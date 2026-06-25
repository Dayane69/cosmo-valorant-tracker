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

async function fetchJSON(fetchImpl, url, headers) {
  const res = await fetchImpl(url, { headers });
  if (!res.ok) { const e = new Error("HTTP " + res.status); e.status = res.status; throw e; }
  return res.json();
}

// Pour un membre : déclenche (optionnellement) matches v4 — ce qui fait grossir
// le cache HenrikDev côté serveur — puis récupère tout l'historique stocké.
// trigger=false quand l'appel v4 a déjà été fait juste avant (ex: ouverture de
// profil côté front) : on économise alors une requête.
export async function refreshMember(member, { fetchImpl, apiKey, region, trigger = true }) {
  const headers = { Authorization: apiKey };
  const r = region || member.region || "eu";
  if (trigger) {
    // matches v4 — alimente le stockage HenrikDev (peu importe qui déclenche l'appel)
    await fetchJSON(
      fetchImpl,
      `${HENRIK_BASE}/valorant/v4/matches/${r}/pc/${enc(member.name)}/${enc(member.tag)}?size=10`,
      headers
    ).catch(() => null); // un échec ici ne doit pas empêcher la lecture du stock existant
  }
  // stored-matches — tout l'historique déjà stocké pour ce joueur
  const stored = await fetchJSON(
    fetchImpl,
    `${HENRIK_BASE}/valorant/v1/stored-matches/${r}/${enc(member.name)}/${enc(member.tag)}`,
    headers
  );
  return (stored && stored.data) || [];
}

// Rafraîchit UN membre et écrit son blob (fusion par matchid). Utilisé par le cron,
// par le bouton manuel, et par la sauvegarde à l'ouverture d'un profil.
export async function refreshOne({ member, getStore, fetchImpl, apiKey, region, trigger = true }) {
  const store = getStore("cosmo-history");
  const key = blobKey(member.name, member.tag);
  const fresh = await refreshMember(member, { fetchImpl, apiKey, region, trigger });
  const existing = (await store.get(key, { type: "json" })) || [];
  const merged = mergeStored(existing, fresh);
  await store.setJSON(key, merged);
  return { added: Math.max(0, merged.length - existing.length), total: merged.length };
}

// Boucle principale du cron : séquentielle et espacée pour rester dans le rate
// limit HenrikDev. L'échec d'un membre est loggé mais ne stoppe pas la boucle.
export async function runRefresh({ roster, region, getStore, fetchImpl, apiKey, log = console, delayMs = 200, sleep }) {
  if (!apiKey) throw new Error("HENRIK_KEY manquante");
  const wait = sleep || ((ms) => new Promise((res) => setTimeout(res, ms)));
  let ok = 0, fail = 0, added = 0;

  for (const member of roster) {
    try {
      const { added: gain, total } = await refreshOne({ member, getStore, fetchImpl, apiKey, region, trigger: true });
      added += gain;
      log.log(`[refresh] ${member.name}#${member.tag}: +${gain} (total ${total})`);
      ok++;
    } catch (e) {
      fail++;
      log.error(`[refresh] échec ${member.name}#${member.tag}: ${(e && e.message) || e}`);
    }
    if (delayMs) await wait(delayMs);
  }

  log.log(`[refresh] terminé: ${ok} ok, ${fail} échecs, +${added} matchs ajoutés`);
  return { ok, fail, added };
}
