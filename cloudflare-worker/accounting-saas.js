// SaaS billing on top of the ledger: plans, coupons, subscriptions (trials, proration, pause,
// cancel), a daily billing run that writes ordinary Invoices into accounting_documents, revenue
// recognition schedules, metered usage, MRR movement events, SaaS metrics, dunning / invoice
// reminders and payment-gateway settlements. Invoices it creates are indistinguishable from
// hand-made ones (Documents tab, PDFs, Mark Paid all work); acc_doc_meta links them back.
import {r2, num, str, todayStr, addDays, addMonths, daysBetween, monthsRange, monthEnd, INTERVAL_MONTHS, allRows, firstRow, dbBatch, audit,
  gstSplitFor, loadSources, invoiceBalances, getSettings, parseJson} from './accounting-core.js';
import {subMrr, profitAndLoss, cashPosition, burnRate} from './accounting-reports.js';
import {ensurePaymentLink} from './accounting-ops.js';

export class HttpError extends Error{ constructor(status, message){ super(message); this.status=status; } }
const need=(cond, msg, status=400)=>{ if(!cond) throw new HttpError(status, msg); };
const INTERVALS=Object.keys(INTERVAL_MONTHS);

/* ── Invoice writer (same columns/maths as worker.js handleAccountingDocumentCreate) ── */
export async function createInvoiceDoc(env, clientId, settings, {customer_name, customer_id=null, lead_id=null, title, lines, currency, gst_rate_pct=0, place_of_supply=null, recipient_gstin=null, date, due_date, notes='', status='sent'}){
  const subtotal=r2(lines.reduce((s,l)=>s+num(l.qty)*num(l.price),0));
  const rate=num(gst_rate_pct);
  const tax=r2(subtotal*rate/100);
  const {cgst, sgst, igst}=gstSplitFor(subtotal, rate, settings.state_code, place_of_supply);
  const r=await env.DB.prepare(`INSERT INTO accounting_documents (client_id, lead_id, type, title, line_items_json, currency, subtotal, tax_pct, tax_amount, total, status, notes, customer_name, customer_id, due_date, is_tax_invoice, gst_rate_pct, cgst_amount, sgst_amount, igst_amount, supplier_gstin, recipient_gstin, place_of_supply, supply_type, reverse_charge, doc_created_at)
    VALUES (?,?,'invoice',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`)
    .bind(clientId, lead_id, str(title,200), JSON.stringify(lines), str(currency||settings.base_currency,10), subtotal, rate, tax, r2(subtotal+tax), status, str(notes,1000), str(customer_name,200)||null, customer_id,
      due_date||null, rate?1:0, rate, cgst, sgst, igst, settings.gstin||null, recipient_gstin||null, place_of_supply||null, recipient_gstin?'B2B':'B2C', `${date}T00:00:00.000Z`).run();
  return {id:r.meta.last_row_id, subtotal, tax, total:r2(subtotal+tax)};
}
async function upsertDocMeta(env, clientId, docId, fields){
  const cols=Object.keys(fields);
  await env.DB.prepare(`INSERT INTO acc_doc_meta (client_id, doc_id, ${cols.join(',')}) VALUES (?,?,${cols.map(()=>'?').join(',')})
    ON CONFLICT(client_id, doc_id) DO UPDATE SET ${cols.map(c=>`${c}=excluded.${c}`).join(',')}`).bind(clientId, docId, ...cols.map(c=>fields[c])).run();
}
export {upsertDocMeta};

/* ── MRR events ── */
export async function recordEvent(env, clientId, sub, kind, before, after, date, note){
  const delta=r2(after-before); if(!delta && kind!=='churn') return;
  await env.DB.prepare(`INSERT INTO acc_sub_events (client_id, subscription_id, event_date, kind, mrr_delta, mrr_after, note) VALUES (?,?,?,?,?,?,?)`)
    .bind(clientId, sub.id, date||todayStr(), kind, delta, r2(after), note||null).run();
}
const getSub=async(env, clientId, id)=>{ const s=await firstRow(env, `SELECT * FROM acc_subscriptions WHERE id=? AND client_id=?`, Number(id), clientId); need(s, 'Subscription not found', 404); return s; };
async function saveSub(env, sub, fields){
  const cols=Object.keys(fields); if(!cols.length) return;
  await env.DB.prepare(`UPDATE acc_subscriptions SET ${cols.map(c=>`${c}=?`).join(', ')}, updated_at=? WHERE id=?`).bind(...cols.map(c=>fields[c]), new Date().toISOString(), sub.id).run();
  Object.assign(sub, fields);
}

/* ── Plans & coupons ── */
export async function plansList(c){ return {list:await allRows(c.env, `SELECT * FROM acc_plans WHERE client_id=? ORDER BY is_active DESC, name`, c.clientId)}; }
export async function planSave(c){
  const b=c.body; need(str(b.name), 'name required');
  const f={name:str(b.name,140), code:str(b.code,40)||null, amount:num(b.amount), currency:str(b.currency||c.settings.base_currency,10).toUpperCase(), interval:INTERVALS.includes(b.interval)?b.interval:'month',
    trial_days:Math.max(0, parseInt(b.trial_days)||0), gst_rate_pct:num(b.gst_rate_pct), sac_code:str(b.sac_code,20)||null, metered_unit_name:str(b.metered_unit_name,40)||null,
    metered_unit_price:num(b.metered_unit_price), included_units:num(b.included_units), is_active:b.is_active===false||b.is_active===0?0:1};
  if(b.id){
    await c.env.DB.prepare(`UPDATE acc_plans SET ${Object.keys(f).map(k=>`${k}=?`).join(',')} WHERE id=? AND client_id=?`).bind(...Object.values(f), Number(b.id), c.clientId).run();
    await audit(c.env, c.clientId, c.actor, 'plan_update', 'plan', b.id, f); return {ok:true, id:Number(b.id)};
  }
  const r=await c.env.DB.prepare(`INSERT INTO acc_plans (client_id, ${Object.keys(f).join(',')}, created_at) VALUES (?,${Object.keys(f).map(()=>'?').join(',')},?)`).bind(c.clientId, ...Object.values(f), new Date().toISOString()).run();
  await audit(c.env, c.clientId, c.actor, 'plan_create', 'plan', r.meta.last_row_id, f);
  return {ok:true, id:r.meta.last_row_id};
}
export async function couponsList(c){ return {list:await allRows(c.env, `SELECT * FROM acc_coupons WHERE client_id=? ORDER BY created_at DESC`, c.clientId)}; }
export async function couponSave(c){
  const b=c.body; need(str(b.code), 'code required');
  const f={code:str(b.code,40).toUpperCase(), kind:b.kind==='amount'?'amount':'pct', value:num(b.value), duration_months:Math.max(0, parseInt(b.duration_months)||0), max_redemptions:Math.max(0, parseInt(b.max_redemptions)||0), valid_till:b.valid_till?str(b.valid_till,10):null, is_active:b.is_active===false||b.is_active===0?0:1};
  need(f.kind!=='pct' || (f.value>0 && f.value<=100), 'Percentage must be between 0 and 100');
  if(b.id){ await c.env.DB.prepare(`UPDATE acc_coupons SET ${Object.keys(f).map(k=>`${k}=?`).join(',')} WHERE id=? AND client_id=?`).bind(...Object.values(f), Number(b.id), c.clientId).run(); return {ok:true}; }
  const r=await c.env.DB.prepare(`INSERT INTO acc_coupons (client_id, ${Object.keys(f).join(',')}, created_at) VALUES (?,${Object.keys(f).map(()=>'?').join(',')},?)`).bind(c.clientId, ...Object.values(f), new Date().toISOString()).run();
  return {ok:true, id:r.meta.last_row_id};
}

/* ── Subscriptions ── */
export async function subscriptionsList(c){
  const list=await allRows(c.env, `SELECT * FROM acc_subscriptions WHERE client_id=? ORDER BY CASE status WHEN 'past_due' THEN 0 WHEN 'suspended' THEN 1 WHEN 'trialing' THEN 2 WHEN 'active' THEN 3 ELSE 4 END, next_billing_date`, c.clientId);
  return {list:list.map(s=>({...s, mrr:subMrr(s)}))};
}
export async function subscriptionCreate(c){
  const b=c.body; const {env, clientId}=c;
  need(str(b.customer_name), 'customer_name required');
  const plan=b.plan_id?await firstRow(env, `SELECT * FROM acc_plans WHERE id=? AND client_id=?`, Number(b.plan_id), clientId):null;
  need(plan||b.amount!=null, 'Pick a plan or enter an amount');
  let coupon=null;
  if(b.coupon_code){
    coupon=await firstRow(env, `SELECT * FROM acc_coupons WHERE client_id=? AND code=? AND is_active=1`, clientId, str(b.coupon_code,40).toUpperCase());
    need(coupon, 'Coupon not found or inactive');
    need(!coupon.valid_till || coupon.valid_till>=todayStr(), 'Coupon has expired');
    need(!coupon.max_redemptions || coupon.redeemed<coupon.max_redemptions, 'Coupon has no redemptions left');
  }
  const start=str(b.start_date,10)||todayStr();
  const trialDays=b.trial_days!=null?Math.max(0, parseInt(b.trial_days)||0):(plan?.trial_days||0);
  const trialEnd=trialDays?addDays(start, trialDays):null;
  const s={
    customer_name:str(b.customer_name,200), customer_email:str(b.customer_email,200)||null, customer_phone:str(b.customer_phone,40)||null,
    fp_customer_id:b.fp_customer_id?Number(b.fp_customer_id):null, lead_id:b.lead_id?Number(b.lead_id):null,
    plan_id:plan?.id||null, plan_name:str(b.plan_name||plan?.name||'Subscription',140), amount:b.amount!=null&&b.amount!==''?num(b.amount):num(plan.amount),
    currency:str(b.currency||plan?.currency||c.settings.base_currency,10).toUpperCase(), interval:INTERVALS.includes(b.interval)?b.interval:(plan?.interval||'month'),
    quantity:Math.max(0, num(b.quantity)||1), coupon_id:coupon?.id||null,
    discount_pct:coupon?.kind==='pct'?num(coupon.value):num(b.discount_pct), discount_amount:coupon?.kind==='amount'?num(coupon.value):num(b.discount_amount),
    discount_months_left:coupon?(coupon.duration_months||-1):(num(b.discount_pct)||num(b.discount_amount)?(parseInt(b.discount_months)||-1):-1),
    start_date:start, trial_end:trialEnd, current_period_start:null, next_billing_date:trialEnd||start, status:trialEnd?'trialing':'active',
    gst_rate_pct:b.gst_rate_pct!=null&&b.gst_rate_pct!==''?num(b.gst_rate_pct):num(plan?.gst_rate_pct), place_of_supply:str(b.place_of_supply,10)||null, recipient_gstin:str(b.recipient_gstin,15)||null,
    auto_invoice:b.auto_invoice===false||b.auto_invoice===0?0:1, recognize_over_period:b.recognize_over_period===false||b.recognize_over_period===0?0:1, notes:str(b.notes,500)||null,
  };
  const now=new Date().toISOString();
  const r=await env.DB.prepare(`INSERT INTO acc_subscriptions (client_id, ${Object.keys(s).join(',')}, created_at, updated_at) VALUES (?,${Object.keys(s).map(()=>'?').join(',')},?,?)`).bind(clientId, ...Object.values(s), now, now).run();
  const sub={...s, id:r.meta.last_row_id};
  if(coupon) await env.DB.prepare(`UPDATE acc_coupons SET redeemed=redeemed+1 WHERE id=?`).bind(coupon.id).run();
  if(sub.status==='active') await recordEvent(env, clientId, sub, 'new', 0, subMrr(sub), start, 'Subscription started');
  await audit(env, clientId, c.actor, 'subscription_create', 'subscription', sub.id, s);
  if(b.bill_now && sub.status==='active' && sub.auto_invoice) await billSubscription(env, clientId, c.settings, sub, todayStr());
  return {ok:true, id:sub.id};
}
export async function subscriptionUpdate(c){
  const b=c.body; const sub=await getSub(c.env, c.clientId, b.id);
  const f={};
  for(const k of ['customer_name','customer_email','customer_phone','plan_name','place_of_supply','recipient_gstin','notes']) if(b[k]!==undefined) f[k]=str(b[k],200)||null;
  for(const k of ['gst_rate_pct']) if(b[k]!==undefined) f[k]=num(b[k]);
  for(const k of ['auto_invoice','recognize_over_period']) if(b[k]!==undefined) f[k]=b[k]?1:0;
  if(b.next_billing_date!==undefined) f.next_billing_date=str(b.next_billing_date,10)||null;
  await saveSub(c.env, sub, f);
  await audit(c.env, c.clientId, c.actor, 'subscription_update', 'subscription', sub.id, f);
  return {ok:true};
}
// Plan / price / quantity change mid-period. Unused time on the old price is credited and the
// remaining time on the new price is charged on one proration invoice (net negative → credit note).
export async function subscriptionChange(c){
  const {env, clientId, settings}=c; const b=c.body; const sub=await getSub(env, clientId, b.id);
  need(['active','past_due','trialing'].includes(sub.status), 'Only live subscriptions can be changed');
  const plan=b.plan_id?await firstRow(env, `SELECT * FROM acc_plans WHERE id=? AND client_id=?`, Number(b.plan_id), clientId):null;
  const before={...sub}; const oldMrr=subMrr(sub);
  const next={amount:b.amount!=null&&b.amount!==''?num(b.amount):(plan?num(plan.amount):sub.amount), quantity:b.quantity!=null&&b.quantity!==''?Math.max(0,num(b.quantity)):sub.quantity,
    plan_id:plan?.id||sub.plan_id, plan_name:plan?.name||sub.plan_name, interval:plan?.interval||sub.interval};
  need(next.interval===sub.interval, 'Changing the billing interval needs a cancel + new subscription');
  const t=str(b.effective_date,10)||todayStr();
  let proration=null;
  if(sub.status!=='trialing' && sub.current_period_start && sub.next_billing_date && b.prorate!==false){
    const span=Math.max(1, daysBetween(sub.current_period_start, sub.next_billing_date));
    const left=Math.max(0, daysBetween(t, sub.next_billing_date));
    const frac=left/span;
    const oldCharge=r2(num(before.amount)*num(before.quantity)*frac), newCharge=r2(num(next.amount)*num(next.quantity)*frac);
    const net=r2(newCharge-oldCharge);
    if(Math.abs(net)>=0.01){
      if(net>0){
        const inv=await createInvoiceDoc(env, clientId, settings, {customer_name:sub.customer_name, customer_id:sub.fp_customer_id, lead_id:sub.lead_id, title:`Proration — ${next.plan_name}`, currency:sub.currency,
          gst_rate_pct:sub.gst_rate_pct, place_of_supply:sub.place_of_supply, recipient_gstin:sub.recipient_gstin, date:t, due_date:addDays(t, settings.payment_terms_days||7),
          lines:[{name:`Unused time on ${before.plan_name} (${left}/${span} days)`, qty:1, price:-oldCharge}, {name:`Remaining time on ${next.plan_name} (${left}/${span} days)`, qty:1, price:newCharge}]});
        await upsertDocMeta(env, clientId, inv.id, {subscription_id:sub.id, period_start:t, period_end:addDays(sub.next_billing_date,-1)});
        proration={type:'invoice', id:inv.id, amount:inv.total};
      }else{
        const g=gstSplitFor(-net, sub.gst_rate_pct, settings.state_code, sub.place_of_supply);
        const tax=r2(g.cgst+g.sgst+g.igst);
        const r=await env.DB.prepare(`INSERT INTO acc_notes (client_id, note_type, note_date, party_name, linked_type, linked_id, reason, currency, subtotal, gst_rate_pct, cgst, sgst, igst, total, place_of_supply, recipient_gstin, status, notes, created_at) VALUES (?,'credit',?,?,?,?,'discount',?,?,?,?,?,?,?,?,?,'open',?,?)`)
          .bind(clientId, t, sub.customer_name, sub.last_invoice_id?'invoice':null, sub.last_invoice_id||null, sub.currency, -net, num(sub.gst_rate_pct), g.cgst, g.sgst, g.igst, r2(-net+tax), sub.place_of_supply, sub.recipient_gstin, `Downgrade proration — ${before.plan_name} → ${next.plan_name}`, new Date().toISOString()).run();
        proration={type:'credit_note', id:r.meta.last_row_id, amount:r2(-net+tax)};
      }
    }
  }
  await saveSub(env, sub, next);
  const newMrr=subMrr(sub);
  if(sub.status!=='trialing') await recordEvent(env, clientId, sub, newMrr>=oldMrr?'expansion':'contraction', oldMrr, newMrr, t, `${before.plan_name} ×${before.quantity} → ${next.plan_name} ×${next.quantity}`);
  await audit(env, clientId, c.actor, 'subscription_change', 'subscription', sub.id, {from:{amount:before.amount, quantity:before.quantity, plan:before.plan_name}, to:next, proration});
  return {ok:true, proration};
}
export async function subscriptionAction(c){
  const {env, clientId}=c; const b=c.body; const sub=await getSub(env, clientId, b.id);
  const t=str(b.date,10)||todayStr(); const mrr=subMrr(sub);
  if(b.action==='cancel'){
    if(b.at_period_end && sub.next_billing_date && sub.status!=='trialing'){ await saveSub(env, sub, {cancel_at:sub.next_billing_date, cancel_reason:str(b.reason,300)||null}); }
    else{ await saveSub(env, sub, {status:'cancelled', cancelled_at:t, cancel_at:null, cancel_reason:str(b.reason,300)||null}); if(mrr) await recordEvent(env, clientId, sub, 'churn', mrr, 0, t, str(b.reason,200)||'Cancelled'); }
  }else if(b.action==='undo_cancel'){ need(sub.status!=='cancelled', 'Already cancelled — create a new subscription'); await saveSub(env, sub, {cancel_at:null}); }
  else if(b.action==='pause'){ need(['active','past_due'].includes(sub.status), 'Only active subscriptions can be paused'); await saveSub(env, sub, {status:'paused'}); await recordEvent(env, clientId, sub, 'contraction', mrr, 0, t, 'Paused'); }
  else if(b.action==='resume'){
    need(['paused','suspended','cancelled'].includes(sub.status), 'Subscription is not paused');
    const nb=sub.next_billing_date && sub.next_billing_date>=t?sub.next_billing_date:t;
    await saveSub(env, sub, {status:'active', next_billing_date:nb, cancelled_at:null, cancel_at:null});
    await recordEvent(env, clientId, sub, sub.status==='cancelled'?'reactivation':'expansion', 0, subMrr(sub), t, 'Resumed');
  }else if(b.action==='bill_now'){
    need(['active','past_due'].includes(sub.status), 'Subscription is not active');
    if(sub.next_billing_date>t) await saveSub(env, sub, {next_billing_date:t});
    const res=await billSubscription(env, clientId, c.settings, sub, t);
    return {ok:true, invoices:res};
  }else throw new HttpError(400, 'Unknown action');
  await audit(env, clientId, c.actor, `subscription_${b.action}`, 'subscription', sub.id, {date:t, reason:b.reason||null});
  return {ok:true};
}

// Bill every period that has come due (catch-up capped at 24). Usage is billed in arrears for the
// period that just ended; plan price in advance for the period starting.
export async function billSubscription(env, clientId, settings, sub, asOf){
  const created=[]; let guard=0;
  const months=INTERVAL_MONTHS[sub.interval]||1;
  const plan=sub.plan_id?await firstRow(env, `SELECT * FROM acc_plans WHERE id=? AND client_id=?`, sub.plan_id, clientId):null;
  while(guard++<24 && sub.auto_invoice && ['trialing','active','past_due'].includes(sub.status) && sub.next_billing_date && sub.next_billing_date<=asOf){
    if(sub.status==='trialing'){
      if(sub.trial_end && sub.trial_end>asOf) break;
      await saveSub(env, sub, {status:'active', next_billing_date:sub.trial_end||sub.next_billing_date});
      await recordEvent(env, clientId, sub, 'new', 0, subMrr(sub), sub.next_billing_date, 'Trial converted');
    }
    if(sub.cancel_at && sub.cancel_at<=sub.next_billing_date){
      const mrr=subMrr(sub);
      await saveSub(env, sub, {status:'cancelled', cancelled_at:sub.cancel_at});
      if(mrr) await recordEvent(env, clientId, {...sub}, 'churn', mrr, 0, sub.cancel_at, sub.cancel_reason||'Cancelled at period end');
      break;
    }
    const ps=sub.next_billing_date, pe=addDays(addMonths(ps, months),-1);
    const base=r2(num(sub.amount)*num(sub.quantity));
    const lines=[{name:`${sub.plan_name} (${ps} → ${pe})`, qty:num(sub.quantity)||1, price:num(sub.amount), hsn:plan?.sac_code||''}];
    const discounted=(num(sub.discount_pct)||num(sub.discount_amount)) && sub.discount_months_left!==0;
    if(discounted){
      const disc=r2(base*num(sub.discount_pct)/100+num(sub.discount_amount));
      if(disc) lines.push({name:'Discount', qty:1, price:-Math.min(disc, base)});
    }
    // Metered usage for the period that just ended.
    if(plan?.metered_unit_price){
      const from=sub.current_period_start||sub.start_date;
      const usage=await allRows(env, `SELECT id, quantity FROM acc_usage_records WHERE client_id=? AND subscription_id=? AND billed_invoice_id IS NULL AND usage_date>=? AND usage_date<?`, clientId, sub.id, from, ps);
      const used=usage.reduce((s,u)=>s+num(u.quantity),0), over=Math.max(0, used-num(plan.included_units)*(num(sub.quantity)||1));
      if(over>0) lines.push({name:`${plan.metered_unit_name||'Usage'} overage ${from} → ${addDays(ps,-1)} (${used} used, ${num(plan.included_units)*(num(sub.quantity)||1)} included)`, qty:r2(over), price:num(plan.metered_unit_price)});
      sub._usageIds=usage.map(u=>u.id);
    }
    const inv=await createInvoiceDoc(env, clientId, settings, {customer_name:sub.customer_name, customer_id:sub.fp_customer_id, lead_id:sub.lead_id, title:`${sub.plan_name} — ${ps}`, lines, currency:sub.currency,
      gst_rate_pct:sub.gst_rate_pct, place_of_supply:sub.place_of_supply, recipient_gstin:sub.recipient_gstin, date:ps, due_date:addDays(ps, settings.payment_terms_days||7), notes:`Subscription #${sub.id}`});
    await upsertDocMeta(env, clientId, inv.id, {subscription_id:sub.id, period_start:ps, period_end:pe});
    if(sub._usageIds?.length) await dbBatch(env, sub._usageIds.map(id=>env.DB.prepare(`UPDATE acc_usage_records SET billed_invoice_id=? WHERE id=?`).bind(inv.id, id)));
    if(sub.recognize_over_period && months>1) await env.DB.prepare(`INSERT OR IGNORE INTO acc_revrec_schedules (client_id, invoice_id, start_month, months, created_at) VALUES (?,?,?,?,?)`).bind(clientId, inv.id, ps.slice(0,7), months, new Date().toISOString()).run();
    const before=subMrr(sub);
    const f={current_period_start:ps, next_billing_date:addMonths(ps, months), last_invoice_id:inv.id};
    if(discounted && sub.discount_months_left>0) f.discount_months_left=Math.max(0, sub.discount_months_left-months);
    await saveSub(env, sub, f);
    if(f.discount_months_left===0) await recordEvent(env, clientId, sub, 'expansion', before, subMrr(sub), f.next_billing_date, 'Discount ended');
    created.push({invoice_id:inv.id, total:inv.total, period_start:ps});
    if(settings.email_invoices && sub.customer_email) await emailInvoice(env, clientId, settings, sub, inv, ps).catch(()=>{});
  }
  return created;
}
let _deps=null; export function setSaasDeps(d){ _deps=d; }
async function emailInvoice(env, clientId, settings, sub, inv, ps){
  if(!_deps?.sendEmail) return;
  const link=await ensurePaymentLink(env, clientId, inv.id).catch(()=>null);
  const amt=`${sub.currency} ${inv.total.toLocaleString('en-IN',{maximumFractionDigits:2})}`;
  await _deps.sendEmail(env, clientId, {to:sub.customer_email, subject:`Invoice #${inv.id} — ${sub.plan_name}`,
    html:`<p>Hi ${esc(sub.customer_name)},</p><p>Your invoice #${inv.id} for <b>${esc(sub.plan_name)}</b> (period starting ${ps}) is ready: <b>${amt}</b>, due ${addDays(ps, settings.payment_terms_days||7)}.</p>${link?.url?`<p><a href="${esc(link.url)}">Pay online</a></p>`:''}${settings.upi_id?`<p>UPI: ${esc(settings.upi_id)}</p>`:''}<p>Thank you!</p>`});
}
const esc=s=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

export async function runBillingForClient(env, clientId, settings, asOf=todayStr()){
  const subs=await allRows(env, `SELECT * FROM acc_subscriptions WHERE client_id=? AND auto_invoice=1 AND status IN ('trialing','active','past_due') AND next_billing_date<=?`, clientId, asOf);
  const out=[];
  for(const s of subs){
    try{ const inv=await billSubscription(env, clientId, settings, s, asOf); if(inv.length) out.push({subscription_id:s.id, customer:s.customer_name, invoices:inv}); }
    catch(e){ out.push({subscription_id:s.id, customer:s.customer_name, error:String(e.message||e)}); }
  }
  // Subscriptions that reached cancel_at without a billing date passing.
  for(const s of await allRows(env, `SELECT * FROM acc_subscriptions WHERE client_id=? AND cancel_at IS NOT NULL AND cancel_at<=? AND status IN ('active','past_due','trialing')`, clientId, asOf)){
    const mrr=subMrr(s); await saveSub(env, s, {status:'cancelled', cancelled_at:s.cancel_at});
    if(mrr) await recordEvent(env, clientId, s, 'churn', mrr, 0, s.cancel_at, s.cancel_reason||'Cancelled at period end');
  }
  return out;
}
export async function billingRun(c){ const res=await runBillingForClient(c.env, c.clientId, c.settings, str(c.body.as_of,10)||todayStr()); await audit(c.env, c.clientId, c.actor, 'billing_run', 'subscription', null, {subscriptions:res.length}); return {ok:true, results:res}; }

/* ── Usage ── */
export async function usageList(c){
  const sid=c.url.searchParams.get('subscription_id');
  const list=sid?await allRows(c.env, `SELECT * FROM acc_usage_records WHERE client_id=? AND subscription_id=? ORDER BY usage_date DESC LIMIT 500`, c.clientId, Number(sid))
    :await allRows(c.env, `SELECT u.*, s.customer_name FROM acc_usage_records u LEFT JOIN acc_subscriptions s ON s.id=u.subscription_id WHERE u.client_id=? ORDER BY u.usage_date DESC LIMIT 500`, c.clientId);
  return {list};
}
export async function usageCreate(c){
  const b=c.body; const sub=await getSub(c.env, c.clientId, b.subscription_id);
  const rows=Array.isArray(b.records)?b.records:[b];
  const stmts=rows.filter(r=>num(r.quantity)).map(r=>c.env.DB.prepare(`INSERT INTO acc_usage_records (client_id, subscription_id, metric, quantity, usage_date, created_at) VALUES (?,?,?,?,?,?)`)
    .bind(c.clientId, sub.id, str(r.metric,60)||null, num(r.quantity), str(r.usage_date,10)||todayStr(), new Date().toISOString()));
  need(stmts.length, 'quantity required');
  await dbBatch(c.env, stmts);
  return {ok:true, count:stmts.length};
}

/* ── Revenue recognition schedules (any invoice can be deferred by hand too) ── */
export async function revrecList(c){
  const list=await allRows(c.env, `SELECT s.*, d.customer_name, d.subtotal, d.currency, d.title, d.doc_created_at FROM acc_revrec_schedules s LEFT JOIN accounting_documents d ON d.id=s.invoice_id WHERE s.client_id=? ORDER BY s.start_month DESC`, c.clientId);
  const cur=todayStr().slice(0,7);
  return {list:list.map(s=>{
    const done=monthsRange(s.start_month, cur).length; const recognisedMonths=Math.min(s.months, Math.max(0, done));
    const sub=num(s.subtotal);
    return {...s, recognised_months:recognisedMonths, recognised:r2(recognisedMonths>=s.months?sub:sub/s.months*recognisedMonths), deferred:r2(recognisedMonths>=s.months?0:sub-sub/s.months*recognisedMonths)};
  })};
}
export async function revrecSave(c){
  const b=c.body;
  const inv=await firstRow(c.env, `SELECT id FROM accounting_documents WHERE id=? AND client_id=? AND type='invoice'`, Number(b.invoice_id), c.clientId);
  need(inv, 'Invoice not found', 404);
  const months=Math.max(1, Math.min(120, parseInt(b.months)||12));
  const start=str(b.start_month,7); need(/^\d{4}-\d{2}$/.test(start), 'start_month must be YYYY-MM');
  await c.env.DB.prepare(`INSERT INTO acc_revrec_schedules (client_id, invoice_id, start_month, months, revenue_account_id, created_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(client_id, invoice_id) DO UPDATE SET start_month=excluded.start_month, months=excluded.months, revenue_account_id=excluded.revenue_account_id`)
    .bind(c.clientId, inv.id, start, months, b.revenue_account_id?Number(b.revenue_account_id):null, new Date().toISOString()).run();
  await audit(c.env, c.clientId, c.actor, 'revrec_schedule', 'invoice', inv.id, {start, months});
  return {ok:true};
}
export async function revrecDelete(c){
  await c.env.DB.prepare(`DELETE FROM acc_revrec_schedules WHERE client_id=? AND invoice_id=?`).bind(c.clientId, Number(c.body.invoice_id)).run();
  await audit(c.env, c.clientId, c.actor, 'revrec_delete', 'invoice', c.body.invoice_id, null);
  return {ok:true};
}

/* ── Metrics ── */
export async function computeSaasMetrics(env, clientId, sync){
  const {ctx, settings}=sync; const t=todayStr();
  const subs=await allRows(env, `SELECT * FROM acc_subscriptions WHERE client_id=?`, clientId);
  const events=await allRows(env, `SELECT * FROM acc_sub_events WHERE client_id=? ORDER BY event_date`, clientId);
  const live=subs.filter(s=>['active','past_due'].includes(s.status));
  const mrr=r2(live.reduce((s,x)=>s+subMrr(x),0));
  const months=monthsRange(addMonths(t.slice(0,7)+'-01',-11).slice(0,7), t.slice(0,7));
  const movement=months.map(m=>{
    const ev=events.filter(e=>e.event_date.slice(0,7)===m);
    const sum=k=>r2(ev.filter(e=>e.kind===k).reduce((s,e)=>s+num(e.mrr_delta),0));
    return {month:m, new:sum('new'), expansion:sum('expansion'), reactivation:sum('reactivation'), contraction:sum('contraction'), churn:sum('churn'),
      mrr_end:r2(events.filter(e=>e.event_date<=monthEnd(m)).reduce((s,e)=>s+num(e.mrr_delta),0))};
  });
  const start12=addMonths(t.slice(0,7)+'-01',-12);
  const mrrAt=d=>r2(events.filter(e=>e.event_date<d).reduce((s,e)=>s+num(e.mrr_delta),0));
  const startMrr=mrrAt(start12);
  const win=events.filter(e=>e.event_date>=start12);
  const sumK=(arr,k)=>r2(arr.filter(e=>e.kind===k).reduce((s,e)=>s+num(e.mrr_delta),0));
  // Trailing-12-month NRR/GRR from the MRR event log (expansion/contraction/churn of ALL
  // subscriptions in the window, so it slightly flatters a fast-growing book — labelled approx).
  const nrr=startMrr?r2((startMrr+sumK(win,'expansion')+sumK(win,'reactivation')+sumK(win,'contraction')+sumK(win,'churn'))/startMrr*100):null;
  const grr=startMrr?r2(Math.min(100, (startMrr+sumK(win,'contraction')+sumK(win,'churn'))/startMrr*100)):null;
  const d30=addDays(t,-30);
  const churned30=events.filter(e=>e.kind==='churn' && e.event_date>=d30);
  const new30=events.filter(e=>e.kind==='new' && e.event_date>=d30).length;
  const activeStart=Math.max(1, live.length+churned30.length-new30);
  const logoChurn=r2(churned30.length/activeStart*100);
  const mrr30=mrrAt(d30);
  const revenueChurn=mrr30?r2(-sumK(churned30,'churn')/mrr30*100):0;
  const arpu=live.length?r2(mrr/live.length):0;
  const from3=addMonths(t.slice(0,7)+'-01',-3), to3=addDays(t.slice(0,7)+'-01',-1);
  const pl=await profitAndLoss(env, clientId, ctx.accounts, {from:from3, to:to3});
  const gm=pl.revenue?pl.gross_profit/pl.revenue:null;
  const sm=r2(pl.sections.opex.filter(r=>r.subtype==='sales_marketing').reduce((s,r)=>s+r.amount,0));
  const new3=events.filter(e=>e.kind==='new' && e.event_date>=from3 && e.event_date<=to3).length;
  const cac=new3?r2(sm/new3):null;
  const monthlyChurnRate=logoChurn/100;
  const ltv=gm!=null && monthlyChurnRate>0?r2(arpu*gm/monthlyChurnRate):null;
  const payback=cac!=null && arpu && gm?r2(cac/(arpu*gm)):null;
  const cash=await cashPosition(env, clientId, ctx.accounts, t);
  const burn=await burnRate(env, clientId, ctx.accounts, 3);
  return {
    base_currency:settings.base_currency, mrr, arr:r2(mrr*12), active_subscriptions:live.length, trialing:subs.filter(s=>s.status==='trialing').length,
    past_due:subs.filter(s=>s.status==='past_due').length, suspended:subs.filter(s=>s.status==='suspended').length, arpu,
    nrr_pct:nrr, grr_pct:grr, logo_churn_30d_pct:logoChurn, revenue_churn_30d_pct:revenueChurn,
    gross_margin_pct:gm==null?null:r2(gm*100), sales_marketing_3m:sm, new_customers_3m:new3, cac, ltv, ltv_cac:ltv&&cac?r2(ltv/cac):null, cac_payback_months:payback,
    cash:cash.total, burn_rate:burn, runway_months:burn>0?r2(cash.total/burn):null,
    movement, renewals_30d:subs.filter(s=>['active','past_due'].includes(s.status) && s.next_billing_date && s.next_billing_date<=addDays(t,30)).map(s=>({id:s.id, customer:s.customer_name, date:s.next_billing_date, amount:r2(num(s.amount)*num(s.quantity)), currency:s.currency})).sort((a,b)=>a.date.localeCompare(b.date)),
    notes:'NRR/GRR are trailing-12-month approximations from the MRR event log. CAC = Sales & Marketing accounts ÷ new subscriptions over the last 3 full months. LTV = ARPU × gross margin ÷ monthly logo churn.',
  };
}
export async function subscriptionEvents(c){ return {list:await allRows(c.env, `SELECT e.*, s.customer_name, s.plan_name FROM acc_sub_events e LEFT JOIN acc_subscriptions s ON s.id=e.subscription_id WHERE e.client_id=? ORDER BY e.event_date DESC, e.id DESC LIMIT 300`, c.clientId)}; }

// Financial Planning's recurring customers → subscriptions (auto_invoice off, since FP's own
// monthly Expected Funds already bill them) so MRR / churn metrics see the whole recurring book.
export async function importFpCustomers(c){
  const {env, clientId}=c;
  const fp=await allRows(env, `SELECT * FROM fp_customers WHERE client_id=?`, clientId);
  const have=new Set((await allRows(env, `SELECT fp_customer_id FROM acc_subscriptions WHERE client_id=? AND fp_customer_id IS NOT NULL`, clientId)).map(r=>r.fp_customer_id));
  const map={monthly:'month', quarterly:'quarter', yearly:'year'};
  let n=0; const now=new Date().toISOString();
  for(const f of fp){
    if(have.has(f.id)) continue;
    const interval=map[f.billing_cycle]||'month'; const months=INTERVAL_MONTHS[interval];
    const status=f.status==='active'?'active':f.status==='paused'?'paused':'cancelled';
    const r=await env.DB.prepare(`INSERT INTO acc_subscriptions (client_id, customer_name, customer_email, customer_phone, fp_customer_id, lead_id, plan_name, amount, currency, interval, quantity, start_date, status, auto_invoice, recognize_over_period, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,0,0,?,?,?)`)
      .bind(clientId, f.name, f.email||null, f.phone||null, f.id, f.lead_id||null, f.plan_name||'Recurring', r2(num(f.monthly_value)*months), f.currency||c.settings.base_currency, interval, f.start_date||todayStr(), status, 'Imported from Financial Planning (billed there)', now, now).run();
    const sub={id:r.meta.last_row_id, status, amount:r2(num(f.monthly_value)*months), quantity:1, interval, discount_months_left:-1};
    await recordEvent(env, clientId, sub, 'new', 0, num(f.monthly_value), f.start_date||todayStr(), 'Imported');
    if(status==='cancelled') await recordEvent(env, clientId, sub, 'churn', num(f.monthly_value), 0, todayStr(), 'Imported as cancelled');
    n++;
  }
  await audit(env, clientId, c.actor, 'import_fp_customers', 'subscription', null, {imported:n});
  return {ok:true, imported:n};
}

/* ── Dunning & invoice reminders (daily) ── */
export async function runCollectionsForClient(env, clientId, deps, opts={}){
  const settings=await getSettings(env, clientId);
  const src=await loadSources(env, clientId);
  const bal=invoiceBalances(src);
  const t=opts.asOf||todayStr();
  const subs=await allRows(env, `SELECT * FROM acc_subscriptions WHERE client_id=?`, clientId);
  const subById={}; for(const s of subs) subById[s.id]=s;
  const logs=await allRows(env, `SELECT invoice_id, step FROM acc_reminder_log WHERE client_id=?`, clientId);
  const done=new Set(logs.map(l=>`${l.invoice_id}|${l.step}`));
  const fpEmails={}; for(const f of await allRows(env, `SELECT id, name, email FROM fp_customers WHERE client_id=?`, clientId)){ if(f.email){ fpEmails['id:'+f.id]=f.email; fpEmails['n:'+String(f.name).toLowerCase()]=f.email; } }
  const sent=[]; const overdueBySub={};
  const D=settings.dunning, R=settings.reminders;
  for(const b of Object.values(bal)){
    if(b.balance<=0.009) continue;
    const inv=b.invoice, meta=src.docMeta[inv.id]||{}, sub=meta.subscription_id?subById[meta.subscription_id]:null;
    const due=inv.due_date||String(inv.doc_created_at).slice(0,10);
    const od=daysBetween(due, t);
    if(sub && od>0) overdueBySub[sub.id]=Math.max(overdueBySub[sub.id]||0, od);
    let step=null;
    if(sub && D.enabled){ const d=[...(D.reminder_days||[])].map(Number).sort((a,b)=>b-a).find(d=>od>=d); if(d!=null) step=`dunning_${d}`; }
    else if(!sub && R.enabled){ const o=[...(R.offsets||[])].map(Number).sort((a,b)=>b-a).find(o=>od>=o); if(o!=null) step=`reminder_${o}`; }
    if(!step || done.has(`${inv.id}|${step}`)) continue;
    const email=sub?.customer_email||fpEmails['id:'+inv.customer_id]||fpEmails['n:'+String(inv.customer_name||'').toLowerCase()];
    const useEmail=sub?D.email:R.email, useWa=sub?D.whatsapp:R.whatsapp;
    const link=await ensurePaymentLink(env, clientId, inv.id).catch(()=>null);
    const amt=`${inv.currency||settings.base_currency} ${b.balance.toLocaleString('en-IN',{maximumFractionDigits:2})}`;
    const when=od>0?`was due on ${due} (${od} day${od===1?'':'s'} ago)`:od===0?'is due today':`is due on ${due}`;
    const text=`Hi ${inv.customer_name||''}, a friendly reminder that invoice #${inv.id} for ${amt} ${when}.${link?.url?` Pay here: ${link.url}`:''}${settings.upi_id?` UPI: ${settings.upi_id}`:''} Thank you!`;
    const results=[];
    if(useEmail && email && deps?.sendEmail){
      const r=await deps.sendEmail(env, clientId, {to:email, subject:`Payment reminder — Invoice #${inv.id}`, html:`<p>${esc(text).replace(/(https?:\/\/\S+)/g,'<a href="$1">$1</a>')}</p>`}).catch(e=>({ok:false, error:e.message}));
      results.push(['email', r?.ok?'sent':'failed', r?.error]);
    }
    if(useWa && inv.lead_id && deps?.sendWhatsApp){
      const r=await deps.sendWhatsApp(env, clientId, inv.lead_id, text).catch(e=>({ok:false, error:e.message}));
      results.push(['whatsapp', r?.ok?'sent':'failed', r?.error]);
    }
    if(!results.length) results.push(['none','skipped', email||inv.lead_id?'Channel not configured':'No email or WhatsApp lead on file for this customer']);
    const now=new Date().toISOString();
    await dbBatch(env, results.map(([ch,st,detail])=>env.DB.prepare(`INSERT INTO acc_reminder_log (client_id, invoice_id, subscription_id, step, channel, status, detail, created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(clientId, inv.id, sub?.id||null, step, ch, st, detail?String(detail).slice(0,300):null, now)));
    sent.push({invoice_id:inv.id, step, results});
  }
  // Subscription status from overdue subscription invoices.
  for(const s of subs){
    const od=overdueBySub[s.id]||0; const mrr=subMrr(s);
    if(['active','past_due'].includes(s.status) && od>=num(D.suspend_after_days||0) && D.suspend_after_days>0){
      await saveSub(env, s, {status:'suspended'}); await recordEvent(env, clientId, s, 'churn', mrr, 0, t, `Suspended — invoice ${od} days overdue`);
    }else if(s.status==='active' && od>0) await saveSub(env, s, {status:'past_due'});
    else if(s.status==='past_due' && !od) await saveSub(env, s, {status:'active'});
    else if(s.status==='suspended' && !od){ await saveSub(env, s, {status:'active'}); await recordEvent(env, clientId, s, 'reactivation', 0, subMrr(s), t, 'Paid — reactivated'); }
  }
  return {sent};
}
export async function remindersLog(c){ return {list:await allRows(c.env, `SELECT l.*, d.customer_name, d.total FROM acc_reminder_log l LEFT JOIN accounting_documents d ON d.id=l.invoice_id WHERE l.client_id=? ORDER BY l.created_at DESC LIMIT 300`, c.clientId)}; }
export async function runCollectionsNow(c){ return {ok:true, ...(await runCollectionsForClient(c.env, c.clientId, c.deps))}; }

/* ── Payment gateway settlements ── */
export async function settlementsList(c){ return {list:await allRows(c.env, `SELECT * FROM acc_gateway_settlements WHERE client_id=? ORDER BY settlement_date DESC LIMIT 500`, c.clientId)}; }
export async function settlementSave(c){
  const b=c.body; need(str(b.settlement_ref) && b.settlement_date, 'settlement_ref and settlement_date required');
  const gross=num(b.gross), fee=num(b.fee), tax=num(b.tax_on_fee); const net=b.net!=null&&b.net!==''?num(b.net):r2(gross-fee-tax);
  need(Math.abs(r2(gross-fee-tax-net))<0.02, `Net (${net}) must equal gross − fee − tax (${r2(gross-fee-tax)})`);
  const f=[str(b.gateway||'razorpay',30), str(b.settlement_ref,80), str(b.settlement_date,10), gross, fee, tax, net, b.bank_account_id?Number(b.bank_account_id):null, str(b.notes,300)||null];
  if(b.id){ await c.env.DB.prepare(`UPDATE acc_gateway_settlements SET gateway=?, settlement_ref=?, settlement_date=?, gross=?, fee=?, tax_on_fee=?, net=?, bank_account_id=?, notes=? WHERE id=? AND client_id=?`).bind(...f, Number(b.id), c.clientId).run(); }
  else await c.env.DB.prepare(`INSERT INTO acc_gateway_settlements (client_id, gateway, settlement_ref, settlement_date, gross, fee, tax_on_fee, net, bank_account_id, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(c.clientId, ...f, new Date().toISOString()).run();
  await audit(c.env, c.clientId, c.actor, b.id?'settlement_update':'settlement_create', 'settlement', b.id||f[1], {gross, fee, tax, net});
  return {ok:true};
}
export async function settlementDelete(c){ await c.env.DB.prepare(`DELETE FROM acc_gateway_settlements WHERE id=? AND client_id=?`).bind(Number(c.body.id), c.clientId).run(); await audit(c.env, c.clientId, c.actor, 'settlement_delete', 'settlement', c.body.id, null); return {ok:true}; }
// CSV from the gateway dashboard (Razorpay "Settlements" export or any similar sheet): header row
// is matched loosely — id/utr/ref, date/settled, amount/gross, fee, tax, net.
export async function settlementImport(c){
  const rows=parseCsv(String(c.body.csv||''));
  need(rows.length>1, 'CSV needs a header row and at least one data row');
  const h=rows[0].map(x=>x.toLowerCase().trim());
  const col=(...names)=>h.findIndex(x=>names.some(n=>x===n||x.includes(n)));
  const iRef=col('settlement_id','settlement id','utr','reference','ref','id'), iDate=col('settled_at','settlement date','date','created_at');
  const iGross=col('gross','amount'), iFee=col('fee'), iTax=col('tax'), iNet=col('net','settled amount','credited');
  need(iRef>=0 && iDate>=0 && (iGross>=0||iNet>=0), 'Could not find reference, date and amount columns');
  let n=0, skipped=0;
  for(const r of rows.slice(1)){
    if(!r[iRef]) continue;
    const date=normDate(r[iDate]); if(!date){ skipped++; continue; }
    let gross=num(r[iGross]), fee=iFee>=0?num(r[iFee]):0, tax=iTax>=0?num(r[iTax]):0, net=iNet>=0?num(r[iNet]):r2(gross-fee-tax);
    if(iGross<0) gross=r2(net+fee+tax);
    // Razorpay exports paise in some reports — a fee larger than the gross means the units differ; skip rather than guess.
    if(fee>gross){ skipped++; continue; }
    try{
      await c.env.DB.prepare(`INSERT INTO acc_gateway_settlements (client_id, gateway, settlement_ref, settlement_date, gross, fee, tax_on_fee, net, bank_account_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .bind(c.clientId, str(c.body.gateway||'razorpay',30), str(r[iRef],80), date, r2(gross), r2(fee), r2(tax), r2(net), c.body.bank_account_id?Number(c.body.bank_account_id):null, new Date().toISOString()).run();
      n++;
    }catch(e){ skipped++; }
  }
  await audit(c.env, c.clientId, c.actor, 'settlement_import', 'settlement', null, {imported:n, skipped});
  return {ok:true, imported:n, skipped};
}
export function parseCsv(text){
  const out=[]; let row=[], cell='', q=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(q){ if(ch==='"'){ if(text[i+1]==='"'){ cell+='"'; i++; } else q=false; } else cell+=ch; }
    else if(ch==='"') q=true; else if(ch===','){ row.push(cell); cell=''; }
    else if(ch==='\n'||ch==='\r'){ if(ch==='\r'&&text[i+1]==='\n') i++; row.push(cell); if(row.some(x=>x.trim())) out.push(row); row=[]; cell=''; }
    else cell+=ch;
  }
  row.push(cell); if(row.some(x=>x.trim())) out.push(row);
  return out.map(r=>r.map(x=>x.trim()));
}
export function normDate(s){
  s=String(s||'').trim(); if(!s) return null;
  let m=s.match(/^(\d{4})-(\d{2})-(\d{2})/); if(m) return `${m[1]}-${m[2]}-${m[3]}`;
  m=s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/); if(m){ const y=m[3].length===2?'20'+m[3]:m[3]; return `${y}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`; }
  const d=new Date(s); return isNaN(d)?null:d.toISOString().slice(0,10);
}
export {parseJson};
