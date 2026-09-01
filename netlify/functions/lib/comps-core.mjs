// Compos par map : projection compacte d'une partie complète.
//
// Pourquoi ce fichier existe. Les blobs `cosmo-history` viennent de
// stored-matches v1, qui ne renvoie QUE le joueur interrogé : on y connaît
// l'agent d'un membre COSMO, jamais celui des neuf autres. Impossible d'en
// tirer la moindre compo d'équipe.
// L'endpoint /valorant/v4/match/{region}/{id} renvoie les 10 joueurs, mais il
// pèse ~370 Ko. On n'en garde donc que ce qui sert : la map, la date, et pour
// chaque camp la liste des agents et le résultat. ~200 octets par partie.
//
// Ce qu'on obtient : DEUX compos réelles par partie (la nôtre et celle d'en
// face), avec leur résultat. C'est la population la plus large qu'on puisse
// observer honnêtement — il n'existe aucune API publique de winrate mondial
// par compo.

// Un agent par camp suffit à rendre la ligne exploitable, mais une compo
// tronquée fausserait les statistiques de composition : on exige les 5.
const TEAM_SIZE = 5;
const HENRIK_BASE_MATCH = "https://api.henrikdev.xyz";

// Horodatage (ms) d'une partie v4.
function startedAt(md) {
  if (!md) return 0;
  if (md.started_at) { const t = new Date(md.started_at).getTime(); if (!Number.isNaN(t)) return t; }
  if (typeof md.game_start === "number") return md.game_start < 1e12 ? md.game_start * 1000 : md.game_start;
  return 0;
}

// Le mode, en gardant le libellé lisible (le front filtre sur "Competitive").
function modeOf(md) {
  const q = (md && md.queue) || {};
  return q.name || q.id || (md && md.mode) || "";
}

// Projette une réponse /valorant/v4/match/... en une ligne compacte.
// Renvoie null si la partie est inexploitable — jamais un objet à moitié
// rempli, qui polluerait silencieusement les moyennes.
export function projectMatch(raw) {
  const d = (raw && raw.data) || raw;
  const md = d && d.metadata;
  if (!md || !Array.isArray(d.players) || !Array.isArray(d.teams)) return null;
  const id = md.match_id || md.matchid || md.id;
  if (!id) return null;

  // Une partie abandonnée en cours de route n'a pas de résultat exploitable.
  if (md.is_completed === false) return null;

  // Les agents, regroupés par camp, dans l'ordre des équipes déclarées.
  const sides = d.teams.map((t) => String((t && t.team_id) || ""));
  if (sides.length !== 2 || !sides[0] || !sides[1]) return null;

  const agents = [[], []];
  for (const p of d.players) {
    if (!p) continue;
    const side = sides.indexOf(String(p.team_id || ""));
    if (side < 0) continue;
    const name = (p.agent && p.agent.name) || (p.character && p.character.name) || p.character;
    if (!name) continue;
    agents[side].push(String(name));
  }
  // Compo incomplète (joueur parti avant la fin, données manquantes) : on jette.
  if (agents[0].length !== TEAM_SIZE || agents[1].length !== TEAM_SIZE) return null;
  // Trié : une compo est un ENSEMBLE, l'ordre des joueurs n'a aucun sens ici.
  agents.forEach((a) => a.sort());

  const rounds = d.teams.map((t) => Number((t && t.rounds && t.rounds.won) || 0));
  let won = d.teams.findIndex((t) => t && t.won === true);
  // Certaines parties n'ont pas de drapeau `won` fiable : on retombe sur le score.
  if (won < 0) won = rounds[0] === rounds[1] ? -1 : (rounds[0] > rounds[1] ? 0 : 1);

  return {
    id,
    map: (md.map && md.map.name) || "",
    mode: modeOf(md),
    at: startedAt(md),
    sides,                  // ["Red","Blue"] — permet de retrouver le camp de COSMO
    t: agents,              // [[5 agents], [5 agents]]
    r: rounds,              // manches gagnées par camp
    w: won,                 // index du camp vainqueur, -1 si égalité
  };
}

// Fusionne deux jeux de compos, en dédoublonnant par id.
// `existing` est prioritaire : une partie déjà projetée ne change plus.
export function mergeComps(existing, fresh) {
  const byId = new Map();
  const add = (list) => (list || []).forEach((c) => { if (c && c.id && !byId.has(c.id)) byId.set(c.id, c); });
  add(existing);
  add(fresh);
  return [...byId.values()].sort((a, b) => (b.at || 0) - (a.at || 0));
}

// Les ids de parties qu'il reste à projeter, les plus récentes d'abord.
// `limit` borne le travail d'un seul passage de cron : 635 parties à
// 60 requêtes/minute ne tiennent pas dans une exécution Netlify.
export function missingIDs(storedMatches, comps, limit) {
  const have = new Set((comps || []).map((c) => c && c.id).filter(Boolean));
  const seen = new Set();
  const out = [];
  for (const m of storedMatches || []) {
    const md = (m && (m.meta || m.metadata)) || {};
    const id = md.id || md.match_id || md.matchid;
    if (!id || have.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, at: startedAt(md), region: md.region || "eu" });
  }
  out.sort((a, b) => (b.at || 0) - (a.at || 0));
  return limit > 0 ? out.slice(0, limit) : out;
}

/* ===================== ALIMENTATION (cron) ===================== */

// Rejoue les parties pas encore projetées et les ajoute au blob.
//
// Le gros de l'historique est livré par comps.json (amorce statique, comme
// roster.json) : ce passage n'a donc qu'à rattraper les parties du jour, soit
// quelques unités. D'où un budget volontairement serré — une fonction Netlify
// n'a pas le droit de traîner, et rater quelques parties n'est pas grave,
// elles seront reprises au passage suivant.
export async function runCompsBackfill({
  getStore, fetchImpl, apiKey, storedMatches,
  limit = 20, budgetMs = 6000, spacingMs = 250, sleep, log = console, now = () => Date.now(),
}) {
  if (!apiKey) throw new Error("HENRIK_KEY manquante");
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const store = getStore("cosmo-comps");
  const doc = (await store.get("comps", { type: "json" })) || null;
  const existing = (doc && Array.isArray(doc.comps) ? doc.comps : Array.isArray(doc) ? doc : []) || [];

  const todo = missingIDs(storedMatches, existing, limit);
  const started = now();
  const fresh = [];
  let skipped = 0, failed = 0;

  for (const item of todo) {
    if (now() - started > budgetMs) break;   // on rend la main, le reste attendra demain
    try {
      const res = await fetchImpl(
        `${HENRIK_BASE_MATCH}/valorant/v4/match/${item.region}/${item.id}`,
        { headers: { Authorization: apiKey } }
      );
      if (!res.ok) { failed++; if (res.status === 429) break; continue; }
      const p = projectMatch(await res.json());
      if (p) fresh.push(p); else skipped++;
    } catch (e) { failed++; }
    if (spacingMs) await wait(spacingMs);
  }

  if (!fresh.length) {
    log.log(`[comps] rien de neuf (${todo.length} en attente, ${skipped} écartées, ${failed} échecs)`);
    return { added: 0, total: existing.length, pending: todo.length, skipped, failed };
  }

  const merged = mergeComps(existing, fresh);
  await store.setJSON("comps", { v: 1, updated: now(), comps: merged });
  log.log(`[comps] +${merged.length - existing.length} (total ${merged.length}, ${todo.length - fresh.length} restantes)`);
  return { added: merged.length - existing.length, total: merged.length,
           pending: Math.max(0, todo.length - fresh.length), skipped, failed };
}
