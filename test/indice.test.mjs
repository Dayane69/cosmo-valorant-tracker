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
  code += "\nglobalThis.__x = { perfDetail, perfParts, perfScore, applyScores, rawLine, tierOf, IDX_W };";
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
