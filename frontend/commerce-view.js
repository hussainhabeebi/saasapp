/* ── COMMERCE WORKSPACE (industry === 'ecommerce', desktop only) ──────────────────────────────────
   A store-admin shell for ecommerce clients, modelled on the big commerce back offices: a left
   sidebar (Home · Orders · Products · Customers · Inbox · Marketing · Analytics · Finance), a
   commerce Home (#pageStorehome) built around sales, orders and stock, and the Ecom module's own
   screens (Orders, Products, Shopify Orders/Stock, Promotions…) opened straight from the sidebar.
   Same layering as travel-view.js — nothing is rebuilt: Customers is the Leads page, Inbox is
   Chats, and every store screen is an ecom.html sub-page inside the existing #ecommerceFrame
   (driven by ?tab= on first load and an 'ecom:goto' postMessage after that; &shell=commerce hides
   ecom.html's own sidebar).
   Phones are untouched: the workspace only switches on at ≥768px (html.cv-mode), so the mobile
   bottom nav, More sheet and Home stay exactly as they were. A user can switch back to the
   classic CRM nav (sidebar → Classic CRM view); that choice is per-browser in localStorage.
   Uses dashboard.html's own globals: $id, esc, navigate, PAGE_HOST, clientRecord, clientId,
   sessionToken, allLeads, CONFIG, ncAuthHeaders, renderEcommerce, openAddLead, openDetail,
   openProjectsTool, isAccountOwner, myEmail, getTeamPermissions, MODULE_PERMISSIONS,
   ALWAYS_ON_MODULES, stageLabel, leadDisplayName, TODAY.
   Bump the ?v= on its <script> tag in dashboard.html when changing this file — sw.js serves
   scripts cache-first. ── */

// Sidebar entries that are really an ecom.html sub-page inside #pageEcommerce.
const CV_ECOM_PAGES={
  cvorders:'orders', cvproducts:'products', cvcategories:'categories', cvpromotions:'promotions',
  cvtestimonials:'testimonials', cvshoporders:'shop-orders', cvshopstock:'shop-stock',
  cvstoresettings:'settings', cvflow:'flow',
};
Object.keys(CV_ECOM_PAGES).forEach(p=>{ PAGE_HOST[p]='ecommerce'; });
const CV_TAB_TO_PAGE=Object.fromEntries(Object.entries(CV_ECOM_PAGES).map(([p,t])=>[t,p]));

// [page, icon, label, opts] — opts.sub indents, opts.badge names a classic-nav badge to mirror.
const CV_NAV=[
  {items:[
    ['storehome','🏠','Home'],
    ['cvorders','🧾','Orders',{count:'orders'}],
    ['cvproducts','📦','Products'],
    ['cvcategories','🏷️','Categories',{sub:true}],
    ['leads','👥','Customers'],
    ['chats','💬','Inbox',{badge:'dnChatBadge'}],
    ['humandeals','🤝','Handovers',{badge:'dnHdBadge'}],
  ]},
  {section:'Shopify', shopify:true, items:[
    ['cvshoporders','🛍️','Shopify orders'],
    ['cvshopstock','📊','Shopify stock'],
  ]},
  {section:'Marketing', items:[
    ['broadcast','📢','Campaigns'],
    ['followups','🔁','Follow-ups'],
    ['cvpromotions','🎁','Promotions'],
    ['cvtestimonials','🌟','Testimonials'],
  ]},
  {section:'Analytics', items:[
    ['reports','📈','Reports'],
    ['team','📊','Team'],
    ['home','🧭','CRM overview'],
    ['bizai','🤖','AI assistant'],
  ]},
  {section:'Finance', items:[
    ['accounting','💰','Accounting'],
    ['billing','💳','Billing',{badge:'dnBillingBadge'}],
  ]},
];
const CV_FOOT=[
  ['cvstoresettings','🛒','Store settings'],
  ['cvflow','🔀','Order flow'],
  ['settings','⚙️','Settings'],
  ['__projects','✅','Projects & tasks'],
  ['__classic','↩️','Classic CRM view'],
];

const CV_PREF_KEY=()=>'lv_commerce_view_'+clientId;
function cvPref(){ try{ return localStorage.getItem(CV_PREF_KEY())||'commerce'; }catch(e){ return 'commerce'; } }
function cvSetPref(v){ try{ localStorage.setItem(CV_PREF_KEY(),v); }catch(e){} }
const CV_DESKTOP=window.matchMedia('(min-width:768px)');
function isCommerceView(){ return clientRecord?.industry==='ecommerce' && cvPref()!=='classic' && CV_DESKTOP.matches; }
function cvShopifyOn(){ return !!clientRecord?.shopify_shop_domain; }
function cvBabyCare(){ try{ return JSON.parse(clientRecord?.bot_config||'{}')?.ecom_communication_style==='baby_care'; }catch(e){ return false; } }

// Same rule as applyUserModulePermissions(): owner or no saved restriction = everything. Store
// screens need the 'ecommerce' module permission.
function cvCanSee(page){
  if(page==='storehome'||page==='__classic'||page==='__projects') return true;
  if(CV_ECOM_PAGES[page]){
    if((page==='cvshoporders'||page==='cvshopstock')&&!cvShopifyOn()) return false;
    if(page==='cvflow'&&!cvBabyCare()) return false;
    page='ecommerce';
  }
  // A classic nav button the dashboard has hidden (module off, plan gate, role) stays hidden here.
  const classic=document.querySelector(`#desktopNav [data-page="${page}"]`);
  if(classic && classic.style.display==='none' && page!=='ecommerce') return false;
  if(!clientRecord||!myEmail||isAccountOwner()) return true;
  const mine=getTeamPermissions()[myEmail];
  if(!mine||!Array.isArray(mine.modules)) return true;
  if(page==='followups') page='broadcast';
  if(typeof ALWAYS_ON_MODULES!=='undefined'&&ALWAYS_ON_MODULES.has(page)) return true;
  const known=(typeof MODULE_PERMISSIONS!=='undefined'?MODULE_PERMISSIONS:[]).some(m=>m.key===page);
  return !known||mine.modules.includes(page);
}

function cvInjectStyle(){
  if($id('cvStyle')) return;
  const st=document.createElement('style'); st.id='cvStyle';
  st.textContent=`
#commerceSide{display:none}
@media(min-width:768px){
  html.cv-mode #app.show{display:grid;grid-template-columns:236px minmax(0,1fr);grid-template-rows:var(--hdr) minmax(0,1fr)}
  html.cv-mode #hdr{grid-column:1/-1;grid-row:1}
  html.cv-mode #desktopNav,html.cv-mode #travelNav{display:none!important}
  html.cv-mode #commerceSide{display:flex;grid-column:1;grid-row:2}
  html.cv-mode #pages{grid-column:2;grid-row:2}
  html.cv-mode .cv-hide{display:none!important}
  html.cv-mode #pages .page-pad{max-width:1440px}
}
#commerceSide{flex-direction:column;min-height:0;background:var(--card);border-right:1px solid var(--line);overflow:hidden}
.cv-store{display:flex;align-items:center;gap:10px;padding:14px 14px 12px;border-bottom:1px solid var(--line)}
.cv-store-av{width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,var(--accent),var(--accent-ink));color:#fff;font-family:var(--disp);font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:14px}
.cv-store-name{font-family:var(--disp);font-weight:700;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cv-store-sub{font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cv-scroll{flex:1;overflow-y:auto;padding:8px 10px 10px;scrollbar-width:thin}
.cv-sec{font-family:var(--disp);font-size:10.5px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);opacity:.85;padding:14px 10px 5px}
.cv-item{display:flex;align-items:center;gap:9px;width:100%;border:none;background:none;cursor:pointer;border-radius:8px;padding:7px 10px;margin:1px 0;font-family:var(--body,inherit);font-size:13.5px;font-weight:500;color:var(--ink);text-align:left;transition:background .12s}
.cv-item:hover{background:var(--bg)}
.cv-item.active{background:var(--accent-soft);color:var(--accent-ink);font-weight:600}
.cv-item.sub{padding-left:36px;font-size:13px;color:var(--muted)}
.cv-item.sub.active{color:var(--accent-ink)}
.cv-ic{width:18px;text-align:center;font-size:15px;line-height:1;flex-shrink:0}
.cv-lbl{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cv-badge{font-family:var(--mono);font-size:10.5px;font-weight:700;border-radius:99px;padding:1px 7px;background:var(--accent-soft);color:var(--accent-ink)}
.cv-badge.hot{background:#ef4444;color:#fff}
.cv-foot{border-top:1px solid var(--line);padding:8px 10px}
.cv-foot .cv-item{font-size:13px}

/* Commerce Home */
.cv-head{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:18px}
.cv-head h1{font-family:var(--disp);font-size:23px;font-weight:700;margin:0;letter-spacing:-.01em}
.cv-head .cv-sub{font-size:13px;color:var(--muted);margin-top:4px}
.cv-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.cv-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:9px;padding:8px 13px;font-family:var(--disp);font-weight:600;font-size:13px;cursor:pointer;text-decoration:none;white-space:nowrap}
.cv-btn:hover{background:var(--bg)}
.cv-btn.pri{background:var(--accent);border-color:var(--accent);color:#fff}
.cv-btn.pri:hover{filter:brightness(1.05);background:var(--accent)}
.cv-sel{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:9px;padding:8px 10px;font-size:13px;font-family:inherit}
.cv-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:16px}
.cv-kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;box-shadow:var(--shadow);min-width:0}
.cv-kpi.click{cursor:pointer}.cv-kpi.click:hover{border-color:var(--ls)}
.cv-kpi-l{font-size:12px;color:var(--muted);display:flex;justify-content:space-between;gap:6px}
.cv-kpi-v{font-family:var(--disp);font-size:24px;font-weight:700;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cv-kpi-f{font-size:12px;color:var(--muted);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cv-kpi.warn .cv-kpi-v{color:#B45309}.cv-kpi.bad .cv-kpi-v{color:#B91C1C}
.cv-up{color:#047857;font-weight:600}.cv-down{color:#B91C1C;font-weight:600}
.cv-grid{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(0,1fr);gap:16px;margin-bottom:16px}
@media(max-width:1180px){.cv-grid{grid-template-columns:1fr}}
.cv-card{background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);padding:16px 18px;min-width:0}
.cv-card-h{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:12px}
.cv-card-h h3{font-family:var(--disp);font-size:15px;font-weight:700;margin:0}
.cv-link{font-size:12px;font-weight:600;color:var(--accent-ink);background:none;border:none;cursor:pointer;font-family:inherit;padding:0}
.cv-chart{width:100%;height:auto;display:block}
.cv-chart text{font-size:10px;fill:var(--muted);font-family:inherit}
.cv-row{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--line);font-size:13px;cursor:pointer}
.cv-row:last-child{border-bottom:none}
.cv-row:hover{background:var(--bg)}
.cv-row .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cv-row .amt{font-family:var(--mono);font-size:12.5px;font-weight:700;white-space:nowrap}
.cv-muted{color:var(--muted);font-size:12px}
.cv-empty{color:var(--muted);font-size:13px;padding:18px 0;text-align:center}
.cv-pill{display:inline-block;border-radius:20px;padding:2px 9px;font-size:11px;font-weight:600;white-space:nowrap;background:var(--bg);color:var(--muted)}
.cv-pill.ok{background:#DCFCE7;color:#166534}.cv-pill.warn{background:#FEF3C7;color:#92400E}
.cv-pill.info{background:#DBEAFE;color:#1E40AF}.cv-pill.bad{background:#FEE2E2;color:#991B1B}
.cv-bar{display:flex;align-items:center;gap:10px;font-size:13px;padding:6px 0}
.cv-bar .lbl{width:150px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cv-bar .trk{flex:1;height:8px;background:var(--bg);border-radius:6px;overflow:hidden}
.cv-bar .trk i{display:block;height:100%;background:var(--accent);border-radius:6px}
.cv-bar .n{min-width:90px;text-align:right;font-family:var(--mono);font-size:12px;font-weight:700}
.cv-funnel .cv-bar .lbl{width:120px}
.cv-todo .cv-row .ic{width:22px;text-align:center}
.cv-banner{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:12px 14px;border-radius:12px;border:1px solid var(--line);background:var(--card);margin-bottom:16px;font-size:13px}
`;
  document.head.appendChild(st);
}

function cvEnsurePage(){
  const pages=$id('pages'); if(!pages||$id('pageStorehome')) return;
  const d=document.createElement('div'); d.className='page hidden'; d.id='pageStorehome';
  d.innerHTML='<div class="page-pad" id="cvHomeBody"></div>';
  pages.appendChild(d);
}

function cvItemHtml([page,icon,label,opts={}]){
  return `<button class="cv-item${opts.sub?' sub':''}" data-cv-page="${page}" onclick="cvGo('${page}')">
    <span class="cv-ic">${icon}</span><span class="cv-lbl">${esc(label)}</span>
    ${opts.badge?`<span class="cv-badge hot" data-cv-mirror="${opts.badge}" style="display:none"></span>`:''}
    ${opts.count?`<span class="cv-badge" data-cv-count="${opts.count}" style="display:none"></span>`:''}
  </button>`;
}
function cvBuildSide(){
  let side=$id('commerceSide');
  if(!side){
    side=document.createElement('nav'); side.id='commerceSide'; side.setAttribute('aria-label','Store navigation');
    $id('desktopNav')?.insertAdjacentElement('afterend',side);
  }
  const name=clientRecord?.client_name||'My store';
  const sub=cvShopifyOn()?clientRecord.shopify_shop_domain:'Store admin';
  side.innerHTML=`
    <div class="cv-store"><div class="cv-store-av">${esc(name.trim().charAt(0).toUpperCase()||'S')}</div>
      <div style="min-width:0"><div class="cv-store-name">${esc(name)}</div><div class="cv-store-sub">${esc(sub)}</div></div></div>
    <div class="cv-scroll">${CV_NAV.map(g=>{
      if(g.shopify&&!cvShopifyOn()) return '';
      const items=g.items.filter(i=>cvCanSee(i[0]));
      if(!items.length) return '';
      return (g.section?`<div class="cv-sec">${esc(g.section)}</div>`:'')+items.map(cvItemHtml).join('');
    }).join('')}</div>
    <div class="cv-foot">${CV_FOOT.filter(i=>cvCanSee(i[0])).map(cvItemHtml).join('')}</div>`;
  cvMirrorBadges();
  cvSetActive(typeof _curPage!=='undefined'?_curPage:'');
  cvRenderCounts();
}

// Chats / Human Deals / Billing badges are maintained on the classic nav — copy them across.
function cvMirrorBadges(){
  document.querySelectorAll('#commerceSide [data-cv-mirror]').forEach(el=>{
    const src=$id(el.dataset.cvMirror);
    const txt=src&&src.style.display!=='none'?String(src.textContent||'').trim():'';
    el.textContent=txt; el.style.display=txt?'':'none';
  });
}
let _cvBadgeObs=null;
function cvWatchBadges(){
  if(_cvBadgeObs||!window.MutationObserver) return;
  const nav=$id('desktopNav'); if(!nav) return;
  _cvBadgeObs=new MutationObserver(()=>{ if(isCommerceView()) cvMirrorBadges(); });
  _cvBadgeObs.observe(nav,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['style']});
}

function cvSetActive(page){
  const key=SETTINGS_GROUP.includes(page)?'settings':(HUMANDEALS_GROUP.includes(page)?'humandeals':page);
  document.querySelectorAll('#commerceSide .cv-item').forEach(b=>b.classList.toggle('active',b.dataset.cvPage===key));
}

// Called from applyTheme() (login + industry change), updateEcomTabVisibility(), and on resize
// across the desktop breakpoint.
function cvApply(){
  if(!clientRecord) return;
  cvInjectStyle();
  cvEnsurePage();
  const on=isCommerceView();
  const was=document.documentElement.classList.contains('cv-mode');
  document.documentElement.classList.toggle('cv-mode',on);
  if(on){ cvBuildSide(); cvWatchBadges(); }
  cvBuildClassicEntry();
  // The ecom frame's own sidebar differs between views (&shell=commerce) — reload it on next open.
  if(was!==on) $id('ecommerceFrame')?.removeAttribute('src');
  if(on){ cvLoadStore(); cvSchedulePreload(); }
}
CV_DESKTOP.addEventListener?.('change',()=>{
  if(!clientRecord||clientRecord.industry!=='ecommerce') return;
  const cur=typeof _curPage!=='undefined'?_curPage:'home';
  cvApply();
  if(isCommerceView()&&cur==='home') navigate('storehome');
  else if(!isCommerceView()&&(cur==='storehome'||CV_ECOM_PAGES[cur])) navigate(cur==='storehome'?'home':'ecommerce');
});

// Classic nav entry back into the workspace (ecommerce clients who switched to classic).
function cvBuildClassicEntry(){
  const show=clientRecord?.industry==='ecommerce' && cvPref()==='classic';
  let b=$id('dnCvSwitch');
  if(!b){
    b=document.createElement('button'); b.id='dnCvSwitch'; b.className='dnTab';
    b.textContent='🛒 Store workspace';
    b.addEventListener('click',()=>cvSwitch('commerce'));
    $id('desktopNav')?.insertBefore(b,$id('desktopNav').firstElementChild?.nextSibling||null);
  }
  b.style.display=show?'':'none';
}

function cvSwitch(mode){
  cvSetPref(mode);
  cvApply();
  navigate(isCommerceView()?'storehome':'home');
}

function cvGo(page){
  if(page==='__classic'){ cvSwitch('classic'); return; }
  if(page==='__projects'){ openProjectsTool(); return; }
  navigate(page);
}

// Hook from navigate(): render whichever commerce page was just shown.
function cvOnNavigate(page){
  if(!isCommerceView()) return;
  cvSetActive(page);
  if(page==='storehome'){ renderStoreHome(); cvLoadStore(); }
  else if(CV_ECOM_PAGES[page]) renderEcommerce(CV_ECOM_PAGES[page]);
  else if(page==='ecommerce') cvSetActive('cvorders');
}

// ecom.html tells us when it switches screens itself (e.g. a "View all orders" link) so the
// sidebar highlight follows.
window.addEventListener('message',e=>{
  if(!(e.origin===location.origin||(location.protocol==='file:'&&e.origin==='null'))||e.data?.source!=='lv-ecom'||e.data.type!=='ecom:tab'||!isCommerceView()) return;
  if($id('pageEcommerce')?.classList.contains('hidden')) return;
  const page=CV_TAB_TO_PAGE[e.data.tab]; if(!page) return;
  if(typeof _curPage!=='undefined') _curPage=page;
  cvSetActive(page);
});

// Load the store frame once the dashboard has settled, so the first click on Orders/Products
// switches instantly instead of loading a whole page and its data.
let _cvPreloadTimer=null;
function cvSchedulePreload(){
  if(_cvPreloadTimer||!cvCanSee('cvorders')) return;
  const go=()=>{ const f=$id('ecommerceFrame'); if(f&&!f.getAttribute('src')&&isCommerceView()) renderEcommerce('orders'); };
  _cvPreloadTimer=setTimeout(()=>{
    if('requestIdleCallback' in window) requestIdleCallback(go,{timeout:4000}); else go();
  },2500);
}

/* ── store data (orders, products, Shopify) ──
   Same client_id-keyed /ecom/* routes ecom.html reads; refreshed at most once a minute while the
   commerce Home is opened. */
let _cvOrders=null, _cvProducts=null, _cvShop=null, _cvShopOrders=null, _cvLoadedAt=0, _cvLoading=null;
function cvLoadStore(force){
  if(_cvLoading) return _cvLoading;
  if(!force&&Date.now()-_cvLoadedAt<60000&&_cvOrders) return Promise.resolve();
  const base=`${CONFIG.WORKER_BASE}`, cid=encodeURIComponent(clientId);
  const get=url=>fetch(url).then(r=>r.ok?r.json():null).catch(()=>null);
  _cvLoading=Promise.all([
    get(`${base}/ecom/orders?client_id=${cid}&sort=-order_date&limit=1000`),
    get(`${base}/ecom/products?client_id=${cid}&limit=1000&include_inactive=true`),
    cvShopifyOn()?fetch(`${base}/shopify/analytics`,{headers:ncAuthHeaders()}).then(r=>r.ok?r.json():null).catch(()=>null):null,
    cvShopifyOn()?get(`${base}/ecom/shopify/orders?client_id=${cid}`):null,
  ]).then(([o,p,s,so])=>{
    if(o) _cvOrders=o.list||[];
    if(p) _cvProducts=p.list||[];
    _cvShop=s; _cvShopOrders=so?.list||null;
    _cvLoadedAt=Date.now();
  }).finally(()=>{
    _cvLoading=null;
    cvRenderCounts();
    if(!$id('pageStorehome')?.classList.contains('hidden')) renderStoreHome();
  });
  return _cvLoading;
}
const CV_OPEN=['pending','received','processing'];
function cvRenderCounts(){
  const n=(_cvOrders||[]).filter(o=>CV_OPEN.includes(String(o.status||'').toLowerCase())).length;
  document.querySelectorAll('#commerceSide [data-cv-count="orders"]').forEach(el=>{ el.textContent=n||''; el.style.display=n?'':'none'; el.title=`${n} to fulfil`; });
}

/* ── helpers ── */
const CV_DAY=86400000;
function cvNum(v){ const n=parseFloat(v); return isNaN(n)?0:n; }
function cvOrderDay(o){ return String(o.order_date||o.CreatedAt||'').slice(0,10); }
function cvOrderTs(o){ return Date.parse(o.CreatedAt||'')||Date.parse((o.order_date||'')+'T12:00:00')||0; }
function cvCountable(o){ const s=String(o.status||'').toLowerCase(); return s!=='cancelled'&&s!=='draft'; }
function cvLocalDay(t){ const d=new Date(t); return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10); }
function cvMoney(v,cur){
  const n=cvNum(v);
  try{ return new Intl.NumberFormat('en-IN',{style:'currency',currency:cur||'INR',maximumFractionDigits:0}).format(Math.round(n)); }
  catch(e){ return `${cur||''} ${Math.round(n).toLocaleString()}`.trim(); }
}
function cvCompact(v,cur){
  const n=cvNum(v);
  if(Math.abs(n)<100000) return cvMoney(n,cur);
  try{ return new Intl.NumberFormat('en-IN',{style:'currency',currency:cur||'INR',notation:'compact',maximumFractionDigits:1}).format(n); }
  catch(e){ return cvMoney(n,cur); }
}
function cvDelta(cur,prev){
  if(!prev) return cur?'<span class="cv-up">New</span>':'';
  const p=Math.round((cur-prev)/prev*100);
  return `<span class="${p>=0?'cv-up':'cv-down'}">${p>=0?'↑':'↓'} ${Math.abs(p)}%</span>`;
}
function cvShort(day){ const t=Date.parse(day+'T00:00:00'); return t?new Date(t).toLocaleDateString(undefined,{day:'numeric',month:'short'}):'—'; }
function cvItems(text){
  return String(text||'').split(/\n|;|,(?=\s*\d+\s*[x×]\s)/i).map(s=>s.trim()).filter(Boolean).map(line=>{
    const head=line.split('|')[0].trim(); let m;
    if((m=head.match(/^(\d+)\s*[x×]\s+(.+)$/i))) return {name:m[2].trim(),qty:+m[1]||1};
    if((m=head.match(/^(.+?)\s*[x×]\s*(\d+)$/i))) return {name:m[1].trim(),qty:+m[2]||1};
    return {name:head,qty:1};
  });
}
// Where an order came from — the same taken_by / shopify_order_id fields ecom.html records.
function cvChannel(o){
  if(o.shopify_order_id) return 'Shopify';
  const t=String(o.taken_by||'').toLowerCase();
  if(t==='ai_bot') return 'WhatsApp AI bot';
  if(t==='store_page') return 'Store page';
  if(t) return 'Team (manual)';
  return 'Other / imported';
}
function cvStatusPill(s){
  const k=String(s||'').toLowerCase();
  const tone={delivered:'ok',shipped:'ok',processing:'info',received:'info',pending:'warn',draft:'',cancelled:'bad'}[k]??'';
  const label=k==='draft'?'Draft (in chat)':(k?k.charAt(0).toUpperCase()+k.slice(1):'—');
  return `<span class="cv-pill ${tone}">${esc(label)}</span>`;
}

let _cvRange=30;
function cvSetRange(v){ _cvRange=Number(v)||30; renderStoreHome(); }

/* ── 🏠 COMMERCE HOME ── */
function renderStoreHome(){
  const el=$id('cvHomeBody');
  if(!el||!isCommerceView()||$id('pageStorehome')?.classList.contains('hidden')) return;
  const name=clientRecord?.client_name||'';
  const h=new Date().getHours();
  const greet=h<12?'Good morning':h<17?'Good afternoon':'Good evening';
  const storeLink=(clientRecord?.external_store_link||'').trim()||(clientRecord?.client_slug?`https://onshope.com/${encodeURIComponent(clientRecord.client_slug)}`:'');
  const head=`<div class="cv-head">
      <div><h1>${greet}${name?', '+esc(name):''}</h1>
        <div class="cv-sub">Here's what's happening with your store — ${esc(new Date().toLocaleDateString(undefined,{weekday:'long',day:'numeric',month:'long'}))}.</div></div>
      <div class="cv-actions">
        <select class="cv-sel" aria-label="Period" onchange="cvSetRange(this.value)">
          ${[[7,'Last 7 days'],[30,'Last 30 days'],[90,'Last 90 days']].map(([v,l])=>`<option value="${v}"${_cvRange===v?' selected':''}>${l}</option>`).join('')}
        </select>
        ${storeLink?`<a class="cv-btn" href="${esc(storeLink)}" target="_blank" rel="noopener">🔗 View store</a>`:''}
        ${cvCanSee('cvproducts')?`<button class="cv-btn" onclick="navigate('cvproducts')">+ Add product</button>`:''}
        ${cvCanSee('cvorders')?`<button class="cv-btn pri" onclick="navigate('cvorders')">+ Create order</button>`:''}
      </div></div>`;
  if(_cvOrders===null){
    el.innerHTML=head+`<div class="cv-kpis">${'<div class="cv-kpi"><div class="sk sk-row"></div><div class="sk sk-row"></div></div>'.repeat(5)}</div>`;
    return;
  }

  const days=_cvRange, now=Date.now(), from=now-days*CV_DAY, prevFrom=from-days*CV_DAY;
  const orders=_cvOrders, products=_cvProducts||[];
  const cur=orders.find(o=>o.currency)?.currency||clientRecord?.currency||'INR';
  const inR=(o,a,b)=>{ const t=cvOrderTs(o); return t>=a&&t<b; };
  const curO=orders.filter(o=>cvCountable(o)&&inR(o,from,now+CV_DAY));
  const prevO=orders.filter(o=>cvCountable(o)&&inR(o,prevFrom,from));
  const sum=l=>l.reduce((s,o)=>s+cvNum(o.total),0);
  const sales=sum(curO), prevSales=sum(prevO);
  const aov=curO.length?sales/curO.length:0, prevAov=prevO.length?prevSales/prevO.length:0;
  const toFulfil=orders.filter(o=>CV_OPEN.includes(String(o.status||'').toLowerCase()));
  const drafts=orders.filter(o=>String(o.status||'').toLowerCase()==='draft');
  const live=products.filter(p=>String(p.status||'').toLowerCase()!=='inactive');
  const out=live.filter(p=>cvNum(p.stock)<=0), low=live.filter(p=>{ const n=cvNum(p.stock); return n>0&&n<=5; });

  // Customers: chats (leads) that started in the period vs. orders placed — WhatsApp commerce's
  // own conversion rate. Repeat rate is by phone across every order on record.
  const leads=typeof allLeads!=='undefined'?allLeads:[];
  const fromDay=cvLocalDay(from), prevDay=cvLocalDay(prevFrom);
  const newLeads=leads.filter(l=>String(l.Date||'').slice(0,10)>=fromDay);
  const prevLeads=leads.filter(l=>{ const d=String(l.Date||'').slice(0,10); return d>=prevDay&&d<fromDay; });
  const conv=newLeads.length?Math.min(100,Math.round(curO.length/newLeads.length*100)):0;
  const prevConv=prevLeads.length?Math.min(100,Math.round(prevO.length/prevLeads.length*100)):0;
  const pk=o=>{ const d=String(o.customer_phone||'').replace(/\D/g,''); return d.length>10?d.slice(-10):d; };
  const perPhone={}; orders.filter(cvCountable).forEach(o=>{ const k=pk(o); if(k) perPhone[k]=(perPhone[k]||0)+1; });
  const buyers=[...new Set(curO.map(pk).filter(Boolean))];
  const repeat=buyers.filter(k=>perPhone[k]>1).length;

  const kpi=(l,v,{badge='',foot='',tone='',go=''}={})=>`<div class="cv-kpi ${tone}${go?' click':''}"${go?` onclick="${go}"`:''}><div class="cv-kpi-l"><span>${esc(l)}</span>${badge}</div><div class="cv-kpi-v">${v}</div>${foot?`<div class="cv-kpi-f">${foot}</div>`:''}</div>`;
  const kpis=`<div class="cv-kpis">
    ${kpi('Total sales',cvCompact(sales,cur),{badge:cvDelta(sales,prevSales),foot:`vs ${esc(cvCompact(prevSales,cur))} previous ${days} days`})}
    ${kpi('Orders',curO.length.toLocaleString(),{badge:cvDelta(curO.length,prevO.length),foot:`${toFulfil.length} waiting to be fulfilled`,go:"navigate('cvorders')"})}
    ${kpi('Average order value',cvMoney(aov,cur),{badge:cvDelta(aov,prevAov)})}
    ${kpi('Chat → order conversion',newLeads.length?conv+'%':'—',{badge:newLeads.length?cvDelta(conv,prevConv):'',foot:`${curO.length} orders from ${newLeads.length} new chats`,go:"navigate('leads')"})}
    ${kpi('Returning customers',buyers.length?Math.round(repeat/buyers.length*100)+'%':'—',{foot:`${repeat} of ${buyers.length} buyers ordered before`,go:"navigate('leads')"})}
  </div>`;

  // Sales over time — one bar per day (revenue; order count in each bar's tooltip).
  const buckets=[]; for(let i=days-1;i>=0;i--) buckets.push({day:cvLocalDay(now-i*CV_DAY),v:0,n:0});
  const byDay=Object.fromEntries(buckets.map(b=>[b.day,b]));
  curO.forEach(o=>{ const b=byDay[cvOrderDay(o)]; if(b){ b.v+=cvNum(o.total); b.n++; } });
  const W=760,H=210,pl=52,pb=22,pt=10;
  const maxV=Math.max(1,...buckets.map(b=>b.v));
  const bw=(W-pl-6)/buckets.length, y=v=>pt+(H-pt-pb)*(1-v/maxV);
  let svg='';
  [0,.5,1].forEach(f=>{ const yy=y(maxV*f); svg+=`<line x1="${pl}" x2="${W}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" stroke="var(--line)"${f?' stroke-dasharray="3 3"':''}/><text x="${pl-6}" y="${(yy+3).toFixed(1)}" text-anchor="end">${esc(cvCompact(maxV*f,cur))}</text>`; });
  const every=Math.ceil(buckets.length/8);
  buckets.forEach((b,i)=>{
    const x=pl+i*bw+bw*.15;
    svg+=`<rect x="${x.toFixed(1)}" y="${y(b.v).toFixed(1)}" width="${Math.max(1,bw*.7).toFixed(1)}" height="${Math.max(0,H-pb-y(b.v)).toFixed(1)}" rx="2" fill="var(--accent)" opacity="${b.v?.85:.15}"><title>${esc(cvShort(b.day))}: ${esc(cvMoney(b.v,cur))} · ${b.n} order${b.n===1?'':'s'}</title></rect>`;
    if(i%every===0) svg+=`<text x="${(x+bw*.35).toFixed(1)}" y="${H-6}" text-anchor="middle">${esc(cvShort(b.day))}</text>`;
  });

  // To-do list — the store's "needs attention" queue, each row a shortcut.
  const chatsWaiting=Number(String($id('dnChatBadge')?.style.display!=='none'&&$id('dnChatBadge')?.textContent||'').replace(/\D/g,''))||0;
  const handovers=leads.filter(l=>!['won','converted','lost'].includes(l.Stage)&&(l.Stage==='human_handover'||l.Handover==='Yes')).length;
  const shopUnful=(_cvShopOrders||[]).filter(o=>!o.cancelled_at&&!['fulfilled','restocked'].includes(String(o.fulfillment_status||'unfulfilled'))).length;
  const abandoned=_cvShop&&_cvShop.total_checkouts?(_cvShop.total_checkouts-_cvShop.completed_checkouts):0;
  const todo=[
    [toFulfil.length,'🧾',`<b>${toFulfil.length}</b> order${toFulfil.length===1?'':'s'} to fulfil`,"navigate('cvorders')"],
    [drafts.length,'📝',`<b>${drafts.length}</b> draft order${drafts.length===1?'':'s'} being placed in WhatsApp`,"navigate('cvorders')"],
    [chatsWaiting,'💬',`<b>${chatsWaiting}</b> unread chat${chatsWaiting===1?'':'s'} in the inbox`,"navigate('chats')"],
    [handovers,'🤝',`<b>${handovers}</b> customer${handovers===1?'':'s'} handed over by the bot`,"navigate('humandeals')"],
    [shopUnful,'🛍️',`<b>${shopUnful}</b> Shopify order${shopUnful===1?'':'s'} unfulfilled`,"navigate('cvshoporders')"],
    [abandoned,'🛒',`<b>${abandoned}</b> abandoned checkout${abandoned===1?'':'s'} (last 6 months)`,"navigate('reports')"],
    [out.length,'⛔',`<b>${out.length}</b> product${out.length===1?'':'s'} out of stock`,"navigate('cvproducts')"],
    [low.length,'⚠️',`<b>${low.length}</b> product${low.length===1?'':'s'} low on stock (≤ 5)`,"navigate('cvproducts')"],
  ].filter(t=>t[0]>0&&cvCanSee(t[3].match(/'(\w+)'/)[1]));

  // Top products, channels and the order funnel.
  const top={};
  curO.forEach(o=>{
    let lines=null; try{ lines=o.line_items_json?JSON.parse(o.line_items_json):null; }catch(e){}
    if(Array.isArray(lines)&&lines.length) lines.forEach(li=>{ const k=li.title||'Item'; const t=top[k]||(top[k]={q:0,r:0}); t.q+=cvNum(li.quantity)||1; t.r+=cvNum(li.price)*(cvNum(li.quantity)||1); });
    else { const items=cvItems(o.items); const share=items.length?cvNum(o.total)/items.reduce((s,i)=>s+i.qty,0):0;
      items.forEach(i=>{ const t=top[i.name]||(top[i.name]={q:0,r:0}); t.q+=i.qty; t.r+=share*i.qty; }); }
  });
  const topList=Object.entries(top).sort((a,b)=>b[1].r-a[1].r||b[1].q-a[1].q).slice(0,6);
  const maxR=Math.max(1,...topList.map(([,t])=>t.r));
  const chan={}; curO.forEach(o=>{ const c=cvChannel(o); const x=chan[c]||(chan[c]={n:0,r:0}); x.n++; x.r+=cvNum(o.total); });
  const chanList=Object.entries(chan).sort((a,b)=>b[1].r-a[1].r);
  const maxC=Math.max(1,...chanList.map(([,c])=>c.r));
  const recent=[...orders].sort((a,b)=>cvOrderTs(b)-cvOrderTs(a)).slice(0,7);
  const fShipped=curO.filter(o=>['shipped','delivered'].includes(String(o.status||'').toLowerCase())).length;
  const fDelivered=curO.filter(o=>String(o.status||'').toLowerCase()==='delivered').length;
  const funnel=[['New chats',newLeads.length],['Orders placed',curO.length],['Shipped',fShipped],['Delivered',fDelivered]];
  const fMax=Math.max(1,...funnel.map(f=>f[1]));

  el.innerHTML=head+(cvShopifyOn()?'':`<div class="cv-banner">🛍️ <span style="flex:1">Sell on Shopify too? Connect your store and its orders and stock sync here automatically.</span>
      ${cvCanSee('settings')?`<button class="cv-btn" onclick="navigate('integrations')">Connect Shopify</button>`:''}</div>`)+kpis+`
    <div class="cv-grid">
      <div class="cv-card"><div class="cv-card-h"><h3>Sales over time</h3><span class="cv-muted">${esc(cvMoney(sales,cur))} · ${curO.length} orders</span></div>
        <svg class="cv-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily sales">${svg}</svg></div>
      <div class="cv-card cv-todo"><div class="cv-card-h"><h3>To do</h3></div>
        ${todo.length?todo.map(([,ic,t,go])=>`<div class="cv-row" onclick="${go}"><span class="ic">${ic}</span><span class="grow">${t}</span><span class="cv-muted">→</span></div>`).join(''):'<div class="cv-empty">✨ All caught up — nothing needs you right now.</div>'}</div>
    </div>
    <div class="cv-grid">
      <div class="cv-card"><div class="cv-card-h"><h3>Recent orders</h3>${cvCanSee('cvorders')?`<button class="cv-link" onclick="navigate('cvorders')">View all →</button>`:''}</div>
        ${recent.length?recent.map(o=>`<div class="cv-row" onclick="navigate('cvorders')"><b style="min-width:84px">#${esc(String(o.order_id||o.Id||'').replace(/^#/,''))}</b><span class="grow">${esc(o.customer_name||o.customer_phone||'—')}<span class="cv-muted"> · ${esc(cvShort(cvOrderDay(o)))} · ${esc(cvChannel(o))}</span></span>${cvStatusPill(o.status)}<span class="amt" style="min-width:90px;text-align:right">${esc(cvMoney(o.total,o.currency||cur))}</span></div>`).join(''):'<div class="cv-empty">No orders yet — orders from WhatsApp chats, your store page and Shopify all land here.</div>'}</div>
      <div class="cv-card"><div class="cv-card-h"><h3>Top products</h3>${cvCanSee('cvproducts')?`<button class="cv-link" onclick="navigate('cvproducts')">Catalog →</button>`:''}</div>
        ${topList.length?topList.map(([n,t])=>`<div class="cv-bar"><span class="lbl" title="${esc(n)}">${esc(n)}</span><span class="trk"><i style="width:${Math.round(t.r/maxR*100)||4}%"></i></span><span class="n">${t.r?esc(cvCompact(t.r,cur)):t.q+' sold'}</span></div>`).join(''):`<div class="cv-empty">No items sold in the last ${days} days.</div>`}</div>
    </div>
    <div class="cv-grid">
      <div class="cv-card"><div class="cv-card-h"><h3>Sales by channel</h3><span class="cv-muted">Last ${days} days</span></div>
        ${chanList.length?chanList.map(([c,x])=>`<div class="cv-bar"><span class="lbl">${esc(c)}</span><span class="trk"><i style="width:${Math.round(x.r/maxC*100)||4}%"></i></span><span class="n">${esc(cvCompact(x.r,cur))} · ${x.n}</span></div>`).join(''):'<div class="cv-empty">No sales in this period.</div>'}</div>
      <div class="cv-card cv-funnel"><div class="cv-card-h"><h3>Chat-to-delivery funnel</h3><span class="cv-muted">Last ${days} days</span></div>
        ${funnel.map(([l,n])=>`<div class="cv-bar"><span class="lbl">${l}</span><span class="trk"><i style="width:${Math.round(n/fMax*100)}%"></i></span><span class="n">${n}</span></div>`).join('')}</div>
    </div>
    <div class="cv-grid">
      <div class="cv-card"><div class="cv-card-h"><h3>Newest customers</h3>${cvCanSee('leads')?`<button class="cv-link" onclick="navigate('leads')">All customers →</button>`:''}</div>
        ${leads.length?[...leads].sort((a,b)=>String(b.Date||'').localeCompare(String(a.Date||''))).slice(0,6).map(l=>`<div class="cv-row" onclick="openDetail(${Number(l.Id)})"><span class="grow">${esc((typeof leadDisplayName==='function'?leadDisplayName(l):l.Name||l.Phone)||'Customer')}<span class="cv-muted"> · ${esc(cvShort(String(l.Date||'').slice(0,10)))}</span></span><span class="cv-pill">${esc(typeof stageLabel==='function'?stageLabel(l.Stage||'new'):(l.Stage||'new'))}</span></div>`).join(''):'<div class="cv-empty">No customers yet.</div>'}</div>
      <div class="cv-card"><div class="cv-card-h"><h3>Inventory</h3>${cvCanSee('cvproducts')?`<button class="cv-link" onclick="navigate('cvproducts')">Manage →</button>`:''}</div>
        <div class="cv-bar"><span class="lbl">Active products</span><span class="n" style="margin-left:auto">${live.length}</span></div>
        <div class="cv-bar"><span class="lbl">In stock</span><span class="n" style="margin-left:auto">${live.length-out.length}</span></div>
        <div class="cv-bar"><span class="lbl">Low (≤ 5)</span><span class="n" style="margin-left:auto;color:#B45309">${low.length}</span></div>
        <div class="cv-bar"><span class="lbl">Out of stock</span><span class="n" style="margin-left:auto;color:#B91C1C">${out.length}</span></div>
        ${cvShopifyOn()&&cvCanSee('cvshopstock')?`<div style="margin-top:8px"><button class="cv-link" onclick="navigate('cvshopstock')">Shopify stock levels →</button></div>`:''}</div>
    </div>`;
}
