/**
 * WebLLM (MLC) als LlmEngine. Die Bibliothek wird nur dann und nur von hier geladen (Version fest gepinnt), nicht in die App gebündelt.
 * Wichtig (Ursache des Geräte-Fehlers, siehe LLM_PROTOTYP_BERICHT.md): `response_format: {type:'json_object'}` OHNE `schema` ruft in
 * web-llm 0.2.88 intern compileJSONSchema(undefined, …) auf → „Cannot pass non-string to std::string“. Deshalb wird die Grammatik hier
 * ausschließlich mit Schema-String angefordert; ohne Schema wird KEIN response_format gesendet.
 */
import type { ChatMessage, ChatOptions, ChatStats, EngineFactory, LlmEngine } from './host'

export const WEBLLM_VERSIONS = ['0.2.88', '0.2.89', '0.2.82', '0.2.79'] as const
export const WEBLLM_VERSION = '0.2.88'
export const webllmUrl = (v: string) => `https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@${v}/+esm`
export const WEBLLM_URL = webllmUrl(WEBLLM_VERSION)
export const MODELS = [
  { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 1B (Q4)', vramMB: 879 },
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 1.5B (Q4)', vramMB: 1630 },
  // f32-Variante der Aktivierungen: Gegenprobe, falls f16 auf dem Adreno-Treiber Probleme macht (größer/langsamer)
  { id: 'Llama-3.2-1B-Instruct-q4f32_1-MLC', label: 'Llama 3.2 1B (Q4, f32)', vramMB: 1129 },
  { id: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC', label: 'Qwen 2.5 1.5B (Q4, f32)', vramMB: 1889 },
] as const

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
const libs = new Map<string, Promise<Any>>()
/** Protokoll der Ladephasen (mit Zeitstempel) – wird im Benchmark-Ergebnis mitgeliefert, damit „hängt beim Laden“ diagnostizierbar ist. */
export const trace: { t: number; msg: string }[] = []
const t0 = typeof performance !== 'undefined' ? performance.now() : 0
export const note = (msg: string) => { trace.push({ t: Math.round(performance.now() - t0), msg }); if (trace.length > 200) trace.shift() }
export let lastIsolation: 'worker' | 'main' | 'main-fallback' | null = null
const timeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => new Promise((res, rej) => { const h = setTimeout(() => rej(new Error(`${what}: keine Antwort nach ${Math.round(ms / 1000)} s`)), ms); p.then(v => { clearTimeout(h); res(v) }, e => { clearTimeout(h); rej(e) }) })

export const loadWebLlm = (url = WEBLLM_URL): Promise<Any> => {
  // Ein fehlgeschlagener Import (z. B. kurz offline) darf nicht dauerhaft zwischengespeichert werden
  let p = libs.get(url)
  if (!p) { note(`Bibliothek wird vom CDN geladen: ${url}`); p = timeout(import(/* @vite-ignore */ url), 40_000, 'Bibliothek vom CDN laden').then(l => { note('Bibliothek geladen'); return l }).catch(e => { libs.delete(url); note(`Bibliothek-Fehler: ${String(e?.message ?? e)}`); throw e }); libs.set(url, p) }
  return p
}

/** Nur für die Fehlerinjektion im Benchmark: erzwingt ein bestimmtes response_format (z. B. das fehlerhafte schemalose json_object). */
export interface RawChatOptions extends ChatOptions { responseFormatOverride?: unknown }

class WebLlmEngine implements LlmEngine {
  constructor(private engine: Any, private worker?: Worker) {}
  async chat(messages: ChatMessage[], opts: RawChatOptions): Promise<{ text: string; stats: ChatStats }> {
    await this.engine.resetChat() // jede Anfrage startet ohne Rest des vorherigen Chats
    const t0 = performance.now()
    let ttft: number | null = null, text = '', usage: Any = null
    const req: Any = { messages, temperature: 0, max_tokens: opts.maxTokens, stream: true, stream_options: { include_usage: true } }
    if (opts.responseFormatOverride !== undefined) req.response_format = opts.responseFormatOverride
    else if (opts.schema) req.response_format = { type: 'json_object', schema: opts.schema }
    const onAbort = () => { try { this.engine.interruptGenerate() } catch { /* ignorieren */ } }
    opts.signal?.addEventListener('abort', onAbort)
    try {
      const it = await this.engine.chat.completions.create(req)
      for await (const c of it) {
        const d = c.choices?.[0]?.delta?.content
        if (d) { if (ttft === null) ttft = performance.now() - t0; text += d }
        if (c.usage) usage = c.usage
      }
    } finally { opts.signal?.removeEventListener('abort', onAbort) }
    const x = usage?.extra
    return { text, stats: { ttftMs: ttft === null ? null : Math.round(ttft), totalMs: Math.round(performance.now() - t0), prefillTps: x?.prefill_tokens_per_s ?? null, decodeTps: x?.decode_tokens_per_s ?? null, completionTokens: usage?.completion_tokens ?? null } }
  }
  async resetChat() { await this.engine.resetChat() }
  interrupt() { this.engine.interruptGenerate() }
  async unload() {
    // Im Worker-Betrieb wird der Worker immer beendet: das gibt WASM-Zustand (Tokenizer, Grammatik) und GPU-Gerät frei, auch wenn unload() scheitert
    try { await Promise.race([this.engine.unload(), new Promise((_r, rej) => setTimeout(() => rej(new Error('unload: Zeitüberschreitung')), 5000))]) }
    finally { this.worker?.terminate() }
  }
}


async function createMain(lib: Any, modelId: string, cfg: Any): Promise<LlmEngine> { note('Haupthread-Engine wird erstellt'); const e = await lib.CreateMLCEngine(modelId, cfg); note('Haupthread-Engine bereit'); return new WebLlmEngine(e) }
/**
 * Worker-Start in drei Varianten (Reihenfolge). Messung: Modul-Worker aus Blob-URL scheitert auf Seiten mit file://-Herkunft;
 * klassischer Blob-Worker und Modul-Worker aus data:-URL laufen dort. Jede Variante wird einzeln versucht und im Protokoll vermerkt.
 */
const handlerBoot = (url: string) => ({
  moduleSrc: `import { WebWorkerMLCEngineHandler } from ${JSON.stringify(url)};\nconst handler = new WebWorkerMLCEngineHandler();\nself.onmessage = (m) => handler.onmessage(m);`,
  // klassisch: Nachrichten bis zum fertigen Import zwischenspeichern
  classicSrc: `let h = null; const q = [];\nself.onmessage = (m) => { if (h) h.onmessage(m); else q.push(m); };\nimport(${JSON.stringify(url)}).then((mod) => { h = new mod.WebWorkerMLCEngineHandler(); q.splice(0).forEach((m) => h.onmessage(m)); }).catch((e) => postMessage({ workerBootError: String(e && e.message || e) }));`,
})
type WorkerKind = 'module-data-url' | 'classic-blob-dynamic-import' | 'module-blob'
const makeWorker = (kind: WorkerKind, url: string): { worker: Worker; revoke: () => void } => {
  const b = handlerBoot(url)
  if (kind === 'module-data-url') return { worker: new Worker(`data:text/javascript;charset=utf-8,${encodeURIComponent(b.moduleSrc)}`, { type: 'module' }), revoke: () => undefined }
  if (kind === 'classic-blob-dynamic-import') { const u = URL.createObjectURL(new Blob([b.classicSrc], { type: 'text/javascript' })); return { worker: new Worker(u), revoke: () => URL.revokeObjectURL(u) } }
  const u = URL.createObjectURL(new Blob([b.moduleSrc], { type: 'text/javascript' })); return { worker: new Worker(u, { type: 'module' }), revoke: () => URL.revokeObjectURL(u) }
}
// data:-Worker bewusst NICHT in der Reihenfolge: ein Worker mit data:-URL hat keinen Zugriff auf CacheStorage (Messung mit dem echten web-llm-Code: SecurityError ‘caches’), WebLLM speichert Modelle aber dort.
export const WORKER_KINDS: WorkerKind[] = ['classic-blob-dynamic-import', 'module-blob']
export let lastWorkerKind: WorkerKind | null = null

async function createInWorker(lib: Any, url: string, modelId: string, cfg: Any, kind: WorkerKind): Promise<LlmEngine> {
  note(`Web Worker wird gestartet (${kind})`)
  const { worker, revoke } = makeWorker(kind, url)
  const cleanup: (() => void)[] = []
  try {
    const failed = new Promise<never>((_r, rej) => {
      const onErr = (ev: ErrorEvent) => rej(new Error(`Web Worker (${kind}) konnte nicht starten: ${ev.message || 'Skriptfehler (Import, CSP oder Herkunft)'}`))
      const onMsg = (ev: MessageEvent) => { if (ev.data && ev.data.workerBootError) rej(new Error(`Web Worker (${kind}): Import im Worker fehlgeschlagen: ${ev.data.workerBootError}`)) }
      worker.addEventListener('error', onErr); worker.addEventListener('message', onMsg)
      cleanup.push(() => { worker.removeEventListener('error', onErr); worker.removeEventListener('message', onMsg) })
    })
    let seen = false
    const wrapped = { ...cfg, initProgressCallback: (p: { progress?: number; text?: string }) => { if (!seen) { seen = true; note('Worker meldet ersten Fortschritt') } cfg.initProgressCallback(p) } }
    const engine = await Promise.race([lib.CreateWebWorkerMLCEngine(worker, modelId, wrapped), failed, new Promise<never>((_r, rej) => setTimeout(() => { if (!seen) rej(new Error(`Web Worker (${kind}) meldet nach 45 s keinen Fortschritt`)) }, 45_000))])
    note('Worker-Engine bereit'); lastWorkerKind = kind
    return new WebLlmEngine(engine, worker)
  } catch (e) { worker.terminate(); throw e } finally { cleanup.forEach(f => f()); revoke() }
}

/**
 * `worker:true` führt die Engine in einem eigenen Web Worker aus (Wiederherstellung = Worker beenden + neu starten).
 * Startet der Worker nicht (z. B. Seite aus einer lokalen Datei), fällt die Fabrik – sichtbar im Protokoll und in `lastIsolation` – auf den Hauptthread zurück.
 */
export const webllmFactory = (url = WEBLLM_URL, o: { worker?: boolean; fallbackToMain?: boolean } = {}): EngineFactory => async (modelId, onProgress) => {
  if (!('gpu' in navigator)) throw new Error('WebGPU ist in diesem Browser nicht verfügbar.')
  const lib = await loadWebLlm(url)
  const cfg = { initProgressCallback: (p: { progress?: number; text?: string }) => onProgress?.({ progress: p.progress ?? 0, text: p.text ?? '' }) }
  if (!o.worker) { lastIsolation = 'main'; return createMain(lib, modelId, cfg) }
  let lastErr: unknown = null
  for (const kind of WORKER_KINDS) {
    try { const e = await createInWorker(lib, url, modelId, cfg, kind); lastIsolation = 'worker'; return e }
    catch (err) { lastErr = err; note(`Worker-Variante ${kind} fehlgeschlagen: ${String((err as Error)?.message ?? err)}`) }
  }
  if (o.fallbackToMain === false) throw lastErr
  note('Alle Worker-Varianten fehlgeschlagen – Rückfall auf Hauptthread'); lastIsolation = 'main-fallback'; return createMain(lib, modelId, cfg)
}
export const isModelCached = async (modelId: string, url = WEBLLM_URL): Promise<boolean | null> => { try { const lib = await loadWebLlm(url); return await lib.hasModelInCache(modelId) } catch { return null } }
