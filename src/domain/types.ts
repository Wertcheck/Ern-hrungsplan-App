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

export type AnimalOrigin = 'none' | 'meat' | 'fish' | 'dairy' | 'egg' | 'honey'

export interface OilProps {
  warmOk: boolean
  coldOk: boolean
  smokePointC?: number
  note: string
}

export interface Food {
  id: string
  name: string
  category: Category
  /** Nährwerte pro 100 g */
  kcal: number
  protein: number
  carbs: number
  fat: number
  fiber: number
  allergens: Allergen[]
  /** false = Allergeninfo unbekannt (z. B. eigenes Lebensmittel ohne Angabe) */
  allergenInfoKnown: boolean
  animal: AnimalOrigin
  /** passt zum basischen Ernährungsstil (Gemüse, Obst, Kräuter, geeignete Pflanzen) */
  basic?: boolean
  /** schwer erhältliche Zutat */
  special?: boolean
  /** Haushaltseinheit, z. B. 1 Stück = 55 g */
  unit?: { label: string; grams: number }
  oil?: OilProps
  micros?: Record<string, string>
  source: string
  /** true nur, wenn Werte gegen eine Referenzquelle geprüft wurden */
  verified: boolean
  custom?: boolean
}

export type MealSlot = 'fruehstueck' | 'mittag' | 'abend' | 'snack'
export const SLOT_LABEL: Record<MealSlot, string> = {
  fruehstueck: 'Frühstück', mittag: 'Mittagessen', abend: 'Abendessen', snack: 'Snack',
}

export type Style =
  | 'basisch' | 'mediterran' | 'vegetarisch' | 'vegan' | 'lowcarb' | 'highprotein' | 'mischkost' | 'individuell'
export const STYLE_LABEL: Record<Style, string> = {
  basisch: 'Basische Ernährung', mediterran: 'Mediterran', vegetarisch: 'Vegetarisch', vegan: 'Vegan',
  lowcarb: 'Low Carb', highprotein: 'High Protein', mischkost: 'Ausgewogene Mischkost', individuell: 'Individuell',
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

export interface Preferences {
  styles: Style[]
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

export interface AppState {
  version: 1
  onboarded: boolean
  profile: Profile
  prefs: Preferences
  foods: Food[]
  recipes: Recipe[]
  plan: Plan | null
  shopping: ShoppingState
  weights: { date: string; kg: number }[]
  eaten: Record<string, boolean>
}
