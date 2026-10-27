// Accounting ledger tabs (accounting-ledger.js): every Overview / Books / Subscriptions / Tax /
// Operations view renders without errors, and the main flows work end to end. Hermetic file://
// setup like the other specs, except that /accounting/ledger/* is answered by the REAL Worker
// module (cloudflare-worker/accounting-ledger.js) running on an in-memory node:sqlite database
// loaded with the real migrations — so the UI is exercised against real ledger maths.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { accLedgerHandleRoute } from '../../cloudflare-worker/accounting-ledger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pageUrl = 'file://' + path.resolve(__dirname, '../accounting.html') + '?client=7&token=owner';
const portalUrl = 'file://' + path.resolve(__dirname, '../accounting-portal.html');
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';
const MIGRATIONS = ['0002_accounting_b2b_documents', '0004_accounting_erpnext_customer', '0005_accounting_company_debtors', '0006_accounting_erpnext_submit', '0015_financial_planning',
  '0028_accounting_expenses', '0029_accounting_vendor_bills', '0034_fp_ai_snapshot', '0035_accounting_standalone', '0036_accounting_interconnect', '0037_accounting_doc_dates_and_paid',
  '0041_fp_reminder_tracking', '0075_accounting_gst', '0098_accounting_bank_cash', '0117_accounting_ledger'];
const T = new Date().toISOString().slice(0, 10);

function d1(db) {
  const prepare = (sql) => { let args = []; const st = {
    bind(...a) { args = a.map((v) => v === undefined ? null : v); return st; },
    async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    async all() { return { results: db.prepare(sql).all(...args) }; },
    async first() { return db.prepare(sql).get(...args) || null; } }; return st; };
  return { prepare, async batch(stmts) { db.exec('BEGIN'); try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
}
const deps = {
  json: (data, status) => new Response(JSON.stringify(data), { status: status || 200 }),
  requireSession: async (req) => req.headers.get('Authorization') === 'Bearer owner' ? { cid: '7', email: 'owner@acme.in' } : null,
  getClientById: async () => ({ client_name: 'Acme Digital' }),
  isAccountingEnabled: async () => true,
};

async function setup(page, { enabled = true, slowMs = 0 } = {}) {
  const db = new DatabaseSync(':memory:');
  for (const m of MIGRATIONS) db.exec(readFileSync(path.resolve(__dirname, `../../cloudflare-worker/migrations/${m}.sql`), 'utf8'));
  const env = { DB: d1(db) };
  db.prepare(`INSERT INTO fp_config (client_id, enabled, reminders_enabled, updated_at, business_state_code, default_currency) VALUES (7,1,1,'x','32','INR')`).run();
  db.prepare(`INSERT INTO acc_bank_accounts (client_id, name, type, currency, opening_balance, opening_balance_date, created_at) VALUES (7,'HDFC Current','bank','INR',200000,'2026-01-01',?)`).run(T);
  const inv = db.prepare(`INSERT INTO accounting_documents (client_id, type, title, line_items_json, currency, subtotal, tax_pct, tax_amount, total, status, customer_name, gst_rate_pct, cgst_amount, sgst_amount, place_of_supply, supply_type, doc_created_at, due_date) VALUES (7,'invoice','SEO retainer',?,'INR',50000,18,9000,59000,'sent','Beta Foods',18,4500,4500,'32','B2C',?,?)`);
  inv.run(JSON.stringify([{ name: 'SEO retainer', qty: 1, price: 50000, hsn: '998361' }]), `${T}T10:00:00Z`, T);
  db.prepare(`INSERT INTO accounting_expenses (client_id, expense_account, amount, currency, expense_date, category, vendor, created_at) VALUES (7,'x',4500,'INR',?,'Software','Figma',?)`).run(T, T);
  db.prepare(`INSERT INTO accounting_vendor_bills (client_id, supplier, bill_date, due_date, line_items_json, currency, subtotal, total, status, created_at) VALUES (7,'Ravi (freelancer)',?,?,?,'INR',20000,20000,'unpaid',?)`).run(T, T, JSON.stringify([{ name: 'Video editing', qty: 1, price: 20000 }]), T);

  const errors = [], fpPatches = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('**/*', async (route) => {
    const req = route.request(), url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (!url.startsWith(WORKER)) return route.abort();
    const u = new URL(url), p = u.pathname;
    if (p.startsWith('/accounting/ledger/') || p.startsWith('/accounting/portal/')) {
      const r = new Request(url, { method: req.method(), headers: req.headers(), body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postData() });
      const res = await accLedgerHandleRoute(r, env, deps, u);
      return route.fulfill({ status: res.status, contentType: 'application/json', body: await res.text() });
    }
    // slowMs: hold back the CRM leads list and the Documents list, the two biggest loads.
    if (slowMs && ((p.includes('/records') && !p.includes('/records/7')) || p === '/accounting/documents')) await new Promise((r) => setTimeout(r, slowMs));
    if (p.includes('/records/7')) return route.fulfill({ json: { Id: 7, client_name: 'Acme Digital', deal_currency: 'INR', accounting_enabled: enabled ? 'Yes' : 'No' } });
    if (p.includes('/records')) return route.fulfill({ json: { list: [] } });
    if (p === '/accounting/documents') return route.fulfill({ json: { list: db.prepare(`SELECT * FROM accounting_documents`).all().map((r) => ({ ...r, Id: r.id })) } });
    if (p === '/accounting/expenses') return route.fulfill({ json: { list: db.prepare(`SELECT * FROM accounting_expenses`).all().map((r) => ({ ...r, Id: r.id })) } });
    if (p === '/accounting/vendor-bills') return route.fulfill({ json: { list: db.prepare(`SELECT * FROM accounting_vendor_bills`).all().map((r) => ({ ...r, Id: r.id })) } });
    if (p.startsWith('/financial/reports/')) return route.fulfill({ json: { currency: 'INR', buckets: [], items: [], categories: [], by_type: [], total: 0, total_documents: 0, since: '2026-01-01', from: '2026-01-01', to: '2026-12-31' } });
    if (p === '/accounting/bank-accounts') return route.fulfill({ json: { list: db.prepare(`SELECT * FROM acc_bank_accounts`).all().map((r) => ({ ...r, Id: r.id })) } });
    if (p === '/financial/config') { if (req.method() === 'PATCH') { const b = JSON.parse(req.postData()); fpPatches.push(b); return route.fulfill({ json: { default_currency: 'INR', ...b } }); } return route.fulfill({ json: { default_currency: 'INR' } }); }
    if (p === '/financial/dashboard') return route.fulfill({ json: { currency: 'INR', expected: 0, collected: 0, outstanding: 0, expenses: 0, trend: [], overdue: [], money_owed_to_you: [], money_you_owe: [] } });
    return route.fulfill({ json: { list: [] } });
  });
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  if (enabled) await expect(page.locator('.tab[data-tab="books"]')).toBeVisible();
  return { db, errors, fpPatches };
}
const PAGES = ['overview', 'documents', 'subscriptions', 'customers', 'collections', 'expenses', 'vendorbills', 'suppliers', 'bankcash', 'books', 'reports', 'tax', 'payroll', 'settings'];
const pageId = (t) => 'tab' + t.charAt(0).toUpperCase() + t.slice(1);
const settle = async (page, id) => {
  await expect(page.locator(`#${id} .acc-sub-body .spinner`)).toHaveCount(0, { timeout: 10000 });
  await expect(page.locator(`#${id} .acc-sub-body`)).not.toContainText(/Something went wrong|is not a function|undefined|not available/);
};
const sections = async (page, id) => {
  const pills = page.locator(`#${id} .fp-pill`);
  const n = await pills.count();
  for (let i = 0; i < n; i++) { await pills.nth(i).click(); await settle(page, id); }
  if (!n) await settle(page, id);
  return n;
};

test('PC view: grouped left sidebar; each screen exists once; every section renders', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const { errors } = await setup(page);
  const nav = await page.locator('#tabs').boundingBox();
  expect(nav.height).toBeGreaterThan(nav.width); // vertical sidebar
  await expect(page.locator('#tabs .nav-head')).toHaveText(['Sales', 'Purchases', 'Banking', 'Accounting', 'Setup']);
  expect(await page.locator('#tabs .tab').evaluateAll((els) => els.map((e) => e.dataset.tab))).toEqual(PAGES);
  for (const gone of ['financial', 'ops']) await expect(page.locator(`.tab[data-tab="${gone}"]`)).toHaveCount(0);
  await expect(page.locator('#tabOverview')).toContainText('Customers owe you');
  await expect(page.locator('#tabOverview')).toContainText('59,000.00');
  await expect(page.locator('#tabOverview')).not.toContainText(/Ask your books|AI/);
  for (const t of PAGES.filter((t) => !['overview', 'documents', 'vendorbills'].includes(t))) {
    await page.click(`.tab[data-tab="${t}"]`);
    await sections(page, pageId(t));
  }
  expect(errors).toEqual([]);
});

test('phone view keeps a horizontal tab strip', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  const nav = await page.locator('#tabs').boundingBox();
  expect(nav.width).toBeGreaterThan(nav.height);
  await expect(page.locator('#tabs .nav-head').first()).toBeHidden();
});

test('mounted legacy panels survive switching away and back (Expenses, Suppliers, Bank & Cash)', async ({ page }) => {
  const { errors } = await setup(page);
  await page.click('.tab[data-tab="expenses"]');
  await page.click('#tabExpenses .fp-pill[data-k="all"]');
  await expect(page.locator('#tabExpenses #expensesTbody')).toContainText('Figma');
  await page.click('#tabExpenses .fp-pill[data-k="fixed"]');
  await expect(page.locator('#tabExpenses')).toContainText('Fixed Recurring Expenses');
  await expect(page.locator('#tabExpenses')).not.toContainText('AI Quick Add');
  await page.click('#tabExpenses .fp-pill[data-k="all"]');
  await expect(page.locator('#tabExpenses #expensesTbody')).toContainText('Figma');
  await page.click('.tab[data-tab="bankcash"]');
  await page.click('#tabBankcash .fp-pill[data-k="accounts"]');
  await expect(page.locator('#tabBankcash')).toContainText('HDFC Current');
  // Parked panels stay in the DOM (hidden), so their own render code still finds them by id.
  await page.click('.tab[data-tab="suppliers"]');
  expect(await page.evaluate(() => !!document.getElementById('expensesTbody') && !!document.getElementById('bcSubAccounts'))).toBe(true);
  expect(errors).toEqual([]);
});

test('Reports: P&L, balance sheet and trial balance tie out; Books: manual journal posts', async ({ page }) => {
  const { errors } = await setup(page);
  await page.click('.tab[data-tab="reports"]');
  await page.click('#tabReports .fp-pill[data-k="pl"]');
  await expect(page.locator('#accPlOut')).toContainText('Net profit');
  await expect(page.locator('#accPlOut')).toContainText('25,500.00'); // 50,000 − 4,500 − 20,000
  await page.click('#tabReports .fp-pill[data-k="bs"]');
  await expect(page.locator('#accBsOut')).toContainText('Assets = Liabilities + Equity');
  await page.click('.tab[data-tab="books"]');
  await page.click('#tabBooks .fp-pill[data-k="journals"]');
  await page.click('text=+ Manual journal');
  await page.fill('#accF_memo', 'Owner capital');
  const rows = page.locator('#accLinesBody .acc-line');
  const owner = await rows.nth(0).locator('option', { hasText: 'Owner' }).first().getAttribute('value');
  await rows.nth(0).locator('select').selectOption(owner);
  await rows.nth(0).locator('.acc-l-cr').fill('10000');
  const cash = await rows.nth(1).locator('option', { hasText: 'Cash in Hand' }).first().getAttribute('value');
  await rows.nth(1).locator('select').selectOption(cash);
  await rows.nth(1).locator('.acc-l-dr').fill('10000');
  await expect(page.locator('#accLinesTotals')).toContainText('Balanced');
  await page.click('#accFormSave');
  await expect(page.locator('#accJOut')).toContainText('Owner capital');
  await page.click('.tab[data-tab="reports"]');
  await page.click('#tabReports .fp-pill[data-k="tb"]');
  await expect(page.locator('#accTbOut')).toContainText('✓ Balanced');
  expect(errors).toEqual([]);
});

test('subscription → billing run → invoice appears; GSTR-1 picks it up', async ({ page }) => {
  const { db, errors } = await setup(page);
  await page.click('.tab[data-tab="subscriptions"]');
  await page.click('#tabSubscriptions .fp-pill[data-k="subs"]');
  await page.click('text=+ Subscription');
  await page.fill('#accF_customer_name', 'Gamma SaaS');
  await page.fill('#accF_amount', '12000');
  await page.selectOption('#accF_interval', 'year');
  await page.fill('#accF_gst_rate_pct', '18');
  await page.fill('#accF_place_of_supply', '32');
  await page.check('#accF_bill_now');
  await page.click('#accFormSave');
  await expect(page.locator('#tabSubscriptions')).toContainText('Gamma SaaS');
  expect(db.prepare(`SELECT COUNT(*) n FROM accounting_documents WHERE customer_name='Gamma SaaS'`).get().n).toBe(1);
  await page.click('#tabSubscriptions .fp-pill[data-k="metrics"]');
  await expect(page.locator('#tabSubscriptions')).toContainText('1,000.00'); // MRR of a 12,000/yr plan
  await page.click('.tab[data-tab="tax"]');
  await page.click('#tabTax .fp-pill[data-k="gstr1"]');
  await expect(page.locator('#accG1Out')).toContainText('62,000.00'); // 50,000 + 12,000 taxable
  expect(errors).toEqual([]);
});

test('Settings → Business & tax saves the books and the invoice GST/currency settings together', async ({ page }) => {
  const { db, fpPatches, errors } = await setup(page);
  await page.click('.tab[data-tab="settings"]');
  await page.click('#tabSettings .fp-pill[data-k="general"]');
  await page.fill('#accS_gstin', '32ABCDE1234F1Z5');
  await page.selectOption('#accS_state_code', '32');
  await page.fill('#accS_default_gst_rate', '18');
  await page.click('text=Save settings');
  await expect.poll(() => fpPatches.length).toBe(1);
  expect(fpPatches[0]).toMatchObject({ business_gstin: '32ABCDE1234F1Z5', business_state_code: '32', default_gst_rate: 18, default_currency: 'INR' });
  expect(db.prepare(`SELECT gstin, state_code FROM acc_settings WHERE client_id=7`).get()).toEqual({ gstin: '32ABCDE1234F1Z5', state_code: '32' });
  expect(errors).toEqual([]);
});

test('client portal shows the customer their open invoice', async ({ page }) => {
  const { db } = await setup(page);
  await page.click('.tab[data-tab="collections"]');
  await page.click('#tabCollections .fp-pill[data-k="links"]');
  await expect(page.locator('#tabCollections')).toContainText('Beta Foods');
  const token = (await page.evaluate(() => AccLedger.post('portal-tokens', { customer_name: 'Beta Foods' }))).token;
  expect(db.prepare(`SELECT COUNT(*) n FROM acc_portal_tokens`).get().n).toBe(1);
  await page.goto(`${portalUrl}?t=${token}`);
  await expect(page.locator('#app')).toContainText('Invoice #1');
  await expect(page.locator('#app')).toContainText('59,000.00');
});

test('accounting does not load for a client the Leadvyne admin has not enabled', async ({ page }) => {
  const { errors } = await setup(page, { enabled: false });
  await expect(page.locator('#app')).toContainText("isn't enabled for your account");
  await expect(page.locator('.tab[data-tab="books"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the Overview shows without waiting for the slow leads and documents lists', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const { errors } = await setup(page, { slowMs: 8000 });
  // Both held-back lists take 8 s; the Overview must be up well before either arrives.
  await expect(page.locator('#tabOverview')).toContainText('Customers owe you', { timeout: 5000 });
  await expect(page.locator('#tabOverview')).toContainText('59,000.00');
  // …and Documents fills in once its list does arrive.
  await page.click('.tab[data-tab="documents"]');
  await expect(page.locator('#tabDocuments')).toContainText('Beta Foods', { timeout: 15000 });
  expect(errors).toEqual([]);
});
