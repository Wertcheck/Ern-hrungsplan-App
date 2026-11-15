import { useMemo, useState } from 'react'
import { useStore } from '../store'
import { Card, Chip, Field, NumInput, Notice, inputCls, cx, fmt } from '../ui/kit'
import { ACTIVITY_LABEL, estimateKcal } from '../domain/nutrition'
import { profileSchema } from '../domain/schemas'
import { analyzePrefs } from '../domain/rules'
import { allDiets, getDiet } from '../domain/diets'
import { customRuleSchema } from '../domain/schemas'
import { ALLERGENS, ALLERGEN_LABEL, CATEGORIES, CATEGORY_LABEL, GROUP_LABEL, STYLE_LABEL, type Activity, type Allergen, type CustomRule, type FoodGroup, type Goal, type Profile, type RuleKind, type Style, type Severity } from '../domain/types'

export const GOAL_LABEL: Record<Goal, string> = { halten: 'Gewicht halten', reduzieren: 'Gewicht reduzieren', aufbauen: 'Gewicht aufbauen', ausgewogen: 'Allgemein ausgewogen ernähren' }

export function profileErrors(p: Profile): Record<string, string> {
  const r = profileSchema.safeParse(p)
  const out: Record<string, string> = {}
  if (!r.success) for (const i of r.error.issues) out[String(i.path[0])] = i.message.includes('expected') || i.message.includes('Invalid') ? 'Ungültiger Wert' : i.message
  return out
}

export function ProfileForm() {
  const { state, update } = useStore()
  const p = state.profile
  const set = (patch: Partial<Profile>) => update(s => ({ ...s, profile: { ...s.profile, ...patch } }))
  const err = profileErrors(p)
  const est = useMemo(() => estimateKcal(p), [p])
  const valid = !err.age && !err.heightCm && !err.weightKg
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Field label="Alter (Jahre)" error={err.age}><NumInput value={p.age} onChange={v => set({ age: v ?? NaN })} min={14} max={100} /></Field>
        <Field label="Größe (cm)" error={err.heightCm}><NumInput value={p.heightCm} onChange={v => set({ heightCm: v ?? NaN })} min={120} max={230} /></Field>
        <Field label="Gewicht (kg)" error={err.weightKg}><NumInput value={p.weightKg} onChange={v => set({ weightKg: v ?? NaN })} step={0.1} min={30} max={300} /></Field>
        <Field label="Zielgewicht (optional)" error={err.targetWeightKg}><NumInput value={p.targetWeightKg} onChange={v => set({ targetWeightKg: v })} step={0.1} /></Field>
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Geschlecht" hint="Nur für die Schätzung des Grundumsatzes.">
          <select className={inputCls} value={p.sex} onChange={e => set({ sex: e.target.value as Profile['sex'] })}>
            <option value="f">weiblich</option><option value="m">männlich</option><option value="d">divers / keine Angabe</option>
          </select>
        </Field>
        <Field label="Aktivitätsniveau">
          <select className={inputCls} value={p.activity} onChange={e => set({ activity: e.target.value as Activity })}>
            {Object.entries(ACTIVITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Ernährungsziel">
          <select className={inputCls} value={p.goal} onChange={e => set({ goal: e.target.value as Goal })}>
            {Object.entries(GOAL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Mahlzeiten pro Tag" hint="3 Hauptmahlzeiten, optional 1–2 Zwischenmahlzeiten">
          <select className={inputCls} value={p.mealCount} onChange={e => set({ mealCount: Number(e.target.value) as 3 | 4 | 5 })}>
            <option value={3}>3 (ohne Snack)</option><option value={4}>4 (1 Snack)</option><option value={5}>5 (2 Snacks)</option>
          </select>
        </Field>
        <Field label="Personen" hint="Einkaufsmengen und Rezepte werden für diese Anzahl berechnet."><NumInput value={p.persons} onChange={v => set({ persons: v ?? 1 })} min={1} max={10} /></Field>
      </div>

      <Card className="!bg-moss/40">
        <div className="flex gap-2 mb-3">
          <Chip active={p.kcalMode === 'auto'} onClick={() => set({ kcalMode: 'auto' })}>Automatisch schätzen</Chip>
          <Chip active={p.kcalMode === 'manual'} onClick={() => set({ kcalMode: 'manual' })}>Manuell festlegen</Chip>
        </div>
        {p.kcalMode === 'manual' ? (
          <Field label="Tägliches Kalorienziel (kcal)" error={err.kcalManual} hint="Zulässig: 1.200 – 4.500 kcal. Bei sehr niedrigen oder hohen Werten kann der Plan das Ziel ggf. nicht exakt erreichen.">
            <NumInput value={p.kcalManual} onChange={v => set({ kcalManual: v ?? NaN })} step={50} min={1200} max={4500} />
          </Field>
        ) : (
          <div>
            <p className="font-serif text-3xl text-forest-dark">{fmt(valid ? est.target : 0)} <span className="text-base font-sans text-muted">kcal / Tag</span></p>
            <p className="text-sm font-medium mt-2">Zugrunde liegende Annahmen</p>
            <ul className="text-sm text-muted list-disc pl-5 space-y-0.5 mt-1">{valid && est.notes.map(n => <li key={n}>{n}</li>)}</ul>
          </div>
        )}
        {p.kcalMode === 'manual' && p.kcalManual < 1500 && <div className="mt-3"><Notice level="warn">Ein sehr niedriges Kalorienziel sollte nicht ohne ärztliche Begleitung verfolgt werden.</Notice></div>}
      </Card>
    </div>
  )
}

export function StyleForm() {
  const { state, update } = useStore()
  const { styles } = state.prefs
  const toggle = (s: Style) => update(st => {
    let next = st.prefs.styles.includes(s) ? st.prefs.styles.filter(x => x !== s) : [...st.prefs.styles, s]
    if (s === 'mischkost' && next.includes(s)) next = ['mischkost']
    else if (s !== 'mischkost') next = next.filter(x => x !== 'mischkost')
    if (!next.length) next = ['mischkost']
    return { ...st, prefs: { ...st.prefs, styles: next } }
  })
  const a = analyzePrefs(state.prefs)
  // Neutrale, alphabetische Reihenfolge – keine Weise wird hervorgehoben oder empfohlen
  const list = allDiets().filter(d => (Object.keys(STYLE_LABEL) as string[]).includes(d.id)).sort((x, y) => x.label.localeCompare(y.label, 'de'))
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">{list.map(d => <Chip key={d.id} active={styles.includes(d.id as Style)} onClick={() => toggle(d.id as Style)} title={d.summary}>{d.label}</Chip>)}</div>
      <p className="text-xs text-muted">Mehrere kompatible Weisen können kombiniert werden. Alle Weisen sind gleichrangig; die App bewertet keine Ernährungsweise als medizinisch überlegen. Ein Wechsel ist jederzeit möglich – ein bestehender Plan wird dann auf Regelverstöße geprüft.</p>
      {a.conflicts.map(c => <Notice key={c} level="error">Widerspruch: {c} Ein Plan kann so nicht erstellt werden.</Notice>)}
      {a.tensions.map(c => <Notice key={c} level="warn">{c}</Notice>)}
      {a.infos.map(c => <Notice key={c} level="info">{c}</Notice>)}
      {a.other.map(c => <Notice key={c} level="warn">{c}</Notice>)}
      <div className="space-y-2">
        {styles.map(id => { const d = getDiet(id); if (!d) return null; return (
          <details key={id} className="rounded-2xl border border-sand/70 bg-white/60 px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">Regeln: {d.label} – {d.summary}</summary>
            <ul className="list-disc pl-5 text-sm text-muted mt-2 space-y-0.5">{d.definition.map(x => <li key={x}>{x}</li>)}</ul>
            {(d.gapNotes ?? []).length > 0 && <div className="mt-2"><p className="text-sm font-medium">Allgemeine Hinweise (keine Diagnose)</p><ul className="list-disc pl-5 text-sm text-muted space-y-0.5">{d.gapNotes!.map(x => <li key={x}>{x}</li>)}</ul></div>}
          </details>
        ) })}
      </div>
    </div>
  )
}

const RULE_LABEL: Record<RuleKind, string> = {
  exclude_group: 'Lebensmittelgruppe ausschließen', exclude_category: 'Kategorie ausschließen', exclude_term: 'Begriff im Namen ausschließen',
  max_carb_pct: 'Rezepte: max. Kohlenhydrat-Energieanteil (%)', min_protein_pct: 'Rezepte: min. Eiweiß-Energieanteil (%)', max_fat_pct: 'Rezepte: max. Fett-Energieanteil (%)',
}

/** Eigene Regeln: gelten zusätzlich zu den gewählten Ernährungsweisen als harte Bedingungen. */
export function RulesForm() {
  const { state, update } = useStore()
  const rules = state.prefs.customRules
  const [kind, setKind] = useState<RuleKind>('exclude_group')
  const [val, setVal] = useState<string>('fisch')
  const [name, setName] = useState('')
  const numeric = kind.endsWith('_pct')
  const set = (r: CustomRule[]) => update(s => ({ ...s, prefs: { ...s.prefs, customRules: r } }))
  const changeKind = (k: RuleKind) => { setKind(k); setVal(k === 'exclude_group' ? 'fisch' : k === 'exclude_category' ? 'fisch' : k === 'exclude_term' ? '' : '25') }
  const parsed = customRuleSchema.safeParse({ id: 'x', name: name.trim() || RULE_LABEL[kind], kind, value: numeric ? Number(val) : val, enabled: true })
  const valid = parsed.success && (numeric ? Number(val) > 0 && Number(val) <= 100 : val.trim().length > 0)
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">Eigene Regeln werden zusätzlich zu den Ernährungsweisen als feste Bedingungen angewendet (Allergien haben stets Vorrang und können dadurch nicht gelockert werden).</p>
      <ul className="space-y-1.5">
        {rules.map(r => (
          <li key={r.id} className="flex items-center gap-2 rounded-2xl bg-white/70 border border-sand/70 px-3 py-2 text-sm">
            <input type="checkbox" className="h-5 w-5 accent-[#2f5d2a]" checked={r.enabled} aria-label={`${r.name} aktiv`} onChange={() => set(rules.map(x => (x.id === r.id ? { ...x, enabled: !x.enabled } : x)))} />
            <span className={cx('flex-1', !r.enabled && 'text-muted line-through')}><b>{r.name}</b> · {RULE_LABEL[r.kind]}: {String(r.value)}</span>
            <button className="text-muted hover:text-danger px-2" aria-label={`${r.name} löschen`} onClick={() => set(rules.filter(x => x.id !== r.id))}>×</button>
          </li>
        ))}
      </ul>
      <div className="grid md:grid-cols-[2fr_1.2fr_1fr_auto] gap-2 items-end">
        <Field label="Regeltyp"><select className={inputCls} value={kind} onChange={e => changeKind(e.target.value as RuleKind)}>{(Object.keys(RULE_LABEL) as RuleKind[]).map(k => <option key={k} value={k}>{RULE_LABEL[k]}</option>)}</select></Field>
        <Field label="Wert">
          {kind === 'exclude_group' ? <select className={inputCls} value={val} onChange={e => setVal(e.target.value)}>{(Object.keys(GROUP_LABEL) as FoodGroup[]).map(g => <option key={g} value={g}>{GROUP_LABEL[g]}</option>)}</select>
            : kind === 'exclude_category' ? <select className={inputCls} value={val} onChange={e => setVal(e.target.value)}>{CATEGORIES.map(c => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}</select>
            : <input className={inputCls} value={val} maxLength={60} inputMode={numeric ? 'numeric' : 'text'} onChange={e => setVal(e.target.value)} placeholder={numeric ? '1–100' : 'z. B. Koriander'} />}
        </Field>
        <Field label="Name (optional)"><input className={inputCls} value={name} maxLength={60} onChange={e => setName(e.target.value)} /></Field>
        <button disabled={!valid} className="rounded-full bg-forest text-white px-5 min-h-11 disabled:opacity-40" onClick={() => { set([...rules, { id: `rule-${Date.now().toString(36)}`, name: name.trim() || RULE_LABEL[kind], kind, value: numeric ? Number(val) : val.trim(), enabled: true }]); setName('') }}>Hinzufügen</button>
      </div>
    </div>
  )
}

export function RestrictionForm() {
  const { state, update } = useStore()
  const rs = state.prefs.restrictions
  const [custom, setCustom] = useState('')
  const get = (a: Allergen) => rs.find(r => r.allergen === a)?.severity
  const setSev = (a: Allergen, sev: Severity | null) => update(s => ({
    ...s, prefs: { ...s.prefs, restrictions: [...s.prefs.restrictions.filter(r => r.allergen !== a), ...(sev ? [{ allergen: a, severity: sev }] : [])] },
  }))
  const addCustom = () => {
    const t = custom.trim()
    if (!t || t.length > 40 || state.prefs.customExclusions.includes(t)) return
    update(s => ({ ...s, prefs: { ...s.prefs, customExclusions: [...s.prefs.customExclusions, t] } })); setCustom('')
  }
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {ALLERGENS.map(a => {
          const sev = get(a)
          return (
            <div key={a} className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 rounded-2xl bg-white/70 border border-sand/70 px-3 py-2">
              <span className="font-medium">{ALLERGEN_LABEL[a]}</span>
              <div className="flex flex-wrap gap-1.5">
                <Chip active={!sev} onClick={() => setSev(a, null)}>Kein</Chip>
                <Chip active={sev === 'intolerance'} onClick={() => setSev(a, 'intolerance')} tone="warn">Unverträglich</Chip>
                <Chip active={sev === 'allergy'} onClick={() => setSev(a, 'allergy')} tone="danger">Allergie</Chip>
              </div>
            </div>
          )
        })}
      </div>
      <Notice level="info"><b>Allergie</b> = strikter Ausschluss, auch bei unbekannter Zusammensetzung (z. B. eigene Lebensmittel ohne Allergenangabe). <b>Unverträglichkeit</b> = Lebensmittel mit diesem Inhaltsstoff werden ebenfalls nicht verwendet. Allergenangaben sind Richtwerte; Spuren und Kreuzkontaminationen werden nicht erfasst. Bei medizinisch relevanten Allergien immer Etiketten prüfen.</Notice>
      <label className="flex items-start gap-2 text-sm rounded-2xl bg-white/70 border border-sand/70 px-3 py-2">
        <input type="checkbox" className="h-5 w-5 mt-0.5 accent-[#2f5d2a]" checked={state.prefs.strictTraces} onChange={e => update(s => ({ ...s, prefs: { ...s.prefs, strictTraces: e.target.checked } }))} />
        <span><b>Strenge Spurenregel bei Allergien</b> – auch Lebensmittel mit möglichen Spuren (Kreuzkontamination, z. B. Nuss-Spuren in Haferflocken) werden bei Allergien nicht verwendet. Empfohlen für echte Allergien; für Unverträglichkeiten ohne Wirkung.</span>
      </label>
      <div>
        <p className="font-medium text-sm mb-1">Sonstige individuelle Ausschlüsse</p>
        <div className="flex gap-2">
          <input className={inputCls} value={custom} maxLength={40} placeholder="z. B. Kürbis, Koriander" onChange={e => setCustom(e.target.value)} onKeyDown={e => e.key === 'Enter' && addCustom()} aria-label="Ausschluss hinzufügen" />
          <button onClick={addCustom} className="rounded-full bg-forest text-white px-5 min-h-11">Hinzufügen</button>
        </div>
        <div className="flex flex-wrap gap-2 mt-2">
          {state.prefs.customExclusions.map(t => <Chip key={t} active tone="danger" onClick={() => update(s => ({ ...s, prefs: { ...s.prefs, customExclusions: s.prefs.customExclusions.filter(x => x !== t) } }))}>{t} ×</Chip>)}
        </div>
      </div>
    </div>
  )
}

export function OilForm() {
  const { state, update } = useStore()
  const o = state.prefs.oils
  const oils = state.foods.filter(f => f.category === 'oele' && f.oil)
  const patch = (p: Partial<typeof o>) => update(s => ({ ...s, prefs: { ...s.prefs, oils: { ...s.prefs.oils, ...p } } }))
  const status = (id: string) => (o.excluded.includes(id) ? 'ex' : o.preferred.includes(id) ? 'pref' : '')
  const setStatus = (id: string, st: '' | 'pref' | 'ex') => patch({
    preferred: st === 'pref' ? [...o.preferred.filter(x => x !== id), id] : o.preferred.filter(x => x !== id),
    excluded: st === 'ex' ? [...o.excluded.filter(x => x !== id), id] : o.excluded.filter(x => x !== id),
    main: st === 'ex' && o.main === id ? null : o.main, warm: st === 'ex' && o.warm === id ? null : o.warm, cold: st === 'ex' && o.cold === id ? null : o.cold,
  })
  const usable = oils.filter(f => !o.excluded.includes(f.id))
  const sel = (key: 'main' | 'warm' | 'cold', label: string, filter: (f: typeof oils[number]) => boolean, hint: string) => (
    <Field label={label} hint={hint}>
      <select className={inputCls} value={o[key] ?? ''} onChange={e => patch({ [key]: e.target.value || null } as never)}>
        <option value="">{key === 'main' ? 'Kein Hauptöl' : 'Automatisch'}</option>
        {usable.filter(filter).map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
      </select>
    </Field>
  )
  return (
    <div className="space-y-4">
      <div className="grid sm:grid-cols-2 gap-2">
        {oils.map(f => (
          <div key={f.id} className={cx('rounded-2xl border px-3 py-2 bg-white/70', status(f.id) === 'ex' ? 'border-danger/40' : 'border-sand/70')}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{f.name}</span>
              <div className="flex gap-1">
                <Chip active={status(f.id) === 'pref'} onClick={() => setStatus(f.id, status(f.id) === 'pref' ? '' : 'pref')}>Bevorzugt</Chip>
                <Chip active={status(f.id) === 'ex'} tone="danger" onClick={() => setStatus(f.id, status(f.id) === 'ex' ? '' : 'ex')}>Nein</Chip>
              </div>
            </div>
            <p className="text-xs text-muted mt-1">{f.oil!.coldOk && 'kalt ✓'} {f.oil!.warmOk ? '· warm ✓' : '· nicht erhitzen'} · {f.oil!.note} ({fmt(f.kcal)} kcal/100 g)</p>
          </div>
        ))}
      </div>
      <div className="grid sm:grid-cols-3 gap-3">
        {sel('main', 'Hauptöl', () => true, 'Wird bevorzugt verwendet, wenn geeignet.')}
        {sel('warm', 'Für warme Zubereitung', f => f.oil!.warmOk, 'Braten, Backen, Dünsten')}
        {sel('cold', 'Für kalte Zubereitung', f => f.oil!.coldOk, 'Salate, Dips, Dressings')}
      </div>
      <p className="text-xs text-muted">Öle und Fette werden bei allen Kalorien- und Nährwertberechnungen vollständig berücksichtigt (1 EL ≈ 10 g ≈ 88 kcal).</p>
    </div>
  )
}
