/* ── HOSPITALITY → API IMPORT (🏨 Hospitality → 🔗 API Import) ─────────────────────────────────
   Dashboard side of cloudflare-worker/hospitality-import.js: add another system's property API
   link + key, preview what it returns, import its properties and units, and keep them in live sync
   (the Worker re-syncs each link on its own interval from the 15-minute cron). Loaded by
   dashboard.html after its main script; rendered from renderHospSubPage('import'). Uses
   dashboard.html's own globals: CONFIG, ncAuthHeaders, esc, $id, showToast, hospLoad, _hospLoaded.
   Bump the ?v= on its <script> tag in dashboard.html when changing this file — sw.js serves
   scripts cache-first. ── */
let _hiSources=[], _hiMinutes=[15,30,60,180,360,720,1440];

const HI_AUTH_LABELS={bearer:'Authorization: Bearer <key>', 'x-api-key':'X-API-Key: <key>', none:'No key (public API)'};
function _hiEvery(m){
  m=Number(m)||60;
  if(m<60) return `Every ${m} min`;
  if(m===60) return 'Every hour';
  if(m<1440) return `Every ${m/60} hours`;
  return 'Once a day';
}
function _hiWhen(iso){
  if(!iso) return 'never';
  const d=new Date(iso); if(isNaN(d)) return 'never';
  const mins=Math.round((Date.now()-d.getTime())/60000);
  if(mins<1) return 'just now';
  if(mins<60) return `${mins} min ago`;
  if(mins<1440) return `${Math.round(mins/60)} h ago`;
  return d.toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
}
async function _hiApi(method, path, body){
  const r=await fetch(`${CONFIG.WORKER_BASE}/hospitality/import${path}`,{method,headers:ncAuthHeaders({'Content-Type':'application/json'}),body:body?JSON.stringify(body):undefined});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data.error||`HTTP ${r.status}`);
  return data;
}
// After an import the Properties / Units tabs must re-read what the sync wrote.
function _hiRefreshCatalog(){ _hospLoaded=false; if(typeof hospLoad==='function') hospLoad(); }

async function renderHospImport(){
  const el=$id('hospContent');
  el.innerHTML='<div style="text-align:center;padding:40px;color:var(--muted)">Loading…</div>';
  try{ const d=await _hiApi('GET','/sources'); _hiSources=d.list||[]; if(d.sync_minutes) _hiMinutes=d.sync_minutes; }
  catch(e){ _hiSources=[]; el.innerHTML=`<div class="empty-state"><div class="ei">⚠️</div>Couldn't load API links: ${esc(e.message)}</div>`; return; }
  const opts=sel=>_hiMinutes.map(m=>`<option value="${m}"${Number(sel)===m?' selected':''}>${_hiEvery(m)}</option>`).join('');
  const sourceCard=s=>{
    const status=s.last_status==='ok'?'<span style="color:var(--green,#16a34a);font-weight:700">● Synced</span>'
      :s.last_status==='error'?'<span style="color:#dc2626;font-weight:700">● Failed</span>'
      :s.last_status==='running'?'<span style="color:var(--warn,#b45309);font-weight:700">● Syncing…</span>'
      :'<span style="color:var(--muted)">● Not synced yet</span>';
    return `
    <div class="card" data-hi-source="${s.id}" style="margin-bottom:12px">
      <div style="display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap">
        <div style="flex:1;min-width:220px">
          <div style="font-weight:700;font-size:15px">${esc(s.name||'API link')}</div>
          <div style="font-family:monospace;font-size:12px;color:var(--muted);word-break:break-all;margin-top:2px">${esc(s.url)}</div>
          <div style="font-size:12px;color:var(--muted);margin-top:4px">${esc(HI_AUTH_LABELS[s.auth_style]||'')}${s.key_hint?` · key ${esc(s.key_hint)}`:''}</div>
        </div>
        <div style="text-align:right;font-size:12px">
          ${status}<div style="color:var(--muted);margin-top:2px">${_hiWhen(s.last_sync_at)}</div>
          <div style="margin-top:2px"><b>${s.properties}</b> properties · <b>${s.units}</b> units</div>
        </div>
      </div>
      ${s.last_status==='error'&&s.last_error?`<div style="margin-top:8px;font-size:12px;color:#dc2626">${esc(s.last_error)}</div>`
        :s.last_summary?`<div style="margin-top:8px;font-size:12px;color:var(--muted)">Last sync: ${esc(s.last_summary)}</div>`:''}
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px">
        <label style="display:flex;gap:6px;align-items:center;font-size:13px"><input type="checkbox" data-hi-live ${Number(s.sync_enabled)?'checked':''} onchange="hiPatch(${s.id},{sync_enabled:this.checked})"> Live sync</label>
        <select class="form-input" data-hi-every style="width:auto;padding:6px 8px" onchange="hiPatch(${s.id},{sync_minutes:Number(this.value)})">${opts(s.sync_minutes)}</select>
        <div style="flex:1"></div>
        <button class="btn btn-sm" onclick="hiReplaceKey(${s.id})">🔑 Change key</button>
        <button class="btn btn-primary btn-sm" data-hi-sync onclick="hiSyncNow(${s.id},this)">⟳ Sync now</button>
        <button class="btn btn-sm" onclick="hiDelete(${s.id})" title="Stop syncing this link">🗑️</button>
      </div>
    </div>`;
  };
  el.innerHTML=`
    <div style="font-family:var(--disp);font-size:16px;font-weight:700;margin-bottom:4px">🔗 Import properties &amp; units from an API</div>
    <div style="font-size:13px;color:var(--muted);margin-bottom:14px">Paste the API link and key another system gives you (e.g. <code>https://yoursite.com/api/v1/properties</code>). We import every property and its rooms/units, then keep them in sync — new ones are added, changes are updated, and ones removed there are switched off here (never deleted, so bookings stay intact).</div>
    ${_hiSources.map(sourceCard).join('')}
    <div class="card" id="hiAddCard">
      <div class="card-title">➕ Add an API link</div>
      <div style="display:grid;gap:10px;grid-template-columns:1fr 1fr">
        <div style="grid-column:1/-1"><label class="form-label">API link</label><input class="form-input" id="hiUrl" type="url" placeholder="https://gosanchari.com/api/v1/properties"></div>
        <div><label class="form-label">API key</label><input class="form-input" id="hiKey" type="password" autocomplete="off" placeholder="Paste the key"></div>
        <div><label class="form-label">The key is sent as</label><select class="form-input" id="hiAuth">${Object.entries(HI_AUTH_LABELS).map(([k,l])=>`<option value="${k}">${esc(l)}</option>`).join('')}</select></div>
        <div><label class="form-label">Name (optional)</label><input class="form-input" id="hiName" type="text" placeholder="e.g. GoSanchari"></div>
        <div><label class="form-label">Live sync</label><select class="form-input" id="hiEvery">${opts(60)}</select></div>
      </div>
      <div style="font-size:11px;color:var(--muted);margin-top:6px">Tip: add <code>?destination=Munnar</code> or similar to the link to import only part of the catalogue. Fields that come from the API are overwritten on each sync — edit them at the source.</div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn btn-sm" id="hiTestBtn" onclick="hiTest()">🔍 Test link</button>
        <button class="btn btn-primary btn-sm" id="hiAddBtn" onclick="hiAdd()">Import &amp; keep in sync</button>
      </div>
      <div id="hiPreview" style="margin-top:12px"></div>
    </div>`;
}

function _hiForm(){
  return {url:$id('hiUrl').value.trim(), api_key:$id('hiKey').value.trim(), auth_style:$id('hiAuth').value, name:$id('hiName').value.trim(), sync_minutes:Number($id('hiEvery').value)};
}
async function hiTest(){
  const f=_hiForm(), out=$id('hiPreview'), btn=$id('hiTestBtn');
  if(!f.url){ out.innerHTML='<div style="color:#dc2626;font-size:13px">Paste the API link first.</div>'; return; }
  btn.disabled=true; out.innerHTML='<div style="color:var(--muted);font-size:13px">Checking the link…</div>';
  try{
    const d=await _hiApi('POST','/test',f);
    if(!d.ok){ out.innerHTML=`<div style="color:#dc2626;font-size:13px">✗ ${esc(d.error||'The link did not work')}</div>`; return; }
    if(!d.found){ out.innerHTML='<div style="color:var(--warn,#b45309);font-size:13px">The link works but returned no properties.</div>'; return; }
    const money=u=>u.base_rate?`${esc(u.currency||'')} ${Number(u.base_rate).toLocaleString()}`:'price —';
    out.innerHTML=`<div style="color:var(--green,#16a34a);font-size:13px;font-weight:700;margin-bottom:6px">✓ Found ${d.found} propert${d.found===1?'y':'ies'} on the first page. A sample:</div>
      ${d.sample.map(p=>`<div style="border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin-bottom:6px;font-size:13px">
        <b>${esc(p.name)}</b>${p.location?` — ${esc(p.location)}`:''} <span style="color:var(--muted)">· ${p.photos} photo${p.photos===1?'':'s'}</span>
        <div style="color:var(--muted);font-size:12px;margin-top:2px">${p.units.map(u=>`${esc(u.name)} (${money(u)}, ${u.capacity_adults} adults)`).join(' · ')}</div>
      </div>`).join('')}`;
  }catch(e){ out.innerHTML=`<div style="color:#dc2626;font-size:13px">✗ ${esc(e.message)}</div>`; }
  finally{ btn.disabled=false; }
}
async function hiAdd(){
  const f=_hiForm(), out=$id('hiPreview'), btn=$id('hiAddBtn');
  if(!f.url){ out.innerHTML='<div style="color:#dc2626;font-size:13px">Paste the API link first.</div>'; return; }
  btn.disabled=true; btn.textContent='Importing…';
  try{
    const d=await _hiApi('POST','/sources',f);
    if(d.result&&!d.result.ok) showToast('Link saved, but the first sync failed: '+d.result.error,'err');
    else showToast(d.result?.summary?'Imported — '+d.result.summary:'Link saved');
    _hiRefreshCatalog();
    renderHospImport();
  }catch(e){ out.innerHTML=`<div style="color:#dc2626;font-size:13px">✗ ${esc(e.message)}</div>`; btn.disabled=false; btn.textContent='Import & keep in sync'; }
}
async function hiSyncNow(id, btn){
  if(btn){ btn.disabled=true; btn.textContent='Syncing…'; }
  try{
    const d=await _hiApi('POST','/sync',{id});
    if(d.result&&!d.result.ok) showToast('Sync failed: '+d.result.error,'err');
    else showToast(d.result?.summary||'Synced');
    _hiRefreshCatalog();
  }catch(e){ showToast('Sync failed: '+e.message,'err'); }
  renderHospImport();
}
async function hiPatch(id, patch){
  try{ await _hiApi('PATCH','/sources',{id,...patch}); const s=_hiSources.find(x=>x.id===id); if(s) Object.assign(s, patch); showToast('Saved'); }
  catch(e){ showToast('Failed to save: '+e.message,'err'); renderHospImport(); }
}
async function hiReplaceKey(id){
  const key=prompt('Paste the new API key:');
  if(!key||!key.trim()) return;
  await hiPatch(id,{api_key:key.trim()});
  renderHospImport();
}
async function hiDelete(id){
  if(!confirm('Stop syncing this API link?\n\nThe properties and units it imported stay (bookings may use them) — they just stop updating.')) return;
  const off=confirm('Also switch off the properties and units it imported?\n\nOK = switch them off · Cancel = keep them active');
  try{ await _hiApi('DELETE','/sources',{id, remove_records:off}); if(off) _hiRefreshCatalog(); renderHospImport(); }
  catch(e){ showToast('Failed to remove: '+e.message,'err'); }
}
