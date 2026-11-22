/**
 * Benchmark/Fehlerinjektion auf dem Gerät. Alles Gemessene stammt aus diesem Lauf; Nichtgemessenes bleibt null bzw. „nicht messbar“.
 *
 * Isolation (Lehre aus Messlauf 1): Ein GPU-/Engine-Fehler macht die Engine in derselben Seite dauerhaft unbrauchbar. Darum läuft JEDE Konfiguration
 * (Modell × Modus) in einer FRISCHEN Seite (Neuladen) und, wenn gewählt, in einem eigenen Web Worker. Reihenfolge je Modell: Smoke → Prompt → Grammatik;
 * Folgekonfigurationen werden nur gestartet, wenn der Smoke-Test bestanden ist. Fortschritt liegt im localStorage und überlebt Neuladen/Abstürze.
 */
import { parseCommands } from '../ai/nlu'
import { CASES, CASE_TODAY, baseState, judge } from '../ai/local/cases'
import { LlmEngineHost, type ChatMessage } from '../ai/local/host'
import { LLM_JSON_SCHEMA, buildSystemPrompt, parseModelOutput } from '../ai/local/llmAction'
import { interpret, toOutcome, type LocalOutcome } from '../ai/local/runner'
import { runGpuMatrix, runGpuProbe } from './gpuProbe'
import { installGpuSpy, spyLog } from './gpuSpy'
import { runWorkerMatrix } from './workerProbe'
import { MODELS, WEBLLM_VERSION, isModelCached, lastIsolation, lastWorkerKind, note, trace, webllmFactory, webllmUrl, type RawChatOptions } from '../ai/local/webllmAdapter'

type Mode = 'smoke' | 'prompt' | 'grammar' | 'accept'
interface Cfg { model: string; mode: Mode; worker: boolean; version?: string }
interface Acc { gpuProbe?: unknown; stageA?: unknown; stageB?: unknown; startedAt: string; device: Record<string, unknown>; queue: Cfg[]; inFlight: Cfg | null; partial?: Record<string, unknown> | null; results: Record<string, unknown>[]; tier0?: unknown; injection?: unknown }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const KEY = 'llm-bench-acc-v3'
const load = (): Acc | null => { try { const t = localStorage.getItem(KEY); return t ? JSON.parse(t) : null } catch { return null } }
const save = (a: Acc) => { try { localStorage.setItem(KEY, JSON.stringify(a)) } catch { /* Speicher evtl. gesperrt */ } }
const view = (a: Acc | null) => { $('out').textContent = JSON.stringify(a ? { schema: 'ernaehrungsplan-llm-bench-v3', webllm: acc?.queue?.[0]?.version ?? WEBLLM_VERSION, note: 'Alle Werte auf diesem Gerät gemessen; fehlend/null = nicht gemessen. Temperatur: nicht messbar (keine Browser-Schnittstelle).', ...a } : 'Noch nichts gemessen.', null, 2) }
const status = (t: string) => { $('st').textContent = t }
const battery = async (): Promise<number | null> => { try { const b = await (navigator as unknown as { getBattery(): Promise<{ level: number }> }).getBattery(); return +b.level.toFixed(2) } catch { return null } }
const memory = async () => {
  const pm = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
  let storage: number | null = null; try { storage = Math.round(((await navigator.storage.estimate()).usage ?? 0) / 1048576) } catch { /* ignorieren */ }
  return { jsHeapMB: pm ? Math.round(pm.usedJSHeapSize / 1048576) : null, storageUsageMB: storage, gpuMemory: 'nicht messbar im Browser', ramProcess: 'nicht messbar im Browser' }
}
const avg = (xs: (number | null | undefined)[]) => { const v = xs.filter((x): x is number => typeof x === 'number'); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null }
const errText = (e: unknown) => String((e as Error)?.message ?? e)
const setBusy = (b: boolean) => { for (const id of ['bench', 'inject', 'gpu', 'stages', 'accept', 'reset']) ($(id) as HTMLButtonElement).disabled = b; ($('abort') as HTMLButtonElement).disabled = !b }

let acc: Acc | null = load()
const sig = new AbortController()

function tier0() {
  return CASES.map(c => { const s = c.setup ? c.setup(baseState()) : baseState(); const r = parseCommands(c.text, { state: s, today: CASE_TODAY }); const o = toOutcome(r.kind === 'refuse' ? { kind: 'invalid', reason: r.text } : r, s, CASE_TODAY); const v = judge(o, c, s, s); return { id: c.id, ok: v.intent && v.params && v.cls && v.noUnwantedChange } })
}

function startQueue(kind: 'bench' | 'accept') {
  const models = [...document.querySelectorAll<HTMLInputElement>('input.model:checked')].map(x => x.value)
  const modes: Mode[] = [...(($('mprompt') as HTMLInputElement).checked ? ['prompt' as const] : []), ...(($('mgrammar') as HTMLInputElement).checked ? ['grammar' as const] : [])]
  const worker = ($('useworker') as HTMLInputElement).checked, version = ($('wver') as HTMLSelectElement).value
  if (!models.length) { status('Bitte mindestens ein Modell wählen.'); return }
  const queue: Cfg[] = models.flatMap(model => (kind === 'accept' ? ['accept' as Mode] : (['smoke', ...modes] as Mode[])).map(mode => ({ model, mode, worker, version })))
  acc = { ...(acc ?? {}), startedAt: new Date().toISOString(), device: { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, deviceMemoryGB_capped: (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? null, webgpu: 'gpu' in navigator }, queue, inFlight: null, results: [], tier0: tier0() }
  save(acc); location.reload()
}

/** Verarbeitet die nächste Konfiguration der Warteschlange in dieser (frischen) Seite, danach Neuladen. */
async function resume() {
  if (!acc || (!acc.queue.length && !acc.inFlight)) { view(acc); return }
  setBusy(true)
  if (acc.inFlight) { // die Seite wurde während einer Konfiguration beendet (Tab-Kill/Absturz/Neuladen)
    const dead = acc.inFlight
    acc.results.push({ ...(acc.partial ?? {}), ...dead, error: 'Seite/Tab wurde während dieser Konfiguration beendet (Absturz, Speicherdruck oder Neuladen).', crashed: true })
    acc.queue = acc.queue.filter(c => !(c.model === dead.model && c.mode === dead.mode))
    if (dead.mode === 'smoke') { acc.queue = acc.queue.filter(c => c.model !== dead.model); acc.results.push({ model: dead.model, mode: 'prompt/grammar', skipped: 'übersprungen: Smoke-Test beendete die Seite' }) }
    acc.inFlight = null; acc.partial = null; save(acc)
    if (!acc.queue.length) { finish(); return }
  }
  const cfg = acc.queue[0]
  acc.inFlight = cfg; save(acc); view(acc)
  let res: Record<string, unknown>
  try { res = await runConfig(cfg) } catch (e) { res = { ...cfg, error: `Unerwarteter Fehler: ${errText(e)}` } }
  acc = load() ?? acc
  acc.results.push(res); acc.inFlight = null; acc.partial = null; acc.queue.shift()
  // Smoke fehlgeschlagen → weitere Konfigurationen dieses Modells sind sinnlos
  if (cfg.mode === 'smoke' && res.smokeOk !== true) { acc.queue = acc.queue.filter(c => c.model !== cfg.model); acc.results.push({ model: cfg.model, mode: 'prompt/grammar', skipped: 'übersprungen: Smoke-Test (einfache Textgenerierung) fehlgeschlagen' }) }
  save(acc)
  if (sig.signal.aborted) { acc.queue = []; save(acc) }
  if (acc.queue.length) { status('Nächste Konfiguration (frische Seite) …'); setTimeout(() => location.reload(), 400); return }
  finish()
}
function finish() { setBusy(false); $('pg').hidden = true; status('Fertig.'); view(acc) }

async function runConfig(cfg: Cfg): Promise<Record<string, unknown>> {
  const r = await runConfigInner(cfg); r.isolationUsed = lastIsolation; r.workerKind = lastWorkerKind; r.trace = [...trace]; r.gpuSpy = [...spyLog]; return r
}
async function runConfigInner(cfg: Cfg): Promise<Record<string, unknown>> {
  const entry: Record<string, unknown> = { model: cfg.model, mode: cfg.mode, worker: cfg.worker, startedAt: new Date().toISOString() }
  note(`Konfiguration ${cfg.mode} · ${cfg.model} (Worker gewünscht: ${cfg.worker})`)
  entry.cachedBeforeLoad = await isModelCached(cfg.model, webllmUrl(cfg.version ?? WEBLLM_VERSION)); entry.version = cfg.version ?? WEBLLM_VERSION; entry.batteryBefore = await battery()
  status(`${cfg.mode} · ${cfg.model}: lade …`); $('pg').hidden = false; let last = 0
  let lastProgressAt = performance.now()
  const watch = setInterval(() => { const last = trace[trace.length - 1]; status(`${cfg.mode} · ${cfg.model}: ${Math.round((performance.now() - lastProgressAt) / 1000)} s ohne Fortschritt · letzte Phase: ${last?.msg ?? '–'}`); try { const a = load(); if (a) { a.partial = { ...(a.partial ?? {}), trace: [...trace] }; save(a) } } catch { /* ignorieren */ } }, 5000)
  const progress = (p: { progress: number; text: string }) => { lastProgressAt = performance.now(); ($('pg') as HTMLProgressElement).value = p.progress; if (performance.now() - last > 500) { last = performance.now(); status(p.text) } }
  const factory = webllmFactory(webllmUrl(cfg.version ?? WEBLLM_VERSION), { worker: cfg.worker })
  const stopWatch = () => clearInterval(watch)

  if (cfg.mode === 'accept') return acceptance(cfg, entry, progress, stopWatch)
  if (cfg.mode === 'smoke') {
    const t0 = performance.now(); let eng
    try { eng = await factory(cfg.model, progress) } catch (e) { stopWatch(); return { ...entry, loadError: errText(e), smokeOk: false } }
    stopWatch()
    entry.loadMs = Math.round(performance.now() - t0); entry.loadNote = entry.cachedBeforeLoad ? 'Modell war im Cache: Zeit enthält KEINEN Download.' : entry.cachedBeforeLoad === false ? 'Erstladung inkl. Download.' : 'Cache-Status unbekannt.'
    entry.memoryAfterLoad = await memory()
    const calls: Record<string, unknown>[] = []
    for (let i = 0; i < 3; i++) {
      status(`Smoke ${i + 1}/3 (einfache Generierung, ohne Grammatik) …`)
      const msgs: ChatMessage[] = [{ role: 'user', content: 'Antworte nur mit dem Wort ok.' }]
      try { const r = await Promise.race([eng.chat(msgs, { maxTokens: 8 }), new Promise<never>((_r, rej) => setTimeout(() => rej(new Error('Smoke: keine Antwort nach 90 s (Inferenz hängt)')), 90_000))]); calls.push({ ok: true, text: r.text, ...r.stats }) } catch (e) { calls.push({ ok: false, error: errText(e) }); break }
    }
    entry.calls = calls; entry.smokeOk = calls.length === 3 && calls.every(c => c.ok === true)
    try { await eng.unload() } catch (e) { entry.unloadError = errText(e) }
    entry.batteryAfter = await battery(); entry.memoryAfterRuns = await memory(); return entry
  }

  const host = new LlmEngineHost(factory, { timeoutMs: 120_000 })
  try { await host.load(cfg.model, progress) } catch (e) { stopWatch(); return { ...entry, loadError: errText(e) } }
  stopWatch()
  entry.loadMs = host.loadMs; entry.loadNote = entry.cachedBeforeLoad ? 'Modell war im Cache: Zeit enthält KEINEN Download.' : entry.cachedBeforeLoad === false ? 'Erstladung inkl. Download.' : 'Cache-Status unbekannt.'
  entry.memoryAfterLoad = await memory()
  const runs: Record<string, unknown>[] = []; entry.runs = runs; const t0 = performance.now()
  let stopped: string | null = null
  for (const c of CASES) {
    if (sig.signal.aborted) { stopped = 'abgebrochen'; break }
    if (stopped) break
    status(`${cfg.model} · ${cfg.mode} · ${c.id}: ${c.text}`)
    const s = c.setup ? c.setup(baseState()) : baseState(), snap = JSON.stringify(s)
    const r = await interpret(host, c.text, s, CASE_TODAY, { useGrammar: cfg.mode === 'grammar', signal: sig.signal })
    const v = judge(r.outcome as LocalOutcome, c, s, JSON.parse(snap)), a1 = r.attempts[0]
    runs.push({ id: c.id, input: c.text, outcome: r.outcome.kind, firstOutputValidJson: !!a1 && !a1.parseError, outputs: r.attempts.map(a => a.output), parseErrors: r.attempts.map(a => a.parseError ?? null), attempts: r.attempts.length,
      intentOk: v.intent, paramsOk: v.params, classOk: v.cls, noUnwantedChange: v.noUnwantedChange, details: v.details, error: r.outcome.kind === 'failed' ? r.outcome.message : null, hostError: host.lastError,
      ttft_ms: a1?.stats?.ttftMs ?? null, total_ms: r.attempts.reduce((a, x) => a + (x.stats?.totalMs ?? 0), 0) || null, decode_tps: a1?.stats?.decodeTps ?? null, prefill_tps: a1?.stats?.prefillTps ?? null, tokens: a1?.stats?.completionTokens ?? null })
    // Nach einem Engine-Fehler nicht „weiterraten“: Rest wird NICHT als Modellfehler gezählt, sondern als nicht ausgeführt dokumentiert
    if (r.outcome.kind === 'failed' && r.outcome.code !== 'timeout' && r.outcome.code !== 'aborted') stopped = `Engine-Fehler nach ${runs.length} Fall/Fällen: ${host.lastError ?? r.outcome.message}`
    acc!.partial = { ...entry, runs: [...runs] }; save(acc!)
  }
  entry.wallClockMs = Math.round(performance.now() - t0); entry.batteryAfter = await battery(); entry.memoryAfterRuns = await memory()
  entry.stoppedEarly = stopped; entry.notExecuted = CASES.length - runs.length
  const ok = runs.filter(r => r.outcome !== 'failed')
  entry.summary = { casesExecuted: runs.length, casesTotal: CASES.length, firstOutputValidJson: runs.filter(r => r.firstOutputValidJson).length, validAfterRetry: runs.filter(r => r.outcome !== 'rejected' && r.outcome !== 'failed').length,
    intentOk: runs.filter(r => r.intentOk).length, paramsOk: runs.filter(r => r.paramsOk && r.outcome !== 'failed').length, classOk: runs.filter(r => r.classOk && r.outcome !== 'failed').length, fullyCorrect: runs.filter(r => r.intentOk && r.paramsOk && r.classOk && r.noUnwantedChange && r.outcome !== 'failed').length, noUnwantedChange: runs.filter(r => r.noUnwantedChange).length, engineFailures: runs.length - ok.length,
    avgTtft_ms: avg(runs.map(r => r.ttft_ms as number | null)), avgTotal_ms: avg(runs.map(r => r.total_ms as number | null)), avgDecode_tps: avg(runs.map(r => r.decode_tps as number | null)), note: 'Feste Sätze: Stichprobe, keine Aussage über Alltagsgenauigkeit.' }
  entry.hostState = { state: host.state, recoveries: host.recoveries, lastError: host.lastError, cleanupErrors: [...host.cleanup] }
  await host.dispose(); return entry
}

/** Abnahmetest je Modell (Phase 6): jede Stufe unabhängig protokolliert; Kriterien erst am Ende bewertet – nur aus gemessenen Werten. */
async function acceptance(cfg: Cfg, entry: Record<string, unknown>, progress: (p: { progress: number; text: string }) => void, stopWatch: () => void): Promise<Record<string, unknown>> {
  const factory = webllmFactory(webllmUrl(cfg.version ?? WEBLLM_VERSION), { worker: cfg.worker })
  const host = new LlmEngineHost(factory, { timeoutMs: 120_000 }), stages: Record<string, Record<string, unknown>> = {}; entry.stages = stages
  const keep = () => { const a = load(); if (a) { a.partial = { ...entry }; save(a) } }
  const t = async <T>(name: string, f: () => Promise<T>) => { const t0 = performance.now(); status(`${cfg.model} · ${name}`); try { const v = await f(); stages[name] = { ok: true, ms: Math.round(performance.now() - t0), ...(v as object) } } catch (e) { stages[name] = { ok: false, ms: Math.round(performance.now() - t0), error: errText(e) } } keep() }
  const msgs = (q: string): ChatMessage[] => [{ role: 'user', content: q }]
  entry.batteryBefore = await battery(); entry.version = cfg.version ?? WEBLLM_VERSION
  await t('S1_init', async () => { await host.load(cfg.model, progress); stopWatch(); return { loadMs: host.loadMs, isolation: lastIsolation } })
  stopWatch()
  await t('S2_plain_x10', async () => {
    const calls: Record<string, unknown>[] = []; let consecutive = 0
    for (let i = 0; i < 10; i++) {
      try { const r = await host.run(msgs('Antworte nur mit dem Wort ok.'), { maxTokens: 12 }); consecutive++; calls.push({ i: i + 1, ok: true, text: r.text, sane: /^\W*ok\W*$/i.test(r.text.trim()), ttftMs: r.stats.ttftMs, totalMs: r.stats.totalMs, decodeTps: r.stats.decodeTps, prefillTps: r.stats.prefillTps }) }
      catch (e) { calls.push({ i: i + 1, ok: false, error: errText(e) }); break }
    }
    return { calls, consecutiveOk: consecutive, allTenOk: consecutive === 10, saneOutputs: calls.filter(c => c.sane).length }
  })
  await t('S3_structured_prompt', async () => {
    const ids = ['o1', 'o5', 'o6', 'f7'], runs: Record<string, unknown>[] = []
    for (const id of ids) { const c = CASES.find(x => x.id === id)!; const st = c.setup ? c.setup(baseState()) : baseState(), snap = JSON.stringify(st); const r = await interpret(host, c.text, st, CASE_TODAY, { useGrammar: false }); const v = judge(r.outcome as LocalOutcome, c, st, JSON.parse(snap)); runs.push({ id, outcome: r.outcome.kind, firstOutputValidJson: !!r.attempts[0] && !r.attempts[0].parseError, fullyCorrect: v.intent && v.params && v.cls && v.noUnwantedChange && r.outcome.kind !== 'failed', outputs: r.attempts.map(a => a.output.slice(0, 200)), error: r.outcome.kind === 'failed' ? r.outcome.message : null }) }
    return { runs, validJsonFirst: runs.filter(r => r.firstOutputValidJson).length, fullyCorrect: runs.filter(r => r.fullyCorrect).length, of: ids.length }
  })
  await t('S3b_structured_grammar', async () => {
    const c = CASES[0], st = baseState(); const r = await interpret(host, c.text, st, CASE_TODAY, { useGrammar: true, maxAttempts: 1 })
    return { outcome: r.outcome.kind, outputs: r.attempts.map(a => a.output.slice(0, 200)), error: r.outcome.kind === 'failed' ? r.outcome.message : null, grammarWorks: r.outcome.kind !== 'failed' && !!r.attempts[0] && !r.attempts[0].parseError }
  })
  await t('S4_error_handling', async () => {
    // Fehler gezielt auslösen (bekannter web-llm-Fehler), dann prüfen, ob der Host kontrolliert meldet UND anschließend wieder arbeitet
    const h2 = new LlmEngineHost(async (id, p) => { const e = await factory(id, p) as unknown as { chat: (m: ChatMessage[], o: RawChatOptions) => Promise<unknown> }; let first = true; const orig = e.chat.bind(e); e.chat = (m, o) => { if (first) { first = false; return orig(m, { ...o, responseFormatOverride: { type: 'json_object' } }) } return orig(m, o) }; return e as never }, { timeoutMs: 120_000 })
    await h2.load(cfg.model); let firstErr: string | null = null, controlled = false
    try { await h2.run(msgs('Antworte nur mit dem Wort ok.'), { maxTokens: 12 }) } catch (e) { firstErr = errText(e); controlled = (e as { name?: string }).name === 'HostError' }
    let recovered = false, text: string | null = null, secondErr: string | null = null
    try { text = (await h2.run(msgs('Antworte nur mit dem Wort ok.'), { maxTokens: 12 })).text; recovered = true } catch (e) { secondErr = errText(e) }
    const info = { firstErr, controlledHostError: controlled, recovered, text, secondErr, recoveries: h2.recoveries, state: h2.state }; await h2.dispose(); return info
  })
  await t('S5_reinit', async () => {
    await host.dispose(); const h3 = new LlmEngineHost(factory, { timeoutMs: 120_000 }); await h3.load(cfg.model)
    const calls: boolean[] = []; for (let i = 0; i < 3; i++) { try { await h3.run(msgs('Antworte nur mit dem Wort ok.'), { maxTokens: 12 }); calls.push(true) } catch { calls.push(false); break } }
    await h3.dispose(); return { loadMs: h3.loadMs, callsOk: calls.filter(Boolean).length, of: 3 }
  })
  entry.batteryAfter = await battery(); entry.memoryAfterRuns = await memory()
  const S = stages, ok = (k: string) => S[k]?.ok === true
  const tps = ((S.S2_plain_x10?.calls as Record<string, unknown>[] | undefined) ?? []).map(c => c.decodeTps as number | null)
  entry.verdict = {
    k1_initialisiert: ok('S1_init'), k2_zehn_aufrufe_in_folge: ok('S2_plain_x10') && S.S2_plain_x10.allTenOk === true,
    k3_strukturierte_ausgabe: ok('S3_structured_prompt') && S.S3_structured_prompt.validJsonFirst === S.S3_structured_prompt.of,
    k4_fehler_kontrolliert: ok('S4_error_handling') && S.S4_error_handling.controlledHostError === true && S.S4_error_handling.recovered === true,
    k5_neuinitialisierung: ok('S5_reinit') && S.S5_reinit.callsOk === 3,
    k6_hardwarewerte_dokumentiert: typeof (S.S1_init?.loadMs) === 'number' && tps.some(x => typeof x === 'number') && entry.batteryBefore !== null && entry.batteryAfter !== null,
    note: 'Erfolg nur, wenn ALLE Kriterien true sind. „Gültige Ausgabe“ (sane) wird separat gezählt: saneOutputs in S2.',
  }
  entry.overallSuccess = Object.entries(entry.verdict as Record<string, unknown>).filter(([k]) => k.startsWith('k')).every(([, v]) => v === true)
  try { await host.dispose() } catch { /* bereits entladen */ }
  return entry
}

/** Ursachentest auf dem Gerät (in dieser frischen Seite): reproduziert den Fehler und prüft Wiederherstellungswege nacheinander. */
async function injection() {
  setBusy(true)
  const modelId = (document.querySelector<HTMLInputElement>('input.model:checked')?.value) ?? MODELS[0].id
  const out: Record<string, unknown> = { model: modelId, startedAt: new Date().toISOString() }
  acc = acc ?? { startedAt: out.startedAt as string, device: { userAgent: navigator.userAgent }, queue: [], inFlight: null, results: [] }
  acc.queue = []; acc.inFlight = null; acc.injection = out; save(acc); view(acc)
  const step = async (name: string, f: () => Promise<unknown>) => { const t = performance.now(); try { const r = await f(); out[name] = { ok: true, ms: Math.round(performance.now() - t), result: r } } catch (e) { out[name] = { ok: false, ms: Math.round(performance.now() - t), error: errText(e) } } save(acc!); view(acc) }
  const msgs: ChatMessage[] = [{ role: 'system', content: buildSystemPrompt() }, { role: 'user', content: 'Ich möchte heute 4.000 kcal essen.' }]
  type Raw = { chat(m: ChatMessage[], o: RawChatOptions): Promise<{ text: string }>; resetChat(): Promise<void>; unload(): Promise<void> }
  const main = webllmFactory(undefined, { worker: false }), wk = webllmFactory(undefined, { worker: true, fallbackToMain: false })
  status('Lade Modell (Hauptthread) …')
  let eng: Raw
  try { eng = (await main(modelId, p => status(p.text))) as unknown as Raw } catch (e) { out.loadError = errText(e); save(acc); setBusy(false); view(acc); return }
  const raw = (o: Partial<RawChatOptions>) => eng.chat(msgs, { maxTokens: 80, ...o })
  status('0: einfache Generierung ohne Grammatik (Kontrolle, vor jedem Fehler) …'); await step('0_kontrolle_ohne_grammatik', async () => (await raw({})).text)
  status('A: schemaloses json_object (der ursprüngliche Aufruf) …'); await step('A_json_object_ohne_schema', () => raw({ responseFormatOverride: { type: 'json_object' } }))
  status('B: danach gültige Anfrage …'); await step('B_danach_ohne_wiederherstellung', async () => (await raw({})).text)
  status('C: resetChat, dann gültige Anfrage …'); await step('C_nach_resetChat', async () => { await eng.resetChat(); return (await raw({})).text })
  status('D: Grammatik MIT Schema-String …'); await step('D_grammatik_mit_schema', async () => { const r = (await raw({ schema: LLM_JSON_SCHEMA })).text; return { text: r, parse: parseModelOutput(r) } })
  status('E: Entladen und im Hauptthread neu laden …'); await step('E_nach_unload_und_neuladen_hauptthread', async () => { await eng.unload().catch(() => undefined); const e2 = (await main(modelId)) as unknown as Raw; const r = await e2.chat(msgs, { maxTokens: 80 }); await e2.unload(); return r.text })
  status('G: neuer Web Worker (alter beendet), gültige Anfrage …'); await step('G_neuer_worker', async () => { const e3 = (await wk(modelId)) as unknown as Raw; const r = await e3.chat(msgs, { maxTokens: 80 }); await e3.unload(); return r.text })
  status('H: Engine-Host mit Worker und automatischer Wiederherstellung …')
  await step('H_host_worker_auto_recovery', async () => {
    const h = new LlmEngineHost(async (id, p) => { const e = (await wk(id, p)) as unknown as Raw; let first = true; const orig = e.chat.bind(e); e.chat = (m, o) => { if (first) { first = false; return orig(m, { ...o, responseFormatOverride: { type: 'json_object' } }) } return orig(m, o) }; return e as never }, { timeoutMs: 120_000 })
    await h.load(modelId); let firstErr: string | null = null
    try { await h.run(msgs, { maxTokens: 60 }) } catch (e) { firstErr = errText(e) }
    const second = await h.run(msgs, { maxTokens: 60 }); const info = { firstErr, recoveries: h.recoveries, secondText: second.text, finalState: h.state }; await h.dispose(); return info
  })
  out.trace = [...trace]; out.isolationLast = lastIsolation; save(acc!); status('Ursachentest fertig.'); setBusy(false); view(acc)
}

$('bench').onclick = () => startQueue('bench')
$('accept').onclick = () => startQueue('accept')
$('stages').onclick = () => void (async () => {
  setBusy(true); acc = acc ?? { startedAt: new Date().toISOString(), device: { userAgent: navigator.userAgent }, queue: [], inFlight: null, results: [] }; acc.queue = []; acc.inFlight = null
  try { acc.stageA = await runGpuMatrix(status) } catch (e) { acc.stageA = { error: errText(e) } }; save(acc); view(acc)
  try { acc.stageB = await runWorkerMatrix(status, webllmUrl(($('wver') as HTMLSelectElement).value)) } catch (e) { acc.stageB = { error: errText(e) } }
  ;(acc as unknown as Record<string, unknown>).gpuSpyStages = [...spyLog]; save(acc); status('Stufentests A+B fertig.'); setBusy(false); view(acc)
})()
$('inject').onclick = () => void injection().catch(e => { status(`Ursachentest-Fehler: ${errText(e)}`); setBusy(false) })
$('gpu').onclick = () => void (async () => {
  setBusy(true); acc = acc ?? { startedAt: new Date().toISOString(), device: { userAgent: navigator.userAgent }, queue: [], inFlight: null, results: [] }
  acc.queue = []; acc.inFlight = null
  try { acc.gpuProbe = await runGpuProbe(status) } catch (e) { acc.gpuProbe = { error: errText(e) } }
  save(acc); status('GPU-Rohtest fertig.'); setBusy(false); view(acc)
})()
$('abort').onclick = () => { sig.abort(); if (acc) { acc.queue = []; save(acc) } status('Abbruch angefordert …') }
$('reset').onclick = () => { try { localStorage.removeItem(KEY) } catch { /* ignorieren */ } acc = null; view(null); status('Ergebnisse gelöscht.') }
$('copy').onclick = () => void navigator.clipboard?.writeText($('out').textContent ?? '').then(() => alert('Kopiert'), () => alert('Kopieren nicht möglich – „Als Datei speichern“.'))
$('dl').onclick = () => { const u = URL.createObjectURL(new Blob([$('out').textContent ?? ''], { type: 'application/json' })); const a = document.createElement('a'); a.href = u; a.download = 'llm-bench-s23.json'; a.click() }
installGpuSpy(); view(acc); void resume()
