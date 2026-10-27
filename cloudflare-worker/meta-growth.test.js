// Ads ROI growth tools: full-funnel Conversions API events (stage map, Junk, website events with the
// Pixel's event id and fbc), failure logging and the tracking-health summary, daily CRM audiences
// (value-based lookalikes) and approved budget / pause changes with Undo. Real migrations (node:sqlite
// D1 shim), NocoDB and the Graph API stubbed.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, { metaCapiBuildEvent, metaWebCapiInfo, capiFunnelFromStages, metaFunnelEventKey } from './worker.js';
import { marSettings, marRule, marAudienceMembers, marRefreshAudiences, marApplyAction, marUndoAction, marHealth, marDaySummary, marAdIndex, marHandleRoute } from './meta-ads-report.js';

const LEADS='mvg6rcw0ia5qqrx', CLIENTS='mxl33bg4wi70fqj';
function d1(db){
  const mk=(sql)=>{ let args=[]; const st={ bind(...a){ args=a; return st; },
    async run(){ const r=db.prepare(sql).run(...args); return {meta:{changes:Number(r.changes), last_row_id:Number(r.lastInsertRowid)}}; },
    async all(){ return {results:db.prepare(sql).all(...args)}; }, async first(){ return db.prepare(sql).get(...args)||null; } }; return st; };
  return {prepare:mk, async batch(list){ const out=[]; for(const st of list) out.push(await st.run()); return out; }};
}
function freshDb(){
  const db=new DatabaseSync(':memory:');
  for(const f of ['0003_meta_capi_log.sql','0118_meta_ads_report.sql','0120_meta_ads_running.sql','0122_meta_ads_growth.sql'])
    db.exec(readFileSync(new URL('./migrations/'+f, import.meta.url), 'utf8'));
  // Budget columns are added at runtime by meta-ads-report.js (0122 no longer ALTERs them).
  db.exec('ALTER TABLE meta_ads_ads ADD COLUMN adset_budget REAL'); db.exec('ALTER TABLE meta_ads_ads ADD COLUMN campaign_budget REAL');
  return db;
}
async function token(secret, cid=7, email='boss@biz.com'){
  const body=btoa(JSON.stringify({cid:String(cid), email, exp:Math.floor(Date.now()/1000)+3600}));
  const key=await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const sig=await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `${body}.${btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}`;
}
const c={Id:7, meta_pixel_id:'744598038086701', meta_capi_token:'EAAGood', meta_ad_account_id:'555', waba_id:'WABA1', deal_currency:'INR', authentik_email:'boss@biz.com'};
const FBC='fb.1.1730000000000.IwAR2abcdefghijklmnop';
const FBP='fb.1.1730000000000.1234567890';

describe('event shapes', ()=>{
  test('a website event: action_source website, the Pixel\'s event id, fbc/fbp, IP and browser', ()=>{
    const {event, matchKey}=metaCapiBuildEvent(c, 'purchase', {Phone:'919876543210'}, {value:2500, eventId:'web_order_ORD-1', web:{fbc:FBC, fbp:FBP, url:'https://app.leadvyne.com/order.html?sku=A', ip:'1.2.3.4', ua:'Mozilla'}}, {ph:'h'});
    assert.equal(matchKey, 'fbc');
    assert.equal(event.action_source, 'website');
    assert.equal(event.event_id, 'web_order_ORD-1');
    assert.equal(event.event_source_url, 'https://app.leadvyne.com/order.html?sku=A');
    assert.deepEqual([event.user_data.fbc, event.user_data.fbp, event.user_data.client_ip_address, event.user_data.client_user_agent], [FBC, FBP, '1.2.3.4', 'Mozilla']);
    assert.deepEqual(event.custom_data, {value:2500, currency:'INR'});
  });
  test('a lead that kept its click id (Fbc) matches on it in later CRM events', ()=>{
    const {event, matchKey}=metaCapiBuildEvent(c, metaFunnelEventKey('QuoteSent'), {Id:9, Fbc:FBC}, {eventName:'QuoteSent'}, {ph:'h'});
    assert.deepEqual([matchKey, event.action_source, event.event_name, event.event_id], ['fbc', 'system_generated', 'QuoteSent', 'lead_9_funnel:quotesent']);
  });
  test('web ids are validated; junk is dropped', ()=>{
    const req=new Request('https://w.test', {headers:{'CF-Connecting-IP':'9.9.9.9', 'User-Agent':'UA'}});
    assert.deepEqual(metaWebCapiInfo(req, {event_id:'web_1730_abc', fbc:FBC, fbp:FBP, url:'https://x.test/a'}), {eventId:'web_1730_abc', web:{fbc:FBC, fbp:FBP, url:'https://x.test/a', ip:'9.9.9.9', ua:'UA'}});
    assert.deepEqual(metaWebCapiInfo(req, {event_id:'<script>', fbc:'nope', fbp:'x', url:'javascript:alert(1)'}).web, {fbc:'', fbp:'', url:'', ip:'9.9.9.9', ua:'UA'});
    assert.equal(metaWebCapiInfo(req, {event_id:'<script>'}).eventId, '');
  });
  test('settings: funnel map names cleaned, rules validated', ()=>{
    const s=marSettings({funnel_map:{quote_sent:'Quote Sent!', visit:'', won:'Purchase'}, rules:[{metric:'cost_per_sale', action:'budget_down', value:'2000', pct:90, days:5}, {metric:'bogus', action:'pause'}]});
    assert.deepEqual(s.funnel_map, {quote_sent:'Quote Sent', won:'Purchase'});
    assert.equal(s.send_junk, true);
    assert.equal(s.rules.length, 1);
    assert.deepEqual([s.rules[0].value, s.rules[0].pct, s.rules[0].days, s.rules[0].level, s.rules[0].op], [2000, 50, 7, 'adset', 'above']);
    assert.equal(marRule({metric:'roas', action:'pause'}).pct, 0);
  });
});

describe('D1 + stubs', ()=>{
  let db, env, origFetch, graph, leads, events, graphResp;
  beforeEach(()=>{
    db=freshDb();
    env={DB:d1(db), SESSION_SIGNING_KEY:'s', NOCODB_BASE:'https://nc.test', NOCODB_TOKEN:'t', ALLOWED_ORIGINS:'https://app.leadvyne.com'};
    graph=[]; events=[]; graphResp=null;
    leads={
      41:{Id:41, ClientId:'7', Phone:'919876543210', Stage:'new', CtwaClid:'ARAk'},
      42:{Id:42, ClientId:'7', Phone:'919800000002', Stage:'new', MetaLeadgenId:'1234567890123456'},
    };
    origFetch=globalThis.fetch;
    globalThis.fetch=async (url, opts={})=>{
      const u=String(url);
      if(u.startsWith('https://graph.facebook.com/')){
        graph.push({url:u, method:opts.method||'GET', body:opts.body});
        if(u.includes('/events?')){ events.push(JSON.parse(opts.body).data[0]); return graphResp||Response.json({events_received:1}); }
        return graphHandler(u, opts);
      }
      if(u.includes(`/tables/${CLIENTS}/records/7`)) return Response.json(c);
      const one=u.match(new RegExp(`/tables/${LEADS}/records/(\\d+)$`));
      if(one) return leads[one[1]]?Response.json(leads[one[1]]):Response.json({}, {status:404});
      if(u.includes(`/tables/${LEADS}/records`) && opts.method==='PATCH'){ for(const p of [].concat(JSON.parse(opts.body))) if(leads[p.Id]) Object.assign(leads[p.Id], p); return Response.json({Id:41}); }
      if(u.includes(`/tables/${LEADS}/records`)) return Response.json({list:Object.values(leads)});
      return Response.json({list:[]});
    };
  });
  afterEach(()=>{ globalThis.fetch=origFetch; db.close(); });
  let graphHandler=()=>Response.json({});
  const setCfg=cfg=>db.prepare(`INSERT INTO meta_ads_report_state (client_id, config_json) VALUES (7, ?) ON CONFLICT(client_id) DO UPDATE SET config_json=excluded.config_json`).run(JSON.stringify(cfg));
  const patch=async body=>(await worker.fetch(new Request(`https://worker.test/nocodb/api/v2/tables/${LEADS}/records`, {method:'PATCH',
    headers:{Authorization:`Bearer ${await token(env.SESSION_SIGNING_KEY)}`, 'Content-Type':'application/json'}, body:JSON.stringify(body)}), env, {})).status;

  test('a mapped stage set in the dashboard sends its event once; Spam sends Junk; form leads keep their lead id', async ()=>{
    setCfg({funnel_map:{quote_sent:'QuoteSent', visit_booked:'VisitBooked'}});
    assert.equal(await patch({Id:41, Stage:'quote_sent'}), 200);
    assert.equal(await patch({Id:41, Stage:'quote_sent'}), 200);
    assert.deepEqual(events.map(e=>e.event_name), ['QuoteSent']);
    assert.equal(events[0].user_data.ctwa_clid, 'ARAk');
    await patch({Id:42, Stage:'visit_booked'});
    assert.deepEqual([events[1].event_name, events[1].user_data.lead_id, events[1].action_source], ['VisitBooked', '1234567890123456', 'system_generated']);
    await patch({Id:41, HandoverOutcome:'Spam', Stage:'lost'});
    assert.equal(events.at(-1).event_name, 'Junk');
    await patch({Id:41, Stage:'new'}); // unmapped stage: nothing
    assert.equal(events.length, 3);
    assert.deepEqual(db.prepare(`SELECT event FROM meta_capi_events ORDER BY id`).all().map(r=>r.event), ['funnel:quotesent', 'funnel:visitbooked', 'junk']);
  });

  test('Junk can be switched off; a refused event is logged for the health panel', async ()=>{
    setCfg({send_junk:false, funnel_map:{quote_sent:'QuoteSent'}});
    assert.deepEqual(await capiFunnelFromStages(env, '7', [{Id:41, HandoverOutcome:'Spam'}]), []);
    graphResp=Response.json({error:{message:'Invalid parameter', code:100, error_user_msg:'Dataset not linked'}}, {status:400});
    const r=await capiFunnelFromStages(env, '7', [{Id:41, Stage:'quote_sent'}]);
    assert.equal(r[0].ok, false);
    const err=db.prepare(`SELECT event, lead_id, code, error FROM meta_capi_errors`).get();
    assert.deepEqual({...err}, {event:'funnel:quotesent', lead_id:41, code:'100', error:'Dataset not linked'});
  });

  test('health: sent / refused by day and event, match strength, top errors, what Meta received', async ()=>{
    const now=new Date().toISOString();
    for(const [e, k] of [['lead','ctwa_clid'], ['lead','hashed'], ['purchase','fbc'], ['funnel:quotesent','lead_id']]) db.prepare(`INSERT INTO meta_capi_events (client_id, event, lead_id, sent_at, match_key) VALUES (7,?,1,?,?)`).run(e, now, k);
    db.prepare(`INSERT INTO meta_capi_errors (client_id, event, lead_id, code, error, at) VALUES (7,'purchase',1,'190','Invalid token',?)`).run(now);
    graphHandler=u=>u.includes('/stats?')?Response.json({data:[{start_time:'x', data:[{value:'Lead', count:5}, {value:'Purchase', count:1}]}]}):Response.json({name:'Aiingo Dataset', last_fired_time:'2026-10-27T10:00:00+0000'});
    const h=await marHealth(env, c, 7);
    assert.deepEqual([h.sent, h.failed], [4, 1]);
    assert.deepEqual(h.match, {lead_id:1, ctwa_clid:1, fbc:1, hashed:1, '':0});
    assert.deepEqual(h.by_event.find(e=>e.event==='purchase'), {event:'purchase', sent:1, failed:1, strong:1});
    assert.equal(h.errors[0].error, 'Invalid token');
    assert.deepEqual(h.meta.received, {Lead:5, Purchase:1});
    assert.equal(h.meta.name, 'Aiingo Dataset');
  });

  test('daily alert when Meta refused events, or nothing reached it for 3 days', ()=>{
    const base={day:'2026-10-26', ads:[], leads:[{Id:1, AdId:'A1', CreatedAt:'2026-10-26T08:00:00Z'}], index:marAdIndex([{ad_id:'A1', campaign_id:'C1'}]), cfg:marSettings({alerts_enabled:true})};
    assert.match(marDaySummary({...base, capi:{failed:3, error:'Invalid token', sent3d:9}}).alerts[0].text, /Meta refused 3 Conversions API events \(Invalid token\)/);
    assert.match(marDaySummary({...base, capi:{failed:0, sent3d:0}}).alerts[0].text, /No events have reached Meta for 3 days/);
    assert.equal(marDaySummary({...base, capi:{failed:0, sent3d:5}}).alerts.length, 0);
  });

  test('audiences: who goes where', ()=>{
    const now=Date.parse('2026-10-27T00:00:00Z'), d=n=>new Date(now-n*86400e3).toISOString();
    const m=marAudienceMembers([
      {Id:1, Phone:'91900', Stage:'won', DealValue:'5000', ClosedAt:d(10)},
      {Id:2, Phone:'91901', Tags:'Order placed', CreatedAt:d(300)},           // bought long ago: exclude + high_value? no value
      {Id:3, Phone:'91902', Score:'Hot', CreatedAt:d(5)},                      // hot, not bought
      {Id:4, Phone:'91903', Score:'Hot', CreatedAt:d(5), HandoverOutcome:'Spam'},
      {Id:5, Phone:'91904', OptOut:'Yes', CreatedAt:d(5)},
      {Id:6, Score:'Hot', CreatedAt:d(5)},                                     // no contact: nowhere
    ], ['Order placed'], now);
    assert.deepEqual(Object.fromEntries(Object.entries(m).map(([k,v])=>[k, v.map(l=>l.Id)])), {buyers:[1], high_value:[1], hot_not_bought:[3], exclude:[1,2,4,5]});
    assert.equal(m.high_value[0]._value, 5000);
  });

  test('audiences: created once, members replaced daily, value-based lookalike at 100+', async ()=>{
    leads={};
    for(let i=0;i<120;i++) leads[100+i]={Id:100+i, ClientId:'7', Phone:'9198000'+String(i).padStart(5,'0'), Stage:'won', DealValue:String(1000+i), ClosedAt:new Date().toISOString()};
    let n=0;
    graphHandler=(u, opts)=>{
      if(u.includes('/act_555/customaudiences')) return Response.json({id:'AUD'+(++n)});
      if(u.includes('/usersreplace')) return Response.json({session_id:1, num_received:10});
      return Response.json({});
    };
    const deps={ncFetch:(env, path)=>fetch('https://nc.test/'+path), leadsTable:LEADS};
    const r=await marRefreshAudiences(env, deps, c, marSettings({audience_country:'AE', audience_ratio:2}));
    assert.deepEqual(r.map(x=>[x.key, x.ok, x.size]), [['buyers', true, 120], ['high_value', true, 120], ['hot_not_bought', true, 0], ['exclude', true, 120]]);
    const creates=graph.filter(g=>g.url.includes('/customaudiences')).map(g=>JSON.parse(g.body));
    assert.equal(creates.find(b=>b.name.includes('Buyers by value')).is_value_based, true);
    const look=creates.filter(b=>b.subtype==='LOOKALIKE');
    assert.equal(look.length, 2);
    assert.deepEqual(JSON.parse(look[0].lookalike_spec), {ratio:0.02, country:'AE'});
    const valueUpload=graph.find(g=>g.url.includes('/usersreplace') && decodeURIComponent(g.body).includes('LOOKALIKE_VALUE'));
    assert.ok(valueUpload, 'value-based audience uploads LOOKALIKE_VALUE');
    const hotId=db.prepare(`SELECT audience_id a FROM meta_ads_audiences WHERE key='hot_not_bought'`).get().a;
    assert.ok(hotId && !graph.some(g=>g.url.includes(`/${hotId}/usersreplace`)), 'an empty audience is created but not replaced with nobody');
    // Second run: no new audiences or lookalikes, members replaced again.
    const before=graph.filter(g=>g.url.includes('/customaudiences')).length;
    await marRefreshAudiences(env, deps, c, marSettings({}));
    assert.equal(graph.filter(g=>g.url.includes('/customaudiences')).length, before);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM meta_ads_audiences WHERE client_id=7`).get().n, 4);
  });

  test('approved changes: budget capped and floored, pause, Undo restores; no budget explained', async ()=>{
    const state={AS1:{name:'Couples', status:'ACTIVE', daily_budget:'100000'}, AS2:{name:'CBO set', status:'ACTIVE'}};
    graphHandler=(u, opts)=>{
      const id=u.match(/v23\.0\/(\w+)/)[1];
      if((opts.method||'GET')==='GET') return Response.json(state[id]||{});
      Object.assign(state[id], JSON.parse(opts.body)); return Response.json({success:true});
    };
    const cfg=marSettings({max_change_pct:20, min_daily_budget:900});
    const a=await marApplyAction(env, {...c, meta_ad_account_id:'555'}, 'boss@biz.com', {target_type:'adset', target_id:'1200000001'.replace('1200000001','AS1'), action:'budget_down', pct:50}, cfg).catch(e=>e);
    assert.match(a.message, /Unknown change/, 'ids must be numeric');
    state['1200000001']=state.AS1;
    const r=await marApplyAction(env, c, 'boss@biz.com', {target_type:'adset', target_id:'1200000001', action:'budget_down', pct:50, reason:'Cost per sale ₹4,000 > ₹2,000'}, cfg);
    assert.deepEqual([r.before.daily_budget, r.after.daily_budget], [100000, 90000], 'capped at 20% and floored at 900');
    assert.equal(state['1200000001'].daily_budget, 90000);
    await marUndoAction(env, c, 'boss@biz.com', r.id);
    assert.equal(state['1200000001'].daily_budget, 100000);
    await assert.rejects(marUndoAction(env, c, 'boss@biz.com', r.id), /Nothing to undo/);
    const p=await marApplyAction(env, c, 'boss@biz.com', {target_type:'adset', target_id:'1200000001', action:'pause'}, cfg);
    assert.equal(state['1200000001'].status, 'PAUSED');
    await marUndoAction(env, c, 'boss@biz.com', p.id);
    assert.equal(state['1200000001'].status, 'ACTIVE');
    state['1200000002']=state.AS2;
    await assert.rejects(marApplyAction(env, c, 'boss@biz.com', {target_type:'adset', target_id:'1200000002', action:'budget_up', pct:10}, cfg), /its campaign holds the budget/);
    assert.deepEqual(db.prepare(`SELECT action, status FROM meta_ads_actions ORDER BY id`).all().map(x=>[x.action, x.status]), [['budget_down','undone'], ['undo','ok'], ['pause','undone'], ['undo','ok']]);
  });

  test('routes: owner only for writes; settings list audiences and actions', async ()=>{
    const deps={json:(b, s=200)=>Response.json(b, {status:s}), requireSession:async()=>({cid:'7', email:'rep@biz.com'}), getClientById:async()=>c,
      isClientOwner:(cl, e)=>e==='boss@biz.com', ncFetch:(env, path)=>fetch('https://nc.test/'+path), leadsTable:LEADS, parseTeamWhatsapp:()=>({}), metaCreds:()=>null, isAccountingEnabled:()=>false};
    const req=(path, method='GET', body)=>marHandleRoute(new Request('https://w.test'+path, {method, body:body?JSON.stringify(body):undefined}), env, deps, new URL('https://w.test'+path));
    assert.equal((await req('/meta/ads-report/actions/apply', 'POST', {})).status, 403);
    assert.equal((await req('/meta/ads-report/audiences/refresh', 'POST')).status, 403);
    const s=await (await req('/meta/ads-report/settings')).json();
    assert.deepEqual(s.audiences.map(a=>a.key), ['buyers', 'high_value', 'hot_not_bought', 'exclude']);
    assert.deepEqual(s.actions, []);
    assert.deepEqual(s.config.funnel_map, {});
  });
});
