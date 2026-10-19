// Aperçu du récap Discord, protégé par REFRESH_TOKEN :
//   GET ?key=…          -> l'image PNG de la dernière session squad terminée
//                          (même déjà postée : c'est un aperçu)
//   GET ?key=…&post=1   -> la poste vraiment sur le webhook
//   GET ?key=…&state=1  -> les sessions déjà postées (rien n'est envoyé)
// Une fonction planifiée ne s'appelle pas par URL : celle-ci sert à voir la
// carte et à tester le webhook sans attendre la prochaine heure.
import { getStore } from "@netlify/blobs";
import { runRecap, readPosted } from "./lib/recap-run.mjs";
import { readFont, readWasm } from "./lib/recap-assets.mjs";

const json = (o, s) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async (req) => {
  const url = new URL(req.url);
  const token = process.env.REFRESH_TOKEN;
  if (!token) return json({ ok: false, error: "REFRESH_TOKEN non configuré côté serveur" }, 500);
  if ((url.searchParams.get("key") || "") !== token) return json({ ok: false, error: "non autorisé" }, 401);
  const post = url.searchParams.get("post") === "1";
  if (url.searchParams.get("state") === "1") {
    try { return json({ ok: true, posted: await readPosted(getStore("cosmo-discord")) }, 200); }
    catch (e) { return json({ ok: false, error: String((e && e.message) || e) }, 500); }
  }
  try {
    const r = await runRecap({ getStore, webhook: process.env.DISCORD_WEBHOOK_URL, post, force: !post,
      readFile: readFont, wasmBytes: readWasm(), site: process.env.URL || "https://cosmo-valo.netlify.app/",
      tz: process.env.RECAP_TZ || "Europe/Paris", minMembers: Number(process.env.DISCORD_MIN_PLAYERS) || undefined });
    if (!r.png) return json({ ok: true, status: r.status }, 200);
    if (post) return json({ ok: !!r.posted, status: r.status, session: r.posted || null }, r.posted ? 200 : 502);
    return new Response(r.png, { status: 200, headers: { "content-type": "image/png", "cache-control": "no-store" } });
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e) }, 500);
  }
};
