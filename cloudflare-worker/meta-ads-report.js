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
//   isAccountingEnabled(c), onExpenseCreated(env,cid,expenseId), logTemplateSend(env,cid,info),
//   reportOpsError, listStateClients? }

const GRAPH='https://graph.facebook.com/v23.0';
const H=3600000, D=24*H;
export const MAR_BACKFILL_DAYS=90;
export const MAR_DAILY_DAYS=3;
export const MAR_MANUAL_DAYS=30;
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
};

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
  };
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
export function marLeadAdRef(lead){
  const camp=String(lead?.AdCampaign||'').trim();
  const legacyId=(camp.match(/^Ad ID (\d{5,25})$/)||[])[1]||'';
  const adId=String(lead?.AdId||'').trim()||legacyId;
  const campaignId=String(lead?.CampaignId||'').trim();
  const src=`${lead?.LeadSource||''} ${lead?.Source||''}`;
  const isAd=!!(adId||campaignId||String(lead?.CtwaClid||'').trim()||String(lead?.MetaLeadgenId||'').trim()
    ||/lead ad|lead form|click-to-whatsapp|\b(meta|facebook|instagram|fb|ig) ads?\b/i.test(src));
  return {isAd, adId, campaignId, campaignName:legacyId?'':camp, adName:String(lead?.AdName||'').trim()};
}
// ads: synced ad rows ({ad_id, adset_id, campaign_id, campaign_name}). Returns a lookup used by marMatchLead.
export function marAdIndex(ads){
  const byAd=new Map(), byCampaign=new Map(), byCampaignName=new Map();
  for(const a of ads||[]){
    if(a.ad_id) byAd.set(String(a.ad_id), a);
    if(a.campaign_id){
      byCampaign.set(String(a.campaign_id), a);
      const n=String(a.campaign_name||'').trim().toLowerCase(); if(n && !byCampaignName.has(n)) byCampaignName.set(n, String(a.campaign_id));
    }
  }
  return {byAd, byCampaign, byCampaignName};
}
// → null (not an ad lead) | {campaign_id, adset_id, ad_id} — ids are '' when an ad lead can't be
// matched to synced spend (shown as "Ad leads not matched to a campaign").
export function marMatchLead(lead, index){
  const ref=marLeadAdRef(lead);
  if(!ref.isAd) return null;
  const ad=ref.adId&&index.byAd.get(ref.adId);
  if(ad) return {campaign_id:String(ad.campaign_id||''), adset_id:String(ad.adset_id||''), ad_id:String(ad.ad_id)};
  if(ref.campaignId && index.byCampaign.has(ref.campaignId)) return {campaign_id:ref.campaignId, adset_id:'', ad_id:''};
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
export function marDaySummary({day, ads, leads, index, tzMin=0, currency='', cfg=MAR_DEFAULTS, syncError=''}){
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
    ]);
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
    const st=await getState(env, cid);
    await patchState(env, cid, {last_ok_at:now, last_error:null, currency, tz_offset_min:tzMin, account_name:String(acct.data.name||'').slice(0,200),
      backfilled_from:!st?.backfilled_from||since<st.backfilled_from?since:st.backfilled_from});
    return {ok:true, rows:rows.length, since, until, currency};
  }catch(e){
    await patchState(env, cid, {last_error:String(e.message||e).slice(0,500)});
    return {ok:false, error:String(e.message||e)};
  }
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
  return {
    ads:(ads||[]).map(a=>({...a, spend:r2(a.spend), impressions:Number(a.impressions)||0, clicks:Number(a.clicks)||0, meta_leads:Number(a.meta_leads)||0, meta_chats:Number(a.meta_chats)||0})),
    days:(days||[]).map(d=>({day:d.day, spend:r2(d.spend), meta_leads:Number(d.meta_leads)||0, meta_chats:Number(d.meta_chats)||0})),
  };
}

/* ── Leads for the summary (server side) ── */
const LEAD_FIELDS='Id,CreatedAt,Date,ClosedAt,Score,Stage,Owner,AdId,CampaignId,AdCampaign,AdName,LeadSource,Source,MetaLeadgenId,CtwaClid,HandoverOutcome,DealValue,DealCurrency';
// Newest leads first until they're older than `sinceMs` (max 2,000). A sale closed on the day on a
// lead older than that window isn't counted in the daily message (the dashboard report counts it).
export async function marRecentLeads(env, deps, cid, sinceMs){
  await deps.ensureLeadsColumns?.(env, ['AdId','CampaignId','CtwaClid','ClosedAt']).catch(()=>{});
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

async function buildSummary(env, deps, c, st, day){
  const cid=Number(c.Id), tzMin=Number(st?.tz_offset_min)||0;
  const {results:ads}=await env.DB.prepare(`SELECT * FROM meta_ads_daily WHERE client_id=? AND day=?`).bind(cid, day).all();
  const {results:all}=await env.DB.prepare(`SELECT ad_id, MAX(adset_id) adset_id, MAX(campaign_id) campaign_id, MAX(campaign_name) campaign_name FROM meta_ads_daily WHERE client_id=? GROUP BY ad_id`).bind(cid).all();
  const sinceMs=Date.parse(marAddDays(day, -8)+'T00:00:00Z');
  const leads=await marRecentLeads(env, deps, cid, sinceMs);
  return marDaySummary({day, ads:ads||[], leads, index:marAdIndex(all||[]), tzMin, currency:st?.currency||'', cfg:marSettings(st?.config_json), syncError:st?.last_error||''});
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
  if(!cfg.accounting_post || !deps.isAccountingEnabled(c)) return {skipped:'off'};
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
      ran++;
    }catch(e){ deps.reportOpsError?.(env, 'ads report: daily run', e, {clientId:cid}); }
  }
  return {ran};
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
  if(path==='/sync' && method==='POST'){
    const st=await ensureState(env, cid);
    if(!marConnected(c)) return json({error:'Add your Ad Account ID and token in Settings → Integrations → Meta Ads first.'}, 400);
    const res=await marSync(env, c, {days:st?.backfilled_from?MAR_MANUAL_DAYS:MAR_BACKFILL_DAYS});
    if(!res.ok) return json({error:res.error, ...stateOut(await getState(env, cid))}, 502);
    return json({ok:true, rows:res.rows, since:res.since, until:res.until, ...stateOut(await getState(env, cid))});
  }
  if(path==='/settings' && method==='GET'){
    const st=await ensureState(env, cid);
    const {results:sends}=await env.DB.prepare(`SELECT kind, day, recipient, status, detail, created_at FROM meta_ads_report_sends WHERE client_id=? ORDER BY id DESC LIMIT 15`).bind(cid).all();
    const {results:posts}=await env.DB.prepare(`SELECT month, expense_id, amount, currency, status, updated_at FROM meta_ads_expense_posts WHERE client_id=? ORDER BY month DESC LIMIT 12`).bind(cid).all();
    const phones=deps.parseTeamWhatsapp(c);
    return json({config:marSettings(st?.config_json), defaults:MAR_DEFAULTS, can_edit:owner, accounting_enabled:!!deps.isAccountingEnabled(c),
      whatsapp_users:Object.keys(phones), whatsapp_connected:!!deps.metaCreds(c)?.wa_token, sends:sends||[], expense_posts:posts||[], ...stateOut(st)});
  }
  if(path==='/settings' && method==='POST'){
    if(!owner) return json({error:'Only the account owner can change Ads ROI settings.'}, 403);
    const body=await request.json().catch(()=>({}));
    await ensureState(env, cid);
    const cfg=marSettings({...marSettings((await getState(env, cid))?.config_json), ...(body.config||{})});
    if(cfg.accounting_post && !deps.isAccountingEnabled(c)) return json({error:'The Accounting module is off for this account — ask LeadVyne to switch it on first.'}, 400);
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
