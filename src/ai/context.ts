/**
 * Nutrition-Context-Service (Frontend-Seite): erzeugt für JEDE Anfrage den minimal nötigen Kontext.
 *  - Sicherheitsrelevantes (Ernährungsweisen, Allergien/Unverträglichkeiten, Ausschlüsse) wird immer gesendet, damit die KI keine unzulässigen Vorschläge macht.
 *  - Alles andere nur, wenn der Nutzer es freigegeben hat UND die Frage es tatsächlich braucht.
 *  - Keine Namen, E-Mail-Adressen oder Freitexte außer vom Nutzer selbst benannten Lebensmitteln/Rezepten.
 */
import type { AppState } from '../domain/types'
import { ALLERGEN_LABEL, STYLE_LABEL, type Style } from '../domain/types'
import { dayTotals, type PlanContext } from '../domain/planner'
import { mealMacros } from '../domain/nutrition'
import { foodViolation } from '../domain/rules'
import { macroTargetFor } from '../domain/diets'
import { analyzeGaps } from '../domain/nutrients'
import { GOAL_LABEL } from '../pages/forms'
import type { NutritionContextPayload } from './types'

export interface Scope { body: boolean; plan: boolean; planDays: number; recipes: boolean; foods: boolean; shopping: boolean; progress: boolean; gaps: boolean }

const has = (t: string, rx: RegExp) => rx.test(t.toLowerCase())

/** Bestimmt anhand der Nutzerfrage, welche Datenbereiche überhaupt relevant sind. */
export function scopeFor(text: string): Scope {
  const wk = has(text, /woche|7 tage|wochenplan/), now = has(text, /heute|morgen|gestern|\btag\b/)
  const planish = has(text, /plan|mahlzeit|frühstück|fruehstueck|mittag|abend|snack|zwischenmahlzeit|tausch|ersetz|statt|alternativ|woche|heute|morgen|abwechslung|variier|kalorien|makro|eiweiß|kohlenhydrat|fett/)
  return {
    body: has(text, /kalorie|gewicht|bmi|abnehm|zunehm|grundumsatz|bedarf|energie|größe|alter|ziel/),
    plan: planish,
    planDays: wk ? 7 : now ? 2 : 3,
    recipes: has(text, /tausch|ersetz|statt|alternativ|vorschlag|rezept|idee|anders|schlag.*vor|abwechslung|hinzufüg|ergänz/),
    foods: has(text, /rezept.*(erstell|entwirf|kreier|bau)|neues rezept|erstelle.*rezept|aus .*zutaten|zutaten|koch(e|en) mit|verfügbar|vorrat/),
    shopping: has(text, /einkauf|kaufen|liste/),
    progress: has(text, /fortschritt|gewicht|verlauf|abnahme|zunahme|erfolg|einhaltung|plan.*(eingehalten|geschafft)/),
    gaps: has(text, /nährstoff|naehrstoff|vitamin|mineral|lücke|luecke|mangel|b12|eisen|calcium|zink|magnesium|ballaststoff|versorg/),
  }
}

/** Mahlzeitenart, auf die sich die Frage bezieht (falls genannt). */
export function slotHint(text: string): 'fruehstueck' | 'mittag' | 'abend' | 'snack' | null {
  const t = text.toLowerCase()
  return /frühstück|fruehstueck/.test(t) ? 'fruehstueck' : /mittag/.test(t) ? 'mittag' : /abend/.test(t) ? 'abend' : /snack|zwischenmahlzeit/.test(t) ? 'snack' : null
}

export interface BuiltContext { payload: NutritionContextPayload; included: string[]; json: string; chars: number; scope: Scope }

const nm = (s: AppState, id: string) => s.foods.find(f => f.id === id)?.name ?? id

export function buildAiContext(state: AppState, ctx: PlanContext, text: string, today: string, kcalTarget: number): BuiltContext {
  const sh = state.ai.share
  const sc = scopeFor(text)
  const included: string[] = []
  const payload: NutritionContextPayload = {}
  const p = state.prefs

  // --- immer: Sicherheit und Regeln
  payload.diets = p.styles.map(x => STYLE_LABEL[x as Style] ?? x)
  payload.custom_rules = [...p.customRules.filter(r => r.enabled).map(r => `${r.name}: ${String(r.value)}`)]
  if (p.restrictions.some(r => r.severity === 'allergy') && p.strictTraces) payload.custom_rules = [...(payload.custom_rules as string[]), 'Bei Allergien auch mögliche Spuren ausschließen']
  payload.restrictions = p.restrictions.map(r => ({ allergen: ALLERGEN_LABEL[r.allergen], severity: r.severity }))
  payload.excluded_terms = [...p.customExclusions]
  payload.excluded_foods = p.excludedFoods.map(id => nm(state, id)).slice(0, 100)
  included.push('Ernährungsweisen', 'Allergien & Unverträglichkeiten', 'Ausschlüsse')

  // --- Ziele (grob)
  const mt = macroTargetFor(p.styles)
  payload.macro_targets = { protein_pct: mt.protein, carbs_pct: mt.carbs, fat_pct: mt.fat }
  const profile: Record<string, unknown> = { goal: GOAL_LABEL[state.profile.goal], kcal_target: Math.round(kcalTarget), meal_count: state.profile.mealCount, persons: state.profile.persons }
  included.push('Kalorienziel & Makroziele', 'Ernährungsziel')
  if (sh.body && sc.body) { profile.age = state.profile.age; profile.height_cm = state.profile.heightCm; profile.weight_kg = state.profile.weightKg; included.push('Alter, Größe, Gewicht') }
  payload.profile = profile

  if (sh.foodPrefs) {
    payload.preferred_foods = p.preferredFoods.map(id => nm(state, id)).slice(0, 100)
    const o = p.oils; const oil = (id: string | null) => (id ? nm(state, id) : null)
    payload.oils = { main: oil(o.main), warm: oil(ctx.oils.warm), cold: oil(ctx.oils.cold) }
    included.push('Lebensmittelpräferenzen & Öle')
  }

  // --- Plan-Ausschnitt
  if (sh.plan && sc.plan && state.plan && state.plan.days.length) {
    const days = state.plan.days
    const idx = Math.max(0, days.findIndex(d => d.date >= today))
    const slice = days.slice(idx, idx + sc.planDays)
    payload.plan = {
      kcal_target: Math.round(state.plan.kcalTarget),
      days: slice.map(d => ({
        date: d.date, total_kcal: Math.round(dayTotals(d, ctx).kcal),
        meals: d.meals.map(m => { const r = ctx.recipes.get(m.recipeId); const x = mealMacros(m, ctx.recipes, ctx.foods, ctx.oils)
          return { meal_id: m.id, slot: m.slot, recipe_id: m.recipeId, recipe_name: r?.name ?? '?', factor: m.factor, kcal: Math.round(x.kcal), protein: Math.round(x.protein), carbs: Math.round(x.carbs), fat: Math.round(x.fat) } }),
      })),
    }
    included.push(`Ernährungsplan (${slice.length} Tag${slice.length === 1 ? '' : 'e'})`)
    // Katalog nur zulässiger Rezepte (Allergien/Regeln bereits berücksichtigt) – die KI kann nur daraus wählen
    if (sc.recipes) {
      // Die in der Frage genannte Mahlzeitenart steht zuerst (bis zu 40 Rezepte), danach die übrigen Arten gemischt –
      // so bleiben die relevantesten Rezepte im Zeichenbudget.
      const hint = slotHint(text)
      const seen = new Set<string>(), cat: object[] = []
      const push = (r: (typeof ctx.eligible)[number]) => { if (seen.has(r.id) || cat.length >= 80) return; seen.add(r.id); const b = ctx.base.get(r.id)!
        cat.push({ id: r.id, name: r.name, slots: r.slots, kcal: Math.round(b.kcal), protein: Math.round(b.protein), carbs: Math.round(b.carbs), fat: Math.round(b.fat) }) }
      if (hint) ctx.eligible.filter(r => r.slots.includes(hint)).slice(0, 40).forEach(push)
      const bySlot = new Map<string, typeof ctx.eligible>()
      for (const r of ctx.eligible) for (const sl of r.slots) bySlot.set(sl, [...(bySlot.get(sl) ?? []), r])
      for (let i = 0; cat.length < 80; i++) { let any = false; for (const list of bySlot.values()) if (list[i]) { any = true; push(list[i]) } if (!any) break }
      payload.recipe_catalog = cat
      included.push(`zulässige Rezepte (${cat.length})`)
    }
  }
  if (sc.foods) {
    payload.food_catalog = state.foods.filter(f => !foodViolation(f, p) && f.dataQuality !== 'missing').map(f => f.name).slice(0, 250)
    included.push('Liste erlaubter Lebensmittel')
  }
  if (sh.shopping && sc.shopping && state.plan) {
    const rows: { name: string; grams: number }[] = []
    for (const d of state.plan.days) for (const m of d.meals) for (const i of ctx.recipes.get(m.recipeId)?.ingredients ?? []) {
      const f = ctx.foods.get(i.foodId === 'oil:warm' ? ctx.oils.warm ?? '' : i.foodId === 'oil:cold' ? ctx.oils.cold ?? '' : i.foodId); if (!f) continue
      const r = rows.find(x => x.name === f.name); const g = i.grams * m.factor * state.profile.persons
      r ? (r.grams += g) : rows.push({ name: f.name, grams: g })
    }
    payload.shopping = rows.slice(0, 100).map(r => ({ name: r.name, grams: Math.round(r.grams) }))
    included.push('Einkaufsliste')
  }
  if (sh.progress && sc.progress) {
    payload.progress = { weights: [...state.weights].sort((a, b) => a.date.localeCompare(b.date)).slice(-60) }
    included.push('Gewichtsverlauf')
  }
  if (sc.gaps && state.plan) {
    const rep = analyzeGaps(state.plan, ctx, state.profile, p)
    payload.nutrient_gaps = rep.rows.filter(r => r.status !== 'ok').slice(0, 30).map(r => ({ nutrient: r.label, status: r.status === 'unknown' ? 'Datenlage unzureichend' : r.status === 'low' ? 'niedrig' : 'knapp', note: `${Math.round(r.pct)} % des Orientierungswerts` }))
    included.push('Nährstoffbilanz')
  }
  const json = JSON.stringify(payload, null, 2)
  return { payload, included, json, chars: json.length, scope: sc }
}
