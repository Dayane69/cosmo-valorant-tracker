// Tests front (app.js) avec un faux DOM (jsdom) + vm.
// Vérifie : init sans erreur, profil qui s'ouvre, fusion dédoublonnée par
// matchid, et tribunal qui reste ranked-only après l'ajout de l'historique.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const roster = JSON.parse(readFileSync(join(root, "roster.json"), "utf8"));
// Le 1er membre du roster : les fixtures s'y accrochent pour ne pas casser
// au prochain changement de pseudo.
const ME = roster.members[0];

function rawMatch(id, iso, won = true, mode = "Competitive") {
  return {
    metadata: { match_id: id, started_at: iso, map: { name: "Ascent" }, queue: { name: mode } },
    players: [
      { puuid: "p1", name: ME.name, tag: ME.tag, team_id: "Blue", agent: { id: "uuid-cypher", name: "Cypher" },
        stats: { kills: 15, deaths: 10, assists: 5, score: 5000, headshots: 20, bodyshots: 30, legshots: 5, damage: { dealt: 4000, received: 3000 } } },
      { puuid: "e1", name: "Foe", tag: "9999", team_id: "Red", agent: { id: "uuid-jett", name: "Jett" },
        stats: { kills: 10, deaths: 12, assists: 3, score: 3500, headshots: 10, bodyshots: 25, legshots: 5, damage: { dealt: 3000, received: 3500 } } },
    ],
    teams: [
      { team_id: "Blue", won, rounds: { won: won ? 13 : 7, lost: won ? 7 : 13 } },
      { team_id: "Red", won: !won, rounds: { won: won ? 7 : 13, lost: won ? 13 : 7 } },
    ],
  };
}

const jsonRes = (obj) => ({ ok: true, status: 200, json: async () => obj });

// Détail complet d'un match (match-by-id) : 3 joueurs -> classement ACS 1er/2e/3e.
function fullMatchById() {
  const mk = (puuid, name, team, score) => ({
    puuid, name, tag: "0", team_id: team, agent: { id: "uuid-x", name: "Sova" },
    stats: { kills: 10, deaths: 10, assists: 5, score, headshots: 10, bodyshots: 20, legshots: 5, damage: { dealt: 2000, received: 2000 } },
  });
  return {
    metadata: { match_id: "m3", started_at: "2026-06-22T10:00:00Z", map: { name: "Ascent" }, queue: { name: "Competitive" } },
    players: [mk("p1", ME.name, "Blue", 5000), mk("pX", "Mate", "Blue", 4000), mk("pY", "Foe", "Red", 3000)],
    teams: [
      { team_id: "Blue", won: true, rounds: { won: 13, lost: 7 } },
      { team_id: "Red", won: false, rounds: { won: 7, lost: 13 } },
    ],
  };
}

// Format compact "stored-matches v1" : meta + stats (1 joueur) + teams:{red,blue} (objet).
function storedV1(id, iso, myScore = 13, oppScore = 7, mode = "Competitive") {
  return {
    meta: { id, map: { name: "Ascent" }, mode, started_at: iso },
    stats: {
      puuid: "p1", team: "Red", character: { id: "uuid-cypher", name: "Cypher" },
      score: 5000, kills: 18, deaths: 12, assists: 5,
      shots: { head: 100, body: 200, leg: 10 }, damage: { made: 3500, received: 3000 },
    },
    teams: { red: myScore, blue: oppScore },
  };
}

// fetch simulé : roster.json, proxy valo (account/mmr/matches), historique, valorant-api.
function makeFetch() {
  return async (input) => {
    const url = String(input);
    if (url.endsWith("roster.json")) return jsonRes(roster);

    if (url.includes("/.netlify/functions/valo")) {
      const path = new URL(url, "http://localhost").searchParams.get("path") || "";
      if (path.includes("/account/")) return jsonRes({ data: { puuid: "p1" } });
      if (path.includes("/mmr/")) return jsonRes({ data: { current: { tier: { name: "Gold 2" }, rr: 42, images: { large: "http://img/large.png" } } } });
      if (path.includes("/mmr-history/")) return jsonRes({ data: { history: [
        { match_id: "m1", last_change: 18, elo: 1345, rr: 42, tier: { id: 13, name: "Gold 2" }, season: { short: "e8a3" }, date: "2026-06-24T10:00:00Z" },
        { match_id: "m2", last_change: -15, elo: 1330, rr: 24, tier: { id: 13, name: "Gold 2" }, season: { short: "e8a3" }, date: "2026-06-23T10:00:00Z" },
      ] } });
      if (path.includes("/v4/matches/")) return jsonRes({ data: [rawMatch("m1", "2026-06-24T10:00:00Z"), rawMatch("m2", "2026-06-23T10:00:00Z")] });
      if (path.includes("/v4/match/")) return jsonRes({ data: fullMatchById() }); // détail complet (match-by-id)
      return jsonRes({ data: [] });
    }

    if (url.includes("/.netlify/functions/historique")) {
      const kind = new URL(url, "http://x").searchParams.get("kind");
      if (kind === "rr") {
        // progression RR accumulée (long terme) : 2 vieux points + m1 (doublon avec le live)
        return jsonRes({ rr: [
          { id: "r1", elo: 1300, change: 20, rr: 0, tier: { id: 13, name: "Gold 2" }, season: "e8a2", ts: Date.parse("2026-06-01T10:00:00Z") },
          { id: "r2", elo: 1320, change: 20, rr: 20, tier: { id: 13, name: "Gold 2" }, season: "e8a2", ts: Date.parse("2026-06-02T10:00:00Z") },
          { id: "m1", elo: 1345, change: 18, rr: 42, tier: { id: 13, name: "Gold 2" }, season: "e8a3", ts: Date.parse("2026-06-24T10:00:00Z") },
        ] });
      }
      // blob accumulé au format stored-matches v1 : m2 (doublon) + m3 (nouveau)
      return jsonRes({ matches: [storedV1("m2", "2026-06-23T10:00:00Z"), storedV1("m3", "2026-06-22T10:00:00Z")] });
    }
    if (url.includes("/.netlify/functions/save-history")) return jsonRes({ ok: true, added: 0, total: 3 });
    if (url.includes("/.netlify/functions/roster")) return jsonRes({ roster: null, ok: true, count: 2 }); // GET->fallback, POST->ok

    if (url.includes("valorant-api.com/v1/agents")) return jsonRes({ data: [{ displayName: "Cypher", displayIcon: "ic" }, { displayName: "Jett", displayIcon: "ij" }] });
    if (url.includes("valorant-api.com/v1/competitivetiers")) return jsonRes({ data: [{ tiers: [
      { tier: 6, tierName: "Bronze 1", color: "b6926bff", largeIcon: "br1" },
      { tier: 7, tierName: "Bronze 2", color: "b6926bff", largeIcon: "br2" },
      { tier: 8, tierName: "Bronze 3", color: "b6926bff", largeIcon: "br3" },
      { tier: 9, tierName: "Silver 1", color: "cfd0d1ff", largeIcon: "s1" },
      { tier: 10, tierName: "Silver 2", color: "cfd0d1ff", largeIcon: "s2" },
      { tier: 11, tierName: "Silver 3", color: "cfd0d1ff", largeIcon: "s3" },
      { tier: 12, tierName: "Gold 1", color: "b5985dff", largeIcon: "g1" },
      { tier: 13, tierName: "Gold 2", color: "e0b24cff", largeIcon: "gi" },
      { tier: 14, tierName: "Gold 3", color: "ffd35cff", largeIcon: "g3" },
    ] }] });
    if (url.includes("valorant-api.com/v1/maps")) return jsonRes({ data: [{ displayName: "Ascent", splash: "sp" }] });

    return { ok: false, status: 404, json: async () => ({}) };
  };
}

// Chaque boot() crée un DOM ; sans fermeture, leurs timers retiennent le
// processus de test à la fin de la suite.
const DOMS = [];
after(() => DOMS.forEach(d => { try { d.window.close(); } catch (e) {} }));

async function boot() {
  const html = readFileSync(join(root, "index.html"), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://cosmo-valo.netlify.app/" });
  DOMS.push(dom);
  const ctx = dom.getInternalVMContext();
  dom.window.scrollTo = () => {};
  dom.window.fetch = makeFetch();
  ctx.fetch = dom.window.fetch;

  let code = readFileSync(join(root, "app.js"), "utf8");
  // Épilogue de test : expose les fonctions + un accès à l'état interne.
  code += "\nglobalThis.__t = { combineMatches, normalizeAny, computeVerdict, openProfile, loadProfile, loadSquadMatches, openMatch, closeMatchFacts, fetchMatchDetail, saveAllHistory, setSaveSpacing: (ms) => { SAVE_SPACING_MS = ms; }, renderCurvePeriod, setRRState: (full, period) => { RR_FULL = full; RR_PERIOD = period; }, computeEloTierOffset, tierFromElo, setEloOffset: (o) => { ELO_TIER_OFFSET = o; }, perfDetail, perfParts, IDX_W, openMatchScore, init, getState: () => STATE, getRoster: () => ROSTER };";
  vm.runInContext(code, ctx);
  const T = ctx.__t;
  await T.init(); // garantit roster chargé + grille construite
  return { dom, T, ctx };
}

test("init s'exécute sans erreur et construit la grille depuis roster.json", async () => {
  const { dom, T } = await boot();
  const N = roster.members.length;
  assert.equal(T.getRoster().length, N, "tous les membres de roster.json sont chargés");
  assert.equal(dom.window.document.querySelectorAll("#roster .agentcard").length, N, "une carte par membre");
});

test("combineMatches dédoublonne par matchid et trie du plus récent au plus ancien", async () => {
  const { T } = await boot();
  const fresh = [rawMatch("a", "2026-06-20T10:00:00Z")];
  const blob = [rawMatch("a", "2026-06-20T10:00:00Z"), rawMatch("b", "2026-06-25T10:00:00Z")];
  const merged = T.combineMatches(fresh, blob);
  assert.equal(merged.length, 2, "le doublon 'a' n'apparaît qu'une fois");
  assert.equal(merged[0].metadata.match_id, "b", "le plus récent en tête");
});

test("le profil s'ouvre et fusionne frais + blob sans doublon (m1, m2, m3)", async () => {
  const { dom, T } = await boot();
  T.openProfile(0);
  await T.loadProfile(); // attend la fin du chargement asynchrone
  const doc = dom.window.document;
  assert.equal(doc.getElementById("profile").hidden, false, "la section profil est visible");
  assert.equal(doc.getElementById("app").hidden, false, "le contenu du profil est affiché");
  // fresh [m1,m2] + blob [m2,m3] => 3 matchs uniques
  assert.equal(T.getState().allMatches.length, 3, "historique combiné dédoublonné = 3");
  assert.equal(doc.querySelectorAll("#ml .mrow").length, 3, "3 lignes de match rendues");
  // Rien n'est ouvert tant qu'on n'a pas cliqué une partie.
  assert.equal(doc.getElementById("matchModal").hidden, true, "la modale reste fermée au chargement");
  // La tête de l'agent est rendue dans le scoreboard, désormais dans la modale.
  T.openMatch(0);
  assert.equal(doc.getElementById("matchModal").hidden, false, "cliquer une partie ouvre la modale");
  const agImg = doc.querySelector("#matchModalBody .ag img");
  assert.ok(agImg, "une image d'agent est présente dans le scoreboard");
  assert.match(agImg.getAttribute("src"), /uuid-(cypher|jett)\/displayicon\.png/);
  assert.ok(doc.body.classList.contains("modal-open"), "le défilement de la page est verrouillé");
  T.closeMatchFacts();
  assert.equal(doc.body.classList.contains("modal-open"), false, "…et déverrouillé à la fermeture");
});

test("le scoreboard affiche le classement par ACS (1er, 2e, …)", async () => {
  const { dom, T } = await boot();
  T.openProfile(0);
  await T.loadProfile();
  const doc = dom.window.document;
  T.openMatch(0);
  // m1 : le joueur (score 5000) > Foe (score 3500) -> 1er, Foe 2e
  const positions = [...doc.querySelectorAll("#matchModalBody td.pos")].map((e) => e.textContent.trim());
  assert.ok(positions.includes("1er"), "le meilleur ACS est marqué 1er");
  assert.ok(positions.includes("2e"), "le second ACS est marqué 2e");
  const top = doc.querySelector("#matchModalBody td.pos.top");
  assert.ok(top && top.textContent.trim() === "1er", "le 1er a la classe de mise en avant");
});

test("éditeur de roster : ajouter/retirer des lignes puis enregistrer", async () => {
  const { dom } = await boot();
  const doc = dom.window.document;
  doc.getElementById("btnEditRoster").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  const rows0 = doc.querySelectorAll("#edMembers .edrow").length;
  assert.ok(rows0 >= 1, "lignes pré-remplies depuis le roster");
  doc.getElementById("edAdd").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  assert.equal(doc.querySelectorAll("#edMembers .edrow").length, rows0 + 1, "ajout d'une ligne");
  doc.querySelector("#edMembers .edrow .edrm").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  assert.equal(doc.querySelectorAll("#edMembers .edrow").length, rows0, "retrait d'une ligne");
  // Sans token -> message d'invite
  doc.getElementById("edSave").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  assert.match(doc.getElementById("edStatus").textContent, /REFRESH_TOKEN/);
  // Avec token + ligne valide -> succès (mock)
  const row = doc.querySelector("#edMembers .edrow");
  row.querySelector('[data-f="name"]').value = "koko";
  row.querySelector('[data-f="tag"]').value = "jetti";
  doc.getElementById("edToken").value = "secret";
  doc.getElementById("edSave").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 40));
  assert.match(doc.getElementById("edStatus").textContent, /Enregistré/);
});

test("la sauvegarde manuelle enregistre TOUS les membres, un par un", async () => {
  const { T, ctx } = await boot();
  T.setSaveSpacing(0); // pas d'attente entre joueurs dans le test
  let saveCalls = 0;
  const names = new Set();
  ctx.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/save-history")) {
      saveCalls++;
      names.add(new URL(url, "http://x").searchParams.get("name"));
      return { ok: true, status: 200, json: async () => ({ ok: true, added: 0, total: 0 }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const N = roster.members.length;
  const res = await T.saveAllHistory();
  assert.equal(res.ok, N, "tous les membres sont sauvegardés");
  assert.equal(res.fail, 0, "aucun échec");
  assert.equal(saveCalls, N, "un appel save-history par membre");
  assert.equal(names.size, N, "chaque membre distinct est traité");
});

test("partie du blob : le détail complet (tous les joueurs + rang ACS) se charge à la demande", async () => {
  const { dom, T } = await boot();
  T.openProfile(0);
  await T.loadProfile();
  const doc = dom.window.document;
  const idx = T.getState().matches.findIndex((M) => M.id === "m3" && M.partial);
  assert.ok(idx >= 0, "m3 vient bien du blob (format compact, partial)");

  // Rendu synchrone : tant que le détail n'est pas chargé, positions inconnues ('—').
  T.openMatch(idx);
  assert.ok([...doc.querySelectorAll("#matchModalBody td.pos")].some((e) => e.textContent.trim() === "—"),
    "positions inconnues avant chargement du détail");

  // Laisse le chargement à la demande + le ré-affichage automatique se faire.
  await new Promise((r) => setTimeout(r, 50));
  const positions = [...doc.querySelectorAll("#matchModalBody td.pos")].map((e) => e.textContent.trim());
  assert.ok(positions.includes("1er") && positions.includes("3e"),
    "après chargement : scoreboard complet avec classement ACS");
  assert.ok(!positions.includes("—"), "plus de position inconnue une fois le détail chargé");
});

// Faits d'armes synthétiques, à la forme exacte de ce que matchFacts produit.
function fakeFacts(nRounds = 21) {
  const timeline = Array.from({ length: nRounds }, (_, i) => ({
    n: i + 1, won: i % 3 !== 0, result: "Elimination", ceremony: i === 4 ? "Ace" : "",
    myKills: 2, myDmg: 300, myScore: 240, weapon: "Vandal", armor: "Heavy",
    loadout: 3900, afk: false, plant: null, defuse: null,
    kills: [{ killer: "Moi", victim: "Foe", weapon: "Vandal", t: 12000, mine: true, onMe: false, assists: [] }],
  }));
  return { timeline, firstBloods: 4, firstDeaths: 2, multi: { 3: 2, 5: 1 }, clutches: 1,
    clutchKinds: ["1v2"], plants: 3, defuses: 1,
    weapons: [{ name: "Vandal", kills: 14 }, { name: "Sheriff", kills: 3 }],
    precision: { head: 25, body: 60, leg: 5, total: 90, hsPct: 28 },
    economy: { avgLoadout: 3800, avgSpent: 3500,
      buckets: { eco: { n: 4, won: 1, label: "Eco (<2000)" }, half: { n: 5, won: 2, label: "Demi-achat" },
                 full: { n: 12, won: 8, label: "Full buy (≥3900)" } } },
    abilities: { grenade: 4, a1: 10, a2: 8, ult: 2, total: 24, perRound: 1.1 },
    duels: [{ name: "Foe", tag: "9999", dealt: 900, received: 700 }],
    lobby: [{ name: "Moi", tag: "1", team: "Blue", mine: true, isMe: true, tier: "Gold 2", party: "A", agent: "Cypher", group: 1 },
            { name: "Foe", tag: "9999", team: "Red", mine: false, isMe: false, tier: "Gold 1", party: "B", agent: "Jett", group: 0 }] };
}

test("la modale réunit le scoreboard ET tout le détail de la partie", async () => {
  const { dom, T } = await boot();
  T.openProfile(0);
  await T.loadProfile();
  const doc = dom.window.document;
  T.getState().matches[0].facts = fakeFacts();
  T.openMatch(0);
  const body = doc.getElementById("matchModalBody").textContent;
  // Tout au même endroit : plus de scoreboard en bas de page.
  assert.match(body, /Scoreboard/, "le scoreboard est dans la modale");
  assert.match(body, /Timeline/, "…avec la timeline");
  assert.match(body, /Faits d'armes/, "…les faits d'armes");
  assert.match(body, /Armes/, "…les armes");
  assert.match(body, /Économie/, "…l'économie");
  assert.match(body, /Duels/, "…les duels");
  assert.match(body, /Lobby/, "…et le lobby");
  assert.equal(doc.getElementById("sb"), null, "l'ancienne carte scoreboard n'existe plus");
});

test("un ace est annoncé dans les faits d'armes", async () => {
  const { dom, T } = await boot();
  T.openProfile(0);
  await T.loadProfile();
  T.getState().matches[0].facts = fakeFacts();
  T.openMatch(0);
  const body = dom.window.document.getElementById("matchModalBody").textContent;
  assert.match(body, /1 ace/, "le 5k est mis en avant");
  assert.match(body, /2×3k/, "les multikills sont détaillés");
});

test("le déroulé sépare les mi-temps et donne la meilleure série", async () => {
  const { dom, T } = await boot();
  T.openProfile(0);
  await T.loadProfile();
  // 21 rounds : 12 en première mi-temps, 9 en seconde, pas de prolongation.
  T.getState().matches[0].facts = fakeFacts(21);
  T.openMatch(0);
  const body = dom.window.document.getElementById("matchModalBody").textContent;
  assert.match(body, /Déroulé/);
  assert.match(body, /mi-temps/);
  assert.match(body, /meilleure série/);
  assert.match(body, /21/, "le nombre de rounds joués est affiché");
  assert.equal(/prolongations/.test(body), false, "pas de prolongation annoncée à 21 rounds");
});

test("au-delà de 24 rounds, les prolongations apparaissent", async () => {
  const { dom, T } = await boot();
  T.openProfile(0);
  await T.loadProfile();
  T.getState().matches[0].facts = fakeFacts(27);
  T.openMatch(0);
  assert.match(dom.window.document.getElementById("matchModalBody").textContent, /prolongations/);
});

test("sans données de round, la modale le dit au lieu de faire semblant", async () => {
  const { dom, T } = await boot();
  T.openProfile(0);
  await T.loadProfile();
  const doc = dom.window.document;
  T.getState().matches[0].facts = null;
  T.openMatch(0);
  const body = doc.getElementById("matchModalBody").textContent;
  assert.match(body, /Scoreboard/, "le scoreboard reste affiché");
  assert.match(body, /indisponible/, "et l'absence de détail est annoncée");
  assert.equal(/Timeline/.test(body), false);
});

test("le détail de l'indice s'ouvre PAR-DESSUS la modale de la partie", async () => {
  const { dom, T } = await boot();
  T.openProfile(0);
  await T.loadProfile();
  const doc = dom.window.document;
  T.openMatch(0);
  const cell = doc.querySelector("#matchModalBody [data-sb]");
  assert.ok(cell, "un indice cliquable dans le scoreboard");
  cell.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(doc.getElementById("scoreModal").hidden, false, "le détail du calcul s'ouvre");
  assert.equal(doc.getElementById("matchModal").hidden, false, "…sans fermer la partie derrière");

  // Échap ne ferme que celle du dessus.
  doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(doc.getElementById("scoreModal").hidden, true, "Échap ferme le détail du calcul");
  assert.equal(doc.getElementById("matchModal").hidden, false, "et laisse la partie ouverte");
  assert.ok(doc.body.classList.contains("modal-open"), "le verrou tient tant qu'une modale reste ouverte");

  doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(doc.getElementById("matchModal").hidden, true);
  assert.equal(doc.body.classList.contains("modal-open"), false);
});

test("cliquer une ligne de match ouvre la modale de cette partie", async () => {
  const { dom, T } = await boot();
  T.openProfile(0);
  await T.loadProfile();
  const doc = dom.window.document;
  const rows = [...doc.querySelectorAll("#ml .mrow")];
  rows[1].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(doc.getElementById("matchModal").hidden, false);
  assert.ok(rows[1].classList.contains("sel"), "la ligne ouverte reste surlignée");
});

test("le graphique RR est long terme (blob + live) et trace les lignes de paliers", async () => {
  const { dom, T } = await boot();
  T.openProfile(0);
  await T.loadProfile();
  const doc = dom.window.document;
  // Série = blob (r1, r2, m1) + live (m1, m2) dédoublonné par id -> 4 points
  const cap = doc.querySelector("#curve .rrcap");
  assert.ok(cap && /4 parties/.test(cap.textContent), "le graphe couvre tout l'historique accumulé (4 points)");
  // Ligne(s) de palier : au moins un libellé de rang (mode elo)
  assert.ok(doc.querySelector("#curve .rrtierlab"), "au moins un libellé de palier est tracé");
  assert.match(doc.querySelector("#curve .rrtierlab").textContent, /Gold/);
});

test("comparaison : superpose la progression d'un second joueur", async () => {
  const { dom, T } = await boot();
  T.openProfile(0);
  await T.loadProfile();
  const doc = dom.window.document;
  const sel = doc.querySelector("#rrCompare");
  assert.ok(sel.options.length > 1, "des joueurs à comparer sont proposés");
  const opt = [...sel.options].find((o) => o.value !== "");
  sel.value = opt.value;
  sel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 40)); // laisse le fetch + re-render
  assert.equal(doc.querySelectorAll("#curve .rrleg").length, 2, "légende avec les deux joueurs");
  assert.ok(doc.querySelectorAll("#curve polyline").length >= 2, "deux courbes tracées (joueur + comparé)");
});

test("lignes de paliers : elo 878 -> Silver 3 (offset dérivé des données, pas Bronze 3)", async () => {
  const { T } = await boot();
  T.openProfile(0);
  await T.loadProfile(); // charge TIER_BY_NUM (ensureTiers)
  // Données réalistes HenrikDev : elo 878 avec tier.id 11 (Silver 3) -> offset 3
  const off = T.computeEloTierOffset([
    { elo: 878, tier: { id: 11, name: "Silver 3" } },
    { elo: 820, tier: { id: 11, name: "Silver 3" } },
  ]);
  assert.equal(off, 3, "offset = tier.id - floor(elo/100) = 11 - 8 = 3");
  T.setEloOffset(off);
  const t = T.tierFromElo(878);
  assert.ok(t && /Silver 3/.test(t.name), `elo 878 -> Silver 3 (obtenu: ${t && t.name})`);
  assert.ok(!/Bronze/.test((t && t.name) || ""), "surtout pas Bronze");
});

test("clic sur l'indice : la modale détaille le calcul et se ferme", async () => {
  const { dom, T } = await boot();
  T.openProfile(0);
  await T.loadProfile();
  const doc = dom.window.document;
  const modal = doc.getElementById("scoreModal");
  assert.equal(modal.hidden, true, "modale fermée au départ");

  // clic sur le badge du dernier match
  doc.getElementById("heroScore").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(modal.hidden, false, "la modale s'ouvre");
  const body = doc.getElementById("scoreModalBody").textContent;
  ["ACS", "KDA", "Δ Dégâts", "ADR", "Survie", "HS%", "Indice COSMO"].forEach(k =>
    assert.ok(body.includes(k), `le détail mentionne ${k}`));
  assert.equal(doc.querySelectorAll("#scoreModalBody .sd-table tbody tr").length >= 8, true,
    "6 critères + sous-total + total");

  // fermeture
  doc.getElementById("scoreModalX").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(modal.hidden, true, "la modale se ferme");
});

test("clic sur un indice de la liste des matchs ouvre son détail", async () => {
  const { dom, T } = await boot();
  T.openProfile(0);
  await T.loadProfile();
  const doc = dom.window.document;
  const badge = doc.querySelector("#ml .mrow [data-sd]");
  assert.ok(badge, "les badges de la liste sont cliquables");
  badge.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(doc.getElementById("scoreModal").hidden, false);
  assert.match(doc.getElementById("scoreModalBody").textContent, /Indice COSMO/);
});

test("peak par acte : un bloc par acte avec le meilleur rang atteint", async () => {
  const { dom, T } = await boot();
  T.openProfile(0);
  await T.loadProfile();
  const doc = dom.window.document;
  const cells = doc.querySelectorAll("#peakActs .peak-cell");
  assert.equal(cells.length, 2, "un bloc par acte (e8a2, e8a3)");
  // peak = max elo de chaque acte -> tier Gold 2 (elo ~1300-1345 -> palier 13)
  assert.ok([...doc.querySelectorAll("#peakActs .pk")].every((el) => /Gold 2/.test(el.textContent)), "le peak est un rang");
});

test("stats agent/map filtrables par acte", async () => {
  const { dom, T } = await boot();
  T.openProfile(0);
  await T.loadProfile();
  const doc = dom.window.document;
  const sel = doc.querySelector("#statsSeason");
  assert.ok([...sel.options].map((o) => o.value).includes("e8a3"), "l'acte e8a3 est proposé");
  sel.value = "e8a3";
  sel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  assert.match(doc.querySelector("#agentStats").textContent, /Cypher/, "les stats de l'acte s'affichent sans erreur");
});

test("le filtre saison/acte restreint le graphe RR à l'acte choisi", async () => {
  const { dom, T } = await boot();
  T.openProfile(0);
  await T.loadProfile();
  const doc = dom.window.document;
  const sel = doc.querySelector("#rrSeason");
  const opts = [...sel.options].map((o) => o.value);
  assert.ok(opts.includes("e8a2") && opts.includes("e8a3"), "les actes présents (e8a2, e8a3) sont listés");
  // Toutes = 4 points (r1,r2 en e8a2 + m1,m2 en e8a3)
  assert.match(doc.querySelector("#curve .rrcap").textContent, /4 parties/);
  // Filtre e8a2 -> 2 points
  sel.value = "e8a2";
  sel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  assert.match(doc.querySelector("#curve .rrcap").textContent, /2 parties/, "seul l'acte e8a2 (2 parties)");
  // Filtre e8a3 -> 2 points
  sel.value = "e8a3";
  sel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  assert.match(doc.querySelector("#curve .rrcap").textContent, /2 parties/, "seul l'acte e8a3 (2 parties)");
});

test("le sélecteur de période limite le graphe (court terme) ou montre tout (long terme)", async () => {
  const { dom, T } = await boot();
  T.openProfile(0);
  await T.loadProfile();
  const doc = dom.window.document;
  const big = Array.from({ length: 60 }, (_, i) => ({
    id: "g" + i, elo: 1300 + i, change: 1, tier: { id: 13, name: "Gold 2" },
    ts: Date.parse("2026-06-01T10:00:00Z") + i * 86400000,
  }));
  T.setRRState(big, 15); T.renderCurvePeriod();
  assert.match(doc.querySelector("#curve .rrcap").textContent, /15 parties/, "court terme = 15 dernières");
  assert.ok(doc.querySelector('#rrPeriod button[data-n="15"]').classList.contains("on"), "bouton 15 actif");

  T.setRRState(big, 0); T.renderCurvePeriod();
  assert.match(doc.querySelector("#curve .rrcap").textContent, /60 parties/, "long terme = tout l'historique");
  assert.ok(doc.querySelector('#rrPeriod button[data-n="0"]').classList.contains("on"), "bouton Tout actif");
});

test("survol du graphique RR : infobulle avec la valeur (partie + RR)", async () => {
  const { dom, T } = await boot();
  T.openProfile(0);
  await T.loadProfile();
  const doc = dom.window.document;
  const svg = doc.querySelector("#curve .rrchart");
  const hit = doc.querySelector("#curve .rrhit");
  const tip = doc.querySelector("#curve .rrtip");
  assert.ok(svg && hit && tip, "graphique + zone de survol + infobulle présents");
  // jsdom n'a pas de layout : on simule la taille rendue du SVG.
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, right: 640, bottom: 250, width: 640, height: 250 });
  hit.dispatchEvent(new dom.window.MouseEvent("mousemove", { clientX: 600, clientY: 60, bubbles: true }));
  assert.equal(tip.hidden, false, "infobulle visible au survol");
  assert.match(tip.textContent, /RR/, "l'infobulle indique une valeur de RR");
  hit.dispatchEvent(new dom.window.MouseEvent("mouseleave", { bubbles: true }));
  assert.equal(tip.hidden, true, "infobulle masquée quand la souris quitte le graphique");
});

test("RR gagné/perdu + rang affichés sur les parties classées de l'historique", async () => {
  const { dom, T } = await boot();
  T.openProfile(0);
  await T.loadProfile();
  const doc = dom.window.document;
  // m1 (le plus récent) = +18, m2 = -15 ; m3 n'est pas dans l'historique MMR -> rien
  const deltas = [...doc.querySelectorAll("#ml .mrr-delta")].map((e) => e.textContent.trim());
  assert.deepEqual(deltas, ["+18", "-15"], "deux deltas RR, dans l'ordre récent->ancien");
  const first = doc.querySelector("#ml .mrow:first-child");
  assert.ok(first.querySelector(".mrr-delta.up"), "la 1re partie est un gain (classe up)");
  assert.ok(first.querySelector(".mrr-icon"), "l'icône de rang au moment de la partie est présente");
  // 3 parties affichées mais seulement 2 ont des infos RR
  assert.equal(doc.querySelectorAll("#ml .mrow").length, 3);
  assert.equal(doc.querySelectorAll("#ml .mrr-delta").length, 2);
});

test("normalizeAny gère le format stored-matches v1 (teams objet) sans crasher", async () => {
  const { T } = await boot();
  const M = T.normalizeAny(storedV1("s1", "2026-06-10T10:00:00Z", 13, 7));
  assert.ok(M, "objet normalisé renvoyé");
  assert.equal(M.id, "s1");
  assert.equal(M.result, "w");
  assert.equal(M.myScore, 13);
  assert.equal(M.oppScore, 7);
  assert.equal(M.mode.toLowerCase(), "competitive");
  assert.equal(M.me.k, 18);
  assert.equal(M.me.agentId, "uuid-cypher");
});

test("combineMatches dédoublonne un même match présent en v4 et en v1", async () => {
  const { T } = await boot();
  const merged = T.combineMatches([rawMatch("dup", "2026-06-24T10:00:00Z")], [storedV1("dup", "2026-06-24T10:00:00Z")]);
  assert.equal(merged.length, 1, "même matchid en v4 et v1 -> une seule entrée");
});

test("le tribunal reste ranked-only après ajout de l'historique", async () => {
  const { T } = await boot();
  const nm = (mode, score100, result) => ({ me: { score100, placement: 4, kd: 1 }, mode, result });
  // 2 ranked (indice 80) + 2 unrated (indice 10) : si l'unrated comptait, la moyenne chuterait.
  const matches = [
    nm("competitive", 80, "w"), nm("unrated", 10, "l"),
    nm("competitive", 80, "w"), nm("unrated", 10, "l"),
  ];
  const v = T.computeVerdict(matches, 10);
  assert.equal(v.avg, 80, "moyenne calculée uniquement sur les parties classées");
  assert.equal(v.tier, "CRACKED");
});

test("loadSquadMatches garde le squad ranked-only même si le blob contient d'autres modes", async () => {
  const { T, ctx } = await boot();
  // Remplace le fetch : v4 -> 1 competitive ; historique -> 1 competitive + 1 unrated
  ctx.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/.netlify/functions/valo")) {
      const path = new URL(url, "http://localhost").searchParams.get("path") || "";
      if (path.includes("/v4/matches/")) return jsonRes({ data: [rawMatch("c1", "2026-06-24T10:00:00Z", true, "Competitive")] });
      return jsonRes({ data: [] });
    }
    if (url.includes("/.netlify/functions/historique")) {
      return jsonRes({ matches: [rawMatch("c2", "2026-06-20T10:00:00Z", true, "Competitive"), rawMatch("u1", "2026-06-23T10:00:00Z", true, "Unrated")] });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const squad = await T.loadSquadMatches("eu");
  const first = squad[0];
  assert.ok(first.norm.every((M) => (M.mode || "").toLowerCase() === "competitive"), "aucune partie non classée dans le squad");
  assert.equal(first.norm.length, 2, "c1 (frais) + c2 (blob), u1 (unrated) exclue");
});
