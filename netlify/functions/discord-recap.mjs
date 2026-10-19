// Récap Discord automatique : tous les quarts d'heure, poste la dernière
// session de la squad terminée (plus de partie depuis 2 h) et pas encore
// postée. Les historiques sont à jour à 5 minutes près (refresh-matches), donc
// le récap part entre 2 h et 2 h 15 après la dernière partie, au lieu de
// jusqu'à 3 h. Un passage sans session à poster ne fait que lire les blobs.
// Ne fait rien tant que DISCORD_WEBHOOK_URL n'est pas défini.
import { getStore } from "@netlify/blobs";
import { runRecap } from "./lib/recap-run.mjs";
import { readFont, readWasm } from "./lib/recap-assets.mjs";

export default async () => {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) { console.log("[recap] DISCORD_WEBHOOK_URL absent : rien à faire"); return new Response("off"); }
  try {
    const r = await runRecap({ getStore, webhook, post: true, readFile: readFont, wasmBytes: readWasm(),
      site: process.env.URL || "https://cosmo-valo.netlify.app/", tz: process.env.RECAP_TZ || "Europe/Paris",
      minMembers: Number(process.env.DISCORD_MIN_PLAYERS) || undefined });
    console.log("[recap]", r.status, r.posted || "");
    return new Response(r.status);
  } catch (e) {
    console.log("[recap] échec :", (e && e.message) || e);
    return new Response("erreur", { status: 500 });
  }
};

// Décalé des passages de refresh-matches (toutes les 5 min, à :00, :05…).
export const config = { schedule: "7,22,37,52 * * * *" };
