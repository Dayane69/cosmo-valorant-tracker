// Roster éditable depuis l'UI, stocké dans un Netlify Blob (cosmo-roster).
// - GET  : renvoie le roster stocké (ou null -> le front retombe sur roster.json).
// - POST : enregistre le roster. Protégé par le secret REFRESH_TOKEN.
// - DELETE : réinitialise (revient à roster.json). Protégé aussi.
// roster.json reste la valeur de départ (seed) ; ceci ne l'écrase jamais.

import { getStore } from "@netlify/blobs";

const json = (o, s) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function cleanRoster(r) {
  if (!r || typeof r !== "object" || !Array.isArray(r.members)) return null;
  const members = r.members
    .filter((m) => m && typeof m.name === "string" && m.name.trim() && typeof m.tag === "string" && m.tag.trim())
    .slice(0, 50)
    .map((m) => {
      const out = {
        name: String(m.name).trim(),
        tag: String(m.tag).trim(),
        agent: m.agent ? String(m.agent).slice(0, 40) : "",
        role: m.role ? String(m.role).slice(0, 40) : "",
        color: m.color ? String(m.color).slice(0, 12) : "#8696a6",
        mono: m.mono ? String(m.mono).slice(0, 3) : String(m.agent || m.name).slice(0, 2),
      };
      if (m.uuid) out.uuid = String(m.uuid).slice(0, 64);
      if (m.customImg) out.customImg = String(m.customImg).slice(0, 500);
      return out;
    });
  if (!members.length) return null;
  return { region: (typeof r.region === "string" && r.region.trim()) || "eu", members };
}

function authed(req) {
  const token = process.env.REFRESH_TOKEN;
  if (!token) return { ok: false, status: 500, error: "REFRESH_TOKEN non configuré côté serveur" };
  const url = new URL(req.url);
  const provided = url.searchParams.get("key") || req.headers.get("x-refresh-token") || "";
  if (provided !== token) return { ok: false, status: 401, error: "non autorisé" };
  return { ok: true };
}

export default async (req) => {
  if (req.method === "GET") {
    // getStore peut échouer hors Netlify : on dégrade en roster null (repli roster.json).
    try { const r = await getStore("cosmo-roster").get("roster", { type: "json" }); return json({ roster: r || null }, 200); }
    catch (e) { return json({ roster: null }, 200); }
  }

  if (req.method === "POST" || req.method === "PUT") {
    const a = authed(req);
    if (!a.ok) return json({ ok: false, error: a.error }, a.status);
    let body;
    try { body = await req.json(); } catch (e) { return json({ ok: false, error: "JSON invalide" }, 400); }
    const clean = cleanRoster(body && body.members ? body : body && body.roster);
    if (!clean) return json({ ok: false, error: "roster invalide (chaque membre a besoin d'un name et d'un tag)" }, 400);
    try { await getStore("cosmo-roster").setJSON("roster", clean); return json({ ok: true, count: clean.members.length }, 200); }
    catch (e) { return json({ ok: false, error: String((e && e.message) || e) }, 500); }
  }

  if (req.method === "DELETE") {
    const a = authed(req);
    if (!a.ok) return json({ ok: false, error: a.error }, a.status);
    try { await getStore("cosmo-roster").delete("roster"); return json({ ok: true }, 200); }
    catch (e) { return json({ ok: false, error: String((e && e.message) || e) }, 500); }
  }

  return json({ ok: false, error: "méthode non supportée" }, 405);
};
