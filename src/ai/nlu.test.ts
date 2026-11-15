import { describe, expect, it } from 'vitest'
import { defaultState } from '../domain/defaults'
import { generatePlan } from '../domain/planner'
import type { AppState } from '../domain/types'
import { findNumbers, fold, followUp, parseCommands, parseWhen, splitClauses, wordToNumber, type Command, type NluResult } from './nlu'
import { evaluateBatch } from './engine'

const TODAY = '2026-11-18'                                       // Mittwoch
const state = (() => {
  const s = defaultState(); s.onboarded = true
  s.profile = { ...s.profile, kcalMode: 'manual', kcalManual: 2200, mealCount: 3 }
  s.plan = generatePlan({ profile: s.profile, foods: s.foods, recipes: s.recipes, prefs: s.prefs, startDate: '2026-11-16', days: 14, seed: 4 })
  return s as AppState
})()
const P = (t: string) => parseCommands(t, { state, today: TODAY })
const cmds = (r: NluResult): Command[] => (r.kind === 'commands' ? r.commands : [])
const only = (t: string) => { const r = P(t); expect(r.kind, `${t} → ${JSON.stringify(r)}`).toBe('commands'); return cmds(r) }

describe('Zahlen', () => {
  it('Zahlwörter (gefaltet)', () => {
    const cases: [string, number][] = [['eins', 1], ['zwolf', 12], ['sechzehn', 16], ['funfundsiebzig', 75], ['einundzwanzig', 21], ['hundert', 100], ['einhundertachtzig', 180], ['hundertachtzig', 180], ['zweihundertfunfzig', 250],
      ['tausend', 1000], ['eintausend', 1000], ['viertausend', 4000], ['dreitausendfunfhundert', 3500], ['zweitausendachthundert', 2800], ['eintausendfunfhundert', 1500], ['zweitausendeinhundertfunfzig', 2150], ['dreitausendzweihundertvierzig', 3240]]
    for (const [w, n] of cases) expect(wordToNumber(w), w).toBe(n)
    for (const w of ['haus', 'tausendeins1', 'hunderttausend', 'dreihunderteins hundert', '']) expect(wordToNumber(w), w).toBeNull()
  })
  it('Ziffern mit Tausenderpunkt/Dezimalkomma und zusammengesetzte Zahlwörter im Text', () => {
    expect(findNumbers('4.000 kcal').map(n => n.value)).toEqual([4000]); expect(findNumbers('3500 und 82,5 kilo').map(n => n.value)).toEqual([3500, 82.5])
    expect(findNumbers('dreitausend funfhundert kalorien')[0].value).toBe(3500); expect(findNumbers('zwei tausend kalorien')[0].value).toBe(2000)
    expect(findNumbers('1.250,5 g')[0].value).toBe(1250.5); expect(findNumbers('ich esse drei mahlzeiten').map(n => n.value)).toEqual([3])
  })
})

describe('Zeitbezug', () => {
  it('heute/morgen/übermorgen/Wochentag/Datum/dauerhaft', () => {
    expect(parseWhen('heute', TODAY)).toEqual({ kind: 'today' }); expect(parseWhen('morgen', TODAY)).toEqual({ kind: 'date', date: '2026-11-19' }); expect(parseWhen('ubermorgen', TODAY)).toEqual({ kind: 'date', date: '2026-11-20' })
    expect(parseWhen('am freitag', TODAY)).toEqual({ kind: 'date', date: '2026-11-20' }); expect(parseWhen('am montag', TODAY)).toEqual({ kind: 'date', date: '2026-11-23' })
    expect(parseWhen('am 21. november', TODAY)).toEqual({ kind: 'date', date: '2026-11-21' }); expect(parseWhen('ab jetzt', TODAY).kind).toBe('permanent'); expect(parseWhen('dauerhaft', TODAY).kind).toBe('permanent')
    expect(parseWhen('guten morgen', TODAY).kind).toBe('none'); expect(parseWhen('irgendwann', TODAY).kind).toBe('none')
  })
})

describe('Klauseln', () => {
  it('Mehrfachaktionen werden an „und“ + neuem Verb getrennt, nicht innerhalb von Aufzählungen', () => {
    expect(splitClauses('Ändere mein Proteinziel auf 180 Gramm und erhöhe die Kalorien heute auf 3.500.')).toHaveLength(2)
    expect(splitClauses('Ich esse mediterran und high protein')).toHaveLength(1)
    expect(splitClauses('Setze Milch auf die Einkaufsliste, erhöhe die Kalorien heute auf 3000')).toHaveLength(2)
    expect(fold('Frühstück ÄÖÜ ß')).toBe('fruhstuck aou ss')
  })
})

describe('Beispielsätze der Vorgabe', () => {
  it('„Ich möchte heute 4.000 kcal essen.“ → einmaliges Tagesziel (kein Nachfragen nötig)', () => {
    expect(only('Ich möchte heute 4.000 kcal essen.')).toEqual([{ type: 'update_calorie_target', kcal: 4000, scope: 'today' }])
  })
  it('„Ich möchte heute 4.000 kcal zu mir nehmen. Passe meinen Ernährungsplan entsprechend an.“', () => {
    const r = P('Ich möchte heute 4.000 kcal zu mir nehmen. Passe meinen Ernährungsplan entsprechend an.')
    expect(cmds(r)).toEqual([{ type: 'update_calorie_target', kcal: 4000, scope: 'today' }]); expect(r.kind === 'commands' && r.notes).toEqual([])
  })
  it('„Ändere mein Proteinziel auf 180 Gramm und erhöhe die Kalorien heute auf 3.500.“ → beide Absichten', () => {
    expect(only('Ändere mein Proteinziel auf 180 Gramm und erhöhe die Kalorien heute auf 3.500.')).toEqual([{ type: 'update_macros', protein_g: 180 }, { type: 'update_calorie_target', kcal: 3500, scope: 'today' }])
  })
})

describe('Kalorienziel', () => {
  it.each([
    ['Setze mein Kalorienziel dauerhaft auf 2.800', { kcal: 2800, scope: 'permanent' }],
    ['Ab jetzt möchte ich 2500 Kalorien am Tag essen', { kcal: 2500, scope: 'permanent' }],
    ['Ich möchte heute viertausend Kalorien essen', { kcal: 4000, scope: 'today' }],
    ['Ich will heute dreitausendfünfhundert Kilokalorien', { kcal: 3500, scope: 'today' }],
    ['Erhöhe meine Kalorien heute um 500', { kcal: 2700, scope: 'today' }],
    ['Senke mein Kalorienziel dauerhaft um 300 kcal', { kcal: 1900, scope: 'permanent' }],
    ['Ich möchte morgen 3000 kcal essen', { kcal: 3000, scope: 'date', date: '2026-11-19' }],
    ['Am Freitag 3200 Kalorien essen', { kcal: 3200, scope: 'date', date: '2026-11-20' }],
    ['Setze die Kalorien für übermorgen auf 2.000', { kcal: 2000, scope: 'date', date: '2026-11-20' }],
    ['Ändere heute mein Kalorienziel auf zweitausendachthundert', { kcal: 2800, scope: 'today' }],
  ])('%s', (t, exp) => { expect(only(t as string)).toEqual([{ type: 'update_calorie_target', ...(exp as object) }]) })
  it('ohne Zeitangabe wird NACHGEFRAGT (heute oder dauerhaft) – nie geraten', () => {
    const r = P('Ich möchte 3000 kcal essen')
    expect(r.kind).toBe('clarify'); if (r.kind !== 'clarify') return
    expect(r.question).toMatch(/nur heute oder dauerhaft/); expect(r.options.map(o => o.label)).toEqual(['Nur heute', 'Dauerhaft'])
    expect(r.options[0].commands).toEqual([{ type: 'update_calorie_target', kcal: 3000, scope: 'today' }]); expect(r.options[1].commands[0]).toMatchObject({ scope: 'permanent', kcal: 3000 })
  })
  it('fehlende Zahl → Rückfrage; Antwort führt die Absicht fort', () => {
    const r = P('Ändere mein Kalorienziel heute')
    expect(r.kind).toBe('clarify'); if (r.kind !== 'clarify' || !r.pending) throw new Error('keine Rückfrage')
    expect(r.question).toMatch(/Auf wie viele Kalorien/)
    expect(cmds(followUp(r.pending, 'dreitausend', { state, today: TODAY }))).toEqual([{ type: 'update_calorie_target', kcal: 3000, scope: 'today' }])
    expect(followUp(r.pending, 'weiß nicht', { state, today: TODAY }).kind).toBe('clarify')                       // keine Zahl → erneut fragen
    expect(cmds(followUp(r.pending, '3.200 dauerhaft', { state, today: TODAY }))[0]).toMatchObject({ kcal: 3200, scope: 'permanent' })
  })
})

describe('Makroziele, Gewicht, Ziel, Aktivität, Ernährungsformen', () => {
  it('Makroziele (auch mehrere in einem Satz)', () => {
    expect(only('Setze mein Eiweißziel auf 160 g')).toEqual([{ type: 'update_macros', protein_g: 160 }])
    expect(only('Ich möchte 150 g Protein und 250 g Kohlenhydrate')).toEqual([{ type: 'update_macros', protein_g: 150, carbs_g: 250 }])
    expect(only('Setze mein Fettziel auf 70 Gramm')).toEqual([{ type: 'update_macros', fat_g: 70 }]); expect(only('Setze meine Makroziele zurück')).toEqual([{ type: 'update_macros', reset: true }])
    expect(P('Ändere mein Proteinziel').kind).toBe('clarify')
  })
  it('Gewicht und Zielgewicht', () => {
    expect(only('Ich wiege 82,5 Kilo')).toEqual([{ type: 'update_weight', kg: 82.5 }]); expect(only('Mein Gewicht ist 81 kg')).toEqual([{ type: 'update_weight', kg: 81 }])
    expect(only('Mein Zielgewicht ist 75 Kilo')).toEqual([{ type: 'update_target_weight', kg: 75 }]); expect(only('Setze mein Gewicht im Profil auf 80 kg')).toEqual([{ type: 'update_user_profile', weight_kg: 80 }])
    expect(only('Ich wiege 80 Kilo und mein Zielgewicht ist 75 Kilo')).toEqual([{ type: 'update_weight', kg: 80 }, { type: 'update_target_weight', kg: 75 }])
  })
  it('Ernährungsziel und Aktivitätsniveau', () => {
    expect(only('Ich möchte abnehmen')).toEqual([{ type: 'update_nutrition_goal', goal: 'reduzieren' }]); expect(only('Mein Ziel ist Muskeln aufbauen')).toEqual([{ type: 'update_nutrition_goal', goal: 'aufbauen' }])
    expect(only('Ich will mein Gewicht halten')).toEqual([{ type: 'update_nutrition_goal', goal: 'halten' }])
    expect(only('Ich bin sehr aktiv')).toEqual([{ type: 'update_activity_level', activity: 'hoch' }]); expect(only('Ich bin im Büro und kaum in Bewegung')).toEqual([{ type: 'update_activity_level', activity: 'sitzend' }])
  })
  it('Ernährungsformen setzen/hinzufügen/entfernen, mehrere kombinierbar', () => {
    expect(only('Ich esse ab jetzt vegan')).toEqual([{ type: 'set_diets', styles: ['vegan'], mode: 'set' }]); expect(only('Stelle auf Keto um')).toEqual([{ type: 'set_diets', styles: ['keto'], mode: 'set' }])
    expect(only('Füge zusätzlich Low Carb hinzu')).toEqual([{ type: 'set_diets', styles: ['lowcarb'], mode: 'add' }]); expect(only('Ich esse nicht mehr vegan')).toEqual([{ type: 'set_diets', styles: ['vegan'], mode: 'remove' }])
    expect(only('Ich esse mediterran und high protein')[0]).toMatchObject({ type: 'set_diets', styles: expect.arrayContaining(['mediterran', 'highprotein']) })
    expect(only('Wechsle zu Paleo')).toEqual([{ type: 'set_diets', styles: ['paleo'], mode: 'set' }]); expect(only('Ich ernähre mich ab jetzt pescetarisch')[0]).toMatchObject({ styles: ['pescetarisch'] })
  })
})

describe('Mahlzeiten, Lebensmittel, Einkauf, Plan', () => {
  const day = state.plan!.days.find(d => d.date === TODAY)!, tomorrow = state.plan!.days.find(d => d.date === '2026-11-19')!
  it('Mahlzeit tauschen: Alternativen werden zur Auswahl angeboten (Engine-geprüft), nicht blind gewählt', () => {
    const r = P('Tausche das Mittagessen heute'); expect(r.kind).toBe('clarify'); if (r.kind !== 'clarify') return
    expect(r.options.length).toBeGreaterThan(0); expect(r.options[0].commands[0]).toMatchObject({ type: 'swap_meal', date: TODAY, meal_id: day.meals.find(m => m.slot === 'mittag')!.id })
    expect(evaluateBatch(r.options[0].commands, state, TODAY).ok).toBe(true)
  })
  it('Mahlzeit löschen / Portion anpassen / ergänzen', () => {
    expect(only('Lösche das Frühstück morgen')).toEqual([{ type: 'remove_meal', date: '2026-11-19', meal_id: tomorrow.meals.find(m => m.slot === 'fruehstueck')!.id }])
    const ab = day.meals.find(m => m.slot === 'abend')!, mi = day.meals.find(m => m.slot === 'mittag')!
    expect(only('Mach das Abendessen heute 20 Prozent größer')).toEqual([{ type: 'set_portion', date: TODAY, meal_id: ab.id, portion_factor: Math.round(ab.factor * 1.2 * 100) / 100 }])
    expect(only('Halbiere das Mittagessen heute')).toEqual([{ type: 'set_portion', date: TODAY, meal_id: mi.id, portion_factor: Math.round((mi.factor / 2) * 100) / 100 }])
    const a = P('Füge heute noch einen Snack hinzu'); expect(a.kind).toBe('clarify'); if (a.kind === 'clarify') expect(a.options[0].commands[0]).toMatchObject({ type: 'add_meal', slot: 'snack', date: TODAY })
  })
  it('Lebensmittel: ausschließen, bevorzugen, Favorit, wieder erlauben; Mehrdeutigkeit und Unbekanntes werden erfragt', () => {
    expect(only('Schließe Tofu aus')).toEqual([{ type: 'update_food_preferences', food_name: expect.stringContaining('Tofu'), preference: 'excluded' }])
    expect(only('Ich mag Quinoa besonders')[0]).toMatchObject({ type: 'update_food_preferences', preference: 'preferred', food_name: expect.stringContaining('Quinoa') })
    expect(only('Füge Haferflocken zu meinen Favoriten hinzu')[0]).toMatchObject({ preference: 'favorite', food_name: expect.stringContaining('Haferflocken') })
    expect(only('Ich möchte Tofu wieder erlauben')[0]).toMatchObject({ preference: 'allowed' })
    const amb = P('Ich mag keine Kartoffel'); expect(amb.kind === 'commands' || amb.kind === 'clarify').toBe(true)
    const unk = P('Schließe Raumschiff aus'); expect(unk.kind).toBe('clarify'); if (unk.kind === 'clarify') expect(unk.question).toMatch(/nicht in deiner Lebensmittelliste/)
  })
  it('Lebensmittel mit Nutzerwerten: nur vollständige Angaben; „pro 100 g“ wird bestätigt statt angenommen', () => {
    const full = P('Füge das Lebensmittel Proteinriegel hinzu mit 380 Kalorien 30 g Eiweiß 35 g Kohlenhydrate 12 g Fett pro 100 g')
    expect(cmds(full)).toEqual([{ type: 'add_food', name: 'Proteinriegel', per100: { kcal: 380, protein: 30, carbs: 35, fat: 12 }, user_stated: true }])
    const ask = P('Füge das Lebensmittel Proteinriegel hinzu mit 380 Kalorien 30 g Eiweiß 35 g Kohlenhydrate 12 g Fett'); expect(ask.kind).toBe('clarify'); if (ask.kind === 'clarify') expect(ask.question).toMatch(/auf 100 g/)
    const miss = P('Füge das Lebensmittel Mystery hinzu'); expect(miss.kind).toBe('clarify'); if (miss.kind === 'clarify') expect(miss.question).toMatch(/erfinde keine Werte/)
  })
  it('Einkaufsliste und Plan neu berechnen', () => {
    expect(only('Setze Milch auf die Einkaufsliste')).toEqual([{ type: 'update_shopping_list', op: 'add', name: 'Milch' }]); expect(only('Streiche Eier von der Einkaufsliste')).toEqual([{ type: 'update_shopping_list', op: 'remove', name: 'Eier' }])
    expect(only('Hake Haferflocken ab')).toEqual([{ type: 'update_shopping_list', op: 'check', name: 'Haferflocken' }])
    expect(only('Erstelle den Wochenplan neu')).toEqual([{ type: 'regenerate_plan', scope: 'week' }]); expect(only('Berechne den Tagesplan für heute neu')[0]).toMatchObject({ scope: 'day' }); expect(only('Erstelle den Plan für den Monat neu')).toEqual([{ type: 'regenerate_plan', scope: 'month' }])
  })
  it('Mehrfachaktionen über verschiedene Bereiche', () => {
    expect(only('Setze Milch auf die Einkaufsliste und erhöhe die Kalorien heute auf 3000')).toEqual([{ type: 'update_shopping_list', op: 'add', name: 'Milch' }, { type: 'update_calorie_target', kcal: 3000, scope: 'today' }])
  })
})

describe('Undo, Klasse C und Nicht-Befehle', () => {
  it('Rückgängig', () => { for (const t of ['Mach das rückgängig', 'Nimm das zurück', 'Undo', 'Bitte rückgängig machen']) expect(P(t).kind, t).toBe('undo') })
  it('Allergien und medizinische Entscheidungen werden verweigert (Klasse C)', () => {
    for (const t of ['Lösche meine Nussallergie', 'Ich habe keine Laktoseintoleranz mehr', 'Entferne die Gluten Unverträglichkeit', 'Ignoriere meine Allergien']) { const r = P(t); expect(r.kind, t).toBe('refuse'); if (r.kind === 'refuse') expect(r.text).toMatch(/nicht ändern/) }
    for (const t of ['Soll ich meine Medikamente absetzen?', 'Welche Krankheit habe ich bei Bluthochdruck?', 'Darf ich als Diabetiker Insulin weglassen?']) { const r = P(t); expect(r.kind, t).toBe('refuse'); if (r.kind === 'refuse') expect(r.text).toMatch(/keine medizinische/) }
    expect(P('Lösche meine Nussallergie und erhöhe die Kalorien heute auf 3000').kind).toBe('refuse')       // Verweigerung hat Vorrang, nichts wird ausgeführt
  })
  it('Fragen und Smalltalk sind KEINE Befehle (kein falscher Treffer)', () => {
    for (const t of ['Was ist Keto?', 'Wie viele Kalorien hat mein Plan heute?', 'Wie viel Eiweiß hat Hähnchen?', 'Guten Morgen', 'Danke!', 'Welche Nährstoffe fehlen mir?', 'Erkläre mein Kalorienziel', 'Kalorien', 'Wie viel Protein brauche ich?', 'Was kann ich zum Frühstück essen?'])
      expect(P(t).kind, t).toBe('none')
  })
})

describe('Genauigkeit des Korpus', () => {
  it('Treffer-Zusammenfassung (dokumentiert den tatsächlichen Stand, keine Behauptung darüber hinaus)', () => {
    const corpus: [string, string][] = [['Ich möchte heute 4.000 kcal essen', 'update_calorie_target'], ['Setze mein Kalorienziel dauerhaft auf 2.800', 'update_calorie_target'], ['Ich wiege 82,5 Kilo', 'update_weight'], ['Ich esse ab jetzt vegan', 'set_diets'], ['Schließe Tofu aus', 'update_food_preferences'], ['Erstelle den Wochenplan neu', 'regenerate_plan'], ['Setze Milch auf die Einkaufsliste', 'update_shopping_list'], ['Ändere mein Proteinziel auf 180 Gramm', 'update_macros']]
    expect(corpus.filter(([t, ty]) => cmds(P(t))[0]?.type === ty).length).toBe(corpus.length)
  })
})
