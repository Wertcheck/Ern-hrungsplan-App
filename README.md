# Ernährungsplan – persönlicher Ernährungsplaner (PWA)

Lokale, responsive PWA (React + TypeScript + Vite + Tailwind). Daten bleiben im Browser (`localStorage`). Optional: KI-Berater über ein lokales FastAPI-Backend (OpenAI **oder** Claude). Die App funktioniert vollständig ohne KI und offline.

**Funktionen:** Profil/Kalorienziel · 12 Ernährungsweisen (kombinierbar, eigene Regeln) · Lebensmittel mit **BLS 4.0** (7.140 durchsuchbar) · Allergien/Unverträglichkeiten · Pläne 7–30 Tage · Rezepte · Einkaufsliste · Nährstoffbilanz · Fortschritt · Export/Import/Löschen · KI-Chat mit Engine-geprüften Vorschlägen.

## Start
```bash
npm install
npm run dev                 # http://localhost:5173
npm run build && npm run preview   # http://localhost:4173 (PWA/Offline nur im Build)
npm test                    # 165 Tests
```
**KI-Backend (optional):**
```bash
python3 -m venv backend/.venv && backend/.venv/bin/pip install -r backend/requirements-dev.txt
python -m backend            # 127.0.0.1:8787; Vite leitet /api weiter
python -m backend.check_env  # prüft .env, zeigt nie Werte (--live = Verbindungstest)
```
Schlüssel stehen **nur** in deiner `.env` (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`); Details und Windows-Beispiel in `AI_PROVIDER_GUIDE.md`. Android: Chrome → „Zum Startbildschirm hinzufügen“ (HTTPS oder `localhost` nötig).

## Dokumentation
`IMPLEMENTATION_STATUS.md` (was ist wie geprüft) · `QA_REPORT.md` · `SECURITY_REPORT.md` · `PROJECT_AUDIT.md` · `SKILL_AUDIT.md` · `ARCHITECTURE.md` · `BLS_INTEGRATION.md` · `AI_ARCHITECTURE.md` · `AI_PROVIDER_GUIDE.md` · `AI_PRIVACY.md` · `AI_COST_CONTROL.md`.

## Datenquellen und Lizenz
Nährwerte (99 Standard-Lebensmittel): **Bundeslebensmittelschlüssel 4.0**, Max Rubner-Institut, CC BY 4.0 – *Max Rubner-Institut (2025): Bundeslebensmittelschlüssel (BLS), Version 4.0 — Deutsche Nährstoffdatenbank. Karlsruhe. DOI: 10.25826/Data20251217-134202-0.* Übrige Lebensmittel sind als „Richtwert (nicht verifiziert)“ gekennzeichnet. Allergen-/Spurenangaben sind Näherungen ohne Gewähr.

## Hinweis
Informations- und Planungshilfe, keine ärztliche oder ernährungsmedizinische Beratung; bei Allergien immer Etiketten prüfen. Keine Ernährungsweise wird als medizinisch überlegen dargestellt.
