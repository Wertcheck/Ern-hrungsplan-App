import type { Food, MealSlot, Plan, PlanDay, PlannedMeal, Preferences, Profile, Recipe } from './types'
import { SLOT_LABEL } from './types'
import { kcalTarget, macroShares, mealMacros, recipeMacros, ZERO, addMacros, type Macros, type OilChoice } from './nutrition'
import { SOFT_STYLES, chooseOils, macroTarget, recipeViolation, styleFit } from './rules'

export const PERIODS = [
  { days: 7, label: '1 Woche' }, { days: 14, label: '2 Wochen' }, { days: 21, label: '3 Wochen' }, { days: 30, label: '1 Monat' },
] as const

export const FACTOR_MIN = 0.6
export const FACTOR_MAX = 1.8
const STEP = 0.05

export interface PlanContext {
  foods: Map<string, Food>
  recipes: Map<string, Recipe>
  oils: OilChoice
  oilNotes: string[]
  prefs: Preferences
  eligible: Recipe[]
  rejected: Map<string, string>
}

export function buildContext(foodList: Food[], recipeList: Recipe[], prefs: Preferences): PlanContext {
  const foods = new Map(foodList.map(f => [f.id, f]))
  const recipes = new Map(recipeList.map(r => [r.id, r]))
  const { oils, notes } = chooseOils(foodList, prefs)
  const eligible: Recipe[] = []
  const rejected = new Map<string, string>()
  for (const r of recipeList) {
    const v = recipeViolation(r, foods, prefs, oils)
    if (v) rejected.set(r.id, v)
    else eligible.push(r)
  }
  return { foods, recipes, oils, oilNotes: notes, prefs, eligible, rejected }
}

export function slotsFor(mealCount: 3 | 4 | 5): { slot: MealSlot; share: number }[] {
  if (mealCount === 3) return [{ slot: 'fruehstueck', share: 0.25 }, { slot: 'mittag', share: 0.4 }, { slot: 'abend', share: 0.35 }]
  if (mealCount === 4) return [{ slot: 'fruehstueck', share: 0.25 }, { slot: 'mittag', share: 0.35 }, { slot: 'snack', share: 0.1 }, { slot: 'abend', share: 0.3 }]
  return [{ slot: 'fruehstueck', share: 0.22 }, { slot: 'snack', share: 0.08 }, { slot: 'mittag', share: 0.32 }, { slot: 'snack', share: 0.08 }, { slot: 'abend', share: 0.3 }]
}

const snap = (f: number) => Math.round(Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, f)) / STEP) * STEP
const round2 = (n: number) => Math.round(n * 100) / 100

export function factorFor(r: Recipe, targetKcal: number, ctx: PlanContext): number {
  const k = recipeMacros(r, ctx.foods, ctx.oils).kcal
  return k > 0 ? round2(snap(targetKcal / k)) : 1
}

/** Seeded PRNG (mulberry32) – nur für minimale Tie-Breaker, damit „Neu generieren“ Alternativen liefert. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

const PERISHABLE = new Set(['gemuese', 'obst', 'fleisch', 'fisch', 'milch'])

interface ScoreEnv { targetKcal: number; recent: Map<string, number>; counts: Map<string, number>; yesterdayKeys: Set<string>; recentFresh: Set<string> }

function mainKey(r: Recipe, ctx: PlanContext): string {
  let best = '', bp = -1
  for (const i of r.ingredients) {
    const f = ctx.foods.get(i.foodId)
    if (!f || f.category === 'oele') continue
    const p = (f.protein * i.grams) / 100
    if (p > bp) { bp = p; best = f.id }
  }
  return best
}

export function scoreCandidate(r: Recipe, ctx: PlanContext, env: ScoreEnv, jitter = 0): number {
  const m = recipeMacros(r, ctx.foods, ctx.oils)
  if (m.kcal <= 0) return -Infinity
  const factor = snap(env.targetKcal / m.kcal)
  const achieved = m.kcal * factor
  const calErr = Math.abs(achieved - env.targetKcal) / env.targetKcal
  let s = -4 * calErr - 0.6 * Math.abs(factor - 1)
  // Präferenzen
  const ing = r.ingredients.filter(i => !i.foodId.startsWith('oil:'))
  const prefHits = ing.filter(i => ctx.prefs.preferredFoods.includes(i.foodId)).length
  const favHits = ing.filter(i => ctx.prefs.favoriteFoods.includes(i.foodId)).length
  s += 1.2 * (prefHits / Math.max(1, ing.length)) * 3 + 0.5 * (favHits / Math.max(1, ing.length)) * 2 + (r.favorite ? 0.8 : 0)
  // Ernährungsstile
  const soft = ctx.prefs.styles.filter(x => SOFT_STYLES.includes(x))
  for (const st of soft) s += 1.5 * styleFit(r, st, ctx.foods, ctx.oils)
  // Makros
  const sh = macroShares(m), t = macroTarget(ctx.prefs.styles)
  s -= (Math.abs(sh.protein - t.protein) + Math.abs(sh.carbs - t.carbs) + Math.abs(sh.fat - t.fat)) / 100
  // Vielfalt
  const last = env.recent.get(r.id)
  if (last !== undefined) s -= 5 * Math.max(0, 1 - last / 6)
  s -= 0.25 * (env.counts.get(r.id) ?? 0)
  if (env.yesterdayKeys.has(mainKey(r, ctx))) s -= 0.7
  // Verwertung frischer Zutaten (Verschwendung vermeiden)
  const overlap = new Set(ing.filter(i => { const f = ctx.foods.get(i.foodId); return f && PERISHABLE.has(f.category) && env.recentFresh.has(i.foodId) }).map(i => i.foodId)).size
  s += 0.2 * Math.min(3, overlap)
  // Verfügbarkeit
  s -= 0.3 * ing.filter(i => ctx.foods.get(i.foodId)?.special).length
  return s + jitter
}

export interface GenerateInput {
  profile: Profile
  foods: Food[]
  recipes: Recipe[]
  prefs: Preferences
  startDate: string
  days: number
  seed?: number
}

const uid = (() => { let n = 0; return () => `m${Date.now().toString(36)}${(n++).toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}` })()
export const newMealId = uid

export function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function dayKcal(meals: PlannedMeal[], ctx: PlanContext): number {
  return meals.reduce((s, m) => s + mealMacros(m, ctx.recipes, ctx.foods, ctx.oils).kcal, 0)
}

/** Feinjustierung: Portionsfaktoren in 0,05er-Schritten, bis die Tagessumme möglichst nahe am Ziel liegt. */
function fineTune(meals: PlannedMeal[], target: number, ctx: PlanContext) {
  for (let it = 0; it < 40; it++) {
    const cur = dayKcal(meals, ctx)
    const dev = Math.abs(cur - target)
    if (dev / target < 0.005) return
    let bestMeal = -1, bestF = 0, bestDev = dev
    meals.forEach((m, idx) => {
      const base = mealMacros({ ...m, factor: 1 }, ctx.recipes, ctx.foods, ctx.oils).kcal
      for (const d of [STEP, -STEP]) {
        const nf = round2(m.factor + d)
        if (nf < FACTOR_MIN || nf > FACTOR_MAX) continue
        const nd = Math.abs(cur - m.factor * base + nf * base - target)
        if (nd < bestDev - 1e-9) { bestDev = nd; bestMeal = idx; bestF = nf }
      }
    })
    if (bestMeal < 0) return
    meals[bestMeal] = { ...meals[bestMeal], factor: bestF }
  }
}

export function generatePlan(input: GenerateInput): Plan {
  const { profile, prefs } = input
  const ctx = buildContext(input.foods, input.recipes, prefs)
  const target = kcalTarget(profile)
  const rand = rng(input.seed ?? 1)
  const slots = slotsFor(profile.mealCount)
  const recent = new Map<string, number>()
  const counts = new Map<string, number>()
  let yesterdayKeys = new Set<string>()
  const freshByDay: Set<string>[] = []
  const days: PlanDay[] = []

  for (let d = 0; d < input.days; d++) {
    for (const [k, v] of recent) recent.set(k, v + 1)
    const meals: PlannedMeal[] = []
    const usedToday = new Set<string>()
    const recentFresh = new Set<string>([...(freshByDay[d - 1] ?? []), ...(freshByDay[d - 2] ?? [])])
    for (const { slot, share } of slots) {
      const env: ScoreEnv = { targetKcal: target * share, recent, counts, yesterdayKeys, recentFresh }
      const cands = ctx.eligible.filter(r => r.slots.includes(slot) && !usedToday.has(r.id))
      let best: Recipe | null = null, bs = -Infinity
      for (const r of cands) {
        const sc = scoreCandidate(r, ctx, env, rand() * 0.15)
        if (sc > bs) { bs = sc; best = r }
      }
      if (!best) continue
      usedToday.add(best.id)
      meals.push({ id: newMealId(), slot, recipeId: best.id, factor: factorFor(best, target * share, ctx) })
    }
    if (meals.length) fineTune(meals, target, ctx)
    const fresh = new Set<string>()
    yesterdayKeys = new Set<string>()
    for (const m of meals) {
      const r = ctx.recipes.get(m.recipeId)!
      recent.set(r.id, 0)
      counts.set(r.id, (counts.get(r.id) ?? 0) + 1)
      yesterdayKeys.add(mainKey(r, ctx))
      r.ingredients.forEach(i => fresh.add(i.foodId))
    }
    freshByDay.push(fresh)
    days.push({ date: addDays(input.startDate, d), meals })
  }
  return {
    id: `plan-${Date.now().toString(36)}`, createdAt: new Date().toISOString(), startDate: input.startDate,
    days, oils: ctx.oils, kcalTarget: target, persons: profile.persons,
  }
}

/** Alternativen für einen Slot, nach Score sortiert (für „Mahlzeit austauschen“). */
export function alternativesFor(slot: MealSlot, targetKcal: number, ctx: PlanContext, excludeIds: string[] = [], limit = 8): { recipe: Recipe; factor: number; kcal: number }[] {
  const env: ScoreEnv = { targetKcal, recent: new Map(), counts: new Map(), yesterdayKeys: new Set(), recentFresh: new Set() }
  return ctx.eligible
    .filter(r => r.slots.includes(slot) && !excludeIds.includes(r.id))
    .map(r => ({ r, s: scoreCandidate(r, ctx, env) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(({ r }) => { const factor = factorFor(r, targetKcal, ctx); return { recipe: r, factor, kcal: recipeMacros(r, ctx.foods, ctx.oils, factor).kcal } })
}

// ---------------- Bewertung ----------------
export interface PlanIssue { level: 'error' | 'warn' | 'info'; text: string }
export interface PlanScore {
  total: number
  parts: { kalorien: number; makros: number; praeferenzen: number; vielfalt: number; wiederholungen: number; verfuegbarkeit: number }
}
export interface DayTotals { date: string; macros: Macros; devPct: number }
export interface PlanAnalysis { score: PlanScore; issues: PlanIssue[]; days: DayTotals[] }

export function dayTotals(day: PlanDay, ctx: PlanContext): Macros {
  return day.meals.reduce((s, m) => addMacros(s, mealMacros(m, ctx.recipes, ctx.foods, ctx.oils)), ZERO)
}

export function analyzePlan(plan: Plan, ctx: PlanContext, mealCount: 3 | 4 | 5 = 3): PlanAnalysis {
  const target = plan.kcalTarget
  const issues: PlanIssue[] = []
  const days: DayTotals[] = plan.days.map(d => {
    const macros = dayTotals(d, ctx)
    return { date: d.date, macros, devPct: ((macros.kcal - target) / target) * 100 }
  })
  const tgt = macroTarget(ctx.prefs.styles)
  const nonEmpty = days.filter(d => d.macros.kcal > 0)
  const calScore = days.length ? days.reduce((s, d) => s + Math.max(0, 100 - 20 * Math.abs(d.devPct)), 0) / days.length : 0
  const macScore = nonEmpty.length ? nonEmpty.reduce((s, d) => {
    const sh = macroShares(d.macros)
    return s + Math.max(0, 100 - 2.5 * (Math.abs(sh.protein - tgt.protein) + Math.abs(sh.carbs - tgt.carbs) + Math.abs(sh.fat - tgt.fat)))
  }, 0) / nonEmpty.length : 0

  const meals = plan.days.flatMap(d => d.meals)
  const soft = ctx.prefs.styles.filter(x => SOFT_STYLES.includes(x))
  let prefSum = 0
  for (const m of meals) {
    const r = ctx.recipes.get(m.recipeId)
    if (!r) continue
    const sf = soft.length ? soft.reduce((s, st) => s + styleFit(r, st, ctx.foods, ctx.oils), 0) / soft.length : 1
    const ing = r.ingredients.filter(i => !i.foodId.startsWith('oil:'))
    const hasPref = ctx.prefs.preferredFoods.length > 0 || ctx.prefs.favoriteFoods.length > 0
    const hit = ing.some(i => ctx.prefs.preferredFoods.includes(i.foodId) || ctx.prefs.favoriteFoods.includes(i.foodId)) || r.favorite
    prefSum += 0.6 * sf + 0.4 * (hasPref ? (hit ? 1 : 0) : 1)
  }
  const prefScore = meals.length ? (prefSum / meals.length) * 100 : 0

  // Vielfalt je Slot-Typ
  const bySlot = new Map<MealSlot, string[]>()
  for (const d of plan.days) for (const m of d.meals) bySlot.set(m.slot, [...(bySlot.get(m.slot) ?? []), m.recipeId])
  let vs = 0, vn = 0
  for (const [slot, ids] of bySlot) {
    const pool = ctx.eligible.filter(r => r.slots.includes(slot)).length
    const possible = Math.max(1, Math.min(ids.length, pool))
    vs += Math.min(1, new Set(ids).size / possible); vn++
  }
  const varScore = vn ? (vs / vn) * 100 : 0

  // Wiederholungen: gleiches Rezept innerhalb von 3 Tagen
  let close = 0
  plan.days.forEach((d, i) => {
    const prev = new Set(plan.days.slice(Math.max(0, i - 3), i).flatMap(x => x.meals.map(m => m.recipeId)))
    d.meals.forEach(m => { if (prev.has(m.recipeId)) close++ })
  })
  const repScore = meals.length ? Math.max(0, 100 - (close / meals.length) * 300) : 0

  let ingN = 0, special = 0
  for (const m of meals) for (const i of ctx.recipes.get(m.recipeId)?.ingredients ?? []) {
    ingN++; if (ctx.foods.get(i.foodId)?.special) special++
  }
  const availScore = ingN ? (1 - special / ingN) * 100 : 100

  const parts = {
    kalorien: calScore, makros: macScore, praeferenzen: prefScore, vielfalt: varScore, wiederholungen: repScore, verfuegbarkeit: availScore,
  }
  const total = 0.3 * calScore + 0.15 * macScore + 0.2 * prefScore + 0.15 * varScore + 0.1 * repScore + 0.1 * availScore

  // Transparente Hinweise
  const slotsNeeded = new Set(plan.days.flatMap(d => d.meals.map(m => m.slot)))
  for (const s of ['fruehstueck', 'mittag', 'abend'] as MealSlot[]) {
    if (!ctx.eligible.some(r => r.slots.includes(s)))
      issues.push({ level: 'error', text: `Für „${SLOT_LABEL[s]}“ gibt es mit deinen Einstellungen kein passendes Rezept. Der Plan ist unvollständig.` })
  }
  if (mealCount >= 4 && !slotsNeeded.has('snack') && !ctx.eligible.some(r => r.slots.includes('snack')))
    issues.push({ level: 'error', text: 'Für Zwischenmahlzeiten gibt es mit deinen Einstellungen kein passendes Rezept.' })
  const off = days.filter(d => Math.abs(d.devPct) > 5)
  if (off.length) {
    const worst = off.reduce((a, b) => (Math.abs(b.devPct) > Math.abs(a.devPct) ? b : a))
    issues.push({ level: off.some(d => Math.abs(d.devPct) > 10) ? 'error' : 'warn', text: `An ${off.length} von ${days.length} Tagen weicht die Kalorienzufuhr um mehr als 5 % vom Ziel ab (max. ${worst.devPct > 0 ? '+' : ''}${worst.devPct.toFixed(0)} %).` })
  }
  const extreme = meals.filter(m => m.factor >= FACTOR_MAX - 1e-9 || m.factor <= FACTOR_MIN + 1e-9).length
  if (extreme) issues.push({ level: 'warn', text: `${extreme} Mahlzeit(en) liegen an der Grenze realistischer Portionsgrößen (${FACTOR_MIN}×–${FACTOR_MAX}×). Das Kalorienziel ist mit den vorhandenen Rezepten nur eingeschränkt erreichbar. Mehr Mahlzeiten pro Tag (Snacks) verteilen die Energie besser.` })
  const bad = new Set<string>()
  for (const m of meals) { const v = ctx.rejected.get(m.recipeId); if (v) bad.add(`${ctx.recipes.get(m.recipeId)?.name}: ${v}`) }
  for (const b of bad) issues.push({ level: 'error', text: `Plan verletzt aktuelle Einstellungen – ${b}. Bitte Mahlzeit austauschen oder Plan neu generieren.` })
  for (const n of ctx.oilNotes) issues.push({ level: 'warn', text: n })
  if (repScore < 70) issues.push({ level: 'info', text: 'Wegen weniger passender Rezepte kommt es zu häufigen Wiederholungen. Mehr Lebensmittel zu erlauben oder eigene Rezepte zu ergänzen erhöht die Vielfalt.' })
  return { score: { total, parts }, issues, days }
}
