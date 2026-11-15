import { useRef, useState } from 'react'
import { useStore } from '../store'
import { parseJsonText } from '../domain/persistence'
import { Btn, Card, Notice, PageTitle } from '../ui/kit'
import { OilForm, ProfileForm, RestrictionForm, RulesForm, StyleForm } from './forms'
import { defaultState } from '../domain/defaults'

export function SettingsPage() {
  const { state, replace, reset, update, saveError } = useStore()
  const file = useRef<HTMLInputElement>(null)
  const [msg, setMsg] = useState<{ level: 'info' | 'error'; text: string } | null>(null)
  const exportData = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob); a.download = `ernaehrungsplan-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
    setMsg({ level: 'info', text: 'Export erstellt.' })
  }
  const importData = async (f: File) => {
    if (f.size > 20 * 1024 * 1024) return setMsg({ level: 'error', text: 'Datei ist zu groß (max. 20 MB).' })
    const r = parseJsonText(await f.text(), 'import')
    if (!r.ok) return setMsg({ level: 'error', text: `Import abgelehnt: ${r.error} Deine aktuellen Daten wurden nicht verändert.` })
    if (!confirm('Aktuelle Daten durch die Sicherung ersetzen?')) return
    replace(r.state); setMsg({ level: 'info', text: 'Sicherung importiert.' })
  }
  const wipe = () => {
    if (!confirm('Wirklich ALLE Daten (Profil, Lebensmittel, Rezepte, Plan, Gewichtsverlauf) unwiderruflich löschen?')) return
    const removed = reset(); setMsg({ level: 'info', text: `Alle Daten wurden gelöscht (${removed.length} Speichereinträge entfernt).` })
  }
  const restoreDb = () => {
    if (!confirm('Lebensmittel- und Rezeptdatenbank auf den Auslieferungszustand zurücksetzen? Eigene Einträge gehen verloren.')) return
    const d = defaultState()
    update(s => ({ ...s, foods: d.foods, recipes: d.recipes, plan: null }))
    setMsg({ level: 'info', text: 'Datenbank zurückgesetzt, Plan entfernt.' })
  }
  return (
    <div className="space-y-5">
      <PageTitle title="Einstellungen" sub="Profil, Ernährungsweise, Unverträglichkeiten, Öle und Daten" />
      {saveError && <Notice level="error">Speichern im Browser fehlgeschlagen (Speicher voll oder blockiert). Bitte exportiere deine Daten.</Notice>}
      <Card><h2 className="text-2xl mb-3">Persönliches Profil</h2><ProfileForm /></Card>
      <Card><h2 className="text-2xl mb-3">Ernährungsweise</h2><StyleForm /></Card>
      <Card><h2 className="text-2xl mb-3">Eigene Regeln</h2><RulesForm /></Card>
      <Card><h2 className="text-2xl mb-3">Allergien &amp; Unverträglichkeiten</h2><RestrictionForm /></Card>
      <Card><h2 className="text-2xl mb-3">Öle &amp; Fette</h2><OilForm /></Card>
      <Notice level="info">Änderungen gelten für neu erzeugte Pläne. Ein bestehender Plan wird auf Regelverstöße geprüft und bei Bedarf markiert – er wird nicht automatisch verändert. Zum Anwenden im Plan „Neu generieren“.</Notice>
      <Card>
        <h2 className="text-2xl mb-1">Daten &amp; Datenschutz</h2>
        <p className="text-sm text-muted mb-3">Alle Daten liegen ausschließlich lokal in diesem Browser. Es gibt keine Konten, kein Tracking und keine Übertragung an Dritte.</p>
        <div className="flex flex-wrap gap-2">
          <Btn variant="soft" onClick={exportData}>Daten exportieren (JSON)</Btn>
          <Btn variant="ghost" onClick={() => file.current?.click()}>Sicherung importieren</Btn>
          <Btn variant="ghost" onClick={restoreDb}>Datenbank zurücksetzen</Btn>
          <Btn variant="danger" onClick={wipe}>Alle Daten löschen</Btn>
        </div>
        <input ref={file} type="file" accept="application/json" hidden onChange={e => { const f = e.target.files?.[0]; if (f) importData(f); e.target.value = '' }} />
        {msg && <div className="mt-3"><Notice level={msg.level}>{msg.text}</Notice></div>}
      </Card>
      <Card className="text-sm text-muted">
        <h2 className="text-xl text-ink mb-1">Hinweise</h2>
        <p>Nährwerte der meisten Standard-Lebensmittel stammen aus dem Bundeslebensmittelschlüssel (BLS 4.0, Max Rubner-Institut, CC BY 4.0; DOI 10.25826/Data20251217-134202-0). Lebensmittel ohne BLS-Zuordnung sind als „Richtwert (nicht verifiziert)“ gekennzeichnet, eigene Angaben als „Eigene Angabe“. Kalorienziele sind grobe Schätzungen. Diese App ersetzt keine ärztliche oder ernährungsmedizinische Beratung; bei Allergien immer Produktetiketten prüfen.</p>
      </Card>
    </div>
  )
}
