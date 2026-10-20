// Bilan du jour : quand personne ne joue ensemble (lundi 19 octobre, joker et
// DN4 chacun de leur côté), aucun récap de squad ne partait.
import assert from "node:assert/strict";
import test from "node:test";
import { dayWindow, pickDay, squadSessions, buildRecap, tzOffsetMs } from "../netlify/functions/lib/recap-core.mjs";
import { recapSVG } from "../netlify/functions/lib/recap-card.mjs";
import { runRecap, discordContent } from "../netlify/functions/lib/recap-run.mjs";

const Z = (iso) => Date.parse(iso);
const game = (id, iso, { team = "red", my = 13, opp = 8, mode = "Competitive" } = {}) => ({
  meta: { id, started_at: iso, mode, map: { name: "Bind" } },
  stats: { team, kills: 18, deaths: 14, assists: 5, score: 4500, damage: { made: 3000 }, shots: { head: 20, body: 70, leg: 10 }, character: { id: "x", name: "Fade" } },
  teams: team === "red" ? { red: my, blue: opp } : { blue: my, red: opp },
});
// Le vrai lundi 19 : joker et DN4, jamais ensemble.
const JOKER = { member: { name: "joker", tag: "prft9" },
  matches: [game("j1", "2026-10-19T07:48:00Z"), game("j2", "2026-10-19T15:17:00Z", { my: 9, opp: 13 }), game("jdm", "2026-10-19T20:42:00Z", { mode: "Deathmatch" })],
  rr: [{ id: "j1", change: 21 }, { id: "j2", change: -17 }] };
const DN4 = { member: { name: "DN4影", tag: "404" },
  matches: [game("d1", "2026-10-19T13:13:00Z"), game("d2", "2026-10-19T13:43:00Z")],
  rr: [{ id: "d1", change: 19 }, { id: "d2", change: 22 }] };
const MORNING = Z("2026-10-20T06:30:00Z");     // 8 h 30 à Paris, le mardi

test("journée de 6 h à 6 h, heure de Paris (y compris le changement d'heure)", () => {
  const w = dayWindow({ now: MORNING, tz: "Europe/Paris" });
  assert.equal(w.key, "d2026-10-19");
  assert.equal(w.start, Z("2026-10-19T04:00:00Z"), "6 h heure d'été");
  assert.equal(w.end, Z("2026-10-20T04:00:00Z"));
  // À 5 h 30 du matin, la journée d'hier n'est pas finie : la dernière finie est avant-hier.
  assert.equal(dayWindow({ now: Z("2026-10-20T03:30:00Z"), tz: "Europe/Paris" }).key, "d2026-10-18");
  // Nuit du samedi 24 au dimanche 25 octobre : passage à l'heure d'hiver à 3 h.
  // La journée du samedi dure donc 25 h (6 h d'été -> 6 h d'hiver).
  const dst = dayWindow({ date: "2026-10-24", tz: "Europe/Paris" });
  assert.equal(dst.start, Z("2026-10-24T04:00:00Z"));
  assert.equal(dst.end, Z("2026-10-25T05:00:00Z"), "6 h heure d'hiver le lendemain");
  assert.equal(tzOffsetMs(Z("2026-12-01T12:00:00Z"), "Europe/Paris"), 3600000);
});

test("lundi 19 : joker et DN4 ont joué chacun de leur côté -> un bilan du jour", () => {
  assert.equal(squadSessions([JOKER, DN4]).length, 0, "pas de session de squad : c'était le trou");
  const d = pickDay([JOKER, DN4], { now: MORNING });
  assert.ok(d);
  const R = buildRecap(d);
  assert.equal(R.kind, "day");
  assert.equal(R.games, 4, "les 4 classées, pas le deathmatch");
  assert.equal(R.together, 0);
  const by = Object.fromEntries(R.members.map((m) => [m.name, m]));
  assert.equal(by.joker.rr, 4);
  assert.equal(by["DN4影"].rr, 41);
  const svg = recapSVG(R, { tz: "Europe/Paris", site: "x" });
  assert.match(svg, /BILAN DU JOUR/);
  assert.match(svg, /Lundi 19 octobre/);
  assert.match(svg, /RR sur la journée/);
  assert.match(discordContent(R, ""), /^\*\*Bilan du jour COSMO · lundi 19 octobre\*\* — 4 parties classées, 3V-1D · \+45 RR/);
});

test("bilan du jour : pas avant 6 h, pas deux fois, pas pour une journée vide", () => {
  assert.equal(pickDay([JOKER, DN4], { now: Z("2026-10-20T03:30:00Z") }), null, "lundi pas fini (5 h 30)");
  assert.equal(pickDay([JOKER, DN4], { now: MORNING, posted: ["d2026-10-19"] }), null, "déjà posté");
  assert.equal(pickDay([JOKER, DN4], { now: Z("2026-10-22T06:30:00Z") }), null, "mardi : personne n'a joué");
});

test("bilan du jour : rien si tout était déjà dans les récaps de squad postés", () => {
  const a = { member: { name: "A", tag: "1" }, matches: [game("t1", "2026-10-19T18:00:00Z"), game("t2", "2026-10-19T18:40:00Z")] };
  const b = { member: { name: "B", tag: "2" }, matches: [game("t1", "2026-10-19T18:00:00Z"), game("t2", "2026-10-19T18:40:00Z")] };
  const [s] = squadSessions([a, b]);
  assert.equal(pickDay([a, b], { now: MORNING, posted: [s.key] }), null, "le récap de squad a déjà tout dit");
  // Une session pas encore postée et pas finie : le récap de squad passe d'abord.
  const late = { member: { name: "A", tag: "1" }, matches: [game("t3", "2026-10-20T03:50:00Z")] };
  const late2 = { member: { name: "B", tag: "2" }, matches: [game("t3", "2026-10-20T03:50:00Z")] };
  assert.equal(pickDay([late, late2], { now: Z("2026-10-20T04:10:00Z") }), null);
  // Avec un solo en plus ce jour-là, le bilan part, et montre tout le monde.
  const c = { member: { name: "C", tag: "3" }, matches: [game("c1", "2026-10-19T12:00:00Z")] };
  const d = pickDay([a, b, c], { now: MORNING, posted: [s.key] });
  assert.equal(buildRecap(d).members.length, 3);
});

test("runRecap : le bilan du jour part quand il n'y a pas de session de squad, et une seule fois", async () => {
  const data = { "cosmo-roster": { roster: { members: [JOKER.member, DN4.member] } },
    "cosmo-history": { "joker#prft9": JOKER.matches, "dn4影#404": DN4.matches },
    "cosmo-rr": { "joker#prft9": JOKER.rr, "dn4影#404": DN4.rr } };
  const stores = {};
  const getStore = (name) => (stores[name] = stores[name] || { data: data[name] || {},
    async get(k) { return this.data[k] === undefined ? null : JSON.parse(JSON.stringify(this.data[k])); },
    async setJSON(k, v) { this.data[k] = v; } });
  const sent = [];
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith("https://discord")) { sent.push(JSON.parse(init.body.get("payload_json")).content); return { ok: true, status: 200 }; }
    if (String(url).includes("fonts.googleapis")) return { ok: true, text: async () => "" };
    return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
  };
  const resvg = { initWasm: async () => {}, Resvg: class { render() { return { asPng: () => new Uint8Array([137, 80, 78, 71]) }; } } };
  const go = () => runRecap({ getStore, fetchImpl, now: MORNING, post: true, webhook: "https://discord.com/api/webhooks/1/x",
    readFile: () => new Uint8Array([0]), wasmBytes: new Uint8Array([0]), resvg });
  assert.equal((await go()).posted, "d2026-10-19");
  assert.match(sent[0], /^\*\*Bilan du jour COSMO · lundi 19 octobre\*\*/);
  assert.equal((await go()).status, "rien à poster");
  assert.equal(sent.length, 1);
});
