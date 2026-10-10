// La règle « façon TradingView » des courbes RR : les bilans (purs) et le geste
// (dans un vrai DOM, avec des évènements pointeur).
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOMS = [];
after(async () => {
  await new Promise((r) => setTimeout(r, 120));
  DOMS.forEach((d) => { try { d.window.close(); } catch (e) {} });
});

// Calculs purs : un simple contexte vm suffit.
const ctx = vm.createContext({ console, URL, URLSearchParams });
vm.runInContext(readFileSync(join(root, "app.js"), "utf8") +
  "\nglobalThis.__r = { rulerDur, rulerProfileStats, rulerDashRows };", ctx);
const R = ctx.__r;

const MIN = 60000, H = 3600000, DAY = 86400000;

test("durées lisibles", () => {
  assert.equal(R.rulerDur(45 * MIN), "45 min");
  assert.equal(R.rulerDur(3 * H + 5 * MIN), "3 h 05");
  assert.equal(R.rulerDur(8 * DAY + 2 * H), "8 j 2 h");
  assert.equal(R.rulerDur(2 * DAY), "2 j");
  assert.equal(R.rulerDur(-90 * MIN), "1 h 30", "le sens du geste ne change pas la durée");
});

test("profil : bilan entre deux parties, dans l'ordre chronologique quel que soit le geste", () => {
  const T0 = Date.parse("2026-09-12T21:00:00Z");
  const changes = [null, 20, -15, 18, 0, -10];
  const series = changes.map((c, i) => ({ change: c, ts: T0 + i * DAY }));
  const pts = [1200, 1220, 1205, 1223, 1223, 1213];
  const s = R.rulerProfileStats(series, pts, 5, 1);        // glissé de droite à gauche
  assert.equal(s.from, 1); assert.equal(s.to, 5);
  assert.equal(s.games, 4, "les parties APRÈS le point de départ, jusqu'à l'arrivée incluse");
  assert.equal(s.up, 1); assert.equal(s.down, 2, "−15 et −10 ; le 0 ne compte ni en haut ni en bas");
  assert.equal(s.dv, -7, "de 1220 à 1213");
  assert.equal(s.tB - s.tA, 4 * DAY);
});

test("dashboard : l'écart de chaque membre entre deux instants", () => {
  const t = (d) => d * DAY;
  const curves = {
    a: [{ t: t(1), elo: 1000, change: 10 }, { t: t(5), elo: 1040, change: 40 }, { t: t(8), elo: 1030, change: -10 }],
    // b n'a pas de point avant la fenêtre : on part du niveau d'AVANT sa 1re partie dedans.
    b: [{ t: t(4), elo: 1500, change: 20 }, { t: t(6), elo: 1530, change: 30 }],
    c: [{ t: t(1), elo: 900, change: 5 }],                           // n'a pas joué dans la fenêtre
    d: [{ t: t(5), elo: 700, change: null }, { t: t(6), elo: 690, change: -10 }],   // ±RR inconnu au départ
  };
  const rows = R.rulerDashRows(curves, ["a", "b", "c", "d"], t(7), t(3));   // fenêtre donnée à l'envers
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(by.a.d, 40, "1000 au début de la fenêtre, 1040 à la fin");
  assert.equal(by.a.games, 1);
  assert.equal(by.b.d, 50, "de 1480 (avant sa partie à +20) à 1530");
  assert.equal(by.b.approx, false);
  assert.equal(by.c, undefined, "pas joué entre les deux instants : pas de ligne");
  assert.equal(by.d.d, -10);
  assert.equal(by.d.approx, true, "on le dit quand le point de départ est approximatif");
  assert.deepEqual(rows.map((r) => r.key), ["b", "a", "d"], "du plus gros gain à la plus grosse perte");
});

/* ------------------------------------------------------------ le geste */

async function boot() {
  // La vraie page (l'app démarre dessus sans erreur), plus une courbe de test.
  const dom = new JSDOM(readFileSync(join(root, "index.html"), "utf8"),
    { runScripts: "outside-only", url: "https://cosmo-valo.netlify.app/" });
  DOMS.push(dom);
  const c = dom.getInternalVMContext();
  dom.window.scrollTo = () => {};
  c.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  dom.window.document.body.insertAdjacentHTML("beforeend",
    `<div id="rulwrap"><svg id="rulsvg" width="400" height="200"></svg></div>`);
  vm.runInContext(readFileSync(join(root, "app.js"), "utf8") +
    "\nglobalThis.__g = { makeRuler, RULER_ON };", c);
  await new Promise((r) => setTimeout(r, 0));
  const doc = dom.window.document, svg = doc.getElementById("rulsvg"), wrap = doc.getElementById("rulwrap");
  // Adaptateur minimal : x = numéro de partie × 40 px, y = 200 − valeur.
  const ruler = c.__g.makeRuler({ id: "t", svg, wrap,
    toView: (e) => ({ x: e.clientX, y: e.clientY }), toPx: (x, y) => ({ left: x, top: y }),
    plot: { y0: 0, y1: 200 }, snap: (x) => ({ k: Math.round(x / 40), x: Math.round(x / 40) * 40 }),
    V: (y) => 200 - y, Y: (v) => 200 - v, magnet: null,
    label: (a, b) => `<b class="lab">${a.k}->${b.k}</b>` });
  const fire = (type, x, y, extra = {}) => {
    const ev = new dom.window.MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, shiftKey: !!extra.shift });
    if (extra.touch) Object.defineProperty(ev, "pointerType", { value: "touch" });
    svg.dispatchEvent(ev);
  };
  return { doc, svg, wrap, ruler, fire, ON: c.__g.RULER_ON };
}

test("sans le bouton ni Maj, un clic sur la courbe ne mesure rien", async () => {
  const { svg, ruler, fire } = await boot();
  fire("pointerdown", 40, 100); fire("pointermove", 200, 50); fire("pointerup", 200, 50);
  assert.equal(svg.querySelector(".rul"), null);
  assert.equal(ruler.busy(), false);
});

test("bouton enfoncé : glisser mesure d'un point à l'autre, calé sur les parties", async () => {
  const { svg, wrap, ruler, fire, ON } = await boot();
  ON.t = true;
  fire("pointerdown", 43, 100); fire("pointermove", 205, 40); fire("pointerup", 205, 40);
  const st = ruler.state();
  assert.equal(st.a.k, 1); assert.equal(st.b.k, 5, "calé sur la partie la plus proche");
  assert.equal(st.b.v, 160);
  assert.ok(svg.querySelector(".rul.up rect"), "boîte tracée, teintée « en hausse »");
  assert.match(wrap.querySelector(".rul-box").innerHTML, /1-&gt;5|1->5/);
  // Après le relâchement, la mesure est figée.
  fire("pointermove", 360, 190);
  assert.equal(ruler.state().b.k, 5);
});

test("deux clics : le premier pose le départ, le second l'arrivée", async () => {
  const { ruler, fire, ON } = await boot();
  ON.t = true;
  fire("pointerdown", 80, 100); fire("pointerup", 80, 100);
  assert.equal(ruler.state().armed, true, "en attente du second point");
  fire("pointermove", 240, 150);
  assert.equal(ruler.state().b.k, 6, "l'arrivée suit la souris");
  fire("pointerdown", 160, 150);
  assert.equal(ruler.state().b.k, 4);
  assert.equal(ruler.state().armed, false);
  fire("pointermove", 360, 10);
  assert.equal(ruler.state().b.k, 4, "le second clic fige la mesure");
});

test("vers la gauche et vers le bas : la teinte suit l'ordre CHRONOLOGIQUE", async () => {
  const { svg, fire, ON } = await boot();
  ON.t = true;
  // Départ récent et haut (partie 6, valeur 150), arrivée ancienne et basse (partie 1, 50) :
  // du plus ancien au plus récent, ça MONTE.
  fire("pointerdown", 240, 50); fire("pointermove", 40, 150); fire("pointerup", 40, 150);
  assert.ok(svg.querySelector(".rul.up"), "de 50 à 150 dans le temps : en hausse");
});

test("Maj + glisser marche à la souris sans le bouton, pas au doigt", async () => {
  const a = await boot();
  a.fire("pointerdown", 40, 100, { shift: true }); a.fire("pointermove", 200, 100); a.fire("pointerup", 200, 100);
  assert.equal(a.ruler.busy(), true);
  const b = await boot();
  b.fire("pointerdown", 40, 100, { shift: true, touch: true });
  assert.equal(b.ruler.busy(), false, "au doigt, glisser doit pouvoir faire défiler la page");
});

test("✕ efface la mesure", async () => {
  const { svg, wrap, ruler, fire, ON } = await boot();
  ON.t = true;
  fire("pointerdown", 40, 100); fire("pointermove", 200, 60); fire("pointerup", 200, 60);
  wrap.querySelector(".rul-x").click();
  assert.equal(ruler.busy(), false);
  assert.equal(svg.querySelector(".rul"), null);
  assert.equal(wrap.querySelector(".rul-box"), null);
});
