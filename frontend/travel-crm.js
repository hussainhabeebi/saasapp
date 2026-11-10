/* ── 📲 TRAVEL CRM TOOLS (travel agency accounts, optional) ─────────────────────────────────────────
   Settings → 🧩 Industry Modules → 📲 Travel CRM tools (CLIENTS.travel_crm_enabled = 'Yes'). Offered
   only to travel agency accounts (industry 'travel' or the Travel Agency module on); while it is off
   nothing on screen changes. When on:
     • every enquiry shows the WhatsApp number it came in on (lead.InboxId → worker /travel-crm/numbers)
     • an Enquiry type label and a Route label on the lead (Leads list, table, 🗂 Pipeline, 📌 Status Board)
     • lead → 🧳 Travel profile: number, enquiry type, route and the customer's travel dates (one row
       per trip). A trip whose dates are over shows ✅ Completed by itself — the worker also stamps
       TripStatus every morning (cloudflare-worker/travel-crm.js)
     • filters by WhatsApp number, route, enquiry type and travel date (Leads, Pipeline, Status Board)
     • Reports → 📲 WhatsApp Numbers: leads and conversions per number, by enquiry type and by route.
   Stored on the lead (NocoDB Leads, columns created on first use like every other optional field):
     EnquiryType, TravelRoute ("Calicut → Dubai"), TravelTrips (JSON [{id, route, depart, ret, note}]),
     TripStatus (Upcoming | Travelling | Completed), NextTravelDate (YYYY-MM-DD).
   Settings: CLIENTS.travel_crm_config = {"enquiry_types":[…], "routes":[…]}.
   Uses dashboard.html's globals: $id, esc, allLeads, clientRecord, clientId, CONFIG, ncAuthHeaders,
   ncPatch, ensureLeadsField, ensureClientField, patchClient, showToast, TODAY, isWonLead, isLostLead,
   rptLeads, _rptOlder, rptLoadOlderLeads, _reportsPage, currentLead, navigate.
   Bump the ?v= on its <script> tag in dashboard.html when changing this file — sw.js serves
   scripts cache-first. ── */

const TC_DEFAULT_TYPES=['Air Ticket','Holiday Package','Visa','Hotel Booking','Umrah / Hajj','Group Booking','Other'];
const TC_DEFAULT_ROUTES=['Calicut → Dubai','Calicut → Sharjah','Kochi → Dubai'];
const TC_TYPE_ICON={'Air Ticket':'✈️','Holiday Package':'🏝️','Visa':'🛂','Hotel Booking':'🏨','Umrah / Hajj':'🕋','Group Booking':'👥','Other':'🏷️'};
const TC_FIELDS=['EnquiryType','TravelRoute',['TravelTrips','LongText'],'TripStatus','NextTravelDate'];
const TC_STATUS={Upcoming:['🗓️','up'], Travelling:['🧳','now'], Completed:['✅','done']};

function tcIsTravelAccount(){ return typeof clientRecord!=='undefined' && !!clientRecord && (clientRecord.industry==='travel' || clientRecord.ta_enabled==='Yes'); }
function tcOn(){ return tcIsTravelAccount() && String(clientRecord.travel_crm_enabled||'').trim().toLowerCase()==='yes'; }
const tcToday=()=>new Date().toISOString().slice(0,10);
const tcTypeIcon=t=>TC_TYPE_ICON[t]||'🏷️';

// Same rules as the worker's travelCrmNormRoute: "calicut to dubai" → "Calicut → Dubai".
function tcNormRoute(raw){
  const s=String(raw||'').replace(/\s+/g,' ').trim();
  if(!s) return '';
  let parts=s.split(/\s*(?:→|->|=>|>|–|—|\/)\s*|\s+to\s+|\s+-\s+/i).map(x=>x.trim()).filter(Boolean);
  if(parts.length<2 && !/\s/.test(s)) parts=s.split('-').map(x=>x.trim()).filter(Boolean);
  const cap=w=>w.length<=3&&w===w.toUpperCase()?w:w.replace(/\b\w/g,ch=>ch.toUpperCase());
  if(parts.length>=2) return `${cap(parts[0])} → ${cap(parts[parts.length-1])}`.slice(0,80);
  return cap(s).slice(0,80);
}
function tcConfig(){
  let cfg={}; try{ cfg=JSON.parse(clientRecord?.travel_crm_config||'{}')||{}; }catch(e){}
  const list=(v,d,norm)=>{ const a=Array.isArray(v)?v.map(x=>norm?norm(x):String(x||'').trim().slice(0,60)).filter(Boolean):[]; return a.length?[...new Set(a)]:d.slice(); };
  return {enquiry_types:list(cfg.enquiry_types, TC_DEFAULT_TYPES), routes:list(cfg.routes, TC_DEFAULT_ROUTES, tcNormRoute)};
}

/* ── Travel dates → trip status (same rules as the worker) ── */
const tcDay=v=>{ const s=String(v||'').trim().slice(0,10); return /^\d{4}-\d{2}-\d{2}$/.test(s)?s:''; };
function tcParseTrips(raw){
  let v=raw; if(typeof v==='string'){ try{ v=JSON.parse(v||'[]'); }catch(e){ v=[]; } }
  return (Array.isArray(v)?v:[]).filter(t=>t&&typeof t==='object').map(t=>({id:String(t.id||'').slice(0,40), route:tcNormRoute(t.route), depart:tcDay(t.depart), ret:tcDay(t.ret), note:String(t.note||'').slice(0,300)})).filter(t=>t.depart||t.ret);
}
function tcLeadTrips(l){
  const trips=tcParseTrips(l?.TravelTrips);
  if(trips.length) return trips;
  const [a,b]=String(l?.TravelDates||'').split('→').map(tcDay);
  return a||b?[{id:'legacy', route:tcNormRoute(l?.TravelRoute||''), depart:a||b, ret:b||'', note:''}]:[];
}
function tcTripStatus(t, today=tcToday()){
  const start=t.depart||t.ret, end=t.ret||t.depart;
  if(!start) return '';
  return end<today?'Completed':start<=today?'Travelling':'Upcoming';
}
function tcLeadTripStatus(l, today=tcToday()){
  const st=tcLeadTrips(l).map(t=>tcTripStatus(t,today));
  if(!st.length) return '';
  return st.includes('Travelling')?'Travelling':st.includes('Upcoming')?'Upcoming':'Completed';
}
function tcNextDate(l, today=tcToday()){
  const ds=tcLeadTrips(l).map(t=>t.depart||t.ret).filter(Boolean).sort();
  return ds.find(d=>d>=today)||ds[ds.length-1]||'';
}
function tcLeadRoutes(l){ return [...new Set([tcNormRoute(l?.TravelRoute), ...tcLeadTrips(l).map(t=>t.route)].filter(Boolean))]; }
function tcFmtDate(d){ try{ return new Date(d+'T00:00:00').toLocaleDateString([], {day:'numeric', month:'short', year:d.slice(0,4)===tcToday().slice(0,4)?undefined:'numeric'}); }catch(e){ return d; } }
function tcTripDates(t){ return t.depart&&t.ret&&t.ret!==t.depart?`${tcFmtDate(t.depart)} → ${tcFmtDate(t.ret)}`:tcFmtDate(t.depart||t.ret); }
function tcStatusChip(st){ const s=TC_STATUS[st]; return s?`<span class="tc-chip tc-st-${s[1]}">${s[0]} ${esc(st)}</span>`:''; }

/* ── WhatsApp numbers (Chatwoot WhatsApp inboxes) ── */
let _tcNumbers=null, _tcNumbersP=null;
const tcNumKey=()=>`lv_tcnums_${typeof clientId!=='undefined'?clientId:''}`;
function tcLoadNumbers(force){
  if(_tcNumbersP && !force) return _tcNumbersP;
  _tcNumbersP=fetch(`${CONFIG.WORKER_BASE}/travel-crm/numbers`,{headers:ncAuthHeaders()}).then(r=>r.ok?r.json():null).then(d=>{
    if(!Array.isArray(d?.numbers)) return;
    const changed=JSON.stringify(d.numbers)!==JSON.stringify(_tcNumbers);
    _tcNumbers=d.numbers;
    try{ localStorage.setItem(tcNumKey(), JSON.stringify(d.numbers)); }catch(e){}
    if(changed) tcRefreshViews();
  }).catch(()=>{});
  return _tcNumbersP;
}
function tcNumbers(){
  if(!_tcNumbers){ try{ const c=JSON.parse(localStorage.getItem(tcNumKey())||'null'); if(Array.isArray(c)) _tcNumbers=c; }catch(e){} }
  if(!_tcNumbersP && tcOn()) tcLoadNumbers();
  return _tcNumbers||[];
}
function tcNumberOf(l){
  const id=String(l?.InboxId||''); if(!id) return null;
  return tcNumbers().find(n=>String(n.inbox_id)===id)||{inbox_id:id, name:'', phone:''};
}
function tcNumberLabel(n){ if(!n) return ''; return n.name&&n.phone?`${n.name} · ${n.phone}`:(n.name||n.phone||`WhatsApp channel #${n.inbox_id}`); }
function tcNumberShort(n){ return n?(n.name||n.phone||`#${n.inbox_id}`):''; }

/* ── Styles ── */
let _tcStyled=false;
function tcInjectStyle(){
  if(_tcStyled) return; _tcStyled=true;
  const st=document.createElement('style');
  st.textContent=`
  .tc-chip{display:inline-flex;align-items:center;gap:3px;font-size:11px;line-height:1.5;padding:1px 8px;border-radius:999px;border:1px solid var(--line,#e5e7eb);background:var(--card,#fff);color:var(--ink,#111);white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis;vertical-align:middle}
  .tc-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
  .tc-num{background:#E7F8EF;border-color:#A7E3C2;color:#065F46}
  .tc-type{background:#EEF2FF;border-color:#C7D2FE;color:#3730A3}
  .tc-route{background:#FFF7ED;border-color:#FED7AA;color:#9A3412}
  .tc-st-up{background:#EFF6FF;border-color:#BFDBFE;color:#1E40AF}
  .tc-st-now{background:#FEF9C3;border-color:#FDE68A;color:#854D0E}
  .tc-st-done{background:#DCFCE7;border-color:#86EFAC;color:#166534;font-weight:600}
  @media (prefers-color-scheme:dark){ .tc-num,.tc-type,.tc-route,.tc-st-up,.tc-st-now,.tc-st-done{background:transparent;color:inherit} }
  .tc-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0 0 12px}
  .tc-bar select,.tc-bar input{font:inherit;font-size:12.5px;padding:7px 9px;border:1px solid var(--line,#e5e7eb);border-radius:8px;background:var(--card,#fff);color:inherit;max-width:220px;min-width:0}
  .tc-bar .tc-lbl{font-size:12px;font-weight:600;color:var(--muted,#6b7280)}
  .tc-bar .tc-clear{font-size:12px;border:0;background:none;color:var(--accent-ink,#0D9C93);cursor:pointer;text-decoration:underline}
  .tc-bar .on{border-color:var(--accent,#0D9C93);box-shadow:0 0 0 1px var(--accent,#0D9C93)}
  .tc-card{border:1px solid var(--line,#e5e7eb);border-radius:12px;padding:12px 14px;margin-bottom:14px;background:var(--card,#fff)}
  .tc-hd{display:flex;align-items:center;gap:8px;justify-content:space-between;font-weight:700;font-size:13px;margin-bottom:8px}
  .tc-src{font-size:12.5px;margin-bottom:10px}
  .tc-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
  @media (max-width:520px){ .tc-grid{grid-template-columns:1fr} }
  .tc-trip{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 0;border-top:1px solid var(--line,#e5e7eb);font-size:12.5px}
  .tc-trip .tc-tmain{flex:1;min-width:160px}
  .tc-trip .tc-tnote{display:block;color:var(--muted,#6b7280);font-size:11.5px}
  .tc-ic{border:0;background:none;cursor:pointer;font-size:14px;padding:2px 4px}
  .tc-form{border-top:1px solid var(--line,#e5e7eb);padding-top:10px;margin-top:4px;display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .tc-form .tc-full{grid-column:1/-1}
  @media (max-width:520px){ .tc-form{grid-template-columns:1fr} }
  `;
  document.head.appendChild(st);
}
function tcEnsureRouteList(){
  let dl=$id('tcRouteList');
  if(!dl){ dl=document.createElement('datalist'); dl.id='tcRouteList'; document.body.appendChild(dl); }
  const routes=[...new Set([...tcConfig().routes, ...(typeof allLeads!=='undefined'?allLeads:[]).flatMap(tcLeadRoutes)])];
  dl.innerHTML=routes.map(r=>`<option value="${esc(r)}"></option>`).join('');
}

/* ── Labels on lead rows / cards ── */
function tcChipsHTML(l, opts={}){
  if(!tcOn()||!l) return '';
  tcInjectStyle();
  const n=tcNumberOf(l), out=[];
  if(n) out.push(`<span class="tc-chip tc-num" title="Came in on WhatsApp number: ${esc(tcNumberLabel(n))}">📲 ${esc(tcNumberShort(n))}</span>`);
  if(l.EnquiryType) out.push(`<span class="tc-chip tc-type" title="Enquiry type">${tcTypeIcon(l.EnquiryType)} ${esc(l.EnquiryType)}</span>`);
  const route=tcLeadRoutes(l)[0];
  if(route) out.push(`<span class="tc-chip tc-route" title="Route">🛫 ${esc(route)}</span>`);
  const st=tcLeadTripStatus(l);
  if(st){ const next=tcNextDate(l); out.push(st==='Completed'?tcStatusChip(st):`<span class="tc-chip tc-st-${TC_STATUS[st][1]}" title="Travel date">${TC_STATUS[st][0]} ${esc(next?tcFmtDate(next):st)}</span>`); }
  if(!out.length) return '';
  return opts.inline?out.join(' '):`<div class="tc-chips">${out.join('')}</div>`;
}

/* ── Filters: WhatsApp number, route, enquiry type, travel date ── */
let _tcF={num:'', route:'', type:'', date:'', from:'', to:''};
const tcPrefKey=()=>`lv_tcf_${typeof clientId!=='undefined'?clientId:''}`;
(function(){ try{ const p=JSON.parse(sessionStorage.getItem(tcPrefKey())||'null'); if(p&&typeof p==='object') _tcF={..._tcF, ...p}; }catch(e){} })();
const tcFiltering=()=>tcOn()&&!!(_tcF.num||_tcF.route||_tcF.type||_tcF.date);
function tcAddDays(iso, n){ const d=new Date(iso+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
function tcMonthRange(offset){ const t=new Date(); const a=new Date(Date.UTC(t.getFullYear(), t.getMonth()+offset, 1)); const b=new Date(Date.UTC(t.getFullYear(), t.getMonth()+offset+1, 0)); return [a.toISOString().slice(0,10), b.toISOString().slice(0,10)]; }
function tcDateMatch(l){
  const f=_tcF.date; if(!f) return true;
  const today=tcToday(), trips=tcLeadTrips(l);
  if(f==='none') return !trips.length;
  if(!trips.length) return false;
  const st=trips.map(t=>tcTripStatus(t,today));
  if(f==='travelling') return st.includes('Travelling');
  if(f==='upcoming') return st.includes('Upcoming');
  if(f==='completed') return tcLeadTripStatus(l,today)==='Completed';
  let a='', b='';
  if(f==='next7'){ a=today; b=tcAddDays(today,7); }
  else if(f==='next30'){ a=today; b=tcAddDays(today,30); }
  else if(f==='month') [a,b]=tcMonthRange(0);
  else if(f==='nextmonth') [a,b]=tcMonthRange(1);
  else if(f==='custom'){ a=_tcF.from; b=_tcF.to; }
  // A trip counts when any of its days falls in the range.
  return trips.some(t=>{ const s=t.depart||t.ret, e=t.ret||t.depart; return (!b||s<=b)&&(!a||e>=a); });
}
function tcMatch(l){
  if(!tcFiltering()) return true;
  if(_tcF.num){ const id=String(l.InboxId||''); if(_tcF.num==='__none'?!!id:id!==_tcF.num) return false; }
  if(_tcF.type){ const t=String(l.EnquiryType||''); if(_tcF.type==='__none'?!!t:t!==_tcF.type) return false; }
  if(_tcF.route){ const r=tcLeadRoutes(l); if(_tcF.route==='__none'?r.length>0:!r.includes(_tcF.route)) return false; }
  return tcDateMatch(l);
}
function tcFilterLeads(list){ return tcFiltering()?list.filter(tcMatch):list; }
function tcBarHTML(){
  if(!tcOn()) return '';
  tcInjectStyle();
  const leads=typeof allLeads!=='undefined'?allLeads:[];
  const cnt={num:{}, type:{}, route:{}};
  for(const l of leads){
    const id=String(l.InboxId||'__none'); cnt.num[id]=(cnt.num[id]||0)+1;
    const t=String(l.EnquiryType||'__none'); cnt.type[t]=(cnt.type[t]||0)+1;
    const rs=tcLeadRoutes(l); (rs.length?rs:['__none']).forEach(r=>{ cnt.route[r]=(cnt.route[r]||0)+1; });
  }
  const nums=[...tcNumbers()];
  Object.keys(cnt.num).filter(k=>k!=='__none'&&!nums.some(n=>String(n.inbox_id)===k)).forEach(k=>nums.push({inbox_id:k,name:'',phone:''}));
  const cfg=tcConfig();
  const types=[...new Set([...cfg.enquiry_types, ...Object.keys(cnt.type).filter(k=>k!=='__none')])];
  const routes=[...new Set([...cfg.routes, ...Object.keys(cnt.route).filter(k=>k!=='__none')])];
  const opt=(v,label,cur,c)=>`<option value="${esc(v)}"${cur===v?' selected':''}>${esc(label)}${c!==undefined?` (${c||0})`:''}</option>`;
  const on=k=>_tcF[k]?' on':'';
  return `<div class="tc-bar" role="group" aria-label="Travel filters">
    <span class="tc-lbl">🧳 Travel filters</span>
    <select class="${on('num')}" aria-label="WhatsApp number" title="WhatsApp number the enquiry came in on" onchange="tcSet('num',this.value)">
      ${opt('','📲 All WhatsApp numbers',_tcF.num)}${nums.map(n=>opt(String(n.inbox_id), tcNumberLabel(n), _tcF.num, cnt.num[String(n.inbox_id)])).join('')}${opt('__none','No WhatsApp number',_tcF.num,cnt.num.__none)}
    </select>
    <select class="${on('route')}" aria-label="Route" onchange="tcSet('route',this.value)">
      ${opt('','🛫 All routes',_tcF.route)}${routes.map(r=>opt(r,r,_tcF.route,cnt.route[r])).join('')}${opt('__none','No route',_tcF.route,cnt.route.__none)}
    </select>
    <select class="${on('type')}" aria-label="Enquiry type" onchange="tcSet('type',this.value)">
      ${opt('','🏷️ All enquiry types',_tcF.type)}${types.map(t=>opt(t,`${tcTypeIcon(t)} ${t}`,_tcF.type,cnt.type[t])).join('')}${opt('__none','No enquiry type',_tcF.type,cnt.type.__none)}
    </select>
    <select class="${on('date')}" aria-label="Travel date" onchange="tcSet('date',this.value)">
      ${[['','📅 Any travel date'],['travelling','🧳 Travelling now'],['next7','Departing in 7 days'],['next30','Departing in 30 days'],['month','This month'],['nextmonth','Next month'],['upcoming','All upcoming'],['completed','✅ Completed trips'],['none','No travel date'],['custom','Custom dates…']].map(([v,l])=>opt(v,l,_tcF.date)).join('')}
    </select>
    ${_tcF.date==='custom'?`<input type="date" aria-label="Travel from" value="${esc(_tcF.from)}" onchange="tcSet('from',this.value)"><input type="date" aria-label="Travel to" value="${esc(_tcF.to)}" onchange="tcSet('to',this.value)">`:''}
    ${tcFiltering()?'<button class="tc-clear" onclick="tcClearFilters()">Clear</button>':''}
  </div>`;
}
function tcRenderBar(id){ const el=$id(id); if(!el) return; const h=tcBarHTML(); el.innerHTML=h; el.style.display=h?'':'none'; }
function tcSet(k,v){
  _tcF[k]=String(v||'');
  if(k==='date'&&v!=='custom'){ _tcF.from=''; _tcF.to=''; }
  try{ sessionStorage.setItem(tcPrefKey(), JSON.stringify(_tcF)); }catch(e){}
  tcRefreshViews();
}
function tcClearFilters(){ _tcF={num:'', route:'', type:'', date:'', from:'', to:''}; try{ sessionStorage.removeItem(tcPrefKey()); }catch(e){} tcRefreshViews(); }
// Leads filtered by one value (Reports rows link here).
function tcOpenLeads(k,v){
  _tcF={num:'', route:'', type:'', date:'', from:'', to:''}; _tcF[k]=String(v||'');
  try{ sessionStorage.setItem(tcPrefKey(), JSON.stringify(_tcF)); }catch(e){}
  if(typeof navigate==='function') navigate('leads');
  setTimeout(()=>{ if(typeof setLeadsViewMode==='function') setLeadsViewMode('list'); tcRefreshViews(); }, 0);
}
const tcVisible=id=>{ const el=$id(id); return !!el && !el.classList.contains('hidden'); };
function tcRefreshViews(){
  try{
    if(tcVisible('pageLeads')){
      const mode=typeof _leadsViewMode!=='undefined'?_leadsViewMode:'list';
      if(mode==='pipeline'){ if(typeof renderKanban==='function') renderKanban(); }
      else if(mode==='list' && typeof renderLeadsCurrentView==='function') renderLeadsCurrentView();
    }
    if(tcVisible('pageTvstatus') && typeof renderTravelStatus==='function') renderTravelStatus();
    if(tcVisible('pageReports') && typeof _reportsPage!=='undefined' && _reportsPage==='tcnumbers') renderReportsTcNumbers();
    if(typeof currentLead!=='undefined' && currentLead && $id('modalDetail')?.classList.contains('open')) tcRenderDetail(currentLead);
  }catch(e){ console.warn('[travel-crm] refresh', e); }
}

/* ── Saving to the lead ── */
let _tcFieldsReady=false;
async function tcEnsureFields(){
  if(_tcFieldsReady) return;
  await Promise.all(TC_FIELDS.map(f=>Array.isArray(f)?ensureLeadsField(f[0],f[1]):ensureLeadsField(f)));
  _tcFieldsReady=true;
}
async function tcSaveLead(id, patch, okMsg){
  const lead=(typeof allLeads!=='undefined'?allLeads:[]).find(l=>Number(l.Id)===Number(id));
  if(!lead) return false;
  const full={...patch};
  if('TravelTrips' in patch || 'TravelRoute' in patch){
    const probe={...lead, ...full};
    full.TripStatus=tcLeadTripStatus(probe); full.NextTravelDate=tcNextDate(probe);
  }
  const before={}; Object.keys(full).forEach(k=>{ before[k]=lead[k]; });
  Object.assign(lead, full);
  if(typeof _noteLeadEdits==='function') _noteLeadEdits({Id:lead.Id, ...full});
  tcRefreshViews();
  try{
    await tcEnsureFields();
    await ncPatch(`${CONFIG.NOCODB_BASE}/api/v2/tables/${CONFIG.LEADS_TABLE_ID}/records`, {Id:Number(lead.Id), ...full});
    if(typeof _cacheLeadsSoon==='function') _cacheLeadsSoon();
    if(okMsg && typeof showToast==='function') showToast(okMsg);
    return true;
  }catch(e){
    if(typeof _dropLeadEdits==='function') _dropLeadEdits({Id:lead.Id});
    Object.assign(lead, before);
    tcRefreshViews();
    if(typeof showToast==='function') showToast('Could not save — '+e.message, 'err');
    return false;
  }
}
function tcSetType(id, v){ return tcSaveLead(id, {EnquiryType:String(v||'').trim()}, v?`Enquiry type: ${v}`:'Enquiry type cleared'); }
function tcSetRoute(id, v){ const r=tcNormRoute(v); return tcSaveLead(id, {TravelRoute:r}, r?`Route: ${r}`:'Route cleared'); }

/* ── Lead → 🧳 Travel profile ── */
let _tcEdit=null; // {leadId, tripId} while the add/edit trip form is open ('' = new trip)
function tcRenderDetail(lead){
  const el=$id('detailTravelCrm'); if(!el) return;
  if(!tcOn()||!lead){ el.innerHTML=''; el.style.display='none'; return; }
  tcInjectStyle(); tcEnsureRouteList();
  if(_tcEdit && Number(_tcEdit.leadId)!==Number(lead.Id)) _tcEdit=null;
  const id=Number(lead.Id), n=tcNumberOf(lead), trips=tcLeadTrips(lead), st=tcLeadTripStatus(lead), cfg=tcConfig();
  const cur=String(lead.EnquiryType||'');
  const types=cur&&!cfg.enquiry_types.includes(cur)?[cur,...cfg.enquiry_types]:cfg.enquiry_types;
  const src=n?`📲 Came in on <b>${esc(tcNumberLabel(n))}</b>`
    :String(lead.Channel||'')==='instagram'||String(lead.Phone||'').startsWith('ig:')?'📷 Came in on Instagram — not a WhatsApp number'
    :'<span style="color:var(--muted)">📲 No WhatsApp number recorded (added manually, imported, or from before numbers were tracked)</span>';
  const sorted=trips.slice().sort((a,b)=>String(a.depart||a.ret).localeCompare(String(b.depart||b.ret)));
  el.style.display='';
  el.innerHTML=`<div class="tc-card">
    <div class="tc-hd"><span>🧳 Travel profile</span>${st?tcStatusChip(st):''}</div>
    <div class="tc-src">${src}</div>
    <div class="tc-grid">
      <div><label class="form-label">Enquiry type</label>
        <select class="form-input" onchange="tcSetType(${id},this.value)"><option value="">— Select —</option>${types.map(t=>`<option value="${esc(t)}"${t===cur?' selected':''}>${tcTypeIcon(t)} ${esc(t)}</option>`).join('')}</select></div>
      <div><label class="form-label">Route</label>
        <input class="form-input" list="tcRouteList" placeholder="e.g. Calicut → Dubai" value="${esc(tcNormRoute(lead.TravelRoute))}" onchange="tcSetRoute(${id},this.value)"></div>
    </div>
    <div class="form-label" style="margin-bottom:2px">Travel dates</div>
    ${sorted.length?sorted.map(t=>_tcEdit&&_tcEdit.tripId===t.id?tcTripFormHTML(id,t):`<div class="tc-trip">
        <div class="tc-tmain"><b>${esc(tcTripDates(t))}</b>${t.route?` · 🛫 ${esc(t.route)}`:''}${t.note?`<span class="tc-tnote">${esc(t.note)}</span>`:''}</div>
        ${tcStatusChip(tcTripStatus(t))}
        <button class="tc-ic" title="Edit" aria-label="Edit travel dates" onclick="tcEditTrip(${id},'${esc(t.id)}')">✏️</button>
        <button class="tc-ic" title="Remove" aria-label="Remove travel dates" onclick="tcDeleteTrip(${id},'${esc(t.id)}')">🗑️</button>
      </div>`).join(''):'<div class="s-note" style="margin:2px 0 6px">No travel dates yet — add the dates the customer shared.</div>'}
    ${_tcEdit&&_tcEdit.tripId===''?tcTripFormHTML(id,null):`<button class="btn btn-secondary btn-sm" style="margin-top:6px" onclick="tcEditTrip(${id},'')">+ Add travel dates</button>`}
    <div class="s-note" style="margin-top:8px">A trip shows ✅ Completed by itself once its last travel day has passed.</div>
  </div>`;
}
function tcTripFormHTML(id, t){
  const lead=allLeads.find(l=>Number(l.Id)===Number(id));
  const route=t?t.route:tcNormRoute(lead?.TravelRoute);
  return `<div class="tc-form">
    <div class="tc-full"><label class="form-label">Route</label><input class="form-input" id="tcTripRoute" list="tcRouteList" placeholder="e.g. Kochi → Dubai" value="${esc(route||'')}"></div>
    <div><label class="form-label">Travel date</label><input class="form-input" id="tcTripDepart" type="date" value="${esc(t?.depart||'')}"></div>
    <div><label class="form-label">Return date <span class="s-note" style="display:inline">(optional)</span></label><input class="form-input" id="tcTripRet" type="date" value="${esc(t?.ret||'')}"></div>
    <div class="tc-full"><label class="form-label">Note <span class="s-note" style="display:inline">(optional)</span></label><input class="form-input" id="tcTripNote" maxlength="300" placeholder="e.g. 2 adults, flexible ±2 days" value="${esc(t?.note||'')}"></div>
    <div class="tc-full" style="display:flex;gap:8px"><button class="btn btn-primary btn-sm" onclick="tcSaveTrip(${id})">Save dates</button><button class="btn btn-secondary btn-sm" onclick="tcCancelTrip()">Cancel</button><span class="save-msg err" id="tcTripMsg"></span></div>
  </div>`;
}
function tcEditTrip(id, tripId){ _tcEdit={leadId:Number(id), tripId:String(tripId)}; const l=allLeads.find(x=>Number(x.Id)===Number(id)); if(l) tcRenderDetail(l); setTimeout(()=>$id('tcTripDepart')?.focus(),0); }
function tcCancelTrip(){ const id=_tcEdit?.leadId; _tcEdit=null; const l=allLeads.find(x=>Number(x.Id)===Number(id)); if(l) tcRenderDetail(l); }
// The lead's trips as stored: the older TravelDates value becomes a real trip the first time they're edited.
function tcStoredTrips(lead){ return tcLeadTrips(lead).map(t=>t.id==='legacy'||!t.id?{...t, id:tcNewId()}:t); }
const tcNewId=()=>'t'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
async function tcSaveTrip(id){
  const lead=allLeads.find(l=>Number(l.Id)===Number(id)); if(!lead||!_tcEdit) return;
  const route=tcNormRoute($id('tcTripRoute')?.value), depart=tcDay($id('tcTripDepart')?.value), ret=tcDay($id('tcTripRet')?.value), note=String($id('tcTripNote')?.value||'').trim().slice(0,300);
  const msg=$id('tcTripMsg');
  if(!depart&&!ret){ if(msg) msg.textContent='Pick the travel date.'; return; }
  if(depart&&ret&&ret<depart){ if(msg) msg.textContent='The return date is before the travel date.'; return; }
  let trips=tcStoredTrips(lead);
  const editId=_tcEdit.tripId==='legacy'?trips.find(t=>t.depart===tcLeadTrips(lead)[0]?.depart)?.id:_tcEdit.tripId;
  const trip={id:editId||tcNewId(), route, depart:depart||ret, ret:depart?ret:'', note};
  trips=editId?trips.map(t=>t.id===editId?trip:t):[...trips, trip];
  const patch={TravelTrips:JSON.stringify(trips.slice(-30))};
  if(route&&!tcNormRoute(lead.TravelRoute)) patch.TravelRoute=route;
  _tcEdit=null;
  await tcSaveLead(id, patch, 'Travel dates saved');
}
async function tcDeleteTrip(id, tripId){
  const lead=allLeads.find(l=>Number(l.Id)===Number(id)); if(!lead) return;
  if(!confirm('Remove these travel dates?')) return;
  const all=tcLeadTrips(lead);
  const idx=all.findIndex(t=>t.id===tripId);
  const trips=tcStoredTrips(lead).filter((t,i)=>i!==idx);
  const patch={TravelTrips:JSON.stringify(trips)};
  // The older TravelDates field would otherwise bring a removed legacy trip straight back.
  if(tripId==='legacy'||!trips.length) patch.TravelDates='';
  await tcSaveLead(id, patch, 'Travel dates removed');
}

/* ── Reports → 📲 WhatsApp Numbers ── */
function renderReportsTcNumbers(){
  const box=$id('reportsContent'); if(!box) return;
  if(!tcOn()){ box.innerHTML='<div class="s-note">Turn on 📲 Travel CRM tools in Settings → Industry Modules to see this report.</div>'; return; }
  tcInjectStyle();
  if(typeof _rptOlder!=='undefined' && !_rptOlder.loading && Date.now()-_rptOlder.at>300000 && typeof rptLoadOlderLeads==='function')
    rptLoadOlderLeads().then(()=>{ if(_reportsPage==='tcnumbers') renderReportsTcNumbers(); });
  const loadedIds=new Set(allLeads.map(l=>l.Id));
  const older=typeof _rptOlder!=='undefined'?_rptOlder.list.filter(l=>!loadedIds.has(l.Id)):[];
  const leads=rptLeads(allLeads.concat(older));
  const nums=tcNumbers();
  const numName=k=>k==='__none'?'No WhatsApp number':tcNumberLabel(nums.find(n=>String(n.inbox_id)===k)||{inbox_id:k});
  const dealCcy=clientRecord?.deal_currency||'';
  const money=v=>v?(dealCcy?dealCcy+' ':'')+Math.round(v).toLocaleString():'—';
  const blank=()=>({total:0, open:0, won:0, lost:0, value:0});
  const add=(r,l)=>{ r.total++; if(isWonLead(l)){ r.won++; r.value+=Number(l.DealValue)||0; } else if(isLostLead(l)) r.lost++; else r.open++; };
  const byNum={}, byRoute={}, matrix={}, typesSeen=new Set();
  for(const l of leads){
    const k=String(l.InboxId||'')||'__none';
    add(byNum[k]=byNum[k]||blank(), l);
    const t=String(l.EnquiryType||'')||'—'; typesSeen.add(t);
    const m=matrix[k]=matrix[k]||{}; m[t]=m[t]||{total:0, won:0}; m[t].total++; if(isWonLead(l)) m[t].won++;
    const r=tcLeadRoutes(l)[0]||'—';
    add(byRoute[r]=byRoute[r]||blank(), l);
  }
  // Every connected number gets a row, even with no leads in the period.
  nums.forEach(n=>{ byNum[String(n.inbox_id)]=byNum[String(n.inbox_id)]||blank(); });
  const pct=r=>r.total?Math.round(r.won/r.total*100)+'%':'—';
  const numRows=Object.entries(byNum).sort((a,b)=>(a[0]==='__none')-(b[0]==='__none')||b[1].total-a[1].total);
  const tot=numRows.reduce((t,[,r])=>({total:t.total+r.total, open:t.open+r.open, won:t.won+r.won, lost:t.lost+r.lost, value:t.value+r.value}), blank());
  const types=[...typesSeen].sort((a,b)=>(a==='—')-(b==='—')||a.localeCompare(b));
  const routeRows=Object.entries(byRoute).sort((a,b)=>(a[0]==='—')-(b[0]==='—')||b[1].total-a[1].total);
  const js=v=>esc(JSON.stringify(v));
  box.innerHTML=`
    <div class="s-note" style="margin-bottom:12px">Leads and conversions (Won) per WhatsApp number the enquiry came in on. Period and member filters apply; leads are counted by the date they came in. Tap a row to open those leads.</div>
    <div style="display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:14px">
      <div class="stat"><div class="stat-lbl">Leads</div><div class="stat-val">${tot.total}</div></div>
      <div class="stat"><div class="stat-lbl">WhatsApp numbers</div><div class="stat-val">${numRows.filter(([k])=>k!=='__none').length}</div></div>
      <div class="stat"><div class="stat-lbl">Conversions (Won)</div><div class="stat-val">${tot.won}</div></div>
      <div class="stat"><div class="stat-lbl">Conversion</div><div class="stat-val">${pct(tot)}</div></div>
    </div>
    <div class="card" style="margin-bottom:14px">
      <div class="card-title">📲 Leads &amp; conversions by WhatsApp number</div>
      <div style="overflow-x:auto"><table class="leads-tbl" style="width:100%;min-width:620px">
        <thead><tr><th>WhatsApp number</th><th>Leads</th><th>Open</th><th>Won</th><th>Lost</th><th>Conversion</th><th>Won value</th></tr></thead>
        <tbody>${numRows.map(([k,r])=>`<tr style="cursor:pointer" onclick="tcOpenLeads('num',${js(k)})"><td>${k==='__none'?'—':'📲'} ${esc(numName(k))}</td><td><b>${r.total}</b></td><td>${r.open}</td><td style="color:#047857">${r.won}</td><td style="color:#B91C1C">${r.lost}</td><td>${pct(r)}</td><td>${money(r.value)}</td></tr>`).join('')}</tbody>
        <tfoot><tr style="font-weight:700"><td>Total</td><td>${tot.total}</td><td>${tot.open}</td><td>${tot.won}</td><td>${tot.lost}</td><td>${pct(tot)}</td><td>${money(tot.value)}</td></tr></tfoot>
      </table></div>
    </div>
    ${types.length?`<div class="card" style="margin-bottom:14px">
      <div class="card-title">🏷️ Enquiry type by WhatsApp number <span class="s-note" style="display:inline">(leads · won)</span></div>
      <div style="overflow-x:auto"><table class="leads-tbl" style="width:100%;min-width:${200+types.length*110}px">
        <thead><tr><th>WhatsApp number</th>${types.map(t=>`<th>${t==='—'?'No type':`${tcTypeIcon(t)} ${esc(t)}`}</th>`).join('')}</tr></thead>
        <tbody>${numRows.filter(([,r])=>r.total).map(([k])=>`<tr><td>${esc(numName(k))}</td>${types.map(t=>{ const c=matrix[k]?.[t]; return `<td>${c?`<b>${c.total}</b> · <span style="color:#047857">${c.won}</span>`:'—'}</td>`; }).join('')}</tr>`).join('')}</tbody>
      </table></div>
    </div>`:''}
    <div class="card" style="margin-bottom:14px">
      <div class="card-title">🛫 Leads by route</div>
      ${routeRows.length?`<div style="overflow-x:auto"><table class="leads-tbl" style="width:100%;min-width:520px">
        <thead><tr><th>Route</th><th>Leads</th><th>Open</th><th>Won</th><th>Lost</th><th>Conversion</th></tr></thead>
        <tbody>${routeRows.map(([k,r])=>`<tr style="cursor:pointer" onclick="tcOpenLeads('route',${js(k==='—'?'__none':k)})"><td>${k==='—'?'No route':'🛫 '+esc(k)}</td><td><b>${r.total}</b></td><td>${r.open}</td><td style="color:#047857">${r.won}</td><td style="color:#B91C1C">${r.lost}</td><td>${pct(r)}</td></tr>`).join('')}</tbody>
      </table></div>`:'<div style="color:var(--muted);font-size:13px">No leads in this period.</div>'}
    </div>`;
}

/* ── Settings → 🧩 Industry Modules → 📲 Travel CRM tools ── */
function tcInitSettings(){
  const row=$id('tcSettingsRow'); if(!row) return;
  const show=tcIsTravelAccount();
  row.style.display=show?'block':'none';
  if(!show) return;
  const on=tcOn(), cfg=tcConfig();
  const sel=$id('cfgTcEnabled'); if(sel) sel.value=on?'Yes':'No';
  const body=$id('tcSettingsBody'); if(body) body.style.display=on?'':'none';
  const types=$id('cfgTcTypes'); if(types && document.activeElement!==types) types.value=cfg.enquiry_types.join('\n');
  const routes=$id('cfgTcRoutes'); if(routes && document.activeElement!==routes) routes.value=cfg.routes.join('\n');
  const hook=$id('tcEchoUrl'); if(hook) hook.textContent=`${CONFIG.WORKER_BASE}/wa/business-echoes`;
  const badge=$id('tcStatusBadge');
  if(badge && typeof _renderModuleBadge==='function') _renderModuleBadge('tcStatusBadge', on);
  const tab=$id('rptTabTcNumbers'); if(tab) tab.style.display=on?'':'none';
}
function tcToggleSettingsBody(){ const body=$id('tcSettingsBody'); if(body) body.style.display=$id('cfgTcEnabled')?.value==='Yes'?'':'none'; }
async function tcSaveSettings(){
  const btn=$id('saveTcEnabled'), msg=$id('saveTcMsg');
  if(btn) btn.disabled=true; if(msg){ msg.textContent=''; msg.className='save-msg'; }
  try{
    const lines=id=>String($id(id)?.value||'').split(/\n|,/).map(x=>x.trim()).filter(Boolean);
    const enabled=$id('cfgTcEnabled')?.value==='Yes'?'Yes':'No';
    const cfg={enquiry_types:[...new Set(lines('cfgTcTypes').map(x=>x.slice(0,60)))].slice(0,40),
      routes:[...new Set(lines('cfgTcRoutes').map(tcNormRoute).filter(Boolean))].slice(0,100)};
    await ensureClientField('travel_crm_enabled');
    await ensureClientField('travel_crm_config','LongText');
    await patchClient({travel_crm_enabled:enabled, travel_crm_config:JSON.stringify(cfg)});
    clientRecord.travel_crm_enabled=enabled; clientRecord.travel_crm_config=JSON.stringify(cfg);
    if(enabled==='Yes') tcLoadNumbers(true);
    tcInitSettings(); tcRefreshViews();
    if(msg) msg.textContent=enabled==='Yes'?'✓ Saved — Travel CRM tools are on':'✓ Saved — everything works as before';
  }catch(e){ if(msg){ msg.textContent='Error: '+e.message; msg.className='save-msg err'; } }
  finally{ if(btn) btn.disabled=false; setTimeout(()=>{ if(msg) msg.textContent=''; }, 4000); }
}
