# KI-Architektur (Multi-Provider)

## Ziele
Optionaler, jederzeit erreichbarer Ernährungsberater mit **OpenAI und Anthropic Claude** über *eine* Schnittstelle; Schlüssel nur serverseitig; die deterministische Engine bleibt maßgeblich; Ausfall der KI beeinträchtigt die App nicht.

## Komponenten
```
UI (ChatPanel) ──► AiProvider (Hook) ──► AiClient ──/api──► FastAPI
   │                   │  ├─ buildAiContext   (Datenminimierung, Freigaben)
   │                   │  ├─ localAnswer      (ohne KI/Netz)
   │                   │  └─ confirmProposal  (Engine-Validierung)
   └─ ActionCard (Vorschau, Übernehmen/Verwerfen)
                                           ┌───────────────────────────────┐
                                           │ api/chat.py   SSE             │
                                           │ services/ai_service           │
                                           │   Limits, Kontext, Fallback   │
                                           │ ai/providers/base_provider    │
                                           │   ├ openai_provider  (SDK)    │
                                           │   ├ anthropic_provider (SDK)  │
                                           │   └ mock_provider (Tests)     │
                                           └───────────────────────────────┘
```
Die UI spricht ausschließlich mit `AiClient`/`AiProvider`; das Backend ausschließlich mit dem Provider-Interface. Provider kennen sich nicht.

## Provider-Interface (`backend/ai/providers/base_provider.py`)
`stream(ProviderRequest) → async Iterator[Event]` mit `TextDelta`, `ToolCall(name,input)`, `UsageEvent`, `StopEvent`; `list_models()`; gemeinsame Fehlerklassen (`AuthError`, `RateLimitError`, `ProviderUnavailable`, `ProviderTimeout`, `BadRequestError`, `ProviderRefusal`) mit `retryable`. System-Prompt, Verlauf, Modell, `max_output_tokens`, optional `temperature`, Timeout, Abbruch (Stream wird bei Client-Disconnect geschlossen).
- **Anthropic** (`anthropic`-SDK, `messages.stream`): Standardmodell `claude-opus-5-5` (konfigurierbar); bei Claude-5.x/4.6+ wird **keine** `temperature` gesendet (API lehnt sie ab), kein erzwungenes `tool_choice`; Wiederholung ohne Temperatur bei Parameterfehler.
- **OpenAI** (`openai`-SDK, Chat Completions, Streaming + `include_usage`, Funktionswerkzeuge): **kein hartkodiertes Modell** – Auswahl aus der Live-Liste oder `OPENAI_DEFAULT_MODEL`.
- **Mock**: nur mit `ENABLE_MOCK_PROVIDER=true` (Tests/Entwicklung).

## API
`GET /api/health` · `GET/PUT /api/ai/settings` · `GET /api/ai/status` · `GET /api/ai/models?provider=` · `POST /api/ai/test` · `GET /api/ai/usage` · `POST /api/ai/chat` (SSE: `meta`, `delta`, `actions`, `usage`, `error`, `done`). Fehler vor dem Stream als JSON `{"error":{"code","message"}}`: `ai_disabled` 403, `cost_limit_reached` 402, `rate_limited` 429, `provider_not_configured`/`needs_model` 503, Validierung 422.
Einstellungen (nicht geheim, `backend/data/ai_settings.json`): `enabled` (Standard **aus**), `provider`, Modelle je Anbieter, `temperature`, `max_output_tokens` (≤ 4096), `history_messages` (≤ 30), `monthly_limit_usd`, `block_on_limit`, `fallback_provider`, `auto_fallback`.

## Kontrollierte Aktionen
1. Nutzer fragt. 2. Frontend baut minimalen Kontext (inkl. nur **regelkonformer** Rezepte). 3. KI antwortet streamend und ruft optional das Werkzeug `propose_actions`. 4. **Backend** prüft Schema, Datum/Mahlzeit-IDs, Rezept-ID im gesendeten Katalog, Grenzen, Zutatennamen aus `food_catalog`; max. 10 Vorschläge. 5. **Engine** (Frontend) prüft Allergien/Ausschlüsse/Ernährungsweisen, Mahlzeitenart, Portionsplausibilität, berechnet Kalorien/Nährwerte selbst und zeigt die Vorschau. 6. Nutzer bestätigt. 7. **Erneute Engine-Prüfung** gegen den aktuellen Zustand, dann Speichern.
Typen: `swap_meal`, `add_meal`, `remove_meal`, `set_portion`, `create_recipe`, `exclude_food`, `add_shopping_item`. **Kein** Typ ändert Allergien, Unverträglichkeiten, Ernährungsweisen, Regeln oder Profil.

## Betriebsmodi
`cloud` (Einwilligung + KI aktiv + Schlüssel + Modell + Limit frei) sonst `local`. Der Modus und der Grund stehen im Chat-Kopf. Bei Ausfall (offline, Backend aus, Fehler) antwortet automatisch der lokale Berater, die Unterhaltung bleibt erhalten, Teilantworten werden behalten.

## Mehrbenutzer-Betrieb (später)
Zusätzlich nötig: Authentifizierung, Mandantentrennung (Ledger/Einstellungen je Nutzer), serverseitige Geheimnisverwaltung, Datenschutzinformation, Kostenkontrolle je Nutzer, Rate-Limit je Konto (nicht IP).

## Tests
Backend 140 (pytest, Fake-SDK-Clients mit echten SDK-Exception-Klassen, Mock); Frontend 35 (SSE, Client, Kontext, Aktionen, lokaler Berater); Browser 20 (echtes Backend + Mock). **Echte Provider-Aufrufe: keine.**
