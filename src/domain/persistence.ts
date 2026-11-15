import { BUILTIN_DATA_VERSION, BUILTIN_FOODS } from '../data/foods'
import { BUILTIN_RECIPES } from '../data/recipes'
import { defaultAi, defaultPrefs, defaultProfile, defaultState } from './defaults'
import { SECTION_SCHEMAS } from './schemas'
import type { AppState, Category, Food, FoodGroup, Recipe } from './types'

export const STORAGE_PREFIX = 'ernaehrungsplan-'
export const STORAGE_KEY = `${STORAGE_PREFIX}state-v1`
export const BACKUP_KEY = `${STORAGE_PREFIX}state-corrupt-backup`

/** Minimales Storage-Interface (localStorage-kompatibel) – erleichtert Tests ohne Browser. */
export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void; key(i: number): string | null; readonly length: number }

export interface ParseResult { state: AppState; warnings: string[] }
export type ParseOutcome = (ParseResult & { ok: true }) | { ok: false; error: string }

const GROUP_BY_CAT: Record<Category, FoodGroup> = {
  gemuese: 'gemuese', obst: 'obst', fleisch: 'fleisch', fisch: 'fisch', milch: 'milch', getreide: 'getreide', nuesse: 'nuss_samen',
  oele: 'oel_fett', gewuerze: 'gewuerz', getraenke: 'getraenk', sonstige: 'sonstige',
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Hebt ältere Zustände (v1) und veraltete Standarddaten auf das aktuelle Schema. */
export function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw }
  const dataVersion = typeof raw.dataVersion === 'number' ? raw.dataVersion : 1
  const prefs = isObj(raw.prefs) ? { ...raw.prefs } : {}
  prefs.customRules ??= []
  prefs.strictTraces ??= true
  out.prefs = prefs
  const builtinIds = new Set(BUILTIN_FOODS.map(f => f.id))
  const oldFoods = Array.isArray(raw.foods) ? (raw.foods as Record<string, unknown>[]) : []
  const customFoods = oldFoods.filter(f => isObj(f) && (f.custom === true || !builtinIds.has(String(f.id)))).map((f): Record<string, unknown> => ({
    ...f,
    traces: Array.isArray(f.traces) ? f.traces : [],
    group: typeof f.group === 'string' ? f.group : GROUP_BY_CAT[f.category as Category] ?? 'sonstige',
    prep: f.prep ?? 'roh',
    dataQuality: f.dataQuality ?? 'user',
    custom: true,
  }))
  // Standarddaten werden aufgefrischt, wenn sie veraltet sind (eigene Einträge bleiben unverändert)
  if (dataVersion < BUILTIN_DATA_VERSION || !Array.isArray(raw.foods)) {
    out.foods = [...structuredClone(BUILTIN_FOODS), ...customFoods]
    const favs = new Set((Array.isArray(raw.recipes) ? (raw.recipes as Record<string, unknown>[]) : []).filter(r => r?.favorite).map(r => r.id))
    const builtinRecipeIds = new Set(BUILTIN_RECIPES.map(r => r.id))
    const customRecipes = (Array.isArray(raw.recipes) ? (raw.recipes as Record<string, unknown>[]) : []).filter(r => isObj(r) && (r.custom === true || !builtinRecipeIds.has(String(r.id))))
    out.recipes = [...structuredClone(BUILTIN_RECIPES).map((r: Recipe) => (favs.has(r.id) ? { ...r, favorite: true } : r)), ...customRecipes]
  } else out.foods = oldFoods
  out.dataVersion = BUILTIN_DATA_VERSION
  out.version = 2
  out.ai ??= defaultAi()
  return out
}

/**
 * Prüft einen Zustand abschnittsweise.
 *  - mode 'load': beschädigte Abschnitte werden durch Standardwerte ersetzt (mit Warnung) – die App startet immer.
 *  - mode 'import': jeder ungültige Abschnitt führt zur Ablehnung der gesamten Datei.
 */
export function parseState(raw: unknown, mode: 'load' | 'import'): ParseOutcome {
  if (!isObj(raw)) return { ok: false, error: 'Datei enthält keine gültigen Anwendungsdaten.' }
  const ver = raw.version
  if (ver !== 1 && ver !== 2) return { ok: false, error: `Inkompatible Datenversion (${typeof ver === 'number' ? ver : 'unbekannt'}).` }
  if (typeof raw.onboarded !== 'boolean') return { ok: false, error: 'Datei ist unvollständig (onboarded fehlt).' }
  if (mode === 'import' && ver === 2) {
    // Aktuelle Sicherungsdateien müssen vollständig sein – nur ältere (v1) Dateien dürfen nachgerüstet werden.
    const missing = Object.keys(SECTION_SCHEMAS).filter(k => k !== 'changeLog' && raw[k] === undefined)
    if (missing.length) return { ok: false, error: `Datei ist unvollständig (fehlend: ${missing.join(', ')}).` }
  }
  const m = migrate(raw)
  const d = defaultState()
  const warnings: string[] = []
  const state: Record<string, unknown> = { version: 2, dataVersion: BUILTIN_DATA_VERSION, onboarded: raw.onboarded }
  const fallbacks: Record<string, unknown> = {
    profile: defaultProfile(), prefs: defaultPrefs(), foods: d.foods, recipes: d.recipes, plan: null, shopping: d.shopping, weights: [], eaten: {}, ai: defaultAi(), changeLog: [],
  }
  const label: Record<string, string> = { profile: 'Profil', prefs: 'Ernährungseinstellungen', foods: 'Lebensmittel', recipes: 'Rezepte', plan: 'Ernährungsplan', shopping: 'Einkaufsliste', weights: 'Gewichtsverlauf', eaten: 'Fortschritt', ai: 'KI-Daten', changeLog: 'Änderungsprotokoll' }
  for (const [key, schema] of Object.entries(SECTION_SCHEMAS)) {
    const value = key === 'profile' ? { ...defaultProfile(), ...(isObj(m.profile) ? m.profile : {}) } : key === 'changeLog' ? m.changeLog ?? [] : m[key]
    const r = value === undefined ? { success: false as const, error: { issues: [{ message: 'fehlt' }] } } : schema.safeParse(value)
    if (r.success) state[key] = r.data
    else if (mode === 'import') return { ok: false, error: `Abschnitt „${label[key]}“ ist ungültig oder unvollständig (${r.error.issues[0]?.message ?? 'Fehler'}).` }
    else { state[key] = fallbacks[key]; warnings.push(`„${label[key]}“ war beschädigt und wurde zurückgesetzt.`) }
  }
  return { ok: true, state: state as unknown as AppState, warnings }
}

export function parseJsonText(text: string, mode: 'load' | 'import'): ParseOutcome {
  let j: unknown
  try { j = JSON.parse(text) } catch { return { ok: false, error: 'Datei ist kein gültiges JSON.' } }
  return parseState(j, mode)
}

export function loadFromStorage(storage: KV): ParseResult {
  let raw: string | null = null
  try { raw = storage.getItem(STORAGE_KEY) } catch { return { state: defaultState(), warnings: ['Der Browser-Speicher ist nicht zugänglich. Änderungen werden nicht gespeichert.'] } }
  if (!raw) return { state: defaultState(), warnings: [] }
  const r = parseJsonText(raw, 'load')
  if (r.ok) return r
  // Unlesbar: Rohdaten zur Rettung sichern, nicht stillschweigend überschreiben
  try { storage.setItem(BACKUP_KEY, raw) } catch { /* ignorieren */ }
  return { state: defaultState(), warnings: [`Gespeicherte Daten waren nicht lesbar (${r.error}) und wurden zurückgesetzt. Eine Sicherung der Rohdaten liegt im Browser-Speicher.`] }
}

export function saveToStorage(storage: KV, state: AppState): boolean {
  try { storage.setItem(STORAGE_KEY, JSON.stringify(state)); return true } catch { return false }
}

/** Entfernt ALLE von der App angelegten Schlüssel (Zustand, Backup, künftige Schlüssel mit gleichem Präfix). */
export function clearAllStorage(storage: KV): string[] {
  const keys: string[] = []
  for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k && k.startsWith(STORAGE_PREFIX)) keys.push(k) }
  keys.forEach(k => storage.removeItem(k))
  return keys
}

export type { Food }
