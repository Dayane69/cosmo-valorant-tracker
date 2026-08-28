// Tests des « invités » : des joueurs hors squad qui comptent pour les rapports
// de session, et pour rien d'autre.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { cleanAlias, cleanRoster } from "../netlify/functions/roster.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function load() {
  const ctx = vm.createContext({ console, URL, URLSearchParams, setTimeout, clearTimeout });
  let code = readFileSync(join(root, "app.js"), "utf8");
  code += `\nglobalThis.__x = { sessionRoster, indexSquadFromFullMatches, sessionComposition,
    sessionSquadReport, memberKey, sessionAlerts, mateMatch, feedSquadHist,
    getHist: () => SQUAD_HIST,
    setPeople: (r, g) => { ROSTER = r; GUESTS = g; PUUID_MEMBER = {}; SQUAD_HIST = null; } };`;
  vm.runInContext(code, ctx);
  return ctx.__x;
}
const X = load();

const MEMBERS = [
  { name: "Yakuza", tag: "2826", color: "#9aa7b2" },
  { name: "SevenDayy", tag: "6340", color: "#e07b2c" },
];
const GUESTS = [{ name: "Kevin", tag: "1234", color: "#c678dd", guest: true }];

const P = (name, tag, team, puuid) => ({ name, tag, team_id: team, puuid });
const full = (id, players) => ({ id, players });

const MIN = 60000;
let seq = 0;
function match(o = {}) {
  const rounds = o.rounds != null ? o.rounds : 24;
  return { id: o.id || "m" + (++seq), rounds, startedMs: o.startedMs || 0, durMs: 35 * MIN,
    map: "Ascent", mode: o.mode || "Competitive", result: o.result || "w",
    myScore: 13, oppScore: 11, forfeit: false, myTeamId: o.myTeamId || "Blue",
    party: o.party || null, facts: null, rr: o.rr || null,
    me: { k: 18, d: 15, a: 5, hs: 22, acs: 220, adr: 150, dd: 10, kd: 1.2, rounds,
      kast: 70, shots: 100, agent: "Jett", score100: o.score100 != null ? o.score100 : 65 } };
}

test("sessionRoster réunit la squad et les invités, ROSTER reste intact", () => {
  X.setPeople(MEMBERS, GUESTS);
  const all = X.sessionRoster();
  assert.equal(all.length, 3);
  assert.equal(all.map(p => p.name).join(","), "Yakuza,SevenDayy,Kevin");
  assert.equal(MEMBERS.length, 2, "la squad n'est pas modifiée");
});

test("un invité est reconnu dans le lobby, avec son drapeau", () => {
  X.setPeople(MEMBERS, GUESTS);
  const idx = X.indexSquadFromFullMatches([
    full("m1", [P("Yakuza", "2826", "Blue", "p1"), P("Kevin", "1234", "Blue", "p2"),
                P("Inconnu", "9999", "Blue", "p3"), P("Ennemi", "8888", "Red", "p4")]),
  ], {});
  assert.equal(idx.m1.length, 2, "Yakuza et Kevin ; l'inconnu et l'ennemi sont écartés");
  const kevin = idx.m1.find(e => e.name === "Kevin");
  assert.equal(kevin.guest, true);
  assert.equal(idx.m1.find(e => e.name === "Yakuza").guest, false);
});

test("sans la liste d'invités, ce joueur resterait un inconnu", () => {
  X.setPeople(MEMBERS, []);
  const idx = X.indexSquadFromFullMatches([
    full("m1", [P("Yakuza", "2826", "Blue", "p1"), P("Kevin", "1234", "Blue", "p2")]),
  ], {});
  assert.equal(idx.m1.length, 1);
  assert.equal(idx.m1[0].name, "Yakuza");
});

test("un invité compte dans la composition de la session", () => {
  X.setPeople(MEMBERS, GUESTS);
  const ms = [match({ id: "m1", myTeamId: "Blue" })];
  const squad = { m1: [{ key: X.memberKey(GUESTS[0]), name: "Kevin", tag: "1234", team: "Blue", guest: true }] };
  const c = X.sessionComposition(ms, squad, "yakuza#2826");
  assert.equal(c.dominant, 2, "jouer avec un invité, c'est jouer en duo");
  assert.equal(c.label, "Duo");
  assert.equal(c.mates[0].name, "Kevin");
  assert.equal(c.mates[0].guest, true, "…mais on sait que ce n'est pas un membre");
});

test("un invité figure dans le rapport commun, marqué comme tel", () => {
  X.setPeople(MEMBERS, GUESTS);
  const M = Object.assign(match({ id: "m1", myTeamId: "Blue", result: "w" }), {
    players: [P("Yakuza", "2826", "Blue", "p1"), P("Kevin", "1234", "Blue", "p2")],
    lines: [{ k: 20, d: 10, a: 4, acs: 260, adr: 160, hs: 25, kd: 2, rounds: 24, shots: 90, score100: 78, agent: "Cypher", team: "Blue" },
            { k: 14, d: 14, a: 7, acs: 190, adr: 130, hs: 19, kd: 1, rounds: 24, shots: 80, score100: 58, agent: "Sova", team: "Blue" }],
  });
  const squad = { m1: [{ key: X.memberKey(GUESTS[0]), name: "Kevin", tag: "1234", team: "Blue", guest: true }] };
  const rows = X.sessionSquadReport({ matches: [M] }, squad, "yakuza#2826", { name: "Yakuza", tag: "2826" });
  assert.equal(rows.length, 2);
  const kevin = rows.find(r => r.name === "Kevin");
  assert.ok(kevin, "l'invité apparaît");
  assert.equal(kevin.guest, true);
  assert.equal(kevin.st.index, 58, "ses stats viennent du scoreboard, faute d'historique stocké");
});

test("les invités ne déclenchent PAS d'alerte sur l'accueil", () => {
  // sessionAlerts ne reçoit que les membres : c'est l'appelant qui décide.
  X.setPeople(MEMBERS, GUESTS);
  const hier = new Date(2026, 7, 25, 20, 0).getTime();
  const ms = [0, 1, 2].map(i => match({ startedMs: hier + i * 40 * MIN, result: "l", rr: { change: -20 } }));
  const a = X.sessionAlerts([{ member: MEMBERS[0], matches: ms }], { now: new Date(2026, 7, 26, 12, 0).getTime() });
  assert.equal(a.length, 1);
  assert.equal(a[0].member.name, "Yakuza", "seuls les membres de la squad sont annoncés");
});

test("les parties fraîches alimentent le bandeau sans attendre le cron", () => {
  X.setPeople(MEMBERS, GUESTS);
  const key = X.memberKey(MEMBERS[0]);
  // Ce que le blob contient déjà (ancien), et ce qu'on vient de récupérer.
  X.feedSquadHist(key, [match({ id: "vieux", score100: 50 })]);
  X.feedSquadHist(key, [match({ id: "frais", score100: 80 })]);
  const ids = X.getHist()[key].map(m => m.id).sort();
  assert.equal(ids.join(","), "frais,vieux", "les deux sont conservés");
});

test("une partie présente des deux côtés : la version fraîche l'emporte", () => {
  X.setPeople(MEMBERS, GUESTS);
  const key = X.memberKey(MEMBERS[0]);
  X.feedSquadHist(key, [match({ id: "m1", score100: 50 })]);      // version stockée
  X.feedSquadHist(key, [match({ id: "m1", score100: 88 })]);      // version fraîche
  const hist = X.getHist()[key];
  assert.equal(hist.length, 1, "pas de doublon");
  assert.equal(hist[0].me.score100, 88, "c'est la fraîche qui reste");
});

/* ------------------------------------------------- assainissement serveur */

test("le serveur accepte les invités et les garde séparés des membres", () => {
  const saved = cleanRoster({
    region: "eu",
    members: [{ name: "Yakuza", tag: "2826", agent: "Cypher" }],
    guests: [{ name: "Kevin", tag: "1234", color: "#c678dd" }],
  });
  assert.equal(saved.members.length, 1);
  assert.equal(saved.guests.length, 1);
  assert.equal(saved.guests[0].name, "Kevin");
  assert.equal(saved.guests[0].agent, undefined, "un invité n'a pas de carte, donc pas d'agent");
  assert.equal(saved.guests[0].uuid, undefined);
});

test("un invité déjà membre de la squad n'est pas dupliqué", () => {
  const saved = cleanRoster({
    members: [{ name: "Yakuza", tag: "2826" }],
    guests: [{ name: "yakuza", tag: "2826" }, { name: "Kevin", tag: "1234" }],
  });
  assert.equal(saved.guests.length, 1, "Yakuza est déjà membre : il n'est pas aussi invité");
  assert.equal(saved.guests[0].name, "Kevin");
});

test("un invité en double dans sa propre liste n'est gardé qu'une fois", () => {
  const saved = cleanRoster({
    members: [{ name: "Yakuza", tag: "2826" }],
    guests: [{ name: "Kevin", tag: "1234" }, { name: "KEVIN", tag: "1234" }],
  });
  assert.equal(saved.guests.length, 1);
});

test("les invités mal formés sont écartés, et la liste est plafonnée", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ name: "G" + i, tag: "" + i }));
  const saved = cleanRoster({
    members: [{ name: "Yakuza", tag: "2826" }],
    guests: [{ name: "", tag: "1" }, { tag: "2" }, null, "pas un objet", ...many],
  });
  assert.ok(saved.guests.length <= 20, `plafonné (${saved.guests.length})`);
  assert.ok(saved.guests.every(g => g.name && g.tag));
});

test("aucun invité : la clé n'est pas écrite pour rien", () => {
  const saved = cleanRoster({ members: [{ name: "Yakuza", tag: "2826" }] });
  assert.equal(saved.guests, undefined);
  assert.equal(cleanRoster({ members: [{ name: "a", tag: "1" }], guests: "pas un tableau" }).guests, undefined);
});

test("un invité peut avoir des anciens pseudos, comme un membre", () => {
  const saved = cleanRoster({
    members: [{ name: "Yakuza", tag: "2826" }],
    guests: [{ name: "Kevin", tag: "1234", alias: ["KevOld#1234"] }],
  });
  assert.deepEqual(saved.guests[0].alias, ["KevOld#1234"]);
  assert.deepEqual(cleanAlias(["Kevin#1234"], "kevin#1234"), [], "son propre pseudo n'est pas un alias");
});

test("un roster sans membre reste invalide, même avec des invités", () => {
  assert.equal(cleanRoster({ members: [], guests: [{ name: "Kevin", tag: "1234" }] }), null);
});
