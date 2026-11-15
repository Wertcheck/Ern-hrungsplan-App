/**
 * Nährstoffbilanz eines Plans: tatsächliche Zufuhr (aus den Rezepten, BLS-Mikronährstoffdaten) im Vergleich zu Orientierungswerten.
 * Wichtig: Referenzwerte sind keine individuellen Empfehlungen; es werden keine Diagnosen gestellt und keine Wirkungen versprochen.
 * Fehlen Daten, wird ausdrücklich „Datenlage unzureichend“ gemeldet statt einer Lücke (fehlend ≠ 0).
 */
import type { MicroKey, Plan, Profile, Sex, Preferences } from './types'
import { MICRO_INFO, MICRO_KEYS } from './types'
import { resolveIngredients } from './nutrition'
import type { PlanContext } from './planner'
import { getDiet } from './diets'

export const REFERENCE_BASIS = 'Orientierungswerte in Anlehnung an die D-A-CH-Referenzwerte für Erwachsene (vereinfacht, nicht gegen die Originalquelle verifiziert). Keine individuelle Empfehlung.'

type Ref = { f: number; m: number; note?: string }
/** pro Tag, Erwachsene */
export const MICRO_REFERENCE: Record<MicroKey, Ref> = {
  calcium: { f: 1000, m: 1000 }, magnesium: { f: 300, m: 350 }, kalium: { f: 4000, m: 4000, note: 'Schätzwert' },
  eisen: { f: 15, m: 10, note: 'Wert für Frauen vor den Wechseljahren' }, zink: { f: 8, m: 14, note: 'bei mittlerer Phytatzufuhr' },
  vitaminA: { f: 700, m: 850, note: 'Referenz in Retinol-Äquivalenten; BLS-Daten in RAE (ähnlich, nicht identisch)' },
  vitaminB12: { f: 4, m: 4 }, vitaminC: { f: 95, m: 110 }, vitaminD: { f: 20, m: 20, note: 'Wert bei fehlender körpereigener Bildung' },
  vitaminE: { f: 12, m: 13 }, folat: { f: 300, m: 300, note: 'Folatäquivalente' },
}
export const FIBER_REF = 30           // g/Tag Richtwert
export const PROTEIN_PER_KG = 0.8     // g/kg Körpergewicht

export type GapStatus = 'ok' | 'borderline' | 'low' | 'unknown'
export interface NutrientRow {
  key: MicroKey | 'fiber' | 'protein'
  label: string; unit: string
  /** durchschnittliche Zufuhr pro Person und Tag aus den Plan-Rezepten */
  intake: number
  reference: number
  pct: number
  /** Anteil der Zutatenmasse mit vorhandenen Nährstoffdaten (0..1) */
  coverage: number
  status: GapStatus
  hardToReach: boolean
  note?: string
}
export interface GapReport { rows: NutrientRow[]; dietNotes: { diet: string; notes: string[] }[]; basis: string; days: number; caveats: string[] }

const refFor = (r: Ref, sex: Sex) => (sex === 'm' ? r.m : sex === 'f' ? r.f : (r.m + r.f) / 2)
export const COVERAGE_MIN = 0.7

export function analyzeGaps(plan: Plan, ctx: PlanContext, profile: Pick<Profile, 'sex' | 'weightKg'>, prefs: Pick<Preferences, 'styles'>): GapReport {
  const sums: Record<string, number> = {}
  const massWith: Record<string, number> = {}
  let mass = 0, fiber = 0, protein = 0, days = 0
  for (const d of plan.days) {
    if (!d.meals.length) continue
    days++
    for (const m of d.meals) {
      const r = ctx.recipes.get(m.recipeId)
      if (!r) continue
      for (const i of resolveIngredients(r.ingredients, plan.oils)) {
        const f = ctx.foods.get(i.foodId)
        if (!f) continue
        const g = i.grams * m.factor
        // Wasser/kalorienfreie Getränke und Gewürze in Spurenmengen verfälschen die Abdeckung nicht
        if (f.category === 'getraenke' && f.kcal <= 5) continue
        mass += g; fiber += (f.fiber * g) / 100; protein += (f.protein * g) / 100
        for (const k of MICRO_KEYS) {
          const v = f.micros?.[k]
          if (v !== undefined) { sums[k] = (sums[k] ?? 0) + (v * g) / 100; massWith[k] = (massWith[k] ?? 0) + g }
        }
      }
    }
  }
  const rows: NutrientRow[] = []
  const classify = (pct: number, coverage: number): GapStatus => (coverage < COVERAGE_MIN ? 'unknown' : pct >= 100 ? 'ok' : pct >= 75 ? 'borderline' : 'low')
  if (days > 0) {
    for (const k of MICRO_KEYS) {
      const ref = refFor(MICRO_REFERENCE[k], profile.sex)
      const intake = (sums[k] ?? 0) / days
      const coverage = mass > 0 ? (massWith[k] ?? 0) / mass : 0
      const pct = (intake / ref) * 100
      const status = classify(pct, coverage)
      rows.push({ key: k, label: MICRO_INFO[k].label, unit: MICRO_INFO[k].unit, intake, reference: ref, pct, coverage, status, hardToReach: status === 'low' && pct < 50, note: MICRO_REFERENCE[k].note })
    }
    rows.push({ key: 'fiber', label: 'Ballaststoffe', unit: 'g', intake: fiber / days, reference: FIBER_REF, pct: (fiber / days / FIBER_REF) * 100, coverage: 1, status: classify((fiber / days / FIBER_REF) * 100, 1), hardToReach: fiber / days / FIBER_REF < 0.5, note: 'Richtwert; Ballaststoffwerte fehlen bei einzelnen Lebensmitteln' })
    const pRef = PROTEIN_PER_KG * profile.weightKg
    rows.push({ key: 'protein', label: 'Eiweiß', unit: 'g', intake: protein / days, reference: pRef, pct: (protein / days / pRef) * 100, coverage: 1, status: classify((protein / days / pRef) * 100, 1), hardToReach: false, note: `Orientierung ${PROTEIN_PER_KG} g je kg Körpergewicht` })
  }
  const dietNotes = prefs.styles.map(s => ({ diet: getDiet(s)?.label ?? s, notes: getDiet(s)?.gapNotes ?? [] })).filter(x => x.notes.length)
  const caveats = [REFERENCE_BASIS, 'Die Zufuhr ist eine Berechnung aus den Rezepten (Rohwerte, ohne Zubereitungsverluste) – keine Messung.']
  if (rows.some(r => r.status === 'unknown')) caveats.push('Für einzelne Nährstoffe liegen für zu viele Zutaten keine Daten vor („Datenlage unzureichend“). Dort wird bewusst keine Lücke behauptet.')
  return { rows, dietNotes, basis: REFERENCE_BASIS, days, caveats }
}
