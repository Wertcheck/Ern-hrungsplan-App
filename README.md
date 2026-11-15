# Ernährungsplan – persönlicher Ernährungsplaner (PWA)

Lokale, responsive Progressive Web App (React + TypeScript + Vite + Tailwind). Alle Daten bleiben im Browser (localStorage); es gibt kein Backend, keine Konten, kein Tracking.

## Start
```bash
npm install
npm run dev        # Entwicklung, http://localhost:5173 (auch im LAN erreichbar → Smartphone)
npm run build && npm run preview   # Produktions-Build, http://localhost:4173
npm test           # Vitest
npm run typecheck
```
Auf Android: Seite im Chrome öffnen → Menü → „Zum Startbildschirm hinzufügen“. Für den Zugriff vom Handy muss die App über HTTPS oder `localhost` erreichbar sein, damit der Service Worker (Offline-Cache) aktiv wird.

## Architektur
- `src/domain/` – reine Logik, UI-unabhängig und getestet: `nutrition` (Kalorien/Makros, Mifflin-St-Jeor), `rules` (Allergien, Ausschlüsse, Stile, Öle), `planner` (Planung + Bewertung), `planops` (Austauschen/Löschen/Ergänzen), `shopping`, `schemas` (zod).
- `src/data/` – Lebensmittel (~100) und Rezepte (~50).
- `src/pages/`, `src/ui/`, `src/store.tsx` – Oberfläche und lokaler Zustand.

## Technische Entscheidungen
- **Kein FastAPI/SQLite**: Einzelnutzer, lokal → ein Backend wäre unnötige Infrastruktur. Persistenz via localStorage mit zod-validiertem Laden/Import; Export/Import/Vollständiges Löschen in den Einstellungen.
- **Planungsalgorithmus** (deterministisch, nur minimaler seed-basierter Tie-Breaker): Pro Tag und Mahlzeit werden zulässige Rezepte bewertet (Kalorienpassung, Präferenzen/Favoriten, Stil-Passung, Makroverteilung, Wiederholungsstrafe, gleiche Hauptzutat am Vortag, Mitnutzen frischer Zutaten gegen Verschwendung, seltene Zutaten). Portionsfaktoren (0,6×–1,8×, 0,05er-Schritte) werden pro Tag feinjustiert. `analyzePlan` liefert einen Score (Kalorien 30 %, Makros 15 %, Präferenzen 20 %, Vielfalt 15 %, Wiederholungen 10 %, Verfügbarkeit 10 %) und transparente Hinweise, wenn Ziele nicht erreichbar sind.
- **Allergien**: Allergie = Ausschluss auch bei unbekannter Allergeninfo; Unverträglichkeit = Ausschluss markierter Lebensmittel. Rezepte mit Zutaten ohne Allergeninfo werden nie als allergenfrei dargestellt. Bestehende Pläne werden bei geänderten Regeln auf Verstöße geprüft und markiert.
- **Öle** sind Platzhalter in Rezepten (`oil:warm`/`oil:cold`) und werden anhand Hauptöl, Zuordnung, Hitzeeignung, Ausschlüssen und Allergien aufgelöst; sie fließen vollständig in Kalorien und Einkaufsliste ein.
- **Basische Ernährung** ist nur ein Ernährungsstil (Gemüse/Obst/Kräuter/Hülsenfrüchte bevorzugt); keine pH-Aussagen.

## Datenquelle und Lizenz
Nährwerte sind gerundete Richtwerte in Anlehnung an USDA FoodData Central (Public Domain / CC0) und **nicht einzeln gegen die Quelle verifiziert** (`verified: false`). Eigene/geänderte Werte gelten nie als verifiziert. Allergen-/Histamin-/Fruktose-Tags sind Näherungen ohne Spurenangaben.

## Bekannte Einschränkungen / offen
- Keine echten Lebensmittelfotos (Emoji-Kacheln, da keine lizenzfreien Bilder offline verfügbar).
- Lebensmitteldatenbank klein (~100 Einträge), kein Import externer Datenbanken (z. B. BLS/Open Food Facts) – Datenmodell ist erweiterbar.
- „Öle bestimmten Zubereitungsarten zuordnen“ ist auf warm/kalt beschränkt.
- Mikronährstoffe sind im Datenmodell vorgesehen, aber nicht befüllt.
- Ab ca. 2.800+ kcal bei 3 Mahlzeiten wird die Portionsgrenze erreicht (wird im Plan als Warnung angezeigt).
- Backups nur manuell (JSON-Export); localStorage-Limit ca. 5 MB.
- Keine optionale KI-Integration.
