import { describe, expect, it } from 'vitest'
import { parseCommands } from '../nlu'
import { CASES, CASE_TODAY, baseState, judge, type LlmCase } from './cases'
import { HostError, LlmEngineHost, type ChatMessage, type ChatOptions, type EngineFactory, type LlmEngine } from './host'
import { LLM_JSON_SCHEMA, parseModelOutput, resolveLlmAction } from './llmAction'
import { interpret, toOutcome } from './runner'

const T = CASE_TODAY
const stats = { ttftMs: 5, totalMs: 10, prefillTps: null, decodeTps: null, completionTokens: 3 }

/** Skriptbare Fake-Engine: liefert nacheinander vorgegebene Antworten oder wirft vorgegebene Fehler. */
class FakeEngine implements LlmEngine {
  calls: { messages: ChatMessage[]; opts: ChatOptions }[] = []
  resets = 0; unloaded = 0; interrupted = 0
  constructor(public script: (string | Error | ((o: ChatOptions) => Promise<string>))[] = [], public resetFails = false) {}
  async chat(messages: ChatMessage[], opts: ChatOptions) {
    this.calls.push({ messages, opts })
    const next = this.script.shift()
    if (next === undefined) return { text: '{"type":"none"}', stats }
    if (next instanceof Error) throw next
    if (typeof next === 'function') return { text: await next(opts), stats }
    return { text: next, stats }
  }
  async resetChat() { this.resets++; if (this.resetFails) throw new Error('The current Object has already been disposed') }
  interrupt() { this.interrupted++ }
  async unload() { this.unloaded++ }
}
const hostWith = (engines: FakeEngine[], timeoutMs = 2000) => { let i = 0; const factory: EngineFactory = async () => engines[Math.min(i++, engines.length - 1)]; return new LlmEngineHost(factory, { timeoutMs, now: () => Date.now() }) }

describe('Regel-Erkennung (Tier 0) über alle gemeinsamen Testfälle', () => {
  it.each(CASES.map(c => [c.id + ' ' + c.text, c] as [string, LlmCase]))('%s', (_n, c) => {
    const before = c.setup ? c.setup(baseState()) : baseState(), snapshot = JSON.stringify(before)
    const r = parseCommands(c.text, { state: before, today: T })
    const outcome = toOutcome(r.kind === 'refuse' ? { kind: 'invalid', reason: r.text } : r, before, T)
    const v = judge(outcome, c, before, JSON.parse(snapshot) && before)
    expect(v.details, JSON.stringify(outcome).slice(0, 300)).toEqual([])
    expect(v.intent && v.params && v.cls && v.noUnwantedChange).toBe(true)
    expect(JSON.stringify(before)).toBe(snapshot)
  })
  it('proteinreiche Alternativen: eiweißreichste zuerst, nur Austausch am heutigen Abend', () => {
    const s = baseState(), r = parseCommands('Ersetze mein heutiges Abendessen durch eine proteinreiche Alternative.', { state: s, today: T })
    expect(r.kind).toBe('clarify'); if (r.kind !== 'clarify') return
    expect(r.options.length).toBeGreaterThan(0)
    for (const o of r.options) expect(o.commands[0]).toMatchObject({ type: 'swap_meal', date: T })
    const g = (l: string) => Number(l.match(/(\d+) g Eiweiß/)?.[1]); const ps = r.options.map(o => g(o.label))
    expect(ps.every(Number.isFinite)).toBe(true)
  })
})

describe('Strenger Parser', () => {
  const ok = (t: string) => { const r = parseModelOutput(t); expect(r.ok, t).toBe(true); return r.ok ? r.value : null }
  const bad = (t: string, re?: RegExp) => { const r = parseModelOutput(t); expect(r.ok, t).toBe(false); if (!r.ok && re) expect(r.error).toMatch(re) }
  it('akzeptiert genau ein Objekt (auch im einzelnen Codeblock)', () => {
    expect(ok('{"type":"update_calorie_target","kcal":4000,"scope":"today"}')).toMatchObject({ kcal: 4000 })
    expect(ok('  {"type":"none"}\n')).toEqual({ type: 'none' })
    expect(ok('```json\n{"type":"undo_last"}\n```')).toEqual({ type: 'undo_last' })
  })
  it('verwirft Prosa, Arrays, mehrere Objekte, Abgeschnittenes, Leeres', () => {
    bad('Klar! {"type":"none"}', /kein reines JSON/); bad('{"type":"none"} Hoffe das hilft.', /kein reines JSON/)
    bad('[{"type":"none"}]', /kein reines JSON/); bad('{"type":"none"}{"type":"undo_last"}', /gültiges JSON/)
    bad('{"type":"update_calorie_target","kcal":40', /kein reines JSON/); bad('', /Leere/); bad('   ', /Leere/); bad('null', /kein reines JSON/)
  })
  it('verwirft unbekannte Absichten, fremde Felder, falsche Typen und Wertebereiche', () => {
    bad('{"type":"delete_all_data"}', /Schema/); bad('{"type":"change_allergies","allergens":[]}', /Schema/)
    bad('{"type":"none","extra":1}', /Schema/); bad('{"type":"update_calorie_target","kcal":"4000"}', /Schema/)
    bad('{"type":"update_calorie_target","kcal":50}', /Schema/); bad('{"type":"update_calorie_target","kcal":2000.5}', /Schema/)
    bad('{"type":"update_calorie_target","kcal":99999}', /Schema/); bad('{"type":"update_calorie_target","scope":"heute"}', /Schema/)
    bad('{"type":"set_diets","styles":[]}', /Schema/); bad('{"type":"set_diets","styles":["rohkost"]}', /Schema/)
    bad('{"type":"update_food_preferences","food_name":"","preference":"excluded"}', /Schema/); bad('{"kcal":4000}', /Schema/)
  })
  it('JSON-Schema für die Grammatik ist ein gültiger JSON-String mit Pflichtfeld „type“', () => {
    expect(typeof LLM_JSON_SCHEMA).toBe('string'); const j = JSON.parse(LLM_JSON_SCHEMA); expect(j.required).toEqual(['type']); expect(j.properties.type.enum).toContain('none')
  })
})

describe('Auflösung in App-Befehle (rechnet der Code, nicht das Modell)', () => {
  const s = baseState()
  const res = (a: object) => { const p = parseModelOutput(JSON.stringify(a)); if (!p.ok) throw new Error(p.error); return resolveLlmAction(p.value, s, T) }
  it('delta_kcal wird aus dem aktuellen Ziel berechnet; day_offset in ein Datum', () => {
    expect(res({ type: 'update_calorie_target', delta_kcal: 300, scope: 'today' })).toMatchObject({ kind: 'commands', commands: [{ kcal: 2500, scope: 'today' }] })
    expect(res({ type: 'update_calorie_target', kcal: 3200, day_offset: 1 })).toMatchObject({ kind: 'commands', commands: [{ kcal: 3200, scope: 'date', date: '2026-11-17' }] })
  })
  it('fehlender Zeitbezug → Rückfrage mit zwei Optionen; kcal UND delta oder keins von beiden → Rückfrage', () => {
    const r = res({ type: 'update_calorie_target', kcal: 3000 }); expect(r.kind).toBe('clarify'); if (r.kind === 'clarify') expect(r.options.map(o => o.label)).toEqual(['Nur heute', 'Dauerhaft'])
    expect(res({ type: 'update_calorie_target', scope: 'today' }).kind).toBe('clarify'); expect(res({ type: 'update_calorie_target', kcal: 3000, delta_kcal: 100, scope: 'today' }).kind).toBe('clarify')
  })
  it('Ernährungsweise nur für einen Tag → Rückfrage, nie stille Umstellung', () => { expect(res({ type: 'set_diets', styles: ['vegetarisch'], day_offset: 1 }).kind).toBe('clarify') })
  it('unbekanntes Lebensmittel → Rückfrage; leere Makros → Rückfrage', () => { expect(res({ type: 'update_food_preferences', food_name: 'Raumschiff', preference: 'excluded' }).kind).toBe('clarify'); expect(res({ type: 'update_macros' }).kind).toBe('clarify') })
})

describe('Engine-Host: Lebenszyklus', () => {
  const msgs: ChatMessage[] = [{ role: 'user', content: 'x' }]
  it('Aufruf vor dem Laden wird abgewiesen', async () => { const h = hostWith([new FakeEngine()]); await expect(h.run(msgs)).rejects.toMatchObject({ code: 'not_loaded' }) })
  it('Laden/Ausführen/Beenden: Zustände und Ressourcenfreigabe', async () => {
    const e = new FakeEngine(['{"type":"none"}']), h = hostWith([e]); await h.load('m'); expect(h.state).toBe('ready'); expect(h.loadMs).not.toBeNull()
    expect((await h.run(msgs)).text).toBe('{"type":"none"}'); expect(h.state).toBe('ready')
    await h.dispose(); expect(h.state).toBe('disposed'); expect(e.unloaded).toBe(1); await expect(h.run(msgs)).rejects.toMatchObject({ code: 'disposed' })
  })
  it('Ladefehler → Zustand error mit verständlicher Meldung; erneutes load() möglich', async () => {
    let n = 0; const h = new LlmEngineHost(async () => { if (n++ === 0) throw new Error('Device lost'); return new FakeEngine() })
    await expect(h.load('m')).rejects.toMatchObject({ code: 'engine' }); expect(h.state).toBe('error'); await h.load('m'); expect(h.state).toBe('ready')
  })
  it('zweiter paralleler Aufruf wird sofort abgewiesen und der erste läuft ungestört weiter', async () => {
    let release!: (v: string) => void
    const e = new FakeEngine([() => new Promise<string>(r => { release = r })]), h = hostWith([e]); await h.load('m')
    const first = h.run(msgs); await Promise.resolve()
    await expect(h.run(msgs)).rejects.toMatchObject({ code: 'busy' }); expect(e.calls.length).toBe(1)
    release('{"type":"none"}'); expect((await first).text).toContain('none'); expect(h.state).toBe('ready')
  })
  it('Abbruch: interrupt + resetChat, Engine bleibt nutzbar', async () => {
    const e = new FakeEngine([(o) => new Promise<string>((_r, rej) => o.signal!.addEventListener('abort', () => rej(new Error('aborted by user')))), '{"type":"none"}']), h = hostWith([e]); await h.load('m')
    const p = h.run(msgs); await Promise.resolve(); h.abort()
    await expect(p).rejects.toMatchObject({ code: 'aborted' }); expect(e.interrupted).toBeGreaterThan(0); expect(e.resets).toBe(1); expect(h.state).toBe('ready')
    expect((await h.run(msgs)).text).toContain('none')
  })
  it('bereits abgebrochenes Signal startet gar keinen Lauf', async () => {
    const e = new FakeEngine(), h = hostWith([e]); await h.load('m'); const ac = new AbortController(); ac.abort()
    await expect(h.run(msgs, { signal: ac.signal })).rejects.toMatchObject({ code: 'aborted' }); expect(e.calls.length).toBe(0); expect(h.state).toBe('ready')
  })
  it('Zeitlimit bricht ab und gibt die Engine wieder frei', async () => {
    const e = new FakeEngine([() => new Promise<string>(() => { /* hängt */ }), '{"type":"none"}']), h = hostWith([e], 30); await h.load('m')
    await expect(h.run(msgs)).rejects.toMatchObject({ code: 'timeout' }); expect(h.state).toBe('ready'); expect((await h.run(msgs, { timeoutMs: 500 })).text).toContain('none')
  })
  it('Engine-Fehler („disposed“, Grammatik) → error; nächster Aufruf stellt per resetChat+Probelauf wieder her', async () => {
    const e = new FakeEngine([new Error('Failed to initialize the grammar matcher for response format `json_object`: Cannot pass non-string to std::string'), '{"type":"none"}', '{"type":"none"}']), h = hostWith([e]); await h.load('m')
    await expect(h.run(msgs)).rejects.toMatchObject({ code: 'engine' }); expect(h.state).toBe('error'); expect(h.lastError).toMatch(/grammar matcher/)
    expect((await h.run(msgs)).text).toContain('none'); expect(h.state).toBe('ready'); expect(h.recoveries).toBe(1); expect(e.resets).toBe(1); expect(e.unloaded).toBe(0)
  })
  it('ist resetChat selbst beschädigt („already been disposed“), wird entladen und NEU geladen', async () => {
    const bad = new FakeEngine([new Error('The current Object has already been disposed')], true), good = new FakeEngine(['{"type":"none"}'])
    const h = hostWith([bad, good]); await h.load('m')
    await expect(h.run(msgs)).rejects.toMatchObject({ code: 'engine' })
    expect((await h.run(msgs)).text).toContain('none'); expect(bad.unloaded).toBe(1); expect(h.state).toBe('ready')
  })
  it('scheitert auch das Neuladen, bleibt es bei error mit verständlicher Meldung; nach Ausschöpfen kein Endlos-Retry', async () => {
    let n = 0; const first = new FakeEngine([new Error('Device lost')], true)
    const h = new LlmEngineHost(async () => { if (n++ === 0) return first; throw new Error('WebGPU nicht verfügbar') }, { maxRecoveries: 2 }); await h.load('m')
    await expect(h.run(msgs)).rejects.toMatchObject({ code: 'engine' })
    await expect(h.run(msgs)).rejects.toMatchObject({ code: 'recovery_failed' }); expect(h.state).toBe('error')
    await expect(h.run(msgs)).rejects.toMatchObject({ code: 'recovery_failed' })
    await expect(h.run(msgs)).rejects.toMatchObject({ code: 'recovery_failed', message: expect.stringMatching(/lässt sich nicht wiederherstellen/) })
    const calls = n; await expect(h.run(msgs)).rejects.toBeInstanceOf(HostError); expect(n).toBe(calls)
  })
  it('Fehler beim Freigeben werden gesammelt, nicht verschluckt', async () => {
    const e = new FakeEngine(); e.unload = async () => { throw new Error('unload kaputt') }; const h = hostWith([e]); await h.load('m'); await h.dispose(); expect(h.cleanup).toContain('unload kaputt')
  })
})

describe('Ablauf: Modell → Parser → Auflösung → Engine-Prüfung (nichts wird ausgeführt)', () => {
  const run = async (script: (string | Error)[], text = 'Ich möchte heute 4.000 kcal essen.', opts = {}) => {
    const e = new FakeEngine(script), h = hostWith([e]); await h.load('m'); const s = baseState(), snap = JSON.stringify(s)
    const r = await interpret(h, text, s, T, opts); expect(JSON.stringify(s)).toBe(snap); return { r, e, h }
  }
  it('gültige Antwort → Befehle mit Aktionsklasse', async () => {
    const { r } = await run(['{"type":"update_calorie_target","kcal":4000,"scope":"today"}'])
    expect(r.outcome).toMatchObject({ kind: 'commands', cls: 'B', commands: [{ type: 'update_calorie_target', kcal: 4000, scope: 'today' }] }); expect(r.attempts).toHaveLength(1)
  })
  it('ungültig, dann gültig: genau eine Wiederholung mit Fehlerrückmeldung', async () => {
    const { r, e } = await run(['Gerne! Hier: {"type":"none"}', '{"type":"update_calorie_target","kcal":4000,"scope":"today"}'])
    expect(r.outcome.kind).toBe('commands'); expect(r.attempts).toHaveLength(2); expect(e.calls[1].messages.at(-1)!.content).toMatch(/Ungültig/)
  })
  it('dauerhaft ungültig → rejected nach begrenzten Versuchen, keine Aktion', async () => {
    const { r, e } = await run(['Blabla', '{"type":"drop_tables"}', '{"type":"none"}'], undefined, { maxAttempts: 2 })
    expect(r.outcome.kind).toBe('rejected'); expect(e.calls.length).toBe(2); expect((r.outcome as { reason: string }).reason).toMatch(/nichts geändert/i)
  })
  it('Versuche sind hart begrenzt (max. 3)', async () => { const { e } = await run(Array(10).fill('x'), undefined, { maxAttempts: 99 }); expect(e.calls.length).toBe(3) })
  it('Allergie-/Löschbefehl vom Modell erfunden → verworfen', async () => {
    for (const bad of ['{"type":"remove_allergy","allergen":"nuesse"}', '{"type":"update_profile","allergies":[]}', '{"type":"delete_all_data"}']) { const { r } = await run([bad, bad]); expect(r.outcome.kind, bad).toBe('rejected') }
  })
  it('Engine lehnt ab (Ziel außerhalb der Grenzen) → rejected mit Begründung der Engine, kein Retry', async () => {
    const { r, e } = await run(['{"type":"update_calorie_target","kcal":5000,"scope":"permanent"}']); expect(r.outcome).toMatchObject({ kind: 'rejected', reason: expect.stringMatching(/Engine lehnt das ab/) }); expect(e.calls.length).toBe(1)
  })
  it('Klasse A (Einkaufsliste) wird als A erkannt, Klasse B bei Zielen', async () => {
    const { r } = await run(['{"type":"update_shopping_list","op":"add","name":"Milch"}'], 'Setze Milch auf die Einkaufsliste.'); expect(r.outcome).toMatchObject({ kind: 'commands', cls: 'A' })
  })
  it('Engine-Fehler → failed mit verständlicher Meldung; nächster Lauf funktioniert wieder', async () => {
    const e = new FakeEngine([new Error('The current Object has already been disposed'), '{"type":"none"}', '{"type":"none"}']), h = hostWith([e]); await h.load('m'); const s = baseState()
    const a = await interpret(h, 'x', s, T); expect(a.outcome).toMatchObject({ kind: 'failed', code: 'engine', message: expect.stringMatching(/neu gestartet/) })
    const b = await interpret(h, 'Erkläre Keto', s, T); expect(b.outcome.kind).toBe('none')
  })
  it('Grammatik-Modus übergibt ein Schema (String), kein schemaloses json_object', async () => {
    const { e } = await run(['{"type":"none"}'], 'Erkläre Keto', { useGrammar: true }); expect(typeof e.calls[0].opts.schema).toBe('string'); expect(e.calls[0].opts.schema!.length).toBeGreaterThan(50)
    const x = await run(['{"type":"none"}'], 'Erkläre Keto', { useGrammar: false }); expect(x.e.calls[0].opts.schema).toBeUndefined()
  })
  it('„Idealmodell“: für alle gemeinsamen Fälle liefert die Pipeline mit korrekter Modellantwort das erwartete Ergebnis', async () => {
    const ideal: Record<string, object> = {
      o1: { type: 'update_calorie_target', kcal: 4000, scope: 'today' }, o2: { type: 'update_calorie_target', kcal: 2800, scope: 'permanent' }, o3: { type: 'update_macros', protein_g: 180 },
      o4: { type: 'update_shopping_list', op: 'add', name: 'Milch' }, o5: { type: 'update_calorie_target', kcal: 3000 }, o6: { type: 'none' }, f2: { type: 'update_calorie_target', kcal: 2800, scope: 'permanent' },
      f4: { type: 'set_diets', styles: ['vegetarisch'], day_offset: 1 }, f5: { type: 'update_food_preferences', food_name: 'Milch', preference: 'not_preferred' }, f5b: { type: 'update_food_preferences', food_name: 'Skyr', preference: 'not_preferred' },
      f6: { type: 'swap_meal_request', slot: 'abend', focus: 'protein' }, f7: { type: 'update_calorie_target', delta_kcal: 300, scope: 'today' }, f8: { type: 'restore_previous_calorie_target' }, f8b: { type: 'restore_previous_calorie_target' } }
    for (const c of CASES) {
      const s = c.setup ? c.setup(baseState()) : baseState(), snap = JSON.stringify(s), e = new FakeEngine([JSON.stringify(ideal[c.id])]), h = hostWith([e]); await h.load('m')
      const r = await interpret(h, c.text, s, T); const v = judge(r.outcome, c, s, JSON.parse(snap)); expect(v.details, `${c.id}: ${JSON.stringify(r.outcome).slice(0, 200)}`).toEqual([])
    }
  })
})
