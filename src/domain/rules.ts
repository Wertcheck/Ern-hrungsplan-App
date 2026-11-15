import type { Allergen, Food, Ingredient, Preferences, Recipe, Style } from './types'
import { OIL_COLD, OIL_WARM } from './types'
import { macroShares, recipeMacros, type OilChoice } from './nutrition'

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

export const isVegan = (p: Preferences) => p.styles.includes('vegan')
export const isVegetarian = (p: Preferences) => p.styles.includes('vegan') || p.styles.includes('vegetarisch')

/** Gibt den Grund zurück, warum ein Lebensmittel für diese Einstellungen nicht erlaubt ist, sonst null. */
export function foodViolation(food: Food, prefs: Preferences): string | null {
  if (prefs.excludedFoods.includes(food.id)) return `${food.name} ist ausgeschlossen`
  const nm = norm(food.name)
  for (const term of prefs.customExclusions) {
    const t = norm(term.trim())
    if (t && nm.includes(t)) return `${food.name} entspricht dem Ausschluss „${term}“`
  }
  for (const r of prefs.restrictions) {
    if (r.severity === 'allergy' && !food.allergenInfoKnown)
      return `${food.name}: Allergeninformation unbekannt (Sicherheitsausschluss wegen Allergie)`
    if (food.allergens.includes(r.allergen))
      return `${food.name} enthält ${r.allergen} (${r.severity === 'allergy' ? 'Allergie' : 'Unverträglichkeit'})`
  }
  if (isVegan(prefs) && food.animal !== 'none') return `${food.name} ist nicht vegan`
  if (isVegetarian(prefs) && (food.animal === 'meat' || food.animal === 'fish')) return `${food.name} ist nicht vegetarisch`
  return null
}

export function isPlaceholder(id: string) { return id === OIL_WARM || id === OIL_COLD }

/** Wählt das Öl für warme und kalte Zubereitung entsprechend Vorlieben, Ausschlüssen und Eignung. */
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

/** Prüft ein Rezept; null = zulässig. Öl-Platzhalter werden mit dem gewählten Öl aufgelöst. */
export function recipeViolation(r: Recipe, foods: Map<string, Food>, prefs: Preferences, oils: OilChoice): string | null {
  for (const i of r.ingredients) {
    let id = i.foodId
    if (id === OIL_WARM) { if (!oils.warm) return 'Kein geeignetes Öl für warme Zubereitung'; id = oils.warm }
    else if (id === OIL_COLD) { if (!oils.cold) return 'Kein geeignetes Öl für kalte Zubereitung'; id = oils.cold }
    const f = foods.get(id)
    if (!f) return `Unbekannte Zutat (${id})`
    const v = foodViolation(f, prefs)
    if (v) return v
  }
  return null
}

export interface AllergenStatus { allergens: Allergen[]; unknown: boolean }
/** Bekannte Allergene eines Rezepts; unknown=true, sobald eine Zutat keine verlässliche Allergeninfo hat. */
export function allergenStatus(ings: Ingredient[], foods: Map<string, Food>): AllergenStatus {
  const set = new Set<Allergen>()
  let unknown = false
  for (const i of ings) {
    const f = foods.get(i.foodId)
    if (!f) { unknown = true; continue }
    if (!f.allergenInfoKnown) unknown = true
    f.allergens.forEach(a => set.add(a))
  }
  return { allergens: [...set], unknown }
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

/** Anteil (0..1) der Nicht-Öl-Zutaten (nach Gewicht), die als basisch-geeignet markiert sind. */
export function basicShare(r: Recipe, foods: Map<string, Food>): number {
  let tot = 0, b = 0
  for (const i of r.ingredients) {
    if (isPlaceholder(i.foodId)) continue
    const f = foods.get(i.foodId)
    if (!f) continue
    tot += i.grams
    if (f.basic) b += i.grams
  }
  return tot ? b / tot : 0
}

/** Wie gut ein Rezept zu einem Stil passt (0..1). */
export function styleFit(r: Recipe, style: Style, foods: Map<string, Food>, oils: OilChoice): number {
  switch (style) {
    case 'vegan': return recipeAnimalProfile(r.ingredients, foods).meat || recipeAnimalProfile(r.ingredients, foods).fish || recipeAnimalProfile(r.ingredients, foods).other ? 0 : 1
    case 'vegetarisch': { const a = recipeAnimalProfile(r.ingredients, foods); return a.meat || a.fish ? 0 : 1 }
    case 'basisch': return Math.min(1, (r.tags.includes('basisch') ? 0.4 : 0) + basicShare(r, foods) * 0.8)
    case 'mediterran': {
      const a = recipeAnimalProfile(r.ingredients, foods)
      let s = r.tags.includes('mediterran') ? 0.7 : 0.2
      if (a.meat) s -= 0.2
      if (a.fish) s += 0.15
      return Math.max(0, Math.min(1, s))
    }
    case 'lowcarb': { const sh = macroShares(recipeMacros(r, foods, oils)); return sh.carbs <= 25 ? 1 : sh.carbs >= 50 ? 0 : (50 - sh.carbs) / 25 }
    case 'highprotein': { const sh = macroShares(recipeMacros(r, foods, oils)); return sh.protein >= 30 ? 1 : sh.protein <= 15 ? 0 : (sh.protein - 15) / 15 }
    default: return 1
  }
}

/** Soft-Stile, die den Score beeinflussen (vegan/vegetarisch sind harte Regeln). */
export const SOFT_STYLES: Style[] = ['basisch', 'mediterran', 'lowcarb', 'highprotein']

export const MACRO_TARGETS: Record<'default' | 'lowcarb' | 'highprotein', { protein: number; carbs: number; fat: number }> = {
  default: { protein: 20, carbs: 50, fat: 30 },
  lowcarb: { protein: 25, carbs: 25, fat: 50 },
  highprotein: { protein: 30, carbs: 40, fat: 30 },
}
export function macroTarget(styles: Style[]) {
  if (styles.includes('lowcarb')) return MACRO_TARGETS.lowcarb
  if (styles.includes('highprotein')) return MACRO_TARGETS.highprotein
  return MACRO_TARGETS.default
}

/** Findet widersprüchliche Einstellungen. */
export function detectConflicts(prefs: Preferences): string[] {
  const out: string[] = []
  const s = prefs.styles
  if (s.includes('vegan') && s.includes('vegetarisch')) out.push('„Vegan“ und „Vegetarisch“ gewählt – es gilt die strengere Regel (vegan).')
  if (s.includes('vegan') && s.includes('mediterran')) out.push('Mediterran ist üblicherweise fisch- und milchbasiert; mit „Vegan“ bleiben nur pflanzliche Rezepte übrig.')
  if (s.includes('lowcarb') && s.includes('highprotein')) out.push('Low Carb und High Protein werden kombiniert: der Plan priorisiert Low Carb mit erhöhtem Eiweißanteil.')
  if (s.includes('vegan') && s.includes('highprotein')) out.push('Vegan + High Protein: der Eiweißanteil ist mit den vorhandenen Rezepten begrenzt.')
  const both = prefs.preferredFoods.filter(id => prefs.excludedFoods.includes(id))
  if (both.length) out.push('Einige Lebensmittel sind gleichzeitig bevorzugt und ausgeschlossen (Ausschluss hat Vorrang).')
  if (prefs.restrictions.some(r => r.allergen === 'nuesse' && r.severity === 'allergy') && prefs.preferredFoods.some(id => ['walnuss', 'mandeln', 'haselnuss'].includes(id)))
    out.push('Nussallergie und bevorzugte Nüsse widersprechen sich (Allergie hat Vorrang).')
  if (prefs.oils.main && prefs.oils.excluded.includes(prefs.oils.main)) out.push('Das Hauptöl ist gleichzeitig ausgeschlossen (Ausschluss hat Vorrang).')
  return out
}
