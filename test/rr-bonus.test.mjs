// RR hors partie : bonus de montée de palier et protection de rang.
// Cas réel (Gogemine, dimanche 18 octobre) : Platine 2 · 87 -> Platine 3 · 13,
// soit +26, alors que ses parties annonçaient +13, −14, +13 = +12.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { rrBonuses, squadSessions, buildRecap } from "../netlify/functions/lib/recap-core.mjs";
import { recapSVG } from "../netlify/functions/lib/recap-card.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ctx = vm.createContext({ console, URL, URLSearchParams });
vm.runInContext(readFileSync(join(root, "app.js"), "utf8")
  + "\nglobalThis.__x = { rrBonus, rrGain, rrIndexFromSeries, sessionStats, rrChip };", ctx);
const X = ctx.__x;

const P2 = { id: 16, name: "Platinum 2" }, P3 = { id: 17, name: "Platinum 3" };
// La vraie série (blob cosmo-rr), dans l'ordre.
const SERIES = [
  { id: "e3f995c5", elo: 1387, rr: 87, change: 20, tier: P2, season: "e11a6", ts: Date.parse("2026-10-17T22:45:00Z") },
  { id: "9302756e", elo: 1410, rr: 10, change: 13, tier: P3, season: "e11a6", ts: Date.parse("2026-10-18T16:12:00Z") },
  { id: "79ff16bf", elo: 1400, rr: 0, change: -14, tier: P3, season: "e11a6", ts: Date.parse("2026-10-18T17:28:00Z") },
  { id: "5ff4b78c", elo: 1413, rr: 13, change: 13, tier: P3, season: "e11a6", ts: Date.parse("2026-10-18T21:09:00Z") },
];

test("site : +10 en montant de palier, +4 rendus par la protection de rang", () => {
  const idx = X.rrIndexFromSeries(SERIES);
  assert.equal(idx["9302756e"].bonus, 10);
  assert.equal(idx["79ff16bf"].bonus, 4);
  assert.equal(idx["5ff4b78c"].bonus, 0);
  assert.equal(X.rrGain(idx["9302756e"]), 23);
  assert.equal(X.rrGain(idx["79ff16bf"]), -10);
});

test("site : le bilan de la journée suit le niveau (+26), pas la somme des parties (+12)", () => {
  const idx = X.rrIndexFromSeries(SERIES);
  const M = (id) => ({ id, mode: "Competitive", result: idx[id].change > 0 ? "w" : "l", rr: idx[id], rounds: 22,
    me: { k: 10, d: 10, a: 5, score: 4000, hs: 20, shots: 100, dmg: 2500, acs: 200 } });
  const st = X.sessionStats([M("9302756e"), M("79ff16bf"), M("5ff4b78c")]);
  assert.equal(st.rrNet, 26);
  assert.equal(st.rrBonus, 14);
});

test("site : un écart sans raison (palier inchangé, pas de défaite à 0) n'est pas un bonus", () => {
  // Une partie manque dans l'historique : l'écart vient d'elle, pas de Riot.
  const prev = { elo: 1350, rr: 50, change: 10, tier: P2 };
  const e = { elo: 1385, rr: 85, change: 15, tier: P2 };
  assert.equal(X.rrBonus(prev, e), 0);
  // Écart énorme : on ne croit pas à un bonus.
  assert.equal(X.rrBonus({ elo: 1300, tier: P2 }, { elo: 1420, rr: 20, change: 20, tier: P3 }), 0);
});

test("site : la pastille orange accompagne le ±RR de la partie", () => {
  const idx = X.rrIndexFromSeries(SERIES);
  const html = X.rrChip(idx["9302756e"]);
  assert.match(html, /mrr-delta up">\+13</, "le ±RR de la partie reste celui du jeu");
  assert.match(html, /class="rr-bonus" title="\+10 RR de bonus en montant de palier">\+10</);
  assert.match(X.rrChip(idx["79ff16bf"]), /title="\+4 RR rendus par la protection de rang">\+4</);
  assert.doesNotMatch(X.rrChip(idx["5ff4b78c"]), /rr-bonus/);
});

test("récap Discord : même calcul côté serveur", () => {
  assert.deepEqual({ ...rrBonuses(SERIES) }, { "9302756e": 10, "79ff16bf": 4 });
  const game = (id, t, my, opp) => ({ meta: { id, started_at: new Date(t).toISOString(), mode: "Competitive", map: { name: "Abyss" } },
    stats: { team: "red", kills: 15, deaths: 12, assists: 4, score: 4200, damage: { made: 2800 }, shots: { head: 15, body: 70, leg: 5 }, character: { id: "breach", name: "Breach" } },
    teams: { red: my, blue: opp } });
  const games = [game("9302756e", SERIES[1].ts, 13, 9), game("79ff16bf", SERIES[2].ts, 8, 13), game("5ff4b78c", SERIES[3].ts, 13, 10)];
  const per = [
    { member: { name: "Gogemine", tag: "0202" }, matches: games, rr: SERIES },
    { member: { name: "joker", tag: "prft9" }, matches: games, rr: [] },
  ];
  const R = buildRecap(squadSessions(per, 6 * 3600000)[0]);
  const g = R.members.find((m) => m.name === "Gogemine");
  assert.equal(g.rr, 26);
  assert.equal(g.rrBonus, 14);
  const svg = recapSVG(R, { tz: "Europe/Paris", site: "x" });
  assert.match(svg, />\+26</);
  assert.match(svg, /dont \+14 bonus/);
});
