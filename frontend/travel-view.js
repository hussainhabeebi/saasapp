/* ── TRAVEL WORKSPACE (industry === 'travel') ────────────────────────────────────────────────────
   A separate app shell for travel clients: its own top nav, mobile bottom nav and "More" sheet,
   a travel "Today" home (#pageTravelhome) and a Departures calendar (#pageDepartures). Everything
   else is reused, not rebuilt: Inquiries is the Leads page, Inbox is Chats, and Trips / Quotes /
   Packages / Visa / Umrah / Finance are travel-agency.html sub-pages inside the existing
   #agencyFrame (driven by ?tab= on first load and a 'ta:goto' postMessage after that). Live
   Flights embeds live-travel-agency.html in its own frame.
   A user can switch back to the classic CRM nav (More ▾ → Classic CRM view); that choice is
   per-browser in localStorage, since it's a viewing preference, not account config.
   Uses dashboard.html's own globals: $id, esc, navigate, PAGE_HOST, MORE_GROUP, clientRecord,
   clientId, sessionToken, allLeads, _taBookings/_taUmrahGroups/_taCarBookings, taLoad,
   renderAgency, openAddLead, openDetail, closeMoreSheet, isAccountOwner, myEmail,
   getTeamPermissions, TODAY.
   Bump the ?v= on its <script> tag in dashboard.html when changing this file — sw.js serves
   scripts cache-first. ── */

// Travel pages that are really a travel-agency.html sub-page inside #pageAgency.
const TV_AGENCY_PAGES={
  tvtrips:'bookings', tvquotes:'itineraries', tvpackages:'packages', tvvisa:'visas',
  tvumrah:'umrah', tvfinance:'finance', tvservices:'services', tvattest:'attestation',
  tvgroupfares:'groupfares', tvspecialfares:'specialfares', tvcars:'cars',
};
Object.keys(TV_AGENCY_PAGES).forEach(p=>{ PAGE_HOST[p]='agency'; });
// Pages that need the Travel Agency module (ta_enabled) and the 'agency' module permission.
const TV_AGENCY_GATED=new Set([...Object.keys(TV_AGENCY_PAGES),'departures','tvlive']);
// Mobile: everything except Today / Trips (own bottom-nav buttons) lights up the More button.
MORE_GROUP.push(...Object.keys(TV_AGENCY_PAGES).filter(p=>p!=='tvtrips'),'departures','tvlive');

// Desktop nav: [page, label] or a dropdown group {group, items:[[page,label],…]}.
const TV_NAV=[
  ['travelhome','🏠 Today'],
  ['leads','📥 Inquiries'],
  ['chats','💬 Inbox'],
  ['tvtrips','🎫 Trips'],
  ['tvquotes','🗺️ Quotes & Itineraries'],
  ['departures','📅 Departures'],
  {group:'🧳 Products', items:[
    ['tvpackages','📦 Packages'],['tvvisa','🛂 Visa & Docs'],['tvumrah','🕌 Umrah / Hajj'],
    ['tvservices','🗂️ Services'],['tvattest','📋 Attestation'],['tvgroupfares','👥 Group Fares'],
    ['tvspecialfares','🎟️ Special Fares'],['tvcars','🚗 Cars'],
  ]},
  ['tvlive','✈️ Live Flights'],
  ['tvfinance','💰 Finance'],
  {group:'📣 Grow', items:[
    ['broadcast','📢 Campaigns'],['followups','🔁 Follow-ups'],['reports','📈 Reports'],['team','📊 Team'],
  ]},
  ['settings','⚙️ Settings'],
  {group:'⋯ More', items:[
    ['humandeals','🤝 Human Deals'],['bizai','🤖 AI Assistant'],['accounting','💰 Accounting'],
    ['billing','💳 Billing'],['home','🏠 Classic Home'],['__classic','↩️ Classic CRM view'],
  ]},
];
// Mobile "More" sheet: travel items shown above the regular ones.
const TV_MORE=[
  ['departures','📅','Departures'],['tvquotes','🗺️','Quotes'],['tvpackages','📦','Packages'],
  ['tvvisa','🛂','Visa & Docs'],['tvumrah','🕌','Umrah'],['tvlive','✈️','Live Flights'],
  ['tvfinance','💰','Finance'],['__classic','↩️','Classic view'],
];

const TV_PREF_KEY=()=>'lv_travel_view_'+clientId;
function tvPref(){ try{ return localStorage.getItem(TV_PREF_KEY())||'travel'; }catch(e){ return 'travel'; } }
function tvSetPref(v){ try{ localStorage.setItem(TV_PREF_KEY(),v); }catch(e){} }
function isTravelView(){ return clientRecord?.industry==='travel' && tvPref()!=='classic'; }
function tvAgencyEnabled(){ return clientRecord?.ta_enabled==='Yes'; }
// Same rule as applyUserModulePermissions(): owner or no saved restriction = everything.
function tvCanSee(page){
  if(TV_AGENCY_GATED.has(page)){
    if(!tvAgencyEnabled()) return false;
    page='agency';
  }
  if(page==='travelhome'||page==='__classic') return true;
  if(!clientRecord||!myEmail||isAccountOwner()) return true;
  const mine=getTeamPermissions()[myEmail];
  if(!mine||!Array.isArray(mine.modules)) return true;
  if(page==='followups') page='broadcast';
  if(typeof ALWAYS_ON_MODULES!=='undefined'&&ALWAYS_ON_MODULES.has(page)) return true;
  const known=(typeof MODULE_PERMISSIONS!=='undefined'?MODULE_PERMISSIONS:[]).some(m=>m.key===page);
  return !known||mine.modules.includes(page);
}

function tvInjectStyle(){
  if($id('tvStyle')) return;
  const st=document.createElement('style'); st.id='tvStyle';
  st.textContent=`
#travelNav{display:none;gap:2px;padding:0 18px;border-bottom:1px solid var(--line);background:var(--card);flex-shrink:0;flex-wrap:wrap}
@media(min-width:768px){html.tv-mode #travelNav{display:flex}html.tv-mode #desktopNav{display:none!important}}
#travelNav .dnTab{white-space:nowrap}
#travelNav .tv-dd{display:none;position:absolute;top:100%;left:0;min-width:200px;background:var(--card);border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow);padding:6px;z-index:60;flex-direction:column}
#travelNav .dnGroup:hover .tv-dd,#travelNav .dnGroup:focus-within .tv-dd{display:flex}
#travelNav .tv-dd .dnTab{text-align:left;border-bottom:none;border-radius:6px;padding:8px 12px;margin:0}
#travelNav .tv-dd .dnTab:hover{background:var(--accent-soft)}
#travelNav .tv-dd .dnTab.active{background:var(--accent-soft)}
html.tv-mode .tv-hide{display:none!important}
html:not(.tv-mode) .tv-only{display:none!important}
.tv-hero{background:linear-gradient(135deg,var(--accent),#38BDF8);color:#fff;border-radius:var(--r);padding:18px 20px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.tv-hero h2{margin:0;font-family:var(--disp);font-size:20px}
.tv-hero .tv-sub{opacity:.85;font-size:13px;margin-top:4px}
.tv-actions{display:flex;gap:8px;flex-wrap:wrap}
.tv-actions button{background:rgba(255,255,255,.18);color:#fff;border:1px solid rgba(255,255,255,.35);border-radius:8px;padding:8px 12px;font-family:var(--disp);font-weight:600;font-size:12.5px;cursor:pointer}
.tv-actions button:hover{background:rgba(255,255,255,.3)}
.tv-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:14px}
.tv-kpi{cursor:pointer}
.tv-kpi .stat-val{font-size:26px}
.tv-kpi.warn .stat-val{color:#B45309}
.tv-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
@media(max-width:900px){.tv-grid{grid-template-columns:1fr}}
.tv-list{display:flex;flex-direction:column}
.tv-row{display:flex;align-items:center;gap:10px;padding:9px 2px;border-bottom:1px solid var(--line);cursor:pointer;font-size:13px}
.tv-row:last-child{border-bottom:none}
.tv-row:hover{background:var(--accent-soft)}
.tv-date{font-family:var(--mono);font-size:11px;color:var(--accent-ink);background:var(--accent-soft);border-radius:6px;padding:3px 6px;min-width:58px;text-align:center;flex-shrink:0}
.tv-main{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tv-meta{font-size:11.5px;color:var(--muted)}
.tv-amt{font-family:var(--mono);font-size:12px;font-weight:700;white-space:nowrap}
.tv-empty{color:var(--muted);font-size:13px;padding:14px 0}
.tv-funnel{display:flex;flex-direction:column;gap:8px}
.tv-fbar{display:flex;align-items:center;gap:10px;font-size:12.5px}
.tv-fbar .lbl{width:110px;color:var(--muted)}
.tv-fbar .bar{flex:1;height:22px;background:var(--line);border-radius:6px;overflow:hidden}
.tv-fbar .bar span{display:block;height:100%;background:var(--accent);border-radius:6px}
.tv-fbar .n{width:44px;text-align:right;font-family:var(--mono);font-weight:700}
.tv-chips{display:flex;flex-wrap:wrap;gap:6px}
.tv-chip{background:var(--accent-soft);color:var(--accent-ink);border-radius:20px;padding:5px 10px;font-size:12px;font-weight:600;cursor:pointer}
.tv-chip b{margin-left:4px}
.tv-banner{background:#FEF3C7;border:1px solid #F59E0B;color:#92400E;border-radius:var(--r-sm);padding:12px 14px;font-size:13px;margin-bottom:14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.tv-cal-head{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}
.tv-cal-head h2{margin:0;font-family:var(--disp);font-size:18px;min-width:170px}
.tv-cal{display:grid;grid-template-columns:repeat(7,1fr);gap:1px;background:var(--line);border:1px solid var(--line);border-radius:var(--r-sm);overflow:hidden}
.tv-dow{background:var(--card);font-size:10.5px;font-weight:700;color:var(--muted);text-transform:uppercase;padding:6px;text-align:center}
.tv-day{background:var(--card);min-height:92px;padding:5px;overflow:hidden}
.tv-day.out{background:var(--bg);opacity:.55}
.tv-day .num{font-size:11px;font-weight:700;color:var(--muted);margin-bottom:3px}
.tv-day.today .num{color:#fff;background:var(--accent);border-radius:50%;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center}
.tv-ev{display:block;font-size:10.5px;border-radius:4px;padding:2px 5px;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;border-left:3px solid}
.tv-ev.booking{background:#E0F2FE;border-color:#0284C7;color:#075985}
.tv-ev.return{background:#F3E8FF;border-color:#9333EA;color:#6B21A8}
.tv-ev.umrah{background:#DCFCE7;border-color:#16A34A;color:#166534}
.tv-ev.car{background:#FFEDD5;border-color:#EA580C;color:#9A3412}
.tv-ev.inquiry{background:#F1F5F9;border-color:#94A3B8;color:#475569}
.tv-legend{display:flex;gap:12px;flex-wrap:wrap;font-size:11.5px;color:var(--muted);margin:10px 0}
.tv-legend .tv-ev{display:inline-block;margin:0 4px 0 0;padding:0 6px}
@media(max-width:640px){.tv-day{min-height:58px}.tv-ev{font-size:9px;padding:1px 3px}}
.tv-frame-page{padding:0!important}
`;
  document.head.appendChild(st);
}

function tvEnsurePages(){
  const pages=$id('pages'); if(!pages) return;
  if(!$id('pageTravelhome')){
    const d=document.createElement('div'); d.className='page hidden'; d.id='pageTravelhome';
    d.innerHTML='<div class="page-pad" id="tvHomeBody"></div>';
    pages.appendChild(d);
  }
  if(!$id('pageDepartures')){
    const d=document.createElement('div'); d.className='page hidden'; d.id='pageDepartures';
    d.innerHTML='<div class="page-pad" id="tvDepBody"></div>';
    pages.appendChild(d);
  }
  if(!$id('pageTvlive')){
    const d=document.createElement('div'); d.className='page hidden tv-frame-page'; d.id='pageTvlive';
    d.innerHTML='<iframe id="tvLiveFrame" title="Live Flights" style="width:100%;height:100%;border:none;display:block"></iframe>';
    pages.appendChild(d);
  }
}

function tvNavButton(page,label){
  const b=document.createElement('button');
  b.className='dnTab'; b.dataset.page=page==='__classic'?'':page; b.textContent=label;
  if(page==='__classic') b.dataset.tvAction='classic';
  b.addEventListener('click',()=>tvGo(page));
  return b;
}
function tvBuildDesktopNav(){
  let nav=$id('travelNav');
  if(!nav){
    nav=document.createElement('div'); nav.id='travelNav';
    $id('desktopNav')?.insertAdjacentElement('afterend',nav);
  }
  nav.innerHTML='';
  TV_NAV.forEach(item=>{
    if(Array.isArray(item)){
      if(tvCanSee(item[0])) nav.appendChild(tvNavButton(item[0],item[1]));
      return;
    }
    const visible=item.items.filter(([p])=>tvCanSee(p));
    if(!visible.length) return;
    const g=document.createElement('div'); g.className='dnGroup';
    g.innerHTML=`<button class="dnGroupBtn">${esc(item.group)} <span class="arr">▾</span></button><div class="tv-dd"></div>`;
    const dd=g.querySelector('.tv-dd');
    visible.forEach(([p,l])=>dd.appendChild(tvNavButton(p,l)));
    nav.appendChild(g);
  });
}

// Mobile: retarget the bottom nav to Today / Inbox / Trips / Inquiries / More, and add the travel
// items to the More sheet. Classic elements get .tv-hide; travel ones .tv-only — so switching
// views is just the html.tv-mode class.
function tvBuildMobileNav(){
  const bn=$id('bottomNav');
  if(bn && !$id('bnTvHome')){
    const mk=(id,page,icon,label)=>{
      const b=document.createElement('button');
      b.className='bnItem tv-only'; b.id=id; b.dataset.page=page;
      b.innerHTML=`<span class="bnIcon">${icon}</span><span class="bnLabel">${esc(label)}</span>`;
      b.addEventListener('click',()=>tvGo(page));
      return b;
    };
    bn.querySelector('.bnItem[data-page="home"]')?.classList.add('tv-hide');
    bn.querySelector('.bnItem[data-page="humandeals"]')?.classList.add('tv-hide');
    bn.prepend(mk('bnTvHome','travelhome','🏠','Today'));
    const more=$id('bnMore');
    bn.insertBefore(mk('bnTvTrips','tvtrips','🎫','Trips'),more);
    // Leads → "Inquiries" label while in travel mode
    const leads=bn.querySelector('.bnItem[data-page="leads"] .bnLabel');
    if(leads && !leads.dataset.classic) leads.dataset.classic=leads.textContent;
  }
  const leadsLbl=bn?.querySelector('.bnItem[data-page="leads"] .bnLabel');
  if(leadsLbl) leadsLbl.textContent=isTravelView()?'Inquiries':(leadsLbl.dataset.classic||'Leads');
  const trips=$id('bnTvTrips'); if(trips) trips.style.display=tvCanSee('tvtrips')?'':'none';

  const grid=document.querySelector('#moreSheet .more-sheet-grid');
  if(grid){
    grid.querySelectorAll('.tv-more').forEach(el=>el.remove());
    const first=grid.firstElementChild;
    TV_MORE.forEach(([page,icon,label])=>{
      if(!tvCanSee(page)) return;
      const b=document.createElement('button');
      b.className='more-item tv-only tv-more';
      if(page!=='__classic') b.dataset.page=page;
      b.innerHTML=`<span class="bnIcon">${icon}</span><span class="bnLabel">${esc(label)}</span>`;
      b.addEventListener('click',()=>{ closeMoreSheet(); tvGo(page); });
      grid.insertBefore(b,first);
    });
    $id('moreAgencyTab')?.classList.add('tv-hide');
  }
}

// Classic nav entry back into the travel workspace (travel clients who switched to classic).
function tvBuildClassicEntry(){
  const show=clientRecord?.industry==='travel' && !isTravelView();
  let b=$id('dnTvSwitch');
  if(!b){
    b=document.createElement('button'); b.id='dnTvSwitch'; b.className='dnTab';
    b.textContent='✈️ Travel workspace';
    b.addEventListener('click',()=>tvSwitch('travel'));
    $id('desktopNav')?.insertBefore(b,$id('desktopNav').firstElementChild?.nextSibling||null);
  }
  b.style.display=show?'':'none';
  let m=$id('moreTvSwitch');
  const grid=document.querySelector('#moreSheet .more-sheet-grid');
  if(!m && grid){
    m=document.createElement('button'); m.id='moreTvSwitch'; m.className='more-item';
    m.innerHTML='<span class="bnIcon">✈️</span><span class="bnLabel">Travel workspace</span>';
    m.addEventListener('click',()=>{ closeMoreSheet(); tvSwitch('travel'); });
    grid.prepend(m);
  }
  if(m) m.style.display=show?'':'none';
}

// Called from applyTheme() (login + industry change) and updateAgencyTabVisibility() (module toggle).
function tvApply(){
  if(!clientRecord) return;
  tvInjectStyle();
  tvEnsurePages();
  const on=isTravelView();
  document.documentElement.classList.toggle('tv-mode',on);
  if(clientRecord.industry==='travel'){
    tvBuildDesktopNav();
    tvBuildMobileNav();
  }
  tvBuildClassicEntry();
  if(on){ tvSeedFromCache(); tvSchedulePreload(); }
}

/* ── speed: cached trip data + background preload ── */
// The trips/Umrah/car rows Today and Departures read, kept in sessionStorage (same 5-minute,
// tab-scoped pattern as dashboard.html's leads cache) so a reload paints them immediately
// while taLoad() refreshes them.
const TV_TA_CACHE_KEY=()=>'lv_tv_ta_'+clientId;
const TV_TA_CACHE_TTL=300000;
function tvCacheTa(){
  try{ sessionStorage.setItem(TV_TA_CACHE_KEY(),JSON.stringify({ts:Date.now(),bookings:_taBookings,umrah:_taUmrahGroups,cars:_taCarBookings})); }
  catch(e){ try{ sessionStorage.removeItem(TV_TA_CACHE_KEY()); }catch(e2){} }
}
function tvSeedFromCache(){
  if(!tvAgencyEnabled()||_taLoaded||_taBookings.length) return;
  try{
    const c=JSON.parse(sessionStorage.getItem(TV_TA_CACHE_KEY())||'null');
    if(!c||Date.now()-c.ts>TV_TA_CACHE_TTL) return;
    _taBookings=c.bookings||[]; _taUmrahGroups=c.umrah||[]; _taCarBookings=c.cars||[];
  }catch(e){}
}
// Load the Trips/Quotes frame once the dashboard has settled, so the first click on Trips,
// Quotes, Packages… switches instantly instead of loading a whole page and its data.
let _tvPreloadTimer=null;
function tvSchedulePreload(){
  if(_tvPreloadTimer||!tvAgencyEnabled()||!tvCanSee('tvtrips')) return;
  const go=()=>{ const f=$id('agencyFrame'); if(f&&!f.getAttribute('src')&&isTravelView()) renderAgency('bookings'); };
  _tvPreloadTimer=setTimeout(()=>{
    if('requestIdleCallback' in window) requestIdleCallback(go,{timeout:4000}); else go();
  },2500);
}

function tvSwitch(mode){
  tvSetPref(mode);
  // The agency frame's tab bar differs between views (&shell=travel) — reload it on next open.
  $id('agencyFrame')?.removeAttribute('src');
  tvApply();
  navigate(isTravelView()?'travelhome':'home');
}

function tvGo(page){
  if(page==='__classic'){ tvSwitch('classic'); return; }
  navigate(page);
}

// Hook from navigate(): render whichever travel page was just shown.
function tvOnNavigate(page){
  if(page==='travelhome'){ renderTravelHome(); tvRefreshTa(); }
  else if(page==='departures'){ renderDepartures(); tvRefreshTa(); }
  else if(page==='tvlive'){
    const f=$id('tvLiveFrame');
    if(f && !f.getAttribute('src')) f.src=`live-travel-agency.html?client=${encodeURIComponent(clientId)}&token=${encodeURIComponent(sessionToken)}&embed=1`;
  }
  else if(TV_AGENCY_PAGES[page]) renderAgency(TV_AGENCY_PAGES[page],_tvNextAction);
}

// Called at the end of dashboard.html's taLoad().
function tvAfterTaLoad(){
  _tvTaLoadedAt=Date.now();
  if(clientRecord?.industry==='travel') tvCacheTa();
  if(!$id('pageTravelhome')?.classList.contains('hidden')) renderTravelHome();
  if(!$id('pageDepartures')?.classList.contains('hidden')) renderDepartures();
}

// dashboard.html's _ta* copies are loaded once at sign-in; edits happen inside the agency frame,
// so refresh them (at most once a minute) whenever a travel page that reads them is opened.
let _tvTaLoadedAt=0;
function tvRefreshTa(){
  if(!tvAgencyEnabled()||Date.now()-_tvTaLoadedAt<60000) return;
  _tvTaLoadedAt=Date.now();
  taLoad().catch(()=>{});
}

// Opens a travel-agency.html sub-page with its "+ New …" form already open.
let _tvNextAction='';
function tvNew(page){
  _tvNextAction='new';
  navigate(page);
  _tvNextAction='';
}

/* ── data helpers ── */
function tvNum(v){ const n=parseFloat(v); return isNaN(n)?0:n; }
function tvDay(d){ return String(d||'').slice(0,10); }
function tvAddDays(iso,n){ const d=new Date(iso+'T00:00:00'); d.setDate(d.getDate()+n); return d.toISOString().slice(0,10); }
function tvShort(iso){ if(!iso) return '—'; try{ return new Date(iso+'T00:00:00').toLocaleDateString('en-GB',{day:'numeric',month:'short'}); }catch(e){ return iso; } }
// Bookings can carry different currencies — total per currency instead of adding AED to INR.
function tvSumByCur(rows,fn){
  const m={};
  rows.forEach(r=>{ const v=fn(r); if(!v) return; const c=(r.currency||clientRecord?.currency||'').toUpperCase()||'—'; m[c]=(m[c]||0)+v; });
  return m;
}
function tvFmtCur(m){
  const parts=Object.entries(m).sort((a,b)=>b[1]-a[1]).map(([c,v])=>`${c==='—'?'':c+' '}${Math.round(v).toLocaleString()}`);
  return parts.length?parts.join(' · '):'0';
}
function tvLeadTravelFrom(l){ return tvDay(String(l.TravelDates||'').split('→')[0].trim()); }
function tvLeadTravelTo(l){ const p=String(l.TravelDates||'').split('→'); return tvDay((p[1]||'').trim()); }
function tvIsClosedLead(l){ return ['won','converted','lost'].includes(l.Stage); }
function tvBookingLive(b){ return (b.status||'quoted')!=='cancelled'; }
function tvBookings(){ return (typeof _taBookings!=='undefined'?_taBookings:[]).filter(Boolean); }
function tvUmrah(){ return (typeof _taUmrahGroups!=='undefined'?_taUmrahGroups:[]).filter(Boolean); }
function tvCarBookings(){ return (typeof _taCarBookings!=='undefined'?_taCarBookings:[]).filter(Boolean); }
function tvCreated(r){ return tvDay(r.CreatedAt||r.created_at); }

/* ── 🏠 TODAY ── */
function renderTravelHome(){
  const el=$id('tvHomeBody');
  // renderHome() calls this on every leads refresh — skip the work while Today isn't on screen;
  // tvOnNavigate renders it fresh when it's opened.
  if(!el || !isTravelView() || $id('pageTravelhome')?.classList.contains('hidden')) return;
  const today=TODAY, in7=tvAddDays(TODAY,7), in14=tvAddDays(TODAY,14), ago30=tvAddDays(TODAY,-30);
  const month=TODAY.slice(0,7);
  const leads=typeof allLeads!=='undefined'?allLeads:[];
  const bks=tvBookings(), live=bks.filter(tvBookingLive);
  const agency=tvAgencyEnabled();

  const depToday=live.filter(b=>tvDay(b.departure_date)===today);
  const depWeek=live.filter(b=>{ const d=tvDay(b.departure_date); return d>=today&&d<=in7; });
  const umrahWeek=tvUmrah().filter(g=>{ const d=tvDay(g.departure_date); return d>=today&&d<=in7; });
  const returnsWeek=tvUmrah().filter(g=>{ const d=tvDay(g.return_date); return d>=today&&d<=in7; });
  const newToday=leads.filter(l=>tvDay(l.Date)===today);
  const waiting=leads.filter(l=>!tvIsClosedLead(l)&&(l.Stage==='human_handover'||l.Handover==='Yes'));
  const quoted=live.filter(b=>(b.status||'quoted')==='quoted');
  const due=live.filter(b=>b.status!=='completed'&&tvNum(b.sell_price)-tvNum(b.deposit)>0.5)
    .sort((a,b)=>(tvDay(a.departure_date)||'9999').localeCompare(tvDay(b.departure_date)||'9999'));
  const dueSoon=due.filter(b=>{ const d=tvDay(b.departure_date); return d&&d<=in14; });
  const thisMonth=live.filter(b=>tvCreated(b).slice(0,7)===month);
  const revenue=tvSumByCur(thisMonth,b=>tvNum(b.sell_price));
  const margin=tvSumByCur(thisMonth,b=>tvNum(b.sell_price)-tvNum(b.cost_price));
  const travellingSoon=leads.filter(l=>{ const d=tvLeadTravelFrom(l); return d&&d>=today&&d<=in14&&!['lost'].includes(l.Stage); })
    .sort((a,b)=>tvLeadTravelFrom(a).localeCompare(tvLeadTravelFrom(b)));

  // Funnel over the last 30 days: inquiries → quotes → booked → travelled.
  const fInq=leads.filter(l=>tvDay(l.Date)>=ago30).length;
  const recentBks=bks.filter(b=>tvCreated(b)>=ago30);
  const fQuoted=recentBks.length;
  const fBooked=recentBks.filter(b=>['confirmed','completed'].includes(b.status)).length;
  const fTravelled=recentBks.filter(b=>b.status==='completed').length;
  const fMax=Math.max(fInq,fQuoted,1);

  // Top destinations (last 90 days) and service-category split.
  const ago90=tvAddDays(TODAY,-90);
  const destCount={};
  leads.filter(l=>tvDay(l.Date)>=ago90&&l.Destination).forEach(l=>{
    const k=String(l.Destination).trim(); if(k) destCount[k]=(destCount[k]||0)+1;
  });
  const topDest=Object.entries(destCount).sort((a,b)=>b[1]-a[1]).slice(0,10);
  const catCount={};
  leads.filter(l=>!tvIsClosedLead(l)).forEach(l=>{ const c=l.ServiceCategory||'Uncategorised'; catCount[c]=(catCount[c]||0)+1; });

  const hour=new Date().getHours();
  const greet=hour<12?'Good morning':hour<17?'Good afternoon':'Good evening';
  const kpi=(label,val,sub,go,warn)=>`<div class="stat tv-kpi${warn?' warn':''}" onclick="${go}"><div class="stat-lbl">${esc(label)}</div><div class="stat-val">${val}</div><div class="stat-sub">${sub}</div></div>`;
  const row=(date,main,meta,amt,go)=>`<div class="tv-row" onclick="${go}"><span class="tv-date">${esc(date)}</span><div class="tv-main">${main}<div class="tv-meta">${meta}</div></div>${amt?`<span class="tv-amt">${amt}</span>`:''}</div>`;
  const cur=b=>esc((b.currency||'').toUpperCase());

  const upcoming=[
    ...depWeek.map(b=>({d:tvDay(b.departure_date),html:row(tvShort(tvDay(b.departure_date)),`🛫 ${esc(b.client_name||'Traveler')}`,`${esc(b.package_name||'Booking')} · ${tvNum(b.pax)||1} pax · ${esc(b.status||'quoted')}`,'',"navigate('tvtrips')")})),
    ...umrahWeek.map(g=>({d:tvDay(g.departure_date),html:row(tvShort(tvDay(g.departure_date)),`🕌 ${esc(g.name||'Umrah group')}`,`${(Array.isArray(g.pilgrims)?g.pilgrims.length:0)} pilgrims · ${tvNum(g.seats)} seats`,'',"navigate('tvumrah')")})),
    ...returnsWeek.map(g=>({d:tvDay(g.return_date),html:row(tvShort(tvDay(g.return_date)),`🛬 ${esc(g.name||'Umrah group')} returns`,'Return','',"navigate('tvumrah')")})),
  ].sort((a,b)=>a.d.localeCompare(b.d));

  el.innerHTML=`
    <div class="tv-hero">
      <div><h2>${greet}${clientRecord?.client_name?', '+esc(clientRecord.client_name):''} ✈️</h2>
        <div class="tv-sub">${depToday.length} departure${depToday.length===1?'':'s'} today · ${newToday.length} new inquir${newToday.length===1?'y':'ies'} · ${waiting.length} waiting for an agent</div></div>
      <div class="tv-actions">
        <button onclick="openAddLead()">+ Inquiry</button>
        ${agency?`<button onclick="tvNew('tvquotes')">+ Itinerary</button><button onclick="tvNew('tvtrips')">+ Quote / Booking</button>`:''}
        ${agency&&tvCanSee('tvlive')?`<button onclick="navigate('tvlive')">✈️ Search flights</button>`:''}
      </div>
    </div>
    ${agency?'':`<div class="tv-banner">✈️ Turn on the <b>Travel Agency</b> module to track trips, quotes, departures and payments here.
      ${isAccountOwner()?`<button class="btn btn-primary btn-sm" onclick="navigate('modules')">Enable in Settings → Modules</button>`:'Ask your account owner to enable it.'}</div>`}
    <div class="tv-kpis">
      ${kpi('Departures today',depToday.length,`${depWeek.length+umrahWeek.length} in the next 7 days`,"navigate('departures')")}
      ${kpi('New inquiries',newToday.length,'today',"navigate('leads')")}
      ${kpi('Waiting for agent',waiting.length,'handed over by the bot',"navigate('humandeals')",waiting.length>0)}
      ${agency?kpi('Open quotes',quoted.length,tvFmtCur(tvSumByCur(quoted,b=>tvNum(b.sell_price))),"navigate('tvtrips')"):''}
      ${agency?kpi('Balance due ≤14d',dueSoon.length,tvFmtCur(tvSumByCur(dueSoon,b=>tvNum(b.sell_price)-tvNum(b.deposit))),"navigate('tvfinance')",dueSoon.length>0):''}
      ${agency?kpi('Sales this month',tvFmtCur(revenue),`margin ${tvFmtCur(margin)}`,"navigate('tvfinance')"):''}
    </div>
    <div class="tv-grid">
      <div class="card"><div class="card-title">🛫 Departures & returns — next 7 days</div>
        <div class="tv-list">${upcoming.length?upcoming.slice(0,10).map(u=>u.html).join(''):`<div class="tv-empty">${agency?'Nothing departing this week.':'Enable the Travel Agency module to see departures.'}</div>`}</div></div>
      <div class="card"><div class="card-title">💳 Balance due</div>
        <div class="tv-list">${due.length?due.slice(0,8).map(b=>row(b.departure_date?tvShort(tvDay(b.departure_date)):'No date',esc(b.client_name||'Traveler'),`${esc(b.package_name||'Booking')} · paid ${cur(b)} ${Math.round(tvNum(b.deposit)).toLocaleString()}`,`${cur(b)} ${Math.round(tvNum(b.sell_price)-tvNum(b.deposit)).toLocaleString()}`,"navigate('tvtrips')")).join(''):'<div class="tv-empty">No outstanding balances.</div>'}</div></div>
    </div>
    <div class="tv-grid">
      <div class="card"><div class="card-title">📥 Newest inquiries</div>
        <div class="tv-list">${leads.length?[...leads].sort((a,b)=>String(b.Date||'').localeCompare(String(a.Date||''))).slice(0,8).map(l=>row(tvShort(tvDay(l.Date)),esc(l.Name||l.Phone||'Inquiry'),[l.Destination,l.TravelDates,l.PaxCount,l.ServiceCategory].filter(Boolean).map(esc).join(' · ')||esc(stageLabel(l.Stage||'new')),'',`openDetail(${Number(l.Id)})`)).join(''):'<div class="tv-empty">No inquiries yet.</div>'}</div></div>
      <div class="card"><div class="card-title">🧳 Inquiries travelling in the next 14 days</div>
        <div class="tv-list">${travellingSoon.length?travellingSoon.slice(0,8).map(l=>row(tvShort(tvLeadTravelFrom(l)),esc(l.Name||l.Phone||'Inquiry'),`${esc(l.Destination||'—')} · ${esc(stageLabel(l.Stage||'new'))}`,'',`openDetail(${Number(l.Id)})`)).join(''):'<div class="tv-empty">No inquiries with travel dates in the next 14 days.</div>'}</div></div>
    </div>
    <div class="tv-grid">
      <div class="card"><div class="card-title">📊 Last 30 days</div>
        <div class="tv-funnel">
          ${[['Inquiries',fInq],['Quoted',fQuoted],['Booked',fBooked],['Travelled',fTravelled]].map(([l,n])=>`<div class="tv-fbar"><span class="lbl">${l}</span><div class="bar"><span style="width:${Math.round(n/fMax*100)}%"></span></div><span class="n">${n}</span></div>`).join('')}
        </div>
        <div class="tv-meta" style="margin-top:8px">Quoted / booked / travelled come from Trips (Agency bookings) created in this period.</div></div>
      <div class="card"><div class="card-title">🌍 Top destinations — 90 days</div>
        ${topDest.length?`<div class="tv-chips">${topDest.map(([d,n])=>`<span class="tv-chip" style="cursor:default">${esc(d)}<b>${n}</b></span>`).join('')}</div>`:'<div class="tv-empty">Add a Destination to inquiries to see this.</div>'}
        <div class="card-title" style="margin:16px 0 10px">🗂️ Open inquiries by service</div>
        <div class="tv-chips">${Object.entries(catCount).sort((a,b)=>b[1]-a[1]).map(([c,n])=>`<span class="tv-chip" onclick="tvOpenLeadsCategory(${esc(JSON.stringify(c)).replace(/"/g,'&quot;')})">${esc(c)}<b>${n}</b></span>`).join('')||'<div class="tv-empty">No open inquiries.</div>'}</div></div>
    </div>`;
}

function tvOpenLeadsCategory(cat){
  navigate('leads');
  if(cat==='Uncategorised') return;
  setTimeout(()=>{ const f=$id('leadCategoryFilter'); if(f){ f.value=cat; if(typeof onLeadsFilterChange==='function') onLeadsFilterChange(); } },50);
}
/* ── 📅 DEPARTURES ── */
let _tvCalMonth=TODAY.slice(0,7);
function tvCalShift(n){
  const [y,m]=_tvCalMonth.split('-').map(Number);
  const d=new Date(y,m-1+n,1);
  _tvCalMonth=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  renderDepartures();
}
function tvCalToday(){ _tvCalMonth=TODAY.slice(0,7); renderDepartures(); }

function tvDepartureEvents(){
  const ev=[];
  tvBookings().filter(tvBookingLive).forEach(b=>{
    const d=tvDay(b.departure_date); if(!d) return;
    ev.push({d,kind:'booking',label:`🛫 ${b.client_name||'Traveler'}${b.package_name?' · '+b.package_name:''}`,meta:`${tvNum(b.pax)||1} pax · ${b.status||'quoted'}`,go:"navigate('tvtrips')"});
  });
  tvUmrah().forEach(g=>{
    const n=Array.isArray(g.pilgrims)?g.pilgrims.length:0;
    if(tvDay(g.departure_date)) ev.push({d:tvDay(g.departure_date),kind:'umrah',label:`🕌 ${g.name||'Umrah group'}`,meta:`${n}/${tvNum(g.seats)} pilgrims · departs`,go:"navigate('tvumrah')"});
    if(tvDay(g.return_date)) ev.push({d:tvDay(g.return_date),kind:'return',label:`🛬 ${g.name||'Umrah group'}`,meta:'returns',go:"navigate('tvumrah')"});
  });
  tvCarBookings().filter(c=>c.status!=='cancelled').forEach(c=>{
    if(tvDay(c.pickup_date)) ev.push({d:tvDay(c.pickup_date),kind:'car',label:`🚗 ${c.customer_name||'Customer'} · ${c.car_name||'car'}`,meta:'pickup',go:"navigate('tvcars')"});
  });
  if(_tvShowInquiries){
    (typeof allLeads!=='undefined'?allLeads:[]).filter(l=>l.Stage!=='lost').forEach(l=>{
      const d=tvLeadTravelFrom(l); if(!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
      ev.push({d,kind:'inquiry',label:`📥 ${l.Name||l.Phone||'Inquiry'}${l.Destination?' · '+l.Destination:''}`,meta:`inquiry · ${stageLabel(l.Stage||'new')}`,go:`openDetail(${Number(l.Id)})`});
      const r=tvLeadTravelTo(l);
      if(/^\d{4}-\d{2}-\d{2}$/.test(r)) ev.push({d:r,kind:'return',label:`🛬 ${l.Name||l.Phone||'Inquiry'}`,meta:'inquiry returns',go:`openDetail(${Number(l.Id)})`});
    });
  }
  return ev.sort((a,b)=>a.d.localeCompare(b.d));
}
let _tvShowInquiries=true;
function tvToggleInquiries(v){ _tvShowInquiries=v; renderDepartures(); }

function renderDepartures(){
  const el=$id('tvDepBody'); if(!el) return;
  const [y,m]=_tvCalMonth.split('-').map(Number);
  const first=new Date(y,m-1,1);
  const startDow=(first.getDay()+6)%7; // Monday-first
  const gridStart=new Date(y,m-1,1-startDow);
  const events=tvDepartureEvents();
  const byDay={};
  events.forEach(e=>{ (byDay[e.d]=byDay[e.d]||[]).push(e); });
  const cells=[];
  for(let i=0;i<42;i++){
    const d=new Date(gridStart); d.setDate(gridStart.getDate()+i);
    const iso=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    if(i>=35 && d.getMonth()!==m-1) break;
    const list=byDay[iso]||[];
    cells.push(`<div class="tv-day${d.getMonth()!==m-1?' out':''}${iso===TODAY?' today':''}"><div class="num">${d.getDate()}</div>
      ${list.slice(0,3).map(e=>`<span class="tv-ev ${e.kind}" title="${esc(e.label+' — '+e.meta)}" onclick="${e.go}">${esc(e.label)}</span>`).join('')}
      ${list.length>3?`<span class="tv-meta">+${list.length-3} more</span>`:''}</div>`);
  }
  const monthEvents=events.filter(e=>e.d.slice(0,7)===_tvCalMonth);
  const title=first.toLocaleDateString('en-GB',{month:'long',year:'numeric'});
  el.innerHTML=`
    <div class="tv-cal-head">
      <button class="btn-ghost" onclick="tvCalShift(-1)" aria-label="Previous month">‹</button>
      <h2>${esc(title)}</h2>
      <button class="btn-ghost" onclick="tvCalShift(1)" aria-label="Next month">›</button>
      <button class="btn-ghost" onclick="tvCalToday()">Today</button>
      <label style="font-size:12.5px;color:var(--muted);display:flex;align-items:center;gap:6px;margin-left:auto"><input type="checkbox" ${_tvShowInquiries?'checked':''} onchange="tvToggleInquiries(this.checked)"> Show inquiry travel dates</label>
      ${tvCanSee('tvtrips')?`<button class="btn btn-primary btn-sm" onclick="tvNew('tvtrips')">+ New booking</button>`:''}
    </div>
    <div class="tv-cal">${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d=>`<div class="tv-dow">${d}</div>`).join('')}${cells.join('')}</div>
    <div class="tv-legend"><span><span class="tv-ev booking">&nbsp;</span>Trip departure</span><span><span class="tv-ev umrah">&nbsp;</span>Umrah group</span><span><span class="tv-ev return">&nbsp;</span>Return</span><span><span class="tv-ev car">&nbsp;</span>Car pickup</span><span><span class="tv-ev inquiry">&nbsp;</span>Inquiry travel date</span></div>
    <div class="card"><div class="card-title">🗓️ ${esc(title)} — ${monthEvents.length} item${monthEvents.length===1?'':'s'}</div>
      <div class="tv-list">${monthEvents.length?monthEvents.map(e=>`<div class="tv-row" onclick="${e.go}"><span class="tv-date">${esc(tvShort(e.d))}</span><div class="tv-main">${esc(e.label)}<div class="tv-meta">${esc(e.meta)}</div></div></div>`).join(''):'<div class="tv-empty">Nothing scheduled this month.</div>'}</div></div>`;
}

/* ── frame → dashboard messages (travel-agency.html in travel-shell mode) ── */
window.addEventListener('message',e=>{
  if(e.origin!==location.origin) return;
  const d=e.data||{};
  if(d.type==='ta:navigate' && typeof d.page==='string' && (d.page==='tvlive'||TV_AGENCY_PAGES[d.page])) navigate(d.page);
});
