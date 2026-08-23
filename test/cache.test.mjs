// Tests du cache local (affichage instantané) et du retry sur 429.
// Le cache ne remplace jamais un appel : il évite l'écran vide en attendant.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Faux localStorage, avec un quota réglable pour tester l'éviction.
function makeStorage(quota = Infinity) {
  const map = new Map();
  return {
    _map: map, quota,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem(k, v) {
      if (String(v).length > this.quota) { const e = new Error("quota"); e.name = "QuotaExceededError"; throw e; }
      map.set(k, String(v));
    },
    removeItem: (k) => map.delete(k),
  };
}

function load(storage, fetchImpl) {
  // setTimeout est requis par le backoff. On plafonne le délai : ce qu'on teste
  // c'est la logique de nouvelle tentative, pas la durée de l'attente.
  const ctx = vm.createContext({ console, URL, URLSearchParams, localStorage: storage,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 1)),
    clearTimeout: (h) => clearTimeout(h),
    fetch: fetchImpl || (async () => ({ ok: false, status: 500 })) });
  let code = readFileSync(join(root, "app.js"), "utf8");
  code += `\nglobalThis.__x = { slimMatch, rehydrateMatch, cacheLoad, cacheSave, cachePutProfile,
    cacheGetProfile, cachePutRank, cacheGetRank, normMatch, api, apiErrMsg, freshAge,
    CACHE_SCHEMA, CACHE_KEY, resetCache: () => { CACHE = null; } };`;
  vm.runInContext(code, ctx);
  return ctx.__x;
}

/* --------------------------------------------------- projection / relecture */

const fullRaw = (id) => ({
  metadata: { match_id: id, map: { name: "Ascent" }, queue: { name: "Competitive" },
    started_at: "2026-08-22T20:00:00Z", game_length_in_ms: 2100000, season: { short: "e11a4" } },
  players: [
    { puuid: "p1", name: "Yakuza", tag: "2826", team_id: "Blue", party_id: "g1",
      agent: { id: "aid", name: "Cypher" },
      stats: { kills: 22, deaths: 12, assists: 6, score: 5600, headshots: 25, bodyshots: 60, legshots: 5,
        damage: { dealt: 3900, received: 3100 } } },
    { puuid: "p2", name: "Foe", tag: "9999", team_id: "Red", party_id: "g2",
      agent: { id: "bid", name: "Omen" },
      stats: { kills: 11, deaths: 18, assists: 3, score: 2700, headshots: 9, bodyshots: 40, legshots: 4,
        damage: { dealt: 2400, received: 3900 } } },
  ],
  rounds: [{ winning_team: "Blue", result: "Elimination", stats: [], plant: null, defuse: null }],
  kills: [{ round: 0, time_in_round_in_ms: 4000, killer: { puuid: "p1", name: "Yakuza", team: "Blue" },
    victim: { puuid: "p2", name: "Foe", team: "Red" }, weapon: { name: "Vandal" }, assistants: [] }],
  teams: [{ team_id: "Blue", won: true, rounds: { won: 13, lost: 8 } },
          { team_id: "Red", won: false, rounds: { won: 8, lost: 13 } }],
});
const ME = { puuid: "p1", name: "Yakuza", tag: "2826" };

test("la projection garde ce qu'il faut pour afficher, et jette le lourd", () => {
  const X = load(makeStorage());
  const M = X.normMatch(fullRaw("m1"), ME);
  const s = X.slimMatch(M);
  assert.equal(s.id, "m1");
  assert.equal(s.me.score100, M.me.score100, "la note affichée est conservée");
  assert.equal(s.me.acs, M.me.acs);
  assert.equal(s.rounds, M.rounds);
  assert.equal(s.durMs, 2100000);
  // Le lourd n'est pas stocké : il est rechargeable à la demande.
  assert.equal(s.facts, undefined);
  assert.equal(s.players, undefined);
  assert.equal(s.lines, undefined);
});

test("la projection reste minuscule comparée à la partie normalisée", () => {
  const X = load(makeStorage());
  const M = X.normMatch(fullRaw("m1"), ME);
  const slim = JSON.stringify(X.slimMatch(M)).length;
  const norm = JSON.stringify({ me: M.me, facts: M.facts, players: M.players }).length;
  assert.ok(slim * 5 < norm, `projection ${slim} o vs normalisé ${norm} o`);
});

test("relire le cache redonne une partie affichable, détail de l'indice inclus", () => {
  const X = load(makeStorage());
  const M = X.normMatch(fullRaw("m1"), ME);
  const back = X.rehydrateMatch(X.slimMatch(M));
  assert.equal(back.id, "m1");
  assert.equal(back.me.score100, M.me.score100, "même note qu'avant");
  assert.ok(back.me.detail, "le détail du calcul est reconstruit (il contient des fonctions, donc non stockable)");
  assert.equal(back.me.detail.score, M.me.detail.score, "…et il redonne exactement la même note");
  assert.equal(back.partial, true, "marquée compacte : le scoreboard complet reste à charger");
  assert.equal(back.lines.length, 1, "une ligne, comme une partie du blob");
  assert.equal(back.facts, null);
});

test("une entrée vide ou sans id n'est pas ressuscitée", () => {
  const X = load(makeStorage());
  assert.equal(X.rehydrateMatch(null), null);
  assert.equal(X.rehydrateMatch({}), null);
});

/* -------------------------------------------------------------- versionnage */

test("un cache écrit par une version antérieure est jeté, pas relu", () => {
  const st = makeStorage();
  st.setItem("cosmo.cache", JSON.stringify({ v: 0, ranks: { "x#1": { tier: "Radiant" } }, profiles: {} }));
  const X = load(st);
  assert.equal(X.cacheGetRank("x#1"), null, "la forme a changé : on repart de zéro plutôt que d'afficher n'importe quoi");
});

test("un cache de la bonne version est relu", () => {
  const st = makeStorage();
  const X0 = load(st);
  st.setItem("cosmo.cache", JSON.stringify({ v: X0.CACHE_SCHEMA, ranks: { "x#1": { tier: "Gold 2", rr: 40 } }, profiles: {} }));
  const X = load(st);
  assert.equal(X.cacheGetRank("x#1").tier, "Gold 2");
});

test("un contenu corrompu ne fait pas planter le démarrage", () => {
  const st = makeStorage();
  st.setItem("cosmo.cache", "{pas du json");
  const X = load(st);
  assert.equal(X.cacheGetRank("x#1"), null);
  assert.equal(X.cacheGetProfile("x#1"), null);
});

test("sans stockage disponible (navigation privée), l'app tourne quand même", () => {
  const ctx = vm.createContext({ console, URL, URLSearchParams,
    get localStorage() { throw new Error("bloqué"); }, fetch: async () => ({ ok: false }) });
  let code = readFileSync(join(root, "app.js"), "utf8");
  code += "\nglobalThis.__x = { cacheGetRank, cachePutRank, cacheSave };";
  assert.doesNotThrow(() => vm.runInContext(code, ctx));
  assert.doesNotThrow(() => ctx.__x.cachePutRank("a#1", { tier: "Gold 2" }));
  assert.equal(ctx.__x.cacheSave(), false, "l'échec est signalé, pas masqué par une exception");
});

/* ------------------------------------------------------- écriture / lecture */

test("un profil enregistré se relit à l'identique", () => {
  const X = load(makeStorage());
  const M = X.normMatch(fullRaw("m1"), ME);
  X.cachePutProfile("Yakuza#2826", { mmr: { tier: "Gold 2", rr: 55 }, matches: [M], rr: [{ id: "m1", elo: 1400 }] });
  const back = X.cacheGetProfile("yakuza#2826");   // insensible à la casse
  assert.ok(back);
  assert.equal(back.mmr.tier, "Gold 2");
  assert.equal(back.matches.length, 1);
  assert.equal(back.rr.length, 1);
  assert.ok(back.ts > 0, "l'horodatage sert à afficher l'âge");
});

test("quota dépassé : on évince les profils les plus anciens au lieu de tout perdre", () => {
  const X = load(makeStorage(1400));   // volontairement très serré
  const M = X.normMatch(fullRaw("m1"), ME);
  X.cachePutProfile("vieux#1", { mmr: {}, matches: [M], rr: [] });
  X.cachePutProfile("recent#2", { mmr: {}, matches: [M], rr: [] });
  const c = X.cacheLoad();
  const keys = Object.keys(c.profiles);
  assert.ok(keys.length >= 1, "au moins un profil survit");
  assert.ok(keys.includes("recent#2"), "c'est le plus récent qui est gardé");
});

/* -------------------------------------------------------------- retry 429 */

test("un 429 est réessayé, et la réponse suivante est servie", async () => {
  let calls = 0;
  const X = load(makeStorage(), async () => {
    calls++;
    if (calls < 3) return { ok: false, status: 429, headers: { get: () => null } };
    return { ok: true, json: async () => ({ data: { ok: true } }) };
  });
  const d = await X.api("/valorant/v1/x");
  assert.equal(calls, 3, "deux échecs puis un succès");
  assert.equal(d.data.ok, true);
});

test("un 404 n'est PAS réessayé : c'est définitif", async () => {
  let calls = 0;
  const X = load(makeStorage(), async () => { calls++; return { ok: false, status: 404, headers: { get: () => null } }; });
  await assert.rejects(() => X.api("/valorant/v1/x"), /http 404/);
  assert.equal(calls, 1, "inutile d'insister sur un compte qui n'existe pas");
});

test("après épuisement des tentatives, l'erreur porte son statut", async () => {
  const X = load(makeStorage(), async () => ({ ok: false, status: 429, headers: { get: () => null } }));
  await assert.rejects(() => X.api("/valorant/v1/x", 2), (e) => e.status === 429);
});

test("une coupure réseau est retentée puis signalée proprement", async () => {
  let calls = 0;
  const X = load(makeStorage(), async () => { calls++; throw new Error("offline"); });
  await assert.rejects(() => X.api("/valorant/v1/x", 2), (e) => e.status === 0);
  assert.equal(calls, 2);
});

test("les messages d'erreur sont lisibles, pas des codes bruts", () => {
  const X = load(makeStorage());
  assert.match(X.apiErrMsg({ status: 429 }), /trop de requêtes/i);
  assert.match(X.apiErrMsg({ status: 404 }), /introuvable/i);
  assert.match(X.apiErrMsg({ status: 0 }), /réseau/i);
  assert.match(X.apiErrMsg({ status: 503 }), /API Valorant/i);
});

/* ------------------------------------------------------------------- âge */

test("l'âge affiché est parlant à toutes les échelles", () => {
  const X = load(makeStorage());
  const ago = (ms) => X.freshAge(Date.now() - ms);
  assert.equal(ago(5000), "à l'instant");
  assert.equal(ago(3 * 60000), "il y a 3 min");
  assert.equal(ago(2 * 3600000), "il y a 2 h");
  assert.equal(ago(3 * 86400000), "il y a 3 j");
  assert.equal(X.freshAge(0), "", "pas d'horodatage : pas d'âge inventé");
});
