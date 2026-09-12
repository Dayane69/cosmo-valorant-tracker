// Ce qui vient des données ne doit jamais devenir du balisage.
//
// `esc()` est appliqué avec constance dans presque tout app.js — mais trois
// endroits y échappaient : les badges du leaderboard, le comparateur 1v1, et
// l'URL du fond de map. Les valeurs viennent du roster (protégé par
// REFRESH_TOKEN) ou de valorant-api, donc ce n'était pas une faille ouverte ;
// il suffisait pourtant d'un guillemet dans un pseudo ou une couleur pour
// casser l'affichage. Ces tests figent la règle partout.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// app.js lance init() tout seul au chargement. On laisse ses chaînes se
// terminer avant de fermer les DOM, sinon elles retombent sur un window fermé.
const DOMS = [];
after(async () => {
  await new Promise((r) => setTimeout(r, 120));
  DOMS.forEach((d) => { try { d.window.close(); } catch (e) {} });
});

async function boot() {
  const dom = new JSDOM(readFileSync(join(root, "index.html"), "utf8"),
    { runScripts: "outside-only", url: "https://cosmo-valo.netlify.app/" });
  DOMS.push(dom);
  const ctx = dom.getInternalVMContext();
  dom.window.scrollTo = () => {};
  ctx.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });

  let code = readFileSync(join(root, "app.js"), "utf8");
  code += `\nglobalThis.__t = { renderLeaderboard, renderList, imgURL,
    setRoster: (r) => { ROSTER = r; },
    setTrib: (m) => { TRIB.matches = m; },
    setMaps: (m) => { MAPS = m; },
    setMatches: (l) => { STATE.matches = l; STATE.allMatches = l; } };`;
  vm.runInContext(code, ctx);
  await new Promise((r) => setTimeout(r, 0));   // init() a démarré : on le laisse se poser
  return { dom, T: ctx.__t, doc: dom.window.document };
}

// La charge classique : si elle n'est pas échappée, un élément <img> apparaît
// dans le DOM et son onerror serait armé.
const XSS = '"><img src=x onerror=BOOM>';

const game = (i, won) => ({
  id: `g${i}`, mode: "Competitive", map: "Ascent", result: won ? "w" : "l",
  started: "2026-06-24T23:00:00Z", startedMs: Date.parse("2026-06-24T23:00:00Z"),
  rounds: 21, myScore: 13, oppScore: 8, myTeamId: "Blue", partial: false, players: [], lines: [],
  me: { k: 20, d: 10, a: 5, hs: 25, acs: 250, adr: 150, dd: 20, kd: 2, rounds: 21, kast: null,
        shots: 100, score100: 70 + i, agent: "Cypher", name: "x", tag: "1", team: "Blue" },
});

const hostile = [
  { name: XSS, tag: "1111", agent: XSS, role: "Duelliste", color: XSS, uuid: "u1" },
  { name: "Normal", tag: "2222", agent: "Jett", role: "Duelliste", color: "#56d8c9", uuid: "u2" },
];

/* ------------------------------------------------------- leaderboard & 1v1 */

test("un pseudo qui contient du HTML reste du texte, badges et 1v1 compris", async () => {
  const { T, doc } = await boot();
  T.setRoster(hostile);
  T.setTrib(hostile.map((member) => ({
    member, data: [], freshFailed: false,
    norm: [game(1, true), game(2, true), game(3, false), game(4, true), game(5, false)],
  })));

  T.renderLeaderboard();

  const lb = doc.getElementById("leaderboard");
  assert.equal(lb.querySelectorAll("img[src='x']").length, 0, "aucune image injectée");
  assert.equal(lb.querySelectorAll("[onerror]").length, 0, "aucun gestionnaire d'évènement injecté");
  // Et le pseudo n'a pas été avalé au passage : il s'affiche, comme du texte.
  assert.ok(lb.textContent.includes(XSS), "le pseudo est rendu, en texte");

  // Les trois zones concernées ont bien été produites.
  assert.ok(doc.getElementById("lbBadges").children.length > 0, "des badges sont rendus");
  assert.ok(doc.getElementById("vsResult").textContent.includes("VS"), "le comparateur est rendu");
});

test("le verdict du 1v1 n'échappe pas au traitement", async () => {
  const { T, doc } = await boot();
  T.setRoster(hostile);
  // Deux joueurs aux stats différentes : il y a un vainqueur, donc le verdict
  // nomme quelqu'un — c'est là que le pseudo était recopié tel quel.
  const strong = [game(1, true), game(2, true), game(3, true)];
  const weak = strong.map((g) => ({ ...g, result: "l", me: { ...g.me, score100: 20, acs: 90, k: 3, d: 20, kd: 0.15, hs: 5, dd: -40 } }));
  T.setTrib([
    { member: hostile[0], data: [], norm: strong, freshFailed: false },
    { member: hostile[1], data: [], norm: weak, freshFailed: false },
  ]);

  T.renderLeaderboard();

  const v = doc.querySelector("#vsResult .vs-verdict");
  assert.ok(v, "un verdict est affiché");
  assert.ok(v.textContent.includes("domine"));
  assert.equal(v.querySelectorAll("img").length, 0, "le verdict ne peut pas injecter de balise");
});

/* ------------------------------------------------------------ URL d'images */

test("imgURL n'accepte qu'une vraie URL d'image https", async () => {
  const { T } = await boot();
  // Ce que renvoie valorant-api.
  assert.equal(T.imgURL("https://media.valorant-api.com/maps/abc-123/splash.png"),
    "https://media.valorant-api.com/maps/abc-123/splash.png");
  // Tout ce qui pourrait sortir du url('…') d'une feuille de style.
  for (const bad of [
    "https://x.example/a.png');background:url('http://pisteur.example/x",
    'https://x.example/a.png");x:y',
    "https://x.example/a b.png",
    "javascript:alert(1)",
    "http://x.example/a.png",          // pas de https : page servie en https
    "//x.example/a.png",
    "", null, undefined, 42,
  ]) assert.equal(T.imgURL(bad), "", String(bad));
});

test("un fond de map douteux n'est pas rendu du tout", async () => {
  const { T, doc } = await boot();
  // esc() ne suffirait pas ici : le parseur HTML décode l'entité avant que CSS
  // ne lise la valeur, donc l'apostrophe ressortirait intacte dans url('…').
  T.setMaps({ ascent: "https://x.example/a.png');background:url('http://pisteur.example/x" });
  T.setMatches([game(1, true)]);
  T.renderList();
  assert.equal(doc.querySelectorAll("#ml .mbg").length, 0, "pas de fond plutôt qu'un fond piégé");

  // Contre-épreuve : une URL normale est bien affichée.
  T.setMaps({ ascent: "https://media.valorant-api.com/maps/abc/splash.png" });
  T.renderList();
  const bg = doc.querySelector("#ml .mbg");
  assert.ok(bg && bg.style.backgroundImage.includes("media.valorant-api.com"), "le vrai fond passe");
});
