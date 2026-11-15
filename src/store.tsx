import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { defaultState } from './domain/defaults'
import { stateSchema } from './domain/schemas'
import { analyzePlan, buildContext, type PlanAnalysis, type PlanContext } from './domain/planner'
import { kcalTarget } from './domain/nutrition'
import type { AppState } from './domain/types'

const KEY = 'ernaehrungsplan-state-v1'

function load(): AppState {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return defaultState()
    const parsed = JSON.parse(raw)
    const ok = stateSchema.safeParse(parsed)
    if (!ok.success) return defaultState()
    const d = defaultState()
    return { ...d, ...parsed, profile: { ...d.profile, ...parsed.profile }, prefs: { ...d.prefs, ...parsed.prefs }, shopping: { ...d.shopping, ...parsed.shopping } }
  } catch { return defaultState() }
}

export const parseImport = (text: string): AppState | string => {
  try {
    const j = JSON.parse(text)
    const r = stateSchema.safeParse(j)
    if (!r.success) return 'Datei hat kein gültiges Format.'
    const d = defaultState()
    return { ...d, ...j, profile: { ...d.profile, ...j.profile }, prefs: { ...d.prefs, ...j.prefs }, shopping: { ...d.shopping, ...j.shopping } }
  } catch { return 'Datei ist kein gültiges JSON.' }
}

interface Store {
  state: AppState
  update: (fn: (s: AppState) => AppState) => void
  replace: (s: AppState) => void
  reset: () => void
  ctx: PlanContext
  analysis: PlanAnalysis | null
  target: number
  saveError: boolean
}
const Ctx = createContext<Store | null>(null)
export const useStore = () => { const c = useContext(Ctx); if (!c) throw new Error('Store fehlt'); return c }

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(load)
  const [saveError, setSaveError] = useState(false)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    try { localStorage.setItem(KEY, JSON.stringify(state)); setSaveError(false) } catch { setSaveError(true) }
  }, [state])
  const update = useCallback((fn: (s: AppState) => AppState) => setState(fn), [])
  const replace = useCallback((s: AppState) => setState(s), [])
  const reset = useCallback(() => { try { localStorage.removeItem(KEY) } catch { /* ignore */ } setState(defaultState()) }, [])
  const ctx = useMemo(() => buildContext(state.foods, state.recipes, state.prefs), [state.foods, state.recipes, state.prefs])
  const analysis = useMemo(() => (state.plan ? analyzePlan(state.plan, ctx, state.profile.mealCount) : null), [state.plan, ctx, state.profile.mealCount])
  const target = useMemo(() => kcalTarget(state.profile), [state.profile])
  return <Ctx.Provider value={{ state, update, replace, reset, ctx, analysis, target, saveError }}>{children}</Ctx.Provider>
}
