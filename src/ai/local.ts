/**
 * Lokaler Berater: beantwortet einfache Fragen deterministisch aus der Ernährungs-Engine – ohne KI, ohne Netz.
 * Alle Zahlen stammen aus der Engine. Vorschläge laufen über denselben Validierungspfad wie KI-Aktionen.
 */
import type { AppState, MealSlot } from '../domain/types'
import { SLOT_LABEL, STYLE_LABEL } from '../domain/types'
import { alternativesFor, dayTotals, type PlanAnalysis, type PlanContext } from '../domain/planner'
import { mealMacros, estimateKcal, macroShares } from '../domain/nutrition'
import { allDiets } from '../domain/diets'
import { analyzeGaps } from '../domain/nutrients'
import { macroTarget } from '../domain/rules'
import type { Proposal } from './types'

export interface LocalAnswer { text: string; proposals: Proposal[] }
const has = (t: string, rx: RegExp) => rx.test(t.toLowerCase())
const SLOT_WORDS: [RegExp, MealSlot][] = [[/frühstück|fruehstueck/, 'fruehstueck'], [/mittag/, 'mittag'], [/abend/, 'abend'], [/snack|zwischenmahlzeit/, 'snack']]

export const HELP_TEXT = 'Ich bin der lokale Berater (ohne KI) und kann: Kalorien- und Makroziele erklären, Ernährungsweisen erläutern, Nährstoffbilanz zusammenfassen, Alternativen für eine Mahlzeit vorschlagen (z. B. „Tausche das Mittagessen heute“) und die Einkaufsliste zusammenfassen. Für freie Fragen, Rezeptideen und Planüberarbeitung aktiviere in den Einstellungen die KI.'

export function localAnswer(text: string, state: AppState, ctx: PlanContext, analysis: PlanAnalysis | null, target: number, today: string): LocalAnswer {
  const t = text.toLowerCase()

  // 1) Ernährungsweise erklären
  const diet = allDiets().find(d => t.includes(d.label.toLowerCase()) || t.includes(String(d.id)) || (d.id === 'lowcarb' && /low.?carb/.test(t)) || (d.id === 'highprotein' && /high.?protein/.test(t)) || (d.id === 'keto' && /keto/.test(t)))
  if (diet && has(t, /erklär|was ist|regel|bedeutet|unterschied|darf|erlaubt/)) {
    return { text: `**${diet.label}** – ${diet.summary}\n\nIn dieser App gelten folgende Regeln:\n${diet.definition.map(x => `• ${x}`).join('\n')}${diet.gapNotes?.length ? `\n\nAllgemeine Hinweise (keine Diagnose):\n${diet.gapNotes.map(x => `• ${x}`).join('\n')}` : ''}`, proposals: [] }
  }

  // 2) Kalorien / Makros
  if (has(t, /kalorie|kcal|makro|eiweiß|kohlenhydrat|fett|berechn|grundumsatz/)) {
    const est = estimateKcal(state.profile), mt = macroTarget(state.prefs.styles)
    const day = state.plan?.days.find(d => d.date >= today)
    const lines = [`Dein Tagesziel: ${Math.round(target)} kcal (${state.profile.kcalMode === 'manual' ? 'manuell festgelegt' : 'automatisch geschätzt'}).`]
    if (state.profile.kcalMode === 'auto') lines.push(...est.notes.slice(0, 3).map(x => `• ${x}`))
    lines.push(`Orientierung für die Energieverteilung: ${mt.protein} % Eiweiß, ${mt.carbs} % Kohlenhydrate, ${mt.fat} % Fett (Eiweiß/Kohlenhydrate je 4 kcal, Fett 9 kcal pro Gramm).`)
    if (day) { const m = dayTotals(day, ctx), s = macroShares(m); lines.push(`Geplant für ${day.date}: ${Math.round(m.kcal)} kcal – ${Math.round(s.protein)} % Eiweiß, ${Math.round(s.carbs)} % Kohlenhydrate, ${Math.round(s.fat)} % Fett.`) }
    lines.push('Das sind Orientierungswerte und keine medizinische Empfehlung.')
    return { text: lines.join('\n'), proposals: [] }
  }

  // 3) Nährstofflücken
  if (has(t, /nährstoff|naehrstoff|vitamin|mineral|lücke|luecke|mangel|versorg|ballaststoff/)) {
    if (!state.plan) return { text: 'Es gibt noch keinen Plan, aus dem ich eine Nährstoffbilanz berechnen könnte.', proposals: [] }
    const rep = analyzeGaps(state.plan, ctx, state.profile, state.prefs)
    const low = rep.rows.filter(r => r.status === 'low' || r.status === 'borderline'), unk = rep.rows.filter(r => r.status === 'unknown')
    const out = [low.length ? `Unter dem Orientierungswert (Ø pro Tag, aus den Rezepten berechnet):\n${low.map(r => `• ${r.label}: ${Math.round(r.pct)} %`).join('\n')}` : 'Alle berechenbaren Nährstoffe liegen im Plan im Orientierungsbereich.']
    if (unk.length) out.push(`Datenlage unzureichend (keine Aussage möglich): ${unk.map(r => r.label).join(', ')}.`)
    for (const d of rep.dietNotes) out.push(`${d.diet}: ${d.notes.join(' ')}`)
    out.push(rep.basis)
    return { text: out.join('\n\n'), proposals: [] }
  }

  // 4) Mahlzeit austauschen
  if (has(t, /tausch|ersetz|alternativ|statt|anders/)) {
    if (!state.plan) return { text: 'Es gibt noch keinen Plan. Erstelle zuerst einen Ernährungsplan.', proposals: [] }
    const day = state.plan.days.find(d => d.date >= today) ?? state.plan.days[0]
    const slot = SLOT_WORDS.find(([rx]) => rx.test(t))?.[1]
    const meal = (slot ? day.meals.find(m => m.slot === slot) : undefined) ?? day.meals.find(m => m.slot === 'mittag') ?? day.meals[0]
    if (!meal) return { text: 'Für diesen Tag gibt es keine Mahlzeit zum Austauschen.', proposals: [] }
    const kc = mealMacros(meal, ctx.recipes, ctx.foods, ctx.oils).kcal
    const alts = alternativesFor(meal.slot, kc, ctx, [meal.recipeId], 3)
    if (!alts.length) return { text: `Mit deinen Einstellungen gibt es keine passende Alternative für ${SLOT_LABEL[meal.slot]}.`, proposals: [] }
    return { text: `Alternativen für ${SLOT_LABEL[meal.slot]} am ${day.date} (aktuell: ${ctx.recipes.get(meal.recipeId)?.name}, ${Math.round(kc)} kcal). Alle Vorschläge erfüllen deine Allergie- und Ausschlussregeln:\n${alts.map(a => `• ${a.recipe.name} (${a.factor}× Portion, ≈ ${Math.round(a.kcal)} kcal)`).join('\n')}\n\nÜbernimm einen Vorschlag unten – die Engine prüft ihn vor dem Speichern erneut.`,
      proposals: alts.map(a => ({ type: 'swap_meal' as const, date: day.date, meal_id: meal.id, recipe_id: a.recipe.id, reason: 'Alternative gleicher Kalorienhöhe' })) }
  }

  // 5) Einkaufsliste
  if (has(t, /einkauf|kaufen/)) {
    if (!state.plan) return { text: 'Es gibt noch keinen Plan – daher auch keine Einkaufsliste.', proposals: [] }
    const tot = new Map<string, number>()
    for (const d of state.plan.days) for (const m of d.meals) for (const i of ctx.recipes.get(m.recipeId)?.ingredients ?? []) {
      const id = i.foodId === 'oil:warm' ? state.plan.oils.warm : i.foodId === 'oil:cold' ? state.plan.oils.cold : i.foodId
      const f = id ? ctx.foods.get(id) : undefined; if (f) tot.set(f.name, (tot.get(f.name) ?? 0) + i.grams * m.factor * state.profile.persons)
    }
    const top = [...tot].sort((a, b) => b[1] - a[1]).slice(0, 5)
    return { text: `Die Einkaufsliste enthält ${tot.size} verschiedene Zutaten für ${state.plan.days.length} Tage und ${state.profile.persons} Person(en). Die mengenmäßig größten Posten: ${top.map(([n, g]) => `${n} (${Math.round(g)} g)`).join(', ')}.\nFür eine KI-gestützte Optimierung (z. B. weniger Reste) aktiviere die KI in den Einstellungen.`, proposals: [] }
  }

  if (analysis && has(t, /plan.*(gut|bewert|analys)|bewert|analys/)) {
    return { text: `Plan-Qualität: ${Math.round(analysis.score.total)}/100.\n${analysis.issues.length ? analysis.issues.map(i => `• ${i.text}`).join('\n') : 'Keine Auffälligkeiten.'}\nAktive Ernährungsweisen: ${state.prefs.styles.map(x => STYLE_LABEL[x]).join(', ')}.`, proposals: [] }
  }
  return { text: HELP_TEXT, proposals: [] }
}
