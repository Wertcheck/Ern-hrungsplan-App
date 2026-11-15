# Projektaudit

Zwei Zeitpunkte: **(A) Audit des Ausgangsstands** (Commit `162a320`, vor Addendum 2–4) und **(B) Stand heute**. Alle Befunde in (A) wurden per Code-Review und – wo möglich – per Probe-Lauf im Browser *belegt*, nicht nur vermutet.

## A) Befunde am Ausgangsstand
| # | Befund | Beleg | Schwere | Status |
|---|---|---|---|---|
| 1 | „Alle Daten löschen“ schrieb sofort einen neuen Standardzustand (55 KB) zurück | Probe: localStorage nach Löschen = 55.878 Zeichen | hoch (Datenschutz) | **behoben** (`skipPersist`, `clearAllStorage`; Browser-Test: 0 Schlüssel, auch nach Reload) |
| 2 | Beschädigter gespeicherter Plan → leerer weißer Bildschirm (`e.days.map is not a function`) | Probe | hoch (Datenintegrität) | **behoben** (abschnittsweise Validierung, `ErrorBoundary`, Rohdaten-Backup) |
| 3 | Offline-Neuladen schlug fehl trotz Service Worker | Probe: `ERR_FAILED` | hoch (PWA) | **behoben** (Precache; saubere Antwortkopie, da *umgeleitete* Antworten für Navigationen verweigert werden) |
| 4 | Nur SVG-Icon im Manifest (kein PNG 192/512/maskable) | Probe | mittel | **behoben** |
| 5 | Importvalidierung zu lasch (`plan: any`, Teilprofile) | Code-Review | hoch | **behoben** (strikte Schemata, v2 muss vollständig sein) |
| 6 | Planer: Greedy je Slot, 3.000 kcal/4 Mahlzeiten verfehlte bis 11 % | Messung | hoch (Kernfunktion) | **behoben** (Kombinationssuche; jetzt ≤ 0,4 %) |
| 7 | Nährwerte nur „Richtwerte“ aus dem Gedächtnis; Kohlenhydrate inkl. Ballaststoffe | Code-Review | hoch (Priorität 1) | **teilweise behoben**: 99/108 aus BLS 4.0, einheitlich *ohne* Ballaststoffe; 9 offen |
| 8 | Allergene ohne Spuren; „Herkunft unbekannt“ nicht abbildbar | Code-Review | hoch (Priorität 2) | **behoben** |
| 9 | Ernährungsweisen fest verdrahtet, „Basisch“ bevorzugt dargestellt | Code-Review | mittel | **behoben** (Registry, 12 Weisen, neutral) |
| 10 | Kein Test der Oberfläche über Plan/Onboarding hinaus | Review | mittel | **behoben** (78 Browser-Prüfungen) |
| 11 | Git-Push 403 | Lauf | extern | **offen** (Berechtigung, siehe unten) |

Architektur-Bewertung des Ausgangsstands: saubere Trennung Domäne/UI; Schwächen waren (a) kein Schema-Versionierungskonzept, (b) Engine-Konstanten verstreut, (c) Persistenz im Store vermischt. Alle drei wurden ohne Neuaufbau behoben (`persistence.ts`, `plausibility.ts`, `diets.ts`).

## B) Stand heute – Risiken und Empfehlungen
| Risiko | Einschätzung | Empfehlung |
|---|---|---|
| localStorage ca. 5 MB-Limit (Zustand ≈ 170 KB, +Chat bis 60 Nachrichten) | niedrig | Bei Wachstum auf IndexedDB wechseln (Schnittstelle `KV` ist bereits abstrahiert) |
| Nährwertquelle für 9 Lebensmittel nicht verifiziert | gering | USDA/BLS-Eintrag ergänzen, sobald Quelle erreichbar |
| Allergen-/Histamin-/Fruktose-Tags sind Näherungen | **mittel (Sicherheit)** | Nie als Garantie darstellen (so umgesetzt); ggf. Abgleich mit Herstellerangaben |
| Referenzwerte (D-A-CH) aus Erinnerung, nicht verifiziert | mittel | Gegen DGE-Tabellen prüfen, bevor die Bilanz mehr als „Orientierung“ sein soll |
| KI nur mit Mock getestet | mittel | Eigenen Live-Test: `python -m backend.check_env --live`, dann Chat mit echtem Modell (siehe `AI_PROVIDER_GUIDE.md`) |
| Einzelnutzer-Annahme (keine Auth) | hoch bei Mehrnutzerbetrieb | Vor Veröffentlichung: Auth, Mandanten, Datenschutzinformation (`AI_PRIVACY.md`) |
| Planer bei sehr hohem Kalorienbedarf (3 Mahlzeiten ≥ 3.000 kcal) | bekannt | Wird gemeldet; Empfehlung 4–5 Mahlzeiten |
| Keine Rezept-Bilder | UX | lizenzgeprüfte Bildquelle beschaffen |

## Verzeichnisstruktur
`src/` (Frontend) · `backend/` (FastAPI) · `scripts/bls/` (Importer) · `e2e/` (Browser-Tests) · `public/` (PWA) · Berichte im Root.

## Git / Remote
Commits liegen lokal auf `claude/nutrition-planner-app-3ixfrf`; Historie unverändert. `git push` → **HTTP 403** („Claude hat keinen GitHub-Zugriff auf Wertcheck/Ern-hrungsplan-App“). Keine Umgehung versucht. Anleitung: GitHub-App unter <https://github.com/apps/claude/installations/select_target> installieren (oder Org-Admin bitten) bzw. claude.ai → Einstellungen → Connectors → GitHub neu verbinden; danach `git push -u origin claude/nutrition-planner-app-3ixfrf`.
