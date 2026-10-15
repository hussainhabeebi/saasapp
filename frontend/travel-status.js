/* ── TRAVEL STATUS BOARD (travel workspace → 📌 Status Board) ─────────────────────────────────────
   Staff mark where each inquiry stands — First call done, Follow up pending (with a due date),
   Booking closed, Booking not done… The board shows a count per status, filters, and a row per
   inquiry with an inline status picker.
   Stored on the lead (NocoDB Leads, created on first use like every other optional lead column):
     TravelStatus        status key (TS_STATUSES below)
     TravelFollowUpAt    YYYY-MM-DD, for follow_up_pending
     TravelStatusAt/By   when / who last changed it
   An inquiry with no status yet shows "New inquiry", or "First call done (auto)" once a call is in
   its CallLog — so the board is useful before anyone has marked anything.
   This status is the travel desk's own tracking; it doesn't move the lead's pipeline Stage.
   Uses dashboard.html's globals: $id, esc, allLeads, ncPatch, CONFIG, ensureLeadsField, myEmail,
   getTeamMembers, sameEmail, seesAllLeads, parseCallLog, openDetail, showToast, TODAY,
   LEAD_CATEGORIES, serviceCategoryIcon, clientId.
   Bump the ?v= on its <script> tag in dashboard.html when changing this file — sw.js serves
   scripts cache-first. ── */

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
const TS_FIELDS=['TravelStatus','TravelFollowUpAt','TravelStatusAt','TravelStatusBy'];
const TS_PAGE_SIZE=100;

let _tsFilter={status:'',owner:'',cat:'',q:''};
let _tsShown=TS_PAGE_SIZE;
let _tsFieldsReady=false;

// The status an inquiry is shown with: what staff set, else derived from its calls.
function tsStatusOf(l){
  if(TS_BY_KEY[l.TravelStatus]) return {key:l.TravelStatus, auto:false};
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
          return `<tr data-lead="${Number(l.Id)}">
            <td><a href="#" onclick="openDetail(${Number(l.Id)});return false"><b>${esc(l.Name||l.Phone||'Inquiry')}</b></a>
              <div class="ts-meta">${[l.Phone,l.Destination,l.TravelDates].filter(Boolean).map(esc).join(' · ')}</div></td>
            <td>${l.ServiceCategory?`${serviceCategoryIcon(l.ServiceCategory)} ${esc(l.ServiceCategory)}`:'<span class="ts-meta">—</span>'}</td>
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
  for(const f of TS_FIELDS) await ensureLeadsField(f);
  _tsFieldsReady=true;
}
async function tsSave(id,patch){
  const lead=(typeof allLeads!=='undefined'?allLeads:[]).find(l=>l.Id===id);
  if(!lead) return;
  const before={}; Object.keys(patch).forEach(k=>{ before[k]=lead[k]; });
  const full={...patch, TravelStatusAt:new Date().toISOString(), TravelStatusBy:myEmail||''};
  Object.assign(lead,full);
  renderTravelStatus();
  try{
    await tsEnsureFields();
    await ncPatch(`${CONFIG.NOCODB_BASE}/api/v2/tables/${CONFIG.LEADS_TABLE_ID}/records`,{Id:id,...full});
    if(typeof showToast==='function') showToast('Status saved');
  }catch(e){
    Object.assign(lead,before);
    renderTravelStatus();
    if(typeof showToast==='function') showToast('Could not save status — '+e.message,'err');
  }
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
