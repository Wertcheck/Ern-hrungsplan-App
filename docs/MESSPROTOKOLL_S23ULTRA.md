# Messprotokoll Galaxy S23 Ultra (Phase 2/3)

Zweck: Belastbare Gerätedaten für die Entscheidung *lokales LLM im Browser (PWA)* vs. *native Hülle*, und *Spracherkennung offline vs. Cloud*.
**Ich (Claude) kann auf dem Gerät nicht messen.** Alles unten ist von dir zu erheben; bis dahin gilt in allen Berichten „nicht gemessen“.

## Schritt 1 – Handbefunde (1 Minute)
| Feld | Wo ablesen |
|---|---|
| Arbeitsspeicher gesamt (8 oder 12 GB) | Einstellungen → Über das Telefon → Informationen zur Hardware |
| freier Speicher | Einstellungen → Gerätewartung → Speicher |
| Android-/One-UI-Version | Einstellungen → Über das Telefon → Softwareinformationen |
| Chrome-Version | Chrome → ⋮ → Einstellungen → Über Chrome |
| Akkustand vorher / nachher | Statusleiste |

## Schritt 2 – Probe-Seite (5 Minuten)
1. App/Vorschau im **Chrome** auf dem S23 öffnen, dann `…/probe.html` aufrufen (kein Login, keine Netzanfragen, kein Modell-Download).
2. „1. Fähigkeiten prüfen“ → „2. Rechentest“ → optional „3. Mikrofon-Test“ (fragt nach Mikrofonerlaubnis; nimmt nichts auf, misst nur Pegel).
3. „Ergebnis kopieren“ oder „Als Datei speichern“ und mir das JSON zurückgeben (enthält keine persönlichen Daten außer User-Agent/Gerätemodell).

## Was daraus entschieden wird
| Befund | Konsequenz |
|---|---|
| `webgpu.adapter` vorhanden **und** `shaderF16` true | Browser-LLM (WebLLM/WebGPU) mit ~1–3B-Modell (4-Bit) ist prototypisierbar |
| WebGPU fehlt, `wasm.simd` true | nur kleine Modelle per WASM (langsam); native Hülle bevorzugen |
| `crossOriginIsolated` false | WASM-Threads nicht nutzbar, ohne dass der Host COOP/COEP-Header setzt (bei statischem Hosting oft nicht möglich) |
| `allocatedMB` < 256 / `allocError` | Browser-Speicherlimit zu knapp für Modelle > ~1 GB |
| `speech.recognitionApi` true | Web-Spracherkennung nutzbar – aber **Cloud** (Google), nicht lokal; offline nicht belegt |
| `speech.voices` mit `localService:true` (de) | lokale TTS ohne Netz denkbar |
| RAM 8 GB | Modelle > ~2–3 GB realistisch nicht empfehlenswert (Hypothese, ungemessen) |

## Schritt 3 – (später, nach Entscheidung) Modelllauf
Erst wenn Schritt 2 es zulässt und du zustimmst: Prototyp-Seite lädt **ein** Modell (Größe vorher genannt, Download nur im WLAN), misst Ladezeit, Tokens/s, Antwortlatenz für 5 feste deutsche Testbefehle, Akku/Temperatur. Ergebnisformat wird vorab festgelegt. **Keine Modellwahl ohne diese Zahlen.**
