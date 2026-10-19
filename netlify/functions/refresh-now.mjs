// Déclenchement manuel du rafraîchissement complet de tout le roster.
// ?state=1 : l'état de la mise à jour automatique (toutes les 5 minutes), sans rien lancer.
// Protégé par un secret REFRESH_TOKEN pour que personne ne puisse le spammer.
//
// Appel : GET ou POST /.netlify/functions/refresh-now?key=LE_SECRET
// (ou en-tête "x-refresh-token: LE_SECRET")
//
// Clés lues UNIQUEMENT côté serveur (process.env) : HENRIK_KEY + REFRESH_TOKEN.

import { getStore } from "@netlify/blobs";
import { runRefresh } from "./lib/refresh-core.mjs";
import { loadRoster } from "./lib/roster-source.mjs";

const json = (obj, status) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

export default async (req) => {
  const token = process.env.REFRESH_TOKEN;
  if (!token) return json({ ok: false, error: "REFRESH_TOKEN non configuré côté serveur" }, 500);

  const url = new URL(req.url);
  const provided = url.searchParams.get("key") || req.headers.get("x-refresh-token") || "";
  if (provided !== token) return json({ ok: false, error: "non autorisé" }, 401);

  // État de la mise à jour automatique : quand elle est passée, et ce qu'elle a
  // fait (qui sortait de partie, combien de parties ajoutées). Aucun appel API.
  if (url.searchParams.get("state") === "1") {
    try {
      const c = await getStore("cosmo-refresh").get("cursor", { type: "json", consistency: "strong" });
      const ago = c && c.at ? Math.round((Date.now() - c.at) / 1000) : null;
      return json({ ok: true, lastRun: c && c.at ? new Date(c.at).toISOString() : null, secondsAgo: ago, ...(c || {}) }, 200);
    } catch (e) { return json({ ok: false, error: String((e && e.message) || e) }, 500); }
  }

  const apiKey = process.env.HENRIK_KEY;
  if (!apiKey) return json({ ok: false, error: "HENRIK_KEY manquante" }, 500);

  try {
    const { members, region } = await loadRoster(getStore);
    // delayMs réduit : on veut finir vite (limite de 10s sur le plan gratuit),
    // 7 membres restent largement sous le rate limit HenrikDev.
    const res = await runRefresh({ roster: members, region, getStore, fetchImpl: fetch, apiKey, delayMs: 100 });
    return json({ ok: true, ...res }, 200);
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e) }, 500);
  }
};
