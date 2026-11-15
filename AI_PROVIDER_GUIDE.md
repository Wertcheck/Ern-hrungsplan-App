# Anbieter einrichten und erweitern

## Schlüssel einrichten (lokal, ohne Werte im Chat)
1. Trage in deiner `.env` ein: `OPENAI_API_KEY=…` und/oder `ANTHROPIC_API_KEY=…` (Variablennamen siehe `backend/.env.example`). Die Datei wird in dieser Reihenfolge gesucht: `ENV_FILE` → `<Projektordner>/.env` → `backend/.env`. **Deine vorhandene Datei im Projektordner wird direkt genutzt; es wird keine zweite angelegt oder verändert.**
2. Prüfen (zeigt nie Werte): `python -m backend.check_env`, dann `python -m backend.check_env --live` (kostenloser `models.list`-Test über das gemeinsame Interface).
3. Backend starten: `python -m backend` (127.0.0.1:8787), Frontend `npm run dev` oder `npm run build && npm run preview` (beide leiten `/api` an das Backend).
4. In der App: **Einstellungen → KI-Ernährungsberater**: KI aktivieren, Anbieter wählen, Modell aus der Live-Liste wählen, „Verbindung testen“, im Chat der Datenübertragung zustimmen.

Windows (PowerShell), Beispiel: `$env:ENV_FILE="C:\Users\Bonit\Ernährungsplan\.env"; python -m backend`.

## Modelle
Nicht fest einprogrammiert: Liste live per `models.list`; Standardmodell nur über Konfiguration (Anthropic-Default `claude-opus-5-5`, OpenAI: keiner). **Fähigkeiten unterscheiden sich:** aktuelle Claude-5.x-Modelle und OpenAI-Reasoning-Modelle akzeptieren keine `temperature` – die App ignoriert sie dann (Hinweis in den Einstellungen). Preise: `backend/config/pricing.json` (Anthropic-Einträge mit Stand/Quelle; **OpenAI leer** – selbst ergänzen, sonst „nicht berechenbar“).

## Weiteren Anbieter ergänzen
1. `backend/ai/providers/<name>_provider.py`: Klasse von `BaseProvider` mit `is_configured`, `from_settings`, `stream`, `list_models`; SDK-Fehler über `sdk_errors` auf die gemeinsamen Fehlerklassen abbilden.
2. Eine Zeile in `registry.py`; Name in `ProviderName` (`settings_store.py`) und `Literal` in `schemas.py`.
3. Preise in `pricing.json`, Tests nach Muster `tests/test_providers.py` (Fake-Client).
Die UI und die Engine bleiben unverändert.

## Fehlerverhalten
Verständliche Meldung, Unterhaltung bleibt erhalten, Teilantwort bleibt, lokaler Berater antwortet. Wechsel des Anbieters: manuell in den Einstellungen; **automatisch nur** mit gesetztem Ersatzanbieter + „automatisch wechseln“ (und nur, wenn noch kein Text ausgegeben wurde). Jede Antwort nennt den Anbieter/das Modell.

## Freigabe für Live-Tests
Echte Aufrufe erfolgen nur nach deiner Freigabe mit deinen Schlüsseln auf deinem Rechner. Vorschlag: `--live`, dann eine Chat-Frage („Tausche das Mittagessen heute“) je Anbieter; erwartet: Antwort mit Anbieter-Fußzeile, ggf. Aktionskarte mit Engine-Vorschau.
