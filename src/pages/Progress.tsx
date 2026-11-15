import { useState } from 'react'
import { useStore } from '../store'
import { Btn, Card, Field, NumInput, PageTitle, fmt, inputCls, todayISO, dateLabel } from '../ui/kit'
import { dayTotals } from '../domain/planner'
import { mealMacros } from '../domain/nutrition'

export function ProgressPage() {
  const { state, update, ctx } = useStore()
  const [kg, setKg] = useState<number | undefined>(state.weights.at(-1)?.kg ?? state.profile.weightKg)
  const [date, setDate] = useState(todayISO())
  const ws = [...state.weights].sort((a, b) => a.date.localeCompare(b.date))
  const add = () => {
    if (!kg || kg < 30 || kg > 300) return
    update(s => ({ ...s, weights: [...s.weights.filter(w => w.date !== date), { date, kg }] }))
  }
  const plan = state.plan
  const past = plan ? plan.days.filter(d => d.date <= todayISO()) : []
  const meals = past.flatMap(d => d.meals)
  const eaten = meals.filter(m => state.eaten[m.id]).length
  const adherence = meals.length ? Math.round((eaten / meals.length) * 100) : null
  const eatenKcal = past.map(d => ({ date: d.date, kcal: d.meals.filter(m => state.eaten[m.id]).reduce((s, m) => s + mealMacros(m, ctx.recipes, ctx.foods, ctx.oils).kcal, 0), planned: dayTotals(d, ctx).kcal }))
  const weeks = plan ? Array.from({ length: Math.ceil(plan.days.length / 7) }, (_, w) => {
    const ds = plan.days.slice(w * 7, w * 7 + 7).filter(d => d.date <= todayISO())
    const ms = ds.flatMap(d => d.meals)
    return { w: w + 1, n: ms.length, ok: ms.filter(m => state.eaten[m.id]).length }
  }).filter(x => x.n) : []

  // Gewichtsdiagramm
  const W = 560, H = 180, pad = 28
  const vals = ws.map(w => w.kg)
  const lo = Math.min(...vals, state.profile.targetWeightKg ?? Infinity) - 1, hi = Math.max(...vals, state.profile.targetWeightKg ?? -Infinity) + 1
  const x = (i: number) => pad + (ws.length < 2 ? (W - 2 * pad) / 2 : (i * (W - 2 * pad)) / (ws.length - 1))
  const y = (v: number) => H - pad - ((v - lo) / (hi - lo || 1)) * (H - 2 * pad)
  const maxK = Math.max(1, ...eatenKcal.map(e => Math.max(e.kcal, e.planned)))
  return (
    <div>
      <PageTitle title="Fortschritt" sub="Ruhig und sachlich – ohne Punkte und Abzeichen." />
      <div className="grid lg:grid-cols-2 gap-4">
        <Card>
          <h2 className="text-xl mb-3">Gewichtsentwicklung</h2>
          <div className="flex gap-2 items-end flex-wrap mb-3">
            <Field label="Datum"><input type="date" className={inputCls} value={date} max={todayISO()} onChange={e => e.target.value && setDate(e.target.value)} /></Field>
            <div className="w-28"><Field label="Gewicht (kg)"><NumInput value={kg} onChange={setKg} step={0.1} min={30} max={300} /></Field></div>
            <Btn onClick={add}>Eintragen</Btn>
          </div>
          {ws.length === 0 ? <p className="text-sm text-muted">Noch keine Einträge.</p> : (
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Gewichtsverlauf">
              {state.profile.targetWeightKg && <g><line x1={pad} x2={W - pad} y1={y(state.profile.targetWeightKg)} y2={y(state.profile.targetWeightKg)} stroke="#b3641c" strokeDasharray="4 4" /><text x={W - pad} y={y(state.profile.targetWeightKg) - 4} textAnchor="end" fontSize="10" fill="#b3641c">Ziel {fmt(state.profile.targetWeightKg, 1)} kg</text></g>}
              <polyline fill="none" stroke="#2f5d2a" strokeWidth="2.5" points={ws.map((w, i) => `${x(i)},${y(w.kg)}`).join(' ')} />
              {ws.map((w, i) => <g key={w.date}><circle cx={x(i)} cy={y(w.kg)} r="4" fill="#2f5d2a" /><text x={x(i)} y={y(w.kg) - 8} textAnchor="middle" fontSize="10" fill="#1d2b1a">{fmt(w.kg, 1)}</text>{(ws.length < 8 || i % Math.ceil(ws.length / 6) === 0) && <text x={x(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="#6b705f">{dateLabel(w.date)}</text>}</g>)}
            </svg>
          )}
          {ws.length > 1 && <p className="text-sm text-muted mt-2">Veränderung: {fmt(ws.at(-1)!.kg - ws[0].kg, 1)} kg seit {dateLabel(ws[0].date)}</p>}
        </Card>
        <Card>
          <h2 className="text-xl mb-1">Einhaltung des Plans</h2>
          <p className="text-sm text-muted mb-3">Markiere im Plan Mahlzeiten mit ✓, sobald du sie gegessen hast.</p>
          {!plan ? <p className="text-sm text-muted">Kein Plan vorhanden.</p> : (
            <>
              <p className="font-serif text-4xl text-forest-dark">{adherence === null ? '–' : `${adherence} %`}</p>
              <p className="text-sm text-muted mb-3">{eaten} von {meals.length} bisher geplanten Mahlzeiten</p>
              {weeks.map(wk => <div key={wk.w} className="flex items-center gap-2 text-sm mb-1"><span className="w-16">Woche {wk.w}</span><div className="flex-1 h-2.5 rounded-full bg-sand/60"><div className="h-full rounded-full bg-olive" style={{ width: `${(wk.ok / wk.n) * 100}%` }} /></div><span className="w-12 text-right text-muted">{wk.ok}/{wk.n}</span></div>)}
            </>
          )}
        </Card>
        <Card className="lg:col-span-2">
          <h2 className="text-xl mb-3">Kalorien: geplant und gegessen</h2>
          {eatenKcal.length === 0 ? <p className="text-sm text-muted">Sobald Planungstage in der Vergangenheit liegen, erscheint hier die Übersicht.</p> : (
            <div className="flex items-end gap-1.5 h-40 overflow-x-auto" role="img" aria-label="Kalorien pro Tag">
              {eatenKcal.map(e => (
                <div key={e.date} className="flex flex-col items-center justify-end h-full min-w-6 flex-1">
                  <div className="flex items-end gap-0.5 h-full w-full justify-center">
                    <div className="w-2 rounded-t bg-sand" style={{ height: `${(e.planned / maxK) * 100}%` }} title={`geplant ${fmt(e.planned)}`} />
                    <div className="w-2 rounded-t bg-forest" style={{ height: `${(e.kcal / maxK) * 100}%` }} title={`gegessen ${fmt(e.kcal)}`} />
                  </div>
                  <span className="text-[10px] text-muted mt-1">{dateLabel(e.date).replace(' ', ' ')}</span>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-muted mt-2">Beige: geplant · Grün: als gegessen markiert. Es werden nur Mahlzeiten aus dem Plan gezählt.</p>
        </Card>
      </div>
    </div>
  )
}
