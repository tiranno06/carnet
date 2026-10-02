// Service worker : installation comme application, ouverture hors connexion, et notifications du robot.
// Il ne touche qu'aux fichiers du site lui-même ; les données (chiffrées) ont leur propre copie locale.
const C = 'carnet-v2';
const SHELL = ['./', './index.html', './sel.json', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if(e.request.method !== 'GET') return;
  // polices et bibliothèque de graphiques : gardées sur l'appareil (elles ne changent jamais à adresse égale)
  if(/^(fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com)$/.test(u.hostname)){
    e.respondWith(caches.open('carnet-libs').then(c => c.match(e.request).then(hit => hit || fetch(e.request).then(r => { if(r.ok || r.type === 'opaque') c.put(e.request, r.clone()); return r; }))));
    return;
  }
  if(u.origin !== location.origin) return; // tout le reste passe sans intervention
  e.respondWith(fetch(e.request).then(r => {
    if(r.ok && /\/(index\.html|sel\.json|manifest\.webmanifest|icon-[^/]+\.png)?$/.test(u.pathname)){ const cl = r.clone(); caches.open(C).then(c => c.put(e.request, cl)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))));
});
// notifications envoyées par le robot (contenu chiffré de bout en bout, déchiffré ici par le navigateur)
self.addEventListener('push', e => {
  let d = {}; try{ d = e.data ? e.data.json() : {}; }catch(_){ d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Carnet', { body: d.body || '', icon: 'icon-192.png', badge: 'icon-192.png', tag: d.tag || 'carnet', renotify: true, data: { url: d.url || './' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(list => {
    for(const c of list){ if(c.url.startsWith(self.registration.scope)){ c.focus(); if('navigate' in c && url !== c.url) return c.navigate(url).catch(() => {}); return; } }
    return self.clients.openWindow(url);
  }));
});
