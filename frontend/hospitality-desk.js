/* ── Hospitality workspace (frontend/hospitality.html) ─────────────────────────────────────────
   Runs embedded in the CRM (?embed=1 — dashboard.html's 🛎️ Front Desk pages, hospitality-view.js):
   the CRM's own nav replaces this page's sidebar, and Chats / leads / other CRM pages are handed to
   the CRM through postMessage ({source:'lv-hospdesk', type:'chat'|'crm'|'lead'}), so nothing ever
   opens in a new tab.
   Core: sign-in state, the one-request bootstrap (/hospitality/desk/bootstrap) painted from a local
   cache first, navigation, and the front-desk screens every Hospitality client gets — Today,
   Bookings, Calendar (tape chart), Chats, Rooms / Boats, Guests, Settings. Pro screens are loaded on
   demand: Direct Sales reuses hospitality-pro.js unchanged (this file provides the dashboard
   globals it expects: CONFIG, ncAuthHeaders, esc, $id, showToast, fmtDateShort, clientRecord,
   hospUnits, hospProperties), and every Pro Suite screen lives in hospitality-desk-suite.js,
   shown only when its switch is on. ── */
'use strict';
const WORKER='https://leadvyne-api-proxy.leadvyne.workers.dev';
var CONFIG={WORKER_BASE:WORKER};
let clientId='', sessionToken='';
try{ clientId=localStorage.getItem('lv_cid')||''; sessionToken=localStorage.getItem('lv_session')||''; }catch(e){}
const $=id=>document.getElementById(id);
var $id=$;
function esc(s){ return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function ncAuthHeaders(extra){ return {Authorization:'Bearer '+sessionToken, ...(extra||{})}; }
var clientRecord={}, hospUnits=[], hospProperties=[];
let D=null;                       // bootstrap payload
let page='today';
const CACHE_KEY='lv_hosp_desk_'+clientId;
const EMBED=new URLSearchParams(location.search).get('embed')==='1';
if(EMBED) document.documentElement.classList.add('embed');
function hostPost(type, data){ try{ window.parent.postMessage({source:'lv-hospdesk', type, ...(data||{})}, location.protocol==='file:'?'*':location.origin); }catch(e){} }

// ── Small helpers ────────────────────────────────────────────────────────────────────────────────
function toast(msg, err){ const t=$('toast'); t.textContent=msg; t.className=err?'err':''; t.style.display='block'; clearTimeout(toast.t); toast.t=setTimeout(()=>t.style.display='none', err?4200:2400); }
function showToast(msg, kind){ toast(msg, kind==='error'||kind==='err'); }
async function api(path, method='GET', body){
  const r=await fetch(WORKER+path, {method, headers:ncAuthHeaders(body?{'Content-Type':'application/json'}:{}), body:body?JSON.stringify(body):undefined});
  if(r.status===401){ location.replace('dashboard.html?full=1'); throw new Error('Signed out'); }
  const ct=r.headers.get('content-type')||'';
  const d=ct.includes('json')?await r.json().catch(()=>({})):{};
  if(!r.ok) throw new Error(d.error||('HTTP '+r.status));
  return d;
}
const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'], DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function dt(iso){ return new Date(String(iso).slice(0,10)+'T00:00:00Z'); }
function fmtDate(iso, withDow=true){ if(!iso) return '—'; const d=dt(iso); return `${withDow?DOW[d.getUTCDay()]+', ':''}${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; }
function fmtDateShort(iso){ return fmtDate(iso, false); }
function addDays(iso, n){ const d=dt(iso); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
function nights(a, b){ return Math.round((dt(b)-dt(a))/86400000); }
const SYM={INR:'₹', USD:'$', EUR:'€', GBP:'£', AED:'AED '};
function money(n, cur){ const c=String(cur||'INR').toUpperCase(); const v=Math.round(Number(n)||0); return (SYM[c]||c+' ')+v.toLocaleString(c==='INR'?'en-IN':'en-US'); }
function today(){ return D?.today||new Date().toISOString().slice(0,10); }
function initials(n){ return String(n||'?').trim().split(/\s+/).slice(0,2).map(x=>x[0]||'').join('').toUpperCase()||'?'; }
function unitById(id){ return (D?.units||[]).find(u=>Number(u.id)===Number(id)); }
function unitName(id){ return unitById(id)?.name||'—'; }
function isBoat(){ return D?.client?.style==='houseboat'; }
function unitWord(plural){ return isBoat()?(plural?'Boats':'Boat'):(plural?'Rooms':'Room'); }
const STATUS={inquiry:['Inquiry','warn'], confirmed:['Confirmed','green'], checked_in:['In-house','blue'], checked_out:['Checked out','gray'], cancelled:['Cancelled','red']};
function statusBadge(s){ const [l, c]=STATUS[s]||[s, 'gray']; return `<span class="badge ${c}">${esc(l)}</span>`; }
function loadScript(src){
  loadScript.p=loadScript.p||{};
  return loadScript.p[src]||(loadScript.p[src]=new Promise((ok, no)=>{ const s=document.createElement('script'); s.src=src; s.onload=ok; s.onerror=()=>{ delete loadScript.p[src]; no(new Error('Could not load '+src)); }; document.head.appendChild(s); }));
}
function openCrm(p){ if(EMBED) return hostPost('crm', {page:p||'home'}); location.href='dashboard.html'+(p?'?page='+encodeURIComponent(p):''); }
function signOut(){ if(EMBED) return hostPost('crm', {page:'logout'}); location.href='dashboard.html?logout=1'; }
// A guest's WhatsApp conversation, inside the CRM's Chats — never a new tab. Without a CRM lead the
// CRM looks the number up; a prepared message is copied so staff can paste it.
function openChat(leadId, phone, text){
  if(text){ try{ navigator.clipboard.writeText(text); toast('Message copied — paste it in the chat'); }catch(e){} }
  if(EMBED) return hostPost('chat', {leadId:leadId||null, phone:phone||''});
  if(leadId){ go('chats'); setTimeout(()=>{ const f=$('chatsHost').querySelector('iframe'); try{ f?.contentWindow.postMessage({source:'lv-dashboard', leadId:Number(leadId)}, location.protocol==='file:'?'*':location.origin); }catch(e){} }, 300); return; }
  toast('Open this guest from Chats — no chat is linked to this number yet', true);
}
// wa.me links the Worker returns for an unsent message → the same in-CRM chat, text copied.
function openChatFromLink(link, leadId){
  const m=String(link||'').match(/wa\.me\/(\d+)(?:\?text=(.*))?/);
  openChat(leadId||null, m?m[1]:'', m&&m[2]?decodeURIComponent(m[2]):'');
}
function chatBtn(leadId, phone, label){ return phone||leadId?`<button class="btn btn-sm" onclick="event.stopPropagation();openChat(${Number(leadId)||'null'},'${esc(String(phone||'').replace(/[^\d+]/g,''))}')">${label||'💬'}</button>`:''; }
function skeleton(){ return '<div class="card"><div class="skel" style="width:35%"></div><div class="skel"></div><div class="skel" style="width:80%"></div><div class="skel" style="width:60%"></div></div>'; }
function errBox(e){ return `<div class="card" style="color:var(--red)">Couldn't load: ${esc(e.message||e)}</div>`; }

// Modal: modal(title, html, [{label, primary, danger, onClick(close)}])
function modal(title, html, buttons){
  $('mTitle').textContent=title; $('mBody').innerHTML=html;
  const foot=$('mFoot'); foot.innerHTML='';
  (buttons||[{label:'Close'}]).forEach(b=>{
    const el=document.createElement('button');
    el.className='btn'+(b.primary?' btn-primary':'')+(b.danger?' btn-danger':'');
    el.textContent=b.label;
    el.onclick=async()=>{
      if(!b.onClick){ closeModal(); return; }
      el.disabled=true;
      try{ const keep=await b.onClick(); if(keep!==true) closeModal(); }
      catch(e){ toast(e.message||String(e), true); }
      finally{ el.disabled=false; }
    };
    foot.appendChild(el);
  });
  $('modal').classList.add('on');
  setTimeout(()=>$('mBody').querySelector('input,select,textarea')?.focus(), 30);
}
function closeModal(){ $('modal').classList.remove('on'); }
function vals(root){
  const o={};
  (root||$('mBody')).querySelectorAll('[name]').forEach(el=>{ o[el.name]=el.type==='checkbox'?el.checked:el.value; });
  return o;
}
function opt(v, label, sel){ return `<option value="${esc(v)}"${String(v)===String(sel)?' selected':''}>${esc(label)}</option>`; }

// ── Bootstrap (cache first, then network) ───────────────────────────────────────────────────────
function applyData(d){
  D=d;
  hospUnits=(d.units||[]).map(u=>({...u, Id:u.id}));
  clientRecord={...clientRecord, Id:d.client.id, client_name:d.client.name, hospitality_enabled:'Yes', hospitality_style:d.client.style, hospitality_pro_enabled:d.client.pro?'Yes':'No'};
  $('bizName').textContent=d.client.name||'Hospitality';
  $('bizSub').textContent=d.client.pro?'Hospitality Pro':'Front desk';
  $('when').textContent=fmtDate(d.today);
  const alerts=d.pro?.alerts_open||0;
  $('alertBtn').style.display=d.pro&&anySuite()?'':'none';
  $('alertDot').style.display=alerts?'':'none'; $('alertDot').textContent=alerts>99?'99+':alerts;
  renderNav();
}
async function refresh(manual){
  try{
    const d=await api('/hospitality/desk/bootstrap');
    applyData(d);
    try{ localStorage.setItem(CACHE_KEY, JSON.stringify({at:Date.now(), d})); }catch(e){}
    render();
    if(manual) toast('Updated');
  }catch(e){
    if(/not enabled/i.test(e.message)){ try{ localStorage.removeItem('lv_hosp_desk'); }catch(x){} location.replace('dashboard.html?full=1'); return; }
    if(!D) $('view').innerHTML=errBox(e); else toast('Offline — showing the last saved view', true);
  }
}
// Keeps the session sliding (same as m.html's loadMe) — runs after first paint, never blocks it.
async function touchSession(){
  try{
    const me=await api('/session/me');
    if(me.session_token){ sessionToken=me.session_token; try{ localStorage.setItem('lv_session', sessionToken); }catch(e){} }
    clientRecord={...(me.client||{}), ...clientRecord, ...{hospitality_pro_enabled:me.client?.hospitality_pro_enabled==='Yes'?'Yes':clientRecord.hospitality_pro_enabled}};
    hospProperties=[];
  }catch(e){}
}

// ── Navigation ───────────────────────────────────────────────────────────────────────────────────
const REQ={id_scan:'web_checkin', staff_bot:'staff_tasks', agent_quotes:'agents', allotments:'agents', commissions:'agents', occasions:'guest_profiles'};
function on(k){ const s=D?.pro?.suite; if(!s||!s[k]) return false; return REQ[k]?on(REQ[k]):true; }
function onAny(...ks){ return ks.some(on); }
function anySuite(){ return !!D?.pro && Object.keys(D.pro.suite||{}).some(on); }
const NAV=[
  {g:'Front desk', items:[
    {k:'today', ic:'🏠', l:'Today'},
    {k:'bookings', ic:'📒', l:'Bookings', ct:()=>D?.stats?.inquiries},
    {k:'calendar', ic:'🗓️', l:'Calendar'},
    {k:'chats', ic:'💬', l:'Chats'},
    {k:'rooms', ic:'🛏️', l:()=>unitWord(true)},
    {k:'guests', ic:'🧳', l:'Guests'},
  ]},
  {g:'Sell more', items:[
    {k:'sales', ic:'⭐', l:'Direct Sales', show:()=>!!D?.pro, ct:()=>(D?.pro?.holds_awaiting||0)+(D?.pro?.groups_new||0)},
    {k:'journey', ic:'🧭', l:'Guest Journey', suite:1, show:()=>onAny('balance_reminders','refunds','web_checkin','prearrival_upsell','stay_messages')},
    {k:'agents', ic:'🤝', l:'Agent Desk', suite:1, show:()=>on('agents')},
  ]},
  {g:'Operations', items:[
    {k:'housekeeping', ic:'🧹', l:'Housekeeping', suite:1, show:()=>on('housekeeping')},
    {k:'tasks', ic:'✅', l:'Tasks & Staff', suite:1, show:()=>onAny('staff_tasks','crew','instay_requests'), ct:()=>D?.pro?.tasks_open},
    {k:'cruise', ic:'🚤', l:'Cruise Day', suite:1, show:()=>onAny('cruise_plan','crew','meal_preorder','pickup')},
    {k:'fleet', ic:'⚓', l:'Fleet & Maintenance', suite:1, show:()=>onAny('fleet','maintenance','cruise_plan','weather_alerts')},
    {k:'meals', ic:'🍛', l:'Kitchen & Menu', suite:1, show:()=>on('meal_preorder')},
  ]},
  {g:'Revenue', items:[
    {k:'pricing', ic:'🏷️', l:'Smart Pricing', suite:1, show:()=>on('pricing_rules'), ct:()=>D?.pro?.suggestions},
    {k:'channels', ic:'🔗', l:'Channels (iCal)', suite:1, show:()=>on('ical_sync')},
    {k:'competitors', ic:'📉', l:'Competitors', suite:1, show:()=>on('competitor_rates')},
    {k:'insights', ic:'📊', l:'Daily Insights', suite:1, show:()=>on('daily_summary')},
  ]},
  {g:'Reputation', items:[
    {k:'feedback', ic:'💚', l:'Guest Feedback', suite:1, show:()=>on('feedback')},
    {k:'reviews', ic:'✍️', l:'Review Replies', suite:1, show:()=>on('review_replies')},
  ]},
  {g:'', items:[
    {k:'alerts', ic:'🔔', l:'Alerts', suite:1, show:()=>anySuite(), ct:()=>D?.pro?.alerts_open},
    {k:'settings', ic:'⚙️', l:'Settings'},
  ]},
];
function navItem(k){ for(const g of NAV) for(const it of g.items) if(it.k===k) return it; return null; }
function visible(it){ return !it.show || it.show(); }
function renderNav(){
  $('nav').innerHTML=NAV.map(g=>{
    const items=g.items.filter(visible);
    if(!items.length) return '';
    return (g.g?`<div class="ng">${esc(g.g)}</div>`:'<div style="height:10px"></div>')+items.map(it=>{
      const ct=it.ct?Number(it.ct())||0:0;
      const label=typeof it.l==='function'?it.l():it.l;
      return `<button class="ni${it.k===page?' on':''}" data-k="${it.k}" onclick="go('${it.k}')" title="${esc(label)}"><span class="ic">${it.ic}</span><span class="lb">${esc(label)}</span>${ct?`<span class="ct">${ct>99?'99+':ct}</span>`:''}</button>`;
    }).join('');
  }).join('');
}
function go(k){ if(location.hash!=='#'+k) location.hash=k; else render(); }
window.addEventListener('hashchange', ()=>render());
function render(){
  const want=(location.hash||'#today').slice(1).split('?')[0];
  const it=navItem(want);
  page=it && (!D || visible(it))?want:'today';
  document.querySelectorAll('.ni[data-k]').forEach(b=>b.classList.toggle('on', b.dataset.k===page));
  const label=it&&it.k===page?(typeof it.l==='function'?it.l():it.l):'Today';
  $('title').textContent=label;
  document.title=`${label} · Hospitality`;
  if(page==='chats' && EMBED){ hostPost('crm', {page:'chats'}); history.replaceState(null, '', '#today'); page='today'; }
  document.body.classList.toggle('chats-on', page==='chats');
  if(page==='chats'){ mountChats(); return; }
  const el=$('view');
  if(!D){ el.innerHTML=skeleton(); return; }
  const core={today:renderToday, bookings:renderBookings, calendar:renderCalendar, rooms:renderRooms, guests:renderGuests, sales:renderSales, settings:renderSettings};
  if(core[page]){
    core[page](el);
    // ?new=1 / ?b=<id> on the hash (from the CRM's Home): open the booking form once.
    const q=new URLSearchParams((location.hash.split('?')[1])||'');
    if(page==='bookings' && (q.get('new') || q.get('b'))){
      history.replaceState(null, '', '#bookings');
      if(q.get('b')) editBooking(Number(q.get('b'))); else openBooking();
    }
    return;
  }
  el.innerHTML=skeleton();
  loadScript('hospitality-desk-suite.js?v=1').then(()=>{ if(page===want) window.HSX.render(page, el); }).catch(e=>{ el.innerHTML=errBox(e); });
}

// ── Today ────────────────────────────────────────────────────────────────────────────────────────
function occupying(b){ return ['confirmed','checked_in','checked_out'].includes(b.status); }
function renderToday(el){
  const t=today(), s=D.stats, cur=D.units[0]?.currency||'INR';
  const arrivals=D.bookings.filter(b=>b.check_in===t && ['confirmed','inquiry'].includes(b.status));
  const departures=D.bookings.filter(b=>b.check_out===t && ['checked_in','confirmed'].includes(b.status));
  const inHouse=D.bookings.filter(b=>b.check_in<=t && b.check_out>t && b.status==='checked_in');
  const upcoming=D.bookings.filter(b=>b.check_in>t && b.check_in<=addDays(t, 7) && ['confirmed','inquiry'].includes(b.status));
  const kpi=(l, v, sub, acc)=>`<div class="stat${acc?' accent':''}"><div class="stat-lbl">${l}</div><div class="stat-val">${v}</div>${sub?`<div class="stat-sub">${sub}</div>`:''}</div>`;
  const row=(b, action)=>`<div class="list-item"><div class="av">${esc(initials(b.guest_name))}</div><div class="li-main"><b>${esc(b.guest_name||'Guest')}</b><span class="muted">${esc(unitName(b.unit_id))} · ${fmtDate(b.check_in, false)} → ${fmtDate(b.check_out, false)} · ${b.adults||1}${b.children?'+'+b.children:''} guests</span></div>${action}<button class="btn btn-sm" onclick="editBooking(${b.id})">Open</button></div>`;
  const list=(arr, fn, empty)=>arr.length?arr.map(fn).join(''):`<div class="empty-state">${empty}</div>`;
  const P=D.pro;
  el.innerHTML=`
    <div class="kpis">
      ${kpi('In-house', s.in_house, `${D.units.filter(u=>u.active).length} ${unitWord(true).toLowerCase()} active`, true)}
      ${kpi('Arrivals today', s.arrivals)}${kpi('Departures today', s.departures)}
      ${kpi('Occupancy today', s.occupancy_today+'%')}${kpi('Next 7 days', s.occupancy_7+'%', 'booked')}
      ${kpi('Revenue this month', money(s.revenue_month, cur))}
    </div>
    ${P?.summary?`<div class="card"><div class="card-title">📊 Today's insights<span class="sp"></span><button class="btn btn-sm" onclick="go('insights')">Open</button></div><div class="summary">${esc(P.summary.text)}</div></div>`:''}
    ${P?proStrip(P):''}
    <div class="grid g3">
      <div class="card"><div class="card-title">🛬 Arriving today <span class="badge green">${arrivals.length}</span></div>
        ${list(arrivals, b=>row(b, b.status==='confirmed'?`<button class="btn btn-sm btn-primary" onclick="setStatus(${b.id},'checked_in')">Check in</button>`:statusBadge(b.status)), 'No arrivals today')}</div>
      <div class="card"><div class="card-title">🛫 Leaving today <span class="badge warn">${departures.length}</span></div>
        ${list(departures, b=>row(b, b.status==='checked_in'?`<button class="btn btn-sm btn-primary" onclick="setStatus(${b.id},'checked_out')">Check out</button>`:statusBadge(b.status)), 'No departures today')}</div>
      <div class="card"><div class="card-title">🏠 In-house <span class="badge blue">${inHouse.length}</span></div>
        ${list(inHouse, b=>row(b, ''), 'Nobody checked in right now')}</div>
    </div>
    <div class="card"><div class="card-title">📅 Next 7 days<span class="sp"></span><button class="btn btn-sm" onclick="go('calendar')">Calendar</button></div>
      ${upcoming.length?`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Arrival</th><th>Guest</th><th>${unitWord()}</th><th>Nights</th><th>Total</th><th>Status</th></tr></thead><tbody>
      ${upcoming.map(b=>`<tr class="click" onclick="editBooking(${b.id})"><td>${fmtDate(b.check_in)}</td><td>${esc(b.guest_name||'—')}</td><td>${esc(unitName(b.unit_id))}</td><td>${nights(b.check_in, b.check_out)}</td><td>${money(b.total_amount, b.currency)}</td><td>${statusBadge(b.status)}</td></tr>`).join('')}
      </tbody></table></div>`:'<div class="empty-state">Nothing booked for the next 7 days yet.</div>'}
    </div>
    ${!P?`<div class="card" style="background:linear-gradient(135deg,#F0FDFA,#fff)"><div class="card-title">⭐ Hospitality Pro</div><div class="muted">Instant WhatsApp quotes with "Hold this room", deposits, add-ons, guest journey, housekeeping, houseboat operations, smart pricing, OTA calendar sync, reviews and an agent desk. <a href="#settings">See what's included</a>.</div></div>`:''}`;
}
function proStrip(P){
  const items=[];
  if(P.holds_awaiting) items.push(`<button class="btn" onclick="go('sales')">🔒 ${P.holds_awaiting} hold${P.holds_awaiting===1?'':'s'} to check</button>`);
  if(P.groups_new) items.push(`<button class="btn" onclick="go('sales')">🎉 ${P.groups_new} new group enquir${P.groups_new===1?'y':'ies'}</button>`);
  if(P.alerts_open) items.push(`<button class="btn" onclick="go('alerts')">🔔 ${P.alerts_open} alert${P.alerts_open===1?'':'s'}</button>`);
  if(P.tasks_open && onAny('staff_tasks','housekeeping')) items.push(`<button class="btn" onclick="go('tasks')">✅ ${P.tasks_open} open task${P.tasks_open===1?'':'s'}</button>`);
  if(P.suggestions && on('pricing_rules')) items.push(`<button class="btn" onclick="go('pricing')">🏷️ ${P.suggestions} price suggestion${P.suggestions===1?'':'s'}</button>`);
  return items.length?`<div class="row" style="margin-bottom:14px">${items.join('')}</div>`:'';
}
async function setStatus(id, status){
  try{
    await api('/hospitality/bookings', 'PATCH', {id, status});
    toast(status==='checked_in'?'Checked in ✓':status==='checked_out'?'Checked out ✓':'Updated');
    await refresh();
  }catch(e){ toast(e.message, true); }
}

// ── Booking modal ────────────────────────────────────────────────────────────────────────────────
function openBooking(pre){
  pre=pre||{};
  const units=D?.units?.filter(u=>u.active)||[];
  if(!units.length){ toast(`Add a ${unitWord().toLowerCase()} first`, true); go('rooms'); return; }
  const b={unit_id:pre.unit_id||units[0].id, check_in:pre.check_in||today(), check_out:pre.check_out||addDays(pre.check_in||today(), 1), adults:2, children:0, status:'confirmed', ...pre};
  bookingForm(b, null);
}
function editBooking(id){
  const b=(D?.bookings||[]).find(x=>Number(x.id)===Number(id)) || (editBooking.extra||{})[id];
  if(!b){ toast('Booking not in view — open it from Bookings', true); return; }
  bookingForm(b, id);
}
function bookingForm(b, id){
  const u=unitById(b.unit_id)||D.units[0];
  const rate=b.rate_per_night||(b.total_amount&&nights(b.check_in, b.check_out)?Math.round(b.total_amount/nights(b.check_in, b.check_out)):u?.base_rate||0);
  const html=`<div class="form-grid">
    <label>${unitWord()}<select class="in" name="unit_id" onchange="bkRecalc(true)">${D.units.map(x=>opt(x.id, x.name+(x.active?'':' (inactive)'), b.unit_id)).join('')}</select></label>
    <label>Status<select class="in" name="status">${Object.entries(STATUS).map(([k, [l]])=>opt(k, l, b.status)).join('')}</select></label>
    <label>Check-in<input class="in" type="date" name="check_in" value="${esc(b.check_in)}" onchange="bkRecalc()"></label>
    <label>Check-out<input class="in" type="date" name="check_out" value="${esc(b.check_out)}" onchange="bkRecalc()"></label>
    <label>Guest name<input class="in" name="guest_name" value="${esc(b.guest_name||'')}" placeholder="Full name"></label>
    <label>Phone (WhatsApp)<input class="in" name="guest_phone" value="${esc(b.guest_phone||'')}" placeholder="+91…"></label>
    <label>Adults<input class="in" type="number" min="1" name="adults" value="${esc(b.adults||1)}"></label>
    <label>Children<input class="in" type="number" min="0" name="children" value="${esc(b.children||0)}"></label>
    <label>Rate / night<input class="in" type="number" min="0" name="rate_per_night" value="${esc(rate)}" oninput="bkRecalc()"></label>
    <label>Total<input class="in" type="number" min="0" name="total_amount" value="${esc(b.total_amount??rate*Math.max(1, nights(b.check_in, b.check_out)))}"></label>
    <label>Deposit received<input class="in" type="number" min="0" name="deposit_amount" value="${esc(b.deposit_amount||0)}"></label>
    <label>Currency<input class="in" name="currency" value="${esc(b.currency||u?.currency||'INR')}"></label>
    <label class="full">Notes<textarea class="in" name="notes" placeholder="Requests, source, special occasion…">${esc(b.notes||'')}</textarea></label>
  </div>
  <div class="muted" id="bkInfo" style="margin-top:8px"></div>
  ${id&&(b.guest_phone||b.lead_id)?`<div class="row" style="margin-top:10px"><button class="btn btn-sm" onclick="closeModal();openChat(${Number(b.lead_id)||'null'},'${esc(String(b.guest_phone||'').replace(/[^\d+]/g,''))}')">💬 Chat with guest</button>${D.pro&&onAny('balance_reminders','refunds','web_checkin','prearrival_upsell','stay_messages')?`<button class="btn btn-sm" onclick="closeModal();location.hash='journey?b=${id}'">🧭 Guest journey</button>`:''}</div>`:''}`;
  const buttons=[];
  if(id){
    if(b.status==='confirmed') buttons.push({label:'Check in', onClick:()=>setStatus(id, 'checked_in')});
    if(b.status==='checked_in') buttons.push({label:'Check out', onClick:()=>setStatus(id, 'checked_out')});
    buttons.push({label:'Delete', danger:true, onClick:async()=>{ if(!confirm('Delete this booking?')) return true; await api('/hospitality/bookings', 'DELETE', {id}); toast('Deleted'); await refresh(); }});
  }
  buttons.push({label:'Cancel'});
  buttons.push({label:id?'Save':'Create booking', primary:true, onClick:async()=>{
    const v=vals();
    if(!(v.check_out>v.check_in)) throw new Error('Check-out must be after check-in');
    const body={...v, unit_id:Number(v.unit_id), adults:Number(v.adults)||1, children:Number(v.children)||0, rate_per_night:Number(v.rate_per_night)||0,
      total_amount:Number(v.total_amount)||0, deposit_amount:Number(v.deposit_amount)||0};
    if(id) await api('/hospitality/bookings', 'PATCH', {id, ...body});
    else await api('/hospitality/bookings', 'POST', body);
    toast(id?'Booking saved':'Booking created');
    await refresh();
  }});
  modal(id?`Booking #${id}`:'New booking', html, buttons);
  bkRecalc();
}
function bkRecalc(unitChanged){
  const v=vals(), n=nights(v.check_in||today(), v.check_out||today());
  const u=unitById(v.unit_id);
  const f=$('mBody');
  if(unitChanged && u){ f.querySelector('[name=rate_per_night]').value=u.base_rate||0; f.querySelector('[name=currency]').value=u.currency||'INR'; }
  const rate=Number(f.querySelector('[name=rate_per_night]').value)||0;
  if(n>0) f.querySelector('[name=total_amount]').value=Math.round(rate*n);
  const info=$('bkInfo'); if(info) info.textContent=n>0?`${n} night${n===1?'':'s'}${u?` · ${u.name} sleeps ${u.capacity_adults} adults${u.capacity_children?` + ${u.capacity_children} children`:''}`:''}`:'Check-out must be after check-in';
}

// ── Bookings ─────────────────────────────────────────────────────────────────────────────────────
let bkFilter={view:'upcoming', q:''};
function renderBookings(el){
  const t=today();
  const views={upcoming:['Upcoming', b=>b.check_in>=t && ['confirmed','inquiry'].includes(b.status)], inhouse:['In-house', b=>b.status==='checked_in'],
    inquiry:['Inquiries', b=>b.status==='inquiry'], past:['Past', b=>b.check_out<t && b.status!=='cancelled'], cancelled:['Cancelled', b=>b.status==='cancelled'], all:['All', ()=>true]};
  const q=bkFilter.q.toLowerCase();
  const list=D.bookings.filter(views[bkFilter.view][1]).filter(b=>!q || `${b.guest_name} ${b.guest_phone} ${unitName(b.unit_id)} ${b.id}`.toLowerCase().includes(q))
    .sort((a, b)=>bkFilter.view==='past'?b.check_in.localeCompare(a.check_in):a.check_in.localeCompare(b.check_in));
  el.innerHTML=`
    <div class="row" style="margin-bottom:12px">
      <div class="tabs" style="margin:0;border:0">${Object.entries(views).map(([k, [l]])=>`<button class="tab${k===bkFilter.view?' on':''}" onclick="bkFilter.view='${k}';render()">${l} <span class="muted">${D.bookings.filter(views[k][1]).length}</span></button>`).join('')}</div>
      <span class="sp"></span>
      <input class="in" id="bkQ" placeholder="Search guest, phone, ${unitWord().toLowerCase()}…" value="${esc(bkFilter.q)}" style="width:260px">
    </div>
    ${list.length?`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>Guest</th><th>${unitWord()}</th><th>Check-in</th><th>Check-out</th><th>Guests</th><th>Total</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.map(b=>`<tr class="click" onclick="editBooking(${b.id})"><td class="muted">${b.id}</td><td><b>${esc(b.guest_name||'—')}</b><div class="muted">${esc(b.guest_phone||'')}</div></td><td>${esc(unitName(b.unit_id))}</td>
      <td>${fmtDate(b.check_in)}</td><td>${fmtDate(b.check_out)}</td><td>${b.adults||1}${b.children?' + '+b.children:''}</td><td>${money(b.total_amount, b.currency)}</td><td>${statusBadge(b.status)}</td>
      <td onclick="event.stopPropagation()">${b.status==='confirmed'&&b.check_in<=t?`<button class="btn btn-sm btn-primary" onclick="setStatus(${b.id},'checked_in')">Check in</button>`:b.status==='checked_in'?`<button class="btn btn-sm" onclick="setStatus(${b.id},'checked_out')">Check out</button>`:b.status==='inquiry'?`<button class="btn btn-sm" onclick="setStatus(${b.id},'confirmed')">Confirm</button>`:''}</td></tr>`).join('')}
    </tbody></table></div>`:`<div class="card empty-state">No bookings here. <button class="btn btn-sm btn-primary" onclick="openBooking()">＋ New booking</button></div>`}
    <div class="muted" style="margin-top:8px">Showing stays from ${fmtDate(addDays(t, -45), false)} to ${fmtDate(addDays(t, 150), false)}.</div>`;
  const qi=$('bkQ');
  qi.oninput=()=>{ bkFilter.q=qi.value; clearTimeout(qi.t); qi.t=setTimeout(()=>{ const pos=qi.selectionStart; render(); const n=$('bkQ'); n.focus(); n.setSelectionRange(pos, pos); }, 200); };
}

// ── Calendar (tape chart) ────────────────────────────────────────────────────────────────────────
let cal={start:null, days:21, mode:'book', data:null};
async function renderCalendar(el){
  if(!cal.start) cal.start=addDays(today(), -2);
  const end=addDays(cal.start, cal.days);
  el.innerHTML=`<div class="row" style="margin-bottom:12px">
    <button class="btn" onclick="cal.start=addDays(cal.start,-7);render()">‹ Week</button>
    <button class="btn" onclick="cal.start=addDays(today(),-2);render()">Today</button>
    <button class="btn" onclick="cal.start=addDays(cal.start,7);render()">Week ›</button>
    <input class="in" type="date" value="${cal.start}" onchange="cal.start=this.value;render()">
    <select class="in" onchange="cal.days=Number(this.value);render()">${[14, 21, 31, 45].map(n=>opt(n, n+' days', cal.days)).join('')}</select>
    <span class="sp"></span>
    <span class="muted">Click a day to:</span>
    <div class="tabs" style="margin:0;border:0">${[['book', '＋ Book'], ['block', '⛔ Block / unblock'], ['rate', '₹ Set rate']].map(([k, l])=>`<button class="tab${cal.mode===k?' on':''}" onclick="cal.mode='${k}';render()">${l}</button>`).join('')}</div>
  </div><div id="tapeBox">${skeleton()}</div>
  <div class="row muted" style="margin-top:8px;gap:14px"><span><span class="badge green">■</span> Confirmed</span><span><span class="badge blue">■</span> In-house</span><span><span class="badge warn">■</span> Inquiry</span><span><span class="badge gray">■</span> Checked out</span><span>▨ Blocked</span><span style="color:var(--amber)">₹ amber = special rate</span></div>`;
  try{
    cal.data=await api(`/hospitality/desk/calendar?start=${cal.start}&end=${end}`);
    if(page!=='calendar') return;
    $('tapeBox').innerHTML=tapeHtml(cal.data, cal.start, cal.days);
  }catch(e){ $('tapeBox').innerHTML=errBox(e); }
}
function tapeHtml(data, start, days){
  const dates=Array.from({length:days}, (_, i)=>addDays(start, i));
  const t=today();
  const blocked={}, rates={};
  data.blocked.forEach(b=>{ blocked[b.unit_id+'|'+b.date]=b.reason||'Blocked'; });
  data.rates.forEach(r=>{ rates[r.unit_id+'|'+r.date]=r.rate; });
  const units=[...D.units].sort((a, b)=>(b.active-a.active)||a.name.localeCompare(b.name));
  const head=`<tr><th class="uh">${unitWord()}</th>${dates.map(d=>{ const w=dt(d).getUTCDay(); return `<th class="${d===t?'td':''}${w===0||w===6?' we':''}">${DOW[w]}<br>${dt(d).getUTCDate()} ${dt(d).getUTCDate()===1||d===start?MON[dt(d).getUTCMonth()]:''}</th>`; }).join('')}</tr>`;
  const rows=units.map(u=>{
    const bk=data.bookings.filter(b=>Number(b.unit_id)===Number(u.id));
    const cells=dates.map((d, i)=>{
      const key=u.id+'|'+d;
      const w=dt(d).getUTCDay();
      const rate=rates[key]!==undefined?rates[key]:(w===0||w===6)&&u.weekend_rate?u.weekend_rate:u.base_rate;
      const starts=bk.filter(b=>b.check_in===d || (i===0 && b.check_in<d && b.check_out>d));
      const bars=starts.map(b=>{ const from=b.check_in<start?start:b.check_in; const len=Math.min(nights(from, b.check_out), days-i); return `<div class="bar ${b.status}" style="width:${len*58-4}px" title="${esc(b.guest_name||'Guest')} · ${fmtDate(b.check_in, false)} → ${fmtDate(b.check_out, false)}" onclick="event.stopPropagation();editBookingFrom(${b.id})">${esc(b.guest_name||'Guest')}</div>`; }).join('');
      return `<td class="cell${blocked[key]?' blk':''}" title="${blocked[key]?esc(blocked[key]):''}" onclick="calClick(${u.id},'${d}')">${bars}<span class="rate${rates[key]!==undefined?' ov':''}">${Math.round(rate||0)}</span></td>`;
    }).join('');
    return `<tr><td class="uh" title="${esc(u.name)}">${esc(u.name)}${u.active?'':' <span class="muted">(off)</span>'}</td>${cells}</tr>`;
  }).join('');
  return `<div class="tape"><table><thead>${head}</thead><tbody>${rows||`<tr><td class="empty-state" colspan="${days+1}">No ${unitWord(true).toLowerCase()} yet.</td></tr>`}</tbody></table></div>`;
}
function editBookingFrom(id){
  const b=cal.data?.bookings.find(x=>x.id===id);
  if(b){ editBooking.extra=editBooking.extra||{}; editBooking.extra[id]=b; }
  editBooking(id);
}
async function calClick(unitId, date){
  const key=unitId+'|'+date;
  const isBlocked=cal.data?.blocked.some(b=>b.unit_id+'|'+b.date===key);
  try{
    if(cal.mode==='book'){ if(isBlocked && !confirm('This date is blocked. Book anyway?')) return; openBooking({unit_id:unitId, check_in:date, check_out:addDays(date, 1)}); return; }
    if(cal.mode==='block'){
      if(isBlocked) await api('/hospitality/blocked-dates', 'DELETE', {unit_id:unitId, date});
      else{ const reason=prompt(`Block ${unitName(unitId)} on ${fmtDate(date)} — reason (optional):`, 'Maintenance'); if(reason===null) return; await api('/hospitality/blocked-dates', 'POST', {unit_id:unitId, date, reason}); }
    }
    if(cal.mode==='rate'){
      const v=prompt(`Special rate for ${unitName(unitId)} on ${fmtDate(date)} (leave empty to clear):`, '');
      if(v===null) return;
      await api('/hospitality/rates', 'POST', {unit_id:unitId, date, rate:v.trim()===''?null:Number(v)});
    }
    renderCalendar($('view'));
  }catch(e){ toast(e.message, true); }
}

// ── Rooms / boats ────────────────────────────────────────────────────────────────────────────────
function renderRooms(el){
  const units=D.units;
  el.innerHTML=`<div class="row" style="margin-bottom:12px"><span class="muted">${units.length} ${unitWord(true).toLowerCase()} · photos, videos and resort properties are managed in <a href="#" onclick="openCrm('hospitality');return false">Classic CRM → Hospitality</a>.</span><span class="sp"></span><button class="btn btn-primary" onclick="unitForm()">＋ Add ${unitWord().toLowerCase()}</button></div>
  ${units.length?`<div class="rooms">${units.map(u=>`<div class="room" style="cursor:pointer;opacity:${u.active?1:.55}" onclick="unitForm(${u.id})">
    ${u.image_url_1&&/^https:\/\//.test(u.image_url_1)&&!/drive\.google/.test(u.image_url_1)?`<img src="${esc(u.image_url_1)}" alt="" loading="lazy" style="width:100%;height:110px;object-fit:cover;border-radius:8px;margin-bottom:8px">`:''}
    <b>${esc(u.name)}</b><div class="muted">${esc(u.unit_type||unitWord())} · ${u.capacity_adults} adults${u.capacity_children?` + ${u.capacity_children} kids`:''}</div>
    <div style="margin-top:6px"><b>${money(u.base_rate, u.currency)}</b><span class="muted"> / night${u.weekend_rate?` · weekend ${money(u.weekend_rate, u.currency)}`:''}</span></div>
    ${u.active?'':'<span class="badge gray">Inactive</span>'}</div>`).join('')}</div>`:`<div class="card empty-state">No ${unitWord(true).toLowerCase()} yet — add your first one.</div>`}`;
}
function unitForm(id){
  const u=id?unitById(id):{name:'', unit_type:'', capacity_adults:2, capacity_children:0, base_rate:0, weekend_rate:'', currency:'INR', active:1, amenities:'', description:''};
  modal(id?`Edit ${u.name}`:`Add ${unitWord().toLowerCase()}`, `<div class="form-grid">
    <label>Name<input class="in" name="name" value="${esc(u.name)}" placeholder="${isBoat()?'Kayal Queen':'Lake View Villa'}"></label>
    <label>Type<input class="in" name="unit_type" value="${esc(u.unit_type||'')}" placeholder="${isBoat()?'Premium · 2 bedroom':'Deluxe'}"></label>
    <label>Adults<input class="in" type="number" min="1" name="capacity_adults" value="${esc(u.capacity_adults)}"></label>
    <label>Children<input class="in" type="number" min="0" name="capacity_children" value="${esc(u.capacity_children)}"></label>
    <label>Rate / night<input class="in" type="number" min="0" name="base_rate" value="${esc(u.base_rate)}"></label>
    <label>Weekend rate (Sat & Sun)<input class="in" type="number" min="0" name="weekend_rate" value="${esc(u.weekend_rate??'')}" placeholder="Same as rate"></label>
    <label>Currency<input class="in" name="currency" value="${esc(u.currency||'INR')}"></label>
    <label>Status<select class="in" name="active">${opt(1, 'Active — can be booked', u.active?1:0)}${opt(0, 'Inactive', u.active?1:0)}</select></label>
    <label class="full">Amenities<input class="in" name="amenities" value="${esc(u.amenities||'')}" placeholder="AC, upper deck, Wi-Fi…"></label>
    <label class="full">Description (the bot uses this)<textarea class="in" name="description">${esc(u.description||'')}</textarea></label></div>`,
  [...(id?[{label:'Delete', danger:true, onClick:async()=>{ if(!confirm(`Delete ${u.name}? Its bookings stay.`)) return true; await api('/hospitality/units', 'DELETE', {id}); toast('Deleted'); await refresh(); }}]:[]),
   {label:'Cancel'}, {label:'Save', primary:true, onClick:async()=>{
     const v=vals();
     if(!v.name.trim()) throw new Error('Name is required');
     const body={...v, capacity_adults:Number(v.capacity_adults)||1, capacity_children:Number(v.capacity_children)||0, base_rate:Number(v.base_rate)||0,
       weekend_rate:v.weekend_rate===''?null:Number(v.weekend_rate), active:v.active==='1'};
     if(id) await api('/hospitality/units', 'PATCH', {id, ...body}); else await api('/hospitality/units', 'POST', body);
     toast('Saved'); await refresh();
   }}]);
}

// ── Guests (from bookings; Pro Suite "Guest profiles" adds memory on top) ───────────────────────
async function renderGuests(el){
  if(on('guest_profiles')){ el.innerHTML=skeleton(); await loadScript('hospitality-desk-suite.js?v=1'); return window.HSX.render('profiles', el); }
  el.innerHTML=skeleton();
  try{
    const all=(await api('/hospitality/bookings')).list||[];
    const t=today(), map=new Map();
    for(const b of all){
      if(!occupying(b)) continue;
      const key=String(b.guest_phone||'').replace(/\D/g,'').slice(-10)||('n:'+String(b.guest_name||'').toLowerCase());
      const g=map.get(key)||{name:b.guest_name, phone:b.guest_phone, stays:0, nights:0, spent:0, last:null, next:null};
      if(b.check_out<=t || b.status==='checked_out'){ g.stays++; g.nights+=nights(b.check_in, b.check_out); g.spent+=Number(b.total_amount)||0; if(!g.last||b.check_out>g.last) g.last=b.check_out; }
      else if(!g.next||b.check_in<g.next) g.next=b.check_in;
      if(b.guest_name) g.name=b.guest_name;
      map.set(key, g);
    }
    const list=[...map.values()].sort((a, b)=>b.stays-a.stays||b.spent-a.spent);
    el.innerHTML=`<div class="muted" style="margin-bottom:10px">${list.length} guests from your bookings.${D.pro?' Switch on <b>Guest profiles</b> in Settings to save birthdays, anniversaries and preferences.':''}</div>
    ${list.length?`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Guest</th><th>Phone</th><th>Stays</th><th>Nights</th><th>Spent</th><th>Last stay</th><th>Next stay</th><th></th></tr></thead><tbody>
    ${list.map(g=>`<tr><td><b>${esc(g.name||'—')}</b>${g.stays>=3?' <span class="badge green">Regular</span>':''}</td><td>${esc(g.phone||'')}</td><td>${g.stays}</td><td>${g.nights}</td><td>${money(g.spent)}</td><td>${g.last?fmtDate(g.last, false):'—'}</td><td>${g.next?fmtDate(g.next, false):'—'}</td>
      <td>${chatBtn(null, g.phone)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="card empty-state">No guests yet.</div>'}`;
  }catch(e){ el.innerHTML=errBox(e); }
}

// ── Chats (chats.html, embedded once and kept alive) ────────────────────────────────────────────
function mountChats(){
  const host=$('chatsHost');
  if(host.firstChild) return;
  const f=document.createElement('iframe');
  f.title='Chats'; f.allow='microphone; clipboard-write; autoplay';
  f.src='chats.html?'+new URLSearchParams({client:clientId, token:sessionToken, embed:'1'});
  host.appendChild(f);
}

// ── Direct Sales (existing Hospitality Pro screens, reused as-is) ───────────────────────────────
async function renderSales(el){
  el.innerHTML=skeleton();
  try{
    await loadScript('hospitality-pro.js?v=1');
    if(page!=='sales') return;
    el.innerHTML='<div id="hospContent"></div>';
    window.renderHospPro($('hospContent'));
  }catch(e){ el.innerHTML=errBox(e); }
}

// ── Settings ─────────────────────────────────────────────────────────────────────────────────────
async function renderSettings(el){
  if(D.pro){ el.innerHTML=skeleton(); await loadScript('hospitality-desk-suite.js?v=1'); return window.HSX.render('settings', el); }
  el.innerHTML=`<div class="card"><div class="card-title">🏨 Hospitality</div>
    <div class="muted">Type of business, greeting photos, unit photos and resort properties are set in <a href="#" onclick="openCrm('hospitality');return false">Classic CRM → Hospitality</a>.</div></div>
    <div class="card"><div class="card-title">⭐ Hospitality Pro is not switched on</div>
    <p class="muted" style="margin-top:0">Pro adds instant WhatsApp quotes with "Hold this room" and deposits, add-ons, loyalty, group enquiries and abandoned-inquiry recovery — plus six Pro Suite modules, each feature with its own switch:</p>
    <ul class="muted"><li>Guest Journey — balance reminders, web check-in with ID scan, pre-arrival upsell</li><li>Houseboat Operations — fleet, cruise plan, weather alerts, crew, meal pre-order, pickup, maintenance</li>
    <li>Revenue & Channels — OTA calendar sync, smart pricing, competitor rates, daily summary</li><li>Housekeeping & Staff — room board, auto cleaning tasks, staff WhatsApp bot</li>
    <li>Reviews & Guest Memory — feedback, Google reviews, AI replies, rebooking and birthday offers</li><li>Agent Desk — agents, WhatsApp agent quotes, allotments, commissions</li></ul>
    <button class="btn btn-primary" onclick="openCrm('modules')">Turn on in Classic CRM → Modules</button></div>`;
}

// ── Boot ─────────────────────────────────────────────────────────────────────────────────────────
(function boot(){
  try{ const c=JSON.parse(localStorage.getItem(CACHE_KEY)||'null'); if(c?.d?.client) applyData(c.d); }catch(e){}
  render();
  refresh();
  setTimeout(touchSession, 1500);
  // Keep Today fresh while the desk is left open.
  setInterval(()=>{ if(document.visibilityState==='visible' && ['today','bookings'].includes(page)) refresh(); }, 5*60*1000);
  document.addEventListener('keydown', e=>{ if(e.key==='Escape') closeModal(); });
})();
