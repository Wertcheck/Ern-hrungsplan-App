import { useState } from 'react'
import { Btn, Card } from '../ui/kit'
import { OilForm, ProfileForm, RestrictionForm, StyleForm, profileErrors } from './forms'
import { useStore } from '../store'

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0)
  const { state, update } = useStore()
  const steps = ['Profil', 'Ernährung', 'Öle']
  const valid = Object.keys(profileErrors(state.profile)).length === 0
  const finish = () => { update(s => ({ ...s, onboarded: true })); onDone() }
  return (
    <div className="min-h-screen max-w-2xl mx-auto px-4 py-8 safe-b">
      <div className="text-center mb-6 rise">
        <div className="mx-auto h-14 w-14 rounded-2xl bg-forest grid place-items-center text-3xl mb-3" aria-hidden>🌿</div>
        <h1 className="text-4xl font-semibold text-forest-dark">Willkommen</h1>
        <p className="text-muted mt-1">Dein persönlicher Plan für eine ausgewogene Ernährung</p>
      </div>
      <ol className="flex items-center justify-center gap-3 mb-6 text-sm" aria-label="Fortschritt">
        {steps.map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            <span className={`h-7 w-7 rounded-full grid place-items-center text-xs font-semibold ${i <= step ? 'bg-forest text-white' : 'border border-sand text-muted'}`}>{i + 1}</span>
            <span className={i === step ? 'font-medium' : 'text-muted'}>{s}</span>{i < steps.length - 1 && <span className="w-6 h-px bg-sand" />}
          </li>
        ))}
      </ol>
      <Card className="rise">
        {step === 0 && <><h2 className="text-2xl mb-3">Dein Ernährungsprofil</h2><ProfileForm /></>}
        {step === 1 && <><h2 className="text-2xl mb-3">Ernährungsweise</h2><StyleForm /><h2 className="text-2xl mt-6 mb-3">Allergien &amp; Unverträglichkeiten</h2><RestrictionForm /></>}
        {step === 2 && <><h2 className="text-2xl mb-3">Öle &amp; Fette</h2><OilForm /></>}
      </Card>
      <div className="flex justify-between mt-5">
        <Btn variant="ghost" disabled={step === 0} onClick={() => setStep(step - 1)}>Zurück</Btn>
        {step < 2 ? <Btn disabled={step === 0 && !valid} onClick={() => setStep(step + 1)}>Weiter →</Btn> : <Btn onClick={finish}>Fertig – Plan erstellen →</Btn>}
      </div>
      <p className="text-center text-xs text-muted mt-6">Alle Daten bleiben lokal auf diesem Gerät. Die App ersetzt keine ärztliche oder ernährungsmedizinische Beratung.</p>
    </div>
  )
}
