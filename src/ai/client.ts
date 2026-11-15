import { SseParser } from './sse'
import type { AiSettings, AiStatus, ChatEvents, ChatRequestBody, ModelList, ProviderName, UsageSummary } from './types'

/** Fehlerklassen, die die UI unterscheiden muss (Offline ≠ Backend aus ≠ Anbieterfehler). */
export class AiError extends Error {
  constructor(public code: 'offline' | 'backend_unreachable' | 'http' | 'stream' | 'aborted', message: string, public status?: number, public apiCode?: string, public retryAfter?: number) { super(message) }
}

const sanitize = (s: string) => s.replace(/(sk-[A-Za-z0-9_-]{6,}|Bearer\s+\S+)/g, '[entfernt]').slice(0, 300)

export interface ClientOptions { baseUrl?: string; fetchImpl?: typeof fetch; online?: () => boolean; timeoutMs?: number }

/** Kommunikation ausschließlich mit dem lokalen Backend (/api). Es werden nie Schlüssel gelesen oder gesendet. */
export class AiClient {
  private base: string
  private f: typeof fetch
  private online: () => boolean
  private timeoutMs: number
  constructor(o: ClientOptions = {}) {
    this.base = (o.baseUrl ?? '/api').replace(/\/$/, '')
    this.f = o.fetchImpl ?? ((...a) => fetch(...a))
    this.online = o.online ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine))
    this.timeoutMs = o.timeoutMs ?? 15000
  }

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.online()) throw new AiError('offline', 'Keine Internetverbindung. Die KI ist offline nicht erreichbar; alle übrigen Funktionen der App arbeiten weiter.')
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), this.timeoutMs)
    let res: Response
    try { res = await this.f(`${this.base}${path}`, { ...init, signal: init.signal ?? ctl.signal, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } }) }
    catch (e) { throw new AiError((e as Error).name === 'AbortError' ? 'aborted' : 'backend_unreachable', 'Das KI-Backend ist nicht erreichbar (läuft `python -m backend`?). Die restliche App ist nicht betroffen.') }
    finally { clearTimeout(t) }
    if (!res.ok) throw await this.httpError(res)
    return (await res.json()) as T
  }

  private async httpError(res: Response): Promise<AiError> {
    let code: string | undefined, msg = `Fehler ${res.status}`
    try { const j = await res.json(); code = j?.error?.code; msg = sanitize(String(j?.error?.message ?? msg)) } catch { /* kein JSON (z. B. Proxy-Fehler wenn Backend aus ist) */ }
    if (res.status >= 502 && !code) return new AiError('backend_unreachable', 'Das KI-Backend ist nicht erreichbar. Die restliche App ist nicht betroffen.', res.status)
    return new AiError('http', msg, res.status, code, Number(res.headers.get('Retry-After')) || undefined)
  }

  status() { return this.req<AiStatus>('/ai/status') }
  getSettings() { return this.req<AiSettings>('/ai/settings') }
  updateSettings(patch: Partial<Omit<AiSettings, 'models'>> & { models?: Partial<AiSettings['models']> }) { return this.req<AiSettings>('/ai/settings', { method: 'PUT', body: JSON.stringify(patch) }) }
  models(provider: Exclude<ProviderName, 'mock'>) { return this.req<ModelList>(`/ai/models?provider=${provider}`) }
  test(provider: ProviderName) { return this.req<{ ok: boolean; provider: string; latency_ms: number; detail: string | null }>('/ai/test', { method: 'POST', body: JSON.stringify({ provider }) }) }
  usage() { return this.req<UsageSummary & { recent: unknown[] }>('/ai/usage') }

  /** Streamt eine Antwort. Abbruch über `signal`. Rückgabe: true, wenn `done` empfangen wurde. */
  async chat(body: ChatRequestBody, ev: ChatEvents, signal?: AbortSignal): Promise<boolean> {
    if (!this.online()) throw new AiError('offline', 'Keine Internetverbindung. Die KI ist offline nicht erreichbar; alle übrigen Funktionen der App arbeiten weiter.')
    let res: Response
    try { res = await this.f(`${this.base}/ai/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal }) }
    catch (e) { throw new AiError((e as Error).name === 'AbortError' ? 'aborted' : 'backend_unreachable', (e as Error).name === 'AbortError' ? 'Abgebrochen.' : 'Das KI-Backend ist nicht erreichbar. Die restliche App ist nicht betroffen.') }
    if (!res.ok) throw await this.httpError(res)
    if (!res.body) throw new AiError('stream', 'Der Browser unterstützt keine Streaming-Antworten.')
    const reader = res.body.getReader(), dec = new TextDecoder(), p = new SseParser()
    let done = false
    try {
      for (;;) {
        const { value, done: end } = await reader.read()
        if (end) break
        for (const e of p.push(dec.decode(value, { stream: true }))) {
          const d = e.data as never
          if (e.event === 'meta') ev.meta?.(d)
          else if (e.event === 'delta') ev.delta?.((d as { text: string }).text)
          else if (e.event === 'actions') ev.actions?.(d)
          else if (e.event === 'usage') ev.usage?.(d)
          else if (e.event === 'error') ev.error?.(d)
          else if (e.event === 'done') done = true
        }
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw new AiError('aborted', 'Abgebrochen.')
      throw new AiError('stream', 'Die Verbindung wurde während der Antwort unterbrochen. Bereits erhaltener Text bleibt erhalten.')
    } finally { try { reader.releaseLock() } catch { /* ignorieren */ } }
    return done
  }
}
