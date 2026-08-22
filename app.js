/* ===================== CONFIG ===================== */
const PROXY = p => `/.netlify/functions/valo?path=${encodeURIComponent(p)}`;
const MEDIA = "https://media.valorant-api.com/agents";

// Roster chargé depuis roster.json (source de vérité unique, partagée avec la
// fonction planifiée refresh-matches). Rempli au démarrage par loadRoster().
let ROSTER = [];
let DEFAULT_REGION = "eu";

const REACTIONS = {
  S:{emoji:"🔥",cap:"Insane",gif:""},
  A:{emoji:"😎",cap:"Propre",gif:""},
  B:{emoji:"👍",cap:"Correct",gif:""},
  C:{emoji:"😐",cap:"Bof",gif:""},
  D:{emoji:"🥴",cap:"Aïe",gif:""},
  F:{emoji:"💩",cap:"La honte",gif:""},
};

// allMatches = historique combiné complet (matches v4 frais + blob accumulé),
// matches = tranche actuellement affichée (pagination côté client).
let STATE = { puuid:null, allMatches:[], matches:[], name:"", tag:"" };
const TRIB = { matches: [], active: 0, n: 10 };
const LB = { n: 10 };
const VS = { a: 0, b: 1 };
let CURRENT_MODE = 'all';
const MATCH_DETAILS = {};                               // cache id -> match complet (détail chargé à la demande)
const DETAIL_PENDING = {};                              // id -> true pendant le chargement du détail
let SELECTED_IDX = -1;                                  // ligne d'historique actuellement ouverte
let RR_FULL = [];                                       // série RR complète (blob + live) du profil courant
let RR_PERIOD = 50;                                     // fenêtre affichée du graphe RR (0 = tout)
let RR_SEASON = 'all';                                  // filtre saison/acte du graphe RR ('all' = toutes)
let STATS_SEASON = 'all';                               // filtre saison/acte des stats agent/map
let COMPARE_MEMBER = null;                              // second joueur comparé sur le graphe RR
let COMPARE_SERIES = null;                              // sa série RR (blob + live)
const FRESH_SIZE = 20;                                  // matches v4 récupérés pour la fraîcheur
let PROFILE_SHOWN = FRESH_SIZE;                         // nb de parties affichées (pagination locale)
const PROFILE_SIZE_STEP = 15;                          // pas du bouton "charger plus"
let MAPS = null;                                        // cache nom de map -> image splash
let AGENTS = null;                                      // cache nom d'agent -> icône (tête)
let TIERS = null;                                       // cache nom de palier -> icône de rang
let TIER_BY_NUM = null;                                 // cache numéro de palier -> {name,color,icon} (lignes de rang du graphe)
let ELO_TIER_OFFSET = 3;                                // numéro de palier = floor(elo/100) + offset (Iron 1 = palier 3, elo 0)
const ANIM_BUSY = { Trib: false, Prof: false };

const $ = id => document.getElementById(id);
const enc = s => encodeURIComponent(s);
const REGION = () => $('region').value;
const num = (v,f=0)=>(v===undefined||v===null||isNaN(v))?f:Number(v);
const clamp = (x, a=0, b=100) => Math.max(a, Math.min(b, x));
const ESC_MAP = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC_MAP[c]);

/* ===================== INDICE COSMO /100 (v2) =====================
   Principes :
   - Chaque critère est calibré pour qu'une valeur MOYENNE en ranked vaille ~50
     (la v1 mettait la moyenne à ~35 : tout le monde était noté D/C).
   - Les assists comptent (KDA), pas seulement le K/D.
   - Le HS% pèse peu et est atténué quand il y a peu de tirs : les agents
     utilitaires (Breach, Brimstone…) ne sont plus punis.
   - On tient compte du contexte : classement dans le lobby, victoire/défaite,
     et surtout des parties écourtées (forfait) où l'échantillon est trop petit.
*/
// Deux jeux de poids : avec KAST (quand les données de round sont dispo) et
// sans (parties compactes du blob) — le KAST englobe la survie, d'où le
// remplacement du critère "survie" plutôt qu'un cumul des deux.
const IDX_W_KAST = { acs:0.26, kast:0.20, kda:0.16, dd:0.16, adr:0.14, hs:0.08 };
const IDX_W     = { acs:0.30, kda:0.20, dd:0.18, adr:0.14, surv:0.10, hs:0.08 };
const LOBBY_W   = 0.20;  // part du classement dans le lobby dans la note finale
const WIN_BONUS = 2.5;   // petit bonus/malus victoire-défaite
const FULL_ROUNDS = 13;  // en dessous : partie écourtée -> on relativise

// Mise à l'échelle finale. En interne 50 = joueur médian (percentile strict), ce
// qui est juste mais sévère : la moitié des parties passeraient sous 50. On
// applique une courbe qui remonte le milieu et le haut SANS jamais changer
// l'ordre des parties (fonction strictement croissante), pour être comparable
// aux autres trackers. Les paliers S/A/B/C/D/F sont décalés d'autant, donc les
// libellés gardent exactement le même sens qu'avant.
const SCORE_GAMMA = 0.65;
const curveScore = s => 100 * Math.pow(clamp(s) / 100, SCORE_GAMMA);

// Les 6 critères, chacun ramené sur 0-100 (50 = moyen en ranked).
function perfParts(o){
  const rounds = num(o.rounds) || 24;
  const kda    = (num(o.k) + 0.5*num(o.a)) / Math.max(num(o.d), 1);
  const dpr    = num(o.d) / Math.max(rounds, 1);          // morts par round
  const shots  = num(o.shots);
  let hsN = clamp(50 + (num(o.hs) - 20) * 2.2);           // 20% HS ≈ moyen
  // Peu de tirs = information peu fiable -> on ramène vers la moyenne.
  if(shots > 0 && shots < 30) hsN = 50 + (hsN - 50) * (shots / 30);

  // Le KAST n'est calculable que si la partie fournit le détail des rounds.
  const hasKast = o.kast != null && !isNaN(o.kast);
  const W = hasKast ? IDX_W_KAST : IDX_W;

  const parts = [
    { key:'acs',  label:'ACS',      raw:num(o.acs), fmt:v=>String(Math.round(v)),
      n:clamp((num(o.acs) - 60) / 2.8),   w:W.acs,
      hint:'impact par round · 200 ≈ moyen' },
  ];
  if(hasKast) parts.push(
    { key:'kast', label:'KAST',     raw:num(o.kast), fmt:v=>Math.round(v)+'%',
      n:clamp(50 + (num(o.kast) - 70) * 2.5), w:W.kast,
      hint:'rounds avec Kill, Assist, Survie ou Trade · 70% ≈ moyen' });
  parts.push(
    { key:'kda',  label:'KDA',      raw:kda,        fmt:v=>v.toFixed(2),
      n:clamp((kda - 0.35) * 77),         w:W.kda,
      hint:'(kills + assists/2) ÷ morts · 1.00 ≈ moyen' },
    { key:'dd',   label:'Δ Dégâts', raw:num(o.dd),  fmt:v=>(v>=0?'+':'')+Math.round(v),
      n:clamp(50 + num(o.dd) * 0.6),      w:W.dd,
      hint:'dégâts infligés − subis, par round · 0 ≈ moyen' },
    { key:'adr',  label:'ADR',      raw:num(o.adr), fmt:v=>String(Math.round(v)),
      n:clamp((num(o.adr) - 40) / 2),     w:W.adr,
      hint:'dégâts par round · 140 ≈ moyen' });
  if(!hasKast) parts.push(
    { key:'surv', label:'Survie',   raw:dpr,        fmt:v=>v.toFixed(2)+' morts/round',
      n:clamp(50 + (0.65 - dpr) * 130),   w:W.surv,
      hint:'0.65 mort par round ≈ moyen · (remplacé par le KAST si dispo)' });
  parts.push(
    { key:'hs',   label:'HS%',      raw:num(o.hs),  fmt:v=>Math.round(v)+'%',
      n:hsN,                               w:W.hs,
      hint:'20% ≈ moyen · atténué si peu de tirs' });
  return parts;
}

/* KAST : % de rounds où le joueur a eu un Kill, un Assist, a Survécu, ou a été
   Tradé (son tueur abattu par un coéquipier dans les 3 s).
   Calculé depuis m.kills[] — déjà présent dans la réponse, donc aucun appel en plus. */
const TRADE_MS = 3000;
function kastByPuuid(m, rounds){
  const kills = Array.isArray(m && m.kills) ? m.kills : [];
  const players = Array.isArray(m && m.players) ? m.players : [];
  if(!kills.length || !rounds || !players.length) return null;

  const byRound = new Map();
  kills.forEach(k=>{ const r=num(k.round); if(!byRound.has(r)) byRound.set(r,[]); byRound.get(r).push(k); });

  const puuids = players.map(p=>p.puuid).filter(Boolean);
  if(!puuids.length) return null;
  const hit = {}; puuids.forEach(p=>{ hit[p]=0; });

  byRound.forEach(ks=>{
    const did=new Set(), died=new Map();
    ks.forEach(k=>{
      const kp=k.killer&&k.killer.puuid, v=k.victim||{};
      if(kp) did.add(kp);
      (k.assistants||[]).forEach(a=>{ if(a&&a.puuid) did.add(a.puuid); });
      if(v.puuid) died.set(v.puuid, {t:num(k.time_in_round_in_ms), killer:kp, team:v.team});
    });
    puuids.forEach(pu=>{
      if(did.has(pu)) { hit[pu]++; return; }          // Kill ou Assist
      const dv=died.get(pu);
      if(!dv){ hit[pu]++; return; }                    // a Survécu
      const traded = ks.some(k2=>{                     // a été Tradé
        const t=num(k2.time_in_round_in_ms);
        return k2.victim && k2.victim.puuid===dv.killer && t>dv.t && (t-dv.t)<=TRADE_MS
            && k2.killer && k2.killer.team===dv.team;
      });
      if(traded) hit[pu]++;
    });
  });

  // Les rounds sans aucun kill : tout le monde a survécu.
  const empty = Math.max(0, rounds - byRound.size);
  const out = {};
  puuids.forEach(pu=>{ out[pu]=Math.round((hit[pu]+empty)/rounds*100); });
  return out;
}

// Note finale + tout le détail du calcul (pour la page d'explication).
// ctx : { rounds, forfeit, win, rel, rank, lobbyN }
function perfDetail(o, ctx){
  ctx = ctx || {};
  const parts = perfParts(o);
  const base  = parts.reduce((s,p) => s + p.n * p.w, 0);
  const adj = [];
  let score = base;

  // 1) Classement dans le lobby : récompense le fait d'avoir porté la partie.
  if(ctx.rel != null){
    const before = score;
    score = base * (1 - LOBBY_W) + ctx.rel * LOBBY_W;
    adj.push({ label:`Classement dans le lobby${ctx.rank?` (${ordinalFr(ctx.rank)}${ctx.lobbyN?'/'+ctx.lobbyN:''})`:''}`,
      delta: score - before, note:`compte pour ${Math.round(LOBBY_W*100)}% de la note` });
  }
  // 2) Victoire / défaite.
  if(ctx.win === true || ctx.win === false){
    const d = ctx.win ? WIN_BONUS : -WIN_BONUS;
    score += d;
    adj.push({ label: ctx.win ? 'Victoire' : 'Défaite', delta:d });
  }
  // 3) Partie écourtée (forfait) : trop peu de rounds pour juger -> on rapproche
  //    la note de la moyenne au lieu de la laisser s'envoler ou s'effondrer.
  const rounds = num(ctx.rounds);
  if(rounds > 0 && rounds < FULL_ROUNDS){
    const before = score;
    score = 50 + (score - 50) * (0.55 + 0.45 * (rounds / FULL_ROUNDS));
    adj.push({ label: ctx.forfeit ? `Forfait adverse (${rounds} rounds)` : `Partie courte (${rounds} rounds)`,
      delta: score - before, note:'échantillon trop petit : la note est rapprochée de la moyenne' });
  }

  // 4) Mise à l'échelle COSMO (dernière étape, purement de présentation).
  const brut = score;
  score = curveScore(score);
  adj.push({ label:'Mise à l\'échelle COSMO', delta: score - brut,
    note:`échelle interne ${Math.round(brut)}/100 (50 = joueur médian) recalée pour être comparable aux autres trackers` });

  return { score: Math.round(clamp(score)), raw: brut, base, parts, adj,
           rounds, forfeit:!!ctx.forfeit, win:ctx.win, rank:ctx.rank, lobbyN:ctx.lobbyN };
}
function perfScore(o, ctx){ return perfDetail(o, ctx).score; }
// Seuils exprimés en échelle INTERNE (avant courbe) puis convertis, pour que
// "Moyen", "Solide"… gardent exactement la même exigence qu'avant la mise à
// l'échelle. En pratique : S≥92, A≥82, B≥72, C≥60, D≥48.
const TIERS_DEF = [
  { min:88, t:"S", c:"#56d8c9", label:"Smurf détecté" },
  { min:74, t:"A", c:"#7ee07a", label:"Énorme" },
  { min:60, t:"B", c:"#cfe04f", label:"Solide" },
  { min:46, t:"C", c:"#f2b234", label:"Moyen" },
  { min:32, t:"D", c:"#f2803a", label:"Bof" },
  { min:-1, t:"F", c:"#ff5d5d", label:"Caca qui pue" },
].map(x => Object.assign({}, x, { cut: Math.round(curveScore(x.min)) }));

function tierOf(s){
  return TIERS_DEF.find(x => s >= x.cut) || TIERS_DEF[TIERS_DEF.length-1];
}
function flair(kd){ return kd>=1.4?"fire":(kd<=0.65?"stink":""); }
function flairHTML(f){
  if(f==="fire") return '<span class="flame" style="left:14%"></span><span class="flame" style="left:42%;animation-delay:.18s"></span><span class="flame" style="left:70%;animation-delay:.34s"></span>';
  if(f==="stink") return '<span class="squig" style="left:18%">〰️</span><span class="squig" style="left:48%;animation-delay:.7s">💩</span><span class="squig" style="left:76%;animation-delay:1.2s">〰️</span>';
  return "";
}
function sc(n){ n=clamp(n);
  const st=[[255,93,93],[242,128,58],[242,178,52],[126,224,122],[86,216,201]];
  const x=n/100*(st.length-1), i=Math.min(Math.floor(x),st.length-2), f=x-i, a=st[i], b=st[i+1];
  return `rgb(${Math.round(a[0]+(b[0]-a[0])*f)},${Math.round(a[1]+(b[1]-a[1])*f)},${Math.round(a[2]+(b[2]-a[2])*f)})`;
}

/* ===================== LOGIQUE MATCHES ===================== */
async function api(path){
  const r=await fetch(PROXY(path));
  if(!r.ok){ const e=new Error('http '+r.status); e.status=r.status; throw e; }
  return r.json();
}

// Identifiant / horodatage stables d'un match brut, quel que soit le format
// (matches v3/v4 -> metadata ; stored-matches v1 -> meta).
function matchID(m){ const md=(m&&(m.metadata||m.meta))||{}; return md.match_id||md.matchid||md.matchId||md.id||null; }
// Horodatage (ms) tolérant : ISO (started_at / game_start_iso) ou epoch (game_start,
// en secondes OU millisecondes selon la version de l'API).
function tsMs(md){
  if(!md) return 0;
  const iso=md.started_at||md.game_start_iso;
  if(iso){ const t=new Date(iso).getTime(); if(!isNaN(t)) return t; }
  if(typeof md.game_start==='number') return md.game_start<1e12 ? md.game_start*1000 : md.game_start;
  return 0;
}
function matchTime(m){ return tsMs((m&&(m.metadata||m.meta))||{}); }
function msToIso(ms){ return ms ? new Date(ms).toISOString() : ''; }

// Durée d'une partie, en ms. Les versions de l'API divergent :
// v4 -> game_length_in_ms, stored v1 -> game_length (parfois en SECONDES).
// Une partie ne dépasse jamais ~1h : au-dessus de 1e5 la valeur est en ms.
function durMs(md){
  if(!md) return 0;
  const a=md.game_length_in_ms;
  if(typeof a==='number' && a>0) return a;
  const g=md.game_length;
  if(typeof g==='number' && g>0) return g<1e5 ? g*1000 : g;
  return 0;
}
// Repli quand l'API ne donne pas la durée : ~100 s par round joué.
const MS_PER_ROUND = 100000;
function matchDuration(M){
  if(!M) return 0;
  if(M.durMs>0) return M.durMs;
  return Math.max(1, num(M.rounds, 24)) * MS_PER_ROUND;
}

// Fusionne plusieurs listes de matchs bruts en dédoublonnant par matchid.
// Les listes passées en premier sont prioritaires (les données fraîches v4
// l'emportent sur la version stockée). Tri du plus récent au plus ancien.
function combineMatches(...lists){
  const byId=new Map(); const extra=[];
  lists.forEach(list=>(list||[]).forEach(m=>{
    const id=matchID(m);
    if(id){ if(!byId.has(id)) byId.set(id,m); }
    else extra.push(m);
  }));
  return [...byId.values(), ...extra].sort((a,b)=>matchTime(b)-matchTime(a));
}

// Récupère l'historique accumulé côté serveur (blob via la fonction historique).
// Repli silencieux sur [] : le blob peut être vide tant que le cron n'a pas tourné.
async function fetchHistorique(name, tag){
  try{
    const r=await fetch(`/.netlify/functions/historique?name=${enc(name)}&tag=${enc(tag)}`);
    if(!r.ok) return [];
    const d=await r.json();
    return Array.isArray(d) ? d : (d.matches||d.data||[]);
  }catch(e){ return []; }
}

// Récupère l'historique RR accumulé (progression long terme) depuis le blob cosmo-rr.
async function fetchRRHistory(name, tag){
  try{
    const r=await fetch(`/.netlify/functions/historique?name=${enc(name)}&tag=${enc(tag)}&kind=rr`);
    if(!r.ok) return [];
    const d=await r.json();
    return Array.isArray(d) ? d : (d.rr||d.data||[]);
  }catch(e){ return []; }
}

// Normalise une entrée d'historique MMR (live) au même format que le blob RR.
function rrTs(e){
  if(!e) return 0;
  if(e.ts!=null && !isNaN(e.ts)) return Number(e.ts);
  const iso=e.date||e.date_raw;
  if(iso){ const t=new Date(iso).getTime(); if(!isNaN(t)) return t; }
  if(typeof e.date_raw==='number') return e.date_raw<1e12 ? e.date_raw*1000 : e.date_raw;
  return 0;
}
function normRRclient(h){
  const id=h.match_id||h.matchid||h.matchId||h.id||null;
  const elo=(h.elo!=null && !isNaN(h.elo))?Number(h.elo):null;
  const rr=h.ranking_in_tier!=null?Number(h.ranking_in_tier):(h.rr!=null?Number(h.rr):null);
  const change=h.last_change!=null?Number(h.last_change):(h.mmr_change_to_last_game!=null?Number(h.mmr_change_to_last_game):null);
  const tier=h.tier?{id:(h.tier.id!=null?h.tier.id:null),name:h.tier.name||''}:(h.currenttier!=null?{id:h.currenttier,name:h.currenttierpatched||''}:null);
  const season=(h.season&&(h.season.short||h.season.id))||h.season_id||null;
  const e={id,elo,rr,change,tier,season,map:(h.map&&h.map.name)||(h.map||''),date:h.date||h.date_raw||null};
  e.ts=rrTs({...e,date_raw:h.date_raw});
  return e;
}
// Fusionne la série RR accumulée (blob) et le live, dédoublonné par match_id/date, tri chronologique.
function mergeRRclient(...lists){
  const byKey=new Map();
  lists.forEach(list=>(list||[]).forEach(e=>{ const k=e&&(e.id||(e.ts?'t:'+e.ts:null)); if(k && !byKey.has(k)) byKey.set(k,e); }));
  return [...byKey.values()].sort((a,b)=>rrTs(a)-rrTs(b));
}

// Sauvegarde l'historique de CE joueur dans le blob, à l'ouverture de son profil.
// Réparti les écritures (1 joueur à la fois) : les membres jamais visités par le
// refresh massif (coupé par le rate limit) finissent par être enregistrés ici.
// Fire-and-forget : un échec (429, etc.) ne doit pas perturber l'affichage.
function saveHistorique(name, tag, region){
  // trigger non passé : matches v4 vient d'être appelé par loadProfile, inutile de re-déclencher.
  try{
    fetch(`/.netlify/functions/save-history?name=${enc(name)}&tag=${enc(tag)}&region=${enc(region)}`, { method:'POST' }).catch(()=>{});
  }catch(e){}
}

// Sauvegarde manuelle de TOUTE la squad, pilotée par le navigateur : un joueur à
// la fois, espacé pour respecter le rate limit HenrikDev, avec retry sur 429.
// Chaque appel = une fonction Netlify courte (pas de limite cumulée de 10s), donc
// tous les membres sont sauvegardés quel que soit leur nombre.
const sleep = ms => new Promise(r => setTimeout(r, ms));
let SAVE_SPACING_MS = 1800;   // délai entre deux joueurs
let SAVE_RUNNING = false;

async function saveOneWithRetry(m, region, tries=3){
  for(let a=0; a<tries; a++){
    try{
      const r=await fetch(`/.netlify/functions/save-history?name=${enc(m.name)}&tag=${enc(m.tag)}&region=${enc(region)}&trigger=1`, { method:'POST' });
      if(r.ok) return true;
      if(r.status===429){ await sleep(2500*(a+1)); continue; } // rate limit -> on temporise et on réessaie
      return false;
    }catch(e){ await sleep(1200); }
  }
  return false;
}

async function saveAllHistory(){
  if(SAVE_RUNNING) return;
  SAVE_RUNNING=true;
  const out=$('refreshStatus'), btn=$('btnRefreshNow');
  if(btn) btn.disabled=true;
  const region=REGION(), members=ROSTER;
  let ok=0, fail=0;
  for(let i=0; i<members.length; i++){
    const m=members[i];
    if(out) out.textContent=`Sauvegarde ${i+1}/${members.length} — ${m.name}…`;
    (await saveOneWithRetry(m, region)) ? ok++ : fail++;
    if(i<members.length-1) await sleep(SAVE_SPACING_MS);   // espace pour le rate limit
  }
  if(out) out.textContent=`Terminé ✓ — ${ok}/${members.length} sauvegardé(s)`+(fail?` · ${fail} échec(s), réessaie dans ~1 min`:'')+'.';
  if(btn) btn.disabled=false;
  SAVE_RUNNING=false;
  return { ok, fail };
}
// Caches valorant-api : on ne mémorise QUE en cas de succès, pour qu'un échec
// transitoire (réseau, blip) ne désactive pas définitivement les icônes.

// Maps : nom -> image splash.
async function ensureMaps(){
  if(MAPS) return MAPS;
  try{
    const r = await fetch('https://valorant-api.com/v1/maps');
    if(r.ok){
      const d = await r.json(), map = {};
      (d.data||[]).forEach(mp=>{ if(mp.displayName && mp.splash) map[mp.displayName.toLowerCase()] = mp.splash; });
      MAPS = map;
    }
  }catch(e){ /* pas de fond de carte, tant pis */ }
  return MAPS || {};
}
// Agents : nom -> icône (tête). Repli quand la partie ne fournit pas l'UUID de l'agent.
async function ensureAgents(){
  if(AGENTS) return AGENTS;
  try{
    const r = await fetch('https://valorant-api.com/v1/agents?isPlayableCharacter=true');
    if(r.ok){
      const d = await r.json(), map = {};
      (d.data||[]).forEach(ag=>{ if(ag.displayName && ag.displayIcon) map[ag.displayName.toLowerCase()] = ag.displayIcon; });
      AGENTS = map;
    }
  }catch(e){ /* pas d'icônes d'agent, on garde les initiales */ }
  return AGENTS || {};
}
// Paliers compétitifs : nom -> icône de rang. Repli quand HenrikDev ne donne pas l'image.
async function ensureTiers(){
  if(TIERS) return TIERS;
  try{
    const r = await fetch('https://valorant-api.com/v1/competitivetiers');
    if(r.ok){
      const d = await r.json(), map = {}, byNum = {};
      const eps = d.data||[];
      const latest = eps[eps.length-1];                 // dernier épisode = paliers à jour
      ((latest&&latest.tiers)||[]).forEach(t=>{
        if(t.tierName && t.largeIcon) map[t.tierName.trim().toLowerCase()] = t.largeIcon;
        if(t.tier!=null){                               // numéro de palier -> nom/couleur/icône (lignes du graphe)
          const col = t.color ? '#'+String(t.color).slice(0,6) : '#8696a6';
          byNum[t.tier] = { name:(t.tierName||'').trim(), color:col, icon:t.largeIcon||'' };
        }
      });
      TIERS = map; TIER_BY_NUM = byNum;
    }
  }catch(e){ /* pas d'icônes de rang, on garde le texte */ }
  return TIERS || {};
}
// Récupère l'icône d'un rang : priorité aux images HenrikDev, repli sur valorant-api.
function rankIcon(cur, tierName){
  return (cur && cur.images && (cur.images.large || cur.images.small))
      || (TIERS && TIERS[(tierName||'').toLowerCase()])
      || null;
}
// Stats brutes d'un joueur sur une partie (avant calcul de l'indice).
function rawLine(p,rounds,kastMap){
  const st=p.stats||{};
  const k=num(st.kills),d=num(st.deaths),a=num(st.assists),score=num(st.score);
  const hsT=num(st.headshots)+num(st.bodyshots)+num(st.legshots);
  const hs=hsT?Math.round(num(st.headshots)/hsT*100):0;
  const dmg=num(st.damage&&st.damage.dealt, num(st.damage_made));
  const rec=num(st.damage&&st.damage.received);
  const acs=rounds?Math.round(score/rounds):0, adr=rounds?Math.round(dmg/rounds):0;
  const dd=rounds?Math.round((dmg-rec)/rounds):0, kd=k/Math.max(d,1);
  const ag=p.agent||{};
  const kast=(kastMap && p.puuid!=null && kastMap[p.puuid]!=null)?kastMap[p.puuid]:null;
  return {k,d,a,hs,acs,adr,dd,kd,rounds,kast,shots:hsT,name:p.name||'?',tag:p.tag||'',team:p.team_id,
    agent:ag.name||(typeof p.agent==='string'?p.agent:'?'),
    agentId:ag.id||ag.uuid||''};
}

// Note TOUS les joueurs d'une partie d'un coup : nécessaire pour connaître le
// classement de chacun dans le lobby. ctx : { rounds, forfeit, winByTeam }
function applyScores(lines, ctx){
  ctx = ctx || {};
  const bases = lines.map(o => perfParts(o).reduce((s,p) => s + p.n * p.w, 0));
  const rank = {};                                    // index -> rang (1 = meilleur)
  bases.map((b,i)=>({b,i})).sort((x,y)=>y.b-x.b).forEach((e,idx)=>{ rank[e.i]=idx+1; });
  const n = lines.length, useLobby = n >= 6;          // pas de classement fiable à 1 joueur
  lines.forEach((o,i)=>{
    const d = perfDetail(o, {
      rounds: ctx.rounds != null ? ctx.rounds : o.rounds,
      forfeit: ctx.forfeit,
      win: ctx.winByTeam ? ctx.winByTeam[o.team] : undefined,
      rel: useLobby ? (n - rank[i]) / (n - 1) * 100 : null,
      rank: useLobby ? rank[i] : null,
      lobbyN: useLobby ? n : null,
    });
    o.score100 = d.score; o.detail = d;
  });
  return lines;
}

// Ligne unique (format compact du blob) : pas de contexte de lobby.
function statline(p,rounds,ctx){
  const o=rawLine(p,rounds);
  const d=perfDetail(o, Object.assign({rounds}, ctx||{}));
  o.score100=d.score; o.detail=d;
  return o;
}
/* ============ DÉTAIL D'UNE PARTIE (timeline, faits d'armes, duels) ============
   Tout est extrait des données de round DÉJÀ téléchargées avec la partie.
   On ne garde que le résultat (compact, ~3 Ko) et pas les tableaux bruts, qui
   pèsent des centaines de Ko par match. */
function matchFacts(m, roundsCount, me){
  const rs = Array.isArray(m && m.rounds) ? m.rounds : [];
  const kills = Array.isArray(m && m.kills) ? m.kills : [];
  const players = Array.isArray(m && m.players) ? m.players : [];
  if(!rs.length || !me) return null;
  const mp = me.puuid, myTeam = me.team_id;

  // Kills groupés par round, triés chronologiquement.
  const byRound = new Map();
  kills.forEach(k=>{ const r=num(k.round); if(!byRound.has(r)) byRound.set(r,[]); byRound.get(r).push(k); });
  byRound.forEach(list=>list.sort((a,b)=>num(a.time_in_round_in_ms)-num(b.time_in_round_in_ms)));

  const mates = players.filter(p=>p.team_id===myTeam && p.puuid!==mp).length;
  const foes  = players.filter(p=>p.team_id!==myTeam).length;

  let firstBloods=0, firstDeaths=0, clutches=0, plants=0, defuses=0;
  const multi={}, clutchKinds=[];
  const dealt={}, received={};

  const timeline = rs.map((r,i)=>{
    const ks = byRound.get(i) || [];
    const mine = ks.filter(k=>k.killer&&k.killer.puuid===mp);
    const won = r.winning_team===myTeam;

    if(ks.length){
      if(ks[0].killer&&ks[0].killer.puuid===mp) firstBloods++;
      if(ks[0].victim&&ks[0].victim.puuid===mp) firstDeaths++;
    }
    if(mine.length>=2) multi[mine.length]=(multi[mine.length]||0)+1;

    // Ma ligne de stats sur ce round (arme, armure, dégâts, AFK…)
    const mst = (r.stats||[]).find(s=>s.player&&s.player.puuid===mp) || {};
    const eco = mst.economy||{}, st = mst.stats||{};
    let myDmg=0;
    (mst.damage_events||[]).forEach(d=>{
      myDmg += num(d.damage);
      const n=(d.player&&d.player.name)||'?';
      dealt[n]=(dealt[n]||0)+num(d.damage);
    });
    // Dégâts subis : ce que les autres m'ont infligé sur ce round.
    (r.stats||[]).forEach(s=>{
      if(!s.player || s.player.puuid===mp) return;
      (s.damage_events||[]).forEach(d=>{
        if(d.player && d.player.puuid===mp) received[s.player.name]=(received[s.player.name]||0)+num(d.damage);
      });
    });

    const pl=r.plant, df=r.defuse;
    if(pl && pl.player && pl.player.puuid===mp) plants++;
    if(df && df.player && df.player.puuid===mp) defuses++;

    // Clutch : je survis, tous mes coéquipiers sont morts, il restait des
    // ennemis à ce moment-là, et je conclus le round.
    const iDied = ks.some(k=>k.victim&&k.victim.puuid===mp);
    if(won && !iDied && mates>0){
      const mateDeaths = ks.filter(k=>k.victim&&k.victim.team===myTeam&&k.victim.puuid!==mp);
      if(mateDeaths.length>=mates){
        const tLast = num(mateDeaths[mateDeaths.length-1].time_in_round_in_ms);
        const foesDeadBefore = ks.filter(k=>k.victim&&k.victim.team!==myTeam&&num(k.time_in_round_in_ms)<=tLast).length;
        const alive = foes - foesDeadBefore;
        const after = mine.filter(k=>num(k.time_in_round_in_ms)>tLast).length;
        if(alive>=1 && after>=1){ clutches++; clutchKinds.push(`1v${alive}`); }
      }
    }

    return { n:i+1, won, result:r.result||'', ceremony:(r.ceremony||'').replace(/^Ceremony/,''),
      myKills:mine.length, myDmg, myScore:num(st.score),
      weapon:(eco.weapon&&eco.weapon.name)||'', armor:(eco.armor&&eco.armor.name)||'',
      loadout:num(eco.loadout_value), afk:!!mst.was_afk,
      plant: pl?{ site:pl.site||'', by:(pl.player&&pl.player.name)||'', mine:!!(pl.player&&pl.player.puuid===mp) }:null,
      defuse: df?{ by:(df.player&&df.player.name)||'', mine:!!(df.player&&df.player.puuid===mp) }:null,
      kills: ks.map(k=>({ killer:(k.killer&&k.killer.name)||'?', victim:(k.victim&&k.victim.name)||'?',
        weapon:(k.weapon&&k.weapon.name)||'', t:num(k.time_in_round_in_ms),
        mine:!!(k.killer&&k.killer.puuid===mp), onMe:!!(k.victim&&k.victim.puuid===mp),
        assists:(k.assistants||[]).map(a=>a&&a.name).filter(Boolean) })),
    };
  });

  // --- Armes : kills par arme (exact, depuis kills[]).
  //     Note : l'API ne fournit PAS le HS% par arme (aucun flag headshot sur un
  //     kill ni sur un damage_event), on ne l'invente donc pas.
  const wc={};
  kills.forEach(k=>{ if(k.killer&&k.killer.puuid===mp){ const w=(k.weapon&&k.weapon.name)||'—'; wc[w]=(wc[w]||0)+1; } });
  const weapons=Object.entries(wc).map(([name,n])=>({name,kills:n})).sort((a,b)=>b.kills-a.kills);

  // --- Précision : répartition exacte des tirs touchés (niveau match).
  const ms=me.stats||{};
  const head=num(ms.headshots), body=num(ms.bodyshots), leg=num(ms.legshots);
  const shotsTot=head+body+leg;
  const precision={ head, body, leg, total:shotsTot, hsPct: shotsTot?Math.round(head/shotsTot*100):0 };

  // --- Économie : achat moyen + répartition eco / demi-achat / full-buy avec le
  //     taux de victoire de chaque tranche.
  const ecoM=me.economy||{};
  const buckets={ eco:{n:0,won:0,label:'Eco (<2000)'}, half:{n:0,won:0,label:'Demi-achat'}, full:{n:0,won:0,label:'Full buy (≥3900)'} };
  timeline.forEach(r=>{ const b=r.loadout<2000?'eco':(r.loadout<3900?'half':'full'); buckets[b].n++; if(r.won) buckets[b].won++; });
  const avgFromTl = timeline.length ? Math.round(timeline.reduce((s,r)=>s+r.loadout,0)/timeline.length) : 0;
  const economy={
    avgLoadout: Math.round(num(ecoM.loadout_value&&ecoM.loadout_value.average)) || avgFromTl,
    avgSpent: Math.round(num(ecoM.spent&&ecoM.spent.average)),
    buckets,
  };

  // --- Utilitaire : casts de compétences (les clés varient selon les versions).
  const ac=me.ability_casts||{};
  const pick=(...k)=>{ for(const x of k){ if(ac[x]!=null) return num(ac[x]); } return 0; };
  const abilities={ grenade:pick('grenade','c_cast'), a1:pick('ability1','ability_1','q_cast'),
    a2:pick('ability2','ability_2','e_cast'), ult:pick('ultimate','x_cast') };
  abilities.total=abilities.grenade+abilities.a1+abilities.a2+abilities.ult;
  abilities.perRound=roundsCount?Math.round(abilities.total/roundsCount*10)/10:0;

  const duels = players.filter(p=>p.team_id!==myTeam).map(p=>({
    name:p.name, tag:p.tag, dealt:num(dealt[p.name]), received:num(received[p.name]),
  })).sort((a,b)=>(b.dealt+b.received)-(a.dealt+a.received));

  const lobby = players.map(p=>({
    name:p.name, tag:p.tag, team:p.team_id, mine:p.team_id===myTeam, isMe:p.puuid===mp,
    tier:(p.tier&&p.tier.name)||'', party:p.party_id||'', agent:(p.agent&&p.agent.name)||'',
  }));
  // Groupes : on ne numérote que les party_id partagés par au moins 2 joueurs.
  const counts={}; lobby.forEach(p=>{ if(p.party) counts[p.party]=(counts[p.party]||0)+1; });
  const groups={}; let g=0;
  Object.keys(counts).forEach(id=>{ if(counts[id]>1) groups[id]=++g; });
  lobby.forEach(p=>{ p.group=groups[p.party]||0; });

  return { timeline, firstBloods, firstDeaths, multi, clutches, clutchKinds, plants, defuses,
           weapons, precision, economy, abilities, duels, lobby };
}

// Nom du mode de jeu, quel que soit le format renvoyé par l'API.
// Attention : queue peut être une chaîne, ou un objet dont "name" vaut null
// (ex. {id:"skirmish_2v2", name:null}) — il ne faut JAMAIS retomber sur l'objet.
function modeName(meta){
  const q = meta && meta.queue;
  if(typeof q === 'string' && q) return q;
  if(q && typeof q === 'object') return q.name || q.id || q.mode_type || '';
  return (meta && (meta.mode || meta.mode_id)) || '';
}
const modeKey = meta => String(modeName(meta)).toLowerCase();

// Normalise une partie au format "matches v4" (metadata + players[] + teams[]).
function normMatch(m, targetState = STATE){
  const meta=m.metadata||{};
  const players=Array.isArray(m.players)?m.players:[];
  const teams=Array.isArray(m.teams)?m.teams:[];
  const me=players.find(p=>p.puuid===targetState.puuid)
        || players.find(p=>(p.name||'').toLowerCase()===targetState.name.toLowerCase()&&(p.tag||'').toLowerCase()===targetState.tag.toLowerCase());

  const sorted = [...players].sort((a,b) => (num(b.stats?.score) - num(a.stats?.score)));
  const meIndex = me ? sorted.findIndex(p => p.puuid === me.puuid || ((p.name||'').toLowerCase()===(me.name||'').toLowerCase() && (p.tag||'').toLowerCase()===(me.tag||'').toLowerCase())) : -1;
  const placement = meIndex !== -1 ? meIndex + 1 : null;

  const T=id=>teams.find(t=>t.team_id===id);
  const rwon=t=>t&&t.rounds?num(t.rounds.won):0, rlost=t=>t&&t.rounds?num(t.rounds.lost):0;
  const myTeam=me?T(me.team_id):null, oppTeam=teams.find(t=>myTeam&&t.team_id!==myTeam.team_id);
  let rounds=myTeam?rwon(myTeam)+rlost(myTeam):(rwon(T('Red'))+rwon(T('Blue')));
  if(!rounds) rounds=(Array.isArray(m.rounds)&&m.rounds.length)||24;
  let result='?';
  if(myTeam) result=(typeof myTeam.won==='boolean')?(myTeam.won?'w':'l'):(rwon(myTeam)>=rwon(oppTeam)?'w':'l');

  // Forfait : en compétitif/non classé il faut 13 rounds pour gagner. Si le
  // vainqueur en a moins, c'est que l'équipe adverse a déclaré forfait.
  const standard=/competitive|unrated|classé|compétitif/.test(modeKey(meta));
  const forfeit=standard && rounds>0 && rounds<FULL_ROUNDS*2 && Math.max(rwon(myTeam),rwon(oppTeam))<FULL_ROUNDS;

  // Indice de tous les joueurs (nécessaire pour le classement dans le lobby).
  const winByTeam={};
  teams.forEach(t=>{ if(t && t.team_id!=null && typeof t.won==='boolean') winByTeam[t.team_id]=t.won; });
  if(!Object.keys(winByTeam).length && myTeam) winByTeam[myTeam.team_id]=(result==='w');
  const kastMap=kastByPuuid(m, rounds);
  const lines=applyScores(players.map(p=>rawLine(p,rounds,kastMap)), {rounds, forfeit, winByTeam});
  const meIdx=me?players.indexOf(me):-1;
  const meStat=meIdx>=0?lines[meIdx]:null;
  if(meStat) meStat.placement = placement;

  const startedMs=tsMs(meta);
  const facts = me ? matchFacts(m, rounds, me) : null;
  // Groupe de queue : les joueurs qui partagent MON party_id. Un party_id seul
  // (taille 1) = solo. Absent du format compact du blob -> null, pas 1.
  let party=null;
  if(me && me.party_id){
    const mates=players.filter(p=>p.party_id===me.party_id);
    party={ size:mates.length, names:mates.filter(p=>p.puuid!==me.puuid).map(p=>p.name||'?') };
  }
  return {players,rounds,lines,forfeit,facts,party,durMs:durMs(meta),
    map:(meta.map&&meta.map.name)||meta.map||'—',
    mode:modeName(meta)||'—',
    started: meta.started_at||meta.game_start_iso||msToIso(startedMs),
    startedMs,
    id: meta.match_id||meta.matchid||meta.matchId||null,
    myScore:rwon(myTeam), oppScore:rwon(oppTeam), result,
    me:meStat, myTeamId:me?me.team_id:'Blue'};
}

// Normalise une partie au format "stored-matches v1" (meta + stats + teams:{red,blue}).
// Ce format est compact (uniquement le joueur interrogé), pas la liste complète.
function normStored(entry, targetState = STATE){
  const meta=entry.meta||{}, st=entry.stats||{}, tms=entry.teams||{};
  const teamKey=(st.team||'').toLowerCase();
  const myScore=num(tms[teamKey]);
  const oppScore=num(tms[teamKey==='red'?'blue':'red']);
  let rounds=myScore+oppScore; if(!rounds) rounds=24;
  const result=myScore>oppScore?'w':(myScore<oppScore?'l':'?');
  const ch=st.character||{}, shots=st.shots||{}, dmg=st.damage||{};
  // On reconstruit un "player" brut pour réutiliser statline (mêmes calculs partout).
  const player={ puuid:st.puuid, name:targetState.name||st.name||'?', tag:targetState.tag||'', team_id:st.team,
    agent:{ id:ch.id||ch.uuid||'', name:ch.name||'?' },
    stats:{ kills:num(st.kills), deaths:num(st.deaths), assists:num(st.assists), score:num(st.score),
      headshots:num(shots.head), bodyshots:num(shots.body), legshots:num(shots.leg),
      damage:{ dealt:num(dmg.made), received:num(dmg.received) } } };
  const standard2=/competitive|unrated|classé|compétitif/.test(modeKey(meta));
  const forfeit=standard2 && rounds>0 && rounds<FULL_ROUNDS*2 && Math.max(myScore,oppScore)<FULL_ROUNDS;
  const meStat=statline(player, rounds, {forfeit, win: result==='?'?undefined:(result==='w')});
  meStat.placement=null; // pas d'info de classement dans ce format compact
  const startedMs=tsMs(meta);
  return { players:[player], rounds, partial:true, forfeit, party:null, durMs:durMs(meta),   // format compact : 1 seul joueur, détail complet chargeable à la demande
    map:(meta.map&&meta.map.name)||meta.map||'—',
    mode:modeName(meta)||'—',
    started: meta.started_at||meta.game_start_iso||msToIso(startedMs),
    startedMs,
    id: meta.id||meta.match_id||null,
    myScore, oppScore, result, me:meStat, myTeamId:st.team||'Blue' };
}

// Détecte le format puis normalise. v4 = "metadata", stored v1 = "meta"+"stats".
function normalizeAny(raw, targetState = STATE){
  if(!raw || typeof raw!=='object') return null;
  if(raw.metadata) return normMatch(raw, targetState);
  if(raw.meta && raw.stats) return normStored(raw, targetState);
  return normMatch(raw, targetState); // repli défensif (guards en place)
}

// Index match_id -> infos RR/rang, depuis la série RR normalisée (blob + live).
// change = RR gagné/perdu sur la game, tierName/icon = rang du joueur à ce moment-là.
function rrIndexFromSeries(series){
  const idx={};
  (series||[]).forEach(e=>{
    if(!e || !e.id) return;
    const tierName = (e.tier&&e.tier.name) || '';
    const icon = (tierName && TIERS) ? (TIERS[tierName.toLowerCase()]||null) : null;
    idx[e.id]={ change:e.change, tierName, icon, rr:e.rr, season:e.season||null };
  });
  return idx;
}

/* ===================== SESSIONS =====================
   Une SESSION = une suite de parties séparées par moins de SESSION_GAP.
   Le découpage se fait sur l'ÉCART entre la FIN d'une partie et le DÉBUT de la
   suivante — jamais sur le jour calendaire. Conséquences voulues :
     - une session du samedi 23h au dimanche 2h reste UNE session ;
     - deux sessions le même jour (midi puis 21h) restent DEUX sessions.
*/
let SESSION_GAP_MIN = 120;               // écart (minutes) qui coupe une session
const BASELINE_MIN = 6;                  // parties hors session nécessaires pour comparer
const STACK_LABEL = {1:'Solo', 2:'Duo', 3:'Trio', 4:'Quatuor', 5:'5-stack'};
const RANKED_RE = /competitive|class[ée]|comp[ée]titif/;
const isRanked = M => RANKED_RE.test(String((M&&M.mode)||'').toLowerCase());
// Les rapports de session ne portent QUE sur les parties classées : un
// deathmatch ou un swiftplay n'a ni le même format, ni le même enjeu, et
// polluerait aussi bien le découpage que les moyennes.
const rankedOnly = list => (list||[]).filter(isRanked);
const memberKey = m => String((m&&m.name)||'').toLowerCase()+'#'+String((m&&m.tag)||'').toLowerCase();

const mean = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : null;
// Moyenne pondérée : une partie de 24 rounds pèse plus qu'un stomp en 13.
function wavg(items, val, weight){
  let s=0, w=0;
  items.forEach(it=>{
    const v=val(it); if(v==null||isNaN(v)) return;
    const k=Math.max(1, num(weight?weight(it):1, 1));
    s+=v*k; w+=k;
  });
  return w ? s/w : null;
}

// Découpe une liste de parties normalisées en sessions (plus récente en premier).
function buildSessions(matches, gapMs){
  const gap = gapMs!=null ? gapMs : SESSION_GAP_MIN*60000;
  const chrono=(matches||[]).filter(M=>M && M.startedMs>0).slice().sort((a,b)=>a.startedMs-b.startedMs);
  const out=[]; let cur=null;
  chrono.forEach(M=>{
    if(!cur || (M.startedMs - cur.endMs) > gap){
      cur={ matches:[], startMs:M.startedMs, endMs:0 };
      out.push(cur);
    }
    cur.matches.push(M);
    cur.endMs=Math.max(cur.endMs, M.startedMs + matchDuration(M));
  });
  out.forEach(s=>{ s.durationMs=s.endMs-s.startMs; s.key='s'+s.startMs; });
  return out.reverse();
}

// Agrégat de stats sur un paquet de parties (session OU référence long terme).
function sessionStats(list){
  const P=(list||[]).filter(M=>M && M.me);
  const rounds=M=>num(M.rounds,1);
  const st={
    n:P.length,
    wins:P.filter(M=>M.result==='w').length,
    losses:P.filter(M=>M.result==='l').length,
    forfeits:P.filter(M=>M.forfeit).length,
    roundsWon:P.reduce((s,M)=>s+num(M.myScore),0),
    roundsLost:P.reduce((s,M)=>s+num(M.oppScore),0),
    totalRounds:P.reduce((s,M)=>s+rounds(M),0),
    index:wavg(P, M=>M.me.score100, rounds),
    acs:wavg(P, M=>M.me.acs, rounds),
    adr:wavg(P, M=>M.me.adr, rounds),
    dd:wavg(P, M=>M.me.dd, rounds),
    hs:wavg(P, M=>M.me.hs, M=>num(M.me.shots,1)),          // pondéré par les tirs touchés
    kast:wavg(P.filter(M=>M.me.kast!=null), M=>M.me.kast, rounds),
    k:P.reduce((s,M)=>s+num(M.me.k),0),
    d:P.reduce((s,M)=>s+num(M.me.d),0),
    a:P.reduce((s,M)=>s+num(M.me.a),0),
  };
  st.kd=st.d?st.k/st.d:st.k;
  st.kda=st.d?(st.k+st.a)/st.d:(st.k+st.a);
  st.dpr=st.totalRounds?st.d/st.totalRounds:null;          // morts par round
  st.winrate=st.n?st.wins/st.n*100:null;
  // RR : uniquement les parties classées dont on connaît la variation.
  const rr=P.filter(M=>isRanked(M) && M.rr && M.rr.change!=null);
  st.rrGames=rr.length;
  st.rrNet=rr.length?rr.reduce((s,M)=>s+num(M.rr.change),0):null;
  return st;
}

// Agrégat des "faits d'armes" — présents seulement sur les parties au format
// complet (les parties compactes du blob n'ont pas le détail des rounds).
function sessionFacts(list){
  const F=(list||[]).filter(M=>M && M.facts);
  if(!F.length) return null;
  const f={ n:F.length, firstBloods:0, firstDeaths:0, clutches:0, plants:0, defuses:0,
            multi:0, aces:0, ecoN:0, ecoWon:0, fullN:0, fullWon:0 };
  const loads=[];
  F.forEach(M=>{
    const x=M.facts;
    f.firstBloods+=num(x.firstBloods); f.firstDeaths+=num(x.firstDeaths);
    f.clutches+=num(x.clutches); f.plants+=num(x.plants); f.defuses+=num(x.defuses);
    Object.keys(x.multi||{}).forEach(k=>{ f.multi+=num(x.multi[k]); if(num(k)>=5) f.aces+=num(x.multi[k]); });
    const b=(x.economy&&x.economy.buckets)||{};
    if(b.eco){ f.ecoN+=num(b.eco.n); f.ecoWon+=num(b.eco.won); }
    if(b.full){ f.fullN+=num(b.full.n); f.fullWon+=num(b.full.won); }
    if(x.economy&&x.economy.avgLoadout) loads.push(x.economy.avgLoadout);
  });
  f.avgLoadout=loads.length?Math.round(mean(loads)):null;
  f.ecoWR=f.ecoN?f.ecoWon/f.ecoN*100:null;
  f.fullWR=f.fullN?f.fullWon/f.fullN*100:null;
  return f;
}

// Référence de comparaison : les AUTRES parties du joueur, dans les MÊMES modes
// que la session (comparer une session de DM à des ranked n'aurait aucun sens).
function sessionBaseline(session, allMatches){
  const modes=new Set(session.matches.map(M=>String(M.mode||'').toLowerCase()));
  const ids=new Set(session.matches.map(M=>M.id).filter(Boolean));
  const pool=(allMatches||[]).filter(M=>M && M.me && !ids.has(M.id)
    && modes.has(String(M.mode||'').toLowerCase()));
  if(pool.length<BASELINE_MIN) return null;
  const st=sessionStats(pool);
  st.facts=sessionFacts(pool);
  return st;
}

// Évolution DANS la session : moyenne d'indice de la 1re moitié vs la 2nde.
// C'est le signal "tilt / fatigue" — le plus utile d'un rapport de session.
function sessionTrend(list){
  const P=(list||[]).filter(M=>M && M.me);
  if(P.length<4) return null;
  const h=Math.ceil(P.length/2);
  const first=mean(P.slice(0,h).map(M=>M.me.score100));
  const last=mean(P.slice(h).map(M=>M.me.score100));
  return { n:P.length, first:Math.round(first), last:Math.round(last), delta:Math.round(last-first) };
}

// Meilleur / pire regroupement (map, agent…) dans la session.
function bestWorst(list, keyFn, minGames){
  const g={};
  (list||[]).forEach(M=>{ if(!M||!M.me) return; const k=keyFn(M); if(!k||k==='—') return; (g[k]=g[k]||[]).push(M); });
  const rows=Object.keys(g).filter(k=>g[k].length>=(minGames||2)).map(k=>({
    key:k, n:g[k].length,
    index:Math.round(mean(g[k].map(M=>M.me.score100))),
    wins:g[k].filter(M=>M.result==='w').length,
  }));
  if(rows.length<2) return null;
  rows.sort((a,b)=>b.index-a.index);
  return { best:rows[0], worst:rows[rows.length-1], rows };
}

/* --- Composition : solo / duo / trio ---------------------------------------
   Deux sources, volontairement distinctes :
   - le STACK COSMO, déduit du croisement des historiques par match_id (fiable
     sur TOUT l'historique, y compris les parties compactes du blob) ;
   - la TAILLE DE PARTY réelle (party_id), qui inclut les joueurs hors squad
     mais n'existe que sur les parties au format complet.
   On n'affiche la seconde que quand elle apporte quelque chose. */
function matchSquadMates(M, squadIndex, selfKey){
  if(!M || !M.id || !squadIndex) return [];
  return (squadIndex[M.id]||[]).filter(e=>e.team===M.myTeamId && e.key!==selfKey);
}

function sessionComposition(list, squadIndex, selfKey){
  const bySize={}, mates={};
  let partyKnown=0, partyMax=0, partyExtra=0;
  (list||[]).forEach(M=>{
    const others=matchSquadMates(M, squadIndex, selfKey);
    const size=others.length+1;
    bySize[size]=(bySize[size]||0)+1;
    others.forEach(e=>{ mates[e.key]=mates[e.key]||{ key:e.key, name:e.name, tag:e.tag, color:e.color, n:0 }; mates[e.key].n++; });
    if(M.party && M.party.size>0){
      partyKnown++;
      partyMax=Math.max(partyMax, M.party.size);
      partyExtra=Math.max(partyExtra, M.party.size-size);   // joueurs hors squad dans la party
    }
  });
  const sizes=Object.keys(bySize).map(Number).sort((a,b)=>bySize[b]-bySize[a] || b-a);
  // Une équipe Valorant compte 5 joueurs : au-delà, c'est du bruit de données
  // (doublon dans le roster, ancien pseudo encore présent…), on plafonne.
  const dominant=Math.min(sizes.length?sizes[0]:1, 5);
  const mixed=sizes.length>1;
  return {
    dominant, mixed, bySize,
    label:STACK_LABEL[dominant]||(dominant+'-stack'),
    mates:Object.keys(mates).map(k=>mates[k]).sort((a,b)=>b.n-a.n),
    partyKnown, partyMax, partyExtra:Math.max(0,partyExtra),
  };
}

// Verdict d'une session : croise la PERFORMANCE (vs ta référence) et le
// RÉSULTAT (RR, sinon winrate). Les deux peuvent diverger — c'est justement
// l'information intéressante ("bien joué, mal payé").
function sessionVerdict(st, base, trend){
  const d=(base && st.index!=null && base.index!=null) ? st.index-base.index : null;
  const perfUp=d!=null && d>=5, perfDown=d!=null && d<=-5;
  const resUp  = st.rrNet!=null ? st.rrNet>0  : (st.winrate!=null && st.winrate>=60);
  const resDown= st.rrNet!=null ? st.rrNet<0  : (st.winrate!=null && st.winrate<=40);
  let word='SESSION MOYENNE', tone='mid', line='Ni bonne ni mauvaise : tu es resté dans tes standards.';
  if(perfUp&&resUp)        { word='GROSSE SESSION';      tone='good'; line='Au-dessus de ton niveau habituel ET ça a payé.'; }
  else if(perfUp&&resDown) { word='BIEN JOUÉ, MAL PAYÉ'; tone='mixed';line='Tu as mieux joué que d\'habitude, le résultat n\'a pas suivi.'; }
  else if(perfDown&&resUp) { word='SESSION PORTÉE';      tone='mixed';line='Les résultats sont là, mais pas grâce à toi cette fois.'; }
  else if(perfDown&&resDown){word='SESSION À OUBLIER';   tone='bad';  line='En dessous de ton niveau, et la sanction est tombée.'; }
  else if(perfUp)          { word='BONNE SESSION';       tone='good'; line='Au-dessus de ta moyenne sur ces modes.'; }
  else if(perfDown)        { word='SESSION EN DESSOUS';  tone='bad';  line='En dessous de ta moyenne sur ces modes.'; }
  else if(resUp)           { word='SESSION POSITIVE';    tone='good'; line='Perf habituelle, mais le bilan est bon.'; }
  else if(resDown)         { word='SESSION NÉGATIVE';    tone='bad';  line='Perf habituelle, mais le bilan est mauvais.'; }
  if(trend && trend.delta<=-10 && tone!=='good') line+=' Et tu as clairement baissé en cours de route.';
  return { word, tone, line, dIndex:d };
}

/* Analyse complète d'une session -> verdict + ce qui allait / n'allait pas /
   à améliorer. Chaque règle est GARDÉE : si la donnée manque (pas de référence,
   pas de détail de round), la règle ne produit rien plutôt que d'inventer. */
function analyzeSession(session, ctx){
  ctx=ctx||{};
  const ms=session.matches.filter(M=>M && M.me);
  const st=sessionStats(ms);
  const facts=sessionFacts(ms);
  const base=ctx.baseline||null;
  const bf=base&&base.facts||null;
  const trend=sessionTrend(ms);
  const good=[], bad=[], tips=[];
  const G=(t,x)=>good.push({title:t,text:x});
  const B=(t,x)=>bad.push({title:t,text:x});
  const T=(t,x)=>tips.push({title:t,text:x});
  const one=v=>Math.round(v*100)/100;
  const sign=v=>(v>0?'+':'')+v;
  const d=(a,b)=>(a==null||b==null)?null:a-b;

  const dIdx=d(st.index, base&&base.index), dAcs=d(st.acs, base&&base.acs);
  const dAdr=d(st.adr, base&&base.adr),     dHs=d(st.hs, base&&base.hs);
  const dKd=d(st.kd, base&&base.kd),        dDpr=d(st.dpr, base&&base.dpr);
  const dKast=(st.kast!=null&&base&&base.kast!=null)?st.kast-base.kast:null;

  // --- Performance globale vs ta référence
  if(dIdx!=null && dIdx>=6)  G('Au-dessus de ton niveau', `Indice moyen ${Math.round(st.index)} contre ${Math.round(base.index)} d'habitude (${sign(Math.round(dIdx))}).`);
  if(dIdx!=null && dIdx<=-6) B('En dessous de ton niveau', `Indice moyen ${Math.round(st.index)} contre ${Math.round(base.index)} d'habitude (${sign(Math.round(dIdx))}).`);

  // --- Impact
  if(dAcs!=null && dAcs>=15)  G('Impact en hausse', `${Math.round(st.acs)} ACS contre ${Math.round(base.acs)} en moyenne.`);
  if(dAcs!=null && dAcs<=-15) B('Impact en baisse', `${Math.round(st.acs)} ACS contre ${Math.round(base.acs)} en moyenne.`);
  if(dAdr!=null && dAdr<=-12){
    B('Moins de dégâts', `${Math.round(st.adr)} ADR contre ${Math.round(base.adr)} d'habitude.`);
    T('Cherche le dégât, pas le kill', 'Tire sur tout ce qui dépasse : un adversaire à 40 PV, c\'est un round gagné par ton équipe même si tu ne le finis pas.');
  }

  // --- Duels & survie
  if(dKd!=null && dKd>=0.25)  G('Duels gagnés', `K/D ${one(st.kd)} contre ${one(base.kd)} d'habitude.`);
  if(dKd!=null && dKd<=-0.25) B('Duels perdus', `K/D ${one(st.kd)} contre ${one(base.kd)} d'habitude.`);
  if(dDpr!=null && dDpr>=0.06){
    B('Tu meurs plus souvent', `${one(st.dpr)} mort par round contre ${one(base.dpr)} d'habitude.`);
    T('Prends moins de duels gratuits', 'Attends l\'utilitaire et le trade de ton coéquipier avant d\'ouvrir. Une mort en début de round coûte le round entier.');
  }
  if(dKast!=null && dKast>=6)  G('Toujours dans le coup', `KAST ${Math.round(st.kast)}% contre ${Math.round(base.kast)}% d'habitude.`);
  if(dKast!=null && dKast<=-6){
    B('Souvent hors du coup', `KAST ${Math.round(st.kast)}% contre ${Math.round(base.kast)}% d'habitude : beaucoup de rounds sans kill, sans assist, sans survie et sans trade.`);
    T('Joue plus proche de ton équipe', 'Le KAST monte tout seul quand tu es tradable : reste à portée d\'un coéquipier au lieu de tenir un angle isolé.');
  }

  // --- Visée
  if(dHs!=null && dHs>=4)  G('Visée au-dessus de ton niveau', `${Math.round(st.hs)}% de headshots contre ${Math.round(base.hs)}% d'habitude.`);
  if(dHs!=null && dHs<=-4){
    B('Visée en dessous', `${Math.round(st.hs)}% de headshots contre ${Math.round(base.hs)}% d'habitude.`);
    T('Échauffe-toi avant de lancer', '10 minutes de Range ou un deathmatch avant la première classée : la première partie d\'une session est presque toujours la moins précise.');
  }

  // --- Entrées de round (nécessite le détail des rounds)
  if(facts && facts.n>=2){
    if(facts.firstDeaths>=4 && facts.firstDeaths>=facts.firstBloods*2){
      B('Tu meurs souvent en premier', `${facts.firstDeaths} premières morts pour ${facts.firstBloods} premiers sangs sur ${facts.n} partie${facts.n>1?'s':''} détaillée${facts.n>1?'s':''}.`);
      T('Ne rentre pas en premier sans info', 'Laisse partir un flash, un drone ou un coéquipier avant de prendre l\'angle. Sinon ton équipe joue le round à 4 contre 5.');
    }
    if(facts.firstBloods>=4 && facts.firstBloods>=facts.firstDeaths*1.5)
      G('Tu ouvres bien les rounds', `${facts.firstBloods} premiers sangs pour seulement ${facts.firstDeaths} premières morts.`);
    if(facts.clutches>=2) G('Clutch', `${facts.clutches} rounds gagnés en dernier survivant.`);
    if(facts.aces>=1) G('Ace', `${facts.aces} ace${facts.aces>1?'s':''} dans la session.`);
    if(facts.ecoWR!=null && facts.ecoN>=5 && facts.ecoWR>=35)
      G('Bons rounds d\'eco', `${Math.round(facts.ecoWR)}% de rounds gagnés en eco (${facts.ecoN} rounds).`);
    if(facts.fullWR!=null && facts.fullN>=8 && facts.fullWR<=40){
      B('Full buys gâchés', `Seulement ${Math.round(facts.fullWR)}% de rounds gagnés en full buy (${facts.fullN} rounds).`);
      T('Le problème n\'est pas l\'argent', 'Avec l\'arme il reste l\'exécution : jouez les rounds ensemble, avec un plan de prise de site, plutôt qu\'en solo.');
    }
  }

  // --- Tilt / durée de session
  if(trend){
    if(trend.delta>=8) G('Montée en régime', `Indice ${trend.first} sur la première moitié, ${trend.last} sur la seconde (${sign(trend.delta)}).`);
    if(trend.delta<=-8){
      B('Tu baisses en cours de session', `Indice ${trend.first} sur la première moitié, ${trend.last} sur la seconde (${sign(trend.delta)}).`);
      T('Coupe plus tôt', `Sur cette session, tes meilleures parties sont les premières. Au-delà de ${Math.ceil(trend.n/2)} parties d'affilée, une pause vaut mieux qu'une partie de plus.`);
    }
  }
  if(st.n>=8 && (!trend || trend.delta<0))
    T('Session longue', `${st.n} parties d'affilée, sans progression sur la fin. Découpe en deux sessions avec une vraie coupure.`);

  // --- Bilan
  if(st.n>=3 && st.winrate>=70) G('Série gagnante', `${st.wins} victoires sur ${st.n} parties.`);
  if(st.n>=3 && st.winrate<=30) B('Série perdante', `${st.losses} défaites sur ${st.n} parties.`);
  if(st.rrNet!=null && st.rrNet>=30) G('RR bien remonté', `${sign(st.rrNet)} RR sur ${st.rrGames} partie${st.rrGames>1?'s':''} classée${st.rrGames>1?'s':''}.`);
  if(st.rrNet!=null && st.rrNet<=-30) B('RR lâché', `${st.rrNet} RR sur ${st.rrGames} partie${st.rrGames>1?'s':''} classée${st.rrGames>1?'s':''}.`);

  // --- Divergence perf / résultat : le constat le plus utile de tous.
  if(dIdx!=null){
    if(dIdx>=5 && st.rrNet!=null && st.rrNet<0)
      T('Rien à changer côté perso', 'Tu as joué au-dessus de ta moyenne et tu as quand même perdu du RR. Ce genre de session ne se corrige pas : elle se rejoue.');
    if(dIdx<=-5 && st.rrNet!=null && st.rrNet>0)
      T('Le RR cache ta perf', 'Le bilan RR est positif alors que tu étais en dessous de ta moyenne : ne prends pas cette session comme une référence.');
  }

  // --- Maps & agents de la session
  const maps=bestWorst(ms, M=>M.map, 2);
  if(maps && maps.best.index-maps.worst.index>=10){
    G('Ta map de la session', `${maps.best.key} — indice ${maps.best.index} sur ${maps.best.n} partie${maps.best.n>1?'s':''}.`);
    B('Ta map compliquée', `${maps.worst.key} — indice ${maps.worst.index} sur ${maps.worst.n} partie${maps.worst.n>1?'s':''}.`);
  }
  const ags=bestWorst(ms, M=>M.me.agent, 2);
  if(ags && ags.best.index-ags.worst.index>=10)
    T('Choix d\'agent', `${ags.best.key} t'a bien réussi (indice ${ags.best.index}) là où ${ags.worst.key} a moins marché (${ags.worst.index}). À garder en tête au prochain agent select.`);

  if(st.forfeits>0)
    T('Parties écourtées', `${st.forfeits} partie${st.forfeits>1?'s':''} coupée${st.forfeits>1?'s':''} par forfait : l'échantillon est trop court pour juger, l'indice a été rapproché de la moyenne.`);

  if(!base) T('Pas encore de référence', `Il faut au moins ${BASELINE_MIN} autres parties dans les mêmes modes pour comparer cette session à tes habitudes. Reviens quand l'historique aura grossi.`);

  return { st, facts, base, trend, maps, ags,
           verdict:sessionVerdict(st, base, trend), good, bad, tips };
}

// Rapport COMMUN : chaque membre COSMO présent dans la session, avec ses
// propres stats sur LES PARTIES DE CETTE SESSION uniquement.
// Stats d'un coéquipier sur UNE partie. Deux provenances : son propre
// historique quand on l'a (e.M), sinon le scoreboard complet de la partie —
// indispensable pour les parties récentes, où son blob n'a pas encore été
// rafraîchi (ou vient d'être remis à zéro par un changement de pseudo).
function mateMatch(M, e){
  if(e.M) return e.M;
  if(!M || !Array.isArray(M.players) || !Array.isArray(M.lines)) return null;
  const i=M.players.findIndex(p=>p && (memberKey(p)===e.key || (p.puuid && PUUID_MEMBER[p.puuid]===e.key)));
  const line=i>=0 ? M.lines[i] : null;
  if(!line) return null;
  const same = e.team===M.myTeamId;
  return { id:M.id, rounds:M.rounds, mode:M.mode, map:M.map, startedMs:M.startedMs,
           forfeit:M.forfeit, myTeamId:e.team, me:line, rr:null,   // son ±RR n'est pas dans MA partie
           result: same ? M.result : (M.result==='w'?'l':(M.result==='l'?'w':'?')),
           myScore: same ? M.myScore : M.oppScore,
           oppScore: same ? M.oppScore : M.myScore };
}

function sessionSquadReport(session, squadIndex, selfKey, selfInfo){
  const per={};
  (session.matches||[]).forEach(M=>{
    ((squadIndex||{})[M.id]||[]).forEach(e=>{
      if(e.team!==M.myTeamId) return;              // adversaire : pas la même session
      const mm=mateMatch(M, e); if(!mm) return;
      const r=per[e.key]||(per[e.key]={ key:e.key, name:e.name, tag:e.tag, color:e.color, matches:[] });
      r.matches.push(mm);
    });
  });
  // Le joueur du profil : on utilise SES parties (format riche) plutôt que la
  // version compacte du blob, pour rester cohérent avec le reste de la page.
  const me=selfInfo||{ name:(typeof STATE!=='undefined'&&STATE.name)||'moi', tag:(typeof STATE!=='undefined'&&STATE.tag)||'' };
  per[selfKey]={ key:selfKey, name:me.name, tag:me.tag, color:me.color||'', matches:session.matches.slice(), self:true };
  return Object.keys(per).map(k=>{
    const r=per[k];
    r.st=sessionStats(r.matches);
    r.n=r.st.n;
    return r;
  }).filter(r=>r.n>0).sort((x,y)=>(y.st.index||0)-(x.st.index||0));
}

/* --- Qui a joué avec qui (index match_id -> membres du roster) --------------
   Deux sources complémentaires, toutes deux ancrées sur le ROSTER courant :

   1. Les parties au format COMPLET (matches v4) : elles contiennent tout le
      lobby avec le pseudo ACTUEL de chaque joueur, tel que Riot le renvoie. Un
      membre qui change de pseudo est donc reconnu immédiatement, sans rien
      reconfigurer — c'est la source prioritaire.
   2. L'historique stocké de chaque membre (blobs) : indispensable pour les
      parties anciennes, dont on ne garde qu'une version compacte à un joueur.
      Lecture de blobs uniquement, donc aucun appel HenrikDev ni rate limit.

   Le puuid, stable à travers un changement de pseudo, sert de pont entre les
   deux : appris en 1 ou 2, il rattache les entrées dont le nom a changé. */
let SQUAD_INDEX = null;      // match_id -> [{key,name,tag,color,team,M?}]
let SQUAD_LOADING = null;
let SQUAD_BLOBS_DONE = false;
let PUUID_MEMBER = {};       // puuid -> clé roster (survit à un changement de pseudo)

// N'ajoute jamais deux fois le même membre sur une même partie : une équipe
// compte 5 joueurs, et les deux sources se recoupent volontairement.
function addSquadEntry(idx, id, e){
  const list = idx[id] || (idx[id] = []);
  const prev = list.find(x => x.key === e.key);
  if(prev){
    if(!prev.team && e.team) prev.team = e.team;   // le format complet fait foi
    if(!prev.M && e.M) prev.M = e.M;               // …mais on garde la ligne de stats du blob
    return prev;
  }
  list.push(e); return e;
}

// Table de correspondance roster : par pseudo#tag ET par puuid déjà connu.
function rosterLookup(){
  const byName={}, byKey={};
  ROSTER.forEach(m=>{ const k=memberKey(m); byName[k]=m; byKey[k]=m; });
  return { byName, byKey };
}

// Source 1 : les parties au format complet, qui portent les pseudos actuels.
function indexSquadFromFullMatches(matches, idx){
  const { byName, byKey } = rosterLookup();
  (matches||[]).forEach(M=>{
    if(!M || !M.id || !Array.isArray(M.players) || M.players.length < 2) return;  // format compact : 1 joueur
    M.players.forEach(p=>{
      if(!p) return;
      const nk = memberKey(p);
      const key = byName[nk] ? nk : (p.puuid && PUUID_MEMBER[p.puuid]) || null;
      const m = key && byKey[key];
      if(!m) return;
      if(p.puuid) PUUID_MEMBER[p.puuid] = key;     // on apprend le puuid au passage
      addSquadEntry(idx, M.id, { key, name:m.name, tag:m.tag, color:m.color||'', team:p.team_id });
    });
  });
  return idx;
}

// Source 2 : l'historique stocké de chaque membre du roster.
async function ensureSquadHistories(){
  if(SQUAD_BLOBS_DONE) return SQUAD_INDEX;
  if(SQUAD_LOADING) return SQUAD_LOADING;
  SQUAD_LOADING=(async()=>{
    const idx = SQUAD_INDEX || (SQUAD_INDEX = {});
    const lists=await Promise.all(ROSTER.map(m=>fetchHistorique(m.name, m.tag).catch(()=>[])));
    ROSTER.forEach((m,i)=>{
      const key=memberKey(m), target={ puuid:null, name:m.name, tag:m.tag };
      (lists[i]||[]).forEach(raw=>{
        let M=null;
        try{ M=normalizeAny(raw, target); }catch(e){ M=null; }
        if(!M || !M.id) return;
        const pu=M.players && M.players[0] && M.players[0].puuid;
        if(pu) PUUID_MEMBER[pu]=key;
        addSquadEntry(idx, M.id, { key, name:m.name, tag:m.tag, color:m.color||'', team:M.myTeamId, M });
      });
    });
    // Un puuid appris tardivement peut rattacher des parties complètes vues avant.
    indexSquadFromFullMatches(STATE.allMatches, idx);
    SQUAD_BLOBS_DONE=true; SQUAD_LOADING=null;
    return idx;
  })();
  return SQUAD_LOADING;
}

// Un changement de roster (pseudo, membre ajouté/retiré) invalide l'index.
function resetSquadIndex(){
  SQUAD_INDEX=null; SQUAD_LOADING=null; SQUAD_BLOBS_DONE=false; PUUID_MEMBER={};
}

/* ===================== HOME & PROFIL ===================== */
async function fillRanks(){
  await ensureTiers();
  const region=REGION();
  ROSTER.forEach(async (m,i)=>{
    const el=$('rank-'+i); if(el) el.textContent='rang…';
    try{
      const r=await fetch(PROXY(`/valorant/v3/mmr/${region}/pc/${enc(m.name)}/${enc(m.tag)}`));
      if(!r.ok){ if(el) el.textContent='rang n/c'; return; }
      const d=(await r.json()).data||{}; const cur=d.current||d.current_data||{};
      const tier=(cur.tier&&cur.tier.name)||cur.currenttierpatched||'';
      const rr=cur.rr!=null?cur.rr:cur.ranking_in_tier;
      if(!el) return;
      if(!tier){ el.textContent='non classé'; return; }
      const icon=rankIcon(cur,tier);
      const rrTxt=rr!=null?' · '+rr+' RR':'';
      el.innerHTML=`${icon?`<img class="rankicon" src="${esc(icon)}" alt="${esc(tier)}" loading="lazy">`:''}<span>${esc(tier)}${rrTxt}</span>`;
    }catch(e){ if(el) el.textContent='rang n/c'; }
  });
}
function toggleSheet(){ $('sheet').hidden=!$('sheet').hidden; }
function showHome(){
  $('profile').hidden = true;
  $('tribunal').hidden = true;
  $('leaderboard').hidden = true;
  $('home').hidden = false;
  window.scrollTo(0,0);
}
function status(kind,html){ const s=$('status'); s.className='status show '+kind; s.innerHTML=html; }
function clearStatus(){ $('status').className='status'; }
function relTime(iso){
  if(!iso) return ''; const t=new Date(iso).getTime(); if(isNaN(t)) return '';
  const m=Math.round((Date.now()-t)/60000); if(m<60) return `il y a ${m} min`;
  const h=Math.round(m/60); if(h<24) return `il y a ${h} h`; return `il y a ${Math.round(h/24)} j`;
}

function renderRank(mmr,overall){
  const rr=mmr.rr!=null?num(mmr.rr):null;
  const oT=tierOf(overall);
  const tierInner=mmr.icon
    ? `<img src="${esc(mmr.icon)}" alt="${esc(mmr.tier||'')}" loading="lazy">`
    : esc(mmr.tier||'—').replace(' ','<br>');
  $('rank').innerHTML=`
    <div class="rankbox">
      <div class="tier${mmr.icon?' hasimg':''}">${tierInner}</div>
      <div class="rankinfo"><div class="big">${esc(mmr.tier||'Non classé')}</div>
        <div class="bar"><i id="rrbar"></i></div>
        <div class="meta">${rr!==null?rr+'/100 RR':'RR n/c'}${mmr.elo?' · elo '+esc(mmr.elo):''}${mmr.peak?' · peak '+esc(mmr.peak):''}</div></div></div>
    <div class="indice">Indice COSMO (8 derniers) <span class="num" style="color:${oT.c}">${overall||'—'}</span><span style="color:${oT.c}">/100 · ${oT.t}</span></div>`;
  setTimeout(()=>{const b=$('rrbar'); if(b) b.style.width=(rr!==null?rr:0)+'%';},60);
}
// "e8a3" -> "E8 · A3" ; sinon le code brut en majuscules.
function seasonLabel(short){
  const m=/e(\d+)a(\d+)/i.exec(String(short||''));
  return m ? `E${m[1]} · A${m[2]}` : String(short||'').toUpperCase();
}
// (Re)remplit le menu Saison/Acte à partir des saisons présentes dans RR_FULL.
function populateSeasonFilter(){
  const sel=$('rrSeason'); if(!sel) return;
  const seasons=[...new Set(RR_FULL.map(e=>e&&e.season).filter(Boolean))]; // ordre chronologique
  if(!seasons.includes(RR_SEASON)) RR_SEASON='all';                        // saison absente du nouveau profil
  const opts=['<option value="all">Toutes les saisons</option>']
    .concat(seasons.slice().reverse().map(sh=>`<option value="${esc(sh)}">${esc(seasonLabel(sh))}</option>`)); // plus récent en haut
  sel.innerHTML=opts.join('');
  sel.value=RR_SEASON;
  sel.disabled = seasons.length===0;
}
// Applique un filtre saison + la fenêtre de période à une série RR.
function sliceSeries(full){
  let s = (RR_SEASON!=='all') ? (full||[]).filter(e=> e && e.season===RR_SEASON) : (full||[]);
  return (RR_PERIOD>0 && s.length>RR_PERIOD) ? s.slice(-RR_PERIOD) : s;
}
// Applique filtre saison + période, gère la comparaison éventuelle, puis trace.
function renderCurvePeriod(){
  const s = sliceSeries(RR_FULL);
  document.querySelectorAll('#rrPeriod button').forEach(b=>b.classList.toggle('on', +b.dataset.n===RR_PERIOD));
  let compare=null;
  if(COMPARE_MEMBER && COMPARE_SERIES && COMPARE_SERIES.length){
    const cs=sliceSeries(COMPARE_SERIES);
    if(cs.length) compare={ series:cs, label:COMPARE_MEMBER.name, color:'var(--cyan)' };
  }
  renderCurve(s, compare);
}

// Remplit le menu "comparer à" avec les autres membres du roster.
function populateCompareFilter(){
  const sel=$('rrCompare'); if(!sel) return;
  COMPARE_MEMBER=null; COMPARE_SERIES=null;
  const cur=((STATE.name||'')+'#'+(STATE.tag||'')).toLowerCase();
  const opts=['<option value="">Comparer à…</option>'];
  ROSTER.forEach((m,i)=>{ if(((m.name||'')+'#'+(m.tag||'')).toLowerCase()!==cur) opts.push(`<option value="${i}">vs ${esc(m.name)}</option>`); });
  sel.innerHTML=opts.join('');
  sel.value='';
}

// Charge la série RR d'un second joueur et rafraîchit le graphe (superposition).
async function setCompareMember(idx){
  if(idx==null || idx<0 || Number.isNaN(idx) || !ROSTER[idx]){ COMPARE_MEMBER=null; COMPARE_SERIES=null; renderCurvePeriod(); return; }
  const m=ROSTER[idx]; COMPARE_MEMBER=m; COMPARE_SERIES=[];
  const region=REGION();
  try{
    const [blobR, liveR]=await Promise.allSettled([
      fetchRRHistory(m.name, m.tag),
      api(`/valorant/v2/mmr-history/${region}/pc/${enc(m.name)}/${enc(m.tag)}`)
    ]);
    const blob=blobR.status==='fulfilled'?(blobR.value||[]):[];
    let live=[]; if(liveR.status==='fulfilled'){ const d=liveR.value.data; live=(d&&d.history)||d||[]; }
    if(COMPARE_MEMBER===m) COMPARE_SERIES=mergeRRclient(blob, (live||[]).map(normRRclient));
  }catch(e){ if(COMPARE_MEMBER===m) COMPARE_SERIES=[]; }
  renderCurvePeriod();
}

// Déduit le décalage elo->numéro de palier depuis les données : chaque point a son
// elo ET son vrai palier (tier.id). offset = tier.id - floor(elo/100). On prend le
// plus fréquent (repli 3 : Iron 1 = palier 3 à elo 0).
function computeEloTierOffset(series){
  const tally={};
  (series||[]).forEach(e=>{
    if(!e || e.elo==null || !e.tier || e.tier.id==null) return;
    const off = Number(e.tier.id) - Math.floor(Number(e.elo)/100);
    if(Number.isFinite(off)) tally[off]=(tally[off]||0)+1;
  });
  let best=null, bestN=-1;
  for(const k in tally){ if(tally[k]>bestN){ bestN=tally[k]; best=Number(k); } }
  return best==null ? 3 : best;
}
// Palier (nom/couleur/icône) correspondant à une valeur d'elo.
function tierFromElo(elo){
  if(!TIER_BY_NUM || elo==null) return null;
  return TIER_BY_NUM[Math.floor(Number(elo)/100) + ELO_TIER_OFFSET] || null;
}

// Série RR normalisée -> valeurs à tracer (elo continu si dispo, sinon cumul RR).
function eloSeriesToPts(series){
  const hasElo = series.some(e=>e && e.elo!=null);
  if(hasElo){
    let last=null;
    let pts=series.map(e=>{ if(e && e.elo!=null) last=Number(e.elo); return last; });
    const firstKnown = pts.find(v=>v!=null) ?? 0;
    return { pts: pts.map(v=> v==null? firstKnown : v), mode:'elo' };
  }
  let acc=0; return { pts: series.map(e=>{ acc+=num(e&&e.change); return acc; }), mode:'rr' };
}

// Graphique de progression RR long terme. `series` = points RR normalisés (blob
// accumulé + live). `compare` (optionnel) = {series, label, color} pour superposer
// la progression d'un second joueur.
function renderCurve(series, compare){
  const box=$('curve');
  if(!Array.isArray(series) || !series.length){ box.innerHTML='<div class="vh-line mono">Pas d\'historique RR.</div>'; return; }

  // Série -> valeurs traçables : elo (continu) si dispo, sinon cumul des +/- RR.
  const prim = eloSeriesToPts(series);
  const pts = prim.pts, chartMode = prim.mode;
  const cmp = (compare && compare.series && compare.series.length) ? eloSeriesToPts(compare.series) : null;

  const n=pts.length, W=640,H=250,mL=46,mR=58,mT=16,mB=30, pw=W-mL-mR, ph=H-mT-mB;
  const allV = cmp ? pts.concat(cmp.pts) : pts;
  const minV=Math.min(...allV), maxV=Math.max(...allV);
  const pad=Math.max(chartMode==='elo'?10:2,(maxV-minV)*0.12), lo=minV-pad, hi=maxV+pad, R=Math.max(hi-lo,1);
  const Xn=(i,len)=> mL + (len<=1? pw/2 : i/(len-1)*pw);
  const X=i=> Xn(i,n);
  const Y=v=> mT + (1-(v-lo)/R)*ph;
  const fmtDate = ts => ts? new Date(ts).toLocaleDateString('fr-FR',{day:'2-digit',month:'2-digit'}) : '';

  // Grille horizontale : lignes de PALIERS (mode elo) ou grille numérique (repli).
  let grid='', ylab='';
  const tierMode = chartMode==='elo' && TIER_BY_NUM;
  if(tierMode){
    const kMin=Math.floor(lo/100), kMax=Math.floor(hi/100);
    for(let k=kMin; k<=kMax; k++){
      const ti=TIER_BY_NUM[k+ELO_TIER_OFFSET];   // palier réel de la bande [k*100, (k+1)*100)
      if(k*100>=lo && k*100<=hi){ const yy=Y(k*100);
        grid+=`<line x1="${mL}" y1="${yy.toFixed(1)}" x2="${W-mR}" y2="${yy.toFixed(1)}" stroke="${ti?ti.color:'var(--line)'}" stroke-width="1" opacity="0.4"/>`; }
      const bLo=Math.max(lo,k*100), bHi=Math.min(hi,(k+1)*100);
      if(ti && (bHi-bLo)>16){ const ym=Y((bLo+bHi)/2);
        ylab+=`<text x="${W-mR+5}" y="${(ym+3).toFixed(1)}" class="rrtierlab" fill="${ti.color}">${esc(ti.name)}</text>`; }
    }
  }else{
    for(let g=0; g<=4; g++){ const val=lo+R*g/4, yy=Y(val);
      grid+=`<line x1="${mL}" y1="${yy.toFixed(1)}" x2="${W-mR}" y2="${yy.toFixed(1)}" stroke="var(--line)" stroke-width="1" opacity="${g===0?0.85:0.45}"/>`;
      ylab+=`<text x="${mL-8}" y="${(yy+3.5).toFixed(1)}" text-anchor="end" class="ax">${Math.round(val)}</text>`;
    }
  }

  const xticks=[...new Set(n<=1?[0]:[0,Math.floor((n-1)/2),n-1])];
  let xlab='';
  xticks.forEach(i=>{ const xx=X(i); const lbl=fmtDate(series[i]&&series[i].ts) || (i===n-1?'récent':`-${n-1-i}`);
    xlab+=`<text x="${xx.toFixed(1)}" y="${H-10}" text-anchor="middle" class="ax">${esc(lbl)}</text>`; });

  const line=pts.map((v,i)=>`${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const area=`${mL},${mT+ph} ${line} ${X(n-1).toFixed(1)},${mT+ph}`;
  let dots='';
  if(n<=50){ pts.forEach((v,i)=>{ const up=i===0?null:v-pts[i-1]; const col=up===null?'var(--amber)':(up>=0?'var(--win)':'var(--loss)');
    dots+=`<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="3" fill="${col}" stroke="#0a0f15" stroke-width="1.5"/>`; }); }

  // Métadonnées par point pour le survol.
  const meta=pts.map((v,i)=>{ const e=series[i]||{}; return { px:X(i), py:Y(v), v, change:num(e.change),
    tier:(e.tier&&e.tier.name)||'', when:fmtDate(e.ts), mode:chartMode }; });

  // Ligne de comparaison (second joueur), tracée sur toute la largeur par son index.
  const cmpLine = cmp ? cmp.pts.map((v,i)=>`${Xn(i,cmp.pts.length).toFixed(1)},${Y(v).toFixed(1)}`).join(' ') : '';
  const legend = cmp
    ? `<span class="rrleg"><i style="background:var(--amber)"></i>${esc(STATE.name)}</span><span class="rrleg"><i style="background:${compare.color}"></i>${esc(compare.label)}</span>`
    : '';

  const yTitle=`<text x="13" y="${mT+ph/2}" transform="rotate(-90 13 ${mT+ph/2})" text-anchor="middle" class="axt">${chartMode==='elo'?'elo (rang)':'RR cumulé'}</text>`;
  const xTitle=`<text x="${mL+pw/2}" y="${H-1}" text-anchor="middle" class="axt">parties classées (ancien → récent)</text>`;
  const pills=series.slice(-15).map(e=>{const c=num(e.change);return `<div class="hpill"><div class="m">${esc(fmtDate(e.ts))}</div><div class="v ${c>=0?'up':'dn'}">${c>=0?'+':''}${c}</div></div>`;}).join('');

  box.innerHTML=`
    <div class="rrcap mono">${n} partie${n>1?'s':''} classée${n>1?'s':''}${chartMode==='elo'?' · progression elo':' · RR cumulé'}${legend?' &nbsp; '+legend:''}</div>
    <div class="rrwrap" style="position:relative">
    <svg class="rrchart" width="100%" viewBox="0 0 ${W} ${H}" role="img" aria-label="Progression du RR">
      <defs><linearGradient id="rrfill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--amber)" stop-opacity="0.26"/><stop offset="100%" stop-color="var(--amber)" stop-opacity="0"/>
      </linearGradient></defs>
      ${grid}
      <polygon points="${area}" fill="url(#rrfill)"/>
      ${cmpLine?`<polyline points="${cmpLine}" fill="none" stroke="${compare.color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/>`:''}
      <polyline points="${line}" fill="none" stroke="var(--amber)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}${ylab}${xlab}${yTitle}${xTitle}
      <line class="rrguide" x1="0" y1="${mT}" x2="0" y2="${mT+ph}" stroke="var(--txt)" stroke-width="1" opacity="0" stroke-dasharray="3 3"/>
      <circle class="rrcursor" r="5" fill="var(--amber)" stroke="#0a0f15" stroke-width="2" opacity="0"/>
      <rect class="rrhit" x="${mL}" y="${mT}" width="${pw}" height="${ph}" fill="transparent" style="cursor:crosshair"/>
    </svg>
    <div class="rrtip" hidden></div>
    </div>
    <div class="hist">${pills}</div>`;

  wireCurveHover(box, meta, W, H);
}

// Survol du graphique RR : ligne-guide + point + infobulle (partie + RR).
function wireCurveHover(box, meta, W, H){
  if(!meta.length) return;
  const svg=box.querySelector('.rrchart'), hit=box.querySelector('.rrhit');
  const guide=box.querySelector('.rrguide'), cursor=box.querySelector('.rrcursor'), tip=box.querySelector('.rrtip');
  if(!svg||!hit||!tip) return;
  const move=e=>{
    const rect=svg.getBoundingClientRect(); if(!rect.width) return;
    const vx=(e.clientX-rect.left)*(W/rect.width);               // px souris -> coordonnées viewBox
    let best=meta[0];
    for(const m of meta){ if(Math.abs(m.px-vx)<Math.abs(best.px-vx)) best=m; }
    guide.setAttribute('x1',best.px); guide.setAttribute('x2',best.px); guide.setAttribute('opacity','0.5');
    cursor.setAttribute('cx',best.px); cursor.setAttribute('cy',best.py); cursor.setAttribute('opacity','1');
    const scale=rect.width/W;
    const c=best.change, sign=c>=0?'+':'';
    tip.innerHTML=`<b>${esc(best.when||'partie')}</b>`
      +`<span>${best.tier?esc(best.tier)+' · ':''}${Math.round(best.v)}${best.mode==='elo'?' elo':' RR'}</span>`
      +(best.change!=null && !isNaN(best.change)?`<span class="d ${c>=0?'up':'dn'}">${sign}${c} RR</span>`:'');
    tip.hidden=false;
    tip.style.left=(best.px*scale)+'px';
    tip.style.top=(best.py*scale)+'px';
  };
  const leave=()=>{ tip.hidden=true; guide.setAttribute('opacity','0'); cursor.setAttribute('opacity','0'); };
  hit.addEventListener('mousemove',move);
  hit.addEventListener('mouseleave',leave);
}

function filterByMode(matches, mode){
  const mainModes = ['competitive', 'unrated', 'deathmatch'];
  if(mode === 'all') return matches;
  if(mode === 'other') return matches.filter(m => !mainModes.includes((m.mode||'').toLowerCase()));
  return matches.filter(m => (m.mode||'').toLowerCase() === mode);
}

function groupStats(matches, keyFn){
  const groups = {};
  matches.forEach(M => {
    if(!M.me) return;
    const k = keyFn(M);
    if(!k || k === '—' || k === '?') return;
    if(!groups[k]) groups[k] = {count:0, wins:0, scoreSum:0, kSum:0, dSum:0};
    const g = groups[k];
    g.count++;
    if(M.result === 'w') g.wins++;
    g.scoreSum += M.me.score100;
    g.kSum += M.me.k;
    g.dSum += M.me.d;
  });
  return Object.entries(groups).map(([name, g]) => ({
    name,
    count: g.count,
    wr: Math.round(g.wins / g.count * 100),
    avgIndice: Math.round(g.scoreSum / g.count),
    kd: g.kSum / Math.max(g.dSum, 1),
  })).sort((a, b) => b.count - a.count || b.avgIndice - a.avgIndice);
}

function renderStatsTable(containerId, stats, nameLabel){
  if(!stats.length){
    $(containerId).innerHTML = `<div class="vh-line mono" style="padding:10px 4px;">Aucune donnée.</div>`;
    return;
  }
  $(containerId).innerHTML = `<table class="sb"><thead><tr>
      <th>${nameLabel}</th><th>N</th><th>WR</th><th>Indice</th><th>K/D</th>
    </tr></thead><tbody>${stats.map(s => {
      const t = tierOf(s.avgIndice);
      const wrColor = s.wr >= 50 ? 'var(--win)' : 'var(--loss)';
      return `<tr>
        <td><b>${esc(s.name)}</b></td>
        <td>${s.count}</td>
        <td style="color:${wrColor}"><b>${s.wr}%</b></td>
        <td class="scell" style="color:${t.c}">${s.avgIndice}</td>
        <td style="color:${sc((s.kd-0.6)*100)}">${s.kd.toFixed(2)}</td>
      </tr>`;
    }).join('')}</tbody></table>`;
}

function renderStatsCards(filtered){
  // Filtre par acte (comme le graphe) : ne garde que les parties de l'acte choisi.
  const rows = STATS_SEASON==='all' ? filtered : filtered.filter(M => M && M.season===STATS_SEASON);
  renderStatsTable('agentStats', groupStats(rows, M => M.me.agent), 'Agent');
  renderStatsTable('mapStats',   groupStats(rows, M => M.map),      'Map');
  markScrollable();
}

// (Re)remplit le menu Saison/Acte des stats à partir des actes présents dans les matchs.
function populateStatsSeasonFilter(){
  const sel=$('statsSeason'); if(!sel) return;
  const seasons=[...new Set((STATE.allMatches||[]).map(M=>M&&M.season).filter(Boolean))];
  if(!seasons.includes(STATS_SEASON)) STATS_SEASON='all';
  sel.innerHTML=['<option value="all">Toutes les saisons</option>']
    .concat(seasons.slice().reverse().map(sh=>`<option value="${esc(sh)}">${esc(seasonLabel(sh))}</option>`)).join('');
  sel.value=STATS_SEASON;
  sel.disabled = seasons.length===0;
}

// Peak (meilleur rang) et rang de fin par acte, calculés depuis la série RR accumulée.
function renderPeakActs(){
  const host=$('peakActs'); if(!host) return;
  const byAct={};
  (RR_FULL||[]).forEach(e=>{
    if(!e || !e.season || e.elo==null) return;
    const a = byAct[e.season] || (byAct[e.season]={ peak:-1, lastTs:-1, lastElo:null, n:0 });
    a.n++;
    if(e.elo>a.peak) a.peak=e.elo;
    if(e.ts>=a.lastTs){ a.lastTs=e.ts; a.lastElo=e.elo; }
  });
  const acts=Object.entries(byAct).sort((x,y)=> y[1].lastTs - x[1].lastTs); // acte le + récent d'abord
  if(!acts.length){ host.innerHTML=''; return; }
  host.innerHTML = `<div class="peak-title mono">Peak par acte <em>meilleur rang atteint</em></div>
    <div class="peak-grid">`+ acts.map(([sh,a])=>{
      const pk=tierFromElo(a.peak), fin=tierFromElo(a.lastElo);
      return `<div class="peak-cell">
        <div class="pa">${esc(seasonLabel(sh))}</div>
        <div class="pk">${pk&&pk.icon?`<img src="${esc(pk.icon)}" alt="" loading="lazy">`:''}<span>${esc(pk?pk.name:'—')}</span></div>
        <div class="pf mono">fin : ${esc(fin?fin.name:'—')} · ${a.n} partie${a.n>1?'s':''}</div>
      </div>`;
    }).join('') + `</div>`;
}

// Cellule "rang au moment de la partie + RR gagné/perdu" pour une ligne d'historique.
// Toujours rendue (même vide) pour garder l'alignement de la grille ; remplie quand
// la partie est présente dans l'historique MMR (ranked récent).
function rrCell(rr){
  if(!rr || rr.change==null) return '<div class="mrr"></div>';
  const c=rr.change, sign=c>0?'+':'';
  const icon=rr.icon?`<img class="mrr-icon" src="${esc(rr.icon)}" alt="${esc(rr.tierName||'')}" title="${esc(rr.tierName||'')}" loading="lazy">`:'';
  return `<div class="mrr" title="${esc(rr.tierName||'')}${rr.rr!=null?' · '+rr.rr+' RR':''}">
    ${icon}<span class="mrr-delta ${c>=0?'up':'dn'}">${sign}${c}</span>
  </div>`;
}

function renderList(){
  const filtered = filterByMode(STATE.matches, CURRENT_MODE);
  renderStatsCards(filtered);

  if(!filtered.length) {
     $('ml').innerHTML = '<div class="vh-line" style="padding:15px; text-align:center;">Aucun match trouvé pour ce mode.</div>';
     return;
  }

  $('ml').innerHTML = filtered.map((M) => {
    const i = STATE.matches.indexOf(M);
    const s = M.me, sc100 = s ? s.score100 : 0, t = tierOf(sc100), f = s ? flair(s.kd) : '';
    const splash = MAPS && MAPS[(M.map||'').toLowerCase()];
    const bg = splash ? `<div class="mbg" style="background-image:url('${splash}')"></div>` : '';
    return `<div class="mrow" data-idx="${i}">${bg}
      <div class="res ${M.result}">${M.result==='w'?'V':'D'}</div>
      <div class="minfo"><b>${esc(M.map)}</b><span>${esc(M.mode)} · ${s?esc(s.agent):'—'} · ${s?s.k+'/'+s.d+'/'+s.a:''} · ${relTime(M.started)}</span></div>
      <div class="mscore" style="color:${M.result==='w'?'var(--win)':'var(--loss)'}">${M.myScore}–${M.oppScore}</div>
      ${rrCell(M.rr)}
      <div class="scorebadge score-mini flair-${f} sd" style="--sc:${t.c}" data-sd="${i}" title="Voir le détail du calcul">${s?sc100:'—'}${flairHTML(f)}</div>
    </div>`;
  }).join('');
  
  // Selection auto du premier element filtré si existant
  if(filtered.length > 0) showMatch(STATE.matches.indexOf(filtered[0]));
}

// Ajoute un dégradé sur les conteneurs qui débordent vraiment horizontalement,
// pour signaler qu'on peut les faire défiler (surtout au doigt sur mobile).
function markScrollable(){
  ['sb','agentStats','mapStats'].forEach(id=>{
    const el=$(id); if(!el) return;
    el.classList.toggle('scrollx', el.scrollWidth > el.clientWidth + 2);
  });
}

// Rang ordinal en français : 1 -> "1er", sinon "Ne".
function ordinalFr(n){ return n===1 ? '1er' : n+'e'; }

/* ============ RAPPORTS DE SESSION (liste + modale) ============ */
const FR_DAYS=['dimanche','lundi','mardi','mercredi','jeudi','vendredi','samedi'];
const FR_MONTHS=['janv.','févr.','mars','avr.','mai','juin','juil.','août','sept.','oct.','nov.','déc.'];
const pad2=n=>String(n).padStart(2,'0');
function fmtDay(ms){ const d=new Date(ms); return `${FR_DAYS[d.getDay()]} ${d.getDate()} ${FR_MONTHS[d.getMonth()]}`; }
function fmtHM(ms){ const d=new Date(ms); return pad2(d.getHours())+':'+pad2(d.getMinutes()); }
function fmtDur(ms){
  const m=Math.max(1, Math.round(ms/60000)), h=Math.floor(m/60);
  return h ? `${h} h ${pad2(m%60)}` : `${m} min`;
}
// Une session peut traverser minuit (samedi 23h -> dimanche 2h) : on le dit
// explicitement plutôt que d'afficher un créneau "23:02 → 02:14" ambigu.
function sessionSpan(s){
  const a=new Date(s.startMs), b=new Date(s.endMs);
  const cross=a.getDate()!==b.getDate()||a.getMonth()!==b.getMonth();
  return `${fmtHM(s.startMs)} → ${fmtHM(s.endMs)}${cross?' <i>('+FR_DAYS[b.getDay()]+')</i>':''} · ${fmtDur(s.durationMs)}`;
}
const signed=v=>(v>0?'+':'')+v;

let SESSIONS=[];             // sessions du profil courant (plus récente en premier)
let SESSIONS_SHOWN=8;
let SESSIONS_ONLY_COMMON=false;

function compChip(comp){
  if(!comp) return '';
  const names=comp.mates.slice(0,3).map(m=>esc(m.name)).join(', ');
  const extra=comp.mates.length>3?` +${comp.mates.length-3}`:'';
  const label=comp.label+(comp.mixed?'*':'');
  return `<span class="sx-comp s${comp.dominant}">${esc(label)}${names?' · '+names+extra:''}</span>`;
}

function renderSessions(){
  const host=$('sxList'); if(!host) return;
  const selfKey=memberKey(STATE);
  let list=SESSIONS;
  if(SESSIONS_ONLY_COMMON) list=list.filter(s=>sessionComposition(s.matches, SQUAD_INDEX, selfKey).mates.length>0);
  if(!list.length){
    host.innerHTML=`<div class="md-empty">${SESSIONS_ONLY_COMMON
      ? 'Aucune session classée jouée avec un autre membre de la squad dans cet historique.'
      : 'Aucune partie classée dans l\'historique — les rapports de session ne prennent en compte que le mode classé.'}</div>`;
    const more=$('btnSxMore'); if(more) more.hidden=true;
    return;
  }
  const shown=list.slice(0, SESSIONS_SHOWN);
  host.innerHTML=shown.map(s=>{
    const st=sessionStats(s.matches);
    const comp=sessionComposition(s.matches, SQUAD_INDEX, selfKey);
    const t=tierOf(Math.round(st.index||0));
    const rr=st.rrNet!=null?`<span class="sx-rr ${st.rrNet>=0?'up':'dn'}">${signed(st.rrNet)} RR</span>`:'';
    return `<button class="sx-row" type="button" data-sx="${esc(s.key)}">
      <div class="sx-when"><b>${esc(fmtDay(s.startMs))}</b><span>${sessionSpan(s)}</span></div>
      <div class="sx-tags">${compChip(comp)}<span class="sx-n">${st.n} partie${st.n>1?'s':''}</span></div>
      <div class="sx-wl"><span class="sx-vd"><b class="w">${st.wins}</b>V · <b class="l">${st.losses}</b>D</span>${rr}</div>
      <div class="scorebadge score-mini" style="--sc:${t.c}">${Math.round(st.index||0)}</div>
    </button>`;
  }).join('');
  const more=$('btnSxMore');
  if(more){
    more.hidden=list.length<=SESSIONS_SHOWN;
    more.textContent=`Voir plus de sessions (${shown.length}/${list.length})`;
  }
}

// Tuile de bilan. `value` et `sub` peuvent contenir du HTML : c'est à l'appelant
// d'échapper ce qui vient des données.
function sxTile(label, value, sub, color){
  return `<div class="md-tile"><b${color?` style="color:${color}"`:''}>${value}</b>
    <span>${esc(label)}</span>${sub?`<span class="sx-tsub">${sub}</span>`:''}</div>`;
}
function pointList(items, kind){
  if(!items.length) return '';
  return `<ul class="sx-points ${kind}">${items.map(p=>
    `<li><b>${esc(p.title)}</b><span>${esc(p.text)}</span></li>`).join('')}</ul>`;
}

function openSessionReport(key){
  const s=SESSIONS.find(x=>x.key===key); if(!s) return;
  const modal=$('sessionModal'), body=$('sessionModalBody');
  if(!modal||!body) return;
  const selfKey=memberKey(STATE);
  const base=sessionBaseline(s, rankedOnly(STATE.allMatches));
  const A=analyzeSession(s, { baseline:base });
  const comp=sessionComposition(s.matches, SQUAD_INDEX, selfKey);
  const st=A.st, t=tierOf(Math.round(st.index||0));
  // Écart vs la référence long terme, affiché sous la valeur de la tuile.
  const dl=(v,b,dec)=>{
    if(v==null||b==null) return '';
    const x=v-b, s=dec?Math.abs(x).toFixed(2):String(Math.abs(Math.round(x)));
    // Un écart qui s'arrondit à zéro s'affiche "= habitude", jamais "-0.00".
    if(Number(s)===0) return '<em class="flat">= habitude</em>';
    return `<em class="${x>0?'up':'dn'}">${x>0?'+':'−'}${s} vs habitude</em>`;
  };

  // Mini-graphe : indice de chaque partie de la session, dans l'ordre.
  const bars=s.matches.filter(M=>M.me).map((M,i)=>{
    const v=M.me.score100, h=Math.max(6, Math.round(v));
    return `<div class="sx-bar ${M.result}" style="height:${h}%" title="${esc(M.map)} · ${esc(M.mode)} · indice ${v}${M.rr&&M.rr.change!=null?' · '+signed(M.rr.change)+' RR':''}"><i>${v}</i></div>`;
  }).join('');

  const squad=sessionSquadReport(s, SQUAD_INDEX, selfKey);
  const common=squad.length>1 ? `
    <div class="md-sec">Rapport commun · ${squad.length} membres COSMO</div>
    <div class="sx-tablewrap"><table class="sb"><thead><tr>
      <th>Joueur</th><th>N</th><th>V-D</th><th>Indice</th><th>ACS</th><th>K/D</th><th>RR</th>
    </tr></thead><tbody>${squad.map(r=>{
      const rt=tierOf(Math.round(r.st.index||0));
      return `<tr${r.self?' class="sx-self"':''}>
        <td><b>${esc(r.name)}</b>${r.self?' <em>(toi)</em>':''}</td>
        <td>${r.n}</td>
        <td><b class="w">${r.st.wins}</b>-<b class="l">${r.st.losses}</b></td>
        <td class="scell" style="color:${rt.c}">${Math.round(r.st.index||0)}</td>
        <td>${Math.round(r.st.acs||0)}</td>
        <td>${(r.st.kd||0).toFixed(2)}</td>
        <td class="${(r.st.rrNet||0)>=0?'up':'dn'}">${r.st.rrNet!=null?signed(r.st.rrNet):'—'}</td>
      </tr>`;
    }).join('')}</tbody></table></div>
    <div class="md-none">Les membres listés sont ceux qui étaient dans TON équipe sur au moins une partie de la session. Leurs chiffres viennent de leur propre historique.</div>`
    : `<div class="md-sec">Rapport commun</div>
       <div class="md-empty">Session jouée sans autre membre de la squad — rien à comparer en commun.</div>`;

  const partyNote = comp.partyKnown && comp.partyExtra>0
    ? `<div class="md-none">Party détectée jusqu'à ${comp.partyMax} joueurs, dont ${comp.partyExtra} hors squad COSMO (info disponible sur ${comp.partyKnown} partie${comp.partyKnown>1?'s':''} au format complet).</div>` : '';
  const mixNote = comp.mixed
    ? `<div class="md-none">Composition variable dans la session : ${Object.keys(comp.bySize).sort((a,b)=>a-b).map(k=>`${comp.bySize[k]}× ${STACK_LABEL[k]||k+'-stack'}`).join(', ')}.</div>` : '';

  body.innerHTML=`
    <div class="sx-head">
      <div>
        <h3>${esc(fmtDay(s.startMs))}</h3>
        <div class="sx-sub">${sessionSpan(s)}</div>
        <div class="sx-tags">${compChip(comp)}</div>
      </div>
      <div class="sx-verdict ${A.verdict.tone}">
        <div class="scorebadge score-hero" style="--sc:${t.c}">${Math.round(st.index||0)}<span class="out">/100</span></div>
        <div><div class="sx-word">${esc(A.verdict.word)}</div><div class="sx-line">${esc(A.verdict.line)}</div></div>
      </div>
    </div>
    ${mixNote}${partyNote}

    <div class="md-sec">Bilan de la session</div>
    <div class="md-tiles">
      ${sxTile('Parties', st.n, `${st.roundsWon}–${st.roundsLost} en rounds`)}
      ${sxTile('Bilan', `<i class="wv">${st.wins}</i>–<i class="lv">${st.losses}</i>`, st.winrate!=null?Math.round(st.winrate)+'% de victoires':'')}
      ${sxTile('RR', st.rrNet!=null?signed(st.rrNet):'—', st.rrGames?`sur ${st.rrGames} classée${st.rrGames>1?'s':''}`:'aucune classée', st.rrNet!=null?(st.rrNet>=0?'var(--win)':'var(--loss)'):'')}
      ${sxTile('Indice moyen', Math.round(st.index||0), esc(t.label)+dl(st.index, base&&base.index), t.c)}
      ${sxTile('ACS', Math.round(st.acs||0), dl(st.acs, base&&base.acs))}
      ${sxTile('K/D', (st.kd||0).toFixed(2), `${st.k}/${st.d}/${st.a}`+dl(st.kd, base&&base.kd, true))}
      ${sxTile('ADR', Math.round(st.adr||0), dl(st.adr, base&&base.adr))}
      ${sxTile('HS%', Math.round(st.hs||0)+'%', dl(st.hs, base&&base.hs))}
      ${st.kast!=null?sxTile('KAST', Math.round(st.kast)+'%', dl(st.kast, base&&base.kast)):''}
    </div>
    ${base?`<div class="md-none">Comparaisons faites avec tes ${base.n} autres parties dans les mêmes modes (indice moyen ${Math.round(base.index)}, ${Math.round(base.acs)} ACS, K/D ${base.kd.toFixed(2)}).</div>`:''}

    <div class="md-sec">Déroulé de la session</div>
    <div class="sx-chart">${bars||'<div class="md-empty">—</div>'}</div>
    <div class="md-legend"><span class="sx-dot w"></span> victoire <span class="sx-dot l"></span> défaite · hauteur = indice COSMO de la partie
      ${A.trend?` · première moitié ${A.trend.first} → seconde moitié ${A.trend.last} (${signed(A.trend.delta)})`:''}</div>

    ${A.good.length?`<div class="md-sec">Ce qui allait</div>${pointList(A.good,'good')}`:''}
    ${A.bad.length?`<div class="md-sec">Ce qui n'allait pas</div>${pointList(A.bad,'bad')}`:''}
    ${A.tips.length?`<div class="md-sec">À améliorer</div>${pointList(A.tips,'tip')}`:''}
    ${(!A.good.length&&!A.bad.length)?`<div class="md-empty">Session parfaitement dans tes standards : rien ne ressort ni en bien ni en mal.</div>`:''}

    ${common}

    <div class="md-sec">Les parties</div>
    <div class="sx-tablewrap"><table class="sb"><thead><tr>
      <th>#</th><th>Map</th><th>Agent</th><th>Score</th><th>K/D/A</th><th>ACS</th><th>Indice</th><th>RR</th>
    </tr></thead><tbody>${s.matches.filter(M=>M.me).map((M,i)=>{
      const mt=tierOf(M.me.score100);
      return `<tr>
        <td>${i+1}</td>
        <td><b>${esc(M.map)}</b><br><em class="sx-mode">${esc(M.mode)}</em></td>
        <td>${esc(M.me.agent)}</td>
        <td class="${M.result==='w'?'w':'l'}"><b>${M.myScore}–${M.oppScore}</b>${M.forfeit?' <em>ff</em>':''}</td>
        <td>${M.me.k}/${M.me.d}/${M.me.a}</td>
        <td>${M.me.acs}</td>
        <td class="scell" style="color:${mt.c}">${M.me.score100}</td>
        <td class="${M.rr&&M.rr.change>=0?'up':'dn'}">${M.rr&&M.rr.change!=null?signed(M.rr.change):'—'}</td>
      </tr>`;
    }).join('')}</tbody></table></div>`;

  modal.hidden=false;
  document.body.style.overflow='hidden';
}
function closeSessionReport(){
  const m=$('sessionModal'); if(m) m.hidden=true;
  document.body.style.overflow='';
}

// Recalcule les sessions du profil courant. Les historiques de la squad sont
// chargés en tâche de fond (blobs uniquement) puis le rendu est rafraîchi :
// la liste s'affiche tout de suite, les compositions arrivent juste après.
function refreshSessions(){
  SESSIONS=buildSessions(rankedOnly(STATE.allMatches));
  SESSIONS_SHOWN=8;
  // Les parties au format complet donnent déjà la composition (avec les pseudos
  // actuels) : on indexe tout de suite, sans attendre les blobs.
  SQUAD_INDEX=SQUAD_INDEX||{};
  indexSquadFromFullMatches(STATE.allMatches, SQUAD_INDEX);
  renderSessions();
  if(!SQUAD_BLOBS_DONE) ensureSquadHistories().then(()=>renderSessions()).catch(()=>{});
}

/* ============ DÉTAIL DU CALCUL DE L'INDICE (modale) ============ */
let SB_LINES=[];   // lignes du scoreboard affiché (pour ouvrir le détail au clic)

function openScoreDetail(line, head){
  const modal=$('scoreModal'), body=$('scoreModalBody');
  if(!modal||!body||!line||!line.detail) return;
  const d=line.detail, t=tierOf(d.score);
  const rows=d.parts.map(p=>`
    <tr>
      <td class="sdk">${esc(p.label)}<span>${esc(p.hint)}</span></td>
      <td class="sdraw">${esc(p.fmt(p.raw))}</td>
      <td class="sdbar"><i style="width:${clamp(p.n).toFixed(0)}%;background:${sc(p.n)}"></i><b>${Math.round(p.n)}</b></td>
      <td class="sdw">×${Math.round(p.w*100)}%</td>
      <td class="sdc">${(p.n*p.w).toFixed(1)}</td>
    </tr>`).join('');
  const adjRows=d.adj.map(a=>`
    <tr class="sdadj">
      <td colspan="4">${esc(a.label)}${a.note?`<span>${esc(a.note)}</span>`:''}</td>
      <td class="sdc ${a.delta>=0?'up':'dn'}">${a.delta>=0?'+':''}${a.delta.toFixed(1)}</td>
    </tr>`).join('');

  body.innerHTML=`
    <div class="sd-head">
      <div class="scorebadge score-hero" style="--sc:${t.c}">${d.score}<span class="out">/100</span></div>
      <div>
        <div class="sd-tier" style="color:${t.c}">${t.t} · ${esc(t.label)}</div>
        <h3>${esc((head&&head.title)||"Détail de l'indice COSMO")}</h3>
        <div class="sd-sub mono">${esc((head&&head.sub)||'')}</div>
      </div>
    </div>
    <table class="sd-table">
      <thead><tr><th>Critère</th><th>Valeur</th><th>Note /100</th><th>Poids</th><th>Points</th></tr></thead>
      <tbody>
        ${rows}
        <tr class="sdsum"><td colspan="4">Sous-total (moyenne pondérée)</td><td class="sdc">${d.base.toFixed(1)}</td></tr>
        ${adjRows}
        <tr class="sdtot"><td colspan="4">Indice COSMO</td><td class="sdc" style="color:${t.c}">${d.score}</td></tr>
      </tbody>
    </table>
    <div class="sd-note mono">Chaque critère est noté sur une échelle interne où une valeur <b>moyenne en ranked vaut 50</b>.
    La note finale est ensuite <b>mise à l'échelle</b> pour être comparable aux autres trackers — l'ordre des parties reste identique.${
      d.forfeit?'<br>⚠️ Partie écourtée par forfait : la note est rapprochée de la moyenne (trop peu de rounds pour juger).':''}</div>`;
  modal.hidden=false;
}
function closeScoreDetail(){ const m=$('scoreModal'); if(m) m.hidden=true; }

/* ============ MODALE : DÉTAIL COMPLET D'UNE PARTIE ============ */
const RES_ICON = { Elimination:'⚔', Detonate:'💥', Defuse:'✂', 'Round timer expired':'⏱', Surrendered:'🏳' };
const CEREMONY_FR = { Ace:'ACE', TeamAce:'TEAM ACE', Clutch:'CLUTCH', Flawless:'FLAWLESS', Closer:'CLOSER', Thrifty:'THRIFTY' };
let FACTS_CUR = null;   // facts de la partie ouverte (pour déplier un round)

function roundChip(r, sel){
  const cer = CEREMONY_FR[r.ceremony] ? `<span class="rc-cer">${esc(CEREMONY_FR[r.ceremony])}</span>` : '';
  const spike = r.plant ? `<span class="rc-sp${r.plant.mine?' me':''}" title="Spike posée site ${esc(r.plant.site)} par ${esc(r.plant.by)}">◆</span>` : '';
  const df = r.defuse ? `<span class="rc-df${r.defuse.mine?' me':''}" title="Désamorcée par ${esc(r.defuse.by)}">✂</span>` : '';
  return `<button class="rchip ${r.won?'w':'l'}${sel?' sel':''}" data-round="${r.n}" title="${esc(r.result)}">
    <span class="rc-n">${r.n}</span>
    <span class="rc-k">${r.myKills}<small>k</small></span>
    <span class="rc-i">${RES_ICON[r.result]||'•'}${spike}${df}</span>
    ${cer}
  </button>`;
}

function renderRoundDetail(n){
  const host=$('mdRound'); if(!host||!FACTS_CUR) return;
  const r=FACTS_CUR.timeline.find(x=>x.n===n); if(!r) return;
  document.querySelectorAll('#mdTimeline .rchip').forEach(b=>b.classList.toggle('sel', +b.dataset.round===n));
  const secs = ms => (ms/1000).toFixed(0)+'s';
  const kills = r.kills.length
    ? r.kills.map(k=>`<div class="mdk${k.mine?' mine':''}${k.onMe?' onme':''}">
        <span class="t">${esc(secs(k.t))}</span>
        <span class="p">${esc(k.killer)}</span><span class="w">${esc(k.weapon||'—')}</span><span class="p">${esc(k.victim)}</span>
        ${k.assists.length?`<span class="a">+ ${esc(k.assists.join(', '))}</span>`:''}
      </div>`).join('')
    : `<div class="mdk"><span class="a">Aucune élimination sur ce round.</span></div>`;
  host.innerHTML=`
    <div class="md-rhead">
      <b>Round ${r.n}</b>
      <span class="${r.won?'up':'dn'}">${r.won?'Gagné':'Perdu'}</span>
      <span class="mono">${esc(r.result)}</span>
      ${CEREMONY_FR[r.ceremony]?`<span class="rc-cer">${esc(CEREMONY_FR[r.ceremony])}</span>`:''}
    </div>
    <div class="md-rmeta mono">
      ${r.myKills} kill${r.myKills>1?'s':''} · ${r.myDmg} dégâts · ${r.myScore} score
      · achat ${r.loadout} cr${r.weapon?` (${esc(r.weapon)}${r.armor?' + '+esc(r.armor):''})`:''}
      ${r.plant?` · spike posée site ${esc(r.plant.site)} par ${esc(r.plant.by)}`:''}
      ${r.defuse?` · désamorcée par ${esc(r.defuse.by)}`:''}
      ${r.afk?' · ⚠️ AFK':''}
    </div>
    <div class="md-kills">${kills}</div>`;
}

function openMatchFacts(i){
  const M=STATE.matches[i]; if(!M) return;
  const modal=$('matchModal'), body=$('matchModalBody'); if(!modal||!body) return;
  const f=M.facts;
  if(!f){
    body.innerHTML=`<div class="md-empty mono">Détail round par round indisponible pour cette partie.<br>
      Ouvre-la dans la liste (le détail complet se charge automatiquement), puis réessaie.</div>`;
    modal.hidden=false; return;
  }
  FACTS_CUR=f;
  const t=tierOf(M.me?M.me.score100:0);
  const mk=Object.keys(f.multi).sort();
  const tile=(v,l,cls='')=>`<div class="md-tile ${cls}"><b>${v}</b><span>${esc(l)}</span></div>`;
  const maxD=Math.max(1,...f.duels.map(d=>Math.max(d.dealt,d.received)));

  body.innerHTML=`
    <div class="sd-head">
      <div class="scorebadge score-hero" style="--sc:${t.c}">${M.me?M.me.score100:'—'}<span class="out">/100</span></div>
      <div>
        <div class="sd-tier" style="color:${M.result==='w'?'var(--win)':'var(--loss)'}">${M.result==='w'?'VICTOIRE':'DÉFAITE'} ${M.myScore}–${M.oppScore}</div>
        <h3>${esc(M.map)}</h3>
        <div class="sd-sub mono">${esc(M.mode)}${M.me?' · '+esc(M.me.agent):''} · ${esc(relTime(M.started))}</div>
      </div>
    </div>

    <div class="md-sec">Timeline <em>clique un round pour son détail</em></div>
    <div class="md-timeline" id="mdTimeline">${f.timeline.map(r=>roundChip(r,r.n===1)).join('')}</div>
    <div class="md-round" id="mdRound"></div>

    <div class="md-sec">Faits d'armes</div>
    <div class="md-tiles">
      ${tile(f.firstBloods,'first bloods','good')}
      ${tile(f.firstDeaths,'first deaths','bad')}
      ${tile(mk.length?mk.map(k=>`${f.multi[k]}×${k}k`).join(' '):'—','multikills')}
      ${tile(f.clutches,f.clutchKinds.length?'clutches ('+f.clutchKinds.join(', ')+')':'clutches','good')}
      ${tile(f.plants,'spikes posées')}
      ${tile(f.defuses,'désamorçages')}
    </div>

    <div class="md-sec">Armes &amp; précision <em>${f.precision.total} tirs touchés</em></div>
    <div class="md-wp">
      <div class="md-weapons">
        ${f.weapons.length ? f.weapons.map(w=>`<div class="md-w">
            <span class="wn">${esc(w.name)}</span>
            <span class="wb"><i style="width:${(w.kills/Math.max(1,f.weapons[0].kills)*100).toFixed(0)}%"></i></span>
            <span class="wk">${w.kills}</span>
          </div>`).join('')
          : `<div class="md-none mono">Aucune élimination sur cette partie.</div>`}
        <div class="md-none mono">kills par arme · le HS% par arme n'est pas fourni par l'API</div>
      </div>
      <div class="md-prec">
        <div class="mp-big"><b>${f.precision.hsPct}%</b><span>headshots</span></div>
        ${f.precision.total ? `<div class="mp-bar">
          <i class="h" style="width:${(f.precision.head/f.precision.total*100).toFixed(1)}%"></i>
          <i class="b" style="width:${(f.precision.body/f.precision.total*100).toFixed(1)}%"></i>
          <i class="l" style="width:${(f.precision.leg/f.precision.total*100).toFixed(1)}%"></i>
        </div>
        <div class="mp-leg mono"><span><i class="h"></i>tête ${f.precision.head}</span><span><i class="b"></i>corps ${f.precision.body}</span><span><i class="l"></i>jambes ${f.precision.leg}</span></div>` : ''}
      </div>
    </div>

    <div class="md-sec">Économie &amp; utilitaire</div>
    <div class="md-tiles">
      ${tile(f.economy.avgLoadout+' cr','achat moyen')}
      ${tile(f.economy.avgSpent+' cr','dépensé / round')}
      ${['eco','half','full'].map(b=>{
        const x=f.economy.buckets[b];
        return tile(x.n?`${x.n}<small> · ${Math.round(x.won/x.n*100)}%</small>`:'0', x.label+(x.n?' · gagnés':''));
      }).join('')}
    </div>
    <div class="md-tiles" style="margin-top:8px">
      ${tile(f.abilities.grenade,'grenade')}
      ${tile(f.abilities.a1,'compétence 1')}
      ${tile(f.abilities.a2,'compétence 2')}
      ${tile(f.abilities.ult,'ultimes','good')}
      ${tile(f.abilities.perRound,'compétences / round')}
    </div>

    <div class="md-sec">Duels <em>dégâts infligés / subis face à chaque adversaire</em></div>
    <div class="md-duels">
      ${f.duels.map(d=>`<div class="md-duel">
        <span class="dn">${esc(d.name)}</span>
        <span class="db"><i class="out" style="width:${(d.dealt/maxD*100).toFixed(0)}%"></i><b>${d.dealt}</b></span>
        <span class="db"><i class="in" style="width:${(d.received/maxD*100).toFixed(0)}%"></i><b>${d.received}</b></span>
      </div>`).join('')}
      <div class="md-legend mono"><span class="k out"></span>infligés <span class="k in"></span>subis</div>
    </div>

    <div class="md-sec">Lobby <em>rangs et groupes détectés</em></div>
    <div class="md-lobby">
      ${['nous','eux'].map(side=>{
        const rows=f.lobby.filter(p=>(side==='nous')===p.mine);
        return `<div class="md-team"><div class="mt-h ${side==='nous'?'blue':'red'}">${side==='nous'?'Ton équipe':'Adverse'}</div>
          ${rows.map(p=>`<div class="mt-r${p.isMe?' me':''}">
            <span class="mt-n">${esc(p.name)}<small>#${esc(p.tag)}</small></span>
            <span class="mt-a mono">${esc(p.agent||'')}</span>
            <span class="mt-t mono">${esc(p.tier||'—')}</span>
            ${p.group?`<span class="mt-g" title="A queue avec le groupe ${p.group}">G${p.group}</span>`:'<span class="mt-g none"></span>'}
          </div>`).join('')}</div>`;
      }).join('')}
    </div>`;
  renderRoundDetail(1);
  modal.hidden=false;
}
function closeMatchFacts(){ const m=$('matchModal'); if(m) m.hidden=true; }

// Ouvre le détail pour une partie de la liste (le joueur du profil).
function openMatchScore(i){
  const M=STATE.matches[i]; if(!M||!M.me) return;
  openScoreDetail(M.me, {
    title:`${M.map} · ${M.result==='w'?'Victoire':'Défaite'} ${M.myScore}–${M.oppScore}`,
    sub:`${M.mode} · ${M.me.agent} · ${M.me.k}/${M.me.d}/${M.me.a} · ${relTime(M.started)}` });
}

// Charge à la demande le détail complet d'un match (tous les joueurs) via match-by-id.
// Sert aux parties venues du blob (format compact), pour reconstituer le scoreboard.
async function fetchMatchDetail(id){
  if(!id || (id in MATCH_DETAILS)) return MATCH_DETAILS[id];
  MATCH_DETAILS[id]=null; // marque "en cours" pour éviter les appels en double
  try{
    const r=await api(`/valorant/v4/match/${REGION()}/pc/${enc(id)}`);
    const raw=(r&&r.data)||r;
    // On garde le match BRUT : il est re-normalisé selon le profil affiché (un même
    // match peut figurer dans l'historique de deux membres -> "ta team" diffère).
    MATCH_DETAILS[id]=(raw && Array.isArray(raw.players) && raw.players.length>1) ? raw : null;
  }catch(e){ MATCH_DETAILS[id]=null; }
  return MATCH_DETAILS[id];
}

function showMatch(i){
  document.querySelectorAll('.mrow').forEach(el=>el.classList.toggle('sel', +el.dataset.idx === i));
  const M=STATE.matches[i];
  if(!M) return;
  SELECTED_IDX=i;
  // Pour une partie du blob (compacte), on normalise le détail complet (s'il est
  // chargé) selon le profil courant, sinon on garde la version compacte.
  const rawDetail=(M.partial && M.id && MATCH_DETAILS[M.id]) ? MATCH_DETAILS[M.id] : null;
  const detail = rawDetail ? normMatch(rawDetail) : M;
  const partialNow = !!M.partial && !rawDetail;
  $('sbsub').textContent=`${detail.map} · ${detail.result==='w'?'victoire':'défaite'} ${detail.myScore}–${detail.oppScore}`;
  // On réutilise les lignes déjà notées (même indice que dans la liste des matchs).
  const all=detail.lines || applyScores(detail.players.map(p=>rawLine(p,detail.rounds)),
    {rounds:detail.rounds, forfeit:detail.forfeit});   // detail.lines porte déjà le KAST
  // Classement par ACS décroissant sur TOUS les joueurs de la partie (1er, 2e, …).
  [...all].sort((a,b)=>b.acs-a.acs).forEach((s,idx)=>{ s.acsRank=idx+1; });
  SB_LINES=all;   // pour ouvrir le détail du calcul au clic sur un indice
  const blue=all.filter(s=>s.team===detail.myTeamId), red=all.filter(s=>s.team!==detail.myTeamId);
  const sbRows = rows => rows.map(s=>{
    const me=s.name.toLowerCase()===STATE.name.toLowerCase()&&s.tag.toLowerCase()===STATE.tag.toLowerCase();
    const t=tierOf(s.score100);
    const initials=esc((s.agent||'?').slice(0,2));
    // Tête de l'agent avec repli en cascade : UUID de la partie -> table nom->icône
    // -> initiales. L'onerror passe au repli suivant au lieu d'abandonner direct.
    const idIcon=s.agentId ? `${MEDIA}/${s.agentId}/displayicon.png` : '';
    const nameIcon=(AGENTS && AGENTS[(s.agent||'').toLowerCase()]) || '';
    const primary=idIcon||nameIcon;
    const fallback=(idIcon && nameIcon && nameIcon!==idIcon) ? nameIcon : '';
    const agCell=primary
      ? `<div class="ag" title="${esc(s.agent)}"><img src="${esc(primary)}" data-fb="${esc(fallback)}" alt="${esc(s.agent)}" loading="lazy" onerror="var f=this.dataset.fb; if(f){this.dataset.fb='';this.src=f;} else {this.closest('.ag').classList.add('noimg');this.remove();}"><span>${initials}</span></div>`
      : `<div class="ag noimg" title="${esc(s.agent)}"><span>${initials}</span></div>`;
    const posCell = partialNow
      ? `<td class="pos">—</td>`
      : `<td class="pos${s.acsRank===1?' top':''}">${ordinalFr(s.acsRank)}</td>`;
    return `<tr class="${me?'me':''}">
      ${posCell}
      <td class="pcol"><div class="agent">${agCell}
        <div class="pn"><b>${esc(s.name)}</b> <span>#${esc(s.tag)}</span></div></div></td>
      <td class="scell sd" style="color:${t.c}" data-sb="${all.indexOf(s)}" title="Voir le détail du calcul">${s.score100}</td>
      <td style="color:${sc((s.acs-130)/2)}"><b>${s.acs}</b></td>
      <td><b style="color:${sc((s.kd-0.6)*100)}">${s.k}</b>/${s.d}/${s.a}</td>
      <td style="color:${s.k-s.d>=0?'var(--win)':'var(--loss)'}">${(s.k-s.d>0?'+':'')}${s.k-s.d}</td>
      <td style="color:${sc((s.hs-10)*4)}">${s.hs}%</td>
      <td style="color:${sc(s.adr-90)}">${s.adr}</td></tr>`;
  }).join('');
  
  // Note pour les parties du blob : détail en cours de chargement ou indisponible.
  let note='';
  if(partialNow){
    note = (M.id in MATCH_DETAILS && MATCH_DETAILS[M.id]===null && !DETAIL_PENDING[M.id])
      ? `<div class="sbnote">Détail complet indisponible pour cette partie (trop ancienne ou hors API).</div>`
      : `<div class="sbnote">Chargement du scoreboard complet…</div>`;
  }

  $('sb').innerHTML=`<table class="sb"><thead><tr><th>#</th><th class="pcol">Joueur</th><th>Indice</th><th>ACS</th><th>K/D/A</th><th>+/–</th><th>HS%</th><th>ADR</th></tr></thead>
    <tbody><tr><td colspan="8" class="teamlabel blue">Ta team — ${detail.myScore} rounds</td></tr>${sbRows(blue)}
    <tr><td colspan="8" class="teamlabel red">Adverse — ${detail.oppScore} rounds</td></tr>${sbRows(red)}</tbody></table>${note}`;
  markScrollable();

  // Charge le détail complet à la demande, puis ré-affiche si cette partie est toujours ouverte.
  if(M.partial && M.id && !(M.id in MATCH_DETAILS)){
    DETAIL_PENDING[M.id]=true;
    fetchMatchDetail(M.id).finally(()=>{
      delete DETAIL_PENDING[M.id];
      // Le détail complet apporte le KAST : on met à jour l'indice de cette partie
      // pour que la liste et le scoreboard affichent la même note.
      const raw=MATCH_DETAILS[M.id];
      if(raw){
        const full=normMatch(raw);
        if(full && full.me){ M.me=Object.assign(full.me,{placement:M.me&&M.me.placement}); M.lines=full.lines; M.partial=false; }
      }
      if(SELECTED_IDX===i){ renderList(); showMatch(i); }
    });
  }
}

function openProfile(idx){
  const m=ROSTER[idx];
  if(!m) return;
  STATE={puuid:null,allMatches:[],matches:[],name:m.name,tag:m.tag};
  PROFILE_SHOWN = FRESH_SIZE;

  const bustSrc = m.customImg || `${MEDIA}/${m.uuid}/fullportrait.png`; // bustportrait.png n'existe pas (404) chez valorant-api

  $('phead').innerHTML=`
    <div class="pbust ${m.customImg?'custom':''}" style="--pc:${m.color}">
      <img src="${bustSrc}" alt="${esc(m.agent)}">
      <div class="mg">${esc(m.agent.slice(0,2))}</div>
    </div>
    <div><div class="eb" style="color:${m.color}">${m.agent} · ${m.role}</div><h1>${m.name}<b>#${m.tag}</b></h1></div>
    <div class="ptools"><button class="btn refresh">Rafraîchir</button></div>`;

  const bust=$('phead').querySelector('.pbust img');
  if(bust){const pb=bust.closest('.pbust');const f=()=>{bust.style.display='none';if(pb)pb.classList.add('noimg');};bust.addEventListener('error',f);if(bust.complete&&bust.naturalWidth===0)f();}
  $('home').hidden=true; $('tribunal').hidden=true; $('leaderboard').hidden=true; $('profile').hidden=false; window.scrollTo(0,0);

  CURRENT_MODE = 'all';
  document.querySelectorAll('#modeTabs button').forEach(x => x.classList.toggle('on', x.dataset.mode === 'all'));
  loadProfile();
}

async function loadProfile(){
  $('app').hidden=true; status('load','Récupération des données HenrikDev…');
  const region=REGION(), n=enc(STATE.name), t=enc(STATE.tag);
  try{
    const acc=await api(`/valorant/v2/account/${n}/${t}`);
    STATE.puuid=acc.data&&acc.data.puuid;
    const [mmrR,histR,matchR,blobR,rrBlobR]=await Promise.allSettled([
      api(`/valorant/v3/mmr/${region}/pc/${n}/${t}`),
      api(`/valorant/v2/mmr-history/${region}/pc/${n}/${t}`),
      api(`/valorant/v4/matches/${region}/pc/${n}/${t}?size=${FRESH_SIZE}`), // données fraîches du moment
      fetchHistorique(STATE.name, STATE.tag),                                 // historique matchs accumulé (blob)
      fetchRRHistory(STATE.name, STATE.tag)                                   // progression RR accumulée (blob)
    ]);
    // Caches médias : têtes d'agents (scoreboard), icônes de rang et fonds de map
    await Promise.all([ensureTiers(), ensureAgents(), ensureMaps()]);

    let mmr={tier:'',rr:null,elo:null,peak:'',icon:null};
    if(mmrR.status==='fulfilled'){ const d=mmrR.value.data||{}; const cur=d.current||d.current_data||{};
      const tierName=(cur.tier&&cur.tier.name)||cur.currenttierpatched||'';
      mmr={tier:tierName, rr:(cur.rr!=null?cur.rr:cur.ranking_in_tier), elo:cur.elo, icon:rankIcon(cur,tierName),
           peak:(d.peak&&d.peak.tier&&d.peak.tier.name)||(d.highest_rank&&d.highest_rank.patched_tier)||''}; }

    // Série RR = live mmr-history + blob accumulé (long terme), fusionnés par match_id/date.
    let liveHist=[]; if(histR.status==='fulfilled'){ const d=histR.value.data; liveHist=(d&&d.history)||d||[]; }
    const rrBlob = rrBlobR.status==='fulfilled' ? (rrBlobR.value||[]) : [];
    const rrSeries = mergeRRclient(rrBlob, (liveHist||[]).map(normRRclient));

    // Fusion : matches v4 frais + blob accumulé, dédoublonnés par matchid, triés du + récent au + ancien.
    const fresh=matchR.status==='fulfilled'?(matchR.value.data||[]):[];
    const blob =blobR.status==='fulfilled'?(blobR.value||[]):[];
    STATE.allMatches=combineMatches(fresh, blob).map(m=>normalizeAny(m)).filter(Boolean);
    // Join RR/rang + acte par match_id (depuis la série RR accumulée -> long terme).
    const rrIdx=rrIndexFromSeries(rrSeries);
    STATE.allMatches.forEach(M=>{ if(M&&M.id&&rrIdx[M.id]){ M.rr=rrIdx[M.id]; M.season=rrIdx[M.id].season; } });
    PROFILE_SHOWN=Math.min(FRESH_SIZE, STATE.allMatches.length);
    STATE.matches=STATE.allMatches.slice(0, PROFILE_SHOWN);

    // L'indice COSMO général reste sur les 8 dernières
    const scored=STATE.matches.slice(0,8).filter(M=>M.me);
    const overall=scored.length?Math.round(scored.reduce((s,M)=>s+M.me.score100,0)/scored.length):0;
    
    RR_FULL = rrSeries;
    ELO_TIER_OFFSET = computeEloTierOffset(rrSeries);   // aligne les lignes de paliers sur les vrais rangs
    populateSeasonFilter();
    populateStatsSeasonFilter();
    populateCompareFilter();
    renderRank(mmr,overall); renderCurvePeriod(); renderPeakActs(); refreshSessions();
    if(STATE.matches.length){ 
       const s=STATE.matches[0].me;
       if(s){
         const tc=tierOf(s.score100);
         $('vcard').style.setProperty('--sc', tc.c);
         $('verdict').innerHTML = `
          <div class="vh-grid">
            <div class="vh-score"><div class="scorebadge score-hero flair-${flair(s.kd)} sd" id="heroScore" title="Voir le détail du calcul" style="--sc:${tc.c}">${s.score100}<span class="out">/100</span>${flairHTML(flair(s.kd))}</div><div class="sd-cta mono">détail du calcul</div></div>
            <div class="vh-body">
              <div class="vh-top"><span class="reschip ${STATE.matches[0].result}">${STATE.matches[0].result==='w'?'VICTOIRE':'DÉFAITE'}</span>
                <span class="map">${esc(STATE.matches[0].map)}</span><span class="mode">${esc(STATE.matches[0].mode)}</span></div>
              <div class="vh-line">${esc(s.agent)} · <b>${s.k}/${s.d}/${s.a}</b> · ${s.acs} ACS · ${s.hs}% HS</div>
            </div>
          </div>`;
       }
       renderList();
    } else {
       $('verdict').innerHTML='<div class="vh-line">Aucun match récent.</div>';
    }
    clearStatus(); $('app').hidden=false;
    updateMoreBtn();
    // Fait grossir le blob de ce joueur en arrière-plan (réparti les écritures).
    saveHistorique(STATE.name, STATE.tag, region);
  }catch(e){
    status('err','<b>Erreur API :</b> '+(e.message||'network'));
  }
}

/* ===================== CHARGER PLUS DE PARTIES ===================== */
// Le bouton reflète la taille réelle de l'historique combiné (frais + blob).
// Quand tout est affiché (le blob ne grossit plus malgré le cron), on désactive
// le bouton avec un message honnête plutôt que de laisser croire à un chargement infini.
function updateMoreBtn(){
  const btn=$('btnMore'); if(!btn) return;
  const total=(STATE.allMatches||[]).length;
  const shown=Math.min(PROFILE_SHOWN, total);
  if(shown>=total){
    btn.disabled=true;
    btn.textContent=`Tout l'historique dispo est chargé (${total} partie${total>1?'s':''})`;
  }else{
    btn.disabled=false;
    btn.textContent=`Charger plus de parties (${shown}/${total} affichées)`;
  }
}

// Pagination côté client : on révèle plus de parties déjà présentes dans
// l'historique combiné, sans nouvel appel API.
function loadMoreMatches(){
  const total=(STATE.allMatches||[]).length;
  if(PROFILE_SHOWN>=total) return;
  PROFILE_SHOWN=Math.min(PROFILE_SHOWN+PROFILE_SIZE_STEP, total);
  STATE.matches=STATE.allMatches.slice(0, PROFILE_SHOWN);
  renderList();
  updateMoreBtn();
}

/* ===================== LOGIQUE TRIBUNAL & JAUGE ===================== */
const Z=[
  {from:0,  to:48, color:"var(--bad)",     label:"BAD"},
  {from:48, to:72, color:"var(--unlucky)", label:"UNLUCKY"},
  {from:72, to:100,color:"var(--cracked)", label:"CRACKED"},
];
const CX=200, CYY=200, R=156;
const ang=s=>180-(s*1.8);
const pt=(s,rad)=>{const a=ang(s)*Math.PI/180;return[CX+rad*Math.cos(a),CYY-rad*Math.sin(a)];};
function arc(a,b){let d='';for(let s=a;s<=b;s+=2){const[x,y]=pt(s,R);d+=(s===a?'M':'L')+x.toFixed(1)+' '+y.toFixed(1)+' ';}return d.trim();}

function drawGauge(id){
  let svg='';
  svg+=`<path d="${arc(0,100)}" fill="none" stroke="#1d2734" stroke-width="20" stroke-linecap="round"/>`;
  Z.forEach(z=>{ svg+=`<path d="${arc(z.from+ (z.from===0?0:0.5), z.to)}" fill="none" stroke="${z.color}" stroke-width="20" stroke-linecap="butt"/>`; });
  Z.forEach(z=>{ const[lx,ly]=pt((z.from+z.to)/2,R+22); svg+=`<text class="znlabel" x="${lx.toFixed(0)}" y="${ly.toFixed(0)}" fill="${z.color}" text-anchor="middle" dominant-baseline="middle">${z.label}</text>`; });
  svg+=`<g class="needle" transform="rotate(-90 ${CX} ${CYY})">
          <line x1="${CX}" y1="${CYY}" x2="${CX}" y2="${CYY-R+16}" stroke="#e9eef4" stroke-width="4" stroke-linecap="round"/>
          <circle cx="${CX}" cy="${CYY-R+16}" r="5" fill="#e9eef4"/>
        </g>
        <circle cx="${CX}" cy="${CYY}" r="11" fill="#0a0d16" stroke="#3a4757" stroke-width="2"/>`;
  const el = $(id); if(el) el.innerHTML=svg;
}

function setNeedle(id, score) {
  const g = $(id)?.querySelector('.needle');
  if(g) g.setAttribute('transform', `rotate(${(score*1.8-90).toFixed(2)} ${CX} ${CYY})`);
}

function resetStage(prefix) {
  const vword = $(`vw${prefix}`), vline = $(`vl${prefix}`), vpct = $(`vp${prefix}`);
  if(vword){ vword.className='vword'; vword.textContent='?'; vword.style.color='var(--muted)'; }
  if(vline){ vline.className='vline'; vline.textContent=''; }
  if(vpct){ vpct.className='vpct'; vpct.textContent=''; }
  setNeedle(`gauge${prefix}`, 50);
}

function computeVerdict(matches, n) {
  // Ranked uniquement : on filtre le competitive avant de prendre les n dernières
  const gs = matches.filter(m => m.me && (m.mode||'').toLowerCase()==='competitive').slice(0, n);
  if(!gs.length) return {tier:'?', avg:0, line:'Pas de parties classées trouvées.', pct:'Lance quelques ranked !', color:'var(--muted)'};
  
  const avg = Math.round(gs.reduce((a,g)=>a+g.me.score100,0)/gs.length);
  const losses = gs.filter(g => g.result !== 'w');
  const unluckyL = losses.filter(g => (g.me.placement != null && g.me.placement <= 5) || g.me.score100 >= 55).length;
  const top3 = gs.filter(g => g.me.placement != null && g.me.placement <= 3).length;

  let tier;
  if(avg >= 72) tier = 'CRACKED'; else if(avg < 48) tier = 'BAD'; else tier = 'UNLUCKY';
  
  let line, pct;
  if(tier === 'CRACKED'){
    line = "Tu es juste trop fort pour ce lobby.";
    pct = `Indice moyen ${avg}/100 · top 3 du lobby dans ${top3}/${gs.length} parties`;
  } else if(tier === 'UNLUCKY'){
    const r = losses.length ? Math.round(unluckyL/losses.length*100) : 0;
    line = "Tu as fait ta part. C'est ailleurs que ça a lâché.";
    pct = `${r}% de tes défaites en étant dans la moitié haute · indice moyen ${avg}/100`;
  } else {
    line = "Soyons honnêtes : le problème, c'était toi.";
    pct = `Indice moyen ${avg}/100 · ${losses.length} défaites sur ${gs.length}`;
  }
  const color = tier === 'CRACKED' ? 'var(--cracked)' : tier === 'UNLUCKY' ? 'var(--unlucky)' : 'var(--bad)';
  return {tier, avg, line, pct, color};
}

function animateVerdict(prefix, matches, n) {
  if (ANIM_BUSY[prefix]) return;
  ANIM_BUSY[prefix] = true;
  
  const btn = $(`rev${prefix}`);
  btn.disabled = true;
  const v = computeVerdict(matches, n);
  const target = clamp(v.avg, 2, 98);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  resetStage(prefix);
  
  const finish = () => {
    setNeedle(`gauge${prefix}`, target);
    $(`stage${prefix}`).style.setProperty('--c', v.color);
    const flash = $(`flash${prefix}`);
    flash.classList.remove('go'); void flash.offsetWidth; flash.classList.add('go');
    
    const w = $(`vw${prefix}`);
    w.textContent = v.tier; w.style.color = v.color; w.className = 'vword show';
    const vl = $(`vl${prefix}`);
    vl.textContent = v.line; vl.classList.add('show');
    const vp = $(`vp${prefix}`);
    vp.textContent = v.pct; vp.classList.add('show');
    
    btn.disabled = false;
    ANIM_BUSY[prefix] = false;
  };

  if(reduce) { finish(); return; }

  const start = performance.now(), dur = 2600;
  function frame(now){
    const t = clamp((now-start)/dur, 0, 1);
    const wobble = Math.cos(t*Math.PI*7.5)*(1-t)*(1-t)*78;
    setNeedle(`gauge${prefix}`, clamp(target+wobble, 0, 100));
    if(t < 1) requestAnimationFrame(frame); else finish();
  }
  requestAnimationFrame(frame);
}

function statusTrib(kind, html) { 
  const s = $('statusTrib'); s.className = 'status show ' + kind; s.innerHTML = html; 
}
function clearStatusTrib() { $('statusTrib').className = 'status'; }

function renderTribMembers() {
  $('tribMembers').innerHTML = ROSTER.map((m, i) => `
    <button class="chip ${i === TRIB.active ? 'on' : ''}" style="--c:${m.color}" data-i="${i}">
      ${m.name}<b>#${m.tag}</b>
    </button>`).join('');
}

// Récupère les matchs de toute la squad : pour chaque membre, on combine les
// parties classées fraîches (v4) avec l'historique accumulé (blob), dédoublonné
// par matchid. Sert au tribunal ET au leaderboard.
// Le blob contient tous les modes : on garde ici uniquement le competitive pour
// préserver le caractère « ranked-only » du tribunal et du leaderboard.
async function loadSquadMatches(region) {
  const reqs = ROSTER.map(m => Promise.allSettled([
    api(`/valorant/v4/matches/${region}/pc/${enc(m.name)}/${enc(m.tag)}?mode=competitive&size=15`),
    fetchHistorique(m.name, m.tag)
  ]));
  const results = await Promise.all(reqs);
  return results.map((pair, i) => {
    const member = ROSTER[i];
    const fresh = pair[0].status === 'fulfilled' ? (pair[0].value.data || []) : [];
    const blob  = pair[1].status === 'fulfilled' ? (pair[1].value || []) : [];
    const data  = combineMatches(fresh, blob);
    const norm  = data.map(m => normalizeAny(m, member)).filter(M => M && (M.mode || '').toLowerCase() === 'competitive');
    return { member, data, norm };
  });
}

async function loadTribunal() {
  $('home').hidden = true;
  $('profile').hidden = true;
  $('leaderboard').hidden = true;
  $('tribunal').hidden = false;
  $('appTrib').hidden = true;

  statusTrib('load', 'Convocation du tribunal (analyse des parties classées de chaque membre)...');
  const region = REGION();
  try {
    TRIB.matches = await loadSquadMatches(region);
    TRIB.active = 0;
    renderTribMembers();
    resetStage('Trib');
    clearStatusTrib();
    $('appTrib').hidden = false;
  } catch(e) {
    statusTrib('err', "Erreur lors de la récupération des données de l'équipe.");
  }
}

/* ===================== LEADERBOARD ===================== */
function statusLb(kind, html) {
  const s = $('statusLb'); s.className = 'status show ' + kind; s.innerHTML = html;
}
function clearStatusLb() { $('statusLb').className = 'status'; }

async function loadLeaderboard() {
  $('home').hidden = true;
  $('profile').hidden = true;
  $('tribunal').hidden = true;
  $('leaderboard').hidden = false;
  $('appLb').hidden = true;
  window.scrollTo(0,0);

  // Si Tribunal a déjà chargé les données, on les réutilise
  if (TRIB.matches && TRIB.matches.length) {
    clearStatusLb();
    renderLeaderboard();
    $('appLb').hidden = false;
    return;
  }

  statusLb('load', 'Récupération des dernières parties classées de toute la squad…');
  const region = REGION();
  try {
    TRIB.matches = await loadSquadMatches(region);
    clearStatusLb();
    renderLeaderboard();
    $('appLb').hidden = false;
  } catch (e) {
    statusLb('err', "Erreur lors de la récupération des données.");
  }
}

function computeMemberStats(member, normMatches, n) {
  const gs = normMatches.filter(m => m.me).slice(0, n);
  if (!gs.length) return { member, count:0, avg:0, wr:0, wins:0, kd:0, hs:0, acs:0, dd:0 };
  const wins = gs.filter(g => g.result === 'w').length;
  const avg = Math.round(gs.reduce((s, g) => s + g.me.score100, 0) / gs.length);
  const wr = Math.round(wins / gs.length * 100);
  const kSum = gs.reduce((s, g) => s + g.me.k, 0);
  const dSum = gs.reduce((s, g) => s + g.me.d, 0);
  return {
    member, count: gs.length, avg, wr, wins,
    kd: kSum / Math.max(dSum, 1),
    hs: Math.round(gs.reduce((s, g) => s + g.me.hs, 0) / gs.length),
    acs: Math.round(gs.reduce((s, g) => s + g.me.acs, 0) / gs.length),
    dd: Math.round(gs.reduce((s, g) => s + g.me.dd, 0) / gs.length),
  };
}

function computeBadges() {
  const stats = TRIB.matches.map(tm => {
    const norm = tm.norm.filter(m => m.me).slice(0, LB.n);
    if (!norm.length) return null;
    const indices = norm.map(m => m.me.score100);
    const avg = indices.reduce((a,v) => a+v, 0) / indices.length;
    const variance = indices.length > 1 ? indices.reduce((a,v) => a + (v-avg)**2, 0) / indices.length : 0;
    const stdev = Math.sqrt(variance);
    const kSum = norm.reduce((a,m) => a + m.me.k, 0);
    const dSum = norm.reduce((a,m) => a + m.me.d, 0);
    const nightCount = norm.filter(m => {
      if (!m.started) return false;
      const h = new Date(m.started).getHours();
      return h >= 22 || h < 5;
    }).length;
    return {
      member: tm.member,
      count: norm.length,
      avg,
      stdev,
      kd: kSum / Math.max(dSum, 1),
      hs: norm.reduce((a,m) => a + m.me.hs, 0) / norm.length,
      acs: norm.reduce((a,m) => a + m.me.acs, 0) / norm.length,
      dd: norm.reduce((a,m) => a + m.me.dd, 0) / norm.length,
      nightCount,
    };
  }).filter(Boolean);

  const eligible = stats.filter(s => s.count >= 3);
  if (!eligible.length) return [];
  const eligibleKonstant = stats.filter(s => s.count >= 5);

  const max = (arr, k) => arr.reduce((a, b) => b[k] > a[k] ? b : a);
  const min = (arr, k) => arr.reduce((a, b) => b[k] < a[k] ? b : a);

  const out = [
    { emoji:'🔥', title:'Carry de la team',  desc:'meilleur indice moyen',  w: max(eligible,'avg'), key:'avg', fmt: v => `${Math.round(v)}/100` },
    { emoji:'💀', title:'Bourreau',          desc:'meilleur ratio K/D',      w: max(eligible,'kd'),  key:'kd',  fmt: v => v.toFixed(2) },
    { emoji:'🎯', title:'Headhunter',        desc:'meilleur HS%',            w: max(eligible,'hs'),  key:'hs',  fmt: v => `${Math.round(v)}%` },
    { emoji:'💪', title:'Le Tank',           desc:'meilleur ΔDmg/round',    w: max(eligible,'dd'),  key:'dd',  fmt: v => `${v>=0?'+':''}${Math.round(v)}` },
    { emoji:'⚡', title:'ACS King',          desc:'meilleur ACS moyen',     w: max(eligible,'acs'), key:'acs', fmt: v => `${Math.round(v)} ACS` },
  ];
  if (eligibleKonstant.length) {
    out.push({ emoji:'🧊', title:'Le plus konstant', desc:'indice le plus stable (σ min)', w: min(eligibleKonstant,'stdev'), key:'stdev', fmt: v => `σ ${v.toFixed(1)}` });
  }
  const nightCandidates = eligible.filter(s => s.nightCount > 0);
  if (nightCandidates.length) {
    out.push({ emoji:'🌙', title:'Late night warrior', desc:'plus de games entre 22h et 5h', w: max(nightCandidates,'nightCount'), key:'nightCount', fmt: v => `${v} games` });
  }
  return out;
}

function renderBadges() {
  const badges = computeBadges();
  const el = $('lbBadges');
  if (!badges.length) { el.innerHTML = ''; return; }
  el.innerHTML = badges.map(b => `
    <div class="badge" style="--c:${b.w.member.color}">
      <div class="b-emoji">${b.emoji}</div>
      <div class="b-title">${b.title}</div>
      <div class="b-winner" style="color:${b.w.member.color}">${b.w.member.name}</div>
      <div class="b-value">${b.fmt(b.w[b.key])}</div>
      <div class="b-desc">${b.desc}</div>
    </div>`).join('');
}

function renderLeaderboard() {
  renderBadges();
  renderVsPickers();
  renderVs();
  const ranked = TRIB.matches
    .map(tm => computeMemberStats(tm.member, tm.norm, LB.n))
    .sort((a, b) => (b.count ? b.avg : -1) - (a.count ? a.avg : -1));

  const medals = ['🥇','🥈','🥉'];
  $('lbList').innerHTML = ranked.map((s, idx) => {
    const m = s.member;
    const t = tierOf(s.avg);
    const wrColor = s.wr >= 50 ? 'var(--win)' : 'var(--loss)';
    const empty = s.count === 0;
    const topClass = (!empty && idx < 3) ? `top${idx+1}` : '';
    const rankHtml = (!empty && idx < 3)
      ? `<div class="lb-rank medal">${medals[idx]}</div>`
      : `<div class="lb-rank">${idx+1}.</div>`;
    const bustSrc = m.customImg || `${MEDIA}/${m.uuid}/fullportrait.png`; // bustportrait.png n'existe pas (404) chez valorant-api
    const bustImg = m.customImg
      ? `<img src="${bustSrc}" alt="" style="width:100%;left:0;top:0;height:100%;object-fit:cover;">`
      : `<img src="${bustSrc}" alt="">`;
    return `<div class="lb-row ${topClass} ${empty?'empty':''}">
      ${rankHtml}
      <div class="lb-bust" style="--pc:${m.color}">${bustImg}</div>
      <div class="lb-name"><b style="color:${m.color}">${m.name}</b><span>#${m.tag} · ${m.agent}</span></div>
      <div class="lb-stat"><div class="v" style="color:${empty?'var(--dim)':t.c}">${empty?'—':s.avg}</div><div class="l">indice</div></div>
      <div class="lb-stat hide-sm"><div class="v" style="color:${empty?'var(--dim)':wrColor}">${empty?'—':s.wr+'%'}</div><div class="l">winrate</div></div>
      <div class="lb-stat"><div class="v">${s.wins}/${s.count}</div><div class="l">parties</div></div>
    </div>`;
  }).join('');
}

/* ===================== 1v1 COMPARATEUR ===================== */
function renderVsPickers() {
  const mk = (side, sel) => ROSTER.map((m, i) => `
    <button class="chip ${i === sel ? 'on' : ''}" style="--c:${m.color}" data-side="${side}" data-i="${i}">
      ${m.name}<b>#${m.tag}</b>
    </button>`).join('');
  $('vsPickerA').innerHTML = mk('a', VS.a);
  $('vsPickerB').innerHTML = mk('b', VS.b);
}

function renderVs() {
  $('vsPeriod').textContent = LB.n;
  const out = $('vsResult');

  if (VS.a === VS.b) {
    out.innerHTML = `<div class="vs-empty">Choisis deux joueurs différents.</div>`;
    return;
  }
  const tmA = TRIB.matches[VS.a], tmB = TRIB.matches[VS.b];
  if (!tmA || !tmB) { out.innerHTML = `<div class="vs-empty">Données indisponibles.</div>`; return; }

  const a = computeMemberStats(tmA.member, tmA.norm, LB.n);
  const b = computeMemberStats(tmB.member, tmB.norm, LB.n);
  if (!a.count || !b.count) {
    out.innerHTML = `<div class="vs-empty">Pas assez de parties classées pour comparer.</div>`;
    return;
  }

  const stats = [
    { label:'Indice',       va:a.avg, vb:b.avg, fmt: v => v },
    { label:'Winrate',      va:a.wr,  vb:b.wr,  fmt: v => v+'%' },
    { label:'K/D',          va:a.kd,  vb:b.kd,  fmt: v => v.toFixed(2) },
    { label:'ACS',          va:a.acs, vb:b.acs, fmt: v => v },
    { label:'HS%',          va:a.hs,  vb:b.hs,  fmt: v => v+'%' },
    { label:'Δ Dmg/round',  va:a.dd,  vb:b.dd,  fmt: v => (v>=0?'+':'')+v },
  ];

  let aWins = 0, bWins = 0;
  stats.forEach(s => { if (s.va > s.vb) aWins++; else if (s.vb > s.va) bWins++; });

  const rows = stats.map(s => {
    const aw = s.va > s.vb, bw = s.vb > s.va;
    return `<tr>
      <td class="vs-v ${aw?'w':''}">${s.fmt(s.va)}</td>
      <td class="vs-l">${s.label}</td>
      <td class="vs-v ${bw?'w':''}">${s.fmt(s.vb)}</td>
    </tr>`;
  }).join('');

  let verdict;
  if (aWins === bWins) {
    verdict = `Égalité ${aWins}–${bWins} · personne ne se détache`;
  } else {
    const winner = aWins > bWins ? a.member : b.member;
    verdict = `${winner.name} domine ${Math.max(aWins,bWins)}–${Math.min(aWins,bWins)} sur les ${LB.n} dernières ranked`;
  }

  out.innerHTML = `
    <div class="vs-heads">
      <div class="vs-head" style="--c:${a.member.color}">
        <div class="nm" style="color:${a.member.color}">${a.member.name}</div>
        <div class="sub">${a.member.agent} · #${a.member.tag}</div>
        <div class="smp">${a.count} parties</div>
      </div>
      <div class="vs-divider">VS</div>
      <div class="vs-head" style="--c:${b.member.color}">
        <div class="nm" style="color:${b.member.color}">${b.member.name}</div>
        <div class="sub">${b.member.agent} · #${b.member.tag}</div>
        <div class="smp">${b.count} parties</div>
      </div>
    </div>
    <table class="vs-table"><tbody>${rows}</tbody></table>
    <div style="text-align:center;"><div class="vs-verdict">${verdict}</div></div>`;
}

function pickVs(e) {
  const c = e.target.closest('.chip');
  if (!c) return;
  const side = c.dataset.side, i = +c.dataset.i;
  if (side === 'a') {
    if (VS.b === i) VS.b = VS.a;
    VS.a = i;
  } else {
    if (VS.a === i) VS.a = VS.b;
    VS.b = i;
  }
  renderVsPickers();
  renderVs();
}

/* ===================== ROSTER (source unique) ===================== */
// Charge roster.json (membres + région par défaut), source de vérité partagée
// avec la fonction planifiée. Repli silencieux si indisponible.
async function loadRoster(){
  // 1) roster stocké (éditable depuis l'UI, via Netlify Blob)
  try{
    const r=await fetch('/.netlify/functions/roster');
    if(r.ok){
      const d=await r.json();
      if(d && d.roster && Array.isArray(d.roster.members) && d.roster.members.length){
        ROSTER=d.roster.members;
        if(d.roster.region) DEFAULT_REGION=d.roster.region;
        applyRegionDefault();
        return;
      }
    }
  }catch(e){ /* pas de roster stocké : on retombe sur roster.json */ }
  // 2) repli : roster.json (valeur de départ, versionnée dans le repo)
  try{
    const r=await fetch('roster.json');
    if(r.ok){
      const d=await r.json();
      ROSTER=Array.isArray(d)?d:(d.members||[]);
      if(d && d.region) DEFAULT_REGION=d.region;
    }
  }catch(e){ /* roster indispo : la grille restera vide */ }
  applyRegionDefault();
}
function applyRegionDefault(){ const sel=$('region'); if(sel && DEFAULT_REGION) sel.value=DEFAULT_REGION; }

// Construit les cartes de l'accueil à partir du ROSTER (plus de duplication en HTML).
function renderRoster(){
  const host=$('roster'); if(!host) return;
  host.innerHTML=ROSTER.map((m,i)=>{
    const mono=esc(m.mono||(m.agent||'').slice(0,2));
    const portrait=m.customImg || `${MEDIA}/${m.uuid}/fullportrait.png`;
    const custom=m.customImg?' custom':'';
    const numTxt=String(i+1).padStart(2,'0');
    return `<button class="agentcard${custom}" style="--c:${esc(m.color)}" data-idx="${i}">
      <div class="glow"></div><div class="num mono">${numTxt}</div>
      <div class="monogram">${mono}</div>
      <img class="portrait" src="${esc(portrait)}" alt="${esc(m.agent)}">
      <div class="scrim"></div>
      <div class="info"><div class="arole">${esc(m.role)}</div><div class="aname">${esc(m.agent)}</div>
        <div class="rid">${esc(m.name)}<b>#${esc(m.tag)}</b></div><div class="rankchip" id="rank-${i}">rang…</div></div>
    </button>`;
  }).join('');
  wireRosterImgs();
}

/* ===================== ÉDITEUR DE ROSTER ===================== */
// Une ligne de formulaire pour un membre.
function rosterRowHTML(m){
  m=m||{};
  const f=(k,ph)=>`<input data-f="${k}" placeholder="${ph}" value="${esc(m[k]||'')}">`;
  return `<div class="edrow">
    ${f('name','pseudo')}${f('tag','tag')}${f('agent','agent')}${f('role','rôle')}
    ${f('color','#couleur')}${f('uuid','uuid agent')}${f('customImg','URL GIF (optionnel)')}
    <button class="edrm" type="button" title="Retirer ce membre">✕</button>
  </div>`;
}
function addRosterRow(m){ const host=$('edMembers'); if(host) host.insertAdjacentHTML('beforeend', rosterRowHTML(m)); }
function renderRosterEditor(){
  const reg=$('edRegion'); if(reg) reg.value=DEFAULT_REGION||'eu';
  const host=$('edMembers'); if(!host) return;
  host.innerHTML='';
  (ROSTER.length?ROSTER:[{}]).forEach(m=>addRosterRow(m));
}
function collectRoster(){
  const members=[...document.querySelectorAll('#edMembers .edrow')].map(row=>{
    const g=f=>{const el=row.querySelector(`[data-f="${f}"]`);return el?el.value.trim():'';};
    const m={ name:g('name'), tag:g('tag'), agent:g('agent'), role:g('role'), color:g('color')||'#8696a6' };
    const uuid=g('uuid'), img=g('customImg');
    if(uuid) m.uuid=uuid; if(img) m.customImg=img;
    m.mono=(m.agent||m.name).slice(0,2);
    return m;
  }).filter(m=>m.name && m.tag);
  return { region:(($('edRegion')&&$('edRegion').value)||'eu').trim()||'eu', members };
}
async function saveRoster(){
  const out=$('edStatus'), tokEl=$('edToken');
  const token=((tokEl&&tokEl.value)||'').trim();
  if(!token){ if(out) out.textContent='Entre la clé REFRESH_TOKEN (configurée sur Netlify).'; return; }
  const roster=collectRoster();
  if(!roster.members.length){ if(out) out.textContent='Ajoute au moins un membre (pseudo + tag).'; return; }
  if(out) out.textContent='Enregistrement…';
  try{
    const r=await fetch(`/.netlify/functions/roster?key=${enc(token)}`, {
      method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(roster)
    });
    const d=await r.json().catch(()=>({}));
    if(!r.ok || d.ok===false){ if(out) out.textContent='Échec : '+((d&&d.error)||('http '+r.status)); return; }
    if(out) out.textContent=`Enregistré ✓ (${d.count} membres). Mise à jour…`;
    resetSquadIndex();   // pseudos/membres modifiés : l'index "qui joue avec qui" est périmé
    await loadRoster(); renderRoster(); fillRanks(); renderRosterEditor();
  }catch(e){ if(out) out.textContent='Erreur réseau : '+((e&&e.message)||e); }
}

/* ===================== WIRING ===================== */
function wireRosterImgs(){
  document.querySelectorAll('.agentcard .portrait').forEach(img=>{
    const fail=()=>{img.style.display='none';const c=img.closest('.agentcard');if(c)c.classList.add('noimg');};
    img.addEventListener('error',fail);
    if(img.complete && img.naturalWidth===0) fail();
  });
}

let WIRED = false;
function wireStatic(){
  if(WIRED) return;   // ne câbler qu'une fois (init peut être rappelé)
  WIRED = true;
  $('btnGear').addEventListener('click',toggleSheet);
  $('btnRanks').addEventListener('click',fillRanks);
  $('btnRefreshNow')?.addEventListener('click', saveAllHistory);
  // Éditeur de roster (⚙ Paramètres)
  $('btnEditRoster')?.addEventListener('click', () => {
    const ed=$('rosterEditor'); if(!ed) return;
    ed.hidden=!ed.hidden; if(!ed.hidden) renderRosterEditor();
  });
  $('edAdd')?.addEventListener('click', () => addRosterRow());
  $('edMembers')?.addEventListener('click', e => { const b=e.target.closest('.edrm'); if(b) b.closest('.edrow')?.remove(); });
  $('edSave')?.addEventListener('click', saveRoster);
  $('btnBack').addEventListener('click',showHome);
  $('btnBackTrib').addEventListener('click',showHome);
  $('btnBackLb').addEventListener('click',showHome);
  // Boutons masqués pour l'instant : on garde le câblage (et on tolère leur absence).
  $('btnTribunal')?.addEventListener('click',loadTribunal);
  $('btnLeaderboard')?.addEventListener('click',loadLeaderboard);
  
  $('roster').addEventListener('click',e=>{const c=e.target.closest('.agentcard');if(c)openProfile(+c.dataset.idx);});
  $('ml').addEventListener('click',e=>{
    const b=e.target.closest('[data-sd]');
    if(b){ e.stopPropagation(); openMatchScore(+b.dataset.sd); return; }   // clic sur l'indice -> détail du calcul
    const r=e.target.closest('.mrow'); if(r) showMatch(+r.dataset.idx);
  });
  // Détail du calcul : badge du dernier match + indices du scoreboard
  $('verdict')?.addEventListener('click',e=>{ if(e.target.closest('#heroScore')) openMatchScore(0); });
  $('sb')?.addEventListener('click',e=>{
    const c=e.target.closest('[data-sb]'); if(!c) return;
    const line=SB_LINES[+c.dataset.sb]; if(!line) return;
    openScoreDetail(line, { title:`${line.name}#${line.tag} · ${line.agent}`, sub:($('sbsub')&&$('sbsub').textContent)||'' });
  });
  $('scoreModal')?.addEventListener('click',e=>{
    if(e.target.closest('#scoreModalX')||e.target.classList.contains('modal-back')) closeScoreDetail();
  });
  // Détail complet de la partie (timeline, faits d'armes, duels, lobby)
  $('btnMatchDetail')?.addEventListener('click',()=>openMatchFacts(SELECTED_IDX>=0?SELECTED_IDX:0));
  $('matchModal')?.addEventListener('click',e=>{
    if(e.target.closest('#matchModalX')||e.target.classList.contains('modal-back')){ closeMatchFacts(); return; }
    const rc=e.target.closest('.rchip'); if(rc) renderRoundDetail(+rc.dataset.round);
  });
  // Rapports de session
  $('sxList')?.addEventListener('click',e=>{
    const r=e.target.closest('[data-sx]'); if(r) openSessionReport(r.dataset.sx);
  });
  $('sessionModal')?.addEventListener('click',e=>{
    if(e.target.closest('#sessionModalX')||e.target.classList.contains('modal-back')) closeSessionReport();
  });
  $('btnSxMore')?.addEventListener('click',()=>{ SESSIONS_SHOWN+=8; renderSessions(); });
  $('sxGap')?.addEventListener('change',e=>{ SESSION_GAP_MIN=+e.target.value||120; refreshSessions(); });
  $('sxScope')?.addEventListener('click',e=>{
    const b=e.target.closest('button[data-scope]'); if(!b) return;
    SESSIONS_ONLY_COMMON = b.dataset.scope==='common';
    document.querySelectorAll('#sxScope button').forEach(x=>x.classList.toggle('on', x===b));
    SESSIONS_SHOWN=8;
    // Le filtre « communes » a besoin des historiques de la squad.
    if(SESSIONS_ONLY_COMMON && !SQUAD_INDEX) ensureSquadHistories().then(renderSessions).catch(()=>renderSessions());
    else renderSessions();
  });
  document.addEventListener('keydown',e=>{ if(e.key==='Escape'){ closeScoreDetail(); closeMatchFacts(); closeSessionReport(); } });
  $('phead').addEventListener('click',e=>{if(e.target.closest('.refresh'))loadProfile();});
  $('btnMore')?.addEventListener('click', loadMoreMatches);

  // Filtres (Onglets des Modes)
  $('modeTabs')?.addEventListener('click', e => {
    const b = e.target.closest('button[data-mode]');
    if (b) {
      CURRENT_MODE = b.dataset.mode;
      document.querySelectorAll('#modeTabs button').forEach(x => x.classList.toggle('on', x === b));
      renderList();
    }
  });

  // Sélecteur de période du graphe RR (court terme <-> long terme)
  $('rrPeriod')?.addEventListener('click', e => {
    const b = e.target.closest('button[data-n]');
    if (b) { RR_PERIOD = +b.dataset.n; renderCurvePeriod(); }
  });
  // Filtre saison / acte du graphe RR
  $('rrSeason')?.addEventListener('change', e => { RR_SEASON = e.target.value; renderCurvePeriod(); });
  // Comparaison avec un autre joueur sur le graphe RR
  $('rrCompare')?.addEventListener('change', e => { const v=e.target.value; setCompareMember(v===''?-1:+v); });
  // Filtre saison / acte des stats agent/map
  $('statsSeason')?.addEventListener('change', e => { STATS_SEASON = e.target.value; renderStatsCards(filterByMode(STATE.matches, CURRENT_MODE)); });

  // Wiring Tribunal Equipe
  $('tribMembers').addEventListener('click', e => {
    const c = e.target.closest('.chip');
    if (c) {
      TRIB.active = +c.dataset.i;
      renderTribMembers();
      resetStage('Trib');
    }
  });
  $('segTrib').addEventListener('click', e => {
    const b = e.target.closest('button[data-n]');
    if (b) {
      TRIB.n = +b.dataset.n;
      document.querySelectorAll('#segTrib button').forEach(x => x.classList.toggle('on', x === b));
      resetStage('Trib');
    }
  });
  $('revTrib').addEventListener('click', () => {
    if(TRIB.matches[TRIB.active]) animateVerdict('Trib', TRIB.matches[TRIB.active].norm, TRIB.n);
  });

  // Wiring 1v1
  $('vsPickerA').addEventListener('click', pickVs);
  $('vsPickerB').addEventListener('click', pickVs);

  // Wiring Leaderboard
  $('segLb').addEventListener('click', e => {
    const b = e.target.closest('button[data-n]');
    if (b) {
      LB.n = +b.dataset.n;
      document.querySelectorAll('#segLb button').forEach(x => x.classList.toggle('on', x === b));
      renderLeaderboard();
    }
  });
}

/* ===================== INIT ===================== */
// Enregistre le service worker (PWA) — sans effet en dehors d'un navigateur compatible.
function registerSW(){
  try{
    if(typeof navigator!=='undefined' && 'serviceWorker' in navigator && location.protocol.startsWith('http')){
      navigator.serviceWorker.register('/sw.js').catch(()=>{});
    }
  }catch(e){}
}
async function init(){
  await loadRoster();   // source de vérité : doit être chargée avant de bâtir la grille
  renderRoster();
  wireStatic();
  drawGauge('gaugeTrib');
  fillRanks();
  registerSW();
}
if(typeof document!=='undefined'){
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init);
  else init();
}