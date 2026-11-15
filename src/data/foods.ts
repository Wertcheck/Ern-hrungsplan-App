import blsMapped from './bls/mapped.json'
import type { Allergen, AnimalOrigin, Category, Food, FoodGroup, OilProps, Prep } from '../domain/types'

/** Bei jeder Änderung der eingebauten Daten erhöhen – frischt gespeicherte Standarddaten auf. */
export const BUILTIN_DATA_VERSION = 3

export const SOURCE_NOTE =
  'Gerundeter Richtwert in Anlehnung an USDA FoodData Central (Public Domain / CC0). Nicht einzeln gegen die Quelle geprüft.'

type Row = [id: string, name: string, cat: Category, kcal: number, p: number, c: number, f: number, fiber: number,
  allergens?: Allergen[], animal?: AnimalOrigin, extra?: Partial<Food>]

const A = (...a: Allergen[]) => a
const oil = (warmOk: boolean, coldOk: boolean, smokePointC: number, note: string): OilProps => ({ warmOk, coldOk, smokePointC, note })
const OIL_X = { unit: { label: 'EL', grams: 10 } }

const ROWS: Row[] = [
  // Gemüse
  ['tomate', 'Tomate', 'gemuese', 18, 0.9, 3.9, 0.2, 1.2, A('histamin'), 'none', { basic: true }],
  ['gurke', 'Gurke', 'gemuese', 15, 0.7, 3.6, 0.1, 0.5, A(), 'none', { basic: true }],
  ['paprika', 'Paprika', 'gemuese', 31, 1.0, 6, 0.3, 2.1, A(), 'none', { basic: true }],
  ['zucchini', 'Zucchini', 'gemuese', 17, 1.2, 3.1, 0.3, 1, A(), 'none', { basic: true }],
  ['brokkoli', 'Brokkoli', 'gemuese', 34, 2.8, 7, 0.4, 2.6, A(), 'none', { basic: true }],
  ['karotte', 'Karotte', 'gemuese', 41, 0.9, 10, 0.2, 2.8, A(), 'none', { basic: true }],
  ['spinat', 'Spinat', 'gemuese', 23, 2.9, 3.6, 0.4, 2.2, A('histamin'), 'none', { basic: true }],
  ['blumenkohl', 'Blumenkohl', 'gemuese', 25, 1.9, 5, 0.3, 2, A(), 'none', { basic: true }],
  ['suesskartoffel', 'Süßkartoffel', 'gemuese', 86, 1.6, 20, 0.1, 3, A(), 'none', { basic: true }],
  ['kartoffel', 'Kartoffel', 'gemuese', 77, 2, 17, 0.1, 2.2, A(), 'none', { basic: true }],
  ['zwiebel', 'Zwiebel', 'gemuese', 40, 1.1, 9, 0.1, 1.7, A('fruktose'), 'none', { basic: true }],
  ['knoblauch', 'Knoblauch', 'gemuese', 149, 6.4, 33, 0.5, 2.1, A('fruktose'), 'none', { basic: true }],
  ['rucola', 'Rucola', 'gemuese', 25, 2.6, 3.7, 0.7, 1.6, A(), 'none', { basic: true }],
  ['feldsalat', 'Feldsalat', 'gemuese', 21, 2, 3.6, 0.4, 1.8, A(), 'none', { basic: true }],
  ['kuerbis', 'Kürbis', 'gemuese', 26, 1, 6.5, 0.1, 0.5, A(), 'none', { basic: true }],
  ['aubergine', 'Aubergine', 'gemuese', 25, 1, 6, 0.2, 3, A('histamin'), 'none', { basic: true }],
  ['fenchel', 'Fenchel', 'gemuese', 31, 1.2, 7, 0.2, 3.1, A(), 'none', { basic: true }],
  ['champignons', 'Champignons', 'gemuese', 22, 3.1, 3.3, 0.3, 1, A(), 'none', { basic: true }],
  ['spargel', 'Spargel', 'gemuese', 20, 2.2, 3.9, 0.1, 2.1, A(), 'none', { basic: true }],
  ['erbsen', 'Erbsen (TK)', 'gemuese', 81, 5.4, 14, 0.4, 5.1, A(), 'none', { basic: true }],
  ['lauch', 'Lauch', 'gemuese', 31, 1.8, 7, 0.3, 2.6, A('fruktose'), 'none', { basic: true }],
  ['rotebete', 'Rote Bete', 'gemuese', 43, 1.6, 10, 0.2, 2.8, A(), 'none', { basic: true }],
  // Obst
  ['apfel', 'Apfel', 'obst', 52, 0.3, 14, 0.2, 2.4, A('fruktose'), 'none', { basic: true, unit: { label: 'Stück', grams: 150 } }],
  ['banane', 'Banane', 'obst', 89, 1.1, 23, 0.3, 2.6, A('fruktose'), 'none', { basic: true, unit: { label: 'Stück', grams: 120 } }],
  ['blaubeeren', 'Blaubeeren', 'obst', 57, 0.7, 14, 0.3, 2.4, A(), 'none', { basic: true }],
  ['himbeeren', 'Himbeeren', 'obst', 52, 1.2, 12, 0.7, 6.5, A(), 'none', { basic: true }],
  ['erdbeeren', 'Erdbeeren', 'obst', 32, 0.7, 7.7, 0.3, 2, A('histamin'), 'none', { basic: true }],
  ['zitrone', 'Zitrone', 'obst', 29, 1.1, 9, 0.3, 2.8, A(), 'none', { basic: true }],
  ['birne', 'Birne', 'obst', 57, 0.4, 15, 0.1, 3.1, A('fruktose'), 'none', { basic: true }],
  ['mango', 'Mango', 'obst', 60, 0.8, 15, 0.4, 1.6, A('fruktose'), 'none', { basic: true, special: true }],
  ['kiwi', 'Kiwi', 'obst', 61, 1.1, 15, 0.5, 3, A('histamin'), 'none', { basic: true }],
  ['avocado', 'Avocado', 'obst', 160, 2, 8.5, 14.7, 6.7, A('histamin'), 'none', { basic: true }],
  ['rosinen', 'Rosinen', 'obst', 299, 3.1, 79, 0.5, 3.7, A('fruktose'), 'none'],
  ['datteln', 'Datteln', 'obst', 282, 2.5, 75, 0.4, 8, A('fruktose'), 'none'],
  // Fleisch
  ['haehnchen', 'Hähnchenbrust', 'fleisch', 120, 22.5, 0, 2.6, 0, A(), 'meat'],
  ['pute', 'Putenbrust', 'fleisch', 114, 24, 0, 1.5, 0, A(), 'meat'],
  ['rindhack', 'Rinderhack (mager)', 'fleisch', 137, 21, 0, 5, 0, A(), 'meat'],
  ['schweinefilet', 'Schweinefilet', 'fleisch', 120, 21, 0, 3.5, 0, A(), 'meat'],
  ['kochschinken', 'Kochschinken', 'fleisch', 107, 18, 1, 3.5, 0, A('histamin'), 'meat'],
  // Fisch
  ['lachs', 'Lachsfilet', 'fisch', 208, 20, 0, 13, 0, A('fisch'), 'fish'],
  ['thunfisch', 'Thunfisch (Dose, im eigenen Saft)', 'fisch', 116, 26, 0, 1, 0, A('fisch', 'histamin'), 'fish'],
  ['forelle', 'Forellenfilet', 'fisch', 119, 20, 0, 4, 0, A('fisch'), 'fish'],
  ['kabeljau', 'Kabeljaufilet', 'fisch', 82, 18, 0, 0.7, 0, A('fisch'), 'fish'],
  ['garnelen', 'Garnelen', 'fisch', 85, 20, 0, 0.5, 0, A('schalentiere'), 'fish'],
  // Milchprodukte & Eier
  ['joghurt', 'Naturjoghurt (3,5 %)', 'milch', 61, 3.5, 4.7, 3.3, 0, A('laktose', 'milch'), 'dairy'],
  ['skyr', 'Skyr (natur)', 'milch', 63, 11, 4, 0.2, 0, A('laktose', 'milch'), 'dairy'],
  ['quark', 'Magerquark', 'milch', 67, 12, 4, 0.3, 0, A('laktose', 'milch'), 'dairy'],
  ['feta', 'Feta', 'milch', 264, 14, 4, 21, 0, A('laktose', 'milch', 'histamin'), 'dairy'],
  ['parmesan', 'Parmesan', 'milch', 392, 36, 3, 28, 0, A('milch', 'histamin'), 'dairy'],
  ['ei', 'Hühnerei', 'sonstige', 143, 12.6, 0.7, 9.5, 0, A('eier'), 'egg', { unit: { label: 'Stück', grams: 55 } }],
  // Getreide & Hülsenfrüchte (Rohgewicht, sofern nicht anders angegeben)
  ['haferflocken', 'Haferflocken', 'getreide', 372, 13.5, 59, 7, 10, A('gluten'), 'none'],
  ['quinoa', 'Quinoa (roh)', 'getreide', 368, 14, 64, 6, 7, A(), 'none', { basic: true }],
  ['naturreis', 'Naturreis (roh)', 'getreide', 362, 7.5, 76, 2.7, 3.5, A(), 'none'],
  ['hirse', 'Hirse (roh)', 'getreide', 378, 11, 73, 4, 8.5, A(), 'none', { basic: true }],
  ['buchweizen', 'Buchweizen (roh)', 'getreide', 343, 13, 72, 3.4, 10, A(), 'none', { basic: true }],
  ['vollkornnudeln', 'Vollkornnudeln (roh)', 'getreide', 350, 13, 66, 2.5, 8, A('gluten'), 'none'],
  ['vollkornbrot', 'Vollkornbrot', 'getreide', 215, 8, 38, 2, 7, A('gluten'), 'none', { unit: { label: 'Scheibe', grams: 45 } }],
  ['linsen', 'Rote Linsen (roh)', 'getreide', 352, 24, 60, 1.1, 11, A('fruktose'), 'none', { basic: true }],
  ['kichererbsen', 'Kichererbsen (Dose, abgetropft)', 'getreide', 139, 7, 18, 2.6, 5, A(), 'none', { basic: true }],
  ['kidneybohnen', 'Kidneybohnen (Dose, abgetropft)', 'getreide', 100, 7, 14, 0.5, 6, A(), 'none', { basic: true }],
  ['tofu', 'Tofu natur', 'getreide', 76, 8, 1.9, 4.8, 0.3, A('soja'), 'none'],
  ['haferdrink', 'Haferdrink', 'getraenke', 45, 1, 6.5, 1.4, 0.8, A('gluten'), 'none'],
  ['sojadrink', 'Sojadrink (ungesüßt)', 'getraenke', 33, 3, 0.5, 1.8, 0.5, A('soja'), 'none'],
  ['mandeldrink', 'Mandeldrink (ungesüßt)', 'getraenke', 24, 0.6, 3, 1.1, 0.4, A('nuesse'), 'none'],
  // Nüsse & Samen
  ['walnuss', 'Walnüsse', 'nuesse', 654, 15, 7, 65, 6.7, A('nuesse'), 'none'],
  ['mandeln', 'Mandeln', 'nuesse', 579, 21, 22, 50, 12.5, A('nuesse'), 'none', { basic: true }],
  ['haselnuss', 'Haselnüsse', 'nuesse', 628, 15, 17, 61, 10, A('nuesse'), 'none'],
  ['erdnussmus', 'Erdnussmus', 'nuesse', 588, 25, 20, 50, 6, A('erdnuesse'), 'none'],
  ['chia', 'Chiasamen', 'nuesse', 486, 17, 42, 31, 34, A(), 'none', { basic: true }],
  ['leinsamen', 'Leinsamen', 'nuesse', 534, 18, 29, 42, 27, A(), 'none', { basic: true }],
  ['sonnenblumenkerne', 'Sonnenblumenkerne', 'nuesse', 584, 21, 20, 51, 8.6, A(), 'none', { basic: true }],
  ['kuerbiskerne', 'Kürbiskerne', 'nuesse', 559, 30, 11, 49, 6, A(), 'none', { basic: true }],
  // Öle & Fette (Platzhalter-Kompatibilität: 1 EL ≈ 10 g)
  ['olivenoel', 'Olivenöl (nativ extra)', 'oele', 884, 0, 0, 100, 0, A(), 'none', { ...OIL_X, oil: oil(true, true, 190, 'Vielseitig: kalt und zum schonenden Braten.') }],
  ['rapsoel', 'Rapsöl', 'oele', 884, 0, 0, 100, 0, A(), 'none', { ...OIL_X, oil: oil(true, true, 200, 'Neutral im Geschmack, gut zum Braten und für Salate.') }],
  ['leinoel', 'Leinöl', 'oele', 884, 0, 0, 100, 0, A(), 'none', { ...OIL_X, oil: oil(false, true, 107, 'Nur kalt verwenden (nicht erhitzen).') }],
  ['walnussoel', 'Walnussöl', 'oele', 884, 0, 0, 100, 0, A('nuesse'), 'none', { ...OIL_X, oil: oil(false, true, 160, 'Nur kalt verwenden, nussiges Aroma.') }],
  ['kokosoel', 'Kokosöl', 'oele', 862, 0, 0, 100, 0, A(), 'none', { ...OIL_X, oil: oil(true, true, 175, 'Hitzestabil, hoher Anteil gesättigter Fette.') }],
  ['avocadooel', 'Avocadoöl', 'oele', 884, 0, 0, 100, 0, A(), 'none', { ...OIL_X, special: true, oil: oil(true, true, 250, 'Sehr hitzestabil, mild im Geschmack.') }],
  ['butter', 'Butter', 'oele', 717, 0.9, 0.1, 81, 0, A('laktose', 'milch'), 'dairy', { ...OIL_X, oil: oil(true, true, 150, 'Nur bei mittlerer Hitze braten.') }],
  ['ghee', 'Ghee', 'oele', 876, 0.3, 0, 99.5, 0, A('milch'), 'dairy', { ...OIL_X, oil: oil(true, true, 250, 'Hitzestabil; praktisch laktosefrei, enthält aber Milchbestandteile.') }],
  // Gewürze & Kräuter
  ['basilikum', 'Basilikum', 'gewuerze', 23, 3.2, 2.7, 0.6, 1.6, A(), 'none', { basic: true }],
  ['petersilie', 'Petersilie', 'gewuerze', 36, 3, 6.3, 0.8, 3.3, A(), 'none', { basic: true }],
  ['schnittlauch', 'Schnittlauch', 'gewuerze', 30, 3.3, 4.4, 0.7, 2.5, A(), 'none', { basic: true }],
  ['ingwer', 'Ingwer', 'gewuerze', 80, 1.8, 18, 0.8, 2, A(), 'none', { basic: true }],
  ['kurkuma', 'Kurkuma', 'gewuerze', 312, 10, 67, 3.3, 22, A(), 'none'],
  ['zimt', 'Zimt', 'gewuerze', 247, 4, 81, 1.2, 53, A(), 'none'],
  ['kreuzkuemmel', 'Kreuzkümmel', 'gewuerze', 375, 18, 44, 22, 11, A(), 'none'],
  ['paprikapulver', 'Paprikapulver', 'gewuerze', 282, 14, 54, 13, 35, A(), 'none'],
  // Getränke
  ['wasser', 'Wasser', 'getraenke', 0, 0, 0, 0, 0, A(), 'none'],
  ['gruentee', 'Grüner Tee (ungesüßt)', 'getraenke', 1, 0, 0, 0, 0, A(), 'none'],
  ['kaffee', 'Kaffee (schwarz)', 'getraenke', 2, 0.3, 0, 0, 0, A(), 'none'],
  // Sonstiges
  ['honig', 'Honig', 'sonstige', 304, 0.3, 82, 0, 0.2, A('fruktose'), 'honey'],
  ['ahornsirup', 'Ahornsirup', 'sonstige', 260, 0, 67, 0, 0, A(), 'none'],
  ['tomatenmark', 'Tomatenmark', 'sonstige', 82, 4.3, 19, 0.5, 4, A('histamin'), 'none'],
  ['passata', 'Passata', 'sonstige', 32, 1.6, 6, 0.2, 1.5, A('histamin'), 'none'],
  ['gemuesebruehe', 'Gemüsebrühe', 'sonstige', 3, 0.2, 0.4, 0.1, 0, A(), 'none'],
  ['kokosmilch', 'Kokosmilch', 'sonstige', 197, 2, 3, 21, 0, A(), 'none'],
  ['sojasauce', 'Sojasauce', 'sonstige', 53, 8, 5, 0.6, 0.8, A('soja', 'gluten', 'histamin'), 'none'],
  ['balsamico', 'Balsamico-Essig', 'sonstige', 88, 0.5, 17, 0, 0, A('histamin'), 'none'],
  // Ergänzungen für Carnivore / Keto / Paleo (gerundete Richtwerte, nicht verifiziert)
  ['rumpsteak', 'Rumpsteak (Rind)', 'fleisch', 150, 21, 0, 7, 0, A(), 'meat'],
  ['speck', 'Speck (roh)', 'fleisch', 541, 37, 1.4, 42, 0, A('histamin'), 'meat'],
  ['haehnchenschenkel', 'Hähnchenschenkel mit Haut (roh)', 'fleisch', 221, 16.7, 0, 16.5, 0, A(), 'meat'],
  ['sardinen', 'Sardinen (Dose, abgetropft)', 'fisch', 208, 24.6, 0, 11.5, 0, A('fisch', 'histamin'), 'fish'],
  ['sahne', 'Schlagsahne (30 %)', 'milch', 292, 2.4, 3.3, 30, 0, A('laktose', 'milch'), 'dairy'],
  ['gouda', 'Gouda', 'milch', 356, 25, 2.2, 27.4, 0, A('laktose', 'milch', 'histamin'), 'dairy'],
  ['frischkaese', 'Frischkäse (Doppelrahm)', 'milch', 342, 6, 4, 34, 0, A('laktose', 'milch'), 'dairy'],
  ['oliven', 'Oliven (grün, mariniert)', 'gemuese', 115, 0.8, 6, 11, 3.2, A('histamin'), 'none', { basic: true }],
  ['macadamia', 'Macadamia-Nüsse', 'nuesse', 718, 7.9, 14, 76, 8.6, A('nuesse'), 'none'],
]


const LEGUMES = new Set(['linsen', 'kichererbsen', 'kidneybohnen', 'tofu', 'sojadrink', 'erdnussmus', 'sojasauce'])
const GRAINS = new Set(['haferflocken', 'quinoa', 'naturreis', 'hirse', 'buchweizen', 'vollkornnudeln', 'vollkornbrot', 'haferdrink'])
const SUGARS = new Set(['honig', 'ahornsirup'])
const NUT_DRINK = new Set(['mandeldrink'])
const PROCESSED = new Set(['vollkornbrot', 'kochschinken', 'speck', 'tofu', 'haferdrink', 'sojadrink', 'mandeldrink', 'honig', 'ahornsirup', 'tomatenmark',
  'passata', 'gemuesebruehe', 'kokosmilch', 'sojasauce', 'balsamico', 'erdnussmus', 'butter', 'ghee', 'joghurt', 'skyr', 'quark', 'feta', 'parmesan',
  'sahne', 'gouda', 'frischkaese', 'oliven'])
const DRIED = new Set(['rosinen', 'datteln', 'kurkuma', 'zimt', 'kreuzkuemmel', 'paprikapulver'])
/** Gluten-/Nuss-Spuren: bei Rohware aus Mühlen/Mischbetrieben üblich (Näherung) */
const TRACES: Record<string, Allergen[]> = {
  quinoa: ['gluten'], hirse: ['gluten'], buchweizen: ['gluten'], linsen: ['gluten'], haferflocken: ['nuesse'],
  chia: ['nuesse'], leinsamen: ['nuesse'], sonnenblumenkerne: ['nuesse'], kuerbiskerne: ['nuesse'],
}

function groupOf(id: string, cat: Category, animal: AnimalOrigin): FoodGroup {
  if (id === 'garnelen') return 'schalentiere'
  if (SUGARS.has(id)) return 'zucker'
  if (LEGUMES.has(id) || id === 'kichererbsen') return 'huelsenfrucht'
  if (GRAINS.has(id)) return 'getreide'
  if (NUT_DRINK.has(id)) return 'nuss_samen'
  if (id === 'ei') return 'ei'
  if (animal === 'dairy' && cat === 'oele') return 'oel_fett'
  const m: Record<Category, FoodGroup> = {
    gemuese: 'gemuese', obst: 'obst', fleisch: 'fleisch', fisch: 'fisch', milch: 'milch', getreide: 'getreide', nuesse: 'nuss_samen',
    oele: 'oel_fett', gewuerze: 'gewuerz', getraenke: 'getraenk', sonstige: 'sonstige',
  }
  return m[cat]
}

function prepOf(id: string, cat: Category, name: string): Prep {
  if (name.includes('(Dose')) return 'konserviert'
  if (name.includes('(roh)') || name.includes('(TK)')) return 'roh'
  if (DRIED.has(id)) return 'getrocknet'
  if (PROCESSED.has(id) || cat === 'oele') return 'verarbeitet'
  return 'roh'
}

interface MappedEntry { code: string; blsName: string; rename: string | null; quality: 'verified' | 'missing'; v: Record<string, number | null>; flags: Record<string, string> }
const MAPPED = blsMapped.foods as unknown as Record<string, MappedEntry>
export const BLS_META = blsMapped.meta

export const BUILTIN_FOODS: Food[] = ROWS.map(([id, name, category, kcal, protein, carbs, fat, fiber, allergens = [], animal = 'none', extra = {}]) => {
  const base: Food = {
    id, name, category, kcal, protein,
    // Richtwerte stammen aus „Kohlenhydrate inkl. Ballaststoffe“ → auf verfügbare Kohlenhydrate (ohne Ballaststoffe) umgerechnet
    carbs: Math.max(0, Math.round((carbs - fiber) * 10) / 10), fat, fiber, allergens, traces: TRACES[id] ?? [], allergenInfoKnown: true, animal,
    group: groupOf(id, category, animal), prep: prepOf(id, category, name),
    source: SOURCE_NOTE, dataQuality: 'reference' as const,
    sourceRef: { name: 'USDA FoodData Central (Näherungswert, nicht gegen die Quelle geprüft)', license: 'CC0 1.0 / Public Domain' },
    ...extra,
  }
  const m = MAPPED[id]
  if (!m) return base
  // Mapped-Lebensmittel nehmen Nährwerte AUSSCHLIESSLICH aus BLS; fehlende Werte werden nicht aus anderen Quellen ergänzt.
  const missingFields = (['kcal', 'protein', 'fat', 'carbs', 'fiber'] as const).filter(k => m.v[k] === null)
  const micros: Food['micros'] = {}
  for (const [k, v] of Object.entries(m.v)) if (!['kcal', 'protein', 'fat', 'carbs', 'fiber'].includes(k) && v !== null) (micros as Record<string, number>)[k] = v
  return {
    ...base,
    name: m.rename ?? base.name,
    kcal: m.v.kcal ?? 0, protein: m.v.protein ?? 0, carbs: m.v.carbs ?? 0, fat: m.v.fat ?? 0, fiber: m.v.fiber ?? 0,
    missingFields: missingFields.length ? [...missingFields] : undefined,
    micros: Object.keys(micros).length ? micros : undefined,
    source: `${BLS_META.dataset} ${BLS_META.version}, Code ${m.code} („${m.blsName}“)`,
    dataQuality: m.quality === 'verified' ? 'verified' : 'missing',
    sourceRef: { name: `${BLS_META.dataset} ${BLS_META.version}`, id: m.code, license: BLS_META.license, retrieved: BLS_META.retrieved },
  }
})
