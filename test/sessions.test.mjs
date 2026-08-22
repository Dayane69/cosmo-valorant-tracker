// Tests des rapports de session : découpage par écart (jamais par jour
// calendaire), agrégats, référence de comparaison, tendance intra-session,
// composition solo/duo/trio et rapport commun.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function load() {
  const ctx = vm.createContext({ console, URL, URLSearchParams });
  let code = readFileSync(join(root, "app.js"), "utf8");
  code += `\nglobalThis.__x = { buildSessions, sessionStats, sessionFacts, sessionBaseline,
    sessionTrend, sessionComposition, sessionVerdict, analyzeSession, sessionSquadReport,
    bestWorst, matchDuration, durMs, memberKey, BASELINE_MIN, isRanked, rankedOnly, normStored,
    addSquadEntry, indexSquadFromFullMatches, mateMatch,
    sessionRecords, bestStreak, parseShareTarget, findSessionAt, RECORD_MIN_GAMES,
    setRoster: r => { ROSTER = r; }, setPuuidMap: p => { PUUID_MEMBER = p; },
    getPuuidMap: () => JSON.stringify(PUUID_MEMBER) };`;
  vm.runInContext(code, ctx);
  return ctx.__x;
}
const X = load();

const H = 3600000, MIN = 60000;
// Une partie normalisée minimale : ce dont le moteur de session a besoin.
let seq = 0;
function match(o = {}) {
  const id = o.id || "m" + (++seq);
  const rounds = o.rounds != null ? o.rounds : 24;
  return Object.assign({
    id, rounds, startedMs: o.startedMs || 0, durMs: o.durMs != null ? o.durMs : 35 * MIN,
    map: o.map || "Ascent", mode: o.mode || "Competitive", result: o.result || "w",
    myScore: o.myScore != null ? o.myScore : 13, oppScore: o.oppScore != null ? o.oppScore : 11,
    forfeit: !!o.forfeit, myTeamId: o.myTeamId || "Blue", party: o.party || null,
    facts: o.facts || null, rr: o.rr || null,
    me: Object.assign({
      k: 18, d: 15, a: 5, hs: 22, acs: 220, adr: 150, dd: 10, kd: 1.2,
      rounds, kast: 70, shots: 100, agent: o.agent || "Jett", score100: o.score100 != null ? o.score100 : 65,
    }, o.me || {}),
  }, { id, rounds });
}
// 22 août 2026 est un samedi.
const SAT23 = new Date("2026-08-22T23:00:00Z").getTime();

/* ---------------------------------------------------------------- découpage */

test("une session à cheval sur minuit reste UNE seule session", () => {
  // samedi 23h00, 23h40, dimanche 00h20, 01h00 -> enchaînées, écarts < 2 h.
  const ms = [0, 40, 80, 120].map(m => match({ startedMs: SAT23 + m * MIN, durMs: 35 * MIN }));
  const s = X.buildSessions(ms, 2 * H);
  assert.equal(s.length, 1, "le passage à minuit ne doit pas couper la session");
  assert.equal(s[0].matches.length, 4);
  // Elle finit bien le lendemain.
  assert.notEqual(new Date(s[0].startMs).getUTCDate(), new Date(s[0].endMs).getUTCDate());
});

test("deux sessions le MÊME jour restent deux sessions", () => {
  const midi = new Date("2026-08-22T12:00:00Z").getTime();
  const soir = new Date("2026-08-22T21:00:00Z").getTime();
  const ms = [
    match({ startedMs: midi }), match({ startedMs: midi + 40 * MIN }),
    match({ startedMs: soir }), match({ startedMs: soir + 40 * MIN }),
  ];
  const s = X.buildSessions(ms, 2 * H);
  assert.equal(s.length, 2);
  assert.equal(s[0].matches.length, 2);
  assert.equal(s[1].matches.length, 2);
  // La plus récente est en premier.
  assert.ok(s[0].startMs > s[1].startMs);
});

test("l'écart se mesure de la FIN d'une partie au DÉBUT de la suivante", () => {
  // Deux parties de 50 min séparées de 100 min de début à début : l'écart réel
  // n'est que de 50 min, elles appartiennent donc à la même session (seuil 1 h).
  const ms = [
    match({ startedMs: SAT23, durMs: 50 * MIN }),
    match({ startedMs: SAT23 + 100 * MIN, durMs: 50 * MIN }),
  ];
  assert.equal(X.buildSessions(ms, 1 * H).length, 1);
  // Avec un seuil de 30 min, l'écart de 50 min coupe bien.
  assert.equal(X.buildSessions(ms, 30 * MIN).length, 2);
});

test("le seuil de coupure change le nombre de sessions", () => {
  const ms = [
    match({ startedMs: SAT23, durMs: 30 * MIN }),
    match({ startedMs: SAT23 + 3 * H, durMs: 30 * MIN }),
  ];
  assert.equal(X.buildSessions(ms, 2 * H).length, 2, "2h30 d'écart -> deux sessions à 2 h");
  assert.equal(X.buildSessions(ms, 4 * H).length, 1, "…mais une seule à 4 h");
});

test("les parties sans horodatage sont ignorées, pas rattachées à tort", () => {
  const ms = [match({ startedMs: SAT23 }), match({ startedMs: 0 })];
  const s = X.buildSessions(ms, 2 * H);
  assert.equal(s.length, 1);
  assert.equal(s[0].matches.length, 1);
});

test("les parties d'une session sont classées dans l'ordre chronologique", () => {
  const ms = [
    match({ id: "c", startedMs: SAT23 + 80 * MIN }),
    match({ id: "a", startedMs: SAT23 }),
    match({ id: "b", startedMs: SAT23 + 40 * MIN }),
  ];
  const s = X.buildSessions(ms, 2 * H);
  assert.equal(s[0].matches.map(m => m.id).join(","), "a,b,c");
});

test("durée d'une partie : ms, secondes, ou repli sur le nombre de rounds", () => {
  assert.equal(X.durMs({ game_length_in_ms: 2400000 }), 2400000);
  assert.equal(X.durMs({ game_length: 2400 }), 2400000, "valeur en secondes -> ms");
  assert.equal(X.durMs({ game_length: 2400000 }), 2400000, "valeur déjà en ms -> inchangée");
  assert.equal(X.durMs({}), 0);
  // Sans durée connue, on estime ~100 s par round joué.
  assert.equal(X.matchDuration({ durMs: 0, rounds: 24 }), 2400000);
});

/* ----------------------------------------------------------------- agrégats */

test("sessionStats : bilan, rounds, K/D/A et RR net des seules parties classées", () => {
  const ms = [
    match({ result: "w", myScore: 13, oppScore: 7, me: { k: 20, d: 10, a: 4 }, rr: { change: 22 } }),
    match({ result: "l", myScore: 9, oppScore: 13, me: { k: 12, d: 18, a: 6 }, rr: { change: -18 } }),
    // Un deathmatch avec un RR renseigné ne doit PAS compter dans le RR net.
    match({ mode: "Deathmatch", result: "w", rr: { change: 999 } }),
  ];
  const st = X.sessionStats(ms);
  assert.equal(st.n, 3);
  assert.equal(st.wins, 2);
  assert.equal(st.losses, 1);
  assert.equal(st.rrGames, 2, "seules les parties classées comptent pour le RR");
  assert.equal(st.rrNet, 4, "22 - 18 = 4");
  assert.equal(st.k, 20 + 12 + 18);
  assert.equal(Math.round(st.winrate), 67);
  assert.ok(st.dpr > 0 && st.dpr < 2, "morts par round dans un ordre de grandeur crédible");
});

test("l'indice de session est pondéré par le nombre de rounds", () => {
  // Une longue partie ratée doit peser plus qu'un stomp court réussi.
  const ms = [
    match({ rounds: 26, score100: 40, me: { rounds: 26 } }),
    match({ rounds: 13, score100: 80, me: { rounds: 13 } }),
  ];
  const st = X.sessionStats(ms);
  const plain = (40 + 80) / 2;
  assert.ok(st.index < plain, `pondéré ${st.index} doit être sous la moyenne simple ${plain}`);
  assert.equal(Math.round(st.index), Math.round((40 * 26 + 80 * 13) / 39));
});

test("une partie sans ligne de stats ne fait pas planter l'agrégat", () => {
  const st = X.sessionStats([match({}), { id: "x", startedMs: 1, me: null }]);
  assert.equal(st.n, 1);
});

test("sessionFacts additionne les faits d'armes et ignore les parties compactes", () => {
  const facts = { firstBloods: 3, firstDeaths: 1, clutches: 1, plants: 2, defuses: 0,
    multi: { 3: 1, 5: 1 }, economy: { avgLoadout: 3800, buckets: { eco: { n: 4, won: 2 }, full: { n: 10, won: 6 } } } };
  const f = X.sessionFacts([match({ facts }), match({ facts }), match({})]);
  assert.equal(f.n, 2, "seules les parties avec détail de round comptent");
  assert.equal(f.firstBloods, 6);
  assert.equal(f.aces, 2, "un multikill à 5 est un ace");
  assert.equal(f.multi, 4);
  assert.equal(Math.round(f.ecoWR), 50);
  assert.equal(X.sessionFacts([match({})]), null, "aucune partie détaillée -> null, pas un objet vide");
});

/* --------------------------------------------------------------- références */

test("la référence exclut la session et se limite à ses modes", () => {
  const sess = { matches: [match({ id: "s1", mode: "Competitive" })] };
  const others = [];
  for (let i = 0; i < 8; i++) others.push(match({ id: "o" + i, mode: "Competitive", score100: 50 }));
  for (let i = 0; i < 8; i++) others.push(match({ id: "d" + i, mode: "Deathmatch", score100: 99 }));
  const base = X.sessionBaseline(sess, others.concat(sess.matches));
  assert.equal(base.n, 8, "seules les 8 ranked hors session servent de référence");
  assert.equal(Math.round(base.index), 50, "le deathmatch à 99 ne pollue pas la référence");
});

test("pas de référence quand l'historique est trop court", () => {
  const sess = { matches: [match({ id: "s1" })] };
  const few = [match({ id: "o1" }), match({ id: "o2" })];
  assert.equal(X.sessionBaseline(sess, few), null);
  assert.ok(X.BASELINE_MIN >= 3, "le seuil doit rester significatif");
});

/* ---------------------------------------------------------------- tendance */

test("sessionTrend compare la 1re moitié à la 2nde, sans chevauchement", () => {
  const ms = [80, 80, 40, 40].map((v, i) => match({ startedMs: SAT23 + i * 40 * MIN, score100: v }));
  const t = X.sessionTrend(ms);
  assert.equal(t.first, 80);
  assert.equal(t.last, 40);
  assert.equal(t.delta, -40, "baisse nette = signal de tilt");
});

test("sessionTrend gère un nombre impair de parties", () => {
  const ms = [90, 90, 90, 30, 30].map((v, i) => match({ startedMs: SAT23 + i * 40 * MIN, score100: v }));
  const t = X.sessionTrend(ms);
  assert.equal(t.n, 5);
  assert.equal(t.first, 90, "3 premières");
  assert.equal(t.last, 30, "2 dernières");
});

test("pas de tendance sous 4 parties : l'échantillon ne dit rien", () => {
  assert.equal(X.sessionTrend([match({}), match({}), match({})]), null);
});

/* ------------------------------------------------------------- composition */

// Index de squad : match_id -> membres présents, avec leur équipe.
function idx(entries) {
  const o = {};
  entries.forEach(e => { (o[e.id] = o[e.id] || []).push(e); });
  return o;
}

test("composition : solo quand personne d'autre de la squad n'est là", () => {
  const ms = [match({ id: "m1" }), match({ id: "m2" })];
  const c = X.sessionComposition(ms, {}, "moi#eu");
  assert.equal(c.dominant, 1);
  assert.equal(c.label, "Solo");
  assert.equal(c.mates.length, 0);
});

test("composition : duo / trio déduits du croisement des historiques", () => {
  const ms = [match({ id: "m1" }), match({ id: "m2" })];
  const squad = idx([
    { id: "m1", key: "gog#eu", name: "Gogemine", tag: "eu", team: "Blue", M: match({ id: "m1" }) },
    { id: "m2", key: "gog#eu", name: "Gogemine", tag: "eu", team: "Blue", M: match({ id: "m2" }) },
    { id: "m2", key: "koko#jetti", name: "koko", tag: "jetti", team: "Blue", M: match({ id: "m2" }) },
  ]);
  const c = X.sessionComposition(ms, squad, "moi#eu");
  assert.equal(c.mates.length, 2);
  assert.equal(c.mates[0].name, "Gogemine", "le plus présent en premier");
  assert.equal(c.mates[0].n, 2);
  assert.equal(c.mixed, true, "1 partie en duo + 1 en trio = composition variable");
  assert.equal(c.bySize[2], 1);
  assert.equal(c.bySize[3], 1);
});

test("un membre de la squad dans l'équipe ADVERSE ne compte pas comme coéquipier", () => {
  const ms = [match({ id: "m1", myTeamId: "Blue" })];
  const squad = idx([{ id: "m1", key: "gog#eu", name: "Gogemine", tag: "eu", team: "Red", M: match({ id: "m1" }) }]);
  const c = X.sessionComposition(ms, squad, "moi#eu");
  assert.equal(c.mates.length, 0);
  assert.equal(c.label, "Solo");
});

test("party_id révèle les joueurs hors squad, sans écraser le stack COSMO", () => {
  const ms = [match({ id: "m1", party: { size: 3, names: ["Gogemine", "Random"] } })];
  const squad = idx([{ id: "m1", key: "gog#eu", name: "Gogemine", tag: "eu", team: "Blue", M: match({ id: "m1" }) }]);
  const c = X.sessionComposition(ms, squad, "moi#eu");
  assert.equal(c.dominant, 2, "2 membres COSMO");
  assert.equal(c.partyMax, 3);
  assert.equal(c.partyExtra, 1, "le 3e joueur n'est pas de la squad");
});

test("le format compact du blob ne prétend pas connaître la party", () => {
  const M = X.normStored({ meta: { id: "z", map: { name: "Ascent" }, queue: "Competitive" },
    stats: { puuid: "p", team: "Blue", kills: 1, deaths: 1, assists: 0, score: 100 },
    teams: { blue: 13, red: 5 } }, { name: "moi", tag: "eu" });
  assert.equal(M.party, null, "party inconnue -> null, surtout pas 1 (= solo à tort)");
});

/* ----------------------------------------------------------------- verdicts */

test("verdict : bien joué mais mal payé", () => {
  const v = X.sessionVerdict({ index: 75, rrNet: -40, winrate: 25 }, { index: 60 }, null);
  assert.equal(v.word, "BIEN JOUÉ, MAL PAYÉ");
  assert.equal(v.tone, "mixed");
});

test("verdict : session portée quand le RR monte sans la perf", () => {
  const v = X.sessionVerdict({ index: 45, rrNet: 30, winrate: 75 }, { index: 62 }, null);
  assert.equal(v.word, "SESSION PORTÉE");
});

test("verdict : sans RR on retombe sur le winrate", () => {
  const good = X.sessionVerdict({ index: 70, rrNet: null, winrate: 80 }, { index: 55 }, null);
  assert.equal(good.word, "GROSSE SESSION");
  const bad = X.sessionVerdict({ index: 40, rrNet: null, winrate: 20 }, { index: 60 }, null);
  assert.equal(bad.word, "SESSION À OUBLIER");
});

test("verdict : sans référence, on ne prétend pas juger la performance", () => {
  const v = X.sessionVerdict({ index: 70, rrNet: 20, winrate: 60 }, null, null);
  assert.equal(v.dIndex, null);
  assert.equal(v.word, "SESSION POSITIVE", "le résultat seul, pas un jugement de perf");
});

/* ------------------------------------------------------------------ analyse */

const chrono = (n, o) => Array.from({ length: n }, (_, i) =>
  match(Object.assign({ startedMs: SAT23 + i * 40 * MIN }, typeof o === "function" ? o(i) : o)));

test("analyzeSession : une session au-dessus de la référence remonte du positif", () => {
  const sess = { matches: chrono(4, { score100: 82, me: { acs: 300, kd: 1.8, k: 25, d: 12 } }) };
  const base = X.sessionStats(chrono(10, { score100: 55, me: { acs: 200, k: 15, d: 16 } }));
  const A = X.analyzeSession(sess, { baseline: base });
  assert.ok(A.good.length >= 2, "au moins la perf globale et l'ACS");
  assert.ok(A.good.some(p => /Au-dessus de ton niveau/.test(p.title)));
  assert.equal(A.verdict.tone === "bad", false);
});

test("analyzeSession : la baisse en cours de session est détectée et donne un conseil", () => {
  const sess = { matches: chrono(6, i => ({ score100: i < 3 ? 80 : 45 })) };
  const A = X.analyzeSession(sess, { baseline: null });
  assert.ok(A.bad.some(p => /baisses en cours de session/.test(p.title)), "tilt détecté");
  assert.ok(A.tips.some(p => /Coupe plus tôt/.test(p.title)), "et transformé en conseil");
});

test("analyzeSession : sans référence, aucune règle comparative ne se déclenche", () => {
  const sess = { matches: chrono(3, { score100: 90 }) };
  const A = X.analyzeSession(sess, { baseline: null });
  assert.equal(A.good.some(p => /vs|habitude/.test(p.text)), false,
    "on n'invente pas une comparaison sans historique");
  assert.ok(A.tips.some(p => /Pas encore de référence/.test(p.title)), "et on le dit");
});

test("analyzeSession : les premières morts à répétition sont signalées", () => {
  const facts = { firstBloods: 1, firstDeaths: 6, clutches: 0, plants: 0, defuses: 0, multi: {},
    economy: { avgLoadout: 3000, buckets: {} } };
  const sess = { matches: chrono(3, { facts }) };
  const A = X.analyzeSession(sess, { baseline: null });
  assert.ok(A.bad.some(p => /meurs souvent en premier/.test(p.title)));
  assert.ok(A.tips.some(p => /Ne rentre pas en premier/.test(p.title)));
});

test("analyzeSession : les parties par forfait sont signalées comme non représentatives", () => {
  const sess = { matches: chrono(3, { forfeit: true, rounds: 6, myScore: 4, oppScore: 2 }) };
  const A = X.analyzeSession(sess, { baseline: null });
  assert.ok(A.tips.some(p => /écourtées/.test(p.title)));
});

test("analyzeSession : la divergence perf/RR produit le bon conseil", () => {
  const sess = { matches: chrono(4, { score100: 80, rr: { change: -15 }, result: "l" }) };
  const base = X.sessionStats(chrono(10, { score100: 60 }));
  const A = X.analyzeSession(sess, { baseline: base });
  assert.ok(A.tips.some(p => /Rien à changer côté perso/.test(p.title)));
});

test("bestWorst : pas de meilleur/pire sans au moins deux groupes qualifiés", () => {
  const ms = chrono(3, { map: "Ascent" });
  assert.equal(X.bestWorst(ms, m => m.map, 2), null);
  const mixed = [match({ map: "Ascent", score100: 80 }), match({ map: "Ascent", score100: 80 }),
                 match({ map: "Bind", score100: 40 }), match({ map: "Bind", score100: 40 })];
  const bw = X.bestWorst(mixed, m => m.map, 2);
  assert.equal(bw.best.key, "Ascent");
  assert.equal(bw.worst.key, "Bind");
});

/* ------------------------------------------------------------ rapport commun */

test("le rapport commun liste chaque membre avec SES stats sur la session", () => {
  const m1 = match({ id: "m1", myTeamId: "Blue" }), m2 = match({ id: "m2", myTeamId: "Blue" });
  const sess = { matches: [m1, m2] };
  const squad = idx([
    { id: "m1", key: "gog#eu", name: "Gogemine", tag: "eu", team: "Blue", M: match({ id: "m1", score100: 40 }) },
    { id: "m2", key: "gog#eu", name: "Gogemine", tag: "eu", team: "Blue", M: match({ id: "m2", score100: 40 }) },
    { id: "m1", key: "adv#eu", name: "Adversaire", tag: "eu", team: "Red", M: match({ id: "m1" }) },
  ]);
  const rows = X.sessionSquadReport(sess, squad, "moi#eu", { name: "Moi", tag: "eu" });
  assert.equal(rows.length, 2, "moi + Gogemine ; l'adversaire est exclu");
  assert.equal(rows[0].name, "Moi", "trié par indice, 65 > 40");
  assert.equal(rows[0].self, true);
  assert.equal(rows[1].name, "Gogemine");
  assert.equal(rows[1].st.n, 2);
  assert.equal(Math.round(rows[1].st.index), 40, "les chiffres du coéquipier viennent de SON historique");
});

test("le rapport commun d'une session solo ne contient que le joueur", () => {
  const sess = { matches: [match({ id: "m1" })] };
  const rows = X.sessionSquadReport(sess, {}, "moi#eu", { name: "Moi", tag: "eu" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].self, true);
});

test("memberKey est insensible à la casse (croisement fiable des historiques)", () => {
  assert.equal(X.memberKey({ name: "SEVENDAYY", tag: "6340" }), X.memberKey({ name: "sevendayy", tag: "6340" }));
});

/* ------------------------------------------------------- classé uniquement */

test("rankedOnly ne garde que le mode classé", () => {
  const list = [match({ mode: "Competitive" }), match({ mode: "Deathmatch" }),
                match({ mode: "Unrated" }), match({ mode: "Swiftplay" }),
                match({ mode: "Classé" }), match({ mode: "Team Deathmatch" })];
  const kept = X.rankedOnly(list).map(m => m.mode);
  assert.equal(kept.join(","), "Competitive,Classé");
});

test("les sessions se construisent sur les seules parties classées", () => {
  // Un deathmatch intercalé ne doit ni rallonger la session, ni la souder à la suivante.
  const ms = [
    match({ mode: "Competitive", startedMs: SAT23, durMs: 30 * MIN }),
    match({ mode: "Deathmatch", startedMs: SAT23 + 2 * H, durMs: 10 * MIN }),
    match({ mode: "Competitive", startedMs: SAT23 + 4 * H, durMs: 30 * MIN }),
  ];
  const s = X.buildSessions(X.rankedOnly(ms), 2 * H);
  assert.equal(s.length, 2, "les deux classées sont trop éloignées : deux sessions");
  assert.equal(s[0].matches.length, 1);
  assert.equal(s[0].matches[0].mode, "Competitive");
});

/* -------------------------------------- index de squad basé sur le roster */

const ROSTER_FIX = [
  { name: "Yakuza", tag: "2826", color: "#9aa7b2" },
  { name: "SevenDayy", tag: "6340", color: "#e07b2c" },
  { name: "Gogemine", tag: "0202", color: "#c8623a" },
];
// Partie au format complet : liste de joueurs avec les pseudos ACTUELS.
const full = (id, players) => ({ id, players });
const P = (name, tag, team, puuid) => ({ name, tag, team_id: team, puuid });

test("addSquadEntry ne duplique jamais un membre sur une même partie", () => {
  const idx = {};
  X.addSquadEntry(idx, "m1", { key: "a#1", name: "A", team: "Blue" });
  X.addSquadEntry(idx, "m1", { key: "a#1", name: "A", team: "Blue" });
  X.addSquadEntry(idx, "m1", { key: "b#2", name: "B", team: "Blue" });
  assert.equal(idx.m1.length, 2, "une équipe compte 5 joueurs, pas des doublons");
});

test("addSquadEntry complète une entrée du blob avec l'équipe du format complet", () => {
  const idx = {};
  X.addSquadEntry(idx, "m1", { key: "a#1", name: "A", team: null, M: { id: "m1" } });
  X.addSquadEntry(idx, "m1", { key: "a#1", name: "A", team: "Red" });
  assert.equal(idx.m1[0].team, "Red");
  assert.ok(idx.m1[0].M, "…sans perdre la ligne de stats venue du blob");
});

test("le format complet reconnaît un membre RENOMMÉ, via son pseudo actuel", () => {
  X.setRoster(ROSTER_FIX);            // le roster dit désormais « Yakuza »
  X.setPuuidMap({});
  const idx = X.indexSquadFromFullMatches([
    full("m1", [P("Yakuza", "2826", "Blue", "PU-yak"), P("SevenDayy", "6340", "Blue", "PU-sev"),
                P("Random", "9999", "Red", "PU-rnd")]),
  ], {});
  assert.equal(idx.m1.length, 2, "seuls les membres du roster sont retenus");
  assert.equal(idx.m1.map(e => e.name).sort().join(","), "SevenDayy,Yakuza");
  assert.equal(idx.m1[0].team, "Blue");
});

test("le puuid appris rattache une partie où le pseudo était encore l'ancien", () => {
  X.setRoster(ROSTER_FIX);
  X.setPuuidMap({});
  const idx = {};
  // 1) une partie récente donne le puuid de Yakuza…
  X.indexSquadFromFullMatches([full("m1", [P("Yakuza", "2826", "Blue", "PU-yak"), P("X", "1", "Red", "PU-x")])], idx);
  assert.ok(JSON.parse(X.getPuuidMap())["PU-yak"], "le puuid a été appris");
  // 2) …une partie plus ancienne, où il s'appelait encore Arsh26, est rattachée.
  X.indexSquadFromFullMatches([full("m2", [P("Arsh26", "2826", "Red", "PU-yak"), P("X", "1", "Blue", "PU-x")])], idx);
  assert.equal(idx.m2.length, 1);
  assert.equal(idx.m2[0].name, "Yakuza", "affiché sous son pseudo ACTUEL, celui du roster");
  assert.equal(idx.m2[0].team, "Red");
});

test("une partie au format compact n'alimente pas l'index par la liste de joueurs", () => {
  X.setRoster(ROSTER_FIX);
  X.setPuuidMap({});
  // normStored ne produit qu'UN joueur : on ne peut rien déduire du lobby.
  const idx = X.indexSquadFromFullMatches([full("m1", [P("Yakuza", "2826", "Blue", "PU-yak")])], {});
  assert.equal(Object.keys(idx).length, 0);
});

test("un membre retiré du roster n'apparaît plus dans les compositions", () => {
  X.setRoster([ROSTER_FIX[1]]);       // seul SevenDayy reste
  X.setPuuidMap({});
  const idx = X.indexSquadFromFullMatches([
    full("m1", [P("Yakuza", "2826", "Blue", "PU-yak"), P("SevenDayy", "6340", "Blue", "PU-sev")]),
  ], {});
  assert.equal(idx.m1.length, 1);
  assert.equal(idx.m1[0].name, "SevenDayy");
});

test("un coéquipier sans historique stocké garde ses stats, prises au scoreboard", () => {
  X.setRoster(ROSTER_FIX);
  X.setPuuidMap({});
  // Partie complète : je suis Blue, SevenDayy aussi. Son blob est vide.
  const M = Object.assign(match({ id: "m1", myTeamId: "Blue", result: "w", myScore: 13, oppScore: 8 }), {
    players: [P("Yakuza", "2826", "Blue", "PU-yak"), P("SevenDayy", "6340", "Blue", "PU-sev")],
    lines: [{ k: 20, d: 10, a: 4, acs: 260, adr: 160, hs: 25, kd: 2, rounds: 21, shots: 90, score100: 78, agent: "Cypher" },
            { k: 12, d: 16, a: 9, acs: 170, adr: 120, hs: 18, kd: 0.75, rounds: 21, shots: 80, score100: 51, agent: "Brimstone" }],
  });
  const mm = X.mateMatch(M, { key: X.memberKey({ name: "SevenDayy", tag: "6340" }), team: "Blue" });
  assert.ok(mm, "les stats du coéquipier sont récupérables depuis le scoreboard");
  assert.equal(mm.me.score100, 51);
  assert.equal(mm.result, "w", "même équipe -> même résultat");
  assert.equal(mm.rr, null, "son ±RR n'est pas connu depuis MA partie : on n'invente pas");

  const rows = X.sessionSquadReport({ matches: [M] },
    { m1: [{ key: X.memberKey({ name: "SevenDayy", tag: "6340" }), name: "SevenDayy", tag: "6340", team: "Blue" }] },
    "yakuza#2826", { name: "Yakuza", tag: "2826" });
  assert.equal(rows.length, 2, "le coéquipier apparaît bien dans le rapport commun");
  assert.equal(rows.map(r => r.name).join(","), "Yakuza,SevenDayy", "trié par indice");
});

test("un coéquipier introuvable au scoreboard n'est pas inventé", () => {
  X.setPuuidMap({});
  const M = Object.assign(match({ id: "m1", myTeamId: "Blue" }), { players: [], lines: [] });
  assert.equal(X.mateMatch(M, { key: "inconnu#0", team: "Blue" }), null);
});

test("la composition plafonne à 5 : une équipe Valorant n'a pas 8 joueurs", () => {
  const ms = [match({ id: "m1", myTeamId: "Blue" })];
  const squad = { m1: ["a", "b", "c", "d", "e", "f", "g"].map(k =>
    ({ key: k + "#1", name: k.toUpperCase(), tag: "1", team: "Blue" })) };
  const c = X.sessionComposition(ms, squad, "moi#eu");
  assert.equal(c.dominant, 5, "plafonné, plutôt que d'afficher un stack impossible");
  assert.equal(c.label, "5-stack");
});

/* -------------------------------------------------------- records de session */

// Fabrique une session prête à l'emploi à partir de parties chronologiques.
function sess(startMs, matches) {
  const list = matches.map((o, i) => match({ ...o, startedMs: startMs + i * 40 * MIN }));
  return { key: "s" + startMs, startMs, endMs: startMs + list.length * 40 * MIN,
           durationMs: list.length * 40 * MIN, matches: list };
}
const W = (o) => ({ result: "w", ...o }), L = (o) => ({ result: "l", ...o });

test("meilleure et pire session exigent un échantillon minimum", () => {
  const petite = sess(SAT23, [W({ score100: 99 }), W({ score100: 99 })]);   // 2 parties
  const vraie = sess(SAT23 - 10 * H, [W({ score100: 60 }), W({ score100: 62 }), L({ score100: 58 })]);
  const recs = X.sessionRecords([petite, vraie], {});
  const best = recs.find(r => r.key === "best");
  assert.ok(best, "il y a bien une meilleure session");
  assert.equal(best.value, 60, "la session de 2 parties à 99 ne peut pas être un record");
  assert.ok(X.RECORD_MIN_GAMES >= 3, "le seuil doit rester significatif");
});

test("meilleure / pire session sont bien départagées par l'indice", () => {
  const bonne = sess(SAT23, [W({ score100: 85 }), W({ score100: 88 }), W({ score100: 82 })]);
  const nulle = sess(SAT23 - 20 * H, [L({ score100: 30 }), L({ score100: 28 }), L({ score100: 35 })]);
  const recs = X.sessionRecords([bonne, nulle], {});
  assert.equal(recs.find(r => r.key === "best").session.key, bonne.key);
  assert.equal(recs.find(r => r.key === "worst").session.key, nulle.key);
});

test("remontée et chute de RR : seuls les signes correspondants sont retenus", () => {
  const monte = sess(SAT23, [W({ rr: { change: 25 } }), W({ rr: { change: 22 } }), W({ rr: { change: 20 } })]);
  const descend = sess(SAT23 - 20 * H, [L({ rr: { change: -18 } }), L({ rr: { change: -20 } }), L({ rr: { change: -15 } })]);
  const recs = X.sessionRecords([monte, descend], {});
  assert.equal(recs.find(r => r.key === "rrup").value, "+67 RR");
  assert.equal(recs.find(r => r.key === "rrdown").value, "-53 RR");
});

test("aucune session positive : pas de record de remontée inventé", () => {
  const only = sess(SAT23, [L({ rr: { change: -18 } }), L({ rr: { change: -20 } }), L({ rr: { change: -15 } })]);
  const recs = X.sessionRecords([only], {});
  assert.equal(recs.find(r => r.key === "rrup"), undefined);
  assert.ok(recs.find(r => r.key === "rrdown"), "la chute, elle, existe bien");
});

test("la session la plus longue se départage à la durée en cas d'égalité", () => {
  const courte = sess(SAT23 - 30 * H, [W(), W(), W()]);
  const longue = sess(SAT23, [W(), W(), W(), W(), W()]);
  const recs = X.sessionRecords([courte, longue], {});
  const rec = recs.find(r => r.key === "long");
  assert.equal(rec.value, "5 parties");
  assert.equal(rec.session.key, longue.key);
});

test("la série de victoires traverse les sessions et se rattache à sa fin", () => {
  const s1 = sess(SAT23 - 30 * H, [W(), W(), W()]);
  const s2 = sess(SAT23, [W(), W(), L()]);
  const recs = X.sessionRecords([s1, s2], {});
  const st = recs.find(r => r.key === "streak");
  assert.equal(st.value, "5 victoires", "3 + 2 d'affilée, la défaite finale coupe");
  assert.equal(st.session.key, s2.key, "rattachée à la session où elle se termine");
});

test("bestStreak : une victoire isolée n'est pas une série", () => {
  const one = [match({ result: "w", startedMs: 1 }), match({ result: "l", startedMs: 2 })];
  assert.equal(X.bestStreak(one), null);
  const two = [match({ result: "w", startedMs: 1 }), match({ result: "w", startedMs: 2 }), match({ result: "l", startedMs: 3 })];
  assert.equal(X.bestStreak(two).n, 2);
});

test("bestStreak remet les parties dans l'ordre avant de compter", () => {
  const shuffled = [
    match({ result: "w", startedMs: 3000 }), match({ result: "l", startedMs: 1000 }),
    match({ result: "w", startedMs: 2000 }),
  ];
  assert.equal(X.bestStreak(shuffled).n, 2, "défaite puis 2 victoires");
});

test("la meilleure session commune ne retient que les sessions à plusieurs", () => {
  const solo = sess(SAT23, [W({ id: "s1" }), W({ id: "s2" }), W({ id: "s3" })].map(o => ({ ...o, score100: 90 })));
  const duo = sess(SAT23 - 20 * H, [W({ id: "d1" }), W({ id: "d2" }), W({ id: "d3" })].map(o => ({ ...o, score100: 70 })));
  const squad = {};
  duo.matches.forEach(m => { squad[m.id] = [{ key: "gog#eu", name: "Gogemine", tag: "eu", team: m.myTeamId }]; });
  const recs = X.sessionRecords([solo, duo], { squadIndex: squad, selfKey: "moi#eu" });
  const team = recs.find(r => r.key === "team");
  assert.equal(team.session.key, duo.key, "la session solo à 90 n'est pas une session commune");
  assert.match(team.sub, /Gogemine/);
});

test("sans historique, aucun record n'est fabriqué", () => {
  assert.equal(X.sessionRecords([], {}).length, 0);
  assert.equal(X.sessionRecords(null, {}).length, 0);
});

/* ------------------------------------------------------ liens de partage */

test("parseShareTarget lit joueur, horodatage et coupure", () => {
  const t = X.parseShareTarget("?s=Yakuza%232826&t=1783357329127&g=180");
  assert.equal(t.name, "Yakuza");
  assert.equal(t.tag, "2826");
  assert.equal(t.ts, 1783357329127);
  assert.equal(t.gap, 180);
});

test("parseShareTarget découpe sur le DERNIER # (pseudo contenant un #)", () => {
  const t = X.parseShareTarget("?s=" + encodeURIComponent("Mon#Pseudo#2826") + "&t=1000");
  assert.equal(t.name, "Mon#Pseudo");
  assert.equal(t.tag, "2826");
});

test("un lien incomplet ou absurde ne déclenche rien", () => {
  assert.equal(X.parseShareTarget("?t=1000"), null, "sans joueur");
  assert.equal(X.parseShareTarget("?s=A%231"), null, "sans horodatage");
  assert.equal(X.parseShareTarget("?s=sansdiese&t=1000"), null);
  assert.equal(X.parseShareTarget("?s=A%231&t=zero"), null, "horodatage non numérique");
  assert.equal(X.parseShareTarget(""), null);
});

test("une coupure hors bornes est ignorée plutôt que d'être appliquée", () => {
  // Une coupure farfelue déplacerait les frontières et ferait pointer le lien
  // sur une autre session que celle partagée.
  assert.equal(X.parseShareTarget("?s=A%231&t=1000&g=99999").gap, null);
  assert.equal(X.parseShareTarget("?s=A%231&t=1000&g=1").gap, null);
  assert.equal(X.parseShareTarget("?s=A%231&t=1000&g=120").gap, 120);
});

test("findSessionAt retrouve la session par début exact", () => {
  const a = sess(SAT23, [W(), W()]), b = sess(SAT23 - 20 * H, [W()]);
  assert.equal(X.findSessionAt([a, b], SAT23).key, a.key);
});

test("findSessionAt tolère un horodatage TOMBANT DANS la session", () => {
  const a = sess(SAT23, [W(), W(), W()]);
  assert.equal(X.findSessionAt([a], SAT23 + 50 * MIN).key, a.key, "au milieu de la session");
});

test("findSessionAt accepte un léger décalage, mais pas n'importe quoi", () => {
  const a = sess(SAT23, [W(), W()]);
  assert.equal(X.findSessionAt([a], SAT23 - 2 * H).key, a.key, "2 h d'écart : toléré");
  assert.equal(X.findSessionAt([a], SAT23 - 48 * H), null, "2 jours d'écart : refusé");
  assert.equal(X.findSessionAt([], SAT23), null);
  assert.equal(X.findSessionAt([a], 0), null);
});
