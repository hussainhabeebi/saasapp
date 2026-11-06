/* Settings → 📇 People & Contacts (dashboard.html #pagePeoplecontacts).
   One place for the business's official identity (name, logo, address, phone, email, hours) and
   the contact person for each department — Sales, Tech support and any custom ones. The bot adds
   these after its prompt on every reply and blocks any phone number or email it would otherwise
   invent (cloudflare-worker/business-contacts.js). Backend: GET/POST /settings/contacts,
   POST /settings/contacts/logo. */
(function(){
  const S={data:null, canManage:false, billing:{}, teammates:[], logoUpload:true, dirty:false};
  const $=id=>document.getElementById(id);
  const h=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const api=(path,opts={})=>fetch(`${CONFIG.WORKER_BASE}${path}`,{...opts,headers:{Authorization:'Bearer '+sessionToken,...(opts.headers||{})}})
    .then(async r=>{ const d=await r.json().catch(()=>({})); if(!r.ok) throw new Error(d.error||'HTTP '+r.status); return d; });
  const newId=()=>'d'+Math.random().toString(36).slice(2,9);
  const ID_FIELDS=[
    ['official_name','Official name','Tripcode Travels LLC','text'],
    ['short_name','Short name (casual replies)','Tripcode','text'],
    ['address','Address','Office 12, Al Rigga Road, Deira, Dubai','textarea'],
    ['map_url','Google Maps link','https://maps.app.goo.gl/…','url'],
    ['hours','Office hours','Mon–Sat 9am–9pm','text'],
    ['phone','Main phone','+971 52 931 9100','tel'],
    ['whatsapp','Main WhatsApp','+971 52 931 9100','tel'],
    ['email','Main email','hello@yourbusiness.com','email'],
    ['website','Website','https://yourbusiness.com','url'],
  ];

  function msg(id,text,ok){ const el=$(id); if(!el) return; el.textContent=text||''; el.style.color=ok===false?'var(--red,#c0392b)':''; }
  function readForm(){
    const d=S.data;
    for(const [k] of ID_FIELDS){ const el=$('pcId_'+k); if(el) d.identity[k]=el.value.trim(); }
    d.guard=$('pcGuard')?.checked!==false;
    d.handover_contact=$('pcHandover')?.checked!==false;
    document.querySelectorAll('#pcDeptRows [data-dept]').forEach(row=>{
      const dep=d.departments.find(x=>x.id===row.dataset.dept); if(!dep) return;
      row.querySelectorAll('[data-f]').forEach(el=>{ dep[el.dataset.f]=el.type==='checkbox'?el.checked:el.value.trim(); });
    });
    const def=document.querySelector('#pcDeptRows input[name="pcDefault"]:checked')?.value;
    d.departments.forEach(x=>{ x.is_default=x.id===def; });
    return d;
  }

  function logoCard(variant,label,hint){
    // Square: the uploaded logo, else the one set earlier in Quotation settings (same logo, older place).
    const url=S.data.identity[variant==='wide'?'logo_wide_url':'logo_url']||(variant==='square'?quoteLogo():'');
    const dis=S.canManage&&S.logoUpload?'':' disabled';
    return `<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;min-width:240px;flex:1">
      <div style="width:${variant==='wide'?132:72}px;height:72px;border:1px dashed var(--line,#ddd);border-radius:10px;display:flex;align-items:center;justify-content:center;overflow:hidden;background:var(--bg-soft,#fafafa)">
        ${url?`<img src="${h(url)}" alt="${h(label)}" style="max-width:100%;max-height:100%;object-fit:contain">`:'<span class="s-note" style="margin:0">No logo</span>'}
      </div>
      <div><div class="form-label" style="margin-bottom:4px">${h(label)}</div>
        <div class="s-note" style="margin:0 0 6px">${h(hint)}</div>
        <input type="file" id="pcLogoFile_${variant}" accept="image/png,image/jpeg,image/webp" style="display:none" onchange="pcLogoUpload('${variant}')">
        <button class="save-btn" onclick="$id('pcLogoFile_${variant}').click()"${dis}>${url?'Replace':'Upload'}</button>
        ${url?`<button class="save-btn" style="background:transparent;color:var(--muted);border:1px solid var(--line,#ddd)" onclick="pcLogoRemove('${variant}')"${dis}>Remove</button>`:''}
      </div></div>`;
  }

  function deptRow(d){
    const dis=S.canManage?'':' disabled';
    const tm=`<select class="form-input" data-f="teammate"${dis}><option value="">— none —</option>${S.teammates.map(t=>`<option value="${h(t.email)}"${t.email===d.teammate?' selected':''}>${h(t.name)}</option>`).join('')}</select>`;
    const inp=(f,ph,type='text')=>`<input class="form-input" data-f="${f}" type="${type}" value="${h(d[f])}" placeholder="${h(ph)}"${dis}>`;
    return `<div class="card" data-dept="${h(d.id)}" style="margin-bottom:10px;padding:12px">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px">
        <div><label class="form-label">Department</label>${inp('name','Sales / Visa / Accounts')}</div>
        <div><label class="form-label">Contact person</label>${inp('person','Rahul')}</div>
        <div><label class="form-label">Phone</label>${inp('phone','+971 52 931 9100','tel')}</div>
        <div><label class="form-label">Email</label>${inp('email','sales@yourbusiness.com','email')}</div>
        <div><label class="form-label">Hours</label>${inp('hours','9am–9pm')}</div>
        <div><label class="form-label">Linked teammate</label>${tm}</div>
        <div style="grid-column:1/-1"><label class="form-label">Handles (helps the bot pick the right one)</label>${inp('handles','packages, bookings, prices')}</div>
      </div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center;margin-top:8px;font-size:13px">
        <label><input type="checkbox" data-f="whatsapp"${d.whatsapp!==false?' checked':''}${dis}> On WhatsApp</label>
        <label title="Off = internal hand-off only; the bot never shares this contact"><input type="checkbox" data-f="public"${d.public!==false?' checked':''}${dis} onchange="pcRefreshPreview()"> Show to customers</label>
        <label><input type="radio" name="pcDefault" value="${h(d.id)}"${d.is_default?' checked':''}${dis} onchange="pcRefreshPreview()"> Default (when nothing else fits)</label>
        ${S.canManage?`<button class="save-btn" style="margin-left:auto;background:transparent;color:var(--red,#c0392b);border:1px solid var(--line,#ddd)" onclick="pcRemoveDept('${h(d.id)}')">Remove</button>`:''}
      </div></div>`;
  }

  // Same rules as the backend's bcPromptBlock, so the preview matches what the bot reads. The
  // saved copy from the server replaces it after every save.
  function previewText(){
    const d=readForm(), id=d.identity, L=[];
    const add=(l,v)=>{ if(v) L.push(`${l}: ${v}`); };
    add('Official name',id.official_name); if(id.short_name&&id.short_name!==id.official_name) add('Short name (casual replies)',id.short_name);
    add('Address',id.address); add('Map',id.map_url); add('Office hours',id.hours); add('Main phone',id.phone);
    const k=s=>String(s||'').replace(/\D/g,'').slice(-9);
    if(id.whatsapp&&k(id.whatsapp)!==k(id.phone)) add('WhatsApp',id.whatsapp);
    add('Email',id.email); add('Website',id.website);
    const deps=d.departments.filter(x=>x.public!==false&&(x.phone||x.email||x.person));
    if(!L.length&&!deps.length) return '(Nothing saved yet — the bot uses only its prompt.)';
    const out=['## Official business details — use exactly as written',...L];
    if(deps.length){
      const def=deps.find(x=>x.is_default)||deps[0];
      out.push('','## Official contacts by department — share ONLY these');
      for(const x of deps) out.push(`- ${x.name}${x.handles?` (${x.handles})`:''}: ${[x.person,x.phone?`${x.phone}${x.whatsapp!==false?' (call / WhatsApp)':' (call)'}`:'',x.email,x.hours?`hours ${x.hours}`:''].filter(Boolean).join(' — ')}${x===def?'  [DEFAULT]':''}`);
    }
    out.push('','Rules: give only the ONE contact that fits · never invent or change a name, number, email or address · if a detail is missing, say the team will share it.');
    return out.join('\n');
  }

  function render(){
    const root=$('pcRoot'); if(!root) return;
    const d=S.data, dis=S.canManage?'':' disabled';
    root.innerHTML=`
      ${S.canManage?'':'<div class="s-note" style="margin-bottom:12px">Only the account owner or an Admin can change these.</div>'}
      <div class="card" style="margin-bottom:14px"><div class="settings-section" style="margin-bottom:0">
        <div class="s-head">🏢 Business identity</div>
        <div class="s-note">Your official details. The bot quotes them exactly, and the logo is kept here for quotations, invoices, emails and your pages.</div>
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin:6px 0 14px">
          ${logoCard('square','Logo (square)','PNG, JPG or WebP · up to 2 MB · 512×512 works best')}
          ${logoCard('wide','Logo (wide, optional)','For document headers and emails')}
        </div>
        ${S.logoUpload?'':'<div class="s-note">Logo storage is not set up on this server yet.</div>'}
        <div class="s-note" style="margin-top:0">The square logo is the one official logo: quotations, invoices, receipts and itinerary PDFs, emails, your store / order / booking / chat pages and the top bar all use it.${!d.identity.logo_url&&quoteLogo()?' Showing the logo from Quotation settings — upload here to make it official everywhere.':''}</div>
        <span class="save-msg" id="pcLogoMsg"></span>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px">
          ${ID_FIELDS.map(([k,l,ph,t])=>`<div${t==='textarea'?' style="grid-column:1/-1"':''}><label class="form-label">${h(l)}</label>${t==='textarea'
            ?`<textarea class="form-input" id="pcId_${k}" rows="2" placeholder="${h(ph)}" oninput="pcRefreshPreview()"${dis}>${h(d.identity[k])}</textarea>`
            :`<input class="form-input" id="pcId_${k}" type="${t}" value="${h(d.identity[k])}" placeholder="${h(ph)}" oninput="pcRefreshPreview()"${dis}>`}</div>`).join('')}
        </div>
        ${S.canManage&&(S.billing.client_name||S.billing.company_address||S.billing.billing_email)?`<button class="save-btn" style="margin-top:10px;background:transparent;color:var(--accent,#2563eb);border:1px solid var(--line,#ddd)" onclick="pcCopyBilling()">Same as billing (Company Profile)</button>`:''}
      </div></div>

      <div class="card" style="margin-bottom:14px"><div class="settings-section" style="margin-bottom:0">
        <div class="s-head">👥 Departments &amp; contact people</div>
        <div class="s-note">The bot gives the one contact that fits the question, or the default when nothing does. Turn off "Show to customers" for a person who should only get internal hand-offs.</div>
        <div id="pcDeptRows">${d.departments.map(deptRow).join('')||'<div class="s-note">No departments yet.</div>'}</div>
        ${S.canManage?`<button class="save-btn" style="background:transparent;color:var(--accent,#2563eb);border:1px solid var(--line,#ddd)" onclick="pcAddDept()">＋ Add department</button>`:''}
      </div></div>

      <div class="card" style="margin-bottom:14px"><div class="settings-section" style="margin-bottom:0">
        <div class="s-head">🛡️ Contact safety</div>
        <label style="display:flex;gap:8px;align-items:flex-start;font-size:13px"><input type="checkbox" id="pcGuard"${d.guard!==false?' checked':''}${dis}>
          <span>Check every bot reply: a phone number or email that isn't here, in the prompt or knowledge base, or from the customer is rewritten, then removed. Recommended.</span></label>
        <label style="display:flex;gap:8px;align-items:flex-start;font-size:13px;margin-top:8px"><input type="checkbox" id="pcHandover"${d.handover_contact!==false?' checked':''}${dis}>
          <span>Send the matching department's contact (or the default) as a fixed message when a customer asks for a contact number or a staff member, and when the bot hands a chat to the team — copied from here, never written by the AI.</span></label>
      </div></div>

      <div class="card" style="margin-bottom:14px"><div class="settings-section" style="margin-bottom:0">
        <div class="s-head">👁️ What the bot reads (added after your bot prompt)</div>
        <pre id="pcPreview" style="white-space:pre-wrap;font-size:12px;background:var(--bg-soft,#f6f6f6);border-radius:8px;padding:12px;margin:0;max-height:340px;overflow:auto"></pre>
      </div></div>

      ${S.canManage?`<div style="display:flex;gap:10px;align-items:center;position:sticky;bottom:0;padding:10px 0;background:var(--bg,#fff)">
        <button class="save-btn" id="pcSaveBtn" onclick="pcSave()">Save People &amp; Contacts</button><span class="save-msg" id="pcSaveMsg"></span></div>`:''}`;
    $('pcDeptRows')?.addEventListener('input',window.pcRefreshPreview); // typing in any department row
    pcRefreshPreview();
  }

  window.pcRefreshPreview=function(){ const el=$('pcPreview'); if(el&&S.data) el.textContent=previewText(); };
  window.pcAddDept=function(){ readForm(); S.data.departments.push({id:newId(),name:'',person:'',phone:'',whatsapp:true,email:'',hours:'',handles:'',public:true,is_default:!S.data.departments.length,teammate:''}); render(); };
  window.pcRemoveDept=function(id){ readForm(); S.data.departments=S.data.departments.filter(x=>x.id!==id); render(); };
  window.pcCopyBilling=function(){
    readForm(); const b=S.billing, i=S.data.identity;
    if(b.client_name) i.official_name=b.client_name;
    if(b.company_address) i.address=b.company_address;
    if(b.billing_email) i.email=b.billing_email;
    render(); msg('pcSaveMsg','Copied from Company Profile — press Save to keep it.');
  };
  window.pcSave=async function(){
    const btn=$('pcSaveBtn'); if(btn) btn.disabled=true;
    msg('pcSaveMsg','Saving…');
    try{
      const r=await api('/settings/contacts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:readForm()})});
      S.data=r.data; render();
      const el=$('pcPreview'); if(el) el.textContent=r.prompt_block?r.prompt_block.trim():'(Nothing saved yet — the bot uses only its prompt.)';
      msg('pcSaveMsg','✓ Saved — the bot uses these from its next reply.');
    }catch(e){ msg('pcSaveMsg',e.message,false); }
    finally{ const b=$('pcSaveBtn'); if(b) b.disabled=false; }
  };
  // ── Official logo ──
  // One upload makes three copies: the square PNG/WebP for pages and emails (R2), a white-backed
  // JPEG for PDFs written on the server (variant print), and a small data URI on the client record
  // (quote_logo_url), which the quotation / invoice PDFs, Campaign emails and the top bar already
  // read — so every place that showed a logo before now shows this one.
  function quoteLogo(){ try{ return (typeof clientRecord!=='undefined'&&clientRecord?.quote_logo_url)||''; }catch(e){ return ''; } }
  const loadImg=file=>new Promise((res,rej)=>{ const u=URL.createObjectURL(file), im=new Image(); im.onload=()=>{ URL.revokeObjectURL(u); res(im); }; im.onerror=()=>{ URL.revokeObjectURL(u); rej(new Error('That file is not an image we can read.')); }; im.src=u; });
  function draw(im,max,bg){
    const k=Math.min(1,max/Math.max(im.naturalWidth||1,im.naturalHeight||1));
    const cv=document.createElement('canvas'); cv.width=Math.max(1,Math.round(im.naturalWidth*k)); cv.height=Math.max(1,Math.round(im.naturalHeight*k));
    const g=cv.getContext('2d'); if(bg){ g.fillStyle=bg; g.fillRect(0,0,cv.width,cv.height); } g.drawImage(im,0,0,cv.width,cv.height); return cv;
  }
  const toBlob=(cv,type,q)=>new Promise(r=>cv.toBlob(r,type,q));
  async function smallDataUrl(im){
    for(const max of [512,384,256]){
      const png=draw(im,max).toDataURL('image/png'); if(png.length<450*1024) return png;
      const jpg=draw(im,max,'#fff').toDataURL('image/jpeg',0.88); if(jpg.length<450*1024) return jpg;
    }
    return draw(im,200,'#fff').toDataURL('image/jpeg',0.8);
  }
  async function syncQuoteLogo(url){
    if(typeof patchClient!=='function') return;
    await patchClient({quote_logo_url:url});
    try{ if(typeof clientRecord!=='undefined'&&clientRecord) clientRecord.quote_logo_url=url; }catch(e){}
    try{ if(typeof applyHeaderLogo==='function') applyHeaderLogo(); }catch(e){}
    try{ if(typeof quoteRenderLogoPreview==='function'&&document.getElementById('quoteLogoPreview')) quoteRenderLogoPreview(url); }catch(e){}
  }
  const postLogo=(variant,blob,name)=>{ const fd=new FormData(); fd.append('variant',variant); fd.append('file',blob,name); return api('/settings/contacts/logo',{method:'POST',body:fd}); };
  const removeLogo=variant=>api('/settings/contacts/logo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({variant,remove:true})});
  // Also used by Quotation settings' logo box, so both places set the same official logo.
  window.pcSetOfficialLogo=async function(file,variant='square'){
    if(!file) throw new Error('Choose an image file.');
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)) throw new Error('Logo must be a PNG, JPG or WebP image.');
    if(file.size>2*1024*1024) throw new Error('Logo is too large — max 2 MB.');
    const im=await loadImg(file);
    const keepType=file.type==='image/jpeg'?'image/jpeg':'image/png';
    const main=await toBlob(draw(im,1024,keepType==='image/jpeg'?'#fff':null),keepType,0.92);
    const r=await postLogo(variant,main,variant+(keepType==='image/jpeg'?'.jpg':'.png'));
    if(variant!=='square') return {url:r.url};
    const print=await toBlob(draw(im,600,'#fff'),'image/jpeg',0.9);
    const p=await postLogo('print',print,'print.jpg').catch(()=>null);
    await syncQuoteLogo(await smallDataUrl(im));
    return {url:r.url,print_url:p?.url||''};
  };
  window.pcClearOfficialLogo=async function(variant='square'){
    await removeLogo(variant);
    if(variant==='square'){ await removeLogo('print').catch(()=>{}); await syncQuoteLogo(''); }
  };
  window.pcLogoUpload=async function(variant){
    const f=$('pcLogoFile_'+variant)?.files?.[0]; if(!f) return;
    readForm(); msg('pcLogoMsg','Uploading…');
    try{
      const r=await window.pcSetOfficialLogo(f,variant);
      S.data.identity[variant==='wide'?'logo_wide_url':'logo_url']=r.url;
      if(r.print_url) S.data.identity.logo_print_url=r.print_url;
      render(); msg('pcLogoMsg',variant==='square'?'✓ Logo saved — now used on documents, emails, pages and the top bar.':'✓ Wide logo saved.');
    }catch(e){ msg('pcLogoMsg',e.message,false); }
  };
  window.pcLogoRemove=async function(variant){
    if(!confirm(variant==='square'?'Remove the official logo? It is removed from documents, emails, pages and the top bar too.':'Remove the wide logo?')) return;
    readForm();
    try{
      if(variant==='square'&&!S.data.identity.logo_url){ await syncQuoteLogo(''); }   // only the older Quotation logo was set
      else await window.pcClearOfficialLogo(variant);
      S.data.identity[variant==='wide'?'logo_wide_url':'logo_url']='';
      if(variant==='square') S.data.identity.logo_print_url='';
      render(); msg('pcLogoMsg','Logo removed.');
    }catch(e){ msg('pcLogoMsg',e.message,false); }
  };
  window.peopleContactsInit=async function(){
    const root=$('pcRoot'); if(!root) return;
    root.innerHTML='<div class="s-note">Loading…</div>';
    try{
      const r=await api('/settings/contacts');
      Object.assign(S,{data:r.data,canManage:!!r.can_manage,billing:r.billing||{},teammates:r.teammates||[],logoUpload:r.logo_upload!==false});
      render();
    }catch(e){ root.innerHTML=`<div class="s-note" style="color:var(--red,#c0392b)">Couldn't load People &amp; Contacts: ${h(e.message)}</div>`; }
  };
})();
