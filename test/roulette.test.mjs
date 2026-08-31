// Tests du moteur de la Roulette. Le hasard est injecté (`rnd`) pour que les
// tirages soient reproductibles : on vérifie les RÈGLES, pas la chance.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function load() {
  const ctx = vm.createContext({ console, URL, URLSearchParams, setTimeout, clearTimeout });
  let code = readFileSync(join(root, "app.js"), "utf8");
  code += `\nglobalThis.__x = { pickMany, pickOne, agentsForRole, agentPlayCounts, freshAgents,
    rollComposition, memberKey, ROLES, ROLE_FR,
    setAgents: l => { AGENT_LIST = l; }, setPeople: (r, g) => { ROSTER = r; GUESTS = g || []; } };`;
  vm.runInContext(code, ctx);
  return ctx.__x;
}
const X = load();

// Deux agents par rôle, pour pouvoir observer les contraintes.
const AGENTS = [
  { name: "Jett", role: "Duelliste" }, { name: "Reyna", role: "Duelliste" },
  { name: "Sova", role: "Initiateur" }, { name: "Breach", role: "Initiateur" },
  { name: "Omen", role: "Contrôleur" }, { name: "Brimstone", role: "Contrôleur" },
  { name: "Cypher", role: "Sentinelle" }, { name: "Killjoy", role: "Sentinelle" },
];
const P = (n) => ({ name: n, tag: "0001", color: "#fff" });
const TEAM = ["Alice", "Bob", "Chloé", "David", "Emma", "Fabien"].map(P);
// Générateur déterministe : suite fixe dans [0,1).
const seq = (...vals) => { let i = 0; return () => vals[i++ % vals.length]; };

/* ------------------------------------------------------------- tirage brut */

test("pickMany tire SANS remise", () => {
  const out = X.pickMany(TEAM, 5, seq(0, 0, 0, 0, 0));
  assert.equal(out.length, 5);
  assert.equal(new Set(out.map(p => p.name)).size, 5, "aucun doublon");
});

test("pickMany ne dépasse jamais la taille du vivier", () => {
  assert.equal(X.pickMany(TEAM.slice(0, 2), 5, Math.random).length, 2);
  assert.equal(X.pickMany([], 3, Math.random).length, 0);
  assert.equal(X.pickMany(null, 3, Math.random).length, 0);
});

test("pickOne renvoie null sur un vivier vide plutôt que undefined", () => {
  assert.equal(X.pickOne([], Math.random), null);
});

/* -------------------------------------------------------------- par rôle */

test("la roulette par rôle ne sort que des agents de ce rôle", () => {
  X.setAgents(AGENTS);
  X.ROLES.forEach(role => {
    const pool = X.agentsForRole(role);
    assert.ok(pool.length, `${role} a des agents`);
    assert.ok(pool.every(a => a.role === role), `${role} : aucun intrus`);
  });
});

test("« tous » ne filtre rien", () => {
  X.setAgents(AGENTS);
  assert.equal(X.agentsForRole("all").length, AGENTS.length);
  assert.equal(X.agentsForRole(null).length, AGENTS.length);
});

test("un rôle inconnu donne un vivier vide, pas la liste entière", () => {
  X.setAgents(AGENTS);
  assert.equal(X.agentsForRole("Saiyan").length, 0);
});

/* --------------------------------------------------------- persos à tester */

test("agentPlayCounts compte les agents joués dans l'historique", () => {
  const h = [{ me: { agent: "Jett" } }, { me: { agent: "Jett" } }, { me: { agent: "Omen" } }, { me: null }, null];
  const c = X.agentPlayCounts(h);
  assert.equal(c.Jett, 2);
  assert.equal(c.Omen, 1);
  assert.equal(c.Sova, undefined);
});

test("« à tester » ne garde que les agents jamais joués", () => {
  const pool = X.freshAgents(AGENTS, { Jett: 5, Reyna: 2, Sova: 1 });
  assert.equal(pool.some(a => a.name === "Jett"), false);
  assert.equal(pool.some(a => a.name === "Omen"), true, "Omen n'a jamais été joué");
  assert.ok(pool.every(a => a.role !== undefined));
});

test("quand TOUT a été joué, on garde les moins joués au lieu de ne rien rendre", () => {
  const counts = {}; AGENTS.forEach((a, i) => { counts[a.name] = i === 3 ? 1 : 7; });
  const pool = X.freshAgents(AGENTS, counts);
  assert.equal(pool.length, 1);
  assert.equal(pool[0].name, "Breach", "le moins joué");
  assert.notEqual(pool.length, 0, "le mode « à tester » ne doit jamais rendre le vivier vide");
});

/* ------------------------------------------------------------- composition */

test("la compo tire le bon nombre de joueurs, chacun avec un agent", () => {
  X.setAgents(AGENTS);
  const out = X.rollComposition(TEAM, { size: 5, list: AGENTS });
  assert.equal(out.length, 5);
  assert.ok(out.every(p => p.person && p.agent), "chacun a un agent");
  assert.equal(new Set(out.map(p => p.person.name)).size, 5, "pas deux fois la même personne");
});

test("deux joueurs n'ont jamais le même agent", () => {
  X.setAgents(AGENTS);
  for (let i = 0; i < 40; i++) {
    const out = X.rollComposition(TEAM, { size: 5, list: AGENTS });
    assert.equal(new Set(out.map(p => p.agent.name)).size, 5, "agents tous différents");
  }
});

test("compo équilibrée : un rôle différent par joueur", () => {
  X.setAgents(AGENTS);
  for (let i = 0; i < 30; i++) {
    const out = X.rollComposition(TEAM, { size: 4, balanced: true, list: AGENTS });
    const roles = out.map(p => p.agent.role);
    assert.equal(new Set(roles).size, 4, `4 rôles distincts (obtenu ${roles.join(",")})`);
  }
});

test("compo équilibrée à 5 : le 5e n'a plus de rôle imposé, mais garde un agent", () => {
  X.setAgents(AGENTS);
  const out = X.rollComposition(TEAM, { size: 5, balanced: true, list: AGENTS });
  assert.equal(out.length, 5);
  assert.ok(out.every(p => p.agent), "personne ne repart sans agent");
  assert.equal(new Set(out.map(p => p.agent.name)).size, 5);
});

test("un rôle imposé s'applique à toute la compo", () => {
  X.setAgents(AGENTS);
  const out = X.rollComposition(TEAM, { size: 2, role: "Duelliste", list: AGENTS });
  assert.ok(out.every(p => p.agent.role === "Duelliste"));
});

test("plus de joueurs que d'agents du rôle : on autorise le doublon plutôt que de laisser un joueur sans agent", () => {
  X.setAgents(AGENTS);
  // 3 joueurs pour 2 duellistes.
  const out = X.rollComposition(TEAM, { size: 3, role: "Duelliste", list: AGENTS });
  assert.equal(out.length, 3);
  assert.ok(out.every(p => p.agent && p.agent.role === "Duelliste"),
    "chacun a bien un duelliste, quitte à répéter");
});

test("la taille est bornée par le nombre de personnes disponibles", () => {
  X.setAgents(AGENTS);
  const out = X.rollComposition(TEAM.slice(0, 2), { size: 5, list: AGENTS });
  assert.equal(out.length, 2, "on ne tire pas 5 joueurs quand il n'y en a que 2");
});

test("« à tester » privilégie les agents que CHAQUE personne joue le moins", () => {
  X.setAgents(AGENTS);
  const alice = TEAM[0], bob = TEAM[1];
  // Alice a tout joué sauf Cypher ; Bob tout sauf Jett.
  const counts = {};
  counts[X.memberKey(alice)] = {}; counts[X.memberKey(bob)] = {};
  AGENTS.forEach(a => {
    if (a.name !== "Cypher") counts[X.memberKey(alice)][a.name] = 3;
    if (a.name !== "Jett") counts[X.memberKey(bob)][a.name] = 3;
  });
  const out = X.rollComposition([alice, bob], { size: 2, fresh: true, counts, list: AGENTS });
  const byName = Object.fromEntries(out.map(p => [p.person.name, p.agent.name]));
  assert.equal(byName["Alice"], "Cypher", "le seul agent qu'Alice n'a jamais joué");
  assert.equal(byName["Bob"], "Jett", "…et celui de Bob");
});

test("un tirage sans personne ne plante pas", () => {
  X.setAgents(AGENTS);
  assert.equal(X.rollComposition([], { size: 3, list: AGENTS }).length, 0);
  assert.equal(X.rollComposition(null, { size: 3, list: AGENTS }).length, 0);
});

test("sans aucun agent chargé, on ne fabrique pas de faux agents", () => {
  const out = X.rollComposition(TEAM, { size: 2, list: [] });
  assert.equal(out.length, 2);
  assert.ok(out.every(p => p.agent === null), "agent null plutôt qu'inventé");
});

test("les rôles traduits couvrent les quatre rôles du jeu", () => {
  assert.equal(X.ROLES.length, 4);
  // deepEqual échoue entre réalms vm : on compare les chaînes.
  assert.equal(Object.values(X.ROLE_FR).sort().join(","), X.ROLES.slice().sort().join(","));
});
