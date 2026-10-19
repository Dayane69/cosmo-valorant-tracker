// Coeur logique du rafraîchissement quotidien, sans dépendance externe.
// Les dépendances (fetch, store Netlify Blobs, clé API) sont injectées pour
// que cette logique soit testable hors de l'environnement Netlify.

const HENRIK_BASE = "https://api.henrikdev.xyz";
const enc = encodeURIComponent;

// Identifiant stable d'un match, quel que soit le format.
// matches v3/v4 -> metadata ; stored-matches v1 -> meta (avec meta.id).
export function matchID(m) {
  const md = (m && (m.metadata || m.meta)) || {};
  return md.match_id || md.matchid || md.matchId || md.id || null;
}

// Horodatage d'un match (ms), pour trier du plus récent au plus ancien.
// Tolérant : ISO (started_at / game_start_iso) ou epoch (game_start, en secondes
// OU millisecondes selon la version de l'API).
export function matchTime(m) {
  const md = (m && (m.metadata || m.meta)) || {};
  const iso = md.started_at || md.game_start_iso;
  if (iso) { const t = new Date(iso).getTime(); if (!Number.isNaN(t)) return t; }
  if (typeof md.game_start === "number") return md.game_start < 1e12 ? md.game_start * 1000 : md.game_start;
  return 0;
}

// Clé de blob normalisée pour un joueur (insensible à la casse).
export function blobKey(name, tag) {
  return `${String(name).toLowerCase()}#${String(tag).toLowerCase()}`;
}

// Fusionne deux listes de matchs en dédoublonnant par matchid.
// `existing` est prioritaire (on garde la version déjà stockée), `fresh` ajoute
// uniquement les nouveaux matchs. Les matchs sans id sont conservés tels quels.
export function mergeStored(existing, fresh) {
  const byId = new Map();
  const extra = [];
  const add = (list) => (list || []).forEach((m) => {
    const id = matchID(m);
    if (id) { if (!byId.has(id)) byId.set(id, m); }
    else extra.push(m);
  });
  add(existing);
  add(fresh);
  const all = [...byId.values(), ...extra];
  all.sort((a, b) => matchTime(b) - matchTime(a));
  return all;
}

// Fetch JSON avec retry borné sur 429 (rate limit), en respectant Retry-After.
// Les temps d'attente sont plafonnés pour rester sous la limite d'exécution Netlify.
async function fetchJSON(fetchImpl, url, headers, { retries = 2, sleep } = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, { headers });
    if (res.ok) return res.json();
    if (res.status === 429 && attempt < retries) {
      const ra = Number(res.headers && res.headers.get && res.headers.get("retry-after")) || 0;
      await wait(ra > 0 ? Math.min(ra * 1000, 3000) : 800 * (attempt + 1));
      continue;
    }
    const e = new Error("HTTP " + res.status); e.status = res.status; throw e;
  }
}

/* Partie v4 (complète) -> format compact de stored-matches v1, pour UN joueur.
   Pourquoi : stored-matches n'a une partie qu'une fois qu'HenrikDev l'a rangée,
   avec du retard. matches v4, lui, l'a dès la fin de la partie, et on l'appelle
   de toute façon : autant en garder les parties tout de suite, au même format
   que l'historique (le site et le récap ne voient pas la différence). */
export function v4ToCompact(m, member) {
  const md = (m && m.metadata) || null;
  if (!md || !md.match_id || !member) return null;
  const n = String(member.name || "").toLowerCase(), t = String(member.tag || "").toLowerCase();
  const p = (Array.isArray(m.players) ? m.players : []).find((x) => x
    && String(x.name || "").toLowerCase() === n && String(x.tag || "").toLowerCase() === t);
  if (!p) return null;
  const st = p.stats || {}, dmg = st.damage || {}, q = md.queue || {};
  const won = {};
  (Array.isArray(m.teams) ? m.teams : []).forEach((tm) => {
    const k = String((tm && tm.team_id) || "").toLowerCase();
    if (k === "red" || k === "blue") won[k] = Number((tm.rounds && tm.rounds.won) || 0);
  });
  return {
    meta: {
      id: md.match_id, map: md.map || null, version: md.game_version || null,
      mode: q.name || (q.id === "custom" ? "Custom Game" : q.id) || "",
      started_at: md.started_at || null, season: md.season || null,
      region: md.region || null, cluster: md.cluster || null,
    },
    stats: {
      puuid: p.puuid || null, name: "", tag: "", team: p.team_id || null, level: p.account_level || null,
      character: { id: (p.agent && p.agent.id) || null, name: (p.agent && p.agent.name) || null },
      tier: p.tier && p.tier.id != null ? p.tier.id : null,
      score: Number(st.score || 0), kills: Number(st.kills || 0), deaths: Number(st.deaths || 0), assists: Number(st.assists || 0),
      shots: { head: Number(st.headshots || 0), body: Number(st.bodyshots || 0), leg: Number(st.legshots || 0) },
      damage: { made: Number(dmg.dealt || 0), received: Number(dmg.received || 0) },
    },
    teams: { red: won.red || 0, blue: won.blue || 0 },
  };
}
const v4Compacts = (v4, member) => {
  const list = (v4 && (v4.data || v4)) || [];
  return (Array.isArray(list) ? list : []).map((m) => v4ToCompact(m, member)).filter(Boolean);
};

// Pour un membre : déclenche (optionnellement) matches v4 — ce qui fait grossir
// le cache HenrikDev côté serveur — puis récupère tout l'historique stocké.
// trigger=false quand l'appel v4 a déjà été fait juste avant (ex: ouverture de
// profil côté front) : on économise alors une requête.
export async function refreshMember(member, { fetchImpl, apiKey, region, trigger = true, sleep, retries, collect }) {
  const headers = { Authorization: apiKey };
  const r = region || member.region || "eu";
  const opts = { sleep, retries };
  if (trigger) {
    // matches v4 — alimente le stockage HenrikDev (peu importe qui déclenche l'appel)
    const v4 = await fetchJSON(
      fetchImpl,
      `${HENRIK_BASE}/valorant/v4/matches/${r}/pc/${enc(member.name)}/${enc(member.tag)}?size=10`,
      headers, opts
    ).catch(() => null); // un échec ici ne doit pas empêcher la lecture du stock existant
    // Cette réponse était jetée. Elle porte pourtant ce que l'historique
    // stocké n'a pas : le Performance Score de chaque partie (patch 13.06).
    if (collect && v4) {
      collect.perf = extractPerf(v4.data || v4, member);
      collect.recent = v4Compacts(v4, member);   // les parties du jour, sans attendre stored-matches
    }
  }
  // stored-matches — tout l'historique déjà stocké pour ce joueur
  const stored = await fetchJSON(
    fetchImpl,
    `${HENRIK_BASE}/valorant/v1/stored-matches/${r}/${enc(member.name)}/${enc(member.tag)}`,
    headers, opts
  );
  return (stored && stored.data) || [];
}

/* ===================== PERFORMANCE SCORE (patch 13.06) =====================
   Depuis le patch 13.06, Riot note chaque joueur sur 500 (« Performance
   Score ») à la place de l'ACS. HenrikDev le renvoie dans les parties
   complètes (players[].performance), pas dans l'historique compact. On en
   garde l'essentiel, par partie : la note, la mention, l'appréciation par axe
   et le MVP. */
const PERF_KEEP = 800;   // ~ plusieurs mois de parties : de quoi couvrir un acte

export function extractPerf(matches, member) {
  const me = (p) => p && (String(p.name || "").toLowerCase() === String(member.name).toLowerCase()
    && String(p.tag || "").toLowerCase() === String(member.tag).toLowerCase());
  return (Array.isArray(matches) ? matches : []).map((m) => {
    const id = matchID(m);
    const p = (m && Array.isArray(m.players) ? m.players : []).find(me);
    const pf = p && p.performance;
    if (!id || !pf || pf.score == null || Number.isNaN(Number(pf.score))) return null;
    const rt = pf.ratings || {};
    const mvp = m.metadata && m.metadata.mvp;
    return {
      id, ts: matchTime(m),
      ps: Math.round(Number(pf.score) * 10) / 10,
      g: rt.grade || null,
      r: Object.assign({}, rt.combat || {}, rt.utility || {}),
      mvp: !!(mvp && ((mvp.puuid && mvp.puuid === p.puuid) || me(mvp))),
    };
  }).filter(Boolean);
}

// Fusionne deux listes de notes par id de partie (la plus récente gagne), bornée.
export function mergePerf(existing, fresh) {
  const byId = new Map();
  (existing || []).forEach((e) => { if (e && e.id) byId.set(e.id, e); });
  (fresh || []).forEach((e) => { if (e && e.id) byId.set(e.id, e); });
  return [...byId.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, PERF_KEEP);
}

/* ===================== HISTORIQUE RR (long terme) ===================== */

// Horodatage (ms) d'une entrée d'historique MMR (date ISO ou epoch).
export function rrTime(e) {
  if (!e) return 0;
  if (e.ts != null && !Number.isNaN(Number(e.ts))) return Number(e.ts);
  const iso = e.date || e.date_raw;
  if (iso) { const t = new Date(iso).getTime(); if (!Number.isNaN(t)) return t; }
  if (typeof e.date_raw === "number") return e.date_raw < 1e12 ? e.date_raw * 1000 : e.date_raw;
  return 0;
}

// Normalise une entrée d'historique MMR (formats v1/v2) en un point RR compact.
export function normRRentry(h) {
  const id = h.match_id || h.matchid || h.matchId || h.id || null;
  const elo = (h.elo != null && !Number.isNaN(Number(h.elo))) ? Number(h.elo) : null;
  const rr = h.ranking_in_tier != null ? Number(h.ranking_in_tier) : (h.rr != null ? Number(h.rr) : null);
  const change = h.last_change != null ? Number(h.last_change)
    : (h.mmr_change_to_last_game != null ? Number(h.mmr_change_to_last_game) : null);
  const tier = h.tier ? { id: (h.tier.id != null ? h.tier.id : null), name: h.tier.name || "" }
    : (h.currenttier != null ? { id: h.currenttier, name: h.currenttierpatched || "" } : null);
  const season = (h.season && (h.season.short || h.season.id)) || h.season_id || null;
  const e = { id, elo, rr, change, tier, season, date: h.date || h.date_raw || null };
  e.ts = rrTime({ ...e, date_raw: h.date_raw });
  return e;
}

// Clé de dédoublonnage d'un point RR : match_id sinon horodatage.
export function rrKey(e) { return e && (e.id || (e.ts ? "t:" + e.ts : null)); }

// Fusionne deux séries RR (dédoublonnage par match_id/date), triées du + ancien au + récent.
export function mergeRR(existing, fresh) {
  const byKey = new Map();
  const add = (list) => (list || []).forEach((e) => { const k = rrKey(e); if (k && !byKey.has(k)) byKey.set(k, e); });
  add(existing); add(fresh);
  return [...byKey.values()].sort((a, b) => rrTime(a) - rrTime(b));
}

// Récupère l'historique MMR d'un membre, normalisé.
export async function fetchMmrHistory(member, { fetchImpl, apiKey, region, sleep, retries }) {
  const headers = { Authorization: apiKey };
  const r = region || member.region || "eu";
  const d = await fetchJSON(
    fetchImpl,
    `${HENRIK_BASE}/valorant/v2/mmr-history/${r}/pc/${enc(member.name)}/${enc(member.tag)}`,
    headers, { sleep, retries }
  ).catch(() => null);
  const hist = (d && d.data && (d.data.history || d.data)) || (d && d.history) || [];
  return (Array.isArray(hist) ? hist : []).map(normRRentry).filter((e) => rrKey(e));
}

/* ===================== REFRESH ===================== */

// Rafraîchit UN membre et écrit son blob (fusion par matchid). Utilisé par le cron,
// par le bouton manuel, et par la sauvegarde à l'ouverture d'un profil.
// Accumule aussi l'historique RR dans un blob dédié (progression long terme).
export async function refreshOne({ member, getStore, fetchImpl, apiKey, region, trigger = true, sleep, retries }) {
  const store = getStore("cosmo-history");
  const key = blobKey(member.name, member.tag);
  const collect = {};
  const fresh = await refreshMember(member, { fetchImpl, apiKey, region, trigger, sleep, retries, collect });
  const existing = (await store.get(key, { type: "json" })) || [];
  const merged = mergeStored(existing, fresh.concat(collect.recent || []));
  await store.setJSON(key, merged);

  // RR long terme : bonus, un échec ne doit pas faire rater la sauvegarde des matchs.
  let rrTotal = 0;
  try {
    const rrStore = getStore("cosmo-rr");
    const rrFresh = await fetchMmrHistory(member, { fetchImpl, apiKey, region, sleep, retries });
    const rrExisting = (await rrStore.get(key, { type: "json" })) || [];
    const rrMerged = mergeRR(rrExisting, rrFresh);
    await rrStore.setJSON(key, rrMerged);
    rrTotal = rrMerged.length;
  } catch (e) { /* pas de RR cette fois, tant pis */ }

  // Performance Score : bonus aussi, jamais bloquant.
  if (collect.perf && collect.perf.length) {
    try {
      const pStore = getStore("cosmo-perf");
      const pExisting = (await pStore.get(key, { type: "json" })) || [];
      await pStore.setJSON(key, mergePerf(pExisting, collect.perf));
    } catch (e) { /* tant pis cette fois */ }
  }

  return { added: Math.max(0, merged.length - existing.length), total: merged.length, rrTotal };
}

/* Mise à jour rapide d'un membre qui vient de jouer : UN appel (matches v4),
   ses parties converties au format compact et fusionnées dans l'historique,
   plus sa note de performance. */
export async function pullRecent({ member, getStore, fetchImpl, apiKey, region, sleep, retries }) {
  const r = region || member.region || "eu";
  const v4 = await fetchJSON(fetchImpl,
    `${HENRIK_BASE}/valorant/v4/matches/${r}/pc/${enc(member.name)}/${enc(member.tag)}?size=10`,
    { Authorization: apiKey }, { sleep, retries });
  const key = blobKey(member.name, member.tag);
  const store = getStore("cosmo-history");
  const existing = (await store.get(key, { type: "json" })) || [];
  const merged = mergeStored(existing, v4Compacts(v4, member));
  if (merged.length !== existing.length) await store.setJSON(key, merged);
  const perf = extractPerf(v4.data || v4, member);
  if (perf.length) {
    try {
      const pStore = getStore("cosmo-perf");
      await pStore.setJSON(key, mergePerf((await pStore.get(key, { type: "json" })) || [], perf));
    } catch (e) { /* la note attendra le prochain passage */ }
  }
  return { added: merged.length - existing.length };
}

/* LA SURVEILLANCE (toutes les 5 minutes)

   Le problème : une mise à jour complète coûte 3 appels par joueur (~22 s et
   21 appels pour le roster, sur une limite de 30 par minute). Une fois par
   heure, elle ne servait que 2 ou 3 joueurs par passage : il fallait jusqu'à
   3 h pour que tout le monde soit à jour, et le récap ou le rapport de session
   tombaient sur des parties manquantes.

   Ce qui la rend assez légère pour tourner toutes les 5 minutes :
   1. Détection : l'historique RR de chaque joueur, un petit appel. Une partie
      classée inconnue = il vient de jouer. (Le RR, au passage, est enregistré.)
   2. Ceux-là seulement : leurs parties récentes (un appel, matches v4).
   3. Un joueur par passage, à tour de rôle : la mise à jour complète, pour les
      parties non classées et le deathmatch, que le RR ne voit pas. Tout le
      roster y passe en ~35 minutes.
   Soit ~10 appels par passage au calme, 17 au plus si tout le monde sort de
   partie en même temps : sous les 30 par minute, avec de la place pour le site.

   `budgetMs` borne le temps (une fonction planifiée est coupée à 30 s). */
export async function watchRefresh({ roster, region, getStore, fetchImpl, apiKey, sweepKey = null,
  budgetMs = 18000, now = () => Date.now(), log = console, sleep, retries = 1 }) {
  if (!apiKey) throw new Error("HENRIK_KEY manquante");
  const list = Array.isArray(roster) ? roster.filter(Boolean) : [];
  const started = now(), over = () => budgetMs && now() - started >= budgetMs;
  const rrStore = getStore("cosmo-rr");
  const out = { checked: 0, played: [], pulled: 0, added: 0, swept: null, fail: 0, nextSweep: null };

  // 1. Qui vient de jouer ?
  const dirty = [];
  for (const m of list) {
    if (over()) break;
    const key = blobKey(m.name, m.tag);
    try {
      const fresh = await fetchMmrHistory(m, { fetchImpl, apiKey, region, sleep, retries });
      const existing = (await rrStore.get(key, { type: "json" })) || [];
      const known = new Set(existing.map(rrKey));
      if (fresh.some((e) => !known.has(rrKey(e)))) {
        await rrStore.setJSON(key, mergeRR(existing, fresh));
        dirty.push(m); out.played.push(key);
      }
      out.checked++;
    } catch (e) { out.fail++; log.error(`[watch] RR ${key}: ${(e && e.message) || e}`); }
  }

  // 2. Leurs parties, tout de suite.
  for (const m of dirty) {
    if (over()) break;
    try { const r = await pullRecent({ member: m, getStore, fetchImpl, apiKey, region, sleep, retries }); out.pulled++; out.added += r.added; }
    catch (e) { out.fail++; log.error(`[watch] parties ${blobKey(m.name, m.tag)}: ${(e && e.message) || e}`); }
  }

  // 3. Le tour complet d'un joueur (à tour de rôle).
  const order = rotateFrom(list, sweepKey);
  const sweep = order[0] || null;
  if (sweep && !over()) {
    try {
      const r = await refreshOne({ member: sweep, getStore, fetchImpl, apiKey, region, trigger: true, sleep, retries });
      out.swept = blobKey(sweep.name, sweep.tag); out.added += r.added;
    } catch (e) { out.fail++; log.error(`[watch] tour complet ${blobKey(sweep.name, sweep.tag)}: ${(e && e.message) || e}`); }
  }
  // Le suivant, même si celui-ci a échoué : un joueur en panne ne bloque pas le tour.
  out.nextSweep = order[1] ? blobKey(order[1].name, order[1].tag) : (sweep ? blobKey(sweep.name, sweep.tag) : null);
  log.log(`[watch] ${out.checked}/${list.length} vérifiés, ${out.played.length} sortent de partie, +${out.added} parties, tour complet : ${out.swept || "—"}`);
  return out;
}

/* Réordonne le roster pour commencer par un membre donné (sa clé de blob), le
   reste suivant dans l'ordre. Sert au relais entre deux exécutions : chacune
   reprend là où la précédente s'est arrêtée.
   Clé inconnue (membre retiré, renommé) : on repart du début plutôt que de ne
   rien faire — un curseur périmé ne doit jamais bloquer le rafraîchissement. */
export function rotateFrom(members, key) {
  const list = Array.isArray(members) ? members.slice() : [];
  if (!key) return list;
  const i = list.findIndex((m) => m && blobKey(m.name, m.tag) === key);
  return i > 0 ? list.slice(i).concat(list.slice(0, i)) : list;
}

/* Boucle principale du cron : séquentielle et espacée pour rester dans le rate
   limit HenrikDev. L'échec d'un membre est loggé mais ne stoppe pas la boucle.

   `budgetMs` borne le temps passé. Ce n'est pas un confort : une fonction
   Netlify est coupée net à 10 s, et une coupure au milieu d'un refreshOne perd
   le travail en cours ET ne dit pas où on s'est arrêté. On préfère rendre la
   main proprement et annoncer le membre suivant (`next`), que l'appelant
   mémorise pour la prochaine exécution. Un membre n'est donc jamais affamé,
   quel que soit le plafond réel de la plateforme.

   Le budget est vérifié AVANT chaque membre sauf le premier : une exécution
   doit toujours faire avancer au moins un membre, sinon un budget trop serré
   bloquerait tout le roster pour toujours. */
export async function runRefresh({ roster, region, getStore, fetchImpl, apiKey, log = console, delayMs = 200, sleep, budgetMs = 0, now = () => Date.now() }) {
  if (!apiKey) throw new Error("HENRIK_KEY manquante");
  const wait = sleep || ((ms) => new Promise((res) => setTimeout(res, ms)));
  const list = Array.isArray(roster) ? roster : [];
  const started = now();
  let ok = 0, fail = 0, added = 0, done = 0;

  for (const member of list) {
    if (budgetMs && done && now() - started >= budgetMs) break;
    try {
      const { added: gain, total } = await refreshOne({ member, getStore, fetchImpl, apiKey, region, trigger: true, sleep });
      added += gain;
      log.log(`[refresh] ${member.name}#${member.tag}: +${gain} (total ${total})`);
      ok++;
    } catch (e) {
      fail++;
      log.error(`[refresh] échec ${member.name}#${member.tag}: ${(e && e.message) || e}`);
    }
    done++;
    if (delayMs) await wait(delayMs);
  }

  const left = list.slice(done);
  const next = left.length ? blobKey(left[0].name, left[0].tag) : null;
  log.log(`[refresh] terminé: ${ok} ok, ${fail} échecs, +${added} matchs ajoutés`
    + (left.length ? ` — ${left.length} membre(s) au tour suivant, à partir de ${next}` : " — roster complet"));
  return { ok, fail, added, done, remaining: left.length, next };
}
