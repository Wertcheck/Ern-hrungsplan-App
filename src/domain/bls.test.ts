import { describe, expect, it } from 'vitest'
import raw from '../data/bls/bls40.json'
import mapped from '../data/bls/mapped.json'
import { BUILTIN_FOODS } from '../data/foods'
import { COMPOSITE_GROUPS, animalOrigin, blsToFood, buildIndex, classify, hasBlsCode, normalize, prepFromName, searchBls, type RawBls } from './bls'
import { defaultPrefs } from './defaults'
import { foodViolation } from './rules'
import { foodMacros } from './nutrition'
import { MICRO_KEYS } from './types'

const index = buildIndex(raw as unknown as RawBls)
const by = (code: string) => index.byCode.get(code)!
const prefs = (over = {}) => ({ ...defaultPrefs(), ...over })

describe('BLS-Datensatz: Integrität', () => {
  it('Umfang, eindeutige Codes, Metadaten mit Herkunft und Lizenz', () => {
    expect(index.entries).toHaveLength(7140)
    expect(index.meta.foodCount).toBe(7140)
    expect(new Set(index.entries.map(e => e.code)).size).toBe(7140)
    expect(index.meta).toMatchObject({ dataset: expect.stringContaining('BLS'), version: '4.0', license: 'CC BY 4.0', doi: '10.25826/Data20251217-134202-0' })
    expect(index.meta.archiveSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(index.meta.citation).toContain('Max Rubner-Institut')
  })
  it('keine ungültigen Werte: nie negativ/NaN, Makrosumme ≤ 100 g, kcal ≤ 950, fehlende Werte als null', () => {
    for (const e of index.entries) {
      for (const k of ['kcal', 'protein', 'fat', 'carbs', 'fiber'] as const) {
        const v = e[k]
        if (v !== null) { expect(Number.isFinite(v), `${e.code} ${k}`).toBe(true); expect(v, `${e.code} ${k}`).toBeGreaterThanOrEqual(0) }
      }
      if (e.protein !== null && e.fat !== null && e.carbs !== null) expect(e.protein + e.fat + e.carbs, e.code).toBeLessThanOrEqual(101)
      if (e.kcal !== null) expect(e.kcal, e.code).toBeLessThanOrEqual(950)
      for (const k of MICRO_KEYS) { const v = e.micros[k]; if (v !== undefined) expect(v, `${e.code} ${k}`).toBeGreaterThanOrEqual(0) }
    }
  })
  it('fehlende Werte werden nicht als 0 geführt (Micros fehlen als Schlüssel; Flags dokumentieren Spuren/Nachweisgrenze)', () => {
    const noMissingAsZero = index.entries.filter(e => e.flags.fiber === 'm' && e.fiber !== null)
    expect(noMissingAsZero).toHaveLength(0)
    const missingFat = index.entries.filter(e => e.fat === null)
    expect(missingFat.length).toBe(3)
    expect(index.entries.some(e => e.flags.protein === 't')).toBe(true)
  })
  it('Stichproben stimmen mit den im Original (XLSX) geprüften Werten überein', () => {
    const spot: Record<string, [number, number, number, number]> = { // kcal, Protein, Fett, verfügbare KH
      C133000: [348, 13.22, 6.7, 53.3], G561100: [22, 0.9, 0.1, 3.2], Q120000: [899, 0, 99.9, 0], T121902: [95, 22.9, 0.4, 0],
      E111100: [135, 13.2, 9, 0.3], M141300: [67, 4, 3.5, 4.1], F110100: [58, 0.4, 0.5, 11.7],
    }
    for (const [code, [kcal, p, f, c]] of Object.entries(spot)) {
      const e = by(code)
      expect(e.kcal, code).toBe(kcal)
      expect(e.protein, code).toBeCloseTo(p, 1)
      expect(e.fat, code).toBeCloseTo(f, 1)
      expect(e.carbs, code).toBeCloseTo(c, 1)
    }
  })
  it('Mikronährstoffe: gängige Lebensmittel haben Werte in plausiblen Größenordnungen (Einheiten mg/µg)', () => {
    const spinat = by('G211100').micros
    expect(Object.keys(spinat).length).toBeGreaterThanOrEqual(9)
    expect(spinat.kalium!).toBeGreaterThan(300); expect(spinat.kalium!).toBeLessThan(1000)   // mg
    expect(spinat.eisen!).toBeGreaterThan(1); expect(spinat.eisen!).toBeLessThan(8)           // mg
    expect(by('M306400').micros.calcium!).toBeGreaterThan(800)                                  // Parmesan, mg
    expect(by('T410100').micros.vitaminD!).toBeGreaterThan(2)                                   // Lachs, µg
  })
})

describe('BLS: Standard-Lebensmittel (Mapping)', () => {
  const verified = BUILTIN_FOODS.filter(f => f.dataQuality === 'verified')
  it('jedes zugeordnete Lebensmittel trägt Code, Version, Lizenz und stimmt exakt mit dem Datensatz überein', () => {
    expect(verified.length).toBe(Object.keys(mapped.foods).length)
    for (const f of verified) {
      const e = by(f.sourceRef!.id!)
      expect(e, f.id).toBeDefined()
      expect(f.sourceRef).toMatchObject({ name: `${index.meta.dataset} 4.0`, license: 'CC BY 4.0' })
      // keine Vermischung mit anderen Quellen: fehlender BLS-Wert = 0 im Modell + Vermerk, niemals ein Fremdwert
      expect([f.kcal, f.protein, f.fat, f.carbs, f.fiber], f.id).toEqual([e.kcal ?? 0, e.protein ?? 0, e.fat ?? 0, e.carbs ?? 0, e.fiber ?? 0])
      for (const k of ['kcal', 'protein', 'fat', 'carbs', 'fiber'] as const) expect(f.missingFields?.includes(k) ?? false, `${f.id} ${k}`).toBe(e[k] === null)
      for (const k of MICRO_KEYS) expect(f.micros?.[k], `${f.id} ${k}`).toBe(e.micros[k])
    }
  })
  it('keine Dubletten: jeder BLS-Code höchstens einmal in den Standard-Lebensmitteln; Namen eindeutig', () => {
    const codes = verified.map(f => f.sourceRef!.id)
    expect(new Set(codes).size).toBe(codes.length)
    expect(new Set(BUILTIN_FOODS.map(f => f.name)).size).toBe(BUILTIN_FOODS.length)
    expect(hasBlsCode(BUILTIN_FOODS, 'C133000')).toBe(true)
  })
  it('Zustand passt zum BLS-Eintrag (roh/Konserve) – keine rohen Rezeptmengen mit gegarten Werten vermischt', () => {
    for (const f of verified) {
      const e = by(f.sourceRef!.id!)
      if (['kichererbsen', 'kidneybohnen', 'thunfisch', 'sardinen'].includes(f.id)) expect(f.prep, f.id).toBe('konserviert')
      if (f.prep === 'roh') expect(e.prep === 'gekocht', `${f.id}: ${e.de}`).toBe(false)
    }
  })
  it('Nährwertberechnung mit BLS-Werten: 50 g Haferflocken = 174 kcal, 100 g Olivenöl = 899 kcal', () => {
    expect(foodMacros(BUILTIN_FOODS.find(f => f.id === 'haferflocken')!, 50).kcal).toBe(174)
    expect(foodMacros(BUILTIN_FOODS.find(f => f.id === 'olivenoel')!, 100).kcal).toBe(899)
  })
})

describe('BLS: Suche und Filter', () => {
  const codes = (q: Parameters<typeof searchBls>[1]) => searchBls(index, q).map(h => h.entry.code)
  it('findet Grundlebensmittel zuerst', () => {
    expect(codes({ text: 'hafer flocken' })[0]).toBe('C133000')
    expect(codes({ text: 'Hühnerei roh' })[0]).toBe('E111100')
    expect(codes({ text: 'olivenöl' })[0]).toBe('Q120000')
  })
  it('tolerant gegenüber Umlauten, ß, Groß-/Kleinschreibung und ue/oe/ae', () => {
    expect(codes({ text: 'KÜRBIS' }).length).toBeGreaterThan(0)
    expect(codes({ text: 'kuerbis' })).toEqual(codes({ text: 'kürbis' }))
    expect(codes({ text: 'süßkartoffel' }).length).toBeGreaterThan(0)
    expect(codes({ text: 'suesskartoffel' }).length).toBeGreaterThan(0)
    expect(normalize('Käse-Soße ß')).toBe('kase sosse ss')
  })
  it('findet Zusammenschreibungen („Haferflocken“ ↔ „Hafer Flocken“), aber keine Zufallstreffer', () => {
    expect(codes({ text: 'Haferflocken' })).toContain('C133000')
    expect(codes({ text: 'haferflocken' })[0]).toBe('C133000')
    expect(codes({ text: 'sonnenblumenkern' })).toContain('H430100')
    expect(codes({ text: 'xyzabcdef' })).toEqual([])
  })
  it('Filter: Gruppe, Zustand, nur Grundlebensmittel, Limit', () => {
    const oils = searchBls(index, { groups: ['Q'], limit: 500 })
    expect(oils.length).toBeGreaterThan(20); expect(oils.every(h => h.entry.group === 'Q')).toBe(true)
    const cans = searchBls(index, { text: 'bohne', preps: ['konserviert'], limit: 100 })
    expect(cans.length).toBeGreaterThan(0); expect(cans.every(h => h.entry.prep === 'konserviert')).toBe(true)
    const basic = searchBls(index, { text: 'kartoffel', basicOnly: true, limit: 500 })
    expect(basic.every(h => !COMPOSITE_GROUPS.has(h.entry.group))).toBe(true)
    expect(searchBls(index, { limit: 7 })).toHaveLength(7)
    expect(searchBls(index, { text: 'qqqxyz' })).toEqual([])
    expect(searchBls(index, { text: 'tomate', withMicros: true }).every(h => Object.keys(h.entry.micros).length >= 8)).toBe(true)
  })
  it('Suche ist schnell (20 Anfragen über 7.140 Einträge < 500 ms gesamt)', () => {
    const t = performance.now()
    for (const q of ['apfel', 'lachs', 'vollkorn', 'milch', 'rind', 'zucchini', 'nuss', 'brot', 'käse', 'reis', 'öl', 'tofu', 'beere', 'pilz', 'gemüse', 'hafer', 'joghurt', 'quark', 'honig', 'ei']) searchBls(index, { text: q })
    expect(performance.now() - t).toBeLessThan(500)
  })
})

describe('BLS → App-Lebensmittel', () => {
  it('Herkunft: Grundlebensmittel eindeutig, Zusammengesetztes „unbekannt“', () => {
    expect(animalOrigin(by('C133000'))).toBe('none')
    expect(animalOrigin(by('E111100'))).toBe('egg')
    expect(animalOrigin(by('S120000'))).toBe('honey')
    expect(animalOrigin(by('M306400'))).toBe('dairy')
    expect(animalOrigin(by('T410100'))).toBe('fish')
    expect(animalOrigin(by('U010100'))).toBe('meat')
    expect(animalOrigin(by('X4A1030'))).toBe('meat')       // Gemüsebrühe mit Hühnerfleisch und Reis
    expect(animalOrigin(by('Y710352'))).not.toBe('none')   // Spiegelei mit Kochschinken
    const composite = index.entries.filter(e => ['X', 'Y', 'D'].includes(e.group) && !/Fleisch|Schinken|Wurst/.test(e.de))
    expect(composite.filter(e => animalOrigin(e) === 'none')).toHaveLength(0)
  })
  it('Klassifikation: Schalentiere, Hülsenfrüchte, Öle', () => {
    expect(classify(by('T753100'))).toEqual({ category: 'fisch', group: 'schalentiere' })
    expect(classify(by('H730132')).group).toBe('huelsenfrucht')
    expect(classify(by('Q120000')).group).toBe('oel_fett')
    expect(classify(by('G561100')).group).toBe('gemuese')
  })
  it('Zustand aus dem Namen', () => {
    expect(prepFromName('Spinat gekocht', 'G211132')).toBe('gekocht')
    expect(prepFromName('Kidneybohne reif, Konserve, abgetropft', 'H742902')).toBe('konserviert')
    expect(prepFromName('Apfel getrocknet', 'F110400')).toBe('getrocknet')
    expect(prepFromName('Tomate roh', 'G561100')).toBe('roh')
  })
  it('Übernahme: Quelle/Version/Lizenz, „Allergene unbekannt“, fehlende Werte → „Daten fehlen“', () => {
    const f = blsToFood(by('C133000'), index.meta)
    expect(f).toMatchObject({ id: 'bls-C133000', allergenInfoKnown: false, allergens: [], dataQuality: 'verified', custom: true, kcal: 348 })
    expect(f.missingFields).toEqual([])
    expect(blsToFood(by('S151100'), index.meta).missingFields).toEqual(['fiber'])   // Ahornsirup: Ballaststoffe fehlen im BLS
    expect(f.sourceRef).toMatchObject({ id: 'C133000', license: 'CC BY 4.0' })
    const miss = index.entries.find(e => e.fat === null)!
    expect(blsToFood(miss, index.meta).dataQuality).toBe('missing')
  })
  it('Sicherheit: übernommene BLS-Lebensmittel umgehen weder Allergie-, Vegan- noch Carnivore-Regeln', () => {
    const oat = blsToFood(by('C133000'), index.meta)
    expect(foodViolation(oat, prefs({ restrictions: [{ allergen: 'soja', severity: 'allergy' }] }))).toMatch(/unbekannt/)   // Allergeninfo fehlt → Sicherheitsausschluss
    expect(foodViolation(oat, prefs({ restrictions: [{ allergen: 'soja', severity: 'intolerance' }] }))).toBeNull()
    const dish = blsToFood(by('Y710352'), index.meta)
    expect(foodViolation(dish, prefs({ styles: ['vegan'] }))).not.toBeNull()
    expect(foodViolation(dish, prefs({ styles: ['vegetarisch'] }))).not.toBeNull()
    const unknownDish = blsToFood(index.entries.find(e => e.group === 'Y' && animalOrigin(e) === 'unknown')!, index.meta)
    expect(foodViolation(unknownDish, prefs({ styles: ['vegan'] }))).toMatch(/nicht vegan/)
    expect(foodViolation(unknownDish, prefs({ styles: ['carnivore'] }))).toMatch(/unbekannt/)
    expect(foodViolation(blsToFood(by('Q120000'), index.meta), prefs({ styles: ['carnivore'] }))).toMatch(/pflanzlich/)
  })
})
