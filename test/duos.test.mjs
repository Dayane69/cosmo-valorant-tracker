// Tests de la détection des duos : deux membres dans la MÊME équipe sur une
// même partie, et surtout l'écart de winrate avec leurs parties séparées.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function load() {
  const ctx = vm.createContext({ console, URL, URLSearchParams });
  let code = readFileSync(join(root, "app.js"), "utf8");
  code += "\nglobalThis.__x = { computeDuos, DUO_MIN_GAMES, normMatch, normalizeAny, squadStale };";
  vm.runInContext(code, ctx);
  return ctx.__x;
}
const X = load();

const M = (id, team, result) => ({ id, myTeamId: team, result, mode: "Competitive", me: { k: 1, d: 1 } });
const sq = (name, matches) => ({ member: { name, tag: "1", color: "#fff" }, norm: matches });

test("un duo n'est retenu qu'au-delà du minimum de parties", () => {
  const deux = [
    sq("A", [M("m1", "Blue", "w"), M("m2", "Blue", "w")]),
    sq("B", [M("m1", "Blue", "w"), M("m2", "Blue", "w")]),
  ];
  assert.equal(X.computeDuos(deux, 3).length, 0, "2 parties ensemble : pas encore un duo");
  assert.equal(X.computeDuos(deux, 2).length, 1);
  assert.ok(X.DUO_MIN_GAMES >= 2);
});

test("deux membres dans des équipes OPPOSÉES ne forment pas un duo", () => {
  const face = [
    sq("A", [M("m1", "Blue", "w"), M("m2", "Blue", "w"), M("m3", "Blue", "w")]),
    sq("B", [M("m1", "Red", "l"), M("m2", "Red", "l"), M("m3", "Red", "l")]),
  ];
  assert.equal(X.computeDuos(face, 2).length, 0, "ils se sont affrontés, ce n'est pas un duo");
});

test("le winrate du duo est celui des parties jouées ensemble", () => {
  const ms = [M("m1", "Blue", "w"), M("m2", "Blue", "w"), M("m3", "Blue", "l"), M("m4", "Blue", "w")];
  const d = X.computeDuos([sq("A", ms), sq("B", ms)], 2)[0];
  assert.equal(d.n, 4);
  assert.equal(d.wins, 3);
  assert.equal(Math.round(d.wr), 75);
});

test("l'écart se mesure contre leurs parties SANS l'autre", () => {
  const ensemble = [M("t1", "Blue", "w"), M("t2", "Blue", "w"), M("t3", "Blue", "w")];
  // Chacun perd tout quand il joue sans l'autre : le duo doit ressortir très positif.
  const a = ensemble.concat([M("a1", "Blue", "l"), M("a2", "Blue", "l")]);
  const b = ensemble.concat([M("b1", "Blue", "l"), M("b2", "Blue", "l")]);
  const d = X.computeDuos([sq("A", a), sq("B", b)], 2)[0];
  assert.equal(Math.round(d.wr), 100);
  assert.equal(Math.round(d.base), 0, "0% de victoires chacun sans l'autre");
  assert.equal(Math.round(d.delta), 100);
});

test("un duo qui ne joue QUE ensemble n'a pas de référence inventée", () => {
  const ms = [M("m1", "Blue", "w"), M("m2", "Blue", "l"), M("m3", "Blue", "w")];
  const d = X.computeDuos([sq("A", ms), sq("B", ms)], 2)[0];
  assert.equal(d.base, null, "aucune partie séparée : pas de comparaison");
  assert.equal(d.delta, null);
});

test("une même partie n'est comptée qu'une fois par paire", () => {
  // Doublon volontaire dans l'historique d'un membre.
  const a = [M("m1", "Blue", "w"), M("m1", "Blue", "w"), M("m2", "Blue", "w"), M("m3", "Blue", "w")];
  const b = [M("m1", "Blue", "w"), M("m2", "Blue", "w"), M("m3", "Blue", "w")];
  const d = X.computeDuos([sq("A", a), sq("B", b)], 2)[0];
  assert.equal(d.n, 3, "3 parties distinctes, malgré le doublon");
});

test("un trio produit les trois paires, triées par nombre de parties", () => {
  const trois = [M("m1", "Blue", "w"), M("m2", "Blue", "w"), M("m3", "Blue", "w")];
  const duos = X.computeDuos([
    sq("A", trois), sq("B", trois),
    sq("C", [M("m1", "Blue", "w"), M("m2", "Blue", "w")]),
  ], 2);
  assert.equal(duos.length, 3, "A+B, A+C, B+C");
  assert.equal(duos[0].n, 3, "la paire la plus assidue en tête");
});

test("liste vide ou membres sans parties : aucun duo fabriqué", () => {
  assert.equal(X.computeDuos([], 2).length, 0);
  assert.equal(X.computeDuos(null, 2).length, 0);
  assert.equal(X.computeDuos([sq("A", []), sq("B", [])], 2).length, 0);
});

/* --------------------------------------- détail par round optionnel */

const fullRaw = () => ({
  metadata: { match_id: "f1", map: { name: "Ascent" }, queue: { name: "Competitive" },
    started_at: "2026-08-22T20:00:00Z" },
  players: [
    { puuid: "p1", name: "A", tag: "1", team_id: "Blue", agent: { id: "a", name: "Jett" },
      stats: { kills: 20, deaths: 10, assists: 4, score: 5000, headshots: 20, bodyshots: 60, legshots: 5,
        damage: { dealt: 3500, received: 3000 } } },
    { puuid: "p2", name: "B", tag: "2", team_id: "Red", agent: { id: "b", name: "Omen" },
      stats: { kills: 10, deaths: 20, assists: 2, score: 2500, headshots: 8, bodyshots: 40, legshots: 3,
        damage: { dealt: 2000, received: 3500 } } },
  ],
  rounds: [{ winning_team: "Blue", result: "Elimination", stats: [], plant: null, defuse: null }],
  kills: [{ round: 0, time_in_round_in_ms: 5000, killer: { puuid: "p1", name: "A", team: "Blue" },
    victim: { puuid: "p2", name: "B", team: "Red" }, weapon: { name: "Vandal" }, assistants: [] }],
  teams: [{ team_id: "Blue", won: true, rounds: { won: 13, lost: 7 } },
          { team_id: "Red", won: false, rounds: { won: 7, lost: 13 } }],
});

test("le détail par round est calculé par défaut", () => {
  const M2 = X.normMatch(fullRaw(), { puuid: "p1", name: "A", tag: "1" });
  assert.ok(M2.facts, "le profil en a besoin");
  assert.ok(Array.isArray(M2.facts.timeline));
});

test("…et peut être désactivé pour les écrans qui ne s'en servent pas", () => {
  const M2 = X.normalizeAny(fullRaw(), { puuid: "p1", name: "A", tag: "1" }, { facts: false });
  assert.equal(M2.facts, null, "~28 Ko et le parcours des rounds économisés par partie");
  assert.equal(M2.me.k, 20, "le reste des stats est intact");
  assert.equal(M2.result, "w");
});

test("squadStale compte les membres non rafraîchis", () => {
  assert.equal(X.squadStale([{ freshFailed: true }, { freshFailed: false }, { freshFailed: true }]), 2);
  assert.equal(X.squadStale([]), 0);
  assert.equal(X.squadStale(null), 0);
});
