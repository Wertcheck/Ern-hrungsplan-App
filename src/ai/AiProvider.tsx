import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useStore } from '../store'
import { AiClient, AiError } from './client'
import { buildAiContext, type BuiltContext } from './context'
import { confirmProposal, validateProposal } from './actions'
import { localAnswer } from './local'
import type { AiStatus, Proposal } from './types'
import type { ChatAction, ChatMessage } from '../domain/types'
import { buildContext } from '../domain/planner'

const MAX_CHAT = 60
const HISTORY_SENT = 12
const uid = () => `c${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
export const todayISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10) }

export interface Draft { content: string; provider?: string; model?: string; fallbackUsed?: boolean }
export interface AiApi {
  client: AiClient
  open: boolean; setOpen: (v: boolean) => void
  status: AiStatus | null; statusError: AiError | null; refreshStatus: () => Promise<void>
  /** cloud = Anbieter-KI; local = lokaler Berater (ohne KI) */
  mode: 'cloud' | 'local'; modeReason: string
  busy: boolean; draft: Draft | null
  send: (text: string) => Promise<void>; stop: () => void
  newConversation: () => void; clearAll: () => void
  applyAction: (msgId: string, actionId: string) => void; dismissAction: (msgId: string, actionId: string) => void
  previewContext: (text: string) => BuiltContext
  lastContext: BuiltContext | null
}
const Ctx = createContext<AiApi | null>(null)
export const useAi = () => { const c = useContext(Ctx); if (!c) throw new Error('AiProvider fehlt'); return c }

export function AiProvider({ children, client }: { children: ReactNode; client?: AiClient }) {
  const { state, update, ctx, analysis, target } = useStore()
  const cl = useMemo(() => client ?? new AiClient(), [client])
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [statusError, setStatusError] = useState<AiError | null>(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [lastContext, setLast] = useState<BuiltContext | null>(null)
  const abort = useRef<AbortController | null>(null)
  const stateRef = useRef(state); stateRef.current = state

  const refreshStatus = useCallback(async () => {
    try { setStatus(await cl.status()); setStatusError(null) } catch (e) { setStatus(null); setStatusError(e as AiError) }
  }, [cl])
  useEffect(() => { void refreshStatus() }, [refreshStatus])
  useEffect(() => { const on = () => void refreshStatus(); window.addEventListener('online', on); window.addEventListener('offline', on); return () => { window.removeEventListener('online', on); window.removeEventListener('offline', on) } }, [refreshStatus])

  const { mode, modeReason } = useMemo((): { mode: 'cloud' | 'local'; modeReason: string } => {
    if (!state.ai.consent) return { mode: 'local', modeReason: 'KI-Nutzung noch nicht bestätigt (Datenübertragung)' }
    if (statusError) return { mode: 'local', modeReason: statusError.code === 'offline' ? 'Offline' : 'KI-Backend nicht erreichbar' }
    if (!status) return { mode: 'local', modeReason: 'Status wird geladen' }
    if (!status.enabled) return { mode: 'local', modeReason: 'KI in den Einstellungen deaktiviert' }
    if (!status.providers[status.provider]?.configured) return { mode: 'local', modeReason: 'Kein Schlüssel für den gewählten Anbieter hinterlegt' }
    if (status.needs_model) return { mode: 'local', modeReason: 'Kein Modell gewählt' }
    if (status.usage.limit_reached) return { mode: 'local', modeReason: 'Monatliches Kostenlimit erreicht' }
    return { mode: 'cloud', modeReason: '' }
  }, [state.ai.consent, status, statusError])

  const commit = useCallback((m: ChatMessage) => update(s => ({ ...s, ai: { ...s.ai, chat: [...s.ai.chat, m].slice(-MAX_CHAT) } })), [update])
  const toActions = useCallback((props: Proposal[], extraRejected: { type: string; reason: string }[] = []): ChatAction[] => {
    const st = stateRef.current, c = buildContext(st.foods, st.recipes, st.prefs)
    const acts: ChatAction[] = props.map(p => { const v = validateProposal(p, st, c); return v.ok ? { id: uid(), proposal: p as unknown as Record<string, unknown>, status: 'pending' as const, summary: { title: v.preview.title, lines: v.preview.lines } } : { id: uid(), proposal: p as unknown as Record<string, unknown>, status: 'rejected' as const, note: v.reason } })
    for (const r of extraRejected) acts.push({ id: uid(), proposal: { type: r.type }, status: 'rejected', note: r.reason })
    return acts
  }, [])

  const previewContext = useCallback((text: string) => buildAiContext(state, ctx, text, todayISO(), target), [state, ctx, target])

  const answerLocally = useCallback((text: string, note?: string) => {
    const st = stateRef.current, c = buildContext(st.foods, st.recipes, st.prefs)
    const a = localAnswer(text, st, c, analysis, target, todayISO())
    commit({ id: uid(), role: 'assistant', content: (note ? `${note}\n\n` : '') + a.text, ts: new Date().toISOString(), provider: 'local', model: 'Lokaler Berater (ohne KI)', actions: a.proposals.length ? toActions(a.proposals) : undefined })
  }, [analysis, target, commit, toActions])

  const send = useCallback(async (raw: string) => {
    const text = raw.trim().slice(0, 4000)
    if (!text || busy) return
    commit({ id: uid(), role: 'user', content: text, ts: new Date().toISOString() })
    if (mode === 'local') { answerLocally(text); return }
    const built = buildAiContext(stateRef.current, ctx, text, todayISO(), target)
    setLast(built)
    const hist = [...stateRef.current.ai.chat.filter(m => !m.error && m.provider !== 'local' && m.content.trim()), { role: 'user' as const, content: text }].slice(-HISTORY_SENT).map(m => ({ role: m.role, content: m.content }))
    const messages = hist[0]?.role === 'assistant' ? hist.slice(1) : hist
    setBusy(true); setDraft({ content: '' })
    const ctl = new AbortController(); abort.current = ctl
    let acc = '', provider: string | undefined, model: string | undefined, fb = false, pending: { proposals: Proposal[]; rejected: { type: string; reason: string }[] } | null = null, errMsg: string | undefined
    try {
      await cl.chat({ messages, context: built.payload }, {
        meta: m => { provider = m.provider; model = m.model; fb = m.fallback_used; setDraft(d => ({ ...(d ?? { content: acc }), provider, model, fallbackUsed: fb })) },
        delta: t => { acc += t; setDraft({ content: acc, provider, model, fallbackUsed: fb }) },
        actions: a => { pending = a },
        error: e => { errMsg = e.message },
      }, ctl.signal)
    } catch (e) {
      const err = e as AiError
      errMsg = err.code === 'aborted' ? 'Abgebrochen.' : err.message
      if (err.code === 'offline' || err.code === 'backend_unreachable') void refreshStatus()
      if (err.code === 'http' && err.apiCode === 'cost_limit_reached') void refreshStatus()
    } finally {
      setBusy(false); setDraft(null); abort.current = null
    }
    const hadText = acc.trim().length > 0
    commit({ id: uid(), role: 'assistant', content: acc, ts: new Date().toISOString(), provider, model: model ? `${model}${fb ? ' (Ersatzanbieter)' : ''}` : undefined, error: errMsg,
      actions: pending ? toActions((pending as { proposals: Proposal[] }).proposals, (pending as { rejected: { type: string; reason: string }[] }).rejected) : undefined })
    // Ohne KI-Antwort (Offline/Backend aus/Fehler): lokaler Berater antwortet, damit die Unterhaltung nicht ins Leere läuft
    if (!hadText && errMsg && errMsg !== 'Abgebrochen.') answerLocally(text, 'Die KI war nicht verfügbar – hier die Antwort des lokalen Beraters:')
  }, [busy, mode, ctx, target, cl, commit, answerLocally, toActions, refreshStatus])

  const stop = useCallback(() => abort.current?.abort(), [])
  const newConversation = useCallback(() => update(s => ({ ...s, ai: { ...s.ai, chat: [] } })), [update])
  const clearAll = newConversation

  const setActionState = (msgId: string, actionId: string, status: ChatAction['status'], note?: string) => (s: typeof state) => ({
    ...s, ai: { ...s.ai, chat: s.ai.chat.map(m => (m.id === msgId ? { ...m, actions: m.actions?.map(a => (a.id === actionId ? { ...a, status, note } : a)) } : m)) },
  })
  const applyAction = useCallback((msgId: string, actionId: string) => update(s => {
    const a = s.ai.chat.find(m => m.id === msgId)?.actions?.find(x => x.id === actionId)
    if (!a || a.status !== 'pending') return s
    const r = confirmProposal(a.proposal, s)          // Engine validiert erneut gegen den aktuellen Zustand
    if (!r.ok) return setActionState(msgId, actionId, 'rejected', r.reason)(s)
    // Weitere Alternativen für dieselbe Mahlzeit aus derselben Nachricht sind nach der Wahl überholt
    const mealId = (a.proposal as { meal_id?: string }).meal_id
    const next = setActionState(msgId, actionId, 'applied')(r.state)
    return !mealId ? next : { ...next, ai: { ...next.ai, chat: next.ai.chat.map(m => (m.id !== msgId ? m : { ...m, actions: m.actions?.map(x => (x.id !== actionId && x.status === 'pending' && (x.proposal as { meal_id?: string }).meal_id === mealId ? { ...x, status: 'dismissed' as const, note: 'andere Variante gewählt' } : x)) })) } }
  }), [update])
  const dismissAction = useCallback((msgId: string, actionId: string) => update(setActionState(msgId, actionId, 'dismissed')), [update])

  const api: AiApi = { client: cl, open, setOpen, status, statusError, refreshStatus, mode, modeReason, busy, draft, send, stop, newConversation, clearAll, applyAction, dismissAction, previewContext, lastContext }
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>
}
