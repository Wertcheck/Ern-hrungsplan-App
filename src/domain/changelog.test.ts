import { describe, expect, it } from 'vitest'
import { defaultState } from './defaults'
import { MAX_LOG, lastUndoable, recordChange, undoLast } from './changelog'
import { generatePlan } from './planner'
import { parseJsonText } from './persistence'
import type { AppState } from './types'

const base = (): AppState => {
  const s = defaultState(); s.onboarded = true
  s.plan = generatePlan({ profile: s.profile, foods: s.foods, recipes: s.recipes, prefs: s.prefs, startDate: '2026-11-16', days: 7, seed: 2 })
  return s
}
const j = (x: unknown) => JSON.stringify(x)
const strip = (s: AppState) => { const { changeLog: _c, ...r } = s; return j(r) }

describe('Änderungsprotokoll und Undo', () => {
  it('keine Änderung → kein Eintrag', () => { const s = base(); expect(recordChange(s, { ...s }, 'nichts', 'user').changeLog).toHaveLength(0) })
  it('einfache Abschnitte: Profil/Präferenzen/Einkauf/Gewicht – Undo stellt exakt den Vorzustand her', () => {
    const s = base()
    const after: AppState = { ...s, profile: { ...s.profile, kcalMode: 'manual', kcalManual: 3100 }, weights: [{ date: '2026-11-15', kg: 80 }], shopping: { ...s.shopping, manual: [{ id: 'a', name: 'Seife', amount: '', checked: false }] }, prefs: { ...s.prefs, excludedFoods: ['tofu'] } }
    const logged = recordChange(s, after, 'Mehrfach', 'assistant')
    expect(logged.changeLog).toHaveLength(1); expect(logged.changeLog[0].patches.map(p => p.key).sort()).toEqual(['prefs', 'profile', 'shopping', 'weights'])
    const u = undoLast(logged)!
    expect(strip(u.state)).toBe(strip(s)); expect(u.state.changeLog[0].undone).toBe(true); expect(lastUndoable(u.state)).toBeUndefined()
  })
  it('Plan: nur geänderte Tage werden gespeichert (klein), Undo stellt Tage, Tagesziele und Metadaten wieder her', () => {
    const s = base(), day = s.plan!.days[2]
    const after: AppState = { ...s, plan: { ...s.plan!, dayTargets: { [day.date]: 4000 }, days: s.plan!.days.map(d => (d.date === day.date ? { ...d, meals: d.meals.slice(1) } : d)) } }
    const logged = recordChange(s, after, 'Tagesziel', 'assistant')
    const patch = logged.changeLog[0].patches[0]
    expect(patch.key).toBe('plan'); expect(Object.keys((patch.before as { days: object }).days)).toEqual([day.date])
    expect(j(logged.changeLog[0]).length).toBeLessThan(6000)       // statt ≈ 30 KB für den ganzen Plan
    const u = undoLast(logged)!
    expect(strip(u.state)).toBe(strip(s)); expect(u.state.plan!.dayTargets).toBeUndefined()
  })
  it('Plan neu erzeugt/gelöscht/hinzugefügte Tage', () => {
    const s = base()
    const none = recordChange(s, { ...s, plan: null }, 'Plan gelöscht', 'user'); expect(strip(undoLast(none)!.state)).toBe(strip(s))
    const fewer = recordChange(s, { ...s, plan: { ...s.plan!, days: s.plan!.days.slice(0, 5) } }, 'kürzer', 'user')
    expect(strip(undoLast(fewer)!.state)).toBe(strip(s))
    const more = recordChange(s, { ...s, plan: { ...s.plan!, days: [...s.plan!.days, { date: '2026-11-23', meals: [] }] } }, 'länger', 'user')
    expect(undoLast(more)!.state.plan!.days).toHaveLength(7)
    const fresh = { ...defaultState(), onboarded: true }; const gen = recordChange(fresh, s, 'Plan erstellt', 'user'); expect(undoLast(gen)!.state.plan).toBeNull()
  })
  it('Rezepte/Lebensmittel: Hinzufügen, Ändern, Entfernen werden umgekehrt', () => {
    const s = base(), r0 = s.recipes[0], f0 = s.foods[0]
    const after: AppState = { ...s, recipes: [...s.recipes.slice(1).map(r => (r.id === s.recipes[1].id ? { ...r, name: 'GEÄNDERT' } : r)), { ...r0, id: 'neu', name: 'Neu' }], foods: s.foods.filter(f => f.id !== f0.id) }
    const logged = recordChange(s, after, 'Rezepte/Foods', 'assistant')
    const u = undoLast(logged)!.state
    expect(u.recipes.map(r => r.id).sort()).toEqual(s.recipes.map(r => r.id).sort()); expect(u.recipes.find(r => r.id === s.recipes[1].id)!.name).toBe(s.recipes[1].name)
    expect(u.foods.some(f => f.id === f0.id)).toBe(true); expect(u.recipes.some(r => r.id === 'neu')).toBe(false)
  })
  it('mehrere Änderungen werden in umgekehrter Reihenfolge zurückgenommen (LIFO)', () => {
    const s0 = base()
    const s1 = recordChange(s0, { ...s0, profile: { ...s0.profile, age: 50 } }, 'Alter 50', 'user')
    const s2 = recordChange(s1, { ...s1, profile: { ...s1.profile, age: 60 } }, 'Alter 60', 'assistant')
    const u1 = undoLast(s2)!; expect(u1.state.profile.age).toBe(50); expect(u1.entry.label).toBe('Alter 60')
    const u2 = undoLast(u1.state)!; expect(u2.state.profile.age).toBe(s0.profile.age); expect(undoLast(u2.state)).toBeNull()
  })
  it('Protokoll ist auf 25 Einträge begrenzt, Chat/Protokoll selbst werden nicht als Änderung gezählt', () => {
    let s = base()
    for (let i = 0; i < MAX_LOG + 5; i++) s = recordChange(s, { ...s, profile: { ...s.profile, age: 20 + (i % 70) } }, `Schritt ${i}`, 'user')
    expect(s.changeLog).toHaveLength(MAX_LOG)
    const chat = recordChange(s, { ...s, ai: { ...s.ai, chat: [{ id: 'x', role: 'user', content: 'hi', ts: '' }] } }, 'Chat', 'user')
    expect(chat.changeLog).toHaveLength(MAX_LOG)
  })
  it('Persistenz: Protokoll übersteht Export/Import; ältere Exporte ohne Protokoll bleiben importierbar', () => {
    const s0 = base(), s1 = recordChange(s0, { ...s0, profile: { ...s0.profile, age: 44 } }, 'Alter', 'user')
    const r = parseJsonText(JSON.stringify(s1), 'import'); expect(r.ok && r.state.changeLog).toHaveLength(1)
    const old = JSON.parse(JSON.stringify(s0)); delete old.changeLog
    const r2 = parseJsonText(JSON.stringify(old), 'import'); expect(r2.ok && r2.state.changeLog).toEqual([])
    const tampered = JSON.parse(JSON.stringify(s1)); tampered.changeLog[0].patches[0].key = 'ai'
    expect(parseJsonText(JSON.stringify(tampered), 'import').ok).toBe(false)
  })
})
