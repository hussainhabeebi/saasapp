// Customer billing portal read model (billing-portal.js): plan summary across gateways, tier
// catalog with prices, combined invoices, history timeline, cancel feedback and the Stripe
// plan-change link. D1 via the same node:sqlite shim as razorpay-billing.test.js; Stripe and
// Razorpay are fakes.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { billingPortalHandleRoute, buildTierCatalog, historyEntry, cardExpiringSoon, statusInfo } from './billing-portal.js';

function d1(db){
  return {prepare(sql){
    let args=[];
    const st={
      bind(...a){ args=a; return st; },
      async run(){ const r=db.prepare(sql).run(...args); return {meta:{changes:Number(r.changes)}}; },
      async all(){ return {results:db.prepare(sql).all(...args)}; },
      async first(){ return db.prepare(sql).get(...args)||null; },
    };
    return st;
  }};
}
const PLAN_TIERS={
  basic:{label:'Basic', max_users:1, max_channels:1, modules:[]},
  standard:{label:'Standard', max_users:3, max_channels:2, modules:['appt_enabled']},
};
const GATED={appt_enabled:'Appointment Booking'};
const STRIPE_PRICES=[
  {price_id:'price_basic_inr', name:'Basic', unit_amount:99900, currency:'inr', interval:'month', interval_count:1, metadata:{}},
  {price_id:'price_basic_aed', name:'Basic', unit_amount:4900, currency:'aed', interval:'month', interval_count:1, metadata:{}},
  {price_id:'price_std_aed', name:'Standard', unit_amount:9900, currency:'aed', interval:'month', interval_count:1, metadata:{}},
];

let db, env, client, stripeCalls, rzpGet, realFetch, deps;
beforeEach(()=>{
  db=new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('./migrations/0116_razorpay_billing.sql', import.meta.url), 'utf8'));
  env={DB:d1(db), STRIPE_SECRET_KEY:'sk_test', STRIPE_PLAN_PRICE_IDS:'price_basic_inr,price_basic_aed,price_std_aed', APP_BASE_URL:'https://app/x'};
  client={Id:7, billing_provider:'stripe', stripe_customer_id:'cus_1', stripe_subscription_id:'sub_s', plan_status:'unpaid', plan_name:'price_1Tq7Ch', plan_renews_at:'2026-11-13T00:00:00Z', gstin:'32ABCDE1234F1Z5'};
  stripeCalls=[];
  const stripe={
    'GET subscriptions/sub_s':{ok:true, data:{id:'sub_s', items:{data:[{id:'si_1', price:{unit_amount:99900, currency:'inr', recurring:{interval:'month', interval_count:1}, product:{name:'Basic', metadata:{}}}}]},
      default_payment_method:{card:{brand:'visa', last4:'4242', exp_month:new Date().getUTCMonth()+1, exp_year:new Date().getUTCFullYear()}}}},
    'GET invoices':{ok:true, data:{data:[
      {id:'in_1', number:'A-1', status:'paid', amount_paid:99900, currency:'inr', created:1700000000, status_transitions:{paid_at:1700000100}, hosted_invoice_url:'https://inv/1', invoice_pdf:'https://inv/1.pdf'},
      {id:'in_d', status:'draft', created:1800000000}]}},
  };
  deps={
    json:(data, status)=>new Response(JSON.stringify(data), {status:status||200}),
    requireSession:async req=>req.headers.get('Authorization')==='Bearer t'?{cid:'7', email:'o@x.in'}:null,
    getClientById:async()=>({...client}),
    stripeFetch:async (env, method, path, params)=>{
      stripeCalls.push({method, path, params});
      if(method==='POST' && path==='billing_portal/sessions') return params.flow_data?{ok:true, data:{url:'https://portal/confirm'}}:{ok:true, data:{url:'https://portal/home'}};
      return stripe[`${method} ${path}`]||{ok:false, status:404, data:{}};
    },
    stripeConfigured:()=>true, stripePlanPrices:async()=>STRIPE_PRICES,
    planTiers:PLAN_TIERS, planGatedModules:GATED, supportContacts:()=>({email:'help@x.in', whatsapp:'919800000000'}),
  };
  rzpGet={};
  realFetch=globalThis.fetch;
  globalThis.fetch=async url=>{
    const path=String(url).replace('https://api.razorpay.com/v1/', '');
    const hit=Object.entries(rzpGet).find(([k])=>path.startsWith(k));
    return new Response(JSON.stringify(hit?hit[1]:{}), {status:hit?200:404});
  };
});
afterEach(()=>{ globalThis.fetch=realFetch; });

async function call(method, path, body){
  const req=new Request('https://api'+path, {method, headers:{Authorization:'Bearer t', ...(body?{'Content-Type':'application/json'}:{})}, body:body?JSON.stringify(body):undefined});
  const res=await billingPortalHandleRoute(req, env, deps, new URL(req.url));
  return {status:res.status, data:await res.json()};
}

describe('helpers', ()=>{
  test('status words a customer understands', ()=>{
    assert.equal(statusInfo('unpaid').label, 'Action needed');
    assert.equal(statusInfo('trialing').tone, 'trial');
    assert.equal(statusInfo('').label, 'No plan');
  });
  test('card expiry warning inside 45 days', ()=>{
    const now=new Date('2026-10-18T00:00:00Z');
    assert.equal(cardExpiringSoon(10, 2026, now), true);
    assert.equal(cardExpiringSoon(11, 2026, now), true);
    assert.equal(cardExpiringSoon(3, 2027, now), false);
  });
  test('tier catalog: Razorpay plans price INR when Razorpay is on, Stripe otherwise', ()=>{
    const rzp=[{plan_id:'plan_b', plan_tier:'basic', amount:89900, currency:'INR', period:'monthly', interval_count:1, active:true}];
    const on=buildTierCatalog(PLAN_TIERS, GATED, rzp, STRIPE_PRICES, true);
    assert.deepEqual(on[0].prices.INR, {amount:89900, currency:'INR', period:'monthly', interval_count:1, gateway:'razorpay', id:'plan_b'});
    assert.equal(on[0].prices.AED.id, 'price_basic_aed');
    assert.deepEqual(on[1].modules, ['Appointment Booking']);
    const off=buildTierCatalog(PLAN_TIERS, GATED, rzp, STRIPE_PRICES, false);
    assert.equal(off[0].prices.INR.gateway, 'stripe');
  });
  test('history hides internal rows and admin notes', ()=>{
    assert.equal(historyEntry({provider:'admin', event_type:'client.deleted'}), null);
    assert.equal(historyEntry({provider:'stripe', event_type:'customer.subscription.updated'}), null);
    const e=historyEntry({provider:'admin', event_type:'plan.manual_set', note:'NEFT UTR 123', created_at:'x'});
    assert.equal(e.title, 'Plan updated by Leadvyne');
    assert.equal(JSON.stringify(e).includes('UTR'), false);
  });
});

describe('routes', ()=>{
  test('overview: readable plan name, price, card, warning, tiers, GST, support', async()=>{
    const r=await call('GET', '/billing/portal/overview');
    assert.equal(r.status, 200);
    assert.equal(r.data.plan.name, 'Basic');
    assert.equal(r.data.plan.amount, 99900);
    assert.equal(r.data.plan.tier, 'basic');
    assert.equal(r.data.status_info.label, 'Action needed');
    assert.equal(r.data.payment_method.last4, '4242');
    assert.equal(r.data.payment_method.expiring_soon, true);
    assert.equal(r.data.tiers.length, 2);
    assert.equal(r.data.gst.gstin, '32ABCDE1234F1Z5');
    assert.equal(r.data.support.whatsapp, '919800000000');
    assert.equal(r.data.has_plan, true);
  });
  test('overview never shows a raw price id as the plan name', async()=>{
    deps.stripeConfigured=()=>false;
    client.plan_tier='';
    const r=await call('GET', '/billing/portal/overview');
    assert.equal(r.data.plan.name, 'Your plan');
  });
  test('overview for a Razorpay subscriber reads the plan and UPI mandate', async()=>{
    env.RAZORPAY_KEY_ID='rzp_test_x'; env.RAZORPAY_KEY_SECRET='s';
    db.prepare(`INSERT INTO rzp_plans (plan_id, plan_tier, name, amount, currency, period, interval_count, active, sort_order, created_at) VALUES ('plan_s','standard','Standard',199900,'INR','monthly',1,1,0,'x')`).run();
    Object.assign(client, {billing_provider:'razorpay', razorpay_subscription_id:'sub_r', razorpay_plan_id:'plan_s', razorpay_status:'active', plan_status:'active', plan_tier:'standard'});
    rzpGet['subscriptions/sub_r']={id:'sub_r', status:'active', payment_method:'upi'};
    const r=await call('GET', '/billing/portal/overview');
    assert.equal(r.data.plan.name, 'Standard');
    assert.equal(r.data.plan.amount, 199900);
    assert.deepEqual(r.data.payment_method, {type:'upi', gateway:'razorpay'});
    assert.equal(r.data.tiers.find(t=>t.key==='standard').prices.INR.gateway, 'razorpay');
  });
  test('invoices merge both gateways, newest first, no drafts', async()=>{
    env.RAZORPAY_KEY_ID='rzp_test_x'; env.RAZORPAY_KEY_SECRET='s';
    client.razorpay_subscription_id='sub_r';
    rzpGet['invoices']={items:[{id:'inv_r', status:'paid', amount_paid:199900, currency:'INR', paid_at:1750000000, short_url:'https://rzp/inv'}]};
    const r=await call('GET', '/billing/portal/invoices');
    assert.deepEqual(r.data.invoices.map(i=>[i.gateway, i.id]), [['razorpay', 'inv_r'], ['stripe', 'in_1']]);
    assert.equal(r.data.invoices[1].pdf, 'https://inv/1.pdf');
  });
  test('cancel feedback is logged and shows nowhere in the customer history', async()=>{
    let r=await call('POST', '/billing/portal/cancel-feedback', {reason:'bogus'});
    assert.equal(r.status, 400);
    r=await call('POST', '/billing/portal/cancel-feedback', {reason:'too_expensive', detail:'Budget cut', outcome:'cancelled'});
    assert.equal(r.status, 200);
    const row=db.prepare(`SELECT * FROM billing_events WHERE event_type='cancel.feedback'`).get();
    assert.match(row.note, /Too expensive — Budget cut/);
    db.prepare(`INSERT INTO billing_events (provider, event_type, client_id, amount, currency, created_at) VALUES ('razorpay','subscription.charged',7,99900,'INR','2026-10-01')`).run();
    const h=await call('GET', '/billing/portal/history');
    assert.deepEqual(h.data.events.map(e=>e.title), ['Payment received']);
  });
  test('stripe-change opens the confirm-plan flow, falls back to the portal home', async()=>{
    let r=await call('POST', '/billing/portal/stripe-change', {price_id:'price_std_aed'});
    assert.equal(r.data.url, 'https://portal/confirm');
    const flow=stripeCalls.find(c=>c.params?.flow_data).params.flow_data;
    assert.deepEqual(flow.subscription_update_confirm.items, [{id:'si_1', price:'price_std_aed', quantity:1}]);
    r=await call('POST', '/billing/portal/stripe-change', {price_id:'price_evil'});
    assert.equal(r.status, 400);
    const orig=deps.stripeFetch;
    deps.stripeFetch=async (e, m, p, params)=>params?.flow_data?{ok:false, data:{error:{message:'flow disabled'}}}:orig(e, m, p, params);
    r=await call('POST', '/billing/portal/stripe-change', {price_id:'price_std_aed'});
    assert.equal(r.data.url, 'https://portal/home');
  });
  test('needs a session', async()=>{
    const req=new Request('https://api/billing/portal/overview');
    const res=await billingPortalHandleRoute(req, env, deps, new URL(req.url));
    assert.equal(res.status, 401);
  });
});
