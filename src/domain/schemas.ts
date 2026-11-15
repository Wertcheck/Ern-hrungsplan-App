import { z } from 'zod'
import { ALLERGENS, CATEGORIES } from './types'

const num = (min: number, max: number) => z.number().finite().min(min).max(max)

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
  .refine(v => Math.abs(v.protein * 4 + v.carbs * 4 + v.fat * 9 - v.kcal) <= Math.max(40, v.kcal * 0.25), { message: 'Kalorien passen nicht zu den Makronährstoffen (Atwater-Check)' })

export const recipeInputSchema = z.object({
  name: z.string().trim().min(1, 'Name fehlt').max(80),
  slots: z.array(z.enum(['fruehstueck', 'mittag', 'abend', 'snack'])).min(1, 'Mindestens eine Mahlzeitenart'),
  ingredients: z.array(z.object({ foodId: z.string().min(1), grams: num(0.1, 3000) })).min(1, 'Mindestens eine Zutat'),
})

const foodSchema = z.object({
  id: z.string(), name: z.string(), category: z.enum(CATEGORIES as [string, ...string[]]),
  kcal: z.number(), protein: z.number(), carbs: z.number(), fat: z.number(), fiber: z.number(),
  allergens: z.array(z.enum(ALLERGENS as [string, ...string[]])), allergenInfoKnown: z.boolean(),
}).passthrough()
const recipeSchema = z.object({
  id: z.string(), name: z.string(), slots: z.array(z.string()),
  ingredients: z.array(z.object({ foodId: z.string(), grams: z.number() })), steps: z.array(z.string()),
}).passthrough()

export const stateSchema = z.object({
  version: z.literal(1), onboarded: z.boolean(), profile: profileSchema.partial().passthrough(),
  prefs: z.object({ styles: z.array(z.string()), restrictions: z.array(z.any()), customExclusions: z.array(z.string()), excludedFoods: z.array(z.string()), preferredFoods: z.array(z.string()), favoriteFoods: z.array(z.string()), oils: z.any() }).passthrough(),
  foods: z.array(foodSchema), recipes: z.array(recipeSchema),
  plan: z.any().nullable(), shopping: z.any(), weights: z.array(z.object({ date: z.string(), kg: z.number() })), eaten: z.record(z.string(), z.boolean()),
}).passthrough()
