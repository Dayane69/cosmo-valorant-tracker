// Tests du détail de partie : timeline, faits d'armes, duels et lobby.
// Tout est calculé depuis les données de round déjà présentes dans la réponse.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ctx = vm.createContext({ console });
vm.runInContext(readFileSync(join(root, "app.js"), "utf8") +
  "\nglobalThis.__x = { matchFacts, normMatch };", ctx);
const X = ctx.__x;

// Joueur : 2 par équipe pour garder les scénarios lisibles.
const P = (puuid, team, name = puuid) => ({ puuid, name, tag: "0", team_id: team,
  agent: { name: "Jett" }, tier: { name: "Gold 2" }, party_id: "party-" + team,
  stats: { kills: 5, deaths: 5, assists: 2, score: 1200, headshots: 5, bodyshots: 10, legshots: 1,
    damage: { dealt: 900, received: 900 } } });

const K = (round, t, killer, victim, opts = {}) => ({ round, time_in_round_in_ms: t,
  killer: { puuid: killer, name: killer, team: opts.kt || "Blue" },
  victim: { puuid: victim, name: victim, team: opts.vt || "Red" },
  assistants: (opts.assists || []).map(a => ({ puuid: a, name: a })),
  weapon: { name: opts.weapon || "Vandal" } });

// Round avec les stats de "moi" (dégâts infligés à chaque victime).
const R = (winner, opts = {}) => ({
  result: opts.result || "Elimination", ceremony: opts.ceremony || "CeremonyDefault", winning_team: winner,
  plant: opts.plant || null, defuse: opts.defuse || null,
  stats: (opts.stats || []).map(s => ({
    player: { puuid: s.p, name: s.p, team: s.team || "Blue" },
    stats: { score: s.score || 0, kills: s.kills || 0, headshots: 0, bodyshots: 0, legshots: 0 },
    economy: { loadout_value: s.loadout || 3900, remaining: 500,
      weapon: { name: s.weapon || "Vandal" }, armor: { name: "Heavy Armor" } },
    ability_casts: {}, was_afk: !!s.afk,
    damage_events: (s.dmg || []).map(([who, d]) => ({ player: { puuid: who, name: who, team: "Red" }, damage: d })),
  })),
});

test("matchFacts : timeline, first bloods/deaths, multikills, plants et défuses", () => {
  const m = {
    players: [P("A", "Blue"), P("M", "Blue"), P("E1", "Red"), P("E2", "Red")],
    rounds: [
      // R1 : je prends le first blood puis un 2e kill (multikill 2k), spike posée par moi
      R("Blue", { plant: { site: "B", player: { puuid: "A", name: "A" } },
        stats: [{ p: "A", kills: 2, score: 300, dmg: [["E1", 150], ["E2", 100]] }] }),
      // R2 : je meurs en premier (first death)
      R("Red", { result: "Detonate", stats: [{ p: "A", kills: 0, dmg: [["E1", 40]] }] }),
      // R3 : je désamorce
      R("Blue", { result: "Defuse", defuse: { player: { puuid: "A", name: "A" } },
        stats: [{ p: "A", kills: 1, dmg: [["E2", 130]] }] }),
    ],
    kills: [
      K(0, 5000, "A", "E1"), K(0, 9000, "A", "E2"),
      K(1, 4000, "E1", "A", { kt: "Red", vt: "Blue" }),
      K(2, 6000, "A", "E2"),
    ],
  };
  const f = X.matchFacts(m, 3, m.players[0]);
  assert.equal(f.timeline.length, 3, "un élément par round");
  assert.equal(f.firstBloods, 2, "j'ouvre le round 1 et le round 3");
  assert.equal(f.firstDeaths, 1, "je tombe en premier au round 2");
  // Comparaison via JSON : les objets viennent du contexte vm (autre realm).
  assert.equal(JSON.stringify(f.multi), JSON.stringify({ 2: 1 }), "un seul multikill (2k au round 1)");
  assert.equal(f.plants, 1);
  assert.equal(f.defuses, 1);

  const r1 = f.timeline[0];
  assert.equal(r1.won, true);
  assert.equal(r1.myKills, 2);
  assert.equal(r1.myDmg, 250, "dégâts du round = somme des damage_events");
  assert.equal(r1.weapon, "Vandal");
  assert.equal(r1.plant.site, "B");
  assert.equal(r1.plant.mine, true);
  assert.equal(r1.kills.length, 2, "le détail du round liste les éliminations");
  assert.equal(r1.kills[0].mine, true);
  assert.equal(f.timeline[1].kills[0].onMe, true, "la mort du round 2 est bien la mienne");
});

test("matchFacts : clutch détecté quand je finis seul contre au moins un ennemi", () => {
  const m = {
    players: [P("A", "Blue"), P("M", "Blue"), P("E1", "Red"), P("E2", "Red")],
    rounds: [R("Blue", { ceremony: "CeremonyClutch", stats: [{ p: "A", kills: 2 }] })],
    kills: [
      K(0, 3000, "E1", "M", { kt: "Red", vt: "Blue" }),   // mon coéquipier tombe -> je suis seul
      K(0, 6000, "A", "E1"),                               // je tue après
      K(0, 9000, "A", "E2"),
    ],
  };
  const f = X.matchFacts(m, 1, m.players[0]);
  assert.equal(f.clutches, 1);
  assert.equal(f.clutchKinds.join(","), "1v2", "il restait 2 ennemis quand je me suis retrouvé seul");
});

test("matchFacts : pas de clutch si je meurs ou si mon équipe perd", () => {
  const base = (winner, meDies) => ({
    players: [P("A", "Blue"), P("M", "Blue"), P("E1", "Red"), P("E2", "Red")],
    rounds: [R(winner, { stats: [{ p: "A", kills: 1 }] })],
    kills: [
      K(0, 3000, "E1", "M", { kt: "Red", vt: "Blue" }),
      K(0, 5000, "A", "E1"),
      ...(meDies ? [K(0, 7000, "E2", "A", { kt: "Red", vt: "Blue" })] : []),
    ],
  });
  assert.equal(X.matchFacts(base("Blue", true), 1, base("Blue", true).players[0]).clutches, 0, "je suis mort");
  assert.equal(X.matchFacts(base("Red", false), 1, base("Red", false).players[0]).clutches, 0, "équipe perdante");
});

test("matchFacts : duels (dégâts infligés et subis) et groupes du lobby", () => {
  const m = {
    players: [P("A", "Blue"), P("M", "Blue"), P("E1", "Red"), P("E2", "Red")],
    rounds: [R("Blue", { stats: [
      { p: "A", kills: 1, dmg: [["E1", 120], ["E2", 60]] },
      { p: "E1", team: "Red", dmg: [["A", 90]] },     // E1 me met 90
      { p: "E2", team: "Red", dmg: [["M", 50]] },     // sur un coéquipier : ne me concerne pas
    ] })],
    kills: [K(0, 5000, "A", "E1")],
  };
  const f = X.matchFacts(m, 1, m.players[0]);
  const e1 = f.duels.find(d => d.name === "E1"), e2 = f.duels.find(d => d.name === "E2");
  assert.equal(e1.dealt, 120); assert.equal(e1.received, 90);
  assert.equal(e2.dealt, 60);  assert.equal(e2.received, 0, "les dégâts sur un coéquipier ne comptent pas");
  assert.equal(f.duels.length, 2, "uniquement les adversaires");

  assert.equal(f.lobby.length, 4);
  assert.equal(f.lobby.find(p => p.name === "A").isMe, true);
  // party_id partagé par 2 joueurs -> un numéro de groupe est attribué
  assert.ok(f.lobby.find(p => p.name === "A").group > 0, "groupe détecté");
  assert.equal(f.lobby.find(p => p.name === "A").group, f.lobby.find(p => p.name === "M").group,
    "les deux Blue sont dans le même groupe");
});

test("matchFacts : renvoie null sans données de round (parties compactes du blob)", () => {
  assert.equal(X.matchFacts({ players: [P("A", "Blue")], rounds: [], kills: [] }, 0, P("A", "Blue")), null);
  assert.equal(X.matchFacts({}, 0, P("A", "Blue")), null);
  assert.equal(X.matchFacts({ rounds: [R("Blue", {})] }, 1, null), null, "sans joueur identifié");
});

test("normMatch attache les facts, et les garde compacts", () => {
  const raw = "/tmp/m1.json";
  if (!existsSync(raw)) return; // partie réelle non disponible hors session de dev
  const m = JSON.parse(readFileSync(raw, "utf8")).data[0];
  const M = X.normMatch(m, { puuid: null, name: "SevenDayy", tag: "6340" });
  assert.ok(M.facts, "facts présents sur une partie complète");
  assert.equal(M.facts.timeline.length, M.rounds, "un élément de timeline par round");
  assert.ok(M.facts.lobby.length === 10 && M.facts.duels.length === 5);
  // On ne doit PAS retenir les tableaux bruts (des centaines de Ko par match).
  const poids = JSON.stringify(M.facts).length, brut = JSON.stringify(m).length;
  assert.ok(poids < brut / 10, `facts compacts (${(poids/1024)|0} Ko contre ${(brut/1024)|0} Ko)`);
});
