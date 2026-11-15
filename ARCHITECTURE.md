# Architektur

```
Browser (React/TS PWA, localStorage)                         lokal 127.0.0.1:8787
┌───────────────────────────────────────────┐   /api (Proxy)  ┌──────────────────────────────┐
│ src/domain  Engine (rein, deterministisch)│◄───────────────►│ backend/ (FastAPI)           │
│ src/ai      Kontext, Aktionen, lokaler    │   SSE           │  ai/providers  OpenAI|Claude │
│             Berater, Client               │                 │  services      Kontext, Limits│
│ src/pages   UI                            │                 │  .env (Schlüssel, nur hier)  │
└───────────────────────────────────────────┘                 └───────────────┬──────────────┘
                                                                       Anbieter-APIs (optional)
```
**Leitprinzip:** Die deterministische Engine im Frontend ist die einzige Instanz für Nährwerte, Regeln und Planänderungen. Die KI schlägt nur vor.

## Frontend (`src/`)
| Modul | Aufgabe |
|---|---|
| `domain/nutrition.ts` | Kalorien/Makros, Mifflin-St Jeor, Öl-Platzhalter (`oil:warm/cold`) |
| `domain/diets.ts` | **Registry** der Ernährungsweisen (`registerDiet`): `foodRule`, `recipeRule`, `fit`, `macroTarget`, `gapNotes`; Relationen (conflict/tension/info) |
| `domain/rules.ts` | Allergien (Allergie strikt inkl. unbekannt/Spuren; Unverträglichkeit), eigene Regeln, Öl-Wahl, Sicherheitsstatus |
| `domain/planner.ts` | Planung (s. u.), Bewertung (`analyzePlan`), Toleranzen |
| `domain/plausibility.ts` | Höchstmengen je Zutat/Mahlzeit, Portionsgrenzen |
| `domain/nutrients.ts` | Zufuhr vs. Orientierungswert, Datenabdeckung, Diät-Hinweise |
| `domain/bls.ts` | BLS-Index/Suche/Umwandlung (lazy geladener Chunk) |
| `domain/persistence.ts`, `schemas.ts` | abschnittsweise Validierung, Migration, Import, Löschen |
| `ai/` | `context.ts` (Datenminimierung), `actions.ts` (Validierung), `local.ts`, `client.ts`, `sse.ts`, UI |
| `data/` | Standard-Lebensmittel/-Rezepte, `bls/` (generierte Daten) |

Datenmodell: `AppState` v2 (`types.ts`), `dataVersion` frischt Standarddaten bei Updates auf (eigene Einträge bleiben).

## Planungsalgorithmus
Pro Tag und Mahlzeit: zulässige Rezepte (Regeln/Allergien) → portionsunabhängiger Score (Präferenzen, Weisen-Passung, Vielfalt, Wiederholung, Reste, Verfügbarkeit) → je Slot die 4 besten + 2 kalorienpassendste Kandidaten → **erschöpfende Suche über alle Kombinationen** (≤ 6⁵) → je Kombination exakte Portionslösung (Lagrange mit Schranken, `solvePortions`) → Zielfunktion = Σ Score − Portionsstrafe − 60·Kalorienabweichung − Makroabweichung (− Flexitarisch-Strafe) → 0,05er-Rasterung + Feinabgleich.
**Warum kein MILP/CP-Solver:** Suchraum klein, deterministisch, erklärbar, keine Abhängigkeit, <1 s für 30 Tage. Ein Solver würde erst bei Wochen-übergreifenden Restriktionen (Einkaufsmengen, Nährstoffziele je Woche) Vorteile bringen.
**Toleranzen:** ≤ 3 % „erreicht“ (Portionsraster 0,05 ≈ 1–2 % je Mahlzeit; Nährwertdaten selbst schwanken), 3–5 % Hinweis, > 5 % Warnung, > 10 % Fehler. Portionsfaktor hart 0,5–2,0, bevorzugt 0,75–1,5.
**Messung (Seed 1, 14 Tage):** max. Tagesabweichung ≤ 0,8 % für alle 12 Weisen bei 2.200 kcal; 1.200–3.000 kcal (4–5 Mahlzeiten) und bis 2.600 kcal (3 Mahlzeiten) ≤ 0,7 %. Nicht erreichbar (wird gemeldet): 3 Mahlzeiten ab 3.000, 4 Mahlzeiten ab 3.500 kcal.

## Backend (`backend/`)
`ai/providers/{base,openai,anthropic,mock,registry}` (gemeinsames Interface, keine gegenseitigen Importe) · `services/{ai_service,nutrition_context,action_validator,usage_ledger,settings_store,rate_limiter}` · `api/{chat,ai_admin,health}` · `config/{settings,pricing.json}`. Details: `AI_ARCHITECTURE.md`.

## Erweiterbarkeit
Neue Ernährungsweise: `registerDiet({...})`. Neuer KI-Anbieter: eine Datei in `ai/providers/` + eine Zeile in `registry.py`. Neue Datenquelle: Importer nach Muster `scripts/bls/`.
