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
   Leads with no ad id are matched by an ad code in their first message ("#K26", also in the ad's
   name), by their first message against the ad's headline, then shared by time window across the
   click-to-WhatsApp ads running in the hour they arrived (adsAttribute) — every number says how
   much is estimated, and the leads behind it open with how each was matched. Also: ads running in
   the period (status, first/last day, timeline), what changed, day by day, creative leaderboard
   with fatigue, an hour × weekday heatmap and ▲/▼ against the previous period.
   Sales are the leads that arrived in the period and are won now (a cohort), so a campaign gets
   credit for sales that close later. Uses dashboard.html globals: $id, esc, allLeads, clientRecord,
   _rptFilters, rptByCategory, _rptOlder, rptLoadOlderLeads, _reportsPage, isWonLead, isLostLead,
   parseCallLog, csConnected, getTeamMembers, sameEmail, isAccountOwner, openDetail, navigate,
   showToast, ncAuthHeaders, CONFIG.
   Bump the ?v= on its <script> tag in dashboard.html when changing this file — sw.js serves
   scripts cache-first. ── */

const ADS_LEVELS=[['campaign','Campaign'],['adset','Ad set'],['ad','Ad']];
const ADS_METHODS={exact:'Exact', code:'Ad code', message:'Message match', estimated:'Time-window share', unmatched:'Not matched'};
let _adsLevel='campaign';
let _adsInclEst=true;           // count time-window estimates in the tables (toggle)
let _adsCache={key:'', at:0, data:null, prev:null, capi:null, settings:null, firstMsgs:{}};
let _adsLeadLists={};           // row key → [{l, w, method}] behind each number (adsShowLeads)

// Mirrors marAdCode / marLeadAdRef / marMatchLead in cloudflare-worker/meta-ads-report.js — keep them in step.
function adsAdCode(text){
  const m=String(text||'').match(/(?:^|[^\w#])#([a-z0-9]{2,12})(?![\w])/i);
  return m && /[a-z]/i.test(m[1]) ? m[1].toLowerCase() : '';
}
function adsLeadAdRef(l){
  const camp=String(l?.AdCampaign||'').trim();
  const legacyId=(camp.match(/^Ad ID (\d{5,25})$/)||[])[1]||'';
  const adId=String(l?.AdId||'').trim()||legacyId;
  const campaignId=String(l?.CampaignId||'').trim();
  const adCode=String(l?.AdCode||'').trim().toLowerCase().replace(/^#/,'');
  const src=`${l?.LeadSource||''} ${l?.Source||''}`;
  const isAd=!!(adId||campaignId||adCode||String(l?.CtwaClid||'').trim()||String(l?.MetaLeadgenId||'').trim()
    ||/lead ad|lead form|click-to-whatsapp|\b(meta|facebook|instagram|fb|ig) ads?\b/i.test(src));
  return {isAd, adId, campaignId, adCode, campaignName:legacyId?'':camp, adName:String(l?.AdName||'').trim()};
}
function adsIndex(ads){
  const byAd=new Map(), byCampaign=new Map(), byCampaignName=new Map(), byAdset=new Map(), byCode=new Map();
  for(const a of ads||[]){
    if(a.ad_id) byAd.set(String(a.ad_id), a);
    if(a.adset_id && !byAdset.has(String(a.adset_id))) byAdset.set(String(a.adset_id), a);
    if(a.campaign_id){
      if(!byCampaign.has(String(a.campaign_id))) byCampaign.set(String(a.campaign_id), a);
      const n=String(a.campaign_name||'').trim().toLowerCase(); if(n && !byCampaignName.has(n)) byCampaignName.set(n, String(a.campaign_id));
    }
    for(const code of new Set([a.ad_name, a.adset_name, a.campaign_name].map(adsAdCode).filter(Boolean))){
      if(!byCode.has(code)) byCode.set(code, []);
      byCode.get(code).push(a);
    }
  }
  return {byAd, byCampaign, byCampaignName, byAdset, byCode};
}
// One ad's ids as a match; several ads sharing a code → the campaign/ad set they share.
function adsMatchOf(list){
  if(!list?.length) return null;
  const one=k=>new Set(list.map(a=>String(a[k]||''))).size===1;
  return {campaign_id:one('campaign_id')?String(list[0].campaign_id||''):'', adset_id:one('adset_id')?String(list[0].adset_id||''):'', ad_id:list.length===1?String(list[0].ad_id):''};
}
// → null (not an ad lead) | {campaign_id, adset_id, ad_id, method} — ids '' when it can't be matched.
function adsMatchLead(l, idx){
  const ref=adsLeadAdRef(l);
  if(!ref.isAd) return null;
  const ad=ref.adId&&idx.byAd.get(ref.adId);
  if(ad) return {campaign_id:String(ad.campaign_id||''), adset_id:String(ad.adset_id||''), ad_id:String(ad.ad_id), method:'exact'};
  if(ref.campaignId && idx.byCampaign.has(ref.campaignId)) return {campaign_id:ref.campaignId, adset_id:'', ad_id:'', method:'exact'};
  const coded=ref.adCode && adsMatchOf(idx.byCode.get(ref.adCode));
  if(coded) return {...coded, method:'code'};
  const byName=ref.campaignName && idx.byCampaignName.get(ref.campaignName.toLowerCase());
  if(byName) return {campaign_id:byName, adset_id:'', ad_id:'', method:'exact'};
  return {campaign_id:'', adset_id:'', ad_id:'', method:'unmatched'};
}
// Words that say nothing about which ad it was.
const ADS_STOP=new Set('the and for you your with this that from have has can get more info information about please hi hello hey want need know details price offer what how are our its it\'s'.split(' '));
function adsWords(s){ return new Set(String(s||'').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu,' ').split(/\s+/).filter(w=>w.length>=3&&!ADS_STOP.has(w))); }
// A lead's first message against the creative text of ads that were live that day: the headline (or
// the ad's own name) mostly present in the message. Ties share the lead; a weak or unclear best is no match.
function adsMessageMatch(text, candidates){
  const said=adsWords(text);
  if(said.size<2) return null;
  const scored=[];
  for(const a of candidates){
    const head=adsWords(a.headline||a.ad_name);
    if(head.size<2) continue;
    let hit=0; for(const w of head) if(said.has(w)) hit++;
    const body=adsWords(a.body); let bodyHit=0; for(const w of body) if(said.has(w)) bodyHit++;
    const score=hit/head.size+(body.size?0.2*bodyHit/body.size:0);
    if(hit>=2 && score>=0.6) scored.push({a, score});
  }
  if(!scored.length) return null;
  scored.sort((x,y)=>y.score-x.score);
  const top=scored.filter(x=>x.score>=scored[0].score-0.05);
  return top.length<=3?top.map(x=>x.a):null;
}
function adsTs(v){ if(!v) return NaN; const s=String(v).trim(); return Date.parse(/^\d{4}-\d{2}-\d{2} \d/.test(s)?s.replace(' ','T'):s); }
// When the lead arrived — NocoDB's CreatedAt first: the bot rewrites Date on every message turn.
function adsArrivedMs(l){ const c=adsTs(l?.CreatedAt); return Number.isFinite(c)?c:adsTs(l?.Date); }
function adsLocalDay(ms){ const d=new Date(ms); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function adsAddDays(day, n){ const d=new Date(day+'T12:00:00'); d.setDate(d.getDate()+n); return adsLocalDay(d.getTime()); }
function adsDaysBetween(a, b){ return Math.round((Date.parse(b+'T12:00:00')-Date.parse(a+'T12:00:00'))/86400000); }
// Day and hour in the ad account's timezone — Meta's own day/hour buckets.
function adsAcctDayHour(ms, tzMin){ const d=new Date(ms+tzMin*60000); return {day:d.toISOString().slice(0,10), hour:d.getUTCHours()}; }
function adsIsJunk(l){ return l.HandoverOutcome==='Spam'; }
// A chat that may have come from a click-to-WhatsApp ad: not added by hand, imported or from a form,
// and no source other than the chat channel itself.
function adsIsChatLead(l){
  const via=String(l.CreatedVia||'').toLowerCase();
  if(via && via!=='chatwoot' && via!=='unknown') return false;
  if(String(l.MetaLeadgenId||'').trim()) return false;
  const src=String(l.LeadSource||l.Source||'').trim();
  return !src || /^(whatsapp|instagram|facebook|messenger|click-to-whatsapp)/i.test(src);
}
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
// The same number of days just before — for "vs previous period".
function adsPrevRange(r){ const n=adsDaysBetween(r.from, r.to)+1; return {from:adsAddDays(r.from, -n), to:adsAddDays(r.from, -1)}; }

async function adsFetch(range, force){
  const key=range.from+'|'+range.to;
  if(!force && _adsCache.key===key && Date.now()-_adsCache.at<60000) return _adsCache;
  const get=p=>fetch(`${CONFIG.WORKER_BASE}/meta/ads-report/${p}`, {headers:ncAuthHeaders()}).then(r=>r.json()).catch(()=>null);
  const prev=adsPrevRange(range);
  const [data, prevData, capi, settings, fm, health]=await Promise.all([get(`data?from=${range.from}&to=${range.to}`), get(`data?from=${prev.from}&to=${prev.to}`),
    get('capi?days=30'), get('settings'), get(`first-messages?from=${range.from}&to=${range.to}`), get('health?days=7')]);
  // Each rule looks at its own last N days, whatever period the report shows.
  const windows={};
  const today=adsLocalDay(Date.now());
  const days=[...new Set((settings?.config?.rules||[]).filter(r=>r.enabled).map(r=>r.days))];
  if(settings?.config?.capacity_guard?.enabled) days.push(7);
  await Promise.all([...new Set(days)].map(async n=>{
    const r={from:adsAddDays(today, -(n-1)), to:today};
    windows[n]={range:r, data:await get(`data?from=${r.from}&to=${r.to}`)};
  }));
  _adsCache={key, at:Date.now(), data, prev:prevData, capi, settings, firstMsgs:fm?.messages||{}, health, windows};
  return _adsCache;
}

function adsMoneyFmt(ccy){
  const c=String(ccy||'').toUpperCase();
  return n=>n==null||!Number.isFinite(n)?'—':(c==='INR'?'₹':c==='USD'?'$':c?c+' ':'')+Math.round(n).toLocaleString();
}
const adsPct=(n,d)=>d?Math.round(n/d*100)+'%':'—';
// Counts can be fractional once a lead is shared between ads by time window.
function adsN(n){ const r=Math.round(n*10)/10; return Number.isInteger(r)?String(r):r.toFixed(1); }

/* ── Attribution: every lead in the period → [{ad, weight}] by the strongest method available ──
   exact (ad / campaign id, lead form, campaign name), ad code, message match, then a time-window
   share: chat leads with no ad id are split across the click-to-WhatsApp ads that were running in
   the hour they arrived (Meta's hourly counts; the day when the hour has none), in proportion to
   each ad's conversations, and never more leads than Meta counted conversations — beyond that a
   plain "WhatsApp" chat is treated as organic. A lead that says it came from an ad always counts. */
function adsAttribute(data, leads, firstMsgs){
  const ads=data.ads||[];
  const idx=adsIndex(ads);
  const tz=Number(data.tz_offset_min)||0;
  const activeByDay=new Map();
  for(const d of data.ad_days||[]){ if(!activeByDay.has(d.day)) activeByDay.set(d.day, []); activeByDay.get(d.day).push(d); }
  const hourRows=new Map(), hourDays=new Set();
  for(const h of data.hours||[]){ const k=h.day+'|'+h.hour; if(!hourRows.has(k)) hourRows.set(k, []); hourRows.get(k).push(h); hourDays.add(h.day); }
  const out=[]; // {l, ms, method, parts:[{m, w}]}
  const pending=[];
  for(const {l, ms} of leads){
    const m=adsMatchLead(l, idx);
    if(m && m.method!=='unmatched'){ out.push({l, ms, method:m.method, parts:[{m, w:1}]}); continue; }
    const msg=firstMsgs[l.Id];
    const code=adsAdCode(msg);
    const coded=code && adsMatchOf(idx.byCode.get(code));
    if(coded){ out.push({l, ms, method:'code', parts:[{m:coded, w:1}]}); continue; }
    const {day}=adsAcctDayHour(ms, tz);
    const live=(activeByDay.get(day)||[]).map(d=>idx.byAd.get(d.ad_id)).filter(Boolean);
    const hits=msg && adsMessageMatch(msg, live);
    if(hits){ out.push({l, ms, method:'message', parts:hits.map(a=>({m:{campaign_id:String(a.campaign_id||''), adset_id:String(a.adset_id||''), ad_id:String(a.ad_id)}, w:1/hits.length}))}); continue; }
    if(adsIsChatLead(l) || (m && m.method==='unmatched' && !String(l.MetaLeadgenId||'').trim())) pending.push({l, ms, certain:!!m});
    else if(m) out.push({l, ms, method:'unmatched', parts:[{m, w:1}]});
  }
  // Buckets: account-timezone hour when Meta's hourly counts cover that day, else the day.
  const buckets=new Map();
  for(const p of pending){
    const {day, hour}=adsAcctDayHour(p.ms, tz);
    let key=hourDays.has(day)?day+'|'+hour:day+'|d';
    let rows=hourDays.has(day)?(hourRows.get(key)||[]):(activeByDay.get(day)||[]);
    if(!rows.some(r=>r.meta_chats>0)){ key=day+'|d'; rows=activeByDay.get(day)||[]; }
    if(!buckets.has(key)) buckets.set(key, {rows, leads:[], matched:0});
    buckets.get(key).leads.push(p);
  }
  // Chat leads already matched to an ad use up some of that bucket's conversations.
  for(const o of out){
    if(!adsIsChatLead(o.l)) continue;
    const {day, hour}=adsAcctDayHour(o.ms, tz);
    const b=buckets.get(day+'|'+hour)||buckets.get(day+'|d'); if(b) b.matched++;
  }
  for(const b of buckets.values()){
    const chats=b.rows.filter(r=>r.meta_chats>0);
    const n=chats.reduce((s,r)=>s+r.meta_chats,0);
    const certain=b.leads.filter(p=>p.certain), maybe=b.leads.filter(p=>!p.certain);
    const room=Math.max(0, n-b.matched-certain.length);
    const wMaybe=maybe.length?Math.min(1, room/maybe.length):0;
    for(const p of b.leads){
      const w=p.certain?1:wMaybe;
      if(!n || !w){ if(p.certain) out.push({l:p.l, ms:p.ms, method:'unmatched', parts:[{m:{campaign_id:'', adset_id:'', ad_id:''}, w:1}]}); continue; }
      out.push({l:p.l, ms:p.ms, method:'estimated', parts:chats.map(r=>{ const a=idx.byAd.get(r.ad_id)||{};
        return {m:{campaign_id:String(a.campaign_id||''), adset_id:String(a.adset_id||''), ad_id:String(r.ad_id)}, w:w*r.meta_chats/n}; })});
    }
  }
  return {list:out, idx};
}

function adsPool(range){
  const loaded=new Set(allLeads.map(l=>l.Id));
  let pool=allLeads.concat((_rptOlder?.list||[]).filter(l=>!loaded.has(l.Id)));
  pool=rptByCategory(pool);
  const member=$id('rptMember')?.value||'';
  const out=[];
  for(const l of pool){
    const ms=adsArrivedMs(l); if(!Number.isFinite(ms)) continue;
    const day=adsLocalDay(ms); if(day<range.from||day>range.to) continue;
    if(member && !sameEmail(l.Owner, member)) continue;
    out.push({l, ms});
  }
  return out;
}

// One row of metrics, from the spend rows and the (weighted) CRM leads that belong to it.
function adsBlank(key, name, sub){ return {key, name, sub:sub||'', spend:0, impressions:0, clicks:0, metaLeads:0, leads:0, exact:0, est:0, hot:0, warm:0, cold:0, qualified:0, junk:0, unreachable:0, lost:0, won:0, revenue:0}; }
function adsAddLead(r, l, w, method){
  r.leads+=w; if(method==='estimated') r.est+=w; else r.exact+=w;
  const won=isWonLead(l);
  if(l.Score==='Hot') r.hot+=w; else if(l.Score==='Cold') r.cold+=w; else r.warm+=w;
  if(l.Score==='Hot'||won) r.qualified+=w;
  if(adsIsJunk(l)) r.junk+=w;
  else if(isLostLead(l)) r.lost+=w;
  let calls=[]; try{ calls=parseCallLog(l.CallLog); }catch(e){}
  if(calls.length && !calls.some(csConnected)) r.unreachable+=w;
  if(won){ r.won+=w; r.revenue+=w*(Number(l.DealValue)||0); }
}
const ADS_SUM_KEYS=['spend','impressions','clicks','metaLeads','leads','exact','est','hot','warm','cold','qualified','junk','unreachable','lost','won','revenue'];

function adsCompute(data, range, firstMsgs, level=_adsLevel, inclEst=_adsInclEst){
  const {list:attributed, idx}=adsAttribute(data, adsPool(range), firstMsgs||{});
  const levelKey={campaign:a=>a.campaign_id, adset:a=>a.adset_id, ad:a=>a.ad_id};
  const rows=new Map(), lists={};
  const rowFor=(key, a)=>{
    if(rows.has(key)) return rows.get(key);
    let r;
    if(!key) r=adsBlank('', 'Ad leads not matched to a campaign', 'They say they came from an ad, but carry no ad id or code, and no ad ran when they arrived');
    else if(level==='campaign') r=adsBlank(key, a?.campaign_name||'Campaign '+key);
    else if(level==='adset') r=key.startsWith('c:')?adsBlank(key, idx.byCampaign.get(key.slice(2))?.campaign_name||'Campaign', 'Ad set not known (campaign-level match)'):adsBlank(key, a?.adset_name||'Ad set '+key, a?.campaign_name||'');
    else r=key.startsWith('c:')?adsBlank(key, idx.byCampaign.get(key.slice(2))?.campaign_name||'Campaign', 'Ad not known (campaign-level match)'):adsBlank(key, a?.ad_name||'Ad '+key, [a?.campaign_name, a?.adset_name].filter(Boolean).join(' › '));
    rows.set(key, r); return r;
  };
  for(const a of data.ads||[]){
    if(!(a.spend>0||a.meta_leads>0||a.meta_chats>0)) continue;
    const r=rowFor(String(levelKey[level](a)||''), a);
    r.spend+=Number(a.spend)||0; r.impressions+=Number(a.impressions)||0; r.clicks+=Number(a.clicks)||0;
    r.metaLeads+=(Number(a.meta_leads)||0)+(Number(a.meta_chats)||0);
  }
  const used=[];
  for(const o of attributed){
    if(o.method==='estimated' && !inclEst) continue;
    let total=0;
    for(const {m, w} of o.parts){
      let key=level==='campaign'?m.campaign_id:m[level+'_id'];
      if(!key && m.campaign_id && level!=='campaign') key='c:'+m.campaign_id;
      const a=level==='campaign'?idx.byCampaign.get(m.campaign_id):level==='adset'?idx.byAdset.get(m.adset_id):idx.byAd.get(m.ad_id);
      adsAddLead(rowFor(key||'', a), o.l, w, o.method);
      (lists[key||'']=lists[key||'']||[]).push({l:o.l, w, method:o.method, ms:o.ms});
      total+=w;
    }
    if(total>0) used.push({l:o.l, ms:o.ms, w:total, method:o.method});
  }
  const list=[...rows.values()].sort((a,b)=>(!a.key)-(!b.key)||b.spend-a.spend||b.leads-a.leads);
  const tot=adsBlank('total', 'Total');
  for(const r of list) for(const k of ADS_SUM_KEYS) tot[k]+=r[k];
  const coverage={exact:0, code:0, message:0, estimated:0, unmatched:0};
  for(const o of attributed) coverage[o.method]+=o.parts.reduce((s,p)=>s+p.w,0);
  return {rows:list, total:tot, adLeads:used, idx, lists, coverage, attributed};
}

function adsSpeedStats(adLeads){
  let w5=0, w60=0, w1440=0, never=0, n=0; const mins=[]; const notCalled=[];
  for(const {l, ms, w} of adLeads){
    if(adsIsJunk(l)) continue;
    n+=w;
    const m=adsFirstCallMin(l, ms);
    if(m==null){ never+=w; if(!isWonLead(l)&&!isLostLead(l)) notCalled.push({l, ms}); continue; }
    mins.push(m); if(m<=5) w5+=w; if(m<=60) w60+=w; if(m<=1440) w1440+=w;
  }
  mins.sort((a,b)=>a-b);
  const median=mins.length?mins[Math.floor((mins.length-1)/2)]:null;
  return {n, w5, w60, w1440, never, median, notCalled:notCalled.sort((a,b)=>a.ms-b.ms)};
}
function adsMinutes(m){ if(m==null) return '—'; if(m<60) return Math.round(m)+' min'; if(m<1440) return (Math.round(m/6)/10)+' h'; return (Math.round(m/144)/10)+' days'; }

function adsStaffRows(adLeads){
  const by=new Map(); const names=new Map(getTeamMembers().map(m=>[m.email.toLowerCase(), m.name]));
  for(const {l, ms, w} of adLeads){
    const k=String(l.Owner||'').trim().toLowerCase();
    if(!by.has(k)) by.set(k, {name:k?(names.get(k)||l.Owner):'Unassigned', leads:0, called:0, answered:0, qualified:0, won:0, revenue:0, mins:[], junk:0});
    const r=by.get(k);
    r.leads+=w;
    if(adsIsJunk(l)) r.junk+=w;
    let calls=[]; try{ calls=parseCallLog(l.CallLog); }catch(e){}
    if(calls.length) r.called+=w;
    if(calls.some(csConnected)) r.answered+=w;
    const won=isWonLead(l);
    if(l.Score==='Hot'||won) r.qualified+=w;
    if(won){ r.won+=w; r.revenue+=w*(Number(l.DealValue)||0); }
    const m=adsFirstCallMin(l, ms); if(m!=null) r.mins.push(m);
  }
  return [...by.values()].map(r=>{ r.mins.sort((a,b)=>a-b); r.median=r.mins.length?r.mins[Math.floor((r.mins.length-1)/2)]:null; return r; }).sort((a,b)=>b.leads-a.leads);
}

/* ── Which ads ran in the period: first/last day with spend, days live, status, and per-ad totals ── */
function adsRunningAds(data, idx, lists){
  const byAd=new Map();
  for(const d of data.ad_days||[]){
    if(!byAd.has(d.ad_id)) byAd.set(d.ad_id, {ad_id:d.ad_id, first:d.day, last:d.day, days:new Map(), spend:0, meta:0});
    const r=byAd.get(d.ad_id);
    if(d.day<r.first) r.first=d.day; if(d.day>r.last) r.last=d.day;
    r.days.set(d.day, d); r.spend+=d.spend; r.meta+=d.meta_leads+d.meta_chats;
  }
  const leadsOf=id=>(lists[id]||[]).reduce((s,x)=>s+x.w,0);
  return [...byAd.values()].map(r=>{
    const a=idx.byAd.get(r.ad_id)||{};
    const ls=lists[r.ad_id]||[];
    const won=ls.filter(x=>isWonLead(x.l)).reduce((s,x)=>s+x.w,0);
    const qualified=ls.filter(x=>x.l.Score==='Hot'||isWonLead(x.l)).reduce((s,x)=>s+x.w,0);
    // Fatigue: Meta's cost per result in the second half of the ad's days vs the first half.
    const ds=[...r.days.values()].sort((x,y)=>x.day.localeCompare(y.day));
    let fatigue=null;
    if(ds.length>=4){
      const h=Math.floor(ds.length/2), cpr=p=>{ const sp=p.reduce((s,d)=>s+d.spend,0), n=p.reduce((s,d)=>s+d.meta_leads+d.meta_chats,0); return n?sp/n:null; };
      const a1=cpr(ds.slice(0,h)), a2=cpr(ds.slice(h));
      if(a1 && a2 && a2>a1*1.4) fatigue=Math.round((a2/a1-1)*100);
    }
    return {...r, name:a.ad_name||'Ad '+r.ad_id, adset:a.adset_name||'', campaign:a.campaign_name||'', status:a.status||'', headline:a.headline||'',
      daysLive:r.days.size, leads:leadsOf(r.ad_id), qualified, won, fatigue};
  }).sort((x,y)=>y.spend-x.spend);
}
function adsStatusChip(s){
  const lab=({ACTIVE:'Active', PAUSED:'Paused', CAMPAIGN_PAUSED:'Campaign paused', ADSET_PAUSED:'Ad set paused', PENDING_REVIEW:'In review', IN_PROCESS:'Processing',
    DISAPPROVED:'Rejected', WITH_ISSUES:'With issues', ARCHIVED:'Archived', DELETED:'Deleted'})[s]||(s?s.toLowerCase():'—');
  const col=s==='ACTIVE'?'var(--green,#16a34a)':s==='DISAPPROVED'||s==='WITH_ISSUES'?'var(--red)':'var(--muted)';
  return `<span style="font-size:11px;font-weight:700;color:${col}">● ${esc(lab)}</span>`;
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
  const {rows, total, adLeads, idx, lists, coverage}=adsCompute(data, range, cache.firstMsgs);
  _adsLeadLists=lists;
  const prevRange=adsPrevRange(range);
  const prev=cache.prev?adsCompute(cache.prev, prevRange, {}, 'campaign').total:null;
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
  // Running ads and the leaderboard are per ad whatever level the main table shows.
  const adLists=_adsLevel==='ad'?lists:adsCompute(data, range, cache.firstMsgs, 'ad').lists;
  const running=adsRunningAds(data, idx, adLists);
  // ▲/▼ vs the previous period; for costs, down is good.
  const delta=(now, before, lowerIsBetter)=>{
    if(prev==null || before==null || !Number.isFinite(before) || !Number.isFinite(now) || !before) return '';
    const pct=Math.round((now/before-1)*100); if(!pct) return '<div class="s-note">= prev. period</div>';
    const good=lowerIsBetter?pct<0:pct>0;
    return `<div class="s-note" style="color:${good?'var(--green,#16a34a)':'var(--red)'}">${pct>0?'▲':'▼'} ${Math.abs(pct)}% vs prev.</div>`;
  };
  const stat=(lbl, val, hint, accent, d)=>`<div class="stat${accent?' accent':''}"${hint?` title="${esc(hint)}"`:''}><div class="stat-lbl">${lbl}</div><div class="stat-val">${val}</div>${d||''}</div>`;
  const per=(a,b)=>a&&b?a/b:null;
  const leadsCell=(r, key)=>{
    const txt=r.est>=0.05&&r.exact>=0.05?`${adsN(r.exact)} + ${adsN(r.est)} est.`:r.est>=0.05?`${adsN(r.est)} est.`:adsN(r.leads);
    return r.leads>0?`<a href="#" onclick="adsShowLeads(${esc(JSON.stringify(key))});return false">${txt}</a>`:txt;
  };
  const covTotal=Object.values(coverage).reduce((a,b)=>a+b,0);
  const levelName=ADS_LEVELS.find(x=>x[0]===_adsLevel)[1];
  const rangeDays=adsDaysBetween(range.from, range.to)+1;
  const dayList=[]; for(let i=0;i<rangeDays;i++) dayList.push(adsAddDays(range.from, i));

  el.innerHTML=`
    <div style="display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap;margin-bottom:14px">
      <div style="flex:1;min-width:240px"><div class="card-title" style="margin-bottom:0">💸 Ads ROI</div>
        <div class="s-note">Meta spend joined with what happened after the click — lead quality, calls, sales and revenue from this CRM. ${range.from} → ${range.to}${range.all?' (All Time = last 90 days of synced spend)':''}, compared with ${prevRange.from} → ${prevRange.to}. Sales = leads from this period that are won now.</div></div>
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
      ${stat('Spend', spendOf(total.spend), '', false, connected?delta(total.spend, prev?.spend):'')}
      ${stat('Meta counted', connected?total.metaLeads:'—', 'Leads + WhatsApp conversations as Meta counts them', false, connected?delta(total.metaLeads, prev?.metaLeads):'')}
      ${stat('Ad leads in CRM', adsN(total.leads), _adsInclEst?'Includes time-window estimates':'Exact matches only', false, delta(total.leads, prev?.leads))}
      ${stat('Qualified', adsN(total.qualified), 'Hot or won', false, delta(total.qualified, prev?.qualified))}
      ${stat('Junk', adsN(total.junk), 'Marked Spam', false, delta(total.junk, prev?.junk, true))}
      ${stat('Sales', adsN(total.won), '', false, delta(total.won, prev?.won))}
      ${stat('Revenue', dealMoney(total.revenue), '', false, delta(total.revenue, prev?.revenue))}
      ${stat('ROAS', roas(total), 'Revenue ÷ spend', true)}
      ${stat('Cost / lead', ratio(total.spend, total.leads), '', false, connected?delta(per(total.spend, total.leads), per(prev?.spend, prev?.leads), true):'')}
      ${stat('Cost / qualified', ratio(total.spend, total.qualified), '', false, connected?delta(per(total.spend, total.qualified), per(prev?.spend, prev?.qualified), true):'')}
      ${stat('Cost / sale', ratio(total.spend, total.won), '', false, connected?delta(per(total.spend, total.won), per(prev?.spend, prev?.won), true):'')}
    </div>

    <div class="card" style="margin-bottom:14px" id="adsCoverage">
      <div class="s-head" style="margin-bottom:4px">🎯 How leads were matched to ads</div>
      <div class="s-note" style="margin-bottom:8px">Strongest first. Time-window shares split a chat with no ad id across the click-to-WhatsApp ads running in the hour it arrived, in proportion to Meta's conversations — an estimate, never more than Meta counted. ${data.hourly_from?`Hourly data from ${esc(data.hourly_from)}; older days are shared by day.`:'No hourly data yet — shared by day until the next sync.'}</div>
      <div style="display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(120px,1fr))">
        ${Object.entries(ADS_METHODS).map(([k,lab])=>stat(lab, adsN(coverage[k]), '', false, `<div class="s-note">${adsPct(coverage[k], covTotal)}</div>`)).join('')}
      </div>
      ${connected&&total.metaLeads&&covTotal<total.metaLeads*0.5?`<div class="s-note" style="margin-top:8px">Meta counted ${total.metaLeads} but only ${adsN(covTotal)} leads could be tied to an ad. Put a short code like <b>#K26</b> in each click-to-WhatsApp ad's pre-filled message and the same code in the ad's name in Ads Manager — every chat from it is then matched exactly. Lead forms: connect them in Integrations → Lead Forms.</div>`:''}
      <label style="display:flex;gap:6px;align-items:center;margin-top:8px;font-size:13px"><input type="checkbox" id="adsInclEst"${_adsInclEst?' checked':''} onchange="adsSetInclEst(this.checked)"> Count time-window estimates in the tables</label>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <div class="s-head" style="margin:0;flex:1">Spend vs sales</div>
        <div style="display:flex;gap:3px" id="adsLevelBtns">${ADS_LEVELS.map(([k,l])=>`<button class="rpt-period${_adsLevel===k?' active':''}" data-level="${k}" onclick="adsSetLevel('${k}')">${l}</button>`).join('')}</div>
      </div>
      <div style="overflow-x:auto"><table class="leads-tbl" id="adsTable" style="width:100%;min-width:980px">
        <thead><tr><th>${levelName}</th><th>Spend</th><th>Meta counted</th><th>CRM leads</th><th>Qualified</th><th>Sales</th><th>Revenue</th><th>Cost/lead</th><th>Cost/qualified</th><th>Cost/sale</th><th>ROAS</th></tr></thead>
        <tbody>${rows.length?rows.map(r=>`<tr${r.key?'':' style="color:var(--muted)"'}>
          <td style="white-space:normal;max-width:none;overflow:visible;min-width:200px"><div>${esc(r.name)}</div>${r.sub?`<div class="s-note">${esc(r.sub)}</div>`:''}</td>
          <td>${spendOf(r.spend)}</td><td>${connected?r.metaLeads:'—'}</td><td>${leadsCell(r, r.key)}</td><td>${adsN(r.qualified)}</td><td>${adsN(r.won)}</td><td>${dealMoney(r.revenue)}</td>
          <td>${ratio(r.spend, r.leads)}</td><td>${ratio(r.spend, r.qualified)}</td><td>${ratio(r.spend, r.won)}</td><td>${roas(r)}</td></tr>`).join('')
          :'<tr><td colspan="11" style="color:var(--muted)">No ad spend or ad leads in this period.</td></tr>'}</tbody>
        ${rows.length?`<tfoot><tr style="font-weight:700"><td>Total</td><td>${spendOf(total.spend)}</td><td>${connected?total.metaLeads:'—'}</td><td>${adsN(total.leads)}</td><td>${adsN(total.qualified)}</td><td>${adsN(total.won)}</td><td>${dealMoney(total.revenue)}</td><td>${ratio(total.spend, total.leads)}</td><td>${ratio(total.spend, total.qualified)}</td><td>${ratio(total.spend, total.won)}</td><td>${roas(total)}</td></tr></tfoot>`:''}
      </table></div>
      <div class="s-note" style="margin-top:6px">Tap a CRM leads number to see the leads behind it and how each was matched.</div>
    </div>

    ${adsActionsCard(cache, adLeads, money)}
    ${adsRunningCard(running, dayList, money, connected, data)}
    ${adsDaysCard(data, adLeads, dayList, money, connected)}
    ${adsLeaderboardCard(running, money, connected)}
    ${adsHeatmapCard(adLeads)}

    <div class="card" style="margin-bottom:14px">
      <div class="s-head" style="margin-bottom:8px">Lead quality by ${levelName.toLowerCase()}</div>
      <div style="overflow-x:auto"><table class="leads-tbl" id="adsQuality" style="width:100%;min-width:760px">
        <thead><tr><th>${levelName}</th><th>Leads</th><th>🔥 Hot</th><th>Warm</th><th>❄️ Cold</th><th>Junk</th><th>Not reachable</th><th>Lost</th><th>Qualified rate</th></tr></thead>
        <tbody>${rows.filter(r=>r.leads>0).map(r=>`<tr><td>${esc(r.name)}</td><td>${adsN(r.leads)}</td><td>${adsN(r.hot)}</td><td>${adsN(r.warm)}</td><td>${adsN(r.cold)}</td>
          <td${r.junk/r.leads>=0.3?' style="color:var(--red);font-weight:700"':''}>${adsN(r.junk)} (${adsPct(r.junk, r.leads)})</td><td>${adsN(r.unreachable)} (${adsPct(r.unreachable, r.leads)})</td><td>${adsN(r.lost)}</td><td>${adsPct(r.qualified, r.leads)}</td></tr>`).join('')
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
        ${stat('Never called', adsN(speed.never))}
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
        <tbody>${staff.map(r=>`<tr><td>${esc(r.name)}</td><td>${adsN(r.leads)}</td><td>${adsPct(r.called, r.leads)}</td><td>${adsPct(r.answered, r.leads)}</td><td>${adsMinutes(r.median)}</td><td>${adsN(r.qualified)}</td><td>${adsN(r.won)}</td><td>${dealMoney(r.revenue)}</td><td>${adsPct(r.won, r.leads-r.junk)}</td></tr>`).join('')
          ||'<tr><td colspan="9" style="color:var(--muted)">No ad leads in this period.</td></tr>'}</tbody>
      </table></div>
      <div class="s-note" style="margin-top:6px">Conversion leaves junk out. A campaign with poor sales but slow or no calls is a follow-up problem, not an ad problem.</div>
    </div>

    ${adsHealthCard(cache.health, cache.settings)}
    ${adsCapiCard(cache.capi)}
    ${adsAudiencesCard(cache.settings)}
    ${adsSettingsCard(cache.settings)}
    <div id="adsLeadsPop" style="display:none"></div>`;
  // Phones show each row as a card labelled from data-label (dashboard.html .leads-tbl rules).
  el.querySelectorAll('table.leads-tbl').forEach(t=>{
    const heads=[...t.querySelectorAll('thead th')].map(th=>th.textContent.trim());
    t.querySelectorAll('tbody tr, tfoot tr').forEach(tr=>[...tr.children].forEach((td,i)=>{ if(heads[i]&&td.colSpan===1) td.dataset.label=heads[i]; }));
  });
}

// Every ad that spent in the period: status, when it ran, and a day-by-day timeline strip.
function adsRunningCard(running, dayList, money, connected, data){
  if(!connected) return '';
  const showStrip=dayList.length<=93;
  const strip=r=>{
    if(!showStrip) return '';
    const max=Math.max(1, ...[...r.days.values()].map(d=>d.spend));
    return `<div style="display:flex;gap:1px;min-width:${Math.min(dayList.length*6, 560)}px;height:14px">${dayList.map(day=>{ const d=r.days.get(day);
      return `<span title="${esc(day)}${d?' · '+money(d.spend)+' · '+(d.meta_leads+d.meta_chats)+' results':''}" style="flex:1;min-width:2px;border-radius:2px;background:${d?'var(--accent,#0D9C93)':'var(--line,#e5e7eb)'};opacity:${d?0.35+0.65*d.spend/max:1}"></span>`; }).join('')}</div>`;
  };
  const changes=(data.changes||[]).slice(0,30);
  return `<div class="card" style="margin-bottom:14px" id="adsRunning">
    <div class="s-head" style="margin-bottom:4px">🟢 Ads running in this period (${running.length})</div>
    <div class="s-note" style="margin-bottom:8px">Every ad that spent in these dates, when it ran, and what it brought in. Status is as of the last sync.</div>
    <div style="overflow-x:auto"><table class="leads-tbl" id="adsRunningTbl" style="width:100%;min-width:1000px">
      <thead><tr><th>Ad</th><th>Status</th><th>First day</th><th>Last day</th><th>Days live</th><th>Spend</th><th>Meta counted</th><th>CRM leads</th><th>Sales</th><th>Cost/sale</th>${showStrip?'<th>Timeline</th>':''}</tr></thead>
      <tbody>${running.slice(0,60).map(r=>`<tr>
        <td style="white-space:normal;max-width:none;min-width:200px"><div>${esc(r.name)}</div><div class="s-note">${esc([r.campaign, r.adset].filter(Boolean).join(' › '))}</div></td>
        <td>${adsStatusChip(r.status)}</td><td>${esc(r.first)}</td><td>${esc(r.last)}</td><td>${r.daysLive}</td><td>${money(r.spend)}</td><td>${r.meta}</td>
        <td>${r.leads>0?`<a href="#" onclick="adsShowLeadsAd(${esc(JSON.stringify(r.ad_id))});return false">${adsN(r.leads)}</a>`:'0'}</td><td>${adsN(r.won)}</td><td>${r.won>0?money(r.spend/r.won):'—'}</td>
        ${showStrip?`<td style="max-width:none;overflow:visible">${strip(r)}</td>`:''}</tr>`).join('')||`<tr><td colspan="${showStrip?11:10}" style="color:var(--muted)">No ad spent in this period.</td></tr>`}</tbody>
    </table></div>
    ${running.length>60?`<div class="s-note" style="margin-top:6px">Showing the 60 ads with the most spend of ${running.length}.</div>`:''}
    <div class="s-head" style="margin:14px 0 6px">🕘 What changed</div>
    <div id="adsChanges">${changes.length?changes.map(c=>`<div class="s-note">${esc(c.day)} · <b>${esc(c.ad_name||c.ad_id||'')}</b>${c.campaign_name?' ('+esc(c.campaign_name)+')':''} — ${esc(c.detail||c.kind)}</div>`).join('')
      :'<div class="s-note">No status changes seen in this period (changes are recorded from each sync onward).</div>'}</div>
  </div>`;
}

// Day by day: spend, how many ads were live, Meta's count, CRM ad leads and sales.
function adsDaysCard(data, adLeads, dayList, money, connected){
  const byDay=new Map(dayList.map(d=>[d, {spend:0, live:0, meta:0, leads:0, won:0}]));
  for(const d of data.ad_days||[]){ const r=byDay.get(d.day); if(!r) continue; r.spend+=d.spend; if(d.spend>0) r.live++; r.meta+=d.meta_leads+d.meta_chats; }
  for(const {l, ms, w} of adLeads){ const r=byDay.get(adsLocalDay(ms)); if(!r) continue; r.leads+=w; if(isWonLead(l)) r.won+=w; }
  const rows=[...byDay.entries()].reverse().filter(([,r])=>r.spend||r.leads||r.meta);
  return `<div class="card" style="margin-bottom:14px">
    <div class="s-head" style="margin-bottom:8px">📅 Day by day</div>
    <div style="overflow-x:auto;max-height:420px;overflow-y:auto"><table class="leads-tbl" id="adsDays" style="width:100%;min-width:640px">
      <thead><tr><th>Day</th><th>Spend</th><th>Ads live</th><th>Meta counted</th><th>CRM ad leads</th><th>Sales</th><th>Cost/lead</th></tr></thead>
      <tbody>${rows.map(([day,r])=>`<tr><td>${esc(day)}</td><td>${connected?money(r.spend):'—'}</td><td>${connected?r.live:'—'}</td><td>${connected?r.meta:'—'}</td><td>${adsN(r.leads)}</td><td>${adsN(r.won)}</td><td>${connected&&r.leads&&r.spend?money(r.spend/r.leads):'—'}</td></tr>`).join('')
        ||'<tr><td colspan="7" style="color:var(--muted)">Nothing in this period.</td></tr>'}</tbody>
    </table></div></div>`;
}

// Ads ranked by what they cost per sale (then per qualified lead), not by cheap clicks; fatigue flagged.
function adsLeaderboardCard(running, money, connected){
  if(!connected) return '';
  const list=running.filter(r=>r.spend>0).map(r=>({...r, cps:r.won>0?r.spend/r.won:null, cpq:r.qualified>0?r.spend/r.qualified:null}))
    .sort((a,b)=>(a.cps==null)-(b.cps==null)||(a.cps??0)-(b.cps??0)||(a.cpq==null)-(b.cpq==null)||(a.cpq??0)-(b.cpq??0)||b.spend-a.spend).slice(0,25);
  return `<div class="card" style="margin-bottom:14px">
    <div class="s-head" style="margin-bottom:4px">🏆 Creative leaderboard</div>
    <div class="s-note" style="margin-bottom:8px">Best cost per sale first, then cost per qualified lead. ⚠️ Fatigue = Meta's cost per result in the ad's later days is 40%+ above its first days — refresh the creative.</div>
    <div style="overflow-x:auto"><table class="leads-tbl" id="adsLeaders" style="width:100%;min-width:860px">
      <thead><tr><th>#</th><th>Ad</th><th>Headline</th><th>Days live</th><th>Spend</th><th>CRM leads</th><th>Qualified</th><th>Sales</th><th>Cost/qualified</th><th>Cost/sale</th><th>Fatigue</th></tr></thead>
      <tbody>${list.map((r,i)=>`<tr><td>${i+1}</td><td style="white-space:normal;max-width:none;min-width:180px">${esc(r.name)}<div class="s-note">${esc(r.campaign)}</div></td><td style="white-space:normal">${esc(r.headline||'—')}</td>
        <td>${r.daysLive}</td><td>${money(r.spend)}</td><td>${adsN(r.leads)}</td><td>${adsN(r.qualified)}</td><td>${adsN(r.won)}</td><td>${r.cpq!=null?money(r.cpq):'—'}</td><td>${r.cps!=null?money(r.cps):'—'}</td>
        <td>${r.fatigue!=null?`<span style="color:var(--red);font-weight:700">⚠️ +${r.fatigue}%</span>`:'—'}</td></tr>`).join('')
        ||'<tr><td colspan="11" style="color:var(--muted)">No ad spent in this period.</td></tr>'}</tbody>
    </table></div></div>`;
}

// When ad leads arrive (weekday × hour, this browser's time), and the hours that turn into sales.
function adsHeatmapCard(adLeads){
  const grid=Array.from({length:7}, ()=>Array(24).fill(0)), won=Array.from({length:7}, ()=>Array(24).fill(0));
  for(const {l, ms, w} of adLeads){ const d=new Date(ms); grid[d.getDay()][d.getHours()]+=w; if(isWonLead(l)) won[d.getDay()][d.getHours()]+=w; }
  const max=Math.max(0.0001, ...grid.flat());
  const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const byHour=Array.from({length:24}, (_,h)=>({h, leads:grid.reduce((s,r)=>s+r[h],0), won:won.reduce((s,r)=>s+r[h],0)}));
  const best=byHour.filter(x=>x.leads>=3).sort((a,b)=>b.won/b.leads-a.won/a.leads||b.leads-a.leads).slice(0,3);
  const busiest=byHour.slice().sort((a,b)=>b.leads-a.leads).slice(0,3).filter(x=>x.leads>0);
  const hl=h=>`${String(h).padStart(2,'0')}:00`;
  return `<div class="card" style="margin-bottom:14px">
    <div class="s-head" style="margin-bottom:4px">🕒 When ad leads arrive</div>
    <div class="s-note" style="margin-bottom:8px">${busiest.length?`Busiest hours: ${busiest.map(x=>hl(x.h)).join(', ')}.`:''} ${best.some(x=>x.won)?`Best hours for sales: ${best.filter(x=>x.won).map(x=>`${hl(x.h)} (${adsPct(x.won, x.leads)})`).join(', ')}.`:''} Run ads and keep staff on the phones in the darker hours.</div>
    <div style="overflow-x:auto"><div id="adsHeatmap" style="display:grid;grid-template-columns:40px repeat(24,minmax(18px,1fr));gap:2px;min-width:560px;font-size:10px">
      <span></span>${Array.from({length:24}, (_,h)=>`<span style="text-align:center;color:var(--muted)">${h}</span>`).join('')}
      ${grid.map((row,d)=>`<span style="color:var(--muted)">${days[d]}</span>${row.map((v,h)=>`<span title="${days[d]} ${hl(h)} · ${adsN(v)} leads${won[d][h]?' · '+adsN(won[d][h])+' sales':''}" style="height:18px;border-radius:3px;background:${v?'var(--accent,#0D9C93)':'var(--line,#e5e7eb)'};opacity:${v?0.2+0.8*v/max:1}"></span>`).join('')}`).join('')}
    </div></div></div>`;
}

// The leads behind a number: name, when, how it was matched, its share, stage, owner.
function adsLeadsPop(title, items){
  const pop=$id('adsLeadsPop'); if(!pop) return;
  const rows=items.slice().sort((a,b)=>b.ms-a.ms);
  pop.style.cssText='position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;padding:16px';
  pop.innerHTML=`<div class="card" style="max-width:760px;width:100%;max-height:80vh;overflow:auto" onclick="event.stopPropagation()">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><div class="s-head" style="margin:0;flex:1">${esc(title)} — ${adsN(rows.reduce((s,x)=>s+x.w,0))} lead${rows.length===1?'':'s'}</div>
      <button class="btn btn-secondary btn-sm" onclick="adsCloseLeads()">✕</button></div>
    <table class="leads-tbl" id="adsLeadsList" style="width:100%"><thead><tr><th>Lead</th><th>Arrived</th><th>Matched by</th><th>Share</th><th>Stage</th><th>Owner</th></tr></thead>
      <tbody>${rows.map(x=>`<tr><td><a href="#" onclick="adsCloseLeads();openDetail(${Number(x.l.Id)});return false">${esc(x.l.Name||x.l.Phone||'Lead '+x.l.Id)}</a></td>
        <td>${esc(new Date(x.ms).toLocaleString())}</td><td>${esc(ADS_METHODS[x.method]||x.method)}</td><td>${x.w>=0.995?'100%':Math.round(x.w*100)+'%'}</td>
        <td>${esc(typeof stageLabel==='function'?stageLabel(x.l.Stage):(x.l.Stage||''))}${isWonLead(x.l)?' ✅':''}</td><td>${esc(x.l.Owner||'Unassigned')}</td></tr>`).join('')}</tbody></table></div>`;
  pop.onclick=adsCloseLeads;
}
function adsShowLeads(key){
  const items=_adsLeadLists[key]||[];
  const cache=_adsCache; const idx=adsIndex(cache.data?.ads||[]);
  const name=!key?'Not matched':key.startsWith('c:')?(idx.byCampaign.get(key.slice(2))?.campaign_name||'Campaign'):
    _adsLevel==='campaign'?(idx.byCampaign.get(key)?.campaign_name||key):_adsLevel==='adset'?(idx.byAdset.get(key)?.adset_name||key):(idx.byAd.get(key)?.ad_name||key);
  adsLeadsPop(name, items);
}
// The running-ads table is always per ad, whatever level the main table shows.
function adsShowLeadsAd(adId){
  const range=adsRange();
  const {lists}=adsCompute(_adsCache.data||{}, range, _adsCache.firstMsgs, 'ad');
  adsLeadsPop(adsIndex(_adsCache.data?.ads||[]).byAd.get(adId)?.ad_name||adId, lists[adId]||[]);
}
function adsCloseLeads(){ const pop=$id('adsLeadsPop'); if(pop){ pop.style.display='none'; pop.innerHTML=''; } }

/* ── Sales-based rules: proposals from the same lead matching as the report, applied only when
   the owner approves (worker: /meta/ads-report/actions/apply, Undo via /actions/undo). ── */
const ADS_RULE_METRICS={cost_per_sale:'Cost per sale', cost_per_qualified:'Cost per qualified lead', cost_per_lead:'Cost per lead', roas:'ROAS (×)', junk_pct:'Junk leads (%)', no_sales_spend:'Spend with no sale'};
const ADS_RULE_ACTIONS={pause:'Pause', budget_down:'Cut budget', budget_up:'Raise budget'};
const ADS_RULE_PRESETS=[
  {metric:'cost_per_sale', op:'above', value:3000, days:7, min_spend:2000, level:'adset', action:'budget_down', pct:20},
  {metric:'no_sales_spend', op:'above', value:3000, days:7, min_spend:0, level:'adset', action:'pause', pct:0},
  {metric:'roas', op:'above', value:3, days:7, min_spend:1000, level:'adset', action:'budget_up', pct:15},
  {metric:'junk_pct', op:'above', value:40, days:7, min_spend:500, level:'adset', action:'pause', pct:0},
];
// The rule's number for one row; Infinity when there's spend but nothing to divide by (no sales yet).
function adsRuleMetric(metric, r){
  const per=(n)=>n>0?r.spend/n:(r.spend>0?Infinity:null);
  if(metric==='cost_per_sale') return per(r.won);
  if(metric==='cost_per_qualified') return per(r.qualified);
  if(metric==='cost_per_lead') return per(r.leads);
  if(metric==='roas') return r.spend>0?r.revenue/r.spend:null;
  if(metric==='junk_pct') return r.leads>=5?r.junk/r.leads*100:null;
  if(metric==='no_sales_spend') return r.won<0.5?r.spend:null;
  return null;
}
function adsRuleProposals(cache){
  const cfg=cache.settings?.config||{};
  const out=[], seen=new Set();
  for(const rule of (cfg.rules||[]).filter(r=>r.enabled)){
    const w=cache.windows?.[rule.days]; if(!w?.data?.ads) continue;
    const {rows}=adsCompute(w.data, w.range, {}, rule.level, true);
    const idx=adsIndex(w.data.ads);
    for(const r of rows){
      if(!r.key || r.key.startsWith('c:') || r.spend<rule.min_spend) continue;
      const v=adsRuleMetric(rule.metric, r); if(v==null) continue;
      if(!(rule.op==='above'?v>rule.value:v<rule.value)) continue;
      const a=rule.level==='campaign'?idx.byCampaign.get(r.key):idx.byAdset.get(r.key);
      const st=rule.level==='campaign'?a?.campaign_status:a?.adset_status;
      if(st && st!=='ACTIVE') continue; // already paused / not running
      let target={type:rule.level, id:r.key, name:r.name, budget:rule.level==='campaign'?a?.campaign_budget:a?.adset_budget};
      // Advantage campaign budget: the money sits on the campaign, so a budget change goes there.
      if(rule.action!=='pause' && rule.level==='adset' && !(a?.adset_budget>0) && a?.campaign_budget>0)
        target={type:'campaign', id:String(a.campaign_id), name:(a.campaign_name||'Campaign')+' (campaign budget)', budget:a.campaign_budget};
      const k=target.type+'|'+target.id; if(seen.has(k)) continue; seen.add(k);
      out.push({rule, target, value:v, row:r});
    }
  }
  return out;
}
// Staff-capacity guard: ad leads from the last 48 h still waiting for a first call. Past the limit,
// propose slowing the click-to-WhatsApp ad sets that bring chats — stop buying leads nobody calls.
function adsCapacityProposals(cache, adLeads){
  const g=cache.settings?.config?.capacity_guard;
  if(!g?.enabled) return {waiting:0, list:[]};
  const since=Date.now()-48*3600e3;
  // The last 7 days, whatever period the report shows.
  const w7=cache.windows?.[7];
  if(w7?.data?.ads) adLeads=adsCompute(w7.data, w7.range, cache.firstMsgs||{}, 'ad', true).adLeads;
  const waiting=adLeads.filter(({l, ms})=>ms>=since && !adsIsJunk(l) && !isWonLead(l) && !isLostLead(l) && adsFirstCallMin(l, ms)==null).length;
  if(waiting<g.max_uncalled) return {waiting, list:[]};
  const w=cache.windows?.[7]; const ads=w?.data?.ads||cache.data?.ads||[];
  const list=[], seen=new Set();
  for(const a of ads){
    if(!(a.meta_chats>0) || (a.adset_status && a.adset_status!=='ACTIVE')) continue;
    const t=a.adset_budget>0?{type:'adset', id:String(a.adset_id), name:a.adset_name||'Ad set', budget:a.adset_budget}
      :a.campaign_budget>0?{type:'campaign', id:String(a.campaign_id), name:(a.campaign_name||'Campaign')+' (campaign budget)', budget:a.campaign_budget}:null;
    if(!t || seen.has(t.type+'|'+t.id)) continue; seen.add(t.type+'|'+t.id);
    list.push({rule:{id:'capacity', action:'budget_down', pct:g.pct, metric:'capacity'}, target:t, value:waiting});
  }
  return {waiting, list};
}
let _adsProposals=[];
function adsActionsCard(cache, adLeads, money){
  const s=cache.settings; if(!s || !cache.data?.connected) return '';
  const cfg=s.config||{};
  const rules=adsRuleProposals(cache), cap=adsCapacityProposals(cache, adLeads);
  _adsProposals=[...cap.list, ...rules];
  const can=!!s.can_edit;
  const fmtV=(m, v)=>v===Infinity?'no '+(m==='cost_per_sale'?'sale':m==='cost_per_qualified'?'qualified lead':'lead')+' yet':m==='roas'?v.toFixed(1)+'×':m==='junk_pct'?Math.round(v)+'%':money(v);
  const why=p=>p.rule.id==='capacity'?`${p.value} ad leads from the last 48 h are still waiting for a first call (limit ${cfg.capacity_guard.max_uncalled})`
    :`${ADS_RULE_METRICS[p.rule.metric]} ${fmtV(p.rule.metric, p.value)} ${p.rule.op} ${fmtV(p.rule.metric, p.rule.value)} over ${p.rule.days} days · spend ${money(p.row.spend)}`;
  const what=p=>p.rule.action==='pause'?'Pause':`${p.rule.action==='budget_up'?'Raise':'Cut'} daily budget ${p.rule.pct}%${p.target.budget?` (${money(p.target.budget)} → ${money(p.target.budget*(1+(p.rule.action==='budget_up'?1:-1)*Math.min(p.rule.pct, cfg.max_change_pct||30)/100))})`:''}`;
  const acts=(s.actions||[]).slice(0,10);
  const actRow=a=>{ let b={}, f={}; try{ b=JSON.parse(a.before_json||'{}'); f=JSON.parse(a.after_json||'{}'); }catch(e){}
    const change=a.action==='pause'?'Paused':a.action==='undo'?'Undo':`Budget ${money((b.daily_budget||0)/100)} → ${money((f.daily_budget||0)/100)}`;
    return `<div class="s-note" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${esc(String(a.at||'').slice(0,16).replace('T',' '))} · <b>${esc(a.target_name||a.target_id)}</b> · ${esc(change)} · ${esc(a.status)}${a.error?' — '+esc(a.error):''}
      ${can&&a.status==='ok'&&a.action!=='undo'&&!a.undone_at?`<button class="btn btn-secondary btn-sm" onclick="adsUndoAction(${Number(a.id)})">↩ Undo</button>`:''}</div>`; };
  return `<div class="card" style="margin-bottom:14px" id="adsActions">
    <div class="s-head" style="margin-bottom:4px">🧭 Suggested actions</div>
    <div class="s-note" style="margin-bottom:8px">From your sales-based rules${cfg.capacity_guard?.enabled?' and the staff-capacity guard':''} (settings below), using the same lead matching as this report. Nothing changes in Meta until ${can?'you approve it':'the account owner approves it'}; every change can be undone.</div>
    ${cap.waiting>=((cfg.capacity_guard||{}).max_uncalled||Infinity)?`<div class="s-note" style="color:var(--red);margin-bottom:6px">⚠️ ${cap.waiting} ad leads are waiting for a first call — slowing ads until the team catches up.</div>`:''}
    <div id="adsProposals">${_adsProposals.length?_adsProposals.map((p,i)=>`<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:8px 0;border-bottom:1px solid var(--line)">
        <div style="flex:1;min-width:220px"><b>${esc(what(p))}</b> — ${esc(p.target.name)} <span class="s-note">(${p.target.type==='adset'?'ad set':'campaign'})</span><div class="s-note">${esc(why(p))}</div></div>
        ${can?`<button class="btn btn-primary btn-sm" data-i="${i}" onclick="adsApprove(${i})">Approve</button>`:''}</div>`).join('')
      :`<div class="s-note">${(cfg.rules||[]).some(r=>r.enabled)||cfg.capacity_guard?.enabled?'No rule is triggered right now.':'No rules yet — add one in the settings below (e.g. "cut budget 20% when cost per sale is above ₹3,000").'}</div>`}</div>
    ${acts.length?`<div class="s-head" style="margin:12px 0 4px;font-size:13px">Recent changes</div><div id="adsActionLog">${acts.map(actRow).join('')}</div>`:''}
  </div>`;
}
async function adsApprove(i){
  const p=_adsProposals[i]; if(!p) return;
  const btn=document.querySelector(`#adsProposals button[data-i="${i}"]`); if(btn){ btn.disabled=true; btn.textContent='Applying…'; }
  try{
    const r=await fetch(`${CONFIG.WORKER_BASE}/meta/ads-report/actions/apply`, {method:'POST', headers:ncAuthHeaders({'Content-Type':'application/json'}),
      body:JSON.stringify({target_type:p.target.type, target_id:p.target.id, action:p.rule.action, pct:p.rule.pct, reason:p.rule.id==='capacity'?`Staff-capacity guard: ${p.value} leads waiting`:`Rule ${p.rule.id}: ${ADS_RULE_METRICS[p.rule.metric]}`})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(d.error||'HTTP '+r.status);
    showToast(`✓ ${p.target.name}: ${p.rule.action==='pause'?'paused':'budget '+((d.before?.daily_budget||0)/100)+' → '+((d.after?.daily_budget||0)/100)}`);
    _adsCache.at=0; renderReportsAds(true);
  }catch(e){ showToast('Not applied: '+e.message, 'err'); if(btn){ btn.disabled=false; btn.textContent='Approve'; } }
}
async function adsUndoAction(id){
  try{
    const r=await fetch(`${CONFIG.WORKER_BASE}/meta/ads-report/actions/undo`, {method:'POST', headers:ncAuthHeaders({'Content-Type':'application/json'}), body:JSON.stringify({id})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(d.error||'HTTP '+r.status);
    showToast('✓ Undone'); _adsCache.at=0; renderReportsAds(true);
  }catch(e){ showToast('Undo failed: '+e.message, 'err'); }
}

/* ── 🩺 Tracking health + Conversion Leads checklist (worker marHealth, last 7 days) ── */
function adsHealthCard(h, s){
  if(!h || h.sent==null) return '';
  const cfg=s?.config||{};
  const strong=(h.match?.lead_id||0)+(h.match?.ctwa_clid||0)+(h.match?.fbc||0);
  const funnelSent=(h.by_event||[]).filter(e=>String(e.event).startsWith('funnel:')).reduce((a,e)=>a+e.sent,0);
  const mapped=Object.keys(cfg.funnel_map||{}).length;
  const evName=e=>({lead:'Lead', qualified:'Qualified', disqualified:'Disqualified', booked:'Booked (Schedule)', purchase:'Purchase', junk:'Junk'})[e]
    ||(String(e).startsWith('funnel:')?(Object.values(cfg.funnel_map||{}).find(n=>'funnel:'+n.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'')===e)||e.slice(7)):e);
  const metaRecv=h.meta?.received||{};
  const check=(ok, text, fix)=>`<div class="s-note" style="margin:3px 0">${ok?'✅':'⚠️'} ${esc(text)}${!ok&&fix?` — <span style="color:var(--muted)">${fix}</span>`:''}</div>`;
  const failRate=h.sent+h.failed?h.failed/(h.sent+h.failed):0;
  return `<div class="card" style="margin-bottom:14px" id="adsHealth">
    <div class="s-head" style="margin-bottom:4px">🩺 Tracking health (last ${h.days} days)</div>
    <div class="s-note" style="margin-bottom:8px">What reached Meta through the Conversions API, what it refused, and how strongly events match an ad click. Problems also go in the daily alert.</div>
    <div style="display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));margin-bottom:10px">
      <div class="stat"><div class="stat-lbl">Events sent</div><div class="stat-val">${h.sent}</div></div>
      <div class="stat"><div class="stat-lbl">Refused by Meta</div><div class="stat-val"${h.failed?' style="color:var(--red)"':''}>${h.failed}</div><div class="s-note">${adsPct(h.failed, h.sent+h.failed)}</div></div>
      <div class="stat"><div class="stat-lbl">Matched by ad click</div><div class="stat-val">${adsPct(strong, h.sent)}</div><div class="s-note">form id, WhatsApp click or fbc</div></div>
      <div class="stat"><div class="stat-lbl">Last event</div><div class="stat-val" style="font-size:15px">${h.last_sent_at?esc(new Date(h.last_sent_at).toLocaleString()):'—'}</div></div>
      ${h.meta?.ok?`<div class="stat"><div class="stat-lbl">Meta received</div><div class="stat-val">${Object.values(metaRecv).reduce((a,b)=>a+b,0)}</div><div class="s-note">all sources, incl. Pixel</div></div>`:''}
    </div>
    <div style="overflow-x:auto"><table class="leads-tbl" id="adsHealthEvents" style="width:100%;min-width:560px">
      <thead><tr><th>Event</th><th>Sent</th><th>Refused</th><th>Matched by ad click</th><th>Meta received</th></tr></thead>
      <tbody>${(h.by_event||[]).map(e=>{ const n=evName(e.event); return `<tr><td>${esc(n)}</td><td>${e.sent}</td><td${e.failed?' style="color:var(--red)"':''}>${e.failed}</td><td>${adsPct(e.strong, e.sent)}</td><td>${metaRecv[n]!=null?metaRecv[n]:'—'}</td></tr>`; }).join('')
        ||'<tr><td colspan="5" style="color:var(--muted)">No events in these days.</td></tr>'}</tbody></table></div>
    ${(h.errors||[]).length?`<div class="s-head" style="margin:10px 0 4px;font-size:13px">Why Meta refused events</div><div id="adsHealthErrors">${h.errors.map(x=>`<div class="s-note">${x.n}× ${esc(x.error)}${x.code?` (code ${esc(x.code)})`:''}</div>`).join('')}</div>`:''}
    <div class="s-head" style="margin:12px 0 4px;font-size:13px">Conversion Leads setup (lead-quality optimisation)</div>
    <div id="adsCLChecklist">
      ${check(h.pixel_connected, 'Pixel / Dataset and token connected', 'add them in Settings → Integrations → Meta Ads')}
      ${h.pixel_connected?check(!!h.meta?.ok, 'Meta can see the dataset with this token', esc(h.meta?.error||'assign the dataset to the token\'s system user')):''}
      ${check(!!clientRecord?.meta_leadgen_connected, 'Lead forms connected', 'connect them in Integrations → Lead Forms so form leads carry their lead id')}
      ${check(mapped>=2, `Funnel stages mapped to events (${mapped})`, 'map at least two pipeline stages in the settings below')}
      ${check(funnelSent>0, `Funnel events reached Meta (${funnelSent})`, 'they start as leads move through the mapped stages')}
      ${check((h.match?.lead_id||0)>0, 'Form leads sent back with their lead id', 'needs connected lead forms and mapped stages')}
      ${check(failRate<0.05, 'Meta accepts the events', 'see the refusals above')}
      <div class="s-note" style="margin-top:4px">When these are green and each stage gets events every week, switch the lead-form campaign's goal to <b>Conversion leads</b> in Ads Manager.</div>
    </div>
  </div>`;
}

/* ── 👥 CRM audiences in the ad account, refreshed daily (worker marRefreshAudiences) ── */
function adsAudiencesCard(s){
  if(!s?.audiences) return '';
  const cfg=s.config||{};
  return `<div class="card" style="margin-bottom:14px" id="adsAudiences">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:4px"><div class="s-head" style="margin:0;flex:1">👥 CRM audiences</div>
      ${s.can_edit&&s.connected?`<button class="btn btn-secondary btn-sm" id="adsAudRefresh" onclick="adsRefreshAudiences()">🔄 Refresh now</button>`:''}</div>
    <div class="s-note" style="margin-bottom:8px">${cfg.audiences_enabled?'Refreshed every morning from your leads (phone/email, hashed).':'Off — switch on "CRM audiences" in the settings below.'} Use Buyers / Buyers-by-value lookalikes to prospect, Hot-not-bought to retarget, and add Exclude to every prospecting ad set. Needs <b>ads_management</b> on the token.</div>
    <div style="overflow-x:auto"><table class="leads-tbl" id="adsAudTbl" style="width:100%;min-width:640px">
      <thead><tr><th>Audience</th><th>People</th><th>Lookalike</th><th>Last refresh</th><th>Status</th></tr></thead>
      <tbody>${s.audiences.map(a=>`<tr><td style="white-space:normal;max-width:none;min-width:200px"><div>${esc(a.name)}</div><div class="s-note">${esc(a.desc||'')}</div></td>
        <td>${a.last_run_at?Number(a.size||0):'—'}</td><td>${a.lookalike?(a.lookalike_id?'✅ created':'—'):'n/a'}</td><td>${a.last_run_at?esc(String(a.last_run_at).slice(0,16).replace('T',' ')):'never'}</td>
        <td style="white-space:normal;max-width:none">${a.last_error?`<span style="color:var(--red)">${esc(a.last_error)}</span>`:a.audience_id?'OK':'—'}</td></tr>`).join('')}</tbody>
    </table></div></div>`;
}
async function adsRefreshAudiences(){
  const btn=$id('adsAudRefresh'); if(btn){ btn.disabled=true; btn.textContent='Refreshing…'; }
  try{
    const r=await fetch(`${CONFIG.WORKER_BASE}/meta/ads-report/audiences/refresh`, {method:'POST', headers:ncAuthHeaders()});
    const d=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(d.error||'HTTP '+r.status);
    const bad=(d.results||[]).filter(x=>!x.ok);
    showToast(bad.length?'Some audiences failed: '+bad[0].error:'✓ Audiences refreshed', bad.length?'err':'ok');
  }catch(e){ showToast('Refresh failed: '+e.message, 'err'); }
  _adsCache.at=0; renderReportsAds(true);
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

    <div style="margin-top:12px" id="adsPurchaseBox">
      <label class="form-label" style="font-weight:600">🛒 Purchase label(s) — sent to Meta as a Purchase</label>
      <input class="form-input" id="adsPurchaseLabels" style="max-width:420px" value="${esc((cfg.purchase_labels||[]).join(', '))}" placeholder="Order placed"${dis}>
      <div class="s-note">When a lead gets one of these labels (Leads tags, Edit Lead or a Chats label), a <b>Purchase</b> with the lead's deal value — or the customer's latest order total — goes to Meta through the Conversions API, once per lead, so your ads learn who actually buys. Comma separated; leave blank to switch it off. Needs the Pixel/Dataset ID and token in Settings → Integrations → Meta Ads.</div>
    </div>

    ${adsGrowthSettings(cfg, dis)}

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
function adsSetInclEst(on){ _adsInclEst=!!on; renderReportsAds(); }
async function adsSyncNow(){
  const btn=$id('adsSyncBtn'); if(btn){ btn.disabled=true; btn.textContent='Syncing…'; }
  try{
    const r=await fetch(`${CONFIG.WORKER_BASE}/meta/ads-report/sync`, {method:'POST', headers:ncAuthHeaders()});
    const d=await r.json().catch(()=>({}));
    if(!r.ok) showToast(d.error||'Sync failed', 'err'); else showToast(`✓ Synced ${d.rows} ad-day rows (${d.since} → ${d.until})${d.ads!=null?`, ${d.ads} ads`:''}${(d.warnings||[]).length?' — '+d.warnings.join('; '):''}`);
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
    purchase_labels:$id('adsPurchaseLabels').value.split(',').map(x=>x.trim()).filter(Boolean),
    funnel_map:Object.fromEntries([...document.querySelectorAll('#adsFunnelMap input[data-stage]')].map(i=>[i.dataset.stage, i.value.trim()]).filter(([,v])=>v)),
    send_junk:$id('adsSendJunk').checked,
    pixel_consent_banner:$id('adsConsent').checked,
    audiences_enabled:$id('adsAudOn').checked,
    audience_country:$id('adsAudCountry').value.trim().toUpperCase()||'IN',
    audience_ratio:Number($id('adsAudRatio').value)||1,
    rules:[...document.querySelectorAll('#adsRules .ads-rule')].map(adsReadRule),
    capacity_guard:{enabled:$id('adsCapOn').checked, max_uncalled:Number($id('adsCapMax').value)||20, pct:Number($id('adsCapPct').value)||20},
    max_change_pct:Number($id('adsMaxChange').value)||30,
    min_daily_budget:Number($id('adsMinBudget').value)||0,
  };
}
function adsReadRule(el){
  const v=k=>el.querySelector(`[data-k="${k}"]`);
  return {id:el.dataset.id, enabled:v('enabled').checked, metric:v('metric').value, op:v('op').value, value:Number(v('value').value)||0,
    days:Number(v('days').value)||7, min_spend:Number(v('min_spend').value)||0, level:v('level').value, action:v('action').value, pct:Number(v('pct').value)||0};
}
// Pipeline stages a lead can reach, plus won / lost, each with an optional Conversions API event name.
function adsFunnelStages(mapped){
  let flow={}; try{ flow=getFlow()||{}; }catch(e){}
  const ids=[...new Set(['new', ...Object.keys(flow.stages||{}).filter(k=>k!=='new'), 'human_handover', 'won', 'lost', ...Object.keys(mapped||{})])];
  return ids.map(id=>{ let n=id; try{ n=stageLabel(id)||id; }catch(e){} return {id, name:n}; });
}
function adsSuggestFunnel(){
  const skip=new Set(['new','lost']);
  document.querySelectorAll('#adsFunnelMap input[data-stage]').forEach(i=>{
    if(i.value.trim() || skip.has(i.dataset.stage)) return;
    i.value=String(i.dataset.label||i.dataset.stage).replace(/[^A-Za-z0-9 ]+/g,' ').trim().split(/\s+/).map(w=>w[0].toUpperCase()+w.slice(1).toLowerCase()).join('').slice(0,40);
  });
}
function adsRuleRow(r, dis){
  const opt=(o, cur)=>Object.entries(o).map(([k,v])=>`<option value="${k}"${k===cur?' selected':''}>${esc(v)}</option>`).join('');
  return `<div class="ads-rule" data-id="${esc(r.id||'r'+Date.now().toString(36))}" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:6px 0;border-bottom:1px solid var(--line);font-size:13px">
    <input type="checkbox" data-k="enabled"${r.enabled!==false?' checked':''}${dis} title="On">
    If <select class="form-input" data-k="metric" style="width:auto"${dis}>${opt(ADS_RULE_METRICS, r.metric)}</select>
    is <select class="form-input" data-k="op" style="width:auto"${dis}>${opt({above:'above', below:'below'}, r.op)}</select>
    <input class="form-input" type="number" min="0" data-k="value" style="width:90px" value="${r.value??''}"${dis}>
    over <select class="form-input" data-k="days" style="width:auto"${dis}>${opt({3:'3 days', 7:'7 days', 14:'14 days', 30:'30 days'}, String(r.days||7))}</select>
    per <select class="form-input" data-k="level" style="width:auto"${dis}>${opt({adset:'ad set', campaign:'campaign'}, r.level)}</select>
    with spend ≥ <input class="form-input" type="number" min="0" data-k="min_spend" style="width:80px" value="${r.min_spend??0}"${dis}>
    → <select class="form-input" data-k="action" style="width:auto"${dis}>${opt(ADS_RULE_ACTIONS, r.action)}</select>
    <input class="form-input" type="number" min="0" max="50" data-k="pct" style="width:60px" value="${r.pct??20}" title="% change (budget actions)"${dis}>%
    ${dis?'':`<button class="btn btn-secondary btn-sm" onclick="this.closest('.ads-rule').remove()" title="Remove">✕</button>`}
  </div>`;
}
function adsAddRule(i){
  const box=$id('adsRules'); if(!box) return;
  box.querySelector('.s-note.empty')?.remove();
  box.insertAdjacentHTML('beforeend', adsRuleRow({...ADS_RULE_PRESETS[i]||ADS_RULE_PRESETS[0], id:'r'+Date.now().toString(36)}, ''));
}
function adsGrowthSettings(cfg, dis){
  const fm=cfg.funnel_map||{};
  const g=cfg.capacity_guard||{};
  const presetName=p=>`${ADS_RULE_ACTIONS[p.action]} when ${ADS_RULE_METRICS[p.metric].toLowerCase()} is ${p.op} ${p.value}`;
  return `<div style="margin-top:14px" id="adsFunnelBox">
      <label class="form-label" style="font-weight:600">📶 Funnel events for Conversion Leads</label>
      <div class="s-note">When a lead reaches a stage, this event goes to Meta through the Conversions API (once per lead) — form leads with their lead id, WhatsApp-ad chats with their click id. Meta then optimises lead-form campaigns for leads that move down your funnel. Use short names without spaces, e.g. <i>QualifiedLead</i>, <i>QuoteSent</i>.</div>
      <div id="adsFunnelMap" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:6px 12px;margin:6px 0">
        ${adsFunnelStages(fm).map(st=>`<label style="font-size:13px;display:flex;gap:6px;align-items:center"><span style="min-width:90px">${esc(st.name)}</span><input class="form-input" data-stage="${esc(st.id)}" data-label="${esc(st.name)}" value="${esc(fm[st.id]||'')}" placeholder="—" maxlength="40"${dis}></label>`).join('')}
      </div>
      ${dis?'':`<button class="btn btn-secondary btn-sm" onclick="adsSuggestFunnel()">✨ Suggest names</button>`}
      <label style="display:flex;gap:8px;align-items:center;margin-top:6px;font-size:13px"><input type="checkbox" id="adsSendJunk"${cfg.send_junk!==false?' checked':''}${dis}> Send <b>Junk</b> when a lead is marked Spam (teaches Meta what to avoid)</label>
      <label style="display:flex;gap:8px;align-items:center;margin-top:4px;font-size:13px"><input type="checkbox" id="adsConsent"${cfg.pixel_consent_banner?' checked':''}${dis}> Ask visitors for cookie consent before the Pixel loads on your store and booking pages</label>
    </div>

    <div style="margin-top:14px" id="adsAudBox">
      <label style="display:flex;gap:8px;align-items:center;font-weight:600"><input type="checkbox" id="adsAudOn"${cfg.audiences_enabled?' checked':''}${dis}> 👥 CRM audiences, refreshed daily</label>
      <div class="s-note" style="margin-left:24px">Buyers, buyers by value, Hot leads not bought yet and an Exclude list (won, junk, opted out) are kept in your ad account, with lookalikes of buyers once there are 100+. Phone and email are hashed before they leave LeadVyne.</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin:6px 0 0 24px">
        <div><label class="form-label">Lookalike country</label><input class="form-input" id="adsAudCountry" style="max-width:80px" maxlength="2" value="${esc(cfg.audience_country||'IN')}"${dis}></div>
        <div><label class="form-label">Lookalike size (%)</label><input class="form-input" type="number" min="1" max="10" id="adsAudRatio" style="max-width:80px" value="${cfg.audience_ratio||1}"${dis}></div>
      </div>
    </div>

    <div style="margin-top:14px" id="adsRulesBox">
      <label class="form-label" style="font-weight:600">🧭 Sales-based rules (suggestions you approve)</label>
      <div class="s-note">Checked against CRM sales, not Meta's lead count. A triggered rule shows up under Suggested actions; nothing changes in Meta until the owner approves it.</div>
      <div id="adsRules">${(cfg.rules||[]).map(r=>adsRuleRow(r, dis)).join('')||'<div class="s-note empty">No rules yet.</div>'}</div>
      ${dis?'':`<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">${ADS_RULE_PRESETS.map((p,i)=>`<button class="btn btn-secondary btn-sm" onclick="adsAddRule(${i})">+ ${esc(presetName(p))}</button>`).join('')}</div>`}
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px">
        <div><label class="form-label">Largest budget change (%)</label><input class="form-input" type="number" min="1" max="50" id="adsMaxChange" style="max-width:100px" value="${cfg.max_change_pct||30}"${dis}></div>
        <div><label class="form-label">Never cut a daily budget below</label><input class="form-input" type="number" min="0" id="adsMinBudget" style="max-width:120px" value="${cfg.min_daily_budget||''}" placeholder="0"${dis}></div>
      </div>
      <label style="display:flex;gap:8px;align-items:center;font-weight:600;margin-top:10px"><input type="checkbox" id="adsCapOn"${g.enabled?' checked':''}${dis}> Staff-capacity guard</label>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin:6px 0 0 24px;align-items:end">
        <div><label class="form-label">When this many ad leads (last 48 h) wait for a first call</label><input class="form-input" type="number" min="1" id="adsCapMax" style="max-width:100px" value="${g.max_uncalled||20}"${dis}></div>
        <div><label class="form-label">suggest cutting WhatsApp-ad budgets by (%)</label><input class="form-input" type="number" min="5" max="50" id="adsCapPct" style="max-width:100px" value="${g.pct||20}"${dis}></div>
      </div>
    </div>`;
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
    _adsCache.at=0; setTimeout(()=>renderReportsAds(true), 600);
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
