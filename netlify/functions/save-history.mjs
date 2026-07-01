// Sauvegarde l'historique d'UN joueur dans le blob, à l'ouverture de son profil.
// Réparti les écritures (1 joueur à la fois) pour éviter de cogner le rate limit
// HenrikDev comme le fait le refresh massif. Restreint aux membres du roster pour
// que personne ne puisse brûler la clé API sur des comptes au hasard.
//
// GET/POST /.netlify/functions/save-history?name=X&tag=Y[&region=eu][&trigger=1]

import { getStore } from "@netlify/blobs";
import roster from "../../roster.json" with { type: "json" };
import { refreshOne } from "./lib/refresh-core.mjs";

const json = (obj, status) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

export default async (req) => {
  const apiKey = process.env.HENRIK_KEY;
  if (!apiKey) return json({ ok: false, error: "HENRIK_KEY manquante" }, 500);

  const url = new URL(req.url);
  const name = url.searchParams.get("name") || "";
  const tag = url.searchParams.get("tag") || "";

  const members = roster.members || roster;
  const member = members.find(
    (m) => String(m.name).toLowerCase() === name.toLowerCase() && String(m.tag).toLowerCase() === tag.toLowerCase()
  );
  if (!member) return json({ ok: false, error: "joueur hors roster" }, 403);

  const region = url.searchParams.get("region") || roster.region || "eu";
  // Par défaut on ne re-déclenche pas matches v4 : l'ouverture de profil l'a déjà fait.
  const trigger = url.searchParams.get("trigger") === "1";

  try {
    const res = await refreshOne({ member, getStore, fetchImpl: fetch, apiKey, region, trigger });
    return json({ ok: true, ...res }, 200);
  } catch (e) {
    // On propage le 429 pour que le client puisse temporiser et réessayer.
    const status = e && e.status === 429 ? 429 : 500;
    return json({ ok: false, error: String((e && e.message) || e) }, status);
  }
};
