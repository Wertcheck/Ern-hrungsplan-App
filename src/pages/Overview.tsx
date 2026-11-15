import { useStore } from '../store'
import { Bar, Btn, Card, Notice, PageTitle, Ring, fmt, todayISO, WEEKDAYS_LONG, parseISO, dateLabel } from '../ui/kit'
import { dayTotals } from '../domain/planner'
import { mealMacros } from '../domain/nutrition'
import { SLOT_LABEL, STYLE_LABEL } from '../domain/types'
import { RecipeThumb } from './RecipeDetail'
import { macroTarget } from '../domain/rules'

export function OverviewPage({ go }: { go: (p: string) => void }) {
  const { state, ctx, target, analysis } = useStore()
  const plan = state.plan
  const day = plan?.days.find(d => d.date === todayISO())
  const planned = day ? dayTotals(day, ctx) : null
  const eaten = day ? day.meals.filter(m => state.eaten[m.id]).reduce((s, m) => { const x = mealMacros(m, ctx.recipes, ctx.foods, ctx.oils); return { k: s.k + x.kcal, p: s.p + x.protein, c: s.c + x.carbs, f: s.f + x.fat } }, { k: 0, p: 0, c: 0, f: 0 }) : null
  const mt = macroTarget(state.prefs.styles)
  const pT = (target * mt.protein) / 100 / 4, cT = (target * mt.carbs) / 100 / 4, fT = (target * mt.fat) / 100 / 9
  const errors = analysis?.issues.filter(i => i.level === 'error') ?? []
  const nextDay = plan?.days.find(d => d.date > todayISO())
  return (
    <div>
      <PageTitle title="Ernährungscoach" sub="Gesund · Ausgewogen · Individuell" />
      {!plan && (
        <Card className="mb-4 bg-gradient-to-br from-moss/70 to-paper text-center py-8">
          <div className="text-5xl mb-2" aria-hidden>🥗</div>
          <h2 className="text-2xl mb-1">Bereit für deinen Plan?</h2>
          <p className="text-muted mb-4">Ziel: {fmt(target)} kcal pro Tag · {state.profile.mealCount} Mahlzeiten</p>
          <Btn onClick={() => go('plan')}>Plan erstellen →</Btn>
        </Card>
      )}
      {errors.map((e, i) => <div key={i} className="mb-3"><Notice level="error">{e.text}</Notice></div>)}
      {plan && !day && <div className="mb-4"><Notice level="info">Heute liegt außerhalb des Plans (Planzeitraum {dateLabel(plan.days[0].date)} – {dateLabel(plan.days.at(-1)!.date)}). <button className="underline" onClick={() => go('plan')}>Zum Plan</button></Notice></div>}
      <div className="grid lg:grid-cols-5 gap-4">
        {day && planned && eaten && (
          <Card className="lg:col-span-3 rise">
            <div className="flex justify-between mb-3"><h2 className="text-xl">Tagesfortschritt</h2><span className="text-sm text-muted">Heute · {WEEKDAYS_LONG[parseISO(day.date).getDay()]}</span></div>
            <div className="flex flex-wrap gap-5 items-center">
              <Ring value={eaten.k} max={target} label={fmt(eaten.k)} sub={`von ${fmt(target)} kcal`} />
              <div className="flex-1 min-w-52 space-y-3">
                <Bar label="Eiweiß" value={eaten.p} max={pT} color="#2f5d2a" />
                <Bar label="Kohlenhydrate" value={eaten.c} max={cT} color="#d18a1c" />
                <Bar label="Fett" value={eaten.f} max={fT} color="#7d52b8" />
              </div>
            </div>
            <p className="text-xs text-muted mt-3">Gezählt werden Mahlzeiten, die du im Plan als gegessen markiert hast. Geplant für heute: ≈ {fmt(planned.kcal)} kcal. Makroziele sind Orientierungswerte ({mt.protein}/{mt.carbs}/{mt.fat} % Energieanteil).</p>
          </Card>
        )}
        {day && (
          <Card className="lg:col-span-2 rise">
            <div className="flex justify-between mb-2"><h2 className="text-xl">Heute auf dem Plan</h2><button className="text-forest text-sm" onClick={() => go('plan')}>Alle →</button></div>
            <ul className="space-y-2">
              {day.meals.map(m => { const r = ctx.recipes.get(m.recipeId); if (!r) return null; return (
                <li key={m.id} className="flex items-center gap-3"><RecipeThumb r={r} size={40} /><div className="flex-1 min-w-0"><div className="text-xs text-forest">{SLOT_LABEL[m.slot]}</div><div className="truncate text-sm font-medium">{r.name}</div></div><span className="text-xs text-muted">{fmt(mealMacros(m, ctx.recipes, ctx.foods, ctx.oils).kcal)} kcal</span></li>
              ) })}
            </ul>
          </Card>
        )}
        {!day && nextDay && <Card className="lg:col-span-5"><p>Nächster Plantag: <b>{dateLabel(nextDay.date)}</b></p></Card>}
        <Card className="lg:col-span-5">
          <h2 className="text-xl mb-3">Meine Ernährungseinstellungen</h2>
          <div className="grid sm:grid-cols-2 gap-2 text-sm">
            {[
              ['Unverträglichkeiten', state.prefs.restrictions.map(r => `${r.allergen} (${r.severity === 'allergy' ? 'Allergie' : 'Unv.'})`).join(', ') || 'keine'],
              ['Ernährungsart', state.prefs.styles.map(x => STYLE_LABEL[x] ?? x).join(', ')],
              ['Bevorzugtes Öl', state.foods.find(f => f.id === state.prefs.oils.main)?.name ?? 'kein Hauptöl'],
              ['Kalorienziel', `${fmt(target)} kcal (${state.profile.kcalMode === 'auto' ? 'geschätzt' : 'manuell'})`],
            ].map(([k, v]) => (
              <button key={k} onClick={() => go('einstellungen')} className="flex justify-between gap-3 rounded-2xl bg-white/70 border border-sand/70 px-4 py-3 text-left hover:border-forest"><span className="font-medium">{k}</span><span className="text-muted text-right">{v}</span></button>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}
