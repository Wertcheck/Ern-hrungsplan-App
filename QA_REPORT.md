# QA-Bericht

Alle Zahlen stammen aus Läufen am 2026-11-15 (Chromium via Playwright, Node 22, Python 3.13). Reihenfolge der Belastbarkeit: automatisiert getestet → im Browser geprüft. **Keine unabhängige Prüfung, kein echtes Android-Gerät, keine echten KI-Anbieter.**

## Automatisierte Tests (alle grün)
| Suite | Befehl | Ergebnis |
|---|---|---|
| Frontend/Engine (Vitest) | `npm test` | **165/165** (domain 50 · diets 38 · bls 19 · ai 35 · persistence 14 · nutrients 9) |
| Backend (pytest) | `npm run backend:test` | **140/140** (Provider 18 · Kontext/Aktionen 13 · API 44 · env-check 10 + weitere parametrisierte) |
| BLS-Importer (pytest) | `npm run bls:test` | **10/10** |
| Typecheck / Build | `npm run typecheck` / `npm run build` | fehlerfrei; Hauptbündel 169 KB gzip, BLS-Chunk 396 KB gzip (lazy) |

Abgedeckt (Auszug): Kalorien-/Makro-/Rezeptberechnung (inkl. im Original geprüfter BLS-Werte), Portionsskalierung, Allergien/Unverträglichkeiten/Spuren/unbekannte Zutaten, vegan/vegetarisch/Carnivore-Regeln, **alle 12 Ernährungsweisen × 3/5 Mahlzeiten** (Regeln *unabhängig* an den Zutaten nachgeprüft), Kombinationen/Widersprüche, eigene Regeln, Registry-Erweiterung, Planlängen 7/14/21/30, Kalorien 1.200–3.000, Portionsplausibilität, Determinismus, Einkaufsliste, Plan-Änderungen, Nährstoffbilanz („Datenlage unzureichend“), Persistenz (Roundtrip, Migration v1→v2, beschädigte/unvollständige/inkompatible/manipulierte Importe, Löschen), BLS (Integrität, Suche, Umwandlung, Sicherheit), KI (SSE-Zerstückelung, API-Fehler, Offline, Abbruch, Stream-Abbruch, Secret-Handling, Datenminimierung, Aktionsvalidierung, Allergie-Vorrang, Zustandsdrift, Prompt-Injection-Fälle, lokaler Berater).

## Browser-QA (`e2e/app.cjs`): **78/78**
- **Viewports 390 / 768 / 1366 px** × 7 Seiten: kein horizontaler Überlauf; Touch-Ziele der Navigation ≥ 44 px (78×68).
- Funktionen: Onboarding-Validierung; Plan 7/14/21/30; Tag/Woche/Monat; Tausch, Löschen (−1), Ergänzen (+1), Portion, „gegessen“; Lebensmittel anlegen/Favorit/Ausschluss/löschen; **BLS-Suche und -Übernahme**; Rezepte (Portion 1,5× ≈ +50 % kcal), anlegen/löschen; Einkaufsliste (50 Posten, abhaken, entfernen, manuell, Update nach Planänderung); Fortschritt; Einstellungen (Profil, Widerspruch Carnivore+Vegan, Weisenwechsel, eigene Regeln).
- **Export** identisch zum gespeicherten Zustand; **Import**: gültig ✓, 6 defekte Varianten (korrupt, inkompatibel, unvollständig, leer, Array, manipuliert) **abgelehnt, Daten unverändert**.
- **Neustart-Persistenz** (Storage-State in neuem Kontext) ✓; **Löschen**: 0 localStorage-Schlüssel, auch nach Reload ✓.
- **PWA:** Service Worker aktiv; App-Hülle vorab gecacht; `/api` nie gecacht; **Offline-Neuladen ✓, gespeicherter Plan ✓, BLS-Suche offline (nach erstem Laden) ✓**; Manifest vollständig, Icons 192/512/maskable liefern 200; `lang`/`title`/`viewport`/`theme-color`.
- A11y-Kurzcheck: alle Bedienelemente haben einen zugänglichen Namen. Keine JS-Fehler in der Sitzung.

## KI-Browser-Test (`e2e/ai.cjs`, echtes Backend + Mock): **20/20**
Einwilligung vor Cloud-Nutzung; lokaler Tausch + Übernahme; Backend-/Anbieter-Anzeige; **Aktionsvorschau mit Engine-Tagessumme**; Plan vor Bestätigung unverändert, danach geändert; Datenvorschau (keine Körperdaten/Plan bei allgemeiner Frage); Backend-Schema akzeptiert den Kontext; **Backend aus → lokaler Fallback, Unterhaltung bleibt**, Plan voll nutzbar; mobil: Berater-Mittelknopf, Vollbild, Zurück, kein Überlauf.

## Beim Testen gefundene und behobene Fehler (Auszug)
SSE-Parser verlor Events bei `\r\n` über Chunk-Grenzen · Import ersetzte fehlende `foods` stillschweigend · Bereinigung ließ `<img …>` als Text · Mandeldrink fiel unter die Nuss-Mengengrenze · Fremdquellen-Werte wurden bei fehlenden BLS-Werten beigemischt · Service Worker lieferte offline keine Startseite · Chips brachen Text um · Chat-Button verdeckte Inhalte (mobil) · Einstellungen reagierten erst nach Serverantwort · BLS-Suche fand „Haferflocken“ nicht.

## Bekannte Einschränkungen / nicht getestet
- Echtes Android-Gerät, iOS, andere Browser (nur Chromium); Installationsdialog/Startbildschirm nur über Manifest-Kriterien.
- Echte OpenAI-/Anthropic-Aufrufe, echte Kosten; Ersatzanbieter nur in Backend-Tests mit Fakes.
- Fortschritts-Berechnungen nicht unit-getestet; visuelle Regression nur durch Sichtprüfung der Screenshots (keine Pixelvergleiche); Lasttests fehlen.
- 3 Mahlzeiten ≥ 3.000 kcal bzw. 4 Mahlzeiten ≥ 3.500 kcal sind nicht erreichbar (wird gemeldet).

## Wiederholen
`npm test && npm run typecheck && npm run build` · `npm run backend:test` · `npm run bls:test` · Browser: `npm run build; npm run preview` + (für KI) Backend mit `ENABLE_MOCK_PROVIDER=true NUTRI_DATA_DIR=<tmp>`, dann `node e2e/app.cjs` / `node e2e/ai.cjs` (Playwright global).
