export type Category =
  | 'gemuese' | 'obst' | 'fleisch' | 'fisch' | 'milch' | 'getreide'
  | 'nuesse' | 'oele' | 'gewuerze' | 'getraenke' | 'sonstige'

export const CATEGORY_LABEL: Record<Category, string> = {
  gemuese: 'Gemüse', obst: 'Obst', fleisch: 'Fleisch', fisch: 'Fisch',
  milch: 'Milchprodukte', getreide: 'Getreide & Hülsenfrüchte', nuesse: 'Nüsse & Samen',
  oele: 'Öle & Fette', gewuerze: 'Gewürze & Kräuter', getraenke: 'Getränke', sonstige: 'Sonstige Lebensmittel',
}
export const CATEGORIES = Object.keys(CATEGORY_LABEL) as Category[]

export type Allergen =
  | 'laktose' | 'milch' | 'gluten' | 'fruktose' | 'histamin' | 'nuesse'
  | 'erdnuesse' | 'soja' | 'eier' | 'fisch' | 'schalentiere'

export const ALLERGEN_LABEL: Record<Allergen, string> = {
  laktose: 'Laktose', milch: 'Milcheiweiß', gluten: 'Gluten', fruktose: 'Fruktose', histamin: 'Histamin',
  nuesse: 'Nüsse', erdnuesse: 'Erdnüsse', soja: 'Soja', eier: 'Eier', fisch: 'Fisch', schalentiere: 'Schalentiere',
}
export const ALLERGENS = Object.keys(ALLERGEN_LABEL) as Allergen[]

/** unknown = Herkunft nicht sicher bestimmbar (z. B. zusammengesetzte Lebensmittel) – gilt nie als vegan/vegetarisch/carnivore-sicher */
export type AnimalOrigin = 'none' | 'meat' | 'fish' | 'dairy' | 'egg' | 'honey' | 'unknown'

export interface OilProps {
  warmOk: boolean
  coldOk: boolean
  smokePointC?: number
  note: string
}

export type Prep = 'roh' | 'gekocht' | 'konserviert' | 'getrocknet' | 'verarbeitet' | 'zubereitet'
export const PREP_LABEL: Record<Prep, string> = {
  roh: 'roh / ungegart', gekocht: 'gekocht', konserviert: 'Konserve (abgetropft)', getrocknet: 'getrocknet',
  verarbeitet: 'verarbeitet', zubereitet: 'zubereitet',
}

/** Funktionelle Lebensmittelgruppe – Grundlage für Ernährungsweisen-Regeln (unabhängig von der Anzeigekategorie). */
export type FoodGroup =
  | 'gemuese' | 'obst' | 'fleisch' | 'fisch' | 'schalentiere' | 'milch' | 'ei' | 'getreide' | 'huelsenfrucht'
  | 'nuss_samen' | 'oel_fett' | 'gewuerz' | 'getraenk' | 'zucker' | 'sonstige'
export const GROUP_LABEL: Record<FoodGroup, string> = {
  gemuese: 'Gemüse', obst: 'Obst', fleisch: 'Fleisch', fisch: 'Fisch', schalentiere: 'Schalentiere', milch: 'Milchprodukte',
  ei: 'Eier', getreide: 'Getreide', huelsenfrucht: 'Hülsenfrüchte', nuss_samen: 'Nüsse & Samen', oel_fett: 'Öle & Fette',
  gewuerz: 'Gewürze & Kräuter', getraenk: 'Getränke', zucker: 'Zucker & Süßungsmittel', sonstige: 'Sonstiges',
}

/** verified = gegen Originalquelle geprüft; reference = gerundeter Richtwert (nicht geprüft); user = eigene Angabe; missing = Wert fehlt */
export type DataQuality = 'verified' | 'reference' | 'user' | 'missing'
export const QUALITY_LABEL: Record<DataQuality, string> = {
  verified: 'Verifiziert (Originalquelle)', reference: 'Richtwert (nicht verifiziert)', user: 'Eigene Angabe', missing: 'Daten fehlen',
}

export const MICRO_KEYS = ['calcium', 'magnesium', 'kalium', 'eisen', 'zink', 'vitaminA', 'vitaminB12', 'vitaminC', 'vitaminD', 'vitaminE', 'folat'] as const
export type MicroKey = (typeof MICRO_KEYS)[number]
export const MICRO_INFO: Record<MicroKey, { label: string; unit: string }> = {
  calcium: { label: 'Calcium', unit: 'mg' }, magnesium: { label: 'Magnesium', unit: 'mg' }, kalium: { label: 'Kalium', unit: 'mg' },
  eisen: { label: 'Eisen', unit: 'mg' }, zink: { label: 'Zink', unit: 'mg' }, vitaminA: { label: 'Vitamin A (RAE)', unit: 'µg' },
  vitaminB12: { label: 'Vitamin B12', unit: 'µg' }, vitaminC: { label: 'Vitamin C', unit: 'mg' }, vitaminD: { label: 'Vitamin D', unit: 'µg' },
  vitaminE: { label: 'Vitamin E', unit: 'mg' }, folat: { label: 'Folat', unit: 'µg' },
}

export interface SourceRef { name: string; id?: string; license?: string; retrieved?: string }

export interface Food {
  id: string
  name: string
  category: Category
  /** Nährwerte pro 100 g; carbs = verfügbare Kohlenhydrate OHNE Ballaststoffe (BLS-/EU-Kennzeichnungsdefinition) */
  kcal: number
  protein: number
  carbs: number
  fat: number
  fiber: number
  allergens: Allergen[]
  /** Mögliche Spuren / Kreuzkontamination (Näherung, nicht vollständig) */
  traces: Allergen[]
  /** false = Allergeninfo unbekannt (z. B. eigenes Lebensmittel ohne Angabe) */
  allergenInfoKnown: boolean
  animal: AnimalOrigin
  group: FoodGroup
  /** Zustand, auf den sich die Nährwerte und Rezeptgramm beziehen */
  prep: Prep
  /** passt zum basischen Ernährungsstil (Gemüse, Obst, Kräuter, geeignete Pflanzen) */
  basic?: boolean
  /** schwer erhältliche Zutat */
  special?: boolean
  /** Haushaltseinheit, z. B. 1 Stück = 55 g */
  unit?: { label: string; grams: number }
  oil?: OilProps
  /** Mikronährstoffe pro 100 g; fehlende Schlüssel = keine Daten (nie 0 annehmen) */
  micros?: Partial<Record<MicroKey, number>>
  /** Nährwertfelder, für die die Quelle keinen Wert liefert (im Modell als 0 geführt, in der Anzeige als „keine Daten“) */
  missingFields?: string[]
  source: string
  sourceRef?: SourceRef
  dataQuality: DataQuality
  custom?: boolean
}

export type MealSlot = 'fruehstueck' | 'mittag' | 'abend' | 'snack'
export const SLOT_LABEL: Record<MealSlot, string> = {
  fruehstueck: 'Frühstück', mittag: 'Mittagessen', abend: 'Abendessen', snack: 'Snack',
}

/** Kennungen der eingebauten Ernährungsweisen. Weitere Weisen werden in domain/diets.ts registriert. */
export type Style =
  | 'carnivore' | 'vegan' | 'vegetarisch' | 'pescetarisch' | 'flexitarisch' | 'keto' | 'lowcarb'
  | 'highprotein' | 'paleo' | 'mediterran' | 'basisch' | 'mischkost'
export const STYLE_LABEL: Record<Style, string> = {
  carnivore: 'Carnivore', vegan: 'Vegan', vegetarisch: 'Vegetarisch', pescetarisch: 'Pescetarisch', flexitarisch: 'Flexitarisch',
  keto: 'Ketogen / Keto', lowcarb: 'Low Carb', highprotein: 'High Protein', paleo: 'Paleo', mediterran: 'Mediterran',
  basisch: 'Basisch', mischkost: 'Ausgewogene Mischkost',
}

export const OIL_WARM = 'oil:warm'
export const OIL_COLD = 'oil:cold'

export interface Ingredient {
  /** Food-ID oder Platzhalter oil:warm / oil:cold (wird mit dem Öl des Nutzers aufgelöst) */
  foodId: string
  /** Gramm pro 1 Portion */
  grams: number
}

export interface Recipe {
  id: string
  name: string
  slots: MealSlot[]
  minutes: number
  ingredients: Ingredient[]
  steps: string[]
  /** explizit gepflegte Stile (basisch/mediterran); übrige werden abgeleitet */
  tags: Style[]
  favorite?: boolean
  custom?: boolean
}

export type Sex = 'f' | 'm' | 'd'
export type Activity = 'sitzend' | 'leicht' | 'moderat' | 'hoch'
export type Goal = 'halten' | 'reduzieren' | 'aufbauen' | 'ausgewogen'

export interface Profile {
  age: number
  heightCm: number
  weightKg: number
  targetWeightKg?: number
  sex: Sex
  activity: Activity
  goal: Goal
  kcalMode: 'auto' | 'manual'
  kcalManual: number
  mealCount: 3 | 4 | 5
  persons: number
}

export type Severity = 'allergy' | 'intolerance'
export interface Restriction { allergen: Allergen; severity: Severity }

export interface OilPrefs {
  preferred: string[]
  excluded: string[]
  main: string | null
  warm: string | null
  cold: string | null
}

export type RuleKind = 'exclude_group' | 'exclude_category' | 'exclude_term' | 'max_carb_pct' | 'min_protein_pct' | 'max_fat_pct'
export interface CustomRule { id: string; name: string; kind: RuleKind; value: string | number; enabled: boolean }

export interface Preferences {
  styles: Style[]
  customRules: CustomRule[]
  /** Bei Allergien auch „Spuren“ als Ausschluss behandeln */
  strictTraces: boolean
  restrictions: Restriction[]
  customExclusions: string[]
  excludedFoods: string[]
  preferredFoods: string[]
  favoriteFoods: string[]
  oils: OilPrefs
}

export interface PlannedMeal {
  id: string
  slot: MealSlot
  recipeId: string
  /** Portionsfaktor relativ zu 1 Rezeptportion */
  factor: number
}
export interface PlanDay { date: string; meals: PlannedMeal[] }

export interface Plan {
  id: string
  createdAt: string
  startDate: string
  days: PlanDay[]
  oils: { warm: string | null; cold: string | null }
  kcalTarget: number
  persons: number
}

export interface ShoppingState {
  checked: string[]
  removed: string[]
  manual: { id: string; name: string; amount: string; checked: boolean }[]
}

export interface AiShare { body: boolean; plan: boolean; shopping: boolean; progress: boolean; foodPrefs: boolean }
export type ActionStatus = 'pending' | 'applied' | 'dismissed' | 'rejected'
export interface ChatAction { id: string; proposal: Record<string, unknown>; status: ActionStatus; note?: string; /** Kurzfassung der Engine-Vorschau zum Zeitpunkt des Vorschlags */ summary?: { title: string; lines: string[] } }
export interface ChatMessage { id: string; role: 'user' | 'assistant'; content: string; ts: string; provider?: string; model?: string; error?: string; actions?: ChatAction[] }
export interface AiState { consent: boolean; share: AiShare; chat: ChatMessage[] }

export interface AppState {
  version: 2
  /** Version der eingebauten Lebensmittel-/Rezeptdaten; bei Anhebung werden Standarddaten aufgefrischt */
  dataVersion: number
  onboarded: boolean
  profile: Profile
  prefs: Preferences
  foods: Food[]
  recipes: Recipe[]
  plan: Plan | null
  shopping: ShoppingState
  weights: { date: string; kg: number }[]
  eaten: Record<string, boolean>
  ai: AiState
}
