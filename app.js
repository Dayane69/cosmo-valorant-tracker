/* ===================== CONFIG ===================== */
const PROXY = p => `/.netlify/functions/valo?path=${encodeURIComponent(p)}`;
const MEDIA = "https://media.valorant-api.com/agents";

// Roster chargé depuis roster.json (source de vérité unique, partagée avec la
// fonction planifiée refresh-matches). Rempli au démarrage par loadRoster().
let ROSTER = [];
// Invités : joueurs hors squad avec qui on joue parfois. Ils comptent pour les
// RAPPORTS DE SESSION (composition, rapport commun) et pour rien d'autre :
// ni carte d'accueil, ni leaderboard, ni tribunal, ni cron.
let GUESTS = [];
// Roster + invités : la seule liste à consulter pour « qui a joué avec qui ».
const sessionRoster = () => ROSTER.concat(GUESTS);
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
let SELECTED_ID = null;                                 // ...et son match_id, stable à travers un rafraîchissement
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
let AGENT_LIST = [];                                    // liste complète {name, role, icon, portrait}
let TIERS = null;                                       // cache nom de palier -> icône de rang
let TIER_BY_NUM = null;                                 // cache numéro de palier -> {name,color,icon} (lignes de rang du graphe)
let ELO_TIER_OFFSET = 3;                                // numéro de palier = floor(elo/100) + offset (Iron 1 = palier 3, elo 0)
const ANIM_BUSY = { Trib: false, Prof: false };
let RANKS_FILLED = false;               // les rangs de l'accueil ont-ils déjà été chargés

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
// Statuts qui méritent une nouvelle tentative : 429 = rafale trop rapide,
// 5xx = hoquet passager d'HenrikDev. Le reste est définitif (404, 400…).
const RETRYABLE = { 429:1, 500:1, 502:1, 503:1, 504:1 };
const API_TRIES = 3;

async function api(path, tries){
  const max = tries || API_TRIES;
  let wait = 1100;
  for(let attempt=0; attempt<max; attempt++){
    let r;
    try{ r = await fetch(PROXY(path)); }
    catch(err){                                   // coupure réseau
      if(attempt === max-1){ const e=new Error('réseau'); e.status=0; throw e; }
      await sleep(wait); wait*=2; continue;
    }
    if(r.ok) return r.json();
    if(!RETRYABLE[r.status] || attempt === max-1){
      const e=new Error('http '+r.status); e.status=r.status; throw e;
    }
    // HenrikDev indique parfois combien de temps patienter : on l'écoute.
    const ra = Number(r.headers.get('retry-after'));
    await sleep(ra > 0 ? Math.min(ra*1000, 10000) : wait);
    wait *= 2;
  }
}

// Message lisible plutôt qu'un « http 429 » brut.
function apiErrMsg(e){
  const st = e && e.status;
  if(st === 429) return "trop de requêtes d'un coup côté API Valorant. Ça se calme tout seul en une minute.";
  if(st === 404) return "compte introuvable côté Riot (pseudo ou tag incorrect ?).";
  if(st === 0)   return "pas de réseau.";
  if(st >= 500)  return "l'API Valorant est en vrac de son côté.";
  return (e && e.message) || 'erreur inconnue';
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

/* --- Anciens pseudos -------------------------------------------------------
   Les blobs (historique ET progression RR) sont indexés par pseudo#tag. Changer
   de pseudo Riot laisse donc toutes les données accumulées orphelines sous
   l'ancienne clé. Les matchs, eux, finissent par revenir (stored-matches est
   rattaché au compte), mais la série RR long terme, elle, est PERDUE : l'API
   mmr-history ne renvoie qu'une fenêtre courte, c'est le blob qui accumule.
   Les alias servent de pont : on relit les anciennes clés et on fusionne. */
function memberAliases(m){
  const raw=m && m.alias;
  const list=Array.isArray(raw)?raw:(typeof raw==='string'?raw.split(','):[]);
  const out=[], seen={}, self=memberKey(m||{});
  list.forEach(entry=>{
    const s=String(entry==null?'':entry).trim();
    const i=s.lastIndexOf('#');
    if(i<1 || i===s.length-1) return;                 // il faut un pseudo ET un tag
    const name=s.slice(0,i).trim(), tag=s.slice(i+1).trim();
    if(!name || !tag) return;
    const k=(name+'#'+tag).toLowerCase();
    if(k===self || seen[k]) return;                   // le pseudo actuel n'est pas un alias
    seen[k]=true; out.push({name, tag});
  });
  return out.slice(0,5);
}
// Toutes les identités sous lesquelles chercher les données d'un membre.
const memberIdentities = m => [{name:m.name, tag:m.tag}, ...memberAliases(m)];

// Historique matchs d'un membre, anciens pseudos compris (dédoublonné par matchid).
async function fetchHistoriqueAll(m){
  const ids=memberIdentities(m);
  if(ids.length===1) return fetchHistorique(m.name, m.tag);
  const lists=await Promise.all(ids.map(x=>fetchHistorique(x.name, x.tag).catch(()=>[])));
  return combineMatches(...lists);
}
// Série RR d'un membre, anciens pseudos compris (dédoublonnée par match_id/date).
async function fetchRRHistoryAll(m){
  const ids=memberIdentities(m);
  if(ids.length===1) return fetchRRHistory(m.name, m.tag);
  const lists=await Promise.all(ids.map(x=>fetchRRHistory(x.name, x.tag).catch(()=>[])));
  return mergeRRclient(...lists);
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
/* ===================== CACHE LOCAL (affichage instantané) =====================
   On garde dans le navigateur de quoi peindre l'écran AVANT que l'API réponde,
   puis on rafraîchit systématiquement en arrière-plan (le cache ne remplace
   jamais un appel : il évite juste l'écran vide).

   Ce qu'on stocke est une projection MINCE. Mesuré sur 20 parties :
     brut de l'API v4 ......... 4 134 Ko
     normalisé tel quel .......   972 Ko   (dont 579 de détail par round)
     projection mince .........     8,9 Ko
   Stocker le normalisé ferait exploser le quota (~5 Mo) dès le 5e membre ; le
   détail par round et le scoreboard complet restent donc dehors — ils sont de
   toute façon rechargeables à la demande. */
const CACHE_KEY = 'cosmo.cache';
const CACHE_SCHEMA = 1;          // À INCRÉMENTER dès que la forme change ci-dessous.
let CACHE = null;

function cacheLoad(){
  if(CACHE) return CACHE;
  CACHE = { v:CACHE_SCHEMA, ranks:{}, profiles:{} };
  try{
    const raw = localStorage.getItem(CACHE_KEY);
    if(raw){
      const d = JSON.parse(raw);
      // Un cache écrit par une version antérieure n'a pas la même forme :
      // le relire produirait un affichage cassé. On le jette.
      if(d && d.v === CACHE_SCHEMA) CACHE = { v:CACHE_SCHEMA, ranks:d.ranks||{}, profiles:d.profiles||{} };
    }
  }catch(e){ /* navigation privée, stockage bloqué… : on tourne sans cache */ }
  return CACHE;
}

function cacheSave(){
  if(!CACHE) return false;
  try{ localStorage.setItem(CACHE_KEY, JSON.stringify(CACHE)); return true; }
  catch(e){
    // Quota dépassé : on évince les profils les plus anciens, un par un.
    const old = Object.keys(CACHE.profiles).sort((a,b)=>(CACHE.profiles[a].ts||0)-(CACHE.profiles[b].ts||0));
    while(old.length){
      delete CACHE.profiles[old.shift()];
      try{ localStorage.setItem(CACHE_KEY, JSON.stringify(CACHE)); return true; }catch(e2){}
    }
    return false;   // stockage inutilisable : l'app fonctionne, sans instantané
  }
}

// Projection mince d'une partie normalisée. `ctx` permet de reconstruire le
// détail du calcul de l'indice (qui contient des fonctions, donc non sérialisable).
function slimMatch(M){
  const s = M && M.me;
  return {
    id:M.id, map:M.map, mode:M.mode, started:M.started, startedMs:M.startedMs,
    durMs:M.durMs||0, rounds:M.rounds, result:M.result,
    myScore:M.myScore, oppScore:M.oppScore, forfeit:!!M.forfeit,
    myTeamId:M.myTeamId, party:M.party||null, rr:M.rr||null, season:M.season||null,
    me: s ? { k:s.k, d:s.d, a:s.a, hs:s.hs, acs:s.acs, adr:s.adr, dd:s.dd, kd:s.kd,
              rounds:s.rounds, kast:s.kast==null?null:s.kast, shots:s.shots,
              name:s.name, tag:s.tag, team:s.team, agent:s.agent, agentId:s.agentId,
              score100:s.score100, placement:s.placement==null?null:s.placement,
              ctx:s.ctx||null } : null,
  };
}

// Reconstruit une partie utilisable depuis la projection. Même forme qu'une
// partie compacte du blob : un seul joueur, détail complet chargeable au clic.
function rehydrateMatch(s){
  if(!s || !s.id) return null;
  let me = null;
  if(s.me){
    me = Object.assign({}, s.me);
    delete me.ctx;
    if(s.me.ctx){ me.detail = perfDetail(me, s.me.ctx); me.ctx = s.me.ctx; }
    me.score100 = s.me.score100;      // on réaffiche la note telle qu'elle était
  }
  return { id:s.id, map:s.map, mode:s.mode, started:s.started, startedMs:s.startedMs,
    durMs:s.durMs, rounds:s.rounds, result:s.result, myScore:s.myScore, oppScore:s.oppScore,
    forfeit:s.forfeit, myTeamId:s.myTeamId, party:s.party, rr:s.rr, season:s.season,
    players:[], lines: me ? [me] : [], facts:null, partial:true, cached:true, me };
}

function cacheGetProfile(key){
  const c=cacheLoad(); const p=c.profiles[String(key).toLowerCase()];
  return (p && Array.isArray(p.matches)) ? p : null;
}
function cachePutProfile(key, data){
  const c=cacheLoad();
  c.profiles[String(key).toLowerCase()] = {
    ts: Date.now(), mmr: data.mmr||null,
    matches: (data.matches||[]).map(slimMatch),
    rr: data.rr||[],
  };
  cacheSave();
}
function cacheGetRank(key){ const c=cacheLoad(); return c.ranks[String(key).toLowerCase()]||null; }
function cachePutRank(key, rank){
  const c=cacheLoad();
  c.ranks[String(key).toLowerCase()] = Object.assign({ ts:Date.now() }, rank);
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
// Les rôles arrivent en anglais : on les traduit nous-mêmes plutôt que de
// dépendre du paramètre de langue de valorant-api (qui peut changer de libellé).
const ROLE_FR = { Duelist:'Duelliste', Initiator:'Initiateur', Controller:'Contrôleur', Sentinel:'Sentinelle' };
const ROLES = ['Duelliste','Initiateur','Contrôleur','Sentinelle'];

async function ensureAgents(){
  if(AGENTS) return AGENTS;
  try{
    const r = await fetch('https://valorant-api.com/v1/agents?isPlayableCharacter=true');
    if(r.ok){
      const d = await r.json(), map = {}, list = [];
      (d.data||[]).forEach(ag=>{
        if(!ag.displayName) return;
        if(ag.displayIcon) map[ag.displayName.toLowerCase()] = ag.displayIcon;
        const en = ag.role && ag.role.displayName;
        list.push({ name:ag.displayName, uuid:ag.uuid,
                    role: ROLE_FR[en] || en || '', icon: ag.displayIcon || '',
                    portrait: ag.fullPortrait || '' });
      });
      AGENTS = map;
      if(list.length) AGENT_LIST = list.sort((a,b)=>a.name.localeCompare(b.name));
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
    o.ctx = { rounds: ctx.rounds != null ? ctx.rounds : o.rounds, forfeit: !!ctx.forfeit,
              win: ctx.winByTeam ? ctx.winByTeam[o.team] : undefined,
              rel: useLobby ? (n - rank[i]) / (n - 1) * 100 : null,
              rank: useLobby ? rank[i] : null, lobbyN: useLobby ? n : null };
  });
  return lines;
}

// Ligne unique (format compact du blob) : pas de contexte de lobby.
function statline(p,rounds,ctx){
  const o=rawLine(p,rounds);
  const c=Object.assign({rounds}, ctx||{});
  const d=perfDetail(o, c);
  o.score100=d.score; o.detail=d; o.ctx=c;
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
function normMatch(m, targetState = STATE, opts){
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
  // Le détail par round (timeline, duels, éco) pèse ~28 Ko par partie et coûte
  // cher à extraire : on ne le calcule que si l'appelant va s'en servir.
  const wantFacts = !opts || opts.facts !== false;
  const facts = (me && wantFacts) ? matchFacts(m, rounds, me) : null;
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
function normStored(entry, targetState = STATE){   // format compact : jamais de détail de round
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
function normalizeAny(raw, targetState = STATE, opts){
  if(!raw || typeof raw!=='object') return null;
  if(raw.metadata) return normMatch(raw, targetState, opts);
  if(raw.meta && raw.stats) return normStored(raw, targetState);
  return normMatch(raw, targetState, opts); // repli défensif (guards en place)
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
    others.forEach(e=>{ mates[e.key]=mates[e.key]||{ key:e.key, name:e.name, tag:e.tag, color:e.color, guest:!!e.guest, n:0 }; mates[e.key].n++; });
    if(M.party && M.party.size>0){
      partyKnown++;
      partyMax=Math.max(partyMax, M.party.size);
      partyExtra=Math.max(partyExtra, M.party.size-size);   // joueurs ni squad ni invités
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
      const r=per[e.key]||(per[e.key]={ key:e.key, name:e.name, tag:e.tag, color:e.color, guest:!!e.guest, matches:[] });
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
let SQUAD_HIST = null;       // clé roster -> ses parties normalisées (depuis les blobs)
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
  sessionRoster().forEach(m=>{ const k=memberKey(m); byName[k]=m; byKey[k]=m; });
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
      addSquadEntry(idx, M.id, { key, name:m.name, tag:m.tag, color:m.color||'', team:p.team_id, guest:!!m.guest });
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
    const hist = SQUAD_HIST || (SQUAD_HIST = {});
    // Les invités ont rarement un historique stocké (le cron ne les visite pas) :
    // la lecture est tentée quand même, et leurs stats viennent sinon du
    // scoreboard des parties (cf. mateMatch).
    const people = sessionRoster();
    const [lists, rrLists] = await Promise.all([
      Promise.all(people.map(m=>fetchHistoriqueAll(m).catch(()=>[]))),
      Promise.all(people.map(m=>fetchRRHistoryAll(m).catch(()=>[]))),
    ]);
    people.forEach((m,i)=>{
      const key=memberKey(m), target={ puuid:null, name:m.name, tag:m.tag };
      const rrIdx=rrIndexFromSeries(rrLists[i]||[]);
      hist[key]=[];
      (lists[i]||[]).forEach(raw=>{
        let M=null;
        try{ M=normalizeAny(raw, target); }catch(e){ M=null; }
        if(!M || !M.id) return;
        if(rrIdx[M.id]){ M.rr=rrIdx[M.id]; M.season=rrIdx[M.id].season; }
        hist[key].push(M);
        const pu=M.players && M.players[0] && M.players[0].puuid;
        if(pu) PUUID_MEMBER[pu]=key;
        addSquadEntry(idx, M.id, { key, name:m.name, tag:m.tag, color:m.color||'', team:M.myTeamId, guest:!!m.guest, M });
      });
    });
    // Un puuid appris tardivement peut rattacher des parties complètes vues avant.
    indexSquadFromFullMatches(STATE.allMatches, idx);
    SQUAD_BLOBS_DONE=true; SQUAD_LOADING=null;
    return idx;
  })();
  return SQUAD_LOADING;
}

/* --- Records de session -----------------------------------------------------
   Le « best of » d'une période, calculé sur les sessions déjà découpées. Une
   session d'une ou deux parties ne peut pas être une meilleure/pire session :
   l'échantillon serait ridicule, on exige RECORD_MIN_GAMES parties. */
const RECORD_MIN_GAMES = 3;

// Plus longue série de victoires d'affilée. Elle peut traverser des sessions
// (c'est bien le but), donc elle se calcule sur les parties, pas sur les sessions.
function bestStreak(matches){
  const P=(matches||[]).filter(M=>M && M.me).slice().sort((a,b)=>a.startedMs-b.startedMs);
  let best=0, cur=0, end=-1;
  P.forEach((M,i)=>{
    if(M.result==='w'){ cur++; if(cur>best){ best=cur; end=i; } }
    else cur=0;
  });
  if(best<2) return null;                       // « série » de 1, ça n'existe pas
  return { n:best, from:P[end-best+1], to:P[end] };
}

// ctx : { squadIndex, selfKey, minGames }
function sessionRecords(sessions, ctx){
  ctx=ctx||{};
  const minG=ctx.minGames!=null?ctx.minGames:RECORD_MIN_GAMES;
  const rows=(sessions||[]).map(s=>({
    s, st:sessionStats(s.matches),
    mates: ctx.squadIndex ? sessionComposition(s.matches, ctx.squadIndex, ctx.selfKey).mates : [],
  })).filter(r=>r.st.n>0);
  if(!rows.length) return [];

  const big=rows.filter(r=>r.st.n>=minG && r.st.index!=null);
  const top=(list,cmp)=>list.length?list.slice().sort(cmp)[0]:null;
  const out=[];
  // value/sub sont évalués ICI, avec la ligne complète {s, st, mates} : le record
  // produit ne porte que des chaînes prêtes à afficher.
  const add=(key,label,icon,r,value,sub)=>{
    if(!r) return;
    out.push({ key, label, icon, session:r.s, st:r.st,
      value: typeof value==='function' ? value(r) : value,
      sub:   typeof sub==='function'   ? sub(r)   : sub });
  };
  const when=r=>fmtDay(r.s.startMs);
  const wl=r=>`${r.st.wins}V-${r.st.losses}D`;
  const games=r=>`${r.st.n} partie${r.st.n>1?'s':''}`;

  add('best','Meilleure session','🔥', top(big,(a,b)=>b.st.index-a.st.index),
      r=>Math.round(r.st.index), r=>`${when(r)} · ${games(r)} · ${wl(r)}`);
  add('worst','Pire session','💀', top(big,(a,b)=>a.st.index-b.st.index),
      r=>Math.round(r.st.index), r=>`${when(r)} · ${games(r)} · ${wl(r)}`);

  const rr=rows.filter(r=>r.st.rrNet!=null);
  const up=top(rr.filter(r=>r.st.rrNet>0),(a,b)=>b.st.rrNet-a.st.rrNet);
  const dn=top(rr.filter(r=>r.st.rrNet<0),(a,b)=>a.st.rrNet-b.st.rrNet);
  add('rrup','Plus grosse remontée','📈', up, r=>'+'+r.st.rrNet+' RR', r=>`${when(r)} · ${games(r)} · ${wl(r)}`);
  add('rrdown','Plus grosse chute','📉', dn, r=>r.st.rrNet+' RR', r=>`${when(r)} · ${games(r)} · ${wl(r)}`);

  add('long','Session la plus longue','⏱', top(rows,(a,b)=>b.st.n-a.st.n || b.s.durationMs-a.s.durationMs),
      r=>r.st.n+' partie'+(r.st.n>1?'s':''), r=>`${when(r)} · ${fmtDur(r.s.durationMs)} · ${wl(r)}`);

  const team=big.filter(r=>r.mates.length>0);
  add('team','Meilleure session commune','🤝', top(team,(a,b)=>b.st.index-a.st.index),
      r=>Math.round(r.st.index), r=>`${when(r)} · avec ${r.mates.map(m=>m.name).join(', ')}`);

  // La série de victoires n'appartient à aucune session en particulier : on la
  // rattache à celle où elle s'est terminée, pour que le clic mène quelque part.
  const streak=bestStreak(rows.reduce((a,r)=>a.concat(r.s.matches),[]));
  if(streak){
    const host=rows.find(r=>r.s.matches.some(M=>M.id===streak.to.id));
    if(host) out.push({ key:'streak', label:'Plus longue série', icon:'⚡',
      value: streak.n+' victoires',
      sub: fmtSpan(streak.from.startedMs, streak.to.startedMs),
      session:host.s, st:host.st });
  }
  return out;
}

/* --- Alertes de session (accueil) -------------------------------------------
   Un bandeau discret quand une session récente mérite qu'on en parle : surtout
   la session trop longue qui part en vrille, mais aussi les gros mouvements de
   RR — pour que le bandeau ne soit pas qu'un rabat-joie.

   Source : les blobs d'historique uniquement (aucun appel HenrikDev sur
   l'accueil). Conséquence assumée : une session jouée ce soir n'apparaît
   qu'une fois le blob rafraîchi (cron de 04:00 UTC, ou ouverture du profil). */
const ALERT_DAYS = 2;          // au-delà de 48 h, on ne montre rien
// Seuils recalibrés sur les sessions réelles de la squad (mesurées : 2 à 7
// parties, RR net entre -46 et +68). À 6 parties et ±40 RR, des soirées à
// +68 RR ne déclenchaient rien du tout.
const ALERT_MIN_GAMES = 5;     // en dessous, « session trop longue » n'a pas de sens
const ALERT_TILT = -8;         // baisse d'indice entre les deux moitiés
const ALERT_RR = 30;           // mouvement de RR jugé notable

const DAY_PART = h => h<5 ? 'nuit' : (h<12 ? 'matin' : (h<18 ? 'après-midi' : 'soir'));

// Une « journée de jeu » ne coupe pas à minuit mais à 5 h du matin : une partie
// jouée dimanche à 2 h appartient à la soirée du SAMEDI, pas au dimanche. Sans
// ça, une session à cheval sur minuit compte pour deux jours et le bandeau
// annonce « hier soir » une partie finie il y a une heure.
const DAY_CUTOFF_H = 5;
function gamingDayStart(ms){
  const d=new Date(ms - DAY_CUTOFF_H*3600000);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
// « hier soir », « ce matin », « il y a 3 jours » — jamais une date brute.
function relDay(ms, nowMs){
  const d=new Date(ms);
  // Écart en JOURNÉES DE JEU : à 2 h du matin, la session de 23 h reste « ce soir ».
  const diff=Math.round((gamingDayStart(nowMs||Date.now())-gamingDayStart(ms))/86400000);
  const p=DAY_PART(d.getHours());
  if(diff<=0) return p==='nuit' ? 'cette nuit' : (p==='après-midi' ? 'cet après-midi' : 'ce '+p);
  if(diff===1) return p==='nuit' ? 'la nuit dernière' : 'hier '+p;
  return `il y a ${diff} jours`;
}

// perMember : [{ member, matches }] (parties normalisées, tous modes).
function sessionAlerts(perMember, opts){
  opts=opts||{};
  const now=opts.now||Date.now();
  const since=now - (opts.days||ALERT_DAYS)*86400000;
  const out=[];
  (perMember||[]).forEach(entry=>{
    if(!entry || !entry.member) return;
    buildSessions(rankedOnly(entry.matches), opts.gapMs).forEach(s=>{
      if(s.endMs < since || s.startMs > now) return;
      const st=sessionStats(s.matches), tr=sessionTrend(s.matches);
      const base={ member:entry.member, session:s, st, trend:tr, when:relDay(s.startMs, now) };

      // Une session qui rapporte du RR n'est pas « partie en vrille », même si
      // les dernières parties étaient moins bonnes : on ne fait pas la leçon à
      // quelqu'un qui vient de gagner 68 RR. Le tilt n'a de sens que si la
      // soirée s'est mal terminée dans les faits.
      const gagnee = st.rrNet!=null ? st.rrNet>=ALERT_RR : (st.winrate!=null && st.winrate>=60);
      if(st.n>=ALERT_MIN_GAMES && tr && tr.delta<=ALERT_TILT && !gagnee){
        const tail=tr.n-Math.ceil(tr.n/2);
        out.push({ ...base, kind:'tilt', tone:'warn', icon:'📉',
          severity: 100 + Math.abs(tr.delta),
          text:`${st.n} parties d'affilée ${base.when} — les ${tail} dernières bien en dessous (indice ${tr.first} → ${tr.last}).` });
      }
      if(st.rrNet!=null && st.rrNet<=-ALERT_RR){
        out.push({ ...base, kind:'rrdrop', tone:'bad', icon:'🩸',
          severity: 60 + Math.abs(st.rrNet),
          text:`${st.rrNet} RR ${base.when} en ${st.n} partie${st.n>1?'s':''} (${st.wins}V-${st.losses}D).` });
      }
      // Pas de condition sur la tendance : une soirée à +68 RR est une bonne
      // nouvelle, même si la dernière partie était moins bonne.
      if(st.rrNet!=null && st.rrNet>=ALERT_RR){
        out.push({ ...base, kind:'hot', tone:'good', icon:'🚀',
          severity: 50 + st.rrNet,
          text:`+${st.rrNet} RR ${base.when} en ${st.n} partie${st.n>1?'s':''} (${st.wins}V-${st.losses}D).` });
      }

      // Récapitulatif, toujours produit : même sans rien de spectaculaire, on
      // montre ce qui a été joué. Un bandeau vide en permanence donne
      // l'impression que la fonctionnalité est cassée, et « 5 parties hier,
      // 2V-3D, -10 RR » reste une information. Sa gravité est volontairement
      // sous celle de tous les autres cas : il ne prend la place que si rien
      // de plus marquant n'a eu lieu ce jour-là.
      const rrTxt = st.rrNet!=null ? `, ${signed(st.rrNet)} RR` : '';
      out.push({ ...base, kind:'recap', tone:'info', icon:'🎮',
        severity: Math.min(40, st.n),
        text:`${st.n} partie${st.n>1?'s':''} ${base.when} — ${st.wins}V-${st.losses}D${rrTxt}, indice ${Math.round(st.index||0)}.` });
    });
  });
  // UNE SEULE alerte : celle de la session la plus récente, tous membres
  // confondus. Rien d'autre — un bandeau qui empile plusieurs évènements de
  // plusieurs jours devient un mur qu'on ne lit plus.
  if(!out.length) return [];
  let last=null;
  out.forEach(a=>{
    if(!last) { last=a; return; }
    if(a.session.endMs > last.session.endMs) { last=a; return; }
    // Même session : on garde le constat le plus marquant.
    if(a.session.endMs === last.session.endMs && a.severity > last.severity) last=a;
  });
  return [last];
}

/* --- Lien de partage d'une session ------------------------------------------
   Pas de stockage ni de nouvelle fonction serverless : le lien porte QUI et
   QUAND, et la page recalcule le rapport depuis les mêmes données publiques.
   Il reste donc toujours cohérent avec le site, et rien n'expire. */
function shareParams(){
  try{ return new URLSearchParams(location.search); }catch(e){ return new URLSearchParams(''); }
}
function sessionShareURL(s, who){
  const id=who||STATE;
  const u=new URL(location.href);
  u.search=''; u.hash='';
  u.searchParams.set('s', `${id.name}#${id.tag}`);
  u.searchParams.set('t', String(s.startMs));
  u.searchParams.set('g', String(SESSION_GAP_MIN));
  return u.toString();
}
// Cible d'un lien partagé, lue dans l'URL. `g` est borné : une valeur farfelue
// changerait le découpage et ferait pointer le lien sur une autre session.
function parseShareTarget(search){
  const p=typeof search==='string' ? new URLSearchParams(search) : (search||shareParams());
  const s=p.get('s'), t=p.get('t');
  if(!s || !t) return null;
  const i=s.lastIndexOf('#');
  if(i<1 || i===s.length-1) return null;
  const ts=Number(t);
  if(!ts || !isFinite(ts)) return null;
  const g=parseInt(p.get('g'),10);
  return { name:s.slice(0,i), tag:s.slice(i+1), ts,
           gap:(g>=15 && g<=720) ? g : null };
}
// Retrouve la session visée. Tolérant : le découpage a pu bouger entre-temps
// (historique qui s'allonge, coupure différente), on accepte un recouvrement.
function findSessionAt(sessions, ts){
  if(!ts) return null;
  const list=sessions||[];
  return list.find(x=>x.startMs===ts)
      || list.find(x=>ts>=x.startMs && ts<=x.endMs)
      || list.reduce((best,x)=>{
           const d=Math.abs(x.startMs-ts);
           return (d<=6*3600000 && (!best || d<Math.abs(best.startMs-ts))) ? x : best;
         }, null);
}

// Un changement de roster (pseudo, membre ajouté/retiré) invalide l'index.
function resetSquadIndex(){
  SQUAD_INDEX=null; SQUAD_HIST=null; SQUAD_LOADING=null; SQUAD_BLOBS_DONE=false; PUUID_MEMBER={};
}

/* ===================== COMPOS PAR MAP =====================
   Quelles compositions gagnent, map par map.

   D'où viennent les données. Les blobs d'historique ne contiennent qu'UN
   joueur par partie (c'est tout ce que renvoie stored-matches) : on n'y voit
   jamais de compo. Le jeu `COMPS` vient d'un autre endpoint, rejoué partie par
   partie, qui donne les 10 joueurs. Chaque partie fournit donc DEUX compos
   réelles avec leur résultat : la nôtre et celle d'en face.

   Les deux échelles :
   - « Observé »  : les deux camps de toutes les parties connues. C'est la
     population la plus large qu'on puisse mesurer honnêtement. Ce n'est PAS un
     winrate mondial — aucune API publique ne donne ça — et l'écran le dit.
   - « COSMO »    : seulement le camp où un membre jouait.

   Toutes les statistiques affichées sont mesurées. Rien n'est estimé. */

let COMPS = [];                 // [{id,map,mode,at,sides,t:[[5],[5]],r,w}]
let COMPS_LOADED = false;
let COMPS_LOADING = null;
let COMPS_SRC = '';             // provenance, pour l'afficher

// En dessous, un « winrate » ne veut plus rien dire : 2 parties sur 2 gagnées
// ne fait pas une bonne compo. Les seuils diffèrent car les populations n'ont
// pas du tout la même taille (une compo exacte est bien plus rare qu'un rôle).
// Pas de « compo exacte à 5 » : mesuré sur l'historique complet, UNE seule
// atteignait 4 parties sur 13 maps. Un classement qui reste vide n'est pas un
// classement. Le noyau à 3, lui, se répète vraiment (227 trios sur 10 maps).
const COMPO_MIN = { roles: 8, trio: 6, agent: 10, duo: 6 };

// Borne basse de l'intervalle de Wilson (95 %). C'est ELLE qui classe, jamais
// le winrate brut : sinon un 3/3 à 100 % passerait devant un 42/60 à 70 %.
// Plus l'échantillon est petit, plus la borne est prudente.
function wilsonLower(w, n){
  if(!n) return 0;
  const z=1.96, p=w/n, z2=z*z;
  return (p + z2/(2*n) - z*Math.sqrt((p*(1-p) + z2/(4*n))/n)) / (1 + z2/n);
}

// Rôle d'un agent, d'après la liste chargée depuis valorant-api.
function roleOf(agent){
  const a = AGENT_LIST.find(x=>x.name===agent);
  return (a && a.role) || null;
}

// Signature de rôles d'une compo : « 2-1-1-1 » dans l'ordre fixe de ROLES.
// Renvoie null si un agent n'a pas de rôle connu — une signature incomplète
// serait rangée avec les autres et fausserait le décompte.
function roleSig(agents){
  const c={}; ROLES.forEach(r=>c[r]=0);
  for(const a of (agents||[])){
    const r = roleOf(a);
    if(!r) return null;
    c[r]++;
  }
  return ROLES.map(r=>c[r]).join('-');
}

// « 2-1-1-1 » -> « 2 Duellistes · 1 Initiateur · 1 Contrôleur · 1 Sentinelle ».
// Les quatre rôles prennent un simple « s » au pluriel.
function roleSigLabel(sig){
  return String(sig||'').split('-').map((n,i)=>{
    n=Number(n)||0;
    return n ? `${n} ${ROLES[i]||'?'}${n>1?'s':''}` : null;
  }).filter(Boolean).join(' · ');
}

/* Toutes les lignes « une équipe dans une partie », selon l'échelle demandée.
   scope 'cosmo' : on ne garde que le camp d'un membre COSMO, retrouvé via
   l'index d'escouade (match_id -> membres, avec leur camp). */
function compRows(comps, scope, squadIndex, opts){
  const o = opts||{};
  const out=[];
  for(const c of (comps||[])){
    if(!c || !Array.isArray(c.t) || c.w == null) continue;
    if(o.map && c.map !== o.map) continue;
    if(o.mode !== 'all' && !isRanked({ mode:c.mode })) continue;
    if(o.since && (c.at||0) < o.since) continue;

    if(scope==='cosmo'){
      const mates = (squadIndex && squadIndex[c.id]) || [];
      // On exige un camp connu : un membre sans camp ne permet pas de savoir
      // LAQUELLE des deux compos était la nôtre.
      // Deux membres peuvent en théorie tomber dans des camps opposés (file
      // solo). Mesuré sur l'historique : 0 cas sur 376 parties à 2+ membres —
      // ils jouent toujours ensemble. On prend quand même le camp majoritaire
      // plutôt que le premier venu, et on renonce en cas d'égalité : mieux vaut
      // écarter une partie que compter la compo adverse comme la nôtre.
      const bySide = {};
      mates.forEach(m=>{ if(m && m.team) bySide[m.team]=(bySide[m.team]||0)+1; });
      const ranked = Object.entries(bySide).sort((a,b)=>b[1]-a[1]);
      if(!ranked.length) continue;
      if(ranked.length > 1 && ranked[0][1] === ranked[1][1]) continue;
      const side = ranked[0][0];
      const i = (c.sides||[]).indexOf(side);
      if(i < 0 || !c.t[i]) continue;
      out.push({ id:c.id, map:c.map, at:c.at, agents:c.t[i], won:c.w===i,
                 draw:c.w<0, rounds:(c.r||[])[i], mates:mates.length });
    } else {
      (c.t||[]).forEach((agents,i)=>{
        if(!agents || !agents.length) return;
        out.push({ id:c.id, map:c.map, at:c.at, agents, won:c.w===i,
                   draw:c.w<0, rounds:(c.r||[])[i] });
      });
    }
  }
  return out;
}

// Agrège des lignes par clé, et classe par borne de Wilson.
// `keys(row)` renvoie 0..n clés : un agent apparaît dans 5 clés, une compo
// dans une seule.
function tally(rows, keys, min){
  const acc={};
  for(const r of rows||[]){
    if(r.draw) continue;                       // une égalité ne tranche rien
    for(const k of keys(r)){
      const e = acc[k] || (acc[k] = { key:k, n:0, w:0 });
      e.n++; if(r.won) e.w++;
    }
  }
  return Object.values(acc)
    .filter(e=>e.n >= (min||1))
    .map(e=>({ ...e, wr:e.w/e.n, score:wilsonLower(e.w,e.n) }))
    .sort((a,b)=> b.score-a.score || b.n-a.n);
}

// Les paires d'agents d'une compo (10 paires pour 5 agents), en clé stable.
function agentPairs(agents){
  const a=(agents||[]).slice().sort(), out=[];
  for(let i=0;i<a.length;i++) for(let j=i+1;j<a.length;j++) out.push(a[i]+' + '+a[j]);
  return out;
}

// Les trios (10 pour 5 agents). C'est le bon grain : une compo entière ne se
// rejoue presque jamais, un noyau à 3 si.
function agentTrios(agents){
  const a=(agents||[]).slice().sort(), out=[];
  for(let i=0;i<a.length;i++) for(let j=i+1;j<a.length;j++) for(let k=j+1;k<a.length;k++)
    out.push(a[i]+' + '+a[j]+' + '+a[k]);
  return out;
}

/* Le tableau complet d'une map, pour une échelle donnée. */
function mapReport(comps, scope, squadIndex, opts){
  const rows = compRows(comps, scope, squadIndex, opts);
  const played = rows.length;
  const won = rows.filter(r=>r.won).length;
  const decided = rows.filter(r=>!r.draw).length;
  return {
    scope, played, won, decided,
    wr: decided ? won/decided : null,
    from: rows.length ? Math.min(...rows.map(r=>r.at||0)) : 0,
    to:   rows.length ? Math.max(...rows.map(r=>r.at||0)) : 0,
    roles:  tally(rows, r=>{ const s=roleSig(r.agents); return s?[s]:[]; }, COMPO_MIN.roles),
    trios:  tally(rows, r=>agentTrios(r.agents), COMPO_MIN.trio),
    agents: tally(rows, r=>r.agents, COMPO_MIN.agent),
    duos:   tally(rows, r=>agentPairs(r.agents), COMPO_MIN.duo),
  };
}

// Les maps disponibles, la plus jouée d'abord.
function compMaps(comps, opts){
  const o=opts||{}, c={};
  (comps||[]).forEach(x=>{
    if(!x || !x.map) return;
    if(o.mode !== 'all' && !isRanked({ mode:x.mode })) return;
    // Même borne que le classement : sinon une map figurerait au menu grâce à
    // des parties que le classement, lui, écarte — et l'écran serait vide.
    if(o.since && (x.at||0) < o.since) return;
    c[x.map]=(c[x.map]||0)+1;
  });
  return Object.entries(c).sort((a,b)=>b[1]-a[1]).map(([map,n])=>({ map, n }));
}

/* ===================== ROULETTE =====================
   Le destin choisit qui joue et avec quel agent, pour les modes autres que la
   ranked. Toute la logique de tirage est ici, séparée de l'animation : elle est
   ainsi testable, et l'animation ne fait que la mettre en scène. */

// Tirage sans remise. `rnd` est injectable pour rendre les tests déterministes.
function pickMany(pool, n, rnd){
  const r = rnd || Math.random;
  const left = (pool||[]).slice();
  const out = [];
  while(out.length < n && left.length) out.push(left.splice(Math.floor(r()*left.length), 1)[0]);
  return out;
}
const pickOne = (pool, rnd) => pickMany(pool, 1, rnd)[0] || null;

// Agents disponibles, éventuellement restreints à un rôle.
function agentsForRole(role, list){
  const all = list || AGENT_LIST;
  if(!role || role==='all') return all.slice();
  return all.filter(a=>a.role===role);
}

// Combien de fois chaque agent a été joué, d'après l'historique déjà chargé.
// Sert au mode « à tester » : le but est de sortir de ses habitudes.
function agentPlayCounts(matches){
  const c={};
  (matches||[]).forEach(M=>{ const a=M && M.me && M.me.agent; if(a) c[a]=(c[a]||0)+1; });
  return c;
}

/* Restreint un vivier aux agents les MOINS joués. On ne se contente pas de
   filtrer les inconnus : quand tout a déjà été joué, on garde ceux qui le sont
   le moins, sinon le mode « à tester » ne renverrait plus rien. */
function freshAgents(pool, counts){
  if(!pool || !pool.length) return [];
  const c = counts || {};
  const min = Math.min(...pool.map(a=>c[a.name]||0));
  return pool.filter(a=>(c[a.name]||0)===min);
}

/* Répartit des rôles sur `total` places : autant de places que demandé par rôle,
   le reste en « libre » (n'importe quel agent). */
function compoSlots(counts, total){
  const slots=[];
  ROLES.forEach(r=>{ for(let i=0;i<((counts&&counts[r])||0);i++) slots.push(r); });
  while(slots.length < total) slots.push(null);
  return slots.slice(0, total);
}

/* Attribue un agent à CHAQUE personne fournie. Les joueurs ne sont plus tirés au
   sort — le groupe est déjà formé, c'est l'appelant qui décide qui joue. Ce qui
   est tiré, c'est la répartition des rôles sur les joueurs, puis l'agent.
   opts : { slots:[role|null], fresh, counts:{clé->comptes}, list, rnd } */
function rollComposition(people, opts){
  opts = opts || {};
  const rnd = opts.rnd || Math.random;
  const list = opts.list || AGENT_LIST;
  const team = (people||[]).slice();
  if(!team.length) return [];
  // Les places sont mélangées : à compo identique, ce n'est pas toujours la même
  // personne qui hérite du même rôle.
  const base = opts.slots && opts.slots.length ? opts.slots.slice(0, team.length) : [];
  while(base.length < team.length) base.push(null);
  const slots = pickMany(base, base.length, rnd);
  const counts = opts.counts || {};
  const used = {};                    // deux joueurs ne prennent pas le même agent

  return team.map((p,i)=>{
    const role = slots[i] || null;
    let pool = agentsForRole(role, list).filter(a=>!used[a.name]);
    if(!pool.length) pool = agentsForRole(role, list);   // plus assez d'agents : doublon toléré
    if(opts.fresh) pool = freshAgents(pool, counts[memberKey(p)] || {});
    const agent = pickOne(pool, rnd);
    if(agent) used[agent.name] = true;
    return { person:p, agent, role: agent ? agent.role : role };
  });
}

/* ===================== VOYANT DE FRAÎCHEUR =====================
   Quatre états, dont un seul est ACTIONNABLE (le rouge). Une donnée vieille de
   3 minutes n'est pas fausse : elle mérite de l'orange, pas une alarme. */
const FRESH = {
  home:    { state:'idle', ts:0, err:'' },
  profile: { state:'idle', ts:0, err:'' },
};
const FRESH_LABEL = { idle:'—', cached:'en cache', loading:'mise à jour…', ok:'à jour', error:'échec · réessayer' };

function freshAge(ts){
  if(!ts) return '';
  const s=Math.max(0, Math.round((Date.now()-ts)/1000));
  if(s<45) return "à l'instant";
  const m=Math.round(s/60);
  if(m<60) return `il y a ${m} min`;
  const h=Math.round(m/60);
  return h<24 ? `il y a ${h} h` : `il y a ${Math.round(h/24)} j`;
}

function setFresh(scope, state, extra){
  const f=FRESH[scope]; if(!f) return;
  f.state=state;
  if(extra && extra.ts) f.ts=extra.ts;
  f.err=(extra && extra.err) || '';
  renderFresh();
}

function renderFresh(){
  ['home','profile'].forEach(scope=>{
    const el=$('fresh'+scope[0].toUpperCase()+scope.slice(1));
    if(!el) return;
    const f=FRESH[scope];
    if(f.state==='idle'){ el.hidden=true; return; }
    el.hidden=false;
    el.className='fresh '+f.state;
    const age=freshAge(f.ts);
    let lbl=FRESH_LABEL[f.state];
    if(f.state==='ok' && age && age!=="à l'instant") lbl=age;
    if(f.state==='cached') lbl=age ? 'en cache · '+age : 'en cache';
    el.innerHTML=`<span class="fdot"></span><span class="flbl">${esc(lbl)}</span>`;
    el.title = f.state==='error'
      ? `Dernier rafraîchissement échoué : ${f.err}. Clique pour réessayer.`
      : (f.state==='loading' ? 'Mise à jour en cours…'
        : `Données ${f.state==='ok'?'à jour':'affichées depuis le cache'}${age?' ('+age+')':''}. Clique pour rafraîchir.`);
  });
}
// L'âge doit vieillir tout seul, sinon « à l'instant » reste affiché 20 minutes.
// Le tic s'arrête dès que l'onglet passe en arrière-plan : inutile de réveiller
// un téléphone pour rafraîchir un libellé que personne ne regarde.
let FRESH_TIMER=null;
function freshTick(){
  FRESH_TIMER=null;
  if(typeof document!=='undefined' && document.hidden) return;   // reprendra au retour
  renderFresh();
  startFreshTicker();
}
function startFreshTicker(){
  if(FRESH_TIMER || typeof setTimeout!=='function') return;
  if(typeof document!=='undefined' && document.hidden) return;
  FRESH_TIMER=setTimeout(freshTick, 30000);
  // Sous Node (tests), un timer en attente retiendrait le processus.
  if(FRESH_TIMER && typeof FRESH_TIMER.unref==='function') FRESH_TIMER.unref();
}
function stopFreshTicker(){
  if(FRESH_TIMER && typeof clearTimeout==='function') clearTimeout(FRESH_TIMER);
  FRESH_TIMER=null;
}

/* ===================== HOME & PROFIL ===================== */
// Peint les rangs depuis le cache (instantané), puis rafraîchit toujours, par
// paquets : 8 appels HenrikDev simultanés, c'est la rafale qui sort des 429.
const RANK_POOL = 3;

function paintRank(i, r){
  const el=$('rank-'+i); if(!el || !r) return;
  if(!r.tier){ el.textContent='non classé'; return; }
  const rrTxt=r.rr!=null?' · '+r.rr+' RR':'';
  el.innerHTML=`${r.icon?`<img class="rankicon" src="${esc(r.icon)}" alt="${esc(r.tier)}" loading="lazy">`:''}<span>${esc(r.tier)}${rrTxt}</span>`;
}

async function fillRanks(){
  RANKS_FILLED = true;
  // 1) Instantané : ce qu'on savait la dernière fois.
  let newest=0;
  ROSTER.forEach((m,i)=>{
    const c=cacheGetRank(memberKey(m));
    const el=$('rank-'+i);
    if(c){ paintRank(i,c); newest=Math.max(newest,c.ts||0); }
    else if(el) el.textContent='rang…';
  });
  setFresh('home', newest?'cached':'loading', { ts:newest });

  await ensureTiers();
  const region=REGION();
  setFresh('home','loading',{ ts:newest });

  // 2) Rafraîchissement systématique, en paquets.
  let failed=0, lastErr=null;
  await pooled(ROSTER, RANK_POOL, async (m, )=>{
    const i=ROSTER.indexOf(m);
    try{
      const d=(await api(`/valorant/v3/mmr/${region}/pc/${enc(m.name)}/${enc(m.tag)}`)).data||{};
      const cur=d.current||d.current_data||{};
      const rank={ tier:(cur.tier&&cur.tier.name)||cur.currenttierpatched||'',
                   rr:(cur.rr!=null?cur.rr:cur.ranking_in_tier), icon:rankIcon(cur,(cur.tier&&cur.tier.name)||cur.currenttierpatched||'') };
      cachePutRank(memberKey(m), rank);
      paintRank(i, rank);
    }catch(e){
      failed++; lastErr=e;
      // On garde la valeur en cache à l'écran : mieux qu'un « rang n/c ».
      if(!cacheGetRank(memberKey(m))){ const el=$('rank-'+i); if(el) el.textContent='rang n/c'; }
    }
  });
  cacheSave();
  if(failed) setFresh('home','error',{ ts:newest||Date.now(), err:apiErrMsg(lastErr)+` (${failed}/${ROSTER.length})` });
  else setFresh('home','ok',{ ts:Date.now() });
}
function toggleSheet(){ $('sheet').hidden=!$('sheet').hidden; }
function showHome(){
  $('profile').hidden = true;
  $('tribunal').hidden = true;
  $('leaderboard').hidden = true;
  const rou=$('roulette'); if(rou) rou.hidden = true;
  const cmp=$('comps'); if(cmp) cmp.hidden = true;
  $('home').hidden = false;
  window.scrollTo(0,0);
  // On nettoie les paramètres de partage : un rafraîchissement depuis l'accueil
  // ne doit pas rouvrir le rapport qu'on vient de quitter.
  SHARE_TARGET=null; SHARE_MISS=false;
  try{
    if(location.search && shareParams().get('s') && history.replaceState)
      history.replaceState(null, '', location.pathname);
  }catch(e){}
  // Rangs et alertes ne sont pas chargés quand on arrive par un lien partagé.
  if(!RANKS_FILLED) fillRanks();
  loadHomeAlerts();
  refreshHomeAlerts();   // tient compte des parties fraîches vues sur un profil
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
      fetchRRHistoryAll(m),
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
  
  // La partie ouverte reste surlignée après un rafraîchissement en arrière-plan.
  if(SELECTED_ID){
    const keep = filtered.find(M=>M.id===SELECTED_ID);
    if(keep){
      SELECTED_IDX = STATE.matches.indexOf(keep);
      document.querySelectorAll('.mrow').forEach(el=>el.classList.toggle('sel', +el.dataset.idx === SELECTED_IDX));
    }
  }
}

// Ajoute un dégradé sur les conteneurs qui débordent vraiment horizontalement,
// pour signaler qu'on peut les faire défiler (surtout au doigt sur mobile).
function markScrollable(){
  const els=['agentStats','mapStats'].map(id=>$(id))
    .concat([...document.querySelectorAll('.sx-tablewrap')]);
  els.forEach(el=>{
    if(!el) return;
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
// Intervalle compact : « du 24 au 26 août », « le 26 août ». La version longue
// (« jusqu'au mercredi 26 août (depuis le lundi 24 août) ») ne tenait pas sur
// une ligne de téléphone.
function fmtSpan(fromMs, toMs){
  const a=new Date(fromMs), b=new Date(toMs);
  const day=x=>`${x.getDate()} ${FR_MONTHS[x.getMonth()]}`;
  if(a.getDate()===b.getDate() && a.getMonth()===b.getMonth()) return `le ${day(b)}`;
  if(a.getMonth()===b.getMonth()) return `du ${a.getDate()} au ${day(b)}`;
  return `du ${day(a)} au ${day(b)}`;
}
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
let RECORDS_DAYS=0;          // fenêtre des records en jours (0 = tout l'historique)
let SHARE_TARGET=null;       // session visée par un lien partagé, en attente d'ouverture
let SHARE_MISS=false;        // le lien pointait sur une session introuvable

function compChip(comp){
  if(!comp) return '';
  // Un invité est nommé comme les autres, avec une astérisque discrète : il
  // compte comme partenaire de jeu, mais il n'est pas de la squad.
  const names=comp.mates.slice(0,3).map(m=>esc(m.name)+(m.guest?'*':'')).join(', ');
  const extra=comp.mates.length>3?` +${comp.mates.length-3}`:'';
  const label=comp.label+(comp.mixed?'*':'');
  return `<span class="sx-comp s${comp.dominant}">${esc(label)}${names?' · '+names+extra:''}</span>`;
}

function renderSessions(){
  const host=$('sxList'); if(!host) return;
  const selfKey=memberKey(STATE);
  const miss = SHARE_MISS
    ? `<div class="sx-miss">Le lien partagé pointe sur une session absente de cet historique. Elle est peut-être trop ancienne, ou la coupure a changé depuis. Les sessions ci-dessous restent accessibles.</div>` : '';
  let list=SESSIONS;
  if(SESSIONS_ONLY_COMMON) list=list.filter(s=>sessionComposition(s.matches, SQUAD_INDEX, selfKey).mates.length>0);
  if(!list.length){
    host.innerHTML=miss+`<div class="md-empty">${SESSIONS_ONLY_COMMON
      ? 'Aucune session classée jouée avec un autre membre de la squad dans cet historique.'
      : 'Aucune partie classée dans l\'historique — les rapports de session ne prennent en compte que le mode classé.'}</div>`;
    const more=$('btnSxMore'); if(more) more.hidden=true;
    return;
  }
  const shown=list.slice(0, SESSIONS_SHOWN);
  host.innerHTML=miss+shown.map(s=>{
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

function renderRecords(){
  const host=$('recList'); if(!host) return;
  const cut = RECORDS_DAYS ? Date.now() - RECORDS_DAYS*86400000 : 0;
  const inRange = SESSIONS.filter(s=>s.startMs>=cut);
  const recs = sessionRecords(inRange, { squadIndex:SQUAD_INDEX, selfKey:memberKey(STATE) });
  if(!recs.length){
    host.innerHTML=`<div class="md-empty">Pas encore de quoi établir des records sur cette période — il faut au moins une session de ${RECORD_MIN_GAMES} parties classées.</div>`;
    return;
  }
  host.innerHTML=recs.map(r=>`
    <button class="rec" type="button" data-sx="${esc(r.session.key)}" title="Voir le rapport de cette session">
      <span class="rec-ico">${r.icon}</span>
      <span class="rec-body">
        <span class="rec-lab">${esc(r.label)}</span>
        <span class="rec-val">${esc(r.value)}</span>
        <span class="rec-sub">${esc(r.sub)}</span>
      </span>
    </button>`).join('');
}

/* --- Partage d'une session ------------------------------------------------- */
async function copyShareLink(url, btn){
  let ok=false;
  try{
    if(navigator.clipboard && navigator.clipboard.writeText){ await navigator.clipboard.writeText(url); ok=true; }
  }catch(e){ ok=false; }
  if(!ok){
    // Repli (http, vieux navigateurs, permission refusée) : sélection + copie.
    try{
      const ta=document.createElement('textarea');
      ta.value=url; ta.setAttribute('readonly',''); ta.style.position='fixed'; ta.style.opacity='0';
      document.body.appendChild(ta); ta.select();
      ok=document.execCommand('copy');
      document.body.removeChild(ta);
    }catch(e){ ok=false; }
  }
  if(!ok){ const f=$('sxShareUrl'); if(f){ f.hidden=false; f.select&&f.select(); } }
  if(btn){
    const old=btn.textContent;
    btn.textContent = ok ? '✓ Lien copié' : '⚠ Copie impossible';
    btn.classList.toggle('done', ok);
    setTimeout(()=>{ btn.textContent=old; btn.classList.remove('done'); }, 2200);
  }
  // Si la copie échoue, le champ ci-dessus prend le relais : le lien reste
  // sélectionnable à la main.
  return ok;
}

// Ouvre le profil d'un membre depuis un « pseudo#tag ». Les anciens pseudos sont
// acceptés : un lien partagé avant un renommage continue de fonctionner.
function openProfileByKey(name, tag){
  const k=String(name+'#'+tag).toLowerCase();
  const i=ROSTER.findIndex(m=>memberKey(m)===k || memberAliases(m).some(a=>memberKey(a)===k));
  if(i<0) return false;
  openProfile(i);
  return true;
}

// Ouvre la session visée par un lien partagé, une fois les données prêtes.
function consumeShareTarget(){
  if(!SHARE_TARGET) return;
  const k=String(SHARE_TARGET.name+'#'+SHARE_TARGET.tag).toLowerCase();
  const mine = memberKey(STATE)===k || memberAliases(STATE).some(a=>memberKey(a)===k);
  if(!mine) return;                       // le profil ouvert n'est pas celui du lien
  const s=findSessionAt(SESSIONS, SHARE_TARGET.ts);
  SHARE_TARGET=null;
  if(s){ SHARE_MISS=false; openSessionReport(s.key); }
  else { SHARE_MISS=true; renderSessions(); }
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

  const shareURL=sessionShareURL(s);
  const squad=sessionSquadReport(s, SQUAD_INDEX, selfKey);
  const common=squad.length>1 ? `
    <div class="md-sec">Rapport commun · ${squad.length} joueurs</div>
    <div class="sx-tablewrap"><table class="sb"><thead><tr>
      <th>Joueur</th><th>N</th><th>V-D</th><th>Indice</th><th>ACS</th><th>K/D</th><th>RR</th>
    </tr></thead><tbody>${squad.map(r=>{
      const rt=tierOf(Math.round(r.st.index||0));
      return `<tr${r.self?' class="sx-self"':''}>
        <td><b>${esc(r.name)}</b>${r.self?' <em>(toi)</em>':(r.guest?' <em>(invité)</em>':'')}</td>
        <td>${r.n}</td>
        <td><b class="w">${r.st.wins}</b>-<b class="l">${r.st.losses}</b></td>
        <td class="scell" style="color:${rt.c}">${Math.round(r.st.index||0)}</td>
        <td>${Math.round(r.st.acs||0)}</td>
        <td>${(r.st.kd||0).toFixed(2)}</td>
        <td class="${(r.st.rrNet||0)>=0?'up':'dn'}">${r.st.rrNet!=null?signed(r.st.rrNet):'—'}</td>
      </tr>`;
    }).join('')}</tbody></table></div>
    <div class="md-none">Les joueurs listés sont ceux qui étaient dans TON équipe sur au moins une partie de la session. Leurs chiffres viennent de leur propre historique quand on l'a, sinon du scoreboard de la partie. Les <em>invités</em> ne font pas partie de la squad : ils n'apparaissent que dans les rapports de session.</div>`
    : `<div class="md-sec">Rapport commun</div>
       <div class="md-empty">Session jouée seul — rien à comparer en commun.</div>`;

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
    }).join('')}</tbody></table></div>

    <div class="sx-share">
      <button class="btn" id="sxShareBtn" type="button" data-url="${esc(shareURL)}">🔗 Copier le lien de la session</button>
      <!-- Repli : révélé seulement si la copie échoue (permission refusée, http). -->
      <input class="sx-url" id="sxShareUrl" readonly hidden value="${esc(shareURL)}" aria-label="Lien de la session">
    </div>`;

  modalOpen('sessionModal');
}
function closeSessionReport(){ modalClose('sessionModal'); }

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
  renderSessions(); renderRecords();
  // Un lien partagé s'ouvre APRÈS les historiques de la squad : le rapport
  // commun est justement ce qu'on partage, autant qu'il soit complet.
  const after=()=>{ renderSessions(); renderRecords(); consumeShareTarget(); };
  if(!SQUAD_BLOBS_DONE) ensureSquadHistories().then(after).catch(after);
  else after();
}

/* ============ MODALES ============
   Verrou de défilement partagé : une modale ouverte au-dessus d'une autre ne
   doit pas déverrouiller la page en se fermant. */
function modalOpen(id){
  const m=$(id); if(!m) return;
  m.hidden=false;
  document.body.classList.add('modal-open');
}
function modalClose(id){
  const m=$(id); if(m) m.hidden=true;
  if(!document.querySelector('.modal:not([hidden])')) document.body.classList.remove('modal-open');
}
// La plus haute modale ouverte, pour qu'Échap ne ferme qu'elle.
function topModal(){
  const order=['scoreModal','matchModal','sessionModal'];
  return order.find(id=>{ const m=$(id); return m && !m.hidden; }) || null;
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
  modalOpen('scoreModal');
}
function closeScoreDetail(){ modalClose('scoreModal'); }

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

/* ============ MODALE UNIQUE D'UNE PARTIE ============
   Scoreboard + détail complet au même endroit : cliquer une partie de la liste
   ouvre tout d'un coup, au lieu d'un scoreboard en bas de page et d'un second
   bouton pour les détails. */

// Scoreboard d'une partie. Renvoie aussi la version « détaillée » utilisée, car
// une partie compacte du blob peut avoir son détail complet chargé entre-temps.
function scoreboardHTML(M){
  const rawDetail=(M.partial && M.id && MATCH_DETAILS[M.id]) ? MATCH_DETAILS[M.id] : null;
  const detail = rawDetail ? normMatch(rawDetail) : M;
  const partialNow = !!M.partial && !rawDetail;
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
      ? `<div class="sbnote">Scoreboard complet indisponible pour cette partie (trop ancienne ou hors API).</div>`
      : `<div class="sbnote">Chargement du scoreboard complet…</div>`;
  }
  const html=`<div class="sx-tablewrap"><table class="sb"><thead><tr><th>#</th><th class="pcol">Joueur</th><th>Indice</th><th>ACS</th><th>K/D/A</th><th>+/–</th><th>HS%</th><th>ADR</th></tr></thead>
    <tbody><tr><td colspan="8" class="teamlabel blue">Ta team — ${detail.myScore} rounds</td></tr>${sbRows(blue)}
    <tr><td colspan="8" class="teamlabel red">Adverse — ${detail.oppScore} rounds</td></tr>${sbRows(red)}</tbody></table></div>${note}`;
  return { html, detail, partialNow };
}

// Déroulé chiffré : mi-temps et meilleure série. Déductible de la timeline sans
// hypothèse sur les côtés (l'API ne dit pas qui attaque en premier).
function matchFlowHTML(f){
  const t=f.timeline; if(!t.length) return '';
  const seg=(a,b)=>{ const r=t.slice(a,b); return r.length?{w:r.filter(x=>x.won).length,l:r.filter(x=>!x.won).length}:null; };
  const h1=seg(0,12), h2=seg(12,24), ot=seg(24,t.length);
  let best=0,cur=0; t.forEach(r=>{ if(r.won){ cur++; if(cur>best) best=cur; } else cur=0; });
  const sh=x=>x?`<b><span class="wv">${x.w}</span>–<span class="lv">${x.l}</span></b>`:'<b>—</b>';
  return `<div class="md-sec">Déroulé</div>
    <div class="md-tiles">
      <div class="md-tile">${sh(h1)}<span>1<sup>re</sup> mi-temps</span></div>
      <div class="md-tile">${sh(h2)}<span>2<sup>de</sup> mi-temps</span></div>
      ${ot?`<div class="md-tile">${sh(ot)}<span>prolongations</span></div>`:''}
      <div class="md-tile"><b>${best}</b><span>meilleure série</span></div>
      <div class="md-tile"><b>${t.length}</b><span>rounds joués</span></div>
    </div>`;
}

// Sections détaillées (nécessitent les données de round).
function factsHTML(f){
  const mk=Object.keys(f.multi).sort();
  const tile=(v,l,cls='')=>`<div class="md-tile ${cls}"><b>${v}</b><span>${esc(l)}</span></div>`;
  const maxD=Math.max(1,...f.duels.map(d=>Math.max(d.dealt,d.received)));
  const aces=mk.filter(k=>+k>=5).reduce((a,k)=>a+f.multi[k],0);
  return `
    <div class="md-sec">Timeline <em>clique un round pour son détail</em></div>
    <div class="md-timeline" id="mdTimeline">${f.timeline.map(r=>roundChip(r,r.n===1)).join('')}</div>
    <div class="md-round" id="mdRound"></div>

    ${matchFlowHTML(f)}

    <div class="md-sec">Faits d'armes${aces?` <em>${aces} ace${aces>1?'s':''} !</em>`:''}</div>
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
}

function renderMatchModal(i){
  const M=STATE.matches[i], body=$('matchModalBody');
  if(!M||!body) return;
  const sb=scoreboardHTML(M);
  const f=M.facts;
  FACTS_CUR=f||null;
  const t=tierOf(M.me?M.me.score100:0);
  const dur=M.durMs?fmtDur(M.durMs):'';
  const rr=(M.rr && M.rr.change!=null) ? ` · <span class="${M.rr.change>=0?'up':'dn'}">${M.rr.change>=0?'+':''}${M.rr.change} RR</span>` : '';

  body.innerHTML=`
    <div class="sd-head">
      <div class="scorebadge score-hero sd" id="mdHeroScore" title="Voir le détail du calcul" style="--sc:${t.c}">${M.me?M.me.score100:'—'}<span class="out">/100</span></div>
      <div>
        <div class="sd-tier" style="color:${M.result==='w'?'var(--win)':'var(--loss)'}">${M.result==='w'?'VICTOIRE':'DÉFAITE'} ${M.myScore}–${M.oppScore}</div>
        <h3>${esc(M.map)}</h3>
        <div class="sd-sub mono">${esc(M.mode)}${M.me?' · '+esc(M.me.agent):''} · ${esc(relTime(M.started))}${dur?' · '+dur:''}${rr}</div>
      </div>
    </div>

    <div class="md-sec">Scoreboard <em>clique un indice pour le détail du calcul</em></div>
    ${sb.html}

    ${f ? factsHTML(f) : `<div class="md-empty mono">Détail round par round indisponible pour cette partie —
      il n'est fourni que par l'API sur les parties récentes.</div>`}`;
  if(f) renderRoundDetail(1);
  markScrollable();
}

// Ouvre la partie i : scoreboard + détail, dans une seule modale.
function openMatch(i){
  const M=STATE.matches[i]; if(!M) return;
  SELECTED_IDX=i; SELECTED_ID=M.id||null;
  document.querySelectorAll('.mrow').forEach(el=>el.classList.toggle('sel', +el.dataset.idx === i));
  renderMatchModal(i);
  modalOpen('matchModal');

  // Partie compacte : on va chercher le détail complet, puis on ré-affiche.
  if(M.partial && M.id && !(M.id in MATCH_DETAILS)){
    DETAIL_PENDING[M.id]=true;
    fetchMatchDetail(M.id).finally(()=>{
      delete DETAIL_PENDING[M.id];
      // Le détail complet apporte le KAST : on met à jour l'indice de cette partie
      // pour que la liste et le scoreboard affichent la même note.
      const raw=MATCH_DETAILS[M.id];
      if(raw){
        const full=normMatch(raw);
        if(full && full.me){ M.me=Object.assign(full.me,{placement:M.me&&M.me.placement}); M.lines=full.lines; M.facts=full.facts; M.partial=false; }
      }
      renderList();
      if(SELECTED_IDX===i && !$('matchModal').hidden) renderMatchModal(i);
    });
  }
}
function closeMatchFacts(){ modalClose('matchModal'); }

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

function openProfile(idx){
  const m=ROSTER[idx];
  if(!m) return;
  STATE={puuid:null,allMatches:[],matches:[],name:m.name,tag:m.tag,alias:m.alias||null};
  PROFILE_SHOWN = FRESH_SIZE;
  SELECTED_IDX=-1; SELECTED_ID=null;

  const bustSrc = esc(m.customImg || `${MEDIA}/${m.uuid}/fullportrait.png`); // bustportrait.png n'existe pas (404) chez valorant-api

  $('phead').innerHTML=`
    <div class="pbust ${m.customImg?'custom':''}" style="--pc:${esc(m.color)}">
      <img src="${bustSrc}" alt="${esc(m.agent)}">
      <div class="mg">${esc(m.agent.slice(0,2))}</div>
    </div>
    <div><div class="eb" style="color:${esc(m.color)}">${esc(m.agent)} · ${esc(m.role)}</div><h1>${esc(m.name)}<b>#${esc(m.tag)}</b></h1></div>
    <div class="ptools"><button class="fresh" id="freshProfile" type="button" hidden></button><button class="btn refresh">Rafraîchir</button></div>`;

  const bust=$('phead').querySelector('.pbust img');
  if(bust){const pb=bust.closest('.pbust');const f=()=>{bust.style.display='none';if(pb)pb.classList.add('noimg');};bust.addEventListener('error',f);if(bust.complete&&bust.naturalWidth===0)f();}
  $('home').hidden=true; $('tribunal').hidden=true; $('leaderboard').hidden=true; if($('roulette')) $('roulette').hidden=true; if($('comps')) $('comps').hidden=true; $('profile').hidden=false; window.scrollTo(0,0);

  CURRENT_MODE = 'all';
  document.querySelectorAll('#modeTabs button').forEach(x => x.classList.toggle('on', x.dataset.mode === 'all'));
  renderFresh();   // le voyant vient d'être recréé avec le phead
  loadProfile();
}

// Peint tout le profil depuis l'état courant, qu'il vienne du cache ou de l'API.
function paintProfile(mmr){
  const scored=STATE.matches.slice(0,8).filter(M=>M.me);
  const overall=scored.length?Math.round(scored.reduce((s,M)=>s+M.me.score100,0)/scored.length):0;
  ELO_TIER_OFFSET = computeEloTierOffset(RR_FULL);   // aligne les paliers sur les vrais rangs
  populateSeasonFilter();
  populateStatsSeasonFilter();
  populateCompareFilter();
  renderRank(mmr, overall); renderCurvePeriod(); renderPeakActs(); refreshSessions();
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
  updateMoreBtn();
}

/* Charge un profil en deux temps :
   1. peinture IMMÉDIATE depuis le cache local (aucun écran d'attente) ;
   2. rafraîchissement systématique en arrière-plan — on ne saute jamais l'appel,
      pour qu'une partie qui vient de finir apparaisse tout de suite.
   Si le rafraîchissement échoue (429, réseau) et qu'on avait du cache à l'écran,
   on GARDE l'affichage et on le signale : une erreur ne doit pas vider la page. */
async function loadProfile(){
  const region=REGION(), n=enc(STATE.name), t=enc(STATE.tag);
  const key=memberKey(STATE);
  const cached=cacheGetProfile(key);
  let painted=false;

  if(cached && cached.matches.length){
    try{
      STATE.puuid=cached.puuid||null;
      STATE.allMatches=cached.matches.map(rehydrateMatch).filter(Boolean);
      PROFILE_SHOWN=Math.min(FRESH_SIZE, STATE.allMatches.length);
      STATE.matches=STATE.allMatches.slice(0, PROFILE_SHOWN);
      RR_FULL=cached.rr||[];
      paintProfile(cached.mmr||{tier:'',rr:null,elo:null,peak:'',icon:null});
      clearStatus(); $('app').hidden=false;
      painted=true;
    }catch(e){ painted=false; }   // cache douteux : on retombe sur le chargement normal
  }
  if(!painted){ $('app').hidden=true; status('load','Récupération des données HenrikDev…'); }
  setFresh('profile','loading',{ ts: painted ? cached.ts : 0 });

  try{
    const acc=await api(`/valorant/v2/account/${n}/${t}`);
    STATE.puuid=acc.data&&acc.data.puuid;
    const [mmrR,histR,matchR,blobR,rrBlobR]=await Promise.allSettled([
      api(`/valorant/v3/mmr/${region}/pc/${n}/${t}`),
      api(`/valorant/v2/mmr-history/${region}/pc/${n}/${t}`),
      api(`/valorant/v4/matches/${region}/pc/${n}/${t}?size=${FRESH_SIZE}`), // données fraîches du moment
      fetchHistoriqueAll(STATE),                                              // historique matchs accumulé (blob + anciens pseudos)
      fetchRRHistoryAll(STATE)                                                // progression RR accumulée (blob + anciens pseudos)
    ]);
    // Si les trois appels HenrikDev ont échoué, il n'y a rien de neuf à montrer.
    const allDown = [mmrR,histR,matchR].every(r=>r.status==='rejected');
    if(allDown) throw (matchR.reason || histR.reason || mmrR.reason || new Error('indisponible'));

    // Caches médias : têtes d'agents (scoreboard), icônes de rang et fonds de map
    await Promise.all([ensureTiers(), ensureAgents(), ensureMaps()]);

    let mmr={tier:'',rr:null,elo:null,peak:'',icon:null};
    if(mmrR.status==='fulfilled'){ const d=mmrR.value.data||{}; const cur=d.current||d.current_data||{};
      const tierName=(cur.tier&&cur.tier.name)||cur.currenttierpatched||'';
      mmr={tier:tierName, rr:(cur.rr!=null?cur.rr:cur.ranking_in_tier), elo:cur.elo, icon:rankIcon(cur,tierName),
           peak:(d.peak&&d.peak.tier&&d.peak.tier.name)||(d.highest_rank&&d.highest_rank.patched_tier)||''}; }
    else if(cached && cached.mmr) mmr=cached.mmr;   // le rang seul a échoué : on garde le dernier connu

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
    RR_FULL = rrSeries;

    paintProfile(mmr);
    clearStatus(); $('app').hidden=false;
    setFresh('profile','ok',{ ts:Date.now() });
    // Le bandeau d'accueil doit connaître la session qu'on vient de jouer.
    feedSquadHist(key, STATE.allMatches);

    // Cache : de quoi repeindre cet écran instantanément la prochaine fois.
    try{
      cachePutProfile(key, { mmr, matches:STATE.allMatches, rr:rrSeries });
      const c=cacheLoad(); if(c.profiles[key]) { c.profiles[key].puuid=STATE.puuid; cacheSave(); }
    }catch(e){}

    // Fait grossir le blob de ce joueur, mais PLUS TARD : lancé tout de suite,
    // il s'ajouterait à la rafale d'appels qu'on vient de faire.
    const who={name:STATE.name, tag:STATE.tag};
    setTimeout(()=>{ if(memberKey(STATE)===memberKey(who)) saveHistorique(who.name, who.tag, region); }, 5000);
  }catch(e){
    if(painted){
      // On garde ce qui est à l'écran : le voyant dit que c'est périmé.
      setFresh('profile','error',{ ts:cached.ts, err:apiErrMsg(e) });
    }else{
      setFresh('profile','error',{ ts:0, err:apiErrMsg(e) });
      status('err','<b>Erreur API :</b> '+apiErrMsg(e));
    }
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
// Seuils de PERFORMANCE. L'arc de la jauge en découle directement, pour que la
// position de l'aiguille corresponde toujours à la zone annoncée.
const TRIB_PERF_HIGH = 72;   // nettement au-dessus de la moyenne (~64 avec la courbe)
const TRIB_PERF_LOW  = 60;   // nettement en dessous
const TRIB_STEADY    = 10;   // écart-type au-delà duquel c'est en dents de scie

// L'arc mesure la PERF, pas le verdict : le verdict, lui, croise perf et
// résultat et s'affiche en toutes lettres sous la jauge.
const Z=[
  {from:0,               to:TRIB_PERF_LOW,  color:"var(--bad)",     label:"FAIBLE"},
  {from:TRIB_PERF_LOW,   to:TRIB_PERF_HIGH, color:"var(--unlucky)", label:"CORRECT"},
  {from:TRIB_PERF_HIGH,  to:100,            color:"var(--cracked)", label:"ÉNORME"},
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

/* Verdict du tribunal (v2).

   L'ancienne version décidait sur le SEUL indice moyen : « UNLUCKY » n'était
   qu'une note médiane, ce qui n'a rien à voir avec la chance. Le mot est
   maintenant tranché en croisant deux axes indépendants :
     - la PERFORMANCE (indice moyen, pondéré par les rounds) ;
     - le RÉSULTAT (RR net, à défaut le winrate).
   Bien jouer et perdre, c'est UNLUCKY. Mal jouer et gagner, c'est PORTÉ.
   L'aiguille continue d'indiquer la performance : à aiguille identique, le
   verdict peut différer — c'est précisément l'information. */
// La phrase s'adapte au résultat : « moyen » ne veut pas dire la même chose
// selon que la fenêtre se solde par des victoires ou des défaites.
const VERDICTS = {
  CRACKED: { color:'var(--cracked)', line:()=>"Tu es juste trop fort pour ce lobby." },
  UNLUCKY: { color:'var(--unlucky)', line:()=>"Tu as fait ta part. C'est ailleurs que ça a lâché." },
  MOYEN:   { color:'var(--muted)',   line:(good,bad)=> bad
              ? "Tu as fait le taf, sans réussir à renverser quoi que ce soit."
              : (good ? "Correct sans plus — mais le bilan est bon."
                      : "Ni bon ni mauvais. Une fenêtre parfaitement quelconque.") },
  PORTÉ:   { color:'var(--muted)',   line:()=>"Les résultats sont là. Pas grâce à toi." },
  BAD:     { color:'var(--bad)',     line:()=>"Soyons honnêtes : le problème, c'était toi." },
};

function computeVerdict(matches, n) {
  const gs = rankedOnly((matches||[]).filter(m => m && m.me)).slice(0, n);
  if(!gs.length) return { tier:'?', avg:0, line:'Pas de parties classées trouvées.',
                          pct:'Lance quelques ranked !', color:'var(--muted)' };

  const st = sessionStats(gs);                       // pondéré par les rounds
  const avg = Math.round(st.index || 0);
  const idx = gs.map(g => g.me.score100);
  const m0 = idx.reduce((a,v)=>a+v,0)/idx.length;
  const sd = Math.sqrt(idx.reduce((a,v)=>a+(v-m0)*(v-m0),0)/idx.length);

  // Sessions récentes reconstruites sur la fenêtre analysée : combien sont
  // parties en vrille ? C'est la « régularité » à l'échelle d'une soirée.
  const sessions = buildSessions(gs);
  const tilted = sessions.filter(s => { const t = sessionTrend(s.matches); return t && t.delta <= ALERT_TILT; }).length;

  const resGood = st.rrNet != null ? st.rrNet > 0 : (st.winrate != null && st.winrate >= 55);
  const resBad  = st.rrNet != null ? st.rrNet < 0 : (st.winrate != null && st.winrate <= 45);
  const perfHigh = avg >= TRIB_PERF_HIGH, perfLow = avg < TRIB_PERF_LOW;

  // BAD est réservé à une perf réellement basse : au-dessus de TRIB_PERF_LOW,
  // perdre ne suffit pas à faire de toi le problème.
  let tier;
  if(perfHigh && resBad)      tier = 'UNLUCKY';
  else if(perfHigh)           tier = 'CRACKED';
  else if(perfLow && resGood) tier = 'PORTÉ';
  else if(perfLow)            tier = 'BAD';
  else                        tier = 'MOYEN';

  // Détail : les chiffres qui JUSTIFIENT le verdict, pas une redite.
  const bits = [`indice ${avg}/100`];
  if(st.rrNet != null) bits.push(`${st.rrNet >= 0 ? '+' : ''}${st.rrNet} RR sur ${st.rrGames} partie${st.rrGames>1?'s':''}`);
  else if(st.winrate != null) bits.push(`${Math.round(st.winrate)}% de victoires (${st.wins}V-${st.losses}D)`);
  bits.push(sd <= TRIB_STEADY ? `régulier (σ ${sd.toFixed(0)})` : `en dents de scie (σ ${sd.toFixed(0)})`);
  if(tilted) bits.push(`${tilted} session${tilted>1?'s':''} partie${tilted>1?'s':''} en vrille`);

  const v = VERDICTS[tier];
  return { tier, avg, line: v.line(resGood, resBad), pct: bits.join(' · '), color: v.color,
           rrNet: st.rrNet, winrate: st.winrate, stdev: sd, tilted, sessions: sessions.length };
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
    <button class="chip ${i === TRIB.active ? 'on' : ''}" style="--c:${esc(m.color)}" data-i="${i}">
      ${esc(m.name)}<b>#${esc(m.tag)}</b>
    </button>`).join('');
}

// Récupère les matchs de toute la squad : pour chaque membre, on combine les
// parties classées fraîches (v4) avec l'historique accumulé (blob), dédoublonné
// par matchid. Sert au tribunal ET au leaderboard.
// Le blob contient tous les modes : on garde ici uniquement le competitive pour
// préserver le caractère « ranked-only » du tribunal et du leaderboard.
// Exécute par petits paquets plutôt qu'en une rafale : 8 appels HenrikDev
// simultanés, c'est exactement le motif qui déclenche des 429.
const SQUAD_POOL = 3;
async function pooled(items, size, fn){
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  }
  return out;
}

async function loadSquadMatches(region) {
  return pooled(ROSTER, SQUAD_POOL, async (member) => {
    const pair = await Promise.allSettled([
      api(`/valorant/v4/matches/${region}/pc/${enc(member.name)}/${enc(member.tag)}?mode=competitive&size=15`),
      fetchHistoriqueAll(member),
      fetchRRHistoryAll(member),          // blob : le verdict juge sur le RR réel, pas sur le winrate
    ]);
    const freshOk = pair[0].status === 'fulfilled';
    const fresh = freshOk ? (pair[0].value.data || []) : [];
    const blob  = pair[1].status === 'fulfilled' ? (pair[1].value || []) : [];
    const rrIdx = rrIndexFromSeries(pair[2].status === 'fulfilled' ? (pair[2].value || []) : []);
    const data  = combineMatches(fresh, blob);
    // Ni le leaderboard ni le tribunal ne lisent le détail par round : on
    // économise ~3 Mo et ~100 ms sur une squad de 8.
    const norm  = data.map(m => normalizeAny(m, member, { facts:false }))
                      .filter(M => M && (M.mode || '').toLowerCase() === 'competitive');
    norm.forEach(M => { if(M.id && rrIdx[M.id]){ M.rr = rrIdx[M.id]; M.season = rrIdx[M.id].season; } });
    return { member, data, norm, freshFailed: !freshOk };
  });
}

// Nombre de membres dont le rafraîchissement a échoué (rate limit, réseau…).
// Leurs chiffres viennent alors du seul historique stocké : il faut le dire.
const squadStale = squads => (squads||[]).filter(s => s && s.freshFailed).length;

// Message honnête quand une partie de la squad n'a pas pu être rafraîchie :
// mieux vaut un classement annoté qu'un classement faux et silencieux.
function staleNote(squads){
  const n=squadStale(squads);
  if(!n) return '';
  return `<div class="sx-miss">${n} membre${n>1?'s n\'ont':' n\'a'} pas pu être rafraîchi${n>1?'s':''} (limite de l'API atteinte). `
    + `Leurs chiffres viennent du seul historique stocké et peuvent être en retard — réessaie dans une minute.</div>`;
}

async function loadTribunal() {
  $('home').hidden = true;
  $('profile').hidden = true;
  $('leaderboard').hidden = true;
  if($('roulette')) $('roulette').hidden = true;
  if($('comps')) $('comps').hidden = true;
  $('tribunal').hidden = false;
  $('appTrib').hidden = true;

  // Le leaderboard réutilisait déjà les données ; l'inverse n'était pas vrai.
  if (TRIB.matches && TRIB.matches.length) {
    TRIB.active = 0;
    renderTribMembers();
    resetStage('Trib');
    const warn0=staleNote(TRIB.matches);
    if(warn0) statusTrib('err', warn0); else clearStatusTrib();
    $('appTrib').hidden = false;
    return;
  }

  statusTrib('load', 'Convocation du tribunal (analyse des parties classées de chaque membre)...');
  const region = REGION();
  try {
    TRIB.matches = await loadSquadMatches(region);
    TRIB.active = 0;
    renderTribMembers();
    resetStage('Trib');
    clearStatusTrib();
    const warn=staleNote(TRIB.matches);
    if(warn) statusTrib('err', warn); else clearStatusTrib();
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
  if($('roulette')) $('roulette').hidden = true;
  if($('comps')) $('comps').hidden = true;
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
    const warn=staleNote(TRIB.matches);
    if(warn) statusLb('err', warn); else clearStatusLb();
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
  renderDuos();
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
    const bustSrc = esc(m.customImg || `${MEDIA}/${m.uuid}/fullportrait.png`); // bustportrait.png n'existe pas (404) chez valorant-api
    const bustImg = m.customImg
      ? `<img src="${bustSrc}" alt="" style="width:100%;left:0;top:0;height:100%;object-fit:cover;">`
      : `<img src="${bustSrc}" alt="">`;
    return `<div class="lb-row ${topClass} ${empty?'empty':''}">
      ${rankHtml}
      <div class="lb-bust" style="--pc:${esc(m.color)}">${bustImg}</div>
      <div class="lb-name"><b style="color:${esc(m.color)}">${esc(m.name)}</b><span>#${esc(m.tag)} · ${esc(m.agent)}</span></div>
      <div class="lb-stat"><div class="v" style="color:${empty?'var(--dim)':t.c}">${empty?'—':s.avg}</div><div class="l">indice</div></div>
      <div class="lb-stat hide-sm"><div class="v" style="color:${empty?'var(--dim)':wrColor}">${empty?'—':s.wr+'%'}</div><div class="l">winrate</div></div>
      <div class="lb-stat"><div class="v">${s.wins}/${s.count}</div><div class="l">parties</div></div>
    </div>`;
  }).join('');
}

/* ===================== DUOS DÉTECTÉS =====================
   Deux membres retrouvés dans la MÊME équipe sur une même partie (croisement
   par match_id, comme pour les sessions). L'intérêt n'est pas le winrate brut
   du duo mais son ÉCART avec le winrate de chacun quand il joue sans l'autre. */
const DUO_MIN_GAMES = 3;

function computeDuos(squads, minGames){
  const min = minGames!=null ? minGames : DUO_MIN_GAMES;
  const byMatch={}, byKey={};
  (squads||[]).forEach(sq=>{
    if(!sq || !sq.member) return;
    const k=memberKey(sq.member);
    byKey[k]=sq;
    (sq.norm||[]).forEach(M=>{ if(M && M.id) (byMatch[M.id]=byMatch[M.id]||[]).push({k, M}); });
  });

  const pairs={};
  Object.keys(byMatch).forEach(id=>{
    const l=byMatch[id];
    for(let i=0;i<l.length;i++) for(let j=i+1;j<l.length;j++){
      if(l[i].M.myTeamId!==l[j].M.myTeamId) continue;         // adversaires : pas un duo
      const x = l[i].k < l[j].k ? l[i] : l[j];
      const y = l[i].k < l[j].k ? l[j] : l[i];
      const pk = x.k+'|'+y.k;
      const p = pairs[pk] || (pairs[pk]={ a:x.k, b:y.k, n:0, wins:0, ids:{} });
      if(p.ids[id]) continue;                                  // une partie ne compte qu'une fois
      p.ids[id]=true; p.n++;
      if(x.M.result==='w') p.wins++;
    }
  });

  return Object.keys(pairs).map(pk=>{
    const p=pairs[pk], A=byKey[p.a], B=byKey[p.b];
    if(!A || !B) return null;
    // Winrate de chacun SANS l'autre : la vraie référence.
    const solo=sq=>{
      const rest=(sq.norm||[]).filter(M=>M && M.id && !p.ids[M.id]);
      return rest.length ? rest.filter(M=>M.result==='w').length/rest.length*100 : null;
    };
    const sa=solo(A), sb=solo(B);
    const base=(sa!=null && sb!=null) ? (sa+sb)/2 : (sa!=null?sa:sb);
    const wr=p.n ? p.wins/p.n*100 : 0;
    return { a:A.member, b:B.member, n:p.n, wins:p.wins, wr, base,
             delta: base!=null ? wr-base : null };
  }).filter(d=>d && d.n>=min).sort((x,y)=>y.n-x.n || y.wr-x.wr);
}

function renderDuos(){
  const host=$('duoList'); if(!host) return;
  const duos=computeDuos(TRIB.matches);
  if(!duos.length){
    host.innerHTML=`<div class="duo-empty">Aucun duo sur les parties chargées — il en faut au moins ${DUO_MIN_GAMES} dans la même équipe.</div>`;
    return;
  }
  host.innerHTML=duos.map(d=>{
    const wrC = d.wr>=50 ? 'var(--win)' : 'var(--loss)';
    const dl = d.delta==null ? '<b>—</b><span>vs séparés</span>'
      : `<b style="color:${d.delta>=0?'var(--win)':'var(--loss)'}">${d.delta>=0?'+':''}${Math.round(d.delta)}</b><span>vs séparés</span>`;
    return `<div class="duo-row">
      <div class="duo-pair"><b style="color:${esc(d.a.color)}">${esc(d.a.name)}</b><span class="duo-x">+</span><b style="color:${esc(d.b.color)}">${esc(d.b.name)}</b></div>
      <div class="duo-stat"><b>${d.n}</b><span>ensemble</span></div>
      <div class="duo-stat"><b style="color:${wrC}">${Math.round(d.wr)}%</b><span>winrate</span></div>
      <div class="duo-stat hide-sm">${dl}</div>
    </div>`;
  }).join('');
}

/* ===================== 1v1 COMPARATEUR ===================== */
function renderVsPickers() {
  const mk = (side, sel) => ROSTER.map((m, i) => `
    <button class="chip ${i === sel ? 'on' : ''}" style="--c:${esc(m.color)}" data-side="${side}" data-i="${i}">
      ${esc(m.name)}<b>#${esc(m.tag)}</b>
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

/* ===================== COMPOS — CHARGEMENT & AFFICHAGE ===================== */

let COMPO_MAP = null;          // map affichée (null = pas encore choisie)
let COMPO_SCOPE = 'global';    // global | cosmo
let COMPO_TAB = 'roles';       // roles | exact | agents | duos
/* Fenêtre par défaut : un an. Le stock remonte à 2023, mais les agents et les
   maps d'alors ne sont plus les mêmes — une compo « gagnante » d'il y a trois
   ans ne dit rien d'aujourd'hui. Un an garde l'essentiel du volume (mesuré :
   588 parties sur 635) en coupant la queue vraiment périmée. */
let COMPO_DAYS = 365;          // 0 = tout l'historique

/* Deux sources, fusionnées : comps.json (amorce versionnée, tout l'historique
   au moment du déploiement) et le blob entretenu par le cron (les parties
   d'après). Le blob est prioritaire, l'amorce comble le reste — même schéma
   que le roster. */
async function loadComps(){
  if(COMPS_LOADED) return COMPS;
  if(COMPS_LOADING) return COMPS_LOADING;
  COMPS_LOADING=(async()=>{
    const grab = async (url, pick) => {
      try{
        const r=await fetch(url);
        if(!r.ok) return [];
        const d=await r.json();
        const list=pick(d);
        return Array.isArray(list)?list:[];
      }catch(e){ return []; }
    };
    const [blob, seed] = await Promise.all([
      grab('/.netlify/functions/comps', d=>d && d.comps),
      grab('comps.json', d=>Array.isArray(d)?d:(d && d.comps)),
    ]);
    const byId=new Map();
    [...blob, ...seed].forEach(c=>{ if(c && c.id && !byId.has(c.id)) byId.set(c.id, c); });
    COMPS=[...byId.values()].sort((a,b)=>(b.at||0)-(a.at||0));
    COMPS_SRC = blob.length ? (seed.length?'blob + amorce':'blob') : (seed.length?'amorce':'');
    COMPS_LOADED=true; COMPS_LOADING=null;
    return COMPS;
  })();
  return COMPS_LOADING;
}

const compoPct = x => x==null ? '—' : Math.round(x*100)+'%';
// Le winrate colore la ligne, mais on reste sobre : au-dessus de 55 % c'est
// bon, en dessous de 45 % c'est mauvais, entre les deux ça ne dit rien.
const compoTone = wr => wr==null ? '' : (wr>=.55 ? ' good' : (wr<.45 ? ' bad' : ''));

// Les têtes d'agents d'une compo, quand on les a.
function compoFaces(agents){
  return (agents||[]).map(a=>{
    // AGENTS est indexé en minuscules (cf. ensureAgents) : sans ça, aucune
    // tête ne s'afficherait jamais, on n'aurait que les initiales.
    const ic = AGENTS && AGENTS[String(a||'').toLowerCase()];
    return ic ? `<img src="${esc(ic)}" alt="${esc(a)}" title="${esc(a)}" loading="lazy">`
              : `<span class="cmp-noface" title="${esc(a)}">${esc(a.slice(0,2))}</span>`;
  }).join('');
}

// Une ligne de classement. `faces` : la clé est une liste d'agents à illustrer.
function compoRow(e, i, opts){
  const o=opts||{};
  const label = o.label ? o.label(e.key) : e.key;
  const faces = o.faces ? `<div class="cmp-faces">${compoFaces(o.faces(e.key))}</div>` : '';
  return `<div class="cmp-row${compoTone(e.wr)}">
    <div class="cmp-rank mono">${i+1}</div>
    <div class="cmp-main">
      <div class="cmp-lbl">${esc(label)}</div>
      ${faces}
    </div>
    <div class="cmp-num">
      <b>${compoPct(e.wr)}</b>
      <span class="mono">${e.w}V / ${e.n - e.w}D</span>
    </div>
  </div>`;
}

const COMPO_TABS = [
  { id:'roles',  lbl:'Par rôles',   min:COMPO_MIN.roles  },
  { id:'trios',  lbl:'Trios',        min:COMPO_MIN.trio   },
  { id:'agents', lbl:'Agents',      min:COMPO_MIN.agent  },
  { id:'duos',   lbl:'Duos',        min:COMPO_MIN.duo    },
];

function compoListHTML(rep){
  const tab = COMPO_TABS.find(t=>t.id===COMPO_TAB) || COMPO_TABS[0];
  const list = (rep[COMPO_TAB]||[]).slice(0, 12);
  if(!list.length){
    // Le classement par rôles a besoin de la liste des agents (valorant-api).
    // Sans elle, aucune signature n'est calculable : le dire, plutôt que de
    // laisser croire qu'on manque de parties.
    if(COMPO_TAB==='roles' && !AGENT_LIST.length){
      return `<div class="cmp-empty">Les rôles des agents n'ont pas pu être chargés
        (valorant-api injoignable). Les autres classements restent disponibles.</div>`;
    }
    return `<div class="cmp-empty">Pas encore assez de parties sur cette map pour ce classement.
      Il en faut au moins ${tab.min} par ligne — en dessous, un pourcentage ne veut rien dire.</div>`;
  }
  const opts = COMPO_TAB==='roles'  ? { label:roleSigLabel }
             : COMPO_TAB==='agents' ? { faces:k=>[k] }
             : { faces:k=>k.split(' + ') };          // trios et duos
  return list.map((e,i)=>compoRow(e,i,opts)).join('');
}

function renderComps(){
  const host=$('cmpBody'); if(!host) return;

  const since = COMPO_DAYS ? Date.now() - COMPO_DAYS*86400000 : 0;
  const opts = { map:COMPO_MAP, mode:'ranked', since };
  const maps = compMaps(COMPS, { mode:'ranked', since });
  if(!maps.length){
    host.innerHTML = `<div class="cmp-empty">Aucune partie exploitable pour l'instant.
      Les compos se remplissent au fil du rafraîchissement quotidien.</div>`;
    const ms=$('cmpMaps'); if(ms) ms.innerHTML='';
    return;
  }
  if(!COMPO_MAP || !maps.some(m=>m.map===COMPO_MAP)) COMPO_MAP = maps[0].map;

  const ms=$('cmpMaps');
  if(ms) ms.innerHTML = maps.map(m=>
    `<button class="cmp-map${m.map===COMPO_MAP?' on':''}" type="button" data-cmap="${esc(m.map)}">
      ${esc(m.map)}<i class="mono">${m.n}</i></button>`).join('');

  document.querySelectorAll('#cmpScope button').forEach(b=>b.classList.toggle('on', b.dataset.scope===COMPO_SCOPE));
  document.querySelectorAll('#cmpTabs button').forEach(b=>b.classList.toggle('on', b.dataset.tab===COMPO_TAB));
  document.querySelectorAll('#cmpDays button').forEach(b=>b.classList.toggle('on', Number(b.dataset.days)===COMPO_DAYS));

  const rep = mapReport(COMPS, COMPO_SCOPE, SQUAD_INDEX, { ...opts, map:COMPO_MAP });

  const head = rep.played
    ? `<b>${rep.played}</b> compo${rep.played>1?'s':''} observée${rep.played>1?'s':''} sur ${esc(COMPO_MAP)}
       · winrate global <b>${compoPct(rep.wr)}</b>
       ${rep.from?`· ${new Date(rep.from).toLocaleDateString('fr-FR')} → ${new Date(rep.to).toLocaleDateString('fr-FR')}`:''}`
    : (COMPO_SCOPE==='cosmo'
        ? `Aucune partie COSMO relevée sur ${esc(COMPO_MAP)}.`
        : `Aucune donnée sur ${esc(COMPO_MAP)}.`);

  host.innerHTML = `<div class="cmp-head mono">${head}</div>${compoListHTML(rep)}`;

  const note=$('cmpNote');
  if(note) note.innerHTML = COMPO_SCOPE==='global'
    ? `Mesuré sur les deux camps de chaque partie que la squad a jouée — adversaires compris.
       Ce n'est pas un winrate mondial : aucune API publique ne le fournit. C'est ce qu'on
       observe réellement, à notre niveau de jeu.`
    : `Mesuré uniquement sur le camp où un membre COSMO jouait. Une partie n'y figure que si
       on sait de quel côté on était.`;
}

let COMPS_RENDERING=false;
async function showComps(){
  $('home').hidden=true; $('profile').hidden=true; $('tribunal').hidden=true;
  $('leaderboard').hidden=true;
  const rou=$('roulette'); if(rou) rou.hidden=true;
  const sec=$('comps'); if(!sec) return;
  sec.hidden=false;
  window.scrollTo(0,0);

  if(COMPS_LOADED && AGENT_LIST.length){ renderComps(); return; }
  if(COMPS_RENDERING) return;
  COMPS_RENDERING=true;
  const host=$('cmpBody');
  if(host && !COMPS_LOADED) host.innerHTML='<div class="cmp-empty">Chargement des compos…</div>';
  try{
    // L'escouade sert à savoir de quel côté COSMO jouait ; les agents à
    // connaître leur rôle. Sans eux, l'onglet « par rôles » serait vide.
    await Promise.all([ loadComps(), ensureAgents(), ensureSquadHistories().catch(()=>null) ]);
  }finally{
    COMPS_RENDERING=false;
  }
  if(!$('comps').hidden) renderComps();
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
        GUESTS=(Array.isArray(d.roster.guests)?d.roster.guests:[]).map(g=>Object.assign({},g,{guest:true}));
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
      GUESTS=((d && Array.isArray(d.guests))?d.guests:[]).map(g=>Object.assign({},g,{guest:true}));
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

/* ===================== ALERTES DE SESSION (ACCUEIL) ===================== */
let ALERTS_LOADED = false;

// Recalcul pur, sans réseau : à appeler dès que SQUAD_HIST a bougé.
function refreshHomeAlerts(){
  if(!$('alerts') || !SQUAD_HIST) return;
  const per=ROSTER.map(m=>({ member:m, matches:SQUAD_HIST[memberKey(m)]||[] }));
  renderAlerts(sessionAlerts(per));
}

async function loadHomeAlerts(){
  if(ALERTS_LOADED) return;
  ALERTS_LOADED = true;
  if(!$('alerts')) return;
  try{
    await ensureSquadHistories();          // lecture de blobs, aucun appel HenrikDev
    refreshHomeAlerts();
  }catch(e){ /* pas d'alertes : l'accueil reste parfaitement utilisable */ }
}

// Les parties fraîches (matches v4) ne sont PAS encore dans le blob : le cron ne
// passe qu'à 04:00. Sans ça, une session jouée ce soir n'apparaîtrait dans le
// bandeau que le lendemain. On les injecte donc dans l'index de squad dès qu'on
// ouvre un profil, le frais l'emportant sur le stocké.
function feedSquadHist(key, matches){
  if(!SQUAD_HIST) SQUAD_HIST={};
  const byId={};
  (matches||[]).forEach(M=>{ if(M && M.id) byId[M.id]=M; });
  (SQUAD_HIST[key]||[]).forEach(M=>{ if(M && M.id && !byId[M.id]) byId[M.id]=M; });
  SQUAD_HIST[key]=Object.keys(byId).map(k=>byId[k]);
}

function renderAlerts(alerts){
  const host=$('alerts'); if(!host) return;
  if(!alerts || !alerts.length){ host.innerHTML=''; host.hidden=true; return; }
  host.hidden=false;
  host.innerHTML=alerts.map(a=>`
    <button class="alert ${a.tone}" type="button"
      data-alert-member="${esc(a.member.name+'#'+a.member.tag)}" data-alert-ts="${a.session.startMs}">
      <span class="alert-ico">${a.icon}</span>
      <span class="alert-body"><b style="color:${esc(a.member.color||'')}">${esc(a.member.name)}</b> ${esc(a.text)}</span>
      <span class="alert-cta">voir la session →</span>
    </button>`).join('');
}

// Un clic sur une alerte ouvre le rapport de la session concernée : c'est
// exactement le mécanisme des liens partagés, réutilisé tel quel.
function openAlert(idStr, ts){
  const i=String(idStr).lastIndexOf('#');
  if(i<1) return;
  const name=String(idStr).slice(0,i), tag=String(idStr).slice(i+1);
  SHARE_TARGET={ name, tag, ts:Number(ts)||0, gap:null };
  if(!openProfileByKey(name, tag)) SHARE_TARGET=null;
}

/* ===================== ROULETTE — MISE EN SCÈNE ===================== */
let ROULETTE_BUSY = false;
let ROU_MODE = 'compo';        // compo | agent
let ROU_ROLE = 'all';          // mode agent uniquement
let ROU_FRESH = false;
let ROU_PICKED = null;         // Set de clés : qui joue (null = pas encore initialisé)
let ROU_PRESET = 'balanced';   // balanced | free | custom
let ROU_COUNTS = { 'Duelliste':0, 'Initiateur':0, 'Contrôleur':0, 'Sentinelle':0 };

const reduceMotion = () => {
  try{ return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }catch(e){ return false; }
};
const rouPeople = () => { const a=sessionRoster(); return a.length?a:ROSTER; };
function rouSelected(){
  if(!ROU_PICKED) return [];
  return rouPeople().filter(p=>ROU_PICKED.has(memberKey(p)));
}
// Comptes d'agents par personne, pour le mode « à tester ».
function rouCounts(){
  const c={};
  rouPeople().forEach(p=>{ c[memberKey(p)] = agentPlayCounts((SQUAD_HIST||{})[memberKey(p)] || []); });
  return c;
}
// Répartition effective des rôles selon le préréglage choisi.
function rouSlots(n){
  if(ROU_PRESET==='free') return compoSlots({}, n);
  if(ROU_PRESET==='custom') return compoSlots(ROU_COUNTS, n);
  // Équilibrée : un rôle différent par joueur, puis des places libres.
  const c={}; ROLES.slice(0, n).forEach(r=>{ c[r]=1; });
  return compoSlots(c, n);
}

const rouAgentCard = a => a ? `
  <div class="rou-agent">
    ${a.icon?`<img src="${esc(a.icon)}" alt="${esc(a.name)}" loading="lazy">`:'<div class="rou-noimg"></div>'}
    <div class="rou-an">${esc(a.name)}</div>
    <div class="rou-ar mono">${esc(a.role||'')}</div>
  </div>` : '<div class="rou-agent"><div class="rou-noimg"></div><div class="rou-an">—</div></div>';

/* Toutes les roues tournent EN MÊME TEMPS, puis se verrouillent une par une.
   C'est nettement plus tendu que de les faire défiler chacune son tour : on voit
   la compo se figer place par place, et il reste toujours quelque chose qui
   tourne jusqu'au dernier. */
function spinAll(slots, ms){
  return new Promise(resolve=>{
    const live = slots.filter(s=>s.el && s.pool && s.pool.length);
    if(!live.length){ resolve(); return; }
    const lock = s => {
      s.el.innerHTML = s.render(s.winner);
      s.el.classList.remove('spinning');
      s.el.classList.add('pop');
      // rou-flash, PAS flash : .flash est déjà l'overlay du tribunal
      // (position:absolute;opacity:0) et faisait disparaître la scène.
      const st=$('rouStage'); if(st){ st.classList.remove('rou-flash'); void st.offsetWidth; st.classList.add('rou-flash'); }
    };
    if(reduceMotion()){ live.forEach(lock); resolve(); return; }

    const hold = ms || 1500;                      // tout le monde tourne
    const gap  = 620;                             // écart entre deux verrouillages
    const start = performance.now();
    live.forEach(s=>{ s.el.classList.add('spinning'); s.lockAt = start + hold + live.indexOf(s)*gap; s.done=false; });
    const end = start + hold + (live.length-1)*gap + 450;
    let tick = 0;
    (function frame(now){
      // Le défilement ralentit à l'approche du verrouillage de chaque roue.
      if(now - tick > 70){
        tick = now;
        live.forEach(s=>{
          if(s.done) return;
          const left = s.lockAt - now;
          if(left <= 0){ s.done = true; lock(s); return; }
          if(left > 260 || Math.random() < 0.45)
            s.el.innerHTML = s.render(s.pool[Math.floor(Math.random()*s.pool.length)]);
        });
      }
      if(now < end) requestAnimationFrame(frame);
      else { live.forEach(s=>{ if(!s.done){ s.done=true; lock(s); } }); resolve(); }
    })(start);
  });
}

function rouStatus(html){ const el=$('rouStatus'); if(el) el.innerHTML=html||''; }

async function runRoulette(){
  if(ROULETTE_BUSY) return;
  const stage=$('rouStage'); if(!stage) return;
  await ensureAgents();
  if(!AGENT_LIST.length){
    rouStatus("Liste des agents indisponible (valorant-api injoignable). Réessaie dans un moment.");
    return;
  }
  ROULETTE_BUSY=true;
  const btn=$('rouGo'); if(btn){ btn.disabled=true; btn.textContent='🎲 Le destin réfléchit…'; }
  rouStatus('');

  try{
    if(ROU_MODE==='agent'){
      const pool=agentsForRole(ROU_ROLE);
      const winner=pickOne(pool);
      stage.innerHTML=`<div class="rou-slot" id="rouSlot0"></div>`;
      await spinAll([{ el:$('rouSlot0'), pool, winner, render:rouAgentCard }], 2200);
      rouStatus(`Le destin a parlé : <b>${esc(winner.name)}</b> — ${esc(winner.role)}.`);
    } else {
      const team=rouSelected();
      if(!team.length){ rouStatus('Choisis au moins un joueur.'); throw new Error('__vide');}
      const picks=rollComposition(team, { slots:rouSlots(team.length), fresh:ROU_FRESH,
        counts:ROU_FRESH?rouCounts():{} });
      stage.innerHTML=picks.map((p,i)=>`<div class="rou-pair">
        <div class="rou-who" style="--c:${esc(p.person.color||'#8696a6')}">${esc(p.person.name)}</div>
        <div class="rou-slot" id="rouA${i}"></div>
      </div>`).join('');
      const slots=picks.map((p,i)=>{
        const pool=agentsForRole(p.role);
        return { el:$('rouA'+i), pool:pool.length?pool:AGENT_LIST, winner:p.agent, render:rouAgentCard };
      });
      await spinAll(slots);
      const missing=picks.filter(p=>!p.agent).length;
      rouStatus(missing ? "Pas assez d'agents disponibles pour tout le monde."
        : `Compo tirée${ROU_FRESH?' · agents les moins joués':''}. Bonne chance.`);
    }
  }catch(e){ if(e && e.message!=='__vide') rouStatus('Le tirage a échoué : '+esc((e&&e.message)||'erreur')); }
  if(btn){ btn.disabled=false; btn.textContent='🎲 Lancer la roulette'; }
  ROULETTE_BUSY=false;
}

function showRoulette(){
  $('home').hidden=true; $('profile').hidden=true; $('tribunal').hidden=true;
  $('leaderboard').hidden=true; $('roulette').hidden=false;
  const cmp=$('comps'); if(cmp) cmp.hidden=true;
  window.scrollTo(0,0);
  // Par défaut : toute la squad est sélectionnée, on retire ceux qui ne jouent pas.
  if(!ROU_PICKED) ROU_PICKED=new Set(ROSTER.map(memberKey));
  renderRouletteControls();
  ensureAgents().then(()=>{ if(!$('roulette').hidden) renderRouletteControls(); });
}

// Les compteurs de rôles sont bâtis UNE fois : les re-générer à chaque clic
// faisait disparaître le bouton sous le doigt (et clignoter la liste).
function buildCompoCounters(){
  const cust=$('rouCustom');
  if(!cust || cust.dataset.built) return;
  cust.dataset.built='1';
  cust.innerHTML=ROLES.map(r=>`<div class="rou-cnt">
    <span class="rou-cn">${esc(r)}</span>
    <button class="rou-pm" type="button" data-role-dec="${esc(r)}" aria-label="Moins de ${esc(r)}">−</button>
    <b data-role-val="${esc(r)}">0</b>
    <button class="rou-pm" type="button" data-role-inc="${esc(r)}" aria-label="Plus de ${esc(r)}">+</button>
  </div>`).join('');
}

// Met à jour les seuls chiffres et le résumé, sans toucher à la structure.
function syncCompo(){
  const n=rouSelected().length;
  ROLES.forEach(r=>{
    const b=document.querySelector(`[data-role-val="${r}"]`);
    if(b) b.textContent=ROU_COUNTS[r]||0;
  });
  const asked=ROLES.reduce((a,r)=>a+(ROU_COUNTS[r]||0),0);
  const free=Math.max(0, n-asked), over=asked>n;
  const sum=$('rouSum');
  if(sum){
    sum.className='rou-sum'+(over?' over':'');
    sum.textContent = over
      ? `${asked} rôles demandés pour ${n} joueur${n>1?'s':''} — les places en trop sont ignorées.`
      : `${asked} imposé${asked>1?'s':''} · ${free} libre${free>1?'s':''} sur ${n}`;
  }
}

function renderRouletteControls(){
  const people=rouPeople(), sel=rouSelected();
  const who=$('rouWho');
  if(who) who.innerHTML=people.map(p=>{
    const on=ROU_PICKED && ROU_PICKED.has(memberKey(p));
    return `<button class="rou-who-chip${on?' on':''}" type="button" data-who="${esc(memberKey(p))}"
      style="--c:${esc(p.color||'#8696a6')}">${esc(p.name)}${p.guest?'<i>*</i>':''}</button>`;
  }).join('');
  const cnt=$('rouCount');
  if(cnt) cnt.textContent = sel.length
    ? `${sel.length} joueur${sel.length>1?'s':''} · ${STACK_LABEL[sel.length]||sel.length+' joueurs'}`
    : 'personne pour l\'instant';

  document.querySelectorAll('#rouMode button').forEach(b=>b.classList.toggle('on', b.dataset.mode===ROU_MODE));
  document.querySelectorAll('#rouPreset button').forEach(b=>b.classList.toggle('on', b.dataset.preset===ROU_PRESET));
  document.querySelectorAll('#rouRole button').forEach(b=>b.classList.toggle('on', b.dataset.role===ROU_ROLE));
  const fr=$('rouFreshOpt'); if(fr) fr.classList.toggle('on', ROU_FRESH);

  buildCompoCounters();
  syncCompo();

  const show=(id,yes)=>{ const el=$(id); if(el) el.hidden=!yes; };
  show('rouWhoRow',   ROU_MODE==='compo');
  show('rouPresetRow',ROU_MODE==='compo');
  show('rouCustomRow',ROU_MODE==='compo' && ROU_PRESET==='custom');
  show('rouOptRow',   ROU_MODE==='compo');
  show('rouRoleRow',  ROU_MODE==='agent');
  const hint=$('rouHint');
  if(hint) hint.textContent = ROU_MODE==='agent'
    ? "Un agent au hasard, dans le rôle de ton choix."
    : "Choisis qui joue, dis quelle compo tu veux, et laisse le destin distribuer.";
}

/* ===================== ÉDITEUR DE ROSTER ===================== */
// Une ligne de formulaire pour un membre.
function rosterRowHTML(m){
  m=m||{};
  const f=(k,ph)=>`<input data-f="${k}" placeholder="${ph}" value="${esc(m[k]||'')}">`;
  const aliasVal=memberAliases(m).map(a=>a.name+'#'+a.tag).join(', ');
  return `<div class="edrow">
    ${f('name','pseudo')}${f('tag','tag')}${f('agent','agent')}${f('role','rôle')}
    ${f('color','#couleur')}${f('uuid','uuid agent')}${f('customImg','URL GIF (optionnel)')}
    <input data-f="alias" class="edalias" placeholder="anciens pseudos : Ancien#tag, Autre#tag"
      title="Anciens pseudos Riot, séparés par des virgules. Sert à récupérer l'historique et la progression RR d'avant le changement de nom." value="${esc(aliasVal)}">
    <button class="edrm" type="button" title="Retirer ce membre">✕</button>
  </div>`;
}
function addRosterRow(m){ const host=$('edMembers'); if(host) host.insertAdjacentHTML('beforeend', rosterRowHTML(m)); }
// Ligne d'invité : pas d'agent ni d'image, il n'a pas de carte sur l'accueil.
function guestRowHTML(g){
  g=g||{};
  const f=(k,ph)=>`<input data-g="${k}" placeholder="${ph}" value="${esc(g[k]||'')}">`;
  const aliasVal=memberAliases(g).map(a=>a.name+'#'+a.tag).join(', ');
  return `<div class="edrow">
    ${f('name','pseudo')}${f('tag','tag')}${f('color','#couleur')}
    <input data-g="alias" class="edalias" placeholder="anciens pseudos : Ancien#tag" value="${esc(aliasVal)}">
    <button class="edrm" type="button" title="Retirer cet invité">✕</button>
  </div>`;
}
function addGuestRow(g){ const host=$('edGuests'); if(host) host.insertAdjacentHTML('beforeend', guestRowHTML(g)); }

function renderRosterEditor(){
  const reg=$('edRegion'); if(reg) reg.value=DEFAULT_REGION||'eu';
  const host=$('edMembers'); if(!host) return;
  host.innerHTML='';
  (ROSTER.length?ROSTER:[{}]).forEach(m=>addRosterRow(m));
  const gh=$('edGuests');
  if(gh){ gh.innerHTML=''; GUESTS.forEach(g=>addGuestRow(g)); }
}
function collectRoster(){
  const members=[...document.querySelectorAll('#edMembers .edrow')].map(row=>{
    const g=f=>{const el=row.querySelector(`[data-f="${f}"]`);return el?el.value.trim():'';};
    const m={ name:g('name'), tag:g('tag'), agent:g('agent'), role:g('role'), color:g('color')||'#8696a6' };
    const uuid=g('uuid'), img=g('customImg');
    if(uuid) m.uuid=uuid; if(img) m.customImg=img;
    const alias=memberAliases({ name:m.name, tag:m.tag, alias:g('alias') });
    if(alias.length) m.alias=alias.map(a=>a.name+'#'+a.tag);
    m.mono=(m.agent||m.name).slice(0,2);
    return m;
  }).filter(m=>m.name && m.tag);

  const guests=[...document.querySelectorAll('#edGuests .edrow')].map(row=>{
    const g=f=>{const el=row.querySelector(`[data-g="${f}"]`);return el?el.value.trim():'';};
    const o={ name:g('name'), tag:g('tag'), color:g('color')||'#8696a6' };
    const alias=memberAliases({ name:o.name, tag:o.tag, alias:g('alias') });
    if(alias.length) o.alias=alias.map(a=>a.name+'#'+a.tag);
    return o;
  }).filter(g=>g.name && g.tag);

  return { region:(($('edRegion')&&$('edRegion').value)||'eu').trim()||'eu', members, guests };
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
  $('edAddGuest')?.addEventListener('click', () => addGuestRow());
  $('edGuests')?.addEventListener('click', e => { const b=e.target.closest('.edrm'); if(b) b.closest('.edrow')?.remove(); });
  $('edMembers')?.addEventListener('click', e => { const b=e.target.closest('.edrm'); if(b) b.closest('.edrow')?.remove(); });
  $('edSave')?.addEventListener('click', saveRoster);
  $('btnBack').addEventListener('click',showHome);
  $('btnBackTrib').addEventListener('click',showHome);
  $('btnBackLb').addEventListener('click',showHome);
  // On tolère l'absence de ces boutons (page allégée / variante d'UI).
  $('btnTribunal')?.addEventListener('click',loadTribunal);
  $('btnRoulette')?.addEventListener('click',showRoulette);
  $('btnBackRou')?.addEventListener('click',showHome);
  $('btnComps')?.addEventListener('click',showComps);
  $('btnBackCmp')?.addEventListener('click',showHome);
  $('cmpMaps')?.addEventListener('click',e=>{ const b=e.target.closest('[data-cmap]');
    if(b){ COMPO_MAP=b.dataset.cmap; renderComps(); } });
  $('cmpScope')?.addEventListener('click',e=>{ const b=e.target.closest('button[data-scope]');
    if(b){ COMPO_SCOPE=b.dataset.scope; renderComps(); } });
  $('cmpTabs')?.addEventListener('click',e=>{ const b=e.target.closest('button[data-tab]');
    if(b){ COMPO_TAB=b.dataset.tab; renderComps(); } });
  $('cmpDays')?.addEventListener('click',e=>{ const b=e.target.closest('button[data-days]');
    if(b){ COMPO_DAYS=Number(b.dataset.days); renderComps(); } });
  $('rouGo')?.addEventListener('click',runRoulette);
  $('rouMode')?.addEventListener('click',e=>{ const b=e.target.closest('button[data-mode]');
    if(b){ ROU_MODE=b.dataset.mode; renderRouletteControls(); } });
  $('rouWho')?.addEventListener('click',e=>{
    const b=e.target.closest('[data-who]'); if(!b) return;
    const k=b.dataset.who;
    if(ROU_PICKED.has(k)) ROU_PICKED.delete(k); else ROU_PICKED.add(k);
    b.classList.toggle('on');          // bascule locale, sans redessiner la liste
    const cnt=$('rouCount'), n=rouSelected().length;
    if(cnt) cnt.textContent = n ? `${n} joueur${n>1?'s':''} · ${STACK_LABEL[n]||n+' joueurs'}` : "personne pour l'instant";
    syncCompo();
  });
  $('rouPreset')?.addEventListener('click',e=>{ const b=e.target.closest('button[data-preset]');
    if(b){ ROU_PRESET=b.dataset.preset; renderRouletteControls(); } });
  $('rouCustom')?.addEventListener('click',e=>{
    const inc=e.target.closest('[data-role-inc]'), dec=e.target.closest('[data-role-dec]');
    if(inc){ const r=inc.dataset.roleInc; ROU_COUNTS[r]=Math.min(5,(ROU_COUNTS[r]||0)+1); }
    else if(dec){ const r=dec.dataset.roleDec; ROU_COUNTS[r]=Math.max(0,(ROU_COUNTS[r]||0)-1); }
    else return;
    syncCompo();   // pas de reconstruction : le bouton reste sous le doigt
  });
  $('rouRole')?.addEventListener('click',e=>{ const b=e.target.closest('button[data-role]');
    if(b){ ROU_ROLE=b.dataset.role; renderRouletteControls(); } });
  $('rouFreshOpt')?.addEventListener('click',()=>{ ROU_FRESH=!ROU_FRESH; renderRouletteControls(); });
  $('btnLeaderboard')?.addEventListener('click',loadLeaderboard);
  
  $('roster').addEventListener('click',e=>{const c=e.target.closest('.agentcard');if(c)openProfile(+c.dataset.idx);});
  $('freshHome')?.addEventListener('click', ()=>{ if(FRESH.home.state!=='loading') fillRanks(); });
  $('alerts')?.addEventListener('click',e=>{
    const b=e.target.closest('[data-alert-member]');
    if(b) openAlert(b.dataset.alertMember, b.dataset.alertTs);
  });
  $('ml').addEventListener('click',e=>{
    const b=e.target.closest('[data-sd]');
    if(b){ e.stopPropagation(); openMatchScore(+b.dataset.sd); return; }   // clic sur l'indice -> détail du calcul
    const r=e.target.closest('.mrow'); if(r) openMatch(+r.dataset.idx);
  });
  // Détail du calcul : badge du dernier match + indices du scoreboard
  $('verdict')?.addEventListener('click',e=>{ if(e.target.closest('#heroScore')) openMatchScore(0); });

  $('scoreModal')?.addEventListener('click',e=>{
    if(e.target.closest('#scoreModalX')||e.target.classList.contains('modal-back')) closeScoreDetail();
  });
  // Modale d'une partie : scoreboard + détail complet au même endroit.
  $('matchModal')?.addEventListener('click',e=>{
    if(e.target.closest('#matchModalX')||e.target.classList.contains('modal-back')){ closeMatchFacts(); return; }
    const rc=e.target.closest('.rchip'); if(rc){ renderRoundDetail(+rc.dataset.round); return; }
    // Indice d'un joueur du scoreboard, ou badge du bandeau : détail du calcul.
    const c=e.target.closest('[data-sb]');
    if(c){
      const line=SB_LINES[+c.dataset.sb]; if(!line) return;
      const M=STATE.matches[SELECTED_IDX];
      openScoreDetail(line, { title:`${line.name}#${line.tag} · ${line.agent}`,
        sub:M?`${M.map} · ${M.result==='w'?'victoire':'défaite'} ${M.myScore}–${M.oppScore}`:'' });
      return;
    }
    if(e.target.closest('#mdHeroScore') && SELECTED_IDX>=0) openMatchScore(SELECTED_IDX);
  });
  // Rapports de session
  $('sxList')?.addEventListener('click',e=>{
    const r=e.target.closest('[data-sx]'); if(r) openSessionReport(r.dataset.sx);
  });
  $('sessionModal')?.addEventListener('click',e=>{
    if(e.target.closest('#sessionModalX')||e.target.classList.contains('modal-back')) closeSessionReport();
  });
  $('btnSxMore')?.addEventListener('click',()=>{ SESSIONS_SHOWN+=8; renderSessions(); });
  $('recList')?.addEventListener('click',e=>{
    const r=e.target.closest('[data-sx]'); if(r) openSessionReport(r.dataset.sx);
  });
  $('recPeriod')?.addEventListener('click',e=>{
    const b=e.target.closest('button[data-days]'); if(!b) return;
    RECORDS_DAYS=+b.dataset.days||0;
    document.querySelectorAll('#recPeriod button').forEach(x=>x.classList.toggle('on', x===b));
    renderRecords();
  });
  $('sessionModalBody')?.addEventListener('click',e=>{
    const b=e.target.closest('#sxShareBtn'); if(b) copyShareLink(b.dataset.url, b);
  });
  $('sessionModalBody')?.addEventListener('focus',e=>{
    if(e.target && e.target.id==='sxShareUrl') e.target.select();   // copie manuelle facile
  }, true);
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
  document.addEventListener('keydown',e=>{
    if(e.key!=='Escape') return;
    const top=topModal();
    if(top==='scoreModal') closeScoreDetail();
    else if(top==='matchModal') closeMatchFacts();
    else if(top==='sessionModal') closeSessionReport();
  });
  $('phead').addEventListener('click',e=>{
    if(e.target.closest('.refresh')){ loadProfile(); return; }
    if(e.target.closest('#freshProfile') && FRESH.profile.state!=='loading') loadProfile();
  });
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
  registerSW();
  startFreshTicker();
  document.addEventListener('visibilitychange', ()=>{
    if(document.hidden) stopFreshTicker(); else { renderFresh(); startFreshTicker(); }
  });
  // Lien de session partagé : on ouvre directement le profil concerné, et le
  // rapport s'ouvrira dès que les données seront prêtes (cf. refreshSessions).
  const sh=parseShareTarget();
  if(sh){
    SHARE_TARGET=sh;
    if(sh.gap) SESSION_GAP_MIN=sh.gap;
    const gapSel=$('sxGap'); if(gapSel) gapSel.value=String(SESSION_GAP_MIN);
    if(openProfileByKey(sh.name, sh.tag)) return;   // fillRanks est inutile ici
    SHARE_TARGET=null;                              // joueur inconnu : accueil normal
  }
  fillRanks();
  loadHomeAlerts();   // en tâche de fond : blobs seulement, l'accueil s'affiche déjà
}
if(typeof document!=='undefined'){
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init);
  else init();
}