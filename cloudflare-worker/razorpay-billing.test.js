// Razorpay subscriptions + admin billing console (razorpay-billing.js), end to end against the real
// migration (node:sqlite through the same tiny D1 shim the other module tests use). Razorpay's API
// is a fake `fetch`; deps are recorded fakes, so nothing leaves the box.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import {
  rzpVerifySignature, rzpPlanStatus, monthlyMinor, guessPlanTier, rzpHandleRoute, rzpListPlans, RZP_TOTAL_COUNT,
} from './razorpay-billing.js';

function d1(db){
  return {prepare(sql){
    let args=[];
    const st={
      bind(...a){ args=a; return st; },
      async run(){ const r=db.prepare(sql).run(...args); return {meta:{changes:Number(r.changes), last_row_id:Number(r.lastInsertRowid)}}; },
      async all(){ return {results:db.prepare(sql).all(...args)}; },
      async first(){ return db.prepare(sql).get(...args)||null; },
    };
    return st;
  }};
}
function freshDb(){
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('./migrations/0116_razorpay_billing.sql', import.meta.url), 'utf8'));
  return db;
}

const PLAN_TIERS={
  basic:{label:'Basic'}, standard:{label:'Standard'},
  business_intelligence:{label:'Business Intelligence'}, marketing_pro:{label:'Enterprise'},
};
const WEBHOOK_SECRET='whsec_test';
const sign=raw=>createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');

let db, env, clients, deps, rzpCalls, rzpRoutes, realFetch;

function setup(){
  db=freshDb();
  env={DB:d1(db), RAZORPAY_KEY_ID:'rzp_test_abc', RAZORPAY_KEY_SECRET:'sec', RAZORPAY_WEBHOOK_SECRET:WEBHOOK_SECRET, STRIPE_SECRET_KEY:'sk_test_x'};
  clients={
    7:{Id:7, client_name:'Acme', authentik_email:'owner@acme.in', billing_email:'billing@acme.in'},
    8:{Id:8, client_name:'Beta', authentik_email:'b@beta.in', billing_email:''},
  };
  const log={patched:[], emails:[]};
  deps={
    log,
    json:(data, status)=>new Response(JSON.stringify(data), {status:status||200, headers:{'Content-Type':'application/json'}}),
    requireSession:async req=>{ const a=req.headers.get('Authorization')||''; return a==='Bearer acme'?{cid:'7'}:a==='Bearer beta'?{cid:'8'}:null; },
    requireAdminSession:async req=>(req.headers.get('Authorization')||'')==='Bearer admin',
    getClientById:async (env, id)=>clients[Number(id)]?{...clients[Number(id)]}:null,
    findClientByField:async (env, field, value)=>Object.values(clients).find(c=>String(c[field]||'')===String(value))||null,
    patchClientFields:async (env, id, fields)=>{ log.patched.push({id:Number(id), fields}); Object.assign(clients[Number(id)], fields); },
    ensureClientColumns:async()=>{},
    listAllClients:async()=>Object.values(clients),
    sendBillingEmail:async (env, mail)=>{ log.emails.push(mail); },
    esc:s=>String(s??''),
    planTiers:PLAN_TIERS, trialDays:15,
    stripeConfigured:env=>!!env.STRIPE_SECRET_KEY,
    stripePlanPrices:async()=>[
      {price_id:'price_basic_inr', name:'Basic', unit_amount:99900, currency:'inr', interval:'month', interval_count:1, metadata:{}},
      {price_id:'price_bi_inr', name:'Business Intelligence', unit_amount:499900, currency:'inr', interval:'month', interval_count:1, metadata:{}},
      {price_id:'price_ent_inr', name:'Leadvyne Pro', unit_amount:999900, currency:'inr', interval:'year', interval_count:1, metadata:{plan_tier:'marketing_pro'}},
      {price_id:'price_basic_aed', name:'Basic', unit_amount:4900, currency:'aed', interval:'month', interval_count:1, metadata:{}},
    ],
    pingStripe:async()=>({ok:true}), pingNocodb:async()=>({ok:true}),
    appBaseUrl:()=>'https://app.example/dashboard.html', webhookBase:()=>'https://api.example',
  };
  rzpCalls=[];
  let n=0;
  // path regex → handler(body, match) returning [status, data]
  rzpRoutes=[
    [/^plans$/, 'POST', b=>[200, {id:`plan_${++n}`, period:b.period, interval:b.interval, item:{name:b.item.name, amount:b.item.amount, currency:b.item.currency}, notes:b.notes}]],
    [/^plans\/(plan_ext)$/, 'GET', ()=>[200, {id:'plan_ext', period:'monthly', interval:1, item:{name:'Standard', amount:199900, currency:'INR'}, notes:{}}]],
    [/^subscriptions$/, 'POST', b=>[200, {id:`sub_${++n}`, plan_id:b.plan_id, status:'created', short_url:`https://rzp.io/i/${n}`, start_at:b.start_at||null, notes:b.notes, total_count:b.total_count}]],
    [/^subscriptions\/(sub_\w+)\/cancel$/, 'POST', (b, m)=>[200, {id:m[1], plan_id:clients[7].razorpay_plan_id, status:b.cancel_at_cycle_end?'active':'cancelled', current_end:2000000000, ended_at:b.cancel_at_cycle_end?null:1900000000}]],
    [/^subscriptions\/(sub_\w+)$/, 'PATCH', (b, m)=>[200, {id:m[1], plan_id:b.plan_id, status:'active', current_end:2000000000}]],
    [/^subscriptions\/(sub_\w+)\/(pause|resume)$/, 'POST', (b, m)=>[200, {id:m[1], plan_id:clients[7].razorpay_plan_id, status:m[2]==='pause'?'paused':'active', current_end:2000000000}]],
    [/^plans\?count=1$/, 'GET', ()=>[200, {items:[]}]],
    [/^invoices/, 'GET', ()=>[200, {items:[{id:'inv_1', status:'paid', amount_paid:99900, currency:'INR', paid_at:1700000000, short_url:'https://rzp.io/inv/1'}]}]],
  ];
  realFetch=globalThis.fetch;
  globalThis.fetch=async (url, init={})=>{
    const u=String(url);
    assert.ok(u.startsWith('https://api.razorpay.com/v1/'), 'unexpected fetch '+u);
    assert.equal(init.headers.Authorization, 'Basic '+btoa('rzp_test_abc:sec'));
    const path=u.slice('https://api.razorpay.com/v1/'.length);
    const body=init.body?JSON.parse(init.body):null;
    rzpCalls.push({method:init.method, path, body});
    for(const [re, method, fn] of rzpRoutes){
      const m=path.match(re);
      if(m && method===init.method){ const [status, data]=fn(body, m); return new Response(JSON.stringify(data), {status}); }
    }
    return new Response(JSON.stringify({error:{description:'not mocked: '+path}}), {status:400});
  };
}

function req(method, path, {auth, body, headers={}}={}){
  return new Request('https://api.example'+path, {method, headers:{...(auth?{Authorization:'Bearer '+auth}:{}), ...(body?{'Content-Type':'application/json'}:{}), ...headers}, body:body?JSON.stringify(body):undefined});
}
async function call(method, path, opts){
  const r=req(method, path, opts);
  const res=await rzpHandleRoute(r, env, deps, new URL(r.url));
  return {status:res.status, data:await res.json()};
}
async function webhook(event, {eventId='evt_'+Math.random(), signature}={}){
  const raw=JSON.stringify(event);
  const r=new Request('https://api.example/billing/razorpay/webhook', {method:'POST', body:raw,
    headers:{'X-Razorpay-Signature':signature||sign(raw), 'X-Razorpay-Event-Id':eventId}});
  const res=await rzpHandleRoute(r, env, deps, new URL(r.url));
  return {status:res.status, data:await res.json()};
}
async function importPlans(){ return call('POST', '/admin/razorpay/plans/import-stripe', {auth:'admin'}); }

describe('pure helpers', ()=>{
  test('signature check is exact hex HMAC of the raw body', async()=>{
    const raw='{"a":1}';
    assert.equal(await rzpVerifySignature(WEBHOOK_SECRET, raw, sign(raw)), true);
    assert.equal(await rzpVerifySignature(WEBHOOK_SECRET, raw+' ', sign(raw)), false);
    assert.equal(await rzpVerifySignature(WEBHOOK_SECRET, raw, ''), false);
    assert.equal(await rzpVerifySignature('', raw, sign(raw)), false);
  });
  test('Razorpay statuses map onto the Stripe vocabulary the dashboard already reads', ()=>{
    const now=1000;
    assert.equal(rzpPlanStatus({status:'created'}, now), 'incomplete');
    assert.equal(rzpPlanStatus({status:'authenticated', start_at:2000}, now), 'trialing');
    assert.equal(rzpPlanStatus({status:'authenticated', start_at:500}, now), 'incomplete');
    assert.equal(rzpPlanStatus({status:'active'}, now), 'active');
    assert.equal(rzpPlanStatus({status:'pending'}, now), 'past_due');
    assert.equal(rzpPlanStatus({status:'halted'}, now), 'unpaid');
    assert.equal(rzpPlanStatus({status:'cancelled'}, now), 'canceled');
    assert.equal(rzpPlanStatus({status:'completed'}, now), 'canceled');
    assert.equal(rzpPlanStatus({status:'expired'}, now), 'incomplete_expired');
  });
  test('MRR normalises every interval to a month', ()=>{
    assert.equal(monthlyMinor(120000, 'yearly'), 10000);
    assert.equal(monthlyMinor(120000, 'year'), 10000);
    assert.equal(monthlyMinor(30000, 'monthly', 3), 10000);
    assert.equal(monthlyMinor(1000, 'bogus'), 0);
  });
  test('plan tier comes from metadata first, then the tier label in the name', ()=>{
    assert.equal(guessPlanTier(PLAN_TIERS, 'Anything', {plan_tier:'standard'}), 'standard');
    assert.equal(guessPlanTier(PLAN_TIERS, 'Business Intelligence (INR)', {}), 'business_intelligence');
    assert.equal(guessPlanTier(PLAN_TIERS, 'Enterprise yearly', {}), 'marketing_pro');
    assert.equal(guessPlanTier(PLAN_TIERS, 'Mystery', {}), '');
  });
});

describe('admin plans', ()=>{
  beforeEach(setup);
  afterEach(()=>{ globalThis.fetch=realFetch; });

  test('import from Stripe copies only the INR plan prices, same name/amount/interval, mapped to tiers', async()=>{
    const r=await importPlans();
    assert.equal(r.status, 200);
    assert.equal(r.data.created.length, 3);
    const plans=await rzpListPlans(env);
    assert.deepEqual(plans.map(p=>[p.name, p.amount, p.period, p.plan_tier, p.stripe_price_id]), [
      ['Basic', 99900, 'monthly', 'basic', 'price_basic_inr'],
      ['Business Intelligence', 499900, 'monthly', 'business_intelligence', 'price_bi_inr'],
      ['Leadvyne Pro', 999900, 'yearly', 'marketing_pro', 'price_ent_inr'],
    ]);
    const created=rzpCalls.filter(c=>c.path==='plans');
    assert.ok(created.every(c=>c.body.item.currency==='INR'));
    // Running it again creates nothing new.
    rzpCalls.length=0;
    const again=await importPlans();
    assert.equal(again.data.created.length, 0);
    assert.equal(rzpCalls.length, 0);
  });

  test('link an existing Razorpay plan, retier it, hide it', async()=>{
    let r=await call('POST', '/admin/razorpay/plans', {auth:'admin', body:{plan_id:'plan_ext', plan_tier:'standard'}});
    assert.equal(r.status, 200);
    assert.equal(r.data.plan.amount, 199900);
    r=await call('PATCH', '/admin/razorpay/plans', {auth:'admin', body:{plan_id:'plan_ext', active:false}});
    assert.equal(r.data.plan.active, false);
    const pub=await call('GET', '/billing/razorpay/plans', {auth:'acme'});
    assert.equal(pub.data.plans.length, 0);
    assert.equal(pub.data.enabled, false);
    const bad=await call('POST', '/admin/razorpay/plans', {auth:'admin', body:{plan_id:'plan_ext', plan_tier:'gold'}});
    assert.equal(bad.status, 400);
  });

  test('admin routes refuse without an admin session', async()=>{
    const r=await call('GET', '/admin/billing/overview', {auth:'acme'});
    assert.equal(r.status, 401);
  });
});

describe('customer subscription lifecycle', ()=>{
  beforeEach(async()=>{ setup(); await importPlans(); rzpCalls.length=0; });
  afterEach(()=>{ globalThis.fetch=realFetch; });

  test('subscribe → 15-day trial, hosted link, client row linked', async()=>{
    const plans=(await call('GET', '/billing/razorpay/plans', {auth:'acme'})).data;
    assert.equal(plans.enabled, true);
    assert.equal(plans.mode, 'test');
    const basic=plans.plans.find(p=>p.plan_tier==='basic');
    const before=Math.floor(Date.now()/1000);
    const r=await call('POST', '/billing/razorpay/subscribe', {auth:'acme', body:{plan_id:basic.plan_id}});
    assert.equal(r.status, 200);
    assert.match(r.data.url, /^https:\/\/rzp\.io\/i\//);
    assert.equal(r.data.trial_days, 15);
    const sent=rzpCalls.find(c=>c.path==='subscriptions').body;
    assert.equal(sent.plan_id, basic.plan_id);
    assert.equal(sent.total_count, RZP_TOTAL_COUNT.monthly);
    assert.equal(sent.notes.client_id, '7');
    assert.ok(sent.start_at>=before+15*86400);
    assert.equal(clients[7].billing_provider, 'razorpay');
    assert.equal(clients[7].razorpay_status, 'created');
    assert.equal(clients[7].plan_status, 'incomplete');
    assert.equal(clients[7].plan_tier, undefined, 'tier not granted before the mandate is authorised');

    // Clicking Subscribe again on the same plan reuses the same link.
    rzpCalls.length=0;
    const again=await call('POST', '/billing/razorpay/subscribe', {auth:'acme', body:{plan_id:basic.plan_id}});
    assert.equal(again.data.resumed, true);
    assert.equal(again.data.url, r.data.url);
    assert.equal(rzpCalls.length, 0);
  });

  test('billing email is required, and a live Stripe subscription blocks a second one', async()=>{
    const pid=(await rzpListPlans(env))[0].plan_id;
    let r=await call('POST', '/billing/razorpay/subscribe', {auth:'beta', body:{plan_id:pid}});
    assert.equal(r.status, 400);
    assert.match(r.data.error, /Billing Email/);
    Object.assign(clients[8], {billing_email:'b@beta.in', stripe_subscription_id:'sub_stripe', plan_status:'active'});
    r=await call('POST', '/billing/razorpay/subscribe', {auth:'beta', body:{plan_id:pid}});
    assert.equal(r.status, 400);
    assert.match(r.data.error, /Stripe/);
  });

  test('webhooks: authenticated → trialing with tier, charged → active + receipt, duplicates ignored', async()=>{
    const basic=(await rzpListPlans(env)).find(p=>p.plan_tier==='basic');
    const {data}=await call('POST', '/billing/razorpay/subscribe', {auth:'acme', body:{plan_id:basic.plan_id}});
    const subId=data.subscription_id;
    const future=Math.floor(Date.now()/1000)+15*86400;
    const subEntity=(status, extra={})=>({id:subId, plan_id:basic.plan_id, status, start_at:future, notes:{client_id:'7'}, ...extra});

    let w=await webhook({event:'subscription.authenticated', payload:{subscription:{entity:subEntity('authenticated')}}});
    assert.equal(w.status, 200);
    assert.equal(clients[7].plan_status, 'trialing');
    assert.equal(clients[7].plan_tier, 'basic');
    assert.equal(clients[7].razorpay_trial_used, 'Yes');
    assert.match(deps.log.emails.at(-1).subject, /trial has started/);

    const charged={event:'subscription.charged', payload:{
      subscription:{entity:subEntity('active', {current_end:future+30*86400})},
      payment:{entity:{id:'pay_1', amount:99900, currency:'INR', status:'captured'}}}};
    w=await webhook(charged, {eventId:'evt_charged'});
    assert.equal(clients[7].plan_status, 'active');
    assert.equal(clients[7].plan_renews_at, new Date((future+30*86400)*1000).toISOString());
    assert.match(deps.log.emails.at(-1).subject, /Payment received — ₹999\.00/);
    const emails=deps.log.emails.length;
    w=await webhook(charged, {eventId:'evt_charged'});
    assert.equal(w.data.duplicate, true);
    assert.equal(deps.log.emails.length, emails, 'no second receipt for a redelivery');

    w=await webhook({event:'subscription.pending', payload:{subscription:{entity:subEntity('pending')}}});
    assert.equal(clients[7].plan_status, 'past_due');

    const events=(await call('GET', '/admin/billing/events?client_id=7', {auth:'admin'})).data.events;
    assert.deepEqual(events.filter(e=>e.provider==='razorpay').map(e=>e.event_type).slice(0, 3),
      ['subscription.pending', 'subscription.charged', 'subscription.authenticated']);
  });

  test('webhooks: bad signature rejected; an old subscription cannot clobber the current one', async()=>{
    const w=await webhook({event:'subscription.cancelled', payload:{}}, {signature:'00'});
    assert.equal(w.status, 400);
    Object.assign(clients[7], {razorpay_subscription_id:'sub_new', razorpay_status:'active', plan_status:'active', billing_provider:'razorpay'});
    await webhook({event:'subscription.cancelled', payload:{subscription:{entity:{id:'sub_old', status:'cancelled', notes:{client_id:'7'}}}}});
    assert.equal(clients[7].plan_status, 'active');
    const ev=(await call('GET', '/admin/billing/events?provider=razorpay', {auth:'admin'})).data.events[0];
    assert.equal(ev.note, 'stale_subscription');
  });

  test('cancel at cycle end keeps access and flags "won\'t renew"; change plan; invoices', async()=>{
    const [basic, bi]=await rzpListPlans(env);
    Object.assign(clients[7], {billing_provider:'razorpay', razorpay_subscription_id:'sub_live', razorpay_plan_id:basic.plan_id, razorpay_status:'active', plan_status:'active'});
    let r=await call('POST', '/billing/razorpay/cancel', {auth:'acme', body:{at_cycle_end:true}});
    assert.equal(r.status, 200);
    assert.deepEqual(rzpCalls.at(-1), {method:'POST', path:'subscriptions/sub_live/cancel', body:{cancel_at_cycle_end:1}});
    assert.equal(clients[7].plan_status, 'active');
    assert.equal(clients[7].plan_cancel_at_period_end, 'Yes');

    r=await call('POST', '/billing/razorpay/change-plan', {auth:'acme', body:{plan_id:bi.plan_id, when:'now'}});
    assert.equal(r.status, 200);
    assert.equal(rzpCalls.at(-1).body.schedule_change_at, 'now');
    assert.equal(clients[7].razorpay_plan_id, bi.plan_id);
    assert.equal(clients[7].plan_tier, 'business_intelligence');

    r=await call('GET', '/billing/razorpay/invoices', {auth:'acme'});
    assert.equal(r.data.invoices[0].amount, 99900);
  });
});

describe('admin console', ()=>{
  beforeEach(async()=>{ setup(); await importPlans(); });
  afterEach(()=>{ globalThis.fetch=realFetch; });

  test('overview: MRR per currency, statuses, providers', async()=>{
    const plans=await rzpListPlans(env);
    const ent=plans.find(p=>p.plan_tier==='marketing_pro');
    Object.assign(clients[7], {billing_provider:'razorpay', razorpay_plan_id:ent.plan_id, razorpay_subscription_id:'sub_a', plan_status:'active'});
    Object.assign(clients[8], {stripe_subscription_id:'sub_s', plan_name:'Basic', plan_status:'trialing',
      plan_renews_at:new Date(Date.now()+3*86400000).toISOString()});
    const r=await call('GET', '/admin/billing/overview', {auth:'admin'});
    assert.equal(r.status, 200);
    assert.equal(r.data.summary.mrr.INR, Math.round(999900/12));
    assert.equal(r.data.summary.trialing, 1);
    assert.equal(r.data.summary.renewing_7d, 1);
    assert.deepEqual(r.data.summary.by_provider, {razorpay:1, stripe:1});
    assert.equal(r.data.clients.find(c=>c.Id===8).provider, 'stripe');
  });

  test('manual plan for an offline customer; pause/resume a Razorpay subscription', async()=>{
    let r=await call('POST', '/admin/billing/manual-plan', {auth:'admin', body:{client_id:8, plan_tier:'standard', plan_status:'active', renews_at:'2027-01-31', note:'NEFT UTR 123'}});
    assert.equal(r.status, 200);
    assert.equal(clients[8].billing_provider, 'manual');
    assert.equal(clients[8].plan_tier, 'standard');
    assert.equal(clients[8].plan_renews_at.slice(0, 10), '2027-01-31');
    r=await call('POST', '/admin/billing/manual-plan', {auth:'admin', body:{client_id:8, plan_tier:'platinum'}});
    assert.equal(r.status, 400);

    const pid=(await rzpListPlans(env))[0].plan_id;
    Object.assign(clients[7], {billing_provider:'razorpay', razorpay_subscription_id:'sub_live', razorpay_plan_id:pid, razorpay_status:'active', plan_status:'active'});
    r=await call('POST', '/admin/razorpay/subscription', {auth:'admin', body:{client_id:7, action:'pause'}});
    assert.equal(r.status, 200);
    assert.equal(clients[7].plan_status, 'paused');
    r=await call('POST', '/admin/razorpay/subscription', {auth:'admin', body:{client_id:7, action:'resume'}});
    assert.equal(clients[7].plan_status, 'active');
    const types=(await call('GET', '/admin/billing/events?provider=admin', {auth:'admin'})).data.events.map(e=>e.event_type);
    assert.ok(types.includes('subscription.pause') && types.includes('plan.manual_set'));
  });

  test('API status reports which secrets are set, never their values', async()=>{
    const r=await call('GET', '/admin/api-status', {auth:'admin'});
    assert.equal(r.status, 200);
    const rzp=r.data.services.find(s=>s.key==='razorpay');
    assert.equal(rzp.mode, 'test');
    assert.equal(rzp.check.ok, true);
    assert.equal(rzp.webhook.url, 'https://api.example/billing/razorpay/webhook');
    assert.equal(JSON.stringify(r.data).includes('sec"'), false);
    assert.equal(JSON.stringify(r.data).includes('rzp_test_abc'), false);
  });
});
