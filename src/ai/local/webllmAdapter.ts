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
export const loadWebLlm = (url = WEBLLM_URL): Promise<Any> => {
  // Ein fehlgeschlagener Import (z. B. kurz offline) darf nicht dauerhaft zwischengespeichert werden
  libPromise ??= import(/* @vite-ignore */ url).catch(e => { libPromise = null; throw e })
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

/** `worker:true` führt die Engine in einem eigenen Web Worker aus: Wiederherstellung = Worker beenden + neuen starten (echte Isolation). */
export const webllmFactory = (url = WEBLLM_URL, o: { worker?: boolean } = {}): EngineFactory => async (modelId, onProgress) => {
  if (!('gpu' in navigator)) throw new Error('WebGPU ist in diesem Browser nicht verfügbar.')
  const lib = await loadWebLlm(url)
  const cfg = { initProgressCallback: (p: { progress?: number; text?: string }) => onProgress?.({ progress: p.progress ?? 0, text: p.text ?? '' }) }
  if (!o.worker) return new WebLlmEngine(await lib.CreateMLCEngine(modelId, cfg))
  const blobUrl = URL.createObjectURL(new Blob([workerSource(url)], { type: 'text/javascript' }))
  const worker = new Worker(blobUrl, { type: 'module' })
  try { return new WebLlmEngine(await lib.CreateWebWorkerMLCEngine(worker, modelId, cfg), worker) }
  catch (e) { worker.terminate(); throw e } finally { URL.revokeObjectURL(blobUrl) }
}
export const isModelCached = async (modelId: string, url = WEBLLM_URL): Promise<boolean | null> => { try { const lib = await loadWebLlm(url); return await lib.hasModelInCache(modelId) } catch { return null } }
