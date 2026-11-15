import { useStore } from '../store'
import { Chip, fmt, CAT_EMOJI } from '../ui/kit'
import { recipeMacros, resolveIngredients, macroShares } from '../domain/nutrition'
import { allergenStatus } from '../domain/rules'
import { ALLERGEN_LABEL, SLOT_LABEL, type Recipe } from '../domain/types'

export function recipeEmoji(r: Recipe, foods: Map<string, { category: keyof typeof CAT_EMOJI; protein: number }>) {
  let best = 'sonstige' as keyof typeof CAT_EMOJI, bp = -1
  for (const i of r.ingredients) {
    const f = foods.get(i.foodId)
    if (f && f.category !== 'oele' && f.category !== 'gewuerze' && i.grams > bp) { bp = i.grams; best = f.category }
  }
  return CAT_EMOJI[best]
}

export function RecipeThumb({ r, size = 56 }: { r: Recipe; size?: number }) {
  const { ctx } = useStore()
  return <div aria-hidden className="shrink-0 grid place-items-center rounded-2xl bg-gradient-to-br from-moss to-sand" style={{ width: size, height: size, fontSize: size * 0.5 }}>{recipeEmoji(r, ctx.foods)}</div>
}

export function RecipeDetail({ recipe, factor, onFactor }: { recipe: Recipe; factor: number; onFactor?: (f: number) => void }) {
  const { ctx, state } = useStore()
  const persons = state.profile.persons
  const m = recipeMacros(recipe, ctx.foods, ctx.oils, factor)
  const sh = macroShares(m)
  const ings = resolveIngredients(recipe.ingredients, ctx.oils)
  const st = allergenStatus(ings, ctx.foods)
  const hasRestr = state.prefs.restrictions.length > 0
  const viol = ctx.rejected.get(recipe.id)
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 items-center text-sm text-muted">
        {recipe.slots.map(s => <Chip key={s}>{SLOT_LABEL[s]}</Chip>)}<span>⏱ {recipe.minutes} Min.</span>
      </div>
      {viol && <div role="alert" className="rounded-2xl bg-danger/10 text-danger border border-danger/30 px-4 py-2 text-sm">Entspricht nicht deinen aktuellen Einstellungen: {viol}</div>}
      {onFactor && (
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium">Portion</span>
          <button aria-label="Portion verkleinern" className="h-10 w-10 rounded-full bg-moss text-xl" onClick={() => onFactor(Math.max(0.25, Math.round((factor - 0.25) * 100) / 100))}>−</button>
          <span className="font-semibold w-16 text-center">{fmt(factor, 2)}×</span>
          <button aria-label="Portion vergrößern" className="h-10 w-10 rounded-full bg-moss text-xl" onClick={() => onFactor(Math.min(4, Math.round((factor + 0.25) * 100) / 100))}>+</button>
        </div>
      )}
      <div className="grid grid-cols-4 gap-2 text-center">
        {[['kcal', m.kcal, ''], ['Eiweiß', m.protein, 'g'], ['Kohlenh.', m.carbs, 'g'], ['Fett', m.fat, 'g']].map(([l, v, u]) => (
          <div key={l as string} className="rounded-2xl bg-white/80 border border-sand/70 py-2">
            <div className="font-serif text-xl text-forest-dark">{fmt(v as number)}<span className="text-xs">{u as string}</span></div><div className="text-xs text-muted">{l as string}</div>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted">Pro Person · Eiweiß {fmt(sh.protein)} % · Kohlenhydrate {fmt(sh.carbs)} % · Fett {fmt(sh.fat)} % · Ballaststoffe {fmt(m.fiber, 1)} g</p>
      <div>
        <h3 className="font-semibold mb-1">Zutaten {persons > 1 ? `(für ${persons} Personen)` : '(pro Person)'}</h3>
        <ul className="divide-y divide-sand/60 rounded-2xl bg-white/80 border border-sand/70">
          {ings.map((i, k) => {
            const f = ctx.foods.get(i.foodId)
            const g = i.grams * factor * persons
            return (
              <li key={k} className="flex justify-between px-3 py-2 text-sm">
                <span>{f?.name ?? i.foodId}{f?.category === 'oele' && <span className="text-xs text-muted"> (Öl)</span>}</span>
                <span className="text-muted">{fmt(g, g < 10 ? 1 : 0)} g{f?.unit && f.unit.label !== 'EL' ? ` ≈ ${fmt(g / f.unit.grams, 1)} ${f.unit.label}` : f?.unit ? ` ≈ ${fmt(g / f.unit.grams, 1)} EL` : ''}</span>
              </li>
            )
          })}
        </ul>
      </div>
      <div>
        <h3 className="font-semibold mb-1">Zubereitung</h3>
        <ol className="list-decimal pl-5 space-y-1 text-sm">{recipe.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
      </div>
      <div className="text-xs text-muted space-y-1">
        <p>Enthält (laut Lebensmitteldaten): {st.allergens.length ? st.allergens.map(a => ALLERGEN_LABEL[a]).join(', ') : 'keine erfassten Allergene'}.
          {st.unknown && ' ⚠ Mindestens eine Zutat hat keine verlässliche Allergeninformation – dieses Rezept gilt NICHT als allergenfrei.'}
          {hasRestr && !st.unknown && !viol && ' Mit deinen aktuellen Angaben verträglich (Richtwerte, Spuren nicht erfasst).'}</p>
        <p>Nährwerte sind Richtwerte aus den hinterlegten Lebensmitteldaten, nicht einzeln verifiziert.</p>
      </div>
    </div>
  )
}
