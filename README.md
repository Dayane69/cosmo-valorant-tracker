# COSMO — Valorant Tracker

Tracker Valorant personnalisé pour la squad **COSMO**. Sélectionne un joueur pour
ouvrir son tracker, compare la team, et tranche le débat ultime : **Unlucky or Bad**.

L'app est un site statique (HTML/CSS/JS, sans framework) servi par Netlify, avec une
petite fonction serverless qui sert de proxy vers l'API [HenrikDev](https://docs.henrikdev.xyz/)
afin de garder la clé API **hors du navigateur**.

## ✨ Fonctionnalités

- **Agent select** — une carte par membre de la squad avec le portrait de son agent fétiche et son rang affiché en direct (avec l'icône du palier).
- **Profil joueur** — rang actuel (icône + RR), indice COSMO /100, liste des matchs filtrable par mode, et un scoreboard détaillé : **tête de chaque agent** et **classement par ACS** (1er, 2e, …). Chaque partie classée affiche aussi le **RR gagné/perdu** et le **rang du joueur au moment de la game**. Pour les parties venues du blob (format compact), le scoreboard complet (tous les joueurs) est **chargé à la demande** au clic via l'endpoint match-by-id.
- **Progression RR long terme** — un graphique d'**elo** (le MMR qui grimpe à travers les rangs) qui s'appuie sur l'historique MMR **accumulé dans un blob** (`cosmo-rr`) : il grossit jour après jour au lieu d'être plafonné à la courte fenêtre de l'API. Lignes horizontales par **palier de rang** (Gold 2, Gold 3…) avec leur couleur, **infobulle au survol** (date, rang, elo, ±RR), **sélecteur de période** (15 / 50 / Tout) et **filtre par saison/acte** (E8 · A3…).
- **Indice COSMO /100 (v2)** — un score de perf maison sur 6 critères (ACS, **KAST**, KDA, Δ dégâts, ADR, HS%), noté sur une échelle interne où **une partie moyenne en ranked vaut 50**, puis **mis à l'échelle** (courbe `SCORE_GAMMA`) pour être comparable aux autres trackers : une partie moyenne s'affiche ~64, une bonne ~76, une excellente ~86. La courbe est strictement croissante, donc **l'ordre des parties ne change jamais**, et les paliers S/A/B/C/D/F sont décalés d'autant pour que les libellés gardent le même sens. Le **KAST** (% de rounds avec Kill, Assist, Survie ou Trade) est **recalculé à partir des évènements de kill** de la partie — l'API ne le fournit pas, mais les données de round sont déjà dans la réponse, donc **aucun appel supplémentaire**. Sur les parties compactes du blob (sans détail de round), il est remplacé par un critère de survie. Il tient compte du **classement dans le lobby**, de la **victoire/défaite**, et rapproche la note de la moyenne sur les **parties écourtées par forfait** (trop peu de rounds pour juger). **Clique sur n'importe quel indice** (carte du dernier match, liste des matchs, scoreboard) pour voir le **détail complet du calcul** : valeur brute, note /100, poids et points de chaque critère, puis les ajustements.
- **Détail d'une partie** — bouton *🔍 Détail de la partie* sous le scoreboard : **timeline round par round** (gagné/perdu, comment le round s'est fini, tes kills, spike posée/désamorcée, badges Ace/Clutch/Flawless/Thrifty) avec le **feed des éliminations** de chaque round au clic ; **faits d'armes** (first bloods/deaths, multikills, clutches avec leur taille, spikes) ; **armes & précision** (kills par arme, répartition exacte tête/corps/jambes) ; **économie & utilitaire** (achat moyen, crédits dépensés par round, répartition eco / demi-achat / full buy **avec le taux de victoire de chaque tranche**, et compétences utilisées dont les ultimates) ; **duels** (dégâts infligés/subis face à chaque adversaire) ; et **lobby** (rang de chacun + groupes détectés via `party_id`). *(Le HS% **par arme** n'est pas exposé par l'API — aucun indicateur de headshot sur un kill ni sur un évènement de dégâts — il n'est donc pas affiché plutôt qu'approximé.)* Tout vient des données de round déjà téléchargées avec la partie — **aucun appel API supplémentaire** — et n'est conservé que sous forme compacte (~28 Ko au lieu des ~460 Ko bruts).
- **Rapports de session** — les parties sont regroupées en **sessions** (des parties enchaînées à moins de la *coupure* choisie : 1 h / 2 h / 3 h / 4 h). Le découpage se fait sur l'**écart réel entre la fin d'une partie et le début de la suivante**, jamais sur le jour calendaire : une session du **samedi 23 h au dimanche 2 h reste une seule session**, et **deux sessions le même jour restent séparées**. Chaque session ouvre un rapport complet : **verdict** (croisement perf ↔ résultat, d'où des verdicts comme *« Bien joué, mal payé »* ou *« Session portée »*), bilan chiffré (V-D, RR net, indice, ACS, K/D, ADR, HS%, KAST) **comparé à ta référence** — tes autres parties **dans les mêmes modes** —, **déroulé partie par partie** en barres (le signal de tilt : première moitié vs seconde), puis **ce qui allait / ce qui n'allait pas / à améliorer**. Chaque constat est **gardé** : sans référence (moins de 6 autres parties) ou sans détail de round, la règle ne se déclenche pas plutôt que d'inventer un jugement.
- **Sessions solo / duo / trio + rapport commun** — la composition vient du **croisement des historiques par `match_id`** (donc disponible sur *tout* l'historique, y compris les parties compactes du blob) : les membres COSMO présents **dans ton équipe** sur une partie. Quand la partie est au format complet, le **`party_id`** précise en plus la taille réelle du groupe de queue (et donc combien de joueurs hors squad en faisaient partie). Une session partagée affiche un **rapport commun** : chaque membre avec ses propres stats **sur les parties de cette session**, classés par indice. Un onglet *Communes* filtre la liste sur les sessions jouées à plusieurs.
- **Tribunal COSMO** — la jauge *Unlucky or Bad* qui juge tes dernières parties classées.
- **Leaderboard** — classement de la squad, badges (Carry, Bourreau, Headhunter…), comparateur 1v1 et détection des duos.
- **Historique grandissant** — un cron quotidien fait grossir l'historique stocké de chaque membre côté serveur, sans qu'il faille ouvrir un profil (voir plus bas).
- **Comparaison 2 joueurs** — superpose la progression RR d'un second joueur sur le graphe.
- **Roster éditable depuis l'UI** — ⚙ Paramètres → *Modifier le roster* : ajoute/retire/édite les membres (stocké côté serveur dans un blob, protégé par `REFRESH_TOKEN`, `roster.json` reste la valeur de départ).
- **PWA & mobile** — installable sur mobile/desktop (manifest + icône + service worker qui cache le shell ; les données restent toujours fraîches). L'interface est pensée **mobile-first** : aucune page ne déborde horizontalement, les tableaux larges (scoreboard, stats par agent/map) **défilent dans leur propre conteneur** avec un dégradé qui signale qu'il reste du contenu, les cibles tactiles font **≥ 44 px** sur écran tactile (`@media(pointer:coarse)`), et les **encoches / barres système iOS** sont gérées via les `safe-area-inset`.

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
        ├── refresh-now.mjs          # déclenchement manuel (protégé par REFRESH_TOKEN)
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

### Déclenchement manuel (sans attendre le cron)

- **Depuis le site (recommandé)** : ⚙ Paramètres → **« ⟳ Sauvegarder l'historique
  de la squad »**. Le navigateur appelle `save-history` **un joueur à la fois**,
  espacé (~1,8 s) avec retry sur 429, et affiche la progression. Comme chaque appel
  est une fonction Netlify courte, on évite à la fois la rafale (rate limit) et la
  limite de 10 s d'exécution → **tous** les membres sont bien enregistrés, quel que
  soit leur nombre. Aucun secret requis (endpoint restreint au roster).
- **En direct / script (curl)** : `netlify/functions/refresh-now.mjs` rejoue toute
  la boucle côté serveur, protégé par le secret `REFRESH_TOKEN` (variable d'env) :
  ```bash
  curl -X POST "https://cosmo-valo.netlify.app/.netlify/functions/refresh-now?key=LE_SECRET"
  ```
  ⚠️ Une seule fonction fait alors toute la boucle : sur beaucoup de membres, elle
  peut buter sur la limite de 10 s / le rate limit — préfère le bouton du site.

Le cron quotidien **tourne l'ordre des membres chaque jour** : si une exécution est
coupée, ce ne sont pas toujours les mêmes joueurs qui passent en dernier.

### Netlify Blobs
Le store clé-valeur **Netlify Blobs** est activé automatiquement sur un site
Netlify standard — aucune configuration supplémentaire n'est requise. (Vérifier
quand même, dans l'onglet *Blobs* du site, qu'il est bien disponible après le
premier déploiement.)

## 🚀 Déploiement (Netlify)

1. Crée un site Netlify connecté à ce repo (ou `netlify deploy`).
2. Récupère une clé API sur le [Discord HenrikDev](https://docs.henrikdev.xyz/authentication-and-authorization).
3. Dans **Site settings → Environment variables**, ajoute :

   | Variable        | Valeur                                   | Obligatoire ? |
   | --------------- | ---------------------------------------- | ------------- |
   | `HENRIK_KEY`    | ta clé API HenrikDev                     | oui           |
   | `REFRESH_TOKEN` | un secret au choix (pour le bouton ⟳)    | optionnel     |

   > Ces clés sont lues **uniquement** côté serveur (fonctions Netlify).
   > Elles n'apparaissent jamais dans le code envoyé au navigateur.

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
npm test      # node --test : fusion/dédoublonnage, profil, tribunal ranked-only, cron idempotent, sessions
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
- **Sessions** : `SESSION_GAP_MIN` (coupure par défaut, aussi réglable depuis l'UI),
  `BASELINE_MIN` (parties nécessaires pour comparer) et les règles de diagnostic
  dans `analyzeSession()` / `sessionVerdict()`.

---

Projet perso, *vibe codé*. Vannes et seuils en exemples — à régler ensemble. 🎯
