// Récap de la semaine : bornes (lundi 6 h -> lundi 6 h), niveau de départ et
// d'arrivée, changements de palier, trophées, carte, envoi le lundi matin.
import assert from "node:assert/strict";
import test from "node:test";
import { weekWindow, buildWeek, pickWeek, tierIdOfElo, tierNameOf, rrInTier } from "../netlify/functions/lib/weekly-core.mjs";
import { weeklySVG, memberColors, PALETTE } from "../netlify/functions/lib/weekly-card.mjs";
import { runRecap, discordContent } from "../netlify/functions/lib/recap-run.mjs";

const Z = (iso) => Date.parse(iso);
const game = (id, iso, { team = "red", my = 13, opp = 8, k = 18, d = 14, agent = "fade", map = "Bind", score = 4500 } = {}) => ({
  meta: { id, started_at: iso, mode: "Competitive", map: { name: map } },
  stats: { team, kills: k, deaths: d, assists: 5, score, damage: { made: 3000 }, shots: { head: 30, body: 60, leg: 10 }, character: { id: agent, name: agent } },
  teams: team === "red" ? { red: my, blue: opp } : { blue: my, red: opp },
});
const rr = (id, iso, elo, change) => ({ id, ts: Z(iso), elo, change, rr: ((elo % 100) + 100) % 100, tier: { id: tierIdOfElo(elo) } });

// Semaine du 26 octobre (heure d'hiver depuis le 25) : lundi 6 h = 05:00 UTC.
const MONDAY_MORNING = Z("2026-11-02T08:00:00Z");
// Gogemine : Platine 2 · 87 dimanche dernier, monte Platine 3 mardi, redescend jeudi.
const GOG = { member: { name: "Gogemine", tag: "0202" },
  matches: [game("g1", "2026-10-27T18:00:00Z"), game("g2", "2026-10-27T18:40:00Z"), game("g3", "2026-10-29T19:00:00Z", { my: 5, opp: 13 }),
    game("g4", "2026-10-29T19:40:00Z", { my: 9, opp: 13 }), game("old", "2026-10-25T18:00:00Z")],
  rr: [rr("old", "2026-10-25T18:30:00Z", 1387, 20), rr("g1", "2026-10-27T18:30:00Z", 1410, 13), rr("g2", "2026-10-27T19:10:00Z", 1425, 15),
    rr("g3", "2026-10-29T19:30:00Z", 1405, -20), rr("g4", "2026-10-29T20:10:00Z", 1385, -20)] };
// joker : 3 parties avec Gogemine le mardi et le jeudi, plus une pénalité sans partie (-6).
const JOK = { member: { name: "joker", tag: "prft9" },
  matches: [game("g1", "2026-10-27T18:00:00Z"), game("g2", "2026-10-27T18:40:00Z"), game("g3", "2026-10-29T19:00:00Z", { my: 5, opp: 13 }), game("j1", "2026-11-01T20:00:00Z", { k: 30, d: 10, score: 7000 })],
  rr: [rr("x", "2026-10-20T20:00:00Z", 1600, 10), rr("g1", "2026-10-27T18:30:00Z", 1620, 20), rr("g2", "2026-10-27T19:10:00Z", 1640, 20),
    rr("g3", "2026-10-29T19:30:00Z", 1620, -20), rr("j1", "2026-11-01T20:30:00Z", 1645, 25), rr("pen", "2026-11-01T22:00:00Z", 1639, -6)] };

test("la semaine : du lundi 6 h au lundi 6 h, heure de Paris", () => {
  const w = weekWindow({ now: MONDAY_MORNING, tz: "Europe/Paris" });
  assert.equal(w.key, "w2026-10-26");
  assert.equal(w.start, Z("2026-10-26T05:00:00Z"), "lundi 26, 6 h (heure d'hiver)");
  assert.equal(w.end, Z("2026-11-02T05:00:00Z"));
  assert.equal(w.days.length, 8);
  // Lundi 2 novembre à 5 h 30 : la semaine n'est pas finie, la dernière finie est la précédente.
  assert.equal(weekWindow({ now: Z("2026-11-02T04:30:00Z"), tz: "Europe/Paris" }).key, "w2026-10-19");
  // La semaine du changement d'heure dure une heure de plus.
  const dst = weekWindow({ monday: "2026-10-19", tz: "Europe/Paris" });
  assert.equal(dst.end - dst.start, 7 * 86400000 + 3600000);
});

test("paliers : numéro, nom, RR dans le palier", () => {
  assert.equal(tierNameOf(tierIdOfElo(1387)), "Platinum 2");
  assert.equal(rrInTier(1387), 87);
  assert.equal(tierNameOf(tierIdOfElo(1410)), "Platinum 3");
  assert.equal(tierNameOf(tierIdOfElo(839)), "Silver 3");
});

test("niveau de départ, d'arrivée et changements de palier", () => {
  const W = buildWeek([GOG, JOK], weekWindow({ now: MONDAY_MORNING }));
  const g = W.members.find((m) => m.name === "Gogemine");
  assert.equal(g.startElo, 1387, "le dernier niveau connu avant lundi");
  assert.equal(g.endElo, 1385);
  assert.equal(g.rr, -2);
  assert.deepEqual(g.events.map((e) => [e.up, tierNameOf(e.to)]), [[true, "Platinum 3"], [false, "Platinum 2"]]);
  assert.equal(g.n, 4, "la partie du dimanche d'avant n'est pas dans la semaine");
  const j = W.members.find((m) => m.name === "joker");
  assert.equal(j.rr, 39, "la différence de niveau compte aussi la pénalité (-6) sans partie");
  assert.equal(W.rankUps, 1);
  assert.equal(W.rankDowns, 1);
});

test("bilan de la squad, jours, duo et trophées", () => {
  const W = buildWeek([GOG, JOK], weekWindow({ now: MONDAY_MORNING }));
  assert.equal(W.games, 5, "g1, g2, g3 comptent une fois même jouées à deux");
  assert.equal(W.together, 3);
  assert.equal(W.wins, 3);
  assert.equal(W.losses, 2);
  const g = W.members.find((m) => m.name === "Gogemine");
  assert.deepEqual(g.days.map((d) => d.n), [0, 2, 0, 2, 0, 0, 0], "mardi et jeudi");
  assert.deepEqual({ ...W.awards.duo }, { a: "Gogemine", b: "joker", n: 3, w: 2 });
  assert.equal(W.awards.climber.name, "joker");
  assert.equal(W.awards.rough.name, "Gogemine");
  assert.equal(W.awards.grinder.n, 4, "le plus actif : 4 parties (égalité, le premier du classement)");
  assert.equal(W.awards.streak, null, "2 victoires d'affilée ne font pas une série");
  assert.equal(W.maps[0].name, "Bind");
  assert.equal(buildWeek([GOG], weekWindow({ monday: "2026-10-05" })), null, "semaine vide : rien");
});

test("pickWeek : seulement la dernière semaine finie, une fois", () => {
  assert.ok(pickWeek([GOG, JOK], { now: MONDAY_MORNING }));
  assert.equal(pickWeek([GOG, JOK], { now: MONDAY_MORNING, posted: ["w2026-10-26"] }), null);
  assert.ok(pickWeek([GOG, JOK], { now: MONDAY_MORNING, posted: ["w2026-10-26"], force: true }), "aperçu forcé");
});

test("carte : sections, pseudos échappés, couleurs du Dashboard", () => {
  const evil = { ...JOK, member: { name: "<b>&x", tag: "1" } };
  const W = buildWeek([GOG, evil], weekWindow({ now: MONDAY_MORNING }));
  const svg = weeklySVG(W, { tz: "Europe/Paris", colors: memberColors([GOG.member, evil.member]) });
  for (const s of ["RÉCAP DE LA SEMAINE", "Du 26 octobre au 1 novembre", "MONTÉES ET DESCENTES", "COURBES DE RR", "STATS DE LA SEMAINE", "ACTIVITÉ", "TROPHÉES DE LA SEMAINE", "MAPS DE LA SEMAINE"]) assert.ok(svg.includes(s), s);
  assert.ok(!svg.includes("<b>"));
  assert.ok(svg.includes("&lt;b&gt;&amp;x"));
  assert.ok(svg.includes(`stroke="${PALETTE[0]}"`), "la courbe de Gogemine a la couleur du 1er du roster");
  assert.match(svg, /Platine 2 · 87/);
  assert.equal(memberColors(Array.from({ length: 9 }, (_, i) => ({ name: "m" + i, tag: "1" })))["m8#1"], "#8696a6", "9e joueur : gris neutre");
});

test("discordContent : le message de la semaine", () => {
  const W = buildWeek([GOG, JOK], weekWindow({ now: MONDAY_MORNING }));
  assert.match(discordContent(W, "https://cosmo-valo.netlify.app/"),
    /^\*\*Récap de la semaine COSMO · du 26 octobre au 1 novembre\*\* — 5 parties classées \(dont 3 ensemble\), 3V-2D · \+37 RR pour la squad · ▲ 1 montée ▼ 1 descente/);
});

test("runRecap : le lundi matin, le récap de la semaine part, une seule fois", async () => {
  const data = { "cosmo-roster": { roster: { members: [GOG.member, JOK.member] } },
    "cosmo-history": { "gogemine#0202": GOG.matches, "joker#prft9": JOK.matches },
    "cosmo-rr": { "gogemine#0202": GOG.rr, "joker#prft9": JOK.rr },
    // Le bilan du dimanche a déjà été posté : c'est au tour de la semaine.
    "cosmo-discord": { posted: ["d2026-11-01"] } };
  const stores = {};
  const getStore = (name) => (stores[name] = stores[name] || { data: data[name] || {},
    async get(k) { return this.data[k] === undefined ? null : JSON.parse(JSON.stringify(this.data[k])); },
    async setJSON(k, v) { this.data[k] = v; } });
  const sent = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.startsWith("https://discord")) { sent.push({ content: JSON.parse(init.body.get("payload_json")).content, file: init.body.get("files[0]").name }); return { ok: true, status: 200 }; }
    if (u.includes("valorant-api.com/v1/competitivetiers")) return { ok: true, json: async () => ({ data: [{ uuid: "u" }] }) };
    if (u.includes("fonts.googleapis")) return { ok: true, text: async () => "" };
    return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
  };
  const resvg = { initWasm: async () => {}, Resvg: class { render() { return { asPng: () => new Uint8Array([137, 80, 78, 71]) }; } } };
  const go = () => runRecap({ getStore, fetchImpl, now: MONDAY_MORNING, post: true, webhook: "https://discord.com/api/webhooks/1/x",
    readFile: () => new Uint8Array([0]), wasmBytes: new Uint8Array([0]), resvg });
  const r = await go();
  assert.equal(r.posted, "w2026-10-26");
  assert.match(sent[0].content, /^\*\*Récap de la semaine COSMO/);
  assert.equal(sent[0].file, "recap-semaine-cosmo.png");
  assert.equal((await go()).status, "rien à poster");
  assert.equal(sent.length, 1);
});
