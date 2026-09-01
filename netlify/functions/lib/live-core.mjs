// « En ce moment » : état de jeu en direct, poussé par le compagnon PC.
//
// Pourquoi ça ne peut pas venir d'une API publique. Aucun service distant
// n'expose une partie en cours : ni HenrikDev (les 58 routes de sa spec
// OpenAPI sont post-partie), ni Riot publiquement. Le « Competitive — Ascent
// 7-5 » qu'on voit sur Discord vient d'un programme lancé sur le PC du joueur,
// qui lit l'API LOCALE que le client VALORANT ouvre sur 127.0.0.1 pendant
// qu'il tourne. C'est la seule source, et elle est sur la machine du joueur.
//
// Ce fichier ne fait donc que recevoir, nettoyer et servir ce que le
// compagnon envoie. Il ne devine rien : sans compagnon, il n'y a pas d'état
// en direct, et l'accueil retombe sur ce qu'il sait déjà (les parties finies).
//
// Rien de sensible n'est stocké : le compagnon garde ses jetons Riot pour lui
// et n'envoie que ce que le jeu affiche déjà à l'écran.

// Au-delà, l'état n'est plus « en direct » : le compagnon envoie toutes les
// ~20 s, donc trois envois manqués suffisent à considérer qu'il a été fermé
// (ou que le PC a été éteint en pleine partie).
export const LIVE_TTL_MS = 90_000;
// La boutique tourne une fois par jour : elle reste valable bien plus
// longtemps qu'un score, et n'a pas à disparaître quand le jeu se ferme.
export const STORE_TTL_MS = 26 * 3600_000;

const MAX_PLAYERS = 40;
const STATES = { menus: 1, pregame: 1, ingame: 1, away: 1 };

const str = (v, max) => {
  const s = String(v == null ? "" : v).trim();
  return s.length > max ? s.slice(0, max) : s;
};
const num = (v, min, max) => {
  // Number(null), Number(""), Number([]) et Number(false) valent tous 0 : sans
  // ce garde-fou, une moitié de score absente s'afficherait « 7 - 0 ».
  if (typeof v !== "number" && typeof v !== "string") return null;
  if (typeof v === "string" && !v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : null;
};
// Un uuid Riot, et rien d'autre : ces valeurs finissent dans des URL
// valorant-api côté navigateur.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuids = (list, max) =>
  (Array.isArray(list) ? list : []).filter((x) => typeof x === "string" && UUID_RE.test(x)).slice(0, max);

// Clé d'un joueur, alignée sur celle des autres blobs (pseudo#tag en minuscules).
export function liveKey(name, tag) {
  return `${String(name || "").toLowerCase()}#${String(tag || "").toLowerCase()}`;
}

/* Nettoie ce qu'un compagnon envoie. Renvoie null si le message n'identifie
   pas un joueur : mieux vaut refuser que d'écrire une entrée anonyme qui ne
   correspondra jamais à personne du roster. */
export function cleanLive(payload, now) {
  const p = payload && typeof payload === "object" ? payload : null;
  if (!p) return null;
  const name = str(p.name, 32), tag = str(p.tag, 16);
  if (!name || !tag) return null;

  const state = STATES[String(p.state || "").toLowerCase()] ? String(p.state).toLowerCase() : "menus";
  const out = {
    key: liveKey(name, tag),
    name, tag, state,
    map: str(p.map, 40),
    mode: str(p.mode, 40),
    agent: str(p.agent, 40),
    at: num(now, 0, Number.MAX_SAFE_INTEGER),
  };

  // Le score n'a de sens qu'en partie, et seulement s'il est complet : un
  // demi-score afficherait « 13 - null ».
  const a = num(p.scoreAlly, 0, 99), b = num(p.scoreEnemy, 0, 99);
  if (out.state === "ingame" && a != null && b != null) out.score = [a, b];

  const size = num(p.partySize, 1, 5), max = num(p.partyMax, 1, 5);
  if (size != null) out.party = { size, max: max != null && max >= size ? max : size };

  const tier = num(p.tier, 0, 30);
  if (tier != null) out.tier = tier;

  // La boutique arrive séparément et vit plus longtemps que l'état de jeu :
  // on la garde à part pour ne pas la perdre quand le joueur ferme le jeu.
  const st = p.store && typeof p.store === "object" ? p.store : null;
  if (st) {
    const offers = uuids(st.offers, 4);
    const night = uuids(st.night, 8);
    const bundle = uuids(st.bundle, 1)[0] || "";
    if (offers.length || night.length || bundle) {
      out.store = { at: out.at, offers };
      if (night.length) out.store.night = night;
      if (bundle) out.store.bundle = bundle;
      const left = num(st.secondsLeft, 0, 172800);
      if (left != null) out.store.secondsLeft = left;
    }
  }
  return out;
}

/* Fusionne une entrée fraîche dans le document stocké.
   La boutique déjà connue est CONSERVÉE quand le nouvel envoi n'en porte pas :
   le compagnon ne la relit qu'une fois par jour, chaque envoi d'état de jeu ne
   doit pas l'effacer. */
export function mergeLive(doc, entry) {
  const players = (doc && Array.isArray(doc.players) ? doc.players : []).filter((x) => x && x.key);
  const out = players.filter((x) => x.key !== entry.key);
  const prev = players.find((x) => x.key === entry.key);
  const merged = { ...entry };
  if (!merged.store && prev && prev.store) merged.store = prev.store;
  out.push(merged);
  out.sort((a, b) => (b.at || 0) - (a.at || 0));
  return { v: 1, updated: entry.at, players: out.slice(0, MAX_PLAYERS) };
}

/* Vue servie au navigateur. Une entrée périmée n'est pas supprimée — elle
   redevient simplement « pas en direct », et sa boutique reste lisible tant
   qu'elle vaut pour aujourd'hui. */
export function liveView(doc, now) {
  const players = (doc && Array.isArray(doc.players) ? doc.players : []).filter((x) => x && x.key);
  return players.map((p) => {
    const age = Math.max(0, now - (p.at || 0));
    const live = age <= LIVE_TTL_MS;
    const v = {
      key: p.key, name: p.name, tag: p.tag,
      state: live ? p.state : "off",
      live, age,
      map: live ? p.map || "" : "",
      mode: live ? p.mode || "" : "",
      agent: live ? p.agent || "" : "",
    };
    if (live && p.score) v.score = p.score;
    if (live && p.party) v.party = p.party;
    if (live && p.tier != null) v.tier = p.tier;
    if (p.store && now - (p.store.at || 0) <= STORE_TTL_MS) v.store = p.store;
    return v;
  }).sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0) || a.age - b.age);
}
