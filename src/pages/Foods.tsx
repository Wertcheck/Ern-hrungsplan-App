import { useMemo, useState } from 'react'
import { useStore } from '../store'
import { Btn, Card, Chip, Field, NumInput, Notice, PageTitle, Sheet, fmt, inputCls, cx, CAT_EMOJI } from '../ui/kit'
import { BlsBrowser } from './BlsBrowser'
import { foodInputSchema } from '../domain/schemas'
import { foodViolation } from '../domain/rules'
import { ALLERGENS, ALLERGEN_LABEL, CATEGORIES, CATEGORY_LABEL, GROUP_LABEL, MICRO_INFO, MICRO_KEYS, PREP_LABEL, QUALITY_LABEL, type Allergen, type AnimalOrigin, type Category, type Food, type FoodGroup, type MicroKey, type Prep } from '../domain/types'

type Filter = 'alle' | 'favoriten' | 'bevorzugt' | 'ausgeschlossen' | 'eigene'
const blank = (): Food => ({ id: '', name: '', category: 'gemuese', kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, allergens: [], traces: [], allergenInfoKnown: false, animal: 'none', group: 'gemuese', prep: 'roh', source: 'Eigene Angabe', dataQuality: 'user', custom: true })

export function FoodsPage() {
  const { state, update } = useStore()
  const [q, setQ] = useState('')
  const [cat, setCat] = useState<Category | 'alle'>('alle')
  const [filter, setFilter] = useState<Filter>('alle')
  const [edit, setEdit] = useState<Food | null>(null)
  const [tab, setTab] = useState<'meine' | 'bls'>('meine')
  const { prefs } = state
  const list = useMemo(() => {
    const t = q.trim().toLowerCase()
    return state.foods.filter(f =>
      (cat === 'alle' || f.category === cat) && (!t || f.name.toLowerCase().includes(t)) &&
      (filter === 'alle' || (filter === 'favoriten' && prefs.favoriteFoods.includes(f.id)) || (filter === 'bevorzugt' && prefs.preferredFoods.includes(f.id)) ||
        (filter === 'ausgeschlossen' && prefs.excludedFoods.includes(f.id)) || (filter === 'eigene' && f.custom))
    ).sort((a, b) => a.name.localeCompare(b.name, 'de'))
  }, [state.foods, q, cat, filter, prefs])

  const toggle = (key: 'favoriteFoods' | 'preferredFoods' | 'excludedFoods', id: string) => update(s => {
    const cur = s.prefs[key], has = cur.includes(id)
    const next = { ...s.prefs, [key]: has ? cur.filter(x => x !== id) : [...cur, id] }
    if (!has && key === 'excludedFoods') next.preferredFoods = next.preferredFoods.filter(x => x !== id)
    if (!has && key === 'preferredFoods') next.excludedFoods = next.excludedFoods.filter(x => x !== id)
    return { ...s, prefs: next }
  })
  const remove = (f: Food) => {
    const used = state.recipes.filter(r => r.ingredients.some(i => i.foodId === f.id))
    if (used.length && !confirm(`„${f.name}“ wird in ${used.length} Rezept(en) verwendet (${used.slice(0, 3).map(r => r.name).join(', ')}…). Diese Rezepte werden dann ohne diese Zutat berechnet und sind ggf. unvollständig. Trotzdem löschen?`)) return
    if (!used.length && !confirm(`„${f.name}“ löschen?`)) return
    update(s => ({ ...s, foods: s.foods.filter(x => x.id !== f.id), prefs: { ...s.prefs, favoriteFoods: s.prefs.favoriteFoods.filter(x => x !== f.id), preferredFoods: s.prefs.preferredFoods.filter(x => x !== f.id), excludedFoods: s.prefs.excludedFoods.filter(x => x !== f.id) } }))
  }
  const save = (f: Food) => update(s => ({ ...s, foods: s.foods.some(x => x.id === f.id) ? s.foods.map(x => (x.id === f.id ? f : x)) : [...s.foods, f] }))

  return (
    <div>
      <PageTitle title="Meine Lebensmittel" sub={`${state.foods.length} Lebensmittel · Richtwerte pro 100 g`} right={<Btn onClick={() => setEdit(blank())}>+ Neu</Btn>} />
      <div className="flex gap-2 mb-3" role="tablist" aria-label="Datenbestand">
        <Chip active={tab === 'meine'} onClick={() => setTab('meine')}>Meine Lebensmittel</Chip>
        <Chip active={tab === 'bls'} onClick={() => setTab('bls')}>BLS-Datenbank (7.140)</Chip>
      </div>
      {tab === 'bls' ? <BlsBrowser /> : <>
      <input className={cx(inputCls, 'mb-3')} placeholder="Lebensmittel suchen…" value={q} onChange={e => setQ(e.target.value)} aria-label="Lebensmittel suchen" />
      <div className="flex gap-2 overflow-x-auto pb-2 items-start">
        <Chip active={cat === 'alle'} onClick={() => setCat('alle')}>Alle</Chip>
        {CATEGORIES.map(c => <Chip key={c} active={cat === c} onClick={() => setCat(c)}>{CAT_EMOJI[c]} {CATEGORY_LABEL[c]}</Chip>)}
      </div>
      <div className="flex gap-2 flex-wrap mb-4">
        {(['alle', 'favoriten', 'bevorzugt', 'ausgeschlossen', 'eigene'] as Filter[]).map(f => <Chip key={f} active={filter === f} onClick={() => setFilter(f)}>{f[0].toUpperCase() + f.slice(1)}</Chip>)}
      </div>
      <div className="grid md:grid-cols-2 gap-2.5">
        {list.map(f => {
          const viol = foodViolation(f, { ...prefs, excludedFoods: [] })
          const ex = prefs.excludedFoods.includes(f.id)
          return (
            <Card key={f.id} className={cx('!p-3', ex && 'opacity-70')}>
              <div className="flex gap-3">
                <div aria-hidden className="h-12 w-12 shrink-0 rounded-2xl bg-gradient-to-br from-moss to-sand grid place-items-center text-2xl">{CAT_EMOJI[f.category]}</div>
                <div className="flex-1 min-w-0">
                  <button onClick={() => setEdit(f)} className="font-semibold text-left hover:underline">{f.name}</button>
                  <div className="text-xs text-muted">{fmt(f.kcal)} kcal · E {fmt(f.protein, 1)} · KH {fmt(f.carbs, 1)} · F {fmt(f.fat, 1)} · Bst {fmt(f.fiber, 1)}</div>
                  <div className="flex flex-wrap gap-1 mt-1 text-[11px]">
                    {f.allergens.map(a => <span key={a} className="rounded-full bg-sand/60 px-2 py-0.5">{ALLERGEN_LABEL[a]}</span>)}
                    {!f.allergenInfoKnown && <span className="rounded-full bg-[#fbeedd] text-warn px-2 py-0.5">Allergene unbekannt</span>}
                    {(f.traces ?? []).filter(a => !f.allergens.includes(a)).map(a => <span key={'t' + a} className="rounded-full bg-sand/40 px-2 py-0.5" title="Mögliche Spuren (Näherung)">Spuren: {ALLERGEN_LABEL[a]}</span>)}
                    <span className="rounded-full bg-sand/40 text-sandtext px-2 py-0.5" title={f.sourceRef?.name ?? f.source}>{QUALITY_LABEL[f.dataQuality]} · {PREP_LABEL[f.prep]}</span>
                    {f.micros && Object.keys(f.micros).length > 0 && <span className="rounded-full bg-moss px-2 py-0.5">Mikronährstoffe</span>}
                    {(f.missingFields ?? []).length > 0 && <span className="rounded-full bg-[#fbeedd] text-warn px-2 py-0.5" title="Für diese Werte liefert die Quelle keine Daten">keine Daten: {(f.missingFields ?? []).map(k => ({ kcal: 'Energie', protein: 'Eiweiß', fat: 'Fett', carbs: 'Kohlenhydrate', fiber: 'Ballaststoffe' } as Record<string, string>)[k] ?? k).join(', ')}</span>}
                    {viol && <span className="rounded-full bg-danger/10 text-danger px-2 py-0.5">wird wegen Einstellungen nicht verwendet</span>}
                  </div>
                </div>
              </div>
              <div className="flex gap-1.5 mt-2 flex-wrap">
                <Chip active={prefs.favoriteFoods.includes(f.id)} onClick={() => toggle('favoriteFoods', f.id)}>★ Favorit</Chip>
                <Chip active={prefs.preferredFoods.includes(f.id)} onClick={() => toggle('preferredFoods', f.id)}>👍 Bevorzugen</Chip>
                <Chip active={ex} tone="danger" onClick={() => toggle('excludedFoods', f.id)}>🚫 Ausschließen</Chip>
                <button className="ml-auto text-sm text-muted hover:text-danger px-2" onClick={() => remove(f)} aria-label={`${f.name} löschen`}>Löschen</button>
              </div>
            </Card>
          )
        })}
      </div>
      {list.length === 0 && <p className="text-center text-muted py-10">Keine Lebensmittel gefunden.</p>}
      </>}
      {edit && <FoodEditor food={edit} onClose={() => setEdit(null)} onSave={f => { save(f); setEdit(null) }} />}
    </div>
  )
}

function FoodEditor({ food, onClose, onSave }: { food: Food; onClose: () => void; onSave: (f: Food) => void }) {
  const isNew = !food.id
  const [f, setF] = useState<Food>(food)
  const [known, setKnown] = useState(food.allergenInfoKnown)
  const [unitG, setUnitG] = useState<number | undefined>(food.unit?.grams)
  const [micros, setMicros] = useState<Partial<Record<MicroKey, number>>>(food.micros ?? {})
  const [unitL, setUnitL] = useState(food.unit?.label ?? 'Stück')
  const r = foodInputSchema.safeParse({ name: f.name, category: f.category, kcal: f.kcal, protein: f.protein, carbs: f.carbs, fat: f.fat, fiber: f.fiber })
  const errs = r.success ? [] : [...new Set(r.error.issues.map(i => i.message))]
  const num = (k: 'kcal' | 'protein' | 'carbs' | 'fat' | 'fiber', label: string) => <Field label={label}><NumInput value={f[k]} onChange={v => setF({ ...f, [k]: v ?? 0, dataQuality: 'user' })} min={0} step={0.1} /></Field>
  const toggleA = (a: Allergen) => setF({ ...f, allergens: f.allergens.includes(a) ? f.allergens.filter(x => x !== a) : [...f.allergens, a] })
  const toggleT = (a: Allergen) => setF({ ...f, traces: (f.traces ?? []).includes(a) ? (f.traces ?? []).filter(x => x !== a) : [...(f.traces ?? []), a] })
  const numChanged = (['kcal', 'protein', 'carbs', 'fat', 'fiber'] as const).some(k => f[k] !== food[k])
  return (
    <Sheet title={isNew ? 'Lebensmittel anlegen' : 'Lebensmittel bearbeiten'} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Bezeichnung"><input className={inputCls} value={f.name} maxLength={80} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Kategorie"><select className={inputCls} value={f.category} onChange={e => setF({ ...f, category: e.target.value as Category })}>{CATEGORIES.map(c => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}</select></Field>
        <p className="text-sm font-medium">Nährwerte pro 100 g</p>
        <div className="grid grid-cols-2 gap-2">{num('kcal', 'Kalorien (kcal)')}{num('protein', 'Eiweiß (g)')}{num('carbs', 'Kohlenhydrate, verfügbar (g)')}{num('fat', 'Fett (g)')}{num('fiber', 'Ballaststoffe (g)')}</div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Zustand der Mengenangabe"><select className={inputCls} value={f.prep} onChange={e => setF({ ...f, prep: e.target.value as Prep })}>{(Object.keys(PREP_LABEL) as Prep[]).map(p => <option key={p} value={p}>{PREP_LABEL[p]}</option>)}</select></Field>
          <Field label="Lebensmittelgruppe (für Ernährungsweisen)"><select className={inputCls} value={f.group} onChange={e => setF({ ...f, group: e.target.value as FoodGroup })}>{(Object.keys(GROUP_LABEL) as FoodGroup[]).map(g => <option key={g} value={g}>{GROUP_LABEL[g]}</option>)}</select></Field>
        </div>
        <Field label="Tierische Herkunft (für vegan/vegetarisch)">
          <select className={inputCls} value={f.animal} onChange={e => setF({ ...f, animal: e.target.value as AnimalOrigin })}>
            <option value="none">pflanzlich</option><option value="unknown">unbekannt (zusammengesetzt)</option><option value="meat">Fleisch</option><option value="fish">Fisch/Meeresfrüchte</option><option value="dairy">Milchprodukt</option><option value="egg">Ei</option><option value="honey">Honig</option>
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Haushaltseinheit (optional)"><input className={inputCls} value={unitL} onChange={e => setUnitL(e.target.value)} placeholder="Stück" /></Field>
          <Field label="Gramm pro Einheit"><NumInput value={unitG} onChange={setUnitG} min={1} /></Field>
        </div>
        <div>
          <p className="text-sm font-medium mb-1">Allergene / Inhaltsstoffe</p>
          <label className="flex items-center gap-2 text-sm mb-2"><input type="checkbox" checked={known} onChange={e => setKnown(e.target.checked)} /> Allergeninformation ist mir bekannt und vollständig</label>
          {!known && <Notice level="warn">Ohne Angabe gilt das Lebensmittel als „Allergene unbekannt“ und wird bei Allergien konsequent nicht verwendet.</Notice>}
          <div className="flex flex-wrap gap-2 mt-2">{ALLERGENS.map(a => <Chip key={a} active={f.allergens.includes(a)} onClick={() => toggleA(a)}>{ALLERGEN_LABEL[a]}</Chip>)}</div>
        </div>
        <div>
          <p className="text-sm font-medium mb-1">Mögliche Spuren (Kreuzkontamination)</p>
          <div className="flex flex-wrap gap-2">{ALLERGENS.map(a => <Chip key={a} active={(f.traces ?? []).includes(a)} onClick={() => toggleT(a)}>{ALLERGEN_LABEL[a]}</Chip>)}</div>
          <p className="text-xs text-muted mt-1">Bei Allergien werden Spuren standardmäßig ebenfalls ausgeschlossen (einstellbar).</p>
        </div>
        <details className="rounded-2xl border border-sand/70 bg-white/60 px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">Mikronährstoffe pro 100 g (optional)</summary>
          <p className="text-xs text-muted my-2">Nur ausfüllen, wenn dir verlässliche Werte vorliegen. Leere Felder bedeuten „keine Daten“ – sie werden nie als 0 gerechnet.</p>
          <div className="grid grid-cols-2 gap-2">
            {MICRO_KEYS.map(k => <Field key={k} label={`${MICRO_INFO[k].label} (${MICRO_INFO[k].unit})`}><NumInput value={micros[k]} min={0} step={0.1} onChange={v => setMicros(m => { const n = { ...m }; if (v === undefined) delete n[k]; else n[k] = v; return n })} /></Field>)}
          </div>
        </details>
        <Field label="Quelle der Nährwerte"><input className={inputCls} value={f.source} onChange={e => setF({ ...f, source: e.target.value, dataQuality: 'user' })} maxLength={200} /></Field>
        <p className="text-xs text-muted">Manuell eingegebene oder geänderte Werte gelten als „Eigene Angabe“, nie als „verifiziert“.</p>
        {errs.map(e => <Notice key={e} level="error">{e}</Notice>)}
        <div className="flex gap-2 pt-2">
          <Btn disabled={!r.success} onClick={() => onSave({ ...f, id: f.id || `custom-${Date.now().toString(36)}`, name: f.name.trim(), allergenInfoKnown: known, unit: unitG && unitG > 0 ? { label: unitL || 'Stück', grams: unitG } : undefined, micros: Object.keys(micros).length ? micros : undefined, dataQuality: f.custom || numChanged || f.dataQuality === 'user' ? 'user' : f.dataQuality, custom: f.custom ?? false })}>Speichern</Btn>
          <Btn variant="ghost" onClick={onClose}>Abbrechen</Btn>
        </div>
      </div>
    </Sheet>
  )
}
