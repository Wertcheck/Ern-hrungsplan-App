# KI-Datenschutz

## Grundsatz
Die App funktioniert vollständig ohne KI und ohne Datenübertragung. KI ist **Opt-in**: Backend-Einstellung „aktiviert“ (Standard aus) **und** deine Einwilligung im Chat/Einstellungen.

## Was wird übertragen (nur an dein lokales Backend, von dort an den gewählten Anbieter)
**Immer (Sicherheit):** Ernährungsweisen (Namen), eigene Regeln, Allergien/Unverträglichkeiten, Ausschlüsse, Kalorienziel, Makroanteile, Ernährungsziel, Mahlzeiten-/Personenzahl, deine aktuelle Frage und die letzten ≤ 12 Nachrichten.
**Nur bei Freigabe *und* passender Frage:** Plan-Ausschnitt (1–7 Tage) und zulässige Rezepte (Katalog ≤ 80, nur regelkonforme) · Lebensmittelpräferenzen/Öle · Alter/Größe/Gewicht · Einkaufsliste · Gewichtsverlauf · Nährstoffbilanz · Liste erlaubter Lebensmittel (nur bei Rezept-Erstellung).
**Nie:** Namen, E-Mail, Kontaktdaten, API-Schlüssel, Standort, Geräte-IDs.
Transparenz: Im Chat zeigt **„Daten“** den exakten JSON-Inhalt der nächsten Anfrage; die Einstellungen listen alle Freigaben.

## Speicherung
- Chatverlauf: nur lokal im Browser (max. 60 Nachrichten), löschbar („Neu“, Einstellungen, „Alle Daten löschen“).
- Backend-Ledger (`backend/data/usage.jsonl`): Zeit, Anbieter, Modell, Token, geschätzte Kosten – **kein Nachrichteninhalt**. Nachrichten werden nicht geloggt.
- Die Anbieter verarbeiten die Anfragen nach ihren eigenen Bedingungen (bitte dort prüfen: Aufbewahrung, Training, Region).

## Rechtliches (vor kommerzieller Nutzung)
Gesundheitsbezogene Angaben (Allergien, Ernährungsweise, Gewicht) können besondere Kategorien personenbezogener Daten sein. Für Mehrnutzer-/kommerziellen Betrieb nötig: Rechtsgrundlage/Einwilligung, Datenschutzinformation, Auftragsverarbeitung mit den Anbietern, Löschkonzept, ggf. Datenschutz-Folgenabschätzung. **Keine Rechtsberatung.**

## Medizinischer Hinweis
Der Berater ist Informations- und Planungshilfe, kein Arzt; keine Diagnosen/Heilversprechen; bei gesundheitlichen Fragen fachliche Beratung (steht im Chat und im Systemprompt).
