/**
 * Tier 1: Strukturierte Ausgabe eines lokalen Sprachmodells → App-Befehle.
 *
 * Grundsätze:
 *  - Das Modell wählt nur eine ABSICHT mit einfachen Parametern. Es rechnet nicht (Deltas/Tagesoffsets statt Summen/Datumsarithmetik)
 *    und kennt keine IDs; diese löst der Code deterministisch auf.
 *  - Jede Antwort wird streng geparst und mit Zod geprüft. Alles Unbekannte/Unvollständige wird verworfen – es entsteht NIE eine Aktion.
 *  - Aus einer gültigen Absicht werden Engine-Befehle; die Ernährungs-Engine prüft sie danach erneut (Klassen, Grenzen, Konflikte).
 *  - Fehlende Angaben (z. B. heute/dauerhaft) werden nachgefragt, nie geraten.
 */
import { z } from 'zod'
import type { AppState, Style } from '../../domain/types'
import { STYLE_LABEL } from '../../domain/types'
import { findFood } from '../actions'
import { fold, swapOptions, type NluResult } from '../nlu'
import { kcalTarget } from '../../domain/nutrition'
import { targetFor } from '../../domain/planner'

const STYLES = ['carnivore', 'vegan', 'vegetarisch', 'pescetarisch', 'flexitarisch', 'keto', 'lowcarb', 'highprotein', 'paleo', 'mediterran', 'basisch', 'mischkost'] as const
const SLOTS = ['fruehstueck', 'mittag', 'abend', 'snack'] as const
const PREFS = ['favorite', 'unfavorite', 'preferred', 'not_preferred', 'excluded', 'allowed'] as const
const int = (min: number, max: number) => z.number().int().min(min).max(max)

export const LLM_INTENTS = ['update_calorie_target', 'update_macros', 'set_diets', 'update_food_preferences', 'swap_meal_request', 'update_shopping_list', 'restore_previous_calorie_target', 'undo_last', 'clarify', 'none'] as const

const o = <T extends z.ZodRawShape>(s: T) => z.object(s).strict()
export const llmActionSchema = z.discriminatedUnion('type', [
  o({ type: z.literal('update_calorie_target'), kcal: int(800, 6000).optional(), delta_kcal: int(-3000, 3000).optional(), scope: z.enum(['today', 'permanent', 'date']).optional(), day_offset: int(0, 30).optional() }),
  o({ type: z.literal('update_macros'), protein_g: int(0, 600).optional(), carbs_g: int(0, 1000).optional(), fat_g: int(0, 500).optional() }),
  o({ type: z.literal('set_diets'), styles: z.array(z.enum(STYLES)).min(1).max(4), mode: z.enum(['set', 'add', 'remove']).optional(), day_offset: int(0, 30).optional() }),
  o({ type: z.literal('update_food_preferences'), food_name: z.string().min(1).max(80), preference: z.enum(PREFS) }),
  o({ type: z.literal('swap_meal_request'), slot: z.enum(SLOTS), day_offset: int(0, 30).optional(), focus: z.enum(['protein', 'none']).optional() }),
  o({ type: z.literal('update_shopping_list'), op: z.enum(['add', 'remove', 'check']), name: z.string().min(1).max(80) }),
  o({ type: z.literal('restore_previous_calorie_target') }),
  o({ type: z.literal('undo_last') }),
  o({ type: z.literal('clarify'), question: z.string().min(1).max(300) }),
  o({ type: z.literal('none') }),
])
export type LlmAction = z.infer<typeof llmActionSchema>

/** JSON-Schema (als String) für die Grammatik-gestützte Erzeugung (xgrammar, Strict-Modus: nur diese Felder). */
export const LLM_JSON_SCHEMA: string = JSON.stringify({
  type: 'object',
  properties: {
    type: { enum: [...LLM_INTENTS] },
    kcal: { type: 'integer' }, delta_kcal: { type: 'integer' }, scope: { enum: ['today', 'permanent', 'date'] }, day_offset: { type: 'integer' },
    protein_g: { type: 'integer' }, carbs_g: { type: 'integer' }, fat_g: { type: 'integer' },
    styles: { type: 'array', items: { enum: [...STYLES] } }, mode: { enum: ['set', 'add', 'remove'] },
    food_name: { type: 'string' }, preference: { enum: [...PREFS] },
    op: { enum: ['add', 'remove', 'check'] }, name: { type: 'string' },
    slot: { enum: [...SLOTS] }, focus: { enum: ['protein', 'none'] }, question: { type: 'string' },
  },
  required: ['type'],
})

export const buildSystemPrompt = (): string => `Du bist der Befehlserkenner einer Ernährungsplaner-App. Du führst nichts aus, du wählst genau EINE Absicht.
Antworte NUR mit einem JSON-Objekt, ohne Text davor oder danach. Erlaubte Absichten (Feld "type"):
- update_calorie_target: Kalorienziel. Entweder "kcal" (Zielwert) oder "delta_kcal" (relative Änderung, z. B. 300 für "um 300 erhöhen", -200 für "senken"). "scope": "today" (nur heute), "permanent" (dauerhaft/ab jetzt) oder "date" mit "day_offset" (1 = morgen, 2 = übermorgen). Fehlt die Angabe heute/dauerhaft, lasse "scope" WEG.
- update_macros: Makroziele in Gramm: "protein_g", "carbs_g", "fat_g".
- set_diets: Ernährungsweise: "styles" (${STYLES.join(', ')}), "mode" set|add|remove. Gilt nur für einen bestimmten Tag ("morgen", "heute"), setze zusätzlich "day_offset".
- update_food_preferences: "food_name" und "preference" (${PREFS.join(', ')}). "Entferne X aus meinen bevorzugten Lebensmitteln" = not_preferred; "aus meinen Favoriten" = unfavorite.
- swap_meal_request: Mahlzeit austauschen: "slot" (${SLOTS.join(', ')}), optional "day_offset" (0 = heute) und "focus": "protein" bei Wunsch nach proteinreich.
- update_shopping_list: Einkaufsliste: "op" add|remove|check, "name".
- restore_previous_calorie_target: Kalorienziel wieder auf den vorherigen Wert.
- undo_last: letzte Änderung rückgängig.
- clarify: wenn etwas Wesentliches fehlt oder unklar ist. Feld "question" (deutsch, kurz).
- none: keine Änderung (Frage, Erklärung, Smalltalk).
Regeln: Rechne nie selbst. Erfinde keine Zahlen, Namen oder Felder. Allergien, Medikamente und medizinische Fragen: "none".
Beispiele:
"Ich möchte heute 3.000 kcal essen." -> {"type":"update_calorie_target","kcal":3000,"scope":"today"}
"Ich möchte 3000 kcal essen." -> {"type":"update_calorie_target","kcal":3000}
"Erhöhe meine Kalorien heute um 300." -> {"type":"update_calorie_target","delta_kcal":300,"scope":"today"}
"Erkläre mir Keto." -> {"type":"none"}`

// ---------------------------------------------------------------- strenger Parser
export type ParseResult = { ok: true; value: LlmAction } | { ok: false; error: string }

/** Erlaubt: genau ein JSON-Objekt, optional in einem einzelnen Markdown-Codeblock. Alles andere (Prosa, mehrere Objekte, Arrays) wird verworfen. */
export function parseModelOutput(text: string): ParseResult {
  let t = (text ?? '').trim()
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fence) t = fence[1].trim()
  if (!t) return { ok: false, error: 'Leere Antwort.' }
  if (!t.startsWith('{') || !t.endsWith('}')) return { ok: false, error: 'Die Antwort ist kein reines JSON-Objekt (Text vor oder nach dem JSON).' }
  let raw: unknown
  try { raw = JSON.parse(t) } catch (e) { return { ok: false, error: `Kein gültiges JSON: ${(e as Error).message.slice(0, 120)}` } }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'JSON ist kein Objekt.' }
  const r = llmActionSchema.safeParse(raw)
  if (!r.success) return { ok: false, error: `Schema verletzt: ${r.error.issues.slice(0, 3).map(i => `${i.path.join('.') || 'type'}: ${i.message}`).join('; ')}` }
  return { ok: true, value: r.data }
}

// ---------------------------------------------------------------- Auflösung in App-Befehle
export type Resolved = NluResult | { kind: 'invalid'; reason: string }
const addDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }

export function resolveLlmAction(a: LlmAction, state: AppState, today: string): Resolved {
  const none = (question: string): Resolved => ({ kind: 'clarify', question, options: [], notes: [] })
  switch (a.type) {
    case 'none': return { kind: 'none' }
    case 'clarify': return none(a.question.replace(/[<>]/g, ' ').trim())
    case 'undo_last': return { kind: 'undo' }
    case 'restore_previous_calorie_target': {
      const last = [...state.changeLog].reverse().find(e => !e.undone)
      if (last && /kalorienziel|tagesziel/i.test(last.label)) return { kind: 'undo' }
      return none(last ? `Die letzte Änderung („${last.label}“) betrifft nicht das Kalorienziel. Nenne den gewünschten Wert oder sage „Mach das rückgängig“.` : 'Es gibt keine frühere Änderung des Kalorienziels. Nenne den gewünschten Wert.')
    }
    case 'update_calorie_target': {
      if ((a.kcal === undefined) === (a.delta_kcal === undefined)) return none('Auf wie viele Kalorien soll das Ziel geändert werden?')
      const date = a.scope === 'date' || (a.day_offset && a.scope === undefined) ? addDays(today, a.day_offset ?? 0) : undefined
      const scope = a.scope ?? (a.day_offset ? 'date' : undefined)
      if (scope === 'date' && (!date || date === today)) return none('Für welchen Tag soll das Kalorienziel gelten?')
      const mk = (sc: 'today' | 'permanent' | 'date'): Record<string, unknown> & { type: string } => {
        const dd = sc === 'date' ? date : undefined
        const base = sc === 'permanent' || !state.plan ? kcalTarget(state.profile) : targetFor(state.plan, dd ?? today)
        return { type: 'update_calorie_target', kcal: Math.round(a.kcal ?? base + (a.delta_kcal as number)), scope: sc, ...(dd ? { date: dd } : {}) }
      }
      if (scope) return { kind: 'commands', commands: [mk(scope)], notes: [] }
      return { kind: 'clarify', question: 'Soll das Ziel nur heute oder dauerhaft gelten?', options: [{ label: 'Nur heute', commands: [mk('today')] }, { label: 'Dauerhaft', commands: [mk('permanent')] }], notes: [] }
    }
    case 'update_macros': {
      if (a.protein_g === undefined && a.carbs_g === undefined && a.fat_g === undefined) return none('Welches Makroziel soll auf wie viel Gramm gesetzt werden?')
      return { kind: 'commands', commands: [{ type: 'update_macros', ...(a.protein_g !== undefined ? { protein_g: a.protein_g } : {}), ...(a.carbs_g !== undefined ? { carbs_g: a.carbs_g } : {}), ...(a.fat_g !== undefined ? { fat_g: a.fat_g } : {}) }], notes: [] }
    }
    case 'set_diets': {
      const names = a.styles.map(s => STYLE_LABEL[s as Style]).join(' + ')
      const cmd = { type: 'set_diets', styles: a.styles, mode: a.mode ?? 'set' }
      if (a.day_offset !== undefined) return { kind: 'clarify', question: `Ernährungsweisen gelten bei mir dauerhaft – nur für einen Tag gibt es das nicht. Soll ich dauerhaft auf ${names} umstellen (der Plan wird ab heute neu berechnet)?`, options: [{ label: `Dauerhaft ${names}`, commands: [cmd] }], notes: [] }
      return { kind: 'commands', commands: [cmd], notes: [] }
    }
    case 'update_food_preferences': {
      const f = findFood(state.foods, a.food_name)
      if (f.food) return { kind: 'commands', commands: [{ type: 'update_food_preferences', food_name: f.food.name, preference: a.preference }], notes: [] }
      const q = fold(a.food_name)
      const cands = state.foods.filter(x => fold(x.name).startsWith(q) || fold(x.name).includes(` ${q}`)).slice(0, 4)
      if (cands.length > 1) return { kind: 'clarify', question: `Welches Lebensmittel ist „${a.food_name}“ gemeint?`, options: cands.map(x => ({ label: x.name, commands: [{ type: 'update_food_preferences', food_name: x.name, preference: a.preference }] })), notes: [] }
      return none(`„${a.food_name}“ finde ich nicht in deiner Lebensmittelliste. Wie heißt es dort genau?`)
    }
    case 'update_shopping_list': return { kind: 'commands', commands: [{ type: 'update_shopping_list', op: a.op, name: a.name.trim() }], notes: [] }
    case 'swap_meal_request': return swapOptions(state, addDays(today, a.day_offset ?? 0), a.slot, a.focus === 'protein' ? 'protein' : undefined)
  }
}
