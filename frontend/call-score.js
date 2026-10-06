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
const CS_PTS={call:3, answered:15, fast:15, callback:10, won:50, wonHot:25, wonBig:25, hotMissed:-10};
const CS_DEFAULT_TARGETS={calls:30, won:3};
const CS_FAST_MS=5*60000;           // first call within 5 min of the lead arriving
const CS_CALLBACK_MS=3*3600000;     // a "Callback Requested" followed up within 3h counts as on time
const CS_HOT_MISSED_MS=24*3600000;  // Hot lead still never called after 24h

function csDayKey(ms){ const d=new Date(ms); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function csToday(){ return csDayKey(Date.now()); }
function csCallMs(c){ const t=Date.parse(c.at||c.date||''); return isFinite(t)?t:null; }
function csCalls(l){ let c=[]; try{ c=JSON.parse(l.CallLog||'[]'); }catch(e){} return Array.isArray(c)?c.slice().reverse():[]; } // oldest first
function csIsSpam(l){ return l.HandoverOutcome==='Spam'; }
function csIsOpen(l){ return !isWonLead(l) && !isLostLead(l) && l.OptOut!=='Yes' && !csIsSpam(l); }
function csEmailKey(e){ return String(e||'').trim().toLowerCase(); }

/* ── Targets ── */
function csTargetsConfig(){
  let bc={}; try{ bc=JSON.parse(clientRecord?.bot_config||'{}'); }catch(e){}
  const t=bc.call_targets||{};
  return {default:{...CS_DEFAULT_TARGETS, ...(t.default||{})}, users:t.users||{}};
}
function csTargetsFor(email){
  const cfg=csTargetsConfig();
  return {...cfg.default, ...(cfg.users[csEmailKey(email)]||{})};
}

/* ── Event stream: every point-earning action, attributed to one user ── */
let _csCache=null;
function csEvents(){
  const sig=allLeads.length+'|'+allLeads.reduce((s,l)=>s+(l.CallLog||'').length+(l.Stage||'').length+(l.ClosedAt||'').length,0);
  if(_csCache && _csCache.sig===sig) return _csCache.events;
  const events=[];
  const wonValues=allLeads.filter(l=>isWonLead(l)&&Number(l.DealValue)>0).map(l=>Number(l.DealValue)).sort((a,b)=>a-b);
  const medianWon=wonValues.length?wonValues[Math.floor(wonValues.length/2)]:0;
  for(const l of allLeads){
    const calls=csCalls(l);
    const leadMs=l.Date?Date.parse(l.Date):NaN;
    calls.forEach((c,i)=>{
      const ms=csCallMs(c); if(ms==null||!c.by) return;
      const answered=c.outcome==='Answered';
      events.push({by:csEmailKey(c.by), ms, kind:answered?'answered':'call', pts:answered?CS_PTS.answered:CS_PTS.call, leadId:l.Id, outcome:c.outcome||'', duration:Number(c.duration)||0, ordinal:i+1});
      if(i===0 && isFinite(leadMs) && ms-leadMs>=0 && ms-leadMs<=CS_FAST_MS) events.push({by:csEmailKey(c.by), ms, kind:'fast', pts:CS_PTS.fast, leadId:l.Id});
      const prev=calls[i-1], prevMs=prev?csCallMs(prev):null;
      if(prev && /callback/i.test(prev.outcome||'') && prevMs!=null && ms-prevMs<=CS_CALLBACK_MS) events.push({by:csEmailKey(c.by), ms, kind:'callback', pts:CS_PTS.callback, leadId:l.Id});
    });
    if(isWonLead(l) && l.Owner && l.ClosedAt){
      const ms=Date.parse(l.ClosedAt);
      if(isFinite(ms)){
        let pts=CS_PTS.won;
        if(l.Score==='Hot') pts+=CS_PTS.wonHot;
        if(medianWon>0 && Number(l.DealValue)>=medianWon) pts+=CS_PTS.wonBig;
        events.push({by:csEmailKey(l.Owner), ms, kind:'won', pts, leadId:l.Id, value:Number(l.DealValue)||0});
      }
    }
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
  return {won, callNow:CS_PTS.answered+(fresh?CS_PTS.fast:0)};
}

/* ── Per-user daily rollup ── */
function csDaily(email){
  const me=csEmailKey(email), byDay={};
  for(const e of csEvents()){
    if(e.by!==me) continue;
    const d=csDayKey(e.ms);
    const r=byDay[d]||(byDay[d]={calls:0, answered:0, won:0, pts:0});
    if(e.kind==='call'||e.kind==='answered') r.calls++;
    if(e.kind==='answered') r.answered++;
    if(e.kind==='won') r.won++;
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
  const t=csDaily(email)[csToday()]||{calls:0, answered:0, won:0, pts:0};
  const missed=csHotMissed(email).length;
  return {...t, pts:t.pts+missed*CS_PTS.hotMissed, missed, target:csTargetsFor(email), streak:csStreak(email)};
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
    <span title="Points today: answered call +${CS_PTS.answered}, call +${CS_PTS.call}, first call in 5 min +${CS_PTS.fast}, callback on time +${CS_PTS.callback}, converted +${CS_PTS.won}${s.missed?`, ${s.missed} Hot lead(s) uncalled 24h+ ${CS_PTS.hotMissed} each`:''}">⭐ <strong>${s.pts}</strong> pts</span>
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

/* ── Celebration toasts after a call / a conversion ── */
function csAfterCall(leadId){
  _csCache=null;
  if(!myEmail) return;
  const l=allLeads.find(x=>x.Id===leadId); if(!l) return;
  const mine=csEvents().filter(e=>e.leadId===leadId && e.by===csEmailKey(myEmail) && Date.now()-e.ms<120000 && e.kind!=='won');
  const pts=mine.reduce((s,e)=>s+e.pts,0);
  const s=csTodaySummary(myEmail);
  if(s.calls===s.target.calls) showToast(`🎯 Daily call target hit! +${pts} pts · 🔥 ${s.streak}-day streak`,'ok');
  else if(pts) showToast(`+${pts} pts · 📞 ${s.calls}/${s.target.calls} calls today`,'ok');
  if(typeof renderLeadsMomentumStrip==='function') renderLeadsMomentumStrip();
}
function csAfterWon(leadId){
  _csCache=null;
  const ev=csEvents().find(e=>e.leadId===leadId && e.kind==='won');
  const s=myEmail?csTodaySummary(myEmail):null;
  showToast(`🎉 Converted! +${ev?.pts||CS_PTS.won} pts${s?` · ✅ ${s.won}/${s.target.won} today`:''}`,'ok');
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
    pts:evs.reduce((s,e)=>s+e.pts,0), outcomes, workDays:work.length, daysMet, target, streak:csStreak(email), today:csTodaySummary(email)};
}
function csFunnel(email, range){
  const owned=allLeads.filter(l=>sameEmail(l.Owner,email) && !csIsSpam(l) && l.Date && Date.parse(l.Date)>=range.from && Date.parse(l.Date)<=range.to);
  const called=owned.filter(l=>csCalls(l).length);
  const connected=called.filter(l=>csCalls(l).some(c=>c.outcome==='Answered'));
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
  html+=head('🏅 Scorecard','Connected = calls marked Answered. Conversion = leads converted ÷ leads called. Speed = median minutes from a lead arriving to its first call. Callback on time = followed up within 3h.');
  html+=`<div class="card"><div style="overflow-x:auto"><table class="leads-tbl" style="width:100%;min-width:1100px">
    <thead><tr><th>Agent</th><th>Today</th><th>Calls</th><th>Connected</th><th>Avg talk</th><th>Converted</th><th>Conversion</th><th>1st-call speed</th><th>Callbacks on time</th><th>Points</th><th>Streak</th><th>Target hit-rate</th></tr></thead>
    <tbody>${rows.map(({m,s})=>`<tr>
      <td>${csWho(m)}</td>
      <td style="white-space:nowrap">📞 ${s.today.calls}/${s.today.target.calls}<br>✅ ${s.today.won}/${s.today.target.won}</td>
      <td>${s.calls}</td><td>${csPct(s.answered,s.calls)}</td><td>${s.avgTalk!=null?s.avgTalk+' min':'—'}</td>
      <td><b>${s.won}</b></td><td>${csPct(s.won,s.leadsCalled)}</td>
      <td>${s.speed==null?'—':s.speed<60?Math.round(s.speed)+' min':(s.speed/60).toFixed(1)+' h'}</td>
      <td>${s.cbDue?`${csPct(s.cbOnTime,s.cbDue)} <span style="color:var(--muted);font-size:11px">(${s.cbOnTime}/${s.cbDue})</span>`:'—'}</td>
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
    html+=head('🎯 Daily targets','Calls and conversions each person should hit per day. Blank = team default.');
    html+=`<div class="card"><div style="overflow-x:auto"><table class="cs-targets" style="width:100%;min-width:420px"><thead><tr><th style="text-align:left">Who</th><th>📞 Calls / day</th><th>✅ Converted / day</th></tr></thead><tbody>
      <tr><td><b>Team default</b></td><td><input type="number" min="0" class="form-input" id="csTgtDefCalls" value="${cfg.default.calls}"></td><td><input type="number" min="0" class="form-input" id="csTgtDefWon" value="${cfg.default.won}"></td></tr>
      ${getTeamMembers().map(m=>{ const u=cfg.users[csEmailKey(m.email)]||{}; return `<tr data-email="${esc(csEmailKey(m.email))}"><td>${esc(m.name)}</td><td><input type="number" min="0" class="form-input cs-tgt-calls" placeholder="${cfg.default.calls}" value="${u.calls??''}"></td><td><input type="number" min="0" class="form-input cs-tgt-won" placeholder="${cfg.default.won}" value="${u.won??''}"></td></tr>`; }).join('')}
    </tbody></table></div><div style="margin-top:10px;display:flex;gap:10px;align-items:center"><button class="btn btn-primary btn-sm" onclick="csSaveTargets(this)">Save targets</button><span class="save-msg" id="csTgtMsg"></span></div></div>`;
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
function csInitials(name){ return String(name||'?').split(/[\s@.]+/).filter(Boolean).slice(0,2).map(w=>w[0].toUpperCase()).join('')||'?'; }
function csEndsIn(){
  const ms=csWeekStart(1).getTime()-Date.now(); const d=Math.floor(ms/86400000), h=Math.floor(ms%86400000/3600000);
  return d?`${d}d ${h}h`:`${h}h ${Math.floor(ms%3600000/60000)}m`;
}
function csRenderHomeArena(){
  const el=$id('homeArena'); if(!el) return;
  _csCache=null;
  const members=getTeamMembers();
  if(!members.length||!myEmail){ el.style.display='none'; return; }
  const board=csWeekBoard(0), badges=csWeekBadges(board), owner=isAccountOwner();
  const meIdx=board.findIndex(r=>sameEmail(r.m.email,myEmail)), me=board[meIdx];
  const solo=members.length<2;
  const last=csWeekWinner(-1);
  const hall=[-1,-2,-3,-4].map(o=>({o, w:csWeekWinner(o)})).filter(x=>x.w);
  const badgeChips=list=>(list||[]).map(b=>`<span class="cs-badge" title="${esc(b.name)} — ${esc(b.why)}">${b.icon}</span>`).join('');
  const isMe=r=>sameEmail(r.m.email,myEmail);

  let html=`<div class="section-card cs-arena">
    <div class="cs-arena-head">
      <div><div class="section-title" style="margin-bottom:2px">🏆 Weekly Arena</div><div class="s-note">Points from calls &amp; conversions · week ends in <b>${csEndsIn()}</b></div></div>
      <button class="btn-ghost" style="font-size:12px" onclick="navigate('reports');setTimeout(()=>renderReportsSubPage('calls'),0)">Full report →</button>
    </div>`;
  if(last && !solo) html+=`<div class="cs-champ">👑 Last week's champion: <b>${esc(last.m.name)}</b> · ${last.s.pts} pts · ${last.s.won} converted${isMe(last)?' — that\'s you! 🎉':''}</div>`;

  if(solo){
    html+=`<div class="cs-solo"><div class="cs-me-pts">${me?.s.pts||0}<span> pts this week</span></div>
      <div class="s-note">📞 ${me?.s.calls||0} calls · ✅ ${me?.s.won||0} converted · 🔥 ${me?.s.streak||0}-day streak</div>
      ${badgeChips(badges[csEmailKey(myEmail)])?`<div style="margin-top:6px">${badgeChips(badges[csEmailKey(myEmail)])}</div>`:''}
      <div class="s-note" style="margin-top:8px">Add teammates in Settings → User Management to compete for the weekly crown.</div></div>`;
  }else{
    // Podium — 2nd, 1st, 3rd
    const top=board.slice(0,3);
    const slot=(r,place)=>r?`<div class="cs-pod cs-pod-${place}${isMe(r)?' me':''}">
        <div class="cs-pod-medal">${['🥇','🥈','🥉'][place-1]}</div>
        <div class="cs-pod-av">${esc(csInitials(r.m.name))}</div>
        <div class="cs-pod-name">${esc(r.m.name)}${isMe(r)?' (you)':''}</div>
        <div class="cs-pod-pts">${r.s.pts} pts</div>
        <div class="cs-pod-sub">✅ ${r.s.won} · 📞 ${r.s.calls}</div>
        <div>${badgeChips(badges[csEmailKey(r.m.email)])}</div>
        <div class="cs-pod-step">${place}</div>
      </div>`:'<div class="cs-pod cs-pod-empty"></div>';
    html+=`<div class="cs-podium">${slot(top[1],2)}${slot(top[0],1)}${slot(top[2],3)}</div>`;

    if(me){
      const above=meIdx>0?board[meIdx-1]:null;
      const msg=meIdx===0
        ? (me.s.pts>0?(board[1]?`You're leading by <b>${me.s.pts-board[1].s.pts} pts</b> — keep it up!`:'You\'re leading!'):'Nobody has scored yet — first call takes the lead!')
        : `You're <b>#${meIdx+1}</b> of ${board.length} · <b>${above.s.pts-me.s.pts+1} pts</b> to pass ${esc(above.m.name)} (≈ ${Math.ceil((above.s.pts-me.s.pts+1)/CS_PTS.answered)} answered calls or ${Math.ceil((above.s.pts-me.s.pts+1)/CS_PTS.won)} conversion${Math.ceil((above.s.pts-me.s.pts+1)/CS_PTS.won)>1?'s':''})`;
      html+=`<div class="cs-me-row"><span>⭐ <b>${me.s.pts}</b> pts this week</span><span>🔥 ${me.s.streak}-day streak</span><span>${msg}</span></div>`;
    }
    // Full ranking for the owner; staff see the podium + their own line
    const rest=owner?board.slice(3):[];
    if(rest.length) html+=`<div class="cs-rest">${rest.map((r,i)=>`<div class="agent-row${isMe(r)?' cs-me':''}"><div class="agent-rank">#${i+4}</div><div class="agent-name">${esc(r.m.name)} ${badgeChips(badges[csEmailKey(r.m.email)])}</div><div class="agent-count">${r.s.pts} pts</div></div>`).join('')}</div>`;
  }

  // Badges legend — who holds each this week
  const holders=CS_BADGES.map(b=>{ const who=board.find(r=>(badges[csEmailKey(r.m.email)]||[]).includes(b)); return `<span class="cs-legend${who?'':' off'}" title="${esc(b.why)}">${b.icon} ${esc(b.name)}${who&&!solo?`: <b>${esc(who.m.name)}</b>`:''}</span>`; }).join('');
  html+=`<div class="cs-legend-row">${holders}</div>`;
  if(hall.length>1 && !solo) html+=`<div class="cs-hall">🏛 Hall of Fame: ${hall.map(x=>`<span title="Week of ${csWeekStart(x.o).toLocaleDateString('en-GB',{day:'numeric',month:'short'})}">${esc(x.w.m.name)} <small>${csWeekStart(x.o).toLocaleDateString('en-GB',{day:'numeric',month:'short'})}</small></span>`).join(' · ')}</div>`;
  html+=`</div>`;
  el.innerHTML=html;
  el.style.display='';
}
