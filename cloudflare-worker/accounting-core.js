// Accounting ledger core (frontend/accounting.html → 🏠 Overview / 📒 Books / 🔁 Subscriptions /
// 🧾 Tax / ⚙️ Operations tabs). A real double-entry General Ledger underneath the existing
// Documents / Expenses / Vendor Bills / Bank & Cash / Financial Planning tables.
//
// Design: the existing tables stay the system of record for what they hold. The ledger is DERIVED
// from them by ledgerSync() — every invoice, receipt, expense, bill, payment entry, collection,
// credit note, depreciation month, payroll run… becomes one journal entry keyed by
// (source_type, source_ref). Each sync rebuilds the desired set, compares a hash against what is
// stored and writes only the differences, so the existing handlers in worker.js needed no posting
// hooks at all and an edited invoice simply re-posts. Entries dated on or before the lock date are
// never touched again (a change to a locked source becomes a warning instead). Manual journals,
// recurring-template journals and year-end closing entries are MATERIALIZED (written once, never
// re-derived). Every table lives in D1; schema is ensured lazily (same reasoning as worker.js's
// accEnsureSchema: migrations are a separate deploy step) and mirrored in migrations/0117.

export const r2=n=>Math.round((Number(n)||0)*100)/100;
export const todayStr=()=>new Date().toISOString().slice(0,10);
export const monthOf=d=>String(d||'').slice(0,7);
export function addMonths(dateStr, n){
  const [y,m,d]=String(dateStr).slice(0,10).split('-').map(Number);
  const t=new Date(Date.UTC(y, m-1+n, 1));
  const last=new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth()+1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d||1, last));
  return t.toISOString().slice(0,10);
}
export function addDays(dateStr, n){ const t=new Date(String(dateStr).slice(0,10)+'T00:00:00Z'); t.setUTCDate(t.getUTCDate()+n); return t.toISOString().slice(0,10); }
export function daysBetween(a, b){ return Math.round((new Date(String(b).slice(0,10)+'T00:00:00Z')-new Date(String(a).slice(0,10)+'T00:00:00Z'))/86400000); }
export function monthStart(m){ return `${m}-01`; }
export function monthEnd(m){ const [y,mo]=m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0,10); }
export function monthsRange(fromM, toM){ const out=[]; let m=fromM; let guard=0; while(m<=toM && guard++<600){ out.push(m); m=addMonths(m+'-01',1).slice(0,7); } return out; }
export const INTERVAL_MONTHS={month:1, quarter:3, half_year:6, year:12};
// Fiscal year containing `date` (fyStartMonth 4 = April, India's FY). Returns {fy, from, to}
// where fy is the starting calendar year.
export function fiscalYear(date, fyStartMonth=4){
  const [y,m]=String(date).slice(0,7).split('-').map(Number);
  const fy=m>=fyStartMonth?y:y-1;
  const from=`${fy}-${String(fyStartMonth).padStart(2,'0')}-01`;
  return {fy, from, to:addDays(addMonths(from,12),-1)};
}
export function str(v, max=200){ return v==null?'':String(v).trim().slice(0,max); }
export function num(v){ const n=Number(v); return Number.isFinite(n)?n:0; }
export function randomToken(bytes=16){ const a=new Uint8Array(bytes); crypto.getRandomValues(a); return [...a].map(b=>b.toString(16).padStart(2,'0')).join(''); }
function fnv(s){ let h=0x811c9dc5; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,0x01000193)>>>0; } return h.toString(36); }
export function hashOf(obj){ const s=JSON.stringify(obj); return fnv(s)+fnv(s.split('').reverse().join(''))+s.length.toString(36); }

/* ── Schema ── */
export const ACC_LEDGER_SCHEMA=[
  `CREATE TABLE IF NOT EXISTS acc_settings (client_id INTEGER PRIMARY KEY, base_currency TEXT NOT NULL DEFAULT 'INR', fy_start_month INTEGER NOT NULL DEFAULT 4, lock_date TEXT, coa_template TEXT NOT NULL DEFAULT 'both', default_payment_account_id INTEGER, payment_terms_days INTEGER NOT NULL DEFAULT 7, expense_approval_required INTEGER NOT NULL DEFAULT 0, default_role TEXT NOT NULL DEFAULT 'admin', business_name TEXT, gstin TEXT, state_code TEXT, pan TEXT, tan TEXT, lut_number TEXT, lut_valid_till TEXT, upi_id TEXT, upi_name TEXT, email_invoices INTEGER NOT NULL DEFAULT 0, reminders_json TEXT, dunning_json TEXT, payroll_json TEXT, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS acc_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, subtype TEXT, parent_id INTEGER, system_key TEXT, bank_account_id INTEGER, description TEXT, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_acc_accounts_code ON acc_accounts(client_id, code)`,
  `CREATE INDEX IF NOT EXISTS idx_acc_accounts_key ON acc_accounts(client_id, system_key)`,
  `CREATE TABLE IF NOT EXISTS acc_journals (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, entry_no INTEGER NOT NULL DEFAULT 0, entry_date TEXT NOT NULL, memo TEXT, source_type TEXT NOT NULL DEFAULT 'manual', source_ref TEXT, source_hash TEXT, status TEXT NOT NULL DEFAULT 'posted', reversal_of INTEGER, currency TEXT, fx_rate REAL, total REAL NOT NULL DEFAULT 0, branch TEXT, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT, voided_at TEXT, void_reason TEXT)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_acc_journals_source ON acc_journals(client_id, source_type, source_ref) WHERE source_ref IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_acc_journals_date ON acc_journals(client_id, entry_date)`,
  `CREATE TABLE IF NOT EXISTS acc_journal_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, journal_id INTEGER NOT NULL, account_id INTEGER NOT NULL, debit REAL NOT NULL DEFAULT 0, credit REAL NOT NULL DEFAULT 0, description TEXT, party_type TEXT, party_name TEXT, branch TEXT, fc_currency TEXT, fc_amount REAL)`,
  `CREATE INDEX IF NOT EXISTS idx_acc_journal_lines_journal ON acc_journal_lines(journal_id)`,
  `CREATE INDEX IF NOT EXISTS idx_acc_journal_lines_account ON acc_journal_lines(client_id, account_id)`,
  `CREATE TABLE IF NOT EXISTS acc_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, at TEXT NOT NULL, actor TEXT, action TEXT NOT NULL, entity_type TEXT, entity_id TEXT, details TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_acc_audit_client ON acc_audit_log(client_id, at)`,
  `CREATE TABLE IF NOT EXISTS acc_user_roles (client_id INTEGER NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(client_id, email))`,
  `CREATE TABLE IF NOT EXISTS acc_category_map (client_id INTEGER NOT NULL, category TEXT NOT NULL, account_id INTEGER NOT NULL, PRIMARY KEY(client_id, category))`,
  `CREATE TABLE IF NOT EXISTS acc_purchase_meta (client_id INTEGER NOT NULL, source_type TEXT NOT NULL, source_id INTEGER NOT NULL, expense_account_id INTEGER, gst_rate_pct REAL NOT NULL DEFAULT 0, cgst REAL NOT NULL DEFAULT 0, sgst REAL NOT NULL DEFAULT 0, igst REAL NOT NULL DEFAULT 0, itc_eligible INTEGER NOT NULL DEFAULT 1, reverse_charge INTEGER NOT NULL DEFAULT 0, supplier_gstin TEXT, supplier_pan TEXT, hsn_sac TEXT, tds_section TEXT, tds_rate REAL NOT NULL DEFAULT 0, tds_amount REAL NOT NULL DEFAULT 0, branch TEXT, PRIMARY KEY(client_id, source_type, source_id))`,
  `CREATE TABLE IF NOT EXISTS acc_doc_meta (client_id INTEGER NOT NULL, doc_id INTEGER NOT NULL, revenue_account_id INTEGER, subscription_id INTEGER, period_start TEXT, period_end TEXT, irn TEXT, ack_no TEXT, ack_date TEXT, signed_qr TEXT, eway_bill_no TEXT, payment_link_id TEXT, payment_link_url TEXT, branch TEXT, PRIMARY KEY(client_id, doc_id))`,
  `CREATE TABLE IF NOT EXISTS acc_payment_meta (client_id INTEGER NOT NULL, payment_entry_id INTEGER NOT NULL, account_id INTEGER NOT NULL, PRIMARY KEY(client_id, payment_entry_id))`,
  `CREATE TABLE IF NOT EXISTS acc_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, note_type TEXT NOT NULL, note_date TEXT NOT NULL, party_name TEXT, linked_type TEXT, linked_id INTEGER, reason TEXT NOT NULL DEFAULT 'return', currency TEXT, subtotal REAL NOT NULL DEFAULT 0, gst_rate_pct REAL NOT NULL DEFAULT 0, cgst REAL NOT NULL DEFAULT 0, sgst REAL NOT NULL DEFAULT 0, igst REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0, place_of_supply TEXT, recipient_gstin TEXT, refund_account_id INTEGER, refund_date TEXT, status TEXT NOT NULL DEFAULT 'open', notes TEXT, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_acc_notes_client ON acc_notes(client_id, note_date)`,
  `CREATE TABLE IF NOT EXISTS acc_fx_rates (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, currency TEXT NOT NULL, rate_date TEXT NOT NULL, rate REAL NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_acc_fx_rates ON acc_fx_rates(client_id, currency, rate_date)`,
  `CREATE TABLE IF NOT EXISTS acc_plans (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, name TEXT NOT NULL, code TEXT, amount REAL NOT NULL DEFAULT 0, currency TEXT, interval TEXT NOT NULL DEFAULT 'month', trial_days INTEGER NOT NULL DEFAULT 0, gst_rate_pct REAL NOT NULL DEFAULT 0, sac_code TEXT, metered_unit_name TEXT, metered_unit_price REAL NOT NULL DEFAULT 0, included_units REAL NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS acc_coupons (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, code TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'pct', value REAL NOT NULL DEFAULT 0, duration_months INTEGER NOT NULL DEFAULT 0, max_redemptions INTEGER NOT NULL DEFAULT 0, redeemed INTEGER NOT NULL DEFAULT 0, valid_till TEXT, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS acc_subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, customer_name TEXT NOT NULL, customer_email TEXT, customer_phone TEXT, fp_customer_id INTEGER, lead_id INTEGER, plan_id INTEGER, plan_name TEXT, amount REAL NOT NULL DEFAULT 0, currency TEXT, interval TEXT NOT NULL DEFAULT 'month', quantity REAL NOT NULL DEFAULT 1, coupon_id INTEGER, discount_pct REAL NOT NULL DEFAULT 0, discount_amount REAL NOT NULL DEFAULT 0, discount_months_left INTEGER NOT NULL DEFAULT -1, start_date TEXT NOT NULL, trial_end TEXT, current_period_start TEXT, next_billing_date TEXT, status TEXT NOT NULL DEFAULT 'active', cancel_at TEXT, cancelled_at TEXT, cancel_reason TEXT, gst_rate_pct REAL NOT NULL DEFAULT 0, place_of_supply TEXT, recipient_gstin TEXT, auto_invoice INTEGER NOT NULL DEFAULT 1, recognize_over_period INTEGER NOT NULL DEFAULT 1, last_invoice_id INTEGER, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_acc_subscriptions_client ON acc_subscriptions(client_id, status)`,
  `CREATE TABLE IF NOT EXISTS acc_sub_events (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, subscription_id INTEGER NOT NULL, event_date TEXT NOT NULL, kind TEXT NOT NULL, mrr_delta REAL NOT NULL DEFAULT 0, mrr_after REAL NOT NULL DEFAULT 0, note TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_acc_sub_events_client ON acc_sub_events(client_id, event_date)`,
  `CREATE TABLE IF NOT EXISTS acc_usage_records (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, subscription_id INTEGER NOT NULL, metric TEXT, quantity REAL NOT NULL DEFAULT 0, usage_date TEXT NOT NULL, billed_invoice_id INTEGER, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_acc_usage_sub ON acc_usage_records(client_id, subscription_id, usage_date)`,
  `CREATE TABLE IF NOT EXISTS acc_revrec_schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, invoice_id INTEGER NOT NULL, start_month TEXT NOT NULL, months INTEGER NOT NULL, revenue_account_id INTEGER, created_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_acc_revrec_invoice ON acc_revrec_schedules(client_id, invoice_id)`,
  `CREATE TABLE IF NOT EXISTS acc_reminder_log (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, invoice_id INTEGER NOT NULL, subscription_id INTEGER, step TEXT NOT NULL, channel TEXT, status TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_acc_reminder_log ON acc_reminder_log(client_id, invoice_id)`,
  `CREATE TABLE IF NOT EXISTS acc_gateway_settlements (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, gateway TEXT NOT NULL DEFAULT 'razorpay', settlement_ref TEXT NOT NULL, settlement_date TEXT NOT NULL, gross REAL NOT NULL DEFAULT 0, fee REAL NOT NULL DEFAULT 0, tax_on_fee REAL NOT NULL DEFAULT 0, net REAL NOT NULL DEFAULT 0, bank_account_id INTEGER, notes TEXT, created_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_acc_settlements_ref ON acc_gateway_settlements(client_id, gateway, settlement_ref)`,
  `CREATE TABLE IF NOT EXISTS acc_tds_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, entry_date TEXT NOT NULL, party_name TEXT, tan TEXT, section TEXT, base_amount REAL NOT NULL DEFAULT 0, amount REAL NOT NULL DEFAULT 0, linked_invoice_id INTEGER, offset_account_id INTEGER, certificate_no TEXT, notes TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS acc_tds_challans (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, section TEXT, quarter TEXT, amount REAL NOT NULL DEFAULT 0, interest REAL NOT NULL DEFAULT 0, paid_date TEXT NOT NULL, challan_no TEXT, bsr_code TEXT, bank_account_id INTEGER, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS acc_recurring_journals (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, name TEXT NOT NULL, frequency TEXT NOT NULL DEFAULT 'month', next_date TEXT NOT NULL, end_date TEXT, memo TEXT, lines_json TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, last_run_at TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS acc_bank_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, match_text TEXT NOT NULL, direction TEXT NOT NULL DEFAULT 'any', account_id INTEGER NOT NULL, party_name TEXT, priority INTEGER NOT NULL DEFAULT 100, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS acc_expense_approvals (client_id INTEGER NOT NULL, expense_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', decided_by TEXT, decided_at TEXT, note TEXT, PRIMARY KEY(client_id, expense_id))`,
  `CREATE TABLE IF NOT EXISTS acc_fixed_assets (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, name TEXT NOT NULL, category TEXT, asset_account_id INTEGER, purchase_date TEXT NOT NULL, cost REAL NOT NULL DEFAULT 0, salvage REAL NOT NULL DEFAULT 0, useful_life_months INTEGER NOT NULL DEFAULT 36, method TEXT NOT NULL DEFAULT 'slm', wdv_rate_pct REAL NOT NULL DEFAULT 0, paid_from_account_id INTEGER, disposed_date TEXT, disposal_amount REAL NOT NULL DEFAULT 0, disposal_account_id INTEGER, notes TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS acc_employees (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, name TEXT NOT NULL, email TEXT, pan TEXT, uan TEXT, designation TEXT, department TEXT, basic REAL NOT NULL DEFAULT 0, hra REAL NOT NULL DEFAULT 0, other_allowances REAL NOT NULL DEFAULT 0, pf_applicable INTEGER NOT NULL DEFAULT 1, esi_applicable INTEGER NOT NULL DEFAULT 1, pt_monthly REAL NOT NULL DEFAULT 0, tds_monthly REAL NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, joined_on TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS acc_payroll_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, period_month TEXT NOT NULL, run_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', lines_json TEXT NOT NULL DEFAULT '[]', gross REAL NOT NULL DEFAULT 0, net REAL NOT NULL DEFAULT 0, employer_cost REAL NOT NULL DEFAULT 0, paid_account_id INTEGER, paid_date TEXT, created_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_acc_payroll_month ON acc_payroll_runs(client_id, period_month)`,
  `CREATE TABLE IF NOT EXISTS acc_budgets (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, fiscal_year INTEGER NOT NULL, account_id INTEGER NOT NULL, branch TEXT NOT NULL DEFAULT '', months_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_acc_budgets ON acc_budgets(client_id, fiscal_year, account_id, branch)`,
  `CREATE TABLE IF NOT EXISTS acc_cost_allocations (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, source_type TEXT NOT NULL, source_id INTEGER NOT NULL, customer_name TEXT NOT NULL, pct REAL NOT NULL DEFAULT 100, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS acc_portal_tokens (token TEXT PRIMARY KEY, client_id INTEGER NOT NULL, customer_name TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_acc_portal_client ON acc_portal_tokens(client_id)`,
];
const schemaReady=new WeakMap();
export async function accLedgerEnsureSchema(env){
  if(!env?.DB) return;
  const cached=schemaReady.get(env.DB);
  if(cached) return cached;
  // One lookup tells whether every table/index already exists (the normal case) — only a brand-new
  // or upgraded database pays for the CREATE statements, and those go in batches, not one by one.
  const pending=(async()=>{
    const names=ACC_LEDGER_SCHEMA.map(s=>s.match(/IF NOT EXISTS\s+(\w+)/i)?.[1]).filter(Boolean);
    let have=new Set();
    try{ const {results}=await env.DB.prepare(`SELECT name FROM sqlite_master WHERE name IN (${names.map(()=>'?').join(',')})`).bind(...names).all(); have=new Set((results||[]).map(r=>r.name)); }catch(e){}
    const missing=ACC_LEDGER_SCHEMA.filter(s=>{ const n=s.match(/IF NOT EXISTS\s+(\w+)/i)?.[1]; return !n || !have.has(n); });
    if(!missing.length) return;
    if(typeof env.DB.batch==='function'){ for(let i=0;i<missing.length;i+=50) await env.DB.batch(missing.slice(i,i+50).map(s=>env.DB.prepare(s))); }
    else for(const s of missing) await env.DB.prepare(s).run();
  })();
  schemaReady.set(env.DB, pending);
  try{ await pending; }catch(e){ schemaReady.delete(env.DB); throw e; }
}

// D1 batch() runs its statements in one transaction and returns one result per statement; falls
// back to sequential runs where batch isn't available (tests' sqlite shim implements both).
export async function dbBatch(env, stmts){
  const out=[];
  if(!stmts.length) return out;
  if(typeof env.DB.batch==='function'){
    for(let i=0;i<stmts.length;i+=50) out.push(...await env.DB.batch(stmts.slice(i,i+50)));
    return out;
  }
  for(const s of stmts) out.push(await s.run());
  return out;
}
export async function allRows(env, sql, ...binds){
  try{ const {results}=await env.DB.prepare(sql).bind(...binds).all(); return results||[]; }
  catch(e){ if(/no such table|no such column/i.test(String(e.message))) return []; throw e; }
}
export async function firstRow(env, sql, ...binds){
  try{ return await env.DB.prepare(sql).bind(...binds).first(); }
  catch(e){ if(/no such table|no such column/i.test(String(e.message))) return null; throw e; }
}

/* ── Settings ── */
export async function getSettings(env, clientId){
  let row=await firstRow(env, `SELECT * FROM acc_settings WHERE client_id=?`, clientId);
  if(!row){
    const fp=await firstRow(env, `SELECT default_currency, business_gstin, business_state_code FROM fp_config WHERE client_id=?`, clientId);
    await env.DB.prepare(`INSERT OR IGNORE INTO acc_settings (client_id, base_currency, gstin, state_code, updated_at) VALUES (?,?,?,?,?)`)
      .bind(clientId, String(fp?.default_currency||'INR').toUpperCase(), fp?.business_gstin||null, fp?.business_state_code||null, new Date().toISOString()).run();
    row=await firstRow(env, `SELECT * FROM acc_settings WHERE client_id=?`, clientId);
  }
  return {...row, reminders:parseJson(row.reminders_json, DEFAULT_REMINDERS), dunning:parseJson(row.dunning_json, DEFAULT_DUNNING), payroll:parseJson(row.payroll_json, DEFAULT_PAYROLL)};
}
export function parseJson(s, dflt){ try{ const v=JSON.parse(s||''); return v&&typeof v==='object'?{...(Array.isArray(dflt)?{}:dflt), ...v}:dflt; }catch(e){ return dflt; } }
export const DEFAULT_REMINDERS={enabled:false, offsets:[-3,0,3,7,15], email:true, whatsapp:false};
export const DEFAULT_DUNNING={enabled:true, reminder_days:[1,3,7], suspend_after_days:15, email:true, whatsapp:false};
export const DEFAULT_PAYROLL={pf_rate:12, pf_wage_cap:15000, employer_pf_rate:12, esi_employee_rate:0.75, esi_employer_rate:3.25, esi_wage_limit:21000};
export const SETTINGS_FIELDS={base_currency:10, fy_start_month:'int', lock_date:'date', coa_template:20, default_payment_account_id:'id', payment_terms_days:'int', expense_approval_required:'bool', default_role:20, business_name:140, gstin:15, state_code:5, pan:10, tan:10, lut_number:60, lut_valid_till:'date', upi_id:80, upi_name:80, email_invoices:'bool', reminders:'json', dunning:'json', payroll:'json'};
export function isLocked(settings, date){ return !!(settings.lock_date && String(date).slice(0,10)<=settings.lock_date); }

/* ── Audit + roles ── */
export async function audit(env, clientId, actor, action, entityType, entityId, details){
  try{
    await env.DB.prepare(`INSERT INTO acc_audit_log (client_id, at, actor, action, entity_type, entity_id, details) VALUES (?,?,?,?,?,?,?)`)
      .bind(clientId, new Date().toISOString(), actor||null, action, entityType||null, entityId==null?null:String(entityId), details==null?null:(typeof details==='string'?details:JSON.stringify(details)).slice(0,4000)).run();
  }catch(e){}
}
export const ROLE_RANK={viewer:1, ca:1, approver:2, accountant:3, admin:4};
// Owner sessions issued before emails were added to the token, and any email with no explicit
// role, fall back to acc_settings.default_role (default 'admin' — so turning roles on never locks
// the owner out; tightening it to 'viewer' is an explicit choice).
export async function roleFor(env, clientId, email, settings){
  const e=String(email||'').trim().toLowerCase();
  if(e){ const r=await firstRow(env, `SELECT role FROM acc_user_roles WHERE client_id=? AND email=?`, clientId, e); if(r?.role) return r.role; }
  if(!e) return 'admin';
  return settings?.default_role||'admin';
}

/* ── Chart of Accounts ── */
// [code, name, type, subtype, system_key, templates] — templates: '' = all, 'saas', 'agency'.
export const COA_SEED=[
  ['1100','Cash in Hand','asset','cash','CASH'],
  ['1150','Undeposited Funds (receipts not yet banked)','asset','bank','UNDEPOSITED'],
  ['1200','Accounts Receivable','asset','receivable','AR'],
  ['1250','Unbilled Revenue','asset','current','UNBILLED','agency'],
  ['1300','GST Input — CGST','asset','tax','GST_IN_CGST'],
  ['1301','GST Input — SGST','asset','tax','GST_IN_SGST'],
  ['1302','GST Input — IGST','asset','tax','GST_IN_IGST'],
  ['1310','TDS Receivable','asset','tax','TDS_RECEIVABLE'],
  ['1350','Prepaid Expenses','asset','current','PREPAID'],
  ['1360','Advances to Staff & Suppliers','asset','current','ADVANCES'],
  ['1500','Computers & Equipment','asset','fixed','FA_DEFAULT'],
  ['1510','Furniture & Fixtures','asset','fixed',null],
  ['1590','Accumulated Depreciation','asset','contra_fixed','ACCUM_DEP'],
  ['2100','Accounts Payable','liability','payable','AP'],
  ['2150','Credit Card','liability','current',null],
  ['2200','GST Output — CGST','liability','tax','GST_OUT_CGST'],
  ['2201','GST Output — SGST','liability','tax','GST_OUT_SGST'],
  ['2202','GST Output — IGST','liability','tax','GST_OUT_IGST'],
  ['2210','GST Payable — Reverse Charge','liability','tax','GST_RCM'],
  ['2220','Sales Tax / VAT Payable','liability','tax','TAX_OUT'],
  ['2300','TDS Payable','liability','tax','TDS_PAYABLE'],
  ['2400','Salaries Payable','liability','current','SALARY_PAYABLE'],
  ['2410','PF Payable','liability','current','PF_PAYABLE'],
  ['2420','ESI Payable','liability','current','ESI_PAYABLE'],
  ['2430','Professional Tax Payable','liability','current','PT_PAYABLE'],
  ['2500','Deferred Revenue','liability','deferred','DEFERRED_REV'],
  ['2510','Customer Advances & Ad-spend Wallets','liability','current','CUSTOMER_ADVANCES'],
  ['2600','Loans','liability','long_term',null],
  ['3000',"Owner's Capital",'equity','equity','CAPITAL'],
  ['3100','Retained Earnings','equity','equity','RETAINED'],
  ['3200','Opening Balance Equity','equity','equity','OPENING_EQUITY'],
  ['3300','Drawings','equity','equity',null],
  ['4000','Sales / Service Revenue','income','operating','SALES'],
  ['4100','Subscription Revenue','income','operating','SUBSCRIPTION_REV'],
  ['4110','Usage & Overage Revenue','income','operating','USAGE_REV','saas'],
  ['4120','Setup & Implementation Fees','income','operating',null,'saas'],
  ['4200','Retainer Fees','income','operating',null,'agency'],
  ['4210','Project Fees','income','operating',null,'agency'],
  ['4220','Media Management Fees & Markup','income','operating',null,'agency'],
  ['4800','Sales Returns & Discounts','income','contra','SALES_RETURNS'],
  ['4900','Other Income','income','other','OTHER_INCOME'],
  ['4910','Foreign Exchange Gain / Loss','income','other','FX_GAIN_LOSS'],
  ['4920','Rounding Off','income','other','ROUNDING'],
  ['4990','Uncategorized Income','income','other','UNCATEGORIZED_INC'],
  ['5000','Hosting & Infrastructure','expense','cogs','HOSTING','saas'],
  ['5010','Third-party APIs & Licences','expense','cogs',null,'saas'],
  ['5100','Freelancers & Subcontractors','expense','cogs','FREELANCERS'],
  ['5110','Media / Ad Spend (pass-through)','expense','cogs','MEDIA_COST','agency'],
  ['5200','Payment Gateway Fees','expense','cogs','GATEWAY_FEES'],
  ['6000','Salaries & Wages','expense','payroll','SALARY_EXP'],
  ['6010',"Employer PF & ESI Contribution",'expense','payroll','EMPLOYER_CONTRIB'],
  ['6100','Advertising & Marketing','expense','sales_marketing','MARKETING'],
  ['6110','Sales Commissions','expense','sales_marketing',null],
  ['6200','Rent','expense','operating','RENT'],
  ['6210','Utilities & Internet','expense','operating','UTILITIES'],
  ['6220','Software Subscriptions','expense','operating','SOFTWARE'],
  ['6230','Travel & Conveyance','expense','operating','TRAVEL'],
  ['6240','Office Supplies','expense','operating',null],
  ['6250','Professional Fees (Legal / CA)','expense','operating','PROFESSIONAL'],
  ['6260','Bank Charges','expense','operating','BANK_CHARGES'],
  ['6270','Interest & Penalties','expense','operating','INTEREST_EXP'],
  ['6300','Depreciation','expense','operating','DEPRECIATION'],
  ['6400','Bad Debts','expense','operating','BAD_DEBTS'],
  ['6900','General Expenses','expense','operating','GENERAL_EXP'],
  ['6990','Uncategorized Expense','expense','operating','UNCATEGORIZED_EXP'],
];
export const ACCOUNT_TYPES=['asset','liability','equity','income','expense'];
// Keyword → system key, for expense categories / bill lines with no explicit account mapping.
const CATEGORY_KEYWORDS=[
  [/salar|wage|payroll|stipend/i,'SALARY_EXP'], [/rent|lease/i,'RENT'],
  [/electric|internet|broadband|utilit|phone|mobile|water/i,'UTILITIES'],
  [/aws|azure|gcp|hosting|server|cloud|domain|vercel|heroku|digitalocean|cloudflare/i,'HOSTING'],
  [/software|saas|subscription|licen[cs]e|notion|slack|figma|adobe|canva|zoom|google workspace|microsoft/i,'SOFTWARE'],
  [/ads?\b|advert|marketing|campaign|facebook|meta|google ads|promotion|seo|influencer/i,'MARKETING'],
  [/media spend|ad spend|media buy/i,'MEDIA_COST'],
  [/freelanc|contractor|subcontract|consultant/i,'FREELANCERS'],
  [/travel|cab|uber|ola|flight|hotel|fuel|petrol|conveyance/i,'TRAVEL'],
  [/legal|audit|\bca\b|chartered|lawyer|professional fee/i,'PROFESSIONAL'],
  [/bank charge|bank fee/i,'BANK_CHARGES'], [/razorpay fee|gateway|stripe fee/i,'GATEWAY_FEES'],
  [/interest|penalt|late fee/i,'INTEREST_EXP'],
];

export async function ensureCoa(env, clientId, settings){
  const [existing, banks]=await Promise.all([
    allRows(env, `SELECT * FROM acc_accounts WHERE client_id=?`, clientId),
    allRows(env, `SELECT id, name, type FROM acc_bank_accounts WHERE client_id=?`, clientId),
  ]);
  const now=new Date().toISOString();
  const tpl=settings?.coa_template||'both';
  const haveCodes=new Set(existing.map(a=>a.code)), haveKeys=new Set(existing.map(a=>a.system_key).filter(Boolean));
  const stmts=[];
  for(const [code,name,type,subtype,key,only] of COA_SEED){
    const fresh=!existing.length;
    // A fresh book gets the template's optional accounts; an existing book only ever gets missing
    // SYSTEM accounts added (a newer posting rule may need one) — never re-adds ones a user deleted.
    if(fresh ? (only && tpl!=='both' && only!==tpl) : (!key || haveKeys.has(key))) continue;
    if(haveCodes.has(code)) continue;
    stmts.push(env.DB.prepare(`INSERT INTO acc_accounts (client_id, code, name, type, subtype, system_key, is_active, created_at) VALUES (?,?,?,?,?,?,1,?)`).bind(clientId, code, name, type, subtype, key||null, now));
  }
  // One ledger account per Bank & Cash account (acc_bank_accounts) so payment entries post to it.
  const linked=new Set(existing.map(a=>a.bank_account_id).filter(Boolean));
  for(const b of banks){
    if(linked.has(b.id)) continue;
    stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO acc_accounts (client_id, code, name, type, subtype, bank_account_id, is_active, created_at) VALUES (?,?,?,?,?,?,1,?)`)
      .bind(clientId, `1120.${b.id}`, `${b.type==='cash'?'Cash':'Bank'} — ${b.name}`, 'asset', b.type==='cash'?'cash':'bank', b.id, now));
  }
  if(stmts.length) await dbBatch(env, stmts);
  return stmts.length ? await allRows(env, `SELECT * FROM acc_accounts WHERE client_id=?`, clientId) : existing;
}

export async function loadAccountContext(env, clientId, settings){
  const [accounts, catRows]=await Promise.all([
    ensureCoa(env, clientId, settings),
    allRows(env, `SELECT category, account_id FROM acc_category_map WHERE client_id=?`, clientId),
  ]);
  const byKey={}, byBank={}, byId={}, byName={};
  for(const a of accounts){
    byId[a.id]=a; byName[String(a.name).toLowerCase()]=a;
    if(a.system_key) byKey[a.system_key]=a.id;
    if(a.bank_account_id) byBank[a.bank_account_id]=a.id;
  }
  const catMap={}; for(const r of catRows) if(byId[r.account_id]) catMap[String(r.category).toLowerCase()]=r.account_id;
  return {accounts, byKey, byBank, byId, byName, catMap};
}
export function expenseAccountFor(ctx, ...hints){
  for(const h of hints){
    const k=String(h||'').trim().toLowerCase(); if(!k) continue;
    if(ctx.catMap[k]) return ctx.catMap[k];
    const a=ctx.byName[k]; if(a && a.type==='expense' && a.is_active) return a.id;
  }
  for(const h of hints){
    const s=String(h||''); if(!s) continue;
    for(const [re,key] of CATEGORY_KEYWORDS) if(re.test(s) && ctx.byKey[key]) return ctx.byKey[key];
  }
  return ctx.byKey.GENERAL_EXP;
}
export function suggestAccountKey(text){ for(const [re,key] of CATEGORY_KEYWORDS) if(re.test(String(text||''))) return key; return null; }

/* ── FX ── */
// Base-currency value of 1 unit of `currency` on `date`: latest acc_fx_rates row on/before the
// date, else the earliest one after it, else 1 (with a warning) — a book never fails to post just
// because a rate is missing; the Tax → FX Rates screen lists what's missing.
export function makeFx(rateRows, base, warnings){
  const by={};
  for(const r of rateRows){ (by[String(r.currency).toUpperCase()]=by[String(r.currency).toUpperCase()]||[]).push(r); }
  for(const k of Object.keys(by)) by[k].sort((a,b)=>a.rate_date.localeCompare(b.rate_date));
  const missing=new Set();
  const fx=(currency, date)=>{
    const c=String(currency||'').toUpperCase();
    if(!c || c===String(base).toUpperCase()) return 1;
    const list=by[c];
    if(!list?.length){ if(!missing.has(c)){ missing.add(c); warnings?.push({kind:'fx_missing', message:`No exchange rate for ${c} → ${base}; posted at 1:1. Add one under Tax → FX Rates.`}); } return 1; }
    let pick=list[0];
    for(const r of list){ if(r.rate_date<=date) pick=r; else break; }
    return Number(pick.rate)||1;
  };
  fx.missing=missing;
  return fx;
}

/* ── Journal entry builder ── */
export function newEntry(type, ref, date, memo, extra={}){
  return {source_type:type, source_ref:String(ref), entry_date:String(date||todayStr()).slice(0,10), memo:str(memo,300), currency:extra.currency||null, fx_rate:extra.fx||1, branch:extra.branch||null, lines:[]};
}
export function dr(e, accountId, amount, extra={}){ if(accountId && r2(amount)) e.lines.push({account_id:accountId, debit:r2(amount), credit:0, ...extra}); return e; }
export function cr(e, accountId, amount, extra={}){ if(accountId && r2(amount)) e.lines.push({account_id:accountId, debit:0, credit:r2(amount), ...extra}); return e; }
// Negative amounts flip sides (a negative revenue line becomes a debit) and lines for the same
// account+party+side are merged, then a sub-5-paise difference goes to Rounding Off.
export function finalizeEntry(e, ctx){
  const merged=new Map();
  for(const l of e.lines){
    let {debit,credit}=l;
    if(debit<0){ credit=-debit; debit=0; } if(credit<0){ debit=-credit; credit=0; }
    const side=debit?'d':'c';
    const k=`${l.account_id}|${l.party_name||''}|${side}|${l.description||''}`;
    const m=merged.get(k);
    if(m){ m.debit=r2(m.debit+debit); m.credit=r2(m.credit+credit); if(l.fc_amount!=null) m.fc_amount=r2((m.fc_amount||0)+l.fc_amount); }
    else merged.set(k, {...l, debit:r2(debit), credit:r2(credit)});
  }
  e.lines=[...merged.values()].filter(l=>l.debit||l.credit);
  const d=r2(e.lines.reduce((s,l)=>s+l.debit,0)), c=r2(e.lines.reduce((s,l)=>s+l.credit,0));
  const diff=r2(d-c);
  if(diff && Math.abs(diff)<=0.05 && ctx?.byKey?.ROUNDING){ if(diff>0) cr(e, ctx.byKey.ROUNDING, diff); else dr(e, ctx.byKey.ROUNDING, -diff); }
  e.total=r2(Math.max(d,c));
  e.balanced=Math.abs(r2(e.lines.reduce((s,l)=>s+l.debit-l.credit,0)))<0.005;
  return e;
}
function entryHash(e){ return hashOf({d:e.entry_date, m:e.memo, b:e.branch, l:e.lines.map(l=>[l.account_id,l.debit,l.credit,l.party_type||'',l.party_name||'',l.description||'',l.fc_currency||'',l.fc_amount??''])}); }

// Types re-derived on every sync. Anything else (manual, recurring, year_close) is materialized.
export const DERIVED_TYPES=['invoice','receipt','collection','expense','fp_expense','vendor_bill','bill_payment','payment','opening','credit_note','note_refund','debit_note','revrec','asset_purchase','depreciation','asset_disposal','settlement','tds_receivable','tds_challan','payroll','payroll_payment'];
export const SOURCE_LABELS={manual:'Manual journal', recurring:'Recurring journal', year_close:'Year-end close', invoice:'Invoice', receipt:'Receipt', collection:'Recurring collection', expense:'Expense', fp_expense:'Fixed expense', vendor_bill:'Vendor bill', bill_payment:'Bill payment', payment:'Payment entry', opening:'Opening balance', credit_note:'Credit note', note_refund:'Credit note refund', debit_note:'Debit note', revrec:'Revenue recognition', asset_purchase:'Asset purchase', depreciation:'Depreciation', asset_disposal:'Asset disposal', settlement:'Gateway settlement', tds_receivable:'TDS deducted by customer', tds_challan:'TDS challan', payroll:'Payroll', payroll_payment:'Salary payment'};

// GST lines for a sales-side tax total: use the stored CGST/SGST/IGST split scaled to the exact
// tax total (rounding lands on the last component); no split but tax present → IGST when a GST
// rate was set, else the generic Sales Tax / VAT account (non-Indian books).
export function splitTax(ctx, tax, {cgst=0, sgst=0, igst=0, gstRate=0}, side){
  const keys=side==='out'?['GST_OUT_CGST','GST_OUT_SGST','GST_OUT_IGST']:['GST_IN_CGST','GST_IN_SGST','GST_IN_IGST'];
  tax=r2(tax); if(!tax) return [];
  const parts=[num(cgst),num(sgst),num(igst)]; const sum=parts.reduce((a,b)=>a+b,0);
  if(sum>0){
    const scaled=parts.map(p=>r2(p*tax/sum)); const drift=r2(tax-scaled.reduce((a,b)=>a+b,0));
    const lastIdx=scaled.map((v,i)=>v?i:-1).filter(i=>i>=0).pop(); scaled[lastIdx]=r2(scaled[lastIdx]+drift);
    return scaled.map((v,i)=>[ctx.byKey[keys[i]], v]).filter(x=>x[1]);
  }
  if(side==='out' && !num(gstRate)) return [[ctx.byKey.TAX_OUT, tax]];
  return [[ctx.byKey[keys[2]], tax]];
}
export function gstSplitFor(amount, ratePct, supplierState, placeOfSupply){
  const rate=num(ratePct); if(!rate) return {cgst:0, sgst:0, igst:0};
  const g=r2(amount*rate/100);
  const intra=supplierState && placeOfSupply && String(supplierState).trim().toUpperCase()===String(placeOfSupply).trim().toUpperCase();
  if(intra){ const h=r2(g/2); return {cgst:h, sgst:r2(g-h), igst:0}; }
  return {cgst:0, sgst:0, igst:g};
}
export const docDate=d=>String(d.doc_created_at||'').slice(0,10)||todayStr();
export const POSTABLE_INVOICE=new Set(['sent','paid','accepted']);

/* ── Source loading (shared by the sync and by AR/portal/statement reads) ── */
export async function loadSources(env, clientId){
  const q=(sql)=>allRows(env, sql, clientId);
  const [docs, docMeta, revrec, payments, payMeta, expenses, approvals, purchaseMeta, fpExpenses, collections, bills, banks, notes, assets, settlements, tdsEntries, challans, payroll, rates]=await Promise.all([
    q(`SELECT id, type, status, title, doc_created_at, due_date, currency, subtotal, tax_amount, total, cgst_amount, sgst_amount, igst_amount, gst_rate_pct, linked_doc_id, customer_name, customer_id, payment_entry_id, lead_id, supply_type, place_of_supply, recipient_gstin, supplier_gstin, is_tax_invoice, reverse_charge, line_items_json FROM accounting_documents WHERE client_id=? AND type IN ('invoice','receipt')`),
    q(`SELECT * FROM acc_doc_meta WHERE client_id=?`),
    q(`SELECT * FROM acc_revrec_schedules WHERE client_id=?`),
    q(`SELECT * FROM acc_payment_entries WHERE client_id=?`),
    q(`SELECT * FROM acc_payment_meta WHERE client_id=?`),
    q(`SELECT * FROM accounting_expenses WHERE client_id=?`),
    q(`SELECT * FROM acc_expense_approvals WHERE client_id=?`),
    q(`SELECT * FROM acc_purchase_meta WHERE client_id=?`),
    q(`SELECT * FROM fp_expenses WHERE client_id=?`),
    q(`SELECT c.*, cu.name AS customer_name FROM fp_collections c LEFT JOIN fp_customers cu ON cu.id=c.customer_id WHERE c.client_id=?`),
    q(`SELECT * FROM accounting_vendor_bills WHERE client_id=?`),
    q(`SELECT * FROM acc_bank_accounts WHERE client_id=?`),
    q(`SELECT * FROM acc_notes WHERE client_id=?`),
    q(`SELECT * FROM acc_fixed_assets WHERE client_id=?`),
    q(`SELECT * FROM acc_gateway_settlements WHERE client_id=?`),
    q(`SELECT * FROM acc_tds_entries WHERE client_id=?`),
    q(`SELECT * FROM acc_tds_challans WHERE client_id=?`),
    q(`SELECT * FROM acc_payroll_runs WHERE client_id=? AND status IN ('posted','paid')`),
    q(`SELECT currency, rate_date, rate FROM acc_fx_rates WHERE client_id=?`),
  ]);
  const idx=(rows,k='id')=>{ const m={}; for(const r of rows) m[r[k]]=r; return m; };
  const pm={}; for(const r of purchaseMeta) pm[`${r.source_type}:${r.source_id}`]=r;
  return {docs, docById:idx(docs), docMeta:idx(docMeta,'doc_id'), revrec, revrecByInvoice:idx(revrec,'invoice_id'), payments, paymentById:idx(payments), payMeta:idx(payMeta,'payment_entry_id'),
    expenses, approvals:idx(approvals,'expense_id'), purchaseMeta:pm, fpExpenses, collections, bills, banks, notes, assets, settlements, tdsEntries, challans, payroll, rates};
}

// Balance due on each invoice: total − linked receipts − credit notes against it − TDS the
// customer deducted against it. Shared by AR aging, dunning, statements and the client portal.
export function invoiceBalances(src){
  const out={};
  for(const d of src.docs){
    if(d.type!=='invoice' || !POSTABLE_INVOICE.has(d.status)) continue;
    out[d.id]={invoice:d, total:r2(d.total), paid:0, credited:0, tds:0, balance:r2(d.total)};
  }
  for(const d of src.docs) if(d.type==='receipt' && d.status!=='void' && d.linked_doc_id && out[d.linked_doc_id]) out[d.linked_doc_id].paid=r2(out[d.linked_doc_id].paid+num(d.total));
  for(const n of src.notes) if(n.note_type==='credit' && n.status!=='void' && n.linked_type==='invoice' && out[n.linked_id]) out[n.linked_id].credited=r2(out[n.linked_id].credited+num(n.total));
  for(const t of src.tdsEntries) if(t.linked_invoice_id && out[t.linked_invoice_id]) out[t.linked_invoice_id].tds=r2(out[t.linked_invoice_id].tds+num(t.amount));
  for(const k of Object.keys(out)){
    const b=out[k];
    // An invoice marked "paid" with no receipt row (status flipped directly) is treated as settled.
    const settledByStatus=b.invoice.status==='paid' && !b.paid;
    b.balance=settledByStatus?0:r2(Math.max(0, b.total-b.paid-b.credited-b.tds));
  }
  return out;
}

/* ── Posting rules ── */
export function buildDesiredEntries(src, ctx, settings, warnings){
  const K=ctx.byKey, base=settings.base_currency||'INR';
  const fx=makeFx(src.rates, base, warnings);
  const out=[];
  const today=todayStr();
  const bankAcct=id=>id && ctx.byBank[id] ? ctx.byBank[id] : null;
  const defaultPay=()=>(settings.default_payment_account_id && ctx.byId[settings.default_payment_account_id]) ? Number(settings.default_payment_account_id) : K.CASH;
  const peAccount=pe=>bankAcct(pe?.account_id);
  const receiptPe={}, expensePe={}, billPe={};
  for(const pe of src.payments){
    if(pe.source_type==='receipt' && pe.source_id) receiptPe[pe.source_id]=pe;
    else if(pe.source_type==='expense' && pe.source_id) expensePe[pe.source_id]=pe;
    else if(pe.source_type==='vendor_bill' && pe.source_id) billPe[pe.source_id]=pe;
  }
  const party=(type,name)=>({party_type:type, party_name:str(name||'—',140)});

  // Invoices
  const postedInvoices={};
  for(const d of src.docs){
    if(d.type!=='invoice' || !POSTABLE_INVOICE.has(d.status)) continue;
    const date=docDate(d), rate=fx(d.currency, date), meta=src.docMeta[d.id]||{};
    const e=newEntry('invoice', d.id, date, `Invoice #${d.id}${d.title?' — '+d.title:''}`, {currency:d.currency, fx:rate, branch:meta.branch});
    const total=num(d.total), subtotal=num(d.subtotal), tax=r2(total-subtotal);
    dr(e, K.AR, total*rate, {...party('customer', d.customer_name), fc_currency:d.currency||null, fc_amount:total});
    const revAcct=src.revrecByInvoice[d.id]?K.DEFERRED_REV:(meta.revenue_account_id && ctx.byId[meta.revenue_account_id]?Number(meta.revenue_account_id):(meta.subscription_id?K.SUBSCRIPTION_REV:K.SALES));
    cr(e, revAcct, subtotal*rate, party('customer', d.customer_name));
    for(const [acct,amt] of splitTax(ctx, tax, {cgst:d.cgst_amount, sgst:d.sgst_amount, igst:d.igst_amount, gstRate:d.gst_rate_pct}, 'out')) cr(e, acct, amt*rate);
    out.push(e); postedInvoices[d.id]={rate, d};
  }
  // Receipts — against their invoice (AR at the invoice's rate, cash at today's rate, the gap is a
  // realised FX gain/loss) or, with no invoice, a cash sale.
  for(const d of src.docs){
    if(d.type!=='receipt' || d.status==='void') continue;
    const pe=src.paymentById[d.payment_entry_id]||receiptPe[d.id];
    const date=pe?.payment_date||docDate(d), rate=fx(d.currency, date);
    const cash=peAccount(pe)||K.UNDEPOSITED, total=num(d.total);
    const e=newEntry('receipt', d.id, date, `Receipt #${d.id}${d.linked_doc_id?` for Invoice #${d.linked_doc_id}`:''}`, {currency:d.currency, fx:rate});
    const inv=d.linked_doc_id && postedInvoices[d.linked_doc_id];
    dr(e, cash, total*rate);
    if(inv){
      cr(e, K.AR, total*inv.rate, {...party('customer', d.customer_name||inv.d.customer_name), fc_currency:d.currency||null, fc_amount:total});
      const gap=r2(total*rate-total*inv.rate); if(gap) cr(e, K.FX_GAIN_LOSS, gap);
    }else{
      cr(e, K.SALES, num(d.subtotal)*rate, party('customer', d.customer_name));
      for(const [acct,amt] of splitTax(ctx, r2(total-num(d.subtotal)), {cgst:d.cgst_amount, sgst:d.sgst_amount, igst:d.igst_amount, gstRate:d.gst_rate_pct}, 'out')) cr(e, acct, amt*rate);
    }
    out.push(e);
  }
  // Financial Planning recurring collections. Rows auto-created when an invoice is marked paid
  // duplicate that invoice's Receipt (fpRecordInvoicePaidSideEffects writes both), so skip them.
  for(const c of src.collections){
    if(/^Auto-recorded from Invoice #/.test(String(c.notes||''))) continue;
    const date=String(c.collected_at||'').slice(0,10)||today, rate=fx(c.currency, date);
    const e=newEntry('collection', c.id, date, `Recurring collection${c.customer_name?' — '+c.customer_name:''}`, {currency:c.currency, fx:rate});
    dr(e, K.UNDEPOSITED, num(c.amount)*rate); cr(e, K.SUBSCRIPTION_REV, num(c.amount)*rate, party('customer', c.customer_name));
    out.push(e);
  }
  // Purchases (expenses + vendor bills) share GST input / RCM / TDS handling. The amount the user
  // entered is what the supplier charged (GST-inclusive); the GST portion becomes input credit
  // when eligible, TDS withheld is owed to the government instead of the supplier.
  const purchaseLines=(e, meta, amount, expAcct, rate, partyName)=>{
    const g=r2(num(meta?.cgst)+num(meta?.sgst)+num(meta?.igst));
    const rcm=!!meta?.reverse_charge, itc=meta?num(meta.itc_eligible)!==0:false;
    if(rcm){
      // Reverse charge: supplier billed without GST; we self-assess it (liability) and claim ITC.
      dr(e, expAcct, amount*rate);
      if(g){ if(itc) for(const [a,v] of splitTax(ctx, g, {cgst:meta.cgst, sgst:meta.sgst, igst:meta.igst}, 'in')) dr(e, a, v*rate); else dr(e, expAcct, g*rate); cr(e, K.GST_RCM, g*rate); }
    }else{
      dr(e, expAcct, (itc?amount-g:amount)*rate);
      if(itc && g) for(const [a,v] of splitTax(ctx, g, {cgst:meta.cgst, sgst:meta.sgst, igst:meta.igst}, 'in')) dr(e, a, v*rate);
    }
    const tds=r2(num(meta?.tds_amount));
    if(tds) cr(e, K.TDS_PAYABLE, tds*rate, party('supplier', partyName));
    return tds;
  };
  for(const x of src.expenses){
    const ap=src.approvals[x.id]; if(ap && ap.status!=='approved') continue;
    const pe=src.paymentById[x.payment_entry_id]||expensePe[x.id];
    const date=String(x.expense_date||'').slice(0,10)||today, rate=fx(x.currency, date), meta=src.purchaseMeta[`expense:${x.id}`];
    const e=newEntry('expense', x.id, date, `Expense — ${x.category||x.expense_account_name||x.expense_account||''}${x.vendor?' · '+x.vendor:''}`, {currency:x.currency, fx:rate, branch:meta?.branch||x.cost_center||null});
    const acct=(meta?.expense_account_id && ctx.byId[meta.expense_account_id])?Number(meta.expense_account_id):expenseAccountFor(ctx, x.category, x.expense_account_name, x.expense_account, x.description, x.vendor);
    const tds=purchaseLines(e, meta, num(x.amount), acct, rate, x.vendor);
    cr(e, peAccount(pe)||defaultPay(), (num(x.amount)-tds)*rate);
    out.push(e);
  }
  for(const x of src.fpExpenses){
    const date=String(x.expense_date||'').slice(0,10)||today, rate=fx(x.currency, date);
    const e=newEntry('fp_expense', x.id, date, `${x.type==='fixed'?'Fixed expense':'Expense'} — ${x.name||x.category}`, {currency:x.currency, fx:rate});
    dr(e, expenseAccountFor(ctx, x.category, x.name), num(x.amount)*rate); cr(e, defaultPay(), num(x.amount)*rate);
    out.push(e);
  }
  for(const b of src.bills){
    const date=String(b.bill_date||'').slice(0,10)||today, rate=fx(b.currency, date), meta=src.purchaseMeta[`vendor_bill:${b.id}`];
    const e=newEntry('vendor_bill', b.id, date, `Bill #${b.id} — ${b.supplier}${b.vendor_invoice_no?' ('+b.vendor_invoice_no+')':''}`, {currency:b.currency, fx:rate, branch:meta?.branch});
    let lines=[]; try{ lines=JSON.parse(b.line_items_json||'[]'); }catch(_){}
    const total=num(b.total);
    // Bill-level account override wins; otherwise each line maps by its description, then the
    // whole GST/TDS treatment is applied pro-rata through purchaseLines on the first account.
    const lineAccts=(meta?.expense_account_id && ctx.byId[meta.expense_account_id])?[[Number(meta.expense_account_id), total]]
      :(lines.length?lines.map(li=>[expenseAccountFor(ctx, li.name||li.description, b.supplier), num(li.qty)*num(li.price)]):[[expenseAccountFor(ctx, b.supplier), total]]);
    const g=r2(num(meta?.cgst)+num(meta?.sgst)+num(meta?.igst));
    const itc=meta?num(meta.itc_eligible)!==0:false;
    const netOfGst=meta && !meta.reverse_charge && itc ? total-g : total;
    const lineSum=lineAccts.reduce((s,[,v])=>s+v,0)||1;
    const tds=purchaseLines(e, meta, total, lineAccts[0][0], rate, b.supplier);
    // purchaseLines debited the first account with the whole amount — re-spread across lines.
    if(lineAccts.length>1){
      const first=e.lines.find(l=>l.account_id===lineAccts[0][0] && l.debit);
      if(first){ first.debit=r2(netOfGst*rate*lineAccts[0][1]/lineSum); for(const [a,v] of lineAccts.slice(1)) dr(e, a, netOfGst*rate*v/lineSum); }
    }
    cr(e, K.AP, (total-tds)*rate, {...party('supplier', b.supplier), fc_currency:b.currency||null, fc_amount:total-tds});
    out.push(e);
    if(b.status==='paid'){
      const pe=src.paymentById[b.payment_entry_id]||billPe[b.id];
      const pdate=String(pe?.payment_date||b.paid_at||b.erpnext_paid_at||b.bill_date).slice(0,10), prate=fx(b.currency, pdate);
      const p=newEntry('bill_payment', b.id, pdate, `Payment — Bill #${b.id} ${b.supplier}`, {currency:b.currency, fx:prate});
      dr(p, K.AP, (total-tds)*rate, {...party('supplier', b.supplier), fc_currency:b.currency||null, fc_amount:total-tds});
      cr(p, peAccount(pe)||defaultPay(), (total-tds)*prate);
      const gap=r2((total-tds)*prate-(total-tds)*rate); if(gap) dr(p, K.FX_GAIN_LOSS, gap);
      out.push(p);
    }
  }
  // Standalone payment entries (not the auto-created ones mirroring a receipt/expense/bill above).
  for(const pe of src.payments){
    if(['receipt','expense','vendor_bill'].includes(pe.source_type) && pe.source_id) continue;
    const date=String(pe.payment_date).slice(0,10), rate=fx(pe.currency, date), bank=peAccount(pe)||K.UNDEPOSITED, amt=num(pe.amount)*rate;
    const override=src.payMeta[pe.id]?.account_id; const ov=override && ctx.byId[override]?Number(override):null;
    const e=newEntry('payment', pe.id, date, `${pe.payment_type==='receive'?'Money in':'Money out'}${pe.party_name?' — '+pe.party_name:''}${pe.description?' · '+pe.description:''}`, {currency:pe.currency, fx:rate});
    const contra=ov || (pe.source_type==='collection'?K.UNDEPOSITED:pe.party_type==='customer'?K.AR:pe.party_type==='supplier'?K.AP:(pe.payment_type==='receive'?K.UNCATEGORIZED_INC:K.UNCATEGORIZED_EXP));
    const pp=pe.party_type?party(pe.party_type, pe.party_name):{};
    if(pe.payment_type==='receive'){ dr(e, bank, amt); cr(e, contra, amt, pp); } else { dr(e, contra, amt, pp); cr(e, bank, amt); }
    out.push(e);
  }
  // Opening balances of bank/cash accounts.
  for(const b of src.banks){
    if(!num(b.opening_balance) || !ctx.byBank[b.id]) continue;
    const date=String(b.opening_balance_date||b.created_at||today).slice(0,10), rate=fx(b.currency, date);
    const e=newEntry('opening', `bank:${b.id}`, date, `Opening balance — ${b.name}`, {currency:b.currency, fx:rate});
    dr(e, ctx.byBank[b.id], num(b.opening_balance)*rate); cr(e, K.OPENING_EQUITY, num(b.opening_balance)*rate);
    out.push(e);
  }
  // Credit notes (sales returns / discounts / write-offs / refunds) and debit notes (purchase returns).
  for(const n of src.notes){
    if(n.status==='void') continue;
    const date=String(n.note_date).slice(0,10), rate=fx(n.currency, date), total=num(n.total), sub=num(n.subtotal), tax=r2(total-sub);
    if(n.note_type==='credit'){
      const inv=n.linked_type==='invoice'?postedInvoices[n.linked_id]:null, arRate=inv?inv.rate:rate;
      const e=newEntry('credit_note', n.id, date, `Credit note CN-${n.id}${n.party_name?' — '+n.party_name:''} (${n.reason})`, {currency:n.currency, fx:rate});
      if(n.reason==='write_off'){ dr(e, K.BAD_DEBTS, total*rate, party('customer', n.party_name)); }
      else{
        dr(e, K.SALES_RETURNS, sub*rate, party('customer', n.party_name));
        for(const [a,v] of splitTax(ctx, tax, {cgst:n.cgst, sgst:n.sgst, igst:n.igst, gstRate:n.gst_rate_pct}, 'out')) dr(e, a, v*rate);
      }
      cr(e, K.AR, total*arRate, {...party('customer', n.party_name), fc_currency:n.currency||null, fc_amount:total});
      const gap=r2(total*rate-total*arRate); if(gap) cr(e, K.FX_GAIN_LOSS, gap);
      out.push(e);
      if(n.reason==='refund' && n.refund_account_id && ctx.byId[n.refund_account_id]){
        const rd=String(n.refund_date||n.note_date).slice(0,10), rr=fx(n.currency, rd);
        const p=newEntry('note_refund', n.id, rd, `Refund paid — CN-${n.id}${n.party_name?' '+n.party_name:''}`, {currency:n.currency, fx:rr});
        dr(p, K.AR, total*rr, {...party('customer', n.party_name), fc_currency:n.currency||null, fc_amount:total}); cr(p, Number(n.refund_account_id), total*rr);
        out.push(p);
      }
    }else{
      const bill=n.linked_type==='vendor_bill'?src.bills.find(b=>b.id===n.linked_id):null;
      const meta=bill?src.purchaseMeta[`vendor_bill:${bill.id}`]:null;
      const expAcct=meta?.expense_account_id && ctx.byId[meta.expense_account_id]?Number(meta.expense_account_id):expenseAccountFor(ctx, bill?.supplier, n.notes);
      const e=newEntry('debit_note', n.id, date, `Debit note DN-${n.id}${n.party_name?' — '+n.party_name:''}`, {currency:n.currency, fx:rate});
      dr(e, K.AP, total*rate, {...party('supplier', n.party_name), fc_currency:n.currency||null, fc_amount:total});
      cr(e, expAcct, sub*rate);
      for(const [a,v] of splitTax(ctx, tax, {cgst:n.cgst, sgst:n.sgst, igst:n.igst}, 'in')) cr(e, a, v*rate);
      out.push(e);
    }
  }
  // Revenue recognition — each scheduled month whose first day has arrived moves its slice from
  // Deferred Revenue to revenue; the last month absorbs the rounding remainder.
  const curMonth=today.slice(0,7);
  for(const s of src.revrec){
    const inv=postedInvoices[s.invoice_id]; if(!inv) continue;
    const months=Math.max(1, Number(s.months)||1), sub=r2(num(inv.d.subtotal)*inv.rate);
    const revAcct=s.revenue_account_id && ctx.byId[s.revenue_account_id]?Number(s.revenue_account_id):(src.docMeta[s.invoice_id]?.subscription_id?K.SUBSCRIPTION_REV:K.SALES);
    const per=r2(sub/months);
    for(let i=0;i<months;i++){
      const m=addMonths(s.start_month+'-01', i).slice(0,7);
      if(m>curMonth) break;
      const amt=i===months-1?r2(sub-per*(months-1)):per;
      const date=m===inv.d.doc_created_at?.slice(0,7)?docDate(inv.d):monthStart(m);
      const e=newEntry('revrec', `${s.id}:${m}`, date<docDate(inv.d)?docDate(inv.d):date, `Revenue recognised ${m} — Invoice #${s.invoice_id} (${i+1}/${months})`);
      dr(e, K.DEFERRED_REV, amt); cr(e, revAcct, amt, party('customer', inv.d.customer_name));
      out.push(e);
    }
  }
  // Fixed assets — purchase, monthly depreciation through the current month, disposal.
  for(const a of src.assets){
    const assetAcct=a.asset_account_id && ctx.byId[a.asset_account_id]?Number(a.asset_account_id):K.FA_DEFAULT;
    const payAcct=a.paid_from_account_id && ctx.byId[a.paid_from_account_id]?Number(a.paid_from_account_id):K.AP;
    const p=newEntry('asset_purchase', a.id, a.purchase_date, `Asset purchased — ${a.name}`);
    dr(p, assetAcct, num(a.cost)); cr(p, payAcct, num(a.cost)); out.push(p);
    const sched=depreciationSchedule(a);
    const lastMonth=a.disposed_date?addMonths(a.disposed_date.slice(0,7)+'-01',-1).slice(0,7):curMonth;
    let accumulated=0;
    for(const {month, amount} of sched){
      if(month>lastMonth || month>curMonth) break;
      accumulated=r2(accumulated+amount);
      const e=newEntry('depreciation', `${a.id}:${month}`, monthEnd(month)>today?today:monthEnd(month), `Depreciation ${month} — ${a.name}`);
      dr(e, K.DEPRECIATION, amount); cr(e, K.ACCUM_DEP, amount); out.push(e);
    }
    if(a.disposed_date){
      const e=newEntry('asset_disposal', a.id, a.disposed_date, `Asset disposed — ${a.name}`);
      const recv=a.disposal_account_id && ctx.byId[a.disposal_account_id]?Number(a.disposal_account_id):K.UNDEPOSITED;
      dr(e, recv, num(a.disposal_amount)); dr(e, K.ACCUM_DEP, accumulated); cr(e, assetAcct, num(a.cost));
      const gain=r2(num(a.disposal_amount)+accumulated-num(a.cost)); if(gain>0) cr(e, K.OTHER_INCOME, gain); else if(gain<0) dr(e, K.OTHER_INCOME, -gain);
      out.push(e);
    }
  }
  // Payment gateway settlements: receipts sat in Undeposited Funds at gross; the payout lands net.
  for(const s of src.settlements){
    const e=newEntry('settlement', s.id, s.settlement_date, `${s.gateway} settlement ${s.settlement_ref}`);
    dr(e, bankAcct(s.bank_account_id)||defaultPay(), num(s.net)); dr(e, K.GATEWAY_FEES, num(s.fee)); dr(e, K.GST_IN_IGST, num(s.tax_on_fee));
    cr(e, K.UNDEPOSITED, num(s.gross)); out.push(e);
  }
  for(const t of src.tdsEntries){
    const off=t.offset_account_id && ctx.byId[t.offset_account_id]?Number(t.offset_account_id):(t.linked_invoice_id?K.AR:K.UNDEPOSITED);
    const e=newEntry('tds_receivable', t.id, t.entry_date, `TDS deducted by ${t.party_name||'customer'}${t.section?' u/s '+t.section:''}`);
    dr(e, K.TDS_RECEIVABLE, num(t.amount)); cr(e, off, num(t.amount), off===K.AR?party('customer', t.party_name):{}); out.push(e);
  }
  for(const c of src.challans){
    const e=newEntry('tds_challan', c.id, c.paid_date, `TDS deposited${c.section?' u/s '+c.section:''}${c.quarter?' · '+c.quarter:''}${c.challan_no?' · Challan '+c.challan_no:''}`);
    dr(e, K.TDS_PAYABLE, num(c.amount)); dr(e, K.INTEREST_EXP, num(c.interest)); cr(e, bankAcct(c.bank_account_id)||defaultPay(), num(c.amount)+num(c.interest)); out.push(e);
  }
  for(const p of src.payroll){
    let lines=[]; try{ lines=JSON.parse(p.lines_json||'[]'); }catch(_){}
    const sum=k=>r2(lines.reduce((s,l)=>s+num(l[k]),0));
    const e=newEntry('payroll', p.id, p.run_date, `Payroll ${p.period_month}`);
    dr(e, K.SALARY_EXP, sum('gross')); dr(e, K.EMPLOYER_CONTRIB, sum('employer_pf')+sum('employer_esi'));
    cr(e, K.SALARY_PAYABLE, sum('net')); cr(e, K.PF_PAYABLE, sum('employee_pf')+sum('employer_pf')); cr(e, K.ESI_PAYABLE, sum('employee_esi')+sum('employer_esi'));
    cr(e, K.PT_PAYABLE, sum('pt')); cr(e, K.TDS_PAYABLE, sum('tds'));
    out.push(e);
    if(p.status==='paid'){
      const q=newEntry('payroll_payment', p.id, p.paid_date||p.run_date, `Salaries paid ${p.period_month}`);
      dr(q, K.SALARY_PAYABLE, sum('net')); cr(q, (p.paid_account_id && ctx.byId[p.paid_account_id])?Number(p.paid_account_id):defaultPay(), sum('net')); out.push(q);
    }
  }
  for(const e of out){
    finalizeEntry(e, ctx);
    if(!e.balanced) warnings.push({kind:'unbalanced', message:`${SOURCE_LABELS[e.source_type]||e.source_type} ${e.source_ref} did not balance and was skipped.`});
  }
  return out.filter(e=>e.balanced && e.lines.length);
}

// Straight-line: (cost − salvage) / life each month. WDV: annual rate on the opening book value,
// monthly, never below salvage. Starts the purchase month.
export function depreciationSchedule(a){
  const out=[]; const life=Math.max(1, Number(a.useful_life_months)||1);
  const cost=num(a.cost), salvage=Math.min(num(a.salvage), cost);
  let book=cost; const start=String(a.purchase_date).slice(0,7);
  const per=r2((cost-salvage)/life);
  for(let i=0;i<(a.method==='wdv'?600:life);i++){
    const month=addMonths(start+'-01', i).slice(0,7);
    let amt=a.method==='wdv'?r2(book*num(a.wdv_rate_pct)/1200):(i===life-1?r2(book-salvage):per);
    if(book-amt<salvage) amt=r2(book-salvage);
    if(amt<=0) break;
    book=r2(book-amt); out.push({month, amount:amt, book_value:book});
  }
  return out;
}

/* ── Sync ── */
const syncing=new Map();
export async function ledgerSync(env, clientId, actor, settings){
  const key=String(clientId);
  if(syncing.has(key)) return syncing.get(key);
  const p=(async()=>{
    try{ return await ledgerSyncOnce(env, clientId, actor, settings); }
    catch(e){
      // Another isolate raced this one to insert the same derived entry (unique source index):
      // its rows are now in place, so a second pass just reconciles against them.
      if(/UNIQUE constraint/i.test(String(e.message))) return await ledgerSyncOnce(env, clientId, actor);
      throw e;
    }
  })();
  syncing.set(key, p);
  try{ return await p; } finally{ syncing.delete(key); }
}
// `settings` may be passed in when the caller just loaded them (the route handler does), saving a
// round trip; every independent read below runs in parallel — on D1 each one is a network hop.
async function ledgerSyncOnce(env, clientId, actor, preloaded){
  await accLedgerEnsureSchema(env);
  const settings=preloaded||await getSettings(env, clientId);
  const ph=DERIVED_TYPES.map(()=>'?').join(',');
  const [ctx, src, existing, maxRow]=await Promise.all([
    loadAccountContext(env, clientId, settings),
    loadSources(env, clientId),
    allRows(env, `SELECT id, source_type, source_ref, source_hash, status, entry_date FROM acc_journals WHERE client_id=? AND source_type IN (${ph})`, clientId, ...DERIVED_TYPES),
    firstRow(env, `SELECT MAX(entry_no) n FROM acc_journals WHERE client_id=?`, clientId),
  ]);
  const warnings=[];
  const desired=buildDesiredEntries(src, ctx, settings, warnings);
  const exMap=new Map(existing.map(r=>[`${r.source_type}|${r.source_ref}`, r]));
  const maxNo=maxRow?.n||0;
  let nextNo=maxNo;
  const now=new Date().toISOString();
  const inserts=[], updates=[];
  const seen=new Set();
  for(const e of desired){
    const k=`${e.source_type}|${e.source_ref}`; seen.add(k);
    e.hash=entryHash(e);
    const ex=exMap.get(k);
    if(ex && ex.source_hash===e.hash && ex.status==='posted') continue;
    if(isLocked(settings, e.entry_date) || (ex && ex.status==='posted' && isLocked(settings, ex.entry_date))){
      warnings.push({kind:'locked', message:`${SOURCE_LABELS[e.source_type]||e.source_type} ${e.source_ref} changed but its period is locked (≤ ${settings.lock_date}); post an adjustment in an open period instead.`});
      continue;
    }
    if(ex) updates.push({e, ex}); else inserts.push(e);
  }
  const voids=existing.filter(r=>r.status==='posted' && !seen.has(`${r.source_type}|${r.source_ref}`));
  // Headers first (one batch, ids come back per statement), then all lines in a second pass. The
  // hash is only stamped AFTER an entry's lines are written: if the isolate dies mid-way, an entry
  // is left with no/old hash and the next sync rewrites its lines instead of trusting it.
  const headerStmts=inserts.map(e=>env.DB.prepare(`INSERT INTO acc_journals (client_id, entry_no, entry_date, memo, source_type, source_ref, source_hash, status, currency, fx_rate, total, branch, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,NULL,'posted',?,?,?,?,?,?,?)`)
    .bind(clientId, ++nextNo, e.entry_date, e.memo, e.source_type, e.source_ref, e.currency, e.fx_rate, e.total, e.branch, 'system', now, now));
  const res=await dbBatch(env, headerStmts);
  inserts.forEach((e,i)=>{ e.id=res[i]?.meta?.last_row_id; });
  const lineStmts=[];
  const addLines=e=>{
    for(const l of e.lines) lineStmts.push(env.DB.prepare(`INSERT INTO acc_journal_lines (client_id, journal_id, account_id, debit, credit, description, party_type, party_name, branch, fc_currency, fc_amount) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(clientId, e.id, l.account_id, l.debit, l.credit, l.description||null, l.party_type||null, l.party_name||null, e.branch||null, l.fc_currency||null, l.fc_amount??null));
    lineStmts.push(env.DB.prepare(`UPDATE acc_journals SET source_hash=? WHERE id=?`).bind(e.hash, e.id));
  };
  for(const e of inserts) addLines(e);
  for(const {e, ex} of updates){
    e.id=ex.id;
    lineStmts.push(env.DB.prepare(`UPDATE acc_journals SET entry_date=?, memo=?, source_hash=NULL, status='posted', currency=?, fx_rate=?, total=?, branch=?, updated_at=?, voided_at=NULL, void_reason=NULL WHERE id=?`)
      .bind(e.entry_date, e.memo, e.currency, e.fx_rate, e.total, e.branch, now, ex.id));
    lineStmts.push(env.DB.prepare(`DELETE FROM acc_journal_lines WHERE journal_id=?`).bind(ex.id));
    addLines(e);
  }
  for(const v of voids){
    if(isLocked(settings, v.entry_date)){ warnings.push({kind:'locked', message:`${SOURCE_LABELS[v.source_type]||v.source_type} ${v.source_ref} was removed but sits in a locked period — reverse it manually.`}); continue; }
    lineStmts.push(env.DB.prepare(`UPDATE acc_journals SET status='void', voided_at=?, void_reason='Source document removed or no longer posts', updated_at=? WHERE id=?`).bind(now, now, v.id));
  }
  await dbBatch(env, lineStmts);
  if(inserts.length||updates.length||voids.length) await audit(env, clientId, actor||'system', 'ledger_sync', 'ledger', null, {posted:inserts.length, reposted:updates.length, voided:voids.length});
  return {posted:inserts.length, reposted:updates.length, voided:voids.length, warnings, settings, ctx, src};
}

/* ── Balances ── */
// {account_id: {debit, credit}} over posted lines in [from, to] (either bound optional).
export async function accountTotals(env, clientId, {from, to, branch, excludeTypes=[]}={}){
  let sql=`SELECT l.account_id, SUM(l.debit) d, SUM(l.credit) c FROM acc_journal_lines l JOIN acc_journals j ON j.id=l.journal_id WHERE l.client_id=? AND j.status='posted'`;
  const b=[clientId];
  if(from){ sql+=` AND j.entry_date>=?`; b.push(from); }
  if(to){ sql+=` AND j.entry_date<=?`; b.push(to); }
  if(branch){ sql+=` AND (l.branch=? OR j.branch=?)`; b.push(branch, branch); }
  if(excludeTypes.length){ sql+=` AND j.source_type NOT IN (${excludeTypes.map(()=>'?').join(',')})`; b.push(...excludeTypes); }
  sql+=` GROUP BY l.account_id`;
  const out={};
  for(const r of await allRows(env, sql, ...b)) out[r.account_id]={debit:r2(r.d), credit:r2(r.c)};
  return out;
}
// Natural-sign balance: debit-normal for assets/expenses, credit-normal otherwise.
export function naturalBalance(type, t){ if(!t) return 0; return ['asset','expense'].includes(type)?r2(t.debit-t.credit):r2(t.credit-t.debit); }

/* ── Materialized journals (manual, recurring, year-end close) ── */
// Validates and writes one journal. lines: [{account_id, debit, credit, description, party_type, party_name}].
export async function insertJournal(env, clientId, settings, ctx, {date, memo, lines, source_type='manual', source_ref=null, actor, branch=null, reversal_of=null}){
  const d=String(date||'').slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw Object.assign(new Error('A valid date is required'), {status:400});
  if(isLocked(settings, d)) throw Object.assign(new Error(`The books are locked up to ${settings.lock_date} — pick a later date.`), {status:409});
  const clean=(Array.isArray(lines)?lines:[]).map(l=>({account_id:Number(l.account_id), debit:r2(l.debit), credit:r2(l.credit), description:str(l.description,200)||null, party_type:str(l.party_type,20)||null, party_name:str(l.party_name,140)||null}))
    .filter(l=>l.account_id && (l.debit||l.credit));
  if(clean.length<2) throw Object.assign(new Error('A journal needs at least two lines'), {status:400});
  for(const l of clean){
    if(!ctx.byId[l.account_id]) throw Object.assign(new Error(`Unknown account ${l.account_id}`), {status:400});
    if(l.debit<0||l.credit<0||(l.debit&&l.credit)) throw Object.assign(new Error('Each line is either a debit or a credit, and positive'), {status:400});
  }
  const dsum=r2(clean.reduce((s,l)=>s+l.debit,0)), csum=r2(clean.reduce((s,l)=>s+l.credit,0));
  if(Math.abs(dsum-csum)>=0.005) throw Object.assign(new Error(`Debits (${dsum}) must equal credits (${csum})`), {status:400});
  const maxNo=(await firstRow(env, `SELECT MAX(entry_no) n FROM acc_journals WHERE client_id=?`, clientId))?.n||0;
  const now=new Date().toISOString();
  const r=await env.DB.prepare(`INSERT INTO acc_journals (client_id, entry_no, entry_date, memo, source_type, source_ref, status, reversal_of, total, branch, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,'posted',?,?,?,?,?,?)`)
    .bind(clientId, maxNo+1, d, str(memo,300), source_type, source_ref, reversal_of, dsum, branch, actor||null, now, now).run();
  const id=r.meta.last_row_id;
  await dbBatch(env, clean.map(l=>env.DB.prepare(`INSERT INTO acc_journal_lines (client_id, journal_id, account_id, debit, credit, description, party_type, party_name, branch) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(clientId, id, l.account_id, l.debit, l.credit, l.description, l.party_type, l.party_name, branch)));
  await audit(env, clientId, actor, `journal_create_${source_type}`, 'journal', id, {date:d, memo, lines:clean});
  return {id, entry_no:maxNo+1};
}
