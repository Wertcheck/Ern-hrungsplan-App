/**
 * Zugriff auf den Bundeslebensmittelschlüssel (BLS 4.0, Max Rubner-Institut, CC BY 4.0).
 * Der vollständige Datensatz (7.140 Lebensmittel) wird erst bei Bedarf geladen (Code-Splitting) und in einen Suchindex überführt.
 * BLS enthält keine Allergeninformationen: übernommene Lebensmittel gelten als „Allergene unbekannt“.
 */
import type { AnimalOrigin, Category, Food, FoodGroup, MicroKey, Prep } from './types'
import { MICRO_KEYS } from './types'

export interface BlsMeta {
  dataset: string; version: string; publisher: string; doi: string; license: string; licenseUrl: string; citation: string; retrieved: string
  archiveSha256: string; foodCount: number; groupLabels: Record<string, string>; flagsLegend: Record<string, string>
  carbsDefinition: string; units: string
}
export interface BlsEntry {
  code: string; de: string; en: string; group: string
  kcal: number | null; protein: number | null; fat: number | null; carbs: number | null; fiber: number | null
  micros: Partial<Record<MicroKey, number>>
  flags: Record<string, string>
  prep: Prep
  /** normalisierter Suchtext */
  norm: string
  /** Suchtext ohne Leerzeichen (findet Zusammenschreibungen wie „Haferflocken“ für „Hafer Flocken“) */
  joined: string
}
export interface BlsIndex { meta: BlsMeta; entries: BlsEntry[]; byCode: Map<string, BlsEntry> }
export interface RawBls { meta: BlsMeta; fields: string[]; rows: (string | number | null)[][] }

export const normalize = (s: string) =>
  s.toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ae/g, 'a').replace(/oe/g, 'o').replace(/ue/g, 'u').replace(/[^a-z0-9% ]+/g, ' ').replace(/\s+/g, ' ').trim()

export function prepFromName(name: string, code: string): Prep {
  if (/konserve|abgetropft/i.test(name)) return 'konserviert'
  if (/getrocknet|pulver|trocken/i.test(name)) return 'getrocknet'
  if (/gekocht|gedünstet|gebraten|gegrillt|gebacken|geschmort|gedämpft|pochiert|gegart|frittiert|blanchiert|gargezogen/i.test(name)) return 'gekocht'
  if (/\broh\b|tiefgefroren/i.test(name) || code.slice(-3) === '100') return 'roh'
  return 'verarbeitet'
}

export function buildIndex(raw: RawBls): BlsIndex {
  const f = (n: string) => raw.fields.indexOf(n)
  const idx = Object.fromEntries(raw.fields.map((n, i) => [n, i]))
  const entries: BlsEntry[] = raw.rows.map(r => {
    const flags: Record<string, string> = {}
    const fl = String(r[idx.flags] ?? '')
    if (fl) for (const p of fl.split(',')) { const [k, v] = p.split(':'); flags[k] = v }
    const micros: Partial<Record<MicroKey, number>> = {}
    for (const k of MICRO_KEYS) { const v = r[idx[k]]; if (typeof v === 'number') micros[k] = v }
    const num = (n: string) => (typeof r[idx[n]] === 'number' ? (r[idx[n]] as number) : null)
    const de = String(r[idx.de]), code = String(r[idx.code])
    return {
      code, de, en: String(r[idx.en] ?? ''), group: String(r[idx.group]),
      kcal: num('kcal'), protein: num('protein'), fat: num('fat'), carbs: num('carbs'), fiber: num('fiber'),
      micros, flags, prep: prepFromName(de, code), norm: normalize(`${de} ${r[idx.en] ?? ''}`), joined: normalize(de).replace(/ /g, ''),
    }
  })
  void f
  return { meta: raw.meta, entries, byCode: new Map(entries.map(e => [e.code, e])) }
}

let cache: Promise<BlsIndex> | null = null
/** Lädt den Datensatz einmalig (dynamischer Import → eigener Chunk, vom Service Worker für Offline gecacht). */
export function loadBls(): Promise<BlsIndex> {
  cache ??= import('../data/bls/bls40.json').then(m => buildIndex((m.default ?? m) as unknown as RawBls)).catch(e => { cache = null; throw e })
  return cache
}

export interface BlsQuery { text?: string; groups?: string[]; preps?: Prep[]; basicOnly?: boolean; withMicros?: boolean; limit?: number }
export interface BlsHit { entry: BlsEntry; score: number }
/** Gruppen, die zusammengesetzte Gerichte/Soßen/Backwaren enthalten (für „nur Grundlebensmittel“) */
export const COMPOSITE_GROUPS = new Set(['X', 'Y', 'D'])

export function searchBls(index: BlsIndex, q: BlsQuery): BlsHit[] {
  const tokens = normalize(q.text ?? '').split(' ').filter(Boolean)
  const full = tokens.join(' ')
  const limit = q.limit ?? 50
  const hits: BlsHit[] = []
  for (const e of index.entries) {
    if (q.groups?.length && !q.groups.includes(e.group)) continue
    if (q.preps?.length && !q.preps.includes(e.prep)) continue
    if (q.basicOnly && COMPOSITE_GROUPS.has(e.group)) continue
    if (q.withMicros && Object.keys(e.micros).length < 8) continue
    let score = 0
    if (tokens.length) {
      const words = e.norm.split(' ')
      let ok = true
      for (const t of tokens) {
        if (words.some(w => w === t)) score += 30
        else if (words.some(w => w.startsWith(t))) score += 20
        else if (e.norm.includes(t)) score += 6
        else if (t.length >= 5 && e.joined.includes(t)) score += 4
        else { ok = false; break }
      }
      if (!ok) continue
      if (e.norm === full || e.norm.startsWith(full + ' ')) score += 40
      // Der gesamte Name entspricht der Anfrage (ohne Leerzeichen, z. B. „Haferflocken“ = „Hafer Flocken“): stärkstes Signal
      if (e.joined === tokens.join('')) score += 75
      if (e.norm.startsWith(full)) score += 15
      score -= Math.min(20, e.norm.length / 8)
      if (e.prep === 'roh') score += 4
    } else score = -e.norm.length
    hits.push({ entry: e, score })
  }
  hits.sort((a, b) => b.score - a.score || a.entry.de.localeCompare(b.entry.de, 'de'))
  return hits.slice(0, limit)
}

const SHELLFISH = /Garnele|Krabbe|Krebs|Hummer|Languste|Muschel|Auster|Tintenfisch|Kalmar|Krake|Scampi|Shrimp|Schnecke/i
const LEGUME = /Linse|Bohne|Erbse|Kichererbse|Soja|Lupine|Erdnuss|Tofu|Tempeh|Sojadrink/i

/** Anzeigekategorie und funktionelle Gruppe aus BLS-Hauptgruppe und Namen (Heuristik, vom Nutzer anpassbar). */
export function classify(e: Pick<BlsEntry, 'group' | 'de'>): { category: Category; group: FoodGroup } {
  const { group: g, de } = e
  if (LEGUME.test(de) && ['G', 'H', 'C'].includes(g)) return { category: 'getreide', group: 'huelsenfrucht' }
  switch (g) {
    case 'B': case 'C': case 'D': return { category: 'getreide', group: 'getreide' }
    case 'E': return /Ei\b|Eier|Hühnerei|Eigelb|Eiklar|Eipulver/i.test(de) && !/Teigwaren/i.test(de) ? { category: 'sonstige', group: 'ei' } : { category: 'getreide', group: 'getreide' }
    case 'F': return { category: 'obst', group: 'obst' }
    case 'G': case 'K': return /Stärke|Mehl|Tapioka|Pulver/i.test(de) ? { category: 'sonstige', group: 'sonstige' } : { category: 'gemuese', group: 'gemuese' }
    case 'H': return /Oliven/i.test(de) ? { category: 'gemuese', group: 'gemuese' } : { category: 'nuesse', group: 'nuss_samen' }
    case 'M': return { category: 'milch', group: 'milch' }
    case 'N': case 'P': return { category: 'getraenke', group: 'getraenk' }
    case 'Q': return { category: 'oele', group: 'oel_fett' }
    case 'R': return { category: 'gewuerze', group: 'gewuerz' }
    case 'S': return { category: 'sonstige', group: 'zucker' }
    case 'T': return SHELLFISH.test(de) ? { category: 'fisch', group: 'schalentiere' } : { category: 'fisch', group: 'fisch' }
    case 'U': case 'V': case 'W': return { category: 'fleisch', group: 'fleisch' }
    default: return { category: 'sonstige', group: 'sonstige' }
  }
}

/**
 * Tierische Herkunft. Konservativ: nur eindeutige Grundlebensmittel gelten als „none“; alles Zusammengesetzte
 * (Gerichte, Soßen, Backwaren, Süßwaren, Margarine …) ist „unknown“ und wird bei vegan/vegetarisch/carnivore NICHT verwendet.
 */
export function animalOrigin(e: Pick<BlsEntry, 'group' | 'de'>): AnimalOrigin {
  const { group: g, de } = e
  if (/Fleisch|Schwein|Rind|Kalb|Huhn|Hähnchen|Pute|Ente|Gans|Lamm|Schaf|Wild|Speck|Schinken|Wurst|Leber|Gelatine|Schmalz|Talg/i.test(de)) return g === 'T' ? 'fish' : 'meat'
  switch (g) {
    case 'T': return 'fish'
    case 'U': case 'V': case 'W': return 'meat'
    case 'M': return 'dairy'
    case 'E': return /Teigwaren/i.test(de) ? (/eifrei/i.test(de) ? 'none' : 'egg') : 'egg'
    case 'S': return /^Honig|Blütenhonig|Honigtau/i.test(de) ? 'honey' : /Zucker|Sirup|Agave|Ahorn/i.test(de) && !/Schoko|Milch|Sahne/i.test(de) ? 'none' : 'unknown'
    case 'Q': return /Butter/i.test(de) ? 'dairy' : /öl\b|Öl\b|Kokosfett|^[A-Za-zäöüÄÖÜ]+öl/.test(de) && !/Margarine|Mayonnaise/i.test(de) ? 'none' : 'unknown'
    case 'F': case 'G': case 'K': case 'C': return /Ei|Milch|Käse|Sahne|Butter|Quark|Joghurt|Speck|Fleisch|Fisch|Honig|Pudding/.test(de) ? 'unknown' : 'none'
    case 'H': return /Ei|Milch|Käse|Sahne|Butter|Quark|Joghurt|Honig|Schokolade|Pudding/.test(de) ? 'unknown' : 'none'
    default: return 'unknown'
  }
}

export const isBlsFood = (f: Pick<Food, 'sourceRef'>) => /BLS|Bundeslebensmittelschlüssel/.test(f.sourceRef?.name ?? '')
export const hasBlsCode = (foods: Food[], code: string) => foods.some(f => f.sourceRef?.id === code && isBlsFood(f))

/** Wandelt einen BLS-Eintrag in ein App-Lebensmittel um. Fehlende Werte bleiben ehrlich als „Daten fehlen“ markiert. */
export function blsToFood(e: BlsEntry, meta: BlsMeta): Food {
  const { category, group } = classify(e)
  const complete = e.kcal !== null && e.protein !== null && e.fat !== null && e.carbs !== null
  return {
    id: `bls-${e.code}`, name: e.de, category, kcal: e.kcal ?? 0, protein: e.protein ?? 0, carbs: e.carbs ?? 0, fat: e.fat ?? 0, fiber: e.fiber ?? 0,
    missingFields: (['kcal', 'protein', 'fat', 'carbs', 'fiber'] as const).filter(k => e[k] === null),
    allergens: [], traces: [], allergenInfoKnown: false, animal: animalOrigin(e), group, prep: e.prep,
    micros: Object.keys(e.micros).length ? { ...e.micros } : undefined,
    source: `${meta.dataset} ${meta.version}, Code ${e.code}`, dataQuality: complete ? 'verified' : 'missing',
    sourceRef: { name: `${meta.dataset} ${meta.version}`, id: e.code, license: meta.license, retrieved: meta.retrieved },
    custom: true,
  }
}
