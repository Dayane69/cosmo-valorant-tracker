/* ===================== CONFIG ===================== */
const PROXY = p => `/.netlify/functions/valo?path=${encodeURIComponent(p)}`;
const MEDIA = "https://media.valorant-api.com/agents";

const ROSTER = [
  {agent:"Cypher",    role:"Sentinelle", uuid:"117ed9e3-49f3-6512-3ccf-0cada7e3823b", color:"#9aa7b2", name:"Arsh26",    tag:"2826"},
  {agent:"Brimstone", role:"Contrôleur", uuid:"9f0d8ba9-4140-b941-57d3-a7ad57c6b417", color:"#e07b2c", name:"SevenDayy", tag:"6340"},
  {agent:"Breach",    role:"Initiateur", uuid:"5f8d3a7f-467b-97f3-062c-13acf203c006", color:"#c8623a", name:"Gogemine",  tag:"0202"},
  {agent:"Jett",      role:"Duelliste",  uuid:"add6443a-41bd-e414-f6ad-e58d267f4e95", color:"#74e0dd", name:"kingsto",   tag:"0000"},
  {agent:"Chamber",   role:"Sentinelle", uuid:"22697a3d-45bf-8dd7-4fec-84a9e28c69d7", color:"#e3b341", name:"joker",     tag:"prft9"},
  {agent:"Phoenix",   role:"Duelliste",  uuid:"eb93336a-449b-9c1b-0a54-a891f7921d69", color:"#ff8262", name:"abd",       tag:"wesh"},
  {agent:"Son Goku",  role:"Saiyan",     customImg:"https://media3.giphy.com/media/v1.Y2lkPTc5MGI3NjExdDA1cjBwcHBrZmt2OGRjMDBvNGoyeTBpbXc1Zjk2d3c1cDc5dmZwMCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/BODTGPaN9Pw9mt5J1L/giphy.gif", color:"#ff8c00", name:"Giorno77",  tag:"5800"},
];

const REACTIONS = {
  S:{emoji:"🔥",cap:"Insane",gif:""},
  A:{emoji:"😎",cap:"Propre",gif:""},
  B:{emoji:"👍",cap:"Correct",gif:""},
  C:{emoji:"😐",cap:"Bof",gif:""},
  D:{emoji:"🥴",cap:"Aïe",gif:""},
  F:{emoji:"💩",cap:"La honte",gif:""},
};

let STATE = { puuid:null, matches:[], name:"", tag:"" };
const TRIB = { matches: [], active: 0, n: 10 };
const LB = { n: 10 };
const VS = { a: 0, b: 1 };
let CURRENT_MODE = 'all';
let PROFILE_SIZE = 20;                                  // nombre de parties demandées pour le profil
const PROFILE_SIZE_STEP = 15, PROFILE_SIZE_MAX = 50;    // pas du "charger plus" + plafond qu'on tente
let MAPS = null;                                        // cache nom de map -> image splash
let AGENTS = null;                                      // cache nom d'agent -> icône (tête)
let TIERS = null;                                       // cache nom de palier -> icône de rang
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
// Charge une fois la liste des maps (nom -> image splash) depuis valorant-api. Repli silencieux si indispo.
async function ensureMaps(){
  if(MAPS) return MAPS;
  MAPS = {};
  try{
    const r = await fetch('https://valorant-api.com/v1/maps');
    if(r.ok){
      const d = await r.json();
      (d.data||[]).forEach(mp=>{ if(mp.displayName && mp.splash) MAPS[mp.displayName.toLowerCase()] = mp.splash; });
    }
  }catch(e){ /* pas de fond de carte, tant pis */ }
  return MAPS;
}
// Charge une fois la liste des agents (nom -> icône / tête) depuis valorant-api.
// Sert à afficher la vraie tête de l'agent dans le scoreboard (au lieu de 2 lettres).
async function ensureAgents(){
  if(AGENTS) return AGENTS;
  AGENTS = {};
  try{
    const r = await fetch('https://valorant-api.com/v1/agents?isPlayableCharacter=true');
    if(r.ok){
      const d = await r.json();
      (d.data||[]).forEach(ag=>{ if(ag.displayName && ag.displayIcon) AGENTS[ag.displayName.toLowerCase()] = ag.displayIcon; });
    }
  }catch(e){ /* pas d'icônes d'agent, on garde les initiales */ }
  return AGENTS;
}
// Charge une fois les paliers compétitifs (nom -> icône de rang) depuis valorant-api.
// Sert de repli quand l'API HenrikDev ne fournit pas l'image du rang.
async function ensureTiers(){
  if(TIERS) return TIERS;
  TIERS = {};
  try{
    const r = await fetch('https://valorant-api.com/v1/competitivetiers');
    if(r.ok){
      const d = await r.json();
      const eps = d.data||[];
      const latest = eps[eps.length-1];                 // dernier épisode = paliers à jour
      ((latest&&latest.tiers)||[]).forEach(t=>{ if(t.tierName && t.largeIcon) TIERS[t.tierName.trim().toLowerCase()] = t.largeIcon; });
    }
  }catch(e){ /* pas d'icônes de rang, on garde le texte */ }
  return TIERS;
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
  const o={k,d,a,hs,acs,adr,dd,kd,name:p.name||'?',tag:p.tag||'',team:p.team_id,agent:(p.agent&&p.agent.name)||'?'};
  o.score100=perfScore(o);
  return o;
}
function normMatch(m, targetState = STATE){
  const meta=m.metadata||{}, players=m.players||[], teams=m.teams||[];
  const me=players.find(p=>p.puuid===targetState.puuid)
        || players.find(p=>(p.name||'').toLowerCase()===targetState.name.toLowerCase()&&(p.tag||'').toLowerCase()===targetState.tag.toLowerCase());
  
  const sorted = [...players].sort((a,b) => (num(b.stats?.score) - num(a.stats?.score)));
  const meIndex = me ? sorted.findIndex(p => p.puuid === me.puuid || ((p.name||'').toLowerCase()===(me.name||'').toLowerCase() && (p.tag||'').toLowerCase()===(me.tag||'').toLowerCase())) : -1;
  const placement = meIndex !== -1 ? meIndex + 1 : null;

  const T=id=>teams.find(t=>t.team_id===id);
  const rwon=t=>t&&t.rounds?num(t.rounds.won):0, rlost=t=>t&&t.rounds?num(t.rounds.lost):0;
  const myTeam=me?T(me.team_id):null, oppTeam=teams.find(t=>myTeam&&t.team_id!==myTeam.team_id);
  let rounds=myTeam?rwon(myTeam)+rlost(myTeam):(rwon(T('Red'))+rwon(T('Blue')));
  if(!rounds) rounds=(m.rounds&&m.rounds.length)||24;
  let result='?';
  if(myTeam) result=(typeof myTeam.won==='boolean')?(myTeam.won?'w':'l'):(rwon(myTeam)>=rwon(oppTeam)?'w':'l');
  
  const meStat = me ? statline(me, rounds) : null;
  if(meStat) meStat.placement = placement;

  return {players,rounds,
    map:(meta.map&&meta.map.name)||meta.map||'—',
    mode:(meta.queue&&meta.queue.name)||meta.queue||meta.mode||'—',
    started:meta.started_at||meta.game_start_iso,
    myScore:rwon(myTeam), oppScore:rwon(oppTeam), result,
    me:meStat, myTeamId:me?me.team_id:'Blue'};
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
function renderCurve(hist){
  const box=$('curve');
  if(!hist || !hist.length){ box.innerHTML='<div class="vh-line mono">Pas d\'historique RR.</div>'; return; }
  const list=hist.slice(0,15).reverse();
  // valeur tracée : elo si dispo, sinon somme cumulée des variations
  let pts=list.map(h=>(h.elo!=null && !isNaN(h.elo))?Number(h.elo):null);
  if(pts.every(v=>v===null)){ let acc=0; pts=list.map(h=>{acc+=num(h.last_change);return acc;}); }
  else { let last=pts.find(v=>v!==null) ?? 0; pts=pts.map(v=>{ if(v!==null) last=v; return last; }); }

  const n=pts.length, W=640,H=250,mL=46,mR=16,mT=16,mB=30, pw=W-mL-mR, ph=H-mT-mB;
  const minV=Math.min(...pts), maxV=Math.max(...pts);
  const pad=Math.max(2,(maxV-minV)*0.12), lo=minV-pad, hi=maxV+pad, R=Math.max(hi-lo,1);
  const X=i=> mL + (n<=1? pw/2 : i/(n-1)*pw);
  const Y=v=> mT + (1-(v-lo)/R)*ph;

  let grid='', ylab='';
  for(let g=0; g<=4; g++){
    const val=lo+R*g/4, yy=Y(val);
    grid+=`<line x1="${mL}" y1="${yy.toFixed(1)}" x2="${W-mR}" y2="${yy.toFixed(1)}" stroke="var(--line)" stroke-width="1" opacity="${g===0?0.85:0.45}"/>`;
    ylab+=`<text x="${mL-8}" y="${(yy+3.5).toFixed(1)}" text-anchor="end" class="ax">${Math.round(val)}</text>`;
  }
  let vgrid='';
  for(let i=0;i<n;i++){ const xx=X(i); vgrid+=`<line x1="${xx.toFixed(1)}" y1="${mT}" x2="${xx.toFixed(1)}" y2="${mT+ph}" stroke="var(--line)" stroke-width="1" opacity="0.16"/>`; }
  const xticks=[...new Set(n<=1?[0]:[0,Math.floor((n-1)/2),n-1])];
  let xlab='';
  xticks.forEach(i=>{ const xx=X(i); const lbl=i===n-1?'récent':`-${n-1-i}`; xlab+=`<text x="${xx.toFixed(1)}" y="${H-10}" text-anchor="middle" class="ax">${lbl}</text>`; });

  const line=pts.map((v,i)=>`${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const area=`${mL},${mT+ph} ${line} ${X(n-1).toFixed(1)},${mT+ph}`;
  let dots='';
  pts.forEach((v,i)=>{ const up=i===0?null:v-pts[i-1]; const col=up===null?'var(--amber)':(up>=0?'var(--win)':'var(--loss)'); dots+=`<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="3.2" fill="${col}" stroke="#0a0f15" stroke-width="1.5"/>`; });

  const yTitle=`<text x="13" y="${mT+ph/2}" transform="rotate(-90 13 ${mT+ph/2})" text-anchor="middle" class="axt">RR / elo</text>`;
  const xTitle=`<text x="${mL+pw/2}" y="${H-1}" text-anchor="middle" class="axt">parties (ancien → récent)</text>`;
  const pills=list.map(h=>{const c=num(h.last_change);return `<div class="hpill"><div class="m">${esc((h.map&&h.map.name)||'')}</div><div class="v ${c>=0?'up':'dn'}">${c>=0?'+':''}${c}</div></div>`;}).join('');

  box.innerHTML=`
    <svg class="rrchart" width="100%" viewBox="0 0 ${W} ${H}" role="img" aria-label="Progression du RR">
      <defs><linearGradient id="rrfill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--amber)" stop-opacity="0.28"/><stop offset="100%" stop-color="var(--amber)" stop-opacity="0"/>
      </linearGradient></defs>
      ${vgrid}${grid}
      <polygon points="${area}" fill="url(#rrfill)"/>
      <polyline points="${line}" fill="none" stroke="var(--amber)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}${ylab}${xlab}${yTitle}${xTitle}
    </svg>
    <div class="hist">${pills}</div>`;
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
      <div class="scorebadge score-mini flair-${f}" style="--sc:${t.c}">${s?sc100:'—'}${flairHTML(f)}</div>
    </div>`;
  }).join('');
  
  // Selection auto du premier element filtré si existant
  if(filtered.length > 0) showMatch(STATE.matches.indexOf(filtered[0]));
}

function showMatch(i){
  document.querySelectorAll('.mrow').forEach(el=>el.classList.toggle('sel', +el.dataset.idx === i));
  const M=STATE.matches[i];
  if(!M) return;
  $('sbsub').textContent=`${M.map} · ${M.result==='w'?'victoire':'défaite'} ${M.myScore}–${M.oppScore}`;
  const all=M.players.map(p=>statline(p,M.rounds));
  const blue=all.filter(s=>s.team===M.myTeamId), red=all.filter(s=>s.team!==M.myTeamId);
  const sbRows = rows => rows.map(s=>{
    const me=s.name.toLowerCase()===STATE.name.toLowerCase()&&s.tag.toLowerCase()===STATE.tag.toLowerCase();
    const t=tierOf(s.score100);
    const initials=esc((s.agent||'?').slice(0,2));
    const aIcon=AGENTS && AGENTS[(s.agent||'').toLowerCase()];
    const agCell=aIcon
      ? `<div class="ag" title="${esc(s.agent)}"><img src="${esc(aIcon)}" alt="${esc(s.agent)}" loading="lazy" onerror="this.closest('.ag').classList.add('noimg');this.remove();"><span>${initials}</span></div>`
      : `<div class="ag noimg" title="${esc(s.agent)}"><span>${initials}</span></div>`;
    return `<tr class="${me?'me':''}">
      <td><div class="agent">${agCell}
        <div class="pn"><b>${esc(s.name)}</b> <span>#${esc(s.tag)}</span></div></div></td>
      <td class="scell" style="color:${t.c}">${s.score100}</td>
      <td style="color:${sc((s.acs-130)/2)}"><b>${s.acs}</b></td>
      <td><b style="color:${sc((s.kd-0.6)*100)}">${s.k}</b>/${s.d}/${s.a}</td>
      <td style="color:${s.k-s.d>=0?'var(--win)':'var(--loss)'}">${(s.k-s.d>0?'+':'')}${s.k-s.d}</td>
      <td style="color:${sc((s.hs-10)*4)}">${s.hs}%</td>
      <td style="color:${sc(s.adr-90)}">${s.adr}</td></tr>`;
  }).join('');
  
  $('sb').innerHTML=`<table class="sb"><thead><tr><th>Joueur</th><th>Indice</th><th>ACS</th><th>K/D/A</th><th>+/–</th><th>HS%</th><th>ADR</th></tr></thead>
    <tbody><tr><td colspan="7" class="teamlabel blue">Ta team — ${M.myScore} rounds</td></tr>${sbRows(blue)}
    <tr><td colspan="7" class="teamlabel red">Adverse — ${M.oppScore} rounds</td></tr>${sbRows(red)}</tbody></table>`;
}

function openProfile(idx){
  const m=ROSTER[idx];
  STATE={puuid:null,matches:[],name:m.name,tag:m.tag};
  PROFILE_SIZE = 20;

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
    const [mmrR,histR,matchR]=await Promise.allSettled([
      api(`/valorant/v3/mmr/${region}/pc/${n}/${t}`),
      api(`/valorant/v2/mmr-history/${region}/pc/${n}/${t}`),
      api(`/valorant/v4/matches/${region}/pc/${n}/${t}?size=${PROFILE_SIZE}`) // taille ajustable via "charger plus"
    ]);
    // Caches médias : têtes d'agents (scoreboard), icônes de rang et fonds de map
    await Promise.all([ensureTiers(), ensureAgents(), ensureMaps()]);

    let mmr={tier:'',rr:null,elo:null,peak:'',icon:null};
    if(mmrR.status==='fulfilled'){ const d=mmrR.value.data||{}; const cur=d.current||d.current_data||{};
      const tierName=(cur.tier&&cur.tier.name)||cur.currenttierpatched||'';
      mmr={tier:tierName, rr:(cur.rr!=null?cur.rr:cur.ranking_in_tier), elo:cur.elo, icon:rankIcon(cur,tierName),
           peak:(d.peak&&d.peak.tier&&d.peak.tier.name)||(d.highest_rank&&d.highest_rank.patched_tier)||''}; }
    let hist=[]; if(histR.status==='fulfilled'){ const d=histR.value.data; hist=(d&&d.history)||d||[]; }

    // On conserve toutes les parties renvoyées (jusqu'à PROFILE_SIZE)
    if(matchR.status==='fulfilled') STATE.matches=(matchR.value.data||[]).map(m=>normMatch(m));
    
    // L'indice COSMO général reste sur les 8 dernières
    const scored=STATE.matches.slice(0,8).filter(M=>M.me);
    const overall=scored.length?Math.round(scored.reduce((s,M)=>s+M.me.score100,0)/scored.length):0;
    
    renderRank(mmr,overall); renderCurve(hist);
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
  }catch(e){
    status('err','<b>Erreur API :</b> '+(e.message||'network'));
  }
}

/* ===================== CHARGER PLUS DE PARTIES ===================== */
function updateMoreBtn(prevLen){
  const btn=$('btnMore'); if(!btn) return;
  const len=STATE.matches.length;
  // plus rien à charger si: l'API a renvoyé moins que demandé, on a atteint le plafond, ou rien de neuf n'est arrivé
  const capReached = len < PROFILE_SIZE || PROFILE_SIZE >= PROFILE_SIZE_MAX || (prevLen!=null && len<=prevLen);
  if(capReached){
    btn.disabled=true;
    btn.textContent=`Tout l'historique dispo est chargé (${len} parties)`;
  }else{
    btn.disabled=false;
    btn.textContent=`Charger plus de parties (${len} affichées)`;
  }
}

async function loadMoreMatches(){
  const btn=$('btnMore');
  if(!STATE.name || PROFILE_SIZE>=PROFILE_SIZE_MAX) return;
  const prevLen=STATE.matches.length;
  PROFILE_SIZE=Math.min(PROFILE_SIZE+PROFILE_SIZE_STEP, PROFILE_SIZE_MAX);
  if(btn){ btn.disabled=true; btn.textContent='Chargement…'; }
  const region=REGION(), n=enc(STATE.name), t=enc(STATE.tag);
  try{
    const r=await api(`/valorant/v4/matches/${region}/pc/${n}/${t}?size=${PROFILE_SIZE}`);
    STATE.matches=(r.data||[]).map(m=>normMatch(m));
    await Promise.all([ensureMaps(), ensureAgents()]);
    renderList();
    updateMoreBtn(prevLen);
  }catch(e){
    if(btn){ btn.disabled=false; btn.textContent='Erreur, réessayer'; }
  }
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

async function loadTribunal() {
  $('home').hidden = true;
  $('profile').hidden = true;
  $('leaderboard').hidden = true;
  $('tribunal').hidden = false;
  $('appTrib').hidden = true;
  
  statusTrib('load', 'Convocation du tribunal (récupération des 15 dernières parties classées de chaque membre)...');
  const region = REGION();
  try {
    const reqs = ROSTER.map(m => api(`/valorant/v4/matches/${region}/pc/${enc(m.name)}/${enc(m.tag)}?mode=competitive&size=15`));
    const results = await Promise.allSettled(reqs);

    TRIB.matches = results.map((r, i) => {
      return { member: ROSTER[i], data: r.status === 'fulfilled' ? (r.value.data || []) : [] };
    });

    TRIB.matches.forEach(tm => {
       tm.norm = tm.data.map(m => normMatch(m, tm.member));
    });

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
    const reqs = ROSTER.map(m => api(`/valorant/v4/matches/${region}/pc/${enc(m.name)}/${enc(m.tag)}?mode=competitive&size=15`));
    const results = await Promise.allSettled(reqs);
    TRIB.matches = results.map((r, i) => {
      const data = r.status === 'fulfilled' ? (r.value.data || []) : [];
      const member = ROSTER[i];
      return { member, data, norm: data.map(m => normMatch(m, member)) };
    });
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
function init(){
  wireRosterImgs();
  wireStatic();
  drawGauge('gaugeTrib');
  fillRanks();
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init);
else init();