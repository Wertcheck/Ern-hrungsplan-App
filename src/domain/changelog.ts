/**
 * Änderungsprotokoll mit Undo. Gespeichert werden nur Vorher-Werte der betroffenen Teile:
 * einfache Abschnitte komplett (klein), Plan nur geänderte Tage + Metadaten, Rezepte/Lebensmittel nur geänderte/entfernte Einträge.
 * Rückgängig macht die jeweils jüngste noch nicht rückgängig gemachte Änderung (LIFO) – so bleibt der Zustand stets konsistent.
 */
import type { AppState, ChangeEntry, ChangePatch, Plan, PlanDay } from './types'

export const MAX_LOG = 25
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const SIMPLE = ['profile', 'prefs', 'shopping', 'weights', 'eaten'] as const

interface PlanBefore { full?: Plan | null; meta?: Omit<Plan, 'days'>; days?: Record<string, PlanDay>; added?: string[] }
interface ListBefore<T> { changed: Record<string, T>; added: string[] }

function diffList<T extends { id: string }>(before: T[], after: T[]): ListBefore<T> | null {
  const b = new Map(before.map(x => [x.id, x])), a = new Map(after.map(x => [x.id, x]))
  const changed: Record<string, T> = {}, added: string[] = []
  for (const [id, x] of b) if (!a.has(id) || !same(x, a.get(id))) changed[id] = x
  for (const id of a.keys()) if (!b.has(id)) added.push(id)
  return Object.keys(changed).length || added.length ? { changed, added } : null
}

function diffPlan(before: Plan | null, after: Plan | null): PlanBefore | null {
  if (same(before, after)) return null
  if (!before || !after) return { full: before }
  const { days: bd, ...bm } = before, { days: ad, ...am } = after
  const bmap = new Map(bd.map(d => [d.date, d])), amap = new Map(ad.map(d => [d.date, d]))
  const days: Record<string, PlanDay> = {}, added: string[] = []
  for (const [date, d] of bmap) if (!amap.has(date) || !same(d, amap.get(date))) days[date] = d
  for (const date of amap.keys()) if (!bmap.has(date)) added.push(date)
  return { meta: same(bm, am) ? undefined : (bm as Omit<Plan, 'days'>), days, added }
}

export function recordChange(before: AppState, after: AppState, label: string, source: 'user' | 'assistant'): AppState {
  const patches: ChangePatch[] = []
  for (const k of SIMPLE) if (!same(before[k], after[k])) patches.push({ key: k, before: before[k] })
  const pp = diffPlan(before.plan, after.plan); if (pp) patches.push({ key: 'plan', before: pp })
  const rp = diffList(before.recipes, after.recipes); if (rp) patches.push({ key: 'recipes', before: rp })
  const fp = diffList(before.foods, after.foods); if (fp) patches.push({ key: 'foods', before: fp })
  if (!patches.length) return after
  const entry: ChangeEntry = { id: `chg-${Date.now().toString(36)}${Math.floor(Math.random() * 1e5).toString(36)}`, ts: new Date().toISOString(), label: label.slice(0, 200), source, patches }
  return { ...after, changeLog: [...after.changeLog, entry].slice(-MAX_LOG) }
}

export const lastUndoable = (s: AppState): ChangeEntry | undefined => [...s.changeLog].reverse().find(e => !e.undone)

function restoreList<T extends { id: string }>(cur: T[], b: ListBefore<T>): T[] {
  const out = cur.filter(x => !b.added.includes(x.id)).map(x => (b.changed[x.id] ? b.changed[x.id] : x))
  for (const [id, item] of Object.entries(b.changed)) if (!out.some(x => x.id === id)) out.push(item)
  return out
}

export function undoLast(state: AppState): { state: AppState; entry: ChangeEntry } | null {
  const entry = lastUndoable(state)
  if (!entry) return null
  let s: AppState = { ...state }
  for (const p of entry.patches) {
    if ((SIMPLE as readonly string[]).includes(p.key)) (s as unknown as Record<string, unknown>)[p.key] = p.before
    else if (p.key === 'plan') {
      const b = p.before as PlanBefore
      if ('full' in b && b.full !== undefined && !b.meta && !b.days) s.plan = b.full ?? null
      else if (s.plan) {
        const map = new Map(s.plan.days.map(d => [d.date, d]))
        for (const date of b.added ?? []) map.delete(date)
        for (const [date, d] of Object.entries(b.days ?? {})) map.set(date, d)
        s.plan = { ...(b.meta ? { ...s.plan, ...b.meta } : s.plan), days: [...map.values()].sort((x, y) => x.date.localeCompare(y.date)) }
        // dayTargets/macroShare, die im Vorher-Zustand fehlten, müssen wieder verschwinden
        if (b.meta) { if (!('dayTargets' in b.meta)) delete s.plan.dayTargets; if (!('macroShare' in b.meta)) delete s.plan.macroShare }
      }
    } else if (p.key === 'recipes') s.recipes = restoreList(s.recipes, p.before as ListBefore<AppState['recipes'][number]>)
    else if (p.key === 'foods') s.foods = restoreList(s.foods, p.before as ListBefore<AppState['foods'][number]>)
  }
  s = { ...s, changeLog: s.changeLog.map(e => (e.id === entry.id ? { ...e, undone: true } : e)) }
  return { state: s, entry }
}
