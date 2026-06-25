// Tests de l'endpoint manuel refresh-now : on vérifie les barrières d'autorisation
// (qui s'exécutent AVANT tout accès à Netlify Blobs / réseau).
import assert from "node:assert/strict";
import test from "node:test";
import handler from "../netlify/functions/refresh-now.mjs";

const call = (url, headers = {}) => handler(new Request(url, { method: "POST", headers }));
const URL_BASE = "https://cosmo-valo.netlify.app/.netlify/functions/refresh-now";

test("500 si REFRESH_TOKEN n'est pas configuré", async () => {
  delete process.env.REFRESH_TOKEN;
  const res = await call(`${URL_BASE}?key=whatever`);
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("401 si la clé fournie est mauvaise", async () => {
  process.env.REFRESH_TOKEN = "secret";
  const res = await call(`${URL_BASE}?key=mauvaise`);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.ok, false);
  delete process.env.REFRESH_TOKEN;
});

test("bonne clé mais HENRIK_KEY manquante -> 500 (avant tout appel Blobs/réseau)", async () => {
  process.env.REFRESH_TOKEN = "secret";
  const savedHenrik = process.env.HENRIK_KEY;
  delete process.env.HENRIK_KEY;
  const res = await call(`${URL_BASE}?key=secret`);
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /HENRIK_KEY/);
  delete process.env.REFRESH_TOKEN;
  if (savedHenrik !== undefined) process.env.HENRIK_KEY = savedHenrik;
});

test("la clé peut aussi passer par l'en-tête x-refresh-token", async () => {
  process.env.REFRESH_TOKEN = "secret";
  delete process.env.HENRIK_KEY;
  const res = await call(URL_BASE, { "x-refresh-token": "secret" });
  // autorisé (pas de 401) mais bloqué ensuite sur HENRIK_KEY manquante
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /HENRIK_KEY/);
  delete process.env.REFRESH_TOKEN;
});
