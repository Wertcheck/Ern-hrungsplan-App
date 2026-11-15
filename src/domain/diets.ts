/**
 * Modulare Ernährungsweisen. Jede Weise ist ein DietDef mit eigenen Regeln:
 *  - foodRule:   harte Regel auf Lebensmittelebene (Grund als Text oder null)
 *  - recipeRule: harte Regel auf Rezeptebene (aus aufgelösten Zutaten und Makros)
 *  - fit:        weiche Passung 0..1 für die Bewertung (Planer-Score)
 *  - macroTarget: Orientierung für die Energieverteilung (Priorität siehe MACRO_PRIORITY)
 * Neue Weisen: registerDiet({...}) – kein weiterer Code nötig.
 * Keine Weise wird als medizinisch überlegen dargestellt; `definition` beschreibt nur die in dieser App angewendeten Regeln.
 */
import type { Food, Ingredient, Recipe } from './types'
import type { Macros, OilChoice } from './nutrition'

export interface DietContext { foods: Map<string, Food>; oils: OilChoice }
export interface MacroShare { protein: number; carbs: number; fat: number }

export interface DietDef {
  id: string
  label: string
  summary: string
  /** Transparente Liste der angewendeten Regeln */
  definition: string[]
  foodRule?: (f: Food) => string | null
  recipeRule?: (m: Macros, ings: Ingredient[], ctx: DietContext) => string | null
  fit?: (r: Recipe, m: Macros, ctx: DietContext) => number
  /** Gewicht der weichen Passung im Planer-Score */
  fitWeight?: number
  macroTarget?: MacroShare
  /** Allgemeine, neutrale Hinweise zu typischen Lücken/Besonderheiten (keine Diagnose) */
  gapNotes?: string[]
  /** Ersetzt diese Weisen als redundant (nur Info) */
  implies?: string[]
}

export type Relation = { level: 'conflict' | 'tension' | 'info'; text: string }

/** carbs sind bereits verfügbare Kohlenhydrate (ohne Ballaststoffe) = „Netto-Kohlenhydrate“ */
const netCarbPct = (m: Macros) => (m.kcal > 0 ? (m.carbs * 4 * 100) / m.kcal : 0)
const share = (m: Macros) => {
  const e = m.protein * 4 + m.carbs * 4 + m.fat * 9
  return e > 0 ? { protein: (m.protein * 400) / e, carbs: (m.carbs * 400) / e, fat: (m.fat * 900) / e } : { protein: 0, carbs: 0, fat: 0 }
}
const hasMeat = (ings: Ingredient[], ctx: DietContext) => ings.some(i => ctx.foods.get(i.foodId)?.animal === 'meat')

export const MACRO_DEFAULT: MacroShare = { protein: 20, carbs: 50, fat: 30 }
/** Reihenfolge, in der Makroziele kombinierter Weisen Vorrang haben */
export const MACRO_PRIORITY = ['keto', 'carnivore', 'lowcarb', 'highprotein']

const registry = new Map<string, DietDef>()
export function registerDiet(d: DietDef) { registry.set(d.id, d) }
export const unregisterDiet = (id: string) => registry.delete(id)
export const getDiet = (id: string) => registry.get(id)
export const allDiets = () => [...registry.values()]

const NOTE_NEUTRAL = 'Diese Beschreibung nennt nur die in dieser App angewendeten Regeln; sie bewertet die Ernährungsweise nicht medizinisch.'

registerDiet({
  id: 'mischkost', label: 'Ausgewogene Mischkost', summary: 'Keine Einschränkung der Lebensmittelgruppen.',
  definition: ['Alle Lebensmittelgruppen erlaubt', 'Energieverteilung als Orientierung ca. 20 % Eiweiß / 50 % Kohlenhydrate / 30 % Fett', NOTE_NEUTRAL],
})
registerDiet({
  id: 'vegan', label: 'Vegan', summary: 'Keine tierischen Lebensmittel.', implies: ['vegetarisch', 'pescetarisch'],
  definition: ['Ausgeschlossen: Fleisch, Fisch, Meeresfrüchte, Milchprodukte, Eier, Honig', NOTE_NEUTRAL],
  foodRule: f => (f.animal !== 'none' ? `${f.name} ist nicht vegan` : null),
  gapNotes: ['Vitamin B12 ist in pflanzlichen Lebensmitteln nicht zuverlässig enthalten; Fachgesellschaften empfehlen angereicherte Lebensmittel oder ein Präparat nach fachlicher Absprache.'],
})
registerDiet({
  id: 'vegetarisch', label: 'Vegetarisch', summary: 'Kein Fleisch und kein Fisch; Milchprodukte und Eier erlaubt.', implies: ['pescetarisch'],
  definition: ['Ausgeschlossen: Fleisch, Fisch, Meeresfrüchte', 'Erlaubt: Milchprodukte, Eier, Honig', NOTE_NEUTRAL],
  foodRule: f => (f.animal === 'meat' || f.animal === 'fish' ? `${f.name} ist nicht vegetarisch` : f.animal === 'unknown' ? `${f.name}: Herkunft unbekannt (nicht sicher vegetarisch)` : null),
  gapNotes: ['Eisen und Zink aus pflanzlichen Quellen werden meist schlechter aufgenommen; auf ausreichende Zufuhr achten.'],
})
registerDiet({
  id: 'pescetarisch', label: 'Pescetarisch', summary: 'Kein Fleisch; Fisch, Meeresfrüchte, Milchprodukte und Eier erlaubt.',
  definition: ['Ausgeschlossen: Fleisch', 'Erlaubt: Fisch, Meeresfrüchte, Milchprodukte, Eier', NOTE_NEUTRAL],
  foodRule: f => (f.animal === 'meat' ? `${f.name} ist Fleisch (nicht pescetarisch)` : f.animal === 'unknown' ? `${f.name}: Herkunft unbekannt (nicht sicher pescetarisch)` : null),
  gapNotes: ['Bei großen Raubfischen (z. B. Thunfisch) auf mögliche Schadstoffbelastung und Abwechslung bei der Fischauswahl achten.'],
})
registerDiet({
  id: 'flexitarisch', label: 'Flexitarisch', summary: 'Überwiegend vegetarisch, Fleisch nur gelegentlich.',
  definition: ['Kein hartes Verbot', 'Rezepte ohne Fleisch werden bevorzugt, Fleischrezepte nur selten (je Tag höchstens eine Fleischmahlzeit bevorzugt)', NOTE_NEUTRAL],
  fitWeight: 2.5,
  gapNotes: ['Bei seltenem Fleischverzehr auf Eisen-, Zink- und Vitamin-B12-Quellen achten.'],
})
registerDiet({
  id: 'carnivore', label: 'Carnivore', summary: 'Ausschließlich tierische Lebensmittel.',
  definition: ['Erlaubt: Fleisch, Fisch, Meeresfrüchte, Eier, Milchprodukte (inkl. Butter/Ghee), Wasser, Kaffee, Tee', 'Ausgeschlossen: sämtliche pflanzlichen Lebensmittel inkl. Pflanzenöle, Honig', 'Kochfett wird automatisch Butter oder Ghee', NOTE_NEUTRAL],
  foodRule: f => {
    if (f.animal === 'honey') return `${f.name} ist nicht carnivore-konform`
    if (f.animal === 'unknown') return `${f.name}: Herkunft unbekannt (nicht sicher carnivore-konform)`
    if (f.animal !== 'none' || (f.group === 'getraenk' && f.kcal <= 5)) return null
    return `${f.name} ist pflanzlich (nicht carnivore)`
  },
  macroTarget: { protein: 30, carbs: 0, fat: 70 },
  gapNotes: [
    'Der Plan enthält keine pflanzlichen Lebensmittel und damit praktisch keine Ballaststoffe und keine pflanzlichen Vitamin-C-Quellen.',
    'Langzeitdaten zu dieser Ernährungsweise sind begrenzt; bei Vorerkrankungen oder Medikamenteneinnahme vorher ärztlich abklären.',
  ],
})
registerDiet({
  id: 'keto', label: 'Ketogen / Keto', summary: 'Sehr wenige Kohlenhydrate, hoher Fettanteil.', implies: ['lowcarb'],
  definition: ['Rezeptregel: Netto-Kohlenhydrate (verfügbare Kohlenhydrate ohne Ballaststoffe) höchstens 12 % der Rezeptenergie', 'Ausgeschlossen: Getreide, Zucker/Süßungsmittel', 'Orientierung Tagesverteilung ca. 20 % Eiweiß / 5 % Kohlenhydrate / 75 % Fett', NOTE_NEUTRAL],
  foodRule: f => (f.group === 'getreide' || f.group === 'zucker' ? `${f.name} ist für Keto ungeeignet (${f.group === 'zucker' ? 'Zucker' : 'Getreide'})` : null),
  recipeRule: m => (netCarbPct(m) > 12 ? `Netto-Kohlenhydrate ${netCarbPct(m).toFixed(0)} % der Energie (Keto-Grenze 12 %)` : null),
  fit: (_r, m) => { const s = share(m); return s.fat >= 65 ? 1 : s.fat <= 40 ? 0 : (s.fat - 40) / 25 },
  fitWeight: 1.5,
  macroTarget: { protein: 20, carbs: 5, fat: 75 },
  gapNotes: [
    'Die Ballaststoffzufuhr ist bei sehr geringem Kohlenhydratanteil oft niedrig.',
    'Bei Diabetes, Nierenerkrankungen, Schwangerschaft oder Medikamenteneinnahme vorher ärztlich abklären.',
  ],
})
registerDiet({
  id: 'lowcarb', label: 'Low Carb', summary: 'Reduzierter Kohlenhydratanteil.',
  definition: ['Bevorzugt: Rezepte mit höchstens ca. 25 % Kohlenhydratenergie (weiche Bewertung)', 'Orientierung Tagesverteilung ca. 25 % Eiweiß / 25 % Kohlenhydrate / 50 % Fett', NOTE_NEUTRAL],
  fit: (_r, m) => { const c = share(m).carbs; return c <= 25 ? 1 : c >= 50 ? 0 : (50 - c) / 25 },
  fitWeight: 1.5, macroTarget: { protein: 25, carbs: 25, fat: 50 },
})
registerDiet({
  id: 'highprotein', label: 'High Protein', summary: 'Erhöhter Eiweißanteil.',
  definition: ['Bevorzugt: Rezepte mit mindestens ca. 30 % Eiweißenergie (weiche Bewertung)', 'Orientierung Tagesverteilung ca. 30 % Eiweiß / 40 % Kohlenhydrate / 30 % Fett', NOTE_NEUTRAL],
  fit: (_r, m) => { const p = share(m).protein; return p >= 30 ? 1 : p <= 15 ? 0 : (p - 15) / 15 },
  fitWeight: 1.5, macroTarget: { protein: 30, carbs: 40, fat: 30 },
  gapNotes: ['Bei Nierenerkrankungen ist eine hohe Eiweißzufuhr ärztlich abzuklären.'],
})
registerDiet({
  id: 'paleo', label: 'Paleo', summary: 'Ohne Getreide, Hülsenfrüchte, Milchprodukte, Zucker und Soja.',
  definition: ['Ausgeschlossen: Getreide (inkl. Pseudogetreide), Hülsenfrüchte (inkl. Soja, Erdnuss), Milchprodukte (Ghee wird in dieser App toleriert), raffinierter Zucker/Süßungsmittel', 'Erlaubt: Fleisch, Fisch, Eier, Gemüse (inkl. Kartoffeln und Süßkartoffeln), Obst, Nüsse, Samen, Pflanzenöle', 'Hinweis: Es gibt keine einheitliche Paleo-Definition; dies ist die in dieser App angewendete Variante.', NOTE_NEUTRAL],
  foodRule: f => {
    if (f.group === 'getreide' || f.group === 'huelsenfrucht' || f.group === 'zucker') return `${f.name} ist nicht paleo-konform`
    if (f.animal === 'dairy' && f.id !== 'ghee') return `${f.name} ist ein Milchprodukt (nicht paleo)`
    if (f.allergens.includes('soja')) return `${f.name} enthält Soja (nicht paleo)`
    return null
  },
  gapNotes: ['Milchprodukte und Getreide entfallen; Calcium-, Jod- und Ballaststoffquellen bewusst einplanen.'],
})
registerDiet({
  id: 'mediterran', label: 'Mediterran', summary: 'Gemüse, Olivenöl, Hülsenfrüchte, Fisch; wenig rotes Fleisch.',
  definition: ['Bevorzugt (weich): Rezepte mit mediterranem Profil – Gemüse, Olivenöl, Hülsenfrüchte, Fisch; rotes Fleisch weniger', NOTE_NEUTRAL],
  fit: (r, _m, ctx) => {
    let animalMeat = false, fish = false
    for (const i of r.ingredients) { const a = ctx.foods.get(i.foodId)?.animal; if (a === 'meat') animalMeat = true; if (a === 'fish') fish = true }
    let s = r.tags.includes('mediterran') ? 0.7 : 0.2
    if (animalMeat) s -= 0.2
    if (fish) s += 0.15
    return Math.max(0, Math.min(1, s))
  },
  fitWeight: 1.5,
})
registerDiet({
  id: 'basisch', label: 'Basisch', summary: 'Ernährungsstil mit viel Gemüse, Obst, Kräutern und Hülsenfrüchten.',
  definition: ['Bevorzugt (weich): Rezepte mit hohem Anteil an Gemüse, Obst, Kräutern und geeigneten pflanzlichen Lebensmitteln', 'Es wird keine Wirkung auf den Blut-pH-Wert behauptet; der Körper reguliert diesen selbst.', NOTE_NEUTRAL],
  fit: (r, _m, ctx) => {
    let tot = 0, b = 0
    for (const i of r.ingredients) { const f = ctx.foods.get(i.foodId); if (!f || f.group === 'oel_fett') continue; tot += i.grams; if (f.basic) b += i.grams }
    return Math.min(1, (r.tags.includes('basisch') ? 0.4 : 0) + (tot ? (b / tot) * 0.8 : 0))
  },
  fitWeight: 1.5,
})

// Flexitarisch braucht Rezept-Zutaten: eigene fit-Funktion mit Zutatenzugriff
const flex = registry.get('flexitarisch')!
flex.fit = (r, _m, ctx) => (hasMeat(r.ingredients, ctx) ? 0.1 : 1)

// ---------------------------------------------------------------- Kombinationen
const REL: Record<string, Relation> = {}
const rel = (a: string, b: string, r: Relation) => { REL[[a, b].sort().join('|')] = r }
rel('carnivore', 'vegan', { level: 'conflict', text: 'Carnivore und Vegan schließen sich gegenseitig aus: Es gäbe kein erlaubtes Lebensmittel.' })
for (const o of ['vegetarisch', 'pescetarisch']) rel('carnivore', o, { level: 'tension', text: `Carnivore + ${o === 'vegetarisch' ? 'Vegetarisch' : 'Pescetarisch'}: nur ${o === 'vegetarisch' ? 'Eier und Milchprodukte' : 'Fisch, Eier und Milchprodukte'} bleiben übrig – die Auswahl wird sehr klein.` })
rel('carnivore', 'flexitarisch', { level: 'tension', text: 'Carnivore und Flexitarisch widersprechen sich im Ziel (Fleisch bevorzugt vs. selten); Carnivore hat als harte Regel Vorrang.' })
rel('carnivore', 'basisch', { level: 'tension', text: 'Basisch bevorzugt pflanzliche Lebensmittel, Carnivore schließt sie aus. Carnivore hat als harte Regel Vorrang, die Basisch-Bewertung bleibt niedrig.' })
rel('carnivore', 'mediterran', { level: 'tension', text: 'Mediterran setzt auf Gemüse und Olivenöl, Carnivore schließt beides aus; Vorrang hat Carnivore.' })
rel('carnivore', 'paleo', { level: 'info', text: 'Carnivore ist enger als Paleo; zusätzlich gelten die Paleo-Regeln (z. B. keine Milchprodukte außer Ghee).' })
rel('carnivore', 'highprotein', { level: 'info', text: 'Carnivore und High Protein sind gut kombinierbar.' })
rel('vegan', 'highprotein', { level: 'tension', text: 'Vegan + High Protein: Der Eiweißanteil ist mit pflanzlichen Rezepten begrenzt.' })
rel('vegan', 'keto', { level: 'tension', text: 'Vegan + Keto: Die Auswahl ist sehr eingeschränkt (v. a. Tofu, Avocado, Nüsse, Kokos).' })
rel('vegan', 'paleo', { level: 'tension', text: 'Vegan + Paleo: Hülsenfrüchte, Soja und Getreide entfallen – eine Eiweißversorgung ist kaum noch planbar.' })
rel('vegan', 'mediterran', { level: 'tension', text: 'Mediterran ist üblicherweise fisch- und milchbasiert; mit Vegan bleiben nur pflanzliche Rezepte.' })
rel('vegan', 'flexitarisch', { level: 'tension', text: 'Vegan schließt Fleisch aus – Flexitarisch hat keine zusätzliche Wirkung.' })
rel('vegetarisch', 'flexitarisch', { level: 'tension', text: 'Vegetarisch schließt Fleisch aus – Flexitarisch hat keine zusätzliche Wirkung.' })
rel('vegan', 'vegetarisch', { level: 'info', text: 'Vegan schließt Vegetarisch ein; es gilt die strengere Regel.' })
rel('vegan', 'pescetarisch', { level: 'info', text: 'Vegan schließt Pescetarisch ein; es gilt die strengere Regel.' })
rel('vegetarisch', 'pescetarisch', { level: 'info', text: 'Vegetarisch schließt Pescetarisch ein; es gilt die strengere Regel.' })
rel('keto', 'lowcarb', { level: 'info', text: 'Keto schließt Low Carb ein; es gilt die strengere Kohlenhydratregel.' })
rel('keto', 'highprotein', { level: 'tension', text: 'Keto und High Protein: Keto begrenzt Kohlenhydrate, hoher Eiweißanteil ist nur eingeschränkt möglich; das Makroziel von Keto hat Vorrang.' })
rel('keto', 'basisch', { level: 'tension', text: 'Keto begrenzt Obst, Hülsenfrüchte und Getreide stark; die Basisch-Bewertung kann daher niedrig bleiben.' })
rel('lowcarb', 'highprotein', { level: 'info', text: 'Low Carb und High Protein sind gut kombinierbar (Low-Carb-Makroziel mit erhöhtem Eiweißanteil).' })
rel('keto', 'paleo', { level: 'info', text: 'Keto und Paleo sind kombinierbar; es gelten beide Regelsätze.' })

export function relationOf(a: string, b: string): Relation | undefined { return REL[[a, b].sort().join('|')] }

export interface ComboAnalysis { conflicts: string[]; tensions: string[]; infos: string[] }
/** Findet Widersprüche und Redundanzen einer Kombination von Weisen. Mischkost ist nur allein sinnvoll. */
export function analyzeCombination(ids: string[]): ComboAnalysis {
  const out: ComboAnalysis = { conflicts: [], tensions: [], infos: [] }
  const real = ids.filter(i => i !== 'mischkost')
  for (let i = 0; i < real.length; i++) for (let j = i + 1; j < real.length; j++) {
    const r = relationOf(real[i], real[j])
    if (!r) continue
    ;(r.level === 'conflict' ? out.conflicts : r.level === 'tension' ? out.tensions : out.infos).push(r.text)
  }
  return out
}

export function macroTargetFor(ids: string[]): MacroShare {
  for (const k of MACRO_PRIORITY) if (ids.includes(k)) return getDiet(k)!.macroTarget!
  return MACRO_DEFAULT
}
