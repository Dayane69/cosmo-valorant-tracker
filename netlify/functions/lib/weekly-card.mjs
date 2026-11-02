// Carte du RÉCAP DE LA SEMAINE : une grande image (1200 px de large, ~4 000 de
// haut) dessinée en SVG, rendue en PNG par le même moteur que les autres récaps.
//
// De haut en bas : en-tête, chiffres clés, montées et descentes de palier,
// courbes de RR (une par joueur), stats, activité jour par jour, trophées, maps.
//
// Couleurs : chaque joueur garde la couleur que lui donne le Dashboard du site
// (même palette, même ordre de roster), validée sur ce fond sombre. Les
// courbes sont en petits multiples — un graphique par joueur, titré à son nom —
// plutôt que 9 lignes emmêlées sur un seul. Les chiffres restent en encre
// claire ; la couleur du joueur n'est portée que par sa pastille et sa courbe.

import { xml, tierFr } from "./recap-card.mjs";
import { tierIdOfElo, tierNameOf, rrInTier } from "./weekly-core.mjs";

const W = 1200, M = 40;
const C = { bg1: "#0b1118", bg2: "#121c27", panel: "#141f2a", panel2: "#18242f", line: "#243240", grid: "#1f2c38",
  txt: "#e9eef4", muted: "#8696a6", dim: "#56636f", win: "#56d8c9", loss: "#ff5d5d", amber: "#f2b234", red: "#ff4655" };
// Palette catégorielle du Dashboard (app.js, DASH_PALETTE), dans l'ordre du roster.
export const PALETTE = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
// Échelle séquentielle (bleu), du plus proche du fond au plus clair : nombre de parties par jour.
const SEQ = ["#104281", "#1c5cab", "#2a78d6", "#5598e7", "#86b6ef"];
const FONT = "Inter, 'Noto Sans JP', sans-serif";

const T = (x, y, s, o = {}) =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${o.size || 18}" font-weight="${o.weight || 400}" fill="${o.fill || C.txt}"${o.anchor ? ` text-anchor="${o.anchor}"` : ""}${o.ls ? ` letter-spacing="${o.ls}"` : ""}>${xml(s)}</text>`;
const cut = (s, n) => { const a = [...String(s || "")]; return a.length > n ? a.slice(0, n - 1).join("") + "…" : a.join(""); };
const signed = (v) => (v == null ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "±") + Math.abs(Math.round(v)));
const f2 = (v) => (v == null ? "—" : (Math.round(v * 100) / 100).toFixed(2));
const pct = (v) => (v == null ? "—" : Math.round(v) + " %");
const rrColor = (v) => (v == null ? C.dim : v > 0 ? C.win : v < 0 ? C.loss : C.muted);
const SHORT = { iron: "Fer", bronze: "Bronze", silver: "Argent", gold: "Or", platinum: "Plat", diamond: "Diam",
  ascendant: "Asc", immortal: "Immo", radiant: "Radiant" };
const tierShort = (name) => { const m = String(name || "").match(/^([a-z]+)\s*(\d)?$/i); return m ? (SHORT[m[1].toLowerCase()] || m[1]) + (m[2] ? " " + m[2] : "") : ""; };
const levelText = (elo) => (elo == null ? "—" : `${tierFr(tierNameOf(tierIdOfElo(elo)))} · ${rrInTier(elo)}`);

function fmtDay(ms, tz, opts) { return new Date(ms).toLocaleDateString("fr-FR", { timeZone: tz, ...opts }); }
const DOW = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

/* week : sortie de buildWeek. opts : { icons: {agentId: dataURI}, tierIcons: {tierId: dataURI}, colors: {key: hex}, tz, site } */
export function weeklySVG(week, opts = {}) {
  const tz = opts.tz || "Europe/Paris", icons = opts.icons || {}, tierIcons = opts.tierIcons || {}, site = opts.site || "cosmo-valo.netlify.app";
  const colorOf = (m) => (opts.colors && opts.colors[m.key]) || C.muted;
  const w = week.window, members = week.members;
  const out = [], defs = [];
  let y = 0;

  const section = (title, sub) => {
    // Titre en capitales espacées, sous-titre sur la ligne d'en dessous :
    // sur la même ligne, la largeur du titre (inconnue sans mesure de texte) les faisait se chevaucher.
    out.push(T(M, y + 30, title, { size: 15, weight: 800, fill: C.amber, ls: 3 }));
    if (sub) out.push(T(M, y + 52, sub, { size: 14, fill: C.dim }));
    y += sub ? 76 : 54;
  };
  const panel = (x, yy, w2, h, fill = C.panel) => out.push(`<rect x="${x}" y="${yy}" width="${w2}" height="${h}" rx="16" fill="${fill}" stroke="${C.line}" stroke-width="1"/>`);
  // Chaque image n'est intégrée qu'UNE fois (dans <defs>, à 100 x 100), puis
  // réutilisée : un portrait d'agent fait 50 à 300 Ko en base64, et chacun
  // revient deux ou trois fois dans la carte.
  const imgDef = {};
  const imageRef = (uri) => {
    if (!imgDef[uri]) { imgDef[uri] = "img" + Object.keys(imgDef).length; defs.push(`<image id="${imgDef[uri]}" href="${uri}" width="100" height="100" preserveAspectRatio="xMidYMid slice"/>`); }
    return imgDef[uri];
  };
  const useImg = (uri, x, yy, size) => `<use href="#${imageRef(uri)}" transform="translate(${x} ${yy}) scale(${size / 100})"/>`;
  const avatar = (m, x, yy, size, i) => {
    defs.push(`<clipPath id="av${i}"><rect x="${x}" y="${yy}" width="${size}" height="${size}" rx="${size / 4.5}"/></clipPath>`);
    if (icons[m.agentId]) out.push(`<g clip-path="url(#av${i})">${useImg(icons[m.agentId], x, yy, size)}</g>`);
    else out.push(`<rect x="${x}" y="${yy}" width="${size}" height="${size}" rx="${size / 4.5}" fill="${C.line}"/>`);
  };
  const tierIcon = (elo, x, yy, size) => {
    const id = elo == null ? null : tierIdOfElo(elo);
    if (id != null && tierIcons[id]) out.push(useImg(tierIcons[id], x, yy, size));
  };

  // ---------------------------------------------------------------- En-tête
  out.push(`<path d="M60 44 H200 L188 92 H48 Z" fill="${C.red}"/>`);
  out.push(T(124, 79, "COSMO", { size: 30, weight: 800, anchor: "middle", fill: "#ffffff", ls: 4 }));
  out.push(T(222, 64, "RÉCAP DE LA SEMAINE", { size: 15, weight: 600, fill: C.amber, ls: 3 }));
  out.push(T(222, 90, `${members.length} joueurs · ${week.games} partie${week.games > 1 ? "s" : ""} classée${week.games > 1 ? "s" : ""}`
    + (week.together ? ` · dont ${week.together} ensemble` : ""), { size: 17, fill: C.muted }));
  const from = fmtDay(w.start, tz, { day: "numeric", month: "long" });
  const to = fmtDay(w.end - 7 * 3600000, tz, { day: "numeric", month: "long" });
  out.push(T(60, 160, `Du ${from} au ${to}`, { size: 44, weight: 800 }));
  out.push(T(60, 196, "Semaine du lundi 6 h au lundi suivant 6 h · parties classées", { size: 18, fill: C.muted }));
  out.push(T(W - 60, 150, `${week.wins}`, { size: 72, weight: 800, anchor: "end", fill: C.win })
    .replace("</text>", `<tspan fill="${C.dim}"> – </tspan><tspan fill="${C.loss}">${week.losses}</tspan></text>`));
  out.push(T(W - 60, 186, week.games ? `${Math.round(week.wins / week.games * 100)} % de victoires` : "", { size: 18, fill: C.muted, anchor: "end" }));
  y = 232;

  // ---------------------------------------------------------- Chiffres clés
  const hours = week.playMs / 3600000;
  const tiles = [
    ["PARTIES", String(week.games), week.together ? `dont ${week.together} ensemble` : "aucune ensemble", C.txt],
    ["TEMPS DE JEU", `${Math.round(hours)} h`, `≈ ${(hours / 7).toFixed(1).replace(".", ",")} h par jour`, C.txt],
    ["RR DE LA SQUAD", signed(week.rrNet), "somme des niveaux gagnés", rrColor(week.rrNet)],
    ["PALIERS", null, "montées · descentes", C.txt],
  ];
  const tw = (W - 2 * M - 3 * 20) / 4;
  tiles.forEach(([lab, val, sub, fill], i) => {
    const x = M + i * (tw + 20);
    panel(x, y, tw, 118);
    out.push(T(x + 22, y + 34, lab, { size: 13, weight: 600, fill: C.dim, ls: 2 }));
    if (val != null) out.push(T(x + 22, y + 78, val, { size: 38, weight: 800, fill }));
    else out.push(T(x + 22, y + 78, `▲ ${week.rankUps}`, { size: 38, weight: 800, fill: C.win })
      .replace("</text>", `<tspan fill="${C.dim}">  </tspan><tspan fill="${C.loss}">▼ ${week.rankDowns}</tspan></text>`));
    out.push(T(x + 22, y + 104, sub, { size: 14, fill: C.muted }));
  });
  y += 148;

  // -------------------------------------------------- Montées et descentes
  section("MONTÉES ET DESCENTES", "niveau de lundi → niveau de fin de semaine");
  const RH = 72;
  out.push(T(466, y + 4, "DÉBUT", { size: 12, weight: 600, fill: C.dim, ls: 2 }));
  out.push(T(741, y + 4, "FIN", { size: 12, weight: 600, fill: C.dim, ls: 2 }));
  out.push(T(1010, y + 4, "RR", { size: 12, weight: 600, fill: C.dim, ls: 2, anchor: "end" }));
  out.push(T(1040, y + 4, "PALIERS", { size: 12, weight: 600, fill: C.dim, ls: 2 }));
  y += 16;   // les lignes commencent sous les en-têtes
  members.forEach((m, i) => {
    const yy = y + i * RH;
    panel(M, yy, W - 2 * M, RH - 8);
    out.push(`<rect x="${M}" y="${yy}" width="6" height="${RH - 8}" rx="3" fill="${colorOf(m)}"/>`);
    avatar(m, M + 20, yy + 10, 44, `r${i}`);
    out.push(T(M + 78, yy + 32, cut(m.name, 18), { size: 21, weight: 800 }));
    out.push(T(M + 78, yy + 52, `${m.n} partie${m.n > 1 ? "s" : ""} · ${m.w}V ${m.l}D`, { size: 14, fill: C.muted }));
    tierIcon(m.startElo, 466, yy + 14, 36);
    out.push(T(510, yy + 38, levelText(m.startElo), { size: 17, fill: C.muted }));
    out.push(T(712, yy + 39, "→", { size: 22, fill: C.dim, anchor: "middle" }));
    tierIcon(m.endElo, 741, yy + 14, 36);
    out.push(T(785, yy + 38, levelText(m.endElo), { size: 17, weight: 600 }));
    out.push(T(1010, yy + 41, signed(m.rr), { size: 24, weight: 800, anchor: "end", fill: rrColor(m.rr) }));
    const ups = m.events.filter((e) => e.up).length, downs = m.events.length - ups;
    if (!m.events.length) out.push(T(1040, yy + 39, "—", { size: 16, fill: C.dim }));
    else {
      // Un seul changement : on le nomme. Plusieurs : le compte (le détail est sur la courbe).
      const label = m.events.length === 1 ? `${ups ? "▲" : "▼"} ${tierShort(tierNameOf(m.events[0].to))}` : null;
      if (label) out.push(T(1040, yy + 39, label, { size: 16, weight: 700, fill: ups ? C.win : C.loss }));
      else out.push(T(1040, yy + 39, `▲${ups}`, { size: 16, weight: 700, fill: C.win })
        .replace("</text>", `<tspan fill="${C.dim}"> </tspan><tspan fill="${C.loss}">▼${downs}</tspan></text>`));
    }
  });
  y += members.length * RH + 24;

  // ---------------------------------------------------------- Courbes de RR
  section("COURBES DE RR", "le niveau de chacun, jour par jour · ▲ ▼ changement de palier");
  const withCurve = members.filter((m) => m.curve && m.curve.points.length > 1);
  const PW = (W - 2 * M - 20) / 2, PH = 250;
  withCurve.forEach((m, i) => {
    const px = M + (i % 2) * (PW + 20), py = y + Math.floor(i / 2) * (PH + 20);
    // Nombre impair : le dernier prend toute la largeur plutôt que laisser un trou.
    const pw = (i === withCurve.length - 1 && withCurve.length % 2) ? W - 2 * M : PW;
    panel(px, py, pw, PH);
    out.push(`<circle cx="${px + 24}" cy="${py + 27}" r="6" fill="${colorOf(m)}"/>`);
    out.push(T(px + 38, py + 33, cut(m.name, 16), { size: 19, weight: 800 }));
    out.push(T(px + pw - 18, py + 34, signed(m.rr), { size: 22, weight: 800, anchor: "end", fill: rrColor(m.rr) }));
    out.push(T(px + 24, py + 56, `${levelText(m.startElo)} → ${levelText(m.endElo)}`, { size: 13, fill: C.muted }));
    // Zone de tracé.
    const x0 = px + 66, x1 = px + pw - 20, y0 = py + 74, y1 = py + PH - 30;
    const pts = m.curve.points;
    const dataLo = Math.min(...pts.map((p) => p.elo)), dataHi = Math.max(...pts.map((p) => p.elo));
    let lo = dataLo, hi = dataHi;
    if (hi - lo < 60) { const c = (hi + lo) / 2; lo = c - 30; hi = c + 30; }
    lo -= 8; hi += 8;
    const X = (t) => x0 + (t - w.start) / (w.end - w.start) * (x1 - x0);
    const Y = (e) => y1 - (e - lo) / (hi - lo) * (y1 - y0);
    // Jours : bandes verticales discrètes et initiales en bas.
    for (let d = 0; d < 7; d++) {
      const a = X(w.days[d]), b = X(w.days[d + 1]);
      if (d) out.push(`<line x1="${a.toFixed(1)}" y1="${y0}" x2="${a.toFixed(1)}" y2="${y1}" stroke="${C.grid}" stroke-width="1"/>`);
      out.push(T(((a + b) / 2).toFixed(1), y1 + 20, DOW[d].charAt(0), { size: 12, fill: C.dim, anchor: "middle" }));
    }
    // Paliers : une ligne pointillée à chaque frontière (multiple de 100), et le
    // nom de chaque palier au MILIEU de sa bande — sur la ligne, on ne savait
    // pas s'il nommait ce qui est au-dessus ou en dessous.
    for (let b = Math.ceil(lo / 100) * 100; b <= hi; b += 100) {
      const yy = Y(b).toFixed(1);
      out.push(`<line x1="${x0}" y1="${yy}" x2="${x1}" y2="${yy}" stroke="${C.line}" stroke-width="1" stroke-dasharray="4 4"/>`);
    }
    // Seulement les paliers où le joueur a été (pas ceux de la marge).
    for (let b = Math.floor(dataLo / 100) * 100; b <= dataHi; b += 100) {
      const top = Y(Math.min(hi, b + 100)), bot = Y(Math.max(lo, b));
      if (bot - top < 14) continue;                       // bande trop fine pour un nom
      out.push(T(x0 - 8, ((top + bot) / 2 + 4).toFixed(1), tierShort(tierNameOf(tierIdOfElo(b))), { size: 11, fill: C.muted, anchor: "end" }));
    }
    // La courbe, puis les points de partie (anneau de la couleur du fond).
    // En marches : le niveau reste le même entre deux parties et change d'un
    // coup à la fin de chacune (une diagonale ferait croire à une pente).
    const d = pts.map((p, k) => k ? `H${X(p.t).toFixed(1)} V${Y(p.elo).toFixed(1)}` : `M${X(p.t).toFixed(1)} ${Y(p.elo).toFixed(1)}`).join(" ");
    out.push(`<path d="${d}" fill="none" stroke="${colorOf(m)}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`);
    pts.forEach((p, k) => { if (k) out.push(`<circle cx="${X(p.t).toFixed(1)}" cy="${Y(p.elo).toFixed(1)}" r="3.5" fill="${colorOf(m)}" stroke="${C.panel}" stroke-width="1.5"/>`); });
    // Changements de palier : ▲ au-dessus, ▼ en dessous ; nommés s'il y en a peu.
    m.events.forEach((e) => {
      const p = pts[e.i], cx = X(p.t), cy = Y(p.elo);
      const tri = e.up ? `M${cx - 6} ${cy - 9} L${cx + 6} ${cy - 9} L${cx} ${cy - 19} Z` : `M${cx - 6} ${cy + 9} L${cx + 6} ${cy + 9} L${cx} ${cy + 19} Z`;
      out.push(`<path d="${tri}" fill="${e.up ? C.win : C.loss}" stroke="${C.panel}" stroke-width="1.5"/>`);
      if (m.events.length <= 2) {
        const ly = e.up ? cy - 24 : cy + 33;
        out.push(T(Math.min(cx, x1 - 30).toFixed(1), ly.toFixed(1), tierShort(tierNameOf(e.to)), { size: 12, weight: 700, fill: e.up ? C.win : C.loss, anchor: "middle" }));
      }
    });
  });
  y += Math.ceil(withCurve.length / 2) * (PH + 20) + 10;

  // ---------------------------------------------------------- Stats
  const usePS = members.filter((m) => m.n).every((m) => m.psN > 0);
  section("STATS DE LA SEMAINE", usePS ? "Perf. = note de performance Riot moyenne (sur 500)" : "");
  const cols = [["PARTIES", 470], ["V–D", 570], ["WIN", 660], ["RR", 760], [usePS ? "PERF." : "ACS", 860], ["K/D", 950], ["HS%", 1040], ["ADR", 1140]];
  cols.forEach(([l, x]) => out.push(T(x, y + 4, l, { size: 12, weight: 600, fill: C.dim, ls: 2, anchor: "end" })));
  y += 16;
  const SH = 54;
  const statRows = members.slice().sort((a, b) => b.n - a.n || (b.ps || 0) - (a.ps || 0));
  statRows.forEach((m, i) => {
    const yy = y + i * SH;
    panel(M, yy, W - 2 * M, SH - 8, i % 2 ? C.panel : C.panel2);
    out.push(`<rect x="${M}" y="${yy}" width="6" height="${SH - 8}" rx="3" fill="${colorOf(m)}"/>`);
    avatar(m, M + 18, yy + 7, 32, `s${i}`);
    out.push(T(M + 62, yy + 30, cut(m.name, 16), { size: 18, weight: 700 }));
    out.push(T(M + 230, yy + 30, cut(m.agent, 12), { size: 14, fill: C.muted }));
    const wr = m.n ? m.w / m.n * 100 : null;
    const vals = [String(m.n), `${m.w}–${m.l}`, pct(wr), signed(m.rr), (usePS ? m.ps : m.acs) == null ? "—" : String(Math.round(usePS ? m.ps : m.acs)), f2(m.kd), m.hs == null ? "—" : Math.round(m.hs) + "%", m.adr == null ? "—" : String(Math.round(m.adr))];
    vals.forEach((v, k) => out.push(T(cols[k][1], yy + 31, v, { size: 18, weight: k === 3 ? 800 : 600, anchor: "end", fill: k === 3 ? rrColor(m.rr) : C.txt })));
  });
  y += statRows.length * SH + 24;

  // ---------------------------------------------------------- Activité
  section("ACTIVITÉ", "parties classées par jour · ±RR du jour");
  const LX = 260, CW = (W - M - LX) / 7, CH = 42;
  for (let d = 0; d < 7; d++) {
    out.push(T(LX + d * CW + CW / 2, y + 4, `${DOW[d]} ${fmtDay(w.days[d] + 6 * 3600000, tz, { day: "numeric" })}`, { size: 13, weight: 600, fill: C.muted, anchor: "middle" }));
  }
  y += 18;
  const shade = (n) => (n <= 0 ? null : n === 1 ? 0 : n <= 3 ? 1 : n <= 5 ? 2 : n <= 8 ? 3 : 4);
  members.forEach((m, i) => {
    const yy = y + i * (CH + 6);
    out.push(`<circle cx="${M + 8}" cy="${yy + CH / 2}" r="6" fill="${colorOf(m)}"/>`);
    out.push(T(M + 24, yy + CH / 2 + 6, cut(m.name, 16), { size: 17, weight: 600 }));
    m.days.forEach((c, d) => {
      const x = LX + d * CW + 2, s = shade(c.n);
      out.push(`<rect x="${x.toFixed(1)}" y="${yy}" width="${(CW - 4).toFixed(1)}" height="${CH}" rx="8" fill="${s == null ? C.panel : SEQ[s]}"${s == null ? ` stroke="${C.line}"` : ""}/>`);
      if (c.n) {
        const ink = s >= 3 ? "#0b1118" : "#ffffff";
        out.push(T((x + (CW - 4) / 2).toFixed(1), yy + CH / 2 + 6, `${c.n}  ${signed(c.rr)}`, { size: 15, weight: 700, fill: ink, anchor: "middle" }));
      }
    });
  });
  y += members.length * (CH + 6) + 8;
  // Légende de l'échelle.
  [["1", 0], ["2–3", 1], ["4–5", 2], ["6–8", 3], ["9+", 4]].forEach(([lab, s], k) => {
    const x = LX + k * 110;
    out.push(`<rect x="${x}" y="${y}" width="22" height="16" rx="4" fill="${SEQ[s]}"/>`);
    out.push(T(x + 30, y + 13, `${lab} partie${lab === "1" ? "" : "s"}`, { size: 13, fill: C.muted }));
  });
  y += 46;

  // ---------------------------------------------------------- Trophées
  section("TROPHÉES DE LA SEMAINE", "");
  const a = week.awards;
  const trophies = [
    ["MVP DE LA SEMAINE", a.mvp && a.mvp.name, a.mvp && `${Math.round(a.mvpMetric === "ps" ? a.mvp.ps : a.mvp.acs)} ${a.mvpMetric === "ps" ? "de perf. moyenne" : "d'ACS moyen"} · ${a.mvp.n} parties`, C.amber],
    ["PLUS GROSSE MONTÉE", a.climber && a.climber.name, a.climber && `${signed(a.climber.rr)} RR · ${levelText(a.climber.endElo)}`, C.win],
    ["SEMAINE DIFFICILE", a.rough && a.rough.name, a.rough && `${signed(a.rough.rr)} RR · ${levelText(a.rough.endElo)}`, C.loss],
    ["MEILLEURE PARTIE", a.bestGame && a.bestGame.m.name, a.bestGame && `${a.bestGame.g.ps != null ? Math.round(a.bestGame.g.ps) + " perf." : Math.round(a.bestGame.g.score / a.bestGame.g.rounds) + " ACS"} · ${a.bestGame.g.agent} · ${a.bestGame.g.k}/${a.bestGame.g.d}/${a.bestGame.g.a}`, C.txt],
    ["PLUS LONGUE SÉRIE", a.streak && a.streak.name, a.streak && `${a.streak.streak} victoires d'affilée`, C.win],
    ["LE PLUS ACTIF", a.grinder && a.grinder.name, a.grinder && `${a.grinder.n} parties classées`, C.txt],
    ["ROI DU HEADSHOT", a.hs && a.hs.name, a.hs && `${Math.round(a.hs.hs)} % de headshots`, C.txt],
    ["MEILLEUR DUO", a.duo && `${a.duo.a} + ${a.duo.b}`, a.duo && `${a.duo.w}V ${a.duo.n - a.duo.w}D ensemble`, C.txt],
  ].filter((t) => t[1]);
  const TW = (W - 2 * M - 3 * 16) / 4, TH = 118;
  trophies.forEach(([lab, who, sub, fill], i) => {
    const x = M + (i % 4) * (TW + 16), yy = y + Math.floor(i / 4) * (TH + 16);
    panel(x, yy, TW, TH);
    out.push(T(x + 18, yy + 30, lab, { size: 12, weight: 700, fill: C.dim, ls: 2 }));
    out.push(T(x + 18, yy + 66, cut(who, 18), { size: 22, weight: 800, fill }));
    out.push(T(x + 18, yy + 94, cut(sub, 34), { size: 13, fill: C.muted }));
  });
  y += Math.ceil(trophies.length / 4) * (TH + 16) + 10;

  // ---------------------------------------------------------- Maps
  const maps = week.maps.slice(0, 8);
  if (maps.length) {
    section("MAPS DE LA SEMAINE", "parties jouées · % de victoires");
    const maxN = Math.max(...maps.map((m) => m.n));
    maps.forEach((mp, i) => {
      const yy = y + i * 40, bx = 200, bw = Math.max(6, (mp.n / maxN) * 760);
      out.push(T(M, yy + 20, mp.name, { size: 17, weight: 600 }));
      out.push(`<rect x="${bx}" y="${yy + 6}" width="${bw.toFixed(1)}" height="20" rx="4" fill="${SEQ[2]}"/>`);
      out.push(T(bx + bw + 10, yy + 22, `${mp.n} partie${mp.n > 1 ? "s" : ""}`, { size: 14, fill: C.muted }));
      const wr = mp.w / mp.n * 100;
      out.push(T(W - M, yy + 22, `${Math.round(wr)} %`, { size: 17, weight: 700, anchor: "end", fill: wr >= 55 ? C.win : wr <= 45 ? C.loss : C.txt }));
    });
    y += maps.length * 40 + 10;
  }

  // ---------------------------------------------------------- Pied
  y += 20;
  out.push(T(M, y, "RR = niveau de fin de semaine moins niveau du lundi (bonus de montée et protection de rang compris).", { size: 13, fill: C.dim }));
  out.push(T(W - M, y, site, { size: 15, fill: C.dim, anchor: "end" }));
  const H = y + 30;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.bg2}"/><stop offset="1" stop-color="${C.bg1}"/></linearGradient>
      <linearGradient id="acc" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${C.red}"/><stop offset="1" stop-color="${C.amber}"/></linearGradient>
      <clipPath id="frame"><rect width="${W}" height="${H}" rx="28"/></clipPath>${defs.join("")}</defs>`,
    `<g clip-path="url(#frame)"><rect width="${W}" height="${H}" fill="url(#bg)"/><rect width="${W}" height="6" fill="url(#acc)"/>`,
    ...out,
    `</g></svg>`,
  ].join("\n");
}

/* Couleurs des joueurs : celles du Dashboard, dans l'ordre du roster ; au-delà
   de 8, gris neutre (le nom en titre de chaque graphique porte l'identité). */
export function memberColors(roster) {
  const out = {};
  (roster || []).forEach((m, i) => { out[`${String(m.name).toLowerCase()}#${String(m.tag).toLowerCase()}`] = PALETTE[i] || C.muted; });
  return out;
}
