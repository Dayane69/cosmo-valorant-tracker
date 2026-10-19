// Récap Discord — l'orchestration : lire les blobs, choisir la session,
// dessiner la carte, l'envoyer au webhook, se souvenir de ce qui est posté.
// Toutes les dépendances sont injectées (getStore, fetch, lecture de fichiers)
// pour pouvoir tester sans Netlify, sans Discord et sans réseau.

import { blobKey } from "./refresh-core.mjs";
import { loadRoster } from "./roster-source.mjs";
import { squadSessions, pickSession, buildRecap } from "./recap-core.mjs";
import { recapSVG, renderPNG, missingChars, fallbackFont } from "./recap-card.mjs";

const POSTED_KEEP = 60;
const identities = (m) => {
  const raw = Array.isArray(m.alias) ? m.alias : (typeof m.alias === "string" ? m.alias.split(",") : []);
  const out = [{ name: m.name, tag: m.tag }];
  raw.forEach((s) => { const t = String(s).trim(), i = t.lastIndexOf("#"); if (i > 0 && i < t.length - 1) out.push({ name: t.slice(0, i), tag: t.slice(i + 1) }); });
  return out;
};

async function readAll(store, m) {
  const lists = await Promise.all(identities(m).map((x) => store.get(blobKey(x.name, x.tag), { type: "json" }).catch(() => null)));
  return [].concat(...lists.map((l) => (Array.isArray(l) ? l : [])));
}

export function shareURL(site, member, startMs, gapMin = 120) {
  const u = new URL(site);
  u.searchParams.set("s", `${member.name}#${member.tag}`);
  u.searchParams.set("t", String(startMs));
  u.searchParams.set("g", String(gapMin));
  return u.toString();
}

export function discordContent(recap, link, tz = "Europe/Paris") {
  const day = new Date(recap.start).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: tz });
  const rr = recap.members.filter((m) => m.rr != null).reduce((a, m) => a + m.rr, 0);
  const tog = recap.together != null && recap.together < recap.games ? ` (dont ${recap.together} ensemble)` : (recap.together != null ? " ensemble" : "");
  return `**Récap COSMO · ${day}** — ${recap.games} partie${recap.games > 1 ? "s" : ""} classée${recap.games > 1 ? "s" : ""}${tog}, ${recap.wins}V-${recap.losses}D`
    + ` · ${rr >= 0 ? "+" : ""}${rr} RR pour la squad\n${link ? `Rapport complet : <${link}>` : ""}`;
}

/* Sessions déjà postées. Lecture forte d'abord ; si l'environnement ne la
   permet pas, lecture normale plutôt que plus aucun récap. */
export async function readPosted(mem) {
  let v;
  try { v = await mem.get("posted", { type: "json", consistency: "strong" }); }
  catch (e) { v = await mem.get("posted", { type: "json" }); }
  return Array.isArray(v) ? v : [];
}

/* opts : { getStore, fetchImpl, now, webhook, post, force, readFile, wasmBytes, resvg?, site, tz, minMembers }
   Renvoie { status, recap?, png?, posted? }. */
export async function runRecap(opts) {
  const { getStore, fetchImpl = fetch, now = Date.now(), webhook, post = false, force = false,
    readFile, wasmBytes, resvg, site = "https://cosmo-valo.netlify.app/", tz = "Europe/Paris", minMembers } = opts;
  const { members } = await loadRoster(getStore);
  const hist = getStore("cosmo-history"), rrS = getStore("cosmo-rr"), pfS = getStore("cosmo-perf"), mem = getStore("cosmo-discord");
  const per = await Promise.all(members.map(async (m) => ({
    member: m, matches: await readAll(hist, m), rr: await readAll(rrS, m), perf: await readAll(pfS, m),
  })));
  // Lecture FORTE : par défaut, Netlify Blobs peut relire une copie vieille
  // d'une minute. Deux envois rapprochés (aperçu &post=1 relancé, ou aperçu
  // puis tâche planifiée) voyaient alors une liste sans la session qui venait
  // de partir, et la postaient une deuxième fois.
  // Mémoire illisible : on ne poste pas — mieux vaut un récap en retard
  // qu'un salon spammé à chaque heure.
  let posted;
  try { posted = await readPosted(mem); }
  catch (e) { if (post) return { status: "mémoire des récaps illisible : rien n'est envoyé (" + String((e && e.message) || e) + ")" }; posted = []; }
  const sessions = squadSessions(per);
  const s = pickSession(sessions, { now, posted, force, ...(minMembers ? { minMembers } : {}) });
  if (!s) return { status: "rien à poster" };
  const recap = buildRecap(s);

  // Portraits d'agents (valorant-api), intégrés à l'image.
  const icons = {};
  await Promise.all([...new Set(recap.members.map((m) => m.agentId).filter(Boolean))].map(async (id) => {
    try {
      const r = await fetchImpl(`https://media.valorant-api.com/agents/${id}/displayicon.png`);
      if (r.ok) icons[id] = "data:image/png;base64," + Buffer.from(await r.arrayBuffer()).toString("base64");
    } catch (e) { /* pas de portrait : un carré neutre à la place */ }
  }));
  const svg = recapSVG(recap, { icons, tz, site: new URL(site).host });
  const fonts = [400, 600, 800].map((w) => readFile(`Inter-${w}.ttf`));
  const extra = await fallbackFont(missingChars(recap.members.map((m) => m.name).concat(recap.best ? [recap.best.name] : [])), fetchImpl);
  if (extra) fonts.push(extra);
  const png = await renderPNG(svg, { wasm: wasmBytes, fonts, resvg });

  if (!post) return { status: "aperçu", recap, png };
  if (!webhook) return { status: "DISCORD_WEBHOOK_URL absent : rien n'est envoyé", recap, png };
  const mvp = recap.mvp && members.find((m) => m.name === recap.mvp.name && m.tag === recap.mvp.tag);
  const form = new FormData();
  form.append("payload_json", JSON.stringify({ content: discordContent(recap, mvp ? shareURL(site, mvp, recap.start) : "", tz), allowed_mentions: { parse: [] } }));
  form.append("files[0]", new Blob([png], { type: "image/png" }), "recap-cosmo.png");
  const res = await fetchImpl(webhook + (webhook.includes("?") ? "&" : "?") + "wait=true", { method: "POST", body: form });
  if (!res.ok) return { status: `Discord a refusé l'envoi (HTTP ${res.status})`, recap, png };
  // On ne se souvient de la session qu'une fois l'envoi réussi.
  try { await mem.setJSON("posted", [...posted.filter((k) => k !== s.key), s.key].slice(-POSTED_KEEP)); }
  catch (e) { return { status: "posté, mais pas mémorisé : risque de doublon (" + String((e && e.message) || e) + ")", recap, png, posted: s.key }; }
  return { status: "posté", recap, png, posted: s.key };
}
