// Service worker minimal : permet d'installer le carnet comme une application et de l'ouvrir hors connexion.
// Il ne touche qu'aux fichiers du site lui-même ; les données (chiffrées) ont leur propre copie locale.
const C = 'carnet-v1';
const SHELL = ['./', './index.html', './sel.json', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if(e.request.method !== 'GET' || u.origin !== location.origin) return; // tout le reste passe sans intervention
  e.respondWith(fetch(e.request).then(r => {
    if(r.ok && /\/(index\.html|sel\.json|manifest\.webmanifest|icon-[^/]+\.png)?$/.test(u.pathname)){ const cl = r.clone(); caches.open(C).then(c => c.put(e.request, cl)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))));
});
