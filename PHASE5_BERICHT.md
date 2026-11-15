# Phase 5 – Action Engine & Regel-NLU: Stand und Nachweis

Reihenfolge laut Nutzerentscheid: **Action Engine zuerst**; lokale Modelle/Sprache erst nach Messlauf auf dem Gerät.

## Reifegrad (ehrlich getrennt)
| Ebene | Stand |
|---|---|
| Geplant | Phase 1 (`PHASE1_BESTANDSAUFNAHME.md`), Router/Provider-Interfaces (Phase 4), Sprache (Phase 6) |
| Implementiert | Aktionsklassen A/B/C, 21 Aktionstypen, Tagesziel einmalig vs. dauerhaft, Makroziele, Änderungsprotokoll + Undo (LIFO, 25), Batch (alles-oder-nichts), deutsche Regel-NLU (Tier 0), Chat-Pipeline mit Rückfrage-Chips/Bestätigung/Undo, Tagesziel in der Plan-Ansicht |
| Automatisiert getestet | 243 Vitest (u. a. Engine 27, Tagesplan 10, Changelog 8, NLU 33), 140 pytest (Backend, unverändert), Browser-E2E `e2e/actions.cjs` (15 Prüfungen: 4.000-kcal-Beispiel, Rückfrage, Allergie-Verweigerung, Klasse A, Undo per Sprache, Mehrfachaktion), `e2e/ai.cjs` (20 Prüfungen, Mock-Anbieter), `e2e/app.cjs` |
| Auf realer Hardware getestet | **nicht gemessen** (kein Gerätezugriff; siehe `docs/MESSPROTOKOLL_S23ULTRA.md`) |
| Unabhängig geprüft | **nein** (kein externes Review, keine Nutzerstudie) |
| Freigegeben | **nein** |

## Verhalten am Beispiel „Ich möchte heute 4.000 kcal essen.“
Regel-NLU → `update_calorie_target{kcal:4000, scope:today}` → Engine-Vorschau (Klasse B, Bestätigung): Tagesziel 4.000 einmalig, **dauerhaftes Ziel unverändert**, Tagessumme geplant, Abweichungswarnung (>25 %), Mahlzeiten-/Einkaufslisten-Diff → nach „Bestätigen“ Plan nur für heute neu berechnet, Eintrag im Änderungsprotokoll, „Rückgängig“ stellt den Plan exakt wieder her (im E2E geprüft). Ohne Zeitangabe („…3000 kcal essen“) wird nachgefragt (Nur heute / Dauerhaft), nie geraten.

## Grenzen / bekannte Lücken
- Regel-NLU deckt feste Muster ab (Korpus 33 Tests); freie Formulierungen fallen auf lokalen Berater bzw. Cloud-KI zurück. Trefferquote auf echten Nutzersätzen: **nicht gemessen**.
- Cloud-Tool-Schema und Backend-Validator kennen weiterhin nur 7 Aktionstypen; die 14 neuen laufen nur über die Regelpfad/Engine (Erweiterung offen).
- Das Backend-Kontextschema (`extra=forbid`) wurde nicht erweitert; Tagesziele gehen daher nicht an die Cloud-KI.
- Makroziel-Eingabefelder im Profilformular fehlen noch (nur per Chat).
- Keine Sprache, kein lokales LLM, kein Router – bewusst noch nicht begonnen.

## Nächste Schritte
1. Du führst `probe.html` auf dem S23 Ultra aus (Protokoll) und gibst mir das JSON.
2. Danach Phase 2/3-Prototypen (PWA vs. native Hülle) und Phase 4 (Router, `LocalAIProvider`/`SpeechToTextProvider`/`TextToSpeechProvider`).
