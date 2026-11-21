# LLM-Prototyp: Fehleranalyse, strukturierte Ausgabe, Benchmark-Stand

Stand: 2026-11-16. Strikte Trennung: **implementiert** · **automatisiert getestet** · **auf dem echten S23 Ultra getestet**. Nichts davon ist „freigegeben“.

## 1. Fehlerursachen

### Fehler 1 – `Failed to initialize the grammar matcher for response format json_object: Cannot pass non-string to std::string`
| | |
|---|---|
| Ursache (gesichert) | Der Prototyp sendete `response_format: {type:'json_object'}` **ohne `schema`**. `@mlc-ai/web-llm` 0.2.88 ruft dafür in `prepareGrammarMatcherForSampling` intern `grammarCompiler.compileJSONSchema(responseFormat.schema, …)` mit `undefined` auf. Der C++-Parameter (xgrammar 0.1.27) ist ein `std::string` → die WASM-Bindung lehnt `undefined` ab. Die Dokumentation der Bibliothek beschreibt schemaloses `json_object` als gültig – im Code von 0.2.88 funktioniert es aber nicht. |
| Nachweis | Quellcode-Analyse **und Reproduktion in Node** (`scripts/repro-xgrammar-bug.mjs`, gleiche xgrammar-Version): schemaloser Aufruf → exakt dieselbe Fehlermeldung (jedes Mal); Aufruf mit Schema-String → Grammatik und Matcher werden erzeugt. |
| Nicht die Ursache | Modell (Llama und Qwen scheitern identisch), Tokenizer, Quantisierung, Gerät/WebGPU (der Grammatik-Teil ist reines WASM). |
| Lösung | Grammatik nur **mit Schema-String** anfordern (`LLM_JSON_SCHEMA`); ohne Schema wird *kein* `response_format` gesendet. Dass das **auf dem S23** funktioniert, ist noch **nicht gemessen** (siehe 5). |

### Fehler 2 – `The current Object has already been disposed` (ab dem 3. Test)
| | |
|---|---|
| Ursache | **Nicht eindeutig geklärt.** Gesichert: Es ist ein Folgefehler des ersten Fehlers (er tritt nie ohne ihn auf; Test 2 liefert noch den Grammatikfehler, ab Test 3 „disposed“). Die Meldung stammt aus der TVM-Laufzeit (`typeIndex()` auf ein bereits freigegebenes Objekt) – kein xgrammar-Objekt: Im Node-Test bleibt der `GrammarCompiler` nach den Fehlern weiter nutzbar. |
| Beobachtung im Quellcode | `asyncGenerate` setzt bei einem Fehler im Prefill `prefilled=false`; dann wird weder `triggerStop()` aufgerufen noch der Chat-Zustand zurückgesetzt (`resetChat`). Der Engine-Zustand (KV-Cache-Länge, Konversation) bleibt nach dem abgebrochenen Prefill unbereinigt. Ob genau das die „disposed“-Objekte erzeugt, ist **Hypothese**. |
| Konsequenz | Die App darf sich nicht darauf verlassen, dass eine Engine nach einem Fehler benutzbar ist. Der Engine-Host behandelt **jeden** Engine-Fehler als Beschädigung und stellt vor der nächsten Anfrage wieder her (siehe 2). Der Geräte-Ursachentest in `llm-bench.html` („Fehlerinjektion“) misst, *welcher* Weg wirklich hilft (nur Retry / `resetChat` / Entladen+Neuladen / Host-Automatik). Ergebnis: **ausstehend**. |

Zusätzlich gefunden und behoben (nicht Teil der gemeldeten Fehler): Der Service Worker überschrieb bei **jeder** Seitennavigation die zwischengespeicherte App-Hülle – auch beim Öffnen von `probe.html`/`llm-proto.html`. Offline hätte die App dann die Messseite gezeigt. Jetzt werden eigenständige `.html`-Werkzeugseiten durchgereicht, nicht gecacht (SW v5).

## 2. Änderungen (implementiert)
- `src/ai/local/llmAction.ts` – Aktionsschema (Zod, strikt) + JSON-Schema für die Grammatik, Systemprompt, **strenger Parser** (genau ein JSON-Objekt, optional ein Codeblock; Prosa/Arrays/mehrere Objekte/unbekannte Felder/falsche Typen/Wertebereiche → verworfen), Auflösung in Engine-Befehle. Das Modell wählt nur eine **Absicht**; es rechnet nicht (`delta_kcal`, `day_offset` statt Summen/Datumsarithmetik) und kennt keine IDs.
- `src/ai/local/runner.ts` – `interpret()`: begrenzte Wiederholung (max. 3, Standard 2) **nur** bei unbrauchbarer Ausgabe, mit Fehlertext als Rückmeldung; Engine-Ablehnungen (Grenzen/Konflikte) werden nicht wiederholt. Das Ergebnis enthält nur Befehle + Aktionsklasse; ausgeführt wird nichts. Ungültig ⇒ `rejected`, nie eine Aktion.
- `src/ai/local/host.ts` – `LlmEngineHost`: Zustände, Sperre gegen parallele Läufe, Abbruch (AbortSignal, Zeitlimit – greift auch bei hängender Engine), `resetChat` nach Abbruch, automatische Wiederherstellung (resetChat+Probelauf → Entladen+Neuladen, max. 2 Versuche in Folge), Ressourcenfreigabe mit gesammelten Fehlern, verständliche deutsche Meldungen.
- `src/ai/local/webllmAdapter.ts` – WebLLM-Anbindung (Version fest, nur per CDN-Import für das Messwerkzeug; **nicht** in die App eingebaut). Schemaloses `json_object` wird nie gesendet.
- `src/ai/local/cases.ts` – 14 gemeinsame, reproduzierbare Testfälle + `judge()`.
- `src/ai/nlu.ts` – nachgebessert, weil die 8 Testsätze Lücken zeigten: Ernährungsweise nur für „morgen/heute“ → Rückfrage (vorher stillschweigend ignoriert), „Entferne X aus meinen bevorzugten/Favoriten“, proteinreiche Austauschvorschläge (eiweißreichste zuerst), „wieder auf den bisherigen Wert“ (nur eindeutig → Rückgängig, sonst Rückfrage), Undo in Mehrfachsätzen.
- Benchmark: `llm-bench.html` + `src/bench/bench.ts` (gleicher Code wie die App); Einzeldatei per `node scripts/build-bench.mjs` → `dist-bench/llm-bench-standalone.html`. Die PWA ist unverändert nutzbar; die lokale KI ist **nicht** in die App verdrahtet.

## 3. Automatisiert getestet (nur Vitest/Browser-Smoke, ohne Modell)
- **287 Vitest** (vorher 243), neu `src/ai/local/local.test.ts` (44): alle 14 Testfälle durch die Regel-Erkennung; Parser (gültig/ungültig, 20+ Fälle); Auflösung; Host mit **Fake-Engine**: Laden/Beenden, parallele Aufrufe, Abbruch, Zeitlimit, Fehler → Wiederherstellung per `resetChat`, per Neuladen, erschöpfte Wiederherstellung, Cleanup-Fehler; Ablauf: Retry, Versuchsgrenze, erfundene Allergie-/Lösch-Aktionen verworfen, Engine-Ablehnung, Klassen A/B, Engine-Fehler → nächster Lauf funktioniert; „Idealmodell“ (skriptierte, korrekte Antworten) liefert für alle 14 Fälle das erwartete Ergebnis und **ändert nie den Zustand**.
- 140 pytest (unverändert), E2E `app` / `actions` / `ai` grün, Benchmark-Seite im Desktop-Browser: lädt, Regel-Baseline 14/14, WebLLM-Ladefehler (CDN hier gesperrt) sauber erfasst.
- **Grenze:** Die Fake-Engine beweist die Logik, **nicht** die Qualität eines echten Modells.

## 4. Testfälle (alle in `cases.ts`)
Originale sechs (4.000 heute · 2.800 dauerhaft · Proteinziel 180 g · Milch auf Einkaufsliste · „3000 kcal“ ohne Zeitbezug → Rückfrage · „Erkläre Keto“ → keine Aktion) und Folgeauftrag (2.800 kcal-Variante · „morgen vegetarisch“ → Rückfrage · „Milch aus bevorzugten entfernen“ → Rückfrage, *weil „Milch“ in der Standardliste nur Allergen-Kategorie ist*; Variante mit **Skyr** → Aktion · proteinreicher Abendessen-Tausch · „+300 heute“ → 2.500 · „wieder auf den bisherigen Wert“ mit/ohne vorherige Kalorienänderung).
Bewertet werden: Absichtserkennung, Parameter, gültiges JSON (erste Ausgabe / nach Retry), Aktionsklasse, Rückfrage bei fehlenden Angaben, **keine ungewollte Zustandsänderung**.

## 5. Auf dem echten S23 Ultra – bisher tatsächlich gemessen
| Messung | Ergebnis |
|---|---|
| Gerät | Snapdragon-Adreno-7xx-GPU, 8 GB RAM (Angabe des Nutzers), 8 Kerne, Chrome-Mobile; WebGPU mit `shader-f16`, `subgroups`; `maxBufferSize` 2 GiB, `maxStorageBufferBindingSize` 128 MiB; `crossOriginIsolated=false` (keine WASM-Threads); 256 MB am Stück allozierbar; Storage-Quota 10 GB |
| Llama 3.2 1B Q4 | lädt (Browser-Cache-Belegung ≈ 766 MB); Ladezeit 4,8–6,0 s – **aus dem Cache**, kein Download-Wert |
| Qwen 2.5 1.5B Q4 | lädt (Belegung gesamt 1519 MB); erste Ladezeit 151 s (inkl. Download, WLAN); später 6,1 s aus dem Cache |
| Funktionstests | 0/6 – **alle am Grammatikfehler (Fehler 1) bzw. dessen Folgefehler gescheitert**; damit **keine** Aussage zu Qualität, Latenz oder Tokens/s |
| Nicht gemessen | Zeit bis zum ersten Token, Gesamtlaufzeit, Tokens/s, korrekte Aktionen, Akku-Verlauf (Batterie 54–56 % vorher; Nachwerte ohne Lauf = unverändert, wertlos), Temperatur (nicht messbar: keine Schnittstelle, vom Nutzer bestätigt – wird nicht erhoben), GPU-/RAM-Verbrauch (im Browser nicht messbar) |

Die Zahlen aus dem früheren Bericht „Ladezeit 5–6,5 s“ sind folglich **Cache-Ladezeiten**; die ehrliche Erstladung ist nur für Qwen belegt (151 s).

## 6. Benchmark-Durchführung (offen: braucht dich)
1. `llm-bench-standalone.html` oder `/llm-bench.html` im Chrome des S23 öffnen (WLAN, Akkustand notieren).
2. **„2. Fehlerinjektion“** zuerst (≈ 2 Min.): zeigt Ursache 1 auf dem Gerät und welcher Wiederherstellungsweg funktioniert (Fehler 2).
3. **„1. Benchmark starten“**: beide Modelle × (Grammatik mit Schema | nur Prompt) × 14 Fälle (≈ 15–30 Min., Bildschirm an, Tab im Vordergrund).
4. Ergebnis-JSON zurückgeben. Pro Modell und Modus getrennt: Ladezeit (mit Cache-Hinweis), TTFT, Gesamtlaufzeit, Tokens/s, gültiges JSON (erste Antwort/nach Retry), korrekte Absicht/Parameter/Klasse, Akku vorher/nachher, JS-Heap/Storage; GPU-RAM und Temperatur sind „nicht messbar“ und bleiben es.

## 7. Plattformentscheidung (vorläufig – keine native Hülle gebaut)
Es gibt **noch keinen funktionierenden, reproduzierbaren PWA-Benchmark**; deshalb **keine Entscheidung** für Capacitor oder native Laufzeit. Heute belegt: WebGPU, f16 und das Laden beider Modelle funktionieren in der PWA. Offen und entscheidend: Inferenzgeschwindigkeit, Zuverlässigkeit der Grammatik (Schema-Modus) und Stabilität über viele Läufe. Eine native Laufzeit lohnt erst, wenn die PWA-Werte zu langsam/instabil sind oder Offline-Spracherkennung gebraucht wird (Web-Spracherkennung läuft auf Android-Chrome typischerweise über Server). Die PWA bleibt unverändert.

## 8. Offene Probleme
1. Fehler 2 (disposed): Ursache nur als Hypothese; Geräte-Ursachentest ausstehend. Ggf. Upstream-Meldung an web-llm (Schema-loses `json_object` in 0.2.88, fehlender Reset nach fehlgeschlagenem Prefill).
2. Modellqualität auf Deutsch (1B/1.5B, Q4): unbekannt – erste echte Messung steht aus.
3. Schema-Grammatik auf dem Gerät: ungetestet.
4. Die lokale KI ist nicht in Chat/Router verdrahtet (bewusst, bis die Zahlen vorliegen); Spracheingabe nicht begonnen.
5. Backend-Kontextschema/Cloud-Tools kennen die neuen Aktionstypen noch nicht (unverändert offen).
