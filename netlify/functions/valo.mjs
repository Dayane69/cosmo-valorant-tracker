// Proxy HenrikDev cote serveur : regle le CORS et garde la cle hors du navigateur.
// La cle se lit UNIQUEMENT dans la variable d'environnement Netlify HENRIK_KEY.
// Aucune cle en dur ici (sinon le scanner de secrets Netlify fait echouer le build).

const UPSTREAM = "https://api.henrikdev.xyz";

const ALLOWED_PATTERNS = [
  /^https:\/\/cosmo-valo\.netlify\.app$/,
  /^https:\/\/deploy-preview-\d+--cosmo-valo\.netlify\.app$/,
  /^https:\/\/[a-z0-9-]+--cosmo-valo\.netlify\.app$/,
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
];

/* Les SEULES routes que le site appelle à travers ce proxy.
   Le préfixe "/valorant/" ne suffisait pas : la liste d'origines ci-dessus ne
   protège que les navigateurs — un curl n'est pas concerné par le CORS. Cette
   fonction étant publique, n'importe qui pouvait donc l'utiliser comme proxy
   Valorant gratuit, sur n'importe laquelle des routes de HenrikDev, avec NOTRE
   clé et NOTRE quota. Tout le reste du code se bat déjà contre le rate limit
   (retry sur 429, appels par paquets de 3, mention des membres non rafraîchis) :
   une clé consommée à notre insu, c'est exactement le quota qui manque le soir
   où la squad joue.
   Ajouter une route ici est volontaire : le jour où le front en appelle une
   nouvelle, elle doit apparaître dans cette liste. */
const ALLOWED_ROUTES = [
  /^\/valorant\/v2\/account\/[^/]+\/[^/]+$/,                      // pseudo#tag -> puuid
  /^\/valorant\/v3\/mmr\/[a-z]{2,5}\/pc\/[^/]+\/[^/]+$/,          // rang courant
  /^\/valorant\/v2\/mmr-history\/[a-z]{2,5}\/pc\/[^/]+\/[^/]+$/,  // progression RR
  /^\/valorant\/v4\/matches\/[a-z]{2,5}\/pc\/[^/]+\/[^/]+$/,      // parties récentes
  /^\/valorant\/v4\/match\/[a-z]{2,5}\/[^/]+$/,                   // une partie par son id
];

/* Valide le chemin demandé et le RECONSTRUIT à partir de ce qu'on a reconnu,
   plutôt que de relayer la chaîne reçue. Renvoie null si rien ne correspond.

   Passer par URL() normalise au passage les chemins tordus (« /valorant/../../x »
   devient « /x », qui ne correspond à aucune route) et fait échouer l'origine
   pour un chemin qui tenterait de sortir de HenrikDev (« //ailleurs.example/… »). */
export function allowedPath(raw) {
  let u;
  try { u = new URL(String(raw || ""), UPSTREAM); } catch (e) { return null; }
  if (u.origin !== UPSTREAM) return null;
  if (!ALLOWED_ROUTES.some((re) => re.test(u.pathname))) return null;

  // Les deux seuls paramètres que le site utilise, bornés. Le reste est jeté :
  // il n'a aucune raison d'être là, et c'est autant de surface en moins.
  const q = new URLSearchParams();
  const size = u.searchParams.get("size");
  if (size && /^[0-9]{1,3}$/.test(size)) q.set("size", size);
  const mode = u.searchParams.get("mode");
  if (mode && /^[a-z]{1,20}$/.test(mode)) q.set("mode", mode);

  const s = q.toString();
  return u.pathname + (s ? `?${s}` : "");
}

const corsHeaders = (origin) => {
  if (origin && ALLOWED_PATTERNS.some((p) => p.test(origin))) {
    return { "access-control-allow-origin": origin, "vary": "origin" };
  }
  return {};
};

const json = (obj, status, origin) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });

export default async (req) => {
  const origin = req.headers.get("origin");
  const url = new URL(req.url);
  const path = url.searchParams.get("path") || "";

  // Securite : liste blanche stricte, et on repart du chemin reconstruit.
  const safe = allowedPath(path);
  if (!safe) return json({ error: "route non autorisee" }, 400, origin);

  const key = process.env.HENRIK_KEY;
  if (!key) return json({ error: "HENRIK_KEY manquante dans les variables Netlify" }, 500, origin);

  try {
    const r = await fetch(UPSTREAM + safe, {
      headers: { Authorization: key },
    });
    const body = await r.text();
    // On relaie les en-têtes de quota : sans eux, le navigateur est aveugle et
    // ne peut ni temporiser correctement, ni expliquer un 429.
    const passthrough = {};
    for (const h of ["retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]) {
      const v = r.headers.get(h);
      if (v) passthrough[h] = v;
    }
    return new Response(body, {
      status: r.status,
      headers: {
        "content-type": r.headers.get("content-type") || "application/json",
        // Une réponse en erreur ne doit surtout pas être mise en cache.
        "cache-control": r.ok ? "public, max-age=60, s-maxage=120" : "no-store",
        ...passthrough,
        ...corsHeaders(origin),
        // Sans ceci, fetch() ne voit pas les en-têtes ci-dessus en cross-origin.
        "access-control-expose-headers": Object.keys(passthrough).join(", ") || "content-type",
      },
    });
  } catch (e) {
    return json({ error: "upstream", detail: String(e) }, 502, origin);
  }
};
