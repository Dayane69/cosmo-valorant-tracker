// Le roster vu du serveur : blob d'abord, roster.json en repli.
//
// Le défaut corrigé ici : le site lisait le roster stocké (éditable dans
// ⚙ Paramètres) pendant que le cron et save-history lisaient roster.json en
// dur. Un membre ajouté ou renommé depuis l'interface n'était donc jamais
// rafraîchi, et l'ouverture de son profil recevait un 403 « joueur hors
// roster » — alors que l'éditeur annonçait que ses modifs remplaçaient
// roster.json.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadRoster, findMember } from "../netlify/functions/lib/roster-source.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const seed = JSON.parse(readFileSync(join(root, "roster.json"), "utf8"));
const seedMembers = seed.members || seed;

// getStore injecté, comme dans refresh-core : la logique est testable hors Netlify.
const storeWith = (doc) => () => ({ get: async () => doc });
const storeThatFails = () => { throw new Error("Blobs indisponible"); };

const BLOB = {
  region: "ap",
  members: [
    { name: "NouveauMembre", tag: "1234" },
    { name: "Renommé", tag: "9999", alias: ["Ancien#0000"] },
  ],
};

test("le roster stocké l'emporte sur roster.json", async () => {
  const r = await loadRoster(storeWith(BLOB));
  assert.equal(r.source, "blob");
  assert.deepEqual(r.members.map((m) => m.name), ["NouveauMembre", "Renommé"]);
  assert.equal(r.region, "ap");
});

test("LE cas qui était cassé : un membre présent seulement dans le blob est reconnu", async () => {
  const r = await loadRoster(storeWith(BLOB));
  // Ce que fait save-history avant d'accepter d'enregistrer un historique.
  assert.ok(findMember(r.members, "NouveauMembre", "1234"), "sinon : 403 joueur hors roster");
  // Et il n'est bien pas dans le fichier versionné : c'est tout le sujet.
  assert.equal(findMember(seedMembers, "NouveauMembre", "1234"), null);
});

test("sans blob, roster.json prend le relais", async () => {
  for (const store of [storeWith(null), storeWith({ members: [] }), storeWith({}), storeThatFails]) {
    const r = await loadRoster(store);
    assert.equal(r.source, "seed");
    assert.equal(r.members.length, seedMembers.length);
  }
});

test("un blob vide ne fait pas rafraîchir personne", async () => {
  // Un roster réinitialisé ne doit pas se traduire par un cron qui ne visite
  // plus aucun membre : mieux vaut le seed que rien.
  const r = await loadRoster(storeWith({ members: [] }));
  assert.ok(r.members.length > 0);
});

test("la région suit le roster stocké, avec roster.json en repli", async () => {
  assert.equal((await loadRoster(storeWith(BLOB))).region, "ap");
  assert.equal((await loadRoster(storeWith({ members: [{ name: "A", tag: "1" }] }))).region, seed.region || "eu");
});

test("roster.json peut être un simple tableau (forme historique)", async () => {
  const r = await loadRoster(storeWith([{ name: "EnTableau", tag: "1" }]));
  assert.equal(r.source, "blob");
  assert.equal(r.members[0].name, "EnTableau");
});

/* ------------------------------------------------------- recherche d'un membre */

test("la recherche ignore la casse", () => {
  const m = seedMembers[0];
  assert.ok(findMember(seedMembers, m.name.toUpperCase(), String(m.tag).toLowerCase()));
});

test("un pseudo sans tag, ou inconnu, ne trouve personne", () => {
  const m = seedMembers[0];
  assert.equal(findMember(seedMembers, m.name, ""), null);
  assert.equal(findMember(seedMembers, "", "2826"), null);
  assert.equal(findMember(seedMembers, "RandomSmurf", "ZZZZ"), null);
});

test("les invités ne sont pas des membres : ils restent hors du cron", async () => {
  const r = await loadRoster(storeWith({
    members: [{ name: "Membre", tag: "1" }],
    guests: [{ name: "Invité", tag: "2" }],
  }));
  assert.equal(findMember(r.members, "Invité", "2"), null);
  assert.equal(r.members.length, 1);
});
