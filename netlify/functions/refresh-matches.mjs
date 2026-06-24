// Fonction planifiée Netlify : tourne une fois par jour pour faire grossir
// l'historique de chaque membre, sans dépendre d'une visite humaine.
//
// Pour chaque joueur : on appelle matches v4 (ce qui pousse HenrikDev à
// interroger Riot et à stocker la partie), puis on lit stored-matches et on
// fusionne le tout dans un blob persistant (Netlify Blobs) par matchid.
//
// La clé API vit UNIQUEMENT dans process.env.HENRIK_KEY (jamais en dur).

import { getStore } from "@netlify/blobs";
import roster from "../../roster.json" with { type: "json" };
import { runRefresh } from "./lib/refresh-core.mjs";

export default async () => {
  const apiKey = process.env.HENRIK_KEY;
  const members = roster.members || roster;
  const region = roster.region || "eu";

  if (!apiKey) {
    return new Response(JSON.stringify({ ok: false, error: "HENRIK_KEY manquante" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  try {
    const res = await runRefresh({ roster: members, region, getStore, fetchImpl: fetch, apiKey });
    return new Response(JSON.stringify({ ok: true, ...res }), {
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e && e.message) || e) }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
};

// 04:00 UTC chaque jour (= 05h heure de Paris en hiver, 06h en été) : hors
// des sessions de jeu habituelles.
export const config = { schedule: "0 4 * * *" };
