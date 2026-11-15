# KI-Kostenkontrolle

## Erfassung (`backend/data/usage.jsonl`, nur Metadaten)
Zeitstempel, Anbieter, Modell, Eingabe-/Ausgabe-Token (soweit vom Anbieter geliefert), geschätzte Kosten, Monatssumme. Anzeige in *Einstellungen → KI*.

## Kosten – nur was verlässlich ist
`Kosten = Token × Preis aus backend/config/pricing.json`. Ohne Preiseintrag: `cost_usd = null` („nicht berechenbar“), **es wird nichts geschätzt oder erfunden**.
Mitgelieferte Preise (Anthropic, USD/Mio. Token, Stand 2026-11-03 laut Skill-Cache): Opus 5.5 4/20 · Fable 5.2 8/40 · Sonnet 5.5 2/10 · Haiku 5.5 0,10/0,50 (nur bis 100K Prompt-Token). **OpenAI: leer – selbst eintragen.** Preise ändern sich: vor Verlass mit der Anbieterseite abgleichen. Nicht berücksichtigt: Caching-Rabatte (nicht genutzt), Rundungen/Steuern der echten Abrechnung. Kosten sind **Schätzungen**, kein Ersatz für die Anbieterrechnung.

## Begrenzung
| Mechanismus | Standard |
|---|---|
| Monatliches Limit (`monthly_limit_usd`) + „sperren bei Limit“ | aus / an |
| Warnung bei Erreichen (Einstellungen), danach antwortet der lokale Berater | ✓ |
| Max. Antwortlänge (`max_output_tokens`) | 1024, Obergrenze 4096 |
| Gesprächshistorie (`history_messages`) | 12 (≤ 30), Frontend sendet ≤ 12 |
| Rate-Limit je IP | 20 / Minute |
| Kontext-Budget | 12.000 Zeichen (Sicherheitsrelevantes wird nie gekürzt) |
| Sperre nur bei **bekannten** Kosten | ein Limit von 0 USD sperrt sofort |

**Grenzen:** OpenAI erfasst bei Abbruch keine Nutzung (dann kein Ledger-Eintrag); ein Limit greift nicht, wenn für das Modell kein Preis hinterlegt ist; Ledger gilt für ein lokales Backend (Einzelnutzer).
