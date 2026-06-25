// Tests des barrières de l'endpoint save-history (s'exécutent avant tout accès
// Blobs / réseau) : HENRIK_KEY manquante, et joueur hors roster.
import assert from "node:assert/strict";
import test from "node:test";
import handler from "../netlify/functions/save-history.mjs";

const call = (url) => handler(new Request(url, { method: "POST" }));
const BASE = "https://cosmo-valo.netlify.app/.netlify/functions/save-history";

test("500 si HENRIK_KEY manquante", async () => {
  const saved = process.env.HENRIK_KEY;
  delete process.env.HENRIK_KEY;
  const res = await call(`${BASE}?name=Arsh26&tag=2826`);
  assert.equal(res.status, 500);
  if (saved !== undefined) process.env.HENRIK_KEY = saved;
});

test("403 si le joueur n'est pas dans le roster", async () => {
  process.env.HENRIK_KEY = "FAKE";
  const res = await call(`${BASE}?name=Inconnu&tag=0000`);
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.ok, false);
  delete process.env.HENRIK_KEY;
});

test("403 protège contre un compte au hasard même avec une clé valide", async () => {
  process.env.HENRIK_KEY = "FAKE";
  const res = await call(`${BASE}?name=RandomSmurf&tag=ZZZZ`);
  assert.equal(res.status, 403);
  delete process.env.HENRIK_KEY;
});
