// Tests des alertes de session (accueil) et du verdict v2 du tribunal, qui
// croise désormais la PERFORMANCE et le RÉSULTAT au lieu du seul indice.
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
  code += `\nglobalThis.__x = { sessionAlerts, relDay, computeVerdict, Z,
    ALERT_MIN_GAMES, ALERT_TILT, ALERT_RR, ALERT_DAYS, TRIB_PERF_HIGH, TRIB_PERF_LOW,
    gamingDayStart, DAY_CUTOFF_H };`;
  vm.runInContext(code, ctx);
  return ctx.__x;
}
const X = load();

const MIN = 60000, H = 3600000, DAY = 86400000;
// Un « maintenant » fixe : mercredi 26 août 2026, 12:00 locale.
const NOW = new Date(2026, 7, 26, 12, 0, 0).getTime();

let seq = 0;
function match(o = {}) {
  const rounds = o.rounds != null ? o.rounds : 24;
  return { id: o.id || "m" + (++seq), rounds, startedMs: o.startedMs || 0,
    durMs: 35 * MIN, map: "Ascent", mode: o.mode || "Competitive",
    result: o.result || "w", myScore: 13, oppScore: 11, forfeit: false,
    myTeamId: "Blue", party: null, facts: null, rr: o.rr || null,
    me: { k: 18, d: 15, a: 5, hs: 22, acs: 220, adr: 150, dd: 10, kd: 1.2,
      rounds, kast: 70, shots: 100, agent: "Jett",
      score100: o.score100 != null ? o.score100 : 65 } };
}
const MEMBER = { name: "Yakuza", tag: "2826", color: "#9aa7b2" };
// n parties enchaînées à partir de startMs, indices donnés un par un.
const run = (startMs, scores, opts = {}) => scores.map((sc, i) =>
  match({ startedMs: startMs + i * 40 * MIN, score100: sc,
          result: opts.results ? opts.results[i] : "w",
          rr: opts.rr ? { change: opts.rr[i] } : null }));

/* ------------------------------------------------------------- formulation */

test("relDay dit « hier soir », « ce matin », jamais une date brute", () => {
  // NOW = mercredi 26 août, 12 h. Les écarts sont comptés en JOURNÉES DE JEU
  // (coupure à 5 h), pas en jours calendaires.
  assert.equal(X.relDay(new Date(2026, 7, 25, 22, 0).getTime(), NOW), "hier soir");
  assert.equal(X.relDay(new Date(2026, 7, 26, 9, 0).getTime(), NOW), "ce matin");
  assert.equal(X.relDay(new Date(2026, 7, 26, 15, 0).getTime(), NOW), "cet après-midi");
  // 2 h du matin appartient à la soirée de la veille : « la nuit dernière ».
  assert.equal(X.relDay(new Date(2026, 7, 26, 2, 0).getTime(), NOW), "la nuit dernière");
  // 1 h du matin le 25 = la soirée du 24, soit deux journées de jeu en arrière.
  assert.equal(X.relDay(new Date(2026, 7, 25, 1, 0).getTime(), NOW), "il y a 2 jours");
  assert.equal(X.relDay(new Date(2026, 7, 23, 20, 0).getTime(), NOW), "il y a 3 jours");
});

/* ------------------------------------------------- journée de jeu (5 h) */

test("la journée de jeu coupe à 5 h, pas à minuit", () => {
  assert.equal(X.DAY_CUTOFF_H, 5);
  const sam23 = new Date(2026, 7, 22, 23, 0).getTime();   // samedi 23 h
  const dim02 = new Date(2026, 7, 23, 2, 0).getTime();    // dimanche 2 h
  const dim06 = new Date(2026, 7, 23, 6, 0).getTime();    // dimanche 6 h
  assert.equal(X.gamingDayStart(sam23), X.gamingDayStart(dim02), "2 h du matin appartient encore à la soirée du samedi");
  assert.notEqual(X.gamingDayStart(dim02), X.gamingDayStart(dim06), "…mais 6 h démarre bien une nouvelle journée");
});

test("à 2 h du matin, la session de 23 h reste « ce soir »", () => {
  const sam23 = new Date(2026, 7, 22, 23, 0).getTime();
  const dim02 = new Date(2026, 7, 23, 2, 0).getTime();    // on est encore debout
  assert.equal(X.relDay(sam23, dim02), "ce soir", "et surtout pas « hier soir »");
});

test("une fois la journée passée, la nuit devient bien « la nuit dernière »", () => {
  const dim02 = new Date(2026, 7, 23, 2, 0).getTime();
  const dim14 = new Date(2026, 7, 23, 14, 0).getTime();   // le lendemain après-midi
  assert.equal(X.relDay(dim02, dim14), "la nuit dernière");
});

test("une session à cheval sur minuit ne compte que pour un seul jour", () => {
  // 23 h -> 01 h : un seul évènement, donc une seule alerte.
  const sam23 = new Date(2026, 7, 22, 23, 0).getTime();
  const dimAprem = new Date(2026, 7, 23, 15, 0).getTime();
  const a = X.sessionAlerts([{ member: MEMBER, matches: run(sam23, [85, 82, 80, 45, 42, 40]) }],
    { now: dimAprem });
  assert.equal(a.length, 1);
});

/* ---------------------------------------------------------------- alertes */

test("session longue qui s'effondre : c'est l'alerte demandée", () => {
  const hier = new Date(2026, 7, 25, 20, 0).getTime();
  // Bilan à l'équilibre : la baisse est bien le sujet.
  const a = X.sessionAlerts([{ member: MEMBER,
    matches: run(hier, [80, 78, 82, 50, 44, 48], { results: ["w", "w", "w", "l", "l", "l"] }) }], { now: NOW });
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, "tilt");
  assert.match(a[0].text, /6 parties d'affilée hier soir/);
  assert.match(a[0].text, /les 3 dernières bien en dessous/);
  assert.equal(a[0].tone, "warn");
});

test("une session courte, même en baisse, ne déclenche rien", () => {
  const hier = new Date(2026, 7, 25, 20, 0).getTime();
  const a = X.sessionAlerts([{ member: MEMBER, matches: run(hier, [85, 80, 40, 35]) }], { now: NOW });
  assert.equal(a.filter(x => x.kind === "tilt").length, 0,
    `il faut au moins ${X.ALERT_MIN_GAMES} parties pour parler de session trop longue`);
});

test("une session longue mais stable ne sonne pas l'alarme", () => {
  const hier = new Date(2026, 7, 25, 20, 0).getTime();
  const a = X.sessionAlerts([{ member: MEMBER, matches: run(hier, [70, 68, 72, 69, 71, 70, 73]) }], { now: NOW });
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, "recap", "jouer longtemps n'est pas un problème en soi");
  assert.equal(a[0].tone, "info");
});

test("un récapitulatif est toujours produit : le bandeau n'est jamais vide après avoir joué", () => {
  const hier = new Date(2026, 7, 25, 20, 0).getTime();
  // Session parfaitement quelconque : 3 parties, bilan neutre, RR nul.
  const a = X.sessionAlerts([{ member: MEMBER,
    matches: run(hier, [66, 64, 68], { results: ["w", "l", "w"], rr: [18, -17, 0] }) }], { now: NOW });
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, "recap");
  assert.match(a[0].text, /3 parties hier soir/);
  assert.match(a[0].text, /2V-1D/);
  assert.match(a[0].text, /indice/);
});

test("le récapitulatif s'efface devant un évènement marquant du même jour", () => {
  const hier = new Date(2026, 7, 25, 20, 0).getTime();
  const a = X.sessionAlerts([{ member: MEMBER,
    matches: run(hier, [62, 60, 58], { results: ["l", "l", "l"], rr: [-15, -14, -13] }) }], { now: NOW });
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, "rrdrop", "la chute de RR passe devant le simple récapitulatif");
});

test("une soirée gagnante n'est jamais accusée d'être partie en vrille", () => {
  const hier = new Date(2026, 7, 25, 20, 0).getTime();
  // Indice en chute libre, mais 5 victoires sur 6 : ce n'est pas un tilt.
  const a = X.sessionAlerts([{ member: MEMBER,
    matches: run(hier, [90, 88, 86, 45, 42, 40],
      { results: ["w", "w", "w", "w", "w", "l"], rr: [22, 21, 20, 19, 18, -14] }) }], { now: NOW });
  assert.notEqual(a[0].kind, "tilt");
  assert.equal(a[0].kind, "hot");
});

test("une grosse remontée alerte même si la fin de session est moins bonne", () => {
  // Le cas réel qui ne déclenchait rien : +68 RR avec une tendance négative.
  const hier = new Date(2026, 7, 25, 20, 0).getTime();
  const a = X.sessionAlerts([{ member: MEMBER,
    matches: run(hier, [85, 82, 80, 60, 58], { results: ["w", "w", "w", "w", "l"], rr: [22, 21, 20, 19, -14] }) }],
    { now: NOW });
  assert.equal(a[0].kind, "hot", "+68 RR reste une bonne nouvelle");
});

test("une grosse chute de RR alerte, une belle remontée aussi", () => {
  const hier = new Date(2026, 7, 25, 20, 0).getTime();
  const chute = X.sessionAlerts([{ member: MEMBER,
    matches: run(hier, [60, 62, 58], { results: ["l", "l", "l"], rr: [-18, -20, -17] }) }], { now: NOW });
  assert.equal(chute[0].kind, "rrdrop");
  assert.match(chute[0].text, /-55 RR hier soir/);

  const monte = X.sessionAlerts([{ member: MEMBER,
    matches: run(hier, [70, 72, 74], { results: ["w", "w", "w"], rr: [20, 22, 21] }) }], { now: NOW });
  assert.equal(monte[0].kind, "hot", "le bandeau n'est pas qu'un rabat-joie");
  assert.equal(monte[0].tone, "good");
});

test("au-delà de 48 h, on ne montre rien", () => {
  assert.equal(X.ALERT_DAYS, 2, "la fenêtre est bien de 48 h");
  const vieux = NOW - 10 * DAY;
  assert.equal(X.sessionAlerts([{ member: MEMBER, matches: run(vieux, [80, 78, 82, 50, 44, 48]) }], { now: NOW }).length, 0);
  // Juste à l'intérieur de la fenêtre : conservé.
  const hier = new Date(2026, 7, 25, 20, 0).getTime();
  assert.equal(X.sessionAlerts([{ member: MEMBER, matches: run(hier, [80, 78, 82, 50, 44, 48]) }], { now: NOW }).length, 1);
  // Trois jours en arrière : hors fenêtre, même si la session est spectaculaire.
  const troisJours = new Date(2026, 7, 23, 20, 0).getTime();
  assert.equal(X.sessionAlerts([{ member: MEMBER, matches: run(troisJours, [95, 92, 90, 20, 18, 15]) }], { now: NOW }).length, 0);
});




test("une session dans le futur (horloge décalée) n'est pas annoncée", () => {
  const plusTard = NOW + 6 * H;
  assert.equal(X.sessionAlerts([{ member: MEMBER, matches: run(plusTard, [80, 80, 80, 45, 43, 40]) }],
    { now: NOW }).length, 0);
});


test("les modes non classés ne créent pas d'alertes", () => {
  const hier = new Date(2026, 7, 25, 20, 0).getTime();
  const dm = run(hier, [90, 88, 85, 30, 28, 25]).map(m => ({ ...m, mode: "Deathmatch" }));
  assert.equal(X.sessionAlerts([{ member: MEMBER, matches: dm }], { now: NOW }).length, 0);
});

test("aucun historique : aucune alerte, aucune erreur", () => {
  assert.equal(X.sessionAlerts([], { now: NOW }).length, 0);
  assert.equal(X.sessionAlerts(null, { now: NOW }).length, 0);
  assert.equal(X.sessionAlerts([{ member: MEMBER, matches: [] }], { now: NOW }).length, 0);
});

test("le bandeau ne montre QUE la session la plus récente", () => {
  const soir = d => new Date(2026, 7, d, 20, 0).getTime();
  // Trois soirs d'affilée, dont un effondrement spectaculaire l'avant-veille.
  const ms = [
    ...run(soir(23), [95, 92, 90, 20, 18, 15], { results: ["w", "w", "w", "l", "l", "l"] }),
    ...run(soir(24), [80, 80, 80, 45, 43, 40], { results: ["w", "w", "w", "l", "l", "l"] }),
    ...run(soir(25), [66, 64, 68], { results: ["w", "l", "w"] }),
  ];
  const a = X.sessionAlerts([{ member: MEMBER, matches: ms }], { now: NOW, days: 10 });
  assert.equal(a.length, 1, "une seule alerte, jamais une liste");
  assert.equal(a[0].when, "hier soir", "et c'est la session la plus récente");
  assert.equal(a[0].kind, "recap", "même si une session plus ancienne était plus spectaculaire");
});

test("entre deux membres, c'est la session qui s'est terminée en dernier", () => {
  const tot = new Date(2026, 7, 25, 17, 0).getTime();
  const tard = new Date(2026, 7, 25, 21, 0).getTime();
  const a = X.sessionAlerts([
    { member: MEMBER, matches: run(tot, [90, 88, 92], { results: ["w", "w", "w"], rr: [22, 21, 20] }) },
    { member: { name: "Autre", tag: "2", color: "#fff" }, matches: run(tard, [60, 58, 62]) },
  ], { now: NOW });
  assert.equal(a.length, 1);
  assert.equal(a[0].member.name, "Autre", "la plus récente, même si l'autre est plus remarquable");
});

test("sur une même session, c'est le constat le plus marquant qui sort", () => {
  const hier = new Date(2026, 7, 25, 20, 0).getTime();
  const a = X.sessionAlerts([{ member: MEMBER,
    matches: run(hier, [85, 82, 80, 40, 38, 35],
      { results: ["w", "w", "w", "l", "l", "l"], rr: [20, 18, 19, -20, -22, -25] }) }], { now: NOW });
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, "tilt", "et pas le simple récapitulatif");
});

/* ------------------------------------------------------- verdict tribunal */

const games = (n, score100, result, rrEach) => Array.from({ length: n }, (_, i) =>
  match({ startedMs: NOW - (n - i) * 2 * H, score100, result,
          rr: rrEach != null ? { change: rrEach } : null }));

test("bien jouer et perdre du RR : UNLUCKY (le mot reprend son sens)", () => {
  const v = X.computeVerdict(games(10, 80, "l", -18), 10);
  assert.equal(v.tier, "UNLUCKY");
  assert.match(v.pct, /indice 80\/100/);
  assert.match(v.pct, /-180 RR/);
});

test("bien jouer ET gagner : CRACKED", () => {
  assert.equal(X.computeVerdict(games(10, 80, "w", 20), 10).tier, "CRACKED");
});

test("mal jouer et gagner quand même : PORTÉ", () => {
  const v = X.computeVerdict(games(10, 45, "w", 20), 10);
  assert.equal(v.tier, "PORTÉ");
  assert.match(v.line, /Pas grâce à toi/);
});

test("mal jouer et perdre : BAD", () => {
  assert.equal(X.computeVerdict(games(10, 45, "l", -18), 10).tier, "BAD");
});

test("perf moyenne : jamais BAD, mais la phrase s'adapte au résultat", () => {
  // Un indice au-dessus de la moyenne qui perd n'est pas « le problème ».
  const perdu = X.computeVerdict(games(10, 65, "l", -18), 10);
  assert.equal(perdu.tier, "MOYEN");
  assert.match(perdu.line, /sans réussir à renverser/);
  const gagne = X.computeVerdict(games(10, 65, "w", 20), 10);
  assert.equal(gagne.tier, "MOYEN");
  assert.match(gagne.line, /le bilan est bon/);
  // BAD reste réservé à une perf réellement basse.
  assert.equal(X.computeVerdict(games(10, 45, "l", -18), 10).tier, "BAD");
});

test("sans RR connu, on retombe sur le winrate", () => {
  const wins = games(6, 80, "w"), losses = games(6, 80, "l");
  assert.equal(X.computeVerdict(wins, 10).tier, "CRACKED");
  assert.equal(X.computeVerdict(losses, 10).tier, "UNLUCKY");
});

test("l'aiguille reste la PERF : même indice, verdicts opposés", () => {
  const a = X.computeVerdict(games(10, 80, "w", 20), 10);
  const b = X.computeVerdict(games(10, 80, "l", -18), 10);
  assert.equal(a.avg, b.avg, "même position d'aiguille");
  assert.notEqual(a.tier, b.tier, "…mais pas le même verdict : c'est tout l'intérêt");
});

test("la régularité est rapportée honnêtement", () => {
  const steady = X.computeVerdict(games(8, 70, "w", 20), 10);
  assert.match(steady.pct, /régulier/);
  const swingy = [80, 30, 85, 25, 90, 20, 88, 35].map((sc, i) =>
    match({ startedMs: NOW - (9 - i) * 2 * H, score100: sc, result: "w", rr: { change: 20 } }));
  assert.match(X.computeVerdict(swingy, 10).pct, /dents de scie/);
});

test("les sessions parties en vrille sont comptées dans le détail", () => {
  // Une seule session (parties rapprochées) qui s'effondre nettement.
  const s = [85, 84, 86, 45, 42, 40].map((sc, i) =>
    match({ startedMs: NOW - 20 * H + i * 40 * MIN, score100: sc, result: "l", rr: { change: -18 } }));
  assert.match(X.computeVerdict(s, 10).pct, /1 session partie en vrille/);
});

test("aucune partie classée : on le dit au lieu d'inventer un verdict", () => {
  const v = X.computeVerdict([match({ mode: "Deathmatch" })], 10);
  assert.equal(v.tier, "?");
  assert.equal(v.avg, 0);
  assert.match(v.pct, /Lance quelques ranked/);
});

test("l'arc de la jauge suit exactement les seuils de perf", () => {
  assert.equal(X.Z[0].to, X.TRIB_PERF_LOW);
  assert.equal(X.Z[1].from, X.TRIB_PERF_LOW);
  assert.equal(X.Z[1].to, X.TRIB_PERF_HIGH);
  assert.equal(X.Z[2].from, X.TRIB_PERF_HIGH);
  assert.equal(X.Z[2].to, 100);
});
