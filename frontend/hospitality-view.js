/* ── HOSPITALITY FRONT DESK in the CRM (desktop, hospitality_enabled === 'Yes') ─────────────────
   The CRM stays the first view. For Hospitality clients on a PC this adds:
   • a "🛎️ Front Desk ▾" menu in the desktop nav linking every new hospitality screen — Today,
     Bookings, Calendar, Rooms/Boats, Guests, Direct Sales and each Pro Suite screen that is
     switched on — each opening INSIDE the CRM (#pageHospdesk, an embedded
     hospitality.html?embed=1#<screen>), never in a new tab;
   • a new Home layout: today's stays with check-in / check-out, occupancy, Pro to-dos and the
     daily insight on top, followed by the CRM's own 🏆 Weekly Arena, Staff Performance and lead
     cards (the classic hero / AI row / briefing strip are hidden while it's on).
   Chats, lead details and other CRM pages requested by the embedded screens arrive here by
   postMessage ({source:'lv-hospdesk'}) and open in the CRM. Phones (LV_LITE) are unchanged.
   Data: one GET /hospitality/desk/bootstrap (cached 30s). Uses dashboard.html globals: $id, esc,
   navigate, clientRecord, clientId, CONFIG, ncAuthHeaders, myEmail, isAccountOwner,
   getTeamPermissions, allLeads, openDetail, openAddLead, showToast, chatSelectLead (chats.js).
   Bump the ?v= on its <script> tag in dashboard.html when changing this file — sw.js serves
   scripts cache-first. ── */
const HV_REQ={id_scan:'web_checkin', staff_bot:'staff_tasks', agent_quotes:'agents', allotments:'agents', commissions:'agents', occasions:'guest_profiles'};
// [screen, label, visible?(hvOn, pro)] — mirrors hospitality-desk.js's NAV.
const HV_NAV=[
  ['today','🏠 Today'], ['bookings','📒 Bookings'], ['calendar','🗓️ Calendar'], ['rooms',null], ['guests','🧳 Guests'],
  ['sales','⭐ Direct Sales', (on, pro)=>pro],
  ['journey','🧭 Guest Journey', on=>['balance_reminders','refunds','web_checkin','prearrival_upsell','stay_messages'].some(on)],
  ['agents','🤝 Agent Desk', on=>on('agents')],
  ['housekeeping','🧹 Housekeeping', on=>on('housekeeping')],
  ['tasks','✅ Tasks & Staff', on=>['staff_tasks','crew','instay_requests'].some(on)],
  ['cruise','🚤 Cruise Day', on=>['cruise_plan','crew','meal_preorder','pickup'].some(on)],
  ['fleet','⚓ Fleet & Maintenance', on=>['fleet','maintenance','cruise_plan','weather_alerts'].some(on)],
  ['meals','🍛 Kitchen & Menu', on=>on('meal_preorder')],
  ['pricing','🏷️ Smart Pricing', on=>on('pricing_rules')],
  ['channels','🔗 Channels (iCal)', on=>on('ical_sync')],
  ['competitors','📉 Competitors', on=>on('competitor_rates')],
  ['insights','📊 Daily Insights', on=>on('daily_summary')],
  ['feedback','💚 Guest Feedback', on=>on('feedback')],
  ['reviews','✍️ Review Replies', on=>on('review_replies')],
  ['alerts','🔔 Alerts', (on, pro, any)=>any],
  ['settings','⚙️ Front Desk Settings'],
];
let _hvData=null, _hvAt=0, _hvLoading=null, _hvScreen='today';

function hvActive(){
  if(window.LV_LITE || !clientRecord || clientRecord.hospitality_enabled!=='Yes') return false;
  try{
    const mine=(!myEmail||isAccountOwner())?null:getTeamPermissions()[myEmail];
    if(mine && Array.isArray(mine.modules) && !mine.modules.includes('hospitality')) return false;
  }catch(e){}
  return true;
}
function hvOn(k){ const s=_hvData?.pro?.suite; if(!s||!s[k]) return false; return HV_REQ[k]?hvOn(HV_REQ[k]):true; }
function hvAnySuite(){ return !!_hvData?.pro && Object.keys(_hvData.pro.suite||{}).some(hvOn); }
function hvIsBoat(){ return (_hvData?.client?.style||clientRecord?.hospitality_style)==='houseboat'; }

// Called from applyTheme (after travel / commerce views) and again once data arrives.
function hvApply(){
  // Stale flag from the short-lived "open the workspace first" redirect.
  try{ localStorage.removeItem('lv_hosp_desk'); }catch(e){}
  const active=hvActive();
  document.documentElement.classList.toggle('hv-mode', active);
  if(!active){ const g=$id('dnHvGroup'); if(g) g.style.display='none'; return; }
  hvEnsurePage();
  hvBuildNav();
  hvLoad().then(()=>{ hvBuildNav(); if(!$id('pageHome')?.classList.contains('hidden')) hvRenderHome(); }).catch(()=>{});
}
function hvOnNavigate(page){
  if(!hvActive()) return;
  if(page==='home') hvRenderHome(true);
  document.querySelectorAll('#dnHvGroup .dnTab').forEach(b=>b.classList.toggle('active', page==='hospdesk' && b.dataset.hv===_hvScreen));
}

async function hvLoad(force){
  if(!force && _hvData && Date.now()-_hvAt<30000) return _hvData;
  if(_hvLoading) return _hvLoading;
  _hvLoading=(async()=>{
    try{
      const r=await fetch(`${CONFIG.WORKER_BASE}/hospitality/desk/bootstrap`, {headers:ncAuthHeaders()});
      const d=await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(d.error||('HTTP '+r.status));
      _hvData=d; _hvAt=Date.now();
      return d;
    }finally{ _hvLoading=null; }
  })();
  return _hvLoading;
}

function hvEnsurePage(){
  if(!$id('hvStyle')){
    const st=document.createElement('style'); st.id='hvStyle';
    st.textContent=`
#pageHospdesk{overflow:hidden;padding:0!important}
#hospDeskFrame{width:100%;height:100%;border:none;display:block}
html.hv-mode #pageHome .home-hero,html.hv-mode #homeBizaiRow,html.hv-mode #bizBriefingCard,html.hv-mode #nbaPriorityStrip,html.hv-mode #homeSourceReport{display:none!important}
.hv-hero{display:flex;align-items:center;gap:16px;flex-wrap:wrap;background:linear-gradient(120deg,#0B3B36,#0E7C66 55%,#14B8A6);color:#fff;border-radius:18px;padding:22px 24px;margin-bottom:16px}
.hv-hero h2{margin:0;font-size:22px;font-weight:750;letter-spacing:-.01em}
.hv-hero .hv-sub{opacity:.85;font-size:13px;margin-top:3px}
.hv-hero .hv-acts{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap}
.hv-hero button{border:1px solid rgba(255,255,255,.35);background:rgba(255,255,255,.12);color:#fff;border-radius:10px;padding:8px 13px;font-weight:600;font-size:13px;cursor:pointer}
.hv-hero button.pri{background:#fff;color:#0B3B36;border-color:#fff}
.hv-hero button:hover{background:rgba(255,255,255,.22)}.hv-hero button.pri:hover{background:#ECFDF5}
.hv-kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin-bottom:16px}
.hv-kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px;cursor:pointer}
.hv-kpi:hover{border-color:var(--accent)}
.hv-kpi .l{font-size:12px;color:var(--muted)}.hv-kpi .v{font-size:24px;font-weight:750;color:var(--ink);margin-top:2px}.hv-kpi .s{font-size:11.5px;color:var(--muted)}
.hv-kpi .bar{height:5px;border-radius:4px;background:var(--line);margin-top:6px;overflow:hidden}.hv-kpi .bar i{display:block;height:100%;background:var(--accent)}
.hv-cols{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-bottom:16px}
.hv-card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
.hv-card h3{margin:0 0 8px;font-size:14px;display:flex;align-items:center;gap:8px;color:var(--ink)}
.hv-card h3 .n{font-size:11.5px;background:var(--accent-soft);color:var(--accent-ink);border-radius:20px;padding:1px 8px}
.hv-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--line);cursor:pointer}
.hv-row:first-of-type{border-top:0}
.hv-av{width:32px;height:32px;border-radius:50%;background:var(--accent-soft);color:var(--accent-ink);display:grid;place-items:center;font-weight:700;font-size:12px;flex:none}
.hv-main{flex:1;min-width:0}.hv-main b{display:block;font-size:13.5px;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.hv-main span{font-size:12px;color:var(--muted)}
.hv-btn{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:8px;padding:5px 10px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap}
.hv-btn.pri{background:var(--accent);border-color:var(--accent);color:#fff}
.hv-empty{color:var(--muted);font-size:13px;padding:14px 0;text-align:center}
.hv-todo{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
.hv-todo button{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:20px;padding:7px 13px;font-size:12.5px;font-weight:600;cursor:pointer}
.hv-todo button:hover{border-color:var(--accent);color:var(--accent-ink)}
.hv-insight{white-space:pre-wrap;line-height:1.6;font-size:13.5px;color:var(--ink)}
.hv-badge{font-size:11px;font-weight:650;border-radius:20px;padding:2px 8px;background:var(--accent-soft);color:var(--accent-ink);white-space:nowrap}
.hv-badge.warn{background:var(--warn-soft);color:var(--warn)}
@media(max-width:1200px){.hv-kpis{grid-template-columns:repeat(3,minmax(0,1fr))}.hv-cols{grid-template-columns:1fr 1fr}}`;
    document.head.appendChild(st);
  }
  if(!$id('pageHospdesk')){
    const pg=document.createElement('div'); pg.className='page hidden'; pg.id='pageHospdesk';
    pg.innerHTML='<iframe id="hospDeskFrame" title="Front Desk"></iframe>';
    $id('pages')?.appendChild(pg);
  }
  if(!$id('hvHome')){
    const body=document.querySelector('#pageHome .home-body');
    const anchor=$id('homeArena');
    if(body && anchor){ const h=document.createElement('div'); h.id='hvHome'; body.insertBefore(h, anchor); }
  }
}

function hvBuildNav(){
  const nav=$id('desktopNav'); if(!nav) return;
  let g=$id('dnHvGroup');
  if(!g){
    g=document.createElement('div'); g.className='dnGroup'; g.id='dnHvGroup';
    g.innerHTML='<button class="dnGroupBtn">🛎️ Front Desk <span class="arr">▾</span></button><div class="dnDropdown" style="min-width:220px;max-height:70vh;overflow:auto"></div>';
    const after=$id('dnHospitalityTab');
    if(after) after.insertAdjacentElement('afterend', g); else nav.insertBefore(g, nav.children[1]||null);
  }
  g.style.display='';
  const pro=!!_hvData?.pro, any=hvAnySuite();
  g.querySelector('.dnDropdown').innerHTML=HV_NAV.filter(([, , show])=>!show || show(hvOn, pro, any))
    .map(([k, l])=>`<button class="dnTab" data-hv="${k}" onclick="hvGo('${k}')">${esc(l||(hvIsBoat()?'⛵ Boats':'🛏️ Rooms'))}</button>`).join('');
}

// Opens a Front Desk screen inside the CRM. screen may carry a query, e.g. 'bookings?b=41'.
function hvGo(screen){
  hvEnsurePage();
  _hvScreen=String(screen||'today').split('?')[0];
  const f=$id('hospDeskFrame');
  const src=`hospitality.html?embed=1#${screen}`;
  if(!f.getAttribute('src')) f.src=src;
  else{ try{ f.contentWindow.location.hash=screen; }catch(e){ f.src=src; } }
  navigate('hospdesk');
}

// Embedded Front Desk → CRM.
window.addEventListener('message', e=>{
  const f=$id('hospDeskFrame');
  if(!f || e.source!==f.contentWindow || e.data?.source!=='lv-hospdesk') return;
  const d=e.data;
  if(d.type==='chat') hvOpenChat(d.leadId, d.phone);
  else if(d.type==='lead'){ if(d.leadId && typeof openDetail==='function') openDetail(Number(d.leadId)); }
  else if(d.type==='crm'){
    if(d.page==='logout'){ $id('hLogout')?.click(); return; }
    navigate(d.page||'home');
  }
});
function hvOpenChat(leadId, phone){
  let id=Number(leadId)||null;
  if(!id && phone){
    const key=String(phone).replace(/\D/g,'').slice(-10);
    const lead=key.length>=6?(typeof allLeads!=='undefined'?allLeads:[]).find(l=>String(l.Phone||'').replace(/\D/g,'').slice(-10)===key):null;
    id=lead?.Id||null;
  }
  if(!id){ if(typeof showToast==='function') showToast('No chat with this number yet — search it in Chats.'); navigate('chats'); return; }
  navigate('chats');
  if(typeof chatSelectLead==='function') chatSelectLead(id);
}

// ── New Home (top block; the CRM's Weekly Arena, Staff Performance and lead cards follow) ──────
const HV_MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'], HV_DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function hvDate(iso, dow){ const d=new Date(String(iso).slice(0,10)+'T00:00:00Z'); return `${dow?HV_DOW[d.getUTCDay()]+', ':''}${d.getUTCDate()} ${HV_MON[d.getUTCMonth()]}`; }
function hvAdd(iso, n){ const d=new Date(iso+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
function hvMoney(n, cur){ const c=String(cur||'INR').toUpperCase(); const v=Math.round(Number(n)||0); return (c==='INR'?'₹':c+' ')+v.toLocaleString(c==='INR'?'en-IN':'en-US'); }
function hvInitials(n){ return String(n||'?').trim().split(/\s+/).slice(0,2).map(x=>x[0]||'').join('').toUpperCase()||'?'; }
function hvUnit(id){ return (_hvData?.units||[]).find(u=>Number(u.id)===Number(id))?.name||'—'; }

async function hvRenderHome(refetch){
  const el=$id('hvHome'); if(!el || !hvActive()) return;
  if(!_hvData) el.innerHTML='<div class="sk sk-row"></div><div class="sk sk-row"></div>';
  try{ await hvLoad(!!refetch && Date.now()-_hvAt>5000); }
  catch(e){ if(!_hvData){ el.innerHTML=''; } return; }
  const D=_hvData, t=D.today, s=D.stats, P=D.pro, cur=D.units[0]?.currency||'INR';
  const hour=new Date().getHours();
  const hello=hour<12?'Good morning':hour<17?'Good afternoon':'Good evening';
  const word=hvIsBoat()?'boats':'rooms';
  const arrivals=D.bookings.filter(b=>b.check_in===t && ['confirmed','inquiry'].includes(b.status));
  const departures=D.bookings.filter(b=>b.check_out===t && ['checked_in','confirmed'].includes(b.status));
  const inHouse=D.bookings.filter(b=>b.check_in<=t && b.check_out>t && b.status==='checked_in');
  const upcoming=D.bookings.filter(b=>b.check_in>t && b.check_in<=hvAdd(t, 7) && ['confirmed','inquiry'].includes(b.status));
  const kpi=(l, v, sub, go, pct)=>`<div class="hv-kpi" onclick="hvGo('${go}')"><div class="l">${l}</div><div class="v">${v}</div>${sub?`<div class="s">${sub}</div>`:''}${pct!=null?`<div class="bar"><i style="width:${Math.min(100, pct)}%"></i></div>`:''}</div>`;
  const row=(b, action)=>`<div class="hv-row" onclick="hvGo('bookings?b=${b.id}')"><div class="hv-av">${esc(hvInitials(b.guest_name))}</div><div class="hv-main"><b>${esc(b.guest_name||'Guest')}</b><span>${esc(hvUnit(b.unit_id))} · ${hvDate(b.check_in)} → ${hvDate(b.check_out)} · ${b.adults||1}${b.children?'+'+b.children:''} guests</span></div>${action}</div>`;
  const list=(arr, fn, empty)=>arr.length?arr.slice(0, 6).map(fn).join('')+(arr.length>6?`<div class="hv-empty"><a href="#" onclick="hvGo('bookings');return false">+${arr.length-6} more</a></div>`:''):`<div class="hv-empty">${empty}</div>`;
  const act=(b, st, l)=>`<button class="hv-btn pri" onclick="event.stopPropagation();hvSetStatus(${b.id},'${st}')">${l}</button>`;
  const todo=[];
  if(P?.holds_awaiting) todo.push(`<button onclick="hvGo('sales')">🔒 ${P.holds_awaiting} hold${P.holds_awaiting===1?'':'s'} to check</button>`);
  if(P?.groups_new) todo.push(`<button onclick="hvGo('sales')">🎉 ${P.groups_new} group enquir${P.groups_new===1?'y':'ies'}</button>`);
  if(s.inquiries) todo.push(`<button onclick="hvGo('bookings')">📝 ${s.inquiries} booking inquir${s.inquiries===1?'y':'ies'}</button>`);
  if(P?.alerts_open && hvAnySuite()) todo.push(`<button onclick="hvGo('alerts')">🔔 ${P.alerts_open} alert${P.alerts_open===1?'':'s'}</button>`);
  if(P?.tasks_open && ['staff_tasks','housekeeping','instay_requests'].some(hvOn)) todo.push(`<button onclick="hvGo('tasks')">✅ ${P.tasks_open} open task${P.tasks_open===1?'':'s'}</button>`);
  if(P?.suggestions && hvOn('pricing_rules')) todo.push(`<button onclick="hvGo('pricing')">🏷️ ${P.suggestions} price suggestion${P.suggestions===1?'':'s'}</button>`);
  el.innerHTML=`
    <div class="hv-hero"><div><h2>${hello}${D.client.name?`, ${esc(D.client.name)}`:''} 👋</h2><div class="hv-sub">${hvDate(t, true)} · ${s.in_house} in-house · ${s.arrivals} arriving · ${s.departures} leaving</div></div>
      <div class="hv-acts"><button class="pri" onclick="hvGo('bookings?new=1')">＋ New booking</button><button onclick="hvGo('calendar')">🗓️ Calendar</button><button onclick="navigate('chats')">💬 Chats</button><button onclick="navigate('leads')">👥 Leads</button><button onclick="openAddLead()">＋ Add lead</button></div></div>
    <div class="hv-kpis">
      ${kpi('In-house', s.in_house, `${D.units.filter(u=>u.active).length} ${word} active`, 'today')}
      ${kpi('Arrivals today', s.arrivals, '', 'today')}${kpi('Departures today', s.departures, '', 'today')}
      ${kpi('Occupancy today', s.occupancy_today+'%', '', 'calendar', s.occupancy_today)}
      ${kpi('Next 7 days', s.occupancy_7+'%', 'booked', 'calendar', s.occupancy_7)}
      ${kpi('Revenue this month', hvMoney(s.revenue_month, cur), '', 'bookings')}
    </div>
    ${todo.length?`<div class="hv-todo">${todo.join('')}</div>`:''}
    ${P?.summary?`<div class="hv-card" style="margin-bottom:16px"><h3>📊 Today's insight<span style="flex:1"></span><button class="hv-btn" onclick="hvGo('insights')">Open</button></h3><div class="hv-insight">${esc(P.summary.text)}</div></div>`:''}
    <div class="hv-cols">
      <div class="hv-card"><h3>🛬 Arriving today <span class="n">${arrivals.length}</span></h3>${list(arrivals, b=>row(b, b.status==='confirmed'?act(b, 'checked_in', 'Check in'):'<span class="hv-badge warn">Inquiry</span>'), 'No arrivals today')}</div>
      <div class="hv-card"><h3>🛫 Leaving today <span class="n">${departures.length}</span></h3>${list(departures, b=>row(b, b.status==='checked_in'?act(b, 'checked_out', 'Check out'):''), 'No departures today')}</div>
      <div class="hv-card"><h3>🏠 In-house <span class="n">${inHouse.length}</span></h3>${list(inHouse, b=>row(b, ''), 'Nobody checked in right now')}</div>
    </div>
    <div class="hv-card" style="margin-bottom:18px"><h3>📅 Next 7 days <span class="n">${upcoming.length}</span><span style="flex:1"></span><button class="hv-btn" onclick="hvGo('calendar')">Calendar</button></h3>
      ${list(upcoming, b=>row(b, `<span style="font-size:12.5px;font-weight:650;color:var(--ink)">${hvMoney(b.total_amount, b.currency)}</span>${b.status==='inquiry'?' <span class="hv-badge warn">Inquiry</span>':''}`), 'Nothing booked for the next 7 days yet.')}</div>`;
}
async function hvSetStatus(id, status){
  try{
    const r=await fetch(`${CONFIG.WORKER_BASE}/hospitality/bookings`, {method:'PATCH', headers:ncAuthHeaders({'Content-Type':'application/json'}), body:JSON.stringify({id, status})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(d.error||('HTTP '+r.status));
    if(typeof showToast==='function') showToast(status==='checked_in'?'Checked in ✓':'Checked out ✓');
    await hvLoad(true); hvRenderHome();
  }catch(e){ if(typeof showToast==='function') showToast(e.message||String(e)); }
}
