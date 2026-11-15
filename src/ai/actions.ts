/**
 * Kontrollierte KI-Aktionen.
 * Ablauf: KI schlägt vor → Backend prüft Struktur/Katalog → HIER prüft die deterministische Engine (Regeln, Allergien, Portionen, Kalorien)
 * → Nutzer sieht Vorschau und bestätigt → erneute Prüfung gegen den aktuellen Zustand → erst dann wird gespeichert.
 * Es gibt KEINEN Aktionstyp, der Allergien, Unverträglichkeiten, Ernährungsweisen, Profil oder Regeln ändern oder lockern kann.
 * KI-Zahlen (Kalorien/Nährwerte) werden nie übernommen – alles wird von der Engine berechnet.
 */
import { z } from 'zod'
import type { AppState, Food, MealSlot, Recipe } from '../domain/types'
import { SLOT_LABEL } from '../domain/types'
import { addMeal, removeMeal, setFactor, swapMeal } from '../domain/planops'
import { FACTOR_MIN, buildContext, dayTotals, factorFor, type PlanContext } from '../domain/planner'
import { MEAL_CAP_G } from '../domain/plausibility'
import { foodViolation, recipeViolation } from '../domain/rules'
import { ingredientsMacros, mealMacros, recipeMacros } from '../domain/nutrition'
import { normalize } from '../domain/bls'
import type { Proposal } from './types'

/** Entfernt HTML-Tags und Steuerzeichen (Anzeige erfolgt ohnehin nur als escapeter Text). */
const clean = (s: string, max: number) => s.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const slot = z.enum(['fruehstueck', 'mittag', 'abend', 'snack'])
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const id = z.string().min(1).max(100)
const reason = z.string().max(300).optional()

export const proposalSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('swap_meal'), date, meal_id: id, recipe_id: id, reason }),
  z.object({ type: z.literal('add_meal'), date, slot, recipe_id: id, portion_factor: z.number().min(0.25).max(3).optional(), reason }),
  z.object({ type: z.literal('remove_meal'), date, meal_id: id, reason }),
  z.object({ type: z.literal('set_portion'), date, meal_id: id, portion_factor: z.number().min(0.25).max(3), reason }),
  z.object({ type: z.literal('create_recipe'), name: z.string().min(1).max(80), slots: z.array(slot).min(1).max(4), ingredients: z.array(z.object({ food_name: z.string().min(1).max(200), grams: z.number().min(0.1).max(3000) })).min(1).max(30), steps: z.array(z.string().max(300)).max(15).optional(), reason }),
  z.object({ type: z.literal('exclude_food'), food_name: z.string().min(1).max(200), reason }),
  z.object({ type: z.literal('add_shopping_item'), name: z.string().min(1).max(200), amount: z.string().max(60).optional(), reason }),
])

export interface ActionPreview { title: string; lines: string[]; warnings: string[] }
type Normalized =
  | { kind: 'swap'; date: string; mealId: string; recipeId: string; factor: number }
  | { kind: 'add'; date: string; slot: MealSlot; recipeId: string; factor: number }
  | { kind: 'remove'; date: string; mealId: string }
  | { kind: 'portion'; date: string; mealId: string; factor: number }
  | { kind: 'recipe'; recipe: Recipe }
  | { kind: 'exclude'; foodId: string }
  | { kind: 'shopping'; name: string; amount: string }
export type Validation = { ok: true; preview: ActionPreview; normalized: Normalized } | { ok: false; reason: string }
const no = (reason: string): Validation => ({ ok: false, reason })

const kcal = (n: number) => `${Math.round(n)} kcal`
const FACTOR_STEP = 0.05
const snap = (f: number) => Math.round(f / FACTOR_STEP) * FACTOR_STEP

/** Findet ein Lebensmittel eindeutig anhand des Namens (exakt oder eindeutiger Wortanfang). */
export function findFood(foods: Food[], name: string): { food?: Food; error?: string } {
  const n = normalize(name)
  if (!n) return { error: 'Leerer Lebensmittelname' }
  const exact = foods.filter(f => normalize(f.name) === n)
  if (exact.length === 1) return { food: exact[0] }
  const pre = foods.filter(f => normalize(f.name).startsWith(n))
  if (pre.length === 1) return { food: pre[0] }
  if (pre.length > 1 || exact.length > 1) return { error: `„${name}“ ist mehrdeutig (${(exact.length > 1 ? exact : pre).slice(0, 3).map(f => f.name).join(', ')} …)` }
  return { error: `„${name}“ ist nicht in deiner Lebensmittelliste (die KI darf keine neuen Nährwerte erfinden)` }
}

export function validateProposal(raw: unknown, state: AppState, ctx: PlanContext): Validation {
  const parsed = proposalSchema.safeParse(raw)
  if (!parsed.success) return no('Ungültiger oder unbekannter Aktionstyp')
  const p = parsed.data as Proposal
  const plan = state.plan
  const target = plan?.kcalTarget ?? 0
  const dayOf = (d: string) => plan?.days.find(x => x.date === d)
  const recipeOk = (rid: string, sl?: MealSlot): { r?: Recipe; error?: string } => {
    const r = ctx.recipes.get(rid)
    if (!r) return { error: 'Rezept existiert nicht' }
    const why = ctx.rejected.get(rid)
    if (why) return { error: `„${r.name}“ verstößt gegen deine Regeln (${why}). Allergie- und Ausschlussregeln haben Vorrang.` }
    if (sl && !r.slots.includes(sl)) return { error: `„${r.name}“ passt nicht zu ${SLOT_LABEL[sl]}` }
    return { r }
  }
  const dayInfo = (d: ReturnType<typeof dayOf>, delta: number) => {
    const before = dayTotals(d!, ctx).kcal, after = before + delta, dev = target ? ((after - target) / target) * 100 : 0
    return { before, after, dev }
  }
  const devWarn = (dev: number) => (Math.abs(dev) > 5 ? [`Tagessumme weicht danach um ${dev > 0 ? '+' : ''}${dev.toFixed(0)} % vom Ziel ab`] : [])

  switch (p.type) {
    case 'swap_meal': {
      const d = dayOf(p.date); if (!plan || !d) return no('Tag nicht im Plan')
      const m = d.meals.find(x => x.id === p.meal_id); if (!m) return no('Mahlzeit nicht gefunden')
      if (m.recipeId === p.recipe_id) return no('Das Rezept ist bereits eingeplant')
      const { r, error } = recipeOk(p.recipe_id, m.slot); if (!r) return no(error!)
      const old = mealMacros(m, ctx.recipes, ctx.foods, ctx.oils).kcal
      const factor = factorFor(r, old, ctx), neu = recipeMacros(r, ctx.foods, ctx.oils, factor).kcal
      const di = dayInfo(d, neu - old)
      return { ok: true, normalized: { kind: 'swap', date: p.date, mealId: m.id, recipeId: r.id, factor }, preview: { title: `${SLOT_LABEL[m.slot]} austauschen`,
        lines: [`Vorher: ${ctx.recipes.get(m.recipeId)?.name ?? '?'} (${kcal(old)})`, `Nachher: ${r.name}, ${factor}× Portion (${kcal(neu)})`, `Tagessumme: ${kcal(di.before)} → ${kcal(di.after)}`], warnings: devWarn(di.dev) } }
    }
    case 'add_meal': {
      const d = dayOf(p.date); if (!plan || !d) return no('Tag nicht im Plan')
      if (d.meals.length >= 8) return no('Pro Tag sind höchstens 8 Mahlzeiten möglich')
      const { r, error } = recipeOk(p.recipe_id, p.slot); if (!r) return no(error!)
      if (d.meals.some(m => m.recipeId === r.id)) return no(`„${r.name}“ ist an diesem Tag bereits eingeplant`)
      const used = dayTotals(d, ctx).kcal
      const maxF = ctx.maxFactor.get(r.id) ?? 2
      let factor: number
      if (p.portion_factor !== undefined) { factor = snap(p.portion_factor); if (factor < FACTOR_MIN || factor > maxF + 1e-9) return no(`Portion ${factor}× ist unplausibel (erlaubt ${FACTOR_MIN}×–${maxF.toFixed(2)}× für dieses Rezept)`) }
      else factor = factorFor(r, Math.max(120, Math.min(700, target - used)), ctx)
      const add = recipeMacros(r, ctx.foods, ctx.oils, factor).kcal, di = dayInfo(d, add)
      return { ok: true, normalized: { kind: 'add', date: p.date, slot: p.slot, recipeId: r.id, factor }, preview: { title: `${SLOT_LABEL[p.slot]} ergänzen`,
        lines: [`${r.name}, ${factor}× Portion (${kcal(add)})`, `Tagessumme: ${kcal(di.before)} → ${kcal(di.after)}`], warnings: devWarn(di.dev) } }
    }
    case 'remove_meal': {
      const d = dayOf(p.date); if (!plan || !d) return no('Tag nicht im Plan')
      const m = d.meals.find(x => x.id === p.meal_id); if (!m) return no('Mahlzeit nicht gefunden')
      const old = mealMacros(m, ctx.recipes, ctx.foods, ctx.oils).kcal, di = dayInfo(d, -old)
      return { ok: true, normalized: { kind: 'remove', date: p.date, mealId: m.id }, preview: { title: `${SLOT_LABEL[m.slot]} entfernen`,
        lines: [`${ctx.recipes.get(m.recipeId)?.name ?? '?'} (${kcal(old)}) wird entfernt`, `Tagessumme: ${kcal(di.before)} → ${kcal(di.after)}`], warnings: [...devWarn(di.dev), ...(d.meals.length === 1 ? ['Der Tag hätte danach keine Mahlzeit'] : [])] } }
    }
    case 'set_portion': {
      const d = dayOf(p.date); if (!plan || !d) return no('Tag nicht im Plan')
      const m = d.meals.find(x => x.id === p.meal_id); if (!m) return no('Mahlzeit nicht gefunden')
      const maxF = ctx.maxFactor.get(m.recipeId) ?? 2, factor = snap(p.portion_factor)
      if (factor < FACTOR_MIN || factor > maxF + 1e-9) return no(`Portion ${factor}× ist unplausibel (erlaubt ${FACTOR_MIN}×–${maxF.toFixed(2)}× für dieses Rezept)`)
      const old = mealMacros(m, ctx.recipes, ctx.foods, ctx.oils).kcal, neu = mealMacros({ ...m, factor }, ctx.recipes, ctx.foods, ctx.oils).kcal, di = dayInfo(d, neu - old)
      return { ok: true, normalized: { kind: 'portion', date: p.date, mealId: m.id, factor }, preview: { title: 'Portion anpassen',
        lines: [`${ctx.recipes.get(m.recipeId)?.name ?? '?'}: ${m.factor}× → ${factor}× (${kcal(old)} → ${kcal(neu)})`, `Tagessumme: ${kcal(di.before)} → ${kcal(di.after)}`], warnings: devWarn(di.dev) } }
    }
    case 'create_recipe': {
      const ings: { foodId: string; grams: number }[] = [], errs: string[] = []
      for (const i of p.ingredients) {
        const { food, error } = findFood(state.foods, i.food_name)
        if (!food) { errs.push(error!); continue }
        const v = foodViolation(food, state.prefs)
        if (v) { errs.push(`${food.name}: ${v}`); continue }
        const cap = food.category === 'getraenke' ? undefined : MEAL_CAP_G[food.group]
        if (cap && i.grams > cap) { errs.push(`${food.name}: ${i.grams} g überschreitet die plausible Höchstmenge von ${cap} g pro Mahlzeit`); continue }
        if (ings.some(x => x.foodId === food.id)) { errs.push(`${food.name} ist doppelt aufgeführt`); continue }
        ings.push({ foodId: food.id, grams: i.grams })
      }
      if (errs.length) return no(`Rezept abgelehnt: ${errs.slice(0, 3).join('; ')}`)
      const name = clean(p.name, 80)
      if (!name) return no('Rezeptname fehlt')
      const recipe: Recipe = { id: `custom-ai-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`, name, slots: p.slots as MealSlot[], minutes: 20, ingredients: ings,
        steps: (p.steps ?? []).map(s => clean(s, 300)).filter(Boolean), tags: [], custom: true }
      const v = recipeViolation(recipe, ctx.foods, state.prefs, ctx.oils)
      if (v) return no(`Rezept verstößt gegen deine Ernährungsregeln: ${v}`)
      const m = ingredientsMacros(ings, ctx.foods)
      return { ok: true, normalized: { kind: 'recipe', recipe }, preview: { title: 'Neues Rezept speichern',
        lines: [`${name} – ${recipe.slots.map(s => SLOT_LABEL[s]).join(', ')}`, `Zutaten: ${ings.map(i => `${ctx.foods.get(i.foodId)!.name} ${Math.round(i.grams)} g`).join(', ')}`,
          `Berechnet von der Engine (pro Portion): ${kcal(m.kcal)} · E ${Math.round(m.protein)} g · KH ${Math.round(m.carbs)} g · F ${Math.round(m.fat)} g`],
        warnings: [...(state.recipes.some(r => normalize(r.name) === normalize(name)) ? ['Ein Rezept mit diesem Namen existiert bereits'] : []), 'Nährwerte stammen aus deiner Lebensmitteldatenbank, nicht von der KI.'] } }
    }
    case 'exclude_food': {
      const { food, error } = findFood(state.foods, p.food_name); if (!food) return no(error!)
      if (state.prefs.excludedFoods.includes(food.id)) return no(`${food.name} ist bereits ausgeschlossen`)
      return { ok: true, normalized: { kind: 'exclude', foodId: food.id }, preview: { title: 'Lebensmittel ausschließen', lines: [`${food.name} wird künftig in Plänen nicht mehr verwendet`], warnings: state.plan ? ['Ein bestehender Plan wird auf Verstöße geprüft; zum Anwenden „Neu generieren“.'] : [] } }
    }
    case 'add_shopping_item': {
      const name = clean(p.name, 80), amount = clean(p.amount ?? '', 40)
      if (!name) return no('Produktname fehlt')
      if (state.shopping.manual.some(m => normalize(m.name) === normalize(name))) return no(`„${name}“ steht schon auf der Liste`)
      return { ok: true, normalized: { kind: 'shopping', name, amount }, preview: { title: 'Zur Einkaufsliste', lines: [`${name}${amount ? ` (${amount})` : ''}`], warnings: [] } }
    }
  }
}

/** Wendet eine bereits validierte Aktion an. Nur über confirmProposal aufrufen. */
function apply(state: AppState, n: Normalized): AppState {
  const plan = state.plan
  switch (n.kind) {
    case 'swap': return { ...state, plan: plan && swapMeal(plan, n.date, n.mealId, n.recipeId, n.factor) }
    case 'add': return { ...state, plan: plan && addMeal(plan, n.date, n.slot, n.recipeId, n.factor) }
    case 'remove': return { ...state, plan: plan && removeMeal(plan, n.date, n.mealId) }
    case 'portion': return { ...state, plan: plan && setFactor(plan, n.date, n.mealId, n.factor) }
    case 'recipe': return { ...state, recipes: [...state.recipes, n.recipe] }
    case 'exclude': return { ...state, prefs: { ...state.prefs, excludedFoods: [...state.prefs.excludedFoods, n.foodId], preferredFoods: state.prefs.preferredFoods.filter(x => x !== n.foodId), favoriteFoods: state.prefs.favoriteFoods.filter(x => x !== n.foodId) } }
    case 'shopping': return { ...state, shopping: { ...state.shopping, manual: [...state.shopping.manual, { id: `ai-${Date.now().toString(36)}`, name: n.name, amount: n.amount, checked: false }] } }
  }
}

/** Bestätigung: Aktion wird gegen den AKTUELLEN Zustand erneut geprüft, bevor sie angewendet wird. */
export function confirmProposal(raw: unknown, state: AppState): { ok: true; state: AppState } | { ok: false; reason: string } {
  const ctx = buildContext(state.foods, state.recipes, state.prefs)
  const v = validateProposal(raw, state, ctx)
  if (!v.ok) return v
  return { ok: true, state: apply(state, v.normalized) }
}
