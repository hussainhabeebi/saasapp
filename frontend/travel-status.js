/* ── TRAVEL STATUS BOARD (travel workspace → 📌 Status Board) ─────────────────────────────────────
   Staff mark where each inquiry stands — First call done, Follow up pending (with a due date),
   Booking closed, Booking not done… The board shows a count per status, filters, and a row per
   inquiry with an inline status picker.
   Stored on the lead (NocoDB Leads, created on first use like every other optional lead column):
     TravelStatus        status key (TS_STATUSES below)
     TravelFollowUpAt    YYYY-MM-DD, for follow_up_pending
     TravelStatusAt/By   when / who last changed it
     TravelStatusLog     JSON history, newest first: [{at, by, from, to, fu}] — Reports → 📌 Status Changes
   An inquiry with no status yet shows "New inquiry", or "First call done (auto)" once a call is in
   its CallLog — so the board is useful before anyone has marked anything.
   Linked to the lead's pipeline Stage both ways (tsStageFor / tsStatusOf): Booking closed, Ticket
   issued and Travelled mark the lead Won; Booking not done and Cancelled mark it Lost; picking an
   open status on a won/lost lead reopens it (to the pipeline stage of the same name when there is
   one). A lead marked Won / Lost anywhere else shows Booking closed / Booking not done (auto).
   Uses dashboard.html's globals: $id, esc, allLeads, ncPatch, CONFIG, ensureLeadsField, myEmail,
   getTeamMembers, sameEmail, seesAllLeads, parseCallLog, openDetail, showToast, TODAY,
   LEAD_CATEGORIES, serviceCategoryIcon, clientId.
   Bump the ?v= on its <script> tag in dashboard.html when changing this file — sw.js serves
   scripts cache-first. ── */

// Lead origin badge/colour (dashboard.html leadOriginBadge/leadOriginClass) and a phone that
// never shows an Instagram lead's internal "ig:<id>" key.
const tsOriginBadge=l=>typeof leadOriginBadge==='function'?leadOriginBadge(l):'';
const tsOriginClass=l=>typeof leadOriginClass==='function'?leadOriginClass(l):'';
const tsLeadName=l=>(typeof leadDisplayName==='function'?leadDisplayName(l):(l.Name||l.Phone))||'Inquiry';
const tsPhone=l=>String(l?.Phone||'').startsWith('ig:')?'Instagram':(l?.Phone||'');

// [key, label, icon, colour group]. Order = the inquiry's usual journey.
const TS_STATUSES=[
  ['new','New inquiry','🆕','gray'],
  ['first_call','First call done','📞','blue'],
  ['not_reachable','Not reachable','📵','amber'],
  ['quote_sent','Quote sent','📤','blue'],
  ['follow_up_pending','Follow up pending','⏰','amber'],
  ['follow_up_done','Follow up done','✅','blue'],
  ['negotiating','Negotiating','🤝','blue'],
  ['docs_pending','Documents pending','📄','amber'],
  ['payment_pending','Payment pending','💳','amber'],
  ['booking_closed','Booking closed','🎉','green'],
  ['ticket_issued','Ticket / voucher issued','🎫','green'],
  ['travelled','Travelled','🧳','green'],
  ['booking_not_done','Booking not done','❌','red'],
  ['cancelled','Cancelled','🚫','red'],
];
const TS_BY_KEY=Object.fromEntries(TS_STATUSES.map(s=>[s[0],s]));
const TS_WON=new Set(['booking_closed','ticket_issued','travelled']);
const TS_LOST=new Set(['booking_not_done','cancelled']);
const tsStageWon=l=>l?.Stage==='won'||l?.Stage==='converted';
const tsStageLost=l=>l?.Stage==='lost';
// The pipeline Stage a travel status puts the lead in, or null to leave Stage as it is.
function tsStageFor(key, lead){
  if(TS_WON.has(key)) return tsStageWon(lead)?null:'won';
  if(TS_LOST.has(key)) return tsStageLost(lead)?null:'lost';
  let stages=[]; try{ stages=Object.keys((typeof getFlow==='function'?getFlow():{}).stages||{}); }catch(e){}
  if(stages.includes(key)) return lead?.Stage===key?null:key;
  return (tsStageWon(lead)||tsStageLost(lead))?'new':null;
}
const TS_FIELDS=['TravelStatus','TravelFollowUpAt','TravelStatusAt','TravelStatusBy',['TravelStatusLog','LongText']];
const TS_LOG_MAX=200;
const TS_PAGE_SIZE=100;

let _tsFilter={status:'',owner:'',cat:'',q:''};
let _tsShown=TS_PAGE_SIZE;
let _tsFieldsReady=false;

// The status an inquiry is shown with: what staff set, else derived from its calls.
function tsStatusOf(l){
  // The pipeline outcome wins: a lead marked Won / Lost elsewhere (Mark Won, kanban, the bot) never
  // keeps showing an open travel status.
  const k=TS_BY_KEY[l.TravelStatus]?l.TravelStatus:'';
  if(tsStageWon(l)&&!TS_WON.has(k)) return {key:'booking_closed', auto:true};
  if(tsStageLost(l)&&!TS_LOST.has(k)) return {key:'booking_not_done', auto:true};
  if(k) return {key:k, auto:false};
  let calls=[]; try{ calls=parseCallLog(l.CallLog); }catch(e){}
  return calls.length?{key:'first_call', auto:true}:{key:'new', auto:true};
}
function tsFollowUpState(l){
  if(l.TravelStatus!=='follow_up_pending'||!l.TravelFollowUpAt) return '';
  const d=String(l.TravelFollowUpAt).slice(0,10);
  return d<TODAY?'overdue':d===TODAY?'today':'later';
}

function tsInjectStyle(){
  if($id('tsStyle')) return;
  const st=document.createElement('style'); st.id='tsStyle';
  st.textContent=`
.ts-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-bottom:14px}
.ts-tile{background:var(--card);border:1.5px solid var(--line);border-radius:12px;padding:10px 12px;cursor:pointer;text-align:left;font-family:inherit;color:inherit}
.ts-tile:hover{border-color:var(--accent)}
.ts-tile.on{border-color:var(--accent);background:var(--accent-soft)}
.ts-tile .n{font-family:var(--disp);font-size:24px;font-weight:700;line-height:1.1}
.ts-tile .l{font-size:11.5px;color:var(--muted);font-weight:600;margin-top:2px}
.ts-tile.amber .n{color:#B45309}.ts-tile.green .n{color:#047857}.ts-tile.red .n{color:#B91C1C}.ts-tile.blue .n{color:var(--accent-ink)}
.ts-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
.ts-bar .form-input{max-width:220px;padding:8px 10px;font-size:13px}
.ts-tbl{width:100%;border-collapse:collapse;font-size:13px;min-width:820px}
.ts-tbl th{text-align:left;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);padding:8px 10px;border-bottom:1px solid var(--line)}
.ts-tbl td{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:middle}
.ts-tbl tr:hover td{background:var(--accent-soft)}
.ts-tbl a{color:var(--ink);text-decoration:none}.ts-tbl a:hover{color:var(--accent-ink);text-decoration:underline}
.ts-sel{font:inherit;font-size:12.5px;padding:6px 8px;border-radius:8px;border:1.5px solid var(--line);background:var(--card);color:var(--ink);max-width:210px}
.ts-sel.gray{border-color:#CBD5E1}.ts-sel.blue{border-color:#7DD3FC}.ts-sel.amber{border-color:#FBBF24;background:#FFFBEB}.ts-sel.green{border-color:#34D399;background:#ECFDF5}.ts-sel.red{border-color:#F87171;background:#FEF2F2}
.ts-auto{font-size:10.5px;color:var(--muted);margin-left:4px}
.ts-date{font:inherit;font-size:12px;padding:5px 6px;border-radius:8px;border:1.5px solid var(--line);background:var(--card);color:var(--ink)}
.ts-due{font-size:10.5px;font-weight:700;border-radius:6px;padding:2px 6px;margin-left:4px}
.ts-due.overdue{background:#FEE2E2;color:#991B1B}.ts-due.today{background:#FEF3C7;color:#92400E}
.ts-meta{font-size:11px;color:var(--muted)}
.ts-empty{color:var(--muted);text-align:center;padding:24px;font-size:13px}
.ts-inline{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:6px}
.ts-sel-inline{min-height:34px}
.ts-cat{font:inherit;font-size:12.5px;padding:6px 8px;border-radius:8px;border:1.5px solid #CBD5E1;background:var(--card);color:var(--ink);max-width:210px;min-height:34px}
.ts-cat.set{border-color:#7DD3FC}
.ts-chip{display:inline-block;font-size:11.5px;font-weight:600;border-radius:999px;padding:3px 9px;white-space:nowrap;border:1px solid var(--line)}
.ts-chip.gray{background:#F1F5F9;color:#475569}.ts-chip.blue{background:#E0F2FE;color:#075985}.ts-chip.amber{background:#FEF3C7;color:#92400E}.ts-chip.green{background:#DCFCE7;color:#166534}.ts-chip.red{background:#FEE2E2;color:#991B1B}
.ts-rpt-tbl{width:100%;min-width:720px}
@media(max-width:767px){.ts-cat{width:100%;max-width:none;font-size:16px;min-height:42px}.ts-sel-inline{width:100%;max-width:none;font-size:16px;min-height:42px;padding:6px 2px 6px 6px;letter-spacing:-.2px}.ts-inline .ts-due{margin-left:0}}
`;
  document.head.appendChild(st);
}

function tsEnsurePage(){
  if($id('pageTvstatus')) return;
  const d=document.createElement('div'); d.className='page hidden'; d.id='pageTvstatus';
  d.innerHTML='<div class="page-pad" id="tsBody"></div>';
  $id('pages')?.appendChild(d);
}

function tsOwnerName(email){
  if(!email) return 'Unassigned';
  const m=getTeamMembers().find(x=>sameEmail(x.email,email));
  return m?.name||email;
}
function tsAgo(iso){
  if(!iso) return '';
  const m=Math.floor((Date.now()-new Date(iso).getTime())/60000);
  if(m<1) return 'just now'; if(m<60) return m+'m ago';
  const h=Math.floor(m/60); if(h<24) return h+'h ago';
  return Math.floor(h/24)+'d ago';
}

function tsFiltered(){
  const q=_tsFilter.q.trim().toLowerCase();
  return (typeof allLeads!=='undefined'?allLeads:[]).filter(l=>{
    if(_tsFilter.status){
      if(_tsFilter.status==='__overdue'){ if(tsFollowUpState(l)!=='overdue'&&tsFollowUpState(l)!=='today') return false; }
      else if(tsStatusOf(l).key!==_tsFilter.status) return false;
    }
    if(_tsFilter.owner==='__none'){ if(String(l.Owner||'').trim()) return false; }
    else if(_tsFilter.owner && !sameEmail(l.Owner,_tsFilter.owner)) return false;
    if(_tsFilter.cat && l.ServiceCategory!==_tsFilter.cat) return false;
    if(q && ![l.Name,l.Phone,l.Destination,l.LeadRef].some(v=>String(v||'').toLowerCase().includes(q))) return false;
    return true;
  });
}
// Follow-ups that are due come first, then most recently changed / arrived.
function tsSort(list){
  const rank={overdue:0,today:1,later:2,'':3};
  return list.sort((a,b)=>(rank[tsFollowUpState(a)]-rank[tsFollowUpState(b)])
    ||String(b.TravelStatusAt||b.Date||'').localeCompare(String(a.TravelStatusAt||a.Date||'')));
}

function renderTravelStatus(){
  tsInjectStyle(); tsEnsurePage();
  const el=$id('tsBody'); if(!el) return;
  const leads=typeof allLeads!=='undefined'?allLeads:[];
  const counts={}; let due=0;
  leads.forEach(l=>{ const k=tsStatusOf(l).key; counts[k]=(counts[k]||0)+1; const f=tsFollowUpState(l); if(f==='overdue'||f==='today') due++; });
  const list=tsSort(tsFiltered());
  const all=seesAllLeads();
  const tile=(key,label,icon,grp,n)=>`<button class="ts-tile ${grp}${_tsFilter.status===key?' on':''}" onclick="tsSetFilter('status','${key}')"><div class="n">${n}</div><div class="l">${icon} ${esc(label)}</div></button>`;
  const opt=(cur,s)=>`<option value="${s[0]}"${cur===s[0]?' selected':''}>${s[2]} ${esc(s[1])}</option>`;
  el.innerHTML=`
    <div class="card-title" style="font-size:16px;margin-bottom:12px">📌 Inquiry Status Board</div>
    <div class="ts-tiles">
      ${tile('','All inquiries','📋','blue',leads.length)}
      ${tile('__overdue','Follow-ups due','🔔',due?'amber':'gray',due)}
      ${TS_STATUSES.map(([k,l,i,g])=>tile(k,l,i,g,counts[k]||0)).join('')}
    </div>
    <div class="ts-bar">
      <input class="form-input" id="tsSearch" placeholder="Search name, phone, destination…" value="${esc(_tsFilter.q)}" oninput="tsSetFilter('q',this.value)">
      ${all?`<select class="form-input" onchange="tsSetFilter('owner',this.value)">
        <option value="">All staff</option>
        ${getTeamMembers().map(m=>`<option value="${esc(m.email)}"${sameEmail(_tsFilter.owner,m.email)?' selected':''}>${esc(m.name||m.email)}</option>`).join('')}
        <option value="__none"${_tsFilter.owner==='__none'?' selected':''}>Unassigned</option>
      </select>`:''}
      <select class="form-input" onchange="tsSetFilter('cat',this.value)">
        <option value="">All services</option>
        ${(typeof LEAD_CATEGORIES!=='undefined'?LEAD_CATEGORIES:[]).map(c=>`<option value="${esc(c)}"${_tsFilter.cat===c?' selected':''}>${serviceCategoryIcon(c)} ${esc(c)}</option>`).join('')}
      </select>
      <span class="ts-meta">${list.length} inquir${list.length===1?'y':'ies'}</span>
    </div>
    <div class="card" style="padding:6px 8px"><div style="overflow-x:auto">
      <table class="ts-tbl">
        <thead><tr><th>Inquiry</th><th>Service</th>${all?'<th>Staff</th>':''}<th>Status</th><th>Follow-up</th><th>Updated</th></tr></thead>
        <tbody>${list.length?list.slice(0,_tsShown).map(l=>{
          const st=tsStatusOf(l); const grp=TS_BY_KEY[st.key][3]; const f=tsFollowUpState(l);
          return `<tr data-lead="${Number(l.Id)}" class="${tsOriginClass(l)}">
            <td><a href="#" onclick="openDetail(${Number(l.Id)});return false"><b>${esc(tsLeadName(l))}</b></a>${tsOriginBadge(l)}
              <div class="ts-meta">${[tsPhone(l),l.Destination,l.TravelDates].filter(Boolean).map(esc).join(' · ')}</div></td>
            <td>${tsInlineCategoryHTML(l)}</td>
            ${all?`<td>${esc(tsOwnerName(l.Owner))}</td>`:''}
            <td><select class="ts-sel ${grp}" aria-label="Status" onchange="tsSetStatus(${Number(l.Id)},this.value)">${TS_STATUSES.map(s=>opt(st.key,s)).join('')}</select>${st.auto?'<span class="ts-auto">auto</span>':''}</td>
            <td>${st.key==='follow_up_pending'?`<input type="date" class="ts-date" aria-label="Follow-up date" value="${esc(String(l.TravelFollowUpAt||'').slice(0,10))}" onchange="tsSetFollowUp(${Number(l.Id)},this.value)">${f==='overdue'?'<span class="ts-due overdue">Overdue</span>':f==='today'?'<span class="ts-due today">Today</span>':''}`:'<span class="ts-meta">—</span>'}</td>
            <td class="ts-meta">${l.TravelStatusAt?`${esc(tsAgo(l.TravelStatusAt))}${l.TravelStatusBy?' · '+esc(tsOwnerName(l.TravelStatusBy)):''}`:'—'}</td>
          </tr>`;}).join(''):`<tr><td colspan="${all?6:5}" class="ts-empty">No inquiries match these filters.</td></tr>`}</tbody>
      </table></div>
      ${list.length>_tsShown?`<div style="text-align:center;padding:10px"><button class="btn-ghost" onclick="tsMore()">Show more (${list.length-_tsShown} left)</button></div>`:''}
    </div>`;
}

function tsSetFilter(k,v){
  _tsFilter[k]=v; _tsShown=TS_PAGE_SIZE;
  if(k==='q'){
    // Keep typing focus: re-render, then put the caret back in the search box.
    renderTravelStatus();
    const s=$id('tsSearch'); if(s){ s.focus(); s.setSelectionRange(s.value.length,s.value.length); }
    return;
  }
  renderTravelStatus();
}
function tsMore(){ _tsShown+=TS_PAGE_SIZE; renderTravelStatus(); }

async function tsEnsureFields(){
  if(_tsFieldsReady) return;
  for(const f of TS_FIELDS) await (Array.isArray(f)?ensureLeadsField(f[0],f[1]):ensureLeadsField(f));
  _tsFieldsReady=true;
}
function tsParseLog(raw){
  try{ const v=typeof raw==='string'?JSON.parse(raw||'[]'):raw; return Array.isArray(v)?v:[]; }catch(e){ return []; }
}
async function tsSave(id,patch){
  const lead=(typeof allLeads!=='undefined'?allLeads:[]).find(l=>l.Id===id);
  if(!lead) return;
  const now=new Date().toISOString();
  const full={...patch, TravelStatusAt:now, TravelStatusBy:myEmail||''};
  const statusChanged=!!patch.TravelStatus && patch.TravelStatus!==lead.TravelStatus;
  const stage=statusChanged?tsStageFor(patch.TravelStatus, lead):null;
  if(stage) full.Stage=stage;
  const before={}; Object.keys(full).concat('TravelStatusLog').forEach(k=>{ before[k]=lead[k]; });
  const from=tsStatusOf(lead).key;
  Object.assign(lead,full);
  tsRefreshViews();
  try{
    await tsEnsureFields();
    if(statusChanged){
      // Append to the history; start from the stored copy so a teammate's change made since this
      // page loaded isn't lost (same approach as appendCallLog).
      let log=tsParseLog(before.TravelStatusLog);
      try{
        const fresh=await ncGet(`${CONFIG.NOCODB_BASE}/api/v2/tables/${CONFIG.LEADS_TABLE_ID}/records/${id}?fields=TravelStatusLog`);
        log=tsParseLog(fresh?.TravelStatusLog);
      }catch(e){}
      const entry={at:now, by:myEmail||'', from, to:patch.TravelStatus};
      if(full.TravelFollowUpAt) entry.fu=full.TravelFollowUpAt;
      full.TravelStatusLog=JSON.stringify([entry,...log].slice(0,TS_LOG_MAX));
      lead.TravelStatusLog=full.TravelStatusLog;
    }
    await ncPatch(`${CONFIG.NOCODB_BASE}/api/v2/tables/${CONFIG.LEADS_TABLE_ID}/records`,{Id:id,...full});
    if(stage && typeof reportLeadQualityChange==='function') reportLeadQualityChange(id, {Stage:before.Stage, DealValue:lead.DealValue, DealCurrency:lead.DealCurrency}, {Stage:stage, DealValue:lead.DealValue, DealCurrency:lead.DealCurrency});
    if(stage && !$id('pageLeads')?.classList.contains('hidden') && typeof renderLeadsCurrentView==='function') renderLeadsCurrentView();
    if(typeof showToast==='function') showToast(stage?`Status saved — lead moved to ${typeof stageLabel==='function'?stageLabel(stage):stage}`:'Status saved');
  }catch(e){
    Object.assign(lead,before);
    tsRefreshViews(true);
    if(typeof showToast==='function') showToast('Could not save status — '+e.message,'err');
  }
}
// Re-render whichever views show travel status. The Inquiries list only needs a redraw when a save
// failed (to put the old value back) — the dropdown the user just changed already shows the new one.
function tsRefreshViews(failed){
  if(!$id('pageTvstatus')?.classList.contains('hidden')) renderTravelStatus();
  if(failed && !$id('pageLeads')?.classList.contains('hidden') && typeof renderLeadsCurrentView==='function') renderLeadsCurrentView();
}
function tsSetStatus(id,key){
  if(!TS_BY_KEY[key]) return;
  const patch={TravelStatus:key};
  // A new follow-up defaults to tomorrow so it lands in "Follow-ups due" instead of nowhere.
  if(key==='follow_up_pending'){
    const lead=allLeads.find(l=>l.Id===id);
    if(!lead?.TravelFollowUpAt||String(lead.TravelFollowUpAt).slice(0,10)<TODAY){
      const d=new Date(); d.setDate(d.getDate()+1); patch.TravelFollowUpAt=d.toISOString().slice(0,10);
    }
  }
  return tsSave(id,patch);
}
function tsSetFollowUp(id,date){ return tsSave(id,{TravelFollowUpAt:date||''}); }

// Today page summary: how many inquiries sit in each open status, and follow-ups due.
function tsSummaryHtml(){
  const leads=typeof allLeads!=='undefined'?allLeads:[];
  if(!leads.length) return '';
  const counts={}; let due=0;
  leads.forEach(l=>{ const k=tsStatusOf(l).key; counts[k]=(counts[k]||0)+1; const f=tsFollowUpState(l); if(f==='overdue'||f==='today') due++; });
  const chips=TS_STATUSES.filter(([k])=>counts[k]).map(([k,l,i])=>`<span class="tv-chip" onclick="tsOpen('${k}')">${i} ${esc(l)}<b>${counts[k]}</b></span>`).join('');
  return `<div class="card" style="margin-bottom:14px"><div class="card-title">📌 Inquiry status
      <button class="btn-ghost" onclick="tsOpen('')" style="font-size:12px;font-weight:500;margin-left:auto">Status board →</button></div>
    ${due?`<div class="tv-banner" style="margin-bottom:10px;cursor:pointer" onclick="tsOpen('__overdue')">🔔 <b>${due}</b> follow-up${due===1?'':'s'} due today or overdue</div>`:''}
    <div class="tv-chips">${chips}</div></div>`;
}
function tsOpen(status){
  _tsFilter={status:status||'',owner:'',cat:'',q:''}; _tsShown=TS_PAGE_SIZE;
  navigate('tvstatus');
}

/* ── Inquiries tab: one compact status dropdown per inquiry (list cards and table) ── */
function tsIsTravel(){ return clientRecord?.industry==='travel'; }
function tsInlineStatusHTML(l){
  if(!tsIsTravel()||!l) return '';
  tsInjectStyle();
  const st=tsStatusOf(l); const grp=TS_BY_KEY[st.key][3]; const f=tsFollowUpState(l);
  return `<div class="ts-inline" onclick="event.stopPropagation()">
    <select class="ts-sel ts-sel-inline ${grp}" data-lead="${Number(l.Id)}" aria-label="Travel status" onchange="tsInlineChange(${Number(l.Id)},this)">
      ${TS_STATUSES.map(s=>`<option value="${s[0]}"${st.key===s[0]?' selected':''}>${s[2]} ${esc(s[1])}</option>`).join('')}
    </select>${l.TravelStatus==='follow_up_pending'&&l.TravelFollowUpAt?`<span class="ts-due ${f==='overdue'?'overdue':f==='today'?'today':''}">⏰ ${esc(String(l.TravelFollowUpAt).slice(0,10))}</span>`:''}
  </div>`;
}
function tsInlineChange(id,sel){
  const s=TS_BY_KEY[sel.value]; if(!s) return;
  sel.className=`ts-sel ts-sel-inline ${s[3]}`;
  tsSetStatus(id,sel.value);
}

/* ── Service Category picker (Leads table and list, Status Board) ──
   Saves straight to the lead's ServiceCategory — the field the Leads category filter/chips, Home
   "Leads by category", Reports → 🗂️ Service Category, the inbox category chips and the per-user
   category access all read. A category saved before LEAD_CATEGORIES changed stays selectable. */
let _tsCatFieldReady=false;
function tsInlineCategoryHTML(l){
  if(!tsIsTravel()||!l) return '';
  tsInjectStyle();
  const cats=typeof LEAD_CATEGORIES!=='undefined'?LEAD_CATEGORIES:[];
  const cur=String(l.ServiceCategory||'').trim();
  const opts=!cur||cats.includes(cur)?cats:[cur,...cats];
  return `<select class="ts-cat ${cur?'set':''}" data-lead="${Number(l.Id)}" aria-label="Service category" title="Service category" onclick="event.stopPropagation()" onchange="tsSetCategory(${Number(l.Id)},this.value)">
      <option value="">🗂️ No category</option>${opts.map(c=>`<option value="${esc(c)}"${c===cur?' selected':''}>${serviceCategoryIcon(c)} ${esc(c)}</option>`).join('')}
    </select>`;
}
async function tsSetCategory(id,cat){
  const lead=(typeof allLeads!=='undefined'?allLeads:[]).find(l=>l.Id===id);
  if(!lead) return;
  cat=String(cat||'').trim();
  const before=lead.ServiceCategory||'';
  if(before===cat) return;
  lead.ServiceCategory=cat;
  tsRefreshCategoryViews();
  try{
    if(!_tsCatFieldReady){ await ensureLeadsField('ServiceCategory'); _tsCatFieldReady=true; }
    await ncPatch(`${CONFIG.NOCODB_BASE}/api/v2/tables/${CONFIG.LEADS_TABLE_ID}/records`,{Id:id, ServiceCategory:cat});
    if(typeof _cacheLeads==='function') _cacheLeads(allLeads);
    if(typeof showToast==='function') showToast(cat?`Category set to ${cat}`:'Category cleared');
  }catch(e){
    lead.ServiceCategory=before;
    tsRefreshCategoryViews(true);
    if(typeof showToast==='function') showToast('Could not save category — '+e.message,'err');
  }
}
// Category counts (Leads chips, Home report, Status Board) follow the change. The Leads list is
// only redrawn when a category filter is on (the row may no longer belong) or a save failed.
function tsRefreshCategoryViews(failed){
  if(!$id('pageLeads')?.classList.contains('hidden')){
    if(failed||$id('leadCategoryFilter')?.value){ if(typeof renderLeadsCurrentView==='function') renderLeadsCurrentView(); }
    else if(typeof renderLeadsCategoryChips==='function') renderLeadsCategoryChips();
  }
  if(!$id('pageTvstatus')?.classList.contains('hidden')&&(failed||_tsFilter.cat)) renderTravelStatus();
  if(typeof renderHome==='function') try{ renderHome(); }catch(e){}
}

/* ── Reports → 📌 Status Changes: every status change, date and time wise ── */
let _tsRpt={q:'', status:'', group:false, shown:300};
function tsRptRange(){
  const f=typeof _rptFilters!=='undefined'?_rptFilters:{period:'all'};
  const now=new Date(); let from=null, to=null;
  if(f.period==='today'){ from=new Date(now); from.setHours(0,0,0,0); }
  else if(f.period==='week'){ from=new Date(now); from.setDate(now.getDate()-now.getDay()); from.setHours(0,0,0,0); }
  else if(f.period==='month'){ from=new Date(now.getFullYear(),now.getMonth(),1); }
  else if(f.period==='year'){ from=new Date(now.getFullYear(),0,1); }
  else if(f.period==='custom'){ if(f.from) from=new Date(f.from+'T00:00:00'); if(f.to) to=new Date(f.to+'T23:59:59'); }
  return {from, to};
}
// Every change across all inquiries, newest first. Inquiries marked before the history was kept
// contribute their last change (TravelStatusAt/By) so they still show up.
function tsAllChanges(){
  const out=[];
  for(const l of (typeof allLeads!=='undefined'?allLeads:[])){
    const log=tsParseLog(l.TravelStatusLog);
    if(log.length) log.forEach(e=>{ if(e?.at&&TS_BY_KEY[e.to]) out.push({...e, lead:l}); });
    else if(l.TravelStatusAt&&TS_BY_KEY[l.TravelStatus]) out.push({at:l.TravelStatusAt, by:l.TravelStatusBy||'', from:'', to:l.TravelStatus, fu:l.TravelFollowUpAt||'', lead:l, legacy:true});
  }
  return out.sort((a,b)=>String(b.at).localeCompare(String(a.at)));
}
function tsFmtDateTime(iso){
  try{ const d=new Date(iso); return {date:d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}), time:d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}; }
  catch(e){ return {date:String(iso).slice(0,10), time:''}; }
}
function tsStatusChip(key){
  const s=TS_BY_KEY[key]; if(!s) return '<span class="ts-meta">—</span>';
  return `<span class="ts-chip ${s[3]}">${s[2]} ${esc(s[1])}</span>`;
}
function renderReportsTravelStatus(){
  tsInjectStyle();
  const el=$id('reportsContent'); if(!el) return;
  const {from,to}=tsRptRange();
  const member=$id('rptMember')?.value||'';
  const q=_tsRpt.q.trim().toLowerCase();
  const all=tsAllChanges().filter(c=>{
    const t=new Date(c.at);
    if(from&&t<from) return false;
    if(to&&t>to) return false;
    if(member&&!sameEmail(c.by,member)) return false;
    if(_tsRpt.status&&c.to!==_tsRpt.status) return false;
    if(q&&![c.lead.Name,c.lead.Phone,c.lead.Destination].some(v=>String(v||'').toLowerCase().includes(q))) return false;
    return true;
  });
  const leadsTouched=new Set(all.map(c=>c.lead.Id)).size;
  const count=k=>all.filter(c=>c.to===k).length;
  const row=c=>{ const dt=tsFmtDateTime(c.at); return `<tr>
      <td style="white-space:nowrap">${esc(dt.date)}</td><td style="white-space:nowrap">${esc(dt.time)}</td>
      <td><a href="#" onclick="openDetail(${Number(c.lead.Id)});return false"><b>${esc(tsLeadName(c.lead))}</b></a>${tsOriginBadge(c.lead)}<div class="ts-meta">${esc(tsPhone(c.lead))}</div></td>
      <td>${c.from?tsStatusChip(c.from):'<span class="ts-meta">—</span>'}</td>
      <td>${tsStatusChip(c.to)}${c.legacy?' <span class="ts-auto" title="Changed before status history was kept">last change</span>':''}</td>
      <td>${c.fu?esc(String(c.fu).slice(0,10)):'<span class="ts-meta">—</span>'}</td>
      <td>${esc(tsOwnerName(c.by))}</td></tr>`; };
  const head='<thead><tr><th>Date</th><th>Time</th><th>Inquiry</th><th>From</th><th>To</th><th>Follow-up</th><th>Changed by</th></tr></thead>';
  let body;
  if(_tsRpt.group){
    const byLead=new Map();
    all.forEach(c=>{ if(!byLead.has(c.lead.Id)) byLead.set(c.lead.Id,[]); byLead.get(c.lead.Id).push(c); });
    body=[...byLead.values()].slice(0,_tsRpt.shown).map(list=>{
      const l=list[0].lead;
      return `<div class="card" style="margin-bottom:10px;padding:12px 14px">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:6px">
          <span><a href="#" onclick="openDetail(${Number(l.Id)});return false"><b>${esc(tsLeadName(l))}</b></a>${tsOriginBadge(l)}</span>
          <span>Now: ${tsStatusChip(tsStatusOf(l).key)}</span></div>
        <div style="overflow-x:auto"><table class="leads-tbl ts-rpt-tbl">${head}<tbody>${list.map(row).join('')}</tbody></table></div></div>`;
    }).join('');
  } else {
    body=`<div class="card" style="padding:6px 8px"><div style="overflow-x:auto"><table class="leads-tbl ts-rpt-tbl">${head}<tbody>${all.slice(0,_tsRpt.shown).map(row).join('')}</tbody></table></div></div>`;
  }
  const more=(_tsRpt.group?leadsTouched:all.length)>_tsRpt.shown;
  el.innerHTML=`
    <div style="margin-bottom:12px"><div class="card-title" style="margin-bottom:0">📌 Status Changes</div>
      <div class="s-note">Every travel status change on an inquiry, by date and time. The period and member filters above apply (member = who changed it).</div></div>
    <div style="display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:14px">
      <div class="stat accent"><div class="stat-lbl">Status changes</div><div class="stat-val">${all.length}</div></div>
      <div class="stat"><div class="stat-lbl">Inquiries updated</div><div class="stat-val">${leadsTouched}</div></div>
      <div class="stat"><div class="stat-lbl">🎉 Booking closed</div><div class="stat-val">${count('booking_closed')}</div></div>
      <div class="stat"><div class="stat-lbl">❌ Booking not done</div><div class="stat-val">${count('booking_not_done')}</div></div>
      <div class="stat"><div class="stat-lbl">⏰ Follow ups set</div><div class="stat-val">${count('follow_up_pending')}</div></div>
    </div>
    <div class="ts-bar">
      <input class="form-input" id="tsRptSearch" placeholder="Search inquiry name or phone…" value="${esc(_tsRpt.q)}" oninput="tsRptSet('q',this.value)">
      <select class="form-input" onchange="tsRptSet('status',this.value)"><option value="">Any new status</option>
        ${TS_STATUSES.map(s=>`<option value="${s[0]}"${_tsRpt.status===s[0]?' selected':''}>${s[2]} ${esc(s[1])}</option>`).join('')}</select>
      <label class="ts-meta" style="display:flex;align-items:center;gap:6px;font-size:12.5px"><input type="checkbox" ${_tsRpt.group?'checked':''} onchange="tsRptSet('group',this.checked)"> Group by inquiry</label>
    </div>
    ${all.length?body:'<div class="card"><div class="ts-empty">No status changes in this period.</div></div>'}
    ${more?`<div style="text-align:center;padding:10px"><button class="btn-ghost" onclick="tsRptSet('shown',${_tsRpt.shown+300})">Show more</button></div>`:''}`;
  if(document.activeElement?.id!=='tsRptSearch' && _tsRpt._focus){ const s=$id('tsRptSearch'); if(s){ s.focus(); s.setSelectionRange(s.value.length,s.value.length); } }
  _tsRpt._focus=false;
}
function tsRptSet(k,v){
  _tsRpt[k]=v; if(k!=='shown') _tsRpt.shown=300;
  if(k==='q') _tsRpt._focus=true;
  renderReportsTravelStatus();
}
