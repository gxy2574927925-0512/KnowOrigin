// Legacy Service Worker retirement shim.
//
// KnowOrigin no longer registers a Service Worker. This file remains at /sw.js so
// browsers that still have the old root-scoped worker can update it, clear its
// caches, unregister it, and reload the current page from the network.
const RETIRE_CACHE_PREFIX = "knoworigin-shell-";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith(RETIRE_CACHE_PREFIX) || key.startsWith("knoworigin-"))
      .map((key) => caches.delete(key)));
    await self.clients.claim();
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    await Promise.allSettled(clients.map((client) => client.navigate(client.url)));
  })());
});
