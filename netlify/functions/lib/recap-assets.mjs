// Fichiers dont le rendu a besoin à l'exécution : les polices (included_files)
// et le moteur resvg en WebAssembly (external_node_modules). On essaie
// plusieurs emplacements : le chemin exact dépend de la façon dont Netlify
// empaquette la fonction, et ne pas trouver un fichier doit dire lequel.
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const FONT_DIRS = [join(here, "..", "assets", "fonts"), join(here, "assets", "fonts"),
  join(process.cwd(), "netlify", "functions", "assets", "fonts")];

export function readFont(file) {
  for (const d of FONT_DIRS) { const p = join(d, file); if (existsSync(p)) return new Uint8Array(readFileSync(p)); }
  throw new Error("police introuvable : " + file);
}
export function readWasm() {
  // Le fichier n'est dans le paquet de la fonction que grâce à included_files
  // (netlify.toml) : rien ne l'importe, l'empaqueteur ne le trouverait pas seul.
  const tries = [];
  try { tries.push(createRequire(import.meta.url).resolve("@resvg/resvg-wasm/index_bg.wasm")); } catch (e) { /* suite */ }
  tries.push(join(process.cwd(), "node_modules", "@resvg", "resvg-wasm", "index_bg.wasm"));
  for (const p of tries) if (p && existsSync(p)) return readFileSync(p);
  throw new Error("moteur de rendu introuvable (essayé : " + tries.join(", ") + ")");
}
