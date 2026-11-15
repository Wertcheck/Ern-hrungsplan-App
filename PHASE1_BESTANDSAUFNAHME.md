# Phase 1 – Bestandsaufnahme und Implementierungsplan
*Lokale KI, Sprachsteuerung, vollständige App-Automatisierung* · Stand 2026-11-15 · **Es wurde nichts umgebaut.**

Kennzeichnung: **[Repo]** = im Code geprüft · **[Messung]** = in dieser Sitzung gemessen · **[Hypothese]** = Vorwissen, **nicht** verifiziert, in Phase 2/3 auf dem Gerät zu prüfen · **[Entscheidung]** = braucht deine Freigabe.

## 1. Ist-Zustand
| Bereich | Befund | Quelle |
|---|---|---|
| Stack | React 19, TypeScript, Vite, Tailwind 4, Zod; **drei** Laufzeit-Abhängigkeiten (react, react-dom, zod) | [Repo] |
| Umfang | Engine/Domäne 2.686 Zeilen, KI-Frontend 1.237, Seiten 1.290, Backend (FastAPI) 3.399, Importer 420, E2E 235 | [Repo] |
| Tests | 165 Vitest · 140 pytest · 10 Importer-pytest · 78 + 20 Browser-Prüfungen, alle grün | [Messung] |
| Bundle | App 169 KB gzip; BLS-Daten 396 KB gzip als Lazy-Chunk | [Messung] |
| Persistenz | `localStorage` (Schlüssel `ernaehrungsplan-state-v1`, ca. 170 KB), abschnittsweise validiert, Migration v1→v2 | [Repo] |
| PWA | Manifest, PNG-Icons, Precache-Service-Worker, Offline-Neuladen (Chromium geprüft); **kein echtes Android-Gerät getestet** | [Repo]/[Messung] |
| Engine | deterministisch; Plan, Rezepte, Regeln, Allergene, Nährstoffbilanz; BLS 4.0 | [Repo] |
| KI | Backend: Provider-Interface (OpenAI, Anthropic, Mock), SSE, Kosten, Limits. Frontend: Chat, Kontext-Minimierung, 7 Aktionstypen mit Engine-Validierung, lokaler Regel-Berater (≈5 Intents) | [Repo] |
| Sprache | **nichts vorhanden** (kein `SpeechRecognition`, `speechSynthesis`, `getUserMedia`) | [Repo] |
| Lokales LLM | **nichts vorhanden**; kein `LocalAIProvider`, kein Router | [Repo] |
| Undo / Änderungsprotokoll | **nicht vorhanden** | [Repo] |

### Wichtige Struktur-Befunde (bestimmen den Plan)
1. **Ein Kalorienziel pro Plan.** `Plan.kcalTarget` (einmal bei Erzeugung aus `kcalTarget(profile)`) steuert Planer, Analyse, Anzeige. „Heute 4.000 kcal“ ist im Modell **nicht darstellbar**, ohne das Profilziel zu überschreiben, was die Vorgabe ausdrücklich verbietet. → braucht ein `dayTargets`-Konzept (Abschnitt 4).
2. **Makro-/Proteinziele sind nicht editierbar**, sie leiten sich aus den Ernährungsweisen ab (`macroTargetFor`). „Proteinziel auf 180 g“ hat keinen Speicherort.
3. **Der Planer kann pro Tag mit eigenem Ziel rechnen** (`solveDay(slots, T, …)` bekommt T je Tag); eine Einzeltag-Neuberechnung benötigt nur den Verlaufskontext der Nachbartage. Aufwand moderat.
4. **Die KI-Aktionsschicht (`ai/actions.ts`) ist erweiterbar**: Schema → Engine-Validierung → Vorschau → erneute Prüfung bei Bestätigung. Sie kennt aber nur Plan-/Rezept-/Ausschluss-Aktionen.
5. **Das Provider-Interface existiert nur im Backend (Python).** Ein `LocalAIProvider` läuft zwingend im Gerät (Browser/nativ) → ein zweites, **TypeScript-seitiges** Provider-Interface ist nötig; der Router gehört ins Frontend (kennt Netz, Gerät, Datenschutz-Präferenz).
6. **Spannung zu früheren Zusagen:** Bisher gilt „keine Aktion ändert Ernährungsweisen/Profil“. Die neuen Anforderungen verlangen genau das (`update_user_profile`, Ernährungsformen). → Regelung nötig (Abschnitt 5): Profil/Weisen **bestätigungspflichtig**; **Allergien/Unverträglichkeiten bleiben für die KI unveränderbar** (Sicherheitsinvariante bleibt).
7. **Rechtliche Altlast:** keine. Lizenzen der Abhängigkeiten uneinheitlich geprüft → vor Modellauslieferung prüfen.

## 2. Lückenanalyse zu den Anforderungen
**Aktionen (Abschnitt 7 der Vorgabe)**
| Vorgabe | Heute | Arbeit |
|---|---|---|
| `replace_meal`, `add_meal`, `remove_meal`, `update_meal_portion` | ✓ (`swap_meal`, `add_meal`, `remove_meal`, `set_portion`) | Umbenennen/Alias |
| `create_recipe`, `add_excluded_food` | ✓ (`create_recipe`, `exclude_food`) | – |
| `update_shopping_list` | teilweise (`add_shopping_item`) | Entfernen/Abhaken ergänzen |
| `update_calorie_target` (heute / dauerhaft) | ✗ | **Datenmodell** (`dayTargets`), Planer-Einzeltag |
| `update_macros`, `update_nutrition_goal`, `update_activity_level` | ✗ | Speicherort + Engine-Anbindung |
| `update_user_profile`, `update_weight`, `update_target_weight` | ✗ | Aktion + Validierung (`profileSchema`) |
| `add_food`, `remove_food`, `add_preferred_food`, `update_food_preferences` | ✗ | Aktionen (`add_food` nur mit Nährwerten aus Nutzer/BLS, nie von der KI) |
| Ernährungsformen setzen/kombinieren | ✗ (UI ja) | Aktion + Konflikterklärung (Engine kann das) |
| `update_recipe` | ✗ | Aktion |
| `regenerate_day/week/month_plan` | nur ganzer Plan über UI | Einzeltag-/Zeitraum-Neuberechnung |
| **Undo**, Änderungsinformation | ✗ | Änderungsprotokoll mit Umkehrung |
| Aktionsklassen A/B/C | implizit (alles bestätigt) | explizite Klassen, Direkt-Ausführung für harmlose Aktionen |

**KI/Router/Sprache**
| Vorgabe | Heute | Arbeit |
|---|---|---|
| `LocalAIProvider` | ✗ | **Prototyp nötig (Phase 2)** |
| Router (lokal vor Cloud, Kriterien, Protokoll) | ✗ (Modus nur cloud/lokal-Regeln) | neues Modul `ai/router.ts` |
| Kostenkontrolle Cloud | ✓ (Backend) | Router-Protokoll anbinden |
| `SpeechToTextProvider`, `TextToSpeechProvider` | ✗ | Schnittstellen + Implementierungen nach Prototyp |
| Mikrofon-UI, Transkript-Vorschau, Korrektur | ✗ | UI (ChatPanel) |
| Mehrfachabsichten, Rückfragen bei fehlenden Angaben | ✗ | NLU-Schicht (Abschnitt 4) |

## 3. Abnahmekriterien (Abschnitt 16) – Ist-Stand
| # | Kriterium | Ist |
|---|---|---|
| 1 | Lokale KI läuft auf dem S23 Ultra | **offen** (kein Gerät, kein Prototyp) |
| 2 | Lokale KI steuert einfache Funktionen zuverlässig | offen |
| 3 | Cloud-KI gezielt bei Bedarf | teilweise (nur manuell wählbar, kein Router) |
| 4 | OpenAI + Anthropic über gemeinsame Schnittstelle | **erfüllt im Backend**, nur mit Mock/Fakes getestet, nie live |
| 5–7 | Sprachbedienung, deutsche Erkennung, lokal/offline | offen |
| 8–9 | Kalorienziel per Sprache, temporär vs. dauerhaft | offen (Datenmodell fehlt) |
| 10 | Neuberechnung nach Änderungen | Engine ✓, Einzeltag-Ziel offen |
| 11 | Allergien/Ausschlüsse verbindlich | **erfüllt** (getestet) |
| 12 | Nachvollziehbar + Undo | Nachvollziehbarkeit teilweise, Undo offen |
| 13 | Schlüssel/Sprachaufnahmen sicher | Schlüssel ✓ (Backend); Sprache offen |
| 14 | Automatisierte + reale Android-Tests | automatisiert ✓ für Bestand; **reale Android-Tests: keine** |

## 4. Zielarchitektur (Vorschlag)
```
Sprache/Text ──► STT-Provider (austauschbar) ──► Transkript (sichtbar, editierbar)
                                                       │
                                  ┌────────────────────▼───────────────────┐
                                  │ NLU-Pipeline (Frontend)                │
                                  │ Tier 0: deterministische Regel-NLU     │  ← kostenlos, schnell, testbar
                                  │   (Zahlen, Einheiten, heute/dauerhaft) │
                                  │ Tier 1: LocalAIProvider (Gerät)        │
                                  │ Tier 2: Cloud (Backend /api)           │
                                  └──────────┬─────────────────────────────┘
                                   AI Router │ Kriterien + Protokoll (ohne Inhalte)
                                  ┌──────────▼─────────────────────────────┐
                                  │ Action Engine  (Schema → Validierung → │
                                  │  Klasse A/B → Bestätigung → Ausführen →│
                                  │  Änderungsprotokoll/Undo)              │
                                  └──────────┬─────────────────────────────┘
                                             ▼  deterministische Engine (unverändert maßgeblich)
```
- **Tier 0 (Empfehlung):** Viele Befehle („heute 4.000 kcal“, „Proteinziel 180 g“, „tausche das Mittagessen“) sind formal genug für eine **regelbasierte deutsche Befehlsgrammatik** (Zahlwörter, Einheiten, Zeitbezug heute/morgen/dauerhaft, Mehrfachaktionen mit „und“). Das ist deterministisch, offline, ohne Modell, 100 % testbar und spart Akku/Kosten. Das lokale LLM wird erst für unscharfe Sprache gebraucht. [Hypothese zur Abdeckung – wird mit einem Befehlskorpus gemessen.]
- **`dayTargets`:** `Plan.dayTargets?: Record<datum, kcal>` (+ Herkunft `temporary`); `Plan.kcalTarget` und `profile.kcalManual` bleiben unverändert. Einzeltag-Neuberechnung nutzt den vorhandenen Tageslöser mit Verlaufskontext der Nachbartage. „Dauerhaft“ ändert das Profilziel (Klasse B, Bestätigung).
- **Undo:** Änderungsprotokoll mit **Umkehr-Patches der betroffenen Abschnitte** (nicht ganze Zustände; Plan ≈ 80 KB je Snapshot wäre zu teuer), Obergrenze z. B. 30 Einträge, Teil des Exports/Löschens.
- **Aktionsklassen:** A direkt (Favorit, Einkaufsposten, Portion ±), B bestätigungspflichtig (Profil, Ernährungsformen, dauerhaftes Ziel, Mehrtages-/Monatsplan, Löschen), C gesperrt (Allergien/Unverträglichkeiten, medizinische Entscheidungen, Datenlöschung).
- **Schnittstellen (TS):** `AiProvider {id, capabilities, complete(req, signal)}` mit `LocalAIProvider` (Gerät) und `CloudProvider` (ruft `/api/ai/chat`); `SpeechToTextProvider`, `TextToSpeechProvider`. Backend-Interface bleibt; ein späterer Cloud-Backend-Wechsel ändert nur die Basis-URL.
- **Router-Kriterien** (nachvollziehbar, Protokoll **ohne Inhalte**): Tier-0-Treffer → fertig; Aufgabenklasse (Befehl vs. Analyse), Selbstvertrauen/Schema-Validität der lokalen Antwort, Netz, Nutzerpräferenz „Cloud erlaubt“, Kostenlimit; **keine** Eskalation nach Nachrichtenlänge. Qualitätsprüfung = deterministisch (Schema gültig? Engine-Validierung bestanden? Rückfrage nötig?).

## 5. Entscheidungen, die du treffen musst [Entscheidung]
1. **Plattform:** PWA allein **oder** natives Android-Gerüst (z. B. Capacitor/TWA mit Plugins). Natives ist [Hypothese] die Voraussetzung für LiteRT-LM, whisper.cpp und sherpa-onnx (native Bibliotheken); eine reine PWA kann nur WebGPU/WASM-Pfade nutzen (WebLLM, ONNX Runtime Web, WASM-Builds). Das ist die **größte Architekturentscheidung**.
2. **Messzugang:** Ohne Gerätezugriff kann ich **keine** Messwerte liefern. Entweder du führst einen von mir vorbereiteten, abhängigkeitsfreien Messlauf auf dem S23 Ultra aus (Capability-Probe-Seite + Messprotokoll, Ergebnis als JSON zurück), oder wir verzichten vorerst auf Gerätewerte.
3. **Regeländerung für KI-Aktionen:** Profil/Ernährungsformen/dauerhaftes Ziel per KI nur mit Bestätigung (Klasse B); Allergien bleiben gesperrt – einverstanden?
4. **Cloud-Voreinstellung:** Standard „lokal zuerst, Cloud nur auf Nachfrage“ oder „Cloud automatisch bei Bedarf (nach Einwilligung)“?
5. **RAM des S23 Ultra:** 8 oder 12 GB bitte aus *Einstellungen → Über das Telefon* ablesen (Browser-APIs melden maximal 8 GB und können 8/12 nicht unterscheiden).

## 6. Machbarkeit lokaler KI und Sprache – **nur Hypothesen, nichts gemessen**
Alles Folgende stammt aus Vorwissen und ist vor jeder Entscheidung auf dem Gerät zu verifizieren. Eine Websuche war in dieser Sitzung nicht möglich (Netz auf wenige Hosts beschränkt).
| Ansatz | Läuft in PWA? | Erwartung/Risiko (unverifiziert) |
|---|---|---|
| WebLLM / WebGPU | ja (Chrome Android mit WebGPU) | 3B-Modell 4-Bit ≈ 2 GB Download; Speicherquote, Ladezeit, Tab-Beendigung durch Android, GPU-Puffergrenzen; Adreno-GPU-Kompatibilität prüfen |
| LiteRT-LM (Google) | nein (nativ) | gute Geräteintegration möglich; Modellformat/Lizenz prüfen |
| ONNX Runtime Mobile / Web | Web: ja (WASM/WebGPU); Mobile: nativ | WASM deutlich langsamer; Modellkonvertierung nötig |
| whisper.cpp (STT) | nativ; WASM-Build möglich | Genauigkeit Deutsch je Modellgröße (tiny/base/small) vs. Latenz abwägen |
| sherpa-onnx (STT) | nativ und WASM-Builds | kleine Streaming-Modelle; deutsche Modelle verfügbar? prüfen |
| Android `SpeechRecognizer` | nein (nativ) | On-Device-Modus je Android-Version/Sprachpaket; nicht automatisch offline |
| Web Speech API (Chrome) | ja | läuft in Chrome Android üblicherweise **serverbasiert** → *nicht* als lokal behandeln; Datenschutz-Hinweis nötig |
| TTS (`speechSynthesis`/Android-TTS) | ja | lokal, wenn deutsche Stimme installiert; Qualität/Offline prüfen |
Lizenzen (alle prüfen): Whisper/whisper.cpp MIT, sherpa-onnx Apache-2.0, ONNX Runtime MIT [Hypothese]; **Modelllizenzen** (Gemma-, Llama-, Qwen-, Phi-Bedingungen) unterscheiden sich stark und sind für eine spätere kommerzielle Nutzung entscheidend.

## 7. Implementierungsplan
| Phase | Inhalt | Voraussetzung | Neue Abhängigkeiten |
|---|---|---|---|
| **2 Hardware-Prototyp** | Capability-Probe (WebGPU-Limits, Speicher, Speicherquote, Sprach-APIs, Akku-Delta); danach 1 kleines + 1 3B-Modell (4-Bit) über den gewählten Pfad; Messung RAM/Tokens pro s/Akku/Temperatur | **Gerätezugang** + Entscheidung 1/2 | erst nach Prototyp |
| **3 Sprach-Prototyp** | STT-Vergleich auf einem deutschen Befehlskorpus (Lebensmittel, Mengen, kcal, lange Sätze); WER/Latenz/Akku; TTS-Test | Gerät, Mikrofon | nach Messung |
| 4 KI-Architektur | TS-Provider-Interface, `CloudProvider`, `LocalAIProvider`-Adapter, Router + Protokoll, Kostenanbindung | 2 abgeschlossen | keine |
| 5 Action Engine | `dayTargets`, Makro-/Profilspeicher, Aktionsklassen, ~20 Aktionen, Undo, Tier-0-Regel-NLU, Mehrfachaktionen, Rückfragen | Entscheidung 3 | keine |
| 6 Sprachintegration | Mikrofon-UI, Transkript-Vorschau/Korrektur, TTS, Berechtigungen, kein Always-on | 3, 5 | je Prototyp |
| 7 UI/UX + QA | Mobile-First-Politur (S23 Ultra), Regression, Datenschutz-/Sicherheitsprüfung, reale Android-Tests | Gerät | – |

**Reihenfolge-Empfehlung:** Phase 5 (Action Engine inkl. Tier-0-NLU, Undo, `dayTargets`) kann **ohne Gerät** und **ohne neue Abhängigkeiten** vollständig automatisiert getestet werden und liefert bereits den größten Nutzen (Textbefehle). Phase 2/3 bleiben Gerätearbeit. Ich empfehle, 5 vor 2/3 zu ziehen, dies widerspricht jedoch deiner vorgegebenen Reihenfolge und braucht deine Freigabe.

## 8. Test- und Nachweisstrategie
Automatisiert (Mock-Provider, Befehlskorpus, Property-Tests für Zahlen/Einheiten, Undo-Roundtrips, Allergie-Invarianten, Routing-Entscheidungen, Mikrofon-/Fehlerzustände per Mocks). **Reale Hardwarewerte nur mit Messprotokoll vom Gerät**; ohne Messung steht in Berichten „nicht gemessen“. Reale API-Aufrufe nur nach deiner Freigabe.

## 9. Risiken
Lokale 3B-Modelle sind bei Tool-Calling/deutschen Mengenangaben oft unzuverlässig [Hypothese] → Tier-0 + Schema-Validierung + Rückfragen statt Raten · Speicher-/Hitzedrosselung auf dem Gerät · Android beendet Hintergrund-Tabs · Modellgröße vs. Speicherquote einer PWA · Lizenzlage der Modelle · Web-STT möglicherweise nicht lokal.
