// Dashboard du roster : les calculs purs (périodes, courbes RR, sessions de la
// squad, tableau, duos, records, forme, activité). Aucun DOM, aucun réseau.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ctx = vm.createContext({ console, URL, URLSearchParams });
vm.runInContext(readFileSync(join(root, "app.js"), "utf8") + `
  globalThis.__d = { dashColors, dashRange, dashActs, dashCurves, squadSessions, dashTable, dashPairs,
    dashRecords, dashForm, dashActivity, dashKpis, dashDayKey, DASH_PALETTE };`, ctx);
const X = ctx.__d;

const MIN = 60000, H = 3600000, DAY = 86400000;
const NOW = new Date("2026-10-08T20:00:00").getTime();
let seq = 0;
// Partie classée normalisée minimale (même forme que SQUAD_HIST).
function M(o = {}) {
  const rounds = o.rounds || 24;
  return { id: o.id || "m" + (++seq), startedMs: o.t, durMs: 35 * MIN, rounds, mode: o.mode || "Competitive",
    map: o.map || "Ascent", result: o.result || "w", myTeamId: o.team || "Blue",
    myScore: 13, oppScore: 9, season: o.season || null,
    rr: o.rr != null ? { change: o.rr } : null,
    me: Object.assign({ k: 18, d: 15, a: 4, hs: 22, acs: 220, adr: 150, kd: 1.2, rounds, shots: 100,
      score100: o.idx != null ? o.idx : 60 }, o.me || {}) };
}
const member = (key, matches) => ({ key, name: key, matches });

test("couleurs : par place dans le roster, jamais de 9e teinte inventée", () => {
  const roster = Array.from({ length: 9 }, (_, i) => ({ name: "p" + i, tag: "0" }));
  const c = X.dashColors(roster);
  assert.equal(c["p0#0"], X.DASH_PALETTE[0]);
  assert.equal(c["p7#0"], X.DASH_PALETTE[7]);
  assert.equal(c["p8#0"], null, "le 9e membre n'a pas de couleur : il n'est pas tracé, il reste dans les tableaux");
});

test("période : fenêtre glissante et période précédente de même longueur", () => {
  const r = X.dashRange("7", NOW, null);
  assert.equal(r.kind, "time");
  assert.ok(r.has({ startedMs: NOW - 2 * DAY }));
  assert.ok(!r.has({ startedMs: NOW - 8 * DAY }));
  assert.ok(r.hasPrev({ startedMs: NOW - 8 * DAY }), "jours 8 à 14 : la semaine d'avant");
  assert.ok(!r.hasPrev({ startedMs: NOW - 15 * DAY }));
  assert.ok(r.has({ ts: NOW - DAY }), "s'applique aussi aux points RR (ts)");
});

test("période : l'acte se lit sur la saison, et sans acte connu on dit « tout »", () => {
  const acts = X.dashActs({ a: [{ ts: 1, season: "e9a1" }, { ts: 5, season: "e9a2" }], b: [{ ts: 3, season: "e9a1" }] });
  assert.equal(acts.act, "e9a2");
  assert.equal(acts.prev, "e9a1");
  const r = X.dashRange("act", NOW, acts);
  assert.ok(r.has({ season: "e9a2" }) && !r.has({ season: "e9a1" }));
  assert.ok(r.hasPrev({ season: "e9a1" }));
  const none = X.dashRange("act", NOW, { act: null, prev: null });
  assert.equal(none.kind, "all", "pas d'acte : on ne fait pas semblant");
  assert.equal(none.hasPrev, null);
});

test("courbes : elo absolu, départ au niveau d'avant la période, vue par jour", () => {
  const r = X.dashRange("7", NOW, null);
  const d1 = NOW - 3 * DAY, d2 = NOW - 2 * DAY;
  const rr = { a: [
    { ts: NOW - 20 * DAY, elo: 1200, change: 10 },               // avant la période
    { ts: d1, elo: 1215, change: 15 }, { ts: d1 + H, elo: 1198, change: -17 },
    { ts: d2, elo: 1220, change: 22 },
    { ts: d2 + H, elo: null, change: 5 },                          // pas d'elo : ignoré
  ] };
  const g = X.dashCurves(rr, r, "game").a;
  assert.equal(g.length, 4, "un point de départ + 3 parties");
  assert.equal(g[0].start, true);
  assert.equal(g[0].elo, 1200, "la courbe part du niveau qu'il avait au début de la période");
  assert.equal(g[0].t, r.from);
  const d = X.dashCurves(rr, r, "day").a;
  assert.equal(d.length, 3, "départ + 2 jours");
  assert.equal(d[1].elo, 1198, "le niveau de FIN de journée");
  assert.equal(d[1].change, -2, "le RR net de la journée (+15 −17)");
});

test("sessions de la squad : qui jouait ensemble, et le RR net de chacun", () => {
  const t = NOW - DAY;
  const a = [M({ id: "x1", t, rr: 20 }), M({ id: "x2", t: t + 40 * MIN, rr: -15, result: "l" }), M({ id: "x3", t: t + 80 * MIN, rr: 18 })];
  const b = [M({ id: "x1", t, rr: 22 }), M({ id: "x2", t: t + 40 * MIN, rr: -14, result: "l" }), M({ id: "x3", t: t + 80 * MIN, rr: 19 })];
  // c est dans le MÊME lobby que a et b sur x3, mais en face : pas « ensemble ».
  const c = [M({ id: "x3", t: t + 80 * MIN, team: "Red", rr: -20, result: "l" }),
             M({ id: "y1", t: t + 10 * H, rr: 15 })];                   // plus tard : autre session
  const S = X.squadSessions([member("a", a), member("b", b), member("c", c)], X.dashRange("7", NOW, null));
  assert.equal(S.length, 2);
  const s = S[1];                                                       // la plus ancienne en dernier
  assert.equal(s.games, 3);
  const net = Object.fromEntries(s.members.map(m => [m.key, m.rr]));
  assert.equal(net.a, 23); assert.equal(net.b, 27); assert.equal(net.c, -20);
  assert.equal(s.groups.length, 1, "un seul groupe : a et b");
  assert.equal(s.groups[0].keys.join("+"), "a+b");
  assert.equal(s.groups[0].n, 3);
  assert.equal(S[0].members.length, 1, "c seul, dix heures plus tard");
});

test("tableau : écart à la période précédente, seulement si elle a assez de parties", () => {
  const cur = [0, 1, 2].map(i => M({ t: NOW - (i + 1) * DAY, me: { hs: 30 } }));
  const prev = [0, 1, 2].map(i => M({ t: NOW - (i + 8) * DAY, me: { hs: 20 } }));
  // b n'a que DEUX parties la semaine d'avant : sous le seuil, un écart ne veut rien dire.
  const T = X.dashTable([member("a", cur.concat(prev)), member("b", cur.concat(prev.slice(0, 2))), member("c", cur.slice())],
    X.dashRange("7", NOW, null));
  assert.equal(Math.round(T[0].hs), 30);
  assert.equal(Math.round(T[0].delta.hs), 10, "+10 points de HS sur la semaine d'avant");
  assert.equal(T[1].delta.hs, null, "deux parties avant : pas d'écart, même si on pourrait le calculer");
  assert.equal(T[2].delta.hs, null, "pas de semaine d'avant : pas d'écart inventé");
});

test("duos : RR moyen par partie ensemble contre séparés", () => {
  const t = NOW - 2 * DAY, ms = [];
  const a = [], b = [];
  for (let i = 0; i < 4; i++) {          // 4 parties ensemble, +20 chacun
    a.push(M({ id: "t" + i, t: t + i * H, rr: 20 }));
    b.push(M({ id: "t" + i, t: t + i * H, rr: 20 }));
  }
  a.push(M({ id: "sa", t: t + 10 * H, rr: -10, result: "l" }));   // séparés : −10
  b.push(M({ id: "sb", t: t + 11 * H, rr: -10, result: "l" }));
  // Face à face sur une partie : ne compte pas comme « ensemble ».
  a.push(M({ id: "vs", t: t + 12 * H, rr: 15 }));
  b.push(M({ id: "vs", t: t + 12 * H, team: "Red", rr: -15, result: "l" }));
  const P = X.dashPairs([member("a", a), member("b", b)], X.dashRange("7", NOW, null));
  assert.equal(P.length, 1);
  assert.equal(P[0].n, 4, "le face-à-face n'est pas une partie ensemble");
  assert.equal(P[0].rrTogether, 20);
  assert.equal(P[0].rrApart, (-10 - 10 + 15 - 15) / 4);
  assert.equal(P[0].gain, 20 - (-5));
  // Sous le seuil de parties ensemble : pas de duo.
  const Q = X.dashPairs([member("a", a.slice(0, 2)), member("b", b.slice(0, 2))], X.dashRange("7", NOW, null));
  assert.equal(Q.length, 0);
});

test("records : seuils respectés, et pas de « record » négatif", () => {
  const t = NOW - DAY;
  const a = [M({ t, rr: 20, me: { hs: 100, shots: 2 } }), M({ t: t + H, rr: 15, me: { hs: 45, shots: 80, acs: 390 } }),
             M({ t: t + 2 * H, rr: 10 })];
  const b = [M({ t: t + 3 * DAY / 4, rr: 5, result: "l", me: { acs: 150 } })];
  const per = [member("a", a), member("b", b)];
  const r = X.dashRange("7", NOW, null);
  const R = X.dashRecords(per, X.squadSessions(per, r), r);
  assert.equal(R.hs.value, 45, "le 100 % sur deux balles ne compte pas");
  assert.equal(R.acs.value, 390);
  assert.equal(R.bestSession.key, "a");
  assert.equal(R.bestSession.value, 45);
  assert.equal(R.worstSession, undefined, "personne n'a perdu de RR : pas de « pire session »");
  assert.equal(R.streak.value, 3);
  assert.equal(R.marathon.key, "a");
  assert.equal(R.marathon.value, 3);
});

test("forme : 10 dernières contre l'acte, et « pas assez » plutôt qu'un verdict", () => {
  const act = "e9a2";
  const old = Array.from({ length: 10 }, (_, i) => M({ t: NOW - (30 + i) * DAY, idx: 50, season: act }));
  const hot = Array.from({ length: 10 }, (_, i) => M({ t: NOW - (i + 1) * DAY, idx: 70, season: act }));
  const F = X.dashForm([member("a", old.concat(hot)), member("b", hot.slice(0, 3))], act);
  const a = F.find(f => f.key === "a"), b = F.find(f => f.key === "b");
  assert.equal(a.state, "up");
  assert.equal(Math.round(a.delta), 10, "70 sur les 10 dernières contre 60 sur l'acte");
  assert.equal(b.state, "na", "trois parties : on ne juge pas une forme");
});

test("activité : une case par jour et par membre, bornée", () => {
  const per = [member("a", [M({ t: NOW - DAY, rr: 10 }), M({ t: NOW - DAY + H, rr: -5 }), M({ t: NOW - 90 * DAY })])];
  const A = X.dashActivity(per, X.dashRange("all", NOW, null), NOW);
  assert.ok(A.days.length <= 42, "pas plus de six semaines de cases");
  const c = A.cells["a|" + X.dashDayKey(NOW - DAY)];
  assert.equal(c.n, 2);
  assert.equal(c.rr, 5);
  assert.equal(A.max, 2);
});

test("bandeau : bilan du roster, et pas de « meilleur » si personne n'a gagné de RR", () => {
  const K = X.dashKpis([{ n: 4, wins: 3, rrNet: 30 }, { n: 2, wins: 0, rrNet: -20 }, { n: 0, wins: 0, rrNet: null }]);
  assert.equal(K.games, 6); assert.equal(K.players, 2);
  assert.equal(K.winrate, 50); assert.equal(K.rrNet, 10); assert.equal(K.best.rrNet, 30);
  assert.equal(X.dashKpis([{ n: 2, wins: 0, rrNet: -5 }]).best, null);
});

test("seules les parties CLASSÉES comptent", () => {
  const per = [member("a", [M({ t: NOW - DAY, rr: 10 }), M({ t: NOW - DAY + H, mode: "Deathmatch", me: { hs: 90 } })])];
  const T = X.dashTable(per, X.dashRange("7", NOW, null));
  assert.equal(T[0].n, 1, "le deathmatch ne compte pas");
  assert.equal(Math.round(T[0].hs), 22);
});
