import { describe, expect, it } from 'vitest'
import { BUILTIN_FOODS } from '../data/foods'
import { BUILTIN_RECIPES } from '../data/recipes'
import { defaultPrefs, defaultProfile } from './defaults'
import { buildContext, generatePlan } from './planner'
import { COVERAGE_MIN, FIBER_REF, MICRO_REFERENCE, analyzeGaps } from './nutrients'
import { MICRO_KEYS, type Food, type Preferences, type Profile, type Style } from './types'

const setup = (styles: Style[] = ['mischkost'], prof: Partial<Profile> = {}, foods: Food[] = BUILTIN_FOODS) => {
  const prefs: Preferences = { ...defaultPrefs(), styles }
  const profile = { ...defaultProfile(), kcalMode: 'manual' as const, kcalManual: 2200, mealCount: 4 as const, ...prof }
  const plan = generatePlan({ profile, foods, recipes: BUILTIN_RECIPES, prefs, startDate: '2026-11-16', days: 7, seed: 1 })
  const ctx = buildContext(foods, BUILTIN_RECIPES, prefs)
  return { plan, ctx, profile, prefs, report: analyzeGaps(plan, ctx, profile, prefs) }
}
const row = (r: ReturnType<typeof analyzeGaps>, k: string) => r.rows.find(x => x.key === k)!

describe('Nährstoffbilanz', () => {
  it('liefert alle elf Mikronährstoffe plus Ballaststoffe und Eiweiß, Zufuhr getrennt von Referenzwert', () => {
    const { report } = setup()
    expect(report.rows.map(r => r.key)).toEqual([...MICRO_KEYS, 'fiber', 'protein'])
    for (const r of report.rows) { expect(r.intake).toBeGreaterThanOrEqual(0); expect(r.reference).toBeGreaterThan(0); expect(r.pct).toBeCloseTo((r.intake / r.reference) * 100, 6) }
    expect(report.basis).toMatch(/nicht gegen die Originalquelle verifiziert/)
  })
  it('Zufuhr stimmt mit einer unabhängigen Handrechnung überein (Kalium, 1 Tag, 1 Rezept)', () => {
    const foods = BUILTIN_FOODS, r = BUILTIN_RECIPES.find(x => x.id === 'r-apfelmandel')!   // Apfel 150 g + Mandeln 20 g
    const prefs = defaultPrefs()
    const ctx = buildContext(foods, [r], prefs)
    const plan = { id: 'p', createdAt: '', startDate: '2026-11-16', days: [{ date: '2026-11-16', meals: [{ id: 'm', slot: 'snack' as const, recipeId: r.id, factor: 2 }] }], oils: { warm: null, cold: null }, kcalTarget: 2000, persons: 1 }
    const k = (id: string) => foods.find(f => f.id === id)!.micros!.kalium!
    const expected = (k('apfel') * 150 * 2) / 100 + (k('mandeln') * 20 * 2) / 100
    expect(row(analyzeGaps(plan, ctx, { sex: 'd', weightKg: 70 }, prefs), 'kalium').intake).toBeCloseTo(expected, 6)
  })
  it('fehlende Daten ≠ 0: Lebensmittel ohne Mikronährstoffdaten ergeben „Datenlage unzureichend“, keine behauptete Lücke', () => {
    const stripped = BUILTIN_FOODS.map(f => ({ ...f, micros: undefined }))
    const { report } = setup(['mischkost'], {}, stripped)
    for (const k of MICRO_KEYS) { expect(row(report, k).status, k).toBe('unknown'); expect(row(report, k).hardToReach).toBe(false) }
    expect(report.caveats.join(' ')).toMatch(/Datenlage unzureichend/)
  })
  it('Datenabdeckung wird je Nährstoff ausgewiesen und steuert den Status (≥ 70 % nötig)', () => {
    const { report } = setup()
    for (const r of report.rows) expect(r.coverage).toBeGreaterThanOrEqual(0)
    for (const r of report.rows) if (r.coverage < COVERAGE_MIN) expect(r.status).toBe('unknown')
  })
  it('Vegan: Vitamin B12 deutlich unter dem Orientierungswert; allgemeiner Hinweis zu B12 ohne Heilversprechen', () => {
    const { report } = setup(['vegan'])
    expect(row(report, 'vitaminB12').status).toBe('low')
    expect(report.dietNotes[0].notes.join(' ')).toMatch(/B12/)
    expect(report.dietNotes.flatMap(d => d.notes).join(' ').toLowerCase()).not.toMatch(/heilt|garantiert|verhindert|behandelt/)
  })
  it('Carnivore: praktisch keine Ballaststoffe, Hinweis zu begrenzter Datenlage; Keto: Ballaststoffe unter Richtwert', () => {
    const c = setup(['carnivore']).report
    expect(row(c, 'fiber').intake).toBeLessThan(1); expect(row(c, 'fiber').status).toBe('low'); expect(row(c, 'fiber').hardToReach).toBe(true)
    expect(c.dietNotes[0].notes.join(' ')).toMatch(/Langzeitdaten/)
    expect(row(setup(['keto']).report, 'fiber').intake).toBeLessThan(FIBER_REF)
  })
  it('Referenzwerte hängen vom Geschlecht ab (Eisen, Magnesium), „divers“ = Mittelwert', () => {
    const f = setup(['mischkost'], { sex: 'f' }).report, m = setup(['mischkost'], { sex: 'm' }).report, d = setup(['mischkost'], { sex: 'd' }).report
    expect(row(f, 'eisen').reference).toBe(MICRO_REFERENCE.eisen.f); expect(row(m, 'eisen').reference).toBe(MICRO_REFERENCE.eisen.m)
    expect(row(d, 'eisen').reference).toBe((MICRO_REFERENCE.eisen.f + MICRO_REFERENCE.eisen.m) / 2)
  })
  it('Eiweißreferenz skaliert mit dem Körpergewicht', () => {
    expect(row(setup(['mischkost'], { weightKg: 100 }).report, 'protein').reference).toBeCloseTo(80, 6)
  })
  it('keine Ausgabe stellt Diagnosen oder Wirkversprechen', () => {
    const { report } = setup(['vegan', 'highprotein'])
    const txt = [...report.caveats, ...report.rows.map(r => r.note ?? '')].join(' ').toLowerCase()
    for (const bad of ['diagnose:', 'leiden an', 'mangel besteht', 'krank', 'heilt']) expect(txt).not.toContain(bad)
  })
})
