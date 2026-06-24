# COSMO — Valorant Tracker

Tracker Valorant personnalisé pour la squad **COSMO**. Sélectionne un joueur pour
ouvrir son tracker, compare la team, et tranche le débat ultime : **Unlucky or Bad**.

L'app est un site statique (HTML/CSS/JS, sans framework) servi par Netlify, avec une
petite fonction serverless qui sert de proxy vers l'API [HenrikDev](https://docs.henrikdev.xyz/)
afin de garder la clé API **hors du navigateur**.

## ✨ Fonctionnalités

- **Agent select** — une carte par membre de la squad avec le portrait de son agent fétiche et son rang affiché en direct (avec l'icône du palier).
- **Profil joueur** — rang actuel (icône + RR), indice COSMO /100, progression du RR, liste des matchs filtrable par mode, et un scoreboard détaillé montrant **la tête de chaque agent**.
- **Indice COSMO /100** — un score de perf maison calculé à partir de l'ACS, du différentiel de dégâts, du K/D, de l'ADR et du HS%.
- **Tribunal COSMO** — la jauge *Unlucky or Bad* qui juge tes dernières parties classées.
- **Leaderboard** — classement de la squad, badges (Carry, Bourreau, Headhunter…), comparateur 1v1 et détection des duos.
- **Historique grandissant** — un cron quotidien fait grossir l'historique stocké de chaque membre côté serveur, sans qu'il faille ouvrir un profil (voir plus bas).

## 🗂️ Structure du projet

```
.
├── index.html                       # UI + styles (CSS inline dans le <head>)
├── app.js                           # logique front : fetch, calcul des stats, rendu
├── roster.json                      # SOURCE DE VÉRITÉ unique de la squad (membres + région)
├── netlify.toml                     # config de build / fonctions Netlify
├── package.json                     # deps (@netlify/blobs) + tests
├── test/                            # tests (node --test + jsdom)
└── netlify/
    └── functions/
        ├── valo.mjs                 # proxy serverless vers HenrikDev (cache la clé)
        ├── refresh-matches.mjs      # fonction PLANIFIÉE (cron quotidien)
        ├── historique.mjs           # lecture de l'historique accumulé (blob)
        └── lib/refresh-core.mjs     # logique de fusion/refresh (testable, sans dépendance)
```

> **Roster = une seule source de vérité.** `roster.json` est lu à la fois par le
> front (`app.js` construit les cartes dynamiquement) et par la fonction planifiée.
> Pour modifier la squad, on n'édite que ce fichier.

### Sources de données
- **Agents & rangs** : [valorant-api.com](https://valorant-api.com) (têtes d'agents, icônes de paliers, splash des maps) — chargé et mis en cache côté client.
- **Stats joueurs/matchs** : [HenrikDev API](https://docs.henrikdev.xyz/) via le proxy Netlify.
- **Historique accumulé** : endpoint `stored-matches` de HenrikDev, agrégé jour après jour dans **Netlify Blobs** (store `cosmo-history`).

## 🔄 Rafraîchissement automatique quotidien

`netlify/functions/refresh-matches.mjs` est une **fonction planifiée Netlify**
(disponible sur tous les plans, y compris gratuit) qui tourne **chaque jour à
04:00 UTC** (soit 05h à Paris en hiver, 06h en été).

Pour chaque membre du roster, elle :
1. appelle `matches` v4 — ce qui pousse HenrikDev à interroger Riot et à **stocker**
   la partie (peu importe qui déclenche l'appel) ;
2. lit `stored-matches` (tout l'historique stocké pour ce joueur) ;
3. fusionne par `matchid` avec le blob existant et le réécrit.

Résultat : l'historique grossit tout seul, **sans dépendre d'une visite humaine**.
Le front combine ensuite cet historique (`/.netlify/functions/historique`) avec les
parties fraîches de `matches` v4, dédoublonnées par `matchid`.

> Les appels du cron sont **séquentiels et espacés** pour rester dans le rate limit
> HenrikDev (30 req/min en Basic, 90 en Advanced). L'échec d'un membre est loggé
> sans interrompre la boucle.

### Netlify Blobs
Le store clé-valeur **Netlify Blobs** est activé automatiquement sur un site
Netlify standard — aucune configuration supplémentaire n'est requise. (Vérifier
quand même, dans l'onglet *Blobs* du site, qu'il est bien disponible après le
premier déploiement.)

## 🚀 Déploiement (Netlify)

1. Crée un site Netlify connecté à ce repo (ou `netlify deploy`).
2. Récupère une clé API sur le [Discord HenrikDev](https://docs.henrikdev.xyz/authentication-and-authorization).
3. Dans **Site settings → Environment variables**, ajoute :

   | Variable     | Valeur                  |
   | ------------ | ----------------------- |
   | `HENRIK_KEY` | ta clé API HenrikDev    |

   > La clé est lue **uniquement** côté serveur dans `netlify/functions/valo.mjs`.
   > Elle n'apparaît jamais dans le code envoyé au navigateur.

4. Déploie. C'est tout — pas d'étape de build, le site est statique.

> **Note CORS :** la fonction n'autorise que les origines listées dans `ALLOWED_PATTERNS`
> (`valo.mjs`). Si tu déploies sous un autre nom de domaine que `cosmo-valo.netlify.app`,
> adapte ces patterns.

## 💻 Développement local

Le plus simple, avec le [Netlify CLI](https://docs.netlify.com/cli/get-started/)
(pour que la fonction proxy tourne aussi) :

```bash
npm install -g netlify-cli
export HENRIK_KEY="ta_cle_henrikdev"
netlify dev
```

Le site sera dispo sur `http://localhost:8888`.

> Sans la fonction, un simple serveur statique (`python3 -m http.server`) affiche l'UI,
> mais les appels API échoueront tant que `/.netlify/functions/valo` n'est pas servi.

### Tests

```bash
npm install   # jsdom + @netlify/blobs
npm test      # node --test : fusion/dédoublonnage, profil, tribunal ranked-only, cron idempotent
npm run check # node --check sur tous les fichiers .js / .mjs
```

## ⚙️ Personnalisation

- **La squad** : édite **uniquement `roster.json`** (pseudo, tag, agent, `uuid` de
  l'agent, couleur, `mono` 2 lettres, et `region` par défaut). Le front et le cron
  lisent ce seul fichier. Un membre peut avoir une image custom via `customImg`
  (cf. l'entrée *Son Goku*).
- **Région** : `region` dans `roster.json` (valeur par défaut), aussi changeable
  depuis ⚙ Paramètres sur l'accueil (`eu`, `na`, `ap`, `kr`, `latam`, `br`).
- **Heure du cron** : `export const config = { schedule }` dans `refresh-matches.mjs` (UTC).
- **Seuils de l'indice** : voir `perfScore()` et `tierOf()` dans `app.js`.

---

Projet perso, *vibe codé*. Vannes et seuils en exemples — à régler ensemble. 🎯
