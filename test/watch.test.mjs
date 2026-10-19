// Mise à jour automatique toutes les 5 minutes (refresh-matches + watchRefresh).
// Le problème réglé : une fois par heure, 2 ou 3 joueurs par passage, il
// fallait jusqu'à 3 h pour que tout le roster soit à jour.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { v4ToCompact, watchRefresh, refreshOne, blobKey } from "../netlify/functions/lib/refresh-core.mjs";
import { isCompsRun } from "../netlify/functions/refresh-matches.mjs";

// Deux vraies parties de SevenDayy (19 octobre), autres joueurs anonymisés :
// une classée (perdue 9-13 sur Sunset) et un deathmatch.
const V4 = JSON.parse(readFileSync(new URL("./fixtures-v4-sevendayy.json", import.meta.url), "utf8"));
const SEVEN = { name: "SevenDayy", tag: "6340" };

function memoryStores(seed = {}) {
  const stores = new Map();
  const getStore = (name) => {
    if (!stores.has(name)) stores.set(name, new Map(Object.entries(seed[name] || {})));
    const m = stores.get(name);
    return { async get(k) { return m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : null; }, async setJSON(k, v) { m.set(k, v); } };
  };
  return { getStore, stores };
}
// Faux HenrikDev : compte les appels par type.
function henrik({ rrBy = {}, v4By = {}, storedBy = {} } = {}) {
  const calls = { rr: 0, v4: 0, stored: 0, who: [] };
  const who = (url, seg) => decodeURIComponent(url.split(seg)[1].split("?")[0].split("/").slice(-2)[0]).toLowerCase();
  const fetchImpl = async (url) => {
    const ok = (o) => ({ ok: true, status: 200, json: async () => o });
    if (url.includes("/v2/mmr-history/")) { calls.rr++; return ok({ data: { history: rrBy[who(url, "/mmr-history/")] || [] } }); }
    if (url.includes("/v4/matches/")) { calls.v4++; calls.who.push(who(url, "/v4/matches/")); return ok({ data: v4By[who(url, "/v4/matches/")] || [] }); }
    if (url.includes("/v1/stored-matches/")) { calls.stored++; return ok({ data: storedBy[who(url, "/stored-matches/")] || [] }); }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchImpl, calls };
}
const quiet = { log() {}, error() {} };
const ROSTER = ["SevenDayy#6340", "Gogemine#0202", "Yakuza#2826", "joker#prft9"].map((s) => ({ name: s.split("#")[0], tag: s.split("#")[1] }));
const rrEntry = (id, iso, change) => ({ match_id: id, date: iso, last_change: change, elo: 1200, ranking_in_tier: 0, tier: { id: 15, name: "Platinum 1" } });

test("v4ToCompact : la partie classée au format de l'historique stocké", () => {
  const c = v4ToCompact(V4[0], SEVEN);
  assert.equal(c.meta.id.slice(0, 8), "f5157616");
  assert.equal(c.meta.mode, "Competitive");
  assert.equal(c.meta.map.name, "Sunset");
  assert.equal(c.meta.season.short, "e11a6");
  assert.equal(c.stats.team, "Red");
  assert.equal(c.stats.character.name, "Brimstone");
  assert.deepEqual({ ...c.stats.shots }, { head: 5, body: 35, leg: 4 });
  assert.deepEqual({ ...c.stats.damage }, { made: 2463, received: 3402 });
  assert.deepEqual({ ...c.teams }, { red: 9, blue: 13 }, "perdue 9-13");
  assert.equal(v4ToCompact(V4[0], { name: "Personne", tag: "1" }), null, "joueur absent : rien d'inventé");
});

test("v4ToCompact : le deathmatch garde son mode (le site le classe en chacun pour soi)", () => {
  const c = v4ToCompact(V4[1], SEVEN);
  assert.equal(c.meta.mode, "Deathmatch");
  assert.deepEqual({ ...c.teams }, { red: 0, blue: 0 });
});

test("surveillance au calme : un petit appel par joueur, un seul tour complet", async () => {
  const known = [rrEntry("old", "2026-10-18T20:00:00Z", 10)];
  const S = memoryStores();
  for (const m of ROSTER) await S.getStore("cosmo-rr").setJSON(blobKey(m.name, m.tag), [{ id: "old", ts: Date.parse("2026-10-18T20:00:00Z"), change: 10 }]);
  const H = henrik({ rrBy: Object.fromEntries(ROSTER.map((m) => [m.name.toLowerCase(), known])) });
  const r = await watchRefresh({ roster: ROSTER, getStore: S.getStore, fetchImpl: H.fetchImpl, apiKey: "k", log: quiet });
  assert.equal(r.checked, 4);
  assert.deepEqual([...r.played], [], "personne ne sort de partie");
  assert.equal(H.calls.v4, 1, "seulement le tour complet");
  assert.equal(r.swept, "sevendayy#6340");
  assert.equal(r.nextSweep, "gogemine#0202");
  assert.ok(H.calls.rr + H.calls.v4 + H.calls.stored <= 4 + 3, "≤ 7 appels au calme");
});

test("un joueur sort de partie : sa partie est dans l'historique au passage suivant (5 min)", async () => {
  const S = memoryStores();
  const H = henrik({
    rrBy: { sevendayy: [rrEntry("f5157616-new", "2026-10-19T09:57:13Z", -21)] },
    v4By: { sevendayy: V4 },
  });
  // stored-matches (HenrikDev) n'a PAS encore la partie : c'était le retard.
  const r = await watchRefresh({ roster: ROSTER, getStore: S.getStore, fetchImpl: H.fetchImpl, apiKey: "k", sweepKey: "yakuza#2826", log: quiet });
  assert.deepEqual([...r.played], ["sevendayy#6340"]);
  const hist = await S.getStore("cosmo-history").get("sevendayy#6340");
  assert.ok(hist.some((e) => e.meta.id.startsWith("f5157616")), "la partie classée de 11 h 57 est là");
  assert.ok(hist.some((e) => e.meta.mode === "Deathmatch"));
  const rr = await S.getStore("cosmo-rr").get("sevendayy#6340");
  assert.ok(rr.some((e) => e.id === "f5157616-new"), "et son RR");
  assert.equal(r.swept, "yakuza#2826", "le tour complet suit son cours");
  assert.ok(H.calls.v4 <= 2, "SevenDayy + le tour complet, pas tout le roster");
});

test("refreshOne garde les parties de matches v4 que stored-matches n'a pas encore", async () => {
  const S = memoryStores();
  const H = henrik({ v4By: { sevendayy: V4 }, storedBy: { sevendayy: [] } });
  await refreshOne({ member: SEVEN, getStore: S.getStore, fetchImpl: H.fetchImpl, apiKey: "k" });
  const hist = await S.getStore("cosmo-history").get("sevendayy#6340");
  assert.equal(hist.length, 2);
});

test("un joueur en panne n'arrête ni la surveillance ni le tour", async () => {
  const S = memoryStores();
  const H = henrik({});
  const fetchImpl = async (url, o) => (url.includes("/Gogemine/") ? { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) } : H.fetchImpl(url, o));
  const r = await watchRefresh({ roster: ROSTER, getStore: S.getStore, fetchImpl, apiKey: "k", sweepKey: "gogemine#0202", log: quiet });
  assert.equal(r.checked, 4, "le RR en échec est vu comme « rien de neuf »");
  assert.equal(r.nextSweep, "yakuza#2826", "le tour passe au suivant même si celui-ci a échoué");
});

test("le budget de temps coupe proprement", async () => {
  const S = memoryStores();
  const H = henrik({});
  let t = 0;
  const r = await watchRefresh({ roster: ROSTER, getStore: S.getStore, fetchImpl: H.fetchImpl, apiKey: "k", budgetMs: 2, now: () => (t += 1), log: quiet });
  assert.ok(r.checked < ROSTER.length);
  assert.equal(r.swept, null);
});

test("planification : toutes les 5 minutes, compos une seule fois par jour", () => {
  const src = readFileSync(new URL("../netlify/functions/refresh-matches.mjs", import.meta.url), "utf8");
  assert.match(src, /schedule: "\*\/5 \* \* \* \*"/);
  assert.equal(isCompsRun(new Date("2026-10-19T04:00:30Z")), true);
  assert.equal(isCompsRun(new Date("2026-10-19T04:05:00Z")), false, "pas 12 fois dans l'heure");
  assert.equal(isCompsRun(new Date("2026-10-19T05:00:00Z")), false);
  const rec = readFileSync(new URL("../netlify/functions/discord-recap.mjs", import.meta.url), "utf8");
  assert.match(rec, /schedule: "7,22,37,52 \* \* \* \*"/, "le récap tous les quarts d'heure");
});
