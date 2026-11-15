import type { MealSlot, Plan, PlannedMeal } from './types'
import { newMealId } from './planner'

const mapDay = (plan: Plan, date: string, fn: (m: PlannedMeal[]) => PlannedMeal[]): Plan => ({
  ...plan, days: plan.days.map(d => (d.date === date ? { ...d, meals: fn(d.meals) } : d)),
})

export const swapMeal = (plan: Plan, date: string, mealId: string, recipeId: string, factor: number): Plan =>
  mapDay(plan, date, ms => ms.map(m => (m.id === mealId ? { ...m, recipeId, factor } : m)))

export const removeMeal = (plan: Plan, date: string, mealId: string): Plan =>
  mapDay(plan, date, ms => ms.filter(m => m.id !== mealId))

export const addMeal = (plan: Plan, date: string, slot: MealSlot, recipeId: string, factor: number): Plan => {
  const order: MealSlot[] = ['fruehstueck', 'snack', 'mittag', 'abend']
  return mapDay(plan, date, ms => [...ms, { id: newMealId(), slot, recipeId, factor }].sort((a, b) => order.indexOf(a.slot) - order.indexOf(b.slot)))
}

export const setFactor = (plan: Plan, date: string, mealId: string, factor: number): Plan =>
  mapDay(plan, date, ms => ms.map(m => (m.id === mealId ? { ...m, factor } : m)))
