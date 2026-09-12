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

// Pour un membre : déclenche (optionnellement) matches v4 — ce qui fait grossir
// le cache HenrikDev côté serveur — puis récupère tout l'historique stocké.
// trigger=false quand l'appel v4 a déjà été fait juste avant (ex: ouverture de
// profil côté front) : on économise alors une requête.
export async function refreshMember(member, { fetchImpl, apiKey, region, trigger = true, sleep, retries }) {
  const headers = { Authorization: apiKey };
  const r = region || member.region || "eu";
  const opts = { sleep, retries };
  if (trigger) {
    // matches v4 — alimente le stockage HenrikDev (peu importe qui déclenche l'appel)
    await fetchJSON(
      fetchImpl,
      `${HENRIK_BASE}/valorant/v4/matches/${r}/pc/${enc(member.name)}/${enc(member.tag)}?size=10`,
      headers, opts
    ).catch(() => null); // un échec ici ne doit pas empêcher la lecture du stock existant
  }
  // stored-matches — tout l'historique déjà stocké pour ce joueur
  const stored = await fetchJSON(
    fetchImpl,
    `${HENRIK_BASE}/valorant/v1/stored-matches/${r}/${enc(member.name)}/${enc(member.tag)}`,
    headers, opts
  );
  return (stored && stored.data) || [];
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
  const fresh = await refreshMember(member, { fetchImpl, apiKey, region, trigger, sleep, retries });
  const existing = (await store.get(key, { type: "json" })) || [];
  const merged = mergeStored(existing, fresh);
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

  return { added: Math.max(0, merged.length - existing.length), total: merged.length, rrTotal };
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
