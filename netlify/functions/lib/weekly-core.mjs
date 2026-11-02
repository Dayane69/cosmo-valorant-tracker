// Récap de la SEMAINE — le calcul, sans réseau ni rendu.
//
// Une semaine va du lundi 6 h au lundi suivant 6 h (heure locale), comme les
// journées du bilan du jour : une partie à 2 h du matin la nuit de dimanche à
// lundi appartient encore au dimanche. Le récap part le lundi après 6 h.
//
// Entrée : l'historique stocké de chaque membre (parties compactes, série RR,
// notes de performance), le même que pour les autres récaps.

import { collectEntries, dayWindow, tzOffsetMs, DAY_CUT_HOUR } from "./recap-core.mjs";

const num = (v, f = 0) => (v === undefined || v === null || Number.isNaN(Number(v)) ? f : Number(v));
const key = (m) => `${String(m.name).toLowerCase()}#${String(m.tag).toLowerCase()}`;
const DAY = 86400000;

/* Paliers : numéro Riot (3 = Fer 1 … 27 = Radiant) <-> elo. Le niveau continu
   (elo) vaut 100 par palier : numéro = floor(elo / 100) + 3 (Platine 1 = 15 =
   elo 1200 à 1299). */
const TIER_NAMES = [null, null, null,
  "Iron 1", "Iron 2", "Iron 3", "Bronze 1", "Bronze 2", "Bronze 3", "Silver 1", "Silver 2", "Silver 3",
  "Gold 1", "Gold 2", "Gold 3", "Platinum 1", "Platinum 2", "Platinum 3", "Diamond 1", "Diamond 2", "Diamond 3",
  "Ascendant 1", "Ascendant 2", "Ascendant 3", "Immortal 1", "Immortal 2", "Immortal 3", "Radiant"];
export const TIER_OFFSET = 3;
export const tierIdOfElo = (elo) => Math.max(3, Math.min(27, Math.floor(num(elo) / 100) + TIER_OFFSET));
export const tierNameOf = (id) => TIER_NAMES[id] || "";
export const rrInTier = (elo) => ((Math.round(num(elo)) % 100) + 100) % 100;

/* La semaine (lundi 6 h -> lundi 6 h) : celle qui commence le lundi `monday`
   (« AAAA-MM-JJ »), ou la dernière terminée à l'instant `now`. */
export function weekWindow({ now, tz = "Europe/Paris", monday = null, cutHour = DAY_CUT_HOUR }) {
  let y, m, d;
  if (monday) { [y, m, d] = String(monday).split("-").map(Number); m -= 1; }
  else {
    const local = new Date(now - cutHour * 3600000 + tzOffsetMs(now, tz));   // jour de jeu en cours
    const dow = (local.getUTCDay() + 6) % 7;                                  // lundi = 0
    const cur = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - dow);
    const prev = new Date(cur - 7 * DAY);
    y = prev.getUTCFullYear(); m = prev.getUTCMonth(); d = prev.getUTCDate();
  }
  const iso = (Y, M, D) => { const t = new Date(Date.UTC(Y, M, D)); return t.toISOString().slice(0, 10); };
  const days = Array.from({ length: 8 }, (_, i) => dayWindow({ date: iso(y, m, d + i), tz, cutHour }).start);
  return { key: "w" + iso(y, m, d), monday: iso(y, m, d), sunday: iso(y, m, d + 6), start: days[0], end: days[7], days };
}

// Courbe d'elo d'un membre sur la semaine, avec le point de départ (le dernier
// niveau connu avant le lundi) et les changements de palier.
function curveOf(rr, w) {
  const pts = (rr || []).filter((e) => e && e.elo != null && num(e.ts) > 0).slice().sort((a, b) => num(a.ts) - num(b.ts));
  const before = pts.filter((e) => num(e.ts) < w.start).pop() || null;
  const inWeek = pts.filter((e) => num(e.ts) >= w.start && num(e.ts) < w.end);
  if (!inWeek.length) return null;
  const first = inWeek[0];
  const startElo = before ? num(before.elo)
    : num(first.elo) - num(first.change);                       // pas d'historique avant : niveau d'avant la 1re partie
  const points = [{ t: w.start, elo: startElo, start: true }].concat(inWeek.map((e) => ({ t: num(e.ts), elo: num(e.elo), id: e.id || null })));
  const events = [];
  for (let i = 1; i < points.length; i++) {
    const a = tierIdOfElo(points[i - 1].elo), b = tierIdOfElo(points[i].elo);
    if (a !== b) events.push({ t: points[i].t, i, from: a, to: b, up: b > a });
  }
  const endElo = points[points.length - 1].elo;
  return { points, events, startElo, endElo, net: endElo - startElo, peak: Math.max(...points.map((p) => p.elo)) };
}

const longestStreak = (games) => {
  let best = 0, cur = 0;
  games.forEach((g) => { cur = g.result === "w" ? cur + 1 : 0; best = Math.max(best, cur); });
  return best;
};
const mostCommon = (arr) => {
  const c = {}; let best = null;
  arr.forEach((x) => { if (!x) return; c[x] = (c[x] || 0) + 1; if (!best || c[x] > c[best]) best = x; });
  return best;
};

/* Le récap de la semaine, prêt à dessiner (ou null si personne n'a joué). */
export function buildWeek(perMember, w) {
  const all = collectEntries(perMember).filter((en) => en.M.t >= w.start && en.M.t < w.end);
  if (!all.length) return null;
  const dayIdx = (t) => { let i = 0; while (i < 6 && t >= w.days[i + 1]) i++; return i; };

  const members = (perMember || []).map((p) => {
    const G = all.filter((en) => key(en.member) === key(p.member)).map((en) => en.M);
    const curve = curveOf(p.rr, w);
    if (!G.length && !curve) return null;
    const rounds = G.reduce((a, g) => a + g.rounds, 0) || 1;
    const k = G.reduce((a, g) => a + g.k, 0), d = G.reduce((a, g) => a + g.d, 0);
    const shots = G.reduce((a, g) => a + g.head + g.body + g.leg, 0), head = G.reduce((a, g) => a + g.head, 0);
    const psG = G.filter((g) => g.ps != null);
    const agentId = mostCommon(G.map((g) => g.agentId));
    const days = Array.from({ length: 7 }, () => ({ n: 0, rr: 0 }));
    G.forEach((g) => { const c = days[dayIdx(g.t)]; c.n++; if (g.rr != null) c.rr += g.rr; });
    const gamesRR = G.filter((g) => g.rr != null).reduce((a, g) => a + g.rr, 0);
    const best = G.slice().sort((a, b) => (b.ps != null ? b.ps : b.score / (b.rounds || 1)) - (a.ps != null ? a.ps : a.score / (a.rounds || 1)))[0] || null;
    return {
      key: key(p.member), name: p.member.name, tag: p.member.tag,
      n: G.length, w: G.filter((g) => g.result === "w").length, l: G.filter((g) => g.result === "l").length,
      together: G.filter((g) => g.together).length,
      // Le RR de la semaine : la différence de NIVEAU (elo) entre lundi et la
      // fin de semaine. Elle compte tout, y compris ce qui n'est pas lié à une
      // partie (bonus de montée, protection de rang, pénalité d'esquive).
      rr: curve ? curve.net : (G.some((g) => g.rr != null) ? gamesRR : null),
      startElo: curve ? curve.startElo : null, endElo: curve ? curve.endElo : null, peak: curve ? curve.peak : null,
      curve, events: curve ? curve.events : [],
      ps: psG.length ? psG.reduce((a, g) => a + g.ps, 0) / psG.length : null, psN: psG.length,
      acs: G.length ? G.reduce((a, g) => a + g.score, 0) / rounds : null,
      kd: d ? k / d : (k || null), hs: shots ? head / shots * 100 : null, shots,
      adr: G.length ? G.reduce((a, g) => a + g.dmg, 0) / rounds : null,
      agentId, agent: (G.find((g) => g.agentId === agentId) || {}).agent || "",
      streak: longestStreak(G), days, best,
      mvps: G.filter((g) => g.mvp).length,
    };
  }).filter(Boolean);
  if (!members.length) return null;
  members.sort((a, b) => (b.rr == null ? -1e9 : b.rr) - (a.rr == null ? -1e9 : a.rr) || b.n - a.n);

  // Parties distinctes (une partie jouée à trois compte une fois).
  const byId = new Map();
  all.forEach((en) => { if (!byId.has(en.M.id)) byId.set(en.M.id, en.M); });
  const games = [...byId.values()];
  const togetherIds = new Set(all.filter((en) => en.M.together).map((en) => en.M.id));
  const maps = {};
  games.forEach((g) => { if (!g.map) return; const m = maps[g.map] || (maps[g.map] = { name: g.map, n: 0, w: 0 }); m.n++; if (g.result === "w") m.w++; });

  // Duos de la semaine : deux membres dans la même équipe, au moins 3 fois.
  const pairs = {};
  const byMatch = {};
  all.forEach((en) => { (byMatch[en.M.id + "|" + en.M.team] = byMatch[en.M.id + "|" + en.M.team] || []).push(en); });
  Object.values(byMatch).forEach((list) => {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const [a, b] = [list[i], list[j]].sort((x, y) => (key(x.member) < key(y.member) ? -1 : 1));
      const pk = key(a.member) + "|" + key(b.member);
      const p = pairs[pk] || (pairs[pk] = { a: a.member.name, b: b.member.name, n: 0, w: 0 });
      p.n++; if (a.M.result === "w") p.w++;
    }
  });
  const duo = Object.values(pairs).filter((p) => p.n >= 3).sort((x, y) => y.w / y.n - x.w / x.n || y.n - x.n)[0] || null;

  // Trophées : chacun avec un seuil, sinon un 100 % sur une partie gagne tout.
  const eligible = members.filter((m) => m.n >= 3);
  const top = (list, f) => list.filter((m) => f(m) != null).sort((a, b) => f(b) - f(a))[0] || null;
  const bestGame = members.map((m) => m.best && { m, g: m.best }).filter(Boolean)
    .sort((a, b) => (b.g.ps != null ? b.g.ps : 0) - (a.g.ps != null ? a.g.ps : 0) || b.g.score / b.g.rounds - a.g.score / a.g.rounds)[0] || null;
  const metricPS = eligible.length && eligible.every((m) => m.psN >= 2);
  const awards = {
    mvp: top(eligible, (m) => (metricPS ? m.ps : m.acs)), mvpMetric: metricPS ? "ps" : "acs",
    climber: (() => { const t = top(members, (m) => m.rr); return t && t.rr > 0 ? t : null; })(),
    rough: (() => { const t = members.filter((m) => m.rr != null).sort((a, b) => a.rr - b.rr)[0]; return t && t.rr < 0 ? t : null; })(),
    grinder: top(members, (m) => m.n),
    streak: (() => { const t = top(members, (m) => m.streak); return t && t.streak >= 3 ? t : null; })(),
    hs: top(members.filter((m) => m.shots >= 150), (m) => m.hs),
    bestGame, duo,
  };
  const rankUps = members.reduce((a, m) => a + m.events.filter((e) => e.up).length, 0);
  const rankDowns = members.reduce((a, m) => a + m.events.filter((e) => !e.up).length, 0);
  return {
    key: w.key, kind: "week", window: w,
    games: games.length, together: togetherIds.size,
    wins: games.filter((g) => g.result === "w").length, losses: games.filter((g) => g.result === "l").length,
    playMs: games.reduce((a, g) => a + g.durMs, 0),
    rrNet: members.filter((m) => m.rr != null).reduce((a, m) => a + m.rr, 0),
    rankUps, rankDowns, members,
    maps: Object.values(maps).sort((a, b) => b.n - a.n || b.w - a.w),
    awards,
  };
}

/* La semaine à poster, ou null : terminée, jamais postée, et quelqu'un a joué. */
export function pickWeek(perMember, { now, tz = "Europe/Paris", posted = [], monday = null, force = false } = {}) {
  const w = weekWindow({ now, tz, monday });
  if (!force && now < w.end) return null;
  if (!force && (posted || []).includes(w.key)) return null;
  return buildWeek(perMember, w);
}
