/**
 * Gemeinsame, reproduzierbare Testfälle für (a) die deterministische Regel-Erkennung (Vitest),
 * (b) die Modell-Auswertung mit Fake-Engine (Vitest) und (c) den Benchmark auf dem Gerät (llm-bench.html).
 * Die Beurteilung („judge“) ist überall dieselbe.
 */
import { defaultState } from '../../domain/defaults'
import { generatePlan, targetFor } from '../../domain/planner'
import type { AppState } from '../../domain/types'
import { commit } from '../engine'
import type { LocalOutcome } from './runner'

export const CASE_TODAY = '2026-11-16'

export function baseState(): AppState {
  const s = defaultState(); s.onboarded = true
  s.profile = { ...s.profile, kcalMode: 'manual', kcalManual: 2200, mealCount: 3 }
  s.plan = generatePlan({ profile: s.profile, foods: s.foods, recipes: s.recipes, prefs: s.prefs, startDate: CASE_TODAY, days: 14, seed: 4 })
  return s
}

export interface Expect {
  /** erlaubte Ergebnisarten */
  kind: LocalOutcome['kind'][]
  type?: string
  params?: Record<string, unknown>
  cls?: 'A' | 'B'
  /** bei Rückfragen: Typ der Befehle in den Optionen */
  optionType?: string
  /** Rückfrage muss ohne Änderung bleiben (immer geprüft) */
  note?: string
  /** Rückfrage ohne Optionen ist korrekt (z. B. Lebensmittel nicht in der Liste) */
  allowEmptyOptions?: boolean
}
export interface LlmCase { id: string; origin: 'original' | 'folgeauftrag'; text: string; setup?: (s: AppState) => AppState; expect: Expect }

const withCalorieChange = (s: AppState): AppState => { const r = commit([{ type: 'update_calorie_target', kcal: 3000, scope: 'permanent' }], s, 'user', CASE_TODAY); if (!r.ok) throw new Error(r.reason); return r.state }

const withSkyrPreferred = (s: AppState): AppState => { const r = commit([{ type: 'update_food_preferences', food_name: 'Skyr', preference: 'preferred' }], s, 'user', CASE_TODAY); if (!r.ok) throw new Error(r.reason); return r.state }

export const CASES: LlmCase[] = [
  { id: 'o1', origin: 'original', text: 'Ich möchte heute 4.000 kcal essen.', expect: { kind: ['commands'], type: 'update_calorie_target', params: { kcal: 4000, scope: 'today' }, cls: 'B' } },
  { id: 'o2', origin: 'original', text: 'Setze mein Kalorienziel dauerhaft auf 2.800.', expect: { kind: ['commands'], type: 'update_calorie_target', params: { kcal: 2800, scope: 'permanent' }, cls: 'B' } },
  { id: 'o3', origin: 'original', text: 'Ändere mein Proteinziel auf 180 Gramm.', expect: { kind: ['commands'], type: 'update_macros', params: { protein_g: 180 }, cls: 'B' } },
  { id: 'o4', origin: 'original', text: 'Setze Milch auf die Einkaufsliste.', expect: { kind: ['commands'], type: 'update_shopping_list', params: { op: 'add' }, cls: 'A' } },
  { id: 'o5', origin: 'original', text: 'Ich möchte 3000 kcal essen.', expect: { kind: ['clarify'], optionType: 'update_calorie_target', note: 'Zeitbezug fehlt → nachfragen, nicht raten' } },
  { id: 'o6', origin: 'original', text: 'Erkläre mir bitte Keto in einem Satz.', expect: { kind: ['none'] } },
  { id: 'f2', origin: 'folgeauftrag', text: 'Setze mein Kalorienziel dauerhaft auf 2.800 kcal.', expect: { kind: ['commands'], type: 'update_calorie_target', params: { kcal: 2800, scope: 'permanent' }, cls: 'B' } },
  { id: 'f4', origin: 'folgeauftrag', text: 'Ich möchte morgen vegetarisch essen.', expect: { kind: ['clarify'], optionType: 'set_diets', note: 'Ernährungsweisen gelten dauerhaft → Rückfrage statt stiller Umstellung' } },
  { id: 'f5', origin: 'folgeauftrag', text: 'Entferne Milch aus meinen bevorzugten Lebensmitteln.', expect: { kind: ['clarify'], allowEmptyOptions: true, note: '„Milch“ ist kein Eintrag der Standard-Lebensmittelliste (nur Allergen-Kategorie) → Rückfrage statt Raten' } },
  { id: 'f5b', origin: 'folgeauftrag', text: 'Entferne Skyr aus meinen bevorzugten Lebensmitteln.', setup: withSkyrPreferred, expect: { kind: ['commands'], type: 'update_food_preferences', params: { preference: 'not_preferred' }, cls: 'A' } },
  { id: 'f6', origin: 'folgeauftrag', text: 'Ersetze mein heutiges Abendessen durch eine proteinreiche Alternative.', expect: { kind: ['clarify'], optionType: 'swap_meal', note: 'Alternativen, eiweißreichste zuerst' } },
  { id: 'f7', origin: 'folgeauftrag', text: 'Erhöhe meine Kalorien heute um 300.', expect: { kind: ['commands'], type: 'update_calorie_target', params: { kcal: 2500, scope: 'today' }, cls: 'B' } },
  { id: 'f8', origin: 'folgeauftrag', text: 'Setze mein Kalorienziel wieder auf den bisherigen Wert.', setup: withCalorieChange, expect: { kind: ['undo'], note: 'vorherige Änderung betraf das Kalorienziel' } },
  { id: 'f8b', origin: 'folgeauftrag', text: 'Setze mein Kalorienziel wieder auf den bisherigen Wert.', expect: { kind: ['clarify'], note: 'es gibt keine frühere Änderung → nachfragen, nichts zurücksetzen' } },
]

export interface Verdict { intent: boolean; params: boolean; cls: boolean; noUnwantedChange: boolean; details: string[] }

const subset = (got: Record<string, unknown>, want: Record<string, unknown>) => Object.entries(want).every(([k, v]) => got[k] === v)

/** Beurteilt ein Ergebnis gegen die Erwartung. `before` = Zustand vor dem Aufruf, `after` = Zustand danach (muss identisch sein). */
export function judge(outcome: LocalOutcome, c: LlmCase, before: AppState, after: AppState): Verdict {
  const d: string[] = [], e = c.expect
  const intent = e.kind.includes(outcome.kind)
  if (!intent) d.push(`Ergebnisart ${outcome.kind}, erwartet ${e.kind.join('|')}`)
  let params = true, cls = true
  const cmds = outcome.kind === 'commands' ? outcome.commands : outcome.kind === 'clarify' ? outcome.options.flatMap(o => o.commands) : []
  if (intent && (outcome.kind === 'commands' || outcome.kind === 'clarify') && (e.type || e.optionType)) {
    const want = outcome.kind === 'commands' ? e.type : e.optionType
    const typeOk = (cmds.length === 0 && !!e.allowEmptyOptions) || (cmds.length > 0 && cmds.every(x => x.type === want))
    if (!typeOk) { params = false; d.push(`Befehlstyp ${cmds.map(x => x.type).join(',') || '–'}, erwartet ${want}`) }
    if (e.params && outcome.kind === 'commands' && !cmds.every(x => subset(x, e.params!))) { params = false; d.push(`Parameter ${JSON.stringify(cmds)} ≠ ${JSON.stringify(e.params)}`) }
    if (e.params && outcome.kind === 'clarify' && e.optionType === 'update_food_preferences' && !cmds.every(x => subset(x, e.params!))) { params = false; d.push('Optionen mit falscher Präferenz') }
  }
  if (intent && e.cls && outcome.kind === 'commands' && outcome.cls !== e.cls) { cls = false; d.push(`Aktionsklasse ${outcome.cls}, erwartet ${e.cls}`) }
  const noUnwantedChange = JSON.stringify(before) === JSON.stringify(after)
  if (!noUnwantedChange) d.push('Zustand wurde verändert')
  return { intent, params, cls, noUnwantedChange, details: d }
}

export { targetFor }
