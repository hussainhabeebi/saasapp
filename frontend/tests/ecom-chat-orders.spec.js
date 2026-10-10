// Ecom → Orders: Baby Care chat drafts ("Draft (in chat)"), staff editing an order, "Fill from chat",
// "Sync from chats", and order PDF / packing list / bulk export. Hermetic file:// setup — Worker routes answered by page.route stubs.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ecomUrl = 'file://' + path.resolve(__dirname, '../ecom.html') + '?client=7';
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';

const ORDERS = [
  { Id: 1, client_id: '7', order_id: 'ORD-1', customer_name: 'Murshid', customer_phone: '919876543210', order_date: '2026-10-01',
    items: 'Romper Set | Name: Aira', total: 999, currency: 'INR', status: 'draft', delivery_address: '', notes: 'Order intent detected in WhatsApp chat' },
  { Id: 2, client_id: '7', order_id: 'ORD-2', customer_name: 'Asha', customer_phone: '919800000000', order_date: '2026-09-30',
    items: 'Jhabla', total: 500, currency: 'INR', status: 'pending' },
];

async function boot(page) {
  const calls = [];
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url.startsWith(WORKER)) {
      const p = new URL(url).pathname;
      const body = req.postData() ? JSON.parse(req.postData()) : null;
      calls.push({ path: p, method: req.method(), body });
      if (p === '/ecom/orders' && req.method() === 'GET') return route.fulfill({ json: { list: ORDERS } });
      if (p === '/ecom/orders') return route.fulfill({ json: { ok: true } });
      if (p === '/ecom/orders/from-chat') return route.fulfill({ json: { ok: true, suggested: { items: 'Romper Set | Name: Ayra', customer_name: 'Murshid', delivery_address: 'Kochi 682001', customer_email: 'murshid@example.com', payment_method: 'COD', notes: 'Wants delivery before 10th' } } });
      if (p === '/ecom/orders/sync-chats') return route.fulfill({ json: { ok: true, created: 2, updated: 1 } });
      return route.fulfill({ json: {} });
    }
    return route.abort();
  });
  await page.goto(ecomUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    // @ts-ignore
    ecomTableIds = { orders: 'tbl' }; showTab('orders'); loadOrders();
  });
  return calls;
}

test('drafts show as "Draft (in chat)" and are left out of revenue', async ({ page }) => {
  await boot(page);
  const draftRow = page.locator('#ordersTbody tr', { hasText: 'ORD-1' });
  await expect(draftRow.locator('select')).toHaveValue('draft');
  await expect(draftRow.locator('select option:checked')).toHaveText('Draft (in chat)');
  await expect(page.locator('#statRevenue')).toHaveText('500');
});

test('staff edit a draft, fill it from the chat, and save as a PATCH', async ({ page }) => {
  const calls = await boot(page);
  await page.locator('#ordersTbody tr', { hasText: 'ORD-1' }).getByTitle('Edit order / add details').click();
  await expect(page.locator('#orderModalTitle')).toHaveText('Edit Order #ORD-1');
  await expect(page.locator('#omStatus')).toHaveValue('draft');
  await page.getByRole('button', { name: '💬 Fill from chat' }).click();
  await expect(page.locator('#omItems')).toHaveValue('Romper Set | Name: Ayra');
  await expect(page.locator('#omAddress')).toHaveValue('Kochi 682001');
  await expect(page.locator('#omNotes')).toHaveValue(/From chat: Wants delivery before 10th/);
  await expect(page.locator('#omCustomerEmail')).toHaveValue('murshid@example.com');
  await expect(page.locator('#omPayment')).toHaveValue('COD');
  await page.locator('#omTotal').fill('1059');
  await page.getByRole('button', { name: 'Save Order' }).click();
  await expect.poll(() => calls.find(c => c.path === '/ecom/orders' && c.method === 'PATCH')?.body).toMatchObject(
    { Id: 1, client_id: '7', order_id: 'ORD-1', items: 'Romper Set | Name: Ayra', delivery_address: 'Kochi 682001', total: 1059, status: 'draft',
      customer_email: 'murshid@example.com', payment_method: 'COD' });
});

test('"Sync from chats" reports what it found and reloads the list', async ({ page }) => {
  const calls = await boot(page);
  await page.getByRole('button', { name: '🔄 Sync from chats' }).click();
  await expect(page.locator('#ordersSyncMsg')).toContainText('2 new draft order(s), 1 refreshed');
  expect(calls.find(c => c.path === '/ecom/orders/sync-chats').body).toEqual({ client_id: '7' });
});

// jsPDF is a CDN script (blocked here) — stub it and record the pages, text, tables and file name.
async function stubPdf(page) {
  await page.evaluate(() => {
    // @ts-ignore
    window.__pdf = { pages: 1, text: [], tables: [], saved: null };
    // @ts-ignore
    window.jspdf = { jsPDF: function (opts) {
      // @ts-ignore
      const P = window.__pdf; P.opts = opts;
      const self = { internal: { pageSize: { getWidth: () => 595, getHeight: () => 842 }, getNumberOfPages: () => P.pages },
        setFont() {}, setFontSize() {}, setTextColor() {}, setDrawColor() {}, setLineWidth() {}, line() {}, rect() {}, roundedRect() {},
        splitTextToSize: (t) => [t], text(t) { P.text.push([].concat(t).join('\n')); }, addPage() { P.pages++; },
        autoTable(o) { P.tables.push({ head: o.head, body: o.body }); o.didDrawPage?.(); self.lastAutoTable = { finalY: 400 }; },
        save(name) { P.saved = name; } };
      return self;
    } };
  });
}
const pdf = (page) => page.evaluate(() => /** @type {any} */ (window).__pdf);

test('row 📄 / 📦 download that one order as a PDF and a packing list', async ({ page }) => {
  await boot(page);
  await stubPdf(page);
  const row = page.locator('#ordersTbody tr', { hasText: 'ORD-1' });
  await row.getByTitle('Download order PDF').click();
  let p = await pdf(page);
  expect(p.saved).toBe('order-ORD-1.pdf');
  expect(p.text).toContain('ORDER');
  expect(p.tables[0].body).toEqual([['1', 'Romper Set', 'Name: Aira', '1']]);

  await stubPdf(page);
  await row.getByTitle('Download packing list').click();
  p = await pdf(page);
  expect(p.saved).toBe('packing-list-ORD-1.pdf');
  expect(p.text).toContain('PACKING LIST');
  expect(p.tables[0].head).toEqual([['Qty', 'Item', 'Customisation / details', 'Packed']]);
  expect(p.text).toContain('Total pieces: 1');
});

test('bulk export: ticked orders only, else every order the search shows', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#orderBulkCount')).toHaveText('Export all 2 shown orders');
  await stubPdf(page);
  await page.getByRole('button', { name: '📦 Packing lists' }).click();
  let p = await pdf(page);
  expect(p.pages).toBe(2);
  expect(p.saved).toMatch(/^packing-lists-\d{4}-\d{2}-\d{2}\.pdf$/);

  await page.locator('#ordersTbody tr', { hasText: 'ORD-2' }).locator('input[type=checkbox]').check();
  await expect(page.locator('#orderBulkCount')).toHaveText('1 order selected');
  await stubPdf(page);
  await page.getByRole('button', { name: '🧾 Summary PDF' }).click();
  p = await pdf(page);
  expect(p.opts.orientation).toBe('landscape');
  expect(p.tables[0].body.map((r) => r[0])).toEqual(['ORD-2']);

  // select-all ticks every shown row; the CSV carries them all
  await page.locator('#orderSelectAll').check();
  await expect(page.locator('#orderBulkCount')).toHaveText('2 orders selected');
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: '⬇ CSV' }).click();
  const file = await dl;
  expect(file.suggestedFilename()).toMatch(/^orders-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = await (await file.createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8'));
  expect(csv).toContain('order_id,order_date,status');
  expect(csv).toContain('ORD-1,2026-10-01,draft,Murshid');
  expect(csv).toContain('ORD-2,2026-09-30,pending,Asha');
});

test('packing list reads quantities and customisation out of the items text', async ({ page }) => {
  await boot(page);
  const lines = await page.evaluate(() => /** @type {any} */ (window).orderItemLines('2x Wireless Mouse, 1x Desk Lamp\nRomper Set × 3 | Size: 0-3m | Name: Ayra'));
  expect(lines).toEqual([
    { name: 'Wireless Mouse', qty: 2, details: '' },
    { name: 'Desk Lamp', qty: 1, details: '' },
    { name: 'Romper Set', qty: 3, details: 'Size: 0-3m · Name: Ayra' },
  ]);
});
