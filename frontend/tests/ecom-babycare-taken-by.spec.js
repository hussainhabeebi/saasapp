// Ecom → Orders, Baby Care only: "Order Taken By" per order, staff-wise report, staff filter,
// and order writes carrying the staff session so the Worker can record who took the order.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ecomUrl = (q = '') => 'file://' + path.resolve(__dirname, '../ecom.html') + '?client=7' + q;
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';

const ORDERS = [
  { Id: 1, order_id: 'ORD-1', customer_name: 'Murshid', customer_phone: '919876543210', order_date: '2026-10-15', items: 'Romper Set', total: 999, status: 'pending', taken_by: 'riya@shop.in', taken_by_name: 'Riya', taken_by_at: '2026-10-15T09:00:00Z' },
  { Id: 2, order_id: 'ORD-2', customer_name: 'Asha', customer_phone: '919800000000', order_date: '2026-10-15', items: 'Jhabla', total: 500, status: 'received', taken_by: 'ai_bot', taken_by_name: 'AI bot (WhatsApp chat)' },
  { Id: 3, order_id: 'ORD-3', customer_name: 'Fathima', customer_phone: '919811111111', order_date: '2026-10-16', items: 'Custom Baby Set', total: 0, status: 'draft' },
  { Id: 4, order_id: 'ORD-4', customer_name: 'Old', customer_phone: '919822222222', order_date: '2026-09-01', items: 'Cap', total: 100, status: 'delivered' },
  { Id: 5, order_id: 'ORD-5', customer_name: 'Nimmi', customer_phone: '919833333333', order_date: '2026-10-16', items: 'Boots', total: 300, status: 'shipped', taken_by: 'riya@shop.in', taken_by_name: 'Riya' },
];
const REPORT = { ok: true, full_access: true, from: '', to: '', total_orders: 4, rows: [
  { taken_by: 'riya@shop.in', name: 'Riya', orders: 2, revenue: 1299, cancelled: 0, by_status: { pending: 1, shipped: 1 }, last_day: '2026-10-16' },
  { taken_by: 'ai_bot', name: 'AI bot (WhatsApp chat)', orders: 1, revenue: 500, cancelled: 0, by_status: { received: 1 }, last_day: '2026-10-15' },
  { taken_by: '', name: 'Not recorded', orders: 1, revenue: 100, cancelled: 0, by_status: { delivered: 1 }, last_day: '2026-09-01' },
] };
const row = (page, id) => page.locator('#ordersTbody tr').filter({ has: page.locator('td', { hasText: new RegExp('^#' + id + '$') }) });

async function boot(page, { style = 'baby_care', token = 'tok' } = {}) {
  const calls = [];
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url.startsWith(WORKER)) {
      const u = new URL(url);
      const body = req.postData() ? JSON.parse(req.postData()) : null;
      calls.push({ path: u.pathname, method: req.method(), body, query: Object.fromEntries(u.searchParams), auth: req.headers()['authorization'] || '' });
      if (u.pathname === '/ecom/client') return route.fulfill({ json: { Id: 7, bot_config: JSON.stringify({ ecom_communication_style: style }), ecom_table_ids: JSON.stringify({ orders: 'tbl' }) } });
      if (u.pathname === '/ecom/orders' && req.method() === 'GET') return route.fulfill({ json: { list: ORDERS } });
      if (u.pathname === '/ecom/orders') return route.fulfill({ json: { Id: 99 } });
      if (u.pathname === '/ecom/orders/staff-report') return route.fulfill({ json: REPORT });
      if (u.pathname === '/ecom/orders/insights') return route.fulfill({ json: { ok: true, leads: [], warm_leads: [] } });
      return route.fulfill({ json: { list: [] } });
    }
    return route.abort();
  });
  await page.goto(ecomUrl(token ? '&token=' + token : ''), { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { /* @ts-ignore */ showTab('orders'); });
  await expect(row(page, 'ORD-1')).toBeVisible();
  return calls;
}

test('"Order Taken By" shows the staff member, the bot, drafts and older orders', async ({ page }) => {
  await boot(page);
  await expect(row(page, 'ORD-1').locator('.taken-by')).toContainText('Riya');
  await expect(row(page, 'ORD-1').locator('.taken-by')).toContainText('riya@shop.in');
  await expect(row(page, 'ORD-2').locator('.taken-by')).toContainText('AI bot');
  await expect(row(page, 'ORD-3').locator('.taken-by')).toContainText('Not taken yet (draft)');
  await expect(row(page, 'ORD-4').locator('.taken-by')).toContainText('Not recorded');
});

test('staff report lists orders per staff member and filters the order list', async ({ page }) => {
  const calls = await boot(page);
  const rep = page.locator('#staffReportTbody tr');
  await expect(rep.filter({ hasText: 'Riya' }).locator('td').nth(1)).toHaveText('2');
  await expect(rep.filter({ hasText: 'Total' })).toContainText('4');
  await rep.filter({ hasText: 'Riya' }).click();
  await expect(page.locator('#ordersTbody tr')).toHaveCount(2);
  await expect(row(page, 'ORD-5')).toBeVisible();
  await rep.filter({ hasText: 'Riya' }).click();
  await expect(page.locator('#ordersTbody tr')).toHaveCount(5);
  expect(calls.find(c => c.path === '/ecom/orders/staff-report').auth).toBe('Bearer tok');
});

test('date range is sent to the staff report', async ({ page }) => {
  const calls = await boot(page);
  await page.locator('#staffReportFrom').fill('2026-10-01');
  await page.locator('#staffReportTo').fill('2026-10-16');
  await expect.poll(() => calls.filter(c => c.path === '/ecom/orders/staff-report').at(-1)?.query).toMatchObject({ from: '2026-10-01', to: '2026-10-16' });
});

test('adding an order and confirming a draft send the staff session', async ({ page }) => {
  const calls = await boot(page);
  await page.getByRole('button', { name: '+ Add Order' }).click();
  await expect(page.locator('#omTakenBy')).toContainText('recorded as taken by you');
  await page.locator('#omCustomerPhone').fill('9876500000');
  await page.getByRole('button', { name: 'Save Order' }).click();
  await expect.poll(() => calls.find(c => c.path === '/ecom/orders' && c.method === 'POST')?.auth).toBe('Bearer tok');
  // the browser can't claim who took it — the Worker decides from the session
  expect(calls.find(c => c.path === '/ecom/orders' && c.method === 'POST').body.taken_by).toBeUndefined();
  await row(page, 'ORD-3').locator('select').selectOption('pending');
  await expect.poll(() => calls.find(c => c.path === '/ecom/orders' && c.method === 'PATCH')?.auth).toBe('Bearer tok');
});

test('edit modal shows who took the order', async ({ page }) => {
  await boot(page);
  await row(page, 'ORD-1').getByTitle('Edit order / add details').click();
  await expect(page.locator('#omTakenBy')).toContainText('Order taken by: Riya');
});

test('other ecom styles: no taken-by column, no report, no session on writes', async ({ page }) => {
  const calls = await boot(page, { style: 'fashion_garments' });
  await expect(page.locator('#ordersTbody .taken-by')).toHaveCount(0);
  await expect(page.locator('#staffReportCard')).toBeHidden();
  expect(calls.some(c => c.path === '/ecom/orders/staff-report')).toBe(false);
  await row(page, 'ORD-3').locator('select').selectOption('pending');
  await expect.poll(() => calls.some(c => c.method === 'PATCH')).toBe(true);
  expect(calls.find(c => c.method === 'PATCH').auth).toBe('');
});
