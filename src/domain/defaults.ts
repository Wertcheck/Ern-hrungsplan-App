import { BUILTIN_FOODS } from '../data/foods'
import { BUILTIN_RECIPES } from '../data/recipes'
import type { AppState, Preferences, Profile } from './types'

export const defaultProfile = (): Profile => ({
  age: 35, heightCm: 175, weightKg: 75, sex: 'd', activity: 'leicht', goal: 'ausgewogen',
  kcalMode: 'auto', kcalManual: 2000, mealCount: 3, persons: 1,
})
export const defaultPrefs = (): Preferences => ({
  styles: ['mischkost'], restrictions: [], customExclusions: [], excludedFoods: [], preferredFoods: [], favoriteFoods: [],
  oils: { preferred: ['olivenoel', 'rapsoel'], excluded: [], main: 'olivenoel', warm: null, cold: null },
})
export const defaultState = (): AppState => ({
  version: 1, onboarded: false, profile: defaultProfile(), prefs: defaultPrefs(),
  foods: structuredClone(BUILTIN_FOODS), recipes: structuredClone(BUILTIN_RECIPES),
  plan: null, shopping: { checked: [], removed: [], manual: [] }, weights: [], eaten: {},
})
