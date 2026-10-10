/* ── CALL & CONVERT SCORE (Leads page strip + "Attend Next" card, Reports → 📞 Calls & Conversions) ──
   Everything here is derived from data the app already saves — each lead's CallLog (who called,
   when, outcome), its Owner, Stage/ClosedAt (conversion) and Score — so there is no new table and
   no backend route. Points, streaks and targets are recomputed from that history on every render,
   which keeps them consistent for every viewer and impossible to drift from the real call log.
   Per-user daily targets live in clientRecord.bot_config.call_targets (merged by patchClient's
   mergeBotConfigFields, so other bot_config keys are never clobbered).
   Uses dashboard.html's own globals: allLeads, clientRecord, myEmail, getTeamMembers, sameEmail,
   isAccountOwner, isWonLead, isLostLead, leadCallTier, leadNeedsActionScore, callBtnHTML,
   maskPhone, esc, $id, showToast, timeAgo, openDetail, patchClient, _rptFilters.
   Bump the ?v= on its <script> tag in dashboard.html when changing this file — sw.js serves
   scripts cache-first. ── */

// Points — weighted toward calls that connect and leads that convert, so logging empty calls
// can't outscore actually closing.
const CS_PTS={call:3, answered:15, fast:15, callback:10, won:50, wonHot:25, wonBig:25, hotMissed:-10,
  task:10, taskOnTime:5, taskPriority:5, project:30, taskOverdue:-5};
const CS_OVERDUE_CAP=5; // at most 5 overdue tasks count against today's score
const CS_DEFAULT_TARGETS={calls:30, won:3};
const CS_FAST_MS=5*60000;           // first call within 5 min of the lead arriving
const CS_CALLBACK_MS=3*3600000;     // a "Callback Requested" followed up within 3h counts as on time
const CS_HOT_MISSED_MS=24*3600000;  // Hot lead still never called after 24h

function csDayKey(ms){ const d=new Date(ms); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function csToday(){ return csDayKey(Date.now()); }
function csCallMs(c){ const t=Date.parse(c.at||c.date||''); return isFinite(t)?t:null; }
function csCalls(l){ return parseCallLog(l.CallLog).slice().reverse(); } // oldest first (parseCallLog: dashboard.html)
// A call that ended with "Continue on WhatsApp" (Power Dial) was a real conversation — it scores as answered.
function csConnected(c){ return c.outcome==='Answered'||c.outcome==='Moved to WhatsApp'; }
function csIsSpam(l){ return l.HandoverOutcome==='Spam'; }
function csIsOpen(l){ return !isWonLead(l) && !isLostLead(l) && l.OptOut!=='Yes' && !csIsSpam(l); }
function csEmailKey(e){ return String(e||'').trim().toLowerCase(); }

/* ── Targets ── */
function csTargetsConfig(){
  let bc={}; try{ bc=JSON.parse(clientRecord?.bot_config||'{}'); }catch(e){}
  const t=bc.call_targets||{};
  return {default:{...CS_DEFAULT_TARGETS, ...(t.default||{})}, users:t.users||{}};
}
// ⚡ Power hour — a daily slot (browser local time) where every call earns double points.
function csPowerHour(){
  let bc={}; try{ bc=JSON.parse(clientRecord?.bot_config||'{}'); }catch(e){}
  const p=bc.power_hour||{};
  const h=v=>{ const n=Math.round(Number(v)); return n>=0&&n<=23?n:null; };
  const start=h(p.start)??11, end=h(p.end)??12;
  // On by default (11am–12pm); only counts calls from when it took effect, so switching it on never
  // re-scores past weeks or changes an old champion.
  return {enabled:p.enabled!==false, start, end:end>start?end:start+1, since:Date.parse(p.since||'')||CS_POWER_DEFAULT_SINCE};
}
const CS_POWER_DEFAULT_SINCE=Date.parse('2026-10-07T00:00:00');
function csInPowerHour(ms){ const ph=csPowerHour(); if(!ph.enabled || ms<ph.since) return false; const h=new Date(ms).getHours(); return h>=ph.start && h<ph.end; }
function csPowerState(){
  const ph=csPowerHour(); if(!ph.enabled) return null;
  const d=new Date(), mins=d.getHours()*60+d.getMinutes();
  if(mins>=ph.start*60 && mins<ph.end*60) return {active:true, minsLeft:ph.end*60-mins, ph};
  if(mins<ph.start*60) return {active:false, startsIn:ph.start*60-mins, ph};
  return {active:false, ph};
}
// Leads won in a given week by anyone — the team goal counts every win, owned or not.
function csTeamWon(offset){ const r=csWeekRange(offset||0); return csEvents().filter(e=>e.kind==='won' && e.ms>=r.from && e.ms<=r.to).length; }
const csHour=h=>`${((h+11)%12)+1}${h<12?'am':'pm'}`;
// 🤝 Weekly team goal — conversions the whole team aims for together (0 / unset = off).
function csTeamGoal(){
  let bc={}; try{ bc=JSON.parse(clientRecord?.bot_config||'{}'); }catch(e){}
  const n=Math.round(Number(bc.team_goal?.won)); return n>0?n:0;
}
function csTargetsFor(email){
  const cfg=csTargetsConfig();
  return {...cfg.default, ...(cfg.users[csEmailKey(email)]||{})};
}

/* ── Event stream: every point-earning action, attributed to one user ── */
/* ── Tasks & projects ──
   Two task stores exist: Projects (D1 pm_tasks / pm_projects, read via GET /pm/tasks and
   /pm/projects) and the dashboard's own Tasks list (clientRecord.manual_tasks). New dashboard
   tasks are also copied into pm_tasks, so the same task can appear in both — merged by
   title + assignee, keeping whichever copy is done. */
let _csWork={tasks:[], projects:[], at:0};
let _csWorkTimer=null;
async function csLoadWork(force){
  if(typeof CONFIG==='undefined' || !CONFIG.WORKER_BASE || typeof ncAuthHeaders!=='function') return;
  if(!force && Date.now()-_csWork.at<60000) return;
  _csWork.at=Date.now();
  const get=u=>fetch(CONFIG.WORKER_BASE+u,{headers:ncAuthHeaders()}).then(r=>r.ok?r.json():{list:[]}).catch(()=>({list:[]}));
  const [t,p]=await Promise.all([get('/pm/tasks'), get('/pm/projects')]);
  _csWork={tasks:Array.isArray(t.list)?t.list:[], projects:Array.isArray(p.list)?p.list:[], at:Date.now()};
  _csCache=null;
  try{ if($id('homeArena')?.style.display!=='none') csRenderHomeArena(); }catch(e){}
  try{ if(typeof renderLeadsMomentumStrip==='function') renderLeadsMomentumStrip(); }catch(e){}
}
function csTasks(){
  const out=new Map();
  const add=(t,src)=>{
    const key=String(t.title||'').trim().toLowerCase()+'|'+csEmailKey(t.by);
    const prev=out.get(key);
    if(!prev || (t.done && !prev.done)) out.set(key,{...t,src});
  };
  for(const t of _csWork.tasks) add({id:'pm'+t.id, title:t.title, by:t.assignee_email, done:t.status==='done', doneMs:t.done_at?Date.parse(t.done_at):NaN,
    due:t.due_date||'', priority:t.priority||'', projectId:Number(t.project_id)||0},'pm');
  let manual=[]; try{ manual=getTasksState().items||[]; }catch(e){}
  for(const t of manual) add({id:'mt'+t.id, title:t.title, by:t.assignee_email, done:t.status==='done', doneMs:t.completed_at?Date.parse(t.completed_at):NaN,
    due:t.due_date||'', priority:t.priority||'', projectId:0},'manual');
  return [...out.values()].filter(t=>t.by);
}
function csTaskPts(t){
  return CS_PTS.task+(t.due && csDayKey(t.doneMs)<=String(t.due).slice(0,10)?CS_PTS.taskOnTime:0)+(/high|urgent/i.test(t.priority)?CS_PTS.taskPriority:0);
}
function csOverdueTasks(email){
  const today=csToday();
  return csTasks().filter(t=>!t.done && t.due && String(t.due).slice(0,10)<today && (!email||sameEmail(t.by,email)));
}

let _csCache=null;
function csEvents(){
  const sig=allLeads.length+'|'+allLeads.reduce((s,l)=>s+(l.CallLog||'').length+(l.Stage||'').length+(l.ClosedAt||'').length,0)+'|'+_csWork.at+'|'+(clientRecord?.manual_tasks||'').length;
  if(_csCache && _csCache.sig===sig) return _csCache.events;
  const events=[];
  const wonValues=allLeads.filter(l=>isWonLead(l)&&Number(l.DealValue)>0).map(l=>Number(l.DealValue)).sort((a,b)=>a-b);
  const medianWon=wonValues.length?wonValues[Math.floor(wonValues.length/2)]:0;
  for(const l of allLeads){
    const calls=csCalls(l);
    const leadMs=l.Date?Date.parse(l.Date):NaN;
    calls.forEach((c,i)=>{
      const ms=csCallMs(c); if(ms==null||!c.by) return;
      const answered=csConnected(c);
      events.push({by:csEmailKey(c.by), ms, kind:answered?'answered':'call', pts:answered?CS_PTS.answered:CS_PTS.call, leadId:l.Id, outcome:c.outcome||'', duration:Number(c.duration)||0, ordinal:i+1});
      const base=answered?CS_PTS.answered:CS_PTS.call;
      // First call within 5 min of the lead arriving: double points (the bonus equals the call's own points)
      if(i===0 && isFinite(leadMs) && ms-leadMs>=0 && ms-leadMs<=CS_FAST_MS) events.push({by:csEmailKey(c.by), ms, kind:'fast', pts:base, leadId:l.Id});
      // ⚡ Power hour: every call counts double
      if(csInPowerHour(ms)) events.push({by:csEmailKey(c.by), ms, kind:'power', pts:base, leadId:l.Id});
      const prev=calls[i-1], prevMs=prev?csCallMs(prev):null;
      if(prev && /callback/i.test(prev.outcome||'') && prevMs!=null && ms-prevMs<=CS_CALLBACK_MS) events.push({by:csEmailKey(c.by), ms, kind:'callback', pts:CS_PTS.callback, leadId:l.Id});
    });
    // Every lead marked Won counts. Credit goes to its Owner, else whoever last called it (an
    // unowned win with no caller still counts toward the team goal, by:''). Dated by ClosedAt,
    // falling back to its last call (closest to when it was won) / last update / arrival when ClosedAt is blank (a leads table
    // without that column, or a lead won by the bot or before the column existed).
    if(isWonLead(l)){
      const lastCall=calls[calls.length-1];
      const ms=[l.ClosedAt, lastCall&&(lastCall.at||lastCall.date), l.UpdatedAt, l.Date].map(v=>Date.parse(v||'')).find(isFinite);
      if(ms!==undefined){
        let pts=CS_PTS.won;
        if(l.Score==='Hot') pts+=CS_PTS.wonHot;
        if(medianWon>0 && Number(l.DealValue)>=medianWon) pts+=CS_PTS.wonBig;
        events.push({by:csEmailKey(l.Owner||lastCall?.by||''), ms, kind:'won', pts, leadId:l.Id, value:Number(l.DealValue)||0});
      }
    }
  }
  // Tasks done: +10, +5 when done by the due date, +5 for high/urgent priority
  const tasks=csTasks();
  for(const t of tasks){
    if(!t.done || !isFinite(t.doneMs)) continue;
    const ontime=!!(t.due && csDayKey(t.doneMs)<=String(t.due).slice(0,10));
    events.push({by:csEmailKey(t.by), ms:t.doneMs, kind:'task', pts:csTaskPts(t), ontime, taskId:t.id});
  }
  // Project finished (all of its 2+ tasks done, or marked completed): +30 to everyone who
  // completed a task in it, dated when its last task was done
  const byProject={};
  for(const t of tasks) if(t.projectId) (byProject[t.projectId]||(byProject[t.projectId]=[])).push(t);
  for(const pr of _csWork.projects){
    const list=byProject[Number(pr.id)]||[];
    const done=list.filter(t=>t.done && isFinite(t.doneMs));
    if(list.length<2 || !done.length) continue;
    if(pr.status!=='completed' && done.length<list.length) continue;
    const ms=Math.max(...done.map(t=>t.doneMs));
    for(const by of new Set(done.map(t=>csEmailKey(t.by)))) events.push({by, ms, kind:'project', pts:CS_PTS.project, projectId:Number(pr.id), projectName:pr.name||''});
  }
  _csCache={sig, events};
  return events;
}
// Hot leads someone owns that still have no call after 24h — a live penalty on today's score
// (and the "leakage" list in the report), not a historical event.
function csHotMissed(email){
  const now=Date.now();
  return allLeads.filter(l=>l.Score==='Hot' && csIsOpen(l) && !csCalls(l).length
    && (!email || sameEmail(l.Owner,email))
    && l.Date && now-Date.parse(l.Date)>CS_HOT_MISSED_MS);
}
// What an open lead is worth if worked now — shown on the "Attend Next" card.
function csLeadPotential(l){
  let won=CS_PTS.won+(l.Score==='Hot'?CS_PTS.wonHot:0);
  const fresh=!csCalls(l).length && l.Date && Date.now()-Date.parse(l.Date)<=CS_FAST_MS;
  const mult=(fresh?2:1)+(csPowerState()?.active?1:0);
  return {won, callNow:CS_PTS.answered*mult, fresh};
}

/* ── Per-user daily rollup ── */
function csDaily(email){
  const me=csEmailKey(email), byDay={};
  for(const e of csEvents()){
    if(e.by!==me) continue;
    const d=csDayKey(e.ms);
    const r=byDay[d]||(byDay[d]={calls:0, answered:0, won:0, tasks:0, projects:0, pts:0});
    if(e.kind==='call'||e.kind==='answered') r.calls++;
    if(e.kind==='answered') r.answered++;
    if(e.kind==='won') r.won++;
    if(e.kind==='task') r.tasks++;
    if(e.kind==='project') r.projects++;
    r.pts+=e.pts;
  }
  return byDay;
}
// Days anyone on the team logged a call — a day the whole team was off (holiday, weekend) never
// breaks a streak or counts against the target hit-rate.
function csTeamWorkDays(){
  const s=new Set();
  for(const e of csEvents()) if(e.kind==='call'||e.kind==='answered') s.add(csDayKey(e.ms));
  return s;
}
function csStreak(email){
  const daily=csDaily(email), target=csTargetsFor(email).calls, work=csTeamWorkDays();
  let streak=0;
  const d=new Date(); d.setHours(12,0,0,0);
  const todayMet=(daily[csToday()]?.calls||0)>=target;
  if(!todayMet) d.setDate(d.getDate()-1); // today still in progress — doesn't break the streak yet
  for(let i=0;i<400;i++){
    const k=csDayKey(d.getTime());
    if((daily[k]?.calls||0)>=target) streak++;
    else if(work.has(k)) break;
    d.setDate(d.getDate()-1);
  }
  return streak;
}
function csTodaySummary(email){
  const t=csDaily(email)[csToday()]||{calls:0, answered:0, won:0, tasks:0, projects:0, pts:0};
  const missed=csHotMissed(email).length, overdue=csOverdueTasks(email).length;
  return {...t, pts:t.pts+missed*CS_PTS.hotMissed+Math.min(overdue,CS_OVERDUE_CAP)*CS_PTS.taskOverdue, missed, overdue, target:csTargetsFor(email), streak:csStreak(email)};
}

/* ── Leads page: one-line personal strip + "Attend Next" card (one Call button) ── */
function csAttendNextLead(){
  const mine=allLeads.filter(l=>csIsOpen(l) && l.Phone && (!l.Owner || sameEmail(l.Owner,myEmail)));
  if(!mine.length) return null;
  // Same call order as the list; within it a lead that arrived in the last 30 min jumps ahead
  // (speed-to-lead is the biggest conversion lever), then Hot, then the Needs Action score.
  const fresh=l=>!csCalls(l).length && l.Date && Date.now()-Date.parse(l.Date)<=30*60000 ? 1 : 0;
  return mine.map(l=>({l, tier:leadCallTier(l), fresh:fresh(l), hot:l.Score==='Hot'?1:0, score:leadNeedsActionScore(l)}))
    .sort((a,b)=>a.tier-b.tier || b.fresh-a.fresh || b.hot-a.hot || b.score-a.score)[0].l;
}
function csLeadsTopHtml(){
  if(!myEmail) return '';
  const s=csTodaySummary(myEmail);
  const callsDone=s.calls>=s.target.calls, wonDone=s.won>=s.target.won;
  const bar=(n,t)=>`<span class="cs-bar"><span style="width:${Math.min(100,Math.round(n/Math.max(1,t)*100))}%"></span></span>`;
  const strip=`<div class="cs-strip">
    <span title="Calls logged today vs your daily target">📞 <strong>${s.calls}</strong>/${s.target.calls} calls${callsDone?' ✓':''} ${bar(s.calls,s.target.calls)}</span>
    <span title="Leads you converted today vs your daily target">✅ <strong>${s.won}</strong>/${s.target.won} converted${wonDone?' ✓':''}</span>
    <span title="Days in a row you hit your call target">🔥 <strong>${s.streak}</strong>-day streak</span>
    <span title="Points today: answered call +${CS_PTS.answered}, call +${CS_PTS.call}, first call in 5 min 2×, power hour 2×, callback on time +${CS_PTS.callback}, converted +${CS_PTS.won}, task done +${CS_PTS.task}${s.overdue?`, ${s.overdue} overdue task(s) ${CS_PTS.taskOverdue} each`:''}${s.missed?`, ${s.missed} Hot lead(s) uncalled 24h+ ${CS_PTS.hotMissed} each`:''}">⭐ <strong>${s.pts}</strong> pts</span>
  </div>`;
  const l=csAttendNextLead();
  if(!l) return strip;
  const p=csLeadPotential(l), tier=leadCallTier(l), calls=csCalls(l);
  const chips=[
    l.Score==='Hot'?'<span class="tag" style="background:#FEE2E2;color:#991B1B">🔥 Hot</span>':'',
    tier===0?'<span class="tag" style="background:#DBEAFE;color:#1E40AF">🆕 Never called</span>':'',
    tier===1?'<span class="tag" style="background:#EDE9FE;color:#5B21B6">⏰ Follow-up due</span>':'',
    calls.length?`<span class="tag">📞 ${calls.length}× · ${timeAgo(calls[calls.length-1].at||calls[calls.length-1].date)}</span>`:(l.Date?`<span class="tag">⏱ waiting ${timeAgo(l.Date).replace(' ago','')}</span>`:''),
  ].join('');
  return strip+`<div class="cs-next" onclick="openDetail(${l.Id})">
    <div class="cs-next-body">
      <div class="cs-next-lbl">🎯 Attend next</div>
      <div class="cs-next-name">${esc(l.Name||'Unknown')} <span style="font-weight:400;color:var(--muted);font-size:12px">${esc(maskPhone(l.Phone))}</span></div>
      <div class="tags-row" style="margin-top:4px">${chips}<span class="tag" style="background:#FEF3C7;color:#92400E">+${p.callNow} if answered · +${p.won} if converted</span></div>
    </div>
    <div onclick="event.stopPropagation()">${callBtnHTML(l,'📞 Call')}</div>
  </div>`;
}

/* ── Personal bests ── */
function csWeekKey(ms){ const d=new Date(ms); d.setHours(0,0,0,0); d.setDate(d.getDate()-d.getDay()); return csDayKey(d.getTime()); }
function csBests(email){
  const me=csEmailKey(email), today=csToday(), thisWeek=csWeekKey(Date.now());
  const daily=csDaily(email), weeks={};
  for(const e of csEvents()) if(e.by===me){ const k=csWeekKey(e.ms); weeks[k]=(weeks[k]||0)+e.pts; }
  const days=Object.entries(daily).filter(([d])=>d!==today);
  return {
    dayCalls:Math.max(0,...days.map(([,r])=>r.calls)),
    weekPts:Math.max(0,...Object.entries(weeks).filter(([w])=>w!==thisWeek).map(([,p])=>p)),
    todayCalls:daily[today]?.calls||0, weekPts_now:weeks[thisWeek]||0,
  };
}
// One celebration per record per day/week per browser (sessionStorage), never on a first-ever day.
function csCheckRecords(){
  if(!myEmail) return null;
  const b=csBests(myEmail);
  const flag=(k)=>{ try{ if(sessionStorage.getItem(k)) return false; sessionStorage.setItem(k,'1'); }catch(e){} return true; };
  if(b.dayCalls>=5 && b.todayCalls>b.dayCalls && flag('cs_pb_day_'+csToday())) return `🏅 New record! ${b.todayCalls} calls in a day — your best ever 🎉`;
  if(b.weekPts>=50 && b.weekPts_now>b.weekPts && flag('cs_pb_week_'+csWeekKey(Date.now()))) return `🏅 New record week! ${b.weekPts_now} pts — beat your best of ${b.weekPts} 🎉`;
  return null;
}

/* ── 🔔 New-lead alert: banner with a 5-minute "double points" countdown and one Call button ── */
let _csAlertTimer=null;
function csNewLeadAlert(lead, reason){
  if(!lead || typeof document==='undefined') return;
  let el=$id('csLeadAlert');
  if(!el){ el=document.createElement('div'); el.id='csLeadAlert'; el.className='cs-alert'; document.body.appendChild(el); }
  clearInterval(_csAlertTimer);
  const arrived=reason==='reassigned'?Date.now()-CS_FAST_MS:(Date.parse(lead.Date||'')||Date.now());
  const askPerm=('Notification' in window) && Notification.permission==='default';
  const paint=()=>{
    const left=CS_FAST_MS-(Date.now()-arrived);
    const timer=left>0?`<span class="cs-alert-timer">⏱ ${Math.floor(left/60000)}:${String(Math.floor(left%60000/1000)).padStart(2,'0')}</span>`:'';
    el.innerHTML=`<div class="cs-alert-main" onclick="openDetail(${lead.Id})">
        <div class="cs-alert-title">${reason==='reassigned'?'🔥 Hot lead reassigned to you':'🔔 New lead'} · <b>${esc(lead.Name||lead.Phone||'New enquiry')}</b></div>
        <div class="cs-alert-sub">${left>0?`Call within the timer for <b>2× points</b>`:'Call now while they’re interested'}${askPerm?` · <a href="#" onclick="event.stopPropagation();Notification.requestPermission();this.remove();return false">Turn on alerts</a>`:''}</div>
      </div>
      ${timer}
      ${lead.Phone?`<a class="btn btn-sm cs-alert-call" href="tel:+${String(lead.Phone).replace(/[^0-9]/g,'')}" onclick="startCallTimer?.(${lead.Id})">📞 Call</a>`:''}
      <button class="cs-alert-x" aria-label="Dismiss" onclick="csDismissLeadAlert()">✕</button>`;
    if(left<=-10*60000) csDismissLeadAlert();
  };
  paint(); el.classList.add('show');
  _csAlertTimer=setInterval(paint,1000);
}
function csDismissLeadAlert(){ clearInterval(_csAlertTimer); $id('csLeadAlert')?.classList.remove('show'); }

/* ── Celebration toasts after a call / a conversion ── */
function csAfterCall(leadId){
  _csCache=null;
  if(!myEmail) return;
  const l=allLeads.find(x=>x.Id===leadId); if(!l) return;
  const mine=csEvents().filter(e=>e.leadId===leadId && e.by===csEmailKey(myEmail) && Date.now()-e.ms<120000 && e.kind!=='won');
  const pts=mine.reduce((s,e)=>s+e.pts,0);
  const s=csTodaySummary(myEmail);
  const record=csCheckRecords();
  const boost=mine.some(e=>e.kind==='fast')?' ⚡ 2× fast call':mine.some(e=>e.kind==='power')?' ⚡ power hour 2×':'';
  if(record) showToast(record,'ok');
  else if(s.calls===s.target.calls) showToast(`🎯 Daily call target hit! +${pts} pts · 🔥 ${s.streak}-day streak`,'ok');
  else if(pts) showToast(`+${pts} pts${boost} · 📞 ${s.calls}/${s.target.calls} calls today`,'ok');
  if($id('csLeadAlert')?.classList.contains('show') && $id('csLeadAlert').innerHTML.includes(`openDetail(${leadId})`)) csDismissLeadAlert();
  if(typeof renderLeadsMomentumStrip==='function') renderLeadsMomentumStrip();
}
function csAfterWon(leadId){
  _csCache=null;
  const ev=csEvents().find(e=>e.leadId===leadId && e.kind==='won');
  const s=myEmail?csTodaySummary(myEmail):null;
  const goal=csTeamGoal(), teamWon=goal?csTeamWon(0):0;
  showToast(csCheckRecords()||(goal&&teamWon===goal?`🤝 Team goal reached — ${goal} conversions this week! 🎉`:`🎉 Converted! +${ev?.pts||CS_PTS.won} pts${s?` · ✅ ${s.won}/${s.target.won} today`:''}${goal?` · 🤝 team ${teamWon}/${goal}`:''}`),'ok');
  if(typeof renderLeadsMomentumStrip==='function') renderLeadsMomentumStrip();
}

/* ── Reports → 📞 Calls & Conversions ── */
function csRange(){
  const f=_rptFilters||{period:'all'}; const now=new Date(); let from=null, to=null;
  const sod=d=>{ const x=new Date(d); x.setHours(0,0,0,0); return x; };
  if(f.period==='today') from=sod(now);
  else if(f.period==='week'){ from=sod(now); from.setDate(from.getDate()-from.getDay()); }
  else if(f.period==='month') from=new Date(now.getFullYear(),now.getMonth(),1);
  else if(f.period==='year') from=new Date(now.getFullYear(),0,1);
  else if(f.period==='custom'){ if(f.from) from=new Date(f.from+'T00:00:00'); if(f.to) to=new Date(f.to+'T23:59:59'); }
  return {from:from?from.getTime():-Infinity, to:to?to.getTime():Infinity};
}
// Owner sees everyone (or the member picked in the Reports filter bar); everyone else only sees
// their own numbers.
function csVisibleMembers(){
  const members=getTeamMembers();
  if(!isAccountOwner()) return members.filter(m=>sameEmail(m.email,myEmail));
  const pick=$id('rptMember')?.value||'';
  return pick?members.filter(m=>sameEmail(m.email,pick)):members;
}
function csMedian(a){ if(!a.length) return null; const s=a.slice().sort((x,y)=>x-y); return s[Math.floor(s.length/2)]; }
function csPct(n,d){ return d?Math.round(n/d*100)+'%':'—'; }
function csWho(m){ return `<b>${esc(m.name)}</b>${m.email!==m.name?`<div style="font-size:11px;color:var(--muted)">${esc(m.email)}</div>`:''}`; }

function csUserStats(email, range){
  const me=csEmailKey(email);
  const evs=csEvents().filter(e=>e.by===me && e.ms>=range.from && e.ms<=range.to);
  const callEvs=evs.filter(e=>e.kind==='call'||e.kind==='answered');
  const answered=callEvs.filter(e=>e.kind==='answered');
  const durations=answered.map(e=>e.duration).filter(n=>n>0);
  const won=evs.filter(e=>e.kind==='won');
  const taskEvs=evs.filter(e=>e.kind==='task');
  const leadsCalled=new Set(callEvs.map(e=>e.leadId));
  // Speed to first call: lead arrival → this user's call, for leads where theirs was the first call
  const speeds=callEvs.filter(e=>e.ordinal===1).map(e=>{ const l=allLeads.find(x=>x.Id===e.leadId); const t=l?.Date?Date.parse(l.Date):NaN; return isFinite(t)?(e.ms-t)/60000:null; }).filter(v=>v!=null&&v>=0);
  // Callbacks: every "Callback Requested" this user logged whose 3h window has passed (or was met)
  let cbDue=0, cbOnTime=0;
  for(const l of allLeads){
    const calls=csCalls(l);
    calls.forEach((c,i)=>{
      const ms=csCallMs(c);
      if(ms==null||csEmailKey(c.by)!==me||!/callback/i.test(c.outcome||'')||ms<range.from||ms>range.to) return;
      const next=calls[i+1], nextMs=next?csCallMs(next):null;
      const onTime=nextMs!=null && nextMs-ms<=CS_CALLBACK_MS;
      if(onTime||Date.now()-ms>CS_CALLBACK_MS){ cbDue++; if(onTime) cbOnTime++; }
    });
  }
  const outcomes={Answered:0,'No Answer':0,Voicemail:0,'Callback Requested':0,Other:0};
  callEvs.forEach(e=>{ outcomes[e.outcome in outcomes?e.outcome:'Other']++; });
  // Target hit-rate over team working days inside the range
  const daily=csDaily(email), target=csTargetsFor(email), work=[...csTeamWorkDays()].filter(d=>{ const t=Date.parse(d+'T12:00:00'); return t>=range.from&&t<=range.to; });
  const daysMet=work.filter(d=>(daily[d]?.calls||0)>=target.calls).length;
  return {calls:callEvs.length, answered:answered.length, avgTalk:durations.length?Math.round(durations.reduce((s,n)=>s+n,0)/durations.length):null,
    won:won.length, wonValue:won.reduce((s,e)=>s+(e.value||0),0), leadsCalled:leadsCalled.size, speed:csMedian(speeds), speedN:speeds.length, cbDue, cbOnTime,
    tasks:taskEvs.length, tasksOnTime:taskEvs.filter(e=>e.ontime).length, projects:evs.filter(e=>e.kind==='project').length,
    pts:evs.reduce((s,e)=>s+e.pts,0), outcomes, workDays:work.length, daysMet, target, streak:csStreak(email), today:csTodaySummary(email)};
}
function csFunnel(email, range){
  const owned=allLeads.filter(l=>sameEmail(l.Owner,email) && !csIsSpam(l) && l.Date && Date.parse(l.Date)>=range.from && Date.parse(l.Date)<=range.to);
  const called=owned.filter(l=>csCalls(l).length);
  const connected=called.filter(l=>csCalls(l).some(csConnected));
  const interested=connected.filter(l=>isWonLead(l) || l.Score==='Hot' || l.Score==='Warm' || (!isLostLead(l) && l.Stage && l.Stage!=='new'));
  const converted=owned.filter(isWonLead);
  return [['Assigned',owned.length],['Called',called.length],['Connected',connected.length],['Interested',interested.length],['Converted',converted.length]];
}

function renderReportsCalls(){
  _csCache=null;
  const el=$id('reportsContent');
  const range=csRange(), members=csVisibleMembers(), owner=isAccountOwner();
  if(!members.length){ el.innerHTML='<div class="card"><div style="color:var(--muted);font-size:13px">No team members yet — add one in Settings → User Management.</div></div>'; return; }
  const rows=members.map(m=>({m, s:csUserStats(m.email, range)}));
  const tot=rows.reduce((a,{s})=>({calls:a.calls+s.calls, answered:a.answered+s.answered, won:a.won+s.won, leadsCalled:a.leadsCalled+s.leadsCalled, pts:a.pts+s.pts}),{calls:0,answered:0,won:0,leadsCalled:0,pts:0});
  const head=(t,note)=>`<div style="margin:22px 0 10px"><div class="card-title" style="margin-bottom:0">${t}</div>${note?`<div class="s-note">${note}</div>`:''}</div>`;

  // 1. Scorecard
  let html=`<div class="s-note" style="margin-bottom:12px">${owner?'Every team member\'s calls and conversions. Pick one person in the filter bar to focus on them.':'Your own calls and conversions.'} Built from the 📞 call log and Won leads — date filter applies to when the call / conversion happened.</div>
  <div style="display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));margin-bottom:14px">
    <div class="stat"><div class="stat-lbl">Calls</div><div class="stat-val">${tot.calls}</div></div>
    <div class="stat"><div class="stat-lbl">Connected</div><div class="stat-val">${csPct(tot.answered,tot.calls)}</div></div>
    <div class="stat accent"><div class="stat-lbl">Converted</div><div class="stat-val">${tot.won}</div></div>
    <div class="stat"><div class="stat-lbl">Conversion (of leads called)</div><div class="stat-val">${csPct(tot.won,tot.leadsCalled)}</div></div>
    <div class="stat"><div class="stat-lbl">Points</div><div class="stat-val">${tot.pts}</div></div>
  </div>`;
  html+=head('🏅 Scorecard','Connected = calls marked Answered. Conversion = leads converted ÷ leads called. Speed = median minutes from a lead arriving to its first call. Callback on time = followed up within 3h. Tasks come from Projects and the Tasks list (+10 each, +5 on time, +5 high priority; +30 when a project you worked on is finished).');
  html+=`<div class="card"><div style="overflow-x:auto"><table class="leads-tbl" style="width:100%;min-width:1180px">
    <thead><tr><th>Agent</th><th>Today</th><th>Calls</th><th>Connected</th><th>Avg talk</th><th>Converted</th><th>Conversion</th><th>1st-call speed</th><th>Callbacks on time</th><th>Tasks done</th><th>Points</th><th>Streak</th><th>Target hit-rate</th></tr></thead>
    <tbody>${rows.map(({m,s})=>`<tr>
      <td>${csWho(m)}</td>
      <td style="white-space:nowrap">📞 ${s.today.calls}/${s.today.target.calls}<br>✅ ${s.today.won}/${s.today.target.won}</td>
      <td>${s.calls}</td><td>${csPct(s.answered,s.calls)}</td><td>${s.avgTalk!=null?s.avgTalk+' min':'—'}</td>
      <td><b>${s.won}</b></td><td>${csPct(s.won,s.leadsCalled)}</td>
      <td>${s.speed==null?'—':s.speed<60?Math.round(s.speed)+' min':(s.speed/60).toFixed(1)+' h'}</td>
      <td>${s.cbDue?`${csPct(s.cbOnTime,s.cbDue)} <span style="color:var(--muted);font-size:11px">(${s.cbOnTime}/${s.cbDue})</span>`:'—'}</td>
      <td>${s.tasks?`${s.tasks} <span style="color:var(--muted);font-size:11px">(${s.tasksOnTime} on time${s.projects?` · ${s.projects} project${s.projects>1?'s':''}`:''})</span>`:'—'}</td>
      <td><b>${s.pts}</b></td><td>🔥 ${s.streak}</td>
      <td>${s.workDays?`${csPct(s.daysMet,s.workDays)} <span style="color:var(--muted);font-size:11px">(${s.daysMet}/${s.workDays} days)</span>`:'—'}</td>
    </tr>`).join('')}</tbody></table></div></div>`;

  // 2. Funnel
  html+=head('🔻 Call-to-convert funnel','Leads assigned in this period → called → connected (answered) → interested (Hot/Warm or moved past New) → converted. Shows where each person loses leads.');
  html+=`<div class="card"><div style="overflow-x:auto"><table class="leads-tbl" style="width:100%;min-width:760px">
    <thead><tr><th>Agent</th><th>Assigned</th><th>Called</th><th>Connected</th><th>Interested</th><th>Converted</th></tr></thead>
    <tbody>${rows.map(({m})=>{ const f=csFunnel(m.email,range); return `<tr><td>${csWho(m)}</td>${f.map(([,n],i)=>`<td><b>${n}</b>${i?` <span style="font-size:11px;color:${f[i-1][1]&&n/f[i-1][1]<0.5?'var(--red)':'var(--muted)'}">${csPct(n,f[i-1][1])}</span>`:''}</td>`).join('')}</tr>`; }).join('')}</tbody>
  </table></div></div>`;

  // 3. Outcomes
  const OC=[['Answered','#059669'],['No Answer','#D97706'],['Voicemail','#6B7280'],['Callback Requested','#7C3AED'],['Other','#CBD5E1']];
  html+=head('📊 Call outcomes','⚠️ flags anyone whose No Answer rate is above 50% (10+ calls) — try a different time of day (see below) or WhatsApp first.');
  html+=`<div class="card">${OC.map(([k,c])=>`<span style="font-size:11px;margin-right:12px"><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${c};margin-right:4px"></span>${k==='Callback Requested'?'Callback':k}</span>`).join('')}
    <div style="margin-top:10px">${rows.map(({m,s})=>{ const flag=s.calls>=10&&s.outcomes['No Answer']/s.calls>0.5;
      return `<div class="cs-oc-row"><div class="cs-oc-name">${esc(m.name)}${flag?' ⚠️':''}</div><div class="cs-oc-bar">${s.calls?OC.map(([k,c])=>s.outcomes[k]?`<span title="${k}: ${s.outcomes[k]}" style="width:${s.outcomes[k]/s.calls*100}%;background:${c}"></span>`:'').join(''):'<em style="font-size:11px;color:var(--muted)">No calls</em>'}</div><div class="cs-oc-n">${s.calls}</div></div>`; }).join('')}</div></div>`;

  // 4. Best time to call
  const emails=new Set(members.map(m=>csEmailKey(m.email)));
  const hours=Array.from({length:24},()=>({calls:0,ans:0}));
  csEvents().forEach(e=>{ if((e.kind==='call'||e.kind==='answered')&&emails.has(e.by)&&e.ms>=range.from&&e.ms<=range.to){ const h=new Date(e.ms).getHours(); hours[h].calls++; if(e.kind==='answered') hours[h].ans++; } });
  const activeH=hours.map((x,h)=>({h,...x})).filter(x=>x.calls);
  const maxRate=Math.max(1,...activeH.map(x=>x.ans/x.calls));
  const bestH=activeH.filter(x=>x.calls>=5).sort((a,b)=>b.ans/b.calls-a.ans/a.calls).slice(0,3);
  html+=head('🕐 Best time to call','Connect rate by hour of day (bar height). Number under each bar = calls made.'+(bestH.length?` Best hours: <b>${bestH.map(x=>`${x.h}:00 (${csPct(x.ans,x.calls)})`).join(', ')}</b>.`:''));
  html+=`<div class="card">${activeH.length?`<div class="cs-hours">${activeH.map(x=>`<div class="cs-hour" title="${x.h}:00 — ${x.ans}/${x.calls} answered"><div class="cs-hour-bar"><span style="height:${Math.round(x.ans/x.calls/maxRate*100)}%"></span></div><div class="cs-hour-pct">${csPct(x.ans,x.calls)}</div><div class="cs-hour-h">${x.h}h</div><div class="cs-hour-n">${x.calls}</div></div>`).join('')}</div>`:'<div style="color:var(--muted);font-size:13px">No calls in this period.</div>'}</div>`;

  // 5. Leakage
  const ownedBy=l=>owner&&!($id('rptMember')?.value)?true:members.some(m=>sameEmail(l.Owner,m.email));
  const hotMissed=csHotMissed().filter(ownedBy);
  const noAnswer=allLeads.filter(l=>csIsOpen(l)&&ownedBy(l)&&csCalls(l).filter(c=>c.outcome==='No Answer').length>=3 && csCalls(l).slice(-1)[0]?.outcome==='No Answer');
  const cbMissed=allLeads.filter(l=>{ if(!csIsOpen(l)||!ownedBy(l)) return false; const last=csCalls(l).slice(-1)[0]; const ms=last?csCallMs(last):null; return last&&/callback/i.test(last.outcome||'')&&ms!=null&&Date.now()-ms>CS_CALLBACK_MS; });
  const owners=Object.fromEntries(getTeamMembers().map(m=>[csEmailKey(m.email),m.name]));
  const leakRows=(list,why)=>list.slice(0,15).map(l=>`<tr class="cs-click" onclick="openDetail(${l.Id})"><td><b>${esc(l.Name||'Unknown')}</b></td><td>${esc(maskPhone(l.Phone))}</td><td>${esc(owners[csEmailKey(l.Owner)]||l.Owner||'Unassigned')}</td><td>${why(l)}</td></tr>`).join('');
  const leakTable=(title,list,why)=>`<div class="card" style="margin-bottom:12px"><div class="s-head" style="margin-bottom:6px">${title} <span class="tag"${list.length?' style="background:#FEE2E2;color:#991B1B"':''}>${list.length}</span></div>${list.length?`<div style="overflow-x:auto"><table class="leads-tbl" style="width:100%;min-width:560px"><thead><tr><th>Lead</th><th>Phone</th><th>Owner</th><th>Why</th></tr></thead><tbody>${leakRows(list,why)}</tbody></table></div>${list.length>15?`<div class="s-note" style="margin-top:6px">+${list.length-15} more</div>`:''}`:'<div style="color:var(--muted);font-size:13px">None — nice.</div>'}</div>`;
  html+=head('🚰 Leakage — leads slipping away','Click a lead to open it. These are live (not date-filtered).');
  html+=leakTable('🔥 Hot leads not called in 24h+',hotMissed,l=>`Arrived ${timeAgo(l.Date)}, never called`);
  html+=leakTable('📵 3+ No Answers, still open',noAnswer,l=>`${csCalls(l).filter(c=>c.outcome==='No Answer').length} no-answers · last ${timeAgo(csCalls(l).slice(-1)[0].at||csCalls(l).slice(-1)[0].date)} — try WhatsApp`);
  html+=leakTable('🔁 Callbacks missed',cbMissed,l=>`Callback asked ${timeAgo(csCalls(l).slice(-1)[0].at||csCalls(l).slice(-1)[0].date)}, not called back`);

  // 6. Leaderboard (this week) + 30-day trend
  const board=csWeekBoard(0);
  const myRank=board.findIndex(r=>sameEmail(r.m.email,myEmail));
  const shown=owner?board:board.slice(0,3);
  html+=head('🏆 This week\'s leaderboard','Ranked by points, then conversions — same as the Home page Weekly Arena.'+(!owner&&myRank>=0?` You're <b>#${myRank+1}</b> of ${board.length}.`:''));
  html+=`<div class="card"><div style="overflow-x:auto"><table class="leads-tbl" style="width:100%;min-width:520px"><thead><tr><th>#</th><th>Agent</th><th>Converted</th><th>Calls</th><th>Connected</th><th>Points</th></tr></thead>
    <tbody>${shown.map((r,i)=>`<tr${sameEmail(r.m.email,myEmail)?' style="background:rgba(13,156,147,.08)"':''}><td>${['🥇','🥈','🥉'][i]||i+1}</td><td>${csWho(r.m)}</td><td><b>${r.s.won}</b></td><td>${r.s.calls}</td><td>${csPct(r.s.answered,r.s.calls)}</td><td>${r.s.pts}</td></tr>`).join('')}</tbody></table></div></div>`;

  const days=[]; for(let i=29;i>=0;i--){ const d=new Date(); d.setHours(12,0,0,0); d.setDate(d.getDate()-i); days.push(csDayKey(d.getTime())); }
  html+=head('📈 Last 30 days','Bars = calls per day (dashed line = daily target), ✅ = a conversion that day.');
  html+=`<div class="card">${members.map(m=>{ const daily=csDaily(m.email), t=csTargetsFor(m.email).calls; const max=Math.max(t,...days.map(d=>daily[d]?.calls||0),1);
    return `<div class="cs-trend-row"><div class="cs-oc-name">${esc(m.name)}</div><div class="cs-trend"><div class="cs-trend-target" style="bottom:${t/max*100}%"></div>${days.map(d=>{ const r=daily[d]||{calls:0,won:0}; return `<div class="cs-trend-day" title="${d}: ${r.calls} calls, ${r.won} converted"><span style="height:${r.calls/max*100}%;background:${r.calls>=t?'#059669':'#0D9C93'}"></span>${r.won?'<i>✅</i>':''}</div>`; }).join('')}</div></div>`; }).join('')}</div>`;

  // 7. Targets (owner only)
  if(owner){
    const cfg=csTargetsConfig();
    html+=head('🎯 Targets, power hour & team goal','Calls and conversions each person should hit per day (blank = team default), the daily power hour, and the shared weekly team goal.');
    html+=`<div class="card"><div style="overflow-x:auto"><table class="cs-targets" style="width:100%;min-width:420px"><thead><tr><th style="text-align:left">Who</th><th>📞 Calls / day</th><th>✅ Converted / day</th></tr></thead><tbody>
      <tr><td><b>Team default</b></td><td><input type="number" min="0" class="form-input" id="csTgtDefCalls" value="${cfg.default.calls}"></td><td><input type="number" min="0" class="form-input" id="csTgtDefWon" value="${cfg.default.won}"></td></tr>
      ${getTeamMembers().map(m=>{ const u=cfg.users[csEmailKey(m.email)]||{}; return `<tr data-email="${esc(csEmailKey(m.email))}"><td>${esc(m.name)}</td><td><input type="number" min="0" class="form-input cs-tgt-calls" placeholder="${cfg.default.calls}" value="${u.calls??''}"></td><td><input type="number" min="0" class="form-input cs-tgt-won" placeholder="${cfg.default.won}" value="${u.won??''}"></td></tr>`; }).join('')}
    </tbody></table></div>
    ${(()=>{ const ph=csPowerHour(), opts=sel=>Array.from({length:24},(_,h)=>`<option value="${h}"${h===sel?' selected':''}>${csHour(h)}</option>`).join(''); return `<div class="cs-cfg-row">
      <label><input type="checkbox" id="csPhOn"${ph.enabled?' checked':''}> ⚡ Power hour — every call earns 2× points from</label>
      <select class="form-input" id="csPhStart">${opts(ph.start)}</select> to <select class="form-input" id="csPhEnd">${opts(ph.end)}</select></div>
      <div class="cs-cfg-row"><label>🤝 Weekly team goal</label><input type="number" min="0" class="form-input" id="csTeamGoal" value="${csTeamGoal()||''}" placeholder="off"> conversions (whole team, shown on Home)</div>`; })()}
    <div style="margin-top:10px;display:flex;gap:10px;align-items:center"><button class="btn btn-primary btn-sm" onclick="csSaveTargets(this)">Save targets</button><span class="save-msg" id="csTgtMsg"></span></div></div>`;
  }
  el.innerHTML=html;
}

async function csSaveTargets(btn){
  const num=v=>{ const n=parseInt(v,10); return isFinite(n)&&n>=0?n:null; };
  const def={calls:num($id('csTgtDefCalls').value)??CS_DEFAULT_TARGETS.calls, won:num($id('csTgtDefWon').value)??CS_DEFAULT_TARGETS.won};
  const users={};
  document.querySelectorAll('.cs-targets tr[data-email]').forEach(tr=>{
    const calls=num(tr.querySelector('.cs-tgt-calls').value), won=num(tr.querySelector('.cs-tgt-won').value);
    if(calls!=null||won!=null) users[tr.dataset.email]={...(calls!=null?{calls}:{}), ...(won!=null?{won}:{})};
  });
  let bc={}; try{ bc=JSON.parse(clientRecord?.bot_config||'{}'); }catch(e){}
  bc.call_targets={default:def, users};
  if($id('csPhOn')){
    const prev=bc.power_hour||{}, on=$id('csPhOn').checked, start=Number($id('csPhStart').value), end=Number($id('csPhEnd').value);
    const same=prev.enabled!==false && prev.start===start && prev.end===end;
    bc.power_hour={enabled:on, start, end, since:on&&same&&prev.since?prev.since:new Date().toISOString()};
  }
  if($id('csTeamGoal')) bc.team_goal={won:num($id('csTeamGoal').value)||0};
  const msg=$id('csTgtMsg'); btn.disabled=true; msg.textContent=''; msg.className='save-msg';
  try{
    await patchClient({bot_config:JSON.stringify(bc)}); // refreshes clientRecord on success
    msg.textContent='✓ Saved';
  }catch(e){ msg.textContent='Error: '+e.message; msg.className='save-msg err'; }
  finally{ btn.disabled=false; }
}

/* ── Home → 🏆 Weekly Arena ──────────────────────────────────────────────────────────────────────
   Weekly competition over the same points as above (weeks start Sunday, like the report's "This
   Week"). Winner = most points, conversions as the tie-break. Everyone sees the podium, their own
   rank and the gap to the person above; the owner also sees the full list. */
function csWeekStart(offset){ const d=new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()-d.getDay()+7*(offset||0)); return d; }
function csWeekRange(offset){ const a=csWeekStart(offset), b=csWeekStart((offset||0)+1); return {from:a.getTime(), to:b.getTime()-1}; }
function csWeekBoard(offset){
  const range=csWeekRange(offset);
  return getTeamMembers().map(m=>({m, s:csUserStats(m.email, range)}))
    .sort((a,b)=>b.s.pts-a.s.pts || b.s.won-a.s.won || b.s.calls-a.s.calls);
}
// The week's winner — only if they actually scored (an all-zero week has no champion).
function csWeekWinner(offset){ const top=csWeekBoard(offset)[0]; return top && top.s.pts>0 ? top : null; }
// Weekly badges — each goes to the single leader of that stat this week (minimums stop a lucky
// one-call week from taking Sharpshooter/Speedster).
const CS_BADGES=[
  {id:'closer',   icon:'💰', name:'Closer',       why:'Most conversions',               val:s=>s.won,                                  ok:s=>s.won>0},
  {id:'machine',  icon:'📞', name:'Call Machine', why:'Most calls',                     val:s=>s.calls,                                ok:s=>s.calls>0},
  {id:'sharp',    icon:'🎯', name:'Sharpshooter', why:'Best connect rate (10+ calls)',  val:s=>s.answered/Math.max(1,s.calls),         ok:s=>s.calls>=10},
  {id:'speed',    icon:'⚡', name:'Speedster',    why:'Fastest first call (3+ leads)',  val:s=>-s.speed,                               ok:s=>s.speed!=null&&s.speedN>=3},
  {id:'tasks',    icon:'🛠️', name:'Task Master',  why:'Most tasks done (3+)',           val:s=>s.tasks*10+s.tasksOnTime,               ok:s=>s.tasks>=3},
  {id:'reliable', icon:'🔁', name:'Reliable',     why:'Most callbacks on time (3+)',    val:s=>s.cbOnTime/Math.max(1,s.cbDue)*1000+s.cbOnTime, ok:s=>s.cbDue>=3&&s.cbOnTime>0},
];
function csWeekBadges(board){
  const out={};
  for(const b of CS_BADGES){
    const eligible=board.filter(r=>b.ok(r.s)); if(!eligible.length) continue;
    const best=eligible.reduce((x,y)=>b.val(y.s)>b.val(x.s)?y:x);
    (out[csEmailKey(best.m.email)]||(out[csEmailKey(best.m.email)]=[])).push(b);
  }
  return out;
}
function csInitials(name){ return String(name||'?').split(/[\s@._-]+/).filter(Boolean).slice(0,2).map(w=>w[0].toUpperCase()).join('')||'?'; }
// Friendly display name: a team member with no name set shows as their email — turn
// "sona.k@aiingo.com" into "Sona K" instead of a truncated address.
function csName(m){
  const n=String(m?.name||'').trim();
  if(!n.includes('@')) return n||'Teammate';
  return n.split('@')[0].split(/[._-]+/).filter(Boolean).map(w=>w[0].toUpperCase()+w.slice(1)).join(' ')||n;
}
function csEndsIn(){
  const ms=csWeekStart(1).getTime()-Date.now(); const d=Math.floor(ms/86400000), h=Math.floor(ms%86400000/3600000);
  return d?`${d}d ${h}h`:`${h}h ${Math.floor(ms%3600000/60000)}m`;
}
// Weekly tiers — a reachable personal goal even when the leader is far ahead.
const CS_TIERS=[{min:0,icon:'🌱',name:'Rookie'},{min:50,icon:'🥉',name:'Bronze'},{min:150,icon:'🥈',name:'Silver'},{min:300,icon:'🥇',name:'Gold'},{min:500,icon:'💎',name:'Diamond'}];
function csTier(pts){
  let i=0; while(i+1<CS_TIERS.length && pts>=CS_TIERS[i+1].min) i++;
  const cur=CS_TIERS[i], next=CS_TIERS[i+1]||null;
  const pct=next?Math.round((pts-cur.min)/(next.min-cur.min)*100):100;
  return {cur, next, pct, toNext:next?next.min-pts:0};
}
const CS_AV_COLORS=['#0D9C93','#6366F1','#EC4899','#F59E0B','#10B981','#3B82F6','#8B5CF6','#EF4444'];
function csAvColor(key){ let h=0; for(const c of String(key)) h=(h*31+c.charCodeAt(0))>>>0; return CS_AV_COLORS[h%CS_AV_COLORS.length]; }
function csAvatar(m,size){ return `<span class="csa-av" style="background:${csAvColor(csEmailKey(m.email))}${size?`;width:${size}px;height:${size}px;font-size:${Math.round(size*.38)}px`:''}">${esc(csInitials(csName(m)))}</span>`; }
function csCallsFor(pts){ return Math.max(1,Math.ceil(pts/CS_PTS.answered)); }

function csRenderHomeArena(){
  const el=$id('homeArena'); if(!el) return;
  _csCache=null;
  // Tasks/projects load in the background, after the page's own critical requests (leads) —
  // the arena re-renders itself when they arrive.
  if(!_csWorkTimer && Date.now()-_csWork.at>=60000) _csWorkTimer=setTimeout(()=>{ _csWorkTimer=null; csLoadWork(); },1500);
  const members=getTeamMembers();
  if(!members.length||!myEmail){ el.style.display='none'; return; }
  const board=csWeekBoard(0), badges=csWeekBadges(board), owner=isAccountOwner();
  const me=board.find(r=>sameEmail(r.m.email,myEmail));
  const solo=members.length<2;
  const last=csWeekWinner(-1);
  const isMe=r=>sameEmail(r.m.email,myEmail);
  const myPts=me?.s.pts||0, tier=csTier(myPts), today=me?.s.today||csTodaySummary(myEmail);
  const scorers=board.filter(r=>r.s.pts>0), idle=board.filter(r=>r.s.pts<=0);
  const myRank=me&&myPts>0?scorers.indexOf(me)+1:null;
  const best=csBests(myEmail), power=csPowerState(), goal=csTeamGoal();

  // One clear next step — never a discouraging giant gap
  let motive;
  if(!myPts) motive=`First answered call = <b>+${CS_PTS.answered} pts</b> 🚀`;
  else if(myRank===1) motive=scorers[1]?`Leading by <b>${myPts-scorers[1].s.pts} pts</b> 🔥`:`You're leading 🔥`;
  else{
    const above=scorers[myRank-2], gap=above.s.pts-myPts+1;
    motive=gap<=2*CS_PTS.won?`<b>${gap} pts</b> to pass ${esc(csName(above.m))} 💪`
      : tier.next?`<b>${tier.toNext} pts</b> to ${tier.next.icon} ${tier.next.name} 💪`:`Diamond tier 💎`;
  }
  const R=34, C=2*Math.PI*R, dash=C*tier.pct/100;
  const ring=`<svg class="csa-ring" viewBox="0 0 80 80"><circle cx="40" cy="40" r="${R}" class="csa-ring-bg"/><circle cx="40" cy="40" r="${R}" class="csa-ring-fg" stroke-dasharray="${dash} ${C}" transform="rotate(-90 40 40)"/></svg>
    <div class="csa-ring-in">${myRank?`<b>#${myRank}</b><span>of ${board.length}</span>`:`<b>${tier.cur.icon}</b><span>${tier.cur.name}</span>`}</div>`;

  let html=`<div class="csa">
  <div class="csa-hero">
    <div class="csa-top">
      <span class="csa-title">🏆 Weekly Arena</span>
      <span class="csa-pill">⏳ ${csEndsIn()}</span>
      <a class="csa-link" href="#" onclick="navigate('reports');setTimeout(()=>renderReportsSubPage('calls'),0);return false">Report →</a>
    </div>
    ${power?.active?`<div class="csa-power">⚡ Power hour — <b>2× points</b> for ${power.minsLeft} min</div>`:''}
    <div class="csa-me">
      <div class="csa-ring-wrap">${ring}</div>
      <div class="csa-me-main">
        <div class="csa-pts">${myPts}<small> pts</small></div>
        <div class="csa-line">${motive}</div>
        <div class="csa-bar"><span style="width:${tier.pct}%"></span></div>
        <div class="csa-sub">${tier.cur.icon} ${tier.cur.name}${tier.next?` · ${tier.toNext} to ${tier.next.icon}`:''}${today.streak?` · 🔥 ${today.streak}d`:''}${best.dayCalls?` · 🏅 best ${best.dayCalls} calls/day`:''}</div>
      </div>
    </div>
  </div>
  <div class="csa-body">`;

  // Team goal (shared)
  if(goal && !solo){
    const teamWon=csTeamWon(0), pct=Math.min(100,Math.round(teamWon/goal*100));
    html+=`<div class="csa-goal${teamWon>=goal?' done':''}"><div class="csa-goal-top"><span>🤝 Team goal</span><b>${teamWon}/${goal} conversions</b></div><div class="csa-qbar"><span style="width:${pct}%"></span></div>${teamWon>=goal?'<div class="csa-q-sub">Goal reached — amazing teamwork! 🎉</div>':`<div class="csa-q-sub">${goal-teamWon} to go together</div>`}</div>`;
  }else if(owner && !solo){
    html+=`<a class="csa-setgoal" href="#" onclick="navigate('reports');setTimeout(()=>renderReportsSubPage('calls'),0);return false">🤝 Set a weekly team goal →</a>`;
  }

  // Today — one compact row
  const chip=(icon,txt,state)=>`<span class="csa-chip${state?' '+state:''}">${icon} ${txt}</span>`;
  html+=`<div class="csa-today">
    ${chip('📞',`${today.calls}/${today.target.calls}`,today.calls>=today.target.calls?'done':'')}
    ${chip('✅',`${today.won}/${today.target.won}`,today.won>=today.target.won?'done':'')}
    ${chip('🛠️',today.overdue?`${today.overdue} overdue`:`${today.tasks} done`,today.overdue?'warn':(today.tasks?'done':''))}
    ${!power?.active&&power?.startsIn?chip('⚡',`2× at ${csHour(power.ph.start)}`,''):''}
  </div>`;

  if(!solo){
    // Leaderboard — top 3 + me (owner sees everyone who scored)
    const leader=scorers[0]?.s.pts||1;
    let shown=scorers.map((r,i)=>({r,i}));
    if(!owner) shown=shown.filter(x=>x.i<3||isMe(x.r));
    const row=(r,i)=>`<div class="csa-row${isMe(r)?' me':''}${i===0?' top1':''}">
        <span class="csa-rank">${['🥇','🥈','🥉'][i]||i+1}</span>
        ${csAvatar(r.m,30)}
        <div class="csa-row-main"><div class="csa-row-name"><span class="csa-nm">${esc(csName(r.m))}</span>${isMe(r)?'<em>you</em>':''}${(badges[csEmailKey(r.m.email)]||[]).map(x=>`<span class="csa-mini" title="${esc(x.name)}">${x.icon}</span>`).join('')}</div>
          <div class="csa-row-bar"><span style="width:${Math.max(4,Math.round(r.s.pts/leader*100))}%"></span></div></div>
        <span class="csa-row-pts">${r.s.pts}</span></div>`;
    html+=`<div class="csa-list">${last?`<div class="csa-champ-line">👑 Last week: <b>${esc(csName(last.m))}</b>${isMe(last)?' (you!)':''}</div>`:''}`;
    html+=shown.length?shown.map((x,k)=>(k&&x.i-shown[k-1].i>1?'<div class="csa-gap">⋯</div>':'')+row(x.r,x.i)).join(''):`<div class="csa-empty">No points yet this week — first call takes the lead 🚀</div>`;
    if(idle.length) html+=`<div class="csa-idle"><span class="csa-stack">${idle.slice(0,5).map(r=>csAvatar(r.m,22)).join('')}</span><span>${idle.length} yet to score</span></div>`;
    html+=`</div>`;
  }else{
    html+=`<div class="csa-empty">Add teammates in Settings → User Management to compete 👑</div>`;
  }

  // Badges, hall of fame and how points work — tucked away
  const hall=solo?[]:[-1,-2,-3,-4].map(o=>({o, w:csWeekWinner(o)})).filter(x=>x.w);
  html+=`<details class="csa-more"><summary>Badges &amp; how points work</summary>
    <div class="csa-badges">${CS_BADGES.map(b=>{ const who=board.find(r=>(badges[csEmailKey(r.m.email)]||[]).includes(b)); return `<div class="csa-badge${who?'':' off'}${who&&isMe(who)?' mine':''}" title="${esc(b.why)}"><span class="csa-b-icon">${b.icon}</span><span class="csa-b-name">${esc(b.name)}</span><span class="csa-b-who">${who?(solo||isMe(who)?'Yours!':esc(csName(who.m))):'Up for grabs'}</span></div>`; }).join('')}</div>
    <div class="csa-rules">📞 Call +${CS_PTS.call} · answered +${CS_PTS.answered} · first call in 5 min <b>2×</b>${power?` · ⚡ ${csHour(power.ph.start)}–${csHour(power.ph.end)} <b>2×</b>`:''} · ✅ converted +${CS_PTS.won} · 🛠️ task +${CS_PTS.task} (+${CS_PTS.taskOnTime} on time) · 🚀 project +${CS_PTS.project}</div>
    ${hall.length>1?`<div class="csa-hall">🏛 ${hall.map(x=>`${esc(csName(x.w.m))} <small>${csWeekStart(x.o).toLocaleDateString('en-GB',{day:'numeric',month:'short'})}</small>`).join(' · ')}</div>`:''}
  </details>`;
  html+=`</div></div>`;
  el.innerHTML=html;
  el.style.display='';
}

// Called by dashboard.html moveTaskStatus after a task is marked done.
function csAfterTask(t){
  _csCache=null;
  if(!t || t.status!=='done' || !myEmail || !sameEmail(t.assignee_email,myEmail)) return;
  const pts=csTaskPts({due:t.due_date||'', priority:t.priority||'', doneMs:Date.now()});
  showToast(`🛠️ Task done! +${pts} pts`,'ok');
}
