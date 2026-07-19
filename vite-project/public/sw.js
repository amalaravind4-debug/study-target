const CACHE_NAME = 'upsc-ledger-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

// Stale-while-revalidate for same-origin GET requests. No build-time asset list is
// needed — this just caches whatever gets fetched as you go, and serves the cached
// copy instantly on the next visit (with a background refresh), which is what makes
// the app usable offline/on a flaky connection and satisfies PWA installability.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(req).then((cached) => {
        const fetchPromise = fetch(req)
          .then((res) => {
            if (res && res.status === 200) cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      })
    )
  );
});

// The timer posts a message here when a slot completes, so the notification can be
// shown via the service worker (more reliable than a page-level Notification when
// the tab is minimized, especially on Android Chrome).
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'notify') {
    self.registration.showNotification(data.title || "Time's up", {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag || 'upsc-timer',
      renotify: true
    });
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      if (clients.length > 0) return clients[0].focus();
      return self.clients.openWindow('/');
    })
  );
});
