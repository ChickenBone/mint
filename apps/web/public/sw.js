/* Only the account-free offline player shell is cached. Audio requires explicit IndexedDB downloads. */
const SHELL = "mint-offline-shell-v35-2";
const FILES = ["/offline.html", "/offline.css", "/offline.js"];
self.addEventListener("install", (event) => { event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (event) => { event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("mint-offline-shell-") && key !== SHELL).map((key) => caches.delete(key)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (FILES.includes(url.pathname)) {
    event.respondWith(fetch(event.request).catch(async () => (await caches.match(url.pathname)) || Response.error()));
    return;
  }
  if (event.request.mode !== "navigate") return;
  event.respondWith(fetch(event.request).catch(async () => (await caches.match("/offline.html")) || new Response("Mint is offline. Reconnect once to enable the offline player.", { status: 503, headers: { "content-type": "text/plain", "cache-control": "no-store" } })));
});
