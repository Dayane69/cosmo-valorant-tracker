// Récap Discord d'une session de la squad — la logique, sans réseau ni rendu.
//
// Entrée : l'historique stocké de chaque membre (blobs cosmo-history, cosmo-rr,
// cosmo-perf), le même que lisent le dashboard et les alertes. Sortie : la
// session à poster (terminée, jouée à plusieurs, jamais postée) et son bilan.
// Tout est injecté et pur : testable sans Netlify ni Discord.

const MIN = 60000, HOUR = 3600000;
export const RECAP = {
  GAP_MS: 120 * MIN,        // même écart de coupure que les sessions du site
  MAX_AGE_MS: 24 * HOUR,    // on ne poste pas une session de la semaine dernière
  MIN_MEMBERS: 2,           // une session « squad » : au moins deux membres ENSEMBLE
};

const num = (v, f = 0) => (v === undefined || v === null || Number.isNaN(Number(v)) ? f : Number(v));
const isRanked = (mode) => /competitive|class[ée]|comp[ée]titif/i.test(String(mode || ""));
const key = (m) => `${String(m.name).toLowerCase()}#${String(m.tag).toLowerCase()}`;

/* RR « hors partie » : bonus de montée de palier, ou protection de rang (une
   défaite arrêtée à 0). Même règle que le site (app.js, rrBonus) : l'écart
   d'elo avec la partie précédente, moins le ±RR annoncé, retenu seulement si
   le palier a changé ou si la défaite s'est arrêtée à 0. Cas réel : Gogemine,
   Platine 2 · 87 -> Platine 3 · 13, soit +26, quand ses parties annonçaient
   +13, −14, +13 = +12. */
export function rrBonuses(rr) {
  const tid = (x) => (x && x.tier && x.tier.id != null && !Number.isNaN(Number(x.tier.id)) ? Number(x.tier.id) : null);
  const out = {};
  let prev = null;
  (rr || []).filter((e) => e && num(e.ts) > 0).slice().sort((a, b) => num(a.ts) - num(b.ts)).forEach((e) => {
    if (e.id && prev && e.elo != null && e.change != null && prev.elo != null) {
      const diff = (num(e.elo) - num(prev.elo)) - num(e.change);
      const moved = tid(prev) != null && tid(e) != null && tid(prev) !== tid(e);
      const shield = num(e.change) < 0 && diff > 0 && e.rr != null && num(e.rr) === 0;
      if (diff && Math.abs(diff) <= 40 && (moved || shield)) out[e.id] = diff;
    }
    if (e.elo != null) prev = e;
  });
  return out;
}

/* Partie compacte (stored-matches v1) -> ce dont le récap a besoin. */
export function normCompact(e) {
  const meta = (e && e.meta) || {}, st = (e && e.stats) || {}, tms = (e && e.teams) || {};
  const id = meta.id || meta.match_id || null;
  const t = Date.parse(meta.started_at || meta.game_start_iso || "") || 0;
  if (!id || !t) return null;
  const team = String(st.team || "").toLowerCase();
  const my = num(tms[team]), opp = num(tms[team === "red" ? "blue" : "red"]);
  const rounds = my + opp || 24;
  const shots = st.shots || {}, dmg = st.damage || {}, ch = st.character || {};
  return {
    id, t, mode: meta.mode || "", map: (meta.map && meta.map.name) || meta.map || "",
    season: (meta.season && meta.season.short) || null,
    team, myScore: my, oppScore: opp, rounds,
    result: my > opp ? "w" : (my < opp ? "l" : "d"),
    k: num(st.kills), d: num(st.deaths), a: num(st.assists), score: num(st.score),
    dmg: num(dmg.made), head: num(shots.head), body: num(shots.body), leg: num(shots.leg),
    agentId: ch.id || "", agent: ch.name || "",
    durMs: rounds * 100 * 1000,   // ~100 s par round : l'historique compact n'a pas la durée
  };
}

/* Sessions de la squad.
   1. Le CŒUR : les parties classées JOUÉES ENSEMBLE (au moins deux membres dans
      la même équipe), coupées à l'écart GAP_MS. C'est lui qui dit quand la
      squad a joué : en enchaînant les parties solo de chacun, la chaîne ne se
      coupait jamais (l'un à 11 h, l'autre à 12 h 30, un troisième à 14 h…) et
      la « session » du samedi 17 octobre durait 14 heures.
   2. Puis TOUT ce qu'ont joué les présents autour (withSolo, par défaut) :
      chaque membre qui a joué pendant le cœur (avec la squad ou en même temps
      qu'elle) compte toutes ses parties classées jouées jusqu'à GAP_MS avant
      ou après. Lundi 19 octobre : SevenDayy avait 2 parties avec Gogemine et 3
      en solo autour ; le récap n'en montrait que 2.
      La marge ne s'enchaîne pas : une partie à 4 h de la squad n'y entre pas.
   La clé (s.key) reste celle du cœur : un récap déjà posté ne repart pas.
   perMember = [{ member, matches (compactes), rr, perf }]. */
export function squadSessions(perMember, gapMs = RECAP.GAP_MS, { togetherOnly = true, withSolo = true } = {}) {
  const entries = [];
  (perMember || []).forEach(({ member, matches, rr, perf }) => {
    const rrBy = {}; (rr || []).forEach((e) => { if (e && e.id) rrBy[e.id] = e; });
    const bonusBy = rrBonuses(rr);
    const pfBy = {}; (perf || []).forEach((e) => { if (e && e.id) pfBy[e.id] = e; });
    (matches || []).forEach((raw) => {
      const M = normCompact(raw);
      if (!M || !isRanked(M.mode)) return;
      const r = rrBy[M.id], p = pfBy[M.id];
      // RR réellement gagné : ±RR de la partie + bonus éventuel (montée, protection).
      M.rrBonus = r && r.change != null ? num(bonusBy[M.id]) : 0;
      M.rr = r && r.change != null ? num(r.change) + M.rrBonus : null;
      M.tierAfter = r && r.tier ? r.tier.name : null;
      M.ps = p && p.ps != null ? num(p.ps) : null;
      M.grade = p ? p.g || null : null;
      M.mvp = !!(p && p.mvp);
      entries.push({ member, M });
    });
  });
  const all = entries.slice().sort((a, b) => a.M.t - b.M.t);
  let core = all;
  if (togetherOnly) {
    const by = {};
    all.forEach((en) => { const k = en.M.id + "|" + en.M.team; (by[k] = by[k] || new Set()).add(key(en.member)); });
    all.forEach((en) => { en.M.together = by[en.M.id + "|" + en.M.team].size >= 2; });
    core = all.filter((en) => en.M.together);
  }
  const out = []; let cur = null;
  core.forEach((en) => {
    if (!cur || en.M.t - cur.end > gapMs) { cur = { start: en.M.t, end: 0, entries: [] }; out.push(cur); }
    cur.entries.push(en);
    cur.end = Math.max(cur.end, en.M.t + en.M.durMs);
  });
  out.forEach((s) => { s.key = "s" + s.start; s.coreStart = s.start; s.coreEnd = s.end; });

  if (togetherOnly && withSolo) {
    const taken = new Set(core);
    out.forEach((s) => {
      // Présents : ceux qui ont joué pendant le cœur, ensemble ou à côté.
      const present = new Set(s.entries.map((e) => key(e.member)));
      all.forEach((en) => { if (en.M.t >= s.coreStart && en.M.t <= s.coreEnd) present.add(key(en.member)); });
      all.forEach((en) => {
        if (taken.has(en) || !present.has(key(en.member))) return;
        if (en.M.t < s.coreStart - gapMs || en.M.t > s.coreEnd + gapMs) return;
        taken.add(en); s.entries.push(en);
      });
      s.entries.sort((a, b) => a.M.t - b.M.t);
      s.start = s.entries[0].M.t;
      s.end = Math.max(...s.entries.map((e) => e.M.t + e.M.durMs));
    });
  }
  return out;
}

/* Deux membres sont « ensemble » sur une partie : même id ET même équipe. */
export function playedTogether(s) {
  const by = {};
  s.entries.forEach(({ member, M }) => { const k = M.id + "|" + M.team; (by[k] = by[k] || new Set()).add(key(member)); });
  return Object.values(by).some((set) => set.size >= 2);
}

/* La session à poster : terminée (plus rien depuis GAP_MS), récente, jouée
   par au moins MIN_MEMBERS membres dont deux ensemble, jamais postée. La plus
   récente qui remplit tout. */
export function pickSession(sessions, { now, posted = [], gapMs = RECAP.GAP_MS, maxAgeMs = RECAP.MAX_AGE_MS, minMembers = RECAP.MIN_MEMBERS, force = false } = {}) {
  const done = new Set(posted || []);
  const ok = (sessions || []).filter((s) => {
    if (!force && done.has(s.key)) return false;
    if (now - s.end < gapMs) return false;                 // la session n'est peut-être pas finie
    if (!force && now - s.end > maxAgeMs) return false;
    const members = new Set(s.entries.map((e) => key(e.member)));
    return members.size >= minMembers && playedTogether(s);
  });
  return ok.length ? ok[ok.length - 1] : null;
}

const mostCommon = (arr) => {
  const c = {}; let best = null;
  arr.forEach((x) => { if (!x) return; c[x] = (c[x] || 0) + 1; if (!best || c[x] > c[best]) best = x; });
  return best;
};

/* Le bilan de la session, prêt à dessiner. */
export function buildRecap(s) {
  const per = {};
  s.entries.forEach(({ member, M }) => {
    const k = key(member);
    const r = per[k] || (per[k] = { name: member.name, tag: member.tag, color: member.color || "#8696a6", games: [] });
    r.games.push(M);
  });
  const members = Object.values(per).map((r) => {
    const G = r.games, n = G.length, rounds = G.reduce((a, g) => a + g.rounds, 0) || 1;
    const k = G.reduce((a, g) => a + g.k, 0), d = G.reduce((a, g) => a + g.d, 0);
    const shots = G.reduce((a, g) => a + g.head + g.body + g.leg, 0), head = G.reduce((a, g) => a + g.head, 0);
    const rrG = G.filter((g) => g.rr != null), psG = G.filter((g) => g.ps != null);
    const agent = mostCommon(G.map((g) => g.agentId));
    return {
      name: r.name, tag: r.tag, color: r.color, n,
      w: G.filter((g) => g.result === "w").length, l: G.filter((g) => g.result === "l").length,
      rr: rrG.length ? rrG.reduce((a, g) => a + g.rr, 0) : null,
      rrBonus: rrG.reduce((a, g) => a + num(g.rrBonus), 0),
      ps: psG.length ? psG.reduce((a, g) => a + g.ps, 0) / psG.length : null,
      acs: G.reduce((a, g) => a + g.score, 0) / rounds,
      kd: d ? k / d : k, k, d,
      hs: shots ? head / shots * 100 : null,
      adr: G.reduce((a, g) => a + g.dmg, 0) / rounds,
      agentId: agent, agent: (G.find((g) => g.agentId === agent) || {}).agent || "",
      mvps: G.filter((g) => g.mvp).length,
      together: G.filter((g) => g.together).length,
      tierAfter: (G.filter((g) => g.tierAfter).slice(-1)[0] || {}).tierAfter || null,
    };
  });
  // Le meilleur de la session : la note Riot si tout le monde en a, sinon l'ACS.
  const allPS = members.every((m) => m.ps != null);
  const metric = (m) => (allPS ? m.ps : m.acs);
  members.sort((a, b) => metric(b) - metric(a));
  // Parties de la session (une fois chacune, même jouée à plusieurs).
  const seen = new Map();
  s.entries.forEach(({ M }) => { if (!seen.has(M.id)) seen.set(M.id, M); });
  const games = [...seen.values()];
  const togetherIds = new Set(s.entries.filter(({ M }) => M.together).map(({ M }) => M.id));
  // La meilleure partie individuelle.
  let best = null;
  s.entries.forEach(({ member, M }) => {
    const v = M.ps != null ? M.ps : M.score / (M.rounds || 1);
    if (!best || v > best.v) best = { v, ps: M.ps != null, name: member.name, map: M.map, k: M.k, d: M.d, a: M.a, agent: M.agent };
  });
  const rrRank = members.filter((m) => m.rr != null).slice().sort((a, b) => b.rr - a.rr);
  return {
    key: s.key, start: s.start, end: s.end,
    games: games.length,
    together: togetherIds.size,
    wins: games.filter((g) => g.result === "w").length,
    losses: games.filter((g) => g.result === "l").length,
    maps: [...new Set(games.map((g) => g.map).filter(Boolean))],
    members, metric: allPS ? "ps" : "acs",
    mvp: members[0] || null,
    best, topRR: rrRank[0] && rrRank[0].rr > 0 ? rrRank[0] : null,
    worstRR: rrRank.length > 1 && rrRank[rrRank.length - 1].rr < 0 ? rrRank[rrRank.length - 1] : null,
  };
}
