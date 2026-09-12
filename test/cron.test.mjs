// Test de la fonction planifiée : mock de Netlify Blobs en mémoire + fetch simulé.
// Vérifie que deux exécutions successives sur les mêmes données ne dupliquent rien.
import assert from "node:assert/strict";
import test from "node:test";
import { runRefresh, refreshOne, refreshMember, mergeStored, mergeRR, normRRentry, matchID, matchTime, blobKey, rotateFrom } from "../netlify/functions/lib/refresh-core.mjs";

// --- Mock Netlify Blobs (clé -> valeur JSON, en mémoire) ---
function memoryStores() {
  const stores = new Map();
  const getStore = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      async get(key, _opts) { return m.has(key) ? m.get(key) : null; },
      async setJSON(key, val) { m.set(key, val); },
    };
  };
  return { getStore, stores };
}

// --- Mock fetch HenrikDev : matches v4 (noop) + stored-matches + mmr-history ---
function makeFetch(storedByPlayer, rrByPlayer = {}) {
  return async (url) => {
    if (url.includes("/valorant/v4/matches/")) {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    if (url.includes("/valorant/v1/stored-matches/")) {
      // Retrouve le joueur dans l'URL .../stored-matches/{region}/{name}/{tag}
      const parts = url.split("/stored-matches/")[1].split("?")[0].split("/");
      const name = decodeURIComponent(parts[1]).toLowerCase();
      const data = storedByPlayer[name] || [];
      return { ok: true, status: 200, json: async () => ({ data }) };
    }
    if (url.includes("/valorant/v2/mmr-history/")) {
      const parts = url.split("/mmr-history/")[1].split("?")[0].split("/");
      const name = decodeURIComponent(parts[2]).toLowerCase();
      return { ok: true, status: 200, json: async () => ({ data: { history: rrByPlayer[name] || [] } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

const mkMatch = (id, iso) => ({ metadata: { match_id: id, started_at: iso } });

test("deux exécutions du cron ne dupliquent rien dans le blob", async () => {
  const roster = [{ name: "Arsh26", tag: "2826" }];
  const stored = {
    arsh26: [
      mkMatch("m1", "2026-06-20T10:00:00Z"),
      mkMatch("m2", "2026-06-21T10:00:00Z"),
    ],
  };
  const { getStore, stores } = memoryStores();
  const fetchImpl = makeFetch(stored);
  const deps = { roster, region: "eu", getStore, fetchImpl, apiKey: "FAKE", log: { log() {}, error() {} }, delayMs: 0 };

  const r1 = await runRefresh(deps);
  assert.equal(r1.ok, 1);
  assert.equal(r1.fail, 0);

  const key = blobKey("Arsh26", "2826");
  const after1 = stores.get("cosmo-history").get(key);
  assert.equal(after1.length, 2, "premier run : 2 matchs stockés");

  // Deuxième run, mêmes données stored -> aucun nouveau match
  const r2 = await runRefresh(deps);
  assert.equal(r2.added, 0, "deuxième run : 0 ajout");
  const after2 = stores.get("cosmo-history").get(key);
  assert.equal(after2.length, 2, "toujours 2 matchs (pas de doublon)");
});

test("un nouveau match est ajouté sans toucher aux existants", async () => {
  const roster = [{ name: "Arsh26", tag: "2826" }];
  const stored = { arsh26: [mkMatch("m1", "2026-06-20T10:00:00Z")] };
  const { getStore, stores } = memoryStores();
  const deps = { roster, region: "eu", getStore, fetchImpl: makeFetch(stored), apiKey: "FAKE", log: { log() {}, error() {} }, delayMs: 0 };

  await runRefresh(deps);
  // HenrikDev stocke une nouvelle partie entre deux jours
  stored.arsh26.push(mkMatch("m2", "2026-06-22T10:00:00Z"));
  const r2 = await runRefresh(deps);
  assert.equal(r2.added, 1);
  const key = blobKey("Arsh26", "2826");
  assert.equal(stores.get("cosmo-history").get(key).length, 2);
});

test("refreshOne avec trigger:false n'appelle pas matches v4 (économise une requête)", async () => {
  const stored = { arsh26: [mkMatch("m1", "2026-06-20T10:00:00Z")] };
  let v4Calls = 0, storedCalls = 0, mmrCalls = 0;
  const fetchImpl = async (url) => {
    if (url.includes("/valorant/v4/matches/")) { v4Calls++; return { ok: true, status: 200, json: async () => ({ data: [] }) }; }
    if (url.includes("/valorant/v2/mmr-history/")) { mmrCalls++; return { ok: true, status: 200, json: async () => ({ data: { history: [] } }) }; }
    storedCalls++;
    const parts = url.split("/stored-matches/")[1].split("?")[0].split("/");
    const name = decodeURIComponent(parts[1]).toLowerCase();
    return { ok: true, status: 200, json: async () => ({ data: stored[name] || [] }) };
  };
  const { getStore, stores } = memoryStores();
  const res = await refreshOne({ member: { name: "Arsh26", tag: "2826" }, getStore, fetchImpl, apiKey: "FAKE", region: "eu", trigger: false });
  assert.equal(v4Calls, 0, "aucun appel matches v4");
  assert.equal(storedCalls, 1, "un seul appel stored-matches");
  assert.equal(mmrCalls, 1, "un appel mmr-history (accumulation RR)");
  assert.equal(res.total, 1);
  assert.equal(stores.get("cosmo-history").get(blobKey("Arsh26", "2826")).length, 1);
});

test("matchID / matchTime gèrent le format stored-matches v1 (meta + game_start)", () => {
  const v1 = { meta: { id: "abc", game_start: 1718000000 } }; // epoch en secondes
  assert.equal(matchID(v1), "abc");
  assert.equal(matchTime(v1), 1718000000 * 1000);
  // epoch déjà en millisecondes : conservé tel quel
  assert.equal(matchTime({ meta: { game_start: 1718000000000 } }), 1718000000000);
  // ISO classique
  assert.equal(matchTime({ metadata: { started_at: "2026-06-20T10:00:00Z" } }), Date.parse("2026-06-20T10:00:00Z"));
});

test("l'historique RR s'accumule dans le blob cosmo-rr, dédoublonné et chronologique", async () => {
  const roster = [{ name: "Arsh26", tag: "2826" }];
  const stored = { arsh26: [mkMatch("m1", "2026-06-20T10:00:00Z")] };
  const rr = { arsh26: [
    { match_id: "m1", elo: 1342, ranking_in_tier: 42, last_change: 18, tier: { id: 13, name: "Gold 2" }, date: "2026-06-20T10:00:00Z" },
    { match_id: "m2", elo: 1324, ranking_in_tier: 24, last_change: -18, tier: { id: 13, name: "Gold 2" }, date: "2026-06-21T10:00:00Z" },
  ] };
  const { getStore, stores } = memoryStores();
  const deps = { roster, region: "eu", getStore, fetchImpl: makeFetch(stored, rr), apiKey: "FAKE", log: { log() {}, error() {} }, delayMs: 0 };

  await runRefresh(deps);
  const rrBlob = stores.get("cosmo-rr").get(blobKey("Arsh26", "2826"));
  assert.equal(rrBlob.length, 2, "2 points RR stockés");
  assert.equal(rrBlob[0].elo, 1342, "trié du plus ancien au plus récent");
  assert.equal(rrBlob[0].tier.name, "Gold 2");

  await runRefresh(deps); // deuxième passage : rien de neuf
  assert.equal(stores.get("cosmo-rr").get(blobKey("Arsh26", "2826")).length, 2, "pas de doublon RR");
});

test("mergeRR : dédoublonne par match_id et trie chronologiquement", () => {
  const a = normRRentry({ match_id: "a", elo: 100, date: "2026-06-20T10:00:00Z" });
  const a2 = normRRentry({ match_id: "a", elo: 100, date: "2026-06-20T10:00:00Z" });
  const b = normRRentry({ match_id: "b", elo: 120, date: "2026-06-25T10:00:00Z" });
  const merged = mergeRR([a], [b, a2]);
  assert.equal(merged.length, 2, "le doublon 'a' n'apparaît qu'une fois");
  assert.equal(merged[merged.length - 1].id, "b", "le plus récent en dernier (chronologique)");
});

test("mergeStored : dédoublonnage par matchid + tri décroissant", () => {
  const existing = [mkMatch("a", "2026-06-20T10:00:00Z")];
  const fresh = [mkMatch("a", "2026-06-20T10:00:00Z"), mkMatch("b", "2026-06-25T10:00:00Z")];
  const merged = mergeStored(existing, fresh);
  assert.equal(merged.length, 2, "le doublon 'a' n'apparaît qu'une fois");
  assert.equal(merged[0].metadata.match_id, "b", "le plus récent en premier");
});

test("refreshMember réessaie après un 429 puis réussit", async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    if (url.includes("/stored-matches/")) {
      calls++;
      if (calls === 1) return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ data: [mkMatch("a", "2026-06-20T10:00:00Z")] }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  };
  const data = await refreshMember({ name: "x", tag: "1" }, { fetchImpl, apiKey: "K", region: "eu", trigger: false, sleep: async () => {}, retries: 2 });
  assert.equal(calls, 2, "un retry après le 429");
  assert.equal(data.length, 1);
});

test("un membre en échec API ne fait pas planter la boucle", async () => {
  const roster = [{ name: "ok", tag: "1" }, { name: "ko", tag: "2" }];
  const stored = { ok: [mkMatch("x", "2026-06-20T10:00:00Z")] }; // 'ko' absent -> []
  const fetchImpl = async (url) => {
    if (url.includes("/ko/") || url.includes("/ko?")) return { ok: false, status: 500, json: async () => ({}) };
    if (url.includes("/valorant/v4/matches/")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    const parts = url.split("/stored-matches/")[1].split("?")[0].split("/");
    const name = decodeURIComponent(parts[1]).toLowerCase();
    return { ok: true, status: 200, json: async () => ({ data: stored[name] || [] }) };
  };
  const { getStore } = memoryStores();
  const res = await runRefresh({ roster, region: "eu", getStore, fetchImpl, apiKey: "FAKE", log: { log() {}, error() {} }, delayMs: 0 });
  assert.equal(res.ok, 1);
  assert.equal(res.fail, 1);
});

/* ===================== PASSAGE HORAIRE : BUDGET ET RELAIS =====================
   Le cron tourne maintenant chaque heure. Une fonction Netlify est coupée net à
   10 s, et un passage complet du roster est pile sur le fil : chaque exécution
   travaille donc sous un budget et annonce où reprendre. Ce qui est vérifié ici,
   c'est qu'aucun membre ne peut être affamé, quel que soit le budget. */

const squad = (n) => Array.from({ length: n }, (_, i) => ({ name: `J${i + 1}`, tag: "0001" }));

// Horloge simulée : chaque membre traité fait avancer le temps de `perMember`.
// Aucune attente réelle, donc les tests restent instantanés.
function fakeClock(perMember) {
  let t = 0;
  return { now: () => t, tick: () => { t += perMember; } };
}

function budgetDeps(members, clock, budgetMs) {
  const { getStore, stores } = memoryStores();
  const base = makeFetch({});
  return {
    stores,
    deps: {
      roster: members, region: "eu", getStore, apiKey: "FAKE",
      log: { log() {}, error() {} }, delayMs: 0, budgetMs, now: clock.now,
      // Le temps avance à chaque appel stored-matches, soit une fois par membre.
      fetchImpl: async (url) => { if (url.includes("/stored-matches/")) clock.tick(); return base(url); },
    },
  };
}

test("le budget arrête la boucle proprement et annonce le membre suivant", async () => {
  const members = squad(8);
  const clock = fakeClock(1000);                 // 1 s par membre
  const { deps } = budgetDeps(members, clock, 3500);
  const res = await runRefresh(deps);

  assert.equal(res.done, 4, "quatre membres tiennent dans 3,5 s");
  assert.equal(res.remaining, 4);
  assert.equal(res.next, blobKey("J5", "0001"), "on dit où reprendre");
});

test("un budget ridicule fait quand même avancer d'un membre", async () => {
  // Sinon un budget trop serré bloquerait le roster pour toujours.
  const clock = fakeClock(5000);
  const { deps } = budgetDeps(squad(8), clock, 1);
  const res = await runRefresh(deps);
  assert.equal(res.done, 1);
  assert.equal(res.next, blobKey("J2", "0001"));
});

test("sans budget, tout le roster passe et il n'y a pas de suite", async () => {
  const clock = fakeClock(1000);
  const { deps } = budgetDeps(squad(8), clock, 0);
  const res = await runRefresh(deps);
  assert.equal(res.done, 8);
  assert.equal(res.remaining, 0);
  assert.equal(res.next, null, "roster complet : la prochaine repart du début");
});

test("de passage en passage, tout le monde est servi exactement une fois", async () => {
  const members = squad(8);
  let cursor = null;
  const vus = [];

  // Trois passages de 3,5 s : 4 + 4 membres, puis retour au début.
  for (let run = 0; run < 3; run++) {
    const clock = fakeClock(1000);
    const ordered = rotateFrom(members, cursor);
    const { deps } = budgetDeps(ordered, clock, 3500);
    const res = await runRefresh(deps);
    vus.push(...ordered.slice(0, res.done).map((m) => m.name));
    cursor = res.next;
  }

  assert.deepEqual(vus.slice(0, 8), ["J1", "J2", "J3", "J4", "J5", "J6", "J7", "J8"],
    "le tour complet se fait sans sauter ni répéter personne");
  assert.equal(vus[8], "J1", "puis on recommence par le début");
});

test("rotateFrom : reprend au bon membre, et pardonne un curseur périmé", () => {
  const members = squad(4);
  assert.deepEqual(rotateFrom(members, blobKey("J3", "0001")).map((m) => m.name), ["J3", "J4", "J1", "J2"]);
  // Curseur absent, vide, ou pointant sur un membre retiré du roster : on
  // repart du début plutôt que de ne rien rafraîchir du tout.
  for (const c of [null, "", blobKey("Parti", "9999")]) {
    assert.deepEqual(rotateFrom(members, c).map((m) => m.name), ["J1", "J2", "J3", "J4"], String(c));
  }
  assert.deepEqual(rotateFrom(null, "x"), []);
});
