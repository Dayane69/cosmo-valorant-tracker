// Test de la fonction planifiée : mock de Netlify Blobs en mémoire + fetch simulé.
// Vérifie que deux exécutions successives sur les mêmes données ne dupliquent rien.
import assert from "node:assert/strict";
import test from "node:test";
import { runRefresh, mergeStored, blobKey } from "../netlify/functions/lib/refresh-core.mjs";

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

// --- Mock fetch HenrikDev : matches v4 (noop) + stored-matches (données fixes) ---
function makeFetch(storedByPlayer) {
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

test("mergeStored : dédoublonnage par matchid + tri décroissant", () => {
  const existing = [mkMatch("a", "2026-06-20T10:00:00Z")];
  const fresh = [mkMatch("a", "2026-06-20T10:00:00Z"), mkMatch("b", "2026-06-25T10:00:00Z")];
  const merged = mergeStored(existing, fresh);
  assert.equal(merged.length, 2, "le doublon 'a' n'apparaît qu'une fois");
  assert.equal(merged[0].metadata.match_id, "b", "le plus récent en premier");
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
