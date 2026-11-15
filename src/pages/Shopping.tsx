import { useMemo, useState } from 'react'
import { useStore } from '../store'
import { Btn, Card, PageTitle, fmt, inputCls, cx } from '../ui/kit'
import { buildShoppingList } from '../domain/shopping'
import { CATEGORY_LABEL } from '../domain/types'
import { CAT_EMOJI } from '../ui/kit'

export function ShoppingPage() {
  const { state, update, ctx } = useStore()
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const sh = state.shopping
  const list = useMemo(() => buildShoppingList(state.plan, ctx.recipes, ctx.foods, ctx.oils, state.plan?.persons ?? state.profile.persons, sh), [state.plan, ctx, state.profile.persons, sh])
  const toggle = (key: string, manual?: boolean) => update(s => manual
    ? { ...s, shopping: { ...s.shopping, manual: s.shopping.manual.map(m => (m.id === key ? { ...m, checked: !m.checked } : m)) } }
    : { ...s, shopping: { ...s.shopping, checked: s.shopping.checked.includes(key) ? s.shopping.checked.filter(x => x !== key) : [...s.shopping.checked, key] } })
  const remove = (key: string, manual?: boolean) => update(s => manual
    ? { ...s, shopping: { ...s.shopping, manual: s.shopping.manual.filter(m => m.id !== key) } }
    : { ...s, shopping: { ...s.shopping, removed: [...s.shopping.removed, key] } })
  const addManual = () => {
    const n = name.trim()
    if (!n) return
    update(s => ({ ...s, shopping: { ...s.shopping, manual: [...s.shopping.manual, { id: `man-${Date.now().toString(36)}`, name: n, amount: amount.trim(), checked: false }] } }))
    setName(''); setAmount('')
  }
  const done = list.groups.flatMap(g => g.items).filter(i => i.checked).length
  return (
    <div>
      <PageTitle title="Einkaufsliste" sub={state.plan ? `Für ${state.plan.days.length} Tage · ${state.plan.persons} Person(en) · ${done}/${list.total} erledigt` : 'Erstelle zuerst einen Ernährungsplan.'}
        right={sh.removed.length > 0 ? <Btn variant="ghost" onClick={() => update(s => ({ ...s, shopping: { ...s.shopping, removed: [] } }))}>Entfernte wiederherstellen</Btn> : undefined} />
      <Card className="mb-4">
        <div className="flex gap-2 flex-wrap">
          <input className={cx(inputCls, 'flex-1 min-w-40')} placeholder="Eigenes Produkt…" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && addManual()} aria-label="Produkt" />
          <input className={cx(inputCls, 'w-32')} placeholder="Menge" value={amount} onChange={e => setAmount(e.target.value)} onKeyDown={e => e.key === 'Enter' && addManual()} aria-label="Menge" />
          <Btn onClick={addManual}>Hinzufügen</Btn>
        </div>
      </Card>
      {list.groups.map(g => (
        <section key={g.category} className="mb-4 rise">
          <h2 className="text-xl mb-2">{CAT_EMOJI[g.category]} {CATEGORY_LABEL[g.category]}</h2>
          <ul className="rounded-3xl bg-paper/90 border border-sand/70 divide-y divide-sand/60 overflow-hidden">
            {g.items.map(i => (
              <li key={i.key} className="flex items-center gap-3 px-4 py-2.5">
                <input type="checkbox" className="h-5 w-5 accent-[#2f5d2a]" checked={i.checked} onChange={() => toggle(i.key, i.manual)} aria-label={`${i.name} erledigt`} />
                <span className={cx('flex-1', i.checked && 'line-through text-muted')}>{i.name}{i.manual && <span className="text-xs text-muted"> (manuell)</span>}</span>
                <span className="text-sm text-muted">{i.manual ? i.amount : <>{fmt(i.grams)} g{i.hint ? ` (${i.hint})` : ''}</>}</span>
                <button className="text-muted hover:text-danger px-2 h-9" aria-label={`${i.name} entfernen`} onClick={() => remove(i.key, i.manual)}>×</button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {list.total === 0 && <p className="text-center text-muted py-10">Die Liste ist leer.</p>}
      <p className="text-xs text-muted">Mengen sind Rohgewichte laut Rezepten und aktualisieren sich automatisch, wenn der Plan geändert wird.</p>
    </div>
  )
}
