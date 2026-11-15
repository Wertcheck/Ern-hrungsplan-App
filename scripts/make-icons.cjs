// Erzeugt die PWA-Icons (PNG) reproduzierbar aus den SVG-Vorlagen in public/. Aufruf: node scripts/make-icons.cjs
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs')
const pub = path.join(__dirname, '..', 'public')
;(async () => {
  const b = await chromium.launch(); const jobs = [['icon.svg', 'icon-192.png', 192], ['icon.svg', 'icon-512.png', 512], ['icon-maskable.svg', 'icon-maskable-512.png', 512], ['icon.svg', 'apple-touch-icon.png', 180]]
  for (const [src, out, size] of jobs) {
    const svg = fs.readFileSync(path.join(pub, src), 'utf8')
    const p = await b.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
    await p.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`)
    await p.screenshot({ path: path.join(pub, out), omitBackground: true }); await p.close(); console.log('erzeugt', out)
  }
  await b.close()
})()
