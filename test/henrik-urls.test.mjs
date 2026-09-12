// Forme des URL HenrikDev appelées par le site.
//
// Pourquoi ce fichier existe. Rien ne vérifiait le CONTRAT d'URL entre le site
// et l'API : c'est exactement par là qu'un segment `pc/` en trop s'était glissé
// dans match-par-id. L'appel ne pouvait qu'échouer, et l'écran attribuait
// l'échec à l'âge de la partie — un défaut qui se présentait comme une limite
// normale, donc invisible.
//
// La règle que ces tests figent : /valorant/v4/matcheS/{region}/pc/{name}/{tag}
// prend une plateforme parce qu'il LISTE les parties d'un joueur ; /valorant/v4/
// match/{region}/{id} n'en prend pas, l'identifiant suffit. Le dernier test
// confronte directement le front au cron, dont la forme est éprouvée sur 635
// parties sans un échec : les deux moitiés du projet ne peuvent plus diverger
// en silence.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { runCompsBackfill } from "../netlify/functions/lib/comps-core.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Charge app.js avec un fetch qui note les URL au lieu de les appeler.
//
// Le `document` n'est branché qu'APRÈS l'exécution du fichier : tant qu'il est
// absent, init() ne se lance pas, et ce qu'on mesure reste le seul appel qu'on
// déclenche. `$` lit le global au moment de l'appel, donc le sélecteur de
// région répond quand même — c'est le repli quand la partie n'a pas la sienne.
function load(selectorRegion = "eu") {
  const calls = [];
  const ctx = vm.createContext({
    console, URL, URLSearchParams,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 1)),
    clearTimeout: (h) => clearTimeout(h),
    fetch: async (url) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => ({ data: null }) }; },
  });
  let code = readFileSync(join(root, "app.js"), "utf8");
  code += `\nglobalThis.__x = { fetchMatchDetail };`;
  vm.runInContext(code, ctx);
  ctx.document = { getElementById: () => ({ value: selectorRegion }) };
  return { X: ctx.__x, calls };
}

// Le front passe par le proxy : on en ressort le chemin HenrikDev demandé.
const pathOf = (proxyUrl) => new URL(proxyUrl, "https://cosmo-valo.netlify.app").searchParams.get("path");

const MID = "8d4b1c2e-0000-4aaa-bbbb-1234567890ab";

test("match-par-id : /valorant/v4/match/{region}/{id}, sans segment de plateforme", async () => {
  const { X, calls } = load();
  await X.fetchMatchDetail(MID, "eu");
  assert.equal(calls.length, 1);
  const path = pathOf(calls[0]);
  assert.equal(path, `/valorant/v4/match/eu/${MID}`);
  // La régression exacte qu'on a corrigée, nommée pour qu'elle ne revienne pas.
  assert.ok(!path.includes("/pc/"), "match-par-id ne prend pas de plateforme");
  // valorant · v4 · match · région · id — pas un segment de plus.
  assert.equal(path.split("/").filter(Boolean).length, 5);
});

test("la région est celle de la PARTIE, pas celle du sélecteur", async () => {
  const { X, calls } = load("eu");                 // sélecteur sur eu…
  await X.fetchMatchDetail(MID, "ap");             // …mais la partie vient d'ap
  assert.equal(pathOf(calls[0]), `/valorant/v4/match/ap/${MID}`);
});

test("sans région connue, on retombe sur le sélecteur", async () => {
  const { X, calls } = load("kr");
  await X.fetchMatchDetail(MID, "");
  assert.equal(pathOf(calls[0]), `/valorant/v4/match/kr/${MID}`);
});

test("un identifiant douteux est encodé, jamais collé tel quel dans l'URL", async () => {
  const { X, calls } = load();
  await X.fetchMatchDetail("../v1/premier", "eu");
  const path = pathOf(calls[0]);
  assert.ok(!path.includes("../"), "un id ne doit pas pouvoir remonter dans l'arborescence");
  assert.equal(path, "/valorant/v4/match/eu/..%2Fv1%2Fpremier");
});

test("le front et le cron demandent la MÊME route pour match-par-id", async () => {
  // Côté front.
  const { X, calls } = load();
  await X.fetchMatchDetail(MID, "eu");
  const front = pathOf(calls[0]);

  // Côté cron : la forme éprouvée sur 635 parties.
  const cronCalls = [];
  await runCompsBackfill({
    getStore: () => ({ get: async () => null, setJSON: async () => {} }),
    fetchImpl: async (url) => { cronCalls.push(String(url)); return { ok: true, status: 200, json: async () => ({}) }; },
    apiKey: "clé-de-test",
    storedMatches: [{ meta: { id: MID, region: "eu", started_at: "2026-08-22T20:00:00Z" } }],
    spacingMs: 0, sleep: async () => {}, log: { log() {}, error() {} },
  });
  assert.equal(cronCalls.length, 1);
  const cron = new URL(cronCalls[0]).pathname;

  assert.equal(front, cron);
});
