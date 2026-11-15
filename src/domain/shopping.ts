import type { Category, Plan, Recipe, Food, ShoppingState } from './types'
import { CATEGORIES } from './types'
import { resolveIngredients, type OilChoice } from './nutrition'

export interface ShoppingItem { key: string; name: string; category: Category; grams: number; checked: boolean; manual?: boolean; amount?: string; hint?: string }

/** Summiert alle Zutaten des Plans (× Personenzahl) je Lebensmittel. Doppelte Zutaten werden zusammengeführt. */
export function aggregate(plan: Plan | null, recipes: Map<string, Recipe>, foods: Map<string, Food>, oils: OilChoice, persons: number): Map<string, number> {
  const tot = new Map<string, number>()
  if (!plan) return tot
  for (const d of plan.days) for (const m of d.meals) {
    const r = recipes.get(m.recipeId)
    if (!r) continue
    for (const i of resolveIngredients(r.ingredients, oils)) {
      if (!foods.has(i.foodId)) continue
      tot.set(i.foodId, (tot.get(i.foodId) ?? 0) + i.grams * m.factor * persons)
    }
  }
  return tot
}

export function buildShoppingList(plan: Plan | null, recipes: Map<string, Recipe>, foods: Map<string, Food>, oils: OilChoice, persons: number, state: ShoppingState): { groups: { category: Category; items: ShoppingItem[] }[]; total: number } {
  const agg = aggregate(plan, recipes, foods, oils, persons)
  const items: ShoppingItem[] = []
  for (const [id, grams] of agg) {
    if (state.removed.includes(id)) continue
    const f = foods.get(id)!
    const unit = f.unit && f.unit.label !== 'EL' ? `≈ ${Math.round((grams / f.unit.grams) * 10) / 10} ${f.unit.label === 'Stück' ? 'Stk.' : f.unit.label}` : undefined
    items.push({ key: id, name: f.name, category: f.category, grams: Math.round(grams), checked: state.checked.includes(id), hint: unit })
  }
  for (const m of state.manual) items.push({ key: m.id, name: m.name, category: 'sonstige', grams: 0, amount: m.amount, checked: m.checked, manual: true })
  const groups = CATEGORIES.map(category => ({
    category,
    items: items.filter(i => i.category === category).sort((a, b) => Number(a.checked) - Number(b.checked) || a.name.localeCompare(b.name, 'de')),
  })).filter(g => g.items.length)
  return { groups, total: items.length }
}
