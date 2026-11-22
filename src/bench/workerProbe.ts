/**
 * Stufe B: Worker-Start getrennt nach Art. Jede Variante wird einzeln versucht und mit Fehlerdetails protokolliert.
 * Ziel: unterscheiden, ob Worker generell, nur Module-Worker, nur Blob-URLs oder nur der CDN-Import im Worker scheitern.
 */
import { WEBLLM_URL } from '../ai/local/webllmAdapter'
type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any

interface Res { ok: boolean; ms: number; reply?: unknown; error?: string; event?: { message: string; filename: string; lineno: number }; note?: string }

function attempt(make: () => Worker, ms = 8000): Promise<Res> {
  return new Promise(resolve => {
    const t0 = performance.now(); let w: Worker | null = null; let done = false
    const fin = (r: Omit<Res, 'ms'>) => { if (done) return; done = true; clearTimeout(h); try { w?.terminate() } catch { /* ignorieren */ } resolve({ ...r, ms: Math.round(performance.now() - t0) }) }
    const h = setTimeout(() => fin({ ok: false, error: `keine Antwort nach ${ms / 1000} s` }), ms)
    try {
      w = make()
      w.addEventListener('message', e => { const d = e.data as Any; if (d && d.probe === true) fin(d.ok === false ? { ok: false, error: String(d.error), reply: d } : { ok: true, reply: d }) })
      w.addEventListener('error', (e: ErrorEvent) => fin({ ok: false, error: 'Worker-Fehlerereignis', event: { message: e.message, filename: e.filename, lineno: e.lineno } }))
      w.addEventListener('messageerror', () => fin({ ok: false, error: 'messageerror' }))
    } catch (e) { fin({ ok: false, error: `Konstruktor: ${String((e as Error)?.message ?? e)}` }) }
  })
}
const blob = (code: string) => URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
const dyn = (url: string) => `(async()=>{try{const m=await import(${JSON.stringify(url)});postMessage({probe:true,ok:true,exports:Object.keys(m).length})}catch(e){postMessage({probe:true,ok:false,error:String(e&&e.message||e)})}})()`

export async function runWorkerMatrix(log: (t: string) => void, webllmUrl = WEBLLM_URL): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { startedAt: new Date().toISOString() }
  out.env = {
    protocol: location.protocol, origin: location.origin, href: location.href.slice(0, 60), isSecureContext: window.isSecureContext, crossOriginIsolated: window.crossOriginIsolated,
    metaCsp: document.querySelector('meta[http-equiv="Content-Security-Policy" i]')?.getAttribute('content') ?? null, workerApi: typeof Worker !== 'undefined', note: 'HTTP-Antwortheader (CSP) sind aus der Seite nicht lesbar',
  }
  const tests: [string, string, () => Worker][] = [
    ['W1_classic_blob_inline', 'klassischer Worker, Blob-URL, ohne Import', () => new Worker(blob("postMessage({probe:true,ok:true})"))],
    ['W2_module_blob_inline', 'Modul-Worker, Blob-URL, ohne Import', () => new Worker(blob("postMessage({probe:true,ok:true})"), { type: 'module' })],
    ['W3_classic_blob_dynamic_import_cdn', 'klassischer Worker, Blob, import() des CDN im try/catch (zeigt die echte Fehlermeldung)', () => new Worker(blob(dyn(webllmUrl)))],
    ['W4_module_blob_dynamic_import_cdn', 'Modul-Worker, Blob, import() des CDN im try/catch', () => new Worker(blob(dyn(webllmUrl)), { type: 'module' })],
    ['W5_module_blob_static_import_cdn', 'Modul-Worker, Blob, statischer import (wie im bisherigen Benchmark)', () => new Worker(blob(`import * as m from ${JSON.stringify(webllmUrl)};postMessage({probe:true,ok:true,exports:Object.keys(m).length})`), { type: 'module' })],
    ['W6_module_data_url', 'Modul-Worker, data:-URL, ohne Import', () => new Worker('data:text/javascript,postMessage({probe:true,ok:true})', { type: 'module' })],
  ]
  const res: Record<string, Res & { what: string }> = {}; out.tests = res
  for (const [name, what, make] of tests) { log(`Worker-Test ${name} …`); res[name] = { what, ...(await attempt(make)) } }
  // lokale Moduldatei: nur sinnvoll, wenn die Seite über http(s) ausgeliefert wird
  if (location.protocol.startsWith('http')) { log('Worker-Test W7 (lokale Moduldatei) …'); res.W7_module_local_file = { what: 'Modul-Worker aus same-origin-Datei /worker-probe.js', ...(await attempt(() => new Worker(new URL('/worker-probe.js', location.origin).href, { type: 'module' }))) } }
  else res.W7_module_local_file = { what: 'Modul-Worker aus same-origin-Datei', ok: false, ms: 0, note: `nicht anwendbar: Seite wurde über ${location.protocol} geöffnet (Chrome erlaubt dort keine Datei-Worker)` }
  out.finishedAt = new Date().toISOString(); return out
}
