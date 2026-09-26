// Altovix service worker: the app opens at once from the cache, and the live page is fetched behind
// it. If the live page differs, the page is told (it shows "New version ready"); the next launch
// gets the new build either way. Live numbers (status.json) never come from this cache.
const CACHE = "altovix-shell-v6";
const SHELL = ["./", "./index.html", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function tellClients(msg) {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  all.forEach((c) => c.postMessage(msg));
}

// The page: cached copy first (instant), then the network copy; a different body means a new build.
const PENDING = "./__update-pending"; // set when a newer page was fetched behind a launch; the page asks for it
async function pageFirstThenRefresh(e) {
  const cache = await caches.open(CACHE);
  const key = new Request("./index.html");
  const hit = await cache.match(key);
  const mine = hit ? hit.clone() : null; // the copy to compare: the original goes to the page and is consumed there
  if (hit) await cache.delete(PENDING); // whatever is served now is the newest copy we have
  // "no-cache" = ask the server (a conditional request; GitHub Pages answers 304 when nothing changed) rather
  // than trust the browser's HTTP cache, which otherwise keeps the previous build for up to ten minutes
  const refresh = fetch(new Request(e.request.url, { cache: "no-cache", credentials: "same-origin" })).then(async (res) => {
    if (!res || !res.ok) return res;
    const fresh = res.clone();
    if (hit) {
      const [a, b] = await Promise.all([mine.text(), res.clone().text()]);
      if (a !== b) {
        await cache.put(key, fresh);
        await cache.put(PENDING, new Response("1"));
        await tellClients({ type: "altovix:update" }); // the page may not exist yet; it also asks on load
      }
    } else {
      await cache.put(key, fresh);
    }
    return res;
  }).catch(() => null);
  e.waitUntil(refresh); // keep the worker alive until the background refresh is done
  if (hit) return hit;
  const net = await refresh;
  return net || new Response("Altovix is offline and has no saved copy yet.", { status: 503, headers: { "Content-Type": "text/plain" } });
}

// the page asks once it is up: "did a newer build arrive while I was launching?"
self.addEventListener("message", (e) => {
  if (!e.data || e.data.type !== "altovix:check" || !e.source) return;
  e.waitUntil(caches.open(CACHE).then((c) => c.match(PENDING)).then((r) => { if (r) e.source.postMessage({ type: "altovix:update" }); }));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return; // feeds, logos and fonts pass through
  if (/\/(crypto-)?status\.json$/.test(url.pathname)) return; // live numbers: never from the cache
  if (req.mode === "navigate" || url.pathname.endsWith("/index.html")) { e.respondWith(pageFirstThenRefresh(e)); return; }
  // everything else (icons, manifest, seed.json): cached copy at once, refreshed in the background
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
