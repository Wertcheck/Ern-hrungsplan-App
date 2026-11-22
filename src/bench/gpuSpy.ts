/**
 * Diagnose-Hülle um WebGPU: protokolliert für JEDES vom Seitencode (auch von WebLLM) erzeugte GPUDevice
 *  - wer/wann `device.destroy()` aufruft (mit Aufrufstapel) – WebLLM zerstört das Gerät bei jedem createBuffer-Fehler,
 *  - `device.lost` (Grund + Meldung des Browsers, dort stehen ggf. Treiberfehler wie VK_ERROR_*),
 *  - nicht abgefangene GPU-Fehler und ALLE nicht-leeren Ergebnisse von `popErrorScope` (OOM / Validation / Internal),
 *  - `console.error`/`console.warn` der Bibliotheken.
 * Verändert kein Verhalten; ruft immer die Originalfunktionen auf. Nur im Messwerkzeug installiert, nicht in der App.
 */
type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any
export interface SpyEvent { t: number; kind: string; msg: string; stack?: string }
export const spyLog: SpyEvent[] = []
const t0 = performance.now()
const add = (kind: string, msg: string, stack?: string) => { spyLog.push({ t: Math.round(performance.now() - t0), kind, msg: String(msg).slice(0, 400), ...(stack ? { stack: stack.split('\n').slice(1, 7).map(l => l.trim()).join(' | ').slice(0, 600) } : {}) }); if (spyLog.length > 300) spyLog.shift() }
let installed = false
let deviceCount = 0

export function installGpuSpy(): void {
  if (installed) return; installed = true
  const origErr = console.error.bind(console), origWarn = console.warn.bind(console)
  console.error = (...a: unknown[]) => { add('console.error', a.map(x => (x as Error)?.message ?? String(x)).join(' ')); origErr(...a) }
  console.warn = (...a: unknown[]) => { add('console.warn', a.map(x => (x as Error)?.message ?? String(x)).join(' ')); origWarn(...a) }
  window.addEventListener('error', e => add('window.error', e.message)); window.addEventListener('unhandledrejection', e => add('unhandledrejection', String((e.reason as Error)?.message ?? e.reason)))
  const gpu = (navigator as Any).gpu; if (!gpu) { add('spy', 'WebGPU nicht verfügbar'); return }
  const orig = gpu.requestAdapter.bind(gpu)
  gpu.requestAdapter = async (...args: unknown[]) => {
    const adapter = await orig(...args); if (!adapter || (adapter as Any).__spied) return adapter
    const od = adapter.requestDevice.bind(adapter); ;(adapter as Any).__spied = true
    adapter.requestDevice = async (desc: Any) => {
      const id = ++deviceCount
      add('requestDevice', `#${id} features=${JSON.stringify(desc?.requiredFeatures ?? [])} limits=${JSON.stringify(desc?.requiredLimits ?? {})}`)
      let dev: Any
      try { dev = await od(desc) } catch (e) { add('requestDevice-Fehler', `#${id} ${String((e as Error)?.message ?? e)}`); throw e }
      dev.lost.then((l: Any) => add('device.lost', `#${id} reason=${l.reason} message=${l.message}`))
      dev.addEventListener('uncapturederror', (e: Any) => add('uncapturederror', `#${id} ${e.error?.constructor?.name}: ${e.error?.message}`))
      const dd = dev.destroy.bind(dev); dev.destroy = () => { add('device.destroy()', `#${id} aufgerufen`, new Error().stack); return dd() }
      const pop = dev.popErrorScope.bind(dev); dev.popErrorScope = async () => { const r = await pop(); if (r) add('popErrorScope', `#${id} ${r.constructor?.name}: ${r.message}`); return r }
      return dev
    }
    return adapter
  }
  add('spy', 'GPU-Diagnose aktiv')
}
