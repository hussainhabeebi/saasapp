// Accounting operations: recurring journals, bank-feed categorisation rules, expense approvals,
// fixed assets, payroll, budgets, cost allocation, payment links (Razorpay) + UPI, the public
// client portal, Tally/CSV exports, and the AI / anomaly / unit-economics features.
import {r2, num, str, todayStr, addDays, addMonths, daysBetween, monthEnd, monthsRange, fiscalYear, INTERVAL_MONTHS, allRows, firstRow, dbBatch, audit, randomToken,
  getSettings, loadAccountContext, loadSources, invoiceBalances, insertJournal, isLocked, depreciationSchedule, makeFx, docDate, accountTotals, naturalBalance,
  expenseAccountFor, suggestAccountKey, SOURCE_LABELS, POSTABLE_INVOICE} from './accounting-core.js';
import {profitAndLoss, arAging, ownerDashboard, partyBalances} from './accounting-reports.js';

class HttpError extends Error{ constructor(status, message){ super(message); this.status=status; } }
const need=(c, m, s=400)=>{ if(!c) throw new HttpError(s, m); };
const lockCheck=(settings, date)=>{ if(isLocked(settings, date)) throw new HttpError(409, `The books are locked up to ${settings.lock_date}.`); };
const xmlEsc=s=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
let _deps={}; export function setOpsDeps(d){ _deps=d||{}; }

/* ── Payment links (Razorpay) + UPI ── */
// Creates (once) a Razorpay Payment Link for an invoice's open balance using the client's own
// Razorpay keys (Financial Planning → Settings). The existing /financial/razorpay-webhook route
// marks the invoice paid when `payment_link.paid` arrives with notes.acc_invoice_id.
export async function ensurePaymentLink(env, clientId, invoiceId, {force=false}={}){
  const meta=await firstRow(env, `SELECT payment_link_url, payment_link_id FROM acc_doc_meta WHERE client_id=? AND doc_id=?`, clientId, invoiceId);
  if(meta?.payment_link_url && !force) return {url:meta.payment_link_url, id:meta.payment_link_id, existing:true};
  const cfg=await firstRow(env, `SELECT razorpay_key_id, razorpay_key_secret FROM fp_config WHERE client_id=?`, clientId);
  if(!cfg?.razorpay_key_id || !cfg?.razorpay_key_secret) return null;
  const src=await loadSources(env, clientId); const bal=invoiceBalances(src)[invoiceId];
  if(!bal || bal.balance<=0) return null;
  const inv=bal.invoice;
  const cust=inv.customer_id?await firstRow(env, `SELECT email, phone FROM fp_customers WHERE id=? AND client_id=?`, inv.customer_id, clientId):null;
  const body={amount:Math.round(bal.balance*100), currency:String(inv.currency||'INR').toUpperCase(), accept_partial:false, reference_id:`acc-${invoiceId}-${Date.now().toString(36)}`,
    description:`Invoice #${invoiceId}${inv.title?' — '+String(inv.title).slice(0,60):''}`, customer:{name:inv.customer_name||'', ...(cust?.email?{email:cust.email}:{}), ...(cust?.phone?{contact:cust.phone}:{})},
    notify:{sms:false, email:false}, reminder_enable:false, notes:{acc_invoice_id:String(invoiceId), acc_client_id:String(clientId)}};
  const r=await fetch('https://api.razorpay.com/v1/payment_links', {method:'POST', headers:{'Content-Type':'application/json', Authorization:'Basic '+btoa(`${cfg.razorpay_key_id}:${cfg.razorpay_key_secret}`)}, body:JSON.stringify(body)});
  const data=await r.json().catch(()=>({}));
  if(!r.ok || !data.short_url) throw new HttpError(502, data?.error?.description||`Razorpay HTTP ${r.status}`);
  await env.DB.prepare(`INSERT INTO acc_doc_meta (client_id, doc_id, payment_link_id, payment_link_url) VALUES (?,?,?,?) ON CONFLICT(client_id, doc_id) DO UPDATE SET payment_link_id=excluded.payment_link_id, payment_link_url=excluded.payment_link_url`)
    .bind(clientId, invoiceId, data.id, data.short_url).run();
  return {url:data.short_url, id:data.id};
}
export function upiLink(settings, amount, note){
  if(!settings.upi_id) return null;
  return `upi://pay?pa=${encodeURIComponent(settings.upi_id)}&pn=${encodeURIComponent(settings.upi_name||settings.business_name||'')}&am=${r2(amount).toFixed(2)}&cu=INR&tn=${encodeURIComponent(note||'')}`;
}
export async function paymentLinkCreate(c){
  const id=Number(c.body.invoice_id);
  const inv=await firstRow(c.env, `SELECT id, total, currency FROM accounting_documents WHERE id=? AND client_id=? AND type='invoice'`, id, c.clientId); need(inv, 'Invoice not found', 404);
  const link=await ensurePaymentLink(c.env, c.clientId, id, {force:!!c.body.force});
  const bal=invoiceBalances(await loadSources(c.env, c.clientId))[id];
  await audit(c.env, c.clientId, c.actor, 'payment_link', 'invoice', id, link);
  return {ok:true, payment_link:link, razorpay_configured:!!link, upi:bal?upiLink(c.settings, bal.balance, `Invoice ${id}`):null, balance:bal?.balance??null};
}
// Called from worker.js's Razorpay webhook for payment_link.paid carrying our notes.
export async function onRazorpayPaymentLinkPaid(env, clientId, notes, deps){
  const invoiceId=Number(notes?.acc_invoice_id); if(!invoiceId || String(notes?.acc_client_id)!==String(clientId)) return false;
  const inv=await firstRow(env, `SELECT * FROM accounting_documents WHERE id=? AND client_id=? AND type='invoice'`, invoiceId, clientId);
  if(!inv || inv.status==='paid') return !!inv;
  await env.DB.prepare(`UPDATE accounting_documents SET status='paid' WHERE id=?`).bind(invoiceId).run();
  if(!inv.paid_recorded_at && deps?.recordInvoicePaid) await deps.recordInvoicePaid(env, clientId, {...inv, status:'paid'}, {payment_mode:'other'});
  await audit(env, clientId, 'razorpay', 'invoice_paid_online', 'invoice', invoiceId, null);
  return true;
}

/* ── Client portal ── */
export async function portalTokens(c){ return {list:await allRows(c.env, `SELECT * FROM acc_portal_tokens WHERE client_id=? ORDER BY created_at DESC`, c.clientId)}; }
export async function portalTokenCreate(c){
  const name=str(c.body.customer_name,200); need(name, 'customer_name required');
  const existing=await firstRow(c.env, `SELECT token FROM acc_portal_tokens WHERE client_id=? AND customer_name=? AND revoked=0`, c.clientId, name);
  if(existing) return {ok:true, token:existing.token};
  const token=randomToken(20);
  await c.env.DB.prepare(`INSERT INTO acc_portal_tokens (token, client_id, customer_name, revoked, created_at) VALUES (?,?,?,0,?)`).bind(token, c.clientId, name, new Date().toISOString()).run();
  await audit(c.env, c.clientId, c.actor, 'portal_token_create', 'portal', name, null);
  return {ok:true, token};
}
export async function portalTokenRevoke(c){ await c.env.DB.prepare(`UPDATE acc_portal_tokens SET revoked=1 WHERE token=? AND client_id=?`).bind(str(c.body.token,64), c.clientId).run(); await audit(c.env, c.clientId, c.actor, 'portal_token_revoke', 'portal', null, null); return {ok:true}; }
// Public (no session): the token is the credential. Only this customer's own documents.
export async function portalView(env, token, deps){
  const t=await firstRow(env, `SELECT * FROM acc_portal_tokens WHERE token=? AND revoked=0`, str(token,64));
  if(!t) throw new HttpError(404, 'This link is no longer valid.');
  const clientId=t.client_id, settings=await getSettings(env, clientId), name=String(t.customer_name).toLowerCase();
  const src=await loadSources(env, clientId); const bal=invoiceBalances(src);
  const mine=d=>String(d.customer_name||'').toLowerCase()===name;
  const client=deps?.getClientById?await deps.getClientById(env, clientId).catch(()=>null):null;
  const invoices=src.docs.filter(d=>d.type==='invoice' && POSTABLE_INVOICE.has(d.status) && mine(d)).sort((a,b)=>docDate(b).localeCompare(docDate(a))).map(d=>{
    const b=bal[d.id]||{balance:0, paid:0};
    let lines=[]; try{ lines=JSON.parse(d.line_items_json||'[]'); }catch(_){}
    return {id:d.id, title:d.title, date:docDate(d), due_date:d.due_date, currency:d.currency||settings.base_currency, subtotal:d.subtotal, tax:r2(num(d.total)-num(d.subtotal)), total:d.total, paid:b.paid, balance:b.balance,
      status:b.balance<=0.009?'paid':(d.due_date && d.due_date<todayStr()?'overdue':'open'), lines:lines.map(l=>({name:l.name, qty:l.qty, price:l.price})),
      payment_link:src.docMeta[d.id]?.payment_link_url||null, upi:b.balance>0?upiLink(settings, b.balance, `Invoice ${d.id}`):null};
  });
  const receipts=src.docs.filter(d=>d.type==='receipt' && d.status!=='void' && mine(d)).map(d=>({id:d.id, date:docDate(d), amount:d.total, currency:d.currency, invoice_id:d.linked_doc_id}));
  const credits=src.notes.filter(n=>n.note_type==='credit' && n.status!=='void' && String(n.party_name||'').toLowerCase()===name).map(n=>({id:n.id, date:n.note_date, amount:n.total, currency:n.currency, reason:n.reason, invoice_id:n.linked_id}));
  const subs=(await allRows(env, `SELECT plan_name, amount, quantity, currency, interval, status, next_billing_date FROM acc_subscriptions WHERE client_id=? AND LOWER(customer_name)=?`, clientId, name));
  return {business:{name:settings.business_name||client?.client_name||'', gstin:settings.gstin||'', logo:client?.quote_logo_url||'', upi_id:settings.upi_id||''},
    customer:t.customer_name, base_currency:settings.base_currency, invoices, receipts, credit_notes:credits, subscriptions:subs,
    outstanding:r2(invoices.reduce((s,i)=>s+i.balance,0))};
}

/* ── Recurring journals ── */
export async function recurringList(c){ return {list:await allRows(c.env, `SELECT * FROM acc_recurring_journals WHERE client_id=? ORDER BY is_active DESC, next_date`, c.clientId)}; }
export async function recurringSave(c){
  const b=c.body; need(str(b.name) && b.next_date, 'name and next_date required');
  const lines=(Array.isArray(b.lines)?b.lines:[]).map(l=>({account_id:Number(l.account_id), debit:r2(l.debit), credit:r2(l.credit), description:str(l.description,200), party_name:str(l.party_name,140)})).filter(l=>l.account_id&&(l.debit||l.credit));
  need(lines.length>=2, 'At least two lines');
  need(Math.abs(r2(lines.reduce((s,l)=>s+l.debit-l.credit,0)))<0.005, 'Debits must equal credits');
  const freq=['week','month','quarter','half_year','year'].includes(b.frequency)?b.frequency:'month';
  const f=[str(b.name,140), freq, str(b.next_date,10), str(b.end_date,10)||null, str(b.memo,300)||null, JSON.stringify(lines), b.is_active===false||b.is_active===0?0:1];
  if(b.id) await c.env.DB.prepare(`UPDATE acc_recurring_journals SET name=?, frequency=?, next_date=?, end_date=?, memo=?, lines_json=?, is_active=? WHERE id=? AND client_id=?`).bind(...f, Number(b.id), c.clientId).run();
  else await c.env.DB.prepare(`INSERT INTO acc_recurring_journals (client_id, name, frequency, next_date, end_date, memo, lines_json, is_active, created_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(c.clientId, ...f, new Date().toISOString()).run();
  await audit(c.env, c.clientId, c.actor, 'recurring_save', 'recurring', b.id||null, {name:f[0], freq});
  return {ok:true};
}
export async function recurringDelete(c){ await c.env.DB.prepare(`DELETE FROM acc_recurring_journals WHERE id=? AND client_id=?`).bind(Number(c.body.id), c.clientId).run(); await audit(c.env, c.clientId, c.actor, 'recurring_delete', 'recurring', c.body.id, null); return {ok:true}; }
export async function runRecurringForClient(env, clientId, asOf=todayStr()){
  const settings=await getSettings(env, clientId); const ctx=await loadAccountContext(env, clientId, settings);
  const due=await allRows(env, `SELECT * FROM acc_recurring_journals WHERE client_id=? AND is_active=1 AND next_date<=?`, clientId, asOf);
  const posted=[];
  for(const t of due){
    let d=t.next_date, g=0; const lines=JSON.parse(t.lines_json||'[]');
    while(d<=asOf && g++<36){
      if(t.end_date && d>t.end_date) break;
      if(!isLocked(settings, d)){
        const exists=await firstRow(env, `SELECT id FROM acc_journals WHERE client_id=? AND source_type='recurring' AND source_ref=?`, clientId, `${t.id}:${d}`);
        if(!exists){ try{ const j=await insertJournal(env, clientId, settings, ctx, {date:d, memo:t.memo||t.name, lines, source_type:'recurring', source_ref:`${t.id}:${d}`, actor:'system'}); posted.push({template:t.name, date:d, journal_id:j.id}); }catch(e){ posted.push({template:t.name, date:d, error:e.message}); } }
      }
      d=t.frequency==='week'?addDays(d,7):addMonths(d, INTERVAL_MONTHS[t.frequency]||1);
    }
    await env.DB.prepare(`UPDATE acc_recurring_journals SET next_date=?, last_run_at=?, is_active=? WHERE id=?`).bind(d, new Date().toISOString(), t.end_date && d>t.end_date?0:1, t.id).run();
  }
  return posted;
}
export async function recurringRunNow(c){ return {ok:true, posted:await runRecurringForClient(c.env, c.clientId)}; }

/* ── Bank feed rules + categorisation of unmatched statement lines ── */
export async function bankRulesList(c){ return {list:await allRows(c.env, `SELECT r.*, a.name AS account_name FROM acc_bank_rules r LEFT JOIN acc_accounts a ON a.id=r.account_id WHERE r.client_id=? ORDER BY r.priority, r.id`, c.clientId)}; }
export async function bankRuleSave(c){
  const b=c.body; need(str(b.match_text) && b.account_id, 'match_text and account_id required');
  const f=[str(b.match_text,120), ['in','out','any'].includes(b.direction)?b.direction:'any', Number(b.account_id), str(b.party_name,140)||null, parseInt(b.priority)||100];
  if(b.id) await c.env.DB.prepare(`UPDATE acc_bank_rules SET match_text=?, direction=?, account_id=?, party_name=?, priority=? WHERE id=? AND client_id=?`).bind(...f, Number(b.id), c.clientId).run();
  else await c.env.DB.prepare(`INSERT INTO acc_bank_rules (client_id, match_text, direction, account_id, party_name, priority, created_at) VALUES (?,?,?,?,?,?,?)`).bind(c.clientId, ...f, new Date().toISOString()).run();
  return {ok:true};
}
export async function bankRuleDelete(c){ await c.env.DB.prepare(`DELETE FROM acc_bank_rules WHERE id=? AND client_id=?`).bind(Number(c.body.id), c.clientId).run(); return {ok:true}; }
export function matchRule(rules, description, amount){
  const d=String(description||'').toLowerCase();
  for(const r of rules){
    if(r.direction==='in' && amount<0) continue; if(r.direction==='out' && amount>0) continue;
    if(d.includes(String(r.match_text).toLowerCase())) return r;
  }
  return null;
}
export async function bankUnmatched(c){
  const rules=(await bankRulesList(c)).list;
  const lines=await allRows(c.env, `SELECT l.*, s.account_id AS bank_account_id, s.account_name FROM acc_bank_recon_lines l JOIN acc_bank_recon_sessions s ON s.id=l.session_id WHERE l.client_id=? AND l.match_status='unmatched' ORDER BY l.txn_date DESC LIMIT 500`, c.clientId);
  const ctx=await loadAccountContext(c.env, c.clientId, c.settings);
  return {list:lines.map(l=>{
    const r=matchRule(rules, l.description, num(l.amount));
    const key=r?null:suggestAccountKey(l.description);
    return {...l, suggested_account_id:r?.account_id||(key?ctx.byKey[key]:null)||null, suggested_by:r?`Rule “${r.match_text}”`:(key?'Keyword':null), party_name:r?.party_name||null};
  })};
}
// Each categorised line becomes a standalone Payment Entry on the statement's bank account with
// its contra account recorded in acc_payment_meta — the ledger sync posts it from there.
export async function bankCategorize(c){
  const items=Array.isArray(c.body.items)?c.body.items:[]; need(items.length, 'items required');
  const ctx=await loadAccountContext(c.env, c.clientId, c.settings);
  let done=0; const errors=[];
  for(const it of items){
    const line=await firstRow(c.env, `SELECT l.*, s.account_id AS bank_account_id, s.account_name, s.currency FROM acc_bank_recon_lines l JOIN acc_bank_recon_sessions s ON s.id=l.session_id WHERE l.id=? AND l.client_id=?`, Number(it.line_id), c.clientId);
    if(!line || line.match_status!=='unmatched'){ errors.push({line_id:it.line_id, error:'Not an unmatched line'}); continue; }
    if(!ctx.byId[it.account_id]){ errors.push({line_id:it.line_id, error:'Pick an account'}); continue; }
    if(isLocked(c.settings, line.txn_date)){ errors.push({line_id:it.line_id, error:'Locked period'}); continue; }
    const amt=num(line.amount); const now=new Date().toISOString();
    const r=await c.env.DB.prepare(`INSERT INTO acc_payment_entries (client_id, payment_type, payment_date, amount, currency, account_id, account_name, mode, reference_no, party_name, source_type, description, is_reconciled, reconciled_at, recon_session_id, recon_line_id, created_at) VALUES (?,?,?,?,?,?,?,'bank',?,?,'bank_feed',?,1,?,?,?,?)`)
      .bind(c.clientId, amt>=0?'receive':'pay', line.txn_date, Math.abs(amt), line.currency||c.settings.base_currency, line.bank_account_id, line.account_name, str(line.reference,140), str(it.party_name,140)||null, str(line.description,500), now, line.session_id, line.id, now).run();
    const peId=r.meta.last_row_id;
    await dbBatch(c.env, [
      c.env.DB.prepare(`INSERT INTO acc_payment_meta (client_id, payment_entry_id, account_id) VALUES (?,?,?) ON CONFLICT(client_id, payment_entry_id) DO UPDATE SET account_id=excluded.account_id`).bind(c.clientId, peId, Number(it.account_id)),
      c.env.DB.prepare(`UPDATE acc_bank_recon_lines SET match_status='matched', matched_payment_entry_id=? WHERE id=?`).bind(peId, line.id),
      c.env.DB.prepare(`UPDATE acc_bank_recon_sessions SET matched_lines=matched_lines+1 WHERE id=?`).bind(line.session_id),
    ]);
    if(it.create_rule && str(it.rule_text)) await c.env.DB.prepare(`INSERT INTO acc_bank_rules (client_id, match_text, direction, account_id, party_name, priority, created_at) VALUES (?,?,?,?,?,100,?)`).bind(c.clientId, str(it.rule_text,120), amt>=0?'in':'out', Number(it.account_id), str(it.party_name,140)||null, now).run();
    done++;
  }
  await audit(c.env, c.clientId, c.actor, 'bank_categorize', 'bank_recon', null, {done, errors:errors.length});
  return {ok:true, categorized:done, errors};
}
export async function paymentAccountSet(c){
  const pe=await firstRow(c.env, `SELECT * FROM acc_payment_entries WHERE id=? AND client_id=?`, Number(c.body.payment_entry_id), c.clientId); need(pe, 'Payment entry not found', 404);
  lockCheck(c.settings, pe.payment_date);
  if(c.body.account_id) await c.env.DB.prepare(`INSERT INTO acc_payment_meta (client_id, payment_entry_id, account_id) VALUES (?,?,?) ON CONFLICT(client_id, payment_entry_id) DO UPDATE SET account_id=excluded.account_id`).bind(c.clientId, pe.id, Number(c.body.account_id)).run();
  else await c.env.DB.prepare(`DELETE FROM acc_payment_meta WHERE client_id=? AND payment_entry_id=?`).bind(c.clientId, pe.id).run();
  await audit(c.env, c.clientId, c.actor, 'payment_account_set', 'payment_entry', pe.id, {account_id:c.body.account_id||null});
  return {ok:true};
}

/* ── Expense approvals ── */
export async function onExpenseCreated(env, clientId, expenseId, actor){
  const s=await getSettings(env, clientId);
  if(!s.expense_approval_required) return;
  await env.DB.prepare(`INSERT OR IGNORE INTO acc_expense_approvals (client_id, expense_id, status) VALUES (?,?,'pending')`).bind(clientId, expenseId).run();
  await audit(env, clientId, actor, 'expense_submitted', 'expense', expenseId, null);
}
export async function approvalsList(c){
  const status=str(c.url.searchParams.get('status'),20)||'pending';
  return {list:await allRows(c.env, `SELECT a.*, e.amount, e.currency, e.expense_date, e.category, e.vendor, e.description FROM acc_expense_approvals a JOIN accounting_expenses e ON e.id=a.expense_id WHERE a.client_id=? AND a.status=? ORDER BY e.expense_date DESC LIMIT 300`, c.clientId, status)};
}
export async function approvalDecide(c){
  const ids=(Array.isArray(c.body.expense_ids)?c.body.expense_ids:[c.body.expense_id]).map(Number).filter(Boolean); need(ids.length, 'expense_id required');
  const status=c.body.decision==='reject'?'rejected':'approved'; const now=new Date().toISOString();
  await dbBatch(c.env, ids.map(id=>c.env.DB.prepare(`INSERT INTO acc_expense_approvals (client_id, expense_id, status, decided_by, decided_at, note) VALUES (?,?,?,?,?,?) ON CONFLICT(client_id, expense_id) DO UPDATE SET status=excluded.status, decided_by=excluded.decided_by, decided_at=excluded.decided_at, note=excluded.note`)
    .bind(c.clientId, id, status, c.actor||null, now, str(c.body.note,300)||null)));
  for(const id of ids) await audit(c.env, c.clientId, c.actor, `expense_${status}`, 'expense', id, c.body.note||null);
  return {ok:true, count:ids.length};
}

/* ── Fixed assets ── */
export async function assetsList(c){
  const t=todayStr().slice(0,7);
  return {list:(await allRows(c.env, `SELECT * FROM acc_fixed_assets WHERE client_id=? ORDER BY purchase_date DESC`, c.clientId)).map(a=>{
    const sched=depreciationSchedule(a); const end=a.disposed_date?addMonths(a.disposed_date.slice(0,7)+'-01',-1).slice(0,7):t;
    const acc=r2(sched.filter(s=>s.month<=end).reduce((s,x)=>s+x.amount,0));
    return {...a, accumulated_depreciation:acc, book_value:a.disposed_date?0:r2(num(a.cost)-acc), monthly_depreciation:sched.find(s=>s.month>=t)?.amount||0, schedule:sched.slice(0,120)};
  })};
}
export async function assetSave(c){
  const b=c.body; need(str(b.name) && b.purchase_date && num(b.cost)>0, 'name, purchase_date and cost required');
  lockCheck(c.settings, b.purchase_date);
  if(b.disposed_date) lockCheck(c.settings, b.disposed_date);
  const f={name:str(b.name,140), category:str(b.category,60)||null, asset_account_id:b.asset_account_id?Number(b.asset_account_id):null, purchase_date:str(b.purchase_date,10), cost:num(b.cost), salvage:num(b.salvage),
    useful_life_months:Math.max(1, parseInt(b.useful_life_months)||36), method:b.method==='wdv'?'wdv':'slm', wdv_rate_pct:num(b.wdv_rate_pct), paid_from_account_id:b.paid_from_account_id?Number(b.paid_from_account_id):null,
    disposed_date:str(b.disposed_date,10)||null, disposal_amount:num(b.disposal_amount), disposal_account_id:b.disposal_account_id?Number(b.disposal_account_id):null, notes:str(b.notes,300)||null};
  need(f.method!=='wdv' || f.wdv_rate_pct>0, 'WDV needs an annual rate');
  if(b.id){
    const old=await firstRow(c.env, `SELECT purchase_date FROM acc_fixed_assets WHERE id=? AND client_id=?`, Number(b.id), c.clientId); need(old, 'Not found', 404); lockCheck(c.settings, old.purchase_date);
    await c.env.DB.prepare(`UPDATE acc_fixed_assets SET ${Object.keys(f).map(k=>`${k}=?`).join(',')} WHERE id=? AND client_id=?`).bind(...Object.values(f), Number(b.id), c.clientId).run();
  }else await c.env.DB.prepare(`INSERT INTO acc_fixed_assets (client_id, ${Object.keys(f).join(',')}, created_at) VALUES (?,${Object.keys(f).map(()=>'?').join(',')},?)`).bind(c.clientId, ...Object.values(f), new Date().toISOString()).run();
  await audit(c.env, c.clientId, c.actor, b.id?'asset_update':'asset_create', 'asset', b.id||null, f);
  return {ok:true};
}
export async function assetDelete(c){
  const a=await firstRow(c.env, `SELECT purchase_date FROM acc_fixed_assets WHERE id=? AND client_id=?`, Number(c.body.id), c.clientId); need(a, 'Not found', 404); lockCheck(c.settings, a.purchase_date);
  await c.env.DB.prepare(`DELETE FROM acc_fixed_assets WHERE id=? AND client_id=?`).bind(Number(c.body.id), c.clientId).run(); await audit(c.env, c.clientId, c.actor, 'asset_delete', 'asset', c.body.id, null); return {ok:true};
}

/* ── Payroll ── */
export async function employeesList(c){ return {list:await allRows(c.env, `SELECT * FROM acc_employees WHERE client_id=? ORDER BY is_active DESC, name`, c.clientId)}; }
export async function employeeSave(c){
  const b=c.body; need(str(b.name), 'name required');
  const f={name:str(b.name,140), email:str(b.email,140)||null, pan:str(b.pan,10).toUpperCase()||null, uan:str(b.uan,20)||null, designation:str(b.designation,80)||null, department:str(b.department,80)||null,
    basic:num(b.basic), hra:num(b.hra), other_allowances:num(b.other_allowances), pf_applicable:b.pf_applicable===false||b.pf_applicable===0?0:1, esi_applicable:b.esi_applicable===false||b.esi_applicable===0?0:1,
    pt_monthly:num(b.pt_monthly), tds_monthly:num(b.tds_monthly), is_active:b.is_active===false||b.is_active===0?0:1, joined_on:str(b.joined_on,10)||null};
  if(b.id) await c.env.DB.prepare(`UPDATE acc_employees SET ${Object.keys(f).map(k=>`${k}=?`).join(',')} WHERE id=? AND client_id=?`).bind(...Object.values(f), Number(b.id), c.clientId).run();
  else await c.env.DB.prepare(`INSERT INTO acc_employees (client_id, ${Object.keys(f).join(',')}, created_at) VALUES (?,${Object.keys(f).map(()=>'?').join(',')},?)`).bind(c.clientId, ...Object.values(f), new Date().toISOString()).run();
  await audit(c.env, c.clientId, c.actor, 'employee_save', 'employee', b.id||null, {name:f.name});
  return {ok:true};
}
// India payroll maths: PF on basic up to the wage cap (employee + employer), ESI on gross when
// gross ≤ the ESI wage limit, fixed PT and TDS per employee, paid-days proration.
export function computePayrollLine(e, cfg, override={}){
  const days=num(override.month_days)||30, paid=override.paid_days!=null&&override.paid_days!==''?num(override.paid_days):days;
  const f=Math.max(0, Math.min(1, paid/days));
  const basic=r2(num(e.basic)*f), hra=r2(num(e.hra)*f), other=r2(num(e.other_allowances)*f+num(override.bonus));
  const gross=r2(basic+hra+other);
  const pfWage=Math.min(basic, num(cfg.pf_wage_cap)||basic);
  const employee_pf=e.pf_applicable?r2(pfWage*num(cfg.pf_rate)/100):0, employer_pf=e.pf_applicable?r2(pfWage*num(cfg.employer_pf_rate)/100):0;
  const esiOk=e.esi_applicable && gross<=num(cfg.esi_wage_limit);
  const employee_esi=esiOk?Math.ceil(gross*num(cfg.esi_employee_rate))/100:0, employer_esi=esiOk?Math.ceil(gross*num(cfg.esi_employer_rate))/100:0;
  const pt=override.pt!=null&&override.pt!==''?num(override.pt):num(e.pt_monthly), tds=override.tds!=null&&override.tds!==''?num(override.tds):num(e.tds_monthly);
  const net=r2(gross-employee_pf-employee_esi-pt-tds);
  return {employee_id:e.id, name:e.name, pan:e.pan, paid_days:paid, month_days:days, basic, hra, other, gross, employee_pf, employer_pf, employee_esi:r2(employee_esi), employer_esi:r2(employer_esi), pt, tds, net};
}
export async function payrollList(c){ return {list:(await allRows(c.env, `SELECT * FROM acc_payroll_runs WHERE client_id=? ORDER BY period_month DESC`, c.clientId)).map(p=>({...p, lines:JSON.parse(p.lines_json||'[]')}))}; }
export async function payrollPrepare(c){
  const m=str(c.body.period_month,7); need(/^\d{4}-\d{2}$/.test(m), 'period_month must be YYYY-MM');
  const existing=await firstRow(c.env, `SELECT * FROM acc_payroll_runs WHERE client_id=? AND period_month=?`, c.clientId, m);
  need(!existing || existing.status==='draft', 'This month is already posted');
  const emps=await allRows(c.env, `SELECT * FROM acc_employees WHERE client_id=? AND is_active=1`, c.clientId); need(emps.length, 'Add employees first');
  const overrides={}; for(const o of (Array.isArray(c.body.overrides)?c.body.overrides:[])) overrides[o.employee_id]=o;
  const lines=emps.map(e=>computePayrollLine(e, c.settings.payroll, overrides[e.id]||{}));
  const sum=k=>r2(lines.reduce((s,l)=>s+l[k],0));
  const runDate=str(c.body.run_date,10)||monthEnd(m);
  lockCheck(c.settings, runDate);
  const vals=[runDate, JSON.stringify(lines), sum('gross'), sum('net'), r2(sum('gross')+sum('employer_pf')+sum('employer_esi'))];
  if(existing) await c.env.DB.prepare(`UPDATE acc_payroll_runs SET run_date=?, lines_json=?, gross=?, net=?, employer_cost=? WHERE id=?`).bind(...vals, existing.id).run();
  else await c.env.DB.prepare(`INSERT INTO acc_payroll_runs (client_id, period_month, run_date, status, lines_json, gross, net, employer_cost, created_at) VALUES (?,?,?,'draft',?,?,?,?,?)`).bind(c.clientId, m, ...vals, new Date().toISOString()).run();
  return {ok:true, lines, gross:vals[2], net:vals[3], employer_cost:vals[4]};
}
export async function payrollAction(c){
  const p=await firstRow(c.env, `SELECT * FROM acc_payroll_runs WHERE id=? AND client_id=?`, Number(c.body.id), c.clientId); need(p, 'Payroll run not found', 404);
  const a=c.body.action;
  if(a==='post'){ need(p.status==='draft', 'Already posted'); lockCheck(c.settings, p.run_date); await c.env.DB.prepare(`UPDATE acc_payroll_runs SET status='posted' WHERE id=?`).bind(p.id).run(); }
  else if(a==='pay'){ need(p.status==='posted', 'Post the payroll first'); const d=str(c.body.paid_date,10)||todayStr(); lockCheck(c.settings, d); await c.env.DB.prepare(`UPDATE acc_payroll_runs SET status='paid', paid_date=?, paid_account_id=? WHERE id=?`).bind(d, c.body.account_id?Number(c.body.account_id):null, p.id).run(); }
  else if(a==='unpost'){ need(p.status!=='draft', 'Not posted'); lockCheck(c.settings, p.run_date); await c.env.DB.prepare(`UPDATE acc_payroll_runs SET status='draft', paid_date=NULL, paid_account_id=NULL WHERE id=?`).bind(p.id).run(); }
  else if(a==='delete'){ need(p.status==='draft', 'Unpost before deleting'); await c.env.DB.prepare(`DELETE FROM acc_payroll_runs WHERE id=?`).bind(p.id).run(); }
  else throw new HttpError(400, 'Unknown action');
  await audit(c.env, c.clientId, c.actor, `payroll_${a}`, 'payroll', p.id, {month:p.period_month});
  return {ok:true};
}

/* ── Budgets ── */
export async function budgetSave(c){
  const b=c.body; const fy=parseInt(b.fiscal_year); need(fy>2000, 'fiscal_year required');
  const rows=Array.isArray(b.rows)?b.rows:[];
  const stmts=rows.filter(r=>r.account_id).map(r=>{ const months=(Array.isArray(r.months)?r.months:[]).slice(0,12).map(num); while(months.length<12) months.push(0);
    return c.env.DB.prepare(`INSERT INTO acc_budgets (client_id, fiscal_year, account_id, branch, months_json, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(client_id, fiscal_year, account_id, branch) DO UPDATE SET months_json=excluded.months_json`)
      .bind(c.clientId, fy, Number(r.account_id), str(b.branch,60), JSON.stringify(months), new Date().toISOString()); });
  await dbBatch(c.env, stmts);
  await audit(c.env, c.clientId, c.actor, 'budget_save', 'budget', fy, {rows:stmts.length});
  return {ok:true, saved:stmts.length};
}
// Seed next year's budget from last year's actuals × (1 + growth%).
export async function budgetFromActuals(c){
  const fy=parseInt(c.body.fiscal_year); const growth=num(c.body.growth_pct);
  const fyStart=`${fy-1}-${String(c.settings.fy_start_month||4).padStart(2,'0')}-01`;
  const ctx=await loadAccountContext(c.env, c.clientId, c.settings);
  const rows=[];
  for(const a of ctx.accounts.filter(a=>a.type==='income'||a.type==='expense')){
    const months=[];
    for(let i=0;i<12;i++){ const m=addMonths(fyStart,i).slice(0,7); const t=await accountTotals(c.env, c.clientId, {from:m+'-01', to:monthEnd(m), excludeTypes:['year_close']}); months.push(r2(naturalBalance(a.type, t[a.id])*(1+growth/100))); }
    if(months.some(x=>x)) rows.push({account_id:a.id, months});
  }
  return budgetSave({...c, body:{fiscal_year:fy, branch:c.body.branch, rows}});
}

/* ── Cost allocation (direct costs → customer, for unit economics) ── */
export async function allocationsList(c){ return {list:await allRows(c.env, `SELECT * FROM acc_cost_allocations WHERE client_id=? ORDER BY id DESC LIMIT 500`, c.clientId)}; }
export async function allocationSave(c){
  const b=c.body; need(['expense','vendor_bill','payroll'].includes(b.source_type) && b.source_id && str(b.customer_name), 'source_type, source_id and customer_name required');
  const pct=Math.max(0, Math.min(100, num(b.pct)||100));
  const used=(await firstRow(c.env, `SELECT SUM(pct) p FROM acc_cost_allocations WHERE client_id=? AND source_type=? AND source_id=? AND id!=?`, c.clientId, b.source_type, Number(b.source_id), Number(b.id)||0))?.p||0;
  need(used+pct<=100.0001, `Only ${r2(100-used)}% of this cost is left to allocate`);
  if(b.id) await c.env.DB.prepare(`UPDATE acc_cost_allocations SET customer_name=?, pct=? WHERE id=? AND client_id=?`).bind(str(b.customer_name,200), pct, Number(b.id), c.clientId).run();
  else await c.env.DB.prepare(`INSERT INTO acc_cost_allocations (client_id, source_type, source_id, customer_name, pct, created_at) VALUES (?,?,?,?,?,?)`).bind(c.clientId, b.source_type, Number(b.source_id), str(b.customer_name,200), pct, new Date().toISOString()).run();
  return {ok:true};
}
export async function allocationDelete(c){ await c.env.DB.prepare(`DELETE FROM acc_cost_allocations WHERE id=? AND client_id=?`).bind(Number(c.body.id), c.clientId).run(); return {ok:true}; }

export async function unitEconomics(env, clientId, settings, {from, to}){
  const src=await loadSources(env, clientId); const fx=makeFx(src.rates, settings.base_currency, []);
  const cust={}; const g=n=>cust[n]=cust[n]||{customer:n, revenue:0, credit_notes:0, direct_costs:0, gateway_fees:0, invoices:0};
  for(const d of src.docs){
    const dt=docDate(d); if(dt<from||dt>to) continue;
    if(d.type==='invoice' && POSTABLE_INVOICE.has(d.status)){ const x=g(d.customer_name||'—'); x.revenue=r2(x.revenue+num(d.subtotal)*fx(d.currency,dt)); x.invoices++; }
    if(d.type==='receipt' && d.status!=='void' && !d.linked_doc_id){ const x=g(d.customer_name||'—'); x.revenue=r2(x.revenue+num(d.subtotal)*fx(d.currency,dt)); }
  }
  for(const c of src.collections){ const dt=String(c.collected_at).slice(0,10); if(dt<from||dt>to||/^Auto-recorded from Invoice #/.test(String(c.notes||''))) continue; const x=g(c.customer_name||'—'); x.revenue=r2(x.revenue+num(c.amount)*fx(c.currency,dt)); }
  for(const n of src.notes){ if(n.note_type!=='credit'||n.status==='void'||n.note_date<from||n.note_date>to) continue; const x=g(n.party_name||'—'); x.credit_notes=r2(x.credit_notes+num(n.subtotal)*fx(n.currency,n.note_date)); }
  const allocs=await allRows(env, `SELECT * FROM acc_cost_allocations WHERE client_id=?`, clientId);
  const costOf=(type,id)=>{
    if(type==='expense'){ const x=src.expenses.find(e=>e.id===id); if(!x||x.expense_date<from||x.expense_date>to) return 0; const m=src.purchaseMeta[`expense:${id}`]; return (num(x.amount)-(m&&num(m.itc_eligible)?num(m.cgst)+num(m.sgst)+num(m.igst):0))*fx(x.currency,x.expense_date); }
    if(type==='vendor_bill'){ const b=src.bills.find(e=>e.id===id); if(!b||b.bill_date<from||b.bill_date>to) return 0; const m=src.purchaseMeta[`vendor_bill:${id}`]; return (num(b.total)-(m&&num(m.itc_eligible)?num(m.cgst)+num(m.sgst)+num(m.igst):0))*fx(b.currency,b.bill_date); }
    if(type==='payroll'){ const p=src.payroll.find(e=>e.id===id); if(!p||p.run_date<from||p.run_date>to) return 0; return num(p.employer_cost); }
    return 0;
  };
  for(const a of allocs){ const x=g(a.customer_name); x.direct_costs=r2(x.direct_costs+costOf(a.source_type, a.source_id)*num(a.pct)/100); }
  const fees=src.settlements.filter(s=>s.settlement_date>=from && s.settlement_date<=to).reduce((s,x)=>s+num(x.fee),0);
  const totalRev=Object.values(cust).reduce((s,x)=>s+x.revenue,0)||1;
  const rows=Object.values(cust).map(x=>{ x.gateway_fees=r2(fees*x.revenue/totalRev); const net=r2(x.revenue-x.credit_notes); const margin=r2(net-x.direct_costs-x.gateway_fees); return {...x, net_revenue:net, margin, margin_pct:net?r2(margin/net*100):null}; })
    .sort((a,b)=>b.net_revenue-a.net_revenue);
  return {from, to, rows, totals:{revenue:r2(rows.reduce((s,r)=>s+r.net_revenue,0)), direct_costs:r2(rows.reduce((s,r)=>s+r.direct_costs,0)), margin:r2(rows.reduce((s,r)=>s+r.margin,0))}};
}

/* ── Anomaly checks (rule-based, no AI needed) ── */
export async function anomalies(env, clientId, sync){
  const {src, ctx, settings}=sync; const t=todayStr(); const out=[];
  const add=(severity, kind, message, ref)=>out.push({severity, kind, message, ref:ref||null});
  const bills=src.bills.slice().sort((a,b)=>a.bill_date.localeCompare(b.bill_date));
  for(let i=0;i<bills.length;i++) for(let j=i+1;j<bills.length;j++){
    const a=bills[i], b=bills[j]; if(daysBetween(a.bill_date,b.bill_date)>7) break;
    if(String(a.supplier).toLowerCase()===String(b.supplier).toLowerCase() && (r2(a.total)===r2(b.total) || (a.vendor_invoice_no && a.vendor_invoice_no===b.vendor_invoice_no)))
      add('high','duplicate_bill',`Possible duplicate bills from ${a.supplier}: #${a.id} and #${b.id} (${a.bill_date} / ${b.bill_date}, ${r2(b.total)})`, {type:'vendor_bill', id:b.id});
  }
  const ex=src.expenses.slice().sort((a,b)=>a.expense_date.localeCompare(b.expense_date));
  for(let i=0;i<ex.length;i++) for(let j=i+1;j<ex.length;j++){
    const a=ex[i], b=ex[j]; if(daysBetween(a.expense_date,b.expense_date)>3) break;
    if(r2(a.amount)===r2(b.amount) && String(a.vendor||a.category).toLowerCase()===String(b.vendor||b.category).toLowerCase())
      add('medium','duplicate_expense',`Possible duplicate expenses: #${a.id} and #${b.id} — ${b.vendor||b.category||''} ${r2(b.amount)} on ${a.expense_date} / ${b.expense_date}`, {type:'expense', id:b.id});
  }
  // Category spikes: this month vs the average of the previous three.
  const cur=t.slice(0,7), prev=[1,2,3].map(i=>addMonths(cur+'-01',-i).slice(0,7));
  const byCat={};
  for(const x of [...src.expenses.map(e=>({c:e.category||e.expense_account_name||'Uncategorized', m:String(e.expense_date).slice(0,7), a:num(e.amount)})), ...src.fpExpenses.map(e=>({c:e.category||e.name, m:String(e.expense_date).slice(0,7), a:num(e.amount)}))]){
    (byCat[x.c]=byCat[x.c]||{})[x.m]=(byCat[x.c][x.m]||0)+x.a;
  }
  for(const [cat,m] of Object.entries(byCat)){
    const avg=prev.reduce((s,p)=>s+(m[p]||0),0)/3, now=m[cur]||0;
    if(avg>0 && now>avg*2.5 && now-avg>1000) add('medium','spike',`${cat} spending this month (${r2(now)}) is ${r2(now/avg)}× the 3-month average (${r2(avg)})`);
  }
  const tb=await accountTotals(env, clientId, {to:t});
  for(const a of ctx.accounts.filter(a=>a.subtype==='bank'||a.subtype==='cash')){ const b=naturalBalance('asset', tb[a.id]); if(b<-0.01) add('high','negative_cash',`${a.name} shows a negative balance (${b}) — a payment may be recorded against the wrong account, or a receipt is missing.`, {type:'account', id:a.id}); }
  const und=naturalBalance('asset', tb[ctx.byKey.UNDEPOSITED]);
  if(und>0.01) add('low','undeposited',`${r2(und)} sits in Undeposited Funds — record which bank account these receipts landed in (Bank & Cash → payment entries) or add gateway settlements.`, {type:'account', id:ctx.byKey.UNDEPOSITED});
  const unc=r2(naturalBalance('expense', tb[ctx.byKey.UNCATEGORIZED_EXP])+naturalBalance('income', tb[ctx.byKey.UNCATEGORIZED_INC]));
  if(unc) add('medium','uncategorized',`${r2(unc)} is posted to Uncategorized income/expense — categorise the bank lines or payment entries.`);
  if(settings.gstin) for(const d of src.docs.filter(d=>d.type==='invoice' && POSTABLE_INVOICE.has(d.status) && !num(d.gst_rate_pct) && d.supply_type!=='EXPORT' && docDate(d)>=addDays(t,-90)))
    add('low','no_gst',`Invoice #${d.id} (${d.customer_name||''}) has no GST although you are GST-registered.`, {type:'invoice', id:d.id});
  for(const d of src.docs.filter(d=>d.type==='invoice' && d.status==='draft' && daysBetween(docDate(d), t)>14)) add('low','stale_draft',`Invoice #${d.id} has been a draft for ${daysBetween(docDate(d), t)} days — drafts don't count as revenue.`, {type:'invoice', id:d.id});
  for(const b of src.bills.filter(b=>b.status!=='paid' && b.due_date && b.due_date<t)) add('medium','overdue_bill',`Bill #${b.id} to ${b.supplier} was due ${b.due_date} (${r2(b.total)}).`, {type:'vendor_bill', id:b.id});
  const future=await firstRow(env, `SELECT COUNT(*) n FROM acc_journals WHERE client_id=? AND status='posted' AND entry_date>?`, clientId, addDays(t,31));
  if(future?.n) add('low','future_dated',`${future.n} journal entries are dated more than a month in the future.`);
  const order={high:0, medium:1, low:2};
  return out.sort((a,b)=>order[a.severity]-order[b.severity]);
}

/* ── AI ── */
async function aiContext(env, clientId, sync){
  const t=todayStr(); const fy=fiscalYear(t, sync.settings.fy_start_month);
  const dash=await ownerDashboard(env, clientId, sync);
  const pl=await profitAndLoss(env, clientId, sync.ctx.accounts, {from:fy.from, to:t});
  const lastMonth=addMonths(t.slice(0,7)+'-01',-1).slice(0,7);
  const plLast=await profitAndLoss(env, clientId, sync.ctx.accounts, {from:lastMonth+'-01', to:monthEnd(lastMonth)});
  const ue=await unitEconomics(env, clientId, sync.settings, {from:fy.from, to:t});
  const ar=arAging(sync.src, sync.settings.base_currency);
  const flat=s=>s.map(r=>({account:r.name, amount:r.amount}));
  return {today:t, currency:sync.settings.base_currency, fiscal_year:`${fy.from} to ${fy.to}`,
    cash:dash.cash, cash_accounts:dash.cash_accounts, receivables:dash.receivables, overdue_receivables:dash.overdue_receivables, payables:dash.payables,
    mrr:dash.mrr, arr:dash.arr, burn_rate_monthly:dash.burn_rate, runway_months:dash.runway_months,
    profit_and_loss_fy_to_date:{revenue:pl.revenue, cost_of_revenue:pl.cogs, gross_profit:pl.gross_profit, operating_expenses:pl.opex, other_income:pl.other_income, net_profit:pl.net_profit, revenue_accounts:flat(pl.sections.revenue), expense_accounts:flat([...pl.sections.cogs,...pl.sections.opex])},
    last_month:{month:lastMonth, revenue:plLast.revenue, expenses:r2(plLast.cogs+plLast.opex), net_profit:plLast.net_profit},
    monthly_trend:dash.trend, top_customers_fy:ue.rows.slice(0,15).map(r=>({customer:r.customer, net_revenue:r.net_revenue, direct_costs:r.direct_costs, margin:r.margin})),
    open_invoices:ar.items.slice(0,25).map(i=>({customer:i.customer, invoice:i.invoice_id, balance:i.balance, overdue_days:i.overdue_days})), aging:ar.buckets};
}
export async function aiAsk(c, sync){
  const q=str(c.body.question,400); need(q, 'question required');
  need(_deps.aiGenerate, 'AI features are not configured for this deployment yet.', 503);
  const data=await aiContext(c.env, c.clientId, sync);
  const system=`You are a sharp, friendly finance assistant for the owner of a marketing agency / SaaS business. Answer using ONLY the JSON data below (from their double-entry books) — never invent a number. If the data can't answer, say what's missing and which report to open (Books → P&L / Balance Sheet / General Ledger, Subscriptions → Metrics, Tax → GSTR). Be concise: 2-6 sentences or a short list, amounts in ${data.currency}.\n\nDATA: ${JSON.stringify(data)}`;
  const answer=await _deps.aiGenerate(c.env, system, q, {temperature:0.2, maxOutputTokens:500, caller:'acc-ledger-ask'});
  need(answer, "Couldn't reach the AI assistant just now — try again in a moment.", 502);
  return {answer};
}
// Expenses / bills that fell through to General or Uncategorized get an account suggestion —
// keyword rules first, then the AI (when configured) for whatever is left.
export async function aiCategorize(c, sync){
  const {src, ctx}=sync; const generic=new Set([ctx.byKey.GENERAL_EXP, ctx.byKey.UNCATEGORIZED_EXP]);
  const cands=[];
  for(const x of src.expenses){ const m=src.purchaseMeta[`expense:${x.id}`]; if(m?.expense_account_id) continue; const a=expenseAccountFor(ctx, x.category, x.expense_account_name, x.expense_account, x.description, x.vendor); if(generic.has(a)) cands.push({source_type:'expense', source_id:x.id, text:[x.category,x.vendor,x.description,x.expense_account_name].filter(Boolean).join(' · '), amount:x.amount, date:x.expense_date}); }
  for(const b of src.bills){ const m=src.purchaseMeta[`vendor_bill:${b.id}`]; if(m?.expense_account_id) continue; let lines=[]; try{ lines=JSON.parse(b.line_items_json||'[]'); }catch(_){}
    const a=expenseAccountFor(ctx, lines[0]?.name, b.supplier); if(generic.has(a)) cands.push({source_type:'vendor_bill', source_id:b.id, text:[b.supplier, ...lines.map(l=>l.name)].filter(Boolean).join(' · '), amount:b.total, date:b.bill_date}); }
  const expenseAccounts=ctx.accounts.filter(a=>a.type==='expense' && a.is_active && !generic.has(a.id));
  let ai={};
  if(_deps.aiGenerate && cands.length){
    const list=cands.slice(0,60).map((x,i)=>({i, text:x.text, amount:x.amount}));
    const system=`Classify each business expense into exactly one account code from this chart: ${JSON.stringify(expenseAccounts.map(a=>({code:a.code, name:a.name})))}. Reply with ONLY a JSON array like [{"i":0,"code":"6220"}]. Use null for code when genuinely unsure.`;
    const txt=await _deps.aiGenerate(c.env, system, JSON.stringify(list), {temperature:0, maxOutputTokens:1200, caller:'acc-ledger-categorize'}).catch(()=>null);
    try{ const arr=JSON.parse(String(txt||'').replace(/^[^\[]*/,'').replace(/[^\]]*$/,'')); for(const r of arr){ const a=expenseAccounts.find(a=>a.code===String(r.code)); if(a) ai[r.i]=a.id; } }catch(_){}
  }
  return {list:cands.map((x,i)=>({...x, suggested_account_id:ai[i]||null, suggested_by:ai[i]?'AI':null})), accounts:expenseAccounts.map(a=>({id:a.id, code:a.code, name:a.name})), ai_available:!!_deps.aiGenerate};
}
export async function aiCategorizeApply(c){
  const items=Array.isArray(c.body.items)?c.body.items:[]; need(items.length, 'items required');
  let n=0; const errors=[];
  for(const it of items){
    const table=it.source_type==='vendor_bill'?'accounting_vendor_bills':it.source_type==='expense'?'accounting_expenses':null; if(!table||!it.account_id) continue;
    const row=await firstRow(c.env, `SELECT * FROM ${table} WHERE id=? AND client_id=?`, Number(it.source_id), c.clientId); if(!row) continue;
    if(isLocked(c.settings, row.bill_date||row.expense_date)){ errors.push({...it, error:'Locked period'}); continue; }
    await c.env.DB.prepare(`INSERT INTO acc_purchase_meta (client_id, source_type, source_id, expense_account_id, itc_eligible) VALUES (?,?,?,?,0) ON CONFLICT(client_id, source_type, source_id) DO UPDATE SET expense_account_id=excluded.expense_account_id`)
      .bind(c.clientId, it.source_type, row.id, Number(it.account_id)).run();
    if(it.remember && row.category) await c.env.DB.prepare(`INSERT INTO acc_category_map (client_id, category, account_id) VALUES (?,?,?) ON CONFLICT(client_id, category) DO UPDATE SET account_id=excluded.account_id`).bind(c.clientId, String(row.category).toLowerCase(), Number(it.account_id)).run();
    n++;
  }
  await audit(c.env, c.clientId, c.actor, 'categorize_apply', 'purchase', null, {applied:n});
  return {ok:true, applied:n, errors};
}

/* ── Exports ── */
const TALLY_GROUP={bank:'Bank Accounts', cash:'Cash-in-Hand', receivable:'Sundry Debtors', payable:'Sundry Creditors', tax:'Duties & Taxes', fixed:'Fixed Assets', contra_fixed:'Fixed Assets',
  deferred:'Current Liabilities', long_term:'Loans (Liability)', cogs:'Direct Expenses', contra:'Sales Accounts'};
function tallyGroup(a){
  if(a.system_key==='RETAINED') return 'Reserves & Surplus';
  if(TALLY_GROUP[a.subtype]) return TALLY_GROUP[a.subtype];
  if(a.type==='asset') return 'Current Assets'; if(a.type==='liability') return 'Current Liabilities'; if(a.type==='equity') return 'Capital Account';
  if(a.type==='income') return a.subtype==='other'?'Indirect Incomes':'Sales Accounts';
  return 'Indirect Expenses';
}
export async function exportTally(c){
  const from=str(c.url.searchParams.get('from'),10)||fiscalYear(todayStr(), c.settings.fy_start_month).from, to=str(c.url.searchParams.get('to'),10)||todayStr();
  const ctx=await loadAccountContext(c.env, c.clientId, c.settings);
  const journals=await allRows(c.env, `SELECT * FROM acc_journals WHERE client_id=? AND status='posted' AND entry_date>=? AND entry_date<=? ORDER BY entry_date, entry_no`, c.clientId, from, to);
  const lines=await allRows(c.env, `SELECT l.* FROM acc_journal_lines l JOIN acc_journals j ON j.id=l.journal_id WHERE l.client_id=? AND j.status='posted' AND j.entry_date>=? AND j.entry_date<=?`, c.clientId, from, to);
  const byJ={}; for(const l of lines) (byJ[l.journal_id]=byJ[l.journal_id]||[]).push(l);
  // Receivable/payable lines post to a per-party ledger (Tally's Sundry Debtors/Creditors) when tagged.
  const ledgerName=l=>{ const a=ctx.byId[l.account_id]; if((a?.subtype==='receivable'||a?.subtype==='payable') && l.party_name && l.party_name!=='—') return l.party_name; return a?.name||`Account ${l.account_id}`; };
  const masters=new Map();
  for(const a of ctx.accounts) masters.set(a.name, tallyGroup(a));
  for(const l of lines){ const a=ctx.byId[l.account_id]; if((a?.subtype==='receivable'||a?.subtype==='payable') && l.party_name && l.party_name!=='—') masters.set(l.party_name, a.subtype==='receivable'?'Sundry Debtors':'Sundry Creditors'); }
  const env=(report, body)=>`<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>${report}</REPORTNAME></REQUESTDESC><REQUESTDATA>\n${body}\n</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  const mastersXml=env('All Masters', [...masters].map(([n,g])=>`<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${xmlEsc(n)}" ACTION="Create"><NAME.LIST><NAME>${xmlEsc(n)}</NAME></NAME.LIST><PARENT>${xmlEsc(g)}</PARENT></LEDGER></TALLYMESSAGE>`).join('\n'));
  const vouchersXml=env('Vouchers', journals.map(j=>`<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="Journal" ACTION="Create"><DATE>${j.entry_date.replace(/-/g,'')}</DATE><VOUCHERTYPENAME>Journal</VOUCHERTYPENAME><VOUCHERNUMBER>${j.entry_no}</VOUCHERNUMBER><NARRATION>${xmlEsc(j.memo)}</NARRATION>${(byJ[j.id]||[]).map(l=>
    `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xmlEsc(ledgerName(l))}</LEDGERNAME><ISDEEMEDPOSITIVE>${l.debit?'Yes':'No'}</ISDEEMEDPOSITIVE><AMOUNT>${l.debit?(-l.debit).toFixed(2):l.credit.toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>`).join('')}</VOUCHER></TALLYMESSAGE>`).join('\n'));
  await audit(c.env, c.clientId, c.actor, 'export_tally', 'export', null, {from, to, vouchers:journals.length});
  return {from, to, masters_xml:mastersXml, vouchers_xml:vouchersXml, vouchers:journals.length, ledgers:masters.size};
}
export async function exportJournals(c){
  const from=str(c.url.searchParams.get('from'),10)||fiscalYear(todayStr(), c.settings.fy_start_month).from, to=str(c.url.searchParams.get('to'),10)||todayStr();
  const rows=await allRows(c.env, `SELECT j.entry_no, j.entry_date, j.memo, j.source_type, j.source_ref, a.code, a.name AS account, l.debit, l.credit, l.party_name, l.description FROM acc_journal_lines l JOIN acc_journals j ON j.id=l.journal_id JOIN acc_accounts a ON a.id=l.account_id
    WHERE l.client_id=? AND j.status='posted' AND j.entry_date>=? AND j.entry_date<=? ORDER BY j.entry_date, j.entry_no, l.id LIMIT 50000`, c.clientId, from, to);
  return {from, to, rows:rows.map(r=>({...r, source:SOURCE_LABELS[r.source_type]||r.source_type}))};
}
export {partyBalances};
