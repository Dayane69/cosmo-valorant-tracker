// Tests front (app.js) avec un faux DOM (jsdom) + vm.
// Vérifie : init sans erreur, profil qui s'ouvre, fusion dédoublonnée par
// matchid, et tribunal qui reste ranked-only après l'ajout de l'historique.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const roster = JSON.parse(readFileSync(join(root, "roster.json"), "utf8"));

function rawMatch(id, iso, won = true, mode = "Competitive") {
  return {
    metadata: { match_id: id, started_at: iso, map: { name: "Ascent" }, queue: { name: mode } },
    players: [
      { puuid: "p1", name: "Arsh26", tag: "2826", team_id: "Blue", agent: { name: "Cypher" },
        stats: { kills: 15, deaths: 10, assists: 5, score: 5000, headshots: 20, bodyshots: 30, legshots: 5, damage: { dealt: 4000, received: 3000 } } },
      { puuid: "e1", name: "Foe", tag: "9999", team_id: "Red", agent: { name: "Jett" },
        stats: { kills: 10, deaths: 12, assists: 3, score: 3500, headshots: 10, bodyshots: 25, legshots: 5, damage: { dealt: 3000, received: 3500 } } },
    ],
    teams: [
      { team_id: "Blue", won, rounds: { won: won ? 13 : 7, lost: won ? 7 : 13 } },
      { team_id: "Red", won: !won, rounds: { won: won ? 7 : 13, lost: won ? 13 : 7 } },
    ],
  };
}

const jsonRes = (obj) => ({ ok: true, status: 200, json: async () => obj });

// fetch simulé : roster.json, proxy valo (account/mmr/matches), historique, valorant-api.
function makeFetch() {
  return async (input) => {
    const url = String(input);
    if (url.endsWith("roster.json")) return jsonRes(roster);

    if (url.includes("/.netlify/functions/valo")) {
      const path = new URL(url, "http://localhost").searchParams.get("path") || "";
      if (path.includes("/account/")) return jsonRes({ data: { puuid: "p1" } });
      if (path.includes("/mmr/")) return jsonRes({ data: { current: { tier: { name: "Gold 2" }, rr: 42, images: { large: "http://img/large.png" } } } });
      if (path.includes("/mmr-history/")) return jsonRes({ data: { history: [] } });
      if (path.includes("/v4/matches/")) return jsonRes({ data: [rawMatch("m1", "2026-06-24T10:00:00Z"), rawMatch("m2", "2026-06-23T10:00:00Z")] });
      return jsonRes({ data: [] });
    }

    if (url.includes("/.netlify/functions/historique")) {
      // blob accumulé : m2 (doublon) + m3 (nouveau, plus ancien)
      return jsonRes({ matches: [rawMatch("m2", "2026-06-23T10:00:00Z"), rawMatch("m3", "2026-06-22T10:00:00Z")] });
    }

    if (url.includes("valorant-api.com/v1/agents")) return jsonRes({ data: [{ displayName: "Cypher", displayIcon: "ic" }, { displayName: "Jett", displayIcon: "ij" }] });
    if (url.includes("valorant-api.com/v1/competitivetiers")) return jsonRes({ data: [{ tiers: [{ tierName: "Gold 2", largeIcon: "gi" }] }] });
    if (url.includes("valorant-api.com/v1/maps")) return jsonRes({ data: [{ displayName: "Ascent", splash: "sp" }] });

    return { ok: false, status: 404, json: async () => ({}) };
  };
}

async function boot() {
  const html = readFileSync(join(root, "index.html"), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://cosmo-valo.netlify.app/" });
  const ctx = dom.getInternalVMContext();
  dom.window.scrollTo = () => {};
  dom.window.fetch = makeFetch();
  ctx.fetch = dom.window.fetch;

  let code = readFileSync(join(root, "app.js"), "utf8");
  // Épilogue de test : expose les fonctions + un accès à l'état interne.
  code += "\nglobalThis.__t = { combineMatches, computeVerdict, openProfile, loadProfile, loadSquadMatches, init, getState: () => STATE, getRoster: () => ROSTER };";
  vm.runInContext(code, ctx);
  const T = ctx.__t;
  await T.init(); // garantit roster chargé + grille construite
  return { dom, T, ctx };
}

test("init s'exécute sans erreur et construit la grille depuis roster.json", async () => {
  const { dom, T } = await boot();
  assert.equal(T.getRoster().length, 7, "7 membres chargés depuis roster.json");
  assert.equal(dom.window.document.querySelectorAll("#roster .agentcard").length, 7, "7 cartes générées");
});

test("combineMatches dédoublonne par matchid et trie du plus récent au plus ancien", async () => {
  const { T } = await boot();
  const fresh = [rawMatch("a", "2026-06-20T10:00:00Z")];
  const blob = [rawMatch("a", "2026-06-20T10:00:00Z"), rawMatch("b", "2026-06-25T10:00:00Z")];
  const merged = T.combineMatches(fresh, blob);
  assert.equal(merged.length, 2, "le doublon 'a' n'apparaît qu'une fois");
  assert.equal(merged[0].metadata.match_id, "b", "le plus récent en tête");
});

test("le profil s'ouvre et fusionne frais + blob sans doublon (m1, m2, m3)", async () => {
  const { dom, T } = await boot();
  T.openProfile(0);
  await T.loadProfile(); // attend la fin du chargement asynchrone
  const doc = dom.window.document;
  assert.equal(doc.getElementById("profile").hidden, false, "la section profil est visible");
  assert.equal(doc.getElementById("app").hidden, false, "le contenu du profil est affiché");
  // fresh [m1,m2] + blob [m2,m3] => 3 matchs uniques
  assert.equal(T.getState().allMatches.length, 3, "historique combiné dédoublonné = 3");
  assert.equal(doc.querySelectorAll("#ml .mrow").length, 3, "3 lignes de match rendues");
});

test("le tribunal reste ranked-only après ajout de l'historique", async () => {
  const { T } = await boot();
  const nm = (mode, score100, result) => ({ me: { score100, placement: 4, kd: 1 }, mode, result });
  // 2 ranked (indice 80) + 2 unrated (indice 10) : si l'unrated comptait, la moyenne chuterait.
  const matches = [
    nm("competitive", 80, "w"), nm("unrated", 10, "l"),
    nm("competitive", 80, "w"), nm("unrated", 10, "l"),
  ];
  const v = T.computeVerdict(matches, 10);
  assert.equal(v.avg, 80, "moyenne calculée uniquement sur les parties classées");
  assert.equal(v.tier, "CRACKED");
});

test("loadSquadMatches garde le squad ranked-only même si le blob contient d'autres modes", async () => {
  const { T, ctx } = await boot();
  // Remplace le fetch : v4 -> 1 competitive ; historique -> 1 competitive + 1 unrated
  ctx.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/.netlify/functions/valo")) {
      const path = new URL(url, "http://localhost").searchParams.get("path") || "";
      if (path.includes("/v4/matches/")) return jsonRes({ data: [rawMatch("c1", "2026-06-24T10:00:00Z", true, "Competitive")] });
      return jsonRes({ data: [] });
    }
    if (url.includes("/.netlify/functions/historique")) {
      return jsonRes({ matches: [rawMatch("c2", "2026-06-20T10:00:00Z", true, "Competitive"), rawMatch("u1", "2026-06-23T10:00:00Z", true, "Unrated")] });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const squad = await T.loadSquadMatches("eu");
  const first = squad[0];
  assert.ok(first.norm.every((M) => (M.mode || "").toLowerCase() === "competitive"), "aucune partie non classée dans le squad");
  assert.equal(first.norm.length, 2, "c1 (frais) + c2 (blob), u1 (unrated) exclue");
});
