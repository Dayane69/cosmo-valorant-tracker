/* Service worker COSMO — cache léger du "shell" pour un démarrage rapide et un
   mode hors-ligne minimal. On NE met JAMAIS en cache les appels de données
   (fonctions Netlify, valorant-api, médias) : ils doivent rester frais. */
const CACHE = "cosmo-shell-v1";
const SHELL = ["/", "/index.html", "/roster.json", "/icon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Données (jamais mises en cache) : on laisse le réseau gérer.
  if (
    url.pathname.startsWith("/.netlify/functions/") ||
    url.hostname.includes("valorant-api.com") ||
    url.hostname.includes("giphy.com")
  ) return;

  // Shell same-origin : réseau d'abord (pour recevoir les mises à jour), repli
  // sur le cache si hors-ligne. Le HTML retombe sur la page d'accueil.
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match("/index.html")))
    );
  }
});
