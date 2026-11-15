import { describe, expect, it } from 'vitest'
import { BUILTIN_FOODS } from '../data/foods'
import { BUILTIN_RECIPES } from '../data/recipes'
import { defaultPrefs, defaultProfile } from './defaults'
import { bmr, estimateKcal, foodMacros, kcalTarget, macroShares, mealMacros, recipeMacros, resolveIngredients } from './nutrition'
import { allergenStatus, chooseOils, detectConflicts, foodViolation, recipeViolation } from './rules'
import { PERIODS, alternativesFor, analyzePlan, buildContext, dayTotals, generatePlan } from './planner'
import { buildShoppingList } from './shopping'
import { addMeal, removeMeal, setFactor, swapMeal } from './planops'
import { foodInputSchema, profileSchema, recipeInputSchema } from './schemas'
import type { Food, Preferences, Profile, Recipe } from './types'

const foods = new Map(BUILTIN_FOODS.map(f => [f.id, f]))
const prefs = (over: Partial<Preferences> = {}): Preferences => ({ ...defaultPrefs(), ...over })
const gen = (profile: Partial<Profile> = {}, p: Partial<Preferences> = {}, days = 7, seed = 1) =>
  generatePlan({ profile: { ...defaultProfile(), ...profile }, foods: BUILTIN_FOODS, recipes: BUILTIN_RECIPES, prefs: prefs(p), startDate: '2026-11-16', days, seed })
const ctxFor = (p: Partial<Preferences> = {}) => buildContext(BUILTIN_FOODS, BUILTIN_RECIPES, prefs(p))

describe('Datenintegrität', () => {
  it('alle Rezeptzutaten verweisen auf existierende Lebensmittel', () => {
    for (const r of BUILTIN_RECIPES) for (const i of r.ingredients) {
      if (i.foodId.startsWith('oil:')) continue
      expect(foods.has(i.foodId), `${r.id}: ${i.foodId}`).toBe(true)
    }
  })
  it('IDs sind eindeutig', () => {
    expect(new Set(BUILTIN_FOODS.map(f => f.id)).size).toBe(BUILTIN_FOODS.length)
    expect(new Set(BUILTIN_RECIPES.map(r => r.id)).size).toBe(BUILTIN_RECIPES.length)
  })
  it('Kalorien sind plausibel zu den Makros (Atwater mit verfügbaren Kohlenhydraten + Ballaststoffe 2 kcal/g; ±25 %/40 kcal)', () => {
    for (const f of BUILTIN_FOODS) {
      const est = f.protein * 4 + f.carbs * 4 + f.fiber * 2 + f.fat * 9
      expect(Math.abs(est - f.kcal), f.id).toBeLessThanOrEqual(Math.max(40, f.kcal * 0.25))
    }
  })
  it('„verifiziert“ nur mit BLS-Quellenangabe; alle übrigen sind als Richtwert gekennzeichnet', () => {
    for (const f of BUILTIN_FOODS) {
      if (f.dataQuality === 'verified') { expect(f.sourceRef?.name).toMatch(/BLS/); expect(f.sourceRef?.id).toMatch(/^[A-Z][0-9A-Z]{6}$/) }
      else expect(['reference', 'missing']).toContain(f.dataQuality)
    }
    expect(BUILTIN_FOODS.filter(f => f.dataQuality === 'verified').length).toBeGreaterThan(90)
  })
})

describe('Kalorien- und Makroberechnung', () => {
  it('foodMacros skaliert linear', () => {
    // BLS 4.0, C133000 „Hafer Flocken“: 348 kcal, 13,22 g Protein je 100 g (im Original geprüft)
    const m = foodMacros(foods.get('haferflocken')!, 50)
    expect(m.kcal).toBeCloseTo(174, 6)
    expect(m.protein).toBeCloseTo(6.61, 6) // 13,22 g/100 g
  })
  it('Mifflin-St Jeor: Mann 30 J., 180 cm, 80 kg → 1780 kcal', () => {
    expect(bmr('m', 30, 180, 80)).toBe(1780)
  })
  it('Zielkalorien: Defizit/Überschuss 10 %, Untergrenze 1200', () => {
    const base = { sex: 'm' as const, age: 30, heightCm: 180, weightKg: 80, activity: 'moderat' as const }
    const keep = estimateKcal({ ...base, goal: 'halten' }).target
    expect(keep).toBe(Math.round((1780 * 1.55) / 10) * 10)
    expect(estimateKcal({ ...base, goal: 'reduzieren' }).target).toBe(Math.round((1780 * 1.55 * 0.9) / 10) * 10)
    expect(estimateKcal({ ...base, goal: 'aufbauen' }).target).toBeGreaterThan(keep)
    const tiny = estimateKcal({ sex: 'f', age: 90, heightCm: 140, weightKg: 35, activity: 'sitzend', goal: 'reduzieren' })
    expect(tiny.target).toBe(1200)
    expect(tiny.notes.length).toBeGreaterThan(2)
  })
  it('kcalTarget nutzt manuellen Wert im Manuell-Modus', () => {
    expect(kcalTarget({ ...defaultProfile(), kcalMode: 'manual', kcalManual: 1850 })).toBe(1850)
  })
  it('Makroanteile summieren sich auf 100 %', () => {
    const s = macroShares({ kcal: 500, protein: 30, carbs: 50, fat: 20, fiber: 0 })
    expect(s.protein + s.carbs + s.fat).toBeCloseTo(100, 5)
  })
  it('Öl wird vollständig in die Kalorien einbezogen und über den Platzhalter aufgelöst', () => {
    const r = BUILTIN_RECIPES.find(x => x.id === 'r-ruehrei')!
    const withOil = recipeMacros(r, foods, { warm: 'olivenoel', cold: null })
    const noOil = recipeMacros(r, foods, { warm: null, cold: null })
    // BLS 4.0, Q120000 „Olivenöl“: 899 kcal, 99,9 g Fett je 100 g → 5 g
    expect(withOil.kcal - noOil.kcal).toBeCloseTo(44.95, 6)
    expect(withOil.fat - noOil.fat).toBeCloseTo(4.995, 6)
    const butter = recipeMacros(r, foods, { warm: 'butter', cold: null })
    // BLS 4.0, Q611000 „Butter mild gesäuert“: 747 kcal je 100 g → 5 g
    expect(butter.kcal - noOil.kcal).toBeCloseTo(37.35, 6)
  })
  it('Portionsgröße: alle Nährwerte skalieren exakt mit dem Faktor', () => {
    const r = BUILTIN_RECIPES[0]
    const oils = { warm: 'olivenoel', cold: 'olivenoel' }
    const one = recipeMacros(r, foods, oils, 1), two = recipeMacros(r, foods, oils, 2), half = recipeMacros(r, foods, oils, 0.5)
    for (const k of ['kcal', 'protein', 'carbs', 'fat', 'fiber'] as const) {
      expect(two[k]).toBeCloseTo(one[k] * 2, 8)
      expect(half[k]).toBeCloseTo(one[k] / 2, 8)
    }
  })
  it('resolveIngredients ohne Öl entfernt Platzhalter', () => {
    expect(resolveIngredients([{ foodId: 'oil:warm', grams: 5 }, { foodId: 'ei', grams: 55 }], { warm: null, cold: null })).toEqual([{ foodId: 'ei', grams: 55 }])
  })
})

describe('Allergien und Ausschlussregeln', () => {
  it('Allergie und Unverträglichkeit schließen Lebensmittel mit Allergen aus', () => {
    const p = prefs({ restrictions: [{ allergen: 'nuesse', severity: 'allergy' }] })
    expect(foodViolation(foods.get('walnuss')!, p)).toMatch(/Nüsse/)
    // Spuren: Haferflocken können Nuss-Spuren enthalten → bei Allergie standardmäßig ausgeschlossen, abschaltbar
    expect(foodViolation(foods.get('haferflocken')!, p)).toMatch(/Spuren/)
    expect(foodViolation(foods.get('haferflocken')!, { ...p, strictTraces: false })).toBeNull()
    expect(foodViolation(foods.get('tomate')!, p)).toBeNull()
    const q = prefs({ restrictions: [{ allergen: 'gluten', severity: 'intolerance' }] })
    expect(foodViolation(foods.get('vollkornbrot')!, q)).not.toBeNull()
  })
  it('Allergie: Lebensmittel mit unbekannter Allergeninfo werden ausgeschlossen, bei Unverträglichkeit nicht', () => {
    const unknown: Food = { ...foods.get('gurke')!, id: 'x', name: 'Mystery Riegel', allergenInfoKnown: false, allergens: [] }
    expect(foodViolation(unknown, prefs({ restrictions: [{ allergen: 'soja', severity: 'allergy' }] }))).toMatch(/unbekannt/)
    expect(foodViolation(unknown, prefs({ restrictions: [{ allergen: 'soja', severity: 'intolerance' }] }))).toBeNull()
    expect(foodViolation(unknown, prefs())).toBeNull()
  })
  it('vegan/vegetarisch sind harte Regeln', () => {
    const vegan = prefs({ styles: ['vegan'] })
    expect(foodViolation(foods.get('ei')!, vegan)).not.toBeNull()
    expect(foodViolation(foods.get('honig')!, vegan)).not.toBeNull()
    expect(foodViolation(foods.get('joghurt')!, vegan)).not.toBeNull()
    const veg = prefs({ styles: ['vegetarisch'] })
    expect(foodViolation(foods.get('lachs')!, veg)).not.toBeNull()
    expect(foodViolation(foods.get('ei')!, veg)).toBeNull()
  })
  it('benutzerdefinierte Ausschlüsse greifen auch bei Umlauten/Groß-Kleinschreibung', () => {
    expect(foodViolation(foods.get('kuerbis')!, prefs({ customExclusions: ['KÜRBIS'] }))).not.toBeNull()
    expect(foodViolation(foods.get('kuerbis')!, prefs({ customExclusions: [' '] }))).toBeNull()
  })
  it('Allergenstatus: unbekannte Zutat → unknown, nie als allergenfrei', () => {
    const f2 = new Map(foods); f2.set('x', { ...foods.get('gurke')!, id: 'x', allergenInfoKnown: false })
    expect(allergenStatus([{ foodId: 'x', grams: 10 }], f2).unknown).toBe(true)
    expect(allergenStatus([{ foodId: 'ei', grams: 10 }], f2).allergens).toContain('eier')
    expect(allergenStatus([{ foodId: 'gibtsnicht', grams: 1 }], f2).unknown).toBe(true)
  })
  it('Rezept mit ausgeschlossenem Lebensmittel wird abgelehnt', () => {
    const r = BUILTIN_RECIPES.find(x => x.id === 'r-lachsofen')!
    const p = prefs({ excludedFoods: ['paprika'] })
    expect(recipeViolation(r, foods, p, { warm: 'olivenoel', cold: 'olivenoel' })).not.toBeNull()
  })
  it('Widersprüche werden erkannt', () => {
    const c = detectConflicts(prefs({ styles: ['vegan', 'vegetarisch', 'mediterran', 'lowcarb', 'highprotein'], preferredFoods: ['ei'], excludedFoods: ['ei'] }))
    expect(c.length).toBeGreaterThanOrEqual(4)
  })
})

describe('Öle', () => {
  it('Leinöl wird nie zum Erhitzen gewählt; Hauptöl und Zuordnung werden respektiert', () => {
    const p = prefs({ oils: { preferred: ['leinoel'], excluded: [], main: 'leinoel', warm: null, cold: null } })
    const { oils, notes } = chooseOils(BUILTIN_FOODS, p)
    expect(oils.cold).toBe('leinoel')
    expect(oils.warm).not.toBe('leinoel')
    expect(notes.some(n => n.includes('ersatzweise'))).toBe(true)
    const q = prefs({ oils: { preferred: ['olivenoel'], excluded: [], main: 'olivenoel', warm: 'avocadooel', cold: 'leinoel' } })
    expect(chooseOils(BUILTIN_FOODS, q).oils).toEqual({ warm: 'avocadooel', cold: 'leinoel' })
  })
  it('ausgeschlossene Öle, Butter bei Vegan und Walnussöl bei Nussallergie werden nicht gewählt', () => {
    const p = prefs({ styles: ['vegan'], restrictions: [{ allergen: 'nuesse', severity: 'allergy' }], oils: { preferred: ['butter', 'walnussoel', 'olivenoel'], excluded: ['olivenoel'], main: 'butter', warm: null, cold: null } })
    const { oils } = chooseOils(BUILTIN_FOODS, p)
    expect(['butter', 'walnussoel', 'olivenoel']).not.toContain(oils.warm)
    expect(['butter', 'walnussoel', 'olivenoel']).not.toContain(oils.cold)
  })
})

describe('Planerstellung', () => {
  for (const { days } of PERIODS) {
    it(`erzeugt Plan mit ${days} Tagen, vollständigen Mahlzeiten und Kalorienziel ±5 %`, () => {
      const plan = gen({ mealCount: 4 }, {}, days)
      expect(plan.days).toHaveLength(days)
      const ctx = ctxFor()
      for (const d of plan.days) {
        expect(d.meals.map(m => m.slot)).toEqual(['fruehstueck', 'mittag', 'snack', 'abend'])
        const dev = Math.abs(dayTotals(d, ctx).kcal - plan.kcalTarget) / plan.kcalTarget
        expect(dev).toBeLessThan(0.05)
      }
      expect(plan.days[days - 1].date).toBe(new Date(Date.UTC(2026, 10, 16 + days - 1)).toISOString().slice(0, 10))
    })
  }
  it('mealCount 3 und 5 liefern 3 bzw. 5 Mahlzeiten pro Tag', () => {
    expect(gen({ mealCount: 3 }).days.every(d => d.meals.length === 3)).toBe(true)
    const p5 = gen({ mealCount: 5 })
    expect(p5.days.every(d => d.meals.length === 5)).toBe(true)
    expect(p5.days.every(d => new Set(d.meals.map(m => m.recipeId)).size === 5)).toBe(true)
  })
  it('hält verschiedene Kalorienziele ein (1400–2500: ±3 %)', () => {
    for (const k of [1400, 1800, 2500]) {
      const plan = gen({ kcalMode: 'manual', kcalManual: k, mealCount: 4 })
      const ctx = ctxFor()
      for (const d of plan.days) expect(Math.abs(dayTotals(d, ctx).kcal - k) / k).toBeLessThan(0.03)
    }
  })
  it('3000 kcal mit 4 Mahlzeiten wird auf ±3 % erreicht (früher bis 11 % Abweichung)', () => {
    const plan = gen({ kcalMode: 'manual', kcalManual: 3000, mealCount: 4 }, {}, 14)
    const ctx = ctxFor()
    for (const d of plan.days) expect(Math.abs(dayTotals(d, ctx).kcal - 3000) / 3000).toBeLessThan(0.03)
  })
  it('4000 kcal: physikalisch nicht erreichbar → Abweichung wird gemeldet statt verschwiegen', () => {
    const plan = gen({ kcalMode: 'manual', kcalManual: 4000, mealCount: 3 }, {}, 7)
    const a = analyzePlan(plan, ctxFor(), 3)
    expect(Math.max(...a.days.map(d => Math.abs(d.devPct)))).toBeGreaterThan(5)
    expect(a.issues.some(i => i.level === 'error' && i.text.includes('5 %'))).toBe(true)
  })
  it('verwendet nur erlaubte Lebensmittel (Allergien + Ausschlüsse), inkl. Öl', () => {
    const p = prefs({ restrictions: [{ allergen: 'nuesse', severity: 'allergy' }, { allergen: 'laktose', severity: 'intolerance' }, { allergen: 'gluten', severity: 'allergy' }], excludedFoods: ['lachs', 'tofu'], oils: { preferred: ['walnussoel'], excluded: [], main: 'walnussoel', warm: null, cold: null } })
    const plan = gen({ mealCount: 4 }, p, 30)
    const ctx = buildContext(BUILTIN_FOODS, BUILTIN_RECIPES, p)
    for (const d of plan.days) for (const m of d.meals) {
      const r = ctx.recipes.get(m.recipeId)!
      expect(recipeViolation(r, ctx.foods, p, plan.oils), r.name).toBeNull()
    }
  })
  it('Vegan: keine tierischen Zutaten, kein Butter/Ghee', () => {
    const p = prefs({ styles: ['vegan'] })
    const plan = gen({ mealCount: 4 }, p, 14)
    const ctx = buildContext(BUILTIN_FOODS, BUILTIN_RECIPES, p)
    for (const d of plan.days) for (const m of d.meals)
      for (const i of ctx.recipes.get(m.recipeId)!.ingredients) {
        const id = i.foodId === 'oil:warm' ? plan.oils.warm : i.foodId === 'oil:cold' ? plan.oils.cold : i.foodId
        expect(foods.get(id!)!.animal).toBe('none')
      }
  })
  it('Bevorzugte Lebensmittel kommen häufiger vor als ohne Präferenz', () => {
    const count = (plan: ReturnType<typeof gen>) => plan.days.flatMap(d => d.meals).filter(m => BUILTIN_RECIPES.find(r => r.id === m.recipeId)!.ingredients.some(i => i.foodId === 'suesskartoffel')).length
    const base = count(gen({}, {}, 14))
    const pref = count(gen({}, { preferredFoods: ['suesskartoffel'] }, 14))
    expect(pref).toBeGreaterThan(base)
  })
  it('Low Carb senkt den Kohlenhydratanteil gegenüber Mischkost', () => {
    const share = (p: ReturnType<typeof gen>) => {
      const ctx = ctxFor(); let c = 0, e = 0
      for (const d of p.days) { const t = dayTotals(d, ctx); c += t.carbs * 4; e += t.kcal }
      return c / e
    }
    expect(share(gen({}, { styles: ['lowcarb'] }, 14))).toBeLessThan(share(gen({}, {}, 14)))
  })
  it('Vielfalt: in 7 Tagen kein Rezept am selben Tag doppelt und wenige enge Wiederholungen', () => {
    const plan = gen({ mealCount: 4 })
    const a = analyzePlan(plan, ctxFor(), 4)
    expect(a.score.parts.wiederholungen).toBeGreaterThan(80)
    expect(a.score.parts.vielfalt).toBeGreaterThan(80)
    expect(a.score.total).toBeGreaterThan(60)
  })
  it('gleiche Eingaben + gleicher Seed → gleicher Plan (deterministisch), anderer Seed → anderer Plan', () => {
    const ids = (p: ReturnType<typeof gen>) => p.days.flatMap(d => d.meals.map(m => m.recipeId + m.factor)).join()
    expect(ids(gen({}, {}, 7, 5))).toBe(ids(gen({}, {}, 7, 5)))
    expect(ids(gen({}, {}, 14, 5))).not.toBe(ids(gen({}, {}, 14, 99)))
  })
})

describe('Grenzfälle und widersprüchliche Einstellungen', () => {
  it('unerreichbar: Vegan + Soja-Allergie + Nuss-Allergie + Gluten + Hülsenfrüchte ausgeschlossen → transparente Fehler, kein Crash', () => {
    const p = prefs({
      styles: ['vegan'],
      restrictions: [{ allergen: 'soja', severity: 'allergy' }, { allergen: 'nuesse', severity: 'allergy' }, { allergen: 'gluten', severity: 'allergy' }],
      excludedFoods: ['kichererbsen', 'kidneybohnen', 'linsen', 'chia', 'avocado', 'banane', 'apfel', 'birne', 'erdnussmus', 'himbeeren', 'erdbeeren', 'blaubeeren'],
    })
    const plan = gen({}, p, 7)
    const a = analyzePlan(plan, buildContext(BUILTIN_FOODS, BUILTIN_RECIPES, p))
    expect(a.issues.some(i => i.level === 'error')).toBe(true)
  })
  it('alles ausgeschlossen → leere Tage, Fehlermeldung statt vermeintlich perfektem Plan', () => {
    const p = prefs({ excludedFoods: BUILTIN_FOODS.map(f => f.id) })
    const plan = gen({}, p, 7)
    expect(plan.days.every(d => d.meals.length === 0)).toBe(true)
    const a = analyzePlan(plan, buildContext(BUILTIN_FOODS, BUILTIN_RECIPES, p))
    expect(a.issues.filter(i => i.level === 'error').length).toBeGreaterThan(0)
    expect(a.score.total).toBeLessThan(40)
  })
  it('sehr hohes Kalorienziel erzeugt Warnung wegen extremer Portionen', () => {
    const plan = gen({ kcalMode: 'manual', kcalManual: 4500 }, {}, 7)
    const a = analyzePlan(plan, ctxFor())
    expect(a.issues.some(i => i.level !== 'info')).toBe(true)
  })
  it('keine geeigneten Öle → Hinweis', () => {
    const p = prefs({ oils: { preferred: [], excluded: BUILTIN_FOODS.filter(f => f.category === 'oele').map(f => f.id), main: null, warm: null, cold: null } })
    const ctx = buildContext(BUILTIN_FOODS, BUILTIN_RECIPES, p)
    expect(ctx.oilNotes.length).toBe(2)
  })
  it('geänderte Einstellungen nach Planerstellung machen Verstöße sichtbar', () => {
    const plan = gen({})
    const strict = buildContext(BUILTIN_FOODS, BUILTIN_RECIPES, prefs({ excludedFoods: ['paprika', 'haferflocken', 'ei', 'kartoffel', 'tomate'] }))
    const a = analyzePlan(plan, strict)
    expect(a.issues.some(i => i.text.includes('verletzt'))).toBe(true)
  })
})

describe('Planänderungen und Einkaufsliste', () => {
  const base = gen({ mealCount: 4, persons: 2 }, {}, 7)
  const ctx = ctxFor()
  const shop = (plan: typeof base, st = { checked: [] as string[], removed: [] as string[], manual: [] as { id: string; name: string; amount: string; checked: boolean }[] }) =>
    buildShoppingList(plan, ctx.recipes, ctx.foods, ctx.oils, 2, st)

  it('Einkaufsliste summiert Mengen (× Personen), fasst Duplikate zusammen und gruppiert nach Kategorie', () => {
    const list = shop(base)
    const keys = list.groups.flatMap(g => g.items.map(i => i.key))
    expect(new Set(keys).size).toBe(keys.length)
    const target = list.groups.flatMap(g => g.items).find(i => i.key === 'ei')!
    let expected = 0
    for (const d of base.days) for (const m of d.meals) {
      const r = ctx.recipes.get(m.recipeId)!
      for (const i of r.ingredients) if (i.foodId === 'ei') expected += i.grams * m.factor * 2
    }
    expect(expected).toBeGreaterThan(0)
    expect(target.grams).toBe(Math.round(expected))
    // mindestens eine Zutat kommt in mehreren Rezepten vor und wurde addiert
    const multi = new Map<string, number>()
    for (const d of base.days) for (const m of d.meals) for (const i of new Set(ctx.recipes.get(m.recipeId)!.ingredients.map(x => x.foodId))) multi.set(i, (multi.get(i) ?? 0) + 1)
    expect([...multi.values()].some(n => n > 1)).toBe(true)
    for (const g of list.groups) for (const i of g.items) expect(foods.get(i.key)?.category ?? 'sonstige').toBe(g.category)
  })
  it('Einkaufsliste enthält Öl aus dem Plan', () => {
    expect(shop(base).groups.flatMap(g => g.items).some(i => i.key === base.oils.warm)).toBe(true)
  })
  it('entfernen, abhaken und manuell ergänzen', () => {
    const l = shop(base, { checked: ['ei'], removed: ['kartoffel'], manual: [{ id: 'mx', name: 'Spülmittel', amount: '1 Fl.', checked: false }] })
    const items = l.groups.flatMap(g => g.items)
    expect(items.find(i => i.key === 'kartoffel')).toBeUndefined()
    expect(items.find(i => i.key === 'ei')?.checked).toBe(true)
    expect(items.find(i => i.key === 'mx')?.manual).toBe(true)
  })
  it('Mahlzeit austauschen aktualisiert Nährwerte und Einkaufsliste', () => {
    const day = base.days[0]
    const meal = day.meals[1]
    const target = mealMacros(meal, ctx.recipes, ctx.foods, ctx.oils).kcal
    const alt = alternativesFor(meal.slot, target, ctx, [meal.recipeId])
    expect(alt.length).toBeGreaterThan(0)
    const swapped = swapMeal(base, day.date, meal.id, alt[0].recipe.id, alt[0].factor)
    expect(swapped.days[0].meals[1].recipeId).toBe(alt[0].recipe.id)
    expect(dayTotals(swapped.days[0], ctx).kcal).not.toBeCloseTo(dayTotals(day, ctx).kcal, 3)
    expect(JSON.stringify(shop(swapped))).not.toBe(JSON.stringify(shop(base)))
    expect(base.days[0].meals[1].recipeId).toBe(meal.recipeId) // Original unverändert (immutable)
  })
  it('Mahlzeit löschen/ergänzen/Portion ändern aktualisiert Kalorien unmittelbar', () => {
    const d = base.days[0], k0 = dayTotals(d, ctx).kcal
    const removed = removeMeal(base, d.date, d.meals[0].id)
    expect(removed.days[0].meals).toHaveLength(d.meals.length - 1)
    expect(dayTotals(removed.days[0], ctx).kcal).toBeLessThan(k0)
    const r = ctx.eligible.find(x => x.slots.includes('snack'))!
    const added = addMeal(removed, d.date, 'snack', r.id, 1)
    expect(added.days[0].meals.length).toBe(d.meals.length)
    const doubled = setFactor(base, d.date, d.meals[0].id, d.meals[0].factor * 2)
    const m0 = mealMacros(d.meals[0], ctx.recipes, ctx.foods, ctx.oils).kcal
    expect(dayTotals(doubled.days[0], ctx).kcal).toBeCloseTo(k0 + m0, 6)
  })
  it('Personenzahl verdoppelt Einkaufsmengen', () => {
    const one = buildShoppingList(base, ctx.recipes, ctx.foods, ctx.oils, 1, { checked: [], removed: [], manual: [] })
    const two = shop(base)
    const g = (l: typeof one) => l.groups.flatMap(x => x.items).find(i => i.key === 'ei')!.grams
    expect(Math.abs(g(two) - 2 * g(one))).toBeLessThanOrEqual(1)
  })
})

describe('Validierung', () => {
  it('Profil', () => {
    expect(profileSchema.safeParse(defaultProfile()).success).toBe(true)
    expect(profileSchema.safeParse({ ...defaultProfile(), age: 10 }).success).toBe(false)
    expect(profileSchema.safeParse({ ...defaultProfile(), weightKg: -5 }).success).toBe(false)
    expect(profileSchema.safeParse({ ...defaultProfile(), kcalManual: 500 }).success).toBe(false)
    expect(profileSchema.safeParse({ ...defaultProfile(), heightCm: NaN }).success).toBe(false)
  })
  it('Lebensmittel: Atwater-Plausibilität und Makrosumme', () => {
    const ok = { name: 'Test', category: 'obst', kcal: 52, protein: 0.3, carbs: 14, fat: 0.2, fiber: 2 }
    expect(foodInputSchema.safeParse(ok).success).toBe(true)
    expect(foodInputSchema.safeParse({ ...ok, kcal: 800 }).success).toBe(false)
    expect(foodInputSchema.safeParse({ ...ok, protein: 60, carbs: 60 }).success).toBe(false)
    expect(foodInputSchema.safeParse({ ...ok, name: ' ' }).success).toBe(false)
  })
  it('Rezept', () => {
    expect(recipeInputSchema.safeParse({ name: 'x', slots: ['mittag'], ingredients: [{ foodId: 'ei', grams: 50 }] }).success).toBe(true)
    expect(recipeInputSchema.safeParse({ name: 'x', slots: [], ingredients: [] }).success).toBe(false)
  })
})

it('Rezeptdatenbank deckt jede Mahlzeitenart ab (Typ-Check)', () => {
  const rs: Recipe[] = BUILTIN_RECIPES
  for (const s of ['fruehstueck', 'mittag', 'abend', 'snack'] as const) expect(rs.filter(r => r.slots.includes(s)).length).toBeGreaterThanOrEqual(9)
})
