// Fonction planifiée Netlify : tourne CHAQUE HEURE pour faire grossir
// l'historique de chaque membre, sans dépendre d'une visite humaine.
//
// Pour chaque joueur : on appelle matches v4 (ce qui pousse HenrikDev à
// interroger Riot et à stocker la partie), puis on lit stored-matches et on
// fusionne le tout dans un blob persistant (Netlify Blobs) par matchid.
//
// POURQUOI CHAQUE HEURE, ET CE QUE ÇA CHANGE VRAIMENT
// Le profil qu'on ouvre est déjà frais : le front appelle matches v4 en direct
// pour ce joueur. Ce qui dépendait du cron, c'est ce qui se lit SANS ouvrir un
// profil — le bandeau d'alertes de l'accueil, qui ne lit que les blobs, et donc
// n'annonçait la session du soir qu'une fois le cron passé. À 04:00, ça voulait
// dire le lendemain. Toutes les heures, la soirée qu'on vient de jouer est là
// quand on ouvre le site.
//
// CE QUI BORNE LE TRAVAIL D'UNE EXÉCUTION
// Une fonction Netlify est coupée net à 10 s. Un passage complet, c'est 8
// membres x 3 appels, soit ~9 s : pile sur le fil. Plutôt que de parier
// dessus, chaque exécution travaille sous un budget de temps et mémorise le
// membre suivant dans un blob ; la suivante reprend là. Personne n'est affamé,
// et le plafond réel de la plateforme n'a plus d'importance.
//
// Côté quota, rien de tendu : 24 appels tiennent dans une fenêtre d'une minute
// (limite Basic : 30/min) et il n'y en a qu'une par heure.
//
// La clé API vit UNIQUEMENT dans process.env.HENRIK_KEY (jamais en dur).

import { getStore } from "@netlify/blobs";
import { runRefresh, blobKey, rotateFrom } from "./lib/refresh-core.mjs";
import { loadRoster } from "./lib/roster-source.mjs";
import { runCompsBackfill } from "./lib/comps-core.mjs";

// Parties récentes de chaque membre, pour donner au backfill des compos de quoi
// travailler. On ne relit que le haut de chaque blob (déjà trié du plus récent
// au plus ancien) : l'historique complet est déjà couvert par comps.json, ce
// passage n'a qu'à rattraper les parties du jour.
const RECENT_PER_MEMBER = 30;

// Budgets. Le total reste sous les 10 s de la plateforme, avec de la marge pour
// l'écriture du curseur et la réponse : mieux vaut rendre la main d'un membre
// trop tôt que se faire couper au milieu d'un blob.
// À l'heure des compos, les deux travaux se partagent le temps au lieu de
// s'additionner — sinon le second se ferait couper net. Ce que le
// rafraîchissement n'a pas eu le temps de faire, le passage suivant le reprend :
// c'est tout l'intérêt du curseur.
const REFRESH_BUDGET_MS = 7500;
const REFRESH_BUDGET_COMPS_HOUR_MS = 4000;
const COMPS_BUDGET_MS = 3500;

// Où reprendre au prochain passage.
const CURSOR_STORE = "cosmo-refresh";
const CURSOR_KEY = "cursor";

// Le backfill des compos ne tourne qu'une fois par jour, à cette heure UTC
// (04:00 = 05h à Paris en hiver, 06h en été) : hors des sessions de jeu.
const COMPS_HOUR_UTC = 4;

async function recentMatches(members) {
  const store = getStore("cosmo-history");
  const out = [];
  for (const m of members) {
    try {
      const list = (await store.get(blobKey(m.name, m.tag), { type: "json" })) || [];
      out.push(...list.slice(0, RECENT_PER_MEMBER));
    } catch (e) { /* un membre sans blob ne bloque pas les autres */ }
  }
  return out;
}

export default async () => {
  const apiKey = process.env.HENRIK_KEY;

  if (!apiKey) {
    return new Response(JSON.stringify({ ok: false, error: "HENRIK_KEY manquante" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  // Roster stocké d'abord (éditable dans l'interface), roster.json en repli :
  // sans ça, un membre ajouté depuis le site n'était jamais rafraîchi.
  const { members: all, region } = await loadRoster(getStore);

  // Relais : on reprend au membre où la dernière exécution s'est arrêtée.
  // L'ancienne rotation était calculée sur le JOUR — avec un passage par heure,
  // elle aurait donné le même ordre 24 fois d'affilée, et les derniers membres
  // n'auraient jamais été atteints les jours où la boucle est coupée.
  // Tout ce bloc est gardé : un store indisponible doit coûter le relais, pas
  // le rafraîchissement. Sans curseur, on repart simplement du début du roster.
  let cursorStore = null, cursor = null;
  try {
    cursorStore = getStore(CURSOR_STORE);
    cursor = (await cursorStore.get(CURSOR_KEY, { type: "json" })) || null;
  } catch (e) { /* premier passage, ou Blobs indisponible */ }
  const members = rotateFrom(all, cursor && cursor.next);

  const compsHour = new Date().getUTCHours() === COMPS_HOUR_UTC;

  try {
    const res = await runRefresh({
      roster: members, region, getStore, fetchImpl: fetch, apiKey,
      delayMs: 100,
      budgetMs: compsHour ? REFRESH_BUDGET_COMPS_HOUR_MS : REFRESH_BUDGET_MS,
    });

    // On note où reprendre. `next` vaut null quand tout le roster est passé :
    // la prochaine exécution recommence par le début.
    if (cursorStore) {
      try {
        await cursorStore.setJSON(CURSOR_KEY, { next: res.next, at: Date.now(), done: res.done });
      } catch (e) {
        console.error(`[refresh] curseur non enregistré: ${(e && e.message) || e}`);
      }
    }

    // Compos par map : on projette les parties récentes (les 10 joueurs, donc
    // les deux compos). C'est la partie coûteuse — jusqu'à 20 appels de plus,
    // ~370 Ko chacun — donc elle reste QUOTIDIENNE : la refaire chaque heure
    // ferait sortir la fenêtre d'une minute du quota Basic, pour des compos qui
    // ne servent pas une lecture « je viens de finir une game ».
    // Un échec ici ne doit pas faire passer tout le rafraîchissement pour raté :
    // l'historique, lui, est déjà écrit.
    let comps = null;
    if (compsHour) {
      try {
        comps = await runCompsBackfill({
          getStore, fetchImpl: fetch, apiKey,
          storedMatches: await recentMatches(members),
          budgetMs: COMPS_BUDGET_MS,
        });
      } catch (e) {
        console.error(`[comps] échec: ${(e && e.message) || e}`);
      }
    }

    return new Response(JSON.stringify({ ok: true, ...res, comps }), {
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e && e.message) || e) }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
};

// Toutes les heures, à l'heure pile.
export const config = { schedule: "0 * * * *" };
