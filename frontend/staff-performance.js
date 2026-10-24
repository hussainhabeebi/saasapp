/* ── STAFF PERFORMANCE (Home page + travel workspace's Today page) ──────────────────────────────
   Per-staff lead handling over a period, computed from data already on each lead — no Worker call:
     Assigned      leads that arrived in the period and are owned by that staff member (Owner)
     Called        of those, leads with at least one call in CallLog
     Not attended  of those, leads still open (not won/lost) with no call logged
     Converted     of those, leads won (isWonLead)
     Not responding of those, open leads whose latest call was No Answer / Voicemail, or tagged
                   "No Answer"
     Score (0–100) 60% attended rate (Called ÷ Assigned) + 40% conversion rate measured against the
                   team's best conversion rate in the same period.
   The owner and full-access roles (seesAllLeads) see every team member plus an "Unassigned" row;
   everyone else sees only their own row.
   Uses dashboard.html's globals: $id, esc, allLeads, getTeamMembers, sameEmail, myEmail,
   seesAllLeads, isWonLead, isLostLead, parseCallLog, clientId, navigate.
   Bump the ?v= on its <script> tag in dashboard.html when changing this file — sw.js serves
   scripts cache-first. ── */

const SP_PERIODS=[['today','Today'],['7','7 days'],['30','30 days'],['all','All time']];
const SP_NO_RESPONSE=new Set(['No Answer','Voicemail']);
const SP_PERIOD_KEY=()=>'lv_sp_period_'+clientId;

function spPeriod(){
  try{ const v=localStorage.getItem(SP_PERIOD_KEY()); if(SP_PERIODS.some(([k])=>k===v)) return v; }catch(e){}
  return '30';
}
function spSetPeriod(v){
  try{ localStorage.setItem(SP_PERIOD_KEY(),v); }catch(e){}
  renderStaffPerformanceAll();
}
function spSince(period){
  if(period==='all') return null;
  const d=new Date(); d.setHours(0,0,0,0);
  if(period!=='today') d.setDate(d.getDate()-(Number(period)-1));
  return d.getTime();
}

function spLeadStats(leads){
  let called=0, notAttended=0, converted=0, notResponding=0;
  for(const l of leads){
    let calls=[]; try{ calls=parseCallLog(l.CallLog); }catch(e){}
    const won=isWonLead(l), closed=won||isLostLead(l);
    if(calls.length) called++;
    else if(!closed) notAttended++;
    if(won) converted++;
    // CallLog is newest-first (appendCallLog unshifts).
    const tags=String(l.Tags||'').split(',').map(t=>t.trim().toLowerCase());
    if(!closed && (SP_NO_RESPONSE.has(calls[0]?.outcome) || tags.includes('no answer'))) notResponding++;
  }
  return {assigned:leads.length, called, notAttended, converted, notResponding};
}

function spRows(period){
  const since=spSince(period);
  const leads=(typeof allLeads!=='undefined'?allLeads:[]).filter(l=>{
    if(since===null) return true;
    const t=new Date(l.Date||l.CreatedAt||0).getTime();
    return t>=since;
  });
  const all=seesAllLeads();
  const members=getTeamMembers().filter(m=>all||sameEmail(m.email,myEmail));
  const rows=members.map(m=>({name:m.name||m.email, email:m.email, ...spLeadStats(leads.filter(l=>sameEmail(l.Owner,m.email)))}));
  if(all){
    const known=new Set(members.map(m=>String(m.email).trim().toLowerCase()));
    // Leads owned by someone no longer on the team still count — grouped by their Owner value.
    const others={};
    leads.forEach(l=>{
      const o=String(l.Owner||'').trim();
      if(o && !known.has(o.toLowerCase())) (others[o]=others[o]||[]).push(l);
    });
    Object.entries(others).forEach(([o,ls])=>rows.push({name:o, email:o, former:true, ...spLeadStats(ls)}));
    const unassigned=leads.filter(l=>!String(l.Owner||'').trim());
    if(unassigned.length) rows.push({name:'Unassigned', email:'', unassigned:true, ...spLeadStats(unassigned)});
  }
  const rate=r=>r.assigned?r.converted/r.assigned:0;
  const bestConv=Math.max(0,...rows.filter(r=>!r.unassigned).map(rate));
  rows.forEach(r=>{
    r.score=(r.unassigned||!r.assigned)?null
      :Math.round(60*(r.called/r.assigned)+40*(bestConv?rate(r)/bestConv:0));
  });
  rows.sort((a,b)=>(a.unassigned-b.unassigned)||((b.score??-1)-(a.score??-1))||(b.assigned-a.assigned));
  return {rows, total:leads.length, all};
}

function spScoreBadge(s){
  if(s==null) return '<span class="sp-score sp-na">—</span>';
  const cls=s>=75?'sp-good':s>=50?'sp-mid':'sp-low';
  return `<span class="sp-score ${cls}">${s}</span>`;
}
function spPct(n,d){ return d?Math.round(n/d*100)+'%':''; }

function spInjectStyle(){
  if($id('spStyle')) return;
  const st=document.createElement('style'); st.id='spStyle';
  st.textContent=`
.sp-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.sp-periods{display:flex;gap:4px;flex-wrap:wrap}
.sp-periods button{font-family:var(--disp);font-size:11.5px;font-weight:600;padding:5px 10px;border-radius:20px;border:1px solid var(--line);background:var(--card);color:var(--muted);cursor:pointer}
.sp-periods button.on{background:var(--accent-soft);border-color:var(--accent);color:var(--accent-ink)}
.sp-tbl{width:100%;border-collapse:collapse;font-size:13px;min-width:640px}
.sp-tbl th{text-align:right;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
.sp-tbl th:first-child,.sp-tbl td:first-child{text-align:left}
.sp-tbl td{text-align:right;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:middle;white-space:nowrap}
.sp-tbl tr:last-child td{border-bottom:none}
.sp-tbl tfoot td{font-weight:700;border-top:2px solid var(--line)}
.sp-tbl .sp-sub{display:block;font-size:10.5px;color:var(--muted);font-weight:500}
.sp-tbl .sp-warn{color:#B45309;font-weight:700}
.sp-tbl .sp-ok{color:#047857;font-weight:700}
.sp-score{display:inline-block;min-width:34px;text-align:center;border-radius:8px;padding:3px 7px;font-family:var(--mono);font-weight:700;font-size:12px}
.sp-good{background:#DCFCE7;color:#166534}.sp-mid{background:#FEF3C7;color:#92400E}.sp-low{background:#FEE2E2;color:#991B1B}.sp-na{background:var(--line);color:var(--muted)}
.sp-note{font-size:11.5px;color:var(--muted);margin-top:10px}
.sp-name small{display:block;font-size:10.5px;color:var(--muted)}
`;
  document.head.appendChild(st);
}

// Renders the report into a container. Re-rendered by renderStaffPerformanceAll() on every leads
// refresh (renderHome) and when the period changes.
function renderStaffPerformance(el){
  if(!el) return;
  spInjectStyle();
  const period=spPeriod();
  const {rows,total,all}=spRows(period);
  const periodLbl=(SP_PERIODS.find(([k])=>k===period)||[])[1]||'';
  const sum=k=>rows.reduce((s,r)=>s+r[k],0);
  const tot={assigned:sum('assigned'),called:sum('called'),notAttended:sum('notAttended'),converted:sum('converted'),notResponding:sum('notResponding')};
  const cell=(n,d,cls)=>`<td><span class="${n&&cls?cls:''}">${n}</span>${d?`<span class="sp-sub">${spPct(n,d)}</span>`:''}</td>`;
  const body=rows.length?rows.map(r=>`<tr>
      <td class="sp-name"><b>${r.unassigned?'📭 ':''}${esc(r.name)}</b>${r.former?'<small>not on the team any more</small>':(!r.unassigned&&r.email&&r.email!==r.name?`<small>${esc(r.email)}</small>`:'')}</td>
      <td>${spScoreBadge(r.score)}</td>
      <td><b>${r.assigned}</b></td>
      ${cell(r.called,r.assigned,'sp-ok')}
      ${cell(r.notAttended,r.assigned,'sp-warn')}
      ${cell(r.converted,r.assigned,'sp-ok')}
      ${cell(r.notResponding,r.assigned,'sp-warn')}
    </tr>`).join(''):'<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:18px">No team members yet — add one in Settings → User Management.</td></tr>';
  el.innerHTML=`
    <div class="section-title sp-head">
      <span>👥 ${all?'Staff Performance':'My Performance'}</span>
      <span class="sp-periods">${SP_PERIODS.map(([k,l])=>`<button class="${k===period?'on':''}" onclick="spSetPeriod('${k}')">${l}</button>`).join('')}</span>
    </div>
    <div style="overflow-x:auto">
      <table class="sp-tbl">
        <thead><tr><th>Staff</th><th title="60% attended rate + 40% conversion vs the team's best">Score</th><th>Assigned / arrived</th><th>Called</th><th>Not attended</th><th>Converted</th><th>Not responding</th></tr></thead>
        <tbody>${body}</tbody>
        ${all&&rows.length>1?`<tfoot><tr><td>Total</td><td></td><td>${tot.assigned}</td>${cell(tot.called,tot.assigned)}${cell(tot.notAttended,tot.assigned)}${cell(tot.converted,tot.assigned)}${cell(tot.notResponding,tot.assigned)}</tr></tfoot>`:''}
      </table>
    </div>
    <div class="sp-note">${esc(periodLbl)} · ${total} lead${total===1?'':'s'} arrived. <b>Called</b> = at least one call logged · <b>Not attended</b> = open, no call yet · <b>Not responding</b> = open, last call was No Answer/Voicemail or tagged "No Answer" · <b>Score</b> = 60% attended rate + 40% conversion vs the team's best.</div>`;
}

function renderStaffPerformanceAll(){
  try{ renderStaffPerformance($id('homeStaffPerf')); }catch(e){}
  try{ renderStaffPerformance($id('tvStaffPerf')); }catch(e){}
}
