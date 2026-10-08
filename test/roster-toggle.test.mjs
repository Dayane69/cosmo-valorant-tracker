// Éditeur de roster : passer un membre en invité (et inversement) d'un clic,
// sans rien perdre. On clique pour de vrai dans un DOM, puis on regarde ce qui
// partirait au serveur — et ce que le serveur en garde.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { cleanRoster } from "../netlify/functions/roster.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOMS = [];
after(async () => {
  await new Promise((r) => setTimeout(r, 120));
  DOMS.forEach((d) => { try { d.window.close(); } catch (e) {} });
});

async function boot(roster, guests) {
  const dom = new JSDOM(readFileSync(join(root, "index.html"), "utf8"),
    { runScripts: "outside-only", url: "https://cosmo-valo.netlify.app/" });
  DOMS.push(dom);
  const ctx = dom.getInternalVMContext();
  dom.window.scrollTo = () => {};
  ctx.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  vm.runInContext(readFileSync(join(root, "app.js"), "utf8") + `
    globalThis.__r = { renderRosterEditor, collectRoster,
      set: (r, g) => { ROSTER = r; GUESTS = g; } };`, ctx);
  await new Promise((r) => setTimeout(r, 0));
  const T = ctx.__r;
  T.set(roster, guests);
  T.renderRosterEditor();
  const doc = dom.window.document;
  // La ligne de l'éditeur dont le pseudo vaut `name`, dans la liste `listId`.
  const row = (listId, name) => [...doc.querySelectorAll(`#${listId} .edrow`)]
    .find((r) => (r.querySelector('[data-f="name"],[data-g="name"]') || {}).value === name);
  const click = (el) => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  // Copie vers ce realm : les objets viennent du contexte vm.
  const collect = () => JSON.parse(JSON.stringify(T.collectRoster()));
  return { doc, row, click, collect };
}

const YAK = { name: "Yakuza", tag: "2826", agent: "Cypher", role: "Sentinelle", color: "#9aa7b2",
  uuid: "117ed9e3", customImg: "https://exemple.org/y.gif", alias: ["Arsh26#2826"] };
const SEV = { name: "SevenDayy", tag: "6340", agent: "Brimstone", role: "Contrôleur", color: "#e07b2c" };

test("un clic passe un membre en invité, avec ce qui est tapé dans sa ligne", async () => {
  const { doc, row, click, collect } = await boot([YAK, SEV], []);
  // Une modif en cours dans la ligne doit suivre le déplacement.
  row("edMembers", "Yakuza").querySelector('[data-f="color"]').value = "#123456";
  click(row("edMembers", "Yakuza").querySelector(".edmove"));

  assert.equal(row("edMembers", "Yakuza"), undefined, "il a quitté la liste des membres");
  const g = row("edGuests", "Yakuza");
  assert.ok(g, "il est dans la liste des invités");
  assert.equal(g.querySelector('[data-g="tag"]').value, "2826");
  assert.equal(g.querySelector('[data-g="color"]').value, "#123456", "la couleur TAPÉE, pas celle chargée");
  assert.match(g.querySelector('[data-g="alias"]').value, /Arsh26#2826/, "les anciens pseudos suivent : sans eux, sa série RR serait perdue");
  assert.match(doc.getElementById("edStatus").textContent, /pas encore enregistré/, "on dit que rien n'est encore enregistré");

  const out = collect();
  assert.deepEqual(out.members.map((m) => m.name), ["SevenDayy"]);
  assert.equal(out.guests.length, 1);
  assert.equal(out.guests[0].agent, undefined, "un invité n'a toujours pas d'agent");
  assert.deepEqual(out.guests[0].was, { agent: "Cypher", role: "Sentinelle", uuid: "117ed9e3", customImg: "https://exemple.org/y.gif" },
    "ce qu'il avait comme membre est mis de côté, pas jeté");
});

test("aller-retour membre -> invité -> membre : rien n'est perdu", async () => {
  const { row, click, collect } = await boot([YAK, SEV], []);
  click(row("edMembers", "Yakuza").querySelector(".edmove"));
  click(row("edGuests", "Yakuza").querySelector(".edmove"));
  const back = row("edMembers", "Yakuza");
  assert.ok(back);
  assert.equal(back.querySelector('[data-f="agent"]').value, "Cypher");
  assert.equal(back.querySelector('[data-f="role"]').value, "Sentinelle");
  assert.equal(back.querySelector('[data-f="uuid"]').value, "117ed9e3");
  assert.equal(back.querySelector('[data-f="customImg"]').value, "https://exemple.org/y.gif");
  const out = collect();
  assert.equal(out.guests.length, 0);
  const y = out.members.find((m) => m.name === "Yakuza");
  assert.equal(y.agent, "Cypher");
  assert.deepEqual(y.alias, ["Arsh26#2826"]);
});

test("un ancien membre enregistré comme invité retrouve son agent en revenant", async () => {
  // Ce que le serveur a stocké lors d'un précédent passage en invité.
  const saved = cleanRoster({ members: [SEV], guests: [{ name: "Yakuza", tag: "2826", color: "#9aa7b2",
    was: { agent: "Cypher", role: "Sentinelle", uuid: "117ed9e3" } }] });
  const { row, click, collect } = await boot(saved.members, saved.guests);
  click(row("edGuests", "Yakuza").querySelector(".edmove"));
  assert.equal(row("edMembers", "Yakuza").querySelector('[data-f="agent"]').value, "Cypher");
  assert.equal(collect().members.find((m) => m.name === "Yakuza").role, "Sentinelle");
});

test("un invité qui n'a jamais été membre entre dans la squad sans agent inventé", async () => {
  const { row, click, collect } = await boot([SEV], [{ name: "Kevin", tag: "1234", color: "#c678dd" }]);
  click(row("edGuests", "Kevin").querySelector(".edmove"));
  const k = collect().members.find((m) => m.name === "Kevin");
  assert.ok(k);
  assert.equal(k.agent, "", "pas d'agent : on ne devine pas");
  assert.equal(k.color, "#c678dd");
});

test("serveur : un invité garde son passé de membre À PART, borné", () => {
  const saved = cleanRoster({ members: [SEV], guests: [{ name: "Yakuza", tag: "2826",
    was: { agent: "x".repeat(100), uuid: "u", pirate: "<script>", customImg: "https://a/b.gif" } }] });
  const g = saved.guests[0];
  assert.equal(g.agent, undefined, "pas d'agent au premier niveau : un invité n'a pas de carte");
  assert.equal(g.was.agent.length, 40, "mêmes bornes que pour un membre");
  assert.equal(g.was.pirate, undefined, "seuls les champs connus passent");
  assert.equal(cleanRoster({ members: [SEV], guests: [{ name: "K", tag: "1", was: "n'importe quoi" }] }).guests[0].was, undefined);
});

test("le passé de membre stocké dans la ligne est échappé", async () => {
  // Les DEUX guillemets : un attribut entre apostrophes résiste au double, pas à l'apostrophe.
  const XSS = `'"><img src=x onerror=BOOM>`;
  const { doc, row, click } = await boot([{ ...SEV, agent: XSS }], []);
  click(row("edMembers", "SevenDayy").querySelector(".edmove"));
  assert.equal(doc.querySelectorAll("#edGuests img").length, 0, "aucune balise injectée");
  click(row("edGuests", "SevenDayy").querySelector(".edmove"));
  assert.equal(row("edMembers", "SevenDayy").querySelector('[data-f="agent"]').value, XSS, "et la valeur revient intacte");
});
