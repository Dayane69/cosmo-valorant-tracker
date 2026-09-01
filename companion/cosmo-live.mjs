#!/usr/bin/env node
/* COSMO — compagnon « En ce moment »
   ================================================================
   À lancer sur ton PC avant de jouer. Il lit l'état de ta partie et l'envoie
   au site, pour que la squad voie qui joue, sur quelle map, et où en est le
   score.

   COMMENT ÇA MARCHE, ET POURQUOI IL FAUT UN PROGRAMME LOCAL
   Aucune API publique ne donne une partie en cours — ni HenrikDev, ni Riot.
   Le seul endroit où cette information existe, c'est ta machine : pendant
   qu'il tourne, le client VALORANT ouvre un petit serveur sur 127.0.0.1.
   C'est exactement là que vont chercher les outils « Discord Rich Presence ».
   Ce compagnon fait pareil.

   CE QU'IL NE FAIT PAS
   - Il ne demande JAMAIS ton mot de passe Riot. Il s'authentifie auprès du
     client déjà ouvert avec le « lockfile » que celui-ci écrit sur le disque.
   - Il n'envoie aucun jeton Riot au site : les jetons restent sur ce PC.
   - Il n'envoie que ce que le jeu affiche déjà : mode, map, score, agent,
     taille du groupe, et (si tu l'actives) les uuid de ta boutique du jour.

   AVERTISSEMENT
   Ces endpoints du client sont NON OFFICIELS. Riot les tolère largement (tout
   l'écosystème des rich presence vit dessus), mais rien ne le garantit. Tu
   l'utilises en connaissance de cause.

   USAGE
     node cosmo-live.mjs --url https://cosmo-valo.netlify.app --key TON_JETON
   Options
     --no-store     n'envoie pas la boutique
     --once         un seul envoi puis on sort (pour tester)
     --debug        affiche l'état brut lu dans le client (utile si un champ
                    ne remonte pas : c'est ce qu'il faut me montrer)
     --interval N   secondes entre deux envois (défaut 20)
   Le jeton peut aussi venir de la variable d'environnement COSMO_LIVE_KEY.
   ================================================================ */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { Buffer } from "node:buffer";

/* ----------------------------------------------------------- arguments */

function parseArgs(argv) {
  const a = { url: "https://cosmo-valo.netlify.app", key: process.env.COSMO_LIVE_KEY || "",
              store: true, once: false, debug: false, interval: 20 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--url") a.url = argv[++i] || a.url;
    else if (k === "--key") a.key = argv[++i] || a.key;
    else if (k === "--interval") a.interval = Math.max(10, Number(argv[++i]) || 20);
    else if (k === "--no-store") a.store = false;
    else if (k === "--once") a.once = true;
    else if (k === "--debug") a.debug = true;
  }
  a.url = String(a.url).replace(/\/+$/, "");
  return a;
}

/* ------------------------------------------------------------ lockfile */

// Le client Riot y écrit « nom:pid:port:motdepasse:protocole » tant qu'il
// tourne, et le supprime en se fermant. C'est notre laissez-passer local.
export function parseLockfile(text) {
  const parts = String(text || "").trim().split(":");
  if (parts.length < 5) return null;
  const port = Number(parts[2]);
  if (!Number.isFinite(port) || port <= 0) return null;
  return { port, password: parts[3], protocol: parts[4] || "https" };
}

function lockfilePath() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(local, "Riot Games", "Riot Client", "Config", "lockfile");
}

function readLockfile() {
  const p = lockfilePath();
  if (!fs.existsSync(p)) return null;
  try { return parseLockfile(fs.readFileSync(p, "utf8")); } catch (e) { return null; }
}

/* --------------------------------------------------------- appels HTTP */

// Le client local présente un certificat auto-signé : on ne le vérifie donc
// pas — mais UNIQUEMENT pour 127.0.0.1, jamais pour un hôte distant.
const localAgent = new https.Agent({ rejectUnauthorized: false });

function request(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isLocal = u.hostname === "127.0.0.1" || u.hostname === "localhost";
    const req = https.request(u, {
      method: opts.method || "GET",
      headers: opts.headers || {},
      agent: isLocal ? localAgent : undefined,
      timeout: 8000,
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("timeout", () => req.destroy(new Error("délai dépassé")));
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function getJSON(url, headers) {
  const r = await request(url, { headers });
  if (r.status < 200 || r.status >= 300) { const e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
  try { return JSON.parse(r.body); } catch (e) { throw new Error("réponse illisible"); }
}

const basic = (pw) => "Basic " + Buffer.from("riot:" + pw).toString("base64");

/* ------------------------------------------------------------ présence */

/* La présence VALORANT porte un champ `private` : du JSON encodé en base64
   qui contient l'état de session, la map et le score en cours. C'est la même
   source que les rich presence Discord. */
export function decodePrivate(b64) {
  if (typeof b64 !== "string" || !b64) return null;
  try { return JSON.parse(Buffer.from(b64, "base64").toString("utf8")); }
  catch (e) { return null; }
}

// Riot a renommé plusieurs de ces champs au fil des patchs, et le client peut
// préfixer par « partyOwner ». On essaie donc plusieurs noms plutôt que de
// tout perdre sur un renommage. `--debug` montre le brut si rien ne colle.
function pick(obj, names) {
  for (const n of names) {
    if (obj && obj[n] !== undefined && obj[n] !== null && obj[n] !== "") return obj[n];
  }
  return null;
}

// « /Game/Maps/Ascent/Ascent » -> « Ascent »
// Les segments de structure sont exclus explicitement : sur un chemin tronqué
// comme « /Game/Maps/ », prendre bêtement le dernier segment afficherait
// « Maps » comme nom de map.
const NOT_A_MAP = { Game: 1, Maps: 1, Content: 1 };
export function mapName(raw) {
  const parts = String(raw || "").trim().split("/").filter(Boolean);
  const last = parts[parts.length - 1] || "";
  if (!last || NOT_A_MAP[last]) return "";
  return /^[A-Za-z0-9 ]{2,30}$/.test(last) ? last : "";
}

const MODES = {
  competitive: "Competitive", unrated: "Unrated", deathmatch: "Deathmatch",
  spikerush: "Spike Rush", ggteam: "Escalation", swiftplay: "Swiftplay",
  hurm: "Team Deathmatch", onefa: "Replication", newmap: "New Map", premier: "Premier",
};
export function modeName(queueId) {
  const q = String(queueId || "").toLowerCase();
  return MODES[q] || (q ? q[0].toUpperCase() + q.slice(1) : "");
}

// « INGAME » / « PREGAME » / « MENUS » -> ce que le site sait afficher.
export function loopState(raw) {
  const s = String(raw || "").toUpperCase();
  if (s === "INGAME") return "ingame";
  if (s === "PREGAME") return "pregame";
  return "menus";
}

/* Transforme la présence brute en l'état que le site attend.
   Exporté pour être testable : le client VALORANT n'est pas installable dans
   un test, mais le format de sa présence, si. */
export function stateFromPresence(priv, ident) {
  if (!priv) return null;
  const state = loopState(pick(priv, ["sessionLoopState"]));
  const out = {
    name: (ident && ident.name) || "",
    tag: (ident && ident.tag) || "",
    state,
    map: mapName(pick(priv, ["matchMap", "partyOwnerMatchMap"])),
    mode: modeName(pick(priv, ["queueId", "partyOwnerQueueId"])),
  };
  const ally = pick(priv, ["partyOwnerMatchScoreAllyTeam", "matchScoreAllyTeam", "scoreAllyTeam"]);
  const enemy = pick(priv, ["partyOwnerMatchScoreEnemyTeam", "matchScoreEnemyTeam", "scoreEnemyTeam"]);
  if (state === "ingame" && ally !== null && enemy !== null) {
    out.scoreAlly = Number(ally);
    out.scoreEnemy = Number(enemy);
  }
  const size = pick(priv, ["partySize"]), max = pick(priv, ["maxPartySize"]);
  if (size !== null) { out.partySize = Number(size); if (max !== null) out.partyMax = Number(max); }
  const tier = pick(priv, ["competitiveTier"]);
  if (tier !== null) out.tier = Number(tier);
  return out;
}

/* ------------------------------------------------------------ boutique */

// La boutique renvoie des uuid d'offres ; c'est le site qui les traduit en
// noms et en images via valorant-api. On n'envoie donc que des uuid.
export function storeFromPayload(sf) {
  if (!sf || typeof sf !== "object") return null;
  const panel = sf.SkinsPanelLayout || {};
  const out = { offers: Array.isArray(panel.SingleItemOffers) ? panel.SingleItemOffers.slice(0, 4) : [] };
  const left = panel.SingleItemOffersRemainingDurationInSeconds;
  if (Number.isFinite(Number(left))) out.secondsLeft = Number(left);
  const bundle = (sf.FeaturedBundle && sf.FeaturedBundle.Bundle && sf.FeaturedBundle.Bundle.DataAssetID) || "";
  if (bundle) out.bundle = [bundle];
  const night = (sf.BonusStore && Array.isArray(sf.BonusStore.BonusStoreOffers))
    ? sf.BonusStore.BonusStoreOffers.map((o) => o && o.Offer && o.Offer.OfferID).filter(Boolean).slice(0, 8)
    : [];
  if (night.length) out.night = night;
  return (out.offers.length || out.bundle || night.length) ? out : null;
}

const SHARD = { eu: "eu", na: "na", latam: "na", br: "na", ap: "ap", kr: "kr" };
// Valeur documentée : l'en-tête décrit juste la plateforme du client.
const CLIENT_PLATFORM =
  "ew0KCSJwbGF0Zm9ybVR5cGUiOiAiUEMiLA0KCSJwbGF0Zm9ybU9TIjogIldpbmRvd3MiLA0KCSJwbGF0Zm9ybU9TVmVyc2lvbiI6ICIxMC4wLjE5MDQyLjEuMjU2LjY0Yml0IiwNCgkicGxhdGZvcm1DaGlwc2V0IjogIlVua25vd24iDQp9";

async function fetchStore(lock, ident, log) {
  try {
    const auth = { Authorization: basic(lock.password) };
    const ent = await getJSON(`https://127.0.0.1:${lock.port}/entitlements/v1/token`, auth);
    const puuid = ent.subject, access = ent.accessToken, jwt = ent.token;
    if (!puuid || !access || !jwt) return null;

    // La version du client : on la demande à HenrikDev plutôt que d'aller
    // gratter ShooterGame.log, c'est plus robuste aux mises à jour.
    const region = (ident && ident.region) || "eu";
    const ver = await getJSON(`https://valorant-api.com/v1/version`).catch(() => null);
    const clientVersion = ver && ver.data && ver.data.riotClientVersion;
    if (!clientVersion) return null;

    const shard = SHARD[region] || "eu";
    const r = await request(`https://pd.${shard}.a.pvp.net/store/v2/storefront/${puuid}`, {
      headers: {
        Authorization: `Bearer ${access}`,
        "X-Riot-Entitlements-JWT": jwt,
        "X-Riot-ClientPlatform": CLIENT_PLATFORM,
        "X-Riot-ClientVersion": clientVersion,
      },
    });
    if (r.status !== 200) { log(`boutique indisponible (HTTP ${r.status})`); return null; }
    return storeFromPayload(JSON.parse(r.body));
  } catch (e) {
    log(`boutique ignorée : ${(e && e.message) || e}`);
    return null;
  }
}

/* --------------------------------------------------------------- boucle */

// Qui suis-je : le client expose la session de chat, qui porte le pseudo/tag.
async function whoAmI(lock) {
  const auth = { Authorization: basic(lock.password) };
  const s = await getJSON(`https://127.0.0.1:${lock.port}/chat/v1/session`, auth);
  return { puuid: s.puuid || "", name: s.game_name || "", tag: s.game_tag || "", region: s.region || "eu" };
}

async function readPresence(lock, puuid) {
  const auth = { Authorization: basic(lock.password) };
  const d = await getJSON(`https://127.0.0.1:${lock.port}/chat/v4/presences`, auth);
  const list = Array.isArray(d.presences) ? d.presences : [];
  const mine = list.find((p) => p && p.puuid === puuid) || list.find((p) => p && p.private);
  return mine ? decodePrivate(mine.private) : null;
}

async function send(cfg, payload, log) {
  const r = await request(`${cfg.url}/.netlify/functions/live?key=${encodeURIComponent(cfg.key)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (r.status !== 200) { log(`envoi refusé (HTTP ${r.status}) ${r.body.slice(0, 120)}`); return false; }
  return true;
}

const stamp = () => new Date().toLocaleTimeString("fr-FR");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  const log = (m) => console.log(`[${stamp()}] ${m}`);

  if (!cfg.key) {
    console.error("Il manque le jeton : --key TON_JETON (ou la variable COSMO_LIVE_KEY).");
    process.exit(1);
  }
  log(`COSMO compagnon — envoi vers ${cfg.url} toutes les ${cfg.interval}s`);
  log("Aucun mot de passe Riot n'est demandé ni transmis. Ctrl+C pour arrêter.");

  let ident = null, storeSentAt = 0, lastLine = "";

  for (;;) {
    const lock = readLockfile();
    if (!lock) {
      if (lastLine !== "off") { log("VALORANT n'est pas lancé — en attente."); lastLine = "off"; }
    } else {
      try {
        if (!ident || !ident.name) ident = await whoAmI(lock);
        const priv = await readPresence(lock, ident.puuid);
        if (cfg.debug) console.log("  brut :", JSON.stringify(priv));
        const st = stateFromPresence(priv, ident);
        if (!st || !st.name) {
          if (lastLine !== "noid") { log("client lancé, mais pas encore connecté."); lastLine = "noid"; }
        } else {
          // La boutique ne change qu'une fois par jour : inutile de la
          // redemander à chaque tour, et ça évite de marteler Riot.
          if (cfg.store && Date.now() - storeSentAt > 6 * 3600_000) {
            const s = await fetchStore(lock, ident, log);
            if (s) { st.store = s; storeSentAt = Date.now(); log(`boutique relevée (${s.offers.length} offres)`); }
            else storeSentAt = Date.now() - 5 * 3600_000;   // on réessaiera dans 1 h, pas en boucle
          }
          const ok = await send(cfg, st, log);
          const line = `${st.state}${st.map ? " · " + st.map : ""}${st.score ? "" : ""}` +
            (st.scoreAlly != null ? ` · ${st.scoreAlly}-${st.scoreEnemy}` : "") +
            (st.mode ? ` · ${st.mode}` : "");
          if (ok && line !== lastLine) { log(line); lastLine = line; }
        }
      } catch (e) {
        const msg = (e && e.message) || String(e);
        if (lastLine !== "err:" + msg) { log(`lecture impossible : ${msg}`); lastLine = "err:" + msg; }
        if (e && e.status === 404) ident = null;   // session pas encore prête
      }
    }
    if (cfg.once) break;
    await sleep(cfg.interval * 1000);
  }
}

// Exécuté directement (et pas importé par un test) : on lance la boucle.
const invokedDirectly = process.argv[1] && process.argv[1].endsWith("cosmo-live.mjs");
if (invokedDirectly) main().catch((e) => { console.error("Arrêt :", (e && e.message) || e); process.exit(1); });
