/* Settings → Integrations → 🩺 Health Check — the client's daily health report.
   Reads GET /health/reports (history + newest full report) and POST /health/run (manual check);
   the daily run happens server-side (Worker cron). Shows the overall status, totals, recommended
   actions, fixes since the last run, results by category, history and recurring issues, and
   downloads the report as a PDF (jsPDF + autotable, already loaded by dashboard.html).
   Uses dashboard.html globals: $id, esc, CONFIG, ncAuthHeaders, clientRecord, showToast. */
(function(){
  const ST={report:null, reports:[], recurring:[], loaded:false, loading:false};
  const ICON={ok:'✅', warn:'⚠️', fail:'❌', off:'⚪'};
  const WORD={ok:'Passed', warn:'Warning', fail:'Failed', off:'Not tested'};
  const LABEL={ok:'Healthy', warn:'Needs Attention', fail:'Critical'};
  const BADGE={ok:'green', warn:'warn', fail:'red', off:'gray'};
  const ORDER={fail:0, warn:1, ok:2, off:3};
  const CATS=[['integration','Integration Health'],['crm','CRM Functionality'],['chatbot','AI Chatbot Health'],['automation','Automation Health'],['database','Database Health']];
  const CAT_ALIAS={sheets:'integration', core:'automation'};
  const TRIGGER={daily:'Automatic (daily)', manual:'Manual', admin:'Run by support'};

  const when=iso=>iso?new Date(iso).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}):'—';
  const ago=iso=>{
    if(!iso) return '';
    const m=Math.max(0,Math.round((Date.now()-new Date(iso).getTime())/60000));
    return m<60?`${m}m ago`:m<2880?`${Math.round(m/60)}h ago`:`${Math.round(m/1440)}d ago`;
  };
  const totalsOf=rs=>{
    const t={total:0,passed:0,failed:0,warnings:0,not_tested:0};
    (rs||[]).forEach(r=>{ t.total++; if(r.status==='ok')t.passed++; else if(r.status==='fail')t.failed++; else if(r.status==='warn')t.warnings++; else t.not_tested++; });
    return t;
  };
  const overallOf=rs=>(rs||[]).some(r=>r.status==='fail')?'fail':(rs||[]).some(r=>r.status==='warn')?'warn':'ok';

  // Before the history has loaded (or for accounts never checked since this report existed),
  // build a basic report from the latest run saved on the client record.
  function fallbackReport(){
    let log=[]; try{ log=JSON.parse(clientRecord?.integration_health_log||'[]'); }catch(e){}
    const last=log[log.length-1];
    if(!last?.results?.length) return null;
    const results=last.results.map(r=>({...r, category:CAT_ALIAS[r.category]||r.category||'integration'}));
    const status=overallOf(results);
    return {ts:last.ts, status, label:LABEL[status], totals:totalsOf(results), results,
      recommendations:results.filter(r=>r.status==='fail'||r.status==='warn').sort((a,b)=>ORDER[a.status]-ORDER[b.status])
        .map(r=>({key:r.key,label:r.label,severity:r.status==='fail'?'error':'warning',problem:r.detail,action:r.hint||''})),
      fixed:[], partial:true};
  }

  async function api(path, opts={}){
    const r=await fetch(`${CONFIG.WORKER_BASE}${path}`, {...opts, headers:ncAuthHeaders({'Content-Type':'application/json'})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(d.error||`HTTP ${r.status}`);
    return d;
  }

  async function loadReports(){
    if(ST.loading) return;
    ST.loading=true;
    try{
      const d=await api('/health/reports?limit=30');
      ST.reports=d.reports||[]; ST.recurring=d.recurring||[];
      if(d.latest) ST.report=d.latest;
      ST.loaded=true;
    }catch(e){ ST.loaded=true; ST.error=e.message; }
    finally{ ST.loading=false; render(); }
  }

  function tile(label, n, cls){
    return `<div style="flex:1;min-width:92px;border:1px solid var(--line);border-radius:10px;padding:8px 10px;background:var(--card)">
      <div style="font-size:11px;color:var(--muted)">${label}</div><div class="${cls||''}" style="font-size:20px;font-weight:700">${n}</div></div>`;
  }
  function changeChip(r){
    if(r.change==='new') return '<span class="badge red" style="font-size:10px;margin-left:6px">New</span>';
    if(r.change==='recurring') return `<span class="badge warn" style="font-size:10px;margin-left:6px">Recurring · ${r.streak} runs</span>`;
    if(r.change==='fixed') return '<span class="badge green" style="font-size:10px;margin-left:6px">Fixed</span>';
    return '';
  }

  function render(){
    const list=$id('intHealthList'); if(!list) return;
    const rep=ST.report||fallbackReport();
    const badge=$id('intHealthBadge');
    if(rep){ badge.textContent=LABEL[rep.status]||rep.label; badge.className='badge '+(BADGE[rep.status]||'gray'); }
    else{ badge.textContent='Not checked yet'; badge.className='badge gray'; }
    $id('intHealthLastChecked').innerHTML=rep
      ? `Last checked <b>${esc(when(rep.ts))}</b> (${esc(ago(rep.ts))})${rep.trigger?` · ${esc(TRIGGER[rep.trigger]||rep.trigger)}`:''} — runs automatically every day.`
        +(rep.partial?'':` Last fully healthy: <b>${rep.last_healthy_at?esc(when(rep.last_healthy_at)):'not yet'}</b>.`)
      : 'Not run yet — click "Run Check Now" below, or wait for tonight\'s automatic run.';
    const pdfBtn=$id('intHealthPdfBtn'); if(pdfBtn) pdfBtn.disabled=!rep;
    if(!rep){ list.innerHTML='<div class="s-note">No results yet.</div>'; renderHistory(); return; }

    const t=rep.totals||totalsOf(rep.results);
    const tiles=`<div style="display:flex;flex-wrap:wrap;gap:8px;margin:4px 0 12px">
      ${tile('Total tests',t.total)}${tile('✅ Passed',t.passed)}${tile('❌ Failed',t.failed,t.failed?'':'')}${tile('⚠️ Warnings',t.warnings)}${tile('⚪ Not tested',t.not_tested)}</div>`;

    const recs=rep.recommendations||[];
    const actions=recs.length?`<div style="margin:0 0 12px">
      <div style="font-weight:700;margin-bottom:6px">💡 Recommended actions</div>
      ${recs.map((a,i)=>`<div style="display:flex;gap:8px;font-size:13px;padding:6px 0;border-top:${i?'1px solid var(--line)':'0'}">
        <span>${a.severity==='error'?'❌':'⚠️'}</span>
        <div><b>${esc(a.label)}</b>${changeChip(a)}<div style="color:var(--muted)">${esc(a.problem||'')}</div>${a.action?`<div>→ ${esc(a.action)}</div>`:''}</div>
      </div>`).join('')}</div>`
      : '<div class="s-note" style="margin:0 0 12px">✅ No action needed — every tested item passed.</div>';

    const fixed=(rep.fixed||[]).length?`<div class="s-note" style="margin:0 0 12px">🎉 Fixed since the previous check: ${rep.fixed.map(f=>`<b>${esc(f.label)}</b>`).join(', ')}</div>`:'';

    const groups=CATS.map(([key,label])=>{
      const rows=(rep.results||[]).filter(r=>(CAT_ALIAS[r.category]||r.category)===key).sort((a,b)=>(ORDER[a.status]??9)-(ORDER[b.status]??9));
      if(!rows.length) return '';
      const tested=rows.some(r=>r.status!=='off');
      const st=tested?overallOf(rows):'off';
      const ct=totalsOf(rows);
      return `<details ${st==='fail'||st==='warn'?'open':''} style="border:1px solid var(--line);border-radius:10px;padding:8px 10px;margin-bottom:8px">
        <summary style="cursor:pointer;display:flex;align-items:center;gap:8px;font-weight:700">
          ${ICON[st]} ${esc(label)} <span class="badge ${BADGE[st]}" style="font-size:10px">${tested?LABEL[st]:'Not tested'}</span>
          <span style="margin-left:auto;font-weight:400;font-size:12px;color:var(--muted)">${ct.passed}/${ct.total-ct.not_tested} passed</span>
        </summary>
        ${rows.map(r=>`<div style="display:flex;align-items:flex-start;gap:8px;font-size:13px;padding:6px 0;border-top:1px solid var(--line);${r.status==='off'?'opacity:.65':''}">
          <span title="${WORD[r.status]||''}">${ICON[r.status]||'—'}</span>
          <div style="flex:1;min-width:0"><b>${esc(r.label)}</b>${changeChip(r)}
            <div style="color:var(--muted)">${esc(r.detail||'')}</div>
            ${r.status!=='ok'&&r.status!=='off'?`<div style="font-size:12px;color:var(--muted)">Last successful: ${r.last_ok_at?esc(when(r.last_ok_at)):'never in recorded history'}</div>`:''}
          </div>
          ${Number.isFinite(r.ms)?`<span style="font-size:11px;color:var(--muted);white-space:nowrap">${r.ms<1000?r.ms+' ms':(r.ms/1000).toFixed(1)+' s'}</span>`:''}
        </div>`).join('')}
      </details>`;
    }).join('');

    list.innerHTML=tiles+actions+fixed+groups;
    renderHistory();
  }

  function renderHistory(){
    const box=$id('intHealthHistory'); if(!box) return;
    if(!ST.loaded){ box.innerHTML='<div class="s-note">Loading history…</div>'; return; }
    if(!ST.reports.length){ box.innerHTML=ST.error?`<div class="s-note">History unavailable: ${esc(ST.error)}</div>`:'<div class="s-note">History starts with the next check.</div>'; return; }
    const viewing=ST.report?.id;
    const rec=ST.recurring.length?`<div style="margin:0 0 10px">
      <div style="font-weight:700;margin-bottom:4px">🔁 Recurring issues (last ${ST.reports.length} checks)</div>
      ${ST.recurring.map(x=>`<div style="font-size:13px;padding:2px 0">${x.open?'🔴':'🟢'} <b>${esc(x.label)}</b> — a problem in ${x.count} of ${x.runs} checks${x.errors?` (${x.errors} as an error)`:''} · ${x.open?'still open':'fixed now'}</div>`).join('')}
    </div>`:'';
    box.innerHTML=rec+`<div style="font-weight:700;margin-bottom:4px">🗂 Previous reports</div>
      <div style="max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:10px">
      ${ST.reports.map(r=>`<button type="button" data-health-report="${r.id}" style="display:flex;width:100%;gap:8px;align-items:center;text-align:left;padding:7px 10px;border:0;border-bottom:1px solid var(--line);background:${r.id===viewing?'var(--accent-soft,#e8f5ee)':'transparent'};color:inherit;font:inherit;font-size:13px;cursor:pointer">
        <span class="badge ${BADGE[r.status]||'gray'}" style="font-size:10px;min-width:96px;text-align:center">${esc(r.label||LABEL[r.status])}</span>
        <span style="flex:1">${esc(when(r.ts))} <span style="color:var(--muted)">· ${esc(TRIGGER[r.trigger]||r.trigger||'')}</span></span>
        <span style="color:var(--muted);white-space:nowrap">✅${r.totals?.passed??0} ❌${r.totals?.failed??0} ⚠️${r.totals?.warnings??0}${r.fixed?.length?` · 🎉${r.fixed.length} fixed`:''}</span>
      </button>`).join('')}</div>`;
    box.querySelectorAll('[data-health-report]').forEach(b=>b.addEventListener('click',()=>openReport(Number(b.dataset.healthReport))));
  }

  async function openReport(id){
    try{
      const d=await api(`/health/reports/${id}`);
      ST.report=d.report; render();
      $id('intHealthList')?.scrollIntoView({behavior:'smooth', block:'start'});
    }catch(e){ showToast?.('Could not open report: '+e.message,'err'); }
  }

  window.renderHealthResults=function(){
    render();
    if(!ST.loaded&&!ST.loading) loadReports();
  };

  window.runHealthCheck=async function(){
    const btn=$id('intHealthRunBtn'), msg=$id('intHealthMsg');
    btn.disabled=true; msg.textContent='Running all checks…';
    try{
      const d=await api('/health/run',{method:'POST'});
      Object.assign(clientRecord,{
        integration_health_status:d.status,
        integration_health_checked_at:d.checked_at,
        integration_health_log:JSON.stringify([...(()=>{try{return JSON.parse(clientRecord.integration_health_log||'[]');}catch(e){return [];}})(), {ts:d.checked_at, results:d.results}].slice(-7))
      });
      if(d.report) ST.report=d.report;
      msg.textContent='✓ Done';
      ST.loaded=false; await loadReports();
    }catch(e){ msg.textContent='Error: '+e.message; }
    finally{ btn.disabled=false; }
  };

  // jsPDF's built-in Helvetica only has the WinAnsi characters: swap arrows/quotes for ones it has
  // and drop the rest (emoji, other scripts), or they print as spaced-out garbage.
  const pdfText=v=>String(v??'').replace(/[→⇒➜]/g,'>').replace(/[←]/g,'<').replace(/[‘’]/g,"'").replace(/[“”]/g,'"')
    .replace(/[^\x00-\xFF—–•…€]/g,'').replace(/\s{2,}/g,' ').trim();
  const pdfCell=v=>typeof v==='string'?pdfText(v):v;

  window.downloadHealthPdf=function(){
    const rep=ST.report||fallbackReport();
    if(!rep) return;
    if(!window.jspdf?.jsPDF){ showToast?.('PDF library not loaded — check your connection and try again','err'); return; }
    const {jsPDF}=window.jspdf;
    const doc=new jsPDF({unit:'pt',format:'a4'});
    const rawText=doc.text.bind(doc), rawTable=doc.autoTable.bind(doc);
    doc.text=(t,...a)=>rawText(Array.isArray(t)?t.map(pdfText):pdfText(t),...a);
    doc.autoTable=o=>rawTable({...o, head:o.head?.map(r=>r.map(pdfCell)), body:o.body?.map(r=>r.map(pdfCell))});
    const W=doc.internal.pageSize.getWidth(), M=40;
    const color={ok:[22,101,52], warn:[154,91,18], fail:[185,28,28], off:[100,116,139]};
    const name=clientRecord?.client_name||'Account';
    doc.setFont('helvetica','bold'); doc.setFontSize(18); doc.text('Health Report', M, 50);
    doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(90);
    doc.text(`${name} · ${when(rep.ts)}${rep.trigger?` · ${TRIGGER[rep.trigger]||rep.trigger}`:''}`, M, 68);
    doc.setFontSize(14); doc.setFont('helvetica','bold'); doc.setTextColor(...(color[rep.status]||color.off));
    doc.text(`Overall status: ${LABEL[rep.status]||rep.label}`, M, 94);
    doc.setTextColor(0); doc.setFont('helvetica','normal'); doc.setFontSize(10);
    doc.text(`Last fully healthy: ${rep.last_healthy_at?when(rep.last_healthy_at):'not yet'}`, M, 110);
    const t=rep.totals||totalsOf(rep.results);
    // jsPDF's built-in font has no emoji, so the PDF uses words, not icons.
    doc.autoTable({startY:122, margin:{left:M,right:M}, theme:'grid', styles:{fontSize:10, halign:'center'},
      head:[['Total tests','Passed','Failed','Warnings','Not tested']], body:[[t.total,t.passed,t.failed,t.warnings,t.not_tested]], headStyles:{fillColor:[12,30,22]}});
    let y=doc.lastAutoTable.finalY+20;
    const section=title=>{ if(y>760){ doc.addPage(); y=50; } doc.setFont('helvetica','bold'); doc.setFontSize(12); doc.text(title, M, y); doc.setFont('helvetica','normal'); y+=8; };
    const recs=rep.recommendations||[];
    section('Errors, warnings and recommended actions');
    doc.autoTable({startY:y, margin:{left:M,right:M}, styles:{fontSize:9, cellPadding:4, valign:'top'}, headStyles:{fillColor:[12,30,22]},
      columnStyles:{0:{cellWidth:60},1:{cellWidth:110}},
      head:[['Severity','Check','Problem','Recommended action']],
      body:recs.length?recs.map(a=>[a.severity==='error'?'Error':'Warning', `${a.label}${a.change==='recurring'?`\n(recurring, ${a.streak} runs)`:a.change==='new'?'\n(new)':''}`, a.problem||'', a.action||'']):[['—','No issues','Every tested item passed.','None']],
      didParseCell:d=>{ if(d.section==='body'&&d.column.index===0) d.cell.styles.textColor=d.cell.raw==='Error'?color.fail:d.cell.raw==='Warning'?color.warn:[0,0,0]; }});
    y=doc.lastAutoTable.finalY+20;
    if((rep.fixed||[]).length){ section('Fixed since the previous check'); doc.setFontSize(10); const lines=doc.splitTextToSize(rep.fixed.map(f=>f.label).join(', '), W-2*M); doc.text(lines, M, y+6); y+=lines.length*12+16; }
    for(const [key,label] of CATS){
      const rows=(rep.results||[]).filter(r=>(CAT_ALIAS[r.category]||r.category)===key).sort((a,b)=>(ORDER[a.status]??9)-(ORDER[b.status]??9));
      if(!rows.length) continue;
      section(label);
      doc.autoTable({startY:y, margin:{left:M,right:M}, styles:{fontSize:9, cellPadding:4, valign:'top'}, headStyles:{fillColor:[12,30,22]},
        columnStyles:{0:{cellWidth:120},1:{cellWidth:62},3:{cellWidth:90}},
        head:[['Test','Result','Details','Last successful']],
        body:rows.map(r=>[r.label, WORD[r.status]||r.status, r.detail||'', r.status==='off'?'—':r.last_ok_at?when(r.last_ok_at):(r.status==='ok'?when(rep.ts):'never')]),
        didParseCell:d=>{ if(d.section==='body'&&d.column.index===1){ const st=Object.keys(WORD).find(k=>WORD[k]===d.cell.raw); if(st) d.cell.styles.textColor=color[st]; } }});
      y=doc.lastAutoTable.finalY+20;
    }
    if(ST.recurring.length){
      section('Recurring issues');
      doc.autoTable({startY:y, margin:{left:M,right:M}, styles:{fontSize:9}, headStyles:{fillColor:[12,30,22]},
        head:[['Check','Times seen','As error','Status now']],
        body:ST.recurring.map(x=>[x.label, `${x.count} of ${x.runs} checks`, x.errors, x.open?'Still open':'Fixed'])});
    }
    const pages=doc.internal.getNumberOfPages();
    for(let i=1;i<=pages;i++){ doc.setPage(i); doc.setFontSize(8); doc.setTextColor(140); doc.text(`Page ${i} of ${pages} · generated ${new Date().toLocaleString()}`, M, doc.internal.pageSize.getHeight()-20); }
    const safe=String(name).replace(/[^\w-]+/g,'-').replace(/^-|-$/g,'')||'account';
    doc.save(`health-report-${safe}-${String(rep.ts).slice(0,10)}.pdf`);
  };
})();
