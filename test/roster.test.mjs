// Tests de l'endpoint roster : lecture publique + écriture protégée par REFRESH_TOKEN.
import assert from "node:assert/strict";
import test from "node:test";
import handler from "../netlify/functions/roster.mjs";

const BASE = "https://cosmo-valo.netlify.app/.netlify/functions/roster";
const post = (url, body) => handler(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

test("GET renvoie un objet roster (null si rien de stocké / hors Netlify)", async () => {
  const res = await handler(new Request(BASE, { method: "GET" }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok("roster" in body, "la réponse contient une clé roster");
});

test("POST sans REFRESH_TOKEN configuré -> 500", async () => {
  delete process.env.REFRESH_TOKEN;
  const res = await post(`${BASE}?key=x`, { members: [{ name: "a", tag: "1" }] });
  assert.equal(res.status, 500);
});

test("POST avec mauvaise clé -> 401", async () => {
  process.env.REFRESH_TOKEN = "secret";
  const res = await post(`${BASE}?key=mauvaise`, { members: [{ name: "a", tag: "1" }] });
  assert.equal(res.status, 401);
  delete process.env.REFRESH_TOKEN;
});

test("POST bonne clé mais roster invalide -> 400 (avant tout accès Blob)", async () => {
  process.env.REFRESH_TOKEN = "secret";
  const res = await post(`${BASE}?key=secret`, { members: [{ name: "", tag: "" }] });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  delete process.env.REFRESH_TOKEN;
});

test("méthode non supportée -> 405", async () => {
  const res = await handler(new Request(BASE, { method: "PATCH" }));
  assert.equal(res.status, 405);
});
