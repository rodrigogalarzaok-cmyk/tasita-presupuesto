const CACHE_NAME = 'tasita-v7';
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// network-first para HTML (para no quedarse con una versión vieja de la app),
// cache-first para el resto (íconos, manifest)
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  // Las llamadas a otro dominio (la API de suscripciones, la cotización del dólar)
  // pasan de largo: no se cachean ni se tocan. Si el service worker las intercepta,
  // rompe el CORS y la app no puede verificar el pago.
  if (new URL(e.request.url).origin !== self.location.origin) return;

  const isHTML = e.request.mode === 'navigate' || e.request.destination === 'document';

  if (isHTML) {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request).then((res) => res || caches.match('./index.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
