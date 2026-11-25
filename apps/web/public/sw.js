// StikSound offline cache.
// Pages: network first, so a new deploy shows up on the next open.
// Hashed build assets: cache first, since their names change with every build.
const CACHE = "stiksound-web-v3";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icons/apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  // MyInstants/Tenor go through the host proxy (/mi, /tenor); search results must stay live.
  if (/\/(mi|tenor)\//.test(url.pathname)) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (req.mode === "navigate") {
        try {
          const fresh = await fetch(req);
          if (fresh.ok) await cache.put("./index.html", fresh.clone());
          return fresh;
        } catch {
          return (await cache.match("./index.html")) ?? Response.error();
        }
      }
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) await cache.put(req, res.clone());
      return res;
    })()
  );
});
