// Reports → 💸 Ads ROI (meta-ads-report.js): attribution rules, Ads Insights sync into D1, the
// daily summary/alerts and the monthly Accounting expense — against the real migrations (node:sqlite
// D1 shim, same as hot-alerts-leadgen.test.js) with Meta, NocoDB and email stubbed.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  marSettings, marActionCount, marInsightRow, marLeadAdRef, marAdIndex, marMatchLead, marLeadArrivedMs, marDay, marAddDays,
  marDaySummary, marSummaryText, marTemplateParams, marSync, marPostExpenses, marRunDue, marHandleRoute, MAR_DEFAULTS, marAdCode, marHourOf,
} from './meta-ads-report.js';

function d1(db){
  const mk=(sql)=>{
    let args=[];
    const st={
      bind(...a){ args=a; return st; },
      async run(){ const r=db.prepare(sql).run(...args); return {meta:{changes:Number(r.changes), last_row_id:Number(r.lastInsertRowid)}}; },
      async all(){ return {results:db.prepare(sql).all(...args)}; },
      async first(){ return db.prepare(sql).get(...args)||null; },
    };
    return st;
  };
  return {prepare:mk, async batch(list){ const out=[]; for(const st of list) out.push(await st.run()); return out; }};
}
function freshDb(){
  const db=new DatabaseSync(':memory:');
  for(const f of ['0003_meta_capi_log.sql','0028_accounting_expenses.sql','0076_lead_messages.sql','0118_meta_ads_report.sql','0120_meta_ads_running.sql','0122_meta_ads_growth.sql'])
    db.exec(readFileSync(new URL('./migrations/'+f, import.meta.url), 'utf8'));
  db.exec('ALTER TABLE accounting_expenses ADD COLUMN supplier_id INTEGER');
  return db;
}
const json=(body, status=200)=>new Response(JSON.stringify(body), {status, headers:{'Content-Type':'application/json'}});

describe('attribution rules', ()=>{
  test('a lead names its ad by id, legacy "Ad ID …", campaign id or name; non-ad leads are not ad leads', ()=>{
    assert.deepEqual(marLeadAdRef({AdId:'111', CtwaClid:'c'}), {isAd:true, adId:'111', campaignId:'', adCode:'', campaignName:'', adName:''});
    assert.equal(marLeadAdRef({AdCampaign:'Ad ID 120200001'}).adId, '120200001');
    assert.equal(marLeadAdRef({AdCampaign:'Ad ID 120200001'}).campaignName, '');
    assert.equal(marLeadAdRef({LeadSource:'Facebook Lead Ad', AdCampaign:'Goa Sept'}).campaignName, 'Goa Sept');
    assert.equal(marLeadAdRef({Source:'Click-to-WhatsApp ad'}).isAd, true);
    assert.equal(marLeadAdRef({Source:'Meta Ads'}).isAd, true);
    assert.equal(marLeadAdRef({Source:'WhatsApp'}).isAd, false);
    assert.equal(marLeadAdRef({Source:'Referral', LeadSource:''}).isAd, false);
  });
  test('matching: ad id, then campaign id, then campaign name, else "not matched"', ()=>{
    const index=marAdIndex([{ad_id:'A1', adset_id:'S1', campaign_id:'C1', campaign_name:'Kerala Honeymoon'}, {ad_id:'A2', adset_id:'S2', campaign_id:'C2', campaign_name:'Goa'}]);
    assert.deepEqual(marMatchLead({AdId:'A1'}, index), {campaign_id:'C1', adset_id:'S1', ad_id:'A1'});
    assert.deepEqual(marMatchLead({CampaignId:'C2', MetaLeadgenId:'9'}, index), {campaign_id:'C2', adset_id:'', ad_id:''});
    assert.deepEqual(marMatchLead({LeadSource:'Instagram Lead Ad', AdCampaign:'kerala honeymoon'}, index), {campaign_id:'C1', adset_id:'', ad_id:''});
    assert.deepEqual(marMatchLead({AdId:'999'}, index), {campaign_id:'', adset_id:'', ad_id:''});
    assert.equal(marMatchLead({Source:'WhatsApp'}, index), null);
  });
  test('ad codes: in a lead\'s message or AdCode, matched to the ad whose name carries it', ()=>{
    assert.equal(marAdCode('Hi I want the offer #K26 please'), 'k26');
    assert.equal(marAdCode('#BABY1'), 'baby1');
    assert.equal(marAdCode('Size #1 price #999'), '');
    assert.equal(marAdCode('mail me a#b.com'), '');
    const index=marAdIndex([{ad_id:'A1', ad_name:'Reel #K26', adset_id:'S1', campaign_id:'C1', campaign_name:'Kerala'}, {ad_id:'A2', ad_name:'Story', adset_id:'S2', campaign_id:'C2', campaign_name:'Goa #G1'}, {ad_id:'A3', ad_name:'Reel', adset_id:'S3', campaign_id:'C2', campaign_name:'Goa #G1'}]);
    assert.deepEqual(marMatchLead({AdCode:'#K26'}, index), {campaign_id:'C1', adset_id:'S1', ad_id:'A1'});
    assert.deepEqual(marMatchLead({AdCode:'g1'}, index), {campaign_id:'C2', adset_id:'', ad_id:''}, 'a campaign code: the campaign, ad unknown');
    assert.deepEqual(marMatchLead({AdCode:'#ZZ9'}, index), {campaign_id:'', adset_id:'', ad_id:''});
  });
  test('Meta hour labels', ()=>{
    assert.equal(marHourOf('19:00:00 - 19:59:59'), 19);
    assert.equal(marHourOf('00:00:00 - 00:59:59'), 0);
    assert.equal(marHourOf('bad'), null);
  });
  test('arrival uses NocoDB CreatedAt (the bot rewrites Date every turn); days in the account timezone', ()=>{
    assert.equal(marLeadArrivedMs({CreatedAt:'2026-10-20 20:00:00+00:00', Date:'2026-10-21T09:00:00Z'}), Date.parse('2026-10-20T20:00:00Z'));
    assert.equal(marLeadArrivedMs({Date:'2026-10-21T09:00:00Z'}), Date.parse('2026-10-21T09:00:00Z'));
    assert.equal(marDay(Date.parse('2026-10-20T20:00:00Z'), 330), '2026-10-21');
    assert.equal(marDay(Date.parse('2026-10-20T20:00:00Z'), 0), '2026-10-20');
    assert.equal(marAddDays('2026-03-01', -1), '2026-02-28');
  });
  test('Meta action counts: "lead" is the total, chats come from messaging conversations', ()=>{
    const actions=[{action_type:'onsite_conversion.lead_grouped', value:'4'}, {action_type:'lead', value:'5'}, {action_type:'onsite_conversion.messaging_conversation_started_7d', value:'7'}];
    assert.equal(marActionCount(actions, ['lead','onsite_conversion.lead_grouped']), 5);
    const row=marInsightRow({date_start:'2026-10-20', ad_id:'A1', campaign_id:'C1', spend:'123.456', impressions:'1000', clicks:'20', actions}, 'inr');
    assert.deepEqual([row.spend, row.meta_leads, row.meta_chats, row.currency], [123.46, 5, 7, 'INR']);
  });
  test('settings are cleaned: bad emails dropped, numbers clamped, template name safe', ()=>{
    const s=marSettings({summary_enabled:true, summary_staff:['A@x.com','nope'], summary_emails:'boss@x.com, bad', alert_cpl_max:'250', alert_junk_pct:500, summary_template:'ads summary!'});
    assert.deepEqual(s.summary_staff, ['a@x.com']);
    assert.deepEqual(s.summary_emails, ['boss@x.com']);
    assert.equal(s.alert_cpl_max, 250);
    assert.equal(s.alert_junk_pct, 100);
    assert.equal(s.summary_template, 'adssummary');
    assert.equal(marSettings('garbage').summary_enabled, false);
  });
});

describe('daily summary', ()=>{
  const index=marAdIndex([{ad_id:'A1', adset_id:'S1', campaign_id:'C1', campaign_name:'Kerala'}, {ad_id:'A2', adset_id:'S2', campaign_id:'C2', campaign_name:'Dubai'}]);
  const ads=[{ad_id:'A1', campaign_id:'C1', spend:1000, meta_leads:4, meta_chats:0}, {ad_id:'A2', campaign_id:'C2', spend:900, meta_leads:0, meta_chats:0}];
  const at=(day, h=10)=>`${day}T0${h-6}:00:00Z`;
  const leads=[
    {Id:1, AdId:'A1', CreatedAt:at('2026-10-20'), Score:'Hot'},
    {Id:2, AdId:'A1', CreatedAt:at('2026-10-20'), Score:'Warm'},
    {Id:3, AdId:'A1', CreatedAt:at('2026-10-20'), HandoverOutcome:'Spam'},
    {Id:4, AdId:'A1', CreatedAt:at('2026-10-15'), Stage:'won', ClosedAt:at('2026-10-20'), DealValue:'20000', DealCurrency:'INR'},
    {Id:6, AdId:'A1', CreatedAt:at('2026-10-18'), HandoverOutcome:'Spam'},
    {Id:5, Source:'WhatsApp', CreatedAt:at('2026-10-20'), Stage:'won', ClosedAt:at('2026-10-20'), DealValue:'5000'},
  ];
  const cfg=marSettings({alerts_enabled:true, alert_spend_no_leads:500, alert_cpl_max:300, alert_junk_pct:30});
  const s=marDaySummary({day:'2026-10-20', ads, leads, index, tzMin:330, currency:'INR', cfg});
  test('totals: ad leads, qualified, junk, sales on the day, ROAS in one currency', ()=>{
    assert.deepEqual([s.spend, s.metaLeads, s.adLeads, s.qualified, s.junk, s.sales, s.revenue], [1900, 4, 3, 1, 1, 1, 20000]);
    assert.equal(Math.round(s.roas*100)/100, 10.53);
    assert.equal(Math.round(s.cpl), 633);
    assert.equal(s.top.name, 'Kerala');
  });
  test('alerts: spend with no leads, cost per lead over the limit, junk share', ()=>{
    assert.deepEqual(s.alerts.map(a=>a.kind).sort(), ['cpl', 'junk', 'no_leads']);
    assert.match(s.alerts.find(a=>a.kind==='no_leads').text, /"Dubai" spent ₹900 with no leads/);
    assert.match(s.alerts.find(a=>a.kind==='cpl').text, /"Kerala" cost ₹333 per lead \(limit ₹300\)/);
  });
  test('no alerts when alerts are off; no ROAS across currencies', ()=>{
    assert.equal(marDaySummary({day:'2026-10-20', ads, leads, index, tzMin:330, currency:'USD', cfg:MAR_DEFAULTS}).alerts.length, 0);
    assert.equal(marDaySummary({day:'2026-10-20', ads, leads, index, tzMin:330, currency:'USD', cfg:MAR_DEFAULTS}).roas, null);
  });
  test('message text and single-line template params', ()=>{
    const text=marSummaryText(s, 'Acme Tours');
    assert.match(text, /^📊 Ads summary — Tue 20 Oct \(Acme Tours\)/);
    assert.match(text, /Leads from ads: 3 · Qualified: 1 · Junk: 1/);
    assert.match(text, /⚠️ Needs attention:/);
    const p=marTemplateParams(s, 'Acme Tours');
    assert.equal(p.length, 3);
    assert.ok(p.every(x=>!/\n/.test(x)));
  });
});

describe('sync, routes, cron, accounting (D1)', ()=>{
  let db, env, origFetch, graphCalls, sent, emails, leads, client;
  const deps={
    json:(b, status=200)=>json(b, status),
    requireSession:async()=>({cid:'7', email:'boss@x.com'}),
    getClientById:async()=>client,
    isClientOwner:(c, e)=>String(e).toLowerCase()===String(c.authentik_email).toLowerCase(),
    ncFetch:async(env, path)=>json({list:leads}),
    ensureLeadsColumns:async()=>{},
    leadsTable:'LEADS',
    parseTeamWhatsapp:()=>({'a@x.com':'919000000002'}),
    metaCreds:()=>({wa_phone_id:'PHONE1', wa_token:'TOKEN'}),
    sendEmail:async(env, to, subject, html)=>{ emails.push({to, subject, html}); return {ok:true}; },
    isAccountingEnabled:c=>c.accounting_enabled==='Yes',
    onExpenseCreated:async()=>{},
    reportOpsError:async(env, what, e)=>{ throw e; },
  };
  let adsList=[
    {id:'A1', name:'Reel 3 #K26', effective_status:'ACTIVE', adset:{id:'S1', name:'Couples 25-40', effective_status:'ACTIVE'}, campaign:{id:'C1', name:'Kerala', effective_status:'ACTIVE'}, creative:{title:'Kerala honeymoon 3N/4D', body:'Houseboat + Munnar'}},
    {id:'A2', name:'Promo', effective_status:'ACTIVE', adset:{id:'S2', name:'UAE', effective_status:'ACTIVE'}, campaign:{id:'C2', name:'Dubai', effective_status:'ACTIVE'}, creative:{title:'Dubai visa', body:''}},
  ];
  const insights=(day)=>({data:[
    {date_start:day, ad_id:'A1', ad_name:'Reel 3', adset_id:'S1', adset_name:'Couples 25-40', campaign_id:'C1', campaign_name:'Kerala', spend:'1000', impressions:'5000', clicks:'80', actions:[{action_type:'lead', value:'4'}], account_currency:'INR'},
    {date_start:day, ad_id:'A2', ad_name:'Promo', adset_id:'S2', adset_name:'UAE', campaign_id:'C2', campaign_name:'Dubai', spend:'900', impressions:'4000', clicks:'10', actions:[], account_currency:'INR'},
  ]});
  beforeEach(()=>{
    db=freshDb(); env={DB:d1(db)}; graphCalls=[]; sent=[]; emails=[]; leads=[];
    client={Id:7, client_name:'Acme Tours', authentik_email:'boss@x.com', meta_ad_account_id:'act_555', meta_capi_token:'TOK', accounting_enabled:'Yes'};
    origFetch=globalThis.fetch;
    globalThis.fetch=async (url, init={})=>{
      url=String(url);
      if(url.endsWith('/messages')){ sent.push(JSON.parse(init.body)); return json({messages:[{id:'wamid.1'}]}); }
      graphCalls.push(url);
      if(url.includes('/act_555?')) return json({name:'Acme Ads', currency:'INR', timezone_offset_hours_utc:5.5});
      if(url.includes('/act_555/insights?') && url.includes('breakdowns=hourly')){
        const range=JSON.parse(new URL(url).searchParams.get('time_range'));
        return json({data:[
          {date_start:range.until, ad_id:'A1', spend:'200', actions:[{action_type:'lead', value:'1'}], hourly_stats_aggregated_by_advertiser_time_zone:'19:00:00 - 19:59:59'},
          {date_start:range.until, ad_id:'A2', spend:'50', actions:[{action_type:'onsite_conversion.messaging_conversation_started_7d', value:'2'}], hourly_stats_aggregated_by_advertiser_time_zone:'07:00:00 - 07:59:59'},
          {date_start:range.until, ad_id:'A2', spend:'0', actions:[], hourly_stats_aggregated_by_advertiser_time_zone:'03:00:00 - 03:59:59'},
        ]});
      }
      if(url.includes('/act_555/ads?')) return json({data:adsList});
      if(url.includes('/act_555/insights?')){
        const range=JSON.parse(new URL(url).searchParams.get('time_range'));
        if(url.includes('after=P2')) return json(insights(range.since));
        return json({...insights(range.until), paging:{next:url+'&after=P2'}});
      }
      return json({error:{message:'unexpected '+url}}, 400);
    };
  });
  afterEach(()=>{ globalThis.fetch=origFetch; db.close(); });
  const req=(path, method='GET', body)=>marHandleRoute(new Request('https://w.test'+path, {method, body:body?JSON.stringify(body):undefined}), env, deps, new URL('https://w.test'+path));

  test('first sync backfills 90 days, follows paging, replaces the window', async ()=>{
    const r=await marSync(env, client, {days:90});
    assert.equal(r.ok, true);
    assert.equal(r.rows, 4);
    assert.equal(marAddDays(r.since, 89), r.until);
    const tr=JSON.parse(new URL(graphCalls[1]).searchParams.get('time_range'));
    assert.deepEqual(tr, {since:r.since, until:r.until});
    const st=db.prepare('SELECT * FROM meta_ads_report_state WHERE client_id=7').get();
    assert.deepEqual([st.currency, st.tz_offset_min, st.account_name, st.backfilled_from, st.last_error], ['INR', 330, 'Acme Ads', r.since, null]);
    // The last 3 days are replaced (2 ads on 2 of those days); the 90-day-old rows stay.
    await marSync(env, client, {days:3});
    assert.equal(db.prepare('SELECT COUNT(*) n FROM meta_ads_daily').get().n, 6);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM meta_ads_daily WHERE day=?').get(r.since).n, 2);
    assert.equal(db.prepare('SELECT backfilled_from b FROM meta_ads_report_state').get().b, r.since);
  });

  test('a token without ads_read is reported in plain words and kept on the state row', async ()=>{
    globalThis.fetch=async()=>json({error:{message:'(#200) Missing permission'}}, 400);
    const r=await marSync(env, client);
    assert.equal(r.ok, false);
    assert.match(r.error, /needs the ads_read permission/);
    assert.match(db.prepare('SELECT last_error e FROM meta_ads_report_state').get().e, /ads_read/);
  });

  test('a token Meta can\'t parse points to Settings, not to ads_read', async ()=>{
    globalThis.fetch=async()=>json({error:{message:'Invalid OAuth access token - Cannot parse access token', type:'OAuthException', code:190}}, 400);
    const r=await marSync(env, client);
    assert.equal(r.ok, false);
    assert.match(r.error, /Meta token in Settings → Integrations → Meta Ads isn't valid/);
    assert.match(r.error, /Paste a fresh System User token with ads_read/);
  });

  test('GET /data syncs on first open and returns per-ad totals for the range', async ()=>{
    const def=await (await req('/meta/ads-report/data')).json();
    assert.equal(def.connected, true);
    assert.equal(def.currency, 'INR');
    assert.equal(marAddDays(def.from, 29), def.to, 'default range: last 30 days');
    assert.equal(def.days.length, 1);
    const res=await (await req(`/meta/ads-report/data?from=${def.synced_from}&to=${def.to}`)).json();
    const a1=res.ads.find(a=>a.ad_id==='A1');
    assert.deepEqual([a1.campaign_name, a1.adset_name, a1.spend, a1.meta_leads], ['Kerala', 'Couples 25-40', 2000, 8]);
    assert.equal(res.days.length, 2);
    // A narrower range keeps every ad (for matching leads) with zero spend.
    const one=await (await req(`/meta/ads-report/data?from=${res.to}&to=${res.to}`)).json();
    assert.equal(one.ads.find(a=>a.ad_id==='A1').spend, 1000);
    assert.equal(graphCalls.filter(u=>u.includes('/insights')&&!u.includes('breakdowns=hourly')).length, 2, 'fresh data is not re-synced (one sync = 2 pages)');
  });

  test('sync keeps hourly rows and ad details; a status change since the last sync is logged', async ()=>{
    const r=await marSync(env, client, {days:90});
    assert.equal(r.ok, true);
    assert.equal(r.hourly_rows, 2, 'zero rows are dropped');
    assert.equal(r.ads, 2);
    assert.equal(r.changes, 0, 'the first sync logs nothing');
    const hrs=db.prepare('SELECT hour, ad_id, meta_leads, meta_chats FROM meta_ads_hourly ORDER BY hour').all().map(x=>({...x}));
    assert.deepEqual(hrs, [{hour:7, ad_id:'A2', meta_leads:0, meta_chats:2}, {hour:19, ad_id:'A1', meta_leads:1, meta_chats:0}]);
    adsList[1]={...adsList[1], effective_status:'PAUSED'};
    adsList.push({id:'A3', name:'New reel', effective_status:'PENDING_REVIEW', adset:{id:'S1', name:'Couples 25-40'}, campaign:{id:'C1', name:'Kerala'}});
    const r2=await marSync(env, client, {days:3});
    assert.equal(r2.changes, 2);
    const res=await (await req(`/meta/ads-report/data?from=${marAddDays(r.until, -2)}&to=${r.until}`)).json();
    assert.deepEqual(res.changes.map(c=>[c.ad_id, c.detail]).sort(), [['A2', 'Active → Paused'], ['A3', 'New ad (In review)']]);
    const a1=res.ads.find(a=>a.ad_id==='A1');
    assert.deepEqual([a1.status, a1.headline, a1.body], ['ACTIVE', 'Kerala honeymoon 3N/4D', 'Houseboat + Munnar']);
    assert.equal(res.hours.length, 2);
    assert.equal(res.hourly_from, r.until);
    assert.ok(res.ad_days.every(d=>d.spend>0||d.meta_leads||d.meta_chats));
  });

  test('GET /first-messages: each lead\'s first customer message in the range', async ()=>{
    const ins=db.prepare(`INSERT INTO lead_messages (lead_id, client_id, role, content, ts) VALUES (?,?,?,?,?)`);
    ins.run(1, 7, 'assistant', 'Welcome!', '2026-10-20T09:59:00Z');
    ins.run(1, 7, 'user', 'Hi, Kerala offer #K26', '2026-10-20T10:00:00Z');
    ins.run(1, 7, 'user', 'price?', '2026-10-20T10:05:00Z');
    ins.run(2, 7, 'user', 'old chat', '2026-09-01T10:00:00Z');
    ins.run(2, 7, 'user', 'back again', '2026-10-20T11:00:00Z');
    ins.run(3, 99, 'user', 'other account', '2026-10-20T10:00:00Z');
    const res=await (await req('/meta/ads-report/first-messages?from=2026-10-20&to=2026-10-20')).json();
    assert.deepEqual(res.messages, {1:'Hi, Kerala offer #K26'});
  });

  test('settings: owner only; accounting needs the Accounting module', async ()=>{
    deps.requireSession=async()=>({cid:'7', email:'a@x.com'});
    assert.equal((await req('/meta/ads-report/settings', 'POST', {config:{summary_enabled:true}})).status, 403);
    deps.requireSession=async()=>({cid:'7', email:'boss@x.com'});
    client.accounting_enabled='No';
    assert.equal((await req('/meta/ads-report/settings', 'POST', {config:{accounting_post:true}})).status, 400);
    const ok=await (await req('/meta/ads-report/settings', 'POST', {config:{summary_enabled:true, summary_staff:['a@x.com']}})).json();
    assert.equal(ok.config.summary_enabled, true);
    const got=await (await req('/meta/ads-report/settings')).json();
    assert.deepEqual(got.config.summary_staff, ['a@x.com']);
    assert.equal(got.can_edit, true);
    assert.deepEqual(got.whatsapp_users, ['a@x.com']);
  });

  test('morning cron: sync, summary on WhatsApp + email once, accounting expense posted and updated', async ()=>{
    await req('/meta/ads-report/settings', 'POST', {config:{summary_enabled:true, summary_staff:['a@x.com'], summary_emails:['boss@x.com'], accounting_post:true}});
    const now=new Date();
    now.setUTCHours(3, 0, 0, 0);
    const yesterday=marAddDays(marDay(now.getTime(), 330), -1);
    leads=[{Id:1, AdId:'A1', CreatedAt:yesterday+'T06:00:00Z', Score:'Hot'}];
    const r=await marRunDue(env, deps, now);
    assert.equal(r.ran, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, '919000000002');
    assert.match(sent[0].text.body, /Leads from ads: 1 · Qualified: 1/);
    assert.equal(emails.length, 1);
    assert.match(emails[0].subject, /Ads summary/);
    // Again the same day: nothing new.
    assert.equal((await marRunDue(env, deps, now)).ran, 0);
    assert.equal(sent.length, 1);
    const exp=db.prepare('SELECT * FROM accounting_expenses').all();
    assert.equal(exp.length, 1);
    assert.equal(exp[0].vendor, 'Meta Platforms');
    assert.equal(exp[0].currency, 'INR');
    const monthSpend=db.prepare(`SELECT SUM(spend) s FROM meta_ads_daily WHERE substr(day,1,7)=?`).get(exp[0].expense_date.slice(0,7)).s;
    assert.equal(exp[0].amount, monthSpend);
  });

  test('accounting: amount follows the month; a deleted expense is never recreated', async ()=>{
    await marSync(env, client, {days:3});
    db.prepare(`INSERT INTO meta_ads_report_state (client_id, config_json) VALUES (7, ?) ON CONFLICT(client_id) DO UPDATE SET config_json=excluded.config_json`).run(JSON.stringify({accounting_post:true}));
    const st=()=>db.prepare('SELECT * FROM meta_ads_report_state WHERE client_id=7').get();
    const day=db.prepare('SELECT MAX(day) d FROM meta_ads_daily').get().d;
    const today=marAddDays(day, 1).slice(0,7)===day.slice(0,7)?marAddDays(day, 1):day;
    const first=await marPostExpenses(env, deps, client, st(), {today});
    const created=first.months.find(m=>m.created);
    assert.ok(created);
    db.prepare(`UPDATE meta_ads_daily SET spend=spend+100 WHERE day=? AND ad_id='A1'`).run(day);
    const second=await marPostExpenses(env, deps, client, st(), {today});
    assert.equal(second.months.find(m=>m.month===created.month).updated, true);
    assert.equal(db.prepare('SELECT amount FROM accounting_expenses WHERE id=?').get(created.expense_id).amount, created.amount+100);
    db.prepare('DELETE FROM accounting_expenses').run();
    const third=await marPostExpenses(env, deps, client, st(), {today});
    assert.equal(third.months.find(m=>m.month===created.month).skipped, 'deleted-by-user');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM accounting_expenses').get().n, 0);
  });

  test('GET /capi groups events sent to Meta by match key', async ()=>{
    const now=new Date().toISOString();
    for(const [e, k] of [['lead','ctwa_clid'], ['lead','ctwa_clid'], ['purchase','lead_id'], ['qualified','hashed']])
      db.prepare('INSERT INTO meta_capi_events (client_id, event, lead_id, sent_at, match_key) VALUES (7,?,1,?,?)').run(e, now, k);
    const res=await (await req('/meta/ads-report/capi')).json();
    assert.deepEqual(res.rows.find(r=>r.event==='lead'), {event:'lead', match_key:'ctwa_clid', n:2});
    assert.equal(res.rows.length, 3);
  });
});
