const CACHE_NAME = "calendai-v1";
const urlsToCache = [
  "/",
  "/index.html",
  "/frontend/src/main.tsx",
  "/frontend/src/App.tsx",
  "/frontend/src/App.css",
  "/frontend/src/index.css"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(urlsToCache);
    })
  );
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      if (response) {
        return response;
      }
      return fetch(event.request);
    })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME && cacheName.startsWith("calendai-")) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});
