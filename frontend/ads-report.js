/* ── Reports → 💸 Ads ROI ─────────────────────────────────────────────────────────────────────
   What Ads Manager can't show: what happened after the click. Meta spend per campaign / ad set /
   ad (synced by the Worker into D1 — cloudflare-worker/meta-ads-report.js) joined here with this
   CRM's own leads: quality, calls, sales and revenue. Ad creation and editing stay in Ads Manager.
     1. Attribution   a lead's AdId / CampaignId (lead forms) or AdId + CtwaClid (click-to-WhatsApp);
                      older leads by campaign name or the "Ad ID …" the bot used to write.
     2. Spend vs sales spend, Meta's lead count, CRM leads, qualified, sales, revenue, cost per lead /
                      qualified lead / sale and ROAS at each level.
     3. Lead quality  Hot / Warm / Cold, junk (Spam), not reachable (called, never answered), lost.
     5. Speed to lead first call after the lead arrived: within 5 min / 1 h / 24 h, never called.
     6. Staff         the same per owner, on ad leads only.
     4. Results sent to Meta (Conversions API) by match key; 7/8. daily summary, alerts and the
                      Accounting expense are set up in the settings card at the bottom.
   Sales are the leads that arrived in the period and are won now (a cohort), so a campaign gets
   credit for sales that close later. Uses dashboard.html globals: $id, esc, allLeads, clientRecord,
   _rptFilters, rptByCategory, _rptOlder, rptLoadOlderLeads, _reportsPage, isWonLead, isLostLead,
   parseCallLog, csConnected, getTeamMembers, sameEmail, isAccountOwner, openDetail, navigate,
   showToast, ncAuthHeaders, CONFIG.
   Bump the ?v= on its <script> tag in dashboard.html when changing this file — sw.js serves
   scripts cache-first. ── */

const ADS_LEVELS=[['campaign','Campaign'],['adset','Ad set'],['ad','Ad']];
let _adsLevel='campaign';
let _adsCache={key:'', at:0, data:null, capi:null, settings:null};

// Mirrors marLeadAdRef / marMatchLead in cloudflare-worker/meta-ads-report.js — keep them in step.
function adsLeadAdRef(l){
  const camp=String(l?.AdCampaign||'').trim();
  const legacyId=(camp.match(/^Ad ID (\d{5,25})$/)||[])[1]||'';
  const adId=String(l?.AdId||'').trim()||legacyId;
  const campaignId=String(l?.CampaignId||'').trim();
  const src=`${l?.LeadSource||''} ${l?.Source||''}`;
  const isAd=!!(adId||campaignId||String(l?.CtwaClid||'').trim()||String(l?.MetaLeadgenId||'').trim()
    ||/lead ad|lead form|click-to-whatsapp|\b(meta|facebook|instagram|fb|ig) ads?\b/i.test(src));
  return {isAd, adId, campaignId, campaignName:legacyId?'':camp, adName:String(l?.AdName||'').trim()};
}
function adsIndex(ads){
  const byAd=new Map(), byCampaign=new Map(), byCampaignName=new Map(), byAdset=new Map();
  for(const a of ads||[]){
    if(a.ad_id) byAd.set(String(a.ad_id), a);
    if(a.adset_id && !byAdset.has(String(a.adset_id))) byAdset.set(String(a.adset_id), a);
    if(a.campaign_id){
      if(!byCampaign.has(String(a.campaign_id))) byCampaign.set(String(a.campaign_id), a);
      const n=String(a.campaign_name||'').trim().toLowerCase(); if(n && !byCampaignName.has(n)) byCampaignName.set(n, String(a.campaign_id));
    }
  }
  return {byAd, byCampaign, byCampaignName, byAdset};
}
function adsMatchLead(l, idx){
  const ref=adsLeadAdRef(l);
  if(!ref.isAd) return null;
  const ad=ref.adId&&idx.byAd.get(ref.adId);
  if(ad) return {campaign_id:String(ad.campaign_id||''), adset_id:String(ad.adset_id||''), ad_id:String(ad.ad_id)};
  if(ref.campaignId && idx.byCampaign.has(ref.campaignId)) return {campaign_id:ref.campaignId, adset_id:'', ad_id:''};
  const byName=ref.campaignName && idx.byCampaignName.get(ref.campaignName.toLowerCase());
  if(byName) return {campaign_id:byName, adset_id:'', ad_id:''};
  return {campaign_id:'', adset_id:'', ad_id:''};
}
function adsTs(v){ if(!v) return NaN; const s=String(v).trim(); return Date.parse(/^\d{4}-\d{2}-\d{2} \d/.test(s)?s.replace(' ','T'):s); }
// When the lead arrived — NocoDB's CreatedAt first: the bot rewrites Date on every message turn.
function adsArrivedMs(l){ const c=adsTs(l?.CreatedAt); return Number.isFinite(c)?c:adsTs(l?.Date); }
function adsLocalDay(ms){ const d=new Date(ms); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function adsAddDays(day, n){ const d=new Date(day+'T12:00:00'); d.setDate(d.getDate()+n); return adsLocalDay(d.getTime()); }
function adsIsJunk(l){ return l.HandoverOutcome==='Spam'; }
function adsFirstCallMin(l, arrived){
  let calls=[]; try{ calls=parseCallLog(l.CallLog); }catch(e){}
  const times=calls.map(c=>adsTs(c.at||c.date)).filter(Number.isFinite);
  if(!times.length) return null;
  return Math.max(0, (Math.min(...times)-arrived)/60000);
}

// The Reports filter bar's period as a day range. "All Time" = the 90 days the Worker backfills.
function adsRange(){
  const f=_rptFilters||{}; const today=adsLocalDay(Date.now()); const now=new Date();
  if(f.period==='today') return {from:today, to:today};
  if(f.period==='week'){ const d=new Date(now); d.setDate(now.getDate()-now.getDay()); return {from:adsLocalDay(d.getTime()), to:today}; }
  if(f.period==='month') return {from:adsLocalDay(new Date(now.getFullYear(), now.getMonth(), 1).getTime()), to:today};
  if(f.period==='year') return {from:adsLocalDay(new Date(now.getFullYear(), 0, 1).getTime()), to:today};
  if(f.period==='custom'){ const to=f.to||today; return {from:f.from||adsAddDays(to, -29), to}; }
  return {from:adsAddDays(today, -89), to:today, all:true};
}

async function adsFetch(range, force){
  const key=range.from+'|'+range.to;
  if(!force && _adsCache.key===key && Date.now()-_adsCache.at<60000) return _adsCache;
  const get=p=>fetch(`${CONFIG.WORKER_BASE}/meta/ads-report/${p}`, {headers:ncAuthHeaders()}).then(r=>r.json()).catch(()=>null);
  const [data, capi, settings]=await Promise.all([get(`data?from=${range.from}&to=${range.to}`), get('capi?days=30'), get('settings')]);
  _adsCache={key, at:Date.now(), data, capi, settings};
  return _adsCache;
}

function adsMoneyFmt(ccy){
  const c=String(ccy||'').toUpperCase();
  return n=>n==null||!Number.isFinite(n)?'—':(c==='INR'?'₹':c==='USD'?'$':c?c+' ':'')+Math.round(n).toLocaleString();
}
const adsPct=(n,d)=>d?Math.round(n/d*100)+'%':'—';

// One row of metrics, from the spend rows and the CRM leads that belong to it.
function adsBlank(key, name, sub){ return {key, name, sub:sub||'', spend:0, impressions:0, clicks:0, metaLeads:0, leads:0, hot:0, warm:0, cold:0, qualified:0, junk:0, unreachable:0, lost:0, won:0, revenue:0}; }
function adsAddLead(r, l){
  r.leads++;
  const won=isWonLead(l);
  if(l.Score==='Hot') r.hot++; else if(l.Score==='Cold') r.cold++; else r.warm++;
  if(l.Score==='Hot'||won) r.qualified++;
  if(adsIsJunk(l)) r.junk++;
  else if(isLostLead(l)) r.lost++;
  let calls=[]; try{ calls=parseCallLog(l.CallLog); }catch(e){}
  if(calls.length && !calls.some(csConnected)) r.unreachable++;
  if(won){ r.won++; r.revenue+=Number(l.DealValue)||0; }
}

function adsCompute(cache, range){
  const data=cache.data||{};
  const ads=data.ads||[];
  const idx=adsIndex(ads);
  const loaded=new Set(allLeads.map(l=>l.Id));
  let pool=allLeads.concat((_rptOlder?.list||[]).filter(l=>!loaded.has(l.Id)));
  pool=rptByCategory(pool);
  const member=$id('rptMember')?.value||'';
  const adLeads=[];
  for(const l of pool){
    const ms=adsArrivedMs(l); if(!Number.isFinite(ms)) continue;
    const day=adsLocalDay(ms); if(day<range.from||day>range.to) continue;
    if(member && !sameEmail(l.Owner, member)) continue;
    const m=adsMatchLead(l, idx); if(!m) continue;
    adLeads.push({l, m, ms});
  }
  const levelKey={campaign:a=>a.campaign_id, adset:a=>a.adset_id, ad:a=>a.ad_id};
  const rows=new Map();
  const rowFor=(key, a)=>{
    if(rows.has(key)) return rows.get(key);
    let r;
    if(!key) r=adsBlank('', 'Ad leads not matched to a campaign', 'No ad or campaign id on these leads — older leads, or the ad wasn\'t in the synced spend');
    else if(_adsLevel==='campaign') r=adsBlank(key, a?.campaign_name||'Campaign '+key);
    else if(_adsLevel==='adset') r=key.startsWith('c:')?adsBlank(key, idx.byCampaign.get(key.slice(2))?.campaign_name||'Campaign', 'Ad set not known (campaign-level match)'):adsBlank(key, a?.adset_name||'Ad set '+key, a?.campaign_name||'');
    else r=key.startsWith('c:')?adsBlank(key, idx.byCampaign.get(key.slice(2))?.campaign_name||'Campaign', 'Ad not known (campaign-level match)'):adsBlank(key, a?.ad_name||'Ad '+key, [a?.campaign_name, a?.adset_name].filter(Boolean).join(' › '));
    rows.set(key, r); return r;
  };
  for(const a of ads){
    if(!(a.spend>0||a.meta_leads>0||a.meta_chats>0)) continue;
    const r=rowFor(String(levelKey[_adsLevel](a)||''), a);
    r.spend+=Number(a.spend)||0; r.impressions+=Number(a.impressions)||0; r.clicks+=Number(a.clicks)||0;
    r.metaLeads+=(Number(a.meta_leads)||0)+(Number(a.meta_chats)||0);
  }
  for(const {l, m} of adLeads){
    let key=m[_adsLevel+'_id'];
    if(!key && m.campaign_id) key='c:'+m.campaign_id;
    if(_adsLevel==='campaign') key=m.campaign_id;
    const a=_adsLevel==='campaign'?idx.byCampaign.get(m.campaign_id):_adsLevel==='adset'?idx.byAdset.get(m.adset_id):idx.byAd.get(m.ad_id);
    adsAddLead(rowFor(key||'', a), l);
  }
  const list=[...rows.values()].sort((a,b)=>(!a.key)-(!b.key)||b.spend-a.spend||b.leads-a.leads);
  const total=adsBlank('total', 'Total');
  for(const r of list) for(const k of ['spend','impressions','clicks','metaLeads','leads','hot','warm','cold','qualified','junk','unreachable','lost','won','revenue']) total[k]+=r[k];
  return {rows:list, total, adLeads, idx};
}

function adsSpeedStats(adLeads){
  let w5=0, w60=0, w1440=0, never=0; const mins=[]; const notCalled=[];
  for(const {l, ms} of adLeads){
    if(adsIsJunk(l)) continue;
    const m=adsFirstCallMin(l, ms);
    if(m==null){ never++; if(!isWonLead(l)&&!isLostLead(l)) notCalled.push({l, ms}); continue; }
    mins.push(m); if(m<=5) w5++; if(m<=60) w60++; if(m<=1440) w1440++;
  }
  mins.sort((a,b)=>a-b);
  const median=mins.length?mins[Math.floor((mins.length-1)/2)]:null;
  return {n:mins.length+never, w5, w60, w1440, never, median, notCalled:notCalled.sort((a,b)=>a.ms-b.ms)};
}
function adsMinutes(m){ if(m==null) return '—'; if(m<60) return Math.round(m)+' min'; if(m<1440) return (Math.round(m/6)/10)+' h'; return (Math.round(m/144)/10)+' days'; }

function adsStaffRows(adLeads){
  const by=new Map(); const names=new Map(getTeamMembers().map(m=>[m.email.toLowerCase(), m.name]));
  for(const {l, ms} of adLeads){
    const k=String(l.Owner||'').trim().toLowerCase();
    if(!by.has(k)) by.set(k, {name:k?(names.get(k)||l.Owner):'Unassigned', leads:0, called:0, answered:0, qualified:0, won:0, revenue:0, mins:[], junk:0});
    const r=by.get(k);
    r.leads++;
    if(adsIsJunk(l)) r.junk++;
    let calls=[]; try{ calls=parseCallLog(l.CallLog); }catch(e){}
    if(calls.length) r.called++;
    if(calls.some(csConnected)) r.answered++;
    const won=isWonLead(l);
    if(l.Score==='Hot'||won) r.qualified++;
    if(won){ r.won++; r.revenue+=Number(l.DealValue)||0; }
    const m=adsFirstCallMin(l, ms); if(m!=null) r.mins.push(m);
  }
  return [...by.values()].map(r=>{ r.mins.sort((a,b)=>a-b); r.median=r.mins.length?r.mins[Math.floor((r.mins.length-1)/2)]:null; return r; }).sort((a,b)=>b.leads-a.leads);
}

async function renderReportsAds(force){
  const el=$id('reportsContent');
  const range=adsRange();
  if(!_adsCache.data || _adsCache.key!==range.from+'|'+range.to) el.innerHTML='<div style="text-align:center;padding:40px;color:var(--muted)">Loading ad spend…</div>';
  // Older leads beyond what's in memory, so a long period isn't undercounted (same as Leads & Calls).
  if(typeof rptLoadOlderLeads==='function' && !_rptOlder.loading && Date.now()-_rptOlder.at>300000)
    rptLoadOlderLeads().then(()=>{ if(_reportsPage==='ads') renderReportsAds(); });
  const cache=await adsFetch(range, force);
  if(_reportsPage!=='ads') return;
  const data=cache.data||{};
  const {rows, total, adLeads}=adsCompute(cache, range);
  const accCcy=data.currency||'';
  const dealCcy=clientRecord?.deal_currency||'';
  const money=adsMoneyFmt(accCcy), dealMoney=adsMoneyFmt(dealCcy||accCcy);
  const sameCcy=!dealCcy||!accCcy||dealCcy.toUpperCase()===accCcy.toUpperCase();
  const connected=!!data.connected;
  const spendOf=v=>connected?money(v):'—';
  const ratio=(num, den)=>connected&&den&&num>0?money(num/den):'—'; // no spend matched = unknown cost, not free
  const roas=r=>connected&&sameCcy&&r.spend>0&&r.revenue>0?(r.revenue/r.spend).toFixed(1)+'×':'—';
  const member=$id('rptMember')?.value||'';
  const synced=data.last_ok_at?new Date(data.last_ok_at).toLocaleString():'never';
  const speed=adsSpeedStats(adLeads);
  const staff=adsStaffRows(adLeads);
  const stat=(lbl, val, hint, accent)=>`<div class="stat${accent?' accent':''}"${hint?` title="${esc(hint)}"`:''}><div class="stat-lbl">${lbl}</div><div class="stat-val">${val}</div></div>`;

  el.innerHTML=`
    <div style="display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap;margin-bottom:14px">
      <div style="flex:1;min-width:240px"><div class="card-title" style="margin-bottom:0">💸 Ads ROI</div>
        <div class="s-note">Meta spend joined with what happened after the click — lead quality, calls, sales and revenue from this CRM. ${range.from} → ${range.to}${range.all?' (All Time = last 90 days of synced spend)':''}. Sales = leads from this period that are won now.</div></div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <span class="s-note" id="adsSynced">${connected?`${esc(data.account_name||'Ad account')} · synced ${esc(synced)}`:''}</span>
        ${connected?'<button class="btn btn-secondary btn-sm" id="adsSyncBtn" onclick="adsSyncNow()">🔄 Sync now</button>':''}
      </div>
    </div>
    ${!connected?`<div class="card" id="adsNotConnected" style="margin-bottom:14px"><div class="s-note">Spend isn't connected — <a href="#" onclick="navigate('integrations');return false">add your Ad Account ID and token in Settings → Integrations → Meta Ads</a> (the token needs <b>ads_read</b>). Lead quality, speed and staff numbers below already work.</div></div>`:''}
    ${connected&&data.last_error?`<div class="card" id="adsSyncError" style="margin-bottom:14px;border-color:var(--red)"><div class="s-note" style="color:var(--red)">⚠️ Last sync failed: ${esc(data.last_error)}</div></div>`:''}
    ${member?'<div class="s-note" style="margin-bottom:10px">Spend is for the whole ad account; leads, sales and calls are only this team member\'s.</div>':''}
    ${!sameCcy?`<div class="s-note" style="margin-bottom:10px">Ad account is in ${esc(accCcy)}, deals in ${esc(dealCcy)} — ROAS is hidden; revenue is shown in ${esc(dealCcy)}.</div>`:''}

    <div id="adsKpis" style="display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));margin-bottom:14px">
      ${stat('Spend', spendOf(total.spend))}
      ${stat('Meta counted', connected?total.metaLeads:'—', 'Leads + WhatsApp conversations as Meta counts them')}
      ${stat('Ad leads in CRM', total.leads)}
      ${stat('Qualified', total.qualified, 'Hot or won')}
      ${stat('Junk', total.junk, 'Marked Spam')}
      ${stat('Sales', total.won)}
      ${stat('Revenue', dealMoney(total.revenue))}
      ${stat('ROAS', roas(total), 'Revenue ÷ spend', true)}
      ${stat('Cost / lead', ratio(total.spend, total.leads))}
      ${stat('Cost / qualified', ratio(total.spend, total.qualified))}
      ${stat('Cost / sale', ratio(total.spend, total.won))}
    </div>

    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <div class="s-head" style="margin:0;flex:1">Spend vs sales</div>
        <div style="display:flex;gap:3px" id="adsLevelBtns">${ADS_LEVELS.map(([k,l])=>`<button class="rpt-period${_adsLevel===k?' active':''}" data-level="${k}" onclick="adsSetLevel('${k}')">${l}</button>`).join('')}</div>
      </div>
      <div style="overflow-x:auto"><table class="leads-tbl" id="adsTable" style="width:100%;min-width:980px">
        <thead><tr><th>${ADS_LEVELS.find(x=>x[0]===_adsLevel)[1]}</th><th>Spend</th><th>Meta counted</th><th>CRM leads</th><th>Qualified</th><th>Sales</th><th>Revenue</th><th>Cost/lead</th><th>Cost/qualified</th><th>Cost/sale</th><th>ROAS</th></tr></thead>
        <tbody>${rows.length?rows.map(r=>`<tr${r.key?'':' style="color:var(--muted)"'}>
          <td style="white-space:normal;max-width:none;overflow:visible;min-width:200px"><div>${esc(r.name)}</div>${r.sub?`<div class="s-note">${esc(r.sub)}</div>`:''}</td>
          <td>${spendOf(r.spend)}</td><td>${connected?r.metaLeads:'—'}</td><td>${r.leads}</td><td>${r.qualified}</td><td>${r.won}</td><td>${dealMoney(r.revenue)}</td>
          <td>${ratio(r.spend, r.leads)}</td><td>${ratio(r.spend, r.qualified)}</td><td>${ratio(r.spend, r.won)}</td><td>${roas(r)}</td></tr>`).join('')
          :'<tr><td colspan="11" style="color:var(--muted)">No ad spend or ad leads in this period.</td></tr>'}</tbody>
        ${rows.length?`<tfoot><tr style="font-weight:700"><td>Total</td><td>${spendOf(total.spend)}</td><td>${connected?total.metaLeads:'—'}</td><td>${total.leads}</td><td>${total.qualified}</td><td>${total.won}</td><td>${dealMoney(total.revenue)}</td><td>${ratio(total.spend, total.leads)}</td><td>${ratio(total.spend, total.qualified)}</td><td>${ratio(total.spend, total.won)}</td><td>${roas(total)}</td></tr></tfoot>`:''}
      </table></div>
      ${connected&&total.metaLeads&&total.leads<total.metaLeads*0.5?`<div class="s-note" style="margin-top:8px">Meta counted ${total.metaLeads} but only ${total.leads} reached this CRM as ad leads — check that lead forms are connected (Integrations → Lead Forms) and that click-to-WhatsApp chats come through Chatwoot.</div>`:''}
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="s-head" style="margin-bottom:8px">Lead quality by ${ADS_LEVELS.find(x=>x[0]===_adsLevel)[1].toLowerCase()}</div>
      <div style="overflow-x:auto"><table class="leads-tbl" id="adsQuality" style="width:100%;min-width:760px">
        <thead><tr><th>${ADS_LEVELS.find(x=>x[0]===_adsLevel)[1]}</th><th>Leads</th><th>🔥 Hot</th><th>Warm</th><th>❄️ Cold</th><th>Junk</th><th>Not reachable</th><th>Lost</th><th>Qualified rate</th></tr></thead>
        <tbody>${rows.filter(r=>r.leads).map(r=>`<tr><td>${esc(r.name)}</td><td>${r.leads}</td><td>${r.hot}</td><td>${r.warm}</td><td>${r.cold}</td>
          <td${r.junk/r.leads>=0.3?' style="color:var(--red);font-weight:700"':''}>${r.junk} (${adsPct(r.junk, r.leads)})</td><td>${r.unreachable} (${adsPct(r.unreachable, r.leads)})</td><td>${r.lost}</td><td>${adsPct(r.qualified, r.leads)}</td></tr>`).join('')
          ||'<tr><td colspan="9" style="color:var(--muted)">No ad leads in this period.</td></tr>'}</tbody>
      </table></div>
      <div class="s-note" style="margin-top:6px">Not reachable = called at least once, never answered. Junk = marked Spam.</div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="s-head" style="margin-bottom:8px">⚡ Speed to lead (ad leads)</div>
      <div id="adsSpeed" style="display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));margin-bottom:10px">
        ${stat('Called within 5 min', adsPct(speed.w5, speed.n))}
        ${stat('Within 1 hour', adsPct(speed.w60, speed.n))}
        ${stat('Within 24 hours', adsPct(speed.w1440, speed.n))}
        ${stat('Never called', speed.never)}
        ${stat('Median first call', adsMinutes(speed.median))}
      </div>
      ${speed.notCalled.length?`<div class="s-note" style="margin-bottom:6px">Open ad leads with no call yet (oldest first):</div>
        <div id="adsNotCalled" style="display:flex;flex-direction:column;gap:4px">${speed.notCalled.slice(0,10).map(({l, ms})=>`<a href="#" onclick="openDetail(${Number(l.Id)});return false" style="font-size:13px">${esc(l.Name||l.Phone||'Lead '+l.Id)} <span class="s-note">· ${esc(l.Owner||'Unassigned')} · waiting ${adsMinutes((Date.now()-ms)/60000)}</span></a>`).join('')}
        ${speed.notCalled.length>10?`<span class="s-note">…and ${speed.notCalled.length-10} more</span>`:''}</div>`:''}
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="s-head" style="margin-bottom:8px">👥 Staff on ad leads</div>
      <div style="overflow-x:auto"><table class="leads-tbl" id="adsStaff" style="width:100%;min-width:760px">
        <thead><tr><th>Staff</th><th>Ad leads</th><th>Called</th><th>Answered</th><th>Median first call</th><th>Qualified</th><th>Sales</th><th>Revenue</th><th>Conversion</th></tr></thead>
        <tbody>${staff.map(r=>`<tr><td>${esc(r.name)}</td><td>${r.leads}</td><td>${adsPct(r.called, r.leads)}</td><td>${adsPct(r.answered, r.leads)}</td><td>${adsMinutes(r.median)}</td><td>${r.qualified}</td><td>${r.won}</td><td>${dealMoney(r.revenue)}</td><td>${adsPct(r.won, r.leads-r.junk)}</td></tr>`).join('')
          ||'<tr><td colspan="9" style="color:var(--muted)">No ad leads in this period.</td></tr>'}</tbody>
      </table></div>
      <div class="s-note" style="margin-top:6px">Conversion leaves junk out. A campaign with poor sales but slow or no calls is a follow-up problem, not an ad problem.</div>
    </div>

    ${adsCapiCard(cache.capi)}
    ${adsSettingsCard(cache.settings)}`;
  // Phones show each row as a card labelled from data-label (dashboard.html .leads-tbl rules).
  el.querySelectorAll('table.leads-tbl').forEach(t=>{
    const heads=[...t.querySelectorAll('thead th')].map(th=>th.textContent.trim());
    t.querySelectorAll('tbody tr, tfoot tr').forEach(tr=>[...tr.children].forEach((td,i)=>{ if(heads[i]&&td.colSpan===1) td.dataset.label=heads[i]; }));
  });
}

function adsCapiCard(capi){
  const rows=capi?.rows||[];
  const EV={lead:'Lead', qualified:'Qualified', disqualified:'Disqualified', booked:'Booked', purchase:'Purchase'};
  const KEY={ctwa_clid:'WhatsApp ad click', lead_id:'Lead form id', hashed:'Phone/email only', '':'Not recorded'};
  const events=Object.keys(EV).map(e=>({e, by:Object.fromEntries(Object.keys(KEY).map(k=>[k, rows.filter(r=>r.event===e&&(r.match_key||'')===k).reduce((s,r)=>s+r.n,0)]))}));
  const total=rows.reduce((s,r)=>s+r.n,0);
  const strong=rows.filter(r=>r.match_key==='ctwa_clid'||r.match_key==='lead_id').reduce((s,r)=>s+r.n,0);
  return `<div class="card" style="margin-bottom:14px" id="adsCapi">
    <div class="s-head" style="margin-bottom:4px">📤 Results sent to Meta (last 30 days)</div>
    <div class="s-note" style="margin-bottom:8px">${capi?.pixel_connected?`Lead, Qualified, Booked and Purchase (with value) go back to Meta through the Conversions API so ads are optimised for buyers, not form-fillers. ${total?`${adsPct(strong, total)} matched by the ad click itself (strongest).`:''}`:'Not connected — add your Pixel/Dataset ID and Conversions API token in <a href="#" onclick="navigate(\'integrations\');return false">Settings → Integrations → Meta Ads</a>.'}</div>
    <div style="overflow-x:auto"><table class="leads-tbl" style="width:100%;min-width:600px">
      <thead><tr><th>Event</th>${Object.values(KEY).map(k=>`<th>${k}</th>`).join('')}<th>Total</th></tr></thead>
      <tbody>${events.map(({e, by})=>`<tr><td>${EV[e]}</td>${Object.keys(KEY).map(k=>`<td>${by[k]||0}</td>`).join('')}<td>${Object.values(by).reduce((a,b)=>a+b,0)}</td></tr>`).join('')}</tbody>
    </table></div></div>`;
}

function adsSettingsCard(s){
  if(!s||s.error) return '';
  const cfg=s.config||{};
  const can=!!s.can_edit;
  const dis=can?'':' disabled';
  const wa=new Set((s.whatsapp_users||[]).map(e=>e.toLowerCase()));
  const members=getTeamMembers();
  const sendRow=x=>`<div class="s-note">${esc(String(x.created_at||'').slice(0,16).replace('T',' '))} · ${esc(x.kind)} · ${esc(x.recipient||'—')} · <b style="color:${x.status==='sent'?'var(--green,#16a34a)':'var(--red)'}">${esc(x.status)}</b>${x.status!=='sent'&&x.detail?' — '+esc(x.detail):''}</div>`;
  return `<div class="card" style="margin-bottom:20px" id="adsSettings">
    <div class="s-head" style="margin-bottom:4px">🔔 Daily summary, alerts &amp; accounting</div>
    <div class="s-note" style="margin-bottom:12px">Every morning after the spend sync: yesterday's spend, ad leads, qualified, junk and sales on WhatsApp and email.${can?'':' Only the account owner can change these.'}</div>

    <label style="display:flex;gap:8px;align-items:center;font-weight:600"><input type="checkbox" id="adsSumOn"${cfg.summary_enabled?' checked':''}${dis}> Send the daily summary</label>
    <div style="margin:8px 0 4px 24px">
      <div class="s-note">WhatsApp to (numbers from User Management):</div>
      <div id="adsSumStaff" style="display:flex;flex-wrap:wrap;gap:10px;margin:4px 0 8px">${members.map(m=>{ const has=wa.has(m.email.toLowerCase()); return `<label style="font-size:13px;display:flex;gap:4px;align-items:center${has?'':';color:var(--muted)'}" title="${has?'':'No WhatsApp number on file — add it in Settings → User Management'}"><input type="checkbox" value="${esc(m.email.toLowerCase())}"${(cfg.summary_staff||[]).includes(m.email.toLowerCase())?' checked':''}${has&&can?'':' disabled'}> ${esc(m.name)}</label>`; }).join('')}</div>
      <label class="form-label">Email to (comma separated)</label>
      <input class="form-input" id="adsSumEmails" style="max-width:420px" value="${esc((cfg.summary_emails||[]).join(', '))}" placeholder="owner@business.com"${dis}>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
        <div><label class="form-label">WhatsApp template (optional)</label><input class="form-input" id="adsSumTpl" style="max-width:240px" value="${esc(cfg.summary_template||'')}" placeholder="ads_daily_summary"${dis}></div>
        <div><label class="form-label">Language</label><input class="form-input" id="adsSumLang" style="max-width:80px" value="${esc(cfg.summary_template_lang||'en')}"${dis}></div>
      </div>
      <div class="s-note">Without a template, WhatsApp only delivers to staff who messaged your business number in the last 24 hours. An approved Utility template with 3 body variables ({{1}} business, {{2}} date, {{3}} summary) always delivers.${s.whatsapp_connected?'':' <b>WhatsApp Business API isn\'t connected</b> — email only.'}</div>
    </div>

    <label style="display:flex;gap:8px;align-items:center;font-weight:600;margin-top:12px"><input type="checkbox" id="adsAlertOn"${cfg.alerts_enabled?' checked':''}${dis}> Alerts (sent even when the summary is off)</label>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin:8px 0 0 24px">
      <div><label class="form-label">Campaign spent at least … with no leads</label><input class="form-input" type="number" min="0" id="adsAlertSpend" style="max-width:160px" value="${cfg.alert_spend_no_leads||''}" placeholder="e.g. 500"${dis}></div>
      <div><label class="form-label">Cost per lead above</label><input class="form-input" type="number" min="0" id="adsAlertCpl" style="max-width:160px" value="${cfg.alert_cpl_max||''}" placeholder="e.g. 300"${dis}></div>
      <div><label class="form-label">Junk leads above (%, last 7 days)</label><input class="form-input" type="number" min="0" max="100" id="adsAlertJunk" style="max-width:160px" value="${cfg.alert_junk_pct||''}" placeholder="e.g. 30"${dis}></div>
    </div>
    <div class="s-note" style="margin-left:24px">Amounts are in the ad account's currency${s.currency?' ('+esc(s.currency)+')':''}. A failing Meta connection is always flagged when alerts are on.</div>

    <label style="display:flex;gap:8px;align-items:center;font-weight:600;margin-top:12px"><input type="checkbox" id="adsAcctOn"${cfg.accounting_post?' checked':''}${can&&s.accounting_enabled?'':' disabled'}> Book Meta spend in Accounting</label>
    <div class="s-note" style="margin-left:24px">${s.accounting_enabled?'One expense per month ("Meta Platforms", Advertising &amp; Marketing), updated daily until the month ends, so the P&amp;L shows profit after ads. Deleting it in Accounting stops it for that month. Add GST from the Meta invoice in Accounting if you claim it.':'The Accounting module isn\'t on for this account.'}</div>
    ${(s.expense_posts||[]).length?`<div id="adsExpensePosts" style="margin:6px 0 0 24px">${s.expense_posts.map(p=>`<div class="s-note">${esc(p.month)} · ${adsMoneyFmt(p.currency)(p.amount)} · ${p.status==='deleted'?'deleted in Accounting — not re-posted':'posted'}</div>`).join('')}</div>`:''}

    ${can?`<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:14px">
      <button class="save-btn" id="adsSettingsSave" onclick="adsSaveSettings()">Save</button>
      <button class="btn btn-secondary btn-sm" id="adsTestBtn" onclick="adsSendTest()">📨 Send yesterday's summary now</button>
      <span class="save-msg" id="adsSettingsMsg"></span>
    </div>`:''}
    ${(s.sends||[]).length?`<details style="margin-top:12px"><summary class="s-note" style="cursor:pointer">Recent messages</summary>${s.sends.map(sendRow).join('')}</details>`:''}
  </div>`;
}

function adsSetLevel(level){ _adsLevel=level; renderReportsAds(); }
async function adsSyncNow(){
  const btn=$id('adsSyncBtn'); if(btn){ btn.disabled=true; btn.textContent='Syncing…'; }
  try{
    const r=await fetch(`${CONFIG.WORKER_BASE}/meta/ads-report/sync`, {method:'POST', headers:ncAuthHeaders()});
    const d=await r.json().catch(()=>({}));
    if(!r.ok) showToast(d.error||'Sync failed', 'err'); else showToast(`✓ Synced ${d.rows} ad-day rows (${d.since} → ${d.until})`);
  }catch(e){ showToast('Sync failed: '+e.message, 'err'); }
  _adsCache.at=0;
  renderReportsAds(true);
}
function adsReadSettingsForm(){
  return {
    summary_enabled:$id('adsSumOn').checked,
    summary_staff:[...document.querySelectorAll('#adsSumStaff input:checked')].map(i=>i.value),
    summary_emails:$id('adsSumEmails').value,
    summary_template:$id('adsSumTpl').value.trim(), summary_template_lang:$id('adsSumLang').value.trim()||'en',
    alerts_enabled:$id('adsAlertOn').checked,
    alert_spend_no_leads:Number($id('adsAlertSpend').value)||0, alert_cpl_max:Number($id('adsAlertCpl').value)||0, alert_junk_pct:Number($id('adsAlertJunk').value)||0,
    accounting_post:$id('adsAcctOn').checked,
  };
}
async function adsSaveSettings(){
  const btn=$id('adsSettingsSave'), msg=$id('adsSettingsMsg');
  btn.disabled=true; msg.textContent=''; msg.className='save-msg';
  try{
    const r=await fetch(`${CONFIG.WORKER_BASE}/meta/ads-report/settings`, {method:'POST', headers:ncAuthHeaders({'Content-Type':'application/json'}), body:JSON.stringify({config:adsReadSettingsForm()})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(d.error||'HTTP '+r.status);
    if(_adsCache.settings) _adsCache.settings.config=d.config;
    msg.textContent='✓ Saved';
    if(d.config.accounting_post) fetch(`${CONFIG.WORKER_BASE}/meta/ads-report/accounting/post`, {method:'POST', headers:ncAuthHeaders()}).catch(()=>{});
  }catch(e){ msg.textContent='Error: '+e.message; msg.className='save-msg err'; }
  finally{ btn.disabled=false; }
}
async function adsSendTest(){
  const btn=$id('adsTestBtn'), msg=$id('adsSettingsMsg');
  btn.disabled=true; msg.textContent='Sending…'; msg.className='save-msg';
  try{
    const r=await fetch(`${CONFIG.WORKER_BASE}/meta/ads-report/test-summary`, {method:'POST', headers:ncAuthHeaders()});
    const d=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(d.error||'HTTP '+r.status);
    const ok=(d.results||[]).filter(x=>x.ok).length, bad=(d.results||[]).filter(x=>!x.ok);
    msg.textContent=d.results?.length?`✓ Sent to ${ok} of ${d.results.length}${bad.length?' — '+bad.map(x=>`${x.to}: ${x.detail}`).join('; '):''}`:'Nothing sent — pick at least one WhatsApp or email recipient and Save first.';
    if(bad.length) msg.className='save-msg err';
  }catch(e){ msg.textContent='Error: '+e.message; msg.className='save-msg err'; }
  finally{ btn.disabled=false; }
}
