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

## 🗂️ Structure du projet

```
.
├── index.html              # UI + styles (tout le CSS est inline dans le <head>)
├── app.js                  # logique front : fetch, calcul des stats, rendu
├── netlify.toml            # config de build / fonctions Netlify
└── netlify/
    └── functions/
        └── valo.mjs        # proxy serverless vers l'API HenrikDev (cache la clé)
```

### Sources d'images
- **Agents & rangs** : [valorant-api.com](https://valorant-api.com) (têtes d'agents, icônes de paliers, splash des maps) — chargé et mis en cache côté client.
- **Stats joueurs/matchs** : [HenrikDev API](https://docs.henrikdev.xyz/) via le proxy Netlify.

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

## ⚙️ Personnalisation

- **La squad** : édite la constante `ROSTER` en haut de `app.js` (pseudo, tag, agent,
  `uuid` de l'agent et couleur). Mets à jour les cartes correspondantes dans `index.html`.
  Un membre peut avoir une image custom via `customImg` (cf. l'entrée *Son Goku*).
- **Région** : sélectionnable depuis ⚙ Paramètres sur l'accueil (`eu`, `na`, `ap`, `kr`, `latam`, `br`).
- **Seuils de l'indice** : voir `perfScore()` et `tierOf()` dans `app.js`.

---

Projet perso, *vibe codé*. Vannes et seuils en exemples — à régler ensemble. 🎯
