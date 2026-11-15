import type { Food, FoodGroup, Recipe } from './types'
import { OIL_COLD, OIL_WARM } from './types'
import type { OilChoice } from './nutrition'
import { resolveIngredients } from './nutrition'

/** Höchstmengen je Zutat und Mahlzeit (Gramm, pro Person), jenseits davon wirken Portionen unrealistisch. */
export const MEAL_CAP_G: Partial<Record<FoodGroup, number>> = {
  oel_fett: 30, nuss_samen: 60, gewuerz: 15, zucker: 30, fleisch: 350, fisch: 350, schalentiere: 350, ei: 330, milch: 300,
}

export const FACTOR_MIN = 0.5
export const FACTOR_MAX = 2.0
/** Bevorzugter Portionsbereich: außerhalb wird im Planer bestraft und im Bericht angezeigt */
export const PREF_MIN = 0.75
export const PREF_MAX = 1.5

/** Größter plausibler Portionsfaktor eines Rezepts (kleinste Grenze über alle gedeckelten Zutaten). */
export function maxPlausibleFactor(r: Recipe, foods: Map<string, Food>, oils: OilChoice): number {
  let hi = FACTOR_MAX
  for (const i of resolveIngredients(r.ingredients, oils)) {
    const f = foods.get(i.foodId)
    const cap = f ? MEAL_CAP_G[f.group] : undefined
    if (cap && i.grams > 0) hi = Math.min(hi, cap / i.grams)
  }
  return Math.max(FACTOR_MIN, hi)
}

export const isOilPlaceholder = (id: string) => id === OIL_WARM || id === OIL_COLD
