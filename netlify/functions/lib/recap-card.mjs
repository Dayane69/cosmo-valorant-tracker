// Carte image du récap Discord : un SVG dessiné à la main (même identité que
// le site), rendu en PNG par resvg (WebAssembly : aucun binaire natif, donc
// rien qui dépende du système des fonctions Netlify).
//
// Les cartes « embed » de Discord sont figées et pauvres : une image, elle,
// porte les portraits d'agents, les couleurs du site et la mise en page qu'on veut.

const W = 1200;
const C = { bg1: "#0b1118", bg2: "#121c27", panel: "#141f2a", line: "#243240", txt: "#e9eef4",
  muted: "#8696a6", dim: "#56636f", win: "#56d8c9", loss: "#ff5d5d", amber: "#f2b234", red: "#ff4655" };
const FONT = "Inter, 'Noto Sans JP', sans-serif";

export const xml = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const cut = (s, n) => { const a = [...String(s || "")]; return a.length > n ? a.slice(0, n - 1).join("") + "…" : a.join(""); };
const signed = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(Math.round(v));
const f2 = (v) => (Math.round(v * 100) / 100).toFixed(2);
const TIER_FR = { iron: "Fer", bronze: "Bronze", silver: "Argent", gold: "Or", platinum: "Platine", diamond: "Diamant",
  ascendant: "Ascendant", immortal: "Immortel", radiant: "Radiant" };
export function tierFr(name) {
  const m = String(name || "").trim().match(/^([a-z]+)\s*(\d)?$/i);
  return m ? (TIER_FR[m[1].toLowerCase()] || m[1]) + (m[2] ? " " + m[2] : "") : String(name || "");
}

function fmtDate(ms, tz) {
  const d = new Date(ms);
  const day = d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: tz });
  return day.charAt(0).toUpperCase() + day.slice(1);
}
const fmtTime = (ms, tz) => new Date(ms).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: tz });
function fmtDur(ms) {
  const m = Math.round(ms / 60000), h = Math.floor(m / 60);
  return h ? `${h} h ${String(m % 60).padStart(2, "0")}` : `${m} min`;
}

const text = (x, y, s, o = {}) =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${o.size || 20}" font-weight="${o.weight || 400}" fill="${o.fill || C.txt}"${o.anchor ? ` text-anchor="${o.anchor}"` : ""}${o.ls ? ` letter-spacing="${o.ls}"` : ""}>${xml(s)}</text>`;

/* recap : sortie de buildRecap. opts : { icons: {agentId: dataURI}, tz, site } */
export function recapSVG(recap, opts = {}) {
  const tz = opts.tz || "Europe/Paris", icons = opts.icons || {}, site = opts.site || "cosmo-valo.netlify.app";
  const rows = recap.members.slice(0, 8);
  const ROW = 96, TOP = 250, FOOT = 170;
  const H = TOP + rows.length * ROW + FOOT;
  const usePS = recap.metric === "ps";
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  out.push(`<defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.bg2}"/><stop offset="1" stop-color="${C.bg1}"/></linearGradient>
    <linearGradient id="acc" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${C.red}"/><stop offset="1" stop-color="${C.amber}"/></linearGradient>
    <clipPath id="frame"><rect width="${W}" height="${H}" rx="28"/></clipPath>
    ${rows.map((m, i) => `<clipPath id="av${i}"><rect x="56" y="${TOP + i * ROW + 14}" width="64" height="64" rx="14"/></clipPath>`).join("")}
  </defs>`);
  out.push(`<g clip-path="url(#frame)"><rect width="${W}" height="${H}" fill="url(#bg)"/><rect width="${W}" height="6" fill="url(#acc)"/>`);

  // --- En-tête : logo, date, horaires ; à droite le bilan.
  out.push(`<path d="M60 44 H200 L188 92 H48 Z" fill="${C.red}"/>`);
  out.push(text(124, 79, "COSMO", { size: 30, weight: 800, anchor: "middle", fill: "#ffffff", ls: 4 }));
  out.push(text(222, 64, "RÉCAP DE SESSION", { size: 15, weight: 600, fill: C.amber, ls: 3 }));
  out.push(text(222, 90, `${recap.members.length} joueurs · ${recap.games} partie${recap.games > 1 ? "s" : ""} classée${recap.games > 1 ? "s" : ""}`, { size: 17, fill: C.muted }));
  out.push(text(60, 156, fmtDate(recap.start, tz), { size: 44, weight: 800 }));
  const maps = recap.maps.length ? " · " + cut(recap.maps.join(", "), 46) : "";
  out.push(text(60, 192, `${fmtTime(recap.start, tz)} → ${fmtTime(recap.end, tz)} · ${fmtDur(recap.end - recap.start)}${maps}`, { size: 20, fill: C.muted }));
  out.push(text(W - 60, 150, `${recap.wins}`, { size: 72, weight: 800, anchor: "end", fill: C.win }).replace("</text>", `<tspan fill="${C.dim}">\u00A0–\u00A0</tspan><tspan fill="${C.loss}">${recap.losses}</tspan></text>`));
  out.push(text(W - 60, 186, recap.games ? `${Math.round(recap.wins / recap.games * 100)} % de victoires` : "", { size: 18, fill: C.muted, anchor: "end" }));

  // --- En-têtes de colonnes.
  const cols = [["PARTIES", 520], ["RR", 650], [usePS ? "PERF." : "ACS", 780], ["K/D", 900], ["HS%", 1010], ["ADR", 1140]];
  cols.forEach(([l, x]) => out.push(text(x, TOP - 14, l, { size: 13, weight: 600, fill: C.dim, anchor: "end", ls: 2 })));
  out.push(text(140, TOP - 14, "JOUEUR", { size: 13, weight: 600, fill: C.dim, ls: 2 }));

  // --- Une ligne par joueur, le meilleur de la session en premier.
  rows.forEach((m, i) => {
    const y = TOP + i * ROW, mvp = i === 0 && rows.length > 1;
    out.push(`<rect x="40" y="${y + 4}" width="${W - 80}" height="${ROW - 10}" rx="16" fill="${C.panel}"${mvp ? ` stroke="${C.amber}" stroke-width="2"` : ` stroke="${C.line}" stroke-width="1"`}/>`);
    out.push(`<rect x="40" y="${y + 4}" width="6" height="${ROW - 10}" rx="3" fill="${xml(m.color || C.muted)}"/>`);
    if (icons[m.agentId]) out.push(`<image href="${icons[m.agentId]}" x="56" y="${y + 14}" width="64" height="64" clip-path="url(#av${i})" preserveAspectRatio="xMidYMid slice"/>`);
    else out.push(`<rect x="56" y="${y + 14}" width="64" height="64" rx="14" fill="${C.line}"/>`);
    out.push(text(140, y + 44, cut(m.name, mvp ? 14 : 18), { size: 25, weight: 800 }));
    const sub = [m.agent, m.tierAfter ? tierFr(m.tierAfter) : ""].filter(Boolean).join(" · ");
    out.push(text(140, y + 70, sub, { size: 16, fill: C.muted }));
    if (mvp) {
      out.push(`<rect x="370" y="${y + 24}" width="66" height="26" rx="13" fill="${C.amber}"/>`);
      out.push(text(403, y + 43, "MVP", { size: 14, weight: 800, anchor: "middle", fill: "#1a1200", ls: 1 }));
    }
    out.push(text(520, y + 46, String(m.n), { size: 26, weight: 800, anchor: "end" }));
    out.push(text(520, y + 70, `${m.w}V ${m.l}D`, { size: 15, fill: C.muted, anchor: "end" }));
    out.push(text(650, y + 56, m.rr == null ? "—" : signed(m.rr), { size: 26, weight: 800, anchor: "end", fill: m.rr == null ? C.dim : (m.rr >= 0 ? C.win : C.loss) }));
    const pv = usePS ? m.ps : m.acs;
    out.push(text(780, y + 56, pv == null ? "—" : String(Math.round(pv)), { size: 26, weight: 800, anchor: "end" }));
    out.push(text(900, y + 56, f2(m.kd), { size: 24, weight: 600, anchor: "end" }));
    out.push(text(1010, y + 56, m.hs == null ? "—" : Math.round(m.hs) + "%", { size: 24, weight: 600, anchor: "end" }));
    out.push(text(1140, y + 56, String(Math.round(m.adr)), { size: 24, weight: 600, anchor: "end" }));
  });

  // --- Pied : les temps forts.
  const fy = TOP + rows.length * ROW + 24;
  const card = (x, w, lab, big, small, fill) => {
    out.push(`<rect x="${x}" y="${fy}" width="${w}" height="110" rx="16" fill="${C.panel}" stroke="${C.line}"/>`);
    out.push(text(x + 22, fy + 32, lab, { size: 13, weight: 600, fill: C.dim, ls: 2 }));
    out.push(text(x + 22, fy + 68, big, { size: 26, weight: 800, fill: fill || C.txt }));
    out.push(text(x + 22, fy + 94, small, { size: 15, fill: C.muted }));
  };
  const b = recap.best;
  if (b) card(40, 540, "MEILLEURE PARTIE", `${cut(b.name, 14)} · ${Math.round(b.v)} ${b.ps ? "perf." : "ACS"}`, cut(`${b.agent} · ${b.map} · ${b.k}/${b.d}/${b.a}`, 46));
  if (recap.topRR) card(600, 270, "PLUS GROS GAIN", `${cut(recap.topRR.name, 11)} ${signed(recap.topRR.rr)}`, "RR sur la session", C.win);
  if (recap.worstRR) card(890, 270, "PLUS GROSSE PERTE", `${cut(recap.worstRR.name, 11)} ${signed(recap.worstRR.rr)}`, "RR sur la session", C.loss);
  out.push(text(W - 44, H - 22, site, { size: 15, fill: C.dim, anchor: "end" }));
  out.push(`</g></svg>`);
  return out.join("\n");
}

/* Les pseudos ne sont pas tous en alphabet latin (« DN4影 ») et Inter n'a pas
   ces glyphes. Plutôt que d'embarquer une police CJK de plusieurs Mo, on
   demande à Google Fonts un sous-ensemble de Noto Sans JP qui ne contient QUE
   les caractères manquants (quelques Ko). Échec réseau : le glyphe manquera,
   la carte part quand même. */
export function missingChars(strings) {
  const set = new Set();
  (strings || []).forEach((s) => [...String(s || "")].forEach((c) => { if (c.codePointAt(0) > 0x24F && !/[–—→·…′″’]/.test(c)) set.add(c); }));
  return [...set].join("");
}
export async function fallbackFont(chars, fetchImpl = fetch) {
  if (!chars) return null;
  try {
    const css = await (await fetchImpl(`https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@700&text=${encodeURIComponent(chars)}`,
      { headers: { "User-Agent": "Mozilla/4.0" } })).text();
    const m = css.match(/url\((https:[^)]+)\)/);
    if (!m) return null;
    const r = await fetchImpl(m[1]);
    return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
  } catch (e) { return null; }
}

/* SVG -> PNG. wasm : octets de index_bg.wasm ; fonts : tableaux d'octets TTF. */
const READY = new WeakMap();   // un initWasm par moteur (le vrai, ou un faux en test)
export async function renderPNG(svg, { wasm, fonts, resvg }) {
  const R = resvg || (await import("@resvg/resvg-wasm"));
  if (!READY.has(R)) READY.set(R, R.initWasm(wasm).catch((e) => { if (!/already/i.test(String(e))) throw e; }));
  await READY.get(R);
  const r = new R.Resvg(svg, {
    fitTo: { mode: "width", value: W },
    font: { fontBuffers: fonts, loadSystemFonts: false, defaultFontFamily: "Inter" },
  });
  return r.render().asPng();
}
