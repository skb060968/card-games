/* ==============================
   Card Games Platform PWA Service Worker
   - Network-first for HTML/JS/CSS (Vite hashes these)
   - Cache-first for static assets (images, icons, sounds)
   - Update detection + prompt support
   ============================== */

const CACHE_NAME = "card-games-v83"; // Upgraded update notification system

// Pre-cache truly static assets (not Vite-hashed JS/CSS)
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/images/ppp-card.png",
  "/images/rummy-card.png",
  "/images/bluff-card.jpeg",
  "/images/fm-card.jpeg",
  "/images/pt-card.jpeg",
  "/images/poker-card.jpeg",
  "/images/coming-soon.png",
  "/sounds/throw.mp3",
  "/sounds/capture.mp3",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

/* ==============================
   Install
   ============================== */
self.addEventListener("install", (event) => {
  console.log(`[SW] Installing version ${CACHE_NAME}`);
  // Skip waiting to activate new service worker immediately
  self.skipWaiting();
  
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Caching app shell');
      return cache.addAll(STATIC_ASSETS);
    })
  );
});

/* ==============================
   Activate
   ============================== */
self.addEventListener("activate", (event) => {
  console.log(`[SW] Activating version ${CACHE_NAME}`);
  
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((key) => {
            if (key !== CACHE_NAME) {
              console.log(`[SW] Deleting old cache: ${key}`);
              return caches.delete(key);
            }
          }),
        ),
      )
      .then(() => self.clients.claim())
      .then(() => {
        // Notify all clients about the update
        return self.clients.matchAll().then((clients) => {
          clients.forEach((client) => {
            client.postMessage({
              type: 'UPDATE_AVAILABLE',
              version: CACHE_NAME
            });
          });
        });
      })
  );
});

/* ==============================
   Fetch — hybrid strategy
   ============================== */
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET and cross-origin requests
  if (event.request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  // Network-first for HTML, JS, CSS (Vite hashes these, so cache-first would serve stale code)
  if (
    event.request.mode === "navigate" ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css") ||
    url.pathname.startsWith("/assets/")
  ) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const clone = response.clone();
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(event.request, clone));
          return response;
        })
        .catch(() =>
          caches
            .match(event.request)
            .then((cached) => cached || caches.match("/index.html")),
        ),
    );
    return;
  }

  // Cache-first for static assets (images, icons, sounds, manifest)
  event.respondWith(
    caches
      .match(event.request)
      .then(
        (cached) =>
          cached ||
          fetch(event.request).then((response) => {
            const clone = response.clone();
            caches
              .open(CACHE_NAME)
              .then((cache) => cache.put(event.request, clone));
            return response;
          }),
      )
      .catch(() => caches.match("/index.html")),
  );
});

/* ==============================
   Listen for SKIP_WAITING message
   ============================== */
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});