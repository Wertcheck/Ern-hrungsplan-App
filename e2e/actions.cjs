// Browser-Test der Regel-Aktionen (Tier 0): „Ich möchte heute 4.000 kcal essen“ inkl. Rückfrage, Vorschau, Bestätigung, Undo.
// Aufruf: node e2e/actions.cjs <Basis-URL> <Screenshot-Ordner>   (kein Backend nötig, keine KI)
const { chromium } = require('playwright')
const BASE = process.argv[2] || 'http://localhost:4173', OUT = process.argv[3] || '/tmp'
const results = []; const check = (n, ok, x = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')) }
;(async () => {
  const b = await chromium.launch(); const errors = []
  const ctx = await b.newContext({ viewport: { width: 1366, height: 860 } }); const p = await ctx.newPage()
  p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR|502|503/.test(m.text())) errors.push(m.text()) })
  p.on('dialog', d => d.accept())
  const state = () => p.evaluate(() => JSON.parse(localStorage.getItem('ernaehrungsplan-state-v1')))
  const today = await p.evaluate(() => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10) })
  await p.goto(BASE + '/')
  await p.getByRole('button', { name: /Weiter/ }).click(); await p.getByRole('button', { name: /Weiter/ }).click(); await p.getByRole('button', { name: /Fertig/ }).click()
  await p.getByRole('button', { name: /Plan erstellen/ }).click(); await p.waitForSelector('[data-testid=day-kcal]')
  const s0 = await state(); const profileTarget0 = JSON.stringify(s0.profile), planTarget0 = s0.plan.kcalTarget
  const dayKcal0 = await p.getByTestId('day-kcal').textContent()
  await p.getByRole('button', { name: 'Ernährungsberater öffnen' }).click(); await p.getByRole('heading', { name: 'Ernährungsberater' }).waitFor()
  const box = p.getByRole('textbox', { name: 'Nachricht an den Berater' }), send = () => p.getByRole('button', { name: 'Senden' }).click()
  // 1) Beispielsatz: einmaliges Tagesziel, Bestätigung nötig (Klasse B), Plan vorher unverändert
  await box.fill('Ich möchte heute 4.000 kcal essen.'); await send()
  await p.getByText('Bitte prüfen und bestätigen').waitFor()
  check('Vorschau zeigt „einmalig“ und unverändertes dauerhaftes Ziel', await p.getByText(/Tagesziel für heute \(einmalig\)/).first().isVisible() && await p.getByText(/bleibt unverändert/).first().isVisible())
  check('Vorschau enthält Tagessumme und Abweichungswarnung', await p.getByText(/Tagessumme geplant/).first().isVisible() && await p.getByText(/Auffällige Abweichung/).first().isVisible())
  check('vor Bestätigung nichts geändert', (await state()).plan.days.find(d => d.date === today)?.meals.length === s0.plan.days.find(d => d.date === today)?.meals.length && !(await state()).plan.dayTargets)
  await p.screenshot({ path: OUT + '/act-01-preview.png' })
  await p.getByRole('button', { name: 'Bestätigen' }).first().click()
  await p.getByText(/Übernommen/).first().waitFor()
  const s1 = await state()
  check('Tagesziel heute = 4000 gespeichert', s1.plan.dayTargets?.[today] === 4000)
  check('Profil und dauerhaftes Plan-Ziel unverändert', JSON.stringify(s1.profile) === profileTarget0 && s1.plan.kcalTarget === planTarget0)
  const dayKcal = s1.plan.days.find(d => d.date === today).meals.length
  check('Änderungsprotokoll hat 1 Eintrag, Rückgängig-Knopf sichtbar', s1.changeLog.length === 1 && await p.getByTestId('undo-btn').isVisible())
  // 2) Plan-Seite zeigt einmaliges Ziel
  await p.getByRole('button', { name: 'Berater schließen' }).click().catch(() => {})
  await p.goto(BASE + '/#/plan'); await p.waitForSelector('[data-testid=day-kcal]')
  check('Plan-Seite zeigt „Tagesziel (einmalig)“', await p.getByText(/Tagesziel \(einmalig\)/).first().isVisible())
  await p.screenshot({ path: OUT + '/act-02-plan.png' })
  void dayKcal; void dayKcal0
  // 3) Undo über Knopf
  const fab = p.getByRole('button', { name: 'Ernährungsberater öffnen' }); if (await fab.isVisible()) await fab.click()
  await p.getByTestId('undo-btn').click()
  const s2 = await state()
  check('Undo stellt Plan ohne Tagesziel wieder her', !s2.plan.dayTargets?.[today] && JSON.stringify(s2.plan.days) === JSON.stringify(s0.plan.days))
  // 4) Rückfrage bei fehlender Zeitangabe
  await box.fill('Ich möchte 3000 kcal essen'); await send()
  await p.getByText(/nur heute oder dauerhaft/).waitFor()
  check('Rückfrage mit Chips „Nur heute“ / „Dauerhaft“', await p.getByText('Nur heute').first().isVisible() && await p.getByText('Dauerhaft').first().isVisible())
  check('ohne Antwort nichts geändert', (await state()).plan.kcalTarget === planTarget0 && !(await state()).plan.dayTargets)
  // 5) Klasse C: Allergie
  await box.fill('Lösche meine Nussallergie'); await send()
  await p.getByText(/nicht ändern/).first().waitFor()
  check('Allergie-Änderung per Chat verweigert, Profil unverändert', JSON.stringify((await state()).profile.allergies) === JSON.stringify(s0.profile.allergies))
  // 6) Klasse A direkt: Einkaufsliste + Undo per Sprache
  await box.fill('Setze Milch auf die Einkaufsliste'); await send()
  await p.getByText(/Erledigt/).first().waitFor()
  const sh = await state(); check('Klasse A wird direkt ausgeführt (Einkaufsliste)', JSON.stringify(sh.shopping).includes('Milch'))
  await box.fill('Mach das rückgängig'); await send()
  await p.getByText(/Rückgängig gemacht/).first().waitFor()
  check('„Mach das rückgängig“ nimmt die Änderung zurück', !JSON.stringify((await state()).shopping).includes('Milch'))
  // 7) Mehrfachaktion
  await box.fill('Ändere mein Proteinziel auf 180 Gramm und erhöhe die Kalorien heute auf 3.500.'); await send()
  await p.getByText('Bitte prüfen und bestätigen').last().waitFor()
  await p.screenshot({ path: OUT + '/act-03-multi.png' })
  await p.getByRole('button', { name: 'Bestätigen' }).last().click()
  await p.getByText(/Übernommen/).last().waitFor()
  const s3 = await state(); check('Mehrfachaktion: Makroziel + Tagesziel gesetzt', s3.profile.macroGoals?.proteinG === 180 && s3.plan.dayTargets?.[today] === 3500, JSON.stringify(s3.profile.macroGoals))
  check('keine Konsolenfehler', errors.length === 0, errors.join(' | ').slice(0, 200))
  await b.close(); process.exit(results.every(Boolean) ? 0 : 1)
})().catch(e => { console.error(e); process.exit(2) })
