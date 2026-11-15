import type { Food, MealSlot, Plan, PlanDay, PlannedMeal, Preferences, Profile, Recipe } from './types'
import { SLOT_LABEL } from './types'
import { addMacros, kcalTarget, macroShares, mealMacros, recipeMacros, ZERO, type Macros, type OilChoice } from './nutrition'
import { chooseOils, fitWeight, macroTarget, recipeViolation, softStyles, styleFit } from './rules'
import { FACTOR_MAX, FACTOR_MIN, PREF_MAX, PREF_MIN, maxPlausibleFactor } from './plausibility'
import type { MacroGoals } from './types'
import type { MacroShare } from './diets'

export { FACTOR_MAX, FACTOR_MIN, PREF_MAX, PREF_MIN }

export const PERIODS = [
  { days: 7, label: '1 Woche' }, { days: 14, label: '2 Wochen' }, { days: 21, label: '3 Wochen' }, { days: 30, label: '1 Monat' },
] as const

/**
 * Toleranzen für die Tages-Kalorienabweichung:
 *  - ≤ 3 %  „erreicht“: Portionen werden in 5-%-Schritten (0,05) skaliert, das entspricht je Mahlzeit ca. 1–2 % Gesamtenergie;
 *    außerdem unterliegen Nährwertdaten selbst Schwankungen von mehreren Prozent – engere Ziele wären Scheingenauigkeit.
 *  - 3–5 %  Hinweis
 *  - > 5 %  Warnung, > 10 % Fehler
 */
export const TOL_OK = 3
export const TOL_WARN = 5
export const TOL_ERROR = 10
const STEP = 0.05
const TOP_BY_SCORE = 4
const TOP_BY_KCAL = 2

export interface PlanContext {
  foods: Map<string, Food>
  recipes: Map<string, Recipe>
  oils: OilChoice
  oilNotes: string[]
  prefs: Preferences
  eligible: Recipe[]
  rejected: Map<string, string>
  /** Obere plausible Portionsgrenze je Rezept */
  maxFactor: Map<string, number>
  /** Basisnährwerte (1 Portion, aufgelöstes Öl) je Rezept */
  base: Map<string, Macros>
}

export function buildContext(foodList: Food[], recipeList: Recipe[], prefs: Preferences): PlanContext {
  const foods = new Map(foodList.map(f => [f.id, f]))
  const recipes = new Map(recipeList.map(r => [r.id, r]))
  const { oils, notes } = chooseOils(foodList, prefs)
  const eligible: Recipe[] = []
  const rejected = new Map<string, string>()
  const maxFactor = new Map<string, number>()
  const base = new Map<string, Macros>()
  for (const r of recipeList) {
    const v = recipeViolation(r, foods, prefs, oils)
    if (v) rejected.set(r.id, v)
    else eligible.push(r)
    maxFactor.set(r.id, maxPlausibleFactor(r, foods, oils))
    base.set(r.id, recipeMacros(r, foods, oils))
  }
  return { foods, recipes, oils, oilNotes: notes, prefs, eligible, rejected, maxFactor, base }
}

export function slotsFor(mealCount: 3 | 4 | 5): { slot: MealSlot; share: number }[] {
  if (mealCount === 3) return [{ slot: 'fruehstueck', share: 0.25 }, { slot: 'mittag', share: 0.4 }, { slot: 'abend', share: 0.35 }]
  if (mealCount === 4) return [{ slot: 'fruehstueck', share: 0.25 }, { slot: 'mittag', share: 0.35 }, { slot: 'snack', share: 0.1 }, { slot: 'abend', share: 0.3 }]
  return [{ slot: 'fruehstueck', share: 0.22 }, { slot: 'snack', share: 0.08 }, { slot: 'mittag', share: 0.32 }, { slot: 'snack', share: 0.08 }, { slot: 'abend', share: 0.3 }]
}

const round2 = (n: number) => Math.round(n * 100) / 100
const clamp = (f: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, f))
const snap = (f: number, lo = FACTOR_MIN, hi = FACTOR_MAX) => round2(clamp(Math.round(f / STEP) * STEP, lo, hi))

export function factorFor(r: Recipe, targetKcal: number, ctx: PlanContext): number {
  const k = ctx.base.get(r.id)?.kcal ?? 0
  const hi = ctx.maxFactor.get(r.id) ?? FACTOR_MAX
  return k > 0 ? snap(targetKcal / k, FACTOR_MIN, Math.floor(hi / STEP) * STEP) : 1
}

/** Seeded PRNG (mulberry32) – nur für winzige Tie-Breaker, damit „Neu generieren“ Alternativen liefert. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

const PERISHABLE = new Set(['gemuese', 'obst', 'fleisch', 'fisch', 'milch'])

interface ScoreEnv { recent: Map<string, number>; counts: Map<string, number>; yesterdayKeys: Set<string>; recentFresh: Set<string> }

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

/** Portionsunabhängige Bewertung: Präferenzen, Ernährungsweisen, Vielfalt, Verschwendung, Verfügbarkeit. */
export function baseScore(r: Recipe, ctx: PlanContext, env: ScoreEnv): number {
  const m = ctx.base.get(r.id)!
  if (m.kcal <= 0) return -Infinity
  let s = 0
  const ing = r.ingredients.filter(i => !i.foodId.startsWith('oil:'))
  const prefHits = ing.filter(i => ctx.prefs.preferredFoods.includes(i.foodId)).length
  const favHits = ing.filter(i => ctx.prefs.favoriteFoods.includes(i.foodId)).length
  s += 3.6 * (prefHits / Math.max(1, ing.length)) + 1.0 * (favHits / Math.max(1, ing.length)) + (r.favorite ? 0.8 : 0)
  for (const st of softStyles(ctx.prefs.styles)) s += fitWeight(st) * styleFit(r, st, ctx.foods, ctx.oils)
  const last = env.recent.get(r.id)
  if (last !== undefined) s -= 5 * Math.max(0, 1 - last / 6)
  s -= 0.25 * (env.counts.get(r.id) ?? 0)
  if (env.yesterdayKeys.has(mainKey(r, ctx))) s -= 0.7
  const overlap = new Set(ing.filter(i => { const f = ctx.foods.get(i.foodId); return f && PERISHABLE.has(f.category) && env.recentFresh.has(i.foodId) }).map(i => i.foodId)).size
  s += 0.2 * Math.min(3, overlap)
  s -= 0.3 * ing.filter(i => ctx.foods.get(i.foodId)?.special).length
  return s
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

/**
 * Löst die Portionsfaktoren f_i so, dass Σ f_i·b_i = T gilt und Σ (f_i − 1)² minimal ist (Lagrange),
 * unter den Schranken lo_i ≤ f_i ≤ hi_i (Active-Set: geklemmte Variablen werden fixiert und der Rest neu gelöst).
 */
export function solvePortions(b: number[], lo: number[], hi: number[], T: number): number[] {
  const n = b.length
  const f = new Array<number>(n).fill(1)
  const fixed = new Array<boolean>(n).fill(false)
  for (let it = 0; it <= n; it++) {
    let fixedSum = 0, sumB = 0, sumB2 = 0
    for (let i = 0; i < n; i++) { if (fixed[i]) fixedSum += f[i] * b[i]; else { sumB += b[i]; sumB2 += b[i] * b[i] } }
    if (sumB2 === 0) break
    const mu = (T - fixedSum - sumB) / sumB2
    let clamped = false
    for (let i = 0; i < n; i++) {
      if (fixed[i]) continue
      const v = 1 + mu * b[i]
      if (v < lo[i]) { f[i] = lo[i]; fixed[i] = true; clamped = true } else if (v > hi[i]) { f[i] = hi[i]; fixed[i] = true; clamped = true } else f[i] = v
    }
    if (!clamped) break
  }
  return f
}

interface Cand { r: Recipe; score: number; b: number; lo: number; hi: number; m: Macros }

/** Feinjustierung der Tagessumme in 0,05er-Schritten (innerhalb der Rezeptgrenzen). */
function fineTune(meals: PlannedMeal[], target: number, ctx: PlanContext) {
  for (let it = 0; it < 60; it++) {
    const cur = dayKcal(meals, ctx)
    const dev = Math.abs(cur - target)
    if (dev / target < 0.004) return
    let bm = -1, bf = 0, bd = dev
    meals.forEach((m, idx) => {
      const base = ctx.base.get(m.recipeId)?.kcal ?? 0
      const hi = Math.floor((ctx.maxFactor.get(m.recipeId) ?? FACTOR_MAX) / STEP + 1e-9) * STEP
      for (const d of [STEP, -STEP]) {
        const nf = round2(m.factor + d)
        if (nf < FACTOR_MIN - 1e-9 || nf > hi + 1e-9) continue
        const nd = Math.abs(cur + d * base - target)
        if (nd < bd - 1e-9) { bd = nd; bm = idx; bf = nf }
      }
    })
    if (bm < 0) return
    meals[bm] = { ...meals[bm], factor: bf }
  }
}

function pickCandidates(slot: MealSlot, slotTarget: number, ctx: PlanContext, env: ScoreEnv, used: Set<string>, rand: () => number, focus?: MacroShare): Cand[] {
  const all: Cand[] = []
  for (const r of ctx.eligible) {
    if (!r.slots.includes(slot) || used.has(r.id)) continue
    const m = ctx.base.get(r.id)!
    const sc = baseScore(r, ctx, env)
    if (!Number.isFinite(sc)) continue
    all.push({ r, score: sc + rand() * 0.15, b: m.kcal, lo: FACTOR_MIN, hi: ctx.maxFactor.get(r.id) ?? FACTOR_MAX, m })
  }
  const byScore = [...all].sort((a, b) => b.score - a.score).slice(0, TOP_BY_SCORE)
  const rest = all.filter(c => !byScore.includes(c)).sort((a, b) => Math.abs(a.b - slotTarget) - Math.abs(b.b - slotTarget)).slice(0, TOP_BY_KCAL)
  // Bei ausdrücklich gesetzten Makrozielen: zusätzlich die Rezepte, deren Energieverteilung dem Ziel am nächsten kommt
  const near = focus
    ? all.filter(c => !byScore.includes(c) && !rest.includes(c)).map(c => { const sh = macroShares(c.m); return { c, d: Math.abs(sh.protein - focus.protein) + Math.abs(sh.carbs - focus.carbs) + Math.abs(sh.fat - focus.fat) } }).sort((a, b) => a.d - b.d).slice(0, 3).map(x => x.c)
    : []
  return [...byScore, ...rest, ...near]
}

/** Wählt für einen Tag die beste Kombination aus Kandidaten und berechnet die Portionen. */
function solveDay(slots: { slot: MealSlot; share: number }[], T: number, ctx: PlanContext, env: ScoreEnv, rand: () => number, tgt: MacroShare, custom = false): PlannedMeal[] {
  const used = new Set<string>()
  const pools = slots.map(({ slot, share }) => pickCandidates(slot, T * share, ctx, env, used, rand, custom ? tgt : undefined))
  if (pools.some(p => p.length === 0)) {
    // Unvollständig lösbar: Slots ohne Kandidaten werden übersprungen, Rest wird einzeln gelöst.
    const ok = pools.map((p, i) => ({ p, i })).filter(x => x.p.length)
    if (!ok.length) return []
    return solveSubset(ok.map(x => slots[x.i]), ok.map(x => x.p), T, ctx, tgt, custom)
  }
  return solveSubset(slots, pools, T, ctx, tgt, custom)
}

function solveSubset(slots: { slot: MealSlot; share: number }[], pools: Cand[][], T: number, ctx: PlanContext, tgt: MacroShare, custom = false): PlannedMeal[] {
  const n = pools.length
  const idx = new Array<number>(n).fill(0)
  const holder: { best: { obj: number; pick: Cand[]; f: number[] } | null } = { best: null }
  const lo = new Array<number>(n), hi = new Array<number>(n), b = new Array<number>(n)
  const flexi = ctx.prefs.styles.includes('flexitarisch')
  const rec = (k: number) => {
    if (k === n) {
      const pick = idx.map((j, i) => pools[i][j])
      if (new Set(pick.map(c => c.r.id)).size < n) return
      for (let i = 0; i < n; i++) { b[i] = pick[i].b; lo[i] = pick[i].lo; hi[i] = pick[i].hi }
      const f = solvePortions(b, lo, hi, T)
      let total = 0, P = 0, C = 0, Fa = 0, pen = 0, sc = 0, meat = 0
      for (let i = 0; i < n; i++) {
        total += f[i] * b[i]; P += f[i] * pick[i].m.protein; C += f[i] * pick[i].m.carbs; Fa += f[i] * pick[i].m.fat; sc += pick[i].score
        pen += 0.6 * (f[i] - 1) ** 2 + 2.5 * (Math.max(0, PREF_MIN - f[i]) + Math.max(0, f[i] - PREF_MAX))
        if (flexi && pick[i].m.protein > 0 && ctx.foods && pick[i].r.ingredients.some(x => ctx.foods.get(x.foodId)?.animal === 'meat')) meat++
      }
      const dev = Math.abs(total - T) / T
      const e = P * 4 + C * 4 + Fa * 9
      const macroDev = e > 0 ? (Math.abs((P * 400) / e - tgt.protein) + Math.abs((C * 400) / e - tgt.carbs) + Math.abs((Fa * 900) / e - tgt.fat)) / 100 : 1
      const obj = sc - pen - 60 * dev - (custom ? 14 : 2.0) * macroDev - (flexi && meat > 1 ? 1.5 * (meat - 1) : 0)
      if (!holder.best || obj > holder.best.obj) holder.best = { obj, pick: [...pick], f }
      return
    }
    for (let j = 0; j < pools[k].length; j++) { idx[k] = j; rec(k + 1) }
  }
  rec(0)
  const best = holder.best
  if (!best) return []
  const meals: PlannedMeal[] = best.pick.map((c, i) => ({
    id: newMealId(), slot: slots[i].slot, recipeId: c.r.id,
    factor: snap(best.f[i], FACTOR_MIN, Math.floor(c.hi / STEP + 1e-9) * STEP),
  }))
  fineTune(meals, T, ctx)
  return meals
}

/** Tagesziel eines Datums: einmaliges Tagesziel, sonst das dauerhafte Planziel. */
export const targetFor = (plan: Pick<Plan, 'kcalTarget' | 'dayTargets'>, date: string): number => plan.dayTargets?.[date] ?? plan.kcalTarget

/**
 * Energieanteile aus eigenen Makrozielen (Gramm) – fehlende Anteile folgen proportional der Ernährungsweise.
 * Ohne Makroziele: undefined (es gilt das Ziel der Ernährungsweise).
 */
export function effectiveMacroShare(goals: MacroGoals | undefined, styles: string[], kcal: number): MacroShare | undefined {
  if (!goals || (goals.proteinG === undefined && goals.carbsG === undefined && goals.fatG === undefined) || kcal <= 0) return undefined
  const base = macroTarget(styles)
  const set: Partial<MacroShare> = {}
  if (goals.proteinG !== undefined) set.protein = (goals.proteinG * 4 * 100) / kcal
  if (goals.carbsG !== undefined) set.carbs = (goals.carbsG * 4 * 100) / kcal
  if (goals.fatG !== undefined) set.fat = (goals.fatG * 9 * 100) / kcal
  const fixed = Object.values(set).reduce((a, b) => a + b, 0)
  const missing = (['protein', 'carbs', 'fat'] as const).filter(k => set[k] === undefined)
  const rest = Math.max(0, 100 - fixed), baseSum = missing.reduce((a, k) => a + base[k], 0) || 1
  const out = { ...base, ...set } as MacroShare
  for (const k of missing) out[k] = (rest * base[k]) / baseSum
  const sum = out.protein + out.carbs + out.fat
  return { protein: (out.protein * 100) / sum, carbs: (out.carbs * 100) / sum, fat: (out.fat * 100) / sum }
}

interface Hist { recent: Map<string, number>; counts: Map<string, number>; yesterdayKeys: Set<string>; freshByDay: Set<string>[] }
const newHist = (): Hist => ({ recent: new Map(), counts: new Map(), yesterdayKeys: new Set(), freshByDay: [] })
const beginDay = (h: Hist) => { for (const [k, v] of h.recent) h.recent.set(k, v + 1) }
const envOf = (h: Hist): ScoreEnv => { const d = h.freshByDay.length; return { recent: h.recent, counts: h.counts, yesterdayKeys: h.yesterdayKeys, recentFresh: new Set([...(h.freshByDay[d - 1] ?? []), ...(h.freshByDay[d - 2] ?? [])]) } }
function endDay(h: Hist, meals: PlannedMeal[], ctx: PlanContext) {
  const fresh = new Set<string>()
  h.yesterdayKeys = new Set<string>()
  for (const m of meals) {
    const r = ctx.recipes.get(m.recipeId)
    if (!r) continue
    h.recent.set(r.id, 0); h.counts.set(r.id, (h.counts.get(r.id) ?? 0) + 1)
    h.yesterdayKeys.add(mainKey(r, ctx)); r.ingredients.forEach(i => fresh.add(i.foodId))
  }
  h.freshByDay.push(fresh)
}

/**
 * Löst einen Tag. Mit `escalate` werden bei unerreichbarem Ziel schrittweise Zwischenmahlzeiten (bis 5 Mahlzeiten) ergänzt –
 * z. B. bei einem einmaligen Tagesziel von 4.000 kcal.
 */
function solveWithEscalation(T: number, mealCount: 3 | 4 | 5, ctx: PlanContext, env: ScoreEnv, rand: () => number, tgt: MacroShare, escalate: boolean, custom = false): { meals: PlannedMeal[]; mealCount: 3 | 4 | 5 } {
  const devOf = (m: PlannedMeal[]) => (m.length ? Math.abs(dayKcal(m, ctx) - T) / T : 1)
  let best = solveDay(slotsFor(mealCount), T, ctx, env, rand, tgt, custom), used = mealCount
  if (!escalate || devOf(best) <= TOL_OK / 100) return { meals: best, mealCount: used }
  for (let mc = mealCount + 1; mc <= 5; mc++) {
    const cand = solveDay(slotsFor(mc as 4 | 5), T, ctx, env, rand, tgt, custom)
    if (devOf(cand) < devOf(best) - 1e-9) { best = cand; used = mc as 4 | 5 }
    if (devOf(best) <= TOL_OK / 100) break
  }
  return { meals: best, mealCount: used }
}

export function generatePlan(input: GenerateInput & { dayTargets?: Record<string, number> }): Plan {
  const { profile, prefs } = input
  const ctx = buildContext(input.foods, input.recipes, prefs)
  const target = kcalTarget(profile)
  const rand = rng(input.seed ?? 1)
  const macroShare = effectiveMacroShare(profile.macroGoals, prefs.styles, target)
  const tgt = macroShare ?? macroTarget(prefs.styles)
  const h = newHist()
  const days: PlanDay[] = []
  for (let d = 0; d < input.days; d++) {
    const date = addDays(input.startDate, d), T = input.dayTargets?.[date] ?? target
    beginDay(h)
    const { meals } = solveWithEscalation(T, profile.mealCount, ctx, envOf(h), rand, tgt, input.dayTargets?.[date] !== undefined, !!macroShare)
    endDay(h, meals, ctx)
    days.push({ date, meals })
  }
  return {
    id: `plan-${Date.now().toString(36)}`, createdAt: new Date().toISOString(), startDate: input.startDate,
    days, oils: ctx.oils, kcalTarget: target, persons: profile.persons,
    ...(input.dayTargets && Object.keys(input.dayTargets).length ? { dayTargets: input.dayTargets } : {}), ...(macroShare ? { macroShare } : {}),
  }
}

export interface RegenResult { plan: Plan; notes: string[]; mealCounts: Record<string, number> }
/**
 * Berechnet einzelne Tage neu (mit Historie der Nachbartage für Vielfalt/Reste). Neue Tagesziele in `overrideTargets`
 * werden als einmalige Tagesziele im Plan gespeichert; das dauerhafte Planziel bleibt unverändert.
 */
export function regenerateDays(plan: Plan, ctx: PlanContext, mealCount: 3 | 4 | 5, dates: string[], opts: { seed?: number; overrideTargets?: Record<string, number> } = {}): RegenResult {
  const want = new Set(dates)
  const dayTargets = { ...(plan.dayTargets ?? {}), ...(opts.overrideTargets ?? {}) }
  const rand = rng(opts.seed ?? 7)
  const tgt = plan.macroShare ?? macroTarget(ctx.prefs.styles)
  const h = newHist(), notes: string[] = [], mealCounts: Record<string, number> = {}
  const days: PlanDay[] = []
  const lastIdx = Math.max(...plan.days.map((d, i) => (want.has(d.date) ? i : -1)))
  plan.days.forEach((d, i) => {
    if (i > lastIdx) { days.push(d); return }
    beginDay(h)
    if (!want.has(d.date)) { endDay(h, d.meals, ctx); days.push(d); return }
    const T = dayTargets[d.date] ?? plan.kcalTarget
    const r = solveWithEscalation(T, mealCount, ctx, envOf(h), rand, tgt, dayTargets[d.date] !== undefined, !!plan.macroShare)
    endDay(h, r.meals, ctx); mealCounts[d.date] = r.mealCount
    if (r.mealCount > mealCount) notes.push(`${d.date}: Für ${Math.round(T)} kcal wurden ${r.mealCount - mealCount} zusätzliche Zwischenmahlzeit(en) eingeplant (${r.mealCount} Mahlzeiten).`)
    const dev = r.meals.length ? ((dayKcal(r.meals, ctx) - T) / T) * 100 : 100
    if (Math.abs(dev) > TOL_WARN) notes.push(`${d.date}: Das Ziel von ${Math.round(T)} kcal ist mit den vorhandenen Rezepten nur auf ${Math.abs(dev).toFixed(0)} % genau erreichbar.`)
    days.push({ date: d.date, meals: r.meals })
  })
  return { plan: { ...plan, days, ...(Object.keys(dayTargets).length ? { dayTargets } : {}) }, notes, mealCounts }
}

/** Alternativen für einen Slot, nach Score und Kalorienpassung sortiert (für „Mahlzeit austauschen“). */
export function alternativesFor(slot: MealSlot, targetKcal: number, ctx: PlanContext, excludeIds: string[] = [], limit = 8): { recipe: Recipe; factor: number; kcal: number }[] {
  const env: ScoreEnv = { recent: new Map(), counts: new Map(), yesterdayKeys: new Set(), recentFresh: new Set() }
  return ctx.eligible
    .filter(r => r.slots.includes(slot) && !excludeIds.includes(r.id))
    .map(r => {
      const factor = factorFor(r, targetKcal, ctx)
      const kcal = (ctx.base.get(r.id)?.kcal ?? 0) * factor
      return { r, factor, kcal, s: baseScore(r, ctx, env) - 4 * (Math.abs(kcal - targetKcal) / Math.max(1, targetKcal)) - 0.6 * Math.abs(factor - 1) }
    })
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(({ r, factor, kcal }) => ({ recipe: r, factor, kcal }))
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
  const issues: PlanIssue[] = []
  const days: DayTotals[] = plan.days.map(d => {
    const macros = dayTotals(d, ctx), target = targetFor(plan, d.date)
    return { date: d.date, macros, devPct: ((macros.kcal - target) / target) * 100 }
  })
  const tgt = plan.macroShare ?? macroTarget(ctx.prefs.styles)
  const nonEmpty = days.filter(d => d.macros.kcal > 0)
  const calScore = days.length ? days.reduce((s, d) => s + Math.max(0, 100 - 20 * Math.abs(d.devPct)), 0) / days.length : 0
  const macScore = nonEmpty.length ? nonEmpty.reduce((s, d) => {
    const sh = macroShares(d.macros)
    return s + Math.max(0, 100 - 2.5 * (Math.abs(sh.protein - tgt.protein) + Math.abs(sh.carbs - tgt.carbs) + Math.abs(sh.fat - tgt.fat)))
  }, 0) / nonEmpty.length : 0

  const meals = plan.days.flatMap(d => d.meals)
  const soft = softStyles(ctx.prefs.styles)
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

  const bySlot = new Map<MealSlot, string[]>()
  for (const d of plan.days) for (const m of d.meals) bySlot.set(m.slot, [...(bySlot.get(m.slot) ?? []), m.recipeId])
  let vs = 0, vn = 0
  for (const [slot, ids] of bySlot) {
    const pool = ctx.eligible.filter(r => r.slots.includes(slot)).length
    const possible = Math.max(1, Math.min(ids.length, pool))
    vs += Math.min(1, new Set(ids).size / possible); vn++
  }
  const varScore = vn ? (vs / vn) * 100 : 0

  let close = 0
  plan.days.forEach((d, i) => {
    const prev = new Set(plan.days.slice(Math.max(0, i - 3), i).flatMap(x => x.meals.map(m => m.recipeId)))
    d.meals.forEach(m => { if (prev.has(m.recipeId)) close++ })
  })
  const repScore = meals.length ? Math.max(0, 100 - (close / meals.length) * 300) : 0

  let ingN = 0, special = 0
  for (const m of meals) for (const i of ctx.recipes.get(m.recipeId)?.ingredients ?? []) { ingN++; if (ctx.foods.get(i.foodId)?.special) special++ }
  const availScore = ingN ? (1 - special / ingN) * 100 : 100

  const parts = { kalorien: calScore, makros: macScore, praeferenzen: prefScore, vielfalt: varScore, wiederholungen: repScore, verfuegbarkeit: availScore }
  const total = 0.3 * calScore + 0.15 * macScore + 0.2 * prefScore + 0.15 * varScore + 0.1 * repScore + 0.1 * availScore

  const slotsNeeded = new Set(plan.days.flatMap(d => d.meals.map(m => m.slot)))
  for (const s of ['fruehstueck', 'mittag', 'abend'] as MealSlot[]) {
    if (!ctx.eligible.some(r => r.slots.includes(s)))
      issues.push({ level: 'error', text: `Für „${SLOT_LABEL[s]}“ gibt es mit deinen Einstellungen kein passendes Rezept. Der Plan ist unvollständig.` })
  }
  if (mealCount >= 4 && !slotsNeeded.has('snack') && !ctx.eligible.some(r => r.slots.includes('snack')))
    issues.push({ level: 'error', text: 'Für Zwischenmahlzeiten gibt es mit deinen Einstellungen kein passendes Rezept.' })
  const off = days.filter(d => Math.abs(d.devPct) > TOL_WARN)
  if (off.length) {
    const worst = off.reduce((a, b) => (Math.abs(b.devPct) > Math.abs(a.devPct) ? b : a))
    issues.push({ level: off.some(d => Math.abs(d.devPct) > TOL_ERROR) ? 'error' : 'warn', text: `An ${off.length} von ${days.length} Tagen weicht die Kalorienzufuhr um mehr als ${TOL_WARN} % vom Ziel ab (max. ${worst.devPct > 0 ? '+' : ''}${worst.devPct.toFixed(0)} %). Mit den verfügbaren Rezepten und plausiblen Portionen ist das Ziel nicht exakter erreichbar. Mehr Mahlzeiten pro Tag oder zusätzliche Rezepte helfen.` })
  } else if (days.some(d => Math.abs(d.devPct) > TOL_OK)) {
    issues.push({ level: 'info', text: `An einzelnen Tagen liegt die Abweichung zwischen ${TOL_OK} % und ${TOL_WARN} %.` })
  }
  const outside = meals.filter(m => m.factor < PREF_MIN - 1e-9 || m.factor > PREF_MAX + 1e-9).length
  if (meals.length && outside / meals.length > 0.2)
    issues.push({ level: 'warn', text: `${outside} von ${meals.length} Mahlzeiten liegen außerhalb des empfohlenen Portionsbereichs (${PREF_MIN}×–${PREF_MAX}×). Das Kalorienziel passt nur eingeschränkt zu den vorhandenen Rezepten.` })
  const bad = new Set<string>()
  for (const m of meals) { const v = ctx.rejected.get(m.recipeId); if (v) bad.add(`${ctx.recipes.get(m.recipeId)?.name}: ${v}`) }
  for (const b of bad) issues.push({ level: 'error', text: `Plan verletzt aktuelle Einstellungen – ${b}. Bitte Mahlzeit austauschen oder Plan neu generieren.` })
  for (const n of ctx.oilNotes) issues.push({ level: 'warn', text: n })
  if (ctx.prefs.styles.includes('keto') && nonEmpty.length) {
    const avg = nonEmpty.reduce((s, d) => s + (d.macros.carbs * 4 * 100) / d.macros.kcal, 0) / nonEmpty.length
    if (avg > 10) issues.push({ level: 'warn', text: `Keto: Netto-Kohlenhydrate im Durchschnitt ${avg.toFixed(0)} % der Energie (Orientierung ≤ 10 %).` })
  }
  if (repScore < 70) issues.push({ level: 'info', text: 'Wegen weniger passender Rezepte kommt es zu häufigen Wiederholungen. Mehr Lebensmittel zu erlauben oder eigene Rezepte zu ergänzen erhöht die Vielfalt.' })
  return { score: { total, parts }, issues, days }
}
