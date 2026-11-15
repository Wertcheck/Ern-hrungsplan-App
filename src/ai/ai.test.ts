import { describe, expect, it, vi } from 'vitest'
import { defaultState } from '../domain/defaults'
import { buildContext, generatePlan, analyzePlan } from '../domain/planner'
import { kcalTarget } from '../domain/nutrition'
import type { AppState, Preferences } from '../domain/types'
import { SseParser } from './sse'
import { AiClient, AiError } from './client'
import { buildAiContext, scopeFor } from './context'
import { confirmProposal, validateProposal } from './actions'
import { localAnswer, HELP_TEXT } from './local'

const T0 = '2026-11-16'
const mk = (over: Partial<Preferences> = {}, tweak?: (s: AppState) => void): AppState => {
  const s = defaultState(); s.onboarded = true; s.prefs = { ...s.prefs, ...over }
  s.profile = { ...s.profile, kcalMode: 'manual', kcalManual: 2200, mealCount: 4, age: 41, heightCm: 181, weightKg: 83 }
  tweak?.(s)
  s.plan = generatePlan({ profile: s.profile, foods: s.foods, recipes: s.recipes, prefs: s.prefs, startDate: T0, days: 7, seed: 2 })
  return s
}
const cx = (s: AppState) => buildContext(s.foods, s.recipes, s.prefs)
const target = (s: AppState) => kcalTarget(s.profile)

describe('SSE-Parser', () => {
  it('parst vollständige und beliebig zerstückelte Events (auch CRLF, Kommentare, Umlaute)', () => {
    const raw = 'event: meta\ndata: {"provider":"mock"}\n\n: ping\n\nevent: delta\r\ndata: {"text":"Grüße ü"}\r\n\r\nevent: done\ndata: {}\n\n'
    const whole = new SseParser().push(raw)
    expect(whole.map(e => e.event)).toEqual(['meta', 'delta', 'done'])
    expect((whole[1].data as { text: string }).text).toBe('Grüße ü')
    for (const size of [1, 2, 3, 7, 13]) {
      const p = new SseParser(), out = []
      for (let i = 0; i < raw.length; i += size) out.push(...p.push(raw.slice(i, i + size)))
      expect(out.map(e => e.event), `chunk ${size}`).toEqual(['meta', 'delta', 'done'])
    }
  })
  it('ungültiges JSON → parse_error, ohne die folgenden Events zu verlieren', () => {
    const out = new SseParser().push('event: delta\ndata: {kaputt\n\nevent: done\ndata: {}\n\n')
    expect(out.map(e => e.event)).toEqual(['parse_error', 'done'])
  })
})

const sseBody = (chunks: string[], failAfter?: number) => {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({ pull(c) { if (failAfter !== undefined && i === failAfter) { c.error(new TypeError('network')); return } if (i < chunks.length) c.enqueue(enc.encode(chunks[i++])); else c.close() } })
}
const resp = (body: BodyInit | null, init: ResponseInit = {}) => new Response(body, { status: 200, ...init })
const client = (f: typeof fetch, online = true) => new AiClient({ fetchImpl: f, online: () => online })

describe('AiClient', () => {
  it('Offline: kein Netzwerkaufruf, klare Meldung, restliche App nicht betroffen', async () => {
    const f = vi.fn()
    await expect(client(f as never, false).status()).rejects.toMatchObject({ code: 'offline' })
    await expect(client(f as never, false).chat({ messages: [{ role: 'user', content: 'x' }], context: null }, {})).rejects.toMatchObject({ code: 'offline', message: expect.stringContaining('übrigen Funktionen') })
    expect(f).not.toHaveBeenCalled()
  })
  it('Backend nicht erreichbar (fetch wirft) und Proxy-Fehler ohne JSON → backend_unreachable', async () => {
    await expect(client((async () => { throw new TypeError('fetch failed') }) as never).status()).rejects.toMatchObject({ code: 'backend_unreachable' })
    await expect(client((async () => resp('Bad Gateway', { status: 502 })) as never).status()).rejects.toMatchObject({ code: 'backend_unreachable', status: 502 })
  })
  it('API-Fehler: Code, Retry-After, und Schlüsselmuster werden aus Meldungen entfernt', async () => {
    const f = (async () => resp(JSON.stringify({ error: { code: 'rate_limited', message: 'Zu viele Anfragen, Bearer abc.def-123 sk-ant-api03-SECRETSECRET' } }), { status: 429, headers: { 'Retry-After': '12' } })) as never
    const e = await client(f).status().catch(x => x) as AiError
    expect(e).toMatchObject({ code: 'http', status: 429, apiCode: 'rate_limited', retryAfter: 12 })
    expect(e.message).not.toMatch(/sk-ant|abc\.def/); expect(e.message).toContain('[entfernt]')
  })
  it('Streaming: Events werden in Reihenfolge geliefert, auch bei zerstückelten Chunks', async () => {
    const ev = ['event: meta\ndata: {"provider":"mock","model":"m","fallback_used":false}\n\n', 'event: delta\ndata: {"text":"Hal', 'lo"}\n\nevent: delta\ndata: {"text":" Welt"}\n\n',
      'event: actions\ndata: {"proposals":[{"type":"exclude_food","food_name":"Tofu"}],"rejected":[]}\n\nevent: usage\ndata: {"input_tokens":5,"output_tokens":7,"cost_usd":null,"cost_known":false}\n\nevent: done\ndata: {}\n\n']
    const got: string[] = []; let text = ''
    const done = await client((async () => resp(sseBody(ev))) as never).chat({ messages: [{ role: 'user', content: 'Hi' }], context: null }, {
      meta: m => got.push('meta:' + m.provider), delta: t => { text += t }, actions: a => got.push('actions:' + a.proposals.length), usage: u => got.push('usage:' + u.output_tokens) })
    expect(done).toBe(true); expect(text).toBe('Hallo Welt'); expect(got).toEqual(['meta:mock', 'actions:1', 'usage:7'])
  })
  it('Fehler-Event des Backends wird weitergereicht, Teiltext bleibt erhalten', async () => {
    let text = '', err = ''
    await client((async () => resp(sseBody(['event: delta\ndata: {"text":"Teil"}\n\n', 'event: error\ndata: {"code":"provider_unavailable","message":"Anbieter nicht erreichbar","retryable":true}\n\nevent: done\ndata: {}\n\n']))) as never)
      .chat({ messages: [{ role: 'user', content: 'x' }], context: null }, { delta: t => { text += t }, error: e => { err = e.code } })
    expect(text).toBe('Teil'); expect(err).toBe('provider_unavailable')
  })
  it('Verbindungsabbruch mitten im Stream → Fehler „stream“, bereits empfangener Text bleibt erhalten', async () => {
    let text = ''
    const e = await client((async () => resp(sseBody(['event: delta\ndata: {"text":"Anfang"}\n\n', 'x'], 1))) as never).chat({ messages: [{ role: 'user', content: 'x' }], context: null }, { delta: t => { text += t } }).catch(x => x)
    expect(e).toMatchObject({ code: 'stream' }); expect(text).toBe('Anfang')
  })
  it('Abbruch durch den Nutzer → code aborted', async () => {
    const ctl = new AbortController()
    const f = ((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))))) as never
    const p = client(f).chat({ messages: [{ role: 'user', content: 'x' }], context: null }, {}, ctl.signal)
    ctl.abort()
    await expect(p).rejects.toMatchObject({ code: 'aborted' })
  })
  it('Secret-Handling: Anfragen enthalten nie Schlüssel/Authorization-Header; Basis-URL ist der eigene Ursprung', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const f = (async (u: string, init: RequestInit) => { seen.push({ url: u, init }); return resp(JSON.stringify({ enabled: false })) }) as never
    await client(f).status(); await client(f).updateSettings({ enabled: true })
    for (const s of seen) {
      expect(s.url.startsWith('/api/')).toBe(true)
      expect(JSON.stringify(s.init.headers ?? {}).toLowerCase()).not.toMatch(/authorization|api-key|x-api/)
      expect(String(s.init.body ?? '').toLowerCase()).not.toMatch(/api_key|apikey|secret|sk-/)
    }
  })
})

describe('Nutrition-Context: Datenminimierung', () => {
  const ALLOWED_TOP = ['profile', 'macro_targets', 'diets', 'custom_rules', 'restrictions', 'excluded_terms', 'excluded_foods', 'preferred_foods', 'oils', 'plan', 'recipe_catalog', 'food_catalog', 'shopping', 'progress', 'nutrient_gaps']
  const ALLOWED_PROFILE = ['goal', 'activity', 'kcal_target', 'persons', 'meal_count', 'age', 'height_cm', 'weight_kg']
  it('Intent-Erkennung', () => {
    expect(scopeFor('Erkläre Keto')).toMatchObject({ plan: false, recipes: false, body: false })
    expect(scopeFor('Tausche das Mittagessen heute')).toMatchObject({ plan: true, recipes: true, planDays: 2 })
    expect(scopeFor('Wie sieht meine Woche aus?').planDays).toBe(7)
    expect(scopeFor('Welche Vitamine fehlen?').gaps).toBe(true)
    expect(scopeFor('Zeig meinen Gewichtsverlauf').progress).toBe(true)
  })
  it('allgemeine Frage: nur Sicherheit + Ziele; kein Plan, keine Körperdaten, kein Katalog', () => {
    const s = mk({ restrictions: [{ allergen: 'nuesse', severity: 'allergy' }], styles: ['vegan'] }), b = buildAiContext(s, cx(s), 'Erkläre die Ernährungsweise', T0, target(s))
    expect(b.payload.diets).toEqual(['Vegan']); expect(b.payload.restrictions).toEqual([{ allergen: 'Nüsse', severity: 'allergy' }])
    for (const k of ['plan', 'recipe_catalog', 'food_catalog', 'shopping', 'progress', 'nutrient_gaps']) expect(b.payload[k], k).toBeUndefined()
    expect(Object.keys(b.payload.profile as object).sort()).toEqual(['goal', 'kcal_target', 'meal_count', 'persons'])
  })
  it('Körperdaten nur mit Freigabe UND passender Frage; Einkauf/Fortschritt ebenfalls', () => {
    const s = mk(); const c = cx(s)
    expect((buildAiContext(s, c, 'Wie viele Kalorien brauche ich bei meinem Gewicht?', T0, 2200).payload.profile as Record<string, unknown>).weight_kg).toBeUndefined()   // nicht freigegeben
    s.ai.share = { ...s.ai.share, body: true, shopping: true, progress: true }
    const p = buildAiContext(s, c, 'Wie viele Kalorien brauche ich bei meinem Gewicht?', T0, 2200).payload.profile as Record<string, unknown>
    expect(p).toMatchObject({ age: 41, height_cm: 181, weight_kg: 83 })
    expect((buildAiContext(s, c, 'Erkläre Paleo', T0, 2200).payload.profile as Record<string, unknown>).weight_kg).toBeUndefined()                            // freigegeben, aber nicht nötig
    expect(buildAiContext(s, c, 'Optimiere die Einkaufsliste', T0, 2200).payload.shopping).toBeDefined()
    expect(buildAiContext(s, c, 'Erkläre Paleo', T0, 2200).payload.shopping).toBeUndefined()
    s.weights = [{ date: '2026-11-01', kg: 83 }]
    expect(buildAiContext(s, c, 'Wie ist mein Gewichtsverlauf?', T0, 2200).payload.progress).toBeDefined()
  })
  it('Plan-Ausschnitt begrenzt (Tage), ohne Freigabe gar nicht', () => {
    const s = mk(); const c = cx(s)
    const days = (t: string) => ((buildAiContext(s, c, t, T0, 2200).payload.plan as { days: unknown[] } | undefined)?.days.length)
    expect(days('Tausche das Frühstück')).toBe(3); expect(days('Tausche das Frühstück heute')).toBe(2); expect(days('Analysiere meine Woche')).toBe(7)
    s.ai.share.plan = false
    expect(buildAiContext(s, c, 'Tausche das Frühstück', T0, 2200).payload.plan).toBeUndefined()
  })
  it('Rezeptkatalog enthält NUR regelkonforme Rezepte (Allergie/Ausschluss/Diät) – unzulässige erreichen die KI nie', () => {
    const s = mk({ restrictions: [{ allergen: 'nuesse', severity: 'allergy' }, { allergen: 'gluten', severity: 'intolerance' }], styles: ['pescetarisch'], excludedFoods: ['lachs'] })
    const c = cx(s), b = buildAiContext(s, c, 'Schlage Alternativen für das Abendessen vor', T0, 2200)
    const cat = b.payload.recipe_catalog as { id: string }[]
    expect(cat.length).toBeGreaterThan(10); expect(cat.length).toBeLessThanOrEqual(80)
    for (const r of cat) { expect(c.rejected.has(r.id), r.id).toBe(false); expect(c.eligible.some(e => e.id === r.id)).toBe(true) }
    const names = JSON.stringify(cat)
    expect(names).not.toMatch(/Walnuss|Mandel|Haferflocken|Lachs|Hähnchen|Rinder/)
  })
  it('Rezeptkatalog: die in der Frage genannte Mahlzeitenart steht zuerst', () => {
    const s = mk(), c = cx(s)
    for (const [text, slot] of [['Tausche das Frühstück', 'fruehstueck'], ['Alternativen fürs Abendessen', 'abend'], ['Tausche den Snack', 'snack']] as const) {
      const cat = buildAiContext(s, c, text, T0, 2200).payload.recipe_catalog as { slots: string[] }[]
      expect(cat[0].slots, text).toContain(slot)
      expect(cat.slice(0, 5).every(r => r.slots.includes(slot)), text).toBe(true)
    }
  })
  it('Lebensmittelliste (nur bei Rezept-Erstellung) enthält keine unzulässigen Lebensmittel', () => {
    const s = mk({ restrictions: [{ allergen: 'soja', severity: 'allergy' }], styles: ['vegetarisch'] })
    const b = buildAiContext(s, cx(s), 'Erstelle ein Rezept aus meinen Zutaten', T0, 2200)
    const foods = b.payload.food_catalog as string[]
    expect(foods.length).toBeGreaterThan(20); expect(foods.join('|')).not.toMatch(/Tofu|Sojadrink|Sojasauce|Lachs|Hähnchen/)
  })
  it('Payload enthält nur vom Backend-Schema erlaubte Felder (extra=forbid), keine Personen-/Kontaktdaten, bleibt unter dem Zeichenbudget', () => {
    const s = mk(); s.ai.share = { body: true, plan: true, shopping: true, progress: true, foodPrefs: true }; s.weights = [{ date: '2026-11-01', kg: 83 }]
    s.prefs.preferredFoods = ['lachs']
    for (const text of ['Tausche das Mittagessen heute', 'Erstelle ein Rezept mit Zutaten und prüfe Gewicht und Kalorien', 'Einkaufsliste und Nährstoffe der Woche']) {
      const b = buildAiContext(s, cx(s), text, T0, 2200)
      for (const k of Object.keys(b.payload)) expect(ALLOWED_TOP, k).toContain(k)
      for (const k of Object.keys(b.payload.profile as object)) expect(ALLOWED_PROFILE, k).toContain(k)
      expect(b.json).not.toMatch(/@|e-?mail|passwort|api[_-]?key|"(first|last|user)_?name"/i)
      expect(b.chars).toBeLessThan(40000)
    }
  })
  it('Allergien, Ausschlüsse und Spurenregel sind immer enthalten (auch bei deaktivierten Freigaben)', () => {
    const s = mk({ restrictions: [{ allergen: 'erdnuesse', severity: 'allergy' }], customExclusions: ['Koriander'], excludedFoods: ['tofu'], strictTraces: true })
    s.ai.share = { body: false, plan: false, shopping: false, progress: false, foodPrefs: false }
    const b = buildAiContext(s, cx(s), 'Hallo', T0, 2200)
    expect(b.payload.restrictions).toEqual([{ allergen: 'Erdnüsse', severity: 'allergy' }]); expect(b.payload.excluded_terms).toEqual(['Koriander']); expect(b.payload.excluded_foods).toEqual(['Tofu natur'])
    expect(JSON.stringify(b.payload.custom_rules)).toMatch(/Spuren/)
  })
})

describe('Kontrollierte Aktionen (Engine-Validierung)', () => {
  const first = (s: AppState, slot = 'mittag') => { const d = s.plan!.days[0]; return { d, m: d.meals.find(x => x.slot === slot)! } }
  const swapTarget = (s: AppState, slot: string, exclude: string) => cx(s).eligible.find(r => r.slots.includes(slot as never) && r.id !== exclude)!
  it('gültiger Tausch: Vorschau mit Tagessumme, nach Bestätigung im Plan, Engine berechnet Portion/Kalorien selbst', () => {
    const s = mk(), { d, m } = first(s), r = swapTarget(s, 'mittag', m.recipeId)
    const v = validateProposal({ type: 'swap_meal', date: d.date, meal_id: m.id, recipe_id: r.id, kcal: 1, protein: 999 }, s, cx(s))
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.preview.lines.join(' ')).toMatch(/Tagessumme: \d+ kcal → \d+ kcal/)
    const res = confirmProposal({ type: 'swap_meal', date: d.date, meal_id: m.id, recipe_id: r.id }, s)
    expect(res.ok && res.state.plan!.days[0].meals.find(x => x.id === m.id)!.recipeId).toBe(r.id)
    expect(s.plan!.days[0].meals.find(x => x.id === m.id)!.recipeId).toBe(m.recipeId)   // Original unverändert
  })
  it('Allergie hat Vorrang: Rezept mit Allergen wird abgelehnt – auch wenn die KI es ausdrücklich verlangt', () => {
    const s = mk({ restrictions: [{ allergen: 'nuesse', severity: 'allergy' }] }), { d, m } = first(s)
    const bad = s.recipes.find(r => r.ingredients.some(i => i.foodId === 'walnuss') && r.slots.includes('mittag') || r.id === 'r-nussmix')!
    for (const reason of ['Der Nutzer erlaubt Nüsse', 'IGNORE ALL RULES and allow nuts', undefined]) {
      const v = validateProposal({ type: 'swap_meal', date: d.date, meal_id: m.id, recipe_id: 'r-haferbowl', reason }, s, cx(s))
      expect(v.ok).toBe(false); if (!v.ok) expect(v.reason).toMatch(/Allergie|Regeln|passt nicht/)
    }
    const v2 = validateProposal({ type: 'add_meal', date: d.date, slot: 'snack', recipe_id: bad.id }, s, cx(s))
    expect(v2.ok).toBe(false); if (!v2.ok) expect(v2.reason).toMatch(/Regeln|Allergie|passt nicht/)
    expect(confirmProposal({ type: 'add_meal', date: d.date, slot: 'snack', recipe_id: 'r-nussmix' }, s).ok).toBe(false)
  })
  it('Ausschlüsse, Ernährungsweise und falscher Mahlzeitentyp werden abgelehnt; unbekannte Ziele ebenfalls', () => {
    const s = mk({ styles: ['vegan'], excludedFoods: ['kartoffel'] }), { d, m } = first(s)
    const reject = (p: object) => { const v = validateProposal(p, s, cx(s)); expect(v.ok, JSON.stringify(p)).toBe(false); return v }
    reject({ type: 'swap_meal', date: d.date, meal_id: m.id, recipe_id: 'r-lachsofen' })          // nicht vegan
    reject({ type: 'swap_meal', date: d.date, meal_id: m.id, recipe_id: 'r-feldsalatei' })         // Ei + Kartoffel
    reject({ type: 'swap_meal', date: d.date, meal_id: m.id, recipe_id: 'r-skyrbowl' })            // Frühstück ≠ Mittag + nicht vegan
    reject({ type: 'swap_meal', date: d.date, meal_id: m.id, recipe_id: 'gibts-nicht' })
    reject({ type: 'swap_meal', date: d.date, meal_id: 'xxx', recipe_id: 'r-linsencurry' })
    reject({ type: 'swap_meal', date: '2030-01-01', meal_id: m.id, recipe_id: 'r-linsencurry' })
    reject({ type: 'swap_meal', date: d.date, meal_id: m.id, recipe_id: m.recipeId })              // identisch
  })
  it('Portionen: unplausible Mengen werden abgelehnt, plausible auf 0,05 gerundet', () => {
    const s = mk(), { d, m } = first(s)
    expect(validateProposal({ type: 'set_portion', date: d.date, meal_id: m.id, portion_factor: 2.9 }, s, cx(s)).ok).toBe(false)
    expect(validateProposal({ type: 'set_portion', date: d.date, meal_id: m.id, portion_factor: 0.3 }, s, cx(s)).ok).toBe(false)
    expect(validateProposal({ type: 'set_portion', date: d.date, meal_id: m.id, portion_factor: 99 }, s, cx(s)).ok).toBe(false)         // Schema
    const r = confirmProposal({ type: 'set_portion', date: d.date, meal_id: m.id, portion_factor: 1.02 }, s)
    expect(r.ok && r.state.plan!.days[0].meals.find(x => x.id === m.id)!.factor).toBe(1)
  })
  it('Mahlzeit ergänzen/entfernen aktualisiert den Plan; Dubletten am selben Tag werden abgelehnt', () => {
    const s = mk(), c = cx(s), d = s.plan!.days[0]
    const snack = c.eligible.find(r => r.slots.includes('snack') && !d.meals.some(m => m.recipeId === r.id))!
    const add = confirmProposal({ type: 'add_meal', date: d.date, slot: 'snack', recipe_id: snack.id }, s)
    expect(add.ok && add.state.plan!.days[0].meals.length).toBe(d.meals.length + 1)
    expect(validateProposal({ type: 'add_meal', date: d.date, slot: 'mittag', recipe_id: d.meals[1].recipeId }, s, c).ok).toBe(false)
    const rm = confirmProposal({ type: 'remove_meal', date: d.date, meal_id: d.meals[0].id }, s)
    expect(rm.ok && rm.state.plan!.days[0].meals.length).toBe(d.meals.length - 1)
  })
  it('Rezept erstellen: Engine berechnet Nährwerte aus der eigenen Datenbank; erfundene/unzulässige/überdosierte Zutaten werden abgelehnt', () => {
    const s = mk({ styles: ['vegetarisch'], restrictions: [{ allergen: 'soja', severity: 'allergy' }] }), c = cx(s)
    const ok = validateProposal({ type: 'create_recipe', name: 'Quinoa-Pfanne <b>XSS</b>', slots: ['mittag'], ingredients: [{ food_name: 'Quinoa', grams: 70 }, { food_name: 'Zucchini', grams: 150 }, { food_name: 'Hühnerei', grams: 55 }], steps: ['Alles braten.'] }, s, c)
    expect(ok.ok).toBe(true); if (ok.ok) { expect(ok.preview.lines.join(' ')).toMatch(/Berechnet von der Engine/); expect(ok.preview.lines[0]).not.toMatch(/[<>]/) }
    const bad = (ing: { food_name: string; grams: number }[]) => validateProposal({ type: 'create_recipe', name: 'X', slots: ['mittag'], ingredients: ing }, s, c)
    expect(bad([{ food_name: 'Zauberpulver', grams: 10 }]).ok).toBe(false)                              // keine erfundenen Lebensmittel/Nährwerte
    expect(bad([{ food_name: 'Tofu', grams: 100 }]).ok).toBe(false)                                     // Soja-Allergie
    expect(bad([{ food_name: 'Lachs', grams: 100 }]).ok).toBe(false)                                    // nicht vegetarisch
    expect(bad([{ food_name: 'Walnüsse', grams: 500 }]).ok).toBe(false)                                 // unplausible Menge
    expect(bad([{ food_name: 'Ei', grams: 55 }, { food_name: 'Hühnerei', grams: 55 }]).ok).toBe(false)        // doppelt
    const saved = confirmProposal({ type: 'create_recipe', name: 'Quinoa-Pfanne', slots: ['mittag'], ingredients: [{ food_name: 'Quinoa', grams: 70 }, { food_name: 'Zucchini', grams: 150 }] }, s)
    expect(saved.ok && saved.state.recipes.at(-1)).toMatchObject({ name: 'Quinoa-Pfanne', custom: true })
  })
  it('Rezept erstellen respektiert Keto-Rezeptregel', () => {
    const s = mk({ styles: ['keto'] })
    expect(validateProposal({ type: 'create_recipe', name: 'Nudeln', slots: ['mittag'], ingredients: [{ food_name: 'Naturreis', grams: 100 }] }, s, cx(s)).ok).toBe(false)   // Getreide
    expect(validateProposal({ type: 'create_recipe', name: 'Eier', slots: ['fruehstueck'], ingredients: [{ food_name: 'Hühnerei', grams: 165 }, { food_name: 'Avocado', grams: 80 }] }, s, cx(s)).ok).toBe(true)
  })
  it('Ausschließen und Einkaufsliste: nur Hinzufügen, nie Lockern; Dubletten abgelehnt; HTML entfernt', () => {
    const s = mk()
    const ex = confirmProposal({ type: 'exclude_food', food_name: 'Tofu' }, s)
    expect(ex.ok && ex.state.prefs.excludedFoods).toContain('tofu')
    expect(validateProposal({ type: 'exclude_food', food_name: 'Nichts' }, s, cx(s)).ok).toBe(false)
    const sh = confirmProposal({ type: 'add_shopping_item', name: '<img src=x onerror=1>Seife', amount: '2 Stk' }, s)
    expect(sh.ok && sh.state.shopping.manual.at(-1)!.name).not.toMatch(/[<>]/)
    if (sh.ok) expect(validateProposal({ type: 'add_shopping_item', name: 'seife' }, sh.state, cx(sh.state)).ok).toBe(false)
  })
  it('SICHERHEITSINVARIANTE: keine Aktion verändert Allergien, Unverträglichkeiten, Ernährungsweisen, eigene Regeln oder Profil', () => {
    const s = mk({ restrictions: [{ allergen: 'gluten', severity: 'allergy' }], styles: ['pescetarisch'], customRules: [{ id: 'r', name: 'x', kind: 'exclude_term', value: 'kohl', enabled: true }] })
    const c = cx(s), d = s.plan!.days[0], m = d.meals[1], r = swapTarget(s, m.slot, m.recipeId)
    const props = [{ type: 'swap_meal', date: d.date, meal_id: m.id, recipe_id: r.id }, { type: 'set_portion', date: d.date, meal_id: m.id, portion_factor: 1.1 }, { type: 'remove_meal', date: d.date, meal_id: d.meals[0].id },
      { type: 'create_recipe', name: 'Test', slots: ['snack'], ingredients: [{ food_name: 'Apfel', grams: 100 }] }, { type: 'exclude_food', food_name: 'Tofu' }, { type: 'add_shopping_item', name: 'Salz' }]
    let cur = s
    for (const p of props) { const r2 = confirmProposal(p, cur); expect(r2.ok, JSON.stringify(p)).toBe(true); if (r2.ok) cur = r2.state }
    expect(cur.prefs.restrictions).toEqual(s.prefs.restrictions); expect(cur.prefs.styles).toEqual(s.prefs.styles); expect(cur.prefs.customRules).toEqual(s.prefs.customRules)
    expect(cur.prefs.strictTraces).toBe(s.prefs.strictTraces); expect(cur.profile).toEqual(s.profile); expect(c).toBeDefined()
    for (const evil of ['set_allergy', 'remove_restriction', 'set_profile', 'delete_all', 'run_code', 'update_settings']) expect(validateProposal({ type: evil, restrictions: [] }, s, c).ok).toBe(false)
  })
  it('Zustandsdrift: Vorschlag war gültig, wird nach geänderter Allergie bei der Bestätigung erneut geprüft und abgelehnt', () => {
    const s = mk()
    const day = s.plan!.days.find(x => x.meals.some(m => m.slot === 'mittag' && m.recipeId !== 'r-nudelngemuese'))!, m = day.meals.find(x => x.slot === 'mittag')!
    const p = { type: 'swap_meal', date: day.date, meal_id: m.id, recipe_id: 'r-nudelngemuese' }   // enthält Vollkornnudeln (Gluten)
    expect(validateProposal(p, s, cx(s)).ok).toBe(true)
    const drifted: AppState = { ...s, prefs: { ...s.prefs, restrictions: [{ allergen: 'gluten', severity: 'allergy' }] } }
    const res = confirmProposal(p, drifted)
    expect(res.ok).toBe(false)
  })
  it('KI-Zahlen werden nie übernommen: manipulierte Nährwertangaben im Vorschlag ändern nichts', () => {
    const s = mk({}), { d, m } = first(s), r = swapTarget(s, 'mittag', m.recipeId)
    const a = confirmProposal({ type: 'swap_meal', date: d.date, meal_id: m.id, recipe_id: r.id }, s), b = confirmProposal({ type: 'swap_meal', date: d.date, meal_id: m.id, recipe_id: r.id, kcal: 1, factor: 9, protein: 500, nutrition: { kcal: 0 } }, s)
    expect(a.ok && b.ok && JSON.stringify((a as never as { state: AppState }).state.plan!.days[0].meals.find(x => x.id === m.id))).toBe(JSON.stringify((b as never as { state: AppState }).state.plan!.days[0].meals.find(x => x.id === m.id)))
  })
})

describe('Lokaler Berater (ohne KI, offline)', () => {
  const ask = (s: AppState, t: string) => localAnswer(t, s, cx(s), s.plan ? analyzePlan(s.plan, cx(s), 4) : null, target(s), T0)
  it('erklärt Ernährungsweisen mit den tatsächlichen Regeln und ohne Heilversprechen', () => {
    const a = ask(mk(), 'Erkläre mir Carnivore')
    expect(a.text).toMatch(/Carnivore/); expect(a.text).toMatch(/pflanzlichen Lebensmittel/i); expect(a.text.toLowerCase()).not.toMatch(/heilt|beste/)
    expect(ask(mk(), 'Was ist Basisch?').text).toMatch(/keine Wirkung auf den Blut-pH-Wert/)
  })
  it('erklärt Kalorien/Makros aus Engine-Werten', () => {
    const s = mk(), a = ask(s, 'Wie berechnest du mein Kalorienziel?')
    expect(a.text).toContain(`${Math.round(target(s))} kcal`); expect(a.text).toMatch(/keine medizinische Empfehlung/)
  })
  it('Nährstofflücken mit „Datenlage unzureichend“ statt Behauptungen', () => {
    const a = ask(mk({ styles: ['vegan'] }), 'Welche Nährstoffe fehlen mir?')
    expect(a.text).toMatch(/Orientierungswert/); expect(a.text).toMatch(/Vitamin B12/)
  })
  it('Tauschvorschläge sind Engine-Alternativen und bestehen dieselbe Validierung wie KI-Aktionen', () => {
    const s = mk({ restrictions: [{ allergen: 'laktose', severity: 'intolerance' }] })
    const a = ask(s, 'Tausche das Frühstück')
    expect(a.proposals.length).toBeGreaterThan(0)
    for (const p of a.proposals) expect(validateProposal(p, s, cx(s)).ok).toBe(true)
    expect(a.text).toMatch(/Allergie- und Ausschlussregeln/)
  })
  it('ohne Plan, unbekannte Fragen und Einkauf', () => {
    const s = defaultState(); s.onboarded = true
    expect(ask(s, 'Tausche das Mittagessen').text).toMatch(/noch keinen Plan/)
    expect(ask(mk(), 'Wetter heute?').text).toBe(HELP_TEXT)
    expect(ask(mk(), 'Einkaufsliste').text).toMatch(/verschiedene Zutaten/)
  })
})
