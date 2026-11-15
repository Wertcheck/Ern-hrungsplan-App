import { useMemo, useState } from 'react'
import { useStore } from '../store'
import { Btn, Card, Chip, Notice, PageTitle, Sheet, fmt, todayISO, WEEKDAYS, WEEKDAYS_LONG, dateLabel, parseISO, cx } from '../ui/kit'
import { PERIODS, alternativesFor, dayTotals, generatePlan } from '../domain/planner'
import { macroShares, mealMacros } from '../domain/nutrition'
import { addMeal, removeMeal, setFactor, swapMeal } from '../domain/planops'
import { SLOT_LABEL, STYLE_LABEL, type MealSlot, type PlanDay, type PlannedMeal } from '../domain/types'
import { RecipeDetail, RecipeThumb } from './RecipeDetail'
import { analyzePrefs } from '../domain/rules'
import { analyzeGaps, type GapStatus } from '../domain/nutrients'

type View = 'tag' | 'woche' | 'monat'
const SLOT_ICON: Record<MealSlot, string> = { fruehstueck: '☕', mittag: '🍴', abend: '🌙', snack: '🍎' }

export function PlanPage() {
  const { state, update, ctx, analysis, target } = useStore()
  const plan = state.plan
  const [days, setDays] = useState<number>(7)
  const [start, setStart] = useState(todayISO())
  const [sel, setSel] = useState<string>(plan?.days.find(d => d.date === todayISO())?.date ?? plan?.days[0]?.date ?? '')
  const [view, setView] = useState<View>('tag')
  const [open, setOpen] = useState<{ date: string; id: string } | null>(null)
  const [swap, setSwap] = useState<{ date: string; id: string } | null>(null)
  const [add, setAdd] = useState<{ date: string } | null>(null)
  const [confirmNew, setConfirmNew] = useState(false)

  const conflicts = analyzePrefs(state.prefs).conflicts
  const generate = () => {
    if (conflicts.length) return
    const p = generatePlan({ profile: state.profile, foods: state.foods, recipes: state.recipes, prefs: state.prefs, startDate: start, days, seed: Math.floor(Math.random() * 1e6) })
    update(s => ({ ...s, plan: p, eaten: {}, shopping: { ...s.shopping, checked: [], removed: [] } }))
    setSel(p.days[0].date); setConfirmNew(false); setView('tag')
  }
  const patch = (fn: (p: NonNullable<typeof plan>) => NonNullable<typeof plan>) => update(s => (s.plan ? { ...s, plan: fn(s.plan) } : s))

  if (!plan) {
    return (
      <div>
        <PageTitle title="Ernährungsplan" sub="Wähle den Zeitraum – der Plan wird aus deinen Einstellungen berechnet." />
        <Card className="max-w-xl space-y-4">
          <div><p className="font-medium mb-2">Planzeitraum</p><div className="flex flex-wrap gap-2">{PERIODS.map(p => <Chip key={p.days} active={days === p.days} onClick={() => setDays(p.days)}>{p.label}</Chip>)}</div></div>
          <label className="block"><span className="text-sm font-medium">Startdatum</span><input type="date" value={start} onChange={e => e.target.value && setStart(e.target.value)} className="block mt-1 rounded-2xl border border-sand bg-white px-3.5 py-2.5 min-h-11" /></label>
          <p className="text-sm text-muted">Kalorienziel: <b>{fmt(target)} kcal</b> · {state.profile.mealCount} Mahlzeiten · {state.profile.persons} Person(en) · {ctx.eligible.length} passende Rezepte</p>
          {conflicts.map(c => <Notice key={c} level="error">Widerspruch in den Ernährungsweisen: {c}</Notice>)}
          {ctx.eligible.length === 0 && <Notice level="error">Mit deinen Einstellungen bleibt kein Rezept übrig. Lockere Ausschlüsse oder lege eigene Rezepte an.</Notice>}
          <Btn onClick={generate} disabled={ctx.eligible.length === 0 || conflicts.length > 0}>Plan erstellen →</Btn>
        </Card>
      </div>
    )
  }

  const day = plan.days.find(d => d.date === sel) ?? plan.days[0]
  const idx = plan.days.indexOf(day)
  const go = (d: number) => { const n = plan.days[idx + d]; if (n) setSel(n.date) }
  const totals = dayTotals(day, ctx)
  const sh = macroShares(totals)
  const devPct = ((totals.kcal - plan.kcalTarget) / plan.kcalTarget) * 100
  const openMeal = open ? plan.days.find(d => d.date === open.date)?.meals.find(m => m.id === open.id) : null
  const swapMealObj = swap ? plan.days.find(d => d.date === swap.date)?.meals.find(m => m.id === swap.id) : null

  const mealKcal = (m: PlannedMeal) => mealMacros(m, ctx.recipes, ctx.foods, ctx.oils).kcal

  return (
    <div>
      <PageTitle title="Dein Ernährungsplan" sub={`${plan.days.length} Tage · Ziel ${fmt(plan.kcalTarget)} kcal · ${plan.persons} Person(en)`}
        right={<Btn variant="soft" onClick={() => setConfirmNew(true)}>↻ Neu generieren</Btn>} />

      <div className="flex gap-2 mb-4" role="tablist" aria-label="Ansicht">
        {(['tag', 'woche', 'monat'] as View[]).map(v => <Chip key={v} active={view === v} onClick={() => setView(v)}>{{ tag: 'Tag', woche: 'Woche', monat: 'Monat' }[v]}</Chip>)}
      </div>

      {view === 'tag' && (
        <>
          <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1" role="tablist" aria-label="Tage">
            {plan.days.map(d => {
              const dt = parseISO(d.date), active = d.date === day.date
              return (
                <button key={d.date} role="tab" aria-selected={active} onClick={() => setSel(d.date)}
                  className={cx('shrink-0 w-16 rounded-2xl border py-2 text-center transition', active ? 'bg-forest text-white border-forest' : 'bg-paper border-sand', d.date === todayISO() && !active && 'border-forest')}>
                  <div className="text-sm font-semibold">{WEEKDAYS[dt.getDay()]}</div><div className="text-xs opacity-80">{dateLabel(d.date)}</div>
                </button>
              )
            })}
          </div>
          <div className="flex items-center justify-between my-3">
            <button aria-label="Vorheriger Tag" disabled={idx === 0} onClick={() => go(-1)} className="h-10 w-10 rounded-full bg-paper border border-sand disabled:opacity-30">‹</button>
            <h2 className="text-2xl font-semibold">{WEEKDAYS_LONG[parseISO(day.date).getDay()]}, {dateLabel(day.date)}</h2>
            <button aria-label="Nächster Tag" disabled={idx === plan.days.length - 1} onClick={() => go(1)} className="h-10 w-10 rounded-full bg-paper border border-sand disabled:opacity-30">›</button>
          </div>
          <div className="grid lg:grid-cols-3 gap-4 [&>*]:min-w-0">
            <div className="lg:col-span-2 space-y-3">
              {day.meals.length === 0 && <Notice level="warn">Für diesen Tag gibt es keine Mahlzeiten.</Notice>}
              {day.meals.map(m => {
                const r = ctx.recipes.get(m.recipeId)
                if (!r) return null
                const bad = ctx.rejected.get(r.id)
                return (
                  <Card key={m.id} className={cx('rise !p-3 flex gap-3 items-center', bad && 'border-danger/50')}>
                    <button className="flex gap-3 items-center text-left flex-1 min-w-0" onClick={() => setOpen({ date: day.date, id: m.id })}>
                      <RecipeThumb r={r} size={64} />
                      <div className="min-w-0">
                        <div className="text-xs text-forest font-medium">{SLOT_ICON[m.slot]} {SLOT_LABEL[m.slot]}</div>
                        <div className="font-semibold truncate">{r.name}</div>
                        <div className="text-xs text-muted">{fmt(m.factor, 2)}× Portion{bad ? ' · ⚠ verletzt Einstellungen' : ''}</div>
                      </div>
                    </button>
                    <div className="text-right shrink-0">
                      <div className="rounded-full bg-moss px-3 py-1 text-sm font-medium text-forest-dark">≈ {fmt(mealKcal(m))} kcal</div>
                      <div className="flex gap-1 mt-2 justify-end">
                        <button title="Gegessen" aria-label="Als gegessen markieren" aria-pressed={!!state.eaten[m.id]} onClick={() => update(s => ({ ...s, eaten: { ...s.eaten, [m.id]: !s.eaten[m.id] } }))} className={cx('h-9 w-9 rounded-full border', state.eaten[m.id] ? 'bg-forest text-white border-forest' : 'bg-paper border-sand')}>✓</button>
                        <button title="Austauschen" aria-label="Mahlzeit austauschen" onClick={() => setSwap({ date: day.date, id: m.id })} className="h-9 w-9 rounded-full border border-sand bg-paper">⇄</button>
                        <button title="Löschen" aria-label="Mahlzeit löschen" onClick={() => patch(p => removeMeal(p, day.date, m.id))} className="h-9 w-9 rounded-full border border-sand bg-paper">🗑</button>
                      </div>
                    </div>
                  </Card>
                )
              })}
              <Btn variant="ghost" onClick={() => setAdd({ date: day.date })}>+ Mahlzeit ergänzen</Btn>
            </div>
            <div className="space-y-3">
              <Card>
                <p className="text-sm text-muted">Kalorien gesamt</p>
                <p className="font-serif text-4xl text-forest-dark" data-testid="day-kcal">≈ {fmt(totals.kcal)} <span className="text-base font-sans text-muted">kcal</span></p>
                <p className={cx('text-sm', Math.abs(devPct) > 5 ? 'text-warn' : 'text-muted')}>{devPct >= 0 ? '+' : ''}{fmt(devPct, 1)} % zum Ziel ({fmt(plan.kcalTarget)})</p>
                <div className="mt-3 space-y-1 text-sm">
                  <div className="flex justify-between"><span>Eiweiß</span><span>{fmt(totals.protein)} g (≈ {fmt(sh.protein)} %)</span></div>
                  <div className="flex justify-between"><span>Kohlenhydrate</span><span>{fmt(totals.carbs)} g (≈ {fmt(sh.carbs)} %)</span></div>
                  <div className="flex justify-between"><span>Fett</span><span>{fmt(totals.fat)} g (≈ {fmt(sh.fat)} %)</span></div>
                  <div className="flex justify-between text-muted"><span>Ballaststoffe</span><span>{fmt(totals.fiber)} g</span></div>
                </div>
              </Card>
              <Card className="text-sm space-y-1">
                <p><b>Öle:</b> {ctx.oils.warm ? `warm: ${ctx.foods.get(ctx.oils.warm)?.name}` : 'warm: –'}; {ctx.oils.cold ? `kalt: ${ctx.foods.get(ctx.oils.cold)?.name}` : 'kalt: –'}</p>
                <p><b>Ernährungsweise:</b> {state.prefs.styles.map(x => STYLE_LABEL[x] ?? x).join(', ')}</p>
              </Card>
              <GapCard />
              {analysis && (
                <Card className="space-y-2">
                  <div className="flex items-center justify-between"><p className="font-medium">Plan-Qualität</p><span className="font-serif text-2xl text-forest-dark">{fmt(analysis.score.total)}<span className="text-sm text-muted">/100</span></span></div>
                  <dl className="grid grid-cols-2 gap-x-3 text-xs text-muted">
                    {Object.entries(analysis.score.parts).map(([k, v]) => <div key={k} className="flex justify-between"><dt>{({ kalorien: 'Kalorien', makros: 'Makros', praeferenzen: 'Präferenzen', vielfalt: 'Vielfalt', wiederholungen: 'Wiederholungen', verfuegbarkeit: 'Verfügbarkeit' } as Record<string, string>)[k]}</dt><dd>{fmt(v)}</dd></div>)}
                  </dl>
                  {analysis.issues.map((i, k) => <Notice key={k} level={i.level}>{i.text}</Notice>)}
                </Card>
              )}
            </div>
          </div>
        </>
      )}

      {view === 'woche' && <WeekView days={plan.days} sel={day.date} onPick={d => { setSel(d); setView('tag') }} target={plan.kcalTarget} />}
      {view === 'monat' && <MonthView days={plan.days} target={plan.kcalTarget} onPick={d => { setSel(d); setView('tag') }} />}

      {open && openMeal && ctx.recipes.get(openMeal.recipeId) && (
        <Sheet title={ctx.recipes.get(openMeal.recipeId)!.name} onClose={() => setOpen(null)}>
          <RecipeDetail recipe={ctx.recipes.get(openMeal.recipeId)!} factor={openMeal.factor} onFactor={f => patch(p => setFactor(p, open.date, open.id, f))} />
        </Sheet>
      )}
      {swap && swapMealObj && (
        <Sheet title={`${SLOT_LABEL[swapMealObj.slot]} austauschen`} onClose={() => setSwap(null)}>
          <Alternatives slot={swapMealObj.slot} targetKcal={mealKcal(swapMealObj)} exclude={[swapMealObj.recipeId]}
            onPick={(rid, f) => { patch(p => swapMeal(p, swap.date, swap.id, rid, f)); setSwap(null) }} />
        </Sheet>
      )}
      {add && <AddSheet day={plan.days.find(d => d.date === add.date)!} onClose={() => setAdd(null)} onAdd={(slot, rid, f) => { patch(p => addMeal(p, add.date, slot, rid, f)); setAdd(null) }} />}
      {confirmNew && (
        <Sheet title="Plan neu generieren" onClose={() => setConfirmNew(false)}>
          <p className="text-sm mb-3">Der aktuelle Plan inklusive manueller Änderungen wird ersetzt.</p>
          <div className="flex flex-wrap gap-2 mb-3">{PERIODS.map(p => <Chip key={p.days} active={days === p.days} onClick={() => setDays(p.days)}>{p.label}</Chip>)}</div>
          <input type="date" aria-label="Startdatum" value={start} onChange={e => e.target.value && setStart(e.target.value)} className="rounded-2xl border border-sand bg-white px-3.5 py-2.5 min-h-11 mb-4" />
          <div className="flex gap-2"><Btn onClick={generate}>Neu generieren</Btn><Btn variant="ghost" onClick={() => setConfirmNew(false)}>Abbrechen</Btn></div>
        </Sheet>
      )}
    </div>
  )
}

function Alternatives({ slot, targetKcal, exclude, onPick }: { slot: MealSlot; targetKcal: number; exclude: string[]; onPick: (rid: string, f: number) => void }) {
  const { ctx } = useStore()
  const [all, setAll] = useState(false)
  const list = useMemo(() => alternativesFor(slot, targetKcal, ctx, exclude, all ? 60 : 8), [slot, targetKcal, ctx, exclude, all])
  if (!list.length) return <Notice level="warn">Keine passenden Rezepte für diese Mahlzeit mit deinen Einstellungen.</Notice>
  return (
    <div className="space-y-2">
      {list.map(a => (
        <button key={a.recipe.id} onClick={() => onPick(a.recipe.id, a.factor)} className="w-full text-left flex gap-3 items-center rounded-2xl bg-paper border border-sand p-2.5 hover:border-forest">
          <RecipeThumb r={a.recipe} size={48} />
          <div className="flex-1 min-w-0"><div className="font-medium truncate">{a.recipe.name}</div><div className="text-xs text-muted">{fmt(a.factor, 2)}× · {a.recipe.minutes} Min.</div></div>
          <span className="rounded-full bg-moss px-3 py-1 text-sm">≈ {fmt(a.kcal)} kcal</span>
        </button>
      ))}
      {!all && <Btn variant="ghost" onClick={() => setAll(true)}>Alle passenden anzeigen</Btn>}
    </div>
  )
}

function AddSheet({ day, onClose, onAdd }: { day: PlanDay; onClose: () => void; onAdd: (s: MealSlot, rid: string, f: number) => void }) {
  const { ctx, target } = useStore()
  const [slot, setSlot] = useState<MealSlot>('snack')
  const used = dayTotals(day, ctx).kcal
  const remaining = Math.max(120, Math.min(700, target - used))
  return (
    <Sheet title="Mahlzeit ergänzen" onClose={onClose}>
      <div className="flex flex-wrap gap-2 mb-3">{(Object.keys(SLOT_LABEL) as MealSlot[]).map(s => <Chip key={s} active={slot === s} onClick={() => setSlot(s)}>{SLOT_LABEL[s]}</Chip>)}</div>
      <p className="text-xs text-muted mb-2">Portion wird auf ca. {fmt(remaining)} kcal (verbleibendes Tagesbudget) angepasst.</p>
      <Alternatives slot={slot} targetKcal={remaining} exclude={day.meals.map(m => m.recipeId)} onPick={(rid, f) => onAdd(slot, rid, f)} />
    </Sheet>
  )
}

function WeekView({ days, sel, onPick, target }: { days: PlanDay[]; sel: string; onPick: (d: string) => void; target: number }) {
  const { ctx } = useStore()
  const i = Math.max(0, days.findIndex(d => d.date === sel))
  const [wk, setWk] = useState(Math.floor(i / 7))
  const weeks = Math.ceil(days.length / 7)
  const slice = days.slice(wk * 7, wk * 7 + 7)
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <button className="h-10 w-10 rounded-full bg-paper border border-sand disabled:opacity-30" disabled={wk === 0} onClick={() => setWk(wk - 1)} aria-label="Vorherige Woche">‹</button>
        <b>Woche {wk + 1} von {weeks}</b>
        <button className="h-10 w-10 rounded-full bg-paper border border-sand disabled:opacity-30" disabled={wk >= weeks - 1} onClick={() => setWk(wk + 1)} aria-label="Nächste Woche">›</button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
        {slice.map(d => {
          const t = dayTotals(d, ctx), dev = ((t.kcal - target) / target) * 100
          return (
            <Card key={d.date} onClick={() => onPick(d.date)} className="!p-3">
              <div className="flex justify-between"><b>{WEEKDAYS[parseISO(d.date).getDay()]}, {dateLabel(d.date)}</b><span className={cx('text-sm', Math.abs(dev) > 5 ? 'text-warn' : 'text-muted')}>{fmt(t.kcal)} kcal ({dev >= 0 ? '+' : ''}{fmt(dev, 1)} %)</span></div>
              <ul className="text-sm text-muted mt-1 lg:grid lg:grid-cols-4 lg:gap-2">{d.meals.map(m => <li key={m.id} className="truncate">{SLOT_LABEL[m.slot]}: {ctx.recipes.get(m.recipeId)?.name}</li>)}</ul>
            </Card>
          )
        })}
      </div>
    </div>
  )
}

function MonthView({ days, target, onPick }: { days: PlanDay[]; target: number; onPick: (d: string) => void }) {
  const { ctx } = useStore()
  const lead = (parseISO(days[0].date).getDay() + 6) % 7
  const cells: (PlanDay | null)[] = [...Array(lead).fill(null), ...days]
  return (
    <div>
      <div className="grid grid-cols-7 gap-1.5 text-center text-xs text-muted mb-1">{['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map(d => <div key={d}>{d}</div>)}</div>
      <div className="grid grid-cols-7 gap-1.5">
        {cells.map((d, i) => {
          if (!d) return <div key={i} />
          const t = dayTotals(d, ctx), dev = Math.abs(((t.kcal - target) / target) * 100)
          return (
            <button key={d.date} onClick={() => onPick(d.date)} aria-label={`${dateLabel(d.date)}, ${fmt(t.kcal)} kcal`}
              className={cx('rounded-xl border p-1.5 text-left min-h-16 hover:border-forest', dev > 10 ? 'bg-danger/10 border-danger/40' : dev > 5 ? 'bg-[#fbeedd] border-warn/40' : 'bg-paper border-sand')}>
              <div className="text-sm font-semibold">{parseISO(d.date).getDate()}</div>
              <div className="text-[11px] text-muted">{fmt(t.kcal)}</div>
              <div className="text-[10px] text-muted hidden sm:block">{d.meals.length} Mahlz.</div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

const GAP_LABEL: Record<GapStatus, string> = { ok: 'erreicht', borderline: 'knapp', low: 'niedrig', unknown: 'Datenlage unzureichend' }
const GAP_COLOR: Record<GapStatus, string> = { ok: '#2f5d2a', borderline: '#d18a1c', low: '#a13a2e', unknown: '#9a9a8a' }

/** Nährstoffbilanz des gesamten Plans (Ø pro Person und Tag): Zufuhr aus den Rezepten vs. Orientierungswert. */
function GapCard() {
  const { state, ctx } = useStore()
  const [open, setOpen] = useState(false)
  const report = useMemo(() => (state.plan ? analyzeGaps(state.plan, ctx, state.profile, state.prefs) : null), [state.plan, ctx, state.profile, state.prefs])
  if (!report || !report.rows.length) return null
  const flagged = report.rows.filter(r => r.status === 'low' || r.status === 'borderline').length
  return (
    <Card className="space-y-2">
      <button className="w-full flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-left" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="font-medium">Nährstoffbilanz</span>
        <span className="text-xs text-muted">{flagged ? `${flagged} unter Orientierung` : 'alle erreicht'} {open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="space-y-2.5">
          <p className="text-xs text-muted">Ø pro Person und Tag über {report.days} Plantage. Zufuhr = Berechnung aus den Rezepten; Referenz = Orientierungswert, keine individuelle Empfehlung.</p>
          {report.rows.map(r => (
            <div key={r.key}>
              <div className="flex justify-between text-sm"><span>{r.label}</span><span className="text-muted">{r.status === 'unknown' ? '–' : `${fmt(r.intake, r.intake < 10 ? 1 : 0)} / ${fmt(r.reference, r.reference < 10 ? 1 : 0)} ${r.unit}`}</span></div>
              <div className="h-2 rounded-full bg-sand/60 overflow-hidden"><div className="h-full rounded-full" style={{ width: `${Math.min(100, r.pct)}%`, background: GAP_COLOR[r.status] }} /></div>
              <div className="text-xs" style={{ color: GAP_COLOR[r.status] }}>{GAP_LABEL[r.status]}{r.hardToReach ? ' · mit den vorhandenen Rezepten schwer erreichbar' : ''}{r.status !== 'unknown' && r.coverage < 0.95 ? ` · Datenabdeckung ${fmt(r.coverage * 100)} %` : ''}</div>
            </div>
          ))}
          {report.dietNotes.map(d => <div key={d.diet} className="text-xs text-muted"><b>{d.diet}:</b> {d.notes.join(' ')}</div>)}
          {report.caveats.map(c => <p key={c} className="text-xs text-muted">{c}</p>)}
        </div>
      )}
    </Card>
  )
}
