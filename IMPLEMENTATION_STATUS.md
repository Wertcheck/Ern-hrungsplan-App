# Implementierungsstatus

Stand: 2026-11-15, Branch `claude/nutrition-planner-app-3ixfrf`.
Stufen: **I** implementiert · **A** automatisiert getestet (Vitest/pytest) · **B** im Browser geprüft (Playwright, Chromium) · **U** unabhängig geprüft (durch Dritte/echtes Gerät/echte Anbieter).
**Keine Funktion hat Stufe U** – es gab keine unabhängige Prüfung, kein echtes Android-Gerät und keine Live-Aufrufe echter KI-Anbieter.

| Bereich | I | A | B | Anmerkung |
|---|:-:|:-:|:-:|---|
| Profil, Kalorienziel (Mifflin-St Jeor, transparent) | ✓ | ✓ | ✓ | Untergrenze 1.200 kcal, max. ±10 % |
| Lebensmittelverwaltung (suchen/anlegen/ändern/löschen/Favorit/Ausschluss) | ✓ | ✓ | ✓ | |
| Lebensmittel-Datenmodell v2 (Gruppe, Zustand, Qualität, Spuren, Mikros, Quelle) | ✓ | ✓ | ✓ | |
| **BLS 4.0**: Import (reproduzierbar), 99 Standard-Lebensmittel, Volltext-Suche über 7.140 Einträge, Übernahme | ✓ | ✓ | ✓ | siehe `BLS_INTEGRATION.md` |
| Allergien/Unverträglichkeiten/Spuren, „Herkunft unbekannt“ | ✓ | ✓ | ✓ | keine Allergenfreiheits-Garantie |
| **12 Ernährungsweisen** als Registry + eigene Regeln + Konflikterkennung | ✓ | ✓ | ✓ | Carnivore, Vegan, Vegetarisch, Pescetarisch, Flexitarisch, Keto, Low Carb, High Protein, Paleo, Mediterran, Basisch, Mischkost |
| Öle/Fette (warm/kalt, Hauptöl, Ausschluss) | ✓ | ✓ | ✓ | |
| Planer v2 (Tageskombinationssuche + Portionslösung) | ✓ | ✓ | ✓ | siehe `ARCHITECTURE.md` |
| Pläne 7/14/21/30 Tage, Tag/Woche/Monat, Tausch, Löschen, Ergänzen, Portion | ✓ | ✓ | ✓ | |
| Rezepte (91 eingebaut), Portionsrechner, eigene Rezepte | ✓ | ✓ | ✓ | |
| Einkaufsliste (aggregiert, gruppiert, manuell, live) | ✓ | ✓ | ✓ | |
| Nährstoffbilanz (11 Mikronährstoffe + Ballaststoffe + Eiweiß), „Datenlage unzureichend“ | ✓ | ✓ | ✓ | Referenzwerte nicht gegen D-A-CH-Original verifiziert |
| Fortschritt (Gewicht, Einhaltung, Kalorien) | ✓ | – | ✓ | Berechnung nicht unit-getestet |
| Persistenz v2, Migration v1→v2, strenger Import, Löschen ohne Rückschreiben | ✓ | ✓ | ✓ | |
| PWA: Manifest, PNG-Icons, Precache-Service-Worker, Offline-Neuladen | ✓ | – | ✓ | Chromium-Desktop/-Mobile-Emulation, kein echtes Gerät |
| KI-Backend (FastAPI): OpenAI- + Anthropic-Adapter, Mock, Einstellungen, Kosten, Rate-Limit, Redaktion | ✓ | ✓ (140) | ✓ (Mock) | **echte Provider nie aufgerufen** |
| KI-Chat-UI (Sidebar/mobile Vollansicht), Streaming, Abbruch, Fehlerzustände | ✓ | ✓ | ✓ (Mock) | |
| Nutrition-Context (Datenminimierung), Datenvorschau, Einwilligung | ✓ | ✓ | ✓ | |
| Kontrollierte Aktionen (Vorschlag → Engine-Prüfung → Bestätigung → erneute Prüfung) | ✓ | ✓ | ✓ | |
| Lokaler Berater ohne KI (offline) | ✓ | ✓ | ✓ | |

## Nicht umgesetzt / offen
- **USDA-Verifizierung**: Zugriff durch die Netzwerkrichtlinie bzw. Berechtigungsprüfung blockiert; 9 Lebensmittel bleiben „Richtwert“ (Speck, Kurkuma, Zimt, Kreuzkümmel, Paprikapulver, Avocadoöl, Wasser, grüner Tee, Kaffee).
- **Lebensmittelfotografie**: nicht umgesetzt (keine lizenzgeprüfte Bildquelle erreichbar; es werden keine ungeprüften Bilder verwendet). Emoji-Kacheln bleiben.
- **Echte Anbieter-Tests, Kostenabgleich mit echter Abrechnung**: nicht durchgeführt (Schlüssel liegen auf deinem Rechner).
- **Android-Gerätetest**: nicht möglich (Cloud-Umgebung).
- **BLS-Allergene**: BLS enthält keine; Tags sind eigene Näherungen.
- **Git-Push**: HTTP 403 (GitHub-App nicht installiert), Commits liegen lokal.
- OpenAI-Preisliste leer (keine Preise erfunden); Kostenanzeige dann „nicht berechenbar“.
