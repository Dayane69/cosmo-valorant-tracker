// Tests des « anciens pseudos » : les blobs (historique ET progression RR) sont
// indexés par pseudo#tag, donc un renommage Riot orpheline les données. Les
// alias servent de pont pour les relire et les fusionner.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { cleanAlias } from "../netlify/functions/roster.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function load() {
  const ctx = vm.createContext({ console, fetch: async () => ({ ok: false }) });
  let code = readFileSync(join(root, "app.js"), "utf8");
  code += `\nglobalThis.__x = { memberAliases, memberIdentities, memberKey,
    setFetch: f => { globalThis.fetch = f; },
    fetchHistoriqueAll, fetchRRHistoryAll, combineMatches, mergeRRclient };`;
  vm.runInContext(code, ctx);
  return ctx.__x;
}
const X = load();

/* ------------------------------------------------------------- analyse côté client */

test("un alias se lit en tableau ou en chaîne séparée par des virgules", () => {
  const m = { name: "Yakuza", tag: "2826" };
  assert.equal(
    X.memberAliases({ ...m, alias: ["Arsh26#2826"] }).map(a => a.name + "#" + a.tag).join(","),
    "Arsh26#2826");
  assert.equal(
    X.memberAliases({ ...m, alias: "Arsh26#2826, VieuxNom#1111" }).map(a => a.name + "#" + a.tag).join(","),
    "Arsh26#2826,VieuxNom#1111");
});

test("le pseudo ACTUEL n'est jamais compté comme alias (pas de double lecture)", () => {
  const a = X.memberAliases({ name: "Yakuza", tag: "2826", alias: ["Yakuza#2826", "yakuza#2826", "Arsh26#2826"] });
  assert.equal(a.length, 1);
  assert.equal(a[0].name, "Arsh26");
});

test("les entrées mal formées sont ignorées, pas devinées", () => {
  const bad = X.memberAliases({ name: "A", tag: "1",
    alias: ["", "  ", "SansTag", "#sansnom", "trop#", null, undefined, 42] });
  assert.equal(bad.length, 0, "aucun alias inventé à partir d'une saisie incomplète");
});

test("un tag peut contenir un # : on découpe sur le DERNIER", () => {
  const a = X.memberAliases({ name: "X", tag: "1", alias: ["Mon#Pseudo#2826"] });
  assert.equal(a[0].name, "Mon#Pseudo");
  assert.equal(a[0].tag, "2826");
});

test("les doublons sont écartés et le nombre d'alias est plafonné", () => {
  const dup = X.memberAliases({ name: "X", tag: "1", alias: ["A#1", "a#1", "A#1"] });
  assert.equal(dup.length, 1);
  const many = X.memberAliases({ name: "X", tag: "1",
    alias: ["A#1", "B#2", "C#3", "D#4", "E#5", "F#6", "G#7"] });
  assert.equal(many.length, 5);
});

test("sans alias, on ne cherche que sous l'identité courante", () => {
  const ids = X.memberIdentities({ name: "Yakuza", tag: "2826" });
  assert.equal(ids.length, 1);
  assert.equal(ids[0].name, "Yakuza");
});

test("avec alias, l'identité courante reste en PREMIER (elle a priorité au dédoublonnage)", () => {
  const ids = X.memberIdentities({ name: "Yakuza", tag: "2826", alias: ["Arsh26#2826"] });
  assert.equal(ids.map(i => i.name).join(","), "Yakuza,Arsh26");
});

/* ------------------------------------------------- fusion effective des deux blobs */

// Bouchon : renvoie l'historique / la série RR selon le pseudo interrogé.
function stubFetch(byName) {
  X.setFetch(async (url) => {
    const u = new URL(url, "http://x");
    const name = (u.searchParams.get("name") || "").toLowerCase();
    const kind = u.searchParams.get("kind") === "rr" ? "rr" : "matches";
    const data = (byName[name] || {})[kind] || [];
    return { ok: true, json: async () => data };
  });
}

const m = (id, ts) => ({ meta: { id, started_at: new Date(ts).toISOString() } });
const rr = (id, ts, elo) => ({ id, elo, rr: 50, change: 20, tier: { id: 12, name: "Gold 1" }, ts });

test("l'historique de l'ancien pseudo est fusionné avec le nouveau", async () => {
  stubFetch({
    yakuza: { matches: [m("new-1", 3000), m("new-2", 4000)] },
    arsh26: { matches: [m("old-1", 1000), m("old-2", 2000)] },
  });
  const out = await X.fetchHistoriqueAll({ name: "Yakuza", tag: "2826", alias: ["Arsh26#2826"] });
  assert.equal(out.length, 4, "les deux blobs sont réunis");
  assert.equal(out[0].meta.id, "new-2", "trié du plus récent au plus ancien");
  assert.equal(out[3].meta.id, "old-1");
});

test("une partie présente des deux côtés n'est comptée qu'une fois", async () => {
  stubFetch({
    yakuza: { matches: [m("commun", 5000), m("new-1", 4000)] },
    arsh26: { matches: [m("commun", 5000), m("old-1", 1000)] },
  });
  const out = await X.fetchHistoriqueAll({ name: "Yakuza", tag: "2826", alias: ["Arsh26#2826"] });
  assert.equal(out.length, 3);
  assert.equal(out.filter(x => x.meta.id === "commun").length, 1);
});

test("la progression RR d'avant le renommage est bien récupérée", async () => {
  // Le cas réel : le blob du nouveau pseudo est VIDE, tout est sous l'ancien.
  stubFetch({
    yakuza: { rr: [] },
    arsh26: { rr: [rr("a", 1000, 900), rr("b", 2000, 930), rr("c", 3000, 963)] },
  });
  const out = await X.fetchRRHistoryAll({ name: "Yakuza", tag: "2826", alias: ["Arsh26#2826"] });
  assert.equal(out.length, 3, "la série orpheline est récupérée");
  assert.equal(out.map(e => e.elo).join(","), "900,930,963", "et reste triée chronologiquement");
});

test("les deux séries RR se recollent bout à bout, sans doublon", async () => {
  stubFetch({
    yakuza: { rr: [rr("c", 3000, 963), rr("d", 4000, 990)] },
    arsh26: { rr: [rr("a", 1000, 900), rr("b", 2000, 930), rr("c", 3000, 963)] },
  });
  const out = await X.fetchRRHistoryAll({ name: "Yakuza", tag: "2826", alias: ["Arsh26#2826"] });
  assert.equal(out.length, 4);
  assert.equal(out.map(e => e.elo).join(","), "900,930,963,990");
});

test("un blob d'alias en erreur ne fait pas perdre les données du pseudo courant", async () => {
  X.setFetch(async (url) => {
    const name = (new URL(url, "http://x").searchParams.get("name") || "").toLowerCase();
    if (name === "arsh26") throw new Error("réseau");
    return { ok: true, json: async () => [m("new-1", 4000)] };
  });
  const out = await X.fetchHistoriqueAll({ name: "Yakuza", tag: "2826", alias: ["Arsh26#2826"] });
  assert.equal(out.length, 1, "l'échec d'un alias est absorbé");
});

/* ------------------------------------------------------- assainissement serveur */

test("le serveur normalise et plafonne les alias reçus", () => {
  assert.deepEqual(cleanAlias(["Arsh26#2826"], "yakuza#2826"), ["Arsh26#2826"]);
  assert.deepEqual(cleanAlias("Arsh26#2826, Autre#1", "yakuza#2826"), ["Arsh26#2826", "Autre#1"]);
  assert.deepEqual(cleanAlias(["Yakuza#2826"], "yakuza#2826"), [], "le pseudo courant est rejeté");
  assert.deepEqual(cleanAlias(["pasdetag", "#pasdenom", ""], "x#1"), []);
  assert.equal(cleanAlias(["A#1", "B#2", "C#3", "D#4", "E#5", "F#6"], "x#1").length, 5);
  assert.deepEqual(cleanAlias(undefined, "x#1"), []);
  assert.deepEqual(cleanAlias({ bidon: true }, "x#1"), [], "un type inattendu ne casse rien");
});

test("un alias hors des limites Riot est rejeté, pas tronqué", () => {
  // Tronquer produirait une clé de blob qui n'existe pas : on préfère refuser.
  assert.deepEqual(cleanAlias(["A".repeat(200) + "#1"], "x#1"), []);
  assert.deepEqual(cleanAlias(["Nom#" + "t".repeat(40)], "x#1"), []);
  assert.deepEqual(cleanAlias(["Arsh26#2826"], "x#1"), ["Arsh26#2826"], "un alias normal passe");
});

/* ------------------------------------------------------------------ roster seed */

test("roster.json porte l'alias du membre renommé", () => {
  const r = JSON.parse(readFileSync(join(root, "roster.json"), "utf8"));
  const yak = r.members.find(x => x.name === "Yakuza");
  assert.ok(yak, "Yakuza est bien dans le roster de départ");
  assert.deepEqual(yak.alias, ["Arsh26#2826"]);
});
