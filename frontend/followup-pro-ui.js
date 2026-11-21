// Follow-up V3 · Pro add-ons in the browser (cloudflare-worker/followup-pro.js, followup-v3.js):
//   FollowupPro.renderHome(el, workerBase, token, {openLead})  — "Who to contact now" card on Home
//                                                                (GET /followups/v3/nba)
//   FollowupPro.openQuote(workerBase, token, leadId, {onSent}) — 📄 Quote builder dialog
//                                                                (GET /followups/v3/quote/catalog,
//                                                                 POST /followups/v3/quote)
// Both stay hidden / refuse politely unless the account switched that add-on on.
(function(){
  'use strict';
  const esc=s=>String(s??'').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const money=(n, cur)=>`${cur?cur+' ':''}${(Number(n)||0).toLocaleString('en-IN', {maximumFractionDigits:2})}`;
  const BAND={critical:['⚡', 'Critical', '#fee2e2', '#991b1b'], warm:['🔥', 'Warm', '#fef9c3', '#854d0e'], nurture:['💧', 'Nurture', '#dbeafe', '#1e40af'], cold:['💤', 'Cold', '#f1f5f9', '#475569']};
  async function api(workerBase, token, path, opts={}){
    const r=await fetch(workerBase+'/followups/v3'+path, {...opts, headers:{Authorization:'Bearer '+token, ...(opts.body?{'Content-Type':'application/json'}:{})}});
    if((r.headers.get('Content-Type')||'').includes('application/pdf')){ if(!r.ok) throw new Error('HTTP '+r.status); return {pdf:await r.blob(), quoteNo:r.headers.get('X-Quote-No')||''}; }
    const d=await r.json().catch(()=>({}));
    if(!r.ok){ const e=new Error(d.error||('HTTP '+r.status)); e.status=r.status; throw e; }
    return d;
  }

  // ── Home: next-best-action ──
  let homeCache=null, homeAt=0;
  async function renderHome(el, workerBase, token, {openLead='openLeadFromAlert', force=false}={}){
    if(!el) return;
    try{
      if(force || !homeCache || Date.now()-homeAt>90000){ homeCache=await api(workerBase, token, '/nba?limit=10'); homeAt=Date.now(); }
    }catch(e){ el.style.display='none'; return; }
    const d=homeCache;
    if(!d || !d.enabled){ el.style.display='none'; return; }
    const chips=['critical', 'warm', 'nurture', 'cold'].filter(b=>d.counts?.[b]).map(b=>{ const [i, l, bg, fg]=BAND[b]; return `<span style="background:${bg};color:${fg};padding:3px 10px;border-radius:12px;font-size:12px;font-weight:700">${i} ${l} ${d.counts[b]}</span>`; }).join(' ');
    const rows=(d.list||[]).map(r=>{
      const [, , bg, fg]=BAND[r.band]||BAND.cold;
      return `<button type="button" data-fp-lead="${Number(r.lead_id)}" style="display:flex;gap:12px;align-items:center;width:100%;text-align:left;padding:9px 6px;border:0;border-top:1px solid var(--line,#e5e7eb);background:none;cursor:pointer;font:inherit;color:inherit">
        <span style="min-width:40px;height:40px;border-radius:10px;background:${bg};color:${fg};display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px" title="Score out of 100">${Number(r.score)}</span>
        <span style="flex:1;min-width:0">
          <span style="display:block;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.name||r.phone||('Lead '+r.lead_id))}${r.stage?` <span style="font-weight:400;color:var(--muted,#6b7280);font-size:12px">· ${esc(String(r.stage).replace(/_/g, ' '))}</span>`:''}</span>
          <span style="display:block;font-size:13px">👉 ${esc(r.action)}</span>
          ${r.reasons?.length?`<span style="display:block;font-size:11.5px;color:var(--muted,#6b7280)">${esc(r.reasons.join(' · '))}</span>`:''}
        </span></button>`;
    }).join('');
    el.innerHTML=`<div class="section-card" style="padding:14px 18px;margin-bottom:0">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <div class="section-title" style="margin:0">🎯 Who to contact now</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${chips}</div>
        <button type="button" data-fp-refresh style="margin-left:auto;font-size:12px;border:1px solid var(--line,#e5e7eb);background:none;border-radius:8px;padding:3px 10px;cursor:pointer">↻ Refresh</button>
      </div>
      ${rows||'<div style="font-size:13px;color:var(--muted,#6b7280);padding:6px 0">No open leads need action right now.</div>'}
    </div>`;
    el.style.display='';
    el.querySelectorAll('[data-fp-lead]').forEach(b=>b.addEventListener('click', ()=>{ const fn=window[openLead]; if(typeof fn==='function') fn(Number(b.dataset.fpLead)); }));
    el.querySelector('[data-fp-refresh]')?.addEventListener('click', ()=>renderHome(el, workerBase, token, {openLead, force:true}));
  }

  // Extra lines for the lead's Follow-up card (language / objection / snooze / score / last quote).
  function chipsHtml(pro, {onQuote, leadId}={}){
    if(!pro || typeof pro!=='object') return '';
    const bits=[];
    if(pro.nba){ const [i, l, bg, fg]=BAND[pro.nba.band]||BAND.cold; bits.push(`<span style="background:${bg};color:${fg};padding:1px 8px;border-radius:10px;font-weight:700" title="${esc((pro.nba.reasons||[]).join(' · '))}">${i} ${Number(pro.nba.score)} · ${l}</span>`); }
    if(pro.language_name) bits.push(`<span title="Follow-ups go out in this language">🌐 ${esc(pro.language_name)}</span>`);
    if(pro.objection) bits.push(`<span title="Last objection">🧱 ${esc(pro.objection)}</span>`);
    if(pro.snooze_until) bits.push(`<span title="The customer asked to talk later">⏰ until ${esc(new Date(pro.snooze_until).toLocaleString([], {day:'numeric', month:'short', hour:'numeric', minute:'2-digit'}))}</span>`);
    const action=pro.nba?.action?`<div style="margin-top:4px">👉 ${esc(pro.nba.action)}</div>`:'';
    const quote=pro.quote_pdf?`<div style="margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">${onQuote?`<button type="button" onclick="${esc(onQuote)}(${Number(leadId)})" style="font-size:12.5px;padding:4px 12px;border-radius:14px;border:1px solid #0F7377;background:#0F7377;color:#fff;cursor:pointer">📄 Quote PDF</button>`:''}${pro.last_quote?`<span style="font-size:12px;color:var(--muted,#6b7280)">Last: ${esc(pro.last_quote.quote_no)} · ${esc(money(pro.last_quote.total, pro.last_quote.currency))} · ${esc(new Date(pro.last_quote.created_at).toLocaleDateString())}${pro.last_quote.via==='followup'?' (auto)':''}</span>`:''}</div>`:'';
    if(!bits.length && !action && !quote) return '';
    return `<div style="margin-top:8px;padding-top:6px;border-top:1px dashed var(--line,#e5e7eb);font-size:12.5px"><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">${bits.join('')}</div>${action}${quote}</div>`;
  }

  // ── Quote builder ──
  function close(){ document.getElementById('fpQuoteModal')?.remove(); }
  async function openQuote(workerBase, token, leadId, {onSent}={}){
    close();
    const wrap=document.createElement('div');
    wrap.id='fpQuoteModal';
    wrap.style.cssText='position:fixed;inset:0;z-index:10000;background:rgba(15,23,42,.45);display:flex;align-items:flex-start;justify-content:center;padding:4vh 12px;overflow:auto';
    wrap.innerHTML='<style>#fpQuoteModal input,#fpQuoteModal textarea{box-sizing:border-box;max-width:100%}</style><div style="background:var(--card,#fff);color:var(--ink,#111827);border-radius:14px;width:min(640px,100%);padding:18px;box-shadow:0 20px 50px rgba(0,0,0,.25);font-size:14px">Loading products…</div>';
    wrap.addEventListener('click', e=>{ if(e.target===wrap) close(); });
    document.body.appendChild(wrap);
    const box=wrap.lastElementChild;
    let d;
    try{ d=await api(workerBase, token, '/quote/catalog?lead_id='+encodeURIComponent(leadId)); }
    catch(e){ box.innerHTML=`<div style="display:flex;justify-content:space-between;gap:10px"><b>📄 Quote PDF</b><button type="button" data-x style="border:0;background:none;font-size:18px;cursor:pointer">✕</button></div><p style="color:#991b1b">${esc(e.message)}</p>`; box.querySelector('[data-x]').onclick=close; return; }
    const cur=d.currency||'';
    const picked=new Map((d.suggested||[]).map(k=>[k, 1]));
    const custom=[];
    const row=p=>`<label style="display:flex;gap:10px;align-items:center;padding:7px 4px;border-top:1px solid var(--line,#eef0f2);cursor:pointer" data-name="${esc((p.name+' '+(p.sku||'')+' '+(p.category||'')).toLowerCase())}">
      <input type="checkbox" data-key="${esc(p.key)}" ${picked.has(p.key)?'checked':''} style="width:auto">
      ${p.image?`<img src="${esc(p.image)}" alt="" loading="lazy" style="width:44px;height:44px;object-fit:cover;border-radius:8px;flex:none">`:'<span style="width:44px;height:44px;border-radius:8px;background:#f1f5f9;flex:none"></span>'}
      <span style="flex:1;min-width:0"><span style="display:block;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.name)}</span><span style="font-size:12px;color:var(--muted,#6b7280)">${esc(money(p.price, p.currency||cur))}${d.suggested?.includes(p.key)?' · <b style="color:#0F7377">lead\'s choice</b>':''}</span></span>
      <input type="number" min="1" max="999" value="${picked.get(p.key)||1}" data-qty="${esc(p.key)}" title="Quantity" style="width:62px">
    </label>`;
    box.innerHTML=`
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:center"><b style="font-size:16px">📄 Quote for ${esc(d.lead?.name||'this lead')}</b><button type="button" data-x style="border:0;background:none;font-size:20px;cursor:pointer" aria-label="Close">✕</button></div>
      ${d.lead?.interested?`<div style="font-size:12.5px;color:var(--muted,#6b7280);margin-top:2px">Interested in: ${esc(d.lead.interested)}</div>`:''}
      ${d.window_open?'':'<div style="margin-top:10px;padding:8px 10px;border-radius:8px;background:#FEF3C7;color:#92400E;font-size:12.5px">The 24-hour WhatsApp window is closed — WhatsApp won\'t deliver a file now. You can still download the PDF and send it after the customer writes again.</div>'}
      ${d.catalog?.length?`<input type="search" data-search placeholder="Search products…" style="width:100%;margin-top:12px">
      <div data-list style="max-height:300px;overflow:auto;margin-top:6px">${d.catalog.map(row).join('')}</div>`:'<div style="margin-top:12px;font-size:13px;color:var(--muted,#6b7280)">No products in your catalog yet — add lines below.</div>'}
      <div data-custom style="margin-top:8px"></div>
      <button type="button" data-addline style="margin-top:6px;font-size:12.5px;border:1px dashed var(--line,#cbd5e1);background:none;border-radius:8px;padding:5px 10px;cursor:pointer">+ Add a line (service, transfer, extra…)</button>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-top:12px">
        <label style="font-size:12.5px">Discount (${esc(cur||'amount')})<input type="number" min="0" data-discount value="0" style="width:100%"></label>
        <label style="font-size:12.5px">Valid for (days)<input type="number" min="1" max="90" data-valid value="${Number(d.valid_days)||7}" style="width:100%"></label>
      </div>
      <label style="display:block;font-size:12.5px;margin-top:8px">Note on the quote<textarea data-note rows="2" maxlength="500" style="width:100%">${esc(d.note||'')}</textarea></label>
      <div data-total style="margin-top:10px;font-weight:700"></div>
      <div data-msg style="margin-top:6px;font-size:12.5px"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:12px">
        <button type="button" data-preview class="btn btn-sec" style="padding:7px 14px;border-radius:8px;cursor:pointer">👁 Preview / download</button>
        <button type="button" data-send class="btn btn-primary" ${d.window_open?'':'disabled'} style="padding:7px 14px;border-radius:8px;cursor:pointer">📤 Send on WhatsApp</button>
      </div>`;
    const $=s=>box.querySelector(s);
    const items=()=>{
      const out=[];
      box.querySelectorAll('[data-key]').forEach(cb=>{ if(cb.checked) out.push({key:cb.dataset.key, qty:Number(box.querySelector(`[data-qty="${CSS.escape(cb.dataset.key)}"]`)?.value)||1}); });
      custom.forEach(c=>{ if(c.name.trim()) out.push({name:c.name.trim(), price:Number(c.price)||0, qty:Number(c.qty)||1}); });
      return out;
    };
    const byKey=new Map((d.catalog||[]).map(p=>[p.key, p]));
    const recalc=()=>{
      const sub=items().reduce((a, it)=>a+(it.key?(byKey.get(it.key)?.price||0):it.price)*it.qty, 0);
      const disc=Math.min(sub, Math.max(0, Number($('[data-discount]').value)||0));
      $('[data-total]').textContent=items().length?`Total: ${money(sub-disc, cur)}${disc?` (after ${money(disc, cur)} discount)`:''}`:'Pick at least one product.';
    };
    const paintCustom=()=>{
      $('[data-custom]').innerHTML=custom.map((c, i)=>`<div style="display:flex;gap:6px;margin-top:6px;align-items:center">
        <input placeholder="Item" value="${esc(c.name)}" data-c="${i}" data-f="name" style="flex:2;min-width:0"><input type="number" min="0" placeholder="Price" value="${esc(c.price)}" data-c="${i}" data-f="price" style="flex:1;min-width:0"><input type="number" min="1" value="${esc(c.qty)}" data-c="${i}" data-f="qty" style="width:58px"><button type="button" data-rm="${i}" style="border:0;background:none;cursor:pointer" aria-label="Remove">✕</button></div>`).join('');
      $('[data-custom]').querySelectorAll('[data-c]').forEach(inp=>inp.addEventListener('input', ()=>{ custom[Number(inp.dataset.c)][inp.dataset.f]=inp.value; recalc(); }));
      $('[data-custom]').querySelectorAll('[data-rm]').forEach(b=>b.addEventListener('click', ()=>{ custom.splice(Number(b.dataset.rm), 1); paintCustom(); recalc(); }));
    };
    $('[data-x]').onclick=close;
    $('[data-addline]').onclick=()=>{ custom.push({name:'', price:'', qty:1}); paintCustom(); recalc(); };
    $('[data-search]')?.addEventListener('input', e=>{ const q=e.target.value.trim().toLowerCase(); box.querySelectorAll('[data-list] > label').forEach(l=>{ l.style.display=!q||l.dataset.name.includes(q)?'':'none'; }); });
    box.addEventListener('input', e=>{ if(e.target.matches('[data-qty],[data-discount]')) recalc(); });
    box.addEventListener('change', e=>{ if(e.target.matches('[data-key]')) recalc(); });
    recalc();
    const payload=send=>({lead_id:leadId, items:items(), discount:Number($('[data-discount]').value)||0, valid_days:Number($('[data-valid]').value)||7, note:$('[data-note]').value, send});
    const msg=(t, bad)=>{ $('[data-msg]').textContent=t; $('[data-msg]').style.color=bad?'#991b1b':'#065f46'; };
    $('[data-preview]').onclick=async()=>{
      if(!items().length) return msg('Pick at least one product.', true);
      const win=window.open('', '_blank');
      msg('Building the PDF…');
      try{
        const r=await api(workerBase, token, '/quote', {method:'POST', body:JSON.stringify(payload(false))});
        const url=URL.createObjectURL(r.pdf);
        if(win) win.location.href=url;
        else { const a=document.createElement('a'); a.href=url; a.download=(r.quoteNo||'quotation')+'.pdf'; document.body.appendChild(a); a.click(); a.remove(); }
        setTimeout(()=>URL.revokeObjectURL(url), 60000);
        msg('PDF ready'+(r.quoteNo?` — ${r.quoteNo}`:'')+'.');
      }catch(e){ if(win) win.close(); msg(e.message, true); }
    };
    $('[data-send]').onclick=async()=>{
      if(!items().length) return msg('Pick at least one product.', true);
      $('[data-send]').disabled=true; msg('Sending…');
      try{
        const r=await api(workerBase, token, '/quote', {method:'POST', body:JSON.stringify(payload(true))});
        msg(`Sent ✓ ${r.quote_no} — ${money(r.total, cur)}`);
        try{ onSent?.(r); }catch(e){}
        setTimeout(close, 1200);
      }catch(e){ $('[data-send]').disabled=false; msg(e.message, true); }
    };
  }
  window.FollowupPro={renderHome, openQuote, chipsHtml};
})();
