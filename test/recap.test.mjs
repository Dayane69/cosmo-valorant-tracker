// Récap Discord : choix de la session, bilan, carte SVG/PNG, envoi au webhook.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normCompact, squadSessions, pickSession, buildRecap, playedTogether, RECAP } from "../netlify/functions/lib/recap-core.mjs";
import { recapSVG, missingChars, renderPNG, xml, tierFr } from "../netlify/functions/lib/recap-card.mjs";
import { runRecap, discordContent, shareURL } from "../netlify/functions/lib/recap-run.mjs";
import { readFont, readWasm } from "../netlify/functions/lib/recap-assets.mjs";

const MIN = 60000, T0 = Date.parse("2026-10-17T19:00:00Z");
const A = { name: "Yaku", tag: "ZA", color: "#ff4655" };
const B = { name: "DN4影", tag: "EUW", color: "#56d8c9" };
const C = { name: "Solo", tag: "X" };

// Une partie au format compact (stored-matches v1).
const game = (id, t, { team = "red", my = 13, opp = 8, k = 20, d = 10, a = 5, score = 5000, mode = "Competitive", agent = "agent-jett", map = "Ascent" } = {}) => ({
  meta: { id, started_at: new Date(t).toISOString(), mode, map: { name: map } },
  stats: { team, kills: k, deaths: d, assists: a, score, damage: { made: 3000 }, shots: { head: 20, body: 70, leg: 10 }, character: { id: agent, name: agent.replace("agent-", "") } },
  teams: team === "red" ? { red: my, blue: opp } : { blue: my, red: opp },
});

test("normCompact : résultat, rounds, ACS de base", () => {
  const M = normCompact(game("g1", T0, { my: 13, opp: 11 }));
  assert.equal(M.result, "w");
  assert.equal(M.rounds, 24);
  assert.equal(M.map, "Ascent");
  assert.equal(normCompact({ meta: {} }), null, "sans id ni date : ignorée");
});

test("squadSessions : seules les parties jouées ENSEMBLE comptent", () => {
  const per = [
    { member: A, matches: [game("g1", T0), game("g2", T0 + 50 * MIN), game("solo-a", T0 - 5 * 60 * MIN)] },
    { member: B, matches: [game("g1", T0), game("g2", T0 + 50 * MIN), game("solo-b", T0 + 6 * 60 * MIN)] },
  ];
  const S = squadSessions(per);
  assert.equal(S.length, 1, "les parties solo ne créent pas de session et ne rallongent pas la soirée");
  assert.deepEqual([...new Set(S[0].entries.map((e) => e.M.id))], ["g1", "g2"]);
  // Sans le filtre, les parties solo s'ajoutent (le comportement corrigé).
  assert.equal(squadSessions(per, RECAP.GAP_MS, { togetherOnly: false }).length, 3);
});

test("squadSessions : même partie mais équipes opposées = pas ensemble", () => {
  const per = [
    { member: A, matches: [game("g1", T0, { team: "red" })] },
    { member: B, matches: [game("g1", T0, { team: "blue" })] },
  ];
  assert.equal(squadSessions(per).length, 0);
});

test("squadSessions : non classé ignoré, coupure à l'écart", () => {
  const per = [
    { member: A, matches: [game("g1", T0), game("g9", T0 + 4 * 60 * MIN), game("u1", T0 + 30 * MIN, { mode: "Unrated" })] },
    { member: B, matches: [game("g1", T0), game("g9", T0 + 4 * 60 * MIN), game("u1", T0 + 30 * MIN, { mode: "Unrated" })] },
  ];
  const S = squadSessions(per);
  assert.equal(S.length, 2, "4 h d'écart : deux soirées");
  assert.ok(S.every((s) => s.entries.every((e) => e.M.id !== "u1")));
  assert.ok(playedTogether(S[0]));
});

test("pickSession : pas finie, trop vieille, déjà postée, force", () => {
  const per = [{ member: A, matches: [game("g1", T0)] }, { member: B, matches: [game("g1", T0)] }];
  const [s] = squadSessions(per);
  assert.equal(pickSession([s], { now: s.end + 30 * MIN }), null, "moins de 2 h après : peut-être pas finie");
  assert.equal(pickSession([s], { now: s.end + 3 * 60 * MIN }), s);
  assert.equal(pickSession([s], { now: s.end + 30 * 60 * MIN }), null, "plus de 24 h : trop tard");
  assert.equal(pickSession([s], { now: s.end + 3 * 60 * MIN, posted: [s.key] }), null, "déjà postée");
  assert.equal(pickSession([s], { now: s.end + 30 * 60 * MIN, posted: [s.key], force: true }), s, "aperçu forcé");
  assert.equal(pickSession([s], { now: s.end + 3 * 60 * MIN, minMembers: 3 }), null, "seuil de joueurs");
});

test("buildRecap : parties comptées une fois, MVP à la note perf., RR", () => {
  const per = [
    { member: A, matches: [game("g1", T0, { k: 25 }), game("g2", T0 + 50 * MIN, { my: 9, opp: 13 })],
      rr: [{ id: "g1", change: 22, tier: { name: "Platinum 1" } }, { id: "g2", change: -18, tier: { name: "Platinum 1" } }],
      perf: [{ id: "g1", ps: 310, g: "merit", mvp: true }, { id: "g2", ps: 250 }] },
    { member: B, matches: [game("g1", T0), game("g2", T0 + 50 * MIN, { my: 9, opp: 13 })],
      rr: [{ id: "g1", change: 20 }, { id: "g2", change: -21 }],
      perf: [{ id: "g1", ps: 260 }, { id: "g2", ps: 240 }] },
  ];
  const R = buildRecap(squadSessions(per)[0]);
  assert.equal(R.games, 2);
  assert.equal(R.wins, 1);
  assert.equal(R.losses, 1);
  assert.equal(R.metric, "ps");
  assert.equal(R.mvp.name, "Yaku");
  assert.equal(R.members[0].ps, 280);
  assert.equal(R.members[0].mvps, 1);
  assert.equal(R.members[0].rr, 4);
  assert.equal(R.topRR.name, "Yaku");
  assert.equal(R.worstRR.name, "DN4影");
  assert.equal(R.best.v, 310);
  // Sans note pour quelqu'un : le classement repasse à l'ACS.
  per[1].perf = [];
  assert.equal(buildRecap(squadSessions(per)[0]).metric, "acs");
});

test("recapSVG : pseudos échappés, badge MVP, tiers en français", () => {
  const per = [
    { member: { name: "<b>&\"x", tag: "1" }, matches: [game("g1", T0)], rr: [{ id: "g1", change: 20, tier: { name: "Gold 2" } }] },
    { member: B, matches: [game("g1", T0)] },
  ];
  const svg = recapSVG(buildRecap(squadSessions(per)[0]), { tz: "Europe/Paris", site: "cosmo-valo.netlify.app" });
  assert.ok(!svg.includes("<b>"), "aucune balise injectée");
  assert.ok(svg.includes("&lt;b&gt;&amp;&quot;x"));
  assert.ok(svg.includes("MVP"));
  assert.ok(svg.includes("Samedi 17 octobre"));
  assert.equal(xml("a'b"), "a&#39;b");
  assert.equal(tierFr("Platinum 2"), "Platine 2");
});

test("missingChars : seulement les glyphes hors latin", () => {
  assert.equal(missingChars(["DN4影", "Yaku", "Éloïse – 1·2"]), "影");
  assert.equal(missingChars(["abc"]), "");
});

test("renderPNG : le vrai moteur resvg + Inter produit un PNG", async () => {
  const per = [{ member: A, matches: [game("g1", T0)] }, { member: B, matches: [game("g1", T0)] }];
  const svg = recapSVG(buildRecap(squadSessions(per)[0]), { tz: "Europe/Paris", site: "x" });
  const png = await renderPNG(svg, { wasm: readWasm(), fonts: [400, 600, 800].map((w) => readFont(`Inter-${w}.ttf`)) });
  assert.deepEqual([...png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(new DataView(png.buffer, png.byteOffset).getUint32(16), 1200, "1200 px de large");
});

// ---- runRecap, avec des stores et un fetch factices -------------------------
function fakeStores(data) {
  const stores = {};
  const getStore = (name) => (stores[name] = stores[name] || {
    data: data[name] || {},
    async get(k) { return this.data[k] === undefined ? null : JSON.parse(JSON.stringify(this.data[k])); },
    async setJSON(k, v) { this.data[k] = v; },
  });
  return { getStore, stores };
}
function world() {
  return {
    "cosmo-roster": { roster: { members: [A, B, C] } },
    "cosmo-history": {
      "yaku#za": [game("g1", T0), game("g2", T0 + 50 * MIN)],
      "dn4影#euw": [game("g1", T0), game("g2", T0 + 50 * MIN)],
      "solo#x": [game("s1", T0 + 20 * MIN)],
    },
    "cosmo-rr": { "yaku#za": [{ id: "g1", change: 20 }] },
  };
}
const fakeRender = { initWasm: async () => {}, Resvg: class { render() { return { asPng: () => new Uint8Array([137, 80, 78, 71]) }; } } };

async function run(stores, extra = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith("https://discord")) return { ok: extra.discordOk !== false, status: extra.discordOk === false ? 400 : 200 };
    if (String(url).includes("fonts.googleapis")) return { ok: true, text: async () => "src: url(https://fonts.gstatic.com/x.ttf)" };
    return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  };
  const r = await runRecap({
    getStore: stores.getStore, fetchImpl, now: T0 + 5 * 60 * MIN, post: true,
    webhook: extra.webhook === undefined ? "https://discord.com/api/webhooks/1/abc" : extra.webhook,
    readFile: () => new Uint8Array([0]), wasmBytes: new Uint8Array([0]), resvg: fakeRender,
  });
  return { r, calls };
}

test("runRecap : poste l'image et ne retient la session qu'après succès", async () => {
  const S = fakeStores(world());
  const { r, calls } = await run(S);
  assert.equal(r.status, "posté");
  const post = calls.find((c) => c.url.startsWith("https://discord"));
  assert.ok(post.url.endsWith("?wait=true"));
  const payload = JSON.parse(post.init.body.get("payload_json"));
  assert.match(payload.content, /2 parties ensemble, 1V-0D|2 parties ensemble, 2V-0D/);
  assert.deepEqual(payload.allowed_mentions, { parse: [] }, "jamais de @everyone");
  assert.equal(post.init.body.get("files[0]").type, "image/png");
  assert.ok(calls.some((c) => c.url.includes("fonts.googleapis") && c.url.includes(encodeURIComponent("影"))), "police de repli pour 影");
  assert.deepEqual(S.stores["cosmo-discord"].data.posted, [r.posted]);
  // Deuxième passage : rien de neuf.
  const again = await run(S);
  assert.equal(again.r.status, "rien à poster");
  assert.equal(again.calls.filter((c) => c.url.startsWith("https://discord")).length, 0);
});

test("runRecap : refus de Discord = la session reste à poster", async () => {
  const S = fakeStores(world());
  const { r } = await run(S, { discordOk: false });
  assert.match(r.status, /refusé.*400/);
  assert.equal(S.stores["cosmo-discord"].data.posted, undefined);
  assert.equal((await run(S)).r.status, "posté", "réessayé à l'heure suivante");
});

test("runRecap : sans webhook, rien n'est envoyé", async () => {
  const S = fakeStores(world());
  const { r, calls } = await run(S, { webhook: "" });
  assert.match(r.status, /DISCORD_WEBHOOK_URL absent/);
  assert.ok(r.png);
  assert.equal(calls.filter((c) => c.url.startsWith("https://discord")).length, 0);
});

test("discordContent / shareURL", () => {
  const recap = { start: T0, games: 3, wins: 2, losses: 1, members: [{ rr: 30 }, { rr: -12 }, { rr: null }] };
  const txt = discordContent(recap, "https://x/?s=1");
  assert.match(txt, /samedi 17 octobre/);
  assert.match(txt, /3 parties ensemble, 2V-1D · \+18 RR/);
  const u = new URL(shareURL("https://cosmo-valo.netlify.app/", A, T0));
  assert.equal(u.searchParams.get("s"), "Yaku#ZA");
  assert.equal(u.searchParams.get("t"), String(T0));
});

test("le PNG de la fonction ne dépend pas du rendu factice", () => {
  // Garde-fou : la police versionnée est bien un TTF (signature 0x00010000).
  const f = readFileSync(new URL("../netlify/functions/assets/fonts/Inter-800.ttf", import.meta.url));
  assert.equal(f.readUInt32BE(0), 0x00010000);
});

test("netlify.toml : le moteur .wasm est embarqué dans les deux fonctions du récap", () => {
  // Sans cette ligne, la fonction répondait « moteur de rendu introuvable » en
  // production : external_node_modules n'embarque que le JS du paquet.
  const toml = readFileSync(new URL("../netlify.toml", import.meta.url), "utf8");
  for (const fn of ["discord-recap", "discord-recap-preview"]) {
    const block = toml.split(`[functions."${fn}"]`)[1].split("\n[")[0];
    assert.match(block, /included_files = \[[^\]]*"node_modules\/@resvg\/resvg-wasm\/index_bg\.wasm"/, fn);
    assert.match(block, /"netlify\/functions\/assets\/\*\*"/, fn + " : les polices");
  }
});
