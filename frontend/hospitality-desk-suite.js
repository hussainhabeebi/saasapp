/* ── Hospitality workspace — Pro Suite screens (loaded on demand by hospitality-desk.js) ─────────
   Settings (one switch per feature), Alerts, Guest Journey, Agent Desk, Housekeeping, Tasks &
   Staff, Cruise Day, Fleet & Maintenance, Kitchen & Menu, Smart Pricing, Channels (iCal),
   Competitors, Daily Insights, Guest Feedback, Review Replies and Guest Profiles — all backed by
   cloudflare-worker/hospitality-suite.js (/hospitality/suite/*). Uses hospitality-desk.js's
   globals (api, D, esc, modal, vals, toast, money, fmtDate, on, onAny, refresh, render…). ── */
'use strict';
const S='/hospitality/suite/';
const sapi=(p, m, b)=>api(S+p, m, b);
const slist=async p=>(await sapi(p)).list||[];
const HS_DESC={
  balance_reminders:'Sends the balance due with a payment link (Razorpay when connected) before arrival — e.g. 7 days and 1 day before.',
  refunds:'A payments ledger per booking: deposits, balances, extras and refunds, with the balance worked out for you.',
  web_checkin:'Before arrival the guest shares arrival time, preferences and ID photos on WhatsApp — no paperwork at the desk.',
  id_scan:'Reads name, ID type, number, date of birth and nationality from the ID photos (Aadhaar stored masked).',
  prearrival_upsell:'A few days before arrival, offers your add-ons and an upgrade to a better room that is free on those dates.',
  stay_messages:'Welcome message on arrival day and a check-out reminder with the bill summary.',
  instay_requests:'In-house guests\' WhatsApp requests ("need towels", "AC not working") become staff tasks automatically.',
  fleet:'Bedrooms, deck, AC / non-AC and day-cruise / overnight / night-stay rates for each boat.',
  cruise_plan:'Jetties with boarding and cruising hours, and a day sheet of every departure with its timeline.',
  weather_alerts:'Checks the forecast for each departure; warns guests and your team about heavy rain or strong wind.',
  crew:'Assign cook, driver and helper to each booking; double-booked crew are flagged.',
  meal_preorder:'Guests pick their Kerala menu on WhatsApp before boarding; the cook gets a kitchen sheet.',
  pickup:'Jetty location, boarding time and captain\'s contact the evening before, plus "boat ready" updates.',
  maintenance:'Fuel and service log per boat, with an alert when the engine service is due.',
  ical_sync:'Two-way calendar sync with Airbnb, Booking.com, Agoda and MakeMyTrip using their iCal links.',
  pricing_rules:'Weekend, season, festival, high-demand and last-minute rules suggest rates; you approve before anything changes.',
  competitor_rates:'Log competitors\' prices and get alerted when one drops well below yours.',
  daily_summary:'A plain-language morning summary — occupancy, arrivals, balances due, tasks — on screen and to the owner\'s WhatsApp.',
  housekeeping:'Room / boat status board and automatic clean and prepare tasks from check-outs and arrivals.',
  staff_tasks:'Tasks and maintenance tickets with priority, assignee and a one-click WhatsApp to the staff member.',
  staff_bot:'Staff message your WhatsApp number: "tasks", "done 12", "issue: AC leaking in Villa 2".',
  guest_profiles:'Remembers birthdays, anniversaries, preferences and notes for every guest.',
  feedback:'After check-out guests rate their stay; 4–5★ get your Google review link, 1–3★ alert the manager.',
  review_replies:'Paste a Google / TripAdvisor review and get a warm, specific reply drafted by AI.',
  rebooking:'A returning-guest offer some weeks after check-out.',
  occasions:'Birthday and anniversary offers sent a few days ahead.',
  agents:'Your travel agents with their commission and credit limit.',
  agent_quotes:'Registered agents get net rates on WhatsApp and can request a booking in one tap.',
  allotments:'Hold rooms or boats for an agent; they are released automatically before the date.',
  commissions:'Commission due per agent booking, marked paid when settled.',
};
function sw(checked, onchange){ return `<label class="sw"><input type="checkbox" ${checked?'checked':''} onchange="${onchange}"><span></span></label>`; }
function fld(f, v){
  const val=v??f.d??'';
  const attrs=`class="in" name="${f.n}"${f.ph?` placeholder="${esc(f.ph)}"`:''}`;
  let input;
  if(f.t==='select') input=`<select ${attrs}>${f.o.map(([k, l])=>opt(k, l, val)).join('')}</select>`;
  else if(f.t==='textarea') input=`<textarea ${attrs}>${esc(val)}</textarea>`;
  else if(f.t==='checkbox') input=`<select ${attrs}>${opt(1, 'Yes', val?1:0)}${opt(0, 'No', val?1:0)}</select>`;
  else input=`<input ${attrs} type="${f.t||'text'}"${f.t==='number'?' step="any"':''} value="${esc(val)}">`;
  return `<label class="${f.full?'full':''}">${esc(f.l)}${input}${f.hint?`<span class="muted" style="font-weight:400">${esc(f.hint)}</span>`:''}</label>`;
}
function formModal(title, fields, values, onSave, extra=[]){
  modal(title, `<div class="form-grid">${fields.map(f=>fld(f, values?.[f.n])).join('')}</div>`, [...extra, {label:'Cancel'}, {label:'Save', primary:true, onClick:async()=>{
    const v=vals();
    fields.forEach(f=>{ if(f.t==='number' && v[f.n]!==undefined) v[f.n]=v[f.n]===''?null:Number(v[f.n]); if(f.t==='checkbox') v[f.n]=v[f.n]==='1'; });
    await onSave(v);
  }}]);
}
function tabs(list, cur, fn){ return `<div class="tabs">${list.filter(t=>t[2]!==false).map(([k, l])=>`<button class="tab${k===cur?' on':''}" onclick="${fn}('${k}')">${l}</button>`).join('')}</div>`; }
function tbl(head, rows, empty){ return rows.length?`<div class="tbl-wrap"><table class="tbl"><thead><tr>${head.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`:`<div class="card empty-state">${empty}</div>`; }
function bookingsIn(from, to){ return D.bookings.filter(b=>['confirmed','checked_in','inquiry'].includes(b.status) && b.check_out>=from && b.check_in<=to).sort((a, b)=>a.check_in.localeCompare(b.check_in)); }
const SUB={}; // remembered sub-tab per page
function rerender(){ window.HSX.render(page, $('view')); }

const R={};
window.HSX={render(key, el){ const fn=R[key]; if(!fn){ el.innerHTML=errBox(new Error('Unknown page')); return; } Promise.resolve(fn(el)).catch(e=>{ el.innerHTML=errBox(e); }); }};

// ── Settings: one switch per feature, grouped by module, plus their options ─────────────────────
let settingsCache=null;
R.settings=async el=>{
  el.innerHTML=skeleton();
  settingsCache=await sapi('settings');
  const cfg=settingsCache.config, mods=settingsCache.modules, req=settingsCache.requires||{};
  const label=k=>{ for(const m of mods) if(m.features[k]) return m.features[k]; return k; };
  const modOn=m=>Object.keys(m.features).some(k=>cfg.features[k]);
  const opt2=(k, l, t='number', hint='', ph='')=>fld({n:k, l, t, hint, ph}, Array.isArray(cfg[k])?cfg[k].join(', '):cfg[k]);
  const optCards=[
    ['journey', 'Guest Journey', [opt2('balance_days', 'Balance reminder — days before arrival', 'text', 'Up to 3, e.g. 7, 1'), opt2('checkin_days', 'Web check-in invite — days before'), opt2('upsell_days', 'Upsell offer — days before'),
      opt2('welcome_hour', 'Welcome message hour (0–23)'), opt2('checkout_hour', 'Check-out reminder hour (0–23)'),
      fld({n:'welcome_text', l:'Welcome text (Wi-Fi, timings…)', t:'textarea', full:true}, cfg.welcome_text), fld({n:'checkout_text', l:'Check-out text', t:'textarea', full:true}, cfg.checkout_text),
      fld({n:'instay_reply', l:'Reply to in-stay requests', full:true, ph:'Got it! Our team will take care of it shortly.'}, cfg.instay_reply)]],
    ['houseboat', 'Houseboat Operations', [opt2('meal_days', 'Meal menu — days before boarding'), opt2('pickup_hour', 'Pickup details — hour the evening before'),
      opt2('weather_lat', 'Property latitude', 'number', 'Used when a boat has no jetty location'), opt2('weather_lng', 'Property longitude'),
      opt2('rain_mm', 'Rain alert at (mm / day)'), opt2('wind_kmh', 'Wind alert at (km/h)'), fld({n:'pickup_text', l:'Extra pickup instructions', t:'textarea', full:true}, cfg.pickup_text)]],
    ['revenue', 'Revenue & Channels', [opt2('summary_hour', 'Daily summary hour (0–23)'), opt2('competitor_alert_pct', 'Competitor alert when cheaper by (%)'), opt2('ical_sync_minutes', 'OTA calendar sync every (minutes)')]],
    ['reviews', 'Reviews & Guest Memory', [opt2('feedback_hour', 'Feedback request hour on check-out day'), fld({n:'google_review_url', l:'Google review link', ph:'https://g.page/r/…'}, cfg.google_review_url),
      opt2('rebook_days', 'Rebooking offer — days after check-out'), opt2('offer_pct', 'Returning-guest / occasion discount (%)'), opt2('occasion_days', 'Birthday / anniversary offer — days before'),
      fld({n:'offer_text', l:'Offer details (code, terms)', t:'textarea', full:true}, cfg.offer_text)]],
  ];
  el.innerHTML=`
    <div class="card"><div class="card-title">⭐ Hospitality Pro Suite<span class="sp"></span><span class="muted" style="font-weight:400">Every feature has its own switch and starts off. Screens appear in the menu as you switch them on.</span></div>
      <div class="grid g2">${mods.map(m=>`<div class="card" style="margin:0;box-shadow:none"><div class="card-title">${esc(m.label)}${modOn(m)?' <span class="badge green">On</span>':''}</div>
        ${Object.entries(m.features).map(([k, l])=>`<div class="feat">${sw(cfg.features[k], `hsToggle('${k}',this.checked)`)}<div style="flex:1"><b>${esc(l)}</b>${req[k]?` <span class="muted">· needs “${esc(label(req[k]))}”</span>`:''}<div class="muted">${esc(HS_DESC[k]||'')}</div></div></div>`).join('')}
      </div>`).join('')}</div></div>
    <div class="card"><div class="card-title">💬 Messages outside WhatsApp's 24-hour window</div>
      <p class="muted" style="margin-top:0">Reminders sent days before arrival (balance, check-in, pre-arrival offers, rebooking, owner summary) need an approved WhatsApp template. Create a <b>Utility</b> template whose body is <code>Hi {{1}}, {{2}}</code> and enter its name here. Without one, these messages go out only if the guest wrote in the last 24 hours — otherwise they appear under 🔔 Alerts with a one-click WhatsApp link for your team. Quiet hours and payment details come from Direct Sales → Settings.</p>
      <div class="form-grid" id="hsMsg">${fld({n:'template_name', l:'Template name', ph:'hospitality_update'}, cfg.template_name)}${fld({n:'template_lang', l:'Template language code', ph:'en'}, cfg.template_lang)}
      ${fld({n:'owner_phone', l:'Owner\'s WhatsApp number (daily summary)', ph:'+91…'}, cfg.owner_phone)}</div></div>
    ${optCards.filter(([k])=>{ const m=mods.find(x=>x.key===k); return m&&modOn(m); }).map(([k, t, f])=>`<div class="card"><div class="card-title">${esc(t)} — options</div><div class="form-grid">${f.join('')}</div></div>`).join('')}
    <div class="row end" style="margin-bottom:14px"><button class="btn btn-primary" onclick="hsSaveOptions()">Save options</button></div>
    <div class="card"><div class="card-title">🏨 Hospitality basics</div><div class="muted">Business type, greeting photos, unit photos and resort properties: <a href="#" onclick="openCrm('hospitality');return false">Classic CRM → Hospitality</a>. Quote, deposit, loyalty and recovery settings: <a href="#sales">Direct Sales → Settings</a>.</div></div>`;
};
function label2(k){ for(const m of settingsCache?.modules||[]) if(m.features[k]) return m.features[k]; return k; }
async function hsToggle(k, val){
  try{
    const r=await sapi('settings', 'PATCH', {config:{features:{[k]:val}}});
    settingsCache.config=r.config;
    if(D.pro) D.pro.suite=r.config.features;
    renderNav();
    toast(`${label2(k)} — ${val?'on':'off'}`);
    R.settings($('view'));
  }catch(e){ toast(e.message, true); }
}
async function hsSaveOptions(){
  const v=vals($('view'));
  const nums=['checkin_days','upsell_days','welcome_hour','checkout_hour','meal_days','pickup_hour','rain_mm','wind_kmh','summary_hour','competitor_alert_pct','ical_sync_minutes','feedback_hour','rebook_days','offer_pct','occasion_days'];
  nums.forEach(k=>{ if(k in v) v[k]=v[k]===''?null:Number(v[k]); });
  ['weather_lat','weather_lng'].forEach(k=>{ if(k in v) v[k]=v[k]===''?null:Number(v[k]); });
  if('balance_days' in v) v.balance_days=String(v.balance_days).split(/[,\s]+/).filter(Boolean).map(Number);
  try{ const r=await sapi('settings', 'PATCH', {config:v}); settingsCache.config=r.config; toast('Options saved'); R.settings($('view')); }
  catch(e){ toast(e.message, true); }
}

// ── Alerts ───────────────────────────────────────────────────────────────────────────────────────
const ALERT_IC={weather:'🌧️', low_rating:'😟', feedback:'📝', competitor:'📉', service:'🛠️', unsent:'✉️', payment:'💳', agent:'🤝'};
R.alerts=async el=>{
  el.innerHTML=skeleton();
  const list=await slist('alerts'); window._alerts=list;
  const open=list.filter(a=>a.status==='open');
  el.innerHTML=`<div class="row" style="margin-bottom:12px"><span class="muted">${open.length} open</span><span class="sp"></span>${open.length?'<button class="btn" onclick="hsAlertDone(0,true)">Mark all done</button>':''}</div>
  ${list.length?list.map(a=>{
    const phone=a.kind==='unsent'?String(a.ref).split('|')[1]:'';
    return `<div class="card" style="opacity:${a.status==='open'?1:.55};padding:12px 14px"><div class="row"><span style="font-size:20px">${ALERT_IC[a.kind]||'🔔'}</span><div style="flex:1;min-width:0"><b>${esc(a.title)}</b>
      <div class="muted" style="white-space:pre-wrap">${esc(a.body).slice(0,600)}</div><div class="muted">${new Date(a.created_at).toLocaleString()}</div></div>
      ${phone?`<button class="btn btn-sm" onclick="hsAlertChat(${a.id})">Open chat & copy message</button>`:''}
      ${a.status==='open'?`<button class="btn btn-sm" onclick="hsAlertDone(${a.id})">Done</button>`:'<span class="badge gray">Done</span>'}</div></div>`;
  }).join(''):'<div class="card empty-state">🎉 No alerts.</div>'}`;
};
function hsAlertChat(id){ const a=(window._alerts||[]).find(x=>x.id===id); if(a) openChat(null, String(a.ref).split('|')[1]||'', a.body); }
async function hsAlertDone(id, all){ try{ await sapi('alerts', 'PATCH', all?{all:true}:{id, status:'done'}); await refresh(); }catch(e){ toast(e.message, true); } }

// ── Guest Journey ────────────────────────────────────────────────────────────────────────────────
let jr={from:null, to:null, list:[]};
const SENT_LABEL={bal_7:'Balance', bal_1:'Balance', checkin:'Check-in', upsell:'Upsell', meal:'Meals', pickup:'Pickup', weather:'Weather', welcome:'Welcome', checkout:'Check-out', feedback:'Feedback', rebook:'Rebook'};
R.journey=async el=>{
  jr.from=jr.from||addDays(today(), -1); jr.to=jr.to||addDays(today(), 30);
  el.innerHTML=`<div class="row" style="margin-bottom:12px"><span class="muted">Stays between</span><input class="in" type="date" value="${jr.from}" onchange="jr.from=this.value;rerender()"><span class="muted">and</span><input class="in" type="date" value="${jr.to}" onchange="jr.to=this.value;rerender()"><span class="sp"></span><span class="muted">Messages go out automatically; use a row to send one now.</span></div><div id="jrBox">${skeleton()}</div>`;
  const d=await sapi(`journey?from=${jr.from}&to=${jr.to}`);
  jr.list=d.list;
  const chips=s=>Object.entries(s||{}).filter(([, v])=>v.s!=='none' && v.s!=='clear').map(([k, v])=>`<span class="badge ${v.s==='skipped'?'red':v.s==='template'?'blue':'green'}" title="${esc(v.s)} · ${new Date(v.at).toLocaleString()}">${esc(SENT_LABEL[k]||k)}</span>`).join(' ');
  $('jrBox').innerHTML=tbl(['Guest', 'Stay', 'Total', 'Paid', 'Balance', 'Check-in', 'Extras', 'Messages', ''], d.list.map(b=>{
    const m=b.money, s=b.suite||{};
    return `<tr class="click" onclick="jrOpen(${b.id})"><td><b>${esc(b.guest_name||'—')}</b><div class="muted">${esc(b.unit_name||'')}</div></td><td>${fmtDate(b.check_in, false)} → ${fmtDate(b.check_out, false)}</td>
      <td>${money(m.total, m.currency)}</td><td>${money(m.received, m.currency)}</td><td>${m.balance>0?`<b style="color:var(--amber)">${money(m.balance, m.currency)}</b>`:'<span class="badge green">Paid</span>'}</td>
      <td>${s.checkin_status==='done'?'<span class="badge green">Done</span>':s.checkin_status?'<span class="badge warn">Started</span>':'<span class="muted">—</span>'}${s.eta?` <span class="muted">ETA ${esc(s.eta)}</span>`:''}${b.id_count?` <span class="muted">· ${b.id_count} ID</span>`:''}</td>
      <td>${b.extras.filter(x=>x.status!=='cancelled').length||'—'}</td><td>${chips(s.sent)||'<span class="muted">—</span>'}</td><td><button class="btn btn-sm">Open</button></td></tr>`;
  }), 'No confirmed stays in this period.');
  const want=new URLSearchParams((location.hash.split('?')[1])||'').get('b');
  if(want) jrOpen(Number(want));
};
async function jrOpen(id){
  let b=jr.list.find(x=>x.id===id);
  if(!b){ toast('That booking is outside the dates shown', true); return; }
  const m=b.money, s=b.suite||{};
  let ids=[];
  if(b.id_count) ids=(await sapi(`idscans?booking_id=${id}`).catch(()=>({list:[]}))).list;
  const sendBtn=(k, l, f)=>f?`<button class="btn btn-sm" onclick="jrSend(${id},'${k}')">${l}</button>`:'';
  modal(`${b.guest_name||'Guest'} · ${b.unit_name||''}`, `
    <div class="row" style="margin-bottom:10px"><span>${fmtDate(b.check_in)} → ${fmtDate(b.check_out)}</span>${statusBadge(b.status)}<span class="sp"></span>${chatBtn(b.lead_id, b.guest_phone, '💬 Chat')}</div>
    <div class="kpis" style="grid-template-columns:repeat(4,1fr)"><div class="stat"><div class="stat-lbl">Total</div><div class="stat-val" style="font-size:18px">${money(m.total, m.currency)}</div></div>
      <div class="stat"><div class="stat-lbl">Received</div><div class="stat-val" style="font-size:18px">${money(m.received, m.currency)}</div></div>
      <div class="stat${m.balance>0?' accent':''}"><div class="stat-lbl">Balance</div><div class="stat-val" style="font-size:18px">${money(m.balance, m.currency)}</div></div>
      <div class="stat"><div class="stat-lbl">Refunded</div><div class="stat-val" style="font-size:18px">${money(m.refunded, m.currency)}</div></div></div>
    <div class="card-title">💳 Payments <span class="sp"></span>${onAny('refunds','balance_reminders')?`<button class="btn btn-sm" onclick="jrPay(${id})">＋ Record payment / refund</button>`:''}</div>
    ${b.payments.length?b.payments.map(p=>`<div class="list-item"><div class="li-main"><b>${esc(p.kind)} · ${money(p.amount, m.currency)}</b><span class="muted">${esc(p.method||'')} ${esc(p.ref||'')} · ${new Date(p.created_at).toLocaleDateString()}</span></div><span class="badge ${p.status==='paid'?'green':p.status==='refunded'?'blue':'warn'}">${esc(p.status)}</span><button class="btn-ghost" onclick="jrPayDel(${p.id},${id})">✕</button></div>`).join(''):`<div class="muted">Deposit on booking: ${money(b.deposit_amount, m.currency)}</div>`}
    <div class="card-title" style="margin-top:14px">✨ Extras <span class="sp"></span><button class="btn btn-sm" onclick="jrExtra(${id})">＋ Add extra</button></div>
    ${b.extras.length?b.extras.map(x=>`<div class="list-item"><div class="li-main"><b>${esc(x.name)} · ${money(x.amount, m.currency)}</b><span class="muted">${esc(x.source)}</span></div><span class="badge ${x.status==='confirmed'?'green':x.status==='cancelled'?'gray':'warn'}">${esc(x.status)}</span>
      ${x.status!=='confirmed'?`<button class="btn btn-sm" onclick="jrExtraSet(${x.id},'confirmed',${id})">Confirm</button>`:''}${x.status!=='cancelled'?`<button class="btn-ghost" onclick="jrExtraSet(${x.id},'cancelled',${id})">Cancel</button>`:''}</div>`).join(''):'<div class="muted">None yet.</div>'}
    <div class="card-title" style="margin-top:14px">📋 Check-in</div>
    <div class="form-grid" id="jrCi">${fld({n:'eta', l:'Arrival time', ph:'14:30'}, s.eta)}${fld({n:'checkin_status', l:'Status', t:'select', o:[['', 'Not started'], ['started', 'Started'], ['done', 'Done']]}, s.checkin_status)}${fld({n:'preferences', l:'Preferences', t:'textarea', full:true}, s.preferences)}</div>
    <div class="row end" style="margin-top:6px"><button class="btn btn-sm" onclick="jrSaveCi(${id})">Save check-in details</button></div>
    ${ids.length?`<div style="margin-top:8px">${ids.map(x=>`<div class="list-item"><div class="li-main"><b>${esc(x.fields.name||'ID document')}</b><span class="muted">${esc([x.fields.id_type, x.fields.id_number, x.fields.dob, x.fields.nationality].filter(Boolean).join(' · ')||'Not read')}</span></div><a class="btn btn-sm" target="_blank" rel="noopener" href="${esc(x.image_url)}">View photo</a></div>`).join('')}</div>`:''}
    <div class="card-title" style="margin-top:14px">💬 Send now</div>
    <div class="row">${sendBtn('balance', 'Balance reminder', m.balance>0 && on('balance_reminders'))}${sendBtn('checkin', 'Check-in invite', on('web_checkin'))}${sendBtn('upsell', 'Upsell offer', on('prearrival_upsell'))}
      ${sendBtn('meal', 'Meal menu', on('meal_preorder'))}${sendBtn('pickup', 'Pickup details', on('pickup'))}${sendBtn('welcome', 'Welcome', on('stay_messages'))}${sendBtn('checkout', 'Check-out', on('stay_messages'))}${sendBtn('feedback', 'Feedback request', on('feedback'))}</div>`,
    [{label:'Close'}]);
}
async function jrReload(id){ await R.journey($('view')); if(id) jrOpen(id); }
async function jrSend(id, kind){
  try{
    const r=await sapi('journey/send', 'POST', {booking_id:id, kind});
    if(r.ok) toast(r.status==='template'?'Sent as WhatsApp template':'Sent on WhatsApp');
    else{ toast('Not sent — the guest hasn\'t written in 24h and no template is set (see Settings).', true); if(r.wa_link) openChatFromLink(r.wa_link, (jr.list.find(x=>x.id===id)||{}).lead_id); }
    jrReload(id);
  }catch(e){ toast(e.message, true); }
}
function jrPay(id){
  formModal('Record payment / refund', [{n:'kind', l:'Type', t:'select', o:[['balance', 'Balance payment'], ['deposit', 'Deposit'], ['extra', 'Extras payment'], ['refund', 'Refund']]},
    {n:'amount', l:'Amount', t:'number'}, {n:'method', l:'Method', t:'select', o:[['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card'], ['bank', 'Bank transfer'], ['razorpay', 'Razorpay'], ['other', 'Other']]},
    {n:'status', l:'Status', t:'select', o:[['paid', 'Paid / done'], ['pending', 'Pending']]}, {n:'ref', l:'Reference'}, {n:'note', l:'Note'}],
  {kind:'balance', method:'upi', status:'paid'}, async v=>{ await sapi('payments', 'POST', {booking_id:id, ...v}); toast('Recorded'); jrReload(id); });
}
async function jrPayDel(pid, id){ if(!confirm('Remove this payment line?')) return; try{ await sapi('payments', 'DELETE', {id:pid}); jrReload(id); }catch(e){ toast(e.message, true); } }
function jrExtra(id){ formModal('Add extra', [{n:'name', l:'What', ph:'Candlelight dinner'}, {n:'amount', l:'Amount', t:'number'}], {}, async v=>{ await sapi('extras', 'POST', {booking_id:id, ...v}); toast('Added'); jrReload(id); }); }
async function jrExtraSet(xid, status, id){ try{ await sapi('extras', 'PATCH', {id:xid, status}); jrReload(id); }catch(e){ toast(e.message, true); } }
async function jrSaveCi(id){ try{ await sapi('booking', 'PATCH', {booking_id:id, ...vals($('jrCi'))}); toast('Saved'); jrReload(id); }catch(e){ toast(e.message, true); } }

// ── Agent Desk ───────────────────────────────────────────────────────────────────────────────────
R.agents=async el=>{
  const cur=SUB.agents||'agents';
  el.innerHTML=tabs([['agents', 'Agents'], ['requests', 'Bookings & commissions'], ['allot', 'Allotments', on('allotments')]], cur, 'agTab')+`<div id="agBox">${skeleton()}</div>`;
  const box=$('agBox');
  const agents=await slist('agents');
  if(cur==='agents'){
    box.innerHTML=`<div class="row end" style="margin-bottom:10px"><span class="muted" style="flex:1">${on('agent_quotes')?'Agents message your WhatsApp number with dates and guests to get net rates and request a booking.':'Switch on “Agent quotes on WhatsApp” in Settings to let agents get rates themselves.'}</span><button class="btn btn-primary" onclick="agForm()">＋ Add agent</button></div>`+
      tbl(['Agent', 'Company', 'WhatsApp', 'Commission', 'Credit limit', 'Status'], agents.map(a=>`<tr class="click" onclick="agForm(${a.id})"><td><b>${esc(a.name)}</b></td><td>${esc(a.company)}</td><td>${esc(a.phone)}</td><td>${a.commission_pct}%</td><td>${a.credit_limit?money(a.credit_limit):'—'}</td><td>${a.active?'<span class="badge green">Active</span>':'<span class="badge gray">Off</span>'}</td></tr>`), 'No agents yet.');
    window._agents=agents;
  }else if(cur==='requests'){
    const list=await slist('agent-bookings');
    const due=list.filter(x=>x.commission_status==='due' && x.status!=='cancelled').reduce((s, x)=>s+Number(x.commission_amount||0), 0);
    box.innerHTML=`<div class="kpis"><div class="stat"><div class="stat-lbl">Requests to confirm</div><div class="stat-val">${list.filter(x=>x.status==='inquiry').length}</div></div><div class="stat accent"><div class="stat-lbl">Commission due</div><div class="stat-val">${money(due)}</div></div></div>`+
      tbl(['#', 'Agent', 'Guest', 'Stay', 'Total', 'Commission', 'Status', ''], list.map(x=>`<tr><td class="muted">${x.booking_id}</td><td>${esc(x.agent_name||'—')}</td><td>${esc(x.guest_name||'')}</td><td>${esc(x.unit_name||'')}<div class="muted">${fmtDate(x.check_in, false)} → ${fmtDate(x.check_out, false)}</div></td>
        <td>${money(x.total_amount, x.currency)}</td><td>${money(x.commission_amount, x.currency)} <span class="badge ${x.commission_status==='paid'?'green':x.commission_status==='void'?'gray':'warn'}">${esc(x.commission_status||'due')}</span></td><td>${statusBadge(x.status)}</td>
        <td>${x.status==='inquiry'?`<button class="btn btn-sm btn-primary" onclick="agConfirm(${x.booking_id})">Confirm</button>`:''}${on('commissions')&&x.commission_status==='due'&&x.status!=='inquiry'?`<button class="btn btn-sm" onclick="agPaid(${x.booking_id})">Mark paid</button>`:''}</td></tr>`), 'No agent bookings yet. Agent requests from WhatsApp appear here; you can also link any booking to an agent below.')+
      `<div class="card" style="margin-top:14px"><div class="card-title">Link a booking to an agent</div><div class="row"><select class="in" id="agLinkB">${D.bookings.filter(b=>b.status!=='cancelled').map(b=>opt(b.id, `#${b.id} ${b.guest_name||'Guest'} · ${fmtDate(b.check_in, false)}`, '')).join('')}</select>
        <select class="in" id="agLinkA">${opt('', '— no agent —', '')}${agents.map(a=>opt(a.id, a.name, '')).join('')}</select><button class="btn" onclick="agLink()">Save</button></div></div>`;
  }else{
    const list=await slist('allotments');
    box.innerHTML=`<div class="row end" style="margin-bottom:10px"><span class="muted" style="flex:1">Allotted dates are blocked for everyone else and released automatically ${'“release days”'} before each date.</span><button class="btn btn-primary" onclick="agAllot()">＋ New allotment</button></div>`+
      tbl(['Agent', D?unitWord():'Unit', 'From', 'To', 'Release', 'Status', ''], list.map(a=>`<tr><td>${esc(a.agent_name||'—')}</td><td>${esc(a.unit_name||'')}</td><td>${fmtDate(a.start_date)}</td><td>${fmtDate(a.end_date)}</td><td>${a.release_days} days before</td><td>${a.status==='active'?'<span class="badge green">Active</span>':'<span class="badge gray">Released</span>'}</td><td>${a.status==='active'?`<button class="btn btn-sm" onclick="agRelease(${a.id})">Release now</button>`:''}</td></tr>`), 'No allotments.');
    window._agents=agents;
  }
};
function agTab(k){ SUB.agents=k; rerender(); }
function agForm(id){
  const a=id?(window._agents||[]).find(x=>x.id===id):{commission_pct:10, active:1};
  formModal(id?`Edit ${a.name}`:'Add agent', [{n:'name', l:'Name'}, {n:'company', l:'Company'}, {n:'phone', l:'WhatsApp number', ph:'+91…'}, {n:'email', l:'Email'},
    {n:'commission_pct', l:'Commission %', t:'number'}, {n:'credit_limit', l:'Credit limit', t:'number'}, {n:'active', l:'Active', t:'checkbox'}, {n:'notes', l:'Notes', t:'textarea', full:true}], a,
  async v=>{ await sapi('agents', id?'PATCH':'POST', id?{id, ...v}:v); toast('Saved'); rerender(); },
  id?[{label:'Delete', danger:true, onClick:async()=>{ if(!confirm('Delete this agent?')) return true; await sapi('agents', 'DELETE', {id}); rerender(); }}]:[]);
}
async function agConfirm(bid){ const g=prompt('Guest name for the booking (optional):', ''); if(g===null) return; try{ await sapi('agents/confirm', 'POST', {booking_id:bid, guest_name:g}); toast('Confirmed'); await refresh(); }catch(e){ toast(e.message, true); } }
async function agPaid(bid){ try{ await sapi('agent-bookings', 'PATCH', {booking_id:bid, commission_status:'paid'}); rerender(); }catch(e){ toast(e.message, true); } }
async function agLink(){ try{ await sapi('agent-bookings', 'PUT', {booking_id:Number($('agLinkB').value), agent_id:Number($('agLinkA').value)||null}); toast('Saved'); rerender(); }catch(e){ toast(e.message, true); } }
function agAllot(){
  formModal('New allotment', [{n:'agent_id', l:'Agent', t:'select', o:(window._agents||[]).map(a=>[a.id, a.name])}, {n:'unit_id', l:unitWord(), t:'select', o:D.units.map(u=>[u.id, u.name])},
    {n:'start_date', l:'From', t:'date'}, {n:'end_date', l:'To (check-out)', t:'date'}, {n:'release_days', l:'Release days before', t:'number'}], {release_days:7, start_date:today(), end_date:addDays(today(), 7)},
  async v=>{ const r=await sapi('allotments', 'POST', v); toast(`${r.blocked} night${r.blocked===1?'':'s'} held${r.skipped?`, ${r.skipped} already taken`:''}`); rerender(); });
}
async function agRelease(id){ if(!confirm('Release this allotment now?')) return; try{ await sapi('allotments', 'DELETE', {id}); rerender(); }catch(e){ toast(e.message, true); } }

// ── Housekeeping ─────────────────────────────────────────────────────────────────────────────────
const ROOM_ST={clean:['Clean', 'green'], dirty:['Dirty', 'warn'], inspected:['Inspected', 'blue'], out_of_order:['Out of order', 'red']};
R.housekeeping=async el=>{
  el.innerHTML=skeleton();
  const [rooms, tasks]=await Promise.all([slist('room-status'), onAny('staff_tasks','housekeeping')?slist('tasks'):[]]);
  const t=today();
  const arriving=new Set(D.bookings.filter(b=>b.check_in===t && ['confirmed'].includes(b.status)).map(b=>Number(b.unit_id)));
  const occupied=new Set(D.bookings.filter(b=>b.check_in<=t && b.check_out>t && b.status==='checked_in').map(b=>Number(b.unit_id)));
  const hk=tasks.filter(x=>x.kind==='housekeeping' && x.status!=='done');
  const counts=Object.fromEntries(Object.keys(ROOM_ST).map(k=>[k, rooms.filter(r=>r.status===k).length]));
  el.innerHTML=`<div class="kpis">${Object.entries(ROOM_ST).map(([k, [l]])=>`<div class="stat"><div class="stat-lbl">${l}</div><div class="stat-val">${counts[k]}</div></div>`).join('')}<div class="stat accent"><div class="stat-lbl">Cleaning tasks open</div><div class="stat-val">${hk.length}</div></div></div>
    <div class="row" style="margin-bottom:10px"><b>${unitWord(true)}</b><span class="sp"></span><button class="btn" onclick="hkGen()">⟳ Build today's task list</button></div>
    <div class="rooms">${rooms.filter(r=>r.active).map(r=>`<div class="room ${r.status}"><div class="row"><b style="flex:1">${esc(r.name)}</b>${occupied.has(r.unit_id)?'<span class="badge blue">Occupied</span>':''}${arriving.has(r.unit_id)?'<span class="badge warn">Arrival today</span>':''}</div>
      <select class="in" style="width:100%;margin-top:8px" onchange="hkSet(${r.unit_id},this.value)">${Object.entries(ROOM_ST).map(([k, [l]])=>opt(k, l, r.status)).join('')}</select>
      ${r.note?`<div class="muted" style="margin-top:4px">${esc(r.note)}</div>`:''}</div>`).join('')}</div>
    <div class="card" style="margin-top:14px"><div class="card-title">🧹 Cleaning & preparation<span class="sp"></span><button class="btn btn-sm" onclick="go('tasks')">All tasks</button></div>
      ${hk.length?hk.map(x=>taskRow(x)).join(''):'<div class="empty-state">Nothing to clean right now.</div>'}</div>`;
  window._tasks=tasks;
};
async function hkSet(unitId, status){ try{ await sapi('room-status', 'PUT', {unit_id:unitId, status}); toast('Updated'); }catch(e){ toast(e.message, true); } }
async function hkGen(){ try{ await sapi('housekeeping/generate', 'POST', {}); toast('Task list updated'); rerender(); }catch(e){ toast(e.message, true); } }

// ── Tasks & Staff ────────────────────────────────────────────────────────────────────────────────
const PRI={urgent:['🔴', 'red'], high:['🟠', 'warn'], normal:['⚪', 'gray'], low:['·', 'gray']};
let staffCache=[];
function taskRow(x){
  const who=staffCache.find(s=>s.id===x.assignee_id);
  return `<div class="list-item"><span class="badge ${PRI[x.priority]?.[1]||'gray'}">${esc(x.priority)}</span><div class="li-main"><b>#${x.id} ${esc(x.title)}</b><span class="muted">${esc(x.kind)}${x.due_date?' · '+fmtDate(x.due_date, false):''}${who?' · '+esc(who.name):' · unassigned'}${x.notes?' · '+esc(x.notes):''}</span></div>
    ${x.status==='open'?`<button class="btn btn-sm" onclick="tkStatus(${x.id},'in_progress')">Start</button>`:''}${x.status!=='done'?`<button class="btn btn-sm btn-primary" onclick="tkStatus(${x.id},'done')">Done</button>`:''}<button class="btn-ghost" onclick="tkForm(${x.id})">Edit</button></div>`;
}
R.tasks=async el=>{
  const cur=SUB.tasks||(onAny('staff_tasks','housekeeping','instay_requests')?'board':'staff');
  el.innerHTML=tabs([['board', 'Task board', onAny('staff_tasks','housekeeping','instay_requests')], ['staff', 'Staff & crew'], ['crew', 'Crew assignment', on('crew')]], cur, 'tkTab')+`<div id="tkBox">${skeleton()}</div>`;
  const box=$('tkBox');
  staffCache=await slist('staff').catch(()=>[]);
  if(cur==='board'){
    const tasks=await slist('tasks');
    window._tasks=tasks;
    const col=(st, l)=>`<div class="kcol"><h4>${l} · ${tasks.filter(x=>x.status===st).length}</h4>${tasks.filter(x=>x.status===st).slice(0, st==='done'?20:200).map(x=>{
      const who=staffCache.find(s=>s.id===x.assignee_id);
      return `<div class="kcard"><div class="row" style="gap:6px"><span>${PRI[x.priority]?.[0]||''}</span><b style="flex:1">${esc(x.title)}</b><span class="muted">#${x.id}</span></div>
        <div class="muted">${esc(x.kind)}${x.unit_id?' · '+esc(unitName(x.unit_id)):''}${x.due_date?' · '+fmtDate(x.due_date, false):''} · ${who?esc(who.name):'unassigned'} · ${esc(x.source)}</div>${x.notes?`<div class="muted">${esc(x.notes)}</div>`:''}
        <div class="row" style="margin-top:6px;gap:6px">${st==='open'?`<button class="btn btn-sm" onclick="tkStatus(${x.id},'in_progress')">Start</button>`:''}${st!=='done'?`<button class="btn btn-sm btn-primary" onclick="tkStatus(${x.id},'done')">Done</button>`:`<button class="btn btn-sm" onclick="tkStatus(${x.id},'open')">Reopen</button>`}
        <button class="btn-ghost" onclick="tkForm(${x.id})">Edit</button>${who?.phone&&st!=='done'?`<button class="btn-ghost" onclick="tkNotify(${x.id})">📲 Send</button>`:''}</div></div>`;
    }).join('')||'<div class="muted" style="padding:4px">—</div>'}</div>`;
    box.innerHTML=`<div class="row end" style="margin-bottom:10px">${on('staff_bot')?'<span class="muted" style="flex:1">Staff can reply on WhatsApp: <b>tasks</b>, <b>done 12</b>, <b>issue: …</b></span>':''}<button class="btn btn-primary" onclick="tkForm()">＋ New task</button></div>
      <div class="kanban">${col('open', 'To do')}${col('in_progress', 'In progress')}${col('done', 'Done')}</div>`;
  }else if(cur==='staff'){
    box.innerHTML=`<div class="row end" style="margin-bottom:10px"><button class="btn btn-primary" onclick="stForm()">＋ Add staff</button></div>`+
      tbl(['Name', 'Role', 'WhatsApp', 'Status'], staffCache.map(s=>`<tr class="click" onclick="stForm(${s.id})"><td><b>${esc(s.name)}</b></td><td>${esc(s.role.replace('_', ' '))}</td><td>${esc(s.phone)}</td><td>${s.active?'<span class="badge green">Active</span>':'<span class="badge gray">Off</span>'}</td></tr>`), 'Add your housekeeping, maintenance and boat crew here.');
  }else{
    const from=today(), to=addDays(from, 14);
    const crew=await slist(`crew?from=${from}&to=${to}`);
    const bks=bookingsIn(from, to).filter(b=>b.status!=='inquiry');
    const crewStaff=staffCache.filter(s=>s.active && ['cook','driver','helper','manager'].includes(s.role));
    box.innerHTML=tbl(['Booking', 'Dates', 'Crew', 'Add'], bks.map(b=>{
      const mine=crew.filter(c=>c.booking_id===b.id);
      return `<tr><td><b>${esc(b.guest_name||'Guest')}</b><div class="muted">${esc(unitName(b.unit_id))}</div></td><td>${fmtDate(b.check_in, false)} → ${fmtDate(b.check_out, false)}</td>
        <td>${mine.map(c=>`<span class="badge blue">${esc(c.staff_role)}: ${esc(c.staff_name)} <a href="#" onclick="crDel(${c.id});return false" style="color:inherit">✕</a></span>`).join(' ')||'<span class="muted">No crew</span>'}</td>
        <td><select class="in" onchange="crAdd(${b.id},this.value);this.value=''">${opt('', '＋ Assign…', '')}${crewStaff.map(s=>opt(s.id, `${s.name} (${s.role})`, '')).join('')}</select></td></tr>`;
    }), 'No stays in the next 14 days.')+(crewStaff.length?'':'<div class="muted" style="margin-top:8px">Add staff with the role cook, driver or helper in “Staff & crew” first.</div>');
  }
};
function tkTab(k){ SUB.tasks=k; rerender(); }
async function tkStatus(id, status){ try{ await sapi('tasks', 'PATCH', {id, status}); toast(status==='done'?'Done ✓':'Updated'); rerender(); refresh(); }catch(e){ toast(e.message, true); } }
async function tkNotify(id){ try{ const r=await sapi('tasks/notify', 'POST', {id}); if(r.ok) toast('Sent on WhatsApp'); else openChatFromLink(r.wa_link); }catch(e){ toast(e.message, true); } }
function tkForm(id){
  const x=id?(window._tasks||[]).find(t=>t.id===id):{kind:'maintenance', priority:'normal', status:'open', due_date:today()};
  formModal(id?`Task #${id}`:'New task', [{n:'title', l:'Task', full:true, ph:'Fix AC in Villa 2'}, {n:'kind', l:'Type', t:'select', o:[['maintenance', 'Maintenance'], ['housekeeping', 'Housekeeping'], ['request', 'Guest request'], ['other', 'Other']]},
    {n:'priority', l:'Priority', t:'select', o:[['urgent', 'Urgent'], ['high', 'High'], ['normal', 'Normal'], ['low', 'Low']]},
    {n:'unit_id', l:unitWord(), t:'select', o:[['', '—'], ...D.units.map(u=>[u.id, u.name])]}, {n:'assignee_id', l:'Assign to', t:'select', o:[['', 'Unassigned'], ...staffCache.filter(s=>s.active).map(s=>[s.id, `${s.name} (${s.role})`])]},
    {n:'due_date', l:'Due', t:'date'}, {n:'status', l:'Status', t:'select', o:[['open', 'To do'], ['in_progress', 'In progress'], ['done', 'Done']]}, {n:'notes', l:'Notes', t:'textarea', full:true}], x,
  async v=>{ v.unit_id=v.unit_id?Number(v.unit_id):null; v.assignee_id=v.assignee_id?Number(v.assignee_id):null; await sapi('tasks', id?'PATCH':'POST', id?{id, ...v}:v); toast('Saved'); rerender(); refresh(); },
  id?[{label:'Delete', danger:true, onClick:async()=>{ if(!confirm('Delete this task?')) return true; await sapi('tasks', 'DELETE', {id}); rerender(); }}]:[]);
}
function stForm(id){
  const s=id?staffCache.find(x=>x.id===id):{role:'housekeeping', active:1};
  formModal(id?`Edit ${s.name}`:'Add staff', [{n:'name', l:'Name'}, {n:'role', l:'Role', t:'select', o:[['housekeeping', 'Housekeeping'], ['maintenance', 'Maintenance'], ['front_desk', 'Front desk'], ['manager', 'Manager'], ['cook', 'Cook (crew)'], ['driver', 'Driver / captain (crew)'], ['helper', 'Helper (crew)']]},
    {n:'phone', l:'WhatsApp number', ph:'+91…'}, {n:'active', l:'Active', t:'checkbox'}], s,
  async v=>{ await sapi('staff', id?'PATCH':'POST', id?{id, ...v}:v); toast('Saved'); rerender(); },
  id?[{label:'Delete', danger:true, onClick:async()=>{ if(!confirm('Delete this staff member?')) return true; await sapi('staff', 'DELETE', {id}); rerender(); }}]:[]);
}
async function crAdd(bid, sid){ if(!sid) return; try{ const r=await sapi('crew', 'POST', {booking_id:bid, staff_id:Number(sid)}); if(r.warning) toast(r.warning, true); else toast('Assigned'); rerender(); }catch(e){ toast(e.message, true); } }
async function crDel(id){ try{ await sapi('crew', 'DELETE', {id}); rerender(); }catch(e){ toast(e.message, true); } }

// ── Cruise Day ───────────────────────────────────────────────────────────────────────────────────
let cruiseDate=null;
const TRIP={day_cruise:'Day cruise', overnight:'Overnight cruise', night_stay:'Night stay'};
R.cruise=async el=>{
  cruiseDate=cruiseDate||today();
  el.innerHTML=`<div class="row" style="margin-bottom:12px"><button class="btn" onclick="cruiseDate=addDays(cruiseDate,-1);rerender()">‹</button><input class="in" type="date" value="${cruiseDate}" onchange="cruiseDate=this.value;rerender()"><button class="btn" onclick="cruiseDate=addDays(cruiseDate,1);rerender()">›</button><button class="btn" onclick="cruiseDate=today();rerender()">Today</button><span class="sp"></span><span id="wxStrip" class="muted"></span></div><div id="crBox">${skeleton()}</div>`;
  const [d, jetties]=await Promise.all([sapi(`cruise?date=${cruiseDate}`), onAny('cruise_plan','pickup','weather_alerts','fleet')?slist('jetties'):[]]);
  window._jetties=jetties;
  if(on('weather_alerts')) sapi('weather').then(w=>{ const day=w.days.find(x=>x.date===cruiseDate); if(day) $('wxStrip').innerHTML=`${day.bad?'<span class="badge red">Weather warning</span>':'<span class="badge green">Weather OK</span>'} ${Math.round(day.rain)} mm rain · wind ${Math.round(day.wind)} km/h`; }).catch(()=>{});
  const deps=d.list.filter(b=>b.check_in===cruiseDate), stay=d.list.filter(b=>b.check_in!==cruiseDate);
  const card=b=>`<div class="card"><div class="row"><div style="flex:1"><b style="font-size:15px">${esc(b.unit_name)}</b> · ${esc(b.guest_name||'Guest')} <span class="muted">${b.adults||1}${b.children?'+'+b.children:''} guests · ${fmtDate(b.check_in, false)} → ${fmtDate(b.check_out, false)}</span></div>
      <span class="badge blue">${esc(TRIP[b.trip_type]||b.trip_type)}</span>${b.suite?.eta?`<span class="badge gray">ETA ${esc(b.suite.eta)}</span>`:''}<button class="btn btn-sm" onclick="crTrip(${b.id})">Edit trip</button></div>
    <div class="grid g3" style="margin-top:10px">
      <div><div class="muted">📍 Jetty</div><b>${esc(b.jetty?.name||'Not set')}</b>${b.jetty?.map_url?` <a target="_blank" rel="noopener" href="${esc(b.jetty.map_url)}">map</a>`:''}
        ${b.plan.length?`<div style="margin-top:6px">${b.plan.map(p=>`<div class="muted">${p.next?'<i>next day</i> ':''}<b style="color:var(--ink)">${esc(p.at)}</b> ${esc(p.what)}</div>`).join('')}</div>`:''}</div>
      <div><div class="muted">👥 Crew</div>${b.crew.map(c=>`<div>${esc(c.role)}: <b>${esc(c.name)}</b> ${chatBtn(null, c.phone)}</div>`).join('')||'<span class="muted">No crew assigned</span>'}</div>
      <div><div class="muted">🍛 Meals</div>${b.meals.map(m=>`<div><b>${esc(m.meal)}:</b> ${esc(m.items.map(i=>i.name).join(', ')||'—')}${m.notes?` <i class="muted">(${esc(m.notes)})</i>`:''}</div>`).join('')||'<span class="muted">No pre-order</span>'}${b.suite?.preferences?`<div class="muted">📝 ${esc(b.suite.preferences)}</div>`:''}</div>
    </div>
    ${b.check_in===cruiseDate?`<div class="row" style="margin-top:10px">${on('pickup')?`<button class="btn btn-sm" onclick="crSend(${b.id},'pickup')">📍 Send pickup details</button><button class="btn btn-sm" onclick="crSend(${b.id},'driver_on_way')">🚗 Driver on the way</button><button class="btn btn-sm btn-primary" onclick="crSend(${b.id},'boat_ready')">🚤 Boat ready</button>`:''}</div>`:''}</div>`;
  $('crBox').innerHTML=`<h3 style="margin:4px 0 10px">Departures (${deps.length})</h3>${deps.map(card).join('')||'<div class="card empty-state">No departures this day.</div>'}
    ${stay.length?`<h3 style="margin:18px 0 10px">On board (${stay.length})</h3>${stay.map(card).join('')}`:''}`;
  window._cruise=d.list;
};
function crTrip(id){
  const b=(window._cruise||[]).find(x=>x.id===id);
  formModal('Trip details', [{n:'trip_type', l:'Trip type', t:'select', o:Object.entries(TRIP)}, {n:'jetty_id', l:'Jetty', t:'select', o:[['', 'Boat\'s default jetty'], ...(window._jetties||[]).map(j=>[j.id, j.name])]},
    {n:'boarding_time', l:'Boarding time', t:'time'}, {n:'eta', l:'Guest arrival time (ETA)'}], {trip_type:b.trip_type, jetty_id:b.suite?.jetty_id||'', boarding_time:b.suite?.boarding_time||'', eta:b.suite?.eta||''},
  async v=>{ v.jetty_id=v.jetty_id?Number(v.jetty_id):null; await sapi('booking', 'PATCH', {booking_id:id, ...v}); toast('Saved'); rerender(); });
}
async function crSend(id, kind){
  const extra=kind==='driver_on_way'?prompt('Add a note (e.g. "Arriving in 15 minutes, white Innova KL-04-1234"):', ''):'';
  if(extra===null) return;
  try{ const r=await sapi('journey/send', 'POST', {booking_id:id, kind, text:extra}); if(r.ok) toast('Sent'); else{ toast('Not sent — open WhatsApp instead', true); if(r.wa_link) openChatFromLink(r.wa_link, ((window._cruise||[]).find(x=>x.id===id)||{}).lead_id); } }catch(e){ toast(e.message, true); }
}

// ── Fleet & Maintenance ──────────────────────────────────────────────────────────────────────────
R.fleet=async el=>{
  const cur=SUB.fleet||(on('fleet')?'fleet':onAny('cruise_plan','pickup','weather_alerts')?'jetties':'maint');
  el.innerHTML=tabs([['fleet', 'Fleet', onAny('fleet','maintenance','cruise_plan')], ['jetties', 'Jetties & cruise hours', onAny('cruise_plan','pickup','weather_alerts','fleet')], ['maint', 'Fuel & maintenance', on('maintenance')], ['weather', 'Weather', on('weather_alerts')]], cur, 'flTab')+`<div id="flBox">${skeleton()}</div>`;
  const box=$('flBox');
  if(cur==='fleet'){
    const [list, jetties]=await Promise.all([slist('fleet'), slist('jetties').catch(()=>[])]);
    window._fleet=list; window._jetties=jetties;
    box.innerHTML=tbl(['Boat', 'Bedrooms', 'Deck', 'AC', 'Category', 'Day cruise', 'Overnight', 'Night stay', 'Jetty', ''], list.map(f=>`<tr class="click" onclick="flForm(${f.unit_id})"><td><b>${esc(f.name)}</b></td><td>${f.bedrooms??'—'}</td><td>${esc(f.deck_type||'—')}</td><td>${esc({ac:'AC', non_ac:'Non-AC', partial:'AC at night'}[f.ac]||'—')}</td><td>${esc(f.category||'—')}</td>
      <td>${f.day_cruise_rate?money(f.day_cruise_rate):'—'}</td><td>${f.overnight_rate?money(f.overnight_rate):'—'}</td><td>${f.night_stay_rate?money(f.night_stay_rate):'—'}</td><td>${esc(jetties.find(j=>j.id===f.jetty_id)?.name||'—')}</td><td><button class="btn btn-sm">Edit</button></td></tr>`), 'Add boats under Boats first.');
  }else if(cur==='jetties'){
    const list=await slist('jetties'); window._jetties=list;
    box.innerHTML=`<div class="row end" style="margin-bottom:10px"><button class="btn btn-primary" onclick="jtForm()">＋ Add jetty</button></div>`+tbl(['Jetty', 'Boarding', 'Cruising', 'Check-out', 'Location', ''], list.map(j=>`<tr class="click" onclick="jtForm(${j.id})"><td><b>${esc(j.name)}</b></td><td>${esc(j.boarding_time)}</td><td>${esc(j.cruise_start)} – ${esc(j.cruise_end)}</td><td>${esc(j.checkout_time)}</td><td>${j.map_url?`<a target="_blank" rel="noopener" href="${esc(j.map_url)}" onclick="event.stopPropagation()">Map</a>`:'—'}${j.lat!=null?` <span class="muted">${j.lat}, ${j.lng}</span>`:''}</td><td><button class="btn btn-sm">Edit</button></td></tr>`), 'Add the jetties your boats board from, with their cruising hours.');
  }else if(cur==='maint'){
    const [fleet, log]=await Promise.all([slist('fleet'), slist('boatlog')]);
    box.innerHTML=`<div class="rooms" style="margin-bottom:14px">${fleet.map(f=>{ const since=Math.max(0, (f.engine_hours||0)-(f.last_service_hours||0)), iv=f.service_interval_hours||250, pct=Math.min(100, Math.round(since/iv*100));
      return `<div class="room ${pct>=90?'out_of_order':pct>=70?'dirty':'clean'}"><b>${esc(f.name)}</b><div class="muted">${Math.round(f.engine_hours||0)} engine hrs · ${Math.round(since)} since service</div>
        <div style="height:6px;background:#EEF1F4;border-radius:4px;margin:6px 0"><div style="width:${pct}%;height:6px;border-radius:4px;background:${pct>=90?'#EF4444':pct>=70?'#F59E0B':'#10B981'}"></div></div><div class="muted">${pct>=90?'Service due':`${Math.round(iv-since)} hrs to service`}${f.last_service_date?` · last ${fmtDate(f.last_service_date, false)}`:''}</div></div>`; }).join('')}</div>
      <div class="row end" style="margin-bottom:10px"><button class="btn" onclick="logForm('fuel')">⛽ Log fuel</button><button class="btn btn-primary" onclick="logForm('service')">🛠️ Log service / repair</button></div>
      ${tbl(['Date', 'Boat', 'Type', 'Litres', 'Cost', 'Engine hrs', 'Note', ''], log.map(l=>`<tr><td>${fmtDate(l.date, false)}</td><td>${esc(l.unit_name||'')}</td><td>${esc(l.kind)}</td><td>${l.litres||'—'}</td><td>${l.cost?money(l.cost):'—'}</td><td>${l.engine_hours??'—'}</td><td>${esc(l.note)}</td><td><button class="btn-ghost" onclick="logDel(${l.id})">✕</button></td></tr>`), 'No fuel or service entries yet.')}`;
    window._fleet=fleet;
  }else{
    const w=await sapi('weather').catch(e=>({error:e.message}));
    box.innerHTML=w.error?`<div class="card">${esc(w.error)}</div>`:`<div class="kpis">${w.days.map(d=>`<div class="stat${d.bad?' accent':''}" style="${d.bad?'border-color:var(--red);background:var(--red-soft)':''}"><div class="stat-lbl">${fmtDate(d.date)}</div><div class="stat-val" style="font-size:18px">${Math.round(d.rain)} mm</div><div class="stat-sub">wind ${Math.round(d.wind)} km/h${d.bad?' · ⚠️ alert':''}</div></div>`).join('')}</div><div class="muted">Forecast from Open-Meteo for ${w.lat}, ${w.lng}. Guests departing on an alert day get a WhatsApp update automatically.</div>`;
  }
};
function flTab(k){ SUB.fleet=k; rerender(); }
function flForm(unitId){
  const f=(window._fleet||[]).find(x=>x.unit_id===unitId)||{};
  formModal(`${f.name||'Boat'} — details`, [{n:'bedrooms', l:'Bedrooms', t:'number'}, {n:'deck_type', l:'Deck', ph:'Upper deck / Sun deck'}, {n:'ac', l:'Air-conditioning', t:'select', o:[['ac', 'AC'], ['non_ac', 'Non-AC'], ['partial', 'AC at night only']]},
    {n:'category', l:'Category', ph:'Deluxe / Premium / Luxury'}, {n:'day_cruise_rate', l:'Day cruise rate', t:'number'}, {n:'overnight_rate', l:'Overnight rate', t:'number'}, {n:'night_stay_rate', l:'Night-stay rate', t:'number'},
    {n:'jetty_id', l:'Default jetty', t:'select', o:[['', '—'], ...(window._jetties||[]).map(j=>[j.id, j.name])]}, {n:'engine_hours', l:'Engine hours now', t:'number'}, {n:'service_interval_hours', l:'Service every (hours)', t:'number'},
    {n:'last_service_hours', l:'Engine hours at last service', t:'number'}, {n:'last_service_date', l:'Last service date', t:'date'}], {bedrooms:1, ac:'ac', service_interval_hours:250, ...f},
  async v=>{ v.jetty_id=v.jetty_id?Number(v.jetty_id):null; await sapi('fleet', 'PUT', {unit_id:unitId, ...v}); toast('Saved'); rerender(); });
}
function jtForm(id){
  const j=id?(window._jetties||[]).find(x=>x.id===id):{boarding_time:'12:00', cruise_start:'12:00', cruise_end:'17:30', checkout_time:'09:00'};
  formModal(id?`Edit ${j.name}`:'Add jetty', [{n:'name', l:'Name', ph:'Finishing Point, Alappuzha'}, {n:'map_url', l:'Google Maps link'}, {n:'lat', l:'Latitude (for weather)', t:'number'}, {n:'lng', l:'Longitude', t:'number'},
    {n:'boarding_time', l:'Boarding', t:'time'}, {n:'cruise_start', l:'Cruising from', t:'time'}, {n:'cruise_end', l:'Cruising until (anchor)', t:'time'}, {n:'checkout_time', l:'Check-out', t:'time'}, {n:'notes', l:'Notes for guests', t:'textarea', full:true}], j,
  async v=>{ await sapi('jetties', id?'PATCH':'POST', id?{id, ...v}:v); toast('Saved'); rerender(); },
  id?[{label:'Delete', danger:true, onClick:async()=>{ if(!confirm('Delete this jetty?')) return true; await sapi('jetties', 'DELETE', {id}); rerender(); }}]:[]);
}
function logForm(kind){
  formModal(kind==='fuel'?'Log fuel':'Log service / repair', [{n:'unit_id', l:'Boat', t:'select', o:(window._fleet||D.units).map(u=>[u.unit_id||u.id, u.name])},
    ...(kind==='fuel'?[{n:'litres', l:'Litres', t:'number'}]:[{n:'kind', l:'Type', t:'select', o:[['service', 'Engine service'], ['repair', 'Repair']]}]),
    {n:'cost', l:'Cost', t:'number'}, {n:'engine_hours', l:'Engine hours (meter)', t:'number'}, {n:'date', l:'Date', t:'date'}, {n:'note', l:'Note', full:true}], {date:today(), kind:'service'},
  async v=>{ await sapi('boatlog', 'POST', {kind, ...v, unit_id:Number(v.unit_id)}); toast('Logged'); rerender(); });
}
async function logDel(id){ if(!confirm('Delete this entry?')) return; try{ await sapi('boatlog', 'DELETE', {id}); rerender(); }catch(e){ toast(e.message, true); } }

// ── Kitchen & Menu ───────────────────────────────────────────────────────────────────────────────
let mealDate=null;
const MEALS=[['breakfast', 'Breakfast'], ['lunch', 'Lunch'], ['snacks', 'Evening snacks'], ['dinner', 'Dinner']];
R.meals=async el=>{
  const cur=SUB.meals||'kitchen';
  mealDate=mealDate||today();
  el.innerHTML=tabs([['kitchen', 'Kitchen sheet'], ['menu', 'Menu']], cur, 'mlTab')+`<div id="mlBox">${skeleton()}</div>`;
  const box=$('mlBox');
  if(cur==='kitchen'){
    const d=await sapi(`meals?date=${mealDate}`);
    const counts={};
    d.list.forEach(o=>o.items.forEach(i=>{ const k=o.meal+'|'+i.name; counts[k]=(counts[k]||0)+1; }));
    box.innerHTML=`<div class="row" style="margin-bottom:12px"><input class="in" type="date" value="${mealDate}" onchange="mealDate=this.value;rerender()"><span class="sp"></span><button class="btn" onclick="window.print()">🖨️ Print</button></div>
      <div class="grid g2"><div class="card"><div class="card-title">🧾 To cook — totals</div>${MEALS.map(([m, l])=>{ const rows=Object.entries(counts).filter(([k])=>k.startsWith(m+'|')); return rows.length?`<div style="margin-bottom:8px"><b>${l}</b>${rows.map(([k, n])=>`<div class="muted">${n} × ${esc(k.split('|')[1])}</div>`).join('')}</div>`:''; }).join('')||'<div class="empty-state">No pre-orders for this day.</div>'}</div>
      <div class="card"><div class="card-title">🚤 By booking</div>${d.list.map(o=>`<div class="list-item"><div class="li-main"><b>${esc(o.unit_name||'')} · ${esc(o.guest_name||'')}</b><span class="muted">${esc(o.meal)}: ${esc(o.items.map(i=>i.name).join(', ')||'—')}${o.notes?` · ${esc(o.notes)}`:''} · ${o.adults||1}${o.children?'+'+o.children:''} guests</span></div></div>`).join('')||'<div class="empty-state">—</div>'}</div></div>`;
  }else{
    const menu=await slist('menu'); window._menu=menu;
    box.innerHTML=`<div class="row end" style="margin-bottom:10px"><span class="muted" style="flex:1">Up to 9 dishes per meal are offered as buttons on WhatsApp.</span><button class="btn btn-primary" onclick="mnForm()">＋ Add dish</button></div>
      <div class="grid g2">${MEALS.map(([m, l])=>`<div class="card"><div class="card-title">${l}</div>${menu.filter(x=>x.meal===m).map(x=>`<div class="list-item" style="cursor:pointer" onclick="mnForm(${x.id})"><span>${x.veg?'🟢':'🔴'}</span><div class="li-main"><b>${esc(x.name)}</b><span class="muted">${x.price?money(x.price)+' extra':'Included'}${x.active?'':' · hidden'}</span></div></div>`).join('')||'<div class="muted">No dishes.</div>'}</div>`).join('')}</div>`;
  }
};
function mlTab(k){ SUB.meals=k; rerender(); }
function mnForm(id){
  const x=id?(window._menu||[]).find(m=>m.id===id):{meal:'lunch', veg:1, active:1, price:0};
  formModal(id?`Edit ${x.name}`:'Add dish', [{n:'name', l:'Dish', ph:'Karimeen pollichathu'}, {n:'meal', l:'Meal', t:'select', o:MEALS}, {n:'veg', l:'Vegetarian', t:'checkbox'}, {n:'price', l:'Extra price (0 = included)', t:'number'}, {n:'sort_order', l:'Order', t:'number'}, {n:'active', l:'Show to guests', t:'checkbox'}], x,
  async v=>{ await sapi('menu', id?'PATCH':'POST', id?{id, ...v}:v); toast('Saved'); rerender(); },
  id?[{label:'Delete', danger:true, onClick:async()=>{ await sapi('menu', 'DELETE', {id}); rerender(); }}]:[]);
}

// ── Smart Pricing ────────────────────────────────────────────────────────────────────────────────
const RULE={weekend:'Weekend (Fri & Sat nights)', season:'Season', event:'Festival / event', high_demand:'High demand (occupancy ≥ threshold)', last_minute:'Last minute (≤ days away, occupancy < threshold)'};
R.pricing=async el=>{
  const cur=SUB.pricing||'sugg';
  el.innerHTML=tabs([['sugg', 'Suggestions'], ['rules', 'Rules']], cur, 'prTab')+`<div id="prBox">${skeleton()}</div>`;
  const box=$('prBox');
  if(cur==='sugg'){
    const list=await slist('suggestions');
    box.innerHTML=`<div class="row" style="margin-bottom:10px"><span class="muted" style="flex:1">Suggestions refresh every morning from your rules. Nothing changes until you apply it.</span><button class="btn" onclick="prGen()">⟳ Recalculate</button>${list.length?`<button class="btn" onclick="prAct('dismiss',null,true)">Dismiss all</button><button class="btn btn-primary" onclick="prAct('apply',null,true)">Apply all (${list.length})</button>`:''}</div>`+
      tbl(['Date', unitWord(), 'Now', 'Suggested', 'Change', 'Why', ''], list.map(s=>{ const ch=Math.round((s.suggested_rate/s.current_rate-1)*100);
        return `<tr><td>${fmtDate(s.date)}</td><td>${esc(s.unit_name||'')}</td><td>${money(s.current_rate, s.currency)}</td><td><b>${money(s.suggested_rate, s.currency)}</b></td><td><span class="badge ${ch>=0?'green':'warn'}">${ch>=0?'+':''}${ch}%</span></td><td class="muted">${esc(s.reason)}</td>
          <td><button class="btn btn-sm btn-primary" onclick="prAct('apply',${s.id})">Apply</button><button class="btn-ghost" onclick="prAct('dismiss',${s.id})">✕</button></td></tr>`; }), 'No suggestions — add rules (weekend, season, festival, demand) and recalculate.');
  }else{
    const rules=await slist('rules'); window._rules=rules;
    box.innerHTML=`<div class="row end" style="margin-bottom:10px"><button class="btn btn-primary" onclick="ruForm()">＋ Add rule</button></div>`+
      tbl(['Rule', 'Type', 'Applies', 'Change', 'Status'], rules.map(r=>`<tr class="click" onclick="ruForm(${r.id})"><td><b>${esc(r.name||RULE[r.kind])}</b></td><td>${esc(RULE[r.kind]||r.kind)}</td>
        <td>${r.kind==='season'||r.kind==='event'?`${fmtDate(r.start_date, false)} – ${fmtDate(r.end_date||r.start_date, false)}`:r.kind==='high_demand'?`≥ ${r.threshold}% booked`:r.kind==='last_minute'?`≤ ${r.days} days, < ${r.threshold}% booked`:'Every Fri & Sat'}${r.unit_id?` · ${esc(unitName(r.unit_id))}`:' · all'}</td>
        <td><b>${r.pct>0?'+':''}${r.pct}%</b></td><td>${r.active?'<span class="badge green">On</span>':'<span class="badge gray">Off</span>'}</td></tr>`), 'Start with: Weekend +10%, Onam / Christmas–New Year +30%, Nehru Trophy Boat Race +40%, high demand (80%) +10%, last minute (2 days, under 50%) −15%.');
  }
};
function prTab(k){ SUB.pricing=k; rerender(); }
async function prGen(){ try{ const r=await sapi('suggestions/generate', 'POST', {}); toast(`${r.count} suggestion${r.count===1?'':'s'}`); rerender(); refresh(); }catch(e){ toast(e.message, true); } }
async function prAct(a, id, all){ if(all && !confirm(a==='apply'?'Apply every suggested rate?':'Dismiss all suggestions?')) return; try{ const r=await sapi('suggestions/'+a, 'POST', all?{all:true}:{ids:[id]}); toast(a==='apply'?`${r.count} rate${r.count===1?'':'s'} updated`:'Dismissed'); rerender(); refresh(); }catch(e){ toast(e.message, true); } }
function ruForm(id){
  const r=id?(window._rules||[]).find(x=>x.id===id):{kind:'event', pct:20, active:1, threshold:80, days:2};
  formModal(id?'Edit rule':'Add pricing rule', [{n:'name', l:'Name', ph:'Onam'}, {n:'kind', l:'Type', t:'select', o:Object.entries(RULE)}, {n:'pct', l:'Change % (negative to lower)', t:'number'},
    {n:'unit_id', l:unitWord(), t:'select', o:[['', `All ${unitWord(true).toLowerCase()}`], ...D.units.map(u=>[u.id, u.name])]}, {n:'start_date', l:'From (season / event)', t:'date'}, {n:'end_date', l:'To', t:'date'},
    {n:'threshold', l:'Occupancy threshold % (demand / last minute)', t:'number'}, {n:'days', l:'Days away (last minute)', t:'number'}, {n:'active', l:'Active', t:'checkbox'}], r,
  async v=>{ v.unit_id=v.unit_id?Number(v.unit_id):null; await sapi('rules', id?'PATCH':'POST', id?{id, ...v}:v); toast('Saved — recalculate to see suggestions'); rerender(); },
  id?[{label:'Delete', danger:true, onClick:async()=>{ await sapi('rules', 'DELETE', {id}); rerender(); }}]:[]);
}

// ── Channels (iCal) ──────────────────────────────────────────────────────────────────────────────
R.channels=async el=>{
  el.innerHTML=skeleton();
  const d=await sapi('ical');
  el.innerHTML=`<div class="card"><div class="card-title">⬇️ Import OTA calendars</div><p class="muted" style="margin-top:0">Paste each OTA's calendar export link (Airbnb: Listing → Availability → Sync calendars → Export; Booking.com: Rates & Availability → Sync calendars). Their bookings block those nights here, so the WhatsApp bot never double-books.</p>
      <div class="row" style="margin-bottom:12px"><select class="in" id="icU">${D.units.map(u=>opt(u.id, u.name, '')).join('')}</select><select class="in" id="icS">${['Airbnb', 'Booking.com', 'Agoda', 'MakeMyTrip', 'Goibibo', 'Expedia', 'Other'].map(s=>opt(s, s, '')).join('')}</select><input class="in" id="icL" placeholder="https://…ics" style="flex:1;min-width:240px"><button class="btn btn-primary" onclick="icAdd()">Add & sync</button></div>
      ${tbl([unitWord(), 'OTA', 'Last sync', 'Nights / events', 'Status', ''], d.feeds.map(f=>`<tr><td>${esc(unitName(f.unit_id))}</td><td>${esc(f.source)}</td><td>${f.last_sync_at?new Date(f.last_sync_at).toLocaleString():'—'}</td><td>${f.events}</td><td>${f.last_status==='ok'?'<span class="badge green">OK</span>':f.last_status?`<span class="badge red" title="${esc(f.last_status)}">Error</span> <span class="muted">${esc(f.last_status)}</span>`:'—'}</td>
        <td><button class="btn btn-sm" onclick="icSync(${f.id})">Sync now</button><button class="btn-ghost" onclick="icDel(${f.id})">✕</button></td></tr>`), 'No OTA calendars connected yet.')}</div>
    <div class="card"><div class="card-title">⬆️ Export your availability to OTAs</div><p class="muted" style="margin-top:0">Give each OTA the link for that ${unitWord().toLowerCase()} ("Import calendar"). Bookings and blocked dates from here then close those nights on the OTA. Keep these links private.</p>
      ${tbl([unitWord(), 'Calendar link', ''], d.exports.map(x=>`<tr><td>${esc(x.name)}</td><td><code style="font-size:12px;word-break:break-all">${esc(WORKER+x.path)}</code></td><td><button class="btn btn-sm" onclick="navigator.clipboard.writeText('${esc(WORKER+x.path)}').then(()=>toast('Copied'))">Copy</button></td></tr>`), '—')}</div>`;
};
async function icAdd(){ try{ const r=await sapi('ical', 'POST', {unit_id:Number($('icU').value), source:$('icS').value, url:$('icL').value.trim()}); toast(r.sync?.status==='ok'?`Synced — ${r.sync.events} booking${r.sync.events===1?'':'s'}`:`Added, but sync failed: ${r.sync?.status}`, r.sync?.status!=='ok'); rerender(); }catch(e){ toast(e.message, true); } }
async function icSync(id){ try{ const r=await sapi('ical/sync', 'POST', {id}); toast(r.status==='ok'?'Synced':r.status, r.status!=='ok'); rerender(); }catch(e){ toast(e.message, true); } }
async function icDel(id){ if(!confirm('Remove this calendar? Nights it blocked will open again.')) return; try{ await sapi('ical', 'DELETE', {id}); rerender(); }catch(e){ toast(e.message, true); } }

// ── Competitors ──────────────────────────────────────────────────────────────────────────────────
R.competitors=async el=>{
  el.innerHTML=skeleton();
  const [comps, rates]=await Promise.all([slist('competitors'), slist('comp-rates')]);
  window._comps=comps;
  el.innerHTML=`<div class="grid g2"><div class="card"><div class="card-title">Competitors<span class="sp"></span><button class="btn btn-sm btn-primary" onclick="cpForm()">＋ Add</button></div>
      ${comps.map(c=>`<div class="list-item"><div class="li-main"><b>${esc(c.name)}</b>${c.url?`<a class="muted" target="_blank" rel="noopener" href="${esc(c.url)}">${esc(c.url).slice(0,60)}</a>`:''}</div><button class="btn-ghost" onclick="cpForm(${c.id})">Edit</button></div>`).join('')||'<div class="empty-state">Add the properties you compete with.</div>'}</div>
    <div class="card"><div class="card-title">Log a price</div>${comps.length?`<div class="form-grid" id="crForm">${fld({n:'competitor_id', l:'Competitor', t:'select', o:comps.map(c=>[c.id, c.name])})}${fld({n:'date', l:'Night', t:'date'}, today())}${fld({n:'rate', l:'Their price', t:'number'})}${fld({n:'room_label', l:'Room / boat type', ph:'2-bedroom premium'})}</div><div class="row end" style="margin-top:10px"><button class="btn btn-primary" onclick="crLog()">Save price</button></div>`:'<div class="muted">Add a competitor first.</div>'}</div></div>
    ${tbl(['Night', 'Competitor', 'Type', 'Their price', ''], rates.map(r=>`<tr><td>${fmtDate(r.date)}</td><td>${esc(r.competitor)}</td><td>${esc(r.room_label)}</td><td><b>${money(r.rate)}</b></td><td><button class="btn-ghost" onclick="crDelRate(${r.id})">✕</button></td></tr>`), 'No prices logged yet.')}`;
};
function cpForm(id){
  const c=id?(window._comps||[]).find(x=>x.id===id):{};
  formModal(id?`Edit ${c.name}`:'Add competitor', [{n:'name', l:'Name'}, {n:'url', l:'Listing link (Booking.com, MakeMyTrip…)', full:true}], c,
    async v=>{ await sapi('competitors', id?'PATCH':'POST', id?{id, ...v}:v); rerender(); },
    id?[{label:'Delete', danger:true, onClick:async()=>{ await sapi('competitors', 'DELETE', {id}); rerender(); }}]:[]);
}
async function crLog(){ const v=vals($('crForm')); try{ const r=await sapi('comp-rates', 'POST', {...v, competitor_id:Number(v.competitor_id), rate:Number(v.rate)}); toast(r.alert||`Saved — your lowest rate that night: ${money(r.our_rate)}`, !!r.alert); rerender(); refresh(); }catch(e){ toast(e.message, true); } }
async function crDelRate(id){ try{ await sapi('comp-rates', 'DELETE', {id}); rerender(); }catch(e){ toast(e.message, true); } }

// ── Daily Insights ───────────────────────────────────────────────────────────────────────────────
R.insights=async el=>{
  el.innerHTML=skeleton();
  const s=await sapi('summary');
  el.innerHTML=`<div class="card"><div class="card-title">📊 ${fmtDate(s.date)}<span class="sp"></span><button class="btn btn-sm" onclick="inRun(false)">⟳ Refresh</button><button class="btn btn-sm btn-primary" onclick="inRun(true)">Send to owner's WhatsApp</button></div><div class="summary">${esc(s.text)}</div>
    <div class="muted" style="margin-top:8px">Sent automatically every morning to the owner's WhatsApp (set the number and template in Settings).</div></div>`;
};
async function inRun(send){ try{ const r=await sapi('summary', 'POST', {send}); toast(send?(r.sent?'Sent':'Not sent — set the owner number and template in Settings'):'Updated', send&&!r.sent); rerender(); }catch(e){ toast(e.message, true); } }

// ── Guest Feedback ───────────────────────────────────────────────────────────────────────────────
R.feedback=async el=>{
  el.innerHTML=skeleton();
  const list=await slist('feedback');
  const avg=list.length?(list.reduce((s, x)=>s+x.rating, 0)/list.length).toFixed(1):'—';
  el.innerHTML=`<div class="kpis"><div class="stat accent"><div class="stat-lbl">Average rating</div><div class="stat-val">${avg} ★</div></div><div class="stat"><div class="stat-lbl">Ratings</div><div class="stat-val">${list.length}</div></div>
    <div class="stat"><div class="stat-lbl">Happy (4–5★)</div><div class="stat-val">${list.filter(x=>x.rating>=4).length}</div></div><div class="stat"><div class="stat-lbl">Needs attention (1–3★)</div><div class="stat-val">${list.filter(x=>x.rating<=3).length}</div></div></div>`+
    tbl(['Guest', 'Stay', 'Rating', 'What they said', ''], list.map(x=>`<tr><td><b>${esc(x.guest_name||'—')}</b><div class="muted">${esc(x.guest_phone||'')}</div></td><td>${esc(x.unit_name||'')}<div class="muted">${fmtDate(x.check_in, false)} → ${fmtDate(x.check_out, false)}</div></td>
      <td><span class="badge ${x.rating>=4?'green':x.rating===3?'warn':'red'}">${'★'.repeat(x.rating)}</span></td><td>${esc(x.feedback||'')}</td><td>${chatBtn(null, x.guest_phone)}</td></tr>`), 'Ratings arrive after check-out.');
};

// ── Review Replies ───────────────────────────────────────────────────────────────────────────────
R.reviews=async el=>{
  el.innerHTML=skeleton();
  const list=await slist('reviews'); window._reviews=list;
  el.innerHTML=`<div class="row end" style="margin-bottom:10px"><span class="muted" style="flex:1">Paste a review from Google, TripAdvisor, Booking.com or MakeMyTrip — AI drafts a reply you can edit and post.</span><button class="btn btn-primary" onclick="rvForm()">＋ Add review</button></div>`+
    (list.length?list.map(r=>`<div class="card"><div class="row"><b>${esc(r.author||'Guest')}</b><span class="badge gray">${esc(r.source)}</span>${r.rating?`<span class="badge ${r.rating>=4?'green':r.rating===3?'warn':'red'}">${'★'.repeat(r.rating)}</span>`:''}<span class="sp"></span><span class="badge ${r.status==='replied'?'green':r.status==='drafted'?'blue':'warn'}">${esc(r.status)}</span></div>
      <div style="margin:8px 0;white-space:pre-wrap">${esc(r.text)}</div>
      <textarea class="in" id="rv${r.id}" placeholder="Reply…">${esc(r.reply)}</textarea>
      <div class="row end" style="margin-top:8px"><button class="btn-ghost btn-danger" onclick="rvDel(${r.id})">Delete</button><button class="btn btn-sm" onclick="rvDraft(${r.id})">✨ Draft with AI</button><button class="btn btn-sm" onclick="navigator.clipboard.writeText($('rv${r.id}').value).then(()=>toast('Copied'))">Copy</button><button class="btn btn-sm btn-primary" onclick="rvSave(${r.id},'replied')">Mark replied</button></div></div>`).join(''):'<div class="card empty-state">No reviews yet.</div>');
};
function rvForm(){ formModal('Add review', [{n:'source', l:'Where', t:'select', o:['Google', 'TripAdvisor', 'Booking.com', 'MakeMyTrip', 'Airbnb', 'Other'].map(s=>[s, s])}, {n:'author', l:'Reviewer'}, {n:'rating', l:'Stars (1–5)', t:'number'}, {n:'text', l:'Review text', t:'textarea', full:true}], {source:'Google', rating:5},
  async v=>{ const r=await sapi('reviews', 'POST', v); rerender(); setTimeout(()=>rvDraft(r.id), 300); }); }
async function rvDraft(id){ toast('Drafting…'); try{ const r=await sapi('reviews/draft', 'POST', {id}); const t=$('rv'+id); if(t) t.value=r.reply; toast('Draft ready — edit and copy'); }catch(e){ toast(e.message, true); } }
async function rvSave(id, status){ try{ await sapi('reviews', 'PATCH', {id, reply:$('rv'+id).value, status}); toast('Saved'); rerender(); }catch(e){ toast(e.message, true); } }
async function rvDel(id){ if(!confirm('Delete this review?')) return; try{ await sapi('reviews', 'DELETE', {id}); rerender(); }catch(e){ toast(e.message, true); } }

// ── Guest Profiles ───────────────────────────────────────────────────────────────────────────────
let gpQ='';
R.profiles=async el=>{
  el.innerHTML=skeleton();
  const list=await slist('guests'); window._guests=list;
  const q=gpQ.toLowerCase();
  const shown=list.filter(g=>!q || `${g.name} ${g.phone} ${g.preferences} ${g.notes}`.toLowerCase().includes(q));
  const md=s=>s?`${Number(s.slice(3))} ${MON[Number(s.slice(0,2))-1]}`:'';
  el.innerHTML=`<div class="row" style="margin-bottom:10px"><input class="in" id="gpQ" placeholder="Search guests…" value="${esc(gpQ)}" style="width:280px"><span class="sp"></span><button class="btn btn-primary" onclick="gpForm()">＋ Add guest</button></div>`+
    tbl(['Guest', 'Stays', 'Spent', 'Last / next', 'Birthday', 'Anniversary', 'Preferences', ''], shown.slice(0, 500).map((g, i)=>`<tr class="click" onclick="gpForm('${esc(g.phone_key)}')"><td><b>${esc(g.name||'—')}</b>${g.stays>=3?' <span class="badge green">Regular</span>':''}<div class="muted">${esc(g.phone||'')}</div></td><td>${g.stays}</td><td>${money(g.spent)}</td>
      <td>${g.last_stay?fmtDate(g.last_stay, false):'—'}${g.next_stay?` · <b>${fmtDate(g.next_stay, false)}</b>`:''}</td><td>${md(g.birthday)||'—'}</td><td>${md(g.anniversary)||'—'}</td><td class="muted">${esc((g.preferences||'').slice(0,80))}</td><td>${chatBtn(null, g.phone)}</td></tr>`), 'No guests yet.');
  const qi=$('gpQ'); qi.oninput=()=>{ gpQ=qi.value; clearTimeout(qi.t); qi.t=setTimeout(()=>{ R.profiles($('view')).then(()=>{ const n=$('gpQ'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }); }, 300); };
};
function gpForm(key){
  const g=key?(window._guests||[]).find(x=>x.phone_key===key):{};
  const yr=s=>s?`2000-${s}`:'';
  formModal(key?(g.name||'Guest'):'Add guest', [{n:'name', l:'Name'}, {n:'phone', l:'WhatsApp number'}, {n:'birthday', l:'Birthday', t:'date', hint:'Only day and month are kept'}, {n:'anniversary', l:'Anniversary', t:'date'},
    {n:'preferences', l:'Preferences (food, room, celebrations)', t:'textarea', full:true}, {n:'notes', l:'Private notes', t:'textarea', full:true}], {...g, birthday:yr(g.birthday), anniversary:yr(g.anniversary)},
  async v=>{ await sapi('guests', 'PUT', v); toast('Saved'); rerender(); });
}
R.guests=R.profiles; // Guests in the menu shows profiles once “Guest profiles” is on
