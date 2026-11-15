# KI-Backend (lokal)

Schlankes FastAPI-Backend (Python 3.13) als einziger Weg zu KI-Anbietern (OpenAI, Anthropic Claude).
Laeuft nur lokal auf `127.0.0.1:8787`. Das Backend fuehrt nie Plan-Aenderungen aus: es streamt Antworten
und validiert nur Struktur/Katalogzugehoerigkeit von Aktionsvorschlaegen. Die massgebliche
Naehrwert-/Allergiepruefung macht die TypeScript-Engine im Frontend.

## Schluessel (nur lokal!)

API-Schluessel stehen ausschliesslich in einer `.env`-Datei bzw. in Prozess-Umgebungsvariablen. Sie werden nie
geloggt, nie in Antworten/Fehlern ausgegeben und nie veraendert oder kopiert (Dateien werden nur gelesen).
`.env` ist per `.gitignore` ausgeschlossen. Vorlage: `backend/.env.example`.

Suchreihenfolge fuer die `.env` (erste existierende Datei gewinnt):

1. Umgebungsvariable `ENV_FILE` (beliebiger Pfad, auch mit Leerzeichen/Umlauten)
2. `<Repo-Root>/.env`
3. `backend/.env`

Echte Prozess-Umgebungsvariablen haben immer Vorrang vor Dateiinhalten.

Erwartete Variablen (Werte hier bewusst nicht aufgefuehrt):

| Variable | Bedeutung |
|---|---|
| `OPENAI_API_KEY` | OpenAI-Schluessel |
| `ANTHROPIC_API_KEY` | Anthropic-Schluessel |
| `OPENAI_DEFAULT_MODEL` | optional; kein Default im Code (leer = Status `needs_model`, Modell in der App waehlen) |
| `ANTHROPIC_DEFAULT_MODEL` | optional; Default `claude-opus-5-5` |
| `ENV_FILE` | optional; Pfad zur `.env` |
| `ALLOWED_ORIGINS` (oder `NUTRI_ALLOWED_ORIGINS`) | kommagetrennt; Default localhost/127.0.0.1 auf 5173 und 4173 |
| `ENABLE_MOCK_PROVIDER` (oder `NUTRI_ENABLE_MOCK_PROVIDER`) | `true` aktiviert den Mock-Provider (Tests/Entwicklung) |
| `NUTRI_HOST`, `NUTRI_PORT` | Default `127.0.0.1`, `8787` |
| `NUTRI_REQUEST_TIMEOUT_S` | Default 60 (Leerlauf-Timeout je Provider-Ereignis und SDK-Timeout) |
| `NUTRI_RATE_LIMIT_PER_MIN` | Default 20 (pro Client-IP, nur Chat; 0 = aus) |
| `NUTRI_MAX_BODY_BYTES`, `NUTRI_MAX_HISTORY_CAP`, `NUTRI_MAX_OUTPUT_TOKENS_CAP`, `NUTRI_DATA_DIR`, `NUTRI_PRICING_PATH` | Limits/Pfade |

Pruefen ohne Netzwerk: `python -m backend.check_env` (zeigt den verwendeten Pfad, nur `gesetzt`/`fehlt`, Syntaxpruefung).
Mit `--live`: kostenloser Verbindungstest (`models.list`) je Provider; meldet nur OK/Fehlerklasse (bereinigt).
Exitcode 0 nur, wenn eine `.env` gefunden wurde, die Syntax stimmt, mindestens ein Schluessel gesetzt ist und
(bei `--live`) alle konfigurierten Provider antworten.

## Start

```bash
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements-dev.txt   # Windows: backend\.venv\Scripts\pip
python -m backend                      # Host/Port aus den Einstellungen (127.0.0.1:8787)
# oder: uvicorn backend.main:app --host 127.0.0.1 --port 8787
```

KI ist standardmaessig deaktiviert (Opt-in ueber `PUT /api/ai/settings {"enabled": true}`).

## Tests

```bash
pytest backend/tests     # vom Repo-Root, ohne Netzwerk, ohne Schluessel (Fake-SDK-Clients / Mock)
```

## Aufbau

```
backend/
  main.py                 create_app(settings=None, provider_factory=None), Middleware, Fehlerformat
  check_env.py            CLI-Pruefung der .env
  config/settings.py      pydantic-settings, .env-Suchreihenfolge; config/pricing.json
  ai/prompts.py           deutscher System-Prompt
  ai/providers/           base_provider (Interface, Events, Fehler), openai_, anthropic_, mock_provider, registry
  services/               ai_service, nutrition_context, action_validator, usage_ledger, settings_store, rate_limiter
  api/                    chat (SSE), ai_admin, health
  tests/
```

Neuer Provider: eine Datei in `ai/providers/` (Subklasse von `BaseProvider`) plus eine Zeile in `registry.py`.
Provider importieren sich nicht gegenseitig.

## API (alle Pfade unter /api)

`GET /health`, `GET /ai/status`, `GET|PUT /ai/settings`, `GET /ai/models?provider=`, `POST /ai/test`,
`GET /ai/usage`, `POST /ai/chat` (SSE: `meta`, `delta`*, `actions`?, `usage`, `error`?, `done`).
Fehler vor dem Stream: JSON `{"error": {"code", "message"}}` mit 402/403/422/429/503.

## Hinweise

- Kosten: nur mit Preis aus `config/pricing.json` (`provider:modell`), sonst `cost_usd: null`/`cost_known: false`.
  OpenAI-Preise sind nicht hinterlegt (selbst ergaenzbar). Caching-Rabatte werden nicht beruecksichtigt (kein Caching).
  Kostenlimit blockiert nur auf Basis bekannter Kosten und mit `block_on_limit`.
- Bei Claude-5.x-Modellen wird kein `temperature` gesendet; bei Ablehnung genau ein Retry ohne `temperature` (auch OpenAI).
- Der Chat fuehrt genau einen Modellaufruf aus; Tool-Aufrufe (`propose_actions`) werden validiert und als `actions`
  gemeldet, nicht an das Modell zurueckgespielt.
- Es werden keine Nachrichteninhalte geloggt oder gespeichert (Usage-Log enthaelt nur Tokens/Modell/Kosten).
