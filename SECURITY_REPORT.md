# Sicherheits- und Datenschutzbericht

Stufen: *geprüft* = durch Test/Scan in dieser Sitzung belegt; *Review* = nur Codesicht; *offen*.

## Geheimnisse
| Anforderung | Ergebnis |
|---|---|
| Schlüssel nur im Backend (`.env`) | **geprüft**: Frontend enthält keine Schlüssel/`VITE_`-Variablen; `/api/ai/status` liefert nur `configured: bool` (Test) |
| `.env` in `.gitignore` | **geprüft** (`git check-ignore`: `.env`, `backend/.env`, `backend/data/`) |
| Schlüssel nie in Logs/Fehlern/UI/Doku | **geprüft** (Redaktionsfilter + Tests; Client entfernt `sk-…`/`Bearer` aus Meldungen; Secret-Scan über getrackte Dateien: nur Dummy-Strings in Tests) |
| Vorhandene `.env` nutzen, nichts überschreiben | **Backend implementiert** (Suchreihenfolge `ENV_FILE` → `<Repo>/.env` → `backend/.env`; nur Lesen; Test mit Leerzeichen/Umlaut im Pfad). **Nicht geprüft** gegen deine echte Datei: `C:\Users\Bonit\Ernährungsplan` ist für diese Cloud-Sitzung nicht zugänglich (Ordnerliste leer); Schlüssel wurden nicht angefordert oder gesehen. |
| Prüfbefehl | `python -m backend.check_env [--live]` – zeigt nur Pfad und „gesetzt/fehlt“, nie Werte; `--live` testet kostenlos über `models.list` |

## Backend
Bindung `127.0.0.1`; CORS nur Allowlist (GET/POST/PUT); `TrustedHostMiddleware`; Body-Limit 256 KB; Pydantic mit `extra="forbid"`; Rate-Limit je IP (20/min, 429 + Retry-After); Timeouts; sichere Fehlerabbildung (`internal_error` ohne Details); Nachrichteninhalte werden weder geloggt noch im Ledger gespeichert. *geprüft* (140 Tests). **Grenzen:** Rate-Limit nur `request.client.host` (kein `X-Forwarded-For`); kein Auth – nur für Einzelnutzer-Betrieb auf localhost.

## Frontend
Kein `innerHTML`/`dangerouslySetInnerHTML`/`eval` (Scan); Chat-Text wird escapet (nur `**fett**`/Listen); KI-Aktionen: Schema + Engine-Validierung, HTML-Entfernung, keine Codeausführung. Eingaben per Zod validiert (Profil, Lebensmittel, Rezepte, Import).
**Import:** strikt, Größenlimit 20 MB, v2 muss vollständig sein; defekte/manipulierte Dateien werden abgelehnt (6 Fälle im Browser geprüft).
**Löschen:** entfernt alle `ernaehrungsplan-*`-Schlüssel (Browser-Test: 0 Schlüssel, auch nach Reload). *Nicht entfernt:* der Service-Worker-Cache der App-Hülle (enthält keine Nutzerdaten).

## KI-Sicherheit
Allergien/Ausschlüsse haben absoluten Vorrang: unzulässige Rezepte erreichen die KI nie (Katalog gefiltert) **und** werden bei Vorschlag und Bestätigung erneut abgelehnt; es gibt keinen Aktionstyp zum Ändern von Allergien/Profil/Regeln (Test „Sicherheitsinvariante“, Prompt-Injection-Fälle). KI-Zahlen werden nie übernommen. Prompt-Injection über Rezept-/Lebensmittelnamen: Kontext wird als Daten gerahmt und bereinigt (Backend-Tests), **kein Rest-Risiko ausgeschlossen**.
Lieferkette: Python-Abhängigkeiten (`fastapi`, `openai`, `anthropic` …) und npm-Pakete wurden nicht mit einem Schwachstellenscanner geprüft (**offen**).

## Datenschutz
Lokale Speicherung; keine Tracker; Datenübertragung nur nach Einwilligung, minimiert, mit Vorschau (`AI_PRIVACY.md`). Für kommerzielle Nutzung fehlen: Authentifizierung, Mandantentrennung, serverseitige Geheimnisverwaltung, Datenschutzinformation/AVV, Kostenkontrolle je Nutzer.

## Nicht unabhängig geprüft
Kein Penetrationstest, kein externes Review.
