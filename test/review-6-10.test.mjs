// Revue du site, points 6 à 10 : Classé par défaut, parties perso hors stats,
// accueil en 2 colonnes au téléphone, duos à un seul endroit, plus de liens
// « Retour à l'accueil », libellés en français.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "index.html"), "utf8");
const ctx = vm.createContext({ console, URL, URLSearchParams });
vm.runInContext(readFileSync(join(root, "app.js"), "utf8")
  + "\nglobalThis.__x = { isCustomMatch, filterByMode, modeFr, tierFr, CURRENT_MODE };", ctx);
const X = ctx.__x;

test("6 : la liste s'ouvre sur « Classé »", () => {
  assert.equal(X.CURRENT_MODE, "competitive");
  assert.match(html, /<button data-mode="competitive" class="on">Classé<\/button>/);
  assert.doesNotMatch(html, /data-mode="all" class="on"/);
});

test("6 : parties perso reconnues (Custom Game, « unknown », cartes Skirmish)", () => {
  assert.equal(X.isCustomMatch({ mode: "Custom Game", map: "Ascent" }), true);
  assert.equal(X.isCustomMatch({ mode: "unknown", map: "Skirmish A" }), true);
  assert.equal(X.isCustomMatch({ mode: "Competitive", map: "Skirmish B" }), true, "la carte suffit");
  assert.equal(X.isCustomMatch({ mode: "Competitive", map: "Lotus" }), false);
  assert.equal(X.isCustomMatch({ mode: "Deathmatch", map: "Bind" }), false);
});

test("7 : accueil au téléphone en deux colonnes", () => {
  const m = html.match(/@media\(max-width:560px\)\{\s*\.roster\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.ok(m, "grille 2 colonnes sous 560 px");
});

test("8 : plus de duos en double dans le Classement", () => {
  assert.doesNotMatch(html, /id="duoList"/);
  assert.match(html, /id="lbToDuos"/, "un lien mène aux duos du Dashboard");
  assert.equal(typeof ctx.computeDuos, "undefined");
});

test("9 : plus de « Retour à l'accueil » sur les onglets", () => {
  assert.doesNotMatch(html, /Retour à l'accueil/);
  assert.match(html, /id="btnBack"/, "le profil garde son retour (on y arrive depuis une carte)");
});

test("10 : rangs et modes en français", () => {
  assert.equal(X.tierFr("Gold 3"), "Or 3");
  assert.equal(X.tierFr("PLATINUM 1"), "Platine 1", "les noms valorant-api sont en majuscules");
  assert.equal(X.tierFr("Unrated"), "Non classé");
  assert.equal(X.tierFr("Radiant"), "Radiant");
  assert.equal(X.modeFr("Competitive"), "Classé");
  assert.equal(X.modeFr("Deathmatch"), "Combat à mort");
  assert.equal(X.modeFr("Team Deathmatch"), "Combat à mort en équipe");
  assert.equal(X.modeFr("Gauntlet: Glitched"), "Gauntlet: Glitched", "mode inconnu : le nom tel quel");
  // Les filtres continuent de lire le nom anglais de l'API.
  assert.equal(X.filterByMode([{ mode: "Competitive" }, { mode: "Deathmatch" }], "competitive").length, 1);
});
