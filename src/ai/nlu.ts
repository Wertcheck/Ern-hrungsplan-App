/**
 * Tier-0-Befehlserkennung (Deutsch): deterministisch, ohne Modell, offline, vollständig testbar.
 * Wandelt Text (auch Spracheingabe nach STT) in Aktionsvorschläge um. Versteht Zahlwörter, Einheiten, Zeitbezug,
 * Mehrfachaktionen; bei fehlenden Angaben wird nachgefragt – es wird NICHT geraten.
 * Unscharfe Sprache, die hier nicht erkannt wird, bleibt für Tier 1/2 (lokales LLM / Cloud) liegen.
 */
import type { AppState, MealSlot, Style } from '../domain/types'
import { SLOT_LABEL, STYLE_LABEL } from '../domain/types'
import { alternativesFor, buildContext, targetFor } from '../domain/planner'
import { kcalTarget, mealMacros } from '../domain/nutrition'
import { findFood } from './actions'

export type Command = Record<string, unknown> & { type: string }
export interface Option { label: string; commands: Command[] }
export type Pending = { intent: 'calorie_value'; scope: 'today' | 'date' | 'permanent'; date?: string; relative?: -1 | 1 } | { intent: 'food_per100'; name: string; vals: { kcal: number; protein: number; carbs: number; fat: number } }
export type NluResult =
  | { kind: 'commands'; commands: Command[]; notes: string[] }
  | { kind: 'clarify'; question: string; options: Option[]; pending?: Pending; notes: string[]; commands?: Command[] }
  | { kind: 'refuse'; text: string }
  | { kind: 'undo' }
  | { kind: 'none' }

// ---------------------------------------------------------------- Normalisierung
export const fold = (s: string) => s.toLowerCase().replace(/ß/g, 'ss').replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/[„“"'’`]/g, '').replace(/\s+/g, ' ').trim()

const ONES: Record<string, number> = { null: 0, ein: 1, eins: 1, eine: 1, einen: 1, einem: 1, einer: 1, zwei: 2, drei: 3, vier: 4, funf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, zwolf: 12, dreizehn: 13, vierzehn: 14, funfzehn: 15, sechzehn: 16, siebzehn: 17, achtzehn: 18, neunzehn: 19 }
const TENS: Record<string, number> = { zwanzig: 20, dreissig: 30, vierzig: 40, funfzig: 50, sechzig: 60, siebzig: 70, achtzig: 80, neunzig: 90 }

/** Deutsches Zahlwort (gefaltet, ohne Umlaute) → Zahl; null, wenn kein vollständiges Zahlwort. Bis 99.999. */
export function wordToNumber(w: string): number | null {
  if (!w) return null
  if (w in ONES) return ONES[w]
  if (w in TENS) return TENS[w]
  const u = w.match(/^(.+)und(zwanzig|dreissig|vierzig|funfzig|sechzig|siebzig|achtzig|neunzig)$/)
  if (u && u[1] in ONES && ONES[u[1]] >= 1 && ONES[u[1]] <= 9) return ONES[u[1]] + TENS[u[2]]
  const t = w.indexOf('tausend')
  if (t >= 0) {
    const left = t === 0 ? 1 : wordToNumber(w.slice(0, t)), right = w.slice(t + 7)
    if (left === null || left < 1 || left > 99) return null
    const r = right ? wordToNumber(right) : 0
    return r === null || r >= 1000 ? null : left * 1000 + r
  }
  const h = w.indexOf('hundert')
  if (h >= 0) {
    const left = h === 0 ? 1 : wordToNumber(w.slice(0, h)), right = w.slice(h + 7)
    if (left === null || left < 1 || left > 9) return null
    const r = right ? wordToNumber(right) : 0
    return r === null || r >= 100 ? null : left * 100 + r
  }
  return null
}

export interface Num { value: number; start: number; end: number; raw: string }
/** Alle Zahlen im (gefalteten) Text: „4.000“, „4000“, „3,5“, „viertausend“, „dreitausend fünfhundert“. */
export function findNumbers(text: string): Num[] {
  const out: Num[] = []
  const rx = /\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?|[a-z]+/g
  let m: RegExpExecArray | null
  const toks: { s: string; i: number }[] = []
  while ((m = rx.exec(text))) toks.push({ s: m[0], i: m.index })
  for (let k = 0; k < toks.length; k++) {
    const { s, i } = toks[k]
    if (/^\d/.test(s)) {
      const v = /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s) ? Number(s.replace(/\./g, '').replace(',', '.')) : Number(s.replace(',', '.'))
      if (Number.isFinite(v)) out.push({ value: v, start: i, end: i + s.length, raw: s })
      continue
    }
    let v = wordToNumber(s)
    if (v === null) continue
    let end = i + s.length, used = 1
    const nx = toks[k + 1]
    // „dreitausend fünfhundert“ / „zwei tausend“ / „zwei hundert“
    if (nx && !/^\d/.test(nx.s)) {
      const n2 = wordToNumber(nx.s)
      if (n2 !== null && v % 1000 === 0 && v >= 1000 && n2 < 1000) { v += n2; end = nx.i + nx.s.length; used = 2 }
      else if (n2 !== null && nx.s === 'tausend' && v < 100) { v *= 1000; end = nx.i + nx.s.length; used = 2 }
      else if (n2 !== null && nx.s === 'hundert' && v < 10) { v *= 100; end = nx.i + nx.s.length; used = 2 }
    }
    out.push({ value: v, start: i, end, raw: text.slice(i, end) }); k += used - 1
  }
  return out
}

// ---------------------------------------------------------------- Zeitbezug
const WEEKDAYS = ['sonntag', 'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag']
const addDays = (iso: string, n: number) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const MONTHS = ['januar', 'februar', 'marz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember']

export interface When { kind: 'today' | 'date' | 'permanent' | 'none'; date?: string }
export function parseWhen(t: string, today: string): When {
  if (/\b(dauerhaft|ab jetzt|ab sofort|immer|standardmassig|generell|grundsatzlich|permanent|langfristig|fur immer|im profil)\b/.test(t)) return { kind: 'permanent' }
  if (/\buebermorgen\b|\bubermorgen\b/.test(t)) return { kind: 'date', date: addDays(today, 2) }
  if (/\bmorgen\b/.test(t) && !/guten morgen/.test(t)) return { kind: 'date', date: addDays(today, 1) }
  if (/\bgestern\b/.test(t)) return { kind: 'date', date: addDays(today, -1) }
  if (/\bheute\b|\bheut\b/.test(t)) return { kind: 'today' }
  const dm = t.match(/\b(\d{1,2})\.\s?(\d{1,2})?\.?\s?(januar|februar|marz|april|mai|juni|juli|august|september|oktober|november|dezember)?/)
  if (dm && (dm[3] || dm[2])) {
    const y = Number(today.slice(0, 4)), mon = dm[3] ? MONTHS.indexOf(dm[3]) + 1 : Number(dm[2])
    if (mon >= 1 && mon <= 12) return { kind: 'date', date: `${y}-${String(mon).padStart(2, '0')}-${String(Number(dm[1])).padStart(2, '0')}` }
  }
  const wd = WEEKDAYS.find(d => new RegExp(`\\b(am |nachsten |kommenden )?${d}\\b`).test(t))
  if (wd) { const cur = new Date(today + 'T00:00:00Z').getUTCDay(); let diff = (WEEKDAYS.indexOf(wd) - cur + 7) % 7; if (diff === 0) diff = 7; return { kind: 'date', date: addDays(today, diff) } }
  return { kind: 'none' }
}

// ---------------------------------------------------------------- Hilfen
const SLOT_WORDS: [RegExp, MealSlot][] = [[/fruhstuck|morgenessen/, 'fruehstueck'], [/mittag/, 'mittag'], [/abend/, 'abend'], [/snack|zwischenmahlzeit|zwischenmahlzeiten/, 'snack']]
const slotOf = (t: string): MealSlot | undefined => SLOT_WORDS.find(([rx]) => rx.test(t))?.[1]
const DIETS: [RegExp, Style][] = [[/\bvegan\w*/, 'vegan'], [/vegetari\w*/, 'vegetarisch'], [/pescetari\w*|pesco/, 'pescetarisch'], [/flexitari\w*/, 'flexitarisch'], [/carnivor\w*|fleischfresser/, 'carnivore'], [/\bketo\w*/, 'keto'], [/low ?carb\w*/, 'lowcarb'], [/high ?protein|eiweissreich\w*/, 'highprotein'], [/paleo\w*|steinzeit\w*/, 'paleo'], [/mediterran\w*/, 'mediterran'], [/basisch\w*|alkalisch\w*/, 'basisch'], [/mischkost|ausgewogen\w*/, 'mischkost']]
const fmt = (n: number) => n.toLocaleString('de-DE')
const near = (nums: Num[], at: number, dir: 'after' | 'any' = 'any', max = 40): Num | undefined => nums.filter(n => (dir === 'after' ? n.start >= at : true) && Math.abs(n.start - at) <= max).sort((a, b) => Math.abs(a.start - at) - Math.abs(b.start - at))[0]

export interface NluInput { state: AppState; today: string }

const REFUSE_ALLERGY = 'Allergien und Unverträglichkeiten kann ich nicht ändern – das ist aus Sicherheitsgründen nur manuell möglich (Einstellungen → Allergien & Unverträglichkeiten). Ich halte sie bei jedem Vorschlag verbindlich ein.'
const REFUSE_MEDICAL = 'Dazu kann ich keine medizinische Einschätzung geben und keine Diagnosen oder Behandlungsentscheidungen treffen. Bitte sprich das mit Ärztin/Arzt oder einer Ernährungsfachkraft ab. Ich kann dir bei Planung und Nährwerten helfen.'

// ---------------------------------------------------------------- Klauseln
const VERBS = '(?:aendere|andere|setze|erhohe|erhoehe|senke|reduziere|verringere|tausche|ersetze|wechsle|loesche|losche|entferne|streiche|fuge|fuege|erstelle|berechne|stelle|trage|hake|schliesse|bevorzuge|aktiviere|deaktiviere|mach|mache|ich (?:moechte|mochte|will|esse|wiege|bin|mag)|mein (?:zielgewicht|gewicht|kalorienziel|proteinziel|eiweissziel|fettziel))'
export function splitClauses(raw: string): string[] {
  const t = fold(raw).replace(/\s+/g, ' ')
  const parts: string[] = []
  let cur = ''
  for (const piece of t.split(/(?<=[.!?;])\s+|\s*(?:,(?!\d)|(?<!\d),)\s*|\s+(?=und (?:dann )?(?:bitte )?(?:auch )?(?:noch )?(?:\w+ )?)/)) {
    const m = piece.match(/^(?:und|sowie|ausserdem|dann)\s+(?:dann\s+)?(.*)$/)
    const body = m ? m[1] : piece
    if (!cur) { cur = body; continue }
    // an „und/Komma“ nur trennen, wenn danach eine neue Absicht (Verb) beginnt
    if (new RegExp(`^(?:bitte\\s+)?${VERBS}\\b`).test(body) || (m && /^(?:ich|mein|die|das|den)\b/.test(body) && new RegExp(VERBS).test(body))) { parts.push(cur); cur = body } else cur = `${cur} ${m ? 'und ' : ''}${body}`.trim()
  }
  if (cur) parts.push(cur)
  return parts.map(p => p.replace(/[.!?]+$/, '').trim()).filter(Boolean)
}

export function parseCommands(raw: string, input: NluInput): NluResult {
  const whole = fold(raw)
  if (/(mach|mache|nimm|nehme)?.{0,25}(ruckgangig|zuruck(nehmen|setzen)|undo)|\bnimm das zuruck\b|\bzuruck\b.{0,10}\bbitte\b/.test(whole) && !/zuruck(setzen)? .*(makro|ziel)/.test(whole)) return { kind: 'undo' }
  const commands: Command[] = [], notes: string[] = []
  let clarify: Extract<NluResult, { kind: 'clarify' }> | null = null
  const unparsed: string[] = []
  for (const c of splitClauses(raw)) {
    const r = parseClause(c, input)
    if (r.kind === 'refuse') return r
    if (r.kind === 'commands') { commands.push(...r.commands); notes.push(...r.notes) }
    else if (r.kind === 'clarify') { clarify ??= { ...r, notes: [...r.notes] }; }
    else unparsed.push(c)
  }
  if (clarify) return { ...clarify, notes: [...notes, ...clarify.notes], commands: commands.length ? commands : undefined }
  if (!commands.length) return { kind: 'none' }
  if (unparsed.length) notes.push(`Nicht verstanden und übersprungen: „${unparsed.join('“, „')}“`)
  return { kind: 'commands', commands, notes }
}

function parseClause(c: string, { state, today }: NluInput): NluResult {
  void SLOT_LABEL
  const nums = findNumbers(c)
  const when = parseWhen(c, today)
  const none: NluResult = { kind: 'none' }
  const rawHas = (rx: RegExp) => rx.test(c)

  // ---- Klasse C: nicht delegierbar
  if (/(allergi|unvertraglich|intoleranz|laktoseintoleranz|glutenunvertraglich)/.test(c) && /(loesche|losche|entferne|streiche|aendere|andere|setze|habe (keine|kein) .* mehr|nicht mehr|ignoriere|deaktiviere|erlaube|vergiss|egal)/.test(c)) return { kind: 'refuse', text: REFUSE_ALLERGY }
  if (/(diagnos|krankheit|medikament|insulin|therapie|dosis|bluthochdruck|schwanger|stillen|nierenerkrank|essstorung)/.test(c) && /(soll(te)? ich|darf ich|kann ich .* heilen|behandl|heilt|diagnos|welche krankheit|ersetzt|absetzen)/.test(c)) return { kind: 'refuse', text: REFUSE_MEDICAL }

  // Fragen sind keine Befehle
  if (/^(was|wie|welche[rs]?|wann|warum|wieso|wo|erklare|zeig)\b/.test(c)) return none

  // ---- Makroziele (vor Kalorien)
  const macroWords: [RegExp, 'protein_g' | 'carbs_g' | 'fat_g'][] = [[/protein\w*|eiweiss\w*/, 'protein_g'], [/kohlenhydrat\w*|carbs/, 'carbs_g'], [/\bfett\w*/, 'fat_g']]
  const withUnit = nums.filter(n => /^\s*(g\b|gramm|gr\b)/.test(c.slice(n.end)))
  if (withUnit.length && !/lebensmittel/.test(c) && macroWords.some(([rx]) => rx.test(c)) && !/kalorien|kcal/.test(c.replace(/\d+\s*(kcal|kalorien)/g, ''))) {
    const cmd: Command = { type: 'update_macros' }
    for (const [rx, key] of macroWords) { const m = c.match(rx); if (!m) continue; const n = near(withUnit, m.index ?? 0, 'any', 30); if (n) cmd[key] = n.value }
    if (cmd.protein_g !== undefined || cmd.carbs_g !== undefined || cmd.fat_g !== undefined) return { kind: 'commands', commands: [cmd], notes: [] }
  }
  if (/(makroziele?|proteinziel|eiweissziel)/.test(c) && /(zurucksetzen|zuruck|loesche|losche|standard)/.test(c)) return { kind: 'commands', commands: [{ type: 'update_macros', reset: true }], notes: [] }
  if (/(proteinziel|eiweissziel|protein|eiweiss)/.test(c) && /(aendere|andere|setze|erhohe|erhoehe|auf)/.test(c) && !withUnit.length && !nums.length)
    return { kind: 'clarify', question: 'Auf wie viel Gramm Eiweiß pro Tag soll das Ziel gesetzt werden?', options: [], notes: [] }

  // ---- Kalorienziel
  if (!/lebensmittel/.test(c) && /(kalorien|kcal|kilokalorien|kalorienziel|energiezufuhr|energieziel)/.test(c) || (/\b(essen|zu mir nehmen|aufnehmen)\b/.test(c) && nums.some(n => n.value >= 800 && /kcal|kalorien/.test(c.slice(n.end, n.end + 14))))) {
    const rel = /\bum\s+\S*\s*$/.test(c.slice(0, nums[0]?.start ?? 0)) ? (/(erhohe|steigere|mehr|plus|zusatzlich)/.test(c) ? 1 : /(senke|reduziere|verringere|weniger|minus)/.test(c) ? -1 : 0) : 0
    const num = nums.filter(n => n.value >= 100 && n.value <= 20000).sort((a, b) => Number(/kcal|kalorien/.test(c.slice(b.end, b.end + 14))) - Number(/kcal|kalorien/.test(c.slice(a.end, a.end + 14))))[0]
    const scope = when.kind === 'permanent' ? 'permanent' : when.kind === 'today' ? 'today' : when.kind === 'date' ? 'date' : null
    if (!num && !/(aendere|andere|setze|erhohe|erhoehe|senke|reduziere|will|moechte|mochte|stelle)/.test(c)) return none
    if (!num) return { kind: 'clarify', question: 'Auf wie viele Kalorien pro Tag soll das Ziel geändert werden?', options: [], pending: { intent: 'calorie_value', scope: (scope ?? 'today') as 'today', date: when.date, relative: rel || undefined }, notes: [] }
    const mk = (sc: 'today' | 'date' | 'permanent', date?: string): Command => {
      let kcal = num.value
      if (rel) { const base = sc === 'permanent' ? kcalTarget(state.profile) : state.plan ? targetFor(state.plan, date ?? today) : kcalTarget(state.profile); kcal = base + rel * num.value }
      return { type: 'update_calorie_target', kcal: Math.round(kcal), scope: sc, ...(sc === 'date' ? { date } : {}) }
    }
    if (scope) return { kind: 'commands', commands: [mk(scope as 'today', when.date)], notes: [] }
    return { kind: 'clarify', question: `Soll das Ziel von ${fmt(rel ? Math.round(kcalTarget(state.profile) + rel * num.value) : num.value)} kcal nur heute oder dauerhaft gelten?`, options: [{ label: 'Nur heute', commands: [mk('today')] }, { label: 'Dauerhaft', commands: [mk('permanent')] }], notes: [] }
  }

  // ---- Gewicht
  const kg = nums.find(n => /^\s*(kg|kilo)/.test(c.slice(n.end)))
  if (/zielgewicht|wunschgewicht/.test(c)) { const n = kg ?? nums.find(x => x.value >= 30 && x.value <= 300); if (n) return { kind: 'commands', commands: [{ type: 'update_target_weight', kg: n.value }], notes: [] } }
  if ((kg || /(wiege|gewicht)/.test(c)) && /(ich wiege|mein gewicht|gewicht (ist|betragt)|trage .*gewicht|wiege (jetzt|aktuell|heute))/.test(c)) {
    const n = kg ?? nums.find(x => x.value >= 30 && x.value <= 300)
    if (n) return /\bprofil\b/.test(c) ? { kind: 'commands', commands: [{ type: 'update_user_profile', weight_kg: n.value }], notes: [] } : { kind: 'commands', commands: [{ type: 'update_weight', kg: n.value }], notes: [] }
  }

  // ---- Ernährungsziel / Aktivität
  if (!/kalorien|kcal/.test(c)) {
    if (/(ich (will|moechte|mochte)|mein ziel ist|ernahrungsziel)/.test(c)) {
      if (/(abnehmen|gewicht reduzieren|fett verlieren)/.test(c)) return { kind: 'commands', commands: [{ type: 'update_nutrition_goal', goal: 'reduzieren' }], notes: [] }
      if (/(zunehmen|aufbauen|muskeln aufbauen|muskelaufbau|masse)/.test(c) && !/vegan|plan/.test(c)) return { kind: 'commands', commands: [{ type: 'update_nutrition_goal', goal: 'aufbauen' }], notes: [] }
      if (/(gewicht halten|halten)/.test(c)) return { kind: 'commands', commands: [{ type: 'update_nutrition_goal', goal: 'halten' }], notes: [] }
    }
    if (/(aktiv|sport|bewegung|trainiere|buro|sitzend)/.test(c) && /(ich bin|setze|aendere|andere|mein aktivitat)/.test(c)) {
      const a = /sehr aktiv|hochaktiv|taglich (intensiv|training)|leistungssport/.test(c) ? 'hoch' : /moderat|mittel|3 ?-? ?4 mal|dreimal|viermal/.test(c) ? 'moderat' : /leicht aktiv|1 ?-? ?2 mal|gelegentlich/.test(c) ? 'leicht' : /sitzend|buro|kaum (in )?bewegung|wenig (in )?bewegung/.test(c) ? 'sitzend' : null
      if (a) return { kind: 'commands', commands: [{ type: 'update_activity_level', activity: a }], notes: [] }
    }
  }

  // ---- Ernährungsformen
  const diets = DIETS.filter(([rx]) => rx.test(c)).map(([, s]) => s)
  if (diets.length && /(ich esse|ernahre mich|stelle .* um|wechsle|wechsel|umstellen|ab jetzt|nur noch|zusatzlich|kombiniere|fuge .* hinzu|fuege .* hinzu|nicht mehr|entferne|deaktiviere|ohne|aktiviere|ernahrungsform|ernahrungsweise)/.test(c) && !/rezept|tausche|ersetze/.test(c)) {
    const mode = /(nicht mehr|entferne|deaktiviere|streiche|ohne mehr)/.test(c) ? 'remove' : /(zusatzlich|zusaetzlich|auch|kombiniere|dazu|hinzu|noch)/.test(c) ? 'add' : 'set'
    return { kind: 'commands', commands: [{ type: 'set_diets', styles: diets, mode }], notes: [] }
  }

  // ---- Plan neu berechnen
  if (/(erstelle|berechne|generiere|plane)/.test(c) && /neu/.test(c) && /(plan|tag|woche|monat)/.test(c)) {
    const scope = /monat/.test(c) ? 'month' : /woche/.test(c) ? 'week' : 'day'
    return { kind: 'commands', commands: [{ type: 'regenerate_plan', scope, ...(scope === 'day' && when.kind === 'date' ? { date: when.date } : {}) }], notes: [] }
  }

  // ---- Einkaufsliste
  if (/einkaufsliste|einkaufszettel/.test(c) || /\bhake\b.*\bab\b|\bist gekauft\b/.test(c)) {
    const nm = (c.match(/(?:setze|schreibe|fuge|fuege|packe|nimm)\s+(?:bitte\s+)?(?:noch\s+)?(.+?)\s+(?:auf|zu|in)\s+(?:die|der|den|meine)\s+einkauf/) ?? c.match(/(?:streiche|entferne|loesche|losche)\s+(?:bitte\s+)?(.+?)\s+(?:von|aus)\s+(?:der|die|den|meiner|meine)\s+einkauf/) ?? c.match(/hake\s+(.+?)\s+ab/))?.[1]
    if (nm) {
      const op = /(streiche|entferne|loesche|losche)/.test(c) ? 'remove' : /hake/.test(c) ? 'check' : 'add'
      const name = nm.replace(/^(das|die|den|der|einen|eine|ein)\s+/, '').trim()
      return { kind: 'commands', commands: [{ type: 'update_shopping_list', op, name: titleCase(name) }], notes: [] }
    }
  }

  // ---- Mahlzeiten
  const slot = slotOf(c)
  if (slot || /\bmahlzeit\b/.test(c)) {
    const plan = state.plan, date = when.kind === 'date' ? when.date! : today
    const day = plan?.days.find(d => d.date === date)
    if (/(tausche|ersetze|wechsle|aendere|andere|anderes|alternative)/.test(c) && /(tausch|ersetz|wechsl|alternativ|anders|aender|ander)/.test(c)) {
      if (!plan || !day) return { kind: 'clarify', question: plan ? `Für ${date} gibt es keinen Plan. Welcher Tag ist gemeint?` : 'Es gibt noch keinen Plan.', options: [], notes: [] }
      const meal = day.meals.find(m => m.slot === slot) ?? (slot ? undefined : day.meals[0])
      if (!meal) return { kind: 'clarify', question: `Am ${date} gibt es kein ${slot ? SLOT_LABEL[slot] : 'Gericht'} im Plan.`, options: [], notes: [] }
      const ctx = buildContext(state.foods, state.recipes, state.prefs), kc = mealMacros(meal, ctx.recipes, ctx.foods, ctx.oils).kcal
      const alts = alternativesFor(meal.slot, kc, ctx, [meal.recipeId], 3)
      if (!alts.length) return { kind: 'clarify', question: 'Mit deinen Einstellungen gibt es keine passende Alternative.', options: [], notes: [] }
      return { kind: 'clarify', question: `Wodurch soll ${ctx.recipes.get(meal.recipeId)?.name} (${SLOT_LABEL[meal.slot]}, ${date}) ersetzt werden?`, options: alts.map(a => ({ label: `${a.recipe.name} (≈ ${Math.round(a.kcal)} kcal)`, commands: [{ type: 'swap_meal', date, meal_id: meal.id, recipe_id: a.recipe.id }] })), notes: [] }
    }
    if (/(loesche|losche|entferne|streiche|lass .* weg)/.test(c) && day) { const meal = day.meals.find(m => m.slot === slot); if (meal) return { kind: 'commands', commands: [{ type: 'remove_meal', date, meal_id: meal.id }], notes: [] } }
    if (/(fuge|fuege|ergaenze|erganze).*(hinzu)|noch (ein|einen|eine)/.test(c) && slot && day) {
      const ctx = buildContext(state.foods, state.recipes, state.prefs)
      const alts = alternativesFor(slot, 250, ctx, day.meals.map(m => m.recipeId), 3)
      if (alts.length) return { kind: 'clarify', question: `Welche Mahlzeit (${SLOT_LABEL[slot]}) soll am ${date} ergänzt werden?`, options: alts.map(a => ({ label: `${a.recipe.name} (≈ ${Math.round(a.kcal)} kcal)`, commands: [{ type: 'add_meal', date, slot, recipe_id: a.recipe.id }] })), notes: [] }
    }
    const meal = day?.meals.find(m => m.slot === slot)
    if (meal && /(grosser|groesser|kleiner|halbiere|verdopple|portion|prozent|%)/.test(c)) {
      const pct = nums.find(n => /^\s*(%|prozent)/.test(c.slice(n.end)))
      let f: number | null = null
      if (/halbiere/.test(c)) f = meal.factor / 2; else if (/verdopple/.test(c)) f = meal.factor * 2
      else if (pct && /grosser|groesser|mehr/.test(c)) f = meal.factor * (1 + pct.value / 100); else if (pct && /kleiner|weniger/.test(c)) f = meal.factor * (1 - pct.value / 100)
      else { const n = nums.find(x => x.value > 0 && x.value <= 3 && /portion|fach|x\b/.test(c.slice(Math.max(0, x.start - 10), x.end + 10))); if (n) f = n.value }
      if (f !== null) return { kind: 'commands', commands: [{ type: 'set_portion', date, meal_id: meal.id, portion_factor: Math.round(f * 100) / 100 }], notes: [] }
    }
  }

  // ---- Lebensmittel hinzufügen (Nutzerwerte)
  if (/(fuge|fuege|lege).*(lebensmittel).*(hinzu|an)/.test(c) || /neues lebensmittel/.test(c)) {
    const name = c.match(/(?:lebensmittel|namens|genannt)\s+([a-z0-9 -]+?)(?:\s+(?:hinzu|an|mit|pro|je)\b|$)/)?.[1]?.trim()
    const pick = (rx: RegExp, unit: RegExp) => { const m = c.match(rx); return m ? nums.filter(n => unit.test(c.slice(n.end, n.end + 12)) || true).sort((a, b) => Math.abs(a.start - (m.index ?? 0)) - Math.abs(b.start - (m.index ?? 0)))[0]?.value : undefined }
    const kc = nums.find(n => /^\s*(kcal|kalorien)/.test(c.slice(n.end)))?.value ?? pick(/(kalorien|kcal)/, /kcal/)
    const pr = nums.find(n => /^\s*(g|gramm)\s+(eiweiss|protein)/.test(c.slice(n.end)))?.value, ch = nums.find(n => /^\s*(g|gramm)\s+kohlenhydrat/.test(c.slice(n.end)))?.value, ft = nums.find(n => /^\s*(g|gramm)\s+fett/.test(c.slice(n.end)))?.value
    if (name && kc !== undefined && pr !== undefined && ch !== undefined && ft !== undefined) {
      const vals = { kcal: kc, protein: pr, carbs: ch, fat: ft }
      const cmd: Command = { type: 'add_food', name: titleCase(name), per100: vals, user_stated: true }
      if (/(pro|je) 100 ?(g|gramm)/.test(c)) return { kind: 'commands', commands: [cmd], notes: [] }
      return { kind: 'clarify', question: `Beziehen sich die Werte (${kc} kcal, ${pr} g Eiweiß, ${ch} g Kohlenhydrate, ${ft} g Fett) auf 100 g?`, options: [{ label: 'Ja, pro 100 g', commands: [cmd] }], pending: { intent: 'food_per100', name: titleCase(name), vals }, notes: [] }
    }
    return { kind: 'clarify', question: 'Nenne bitte Name und Nährwerte pro 100 g (Kalorien, Eiweiß, Kohlenhydrate, Fett). Ich erfinde keine Werte.', options: [], notes: [] }
  }

  // ---- Lebensmittel-Präferenzen
  const pref = (() => {
    const ex = c.match(/(?:schliesse|schliess)\s+(.+?)\s+aus\b|\bich (?:mag|esse) (?:kein|keine|keinen|keinem)\s+(.+?)(?:\s+mehr)?$|\bohne\s+(.+)$|\b(?:streiche|sperre)\s+(.+?)\s+(?:aus dem plan|vom plan)/)
    if (ex) return { p: 'excluded' as const, name: ex[1] ?? ex[2] ?? ex[3] ?? ex[4] }
    const pf = c.match(/(?:bevorzuge|bevorzuge mehr|mehr von|ich mag)\s+(?:bitte\s+)?(?:mehr\s+)?(.+?)(?:\s+besonders|\s+gerne|\s+sehr)?$/)
    if (pf && !/kein|keine/.test(c)) return { p: 'preferred' as const, name: pf[1] }
    const fv = c.match(/(?:fuge|fuege|setze|nimm)\s+(.+?)\s+(?:zu|in|auf)\s+(?:die\s+|meine\s+|meinen\s+|den\s+)?favorit/)
    if (fv) return { p: 'favorite' as const, name: fv[1] }
    const al = c.replace(/^(?:ich\s+(?:moechte|mochte|will)\s+|bitte\s+)/, '').match(/(.+?)\s+wieder\s+(?:erlauben|zulassen)/)
    if (al) return { p: 'allowed' as const, name: al[1] }
    return null
  })()
  if (pref && pref.name) {
    const words = pref.name.replace(/^(das|die|den|der|einen|eine|ein|bitte)\s+/, '').split(' ').filter(Boolean)
    for (let n = Math.min(3, words.length); n >= 1; n--) {
      const q = words.slice(0, n).join(' ')
      const f = findFood(state.foods, q)
      if (f.food) return { kind: 'commands', commands: [{ type: 'update_food_preferences', food_name: f.food.name, preference: pref.p }], notes: [] }
      const cands = state.foods.filter(x => fold(x.name).startsWith(fold(q)) || fold(x.name).includes(` ${fold(q)}`)).slice(0, 4)
      if (cands.length > 1) return { kind: 'clarify', question: `Welches Lebensmittel ist „${q}“ gemeint?`, options: cands.map(x => ({ label: x.name, commands: [{ type: 'update_food_preferences', food_name: x.name, preference: pref.p }] })), notes: [] }
    }
    return { kind: 'clarify', question: `„${words.join(' ')}“ finde ich nicht in deiner Lebensmittelliste. Wie heißt es dort genau?`, options: [], notes: [] }
  }
  void rawHas; void STYLE_LABEL; void whenNote
  return none
}

const whenNote = (_: When) => ''
const titleCase = (s: string) => s.split(' ').map(w => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ')

/** Antwort auf eine Rückfrage (z. B. „3000“ nach „Auf wie viele Kalorien …?“). */
export function followUp(pending: Pending, text: string, input: NluInput): NluResult {
  const t = fold(text)
  if (pending.intent === 'calorie_value') {
    const n = findNumbers(t).find(x => x.value >= 100 && x.value <= 20000)
    if (!n) return { kind: 'clarify', question: 'Ich habe keine Zahl verstanden. Auf wie viele Kalorien soll das Ziel geändert werden?', options: [], pending, notes: [] }
    const base = pending.relative ? (pending.scope === 'permanent' || !input.state.plan ? kcalTarget(input.state.profile) : targetFor(input.state.plan, pending.date ?? input.today)) : 0
    const kcal = pending.relative ? base + pending.relative * n.value : n.value
    const when = parseWhen(t, input.today)
    const scope = when.kind === 'permanent' ? 'permanent' : when.kind === 'date' ? 'date' : pending.scope
    return { kind: 'commands', commands: [{ type: 'update_calorie_target', kcal: Math.round(kcal), scope, ...(scope === 'date' ? { date: when.date ?? pending.date } : {}) }], notes: [] }
  }
  if (/^(ja|jap|genau|stimmt|richtig|pro 100)/.test(t)) return { kind: 'commands', commands: [{ type: 'add_food', name: pending.name, per100: pending.vals, user_stated: true }], notes: [] }
  return { kind: 'none' }
}
