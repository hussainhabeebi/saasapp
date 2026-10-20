/* Accounting ledger UI — the 🏠 Overview / 📒 Books / 🔁 Subscriptions / 🧾 Tax / ⚙️ Operations tabs of
   accounting.html, talking to the Worker's /accounting/ledger/* routes (cloudflare-worker/
   accounting-ledger.js). Loaded after accounting.html's inline script and reuses its globals
   (acctFetch, esc, escAttr, clientId, WORKER_BASE, Chart, jspdf). Each tab renders lazily the
   first time it's opened. Reports → P&L / Trial Balance / Cash Flow are re-pointed at the ledger
   at the bottom of this file so there's only one set of numbers in the app. */
(function(){
'use strict';
const L={meta:null, loaded:{}, charts:{}};
window.AccLedger=L;

/* ── helpers ── */
const api=(path, opts)=>acctFetch(`/accounting/ledger/${path}`, opts||{method:'GET'});
const post=(path, body)=>api(path, {method:'POST', body:JSON.stringify(body||{})});
const qs=o=>new URLSearchParams(Object.entries(o).filter(([,v])=>v!=null&&v!=='')).toString();
const today=()=>new Date().toISOString().slice(0,10);
const monthStart=()=>today().slice(0,8)+'01';
const addDays=(d,n)=>{ const t=new Date(d+'T00:00:00Z'); t.setUTCDate(t.getUTCDate()+n); return t.toISOString().slice(0,10); };
const fyStart=()=>{ const m=(L.meta?.settings?.fy_start_month)||4; const d=new Date(); const y=d.getMonth()+1>=m?d.getFullYear():d.getFullYear()-1; return `${y}-${String(m).padStart(2,'0')}-01`; };
const cur=()=>L.meta?.settings?.base_currency||'INR';
function money(n, c){ const v=Number(n||0); const s=Math.abs(v).toLocaleString('en-IN',{minimumFractionDigits:2, maximumFractionDigits:2}); return `${v<0?'−':''}${c===''?'':(c||cur())+' '}${s}`; }
const m0=n=>money(n,'');
const pct=n=>n==null?'—':`${Number(n).toFixed(1)}%`;
const numCell=(n, cls='')=>`<td class="num ${cls} ${Number(n)<0?'neg':''}">${n==null||n===''?'—':m0(n)}</td>`;
const empty=(msg, cols)=>cols?`<tr><td colspan="${cols}" class="empty-state">${esc(msg)}</td></tr>`:`<div class="empty-state">${esc(msg)}</div>`;
const spinner='<div class="empty-state"><span class="spinner"></span> Loading…</div>';
const errBox=e=>`<div class="empty-state">⚠️ ${esc(e.message||e)}</div>`;
const can=role=>({viewer:1, ca:1, approver:2, accountant:3, admin:4}[L.meta?.role||'admin']||0)>=({viewer:1, approver:2, accountant:3, admin:4}[role]);
function toast(msg, bad){
  let t=document.getElementById('accToast');
  if(!t){ t=document.createElement('div'); t.id='accToast'; document.body.appendChild(t); }
  t.textContent=msg; t.className='acc-toast show'+(bad?' bad':'');
  clearTimeout(t._h); t._h=setTimeout(()=>t.className='acc-toast', 3200);
}
async function act(fn, okMsg){ try{ const r=await fn(); if(okMsg) toast(okMsg); return r; }catch(e){ toast(e.message, true); throw e; } }
function download(name, text, type='text/plain'){ const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([text], {type})); a.download=name; document.body.appendChild(a); a.click(); setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 500); }
function toCsv(rows){ return rows.map(r=>r.map(v=>{ const s=String(v==null?'':v); return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s; }).join(',')).join('\n'); }
function exportXlsx(name, sheets){
  if(!window.XLSX){ const first=Object.entries(sheets)[0]; download(name.replace(/\.xlsx$/,'.csv'), toCsv(first[1]), 'text/csv'); return; }
  const wb=XLSX.utils.book_new();
  for(const [n, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), n.slice(0,31));
  XLSX.writeFile(wb, name);
}
function accountOptions(selected, filter){
  const groups={asset:'Assets', liability:'Liabilities', equity:'Equity', income:'Income', expense:'Expenses'};
  const list=(L.meta?.accounts||[]).filter(a=>!filter||filter(a));
  return '<option value="">— Select account —</option>'+Object.entries(groups).map(([t,label])=>{
    const xs=list.filter(a=>a.type===t); if(!xs.length) return '';
    return `<optgroup label="${label}">${xs.map(a=>`<option value="${a.id}" ${String(selected)===String(a.id)?'selected':''}>${esc(a.code)} · ${esc(a.name)}</option>`).join('')}</optgroup>`;
  }).join('');
}
const cashAccounts=a=>a.type==='asset'&&(a.subtype==='bank'||a.subtype==='cash');
const accName=id=>{ const a=(L.meta?.accounts||[]).find(a=>String(a.id)===String(id)); return a?`${a.code} · ${a.name}`:'—'; };
function subnav(root, key, items, onShow){
  root.innerHTML=`<div class="fp-subnav">${items.map(([k,label],i)=>`<button class="fp-pill ${i?'':'active'}" data-k="${k}">${label}</button>`).join('')}</div><div class="acc-sub-body"></div>`;
  const body=root.querySelector('.acc-sub-body');
  const show=k=>{ root.querySelectorAll('.fp-pill').forEach(p=>p.classList.toggle('active', p.dataset.k===k)); body.innerHTML=spinner; onShow(k, body); try{ localStorage.setItem('acc_sub_'+key, k); }catch(_){} };
  root.querySelectorAll('.fp-pill').forEach(p=>p.onclick=()=>show(p.dataset.k));
  let start=items[0][0]; try{ const s=localStorage.getItem('acc_sub_'+key); if(s && items.some(i=>i[0]===s)) start=s; }catch(_){}
  show(start);
  return show;
}
function card(title, actions, inner){ return `<div class="card"><div class="card-title-row"><div class="card-title">${title}</div><div class="card-actions">${actions||''}</div></div>${inner}</div>`; }
const dateRangeInputs=(id, from, to)=>`<input class="s-input" type="date" id="${id}From" value="${from}" style="width:auto"><span class="acc-muted">to</span><input class="s-input" type="date" id="${id}To" value="${to}" style="width:auto">`;
const val=id=>document.getElementById(id)?.value;

/* Generic form modal: fields [{k,label,type:'text'|'number'|'date'|'select'|'textarea'|'checkbox'|'account'|'month', options, value, hint, full, filter}] */
function form({title, fields, submit='Save', onSave, wide, extraHtml}){
  let ov=document.getElementById('accFormModal');
  if(!ov){ ov=document.createElement('div'); ov.id='accFormModal'; ov.className='modal-overlay'; document.body.appendChild(ov); }
  const fieldHtml=f=>{
    const id='accF_'+f.k, v=f.value==null?'':f.value;
    let input;
    if(f.type==='select') input=`<select class="s-input" id="${id}">${(f.options||[]).map(o=>{ const [ov2,lab]=Array.isArray(o)?o:[o,o]; return `<option value="${escAttr(ov2)}" ${String(ov2)===String(v)?'selected':''}>${esc(lab)}</option>`; }).join('')}</select>`;
    else if(f.type==='account') input=`<select class="s-input" id="${id}">${accountOptions(v, f.filter)}</select>`;
    else if(f.type==='textarea') input=`<textarea class="s-input" id="${id}" rows="${f.rows||3}">${esc(v)}</textarea>`;
    else if(f.type==='checkbox') input=`<label class="acc-check"><input type="checkbox" id="${id}" ${v?'checked':''}> ${esc(f.text||'')}</label>`;
    else input=`<input class="s-input" id="${id}" type="${f.type||'text'}" value="${escAttr(v)}" ${f.step?`step="${f.step}"`:''} placeholder="${escAttr(f.placeholder||'')}">`;
    return `<div ${f.full?'style="grid-column:1/-1"':''}><label class="s-lbl">${esc(f.label)}</label>${input}${f.hint?`<div class="s-hint">${esc(f.hint)}</div>`:''}</div>`;
  };
  ov.innerHTML=`<div class="modal-card" style="max-width:${wide?860:620}px"><div class="modal-title">${esc(title)}</div><div class="modal-grid">${fields.map(fieldHtml).join('')}</div>${extraHtml||''}
    <div class="save-msg err" id="accFormErr"></div><div class="modal-actions"><button class="save-btn sec" id="accFormCancel">Cancel</button><button class="save-btn" id="accFormSave">${esc(submit)}</button></div></div>`;
  ov.classList.add('active');
  const close=()=>ov.classList.remove('active');
  ov.querySelector('#accFormCancel').onclick=close;
  ov.onclick=e=>{ if(e.target===ov) close(); };
  ov.querySelector('#accFormSave').onclick=async()=>{
    const data={}; for(const f of fields){ const el=document.getElementById('accF_'+f.k); if(!el) continue; data[f.k]=f.type==='checkbox'?el.checked:(f.type==='number'?(el.value===''?'':Number(el.value)):el.value); }
    const btn=ov.querySelector('#accFormSave'); btn.disabled=true; ov.querySelector('#accFormErr').textContent='';
    try{ await onSave(data, ov); close(); }catch(e){ ov.querySelector('#accFormErr').textContent=e.message; }
    finally{ btn.disabled=false; }
  };
  return ov;
}

async function loadMeta(force){
  if(L.meta && !force) return L.meta;
  L.meta=await api('settings');
  return L.meta;
}

/* Journal line editor shared by manual + recurring journals */
function linesEditor(lines){
  const rows=(lines&&lines.length?lines:[{},{}]).map(l=>lineRow(l)).join('');
  return `<div class="acc-lines"><div class="acc-lines-head"><span>Account</span><span>Debit</span><span>Credit</span><span>Party / note</span><span></span></div><div id="accLinesBody">${rows}</div>
    <div class="acc-lines-foot"><button type="button" class="save-btn sec" onclick="AccLedger.addLine()">+ Line</button><span id="accLinesTotals" class="acc-muted"></span></div></div>`;
}
function lineRow(l={}){ return `<div class="acc-line"><select class="s-input acc-l-acct" onchange="AccLedger.lineTotals()">${accountOptions(l.account_id)}</select><input class="s-input acc-l-dr" type="number" step="0.01" value="${l.debit||''}" oninput="AccLedger.lineTotals()"><input class="s-input acc-l-cr" type="number" step="0.01" value="${l.credit||''}" oninput="AccLedger.lineTotals()"><input class="s-input acc-l-party" value="${escAttr(l.party_name||l.description||'')}" placeholder="optional"><button type="button" class="icon-btn danger" onclick="this.parentElement.remove();AccLedger.lineTotals()">✕</button></div>`; }
L.addLine=()=>{ document.getElementById('accLinesBody').insertAdjacentHTML('beforeend', lineRow()); };
L.lineTotals=()=>{ const ls=readLines(); const d=ls.reduce((s,l)=>s+l.debit,0), c=ls.reduce((s,l)=>s+l.credit,0); const el=document.getElementById('accLinesTotals'); if(el) el.innerHTML=`Debits ${m0(d)} · Credits ${m0(c)} ${Math.abs(d-c)<0.005&&d?'<span class="badge paid">Balanced</span>':'<span class="badge void">Off by '+m0(d-c)+'</span>'}`; };
function readLines(){ return [...document.querySelectorAll('#accLinesBody .acc-line')].map(r=>({account_id:r.querySelector('.acc-l-acct').value, debit:Number(r.querySelector('.acc-l-dr').value)||0, credit:Number(r.querySelector('.acc-l-cr').value)||0, party_name:r.querySelector('.acc-l-party').value.trim()})).filter(l=>l.account_id&&(l.debit||l.credit)); }

/* ══════════ 🏠 OVERVIEW ══════════ */
async function renderOverview(root){
  root.innerHTML=spinner;
  try{
    await loadMeta();
    const d=await api('dashboard');
    const k=(label, value, sub, cls)=>`<div class="stat-card ${cls||''}"><div class="stat-lbl">${label}</div><div class="stat-val">${value}</div>${sub?`<div class="stat-sub">${sub}</div>`:''}</div>`;
    root.innerHTML=`
      ${(d.warnings||[]).length?`<div class="acc-warn">${d.warnings.slice(0,5).map(w=>`⚠️ ${esc(w.message)}`).join('<br>')}</div>`:''}
      <div class="stat-grid">
        ${k('Cash & bank', money(d.cash), (d.cash_accounts||[]).slice(0,3).map(a=>`${esc(a.name)} ${m0(a.balance)}`).join(' · '))}
        ${k('Customers owe you', money(d.receivables), `Overdue ${money(d.overdue_receivables)}`)}
        ${k('You owe suppliers', money(d.payables))}
        ${k('MRR', money(d.mrr), `ARR ${money(d.arr)} · ${d.active_subscriptions} active`)}
        ${k('Monthly burn', d.burn_rate>0?money(d.burn_rate):'Cash-positive', d.runway_months!=null?`Runway ${d.runway_months} months`:'')}
        ${k('Revenue FY to date', money(d.revenue_ytd), `Gross margin ${pct(d.gross_margin_pct_ytd)}`)}
        ${k('Net profit FY to date', money(d.net_profit_ytd), `${d.fy?.from} → today`, d.net_profit_ytd<0?'neg-card':'')}
      </div>
      <div class="acc-two">
        ${card('Revenue vs expenses — last 6 months', '', '<div style="height:240px"><canvas id="accTrendChart"></canvas></div>')}
        ${card('Top overdue customers', '<button class="save-btn sec" onclick="showTab(\'documents\')">Open invoices</button>', d.top_overdue.length?`<table><tbody>${d.top_overdue.map(o=>`<tr><td>${esc(o.customer)}</td>${numCell(o.amount)}</tr>`).join('')}</tbody></table>`:empty('Nothing overdue 🎉'))}
      </div>
      ${card('Things to check', '<button class="save-btn sec" onclick="AccLedger.openOps(\'ai\')">Categorise with AI</button>', d.anomalies.length?`<div class="acc-alerts">${d.anomalies.map(a=>`<div class="acc-alert ${a.severity}"><span class="badge ${a.severity==='high'?'void':a.severity==='medium'?'sent':'draft'}">${a.severity}</span> ${esc(a.message)}</div>`).join('')}</div>`:empty('No issues found.'))}
      ${card('🤖 Ask your books', '', `<div class="acc-ask"><input class="s-input" id="accAskQ" placeholder="e.g. What was my profit last month? Which client is most profitable? How long is my runway?" onkeydown="if(event.key==='Enter')AccLedger.ask()"><button class="save-btn" onclick="AccLedger.ask()">Ask</button></div><div id="accAskA" class="acc-answer"></div>`)}
      <div id="accForecastCard">${card('13-week cash forecast', '', spinner)}</div>
      <div id="accUnitEcoCard">${card('Profitability by client (FY to date)', '', spinner)}</div>`;
    if(window.Chart){
      if(L.charts.trend) L.charts.trend.destroy();
      L.charts.trend=new Chart(document.getElementById('accTrendChart'), {type:'bar', data:{labels:d.trend.map(t=>t.month), datasets:[
        {label:'Revenue', data:d.trend.map(t=>t.revenue), backgroundColor:'#F97316'}, {label:'Expenses', data:d.trend.map(t=>t.expenses), backgroundColor:'#FBCFA0'},
        {label:'Net', data:d.trend.map(t=>t.net), type:'line', borderColor:'#059669', backgroundColor:'#059669', tension:.3}]},
        options:{maintainAspectRatio:false, plugins:{legend:{position:'bottom'}}, scales:{y:{ticks:{callback:v=>Number(v).toLocaleString('en-IN')}}}}});
    }
    api('forecast').then(f=>{
      document.getElementById('accForecastCard').innerHTML=card('13-week cash forecast', `<span class="acc-muted">Lowest point ${money(f.lowest_balance)}</span>`,
        `<div class="tbl-wrap"><table><thead><tr><th>Week</th><th>From</th><th class="num">In</th><th class="num">Out</th><th class="num">Closing cash</th><th>Biggest items</th></tr></thead><tbody>
        ${f.weeks.map(w=>`<tr><td>W${w.week}</td><td>${w.start}</td>${numCell(w.inflow)}${numCell(-w.outflow)}${numCell(w.closing, w.closing<0?'neg':'')}<td class="acc-small">${w.items.slice(0,3).map(i=>`${i.dir==='inflow'?'↘':'↗'} ${esc(i.label)} ${m0(i.amount)}`).join('<br>')}</td></tr>`).join('')}</tbody></table></div>
        <div class="s-hint">Open invoices by due date, upcoming subscription renewals and recurring dues in; unpaid bills, recurring journals, payroll and fixed expenses out.</div>`);
    }).catch(e=>{ document.getElementById('accForecastCard').innerHTML=card('13-week cash forecast','',errBox(e)); });
    api(`unit-economics?${qs({from:fyStart(), to:today()})}`).then(u=>{
      document.getElementById('accUnitEcoCard').innerHTML=card('Profitability by client (FY to date)', '<button class="save-btn sec" onclick="AccLedger.openOps(\'allocations\')">Allocate costs</button>',
        `<div class="tbl-wrap"><table><thead><tr><th>Client</th><th class="num">Net revenue</th><th class="num">Direct costs</th><th class="num">Gateway fees</th><th class="num">Margin</th><th class="num">Margin %</th></tr></thead><tbody>
        ${u.rows.length?u.rows.slice(0,25).map(r=>`<tr><td>${esc(r.customer)}</td>${numCell(r.net_revenue)}${numCell(r.direct_costs)}${numCell(r.gateway_fees)}${numCell(r.margin)}<td class="num">${pct(r.margin_pct)}</td></tr>`).join(''):empty('No revenue yet this year.',6)}</tbody></table></div>`);
    }).catch(e=>{ document.getElementById('accUnitEcoCard').innerHTML=card('Profitability by client','',errBox(e)); });
  }catch(e){ root.innerHTML=errBox(e); }
}
L.ask=async()=>{
  const q=val('accAskQ').trim(); if(!q) return;
  const box=document.getElementById('accAskA'); box.innerHTML='<span class="spinner"></span> Thinking…';
  try{ const r=await post('ai/ask', {question:q}); box.innerHTML=esc(r.answer).replace(/\n/g,'<br>'); }catch(e){ box.innerHTML=`⚠️ ${esc(e.message)}`; }
};

/* ══════════ 📒 BOOKS ══════════ */
async function renderBooks(root){
  await loadMeta();
  subnav(root, 'books', [['pl','📈 Profit & Loss'],['bs','⚖️ Balance Sheet'],['tb','🧮 Trial Balance'],['cf','🌊 Cash Flow'],['gl','📖 General Ledger'],['journals','✍️ Journals'],['coa','🗂️ Chart of Accounts'],['notes','↩️ Credit / Debit Notes'],['parties','👥 Customer & Supplier Ledgers'],['close','🔒 Period Close'],['audit','🕵️ Audit Trail']], (k, body)=>{
    ({pl:booksPL, bs:booksBS, tb:booksTB, cf:booksCF, gl:booksGL, journals:booksJournals, coa:booksCoa, notes:booksNotes, parties:booksParties, close:booksClose, audit:booksAudit})[k](body);
  });
}
L.plData=null;
function plTable(d){
  const cmp=d.compare;
  const head=`<tr><th>Account</th><th class="num">${esc(d.from)} → ${esc(d.to)}</th>${cmp?`<th class="num">${esc(cmp.label)}</th><th class="num">Change</th>`:''}</tr>`;
  const cmpAmt=(sec, id)=>{ const r=cmp?.sections[sec].find(x=>x.account_id===id); return r?r.amount:0; };
  const rows=(sec, title)=>{
    const ids=new Set([...d.sections[sec].map(r=>r.account_id), ...(cmp?cmp.sections[sec].map(r=>r.account_id):[])]);
    const all=[...ids].map(id=>d.sections[sec].find(r=>r.account_id===id)||{...cmp.sections[sec].find(r=>r.account_id===id), amount:0});
    if(!all.length) return '';
    return `<tr class="acc-sec"><td colspan="${cmp?4:2}">${title}</td></tr>`+all.map(r=>`<tr class="acc-click" onclick="AccLedger.drill(${r.account_id})"><td class="acc-indent">${esc(r.code)} · ${esc(r.name)}</td>${numCell(r.amount)}${cmp?numCell(cmpAmt(sec,r.account_id))+numCell(r.amount-cmpAmt(sec,r.account_id)):''}</tr>`).join('');
  };
  const tot=(label, k, strong)=>`<tr class="${strong?'acc-total':'acc-sub'}"><td>${label}</td>${numCell(d[k])}${cmp?numCell(cmp[k])+numCell(d[k]-cmp[k]):''}</tr>`;
  return `<div class="tbl-wrap"><table class="acc-fin">${head}
    ${rows('revenue','Revenue')}${tot('Total revenue','revenue')}
    ${rows('cogs','Cost of revenue')}${tot('Gross profit','gross_profit',true)}
    ${rows('opex','Operating expenses')}${tot('Total operating expenses','opex')}${tot('Operating profit','operating_profit',true)}
    ${rows('other','Other income / (expense)')}${tot('Net profit','net_profit',true)}</table></div>
    <div class="s-hint">Gross margin ${pct(d.gross_margin_pct)}. Click an account to see its entries.</div>`;
}
function booksPL(body){
  body.innerHTML=card('Profit & Loss', `${dateRangeInputs('accPl', fyStart(), today())}<select class="s-input" id="accPlCmp" style="width:auto"><option value="">No comparison</option><option value="prev">vs previous period</option><option value="yoy">vs same period last year</option></select><input class="s-input" id="accPlBranch" placeholder="Branch / cost centre" style="width:150px"><button class="save-btn sec" onclick="AccLedger.runPL()">Run</button><button class="save-btn sec" onclick="AccLedger.exportPL()">⬇ Excel</button>`, '<div id="accPlOut"></div>');
  L.runPL();
}
L.runPL=async()=>{
  const out=document.getElementById('accPlOut'); out.innerHTML=spinner;
  try{ L.plData=await api(`pl?${qs({from:val('accPlFrom'), to:val('accPlTo'), compare:val('accPlCmp'), branch:val('accPlBranch')})}`); out.innerHTML=warnList(L.plData.warnings)+plTable(L.plData); }catch(e){ out.innerHTML=errBox(e); }
};
L.exportPL=()=>{ const d=L.plData; if(!d) return; const rows=[['Section','Code','Account','Amount']];
  for(const [k,t] of [['revenue','Revenue'],['cogs','Cost of revenue'],['opex','Operating expenses'],['other','Other']]) for(const r of d.sections[k]) rows.push([t, r.code, r.name, r.amount]);
  rows.push([],['','','Gross profit',d.gross_profit],['','','Operating profit',d.operating_profit],['','','Net profit',d.net_profit]);
  exportXlsx(`profit-and-loss_${d.from}_${d.to}.xlsx`, {'P&L':rows}); };
const warnList=w=>(w&&w.length)?`<div class="acc-warn">${w.slice(0,6).map(x=>'⚠️ '+esc(x.message)).join('<br>')}</div>`:'';
L.drill=id=>{ L.glAccount=id; const b=document.querySelector('#tabBooks .fp-pill[data-k="gl"]'); if(b) b.click(); };
function bsSection(title, groups, total, cmpGroups){
  const cmpAmt=id=>{ for(const g of (cmpGroups||[])) for(const r of g.rows) if(r.account_id===id && id!=null) return r.amount; return null; };
  return `<tr class="acc-sec"><td colspan="${cmpGroups?3:2}">${title}</td></tr>`+groups.map(g=>`<tr class="acc-sub"><td>${esc(g.group)}</td>${numCell(g.total)}${cmpGroups?'<td></td>':''}</tr>`+g.rows.map(r=>`<tr class="${r.account_id?'acc-click':''}" ${r.account_id?`onclick="AccLedger.drill(${r.account_id})"`:''}><td class="acc-indent">${r.code?esc(r.code)+' · ':''}${esc(r.name)}</td>${numCell(r.amount)}${cmpGroups?numCell(cmpAmt(r.account_id)):''}</tr>`).join('')).join('')+`<tr class="acc-total"><td>Total ${title.toLowerCase()}</td>${numCell(total)}${cmpGroups?'<td></td>':''}</tr>`;
}
function booksBS(body){
  body.innerHTML=card('Balance Sheet', `<label class="acc-muted">As of</label><input class="s-input" type="date" id="accBsAsOf" value="${today()}" style="width:auto"><label class="acc-muted">compare</label><input class="s-input" type="date" id="accBsCmp" style="width:auto"><button class="save-btn sec" onclick="AccLedger.runBS()">Run</button>`, '<div id="accBsOut"></div>');
  L.runBS();
}
L.runBS=async()=>{
  const out=document.getElementById('accBsOut'); out.innerHTML=spinner;
  try{
    const d=await api(`balance-sheet?${qs({as_of:val('accBsAsOf'), compare_as_of:val('accBsCmp')})}`);
    out.innerHTML=warnList(d.warnings)+`<div class="acc-bal ${d.balanced?'ok':'bad'}">${d.balanced?'✓ Assets = Liabilities + Equity':'⚠ Out of balance by '+m0(d.difference)}</div>
      <div class="tbl-wrap"><table class="acc-fin"><tr><th>Account</th><th class="num">${esc(d.as_of)}</th>${d.compare?`<th class="num">${esc(d.compare.as_of)}</th>`:''}</tr>
      ${bsSection('Assets', d.assets, d.total_assets, d.compare?.assets)}${bsSection('Liabilities', d.liabilities, d.total_liabilities, d.compare?.liabilities)}${bsSection('Equity', d.equity, d.total_equity, d.compare?.equity)}
      <tr class="acc-total"><td>Liabilities + equity</td>${numCell(d.total_liabilities+d.total_equity)}${d.compare?'<td></td>':''}</tr></table></div>`;
  }catch(e){ out.innerHTML=errBox(e); }
};
function booksTB(body){
  body.innerHTML=card('Trial Balance', `${dateRangeInputs('accTb', fyStart(), today())}<button class="save-btn sec" onclick="AccLedger.runTB()">Run</button><button class="save-btn sec" onclick="AccLedger.exportTB()">⬇ Excel</button>`, '<div id="accTbOut"></div>');
  L.runTB();
}
L.runTB=async()=>{
  const out=document.getElementById('accTbOut'); out.innerHTML=spinner;
  try{
    const d=L.tbData=await api(`trial-balance?${qs({from:val('accTbFrom'), to:val('accTbTo')})}`);
    out.innerHTML=warnList(d.warnings)+`<div class="acc-bal ${d.balanced?'ok':'bad'}">${d.balanced?'✓ Balanced':'⚠ Out of balance'}</div><div class="tbl-wrap"><table class="acc-fin"><thead><tr><th>Code</th><th>Account</th><th class="num">Opening</th><th class="num">Debit</th><th class="num">Credit</th><th class="num">Closing Dr</th><th class="num">Closing Cr</th></tr></thead><tbody>
      ${d.rows.length?d.rows.map(r=>`<tr class="acc-click" onclick="AccLedger.drill(${r.account_id})"><td>${esc(r.code)}</td><td>${esc(r.name)}</td>${numCell(r.opening)}${numCell(r.debit)}${numCell(r.credit)}${numCell(r.closing_debit||'')}${numCell(r.closing_credit||'')}</tr>`).join(''):empty('No entries yet — create an invoice, expense or bill and it will appear here.',7)}
      <tr class="acc-total"><td colspan="5">Totals</td>${numCell(d.total_debit)}${numCell(d.total_credit)}</tr></tbody></table></div>`;
  }catch(e){ out.innerHTML=errBox(e); }
};
L.exportTB=()=>{ const d=L.tbData; if(!d) return; exportXlsx(`trial-balance_${val('accTbFrom')}_${val('accTbTo')}.xlsx`, {'Trial Balance':[['Code','Account','Type','Opening','Debit','Credit','Closing Dr','Closing Cr'], ...d.rows.map(r=>[r.code,r.name,r.type,r.opening,r.debit,r.credit,r.closing_debit,r.closing_credit]), ['','Total','','','','',d.total_debit,d.total_credit]]}); };
function booksCF(body){
  body.innerHTML=card('Cash Flow (from the ledger)', `${dateRangeInputs('accCf', fyStart(), today())}<button class="save-btn sec" onclick="AccLedger.runCF()">Run</button>`, '<div id="accCfOut"></div>');
  L.runCF();
}
L.runCF=async(target)=>{
  const out=target||document.getElementById('accCfOut'); out.innerHTML=spinner;
  const from=target?val('repCfFrom')||val('repCashFrom')||fyStart():val('accCfFrom'), to=target?val('repCfTo')||val('repCashTo')||today():val('accCfTo');
  try{
    const d=await api(`cash-flow?${qs({from, to})}`);
    out.innerHTML=`<div class="stat-grid" style="margin-bottom:14px"><div class="stat-card"><div class="stat-lbl">Opening cash</div><div class="stat-val">${money(d.opening_cash)}</div></div><div class="stat-card"><div class="stat-lbl">Net change</div><div class="stat-val">${money(d.net_change)}</div></div><div class="stat-card"><div class="stat-lbl">Closing cash</div><div class="stat-val">${money(d.closing_cash)}</div></div></div>
      <div class="tbl-wrap"><table class="acc-fin">${d.sections.map(s=>`<tr class="acc-sec"><td colspan="2">${s.section[0].toUpperCase()+s.section.slice(1)} activities</td></tr>${s.rows.map(r=>`<tr><td class="acc-indent">${esc(r.label)}</td>${numCell(r.amount)}</tr>`).join('')||'<tr><td class="acc-indent acc-muted">None</td><td></td></tr>'}<tr class="acc-sub"><td>Net cash from ${s.section}</td>${numCell(s.total)}</tr>`).join('')}</table></div>
      <div class="card-title" style="margin-top:16px">By month</div><div class="tbl-wrap"><table><thead><tr><th>Month</th><th class="num">In</th><th class="num">Out</th><th class="num">Net</th></tr></thead><tbody>${d.months.map(m=>`<tr><td>${m.month}</td>${numCell(m.inflow)}${numCell(-m.outflow)}${numCell(m.net)}</tr>`).join('')}</tbody></table></div>`;
  }catch(e){ out.innerHTML=errBox(e); }
};
function booksGL(body){
  body.innerHTML=card('General Ledger', `<select class="s-input" id="accGlAcct" style="width:260px">${accountOptions(L.glAccount)}</select>${dateRangeInputs('accGl', fyStart(), today())}<button class="save-btn sec" onclick="AccLedger.runGL()">Run</button><button class="save-btn sec" onclick="AccLedger.exportGL()">⬇ CSV</button>`, '<div id="accGlOut"><div class="empty-state">Pick an account.</div></div>');
  if(L.glAccount) L.runGL();
}
L.runGL=async()=>{
  const id=val('accGlAcct'); if(!id) return; L.glAccount=id;
  const out=document.getElementById('accGlOut'); out.innerHTML=spinner;
  try{
    const d=L.glData=await api(`general-ledger?${qs({account_id:id, from:val('accGlFrom'), to:val('accGlTo')})}`);
    out.innerHTML=`<div class="tbl-wrap"><table><thead><tr><th>Date</th><th>#</th><th>Description</th><th>Party</th><th>Source</th><th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th></tr></thead><tbody>
      <tr class="acc-sub"><td colspan="7">Opening balance</td>${numCell(d.opening)}</tr>
      ${d.rows.map(r=>`<tr><td>${r.date}</td><td>${r.entry_no}</td><td>${esc(r.memo||'')}${r.description?`<div class="acc-small">${esc(r.description)}</div>`:''}</td><td>${esc(r.party||'')}</td><td><span class="badge draft">${esc(r.source)}</span></td>${numCell(r.debit||'')}${numCell(r.credit||'')}${numCell(r.balance)}</tr>`).join('')}
      <tr class="acc-total"><td colspan="5">Closing</td>${numCell(d.total_debit)}${numCell(d.total_credit)}${numCell(d.closing)}</tr></tbody></table></div>`;
  }catch(e){ out.innerHTML=errBox(e); }
};
L.exportGL=()=>{ const d=L.glData; if(!d) return; download(`ledger_${d.account.code}_${d.from}_${d.to}.csv`, toCsv([['Date','Entry','Description','Party','Source','Debit','Credit','Balance'], ...d.rows.map(r=>[r.date,r.entry_no,r.memo,r.party,r.source,r.debit,r.credit,r.balance])]), 'text/csv'); };

function booksJournals(body){
  body.innerHTML=card('Journal entries', `${dateRangeInputs('accJ', fyStart(), today())}<select class="s-input" id="accJType" style="width:auto"><option value="">All sources</option><option value="manual">Manual</option><option value="recurring">Recurring</option><option value="year_close">Year-end close</option><option value="invoice">Invoices</option><option value="receipt">Receipts</option><option value="expense">Expenses</option><option value="vendor_bill">Vendor bills</option><option value="payment">Payment entries</option><option value="credit_note">Credit notes</option><option value="revrec">Revenue recognition</option><option value="depreciation">Depreciation</option><option value="payroll">Payroll</option></select><input class="search-input" id="accJQ" placeholder="🔍 memo or #"><button class="save-btn sec" onclick="AccLedger.runJournals()">Search</button>${can('accountant')?'<button class="save-btn" onclick="AccLedger.newJournal()">+ Manual journal</button>':''}`, '<div id="accJOut"></div>');
  L.runJournals();
}
L.runJournals=async()=>{
  const out=document.getElementById('accJOut'); out.innerHTML=spinner;
  try{
    const d=await api(`journals?${qs({from:val('accJFrom'), to:val('accJTo'), source_type:val('accJType'), q:val('accJQ')})}`);
    L.journals=d.list;
    out.innerHTML=d.list.length?`<div class="acc-journals">${d.list.map(j=>`<div class="acc-journal"><div class="acc-j-head"><b>#${j.entry_no}</b> <span>${j.entry_date}</span> <span class="badge ${j.source_type==='manual'?'sent':'draft'}">${esc(j.source_label)}</span> <span class="acc-j-memo">${esc(j.memo||'')}</span><span class="acc-j-amt">${m0(j.total)}</span>
      <span class="row-actions">${j.editable&&can('accountant')?`<button class="icon-btn" onclick="AccLedger.editJournal(${j.id})">✏️</button><button class="icon-btn danger" onclick="AccLedger.voidJournal(${j.id})">Void</button>`:''}${can('accountant')?`<button class="icon-btn" title="Post a reversing entry" onclick="AccLedger.reverseJournal(${j.id})">↩︎</button>`:''}</span></div>
      <table class="acc-j-lines">${j.lines.map(l=>`<tr><td>${esc(l.code||'')} · ${esc(l.account_name||'')}${l.party_name?` <span class="acc-small">(${esc(l.party_name)})</span>`:''}</td>${numCell(l.debit||'')}${numCell(l.credit||'')}</tr>`).join('')}</table></div>`).join('')}</div>`:empty('No journal entries in this range.');
  }catch(e){ out.innerHTML=errBox(e); }
};
L.newJournal=(j)=>{
  form({title:j?`Edit journal #${j.entry_no}`:'New manual journal', wide:true, fields:[{k:'date', label:'Date', type:'date', value:j?.entry_date||today()},{k:'memo', label:'Narration', value:j?.memo||''},{k:'branch', label:'Branch / cost centre (optional)', value:j?.branch||''}],
    extraHtml:linesEditor(j?.lines), onSave:async f=>{ const lines=readLines(); if(j) await post('journals/update', {id:j.id, ...f, lines}); else await post('journals', {...f, lines}); toast('Journal saved'); L.runJournals(); }});
  L.lineTotals();
};
L.editJournal=id=>L.newJournal(L.journals.find(j=>j.id===id));
L.voidJournal=async id=>{ const reason=prompt('Reason for voiding this journal?'); if(reason==null) return; await act(()=>post('journals/void', {id, reason}), 'Journal voided'); L.runJournals(); };
L.reverseJournal=async id=>{ const d=prompt('Date for the reversing entry (YYYY-MM-DD)', today()); if(!d) return; await act(()=>post('journals/reverse', {id, date:d}), 'Reversal posted'); L.runJournals(); };

async function booksCoa(body){
  try{
    const [{list}, cm]=await Promise.all([api('accounts'), api('category-map')]);
    const groups={asset:'Assets', liability:'Liabilities', equity:'Equity', income:'Income', expense:'Expenses'};
    body.innerHTML=card('Chart of accounts', can('accountant')?'<button class="save-btn" onclick="AccLedger.editAccount()">+ Account</button>':'',
      Object.entries(groups).map(([t,label])=>`<div class="card-title" style="margin-top:10px">${label}</div><div class="tbl-wrap"><table><thead><tr><th>Code</th><th>Name</th><th>Sub-type</th><th class="num">Balance</th><th></th></tr></thead><tbody>
        ${list.filter(a=>a.type===t).map(a=>`<tr class="${a.is_active?'':'acc-inactive'}"><td>${esc(a.code)}</td><td>${esc(a.name)} ${a.system_key?'<span class="badge draft" title="Used by automatic postings">system</span>':''}${a.bank_account_id?'<span class="badge sent">bank</span>':''}</td><td>${esc(a.subtype||'')}</td>${numCell(a.balance)}
          <td class="row-actions">${can('accountant')?`<button class="icon-btn" onclick='AccLedger.editAccount(${JSON.stringify(a).replace(/'/g,"&#39;")})'>✏️</button>`:''}${can('admin')&&!a.system_key&&!a.bank_account_id&&!a.has_entries?`<button class="icon-btn danger" onclick="AccLedger.deleteAccount(${a.id})">🗑</button>`:''}<button class="icon-btn" onclick="AccLedger.drill(${a.id})">📖</button></td></tr>`).join('')}</tbody></table></div>`).join(''))
      +card('Expense category → account mapping', '', `<div class="s-hint" style="margin-bottom:10px">Expense Entry and Financial Planning categories post to these accounts. Unmapped categories are matched by keyword (rent, software, ads…), else General Expenses.</div>
        <div class="tbl-wrap"><table><thead><tr><th>Category</th><th>Posts to</th></tr></thead><tbody>${cm.list.length?cm.list.map(c=>`<tr><td>${esc(c.category)}</td><td><select class="s-input" ${can('accountant')?'':'disabled'} onchange="AccLedger.mapCategory('${escAttr(c.category)}', this.value)">${accountOptions(c.account_id||c.effective_account_id, a=>a.type==='expense')}</select>${c.account_id?'':'<div class="s-hint">auto</div>'}</td></tr>`).join(''):empty('No expense categories yet.',2)}</tbody></table></div>`);
  }catch(e){ body.innerHTML=errBox(e); }
}
L.mapCategory=(category, account_id)=>act(()=>post('category-map', {category, account_id}), 'Mapping saved');
L.editAccount=(a={})=>form({title:a.id?'Edit account':'New account', fields:[
  {k:'code', label:'Code', value:a.code||''},{k:'name', label:'Name', value:a.name||''},
  {k:'type', label:'Type', type:'select', value:a.type||'expense', options:[['asset','Asset'],['liability','Liability'],['equity','Equity'],['income','Income'],['expense','Expense']]},
  {k:'subtype', label:'Sub-type', type:'select', value:a.subtype||'operating', options:[['operating','Operating'],['cogs','Cost of revenue (direct)'],['sales_marketing','Sales & marketing (counts toward CAC)'],['payroll','Payroll'],['other','Other income/expense'],['contra','Contra revenue'],['bank','Bank'],['cash','Cash'],['receivable','Receivable'],['current','Current asset/liability'],['fixed','Fixed asset'],['contra_fixed','Accumulated depreciation'],['tax','Tax'],['payable','Payable'],['deferred','Deferred revenue'],['long_term','Long-term liability'],['equity','Equity']]},
  {k:'parent_id', label:'Parent account (optional)', type:'account', value:a.parent_id||''},
  {k:'is_active', label:'Status', type:'checkbox', text:'Active', value:a.id?!!a.is_active:true},
  {k:'description', label:'Description', type:'textarea', value:a.description||'', full:true}],
  onSave:async f=>{ await post('accounts', {...f, id:a.id}); await loadMeta(true); toast('Account saved'); booksCoa(document.querySelector('#tabBooks .acc-sub-body')); }});
L.deleteAccount=async id=>{ if(!confirm('Delete this account?')) return; await act(()=>post('accounts/delete', {id}), 'Deleted'); await loadMeta(true); booksCoa(document.querySelector('#tabBooks .acc-sub-body')); };

async function booksNotes(body){
  try{
    const {list}=await api('notes');
    body.innerHTML=card('Credit notes & debit notes', can('accountant')?'<button class="save-btn sec" onclick="AccLedger.newNote(\'debit\')">+ Debit note (supplier)</button><button class="save-btn" onclick="AccLedger.newNote(\'credit\')">+ Credit note (customer)</button>':'',
      `<div class="s-hint" style="margin-bottom:10px">A credit note reduces what a customer owes (return, discount, refund or bad-debt write-off) and reverses the GST. A debit note reduces what you owe a supplier.</div>
      <div class="tbl-wrap"><table><thead><tr><th>No.</th><th>Date</th><th>Party</th><th>Against</th><th>Reason</th><th class="num">Taxable</th><th class="num">GST</th><th class="num">Total</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.length?list.map(n=>`<tr><td>${n.note_type==='credit'?'CN':'DN'}-${n.id}</td><td>${n.note_date}</td><td>${esc(n.party_name||'')}</td><td>${n.linked_id?(n.linked_type==='invoice'?'Invoice #':'Bill #')+n.linked_id:'—'}</td><td>${esc(n.reason)}</td>${numCell(n.subtotal)}${numCell(n.cgst+n.sgst+n.igst)}${numCell(n.total)}<td><span class="badge ${n.status==='void'?'void':'paid'}">${n.status}</span></td><td>${n.status!=='void'&&can('accountant')?`<button class="icon-btn danger" onclick="AccLedger.voidNote(${n.id})">Void</button>`:''}</td></tr>`).join(''):empty('No notes yet.',10)}</tbody></table></div>`);
  }catch(e){ body.innerHTML=errBox(e); }
}
L.newNote=type=>{
  const invs=(typeof allDocuments!=='undefined'?allDocuments:[]).filter(d=>d.type==='invoice' && ['sent','paid','accepted'].includes(d.status));
  const bills=typeof allVendorBills!=='undefined'?allVendorBills:[];
  form({title:type==='credit'?'New credit note':'New debit note', fields:[
    type==='credit'?{k:'linked_id', label:'Against invoice', type:'select', options:[['','— None —'], ...invs.map(d=>[d.Id||d.id, `#${d.Id||d.id} · ${d.customer_name||''} · ${d.currency||''} ${d.total}`])]}
                   :{k:'linked_id', label:'Against bill', type:'select', options:[['','— None —'], ...bills.map(b=>[b.Id||b.id, `#${b.Id||b.id} · ${b.supplier} · ${b.currency||''} ${b.total}`])]},
    {k:'party_name', label:type==='credit'?'Customer (if no invoice)':'Supplier (if no bill)'},
    {k:'note_date', label:'Date', type:'date', value:today()},
    {k:'reason', label:'Reason', type:'select', options:type==='credit'?[['return','Return / service not delivered'],['discount','Discount / price adjustment'],['refund','Refund (money paid back)'],['write_off','Bad-debt write-off'],['other','Other']]:[['return','Purchase return'],['discount','Discount received'],['other','Other']]},
    {k:'subtotal', label:'Amount before GST', type:'number', step:'0.01'},
    {k:'gst_rate_pct', label:'GST rate % (blank = same as invoice)', type:'number'},
    type==='credit'?{k:'refund_account_id', label:'Refund paid from (refunds only)', type:'account', filter:cashAccounts}:{k:'supplier_state', label:'Supplier state code (for CGST/SGST vs IGST)', placeholder:'e.g. 32'},
    {k:'notes', label:'Notes', type:'textarea', full:true}],
    onSave:async f=>{ const r=await post('notes', {...f, note_type:type}); toast(`Saved — total ${m0(r.total)}`); booksNotes(document.querySelector('#tabBooks .acc-sub-body')); }});
};
L.voidNote=async id=>{ if(!confirm('Void this note?')) return; await act(()=>post('notes/void', {id}), 'Voided'); booksNotes(document.querySelector('#tabBooks .acc-sub-body')); };

async function booksParties(body){
  body.innerHTML=card('Customer & supplier ledgers', `<select class="s-input" id="accPtType" style="width:auto" onchange="AccLedger.runParties()"><option value="customer">Customers (receivable)</option><option value="supplier">Suppliers (payable)</option></select>`, '<div id="accPtOut"></div>');
  L.runParties();
}
L.runParties=async()=>{
  const out=document.getElementById('accPtOut'); out.innerHTML=spinner; const type=val('accPtType');
  try{
    const {list}=await api(`parties?type=${type}`);
    out.innerHTML=`<div class="tbl-wrap"><table><thead><tr><th>${type==='customer'?'Customer':'Supplier'}</th><th class="num">Billed</th><th class="num">Paid / credited</th><th class="num">Balance</th><th>Last activity</th><th></th></tr></thead><tbody>
      ${list.length?list.map(p=>`<tr><td>${esc(p.party)}</td>${numCell(type==='customer'?p.debit:p.credit)}${numCell(type==='customer'?p.credit:p.debit)}${numCell(p.balance)}<td>${p.last_date||''}</td><td class="row-actions"><button class="icon-btn" onclick="AccLedger.statement('${type}', '${escAttr(p.party).replace(/'/g,"\\'")}')">📄 Statement</button>${type==='customer'&&can('accountant')?`<button class="icon-btn" onclick="AccLedger.portalLink('${escAttr(p.party).replace(/'/g,"\\'")}')">🔗 Portal</button>`:''}</td></tr>`).join(''):empty('No balances yet.',6)}</tbody></table></div>`;
  }catch(e){ out.innerHTML=errBox(e); }
};
L.statement=async(type, name)=>{
  const from=prompt('Statement from (YYYY-MM-DD)', fyStart()); if(!from) return;
  try{
    const d=await api(`party-statement?${qs({type, name, from, to:today()})}`);
    const {jsPDF}=window.jspdf; const doc=new jsPDF();
    doc.setFontSize(15); doc.text(`Statement of account — ${name}`, 14, 18);
    doc.setFontSize(10); doc.text(`${d.business_name||(typeof clientRecord!=='undefined'&&clientRecord?.client_name||'')}   ·   ${d.from} to ${d.to}   ·   ${d.base_currency}`, 14, 25);
    doc.autoTable({startY:32, head:[['Date','Description','Debit','Credit','Balance']], body:[['', 'Opening balance','','',m0(d.opening)], ...d.rows.map(r=>[r.date, r.memo||'', r.debit?m0(r.debit):'', r.credit?m0(r.credit):'', m0(r.balance)]), ['', 'Closing balance', m0(d.total_debit), m0(d.total_credit), m0(d.closing)]],
      styles:{fontSize:8}, headStyles:{fillColor:[194,65,12]}, columnStyles:{2:{halign:'right'},3:{halign:'right'},4:{halign:'right'}}});
    doc.save(`statement_${name.replace(/[^a-z0-9]+/gi,'_')}_${d.to}.pdf`);
  }catch(e){ toast(e.message, true); }
};
L.portalLink=async name=>{
  try{ const r=await post('portal-tokens', {customer_name:name}); const url=portalUrl(r.token);
    try{ await navigator.clipboard.writeText(url); toast('Portal link copied'); }catch(_){ prompt('Client portal link', url); } }catch(e){ toast(e.message, true); }
};
const portalUrl=t=>`${location.origin}${location.pathname.replace(/[^/]*$/,'')}accounting-portal.html?t=${t}`;

async function booksClose(body){
  await loadMeta(true); const s=L.meta.settings;
  const fy=Number(fyStart().slice(0,4))-1;
  body.innerHTML=card('Lock the books', '', `<div class="s-hint" style="margin-bottom:10px">Nothing dated on or before the lock date can be created, edited or deleted in the ledger — changes to documents in a locked period show up as warnings instead. Use a reversing journal in an open period to correct closed months.</div>
      <div class="acc-inline"><label class="s-lbl">Locked up to</label><input class="s-input" type="date" id="accLockDate" value="${s.lock_date||''}" style="width:auto">${can('admin')?'<button class="save-btn" onclick="AccLedger.setLock()">Save lock date</button><button class="save-btn sec" onclick="AccLedger.setLock(true)">Unlock all</button>':''}</div>`)
    +card('Year-end close', '', `<div class="s-hint" style="margin-bottom:10px">Moves the year's profit or loss into Retained Earnings with one closing entry and locks that year. Reports for the year are unaffected.</div>
      <div class="acc-inline"><label class="s-lbl">Financial year starting</label><input class="s-input" type="number" id="accCloseFy" value="${fy}" style="width:110px">${can('admin')?'<button class="save-btn" onclick="AccLedger.closeYear()">Close year</button>':''}</div>`)
    +card('Re-sync ledger', can('accountant')?'<button class="save-btn sec" onclick="AccLedger.resync()">Re-sync now</button>':'', '<div class="s-hint">The ledger re-reads every invoice, receipt, expense, bill and payment each time a report is opened. Use this to see what changed and any warnings.</div><div id="accSyncOut"></div>');
}
L.setLock=async unlock=>{ await act(()=>post('lock', {lock_date:unlock?null:val('accLockDate')}), unlock?'Books unlocked':'Lock date saved'); booksClose(document.querySelector('#tabBooks .acc-sub-body')); };
L.closeYear=async()=>{ const fy=val('accCloseFy'); if(!confirm(`Close FY ${fy}-${String(Number(fy)+1).slice(-2)}? This posts a closing entry and locks the year.`)) return; const r=await act(()=>post('close-year', {fy})); if(r) toast(`Closed — net profit ${m0(r.net_profit)}, locked to ${r.locked_to}`); booksClose(document.querySelector('#tabBooks .acc-sub-body')); };
L.resync=async()=>{ const out=document.getElementById('accSyncOut'); out.innerHTML=spinner; try{ const r=await post('sync'); out.innerHTML=`<div class="acc-bal ok">Posted ${r.posted} · updated ${r.reposted} · voided ${r.voided}</div>${warnList(r.warnings)}`; }catch(e){ out.innerHTML=errBox(e); } };

async function booksAudit(body){
  body.innerHTML=card('Audit trail', `<label class="acc-check"><input type="checkbox" id="accAuditHide" checked onchange="AccLedger.runAudit()"> Hide automatic syncs</label>`, '<div id="accAuditOut"></div>');
  L.runAudit();
}
L.runAudit=async()=>{
  const out=document.getElementById('accAuditOut'); out.innerHTML=spinner;
  try{ const {list}=await api(`audit?hide_sync=${document.getElementById('accAuditHide').checked?1:0}`);
    out.innerHTML=`<div class="tbl-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Details</th></tr></thead><tbody>${list.length?list.map(a=>`<tr><td>${new Date(a.at).toLocaleString()}</td><td>${esc(a.actor||'')}</td><td>${esc(a.action)}</td><td>${esc(a.entity_type||'')} ${esc(a.entity_id||'')}</td><td class="acc-small acc-details">${esc((a.details||'').slice(0,300))}</td></tr>`).join(''):empty('Nothing logged yet.',5)}</tbody></table></div>`;
  }catch(e){ out.innerHTML=errBox(e); }
};

Object.assign(L, {api, post, qs, today, fyStart, money, m0, pct, numCell, empty, spinner, errBox, can, toast, act, download, toCsv, exportXlsx, accountOptions, cashAccounts, accName, subnav, card, dateRangeInputs, val, form, loadMeta, linesEditor, readLines, warnList, portalUrl, addDays, monthStart,
  renderOverview, renderBooks, plTable});
})();

/* ══════════ 🔁 SUBSCRIPTIONS / 🧾 TAX / ⚙️ OPERATIONS ══════════ */
(function(){
'use strict';
const L=window.AccLedger;
const {api, post, qs, today, fyStart, money, m0, pct, numCell, empty, spinner, errBox, can, toast, act, download, toCsv, exportXlsx, accountOptions, cashAccounts, accName, subnav, card, dateRangeInputs, val, form, loadMeta, linesEditor, readLines, portalUrl, addDays}=L;
const body=tab=>document.querySelector(`#${tab} .acc-sub-body`);
const statusBadge=s=>`<span class="badge ${({active:'paid', trialing:'sent', past_due:'failed', suspended:'void', paused:'draft', cancelled:'void', open:'sent', paid:'paid', overdue:'void', draft:'draft', posted:'sent', pending:'pending', approved:'paid', rejected:'void'})[s]||'draft'}">${esc(String(s).replace('_',' '))}</span>`;
const docs=()=>typeof allDocuments!=='undefined'?allDocuments:[];
const fpCust=()=>typeof fpCustomers!=='undefined'?fpCustomers:[];

/* ── 🔁 Subscriptions ── */
async function renderSubs(root){
  await loadMeta();
  subnav(root, 'subs', [['metrics','📊 SaaS Metrics'],['subs','🔁 Subscriptions'],['plans','📦 Plans & Coupons'],['usage','📈 Usage'],['revrec','🗓️ Revenue Recognition'],['collect','📨 Dunning & Reminders'],['settle','💳 Gateway Settlements']], (k, b)=>({metrics:subsMetrics, subs:subsList, plans:subsPlans, usage:subsUsage, revrec:subsRevrec, collect:subsCollect, settle:subsSettle})[k](b));
}
async function subsMetrics(b){
  try{
    const d=await api('metrics');
    const k=(l,v,s)=>`<div class="stat-card"><div class="stat-lbl">${l}</div><div class="stat-val">${v}</div>${s?`<div class="stat-sub">${s}</div>`:''}</div>`;
    b.innerHTML=`<div class="stat-grid">
      ${k('MRR', money(d.mrr), `ARR ${money(d.arr)}`)}${k('Active', d.active_subscriptions, `${d.trialing} trialing · ${d.past_due} past due · ${d.suspended} suspended`)}${k('ARPU', money(d.arpu))}
      ${k('Net revenue retention', pct(d.nrr_pct), 'trailing 12 months')}${k('Gross revenue retention', pct(d.grr_pct))}${k('Logo churn (30d)', pct(d.logo_churn_30d_pct), `Revenue churn ${pct(d.revenue_churn_30d_pct)}`)}
      ${k('Gross margin', pct(d.gross_margin_pct), 'last 3 months')}${k('CAC', d.cac==null?'—':money(d.cac), `${d.new_customers_3m} new · S&M ${money(d.sales_marketing_3m)}`)}${k('LTV', d.ltv==null?'—':money(d.ltv), d.ltv_cac?`LTV:CAC ${d.ltv_cac}×`:'')}
      ${k('CAC payback', d.cac_payback_months==null?'—':d.cac_payback_months+' mo')}${k('Burn', d.burn_rate>0?money(d.burn_rate):'Cash-positive')}${k('Runway', d.runway_months==null?'∞':d.runway_months+' mo', `Cash ${money(d.cash)}`)}
    </div>
    ${card('MRR movement — last 12 months', '', `<div style="height:260px"><canvas id="accMrrChart"></canvas></div><div class="tbl-wrap"><table><thead><tr><th>Month</th><th class="num">New</th><th class="num">Expansion</th><th class="num">Reactivation</th><th class="num">Contraction</th><th class="num">Churn</th><th class="num">MRR end</th></tr></thead><tbody>${d.movement.map(m=>`<tr><td>${m.month}</td>${numCell(m.new)}${numCell(m.expansion)}${numCell(m.reactivation)}${numCell(m.contraction)}${numCell(m.churn)}${numCell(m.mrr_end)}</tr>`).join('')}</tbody></table></div>`)}
    ${card('Renewals in the next 30 days', '', d.renewals_30d.length?`<table><tbody>${d.renewals_30d.map(r=>`<tr><td>${r.date}</td><td>${esc(r.customer)}</td>${numCell(r.amount)}<td>${esc(r.currency||'')}</td></tr>`).join('')}</tbody></table>`:empty('None.'))}
    <div class="s-hint">${esc(d.notes)}</div>`;
    if(window.Chart){ if(L.charts.mrr) L.charts.mrr.destroy(); L.charts.mrr=new Chart(document.getElementById('accMrrChart'), {type:'bar', data:{labels:d.movement.map(m=>m.month), datasets:[
      {label:'New', data:d.movement.map(m=>m.new), backgroundColor:'#059669', stack:'s'}, {label:'Expansion', data:d.movement.map(m=>m.expansion+m.reactivation), backgroundColor:'#34D399', stack:'s'},
      {label:'Contraction', data:d.movement.map(m=>m.contraction), backgroundColor:'#FBBF24', stack:'s'}, {label:'Churn', data:d.movement.map(m=>m.churn), backgroundColor:'#DC2626', stack:'s'},
      {label:'MRR', data:d.movement.map(m=>m.mrr_end), type:'line', borderColor:'#C2410C', yAxisID:'y1', tension:.3}]}, options:{maintainAspectRatio:false, plugins:{legend:{position:'bottom'}}, scales:{x:{stacked:true}, y:{stacked:true}, y1:{position:'right', grid:{display:false}}}}}); }
  }catch(e){ b.innerHTML=errBox(e); }
}
async function subsList(b){
  try{
    const [{list}, plans]=await Promise.all([api('subscriptions'), api('plans')]); L.subs=list; L.plans=plans.list;
    b.innerHTML=card('Subscriptions', can('accountant')?`<button class="save-btn sec" onclick="AccLedger.importFp()">Import Financial Planning customers</button><button class="save-btn sec" onclick="AccLedger.billingRun()">▶ Run billing now</button><button class="save-btn" onclick="AccLedger.newSub()">+ Subscription</button>`:'',
      `<div class="tbl-wrap"><table><thead><tr><th>Customer</th><th>Plan</th><th class="num">Price</th><th>Every</th><th class="num">MRR</th><th>Status</th><th>Next bill</th><th></th></tr></thead><tbody>
      ${list.length?list.map(s=>`<tr><td>${esc(s.customer_name)}${s.customer_email?`<div class="acc-small">${esc(s.customer_email)}</div>`:''}</td><td>${esc(s.plan_name||'')} ${s.quantity!=1?'× '+s.quantity:''}${s.discount_pct||s.discount_amount?`<div class="acc-small">discount ${s.discount_pct?s.discount_pct+'%':m0(s.discount_amount)}${s.discount_months_left>0?' · '+s.discount_months_left+' mo left':s.discount_months_left===0?' (ended)':''}</div>`:''}</td>${numCell(s.amount)}<td>${s.interval}</td>${numCell(s.mrr)}
        <td>${statusBadge(s.status)}${s.cancel_at?`<div class="acc-small">cancels ${s.cancel_at}</div>`:''}${s.auto_invoice?'':'<div class="acc-small">not auto-billed</div>'}</td><td>${s.status==='trialing'?'trial → '+(s.trial_end||''):(s.next_billing_date||'')}</td>
        <td>${can('accountant')?`<select class="s-input" style="width:auto;font-size:12px" onchange="AccLedger.subAction(${s.id}, this.value); this.value=''"><option value="">Actions…</option><option value="change">Change plan / qty</option><option value="bill_now">Bill now</option><option value="edit">Edit details</option>${['active','past_due'].includes(s.status)?'<option value="pause">Pause</option>':''}${['paused','suspended','cancelled'].includes(s.status)?'<option value="resume">Resume</option>':''}${s.status!=='cancelled'?'<option value="cancel_end">Cancel at period end</option><option value="cancel">Cancel now</option>':''}${s.cancel_at?'<option value="undo_cancel">Undo cancellation</option>':''}<option value="usage">Record usage</option><option value="portal">Copy portal link</option></select>`:''}</td></tr>`).join(''):empty('No subscriptions yet. Add one, or import your Financial Planning recurring customers.',8)}</tbody></table></div>
      <div class="s-hint">The daily billing run creates an Invoice (Documents tab) for every subscription whose next bill date has arrived — trials convert on their end date, coupons apply, metered usage is billed in arrears, and annual / quarterly invoices are recognised monthly through Deferred Revenue.</div>`);
  }catch(e){ b.innerHTML=errBox(e); }
}
const planOpts=()=>[['','— Custom price —'], ...(L.plans||[]).filter(p=>p.is_active).map(p=>[p.id, `${p.name} · ${p.currency} ${p.amount}/${p.interval}`])];
L.newSub=()=>form({title:'New subscription', fields:[
  {k:'customer_name', label:'Customer', placeholder:'Name as on invoices'}, {k:'customer_email', label:'Email (for invoices & reminders)'},
  {k:'plan_id', label:'Plan', type:'select', options:planOpts()}, {k:'amount', label:'Price per period (blank = plan price)', type:'number', step:'0.01'},
  {k:'interval', label:'Billing interval', type:'select', options:[['month','Monthly'],['quarter','Quarterly'],['half_year','Half-yearly'],['year','Yearly']]}, {k:'quantity', label:'Quantity / seats', type:'number', value:1},
  {k:'start_date', label:'Start date', type:'date', value:today()}, {k:'trial_days', label:'Trial days (blank = plan default)', type:'number'},
  {k:'coupon_code', label:'Coupon code'}, {k:'currency', label:'Currency', value:L.meta?.settings?.base_currency||'INR'},
  {k:'gst_rate_pct', label:'GST % (blank = plan)', type:'number'}, {k:'place_of_supply', label:'Customer state code', placeholder:'e.g. 32'},
  {k:'recipient_gstin', label:'Customer GSTIN (B2B)'}, {k:'auto_invoice', label:'Billing', type:'checkbox', text:'Create invoices automatically', value:true},
  {k:'recognize_over_period', label:'Revenue', type:'checkbox', text:'Recognise multi-month invoices monthly', value:true}, {k:'bill_now', label:'Now', type:'checkbox', text:'Invoice the first period immediately', value:false}],
  onSave:async f=>{ await post('subscriptions', f); toast('Subscription created'); subsList(body('tabSubscriptions')); }});
L.subAction=async(id, a)=>{
  const s=L.subs.find(x=>x.id===id); if(!a) return;
  const reload=()=>subsList(body('tabSubscriptions'));
  if(a==='change') return form({title:`Change ${s.customer_name}`, fields:[{k:'plan_id', label:'New plan', type:'select', options:planOpts()},{k:'amount', label:'New price (blank = plan)', type:'number', step:'0.01'},{k:'quantity', label:'Quantity', type:'number', value:s.quantity},{k:'effective_date', label:'Effective', type:'date', value:today()},{k:'prorate', label:'Proration', type:'checkbox', text:'Prorate the rest of this period', value:true}],
    onSave:async f=>{ const r=await post('subscriptions/change', {id, ...f}); toast(r.proration?`${r.proration.type==='invoice'?'Proration invoice':'Credit note'} for ${m0(r.proration.amount)}`:'Plan changed'); reload(); }});
  if(a==='edit') return form({title:`Edit ${s.customer_name}`, fields:[{k:'customer_name', label:'Customer', value:s.customer_name},{k:'customer_email', label:'Email', value:s.customer_email},{k:'next_billing_date', label:'Next billing date', type:'date', value:s.next_billing_date},{k:'gst_rate_pct', label:'GST %', type:'number', value:s.gst_rate_pct},{k:'place_of_supply', label:'State code', value:s.place_of_supply},{k:'recipient_gstin', label:'GSTIN', value:s.recipient_gstin},{k:'auto_invoice', label:'Billing', type:'checkbox', text:'Auto-invoice', value:!!s.auto_invoice},{k:'notes', label:'Notes', type:'textarea', value:s.notes, full:true}],
    onSave:async f=>{ await post('subscriptions/update', {id, ...f}); toast('Saved'); reload(); }});
  if(a==='usage') return form({title:`Record usage — ${s.customer_name}`, fields:[{k:'quantity', label:'Quantity', type:'number'},{k:'metric', label:'Metric', placeholder:'e.g. messages'},{k:'usage_date', label:'Date', type:'date', value:today()}], onSave:async f=>{ await post('usage', {subscription_id:id, ...f}); toast('Usage recorded'); }});
  if(a==='portal') return L.portalLink(s.customer_name);
  const map={cancel_end:{action:'cancel', at_period_end:true}, cancel:{action:'cancel'}};
  const payload={id, ...(map[a]||{action:a})};
  if(payload.action==='cancel'){ const r=prompt('Cancellation reason (optional)'); if(r==null) return; payload.reason=r; }
  const r=await act(()=>post('subscriptions/action', payload), 'Done'); if(r?.invoices?.length) toast(`Created ${r.invoices.length} invoice(s)`);
  reload();
};
L.billingRun=async()=>{ const r=await act(()=>post('billing-run')); if(r){ const n=r.results.reduce((s,x)=>s+(x.invoices?.length||0),0); toast(n?`Created ${n} invoice(s)`:'Nothing due today'); if(n && typeof loadDocuments==='function'){ try{ await loadDocuments(); renderDocumentsTable(); }catch(_){} } } subsList(body('tabSubscriptions')); };
L.importFp=async()=>{ const r=await act(()=>post('import-fp-customers')); if(r) toast(`Imported ${r.imported}`); subsList(body('tabSubscriptions')); };
async function subsPlans(b){
  try{
    const [p, c]=await Promise.all([api('plans'), api('coupons')]); L.plans=p.list;
    b.innerHTML=card('Plans', can('accountant')?'<button class="save-btn" onclick="AccLedger.editPlan()">+ Plan</button>':'', `<div class="tbl-wrap"><table><thead><tr><th>Plan</th><th class="num">Price</th><th>Every</th><th>Trial</th><th>GST</th><th>Metered</th><th></th></tr></thead><tbody>
      ${p.list.length?p.list.map(x=>`<tr class="${x.is_active?'':'acc-inactive'}"><td>${esc(x.name)}${x.code?` <span class="acc-small">${esc(x.code)}</span>`:''}</td>${numCell(x.amount)}<td>${x.interval}</td><td>${x.trial_days?x.trial_days+' days':'—'}</td><td>${x.gst_rate_pct||0}%</td><td>${x.metered_unit_price?`${m0(x.metered_unit_price)}/${esc(x.metered_unit_name||'unit')} over ${x.included_units}`:'—'}</td><td>${can('accountant')?`<button class="icon-btn" onclick='AccLedger.editPlan(${JSON.stringify(x).replace(/'/g,"&#39;")})'>✏️</button>`:''}</td></tr>`).join(''):empty('No plans yet.',7)}</tbody></table></div>`)
      +card('Coupons', can('accountant')?'<button class="save-btn" onclick="AccLedger.editCoupon()">+ Coupon</button>':'', `<div class="tbl-wrap"><table><thead><tr><th>Code</th><th>Discount</th><th>Duration</th><th>Used</th><th>Valid till</th><th></th></tr></thead><tbody>
      ${c.list.length?c.list.map(x=>`<tr class="${x.is_active?'':'acc-inactive'}"><td><b>${esc(x.code)}</b></td><td>${x.kind==='pct'?x.value+'%':m0(x.value)}</td><td>${x.duration_months?x.duration_months+' months':'forever'}</td><td>${x.redeemed}${x.max_redemptions?' / '+x.max_redemptions:''}</td><td>${x.valid_till||'—'}</td><td>${can('accountant')?`<button class="icon-btn" onclick='AccLedger.editCoupon(${JSON.stringify(x).replace(/'/g,"&#39;")})'>✏️</button>`:''}</td></tr>`).join(''):empty('No coupons.',6)}</tbody></table></div>`);
  }catch(e){ b.innerHTML=errBox(e); }
}
L.editPlan=(p={})=>form({title:p.id?'Edit plan':'New plan', fields:[{k:'name', label:'Name', value:p.name},{k:'code', label:'Code', value:p.code},{k:'amount', label:'Price per period', type:'number', step:'0.01', value:p.amount},{k:'currency', label:'Currency', value:p.currency||L.meta?.settings?.base_currency},
  {k:'interval', label:'Interval', type:'select', value:p.interval||'month', options:[['month','Monthly'],['quarter','Quarterly'],['half_year','Half-yearly'],['year','Yearly']]},{k:'trial_days', label:'Trial days', type:'number', value:p.trial_days||0},{k:'gst_rate_pct', label:'GST %', type:'number', value:p.gst_rate_pct??18},{k:'sac_code', label:'SAC code', value:p.sac_code||'998314'},
  {k:'metered_unit_name', label:'Metered unit (optional)', value:p.metered_unit_name, placeholder:'e.g. messages'},{k:'metered_unit_price', label:'Price per extra unit', type:'number', step:'0.0001', value:p.metered_unit_price},{k:'included_units', label:'Units included per seat', type:'number', value:p.included_units},{k:'is_active', label:'Status', type:'checkbox', text:'Active', value:p.id?!!p.is_active:true}],
  onSave:async f=>{ await post('plans', {...f, id:p.id}); toast('Plan saved'); subsPlans(body('tabSubscriptions')); }});
L.editCoupon=(c={})=>form({title:c.id?'Edit coupon':'New coupon', fields:[{k:'code', label:'Code', value:c.code},{k:'kind', label:'Type', type:'select', value:c.kind||'pct', options:[['pct','Percentage'],['amount','Fixed amount per period']]},{k:'value', label:'Value', type:'number', value:c.value},{k:'duration_months', label:'Duration in months (0 = forever)', type:'number', value:c.duration_months||0},{k:'max_redemptions', label:'Max redemptions (0 = unlimited)', type:'number', value:c.max_redemptions||0},{k:'valid_till', label:'Valid till', type:'date', value:c.valid_till},{k:'is_active', label:'Status', type:'checkbox', text:'Active', value:c.id?!!c.is_active:true}],
  onSave:async f=>{ await post('coupons', {...f, id:c.id}); toast('Coupon saved'); subsPlans(body('tabSubscriptions')); }});
async function subsUsage(b){
  try{ const {list}=await api('usage');
    b.innerHTML=card('Metered usage', '', `<div class="s-hint" style="margin-bottom:10px">Record usage from a subscription's Actions menu, or POST it from your app. Usage above the plan's included units is billed on the next invoice.</div><div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Customer</th><th>Metric</th><th class="num">Qty</th><th>Billed</th></tr></thead><tbody>${list.length?list.map(u=>`<tr><td>${u.usage_date}</td><td>${esc(u.customer_name||'#'+u.subscription_id)}</td><td>${esc(u.metric||'')}</td><td class="num">${u.quantity}</td><td>${u.billed_invoice_id?'Invoice #'+u.billed_invoice_id:'—'}</td></tr>`).join(''):empty('No usage recorded.',5)}</tbody></table></div>`);
  }catch(e){ b.innerHTML=errBox(e); }
}
async function subsRevrec(b){
  try{ const {list}=await api('revrec');
    b.innerHTML=card('Revenue recognition schedules', can('accountant')?'<button class="save-btn" onclick="AccLedger.newRevrec()">+ Defer an invoice</button>':'', `<div class="s-hint" style="margin-bottom:10px">An invoice with a schedule books its revenue to Deferred Revenue and releases an equal slice each month.</div><div class="tbl-wrap"><table><thead><tr><th>Invoice</th><th>Customer</th><th>From</th><th>Months</th><th class="num">Total</th><th class="num">Recognised</th><th class="num">Still deferred</th><th></th></tr></thead><tbody>
      ${list.length?list.map(r=>`<tr><td>#${r.invoice_id} ${esc(r.title||'')}</td><td>${esc(r.customer_name||'')}</td><td>${r.start_month}</td><td>${r.recognised_months}/${r.months}</td>${numCell(r.subtotal)}${numCell(r.recognised)}${numCell(r.deferred)}<td>${can('accountant')?`<button class="icon-btn danger" onclick="AccLedger.delRevrec(${r.invoice_id})">Remove</button>`:''}</td></tr>`).join(''):empty('No schedules.',8)}</tbody></table></div>`);
  }catch(e){ b.innerHTML=errBox(e); }
}
L.newRevrec=()=>form({title:'Defer an invoice', fields:[{k:'invoice_id', label:'Invoice', type:'select', options:docs().filter(d=>d.type==='invoice').map(d=>[d.Id||d.id, `#${d.Id||d.id} · ${d.customer_name||''} · ${d.currency||''} ${d.subtotal}`])},{k:'start_month', label:'First month', type:'month', value:today().slice(0,7)},{k:'months', label:'Number of months', type:'number', value:12},{k:'revenue_account_id', label:'Revenue account (optional)', type:'account', filter:a=>a.type==='income'}],
  onSave:async f=>{ await post('revrec', f); toast('Schedule saved'); subsRevrec(body('tabSubscriptions')); }});
L.delRevrec=async id=>{ if(!confirm('Remove this schedule? The invoice will be recognised in full on its date.')) return; await act(()=>post('revrec/delete', {invoice_id:id}), 'Removed'); subsRevrec(body('tabSubscriptions')); };
async function subsCollect(b){
  try{ await loadMeta(true); const s=L.meta.settings; const D=JSON.parse(s.dunning_json||'null')||L.meta.defaults.dunning, R=JSON.parse(s.reminders_json||'null')||L.meta.defaults.reminders;
    const {list}=await api('reminders-log');
    b.innerHTML=card('Invoice reminders (all invoices)', '', `<div class="modal-grid"><div><label class="acc-check"><input type="checkbox" id="accRemOn" ${R.enabled?'checked':''}> Send reminders</label></div><div><label class="s-lbl">Days relative to due date</label><input class="s-input" id="accRemOffsets" value="${(R.offsets||[]).join(', ')}"><div class="s-hint">Negative = before due, e.g. -3, 0, 3, 7, 15</div></div><div><label class="acc-check"><input type="checkbox" id="accRemEmail" ${R.email?'checked':''}> Email</label><label class="acc-check"><input type="checkbox" id="accRemWa" ${R.whatsapp?'checked':''}> WhatsApp (uses the Financial Planning reminder template)</label></div></div>`)
      +card('Subscription dunning', '', `<div class="modal-grid"><div><label class="acc-check"><input type="checkbox" id="accDunOn" ${D.enabled?'checked':''}> Chase unpaid subscription invoices</label></div><div><label class="s-lbl">Reminder days after due</label><input class="s-input" id="accDunDays" value="${(D.reminder_days||[]).join(', ')}"></div><div><label class="s-lbl">Suspend after (days overdue, 0 = never)</label><input class="s-input" type="number" id="accDunSuspend" value="${D.suspend_after_days}"></div><div><label class="acc-check"><input type="checkbox" id="accDunEmail" ${D.email?'checked':''}> Email</label><label class="acc-check"><input type="checkbox" id="accDunWa" ${D.whatsapp?'checked':''}> WhatsApp</label></div></div>
        <div class="s-hint">Each message includes the balance, due date, a Razorpay payment link (when your Razorpay keys are saved in Financial Planning → Settings) and your UPI ID. Suspended subscriptions drop out of MRR and reactivate automatically once paid.</div>
        ${can('admin')?'<div class="modal-actions"><button class="save-btn sec" onclick="AccLedger.runCollections()">Send due reminders now</button><button class="save-btn" onclick="AccLedger.saveCollect()">Save</button></div>':''}`)
      +card('Reminder log', '', `<div class="tbl-wrap"><table><thead><tr><th>When</th><th>Invoice</th><th>Customer</th><th>Step</th><th>Channel</th><th>Result</th></tr></thead><tbody>${list.length?list.map(l=>`<tr><td>${new Date(l.created_at).toLocaleString()}</td><td>#${l.invoice_id}</td><td>${esc(l.customer_name||'')}</td><td>${esc(l.step)}</td><td>${esc(l.channel||'')}</td><td>${statusBadge(l.status==='sent'?'paid':l.status==='failed'?'void':'draft').replace(/>[^<]*</,'>'+esc(l.status)+'<')}${l.detail?`<div class="acc-small">${esc(l.detail)}</div>`:''}</td></tr>`).join(''):empty('Nothing sent yet.',6)}</tbody></table></div>`);
  }catch(e){ b.innerHTML=errBox(e); }
}
const nums=s=>String(s||'').split(',').map(x=>Number(x.trim())).filter(x=>!isNaN(x)&&String(x)!=='');
L.saveCollect=()=>act(()=>post('settings', {reminders:{enabled:document.getElementById('accRemOn').checked, offsets:nums(val('accRemOffsets')), email:document.getElementById('accRemEmail').checked, whatsapp:document.getElementById('accRemWa').checked},
  dunning:{enabled:document.getElementById('accDunOn').checked, reminder_days:nums(val('accDunDays')), suspend_after_days:Number(val('accDunSuspend'))||0, email:document.getElementById('accDunEmail').checked, whatsapp:document.getElementById('accDunWa').checked}}), 'Saved');
L.runCollections=async()=>{ const r=await act(()=>post('collections-run')); if(r) toast(`${r.sent.length} reminder step(s) processed`); subsCollect(body('tabSubscriptions')); };
async function subsSettle(b){
  try{ const {list}=await api('settlements');
    b.innerHTML=card('Payment gateway settlements', can('accountant')?'<button class="save-btn sec" onclick="AccLedger.importSettle()">⬆ Import CSV</button><button class="save-btn" onclick="AccLedger.editSettle()">+ Settlement</button>':'', `<div class="s-hint" style="margin-bottom:10px">Receipts without a bank account sit in Undeposited Funds at the gross amount. A settlement moves the net payout into your bank and books the gateway fee and the GST on it (claimable as input credit).</div>
      <div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Gateway</th><th>Reference</th><th class="num">Gross</th><th class="num">Fee</th><th class="num">GST on fee</th><th class="num">Net to bank</th><th></th></tr></thead><tbody>${list.length?list.map(s=>`<tr><td>${s.settlement_date}</td><td>${esc(s.gateway)}</td><td>${esc(s.settlement_ref)}</td>${numCell(s.gross)}${numCell(s.fee)}${numCell(s.tax_on_fee)}${numCell(s.net)}<td>${can('accountant')?`<button class="icon-btn danger" onclick="AccLedger.delSettle(${s.id})">🗑</button>`:''}</td></tr>`).join(''):empty('No settlements recorded.',8)}</tbody></table></div>`);
  }catch(e){ b.innerHTML=errBox(e); }
}
L.editSettle=()=>form({title:'New settlement', fields:[{k:'gateway', label:'Gateway', value:'razorpay'},{k:'settlement_ref', label:'Settlement ID / UTR'},{k:'settlement_date', label:'Date', type:'date', value:today()},{k:'bank_account_id', label:'Paid into', type:'select', options:bankOpts()},{k:'gross', label:'Gross collected', type:'number', step:'0.01'},{k:'fee', label:'Gateway fee', type:'number', step:'0.01'},{k:'tax_on_fee', label:'GST on fee', type:'number', step:'0.01'},{k:'net', label:'Net (blank = gross − fee − GST)', type:'number', step:'0.01'}],
  onSave:async f=>{ await post('settlements', f); toast('Saved'); subsSettle(body('tabSubscriptions')); }});
L.importSettle=()=>form({title:'Import settlements CSV', fields:[{k:'gateway', label:'Gateway', value:'razorpay'},{k:'bank_account_id', label:'Paid into', type:'select', options:bankOpts()},{k:'csv', label:'Paste CSV (header row: settlement id, date, amount/gross, fee, tax, net)', type:'textarea', rows:8, full:true}],
  onSave:async f=>{ const r=await post('settlements/import', f); toast(`Imported ${r.imported}${r.skipped?`, skipped ${r.skipped}`:''}`); subsSettle(body('tabSubscriptions')); }});
L.delSettle=async id=>{ if(!confirm('Delete this settlement?')) return; await act(()=>post('settlements/delete', {id}), 'Deleted'); subsSettle(body('tabSubscriptions')); };
function bankOpts(){ return [['','— Select —'], ...(L.meta?.accounts||[]).filter(a=>a.bank_account_id).map(a=>[a.bank_account_id, a.name])]; }

/* ── 🧾 Tax ── */
async function renderTax(root){
  await loadMeta();
  subnav(root, 'tax', [['gstr1','📤 GSTR-1'],['gstr3b','🧾 GSTR-3B'],['purchases','📥 Purchase Tax & ITC'],['tds','🏛️ TDS'],['einv','🔏 E-invoice'],['fx','💱 FX Rates']], (k,b)=>({gstr1:taxGstr1, gstr3b:taxGstr3b, purchases:taxPurchases, tds:taxTds, einv:taxEinv, fx:taxFx})[k](b));
}
const monthInput=id=>`<input class="s-input" type="month" id="${id}" value="${today().slice(0,7)}" style="width:auto">`;
function gTable(title, rows, cols){
  if(!rows.length) return '';
  return `<div class="card-title" style="margin-top:14px">${title} (${rows.length})</div><div class="tbl-wrap"><table><thead><tr>${cols.map(([,h,n])=>`<th class="${n?'num':''}">${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${cols.map(([k,,n])=>n?numCell(r[k]):`<td>${esc(r[k]??'')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
async function taxGstr1(b){
  b.innerHTML=card('GSTR-1 — outward supplies', `${monthInput('accG1M')}<button class="save-btn sec" onclick="AccLedger.runG1()">Run</button><button class="save-btn sec" onclick="AccLedger.exportG1()">⬇ Excel</button>`, '<div id="accG1Out"></div>');
  L.runG1();
}
L.runG1=async()=>{
  const out=document.getElementById('accG1Out'); out.innerHTML=spinner;
  try{
    const d=L.g1=await api(`gstr1?month=${val('accG1M')}`);
    const inv=[['invoice_no','Invoice'],['date','Date'],['customer','Customer'],['gstin','GSTIN'],['pos','POS'],['rate','Rate'],['taxable','Taxable',1],['igst','IGST',1],['cgst','CGST',1],['sgst','SGST',1],['value','Value',1]];
    out.innerHTML=`${d.warnings.length?`<div class="acc-warn">${d.warnings.map(w=>'⚠️ '+esc(w)).join('<br>')}</div>`:''}
      <div class="stat-grid"><div class="stat-card"><div class="stat-lbl">Taxable value</div><div class="stat-val">${money(d.totals.taxable)}</div></div><div class="stat-card"><div class="stat-lbl">IGST</div><div class="stat-val">${money(d.totals.igst)}</div></div><div class="stat-card"><div class="stat-lbl">CGST + SGST</div><div class="stat-val">${money(d.totals.cgst+d.totals.sgst)}</div></div><div class="stat-card"><div class="stat-lbl">Credit notes</div><div class="stat-val">${money(d.totals.credit_notes)}</div></div></div>
      ${gTable('B2B invoices (4A)', d.b2b, inv)}${gTable('B2C large (5A)', d.b2cl, inv)}${gTable('B2C small (7)', d.b2cs, [['type','Type'],['pos','POS'],['rate','Rate'],['taxable','Taxable',1],['igst','IGST',1],['cgst','CGST',1],['sgst','SGST',1]])}
      ${gTable('Exports (6A)', d.exports, [...inv.slice(0,3),['export_type','Type'],['lut','LUT'],['taxable','Taxable',1],['igst','IGST',1]])}
      ${gTable('Credit notes — registered (9B)', d.cdnr, [['note_no','Note'],['date','Date'],['party','Party'],['gstin','GSTIN'],['against','Against'],['taxable','Taxable',1],['igst','IGST',1],['cgst','CGST',1],['sgst','SGST',1]])}${gTable('Credit notes — unregistered (9B)', d.cdnur, [['note_no','Note'],['date','Date'],['party','Party'],['taxable','Taxable',1],['igst','IGST',1],['cgst','CGST',1],['sgst','SGST',1]])}
      ${gTable('HSN / SAC summary (12)', d.hsn, [['hsn','HSN/SAC'],['description','Description'],['qty','Qty'],['taxable','Taxable',1],['igst','IGST',1],['cgst','CGST',1],['sgst','SGST',1]])}
      <div class="card-title" style="margin-top:14px">Documents issued (13)</div><div>${d.docs.total} invoices ${d.docs.from?`(${esc(d.docs.from)} → ${esc(d.docs.to)})`:''}, ${d.docs.cancelled} cancelled</div>
      <div class="s-hint">Working paper for the GST portal or your GSP — check it against your books before filing.</div>`;
  }catch(e){ out.innerHTML=errBox(e); }
};
L.exportG1=()=>{ const d=L.g1; if(!d) return; const sh=(rows, cols)=>[cols.map(c=>c[1]), ...rows.map(r=>cols.map(c=>r[c[0]]))];
  const inv=[['invoice_no','Invoice'],['date','Date'],['customer','Customer'],['gstin','GSTIN'],['pos','POS'],['rate','Rate'],['taxable','Taxable'],['igst','IGST'],['cgst','CGST'],['sgst','SGST'],['value','Value']];
  exportXlsx(`GSTR1_${d.month}.xlsx`, {b2b:sh(d.b2b,inv), b2cl:sh(d.b2cl,inv), b2cs:sh(d.b2cs,[['type','Type'],['pos','POS'],['rate','Rate'],['taxable','Taxable'],['igst','IGST'],['cgst','CGST'],['sgst','SGST']]), exp:sh(d.exports,[...inv,['export_type','Type'],['lut','LUT']]), cdnr:sh(d.cdnr,[['note_no','Note'],['date','Date'],['party','Party'],['gstin','GSTIN'],['against','Against'],['taxable','Taxable'],['igst','IGST'],['cgst','CGST'],['sgst','SGST']]), hsn:sh(d.hsn,[['hsn','HSN'],['description','Description'],['qty','Qty'],['taxable','Taxable'],['igst','IGST'],['cgst','CGST'],['sgst','SGST']])}); };
async function taxGstr3b(b){
  b.innerHTML=card('GSTR-3B — summary return', `${monthInput('accG3M')}<button class="save-btn sec" onclick="AccLedger.runG3()">Run</button>`, '<div id="accG3Out"></div>');
  L.runG3();
}
L.runG3=async()=>{
  const out=document.getElementById('accG3Out'); out.innerHTML=spinner;
  try{
    const d=await api(`gstr3b?month=${val('accG3M')}`);
    const row=(l,x,t)=>`<tr><td>${l}</td>${numCell(t??x.taxable??'')}${numCell(x.igst)}${numCell(x.cgst)}${numCell(x.sgst)}</tr>`;
    out.innerHTML=`<div class="tbl-wrap"><table class="acc-fin"><thead><tr><th></th><th class="num">Taxable</th><th class="num">IGST</th><th class="num">CGST</th><th class="num">SGST</th></tr></thead><tbody>
      <tr class="acc-sec"><td colspan="5">3.1 Outward supplies</td></tr>${row('(a) Taxable (net of credit notes)', d.outward_taxable)}${row('(b) Zero-rated (exports)', {...d.zero_rated, cgst:0, sgst:0})}${row('(c) Nil-rated / exempt', {igst:0,cgst:0,sgst:0}, d.nil_rated.taxable)}${row('(d) Inward supplies on reverse charge', d.inward_rcm, '')}
      <tr class="acc-sec"><td colspan="5">4 Input tax credit</td></tr>${row('ITC on reverse charge', d.itc_available.rcm, '')}${row('All other ITC', d.itc_available.other, '')}${row('Net ITC available', d.itc_available.total, '')}${row('Ineligible ITC', d.itc_ineligible, '')}
      <tr class="acc-sec"><td colspan="5">6 Payment</td></tr>${row('Tax liability', d.tax_liability, '')}${row('Paid in cash', d.cash_payable, '')}${row('Credit carried forward', d.credit_carried_forward, '')}
      <tr class="acc-total"><td>Total cash payable</td><td></td><td colspan="3" class="num">${money(d.total_cash_payable)}</td></tr></tbody></table></div>
      <div class="s-hint">ITC comes from the GST you enter on bills and expenses (Purchase Tax & ITC) plus GST on gateway fees. Set-off order: IGST credit → IGST, CGST, SGST; CGST → CGST, IGST; SGST → SGST, IGST.</div>`;
  }catch(e){ out.innerHTML=errBox(e); }
};
async function taxPurchases(b){
  b.innerHTML=card('Purchase tax register — GST input credit, reverse charge, TDS', `${dateRangeInputs('accPr', today().slice(0,8)+'01', today())}<label class="acc-check"><input type="checkbox" id="accPrMissing"> Only without tax details</label><button class="save-btn sec" onclick="AccLedger.runPurch()">Run</button>`, '<div id="accPrOut"></div>');
  L.runPurch();
}
L.runPurch=async()=>{
  const out=document.getElementById('accPrOut'); out.innerHTML=spinner;
  try{
    const d=await api(`purchase-register?${qs({from:val('accPrFrom'), to:val('accPrTo')})}`); L.purch=d.rows;
    const rows=document.getElementById('accPrMissing').checked?d.rows.filter(r=>!r.has_meta):d.rows;
    out.innerHTML=`<div class="stat-grid"><div class="stat-card"><div class="stat-lbl">Input credit (ITC)</div><div class="stat-val">${money(d.totals.itc)}</div></div><div class="stat-card"><div class="stat-lbl">IGST / CGST / SGST</div><div class="stat-val" style="font-size:16px">${m0(d.totals.igst)} / ${m0(d.totals.cgst)} / ${m0(d.totals.sgst)}</div></div><div class="stat-card"><div class="stat-lbl">TDS withheld</div><div class="stat-val">${money(d.totals.tds)}</div></div></div>
      <div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Supplier</th><th>Ref</th><th class="num">Amount</th><th class="num">GST</th><th>ITC</th><th>TDS</th><th>Account</th><th></th></tr></thead><tbody>
      ${rows.length?rows.map((r,i)=>{ const m=r.meta||{}; const g=(m.cgst||0)+(m.sgst||0)+(m.igst||0); return `<tr><td>${r.date}</td><td>${r.source_type==='vendor_bill'?'Bill':'Expense'} #${r.source_id}${r.approval&&r.approval!=='approved'?' '+statusBadge(r.approval):''}</td><td>${esc(r.party)}</td><td>${esc(r.reference)}</td>${numCell(r.amount)}${numCell(g||'')}<td>${r.meta?(m.reverse_charge?'RCM':m.itc_eligible?'✓':'✗'):'—'}</td><td>${m.tds_amount?`${esc(m.tds_section||'')} ${m0(m.tds_amount)}`:'—'}</td><td class="acc-small">${m.expense_account_id?esc(accName(m.expense_account_id)):'auto'}</td><td>${can('accountant')?`<button class="icon-btn" onclick="AccLedger.editPurch(${L.purch.indexOf(r)})">${r.meta?'✏️':'+ Tax'}</button>`:''}</td></tr>`; }).join(''):empty('No bills or expenses in this range.',10)}</tbody></table></div>`;
  }catch(e){ out.innerHTML=errBox(e); }
};
L.editPurch=i=>{ const r=L.purch[i], m=r.meta||{};
  form({title:`Tax details — ${r.source_type==='vendor_bill'?'Bill':'Expense'} #${r.source_id} (${r.party})`, fields:[
    {k:'expense_account_id', label:'Expense account (override)', type:'account', value:m.expense_account_id, filter:a=>a.type==='expense'||a.subtype==='fixed'||a.subtype==='current'},
    {k:'gst_rate_pct', label:'GST rate %', type:'number', value:m.gst_rate_pct||'', hint:`Amount ${m0(r.amount)} is treated as GST-inclusive; GST is backed out automatically`},
    {k:'supplier_state', label:'Supplier state code', placeholder:'e.g. 27 (blank = IGST)'},
    {k:'igst', label:'…or exact IGST', type:'number', step:'0.01', value:m.igst||''},{k:'cgst', label:'CGST', type:'number', step:'0.01', value:m.cgst||''},{k:'sgst', label:'SGST', type:'number', step:'0.01', value:m.sgst||''},
    {k:'itc_eligible', label:'Input credit', type:'checkbox', text:'ITC eligible', value:r.meta?!!m.itc_eligible:true},{k:'reverse_charge', label:'Reverse charge', type:'checkbox', text:'Supplier did not charge GST (RCM)', value:!!m.reverse_charge},
    {k:'supplier_gstin', label:'Supplier GSTIN', value:m.supplier_gstin},{k:'supplier_pan', label:'Supplier PAN (for TDS)', value:m.supplier_pan},{k:'hsn_sac', label:'HSN / SAC', value:m.hsn_sac},
    {k:'tds_section', label:'TDS section', type:'select', value:m.tds_section||'', options:[['','No TDS'],['194C','194C — Contractors'],['194J','194J — Professional / technical'],['194H','194H — Commission'],['194I','194I — Rent'],['194Q','194Q — Purchase of goods'],['194O','194O — E-commerce']]},
    {k:'tds_rate', label:'TDS rate %', type:'number', value:m.tds_rate||''},{k:'tds_amount', label:'…or exact TDS amount', type:'number', step:'0.01', value:m.tds_amount||''},{k:'branch', label:'Branch / cost centre', value:m.branch}],
    onSave:async f=>{ await post('purchase-meta', {...f, source_type:r.source_type, source_id:r.source_id}); toast('Saved'); L.runPurch(); }});
};
async function taxTds(b){
  try{
    const d=await api('tds'); L.tds=d;
    b.innerHTML=card('TDS summary by quarter', `${can('accountant')?'<button class="save-btn" onclick="AccLedger.newChallan()">+ Challan paid</button>':''}<button class="save-btn sec" onclick="AccLedger.export26q()">⬇ Deductions CSV (26Q / 24Q working)</button>`, `<div class="tbl-wrap"><table><thead><tr><th>Quarter</th><th>Section</th><th class="num">Deducted</th><th class="num">Deposited</th><th class="num">Pending</th></tr></thead><tbody>${d.summary.length?d.summary.map(q=>`<tr><td>${esc(q.quarter)}</td><td>${esc(q.section)}</td>${numCell(q.deducted)}${numCell(q.deposited)}${numCell(q.pending, q.pending>0?'neg':'')}</tr>`).join(''):empty('No TDS deducted yet — add TDS on bills/expenses under Purchase Tax & ITC, or in payroll.',5)}</tbody></table></div>`)
      +card('Deductions', '', `<div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Deductee</th><th>PAN</th><th>Section</th><th class="num">Paid</th><th class="num">TDS</th><th>Source</th></tr></thead><tbody>${d.deductions.slice(0,200).map(x=>`<tr><td>${x.date}</td><td>${esc(x.deductee)}</td><td>${esc(x.pan)}</td><td>${esc(x.section)}</td>${numCell(x.amount_paid)}${numCell(x.tds)}<td>${esc(x.source)}</td></tr>`).join('')||empty('None.',7)}</tbody></table></div>`)
      +card('Challans', '', `<div class="tbl-wrap"><table><thead><tr><th>Paid</th><th>Section</th><th>Quarter</th><th>Challan</th><th class="num">Tax</th><th class="num">Interest</th><th></th></tr></thead><tbody>${d.challans.map(c=>`<tr><td>${c.paid_date}</td><td>${esc(c.section||'')}</td><td>${esc(c.quarter||'')}</td><td>${esc(c.challan_no||'')} ${esc(c.bsr_code||'')}</td>${numCell(c.amount)}${numCell(c.interest)}<td>${can('accountant')?`<button class="icon-btn danger" onclick="AccLedger.delTds('challan',${c.id})">🗑</button>`:''}</td></tr>`).join('')||empty('None.',7)}</tbody></table></div>`)
      +card('TDS deducted by your customers (receivable)', `${can('accountant')?'<button class="save-btn" onclick="AccLedger.newTdsRec()">+ Record</button>':''}<button class="save-btn sec" onclick="AccLedger.recon26as()">Match with 26AS</button>`, `<div class="s-hint" style="margin-bottom:8px">When a client pays you less because they withheld TDS, record it here — it moves from what they owe you to TDS Receivable (claimable in your income-tax return). Total: <b>${money(d.receivable_total)}</b></div><div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Customer</th><th>TAN</th><th>Section</th><th>Invoice</th><th class="num">TDS</th><th>Form 16A</th><th></th></tr></thead><tbody>${d.receivable.map(t=>`<tr><td>${t.entry_date}</td><td>${esc(t.party_name||'')}</td><td>${esc(t.tan||'')}</td><td>${esc(t.section||'')}</td><td>${t.linked_invoice_id?'#'+t.linked_invoice_id:'—'}</td>${numCell(t.amount)}<td>${esc(t.certificate_no||'')}</td><td>${can('accountant')?`<button class="icon-btn danger" onclick="AccLedger.delTds('receivable',${t.id})">🗑</button>`:''}</td></tr>`).join('')||empty('None.',8)}</tbody></table></div><div id="acc26asOut"></div>`);
  }catch(e){ b.innerHTML=errBox(e); }
}
L.newChallan=()=>form({title:'TDS challan paid', fields:[{k:'paid_date', label:'Paid on', type:'date', value:today()},{k:'section', label:'Section', placeholder:'194J'},{k:'quarter', label:'Quarter (blank = from date)'},{k:'amount', label:'Tax', type:'number', step:'0.01'},{k:'interest', label:'Interest / late fee', type:'number', step:'0.01'},{k:'challan_no', label:'Challan serial no.'},{k:'bsr_code', label:'BSR code'},{k:'bank_account_id', label:'Paid from', type:'select', options:bankOpts()}],
  onSave:async f=>{ await post('tds/challan', f); toast('Challan saved'); taxTds(body('tabTax')); }});
L.newTdsRec=()=>form({title:'TDS deducted by a customer', fields:[{k:'linked_invoice_id', label:'Against invoice', type:'select', options:[['','— None —'], ...docs().filter(d=>d.type==='invoice').map(d=>[d.Id||d.id, `#${d.Id||d.id} · ${d.customer_name||''} · ${d.total}`])]},{k:'party_name', label:'Customer (if no invoice)'},{k:'entry_date', label:'Date', type:'date', value:today()},{k:'tan', label:'Customer TAN'},{k:'section', label:'Section', placeholder:'194J'},{k:'base_amount', label:'Amount TDS was deducted on', type:'number'},{k:'amount', label:'TDS amount', type:'number', step:'0.01'},{k:'offset_account_id', label:'Adjust against (blank = invoice receivable)', type:'account', filter:a=>a.type==='asset'},{k:'certificate_no', label:'Form 16A no.'}],
  onSave:async f=>{ await post('tds/receivable', f); toast('Recorded'); taxTds(body('tabTax')); }});
L.delTds=async(kind,id)=>{ if(!confirm('Delete?')) return; await act(()=>post('tds/delete', {kind, id}), 'Deleted'); taxTds(body('tabTax')); };
L.export26q=()=>{ const d=L.tds; if(!d) return; download('tds-deductions.csv', toCsv([['Quarter','Date','Deductee','PAN','Section','Amount paid','Rate','TDS','Source'], ...d.deductions.map(x=>[x.quarter,x.date,x.deductee,x.pan,x.section,x.amount_paid,x.rate,x.tds,x.source])]), 'text/csv'); };
L.recon26as=()=>form({title:'Match TDS receivable with Form 26AS / AIS', fields:[{k:'csv', label:'Paste 26AS Part A rows (CSV with a header: deductor name, TAN, amount, TDS)', type:'textarea', rows:8, full:true}], submit:'Match',
  onSave:async f=>{ const r=await post('tds/26as', f); document.getElementById('acc26asOut').innerHTML=`<div class="card-title" style="margin-top:14px">26AS match — ${r.rows.length-r.unmatched_in_26as}/${r.rows.length} matched · 26AS ${m0(r.total_26as)} vs books ${m0(r.total_books)}</div><div class="tbl-wrap"><table><thead><tr><th>Deductor</th><th>TAN</th><th class="num">TDS</th><th>In books?</th></tr></thead><tbody>${r.rows.map(x=>`<tr><td>${esc(x.deductor)}</td><td>${esc(x.tan)}</td>${numCell(x.tds)}<td>${x.matched?'✓':'<span class="badge void">missing</span>'}</td></tr>`).join('')}</tbody></table></div>${r.unmatched_in_books.length?`<div class="acc-warn">In books but not in 26AS: ${r.unmatched_in_books.map(x=>`${esc(x.party||'')} ${m0(x.amount)}`).join(', ')}</div>`:''}`; }});
async function taxEinv(b){
  const invs=docs().filter(d=>d.type==='invoice');
  b.innerHTML=card('E-invoice (IRP)', `<select class="s-input" id="accEiInv" style="width:320px">${invs.map(d=>`<option value="${d.Id||d.id}">#${d.Id||d.id} · ${esc(d.customer_name||'')} · ${esc(d.currency||'')} ${d.total}</option>`).join('')}</select><button class="save-btn sec" onclick="AccLedger.runEinv()">Prepare</button>`, `<div id="accEiOut">${invs.length?'':'<div class="empty-state">No invoices yet.</div>'}</div>`);
}
L.runEinv=async()=>{
  const out=document.getElementById('accEiOut'); out.innerHTML=spinner; const id=val('accEiInv');
  try{
    const d=L.ei=await api(`einvoice?invoice_id=${id}`);
    out.innerHTML=`${d.missing.length?`<div class="acc-warn">Before uploading: ${d.missing.map(esc).join(' · ')}</div>`:''}<div class="s-hint">${esc(d.note)}</div>
      <div class="modal-actions" style="justify-content:flex-start"><button class="save-btn sec" onclick="AccLedger.download('einvoice_INV-${id}.json', JSON.stringify([AccLedger.ei.json], null, 2), 'application/json')">⬇ Download JSON</button></div>
      <pre class="acc-pre">${esc(JSON.stringify(d.json, null, 2))}</pre>
      ${can('accountant')?`<div class="modal-grid"><div><label class="s-lbl">IRN</label><input class="s-input" id="accEiIrn" value="${escAttr(d.meta.irn||'')}"></div><div><label class="s-lbl">Ack no.</label><input class="s-input" id="accEiAck" value="${escAttr(d.meta.ack_no||'')}"></div><div><label class="s-lbl">Ack date</label><input class="s-input" id="accEiAckDt" value="${escAttr(d.meta.ack_date||'')}"></div><div><label class="s-lbl">E-way bill no.</label><input class="s-input" id="accEiEway" value="${escAttr(d.meta.eway_bill_no||'')}"></div><div style="grid-column:1/-1"><label class="s-lbl">Signed QR code</label><textarea class="s-input" id="accEiQr" rows="2">${esc(d.meta.signed_qr||'')}</textarea></div></div><button class="save-btn" onclick="AccLedger.saveEinv(${id})">Save IRN details</button>`:''}`;
  }catch(e){ out.innerHTML=errBox(e); }
};
L.saveEinv=id=>act(()=>post('einvoice', {invoice_id:id, irn:val('accEiIrn'), ack_no:val('accEiAck'), ack_date:val('accEiAckDt'), eway_bill_no:val('accEiEway'), signed_qr:val('accEiQr')}), 'IRN saved');
async function taxFx(b){
  try{
    const [d, r]=await Promise.all([api('fx'), api('fx/revaluation')]);
    b.innerHTML=card(`Exchange rates → ${esc(d.base_currency)}`, can('accountant')?'<button class="save-btn" onclick="AccLedger.newFx()">+ Rate</button>':'', `${d.missing.length?`<div class="acc-warn">No rate yet for ${d.missing.map(esc).join(', ')} — those documents are posted at 1:1 until you add one.</div>`:''}<div class="s-hint" style="margin-bottom:8px">Documents post at the latest rate on or before their date. Receipts and bill payments at a different rate book a realised FX gain/loss automatically.</div>
      <div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Currency</th><th class="num">1 unit = ${esc(d.base_currency)}</th><th></th></tr></thead><tbody>${d.rates.length?d.rates.map(x=>`<tr><td>${x.rate_date}</td><td>${esc(x.currency)}</td><td class="num">${x.rate}</td><td>${can('accountant')?`<button class="icon-btn danger" onclick="AccLedger.delFx(${x.id})">🗑</button>`:''}</td></tr>`).join(''):empty('No rates.',4)}</tbody></table></div>`)
      +card('Unrealised FX on open invoices & bills', `<span class="acc-muted">Net ${money(r.net_gain_loss)}</span>`, `<div class="tbl-wrap"><table><thead><tr><th>Item</th><th>Party</th><th>Currency</th><th class="num">Open</th><th class="num">Booked rate</th><th class="num">Today</th><th class="num">Gain / (loss)</th></tr></thead><tbody>${r.rows.length?r.rows.map(x=>`<tr><td>${esc(x.ref)}</td><td>${esc(x.party||'')}</td><td>${esc(x.currency)}</td>${numCell(x.open)}<td class="num">${x.booked_rate}</td><td class="num">${x.current_rate}</td>${numCell(x.gain_loss)}</tr>`).join(''):empty('No open foreign-currency items.',7)}</tbody></table></div><div class="s-hint">Report only — post a manual journal against Foreign Exchange Gain / Loss if you want it booked at period end.</div>`);
  }catch(e){ b.innerHTML=errBox(e); }
}
L.newFx=()=>form({title:'Exchange rate', fields:[{k:'currency', label:'Currency', placeholder:'USD'},{k:'rate_date', label:'Date', type:'date', value:today()},{k:'rate', label:`Value of 1 unit in ${L.meta?.settings?.base_currency||'INR'}`, type:'number', step:'0.0001'}], onSave:async f=>{ await post('fx', f); toast('Rate saved'); taxFx(body('tabTax')); }});
L.delFx=async id=>{ await act(()=>post('fx/delete', {id}), 'Deleted'); taxFx(body('tabTax')); };

/* ── ⚙️ Operations ── */
async function renderOps(root){
  await loadMeta();
  L.opsShow=subnav(root, 'ops', [['settings','⚙️ Settings'],['recurring','🔁 Recurring Journals'],['bank','🏦 Bank Feed Rules'],['approvals','✅ Approvals'],['assets','🖥️ Fixed Assets'],['payroll','👩‍💼 Payroll'],['budget','🎯 Budgets'],['links','🔗 Payment Links & Portal'],['allocations','🎯 Cost Allocation'],['ai','🤖 AI Categorise'],['exports','⬇ Exports'],['roles','👥 Roles']],
    (k,b)=>({settings:opsSettings, recurring:opsRecurring, bank:opsBank, approvals:opsApprovals, assets:opsAssets, payroll:opsPayroll, budget:opsBudget, links:opsLinks, allocations:opsAlloc, ai:opsAi, exports:opsExports, roles:opsRoles})[k](b));
}
L.openOps=k=>{ showTab('ops'); setTimeout(()=>{ const b=document.querySelector(`#tabOps .fp-pill[data-k="${k}"]`); if(b) b.click(); }, 50); };
async function opsSettings(b){
  await loadMeta(true); const s=L.meta.settings;
  const f=(k,l,v,t='text',extra='')=>`<div><label class="s-lbl">${l}</label><input class="s-input" id="accS_${k}" type="${t}" value="${escAttr(v??'')}" ${extra}></div>`;
  b.innerHTML=card('Ledger settings', '', `<div class="modal-grid">
    ${f('business_name','Legal business name',s.business_name)}${f('base_currency','Base (reporting) currency',s.base_currency)}
    <div><label class="s-lbl">Financial year starts</label><select class="s-input" id="accS_fy_start_month">${['January','February','March','April','May','June','July','August','September','October','November','December'].map((m,i)=>`<option value="${i+1}" ${s.fy_start_month==i+1?'selected':''}>${m}</option>`).join('')}</select></div>
    ${f('payment_terms_days','Default payment terms (days)',s.payment_terms_days,'number')}
    <div><label class="s-lbl">Default "paid from" account</label><select class="s-input" id="accS_default_payment_account_id">${accountOptions(s.default_payment_account_id, cashAccounts)}</select><div class="s-hint">Used for expenses and bill payments with no bank account picked (default: Cash in Hand)</div></div>
    <div><label class="s-lbl">New chart template</label><select class="s-input" id="accS_coa_template"><option value="both" ${s.coa_template==='both'?'selected':''}>Agency + SaaS</option><option value="agency" ${s.coa_template==='agency'?'selected':''}>Marketing agency</option><option value="saas" ${s.coa_template==='saas'?'selected':''}>SaaS</option></select></div>
    ${f('gstin','GSTIN',s.gstin)}${f('state_code','GST state code',s.state_code,'text','placeholder="e.g. 32"')}${f('pan','PAN',s.pan)}${f('tan','TAN (for TDS)',s.tan)}
    ${f('lut_number','LUT number (exports without IGST)',s.lut_number)}${f('lut_valid_till','LUT valid till',s.lut_valid_till,'date')}${f('upi_id','UPI ID (on reminders & portal)',s.upi_id)}${f('upi_name','UPI payee name',s.upi_name)}
    <div><label class="acc-check"><input type="checkbox" id="accS_expense_approval_required" ${s.expense_approval_required?'checked':''}> Expenses need approval before they post</label><label class="acc-check"><input type="checkbox" id="accS_email_invoices" ${s.email_invoices?'checked':''}> Email subscription invoices automatically</label></div>
    </div>${can('admin')?'<div class="modal-actions"><button class="save-btn" onclick="AccLedger.saveSettings()">Save settings</button></div>':''}<div class="s-hint">Your role: <b>${esc(L.meta.role)}</b>. Changing the base currency re-posts every open-period entry at the new currency's exchange rates.</div>`);
}
L.saveSettings=async()=>{
  const g=k=>document.getElementById('accS_'+k); const body={};
  for(const k of ['business_name','base_currency','fy_start_month','payment_terms_days','default_payment_account_id','coa_template','gstin','state_code','pan','tan','lut_number','lut_valid_till','upi_id','upi_name']) body[k]=g(k).value;
  body.expense_approval_required=g('expense_approval_required').checked; body.email_invoices=g('email_invoices').checked;
  await act(()=>post('settings', body), 'Settings saved'); await loadMeta(true);
};
async function opsRecurring(b){
  try{ const {list}=await api('recurring'); L.rec=list;
    b.innerHTML=card('Recurring journals', can('accountant')?'<button class="save-btn sec" onclick="AccLedger.runRec()">▶ Post due now</button><button class="save-btn" onclick="AccLedger.editRec()">+ Template</button>':'', `<div class="s-hint" style="margin-bottom:8px">Rent, salaries, SaaS tools, loan EMIs, accruals — posted automatically every day they fall due.</div><div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Every</th><th>Next</th><th>Ends</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.length?list.map((r,i)=>{ const lines=JSON.parse(r.lines_json||'[]'); return `<tr class="${r.is_active?'':'acc-inactive'}"><td>${esc(r.name)}<div class="acc-small">${lines.map(l=>`${l.debit?'Dr':'Cr'} ${esc(accName(l.account_id))}`).join(' · ')}</div></td><td>${r.frequency}</td><td>${r.next_date}</td><td>${r.end_date||'—'}</td>${numCell(lines.reduce((s,l)=>s+(l.debit||0),0))}<td>${r.is_active?'Active':'Stopped'}</td><td class="row-actions">${can('accountant')?`<button class="icon-btn" onclick="AccLedger.editRec(${i})">✏️</button><button class="icon-btn danger" onclick="AccLedger.delRec(${r.id})">🗑</button>`:''}</td></tr>`; }).join(''):empty('No recurring journals.',7)}</tbody></table></div>`);
  }catch(e){ b.innerHTML=errBox(e); }
}
L.editRec=i=>{ const r=i!=null?L.rec[i]:{}; form({title:r.id?'Edit recurring journal':'New recurring journal', wide:true, fields:[{k:'name', label:'Name', value:r.name},{k:'frequency', label:'Every', type:'select', value:r.frequency||'month', options:[['week','Week'],['month','Month'],['quarter','Quarter'],['half_year','6 months'],['year','Year']]},{k:'next_date', label:'Next date', type:'date', value:r.next_date||today()},{k:'end_date', label:'End date (optional)', type:'date', value:r.end_date},{k:'memo', label:'Narration', value:r.memo},{k:'is_active', label:'Status', type:'checkbox', text:'Active', value:r.id?!!r.is_active:true}],
  extraHtml:linesEditor(r.lines_json?JSON.parse(r.lines_json):null), onSave:async f=>{ await post('recurring', {...f, id:r.id, lines:readLines()}); toast('Saved'); opsRecurring(body('tabOps')); }}); L.lineTotals(); };
L.delRec=async id=>{ if(!confirm('Delete this template? Entries already posted stay.')) return; await act(()=>post('recurring/delete', {id}), 'Deleted'); opsRecurring(body('tabOps')); };
L.runRec=async()=>{ const r=await act(()=>post('recurring/run')); if(r) toast(`Posted ${r.posted.filter(p=>!p.error).length} journal(s)`); opsRecurring(body('tabOps')); };
async function opsBank(b){
  try{ const [rules, un]=await Promise.all([api('bank-rules'), api('bank-unmatched')]); L.unmatched=un.list;
    b.innerHTML=card('Unmatched bank statement lines', can('accountant')?'<button class="save-btn" onclick="AccLedger.categorizeLines()">Post selected</button>':'', `<div class="s-hint" style="margin-bottom:8px">Lines from statements uploaded in Bank &amp; Cash → Reconciliation that didn't match a payment. Pick an account (rules and keywords pre-fill it) and post — each becomes a reconciled payment entry.</div>
      <div class="tbl-wrap"><table><thead><tr><th><input type="checkbox" onclick="document.querySelectorAll('.acc-bl-sel').forEach(c=>c.checked=this.checked)"></th><th>Date</th><th>Bank</th><th>Description</th><th class="num">Amount</th><th>Account</th><th>Remember</th></tr></thead><tbody>
      ${un.list.length?un.list.map((l,i)=>`<tr><td><input type="checkbox" class="acc-bl-sel" data-i="${i}" ${l.suggested_account_id?'checked':''}></td><td>${l.txn_date||''}</td><td>${esc(l.account_name||'')}</td><td>${esc(l.description||'')}${l.suggested_by?`<div class="acc-small">${esc(l.suggested_by)}</div>`:''}</td>${numCell(l.amount)}<td><select class="s-input acc-bl-acct" data-i="${i}" style="min-width:200px">${accountOptions(l.suggested_account_id, a=>!a.bank_account_id)}</select></td><td><input class="s-input acc-bl-rule" data-i="${i}" placeholder="rule text e.g. AWS" style="width:130px"></td></tr>`).join(''):empty('No unmatched lines. 🎉',7)}</tbody></table></div>`)
      +card('Matching rules', can('accountant')?'<button class="save-btn" onclick="AccLedger.editRule()">+ Rule</button>':'', `<div class="tbl-wrap"><table><thead><tr><th>If description contains</th><th>Direction</th><th>Post to</th><th>Party</th><th>Priority</th><th></th></tr></thead><tbody>${rules.list.length?rules.list.map(r=>`<tr><td><b>${esc(r.match_text)}</b></td><td>${r.direction}</td><td>${esc(r.account_name||'')}</td><td>${esc(r.party_name||'')}</td><td>${r.priority}</td><td>${can('accountant')?`<button class="icon-btn danger" onclick="AccLedger.delRule(${r.id})">🗑</button>`:''}</td></tr>`).join(''):empty('No rules yet.',6)}</tbody></table></div>`);
  }catch(e){ b.innerHTML=errBox(e); }
}
L.categorizeLines=async()=>{
  const items=[...document.querySelectorAll('.acc-bl-sel:checked')].map(c=>{ const i=c.dataset.i; const l=L.unmatched[i]; const rule=document.querySelector(`.acc-bl-rule[data-i="${i}"]`).value.trim();
    return {line_id:l.id, account_id:document.querySelector(`.acc-bl-acct[data-i="${i}"]`).value, party_name:l.party_name, create_rule:!!rule, rule_text:rule}; }).filter(x=>x.account_id);
  if(!items.length) return toast('Select lines and pick accounts', true);
  const r=await act(()=>post('bank-categorize', {items})); if(r) toast(`Posted ${r.categorized}${r.errors.length?`, ${r.errors.length} skipped`:''}`); opsBank(body('tabOps'));
};
L.editRule=()=>form({title:'New matching rule', fields:[{k:'match_text', label:'Description contains', placeholder:'e.g. GOOGLE ADS'},{k:'direction', label:'Direction', type:'select', options:[['any','Money in or out'],['out','Money out'],['in','Money in']]},{k:'account_id', label:'Post to account', type:'account'},{k:'party_name', label:'Party (optional)'},{k:'priority', label:'Priority (lower first)', type:'number', value:100}],
  onSave:async f=>{ await post('bank-rules', f); toast('Rule saved'); opsBank(body('tabOps')); }});
L.delRule=async id=>{ await act(()=>post('bank-rules/delete', {id}), 'Deleted'); opsBank(body('tabOps')); };
async function opsApprovals(b){
  try{ const {list}=await api('approvals?status=pending');
    b.innerHTML=card('Expenses waiting for approval', can('approver')&&list.length?'<button class="save-btn sec" onclick="AccLedger.decide(\'reject\')">Reject selected</button><button class="save-btn" onclick="AccLedger.decide(\'approve\')">Approve selected</button>':'', `${L.meta.settings.expense_approval_required?'':'<div class="acc-warn">Approval is switched off (Operations → Settings) — new expenses post straight away.</div>'}
      <div class="tbl-wrap"><table><thead><tr><th><input type="checkbox" onclick="document.querySelectorAll('.acc-ap-sel').forEach(c=>c.checked=this.checked)"></th><th>Date</th><th>Category</th><th>Vendor</th><th>Description</th><th class="num">Amount</th></tr></thead><tbody>${list.length?list.map(x=>`<tr><td><input type="checkbox" class="acc-ap-sel" value="${x.expense_id}"></td><td>${x.expense_date}</td><td>${esc(x.category||'')}</td><td>${esc(x.vendor||'')}</td><td>${esc(x.description||'')}</td>${numCell(x.amount)}</tr>`).join(''):empty('Nothing waiting.',6)}</tbody></table></div>`);
  }catch(e){ b.innerHTML=errBox(e); }
}
L.decide=async decision=>{ const ids=[...document.querySelectorAll('.acc-ap-sel:checked')].map(c=>Number(c.value)); if(!ids.length) return; const note=decision==='reject'?prompt('Reason for rejecting?'):''; if(note==null) return;
  await act(()=>post('approvals/decide', {expense_ids:ids, decision, note}), decision==='approve'?'Approved':'Rejected'); opsApprovals(body('tabOps')); };
async function opsAssets(b){
  try{ const {list}=await api('assets'); L.assets=list;
    b.innerHTML=card('Fixed asset register', can('accountant')?'<button class="save-btn" onclick="AccLedger.editAsset()">+ Asset</button>':'', `<div class="tbl-wrap"><table><thead><tr><th>Asset</th><th>Bought</th><th class="num">Cost</th><th>Method</th><th class="num">Depreciated</th><th class="num">Book value</th><th class="num">This month</th><th></th></tr></thead><tbody>
      ${list.length?list.map((a,i)=>`<tr><td>${esc(a.name)}<div class="acc-small">${esc(a.category||'')}${a.disposed_date?' · disposed '+a.disposed_date:''}</div></td><td>${a.purchase_date}</td>${numCell(a.cost)}<td>${a.method==='wdv'?`WDV ${a.wdv_rate_pct}%`:`SLM ${a.useful_life_months} mo`}</td>${numCell(a.accumulated_depreciation)}${numCell(a.book_value)}${numCell(a.monthly_depreciation)}<td class="row-actions">${can('accountant')?`<button class="icon-btn" onclick="AccLedger.editAsset(${i})">✏️</button><button class="icon-btn danger" onclick="AccLedger.delAsset(${a.id})">🗑</button>`:''}</td></tr>`).join(''):empty('No assets. Laptops, cameras, furniture, servers…',8)}</tbody></table></div><div class="s-hint">Purchase, monthly depreciation and disposal post to the ledger automatically.</div>`);
  }catch(e){ b.innerHTML=errBox(e); }
}
L.editAsset=i=>{ const a=i!=null?L.assets[i]:{}; form({title:a.id?'Edit asset':'New fixed asset', fields:[{k:'name', label:'Asset', value:a.name},{k:'category', label:'Category', value:a.category, placeholder:'Computers'},{k:'asset_account_id', label:'Asset account', type:'account', value:a.asset_account_id, filter:x=>x.subtype==='fixed'},{k:'purchase_date', label:'Purchase date', type:'date', value:a.purchase_date||today()},{k:'cost', label:'Cost (excl. GST claimed)', type:'number', step:'0.01', value:a.cost},{k:'salvage', label:'Residual value', type:'number', value:a.salvage||0},
  {k:'method', label:'Method', type:'select', value:a.method||'slm', options:[['slm','Straight line'],['wdv','Written-down value']]},{k:'useful_life_months', label:'Useful life (months, SLM)', type:'number', value:a.useful_life_months||36},{k:'wdv_rate_pct', label:'WDV rate % per year', type:'number', value:a.wdv_rate_pct||40},{k:'paid_from_account_id', label:'Paid from (blank = Accounts Payable)', type:'account', value:a.paid_from_account_id, filter:x=>x.type==='asset'||x.type==='liability'||x.type==='equity'},
  {k:'disposed_date', label:'Disposed on', type:'date', value:a.disposed_date},{k:'disposal_amount', label:'Sale proceeds', type:'number', value:a.disposal_amount||0},{k:'disposal_account_id', label:'Proceeds received in', type:'account', value:a.disposal_account_id, filter:cashAccounts}],
  onSave:async f=>{ await post('assets', {...f, id:a.id}); toast('Asset saved'); opsAssets(body('tabOps')); }}); };
L.delAsset=async id=>{ if(!confirm('Delete this asset and all its depreciation?')) return; await act(()=>post('assets/delete', {id}), 'Deleted'); opsAssets(body('tabOps')); };
async function opsPayroll(b){
  try{ const [e, p]=await Promise.all([api('employees'), api('payroll')]); L.emps=e.list; L.runs=p.list;
    b.innerHTML=card('Payroll runs', can('accountant')?'<button class="save-btn" onclick="AccLedger.prepPayroll()">+ Prepare month</button>':'', p.list.length?p.list.map(r=>`<div class="acc-journal"><div class="acc-j-head"><b>${r.period_month}</b> ${statusBadge(r.status)} <span class="acc-j-memo">Gross ${m0(r.gross)} · Net pay ${m0(r.net)} · Cost to company ${m0(r.employer_cost)}</span>
      <span class="row-actions">${can('accountant')?(r.status==='draft'?`<button class="icon-btn" onclick="AccLedger.prepPayroll('${r.period_month}')">Recalculate</button><button class="save-btn" onclick="AccLedger.payrollAct(${r.id},'post')">Post</button><button class="icon-btn danger" onclick="AccLedger.payrollAct(${r.id},'delete')">🗑</button>`:r.status==='posted'?`<button class="save-btn" onclick="AccLedger.payrollPay(${r.id})">Mark salaries paid</button><button class="icon-btn" onclick="AccLedger.payrollAct(${r.id},'unpost')">Unpost</button>`:`<span class="acc-small">paid ${r.paid_date}</span><button class="icon-btn" onclick="AccLedger.payrollAct(${r.id},'unpost')">Unpost</button>`):''}<button class="icon-btn" onclick="AccLedger.payslips(${r.id})">⬇ Register</button></span></div>
      <table class="acc-j-lines"><tr class="acc-small"><td>Employee</td><td class="num">Days</td><td class="num">Gross</td><td class="num">PF</td><td class="num">ESI</td><td class="num">PT</td><td class="num">TDS</td><td class="num">Net</td></tr>${r.lines.map(l=>`<tr><td>${esc(l.name)}</td><td class="num">${l.paid_days}/${l.month_days}</td>${numCell(l.gross)}${numCell(l.employee_pf)}${numCell(l.employee_esi)}${numCell(l.pt)}${numCell(l.tds)}${numCell(l.net)}</tr>`).join('')}</table></div>`).join(''):empty('No payroll yet.'))
      +card('Employees', can('accountant')?'<button class="save-btn" onclick="AccLedger.editEmp()">+ Employee</button>':'', `<div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Designation</th><th class="num">Basic</th><th class="num">HRA</th><th class="num">Other</th><th>PF / ESI</th><th class="num">PT</th><th class="num">TDS / mo</th><th></th></tr></thead><tbody>${e.list.length?e.list.map((x,i)=>`<tr class="${x.is_active?'':'acc-inactive'}"><td>${esc(x.name)}<div class="acc-small">${esc(x.pan||'')}</div></td><td>${esc(x.designation||'')}</td>${numCell(x.basic)}${numCell(x.hra)}${numCell(x.other_allowances)}<td>${x.pf_applicable?'PF':''} ${x.esi_applicable?'ESI':''}</td>${numCell(x.pt_monthly)}${numCell(x.tds_monthly)}<td>${can('accountant')?`<button class="icon-btn" onclick="AccLedger.editEmp(${i})">✏️</button>`:''}</td></tr>`).join(''):empty('No employees.',9)}</tbody></table></div><div class="s-hint">PF ${L.meta.defaults.payroll.pf_rate}% of basic (capped at ${m0(L.meta.defaults.payroll.pf_wage_cap)}) from both sides, ESI 0.75% + 3.25% when gross ≤ ${m0(L.meta.defaults.payroll.esi_wage_limit)}. Posting books salary expense, employer contributions and the PF/ESI/PT/TDS liabilities; TDS shows in Tax → TDS under 192.</div>`);
  }catch(e){ b.innerHTML=errBox(e); }
}
L.editEmp=i=>{ const x=i!=null?L.emps[i]:{}; form({title:x.id?'Edit employee':'New employee', fields:[{k:'name', label:'Name', value:x.name},{k:'email', label:'Email', value:x.email},{k:'pan', label:'PAN', value:x.pan},{k:'uan', label:'UAN', value:x.uan},{k:'designation', label:'Designation', value:x.designation},{k:'department', label:'Department', value:x.department},{k:'basic', label:'Basic / month', type:'number', value:x.basic},{k:'hra', label:'HRA / month', type:'number', value:x.hra},{k:'other_allowances', label:'Other allowances / month', type:'number', value:x.other_allowances},{k:'pt_monthly', label:'Professional tax / month', type:'number', value:x.pt_monthly??200},{k:'tds_monthly', label:'TDS / month', type:'number', value:x.tds_monthly},{k:'joined_on', label:'Joined', type:'date', value:x.joined_on},{k:'pf_applicable', label:'PF', type:'checkbox', text:'PF applicable', value:x.id?!!x.pf_applicable:true},{k:'esi_applicable', label:'ESI', type:'checkbox', text:'ESI applicable', value:x.id?!!x.esi_applicable:true},{k:'is_active', label:'Status', type:'checkbox', text:'Active', value:x.id?!!x.is_active:true}],
  onSave:async f=>{ await post('employees', {...f, id:x.id}); toast('Saved'); opsPayroll(body('tabOps')); }}); };
L.prepPayroll=m=>{ const emps=(L.emps||[]).filter(e=>e.is_active);
  form({title:'Prepare payroll', wide:true, fields:[{k:'period_month', label:'Month', type:'month', value:m||today().slice(0,7)},{k:'run_date', label:'Posting date (blank = month end)', type:'date'}],
    extraHtml:`<div class="card-title">Adjustments (optional)</div><table><tr class="acc-small"><td>Employee</td><td>Paid days</td><td>Month days</td><td>Bonus</td><td>TDS override</td></tr>${emps.map(e=>`<tr class="acc-pay-ov" data-id="${e.id}"><td>${esc(e.name)}</td><td><input class="s-input" type="number" data-k="paid_days" style="width:80px"></td><td><input class="s-input" type="number" data-k="month_days" value="30" style="width:80px"></td><td><input class="s-input" type="number" data-k="bonus" style="width:100px"></td><td><input class="s-input" type="number" data-k="tds" style="width:100px"></td></tr>`).join('')}</table>`,
    submit:'Calculate', onSave:async f=>{ const overrides=[...document.querySelectorAll('.acc-pay-ov')].map(r=>{ const o={employee_id:Number(r.dataset.id)}; r.querySelectorAll('input').forEach(i=>{ if(i.value!=='') o[i.dataset.k]=i.value; }); return o; });
      const r=await post('payroll/prepare', {...f, overrides}); toast(`Net pay ${m0(r.net)} — review and Post`); opsPayroll(body('tabOps')); }}); };
L.payrollAct=async(id,action)=>{ if(action==='delete'&&!confirm('Delete this draft?')) return; await act(()=>post('payroll/action', {id, action}), 'Done'); opsPayroll(body('tabOps')); };
L.payrollPay=id=>form({title:'Mark salaries paid', fields:[{k:'paid_date', label:'Paid on', type:'date', value:today()},{k:'account_id', label:'Paid from', type:'account', filter:cashAccounts}], onSave:async f=>{ await post('payroll/action', {id, action:'pay', ...f}); toast('Marked paid'); opsPayroll(body('tabOps')); }});
L.payslips=id=>{ const r=L.runs.find(x=>x.id===id); exportXlsx(`payroll_${r.period_month}.xlsx`, {Register:[['Employee','PAN','Paid days','Basic','HRA','Other','Gross','Employee PF','Employer PF','Employee ESI','Employer ESI','PT','TDS','Net'], ...r.lines.map(l=>[l.name,l.pan,l.paid_days,l.basic,l.hra,l.other,l.gross,l.employee_pf,l.employer_pf,l.employee_esi,l.employer_esi,l.pt,l.tds,l.net])]}); };
async function opsBudget(b){
  const fy=Number(fyStart().slice(0,4));
  b.innerHTML=card('Budget vs actual', `<input class="s-input" type="number" id="accBudFy" value="${fy}" style="width:100px"><input class="s-input" id="accBudBranch" placeholder="Branch (optional)" style="width:150px"><button class="save-btn sec" onclick="AccLedger.runBudget()">Load</button>${can('accountant')?'<button class="save-btn sec" onclick="AccLedger.budgetFromActuals()">Seed from last year</button><button class="save-btn" onclick="AccLedger.saveBudget()">Save budget</button>':''}`, '<div id="accBudOut"></div>');
  L.runBudget();
}
L.runBudget=async()=>{
  const out=document.getElementById('accBudOut'); out.innerHTML=spinner;
  try{
    const d=L.bud=await api(`budget?${qs({fy:val('accBudFy'), branch:val('accBudBranch')})}`);
    const have=new Set(d.rows.map(r=>r.account_id));
    const extra=(L.meta.accounts||[]).filter(a=>(a.type==='income'||a.type==='expense') && !have.has(a.id)).map(a=>({account_id:a.id, code:a.code, name:a.name, type:a.type, budget:Array(12).fill(0), actual:Array(12).fill(0), budget_total:0, actual_total:0, variance:0}));
    const rows=[...d.rows, ...extra];
    out.innerHTML=`<div class="tbl-wrap"><table class="acc-budget"><thead><tr><th>Account</th>${d.months.map(m=>`<th class="num">${m.slice(2)}</th>`).join('')}<th class="num">Budget</th><th class="num">Actual</th><th class="num">Variance</th></tr></thead><tbody>
      ${rows.map(r=>`<tr data-acct="${r.account_id}"><td>${esc(r.code)} · ${esc(r.name)}</td>${r.budget.map((v,i)=>`<td><input class="acc-bud-in" type="number" value="${v||''}" title="Actual ${m0(r.actual[i])}" ${can('accountant')?'':'disabled'}><div class="acc-small">${r.actual[i]?m0(r.actual[i]):''}</div></td>`).join('')}${numCell(r.budget_total)}${numCell(r.actual_total)}${numCell(r.variance, r.variance<0?'neg':'')}</tr>`).join('')}</tbody></table></div><div class="s-hint">Small numbers under each cell are actuals. Variance is favourable when positive (more income or less spend than budgeted).</div>`;
  }catch(e){ out.innerHTML=errBox(e); }
};
L.saveBudget=async()=>{ const rows=[...document.querySelectorAll('.acc-budget tbody tr')].map(tr=>({account_id:Number(tr.dataset.acct), months:[...tr.querySelectorAll('.acc-bud-in')].map(i=>Number(i.value)||0)})).filter(r=>r.months.some(x=>x));
  await act(()=>post('budget', {fiscal_year:val('accBudFy'), branch:val('accBudBranch'), rows}), 'Budget saved'); L.runBudget(); };
L.budgetFromActuals=async()=>{ const g=prompt('Grow last year\'s actuals by what %?', '10'); if(g==null) return; await act(()=>post('budget/from-actuals', {fiscal_year:val('accBudFy'), branch:val('accBudBranch'), growth_pct:Number(g)||0}), 'Budget seeded'); L.runBudget(); };
async function opsLinks(b){
  try{ const [ar, tok]=await Promise.all([api('ar-aging'), api('portal-tokens')]);
    b.innerHTML=card('Collect online — open invoices', '', `<div class="s-hint" style="margin-bottom:8px">Payment links use your Razorpay keys (Financial Planning → Settings); when the customer pays, the invoice is marked paid automatically. The UPI link opens any UPI app with the amount filled in.</div>
      <div class="tbl-wrap"><table><thead><tr><th>Invoice</th><th>Customer</th><th>Due</th><th class="num">Balance</th><th></th></tr></thead><tbody>${ar.items.length?ar.items.map(i=>`<tr><td>#${i.invoice_id}</td><td>${esc(i.customer)}</td><td>${i.due_date}${i.overdue_days?` <span class="badge void">${i.overdue_days}d</span>`:''}</td>${numCell(i.balance)}<td class="row-actions">${can('accountant')?`<button class="icon-btn" onclick="AccLedger.payLink(${i.invoice_id})">💳 Payment link</button><button class="icon-btn" onclick="AccLedger.portalLink('${escAttr(i.customer).replace(/'/g,"\\'")}')">🔗 Portal</button>`:''}</td></tr>`).join(''):empty('No open invoices.',5)}</tbody></table></div>`)
      +card('Client portal links', '', `<div class="s-hint" style="margin-bottom:8px">Each customer gets a private page with their invoices, payments, credit notes and a statement — with pay buttons.</div><div class="tbl-wrap"><table><thead><tr><th>Customer</th><th>Created</th><th>Status</th><th></th></tr></thead><tbody>${tok.list.length?tok.list.map(t=>`<tr><td>${esc(t.customer_name)}</td><td>${String(t.created_at).slice(0,10)}</td><td>${t.revoked?'<span class="badge void">revoked</span>':'<span class="badge paid">active</span>'}</td><td class="row-actions">${t.revoked?'':`<button class="icon-btn" onclick="AccLedger.copy('${portalUrl(t.token)}')">Copy</button><a class="icon-btn" href="${portalUrl(t.token)}" target="_blank">Open</a>${can('accountant')?`<button class="icon-btn danger" onclick="AccLedger.revoke('${t.token}')">Revoke</button>`:''}`}</td></tr>`).join(''):empty('No portal links yet — create one from an invoice or a customer ledger.',4)}</tbody></table></div>`);
  }catch(e){ b.innerHTML=errBox(e); }
}
L.copy=async t=>{ try{ await navigator.clipboard.writeText(t); toast('Copied'); }catch(_){ prompt('Copy', t); } };
L.payLink=async id=>{ const r=await act(()=>post('payment-link', {invoice_id:id})); if(!r) return;
  const lines=[r.payment_link?.url?`Razorpay: ${r.payment_link.url}`:'Razorpay keys not set — add them in Financial Planning → Settings to create card/UPI payment links.', r.upi?`UPI: ${r.upi}`:'Add your UPI ID in Operations → Settings for a UPI link.'];
  form({title:`Collect Invoice #${id} — ${m0(r.balance)}`, fields:[{k:'links', label:'Share with the customer', type:'textarea', rows:5, value:lines.join('\n'), full:true}], submit:'Copy', onSave:async f=>{ await L.copy(f.links); }}); };
L.revoke=async t=>{ if(!confirm('Revoke this portal link?')) return; await act(()=>post('portal-tokens/revoke', {token:t}), 'Revoked'); opsLinks(body('tabOps')); };
async function opsAlloc(b){
  try{ const {list}=await api('allocations'); const exps=typeof allExpenses!=='undefined'?allExpenses:[]; const bills=typeof allVendorBills!=='undefined'?allVendorBills:[];
    L.allocSrc=[...bills.map(x=>['vendor_bill', x.Id||x.id, `Bill #${x.Id||x.id} · ${x.supplier} · ${x.total} (${x.bill_date})`]), ...exps.map(x=>['expense', x.Id||x.id, `Expense #${x.Id||x.id} · ${x.vendor||x.category||''} · ${x.amount} (${x.expense_date})`])];
    b.innerHTML=card('Direct cost allocation', can('accountant')?'<button class="save-btn" onclick="AccLedger.newAlloc()">+ Allocate a cost</button>':'', `<div class="s-hint" style="margin-bottom:8px">Assign freelancer bills, ad spend, hosting or payroll to the client they were for — Overview → Profitability by client uses this.</div><div class="tbl-wrap"><table><thead><tr><th>Cost</th><th>Client</th><th class="num">Share</th><th></th></tr></thead><tbody>${list.length?list.map(a=>`<tr><td>${esc((L.allocSrc.find(s=>s[0]===a.source_type&&String(s[1])===String(a.source_id))||[])[2]||`${a.source_type} #${a.source_id}`)}</td><td>${esc(a.customer_name)}</td><td class="num">${a.pct}%</td><td>${can('accountant')?`<button class="icon-btn danger" onclick="AccLedger.delAlloc(${a.id})">🗑</button>`:''}</td></tr>`).join(''):empty('Nothing allocated yet.',4)}</tbody></table></div>`);
  }catch(e){ b.innerHTML=errBox(e); }
}
L.newAlloc=()=>{ const custs=[...new Set([...docs().map(d=>d.customer_name), ...fpCust().map(c=>c.name)].filter(Boolean))];
  form({title:'Allocate a cost to a client', fields:[{k:'src', label:'Cost', type:'select', options:L.allocSrc.map(s=>[`${s[0]}:${s[1]}`, s[2]])},{k:'customer_name', label:'Client', type:'select', options:custs},{k:'pct', label:'Share %', type:'number', value:100}],
    onSave:async f=>{ const [source_type, source_id]=f.src.split(':'); await post('allocations', {source_type, source_id, customer_name:f.customer_name, pct:f.pct}); toast('Allocated'); opsAlloc(body('tabOps')); }}); };
L.delAlloc=async id=>{ await act(()=>post('allocations/delete', {id}), 'Removed'); opsAlloc(body('tabOps')); };
async function opsAi(b){
  try{ const d=await api('ai/categorize'); L.cat=d.list;
    b.innerHTML=card('Categorise expenses', can('accountant')&&d.list.length?'<button class="save-btn" onclick="AccLedger.applyCat()">Apply selected</button>':'', `<div class="s-hint" style="margin-bottom:8px">Expenses and bills that would otherwise land in General / Uncategorized Expense. ${d.ai_available?'Suggestions marked AI come from the assistant — check before applying.':'AI is not configured on this deployment; pick accounts by hand.'}</div>
      <div class="tbl-wrap"><table><thead><tr><th><input type="checkbox" onclick="document.querySelectorAll('.acc-cat-sel').forEach(c=>c.checked=this.checked)"></th><th>Date</th><th>What</th><th class="num">Amount</th><th>Account</th><th>Remember category</th></tr></thead><tbody>
      ${d.list.length?d.list.map((x,i)=>`<tr><td><input type="checkbox" class="acc-cat-sel" data-i="${i}" ${x.suggested_account_id?'checked':''}></td><td>${x.date}</td><td>${esc(x.text)}${x.suggested_by?` <span class="badge sent">${x.suggested_by}</span>`:''}</td>${numCell(x.amount)}<td><select class="s-input acc-cat-acct" data-i="${i}">${accountOptions(x.suggested_account_id, a=>a.type==='expense')}</select></td><td>${x.source_type==='expense'?`<input type="checkbox" class="acc-cat-rem" data-i="${i}">`:''}</td></tr>`).join(''):empty('Everything is categorised. 🎉',6)}</tbody></table></div>`);
  }catch(e){ b.innerHTML=errBox(e); }
}
L.applyCat=async()=>{ const items=[...document.querySelectorAll('.acc-cat-sel:checked')].map(c=>{ const i=c.dataset.i, x=L.cat[i]; return {source_type:x.source_type, source_id:x.source_id, account_id:document.querySelector(`.acc-cat-acct[data-i="${i}"]`).value, remember:!!document.querySelector(`.acc-cat-rem[data-i="${i}"]`)?.checked}; }).filter(x=>x.account_id);
  const r=await act(()=>post('ai/categorize/apply', {items})); if(r) toast(`Applied ${r.applied}`); opsAi(body('tabOps')); };
async function opsExports(b){
  b.innerHTML=card('Export your books', '', `<div class="acc-inline">${dateRangeInputs('accEx', fyStart(), today())}</div>
    <div class="acc-export-grid">
      <div class="stat-card"><div class="stat-lbl">Tally Prime / ERP 9</div><div class="s-hint">Ledger masters + journal vouchers (XML). Import masters first, then vouchers.</div><button class="save-btn sec" onclick="AccLedger.exTally()">⬇ Tally XML</button></div>
      <div class="stat-card"><div class="stat-lbl">Excel workbook</div><div class="s-hint">Chart of accounts, trial balance and every journal line.</div><button class="save-btn sec" onclick="AccLedger.exBook()">⬇ Excel</button></div>
      <div class="stat-card"><div class="stat-lbl">Journal lines CSV</div><div class="s-hint">For your CA or any other accounting software.</div><button class="save-btn sec" onclick="AccLedger.exCsv()">⬇ CSV</button></div>
    </div>`);
}
L.exTally=async()=>{ try{ const d=await api(`export/tally?${qs({from:val('accExFrom'), to:val('accExTo')})}`); download(`tally_masters_${d.from}_${d.to}.xml`, d.masters_xml, 'application/xml'); setTimeout(()=>download(`tally_vouchers_${d.from}_${d.to}.xml`, d.vouchers_xml, 'application/xml'), 400); toast(`${d.ledgers} ledgers, ${d.vouchers} vouchers`); }catch(e){ toast(e.message, true); } };
L.exCsv=async()=>{ try{ const d=await api(`export/journals?${qs({from:val('accExFrom'), to:val('accExTo')})}`); download(`journals_${d.from}_${d.to}.csv`, toCsv([['Entry','Date','Narration','Source','Code','Account','Debit','Credit','Party','Line note'], ...d.rows.map(r=>[r.entry_no,r.entry_date,r.memo,r.source,r.code,r.account,r.debit,r.credit,r.party_name,r.description])]), 'text/csv'); }catch(e){ toast(e.message, true); } };
L.exBook=async()=>{ try{ const from=val('accExFrom'), to=val('accExTo');
  const [j, tb, coa]=await Promise.all([api(`export/journals?${qs({from, to})}`), api(`trial-balance?${qs({from, to})}`), api('accounts')]);
  exportXlsx(`books_${from}_${to}.xlsx`, {'Chart of Accounts':[['Code','Name','Type','Sub-type','Balance'], ...coa.list.map(a=>[a.code,a.name,a.type,a.subtype,a.balance])], 'Trial Balance':[['Code','Account','Opening','Debit','Credit','Closing'], ...tb.rows.map(r=>[r.code,r.name,r.opening,r.debit,r.credit,r.closing])], 'Journals':[['Entry','Date','Narration','Source','Code','Account','Debit','Credit','Party'], ...j.rows.map(r=>[r.entry_no,r.entry_date,r.memo,r.source,r.code,r.account,r.debit,r.credit,r.party_name])]}); }catch(e){ toast(e.message, true); } };
async function opsRoles(b){
  try{ const d=await api('roles');
    b.innerHTML=card('Who can do what', can('admin')?'<button class="save-btn" onclick="AccLedger.editRole()">+ Person</button>':'', `<div class="s-hint" style="margin-bottom:8px"><b>Admin</b> everything incl. settings, period lock and roles · <b>Accountant</b> create and edit entries · <b>Approver</b> approve expenses · <b>Viewer / CA</b> read and export only. Anyone not listed gets <b>${esc(d.default_role)}</b> (change in Operations → Settings to tighten it). You are <b>${esc(d.you)}</b> (${esc(d.your_role)}).</div>
      <div class="tbl-wrap"><table><thead><tr><th>Email</th><th>Role</th><th></th></tr></thead><tbody>${d.list.length?d.list.map(r=>`<tr><td>${esc(r.email)}</td><td>${esc(r.role)}</td><td>${can('admin')?`<button class="icon-btn danger" onclick="AccLedger.delRole('${escAttr(r.email)}')">Remove</button>`:''}</td></tr>`).join(''):empty('No roles set — everyone with access is an admin.',3)}</tbody></table></div>
      <div class="acc-inline" style="margin-top:12px"><label class="s-lbl">Default role for unlisted people</label><select class="s-input" id="accDefRole" style="width:auto">${['admin','accountant','approver','viewer'].map(r=>`<option ${d.default_role===r?'selected':''}>${r}</option>`).join('')}</select><button class="save-btn sec" onclick="AccLedger.saveDefRole()">Save</button></div>`);
  }catch(e){ b.innerHTML=errBox(e); }
}
L.editRole=()=>form({title:'Give someone access', fields:[{k:'email', label:'Login email'},{k:'role', label:'Role', type:'select', options:[['accountant','Accountant'],['approver','Approver'],['viewer','Viewer'],['ca','External CA (read-only)'],['admin','Admin']]}], onSave:async f=>{ await post('roles', f); toast('Saved'); opsRoles(body('tabOps')); }});
L.delRole=async email=>{ await act(()=>post('roles/delete', {email}), 'Removed'); opsRoles(body('tabOps')); };
L.saveDefRole=()=>act(()=>post('settings', {default_role:val('accDefRole')}), 'Saved');

Object.assign(L, {renderSubs, renderTax, renderOps, download});

/* ── Tab wiring: render each new tab the first time it's opened ── */
const RENDER={overview:L.renderOverview, books:L.renderBooks, subscriptions:renderSubs, tax:renderTax, ops:renderOps};
const origShowTab=window.showTab;
window.showTab=function(name){
  origShowTab(name);
  if(RENDER[name] && !L.loaded[name]){ L.loaded[name]=true; const root=document.getElementById('tab'+name.charAt(0).toUpperCase()+name.slice(1)); RENDER[name](root.querySelector('.acc-root')||root); }
};
L.refresh=name=>{ L.loaded[name]=false; if(document.querySelector(`.tab[data-tab="${name}"]`)?.classList.contains('active')) window.showTab(name); };

/* ── Reports tab: P&L, Trial Balance and Cash Flow now come from the ledger ── */
window.loadReportPL=async function(){
  const el=document.getElementById('repPlContent'); el.innerHTML=spinner;
  try{ await loadMeta(); const d=await api(`pl?${qs({from:val('repPlFrom'), to:val('repPlTo')})}`);
    el.innerHTML=`<div class="stat-grid" style="margin-bottom:16px"><div class="stat-card"><div class="stat-lbl">Revenue</div><div class="stat-val">${money(d.revenue)}</div></div><div class="stat-card"><div class="stat-lbl">Expenses</div><div class="stat-val">${money(d.cogs+d.opex)}</div></div><div class="stat-card"><div class="stat-lbl">Net profit</div><div class="stat-val" style="color:${d.net_profit<0?'#DC2626':'var(--ink)'}">${money(d.net_profit)}</div><div class="stat-sub">Gross margin ${pct(d.gross_margin_pct)}</div></div></div>${L.warnList(d.warnings)}${L.plTable(d)}<div class="s-hint">From the double-entry ledger — accrual basis (invoices count when issued). Books → Profit &amp; Loss adds comparisons.</div>`;
  }catch(e){ el.innerHTML=errBox(e); }
};
window.loadReportTrialBalance=async function(){
  const el=document.getElementById('repTrialContent'); const from=val('repTrialFrom'), to=val('repTrialTo');
  if(!from||!to){ el.innerHTML='<div class="empty-state">Pick a date range and click Run.</div>'; return; }
  el.innerHTML=spinner;
  try{ const d=await api(`trial-balance?${qs({from, to})}`);
    el.innerHTML=`${L.warnList(d.warnings)}<div class="acc-bal ${d.balanced?'ok':'bad'}">${d.balanced?'✓ Balanced':'⚠ Out of balance'}</div><div class="tbl-wrap"><table class="acc-fin"><thead><tr><th>Code</th><th>Account</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead><tbody>${d.rows.map(r=>`<tr><td>${esc(r.code)}</td><td>${esc(r.name)}</td>${numCell(r.closing_debit||'')}${numCell(r.closing_credit||'')}</tr>`).join('')||empty('No entries.',4)}<tr class="acc-total"><td colspan="2">Totals</td>${numCell(d.total_debit)}${numCell(d.total_credit)}</tr></tbody></table></div>`;
  }catch(e){ el.innerHTML=errBox(e); }
};
const origCash=window.loadReportCashFlow;
window.loadReportCashFlow=async function(){
  const el=document.getElementById('repCashflowContent')||document.getElementById('repCfContent');
  if(!el) return origCash&&origCash();
  await loadMeta().catch(()=>{});
  return L.runCF(el);
};
})();
