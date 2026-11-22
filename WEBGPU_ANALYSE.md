# WebGPU-/WebLLM-Fehleranalyse Samsung Galaxy S23 Ultra

Stand: 2026-11-22. Nichts hiervon ist „freigegeben“. Quellen strikt getrennt: **[Code]** = aus dem Quelltext von `@mlc-ai/web-llm` 0.2.88 abgeleitet · **[Entwicklungsrechner]** = hier gemessen (Chromium mit Software-GPU, *nicht* das S23) · **[S23 gemessen]** = von mir ausgewertete Messdateien des Geräts (`llm-bench-s23_3/_4.json`) · **[Nutzerangabe]** = von dir berichtet, die Datei `llm-bench-s23 (5).json` liegt mir **nicht** vor (siehe Abschnitt 9) · **[Hypothese]**.

## 1. Eingangsdaten
| Angabe | Quelle |
|---|---|
| Adreno 7xx, WebGPU vorhanden, `shader-f16` und `subgroups` werden gemeldet, `maxStorageBufferBindingSize` 128 MiB, `maxBufferSize` 2 GiB, `crossOriginIsolated=false`, `deviceMemory` 8 (Browserwert, gedeckelt) | [S23 gemessen] (Probe-Datei) |
| Llama/Qwen laden aus dem Cache in ≈ 5–8 s; Inferenz Qwen 1.5B (Q4, f16, Hauptthread): 0,50 tok/s Decode, 2 Aufrufe erfolgreich (Ausgabe `OK Xu zh`), 3. Aufruf `mapAsync … unmapped`; Llama schon im Kontrollaufruf `mapAsync … unmapped` | [S23 gemessen] (`_4`) |
| F32-Matmul ≈ 47 GFLOPS, 200 Readbacks fehlerfrei, F16-Pipeline scheitert, `VK_ERROR_UNKNOWN`, `A valid external Instance reference no longer exists` | [Nutzerangabe] (Datei (5) nicht erhalten) |

## 2. Ursachenanalyse (Phase 1)
**2.1 WebLLM 0.2.88 und Laufzeit [Code].** 0.2.88 hängt von einem separaten **Entwicklungs-Build** `@mlc-ai/web-runtime 0.28.0-dev2` sowie `web-xgrammar 0.1.27` und `web-tokenizers ^0.1.6` ab; die Versionen 0.2.79/0.2.82 bringen die Laufzeit selbst mit (nur `loglevel` als Abhängigkeit). Es existiert bereits 0.2.89. Der Wechsel ist ein relevanter Unterschied zwischen den Versionen; ob er hier eine Rolle spielt, ist **offen**. Der Benchmark erlaubt jetzt die Versionswahl (0.2.79 / 0.2.82 / 0.2.88 / 0.2.89).

**2.2 Gerät und f16 [Code].** Die Laufzeit fordert beim `requestDevice` **immer** `shader-f16` und `subgroups` an, sobald der Adapter sie *meldet* („Always require f16 if available“), auch für f32-Modelle, und setzt erhöhte Limits (u. a. 10 Storage-Buffer pro Stage, 32 KiB Workgroup-Speicher). Die `q4f16`-Modelle verlangen `required_features: ["shader-f16"]`, die `q4f32`-Modelle nicht. **[Hypothese]:** Meldet der Adapter f16, die f16-Pipeline schlägt aber im Treiber fehl (so die Nutzerangabe), kann kein `q4f16`-Modell laufen; ein `q4f32`-Modell könnte laufen, wenn das Gerät mit den angeforderten Features überhaupt stabil bleibt. Der neue Stufentest A prüft das getrennt (Gerät ohne Features / nur f16 / exakt wie WebLLM, jeweils f32 **und** f16 mit Korrektheitsprüfung und allen drei Fehler-Scopes).

**2.3 GPU-Buffer-/Device-Lebenszyklus [Code].** `tryCreateBuffer` fängt jeden Fehler bei `createBuffer` ab und ruft dann **`device.destroy()`** auf („wir behandeln jeden Fehler als fatal“). `destroy()` hebt laufende `mapAsync`-Aufrufe auf – genau die Meldung `Buffer was unmapped before mapping was resolved`. **[Hypothese, gut vereinbar mit den Daten]:** Ein Fehler beim Anlegen eines Puffers (Speicher-/Treiberfehler) zerstört das Gerät; alle weiteren Aufrufe scheitern (`Object has already been disposed`). Der neue **GPU-Spy** protokolliert jeden `device.destroy()` mit Aufrufstapel, `device.lost` (Grund + Browsermeldung), alle `popErrorScope`-Fehler und `console.error`. Damit lässt sich die Hypothese auf dem Gerät belegen oder widerlegen.

**2.4 `A valid external Instance reference no longer exists` [Code].** Diese Meldung steht **nicht** im WebLLM-Quelltext. Sie stammt aus Chromes WebGPU-Implementierung (Dawn) und bedeutet, dass die zugrunde liegende GPU-Instanz nicht mehr existiert – typisch nach Verlust des GPU-Prozesses/Kontexts. Sie ist also ein Folgesymptom eines Fehlers *unterhalb* von WebLLM, nicht dessen Ursache.

**2.5 Vulkan/Adreno [offen].** `VK_ERROR_UNKNOWN` ist ein unspezifischer Treiberfehler. Ob er durch f16-Kernel, Speicherdruck, die angeforderten Limits oder einen Chrome-/Treiberfehler entsteht, ist **nicht entscheidbar**; ich behaupte keinen Treiberfehler. Die Stufentests grenzen es ein (siehe 3).

**2.6 Worker, CSP, Blob, Modulauflösung [Entwicklungsrechner, echter web-llm-Code].** Auf einer Seite mit `file://`-Herkunft:
| Variante | Ergebnis |
|---|---|
| klassischer Worker aus Blob, ohne Import | **läuft** |
| Modul-Worker aus Blob, ohne Import | **startet nicht** (leeres Fehlerereignis) |
| Modul-Worker aus Blob mit `import` des CDN | startet nicht |
| klassischer Worker aus Blob mit `import()` des CDN (try/catch) | **läuft**, WebLLM (35 Exporte) importiert |
| Modul-Worker aus `data:`-URL | läuft, aber **ohne CacheStorage** (`SecurityError … 'caches'` bei der Modellinitialisierung) → für WebLLM unbrauchbar |
| Modul-Worker aus lokaler Datei | nur über http(s) möglich, nicht aus `file://` |
Damit ist der bisherige Fehler „Blob-Modul-Worker startet nicht“ als **Herkunfts-/Blob-Problem der Seite** erklärt, nicht als WebLLM-Fehler; die Worker-Fabrik probiert jetzt zuerst klassischer Blob-Worker + dynamischem Import, dann Modul-Blob. Ob das auf dem S23 genauso ist, zeigt Stufentest B (Umgebung `protocol/origin` wird mit protokolliert). Eine CSP-Konfiguration gibt es in dieser Seite nicht (kein `<meta>`-CSP); HTTP-Header-CSP lassen sich aus der Seite nicht lesen.

**2.7 CDN und Cache [S23 gemessen].** Die Bibliothek lädt in ≈ 0,1–0,2 s vom CDN; Modelle liegen im Cache (`cachedBeforeLoad: true`, 1531 MB Belegung). Die `q4f32`-Downloads schlugen mit `Cache.add() … network error` / `Failed to fetch` fehl (Netz, nicht Modell). Lokale statt CDN-Dateien: **nicht umgesetzt** – sinnvoll erst, wenn die App über http(s) ausgeliefert wird (dann auch same-origin-Worker, W7).

**2.8 Engine-Wiederverwendung nach GPU-Fehlern [S23 gemessen + Code].** Nach dem ersten Fehler scheitern alle Folgeaufrufe, auch `unload` + Neuaufbau im selben Hauptthread (`Tokenizer instance already deleted`, `GrammarMatcher instance already deleted`). WebLLM stellt sich nicht selbst wieder her. Zusätzlich: Ein WebGPU-Adapter ist nach `requestDevice` **verbraucht** (Spezifikation; im Entwicklungsrechner reproduziert: *„adapter is consumed“*) – eine Neuinitialisierung muss einen frischen Adapter holen. **[Hypothese]:** Der im Hauptthread geteilte WASM-Zustand (Tokenizer/Grammatik) bleibt nach dem Fehler beschädigt; nur ein frischer Worker oder eine frische Seite hilft.

## 3. Isolierte Tests (Phase 2) – implementiert, **auf dem S23 noch nicht gelaufen**
Das Messwerkzeug `llm-bench.html` bzw. die Einzeldatei hat vier voneinander unabhängige Stufen; jede schreibt ihr eigenes Ergebnis:
- **A. GPU-Basis (Button 4):** drei Geräte-Varianten (ohne Features / nur f16 / wie WebLLM) × f32/f16 (256² und 1024², exakte Korrektheitsprüfung, Shader-Compilerfehler, alle Fehler-Scopes), wiederholte Geräte-Initialisierung ×6 (mit frischem Adapter). Ergänzend Button 3: Readback ×200, Durchsatz, Dauerlast 20 s.
- **B. Worker (Button 4):** W1–W7 wie in 2.6, mit Fehlerdetails und Seitenumgebung.
- **C. Modelllaufzeit (Buttons 1 und 5):** Initialisierung → Smoke (einfache Generierung) → Prompt-Modus → Grammatik, immer in frischer Seite je Konfiguration; JSON/Grammatik erst nach bestandenem Smoke.
- **Abnahmetest (Button 5, Phase 6):** S1 Initialisierung · S2 **zehn** aufeinanderfolgende Aufrufe · S3 strukturierte Ausgabe (Prompt) und S3b Grammatik · S4 gezielt ausgelöster Fehler → kontrolliert gemeldet **und** anschließend wieder nutzbar · S5 erneute Initialisierung + 3 Aufrufe; dazu Hardwarewerte (Ladezeit, Tokens/s, Akku, JS-Heap/Storage). Der Gesamterfolg wird **nur aus gemessenen Feldern** berechnet; ohne Erfüllung aller sechs Kriterien gilt kein Modell als bestanden.
- Der **GPU-Spy** läuft in allen Stufen mit und hängt seine Ereignisse an jedes Ergebnis.
Im Entwicklungsrechner (Software-GPU) laufen A und B durch (f32-Korrektheit, Readback, Wiederholinitialisierung, Worker-Befunde aus 2.6); der f16-Pfad ist dort **ungeprüft**, weil die Software-GPU kein `shader-f16` kennt. Ergebnisse dieser Stufen sagen **nichts** über das S23.

## 4. Alternative PWA-Konfigurationen (Phase 3)
Umgesetzt (alles wählbar, nichts erfunden): **WebLLM-Version** 0.2.79 / 0.2.82 / 0.2.88 / 0.2.89 (CDN, fest gepinnt); **q4f32-Modelle** (Llama 1B ≈ 1,1 GB, Qwen 1,5B ≈ 1,9 GB) neben `q4f16`; Worker-Varianten aus 2.6. **Nicht umgesetzt:** lokal gebündelte Laufzeit-/Worker-Dateien (erst bei http(s)-Auslieferung sinnvoll), alternative Backends/Flags (WebLLM bietet für WebGPU keine dokumentierte Backend-Alternative; ich ergänze keine). Die f16-Option wird nur genutzt, wenn der Stufentest A f16 als korrekt ausweist – das entscheidet die Auswertung, nicht der Adapter.

## 5. Engine-Stabilität (Phase 4) – implementiert, automatisiert getestet (Fake-Engine)
`LlmEngineHost` (siehe `LLM_PROTOTYP_BERICHT.md`): eindeutiger Lebenszyklus, keine parallelen Läufe, Abbruch/Zeitlimit, Wiederherstellung (resetChat+Probe → Entladen/Neuaufbau, max. 2 in Folge), Freigabe mit gesammelten Fehlern; neu: **Worker beenden = vollständige Freigabe** (WASM-Zustand + GPU-Gerät), Phasenprotokoll, Ladeüberwachung. Offen: ob der Neuaufbau *auf dem Gerät* nach einem echten GPU-Fehler gelingt – genau das prüft Abnahmetest S4/S5.

## 6. Plattformvergleich (Phase 5) – **nicht begonnen**
Bedingung des Auftrags („erst wenn die PWA-Fehler ausreichend untersucht sind“) ist noch nicht erfüllt: Die neuen Stufentests und der Abnahmetest haben auf dem S23 noch nicht gelaufen. Vorgesehen danach (nur Prototyp, keine Migration): kleine Capacitor-Hülle mit einer nativen Inferenzbibliothek; Kandidaten wären u. a. llama.cpp (CPU, GGUF) oder Googles MediaPipe-/LiteRT-LLM-Laufzeit – **Eignung, Modellformate und Plugin-Reife sind von mir nicht geprüft** und vor dem Bau zu verifizieren. Vergleichskriterien: Inferenzfähigkeit, Stabilität (zehn Aufrufe, Fehlerbehandlung, Neustart), RAM, Ladezeit, Akku, Wartbarkeit, Integrationsaufwand – mit denselben 14 Testfällen wie die PWA.

## 7. Abnahmekriterien (Phase 6)
Ein Modell gilt erst als erfolgreich getestet, wenn alle sechs Kriterien im Abnahmetest `true` sind (Initialisierung, **10** Aufrufe in Folge, strukturierte Ausgabe, kontrollierter Fehler mit anschließender Nutzbarkeit, Neuinitialisierung, dokumentierte Hardwarewerte). **Stand: kein Modell erfüllt das; auf dem S23 wurde bisher kein Abnahmetest ausgeführt.**

## 8. Offene Risiken
1. f16-Pipeline und `VK_ERROR_UNKNOWN`: Ursache nicht bestimmt; Nutzerangaben nicht von mir verifiziert (Datei fehlt).
2. WebLLM 0.2.88 nutzt einen Entwicklungs-Build der Laufzeit; ältere Versionen ungetestet.
3. Hauptthread-Betrieb ist nach einem GPU-Fehler nicht wiederherstellbar; Worker-Betrieb auf dem S23 ungetestet (Herkunft der Seite unbekannt).
4. 0,5 tok/s und fehlerhafte Ausgabe (`OK Xu zh`): Ursache offen (f16-Numerik, Drosselung, Speicher?).
5. Die lokale KI ist nicht in die App verdrahtet; die PWA und die Regel-Erkennung (Tier 0, 14/14) bleiben unverändert nutzbar.

## 9. Fehlende Datei
`llm-bench-s23 (5).json` ist nicht angekommen (neueste empfangene Datei: `llm-bench-s23_4.json`, bereits ausgewertet). Die Angaben F32 ≈ 47 GFLOPS, 200 Readbacks, f16-Fehler und `VK_ERROR_UNKNOWN` sind deshalb als **[Nutzerangabe]** gekennzeichnet. Bitte Datei erneut anhängen; ich gleiche sie dann mit der Analyse ab.
