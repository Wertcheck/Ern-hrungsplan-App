import type { Activity, Food, Goal, Ingredient, PlannedMeal, Profile, Recipe, Sex } from './types'
import { OIL_COLD, OIL_WARM } from './types'

export interface Macros { kcal: number; protein: number; carbs: number; fat: number; fiber: number }
export const ZERO: Macros = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 }

export const addMacros = (a: Macros, b: Macros): Macros => ({
  kcal: a.kcal + b.kcal, protein: a.protein + b.protein, carbs: a.carbs + b.carbs,
  fat: a.fat + b.fat, fiber: a.fiber + b.fiber,
})
export const scaleMacros = (m: Macros, f: number): Macros => ({
  kcal: m.kcal * f, protein: m.protein * f, carbs: m.carbs * f, fat: m.fat * f, fiber: m.fiber * f,
})

export function foodMacros(food: Food, grams: number): Macros {
  const k = grams / 100
  return { kcal: food.kcal * k, protein: food.protein * k, carbs: food.carbs * k, fat: food.fat * k, fiber: food.fiber * k }
}

export interface OilChoice { warm: string | null; cold: string | null }

/** Ersetzt Öl-Platzhalter durch die gewählten Öle. Unbekannte Zutaten werden ignoriert. */
export function resolveIngredients(ings: Ingredient[], oils: OilChoice): Ingredient[] {
  const out: Ingredient[] = []
  for (const i of ings) {
    if (i.foodId === OIL_WARM) { if (oils.warm) out.push({ foodId: oils.warm, grams: i.grams }) }
    else if (i.foodId === OIL_COLD) { if (oils.cold) out.push({ foodId: oils.cold, grams: i.grams }) }
    else out.push(i)
  }
  return out
}

export function ingredientsMacros(ings: Ingredient[], foods: Map<string, Food>, factor = 1): Macros {
  let m = ZERO
  for (const i of ings) {
    const f = foods.get(i.foodId)
    if (f) m = addMacros(m, foodMacros(f, i.grams * factor))
  }
  return m
}

/** Nährwerte einer Rezeptportion (Faktor 1) inkl. aufgelöstem Öl */
export function recipeMacros(r: Recipe, foods: Map<string, Food>, oils: OilChoice, factor = 1): Macros {
  return ingredientsMacros(resolveIngredients(r.ingredients, oils), foods, factor)
}

export function mealMacros(m: PlannedMeal, recipes: Map<string, Recipe>, foods: Map<string, Food>, oils: OilChoice): Macros {
  const r = recipes.get(m.recipeId)
  return r ? recipeMacros(r, foods, oils, m.factor) : ZERO
}

/** Energieanteile in % (Eiweiß/KH 4 kcal, Fett 9 kcal) */
export function macroShares(m: Macros): { protein: number; carbs: number; fat: number } {
  const e = m.protein * 4 + m.carbs * 4 + m.fat * 9
  if (e <= 0) return { protein: 0, carbs: 0, fat: 0 }
  return { protein: (m.protein * 4 * 100) / e, carbs: (m.carbs * 4 * 100) / e, fat: (m.fat * 9 * 100) / e }
}

const ACTIVITY: Record<Activity, number> = { sitzend: 1.2, leicht: 1.375, moderat: 1.55, hoch: 1.725 }
export const ACTIVITY_LABEL: Record<Activity, string> = {
  sitzend: 'Überwiegend sitzend (×1,2)', leicht: 'Leicht aktiv (×1,375)',
  moderat: 'Moderat aktiv (×1,55)', hoch: 'Sehr aktiv (×1,725)',
}
const GOAL_ADJ: Record<Goal, number> = { halten: 0, ausgewogen: 0, reduzieren: -0.1, aufbauen: 0.1 }
export const MIN_KCAL = 1200
export const MAX_KCAL = 4500

/** Grundumsatz nach Mifflin-St Jeor. Für "divers" wird der Mittelwert der Konstanten genutzt. */
export function bmr(sex: Sex, age: number, heightCm: number, weightKg: number): number {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age
  return base + (sex === 'm' ? 5 : sex === 'f' ? -161 : -78)
}

export interface KcalEstimate { bmr: number; tdee: number; target: number; adjustmentPct: number; notes: string[] }

export function estimateKcal(p: Pick<Profile, 'sex' | 'age' | 'heightCm' | 'weightKg' | 'activity' | 'goal'>): KcalEstimate {
  const b = bmr(p.sex, p.age, p.heightCm, p.weightKg)
  const tdee = b * ACTIVITY[p.activity]
  const adj = GOAL_ADJ[p.goal]
  let target = Math.round((tdee * (1 + adj)) / 10) * 10
  const notes = [
    `Grundumsatz nach Mifflin-St Jeor: ${Math.round(b)} kcal`,
    `Gesamtumsatz = Grundumsatz × Aktivitätsfaktor ${ACTIVITY[p.activity]} = ${Math.round(tdee)} kcal`,
    adj === 0 ? 'Kein Zuschlag/Abschlag (Gewicht halten bzw. ausgewogen).'
      : adj < 0 ? 'Moderates Defizit von 10 % (bewusst kein aggressives Defizit).' : 'Moderater Überschuss von 10 %.',
    'Dies ist nur eine grobe Schätzung und keine medizinische Empfehlung.',
  ]
  if (target < MIN_KCAL) { target = MIN_KCAL; notes.push(`Untergrenze von ${MIN_KCAL} kcal angewendet.`) }
  if (target > MAX_KCAL) { target = MAX_KCAL }
  return { bmr: b, tdee, target, adjustmentPct: adj * 100, notes }
}

export const kcalTarget = (p: Profile): number => (p.kcalMode === 'manual' ? p.kcalManual : estimateKcal(p).target)

/** Skaliert Zutaten auf eine neue Portionszahl (Nährwerte werden stets aus den Zutaten neu berechnet). */
export function scaleIngredients(ings: Ingredient[], factor: number): Ingredient[] {
  return ings.map(i => ({ ...i, grams: i.grams * factor }))
}
