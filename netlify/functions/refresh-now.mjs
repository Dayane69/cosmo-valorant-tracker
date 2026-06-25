// Déclenchement manuel du rafraîchissement (même logique que le cron quotidien).
// Protégé par un secret REFRESH_TOKEN pour que personne ne puisse le spammer.
//
// Appel : GET ou POST /.netlify/functions/refresh-now?key=LE_SECRET
// (ou en-tête "x-refresh-token: LE_SECRET")
//
// Clés lues UNIQUEMENT côté serveur (process.env) : HENRIK_KEY + REFRESH_TOKEN.

import { getStore } from "@netlify/blobs";
import roster from "../../roster.json" with { type: "json" };
import { runRefresh } from "./lib/refresh-core.mjs";

const json = (obj, status) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

export default async (req) => {
  const token = process.env.REFRESH_TOKEN;
  if (!token) return json({ ok: false, error: "REFRESH_TOKEN non configuré côté serveur" }, 500);

  const url = new URL(req.url);
  const provided = url.searchParams.get("key") || req.headers.get("x-refresh-token") || "";
  if (provided !== token) return json({ ok: false, error: "non autorisé" }, 401);

  const apiKey = process.env.HENRIK_KEY;
  if (!apiKey) return json({ ok: false, error: "HENRIK_KEY manquante" }, 500);

  try {
    const members = roster.members || roster;
    const region = roster.region || "eu";
    // delayMs réduit : on veut finir vite (limite de 10s sur le plan gratuit),
    // 7 membres restent largement sous le rate limit HenrikDev.
    const res = await runRefresh({ roster: members, region, getStore, fetchImpl: fetch, apiKey, delayMs: 100 });
    return json({ ok: true, ...res }, 200);
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e) }, 500);
  }
};
