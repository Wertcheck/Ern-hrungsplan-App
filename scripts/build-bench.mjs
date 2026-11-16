// Erzeugt eine einzelne, eigenständige HTML-Datei des Benchmarks (alles inline, nur die WebLLM-Bibliothek kommt zur Laufzeit vom CDN).
// Aufruf: node scripts/build-bench.mjs [Ausgabedatei]   (Standard: dist-bench/llm-bench-standalone.html)
import { build } from 'vite'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
const out = process.argv[2] ?? 'dist-bench/llm-bench-standalone.html'
const r = await build({ configFile: false, logLevel: 'error', build: { write: false, minify: true, target: 'es2022', lib: { entry: 'src/bench/bench.ts', formats: ['es'], fileName: 'b' } } })
const chunk = (Array.isArray(r) ? r[0] : r).output.find(o => o.type === 'chunk')
const js = chunk.code.replace(/<\/script/gi, '<\\/script')
const html = readFileSync('llm-bench.html', 'utf8').replace('<script type="module" src="/src/bench/bench.ts"></script>', () => `<script type="module">${js}</script>`)
mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, html)
console.log(`${out}: ${(html.length / 1024).toFixed(0)} KB`)
