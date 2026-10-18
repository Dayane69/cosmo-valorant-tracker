// Normalisation des parties de la squad (détail par round optionnel, membres non rafraîchis).
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
  code += "\nglobalThis.__x = { normMatch, normalizeAny, squadStale };";
  vm.runInContext(code, ctx);
  return ctx.__x;
}
const X = load();

// Les duos du Classement (winrate seul) ont rejoint ceux du Dashboard
// (winrate + RR) : leurs tests sont dans dashboard.test.mjs.

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
