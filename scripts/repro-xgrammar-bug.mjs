// Reproduktion des Grammar-Matcher-Fehlers (WASM, keine GPU nötig).
// Aufruf in einem LEEREN Verzeichnis: npm i @mlc-ai/web-xgrammar@0.1.27 && cp node_modules/@mlc-ai/web-xgrammar/lib/index.js node_modules/@mlc-ai/web-xgrammar/lib/index.cjs && node <Pfad>/repro-xgrammar-bug.mjs
import { createRequire } from 'module'; const { TokenizerInfo, GrammarCompiler, GrammarMatcher } = createRequire(import.meta.url)('./node_modules/@mlc-ai/web-xgrammar/lib/index.cjs')
// kleine Fake-Vokabel (JSON-taugliche Tokens), reicht für den Aufrufpfad
const vocab = ['<unk>','</s>','{','}','"','a','b',':',',',' ','0','1','2','3','true','false','null','"type"','"kcal"','"none"','"today"']
const log = (...a) => console.log(...a)
const ti = await TokenizerInfo.createTokenizerInfo(vocab, 'raw', false, vocab.length, [1])
const gc = await GrammarCompiler.createGrammarCompiler(ti)
// 1) exakt der Aufruf aus web-llm 0.2.88 für {type:'json_object'} OHNE schema
try { await gc.compileJSONSchema(undefined, true, undefined, undefined, true, 16); log('A: ok (unerwartet)') } catch (e) { log('A: json_object ohne schema ->', String(e.message||e)) }
// 2) Folgeaufruf mit demselben Compiler
try { await gc.compileJSONSchema(undefined, true, undefined, undefined, true, 16); log('B: ok') } catch (e) { log('B: zweiter Versuch ->', String(e.message||e)) }
// 3) mit gültigem Schema-String
const schema = JSON.stringify({ type:'object', properties:{ type:{enum:['none','x']} }, required:['type'] })
try { const g = await gc.compileJSONSchema(schema, true, undefined, undefined, true, 16); const m = await GrammarMatcher.createGrammarMatcher(g); log('C: mit Schema-String ok, Matcher erstellt'); m.dispose(); g.dispose() } catch (e) { log('C: mit Schema ->', String(e.message||e)) }
// 4) lebt der Compiler nach den Fehlern noch?
try { const g = await gc.compileJSONSchema(schema, true, undefined, undefined, true, 16); log('D: Compiler nach Fehlern weiter nutzbar'); g.dispose() } catch (e) { log('D: Compiler nach Fehlern ->', String(e.message||e)) }
