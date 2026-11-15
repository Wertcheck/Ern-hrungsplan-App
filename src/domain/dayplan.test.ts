import { describe, expect, it } from 'vitest'
import { BUILTIN_FOODS } from '../data/foods'
import { BUILTIN_RECIPES } from '../data/recipes'
import { defaultPrefs, defaultProfile } from './defaults'
import { analyzePlan, buildContext, dayTotals, effectiveMacroShare, generatePlan, regenerateDays, targetFor } from './planner'
import { macroShares } from './nutrition'
import type { Plan, Preferences, Profile } from './types'

const profile = (o: Partial<Profile> = {}): Profile => ({ ...defaultProfile(), kcalMode: 'manual', kcalManual: 2200, mealCount: 3, ...o })
const prefs = (o: Partial<Preferences> = {}): Preferences => ({ ...defaultPrefs(), ...o })
const gen = (p: Profile, pr: Preferences = prefs(), days = 7, extra: object = {}) => generatePlan({ profile: p, foods: BUILTIN_FOODS, recipes: BUILTIN_RECIPES, prefs: pr, startDate: '2026-11-16', days, seed: 3, ...extra })
const ctx = (pr: Preferences = prefs()) => buildContext(BUILTIN_FOODS, BUILTIN_RECIPES, pr)
const dev = (pl: Plan, c: ReturnType<typeof ctx>, i: number) => Math.abs(dayTotals(pl.days[i], c).kcal - targetFor(pl, pl.days[i].date)) / targetFor(pl, pl.days[i].date) * 100

describe('Tagesziele (einmalig) und Einzeltag-Neuberechnung', () => {
  it('targetFor: einmaliges Tagesziel überschreibt nur dieses Datum', () => {
    const pl = { kcalTarget: 2200, dayTargets: { '2026-11-18': 3300 } }
    expect(targetFor(pl, '2026-11-18')).toBe(3300); expect(targetFor(pl, '2026-11-17')).toBe(2200)
  })
  it('regenerateDays ersetzt nur den gewählten Tag; Planziel/Profil/andere Tage bleiben unverändert', () => {
    const p = profile(), pl = gen(p), c = ctx(), date = pl.days[2].date
    const r = regenerateDays(pl, c, 3, [date], { overrideTargets: { [date]: 3000 } })
    expect(r.plan.kcalTarget).toBe(2200); expect(r.plan.dayTargets).toEqual({ [date]: 3000 })
    pl.days.forEach((d, i) => { if (i !== 2) expect(JSON.stringify(r.plan.days[i])).toBe(JSON.stringify(d)) })
    expect(JSON.stringify(r.plan.days[2].meals)).not.toBe(JSON.stringify(pl.days[2].meals))
    expect(p.kcalManual).toBe(2200)
    expect(pl.dayTargets).toBeUndefined()                           // Eingabe wird nicht mutiert
  })
  it('3.000 kcal mit 3 Mahlzeiten: Tag wird auf ±3 % erreicht (ggf. mit zusätzlicher Zwischenmahlzeit, transparent gemeldet)', () => {
    const pl = gen(profile()), c = ctx(), date = pl.days[1].date
    const r = regenerateDays(pl, c, 3, [date], { overrideTargets: { [date]: 3000 } })
    expect(dev(r.plan, c, 1)).toBeLessThan(3)
    if (r.mealCounts[date] > 3) expect(r.notes.join(' ')).toMatch(/zusätzliche Zwischenmahlzeit/)
  })
  it('4.000 kcal: entweder auf ±5 % erreicht oder die Abweichung wird ausdrücklich gemeldet (nie verschwiegen)', () => {
    const pl = gen(profile()), c = ctx(), date = pl.days[0].date
    const r = regenerateDays(pl, c, 3, [date], { overrideTargets: { [date]: 4000 } })
    expect(r.mealCounts[date]).toBeGreaterThan(3)                  // 3 Mahlzeiten reichen nicht → Ergänzung
    const d = dev(r.plan, c, 0)
    if (d > 5) expect(r.notes.join(' ')).toMatch(/nur auf \d+ % genau/)
    expect(analyzePlan(r.plan, c, 3).days[0].devPct).toBeCloseTo(((dayTotals(r.plan.days[0], c).kcal - 4000) / 4000) * 100, 6)   // Analyse nutzt das Tagesziel
  })
  it('niedriges Tagesziel (1.400 kcal) wird ebenfalls erreicht, ohne Zusatzmahlzeiten', () => {
    const pl = gen(profile({ mealCount: 4 })), c = ctx(), date = pl.days[3].date
    const r = regenerateDays(pl, c, 4, [date], { overrideTargets: { [date]: 1400 } })
    expect(dev(r.plan, c, 3)).toBeLessThan(3); expect(r.mealCounts[date]).toBe(4)
  })
  it('Regeln bleiben verbindlich: Allergie/Ausschluss/Ernährungsweise gelten auch für neu berechnete Tage', () => {
    const pr = prefs({ styles: ['vegan'], restrictions: [{ allergen: 'nuesse', severity: 'allergy' }] }), c = ctx(pr)
    const pl = gen(profile({ mealCount: 4 }), pr), date = pl.days[0].date
    const r = regenerateDays(pl, c, 4, [date], { overrideTargets: { [date]: 3200 } })
    for (const m of r.plan.days[0].meals) expect(c.rejected.has(m.recipeId)).toBe(false)
  })
  it('mehrere Tage/Woche: Vielfalt über die Neuberechnung hinweg (kein Rezept zweimal am selben Tag)', () => {
    const pl = gen(profile({ mealCount: 4 }), prefs(), 14), c = ctx()
    const r = regenerateDays(pl, c, 4, pl.days.slice(0, 7).map(d => d.date))
    for (const d of r.plan.days) expect(new Set(d.meals.map(m => m.recipeId)).size).toBe(d.meals.length)
    expect(JSON.stringify(r.plan.days.slice(7))).toBe(JSON.stringify(pl.days.slice(7)))
  })
  it('generatePlan mit dayTargets setzt einzelne Tage, übrige Tage folgen dem Planziel', () => {
    const pl = gen(profile({ mealCount: 4 }), prefs(), 7, { dayTargets: { '2026-11-18': 3000 } }), c = ctx()
    expect(pl.dayTargets).toEqual({ '2026-11-18': 3000 }); expect(dev(pl, c, 2)).toBeLessThan(3); expect(dev(pl, c, 0)).toBeLessThan(3)
  })
})

describe('Eigene Makroziele', () => {
  it('Berechnung: Eiweiß 180 g bei 3.000 kcal = 24 %; Rest verteilt sich proportional zur Ernährungsweise; Summe 100', () => {
    const s = effectiveMacroShare({ proteinG: 180 }, ['mischkost'], 3000)!
    expect(s.protein).toBeCloseTo(24, 6); expect(s.protein + s.carbs + s.fat).toBeCloseTo(100, 6); expect(s.carbs / s.fat).toBeCloseTo(50 / 30, 6)
    const all = effectiveMacroShare({ proteinG: 150, carbsG: 300, fatG: 80 }, ['keto'], 2400)!
    expect(all.protein + all.carbs + all.fat).toBeCloseTo(100, 6)
    expect(effectiveMacroShare(undefined, ['mischkost'], 2000)).toBeUndefined(); expect(effectiveMacroShare({}, ['mischkost'], 2000)).toBeUndefined()
  })
  it('hohes Eiweißziel verschiebt den geplanten Eiweißanteil spürbar nach oben und wird im Plan gespeichert', () => {
    const c = ctx(), share = (pl: Plan) => { const t = pl.days.reduce((a, d) => { const m = dayTotals(d, c); return { kcal: a.kcal + m.kcal, protein: a.protein + m.protein, carbs: a.carbs + m.carbs, fat: a.fat + m.fat, fiber: 0 } }, { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 }); return macroShares(t).protein }
    const base = gen(profile({ mealCount: 4 })), high = gen(profile({ mealCount: 4, macroGoals: { proteinG: 220 } }))
    expect(high.macroShare!.protein).toBeCloseTo(40, 6); expect(base.macroShare).toBeUndefined()
    expect(share(high)).toBeGreaterThan(share(base) + 4)
  })
})
