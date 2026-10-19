// Fonction planifiée Netlify : TOUTES LES 5 MINUTES, garde l'historique de
// chaque membre à jour sans dépendre d'une visite humaine.
//
// POURQUOI 5 MINUTES
// Avant, une fois par heure, chaque passage ne mettait à jour que 2 ou 3
// joueurs (3 appels HenrikDev chacun, sous un budget de temps) : il fallait
// jusqu'à 3 h pour que tout le roster soit à jour. Le récap Discord et le
// rapport de session lisaient donc un historique en retard, et seule
// l'ouverture d'un profil sur le site forçait la mise à jour d'un joueur.
//
// CE QUI REND ÇA POSSIBLE (voir watchRefresh dans lib/refresh-core.mjs)
// Une vérification légère d'abord (l'historique RR, un petit appel par
// joueur), puis une vraie mise à jour seulement pour ceux qui sortent de
// partie, plus un joueur en tour complet à chaque passage. ~10 appels par
// passage, 17 au pire, sous la limite de 30 par minute.
//
// La clé API vit UNIQUEMENT dans process.env.HENRIK_KEY (jamais en dur).

import { getStore } from "@netlify/blobs";
import { watchRefresh, blobKey } from "./lib/refresh-core.mjs";
import { loadRoster } from "./lib/roster-source.mjs";
import { runCompsBackfill } from "./lib/comps-core.mjs";

// Parties récentes de chaque membre, pour donner au backfill des compos de quoi
// travailler. On ne relit que le haut de chaque blob (déjà trié du plus récent
// au plus ancien) : l'historique complet est déjà couvert par comps.json, ce
// passage n'a qu'à rattraper les parties du jour.
const RECENT_PER_MEMBER = 30;

// Budgets : une fonction planifiée est coupée à 30 s. Au passage des compos
// (une fois par jour), la surveillance laisse du temps au backfill.
const WATCH_BUDGET_MS = 18000;
const WATCH_BUDGET_COMPS_MS = 12000;
const COMPS_BUDGET_MS = 8000;

// Où reprendre le tour complet, et ce qu'a fait le dernier passage
// (lisible avec refresh-now?key=…&state=1).
const CURSOR_STORE = "cosmo-refresh";
const CURSOR_KEY = "cursor";

// Le backfill des compos : UN passage par jour, le premier de 04:00 UTC
// (05h à Paris en hiver, 06h en été), hors des sessions de jeu. Il coûte
// jusqu'à 20 appels : le refaire à chaque passage viderait le quota.
const COMPS_HOUR_UTC = 4;
export const isCompsRun = (d) => d.getUTCHours() === COMPS_HOUR_UTC && d.getUTCMinutes() < 5;

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
      status: 500, headers: { "content-type": "application/json" },
    });
  }
  // Roster stocké d'abord (éditable dans l'interface), roster.json en repli.
  const { members, region } = await loadRoster(getStore);

  let cursorStore = null, cursor = null;
  try {
    cursorStore = getStore(CURSOR_STORE);
    cursor = (await cursorStore.get(CURSOR_KEY, { type: "json" })) || null;
  } catch (e) { /* premier passage, ou Blobs indisponible */ }

  const compsRun = isCompsRun(new Date());
  try {
    const res = await watchRefresh({
      roster: members, region, getStore, fetchImpl: fetch, apiKey,
      sweepKey: cursor && cursor.next,
      budgetMs: compsRun ? WATCH_BUDGET_COMPS_MS : WATCH_BUDGET_MS,
    });
    if (cursorStore) {
      try {
        await cursorStore.setJSON(CURSOR_KEY, { next: res.nextSweep, at: Date.now(),
          last: { checked: res.checked, played: res.played, added: res.added, swept: res.swept, fail: res.fail, errors: res.errors } });
      } catch (e) { console.error(`[refresh] curseur non enregistré: ${(e && e.message) || e}`); }
    }
    let comps = null;
    if (compsRun) {
      try {
        comps = await runCompsBackfill({ getStore, fetchImpl: fetch, apiKey,
          storedMatches: await recentMatches(members), budgetMs: COMPS_BUDGET_MS });
      } catch (e) { console.error(`[comps] échec: ${(e && e.message) || e}`); }
    }
    return new Response(JSON.stringify({ ok: true, ...res, comps }), { headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e && e.message) || e) }), {
      status: 500, headers: { "content-type": "application/json" },
    });
  }
};

// Toutes les 5 minutes.
export const config = { schedule: "*/5 * * * *" };
