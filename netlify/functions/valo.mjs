// Proxy HenrikDev cote serveur : regle le CORS et garde la cle hors du navigateur.
// La cle se lit UNIQUEMENT dans la variable d'environnement Netlify HENRIK_KEY.
// Aucune cle en dur ici (sinon le scanner de secrets Netlify fait echouer le build).

const ALLOWED_PATTERNS = [
  /^https:\/\/cosmo-valo\.netlify\.app$/,
  /^https:\/\/deploy-preview-\d+--cosmo-valo\.netlify\.app$/,
  /^https:\/\/[a-z0-9-]+--cosmo-valo\.netlify\.app$/,
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
];

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

  // securite : on n'autorise que les endpoints valorant de HenrikDev
  if (!path.startsWith("/valorant/")) return json({ error: "path non autorise" }, 400, origin);

  const key = process.env.HENRIK_KEY;
  if (!key) return json({ error: "HENRIK_KEY manquante dans les variables Netlify" }, 500, origin);

  try {
    const r = await fetch("https://api.henrikdev.xyz" + path, {
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
