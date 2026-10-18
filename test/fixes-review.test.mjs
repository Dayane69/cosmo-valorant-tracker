// Corrections de la revue du 18 octobre (points 1 à 5), vérifiées sur les cas
// réels observés sur le site en ligne.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const roster = JSON.parse(readFileSync(join(root, "roster.json"), "utf8"));

const ctx = vm.createContext({ console, URL, URLSearchParams });
vm.runInContext(readFileSync(join(root, "app.js"), "utf8") + `
  globalThis.__f = { isActId, dashActs, dashForm, currentAct, rankFromSeries, normalizeAny, resultWord, scoreText,
    giphyVariants, lightImg, portraitMedia, setRR: (s) => { RR_FULL = s; }, setTiers: (t) => { TIERS = t; } };`, ctx);
const F = ctx.__f;
const DAY = 86400000, NOW = Date.parse("2026-10-18T20:00:00Z");

/* ---------- 1. « Unknown » n'est pas un acte */

test("acte : une saison « Unknown » ne devient pas l'acte en cours (cas réel du 15 octobre)", () => {
  assert.equal(F.isActId("e11a6"), true);
  assert.equal(F.isActId("Unknown"), false);
  assert.equal(F.isActId(null), false);
  // Ce que contenaient les blobs : e11a6 depuis le 14, une seule entrée « Unknown » le 15.
  const rr = {
    a: [{ ts: Date.parse("2026-10-01"), season: "e11a5" }, { ts: Date.parse("2026-10-14"), season: "e11a6" }],
    b: [{ ts: Date.parse("2026-10-14T12:00:00Z"), season: "e11a6" }, { ts: Date.parse("2026-10-15T12:00:00Z"), season: "Unknown" }],
  };
  const acts = F.dashActs(rr);
  assert.equal(acts.act, "e11a6", "avant : « Unknown », apparu le plus tard, était pris pour l'acte en cours");
  assert.equal(acts.prev, "e11a5");
});

test("acte : la forme du moment retrouve ses parties", () => {
  const ms = Array.from({ length: 12 }, (_, i) => ({ id: "g" + i, mode: "Competitive", startedMs: NOW - i * DAY, season: "e11a6",
    result: "w", me: { k: 15, d: 12, a: 4, acs: 220, adr: 140, hs: 22, rounds: 24, shots: 100, score100: 60 } }));
  const F2 = F.dashForm([{ key: "a", name: "a", matches: ms }], F.dashActs({ a: [{ ts: 1, season: "e11a6" }], b: [{ ts: 2, season: "Unknown" }] }).act);
  assert.notEqual(F2[0].state, "na", "avant : « pas assez de parties » pour tout le monde");
});

test("acte : la carte « L'acte en cours » du profil ignore aussi « Unknown »", () => {
  F.setRR([{ season: "e11a6", ts: 1 }, { season: "Unknown", ts: 2 }]);
  assert.equal(F.currentAct(), "e11a6");
});

/* ---------- 3. Rang lu dans l'historique stocké */

test("rang : lu dans la série RR stockée (dernier palier connu)", () => {
  F.setTiers({ "gold 3": "g3.png" });
  const rk = F.rankFromSeries([{ tier: { id: 13, name: "Gold 2" }, rr: 80, elo: 1180, ts: 1 }, { tier: { id: 14, name: "Gold 3" }, rr: 11, elo: 1211, ts: 2 }]);
  assert.equal(rk.tier, "Gold 3"); assert.equal(rk.rr, 11); assert.equal(rk.icon, "g3.png");
  assert.equal(F.rankFromSeries([]), null);
  assert.equal(F.rankFromSeries([{ tier: { id: 0, name: "Unrated" }, rr: 0, ts: 1 }]), null, "non classé : on laisse le direct répondre");
});

/* ---------- 4. Deathmatch : une place, pas une défaite */

test("deathmatch compact : ni victoire ni défaite (cas réel : équipe = puuid, 13-13)", () => {
  const dm = { meta: { id: "dm1", mode: "Deathmatch", map: { name: "Summit" }, started_at: "2026-10-18T18:18:03Z" },
    stats: { puuid: "pp", team: "8f4773be-ff3b", character: { id: "x", name: "Brimstone" }, score: 3981, kills: 13, deaths: 22, assists: 2,
      shots: { head: 0, body: 0, leg: 0 }, damage: { made: 0, received: 0 } }, teams: { red: 13, blue: 13 } };
  const M = F.normalizeAny(dm, { name: "Yakuza", tag: "2826" });
  assert.equal(M.ffa, true);
  assert.equal(M.result, "?");
  assert.equal(F.resultWord(M), "Combat à mort", "avant : « DÉFAITE »");
  assert.equal(F.scoreText(M), "");
});

test("deathmatch complet : la place au nombre de kills", () => {
  const pl = (n, k) => ({ puuid: n, name: n, tag: "0", team_id: n, agent: { name: "Jett" },
    stats: { kills: k, deaths: 10, assists: 1, score: k * 100, headshots: 1, bodyshots: 1, legshots: 0, damage: { dealt: 0, received: 0 } } });
  const raw = { metadata: { match_id: "dm2", queue: { name: "Deathmatch" }, map: { name: "Bind" }, started_at: "2026-10-18T18:00:00Z" },
    players: [pl("a", 40), pl("me", 30), pl("c", 35), pl("d", 10)], teams: [] };
  const M = F.normalizeAny(raw, { puuid: "me", name: "me", tag: "0" });
  assert.equal(M.ffaPlace, 3, "40 et 35 kills devant ses 30");
  assert.equal(M.ffaN, 4);
  assert.equal(F.resultWord(M), "3e / 4");
});

test("team deathmatch : deux équipes, ce n'est PAS du chacun pour soi", () => {
  const pl = (n, t) => ({ puuid: n, name: n, tag: "0", team_id: t, agent: { name: "Jett" },
    stats: { kills: 10, deaths: 10, assists: 1, score: 1000, headshots: 1, bodyshots: 1, legshots: 0, damage: { dealt: 0, received: 0 } } });
  const raw = { metadata: { match_id: "tdm", queue: { name: "Team Deathmatch" }, map: { name: "Drift" }, started_at: "2026-10-18T18:00:00Z" },
    players: [pl("me", "Blue"), pl("b", "Blue"), pl("c", "Red"), pl("d", "Red")],
    teams: [{ team_id: "Blue", won: true, rounds: { won: 100, lost: 80 } }, { team_id: "Red", won: false, rounds: { won: 80, lost: 100 } }] };
  const M = F.normalizeAny(raw, { puuid: "me", name: "me", tag: "0" });
  assert.equal(!!M.ffa, false);
  assert.equal(F.resultWord(M), "VICTOIRE");
});

/* ---------- 5. GIF Giphy allégés */

test("GIF Giphy : MP4 pour les grandes cartes, 200w.webp pour les vignettes (cas réel du roster)", () => {
  const u = "https://media1.giphy.com/media/v1.Y2lkPTc5MGI3NjExMTRlOXZr/fh4QWl6Rb21sxBYKQs/giphy.gif";
  const v = F.giphyVariants(u);
  assert.equal(v.mp4, "https://media1.giphy.com/media/v1.Y2lkPTc5MGI3NjExMTRlOXZr/fh4QWl6Rb21sxBYKQs/giphy.mp4");
  assert.equal(v.small, "https://media1.giphy.com/media/v1.Y2lkPTc5MGI3NjExMTRlOXZr/fh4QWl6Rb21sxBYKQs/200w.webp");
  assert.equal(F.lightImg(u), v.small);
  assert.equal(F.giphyVariants("https://exemple.org/moi.gif"), null, "pas Giphy : on n'invente pas d'adresse");
  assert.equal(F.lightImg("https://exemple.org/moi.gif"), "https://exemple.org/moi.gif");
  const html = F.portraitMedia(u, "portrait", "Cypher");
  assert.match(html, /^<video class="portrait"/);
  assert.match(html, /muted/); assert.match(html, /playsinline/); assert.match(html, /loop/);
  assert.match(html, /data-orig="https:\/\/media1\.giphy\.com\/.*giphy\.gif"/, "le GIF d'origine reste en secours");
  assert.match(F.portraitMedia("https://exemple.org/moi.gif", "portrait", "x"), /^<img class="portrait"/);
});

/* ---------- 3 (suite). En situation : un vrai DOM, un faux réseau qui compte */

const DOMS = [];
after(async () => { await new Promise((r) => setTimeout(r, 150)); DOMS.forEach((d) => { try { d.window.close(); } catch (e) {} }); });
const jsonRes = (o) => ({ ok: true, status: 200, json: async () => o });

async function boot({ valoFails = false } = {}) {
  const dom = new JSDOM(readFileSync(join(root, "index.html"), "utf8"), { runScripts: "outside-only", url: "https://cosmo-valo.netlify.app/" });
  DOMS.push(dom);
  const c = dom.getInternalVMContext();
  dom.window.scrollTo = () => {};
  const calls = { valo: 0 };
  const series = (i) => [{ id: "r" + i, elo: 1100 + i * 30, rr: 10 + i, change: 12, tier: { id: 12 + (i % 3), name: ["Gold 1", "Gold 2", "Gold 3"][i % 3] }, season: "e11a6", ts: Date.parse("2026-10-17T20:00:00Z") }];
  const stored = (id) => ({ meta: { id, map: { name: "Ascent" }, mode: "Competitive", started_at: "2026-10-17T20:00:00Z" },
    stats: { puuid: "p", team: "Red", character: { id: "x", name: "Cypher" }, score: 5000, kills: 18, deaths: 12, assists: 5,
      shots: { head: 50, body: 100, leg: 5 }, damage: { made: 3500, received: 3000 } }, teams: { red: 13, blue: 7 } });
  dom.window.fetch = c.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("roster.json")) return jsonRes(roster);
    if (url.includes("/.netlify/functions/roster")) return jsonRes({ roster: null });
    if (url.includes("/.netlify/functions/valo")) {
      calls.valo++;
      if (valoFails) return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({ errors: [{ message: "rate limit" }] }) };
      return jsonRes({ data: { puuid: "p", current: { tier: { name: "Gold 2" }, rr: 1 } } });
    }
    if (url.includes("/.netlify/functions/historique")) {
      const u = new URL(url, "http://x"), kind = u.searchParams.get("kind"), name = u.searchParams.get("name");
      const i = Math.max(0, roster.members.findIndex((m) => m.name === name));
      if (kind === "rr") return jsonRes({ rr: series(i) });
      if (kind === "perf") return jsonRes({ perf: [] });
      return jsonRes({ matches: [stored("s" + i + "a"), stored("s" + i + "b")] });
    }
    if (url.includes("competitivetiers")) return jsonRes({ data: [{ tiers: [12, 13, 14].map((t, k) => ({ tier: t, tierName: ["Gold 1", "Gold 2", "Gold 3"][k], color: "ffffffff", largeIcon: "g" + t })) }] });
    return { ok: false, status: 404, json: async () => ({}) };
  };
  vm.runInContext(readFileSync(join(root, "app.js"), "utf8") + `
    globalThis.__t = { init, fillRanks, openProfile, loadProfile, setRetry: () => {}, fresh: () => FRESH, getState: () => STATE };`, c);
  const T = c.__t;
  await T.init();
  await new Promise((r) => setTimeout(r, 50));
  return { dom, T, calls, doc: dom.window.document };
}

test("accueil : les rangs viennent de l'historique stocké — zéro appel à l'API HenrikDev", async () => {
  const { T, calls, doc } = await boot();
  calls.valo = 0;
  await T.fillRanks();
  assert.equal(calls.valo, 0, "avant : un appel par joueur à chaque chargement de l'accueil");
  const chip = doc.getElementById("rank-0").textContent;
  assert.match(chip, /Or \d/, "le rang est bien peint depuis le stocké (en français)");
  assert.equal(T.fresh().home.state, "stored", "le voyant dit d'où vient le rang");
  // Sur demande (clic sur le voyant), l'API est interrogée pour tout le monde.
  await T.fillRanks(true);
  assert.equal(calls.valo, roster.members.length);
});

test("profil : API saturée, il s'affiche quand même depuis l'historique stocké", async () => {
  const { T, doc } = await boot({ valoFails: true });
  T.openProfile(0);
  await T.loadProfile().catch(() => {});
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(doc.getElementById("app").hidden, false, "avant : bloqué sur « Récupération des données HenrikDev… »");
  assert.ok(T.getState().allMatches.length >= 2, "les parties du stocké sont là");
  assert.ok(doc.querySelectorAll("#ml .mrow").length >= 2);
  assert.equal(T.fresh().profile.state, "error", "le voyant dit que le direct a échoué");
});
