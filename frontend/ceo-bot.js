// CEO Bot tab for projects.html (cloudflare-worker/ceo-bot.js). Only appears when the super-admin
// enabled CEO Bot for this client AND the signed-in user is the account owner — GET /ceo/status
// decides; for everyone else this file adds nothing to the page. The Worker enforces the same
// rules on every /ceo/* route, so hiding the tab is a convenience, not the security boundary.
// Uses projects.html's own globals: pmFetch, $id, esc, escAttr, allProjects, setView.
(function(){
'use strict';
const S={ready:false, tab:'overview', cfg:null, channel:null, team:[], projects:[], threads:[], thread:null, messages:[],
  actions:[], report:null, standups:[], chat:[], busy:false};
const DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const PLAYBOOKS=[
  ['brief','☀️ Morning brief to you','Open / due / overdue / blocked, workload tips'],
  ['reminders','📋 Staff daily task list','Each person gets their due & overdue tasks'],
  ['escalation','⏰ Overdue nudges → escalation','Staff first (with buttons), then you'],
  ['standup','🗣️ Daily standup','Yesterday / today / blockers, collected on WhatsApp'],
  ['wrap','🌙 Evening day wrap','Done today, blockers, delays, missing standups'],
  ['weekly','📊 Weekly CEO report','Team scorecard, on-time %, top performer'],
  ['recognition','👏 Recognition','Thanks staff who closed 3+ tasks with nothing overdue'],
];
const AUTONOMY=[
  ['observe','Observe — reports only, never changes tasks'],
  ['suggest','Suggest — every change waits for your OK'],
  ['auto_safe','Auto-safe — status/date/priority & staff messages run; reassign & new tasks wait'],
  ['full','Full auto — runs every change, logs it'],
];

const css=`
#viewCeo .ceo-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px}
#viewCeo .ceo-title{font-family:var(--disp);font-size:18px;font-weight:700}
#viewCeo .ceo-pill{font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;background:#F1F5F9;color:#475569}
#viewCeo .ceo-pill.on{background:#E1F3EA;color:#15803D}#viewCeo .ceo-pill.paused{background:#FEF3E2;color:#B45309}
#viewCeo .ceo-tabs{display:flex;gap:6px;overflow-x:auto;margin-bottom:16px;scrollbar-width:none}
#viewCeo .ceo-tab{border:1px solid var(--line);background:var(--card);border-radius:20px;padding:7px 14px;font-size:12.5px;font-weight:700;color:var(--muted);white-space:nowrap}
#viewCeo .ceo-tab.active{background:var(--accent);border-color:var(--accent);color:#fff}
#viewCeo .ceo-card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:16px;margin-bottom:14px}
#viewCeo .ceo-card h4{font-family:var(--disp);font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin-bottom:10px}
#viewCeo .ceo-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
#viewCeo .ceo-check{display:flex;align-items:center;gap:8px;font-size:13px;padding:5px 0}
#viewCeo .ceo-row{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--line);font-size:13px}
#viewCeo .ceo-row:last-child{border-bottom:none}
#viewCeo .ceo-row .grow{flex:1;min-width:0}
#viewCeo .ceo-row small{display:block;color:var(--muted);font-size:11.5px}
#viewCeo .ceo-chatlog{max-height:340px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;margin-bottom:10px}
#viewCeo .ceo-bubble{max-width:85%;padding:9px 12px;border-radius:12px;font-size:13px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word}
#viewCeo .ceo-bubble.in{align-self:flex-end;background:var(--accent-soft);color:var(--accent-ink)}
#viewCeo .ceo-bubble.out{align-self:flex-start;background:var(--bg);border:1px solid var(--line)}
#viewCeo .ceo-bubble .meta{display:block;font-size:10.5px;color:var(--muted);margin-top:4px}
#viewCeo .ceo-bubble.skipped,#viewCeo .ceo-bubble.failed{opacity:.6;border-style:dashed}
#viewCeo .ceo-threads{display:grid;grid-template-columns:260px 1fr;gap:14px}
#viewCeo .ceo-thread{padding:10px 12px;border-radius:10px;cursor:pointer;border:1px solid transparent}
#viewCeo .ceo-thread:hover{background:var(--bg)}#viewCeo .ceo-thread.active{background:var(--accent-soft);border-color:#BCE4DF}
#viewCeo .ceo-thread b{display:block;font-size:13px}#viewCeo .ceo-thread span{display:block;font-size:11.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#viewCeo .ceo-inline{display:flex;gap:8px;align-items:center}
#viewCeo .ceo-inline input{flex:1;border:1px solid var(--line);border-radius:8px;padding:9px 11px;background:var(--bg)}
#viewCeo .ceo-copy{font-family:var(--mono);font-size:11.5px;background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:7px 9px;word-break:break-all}
#viewCeo .ceo-days{display:flex;gap:4px;flex-wrap:wrap}
#viewCeo .ceo-days label{display:flex;align-items:center;gap:3px;font-size:12px;border:1px solid var(--line);border-radius:7px;padding:4px 7px}
#viewCeo .ceo-days input{width:auto}
#viewCeo .ceo-score{font-family:var(--mono);font-weight:700}
#viewCeo .ceo-note{font-size:12px;color:var(--muted);line-height:1.5}
#viewCeo .ceo-team-tbl input[type=text]{width:100%;border:1px solid var(--line);border-radius:7px;padding:6px 8px;background:var(--bg)}
@media(max-width:760px){#viewCeo .ceo-grid,#viewCeo .ceo-threads{grid-template-columns:1fr}#viewCeo .ceo-bubble{max-width:95%}}
`;

async function api(path, opts){ return pmFetch(path, opts||{method:'GET'}); }
const post=(path, body)=>api(path, {method:'POST', body:JSON.stringify(body||{})});
function toast(msg, bad){ const el=$id('ceoMsg'); if(!el) return; el.textContent=msg; el.style.color=bad?'#DC2626':'var(--accent-ink)'; clearTimeout(toast._t); toast._t=setTimeout(()=>{ el.textContent=''; }, 5000); }
function when(iso){ if(!iso) return ''; const d=new Date(iso); return d.toLocaleString(undefined,{month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'}); }
function nameOf(email){ return (S.team.find(m=>m.email===email)||{}).name||email; }

// ── Init: only owners of enabled accounts get the tab ──
window.ceoInit=async function(){
  let st; try{ st=await api('/ceo/status'); }catch(e){ return; }
  if(!st || !st.enabled || !st.admin) return;
  S.ready=true;
  const style=document.createElement('style'); style.textContent=css; document.head.appendChild(style);
  const tabs=$id('viewTabs');
  if(tabs && !$id('ceoViewTab')){
    const b=document.createElement('button'); b.className='viewtab'; b.id='ceoViewTab'; b.dataset.view='ceo'; b.textContent='🤖 CEO Bot';
    b.onclick=()=>setView('ceo'); tabs.appendChild(b);
  }
  const more=$id('projMore');
  if(more && !$id('ceoMoreBtn')){
    const b=document.createElement('button'); b.className='btn sm mobile-more-action'; b.id='ceoMoreBtn'; b.textContent='🤖 CEO Bot';
    b.onclick=()=>{ closeProjMore(); setView('ceo'); }; more.insertBefore(b, more.firstChild);
  }
  if(new URLSearchParams(location.search).get('view')==='ceo') setView('ceo');
};

window.ceoRender=async function(){
  const root=$id('viewCeo'); if(!root) return;
  if(!S.ready){ root.innerHTML='<div class="empty-state"><div class="empty-icon">🔒</div>CEO Bot is not enabled for this account.</div>'; return; }
  if(!S.cfg){ root.innerHTML='<div class="empty-state">Loading CEO Bot…</div>'; await loadConfig(); }
  draw();
  if(S.tab==='chats') loadThreads();
  if(S.tab==='approvals') loadActions();
  if(S.tab==='team') loadTeamReport();
  if(S.tab==='overview') loadActions(true);
};
async function loadConfig(){
  try{ const d=await api('/ceo/config'); S.cfg=d.config; S.channel=d.channel; S.team=d.team||[]; S.projects=d.projects||[]; }
  catch(e){ $id('viewCeo').innerHTML=`<div class="empty-state">${esc(e.message)}</div>`; throw e; }
}
window.ceoTab=function(t){ S.tab=t; window.ceoRender(); };

function draw(){
  const c=S.cfg;
  const status=!c.active?['','Off']:c.paused?['paused','Paused']:['on','Active'];
  const tabs=[['overview','Overview'],['chats','💬 Chats'],['approvals','📝 Approvals'],['team','👥 Team report'],['settings','⚙️ Settings']];
  $id('viewCeo').innerHTML=`
    <div class="ceo-head"><div class="ceo-title">🤖 ${esc(c.persona.name)}</div><span class="ceo-pill ${status[0]}">${status[1]}</span>
      <span class="ceo-note">Staff tasks only · own WhatsApp number · visible to you only</span><span class="save-msg" id="ceoMsg" style="margin-left:auto"></span></div>
    <div class="ceo-tabs">${tabs.map(([k,l])=>`<button class="ceo-tab ${S.tab===k?'active':''}" onclick="ceoTab('${k}')">${l}</button>`).join('')}</div>
    <div id="ceoBody">${({overview:overviewHtml, chats:chatsHtml, approvals:approvalsHtml, team:teamHtml, settings:settingsHtml}[S.tab]||overviewHtml)()}</div>`;
  if(S.tab==='overview'){ const log=$id('ceoChatLog'); if(log) log.scrollTop=log.scrollHeight; }
}

// ── Overview ──
function overviewHtml(){
  const c=S.cfg, ch=S.channel, me=S.team.find(m=>m.isAdmin)||{};
  const steps=[
    [ch.connected, `CEO WhatsApp number connected${ch.display_phone?` (${esc(ch.display_phone)})`:''}`, 'settings'],
    [!!me.phone, 'Your WhatsApp number added (Settings → Team)', 'settings'],
    [S.team.filter(m=>!m.isAdmin&&m.phone).length>0, `Staff WhatsApp numbers (${S.team.filter(m=>!m.isAdmin&&m.phone).length}/${S.team.filter(m=>!m.isAdmin).length})`, 'settings'],
    [c.active, 'CEO Bot switched on', 'settings'],
  ];
  const pending=S.actions.filter(a=>a.status==='pending').length;
  return `<div class="ceo-grid">
    <div>
      <div class="ceo-card"><h4>Setup</h4>${steps.map(([ok,l,t])=>`<div class="ceo-check">${ok?'✅':'⬜'} <span style="flex:1">${l}</span>${ok?'':`<button class="btn sm" onclick="ceoTab('${t}')">Fix</button>`}</div>`).join('')}
        <div class="ceo-note" style="margin-top:8px">WhatsApp only lets the bot send free-form messages within 24 hours of someone writing to it. Message the CEO number once a day (or set an approved template in Settings) so briefs always arrive.</div></div>
      <div class="ceo-card"><h4>Send now</h4><div class="ceo-inline" style="flex-wrap:wrap">
        <button class="btn sm" onclick="ceoRunNow('brief')">☀️ Brief</button><button class="btn sm" onclick="ceoRunNow('wrap')">🌙 Day wrap</button>
        <button class="btn sm" onclick="ceoRunNow('weekly')">📊 Weekly report</button><button class="btn sm" onclick="ceoTest()">👋 Test message</button></div>
        ${pending?`<div class="ceo-check" style="margin-top:10px">📝 <b>${pending}</b>&nbsp;change${pending>1?'s':''} waiting for your OK <button class="btn sm" style="margin-left:auto" onclick="ceoTab('approvals')">Review</button></div>`:''}
        <div style="margin-top:10px"><button class="btn sm ${c.paused?'primary':''}" onclick="ceoSetPaused(${!c.paused})">${c.paused?'▶️ Resume all messages':'⏸️ Pause all messages'}</button></div></div>
    </div>
    <div class="ceo-card"><h4>Ask ${esc(c.persona.name)}</h4>
      <div class="ceo-chatlog" id="ceoChatLog">${S.chat.length?S.chat.map(m=>`<div class="ceo-bubble ${m.dir}">${esc(m.text)}</div>`).join(''):
        `<div class="ceo-note">Same as messaging the CEO number from your phone. Try: “what's overdue?”, “how is Rahul doing this week?”, “move #12 to Friday”, “BRIEF”.</div>`}</div>
      <div class="ceo-inline"><input id="ceoChatInput" placeholder="Ask or instruct…" onkeydown="if(event.key==='Enter')ceoSendChat()"><button class="btn primary sm" onclick="ceoSendChat()" ${S.busy?'disabled':''}>Send</button></div>
    </div></div>`;
}
window.ceoSendChat=async function(){
  const inp=$id('ceoChatInput'); const text=(inp?.value||'').trim(); if(!text||S.busy) return;
  S.chat.push({dir:'in', text}); S.busy=true; draw();
  try{ const d=await post('/ceo/chat', {text}); S.chat.push({dir:'out', text:d.reply}); }
  catch(e){ S.chat.push({dir:'out', text:'⚠️ '+e.message}); }
  S.busy=false; S.actions=[]; await loadActions(true); draw(); $id('ceoChatInput')?.focus();
};
window.ceoRunNow=async function(kind){
  try{ const d=await post('/ceo/run', {kind}); S.chat.push({dir:'out', text:d.text}); draw();
    toast(d.ok?'Sent to your WhatsApp ✅':`Shown here — not sent on WhatsApp (${d.error==='window'?'outside 24h window: message the CEO number first':d.error})`, !d.ok); }
  catch(e){ toast(e.message, true); }
};
window.ceoTest=async function(){
  try{ const d=await post('/ceo/test'); toast(d.ok?'Test message sent ✅':d.error, !d.ok); }catch(e){ toast(e.message, true); }
};
window.ceoSetPaused=async function(p){ await saveConfig({paused:p}, p?'Paused — no messages will be sent':'Resumed'); };

// ── Chats (owner only) ──
async function loadThreads(){
  try{ S.threads=(await api('/ceo/threads')).threads||[]; }catch(e){ S.threads=[]; }
  if(S.thread) await loadMessages(S.thread, true); else if(S.tab==='chats') $id('ceoBody').innerHTML=chatsHtml();
}
async function loadMessages(phone, silent){
  S.thread=phone;
  try{ S.messages=(await api('/ceo/messages?phone='+encodeURIComponent(phone))).messages||[]; }catch(e){ S.messages=[]; }
  if(S.tab==='chats'){ $id('ceoBody').innerHTML=chatsHtml(); const l=$id('ceoThreadLog'); if(l) l.scrollTop=l.scrollHeight; }
}
window.ceoOpenThread=phone=>loadMessages(phone);
function chatsHtml(){
  const list=S.threads.length?S.threads.map(t=>`<div class="ceo-thread ${S.thread===t.phone?'active':''}" onclick="ceoOpenThread('${escAttr(t.phone)}')">
      <b>${t.party_role==='admin'||t.phone==='console'?'👤 ':t.party_role==='staff'?'🙋 ':'❔ '}${esc(t.name)}</b><span>${t.direction==='in'?'↩ ':''}${esc(String(t.body).slice(0,60))}</span><span>${when(t.created_at)} · ${t.total} msgs</span></div>`).join('')
    :'<div class="ceo-note">No conversations yet.</div>';
  const log=S.thread?(S.messages.length?S.messages.map(m=>`<div class="ceo-bubble ${m.direction==='in'?'in':'out'} ${m.status==='skipped'||m.status==='failed'?m.status:''}">${esc(m.body)}<span class="meta">${when(m.created_at)} · ${esc(m.kind)}${m.status&&m.status!=='sent'&&m.status!=='received'?` · ${esc(m.status)}${m.detail?': '+esc(m.detail):''}`:''}</span></div>`).join(''):'<div class="ceo-note">No messages.</div>')
    :'<div class="ceo-note">Pick a conversation. Every message on the CEO number is here — the bot\'s chats with you and with each staff member. Only you can see this.</div>';
  return `<div class="ceo-threads"><div class="ceo-card" style="padding:8px;max-height:560px;overflow-y:auto">${list}</div>
    <div class="ceo-card"><div class="ceo-chatlog" id="ceoThreadLog" style="max-height:520px">${log}</div>${S.thread?`<button class="btn sm" onclick="ceoOpenThread('${escAttr(S.thread)}')">↻ Refresh</button>`:''}</div></div>`;
}

// ── Approvals ──
async function loadActions(quiet){
  try{ S.actions=(await api('/ceo/actions')).actions||[]; }catch(e){ S.actions=[]; }
  // On Overview only redraw when there's something pending to show, so a typed question isn't wiped.
  if(S.tab==='approvals' || (S.tab==='overview' && (!quiet || S.actions.some(a=>a.status==='pending')))) draw();
}
function approvalsHtml(){
  const pend=S.actions.filter(a=>a.status==='pending'), done=S.actions.filter(a=>a.status!=='pending').slice(0,40);
  const badge=s=>({executed:'st-done', rejected:'st-blocked', failed:'st-blocked'}[s]||'st-todo');
  return `<div class="ceo-card"><h4>Waiting for your OK (${pend.length})</h4>${pend.length?pend.map(a=>`<div class="ceo-row"><div class="grow"><b>A${a.id}</b> ${esc(a.summary)}<small>${when(a.created_at)} · via ${esc(a.requested_via)}</small></div>
      <button class="btn sm primary" onclick="ceoDecide(${a.id},'approve')">Approve</button><button class="btn sm" onclick="ceoDecide(${a.id},'reject')">Reject</button></div>`).join('')
      :'<div class="ceo-note">Nothing pending. You can also reply APPROVE 12 / REJECT 12 on WhatsApp.</div>'}</div>
    <div class="ceo-card"><h4>History</h4>${done.length?done.map(a=>`<div class="ceo-row"><div class="grow">A${a.id} ${esc(a.summary)}<small>${when(a.decided_at||a.created_at)}${a.result?' · '+esc(a.result):''}</small></div><span class="badge ${badge(a.status)}">${esc(a.status)}</span></div>`).join(''):'<div class="ceo-note">No changes yet.</div>'}</div>`;
}
window.ceoDecide=async function(id, decision){
  try{ const d=await post('/ceo/actions/decide', {id, decision}); toast(d.message); }catch(e){ toast(e.message, true); }
  await loadActions();
};

// ── Team report (same scorecard as Reports → Team in the dashboard) ──
async function loadTeamReport(days){
  const d=days||S.reportDays||30; S.reportDays=d;
  try{ S.report=await api('/ceo/team-report?days='+d); S.standups=(await api('/ceo/standups')).standups||[]; }catch(e){ S.report={error:e.message}; }
  if(S.tab==='team') $id('ceoBody').innerHTML=teamHtml();
}
window.ceoReportDays=d=>loadTeamReport(Number(d));
function teamHtml(){
  const r=S.report;
  if(!r) return '<div class="ceo-note">Loading…</div>';
  if(r.error) return `<div class="ceo-note">${esc(r.error)}</div>`;
  const t=r.totals;
  const stat=(v,l,red)=>`<div class="stat"><div class="stat-val" ${red&&v?'style="color:#DC2626"':''}>${v===null||v===undefined?'—':v}</div><div class="stat-lbl">${l}</div></div>`;
  return `<div class="ceo-inline" style="margin-bottom:12px"><span class="ceo-note">Period</span><select onchange="ceoReportDays(this.value)" style="border:1px solid var(--line);border-radius:8px;padding:6px 10px;background:var(--card)">
      ${[7,30,90].map(d=>`<option value="${d}" ${d===r.days?'selected':''}>Last ${d} days</option>`).join('')}</select></div>
    <div class="stats">${stat(t.done,'Completed')}${stat(t.on_time_pct===null?null:t.on_time_pct+'%','On time')}${stat(t.overdue,'Overdue now',1)}${stat(t.blocked,'Blocked',1)}${stat(t.created,'Created')}${stat(t.hours,'Hours logged')}</div>
    <div class="tbl-wrap"><table><thead><tr><th>Member</th><th>Score</th><th>Done</th><th>On time</th><th>Open</th><th>Overdue</th><th>Blocked</th><th>Standups</th><th>Bot updates</th><th>Nudges</th><th>Hours</th></tr></thead>
      <tbody>${r.members.map(m=>`<tr><td><b>${esc(m.name)}</b>${m.is_admin?' (you)':''}${m.has_whatsapp?'':' <span title="No WhatsApp number">📵</span>'}</td>
        <td data-label="Score" class="ceo-score">${m.score===null?'—':m.score}</td><td data-label="Done">${m.done}</td><td data-label="On time">${m.on_time_pct===null?'—':m.on_time_pct+'%'}</td>
        <td data-label="Open">${m.open}</td><td data-label="Overdue" ${m.overdue?'style="color:#DC2626;font-weight:700"':''}>${m.overdue}</td><td data-label="Blocked">${m.blocked}</td>
        <td data-label="Standups">${m.standups_asked?`${m.standups_answered}/${m.standups_asked}`:'—'}</td><td data-label="Bot updates">${m.bot_updates}</td><td data-label="Nudges">${m.nudges}</td><td data-label="Hours">${m.hours}</td></tr>`).join('')}</tbody></table></div>
    <div class="ceo-note" style="margin:8px 0 16px">Score = 40% on-time rate + 40% completion (done vs. done + overdue now) + 20% standup answers, over whatever has data.</div>
    <div class="ceo-card"><h4>Standups — last 14 days</h4>${S.standups.length?S.standups.map(s=>`<div class="ceo-row"><div class="grow"><b>${esc(s.name)}</b> · ${esc(s.standup_date)}<small>${s.answered_at?esc(s.answer):'<i>No answer</i>'}</small></div></div>`).join(''):'<div class="ceo-note">No standups yet — switch the Daily standup playbook on in Settings.</div>'}</div>`;
}

// ── Settings ──
function settingsHtml(){
  const c=S.cfg, ch=S.channel, s=c.schedule;
  const fld=(label, html, hint)=>`<div class="field"><label>${label}</label>${html}${hint?`<div class="field-hint">${hint}</div>`:''}</div>`;
  const time=(id,v)=>`<input type="time" id="${id}" value="${escAttr(v)}">`;
  const num=(id,v,min,max)=>`<input type="number" id="${id}" value="${escAttr(v)}" min="${min}" max="${max}">`;
  const tz=s.tz_offset_min, tzStr=`${tz<0?'-':'+'}${String(Math.floor(Math.abs(tz)/60)).padStart(2,'0')}:${String(Math.abs(tz)%60).padStart(2,'0')}`;
  return `<div class="ceo-grid"><div>
    <div class="ceo-card"><h4>Master switch</h4>
      <label class="field-check"><input type="checkbox" id="ceoActive" ${c.active?'checked':''}> CEO Bot is on (sends scheduled messages)</label>
      <label class="field-check" style="margin-top:6px"><input type="checkbox" id="ceoPaused" ${c.paused?'checked':''}> Emergency pause — stop every outbound message</label>
      ${fld('Autonomy', `<select id="ceoAutonomy">${AUTONOMY.map(([k,l])=>`<option value="${k}" ${c.autonomy===k?'selected':''}>${l}</option>`).join('')}</select>`)}
      <label class="field-check"><input type="checkbox" id="ceoDelayApproval" ${c.staff_delay_needs_approval?'checked':''}> Staff deadline extensions need my approval</label>
    </div>
    <div class="ceo-card"><h4>Playbooks</h4>${PLAYBOOKS.map(([k,l,h])=>`<label class="ceo-row" style="cursor:pointer"><input type="checkbox" data-pb="${k}" ${c.playbooks[k]?'checked':''} style="width:auto"><span class="grow">${l}<small>${h}</small></span></label>`).join('')}</div>
    <div class="ceo-card"><h4>Schedule</h4>
      <div class="field-row">${fld('Morning brief', time('ceoBrief', s.brief))}${fld('Standup', time('ceoStandup', s.standup))}</div>
      <div class="field-row">${fld('Day wrap', time('ceoWrap', s.wrap))}${fld('Weekly report', `<div class="ceo-inline"><select id="ceoWeeklyDay">${DAYS.map((d,i)=>`<option value="${i}" ${s.weekly_day===i?'selected':''}>${d}</option>`).join('')}</select>${time('ceoWeeklyTime', s.weekly_time)}</div>`)}</div>
      ${fld('Work days', `<div class="ceo-days">${DAYS.map((d,i)=>`<label><input type="checkbox" data-day="${i}" ${s.work_days.includes(i)?'checked':''}>${d}</label>`).join('')}</div>`)}
      <div class="field-row">${fld('Quiet from (hour)', num('ceoQuietStart', s.quiet_start, 0, 23))}${fld('Quiet until (hour)', num('ceoQuietEnd', s.quiet_end, 0, 23))}</div>
      ${fld('Time zone (UTC offset)', `<input id="ceoTz" value="${tzStr}" placeholder="+05:30">`, 'e.g. +05:30 India, +04:00 UAE, +03:00 Saudi')}
    </div>
    <div class="ceo-card"><h4>Escalation</h4><div class="field-row">
      ${fld('Nudge staff after (days late)', num('ceoEscStaff', c.escalation.staff_after_days, 0, 30))}
      ${fld('Alert me after (days late)', num('ceoEscAdmin', c.escalation.admin_after_days, 0, 60))}</div></div>
  </div><div>
    <div class="ceo-card"><h4>📱 CEO WhatsApp number</h4>
      ${ch.connected?`<div class="ceo-check">✅ Connected: <b>${esc(ch.display_phone||ch.wa_phone_id)}</b></div>`:'<div class="ceo-note" style="margin-bottom:10px">Use a <b>separate</b> number (not your leads number) added to your Meta WhatsApp Business account.</div>'}
      ${fld('Phone number ID', `<input id="ceoPhoneId" value="${escAttr(ch.wa_phone_id)}" placeholder="Meta → WhatsApp → API Setup">`)}
      ${fld('Access token', `<input id="ceoToken" type="password" placeholder="${ch.connected?'•••••• saved — paste to replace':'Permanent system-user token'}">`)}
      ${fld('App secret (optional)', `<input id="ceoAppSecret" type="password" placeholder="${ch.has_app_secret?'•••••• saved':'Only if this number is on your own Meta app'}">`, 'Used to verify that incoming messages really come from Meta.')}
      <div class="ceo-inline"><button class="btn primary sm" onclick="ceoSaveChannel()">${ch.connected?'Update':'Connect'}</button>${ch.connected?'<button class="btn sm" onclick="ceoDisconnect()">Disconnect</button><button class="btn sm" onclick="ceoTest()">Send test</button>':''}</div>
      ${ch.webhook_url?`<div class="subhead">Webhook (Meta → WhatsApp → Configuration)</div><div class="field-hint">Callback URL</div><div class="ceo-copy">${esc(ch.webhook_url)}</div>
        <div class="field-hint" style="margin-top:6px">Verify token</div><div class="ceo-copy">${esc(ch.verify_token)}</div><div class="field-hint" style="margin-top:6px">Subscribe to the <b>messages</b> field.</div>`:''}
      ${fld('Message template (optional)', `<div class="ceo-inline"><input id="ceoTplName" value="${escAttr(c.template.name)}" placeholder="e.g. ceo_update"><input id="ceoTplLang" value="${escAttr(c.template.lang)}" style="max-width:70px"></div>`,
        'An approved Utility template whose body is just {{1}}. Lets the bot reach people who haven\'t messaged it in 24 hours.')}
    </div>
    <div class="ceo-card"><h4>👥 Team</h4><div class="ceo-note" style="margin-bottom:8px">Numbers default to each user's WhatsApp in User Management. Override here for the CEO Bot only.</div>
      <div class="ceo-team-tbl">${S.team.map(m=>`<div class="ceo-row" style="flex-wrap:wrap"><div class="grow" style="min-width:140px"><b>${esc(m.name)}</b>${m.isAdmin?' (you)':''}<small>${esc(m.email)}</small></div>
        <input type="text" data-phone="${escAttr(m.email)}" value="${escAttr((S.cfg.staff[m.email]||{}).phone||(m.isAdmin?S.cfg.admin_phone:'')||'')}" placeholder="${escAttr(m.phone||'WhatsApp with country code')}" style="max-width:170px">
        ${m.isAdmin?'':`<label class="field-check"><input type="checkbox" data-standup="${escAttr(m.email)}" ${m.standup?'checked':''}> Standup</label><label class="field-check"><input type="checkbox" data-muted="${escAttr(m.email)}" ${m.muted?'checked':''}> Mute</label>`}</div>`).join('')}</div></div>
    <div class="ceo-card"><h4>Scope & persona</h4>
      ${fld('Projects the bot manages', `<div class="ceo-days">${S.projects.filter(p=>p.status!=='archived').map(p=>`<label><input type="checkbox" data-proj="${p.id}" ${c.project_scope.includes(p.id)?'checked':''}>${esc(p.name)}</label>`).join('')||'<span class="ceo-note">No projects yet</span>'}</div>`, 'None ticked = all active projects.')}
      <div class="field-row">${fld('Bot name', `<input id="ceoName" value="${escAttr(c.persona.name)}">`)}${fld('Reply language', `<input id="ceoLang" value="${escAttr(c.persona.language)}" placeholder="English, Malayalam…">`)}</div>
      ${fld('Monthly AI limit (questions + reply parsing)', num('ceoAiCap', c.monthly_ai_cap, 0, 100000))}
    </div>
  </div></div>
  <div style="position:sticky;bottom:0;background:var(--bg);padding:10px 0;display:flex;gap:10px;align-items:center"><button class="btn primary" onclick="ceoSaveSettings()">Save settings</button></div>`;
}
function readSettings(){
  const q=s=>document.querySelector('#viewCeo '+s);
  const v=id=>$id(id)?.value;
  const playbooks={}; document.querySelectorAll('#viewCeo [data-pb]').forEach(el=>{ playbooks[el.dataset.pb]=el.checked; });
  const work_days=[...document.querySelectorAll('#viewCeo [data-day]')].filter(el=>el.checked).map(el=>Number(el.dataset.day));
  const m=String(v('ceoTz')||'').trim().match(/^([+-])?(\d{1,2})(?::?(\d{2}))?$/);
  const tz=m?(m[1]==='-'?-1:1)*(Number(m[2])*60+Number(m[3]||0)):S.cfg.schedule.tz_offset_min;
  const staff={}; let admin_phone='';
  S.team.forEach(mem=>{
    const phone=(q(`[data-phone="${CSS.escape(mem.email)}"]`)?.value||'').trim();
    if(mem.isAdmin){ admin_phone=phone; return; }
    staff[mem.email]={phone, standup:!!q(`[data-standup="${CSS.escape(mem.email)}"]`)?.checked, muted:!!q(`[data-muted="${CSS.escape(mem.email)}"]`)?.checked};
  });
  return {active:$id('ceoActive').checked, paused:$id('ceoPaused').checked, autonomy:v('ceoAutonomy'), staff_delay_needs_approval:$id('ceoDelayApproval').checked,
    playbooks, schedule:{brief:v('ceoBrief'), standup:v('ceoStandup'), wrap:v('ceoWrap'), weekly_day:Number(v('ceoWeeklyDay')), weekly_time:v('ceoWeeklyTime'),
      work_days, quiet_start:Number(v('ceoQuietStart')), quiet_end:Number(v('ceoQuietEnd')), tz_offset_min:tz},
    escalation:{staff_after_days:Number(v('ceoEscStaff')), admin_after_days:Number(v('ceoEscAdmin'))},
    template:{name:v('ceoTplName'), lang:v('ceoTplLang')}, staff, admin_phone,
    project_scope:[...document.querySelectorAll('#viewCeo [data-proj]')].filter(el=>el.checked).map(el=>Number(el.dataset.proj)),
    persona:{name:v('ceoName'), language:v('ceoLang')}, monthly_ai_cap:Number(v('ceoAiCap'))};
}
async function saveConfig(patch, okMsg){
  try{ const d=await post('/ceo/config', {config:patch}); S.cfg=d.config; await loadConfig(); draw(); toast(okMsg||'Saved ✅'); }
  catch(e){ toast(e.message, true); }
}
window.ceoSaveSettings=()=>saveConfig(readSettings());
window.ceoSaveChannel=async function(){
  try{
    const d=await post('/ceo/channel', {wa_phone_id:$id('ceoPhoneId').value.trim(), wa_token:$id('ceoToken').value.trim(), app_secret:$id('ceoAppSecret').value.trim()});
    S.channel=d.channel; draw(); toast('CEO number connected ✅ — now add the webhook in Meta');
  }catch(e){ toast(e.message, true); }
};
window.ceoDisconnect=async function(){
  if(!confirm('Disconnect the CEO WhatsApp number? The bot stops sending until you connect it again.')) return;
  try{ const d=await post('/ceo/channel', {disconnect:true}); S.channel=d.channel; draw(); toast('Disconnected'); }catch(e){ toast(e.message, true); }
};
})();
