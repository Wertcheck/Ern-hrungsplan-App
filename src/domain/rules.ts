import type { Allergen, CustomRule, Food, FoodGroup, Ingredient, Preferences, Recipe } from './types'
import { ALLERGEN_LABEL, GROUP_LABEL, OIL_COLD, OIL_WARM } from './types'
import { ingredientsMacros, resolveIngredients, type Macros, type OilChoice } from './nutrition'
import { analyzeCombination, getDiet, macroTargetFor, type DietContext } from './diets'

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

/** Laktose, Fruktose, Histamin sind Unverträglichkeiten, keine Allergien – werden bei „Allergie“ trotzdem strikt behandelt. */
export const INTOLERANCE_ONLY: Allergen[] = ['laktose', 'fruktose', 'histamin']

export function ruleViolation(rule: CustomRule, f: Food): string | null {
  if (!rule.enabled) return null
  const v = String(rule.value)
  if (rule.kind === 'exclude_group' && f.group === v) return `${f.name} (${GROUP_LABEL[f.group as FoodGroup] ?? f.group}) – eigene Regel „${rule.name}“`
  if (rule.kind === 'exclude_category' && f.category === v) return `${f.name} – eigene Regel „${rule.name}“`
  if (rule.kind === 'exclude_term') { const t = norm(v.trim()); if (t && norm(f.name).includes(t)) return `${f.name} – eigene Regel „${rule.name}“` }
  return null
}

/** Gibt den Grund zurück, warum ein Lebensmittel nicht erlaubt ist, sonst null. Allergien haben stets Vorrang. */
export function foodViolation(food: Food, prefs: Preferences): string | null {
  for (const r of prefs.restrictions) {
    const label = ALLERGEN_LABEL[r.allergen]
    if (r.severity === 'allergy') {
      if (!food.allergenInfoKnown) return `${food.name}: Allergeninformation unbekannt (Sicherheitsausschluss wegen Allergie „${label}“)`
      if (food.allergens.includes(r.allergen)) return `${food.name} enthält ${label} (Allergie)`
      if (prefs.strictTraces && (food.traces ?? []).includes(r.allergen)) return `${food.name}: mögliche Spuren (${label}) – Allergie, strenge Spurenregel`
    } else if (food.allergens.includes(r.allergen)) return `${food.name} enthält ${label} (Unverträglichkeit)`
  }
  if (prefs.excludedFoods.includes(food.id)) return `${food.name} ist ausgeschlossen`
  const nm = norm(food.name)
  for (const term of prefs.customExclusions) {
    const t = norm(term.trim())
    if (t && nm.includes(t)) return `${food.name} entspricht dem Ausschluss „${term}“`
  }
  for (const r of prefs.customRules) { const v = ruleViolation(r, food); if (v) return v }
  for (const s of prefs.styles) { const v = getDiet(s)?.foodRule?.(food); if (v) return v }
  return null
}

export function isPlaceholder(id: string) { return id === OIL_WARM || id === OIL_COLD }

/** Wählt das Öl für warme und kalte Zubereitung entsprechend Vorlieben, Ausschlüssen, Ernährungsweisen und Allergien. */
export function chooseOils(foods: Food[], prefs: Preferences): { oils: OilChoice; notes: string[] } {
  const o = prefs.oils
  const notes: string[] = []
  const all = foods.filter(f => f.category === 'oele' && f.oil)
  const allowed = all.filter(f => !o.excluded.includes(f.id) && !foodViolation(f, prefs))
  const pick = (role: 'warm' | 'cold'): string | null => {
    const ok = (f: Food) => (role === 'warm' ? f.oil!.warmOk : f.oil!.coldOk)
    const cand = allowed.filter(ok)
    const explicit = o[role] ? cand.find(f => f.id === o[role]) : undefined
    if (explicit) return explicit.id
    const main = o.main ? cand.find(f => f.id === o.main) : undefined
    if (main) return main.id
    for (const id of o.preferred) { const f = cand.find(x => x.id === id); if (f) return f.id }
    const fb = [...cand].sort((a, b) => (b.oil!.smokePointC ?? 0) - (a.oil!.smokePointC ?? 0))[0]
    if (fb) notes.push(`Kein bevorzugtes Öl für ${role === 'warm' ? 'warme' : 'kalte'} Zubereitung geeignet – ${fb.name} wird ersatzweise verwendet.`)
    else notes.push(`Kein erlaubtes Öl für ${role === 'warm' ? 'warme' : 'kalte'} Zubereitung verfügbar.`)
    return fb?.id ?? null
  }
  return { oils: { warm: pick('warm'), cold: pick('cold') }, notes }
}

function customRecipeViolation(r: CustomRule, m: Macros): string | null {
  if (!r.enabled || m.kcal <= 0) return null
  const e = m.protein * 4 + m.carbs * 4 + m.fat * 9
  const v = Number(r.value)
  if (r.kind === 'max_carb_pct' && (m.carbs * 400) / e > v) return `Kohlenhydrate ${Math.round((m.carbs * 400) / e)} % > ${v} % (eigene Regel „${r.name}“)`
  if (r.kind === 'min_protein_pct' && (m.protein * 400) / e < v) return `Eiweiß ${Math.round((m.protein * 400) / e)} % < ${v} % (eigene Regel „${r.name}“)`
  if (r.kind === 'max_fat_pct' && (m.fat * 900) / e > v) return `Fett ${Math.round((m.fat * 900) / e)} % > ${v} % (eigene Regel „${r.name}“)`
  return null
}

/** Prüft ein Rezept; null = zulässig. Öl-Platzhalter werden mit dem gewählten Öl aufgelöst. */
export function recipeViolation(r: Recipe, foods: Map<string, Food>, prefs: Preferences, oils: OilChoice): string | null {
  const resolved: Ingredient[] = []
  for (const i of r.ingredients) {
    let id = i.foodId
    if (id === OIL_WARM) { if (!oils.warm) return 'Kein geeignetes Öl für warme Zubereitung'; id = oils.warm }
    else if (id === OIL_COLD) { if (!oils.cold) return 'Kein geeignetes Öl für kalte Zubereitung'; id = oils.cold }
    const f = foods.get(id)
    if (!f) return `Unbekannte Zutat (${id})`
    const v = foodViolation(f, prefs)
    if (v) return v
    resolved.push({ foodId: id, grams: i.grams })
  }
  const m = ingredientsMacros(resolved, foods)
  const ctx: DietContext = { foods, oils }
  for (const s of prefs.styles) { const v = getDiet(s)?.recipeRule?.(m, resolved, ctx); if (v) return v }
  for (const c of prefs.customRules) { const v = customRecipeViolation(c, m); if (v) return v }
  return null
}

export type SafetyStatus = 'ok' | 'traces' | 'unknown' | 'contains'
export interface AllergenStatus {
  /** Bekannte Allergene laut Lebensmitteldaten */
  allergens: Allergen[]
  /** Mögliche Spuren laut Lebensmitteldaten (Näherung) */
  traces: Allergen[]
  /** true, sobald eine Zutat keine verlässliche Allergeninformation hat */
  unknown: boolean
  unknownFoods: string[]
}
export function allergenStatus(ings: Ingredient[], foods: Map<string, Food>): AllergenStatus {
  const set = new Set<Allergen>(), tr = new Set<Allergen>(), unk: string[] = []
  for (const i of ings) {
    const f = foods.get(i.foodId)
    if (!f) { unk.push(i.foodId); continue }
    if (!f.allergenInfoKnown) unk.push(f.name)
    f.allergens.forEach(a => set.add(a))
    ;(f.traces ?? []).forEach(a => tr.add(a))
  }
  return { allergens: [...set], traces: [...tr].filter(a => !set.has(a)), unknown: unk.length > 0, unknownFoods: unk }
}

/**
 * Sicherheitsstatus bezüglich der Nutzer-Restriktionen. „ok“ bedeutet NUR: laut hinterlegten Daten kein Treffer –
 * keine Garantie der Allergenfreiheit (Datenlücken, Spuren und Herstellungsprozesse sind nicht vollständig erfasst).
 */
export function safetyFor(ings: Ingredient[], foods: Map<string, Food>, prefs: Preferences): { status: SafetyStatus; reasons: string[] } {
  const st = allergenStatus(ings, foods)
  const reasons: string[] = []
  let status: SafetyStatus = 'ok'
  for (const r of prefs.restrictions) {
    if (st.allergens.includes(r.allergen)) { status = 'contains'; reasons.push(`Enthält ${ALLERGEN_LABEL[r.allergen]}`) }
  }
  if (status !== 'contains' && st.unknown && prefs.restrictions.length) { status = 'unknown'; reasons.push(`Keine Allergeninformation: ${st.unknownFoods.join(', ')}`) }
  if (status === 'ok') {
    for (const r of prefs.restrictions) if (st.traces.includes(r.allergen)) { status = 'traces'; reasons.push(`Mögliche Spuren von ${ALLERGEN_LABEL[r.allergen]}`) }
  }
  return { status, reasons }
}

export function recipeAnimalProfile(ings: Ingredient[], foods: Map<string, Food>) {
  let meat = false, fish = false, other = false
  for (const i of ings) {
    const f = foods.get(i.foodId)
    if (!f) continue
    if (f.animal === 'meat') meat = true
    else if (f.animal === 'fish') fish = true
    else if (f.animal !== 'none') other = true
  }
  return { meat, fish, other }
}

/** Passung eines Rezepts zu einer Ernährungsweise (0..1); Weisen ohne weiche Regel liefern 1. */
export function styleFit(r: Recipe, style: string, foods: Map<string, Food>, oils: OilChoice): number {
  const d = getDiet(style)
  if (!d?.fit) return 1
  const resolved = resolveIngredients(r.ingredients, oils)
  return d.fit(r, ingredientsMacros(resolved, foods), { foods, oils })
}

/** Ernährungsweisen mit weicher Bewertung (Gewicht > 0) unter den gewählten. */
export const softStyles = (styles: string[]) => styles.filter(s => !!getDiet(s)?.fit)
export const fitWeight = (style: string) => getDiet(style)?.fitWeight ?? 1.5
export const macroTarget = (styles: string[]) => macroTargetFor(styles)

export interface PrefsAnalysis { conflicts: string[]; tensions: string[]; infos: string[]; other: string[] }
export function analyzePrefs(prefs: Preferences): PrefsAnalysis {
  const c = analyzeCombination(prefs.styles)
  const other: string[] = []
  const both = prefs.preferredFoods.filter(id => prefs.excludedFoods.includes(id))
  if (both.length) other.push('Einige Lebensmittel sind gleichzeitig bevorzugt und ausgeschlossen (Ausschluss hat Vorrang).')
  if (prefs.restrictions.some(r => r.allergen === 'nuesse' && r.severity === 'allergy') && prefs.preferredFoods.some(id => ['walnuss', 'mandeln', 'haselnuss', 'macadamia'].includes(id)))
    other.push('Nussallergie und bevorzugte Nüsse widersprechen sich (Allergie hat Vorrang).')
  if (prefs.oils.main && prefs.oils.excluded.includes(prefs.oils.main)) other.push('Das Hauptöl ist gleichzeitig ausgeschlossen (Ausschluss hat Vorrang).')
  for (const r of prefs.restrictions) if (r.severity === 'allergy' && INTOLERANCE_ONLY.includes(r.allergen))
    other.push(`${ALLERGEN_LABEL[r.allergen]} ist medizinisch meist eine Unverträglichkeit; als „Allergie“ markiert wird es besonders streng behandelt (auch unbekannte Zutaten und Spuren).`)
  const ks = prefs.customRules.filter(r => r.enabled && r.kind === 'max_carb_pct')
  if (ks.length && prefs.customRules.some(r => r.enabled && r.kind === 'min_protein_pct' && Number(r.value) + Number(ks[0].value) > 100))
    other.push('Eigene Regeln (maximale Kohlenhydrate / minimales Eiweiß) lassen sich rechnerisch kaum gemeinsam erfüllen.')
  return { ...c, other }
}

/** Alle Hinweise als Liste (Kompatibilität / einfache Anzeige). */
export function detectConflicts(prefs: Preferences): string[] {
  const a = analyzePrefs(prefs)
  return [...a.conflicts, ...a.tensions, ...a.infos, ...a.other]
}
