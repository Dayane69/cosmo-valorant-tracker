# COSMO — compagnon « En ce moment »

Petit programme à lancer sur ton PC **avant de jouer**. Il envoie au site ce
que tu es en train de faire, pour que la squad voie qui joue, sur quelle map,
et où en est le score.

## Pourquoi un programme sur mon PC ?

Parce qu'il n'y a **aucun autre endroit** où l'info existe. Aucune API publique
ne donne une partie en cours : ni HenrikDev (ses 58 routes sont toutes
post-partie), ni Riot. Le « Competitive — Ascent 7-5 » que tu vois sur Discord
vient exactement de la même mécanique : un programme sur la machine du joueur
qui lit l'**API locale** que le client VALORANT ouvre sur `127.0.0.1` pendant
qu'il tourne.

## Ce qu'il fait, et surtout ce qu'il ne fait pas

Il envoie : l'état (menu / sélection d'agents / en partie), le mode, la map, le
score, ton agent, la taille du groupe, ton palier, et — si tu ne le désactives
pas — les identifiants de ta boutique du jour.

Il **ne demande jamais ton mot de passe Riot**. Il s'authentifie auprès du
client *déjà ouvert* grâce au *lockfile* que celui-ci écrit sur ton disque. Les
jetons Riot restent sur ton PC : rien de tout ça n'est envoyé au site.

Il n'envoie que ce que le jeu affiche déjà à l'écran.

## Avertissement

Ces endpoints du client VALORANT sont **non officiels**. Riot les tolère
largement — tout l'écosystème des rich presence Discord vit dessus, et
HenrikDev aussi — mais rien ne le garantit formellement. Utilise-le en
connaissance de cause.

**N'utilise jamais** un outil qui te réclame ton identifiant et ton mot de
passe Riot pour la boutique. C'est inutile (le lockfile donne les mêmes accès)
et c'est le meilleur moyen de perdre un compte.

## Installation

Il faut **Node.js 18 ou plus** ([nodejs.org](https://nodejs.org)), rien d'autre :
aucune dépendance à installer.

1. Récupère le fichier :
   `https://cosmo-valo.netlify.app/companion/cosmo-live.mjs`
   (clic droit → Enregistrer sous, ou `curl -O <url>`)

2. Lance-le, avec le jeton que Dayane te donne :

   ```
   node cosmo-live.mjs --key TON_JETON
   ```

3. Lance VALORANT. Le compagnon détecte tout seul quand le jeu démarre et
   s'arrête d'envoyer quand tu le fermes.

Laisse la fenêtre ouverte pendant que tu joues. Ctrl+C pour arrêter.

## Options

| Option | Effet |
|---|---|
| `--key JETON` | Le jeton d'envoi. Peut aussi venir de la variable `COSMO_LIVE_KEY`. |
| `--no-store` | N'envoie pas la boutique, seulement l'état de jeu. |
| `--interval N` | Secondes entre deux envois (20 par défaut, minimum 10). |
| `--once` | Un seul envoi puis on quitte — pratique pour tester. |
| `--debug` | Affiche l'état brut lu dans le client. |
| `--url ...` | Autre adresse du site (par défaut `https://cosmo-valo.netlify.app`). |

## Démarrage automatique (Windows)

Crée un fichier `cosmo.bat` à côté du script :

```bat
@echo off
node "%~dp0cosmo-live.mjs" --key TON_JETON
```

Puis `Win+R` → `shell:startup` → dépose un raccourci vers ce `.bat`.

## Si ça ne marche pas

**« VALORANT n'est pas lancé — en attente. »** — normal tant que le client Riot
n'est pas ouvert. Le compagnon repartira tout seul.

**Le score ne remonte pas, ou la map est vide.** Riot renomme parfois les
champs de la présence d'un patch à l'autre. Le compagnon essaie déjà plusieurs
noms, mais si ça ne suffit plus :

```
node cosmo-live.mjs --key TON_JETON --once --debug
```

Envoie la ligne `brut :` à Dayane — c'est exactement ce qu'il faut pour
rebrancher le bon champ.

**« envoi refusé (HTTP 401) »** — le jeton est faux. **HTTP 500** — le jeton
n'est pas configuré côté serveur (variable `LIVE_TOKEN` sur Netlify).
