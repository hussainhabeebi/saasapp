/* ── HOSPITALITY PRO (🏨 Hospitality → ⭐ Pro) ──────────────────────────────────────────────────
   Dashboard side of cloudflare-worker/hospitality-pro.js. Loaded by dashboard.html after its main
   script; only ever rendered from renderHospSubPage('pro'), and that tab is only shown when
   clientRecord.hospitality_pro_enabled==='Yes' (the Worker also 403s every /hospitality/pro/*
   call otherwise). Uses dashboard.html's own globals: CONFIG, ncAuthHeaders, esc, $id, showToast,
   fmtDateShort, clientRecord, hospUnits, hospProperties.
   Bump the ?v= on its <script> tag in dashboard.html when changing this file — sw.js serves
   scripts cache-first. ── */
let _hpPage='overview';
let _hpCache={};

const HP_PAGES=[
  ['overview','📊 Overview'],['holds','🔒 Holds'],['addons','✨ Add-ons'],['tours','🎥 Tours'],
  ['guests','⭐ Loyalty'],['groups','🎉 Groups'],['registrations','📋 Check-in'],['recovery','🔁 Recovery'],['settings','⚙️ Settings'],
];
const HP_FEATURE_LABELS={
  quote:['💬 Instant quote + Hold this room','Dates → guests → room → priced quote → a timed hold with a deposit link.'],
  tour_first:['🎥 Virtual tour first, then price','Room photos and tour links go out before the number does.'],
  addons:['✨ Add-ons at booking','Guests tap extras (dinner, campfire, pickup…) onto the quote.'],
  loyalty:['⭐ Loyalty & repeat guests','Returning numbers are welcomed back and get their tier discount.'],
  recovery:['🔁 Abandoned-inquiry recovery','Nudges quotes nobody held — inside WhatsApp\'s 24h window, never in quiet hours.'],
  groups:['🎉 Group & event enquiries','Weddings, offsites, college tours → a short brief for your team.'],
  registration:['📋 Digital guest registration','ID photos collected on WhatsApp after the booking is confirmed.'],
};
const HP_HOLD_BADGE={active:['Held','warn'],payment_claimed:['Says paid','warn'],converted:['Booked','green'],expired:['Expired','gray'],released:['Released','gray'],conflict:['Conflict','red']};
const HP_GROUP_STATUS=['new','quoted','won','lost'];
const HP_REG_STATUS=['pending','received','verified'];

function _hpInjectStyle(){
  if($id('hpStyle')) return;
  const st=document.createElement('style'); st.id='hpStyle';
  st.textContent=`.hp-nav{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}
.hp-chip{font-family:var(--disp);font-size:12px;font-weight:600;padding:7px 12px;border-radius:20px;border:1px solid var(--line);background:var(--card);color:var(--muted);cursor:pointer}
.hp-chip.active{background:#FEF3C7;border-color:#D97706;color:#B45309}
.hp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:14px}
.hp-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
.hp-row label{font-size:12px;color:var(--muted);min-width:170px}
.hp-feat{display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-bottom:1px solid var(--line)}
.hp-feat:last-child{border-bottom:none}
.hp-muted{font-size:12px;color:var(--muted)}
.hp-tbl td,.hp-tbl th{font-size:12.5px;vertical-align:top}`;
  document.head.appendChild(st);
}

async function hpApi(method, path, body){
  const r=await fetch(`${CONFIG.WORKER_BASE}/hospitality/pro/${path}`,{method,headers:ncAuthHeaders({'Content-Type':'application/json'}),body:body?JSON.stringify(body):undefined});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data.error||('HTTP '+r.status));
  return data;
}
function hpMoney(n,cur){ const v=Math.round(Number(n)||0); return `${cur&&cur!=='INR'?cur+' ':'₹'}${v.toLocaleString('en-IN')}`; }
function hpLoading(el){ el.innerHTML='<div style="text-align:center;padding:40px;color:var(--muted)">Loading…</div>'; }
function hpErr(el,e){ el.innerHTML=`<div class="card" style="color:var(--red)">Couldn't load: ${esc(e.message||e)}</div>`; }
function hpSafeUrl(u){ return /^https?:\/\//i.test(String(u||''))?String(u):''; }
function hpUnitName(id){ const u=(typeof hospUnits!=='undefined'?hospUnits:[]).find(x=>Number(x.Id||x.id)===Number(id)); return u?u.name:'—'; }

function renderHospPro(el){
  _hpInjectStyle();
  el=el||$id('hospContent');
  el.innerHTML=`<div class="hp-nav">${HP_PAGES.map(([k,l])=>`<button class="hp-chip${k===_hpPage?' active':''}" onclick="hpGo('${k}')">${l}</button>`).join('')}</div><div id="hpBody"></div>`;
  hpGo(_hpPage);
}
function hpGo(page){
  _hpPage=page;
  document.querySelectorAll('.hp-chip').forEach((b,i)=>b.classList.toggle('active',HP_PAGES[i]&&HP_PAGES[i][0]===page));
  const el=$id('hpBody'); if(!el) return;
  ({overview:hpRenderOverview,holds:hpRenderHolds,addons:hpRenderAddons,tours:hpRenderTours,guests:hpRenderGuests,
    groups:hpRenderGroups,registrations:hpRenderRegistrations,recovery:hpRenderRecovery,settings:hpRenderSettings}[page]||hpRenderOverview)(el);
}

/* ── Overview ── */
async function hpRenderOverview(el){
  hpLoading(el);
  try{
    const [o,s]=await Promise.all([hpApi('GET','overview'),hpApi('GET','settings')]);
    _hpCache.settings=s;
    const tile=(lbl,val,acc)=>`<div class="stat${acc?' accent':''}"><div class="stat-lbl">${lbl}</div><div class="stat-val" style="font-size:22px">${val}</div></div>`;
    const f=s.config.features;
    el.innerHTML=`
      <div class="hp-grid">
        ${tile('Bookings via Pro (30d)',o.bookings_30d,true)}
        ${tile('Revenue via Pro (30d)',hpMoney(o.revenue_30d))}
        ${tile('Add-on revenue (30d)',hpMoney(o.addons_30d))}
        ${tile('Recovered quotes (30d)',`${o.recovery_recovered_30d}<span class="hp-muted"> / ${o.recovery_nudged_30d} nudged</span>`)}
        ${tile('Active holds',o.holds_active)}
        ${tile('Payments to verify',o.holds_awaiting,o.holds_awaiting>0)}
        ${tile('Open group enquiries',o.groups_open)}
        ${tile('Check-ins awaiting IDs',o.registrations_pending)}
      </div>
      ${o.holds_awaiting?`<div class="card" style="border-left:4px solid #D97706;margin-bottom:14px">💳 <b>${o.holds_awaiting}</b> guest${o.holds_awaiting===1?' says they have':'s say they have'} paid a deposit. <a href="#" onclick="hpGo('holds');return false">Verify &amp; confirm →</a></div>`:''}
      ${o.holds_conflict?`<div class="card" style="border-left:4px solid var(--red);margin-bottom:14px">⚠️ <b>${o.holds_conflict}</b> hold${o.holds_conflict===1?'':'s'} clashed with a booking made elsewhere. <a href="#" onclick="hpGo('holds');return false">Review →</a></div>`:''}
      <div class="card">
        <div class="card-title">What Hospitality Pro does on WhatsApp</div>
        ${Object.keys(HP_FEATURE_LABELS).map(k=>`<div class="hp-feat"><span class="badge ${f[k]?'green':'gray'}" style="min-width:34px;justify-content:center">${f[k]?'ON':'OFF'}</span><div><b style="font-size:13px">${HP_FEATURE_LABELS[k][0]}</b><div class="hp-muted">${HP_FEATURE_LABELS[k][1]}</div></div></div>`).join('')}
        <div class="hp-muted" style="margin-top:10px">Everything else in your Hospitality bot works exactly as before — Pro only steps in when a guest wants to book, asks for a group/event, or is paying / checking in. Toggle features in <a href="#" onclick="hpGo('settings');return false">⚙️ Settings</a>.</div>
      </div>`;
  }catch(e){ hpErr(el,e); }
}

/* ── Holds ── */
async function hpRenderHolds(el, filter=''){
  hpLoading(el);
  try{
    const {list}=await hpApi('GET','holds');
    _hpCache.holds=list;
    const rows=filter?list.filter(h=>h.status===filter):list;
    el.innerHTML=`
      <div class="hp-row">
        <div style="font-family:var(--disp);font-size:16px;font-weight:700;flex:1">🔒 Holds <span class="hp-muted">(${list.length})</span></div>
        <select class="form-input" style="max-width:170px;padding:8px 10px" onchange="hpRenderHolds($id('hpBody'),this.value)">
          <option value="">All</option>${Object.keys(HP_HOLD_BADGE).map(s=>`<option value="${s}"${s===filter?' selected':''}>${HP_HOLD_BADGE[s][0]}</option>`).join('')}
        </select>
      </div>
      <div class="s-note" style="margin:0 0 10px">A hold reserves a room for the guest while they pay the deposit. <b>Confirm</b> turns it into a normal confirmed booking (it appears in 📖 Bookings) and sends the guest their confirmation + check-in request.</div>
      <div class="tbl-wrap"><table class="leads-tbl hp-tbl" style="width:100%">
        <thead><tr><th>#</th><th>Guest</th><th>Room</th><th>Dates</th><th>Total</th><th>Deposit</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${rows.length?rows.map(h=>{
          const [lbl,cls]=HP_HOLD_BADGE[h.status]||[h.status,'gray'];
          let addons=[]; try{addons=JSON.parse(h.addons_json||'[]');}catch(e){}
          const open=['active','payment_claimed','expired','conflict'].includes(h.status);
          const pay=hpSafeUrl(h.payment_url);
          return `<tr>
            <td>${h.id}</td>
            <td>${esc(h.guest_name||'—')}<div class="hp-muted">${esc(h.guest_phone||'')}</div></td>
            <td>${esc(h.unit_name||hpUnitName(h.unit_id))}${addons.length?`<div class="hp-muted">+ ${addons.map(a=>esc(a.name)).join(', ')}</div>`:''}</td>
            <td>${fmtDateShort(h.check_in)} → ${fmtDateShort(h.check_out)}<div class="hp-muted">${h.adults} adults${h.children?` + ${h.children} kids`:''}</div></td>
            <td>${hpMoney(h.total_amount,h.currency)}${h.discount_amount?`<div class="hp-muted">incl. ${esc(h.discount_label)} −${hpMoney(h.discount_amount,h.currency)}</div>`:''}</td>
            <td>${hpMoney(h.deposit_amount,h.currency)}${pay?`<div><a href="${esc(pay)}" target="_blank" rel="noopener" class="hp-muted">payment link</a></div>`:''}${h.payment_ref?`<div class="hp-muted">${hpSafeUrl(h.payment_ref)?`<a href="${esc(h.payment_ref)}" target="_blank" rel="noopener">screenshot</a>`:esc(h.payment_ref)}</div>`:''}</td>
            <td><span class="badge ${cls}">${lbl}</span>${h.status==='active'?`<div class="hp-muted">until ${new Date(h.expires_at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}</div>`:''}${h.booking_id?`<div class="hp-muted">booking #${h.booking_id}</div>`:''}</td>
            <td style="white-space:nowrap">${open?`<button class="btn btn-primary btn-sm" onclick="hpConfirmHold(${h.id})">✓ Confirm</button> <button class="btn-ghost" title="Release" onclick="hpReleaseHold(${h.id})">✕</button>`:''}</td>
          </tr>`;}).join(''):'<tr><td colspan="8" class="empty-state">No holds yet — they appear here when a guest taps “🔒 Hold this room” on WhatsApp.</td></tr>'}
        </tbody></table></div>`;
  }catch(e){ hpErr(el,e); }
}
async function hpConfirmHold(id){
  const h=(_hpCache.holds||[]).find(x=>x.id===id);
  const ref=prompt(`Confirm hold #${id}${h?` for ${h.guest_name||h.guest_phone}`:''}?\n\nOptional: payment reference (UPI txn id, etc.)`, h&&h.payment_ref&&!hpSafeUrl(h.payment_ref)?h.payment_ref:'');
  if(ref===null) return;
  try{ const r=await hpApi('POST','holds/confirm',{id,payment_ref:ref||undefined}); showToast(r.already?'Already confirmed':'✓ Booking confirmed — guest notified'); if(typeof _hospLoaded!=='undefined') _hospLoaded=false; }
  catch(e){ alert(e.message); }
  hpRenderHolds($id('hpBody'));
}
async function hpReleaseHold(id){
  if(!confirm(`Release hold #${id}? The room becomes available to other guests again.`)) return;
  try{ await hpApi('POST','holds/release',{id}); showToast('Hold released'); }catch(e){ alert(e.message); }
  hpRenderHolds($id('hpBody'));
}

/* ── Add-ons ── */
const HP_PRICE_TYPES={per_booking:'per booking',per_night:'per night',per_guest:'per guest',per_guest_night:'per guest / night'};
async function hpRenderAddons(el){
  hpLoading(el);
  try{
    const {list}=await hpApi('GET','addons');
    el.innerHTML=`
      <div class="hp-row"><div style="font-family:var(--disp);font-size:16px;font-weight:700;flex:1">✨ Add-ons</div></div>
      <div class="s-note" style="margin:0 0 10px">Offered as tap-to-add extras during the WhatsApp quote, and added to the total. Ideas: candlelight dinner, campfire, bonfire &amp; BBQ, Ayurvedic massage, jeep safari, airport pickup, birthday decoration, houseboat lunch upgrade.</div>
      <div class="card" style="margin-bottom:12px"><div class="hp-row" style="margin:0">
        <input class="form-input" id="hpAddName" placeholder="Name (e.g. Candlelight Dinner)" style="flex:2;min-width:180px">
        <input class="form-input" id="hpAddPrice" type="number" min="0" placeholder="Price" style="max-width:110px">
        <select class="form-input" id="hpAddType" style="max-width:170px">${Object.entries(HP_PRICE_TYPES).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select>
        <input class="form-input" id="hpAddDesc" placeholder="Short note (optional)" style="flex:2;min-width:160px">
        <button class="btn btn-primary btn-sm" onclick="hpAddAddon()">+ Add</button>
      </div></div>
      <div class="tbl-wrap"><table class="leads-tbl hp-tbl" style="width:100%">
        <thead><tr><th>Name</th><th>Price</th><th>Charged</th><th>Note</th><th>Order</th><th>Active</th><th></th></tr></thead>
        <tbody>${list.length?list.map(a=>`<tr>
          <td><input class="form-input" value="${esc(a.name)}" onchange="hpPatchAddon(${a.id},{name:this.value})" style="min-width:150px"></td>
          <td><input class="form-input" type="number" min="0" value="${a.price}" onchange="hpPatchAddon(${a.id},{price:Number(this.value)})" style="max-width:100px"></td>
          <td><select class="form-input" onchange="hpPatchAddon(${a.id},{price_type:this.value})">${Object.entries(HP_PRICE_TYPES).map(([k,v])=>`<option value="${k}"${k===a.price_type?' selected':''}>${v}</option>`).join('')}</select></td>
          <td><input class="form-input" value="${esc(a.description||'')}" onchange="hpPatchAddon(${a.id},{description:this.value})"></td>
          <td><input class="form-input" type="number" value="${a.sort_order||0}" onchange="hpPatchAddon(${a.id},{sort_order:Number(this.value)})" style="max-width:64px"></td>
          <td><input type="checkbox" ${a.active?'checked':''} onchange="hpPatchAddon(${a.id},{active:this.checked})"></td>
          <td><button class="btn-ghost" title="Delete" onclick="hpDeleteAddon(${a.id})">🗑</button></td>
        </tr>`).join(''):'<tr><td colspan="7" class="empty-state">No add-ons yet.</td></tr>'}</tbody></table></div>`;
  }catch(e){ hpErr(el,e); }
}
async function hpAddAddon(){
  const name=$id('hpAddName').value.trim();
  if(!name){ alert('Enter a name'); return; }
  try{ await hpApi('POST','addons',{name,price:Number($id('hpAddPrice').value)||0,price_type:$id('hpAddType').value,description:$id('hpAddDesc').value.trim()}); showToast('✓ Add-on added'); }
  catch(e){ alert(e.message); }
  hpRenderAddons($id('hpBody'));
}
async function hpPatchAddon(id,fields){ try{ await hpApi('PATCH','addons',{id,...fields}); showToast('✓ Saved'); }catch(e){ alert(e.message); } }
async function hpDeleteAddon(id){ if(!confirm('Delete this add-on?')) return; try{ await hpApi('DELETE','addons',{id}); }catch(e){ alert(e.message); } hpRenderAddons($id('hpBody')); }

/* ── Tours ── */
async function hpRenderTours(el){
  hpLoading(el);
  try{
    const {list}=await hpApi('GET','tours');
    const units=typeof hospUnits!=='undefined'?hospUnits:[];
    const props=typeof hospProperties!=='undefined'?hospProperties:[];
    const target=t=>t.unit_id?`🏠 ${esc(hpUnitName(t.unit_id))}`:(t.property_id?`🏨 ${esc((props.find(p=>Number(p.Id||p.id)===Number(t.property_id))||{}).name||'Property')}`:'🌴 Whole resort');
    el.innerHTML=`
      <div class="hp-row"><div style="font-family:var(--disp);font-size:16px;font-weight:700;flex:1">🎥 Virtual tours</div></div>
      <div class="s-note" style="margin:0 0 10px">Sent with the room's photos <b>before</b> the guest sees the price — a 360° tour, YouTube walkthrough, Instagram reel or Google Maps Street View link. Room photos themselves come from 🏠 Units.</div>
      <div class="card" style="margin-bottom:12px"><div class="hp-row" style="margin:0">
        <input class="form-input" id="hpTourTitle" placeholder="Title (e.g. 360° villa tour)" style="flex:1;min-width:160px">
        <input class="form-input" id="hpTourUrl" placeholder="https://…" style="flex:2;min-width:200px">
        <select class="form-input" id="hpTourFor" style="max-width:220px">
          <option value="">🌴 Whole resort (every room)</option>
          ${units.map(u=>`<option value="u:${u.Id||u.id}">🏠 ${esc(u.name)}</option>`).join('')}
          ${props.map(p=>`<option value="p:${p.Id||p.id}">🏨 ${esc(p.name)}</option>`).join('')}
        </select>
        <button class="btn btn-primary btn-sm" onclick="hpAddTour()">+ Add</button>
      </div></div>
      <div class="tbl-wrap"><table class="leads-tbl hp-tbl" style="width:100%">
        <thead><tr><th>Title</th><th>Link</th><th>Shown for</th><th></th></tr></thead>
        <tbody>${list.length?list.map(t=>`<tr><td>${esc(t.title||'Virtual tour')}</td><td><a href="${esc(hpSafeUrl(t.url))}" target="_blank" rel="noopener">${esc(t.url)}</a></td><td>${target(t)}</td><td><button class="btn-ghost" onclick="hpDeleteTour(${t.id})">🗑</button></td></tr>`).join(''):'<tr><td colspan="4" class="empty-state">No tour links yet.</td></tr>'}</tbody></table></div>`;
  }catch(e){ hpErr(el,e); }
}
async function hpAddTour(){
  const url=$id('hpTourUrl').value.trim(), f=$id('hpTourFor').value;
  const body={title:$id('hpTourTitle').value.trim(),url};
  if(f.startsWith('u:')) body.unit_id=Number(f.slice(2)); else if(f.startsWith('p:')) body.property_id=Number(f.slice(2));
  try{ await hpApi('POST','tours',body); showToast('✓ Tour added'); }catch(e){ alert(e.message); return; }
  hpRenderTours($id('hpBody'));
}
async function hpDeleteTour(id){ if(!confirm('Remove this tour link?')) return; try{ await hpApi('DELETE','tours',{id}); }catch(e){ alert(e.message); } hpRenderTours($id('hpBody')); }

/* ── Loyalty ── */
async function hpRenderGuests(el){
  hpLoading(el);
  try{
    const [{list},s]=await Promise.all([hpApi('GET','guests'),_hpCache.settings?Promise.resolve(_hpCache.settings):hpApi('GET','settings')]);
    _hpCache.settings=s;
    const loy=s.config.loyalty;
    const tierBadge=t=>t?`<span class="badge ${t==='Platinum'?'green':t==='Gold'?'warn':'gray'}">${t}</span>`:'<span class="hp-muted">—</span>';
    el.innerHTML=`
      <div class="hp-row"><div style="font-family:var(--disp);font-size:16px;font-weight:700;flex:1">⭐ Loyalty &amp; repeat guests <span class="hp-muted">(${list.length})</span></div></div>
      <div class="s-note" style="margin:0 0 10px">Built from your 📖 Bookings by phone number. Tiers by completed stays — Silver 1+ (${loy.silver_pct}% off), Gold 3+ (${loy.gold_pct}%), Platinum 5+ (${loy.platinum_pct}%). The discount is applied to the room rate automatically when a returning guest asks for a quote on WhatsApp.</div>
      <div class="tbl-wrap"><table class="leads-tbl hp-tbl" style="width:100%">
        <thead><tr><th>Guest</th><th>Phone</th><th>Tier</th><th>Stays</th><th>Upcoming</th><th>Total spent</th><th>Last stay</th></tr></thead>
        <tbody>${list.length?list.map(g=>`<tr><td>${esc(g.name||'—')}</td><td>${esc(g.phone)}</td><td>${tierBadge(g.tier)}</td><td>${g.stays}</td><td>${g.upcoming?`${g.upcoming} · ${fmtDateShort(g.next_stay)}`:'—'}</td><td>${hpMoney(g.spent)}</td><td>${g.last_stay?fmtDateShort(g.last_stay):'—'}</td></tr>`).join(''):'<tr><td colspan="7" class="empty-state">No guests with a phone number on their bookings yet.</td></tr>'}</tbody></table></div>`;
  }catch(e){ hpErr(el,e); }
}

/* ── Groups ── */
async function hpRenderGroups(el){
  hpLoading(el);
  try{
    const {list}=await hpApi('GET','groups');
    el.innerHTML=`
      <div class="hp-row"><div style="font-family:var(--disp);font-size:16px;font-weight:700;flex:1">🎉 Group &amp; event enquiries <span class="hp-muted">(${list.length})</span></div></div>
      <div class="s-note" style="margin:0 0 10px">The bot collects the occasion, group size, dates and requirements, then hands over with a private note in the chat. Track each proposal here.</div>
      <div class="tbl-wrap"><table class="leads-tbl hp-tbl" style="width:100%">
        <thead><tr><th>Received</th><th>Guest</th><th>Occasion</th><th>Size</th><th>Dates</th><th>Requirements</th><th>Status</th><th>Notes</th></tr></thead>
        <tbody>${list.length?list.map(g=>`<tr>
          <td>${fmtDateShort(g.created_at)}</td><td>${esc(g.guest_name||'—')}<div class="hp-muted">${esc(g.guest_phone||'')}</div></td>
          <td>${esc(g.event_type)}</td><td>${g.group_size||'—'}</td>
          <td>${g.check_in?`${fmtDateShort(g.check_in)}${g.check_out?` → ${fmtDateShort(g.check_out)}`:''}`:'<span class="hp-muted">flexible</span>'}</td>
          <td style="max-width:240px">${esc(g.requirements||'—')}</td>
          <td><select class="form-input" onchange="hpPatchGroup(${g.id},{status:this.value})">${HP_GROUP_STATUS.map(s=>`<option value="${s}"${s===g.status?' selected':''}>${s[0].toUpperCase()+s.slice(1)}</option>`).join('')}</select></td>
          <td><input class="form-input" value="${esc(g.notes||'')}" placeholder="Proposal sent, ₹…" onchange="hpPatchGroup(${g.id},{notes:this.value})"></td>
        </tr>`).join(''):'<tr><td colspan="8" class="empty-state">No group enquiries yet.</td></tr>'}</tbody></table></div>`;
  }catch(e){ hpErr(el,e); }
}
async function hpPatchGroup(id,fields){ try{ await hpApi('PATCH','groups',{id,...fields}); showToast('✓ Saved'); }catch(e){ alert(e.message); } }

/* ── Registrations ── */
async function hpRenderRegistrations(el){
  hpLoading(el);
  try{
    const {list}=await hpApi('GET','registrations');
    el.innerHTML=`
      <div class="hp-row"><div style="font-family:var(--disp);font-size:16px;font-weight:700;flex:1">📋 Digital check-in <span class="hp-muted">(${list.length})</span></div></div>
      <div class="s-note" style="margin:0 0 10px">After a booking is confirmed through Pro, the guest is asked on WhatsApp for ID photos of each adult. Open each document, check it, and mark the check-in <b>Verified</b>. For foreign nationals, file Form C as usual.</div>
      <div class="tbl-wrap"><table class="leads-tbl hp-tbl" style="width:100%">
        <thead><tr><th>Guest</th><th>Stay</th><th>Documents</th><th>Status</th></tr></thead>
        <tbody>${list.length?list.map(r=>{
          let docs=[]; try{docs=JSON.parse(r.documents_json||'[]');}catch(e){}
          return `<tr>
            <td>${esc(r.guest_name||'—')}<div class="hp-muted">${esc(r.guest_phone||'')}</div></td>
            <td>${esc(r.unit_name||'—')}<div class="hp-muted">${r.check_in?`${fmtDateShort(r.check_in)} → ${fmtDateShort(r.check_out)}`:''}${r.booking_id?` · #${r.booking_id}`:''}</div></td>
            <td>${docs.length?docs.map((d,i)=>hpSafeUrl(d.url)?`<a href="${esc(d.url)}" target="_blank" rel="noopener">ID ${i+1}</a>`:`ID ${i+1}`).join(' · '):'<span class="hp-muted">none yet</span>'}</td>
            <td><select class="form-input" onchange="hpPatchReg(${r.id},this.value)">${HP_REG_STATUS.map(s=>`<option value="${s}"${s===r.status?' selected':''}>${s[0].toUpperCase()+s.slice(1)}</option>`).join('')}</select></td>
          </tr>`;}).join(''):'<tr><td colspan="4" class="empty-state">No check-ins yet.</td></tr>'}</tbody></table></div>`;
  }catch(e){ hpErr(el,e); }
}
async function hpPatchReg(id,status){ try{ await hpApi('PATCH','registrations',{id,status}); showToast('✓ Saved'); }catch(e){ alert(e.message); } }

/* ── Recovery ── */
async function hpRenderRecovery(el){
  hpLoading(el);
  try{
    const {list}=await hpApi('GET','recovery');
    const badge={active:['Watching','warn'],held:['Held','green'],converted:['Booked','green'],stopped:['Stopped','gray'],done:['Done','gray']};
    el.innerHTML=`
      <div class="hp-row"><div style="font-family:var(--disp);font-size:16px;font-weight:700;flex:1">🔁 Abandoned-inquiry recovery</div></div>
      <div class="s-note" style="margin:0 0 10px">Guests who saw a price but didn't hold. The bot re-checks real availability and sends a short nudge with a “🔒 Hold this room” button — only inside WhatsApp's 24-hour reply window, never in quiet hours, never to opted-out guests or chats a teammate has taken over.</div>
      <div class="tbl-wrap"><table class="leads-tbl hp-tbl" style="width:100%">
        <thead><tr><th>Guest</th><th>Room</th><th>Dates</th><th>Quoted</th><th>Nudges sent</th><th>Last reply</th><th>Status</th></tr></thead>
        <tbody>${list.length?list.map(r=>{ const [l,c]=badge[r.status]||[r.status,'gray']; return `<tr>
          <td>${esc(r.guest_name||'—')}</td><td>${esc(r.unit_name||'—')}</td>
          <td>${r.check_in?`${fmtDateShort(r.check_in)} → ${fmtDateShort(r.check_out)}`:'—'}</td>
          <td>${hpMoney(r.quoted_total,r.currency)}</td><td>${r.step}</td>
          <td>${r.last_activity_at?new Date(r.last_activity_at).toLocaleString([], {day:'numeric',month:'short',hour:'numeric',minute:'2-digit'}):'—'}</td>
          <td><span class="badge ${c}">${l}</span></td></tr>`;}).join(''):'<tr><td colspan="7" class="empty-state">Nothing to recover yet.</td></tr>'}</tbody></table></div>`;
  }catch(e){ hpErr(el,e); }
}

/* ── Settings ── */
async function hpRenderSettings(el){
  hpLoading(el);
  try{
    const s=await hpApi('GET','settings');
    _hpCache.settings=s;
    const c=s.config;
    const num=(id,val,min,max,w)=>`<input class="form-input" type="number" id="${id}" value="${val}" min="${min}" max="${max}" style="max-width:${w||100}px">`;
    const hook=`${CONFIG.WORKER_BASE}/hospitality/pro/razorpay/webhook`;
    const tz=[[330,'India (IST, UTC+5:30)'],[240,'Gulf (UTC+4)'],[180,'UTC+3'],[345,'Nepal (UTC+5:45)'],[360,'UTC+6'],[420,'UTC+7'],[480,'UTC+8'],[0,'UTC'],[60,'UTC+1'],[-300,'UTC-5']];
    if(!tz.some(([v])=>v===c.tz_offset_min)) tz.unshift([c.tz_offset_min,`UTC${c.tz_offset_min>=0?'+':''}${c.tz_offset_min/60}`]);
    el.innerHTML=`
      <div class="card" style="margin-bottom:14px">
        <div class="card-title">Features</div>
        ${Object.keys(HP_FEATURE_LABELS).map(k=>`<label class="hp-feat" style="cursor:pointer"><input type="checkbox" class="hp-feat-cb" data-k="${k}" ${c.features[k]?'checked':''} style="margin-top:3px"><div><b style="font-size:13px">${HP_FEATURE_LABELS[k][0]}</b><div class="hp-muted">${HP_FEATURE_LABELS[k][1]}</div></div></label>`).join('')}
      </div>
      <div class="card" style="margin-bottom:14px">
        <div class="card-title">💳 Hold &amp; deposit</div>
        <div class="hp-row"><label>Hold lasts (minutes)</label>${num('hpHoldMin',c.hold_minutes,15,1440)}</div>
        <div class="hp-row"><label>Deposit to confirm (%)</label>${num('hpDeposit',c.deposit_pct,0,100)}<span class="hp-muted">0 = no deposit, staff confirm manually</span></div>
        <div class="hp-row"><label>Payment method</label><select class="form-input" id="hpPayMode" style="max-width:280px" onchange="$id('hpRzpBox').style.display=this.value==='razorpay'?'':'none'">
          <option value="manual"${c.payment_mode==='manual'?' selected':''}>Manual — show my UPI / bank details</option>
          <option value="razorpay"${c.payment_mode==='razorpay'?' selected':''}>Razorpay — auto payment link + auto confirm</option></select></div>
        <div class="hp-row" style="align-items:flex-start"><label>UPI / bank details or payment link<div class="hp-muted">Shown with every hold. Also the fallback if Razorpay fails.</div></label><textarea class="form-input" id="hpPayText" rows="3" style="flex:1;min-width:240px" placeholder="UPI: myresort@okhdfc&#10;or https://rzp.io/l/myresort">${esc(c.payment_instructions)}</textarea></div>
        <div id="hpRzpBox" style="display:${c.payment_mode==='razorpay'?'':'none'};border-top:1px solid var(--line);padding-top:10px">
          <div class="hp-row"><label>Razorpay Key ID</label><input class="form-input" id="hpRzpKey" value="${esc(s.razorpay_key_id||'')}" placeholder="rzp_live_…" style="max-width:260px"></div>
          <div class="hp-row"><label>Razorpay Key Secret</label><input class="form-input" id="hpRzpSecret" type="password" placeholder="${s.razorpay_connected?'•••••• saved — leave blank to keep':'paste key secret'}" style="max-width:260px"></div>
          <div class="hp-row"><label>Webhook secret</label><input class="form-input" id="hpRzpHook" type="password" placeholder="${s.razorpay_webhook_ready?'•••••• saved — leave blank to keep':'paste webhook secret'}" style="max-width:260px"></div>
          <div class="hp-muted">In Razorpay → Settings → Webhooks, add <code style="user-select:all">${esc(hook)}</code> with the event <b>payment_link.paid</b> and the same secret. Paid holds then confirm themselves.</div>
        </div>
      </div>
      <div class="card" style="margin-bottom:14px">
        <div class="card-title">⭐ Loyalty discounts (on the room rate)</div>
        <div class="hp-row"><label>Silver — 1+ stays (%)</label>${num('hpLoyS',c.loyalty.silver_pct,0,50)}</div>
        <div class="hp-row"><label>Gold — 3+ stays (%)</label>${num('hpLoyG',c.loyalty.gold_pct,0,50)}</div>
        <div class="hp-row"><label>Platinum — 5+ stays (%)</label>${num('hpLoyP',c.loyalty.platinum_pct,0,50)}</div>
      </div>
      <div class="card" style="margin-bottom:14px">
        <div class="card-title">🔁 Recovery, groups &amp; timing</div>
        <div class="hp-row"><label>Nudge after (hours idle)</label><input class="form-input" id="hpRecHours" value="${c.recovery_hours.join(', ')}" style="max-width:140px"><span class="hp-muted">comma-separated, each under 23 (WhatsApp's 24h window). Blank = no nudges.</span></div>
        <div class="hp-row"><label>Quiet hours (no nudges)</label>${num('hpQuietS',c.quiet_start,0,23,70)}<span class="hp-muted">to</span>${num('hpQuietE',c.quiet_end,0,23,70)}<span class="hp-muted">(24h clock)</span></div>
        <div class="hp-row"><label>Time zone</label><select class="form-input" id="hpTz" style="max-width:240px">${tz.map(([v,l])=>`<option value="${v}"${v===c.tz_offset_min?' selected':''}>${l}</option>`).join('')}</select></div>
        <div class="hp-row"><label>Treat as a group from (guests)</label>${num('hpGroupMin',c.group_min_guests,4,500)}</div>
      </div>
      <div class="card" style="margin-bottom:14px">
        <div class="card-title">📋 Check-in request message</div>
        <textarea class="form-input" id="hpRegMsg" rows="4" style="width:100%" placeholder="Leave blank for the default: asks for a government ID photo for each adult guest (passport + visa for foreign nationals).">${esc(c.registration_message)}</textarea>
      </div>
      <div class="hp-row"><button class="save-btn" onclick="hpSaveSettings()">Save settings</button><span class="save-msg" id="hpSaveMsg"></span></div>`;
  }catch(e){ hpErr(el,e); }
}
async function hpSaveSettings(){
  const msg=$id('hpSaveMsg'); msg.textContent=''; msg.className='save-msg';
  const features={}; document.querySelectorAll('.hp-feat-cb').forEach(cb=>{ features[cb.dataset.k]=cb.checked; });
  const hoursRaw=$id('hpRecHours').value.trim();
  const config={
    features, hold_minutes:Number($id('hpHoldMin').value), deposit_pct:Number($id('hpDeposit').value),
    payment_mode:$id('hpPayMode').value, payment_instructions:$id('hpPayText').value,
    loyalty:{silver_pct:Number($id('hpLoyS').value), gold_pct:Number($id('hpLoyG').value), platinum_pct:Number($id('hpLoyP').value)},
    recovery_hours:hoursRaw?hoursRaw.split(/[,\s]+/).map(Number).filter(n=>n>0):[],
    quiet_start:Number($id('hpQuietS').value), quiet_end:Number($id('hpQuietE').value), tz_offset_min:Number($id('hpTz').value),
    group_min_guests:Number($id('hpGroupMin').value), registration_message:$id('hpRegMsg').value,
  };
  const body={config};
  const key=$id('hpRzpKey')?.value.trim(), sec=$id('hpRzpSecret')?.value.trim(), hook=$id('hpRzpHook')?.value.trim();
  if(key!==undefined) body.razorpay_key_id=key;
  if(sec) body.razorpay_key_secret=sec;
  if(hook) body.razorpay_webhook_secret=hook;
  if(config.payment_mode==='razorpay' && !key){ msg.textContent='Add your Razorpay Key ID, or switch to Manual.'; msg.className='save-msg err'; return; }
  try{
    const r=await hpApi('PATCH','settings',body);
    _hpCache.settings=null;
    showToast(config.payment_mode==='razorpay'&&!r.razorpay_connected?'✓ Saved — Razorpay key secret still missing':'✓ Settings saved');
    hpRenderSettings($id('hpBody'));
  }catch(e){ msg.textContent='Error: '+e.message; msg.className='save-msg err'; }
}
