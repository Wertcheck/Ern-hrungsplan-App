import { z } from 'zod'
import { ALLERGENS, CATEGORIES, MICRO_KEYS } from './types'

const num = (min: number, max: number) => z.number().finite().min(min).max(max)
const str = (max = 200) => z.string().max(max)

export const profileSchema = z.object({
  age: z.number().int().min(14, 'Mindestalter 14 Jahre').max(100, 'Alter bis 100'),
  heightCm: num(120, 230),
  weightKg: num(30, 300),
  targetWeightKg: num(30, 300).optional(),
  sex: z.enum(['f', 'm', 'd']),
  activity: z.enum(['sitzend', 'leicht', 'moderat', 'hoch']),
  goal: z.enum(['halten', 'reduzieren', 'aufbauen', 'ausgewogen']),
  kcalMode: z.enum(['auto', 'manual']),
  kcalManual: num(1200, 4500),
  mealCount: z.union([z.literal(3), z.literal(4), z.literal(5)]),
  persons: z.number().int().min(1).max(10),
})

export const foodInputSchema = z.object({
  name: z.string().trim().min(1, 'Bezeichnung fehlt').max(80),
  category: z.enum(CATEGORIES as [string, ...string[]]),
  kcal: num(0, 900), protein: num(0, 100), carbs: num(0, 100), fat: num(0, 100), fiber: num(0, 100),
}).refine(v => v.protein + v.carbs + v.fat <= 100.5, { message: 'Eiweiß + Kohlenhydrate + Fett dürfen 100 g nicht überschreiten' })
  .refine(v => Math.abs(v.protein * 4 + v.carbs * 4 + v.fiber * 2 + v.fat * 9 - v.kcal) <= Math.max(40, v.kcal * 0.25), { message: 'Kalorien passen nicht zu den Makronährstoffen (Atwater-Check)' })

export const recipeInputSchema = z.object({
  name: z.string().trim().min(1, 'Name fehlt').max(80),
  slots: z.array(z.enum(['fruehstueck', 'mittag', 'abend', 'snack'])).min(1, 'Mindestens eine Mahlzeitenart'),
  ingredients: z.array(z.object({ foodId: z.string().min(1), grams: num(0.1, 3000) })).min(1, 'Mindestens eine Zutat'),
})

export const customRuleSchema = z.object({
  id: str(60), name: z.string().trim().min(1).max(60),
  kind: z.enum(['exclude_group', 'exclude_category', 'exclude_term', 'max_carb_pct', 'min_protein_pct', 'max_fat_pct']),
  value: z.union([z.string().max(60), z.number().finite().min(0).max(100)]), enabled: z.boolean(),
})

const microsSchema = z.object(Object.fromEntries(MICRO_KEYS.map(k => [k, num(0, 100000).optional()]))).partial()
const allergenEnum = z.enum(ALLERGENS as [string, ...string[]])

export const foodSchema = z.object({
  id: str(80), name: str(120), category: z.enum(CATEGORIES as [string, ...string[]]),
  kcal: num(0, 900), protein: num(0, 100), carbs: num(0, 100), fat: num(0, 100), fiber: num(0, 100),
  allergens: z.array(allergenEnum), traces: z.array(allergenEnum), allergenInfoKnown: z.boolean(),
  animal: z.enum(['none', 'meat', 'fish', 'dairy', 'egg', 'honey', 'unknown']),
  group: z.string(), prep: z.enum(['roh', 'gekocht', 'konserviert', 'getrocknet', 'verarbeitet', 'zubereitet']),
  missingFields: z.array(z.string()).optional(), source: str(400), dataQuality: z.enum(['verified', 'reference', 'user', 'missing']),
  micros: microsSchema.optional(), sourceRef: z.object({ name: str(), id: str().optional(), license: str().optional(), retrieved: str().optional() }).optional(),
}).passthrough()

export const recipeSchema = z.object({
  id: str(80), name: str(120), slots: z.array(z.enum(['fruehstueck', 'mittag', 'abend', 'snack'])).min(1), minutes: num(0, 1000),
  ingredients: z.array(z.object({ foodId: str(80), grams: num(0, 5000) })), steps: z.array(str(600)), tags: z.array(z.string()),
}).passthrough()

export const prefsSchema = z.object({
  styles: z.array(z.string()).min(1), customRules: z.array(customRuleSchema), strictTraces: z.boolean(),
  restrictions: z.array(z.object({ allergen: allergenEnum, severity: z.enum(['allergy', 'intolerance']) })),
  customExclusions: z.array(str(60)), excludedFoods: z.array(str(80)), preferredFoods: z.array(str(80)), favoriteFoods: z.array(str(80)),
  oils: z.object({ preferred: z.array(z.string()), excluded: z.array(z.string()), main: z.string().nullable(), warm: z.string().nullable(), cold: z.string().nullable() }),
})

export const planSchema = z.object({
  id: str(), createdAt: str(), startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  days: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    meals: z.array(z.object({ id: str(80), slot: z.enum(['fruehstueck', 'mittag', 'abend', 'snack']), recipeId: str(80), factor: num(0.1, 6) })),
  })).max(60),
  oils: z.object({ warm: z.string().nullable(), cold: z.string().nullable() }),
  kcalTarget: num(500, 8000), persons: z.number().int().min(1).max(10),
})

export const shoppingSchema = z.object({
  checked: z.array(z.string()), removed: z.array(z.string()),
  manual: z.array(z.object({ id: str(80), name: str(120), amount: str(60), checked: z.boolean() })),
})

export const aiSchema = z.object({
  consent: z.boolean(),
  share: z.object({ body: z.boolean(), plan: z.boolean(), shopping: z.boolean(), progress: z.boolean(), foodPrefs: z.boolean() }),
  chat: z.array(z.object({
    id: str(80), role: z.enum(['user', 'assistant']), content: z.string().max(20000), ts: str(60),
    provider: z.string().optional(), model: z.string().optional(), error: z.string().optional(),
    actions: z.array(z.object({ id: str(80), proposal: z.record(z.string(), z.unknown()), status: z.enum(['pending', 'applied', 'dismissed', 'rejected']), note: z.string().optional() })).optional(),
  })).max(300),
})

export const weightsSchema = z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), kg: num(30, 300) })).max(5000)
export const eatenSchema = z.record(z.string(), z.boolean())

/** Abschnitte des Zustands; jeder wird einzeln validiert (siehe persistence.ts). */
export const SECTION_SCHEMAS = {
  profile: profileSchema, prefs: prefsSchema, foods: z.array(foodSchema).max(5000), recipes: z.array(recipeSchema).max(5000),
  plan: planSchema.nullable(), shopping: shoppingSchema, weights: weightsSchema, eaten: eatenSchema, ai: aiSchema,
} as const
