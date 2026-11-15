import { Component, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { defaultState } from './domain/defaults'
import { clearAllStorage, loadFromStorage, saveToStorage, type KV } from './domain/persistence'
import { analyzePlan, buildContext, type PlanAnalysis, type PlanContext } from './domain/planner'
import { kcalTarget } from './domain/nutrition'
import type { AppState } from './domain/types'

const storage = (): KV | null => { try { return window.localStorage } catch { return null } }

interface Store {
  state: AppState
  update: (fn: (s: AppState) => AppState) => void
  replace: (s: AppState) => void
  /** Löscht alle lokalen Anwendungsdaten und schreibt nichts zurück */
  reset: () => string[]
  ctx: PlanContext
  analysis: PlanAnalysis | null
  target: number
  saveError: boolean
  warnings: string[]
  dismissWarnings: () => void
}
const Ctx = createContext<Store | null>(null)
export const useStore = () => { const c = useContext(Ctx); if (!c) throw new Error('Store fehlt'); return c }

export function StoreProvider({ children }: { children: ReactNode }) {
  const initial = useMemo(() => { const s = storage(); return s ? loadFromStorage(s) : { state: defaultState(), warnings: ['Der Browser-Speicher ist nicht zugänglich. Änderungen werden nicht gespeichert.'] } }, [])
  const [state, setState] = useState<AppState>(initial.state)
  const [warnings, setWarnings] = useState<string[]>(initial.warnings)
  const [saveError, setSaveError] = useState(false)
  /** true nach „Alle Daten löschen“, bis zur nächsten echten Änderung – verhindert das Zurückschreiben des Standardzustands */
  const skipPersist = useRef(false)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    if (skipPersist.current) return
    const s = storage()
    if (!s) return
    setSaveError(!saveToStorage(s, state))
  }, [state])
  const update = useCallback((fn: (s: AppState) => AppState) => { skipPersist.current = false; setState(fn) }, [])
  const replace = useCallback((s: AppState) => { skipPersist.current = false; setState(s) }, [])
  const reset = useCallback(() => {
    skipPersist.current = true
    const s = storage()
    const removed = s ? clearAllStorage(s) : []
    setState(defaultState()); setWarnings([])
    return removed
  }, [])
  const ctx = useMemo(() => buildContext(state.foods, state.recipes, state.prefs), [state.foods, state.recipes, state.prefs])
  const analysis = useMemo(() => (state.plan ? analyzePlan(state.plan, ctx, state.profile.mealCount) : null), [state.plan, ctx, state.profile.mealCount])
  const target = useMemo(() => kcalTarget(state.profile), [state.profile])
  const dismissWarnings = useCallback(() => setWarnings([]), [])
  return <Ctx.Provider value={{ state, update, replace, reset, ctx, analysis, target, saveError, warnings, dismissWarnings }}>{children}</Ctx.Provider>
}

/** Fängt Laufzeitfehler ab, damit nie ein leerer weißer Bildschirm entsteht; Daten bleiben unangetastet. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div role="alert" style={{ maxWidth: 560, margin: '10vh auto', padding: 24, fontFamily: 'system-ui', lineHeight: 1.5 }}>
        <h1 style={{ fontFamily: 'Georgia,serif', color: '#1f3f1c' }}>Etwas ist schiefgelaufen</h1>
        <p>Die Anzeige ist auf einen Fehler gestoßen. Deine gespeicherten Daten wurden nicht verändert.</p>
        <p style={{ color: '#6b705f', fontSize: 14 }}>Technische Meldung: {this.state.error.message}</p>
        <button onClick={() => location.reload()} style={{ padding: '10px 20px', borderRadius: 999, background: '#2f5d2a', color: '#fff', border: 0, marginRight: 8 }}>Neu laden</button>
        <button onClick={() => { try { const s = window.localStorage; const raw = s.getItem('ernaehrungsplan-state-v1'); if (raw) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([raw], { type: 'application/json' })); a.download = 'ernaehrungsplan-rohdaten.json'; a.click() } } catch { /* ignorieren */ } }}
          style={{ padding: '10px 20px', borderRadius: 999, border: '1px solid #e8dfc8', background: '#fff' }}>Rohdaten sichern</button>
      </div>
    )
  }
}
