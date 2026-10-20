// Accounting ledger (accounting-ledger.js + accounting-core/reports/saas/tax/ops.js): posting rules,
// re-posting/voiding on edits, period lock, manual journals, year-end close, SaaS billing with
// proration and revenue recognition, credit notes, GST returns, payroll, roles and the client
// portal — through the real router against node:sqlite with the existing accounting migrations.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { accLedgerHandleRoute, accLedgerRunDaily } from './accounting-ledger.js';
import { addMonths, addDays, todayStr, depreciationSchedule, finalizeEntry, newEntry, dr, cr, gstSplitFor } from './accounting-core.js';
import { computePayrollLine } from './accounting-ops.js';
import { parseCsv } from './accounting-saas.js';

function d1(db){
  const stmt=(sql)=>{
    let args=[];
    const st={
      bind(...a){ args=a.map(v=>v===undefined?null:v); return st; },
      async run(){ const r=db.prepare(sql).run(...args); return {meta:{changes:Number(r.changes), last_row_id:Number(r.lastInsertRowid)}}; },
      async all(){ return {results:db.prepare(sql).all(...args)}; },
      async first(){ return db.prepare(sql).get(...args)||null; },
    };
    return st;
  };
  return {prepare:stmt, async batch(stmts){ db.exec('BEGIN'); try{ const out=[]; for(const s of stmts) out.push(await s.run()); db.exec('COMMIT'); return out; }catch(e){ db.exec('ROLLBACK'); throw e; } }};
}
const MIGRATIONS=['0002_accounting_b2b_documents','0004_accounting_erpnext_customer','0005_accounting_company_debtors','0006_accounting_erpnext_submit','0015_financial_planning',
  '0028_accounting_expenses','0029_accounting_vendor_bills','0034_fp_ai_snapshot','0035_accounting_standalone','0036_accounting_interconnect','0037_accounting_doc_dates_and_paid','0041_fp_reminder_tracking','0075_accounting_gst','0098_accounting_bank_cash','0117_accounting_ledger'];

let db, env, emails, session;
const deps={
  json:(data, status)=>new Response(JSON.stringify(data), {status:status||200}),
  requireSession:async req=>{ const a=req.headers.get('Authorization'); return a==='Bearer owner'?{cid:'7', email:'owner@x.in'}:a==='Bearer viewer'?{cid:'7', email:'ca@x.in'}:a==='Bearer other'?{cid:'8', email:'o@y.in'}:null; },
  getClientById:async()=>({client_name:'Acme Digital'}),
  sendEmail:async (env, clientId, msg)=>{ emails.push(msg); return {ok:true}; },
};
async function call(method, path, body, token='owner'){
  const url=new URL('https://w.example'+path);
  const req=new Request(url, {method, headers:{Authorization:`Bearer ${token}`, 'Content-Type':'application/json'}, ...(body?{body:JSON.stringify(body)}:{})});
  const res=await accLedgerHandleRoute(req, env, deps, url);
  const data=await res.json();
  return {status:res.status, data};
}
const get=(p,t)=>call('GET', `/accounting/ledger/${p}`, null, t);
const post=(p,b,t)=>call('POST', `/accounting/ledger/${p}`, b, t);
const q=(sql,...a)=>db.prepare(sql).all(...a);
const one=(sql,...a)=>db.prepare(sql).get(...a);
const T=todayStr();
function invoice({total=1180, subtotal=1000, cgst=90, sgst=90, igst=0, status='sent', date=T, customer='Beta Co', currency='INR', rate=18, lines}={}){
  const r=db.prepare(`INSERT INTO accounting_documents (client_id, type, title, line_items_json, currency, subtotal, tax_pct, tax_amount, total, status, customer_name, gst_rate_pct, cgst_amount, sgst_amount, igst_amount, place_of_supply, supply_type, doc_created_at, due_date) VALUES (7,'invoice','Website',?,?,?,?,?,?,?,?,?,?,?,?,'32','B2C',?,?)`)
    .run(JSON.stringify(lines||[{name:'SEO retainer', qty:1, price:subtotal, hsn:'998361'}]), currency, subtotal, rate, total-subtotal, total, status, customer, rate, cgst, sgst, igst, `${date}T10:00:00.000Z`, addDays(date,7));
  return Number(r.lastInsertRowid);
}
const acct=key=>one(`SELECT id FROM acc_accounts WHERE client_id=7 AND system_key=?`, key).id;
async function tbMap(){ const {data}=await get(`trial-balance?from=2000-01-01&to=${addDays(T,400)}`); assert.ok(data.balanced, 'trial balance must balance'); const m={}; for(const r of data.rows) m[r.code]=r.closing; return m; }

beforeEach(()=>{
  db=new DatabaseSync(':memory:');
  for(const m of MIGRATIONS) db.exec(readFileSync(new URL(`./migrations/${m}.sql`, import.meta.url), 'utf8'));
  db.exec(`INSERT INTO fp_config (client_id, enabled, reminders_enabled, updated_at, business_state_code) VALUES (7,1,1,'x','32')`);
  env={DB:d1(db)}; emails=[];
});

describe('posting rules', ()=>{
  test('invoice → AR / revenue / CGST+SGST, receipt clears AR, auto collection is not double counted', async ()=>{
    const id=invoice();
    let tb=await tbMap();
    assert.equal(tb['1200'], 1180); assert.equal(tb['4000'], -1000); assert.equal(tb['2200'], -90); assert.equal(tb['2201'], -90);
    db.prepare(`UPDATE accounting_documents SET status='paid' WHERE id=?`).run(id);
    db.prepare(`INSERT INTO accounting_documents (client_id, type, title, line_items_json, currency, subtotal, tax_amount, total, status, linked_doc_id, customer_name, doc_created_at) VALUES (7,'receipt','x','[]','INR',1000,180,1180,'paid',?,'Beta Co',?)`).run(id, `${T}T11:00:00Z`);
    db.prepare(`INSERT INTO fp_customers (client_id, name, start_date, created_at) VALUES (7,'Beta Co',?,?)`).run(T, T);
    db.prepare(`INSERT INTO fp_collections (client_id, customer_id, amount, currency, collected_at, notes, created_at) VALUES (7,1,1180,'INR',?,?,?)`).run(T, `Auto-recorded from Invoice #${id} marked paid`, T);
    tb=await tbMap();
    assert.equal(tb['1200']||0, 0); assert.equal(tb['1150'], 1180); assert.equal(tb['4000'], -1000);
    const {data:pl}=await get(`pl?from=2000-01-01&to=${T}`);
    assert.equal(pl.revenue, 1000); assert.equal(pl.net_profit, 1000);
  });

  test('editing a source reposts, deleting voids, lock date freezes', async ()=>{
    const id=invoice();
    await tbMap();
    db.prepare(`UPDATE accounting_documents SET subtotal=2000, total=2360, cgst_amount=180, sgst_amount=180 WHERE id=?`).run(id);
    let tb=await tbMap(); assert.equal(tb['1200'], 2360);
    assert.equal(one(`SELECT COUNT(*) n FROM acc_journals WHERE source_type='invoice'`).n, 1);
    // Lock and change — ledger keeps the locked figure and warns.
    let r=await post('lock', {lock_date:T}); assert.equal(r.status, 200);
    db.prepare(`UPDATE accounting_documents SET subtotal=3000, total=3540 WHERE id=?`).run(id);
    const s=await post('sync', {}); assert.ok(s.data.warnings.some(w=>w.kind==='locked'));
    tb=await tbMap(); assert.equal(tb['1200'], 2360);
    await post('lock', {lock_date:null});
    db.prepare(`DELETE FROM accounting_documents WHERE id=?`).run(id);
    tb=await tbMap(); assert.equal(tb['1200']||0, 0);
    assert.equal(one(`SELECT status FROM acc_journals WHERE source_type='invoice'`).status, 'void');
    const audit=q(`SELECT action FROM acc_audit_log WHERE client_id=7`).map(r=>r.action);
    assert.ok(audit.includes('period_lock') && audit.includes('period_unlock'));
  });

  test('expense with GST input credit + TDS, bill paid from a bank account, opening balance', async ()=>{
    db.prepare(`INSERT INTO acc_bank_accounts (client_id, name, type, currency, opening_balance, opening_balance_date, created_at) VALUES (7,'HDFC','bank','INR',50000,'2026-01-01',?)`).run(T);
    db.prepare(`INSERT INTO accounting_expenses (client_id, expense_account, amount, currency, expense_date, category, vendor, created_at) VALUES (7,'x',11800,'INR',?,'Software','Figma',?)`).run(T, T);
    const r=await post('purchase-meta', {source_type:'expense', source_id:1, gst_rate_pct:18, supplier_state:'27', tds_section:'194J', tds_rate:10});
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.meta.igst, 1800); assert.equal(r.data.meta.tds_amount, 1000);
    db.prepare(`INSERT INTO accounting_vendor_bills (client_id, supplier, bill_date, line_items_json, currency, subtotal, total, status, paid_at, created_at) VALUES (7,'AWS',?,?,'INR',5000,5000,'paid',?,?)`).run(T, JSON.stringify([{name:'AWS hosting', qty:1, price:5000}]), T, T);
    db.prepare(`INSERT INTO acc_payment_entries (client_id, payment_type, payment_date, amount, currency, account_id, source_type, source_id, created_at) VALUES (7,'pay',?,5000,'INR',1,'vendor_bill',1,?)`).run(T, T);
    const tb=await tbMap();
    assert.equal(tb['6220'], 10000); assert.equal(tb['1302'], 1800); assert.equal(tb['2300'], -1000);
    assert.equal(tb['5000'], 5000); assert.equal(tb['2100']||0, 0);
    assert.equal(tb['1120.1'], 45000); assert.equal(tb['3200'], -50000);
    assert.equal(tb['1100'], -10800); // expense with no bank account → default Cash in Hand
  });

  test('foreign-currency invoice settles at a new rate → realised FX gain', async ()=>{
    await post('fx', {currency:'USD', rate_date:'2026-01-01', rate:80});
    await post('fx', {currency:'USD', rate_date:T, rate:85});
    const id=invoice({total:100, subtotal:100, cgst:0, sgst:0, rate:0, currency:'USD', date:'2026-02-01'});
    db.prepare(`INSERT INTO accounting_documents (client_id, type, title, line_items_json, currency, subtotal, total, status, linked_doc_id, customer_name, doc_created_at) VALUES (7,'receipt','x','[]','USD',100,100,'paid',?,'Beta Co',?)`).run(id, `${T}T11:00:00Z`);
    const tb=await tbMap();
    assert.equal(tb['4000'], -8000); assert.equal(tb['1150'], 8500); assert.equal(tb['4910'], -500); assert.equal(tb['1200']||0, 0);
  });

  test('finalizeEntry flips negatives, merges, and rounds sub-5-paise drift', ()=>{
    const ctx={byKey:{ROUNDING:99}};
    const e=newEntry('x','1',T,'m'); dr(e,1,100.03); cr(e,2,-5); cr(e,3,105); finalizeEntry(e, ctx);
    assert.ok(e.balanced); assert.deepEqual(e.lines.find(l=>l.account_id===2), {account_id:2, debit:5, credit:0});
    assert.equal(e.lines.find(l=>l.account_id===99).credit, 0.03);
  });
});

describe('books', ()=>{
  test('manual journal validation, reverse, void and a balanced balance sheet after year-end close', async ()=>{
    await get('accounts');
    const cash=acct('CASH'), cap=acct('CAPITAL'), rent=acct('RENT');
    let r=await post('journals', {date:'2025-05-01', memo:'Capital', lines:[{account_id:cash, debit:100000},{account_id:cap, credit:90000}]});
    assert.equal(r.status, 400); assert.match(r.data.error, /must equal/);
    r=await post('journals', {date:'2025-05-01', memo:'Capital', lines:[{account_id:cash, debit:100000},{account_id:cap, credit:100000}]}); assert.equal(r.status, 200);
    r=await post('journals', {date:'2025-06-01', memo:'Rent', lines:[{account_id:rent, debit:20000},{account_id:cash, credit:20000}]}); assert.equal(r.status, 200);
    invoice({date:'2025-07-01'});
    const close=await post('close-year', {fy:2025});
    // FY2025 (Apr 2025 – Mar 2026) has ended only if today is past 2026-03-31.
    if(T>'2026-03-31'){
      assert.equal(close.status, 200, JSON.stringify(close.data)); assert.equal(close.data.net_profit, -19000);
      const {data:pl}=await get('pl?from=2025-04-01&to=2026-03-31'); assert.equal(pl.net_profit, -19000, 'P&L ignores the closing entry');
      const {data:bs}=await get(`balance-sheet?as_of=${T}`); assert.ok(bs.balanced, JSON.stringify(bs));
      assert.equal(bs.equity.flatMap(g=>g.rows).find(x=>x.code==='3100').amount, -19000);
      r=await post('journals', {date:'2025-12-01', memo:'late', lines:[{account_id:rent, debit:1},{account_id:cash, credit:1}]});
      assert.equal(r.status, 409, 'closed year is locked');
    }
    const j=one(`SELECT id FROM acc_journals WHERE memo='Rent'`).id;
    r=await post('journals/reverse', {id:j, date:T}); assert.equal(r.status, 200);
    const inv=one(`SELECT id FROM acc_journals WHERE source_type='invoice'`).id;
    r=await post('journals/void', {id:inv}); assert.equal(r.status, 400); assert.match(r.data.error, /posted automatically/);
  });

  test('chart of accounts: system accounts protected, used accounts cannot be deleted', async ()=>{
    let r=await post('accounts', {code:'6500', name:'Team Offsite', type:'expense', subtype:'operating'}); assert.equal(r.status, 200);
    r=await post('accounts', {code:'6500', name:'Dup', type:'expense'}); assert.equal(r.status, 400);
    r=await post('accounts/delete', {id:acct('AR')}); assert.equal(r.status, 400);
    r=await post('accounts/delete', {id:one(`SELECT id FROM acc_accounts WHERE code='6500'`).id}); assert.equal(r.status, 200);
    const {data}=await get('accounts'); assert.ok(data.list.length>50);
  });

  test('credit note against an invoice reduces AR and is capped at the balance', async ()=>{
    const id=invoice();
    let r=await post('notes', {note_type:'credit', linked_id:id, subtotal:2000, reason:'discount'}); assert.equal(r.status, 400);
    r=await post('notes', {note_type:'credit', linked_id:id, subtotal:500, reason:'discount'}); assert.equal(r.status, 200); assert.equal(r.data.total, 590);
    const tb=await tbMap(); assert.equal(tb['1200'], 590); assert.equal(tb['4800'], 500); assert.equal(tb['2200'], -45);
    const {data:ar}=await get('ar-aging'); assert.equal(ar.items[0].balance, 590);
  });

  test('roles: viewer is read-only, other clients see nothing', async ()=>{
    await post('roles', {email:'ca@x.in', role:'ca'});
    invoice();
    assert.equal((await get('trial-balance', 'viewer')).status, 200);
    const r=await post('journals', {date:T, lines:[]}, 'viewer'); assert.equal(r.status, 403);
    const other=await get(`trial-balance?from=2000-01-01&to=${T}`, 'other'); assert.equal(other.data.rows.length, 0);
    assert.equal((await post('roles', {email:'owner@x.in', role:'viewer'})).status, 400);
  });
});

describe('saas', ()=>{
  test('annual plan: billing run invoices into deferred revenue and recognises monthly', async ()=>{
    const start=addMonths(T.slice(0,7)+'-01', -2);
    let r=await post('plans', {name:'Pro Annual', amount:12000, interval:'year', gst_rate_pct:18}); const plan=r.data.id;
    r=await post('subscriptions', {customer_name:'Gamma', customer_email:'g@x.in', plan_id:plan, start_date:start, place_of_supply:'32'}); assert.equal(r.status, 200, JSON.stringify(r.data));
    r=await post('billing-run', {}); assert.equal(r.data.results[0].invoices.length, 1);
    const inv=one(`SELECT * FROM accounting_documents WHERE type='invoice'`);
    assert.equal(inv.total, 14160); assert.equal(inv.cgst_amount, 1080);
    const tb=await tbMap();
    assert.equal(tb['2500'], -(12000-3000)); assert.equal(tb['4100'], -3000);
    const {data:m}=await get('metrics'); assert.equal(m.mrr, 1000); assert.equal(m.arr, 12000);
    const sub=one(`SELECT * FROM acc_subscriptions`); assert.equal(sub.next_billing_date, addMonths(start, 12));
  });

  test('mid-period upgrade creates a proration invoice and an expansion event', async ()=>{
    const start=addDays(T,-10);
    const r=await post('subscriptions', {customer_name:'Delta', plan_name:'Starter', amount:3000, interval:'month', start_date:start}); const id=r.data.id;
    await post('billing-run', {});
    const ch=await post('subscriptions/change', {id, amount:6000}); assert.equal(ch.status, 200, JSON.stringify(ch.data));
    assert.equal(ch.data.proration.type, 'invoice'); assert.ok(ch.data.proration.amount>0 && ch.data.proration.amount<3000);
    const ev=q(`SELECT kind, mrr_delta FROM acc_sub_events ORDER BY id`); assert.deepEqual(ev.map(e=>e.kind), ['new','expansion']); assert.equal(ev[1].mrr_delta, 3000);
    await post('subscriptions/action', {id, action:'cancel', reason:'budget'});
    const {data:m}=await get('metrics'); assert.equal(m.mrr, 0);
  });

  test('trial converts on its end date; coupon discount applies; dunning emails then suspends', async ()=>{
    await post('coupons', {code:'half', kind:'pct', value:50, duration_months:1});
    const start=addDays(T,-20);
    await post('subscriptions', {customer_name:'Eps', customer_email:'e@x.in', plan_name:'Std', amount:1000, interval:'month', start_date:start, trial_days:10, coupon_code:'HALF'});
    await post('billing-run', {});
    const invs=q(`SELECT * FROM accounting_documents WHERE type='invoice' ORDER BY id`);
    assert.equal(invs.length, 1); assert.equal(invs[0].total, 500); assert.equal(invs[0].doc_created_at.slice(0,10), addDays(start,10));
    await post('settings', {dunning:{enabled:true, reminder_days:[1,3], suspend_after_days:2, email:true}});
    await post('collections-run', {});
    assert.equal(emails.length, 1); assert.match(emails[0].subject, /Invoice #1/);
    assert.equal(one(`SELECT status FROM acc_subscriptions`).status, 'suspended');
    await post('collections-run', {}); assert.equal(emails.length, 1, 'each step is sent once');
  });

  test('settlement CSV import posts net to bank with fees and GST on fees', async ()=>{
    db.prepare(`INSERT INTO acc_bank_accounts (client_id, name, type, currency, opening_balance, created_at) VALUES (7,'ICICI','bank','INR',0,?)`).run(T);
    const r=await post('settlements/import', {bank_account_id:1, csv:`settlement_id,settled_at,amount,fees,tax,net\nsetl_1,${T},10000,200,36,9764\n`});
    assert.equal(r.data.imported, 1);
    const tb=await tbMap(); assert.equal(tb['1120.1'], 9764); assert.equal(tb['5200'], 200); assert.equal(tb['1150'], -10000);
  });
});

describe('tax', ()=>{
  test('GSTR-1 buckets and GSTR-3B set-off', async ()=>{
    invoice({customer:'B2C Walkin'});
    const b2b=invoice({customer:'Corp', cgst:0, sgst:0, igst:180});
    db.prepare(`UPDATE accounting_documents SET recipient_gstin='27AAAAA0000A1Z5', supply_type='B2B', place_of_supply='27' WHERE id=?`).run(b2b);
    db.prepare(`INSERT INTO accounting_vendor_bills (client_id, supplier, bill_date, line_items_json, currency, subtotal, total, status, created_at) VALUES (7,'Freelancer',?,'[]','INR',1180,1180,'unpaid',?)`).run(T, T);
    await post('purchase-meta', {source_type:'vendor_bill', source_id:1, gst_rate_pct:18, supplier_state:'32'});
    const {data:g1}=await get(`gstr1?month=${T.slice(0,7)}`);
    assert.equal(g1.b2b.length, 1); assert.equal(g1.b2cs.length, 1); assert.equal(g1.totals.taxable, 2000); assert.equal(g1.hsn[0].hsn, '998361');
    const {data:g3}=await get(`gstr3b?month=${T.slice(0,7)}`);
    assert.equal(g3.tax_liability.igst, 180); assert.equal(g3.itc_available.total.cgst, 90);
    assert.equal(g3.total_cash_payable, 180+90+90-180);
  });
  test('gstSplitFor intra vs inter state', ()=>{
    assert.deepEqual(gstSplitFor(1000, 18, '32', '32'), {cgst:90, sgst:90, igst:0});
    assert.deepEqual(gstSplitFor(1000, 18, '32', '27'), {cgst:0, sgst:0, igst:180});
  });
});

describe('operations', ()=>{
  test('depreciation SLM and WDV', ()=>{
    const s=depreciationSchedule({cost:36000, salvage:0, useful_life_months:36, method:'slm', purchase_date:'2026-01-10'});
    assert.equal(s.length, 36); assert.equal(s[0].amount, 1000); assert.equal(s.at(-1).book_value, 0);
    const w=depreciationSchedule({cost:100000, salvage:5000, useful_life_months:60, method:'wdv', wdv_rate_pct:40, purchase_date:'2026-01-10'});
    assert.equal(w[0].amount, 3333.33); assert.ok(w.at(-1).book_value>=5000);
  });
  test('payroll PF/ESI/PT and posting', async ()=>{
    const line=computePayrollLine({id:1, name:'A', basic:20000, hra:5000, other_allowances:0, pf_applicable:1, esi_applicable:1, pt_monthly:200, tds_monthly:0}, {pf_rate:12, pf_wage_cap:15000, employer_pf_rate:12, esi_employee_rate:0.75, esi_employer_rate:3.25, esi_wage_limit:21000});
    assert.equal(line.employee_pf, 1800); assert.equal(line.employee_esi, 0, 'gross above ESI limit'); assert.equal(line.net, 25000-1800-200);
    await post('employees', {name:'A', basic:12000, hra:4000, pt_monthly:200});
    const m=T.slice(0,7);
    const p=await post('payroll/prepare', {period_month:m, run_date:T}); assert.equal(p.status, 200, JSON.stringify(p.data));
    const id=one(`SELECT id FROM acc_payroll_runs`).id;
    await post('payroll/action', {id, action:'post'});
    const tb=await tbMap();
    assert.equal(tb['6000'], 16000); assert.equal(tb['2410'], -(1440*2)); assert.equal(tb['2420'], -(120+520));
  });
  test('recurring journal materialises each due date once', async ()=>{
    await get('accounts');
    const r=await post('recurring', {name:'Rent', frequency:'month', next_date:addMonths(T,-2), lines:[{account_id:acct('RENT'), debit:500},{account_id:acct('CASH'), credit:500}]}); assert.equal(r.status, 200);
    const a=await post('recurring/run', {}); assert.equal(a.data.posted.length, 3);
    const b=await post('recurring/run', {}); assert.equal(b.data.posted.length, 0);
  });
  test('expense approval keeps pending expenses out of the ledger', async ()=>{
    await post('settings', {expense_approval_required:true});
    const { accLedgerOnExpenseCreated }=await import('./accounting-ledger.js');
    db.prepare(`INSERT INTO accounting_expenses (client_id, expense_account, amount, currency, expense_date, category, created_at) VALUES (7,'x',700,'INR',?,'Travel',?)`).run(T, T);
    await accLedgerOnExpenseCreated(env, 7, 1, 'emp@x.in');
    let tb=await tbMap(); assert.equal(tb['6230']||0, 0);
    await post('approvals/decide', {expense_id:1, decision:'approve'});
    tb=await tbMap(); assert.equal(tb['6230'], 700);
  });
  test('client portal shows only that customer, with balances', async ()=>{
    invoice({customer:'Beta Co'}); invoice({customer:'Other'});
    const t=await post('portal-tokens', {customer_name:'Beta Co'});
    const url=new URL(`https://w.example/accounting/portal/${t.data.token}`);
    const res=await accLedgerHandleRoute(new Request(url), env, deps, url); const data=await res.json();
    assert.equal(data.invoices.length, 1); assert.equal(data.outstanding, 1180); assert.equal(data.business.name, 'Acme Digital');
    const bad=new URL('https://w.example/accounting/portal/nope'); assert.equal((await accLedgerHandleRoute(new Request(bad), env, deps, bad)).status, 404);
  });
  test('dashboard, forecast, anomalies, exports run end to end', async ()=>{
    invoice(); invoice({date:addDays(T,-60)});
    db.prepare(`INSERT INTO accounting_vendor_bills (client_id, supplier, bill_date, line_items_json, currency, subtotal, total, status, created_at) VALUES (7,'AWS',?,'[]','INR',500,500,'unpaid',?),(7,'AWS',?,'[]','INR',500,500,'unpaid',?)`).run(T, T, addDays(T,-2), T);
    const {data:d}=await get('dashboard'); assert.equal(d.receivables, 2360); assert.ok(d.anomalies.some(a=>a.kind==='duplicate_bill'));
    const {data:f}=await get('forecast'); assert.equal(f.weeks.length, 13);
    const {data:x}=await get('export/tally'); assert.match(x.vouchers_xml, /<VOUCHER VCHTYPE="Journal"/); assert.match(x.masters_xml, /Sundry Debtors/);
    for(const p of ['cash-flow','balance-sheet','unit-economics','budget','tds','fx','fx/revaluation','purchase-register','journals','audit','revrec','subscriptions','approvals','assets','bank-unmatched','reminders-log','category-map','parties'])
      assert.equal((await get(p)).status, 200, p);
  });
  test('daily job bills, posts recurring and syncs without throwing', async ()=>{
    await get('me');
    await post('subscriptions', {customer_name:'Zeta', plan_name:'M', amount:100, interval:'month', start_date:T});
    await accLedgerRunDaily(env, deps);
    assert.equal(one(`SELECT COUNT(*) n FROM accounting_documents WHERE type='invoice'`).n, 1);
  });
  test('csv parser handles quotes', ()=>{ assert.deepEqual(parseCsv('a,b\n"x, y","q""z"\n'), [['a','b'],['x, y','q"z']]); });
});
