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

function optionalTopics(){ return state.profile==="psir" ? PSIR_TOPICS : MALAYALAM_TOPICS; }
function optionalLabel(){ return state.profile==="psir" ? "PSIR — Political Science & IR" : "Malayalam Literature"; }

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
}
async function pushAllToSupabase(){
  if(!supaConfigured()) return;
  await supaUpsert('shared','settings', state.settings);
  await supaUpsert(state.profile,'subjectOrder', state.subjectOrder[state.profile]);
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
  await loadSubjectOrderForProfile(state.profile);
  rebuildGSDays(state.subjectOrder[state.profile]);
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
      const g = GS_DAYS[src-1];
      items.push({when:o+"d", label:g.subjectLabel, topic:g.topic});
      if(src<=OPTIONAL_DAYS){
        items.push({when:o+"d", label:optionalLabel(), topic:optionalTopics()[src-1]});
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

  const doneCount = [prog.gs, prog.opt || !showOptional, prog.aw, prog.rev, prog.ca].filter(Boolean).length;
  const totalSlots = showOptional ? 5 : 4;
  const overallPct = Math.round((day-1+ (doneCount/totalSlots)) / TOTAL_DAYS * 100);

  let spineHtml = '';
  for(let i=1;i<=TOTAL_DAYS;i++){
    const gg = GS_DAYS[i-1];
    const dp = getDayProgress(i);
    const isDone = dp.gs && dp.aw && dp.rev && dp.ca && (i>OPTIONAL_DAYS || dp.opt);
    spineHtml += '<div class="tick'+(isDone?' done':'')+(i===day?' current':'')+'" style="background:'+gg.color+'" data-day="'+i+'" title="Day '+i+' — '+gg.subjectLabel+'"></div>';
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
          <button data-action="profile" data-value="psir" class="${state.profile==='psir'?'active':''}">You · PSIR</button>
          <button data-action="profile" data-value="malayalam" class="${state.profile==='malayalam'?'active':''}">Partner · Malayalam</button>
        </div>
        <button class="icon ghost" data-action="report" aria-label="Weekly report">⬇</button>
        <button class="icon ghost" data-action="settings" aria-label="Settings">⚙</button>
      </div>
    </header>

    <div class="daynav">
      <button class="icon" data-action="prevday" ${day<=1?'disabled':''}>◀</button>
      <div class="center">
        <div class="daynum mono">Day ${day} <span style="color:var(--muted); font-size:16px;">/ ${TOTAL_DAYS}</span></div>
        <div class="phase">${g.subjectLabel} · ${g.posInSubject}/${g.subjectTotal}${showOptional ? ' · + Optional running alongside' : ''}</div>
        ${dateObj ? '<div class="datestr">'+fmtDate(dateObj)+'</div>' : ''}
      </div>
      <button class="icon" data-action="nextday" ${day>=TOTAL_DAYS?'disabled':''}>▶</button>
    </div>

    <div class="progressbar"><div style="width:${overallPct}%"></div></div>

    <div class="spine-wrap"><div class="spine">${spineHtml}</div></div>

    <div class="grid">
      <div class="card" id="card-gs">
        <span class="label">Subject 1 of 2</span>
        <h3>${g.subjectLabel}</h3>
        <div class="topic">${g.topic}</div>
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
        <span class="label">Subject 2 of 2 — Optional</span>
        <h3>${optionalLabel()}</h3>
        <div class="topic">${optionalTopics()[day-1]}</div>
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
        <div class="topic">Write ${showOptional ? '2 GS-style answers on today\\u2019s ' + g.subjectLabel + ' topic, plus 1 optional-style answer' : '2–3 mains-style answers based on today\\u2019s ' + g.subjectLabel + ' topic'}.</div>
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
    </div>

    <div id="modalRoot"></div>
  `;
  document.getElementById('app').innerHTML = html;
  attachHandlers();
}

function attachHandlers(){
  document.querySelectorAll('[data-action="profile"]').forEach(b=>{
    b.addEventListener('click', async ()=>{
      state.profile = b.getAttribute('data-value');
      await saveProfile();
      await loadProgress();
      await loadSubjectOrderForProfile(state.profile);
      rebuildGSDays(state.subjectOrder[state.profile]);
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
  const profileLabel = state.profile==='psir' ? 'You · PSIR' : 'Partner · Malayalam';
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
    const g = GS_DAYS[day-1];
    const showOptional = day<=OPTIONAL_DAYS;
    const prog = getDayProgress(day);
    const dateObj = scheduledDate(day);
    rows.push({
      day, dateObj,
      gsLabel: g.subjectLabel, gsTopic: g.topic,
      optTopic: showOptional ? optionalTopics()[day-1] : null,
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
        <div class="field"><label>Profile</label><strong>${state.profile==='psir' ? 'You · PSIR' : 'Partner · Malayalam'}</strong></div>
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
  const profileLabel = state.profile==='psir' ? 'You · PSIR' : 'Partner · Malayalam';
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

/* ============== INIT ============== */
(async function init(){
  document.getElementById('app').innerHTML = '<div style="padding:40px; text-align:center; color:var(--muted);">Loading your ledger…</div>';
  await loadState();
  render();
})();
