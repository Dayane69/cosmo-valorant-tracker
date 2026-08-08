// Tests de l'indice COSMO v2 : calibrage, assists, HS% atténué, parties
// écourtées (forfait), et cohérence du détail affiché dans la modale.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// app.js sans DOM : on n'utilise que les fonctions de calcul.
function loadIndex() {
  const ctx = vm.createContext({ console });
  let code = readFileSync(join(root, "app.js"), "utf8");
  code += "\nglobalThis.__x = { perfDetail, perfParts, perfScore, applyScores, rawLine, tierOf, IDX_W, IDX_W_KAST, kastByPuuid, normMatch };";
  vm.runInContext(code, ctx);
  return ctx.__x;
}
const X = loadIndex();

// Ligne de stats : rounds complets par défaut.
const line = (o) => Object.assign(
  { k: 15, d: 15, a: 5, hs: 20, acs: 200, adr: 140, dd: 0, rounds: 24, shots: 100 }, o);

test("un joueur parfaitement moyen obtient ~50 (et non ~35 comme en v1)", () => {
  const d = X.perfDetail(line({}), { rounds: 24 });
  assert.ok(d.score >= 45 && d.score <= 55, `moyenne attendue ~50, obtenu ${d.score}`);
});

test("les poids des critères totalisent 100%", () => {
  const total = Object.values(X.IDX_W).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `somme des poids = ${total}`);
  const parts = X.perfParts(line({}));
  assert.equal(parts.length, 6);
  assert.ok(Math.abs(parts.reduce((s, p) => s + p.w, 0) - 1) < 1e-9);
});

test("les assists comptent (la v1 ne regardait que le K/D)", () => {
  const sans = X.perfDetail(line({ k: 10, d: 10, a: 0 }), { rounds: 24 }).score;
  const avec = X.perfDetail(line({ k: 10, d: 10, a: 10 }), { rounds: 24 }).score;
  assert.ok(avec > sans, `10 assists doivent améliorer la note (${sans} -> ${avec})`);
});

test("un HS% faible avec peu de tirs ne plombe pas la note (agents utilitaires)", () => {
  const peu = X.perfDetail(line({ hs: 8, shots: 10 }), { rounds: 24 }).score;
  const beaucoup = X.perfDetail(line({ hs: 8, shots: 200 }), { rounds: 24 }).score;
  assert.ok(peu > beaucoup, `peu de tirs => HS% atténué (${peu} vs ${beaucoup})`);
});

test("partie écourtée (forfait) : la note est rapprochée de la moyenne", () => {
  const bonneStat = { k: 20, d: 5, a: 5, acs: 300, adr: 200, dd: 60, hs: 30 };
  const longue = X.perfDetail(line(Object.assign({ rounds: 24 }, bonneStat)), { rounds: 24 }).score;
  const courte = X.perfDetail(line(Object.assign({ rounds: 7 }, bonneStat)), { rounds: 7, forfeit: true }).score;
  assert.ok(courte < longue, "une perf énorme sur 7 rounds ne doit pas valoir autant que sur 24");
  assert.ok(courte > 50, "…mais elle reste au-dessus de la moyenne");

  const mauvaise = { k: 2, d: 12, a: 1, acs: 80, adr: 50, dd: -60, hs: 8 };
  const malLong = X.perfDetail(line(Object.assign({ rounds: 24 }, mauvaise)), { rounds: 24 }).score;
  const malCourt = X.perfDetail(line(Object.assign({ rounds: 7 }, mauvaise)), { rounds: 7, forfeit: true }).score;
  assert.ok(malCourt > malLong, "une mauvaise perf sur 7 rounds est moins punie que sur 24");
  assert.ok(d => true);
  assert.equal(X.perfDetail(line({ rounds: 7 }), { rounds: 7, forfeit: true }).forfeit, true);
});

test("cas réel : la game gagnée par forfait 6:1 n'est plus notée comme une catastrophe", () => {
  // Sunset (capture tracker.gg) : 4/3/5, ACS 164, DDΔ +5, HS 8%, victoire 6-1.
  const o = line({ k: 4, d: 3, a: 5, acs: 164, adr: 118, dd: 5, hs: 8, rounds: 7, shots: 28 });
  const d = X.perfDetail(o, { rounds: 7, forfeit: true, win: true, rel: (10 - 7) / 9 * 100, rank: 7, lobbyN: 10 });
  assert.ok(d.score >= 45, `la v1 donnait 29 ; attendu >= 45, obtenu ${d.score}`);
});

test("victoire/défaite et classement dans le lobby apparaissent dans le détail", () => {
  const d = X.perfDetail(line({}), { rounds: 24, win: true, rel: 100, rank: 1, lobbyN: 10 });
  const labels = d.adj.map(a => a.label).join(" | ");
  assert.match(labels, /lobby/i);
  assert.match(labels, /Victoire/);
  // le total = sous-total + somme des ajustements (arrondi près)
  const somme = d.base + d.adj.reduce((s, a) => s + a.delta, 0);
  assert.ok(Math.abs(somme - d.score) < 1, `cohérence total : ${somme} vs ${d.score}`);
});

test("chaque critère du détail est exploitable pour l'affichage", () => {
  const d = X.perfDetail(line({}), { rounds: 24 });
  d.parts.forEach(p => {
    assert.ok(p.label && p.hint, "libellé + explication présents");
    assert.ok(p.n >= 0 && p.n <= 100, `note ${p.key} bornée 0-100`);
    assert.equal(typeof p.fmt(p.raw), "string", "valeur brute formatable");
  });
});

test("applyScores classe les joueurs du lobby et note tout le monde", () => {
  const mk = (score, kills) => ({ stats: { kills, deaths: 10, assists: 3, score,
    headshots: 20, bodyshots: 60, legshots: 5, damage: { dealt: 3000, received: 3000 } }, team_id: "Blue" });
  const players = [mk(6000, 25), mk(5000, 20), mk(4000, 15), mk(3000, 10), mk(2000, 5), mk(1000, 2)];
  const lines = X.applyScores(players.map(p => X.rawLine(p, 24)), { rounds: 24, winByTeam: { Blue: true } });
  assert.equal(lines.length, 6);
  lines.forEach(l => assert.ok(l.detail && typeof l.score100 === "number"));
  assert.ok(lines[0].score100 > lines[5].score100, "le meilleur ACS est mieux noté");
  assert.match(lines[0].detail.adj.map(a => a.label).join(" "), /1er\/6/);
});

/* ===================== KAST ===================== */

// Construit un match minimal : 2 joueurs, kills fournis round par round.
function matchWith(kills, rounds = 2) {
  return {
    players: [{ puuid: "A", team_id: "Blue" }, { puuid: "B", team_id: "Red" }],
    rounds: Array.from({ length: rounds }, () => ({})),
    kills,
  };
}

test("KAST : un kill, un assist ou une survie valident le round", () => {
  // Round 0 : A tue B (A a un kill, B meurt sans être tradé) · Round 1 : aucun kill
  const k = X.kastByPuuid(matchWith([
    { round: 0, time_in_round_in_ms: 5000, killer: { puuid: "A", team: "Blue" }, victim: { puuid: "B", team: "Red" }, assistants: [] },
  ]), 2);
  assert.equal(k.A, 100, "A : kill au round 0 + survie au round 1");
  assert.equal(k.B, 50, "B : mort non tradée au round 0, survie au round 1");
});

test("KAST : un assist valide le round pour l'assistant", () => {
  const m = {
    players: [{ puuid: "A" }, { puuid: "B" }, { puuid: "C" }],
    rounds: [{}],
    kills: [{ round: 0, time_in_round_in_ms: 5000, killer: { puuid: "A", team: "Blue" },
      victim: { puuid: "B", team: "Red" }, assistants: [{ puuid: "C" }] }],
  };
  const k = X.kastByPuuid(m, 1);
  assert.equal(k.C, 100, "C a un assist -> round validé");
  assert.equal(k.B, 0, "B est mort sans trade");
});

test("KAST : une mort tradée dans les 3 s valide quand même le round", () => {
  const base = (dt) => ({
    players: [{ puuid: "A" }, { puuid: "B" }, { puuid: "T" }],
    rounds: [{}],
    kills: [
      // L'ennemi B tue A
      { round: 0, time_in_round_in_ms: 5000, killer: { puuid: "B", team: "Red" }, victim: { puuid: "A", team: "Blue" }, assistants: [] },
      // Le coéquipier T venge A après dt ms
      { round: 0, time_in_round_in_ms: 5000 + dt, killer: { puuid: "T", team: "Blue" }, victim: { puuid: "B", team: "Red" }, assistants: [] },
    ],
  });
  assert.equal(X.kastByPuuid(base(2000), 1).A, 100, "trade en 2 s -> validé");
  assert.equal(X.kastByPuuid(base(5000), 1).A, 0, "trade en 5 s -> trop tard");
});

test("KAST : le critère remplace la survie et garde des poids à 100%", () => {
  const totalKast = Object.values(X.IDX_W_KAST).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(totalKast - 1) < 1e-9, `somme des poids avec KAST = ${totalKast}`);

  const avecKast = X.perfParts(line({ kast: 72 })).map(p => p.key);
  assert.ok(avecKast.includes("kast"), "le critère KAST est présent");
  assert.ok(!avecKast.includes("surv"), "la survie est remplacée (pas de double comptage)");

  const sansKast = X.perfParts(line({})).map(p => p.key);
  assert.ok(sansKast.includes("surv") && !sansKast.includes("kast"), "repli sur la survie sans KAST");
});

test("KAST : un bon KAST améliore la note, un mauvais la baisse", () => {
  const bas = X.perfDetail(line({ kast: 50 }), { rounds: 24 }).score;
  const moyen = X.perfDetail(line({ kast: 70 }), { rounds: 24 }).score;
  const haut = X.perfDetail(line({ kast: 88 }), { rounds: 24 }).score;
  assert.ok(bas < moyen && moyen < haut, `progression attendue (${bas} < ${moyen} < ${haut})`);
  assert.ok(Math.abs(moyen - 50) <= 5, `70% de KAST ≈ note moyenne (obtenu ${moyen})`);
});

test("KAST : normMatch le calcule pour tous les joueurs d'une vraie partie", () => {
  const mkP = (puuid, team) => ({ puuid, name: puuid, tag: "0", team_id: team,
    stats: { kills: 10, deaths: 10, assists: 4, score: 4800, headshots: 20, bodyshots: 50, legshots: 5,
      damage: { dealt: 3400, received: 3300 } } });
  const m = {
    metadata: { match_id: "x", started_at: "2026-08-08T10:00:00Z", map: { name: "Ascent" }, queue: { name: "Competitive" } },
    players: [mkP("A", "Blue"), mkP("B", "Red")],
    teams: [{ team_id: "Blue", won: true, rounds: { won: 13, lost: 5 } },
            { team_id: "Red", won: false, rounds: { won: 5, lost: 13 } }],
    rounds: Array.from({ length: 18 }, () => ({})),
    kills: [{ round: 0, time_in_round_in_ms: 4000, killer: { puuid: "A", team: "Blue" }, victim: { puuid: "B", team: "Red" }, assistants: [] }],
  };
  const M = X.normMatch(m, { puuid: "A", name: "A", tag: "0" });
  assert.equal(M.me.kast, 100, "A : kill au round 0 + survie sur les 17 autres");
  assert.ok(M.me.detail.parts.some(p => p.key === "kast"), "le détail affiche le KAST");
});
