// Endpoint de lecture des blobs accumulés.
// Le navigateur n'accède jamais à Netlify Blobs directement : il passe par ici.
// GET /.netlify/functions/historique?name=X&tag=Y[&kind=matches|rr]
//   kind=matches (défaut) -> { matches, data, count }
//   kind=rr               -> { rr, data, count }   (progression RR long terme)

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
  const kind = url.searchParams.get("kind") === "rr" ? "rr" : "matches";
  if (!name || !tag) return json({ data: [], count: 0, error: "name et tag requis" }, 400);

  const storeName = kind === "rr" ? "cosmo-rr" : "cosmo-history";
  try {
    const store = getStore(storeName);
    const data = (await store.get(blobKey(name, tag), { type: "json" })) || [];
    return json({ [kind]: data, data, count: data.length }, 200);
  } catch (e) {
    // Dégrade proprement : pas encore de données stockées n'est pas une erreur fatale.
    return json({ [kind]: [], data: [], count: 0, error: String((e && e.message) || e) }, 200);
  }
};
