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

async function setup(page, { enabled = true } = {}) {
  const db = new DatabaseSync(':memory:');
  for (const m of MIGRATIONS) db.exec(readFileSync(path.resolve(__dirname, `../../cloudflare-worker/migrations/${m}.sql`), 'utf8'));
  const env = { DB: d1(db) };
  db.prepare(`INSERT INTO fp_config (client_id, enabled, reminders_enabled, updated_at, business_state_code, default_currency) VALUES (7,1,1,'x','32','INR')`).run();
  db.prepare(`INSERT INTO acc_bank_accounts (client_id, name, type, currency, opening_balance, opening_balance_date, created_at) VALUES (7,'HDFC Current','bank','INR',200000,'2026-01-01',?)`).run(T);
  const inv = db.prepare(`INSERT INTO accounting_documents (client_id, type, title, line_items_json, currency, subtotal, tax_pct, tax_amount, total, status, customer_name, gst_rate_pct, cgst_amount, sgst_amount, place_of_supply, supply_type, doc_created_at, due_date) VALUES (7,'invoice','SEO retainer',?,'INR',50000,18,9000,59000,'sent','Beta Foods',18,4500,4500,'32','B2C',?,?)`);
  inv.run(JSON.stringify([{ name: 'SEO retainer', qty: 1, price: 50000, hsn: '998361' }]), `${T}T10:00:00Z`, T);
  db.prepare(`INSERT INTO accounting_expenses (client_id, expense_account, amount, currency, expense_date, category, vendor, created_at) VALUES (7,'x',4500,'INR',?,'Software','Figma',?)`).run(T, T);
  db.prepare(`INSERT INTO accounting_vendor_bills (client_id, supplier, bill_date, due_date, line_items_json, currency, subtotal, total, status, created_at) VALUES (7,'Ravi (freelancer)',?,?,?,'INR',20000,20000,'unpaid',?)`).run(T, T, JSON.stringify([{ name: 'Video editing', qty: 1, price: 20000 }]), T);

  const errors = [];
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
    if (p.includes('/records/7')) return route.fulfill({ json: { Id: 7, client_name: 'Acme Digital', deal_currency: 'INR', accounting_enabled: enabled ? 'Yes' : 'No' } });
    if (p.includes('/records')) return route.fulfill({ json: { list: [] } });
    if (p === '/accounting/documents') return route.fulfill({ json: { list: db.prepare(`SELECT * FROM accounting_documents`).all().map((r) => ({ ...r, Id: r.id })) } });
    if (p === '/accounting/expenses') return route.fulfill({ json: { list: db.prepare(`SELECT * FROM accounting_expenses`).all().map((r) => ({ ...r, Id: r.id })) } });
    if (p === '/accounting/vendor-bills') return route.fulfill({ json: { list: db.prepare(`SELECT * FROM accounting_vendor_bills`).all().map((r) => ({ ...r, Id: r.id })) } });
    if (p === '/financial/config') return route.fulfill({ json: { default_currency: 'INR' } });
    if (p === '/financial/dashboard') return route.fulfill({ json: { currency: 'INR', expected: 0, collected: 0, outstanding: 0, expenses: 0, trend: [], overdue: [], money_owed_to_you: [], money_you_owe: [] } });
    return route.fulfill({ json: { list: [] } });
  });
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  if (enabled) await expect(page.locator('.tab[data-tab="books"]')).toBeVisible();
  return { db, errors };
}
const subs = async (page, tab) => {
  const pills = page.locator(`#${tab} .fp-pill`);
  const n = await pills.count();
  for (let i = 0; i < n; i++) {
    await pills.nth(i).click();
    await expect(page.locator(`#${tab} .acc-sub-body .spinner`)).toHaveCount(0, { timeout: 10000 });
    await expect(page.locator(`#${tab} .acc-sub-body`)).not.toContainText(/Something went wrong|is not a function|undefined/);
  }
  return n;
};

test('every ledger tab and sub-view renders against the real ledger', async ({ page }) => {
  const { errors } = await setup(page);
  await page.click('.tab[data-tab="overview"]');
  await expect(page.locator('#tabOverview')).toContainText('Customers owe you');
  await expect(page.locator('#tabOverview')).toContainText('59,000.00');
  await expect(page.locator('#tabOverview')).toContainText('13-week cash forecast');
  for (const [tab, id] of [['books', 'tabBooks'], ['subscriptions', 'tabSubscriptions'], ['tax', 'tabTax'], ['ops', 'tabOps']]) {
    await page.click(`.tab[data-tab="${tab}"]`);
    expect(await subs(page, id)).toBeGreaterThan(4);
  }
  expect(errors).toEqual([]);
});

test('P&L, balance sheet and trial balance tie out; manual journal posts', async ({ page }) => {
  const { errors } = await setup(page);
  await page.click('.tab[data-tab="books"]');
  await page.click('#tabBooks .fp-pill[data-k="pl"]');
  await expect(page.locator('#accPlOut')).toContainText('Net profit');
  await expect(page.locator('#accPlOut')).toContainText('25,500.00'); // 50,000 − 4,500 − 20,000
  await page.click('#tabBooks .fp-pill[data-k="bs"]');
  await expect(page.locator('#accBsOut')).toContainText('Assets = Liabilities + Equity');
  await page.click('#tabBooks .fp-pill[data-k="journals"]');
  await page.click('text=+ Manual journal');
  await page.fill('#accF_memo', 'Owner capital');
  const rows = page.locator('#accLinesBody .acc-line');
  await rows.nth(0).locator('select').selectOption({ label: '3000 · Owner\'s Capital' }).catch(async () => {
    const v = await rows.nth(0).locator('option', { hasText: 'Owner' }).first().getAttribute('value'); await rows.nth(0).locator('select').selectOption(v);
  });
  await rows.nth(0).locator('.acc-l-cr').fill('10000');
  const cash = await rows.nth(1).locator('option', { hasText: 'Cash in Hand' }).first().getAttribute('value');
  await rows.nth(1).locator('select').selectOption(cash);
  await rows.nth(1).locator('.acc-l-dr').fill('10000');
  await expect(page.locator('#accLinesTotals')).toContainText('Balanced');
  await page.click('#accFormSave');
  await expect(page.locator('#accJOut')).toContainText('Owner capital');
  await page.click('#tabBooks .fp-pill[data-k="tb"]');
  await expect(page.locator('#accTbOut')).toContainText('✓ Balanced');
  expect(errors).toEqual([]);
});

test('subscription → billing run → invoice appears; GSTR-1 picks it up; Reports P&L uses the ledger', async ({ page }) => {
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
  await page.click('#tabSubscriptions .fp-pill[data-k="revrec"]');
  await expect(page.locator('#tabSubscriptions')).toContainText('Gamma SaaS');
  await page.click('.tab[data-tab="tax"]');
  await page.click('#tabTax .fp-pill[data-k="gstr1"]');
  await expect(page.locator('#accG1Out')).toContainText('62,000.00'); // 50,000 + 12,000 taxable
  await page.click('.tab[data-tab="reports"]');
  await page.click('button[data-repsub="pl"]');
  await page.click('#repSubPl >> text=Run');
  await expect(page.locator('#repPlContent')).toContainText('From the double-entry ledger');
  expect(errors).toEqual([]);
});

test('client portal shows the customer their open invoice', async ({ page }) => {
  const { db } = await setup(page);
  await page.click('.tab[data-tab="ops"]');
  await page.click('#tabOps .fp-pill[data-k="links"]');
  await expect(page.locator('#tabOps')).toContainText('Beta Foods');
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
