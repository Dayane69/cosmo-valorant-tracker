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
- **Rapports de session** — **uniquement les parties classées** (un deathmatch ou un swiftplay n'a ni le même format ni le même enjeu, et fausserait autant le découpage que les moyennes). Les parties sont regroupées en **sessions** (des parties enchaînées à moins de la *coupure* choisie : 1 h / 2 h / 3 h / 4 h). Le découpage se fait sur l'**écart réel entre la fin d'une partie et le début de la suivante**, jamais sur le jour calendaire : une session du **samedi 23 h au dimanche 2 h reste une seule session**, et **deux sessions le même jour restent séparées**. Chaque session ouvre un rapport complet : **verdict** (croisement perf ↔ résultat, d'où des verdicts comme *« Bien joué, mal payé »* ou *« Session portée »*), bilan chiffré (V-D, RR net, indice, ACS, K/D, ADR, HS%, KAST) **comparé à ta référence** — tes autres parties classées, hors session —, **déroulé partie par partie** en barres (le signal de tilt : première moitié vs seconde), puis **ce qui allait / ce qui n'allait pas / à améliorer**. Chaque constat est **gardé** : sans référence (moins de 6 autres parties) ou sans détail de round, la règle ne se déclenche pas plutôt que d'inventer un jugement.
- **Sessions solo / duo / trio + rapport commun** — la composition est **ancrée sur le roster courant**, à partir de deux sources complémentaires :
  1. les parties au **format complet** (matches v4), qui contiennent tout le lobby avec le **pseudo actuel** de chaque joueur tel que Riot le renvoie — un membre qui **change de pseudo** est donc reconnu immédiatement, sans rien reconfigurer ;
  2. l'**historique stocké** de chaque membre (blobs), indispensable pour les parties anciennes dont on ne garde qu'une version compacte à un joueur.

  Le **puuid**, stable à travers un changement de pseudo, sert de pont entre les deux et rattache les entrées dont le nom a changé. Seuls comptent les membres présents **dans ton équipe** (un membre COSMO en face n'est pas un coéquipier), sans doublon, et la taille est plafonnée à 5 — une équipe Valorant n'en contient pas plus. Quand la partie est au format complet, le **`party_id`** précise en plus la taille réelle du groupe de queue (et donc combien de joueurs hors squad en faisaient partie).

  Une session partagée affiche un **rapport commun** : chaque membre avec ses propres stats **sur les parties de cette session**, classés par indice. Les chiffres viennent de son historique quand on l'a, sinon **du scoreboard de la partie** — un coéquipier dont le blob n'a pas encore été rafraîchi apparaît donc quand même (son ±RR, lui, reste inconnu et s'affiche `—` plutôt qu'approximé). Un onglet *Communes* filtre la liste sur les sessions jouées à plusieurs.

- **Anciens pseudos (changement de nom Riot)** — les blobs sont indexés par `pseudo#tag` : renommer un membre laisse toutes ses données accumulées orphelines sous l'ancienne clé. Pour les **matchs** ce n'est que temporaire (`stored-matches` est rattaché au compte, le cron les ramène), mais la **progression RR est définitivement perdue** : `mmr-history` ne renvoie qu'une fenêtre courte, c'est le blob `cosmo-rr` qui l'accumule au fil des jours.

  Le champ **`alias`** d'un membre (⚙ Paramètres → *Modifier le roster* → *anciens pseudos*, ou `"alias": ["Ancien#tag"]` dans `roster.json`) liste ses anciens `Pseudo#tag`. Le front lit alors **toutes** ses clés et fusionne : historique dédoublonné par `match_id`, série RR par `match_id`/date. La courbe d'elo redevient continue **à travers le renommage**, et l'ancienne progression réapparaît. Le pseudo courant est prioritaire au dédoublonnage, un alias en échec est absorbé sans perdre les données courantes, et une saisie mal formée est **rejetée plutôt que devinée** (jusqu'à 5 alias par membre, validés côté serveur aussi). Rien n'est déplacé ni écrasé : les alias ne servent qu'à la **lecture**.
- **Records de session** — le « best of » d'une période (30 j / 90 j / tout) : meilleure et pire session, plus grosse remontée et plus grosse chute de RR, session la plus longue, meilleure session commune, et la **plus longue série de victoires** — qui, elle, se calcule sur les parties et peut donc **traverser plusieurs sessions**. Meilleure/pire exigent au moins `RECORD_MIN_GAMES` parties : sur une session de deux parties, l'échantillon ne veut rien dire. Un record sans vainqueur n'est pas affiché (pas de « plus grosse remontée » si aucune session n'est positive). Chaque record est cliquable et ouvre le rapport de sa session.
- **Partage d'une session** — bouton *🔗 Copier le lien* dans le rapport. Le lien porte **qui** et **quand** (`?s=Pseudo%23tag&t=<début>&g=<coupure>`) et la page **recalcule** le rapport depuis les mêmes données publiques : pas de stockage, pas de fonction serverless en plus, rien qui expire, et le rapport reste toujours cohérent avec le site. À l'ouverture, le profil se charge et le rapport s'affiche directement — après les historiques de la squad, pour que le **rapport commun** soit complet. La coupure transportée est bornée (une valeur farfelue déplacerait les frontières de session), la cible est retrouvée même si le découpage a un peu bougé depuis, et si la session est introuvable un **message clair** le dit au lieu d'ouvrir un rapport au hasard. Un lien partagé sous un **ancien pseudo** continue de fonctionner (cf. alias). Le site étant déjà public, partager un lien n'expose rien de plus qu'un profil.
- **Alertes de session (accueil)** — un bandeau discret quand une session récente mérite qu'on en parle : *« Yakuza — 7 parties d'affilée hier soir, les 3 dernières bien en dessous (indice 77 → 50). »*. Trois déclencheurs : **session trop longue qui s'effondre** (≥ 6 parties et baisse d'indice entre les deux moitiés), **grosse chute de RR**, et **belle remontée** — pour que le bandeau ne soit pas qu'un rabat-joie. Une seule alerte par membre (la plus grave), 3 au maximum, et seulement sur les 3 derniers jours. Un clic ouvre le rapport de la session concernée.

  > Source : les **blobs d'historique uniquement**, donc aucun appel HenrikDev sur l'accueil et aucun risque de rate limit. Contrepartie assumée : une session jouée ce soir n'apparaît qu'une fois le blob rafraîchi (cron de 04:00 UTC, ou simple ouverture du profil).
- **Tribunal COSMO (v2)** — la jauge *Unlucky or Bad*. L'ancienne version tranchait sur le **seul indice moyen** : « UNLUCKY » n'était qu'une note médiane, ce qui n'a rien à voir avec la chance. Le verdict croise maintenant **deux axes indépendants** : la **performance** (indice moyen pondéré par les rounds) et le **résultat** (RR net réel, à défaut le winrate). Bien jouer et perdre → **UNLUCKY**. Mal jouer et gagner → **PORTÉ**. L'aiguille, elle, continue d'indiquer la performance, et l'arc est étiqueté en conséquence (FAIBLE / CORRECT / ÉNORME) : **à aiguille identique le verdict peut différer**, et c'est précisément l'information. `BAD` est réservé à une perf réellement basse — au-dessus du seuil, perdre ne suffit pas à faire de toi le problème. Le détail rapporte ce qui justifie le verdict : indice, RR net, **régularité** (σ de l'indice) et nombre de **sessions parties en vrille**.
- **Leaderboard** — classement de la squad sur les N dernières classées, badges (Carry, Bourreau, Headhunter, Le plus konstant, Late night warrior…), comparateur 1v1, et **duos détectés** : les paires retrouvées dans la **même équipe** (croisement par `match_id`), avec le winrate du duo **et son écart face au winrate de chacun sans l'autre** — le chiffre intéressant. Un duo qui ne joue jamais séparément n'a pas de référence : l'écart affiche `—` plutôt qu'un nombre inventé.
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
npm test      # node --test : fusion/dédoublonnage, profil, tribunal ranked-only, cron idempotent, sessions, duos
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
