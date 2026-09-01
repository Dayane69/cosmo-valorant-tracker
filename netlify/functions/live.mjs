// État « en direct », poussé par le compagnon PC et lu par le site.
//
// POST /.netlify/functions/live?key=TOKEN   -> le compagnon envoie son état
// GET  /.netlify/functions/live             -> le site lit l'état de la squad
//
// Le POST est protégé : sans ça, n'importe qui pourrait afficher n'importe
// quoi sur l'accueil. Le jeton se lit dans LIVE_TOKEN, à défaut REFRESH_TOKEN
// (pour n'avoir qu'un secret à gérer si on préfère).
//
// Aucune clé, aucun jeton Riot ne transite ni n'est stocké ici : le compagnon
// garde ses jetons sur le PC et n'envoie que ce que le jeu affiche déjà.

import { getStore } from "@netlify/blobs";
import { cleanLive, mergeLive, liveView } from "./lib/live-core.mjs";

const json = (obj, status, extra) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      // Jamais de cache : c'est la seule donnée du site qui se périme en
      // secondes. Un score en cache serait pire que pas de score du tout.
      "cache-control": "no-store",
      ...(extra || {}),
    },
  });

// Le compagnon tourne sur un PC, hors du domaine : il lui faut le CORS.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-live-token",
};

function authed(req) {
  const token = process.env.LIVE_TOKEN || process.env.REFRESH_TOKEN;
  if (!token) return { ok: false, status: 500, error: "LIVE_TOKEN non configuré côté serveur" };
  const url = new URL(req.url);
  const given = url.searchParams.get("key") || req.headers.get("x-live-token") || "";
  if (given !== token) return { ok: false, status: 401, error: "non autorisé" };
  return { ok: true };
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (req.method === "GET") {
    try {
      const doc = (await getStore("cosmo-live").get("live", { type: "json" })) || null;
      const players = liveView(doc, Date.now());
      return json({ players, count: players.length }, 200, CORS);
    } catch (e) {
      // Pas encore de blob : ce n'est pas une erreur, personne n'a lancé le
      // compagnon. Le front retombe sur ce qu'il sait des parties finies.
      return json({ players: [], count: 0 }, 200, CORS);
    }
  }

  if (req.method === "POST") {
    const a = authed(req);
    if (!a.ok) return json({ ok: false, error: a.error }, a.status, CORS);

    let body;
    try { body = await req.json(); } catch (e) { return json({ ok: false, error: "JSON invalide" }, 400, CORS); }

    const entry = cleanLive(body, Date.now());
    if (!entry) return json({ ok: false, error: "état invalide (name et tag requis)" }, 400, CORS);

    try {
      const store = getStore("cosmo-live");
      const doc = (await store.get("live", { type: "json" })) || null;
      const next = mergeLive(doc, entry);
      await store.setJSON("live", next);
      return json({ ok: true, key: entry.key, state: entry.state, players: next.players.length }, 200, CORS);
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e) }, 500, CORS);
    }
  }

  return json({ ok: false, error: "méthode non supportée" }, 405, CORS);
};
