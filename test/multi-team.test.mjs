// Parties à plusieurs équipes — Gauntlet: Glitched (patch 13.06) : 16 joueurs,
// 8 duos. Tout le tracker supposait « ta team contre l'adverse » ; ces tests
// verrouillent ce qui change quand il y a sept autres équipes, et surtout ce
// qui NE change PAS pour une partie classique.
//
// La partie ci-dessous est reconstituée d'après le format annoncé par Riot
// (8 équipes de 2) : aucune vraie réponse d'API n'était disponible pour ce
// mode au moment d'écrire ces tests.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ctx = vm.createContext({ console, URL, URLSearchParams });
vm.runInContext(readFileSync(join(root, "app.js"), "utf8") + `
  globalThis.__x = { multiTeamOf, normMatch, matchFacts, scoreboardHTML, slimMatch, rehydrateMatch,
    resultWord, scoreText, setMe: (n, t) => { STATE.name = n; STATE.tag = t; } };`, ctx);
const X = ctx.__x;

const ME = { puuid: "A", name: "A", tag: "0" };
const st = { kills: 3, deaths: 2, assists: 1, score: 900, headshots: 3, bodyshots: 6, legshots: 1,
  damage: { dealt: 700, received: 500 } };
const player = (puuid, team) => ({ puuid, name: puuid, tag: "0", team_id: team,
  agent: { name: "Robo" }, tier: { id: 0, name: "Unrated" }, party_id: "p-" + team, stats: st });

// 8 équipes T1..T8, deux joueurs chacune. Moi (A) et mon duo (M) sommes T1.
const TEAMS = ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"];
function gauntlet({ withWinner = true } = {}) {
  const players = [player("A", "T1"), player("M", "T1"), player("E1", "T2"), player("E2", "T2")];
  TEAMS.slice(2).forEach(t => players.push(player(t + "a", t), player(t + "b", t)));
  // Bilans de rounds : T3 gagne le tournoi, nous finissons avec 5–3.
  const rec = { T1: [5, 3], T2: [4, 3], T3: [7, 1], T4: [3, 3], T5: [2, 3], T6: [1, 3], T7: [1, 3], T8: [0, 3] };
  const teams = TEAMS.map(t => ({ team_id: t, rounds: { won: rec[t][0], lost: rec[t][1] },
    ...(withWinner ? { won: t === "T3" } : {}) }));
  const K = (t, killer, kt, victim, vt) => ({ round: 0, time_in_round_in_ms: t,
    killer: { puuid: killer, name: killer, team: kt }, victim: { puuid: victim, name: victim, team: vt },
    assistants: [], weapon: { name: "Warden" } });
  return {
    metadata: { match_id: "g1", queue: { id: "gauntlet", name: "Gauntlet" }, map: { name: "Arena" } },
    players, teams,
    // Round 1 : quatre duels en même temps. Le premier kill du LOBBY est chez T3/T4 ;
    // dans MON duel, j'ouvre sur E1, mon duo tombe, puis je finis E2 seul : un 1v1.
    rounds: [{ winning_team: "T1", result: "Elimination", stats: [] }],
    kills: [
      K(1000, "T3a", "T3", "T4a", "T4"),
      K(2000, "A", "T1", "E1", "T2"),
      K(2500, "T5a", "T5", "T6b", "T6"),
      K(3000, "E2", "T2", "M", "T1"),
      K(4500, "A", "T1", "E2", "T2"),
    ],
  };
}
// Une partie classique 5v5, pour vérifier qu'on ne l'a pas abîmée.
function classic() {
  const players = [];
  ["A", "M", "B", "C", "D"].forEach(p => players.push(player(p, "Blue")));
  ["E1", "E2", "E3", "E4", "E5"].forEach(p => players.push(player(p, "Red")));
  return { metadata: { match_id: "c1", queue: { name: "Competitive" }, map: { name: "Ascent" } }, players,
    teams: [{ team_id: "Blue", rounds: { won: 13, lost: 9 }, won: true }, { team_id: "Red", rounds: { won: 9, lost: 13 }, won: false }],
    rounds: [], kills: [] };
}

test("forme : 8 duos = plusieurs équipes ; 5v5 et chacun-pour-soi n'en sont pas", () => {
  const g = gauntlet();
  assert.equal(X.multiTeamOf(g.players, g.teams).count, 8);
  const c = classic();
  assert.equal(X.multiTeamOf(c.players, c.teams), null, "deux équipes : le cas classique");
  // Deathmatch, quelle que soit la façon dont l'API l'encode : un joueur par équipe…
  const ffa = Array.from({ length: 14 }, (_, i) => player("P" + i, "P" + i));
  assert.equal(X.multiTeamOf(ffa, []), null, "chacun pour soi : pas des équipes");
  // …ou tout le monde dans la même.
  assert.equal(X.multiTeamOf(ffa.map(p => ({ ...p, team_id: "Blue" })), []), null);
});

test("résultat : le verdict de l'API, jamais un duel contre une équipe prise au hasard", () => {
  const M = X.normMatch(gauntlet(), ME);
  assert.equal(M.result, "l", "T3 a gagné, pas nous");
  assert.equal(M.multi.count, 8);
  assert.equal(M.myScore, 5);
  assert.equal(M.oppScore, 3, "le score est NOTRE bilan de rounds, pas celui d'une équipe adverse");
  assert.equal(X.scoreText(M), "5–3 en rounds");

  // Sans verdict explicite : on ne sait pas, et on le dit.
  const U = X.normMatch(gauntlet({ withWinner: false }), ME);
  assert.equal(U.result, "?");
  assert.equal(X.resultWord(U), "—", "surtout pas « DÉFAITE » par défaut");
});

test("détail des rounds : on lit MON duel, pas le premier kill du lobby", () => {
  const f = X.matchFacts(gauntlet(), 1, gauntlet().players[0]);
  assert.equal(f.firstBloods, 1, "j'ouvre mon duel, même si d'autres duels ont eu un kill avant");
  assert.equal(f.firstDeaths, 0);
  assert.equal(f.clutches, 1, "mon duo tombe, je finis seul");
  assert.equal(f.clutchKinds[0], "1v1", "un 1v1 — pas un « 1v13 » en comptant tout le lobby");
  // Le fil du round ne mélange pas les duels des autres au mien.
  assert.equal(f.timeline[0].kills.length, 3);
  assert.ok(f.timeline[0].kills.every(k => k.killerAlly || k.victimAlly));
});

test("scoreboard : un bloc par équipe, la mienne d'abord, la gagnante ensuite", () => {
  X.setMe("A", "0");
  const M = X.normMatch(gauntlet(), ME);
  const { html } = X.scoreboardHTML(M);
  const labels = [...html.matchAll(/class="teamlabel[^"]*">([^<]+)</g)].map(m => m[1]);
  assert.equal(labels.length, 8, "huit équipes, huit blocs");
  assert.match(labels[0], /^Ta team — 5–3 en rounds$/);
  assert.match(labels[1], /vainqueur/, "la gagnante juste après la mienne");
  assert.match(labels[1], /7–1/);
  assert.equal(html.includes("Adverse"), false, "« l'adverse » n'existe plus à huit équipes");
});

test("cache : le nombre d'équipes survit à l'instantané, et rien n'est ajouté aux parties classiques", () => {
  const M = X.normMatch(gauntlet(), ME, { facts: false });
  const back = X.rehydrateMatch(JSON.parse(JSON.stringify(X.slimMatch(M))));
  assert.equal(back.multi.count, 8);
  const c = X.slimMatch(X.normMatch(classic(), ME, { facts: false }));
  assert.equal("multi" in c, false, "pas un octet de plus pour les parties classiques");
});

test("partie classique : strictement inchangée", () => {
  const C = X.normMatch(classic(), ME);
  assert.equal("multi" in C, false);
  assert.equal(C.result, "w");
  assert.equal(C.myScore, 13);
  assert.equal(C.oppScore, 9, "à deux équipes, le score reste celui de l'adversaire");
  assert.equal(X.resultWord(C), "VICTOIRE");
  assert.equal(X.scoreText(C), "13–9");
});
