// Endpoint de lecture de l'historique accumulé.
// Le navigateur n'accède jamais à Netlify Blobs directement : il passe par ici.
// GET /.netlify/functions/historique?name=X&tag=Y -> { matches: [...], count }

import { getStore } from "@netlify/blobs";
import { blobKey } from "./lib/refresh-core.mjs";

const json = (obj, status) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
  });

export default async (req) => {
  const url = new URL(req.url);
  const name = url.searchParams.get("name") || "";
  const tag = url.searchParams.get("tag") || "";
  if (!name || !tag) return json({ matches: [], count: 0, error: "name et tag requis" }, 400);

  try {
    const store = getStore("cosmo-history");
    const data = (await store.get(blobKey(name, tag), { type: "json" })) || [];
    return json({ matches: data, count: data.length }, 200);
  } catch (e) {
    // Dégrade proprement : pas d'historique stocké pour l'instant n'est pas une erreur fatale.
    return json({ matches: [], count: 0, error: String((e && e.message) || e) }, 200);
  }
};
