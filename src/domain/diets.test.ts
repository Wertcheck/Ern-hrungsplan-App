import { describe, expect, it } from 'vitest'
import { BUILTIN_FOODS } from '../data/foods'
import { BUILTIN_RECIPES } from '../data/recipes'
import { defaultPrefs, defaultProfile } from './defaults'
import { allDiets, analyzeCombination, getDiet, macroTargetFor, registerDiet, relationOf, unregisterDiet } from './diets'
import { FACTOR_MAX, FACTOR_MIN, analyzePlan, buildContext, dayTotals, generatePlan, solvePortions, type PlanContext } from './planner'
import { MEAL_CAP_G } from './plausibility'
import { analyzePrefs, foodViolation, recipeViolation, styleFit } from './rules'
import { macroShares, resolveIngredients, type Macros } from './nutrition'
import { STYLE_LABEL, type CustomRule, type Plan, type Preferences, type Style } from './types'

const foods = new Map(BUILTIN_FOODS.map(f => [f.id, f]))
const prefs = (o: Partial<Preferences> = {}): Preferences => ({ ...defaultPrefs(), ...o })
const gen = (p: Preferences, meals: 3 | 4 | 5 = 4, kcal = 2200, days = 14, seed = 1) =>
  generatePlan({ profile: { ...defaultProfile(), kcalMode: 'manual', kcalManual: kcal, mealCount: meals }, foods: BUILTIN_FOODS, recipes: BUILTIN_RECIPES, prefs: p, startDate: '2026-11-16', days, seed })
const ctxOf = (p: Preferences) => buildContext(BUILTIN_FOODS, BUILTIN_RECIPES, p)
const ingredientsOf = (plan: Plan, ctx: PlanContext) =>
  plan.days.flatMap(d => d.meals.flatMap(m => resolveIngredients(ctx.recipes.get(m.recipeId)!.ingredients, plan.oils).map(i => ({ f: foods.get(i.foodId)!, g: i.grams * m.factor, m }))))
const total = (plan: Plan, ctx: PlanContext): Macros => plan.days.reduce((a, d) => { const m = dayTotals(d, ctx); return { kcal: a.kcal + m.kcal, protein: a.protein + m.protein, carbs: a.carbs + m.carbs, fat: a.fat + m.fat, fiber: a.fiber + m.fiber } }, { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 })

const ALL: Style[] = ['carnivore', 'vegan', 'vegetarisch', 'pescetarisch', 'flexitarisch', 'keto', 'lowcarb', 'highprotein', 'paleo', 'mediterran', 'basisch', 'mischkost']

describe('Registry', () => {
  it('alle 12 geforderten Ernährungsweisen sind registriert, ohne bevorzugte Weise, jede mit transparenter Definition', () => {
    for (const s of ALL) {
      const d = getDiet(s)!
      expect(d, s).toBeDefined(); expect(d.label).toBe(STYLE_LABEL[s]); expect(d.definition.length).toBeGreaterThan(0)
      expect(d.definition.join(' ')).toMatch(/nicht medizinisch|keine Wirkung|Orientierung|Regeln|erlaubt|Ausgeschlossen|Bevorzugt/i)
    }
    expect(allDiets().length).toBeGreaterThanOrEqual(12)
    expect(defaultPrefs().styles).toEqual(['mischkost'])   // neutral, keine Weise voreingestellt
  })
  it('keine Beschreibung behauptet medizinische Überlegenheit oder Heilwirkung', () => {
    const txt = allDiets().flatMap(d => [d.summary, ...d.definition, ...(d.gapNotes ?? [])]).join(' ').toLowerCase()
    for (const bad of ['heilt', 'heilung', 'gesünder als', 'beste ernährung', 'überlegen', 'entgiftet', 'ph-wert des blutes', 'krebs']) expect(txt, bad).not.toContain(bad)
  })
  it('Basisch: ausdrücklich keine pH-Wirkung behauptet', () => { expect(getDiet('basisch')!.definition.join(' ')).toMatch(/keine Wirkung auf den Blut-pH-Wert/) })
  it('neue Weise ohne Architekturänderung ergänzbar (registerDiet) und wirkt sofort im Planer', () => {
    registerDiet({ id: 'testdiet', label: 'Test', summary: 't', definition: ['Test'], foodRule: f => (f.group === 'fisch' || f.group === 'schalentiere' ? 'kein Fisch' : null) })
    try {
      const p = prefs({ styles: ['testdiet' as Style] })
      const plan = gen(p, 4, 2000, 7), ctx = ctxOf(p)
      expect(ingredientsOf(plan, ctx).some(x => x.f.group === 'fisch' || x.f.group === 'schalentiere')).toBe(false)
      expect(ctx.rejected.size).toBeGreaterThan(0)
    } finally { unregisterDiet('testdiet') }
  })
})

describe('Jede Ernährungsweise: Plan, Regeln und Genauigkeit', () => {
  for (const style of ALL) {
    it(`${STYLE_LABEL[style]}: vollständige Tage in allen Mahlzeitenarten, Kalorienziel ±3 %, keine Regelverstöße`, () => {
      const p = prefs({ styles: [style] }), ctx = ctxOf(p)
      for (const slot of ['fruehstueck', 'mittag', 'abend', 'snack'] as const) expect(ctx.eligible.filter(r => r.slots.includes(slot)).length, `${style}/${slot}`).toBeGreaterThanOrEqual(3)
      for (const meals of [3, 5] as const) {
        const plan = gen(p, meals)
        expect(plan.days.every(d => d.meals.length === meals)).toBe(true)
        const a = analyzePlan(plan, ctx, meals)
        expect(Math.max(...a.days.map(d => Math.abs(d.devPct))), `${style}/${meals}`).toBeLessThan(3)
        expect(a.issues.filter(i => i.level === 'error')).toEqual([])
        for (const d of plan.days) for (const m of d.meals) expect(recipeViolation(ctx.recipes.get(m.recipeId)!, foods, p, plan.oils)).toBeNull()
      }
    })
  }
  it('Carnivore: ausschließlich tierische Zutaten (oder kalorienfreie Getränke), Fett nur Butter/Ghee, praktisch keine Kohlenhydrate', () => {
    const p = prefs({ styles: ['carnivore'] }), ctx = ctxOf(p), plan = gen(p)
    expect(['butter', 'ghee']).toContain(plan.oils.warm)
    for (const { f } of ingredientsOf(plan, ctx)) expect(['meat', 'fish', 'egg', 'dairy'].includes(f.animal) || (f.group === 'getraenk' && f.kcal <= 5), f.id).toBe(true)
    expect(macroShares(total(plan, ctx)).carbs).toBeLessThan(2)
  })
  it('Vegan: keine tierischen Zutaten, auch nicht im Kochfett (Butter/Ghee)', () => {
    const p = prefs({ styles: ['vegan'], oils: { ...defaultPrefs().oils, preferred: ['butter', 'ghee'], main: 'butter' } }), ctx = ctxOf(p), plan = gen(p)
    expect(ingredientsOf(plan, ctx).every(x => x.f.animal === 'none')).toBe(true)
  })
  it('Vegetarisch kein Fleisch/Fisch; Pescetarisch kein Fleisch, aber Fisch kommt vor', () => {
    const v = prefs({ styles: ['vegetarisch'] }), pe = prefs({ styles: ['pescetarisch'] })
    expect(ingredientsOf(gen(v), ctxOf(v)).some(x => x.f.animal === 'meat' || x.f.animal === 'fish')).toBe(false)
    const ctx = ctxOf(pe), plan = gen(pe)
    expect(ingredientsOf(plan, ctx).some(x => x.f.animal === 'meat')).toBe(false)
    expect(ingredientsOf(plan, ctx).some(x => x.f.animal === 'fish')).toBe(true)
  })
  it('Paleo: kein Getreide, keine Hülsenfrüchte, kein Zucker, keine Milchprodukte (außer Ghee), kein Soja', () => {
    const p = prefs({ styles: ['paleo'] }), ctx = ctxOf(p)
    for (const { f } of ingredientsOf(gen(p), ctx)) {
      expect(['getreide', 'huelsenfrucht', 'zucker']).not.toContain(f.group)
      expect(f.animal === 'dairy' && f.id !== 'ghee').toBe(false); expect(f.allergens).not.toContain('soja')
    }
  })
  it('Keto: Netto-Kohlenhydrate je Rezept ≤ 12 % und im Tagesschnitt ≤ 10 % der Energie; Fett dominiert', () => {
    const p = prefs({ styles: ['keto'] }), ctx = ctxOf(p), plan = gen(p)
    for (const r of ctx.eligible) expect(((ctx.base.get(r.id)!.carbs) * 400) / ctx.base.get(r.id)!.kcal, r.id).toBeLessThanOrEqual(12.01)
    const sh = macroShares(total(plan, ctx))
    expect(sh.carbs).toBeLessThanOrEqual(10); expect(sh.fat).toBeGreaterThan(55)
    expect(macroTargetFor(['keto'])).toEqual({ protein: 20, carbs: 5, fat: 75 })
  })
  it('Low Carb senkt, High Protein erhöht den jeweiligen Anteil gegenüber Mischkost', () => {
    const base = macroShares(total(gen(prefs()), ctxOf(prefs())))
    const lc = prefs({ styles: ['lowcarb'] }), hp = prefs({ styles: ['highprotein'] })
    expect(macroShares(total(gen(lc), ctxOf(lc))).carbs).toBeLessThan(base.carbs - 8)
    expect(macroShares(total(gen(hp), ctxOf(hp))).protein).toBeGreaterThan(base.protein + 4)
  })
  it('Flexitarisch: deutlich weniger Fleischmahlzeiten als Mischkost', () => {
    const count = (p: Preferences) => { const ctx = ctxOf(p), plan = gen(p, 4, 2200, 28); return plan.days.flatMap(d => d.meals).filter(m => ctx.recipes.get(m.recipeId)!.ingredients.some(i => foods.get(i.foodId)?.animal === 'meat')).length }
    const mixed = count(prefs()), flex = count(prefs({ styles: ['flexitarisch'] }))
    expect(flex).toBeLessThan(mixed * 0.6)
  })
  it('Mediterran/Basisch: Passung der Rezepte höher als bei Mischkost', () => {
    for (const st of ['mediterran', 'basisch'] as Style[]) {
      const p = prefs({ styles: [st] }), base = prefs(), ctx = ctxOf(p), cb = ctxOf(base)
      const avg = (plan: Plan, c: PlanContext) => plan.days.flatMap(d => d.meals).reduce((s, m) => s + styleFit(c.recipes.get(m.recipeId)!, st, foods, plan.oils), 0) / plan.days.flatMap(d => d.meals).length
      expect(avg(gen(p), ctx)).toBeGreaterThan(avg(gen(base), cb) + 0.1)
    }
  })
})

describe('Kombinationen und Widersprüche', () => {
  it('Carnivore + Vegan: harter Konflikt erkannt; Plan wird nicht „perfekt“ vorgetäuscht', () => {
    const p = prefs({ styles: ['carnivore', 'vegan'] })
    expect(analyzeCombination(p.styles).conflicts.length).toBe(1)
    const ctx = ctxOf(p)
    expect(ctx.eligible).toHaveLength(0)
    const plan = gen(p, 4, 2000, 7)
    expect(plan.days.every(d => d.meals.length === 0)).toBe(true)
    expect(analyzePlan(plan, ctx).issues.some(i => i.level === 'error')).toBe(true)
  })
  it('kompatible Kombinationen (Keto+Carnivore, Paleo+Pescetarisch, Vegan+Highprotein) liefern Pläne, die ALLE Regeln erfüllen', () => {
    for (const styles of [['keto', 'carnivore'], ['paleo', 'pescetarisch'], ['vegan', 'highprotein'], ['lowcarb', 'mediterran']] as Style[][]) {
      const p = prefs({ styles }), ctx = ctxOf(p), plan = gen(p, 5)
      expect(plan.days.every(d => d.meals.length === 5), styles.join()).toBe(true)
      for (const d of plan.days) for (const m of d.meals) expect(recipeViolation(ctx.recipes.get(m.recipeId)!, foods, p, plan.oils), styles.join()).toBeNull()
    }
    const kc = ctxOf(prefs({ styles: ['keto', 'carnivore'] }))
    expect(macroTargetFor(['keto', 'carnivore'])).toEqual({ protein: 20, carbs: 5, fat: 75 })   // Priorität: keto vor carnivore
    expect(kc.eligible.length).toBeGreaterThan(10)
  })
  it('Spannungen und Redundanzen werden unterschieden, Mischkost ist neutral', () => {
    expect(analyzeCombination(['vegan', 'vegetarisch']).infos.length).toBe(1)
    expect(analyzeCombination(['vegan', 'paleo']).tensions.length).toBe(1)
    expect(analyzeCombination(['mischkost', 'carnivore', 'keto']).conflicts).toEqual([])
    expect(relationOf('vegan', 'carnivore')?.level).toBe('conflict'); expect(relationOf('keto', 'carnivore')).toBeUndefined()
    const a = analyzePrefs(prefs({ styles: ['carnivore', 'basisch'], restrictions: [{ allergen: 'histamin', severity: 'allergy' }] }))
    expect(a.tensions.length).toBe(1); expect(a.other.join()).toMatch(/Unverträglichkeit/)
  })
  it('Carnivore + Milcheiweiß-Allergie: kein Absturz, Einschränkung wird transparent gemeldet', () => {
    const p = prefs({ styles: ['carnivore'], restrictions: [{ allergen: 'milch', severity: 'allergy' }] }), ctx = ctxOf(p)
    for (const r of ctx.eligible) expect(recipeViolation(r, foods, p, ctx.oils)).toBeNull()
    const plan = gen(p, 3, 2000, 7), a = analyzePlan(plan, ctx, 3)
    expect(plan.oils.warm).toBeNull()                    // kein erlaubtes Kochfett (Butter/Ghee enthalten Milch)
    expect(a.issues.some(i => /Öl/.test(i.text))).toBe(true)
    expect(ingredientsOf(plan, ctx).some(x => x.f.allergens.includes('milch'))).toBe(false)
  })
  it('Carnivore + Laktoseintoleranz: Ghee ersetzt Butter und bleibt erlaubt', () => {
    const p = prefs({ styles: ['carnivore'], restrictions: [{ allergen: 'laktose', severity: 'intolerance' }] })
    expect(gen(p).oils.warm).toBe('ghee')
  })
})

describe('Eigene Regeln', () => {
  const rule = (kind: CustomRule['kind'], value: string | number, enabled = true): CustomRule => ({ id: 'r', name: 'Meine Regel', kind, value, enabled })
  it('Gruppe, Kategorie und Begriff ausschließen', () => {
    for (const r of [rule('exclude_group', 'fisch'), rule('exclude_category', 'fisch'), rule('exclude_term', 'Lachs')]) {
      const p = prefs({ customRules: [r] }), ctx = ctxOf(p)
      expect(foodViolation(foods.get('lachs')!, p)).toMatch(/Meine Regel/)
      expect(ingredientsOf(gen(p, 4, 2000, 7), ctx).some(x => x.f.id === 'lachs')).toBe(false)
    }
  })
  it('Rezeptregeln: max. Kohlenhydrate, min. Eiweiß – gelten für jedes zulässige Rezept', () => {
    const p = prefs({ customRules: [rule('max_carb_pct', 20), rule('min_protein_pct', 25)] }), ctx = ctxOf(p)
    expect(ctx.eligible.length).toBeGreaterThan(5)
    for (const r of ctx.eligible) { const s = macroShares(ctx.base.get(r.id)!); expect(s.carbs).toBeLessThanOrEqual(20); expect(s.protein).toBeGreaterThanOrEqual(25) }
  })
  it('deaktivierte Regeln wirken nicht; widersprüchliche Regeln führen zu Fehlermeldung statt Plan', () => {
    expect(foodViolation(foods.get('lachs')!, prefs({ customRules: [rule('exclude_group', 'fisch', false)] }))).toBeNull()
    const p = prefs({ customRules: [rule('max_carb_pct', 5), rule('min_protein_pct', 95)] })
    expect(ctxOf(p).eligible).toHaveLength(0)
    expect(analyzePrefs(p).other.join()).toMatch(/unrealistisch/)
  })
})

describe('Planer: Genauigkeit, Portionen, Determinismus', () => {
  it('Kalorienziele von 1200 bis 3000 kcal (4–5 Mahlzeiten) und bis 2600 kcal (3 Mahlzeiten) auf ±3 % erreicht', () => {
    const ctx = ctxOf(prefs())
    for (const [meals, max] of [[3, 2600], [4, 3000], [5, 3000]] as const) for (let k = 1200; k <= max; k += 200) {
      const plan = gen(prefs(), meals, k, 7)
      for (const d of plan.days) expect(Math.abs(dayTotals(d, ctx).kcal - k) / k, `${meals}/${k}`).toBeLessThan(0.03)
    }
  })
  it('keine unplausiblen Portionen: Faktoren in [0,5; 2,0], Zutatenmengen unter den Mahlzeit-Höchstwerten', () => {
    for (const style of ['mischkost', 'carnivore', 'keto', 'vegan'] as Style[]) for (const k of [1400, 3000]) {
      const p = prefs({ styles: [style] }), ctx = ctxOf(p), plan = gen(p, 5, k, 7)
      for (const x of ingredientsOf(plan, ctx)) {
        expect(x.m.factor).toBeGreaterThanOrEqual(FACTOR_MIN - 1e-9); expect(x.m.factor).toBeLessThanOrEqual(FACTOR_MAX + 1e-9)
        const cap = x.f.category === 'getraenke' ? undefined : MEAL_CAP_G[x.f.group]; if (cap) expect(x.g, `${style}/${k}/${x.f.id}`).toBeLessThanOrEqual(cap + 0.5)
      }
    }
  })
  it('deterministisch bei gleichem Seed, abweichend bei anderem Seed', () => {
    const ids = (pl: Plan) => pl.days.flatMap(d => d.meals.map(m => m.recipeId + m.factor)).join()
    expect(ids(gen(prefs(), 4, 2200, 14, 5))).toBe(ids(gen(prefs(), 4, 2200, 14, 5)))
    expect(ids(gen(prefs(), 4, 2200, 14, 5))).not.toBe(ids(gen(prefs(), 4, 2200, 14, 77)))
  })
  it('Vielfalt: in 14 Tagen kommt dasselbe Hauptgericht nicht am selben Tag doppelt vor; 30-Tage-Plan bleibt schnell', () => {
    const t = performance.now()
    const plan = gen(prefs(), 5, 2200, 30)
    expect(performance.now() - t).toBeLessThan(5000)
    for (const d of plan.days) expect(new Set(d.meals.map(m => m.recipeId)).size).toBe(d.meals.length)
  })
})

describe('solvePortions (Lagrange mit Schranken)', () => {
  it('trifft die Zielsumme exakt, wenn erreichbar, und minimiert Abweichungen von 1', () => {
    const f = solvePortions([500, 600, 400], [0.5, 0.5, 0.5], [2, 2, 2], 1800)
    expect(f.reduce((s, x, i) => s + x * [500, 600, 400][i], 0)).toBeCloseTo(1800, 6)
    expect(f[0]).toBeCloseTo(f[1], 0.0) // gleicher Zuschlag je Mahlzeit (proportional zur Basis)
  })
  it('Schranken werden eingehalten; unerreichbare Ziele sättigen an den Grenzen', () => {
    const lo = [0.5, 0.5], hi = [1.2, 2]
    const sat = solvePortions([400, 400], lo, hi, 9999)
    expect(sat).toEqual([1.2, 2])
    const low = solvePortions([400, 400], lo, hi, 1)
    expect(low).toEqual([0.5, 0.5])
    const mixed = solvePortions([500, 500, 500], [0.5, 0.5, 0.5], [1.1, 2, 2], 2400)
    expect(mixed[0]).toBeLessThanOrEqual(1.1 + 1e-9)
    expect(mixed.reduce((s, x) => s + x * 500, 0)).toBeCloseTo(2400, 6)
  })
})
