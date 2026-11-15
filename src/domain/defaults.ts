import { BUILTIN_DATA_VERSION, BUILTIN_FOODS } from '../data/foods'
import { BUILTIN_RECIPES } from '../data/recipes'
import type { AiState, AppState, Preferences, Profile } from './types'

export const defaultProfile = (): Profile => ({
  age: 35, heightCm: 175, weightKg: 75, sex: 'd', activity: 'leicht', goal: 'ausgewogen',
  kcalMode: 'auto', kcalManual: 2000, mealCount: 3, persons: 1,
})
export const defaultPrefs = (): Preferences => ({
  styles: ['mischkost'], customRules: [], strictTraces: true, restrictions: [], customExclusions: [], excludedFoods: [], preferredFoods: [], favoriteFoods: [],
  oils: { preferred: ['olivenoel', 'rapsoel'], excluded: [], main: 'olivenoel', warm: null, cold: null },
})
/** Datensparsame Voreinstellung: nur Sicherheitsrelevantes (Weisen/Allergien) wird ohnehin immer gesendet; alles Weitere ist opt-in. */
export const defaultAi = (): AiState => ({ consent: false, share: { body: false, plan: true, shopping: false, progress: false, foodPrefs: true }, chat: [] })
export const defaultState = (): AppState => ({
  version: 2, dataVersion: BUILTIN_DATA_VERSION, onboarded: false, profile: defaultProfile(), prefs: defaultPrefs(),
  foods: structuredClone(BUILTIN_FOODS), recipes: structuredClone(BUILTIN_RECIPES),
  plan: null, shopping: { checked: [], removed: [], manual: [] }, weights: [], eaten: {}, ai: defaultAi(),
})
