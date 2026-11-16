/** Benchmark/Fehlerinjektion auf dem Gerät. Alles Gemessene stammt aus diesem Lauf; Nichtgemessenes bleibt null bzw. „nicht messbar“. */
import { parseCommands } from '../ai/nlu'
import { CASES, CASE_TODAY, baseState, judge } from '../ai/local/cases'
import { LlmEngineHost, type ChatMessage } from '../ai/local/host'
import { LLM_JSON_SCHEMA, buildSystemPrompt, parseModelOutput } from '../ai/local/llmAction'
import { interpret, toOutcome, type LocalOutcome } from '../ai/local/runner'
import { MODELS, WEBLLM_VERSION, isModelCached, webllmFactory, type RawChatOptions } from '../ai/local/webllmAdapter'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const R: Record<string, unknown> = { schema: 'ernaehrungsplan-llm-bench-v2', webllm: WEBLLM_VERSION, time: new Date().toISOString(), note: 'Alle Werte auf diesem Gerät gemessen; fehlend/null = nicht gemessen.' }
const KEY = 'llm-bench-last'
const show = () => { const t = JSON.stringify(R, null, 2); $('out').textContent = t; try { localStorage.setItem(KEY, t) } catch { /* Speicher evtl. gesperrt */ } }
const status = (t: string) => { $('st').textContent = t }
try { const prev = localStorage.getItem(KEY); if (prev) R.previousPageState = { note: 'Zustand vor dem letzten Neuladen/Absturz der Seite', ...JSON.parse(prev) } } catch { /* ignorieren */ }

const battery = async (): Promise<number | null> => { try { const b = await (navigator as unknown as { getBattery(): Promise<{ level: number }> }).getBattery(); return +b.level.toFixed(2) } catch { return null } }
const memory = async () => {
  const pm = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
  let storage: number | null = null; try { storage = Math.round(((await navigator.storage.estimate()).usage ?? 0) / 1048576) } catch { /* ignorieren */ }
  return { jsHeapMB: pm ? Math.round(pm.usedJSHeapSize / 1048576) : null, storageUsageMB: storage, gpuMemory: 'nicht messbar im Browser', ramProcess: 'nicht messbar im Browser' }
}
const avg = (xs: (number | null | undefined)[]) => { const v = xs.filter((x): x is number => typeof x === 'number'); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null }
let ctl: AbortController | null = null, running = false
const setBusy = (b: boolean) => { running = b; ($('bench') as HTMLButtonElement).disabled = b; ($('inject') as HTMLButtonElement).disabled = b; ($('abort') as HTMLButtonElement).disabled = !b }

async function benchmark() {
  if (running) return
  const models = [...document.querySelectorAll<HTMLInputElement>('input.model:checked')].map(x => x.value)
  const modes: ('grammar' | 'prompt')[] = [...(($('mgrammar') as HTMLInputElement).checked ? ['grammar' as const] : []), ...(($('mprompt') as HTMLInputElement).checked ? ['prompt' as const] : [])]
  if (!models.length || !modes.length) { status('Bitte mindestens ein Modell und einen Modus wählen.'); return }
  setBusy(true); ctl = new AbortController()
  R.device = { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, deviceMemoryGB_capped: (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? null, webgpu: 'gpu' in navigator }
  R.temperature = { before: ($('tbefore') as HTMLInputElement).value || 'nicht gemessen', after: 'siehe unten', note: 'Browser bieten keine Temperatur-Schnittstelle; nur manuelle Eingabe.' }
  R.tier0 = CASES.map(c => { const s = c.setup ? c.setup(baseState()) : baseState(); const r = parseCommands(c.text, { state: s, today: CASE_TODAY }); const o = toOutcome(r.kind === 'refuse' ? { kind: 'invalid', reason: r.text } : r, s, CASE_TODAY); const v = judge(o, c, s, s); return { id: c.id, ok: v.intent && v.params && v.cls && v.noUnwantedChange } })
  const results: Record<string, unknown>[] = []; R.models = results; show()
  try {
    for (const modelId of models) {
      const entry: Record<string, unknown> = { model: modelId }; results.push(entry)
      const host = new LlmEngineHost(webllmFactory(), { timeoutMs: 120_000 })
      entry.cachedBeforeLoad = await isModelCached(modelId); entry.batteryBeforeLoad = await battery(); show()
      status(`Lade ${modelId} …`); $('pg').hidden = false; let last = 0
      try { await host.load(modelId, p => { ($('pg') as HTMLProgressElement).value = p.progress; if (performance.now() - last > 500) { last = performance.now(); status(p.text) } }) }
      catch (e) { entry.loadError = String((e as Error).message); show(); continue }
      entry.loadMs = host.loadMs; entry.loadNote = entry.cachedBeforeLoad ? 'Modell war bereits im Cache: Zeit enthält KEINEN Download.' : entry.cachedBeforeLoad === false ? 'Erstladung inkl. Download.' : 'Cache-Status unbekannt.'
      entry.memoryAfterLoad = await memory(); entry.batteryAfterLoad = await battery()
      const perMode: Record<string, unknown>[] = []; entry.modes = perMode
      for (const mode of modes) {
        const runs: Record<string, unknown>[] = []; const m: Record<string, unknown> = { mode, runs }; perMode.push(m)
        const b0 = await battery(); m.batteryBefore = b0; const t0 = performance.now()
        for (const c of CASES) {
          if (ctl.signal.aborted) break
          status(`${modelId} · ${mode} · ${c.id}: ${c.text}`)
          const s = c.setup ? c.setup(baseState()) : baseState(), snap = JSON.stringify(s)
          const r = await interpret(host, c.text, s, CASE_TODAY, { useGrammar: mode === 'grammar', signal: ctl.signal })
          const v = judge(r.outcome as LocalOutcome, c, s, JSON.parse(snap))
          const a1 = r.attempts[0]
          runs.push({ id: c.id, input: c.text, outcome: r.outcome.kind, firstOutputValidJson: !!a1 && !a1.parseError, outputs: r.attempts.map(a => a.output), parseErrors: r.attempts.map(a => a.parseError ?? null), attempts: r.attempts.length,
            intentOk: v.intent, paramsOk: v.params, classOk: v.cls, noUnwantedChange: v.noUnwantedChange, details: v.details, error: r.outcome.kind === 'failed' ? r.outcome.message : null,
            ttft_ms: a1?.stats?.ttftMs ?? null, total_ms: r.attempts.reduce((a, x) => a + (x.stats?.totalMs ?? 0), 0) || null, decode_tps: a1?.stats?.decodeTps ?? null, prefill_tps: a1?.stats?.prefillTps ?? null, tokens: a1?.stats?.completionTokens ?? null })
          show()
        }
        m.wallClockMs = Math.round(performance.now() - t0); m.batteryAfter = await battery()
        m.summary = { cases: runs.length, firstOutputValidJson: runs.filter(r => r.firstOutputValidJson).length, validAfterRetry: runs.filter(r => r.outcome !== 'rejected' && r.outcome !== 'failed').length,
          intentOk: runs.filter(r => r.intentOk).length, paramsOk: runs.filter(r => r.paramsOk).length, classOk: runs.filter(r => r.classOk).length, fullyCorrect: runs.filter(r => r.intentOk && r.paramsOk && r.classOk && r.noUnwantedChange).length, noUnwantedChange: runs.filter(r => r.noUnwantedChange).length, failedRuns: runs.filter(r => r.outcome === 'failed').length,
          avgTtft_ms: avg(runs.map(r => r.ttft_ms as number | null)), avgTotal_ms: avg(runs.map(r => r.total_ms as number | null)), avgDecode_tps: avg(runs.map(r => r.decode_tps as number | null)),
          note: `${CASES.length} feste Sätze: Stichprobe, keine Aussage über Alltagsgenauigkeit.` }
        show()
      }
      entry.hostState = { state: host.state, recoveries: host.recoveries, lastError: host.lastError, cleanupErrors: [...host.cleanup] }
      entry.memoryAfterRuns = await memory()
      await host.dispose(); show()
    }
  } catch (e) { R.benchmarkError = String((e as Error).message ?? e) }
  R.temperature = { ...(R.temperature as object), after: ($('tafter') as HTMLInputElement).value || 'nicht gemessen' }
  status(ctl.signal.aborted ? 'Abgebrochen (Teilergebnis gespeichert).' : 'Fertig.'); $('pg').hidden = true; setBusy(false); show()
}

/** Ursachentest auf dem Gerät: reproduziert den Fehler gezielt und prüft Wiederherstellungswege nacheinander. Keine Fehler werden verborgen. */
async function injection() {
  if (running) return
  setBusy(true)
  const modelId = (document.querySelector<HTMLInputElement>('input.model:checked')?.value) ?? MODELS[0].id
  const out: Record<string, unknown> = { model: modelId }; R.injection = out; show()
  const step = async (name: string, f: () => Promise<unknown>) => { const t = performance.now(); try { const r = await f(); out[name] = { ok: true, ms: Math.round(performance.now() - t), result: r } } catch (e) { out[name] = { ok: false, ms: Math.round(performance.now() - t), error: String((e as Error).message ?? e) } } show() }
  const factory = webllmFactory(); status('Lade Modell für Ursachentest …')
  const eng = await factory(modelId, p => status(p.text)); const msgs: ChatMessage[] = [{ role: 'system', content: buildSystemPrompt() }, { role: 'user', content: 'Ich möchte heute 4.000 kcal essen.' }]
  const raw = (o: Partial<RawChatOptions>) => (eng as unknown as { chat(m: ChatMessage[], o: RawChatOptions): Promise<{ text: string }> }).chat(msgs, { maxTokens: 80, ...o })
  status('A: schemaloses json_object (der ursprüngliche Aufruf) …')
  await step('A_json_object_ohne_schema', () => raw({ responseFormatOverride: { type: 'json_object' } }))
  status('B: direkt danach gültige Anfrage ohne Grammatik …')
  await step('B_danach_ohne_wiederherstellung', async () => (await raw({})).text)
  status('C: resetChat, dann gültige Anfrage …')
  await step('C_nach_resetChat', async () => { await eng.resetChat(); return (await raw({})).text })
  status('D: Grammatik MIT Schema-String …')
  await step('D_grammatik_mit_schema', async () => { const r = (await raw({ schema: LLM_JSON_SCHEMA })).text; return { text: r, parse: parseModelOutput(r) } })
  status('E: Entladen und Neuladen, dann gültige Anfrage …')
  await step('E_nach_unload_und_neuladen', async () => { await eng.unload(); const e2 = await factory(modelId); const r = await e2.chat(msgs, { maxTokens: 80 }); await e2.unload(); return r.text })
  // F: Host stellt nach einem Fehler selbst wieder her
  status('F: Engine-Host mit automatischer Wiederherstellung …')
  await step('F_host_auto_recovery', async () => {
    const h = new LlmEngineHost(async (id, p) => { const e = await factory(id, p); let first = true; const w = e as unknown as { chat: (m: ChatMessage[], o: RawChatOptions) => Promise<unknown> }; const orig = w.chat.bind(e); w.chat = (m, o) => { if (first) { first = false; return orig(m, { ...o, responseFormatOverride: { type: 'json_object' } }) } return orig(m, o) }; return e }, { timeoutMs: 120_000 })
    await h.load(modelId); let firstErr: string | null = null
    try { await h.run(msgs, { maxTokens: 60 }) } catch (e) { firstErr = String((e as Error).message) }
    const second = await h.run(msgs, { maxTokens: 60 }); const info = { firstErr, stateAfterFirst: 'error', recoveries: h.recoveries, secondText: second.text, finalState: h.state }; await h.dispose(); return info
  })
  status('Ursachentest fertig.'); setBusy(false); show()
}

$('bench').onclick = () => void benchmark().catch(e => { R.benchmarkError = String(e?.message ?? e); setBusy(false); show() })
$('inject').onclick = () => void injection().catch(e => { R.injectionError = String(e?.message ?? e); setBusy(false); show() })
$('abort').onclick = () => ctl?.abort()
$('copy').onclick = () => void navigator.clipboard?.writeText(JSON.stringify(R, null, 2)).then(() => alert('Kopiert'), () => alert('Kopieren nicht möglich – „Als Datei speichern“.'))
$('dl').onclick = () => { const u = URL.createObjectURL(new Blob([JSON.stringify(R, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = u; a.download = 'llm-bench-s23.json'; a.click() }
show()
