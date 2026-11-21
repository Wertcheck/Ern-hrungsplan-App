/**
 * Lebenszyklus einer lokalen LLM-Engine (WebLLM o. ä.) – unabhängig von der konkreten Bibliothek.
 *
 * Zustände: idle → loading → ready ⇄ busy; Fehler → error → (automatische) Wiederherstellung → ready; dispose → disposed.
 * Garantien:
 *  - Nie zwei Inferenzläufe gleichzeitig (zweiter Aufruf wird sofort mit BusyError abgewiesen, nichts wird gestartet).
 *  - Abbruch (AbortSignal/Zeitlimit) unterbricht den Lauf, setzt den Chat-Zustand zurück und lässt die Engine nutzbar.
 *  - Ein Engine-Fehler (z. B. „disposed“, Device lost, Grammatik) markiert die Engine als beschädigt; der NÄCHSTE Aufruf stellt sie vorher
 *    wieder her: erst resetChat + Probelauf, sonst vollständiges Entladen und Neuladen. Maximal 2 Versuche in Folge, dann bleibt es bei error.
 *  - Ressourcen werden bei Neuladen/dispose per unload() freigegeben; Fehler dabei werden gesammelt, nicht verschluckt.
 */
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface ChatStats { ttftMs: number | null; totalMs: number; prefillTps: number | null; decodeTps: number | null; completionTokens: number | null }
export interface ChatOptions { maxTokens: number; signal?: AbortSignal; /** JSON-Schema als String → grammatikgestützte Ausgabe */ schema?: string }
export interface LlmEngine {
  chat(messages: ChatMessage[], opts: ChatOptions): Promise<{ text: string; stats: ChatStats }>
  resetChat(): Promise<void>
  interrupt(): void
  unload(): Promise<void>
}
export type EngineFactory = (modelId: string, onProgress?: (p: { progress: number; text: string }) => void) => Promise<LlmEngine>
export type HostState = 'idle' | 'loading' | 'ready' | 'busy' | 'error' | 'disposed'

export class HostError extends Error {
  constructor(public code: 'busy' | 'not_loaded' | 'aborted' | 'timeout' | 'engine' | 'recovery_failed' | 'disposed', message: string, public causeText?: string) { super(message); this.name = 'HostError' }
}

const TAINT = /disposed|already deleted|mapasync|unmapped|device (was )?lost|[(\[]device[)\]] is lost|out of memory|oom|grammar|abort(ed)? by|context lost|internal error|runtime error|unreachable/i
export const explain = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 300)

export interface HostOptions { timeoutMs?: number; maxRecoveries?: number; now?: () => number }

export class LlmEngineHost {
  state: HostState = 'idle'
  lastError: string | null = null
  modelId: string | null = null
  loadMs: number | null = null
  recoveries = 0
  private engine: LlmEngine | null = null
  private recoveryStreak = 0
  private cleanupErrors: string[] = []
  private ctl: AbortController | null = null
  private readonly timeoutMs: number
  private readonly maxRecoveries: number
  private readonly now: () => number
  constructor(private factory: EngineFactory, opts: HostOptions = {}) { this.timeoutMs = opts.timeoutMs ?? 90_000; this.maxRecoveries = opts.maxRecoveries ?? 2; this.now = opts.now ?? (() => performance.now()) }

  get cleanup(): readonly string[] { return this.cleanupErrors }

  async load(modelId: string, onProgress?: (p: { progress: number; text: string }) => void): Promise<void> {
    if (this.state === 'disposed') throw new HostError('disposed', 'Die lokale KI wurde beendet.')
    if (this.state === 'busy' || this.state === 'loading') throw new HostError('busy', 'Es läuft bereits ein Vorgang.')
    await this.release()
    this.state = 'loading'; this.modelId = modelId
    const t0 = this.now()
    try { this.engine = await this.factory(modelId, onProgress); this.loadMs = Math.round(this.now() - t0); this.state = 'ready'; this.lastError = null; this.recoveryStreak = 0 }
    catch (e) { this.engine = null; this.state = 'error'; this.lastError = explain(e); throw new HostError('engine', `Das lokale Modell konnte nicht geladen werden: ${explain(e)}`, explain(e)) }
  }

  abort(): void { if (this.state === 'busy') { this.ctl?.abort(); try { this.engine?.interrupt() } catch { /* Engine evtl. schon beendet */ } } }

  async run(messages: ChatMessage[], opts: { maxTokens?: number; schema?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ text: string; stats: ChatStats }> {
    if (this.state === 'disposed') throw new HostError('disposed', 'Die lokale KI wurde beendet.')
    if (this.state === 'busy' || this.state === 'loading') throw new HostError('busy', 'Die lokale KI ist noch beschäftigt. Bitte warte, bis die laufende Anfrage fertig ist.')
    if (this.state === 'idle' || !this.modelId) throw new HostError('not_loaded', 'Das lokale Modell ist noch nicht geladen.')
    if (this.state === 'error') await this.recover()
    const engine = this.engine
    if (!engine) throw new HostError('not_loaded', 'Das lokale Modell ist nicht geladen.')
    this.state = 'busy'
    const ctl = this.ctl = new AbortController()
    const onExt = () => ctl.abort(); opts.signal?.addEventListener('abort', onExt)
    if (opts.signal?.aborted) ctl.abort()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); try { engine.interrupt() } catch { /* ignorieren */ } }, opts.timeoutMs ?? this.timeoutMs)
    try {
      if (ctl.signal.aborted) throw new Error('aborted')
      // Abbruch/Zeitlimit müssen auch greifen, wenn die Engine nicht von selbst zurückkehrt
      const aborted = new Promise<never>((_r, rej) => ctl.signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true }))
      const r = await Promise.race([engine.chat(messages, { maxTokens: opts.maxTokens ?? 160, signal: ctl.signal, schema: opts.schema }), aborted])
      if (ctl.signal.aborted) throw new Error('aborted')
      this.state = 'ready'; this.recoveryStreak = 0
      return r
    } catch (e) {
      const msg = explain(e)
      if (ctl.signal.aborted) {
        // Abbruch: Chat-Zustand sauber zurücksetzen; schlägt das fehl, gilt die Engine als beschädigt
        try { await engine.resetChat(); this.state = 'ready' } catch (e2) { this.state = 'error'; this.lastError = explain(e2) }
        throw new HostError(timedOut ? 'timeout' : 'aborted', timedOut ? 'Die lokale KI hat zu lange gebraucht und wurde abgebrochen.' : 'Abgebrochen.')
      }
      // Jeder Fehler aus der Engine lässt ihren inneren Zustand unsicher: sicherheitshalber wiederherstellen lassen (nächster Aufruf)
      this.state = 'error'; this.lastError = msg
      throw new HostError('engine', TAINT.test(msg) ? 'Die lokale KI hat einen internen Fehler gemeldet und wird beim nächsten Mal neu gestartet.' : `Die lokale KI hat einen Fehler gemeldet: ${msg}`, msg)
    } finally {
      clearTimeout(timer); opts.signal?.removeEventListener('abort', onExt); this.ctl = null
    }
  }

  /** Stellt eine beschädigte Engine wieder her: 1) resetChat + Probelauf, 2) Entladen und Neuladen. */
  async recover(): Promise<void> {
    if (this.state !== 'error' || !this.modelId) return
    if (this.recoveryStreak >= this.maxRecoveries) throw new HostError('recovery_failed', 'Die lokale KI lässt sich nicht wiederherstellen. Bitte Modell neu laden oder die App neu starten.', this.lastError ?? undefined)
    this.recoveryStreak++; this.recoveries++
    this.state = 'loading'
    if (this.engine) {
      try {
        await this.engine.resetChat()
        await this.engine.chat([{ role: 'user', content: 'ok' }], { maxTokens: 2 })
        this.state = 'ready'; this.lastError = null; return
      } catch (e) { this.lastError = explain(e) }
    }
    await this.release()
    try { this.engine = await this.factory(this.modelId); this.state = 'ready'; this.lastError = null }
    catch (e) { this.engine = null; this.state = 'error'; this.lastError = explain(e); throw new HostError('recovery_failed', 'Neustart der lokalen KI fehlgeschlagen. Die Regel-Erkennung funktioniert weiter.', explain(e)) }
  }

  private async release(): Promise<void> {
    const e = this.engine; this.engine = null
    if (e) { try { await e.unload() } catch (err) { this.cleanupErrors.push(explain(err)) } }
  }

  async dispose(): Promise<void> { this.abort(); await this.release(); this.state = 'disposed' }
}
