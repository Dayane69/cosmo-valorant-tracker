// Performance Score (patch 13.06) et objectifs d'acte.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { extractPerf, mergePerf } from "../netlify/functions/lib/refresh-core.mjs";
import { cleanGoal } from "../netlify/functions/goals.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ctx = vm.createContext({ console, URL, URLSearchParams });
vm.runInContext(readFileSync(join(root, "app.js"), "utf8") + `
  globalThis.__p = { normalizeAny, attachPerf, sessionStats, perfVal, perfAgg, psGradeFr, perfHTML, scoreboardHTML, dashTable, dashRange,
    goalPlan, goalLevers, goalPicks, tierFr, tierNumOf, actWindowOf, setMe: (n,t)=>{ STATE.name=n; STATE.tag=t; } };`, ctx);
const P = ctx.__p;
const DAY = 86400000;

// Joueur v4 avec le bloc « performance » tel que HenrikDev le renvoie (relevé réel).
const perfBlock = (score, grade) => ({ score, breakdown: { damage: 85.3 },
  ratings: { grade, combat: { damage: "double_down", death_impact: "up", kill_impact: "double_down", trades: "double_down" },
    utility: { assists: "double_down", defuses: "double_up", plants: "double_up", utility_usage: "up" } } });
const pl = (puuid, name, team, score, perf) => ({ puuid, name, tag: "0", team_id: team, agent: { name: "Cypher" },
  stats: { kills: 9, deaths: 17, assists: 2, score, headshots: 10, bodyshots: 40, legshots: 5, damage: { dealt: 2048, received: 3000 } },
  ...(perf ? { performance: perf } : {}) });
const v4 = (id, perfMe, perfFoe, mvp) => ({ metadata: { match_id: id, started_at: "2026-10-18T19:16:50Z", map: { name: "Lotus" },
    queue: { name: "Competitive" }, ...(mvp ? { mvp: { puuid: mvp, name: "x", tag: "0" } } : {}) },
  players: [pl("me", "Yakuza", "Blue", 2914, perfMe), pl("foe", "sir3gold", "Red", 8948, perfFoe)],
  teams: [{ team_id: "Blue", won: false, rounds: { won: 11, lost: 13 } }, { team_id: "Red", won: true, rounds: { won: 13, lost: 11 } }] });

/* ---------- Performance Score */

test("cron : la note de chaque partie est extraite de la réponse v4, jetée jusqu'ici", () => {
  const out = extractPerf([v4("m1", perfBlock(119.2, "pass"), perfBlock(464.3, "distinction"), "foe"), v4("m2", null, null)], { name: "Yakuza", tag: "0" });
  assert.equal(out.length, 1, "une partie sans note (d'avant le patch) n'est pas inventée");
  assert.equal(out[0].id, "m1"); assert.equal(out[0].ps, 119.2); assert.equal(out[0].g, "pass");
  assert.equal(out[0].r.defuses, "double_up"); assert.equal(out[0].r.damage, "double_down");
  assert.equal(out[0].mvp, false, "le MVP était l'adversaire");
  assert.equal(extractPerf([v4("m3", perfBlock(300, "merit"), null, "me")], { name: "yakuza", tag: "0" })[0].mvp, true);
});

test("cron : fusion des notes par partie, bornée", () => {
  const a = [{ id: "x", ts: 1, ps: 100 }], b = [{ id: "x", ts: 1, ps: 120 }, { id: "y", ts: 2, ps: 200 }];
  const m = mergePerf(a, b);
  assert.equal(m.length, 2);
  assert.equal(m.find((e) => e.id === "x").ps, 120, "la version fraîche gagne");
  assert.equal(mergePerf([], Array.from({ length: 900 }, (_, i) => ({ id: "g" + i, ts: i, ps: 1 }))).length, 800);
});

test("partie complète : la note, la mention, les axes et le MVP", () => {
  const M = P.normalizeAny(v4("m1", perfBlock(119.4, "pass"), perfBlock(464.3, "distinction"), "foe"), { puuid: "me", name: "Yakuza", tag: "0" });
  assert.equal(M.me.ps, 119); assert.equal(M.me.psGrade, "pass"); assert.equal(M.me.psR.plants, "double_up");
  assert.equal(M.mvp, false);
  assert.equal(M.lines.find((l) => l.name === "sir3gold").mvp, true);
});

test("partie compacte : la note stockée par le cron se rattache, sans écraser une note déjà là", () => {
  const ms = [{ id: "a", me: { ps: null } }, { id: "b", me: { ps: 250 } }, { id: "c", me: {} }];
  P.attachPerf(ms, [{ id: "a", ps: 301.6, g: "merit", r: { damage: "up" }, mvp: true }, { id: "b", ps: 999 }]);
  assert.equal(ms[0].me.ps, 302); assert.equal(ms[0].me.psGrade, "merit"); assert.equal(ms[0].mvp, true);
  assert.equal(ms[1].me.ps, 250, "la note de la partie complète fait foi");
});

test("moyenne de note sur les SEULES parties notées — jamais un mélange note/ACS", () => {
  const g = (ps, acs) => ({ me: { ps, acs, k: 1, d: 1, a: 0, hs: 20, adr: 100, rounds: 20, shots: 10, score100: 50 }, rounds: 20 });
  const st = P.sessionStats([g(300, 200), g(null, 400), g(200, 150)]);
  assert.equal(st.psN, 2); assert.equal(st.ps, 250);
  assert.deepEqual({ ...P.perfAgg(st) }, { v: 250, lab: "Perf.", ps: true, n: 2 });
  assert.equal(P.perfAgg(P.sessionStats([g(null, 222)])).lab, "ACS", "sans note : l'ACS, et c'est écrit");
  assert.equal(P.perfVal({ ps: null, acs: 187 }).lab, "ACS");
  assert.equal(P.psGradeFr("distinction"), "Distinction");
});

test("scoreboard : la colonne devient « Perf. » dès que la partie a des notes", () => {
  P.setMe("Yakuza", "0");
  const withPS = P.scoreboardHTML(P.normalizeAny(v4("m1", perfBlock(119, "pass"), perfBlock(464, "distinction"), "foe"), { puuid: "me", name: "Yakuza", tag: "0" }));
  assert.match(withPS.html, /<th[^>]*>Perf\.<\/th>/);
  assert.match(withPS.html, /<b>464<\/b>/);
  assert.match(withPS.html, /pn-mvp/, "le MVP est signalé");
  const old = P.scoreboardHTML(P.normalizeAny(v4("m0", null, null), { puuid: "me", name: "Yakuza", tag: "0" }));
  assert.match(old.html, /<th>ACS<\/th>/, "partie d'avant le patch : l'ACS, comme avant");
});

test("détail de la note : points forts et axes à travailler, comme l'écran de fin de partie", () => {
  const l = { ps: 119, psGrade: "pass", psR: { damage: "double_down", plants: "double_up", trades: "neutral" } };
  const h = P.perfHTML(l, { mvp: false });
  assert.match(h, /119/); assert.match(h, /Correct/);
  assert.match(h, /Points forts<\/b> : Plants/); assert.match(h, /À travailler<\/b> : Dégâts/);
  assert.equal(P.perfHTML({ ps: null }, {}), "", "pas de note : pas de section");
});

/* ---------- Objectifs d'acte */

test("serveur : un objectif valide, et rien d'autre", () => {
  assert.deepEqual(cleanGoal({ name: "Yakuza", tag: "2826", act: "E11A6", tier: "Platinum 3", note: "x".repeat(200) }),
    { key: "yakuza#2826", act: "e11a6", tier: "Platinum 3", note: "x".repeat(140) });
  assert.equal(cleanGoal({ name: "Yakuza", tag: "2826", act: "Unknown", tier: "Gold 1" }), null, "un acte doit ressembler à e11a6");
  assert.equal(cleanGoal({ name: "Yakuza", tag: "2826", act: "e11a6", tier: "<script>" }), null);
  assert.equal(cleanGoal({ name: "Yakuza", tag: "2826", act: "e11a6", tier: "Radiant" }).tier, "Radiant");
  assert.equal(cleanGoal({ name: "Yakuza", tag: "2826", act: "e11a6", tier: "" }).tier, "", "palier vide = effacer");
});

// Table des paliers (numérotation actuelle) et série RR synthétique.
const BYNUM = {}; ["IRON 1","IRON 2","IRON 3","BRONZE 1","BRONZE 2","BRONZE 3","SILVER 1","SILVER 2","SILVER 3","GOLD 1","GOLD 2","GOLD 3",
  "PLATINUM 1","PLATINUM 2","PLATINUM 3","DIAMOND 1"].forEach((n, i) => { BYNUM[i + 3] = { name: n, icon: "i" + (i + 3) }; });
const START = Date.parse("2026-10-14T00:00:00Z"), END = Date.parse("2027-01-06T00:00:00Z"), NOW = START + 10 * DAY;
function seriesOf(changes, startElo) {
  let elo = startElo; const out = [{ id: "prev", elo: startElo, change: 5, season: "e11a5", ts: START - DAY, tier: { name: "GOLD 2" }, rr: startElo % 100 }];
  changes.forEach((c, i) => { elo += c; out.push({ id: "g" + i, elo, change: c, season: "e11a6", ts: START + (i + 1) * (9 * DAY / changes.length), rr: ((elo % 100) + 100) % 100, tier: { name: BYNUM[Math.floor(elo / 100) + 3].name } }); });
  return out;
}

test("objectif : RR restants, temps, rythme, projection, winrate requis — calculés juste", () => {
  // 20 parties en 10 jours : 12 V à +20, 8 D à −15 → +6 RR/partie, 2 parties/jour.
  const ch = Array.from({ length: 20 }, (_, i) => (i % 5 < 3 ? 20 : -15));
  const s = seriesOf(ch, 1150);                       // 1150 = Or 3 · 50 → fin : 1270 = Platine 1 · 70
  const p = P.goalPlan({ series: s, matches: [], goal: { act: "e11a6", tier: "Platinum 3" }, act: { start: START, end: END }, now: NOW, byNum: BYNUM, offset: 3 });
  assert.equal(p.curElo, 1270);
  assert.equal(p.targetElo, 1400, "Platine 3 = palier 17 → (17 − 3) × 100");
  assert.equal(p.remaining, 130);
  assert.equal(p.startElo, 1150, "niveau AVANT la 1re partie de l'acte");
  assert.equal(Math.round(p.progress * 100), 48, "(1270 − 1150) / (1400 − 1150)");
  assert.equal(p.n, 20); assert.equal(p.wins, 12); assert.equal(p.losses, 8);
  assert.equal(p.netPer, 6); assert.equal(p.avgWin, 20); assert.equal(p.avgLoss, 15);
  assert.equal(Math.round(p.daysLeft), 74);
  assert.equal(p.pace, 2, "20 parties en 10 jours");
  assert.equal(p.gamesNeeded, 22, "130 / 6 arrondi au-dessus");
  assert.equal(p.status, "ontrack");
  // Winrate requis à 2 parties/jour d'ici la fin : (130/148 + 15) / 35.
  const gl = 2 * p.daysLeft;
  assert.ok(Math.abs(p.reqWr - (130 / gl + 15) / 35) < 1e-9);
  assert.equal(p.next.name, "PLATINUM 2", "1300 = début de Platine 2"); assert.equal(p.next.rr, 30); assert.equal(p.next.wins, 2);
  assert.deepEqual([...p.steps.map((x) => x.name)], ["PLATINUM 1", "PLATINUM 2", "PLATINUM 3"]);
  assert.deepEqual([...p.steps.map((x) => x.passed)], [true, false, false]);
});

test("objectif : en retard, atteint, ou trop tôt pour juger", () => {
  const down = seriesOf(Array.from({ length: 10 }, (_, i) => (i % 2 ? -18 : 15)), 1150);   // −1,5 RR/partie
  const b = P.goalPlan({ series: down, matches: [], goal: { act: "e11a6", tier: "Platinum 3" }, act: { start: START, end: END }, now: NOW, byNum: BYNUM, offset: 3 });
  assert.equal(b.status, "behind"); assert.equal(b.gamesNeeded, null, "en recul : pas de « N parties » trompeur");
  const up = P.goalPlan({ series: seriesOf([60, 60, 60, 60, 60], 1150), matches: [], goal: { act: "e11a6", tier: "Gold 3" }, act: { start: START, end: END }, now: NOW, byNum: BYNUM, offset: 3 });
  assert.equal(up.status, "reached"); assert.equal(up.progress, 1);
  const few = P.goalPlan({ series: seriesOf([20, 20], 1150), matches: [], goal: { act: "e11a6", tier: "Platinum 3" }, act: { start: START, end: END }, now: NOW, byNum: BYNUM, offset: 3 });
  assert.equal(few.status, "unknown"); assert.equal(few.projected, null); assert.equal(few.reqWr, null);
  assert.equal(P.goalPlan({ series: [], matches: [], goal: { act: "e11a6", tier: "Gold 3" }, now: NOW, byNum: BYNUM, offset: 3 }), null);
});

test("objectif : leviers comparés de toi à toi, agents et maps qui rapportent", () => {
  const g = (r, d, hs, agent, map, rr) => ({ season: "e11a6", mode: "Competitive", result: r, map, rr: { change: rr },
    me: { k: 15, d, a: 3, hs, adr: 140, rounds: 20, agent, ps: null } });
  const ms = [g("w", 10, 25, "Killjoy", "Lotus", 20), g("w", 11, 24, "Killjoy", "Bind", 21), g("w", 12, 26, "Killjoy", "Lotus", 19),
    g("l", 18, 18, "Sova", "Haven", -16), g("l", 17, 17, "Sova", "Haven", -15), g("l", 19, 19, "Sova", "Haven", -17)];
  const lv = P.goalLevers(ms, "e11a6");
  // K/D 1,36 contre 0,83 (+64 %) puis morts par round 0,55 contre 0,90 (−39 %) : les deux plus gros écarts.
  assert.deepEqual([...lv.map((l) => l.k)], ["kd", "dpr"]);
  assert.ok(lv[1].w < lv[1].l, "moins de morts dans ses victoires");
  const pk = P.goalPicks(ms, "e11a6");
  assert.equal(pk.bestAgent.k, "Killjoy"); assert.equal(pk.worstAgent.k, "Sova"); assert.equal(pk.worstMap.k, "Haven");
  assert.equal(P.goalLevers(ms.slice(0, 4), "e11a6").length, 0, "moins de 3 défaites : pas de comparaison");
});

test("objectif : noms de rang en français, numéro de palier, fenêtre de l'acte", () => {
  assert.equal(P.tierFr("PLATINUM 3"), "Platine 3"); assert.equal(P.tierFr("Gold 1"), "Or 1"); assert.equal(P.tierFr("Radiant"), "Radiant");
  assert.equal(P.tierNumOf("platinum 3", BYNUM), 17);
  const w = P.actWindowOf([{ type: "EAresSeasonType::Act", start: START, end: END, name: "ACT VI" }, { type: "", start: 0, end: 9e15 }], NOW);
  assert.equal(w.end, END);
});
