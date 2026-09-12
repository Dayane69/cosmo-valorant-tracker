// Proxy HenrikDev : ce qui passe, ce qui ne passe pas.
//
// Cette fonction est publique et porte NOTRE clé. Sa seule barrière était
// « le chemin commence par /valorant/ » — la liste d'origines juste à côté ne
// protège que les navigateurs, un curl n'est pas concerné par le CORS. Ces
// tests figent la liste blanche, et surtout le fait qu'elle reste alignée sur
// ce que le front appelle vraiment.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import handler, { allowedPath } from "../netlify/functions/valo.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MID = "8d4b1c2e-0000-4aaa-bbbb-1234567890ab";

/* ----------------------------------------------------------- liste blanche */

test("les routes du site passent", () => {
  const ok = [
    "/valorant/v2/account/Yakuza/2826",
    "/valorant/v3/mmr/eu/pc/Yakuza/2826",
    "/valorant/v2/mmr-history/eu/pc/Yakuza/2826",
    "/valorant/v4/matches/eu/pc/Yakuza/2826",
    `/valorant/v4/match/eu/${MID}`,
  ];
  for (const p of ok) assert.equal(allowedPath(p), p, p);
});

test("tout le reste de l'API est refusé, y compris sous /valorant/", () => {
  const ko = [
    "/valorant/v1/premier/quelquechose",              // route réelle, mais pas la nôtre
    "/valorant/v1/stored-matches/eu/Yakuza/2826",     // appelée côté serveur, jamais via le proxy
    "/valorant/v3/matches/eu/Yakuza/2826",            // ancienne version
    "/valorant/v4/matches/eu/console/Yakuza/2826",    // autre plateforme
    "/valorant/v2/account/Yakuza",                    // incomplet
    "/valorant/v2/account/Yakuza/2826/extra",         // un segment de trop
    "/autre/chose",
    "",
  ];
  for (const p of ko) assert.equal(allowedPath(p), null, p);
});

test("on ne peut pas sortir de HenrikDev ni remonter l'arborescence", () => {
  // Normalisé en « /premier/… », qui ne correspond à aucune route.
  assert.equal(allowedPath("/valorant/v2/../../premier/x"), null);
  // Une autorité glissée dans le chemin : l'origine change, donc c'est refusé.
  assert.equal(allowedPath("//ailleurs.example/valorant/v2/account/a/b"), null);
  assert.equal(allowedPath("https://ailleurs.example/valorant/v2/account/a/b"), null);
});

test("seuls size et mode survivent, et seulement bien formés", () => {
  assert.equal(
    allowedPath("/valorant/v4/matches/eu/pc/Yakuza/2826?size=20&mode=competitive"),
    "/valorant/v4/matches/eu/pc/Yakuza/2826?size=20&mode=competitive");
  // Tout le reste est jeté : rien ne le justifie, et c'est autant de surface en moins.
  assert.equal(
    allowedPath("/valorant/v4/matches/eu/pc/Yakuza/2826?size=20&api_key=vole&callback=x"),
    "/valorant/v4/matches/eu/pc/Yakuza/2826?size=20");
  // Valeurs aberrantes : écartées plutôt que relayées.
  assert.equal(
    allowedPath("/valorant/v4/matches/eu/pc/Yakuza/2826?size=99999"),
    "/valorant/v4/matches/eu/pc/Yakuza/2826");
});

/* ------------------------------------------------------------- le handler */

// Un faux HenrikDev qui note l'URL appelée.
function stubUpstream() {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response('{"data":null}', { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const call = (path) =>
  handler(new Request(`https://cosmo-valo.netlify.app/.netlify/functions/valo?path=${encodeURIComponent(path)}`));

test("une route refusée ne touche jamais l'API — donc ne consomme aucun quota", async () => {
  const up = stubUpstream();
  process.env.HENRIK_KEY = "clé-de-test";
  try {
    const res = await call("/valorant/v1/premier/x");
    assert.equal(res.status, 400);
    assert.equal(up.calls.length, 0, "aucun appel ne doit partir");
  } finally { up.restore(); }
});

test("une route acceptée part vers HenrikDev, reconstruite", async () => {
  const up = stubUpstream();
  process.env.HENRIK_KEY = "clé-de-test";
  try {
    const res = await call("/valorant/v4/matches/eu/pc/Yakuza/2826?size=20&tiers=x");
    assert.equal(res.status, 200);
    assert.equal(up.calls.length, 1);
    assert.equal(up.calls[0], "https://api.henrikdev.xyz/valorant/v4/matches/eu/pc/Yakuza/2826?size=20");
  } finally { up.restore(); }
});

/* --------------------------------------------- alignement avec le vrai front */

test("toutes les routes appelées par app.js sont dans la liste blanche", () => {
  const code = readFileSync(join(root, "app.js"), "utf8");
  // Les appels ont tous la forme api(`/valorant/...`). Les interpolations sont
  // remplacées par un jeton plausible : ce qu'on vérifie, c'est la FORME.
  const found = [...code.matchAll(/api\(`(\/valorant\/[^`]*)`/g)]
    .map((m) => m[1].replace(/\$\{[^}]*\}/g, "eu"));

  assert.ok(found.length >= 5, `routes trouvées dans app.js : ${found.length}`);
  for (const p of found) {
    assert.ok(allowedPath(p), `app.js appelle ${p}, que le proxy refuserait`);
  }
});
