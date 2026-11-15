import { describe, expect, it } from 'vitest'
import { BUILTIN_DATA_VERSION, BUILTIN_FOODS } from '../data/foods'
import { BUILTIN_RECIPES } from '../data/recipes'
import { defaultState } from './defaults'
import { BACKUP_KEY, STORAGE_KEY, STORAGE_PREFIX, clearAllStorage, loadFromStorage, parseJsonText, parseState, saveToStorage, type KV } from './persistence'
import { generatePlan } from './planner'
import type { AppState } from './types'

class MemKV implements KV {
  m = new Map<string, string>()
  get length() { return this.m.size }
  key(i: number) { return [...this.m.keys()][i] ?? null }
  getItem(k: string) { return this.m.get(k) ?? null }
  setItem(k: string, v: string) { this.m.set(k, v) }
  removeItem(k: string) { this.m.delete(k) }
}
const withPlan = (): AppState => {
  const s = defaultState(); s.onboarded = true
  s.plan = generatePlan({ profile: s.profile, foods: s.foods, recipes: s.recipes, prefs: s.prefs, startDate: '2026-11-16', days: 7, seed: 3 })
  s.weights = [{ date: '2026-11-16', kg: 80.5 }]
  return s
}
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x))

describe('Speichern und Laden', () => {
  it('Roundtrip: gespeicherter Zustand wird unverändert geladen', () => {
    const kv = new MemKV(), s = withPlan()
    expect(saveToStorage(kv, s)).toBe(true)
    const r = loadFromStorage(kv)
    expect(r.warnings).toEqual([])
    expect(clone(r.state)).toEqual(clone(s))
  })
  it('ohne gespeicherte Daten: Standardzustand, keine Warnung', () => {
    const r = loadFromStorage(new MemKV())
    expect(r.warnings).toEqual([]); expect(r.state.onboarded).toBe(false)
  })
  it('nicht lesbares JSON: App startet mit Standardzustand, Rohdaten werden gesichert (nicht überschrieben)', () => {
    const kv = new MemKV(); kv.setItem(STORAGE_KEY, '{kaputt')
    const r = loadFromStorage(kv)
    expect(r.warnings[0]).toMatch(/nicht lesbar/)
    expect(kv.getItem(BACKUP_KEY)).toBe('{kaputt')
  })
  it('beschädigter Plan (days kein Array) → nur der Plan wird verworfen, alles andere bleibt erhalten', () => {
    const kv = new MemKV(), s = withPlan()
    s.profile.age = 51; s.prefs.excludedFoods = ['tomate']
    const bad = clone(s) as unknown as Record<string, unknown>
    ;(bad.plan as Record<string, unknown>).days = 'kaputt'
    kv.setItem(STORAGE_KEY, JSON.stringify(bad))
    const r = loadFromStorage(kv)
    expect(r.state.plan).toBeNull()
    expect(r.state.profile.age).toBe(51); expect(r.state.prefs.excludedFoods).toEqual(['tomate']); expect(r.state.weights).toHaveLength(1)
    expect(r.warnings.join()).toMatch(/Ernährungsplan.*zurückgesetzt/)
  })
  it('beschädigtes Profil/Einstellungen werden einzeln zurückgesetzt', () => {
    const bad = clone(withPlan()) as unknown as Record<string, unknown>
    bad.profile = { age: 'x' }; bad.prefs = { styles: [] }
    const kv = new MemKV(); kv.setItem(STORAGE_KEY, JSON.stringify(bad))
    const r = loadFromStorage(kv)
    expect(r.warnings.length).toBe(2); expect(r.state.plan).not.toBeNull()
  })
  it('Speicher nicht verfügbar → Warnung statt Absturz', () => {
    const broken: KV = { length: 0, key: () => null, getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('quota') }, removeItem: () => {} }
    expect(loadFromStorage(broken).warnings[0]).toMatch(/nicht zugänglich/)
    expect(saveToStorage(broken, defaultState())).toBe(false)
  })
})

describe('Migration v1 → v2', () => {
  const v1 = () => {
    const s = clone(defaultState()) as unknown as Record<string, unknown>
    s.version = 1; delete s.dataVersion; delete s.ai
    const prefs = s.prefs as Record<string, unknown>; delete prefs.customRules; delete prefs.strictTraces
    s.foods = [
      { id: 'tomate', name: 'ALT Tomate', category: 'gemuese', kcal: 999, protein: 1, carbs: 1, fat: 1, fiber: 1, allergens: [], allergenInfoKnown: true, animal: 'none', source: 'alt', verified: false },
      { id: 'custom-1', name: 'Mein Riegel', category: 'sonstige', kcal: 400, protein: 10, carbs: 50, fat: 15, fiber: 3, allergens: ['soja'], allergenInfoKnown: true, animal: 'none', source: 'Eigene Angabe', verified: false, custom: true },
    ]
    s.recipes = [{ id: 'r-haferbowl', name: 'alt', slots: ['fruehstueck'], minutes: 5, ingredients: [{ foodId: 'haferflocken', grams: 50 }], steps: [], tags: [], favorite: true },
      { id: 'custom-r', name: 'Mein Rezept', slots: ['mittag'], minutes: 5, ingredients: [{ foodId: 'custom-1', grams: 50 }], steps: ['x'], tags: [], custom: true }]
    s.onboarded = true
    return s
  }
  it('Altdaten werden geladen: Standarddaten aufgefrischt, eigene Lebensmittel/Rezepte und Favoriten bleiben erhalten', () => {
    const r = parseState(v1(), 'load')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const s = r.state
    expect(s.version).toBe(2); expect(s.dataVersion).toBe(BUILTIN_DATA_VERSION)
    expect(s.foods.find(f => f.id === 'tomate')!.kcal).toBe(BUILTIN_FOODS.find(f => f.id === 'tomate')!.kcal) // aufgefrischt
    expect(s.foods.length).toBe(BUILTIN_FOODS.length + 1)
    const mine = s.foods.find(f => f.id === 'custom-1')!
    expect(mine).toMatchObject({ name: 'Mein Riegel', kcal: 400, allergens: ['soja'], dataQuality: 'user', traces: [], prep: 'roh' })
    expect(s.recipes.find(x => x.id === 'custom-r')).toBeDefined()
    expect(s.recipes.find(x => x.id === 'r-haferbowl')!.favorite).toBe(true)
    expect(s.recipes.length).toBe(BUILTIN_RECIPES.length + 1)
    expect(s.prefs.strictTraces).toBe(true); expect(s.prefs.customRules).toEqual([]); expect(s.ai.consent).toBe(false)
  })
})

describe('Import (streng)', () => {
  const ok = () => JSON.stringify(withPlan())
  it('gültige Sicherung wird akzeptiert', () => { expect(parseJsonText(ok(), 'import').ok).toBe(true) })
  it('kein JSON / kein Objekt / leer', () => {
    for (const t of ['', 'abc', '[1,2]', 'null', '"x"', '123']) { const r = parseJsonText(t, 'import'); expect(r.ok, t).toBe(false) }
  })
  it('inkompatible oder fehlende Version, fehlende Kernfelder', () => {
    const o = JSON.parse(ok())
    expect(parseJsonText(JSON.stringify({ ...o, version: 99 }), 'import')).toMatchObject({ ok: false, error: expect.stringContaining('Inkompatible') })
    const noVer = { ...o }; delete noVer.version
    expect(parseJsonText(JSON.stringify(noVer), 'import').ok).toBe(false)
    const noOn = { ...o }; delete noOn.onboarded
    expect(parseJsonText(JSON.stringify(noOn), 'import').ok).toBe(false)
  })
  it('unvollständige Datei (Abschnitt fehlt) und beschädigte Abschnitte werden im Importmodus abgelehnt, nicht stillschweigend ersetzt', () => {
    const o = JSON.parse(ok())
    for (const key of ['profile', 'prefs', 'foods', 'recipes', 'plan', 'shopping', 'weights', 'eaten', 'ai']) {
      const miss = { ...o }; delete miss[key]
      expect(parseJsonText(JSON.stringify(miss), 'import'), key).toMatchObject({ ok: false, error: expect.stringContaining('unvollständig') })
    }
    const bad = { ...o, plan: { ...o.plan, days: 'x' } }
    expect(parseJsonText(JSON.stringify(bad), 'import')).toMatchObject({ ok: false, error: expect.stringContaining('Ernährungsplan') })
    const badFood = { ...o, foods: [{ id: 'x' }] }
    expect(parseJsonText(JSON.stringify(badFood), 'import').ok).toBe(false)
    const badWeight = { ...o, weights: [{ date: '2026-01-01', kg: -5 }] }
    expect(parseJsonText(JSON.stringify(badWeight), 'import').ok).toBe(false)
  })
  it('manipulierte Werte außerhalb der Bereiche werden abgelehnt (kcal-Ziel, Portionsfaktor, Datum)', () => {
    const o = JSON.parse(ok())
    const a = clone(o); a.plan.kcalTarget = 999999
    const b = clone(o); b.plan.days[0].meals[0].factor = 500
    const c = clone(o); c.plan.startDate = 'morgen'
    for (const x of [a, b, c]) expect(parseJsonText(JSON.stringify(x), 'import').ok).toBe(false)
  })
  it('Export enthält vollständig alle Daten (Roundtrip über JSON)', () => {
    const s = withPlan(); s.eaten = { m1: true }; s.shopping.manual = [{ id: 'a', name: 'Seife', amount: '1', checked: false }]
    s.ai.chat = [{ id: 'c1', role: 'user', content: 'Hallo', ts: '2026-11-15T10:00:00Z' }]
    const r = parseJsonText(JSON.stringify(s), 'import')
    expect(r.ok && clone(r.state)).toEqual(clone(s))
  })
})

describe('Vollständige Datenlöschung', () => {
  it('entfernt alle App-Schlüssel (Zustand, Backup, künftige), lässt fremde Schlüssel unberührt', () => {
    const kv = new MemKV()
    kv.setItem(STORAGE_KEY, 'x'); kv.setItem(BACKUP_KEY, 'y'); kv.setItem(`${STORAGE_PREFIX}zukunft`, 'z'); kv.setItem('fremd', 'a')
    const removed = clearAllStorage(kv)
    expect(removed.sort()).toEqual([BACKUP_KEY, `${STORAGE_PREFIX}zukunft`, STORAGE_KEY].sort())
    expect([...kv.m.keys()]).toEqual(['fremd'])
    expect(loadFromStorage(kv).state.onboarded).toBe(false)
  })
})
