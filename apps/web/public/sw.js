/* Deliberately network-only: never cache accounts, catalog, lyrics or audio. */
self.addEventListener("install", (event) => { event.waitUntil(self.skipWaiting()); });
self.addEventListener("activate", (event) => { event.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || event.request.mode !== "navigate") return;
  event.respondWith(fetch(event.request).catch(() => new Response(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0a0d0c"><title>Mint is offline</title><body style="margin:0;padding:40px 24px;background:#0a0d0c;color:#f2f5f3;font:16px system-ui"><main style="max-width:38rem;margin:auto"><h1>You are offline</h1><p>Mint needs a connection to your server. Your account and music have not been cached on this device.</p><a style="color:#3fe0a0" href="/app/music">Try connecting again</a></main></body></html>`,
    { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } })));
});
