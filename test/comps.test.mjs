// Compos par map : projection côté serveur, agrégation côté front.
// Les données sont fabriquées à la main pour que les winrates attendus soient
// vérifiables de tête — on teste les RÈGLES, pas un jeu de données réel.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { projectMatch, mergeComps, missingIDs, runCompsBackfill } from "../netlify/functions/lib/comps-core.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------------------- projection (serveur) */

// Une réponse /valorant/v4/match/... réduite à ce que la projection lit.
const v4 = (over = {}) => ({
  data: {
    metadata: {
      match_id: over.id || "m1", map: { name: over.map || "Ascent" },
      started_at: over.at || "2026-08-31T11:00:00.00Z",
      queue: { id: "competitive", name: "Competitive" },
      is_completed: over.completed === undefined ? true : over.completed,
    },
    players: (over.players || [
      ...["Jett", "Sova", "Omen", "Cypher", "Raze"].map((a) => ({ team_id: "Red", agent: { name: a } })),
      ...["Reyna", "Fade", "Viper", "Sage", "Neon"].map((a) => ({ team_id: "Blue", agent: { name: a } })),
    ]),
    teams: over.teams || [
      { team_id: "Red", rounds: { won: 13, lost: 6 }, won: true },
      { team_id: "Blue", rounds: { won: 6, lost: 13 }, won: false },
    ],
  },
});

test("projectMatch retient les deux compos et le vainqueur", () => {
  const p = projectMatch(v4());
  assert.equal(p.id, "m1");
  assert.equal(p.map, "Ascent");
  assert.equal(p.sides.join(","), "Red,Blue");
  assert.equal(p.t.length, 2);
  assert.equal(p.t[0].length, 5);
  assert.equal(p.w, 0, "Red a gagné");
  assert.equal(p.r.join(","), "13,6");
});

test("les agents sont triés : une compo est un ensemble, pas un ordre", () => {
  const a = projectMatch(v4()).t[0];
  assert.equal(a.join(","), a.slice().sort().join(","));
  // Les mêmes 5 agents dans un autre ordre donnent la MÊME clé.
  const shuffled = v4({
    players: [
      ...["Raze", "Cypher", "Omen", "Sova", "Jett"].map((x) => ({ team_id: "Red", agent: { name: x } })),
      ...["Reyna", "Fade", "Viper", "Sage", "Neon"].map((x) => ({ team_id: "Blue", agent: { name: x } })),
    ],
  });
  assert.equal(projectMatch(shuffled).t[0].join(","), a.join(","));
});

test("une compo incomplète est écartée plutôt que comptée à moitié", () => {
  const short = v4({
    players: [
      ...["Jett", "Sova", "Omen"].map((a) => ({ team_id: "Red", agent: { name: a } })),
      ...["Reyna", "Fade", "Viper", "Sage", "Neon"].map((a) => ({ team_id: "Blue", agent: { name: a } })),
    ],
  });
  assert.equal(projectMatch(short), null);
});

test("une partie non terminée n'a pas de résultat exploitable", () => {
  assert.equal(projectMatch(v4({ completed: false })), null);
});

test("sans drapeau `won` fiable, le score tranche", () => {
  const p = projectMatch(v4({
    teams: [{ team_id: "Red", rounds: { won: 4 } }, { team_id: "Blue", rounds: { won: 13 } }],
  }));
  assert.equal(p.w, 1);
  const draw = projectMatch(v4({
    teams: [{ team_id: "Red", rounds: { won: 12 } }, { team_id: "Blue", rounds: { won: 12 } }],
  }));
  assert.equal(draw.w, -1, "égalité");
});

test("une réponse vide ou biscornue ne fait pas planter la projection", () => {
  [null, {}, { data: {} }, { data: { metadata: {}, players: [], teams: [] } }].forEach((x) => {
    assert.equal(projectMatch(x), null);
  });
});

test("mergeComps dédoublonne et garde la version déjà stockée", () => {
  const a = { id: "x", at: 2, map: "Ascent" };
  const b = { id: "x", at: 2, map: "MODIFIÉ" };
  const c = { id: "y", at: 5, map: "Bind" };
  const out = mergeComps([a], [b, c]);
  assert.equal(out.length, 2);
  assert.equal(out.find((z) => z.id === "x").map, "Ascent", "l'existant fait foi");
  assert.equal(out[0].id, "y", "trié du plus récent au plus ancien");
});

test("missingIDs ne renvoie que l'inconnu, récent d'abord, et borné", () => {
  const stored = [
    { meta: { id: "a", started_at: "2026-08-01T00:00:00Z", region: "eu" } },
    { meta: { id: "b", started_at: "2026-08-03T00:00:00Z", region: "eu" } },
    { meta: { id: "c", started_at: "2026-08-02T00:00:00Z", region: "eu" } },
    { meta: { id: "b", started_at: "2026-08-03T00:00:00Z" } },      // doublon entre membres
  ];
  const out = missingIDs(stored, [{ id: "a" }], 0);
  assert.equal(out.map((x) => x.id).join(","), "b,c");
  assert.equal(missingIDs(stored, [], 1).length, 1, "la limite borne le travail du cron");
});

/* --------------------------------------------------- backfill (cron) */

function fakeStore(initial) {
  let doc = initial;
  return { store: { get: async () => doc, setJSON: async (k, v) => { doc = v; } }, read: () => doc };
}
const silent = { log() {}, error() {} };

test("le backfill écrit les nouvelles parties dans le blob", async () => {
  const { store, read } = fakeStore(null);
  const res = await runCompsBackfill({
    getStore: () => store, apiKey: "k", sleep: async () => {}, log: silent,
    storedMatches: [{ meta: { id: "m1", started_at: "2026-08-31T11:00:00Z", region: "eu" } }],
    fetchImpl: async () => ({ ok: true, json: async () => v4() }),
  });
  assert.equal(res.added, 1);
  assert.equal(read().comps.length, 1);
  assert.equal(read().v, 1);
});

test("le backfill respecte son budget de temps", async () => {
  const { store } = fakeStore(null);
  let clock = 0;
  let calls = 0;
  const stored = Array.from({ length: 50 }, (_, i) => ({ meta: { id: "m" + i, started_at: "2026-08-31T11:00:00Z" } }));
  await runCompsBackfill({
    getStore: () => store, apiKey: "k", sleep: async () => {}, log: silent, storedMatches: stored,
    limit: 50, budgetMs: 100, now: () => (clock += 30),
    fetchImpl: async () => { calls++; return { ok: true, json: async () => v4({ id: "m" + calls }) }; },
  });
  assert.ok(calls < 10, `s'arrête vite (${calls} appels)`);
});

test("un 429 stoppe le backfill au lieu de s'acharner", async () => {
  const { store } = fakeStore(null);
  let calls = 0;
  await runCompsBackfill({
    getStore: () => store, apiKey: "k", sleep: async () => {}, log: silent,
    storedMatches: Array.from({ length: 10 }, (_, i) => ({ meta: { id: "m" + i } })),
    fetchImpl: async () => { calls++; return { ok: false, status: 429 }; },
  });
  assert.equal(calls, 1);
});

test("sans clé API, le backfill refuse de partir", async () => {
  await assert.rejects(() => runCompsBackfill({ getStore: () => fakeStore(null).store, storedMatches: [] }));
});

/* ------------------------------------------------- agrégation (front) */

function loadFront() {
  const ctx = vm.createContext({ console, URL, URLSearchParams, setTimeout, clearTimeout });
  let code = readFileSync(join(root, "app.js"), "utf8");
  code += `\nglobalThis.__c = { wilsonLower, roleOf, roleSig, roleSigLabel, compRows, tally,
    agentPairs, agentTrios, mapReport, compMaps, COMPO_MIN,
    setAgents: l => { AGENT_LIST = l; } };`;
  vm.runInContext(code, ctx);
  return ctx.__c;
}
const C = loadFront();
C.setAgents([
  { name: "Jett", role: "Duelliste" }, { name: "Raze", role: "Duelliste" }, { name: "Reyna", role: "Duelliste" },
  { name: "Sova", role: "Initiateur" }, { name: "Fade", role: "Initiateur" },
  { name: "Omen", role: "Contrôleur" }, { name: "Viper", role: "Contrôleur" },
  { name: "Cypher", role: "Sentinelle" }, { name: "Sage", role: "Sentinelle" },
]);

// Une partie projetée : Red = compo A, Blue = compo B, `redWins` tranche.
const M = (id, map, red, blue, redWins, at) => ({
  id, map, mode: "Competitive", at: at || 1,
  sides: ["Red", "Blue"], t: [red.slice().sort(), blue.slice().sort()],
  r: redWins ? [13, 6] : [6, 13], w: redWins ? 0 : 1,
});
const A = ["Jett", "Raze", "Sova", "Omen", "Cypher"];   // 2 duel, 1 init, 1 ctrl, 1 sent
const B = ["Reyna", "Fade", "Viper", "Sage", "Jett"];   // 2 duel, 1 init, 1 ctrl, 1 sent

test("wilsonLower punit les petits échantillons", () => {
  assert.ok(C.wilsonLower(3, 3) < C.wilsonLower(42, 60), "3/3 ne passe pas devant 42/60");
  assert.ok(C.wilsonLower(5, 10) < 0.5, "5/10 : la borne basse reste sous 50 %");
  assert.equal(C.wilsonLower(0, 0), 0);
});

test("roleSig compte les rôles, et refuse une compo au rôle inconnu", () => {
  assert.equal(C.roleSig(A), "2-1-1-1");
  assert.equal(C.roleSig(["Jett", "Jett", "Jett", "Jett", "Jett"]), "5-0-0-0");
  assert.equal(C.roleSig(["Jett", "AgentInconnu"]), null, "plutôt null qu'une signature fausse");
});

test("roleSigLabel se lit en français, avec les pluriels", () => {
  assert.equal(C.roleSigLabel("2-1-1-1"), "2 Duellistes · 1 Initiateur · 1 Contrôleur · 1 Sentinelle");
  assert.equal(C.roleSigLabel("0-0-5-0"), "5 Contrôleurs", "les rôles absents ne sont pas listés");
});

test("échelle observée : chaque partie donne DEUX compos", () => {
  const rows = C.compRows([M("m1", "Ascent", A, B, true)], "global", null, { map: "Ascent", mode: "ranked" });
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((r) => r.won).length, 1, "un gagnant, un perdant");
});

test("échelle COSMO : seulement notre camp, et seulement si on le connaît", () => {
  const comps = [M("m1", "Ascent", A, B, true), M("m2", "Ascent", A, B, false)];
  const idx = { m1: [{ key: "x", team: "Blue" }], m2: [{ key: "x", team: "Red" }] };
  const rows = C.compRows(comps, "cosmo", idx, { map: "Ascent", mode: "ranked" });
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((r) => r.won).length, 0, "COSMO a perdu les deux");

  // Camp inconnu : la partie est ignorée, pas devinée.
  const blind = C.compRows(comps, "cosmo", { m1: [{ key: "x" }] }, { map: "Ascent", mode: "ranked" });
  assert.equal(blind.length, 0);
});

test("le filtre map et le filtre ranked s'appliquent", () => {
  const comps = [
    M("m1", "Ascent", A, B, true),
    M("m2", "Bind", A, B, true),
    { ...M("m3", "Ascent", A, B, true), mode: "Deathmatch" },
  ];
  assert.equal(C.compRows(comps, "global", null, { map: "Ascent", mode: "ranked" }).length, 2, "m1 seulement, 2 camps");
  assert.equal(C.compRows(comps, "global", null, { map: "Bind", mode: "ranked" }).length, 2);
});

test("tally classe par borne de Wilson, pas par winrate brut", () => {
  const rows = [];
  // « rare » : 3 victoires sur 3.  « solide » : 40 sur 60.
  for (let i = 0; i < 3; i++) rows.push({ agents: ["rare"], won: true });
  for (let i = 0; i < 60; i++) rows.push({ agents: ["solide"], won: i < 40 });
  const out = C.tally(rows, (r) => r.agents, 1);
  assert.equal(out[0].key, "solide", "60 parties à 67 % passent devant 3 sur 3");
  assert.equal(out[0].n, 60);
  assert.equal(Math.round(out[0].wr * 100), 67);
});

test("tally écarte les égalités et respecte le minimum", () => {
  const rows = [{ agents: ["x"], won: true }, { agents: ["x"], draw: true }, { agents: ["y"], won: false }];
  const out = C.tally(rows, (r) => r.agents, 1);
  assert.equal(out.find((e) => e.key === "x").n, 1, "l'égalité ne compte pas");
  assert.equal(C.tally(rows, (r) => r.agents, 2).length, 0, "sous le minimum, rien ne sort");
});

test("agentPairs produit les 10 paires d'une compo, dans un ordre stable", () => {
  const p = C.agentPairs(A);
  assert.equal(p.length, 10);
  assert.equal(new Set(p).size, 10);
  assert.equal(C.agentPairs(["Sova", "Jett"]).join(""), C.agentPairs(["Jett", "Sova"]).join(""));
});

test("mapReport résume la map et remplit les quatre classements", () => {
  // 12 parties identiques : compo A gagne à chaque fois.
  const comps = Array.from({ length: 12 }, (_, i) => M("m" + i, "Ascent", A, B, true, i + 1));
  const rep = C.mapReport(comps, "global", null, { map: "Ascent", mode: "ranked" });
  assert.equal(rep.played, 24, "12 parties = 24 compos");
  assert.equal(rep.wr, 0.5, "un gagnant pour un perdant : 50 % par construction");
  assert.equal(rep.from, 1);
  assert.equal(rep.to, 12);

  const trio = rep.trios.find((e) => e.key === "Cypher + Jett + Omen");
  assert.equal(trio.n, 12);
  assert.equal(trio.wr, 1, "ce noyau a tout gagné");

  const jett = rep.agents.find((e) => e.key === "Jett");
  assert.equal(jett.n, 24, "Jett est dans les deux compos");
  assert.equal(jett.wr, 0.5);
});

test("les seuils empêchent d'afficher un pourcentage sur 2 parties", () => {
  const comps = [M("m1", "Ascent", A, B, true), M("m2", "Ascent", A, B, false)];
  const rep = C.mapReport(comps, "global", null, { map: "Ascent", mode: "ranked" });
  assert.equal(rep.roles.length, 0);
  assert.equal(rep.trios.length, 0);
  assert.equal(rep.agents.length, 0);
  assert.ok(C.COMPO_MIN.roles > 2 && C.COMPO_MIN.trio > 2);
});

test("compMaps classe les maps par nombre de parties", () => {
  const comps = [
    M("m1", "Ascent", A, B, true), M("m2", "Ascent", A, B, true), M("m3", "Bind", A, B, true),
    { ...M("m4", "Split", A, B, true), mode: "Deathmatch" },
  ];
  const maps = C.compMaps(comps, { mode: "ranked" });
  assert.equal(maps[0].map, "Ascent");
  assert.equal(maps[0].n, 2);
  assert.equal(maps.some((m) => m.map === "Split"), false, "le deathmatch n'a pas de compo");
});

test("un jeu de compos vide ne fait rien planter", () => {
  assert.equal(C.compMaps([], {}).length, 0);
  assert.equal(C.compMaps(null, {}).length, 0);
  const rep = C.mapReport([], "global", null, { map: "Ascent", mode: "ranked" });
  assert.equal(rep.played, 0);
  assert.equal(rep.wr, null);
});

test("camps opposés : on écarte plutôt que de compter la compo adverse", () => {
  const comps = [M("m1", "Ascent", A, B, true)];
  // Deux membres du même côté : c'est bien notre camp.
  const same = C.compRows(comps, "cosmo", { m1: [{ key: "a", team: "Red" }, { key: "b", team: "Red" }] },
    { map: "Ascent", mode: "ranked" });
  assert.equal(same.length, 1);
  assert.equal(same[0].won, true);

  // Majorité claire : on suit la majorité.
  const major = C.compRows(comps, "cosmo",
    { m1: [{ key: "a", team: "Blue" }, { key: "b", team: "Blue" }, { key: "c", team: "Red" }] },
    { map: "Ascent", mode: "ranked" });
  assert.equal(major.length, 1);
  assert.equal(major[0].won, false, "la majorité était côté Blue, qui a perdu");

  // Égalité parfaite : impossible de trancher, on n'invente pas.
  const tie = C.compRows(comps, "cosmo", { m1: [{ key: "a", team: "Red" }, { key: "b", team: "Blue" }] },
    { map: "Ascent", mode: "ranked" });
  assert.equal(tie.length, 0);
});

test("le filtre de période coupe la queue périmée", () => {
  const day = 86400000, now = Date.now();
  const comps = [
    M("recent", "Ascent", A, B, true, now - 10 * day),
    M("vieux",  "Ascent", A, B, true, now - 900 * day),
  ];
  const all = C.compRows(comps, "global", null, { map: "Ascent", mode: "ranked" });
  assert.equal(all.length, 4, "sans borne, les deux parties comptent");
  const year = C.compRows(comps, "global", null, { map: "Ascent", mode: "ranked", since: now - 365 * day });
  assert.equal(year.length, 2, "la partie de 2023 sort");
  // compMaps applique la même borne, sinon une map ne figurerait au menu que
  // grâce à des parties que le classement, lui, ignore.
  assert.equal(C.compMaps(comps, { mode: "ranked", since: now - 365 * day })[0].n, 1);
});

test("agentTrios produit les 10 noyaux d'une compo, en clé stable", () => {
  const t = C.agentTrios(A);
  assert.equal(t.length, 10);
  assert.equal(new Set(t).size, 10);
  // L'ordre des joueurs ne doit pas créer deux clés pour le même trio.
  assert.equal(C.agentTrios(["Omen", "Jett", "Sova"])[0], C.agentTrios(["Sova", "Omen", "Jett"])[0]);
  assert.equal(C.agentTrios(["Jett", "Sova"]).length, 0, "moins de 3 agents : aucun trio");
});
