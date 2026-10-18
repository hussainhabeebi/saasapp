// ── Customer billing portal (dashboard.html → Billing) ──────────────────────────────────────────
// One read model for the Billing page across both gateways, so the page shows the same sections
// whether the client pays through Stripe, Razorpay or a manual (admin-set) plan:
//   GET  /billing/portal/overview        plan summary (readable name, price, status, next charge),
//                                        payment method (+ card expiry warning), plan comparison
//                                        with each tier's price, GST details, support contacts
//   GET  /billing/portal/invoices        Stripe + Razorpay invoices in one list
//   GET  /billing/portal/history         billing timeline built from billing_events
//   POST /billing/portal/cancel-feedback why a customer is leaving (Admin → event log)
//   POST /billing/portal/stripe-change   Stripe Portal deep link to confirm a specific plan
// Gateway state still comes from the existing syncs (worker.js Stripe module, razorpay-billing.js);
// this file only reads it, except cancel-feedback (an audit row) and stripe-change (a Portal link).
//
// deps (from worker.js): { json, requireSession, getClientById, stripeFetch, stripeConfigured(env),
//   stripePlanPrices(env), planTiers, planGatedModules, supportContacts(env)→{email,whatsapp} }

import {rzpFetch, rzpConfigured, rzpListPlans, rzpEnsureSchema, logBillingEvent, guessPlanTier, RZP_TERMINAL} from './razorpay-billing.js';

const STRIPE_INTERVAL={day:'daily', week:'weekly', month:'monthly', year:'yearly'};

// Customer-facing words for every plan_status value either gateway writes.
export const STATUS_LABELS={
  active:{label:'Active', tone:'ok'}, trialing:{label:'Free trial', tone:'trial'},
  past_due:{label:'Payment retrying', tone:'warn'}, unpaid:{label:'Action needed', tone:'bad'},
  incomplete:{label:'Awaiting payment', tone:'warn'}, incomplete_expired:{label:'Expired', tone:'off'},
  paused:{label:'Paused', tone:'off'}, canceled:{label:'Cancelled', tone:'off'},
};
export function statusInfo(s){ return STATUS_LABELS[s]||{label:s?String(s).replace(/_/g,' '):'No plan', tone:'off'}; }

export function providerOf(c){
  if(c.billing_provider) return c.billing_provider;
  if(c.razorpay_subscription_id) return 'razorpay';
  if(c.stripe_subscription_id) return 'stripe';
  return '';
}

// A card that expires before (or within 45 days of) the next charge is worth a warning.
export function cardExpiringSoon(expMonth, expYear, now=new Date()){
  if(!expMonth||!expYear) return false;
  const lastDay=new Date(Date.UTC(Number(expYear), Number(expMonth), 0, 23, 59, 59));
  return lastDay.getTime()-now.getTime() < 45*86400000;
}

function stripeMethod(pm){
  if(!pm) return null;
  if(pm.card) return {type:'card', brand:pm.card.brand||'card', last4:pm.card.last4||'', exp_month:pm.card.exp_month, exp_year:pm.card.exp_year,
    expiring_soon:cardExpiringSoon(pm.card.exp_month, pm.card.exp_year), gateway:'stripe'};
  if(pm.type) return {type:pm.type, gateway:'stripe'};
  return null;
}
function rzpMethod(sub){
  const t=String(sub?.payment_method||'');
  if(!t) return null;
  return {type:t==='emandate'?'netbanking':t, gateway:'razorpay'};
}

// Every tier with its limits, included modules and the price it sells for per currency — Razorpay
// plans for INR when Razorpay is set up (that's what an Indian customer is offered), else Stripe.
export function buildTierCatalog(planTiers, planGatedModules, rzpPlans, stripePrices, useRazorpay){
  const out=Object.entries(planTiers).map(([key, t])=>({key, label:t.label, max_users:t.max_users, max_channels:t.max_channels,
    modules:t.modules.map(m=>planGatedModules[m]||m), prices:{}}));
  const byKey=Object.fromEntries(out.map(t=>[t.key, t]));
  for(const p of stripePrices||[]){
    const tier=guessPlanTier(planTiers, p.name, p.metadata);
    const cur=String(p.currency||'').toUpperCase();
    if(!byKey[tier]||!STRIPE_INTERVAL[p.interval]) continue;
    if(cur==='INR' && useRazorpay) continue;
    if(!byKey[tier].prices[cur]) byKey[tier].prices[cur]={amount:p.unit_amount, currency:cur, period:STRIPE_INTERVAL[p.interval], interval_count:p.interval_count||1, gateway:'stripe', id:p.price_id};
  }
  if(useRazorpay) for(const p of rzpPlans||[]){
    if(!p.active||!byKey[p.plan_tier]||byKey[p.plan_tier].prices.INR) continue;
    byKey[p.plan_tier].prices.INR={amount:p.amount, currency:'INR', period:p.period, interval_count:p.interval_count, gateway:'razorpay', id:p.plan_id};
  }
  return out;
}

async function overview(env, deps, cid){
  const c=await deps.getClientById(env, cid);
  if(!c) return null;
  const provider=providerOf(c);
  const useRzp=rzpConfigured(env);
  const [rzpPlans, stripePrices]=await Promise.all([
    useRzp?rzpListPlans(env, {activeOnly:true}).catch(()=>[]):[],
    deps.stripeConfigured(env)?deps.stripePlanPrices(env).catch(()=>[]):[],
  ]);
  const tierKey=String(c.plan_tier||'').trim();
  const plan={name:c.plan_name||'', tier:deps.planTiers[tierKey]?tierKey:'', tier_label:deps.planTiers[tierKey]?.label||'Legacy',
    amount:null, currency:'', period:'', interval_count:1};
  let method=null, trialEnd=null;

  if(provider==='stripe' && c.stripe_subscription_id && deps.stripeConfigured(env)){
    const {ok, data:sub}=await deps.stripeFetch(env, 'GET', `subscriptions/${c.stripe_subscription_id}`,
      {expand:['default_payment_method','items.data.price.product','customer.invoice_settings.default_payment_method']});
    if(ok && sub?.id){
      const price=sub.items?.data?.[0]?.price;
      if(price){
        plan.name=price.nickname||price.product?.name||plan.name;
        plan.amount=price.unit_amount; plan.currency=String(price.currency||'').toUpperCase();
        plan.period=STRIPE_INTERVAL[price.recurring?.interval]||''; plan.interval_count=price.recurring?.interval_count||1;
        if(!plan.tier){ const g=guessPlanTier(deps.planTiers, plan.name, {...(price.product?.metadata||{}), ...(price.metadata||{})}); if(g){ plan.tier=g; plan.tier_label=deps.planTiers[g].label; } }
      }
      method=stripeMethod(sub.default_payment_method||sub.customer?.invoice_settings?.default_payment_method);
      trialEnd=sub.trial_end?new Date(sub.trial_end*1000).toISOString():null;
    }
  }else if(provider==='razorpay' && c.razorpay_subscription_id){
    const p=rzpPlans.find(x=>x.plan_id===c.razorpay_plan_id)||(await rzpListPlans(env).catch(()=>[])).find(x=>x.plan_id===c.razorpay_plan_id);
    if(p){ plan.name=p.name; plan.amount=p.amount; plan.currency=p.currency; plan.period=p.period; plan.interval_count=p.interval_count; }
    if(useRzp && !RZP_TERMINAL.includes(c.razorpay_status)){
      const {ok, data:sub}=await rzpFetch(env, 'GET', `subscriptions/${c.razorpay_subscription_id}`);
      if(ok && sub?.id){
        method=rzpMethod(sub);
        if(sub.status==='authenticated' && Number(sub.start_at)>Date.now()/1000) trialEnd=new Date(Number(sub.start_at)*1000).toISOString();
      }
    }
  }
  if(!plan.name && plan.tier) plan.name=plan.tier_label;
  // A raw Stripe price id is never a name a customer should see.
  if(/^price_/.test(plan.name)) plan.name=plan.tier?plan.tier_label:'Your plan';

  const status=c.plan_status||'';
  return {
    ok:true, provider, status, status_info:statusInfo(status),
    has_plan:!!provider && !['canceled','incomplete_expired',''].includes(status) && !(provider==='razorpay' && ['created',...RZP_TERMINAL].includes(c.razorpay_status)),
    plan, renews_at:c.plan_renews_at||'', cancel_at_period_end:c.plan_cancel_at_period_end==='Yes', trial_end:trialEnd,
    payment_method:method,
    tiers:buildTierCatalog(deps.planTiers, deps.planGatedModules, rzpPlans, stripePrices, useRzp),
    gst:{gstin:c.gstin||'', billing_state:c.billing_state||''},
    support:deps.supportContacts(env),
  };
}

async function invoices(env, deps, cid){
  const c=await deps.getClientById(env, cid);
  if(!c) return [];
  const out=[];
  if(c.stripe_customer_id && deps.stripeConfigured(env)){
    const {ok, data}=await deps.stripeFetch(env, 'GET', 'invoices', {customer:c.stripe_customer_id, limit:24});
    if(ok) for(const i of data?.data||[]){
      if(i.status==='draft') continue;
      out.push({gateway:'stripe', id:i.id, number:i.number||'', date:i.status_transitions?.paid_at||i.created, amount:i.status==='paid'?i.amount_paid:i.amount_due,
        currency:String(i.currency||'').toUpperCase(), status:i.status, url:i.hosted_invoice_url||'', pdf:i.invoice_pdf||''});
    }
  }
  if(c.razorpay_subscription_id && rzpConfigured(env)){
    const {ok, data}=await rzpFetch(env, 'GET', `invoices?subscription_id=${encodeURIComponent(c.razorpay_subscription_id)}&count=50`);
    if(ok) for(const i of data?.items||[]){
      out.push({gateway:'razorpay', id:i.id, number:i.invoice_number||i.receipt||'', date:i.paid_at||i.issued_at||i.date||i.created_at,
        amount:i.amount_paid||i.amount||0, currency:String(i.currency||'INR').toUpperCase(), status:i.status, url:i.short_url||'', pdf:''});
    }
  }
  return out.sort((a, b)=>Number(b.date||0)-Number(a.date||0));
}

// billing_events → a customer-readable timeline. Internal-only rows (admin notes, deleted clients,
// raw subscription.updated noise) are left out; admin actions show as "by Leadvyne", never the note.
const HISTORY_MAP={
  'razorpay:checkout.started':['Subscription started', 'info'],
  'razorpay:checkout.started_switch_from_stripe':['Started switching to UPI / Indian payment', 'info'],
  'razorpay:subscription.authenticated':['AutoPay mandate approved', 'ok'],
  'razorpay:subscription.activated':['Subscription active', 'ok'],
  'razorpay:subscription.charged':['Payment received', 'ok'],
  'razorpay:subscription.pending':['Payment failed — retrying', 'warn'],
  'razorpay:subscription.halted':['Subscription on hold — payment failed', 'bad'],
  'razorpay:subscription.paused':['Subscription paused', 'info'],
  'razorpay:subscription.resumed':['Subscription resumed', 'ok'],
  'razorpay:subscription.cancelled':['Subscription cancelled', 'info'],
  'razorpay:subscription.completed':['Subscription completed', 'info'],
  'razorpay:subscription.cancel_requested':['Cancellation requested', 'info'],
  'razorpay:subscription.change_requested':['Plan change requested', 'info'],
  'stripe:checkout.session.completed':['Checkout completed', 'ok'],
  'stripe:invoice.payment_succeeded':['Payment received', 'ok'],
  'stripe:invoice.payment_failed':['Payment failed', 'warn'],
  'stripe:invoice.payment_action_required':['Bank confirmation needed', 'warn'],
  'stripe:customer.subscription.trial_will_end':['Trial ending soon', 'info'],
  'stripe:customer.subscription.deleted':['Subscription cancelled', 'info'],
  'admin:plan.manual_set':['Plan updated by Leadvyne', 'info'],
  'admin:subscription.pause':['Subscription paused by Leadvyne', 'info'],
  'admin:subscription.resume':['Subscription resumed by Leadvyne', 'ok'],
  'admin:subscription.cancel_now':['Subscription cancelled by Leadvyne', 'info'],
  'admin:subscription.cancel_cycle_end':['Set to end at the period end by Leadvyne', 'info'],
  'admin:subscription.change_plan':['Plan changed by Leadvyne', 'info'],
  'admin:stripe.cancelled_after_switch':['Moved from card (Stripe) to Razorpay', 'ok'],
};
export function historyEntry(row){
  const m=HISTORY_MAP[`${row.provider}:${row.event_type}`];
  if(!m) return null;
  return {date:row.created_at, title:m[0], tone:m[1], amount:row.amount??null, currency:row.currency||'',
    gateway:row.provider==='admin'?'':row.provider};
}
async function history(env, cid){
  await rzpEnsureSchema(env);
  const {results}=await env.DB.prepare(`SELECT * FROM billing_events WHERE client_id=? ORDER BY id DESC LIMIT 80`).bind(Number(cid)).all();
  return (results||[]).map(historyEntry).filter(Boolean).slice(0, 40);
}

export const CANCEL_REASONS={too_expensive:'Too expensive', missing_features:'Missing features I need', not_using:'Not using it enough',
  switching:'Switching to another product', temporary:'Only needed it for a while', support:'Problems / support', other:'Other'};

export async function billingPortalHandleRoute(request, env, deps, url){
  const json=deps.json, p=url.pathname, m=request.method;
  if(!p.startsWith('/billing/portal/')) return null;
  const payload=await deps.requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);

  if(p==='/billing/portal/overview' && m==='GET'){
    const d=await overview(env, deps, payload.cid);
    return d?json(d):json({error:'Client not found'}, 404);
  }
  if(p==='/billing/portal/invoices' && m==='GET') return json({ok:true, invoices:await invoices(env, deps, payload.cid)});
  if(p==='/billing/portal/history' && m==='GET') return json({ok:true, events:await history(env, payload.cid)});
  if(p==='/billing/portal/cancel-feedback' && m==='POST'){
    const {reason, detail, outcome}=await request.json().catch(()=>({}));
    if(!CANCEL_REASONS[reason]) return json({error:'Pick a reason.'}, 400);
    const c=await deps.getClientById(env, payload.cid);
    await logBillingEvent(env, {provider:'customer', event_type:'cancel.feedback', client_id:payload.cid, status:String(outcome||'').slice(0, 40),
      note:`${CANCEL_REASONS[reason]}${detail?` — ${String(detail).slice(0, 400)}`:''}${payload.email?` (${payload.email})`:''}`, object_id:c?.razorpay_subscription_id||c?.stripe_subscription_id||''});
    return json({ok:true});
  }
  if(p==='/billing/portal/stripe-change' && m==='POST'){
    const {price_id}=await request.json().catch(()=>({}));
    if(!deps.stripeConfigured(env)) return json({error:'Stripe is not configured on the server.'}, 500);
    const allowed=(env.STRIPE_PLAN_PRICE_IDS||'').split(',').map(s=>s.trim()).filter(Boolean);
    if(!allowed.includes(price_id)) return json({error:'Unknown plan.'}, 400);
    const c=await deps.getClientById(env, payload.cid);
    if(!c?.stripe_customer_id||!c.stripe_subscription_id) return json({error:'No card subscription to change.'}, 400);
    // Straight to Stripe's "confirm this plan change" screen; Portal setups without plan switching
    // enabled reject that flow, so fall back to the Portal's home page.
    let r=null;
    const sub=await deps.stripeFetch(env, 'GET', `subscriptions/${c.stripe_subscription_id}`);
    const itemId=sub.ok?sub.data?.items?.data?.[0]?.id:null;
    if(itemId) r=await deps.stripeFetch(env, 'POST', 'billing_portal/sessions', {customer:c.stripe_customer_id, return_url:env.APP_BASE_URL,
      flow_data:{type:'subscription_update_confirm', subscription_update_confirm:{subscription:c.stripe_subscription_id, items:[{id:itemId, price:price_id, quantity:1}]}}});
    if(!r?.ok||!r.data?.url) r=await deps.stripeFetch(env, 'POST', 'billing_portal/sessions', {customer:c.stripe_customer_id, return_url:env.APP_BASE_URL});
    if(!r.ok||!r.data?.url) return json({error:'Could not open the billing portal: '+(r.data?.error?.message||'unknown error')}, 502);
    return json({ok:true, url:r.data.url});
  }
  return json({error:'Not found'}, 404);
}
