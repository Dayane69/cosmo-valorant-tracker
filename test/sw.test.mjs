// Service worker : ce qu'il sert quand le réseau tombe.
//
// Le défaut corrigé ici : le repli sur la page d'accueil s'appliquait à TOUTE
// requête same-origin, pas seulement aux navigations. Hors-ligne et sans
// entrée en cache, une demande de app.js ou de comps.json recevait donc du
// HTML — un script qui ne se parse pas, un JSON illisible. Une panne franche
// vaut mieux : tous les fetch de l'app ont leur catch.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "https://cosmo-valo.netlify.app";

/* Charge sw.js dans un faux environnement de service worker et renvoie de quoi
   déclencher un évènement `fetch`. `cached` : ce que le cache contient déjà. */
function loadSW({ online = false, cached = {} } = {}) {
  const listeners = {};
  const store = new Map(Object.entries(cached));
  const puts = [];

  const caches = {
    open: async () => ({ addAll: async () => {}, put: async (req, res) => { puts.push([req.url || req, res]); } }),
    keys: async () => [],
    delete: async () => true,
    match: async (r) => store.get(typeof r === "string" ? r : r.url),
  };
  const self = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: () => {},
    clients: { claim: () => {} },
    location: { origin: ORIGIN },
  };
  const netResponse = new Response("du réseau", { status: 200 });
  const ctx = vm.createContext({
    self, caches, URL, Response,
    fetch: async () => { if (!online) throw new TypeError("hors-ligne"); return netResponse; },
  });
  vm.runInContext(readFileSync(join(root, "sw.js"), "utf8"), ctx);

  // Déclenche un fetch et renvoie la réponse, ou null si le SW n'intercepte pas.
  const fire = async (url, { method = "GET", mode = "no-cors" } = {}) => {
    let promise = null;
    listeners.fetch({ request: { url, method, mode }, respondWith: (p) => { promise = p; } });
    return promise === null ? null : await promise;
  };
  return { fire, puts, netResponse };
}

test("hors-ligne, une navigation retombe sur la page d'accueil", async () => {
  const shell = new Response("<html>accueil</html>", { status: 200 });
  const { fire } = loadSW({ cached: { "/index.html": shell } });
  const res = await fire(`${ORIGIN}/une/page`, { mode: "navigate" });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /accueil/);
});

test("hors-ligne, un script absent du cache échoue au lieu de recevoir du HTML", async () => {
  const shell = new Response("<html>accueil</html>", { status: 200 });
  const { fire } = loadSW({ cached: { "/index.html": shell } });

  for (const u of [`${ORIGIN}/app.js`, `${ORIGIN}/comps.json`, `${ORIGIN}/roster.json`]) {
    const res = await fire(u);
    assert.equal(res.status, 504, `${u} doit échouer franchement`);
    assert.equal(await res.text(), "", "surtout pas la page d'accueil");
  }
});

test("hors-ligne, ce qui est en cache est servi normalement", async () => {
  const app = new Response("/* app.js */", { status: 200 });
  const { fire } = loadSW({ cached: { [`${ORIGIN}/app.js`]: app } });
  const res = await fire(`${ORIGIN}/app.js`);
  assert.equal(await res.text(), "/* app.js */");
});

test("même sans page d'accueil en cache, une navigation ne pend pas", async () => {
  // respondWith(undefined) planterait : on répond une vraie erreur.
  const { fire } = loadSW({ cached: {} });
  const res = await fire(`${ORIGIN}/`, { mode: "navigate" });
  assert.equal(res.status, 504);
});

test("les données ne passent jamais par le cache du SW", async () => {
  const { fire } = loadSW({ online: true });
  for (const u of [
    `${ORIGIN}/.netlify/functions/live-ou-autre`,
    `${ORIGIN}/.netlify/functions/historique?name=a&tag=b`,
    "https://valorant-api.com/v1/agents",
  ]) {
    assert.equal(await fire(u), null, `${u} doit être laissé au réseau`);
  }
});

test("une écriture (POST) n'est pas interceptée", async () => {
  const { fire } = loadSW({ online: true });
  assert.equal(await fire(`${ORIGIN}/app.js`, { method: "POST" }), null);
});

test("en ligne, c'est le réseau qui gagne, et la réponse est mise en cache", async () => {
  const vieux = new Response("vieille version", { status: 200 });
  const { fire, puts } = loadSW({ online: true, cached: { [`${ORIGIN}/app.js`]: vieux } });
  const res = await fire(`${ORIGIN}/app.js`);
  assert.equal(await res.text(), "du réseau", "le cache ne doit pas masquer une mise à jour");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(puts.length, 1, "la réponse fraîche remplace l'entrée en cache");
});
