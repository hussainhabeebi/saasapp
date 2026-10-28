// ── Razorpay subscriptions (Indian customers) + admin billing / API console ─────────────────────
// Stripe stays the gateway for everyone else (worker.js "Billing module (Stripe)"); this adds
// Razorpay as the INR gateway so Indian customers can pay with UPI AutoPay, RuPay/Indian cards
// and net-banking e-mandates — Razorpay sends the RBI pre-debit notifications for those itself.
//
// Same plans: every Razorpay Plan is mapped (rzp_plans.plan_tier) to the same PLAN_TIERS entry the
// Stripe prices sell. Admin → Billing → "Razorpay plans" → "Import from Stripe" creates one
// Razorpay Plan per Stripe INR plan price with the same name, amount and interval, so the two
// catalogs can't drift. A Razorpay subscription that goes active sets CLIENTS.plan_tier from that
// mapping (limits/modules apply exactly as for a Stripe customer).
//
// State lives on the same CLIENTS fields the Stripe flow already writes (plan_status, plan_name,
// plan_renews_at, plan_cancel_at_period_end) with Razorpay statuses mapped onto Stripe's words
// (rzpPlanStatus), so every existing banner, badge and onboarding check keeps working. Razorpay-
// only fields: billing_provider, razorpay_subscription_id, razorpay_customer_id, razorpay_plan_id,
// razorpay_status, razorpay_short_url, razorpay_trial_used.
//
// Platform credentials are Worker secrets — RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET,
// RAZORPAY_WEBHOOK_SECRET — never per-client and never sent to a browser.
//
// This file imports nothing from worker.js; worker.js passes helpers in as `deps` (RZP_DEPS):
//   { json, requireSession, requireAdminSession, getClientById, findClientByField,
//     patchClientFields, ensureClientColumns, listAllClients(env)→[client],
//     sendBillingEmail(env,{to,subject,heading,bodyHtml,ctaLabel,ctaUrl}), esc,
//     planTiers (PLAN_TIERS), trialDays, stripeConfigured(env)→bool,
//     stripePlanPrices(env)→[{price_id,name,unit_amount,currency,interval,interval_count,metadata}],
//     pingStripe(env)→{ok,error?}, pingNocodb(env)→{ok,error?}, appBaseUrl(env), webhookBase(env),
//     cancelStripeSubscription(env, subId)→{ok,error?} }

export const RZP_API='https://api.razorpay.com/v1';
export const RZP_TERMINAL=['cancelled','completed','expired'];
const STRIPE_TERMINAL=['canceled','incomplete_expired'];
// A Stripe subscription whose payments are failing — the customer may switch to Razorpay. Stripe
// keeps running untouched until the Razorpay mandate is approved; only then is it cancelled
// (rzpHandleWebhook → deps.cancelStripeSubscription), so an abandoned switch changes nothing.
export const STRIPE_SWITCHABLE=['past_due','unpaid','incomplete'];
export function stripeLive(c){
  return !!c?.stripe_subscription_id && (c.billing_provider||'stripe')==='stripe' && !STRIPE_TERMINAL.includes(c.plan_status);
}
export const RZP_CLIENT_COLUMNS=['billing_provider','razorpay_subscription_id','razorpay_customer_id','razorpay_plan_id',
  'razorpay_status','razorpay_short_url','razorpay_trial_used','plan_tier','plan_name','plan_status','plan_renews_at',
  'plan_cancel_at_period_end','billing_admin_note'];
// How many billing cycles a subscription is created for (Razorpay needs a finite total_count) —
// roughly ten years, after which it completes and the customer simply subscribes again.
export const RZP_TOTAL_COUNT={daily:3650, weekly:520, monthly:120, yearly:10};
const STRIPE_TO_RZP_PERIOD={day:'daily', week:'weekly', month:'monthly', year:'yearly'};

export function rzpConfigured(env){ return !!(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET); }
export function rzpMode(env){
  const k=String(env.RAZORPAY_KEY_ID||'');
  return k.startsWith('rzp_live_')?'live':k.startsWith('rzp_test_')?'test':(k?'unknown':'');
}

export async function rzpFetch(env, method, path, body){
  const r=await fetch(`${RZP_API}/${path}`, {
    method,
    headers:{Authorization:'Basic '+btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`), ...(body?{'Content-Type':'application/json'}:{})},
    body:body?JSON.stringify(body):undefined
  });
  const data=await r.json().catch(()=>({}));
  return {ok:r.ok, status:r.status, data, error:data?.error?.description||(r.ok?'':`HTTP ${r.status}`)};
}

const te=s=>new TextEncoder().encode(s);
const toHex=buf=>[...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
// X-Razorpay-Signature = hex HMAC-SHA256 of the raw request body with the webhook secret.
export async function rzpVerifySignature(secret, rawBody, signature){
  if(!secret||!signature) return false;
  const key=await crypto.subtle.importKey('raw', te(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const expected=toHex(await crypto.subtle.sign('HMAC', key, te(rawBody)));
  const sig=String(signature).trim().toLowerCase();
  if(expected.length!==sig.length) return false;
  let diff=0;
  for(let i=0;i<expected.length;i++) diff|=expected.charCodeAt(i)^sig.charCodeAt(i);
  return diff===0;
}

// Razorpay subscription status → the Stripe vocabulary CLIENTS.plan_status already uses.
// 'authenticated' = mandate approved, first charge still ahead: a trial when start_at is later.
export function rzpPlanStatus(sub, nowSec=Math.floor(Date.now()/1000)){
  switch(sub?.status){
    case 'created': return 'incomplete';
    case 'authenticated': return Number(sub.start_at)>nowSec?'trialing':'incomplete';
    case 'active': return 'active';
    case 'pending': return 'past_due';
    case 'halted': return 'unpaid';
    case 'paused': return 'paused';
    case 'cancelled': case 'completed': return 'canceled';
    case 'expired': return 'incomplete_expired';
    default: return String(sub?.status||'');
  }
}
export function rzpRenewsAt(sub){
  const t=Number(sub?.current_end||sub?.charge_at||sub?.start_at||0);
  return t?new Date(t*1000).toISOString():'';
}
// Monthly-equivalent amount in minor units, for MRR.
export function monthlyMinor(amount, period, intervalCount=1){
  const n=Math.max(1, Number(intervalCount)||1), a=Number(amount)||0;
  const perMonth={daily:30, day:30, weekly:52/12, week:52/12, monthly:1, month:1, yearly:1/12, year:1/12}[period];
  return perMonth?Math.round(a*perMonth/n):0;
}
// Picks the PLAN_TIERS key a Stripe price sells: explicit plan_tier metadata first, else the
// tier whose label (or key) appears in the price/product name — "Business Intelligence (INR)".
export function guessPlanTier(planTiers, name, metadata){
  const explicit=String(metadata?.plan_tier||'').trim();
  if(explicit && planTiers[explicit]) return explicit;
  const n=String(name||'').toLowerCase();
  const byLen=Object.entries(planTiers).sort((a,b)=>b[1].label.length-a[1].label.length);
  for(const [key, t] of byLen) if(n.includes(t.label.toLowerCase())||n.includes(key.replace(/_/g,' '))) return key;
  return '';
}
export function formatMinor(amount, currency){
  const cur=String(currency||'INR').toUpperCase();
  const sym={INR:'₹', AED:'AED '}[cur]||cur+' ';
  return sym+(Number(amount||0)/100).toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2});
}

// ── Schema ───────────────────────────────────────────────────────────────────────────────────────
const SCHEMA=[
  `CREATE TABLE IF NOT EXISTS rzp_plans (plan_id TEXT PRIMARY KEY, plan_tier TEXT NOT NULL DEFAULT '', name TEXT NOT NULL,
    amount INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'INR', period TEXT NOT NULL, interval_count INTEGER NOT NULL DEFAULT 1,
    stripe_price_id TEXT, active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS billing_events (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, event_id TEXT,
    event_type TEXT NOT NULL, client_id INTEGER, object_id TEXT, amount INTEGER, currency TEXT, status TEXT, note TEXT, created_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_events_dedupe ON billing_events(provider, event_id)`,
  `CREATE INDEX IF NOT EXISTS idx_billing_events_client ON billing_events(client_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_billing_events_created ON billing_events(created_at)`,
];
const _schemaReady=new WeakMap();
export function rzpEnsureSchema(env){
  if(!env?.DB) return Promise.resolve();
  let p=_schemaReady.get(env.DB);
  if(!p){
    p=(async()=>{ for(const s of SCHEMA) await env.DB.prepare(s).run(); })().catch(e=>{ _schemaReady.delete(env.DB); throw e; });
    _schemaReady.set(env.DB, p);
  }
  return p;
}
let _columnsReady=null;
function ensureColumns(env, deps){
  if(!_columnsReady) _columnsReady=Promise.resolve(deps.ensureClientColumns(env, RZP_CLIENT_COLUMNS)).catch(()=>{ _columnsReady=null; });
  return _columnsReady;
}

// Best-effort audit row. A duplicate (provider, event_id) is ignored; returns whether it was new.
export async function logBillingEvent(env, ev){
  try{
    await rzpEnsureSchema(env);
    const r=await env.DB.prepare(`INSERT OR IGNORE INTO billing_events (provider, event_id, event_type, client_id, object_id, amount, currency, status, note, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(String(ev.provider||''), ev.event_id?String(ev.event_id):null, String(ev.event_type||''),
      ev.client_id!=null&&ev.client_id!==''?Number(ev.client_id):null, ev.object_id?String(ev.object_id):null,
      ev.amount!=null?Number(ev.amount):null, ev.currency?String(ev.currency).toUpperCase():null, ev.status?String(ev.status):null,
      ev.note?String(ev.note).slice(0,500):null, new Date().toISOString()).run();
    return Number(r?.meta?.changes||0)>0;
  }catch(e){ console.error('logBillingEvent failed', e?.message||e); return false; }
}
async function eventSeen(env, provider, eventId){
  if(!eventId) return false;
  const row=await env.DB.prepare(`SELECT id FROM billing_events WHERE provider=? AND event_id=?`).bind(provider, String(eventId)).first();
  return !!row;
}

// ── Plans ────────────────────────────────────────────────────────────────────────────────────────
function planOut(r){
  return {plan_id:r.plan_id, plan_tier:r.plan_tier||'', name:r.name, amount:Number(r.amount), currency:r.currency||'INR',
    period:r.period, interval_count:Number(r.interval_count)||1, stripe_price_id:r.stripe_price_id||'', active:!!Number(r.active), sort_order:Number(r.sort_order)||0};
}
export async function rzpListPlans(env, {activeOnly=false}={}){
  await rzpEnsureSchema(env);
  const {results}=await env.DB.prepare(`SELECT * FROM rzp_plans ${activeOnly?'WHERE active=1':''} ORDER BY sort_order ASC, amount ASC`).all();
  return (results||[]).map(planOut);
}
async function getPlanRow(env, planId){
  if(!planId) return null;
  await rzpEnsureSchema(env);
  const r=await env.DB.prepare(`SELECT * FROM rzp_plans WHERE plan_id=?`).bind(String(planId)).first();
  return r?planOut(r):null;
}
async function upsertPlan(env, p){
  await rzpEnsureSchema(env);
  await env.DB.prepare(`INSERT INTO rzp_plans (plan_id, plan_tier, name, amount, currency, period, interval_count, stripe_price_id, active, sort_order, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(plan_id) DO UPDATE SET plan_tier=excluded.plan_tier, name=excluded.name, amount=excluded.amount,
    currency=excluded.currency, period=excluded.period, interval_count=excluded.interval_count, stripe_price_id=excluded.stripe_price_id,
    active=excluded.active, sort_order=excluded.sort_order`)
    .bind(p.plan_id, p.plan_tier||'', p.name, Number(p.amount), p.currency||'INR', p.period, Number(p.interval_count)||1,
      p.stripe_price_id||null, p.active===false?0:1, Number(p.sort_order)||0, new Date().toISOString()).run();
}
function planFromRazorpay(rp){
  return {plan_id:rp.id, name:rp.item?.name||rp.id, amount:Number(rp.item?.amount||0), currency:(rp.item?.currency||'INR').toUpperCase(),
    period:rp.period, interval_count:Number(rp.interval)||1, plan_tier:rp.notes?.plan_tier||'', stripe_price_id:rp.notes?.stripe_price_id||''};
}

// ── Subscription → CLIENTS ───────────────────────────────────────────────────────────────────────
// Writes a Razorpay subscription's state onto the client. An event for an older subscription
// (the customer has since started a new one) is ignored unless `force` — so a late "cancelled"
// for the abandoned first attempt can't wipe out the live plan.
export async function rzpSyncSubscription(env, deps, clientId, sub, {force=false, cancelAtCycleEnd, linkOnly=false}={}){
  const c=await deps.getClientById(env, clientId);
  if(!c) return {ok:false, error:'Client not found'};
  const current=String(c.razorpay_subscription_id||'');
  if(!force && current && current!==sub.id) return {ok:true, skipped:'stale_subscription'};
  // Switching from a failing Stripe subscription: until the mandate is approved, only remember the
  // Razorpay link — the plan fields keep describing the Stripe subscription that is still running.
  if(linkOnly || (stripeLive(c) && ['created'].includes(sub.status))){
    await ensureColumns(env, deps);
    const patch={razorpay_subscription_id:sub.id, razorpay_plan_id:sub.plan_id||'', razorpay_status:sub.status||'',
      razorpay_short_url:sub.short_url||c.razorpay_short_url||'', razorpay_customer_id:sub.customer_id||c.razorpay_customer_id||''};
    await deps.patchClientFields(env, clientId, patch);
    return {ok:true, patch, linked_only:true};
  }
  const plan=await getPlanRow(env, sub.plan_id);
  const status=rzpPlanStatus(sub);
  const terminal=RZP_TERMINAL.includes(sub.status);
  let cape=cancelAtCycleEnd;
  if(cape===undefined) cape=('cancel_at_cycle_end' in (sub||{}))?!!sub.cancel_at_cycle_end:(current===sub.id && c.plan_cancel_at_period_end==='Yes');
  if(terminal) cape=false;
  const patch={
    billing_provider:'razorpay',
    razorpay_subscription_id:sub.id,
    razorpay_customer_id:sub.customer_id||c.razorpay_customer_id||'',
    razorpay_plan_id:sub.plan_id||'',
    razorpay_status:sub.status||'',
    razorpay_short_url:sub.short_url||c.razorpay_short_url||'',
    plan_status:status,
    plan_renews_at:terminal?(sub.ended_at?new Date(Number(sub.ended_at)*1000).toISOString():(c.plan_renews_at||'')):rzpRenewsAt(sub),
    plan_name:plan?.name||sub.plan_id||'',
    plan_cancel_at_period_end:cape?'Yes':'No',
  };
  // Paid/trialing on a mapped plan → apply that tier's limits. Never cleared on cancel: an empty
  // plan_tier means "legacy, unlimited", so clearing it would *grant* access — the admin decides.
  if(plan?.plan_tier && ['active','trialing','past_due'].includes(status)) patch.plan_tier=plan.plan_tier;
  if(['authenticated','active'].includes(sub.status)) patch.razorpay_trial_used='Yes';
  // Approving the mandate completes a switch from a failing Stripe subscription. Done here so it
  // happens on whichever path sees the approval first (webhook or the Billing page's status pull).
  const switching=stripeLive(c) && ['authenticated','active'].includes(sub.status) && current===sub.id;
  await ensureColumns(env, deps);
  await deps.patchClientFields(env, clientId, patch);
  let switched='';
  if(switching){
    // Stop the failing Stripe subscription so its retries can't charge the customer a second time.
    const r=await deps.cancelStripeSubscription(env, c.stripe_subscription_id).catch(e=>({ok:false, error:String(e?.message||e)}));
    switched=r.ok?`switched from Stripe — cancelled ${c.stripe_subscription_id}`:`switched from Stripe — FAILED to cancel ${c.stripe_subscription_id}: ${r.error}`;
    await logBillingEvent(env, {provider:'admin', event_type:r.ok?'stripe.cancelled_after_switch':'stripe.cancel_after_switch_failed', client_id:clientId, object_id:c.stripe_subscription_id, note:r.ok?`replaced by Razorpay ${sub.id}`:r.error});
  }
  return {ok:true, patch, switched};
}

function billingTo(c){ return c?.billing_email||c?.authentik_email||''; }
function fmtDate(sec){ return sec?new Date(Number(sec)*1000).toLocaleDateString('en-IN', {day:'numeric', month:'short', year:'numeric'}):''; }

async function sendLifecycleEmail(env, deps, c, eventType, sub, pay){
  const to=billingTo(c);
  if(!to) return;
  const esc=deps.esc, ctaUrl=deps.appBaseUrl(env);
  const plan=await getPlanRow(env, sub?.plan_id);
  const planName=esc(plan?.name||'your Leadvyne plan');
  const amount=pay?formatMinor(pay.amount, pay.currency):(plan?formatMinor(plan.amount, plan.currency):'');
  let mail=null;
  if(eventType==='subscription.authenticated' && Number(sub?.start_at)>Date.now()/1000){
    mail={subject:'Your Leadvyne trial has started', heading:'Your free trial has started',
      bodyHtml:`<p>Your AutoPay mandate for <strong>${planName}</strong> is set up. Nothing is charged during the trial —
        the first charge of <strong>${esc(amount)}</strong> happens on <strong>${esc(fmtDate(sub.start_at))}</strong>.</p>
        <p>You'll also get a pre-debit notice from Razorpay before every charge. Cancel any time from the Billing page.</p>`,
      ctaLabel:'Manage subscription'};
  }else if(eventType==='subscription.charged'){
    mail={subject:`Payment received — ${amount}`, heading:'Payment received, thank you',
      bodyHtml:`<p>We've received <strong>${esc(amount)}</strong> for <strong>${planName}</strong>.</p>
        ${sub?.current_end?`<p>Your subscription renews next on <strong>${esc(fmtDate(sub.current_end))}</strong>.</p>`:''}`,
      ctaLabel:'View invoices'};
  }else if(eventType==='subscription.pending'){
    mail={subject:'Payment failed — action needed', heading:'We couldn\'t collect your payment',
      bodyHtml:`<p>The charge for <strong>${planName}</strong> didn't go through. Razorpay will retry automatically —
        please make sure your UPI / card / bank mandate is still active and has enough balance.</p>`,
      ctaLabel:'Open billing'};
  }else if(eventType==='subscription.halted'){
    mail={subject:'Your Leadvyne subscription is on hold', heading:'Your subscription is on hold',
      bodyHtml:`<p>We couldn't collect the payment for <strong>${planName}</strong> after several retries, so the
        subscription is on hold. Subscribe again from the Billing page to keep your account running.</p>`,
      ctaLabel:'Open billing'};
  }else if(eventType==='subscription.cancelled'){
    mail={subject:'Your Leadvyne subscription was cancelled', heading:'Subscription cancelled',
      bodyHtml:`<p>Your subscription to <strong>${planName}</strong> has been cancelled and won't be charged again.
        You can subscribe again any time from the Billing page.</p>`,
      ctaLabel:'Open billing'};
  }
  if(mail) await deps.sendBillingEmail(env, {to, ...mail, ctaUrl}).catch(()=>{});
}

// POST /billing/razorpay/webhook — public, signature-checked. Subscribe to the subscription.*
// events (see SETUP.md "Razorpay subscriptions").
export async function rzpHandleWebhook(request, env, deps){
  const json=deps.json;
  if(!env.RAZORPAY_WEBHOOK_SECRET) return json({error:'Webhook not configured'}, 500);
  const raw=await request.text();
  if(!await rzpVerifySignature(env.RAZORPAY_WEBHOOK_SECRET, raw, request.headers.get('X-Razorpay-Signature'))) return json({error:'Invalid signature'}, 400);
  let event; try{ event=JSON.parse(raw); }catch(e){ return json({error:'Bad payload'}, 400); }
  const eventType=String(event?.event||'');
  const eventId=request.headers.get('X-Razorpay-Event-Id')||'';
  await rzpEnsureSchema(env);
  if(await eventSeen(env, 'razorpay', eventId)) return json({received:true, duplicate:true});

  const sub=event?.payload?.subscription?.entity||null;
  const pay=event?.payload?.payment?.entity||null;
  let clientId=sub?.notes?.client_id||null;
  if(!clientId && sub?.id) clientId=(await deps.findClientByField(env, 'razorpay_subscription_id', sub.id))?.Id||null;
  let note='';
  if(sub && clientId && eventType.startsWith('subscription.')){
    const res=await rzpSyncSubscription(env, deps, clientId, sub);
    if(res.skipped) note=res.skipped;
    else if(res.ok){
      if(res.switched) note=res.switched;
      const c=await deps.getClientById(env, clientId);
      await sendLifecycleEmail(env, deps, c, eventType, sub, pay);
    }
  }else if(!clientId) note='no matching client';
  await logBillingEvent(env, {provider:'razorpay', event_id:eventId||null, event_type:eventType||'unknown', client_id:clientId,
    object_id:sub?.id||pay?.id||'', amount:pay?.amount??null, currency:pay?.currency||null, status:sub?.status||pay?.status||'', note});
  return json({received:true});
}

// ── Customer routes ──────────────────────────────────────────────────────────────────────────────
async function subscribe(request, env, deps, payload){
  const json=deps.json;
  const {plan_id}=await request.json().catch(()=>({}));
  const plan=await getPlanRow(env, plan_id);
  if(!plan||!plan.active) return json({error:'Unknown plan.'}, 400);
  const c=await deps.getClientById(env, payload.cid);
  if(!c) return json({error:'Client not found'}, 404);
  if(!c.billing_email) return json({error:'Set your Billing Email in Company Profile before subscribing.'}, 400);
  if(stripeLive(c) && !STRIPE_SWITCHABLE.includes(c.plan_status))
    return json({error:'You already have a card subscription (Stripe). Cancel it from the Customer Portal first, then subscribe with Razorpay.'}, 400);
  if(c.razorpay_subscription_id && !RZP_TERMINAL.includes(c.razorpay_status)){
    if(c.razorpay_status==='created'){
      // Link made but never authorised: reuse it for the same plan, else drop it and start over.
      if(c.razorpay_plan_id===plan.plan_id && c.razorpay_short_url) return json({ok:true, url:c.razorpay_short_url, subscription_id:c.razorpay_subscription_id, resumed:true});
      await rzpFetch(env, 'POST', `subscriptions/${c.razorpay_subscription_id}/cancel`, {cancel_at_cycle_end:0});
    }else return json({error:'You already have an active subscription — use Change plan instead.'}, 400);
  }
  const nowSec=Math.floor(Date.now()/1000);
  const trial=deps.trialDays>0 && c.razorpay_trial_used!=='Yes' && !c.stripe_subscription_id;
  const body={
    plan_id:plan.plan_id,
    total_count:RZP_TOTAL_COUNT[plan.period]||120,
    quantity:1,
    customer_notify:1,
    notes:{client_id:String(payload.cid), plan_tier:plan.plan_tier||'', source:'leadvyne'},
    notify_info:{notify_email:c.billing_email},
  };
  if(trial) body.start_at=nowSec+deps.trialDays*86400;
  const {ok, data, error}=await rzpFetch(env, 'POST', 'subscriptions', body);
  if(!ok||!data?.id) return json({error:'Failed to start subscription: '+(error||'unknown error')}, 502);
  const switching=stripeLive(c);
  await rzpSyncSubscription(env, deps, payload.cid, data, {force:true, cancelAtCycleEnd:false, linkOnly:switching});
  await logBillingEvent(env, {provider:'razorpay', event_type:switching?'checkout.started_switch_from_stripe':'checkout.started', client_id:payload.cid, object_id:data.id, amount:plan.amount, currency:plan.currency, status:data.status, note:`${plan.name}${trial?` · ${deps.trialDays}-day trial`:''}${switching?` · replacing Stripe ${c.stripe_subscription_id} (${c.plan_status})`:''}`});
  return json({ok:true, url:data.short_url, subscription_id:data.id, trial_days:trial?deps.trialDays:0});
}

async function pullSubscription(env, deps, clientId){
  const c=await deps.getClientById(env, clientId);
  if(!c) return {ok:false, status:404, error:'Client not found'};
  if(!c.razorpay_subscription_id) return {ok:false, status:404, error:'No Razorpay subscription for this account yet.'};
  const {ok, data, error}=await rzpFetch(env, 'GET', `subscriptions/${c.razorpay_subscription_id}`);
  if(!ok||!data?.id) return {ok:false, status:502, error:'Could not fetch the subscription from Razorpay: '+error};
  await rzpSyncSubscription(env, deps, clientId, data, {force:true});
  return {ok:true, sub:data};
}

// Links a subscription started outside the app (a subscription link made in the Razorpay Dashboard)
// to this client — billing-portal.js has already checked it belongs to them. Its plan is imported
// (inactive, so it's never offered in the plan picker) when it isn't in rzp_plans yet, so the tier
// and price still resolve; an abandoned, never-authorised link from our own checkout is cancelled
// so it can't be approved later and charge twice.
export async function rzpLinkSubscription(env, deps, clientId, sub){
  const c=await deps.getClientById(env, clientId);
  if(!c) return {ok:false, status:404, error:'Client not found'};
  if(sub.plan_id && !await getPlanRow(env, sub.plan_id)){
    const {ok, data}=await rzpFetch(env, 'GET', `plans/${encodeURIComponent(sub.plan_id)}`);
    if(ok && data?.id){
      const row=planFromRazorpay(data);
      row.plan_tier=deps.planTiers[row.plan_tier]?row.plan_tier:guessPlanTier(deps.planTiers, row.name, data.notes);
      await upsertPlan(env, {...row, active:false, sort_order:99});
    }
  }
  const old=String(c.razorpay_subscription_id||'');
  if(old && old!==sub.id && c.razorpay_status==='created')
    await rzpFetch(env, 'POST', `subscriptions/${old}/cancel`, {cancel_at_cycle_end:0}).catch(()=>{});
  const res=await rzpSyncSubscription(env, deps, clientId, sub, {force:true});
  return {...res, plan:await getPlanRow(env, sub.plan_id)};
}

function subSummary(sub, plan){
  return {id:sub.id, status:sub.status, plan_status:rzpPlanStatus(sub), plan_id:sub.plan_id, plan_name:plan?.name||sub.plan_id,
    amount:plan?.amount??null, currency:plan?.currency||'INR', period:plan?.period||'', interval_count:plan?.interval_count||1,
    current_start:sub.current_start||null, current_end:sub.current_end||null, charge_at:sub.charge_at||null, start_at:sub.start_at||null,
    paid_count:sub.paid_count??null, remaining_count:sub.remaining_count??null, total_count:sub.total_count??null,
    payment_method:sub.payment_method||'', short_url:sub.short_url||'', has_scheduled_changes:!!sub.has_scheduled_changes,
    change_scheduled_at:sub.change_scheduled_at||null};
}

async function cancelSub(env, deps, clientId, atCycleEnd){
  const c=await deps.getClientById(env, clientId);
  if(!c?.razorpay_subscription_id||RZP_TERMINAL.includes(c.razorpay_status)) return {ok:false, status:400, error:'No active Razorpay subscription.'};
  // A link that was never authorised has no cycle to wait out.
  const endOfCycle=!!atCycleEnd && !['created'].includes(c.razorpay_status);
  const {ok, data, error}=await rzpFetch(env, 'POST', `subscriptions/${c.razorpay_subscription_id}/cancel`, {cancel_at_cycle_end:endOfCycle?1:0});
  if(!ok||!data?.id) return {ok:false, status:502, error:'Razorpay refused the cancellation: '+error};
  await rzpSyncSubscription(env, deps, clientId, data, {force:true, cancelAtCycleEnd:endOfCycle?true:undefined});
  return {ok:true, sub:data, at_cycle_end:endOfCycle};
}

async function changePlan(env, deps, clientId, planId, when){
  const c=await deps.getClientById(env, clientId);
  if(!c?.razorpay_subscription_id||RZP_TERMINAL.includes(c.razorpay_status)) return {ok:false, status:400, error:'No active Razorpay subscription.'};
  const plan=await getPlanRow(env, planId);
  if(!plan||!plan.active) return {ok:false, status:400, error:'Unknown plan.'};
  if(plan.plan_id===c.razorpay_plan_id) return {ok:false, status:400, error:'Already on that plan.'};
  const schedule=when==='now'?'now':'cycle_end';
  // Razorpay only allows updates on card-mandate subscriptions; UPI/e-mandate ones get a clear
  // error back, in which case the customer cancels and subscribes to the new plan.
  const {ok, data, error}=await rzpFetch(env, 'PATCH', `subscriptions/${c.razorpay_subscription_id}`, {plan_id:plan.plan_id, schedule_change_at:schedule, customer_notify:1});
  if(!ok||!data?.id) return {ok:false, status:502, error:`Razorpay couldn't change the plan: ${error}. For UPI / bank mandates, cancel and subscribe to the new plan instead.`};
  await rzpSyncSubscription(env, deps, clientId, data, {force:true});
  return {ok:true, sub:data, scheduled:schedule==='cycle_end'};
}

async function listInvoices(env, clientId, deps){
  const c=await deps.getClientById(env, clientId);
  if(!c?.razorpay_subscription_id) return [];
  const {ok, data}=await rzpFetch(env, 'GET', `invoices?subscription_id=${encodeURIComponent(c.razorpay_subscription_id)}&count=50`);
  if(!ok) return [];
  return (data?.items||[]).map(i=>({id:i.id, status:i.status, amount:i.amount_paid||i.amount||0, currency:i.currency||'INR',
    date:i.paid_at||i.issued_at||i.date||i.created_at||null, billing_start:i.billing_start||null, billing_end:i.billing_end||null,
    payment_id:i.payment_id||'', short_url:i.short_url||''}));
}

// ── Admin ────────────────────────────────────────────────────────────────────────────────────────
async function importFromStripe(env, deps){
  if(!deps.stripeConfigured(env)) return {ok:false, status:400, error:'Stripe is not configured, so there is nothing to import.'};
  const prices=await deps.stripePlanPrices(env);
  const inr=prices.filter(p=>String(p.currency).toLowerCase()==='inr' && STRIPE_TO_RZP_PERIOD[p.interval]);
  const existing=await rzpListPlans(env);
  const created=[], skipped=[];
  for(const [i, p] of inr.entries()){
    const already=existing.find(e=>e.stripe_price_id===p.price_id);
    if(already){ skipped.push({price_id:p.price_id, plan_id:already.plan_id, reason:'already imported'}); continue; }
    const tier=guessPlanTier(deps.planTiers, p.name, p.metadata);
    const {ok, data, error}=await rzpFetch(env, 'POST', 'plans', {
      period:STRIPE_TO_RZP_PERIOD[p.interval], interval:Number(p.interval_count)||1,
      item:{name:p.name, amount:Number(p.unit_amount), currency:'INR', description:`Leadvyne ${deps.planTiers[tier]?.label||p.name}`},
      notes:{stripe_price_id:p.price_id, plan_tier:tier},
    });
    if(!ok||!data?.id){ skipped.push({price_id:p.price_id, reason:error||'Razorpay error'}); continue; }
    const row={...planFromRazorpay(data), plan_tier:tier, stripe_price_id:p.price_id, sort_order:i};
    await upsertPlan(env, row);
    created.push(row);
  }
  await logBillingEvent(env, {provider:'admin', event_type:'plans.import_stripe', note:`${created.length} created, ${skipped.length} skipped`});
  return {ok:true, created, skipped, stripe_inr_prices:inr.length};
}

async function addOrCreatePlan(env, deps, body){
  const tier=String(body.plan_tier||'');
  if(tier && !deps.planTiers[tier]) return {ok:false, status:400, error:'Unknown plan tier.'};
  if(body.plan_id){
    // Link a plan that already exists in the Razorpay Dashboard.
    const {ok, data, error}=await rzpFetch(env, 'GET', `plans/${encodeURIComponent(String(body.plan_id).trim())}`);
    if(!ok||!data?.id) return {ok:false, status:404, error:'Razorpay plan not found: '+error};
    const row={...planFromRazorpay(data), plan_tier:tier||data.notes?.plan_tier||'', sort_order:Number(body.sort_order)||0};
    await upsertPlan(env, row);
    return {ok:true, plan:row};
  }
  const name=String(body.name||'').trim().slice(0,120);
  const amount=Math.round(Number(body.amount_inr)*100);
  const period=['daily','weekly','monthly','yearly'].includes(body.period)?body.period:'monthly';
  const interval=Math.max(1, Math.min(12, Number(body.interval_count)||1));
  if(!name) return {ok:false, status:400, error:'Plan name is required.'};
  if(!(amount>=100)) return {ok:false, status:400, error:'Amount must be at least ₹1.'};
  if(period==='daily' && interval<7) return {ok:false, status:400, error:'Razorpay daily plans need an interval of at least 7 days.'};
  const {ok, data, error}=await rzpFetch(env, 'POST', 'plans', {period, interval, item:{name, amount, currency:'INR', description:`Leadvyne ${deps.planTiers[tier]?.label||name}`}, notes:{plan_tier:tier}});
  if(!ok||!data?.id) return {ok:false, status:502, error:'Razorpay refused the plan: '+error};
  const row={...planFromRazorpay(data), plan_tier:tier, sort_order:Number(body.sort_order)||0};
  await upsertPlan(env, row);
  await logBillingEvent(env, {provider:'admin', event_type:'plan.created', object_id:row.plan_id, amount:row.amount, currency:'INR', note:name});
  return {ok:true, plan:row};
}

async function updatePlan(env, deps, body){
  const row=await getPlanRow(env, body.plan_id);
  if(!row) return {ok:false, status:404, error:'Plan not found.'};
  if('plan_tier' in body && body.plan_tier && !deps.planTiers[body.plan_tier]) return {ok:false, status:400, error:'Unknown plan tier.'};
  const next={...row,
    plan_tier:'plan_tier' in body?String(body.plan_tier||''):row.plan_tier,
    active:'active' in body?!!body.active:row.active,
    sort_order:'sort_order' in body?Number(body.sort_order)||0:row.sort_order};
  await upsertPlan(env, next);
  return {ok:true, plan:next};
}

// Offline / bank-transfer customers, comps and corrections: set tier + status + renewal by hand.
async function manualPlan(env, deps, body){
  const cid=Number(body.client_id);
  if(!cid) return {ok:false, status:400, error:'client_id required'};
  const c=await deps.getClientById(env, cid);
  if(!c) return {ok:false, status:404, error:'Client not found'};
  const tier=String(body.plan_tier??c.plan_tier??'');
  if(tier && !deps.planTiers[tier]) return {ok:false, status:400, error:'Unknown plan tier.'};
  const status=String(body.plan_status||'active');
  if(!['active','trialing','past_due','paused','canceled'].includes(status)) return {ok:false, status:400, error:'Unknown status.'};
  let renews='';
  if(body.renews_at){
    const d=new Date(String(body.renews_at));
    if(isNaN(d.getTime())) return {ok:false, status:400, error:'Renewal date is not a valid date.'};
    renews=d.toISOString();
  }
  const gatewayLive=(c.razorpay_subscription_id && !RZP_TERMINAL.includes(c.razorpay_status))
    || (c.stripe_subscription_id && !STRIPE_TERMINAL.includes(c.plan_status));
  const patch={plan_tier:tier, plan_status:status, plan_renews_at:renews, plan_name:String(body.plan_name||deps.planTiers[tier]?.label||c.plan_name||'').slice(0,120),
    plan_cancel_at_period_end:'No', billing_admin_note:String(body.note||'').slice(0,500)};
  if(!gatewayLive) patch.billing_provider='manual';
  await ensureColumns(env, deps);
  await deps.patchClientFields(env, cid, patch);
  await logBillingEvent(env, {provider:'admin', event_type:'plan.manual_set', client_id:cid, status, note:`${tier||'legacy'}${renews?' until '+renews.slice(0,10):''}${body.note?' — '+body.note:''}`});
  return {ok:true, patch, gateway_live:!!gatewayLive};
}

export function providerOf(c){
  if(c.billing_provider) return c.billing_provider;
  if(c.razorpay_subscription_id) return 'razorpay';
  if(c.stripe_subscription_id) return 'stripe';
  return '';
}

export async function billingOverview(env, deps){
  const [clients, rzpPlans, stripePrices]=await Promise.all([
    deps.listAllClients(env),
    rzpListPlans(env).catch(()=>[]),
    deps.stripeConfigured(env)?deps.stripePlanPrices(env).catch(()=>[]):Promise.resolve([]),
  ]);
  const stripeBy={};
  for(const p of stripePrices){ stripeBy[p.price_id]=p; if(p.name) stripeBy[p.name]=p; }
  const nowMs=Date.now();
  const summary={total:clients.length, by_status:{}, by_provider:{}, mrr:{}, trialing:0, at_risk:0, cancel_scheduled:0, renewing_7d:0, paying:0};
  const rows=clients.map(c=>{
    const provider=providerOf(c);
    const status=c.plan_status||'none';
    let amount=null, currency='', period='', interval=1;
    if(provider==='razorpay'){
      const p=rzpPlans.find(x=>x.plan_id===c.razorpay_plan_id);
      if(p){ amount=p.amount; currency=p.currency; period=p.period; interval=p.interval_count; }
    }else if(provider==='stripe'){
      const p=stripeBy[c.plan_name];
      if(p){ amount=p.unit_amount; currency=String(p.currency).toUpperCase(); period=p.interval; interval=p.interval_count; }
    }
    const mrr=amount!=null?monthlyMinor(amount, period, interval):0;
    summary.by_status[status]=(summary.by_status[status]||0)+1;
    summary.by_provider[provider||'none']=(summary.by_provider[provider||'none']||0)+1;
    if(status==='active' && mrr && currency){ summary.mrr[currency]=(summary.mrr[currency]||0)+mrr; summary.paying++; }
    if(status==='trialing') summary.trialing++;
    if(['past_due','unpaid'].includes(status)) summary.at_risk++;
    if(c.plan_cancel_at_period_end==='Yes' && !['canceled','incomplete_expired'].includes(status)) summary.cancel_scheduled++;
    const renewMs=c.plan_renews_at?Date.parse(c.plan_renews_at):NaN;
    if(['active','trialing'].includes(status) && renewMs>=nowMs && renewMs-nowMs<=7*86400000) summary.renewing_7d++;
    return {
      Id:c.Id, client_name:c.client_name||'', authentik_email:c.authentik_email||'', billing_email:c.billing_email||'',
      active:c.active||'', plan_tier:c.plan_tier||'', provider, plan_name:c.plan_name||'', plan_status:c.plan_status||'',
      plan_renews_at:c.plan_renews_at||'', plan_cancel_at_period_end:c.plan_cancel_at_period_end||'',
      stripe_customer_id:c.stripe_customer_id||'', stripe_subscription_id:c.stripe_subscription_id||'',
      razorpay_subscription_id:c.razorpay_subscription_id||'', razorpay_customer_id:c.razorpay_customer_id||'',
      razorpay_plan_id:c.razorpay_plan_id||'', razorpay_status:c.razorpay_status||'', razorpay_short_url:c.razorpay_short_url||'',
      wa_credits_balance:Number(c.wa_credits_balance)||0, voice_addon_active:c.voice_addon_active||'No',
      billing_admin_note:c.billing_admin_note||'', amount, currency, period, interval_count:interval, mrr,
    };
  });
  return {ok:true, summary, clients:rows, razorpay_plans:rzpPlans, stripe_plans:stripePrices,
    gateways:{stripe:deps.stripeConfigured(env), razorpay:rzpConfigured(env), razorpay_mode:rzpMode(env)}};
}

async function timed(fn){
  const t=Date.now();
  try{ const r=await fn(); return {...r, ms:Date.now()-t}; }
  catch(e){ return {ok:false, error:String(e?.message||e), ms:Date.now()-t}; }
}
// Which platform secrets are set (never their values) + a live round trip to each gateway/API.
export async function apiStatus(env, deps){
  const has=k=>!!env[k];
  const stripeKey=String(env.STRIPE_SECRET_KEY||'');
  const [stripe, razorpay, nocodb, resend]=await Promise.all([
    has('STRIPE_SECRET_KEY')?timed(()=>deps.pingStripe(env)):{ok:false, skipped:true},
    rzpConfigured(env)?timed(async()=>{ const r=await rzpFetch(env, 'GET', 'plans?count=1'); return {ok:r.ok, error:r.ok?'':r.error}; }):{ok:false, skipped:true},
    has('NOCODB_TOKEN')?timed(()=>deps.pingNocodb(env)):{ok:false, skipped:true},
    has('RESEND_API_KEY')?timed(async()=>{ const r=await fetch('https://api.resend.com/domains', {headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`}}); return {ok:r.ok, error:r.ok?'':`HTTP ${r.status}`}; }):{ok:false, skipped:true},
  ]);
  const base=deps.webhookBase(env);
  let lastEvents={};
  try{
    await rzpEnsureSchema(env);
    const {results}=await env.DB.prepare(`SELECT provider, MAX(created_at) AS last_at, COUNT(*) AS n FROM billing_events WHERE created_at>=? GROUP BY provider`)
      .bind(new Date(Date.now()-30*86400000).toISOString()).all();
    for(const r of results||[]) lastEvents[r.provider]={last_at:r.last_at, count_30d:Number(r.n)};
  }catch(e){}
  return {ok:true, checked_at:new Date().toISOString(), services:[
    {key:'stripe', name:'Stripe (cards, global)', configured:has('STRIPE_SECRET_KEY'), mode:stripeKey.startsWith('sk_live_')||stripeKey.startsWith('rk_live_')?'live':stripeKey?'test':'',
      secrets:{STRIPE_SECRET_KEY:has('STRIPE_SECRET_KEY'), STRIPE_WEBHOOK_SECRET:has('STRIPE_WEBHOOK_SECRET'), STRIPE_PLAN_PRICE_IDS:has('STRIPE_PLAN_PRICE_IDS'), STRIPE_ADDON_PRICE_IDS:has('STRIPE_ADDON_PRICE_IDS')},
      check:stripe, webhook:{url:`${base}/billing/webhook`, events:['checkout.session.completed','checkout.session.expired','customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','customer.subscription.trial_will_end','invoice.payment_succeeded','invoice.payment_failed','invoice.payment_action_required']},
      last_event:lastEvents.stripe||null},
    {key:'razorpay', name:'Razorpay (India — UPI, cards, net-banking)', configured:rzpConfigured(env), mode:rzpMode(env),
      secrets:{RAZORPAY_KEY_ID:has('RAZORPAY_KEY_ID'), RAZORPAY_KEY_SECRET:has('RAZORPAY_KEY_SECRET'), RAZORPAY_WEBHOOK_SECRET:has('RAZORPAY_WEBHOOK_SECRET')},
      check:razorpay, webhook:{url:`${base}/billing/razorpay/webhook`, events:['subscription.authenticated','subscription.activated','subscription.charged','subscription.pending','subscription.halted','subscription.paused','subscription.resumed','subscription.cancelled','subscription.completed','subscription.updated']},
      last_event:lastEvents.razorpay||null},
    {key:'nocodb', name:'NocoDB (client records)', configured:has('NOCODB_TOKEN'), secrets:{NOCODB_TOKEN:has('NOCODB_TOKEN'), NOCODB_BASE:has('NOCODB_BASE')}, check:nocodb},
    {key:'resend', name:'Resend (billing & invite email)', configured:has('RESEND_API_KEY'), secrets:{RESEND_API_KEY:has('RESEND_API_KEY'), BILLING_FROM_EMAIL:has('BILLING_FROM_EMAIL')}, check:resend},
    {key:'platform', name:'Platform secrets', configured:has('SESSION_SIGNING_KEY')&&has('ADMIN_PASSCODE'),
      secrets:{SESSION_SIGNING_KEY:has('SESSION_SIGNING_KEY'), ADMIN_PASSCODE:has('ADMIN_PASSCODE'), AI_KEY_ENC_SECRET:has('AI_KEY_ENC_SECRET'), GEMINI_API_KEY:has('GEMINI_API_KEY'), META_APP_SECRET:has('META_APP_SECRET'), CHATWOOT_PLATFORM_TOKEN:has('CHATWOOT_PLATFORM_TOKEN')}},
  ]};
}

async function listEvents(env, url){
  await rzpEnsureSchema(env);
  const where=[], args=[];
  const provider=url.searchParams.get('provider'), cid=url.searchParams.get('client_id'), type=url.searchParams.get('type');
  if(provider){ where.push('provider=?'); args.push(provider); }
  if(cid){ where.push('client_id=?'); args.push(Number(cid)); }
  if(type){ where.push('event_type LIKE ?'); args.push(`%${type}%`); }
  const limit=Math.max(1, Math.min(500, Number(url.searchParams.get('limit'))||100));
  const {results}=await env.DB.prepare(`SELECT * FROM billing_events ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY id DESC LIMIT ${limit}`).bind(...args).all();
  return results||[];
}

async function adminSubscriptionAction(env, deps, body){
  const cid=Number(body.client_id);
  if(!cid) return {ok:false, status:400, error:'client_id required'};
  const c=await deps.getClientById(env, cid);
  if(!c) return {ok:false, status:404, error:'Client not found'};
  const action=String(body.action||'');
  let res;
  if(action==='sync') res=await pullSubscription(env, deps, cid);
  else if(action==='cancel_now') res=await cancelSub(env, deps, cid, false);
  else if(action==='cancel_cycle_end') res=await cancelSub(env, deps, cid, true);
  else if(action==='change_plan') res=await changePlan(env, deps, cid, body.plan_id, body.when);
  else if(action==='pause'||action==='resume'){
    if(!c.razorpay_subscription_id||RZP_TERMINAL.includes(c.razorpay_status)) return {ok:false, status:400, error:'No active Razorpay subscription.'};
    const r=await rzpFetch(env, 'POST', `subscriptions/${c.razorpay_subscription_id}/${action}`, action==='pause'?{pause_at:'now'}:{resume_at:'now'});
    if(!r.ok||!r.data?.id) return {ok:false, status:502, error:`Razorpay couldn't ${action} it: ${r.error}`};
    await rzpSyncSubscription(env, deps, cid, r.data, {force:true});
    res={ok:true, sub:r.data};
  }
  else return {ok:false, status:400, error:'Unknown action.'};
  if(res.ok) await logBillingEvent(env, {provider:'admin', event_type:`subscription.${action}`, client_id:cid, object_id:res.sub?.id||c.razorpay_subscription_id, status:res.sub?.status||'', note:body.plan_id?`→ ${body.plan_id} (${body.when||'cycle_end'})`:''});
  return res;
}

// ── Router ───────────────────────────────────────────────────────────────────────────────────────
// Handles /billing/razorpay/*, /admin/razorpay/*, /admin/billing/* and /admin/api-status.
// Returns null for a path it doesn't own.
export async function rzpHandleRoute(request, env, deps, url){
  const json=deps.json, p=url.pathname, m=request.method;
  const out=r=>r.ok?json(r):json({error:r.error}, r.status||400);

  if(p==='/billing/razorpay/webhook' && m==='POST') return rzpHandleWebhook(request, env, deps);

  if(p.startsWith('/billing/razorpay/')){
    const payload=await deps.requireSession(request, env);
    if(!payload) return json({error:'Invalid or expired session'}, 401);
    if(p==='/billing/razorpay/plans' && m==='GET'){
      if(!rzpConfigured(env)) return json({ok:true, enabled:false, plans:[]});
      const plans=await rzpListPlans(env, {activeOnly:true});
      return json({ok:true, enabled:plans.length>0, mode:rzpMode(env), trial_days:deps.trialDays, plans:plans.map(({stripe_price_id, active, sort_order, ...rest})=>rest)});
    }
    if(!rzpConfigured(env)) return json({error:'Razorpay is not configured on the server.'}, 500);
    if(p==='/billing/razorpay/subscribe' && m==='POST') return subscribe(request, env, deps, payload);
    if(p==='/billing/razorpay/status' && m==='GET'){
      const r=await pullSubscription(env, deps, payload.cid);
      if(!r.ok) return json({error:r.error}, r.status);
      return json({ok:true, subscription:subSummary(r.sub, await getPlanRow(env, r.sub.plan_id))});
    }
    if(p==='/billing/razorpay/cancel' && m==='POST'){
      const {at_cycle_end}=await request.json().catch(()=>({}));
      const r=await cancelSub(env, deps, payload.cid, at_cycle_end!==false);
      if(r.ok) await logBillingEvent(env, {provider:'razorpay', event_type:'subscription.cancel_requested', client_id:payload.cid, object_id:r.sub.id, status:r.sub.status, note:r.at_cycle_end?'at cycle end (customer)':'immediately (customer)'});
      return r.ok?json({ok:true, status:r.sub.status, at_cycle_end:r.at_cycle_end}):json({error:r.error}, r.status);
    }
    if(p==='/billing/razorpay/change-plan' && m==='POST'){
      const {plan_id, when}=await request.json().catch(()=>({}));
      const r=await changePlan(env, deps, payload.cid, plan_id, when);
      if(r.ok) await logBillingEvent(env, {provider:'razorpay', event_type:'subscription.change_requested', client_id:payload.cid, object_id:r.sub.id, note:`→ ${plan_id} (${when==='now'?'now':'cycle_end'})`});
      return r.ok?json({ok:true, scheduled:r.scheduled}):json({error:r.error}, r.status);
    }
    if(p==='/billing/razorpay/invoices' && m==='GET') return json({ok:true, invoices:await listInvoices(env, payload.cid, deps)});
    return json({error:'Not found'}, 404);
  }

  if(p.startsWith('/admin/razorpay/')||p.startsWith('/admin/billing/')||p==='/admin/api-status'){
    if(!await deps.requireAdminSession(request, env)) return json({error:'Invalid or expired admin session'}, 401);
    if(p==='/admin/api-status' && m==='GET') return json(await apiStatus(env, deps));
    if(p==='/admin/billing/overview' && m==='GET') return json(await billingOverview(env, deps));
    if(p==='/admin/billing/events' && m==='GET') return json({ok:true, events:await listEvents(env, url)});
    if(p==='/admin/billing/manual-plan' && m==='POST') return out(await manualPlan(env, deps, await request.json().catch(()=>({}))));
    if(p==='/admin/razorpay/plans' && m==='GET') return json({ok:true, configured:rzpConfigured(env), mode:rzpMode(env), plans:await rzpListPlans(env), tiers:Object.fromEntries(Object.entries(deps.planTiers).map(([k,t])=>[k,t.label]))});
    if(!rzpConfigured(env)) return json({error:'Razorpay is not configured — set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET (wrangler secret put).'}, 400);
    if(p==='/admin/razorpay/plans' && m==='POST') return out(await addOrCreatePlan(env, deps, await request.json().catch(()=>({}))));
    if(p==='/admin/razorpay/plans' && m==='PATCH') return out(await updatePlan(env, deps, await request.json().catch(()=>({}))));
    if(p==='/admin/razorpay/plans/import-stripe' && m==='POST') return out(await importFromStripe(env, deps));
    if(p==='/admin/razorpay/subscription' && m==='POST'){
      const r=await adminSubscriptionAction(env, deps, await request.json().catch(()=>({})));
      if(!r.ok) return json({error:r.error}, r.status||400);
      return json({ok:true, subscription:r.sub?subSummary(r.sub, await getPlanRow(env, r.sub.plan_id)):null, scheduled:r.scheduled||false});
    }
    if(p==='/admin/razorpay/invoices' && m==='GET'){
      const cid=Number(url.searchParams.get('client_id'));
      if(!cid) return json({error:'client_id required'}, 400);
      return json({ok:true, invoices:await listInvoices(env, cid, deps)});
    }
    return json({error:'Not found'}, 404);
  }
  return null;
}
