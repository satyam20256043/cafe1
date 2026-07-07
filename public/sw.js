// ══════════════════════════════════════════════════════════════════════════════
// Zordic California — Service Worker (Phase 5 PWA)
// ══════════════════════════════════════════════════════════════════════════════
const CACHE_NAME    = 'cafe-hq-v3';
const OFFLINE_PAGE  = '/offline.html';

// Assets to pre-cache on install
const PRECACHE = [
  '/',
  '/offline.html',
  '/manifest.json',
];

// API routes that should NEVER be cached (always live)
const NEVER_CACHE = [
  '/api/',
  '/socket.io/',
];

// ── Install: pre-cache shell ──────────────────────────────────────────────────
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE).catch(() => {}))
  );
});

// ── Activate: clean old caches ────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: network-first for API, cache-first for assets ─────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip non-GET and API/socket calls — always go to network
  if (event.request.method !== 'GET') return;
  if (NEVER_CACHE.some(p => url.pathname.startsWith(p))) return;

  // For navigation (page loads): network first, fallback to cache, then offline
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request).then(cached => cached || caches.match(OFFLINE_PAGE)))
    );
    return;
  }

  // For other assets: cache first, fallback to network
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(res => {
        if (!res || res.status !== 200 || res.type !== 'basic') return res;
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        return res;
      });
    })
  );
});

// ── Push Notifications ────────────────────────────────────────────────────────
self.addEventListener('push', event => {
  let data = { title: 'Zordic California', body: 'You have an update!', icon: '/favicon.ico', tag: 'cafe-update' };
  try { data = { ...data, ...event.data.json() }; } catch(e) {}

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body:    data.body,
      icon:    data.icon || '/favicon.ico',
      badge:   '/favicon.ico',
      tag:     data.tag  || 'cafe-update',
      vibrate: [200, 100, 200],
      data:    { url: data.url || '/' },
      actions: data.actions || []
    })
  );
});

// ── Notification click: open app ──────────────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes(self.location.origin) && 'focus' in c);
      if (existing) return existing.focus().then(c => c.navigate(target));
      return clients.openWindow(target);
    })
  );
});

// ── Background sync (optional) ────────────────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-orders') {
    // Retry any queued orders when back online
    event.waitUntil(Promise.resolve());
  }
});
