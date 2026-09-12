// Roster effectif, vu du serveur.
//
// Le problème que ce fichier règle. Le site privilégie le roster STOCKÉ (blob
// `cosmo-roster`, éditable dans ⚙ Paramètres) et ne retombe sur roster.json
// qu'à défaut. Les fonctions serveur, elles, importaient roster.json en
// statique — le fichier versionné, que l'éditeur ne peut pas modifier. Les
// deux moitiés du projet ne voyaient donc pas le même roster.
//
// Ce que ça donnait pour un membre ajouté ou renommé depuis l'interface :
//   - le cron de 04:00 ne le visitait jamais, son historique ne grossissait pas ;
//   - l'ouverture de son profil recevait un 403 « joueur hors roster » ;
//   - le bouton « Sauvegarder l'historique de la squad » le comptait en échec,
//     sans dire pourquoi.
// L'éditeur promettait pourtant l'inverse : « Les modifs sont partagées et
// remplacent roster.json ».
//
// Même ordre que le front, donc : blob d'abord, roster.json en repli. Le seed
// versionné reste la valeur de départ et n'est jamais écrasé.
//
// Les dépendances sont injectées (getStore), comme dans refresh-core : la
// logique reste testable hors de Netlify, où getStore n'existe pas.

import seed from "../../../roster.json" with { type: "json" };

// roster.json accepte deux formes historiques : un objet {region, members} ou
// directement le tableau de membres.
const membersOf = (r) => (r && Array.isArray(r.members) ? r.members : Array.isArray(r) ? r : []);

/* Renvoie { members, region, source }.
   `source` dit d'où ça vient ("blob" ou "seed") — utile dans les réponses JSON
   pour diagnostiquer sans avoir à deviner. */
export async function loadRoster(getStore) {
  try {
    const stored = await getStore("cosmo-roster").get("roster", { type: "json" });
    const members = membersOf(stored);
    // Un blob vide (roster réinitialisé, store pas encore créé) n'est pas un
    // roster : on repasse au seed plutôt que de ne rafraîchir personne.
    if (members.length) {
      return { members, region: (stored && stored.region) || seed.region || "eu", source: "blob" };
    }
  } catch (e) {
    // Blobs indisponible (hors Netlify, store absent) : le seed prend le relais.
  }
  return { members: membersOf(seed), region: seed.region || "eu", source: "seed" };
}

/* Retrouve un membre par pseudo#tag, insensible à la casse.
   Note : seuls les MEMBRES sont cherchés, jamais les invités. C'est voulu et
   documenté dans l'éditeur — un invité n'a ni carte, ni rafraîchissement
   automatique ; ses chiffres viennent du scoreboard des parties. */
export function findMember(members, name, tag) {
  const n = String(name || "").toLowerCase(), t = String(tag || "").toLowerCase();
  if (!n || !t) return null;
  return (members || []).find(
    (m) => m && String(m.name).toLowerCase() === n && String(m.tag).toLowerCase() === t
  ) || null;
}
