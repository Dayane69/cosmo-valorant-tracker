// Lecture du jeu de compos accumulé (blob `cosmo-comps`).
// Le navigateur n'accède jamais aux Blobs directement : il passe par ici.
// GET /.netlify/functions/comps  ->  { comps: [...], count, updated }
//
// Si le blob n'existe pas encore (premier déploiement, ou store vide), on
// renvoie une liste vide et le front retombe sur comps.json — même repli que
// le roster.

import { getStore } from "@netlify/blobs";

const json = (obj, status) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      // Le jeu ne bouge qu'une fois par jour (cron) : un cache court côté CDN
      // évite de relire le blob à chaque ouverture de la rubrique.
      "cache-control": status === 200 ? "public, max-age=300, s-maxage=600" : "no-store",
    },
  });

export default async (req) => {
  if (req.method !== "GET") return json({ comps: [], count: 0, error: "méthode non supportée" }, 405);
  try {
    const doc = (await getStore("cosmo-comps").get("comps", { type: "json" })) || null;
    const comps = (doc && Array.isArray(doc.comps) ? doc.comps : Array.isArray(doc) ? doc : []) || [];
    return json({ comps, count: comps.length, updated: (doc && doc.updated) || null }, 200);
  } catch (e) {
    // Pas encore de données n'est pas une erreur fatale : le front a son seed.
    return json({ comps: [], count: 0, updated: null, error: String((e && e.message) || e) }, 200);
  }
};
