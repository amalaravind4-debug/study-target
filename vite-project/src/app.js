import './style.css';
import {
  SUBJECTS, CORE_ORDER_DEFAULT, FIXED_TAIL, PSIR_TOPICS, MALAYALAM_TOPICS,
  GS_DAYS, rebuildGSDays, TOTAL_DAYS, OPTIONAL_DAYS, caTopicForDay,
  buildWeightedSequence, recommendPYQs
} from './data.js';


/* ============== STORAGE COMPATIBILITY SHIM ==============
   window.storage is provided natively inside Claude.ai's artifact preview.
   Outside that environment (e.g. deployed on Vercel), it doesn't exist —
   so this polyfills the same get/set/delete/list interface using the
   browser's own localStorage. Nothing else in this file needs to change
   for either environment. */
if(typeof window.storage === 'undefined'){
  window.storage = {
    async get(key){
      try{
        const v = localStorage.getItem('upsc:'+key);
        return v===null ? null : {key, value:v, shared:false};
      }catch(e){ return null; }
    },
    async set(key, value){
      try{
        localStorage.setItem('upsc:'+key, value);
        return {key, value, shared:false};
      }catch(e){ return null; }
    },
    async delete(key){
      try{ localStorage.removeItem('upsc:'+key); return {key, deleted:true, shared:false}; }
      catch(e){ return null; }
    },
    async list(prefix){
      try{
        const p = 'upsc:'+(prefix||'');
        const keys = Object.keys(localStorage).filter(k=>k.startsWith(p)).map(k=>k.slice(5));
        return {keys, prefix, shared:false};
      }catch(e){ return null; }
    }
  };
}


/* ============== STATE ============== */
let state = {
  day: 1,
  profile: "psir", /* 'psir' or 'malayalam' */
  settings: { gsMin:120, optMin:90, awMin:45, revMin:30, caMin:60, startDate:"" },
  progress: {}, /* profile -> {day: {gs,opt,aw,rev,ca}} */
  subjectOrder: { psir: CORE_ORDER_DEFAULT.slice(), malayalam: CORE_ORDER_DEFAULT.slice() },
  dayBudgets: {
    gs: { psir:{}, malayalam:{} }, /* profile -> {subjectKey: totalDays} — how many days to give that whole subject; app splits them across its topics by weight */
    opt: { psir:null, malayalam:null } /* profile -> totalDays for the whole optional syllabus, or null for the default 1 day/topic */
  },
  dayChoice: { psir:{}, malayalam:{} }, /* profile -> {day: {subjectKey, idx}} — manual GS topic pick, overrides the planned sequence */
  optChoice: { psir:{}, malayalam:{} }, /* profile -> {day: idx} — manual optional-topic pick */
  totalSeconds: { psir:0, malayalam:0 }, /* lifetime cumulative seconds studied, per profile */
  dailySlotSeconds: { psir:{}, malayalam:{} }, /* profile -> {day: {gs,opt,aw,ca,rev}} seconds, for charts */
  notes: { psir:{}, malayalam:{} }, /* profile -> {day: text} — revision notes, surfaced back in spaced revision */
  sync: {
    url: import.meta.env.VITE_SUPABASE_URL || "",
    key: import.meta.env.VITE_SUPABASE_ANON_KEY || "",
    code: import.meta.env.VITE_SYNC_CODE || ""
  }, /* Supabase config — defaults come from build-time env vars, can still be overridden in Settings */
  notifPermAsked:false
};
let timers = {}; /* slot -> {remaining, running, intervalId, duration} */
let storageReady = false;
let syncStatus = "off"; /* off | synced | syncing | error */
let totalTimeDirtyTicks = 0;
let noteSaveTimeout = null;

function optionalTopics(){ return state.profile==="psir" ? PSIR_TOPICS : MALAYALAM_TOPICS; }
function optionalLabel(){ return state.profile==="psir" ? "PSIR — Political Science & IR" : "Malayalam Literature"; }

/* Effective topic for a given day = manual pick if the person made one, else the planned/suggested one. */
function getEffectiveGS(day, profile){
  profile = profile || state.profile;
  const choice = (state.dayChoice[profile]||{})[day];
  if(choice && SUBJECTS[choice.subjectKey] && SUBJECTS[choice.subjectKey].topics[choice.idx]!==undefined){
    const subj = SUBJECTS[choice.subjectKey];
    return {
      subjectKey: choice.subjectKey, subjectLabel: subj.label, color: subj.color,
      topic: subj.topics[choice.idx], posInSubject: choice.idx+1, subjectTotal: subj.topics.length,
      topicDayIndex: 1, topicDayTotal: 1,
      isOverride: true
    };
  }
  const g = GS_DAYS[day-1];
  return { subjectKey:g.subjectKey, subjectLabel:g.subjectLabel, color:g.color, topic:g.topic,
    posInSubject:g.posInSubject, subjectTotal:g.subjectTotal,
    topicDayIndex: g.topicDayIndex||1, topicDayTotal: g.topicDayTotal||1, isOverride:false };
}
/* Cached per profile so we don't rebuild the weighted sequence on every render;
   invalidated whenever the optional day-budget is saved (see saveDayBudgets). */
let optSeqCache = { psir:null, malayalam:null };
function getOptSequence(profile){
  if(optSeqCache[profile]) return optSeqCache[profile];
  const topics = profile==='psir' ? PSIR_TOPICS : MALAYALAM_TOPICS;
  const budget = state.dayBudgets.opt[profile];
  const seq = (budget && budget!==topics.length) ? buildWeightedSequence(topics, budget).seq : topics.map((_,i)=>i);
  optSeqCache[profile] = seq;
  return seq;
}
function getEffectiveOpt(day, profile){
  profile = profile || state.profile;
  const topics = profile==='psir' ? PSIR_TOPICS : MALAYALAM_TOPICS;
  const choice = (state.optChoice[profile]||{})[day];
  if(choice!==undefined && topics[choice]!==undefined){
    return { idx:choice, topic:topics[choice], isOverride:true };
  }
  const seq = getOptSequence(profile);
  const idx = seq[(day-1) % seq.length]; /* cycles through once the first pass is done */
  return { idx, topic:topics[idx], isOverride:false };
}

/* ============== SUPABASE SYNC (optional cloud backup, best-effort) ==============
   Table needed in your Supabase project:

   create table upsc_sync (
     id bigint generated always as identity primary key,
     sync_code text not null,
     scope text not null,
     key text not null,
     value jsonb not null,
     updated_at timestamptz default now(),
     unique (sync_code, scope, key)
   );
   alter table upsc_sync enable row level security;
   create policy "allow anon all" on upsc_sync for all using (true) with check (true);

   Enter your Project URL, anon/public API key, and a private "sync code" (any string
   you both use) in Settings → Cloud Sync. Everything still works locally without this. */
function supaConfigured(){
  return !!(state.sync.url && state.sync.key && state.sync.code);
}
function setSyncStatus(s){
  syncStatus = s;
  const el = document.getElementById('syncStatusText');
  if(el) el.textContent = syncStatusLabel();
}
function syncStatusLabel(){
  if(!supaConfigured()) return "Not configured — saving locally only";
  if(syncStatus==='synced') return "Synced ✓";
  if(syncStatus==='syncing') return "Syncing…";
  if(syncStatus==='error') return "Sync error — check URL/key/network";
  return "Configured — not yet synced";
}
async function supaUpsert(scope, key, value){
  if(!supaConfigured()) return;
  setSyncStatus('syncing');
  try{
    const url = state.sync.url.replace(/\/$/,'') + '/rest/v1/upsc_sync?on_conflict=sync_code,scope,key';
    const res = await fetch(url, {
      method:'POST',
      headers:{
        'apikey': state.sync.key,
        'Authorization': 'Bearer '+state.sync.key,
        'Content-Type':'application/json',
        'Prefer':'resolution=merge-duplicates'
      },
      body: JSON.stringify([{ sync_code: state.sync.code, scope, key, value, updated_at: new Date().toISOString() }])
    });
    if(!res.ok) throw new Error('status '+res.status);
    setSyncStatus('synced');
  }catch(e){ setSyncStatus('error'); }
}
async function supaFetch(scope, key){
  if(!supaConfigured()) return undefined;
  try{
    const url = state.sync.url.replace(/\/$/,'') + '/rest/v1/upsc_sync?sync_code=eq.'+encodeURIComponent(state.sync.code)+
      '&scope=eq.'+encodeURIComponent(scope)+'&key=eq.'+encodeURIComponent(key)+'&select=value';
    const res = await fetch(url, { headers:{ 'apikey': state.sync.key, 'Authorization':'Bearer '+state.sync.key } });
    if(!res.ok) throw new Error('status '+res.status);
    const data = await res.json();
    setSyncStatus('synced');
    return (data && data.length) ? data[0].value : null;
  }catch(e){ setSyncStatus('error'); return undefined; }
}
async function loadProfileScopedData(profile){
  /* subjectOrder */
  try{
    const so = await window.storage.get('subjectOrder:'+profile);
    if(so && so.value){
      const parsed = JSON.parse(so.value);
      if(Array.isArray(parsed) && parsed.length===CORE_ORDER_DEFAULT.length) state.subjectOrder[profile] = parsed;
    }
  }catch(e){}
  /* dayChoice */
  try{
    const dc = await window.storage.get('dayChoice:'+profile);
    if(dc && dc.value) state.dayChoice[profile] = JSON.parse(dc.value);
  }catch(e){}
  /* optChoice */
  try{
    const oc = await window.storage.get('optChoice:'+profile);
    if(oc && oc.value) state.optChoice[profile] = JSON.parse(oc.value);
  }catch(e){}
  /* dayBudgets — GS per-subject day totals, and optional total-day budget */
  try{
    const bg = await window.storage.get('dayBudgetsGS:'+profile);
    if(bg && bg.value) state.dayBudgets.gs[profile] = JSON.parse(bg.value);
  }catch(e){}
  try{
    const bo = await window.storage.get('dayBudgetOpt:'+profile);
    if(bo && bo.value) state.dayBudgets.opt[profile] = JSON.parse(bo.value);
  }catch(e){}
  optSeqCache[profile] = null;
  /* dailySlotSeconds */
  try{
    const dss = await window.storage.get('dailySlotSeconds:'+profile);
    if(dss && dss.value) state.dailySlotSeconds[profile] = JSON.parse(dss.value);
  }catch(e){}
  /* notes */
  try{
    const nt = await window.storage.get('notes:'+profile);
    if(nt && nt.value) state.notes[profile] = JSON.parse(nt.value);
  }catch(e){}
  /* totalSeconds — local value first */
  let localSeconds = 0;
  try{
    const ts = await window.storage.get('totalSeconds:'+profile);
    if(ts && ts.value) localSeconds = parseInt(ts.value,10) || 0;
  }catch(e){}
  state.totalSeconds[profile] = Math.max(state.totalSeconds[profile]||0, localSeconds);

  if(supaConfigured()){
    const remoteOrder = await supaFetch(profile,'subjectOrder');
    if(remoteOrder && Array.isArray(remoteOrder) && remoteOrder.length===CORE_ORDER_DEFAULT.length) state.subjectOrder[profile] = remoteOrder;
    const remoteDayChoice = await supaFetch(profile,'dayChoice');
    if(remoteDayChoice) state.dayChoice[profile] = remoteDayChoice;
    const remoteOptChoice = await supaFetch(profile,'optChoice');
    if(remoteOptChoice) state.optChoice[profile] = remoteOptChoice;
    const remoteBudgetsGS = await supaFetch(profile,'dayBudgetsGS');
    if(remoteBudgetsGS) state.dayBudgets.gs[profile] = remoteBudgetsGS;
    const remoteBudgetOpt = await supaFetch(profile,'dayBudgetOpt');
    if(remoteBudgetOpt!==undefined && remoteBudgetOpt!==null) state.dayBudgets.opt[profile] = remoteBudgetOpt;
    optSeqCache[profile] = null;
    const remoteDailySlotSeconds = await supaFetch(profile,'dailySlotSeconds');
    if(remoteDailySlotSeconds) state.dailySlotSeconds[profile] = remoteDailySlotSeconds;
    const remoteNotes = await supaFetch(profile,'notes');
    if(remoteNotes) state.notes[profile] = remoteNotes;
    const remoteSeconds = await supaFetch(profile,'totalSeconds');
    if(typeof remoteSeconds === 'number') state.totalSeconds[profile] = Math.max(state.totalSeconds[profile]||0, remoteSeconds);
  }
}
async function pullAllFromSupabase(){
  if(!supaConfigured()) return;
  const remoteSettings = await supaFetch('shared','settings');
  if(remoteSettings) state.settings = Object.assign(state.settings, remoteSettings);
  await loadProfileScopedData(state.profile);
  rebuildGSDays(state.subjectOrder[state.profile], state.dayBudgets.gs[state.profile]);
  const remoteDay = await supaFetch('shared','currentDay');
  if(remoteDay) state.day = remoteDay;
  const remoteProgress = await supaFetch(state.profile,'progress');
  if(remoteProgress) state.progress[state.profile] = remoteProgress;
}
async function pushAllToSupabase(){
  if(!supaConfigured()) return;
  await supaUpsert('shared','settings', state.settings);
  await supaUpsert(state.profile,'subjectOrder', state.subjectOrder[state.profile]);
  await supaUpsert(state.profile,'dayChoice', state.dayChoice[state.profile]||{});
  await supaUpsert(state.profile,'optChoice', state.optChoice[state.profile]||{});
  await supaUpsert(state.profile,'dayBudgetsGS', state.dayBudgets.gs[state.profile]||{});
  await supaUpsert(state.profile,'dayBudgetOpt', state.dayBudgets.opt[state.profile]||null);
  await supaUpsert(state.profile,'totalSeconds', state.totalSeconds[state.profile]||0);
  await supaUpsert(state.profile,'dailySlotSeconds', state.dailySlotSeconds[state.profile]||{});
  await supaUpsert(state.profile,'notes', state.notes[state.profile]||{});
  await supaUpsert('shared','currentDay', state.day);
  await supaUpsert(state.profile,'progress', state.progress[state.profile]||{});
}
async function manualSyncNow(){
  await pullAllFromSupabase();
  await pushAllToSupabase();
  render();
}

/* ============== PERSISTENCE ============== */
async function loadState(){
  try{
    const sy = await window.storage.get('sync');
    if(sy && sy.value) state.sync = Object.assign(state.sync, JSON.parse(sy.value));
  }catch(e){}
  try{
    const s = await window.storage.get('settings');
    if(s && s.value) state.settings = Object.assign(state.settings, JSON.parse(s.value));
  }catch(e){}
  try{
    const p = await window.storage.get('profile');
    if(p && p.value) state.profile = p.value;
  }catch(e){}
  await loadProfileScopedData(state.profile);
  rebuildGSDays(state.subjectOrder[state.profile], state.dayBudgets.gs[state.profile]);
  try{
    const d = await window.storage.get('currentDay');
    if(d && d.value) state.day = parseInt(d.value,10) || 1;
  }catch(e){}
  await loadProgress();
  if(supaConfigured()){ await pullAllFromSupabase(); }
  storageReady = true;
}
async function loadProgress(){
  try{
    const key = 'progress:'+state.profile;
    const r = await window.storage.get(key);
    state.progress[state.profile] = (r && r.value) ? JSON.parse(r.value) : {};
  }catch(e){
    state.progress[state.profile] = state.progress[state.profile] || {};
  }
}
async function saveSync(){
  try{ await window.storage.set('sync', JSON.stringify(state.sync)); }catch(e){}
}
async function saveSettings(){
  try{ await window.storage.set('settings', JSON.stringify(state.settings)); }catch(e){}
  supaUpsert('shared','settings', state.settings);
}
async function saveSubjectOrder(){
  try{ await window.storage.set('subjectOrder:'+state.profile, JSON.stringify(state.subjectOrder[state.profile])); }catch(e){}
  supaUpsert(state.profile,'subjectOrder', state.subjectOrder[state.profile]);
}
async function saveDayChoice(){
  try{ await window.storage.set('dayChoice:'+state.profile, JSON.stringify(state.dayChoice[state.profile]||{})); }catch(e){}
  supaUpsert(state.profile,'dayChoice', state.dayChoice[state.profile]||{});
}
async function saveOptChoice(){
  try{ await window.storage.set('optChoice:'+state.profile, JSON.stringify(state.optChoice[state.profile]||{})); }catch(e){}
  supaUpsert(state.profile,'optChoice', state.optChoice[state.profile]||{});
}
async function saveDayBudgets(){
  try{ await window.storage.set('dayBudgetsGS:'+state.profile, JSON.stringify(state.dayBudgets.gs[state.profile]||{})); }catch(e){}
  try{ await window.storage.set('dayBudgetOpt:'+state.profile, JSON.stringify(state.dayBudgets.opt[state.profile]||null)); }catch(e){}
  optSeqCache[state.profile] = null;
  supaUpsert(state.profile,'dayBudgetsGS', state.dayBudgets.gs[state.profile]||{});
  supaUpsert(state.profile,'dayBudgetOpt', state.dayBudgets.opt[state.profile]||null);
}
async function persistTotalTime(){
  const secs = state.totalSeconds[state.profile]||0;
  try{ await window.storage.set('totalSeconds:'+state.profile, String(secs)); }catch(e){}
  supaUpsert(state.profile,'totalSeconds', secs);
}
async function persistDailySlotSeconds(){
  const data = state.dailySlotSeconds[state.profile]||{};
  try{ await window.storage.set('dailySlotSeconds:'+state.profile, JSON.stringify(data)); }catch(e){}
  supaUpsert(state.profile,'dailySlotSeconds', data);
}
async function saveNote(day, text){
  const notes = state.notes[state.profile] || (state.notes[state.profile]={});
  if(text && text.trim()){ notes[day] = text; } else { delete notes[day]; }
  try{ await window.storage.set('notes:'+state.profile, JSON.stringify(notes)); }catch(e){}
  supaUpsert(state.profile,'notes', notes);
}
async function saveProfile(){
  try{ await window.storage.set('profile', state.profile); }catch(e){}
}
async function saveDay(){
  try{ await window.storage.set('currentDay', String(state.day)); }catch(e){}
  supaUpsert('shared','currentDay', state.day);
}
async function saveProgress(){
  try{
    const key='progress:'+state.profile;
    await window.storage.set(key, JSON.stringify(state.progress[state.profile]||{}));
  }catch(e){}
  supaUpsert(state.profile,'progress', state.progress[state.profile]||{});
}

function getDayProgress(day){
  const p = state.progress[state.profile] || {};
  return p[day] || {gs:false, opt:false, aw:false, rev:false, ca:false};
}
function setDayProgress(day, slot, val){
  const p = state.progress[state.profile] || {};
  const d = p[day] || {gs:false, opt:false, aw:false, rev:false, ca:false};
  d[slot]=val;
  p[day]=d;
  state.progress[state.profile]=p;
  saveProgress();
}

/* ============== REVISION LOGIC ============== */
function getRevisionItems(day){
  const offsets = [1,3,7,28,90];
  const items = [];
  offsets.forEach(o=>{
    const src = day - o;
    if(src>=1 && src<=TOTAL_DAYS){
      const g = getEffectiveGS(src);
      items.push({when:o+"d", label:g.subjectLabel, topic:g.topic});
      const opt = getEffectiveOpt(src);
      items.push({when:o+"d", label:optionalLabel(), topic:opt.topic});
      const note = (state.notes[state.profile]||{})[src];
      if(note){ items.push({when:o+"d", label:"Your note from Day "+src, topic:note, isNote:true}); }
    }
  });
  return items;
}

/* ============== AUDIO / NOTIFY ============== */
function beep(){
  try{
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    [880,660,880].forEach((freq,i)=>{
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type='sine'; o.frequency.value=freq;
      o.connect(g); g.connect(ctx.destination);
      const t = ctx.currentTime + i*0.28;
      g.gain.setValueAtTime(0.001, t);
      g.gain.linearRampToValueAtTime(0.25, t+0.02);
      g.gain.linearRampToValueAtTime(0.001, t+0.24);
      o.start(t); o.stop(t+0.26);
    });
  }catch(e){}
}
function tryNotify(title, body){
  try{
    if('Notification' in window){
      if(Notification.permission==='granted'){ new Notification(title, {body}); }
    }
  }catch(e){}
}
function requestNotifPerm(){
  try{
    if('Notification' in window && Notification.permission==='default'){
      Notification.requestPermission();
    }
  }catch(e){}
}

function showBanner(msg){
  const b = document.createElement('div');
  b.className='banner';
  b.textContent = msg;
  document.body.appendChild(b);
  setTimeout(()=>{ b.remove(); }, 4200);
}

/* ============== TIMERS ============== */
function fmt(sec){
  const m = Math.floor(sec/60), s = sec%60;
  return String(m).padStart(2,'0')+":"+String(s).padStart(2,'0');
}
function slotMinutes(slot){
  if(slot==='gs') return state.settings.gsMin;
  if(slot==='opt') return state.settings.optMin;
  if(slot==='aw') return state.settings.awMin;
  if(slot==='rev') return state.settings.revMin;
  if(slot==='ca') return state.settings.caMin;
  return 30;
}
function slotName(slot){
  if(slot==='gs') return 'Subject 1';
  if(slot==='opt') return 'Optional';
  if(slot==='aw') return 'Answer Writing';
  if(slot==='rev') return 'Spaced Revision';
  if(slot==='ca') return 'Current Affairs';
}
let persistedTimers = {}; /* slot -> {day, profile, status:'running'|'paused', endAt|remaining} — survives reloads */
async function loadPersistedTimers(){
  try{
    const r = await window.storage.get('runningTimers');
    persistedTimers = (r && r.value) ? JSON.parse(r.value) : {};
  }catch(e){ persistedTimers = {}; }
}
function savePersistedTimers(){
  try{ window.storage.set('runningTimers', JSON.stringify(persistedTimers)); }catch(e){}
}
function setPersistedTimer(slot, data){
  persistedTimers[slot] = data;
  savePersistedTimers();
}
function clearPersistedTimer(slot){
  if(persistedTimers[slot]){ delete persistedTimers[slot]; savePersistedTimers(); }
}
function initTimer(slot){
  if(timers[slot]) return;
  const dur = slotMinutes(slot)*60;
  const p = persistedTimers[slot];
  if(p && p.day===state.day && p.profile===state.profile){
    if(p.status==='running' && p.endAt){
      const remaining = Math.max(0, Math.round((p.endAt-Date.now())/1000));
      timers[slot] = { duration:dur, remaining, running:true, endAt:p.endAt, lastTick:Date.now(), intervalId:null };
      return;
    }
    if(p.status==='paused' && typeof p.remaining==='number'){
      timers[slot] = { duration:dur, remaining:p.remaining, running:false, endAt:null, lastTick:null, intervalId:null };
      return;
    }
  }
  timers[slot] = { duration:dur, remaining:dur, running:false, endAt:null, lastTick:null, intervalId:null };
}
/* After render() rebuilds the DOM, any slot restored from persistence with status
   'running' needs its interval (re)started — or, if time fully elapsed while the
   app was closed, the completion should fire right now as a catch-up. */
function resumeRestoredTimers(){
  Object.keys(timers).forEach(slot=>{
    const t = timers[slot];
    if(!t || !t.running || t.intervalId) return;
    updateTimerDisplay(slot);
    updateButtons(slot);
    if(t.remaining<=0){
      t.running = false;
      onSlotTimeUp(slot);
      clearPersistedTimer(slot);
      persistTotalTime();
      persistDailySlotSeconds();
      updateButtons(slot);
    } else {
      t.lastTick = Date.now();
      t.intervalId = setInterval(()=>tickTimer(slot), 1000);
    }
  });
}
function bumpTotalTime(slot, secs){
  if(secs<=0) return;
  state.totalSeconds[state.profile] = (state.totalSeconds[state.profile]||0) + secs;
  const dss = state.dailySlotSeconds[state.profile] || (state.dailySlotSeconds[state.profile]={});
  const bucket = dss[state.day] || (dss[state.day]={gs:0,opt:0,aw:0,ca:0,rev:0});
  bucket[slot] = (bucket[slot]||0) + secs;
  updateTotalTimeDisplay();
  totalTimeDirtyTicks += secs;
  if(totalTimeDirtyTicks>=20){
    totalTimeDirtyTicks = 0;
    persistTotalTime();
    persistDailySlotSeconds();
  }
}
function updateTotalTimeDisplay(){
  const el = document.getElementById('totalTimeStat');
  if(el) el.textContent = fmtHM(state.totalSeconds[state.profile]||0);
}
function fmtHM(totalSec){
  const h = Math.floor(totalSec/3600), m = Math.floor((totalSec%3600)/60);
  return h+"h "+String(m).padStart(2,'0')+"m";
}
/* Timestamp-based tick: computes remaining from wall-clock time rather than counting
   ticks, so throttled/suspended background tabs self-correct the instant they resume
   instead of drifting or losing time. */
function tickTimer(slot){
  const t = timers[slot];
  if(!t || !t.running) return;
  const now = Date.now();
  const elapsed = Math.max(0, Math.round((now - t.lastTick)/1000));
  if(elapsed>0){
    const credit = Math.min(elapsed, t.remaining);
    if(credit>0) bumpTotalTime(slot, credit);
    t.remaining = Math.max(0, Math.round((t.endAt - now)/1000));
    t.lastTick = now;
    updateTimerDisplay(slot);
  }
  if(t.remaining<=0 && t.running){
    if(t.intervalId) clearInterval(t.intervalId);
    t.running = false;
    updateTimerDisplay(slot);
    onSlotTimeUp(slot);
    clearPersistedTimer(slot);
    persistTotalTime();
    persistDailySlotSeconds();
  }
}
function startTimer(slot){
  initTimer(slot);
  if(timers[slot].running) return;
  const t = timers[slot];
  t.running = true;
  t.endAt = Date.now() + t.remaining*1000;
  t.lastTick = Date.now();
  t.intervalId = setInterval(()=>tickTimer(slot), 1000);
  setPersistedTimer(slot, {day:state.day, profile:state.profile, status:'running', endAt:t.endAt});
  updateButtons(slot);
}
function pauseTimer(slot){
  const t = timers[slot];
  if(t && t.running){
    tickTimer(slot);
    if(t.intervalId) clearInterval(t.intervalId);
    t.running = false;
    if(t.remaining>0){
      setPersistedTimer(slot, {day:state.day, profile:state.profile, status:'paused', remaining:t.remaining});
    } else {
      clearPersistedTimer(slot);
    }
    persistTotalTime();
    persistDailySlotSeconds();
  }
  updateButtons(slot);
}
function resetTimer(slot){
  if(timers[slot] && timers[slot].running && timers[slot].intervalId) clearInterval(timers[slot].intervalId);
  const dur = slotMinutes(slot)*60;
  timers[slot] = { duration:dur, remaining:dur, running:false, endAt:null, lastTick:null, intervalId:null };
  clearPersistedTimer(slot);
  updateTimerDisplay(slot);
  updateButtons(slot);
  const card = document.getElementById('card-'+slot);
  if(card) card.classList.remove('flash');
}
function onSlotTimeUp(slot){
  const card = document.getElementById('card-'+slot);
  if(card){ card.classList.add('flash'); }
  beep();
  showBanner("Time's up — " + slotName(slot));
  tryNotify("Time's up", slotName(slot)+" slot has ended.");
  notifyViaServiceWorker("Time's up", slotName(slot)+" slot has ended.");
}
function updateTimerDisplay(slot){
  const el = document.getElementById('timer-'+slot);
  if(el){
    el.textContent = fmt(timers[slot].remaining);
    el.classList.toggle('done', timers[slot].remaining<=0);
  }
}
function updateButtons(slot){
  const startBtn = document.getElementById('start-'+slot);
  const pauseBtn = document.getElementById('pause-'+slot);
  if(startBtn) startBtn.disabled = timers[slot] && timers[slot].running;
  if(pauseBtn) pauseBtn.disabled = !(timers[slot] && timers[slot].running);
}
function anyTimerRunning(){
  return Object.keys(timers).some(s=>timers[s] && timers[s].running);
}
function clearAllTimers(){
  const wasRunning = anyTimerRunning();
  Object.keys(timers).forEach(slot=>{
    if(timers[slot] && timers[slot].running) tickTimer(slot);
    if(timers[slot] && timers[slot].intervalId) clearInterval(timers[slot].intervalId);
  });
  if(wasRunning){ persistTotalTime(); persistDailySlotSeconds(); }
  timers = {};
}
/* Catch up the instant the tab/screen becomes visible again — this is what makes the

   timer trustworthy even though the browser suspends JS while backgrounded/screen-off:
   nothing runs while hidden, but the very first moment you look, elapsed real time is
   computed from timestamps and applied all at once. */
document.addEventListener('visibilitychange', ()=>{
  if(!document.hidden){
    Object.keys(timers).forEach(slot=>{ if(timers[slot] && timers[slot].running) tickTimer(slot); });
  } else if(anyTimerRunning()){
    persistTotalTime();
    persistDailySlotSeconds();
  }
});
window.addEventListener('beforeunload', ()=>{
  if(anyTimerRunning()){ persistTotalTime(); persistDailySlotSeconds(); }
});
function notifyViaServiceWorker(title, body){
  try{
    if('serviceWorker' in navigator && navigator.serviceWorker.controller){
      navigator.serviceWorker.controller.postMessage({ type:'notify', title, body, tag:'upsc-timer' });
    }
  }catch(e){}
}


/* ============== RENDER ============== */
function fmtDate(d){
  return d.toLocaleDateString('en-IN', {day:'2-digit', month:'short', year:'numeric'});
}
function scheduledDate(day){
  if(!state.settings.startDate) return null;
  const start = new Date(state.settings.startDate+"T00:00:00");
  const d = new Date(start);
  d.setDate(d.getDate() + (day-1));
  return d;
}

function buildSubjectOptions(selectedKey){
  const order = CORE_ORDER_DEFAULT.concat(FIXED_TAIL);
  return order.map(k=>`<option value="${k}" ${k===selectedKey?'selected':''}>${esc(SUBJECTS[k].label)}</option>`).join('');
}
function buildGSTopicOptions(subjectKey, selectedIdx){
  return SUBJECTS[subjectKey].topics.map((t,i)=>`<option value="${i}" ${i===selectedIdx?'selected':''}>${i+1}. ${esc(t.slice(0,70))}${t.length>70?'…':''}</option>`).join('');
}
function buildOptTopicOptions(profile, selectedIdx){
  const topics = profile==='psir' ? PSIR_TOPICS : MALAYALAM_TOPICS;
  return topics.map((t,i)=>`<option value="${i}" ${i===selectedIdx?'selected':''}>${i+1}. ${esc(t.slice(0,70))}${t.length>70?'…':''}</option>`).join('');
}

function render(){
  clearAllTimers();
  const day = state.day;
  const effGS = getEffectiveGS(day);
  const effOpt = getEffectiveOpt(day);
  const prog = getDayProgress(day);
  const revItems = getRevisionItems(day);
  const dateObj = scheduledDate(day);
  ['gs','opt','aw','ca','rev'].forEach(initTimer);

  const gsPYQs = recommendPYQs(effGS.subjectKey, effGS.topic, 2);
  const optPYQs = recommendPYQs(state.profile, effOpt.topic, 2);
  const pyqHtml = (items)=> items.length
    ? items.map(p=>'<div class="topic" style="font-size:12.5px; margin-bottom:4px;">• '+esc(p.q)+'</div>').join('')
    : '<div class="meta">No close match yet — pick any recent PYQ on this theme.</div>';

  const doneCount = [prog.gs, prog.opt, prog.aw, prog.rev, prog.ca].filter(Boolean).length;
  const totalSlots = 5;
  const overallPct = Math.round((day-1+ (doneCount/totalSlots)) / TOTAL_DAYS * 100);

  let spineHtml = '';
  for(let i=1;i<=TOTAL_DAYS;i++){
    const gg = GS_DAYS[i-1];
    const dp = getDayProgress(i);
    const isDone = dp.gs && dp.aw && dp.rev && dp.ca && dp.opt;
    spineHtml += '<div class="tick'+(isDone?' done':'')+(i===day?' current':'')+'" style="background:'+gg.color+'" data-day="'+i+'" title="Day '+i+' — '+gg.subjectLabel+'"></div>';
  }

  let revHtml = '';
  if(revItems.length===0){
    revHtml = '<div class="topic" style="color:var(--muted)">No spaced-revision topics yet — they will appear from Day 2 onward.</div>';
  } else {
    revItems.forEach(it=>{
      revHtml += '<div class="rev-item"'+(it.isNote?' style="color:var(--gold);"':'')+'><span class="when mono">'+it.when+'</span><strong>'+it.label+':</strong> '+esc(it.topic)+'</div>';
    });
  }

  const html = `
    <header class="top">
      <div class="brand">
        <span class="eyebrow">The Campaign Ledger</span>
        <h1>300-Day UPSC Prep</h1>
      </div>
      <div class="top-actions">
        <div class="profile-switch">
          <button data-action="profile" data-value="psir" class="${state.profile==='psir'?'active':''}">Amal · PSIR</button>
          <button data-action="profile" data-value="malayalam" class="${state.profile==='malayalam'?'active':''}">Arya · Malayalam</button>
        </div>
        <button class="icon ghost" data-action="progress" aria-label="Progress charts">📈</button>
        <button class="icon ghost" data-action="report" aria-label="Weekly report">⬇</button>
        <button class="icon ghost" data-action="settings" aria-label="Settings">⚙</button>
      </div>
    </header>

    <div class="daynav">
      <button class="icon" data-action="prevday" ${day<=1?'disabled':''}>◀</button>
      <div class="center">
        <div class="daynum mono">Day ${day} <span style="color:var(--muted); font-size:16px;">/ ${TOTAL_DAYS}</span></div>
        <div class="phase">${effGS.subjectLabel} · ${effGS.posInSubject}/${effGS.subjectTotal}${effGS.isOverride?' · your pick':' · planned'}</div>
        ${dateObj ? '<div class="datestr">'+fmtDate(dateObj)+'</div>' : ''}
        <div class="datestr">Total studied: <span id="totalTimeStat" class="mono">${fmtHM(state.totalSeconds[state.profile]||0)}</span></div>
      </div>
      <button class="icon" data-action="nextday" ${day>=TOTAL_DAYS?'disabled':''}>▶</button>
    </div>

    <div class="progressbar"><div style="width:${overallPct}%"></div></div>

    <div class="spine-wrap"><div class="spine">${spineHtml}</div></div>

    <div class="grid">
      <div class="card" id="card-gs">
        <span class="label">Subject 1 of 2 ${effGS.isOverride?'· your pick':'· planned'}${effGS.topicDayTotal>1?' · Day '+effGS.topicDayIndex+'/'+effGS.topicDayTotal+' on this topic':''}</span>
        <h3>${effGS.subjectLabel}</h3>
        <div class="topic">${effGS.topic}</div>
        <div class="pyq-box" style="background:var(--surface2); border-radius:8px; padding:8px;">
          <div class="label" style="margin-bottom:4px;">Recommended PYQs to write on</div>
          ${pyqHtml(gsPYQs)}
        </div>
        <button class="ghost" style="align-self:flex-start; font-size:11px; padding:5px 9px;" data-action="toggleGSPicker">Change topic</button>
        <div id="gsPicker" style="display:none; background:var(--surface2); border-radius:8px; padding:8px; gap:6px; flex-direction:column;">
          <select id="gsPickerSubject" style="width:100%; padding:6px; border-radius:6px; background:var(--surface); color:var(--text); border:1px solid var(--line);">${buildSubjectOptions(effGS.subjectKey)}</select>
          <select id="gsPickerTopic" style="width:100%; padding:6px; border-radius:6px; background:var(--surface); color:var(--text); border:1px solid var(--line);">${buildGSTopicOptions(effGS.subjectKey, effGS.posInSubject-1)}</select>
          <div style="display:flex; gap:6px;">
            <button class="primary" style="flex:1;" data-action="saveGSChoice">Save</button>
            ${effGS.isOverride?'<button class="ghost" data-action="resetGSChoice">Reset to planned</button>':''}
          </div>
        </div>
        <div class="row">
          <label class="check"><input type="checkbox" data-action="check" data-slot="gs" ${prog.gs?'checked':''}/> Done</label>
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="timer mono" id="timer-gs">${fmt(timers.gs.remaining)}</span>
            <button class="icon" id="start-gs" data-action="start" data-slot="gs" ${timers.gs.running?'disabled':''}>▶</button>
            <button class="icon" id="pause-gs" data-action="pause" data-slot="gs" ${timers.gs.running?'':'disabled'}>❚❚</button>
            <button class="icon ghost" data-action="reset" data-slot="gs">↺</button>
          </div>
        </div>
      </div>

      <div class="card" id="card-opt">
        <span class="label">Subject 2 of 2 — Optional ${effOpt.isOverride?'· your pick':'· planned'}</span>
        <h3>${optionalLabel()}</h3>
        <div class="topic">${effOpt.topic}</div>
        <div class="pyq-box" style="background:var(--surface2); border-radius:8px; padding:8px;">
          <div class="label" style="margin-bottom:4px;">Recommended PYQs to write on</div>
          ${pyqHtml(optPYQs)}
        </div>
        <button class="ghost" style="align-self:flex-start; font-size:11px; padding:5px 9px;" data-action="toggleOptPicker">Change topic</button>
        <div id="optPicker" style="display:none; background:var(--surface2); border-radius:8px; padding:8px; gap:6px; flex-direction:column;">
          <select id="optPickerTopic" style="width:100%; padding:6px; border-radius:6px; background:var(--surface); color:var(--text); border:1px solid var(--line);">${buildOptTopicOptions(state.profile, effOpt.idx)}</select>
          <div style="display:flex; gap:6px;">
            <button class="primary" style="flex:1;" data-action="saveOptChoice">Save</button>
            ${effOpt.isOverride?'<button class="ghost" data-action="resetOptChoice">Reset to planned</button>':''}
          </div>
        </div>
        <div class="row">
          <label class="check"><input type="checkbox" data-action="check" data-slot="opt" ${prog.opt?'checked':''}/> Done</label>
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="timer mono" id="timer-opt">${fmt(timers.opt.remaining)}</span>
            <button class="icon" id="start-opt" data-action="start" data-slot="opt" ${timers.opt.running?'disabled':''}>▶</button>
            <button class="icon" id="pause-opt" data-action="pause" data-slot="opt" ${timers.opt.running?'':'disabled'}>❚❚</button>
            <button class="icon ghost" data-action="reset" data-slot="opt">↺</button>
          </div>
        </div>
      </div>

      <div class="card" id="card-aw">
        <span class="label">Answer Writing</span>
        <h3>Daily Practice</h3>
        <div class="topic">Write 2 GS-style answers on today\\u2019s ${effGS.subjectLabel} topic, plus 1 optional-style answer.</div>
        <div class="row">
          <label class="check"><input type="checkbox" data-action="check" data-slot="aw" ${prog.aw?'checked':''}/> Done</label>
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="timer mono" id="timer-aw">${fmt(timers.aw.remaining)}</span>
            <button class="icon" id="start-aw" data-action="start" data-slot="aw" ${timers.aw.running?'disabled':''}>▶</button>
            <button class="icon" id="pause-aw" data-action="pause" data-slot="aw" ${timers.aw.running?'':'disabled'}>❚❚</button>
            <button class="icon ghost" data-action="reset" data-slot="aw">↺</button>
          </div>
        </div>
      </div>

      <div class="card" id="card-ca">
        <span class="label">Daily Habit</span>
        <h3>Current Affairs</h3>
        <div class="topic">${caTopicForDay(day)}</div>
        <div class="row">
          <label class="check"><input type="checkbox" data-action="check" data-slot="ca" ${prog.ca?'checked':''}/> Done</label>
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="timer mono" id="timer-ca">${fmt(timers.ca.remaining)}</span>
            <button class="icon" id="start-ca" data-action="start" data-slot="ca" ${timers.ca.running?'disabled':''}>▶</button>
            <button class="icon" id="pause-ca" data-action="pause" data-slot="ca" ${timers.ca.running?'':'disabled'}>❚❚</button>
            <button class="icon ghost" data-action="reset" data-slot="ca">↺</button>
          </div>
        </div>
      </div>

      <div class="card" id="card-rev">
        <span class="label">Spaced Revision</span>
        <h3>1 / 3 / 7 / 28 / 90-day recall</h3>
        <div>${revHtml}</div>
        <div class="row">
          <label class="check"><input type="checkbox" data-action="check" data-slot="rev" ${prog.rev?'checked':''}/> Done</label>
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="timer mono" id="timer-rev">${fmt(timers.rev.remaining)}</span>
            <button class="icon" id="start-rev" data-action="start" data-slot="rev" ${timers.rev.running?'disabled':''}>▶</button>
            <button class="icon" id="pause-rev" data-action="pause" data-slot="rev" ${timers.rev.running?'':'disabled'}>❚❚</button>
            <button class="icon ghost" data-action="reset" data-slot="rev">↺</button>
          </div>
        </div>
      </div>

      <div class="card" id="card-notes">
        <span class="label">Notes for Day ${day}</span>
        <h3>Revision Notes</h3>
        <textarea id="notesInput" placeholder="Key points, mnemonics, things to revisit — shown again automatically on this day's +1/+3/+7/+28/+90 revision cycles."
          style="width:100%; min-height:80px; resize:vertical; background:var(--surface2); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:8px; font-family:'IBM Plex Sans',sans-serif; font-size:13px;">${esc((state.notes[state.profile]||{})[day]||'')}</textarea>
        <div class="row" style="border-top:none; padding-top:2px;">
          <span id="noteSaveStatus" class="meta"></span>
          <button class="primary" data-action="saveNote">Save note</button>
        </div>
      </div>
    </div>

    <div class="note">
      Every day has 5 timed slots plus a Notes card. Each of you picks your own GS and Optional topic day by day — "Change topic" opens a picker over the full syllabus; whatever you don't touch just uses the suggested sequence from your subject order (Settings → Reorder). Spaced revision, notes, and the weekly report always reflect whatever you actually picked, not just the suggestion.
      Malayalam optional text/author list follows the standard syllabus structure — please cross-check specific prescribed works against your current UPSC syllabus notification.
    </div>

    <div id="modalRoot"></div>
  `;
  document.getElementById('app').innerHTML = html;
  attachHandlers();
  resumeRestoredTimers();
}

function attachHandlers(){
  document.querySelectorAll('[data-action="profile"]').forEach(b=>{
    b.addEventListener('click', async ()=>{
      state.profile = b.getAttribute('data-value');
      await saveProfile();
      await loadProgress();
      await loadProfileScopedData(state.profile);
      rebuildGSDays(state.subjectOrder[state.profile], state.dayBudgets.gs[state.profile]);
      if(supaConfigured()){
        const remoteProgress = await supaFetch(state.profile,'progress');
        if(remoteProgress) state.progress[state.profile] = remoteProgress;
      }
      render();
    });
  });
  const prev = document.querySelector('[data-action="prevday"]');
  if(prev) prev.addEventListener('click', ()=>{ if(state.day>1){ state.day--; saveDay(); render(); } });
  const next = document.querySelector('[data-action="nextday"]');
  if(next) next.addEventListener('click', ()=>{ if(state.day<TOTAL_DAYS){ state.day++; saveDay(); render(); } });

  document.querySelectorAll('.tick').forEach(t=>{
    t.addEventListener('click', ()=>{
      state.day = parseInt(t.getAttribute('data-day'),10);
      saveDay();
      render();
    });
  });

  document.querySelectorAll('[data-action="check"]').forEach(cb=>{
    cb.addEventListener('change', ()=>{
      setDayProgress(state.day, cb.getAttribute('data-slot'), cb.checked);
    });
  });
  document.querySelectorAll('[data-action="start"]').forEach(b=>{
    b.addEventListener('click', ()=>{ requestNotifPerm(); startTimer(b.getAttribute('data-slot')); });
  });
  document.querySelectorAll('[data-action="pause"]').forEach(b=>{
    b.addEventListener('click', ()=>{ pauseTimer(b.getAttribute('data-slot')); });
  });
  document.querySelectorAll('[data-action="reset"]').forEach(b=>{
    b.addEventListener('click', ()=>{ resetTimer(b.getAttribute('data-slot')); });
  });

  const settingsBtn = document.querySelector('[data-action="settings"]');
  if(settingsBtn) settingsBtn.addEventListener('click', openSettings);
  const reportBtn = document.querySelector('[data-action="report"]');
  if(reportBtn) reportBtn.addEventListener('click', ()=>openWeeklyReport(Math.ceil(state.day/7)));
  const progressBtn = document.querySelector('[data-action="progress"]');
  if(progressBtn) progressBtn.addEventListener('click', ()=>openProgressView());

  const gsToggle = document.querySelector('[data-action="toggleGSPicker"]');
  if(gsToggle) gsToggle.addEventListener('click', ()=>{
    const p = document.getElementById('gsPicker');
    p.style.display = (p.style.display==='none'||!p.style.display) ? 'flex' : 'none';
  });
  const optToggle = document.querySelector('[data-action="toggleOptPicker"]');
  if(optToggle) optToggle.addEventListener('click', ()=>{
    const p = document.getElementById('optPicker');
    p.style.display = (p.style.display==='none'||!p.style.display) ? 'flex' : 'none';
  });
  const gsSubjectSelect = document.getElementById('gsPickerSubject');
  if(gsSubjectSelect) gsSubjectSelect.addEventListener('change', ()=>{
    const topicSelect = document.getElementById('gsPickerTopic');
    topicSelect.innerHTML = buildGSTopicOptions(gsSubjectSelect.value, 0);
  });
  const saveGSBtn = document.querySelector('[data-action="saveGSChoice"]');
  if(saveGSBtn) saveGSBtn.addEventListener('click', async ()=>{
    const subjectKey = document.getElementById('gsPickerSubject').value;
    const idx = parseInt(document.getElementById('gsPickerTopic').value,10);
    const dc = state.dayChoice[state.profile] || (state.dayChoice[state.profile]={});
    dc[state.day] = {subjectKey, idx};
    await saveDayChoice();
    render();
  });
  const resetGSBtn = document.querySelector('[data-action="resetGSChoice"]');
  if(resetGSBtn) resetGSBtn.addEventListener('click', async ()=>{
    const dc = state.dayChoice[state.profile] || {};
    delete dc[state.day];
    await saveDayChoice();
    render();
  });
  const saveOptBtn = document.querySelector('[data-action="saveOptChoice"]');
  if(saveOptBtn) saveOptBtn.addEventListener('click', async ()=>{
    const idx = parseInt(document.getElementById('optPickerTopic').value,10);
    const oc = state.optChoice[state.profile] || (state.optChoice[state.profile]={});
    oc[state.day] = idx;
    await saveOptChoice();
    render();
  });
  const resetOptBtn = document.querySelector('[data-action="resetOptChoice"]');
  if(resetOptBtn) resetOptBtn.addEventListener('click', async ()=>{
    const oc = state.optChoice[state.profile] || {};
    delete oc[state.day];
    await saveOptChoice();
    render();
  });

  const notesInput = document.getElementById('notesInput');
  const noteStatus = document.getElementById('noteSaveStatus');
  const doSaveNote = async ()=>{
    await saveNote(state.day, notesInput.value);
    if(noteStatus) noteStatus.textContent = 'Saved ✓';
  };
  if(notesInput){
    notesInput.addEventListener('input', ()=>{
      if(noteStatus) noteStatus.textContent = 'Unsaved…';
      if(noteSaveTimeout) clearTimeout(noteSaveTimeout);
      noteSaveTimeout = setTimeout(doSaveNote, 1500);
    });
    notesInput.addEventListener('blur', ()=>{
      if(noteSaveTimeout) clearTimeout(noteSaveTimeout);
      doSaveNote();
    });
  }
  const saveNoteBtn = document.querySelector('[data-action="saveNote"]');
  if(saveNoteBtn) saveNoteBtn.addEventListener('click', ()=>{
    if(noteSaveTimeout) clearTimeout(noteSaveTimeout);
    doSaveNote();
  });
}

function openSettings(){
  const root = document.getElementById('modalRoot');
  root.innerHTML = `
    <div class="overlay" id="overlay">
      <div class="modal">
        <h2>Slot durations &amp; schedule</h2>
        <div class="field"><label>Subject 1 (GS) — minutes</label><input type="number" min="5" id="set-gs" value="${state.settings.gsMin}"></div>
        <div class="field"><label>Optional — minutes</label><input type="number" min="5" id="set-opt" value="${state.settings.optMin}"></div>
        <div class="field"><label>Answer Writing — minutes</label><input type="number" min="5" id="set-aw" value="${state.settings.awMin}"></div>
        <div class="field"><label>Spaced Revision — minutes</label><input type="number" min="5" id="set-rev" value="${state.settings.revMin}"></div>
        <div class="field"><label>Current Affairs — minutes</label><input type="number" min="5" id="set-ca" value="${state.settings.caMin}"></div>
        <div class="field"><label>Start date (Day 1)</label><input type="date" id="set-start" value="${state.settings.startDate||''}"></div>
        <button style="width:100%; margin-top:4px;" data-action="notifperm">Enable browser notifications (best-effort)</button>
        <button style="width:100%; margin-top:8px;" data-action="openReorder">Reorder subject sequence →</button>
        <button style="width:100%; margin-top:8px;" data-action="openDayBudget">Study plan — day budgets →</button>

        <h2 style="margin-top:20px;">Cloud sync (Supabase)</h2>
        <div class="field"><label>Project URL</label><input type="text" id="set-supa-url" placeholder="https://xxxx.supabase.co" value="${state.sync.url}" style="width:170px;"></div>
        <div class="field"><label>Anon/public API key</label><input type="text" id="set-supa-key" placeholder="eyJ..." value="${state.sync.key}" style="width:170px;"></div>
        <div class="field"><label>Sync code (shared by both of you)</label><input type="text" id="set-supa-code" placeholder="e.g. rowan-ledger-92" value="${state.sync.code}" style="width:170px;"></div>
        <div class="field"><label>Status</label><span id="syncStatusText" class="mono" style="font-size:11px;">${syncStatusLabel()}</span></div>
        <button style="width:100%;" data-action="syncNow">Sync now</button>
        <div class="note" style="margin-top:10px; padding-top:10px;">These are normally pre-filled automatically from your Vercel environment variables (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY / VITE_SYNC_CODE), so most people never need to touch this screen. Anything you type here and save overrides that default on this device only. Sync also requires the <span class="mono">upsc_sync</span> table to exist in your Supabase project — see the SQL comment near the top of src/app.js.</div>

        <div class="close-row">
          <button class="ghost" data-action="closeModal">Cancel</button>
          <button class="primary" data-action="saveSettings">Save</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById('overlay').addEventListener('click', (e)=>{ if(e.target.id==='overlay') closeModal(); });
  document.querySelector('[data-action="closeModal"]').addEventListener('click', closeModal);
  document.querySelector('[data-action="notifperm"]').addEventListener('click', requestNotifPerm);
  document.querySelector('[data-action="openReorder"]').addEventListener('click', openReorderModal);
  document.querySelector('[data-action="openDayBudget"]').addEventListener('click', openDayBudgetModal);
  document.querySelector('[data-action="syncNow"]').addEventListener('click', async ()=>{
    state.sync.url = document.getElementById('set-supa-url').value.trim();
    state.sync.key = document.getElementById('set-supa-key').value.trim();
    state.sync.code = document.getElementById('set-supa-code').value.trim();
    await saveSync();
    setSyncStatus(supaConfigured() ? 'syncing' : 'off');
    await manualSyncNow();
    openSettings();
  });
  document.querySelector('[data-action="saveSettings"]').addEventListener('click', async ()=>{
    state.settings.gsMin = parseInt(document.getElementById('set-gs').value,10) || state.settings.gsMin;
    state.settings.optMin = parseInt(document.getElementById('set-opt').value,10) || state.settings.optMin;
    state.settings.awMin = parseInt(document.getElementById('set-aw').value,10) || state.settings.awMin;
    state.settings.revMin = parseInt(document.getElementById('set-rev').value,10) || state.settings.revMin;
    state.settings.caMin = parseInt(document.getElementById('set-ca').value,10) || state.settings.caMin;
    state.settings.startDate = document.getElementById('set-start').value || '';
    state.sync.url = document.getElementById('set-supa-url').value.trim();
    state.sync.key = document.getElementById('set-supa-key').value.trim();
    state.sync.code = document.getElementById('set-supa-code').value.trim();
    await saveSettings();
    await saveSync();
    closeModal();
    render();
  });
}

function openReorderModal(){
  const root = document.getElementById('modalRoot');
  const order = state.subjectOrder[state.profile];
  const profileLabel = state.profile==='psir' ? 'Amal · PSIR' : 'Arya · Malayalam';
  const rows = order.map((key,i)=>{
    const label = SUBJECTS[key].label;
    return `<div class="field" data-key="${key}">
      <label>${i+1}. ${esc(label)}</label>
      <div style="display:flex; gap:6px;">
        <button class="icon" data-action="moveUp" data-idx="${i}" ${i===0?'disabled':''}>▲</button>
        <button class="icon" data-action="moveDown" data-idx="${i}" ${i===order.length-1?'disabled':''}>▼</button>
      </div>
    </div>`;
  }).join('');
  root.innerHTML = `
    <div class="overlay" id="overlay">
      <div class="modal">
        <h2>Reorder subject sequence — ${profileLabel}</h2>
        <div class="note" style="margin-top:0; border-top:none; padding-top:0;">This order applies only to ${profileLabel}'s plan — the other profile keeps its own sequence. Revision Rounds and the Test Series always stay last since they depend on content already covered. Heads up: reordering reshuffles which day maps to which topic — if you've already marked days complete, those checkmarks stay tied to the day number, not the subject, so double-check after reordering.</div>
        ${rows}
        <div class="close-row">
          <button class="ghost" data-action="resetOrder">Reset to default</button>
          <button class="ghost" data-action="backToSettings">Back</button>
          <button class="primary" data-action="saveOrder">Save order</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById('overlay').addEventListener('click', (e)=>{ if(e.target.id==='overlay') closeModal(); });
  document.querySelector('[data-action="backToSettings"]').addEventListener('click', openSettings);
  document.querySelector('[data-action="resetOrder"]').addEventListener('click', ()=>{
    state.subjectOrder[state.profile] = CORE_ORDER_DEFAULT.slice();
    openReorderModal();
  });
  document.querySelectorAll('[data-action="moveUp"]').forEach(b=>{
    b.addEventListener('click', ()=>{
      const i = parseInt(b.getAttribute('data-idx'),10);
      const o = state.subjectOrder[state.profile];
      if(i>0){ const t=o[i-1]; o[i-1]=o[i]; o[i]=t; }
      openReorderModal();
    });
  });
  document.querySelectorAll('[data-action="moveDown"]').forEach(b=>{
    b.addEventListener('click', ()=>{
      const i = parseInt(b.getAttribute('data-idx'),10);
      const o = state.subjectOrder[state.profile];
      if(i<o.length-1){ const t=o[i+1]; o[i+1]=o[i]; o[i]=t; }
      openReorderModal();
    });
  });
  document.querySelector('[data-action="saveOrder"]').addEventListener('click', async ()=>{
    rebuildGSDays(state.subjectOrder[state.profile], state.dayBudgets.gs[state.profile]);
    await saveSubjectOrder();
    closeModal();
    render();
  });
}

function openDayBudgetModal(){
  const root = document.getElementById('modalRoot');
  const profile = state.profile;
  const profileLabel = profile==='psir' ? 'Amal · PSIR' : 'Arya · Malayalam';
  const order = state.subjectOrder[profile];
  const budgets = state.dayBudgets.gs[profile] || {};

  const rows = order.map(key=>{
    const subj = SUBJECTS[key];
    const min = subj.topics.length;
    const val = budgets[key] || min;
    return `<div class="field" data-key="${key}">
      <label>${esc(subj.label)} <span class="meta">(${min} topics, min ${min}d)</span></label>
      <input type="number" min="${min}" data-budget-key="${key}" value="${val}" style="width:80px;">
    </div>`;
  }).join('');

  const optTopics = profile==='psir' ? PSIR_TOPICS : MALAYALAM_TOPICS;
  const optMin = optTopics.length;
  const optVal = state.dayBudgets.opt[profile] || optMin;

  root.innerHTML = `
    <div class="overlay" id="overlay">
      <div class="modal" style="max-width:480px;">
        <h2>Study plan — day budgets — ${profileLabel}</h2>
        <div class="note" style="margin-top:0; border-top:none; padding-top:0;">
          Set a total number of days for each subject — the app splits those days across that subject's topics on its own, giving denser topics (the ones bundling several concepts together) more days and quick revision/PYQ-practice topics fewer. Minimum is one day per topic. Revision Rounds and the Test Series stay at their fixed length since they depend on content already covered.
        </div>
        ${rows}
        <h2 style="margin-top:16px;">Optional — ${optionalLabel()}</h2>
        <div class="field">
          <label>Total days for the whole optional syllabus <span class="meta">(${optMin} topics, min ${optMin}d)</span></label>
          <input type="number" min="${optMin}" id="budget-opt" value="${optVal}" style="width:80px;">
        </div>
        <div class="close-row">
          <button class="ghost" data-action="resetBudgets">Reset to 1 day/topic</button>
          <button class="ghost" data-action="backToSettings">Back</button>
          <button class="primary" data-action="saveBudgets">Save &amp; rebuild plan</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById('overlay').addEventListener('click', (e)=>{ if(e.target.id==='overlay') closeModal(); });
  document.querySelector('[data-action="backToSettings"]').addEventListener('click', openSettings);
  document.querySelector('[data-action="resetBudgets"]').addEventListener('click', async ()=>{
    state.dayBudgets.gs[profile] = {};
    state.dayBudgets.opt[profile] = null;
    await saveDayBudgets();
    rebuildGSDays(state.subjectOrder[profile], state.dayBudgets.gs[profile]);
    openDayBudgetModal();
  });
  document.querySelector('[data-action="saveBudgets"]').addEventListener('click', async ()=>{
    const newBudgets = {};
    document.querySelectorAll('[data-budget-key]').forEach(inp=>{
      const key = inp.getAttribute('data-budget-key');
      const min = SUBJECTS[key].topics.length;
      newBudgets[key] = Math.max(min, parseInt(inp.value,10) || min);
    });
    state.dayBudgets.gs[profile] = newBudgets;
    const newOptVal = Math.max(optMin, parseInt(document.getElementById('budget-opt').value,10) || optMin);
    state.dayBudgets.opt[profile] = (newOptVal===optMin) ? null : newOptVal;
    await saveDayBudgets();
    rebuildGSDays(state.subjectOrder[profile], state.dayBudgets.gs[profile]);
    closeModal();
    render();
  });
}

function closeModal(){
  const root = document.getElementById('modalRoot');
  if(root) root.innerHTML='';
}

const WEEK_SIZE = 7;
const TOTAL_WEEKS = Math.ceil(TOTAL_DAYS / WEEK_SIZE);

function weekBounds(weekNum){
  const start = (weekNum-1)*WEEK_SIZE + 1;
  const end = Math.min(weekNum*WEEK_SIZE, TOTAL_DAYS);
  return {start, end};
}

function buildWeekRows(weekNum){
  const {start, end} = weekBounds(weekNum);
  const rows = [];
  for(let day=start; day<=end; day++){
    const g = getEffectiveGS(day);
    const opt = getEffectiveOpt(day);
    const prog = getDayProgress(day);
    const dateObj = scheduledDate(day);
    rows.push({
      day, dateObj,
      gsLabel: g.subjectLabel, gsTopic: g.topic,
      optTopic: opt.topic,
      caTopic: caTopicForDay(day),
      slots: {gs:prog.gs, opt: prog.opt, aw:prog.aw, ca:prog.ca, rev:prog.rev},
      showOptional: true
    });
  }
  return rows;
}

function weekCompletionPct(rows){
  let done=0, total=0;
  rows.forEach(r=>{
    Object.values(r.slots).forEach(v=>{ if(v!==null){ total++; if(v) done++; } });
  });
  return total? Math.round(done/total*100) : 0;
}

function openWeeklyReport(weekNum){
  weekNum = Math.max(1, Math.min(TOTAL_WEEKS, weekNum));
  const root = document.getElementById('modalRoot');
  const rows = buildWeekRows(weekNum);
  const {start,end} = weekBounds(weekNum);
  const pct = weekCompletionPct(rows);
  root.innerHTML = `
    <div class="overlay" id="overlay">
      <div class="modal">
        <h2>Weekly report</h2>
        <div class="field">
          <label>Week ${weekNum} of ${TOTAL_WEEKS} — Days ${start}–${end}</label>
          <div style="display:flex; gap:6px;">
            <button class="icon" data-action="reportPrev" ${weekNum<=1?'disabled':''}>◀</button>
            <button class="icon" data-action="reportNext" ${weekNum>=TOTAL_WEEKS?'disabled':''}>▶</button>
          </div>
        </div>
        <div class="field"><label>Completion this week</label><strong class="mono">${pct}%</strong></div>
        <div class="field"><label>Profile</label><strong>${state.profile==='psir' ? 'Amal · PSIR' : 'Arya · Malayalam'}</strong></div>
        <div class="field"><label>Total time studied (lifetime)</label><strong class="mono">${fmtHM(state.totalSeconds[state.profile]||0)}</strong></div>
        <div class="close-row">
          <button class="ghost" data-action="closeModal">Cancel</button>
          <button class="primary" data-action="downloadReport" data-week="${weekNum}">Download report (.html)</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById('overlay').addEventListener('click', (e)=>{ if(e.target.id==='overlay') closeModal(); });
  document.querySelector('[data-action="closeModal"]').addEventListener('click', closeModal);
  const prevBtn = document.querySelector('[data-action="reportPrev"]');
  if(prevBtn) prevBtn.addEventListener('click', ()=>openWeeklyReport(weekNum-1));
  const nextBtn = document.querySelector('[data-action="reportNext"]');
  if(nextBtn) nextBtn.addEventListener('click', ()=>openWeeklyReport(weekNum+1));
  document.querySelector('[data-action="downloadReport"]').addEventListener('click', ()=>{
    downloadWeeklyReport(weekNum);
  });
}

function esc(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function generateWeeklyReportHTML(weekNum){
  const rows = buildWeekRows(weekNum);
  const {start,end} = weekBounds(weekNum);
  const pct = weekCompletionPct(rows);
  const profileLabel = state.profile==='psir' ? 'Amal · PSIR' : 'Arya · Malayalam';
  const generated = new Date().toLocaleString('en-IN');
  const mark = v => v===null ? '<span style="color:#999">—</span>' : (v ? '<span style="color:#2f7a4f">&#10003; done</span>' : '<span style="color:#b23">&#10007; pending</span>');

  let rowsHtml = '';
  rows.forEach(r=>{
    rowsHtml += `
    <tr>
      <td class="mono">${r.day}${r.dateObj ? '<br><span class="muted">'+r.dateObj.toLocaleDateString('en-IN',{day:'2-digit',month:'short'})+'</span>' : ''}</td>
      <td><strong>${esc(r.gsLabel)}</strong><br>${esc(r.gsTopic)}<br><span class="muted">${mark(r.slots.gs)}</span></td>
      <td>${esc(r.optTopic)}<br><span class="muted">${mark(r.slots.opt)}</span></td>
      <td>${mark(r.slots.aw)}</td>
      <td>${esc(r.caTopic)}<br><span class="muted">${mark(r.slots.ca)}</span></td>
      <td>${mark(r.slots.rev)}</td>
    </tr>`;
  });

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>UPSC Prep — Week ${weekNum} Report</title>
<style>
  body{font-family:Georgia,'Times New Roman',serif; background:#fff; color:#1a1a1a; padding:24px; max-width:960px; margin:0 auto;}
  h1{font-size:22px; margin-bottom:2px;}
  .sub{color:#666; font-size:13px; margin-bottom:18px;}
  table{border-collapse:collapse; width:100%; font-size:12px;}
  th,td{border:1px solid #ccc; padding:8px; text-align:left; vertical-align:top;}
  th{background:#f2ede0;}
  .muted{color:#777; font-size:11px;}
  .mono{font-family:'Courier New',monospace;}
  .summary{background:#f7f4ec; border:1px solid #ddd; padding:12px 16px; border-radius:6px; margin-bottom:18px;}
  @media print{ body{padding:0;} }
</style></head>
<body>
  <h1>UPSC Prep — Weekly Report</h1>
  <div class="sub">${profileLabel} &middot; Week ${weekNum} of ${TOTAL_WEEKS} (Days ${start}&ndash;${end}) &middot; Generated ${esc(generated)}</div>
  <div class="summary"><strong>Completion this week: ${pct}%</strong> &middot; Total time studied (lifetime): ${fmtHM(state.totalSeconds[state.profile]||0)}</div>
  <table>
    <thead><tr><th>Day</th><th>GS Subject</th><th>Optional</th><th>Answer Writing</th><th>Current Affairs</th><th>Spaced Revision</th></tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
</body></html>`;
}

function downloadFile(filename, content, mime){
  try{
    const blob = new Blob([content], {type:mime});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(()=>URL.revokeObjectURL(url), 2000);
  }catch(e){
    showBanner('Download failed — try again');
  }
}

function downloadWeeklyReport(weekNum){
  const html = generateWeeklyReportHTML(weekNum);
  const profileTag = state.profile==='psir' ? 'PSIR' : 'Malayalam';
  downloadFile('UPSC-Prep-Week'+weekNum+'-'+profileTag+'.html', html, 'text/html');
  closeModal();
}

/* ============== PROGRESS CHARTS ============== */
function minutesForDay(profile, day){
  const dss = (state.dailySlotSeconds[profile]||{})[day] || {};
  const totalSec = Object.values(dss).reduce((a,b)=>a+(b||0),0);
  return totalSec/60;
}
function slotMinutesForDay(profile, day){
  const dss = (state.dailySlotSeconds[profile]||{})[day] || {};
  return { gs:(dss.gs||0)/60, opt:(dss.opt||0)/60, aw:(dss.aw||0)/60, ca:(dss.ca||0)/60, rev:(dss.rev||0)/60 };
}
function niceCeil(v){
  if(v<=0) return 5;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v/mag;
  let n;
  if(norm<=1) n=1; else if(norm<=2) n=2; else if(norm<=5) n=5; else n=10;
  return n*mag;
}
function movingAverage(values, window){
  return values.map((_,i)=>{
    const start = Math.max(0, i-window+1);
    const slice = values.slice(start, i+1);
    return slice.reduce((a,b)=>a+b,0)/slice.length;
  });
}
/* Line graph: gridlines + y-axis scale, filled area under the line, a dashed
   moving-average trend line so day-to-day noise doesn't hide the real trend,
   and a dot with a hover tooltip at every data point. */
function buildLineGraphSVG(labels, values, opts){
  opts = opts || {};
  const w = opts.width || 340, h = opts.height || 190;
  const padL = 30, padR = 10, padT = 12, padB = 22;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const n = Math.max(1, values.length);
  const niceMax = niceCeil(Math.max(...values, 0.001));
  const stepX = n>1 ? plotW/(n-1) : 0;
  const color = opts.color || '#C9A227';
  const trendColor = opts.trendColor || '#4FA893';

  const xOf = i => padL + i*stepX;
  const yOf = v => padT + plotH - Math.min(1, v/niceMax)*plotH;

  let grid = '', yLabels = '';
  const bands = 4;
  for(let i=0;i<=bands;i++){
    const v = niceMax*i/bands;
    const y = yOf(v);
    grid += '<line x1="'+padL+'" y1="'+y.toFixed(1)+'" x2="'+(w-padR)+'" y2="'+y.toFixed(1)+'" stroke="#323C66" stroke-width="1" stroke-dasharray="'+(i===0?'0':'2,3')+'"/>';
    yLabels += '<text x="'+(padL-5)+'" y="'+(y+3).toFixed(1)+'" font-size="8" fill="#9BA3C4" text-anchor="end" font-family="IBM Plex Mono, monospace">'+Math.round(v)+'</text>';
  }

  const pts = values.map((v,i)=>[xOf(i), yOf(v)]);
  let linePath = pts.map((p,i)=>(i===0?'M':'L')+p[0].toFixed(1)+','+p[1].toFixed(1)).join(' ');
  const baseline = padT+plotH;
  let areaPath = 'M'+pts[0][0].toFixed(1)+','+baseline.toFixed(1);
  pts.forEach(p=>{ areaPath += ' L'+p[0].toFixed(1)+','+p[1].toFixed(1); });
  areaPath += ' L'+pts[pts.length-1][0].toFixed(1)+','+baseline.toFixed(1)+' Z';

  let trendPath = '';
  if(n>=3){
    const avg = movingAverage(values, Math.min(7,n));
    trendPath = avg.map((v,i)=>(i===0?'M':'L')+xOf(i).toFixed(1)+','+yOf(v).toFixed(1)).join(' ');
  }

  let dots = '';
  pts.forEach((p,i)=>{
    dots += '<circle cx="'+p[0].toFixed(1)+'" cy="'+p[1].toFixed(1)+'" r="2.6" fill="'+color+'"><title>Day '+esc(String(labels[i]))+': '+values[i].toFixed(1)+' min</title></circle>';
  });

  let xLabels = '';
  const stride = Math.max(1, Math.ceil(n/6));
  labels.forEach((l,i)=>{
    if(i % stride===0 || i===n-1){
      xLabels += '<text x="'+xOf(i).toFixed(1)+'" y="'+(h-6)+'" font-size="8" fill="#9BA3C4" text-anchor="middle" font-family="IBM Plex Mono, monospace">'+esc(String(l))+'</text>';
    }
  });

  const gradId = 'grad'+Math.abs(Math.round(Math.random()*1e6));
  return '<svg viewBox="0 0 '+w+' '+h+'" style="width:100%; height:auto; display:block;">'
    + '<defs><linearGradient id="'+gradId+'" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0%" stop-color="'+color+'" stop-opacity="0.35"/>'
    + '<stop offset="100%" stop-color="'+color+'" stop-opacity="0"/></linearGradient></defs>'
    + grid + yLabels
    + '<path d="'+areaPath+'" fill="url(#'+gradId+')" stroke="none"/>'
    + '<path d="'+linePath+'" fill="none" stroke="'+color+'" stroke-width="2"/>'
    + (n>=3 ? '<path d="'+trendPath+'" fill="none" stroke="'+trendColor+'" stroke-width="1.5" stroke-dasharray="4,3"/>' : '')
    + dots + xLabels
    + '</svg>';
}
function buildBarChartSVG(labels, values, opts){
  opts = opts || {};
  const w = opts.width || 320, h = opts.height || 160;
  const padL = 28, padR = 10, padT = 12, bottomPad = 20;
  const plotW = w - padL - padR, plotH = h - padT - bottomPad;
  const niceMax = niceCeil(Math.max(...values, 0.001));
  const n = Math.max(1, values.length);
  const barSlot = plotW / n;

  let grid = '', yLabels = '';
  const bands = 3;
  for(let i=0;i<=bands;i++){
    const v = niceMax*i/bands;
    const y = padT + plotH - (v/niceMax)*plotH;
    grid += '<line x1="'+padL+'" y1="'+y.toFixed(1)+'" x2="'+(w-padR)+'" y2="'+y.toFixed(1)+'" stroke="#323C66" stroke-width="1" stroke-dasharray="'+(i===0?'0':'2,3')+'"/>';
    yLabels += '<text x="'+(padL-5)+'" y="'+(y+3).toFixed(1)+'" font-size="8" fill="#9BA3C4" text-anchor="end" font-family="IBM Plex Mono, monospace">'+Math.round(v)+'</text>';
  }
  let bars = '', valueLabels = '';
  values.forEach((v,i)=>{
    const barH = (v/niceMax) * plotH;
    const x = padL + i*barSlot + barSlot*0.18;
    const y = padT + plotH - barH;
    bars += '<rect x="'+x.toFixed(1)+'" y="'+y.toFixed(1)+'" width="'+(barSlot*0.64).toFixed(1)+'" height="'+Math.max(0,barH).toFixed(1)+'" rx="2" fill="'+(opts.color||'#C9A227')+'"><title>'+esc(String(labels[i]))+': '+v.toFixed(1)+' min</title></rect>';
    if(v>0){
      valueLabels += '<text x="'+(x+barSlot*0.32).toFixed(1)+'" y="'+(y-3).toFixed(1)+'" font-size="7.5" fill="#9BA3C4" text-anchor="middle" font-family="IBM Plex Mono, monospace">'+v.toFixed(0)+'</text>';
    }
  });
  let xLabels = '';
  labels.forEach((l,i)=>{
    const x = padL + i*barSlot + barSlot/2;
    xLabels += '<text x="'+x.toFixed(1)+'" y="'+(h-6)+'" font-size="8" fill="#9BA3C4" text-anchor="middle" font-family="IBM Plex Mono, monospace">'+esc(String(l))+'</text>';
  });
  return '<svg viewBox="0 0 '+w+' '+h+'" style="width:100%; height:auto; display:block;">'+grid+yLabels+bars+valueLabels+xLabels+'</svg>';
}
function openProgressView(fromDay, toDay, singleDay){
  const d = state.day;
  fromDay = Math.max(1, Math.min(fromDay || Math.max(1, d-13), TOTAL_DAYS));
  toDay = Math.max(fromDay, Math.min(toDay || d, TOTAL_DAYS));
  singleDay = Math.max(1, Math.min(singleDay || toDay, TOTAL_DAYS));

  const rangeLabels = [], rangeValues = [];
  for(let day=fromDay; day<=toDay; day++){ rangeLabels.push(day); rangeValues.push(minutesForDay(state.profile, day)); }
  const rangeTotal = rangeValues.reduce((a,b)=>a+b,0);
  const daysWithStudy = rangeValues.filter(v=>v>0).length;
  const rangeChart = buildLineGraphSVG(rangeLabels, rangeValues, {color:'#C9A227', trendColor:'#4FA893', height:170});

  const sd = slotMinutesForDay(state.profile, singleDay);
  const slotLabels = ['GS','Opt','AW','CA','Rev'];
  const slotValues = [sd.gs, sd.opt, sd.aw, sd.ca, sd.rev];
  const dayChart = buildBarChartSVG(slotLabels, slotValues, {color:'#4FA893', height:130});
  const dayDate = scheduledDate(singleDay);

  const root = document.getElementById('modalRoot');
  root.innerHTML = `
    <div class="overlay" id="overlay">
      <div class="modal" style="max-width:520px;">
        <h2>Progress — ${state.profile==='psir'?'Amal · PSIR':'Arya · Malayalam'}</h2>

        <div class="field"><label>From day</label><input type="number" id="pv-from" min="1" max="${TOTAL_DAYS}" value="${fromDay}" style="width:80px;"></div>
        <div class="field"><label>To day</label><input type="number" id="pv-to" min="1" max="${TOTAL_DAYS}" value="${toDay}" style="width:80px;"></div>
        <button style="width:100%; margin-bottom:10px;" data-action="pvUpdateRange">Update range</button>
        <div style="background:var(--surface2); border-radius:8px; padding:8px;">${rangeChart}</div>
        <div class="meta" style="margin-top:6px;">Solid line: minutes/day &middot; dashed line: 7-day trend &middot; Total: ${fmtHM(Math.round(rangeTotal*60))} across ${daysWithStudy}/${toDay-fromDay+1} day(s) with study logged</div>

        <h2 style="margin-top:20px;">Single day breakdown</h2>
        <div class="field"><label>Day</label><input type="number" id="pv-single" min="1" max="${TOTAL_DAYS}" value="${singleDay}" style="width:80px;"></div>
        <button style="width:100%; margin-bottom:10px;" data-action="pvUpdateSingle">Update day</button>
        <div style="background:var(--surface2); border-radius:8px; padding:8px;">${dayChart}</div>
        <div class="meta" style="margin-top:6px;">Day ${singleDay}${dayDate?' — '+fmtDate(dayDate):''} — GS/Opt/AW/CA/Rev, minutes</div>

        <div class="close-row">
          <button class="primary" data-action="closeModal">Close</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById('overlay').addEventListener('click', (e)=>{ if(e.target.id==='overlay') closeModal(); });
  document.querySelector('[data-action="closeModal"]').addEventListener('click', closeModal);
  document.querySelector('[data-action="pvUpdateRange"]').addEventListener('click', ()=>{
    const f = parseInt(document.getElementById('pv-from').value,10)||fromDay;
    const t = parseInt(document.getElementById('pv-to').value,10)||toDay;
    openProgressView(f, t, singleDay);
  });
  document.querySelector('[data-action="pvUpdateSingle"]').addEventListener('click', ()=>{
    const s = parseInt(document.getElementById('pv-single').value,10)||singleDay;
    openProgressView(fromDay, toDay, s);
  });
}

/* ============== INIT ============== */
if('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

(async function init(){
  document.getElementById('app').innerHTML = '<div style="padding:40px; text-align:center; color:var(--muted);">Loading your ledger…</div>';
  await loadState();
  await loadPersistedTimers();
  render();
})();
