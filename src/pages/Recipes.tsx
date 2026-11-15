import { useMemo, useState } from 'react'
import { useStore } from '../store'
import { Btn, Card, Chip, Field, NumInput, Notice, PageTitle, Sheet, fmt, inputCls } from '../ui/kit'
import { recipeMacros } from '../domain/nutrition'
import { recipeInputSchema } from '../domain/schemas'
import { SLOT_LABEL, type Ingredient, type MealSlot, type Recipe } from '../domain/types'
import { OIL_COLD, OIL_WARM } from '../domain/types'
import { RecipeDetail, RecipeThumb } from './RecipeDetail'

export function RecipesPage() {
  const { state, update, ctx } = useStore()
  const [q, setQ] = useState('')
  const [slot, setSlot] = useState<MealSlot | 'alle'>('alle')
  const [fav, setFav] = useState(false)
  const [onlyOk, setOnlyOk] = useState(false)
  const [open, setOpen] = useState<Recipe | null>(null)
  const [factor, setFactor] = useState(1)
  const [edit, setEdit] = useState<Recipe | null>(null)
  const list = useMemo(() => {
    const t = q.trim().toLowerCase()
    return state.recipes.filter(r => (slot === 'alle' || r.slots.includes(slot)) && (!fav || r.favorite) && (!onlyOk || !ctx.rejected.has(r.id)) &&
      (!t || r.name.toLowerCase().includes(t) || r.ingredients.some(i => ctx.foods.get(i.foodId)?.name.toLowerCase().includes(t))))
  }, [state.recipes, q, slot, fav, onlyOk, ctx])
  const toggleFav = (id: string) => update(s => ({ ...s, recipes: s.recipes.map(r => (r.id === id ? { ...r, favorite: !r.favorite } : r)) }))
  const del = (r: Recipe) => {
    const inPlan = state.plan?.days.some(d => d.meals.some(m => m.recipeId === r.id))
    if (!confirm(inPlan ? `„${r.name}“ ist im Plan enthalten. Beim Löschen verschwinden diese Mahlzeiten aus dem Plan. Löschen?` : `„${r.name}“ löschen?`)) return
    update(s => ({ ...s, recipes: s.recipes.filter(x => x.id !== r.id), plan: s.plan ? { ...s.plan, days: s.plan.days.map(d => ({ ...d, meals: d.meals.filter(m => m.recipeId !== r.id) })) } : null }))
    setOpen(null)
  }
  return (
    <div>
      <PageTitle title="Rezepte" sub={`${state.recipes.length} Rezepte · ${ctx.eligible.length} passen zu deinen Einstellungen`} right={<Btn onClick={() => setEdit({ id: '', name: '', slots: ['mittag'], minutes: 20, ingredients: [], steps: [''], tags: [], custom: true })}>+ Neu</Btn>} />
      <input className={`${inputCls} mb-3`} placeholder="Rezept oder Zutat suchen…" value={q} onChange={e => setQ(e.target.value)} aria-label="Rezepte suchen" />
      <div className="flex flex-wrap gap-2 mb-4">
        <Chip active={slot === 'alle'} onClick={() => setSlot('alle')}>Alle</Chip>
        {(Object.keys(SLOT_LABEL) as MealSlot[]).map(s => <Chip key={s} active={slot === s} onClick={() => setSlot(s)}>{SLOT_LABEL[s]}</Chip>)}
        <Chip active={fav} onClick={() => setFav(!fav)}>★ Favoriten</Chip>
        <Chip active={onlyOk} onClick={() => setOnlyOk(!onlyOk)}>Nur passende</Chip>
      </div>
      <div className="grid md:grid-cols-2 gap-2.5">
        {list.map(r => {
          const m = recipeMacros(r, ctx.foods, ctx.oils)
          const bad = ctx.rejected.get(r.id)
          return (
            <Card key={r.id} className="!p-3 flex gap-3 items-center">
              <button className="flex gap-3 items-center flex-1 min-w-0 text-left" onClick={() => { setOpen(r); setFactor(1) }}>
                <RecipeThumb r={r} size={60} />
                <div className="min-w-0"><div className="font-semibold truncate">{r.name}</div>
                  <div className="text-xs text-muted">{r.slots.map(s => SLOT_LABEL[s]).join(', ')} · {fmt(m.kcal)} kcal · {r.minutes} Min.</div>
                  {bad && <div className="text-xs text-danger">⚠ passt nicht zu deinen Einstellungen</div>}</div>
              </button>
              <button aria-label="Favorit" aria-pressed={!!r.favorite} onClick={() => toggleFav(r.id)} className="h-10 w-10 rounded-full text-xl">{r.favorite ? '★' : '☆'}</button>
            </Card>
          )
        })}
      </div>
      {list.length === 0 && <p className="text-center text-muted py-10">Keine Rezepte gefunden.</p>}
      {open && (
        <Sheet title={open.name} onClose={() => setOpen(null)}>
          <RecipeDetail recipe={state.recipes.find(r => r.id === open.id) ?? open} factor={factor} onFactor={setFactor} />
          <div className="flex gap-2 mt-4"><Btn variant="soft" onClick={() => { setEdit(open); setOpen(null) }}>Bearbeiten</Btn><Btn variant="ghost" onClick={() => del(open)}>Löschen</Btn></div>
        </Sheet>
      )}
      {edit && <RecipeEditor recipe={edit} onClose={() => setEdit(null)} onSave={r => {
        update(s => ({ ...s, recipes: s.recipes.some(x => x.id === r.id) ? s.recipes.map(x => (x.id === r.id ? r : x)) : [...s.recipes, r] })); setEdit(null)
      }} />}
    </div>
  )
}

function RecipeEditor({ recipe, onClose, onSave }: { recipe: Recipe; onClose: () => void; onSave: (r: Recipe) => void }) {
  const { state } = useStore()
  const [r, setR] = useState<Recipe>({ ...recipe, steps: recipe.steps.length ? recipe.steps : [''] })
  const [add, setAdd] = useState('')
  const parsed = recipeInputSchema.safeParse({ name: r.name, slots: r.slots, ingredients: r.ingredients })
  const errs = parsed.success ? [] : [...new Set(parsed.error.issues.map(i => i.message))]
  const options = state.foods.filter(f => !r.ingredients.some(i => i.foodId === f.id) && (!add || f.name.toLowerCase().includes(add.toLowerCase()))).slice(0, 6)
  const setIng = (idx: number, p: Partial<Ingredient>) => setR({ ...r, ingredients: r.ingredients.map((i, k) => (k === idx ? { ...i, ...p } : i)) })
  return (
    <Sheet title={recipe.id ? 'Rezept bearbeiten' : 'Rezept erstellen'} onClose={onClose} wide>
      <div className="space-y-3">
        <Field label="Name"><input className={inputCls} value={r.name} maxLength={80} onChange={e => setR({ ...r, name: e.target.value })} /></Field>
        <div><p className="text-sm font-medium mb-1">Geeignet für</p><div className="flex flex-wrap gap-2">{(Object.keys(SLOT_LABEL) as MealSlot[]).map(s => <Chip key={s} active={r.slots.includes(s)} onClick={() => setR({ ...r, slots: r.slots.includes(s) ? r.slots.filter(x => x !== s) : [...r.slots, s] })}>{SLOT_LABEL[s]}</Chip>)}</div></div>
        <Field label="Zubereitungszeit (Min.)"><NumInput value={r.minutes} onChange={v => setR({ ...r, minutes: v ?? 0 })} min={1} /></Field>
        <div>
          <p className="text-sm font-medium mb-1">Zutaten (Gramm pro 1 Portion)</p>
          <ul className="space-y-1.5">
            {r.ingredients.map((i, k) => (
              <li key={k} className="flex items-center gap-2">
                <span className="flex-1 text-sm">{i.foodId === OIL_WARM ? 'Öl (warm, dein Öl)' : i.foodId === OIL_COLD ? 'Öl (kalt, dein Öl)' : state.foods.find(f => f.id === i.foodId)?.name ?? i.foodId}</span>
                <div className="w-24"><NumInput aria-label="Gramm" value={i.grams} onChange={v => setIng(k, { grams: v ?? 0 })} min={0.1} step={1} /></div>
                <button aria-label="Zutat entfernen" className="h-9 w-9 rounded-full bg-moss" onClick={() => setR({ ...r, ingredients: r.ingredients.filter((_, x) => x !== k) })}>×</button>
              </li>
            ))}
          </ul>
          <input className={`${inputCls} mt-2`} placeholder="Zutat suchen und hinzufügen…" value={add} onChange={e => setAdd(e.target.value)} />
          <div className="flex flex-wrap gap-2 mt-2">
            {options.map(f => <Chip key={f.id} onClick={() => { setR({ ...r, ingredients: [...r.ingredients, { foodId: f.id, grams: 100 }] }); setAdd('') }}>+ {f.name}</Chip>)}
            <Chip onClick={() => setR({ ...r, ingredients: [...r.ingredients, { foodId: OIL_WARM, grams: 10 }] })}>+ Öl (warm)</Chip>
            <Chip onClick={() => setR({ ...r, ingredients: [...r.ingredients, { foodId: OIL_COLD, grams: 10 }] })}>+ Öl (kalt)</Chip>
          </div>
        </div>
        <Field label="Zubereitung (ein Schritt pro Zeile)"><textarea className={inputCls} rows={4} value={r.steps.join('\n')} onChange={e => setR({ ...r, steps: e.target.value.split('\n') })} /></Field>
        {errs.map(e => <Notice key={e} level="error">{e}</Notice>)}
        <div className="flex gap-2">
          <Btn disabled={!parsed.success} onClick={() => onSave({ ...r, id: r.id || `custom-r-${Date.now().toString(36)}`, name: r.name.trim(), steps: r.steps.map(s => s.trim()).filter(Boolean), custom: r.custom ?? true })}>Speichern</Btn>
          <Btn variant="ghost" onClick={onClose}>Abbrechen</Btn>
        </div>
      </div>
    </Sheet>
  )
}
