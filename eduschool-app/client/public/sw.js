// Install-only service worker: a registered fetch listener used to be
// required for PWA installability (modern Chrome no longer requires it,
// kept for broader browser support). Never call respondWith() here — this
// is a live ERP app; a stale cached response for schedule/attendance/
// financial data would be actively wrong, not just outdated. A previous
// version did `event.respondWith(fetch(event.request))` as a "no-op"
// passthrough, which actually added a real extra hop — and an SW
// cold-start delay whenever the worker thread had gone idle — on every
// single API call (measured 300-700ms+ overhead per request).
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {});
