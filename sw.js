/* Service worker mínimo — permite instalabilidade como PWA (inclui iOS, com limitações do Safari). */
const CACHE_VERSION = 'brain-drive-v19';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', () => {
  /* Rede por defeito; cache reservado para evoluções futuras. */
});
