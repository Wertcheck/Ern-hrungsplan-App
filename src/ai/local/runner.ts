import type { AppState } from '../../domain/types'
import { evaluateBatch } from '../engine'
import type { NluResult } from '../nlu'
import { HostError, type ChatMessage, type ChatStats, type LlmEngineHost } from './host'
import { LLM_JSON_SCHEMA, buildSystemPrompt, parseModelOutput, resolveLlmAction, type LlmAction } from './llmAction'

export interface Attempt { output: string; parseError?: string; stats?: ChatStats; action?: LlmAction }
export type LocalOutcome =
  | { kind: 'commands'; commands: Record<string, unknown>[]; cls: 'A' | 'B'; notes: string[] }
  | { kind: 'clarify'; question: string; options: { label: string; commands: Record<string, unknown>[] }[] }
  | { kind: 'undo' }
  | { kind: 'none' }
  /** Modellantwort unbrauchbar oder von der Engine abgelehnt – es wird NICHTS ausgeführt. */
  | { kind: 'rejected'; reason: string }
  | { kind: 'failed'; code: HostError['code']; message: string }
export interface LocalResult { outcome: LocalOutcome; attempts: Attempt[]; llmAction?: LlmAction }

export interface InterpretOptions { maxAttempts?: number; useGrammar?: boolean; maxTokens?: number; signal?: AbortSignal }

/**
 * Lässt das lokale Modell eine Absicht bestimmen. Begrenzte Wiederholung NUR bei unbrauchbarer Ausgabe (kein JSON/Schema verletzt),
 * mit der konkreten Fehlermeldung als Rückmeldung. Domänenfehler (Engine lehnt ab) werden nicht wiederholt. Niemals wird ein Zustand verändert:
 * das Ergebnis enthält nur Befehle, die der Aufrufer anschließend über Vorschau/Bestätigung (Klasse B) bzw. commit (Klasse A) ausführt.
 */
export async function interpret(host: LlmEngineHost, text: string, state: AppState, today: string, o: InterpretOptions = {}): Promise<LocalResult> {
  const max = Math.max(1, Math.min(3, o.maxAttempts ?? 2))
  const messages: ChatMessage[] = [{ role: 'system', content: buildSystemPrompt() }, { role: 'user', content: text }]
  const attempts: Attempt[] = []
  for (let i = 0; i < max; i++) {
    let out: { text: string; stats: ChatStats }
    try { out = await host.run(messages, { maxTokens: o.maxTokens ?? 160, schema: o.useGrammar ? LLM_JSON_SCHEMA : undefined, signal: o.signal }) }
    catch (e) {
      const he = e instanceof HostError ? e : new HostError('engine', String((e as Error)?.message ?? e))
      // Ein Engine-Fehler wird nicht „weg-wiederholt“, sondern gemeldet; die Engine stellt sich beim nächsten Aufruf selbst wieder her.
      return { outcome: { kind: 'failed', code: he.code, message: he.message }, attempts }
    }
    const p = parseModelOutput(out.text)
    if (!p.ok) {
      attempts.push({ output: out.text, parseError: p.error, stats: out.stats })
      messages.push({ role: 'assistant', content: out.text.slice(0, 400) }, { role: 'user', content: `Ungültig: ${p.error} Antworte jetzt NUR mit einem JSON-Objekt nach dem Schema für den ursprünglichen Satz: ${text}` })
      continue
    }
    attempts.push({ output: out.text, stats: out.stats, action: p.value })
    return { outcome: toOutcome(resolveLlmAction(p.value, state, today), state, today), attempts, llmAction: p.value }
  }
  return { outcome: { kind: 'rejected', reason: `Das lokale Modell lieferte nach ${max} Versuch(en) keine gültige Antwort (${attempts[attempts.length - 1]?.parseError ?? 'unbekannt'}). Es wurde nichts geändert.` }, attempts }
}

export function toOutcome(r: NluResult | { kind: 'invalid'; reason: string }, state: AppState, today: string): LocalOutcome {
  switch (r.kind) {
    case 'none': return { kind: 'none' }
    case 'undo': return { kind: 'undo' }
    case 'refuse': return { kind: 'rejected', reason: r.text }
    case 'invalid': return { kind: 'rejected', reason: r.reason }
    case 'clarify': return { kind: 'clarify', question: r.question, options: r.options.map(x => ({ label: x.label, commands: x.commands })) }
    case 'commands': {
      const b = evaluateBatch(r.commands, state, today)
      if (!b.ok) return { kind: 'rejected', reason: `Die Ernährungs-Engine lehnt das ab: ${b.items.filter(i => !i.ev.ok).map(i => (i.ev as { reason: string }).reason).join(' ')}` }
      return { kind: 'commands', commands: r.commands, cls: b.cls, notes: r.notes }
    }
  }
}
