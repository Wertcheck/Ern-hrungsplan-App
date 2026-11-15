import { useEffect, useState } from 'react'
import { useStore } from './store'
import { cx } from './ui/kit'
import { Onboarding } from './pages/Onboarding'
import { OverviewPage } from './pages/Overview'
import { FoodsPage } from './pages/Foods'
import { PlanPage } from './pages/Plan'
import { RecipesPage } from './pages/Recipes'
import { ShoppingPage } from './pages/Shopping'
import { ProgressPage } from './pages/Progress'
import { SettingsPage } from './pages/Settings'
import { useAi } from './ai/AiProvider'
import { ChatPanel } from './ai/ChatPanel'

const NAV: { id: string; label: string; icon: string }[] = [
  { id: 'uebersicht', label: 'Übersicht', icon: '🏠' },
  { id: 'lebensmittel', label: 'Meine Lebensmittel', icon: '🥕' },
  { id: 'plan', label: 'Ernährungsplan', icon: '🍴' },
  { id: 'rezepte', label: 'Rezepte', icon: '🍲' },
  { id: 'einkauf', label: 'Einkaufsliste', icon: '🛒' },
  { id: 'fortschritt', label: 'Fortschritt', icon: '📈' },
  { id: 'einstellungen', label: 'Einstellungen', icon: '⚙️' },
]
const MOBILE = ['uebersicht', 'plan', 'rezepte', 'einkauf', 'mehr']
const SHORT: Record<string, string> = { uebersicht: 'Übersicht', plan: 'Plan', rezepte: 'Rezepte', einkauf: 'Einkauf', mehr: 'Mehr' }

const readHash = () => (location.hash.replace('#/', '') || 'uebersicht')

export default function App() {
  const { state, warnings, dismissWarnings } = useStore()
  const ai = useAi()
  const [page, setPage] = useState(readHash())
  useEffect(() => { const h = () => { setPage(readHash()); window.scrollTo(0, 0) }; window.addEventListener('hashchange', h); return () => window.removeEventListener('hashchange', h) }, [])
  const go = (p: string) => { location.hash = `#/${p}` }
  if (!state.onboarded) return <Onboarding onDone={() => go('plan')} />
  const more = ['lebensmittel', 'fortschritt', 'einstellungen']
  const isMore = more.includes(page) || page === 'mehr'
  const body = {
    uebersicht: <OverviewPage go={go} />, lebensmittel: <FoodsPage />, plan: <PlanPage />, rezepte: <RecipesPage />,
    einkauf: <ShoppingPage />, fortschritt: <ProgressPage />, einstellungen: <SettingsPage />,
    mehr: (
      <div className="space-y-2"><h1 className="text-3xl text-forest-dark mb-3">Mehr</h1>
        {NAV.filter(n => more.includes(n.id)).map(n => <button key={n.id} onClick={() => go(n.id)} className="w-full text-left rounded-3xl bg-paper border border-sand px-5 py-4 text-lg">{n.icon} {n.label}</button>)}
      </div>
    ),
  }[page] ?? <OverviewPage go={go} />
  return (
    <div className="min-h-screen lg:flex">
      <aside className="hidden lg:flex flex-col w-64 shrink-0 p-5 gap-1 sticky top-0 h-screen border-r border-sand/70 bg-paper/60">
        <div className="flex items-center gap-2 mb-6"><span className="h-10 w-10 rounded-xl bg-forest grid place-items-center text-xl" aria-hidden>🌿</span><span className="font-serif text-xl text-forest-dark">Ernährungsplan</span></div>
        {NAV.map(n => (
          <button key={n.id} onClick={() => go(n.id)} aria-current={page === n.id ? 'page' : undefined}
            className={cx('text-left rounded-2xl px-4 py-2.5 transition', page === n.id ? 'bg-forest text-white' : 'hover:bg-moss/60')}>{n.icon} {n.label}</button>
        ))}
      </aside>
      <main className="flex-1 min-w-0 overflow-x-clip px-4 sm:px-8 pt-6 pb-28 lg:pb-10 max-w-5xl mx-auto w-full">
        {warnings.length > 0 && (
          <div role="alert" className="mb-4 rounded-2xl border border-warn/40 bg-[#fbeedd] text-warn px-4 py-3 text-sm flex gap-3 justify-between">
            <div>{warnings.map(w => <p key={w}>{w}</p>)}</div>
            <button className="underline shrink-0" onClick={dismissWarnings}>OK</button>
          </div>
        )}
        {body}
      </main>
      {ai.open && (
        <aside aria-label="Berater" className="fixed inset-0 z-50 lg:z-auto lg:sticky lg:inset-auto lg:top-0 lg:h-screen lg:w-[400px] lg:shrink-0 border-l border-sand/70 bg-cream"><ChatPanel /></aside>
      )}
      {!ai.open && (
        <button onClick={() => ai.setOpen(true)} aria-label="Ernährungsberater öffnen"
          className="fixed z-40 right-4 bottom-20 lg:bottom-6 h-14 w-14 rounded-full bg-forest text-white shadow-lg text-2xl grid place-items-center hover:bg-forest-dark">💬</button>
      )}
      <nav aria-label="Hauptnavigation" className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-paper/95 backdrop-blur border-t border-sand safe-b">
        <ul className="grid grid-cols-5">
          {MOBILE.map(id => {
            const n = NAV.find(x => x.id === id)
            const active = id === 'mehr' ? isMore : page === id
            return (
              <li key={id}><button onClick={() => go(id)} aria-current={active ? 'page' : undefined} className={cx('w-full py-2 flex flex-col items-center text-[11px] min-h-14', active ? 'text-forest font-semibold' : 'text-muted')}>
                <span className="text-xl" aria-hidden>{n?.icon ?? '☰'}</span>{SHORT[id]}</button></li>
            )
          })}
        </ul>
      </nav>
    </div>
  )
}
