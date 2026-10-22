// Follow-up V3 status for one lead — shared by the CRM lead card (dashboard.html) and Chats
// (chats.html). Reads GET /followups/v3/lead?lead_id= (cloudflare-worker/followup-v3.js
// fv3LeadStatus). Shows nothing unless the account has Follow-up V3 switched on.
(function(){
  'use strict';
  const esc=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  function rel(iso){
    const t=Date.parse(iso||''); if(!t) return '';
    const diff=t-Date.now(), a=Math.abs(diff), m=Math.round(a/60000), h=Math.round(a/3600000), d=Math.round(a/86400000);
    if(m<1) return 'now';
    const txt=m<60?m+' min':h<48?h+'h':d+' days';
    return diff>0?'in '+txt:txt+' ago';
  }
  function when(iso){ const t=Date.parse(iso||''); return t?new Date(t).toLocaleString([], {weekday:'short', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit'}):''; }
  const HEAD={
    due:['📤','Sending now'], scheduled:['⏳','Next follow-up scheduled'], waiting_template:['⏳','Waiting for template approval'],
    completed:['✅','All follow-ups sent'], goal_reached:['🎯','Sequence finished'], human:['🙋','On hold — your team is handling it'],
    agent_replied:['💬','On hold — your team replied last'], paused:['⏸','Follow-ups paused'], stopped:['🚫','Stopped'],
    not_enrolled:['—','Not in a follow-up sequence'], capped:['⏸','Taking a break'],
    meeting:['📅','On hold — meeting booked'],
  };
  const STEP_ICON={sent:'✅', skipped:'⏭', expired:'⌛', not_set:'–', pending_template:'⏳', next:'▶', upcoming:'○'};
  const STEP_TEXT={sent:'Sent', skipped:'Skipped', expired:'Window closed — skipped', not_set:'Not set up', pending_template:'Template waiting for approval', next:'Next', upcoming:'Upcoming'};
  function lastSent(d){ return (d.history||[])[0]||null; }
  // One line for tight spaces (chat header).
  function shortText(d){
    if(!d||!d.enabled) return '';
    const last=lastSent(d);
    const lastTxt=last?`✓ Follow-up ${last.step===6?'(re-engage)':last.step} sent ${rel(last.sent_at)}${last.replied_at?' · replied':''}`:'No follow-up sent yet';
    if(d.status==='scheduled'&&d.next) return `${lastTxt} · next ${rel(d.next.due_at)}`;
    if(d.status==='due') return `${lastTxt} · next going out now`;
    const h=HEAD[d.status];
    return d.status==='completed'||!h?lastTxt:`${lastTxt} · ${h[1].toLowerCase()}`;
  }
  // Full card (lead detail / chat info panel). `opts.onSkip` = name of a global function(leadId, step).
  function html(d, opts={}){
    if(!d||!d.enabled) return '';
    const [icon, title]=HEAD[d.status]||['•', d.status];
    const last=lastSent(d);
    const muted='color:var(--muted,#6b7280)';
    const stepRows=(d.steps||[]).map(s=>{
      const right=s.state==='sent'?`${esc(rel(s.sent_at))}${s.replied_at?' · <b>replied</b>':''}${s.variant&&s.variant!=='A'?` · ${s.variant==='OBJ'?'objection reply':'variant '+esc(s.variant)}`:''}`
        :s.state==='next'&&(d.status==='scheduled'||d.status==='due')?esc(d.status==='due'?'now':rel(s.due_at)):esc(STEP_TEXT[s.state]||'');
      const dim=s.state==='upcoming'||s.state==='not_set'||s.state==='expired'||s.state==='skipped';
      return `<div style="display:flex;justify-content:space-between;gap:8px;padding:3px 0;${dim?muted:''}" title="${esc(s.sent_at?when(s.sent_at):s.due_at?when(s.due_at):'')}"><span>${STEP_ICON[s.state]||'○'} ${esc(s.label)}</span><span style="text-align:right">${right}</span></div>`;
    }).join('');
    const reHist=(d.history||[]).filter(h=>h.kind==='reengage');
    const reRows=reHist.map(h=>`<div style="display:flex;justify-content:space-between;gap:8px;padding:3px 0"><span>✅ Re-engage</span><span>${esc(rel(h.sent_at))}${h.replied_at?' · <b>replied</b>':''}</span></div>`).join('');
    const nextLine=d.next&&(d.status==='scheduled'||d.status==='due')
      ? `<div style="margin-top:6px">Next: <b>${esc(d.next.label)}</b> — ${d.status==='due'?'going out within 15 min':esc(rel(d.next.due_at))+' <span style="'+muted+'">('+esc(when(d.next.due_at))+')</span>'}${opts.onSkip?` <button type="button" onclick="${esc(opts.onSkip)}(${Number(d.lead_id||opts.leadId)},${Number(d.next.step)})" style="margin-left:6px;font-size:11.5px;padding:2px 9px;border-radius:12px;border:1px solid #d1d7db;background:#fff;cursor:pointer">Skip</button>`:''}</div>`:'';
    const fail=d.last_failure?`<div style="margin-top:6px;padding:6px 8px;border-radius:6px;background:#FEF3C7;color:#92400E;font-size:12px">⚠️ ${esc(d.last_failure.hint)} ${esc(d.last_failure.fix)}</div>`:'';
    return `<div style="font-size:13px;line-height:1.45">
      <div style="font-weight:700">${icon} ${esc(title)}</div>
      ${d.status==='scheduled'||d.status==='due'?'':`<div style="${muted};font-size:12.5px">${esc(d.text||'')}</div>`}
      <div style="margin-top:6px">${last?`Last follow-up: <b>${esc(last.label)}</b> sent ${esc(rel(last.sent_at))}${last.replied_at?' — <b>customer replied</b>':' — no reply yet'}`:'<b>No follow-up sent yet</b> in this conversation.'}</div>
      ${nextLine}${fail}
      <div style="margin-top:8px;border-top:1px solid var(--line,#e5e7eb);padding-top:6px">${stepRows}${reRows}</div>
    </div>`;
  }
  async function load(workerBase, token, leadId){
    const r=await fetch(`${workerBase}/followups/v3/lead?lead_id=${encodeURIComponent(leadId)}`, {headers:{Authorization:'Bearer '+token}});
    const d=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(d.error||('HTTP '+r.status));
    return {...d, lead_id:leadId};
  }
  async function skip(workerBase, token, leadId, step){
    const r=await fetch(`${workerBase}/followups/v3/lead/skip`, {method:'POST', headers:{Authorization:'Bearer '+token, 'Content-Type':'application/json'}, body:JSON.stringify({lead_id:leadId, step})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(d.error||('HTTP '+r.status));
    return {...d, lead_id:leadId};
  }
  window.FollowupStatus={load, skip, html, shortText, rel};
})();
