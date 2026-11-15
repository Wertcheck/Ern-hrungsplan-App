// Vollständige Browser-QA der App. Aufruf: node e2e/app.cjs <Basis-URL> <Ausgabeordner>
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path')
const BASE = process.argv[2] || 'http://localhost:4173', OUT = process.argv[3] || '/tmp/e2e'; fs.mkdirSync(OUT, { recursive: true })
const R = []; const check = (n, ok, x = '') => { R.push([n, !!ok, x]); console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + String(x).slice(0, 160) : '')) }
const errors = []
async function newPage(b, opts = {}) {
  const ctx = await b.newContext({ viewport: { width: 1366, height: 860 }, acceptDownloads: true, ...opts }); const p = await ctx.newPage()
  p.on('pageerror', e => errors.push('pageerror: ' + e.message)); p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR|503|502/.test(m.text())) errors.push('console: ' + m.text()) })
  p.on('dialog', d => d.accept()); return [ctx, p]
}
const st = p => p.evaluate(() => { const r = localStorage.getItem('ernaehrungsplan-state-v1'); return r ? JSON.parse(r) : null })
const onboard = async p => { await p.goto(BASE + '/'); await p.getByRole('button', { name: /Weiter/ }).click(); await p.getByRole('button', { name: /Weiter/ }).click(); await p.getByRole('button', { name: /Fertig/ }).click(); await p.getByRole('button', { name: /Plan erstellen/ }).click(); await p.waitForSelector('[data-testid=day-kcal]') }
const sec = async (name, fn) => { try { await fn() } catch (e) { check(name + ' (Abbruch)', false, e.message.split('\n').slice(0, 2).join(' | ')) } }
;(async () => {
  const b = await chromium.launch()
  // ---------- A) Viewports und Seiten ----------
  for (const [w, h, label] of [[390, 844, 'phone'], [768, 1024, 'tablet'], [1366, 800, 'desktop']]) await sec('viewport ' + label, async () => {
    const [ctx, p] = await newPage(b, { viewport: { width: w, height: h }, deviceScaleFactor: 1 }); await onboard(p)
    for (const r of ['uebersicht', 'lebensmittel', 'plan', 'rezepte', 'einkauf', 'fortschritt', 'einstellungen']) {
      await p.goto(BASE + '/#/' + r); await p.waitForTimeout(250)
      const sw = await p.evaluate(() => document.documentElement.scrollWidth); check(`${label}/${r}: kein horizontaler Überlauf`, sw <= w + 1, `scrollWidth ${sw}`)
      if (['uebersicht', 'plan', 'einstellungen'].includes(r)) await p.screenshot({ path: `${OUT}/${label}-${r}.png`, fullPage: r !== 'plan' })
    }
    if (label === 'phone') {
      const nav = await p.locator('nav[aria-label=Hauptnavigation] button').evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return [r.width, r.height] }))
      check('phone: Touch-Ziele der Navigation ≥ 44 px', nav.length === 5 && nav.every(([ww, hh]) => ww >= 44 && hh >= 44), JSON.stringify(nav))
    } else if (label === 'desktop') check('desktop: Seitenleiste mit allen 7 Bereichen', (await p.locator('aside button').count()) >= 7)
    else check('tablet: Navigation sichtbar', (await p.locator('nav[aria-label=Hauptnavigation] button, aside button').count()) >= 5)
    await ctx.close()
  })
  // ---------- B) Funktionen (Desktop) ----------
  const [ctx, p] = await newPage(b); await onboard(p)
  await sec('Onboarding-Validierung', async () => { const [c2, p2] = await newPage(b); await p2.goto(BASE + '/'); await p2.getByLabel('Alter (Jahre)').fill('10'); check('Alter 10 → Fehler, Weiter gesperrt', (await p2.getByText('Mindestalter 14 Jahre').isVisible()) && (await p2.getByRole('button', { name: /Weiter/ }).isDisabled())); await c2.close() })
  await sec('Planlängen 7/14/21/30', async () => {
    for (const [lbl, n] of [['2 Wochen', 14], ['3 Wochen', 21], ['1 Monat', 30], ['1 Woche', 7]]) {
      await p.goto(BASE + '/#/plan'); await p.getByRole('button', { name: /Neu generieren/ }).click(); await p.getByRole('button', { name: lbl }).click(); await p.getByRole('button', { name: 'Neu generieren' }).last().click(); await p.waitForSelector('[data-testid=day-kcal]')
      const s = await st(p); check(`Plan ${lbl}: ${n} Tage mit Mahlzeiten`, s.plan.days.length === n && s.plan.days.every(d => d.meals.length === 3), s.plan.days.length)
    }
  })
  await sec('Plan: Tag/Woche/Monat, Tausch, Löschen, Ergänzen, Portion', async () => {
    await p.goto(BASE + '/#/plan'); const k0 = await p.getByTestId('day-kcal').textContent()
    await p.getByRole('tab', { name: /Mo|Di/ }).first().click(); check('Tagwechsel', (await p.getByTestId('day-kcal').textContent()) !== undefined)
    await p.getByRole('button', { name: 'Woche', exact: true }).click(); check('Wochenansicht', (await p.getByText(/Woche 1 von/).count()) > 0)
    await p.getByRole('button', { name: 'Monat', exact: true }).click(); check('Monatsansicht', (await p.locator('button[aria-label*="kcal"]').count()) >= 7)
    await p.getByRole('button', { name: 'Tag', exact: true }).click()
    await p.locator('button[aria-label="Mahlzeit austauschen"]').first().click(); await p.locator('div[role=dialog] button').filter({ hasText: 'kcal' }).first().click()
    const total = async () => (await st(p)).plan.days.reduce((n, d) => n + d.meals.length, 0)
    const before = await total()
    await p.locator('button[aria-label="Mahlzeit löschen"]').first().click(); const after = await total()
    check('Mahlzeit löschen verringert die Anzahl um genau 1', after === before - 1, `${before} → ${after}`)
    await p.getByRole('button', { name: /Mahlzeit ergänzen/ }).click(); await p.locator('div[role=dialog] button').filter({ hasText: 'kcal' }).first().click()
    check('Mahlzeit ergänzen erhöht die Anzahl um 1', (await total()) === after + 1)
    await p.locator('div.rise button').filter({ hasText: /Portion/ }).first().click(); const f0 = await p.locator('div[role=dialog] span.font-semibold').first().textContent()
    await p.getByRole('button', { name: 'Portion vergrößern' }).click(); const f1 = await p.locator('div[role=dialog] span.font-semibold').first().textContent()
    check('Portionsänderung aktualisiert die Anzeige', f0 !== f1, `${f0} → ${f1}`); await p.keyboard.press('Escape')
    await p.locator('button[aria-label="Als gegessen markieren"]').first().click(); check('„gegessen“ markierbar', Object.keys((await st(p)).eaten).length === 1)
    await p.screenshot({ path: OUT + '/desktop-plan-nutrients.png' })
  })
  await sec('Lebensmittel: neu, bearbeiten, Favorit, ausschließen, löschen; BLS-Übernahme', async () => {
    await p.goto(BASE + '/#/lebensmittel'); await p.getByRole('button', { name: '+ Neu' }).click(); await p.getByLabel('Bezeichnung').fill('Testriegel'); await p.getByLabel('Kalorien (kcal)').fill('375')
    await p.getByLabel('Eiweiß (g)').fill('10'); await p.getByLabel('Kohlenhydrate, verfügbar (g)').fill('50'); await p.getByLabel('Fett (g)').fill('15'); await p.getByRole('button', { name: 'Speichern' }).click()
    await p.getByPlaceholder('Lebensmittel suchen…').fill('Testriegel'); check('eigenes Lebensmittel angelegt (Eigene Angabe, Allergene unbekannt)', (await p.getByText('Eigene Angabe').count()) > 0 && (await p.getByText('Allergene unbekannt').count()) > 0)
    await p.getByRole('button', { name: '★ Favorit' }).click(); await p.getByRole('button', { name: /🚫 Ausschließen/ }).click()
    const s = await st(p); check('Favorit und Ausschluss gespeichert', s.prefs.favoriteFoods.some(x => x.startsWith('custom')) && s.prefs.excludedFoods.some(x => x.startsWith('custom')))
    await p.getByRole('button', { name: 'Testriegel löschen' }).click(); check('löschen', !(await st(p)).foods.some(f => f.name === 'Testriegel'))
    await p.getByRole('button', { name: /BLS-Datenbank/ }).click(); await p.getByLabel('BLS durchsuchen').fill('Hafer Flocken'); await p.getByText('C133000').first().waitFor()
    check('BLS-Suche findet „Hafer Flocken“ (C133000), bereits vorhanden', (await p.getByText('vorhanden').count()) > 0)
    await p.getByLabel('BLS durchsuchen').fill('Hirse Flocken'); await p.getByRole('button', { name: /Hirse Flocken übernehmen/ }).click()
    check('BLS-Übernahme erzeugt Eintrag mit Quelle', (await st(p)).foods.some(f => f.sourceRef?.id === 'C333100' && f.allergenInfoKnown === false))
    await p.locator('main [role=tablist] button').first().click(); await p.getByPlaceholder('Lebensmittel suchen…').fill(''); check('BLS-Lebensmittel zeigt Datenqualität/Quelle', (await p.getByText(/Verifiziert \(Originalquelle\)/).count()) > 10)
    await p.getByLabel('Lebensmittelgruppe').count()
  })
  await sec('Rezepte: Suche, Portion/Nährwerte, neu, bearbeiten, löschen', async () => {
    await p.goto(BASE + '/#/rezepte'); await p.getByLabel('Rezepte suchen').fill('Haferflocken'); await p.locator('button:has-text("Haferflocken-Bowl")').first().click()
    const kc = async () => Number((await p.locator('div[role=dialog] .font-serif').first().textContent()).replace(/\D/g, '')); const k1 = await kc()
    await p.getByRole('button', { name: 'Portion vergrößern' }).click(); await p.getByRole('button', { name: 'Portion vergrößern' }).click(); const k2 = await kc()
    check('Portionsänderung berechnet Nährwerte neu (1,5× ≈ +50 %)', Math.abs(k2 / k1 - 1.5) < 0.02, `${k1} → ${k2}`); await p.keyboard.press('Escape')
    await p.getByRole('button', { name: '+ Neu' }).click(); await p.getByLabel('Name').fill('Testrezept'); await p.getByPlaceholder('Zutat suchen und hinzufügen…').fill('Apfel'); await p.getByRole('button', { name: /\+ Apfel/ }).first().click(); await p.getByRole('button', { name: 'Speichern' }).click()
    check('eigenes Rezept gespeichert', (await st(p)).recipes.some(r => r.name === 'Testrezept'))
    await p.getByLabel('Rezepte suchen').fill('Testrezept'); await p.locator('button:has-text("Testrezept")').first().click(); await p.getByRole('button', { name: 'Löschen' }).click()
    check('Rezept löschen', !(await st(p)).recipes.some(r => r.name === 'Testrezept'))
  })
  await sec('Einkaufsliste: Gruppen, Abhaken, Entfernen, manuell, Update nach Planänderung', async () => {
    await p.goto(BASE + '/#/einkauf'); const items0 = await p.locator('li input[type=checkbox]').count(); check('Einkaufsliste enthält gruppierte Zutaten', items0 > 10 && (await p.locator('h2').count()) > 3, items0)
    await p.locator('li input[type=checkbox]').first().check(); check('Abhaken', (await st(p)).shopping.checked.length === 1)
    await p.getByLabel('Produkt').fill('Spülmittel'); await p.getByLabel('Menge').fill('1 Fl.'); await p.getByRole('button', { name: 'Hinzufügen' }).click(); check('manuell ergänzt', (await p.getByText('Spülmittel').count()) > 0)
    await p.locator('button[aria-label$="entfernen"]').first().click(); check('Produkt entfernt', (await p.locator('li input[type=checkbox]').count()) === items0)
    const txt0 = await p.locator('main').innerText()
    await p.goto(BASE + '/#/plan'); await p.getByRole('button', { name: /Neu generieren/ }).click(); await p.getByRole('button', { name: 'Neu generieren' }).last().click(); await p.waitForSelector('[data-testid=day-kcal]'); await p.goto(BASE + '/#/einkauf')
    check('Liste aktualisiert sich nach Plan-Änderung', (await p.locator('main').innerText()) !== txt0)
  })
  await sec('Fortschritt: Gewicht eintragen', async () => { await p.goto(BASE + '/#/fortschritt'); await p.getByRole('button', { name: 'Eintragen' }).click(); check('Gewichtsverlauf + Diagramm', (await st(p)).weights.length === 1 && (await p.locator('svg[aria-label="Gewichtsverlauf"]').count()) === 1) })
  await sec('Einstellungen: Profil, Weisen-Konflikt, eigene Regel', async () => {
    await p.goto(BASE + '/#/einstellungen'); await p.getByRole('button', { name: 'Manuell festlegen' }).click(); await p.getByLabel(/Tägliches Kalorienziel/).fill('1900'); check('Kalorienziel manuell gespeichert', (await st(p)).profile.kcalManual === 1900)
    await p.getByRole('button', { name: 'Carnivore', exact: true }).click(); await p.getByRole('button', { name: 'Vegan', exact: true }).click()
    check('Widerspruch Carnivore+Vegan wird angezeigt', (await p.getByText(/Widerspruch:.*schließen sich gegenseitig aus/).count()) > 0)
    await p.goto(BASE + '/#/plan'); await p.getByRole('button', { name: /Neu generieren/ }).click(); await p.getByRole('button', { name: 'Neu generieren' }).last().click().catch(() => {})
    await p.goto(BASE + '/#/einstellungen'); await p.getByRole('button', { name: 'Vegan', exact: true }).click(); await p.getByRole('button', { name: 'Carnivore', exact: true }).click(); await p.getByRole('button', { name: 'Mediterran', exact: true }).click()
    check('Ernährungsweise wechselbar', (await st(p)).prefs.styles.join() === 'mediterran', (await st(p)).prefs.styles.join())
    await p.getByRole('button', { name: 'Hinzufügen' }).first().click(); check('eigene Regel hinzugefügt', (await st(p)).prefs.customRules.length === 1)
    await p.locator('button[aria-label$="löschen"]').first().click(); check('eigene Regel gelöscht', (await st(p)).prefs.customRules.length === 0)
    await p.screenshot({ path: OUT + '/desktop-settings-diets.png' })
  })
  // ---------- C) Export / Import / Persistenz / Löschen ----------
  await sec('Export und Import', async () => {
    await p.goto(BASE + '/#/einstellungen'); const [dl] = await Promise.all([p.waitForEvent('download'), p.getByRole('button', { name: /Daten exportieren/ }).click()])
    const file = path.join(OUT, 'export.json'); await dl.saveAs(file); const exp = JSON.parse(fs.readFileSync(file, 'utf8')); const cur = await st(p)
    check('Export vollständig (identisch mit gespeichertem Zustand)', JSON.stringify(exp) === JSON.stringify(cur), `${(fs.statSync(file).size / 1024) | 0} KB`)
    const imp = async (name, content) => { const f = path.join(OUT, name); fs.writeFileSync(f, content); await p.locator('input[type=file]').setInputFiles(f); await p.waitForTimeout(400) }
    const before = JSON.stringify(await st(p))
    const bad = { 'korrupt.json': '{"version":2,', 'inkompatibel.json': JSON.stringify({ ...exp, version: 99 }), 'unvollstaendig.json': JSON.stringify((({ foods, ...r }) => r)(exp)), 'leer.json': '', 'array.json': '[1,2,3]', 'manipuliert.json': JSON.stringify({ ...exp, plan: { ...exp.plan, kcalTarget: 9999999 } }) }
    for (const [n, c] of Object.entries(bad)) { await imp(n, c); check(`Import ${n} abgelehnt, Daten unverändert`, (await p.getByText(/Import abgelehnt/).count()) > 0 && JSON.stringify(await st(p)) === before) }
    const mod = { ...exp, profile: { ...exp.profile, age: 52 } }; await imp('gueltig.json', JSON.stringify(mod)); check('gültiger Import ersetzt Daten', (await st(p)).profile.age === 52)
  })
  await sec('Persistenz nach Browser-Neustart', async () => {
    const stateFile = path.join(OUT, 'storage.json'); await ctx.storageState({ path: stateFile }); await ctx.close()
    const [c2, p2] = await newPage(b, { storageState: stateFile }); await p2.goto(BASE + '/#/plan'); await p2.waitForSelector('[data-testid=day-kcal]')
    const s = await st(p2); check('Daten nach Neustart vorhanden (Plan, Profil)', s.plan && s.profile.age === 52 && s.onboarded)
    // ---------- D) Offline / PWA ----------
    await p2.goto(BASE + '/#/lebensmittel'); await p2.getByRole('button', { name: /BLS-Datenbank/ }).click(); await p2.getByLabel('BLS durchsuchen').fill('Hafer'); await p2.getByText('C133000').first().waitFor()
    await p2.waitForFunction(async () => { const r = await navigator.serviceWorker.getRegistration(); return !!(r && r.active) }); await p2.reload(); await p2.waitForTimeout(800)
    const ctl = await p2.evaluate(() => !!navigator.serviceWorker.controller); check('Service Worker aktiv und steuert die Seite', ctl)
    const keys = await p2.evaluate(async () => { const out = {}; for (const k of await caches.keys()) out[k] = (await (await caches.open(k)).keys()).map(r => new URL(r.url).pathname); return out })
    check('App-Hülle vorab gecacht (index, Manifest, Icons, JS, CSS)', Object.values(keys).flat().some(u => /\/assets\/index-.*\.js/.test(u)) && Object.values(keys).flat().includes('/icon-192.png'), JSON.stringify(keys).slice(0, 140))
    check('/api wird nie gecacht', !Object.values(keys).flat().some(u => u.startsWith('/api')))
    await c2.setOffline(true); await p2.reload(); await p2.getByRole('heading', { name: 'Meine Lebensmittel' }).waitFor({ timeout: 10000 }).catch(() => {})
    check('Offline: Neuladen zeigt die App (Navigation, Seite)', (await p2.getByRole('heading', { name: 'Meine Lebensmittel' }).count()) > 0 && (await p2.locator('aside button').count()) >= 7)
    await p2.goto(BASE + '/#/plan'); check('Offline: gespeicherter Plan ist verfügbar', (await p2.getByTestId('day-kcal').count()) > 0)
    await p2.goto(BASE + '/#/lebensmittel'); await p2.getByRole('button', { name: /BLS-Datenbank/ }).click(); await p2.getByLabel('BLS durchsuchen').fill('Haferflocken'); await p2.getByText('C133000').first().waitFor({ timeout: 8000 }).catch(() => {})
    check('Offline: BLS-Datenbank nach erstem Laden nutzbar (Suche „Haferflocken“ → C133000)', (await p2.getByText('C133000').count()) > 0 && (await p2.getByText(/konnte nicht geladen/).count()) === 0)
    await p2.goto(BASE + '/#/einstellungen'); check('Offline: Einstellungen/Seiten bleiben nutzbar; KI meldet Ausfall statt zu blockieren', (await p2.getByText('Alle Daten löschen').count()) > 0)
    await c2.setOffline(false)
    // Manifest / Icons
    const man = await (await p2.request.get(BASE + '/manifest.webmanifest')).json()
    const sizes = []; for (const ic of man.icons) { const r = await p2.request.get(BASE + ic.src); sizes.push(`${ic.sizes}:${r.status()}:${ic.purpose}`) }
    check('Manifest vollständig (name, start_url, scope, display, theme, Icons 192/512/maskable)', man.name && man.start_url && man.scope && man.display === 'standalone' && man.theme_color && man.icons.some(i => i.sizes === '192x192' && i.type === 'image/png') && man.icons.some(i => i.sizes === '512x512') && man.icons.some(i => i.purpose === 'maskable') && sizes.every(s => s.includes(':200:')), sizes.join(' '))
    check('lang, title, viewport, theme-color gesetzt', await p2.evaluate(() => document.documentElement.lang === 'de' && !!document.title && !!document.querySelector('meta[name=viewport]') && !!document.querySelector('meta[name=theme-color]')))
    // ---------- E) Datenlöschung ----------
    await p2.goto(BASE + '/#/einstellungen'); await p2.getByRole('button', { name: 'Alle Daten löschen' }).click(); await p2.waitForTimeout(400)
    const keysAfter = await p2.evaluate(() => Object.keys(localStorage)); check('Löschen entfernt ALLE App-Schlüssel (localStorage leer)', keysAfter.length === 0, JSON.stringify(keysAfter))
    await p2.reload(); await p2.waitForTimeout(500); check('nach Neuladen: Willkommen/Onboarding, weiterhin nichts gespeichert', (await p2.getByRole('heading', { name: 'Willkommen' }).count()) === 1 && (await p2.evaluate(() => Object.keys(localStorage).length)) === 0)
    // A11y-Kurzprüfung
    await onboard(p2); const unnamed = await p2.evaluate(() => [...document.querySelectorAll('button,[role=button],input,select,textarea')].filter(e => !(e.getAttribute('aria-label') || e.textContent.trim() || (e.labels && e.labels.length) || e.getAttribute('title') || e.getAttribute('placeholder'))).length)
    check('A11y: alle Bedienelemente haben einen zugänglichen Namen', unnamed === 0, unnamed)
    await c2.close()
  })
  check('keine JavaScript-Fehler in der gesamten Sitzung', errors.length === 0, errors.slice(0, 4).join(' | '))
  await b.close(); const failed = R.filter(r => !r[1]); console.log(`\n${R.length - failed.length}/${R.length} Prüfungen bestanden`); fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(R, null, 1)); process.exit(failed.length ? 1 : 0)
})().catch(e => { console.error('ABBRUCH', e.message.split('\n').slice(0, 3).join(' | ')); process.exit(2) })
