// ── Ads ROI (Reports → 💸 Ads ROI) ───────────────────────────────────────────────────────────────
// What Meta Ads Manager can't show: what happened AFTER the click. Spend comes from Meta (read-only
// Ads Insights, synced per ad per day into D1 meta_ads_daily); leads, quality, calls, sales and
// revenue come from this CRM. The dashboard joins the two per campaign / ad set / ad
// (frontend/ads-report.js). Ad creation and editing stay in Ads Manager on purpose.
//
//   1. Attribution — leads carry AdId / CampaignId (lead forms) or AdId + CtwaClid (click-to-WhatsApp,
//      from the referral Chatwoot passes on); see worker.js engineLeadAdClick / processMetaLeadgenChange.
//   2. Spend sync — marSync: Ads Insights level=ad, time_increment=1, into meta_ads_daily. 90 days on
//      first use, then the last 3 days (Meta keeps restating recent days); "Sync now" re-reads 30.
//   7. Daily summary + alerts — marRunDue (15-minute cron, a few accounts per tick): after the
//      morning sync, yesterday's spend / ad leads / qualified / junk / sales on staff WhatsApp and
//      email, with alerts (spend with no leads, cost per lead over a limit, junk share, Meta
//      connection failing). Sent once per day per account (meta_ads_report_sends).
//   8. Accounting — marPostExpenses: one accounting_expenses row per month ("Meta Ads spend"),
//      updated as the month's spend grows; the ledger posts it to Advertising & Marketing. A row the
//      user deletes is never recreated.
//
// Settings live in D1 (meta_ads_report_state.config_json), not on the CLIENTS row. Only the account
// owner can change them, since they message staff and write to the books.
// This file imports nothing from worker.js; worker.js passes helpers in as `deps` (META_ADS_REPORT_DEPS):
// { json, requireSession, getClientById, isClientOwner, ncFetch, ensureLeadsColumns, leadsTable,
//   parseTeamWhatsapp, metaCreds(c)→{wa_phone_id,wa_token}|null, sendEmail(env,to,subject,html),
//   isAccountingEnabled(c, env)→bool|Promise<bool>, onExpenseCreated(env,cid,expenseId), logTemplateSend(env,cid,info),
//   reportOpsError }

const GRAPH='https://graph.facebook.com/v23.0';
const H=3600000, D=24*H;
export const MAR_BACKFILL_DAYS=90;
export const MAR_DAILY_DAYS=3;
export const MAR_MANUAL_DAYS=30;
export const MAR_HOURLY_DAYS=30; // hourly rows kept for time-window attribution (Reports → Ads ROI)
const MAR_STALE_MS=6*H;        // the report re-syncs on open when the last good sync is older than this
const MAR_RETRY_MS=10*60000;   // ...but not more often than this after a failure
const MAR_PER_TICK=3;          // accounts handled per 15-minute cron tick
const MAR_DAILY_FROM_UTC_HOUR=1; // the morning run starts 01:00 UTC (06:30 IST, 05:00 UAE)

export const MAR_DEFAULTS={
  summary_enabled:false,
  summary_staff:[],           // team emails — their WhatsApp number from User Management
  summary_emails:[],          // plain email recipients
  summary_template:'',        // optional approved WhatsApp template (3 body params); empty = plain text
  summary_template_lang:'en',
  alerts_enabled:false,
  alert_spend_no_leads:0,     // a campaign spending at least this in a day with no leads at all
  alert_cpl_max:0,            // cost per CRM lead above this (campaign, yesterday)
  alert_junk_pct:0,           // junk share of a campaign's last-7-day leads (min 5 leads)
  accounting_post:false,      // book monthly Meta spend as an expense in Accounting
  purchase_labels:['Order placed'], // a lead getting one of these labels (Tags) sends Purchase to Meta; [] = off
  funnel_map:{},              // pipeline stage id → Conversions API event name ("quote_sent" → "QuoteSent")
  send_junk:true,             // a lead marked Spam → "Junk" event (Meta learns who not to find)
  pixel_consent_banner:false, // LeadVyne web pages ask before loading the Meta Pixel
  audiences_enabled:false,    // daily CRM audiences in the ad account (needs ads_management)
  audience_country:'IN',      // lookalike country
  audience_ratio:1,           // lookalike size, % of the country (1–10)
  rules:[],                   // sales-based budget / pause rules — proposals, applied only on approval
  capacity_guard:{enabled:false, max_uncalled:20, pct:20},
  max_change_pct:30,          // no single approved budget change moves more than this %
  min_daily_budget:0,         // never cut a daily budget below this (account currency)
};
export const MAR_RULE_METRICS=['cost_per_sale','cost_per_qualified','cost_per_lead','roas','junk_pct','no_sales_spend'];
export const MAR_RULE_ACTIONS=['pause','budget_down','budget_up'];
// One sales-based rule, cleaned: "if <metric> is above/below <value> over the last <days> days for
// an <level> that spent at least <min_spend>, propose <action> (by <pct>%)".
export function marRule(r, i=0){
  const n=(v,max)=>{ const x=Number(v); return Number.isFinite(x)&&x>=0?Math.min(x,max):0; };
  if(!r || !MAR_RULE_METRICS.includes(r.metric) || !MAR_RULE_ACTIONS.includes(r.action)) return null;
  return {id:String(r.id||'r'+(i+1)).replace(/[^\w-]/g,'').slice(0,20)||'r'+(i+1), enabled:r.enabled!==false, metric:r.metric,
    op:r.op==='below'?'below':'above', value:n(r.value, 1e9), days:[3,7,14,30].includes(Number(r.days))?Number(r.days):7,
    min_spend:n(r.min_spend, 1e9), level:r.level==='campaign'?'campaign':'adset', action:r.action,
    pct:r.action==='pause'?0:Math.max(1, Math.min(50, Math.round(n(r.pct, 50)||20)))};
}

const WON_STAGES=new Set(['won','converted','consultation_booked','visit_booked','appt_booked']);

/* ── Pure helpers (exported for tests; frontend/ads-report.js mirrors the attribution rules) ── */

export function marSettings(raw){
  let s=raw; if(typeof s==='string'){ try{ s=JSON.parse(s||'{}'); }catch(e){ s={}; } }
  s=s&&typeof s==='object'?s:{};
  const num=(v,max)=>{ const n=Number(v); return Number.isFinite(n)&&n>0?Math.min(n,max):0; };
  const list=(v,re)=>[...new Set((Array.isArray(v)?v:String(v||'').split(/[,\s]+/)).map(x=>String(x).trim().toLowerCase()).filter(x=>re.test(x)))].slice(0,20);
  return {
    summary_enabled:s.summary_enabled===true,
    summary_staff:list(s.summary_staff, /^[^@\s]+@[^@\s]+$/),
    summary_emails:list(s.summary_emails, /^[^@\s]+@[^@\s]+\.[^@\s]+$/),
    summary_template:String(s.summary_template||'').trim().replace(/[^a-z0-9_]/gi,'').slice(0,120),
    summary_template_lang:String(s.summary_template_lang||'en').trim().slice(0,10)||'en',
    alerts_enabled:s.alerts_enabled===true,
    alert_spend_no_leads:num(s.alert_spend_no_leads, 1e9),
    alert_cpl_max:num(s.alert_cpl_max, 1e9),
    alert_junk_pct:num(s.alert_junk_pct, 100),
    accounting_post:s.accounting_post===true,
    purchase_labels:s.purchase_labels===undefined?[...MAR_DEFAULTS.purchase_labels]
      :(Array.isArray(s.purchase_labels)?s.purchase_labels:String(s.purchase_labels||'').split(','))
        .map(x=>String(x).trim().slice(0,40)).filter((x,i,a)=>x && a.findIndex(y=>y.toLowerCase()===x.toLowerCase())===i).slice(0,10),
    funnel_map:Object.fromEntries(Object.entries(s.funnel_map&&typeof s.funnel_map==='object'?s.funnel_map:{})
      .map(([k,v])=>[String(k).trim().slice(0,60), String(v||'').replace(/[^A-Za-z0-9_ ]/g,'').trim().slice(0,40)]).filter(([k,v])=>k&&v).slice(0,30)),
    send_junk:s.send_junk!==false,
    pixel_consent_banner:s.pixel_consent_banner===true,
    audiences_enabled:s.audiences_enabled===true,
    audience_country:/^[A-Za-z]{2}$/.test(String(s.audience_country||''))?String(s.audience_country).toUpperCase():'IN',
    audience_ratio:Math.max(1, Math.min(10, Math.round(Number(s.audience_ratio)||1))),
    rules:(Array.isArray(s.rules)?s.rules:[]).map(marRule).filter(Boolean).slice(0,20),
    capacity_guard:{enabled:s.capacity_guard?.enabled===true, max_uncalled:Math.max(1, Math.min(1000, Math.round(Number(s.capacity_guard?.max_uncalled)||20))),
      pct:Math.max(5, Math.min(50, Math.round(Number(s.capacity_guard?.pct)||20)))},
    max_change_pct:Math.max(5, Math.min(50, Math.round(Number(s.max_change_pct)||30))),
    min_daily_budget:num(s.min_daily_budget, 1e9),
  };
}
// The funnel part of the settings, for worker.js capiFunnelFromStages (no settings row → defaults).
export async function marCapiFunnelSettings(env, cid){
  try{
    if(!await marEnsureSchema(env)) return {funnel_map:{}, send_junk:true};
    const cfg=marSettings((await getState(env, cid))?.config_json);
    return {funnel_map:cfg.funnel_map, send_junk:cfg.send_junk};
  }catch(e){ return {funnel_map:{}, send_junk:true}; }
}
// What a public LeadVyne page (store, order, booking) needs to load the Pixel. Pixel ids are public.
export async function marPublicPixel(env, c){
  const id=String(c?.meta_pixel_id||'').trim();
  if(!/^\d{5,25}$/.test(id)) return {meta_pixel_id:''};
  let consent=false;
  try{ if(await marEnsureSchema(env)) consent=marSettings((await getState(env, c.Id))?.config_json).pixel_consent_banner; }catch(e){}
  return {meta_pixel_id:id, pixel_consent_banner:consent};
}
// Does a lead's Tags ("Hot, Order placed") carry one of the purchase labels? Case-insensitive, whole label.
export function marHasPurchaseLabel(tags, labels){
  const have=new Set(String(tags||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean));
  return (labels||[]).some(l=>have.has(String(l).trim().toLowerCase()));
}
// The account's purchase labels, without creating a settings row (defaults when there's none).
export async function marPurchaseLabels(env, cid){
  try{
    if(!await marEnsureSchema(env)) return [...MAR_DEFAULTS.purchase_labels];
    const st=await getState(env, cid);
    return marSettings(st?.config_json).purchase_labels;
  }catch(e){ return [...MAR_DEFAULTS.purchase_labels]; }
}

// Meta reports a lead under several action types; 'lead' is already the total when present.
export function marActionCount(actions, types){
  const list=Array.isArray(actions)?actions:[];
  for(const t of types){ const a=list.find(x=>x?.action_type===t); if(a) return Math.round(Number(a.value)||0); }
  return 0;
}
const LEAD_ACTIONS=['lead','onsite_conversion.lead_grouped','offsite_conversion.fb_pixel_lead'];
const CHAT_ACTIONS=['onsite_conversion.messaging_conversation_started_7d'];
export function marInsightRow(r, currency){
  return {
    day:String(r.date_start||'').slice(0,10), ad_id:String(r.ad_id||''), ad_name:String(r.ad_name||'').slice(0,300),
    adset_id:String(r.adset_id||''), adset_name:String(r.adset_name||'').slice(0,300),
    campaign_id:String(r.campaign_id||''), campaign_name:String(r.campaign_name||'').slice(0,300),
    spend:Math.round((Number(r.spend)||0)*100)/100, impressions:Math.round(Number(r.impressions)||0), clicks:Math.round(Number(r.clicks)||0),
    meta_leads:marActionCount(r.actions, LEAD_ACTIONS), meta_chats:marActionCount(r.actions, CHAT_ACTIONS),
    currency:String(r.account_currency||currency||'').toUpperCase().slice(0,10),
  };
}

// Where a lead says it came from. isAd: any sign it came from a Meta ad (ids, click id, lead form,
// or a Source/LeadSource that names an ad). Older click-to-WhatsApp leads only kept the ad id inside
// AdCampaign ("Ad ID 1202…") — read it back from there.
// An ad code typed into a click-to-WhatsApp ad's pre-filled message — "Hi, I want the Kerala offer
// #K26" — and the same "#K26" in the ad's (or ad set's / campaign's) name in Ads Manager ties the chat
// to that ad even when Meta's referral never reaches us. 2–12 letters/digits with at least one
// letter, so "#1" or a price isn't taken for a code. Lower-cased.
export function marAdCode(text){
  const m=String(text||'').match(/(?:^|[^\w#])#([a-z0-9]{2,12})(?![\w])/i);
  return m && /[a-z]/i.test(m[1]) ? m[1].toLowerCase() : '';
}
export function marLeadAdRef(lead){
  const camp=String(lead?.AdCampaign||'').trim();
  const legacyId=(camp.match(/^Ad ID (\d{5,25})$/)||[])[1]||'';
  const adId=String(lead?.AdId||'').trim()||legacyId;
  const campaignId=String(lead?.CampaignId||'').trim();
  const src=`${lead?.LeadSource||''} ${lead?.Source||''}`;
  const adCode=String(lead?.AdCode||'').trim().toLowerCase().replace(/^#/,'');
  const isAd=!!(adId||campaignId||adCode||String(lead?.CtwaClid||'').trim()||String(lead?.MetaLeadgenId||'').trim()
    ||/lead ad|lead form|click-to-whatsapp|\b(meta|facebook|instagram|fb|ig) ads?\b/i.test(src));
  return {isAd, adId, campaignId, adCode, campaignName:legacyId?'':camp, adName:String(lead?.AdName||'').trim()};
}
// ads: synced ad rows ({ad_id, adset_id, campaign_id, campaign_name}). Returns a lookup used by marMatchLead.
export function marAdIndex(ads){
  const byAd=new Map(), byCampaign=new Map(), byCampaignName=new Map(), byCode=new Map();
  for(const a of ads||[]){
    if(a.ad_id) byAd.set(String(a.ad_id), a);
    for(const code of new Set([a.ad_name, a.adset_name, a.campaign_name].map(marAdCode).filter(Boolean))){
      if(!byCode.has(code)) byCode.set(code, []);
      byCode.get(code).push(a);
    }
    if(a.campaign_id){
      byCampaign.set(String(a.campaign_id), a);
      const n=String(a.campaign_name||'').trim().toLowerCase(); if(n && !byCampaignName.has(n)) byCampaignName.set(n, String(a.campaign_id));
    }
  }
  return {byAd, byCampaign, byCampaignName, byCode};
}
// → null (not an ad lead) | {campaign_id, adset_id, ad_id} — ids are '' when an ad lead can't be
// matched to synced spend (shown as "Ad leads not matched to a campaign").
export function marMatchLead(lead, index){
  const ref=marLeadAdRef(lead);
  if(!ref.isAd) return null;
  const ad=ref.adId&&index.byAd.get(ref.adId);
  if(ad) return {campaign_id:String(ad.campaign_id||''), adset_id:String(ad.adset_id||''), ad_id:String(ad.ad_id)};
  if(ref.campaignId && index.byCampaign.has(ref.campaignId)) return {campaign_id:ref.campaignId, adset_id:'', ad_id:''};
  // An ad code: the one ad carrying it, else the campaign (or ad set) all its ads share.
  const coded=ref.adCode && index.byCode?.get(ref.adCode);
  if(coded?.length){
    const one=k=>new Set(coded.map(a=>String(a[k]||''))).size===1;
    return {campaign_id:one('campaign_id')?String(coded[0].campaign_id||''):'', adset_id:one('adset_id')?String(coded[0].adset_id||''):'', ad_id:coded.length===1?String(coded[0].ad_id):''};
  }
  const byName=ref.campaignName && index.byCampaignName.get(ref.campaignName.toLowerCase());
  if(byName) return {campaign_id:byName, adset_id:'', ad_id:''};
  return {campaign_id:'', adset_id:'', ad_id:''};
}

export function marIsWon(lead){ return WON_STAGES.has(String(lead?.Stage||'')); }
export function marIsJunk(lead){ return String(lead?.HandoverOutcome||'')==='Spam'; }
export function marIsQualified(lead){ return String(lead?.Score||'')==='Hot' || marIsWon(lead); }
function parseTs(v){ if(!v) return NaN; const s=String(v).trim(); return Date.parse(/^\d{4}-\d{2}-\d{2} \d/.test(s)?s.replace(' ','T'):s); }
// When a lead arrived. NocoDB's own CreatedAt first: the bot rewrites Date on every message turn.
export function marLeadArrivedMs(lead){ const c=parseTs(lead?.CreatedAt); return Number.isFinite(c)?c:parseTs(lead?.Date); }
// YYYY-MM-DD of a timestamp in the ad account's timezone (offset in minutes east of UTC).
export function marDay(ms, tzMin=0){ return Number.isFinite(ms)?new Date(ms+tzMin*60000).toISOString().slice(0,10):''; }
export function marAddDays(day, n){ const d=new Date(day+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }

export function marMoney(n, ccy){
  const v=Math.round(Number(n)||0).toLocaleString('en-IN');
  const c=String(ccy||'').toUpperCase();
  return c==='INR'?'₹'+v:c==='USD'?'$'+v:(c?c+' ':'')+v;
}

// Yesterday (or any `day`) for one account, from the synced ad rows and the CRM's recent leads.
// ads: meta_ads_daily rows for `day`; leads: recent leads (arrived since day-7, plus any closed on
// `day`); index: marAdIndex over every synced ad. Pure — the cron and the "send test" button share it.
export function marDaySummary({day, ads, leads, index, tzMin=0, currency='', cfg=MAR_DEFAULTS, syncError='', capi=null}){
  const camp=new Map();
  const C=id=>{ if(!camp.has(id)){ const a=index.byCampaign.get(id); camp.set(id, {id, name:id?(a?.campaign_name||'Campaign '+id):'Not matched to a campaign', spend:0, metaLeads:0, leads:0, junk7:0, leads7:0}); } return camp.get(id); };
  let spend=0, metaLeads=0;
  for(const a of ads||[]){ spend+=Number(a.spend)||0; const m=(Number(a.meta_leads)||0)+(Number(a.meta_chats)||0); metaLeads+=m; const c=C(String(a.campaign_id||'')); c.spend+=Number(a.spend)||0; c.metaLeads+=m; }
  const weekFrom=marAddDays(day, -6);
  let adLeads=0, qualified=0, junk=0, sales=0, revenue=0; const dealCcys=new Set();
  for(const l of leads||[]){
    const m=marMatchLead(l, index); if(!m) continue;
    const arrived=marDay(marLeadArrivedMs(l), tzMin);
    if(arrived>=weekFrom && arrived<=day){ const c=C(m.campaign_id); c.leads7++; if(marIsJunk(l)) c.junk7++; }
    if(arrived===day){ adLeads++; C(m.campaign_id).leads++; if(marIsQualified(l)) qualified++; if(marIsJunk(l)) junk++; }
    const closed=marDay(parseTs(l.ClosedAt), tzMin);
    if(marIsWon(l) && closed===day){ sales++; revenue+=Number(l.DealValue)||0; if(l.DealCurrency) dealCcys.add(String(l.DealCurrency).toUpperCase()); }
  }
  // ROAS only when sales and spend are in the same currency (or the deal currency was never set).
  const sameCcy=!dealCcys.size || (dealCcys.size===1 && dealCcys.has(String(currency).toUpperCase()));
  const roas=spend>0 && revenue>0 && sameCcy ? revenue/spend : null;
  const campaigns=[...camp.values()].filter(c=>c.spend>0||c.leads>0).sort((a,b)=>b.spend-a.spend);
  const alerts=[];
  if(cfg.alerts_enabled){
    if(syncError) alerts.push({kind:'sync', text:`Meta connection failed — spend may be out of date (${String(syncError).slice(0,120)})`});
    for(const c of campaigns){
      if(!c.id) continue;
      if(cfg.alert_spend_no_leads && c.spend>=cfg.alert_spend_no_leads && c.leads===0 && c.metaLeads===0)
        alerts.push({kind:'no_leads', campaign:c.name, text:`"${c.name}" spent ${marMoney(c.spend, currency)} with no leads`});
      else if(cfg.alert_cpl_max && c.leads>0 && c.spend/c.leads>cfg.alert_cpl_max)
        alerts.push({kind:'cpl', campaign:c.name, text:`"${c.name}" cost ${marMoney(c.spend/c.leads, currency)} per lead (limit ${marMoney(cfg.alert_cpl_max, currency)})`});
    }
    if(capi?.failed) alerts.push({kind:'capi', text:`Meta refused ${capi.failed} Conversions API event${capi.failed===1?'':'s'} (${String(capi.error||'').slice(0,100)}) — see Ads ROI → Tracking health`});
    else if(capi && !capi.sent3d && adLeads>0) alerts.push({kind:'capi', text:'No events have reached Meta for 3 days although ads bring leads — check the Pixel/Dataset and token in Integrations → Meta Ads'});
    if(cfg.alert_junk_pct) for(const c of camp.values()){
      if(c.id && c.leads7>=5 && c.junk7/c.leads7*100>=cfg.alert_junk_pct)
        alerts.push({kind:'junk', campaign:c.name, text:`"${c.name}": ${Math.round(c.junk7/c.leads7*100)}% of last 7 days' leads were junk (${c.junk7}/${c.leads7})`});
    }
  }
  const top=campaigns.filter(c=>c.id&&c.leads>0).sort((a,b)=>b.leads-a.leads)[0]||null;
  return {day, currency, spend, metaLeads, adLeads, qualified, junk, sales, revenue, roas,
    cpl:adLeads?spend/adLeads:null, costPerSale:sales?spend/sales:null, top, campaigns, alerts};
}

export function marSummaryText(s, businessName){
  const dl=new Date(s.day+'T00:00:00Z').toLocaleDateString('en-GB', {weekday:'short', day:'numeric', month:'short', timeZone:'UTC'});
  const m=n=>marMoney(n, s.currency);
  const lines=[`📊 Ads summary — ${dl}${businessName?` (${businessName})`:''}`,
    `Spend: ${m(s.spend)} · Meta counted ${s.metaLeads} lead${s.metaLeads===1?'':'s'}`,
    `Leads from ads: ${s.adLeads} · Qualified: ${s.qualified} · Junk: ${s.junk}`,
    `Sales: ${s.sales} · Revenue: ${m(s.revenue)}${s.roas!=null?` · ROAS ${s.roas.toFixed(1)}×`:''}`];
  const costs=[s.cpl!=null?`Cost/lead ${m(s.cpl)}`:'', s.costPerSale!=null?`Cost/sale ${m(s.costPerSale)}`:''].filter(Boolean);
  if(costs.length) lines.push(costs.join(' · '));
  if(s.top) lines.push(`Top campaign: ${s.top.name} — ${s.top.leads} lead${s.top.leads===1?'':'s'}, ${m(s.top.spend)}`);
  if(s.alerts.length) lines.push('', '⚠️ Needs attention:', ...s.alerts.map(a=>'• '+a.text));
  return lines.join('\n');
}
// WhatsApp template body params can't hold newlines/tabs or 4+ spaces in a row.
export function marTemplateParams(s, businessName){
  const one=t=>String(t||'-').replace(/[\n\t]+/g,' · ').replace(/ {4,}/g,'   ').slice(0,900)||'-';
  const body=marSummaryText(s, '').split('\n').slice(1).filter(Boolean);
  return [one(businessName||'Your business'), one(new Date(s.day+'T00:00:00Z').toLocaleDateString('en-GB', {day:'numeric', month:'short', timeZone:'UTC'})), one(body.join(' · '))];
}

/* ── Storage ── */
let _schemaOk=false;
export async function marEnsureSchema(env){
  if(_schemaOk) return true;
  if(!env?.DB) return false;
  try{
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS meta_ads_daily (client_id INTEGER NOT NULL, day TEXT NOT NULL, ad_id TEXT NOT NULL, ad_name TEXT, adset_id TEXT, adset_name TEXT, campaign_id TEXT, campaign_name TEXT, spend REAL NOT NULL DEFAULT 0, impressions INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0, meta_leads INTEGER NOT NULL DEFAULT 0, meta_chats INTEGER NOT NULL DEFAULT 0, currency TEXT, synced_at TEXT, PRIMARY KEY (client_id, day, ad_id))`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS meta_ads_report_state (client_id INTEGER PRIMARY KEY, config_json TEXT NOT NULL DEFAULT '{}', account_name TEXT, currency TEXT, tz_offset_min INTEGER NOT NULL DEFAULT 0, backfilled_from TEXT, last_attempt_at TEXT, last_ok_at TEXT, last_error TEXT, last_daily_day TEXT, updated_at TEXT)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS meta_ads_report_sends (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, kind TEXT NOT NULL, day TEXT NOT NULL, recipient TEXT, status TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL)`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_meta_ads_report_sends_client ON meta_ads_report_sends(client_id, day)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS meta_ads_expense_posts (client_id INTEGER NOT NULL, month TEXT NOT NULL, expense_id INTEGER, amount REAL NOT NULL DEFAULT 0, currency TEXT, status TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (client_id, month))`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS meta_ads_hourly (client_id INTEGER NOT NULL, day TEXT NOT NULL, hour INTEGER NOT NULL, ad_id TEXT NOT NULL, spend REAL NOT NULL DEFAULT 0, meta_leads INTEGER NOT NULL DEFAULT 0, meta_chats INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (client_id, day, hour, ad_id))`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS meta_ads_ads (client_id INTEGER NOT NULL, ad_id TEXT NOT NULL, ad_name TEXT, adset_id TEXT, adset_name TEXT, campaign_id TEXT, campaign_name TEXT, status TEXT, adset_status TEXT, campaign_status TEXT, headline TEXT, body TEXT, updated_at TEXT, PRIMARY KEY (client_id, ad_id))`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS meta_ads_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, at TEXT NOT NULL, day TEXT NOT NULL, ad_id TEXT, ad_name TEXT, campaign_name TEXT, kind TEXT NOT NULL, detail TEXT)`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_meta_ads_changes_client ON meta_ads_changes(client_id, day)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS meta_capi_errors (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, event TEXT NOT NULL, lead_id INTEGER, code TEXT, error TEXT, at TEXT NOT NULL)`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_meta_capi_errors_client ON meta_capi_errors(client_id, at)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS meta_ads_audiences (client_id INTEGER NOT NULL, key TEXT NOT NULL, audience_id TEXT, lookalike_id TEXT, size INTEGER NOT NULL DEFAULT 0, last_run_at TEXT, last_error TEXT, PRIMARY KEY (client_id, key))`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS meta_ads_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, at TEXT NOT NULL, actor TEXT, target_type TEXT NOT NULL, target_id TEXT NOT NULL, target_name TEXT, action TEXT NOT NULL, before_json TEXT, after_json TEXT, reason TEXT, status TEXT NOT NULL, error TEXT, undone_at TEXT)`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_meta_ads_actions_client ON meta_ads_actions(client_id, at)`),
    ]);
    // Budgets arrived after meta_ads_ads (migrations/0122) — add them to an older table.
    for(const col of ['adset_budget REAL','campaign_budget REAL']){
      try{ await env.DB.prepare(`ALTER TABLE meta_ads_ads ADD COLUMN ${col}`).run(); }catch(e){}
    }
    _schemaOk=true;
  }catch(e){ console.error('[ads-report] schema', e.message); }
  return _schemaOk;
}
async function getState(env, cid){
  return await env.DB.prepare(`SELECT * FROM meta_ads_report_state WHERE client_id=?`).bind(Number(cid)).first()||null;
}
async function ensureState(env, cid){
  await env.DB.prepare(`INSERT OR IGNORE INTO meta_ads_report_state (client_id, config_json, updated_at) VALUES (?, '{}', ?)`).bind(Number(cid), new Date().toISOString()).run();
  return getState(env, cid);
}
async function patchState(env, cid, fields){
  const keys=Object.keys(fields); if(!keys.length) return;
  await env.DB.prepare(`UPDATE meta_ads_report_state SET ${keys.map(k=>k+'=?').join(', ')}, updated_at=? WHERE client_id=?`)
    .bind(...keys.map(k=>fields[k]), new Date().toISOString(), Number(cid)).run();
}

/* ── Spend sync (Ads Insights → meta_ads_daily) ── */
export function marConnected(c){ return !!(c?.meta_ad_account_id && c?.meta_capi_token); }
function acctPath(c){ return `act_${String(c.meta_ad_account_id||'').trim().replace(/^act_/,'')}`; }
async function graphGet(url){
  const r=await fetch(url, {signal:AbortSignal.timeout?.(25000)});
  const data=await r.json().catch(()=>({}));
  return {ok:r.ok, status:r.status, data};
}
function graphErr(res, what){
  const e=res.data?.error||{};
  const m=e.message||'HTTP '+res.status;
  if(e.code===190||/access token/i.test(m))
    return new Error(`The Meta token in Settings → Integrations → Meta Ads isn't valid (${m}). Paste a fresh System User token with ads_read there and Save.`);
  return new Error(/permission|ads_read|\(#(200|10|272)\)/i.test(m)?`${what}: ${m} — the token needs the ads_read permission on this ad account.`:`${what}: ${m}`);
}

export async function marSync(env, c, {days=MAR_DAILY_DAYS}={}){
  const cid=Number(c.Id);
  await marEnsureSchema(env);
  await ensureState(env, cid);
  const now=new Date().toISOString();
  if(!marConnected(c)){ await patchState(env, cid, {last_attempt_at:now, last_error:'Not connected'}); return {ok:false, error:'not-connected'}; }
  await patchState(env, cid, {last_attempt_at:now});
  try{
    const token=encodeURIComponent(c.meta_capi_token);
    const acct=await graphGet(`${GRAPH}/${acctPath(c)}?fields=name,currency,timezone_offset_hours_utc&access_token=${token}`);
    if(!acct.ok) throw graphErr(acct, 'Meta rejected the ad account');
    const tzMin=Math.round((Number(acct.data.timezone_offset_hours_utc)||0)*60);
    const currency=String(acct.data.currency||'').toUpperCase();
    const until=marDay(Date.now(), tzMin);
    const since=marAddDays(until, -(Math.max(1, Math.min(400, days))-1));
    const qs=new URLSearchParams({level:'ad', time_increment:'1', limit:'500',
      fields:'ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,spend,impressions,clicks,actions,account_currency',
      time_range:JSON.stringify({since, until})});
    let url=`${GRAPH}/${acctPath(c)}/insights?${qs}&access_token=${token}`;
    const rows=[];
    for(let page=0; url && page<60; page++){
      const res=await graphGet(url);
      if(!res.ok) throw graphErr(res, 'Meta rejected the spend request');
      for(const r of res.data?.data||[]){ const row=marInsightRow(r, currency); if(row.day && row.ad_id) rows.push(row); }
      url=res.data?.paging?.next||'';
    }
    // Replace the window in one batch (a restated day can lose an ad entirely). One INSERT per 200
    // rows via json_each — D1 caps bound parameters per statement, not their size.
    const stmts=[env.DB.prepare(`DELETE FROM meta_ads_daily WHERE client_id=? AND day>=? AND day<=?`).bind(cid, since, until)];
    for(let i=0; i<rows.length; i+=200){
      stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO meta_ads_daily (client_id, day, ad_id, ad_name, adset_id, adset_name, campaign_id, campaign_name, spend, impressions, clicks, meta_leads, meta_chats, currency, synced_at)
        SELECT ?, json_extract(j.value,'$.day'), json_extract(j.value,'$.ad_id'), json_extract(j.value,'$.ad_name'), json_extract(j.value,'$.adset_id'), json_extract(j.value,'$.adset_name'),
          json_extract(j.value,'$.campaign_id'), json_extract(j.value,'$.campaign_name'), json_extract(j.value,'$.spend'), json_extract(j.value,'$.impressions'), json_extract(j.value,'$.clicks'),
          json_extract(j.value,'$.meta_leads'), json_extract(j.value,'$.meta_chats'), json_extract(j.value,'$.currency'), ? FROM json_each(?) j`).bind(cid, now, JSON.stringify(rows.slice(i, i+200))));
    }
    await env.DB.batch(stmts);
    // Extras for "which ads ran when" and time-window attribution. Each is best-effort: a failure
    // here keeps the day totals above and is reported as a warning, not a failed sync.
    const warnings=[];
    const hourSince=marAddDays(until, -(Math.max(1, Math.min(MAR_HOURLY_DAYS, days))-1));
    const hourly=await marSyncHourly(env, c, token, cid, hourSince, until).catch(e=>{ warnings.push('Hourly breakdown: '+e.message); return null; });
    const ads=await marSyncAds(env, c, token, cid, until).catch(e=>{ warnings.push('Ad details: '+e.message); return null; });
    const st=await getState(env, cid);
    await patchState(env, cid, {last_ok_at:now, last_error:null, currency, tz_offset_min:tzMin, account_name:String(acct.data.name||'').slice(0,200),
      backfilled_from:!st?.backfilled_from||since<st.backfilled_from?since:st.backfilled_from});
    return {ok:true, rows:rows.length, since, until, currency, hourly_rows:hourly?.rows??null, ads:ads?.ads??null, changes:ads?.changes??null, warnings};
  }catch(e){
    await patchState(env, cid, {last_error:String(e.message||e).slice(0,500)});
    return {ok:false, error:String(e.message||e)};
  }
}
// Meta's hourly breakdown ("00:00:00 - 00:59:59", account timezone) → meta_ads_hourly, so a lead
// can be matched to the ads that were actually running in the hour it arrived.
export function marHourOf(v){ const m=String(v||'').match(/^(\d{1,2}):/); const h=m?Number(m[1]):NaN; return h>=0&&h<24?h:null; }
async function marSyncHourly(env, c, token, cid, since, until){
  const qs=new URLSearchParams({level:'ad', time_increment:'1', limit:'500', breakdowns:'hourly_stats_aggregated_by_advertiser_time_zone',
    fields:'ad_id,spend,actions', time_range:JSON.stringify({since, until})});
  let url=`${GRAPH}/${acctPath(c)}/insights?${qs}&access_token=${token}`;
  const rows=[];
  for(let page=0; url && page<80; page++){
    const res=await graphGet(url);
    if(!res.ok) throw graphErr(res, 'Meta rejected the hourly request');
    for(const r of res.data?.data||[]){
      const hour=marHourOf(r.hourly_stats_aggregated_by_advertiser_time_zone);
      const row={day:String(r.date_start||'').slice(0,10), hour, ad_id:String(r.ad_id||''), spend:Math.round((Number(r.spend)||0)*100)/100,
        meta_leads:marActionCount(r.actions, LEAD_ACTIONS), meta_chats:marActionCount(r.actions, CHAT_ACTIONS)};
      if(row.day && row.ad_id && hour!=null && (row.spend>0||row.meta_leads||row.meta_chats)) rows.push(row);
    }
    url=res.data?.paging?.next||'';
  }
  const stmts=[env.DB.prepare(`DELETE FROM meta_ads_hourly WHERE client_id=? AND day>=? AND day<=?`).bind(cid, since, until),
    env.DB.prepare(`DELETE FROM meta_ads_hourly WHERE client_id=? AND day<?`).bind(cid, marAddDays(until, -MAR_HOURLY_DAYS-7))];
  for(let i=0; i<rows.length; i+=300){
    stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO meta_ads_hourly (client_id, day, hour, ad_id, spend, meta_leads, meta_chats)
      SELECT ?, json_extract(j.value,'$.day'), json_extract(j.value,'$.hour'), json_extract(j.value,'$.ad_id'), json_extract(j.value,'$.spend'),
        json_extract(j.value,'$.meta_leads'), json_extract(j.value,'$.meta_chats') FROM json_each(?) j`).bind(cid, JSON.stringify(rows.slice(i, i+300))));
  }
  await env.DB.batch(stmts);
  return {rows:rows.length};
}
// Every ad's current status, ad set / campaign, headline and text → meta_ads_ads. A status that
// changed since the last sync (or a new ad) goes to meta_ads_changes — "what changed" in the report.
export function marAdRow(a){
  const cr=a.creative||{};
  return {ad_id:String(a.id||''), ad_name:String(a.name||'').slice(0,300),
    adset_id:String(a.adset?.id||a.adset_id||''), adset_name:String(a.adset?.name||'').slice(0,300),
    campaign_id:String(a.campaign?.id||a.campaign_id||''), campaign_name:String(a.campaign?.name||'').slice(0,300),
    status:String(a.effective_status||'').toUpperCase(), adset_status:String(a.adset?.effective_status||'').toUpperCase(), campaign_status:String(a.campaign?.effective_status||'').toUpperCase(),
    headline:String(cr.title||'').slice(0,300), body:String(cr.body||'').slice(0,1000),
    // Daily budgets come in the account's minor unit (paise/cents); 0 = none at that level.
    adset_budget:Math.round(Number(a.adset?.daily_budget)||0)/100, campaign_budget:Math.round(Number(a.campaign?.daily_budget)||0)/100};
}
async function marSyncAds(env, c, token, cid, today){
  const qs=new URLSearchParams({limit:'200', fields:'id,name,effective_status,adset{id,name,effective_status,daily_budget},campaign{id,name,effective_status,daily_budget},creative{title,body}'});
  let url=`${GRAPH}/${acctPath(c)}/ads?${qs}&access_token=${token}`;
  const ads=[];
  for(let page=0; url && page<25; page++){
    const res=await graphGet(url);
    if(!res.ok) throw graphErr(res, 'Meta rejected the ads list');
    for(const a of res.data?.data||[]){ const row=marAdRow(a); if(row.ad_id) ads.push(row); }
    url=res.data?.paging?.next||'';
  }
  const {results:prev}=await env.DB.prepare(`SELECT ad_id, status FROM meta_ads_ads WHERE client_id=?`).bind(cid).all();
  const before=new Map((prev||[]).map(r=>[String(r.ad_id), String(r.status||'')]));
  const now=new Date().toISOString();
  const changes=[];
  if(before.size) for(const a of ads){
    const was=before.get(a.ad_id);
    if(was===undefined) changes.push({ad:a, kind:'new', detail:`New ad (${marStatusLabel(a.status)})`});
    else if(was!==a.status) changes.push({ad:a, kind:'status', detail:`${marStatusLabel(was)} → ${marStatusLabel(a.status)}`});
  }
  const stmts=[];
  for(let i=0; i<ads.length; i+=150){
    stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO meta_ads_ads (client_id, ad_id, ad_name, adset_id, adset_name, campaign_id, campaign_name, status, adset_status, campaign_status, headline, body, adset_budget, campaign_budget, updated_at)
      SELECT ?, json_extract(j.value,'$.ad_id'), json_extract(j.value,'$.ad_name'), json_extract(j.value,'$.adset_id'), json_extract(j.value,'$.adset_name'),
        json_extract(j.value,'$.campaign_id'), json_extract(j.value,'$.campaign_name'), json_extract(j.value,'$.status'), json_extract(j.value,'$.adset_status'),
        json_extract(j.value,'$.campaign_status'), json_extract(j.value,'$.headline'), json_extract(j.value,'$.body'), json_extract(j.value,'$.adset_budget'),
        json_extract(j.value,'$.campaign_budget'), ? FROM json_each(?) j`).bind(cid, now, JSON.stringify(ads.slice(i, i+150))));
  }
  for(const ch of changes) stmts.push(env.DB.prepare(`INSERT INTO meta_ads_changes (client_id, at, day, ad_id, ad_name, campaign_name, kind, detail) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(cid, now, today, ch.ad.ad_id, ch.ad.ad_name, ch.ad.campaign_name, ch.kind, ch.detail));
  if(stmts.length) await env.DB.batch(stmts);
  return {ads:ads.length, changes:changes.length};
}
export function marStatusLabel(s){
  const m={ACTIVE:'Active', PAUSED:'Paused', CAMPAIGN_PAUSED:'Campaign paused', ADSET_PAUSED:'Ad set paused', PENDING_REVIEW:'In review', IN_PROCESS:'Processing',
    DISAPPROVED:'Rejected', WITH_ISSUES:'With issues', ARCHIVED:'Archived', DELETED:'Deleted', PREAPPROVED:'Pre-approved', PENDING_BILLING_INFO:'Billing info needed'};
  return m[String(s||'').toUpperCase()]||String(s||'Unknown');
}

// Sync when the data is stale — first use backfills MAR_BACKFILL_DAYS.
async function syncIfStale(env, c, st){
  if(!marConnected(c)) return null;
  const now=Date.now();
  if(st?.last_ok_at && now-Date.parse(st.last_ok_at)<MAR_STALE_MS) return null;
  if(st?.last_attempt_at && st?.last_error && now-Date.parse(st.last_attempt_at)<MAR_RETRY_MS) return null;
  return marSync(env, c, {days:st?.backfilled_from?MAR_DAILY_DAYS:MAR_BACKFILL_DAYS});
}

/* ── Report data ── */
const DAY_RE=/^\d{4}-\d{2}-\d{2}$/;
export async function marReportData(env, cid, from, to){
  const {results:ads}=await env.DB.prepare(`SELECT ad_id, MAX(ad_name) ad_name, MAX(adset_id) adset_id, MAX(adset_name) adset_name, MAX(campaign_id) campaign_id, MAX(campaign_name) campaign_name,
      SUM(CASE WHEN day>=?1 AND day<=?2 THEN spend ELSE 0 END) spend, SUM(CASE WHEN day>=?1 AND day<=?2 THEN impressions ELSE 0 END) impressions,
      SUM(CASE WHEN day>=?1 AND day<=?2 THEN clicks ELSE 0 END) clicks, SUM(CASE WHEN day>=?1 AND day<=?2 THEN meta_leads ELSE 0 END) meta_leads,
      SUM(CASE WHEN day>=?1 AND day<=?2 THEN meta_chats ELSE 0 END) meta_chats
    FROM meta_ads_daily WHERE client_id=?3 GROUP BY ad_id`).bind(from, to, Number(cid)).all();
  const {results:days}=await env.DB.prepare(`SELECT day, SUM(spend) spend, SUM(meta_leads) meta_leads, SUM(meta_chats) meta_chats FROM meta_ads_daily WHERE client_id=? AND day>=? AND day<=? GROUP BY day ORDER BY day`)
    .bind(Number(cid), from, to).all();
  const r2=n=>Math.round((Number(n)||0)*100)/100;
  // Per ad per day (timeline, fatigue, day shares) and per ad per hour (time-window attribution).
  const {results:adDays}=await env.DB.prepare(`SELECT day, ad_id, spend, meta_leads, meta_chats FROM meta_ads_daily WHERE client_id=? AND day>=? AND day<=? AND (spend>0 OR meta_leads>0 OR meta_chats>0) ORDER BY day`)
    .bind(Number(cid), from, to).all();
  const {results:hours}=await env.DB.prepare(`SELECT day, hour, ad_id, spend, meta_leads, meta_chats FROM meta_ads_hourly WHERE client_id=? AND day>=? AND day<=?`)
    .bind(Number(cid), from, to).all();
  const hourlyFrom=(await env.DB.prepare(`SELECT MIN(day) d FROM meta_ads_hourly WHERE client_id=?`).bind(Number(cid)).first())?.d||'';
  const {results:meta}=await env.DB.prepare(`SELECT ad_id, ad_name, adset_id, adset_name, campaign_id, campaign_name, status, adset_status, campaign_status, headline, body, adset_budget, campaign_budget FROM meta_ads_ads WHERE client_id=?`).bind(Number(cid)).all();
  const {results:changes}=await env.DB.prepare(`SELECT at, day, ad_id, ad_name, campaign_name, kind, detail FROM meta_ads_changes WHERE client_id=? AND day>=? AND day<=? ORDER BY at DESC LIMIT 200`)
    .bind(Number(cid), from, to).all();
  const metaById=new Map((meta||[]).map(m=>[String(m.ad_id), m]));
  return {
    ads:(ads||[]).map(a=>{ const m=metaById.get(String(a.ad_id))||{};
      return {...a, spend:r2(a.spend), impressions:Number(a.impressions)||0, clicks:Number(a.clicks)||0, meta_leads:Number(a.meta_leads)||0, meta_chats:Number(a.meta_chats)||0,
        status:m.status||'', adset_status:m.adset_status||'', campaign_status:m.campaign_status||'', headline:m.headline||'', body:m.body||'',
        adset_budget:Number(m.adset_budget)||0, campaign_budget:Number(m.campaign_budget)||0}; }),
    days:(days||[]).map(d=>({day:d.day, spend:r2(d.spend), meta_leads:Number(d.meta_leads)||0, meta_chats:Number(d.meta_chats)||0})),
    ad_days:(adDays||[]).map(d=>({day:d.day, ad_id:String(d.ad_id), spend:r2(d.spend), meta_leads:Number(d.meta_leads)||0, meta_chats:Number(d.meta_chats)||0})),
    hours:(hours||[]).map(h=>({day:h.day, hour:Number(h.hour), ad_id:String(h.ad_id), spend:r2(h.spend), meta_leads:Number(h.meta_leads)||0, meta_chats:Number(h.meta_chats)||0})),
    hourly_from:hourlyFrom,
    changes:changes||[],
  };
}
// Each lead's first customer message (Chats' D1 lead_messages) for leads whose first message falls
// in [fromIso, toIso] — matched against ad codes ("#K26") and ad headlines in the dashboard.
export async function marFirstMessages(env, cid, fromIso, toIso){
  const {results}=await env.DB.prepare(`SELECT m.lead_id, m.content FROM lead_messages m
      JOIN (SELECT lead_id, MIN(ts) t FROM lead_messages WHERE client_id=? AND role='user' GROUP BY lead_id HAVING MIN(ts)>=? AND MIN(ts)<=?) f
        ON f.lead_id=m.lead_id AND m.ts=f.t
      WHERE m.client_id=? AND m.role='user' LIMIT 20000`).bind(Number(cid), fromIso, toIso, Number(cid)).all();
  const out={};
  for(const r of results||[]) if(!(r.lead_id in out)) out[r.lead_id]=String(r.content||'').slice(0,300);
  return out;
}

/* ── Leads for the summary (server side) ── */
const LEAD_FIELDS='Id,CreatedAt,Date,ClosedAt,Score,Stage,Owner,AdId,AdCode,CampaignId,AdCampaign,AdName,LeadSource,Source,MetaLeadgenId,CtwaClid,HandoverOutcome,DealValue,DealCurrency';
// Newest leads first until they're older than `sinceMs` (max 2,000). A sale closed on the day on a
// lead older than that window isn't counted in the daily message (the dashboard report counts it).
export async function marRecentLeads(env, deps, cid, sinceMs){
  await deps.ensureLeadsColumns?.(env, ['AdId','AdCode','CampaignId','CtwaClid','ClosedAt']).catch(()=>{});
  const where=encodeURIComponent(`(ClientId,eq,${cid})`);
  const out=[]; let fields=`&fields=${LEAD_FIELDS}`;
  for(let page=0; page<10; page++){
    let r=await deps.ncFetch(env, `api/v2/tables/${deps.leadsTable}/records?where=${where}&sort=-Id&limit=200&offset=${page*200}${fields}`);
    if(!r.ok && fields){ fields=''; r=await deps.ncFetch(env, `api/v2/tables/${deps.leadsTable}/records?where=${where}&sort=-Id&limit=200&offset=${page*200}`); }
    if(!r.ok) break;
    const list=(await r.json().catch(()=>({})))?.list||[];
    out.push(...list);
    if(list.length<200) break;
    const oldest=Math.min(...list.map(l=>marLeadArrivedMs(l)).filter(Number.isFinite));
    if(Number.isFinite(oldest) && oldest<sinceMs) break;
  }
  return out;
}

// Every lead of the account (up to 10,000) — a missing optional column must not empty the list,
// so a refused field list is retried without one.
export async function marAllLeads(env, deps, cid, fieldList){
  const where=encodeURIComponent(`(ClientId,eq,${cid})`);
  let fields=fieldList?`&fields=${fieldList}`:'';
  const out=[];
  for(let page=0; page<50; page++){
    let r=await deps.ncFetch(env, `api/v2/tables/${deps.leadsTable}/records?where=${where}&sort=-Id&limit=200&offset=${page*200}${fields}`);
    if(!r.ok && fields){ fields=''; r=await deps.ncFetch(env, `api/v2/tables/${deps.leadsTable}/records?where=${where}&sort=-Id&limit=200&offset=${page*200}`); }
    if(!r.ok) throw new Error('Could not read the leads ('+r.status+')');
    const list=(await r.json().catch(()=>({})))?.list||[];
    out.push(...list);
    if(list.length<200) break;
  }
  return out;
}
async function buildSummary(env, deps, c, st, day){
  const cid=Number(c.Id), tzMin=Number(st?.tz_offset_min)||0;
  const {results:ads}=await env.DB.prepare(`SELECT * FROM meta_ads_daily WHERE client_id=? AND day=?`).bind(cid, day).all();
  const {results:all}=await env.DB.prepare(`SELECT ad_id, MAX(ad_name) ad_name, MAX(adset_id) adset_id, MAX(adset_name) adset_name, MAX(campaign_id) campaign_id, MAX(campaign_name) campaign_name FROM meta_ads_daily WHERE client_id=? GROUP BY ad_id`).bind(cid).all();
  const sinceMs=Date.parse(marAddDays(day, -8)+'T00:00:00Z');
  const leads=await marRecentLeads(env, deps, cid, sinceMs);
  // Conversions API on that day: refusals, and whether anything reached Meta in the last 3 days.
  let capi=null;
  if(c.meta_pixel_id && c.meta_capi_token){
    const dayStart=day+'T00:00:00Z', dayEnd=marAddDays(day, 1)+'T00:00:00Z';
    const f=await env.DB.prepare(`SELECT COUNT(*) n, MAX(error) e FROM meta_capi_errors WHERE client_id=? AND at>=? AND at<?`).bind(cid, dayStart, dayEnd).first().catch(()=>null);
    const s3=await env.DB.prepare(`SELECT COUNT(*) n FROM meta_capi_events WHERE client_id=? AND sent_at>=?`).bind(cid, marAddDays(day, -2)+'T00:00:00Z').first().catch(()=>null);
    capi={failed:Number(f?.n)||0, error:f?.e||'', sent3d:Number(s3?.n)||0};
  }
  return marDaySummary({day, ads:ads||[], leads, index:marAdIndex(all||[]), tzMin, currency:st?.currency||'', cfg:marSettings(st?.config_json), syncError:st?.last_error||'', capi});
}

/* ── Daily summary + alerts delivery ── */
async function logSend(env, cid, kind, day, recipient, status, detail){
  try{
    await env.DB.prepare(`INSERT INTO meta_ads_report_sends (client_id, kind, day, recipient, status, detail, created_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(Number(cid), kind, day, recipient||null, status, String(detail||'').slice(0,300), new Date().toISOString()).run();
  }catch(e){}
}
async function sendWhatsapp(creds, to, cfg, text, params){
  const msg=cfg.summary_template
    ? {type:'template', template:{name:cfg.summary_template, language:{code:cfg.summary_template_lang}, components:[{type:'body', parameters:params.map(t=>({type:'text', text:t}))}]}}
    : {type:'text', text:{body:text.slice(0,4000)}};
  const r=await fetch(`https://graph.facebook.com/v18.0/${creds.wa_phone_id}/messages`, {
    method:'POST', headers:{Authorization:`Bearer ${creds.wa_token}`, 'Content-Type':'application/json'},
    body:JSON.stringify({messaging_product:'whatsapp', to, ...msg})});
  const d=await r.json().catch(()=>({}));
  return r.ok?{ok:true, detail:d?.messages?.[0]?.id||'sent'}:{ok:false, detail:d?.error?.message||'HTTP '+r.status};
}
function summaryHtml(s, text){
  const esc=t=>String(t).replace(/[&<>]/g, ch=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[ch]));
  return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#111">${esc(text).replace(/\n/g,'<br>')}
    <p style="color:#777;font-size:12px;margin-top:16px">Open Reports → 💸 Ads ROI in LeadVyne for the full breakdown by campaign, ad, lead quality and staff.</p></div>`;
}
// Sends the summary (if on) and/or alerts (if on and any) for `day`. force: the "send test" button.
export async function marSendSummary(env, deps, c, st, day, {force=false}={}){
  const cfg=marSettings(st?.config_json);
  if(!force && !cfg.summary_enabled && !cfg.alerts_enabled) return {skipped:'off'};
  const s=await buildSummary(env, deps, c, st, day);
  const kind=cfg.summary_enabled||force?'summary':'alerts';
  if(kind==='alerts' && !s.alerts.length) return {skipped:'no-alerts', summary:s};
  // Ads paused and nothing happened: no message (the test button still sends).
  if(!force && !s.spend && !s.adLeads && !s.sales && !s.alerts.length) return {skipped:'quiet-day', summary:s};
  const text=kind==='summary'?marSummaryText(s, c.client_name):['⚠️ Ads alerts — '+day, ...s.alerts.map(a=>'• '+a.text)].join('\n');
  const params=marTemplateParams(s, c.client_name);
  const phones=deps.parseTeamWhatsapp(c);
  const results=[];
  const creds=cfg.summary_staff.length?deps.metaCreds(c):null;
  for(const email of cfg.summary_staff){
    const to=phones[email];
    if(!to){ results.push({to:email, ok:false, detail:'No WhatsApp number on file for this user'}); continue; }
    if(!creds?.wa_phone_id||!creds?.wa_token){ results.push({to:email, ok:false, detail:'WhatsApp Business API not connected'}); continue; }
    const res=await sendWhatsapp(creds, to, cfg, text, params).catch(e=>({ok:false, detail:e.message}));
    if(res.ok && cfg.summary_template){ try{ await deps.logTemplateSend?.(env, c.Id, {template:cfg.summary_template, phone:to}); }catch(e){} }
    results.push({to:email, channel:'whatsapp', ...res});
  }
  for(const to of cfg.summary_emails){
    const res=await deps.sendEmail(env, to, `${kind==='summary'?'📊 Ads summary':'⚠️ Ads alerts'} — ${day}${c.client_name?' · '+c.client_name:''}`, summaryHtml(s, text)).catch(e=>({ok:false, error:e.message}));
    results.push({to, channel:'email', ok:!!res?.ok, detail:res?.ok?'sent':res?.error||'failed'});
  }
  for(const r of results) await logSend(env, c.Id, force?'test':kind, day, r.to, r.ok?'sent':'failed', r.detail);
  if(!results.length) await logSend(env, c.Id, force?'test':kind, day, null, 'skipped', 'No recipients set');
  return {summary:s, text, results};
}

/* ── Accounting: monthly Meta spend as an expense ── */
export async function marPostExpenses(env, deps, c, st, {today}={}){
  const cid=Number(c.Id);
  const cfg=marSettings(st?.config_json);
  if(!cfg.accounting_post || !await deps.isAccountingEnabled(c, env)) return {skipped:'off'};
  today=today||marDay(Date.now(), Number(st?.tz_offset_min)||0);
  const months=[today.slice(0,7)];
  if(Number(today.slice(8,10))<=5) months.unshift(marAddDays(today.slice(0,7)+'-01', -1).slice(0,7)); // finalise last month
  const out=[];
  for(const month of months){
    const row=await env.DB.prepare(`SELECT SUM(spend) spend, MAX(currency) currency FROM meta_ads_daily WHERE client_id=? AND substr(day,1,7)=?`).bind(cid, month).first();
    const amount=Math.round((Number(row?.spend)||0)*100)/100;
    const currency=String(row?.currency||st?.currency||'INR').toUpperCase();
    if(!amount){ out.push({month, skipped:'no-spend'}); continue; }
    const lastDay=marAddDays(marAddDays(month+'-01', 32).slice(0,7)+'-01', -1);
    const date=lastDay<today?lastDay:marAddDays(today, -1)<month+'-01'?today:marAddDays(today, -1);
    const post=await env.DB.prepare(`SELECT * FROM meta_ads_expense_posts WHERE client_id=? AND month=?`).bind(cid, month).first();
    const now=new Date().toISOString();
    if(post?.status==='deleted'){ out.push({month, skipped:'deleted-by-user'}); continue; }
    if(post?.expense_id){
      const exists=await env.DB.prepare(`SELECT id, amount FROM accounting_expenses WHERE id=? AND client_id=?`).bind(Number(post.expense_id), cid).first();
      if(!exists){
        await env.DB.prepare(`UPDATE meta_ads_expense_posts SET status='deleted', updated_at=? WHERE client_id=? AND month=?`).bind(now, cid, month).run();
        out.push({month, skipped:'deleted-by-user'}); continue;
      }
      if(Math.abs(Number(exists.amount)-amount)<0.005){ out.push({month, unchanged:true, amount}); continue; }
      await env.DB.prepare(`UPDATE accounting_expenses SET amount=?, currency=?, expense_date=? WHERE id=? AND client_id=?`).bind(amount, currency, date, Number(post.expense_id), cid).run();
      await env.DB.prepare(`UPDATE meta_ads_expense_posts SET amount=?, currency=?, status='posted', updated_at=? WHERE client_id=? AND month=?`).bind(amount, currency, now, cid, month).run();
      out.push({month, updated:true, amount, expense_id:post.expense_id}); continue;
    }
    const label=new Date(month+'-01T00:00:00Z').toLocaleDateString('en-GB', {month:'long', year:'numeric', timeZone:'UTC'});
    const ins=await env.DB.prepare(`INSERT INTO accounting_expenses (client_id, company, expense_account, expense_account_name, paid_from_account, paid_from_account_name, amount, currency, expense_date, category, vendor, supplier_id, description, cost_center, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(cid, '', 'Advertising & Marketing', 'Advertising & Marketing', '', '', amount, currency, date, 'Advertising — Meta Ads', 'Meta Platforms', null,
        `Meta Ads spend, ${label} (ad account ${String(c.meta_ad_account_id||'').replace(/^act_/,'')}). Posted automatically from Reports → Ads ROI and updated daily until the month ends.`, '', 'unsynced', now).run();
    const expenseId=ins.meta?.last_row_id;
    await env.DB.prepare(`INSERT OR REPLACE INTO meta_ads_expense_posts (client_id, month, expense_id, amount, currency, status, updated_at) VALUES (?,?,?,?,?,'posted',?)`).bind(cid, month, expenseId, amount, currency, now).run();
    try{ await deps.onExpenseCreated?.(env, cid, expenseId); }catch(e){}
    out.push({month, created:true, amount, expense_id:expenseId});
  }
  return {months:out};
}

/* ── Cron: a few accounts per 15-minute tick, once per day each ── */
export async function marRunDue(env, deps, now=new Date()){
  if(!await marEnsureSchema(env)) return {ran:0};
  if(now.getUTCHours()<MAR_DAILY_FROM_UTC_HOUR) return {ran:0};
  const today=now.toISOString().slice(0,10);
  const {results}=await env.DB.prepare(`SELECT * FROM meta_ads_report_state WHERE (last_daily_day IS NULL OR last_daily_day<?) ORDER BY COALESCE(last_daily_day,'') LIMIT ?`).bind(today, MAR_PER_TICK).all();
  let ran=0;
  for(const st0 of results||[]){
    const cid=Number(st0.client_id);
    try{
      // Claimed first, so a slow account can't be picked up again by the next tick.
      await patchState(env, cid, {last_daily_day:today});
      const c=await deps.getClientById(env, cid);
      if(!c) continue;
      if(marConnected(c)) await marSync(env, c, {days:st0.backfilled_from?MAR_DAILY_DAYS:MAR_BACKFILL_DAYS});
      const st=await getState(env, cid);
      const day=marAddDays(marDay(now.getTime(), Number(st?.tz_offset_min)||0), -1);
      await marPostExpenses(env, deps, c, st).catch(e=>deps.reportOpsError?.(env, 'ads report: accounting post', e, {clientId:cid}));
      const already=await env.DB.prepare(`SELECT 1 x FROM meta_ads_report_sends WHERE client_id=? AND day=? AND kind IN ('summary','alerts') AND status='sent' LIMIT 1`).bind(cid, day).first();
      if(!already) await marSendSummary(env, deps, c, st, day);
      // CRM audiences in the ad account, refreshed once a day when switched on.
      const cfg=marSettings(st?.config_json);
      if(cfg.audiences_enabled && marConnected(c)) await marRefreshAudiences(env, deps, c, cfg).catch(e=>deps.reportOpsError?.(env, 'ads report: audiences', e, {clientId:cid}));
      ran++;
    }catch(e){ deps.reportOpsError?.(env, 'ads report: daily run', e, {clientId:cid}); }
  }
  return {ran};
}

/* ── Meta writes: audiences and approved budget / pause changes (need ads_management) ── */
async function sha256Hex(str){
  const buf=await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
// Same normalisation as the Conversions API (worker.js capiHashEmail / capiHashPhone).
export async function marHashContact(lead){
  const em=String(lead?.Email||'').trim().toLowerCase(), ph=String(lead?.Phone||'').replace(/[^0-9]/g,'');
  return {em:em.includes('@')?await sha256Hex(em):'', ph:ph.length>=7?await sha256Hex(ph):''};
}
async function graphWrite(c, path, body, {form=false}={}){
  const url=`${GRAPH}/${path}${path.includes('?')?'&':'?'}access_token=${encodeURIComponent(c.meta_capi_token)}`;
  const r=await fetch(url, form
    ? {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams(body), signal:AbortSignal.timeout?.(30000)}
    : {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body), signal:AbortSignal.timeout?.(30000)});
  const data=await r.json().catch(()=>({}));
  return {ok:r.ok && data?.success!==false, status:r.status, data};
}
function writeErr(res, what){
  const m=res.data?.error?.error_user_msg||res.data?.error?.message||'HTTP '+res.status;
  return new Error(/permission|ads_management|\(#(200|10|294)\)/i.test(m)?`${what}: ${m} — the token needs ads_management on this ad account.`
    :/terms|tos/i.test(m)?`${what}: ${m} — accept Meta's Custom Audience terms once in Ads Manager → Audiences.`:`${what}: ${m}`);
}

// CRM audiences, refreshed daily (marRefreshAudiences): who's in each, from the account's leads.
export const MAR_AUDIENCES=[
  {key:'buyers', name:'LeadVyne — Buyers (last 180 days)', lookalike:true, desc:'Won leads or leads with the purchase label, last 180 days — lookalike source.'},
  {key:'high_value', name:'LeadVyne — Buyers by value', value:true, lookalike:true, desc:'Every buyer with a deal value — value-based lookalike source (finds people like your biggest spenders).'},
  {key:'hot_not_bought', name:'LeadVyne — Hot, not bought (90 days)', desc:'Hot leads that haven\'t bought, last 90 days — retarget with an offer.'},
  {key:'exclude', name:'LeadVyne — Exclude: customers, junk, opted out', desc:'Exclude from prospecting so you stop paying to reach people who already bought or said no.'},
];
export function marAudienceMembers(leads, labels, nowMs=Date.now()){
  const out={buyers:[], high_value:[], hot_not_bought:[], exclude:[]};
  for(const l of leads||[]){
    if(!String(l.Phone||'').replace(/\D/g,'') && !String(l.Email||'').includes('@')) continue;
    const won=marIsWon(l)||marHasPurchaseLabel(l.Tags, labels);
    const junk=marIsJunk(l), optedOut=String(l.OptOut||'')==='Yes';
    const arrived=marLeadArrivedMs(l), closedTs=parseTs(l.ClosedAt), closed=Number.isFinite(closedTs)?closedTs:arrived;
    const value=Number(String(l.DealValue??'').replace(/[^0-9.]/g,''))||0;
    if(won && Number.isFinite(closed) && closed>=nowMs-180*D) out.buyers.push(l);
    if(won && value>0) out.high_value.push({...l, _value:value});
    if(!won && !junk && !optedOut && l.Score==='Hot' && Number.isFinite(arrived) && arrived>=nowMs-90*D) out.hot_not_bought.push(l);
    if(won || junk || optedOut) out.exclude.push(l);
  }
  return out;
}
// Replaces the audience's members in one session (Meta's usersreplace) — a daily refresh drops
// people who no longer qualify, which /users (add-only) can't.
async function marReplaceAudience(c, audienceId, rows, schema){
  const session_id=Math.floor(Math.random()*9e15)+1;
  const batches=Math.max(1, Math.ceil(rows.length/10000));
  for(let i=0;i<batches;i++){
    const res=await graphWrite(c, `${audienceId}/usersreplace`, {
      payload:JSON.stringify({schema, data:rows.slice(i*10000, (i+1)*10000)}),
      session:JSON.stringify({session_id, batch_seq:i+1, last_batch_flag:i===batches-1, estimated_num_total:rows.length}),
    }, {form:true});
    if(!res.ok) throw writeErr(res, 'Meta refused the audience upload');
  }
}
export async function marRefreshAudiences(env, deps, c, cfg){
  const cid=Number(c.Id);
  const leads=await marAllLeads(env, deps, cid, 'Id,Email,Phone,Stage,Score,Tags,DealValue,HandoverOutcome,OptOut,ClosedAt,CreatedAt,Date');
  const members=marAudienceMembers(leads, cfg.purchase_labels);
  const {results}=await env.DB.prepare(`SELECT * FROM meta_ads_audiences WHERE client_id=?`).bind(cid).all();
  const have=new Map((results||[]).map(r=>[r.key, r]));
  const out=[];
  for(const def of MAR_AUDIENCES){
    const row=have.get(def.key)||{};
    const now=new Date().toISOString();
    try{
      const rows=[];
      for(const l of members[def.key]){
        const h=await marHashContact(l);
        if(!h.em && !h.ph) continue;
        rows.push(def.value?[h.em, h.ph, Math.round(l._value*100)/100]:[h.em, h.ph]);
      }
      let audienceId=row.audience_id||'';
      if(!audienceId){
        const res=await graphWrite(c, `${acctPath(c)}/customaudiences`, {name:def.name, description:def.desc+' Auto-managed by LeadVyne — do not edit.', subtype:'CUSTOM',
          customer_file_source:'USER_PROVIDED_ONLY', ...(def.value?{is_value_based:true}:{})});
        if(!res.ok || !res.data?.id) throw writeErr(res, 'Meta refused to create the audience');
        audienceId=String(res.data.id);
      }
      if(rows.length) await marReplaceAudience(c, audienceId, rows, def.value?['EMAIL','PHONE','LOOKALIKE_VALUE']:['EMAIL','PHONE']);
      // A lookalike needs at least 100 people in its source — created once; Meta keeps it current.
      let lookalikeId=row.lookalike_id||'', note='';
      if(def.lookalike && !lookalikeId){
        if(rows.length>=100){
          const res=await graphWrite(c, `${acctPath(c)}/customaudiences`, {name:`${def.name} — Lookalike ${cfg.audience_ratio}% ${cfg.audience_country}`, subtype:'LOOKALIKE',
            origin_audience_id:audienceId, lookalike_spec:JSON.stringify({ratio:cfg.audience_ratio/100, country:cfg.audience_country})});
          if(res.ok && res.data?.id) lookalikeId=String(res.data.id); else note='Lookalike: '+(res.data?.error?.message||'refused');
        }else note=`Lookalike waits for 100 people (has ${rows.length})`;
      }
      await env.DB.prepare(`INSERT OR REPLACE INTO meta_ads_audiences (client_id, key, audience_id, lookalike_id, size, last_run_at, last_error) VALUES (?,?,?,?,?,?,?)`)
        .bind(cid, def.key, audienceId, lookalikeId||null, rows.length, now, note||null).run();
      out.push({key:def.key, ok:true, audience_id:audienceId, lookalike_id:lookalikeId, size:rows.length, note});
    }catch(e){
      await env.DB.prepare(`INSERT OR REPLACE INTO meta_ads_audiences (client_id, key, audience_id, lookalike_id, size, last_run_at, last_error) VALUES (?,?,?,?,?,?,?)`)
        .bind(cid, def.key, row.audience_id||null, row.lookalike_id||null, Number(row.size)||0, now, String(e.message).slice(0,300)).run();
      out.push({key:def.key, ok:false, error:e.message});
      if(/ads_management|terms/i.test(e.message)) break; // the same refusal would repeat for every audience
    }
  }
  return out;
}

// An approved rule proposal: pause, or move a daily budget by pct (capped at max_change_pct, never
// below min_daily_budget). What it was before is kept, so Undo puts it back.
export async function marApplyAction(env, c, actor, body, cfg){
  const cid=Number(c.Id);
  const type=body.target_type==='campaign'?'campaign':body.target_type==='adset'?'adset':'';
  const id=String(body.target_id||'');
  const action=String(body.action||'');
  if(!type || !/^\d{5,25}$/.test(id) || !['pause','budget_down','budget_up'].includes(action)) throw Object.assign(new Error('Unknown change'), {status:400});
  const pct=Math.max(1, Math.min(cfg.max_change_pct, Number(body.pct)||0));
  const cur=await graphGet(`${GRAPH}/${id}?fields=name,status,effective_status,daily_budget&access_token=${encodeURIComponent(c.meta_capi_token)}`);
  if(!cur.ok) throw graphErr(cur, 'Meta could not find that '+(type==='adset'?'ad set':'campaign'));
  const before={status:cur.data.status||'', daily_budget:Number(cur.data.daily_budget)||0};
  let after, update;
  if(action==='pause'){
    if(before.status==='PAUSED') throw Object.assign(new Error('It is already paused.'), {status:409});
    update={status:'PAUSED'}; after={...before, status:'PAUSED'};
  }else{
    if(!before.daily_budget) throw Object.assign(new Error(type==='adset'?'This ad set has no daily budget of its own — its campaign holds the budget (Advantage campaign budget).':'This campaign has no daily budget — the budget is on its ad sets.'), {status:409});
    const floor=Math.round(cfg.min_daily_budget*100);
    let next=Math.round(before.daily_budget*(action==='budget_up'?1+pct/100:1-pct/100));
    if(action==='budget_down' && floor && next<floor) next=floor;
    if(next===before.daily_budget) throw Object.assign(new Error('The budget is already at the floor you set.'), {status:409});
    update={daily_budget:next}; after={...before, daily_budget:next};
  }
  const res=await graphWrite(c, id, update);
  const now=new Date().toISOString();
  const ins=await env.DB.prepare(`INSERT INTO meta_ads_actions (client_id, at, actor, target_type, target_id, target_name, action, before_json, after_json, reason, status, error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(cid, now, actor||null, type, id, String(cur.data.name||'').slice(0,300), action, JSON.stringify(before), JSON.stringify(after), String(body.reason||'').slice(0,500),
      res.ok?'ok':'error', res.ok?null:String(res.data?.error?.message||'HTTP '+res.status).slice(0,300)).run();
  if(!res.ok) throw writeErr(res, 'Meta refused the change');
  return {id:ins.meta?.last_row_id, name:cur.data.name||'', before, after};
}
export async function marUndoAction(env, c, actor, actionId){
  const cid=Number(c.Id);
  const row=await env.DB.prepare(`SELECT * FROM meta_ads_actions WHERE id=? AND client_id=?`).bind(Number(actionId), cid).first();
  if(!row || row.status!=='ok' || row.undone_at || row.action==='undo') throw Object.assign(new Error('Nothing to undo.'), {status:404});
  let before={}; try{ before=JSON.parse(row.before_json||'{}'); }catch(e){}
  const update=row.action==='pause'?{status:before.status||'ACTIVE'}:{daily_budget:before.daily_budget};
  const res=await graphWrite(c, row.target_id, update);
  if(!res.ok) throw writeErr(res, 'Meta refused the undo');
  const now=new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE meta_ads_actions SET undone_at=?, status='undone' WHERE id=?`).bind(now, row.id),
    env.DB.prepare(`INSERT INTO meta_ads_actions (client_id, at, actor, target_type, target_id, target_name, action, before_json, after_json, reason, status) VALUES (?,?,?,?,?,?,'undo',?,?,?,'ok')`)
      .bind(cid, now, actor||null, row.target_type, row.target_id, row.target_name, row.after_json, JSON.stringify(update), `Undo of #${row.id}`),
  ]);
  return {ok:true, restored:update};
}

/* ── Tracking health: what reached Meta, what it refused, how strongly events match ── */
const STRONG_KEYS=new Set(['lead_id','ctwa_clid','fbc']);
export async function marHealth(env, c, days=7){
  const cid=Number(c.Id);
  const since=new Date(Date.now()-days*D).toISOString();
  const {results:sent}=await env.DB.prepare(`SELECT substr(sent_at,1,10) day, event, COALESCE(match_key,'') mk, COUNT(*) n, MAX(sent_at) last FROM meta_capi_events WHERE client_id=? AND sent_at>=? GROUP BY day, event, mk`).bind(cid, since).all()
    .catch(()=>({results:[]}));
  const {results:failed}=await env.DB.prepare(`SELECT substr(at,1,10) day, event, code, error, COUNT(*) n, MAX(at) last FROM meta_capi_errors WHERE client_id=? AND at>=? GROUP BY day, event, code, error`).bind(cid, since).all()
    .catch(()=>({results:[]}));
  const byDay={}, byEvent={}, match={lead_id:0, ctwa_clid:0, fbc:0, hashed:0, '':0}, errs={};
  let lastSent='', total=0, totalFailed=0;
  for(const r of sent||[]){
    const n=Number(r.n)||0; total+=n;
    (byDay[r.day]=byDay[r.day]||{day:r.day, sent:0, failed:0}).sent+=n;
    const e=(byEvent[r.event]=byEvent[r.event]||{event:r.event, sent:0, failed:0, strong:0});
    e.sent+=n; if(STRONG_KEYS.has(r.mk)) e.strong+=n;
    match[r.mk in match?r.mk:'']+=n;
    if(r.last>lastSent) lastSent=r.last;
  }
  for(const r of failed||[]){
    const n=Number(r.n)||0; totalFailed+=n;
    (byDay[r.day]=byDay[r.day]||{day:r.day, sent:0, failed:0}).failed+=n;
    (byEvent[r.event]=byEvent[r.event]||{event:r.event, sent:0, failed:0, strong:0}).failed+=n;
    const k=String(r.error||r.code||'Unknown');
    const x=(errs[k]=errs[k]||{error:k, code:r.code||'', n:0, last:''}); x.n+=n; if(r.last>x.last) x.last=r.last;
  }
  // What Meta itself says it received (best-effort — needs the token to see the dataset).
  let meta=null;
  if(c.meta_pixel_id && c.meta_capi_token){
    const t=encodeURIComponent(c.meta_capi_token);
    const info=await graphGet(`${GRAPH}/${c.meta_pixel_id}?fields=name,last_fired_time&access_token=${t}`).catch(()=>null);
    const stats=await graphGet(`${GRAPH}/${c.meta_pixel_id}/stats?aggregation=event&start_time=${Math.floor((Date.now()-days*D)/1000)}&access_token=${t}`).catch(()=>null);
    const received={};
    for(const b of stats?.ok?(stats.data?.data||[]):[]) for(const x of b.data||[]) received[x.value]=(received[x.value]||0)+(Number(x.count)||0);
    meta={ok:!!info?.ok, name:info?.data?.name||'', last_fired_time:info?.data?.last_fired_time||'', received, error:info?.ok?'':(info?.data?.error?.message||'')};
  }
  return {days, pixel_connected:!!(c.meta_pixel_id&&c.meta_capi_token), sent:total, failed:totalFailed, last_sent_at:lastSent,
    by_day:Object.values(byDay).sort((a,b)=>a.day.localeCompare(b.day)), by_event:Object.values(byEvent).sort((a,b)=>b.sent-a.sent),
    match, errors:Object.values(errs).sort((a,b)=>b.n-a.n).slice(0,8), meta};
}

/* ── Routes: /meta/ads-report/* ── */
export async function marHandleRoute(request, env, deps, url){
  const {json}=deps;
  const payload=await deps.requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  if(!await marEnsureSchema(env)) return json({error:'Storage unavailable'}, 503);
  const cid=Number(payload.cid);
  const c=await deps.getClientById(env, cid);
  if(!c) return json({error:'Client not found'}, 404);
  const path=url.pathname.replace(/^\/meta\/ads-report/, '');
  const method=request.method;
  const owner=deps.isClientOwner(c, payload.email);
  const stateOut=st=>({connected:marConnected(c), account_name:st?.account_name||'', currency:st?.currency||'', tz_offset_min:Number(st?.tz_offset_min)||0,
    synced_from:st?.backfilled_from||'', last_ok_at:st?.last_ok_at||'', last_attempt_at:st?.last_attempt_at||'', last_error:st?.last_error||''});

  if(path==='/data' && method==='GET'){
    let st=await ensureState(env, cid);
    const sync=await syncIfStale(env, c, st);
    if(sync) st=await getState(env, cid);
    const today=marDay(Date.now(), Number(st?.tz_offset_min)||0);
    let from=url.searchParams.get('from')||'', to=url.searchParams.get('to')||'';
    if(!DAY_RE.test(to)) to=today;
    if(!DAY_RE.test(from)) from=marAddDays(to, -29);
    if(from>to) [from, to]=[to, from];
    return json({...stateOut(st), from, to, ...await marReportData(env, cid, from, to)});
  }
  if(path==='/health' && method==='GET'){
    const days=Math.min(90, Math.max(1, parseInt(url.searchParams.get('days'))||7));
    return json(await marHealth(env, c, days));
  }
  if(path==='/audiences/refresh' && method==='POST'){
    if(!owner) return json({error:'Only the account owner can refresh audiences.'}, 403);
    if(!marConnected(c)) return json({error:'Add your Ad Account ID and token in Settings → Integrations → Meta Ads first.'}, 400);
    const st=await ensureState(env, cid);
    return json({ok:true, results:await marRefreshAudiences(env, deps, c, marSettings(st?.config_json))});
  }
  if((path==='/actions/apply'||path==='/actions/undo') && method==='POST'){
    if(!owner) return json({error:'Only the account owner can change ads.'}, 403);
    if(!marConnected(c)) return json({error:'Add your Ad Account ID and token in Settings → Integrations → Meta Ads first.'}, 400);
    const body=await request.json().catch(()=>({}));
    try{
      if(path==='/actions/undo') return json(await marUndoAction(env, c, payload.email, body.id));
      const st=await ensureState(env, cid);
      return json({ok:true, ...await marApplyAction(env, c, payload.email, body, marSettings(st?.config_json))});
    }catch(e){ return json({error:e.message}, e.status||502); }
  }
  if(path==='/first-messages' && method==='GET'){
    const from=url.searchParams.get('from')||'', to=url.searchParams.get('to')||'';
    if(!DAY_RE.test(from)||!DAY_RE.test(to)) return json({error:'from and to (YYYY-MM-DD) required'}, 400);
    // A day of slack each side: lead timestamps are UTC, the range is the viewer's own days.
    const fromIso=marAddDays(from, -1)+'T00:00:00Z', toIso=marAddDays(to, 1)+'T23:59:59Z';
    try{ return json({messages:await marFirstMessages(env, cid, fromIso, toIso)}); }
    catch(e){ return json({messages:{}, error:'Chat history not available'}); }
  }
  if(path==='/sync' && method==='POST'){
    const st=await ensureState(env, cid);
    if(!marConnected(c)) return json({error:'Add your Ad Account ID and token in Settings → Integrations → Meta Ads first.'}, 400);
    const res=await marSync(env, c, {days:st?.backfilled_from?MAR_MANUAL_DAYS:MAR_BACKFILL_DAYS});
    if(!res.ok) return json({error:res.error, ...stateOut(await getState(env, cid))}, 502);
    return json({ok:true, rows:res.rows, since:res.since, until:res.until, hourly_rows:res.hourly_rows, ads:res.ads, changes:res.changes, warnings:res.warnings||[], ...stateOut(await getState(env, cid))});
  }
  if(path==='/settings' && method==='GET'){
    const st=await ensureState(env, cid);
    const {results:sends}=await env.DB.prepare(`SELECT kind, day, recipient, status, detail, created_at FROM meta_ads_report_sends WHERE client_id=? ORDER BY id DESC LIMIT 15`).bind(cid).all();
    const {results:posts}=await env.DB.prepare(`SELECT month, expense_id, amount, currency, status, updated_at FROM meta_ads_expense_posts WHERE client_id=? ORDER BY month DESC LIMIT 12`).bind(cid).all();
    const phones=deps.parseTeamWhatsapp(c);
    const {results:aud}=await env.DB.prepare(`SELECT key, audience_id, lookalike_id, size, last_run_at, last_error FROM meta_ads_audiences WHERE client_id=?`).bind(cid).all();
    const {results:acts}=await env.DB.prepare(`SELECT id, at, actor, target_type, target_id, target_name, action, before_json, after_json, reason, status, error, undone_at FROM meta_ads_actions WHERE client_id=? ORDER BY id DESC LIMIT 25`).bind(cid).all();
    return json({audiences:MAR_AUDIENCES.map(d=>({...d, ...((aud||[]).find(a=>a.key===d.key)||{})})), actions:acts||[],
      config:marSettings(st?.config_json), defaults:MAR_DEFAULTS, can_edit:owner, accounting_enabled:!!await deps.isAccountingEnabled(c, env),
      whatsapp_users:Object.keys(phones), whatsapp_connected:!!deps.metaCreds(c)?.wa_token, sends:sends||[], expense_posts:posts||[], ...stateOut(st)});
  }
  if(path==='/settings' && method==='POST'){
    if(!owner) return json({error:'Only the account owner can change Ads ROI settings.'}, 403);
    const body=await request.json().catch(()=>({}));
    await ensureState(env, cid);
    const cfg=marSettings({...marSettings((await getState(env, cid))?.config_json), ...(body.config||{})});
    if(cfg.accounting_post && !await deps.isAccountingEnabled(c, env)) return json({error:'The Accounting module is off for this account — ask LeadVyne to switch it on first.'}, 400);
    await patchState(env, cid, {config_json:JSON.stringify(cfg)});
    return json({ok:true, config:cfg});
  }
  if(path==='/test-summary' && method==='POST'){
    if(!owner) return json({error:'Only the account owner can send a test summary.'}, 403);
    const st=await ensureState(env, cid);
    const day=marAddDays(marDay(Date.now(), Number(st?.tz_offset_min)||0), -1);
    const res=await marSendSummary(env, deps, c, st, day, {force:true});
    return json({ok:true, day, text:res.text||'', results:res.results||[]});
  }
  if(path==='/accounting/post' && method==='POST'){
    if(!owner) return json({error:'Only the account owner can post to Accounting.'}, 403);
    const st=await ensureState(env, cid);
    if(!marSettings(st?.config_json).accounting_post) return json({error:'Switch on "Book Meta spend in Accounting" first.'}, 400);
    return json({ok:true, ...await marPostExpenses(env, deps, c, st)});
  }
  if(path==='/capi' && method==='GET'){
    const days=Math.min(180, Math.max(1, parseInt(url.searchParams.get('days'))||30));
    const since=new Date(Date.now()-days*D).toISOString();
    let rows=[];
    try{
      rows=(await env.DB.prepare(`SELECT event, COALESCE(match_key,'') match_key, COUNT(*) n FROM meta_capi_events WHERE client_id=? AND sent_at>=? GROUP BY event, match_key`).bind(cid, since).all()).results||[];
    }catch(e){
      // match_key arrives with migrations/0118 — older databases still report the event totals.
      rows=((await env.DB.prepare(`SELECT event, '' match_key, COUNT(*) n FROM meta_capi_events WHERE client_id=? AND sent_at>=? GROUP BY event`).bind(cid, since).all().catch(()=>({results:[]}))).results)||[];
    }
    return json({days, pixel_connected:!!(c.meta_pixel_id&&c.meta_capi_token), rows:rows.map(r=>({event:r.event, match_key:r.match_key||'', n:Number(r.n)||0}))});
  }
  return json({error:'Not found'}, 404);
}
