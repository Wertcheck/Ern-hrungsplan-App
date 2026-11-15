/**
 * Action Engine – einzige Stelle, an der Assistenten-Befehle (Text, Sprache, KI) den App-Zustand verändern.
 *   parse → validieren (Schema + Geschäftsregeln + Engine) → Klasse A/B → Vorschau → [Bestätigung] → anwenden → Änderungsprotokoll (Undo)
 * Die deterministische Ernährungs-Engine rechnet alles; Eingaben werden nie als Rechenergebnis übernommen.
 * Klasse C (nicht delegierbar): Allergien/Unverträglichkeiten, medizinische Entscheidungen – es gibt dafür bewusst KEINE Aktion.
 */
import { z } from 'zod'
import type { AppState, Food, MealSlot, Profile, Recipe, Style } from '../domain/types'
import { SLOT_LABEL, STYLE_LABEL } from '../domain/types'
import { buildContext, dayTotals, effectiveMacroShare, regenerateDays, targetFor } from '../domain/planner'
import { kcalTarget, ingredientsMacros } from '../domain/nutrition'
import { profileSchema, foodInputSchema } from '../domain/schemas'
import { analyzePrefs, foodViolation, recipeViolation } from '../domain/rules'
import { getDiet } from '../domain/diets'
import { aggregate } from '../domain/shopping'
import { MEAL_CAP_G } from '../domain/plausibility'
import { recordChange, undoLast } from '../domain/changelog'
import { normalize } from '../domain/bls'
import { confirmProposal, findFood, validateProposal } from './actions'

export type ActionClass = 'A' | 'B'
export const localToday = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10) }

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const STYLES = Object.keys(STYLE_LABEL) as [Style, ...Style[]]
const reason = z.string().max(300).optional()
const ing = z.object({ food_name: z.string().min(1).max(200), grams: z.number().min(0.1).max(3000) })
const slot = z.enum(['fruehstueck', 'mittag', 'abend', 'snack'])

export const newSchemas = [
  z.object({ type: z.literal('update_calorie_target'), kcal: z.number().min(800).max(6000), scope: z.enum(['today', 'date', 'permanent']), date: date.optional(), reason }),
  z.object({ type: z.literal('update_macros'), protein_g: z.number().min(0).max(600).optional(), carbs_g: z.number().min(0).max(1000).optional(), fat_g: z.number().min(0).max(500).optional(), reset: z.boolean().optional(), reason }),
  z.object({ type: z.literal('update_nutrition_goal'), goal: z.enum(['halten', 'reduzieren', 'aufbauen', 'ausgewogen']), reason }),
  z.object({ type: z.literal('update_activity_level'), activity: z.enum(['sitzend', 'leicht', 'moderat', 'hoch']), reason }),
  z.object({ type: z.literal('update_user_profile'), age: z.number().optional(), height_cm: z.number().optional(), weight_kg: z.number().optional(), sex: z.enum(['f', 'm', 'd']).optional(), persons: z.number().optional(), meal_count: z.number().optional(), reason }),
  z.object({ type: z.literal('update_weight'), kg: z.number().min(30).max(300), date: date.optional(), reason }),
  z.object({ type: z.literal('update_target_weight'), kg: z.number().min(30).max(300), reason }),
  z.object({ type: z.literal('add_food'), name: z.string().min(1).max(80), category: z.string().max(30).optional(), per100: z.object({ kcal: z.number(), protein: z.number(), carbs: z.number(), fat: z.number(), fiber: z.number().optional() }), user_stated: z.literal(true), reason }),
  z.object({ type: z.literal('remove_food'), food_name: z.string().min(1).max(200), reason }),
  z.object({ type: z.literal('update_food_preferences'), food_name: z.string().min(1).max(200), preference: z.enum(['favorite', 'unfavorite', 'preferred', 'not_preferred', 'excluded', 'allowed']), reason }),
  z.object({ type: z.literal('set_diets'), styles: z.array(z.enum(STYLES)).min(1).max(8), mode: z.enum(['set', 'add', 'remove']), reason }),
  z.object({ type: z.literal('regenerate_plan'), scope: z.enum(['day', 'week', 'month']), date: date.optional(), reason }),
  z.object({ type: z.literal('update_recipe'), recipe_name: z.string().min(1).max(120), name: z.string().min(1).max(80).optional(), slots: z.array(slot).min(1).max(4).optional(), ingredients: z.array(ing).min(1).max(30).optional(), steps: z.array(z.string().max(300)).max(15).optional(), reason }),
  z.object({ type: z.literal('update_shopping_list'), op: z.enum(['add', 'remove', 'check', 'uncheck']), name: z.string().min(1).max(200), amount: z.string().max(60).optional(), reason }),
] as const
const newSchema = z.discriminatedUnion('type', [...newSchemas])
export type NewProposal = z.infer<typeof newSchema>
const OLD_TYPES = ['swap_meal', 'add_meal', 'remove_meal', 'set_portion', 'create_recipe', 'exclude_food', 'add_shopping_item'] as const
/** Alternative Bezeichnungen der Vorgabe */
const ALIAS: Record<string, string> = { replace_meal: 'swap_meal', update_meal_portion: 'set_portion', add_excluded_food: 'exclude_food', add_preferred_food: 'update_food_preferences', regenerate_day_plan: 'regenerate_plan', regenerate_week_plan: 'regenerate_plan', regenerate_month_plan: 'regenerate_plan' }

export interface Preview { title: string; lines: string[]; warnings: string[] }
export type Evaluation = { ok: true; cls: ActionClass; preview: Preview; next: AppState } | { ok: false; reason: string }
const no = (reason: string): Evaluation => ({ ok: false, reason })
const kcal = (n: number) => `${Math.round(n)} kcal`

export function normalizeRaw(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw
  const o = { ...(raw as Record<string, unknown>) }
  const t = String(o.type ?? '')
  if (ALIAS[t]) {
    if (t === 'add_preferred_food') o.preference = 'preferred'
    if (t === 'regenerate_day_plan') o.scope = 'day'
    if (t === 'regenerate_week_plan') o.scope = 'week'
    if (t === 'regenerate_month_plan') o.scope = 'month'
    o.type = ALIAS[t]
  }
  return o
}

export const classOf = (p: { type: string; preference?: string }): ActionClass =>
  ['set_portion', 'add_shopping_item', 'update_shopping_list', 'update_weight', 'update_target_weight', 'exclude_food'].includes(p.type) || (p.type === 'update_food_preferences' && p.preference !== 'allowed') ? 'A' : 'B'

// -------------------------------------------------------------------- Hilfen
const shoppingDiff = (before: AppState, after: AppState): string | null => {
  if (!before.plan || !after.plan) return null
  const cb = buildContext(before.foods, before.recipes, before.prefs), ca = buildContext(after.foods, after.recipes, after.prefs)
  const a = aggregate(before.plan, cb.recipes, cb.foods, cb.oils, before.plan.persons), b = aggregate(after.plan, ca.recipes, ca.foods, ca.oils, after.plan.persons)
  let neu = 0, weg = 0, geaendert = 0
  for (const [k, v] of b) { const o = a.get(k); if (o === undefined) neu++; else if (Math.abs(v - o) > Math.max(5, o * 0.03)) geaendert++ }
  for (const k of a.keys()) if (!b.has(k)) weg++
  return neu || weg || geaendert ? `Einkaufsliste wird aktualisiert: ${neu} neue, ${weg} entfallende Zutat(en), ${geaendert} geänderte Mengen` : null
}

/** Berechnet den Plan ab `from` neu (z. B. nach neuem dauerhaftem Ziel, Ernährungsweise oder Profiländerung). */
function regenFrom(state: AppState, from: string, mealCount: 3 | 4 | 5, planPatch: Partial<NonNullable<AppState['plan']>> = {}): { state: AppState; notes: string[]; days: number } {
  if (!state.plan) return { state, notes: [], days: 0 }
  const plan = { ...state.plan, ...planPatch }
  if ('macroShare' in planPatch && planPatch.macroShare === undefined) delete plan.macroShare
  const ctx = buildContext(state.foods, state.recipes, state.prefs)
  const dates = plan.days.filter(d => d.date >= from).map(d => d.date)
  if (!dates.length) return { state: { ...state, plan }, notes: [], days: 0 }
  const r = regenerateDays(plan, ctx, mealCount, dates)
  return { state: { ...state, plan: r.plan }, notes: r.notes, days: dates.length }
}

const dayLine = (s: AppState, ctx: ReturnType<typeof buildContext>, d: string) => { const day = s.plan?.days.find(x => x.date === d); return day ? dayTotals(day, ctx).kcal : 0 }

/** Retarget: nach Profiländerung neues Ziel bestimmen und ggf. den Plan ab heute neu rechnen (Vergangenheit bleibt unverändert). */
function applyProfile(state: AppState, newProfile: Profile, today: string): { state: AppState; notes: string[]; lines: string[] } {
  const lines: string[] = [], oldT = kcalTarget(state.profile), newT = kcalTarget(newProfile)
  const next: AppState = { ...state, profile: newProfile }
  if (!state.plan) return { state: next, notes: [], lines }
  const share = effectiveMacroShare(newProfile.macroGoals, state.prefs.styles, newT)
  const need = newT !== state.plan.kcalTarget || newProfile.mealCount !== state.profile.mealCount || JSON.stringify(share) !== JSON.stringify(state.plan.macroShare)
  if (!need) return { state: { ...next, plan: { ...state.plan, persons: newProfile.persons } }, notes: [], lines }
  const r = regenFrom(next, today, newProfile.mealCount, { kcalTarget: newT, persons: newProfile.persons, macroShare: share })
  if (newT !== oldT) lines.push(`Dauerhaftes Kalorienziel: ${kcal(oldT)} → ${kcal(newT)}`)
  lines.push(`${r.days} Tag(e) ab heute werden neu berechnet (vergangene Tage bleiben unverändert)`)
  return { state: r.state, notes: r.notes, lines }
}

const validateName = (s: string, max = 80) => s.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)

// -------------------------------------------------------------------- Auswertung
export function evaluate(raw: unknown, state: AppState, today: string = localToday()): Evaluation {
  const n = normalizeRaw(raw) as { type?: string }
  const t = String(n?.type ?? '')
  if ((OLD_TYPES as readonly string[]).includes(t)) {
    const ctx = buildContext(state.foods, state.recipes, state.prefs)
    const v = validateProposal(n, state, ctx)
    if (!v.ok) return no(v.reason)
    const r = confirmProposal(n, state)
    if (!r.ok) return no(r.reason)
    const warnings = [...v.preview.warnings]
    const sd = shoppingDiff(state, r.state); if (sd) v.preview.lines.push(sd)
    return { ok: true, cls: classOf(n as { type: string }), preview: { title: v.preview.title, lines: v.preview.lines, warnings }, next: r.state }
  }
  const parsed = newSchema.safeParse(n)
  if (!parsed.success) return no('Ungültiger oder nicht erlaubter Aktionstyp')
  const p = parsed.data
  const ctx = buildContext(state.foods, state.recipes, state.prefs)
  const plan = state.plan
  switch (p.type) {
    case 'update_calorie_target': {
      if (p.scope === 'permanent') {
        if (p.kcal < 1200 || p.kcal > 4500) return no('Das dauerhafte Kalorienziel muss zwischen 1.200 und 4.500 kcal liegen')
        const cur = kcalTarget(state.profile)
        const np: Profile = { ...state.profile, kcalMode: 'manual', kcalManual: Math.round(p.kcal) }
        const r = applyProfile(state, np, today)
        const dev = ((p.kcal - cur) / cur) * 100
        const warnings = [...r.notes]
        if (Math.abs(dev) > 25) warnings.unshift(`Auffällige Abweichung: ${dev > 0 ? '+' : ''}${dev.toFixed(0)} % gegenüber dem bisherigen Ziel`)
        if (p.kcal < 1500) warnings.push('Sehr niedrige Energiezufuhr nur mit ärztlicher Begleitung')
        const sd = shoppingDiff(state, r.state)
        return { ok: true, cls: 'B', next: r.state, preview: { title: 'Kalorienziel dauerhaft ändern', lines: [...r.lines, ...(sd ? [sd] : [])], warnings } }
      }
      const d = p.scope === 'today' ? today : p.date
      if (!d) return no('Für ein einmaliges Ziel wird ein Datum benötigt')
      if (!plan) return no('Es gibt noch keinen Plan')
      if (!plan.days.some(x => x.date === d)) return no(`${d} liegt nicht im Plan (${plan.days[0].date} – ${plan.days.at(-1)!.date})`)
      if (p.kcal < 1000 || p.kcal > 6000) return no('Ein einmaliges Tagesziel muss zwischen 1.000 und 6.000 kcal liegen')
      const cur = targetFor(plan, d), before = dayLine(state, ctx, d)
      const r = regenerateDays(plan, ctx, state.profile.mealCount, [d], { overrideTargets: { [d]: Math.round(p.kcal) } })
      const next: AppState = { ...state, plan: r.plan }
      const after = dayLine(next, ctx, d), dev = ((p.kcal - plan.kcalTarget) / plan.kcalTarget) * 100
      const warnings = [...r.notes.map(x => x.replace(/^\d{4}-\d{2}-\d{2}: /, ''))]
      if (Math.abs(dev) > 25) warnings.unshift(`Auffällige Abweichung: ${dev > 0 ? '+' : ''}${dev.toFixed(0)} % gegenüber deinem dauerhaften Ziel (${kcal(plan.kcalTarget)})`)
      if (p.kcal > 4500) warnings.push('Ungewöhnlich hohe Energiezufuhr – nur bewusst und einmalig verwenden')
      const sd = shoppingDiff(state, next)
      return { ok: true, cls: 'B', next, preview: { title: `Tagesziel für ${d === today ? 'heute' : d} (einmalig)`, lines: [`Tagesziel: ${kcal(cur)} → ${kcal(p.kcal)}  (dein dauerhaftes Ziel ${kcal(plan.kcalTarget)} bleibt unverändert)`, `Tagessumme geplant: ${kcal(before)} → ${kcal(after)}`, `Mahlzeiten: ${state.plan!.days.find(x => x.date === d)!.meals.length} → ${next.plan!.days.find(x => x.date === d)!.meals.length}`, ...(sd ? [sd] : [])], warnings } }
    }
    case 'update_macros': {
      const goals = p.reset ? undefined : { ...state.profile.macroGoals, ...(p.protein_g !== undefined ? { proteinG: p.protein_g } : {}), ...(p.carbs_g !== undefined ? { carbsG: p.carbs_g } : {}), ...(p.fat_g !== undefined ? { fatG: p.fat_g } : {}) }
      if (!p.reset && p.protein_g === undefined && p.carbs_g === undefined && p.fat_g === undefined) return no('Es wurde kein Makroziel angegeben')
      const T = kcalTarget(state.profile)
      if (goals) {
        const e = (goals.proteinG ?? 0) * 4 + (goals.carbsG ?? 0) * 4 + (goals.fatG ?? 0) * 9
        if (e > T * 1.25) return no(`Die Makroziele ergeben ${kcal(e)} und übersteigen das Kalorienziel (${kcal(T)}) um mehr als 25 %`)
        if (goals.proteinG && (goals.proteinG * 4) / T > 0.6) return no('Ein Eiweißanteil von über 60 % der Energie wird nicht unterstützt')
      }
      const np: Profile = { ...state.profile }; if (goals) np.macroGoals = goals; else delete np.macroGoals
      const r = applyProfile(state, np, today), w = [...r.notes]
      if (goals && (goals.proteinG ?? 0) * 4 + (goals.carbsG ?? 0) * 4 + (goals.fatG ?? 0) * 9 < T * 0.75 && goals.proteinG !== undefined && goals.carbsG !== undefined && goals.fatG !== undefined) w.push('Die drei Makroziele ergeben deutlich weniger Energie als das Kalorienziel')
      return { ok: true, cls: 'B', next: r.state, preview: { title: p.reset ? 'Eigene Makroziele zurücksetzen' : 'Makroziele ändern', lines: [p.reset ? 'Makroziele folgen wieder der Ernährungsweise' : `Eiweiß ${goals?.proteinG ?? '–'} g · Kohlenhydrate ${goals?.carbsG ?? '–'} g · Fett ${goals?.fatG ?? '–'} g (fehlende Werte folgen der Ernährungsweise)`, ...r.lines], warnings: w } }
    }
    case 'update_nutrition_goal': case 'update_activity_level': case 'update_user_profile': {
      const patch: Partial<Profile> = p.type === 'update_nutrition_goal' ? { goal: p.goal } : p.type === 'update_activity_level' ? { activity: p.activity }
        : { ...(p.age !== undefined ? { age: p.age } : {}), ...(p.height_cm !== undefined ? { heightCm: p.height_cm } : {}), ...(p.weight_kg !== undefined ? { weightKg: p.weight_kg } : {}), ...(p.sex ? { sex: p.sex } : {}), ...(p.persons !== undefined ? { persons: p.persons } : {}), ...(p.meal_count !== undefined ? { mealCount: p.meal_count as 3 | 4 | 5 } : {}) }
      if (!Object.keys(patch).length) return no('Keine Änderung angegeben')
      const np = { ...state.profile, ...patch }
      const v = profileSchema.safeParse(np)
      if (!v.success) return no(`Ungültiger Wert: ${v.error.issues[0]?.message ?? 'außerhalb des zulässigen Bereichs'}`)
      const oldT = kcalTarget(state.profile), r = applyProfile(state, np, today)
      const lines = Object.entries(patch).map(([k, val]) => `${k}: ${String((state.profile as unknown as Record<string, unknown>)[k])} → ${String(val)}`)
      const warnings = [...r.notes]
      if (state.profile.kcalMode === 'auto' && kcalTarget(np) !== oldT) warnings.push(`Das automatisch geschätzte Kalorienziel ändert sich von ${kcal(oldT)} auf ${kcal(kcalTarget(np))}`)
      if (state.profile.kcalMode === 'manual') lines.push('Dein manuell gesetztes Kalorienziel bleibt unverändert')
      return { ok: true, cls: 'B', next: r.state, preview: { title: p.type === 'update_user_profile' ? 'Profil ändern' : p.type === 'update_nutrition_goal' ? 'Ernährungsziel ändern' : 'Aktivitätsniveau ändern', lines: [...lines, ...r.lines], warnings } }
    }
    case 'update_weight': {
      const d = p.date ?? today, last = [...state.weights].sort((a, b) => a.date.localeCompare(b.date)).at(-1)
      const warn = last && Math.abs(p.kg - last.kg) / last.kg > 0.05 ? [`Große Abweichung zum letzten Eintrag (${last.kg} kg) – bitte prüfen`] : []
      return { ok: true, cls: 'A', next: { ...state, weights: [...state.weights.filter(w => w.date !== d), { date: d, kg: p.kg }].sort((a, b) => a.date.localeCompare(b.date)) }, preview: { title: 'Gewicht eintragen', lines: [`${p.kg} kg am ${d} (Gewichtsverlauf; das Profilgewicht und damit das Kalorienziel bleiben unverändert)`], warnings: warn } }
    }
    case 'update_target_weight': return { ok: true, cls: 'A', next: { ...state, profile: { ...state.profile, targetWeightKg: p.kg } }, preview: { title: 'Zielgewicht', lines: [`Zielgewicht: ${state.profile.targetWeightKg ?? '–'} → ${p.kg} kg`], warnings: [] } }
    case 'add_food': {
      const name = validateName(p.name)
      const cat = (p.category ?? 'sonstige') as Food['category']
      const v = foodInputSchema.safeParse({ name, category: cat, kcal: p.per100.kcal, protein: p.per100.protein, carbs: p.per100.carbs, fat: p.per100.fat, fiber: p.per100.fiber ?? 0 })
      if (!v.success) return no(`Nährwerte abgelehnt: ${v.error.issues[0]?.message}`)
      if (state.foods.some(f => normalize(f.name) === normalize(name))) return no(`„${name}“ existiert bereits`)
      const food: Food = { id: `custom-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`, name, category: cat, kcal: p.per100.kcal, protein: p.per100.protein, carbs: p.per100.carbs, fat: p.per100.fat, fiber: p.per100.fiber ?? 0, allergens: [], traces: [], allergenInfoKnown: false, animal: 'unknown', group: 'sonstige', prep: 'zubereitet', source: 'Eigene Angabe (Sprache/Text)', dataQuality: 'user', custom: true }
      return { ok: true, cls: 'B', next: { ...state, foods: [...state.foods, food] }, preview: { title: 'Lebensmittel hinzufügen', lines: [`${name}: ${p.per100.kcal} kcal · E ${p.per100.protein} · KH ${p.per100.carbs} · F ${p.per100.fat} je 100 g (deine Angabe)`], warnings: ['Allergene und Herkunft sind unbekannt – das Lebensmittel wird bei Allergien/vegan/vegetarisch nicht verwendet, bis du es ergänzt'] } }
    }
    case 'remove_food': {
      const { food, error } = findFood(state.foods, p.food_name); if (!food) return no(error!)
      const inPlan = plan && plan.days.some(d => d.meals.some(m => ctx.recipes.get(m.recipeId)?.ingredients.some(i => i.foodId === food.id)))
      if (inPlan) return no(`${food.name} wird in Mahlzeiten deines Plans verwendet – tausche diese zuerst aus oder berechne den Plan neu`)
      const used = state.recipes.filter(r => r.ingredients.some(i => i.foodId === food.id))
      const rm = (a: string[]) => a.filter(x => x !== food.id)
      const next: AppState = { ...state, foods: state.foods.filter(f => f.id !== food.id), prefs: { ...state.prefs, favoriteFoods: rm(state.prefs.favoriteFoods), preferredFoods: rm(state.prefs.preferredFoods), excludedFoods: rm(state.prefs.excludedFoods) } }
      return { ok: true, cls: 'B', next, preview: { title: 'Lebensmittel entfernen', lines: [`${food.name} wird entfernt`], warnings: used.length ? [`${used.length} Rezept(e) verwenden dieses Lebensmittel und werden unbenutzbar: ${used.slice(0, 3).map(r => r.name).join(', ')}`] : [] } }
    }
    case 'update_food_preferences': {
      const { food, error } = findFood(state.foods, p.food_name); if (!food) return no(error!)
      const pr = state.prefs, ex = (a: string[], id: string) => a.filter(x => x !== id), add = (a: string[], id: string) => (a.includes(id) ? a : [...a, id])
      let np = pr, msg = ''
      if (p.preference === 'favorite') { np = { ...pr, favoriteFoods: add(pr.favoriteFoods, food.id) }; msg = 'zu Favoriten' }
      else if (p.preference === 'unfavorite') { np = { ...pr, favoriteFoods: ex(pr.favoriteFoods, food.id) }; msg = 'aus Favoriten entfernt' }
      else if (p.preference === 'preferred') { np = { ...pr, preferredFoods: add(pr.preferredFoods, food.id), excludedFoods: ex(pr.excludedFoods, food.id) }; msg = 'bevorzugt' }
      else if (p.preference === 'not_preferred') { np = { ...pr, preferredFoods: ex(pr.preferredFoods, food.id) }; msg = 'nicht mehr bevorzugt' }
      else if (p.preference === 'excluded') { np = { ...pr, excludedFoods: add(pr.excludedFoods, food.id), preferredFoods: ex(pr.preferredFoods, food.id), favoriteFoods: ex(pr.favoriteFoods, food.id) }; msg = 'ausgeschlossen' }
      else { np = { ...pr, excludedFoods: ex(pr.excludedFoods, food.id) }; msg = 'wieder erlaubt' }
      if (JSON.stringify(np) === JSON.stringify(pr)) return no(`${food.name} hat diese Einstellung bereits`)
      const warnings = p.preference === 'excluded' && plan ? ['Ein bestehender Plan wird auf Verstöße geprüft; zum Anwenden den Plan neu berechnen'] : []
      if (p.preference === 'allowed') { const v = foodViolation(food, { ...np }); if (v) return no(`Bleibt weiterhin gesperrt: ${v}`) }
      return { ok: true, cls: classOf(p), next: { ...state, prefs: np }, preview: { title: 'Lebensmittel-Einstellung', lines: [`${food.name}: ${msg}`], warnings } }
    }
    case 'set_diets': {
      const cur = state.prefs.styles.filter(s => s !== 'mischkost')
      let styles: Style[] = p.mode === 'set' ? [...p.styles] : p.mode === 'add' ? [...new Set([...cur, ...p.styles])] : cur.filter(s => !p.styles.includes(s))
      if (p.styles.includes('mischkost' as Style) && p.mode !== 'remove') styles = ['mischkost']
      else styles = styles.filter(s => s !== 'mischkost')
      if (!styles.length) styles = ['mischkost']
      const prefs = { ...state.prefs, styles }
      const a = analyzePrefs(prefs)
      if (a.conflicts.length) return no(`Unvereinbar: ${a.conflicts[0]}`)
      const c2 = buildContext(state.foods, state.recipes, prefs)
      for (const sl of ['fruehstueck', 'mittag', 'abend'] as const) if (!c2.eligible.some(r => r.slots.includes(sl))) return no(`Mit dieser Kombination bleibt kein Rezept für ${SLOT_LABEL[sl]} übrig`)
      const base = { ...state, prefs }
      const r = regenFrom(base, today, state.profile.mealCount)
      const sd = shoppingDiff(state, r.state)
      return { ok: true, cls: 'B', next: r.state, preview: { title: 'Ernährungsweise ändern', lines: [`Bisher: ${state.prefs.styles.map(s => STYLE_LABEL[s]).join(' + ')}`, `Neu: ${styles.map(s => STYLE_LABEL[s]).join(' + ')}`, ...styles.map(s => `${STYLE_LABEL[s]}: ${getDiet(s)?.summary ?? ''}`), ...(plan ? [`${r.days} Tag(e) ab heute werden nach den neuen Regeln neu berechnet`] : []), ...(sd ? [sd] : [])], warnings: [...a.tensions, ...a.infos, ...a.other, ...r.notes] } }
    }
    case 'regenerate_plan': {
      if (!plan) return no('Es gibt noch keinen Plan')
      const start = p.date ?? today
      const from = plan.days.findIndex(d => d.date >= start)
      if (from < 0) return no('Ab diesem Datum gibt es keine Plantage')
      const n = p.scope === 'day' ? 1 : p.scope === 'week' ? 7 : 30
      const dates = plan.days.slice(from, from + n).map(d => d.date)
      if (p.scope === 'day' && dates[0] !== start) return no(`${start} liegt nicht im Plan`)
      const r = regenerateDays(plan, ctx, state.profile.mealCount, dates, { seed: Date.now() % 100000 })
      const next = { ...state, plan: r.plan }, sd = shoppingDiff(state, next)
      return { ok: true, cls: 'B', next, preview: { title: p.scope === 'day' ? 'Tagesplan neu berechnen' : p.scope === 'week' ? 'Wochenplan neu berechnen' : 'Monatsplan neu berechnen', lines: [`${dates.length} Tag(e): ${dates[0]}${dates.length > 1 ? ` – ${dates.at(-1)}` : ''}`, 'Manuelle Änderungen an diesen Tagen werden ersetzt (rückgängig machbar)', ...(sd ? [sd] : [])], warnings: r.notes } }
    }
    case 'update_recipe': {
      const q = normalize(p.recipe_name)
      const cands = state.recipes.filter(r => normalize(r.name) === q || normalize(r.name).startsWith(q))
      if (cands.length !== 1) return no(cands.length ? `„${p.recipe_name}“ ist mehrdeutig` : `Rezept „${p.recipe_name}“ nicht gefunden`)
      const r0 = cands[0]
      if (!r0.custom) return no(`„${r0.name}“ ist ein Standardrezept und kann nicht verändert werden. Lege stattdessen ein eigenes Rezept an.`)
      let ingredients = r0.ingredients
      if (p.ingredients) {
        ingredients = []
        for (const i of p.ingredients) {
          const { food, error } = findFood(state.foods, i.food_name); if (!food) return no(error!)
          const v = foodViolation(food, state.prefs); if (v) return no(`${food.name}: ${v}`)
          const cap = food.category === 'getraenke' ? undefined : MEAL_CAP_G[food.group]; if (cap && i.grams > cap) return no(`${food.name}: ${i.grams} g überschreitet die plausible Höchstmenge von ${cap} g`)
          if (ingredients.some(x => x.foodId === food.id)) return no(`${food.name} ist doppelt aufgeführt`)
          ingredients.push({ foodId: food.id, grams: i.grams })
        }
      }
      const updated: Recipe = { ...r0, name: p.name ? validateName(p.name) : r0.name, slots: (p.slots as MealSlot[] | undefined) ?? r0.slots, ingredients, steps: p.steps ? p.steps.map(s => validateName(s, 300)).filter(Boolean) : r0.steps }
      const v = recipeViolation(updated, ctx.foods, state.prefs, ctx.oils); if (v) return no(`Verstößt gegen deine Regeln: ${v}`)
      const next: AppState = { ...state, recipes: state.recipes.map(r => (r.id === r0.id ? updated : r)) }
      const used = plan?.days.some(d => d.meals.some(m => m.recipeId === r0.id))
      const m0 = ingredientsMacros(r0.ingredients, ctx.foods), m1 = ingredientsMacros(ingredients, ctx.foods)
      return { ok: true, cls: 'B', next, preview: { title: 'Rezept ändern', lines: [`${r0.name}${updated.name !== r0.name ? ` → ${updated.name}` : ''}`, `Pro Portion (Engine): ${kcal(m0.kcal)} → ${kcal(m1.kcal)}`], warnings: used ? ['Das Rezept ist im Plan eingeplant – die Kalorien dieser Tage ändern sich'] : [] } }
    }
    case 'update_shopping_list': {
      const name = validateName(p.name, 80), nn = normalize(name)
      const sh = state.shopping
      const man = sh.manual.find(m => normalize(m.name) === nn)
      const food = man ? undefined : findFood(state.foods, name).food
      if (p.op === 'add') { if (man) return no(`„${man.name}“ steht schon auf der Liste`); return { ok: true, cls: 'A', next: { ...state, shopping: { ...sh, manual: [...sh.manual, { id: `ai-${Date.now().toString(36)}`, name, amount: validateName(p.amount ?? '', 40), checked: false }] } }, preview: { title: 'Zur Einkaufsliste', lines: [`${name}${p.amount ? ` (${p.amount})` : ''}`], warnings: [] } } }
      if (!man && !food) return no(`„${name}“ steht nicht auf der Einkaufsliste`)
      if (p.op === 'remove') return { ok: true, cls: 'A', next: { ...state, shopping: man ? { ...sh, manual: sh.manual.filter(m => m.id !== man.id) } : { ...sh, removed: [...new Set([...sh.removed, food!.id])] } }, preview: { title: 'Von der Einkaufsliste', lines: [`${man?.name ?? food!.name} entfernt`], warnings: [] } }
      const on = p.op === 'check'
      return { ok: true, cls: 'A', next: { ...state, shopping: man ? { ...sh, manual: sh.manual.map(m => (m.id === man.id ? { ...m, checked: on } : m)) } : { ...sh, checked: on ? [...new Set([...sh.checked, food!.id])] : sh.checked.filter(x => x !== food!.id) } }, preview: { title: on ? 'Abhaken' : 'Abhaken aufheben', lines: [man?.name ?? food!.name], warnings: [] } }
    }
  }
}

// -------------------------------------------------------------------- Batch, Anwenden, Undo
export interface BatchItem { raw: unknown; ev: Evaluation }
export interface BatchEvaluation { items: BatchItem[]; ok: boolean; cls: ActionClass; next: AppState }
/** Mehrfachaktionen werden nacheinander gegen den jeweils fortgeschriebenen Zustand geprüft (z. B. erst Makroziel, dann Tagesziel). */
export function evaluateBatch(raws: unknown[], state: AppState, today: string = localToday()): BatchEvaluation {
  let cur = state, ok = true, cls: ActionClass = 'A'
  const items: BatchItem[] = []
  for (const raw of raws) {
    const ev = evaluate(raw, cur, today)
    items.push({ raw, ev })
    if (ev.ok) { cur = ev.next; if (ev.cls === 'B') cls = 'B' } else ok = false
  }
  return { items, ok, cls, next: ok ? cur : state }
}

/** Führt eine bestätigte (oder direkte) Aktionsfolge aus: erneute Prüfung gegen den aktuellen Zustand, dann Protokoll-Eintrag (Undo). */
export function commit(raws: unknown[], state: AppState, source: 'user' | 'assistant', today: string = localToday()): { ok: true; state: AppState; label: string } | { ok: false; reason: string } {
  const b = evaluateBatch(raws, state, today)
  if (!b.ok) { const bad = b.items.find(i => !i.ev.ok)!.ev as { reason: string }; return { ok: false, reason: bad.reason } }
  const label = b.items.map(i => (i.ev as { preview: Preview }).preview.title).join(' + ')
  return { ok: true, state: recordChange(state, b.next, label, source), label }
}
export const undo = undoLast
