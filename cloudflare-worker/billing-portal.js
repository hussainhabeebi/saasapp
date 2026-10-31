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
//   POST /billing/portal/link-subscription  link a subscription paid outside the app (by its ID)
//   POST /admin/billing/link-subscription   same, for any client, from Admin → Billing
// Gateway state still comes from the existing syncs (worker.js Stripe module, razorpay-billing.js);
// this file only reads it, except cancel-feedback (an audit row) and stripe-change (a Portal link).
//
// deps (from worker.js): { json, requireSession, requireAdminSession, getClientById, findClientByField,
//   stripeFetch, stripeConfigured(env), stripePlanPrices(env), planTiers, planGatedModules,
//   supportContacts(env)→{email,whatsapp}, linkStripeSubscription(env, cid, sub),
//   rzpDeps()→RZP_DEPS, freshClient(env, cid)→client (uncached, re-cached) }

import {rzpFetch, rzpConfigured, rzpListPlans, rzpEnsureSchema, rzpLinkSubscription, logBillingEvent, guessPlanTier, RZP_TERMINAL} from './razorpay-billing.js';

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
  'razorpay:subscription.linked':['Subscription linked to your account', 'ok'],
  'stripe:subscription.linked':['Subscription linked to your account', 'ok'],
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

// ── Link a subscription by its ID ────────────────────────────────────────────────────────────────
// A subscription started outside the app — a Razorpay subscription link or a Stripe payment link
// the team sent — carries no client_id, so its webhooks match no account and the Billing page keeps
// saying "no plan". The customer pastes the subscription ID (sub_…) and it's linked here.
// Both gateways use the sub_ prefix, so the gateway is whichever one knows the ID.
//
// A customer can only link a subscription that is theirs: not already on another account, not
// created for another client, and paid with one of this account's emails (login, teammates or
// billing email). Admin skips the email/ownership checks (the team verified it some other way).
const LINKED_FIELDS=['billing_provider','plan_status','plan_name','plan_tier','plan_renews_at','plan_cancel_at_period_end',
  'razorpay_subscription_id','razorpay_plan_id','razorpay_status','razorpay_customer_id','stripe_subscription_id','stripe_customer_id'];
const SUB_ID_RE=/^sub_[A-Za-z0-9]{8,64}$/;
export function accountEmails(c){
  return new Set([c.authentik_email, c.billing_email, ...String(c.team_emails||'').split(',')]
    .map(e=>String(e||'').trim().toLowerCase()).filter(Boolean));
}
export function maskEmail(e){
  const [u, d]=String(e||'').split('@');
  if(!d) return '';
  return `${u.slice(0, 2)}${'*'.repeat(Math.max(1, Math.min(6, u.length-2)))}@${d}`;
}
async function fetchRzpSub(env, id){
  if(!rzpConfigured(env)) return null;
  const {ok, data}=await rzpFetch(env, 'GET', `subscriptions/${encodeURIComponent(id)}`);
  if(!ok||!data?.id) return null;
  const emails=[data.notify_info?.notify_email];
  if(data.customer_id){
    const r=await rzpFetch(env, 'GET', `customers/${encodeURIComponent(data.customer_id)}`);
    if(r.ok) emails.push(r.data?.email);
  }
  return {gateway:'razorpay', sub:data, owner:data.notes?.client_id||'', emails:emails.filter(Boolean),
    terminal:RZP_TERMINAL.includes(data.status), unpaid:data.status==='created', pay_url:data.short_url||'', field:'razorpay_subscription_id'};
}
async function fetchStripeSub(env, deps, id){
  if(!deps.stripeConfigured(env)) return null;
  const {ok, data}=await deps.stripeFetch(env, 'GET', `subscriptions/${id}`, {expand:['customer']});
  if(!ok||!data?.id) return null;
  return {gateway:'stripe', sub:data, owner:data.metadata?.client_id||'', emails:[data.customer?.email].filter(Boolean),
    terminal:['canceled','incomplete_expired'].includes(data.status), unpaid:data.status==='incomplete', pay_url:'', field:'stripe_subscription_id'};
}

export async function linkSubscription(env, deps, cid, body, {admin=false}={}){
  const id=String(body?.subscription_id||'').trim();
  if(!SUB_ID_RE.test(id)) return {ok:false, status:400, error:'Enter the subscription ID — it starts with sub_ (find it in the Razorpay / Stripe email or receipt).'};
  const c=await deps.getClientById(env, cid);
  if(!c) return {ok:false, status:404, error:'Client not found'};
  const want=['razorpay', 'stripe'].includes(body?.gateway)?body.gateway:'';
  // Razorpay IDs are sub_ + 14 characters, Stripe's are longer — try the likelier one first.
  const order=want?[want]:(id.length<=18?['razorpay', 'stripe']:['stripe', 'razorpay']);
  let found=null;
  for(const g of order){
    found=g==='razorpay'?await fetchRzpSub(env, id):await fetchStripeSub(env, deps, id);
    if(found) break;
  }
  if(!found) return {ok:false, status:404, error:`No subscription ${id} found${want?` on ${want==='razorpay'?'Razorpay':'Stripe'}`:''}. Check the ID and try again.`};

  const other=await deps.findClientByField(env, found.field, id);
  if(other && String(other.Id)!==String(cid)) return {ok:false, status:409, error:'That subscription is already linked to another account. Contact support if this is wrong.'};
  if(!admin){
    if(found.owner && String(found.owner)!==String(cid)) return {ok:false, status:403, error:'That subscription was started for another account. Contact support if this is wrong.'};
    const mine=accountEmails(c);
    if(!found.emails.some(e=>mine.has(String(e).trim().toLowerCase())))
      return {ok:false, status:403, error:found.emails.length
        ?`That subscription was paid with ${maskEmail(found.emails[0])}, which isn't one of this account's emails. Set it as your Billing Email (Company & GST details below) and try again, or contact support.`
        :'We couldn\'t confirm that subscription is yours (no email on it). Contact support and we\'ll link it for you.'};
    if(found.terminal) return {ok:false, status:400, error:`That subscription has already ended (${found.sub.status}). Subscribe again from the plans below.`};
  }
  // Not paid / authorised yet: linking it would change nothing a customer can see (the page only
  // counts a subscription once its mandate or first payment is through), so say what to do instead.
  if(!admin && found.unpaid) return {ok:false, status:400, unpaid:true, pay_url:found.pay_url,
    error:`That subscription hasn't been paid yet (${found.gateway==='razorpay'?'Razorpay':'Stripe'} status: ${found.sub.status}).${found.pay_url?' Complete the payment from its link, then link it again.':' Complete the payment first, then link it again.'} If you've already paid, check you used the subscription ID from the payment receipt.`};

  // Linking the same ID again just re-syncs it; the history row is written once (event_id dedupe).
  let price=null;
  if(found.gateway==='razorpay'){
    const r=await rzpLinkSubscription(env, deps.rzpDeps(), cid, found.sub);
    if(!r.ok) return {ok:false, status:r.status||502, error:r.error||'Could not link the subscription.'};
    if(r.plan) price={name:r.plan.name, amount:r.plan.amount, currency:r.plan.currency};
  }else{
    const r=await deps.linkStripeSubscription(env, cid, found.sub);
    if(r && r.ok===false) return {ok:false, status:502, error:r.error||'Could not link the subscription.'};
    const p=found.sub.items?.data?.[0]?.price;
    if(p) price={name:p.nickname||'', amount:p.unit_amount, currency:p.currency};
  }
  await logBillingEvent(env, {provider:found.gateway, event_id:`link:${cid}:${id}`, event_type:'subscription.linked', client_id:cid, object_id:id,
    amount:price?.amount??null, currency:price?.currency||null, status:found.sub.status||'',
    note:admin?'linked by admin':`linked by customer${found.emails[0]?` (${found.emails[0]})`:''}`});
  // The billing fields as saved, so the page can show the plan without another (possibly cached) read.
  const fresh=await deps.freshClient(env, cid).catch(()=>null);
  const client=fresh?Object.fromEntries(LINKED_FIELDS.map(k=>[k, fresh[k]??''])):null;
  return {ok:true, gateway:found.gateway, subscription_id:id, status:found.sub.status, plan_name:price?.name||'', unpaid:!!found.unpaid, client};
}

export const CANCEL_REASONS={too_expensive:'Too expensive', missing_features:'Missing features I need', not_using:'Not using it enough',
  switching:'Switching to another product', temporary:'Only needed it for a while', support:'Problems / support', other:'Other'};

export async function billingPortalHandleRoute(request, env, deps, url){
  const json=deps.json, p=url.pathname, m=request.method;
  const out=r=>r.ok?json(r):json({error:r.error, ...(r.pay_url?{pay_url:r.pay_url}:{})}, r.status||400);
  if(p==='/admin/billing/link-subscription' && m==='POST'){
    if(!await deps.requireAdminSession(request, env)) return json({error:'Invalid or expired admin session'}, 401);
    const body=await request.json().catch(()=>({}));
    if(!Number(body.client_id)) return json({error:'client_id required'}, 400);
    return out(await linkSubscription(env, deps, Number(body.client_id), body, {admin:true}));
  }
  if(!p.startsWith('/billing/portal/')) return null;
  const payload=await deps.requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);

  if(p==='/billing/portal/overview' && m==='GET'){
    const d=await overview(env, deps, payload.cid);
    return d?json(d):json({error:'Client not found'}, 404);
  }
  if(p==='/billing/portal/invoices' && m==='GET') return json({ok:true, invoices:await invoices(env, deps, payload.cid)});
  if(p==='/billing/portal/history' && m==='GET') return json({ok:true, events:await history(env, payload.cid)});
  if(p==='/billing/portal/link-subscription' && m==='POST') return out(await linkSubscription(env, deps, payload.cid, await request.json().catch(()=>({}))));
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
