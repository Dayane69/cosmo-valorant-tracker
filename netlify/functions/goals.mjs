// Objectifs d'acte des membres (blob cosmo-goals, un seul document).
// - GET  : { goals: { "pseudo#tag": { act, tier, note, setAt } } }
// - POST : { name, tag, act, tier, note } — fixe (ou efface, tier vide)
//   l'objectif d'un joueur. Protégé : REFRESH_TOKEN, ou GOALS_TOKEN si
//   défini — une clé à donner aux potes pour qu'ils fixent LEUR objectif
//   sans pouvoir toucher au roster.

import { getStore } from "@netlify/blobs";

const json = (o, s) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const ACT_RE = /^e\d+a\d+$/i;
// Un palier Valorant : « Platinum 3 », « Radiant ». Rien d'autre ne passe.
const TIER_RE = /^(iron|bronze|silver|gold|platinum|diamond|ascendant|immortal) [1-3]$|^radiant$/i;

// Exporté pour être testé sans Netlify. null = requête invalide.
export function cleanGoal(b) {
  if (!b || typeof b !== "object") return null;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  const tag = typeof b.tag === "string" ? b.tag.trim() : "";
  const act = typeof b.act === "string" ? b.act.trim().toLowerCase() : "";
  const tier = typeof b.tier === "string" ? b.tier.trim().replace(/\s+/g, " ") : "";
  if (!name || !tag || name.length > 32 || tag.length > 16 || !ACT_RE.test(act)) return null;
  if (tier && !TIER_RE.test(tier)) return null;
  const note = typeof b.note === "string" ? b.note.trim().slice(0, 140) : "";
  return { key: `${name}#${tag}`.toLowerCase(), act, tier, note };
}

function authed(req) {
  const tokens = [process.env.REFRESH_TOKEN, process.env.GOALS_TOKEN].filter(Boolean);
  if (!tokens.length) return { ok: false, status: 500, error: "aucune clé configurée côté serveur" };
  const url = new URL(req.url);
  const provided = url.searchParams.get("key") || req.headers.get("x-refresh-token") || "";
  if (!tokens.includes(provided)) return { ok: false, status: 401, error: "clé invalide" };
  return { ok: true };
}

export default async (req) => {
  const store = (() => { try { return getStore("cosmo-goals"); } catch (e) { return null; } })();
  if (req.method === "GET") {
    if (!store) return json({ goals: {} }, 200);
    try { return json({ goals: (await store.get("goals", { type: "json" })) || {} }, 200); }
    catch (e) { return json({ goals: {} }, 200); }
  }
  if (req.method === "POST") {
    const a = authed(req);
    if (!a.ok) return json({ ok: false, error: a.error }, a.status);
    let body;
    try { body = await req.json(); } catch (e) { return json({ ok: false, error: "JSON invalide" }, 400); }
    const g = cleanGoal(body);
    if (!g) return json({ ok: false, error: "objectif invalide (pseudo, tag, acte « e11a6 », palier « Platinum 3 »)" }, 400);
    if (!store) return json({ ok: false, error: "stockage indisponible" }, 500);
    try {
      const all = (await store.get("goals", { type: "json" })) || {};
      if (g.tier) all[g.key] = { act: g.act, tier: g.tier, note: g.note, setAt: Date.now() };
      else delete all[g.key];
      await store.setJSON("goals", all);
      return json({ ok: true, goals: all }, 200);
    } catch (e) { return json({ ok: false, error: String((e && e.message) || e) }, 500); }
  }
  return json({ ok: false, error: "méthode non supportée" }, 405);
};
