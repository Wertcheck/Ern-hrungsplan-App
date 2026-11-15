import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { Btn, Card, Chip, Notice, fmt, inputCls } from '../ui/kit'
import { blsToFood, hasBlsCode, loadBls, searchBls, type BlsIndex } from '../domain/bls'
import { MICRO_KEYS, PREP_LABEL, type Prep } from '../domain/types'

const PREPS: Prep[] = ['roh', 'gekocht', 'konserviert', 'getrocknet', 'verarbeitet']

/** Durchsuchbarer Zugriff auf den vollständigen BLS 4.0 (7.140 Lebensmittel). Übernahme legt eine Kopie in „Meine Lebensmittel“ an. */
export function BlsBrowser() {
  const { state, update } = useStore()
  const [index, setIndex] = useState<BlsIndex | null>(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const dq = useDeferredValue(q)
  const [group, setGroup] = useState('')
  const [prep, setPrep] = useState<Prep | ''>('')
  const [basic, setBasic] = useState(true)
  const [limit, setLimit] = useState(30)
  useEffect(() => { loadBls().then(setIndex).catch(() => setErr('Der BLS-Datensatz konnte nicht geladen werden. Beim ersten Öffnen ist eine Internetverbindung nötig; danach steht er offline zur Verfügung.')) }, [])
  const hits = useMemo(() => (index ? searchBls(index, { text: dq, groups: group ? [group] : undefined, preps: prep ? [prep] : undefined, basicOnly: basic, limit }) : []), [index, dq, group, prep, basic, limit])
  if (err) return <Notice level="error">{err}</Notice>
  if (!index) return <p className="text-muted py-8 text-center" role="status">BLS-Datensatz wird geladen …</p>
  const meta = index.meta
  return (
    <div>
      <Notice level="info">
        <b>{meta.dataset} {meta.version}</b> – amtliche Nährwertdatenbank des Max Rubner-Instituts ({fmt(meta.foodCount)} Lebensmittel, Lizenz {meta.license}). Werte je 100 g essbarer Anteil;
        Kohlenhydrate = verfügbare Kohlenhydrate ohne Ballaststoffe. <b>Allergene sind im BLS nicht enthalten</b> – übernommene Lebensmittel gelten als „Allergene unbekannt“ und werden bei Allergien nicht verwendet, bis du sie ergänzt.
      </Notice>
      <input className={`${inputCls} my-3`} placeholder="BLS durchsuchen, z. B. „Hafer“, „Lachs roh“, „Kürbis“ …" value={q} onChange={e => { setQ(e.target.value); setLimit(30) }} aria-label="BLS durchsuchen" />
      <div className="flex flex-wrap gap-2 items-center mb-3">
        <select aria-label="Lebensmittelgruppe" className="rounded-full border border-sand bg-paper px-3 py-2 text-sm" value={group} onChange={e => { setGroup(e.target.value); setLimit(30) }}>
          <option value="">Alle Gruppen</option>
          {Object.entries(meta.groupLabels).map(([k, v]) => <option key={k} value={k}>{k} – {v}</option>)}
        </select>
        <select aria-label="Zustand" className="rounded-full border border-sand bg-paper px-3 py-2 text-sm" value={prep} onChange={e => { setPrep(e.target.value as Prep | ''); setLimit(30) }}>
          <option value="">Jeder Zustand</option>{PREPS.map(p => <option key={p} value={p}>{PREP_LABEL[p]}</option>)}
        </select>
        <Chip active={basic} onClick={() => { setBasic(!basic); setLimit(30) }}>Nur Grundlebensmittel</Chip>
      </div>
      <div className="grid md:grid-cols-2 gap-2.5">
        {hits.map(({ entry: e }) => {
          const have = hasBlsCode(state.foods, e.code)
          const nm = MICRO_KEYS.filter(k => e.micros[k] !== undefined).length
          return (
            <Card key={e.code} className="!p-3">
              <div className="flex justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold">{e.de}</div>
                  <div className="text-xs text-muted">{e.code} · {meta.groupLabels[e.group] ?? e.group} · {PREP_LABEL[e.prep]}</div>
                </div>
                {have ? <span className="text-xs rounded-full bg-moss px-2.5 py-1 h-fit shrink-0">✓ vorhanden</span>
                  : <Btn variant="soft" className="!px-3 !py-1.5 !min-h-9 text-sm shrink-0" aria-label={`${e.de} übernehmen`} onClick={() => update(s => (hasBlsCode(s.foods, e.code) ? s : { ...s, foods: [...s.foods, blsToFood(e, meta)] }))}>Übernehmen</Btn>}
              </div>
              <div className="text-xs mt-1.5">
                {e.kcal === null ? <span className="text-warn">Energie: keine Daten</span> : <>{fmt(e.kcal)} kcal · E {e.protein === null ? '–' : fmt(e.protein, 1)} · KH {e.carbs === null ? '–' : fmt(e.carbs, 1)} · F {e.fat === null ? '–' : fmt(e.fat, 1)} · Bst {e.fiber === null ? '–' : fmt(e.fiber, 1)} g</>}
                <span className="text-muted"> · {nm}/{MICRO_KEYS.length} Mikronährstoffe</span>
              </div>
            </Card>
          )
        })}
      </div>
      {hits.length === 0 && <p className="text-center text-muted py-8">Keine Treffer.</p>}
      {hits.length >= limit && <div className="text-center mt-3"><Btn variant="ghost" onClick={() => setLimit(limit + 30)}>Mehr anzeigen</Btn></div>}
      <p className="text-xs text-muted mt-4">Quelle: {meta.citation}. Lizenz: <a className="underline" href={meta.licenseUrl} target="_blank" rel="noreferrer">{meta.license}</a>. Die Daten wurden für diese App normalisiert (Rundung auf 4 signifikante Stellen); fehlende Werte sind nicht 0.</p>
    </div>
  )
}
