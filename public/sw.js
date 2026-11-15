/* Service Worker: App-Hülle wird beim Installieren vorab gecacht (offlinefähig), Daten liegen lokal (localStorage).
   /api (KI-Backend) wird NIE gecacht. Bei Änderungen am Caching-Verhalten VERSION erhöhen. */
const VERSION = 'v4';
const SHELL = 'ep-shell-' + VERSION;
const RUNTIME = 'ep-runtime-' + VERSION;
const CORE = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

// Browser verweigern „umgeleitete“ Antworten für Navigationsanfragen (ERR_FAILED) – daher immer eine saubere Kopie speichern.
async function clean(r) {
  if (!r.redirected) return r;
  return new Response(await r.blob(), { status: r.status, statusText: r.statusText, headers: r.headers });
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    const res = await fetch('/', { cache: 'no-store' });
    if (!res.ok) throw new Error('index nicht ladbar');
    const page = await clean(res);
    const html = await page.clone().text();
    await c.put('/', page.clone());
    await c.put('/index.html', page);
    await Promise.all(CORE.filter(u => u !== '/' && u !== '/index.html').map(u => c.add(u).catch(() => undefined)));
    // Hash-Assets (JS/CSS) aus der index.html ermitteln und vorab cachen
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(m => m[1]);
    await Promise.all(assets.map(a => c.add(a).catch(() => undefined)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => e.waitUntil((async () => {
  const keep = new Set([SHELL, RUNTIME]);
  for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // KI-/Backend-Anfragen niemals cachen

  // Seitennavigation: Netzwerk zuerst, offline die gecachte App-Hülle (SPA)
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(async r => { if (r.ok) { const copy = await clean(r.clone()); caches.open(SHELL).then(c => { c.put('/index.html', copy.clone()); c.put('/', copy); }); } return r; })
      .catch(() => caches.match('/index.html').then(r => r || caches.match('/'))));
    return;
  }
  // Hash-Assets sind unveränderlich: Cache zuerst, sonst Netzwerk (und dabei cachen, z. B. der BLS-Chunk beim ersten Öffnen)
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { if (r.ok) { const copy = r.clone(); caches.open(RUNTIME).then(c => c.put(req, copy)); } return r; })));
    return;
  }
  e.respondWith(fetch(req).then(r => { if (r.ok) { const copy = r.clone(); caches.open(RUNTIME).then(c => c.put(req, copy)); } return r; }).catch(() => caches.match(req)));
});
