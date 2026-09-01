// État « en direct » : nettoyage de ce que le compagnon envoie, fusion,
// péremption. Le compagnon tourne sur un PC hors de portée des tests ; ce qui
// est testé ici, c'est ce que le serveur accepte, garde et ressert.
import assert from "node:assert/strict";
import test from "node:test";
import { cleanLive, mergeLive, liveView, liveKey, LIVE_TTL_MS, STORE_TTL_MS }
  from "../netlify/functions/lib/live-core.mjs";

const T = 1_700_000_000_000;
const U = (n) => `0000000${n}-0000-4000-8000-000000000000`.slice(-36);

const base = (o = {}) => ({ name: "Yakuza", tag: "2826", state: "ingame", map: "Ascent",
  mode: "Competitive", agent: "Jett", scoreAlly: 7, scoreEnemy: 5, ...o });

/* ------------------------------------------------------------- nettoyage */

test("un état complet passe intact", () => {
  const e = cleanLive(base(), T);
  assert.equal(e.key, "yakuza#2826");
  assert.equal(e.state, "ingame");
  assert.equal(e.map, "Ascent");
  assert.equal(e.score.join("-"), "7-5");
  assert.equal(e.at, T);
});

test("sans pseudo ni tag, on refuse plutôt que d'écrire une entrée anonyme", () => {
  [null, {}, { name: "Yakuza" }, { tag: "2826" }, { name: "  ", tag: "2826" }, "texte"]
    .forEach((x) => assert.equal(cleanLive(x, T), null));
});

test("la clé est insensible à la casse, comme les autres blobs", () => {
  assert.equal(cleanLive(base({ name: "YAKUZA", tag: "2826" }), T).key, liveKey("yakuza", "2826"));
});

test("un état inconnu retombe sur menus plutôt que de passer tel quel", () => {
  assert.equal(cleanLive(base({ state: "n'importe quoi" }), T).state, "menus");
  assert.equal(cleanLive(base({ state: "PREGAME" }), T).state, "pregame");
});

test("un demi-score n'est pas affiché", () => {
  assert.equal(cleanLive(base({ scoreEnemy: null }), T).score, undefined);
  assert.equal(cleanLive(base({ scoreAlly: "x" }), T).score, undefined);
});

test("un score hors partie est ignoré : il ne voudrait rien dire", () => {
  assert.equal(cleanLive(base({ state: "menus" }), T).score, undefined);
});

test("les valeurs aberrantes sont bornées, pas propagées", () => {
  const e = cleanLive(base({ scoreAlly: 999, scoreEnemy: -5, partySize: 99, tier: 500 }), T);
  assert.equal(e.score.join("-"), "99-0");
  assert.equal(e.party.size, 5);
  assert.equal(e.tier, 30);
});

test("une taille de groupe incohérente est recollée", () => {
  // max < size est impossible : on aligne le max sur la taille observée.
  assert.equal(cleanLive(base({ partySize: 5, partyMax: 2 }), T).party.max, 5);
});

test("les champs texte sont tronqués, pas rejetés", () => {
  const e = cleanLive(base({ map: "M".repeat(500) }), T);
  assert.equal(e.map.length, 40);
});

/* --------------------------------------------------------------- boutique */

test("la boutique n'accepte que des uuid", () => {
  const e = cleanLive(base({ store: { offers: [U(1), "pas-un-uuid", U(2), "<script>"] } }), T);
  assert.equal(e.store.offers.length, 2);
  assert.equal(e.store.offers[0], U(1));
});

test("une boutique sans rien d'exploitable n'est pas stockée", () => {
  assert.equal(cleanLive(base({ store: { offers: ["nope"] } }), T).store, undefined);
  assert.equal(cleanLive(base({ store: {} }), T).store, undefined);
});

test("la boutique garde le bundle, le night market et le temps restant", () => {
  const e = cleanLive(base({ store: { offers: [U(1)], bundle: [U(9)], night: [U(3), U(4)], secondsLeft: 3600 } }), T);
  assert.equal(e.store.bundle, U(9));
  assert.equal(e.store.night.length, 2);
  assert.equal(e.store.secondsLeft, 3600);
});

/* ----------------------------------------------------------------- fusion */

test("un nouvel envoi remplace l'ancien du même joueur, pas des autres", () => {
  let doc = mergeLive(null, cleanLive(base(), T));
  doc = mergeLive(doc, cleanLive(base({ name: "koko", tag: "jetti" }), T + 1));
  doc = mergeLive(doc, cleanLive(base({ scoreAlly: 9 }), T + 2));
  assert.equal(doc.players.length, 2);
  assert.equal(doc.players.find((p) => p.key === "yakuza#2826").score.join("-"), "9-5");
});

test("la boutique survit aux envois d'état qui n'en portent pas", () => {
  // Le compagnon ne relit la boutique qu'une fois par jour : chaque envoi de
  // score ne doit pas l'effacer.
  let doc = mergeLive(null, cleanLive(base({ store: { offers: [U(1)] } }), T));
  doc = mergeLive(doc, cleanLive(base({ scoreAlly: 11 }), T + 60_000));
  const p = doc.players.find((x) => x.key === "yakuza#2826");
  assert.equal(p.store.offers[0], U(1));
  assert.equal(p.score.join("-"), "11-5");
});

test("une boutique fraîche remplace bien l'ancienne", () => {
  let doc = mergeLive(null, cleanLive(base({ store: { offers: [U(1)] } }), T));
  doc = mergeLive(doc, cleanLive(base({ store: { offers: [U(7)] } }), T + 86_400_000));
  assert.equal(doc.players[0].store.offers[0], U(7));
});

/* ------------------------------------------------------------- péremption */

test("passé le délai, le joueur n'est plus « en direct »", () => {
  const doc = mergeLive(null, cleanLive(base(), T));
  const frais = liveView(doc, T + 10_000)[0];
  assert.equal(frais.live, true);
  assert.equal(frais.state, "ingame");
  assert.equal(frais.score.join("-"), "7-5");

  const vieux = liveView(doc, T + LIVE_TTL_MS + 1)[0];
  assert.equal(vieux.live, false);
  assert.equal(vieux.state, "off");
  assert.equal(vieux.score, undefined, "un vieux score ne doit pas rester affiché");
  assert.equal(vieux.map, "", "ni la map");
});

test("la boutique reste lisible bien après la fin de la partie", () => {
  const doc = mergeLive(null, cleanLive(base({ store: { offers: [U(1)] } }), T));
  const v = liveView(doc, T + LIVE_TTL_MS + 60_000)[0];
  assert.equal(v.live, false);
  assert.equal(v.store.offers[0], U(1), "la boutique du jour survit au jeu fermé");
  assert.equal(liveView(doc, T + STORE_TTL_MS + 1)[0].store, undefined, "mais pas éternellement");
});

test("les joueurs en direct passent devant, puis les plus récents", () => {
  let doc = mergeLive(null, cleanLive(base({ name: "vieux", tag: "0001" }), T));
  doc = mergeLive(doc, cleanLive(base({ name: "recent", tag: "0002" }), T + LIVE_TTL_MS + 10_000));
  const v = liveView(doc, T + LIVE_TTL_MS + 20_000);
  assert.equal(v[0].name, "recent");
  assert.equal(v[0].live, true);
  assert.equal(v[1].live, false);
});

test("un document vide ou abîmé ne fait pas planter la lecture", () => {
  [null, {}, { players: null }, { players: [null, {}, { key: "" }] }].forEach((d) => {
    assert.equal(liveView(d, T).length, 0);
  });
});

test("null, chaîne vide et tableau ne sont pas des nombres", () => {
  // Number(null) === 0 : un score absent ne doit pas devenir zéro.
  [null, undefined, "", "  ", [], {}, false, true].forEach((v) => {
    const e = cleanLive(base({ scoreAlly: 7, scoreEnemy: v }), T);
    assert.equal(e.score, undefined, `scoreEnemy = ${JSON.stringify(v)}`);
  });
  assert.equal(cleanLive(base({ partySize: null }), T).party, undefined);
  assert.equal(cleanLive(base({ tier: "" }), T).tier, undefined);
  // Un vrai zéro, lui, reste un zéro : 0-0 au début d'une partie est valide.
  assert.equal(cleanLive(base({ scoreAlly: 0, scoreEnemy: 0 }), T).score.join("-"), "0-0");
});
