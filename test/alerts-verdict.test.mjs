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
    ALERT_MIN_GAMES, ALERT_TILT, ALERT_RR, ALERT_DAYS, TRIB_PERF_HIGH, TRIB_PERF_LOW };`;
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
  const soirHier = new Date(2026, 7, 25, 22, 0).getTime();
  assert.equal(X.relDay(soirHier, NOW), "hier soir");
  assert.equal(X.relDay(new Date(2026, 7, 26, 9, 0).getTime(), NOW), "ce matin");
  assert.equal(X.relDay(new Date(2026, 7, 26, 15, 0).getTime(), NOW), "cet après-midi");
  assert.equal(X.relDay(new Date(2026, 7, 26, 2, 0).getTime(), NOW), "cette nuit");
  assert.equal(X.relDay(new Date(2026, 7, 25, 1, 0).getTime(), NOW), "la nuit dernière");
  assert.equal(X.relDay(new Date(2026, 7, 23, 20, 0).getTime(), NOW), "il y a 3 jours");
});

/* ---------------------------------------------------------------- alertes */

test("session longue qui s'effondre : c'est l'alerte demandée", () => {
  const hier = new Date(2026, 7, 25, 20, 0).getTime();
  const a = X.sessionAlerts([{ member: MEMBER, matches: run(hier, [80, 78, 82, 50, 44, 48]) }], { now: NOW });
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

test("une session longue mais stable ne déclenche rien non plus", () => {
  const hier = new Date(2026, 7, 25, 20, 0).getTime();
  const a = X.sessionAlerts([{ member: MEMBER, matches: run(hier, [70, 68, 72, 69, 71, 70, 73]) }], { now: NOW });
  assert.equal(a.length, 0, "jouer longtemps n'est pas un problème en soi");
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

test("les sessions trop anciennes sont ignorées", () => {
  const vieux = NOW - 10 * DAY;
  const a = X.sessionAlerts([{ member: MEMBER, matches: run(vieux, [80, 78, 82, 50, 44, 48]) }], { now: NOW });
  assert.equal(a.length, 0, `au-delà de ${X.ALERT_DAYS} jours, ce n'est plus une alerte`);
});

test("une seule alerte par membre : le pire ne monopolise pas le bandeau", () => {
  const hier = new Date(2026, 7, 25, 20, 0).getTime();
  // Session à la fois longue-en-baisse ET très négative en RR.
  const both = run(hier, [85, 82, 80, 40, 38, 35],
    { results: ["w", "w", "w", "l", "l", "l"], rr: [20, 18, 19, -20, -22, -25] });
  const a = X.sessionAlerts([{ member: MEMBER, matches: both }], { now: NOW });
  assert.equal(a.length, 1, "une seule alerte pour ce membre");
  assert.equal(a[0].kind, "tilt", "la plus grave l'emporte");
});

test("le bandeau est plafonné et trié par gravité", () => {
  const hier = new Date(2026, 7, 25, 20, 0).getTime();
  const per = ["A", "B", "C", "D"].map((n, i) => ({
    member: { name: n, tag: "1", color: "#fff" },
    // Effondrements de plus en plus marqués.
    matches: run(hier - i * 5 * MIN, [80, 80, 80, 60 - i * 10, 58 - i * 10, 55 - i * 10]),
  }));
  const a = X.sessionAlerts(per, { now: NOW, max: 3 });
  assert.equal(a.length, 3, "plafonné à 3");
  assert.equal(a[0].member.name, "D", "l'effondrement le plus net en tête");
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
