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
const FRESH_SIZE = 20;                                  // matches v4 récupérés pour la fraîcheur
let PROFILE_SHOWN = FRESH_SIZE;                         // nb de parties affichées (pagination locale)
const PROFILE_SIZE_STEP = 15;                          // pas du bouton "charger plus"
let MAPS = null;                                        // cache nom de map -> image splash
let AGENTS = null;                                      // cache nom d'agent -> icône (tête)
let TIERS = null;                                       // cache nom de palier -> icône de rang
let TIER_BY_NUM = null;                                 // cache numéro de palier -> {name,color,icon} (lignes de rang du graphe)
const ANIM_BUSY = { Trib: false, Prof: false };

const $ = id => document.getElementById(id);
const enc = s => encodeURIComponent(s);
const REGION = () => $('region').value;
const num = (v,f=0)=>(v===undefined||v===null||isNaN(v))?f:Number(v);
const clamp = (x, a=0, b=100) => Math.max(a, Math.min(b, x));
const ESC_MAP = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC_MAP[c]);

/* ===================== INDICE /100 ===================== */
function perfScore(o){
  const acsN=clamp((o.acs-130)/2);      
  const ddN =clamp(o.dd+40);            
  const kdN =clamp((o.kd-0.6)*100);     
  const adrN=clamp(o.adr-90);           
  const hsN =clamp((o.hs-10)*4);        
  return Math.round(clamp(0.34*acsN+0.22*ddN+0.18*kdN+0.14*adrN+0.12*hsN));
}
function tierOf(s){
  if(s>=88) return {t:"S",c:"#56d8c9",label:"Smurf détecté"};
  if(s>=74) return {t:"A",c:"#7ee07a",label:"Énorme"};
  if(s>=60) return {t:"B",c:"#cfe04f",label:"Solide"};
  if(s>=46) return {t:"C",c:"#f2b234",label:"Moyen"};
  if(s>=32) return {t:"D",c:"#f2803a",label:"Bof"};
  return {t:"F",c:"#ff5d5d",label:"Caca qui pue"};
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
  const e={id,elo,rr,change,tier,map:(h.map&&h.map.name)||(h.map||''),date:h.date||h.date_raw||null};
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
function statline(p,rounds){
  const st=p.stats||{};
  const k=num(st.kills),d=num(st.deaths),a=num(st.assists),score=num(st.score);
  const hsT=num(st.headshots)+num(st.bodyshots)+num(st.legshots);
  const hs=hsT?Math.round(num(st.headshots)/hsT*100):0;
  const dmg=num(st.damage&&st.damage.dealt, num(st.damage_made));
  const rec=num(st.damage&&st.damage.received);
  const acs=rounds?Math.round(score/rounds):0, adr=rounds?Math.round(dmg/rounds):0;
  const dd=rounds?Math.round((dmg-rec)/rounds):0, kd=k/Math.max(d,1);
  const ag=p.agent||{};
  const o={k,d,a,hs,acs,adr,dd,kd,name:p.name||'?',tag:p.tag||'',team:p.team_id,
    agent:ag.name||(typeof p.agent==='string'?p.agent:'?'),
    agentId:ag.id||ag.uuid||''};
  o.score100=perfScore(o);
  return o;
}
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

  const meStat = me ? statline(me, rounds) : null;
  if(meStat) meStat.placement = placement;

  const startedMs=tsMs(meta);
  return {players,rounds,
    map:(meta.map&&meta.map.name)||meta.map||'—',
    mode:(meta.queue&&meta.queue.name)||meta.queue||meta.mode||'—',
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
  const meStat=statline(player, rounds);
  meStat.placement=null; // pas d'info de classement dans ce format compact
  const startedMs=tsMs(meta);
  return { players:[player], rounds, partial:true,   // format compact : 1 seul joueur, détail complet chargeable à la demande
    map:(meta.map&&meta.map.name)||meta.map||'—',
    mode:(meta.queue&&meta.queue.name)||meta.mode||'—',
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
    idx[e.id]={ change:e.change, tierName, icon, rr:e.rr };
  });
  return idx;
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
// Applique la fenêtre choisie (sélecteur de période) à la série RR complète, puis
// trace le graphe. RR_PERIOD=0 -> tout l'historique ; sinon les N plus récentes.
function renderCurvePeriod(){
  const s = (RR_PERIOD>0 && RR_FULL.length>RR_PERIOD) ? RR_FULL.slice(-RR_PERIOD) : RR_FULL;
  document.querySelectorAll('#rrPeriod button').forEach(b=>b.classList.toggle('on', +b.dataset.n===RR_PERIOD));
  renderCurve(s);
}

// Graphique de progression RR long terme. `series` = points RR normalisés
// (blob accumulé + live), triés du plus ancien au plus récent.
function renderCurve(series){
  const box=$('curve');
  if(!Array.isArray(series) || !series.length){ box.innerHTML='<div class="vh-line mono">Pas d\'historique RR.</div>'; return; }

  // Valeur tracée : elo (continu, grimpe à travers les rangs -> permet les lignes de
  // paliers) si dispo, sinon somme cumulée des +/- RR.
  const hasElo = series.some(e=>e && e.elo!=null);
  let pts, chartMode;
  if(hasElo){
    let last=null;
    pts=series.map(e=>{ if(e && e.elo!=null) last=Number(e.elo); return last; });
    const firstKnown = pts.find(v=>v!=null) ?? 0;
    pts=pts.map(v=> v==null? firstKnown : v);
    chartMode='elo';
  }else{
    let acc=0; pts=series.map(e=>{ acc+=num(e&&e.change); return acc; }); chartMode='rr';
  }

  const n=pts.length, W=640,H=250,mL=46,mR=58,mT=16,mB=30, pw=W-mL-mR, ph=H-mT-mB;
  const minV=Math.min(...pts), maxV=Math.max(...pts);
  const pad=Math.max(chartMode==='elo'?10:2,(maxV-minV)*0.12), lo=minV-pad, hi=maxV+pad, R=Math.max(hi-lo,1);
  const X=i=> mL + (n<=1? pw/2 : i/(n-1)*pw);
  const Y=v=> mT + (1-(v-lo)/R)*ph;
  const fmtDate = ts => ts? new Date(ts).toLocaleDateString('fr-FR',{day:'2-digit',month:'2-digit'}) : '';

  // Grille horizontale : lignes de PALIERS (mode elo) ou grille numérique (repli).
  let grid='', ylab='';
  const tierMode = chartMode==='elo' && TIER_BY_NUM;
  if(tierMode){
    const kMin=Math.floor(lo/100), kMax=Math.floor(hi/100);
    for(let k=kMin; k<=kMax; k++){
      const ti=TIER_BY_NUM[k];
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

  const yTitle=`<text x="13" y="${mT+ph/2}" transform="rotate(-90 13 ${mT+ph/2})" text-anchor="middle" class="axt">${chartMode==='elo'?'elo (rang)':'RR cumulé'}</text>`;
  const xTitle=`<text x="${mL+pw/2}" y="${H-1}" text-anchor="middle" class="axt">parties classées (ancien → récent)</text>`;
  const pills=series.slice(-15).map(e=>{const c=num(e.change);return `<div class="hpill"><div class="m">${esc(fmtDate(e.ts))}</div><div class="v ${c>=0?'up':'dn'}">${c>=0?'+':''}${c}</div></div>`;}).join('');

  box.innerHTML=`
    <div class="rrcap mono">${n} partie${n>1?'s':''} classée${n>1?'s':''}${chartMode==='elo'?' · progression elo':' · RR cumulé'}</div>
    <div class="rrwrap" style="position:relative">
    <svg class="rrchart" width="100%" viewBox="0 0 ${W} ${H}" role="img" aria-label="Progression du RR">
      <defs><linearGradient id="rrfill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--amber)" stop-opacity="0.26"/><stop offset="100%" stop-color="var(--amber)" stop-opacity="0"/>
      </linearGradient></defs>
      ${grid}
      <polygon points="${area}" fill="url(#rrfill)"/>
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
  renderStatsTable('agentStats', groupStats(filtered, M => M.me.agent), 'Agent');
  renderStatsTable('mapStats',   groupStats(filtered, M => M.map),      'Map');
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
      <div class="scorebadge score-mini flair-${f}" style="--sc:${t.c}">${s?sc100:'—'}${flairHTML(f)}</div>
    </div>`;
  }).join('');
  
  // Selection auto du premier element filtré si existant
  if(filtered.length > 0) showMatch(STATE.matches.indexOf(filtered[0]));
}

// Rang ordinal en français : 1 -> "1er", sinon "Ne".
function ordinalFr(n){ return n===1 ? '1er' : n+'e'; }

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
  const all=detail.players.map(p=>statline(p,detail.rounds));
  // Classement par ACS décroissant sur TOUS les joueurs de la partie (1er, 2e, …).
  [...all].sort((a,b)=>b.acs-a.acs).forEach((s,idx)=>{ s.acsRank=idx+1; });
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
      <td class="scell" style="color:${t.c}">${s.score100}</td>
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

  // Charge le détail complet à la demande, puis ré-affiche si cette partie est toujours ouverte.
  if(M.partial && M.id && !(M.id in MATCH_DETAILS)){
    DETAIL_PENDING[M.id]=true;
    fetchMatchDetail(M.id).finally(()=>{ delete DETAIL_PENDING[M.id]; if(SELECTED_IDX===i) showMatch(i); });
  }
}

function openProfile(idx){
  const m=ROSTER[idx];
  if(!m) return;
  STATE={puuid:null,allMatches:[],matches:[],name:m.name,tag:m.tag};
  PROFILE_SHOWN = FRESH_SIZE;

  const bustSrc = m.customImg || `${MEDIA}/${m.uuid}/bustportrait.png`;

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
    // Join RR/rang par match_id (depuis la série RR accumulée -> long terme).
    const rrIdx=rrIndexFromSeries(rrSeries);
    STATE.allMatches.forEach(M=>{ if(M&&M.id&&rrIdx[M.id]) M.rr=rrIdx[M.id]; });
    PROFILE_SHOWN=Math.min(FRESH_SIZE, STATE.allMatches.length);
    STATE.matches=STATE.allMatches.slice(0, PROFILE_SHOWN);

    // L'indice COSMO général reste sur les 8 dernières
    const scored=STATE.matches.slice(0,8).filter(M=>M.me);
    const overall=scored.length?Math.round(scored.reduce((s,M)=>s+M.me.score100,0)/scored.length):0;
    
    RR_FULL = rrSeries;
    renderRank(mmr,overall); renderCurvePeriod();
    if(STATE.matches.length){ 
       const s=STATE.matches[0].me;
       if(s){
         const tc=tierOf(s.score100);
         $('vcard').style.setProperty('--sc', tc.c);
         $('verdict').innerHTML = `
          <div class="vh-grid">
            <div class="vh-score"><div class="scorebadge score-hero flair-${flair(s.kd)}" style="--sc:${tc.c}">${s.score100}<span class="out">/100</span>${flairHTML(flair(s.kd))}</div></div>
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
    const bustSrc = m.customImg || `${MEDIA}/${m.uuid}/bustportrait.png`;
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
  try{
    const r=await fetch('roster.json');
    if(r.ok){
      const d=await r.json();
      ROSTER=Array.isArray(d)?d:(d.members||[]);
      if(d && d.region) DEFAULT_REGION=d.region;
    }
  }catch(e){ /* roster indispo : la grille restera vide */ }
  const sel=$('region'); if(sel && DEFAULT_REGION) sel.value=DEFAULT_REGION;
}

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

/* ===================== WIRING ===================== */
function wireRosterImgs(){
  document.querySelectorAll('.agentcard .portrait').forEach(img=>{
    const fail=()=>{img.style.display='none';const c=img.closest('.agentcard');if(c)c.classList.add('noimg');};
    img.addEventListener('error',fail);
    if(img.complete && img.naturalWidth===0) fail();
  });
}

function wireStatic(){
  $('btnGear').addEventListener('click',toggleSheet);
  $('btnRanks').addEventListener('click',fillRanks);
  $('btnRefreshNow')?.addEventListener('click', saveAllHistory);
  $('btnBack').addEventListener('click',showHome);
  $('btnBackTrib').addEventListener('click',showHome);
  $('btnBackLb').addEventListener('click',showHome);
  $('btnTribunal').addEventListener('click',loadTribunal);
  $('btnLeaderboard').addEventListener('click',loadLeaderboard);
  
  $('roster').addEventListener('click',e=>{const c=e.target.closest('.agentcard');if(c)openProfile(+c.dataset.idx);});
  $('ml').addEventListener('click',e=>{const r=e.target.closest('.mrow');if(r)showMatch(+r.dataset.idx);});
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
async function init(){
  await loadRoster();   // source de vérité : doit être chargée avant de bâtir la grille
  renderRoster();
  wireStatic();
  drawGauge('gaugeTrib');
  fillRanks();
}
if(typeof document!=='undefined'){
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init);
  else init();
}