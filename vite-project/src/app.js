import './style.css';
import {
  SUBJECTS, CORE_ORDER_DEFAULT, PSIR_TOPICS, MALAYALAM_TOPICS,
  GS_DAYS, rebuildGSDays, TOTAL_DAYS, OPTIONAL_DAYS, caTopicForDay
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
  topicChoices: {}, /* profile -> { day: {gsKey, gsIdx, optIdx} } — manual daily topic picks, override the auto schedule */
  studyTotals: {}, /* profile -> cumulative seconds studied (all-time), from the total-study stopwatch */
  sync: {
    url: import.meta.env.VITE_SUPABASE_URL || "",
    key: import.meta.env.VITE_SUPABASE_ANON_KEY || "",
    code: import.meta.env.VITE_SYNC_CODE || ""
  }, /* Supabase config — defaults come from build-time env vars, can still be overridden in Settings */
  notifPermAsked:false
};
let timers = {}; /* slot -> {remaining, running, intervalId, duration} */
let stopwatch = { running:false, intervalId:null }; /* total-study count-up stopwatch, independent of per-slot countdowns */
let stopwatchPersistCounter = 0;
let storageReady = false;
let syncStatus = "off"; /* off | synced | syncing | error */

function optionalTopics(){ return state.profile==="psir" ? PSIR_TOPICS : MALAYALAM_TOPICS; }
function optionalLabel(){ return state.profile==="psir" ? "PSIR — Political Science & IR" : "Malayalam Literature"; }
function profileName(profile){ return (profile||state.profile)==="psir" ? "Amal" : "Arya"; }

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
async function loadSubjectOrderForProfile(profile){
  try{
    const so = await window.storage.get('subjectOrder:'+profile);
    if(so && so.value){
      const parsed = JSON.parse(so.value);
      if(Array.isArray(parsed) && parsed.length===CORE_ORDER_DEFAULT.length){
        state.subjectOrder[profile] = parsed;
      }
    }
  }catch(e){}
  if(supaConfigured()){
    const remoteOrder = await supaFetch(profile,'subjectOrder');
    if(remoteOrder && Array.isArray(remoteOrder) && remoteOrder.length===CORE_ORDER_DEFAULT.length){
      state.subjectOrder[profile] = remoteOrder;
    }
  }
}
async function pullAllFromSupabase(){
  if(!supaConfigured()) return;
  const remoteSettings = await supaFetch('shared','settings');
  if(remoteSettings) state.settings = Object.assign(state.settings, remoteSettings);
  await loadSubjectOrderForProfile(state.profile);
  rebuildGSDays(state.subjectOrder[state.profile]);
  const remoteDay = await supaFetch('shared','currentDay');
  if(remoteDay) state.day = remoteDay;
  const remoteProgress = await supaFetch(state.profile,'progress');
  if(remoteProgress) state.progress[state.profile] = remoteProgress;
  const remoteTopics = await supaFetch(state.profile,'topicChoices');
  if(remoteTopics) state.topicChoices[state.profile] = remoteTopics;
  const remoteTotal = await supaFetch(state.profile,'studyTotal');
  if(typeof remoteTotal === 'number') state.studyTotals[state.profile] = remoteTotal;
}
async function pushAllToSupabase(){
  if(!supaConfigured()) return;
  await supaUpsert('shared','settings', state.settings);
  await supaUpsert(state.profile,'subjectOrder', state.subjectOrder[state.profile]);
  await supaUpsert('shared','currentDay', state.day);
  await supaUpsert(state.profile,'progress', state.progress[state.profile]||{});
  await supaUpsert(state.profile,'topicChoices', state.topicChoices[state.profile]||{});
  await supaUpsert(state.profile,'studyTotal', state.studyTotals[state.profile]||0);
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
  await loadSubjectOrderForProfile(state.profile);
  rebuildGSDays(state.subjectOrder[state.profile]);
  try{
    const d = await window.storage.get('currentDay');
    if(d && d.value) state.day = parseInt(d.value,10) || 1;
  }catch(e){}
  await loadProgress();
  await loadTopicChoices(state.profile);
  await loadStudyTotal(state.profile);
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
async function loadTopicChoices(profile){
  try{
    const r = await window.storage.get('topicChoices:'+profile);
    state.topicChoices[profile] = (r && r.value) ? JSON.parse(r.value) : (state.topicChoices[profile]||{});
  }catch(e){
    state.topicChoices[profile] = state.topicChoices[profile] || {};
  }
  if(supaConfigured()){
    const remote = await supaFetch(profile,'topicChoices');
    if(remote && typeof remote==='object') state.topicChoices[profile] = remote;
  }
}
async function loadStudyTotal(profile){
  try{
    const r = await window.storage.get('studyTotal:'+profile);
    state.studyTotals[profile] = (r && r.value) ? (parseInt(r.value,10)||0) : (state.studyTotals[profile]||0);
  }catch(e){
    state.studyTotals[profile] = state.studyTotals[profile] || 0;
  }
  if(supaConfigured()){
    const remote = await supaFetch(profile,'studyTotal');
    if(typeof remote === 'number') state.studyTotals[profile] = remote;
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
async function saveTopicChoices(){
  try{ await window.storage.set('topicChoices:'+state.profile, JSON.stringify(state.topicChoices[state.profile]||{})); }catch(e){}
  supaUpsert(state.profile, 'topicChoices', state.topicChoices[state.profile]||{});
}
async function saveStudyTotal(){
  try{ await window.storage.set('studyTotal:'+state.profile, String(state.studyTotals[state.profile]||0)); }catch(e){}
  supaUpsert(state.profile, 'studyTotal', state.studyTotals[state.profile]||0);
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

/* ============== DAILY TOPIC CHOICES (manual per-day picks, override the auto schedule) ============== */
function getTopicChoice(day){
  const tc = state.topicChoices[state.profile] || {};
  return tc[day] || {};
}
function setTopicChoice(day, patch){
  const tc = state.topicChoices[state.profile] || {};
  const cur = tc[day] || {};
  tc[day] = Object.assign({}, cur, patch);
  state.topicChoices[state.profile] = tc;
  saveTopicChoices();
}
function getGSChoice(day){
  const auto = GS_DAYS[day-1];
  const c = getTopicChoice(day);
  if(c.gsKey && SUBJECTS[c.gsKey] && Number.isInteger(c.gsIdx) && SUBJECTS[c.gsKey].topics[c.gsIdx]!==undefined){
    return { label: SUBJECTS[c.gsKey].label, topic: SUBJECTS[c.gsKey].topics[c.gsIdx], custom:true, key:c.gsKey, idx:c.gsIdx };
  }
  return { label: auto.subjectLabel, topic: auto.topic, custom:false, key: auto.subjectKey, idx: auto.posInSubject-1 };
}
function getOptChoice(day){
  const topics = optionalTopics();
  const c = getTopicChoice(day);
  if(Number.isInteger(c.optIdx) && topics[c.optIdx]!==undefined){
    return { topic: topics[c.optIdx], custom:true, idx:c.optIdx };
  }
  const fallbackIdx = day-1;
  if(topics[fallbackIdx]!==undefined) return { topic: topics[fallbackIdx], custom:false, idx: fallbackIdx };
  return { topic: "No planned topic for today — pick one.", custom:false, idx:null };
}

/* ============== REVISION LOGIC ============== */
function getRevisionItems(day){
  const offsets = [1,3,7,28,90];
  const items = [];
  offsets.forEach(o=>{
    const src = day - o;
    if(src>=1 && src<=TOTAL_DAYS){
      const gsC = getGSChoice(src);
      items.push({when:o+"d", label:gsC.label, topic:gsC.topic});
      if(src<=OPTIONAL_DAYS){
        const optC = getOptChoice(src);
        items.push({when:o+"d", label:optionalLabel(), topic:optC.topic});
      }
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
function initTimer(slot){
  if(!timers[slot] || timers[slot].justSetDuration){
    timers[slot] = { remaining: slotMinutes(slot)*60, running:false, intervalId:null };
  }
}
function startTimer(slot){
  initTimer(slot);
  if(timers[slot].running) return;
  timers[slot].running = true;
  timers[slot].intervalId = setInterval(()=>{
    timers[slot].remaining -= 1;
    updateTimerDisplay(slot);
    if(timers[slot].remaining<=0){
      clearInterval(timers[slot].intervalId);
      timers[slot].running=false;
      timers[slot].remaining=0;
      updateTimerDisplay(slot);
      onSlotTimeUp(slot);
    }
  },1000);
  updateButtons(slot);
}
function pauseTimer(slot){
  if(timers[slot] && timers[slot].intervalId) clearInterval(timers[slot].intervalId);
  if(timers[slot]) timers[slot].running=false;
  updateButtons(slot);
}
function resetTimer(slot){
  if(timers[slot] && timers[slot].intervalId) clearInterval(timers[slot].intervalId);
  timers[slot] = { remaining: slotMinutes(slot)*60, running:false, intervalId:null };
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
function clearAllTimers(){
  Object.keys(timers).forEach(slot=>{
    if(timers[slot] && timers[slot].intervalId) clearInterval(timers[slot].intervalId);
  });
  timers = {};
}

/* ============== TOTAL STUDY STOPWATCH ==============
   A single count-up stopwatch per profile, separate from the five per-slot
   countdown timers above. It tracks cumulative time studied (all-time) and
   keeps running across day-navigation/render — it is intentionally NOT
   touched by clearAllTimers(). */
function fmtTotal(sec){
  sec = Math.max(0, sec|0);
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60);
  return h>0 ? (h+"h "+String(m).padStart(2,'0')+"m") : (m+"m "+String(sec%60).padStart(2,'0')+"s");
}
function updateStopwatchDisplay(){
  const el = document.getElementById('stopwatchDisplay');
  if(el) el.textContent = fmtTotal(state.studyTotals[state.profile]||0);
}
function updateStopwatchButton(){
  const btn = document.querySelector('[data-action="stopwatchToggle"]');
  if(btn) btn.textContent = stopwatch.running ? '❚❚' : '▶';
}
function stopwatchTick(){
  state.studyTotals[state.profile] = (state.studyTotals[state.profile]||0) + 1;
  updateStopwatchDisplay();
  stopwatchPersistCounter++;
  if(stopwatchPersistCounter>=15){ stopwatchPersistCounter=0; saveStudyTotal(); }
}
function startStopwatch(){
  if(stopwatch.running) return;
  stopwatch.running = true;
  stopwatch.intervalId = setInterval(stopwatchTick, 1000);
  updateStopwatchButton();
}
function pauseStopwatch(){
  if(stopwatch.intervalId) clearInterval(stopwatch.intervalId);
  stopwatch.intervalId = null;
  stopwatch.running = false;
  saveStudyTotal();
  updateStopwatchButton();
}
function toggleStopwatch(){
  if(stopwatch.running) pauseStopwatch(); else startStopwatch();
}
function resetStopwatch(){
  pauseStopwatch();
  state.studyTotals[state.profile] = 0;
  saveStudyTotal();
  updateStopwatchDisplay();
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

function render(){
  clearAllTimers();
  const day = state.day;
  const g = GS_DAYS[day-1];
  const showOptional = day<=OPTIONAL_DAYS;
  const prog = getDayProgress(day);
  const revItems = getRevisionItems(day);
  const dateObj = scheduledDate(day);
  const gsChoice = getGSChoice(day);
  const optChoice = getOptChoice(day);

  const doneCount = [prog.gs, prog.opt || !showOptional, prog.aw, prog.rev, prog.ca].filter(Boolean).length;
  const totalSlots = showOptional ? 5 : 4;
  const overallPct = Math.round((day-1+ (doneCount/totalSlots)) / TOTAL_DAYS * 100);

  let spineHtml = '';
  for(let i=1;i<=TOTAL_DAYS;i++){
    const gg = GS_DAYS[i-1];
    const dp = getDayProgress(i);
    const isDone = dp.gs && dp.aw && dp.rev && dp.ca && (i>OPTIONAL_DAYS || dp.opt);
    const ggChoice = getGSChoice(i);
    spineHtml += '<div class="tick'+(isDone?' done':'')+(i===day?' current':'')+'" style="background:'+gg.color+'" data-day="'+i+'" title="Day '+i+' — '+ggChoice.label+'"></div>';
  }

  let revHtml = '';
  if(revItems.length===0){
    revHtml = '<div class="topic" style="color:var(--muted)">No spaced-revision topics yet — they will appear from Day 2 onward.</div>';
  } else {
    revItems.forEach(it=>{
      revHtml += '<div class="rev-item"><span class="when mono">'+it.when+'</span><strong>'+it.label+':</strong> '+it.topic+'</div>';
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
        <button class="icon ghost" data-action="report" aria-label="Weekly report">⬇</button>
        <button class="icon ghost" data-action="settings" aria-label="Settings">⚙</button>
      </div>
    </header>

    <div class="daynav">
      <button class="icon" data-action="prevday" ${day<=1?'disabled':''}>◀</button>
      <div class="center">
        <div class="daynum mono">Day ${day} <span style="color:var(--muted); font-size:16px;">/ ${TOTAL_DAYS}</span></div>
        <div class="phase">${gsChoice.label} · ${g.posInSubject}/${g.subjectTotal}${showOptional ? ' · + Optional running alongside' : ''}</div>
        ${dateObj ? '<div class="datestr">'+fmtDate(dateObj)+'</div>' : ''}
      </div>
      <button class="icon" data-action="nextday" ${day>=TOTAL_DAYS?'disabled':''}>▶</button>
    </div>

    <div class="studytimer">
      <div>
        <span class="label">Total time studied · ${profileName()}</span><br>
        <span class="stopwatch mono" id="stopwatchDisplay">${fmtTotal(state.studyTotals[state.profile]||0)}</span>
      </div>
      <div class="controls">
        <button class="icon" data-action="stopwatchToggle">${stopwatch.running?'❚❚':'▶'}</button>
        <button class="icon ghost" data-action="stopwatchReset">↺</button>
      </div>
    </div>

    <div class="progressbar"><div style="width:${overallPct}%"></div></div>

    <div class="spine-wrap"><div class="spine">${spineHtml}</div></div>

    <div class="grid">
      <div class="card" id="card-gs">
        <span class="label">Subject 1 of 2${gsChoice.custom?' · your pick':' · planned'}</span>
        <h3>${gsChoice.label}</h3>
        <div class="topic">${gsChoice.topic}</div>
        <button class="ghost topic-pick-btn" data-action="pickTopic" data-slot="gs">✎ ${gsChoice.custom?'Change':'Choose'} today's topic</button>
        <div class="row">
          <label class="check"><input type="checkbox" data-action="check" data-slot="gs" ${prog.gs?'checked':''}/> Done</label>
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="timer mono" id="timer-gs">${fmt(slotMinutes('gs')*60)}</span>
            <button class="icon" id="start-gs" data-action="start" data-slot="gs">▶</button>
            <button class="icon" id="pause-gs" data-action="pause" data-slot="gs" disabled>❚❚</button>
            <button class="icon ghost" data-action="reset" data-slot="gs">↺</button>
          </div>
        </div>
      </div>

      ${showOptional ? `
      <div class="card" id="card-opt">
        <span class="label">Subject 2 of 2 — Optional${optChoice.custom?' · your pick':' · planned'}</span>
        <h3>${optionalLabel()}</h3>
        <div class="topic">${optChoice.topic}</div>
        <button class="ghost topic-pick-btn" data-action="pickTopic" data-slot="opt">✎ ${optChoice.custom?'Change':'Choose'} today's topic</button>
        <div class="meta">Optional day ${day} of ${OPTIONAL_DAYS} — runs alongside your GS subject for the first ${OPTIONAL_DAYS} days.</div>
        <div class="row">
          <label class="check"><input type="checkbox" data-action="check" data-slot="opt" ${prog.opt?'checked':''}/> Done</label>
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="timer mono" id="timer-opt">${fmt(slotMinutes('opt')*60)}</span>
            <button class="icon" id="start-opt" data-action="start" data-slot="opt">▶</button>
            <button class="icon" id="pause-opt" data-action="pause" data-slot="opt" disabled>❚❚</button>
            <button class="icon ghost" data-action="reset" data-slot="opt">↺</button>
          </div>
        </div>
      </div>` : `
      <div class="card">
        <span class="label">Optional — complete</span>
        <h3>${optionalLabel()}</h3>
        <div class="topic" style="color:var(--muted)">Optional syllabus finished on Day ${OPTIONAL_DAYS}. It returns as revision on days 221–300.</div>
      </div>`}

      <div class="card" id="card-aw">
        <span class="label">Answer Writing</span>
        <h3>Daily Practice</h3>
        <div class="topic">Write ${showOptional ? '2 GS-style answers on today\\u2019s ' + gsChoice.label + ' topic, plus 1 optional-style answer' : '2–3 mains-style answers based on today\\u2019s ' + gsChoice.label + ' topic'}.</div>
        <div class="row">
          <label class="check"><input type="checkbox" data-action="check" data-slot="aw" ${prog.aw?'checked':''}/> Done</label>
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="timer mono" id="timer-aw">${fmt(slotMinutes('aw')*60)}</span>
            <button class="icon" id="start-aw" data-action="start" data-slot="aw">▶</button>
            <button class="icon" id="pause-aw" data-action="pause" data-slot="aw" disabled>❚❚</button>
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
            <span class="timer mono" id="timer-ca">${fmt(slotMinutes('ca')*60)}</span>
            <button class="icon" id="start-ca" data-action="start" data-slot="ca">▶</button>
            <button class="icon" id="pause-ca" data-action="pause" data-slot="ca" disabled>❚❚</button>
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
            <span class="timer mono" id="timer-rev">${fmt(slotMinutes('rev')*60)}</span>
            <button class="icon" id="start-rev" data-action="start" data-slot="rev">▶</button>
            <button class="icon" id="pause-rev" data-action="pause" data-slot="rev" disabled>❚❚</button>
            <button class="icon ghost" data-action="reset" data-slot="rev">↺</button>
          </div>
        </div>
      </div>
    </div>

    <div class="note">
      Every day now has 5 slots: GS subject, Optional (days 1–${OPTIONAL_DAYS} only), Answer Writing, a 1-hour daily Current Affairs habit (newspaper/CA source, theme rotates through the week), and Spaced Revision. Days 1–${OPTIONAL_DAYS}: your GS subject runs alongside your optional. Days ${OPTIONAL_DAYS+1}–220: remaining GS syllabus (Ancient/Medieval History, Culture, Science &amp; Tech, Environment, Ethics, Essay, CSAT, plus a dedicated Current-Affairs-Consolidation block that revises everything logged in the daily habit slot) with two revision rounds and a test-series block. Days 221–300: a 4-cycle integrated revision + full mock-test phase covering GS and optional together.
      Malayalam optional text/author list follows the standard syllabus structure — please cross-check specific prescribed works against your current UPSC syllabus notification.
      GS/Optional topics above are a planned default — use "Choose today's topic" on either card to pick any subject/topic from the syllabus for that day instead; it's saved per person and only changes that one day, spaced revision picks it up automatically. The Total Time Studied stopwatch is a separate running tally, independent of the five slot timers.
    </div>

    <div id="modalRoot"></div>
  `;
  document.getElementById('app').innerHTML = html;
  attachHandlers();
}

function attachHandlers(){
  document.querySelectorAll('[data-action="profile"]').forEach(b=>{
    b.addEventListener('click', async ()=>{
      pauseStopwatch();
      state.profile = b.getAttribute('data-value');
      await saveProfile();
      await loadProgress();
      await loadSubjectOrderForProfile(state.profile);
      rebuildGSDays(state.subjectOrder[state.profile]);
      await loadTopicChoices(state.profile);
      await loadStudyTotal(state.profile);
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
  document.querySelectorAll('[data-action="pickTopic"]').forEach(b=>{
    b.addEventListener('click', ()=>{ openTopicPicker(b.getAttribute('data-slot')); });
  });
  const swToggle = document.querySelector('[data-action="stopwatchToggle"]');
  if(swToggle) swToggle.addEventListener('click', toggleStopwatch);
  const swReset = document.querySelector('[data-action="stopwatchReset"]');
  if(swReset) swReset.addEventListener('click', resetStopwatch);
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
}

/* ============== DAILY TOPIC PICKER MODAL ============== */
const SYLLABUS_SUBJECT_KEYS = Object.keys(SUBJECTS); /* every subject in the syllabus, GS + revision/test phases */

function openTopicPicker(slot){
  const day = state.day;
  const root = document.getElementById('modalRoot');
  const whoLabel = profileName();

  if(slot==='gs'){
    const current = getGSChoice(day);
    const subjectOptions = SYLLABUS_SUBJECT_KEYS.map(key=>
      `<option value="${key}" ${key===current.key?'selected':''}>${esc(SUBJECTS[key].label)}</option>`).join('');
    const topicOptions = SUBJECTS[current.key].topics.map((t,i)=>
      `<option value="${i}" ${i===current.idx?'selected':''}>${i+1}. ${esc(t)}</option>`).join('');
    root.innerHTML = `
      <div class="overlay" id="overlay">
        <div class="modal">
          <h2>Day ${day} — choose Subject 1 topic</h2>
          <div class="field stack">
            <label>Subject (full syllabus)</label>
            <select id="tp-subject" class="tp-select">${subjectOptions}</select>
          </div>
          <div class="field stack">
            <label>Topic</label>
            <select id="tp-topic" class="tp-select">${topicOptions}</select>
          </div>
          <div class="note" style="margin-top:0; border-top:none; padding-top:0;">This only changes what Day ${day} shows for ${whoLabel} — the rest of the schedule stays put, and spaced revision will reference whatever you pick here.</div>
          <div class="close-row">
            <button class="ghost" data-action="tpUsePlanned">Use planned topic</button>
            <button class="ghost" data-action="closeModal">Cancel</button>
            <button class="primary" data-action="tpSave">Save</button>
          </div>
        </div>
      </div>
    `;
    document.getElementById('overlay').addEventListener('click',(e)=>{ if(e.target.id==='overlay') closeModal(); });
    document.querySelector('[data-action="closeModal"]').addEventListener('click', closeModal);
    document.getElementById('tp-subject').addEventListener('change', (e)=>{
      const key = e.target.value;
      const topicSel = document.getElementById('tp-topic');
      topicSel.innerHTML = SUBJECTS[key].topics.map((t,i)=>`<option value="${i}">${i+1}. ${esc(t)}</option>`).join('');
    });
    document.querySelector('[data-action="tpUsePlanned"]').addEventListener('click', ()=>{
      setTopicChoice(day, {gsKey:null, gsIdx:null});
      closeModal(); render();
    });
    document.querySelector('[data-action="tpSave"]').addEventListener('click', ()=>{
      const key = document.getElementById('tp-subject').value;
      const idx = parseInt(document.getElementById('tp-topic').value,10);
      setTopicChoice(day, {gsKey:key, gsIdx:idx});
      closeModal(); render();
    });
  } else {
    const current = getOptChoice(day);
    const topics = optionalTopics();
    const topicOptions = topics.map((t,i)=>
      `<option value="${i}" ${i===current.idx?'selected':''}>${i+1}. ${esc(t)}</option>`).join('');
    root.innerHTML = `
      <div class="overlay" id="overlay">
        <div class="modal">
          <h2>Day ${day} — choose ${esc(optionalLabel())} topic</h2>
          <div class="field stack">
            <label>Topic</label>
            <select id="tp-topic-opt" class="tp-select">${topicOptions}</select>
          </div>
          <div class="note" style="margin-top:0; border-top:none; padding-top:0;">This only changes what Day ${day} shows for ${whoLabel} — the rest of the schedule stays put, and spaced revision will reference whatever you pick here.</div>
          <div class="close-row">
            <button class="ghost" data-action="tpUsePlannedOpt">Use planned topic</button>
            <button class="ghost" data-action="closeModal">Cancel</button>
            <button class="primary" data-action="tpSaveOpt">Save</button>
          </div>
        </div>
      </div>
    `;
    document.getElementById('overlay').addEventListener('click',(e)=>{ if(e.target.id==='overlay') closeModal(); });
    document.querySelector('[data-action="closeModal"]').addEventListener('click', closeModal);
    document.querySelector('[data-action="tpUsePlannedOpt"]').addEventListener('click', ()=>{
      setTopicChoice(day, {optIdx:null});
      closeModal(); render();
    });
    document.querySelector('[data-action="tpSaveOpt"]').addEventListener('click', ()=>{
      const idx = parseInt(document.getElementById('tp-topic-opt').value,10);
      setTopicChoice(day, {optIdx:idx});
      closeModal(); render();
    });
  }
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

        <h2 style="margin-top:20px;">Cloud sync (Supabase)</h2>
        <div class="field"><label>Project URL</label><input type="text" id="set-supa-url" placeholder="https://xxxx.supabase.co" value="${state.sync.url}" style="width:170px;"></div>
        <div class="field"><label>Anon/public API key</label><input type="text" id="set-supa-key" placeholder="eyJ..." value="${state.sync.key}" style="width:170px;"></div>
        <div class="field"><label>Sync code (shared by both of you)</label><input type="text" id="set-supa-code" placeholder="e.g. rowan-ledger-92" value="${state.sync.code}" style="width:170px;"></div>
        <div class="field"><label>Status</label><span id="syncStatusText" class="mono" style="font-size:11px;">${syncStatusLabel()}</span></div>
        <button style="width:100%;" data-action="syncNow">Sync now</button>
        <div class="note" style="margin-top:10px; padding-top:10px;">Leave these blank to keep everything device-local. To enable sync, create a Supabase project, run the SQL for the <span class="mono">upsc_sync</span> table (see comment at top of this app's code), then paste your Project URL, anon key, and a private sync code here — enter the same sync code on both your devices.</div>

        <button class="ghost" style="width:100%; margin-top:16px;" data-action="signOut">Sign out</button>

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
  document.querySelector('[data-action="signOut"]').addEventListener('click', ()=>{
    try{ localStorage.removeItem(AUTH_STORAGE_KEY); }catch(e){}
    closeModal();
    pauseStopwatch();
    renderLogin();
  });
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
    rebuildGSDays(state.subjectOrder[state.profile]);
    await saveSubjectOrder();
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
    const showOptional = day<=OPTIONAL_DAYS;
    const prog = getDayProgress(day);
    const dateObj = scheduledDate(day);
    const gsC = getGSChoice(day);
    const optC = showOptional ? getOptChoice(day) : null;
    rows.push({
      day, dateObj,
      gsLabel: gsC.label, gsTopic: gsC.topic,
      optTopic: optC ? optC.topic : null,
      caTopic: caTopicForDay(day),
      slots: {gs:prog.gs, opt: showOptional? prog.opt : null, aw:prog.aw, ca:prog.ca, rev:prog.rev},
      showOptional
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
      <td>${r.optTopic ? esc(r.optTopic)+'<br><span class="muted">'+mark(r.slots.opt)+'</span>' : '<span class="muted">— (optional complete)</span>'}</td>
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
  <div class="summary"><strong>Completion this week: ${pct}%</strong></div>
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

/* ============== LOGIN GATE ==============
   A simple shared username/password screen. Note: this is a soft gate to
   keep casual visitors out, not real security — anyone who inspects the
   deployed JS bundle can read the credentials below, since this is a
   static client-side app with no server. Don't reuse this password
   anywhere sensitive. */
const APP_USERNAME = "toLBSNAA";
const APP_PASSWORD = "CSE@2028";
const AUTH_STORAGE_KEY = "upscAuthed";

function isAuthed(){
  try{ return localStorage.getItem(AUTH_STORAGE_KEY) === '1'; }catch(e){ return false; }
}
function setAuthed(){
  try{ localStorage.setItem(AUTH_STORAGE_KEY, '1'); }catch(e){}
}
function renderLogin(errorMsg){
  document.getElementById('app').innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <span class="eyebrow">The Campaign Ledger</span>
        <h1>300-Day UPSC Prep</h1>
        <p class="login-sub">Sign in to continue</p>
        ${errorMsg ? '<div class="login-error">'+errorMsg+'</div>' : ''}
        <div class="field stack">
          <label>Username</label>
          <input type="text" id="login-user" autocomplete="username">
        </div>
        <div class="field stack">
          <label>Password</label>
          <input type="password" id="login-pass" autocomplete="current-password">
        </div>
        <button class="primary" style="width:100%; margin-top:6px;" data-action="loginSubmit">Sign in</button>
      </div>
    </div>
  `;
  const submit = ()=>{
    const u = document.getElementById('login-user').value.trim();
    const p = document.getElementById('login-pass').value;
    if(u===APP_USERNAME && p===APP_PASSWORD){
      setAuthed();
      boot();
    } else {
      renderLogin('Incorrect username or password.');
    }
  };
  document.querySelector('[data-action="loginSubmit"]').addEventListener('click', submit);
  document.getElementById('login-pass').addEventListener('keydown', (e)=>{ if(e.key==='Enter') submit(); });
  document.getElementById('login-user').addEventListener('keydown', (e)=>{ if(e.key==='Enter') submit(); });
  document.getElementById('login-user').focus();
}

async function boot(){
  document.getElementById('app').innerHTML = '<div style="padding:40px; text-align:center; color:var(--muted);">Loading your ledger…</div>';
  await loadState();
  render();
}

/* ============== INIT ============== */
(function init(){
  if(isAuthed()){ boot(); } else { renderLogin(); }
})();
