// Compagnon PC : tout ce qui transforme ce que dit le client VALORANT en ce
// que le site attend. Le client lui-même ne peut pas tourner ici, mais le
// FORMAT de ce qu'il renvoie, si — et c'est là que sont les pièges.
import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import { parseLockfile, decodePrivate, mapName, modeName, loopState,
         stateFromPresence, storeFromPayload } from "../companion/cosmo-live.mjs";
import { cleanLive } from "../netlify/functions/lib/live-core.mjs";

/* ------------------------------------------------------------- lockfile */

test("le lockfile est lu au format nom:pid:port:motdepasse:protocole", () => {
  const l = parseLockfile("Riot Client:12345:54321:AbCdEf:https");
  assert.equal(l.port, 54321);
  assert.equal(l.password, "AbCdEf");
  assert.equal(l.protocol, "https");
  assert.equal(parseLockfile("Riot Client:12345:54321:pw:https\n").port, 54321, "retour à la ligne toléré");
});

test("un lockfile tronqué ou absurde ne donne pas un port bancal", () => {
  ["", null, "trop:court", "a:b:pas-un-port:d:e"].forEach((x) => assert.equal(parseLockfile(x), null));
});

/* ------------------------------------------------------------- présence */

const b64 = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");

test("le champ private est du JSON en base64", () => {
  assert.equal(decodePrivate(b64({ a: 1 })).a, 1);
  ["", null, "pas du base64 valide !!", Buffer.from("{cassé", "utf8").toString("base64")]
    .forEach((x) => assert.equal(decodePrivate(x), null));
});

test("le nom de map est extrait du chemin interne", () => {
  assert.equal(mapName("/Game/Maps/Ascent/Ascent"), "Ascent");
  assert.equal(mapName("/Game/Maps/Duality/Duality"), "Duality");
  assert.equal(mapName(""), "");
  assert.equal(mapName("/Game/Maps/"), "", "un chemin sans map ne doit pas inventer un nom");
  assert.equal(mapName("/Game/"), "", "ni « Game »");
  assert.equal(mapName("Ascent"), "Ascent", "un nom nu reste accepté");
});

test("les modes sont traduits, et un mode inconnu reste lisible", () => {
  assert.equal(modeName("competitive"), "Competitive");
  assert.equal(modeName("hurm"), "Team Deathmatch");
  assert.equal(modeName("un_truc_neuf"), "Un_truc_neuf", "plutôt ça qu'une case vide");
  assert.equal(modeName(""), "");
});

test("l'état de session est ramené aux trois cas que le site sait afficher", () => {
  assert.equal(loopState("INGAME"), "ingame");
  assert.equal(loopState("PREGAME"), "pregame");
  assert.equal(loopState("MENUS"), "menus");
  assert.equal(loopState("QUELQUE_CHOSE"), "menus");
});

const ID = { name: "Yakuza", tag: "2826", region: "eu" };

test("une présence en partie donne map, mode et score", () => {
  const st = stateFromPresence({
    sessionLoopState: "INGAME", matchMap: "/Game/Maps/Ascent/Ascent", queueId: "competitive",
    partyOwnerMatchScoreAllyTeam: 7, partyOwnerMatchScoreEnemyTeam: 5,
    partySize: 3, maxPartySize: 5, competitiveTier: 21,
  }, ID);
  assert.equal(st.state, "ingame");
  assert.equal(st.map, "Ascent");
  assert.equal(st.mode, "Competitive");
  assert.equal(st.scoreAlly, 7);
  assert.equal(st.scoreEnemy, 5);
  assert.equal(st.partySize, 3);
  assert.equal(st.tier, 21);
});

test("les noms de champs alternatifs sont acceptés", () => {
  // Riot a renommé ces champs au fil des patchs : perdre le score sur un
  // renommage serait le bug le plus probable de tout le compagnon.
  const st = stateFromPresence({
    sessionLoopState: "INGAME", partyOwnerMatchMap: "/Game/Maps/Bind/Bind",
    partyOwnerQueueId: "unrated", matchScoreAllyTeam: 12, matchScoreEnemyTeam: 10,
  }, ID);
  assert.equal(st.map, "Bind");
  assert.equal(st.mode, "Unrated");
  assert.equal(st.scoreAlly, 12);
});

test("hors partie, aucun score n'est fabriqué", () => {
  const st = stateFromPresence({ sessionLoopState: "MENUS", partySize: 2 }, ID);
  assert.equal(st.scoreAlly, undefined);
  assert.equal(st.map, "");
  assert.equal(st.partySize, 2);
});

test("un score de 0-0 en début de partie est bien transmis", () => {
  // Le piège : 0 est falsy. Un début de partie ne doit pas passer pour un
  // score absent.
  const st = stateFromPresence({
    sessionLoopState: "INGAME", matchMap: "/Game/Maps/Split/Split",
    partyOwnerMatchScoreAllyTeam: 0, partyOwnerMatchScoreEnemyTeam: 0,
  }, ID);
  assert.equal(st.scoreAlly, 0);
  assert.equal(st.scoreEnemy, 0);
  // …et il survit au nettoyage côté serveur.
  assert.equal(cleanLive(st, 1).score.join("-"), "0-0");
});

test("une présence vide ne produit pas d'état", () => {
  assert.equal(stateFromPresence(null, ID), null);
});

test("ce que produit le compagnon est accepté tel quel par le serveur", () => {
  // Le contrat entre les deux moitiés : si ce test casse, l'un des deux a
  // changé de vocabulaire sans prévenir l'autre.
  const st = stateFromPresence({
    sessionLoopState: "INGAME", matchMap: "/Game/Maps/Lotus/Lotus", queueId: "competitive",
    partyOwnerMatchScoreAllyTeam: 13, partyOwnerMatchScoreEnemyTeam: 11,
    partySize: 5, maxPartySize: 5, competitiveTier: 18,
  }, ID);
  const e = cleanLive(st, 1234);
  assert.equal(e.key, "yakuza#2826");
  assert.equal(e.map, "Lotus");
  assert.equal(e.mode, "Competitive");
  assert.equal(e.score.join("-"), "13-11");
  assert.equal(e.party.size, 5);
  assert.equal(e.tier, 18);
});

/* ------------------------------------------------------------- boutique */

const OFFER = (n) => `0000000${n}-0000-4000-8000-000000000000`.slice(-36);

test("la boutique est réduite aux uuid d'offres", () => {
  const s = storeFromPayload({
    SkinsPanelLayout: {
      SingleItemOffers: [OFFER(1), OFFER(2), OFFER(3), OFFER(4)],
      SingleItemOffersRemainingDurationInSeconds: 42_000,
    },
    FeaturedBundle: { Bundle: { DataAssetID: OFFER(9) } },
  });
  assert.equal(s.offers.length, 4);
  assert.equal(s.secondsLeft, 42_000);
  assert.equal(s.bundle[0], OFFER(9));
  // Et le serveur l'accepte.
  const e = cleanLive({ name: "a", tag: "b", store: s }, 1);
  assert.equal(e.store.offers.length, 4);
  assert.equal(e.store.bundle, OFFER(9));
});

test("le night market est repris quand il est ouvert", () => {
  const s = storeFromPayload({
    SkinsPanelLayout: { SingleItemOffers: [OFFER(1)] },
    BonusStore: { BonusStoreOffers: [{ Offer: { OfferID: OFFER(5) } }, { Offer: { OfferID: OFFER(6) } }] },
  });
  assert.equal(s.night.length, 2);
});

test("une boutique absente ou vide ne renvoie rien à envoyer", () => {
  [null, {}, { SkinsPanelLayout: {} }].forEach((x) => assert.equal(storeFromPayload(x), null));
});

test("importer le compagnon ne lance pas sa boucle", () => {
  // Le module a été importé en haut de ce fichier : s'il démarrait sa boucle
  // d'envoi, les tests ne se termineraient jamais.
  assert.ok(true);
});
