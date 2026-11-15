import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useStore } from '../store'
import { Btn, Chip, Notice, Sheet, cx } from '../ui/kit'
import { useAi } from './AiProvider'
import { validateProposal } from './actions'
import type { ChatAction, ChatMessage } from '../domain/types'

const SUGGESTIONS = ['Ich möchte heute 4.000 kcal essen', 'Tausche das Mittagessen heute', 'Welche Nährstoffe fehlen im Plan?', 'Erkläre die Ernährungsweise Keto']
const TYPE_LABEL: Record<string, string> = { swap_meal: 'Mahlzeit austauschen', add_meal: 'Mahlzeit ergänzen', remove_meal: 'Mahlzeit entfernen', set_portion: 'Portion anpassen', create_recipe: 'Neues Rezept', exclude_food: 'Lebensmittel ausschließen', add_shopping_item: 'Zur Einkaufsliste' }
const PROVIDER_LABEL: Record<string, string> = { openai: 'OpenAI', anthropic: 'Claude', mock: 'Test-Anbieter', local: 'Lokal' }

/** Minimale, sichere Darstellung: **fett** und Aufzählungen; alles andere bleibt Text (React escaped). */
function Rich({ text }: { text: string }) {
  const parts = (s: string): ReactNode[] => s.split(/(\*\*[^*]+\*\*)/g).map((p, i) => (p.startsWith('**') && p.endsWith('**') ? <b key={i}>{p.slice(2, -2)}</b> : <Fragment key={i}>{p}</Fragment>))
  return <div className="space-y-1.5 text-[15px] leading-relaxed">{text.split('\n').map((l, i) => (l.trim() === '' ? <div key={i} className="h-1" /> : <p key={i} className={l.startsWith('• ') ? 'pl-3 -indent-3' : ''}>{parts(l)}</p>))}</div>
}

function ActionCard({ msg, a }: { msg: ChatMessage; a: ChatAction }) {
  const { state, ctx } = useStore()
  const ai = useAi()
  const batch = a.proposal.type === 'batch'
  const v = useMemo(() => (a.status === 'pending' && !batch ? validateProposal(a.proposal, state, ctx) : null), [a, state, ctx, batch])
  const tone = a.status === 'applied' ? 'border-forest bg-moss/60' : a.status === 'rejected' ? 'border-danger/40 bg-danger/5' : 'border-sand bg-white/80'
  return (
    <div className={cx('rounded-2xl border p-3 mt-2 text-sm', tone)}>
      <div className="font-semibold mb-1">{v?.ok ? v.preview.title : a.summary?.title ?? TYPE_LABEL[String(a.proposal.type)] ?? 'Vorschlag'}</div>
      {a.status !== 'pending' && a.summary && <ul className="space-y-0.5 text-[13px] text-muted">{a.summary.lines.slice(0, 2).map((l, i) => <li key={i}>{l}</li>)}</ul>}
      {batch && a.status === 'pending' && a.summary && <ul className="space-y-0.5 text-[13px]">{a.summary.lines.map((l, i) => <li key={i} className={l.startsWith('⚠') ? 'text-warn' : ''}>{l}</li>)}</ul>}
      {v?.ok && <><ul className="space-y-0.5 text-[13px]">{v.preview.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>{v.preview.warnings.map(w => <div key={w} className="text-warn text-xs mt-1">⚠ {w}</div>)}</>}
      {a.status === 'pending' && v && !v.ok && <div className="text-danger text-xs">Von der Engine abgelehnt: {v.reason}</div>}
      {a.status === 'rejected' && <div className="text-danger text-xs">Abgelehnt: {a.note ?? 'Engine-Prüfung nicht bestanden'}</div>}
      {a.status === 'applied' && <div className="text-forest-dark text-xs">✓ Übernommen (nach Prüfung durch die Ernährungs-Engine){batch ? ' · rückgängig machbar' : ''}</div>}
      {a.status === 'dismissed' && <div className="text-muted text-xs">Verworfen</div>}
      {a.status === 'pending' && (v?.ok || batch) && (
        <div className="flex gap-2 mt-2">
          <Btn className="!px-4 !py-1.5 !min-h-9 text-sm" onClick={() => ai.applyAction(msg.id, a.id)}>{batch ? 'Bestätigen' : 'Übernehmen'}</Btn>
          <Btn variant="ghost" className="!px-4 !py-1.5 !min-h-9 text-sm" onClick={() => ai.dismissAction(msg.id, a.id)}>Verwerfen</Btn>
        </div>
      )}
    </div>
  )
}

function Bubble({ m }: { m: ChatMessage }) {
  const mine = m.role === 'user'
  return (
    <div className={cx('flex', mine ? 'justify-end' : 'justify-start')}>
      <div className={cx('max-w-[92%] rounded-3xl px-4 py-3', mine ? 'bg-forest text-white rounded-br-lg' : 'bg-paper border border-sand/80 rounded-bl-lg')}>
        {mine ? <p className="whitespace-pre-wrap text-[15px]">{m.content}</p> : m.content ? <Rich text={m.content} /> : null}
        {m.error && <div role="alert" className="mt-2 text-xs rounded-xl bg-danger/10 text-danger px-2.5 py-1.5">{m.error}</div>}
        {m.actions?.map(a => <ActionCard key={a.id} msg={m} a={a} />)}
        {!mine && m.provider && <div className="mt-2 text-[11px] text-muted">{PROVIDER_LABEL[m.provider] ?? m.provider}{m.model ? ` · ${m.model}` : ''}</div>}
      </div>
    </div>
  )
}

function Consent() {
  const { update } = useStore()
  const ai = useAi()
  return (
    <div className="rounded-3xl bg-moss/50 border border-olive/40 p-4 text-sm space-y-2">
      <p className="font-semibold">Bevor die Cloud-KI antwortet</p>
      <p>Fragen und der <b>minimal nötige Ernährungskontext</b> (Ernährungsweisen, Allergien/Ausschlüsse, Kalorienziel – und nur bei Bedarf Plan-Ausschnitt, Rezeptnamen usw.) werden über dein lokales Backend an den gewählten Anbieter (OpenAI oder Claude) gesendet. Körperdaten, Einkaufsliste und Gewichtsverlauf nur, wenn du sie unter Einstellungen freigibst. Es werden keine Namen oder Kontaktdaten übertragen.</p>
      <p className="text-muted">Ohne Einwilligung antwortet der lokale Berater (ohne KI, ohne Datenübertragung).</p>
      <div className="flex gap-2 pt-1"><Btn onClick={() => update(s => ({ ...s, ai: { ...s.ai, consent: true } }))}>Einverstanden</Btn><Btn variant="ghost" onClick={() => ai.setOpen(true)}>Lokal bleiben</Btn></div>
    </div>
  )
}

export function ChatPanel() {
  const { state } = useStore()
  const ai = useAi()
  const [input, setInput] = useState('')
  const [showData, setShowData] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { if (state.ai.chat.length || ai.draft) end.current?.scrollIntoView({ block: 'end' }) }, [state.ai.chat.length, ai.draft?.content])
  const submit = () => { const t = input.trim(); if (!t) return; setInput(''); void ai.send(t) }
  const cloud = ai.mode === 'cloud'
  const provider = ai.status?.provider
  const preview = showData ? ai.previewContext(input || 'Plan Mahlzeit tausch Rezept') : null
  return (
    <section aria-label="Ernährungsberater" className="flex flex-col h-full bg-cream">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-sand/70 bg-paper/80">
        <button className="lg:hidden h-10 w-10 rounded-full bg-moss text-lg" aria-label="Zurück zur App" onClick={() => ai.setOpen(false)}>←</button>
        <span className="h-9 w-9 rounded-xl bg-forest grid place-items-center text-lg" aria-hidden>🌿</span>
        <div className="min-w-0 flex-1">
          <h2 className="font-serif text-lg leading-tight">Ernährungsberater</h2>
          <p className="text-[11px] text-muted truncate" data-testid="ai-mode">{cloud ? `${PROVIDER_LABEL[provider ?? ''] ?? provider} · ${ai.status?.model}` : `Lokaler Berater (ohne KI) – ${ai.modeReason}`}</p>
        </div>
        {ai.undoLabel && <button className="text-xs underline text-forest px-1" data-testid="undo-btn" title={ai.undoLabel} onClick={() => ai.undoChange()}>Rückgängig</button>}
        <button className="text-xs underline text-forest px-1" onClick={() => setShowData(true)}>Daten</button>
        <button className="text-xs underline text-forest px-1" onClick={() => { if (!state.ai.chat.length || confirm('Unterhaltung löschen?')) ai.newConversation() }}>Neu</button>
        <button className="hidden lg:block h-9 w-9 rounded-full bg-moss" aria-label="Berater schließen" onClick={() => ai.setOpen(false)}>×</button>
      </header>
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-3" aria-live="polite">
        {!state.ai.consent && <Consent />}
        {state.ai.chat.length === 0 && !ai.draft && (
          <div className="text-center text-sm text-muted py-6 space-y-3">
            <p>Frag mich zu deinem Plan, zu Nährwerten oder Ernährungsweisen. Änderungen schlage ich nur vor – du bestätigst, die Engine prüft.</p>
            <div className="flex flex-wrap gap-2 justify-center">{SUGGESTIONS.map(s => <Chip key={s} onClick={() => void ai.send(s)}>{s}</Chip>)}</div>
          </div>
        )}
        {state.ai.chat.map(m => <Bubble key={m.id} m={m} />)}
        {ai.draft && (
          <div className="flex justify-start"><div className="max-w-[92%] rounded-3xl rounded-bl-lg px-4 py-3 bg-paper border border-sand/80">
            {ai.draft.content ? <Rich text={ai.draft.content} /> : <span className="text-muted text-sm" role="status">Berater denkt nach …</span>}
            <span className="inline-block w-1.5 h-4 bg-forest/60 ml-0.5 animate-pulse align-middle" aria-hidden />
            {ai.draft.provider && <div className="mt-2 text-[11px] text-muted">{PROVIDER_LABEL[ai.draft.provider] ?? ai.draft.provider} · {ai.draft.model}{ai.draft.fallbackUsed ? ' (Ersatzanbieter)' : ''}</div>}
          </div></div>
        )}
        <div ref={end} />
      </div>
      <div className="border-t border-sand/70 bg-paper/90 p-3 safe-b">
        {!cloud && state.ai.consent && ai.modeReason && <p className="text-[11px] text-muted mb-1.5">Antwort ohne Cloud-KI: {ai.modeReason}.</p>}
        <div className="flex gap-2 items-end">
          <textarea aria-label="Nachricht an den Berater" rows={2} maxLength={4000} value={input} onChange={e => setInput(e.target.value)} placeholder="Nachricht …"
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
            className="flex-1 resize-none rounded-2xl border border-sand bg-white px-3.5 py-2.5 focus:border-forest outline-none" />
          {ai.busy ? <Btn variant="danger" onClick={ai.stop} aria-label="Antwort abbrechen">■</Btn> : <Btn onClick={submit} disabled={!input.trim()} aria-label="Senden">➤</Btn>}
        </div>
        <p className="text-[11px] text-muted mt-1.5">Informations- und Planungshilfe – kein Arzt, keine Diagnosen. Bei gesundheitlichen Fragen fachliche Beratung einholen.</p>
      </div>
      {showData && preview && (
        <Sheet title="Gesendete Daten" onClose={() => setShowData(false)} wide>
          <Notice level="info">{cloud ? `Bei der nächsten Anfrage gehen diese Angaben über dein lokales Backend an ${PROVIDER_LABEL[provider ?? ''] ?? provider}.` : 'Im lokalen Modus wird nichts übertragen. So würde der Kontext bei aktivierter KI aussehen.'} Je nach Frage wird weniger gesendet; Vorschau für den aktuellen Text im Eingabefeld.</Notice>
          <p className="text-sm mt-3"><b>Enthaltene Bereiche:</b> {preview.included.join(', ')}</p>
          <pre className="mt-2 text-xs bg-white/80 border border-sand rounded-2xl p-3 overflow-auto max-h-[50vh]">{preview.json}</pre>
          <p className="text-xs text-muted mt-2">{preview.chars.toLocaleString('de-DE')} Zeichen. Es werden keine Namen, E-Mail-Adressen oder API-Schlüssel übertragen.</p>
        </Sheet>
      )}
    </section>
  )
}
