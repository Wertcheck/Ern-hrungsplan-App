# BLS-4.0-Integration

## Herkunft und Version
- **Bundeslebensmittelschlüssel (BLS), Version 4.0**, Max Rubner-Institut (MRI), Karlsruhe. Stand Dokumentation: Dezember 2025.
- Download-Seite: <https://www.blsdb.de/download> (offen, **ohne Schlüssel/Registrierung**; der Link trägt ein öffentliches Seiten-Token).
- Archiv `BLS_4_0_2025_DE.zip`, 14.263.306 Bytes, **SHA-256 `12b7a6ba62807ec9b301eb276f897dc85f99b2292311618dec3749a12d984c91`** (festgeschrieben in `scripts/bls/SOURCE.json`), abgerufen 2026-11-15.
- Inhalt: `BLS_4_0_Daten_2025_DE.xlsx` (7.140 Lebensmittel × 138 Nährstoffe), `BLS_4_0_Components_DE_EN.xlsx` (Komponenten/Formeln), `BLS_4_0_Dokumentation_DE.pdf` (24 S.).
- DOI: 10.25826/Data20251217-134202-0.

## Lizenz und Quellenangabe
**CC BY 4.0** (<https://creativecommons.org/licenses/by/4.0/deed.de>). Pflicht: Namensnennung des MRI als Herausgeber. Zitierweise (wird in der App unter *Meine Lebensmittel → BLS-Datenbank* und *Einstellungen* angezeigt):
> Max Rubner-Institut (2025): Bundeslebensmittelschlüssel (BLS), Version 4.0 — Deutsche Nährstoffdatenbank. Karlsruhe. DOI: 10.25826/Data20251217-134202-0

Änderungen: Werte wurden normalisiert (siehe unten) und teilweise einem App-Lebensmittel zugeordnet; das Original bleibt unverändert im Archiv. Die App ist keine Veröffentlichung des MRI.

## Datenanalyse (tatsächlich ermittelt)
- 1 Tabellenblatt; Spalte A `BLS Code` (Format `[A-Z][0-9A-Z]{6}`, z. B. `C133000`; einzelne Codes enthalten Buchstaben), B deutscher, C englischer Name; danach je Nährstoff 3 Spalten *Wert · Datenherkunft · Referenz* (`CODE Name [Einheit/100g]`). Werte gelten **pro 100 g essbarem Anteil**.
- 7.140 eindeutige Codes, keine doppelten Namen. Erster Buchstabe = Hauptgruppe (B Brot … Y Gerichte, 20 Gruppen).
- **Kohlenhydrate (`CHO`) = verfügbare Kohlenhydrate ohne Ballaststoffe** → in der App einheitlich so geführt (Rechenschritt für Nicht-BLS-Richtwerte: Kohlenhydrate − Ballaststoffe).
- Sonderwerte: `-`/leer = **fehlend (≠ 0)**, `TR` = Spuren, `<LOD`/`<LOQ` = unter Nachweisgrenze.
- Abdeckung (von 7.140): Energie 100 %; Fett 3 fehlend; Ballaststoffe 14; Calcium 14; Magnesium 18; Kalium 16; Eisen 22; Zink 59; Vitamin A (RAE) 6; B12 95; C 164; D 136; E 152; Folat 4.
- Energie folgt der BLS-Formel (inkl. Alkohol, organische Säuren, Polyole); deshalb weichen 84 Einträge (überwiegend Alkoholika) von der einfachen Atwater-Plausibilität ab.

## Importprozess (reproduzierbar)
```
pip install -r scripts/bls/requirements.txt
python scripts/bls/bls_import.py --download            # oder --zip BLS_4_0_2025_DE.zip
python -m pytest scripts/bls/test_bls_import.py
```
1. Seite abrufen, Download-Link extrahieren, **nur freigegebene Hosts** (`www.blsdb.de`, `blsdb.de`).
2. Archiv prüfen: Größenlimit, ZIP-Test, **SHA-256 gegen `SOURCE.json`** (Abweichung = Abbruch, neue Version nur mit `--accept-new-hash`), unsichere Pfade/ausführbare Endungen = Abbruch. **Es wird nichts entpackt oder ausgeführt**; die XLSX wird aus dem ZIP gelesen.
3. Tabelle prüfen (Kopfzeile, Einheiten je Spalte, Codeformat, keine Dubletten, keine negativen Werte).
4. Normalisieren: kcal ganzzahlig, sonst 4 signifikante Stellen; Sonderwerte gemäß Dokumentation; `flags` je Wert (`t`, `l`, `m`).
5. Ausgabe: `src/data/bls/bls40.json` (vollständig, 1,25 MB / 413 KB gzip, eigener Lazy-Chunk) und `mapped.json` (Zuordnung `scripts/bls/mapping.json`, 99 Einträge, **manuell geprüft**).
Zweiter Lauf liefert **byte-identische** Dateien (geprüft).

## Datenstruktur in der App
`Food`: `sourceRef {name, id=BLS-Code, license, retrieved}`, `dataQuality` (`verified` = unverändert aus BLS · `reference` = Richtwert · `user` · `missing`), `prep`, `group`, `micros{calcium,magnesium,kalium,eisen,zink,vitaminA,vitaminB12,vitaminC,vitaminD,vitaminE,folat}`, `missingFields` (fehlende Quellwerte, im Modell 0, in der UI „keine Daten“). Versionierung: `meta.json`-Felder in `bls40.json`/`mapped.json` (Version, SHA-256, DOI, Importer-Version); `BUILTIN_DATA_VERSION` frischt gespeicherte Standarddaten auf.

## Integration
- **99 von 108 Standard-Lebensmitteln** nutzen **ausschließlich** BLS-Werte (keine Vermischung mit anderen Quellen; fehlt ein BLS-Wert, bleibt er fehlend). Nicht zugeordnet (Richtwert): Speck, Kurkuma, Zimt, Kreuzkümmel, Paprikapulver, Avocadoöl, Wasser, grüner Tee, Kaffee.
- Namen wurden dem BLS-Eintrag angepasst, wo er abweicht (z. B. „Rinderhackfleisch (roh)“ statt „mager“ – BLS: 224 kcal statt 137).
- **Suche/Filter**: Volltext (Umlaut-/ß-/ue-tolerant, Zusammenschreibung „Haferflocken“ = „Hafer Flocken“), Filter Gruppe/Zustand/„nur Grundlebensmittel“, <500 ms für 20 Abfragen (Test).
- **Übernahme** legt eine Kopie an (keine Dubletten pro BLS-Code); bestehende und eigene Lebensmittel werden nie überschrieben (Migration ersetzt nur eingebaute Standarddaten).
- **Allergene**: BLS hat keine. Übernommene Einträge = „Allergene unbekannt“ (bei Allergie ausgeschlossen). Herkunft (vegan/vegetarisch) wird konservativ abgeleitet; Zusammengesetztes ist „unbekannt“ und gilt nie als vegan/vegetarisch/carnivore.

## Qualitätssicherung
- Stichprobe: 400 zufällige Lebensmittel × 10 Nährstoffe (4.000 Werte) gegen die Original-XLSX: **0 Abweichungen**.
- Tests: 10 pytest (Importer, inkl. Archiv-/Pfad-/Hostprüfung), 19 Vitest (Integrität, im Original geprüfte Werte, Mapping-Konsistenz, Suche, Umwandlung, Sicherheit). Regression: gesamte Planer-/Engine-Suite grün.
- Auswirkung: Haferflocken 372→348 kcal, Olivenöl 884→899 kcal/100 g usw. Planergebnisse bleiben ±0,8 % am Ziel.

## Bekannte Einschränkungen
BLS ohne Allergene; Alkohol-/Säureenergie nicht in einfacher Atwater-Formel; Gruppenbeschriftungen sind App-seitige Zusammenfassungen; Zubereitungszustand wird aus dem Namen abgeleitet; Mikronährstoffe sind Rohwerte ohne Zubereitungsverluste; nur Deutsch/Englisch-Namen.

## Aktualisierung
Neue Version: Seite prüfen (Lizenz!), `SOURCE.json` (Version, Hash, Dateien, Zitat) anpassen, `--download --accept-new-hash`, `mapping.json` prüfen (Codes können sich ändern – der Import bricht bei unbekannten Codes ab), `BUILTIN_DATA_VERSION` erhöhen, Tests laufen lassen.
