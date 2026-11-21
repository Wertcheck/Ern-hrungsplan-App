/**
 * WebLLM (MLC) als LlmEngine. Die Bibliothek wird nur dann und nur von hier geladen (Version fest gepinnt), nicht in die App gebündelt.
 * Wichtig (Ursache des Geräte-Fehlers, siehe LLM_PROTOTYP_BERICHT.md): `response_format: {type:'json_object'}` OHNE `schema` ruft in
 * web-llm 0.2.88 intern compileJSONSchema(undefined, …) auf → „Cannot pass non-string to std::string“. Deshalb wird die Grammatik hier
 * ausschließlich mit Schema-String angefordert; ohne Schema wird KEIN response_format gesendet.
 */
import type { ChatMessage, ChatOptions, ChatStats, EngineFactory, LlmEngine } from './host'

export const WEBLLM_VERSION = '0.2.88'
export const WEBLLM_URL = `https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@${WEBLLM_VERSION}/+esm`
export const MODELS = [
  { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 1B (Q4)', vramMB: 879 },
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 1.5B (Q4)', vramMB: 1630 },
  // f32-Variante der Aktivierungen: Gegenprobe, falls f16 auf dem Adreno-Treiber Probleme macht (größer/langsamer)
  { id: 'Llama-3.2-1B-Instruct-q4f32_1-MLC', label: 'Llama 3.2 1B (Q4, f32)', vramMB: 1129 },
  { id: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC', label: 'Qwen 2.5 1.5B (Q4, f32)', vramMB: 1889 },
] as const

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
let libPromise: Promise<Any> | null = null
/** Protokoll der Ladephasen (mit Zeitstempel) – wird im Benchmark-Ergebnis mitgeliefert, damit „hängt beim Laden“ diagnostizierbar ist. */
export const trace: { t: number; msg: string }[] = []
const t0 = typeof performance !== 'undefined' ? performance.now() : 0
export const note = (msg: string) => { trace.push({ t: Math.round(performance.now() - t0), msg }); if (trace.length > 200) trace.shift() }
export let lastIsolation: 'worker' | 'main' | 'main-fallback' | null = null
const timeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => new Promise((res, rej) => { const h = setTimeout(() => rej(new Error(`${what}: keine Antwort nach ${Math.round(ms / 1000)} s`)), ms); p.then(v => { clearTimeout(h); res(v) }, e => { clearTimeout(h); rej(e) }) })

export const loadWebLlm = (url = WEBLLM_URL): Promise<Any> => {
  // Ein fehlgeschlagener Import (z. B. kurz offline) darf nicht dauerhaft zwischengespeichert werden
  if (!libPromise) { note('Bibliothek wird vom CDN geladen'); libPromise = timeout(import(/* @vite-ignore */ url), 40_000, 'Bibliothek vom CDN laden').then(l => { note('Bibliothek geladen'); return l }).catch(e => { libPromise = null; note(`Bibliothek-Fehler: ${String(e?.message ?? e)}`); throw e }) }
  return libPromise
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

const workerSource = (url: string) => `import { WebWorkerMLCEngineHandler } from ${JSON.stringify(url)};\nconst handler = new WebWorkerMLCEngineHandler();\nself.onmessage = (m) => handler.onmessage(m);`

async function createMain(lib: Any, modelId: string, cfg: Any): Promise<LlmEngine> { note('Haupthread-Engine wird erstellt'); const e = await lib.CreateMLCEngine(modelId, cfg); note('Haupthread-Engine bereit'); return new WebLlmEngine(e) }
async function createInWorker(lib: Any, url: string, modelId: string, cfg: Any): Promise<LlmEngine> {
  const blobUrl = URL.createObjectURL(new Blob([workerSource(url)], { type: 'text/javascript' }))
  note('Web Worker wird gestartet (Blob-Modul-Worker)')
  const worker = new Worker(blobUrl, { type: 'module' })
  const cleanup: (() => void)[] = []
  try {
    const failed = new Promise<never>((_r, rej) => {
      const onErr = (ev: ErrorEvent) => rej(new Error(`Web Worker konnte nicht starten: ${ev.message || 'Skriptfehler (Import, CSP oder Herkunft)'}`))
      const onMsgErr = () => rej(new Error('Web Worker: Nachricht nicht lesbar (messageerror)'))
      worker.addEventListener('error', onErr); worker.addEventListener('messageerror', onMsgErr)
      cleanup.push(() => { worker.removeEventListener('error', onErr); worker.removeEventListener('messageerror', onMsgErr) })
    })
    let seen = false
    const wrapped = { ...cfg, initProgressCallback: (p: { progress?: number; text?: string }) => { if (!seen) { seen = true; note('Worker meldet ersten Fortschritt') } cfg.initProgressCallback(p) } }
    const engine = await Promise.race([lib.CreateWebWorkerMLCEngine(worker, modelId, wrapped), failed, new Promise<never>((_r, rej) => setTimeout(() => { if (!seen) rej(new Error('Web Worker meldet nach 45 s keinen Fortschritt (er startet vermutlich nicht: Blob-/Herkunftsproblem dieser Seite)')) }, 45_000))])
    note('Worker-Engine bereit')
    return new WebLlmEngine(engine, worker)
  } catch (e) { worker.terminate(); throw e } finally { cleanup.forEach(f => f()); URL.revokeObjectURL(blobUrl) }
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
  try { const e = await createInWorker(lib, url, modelId, cfg); lastIsolation = 'worker'; return e }
  catch (err) {
    note(`Worker-Start fehlgeschlagen: ${String((err as Error)?.message ?? err)}`)
    if (o.fallbackToMain === false) throw err
    note('Rückfall auf Hauptthread'); lastIsolation = 'main-fallback'; return createMain(lib, modelId, cfg)
  }
}
export const isModelCached = async (modelId: string, url = WEBLLM_URL): Promise<boolean | null> => { try { const lib = await loadWebLlm(url); return await lib.hasModelInCache(modelId) } catch { return null } }
