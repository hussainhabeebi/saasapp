// Ecom → Orders, Baby Care stores only: counts by status and by date, duplicate flags + duplicate
// save prompt, lead source / assignee column, warm leads, order session. Hermetic file:// setup.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ecomUrl = (q = '') => 'file://' + path.resolve(__dirname, '../ecom.html') + '?client=7' + q;
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';

const ORDERS = [
  { Id: 1, order_id: 'ORD-1', customer_name: 'Murshid', customer_phone: '919876543210', order_date: '2026-10-15', CreatedAt: '2026-10-15T09:00:00Z', items: 'Romper Set', total: 999, status: 'pending' },
  { Id: 2, order_id: 'ORD-2', customer_name: 'Murshid', customer_phone: '+91 98765 43210', order_date: '2026-10-15', CreatedAt: '2026-10-15T10:00:00Z', items: 'Romper Set', total: 999, status: 'received' },
  { Id: 3, order_id: 'ORD-3', customer_name: 'Asha', customer_phone: '919800000000', order_date: '2026-10-14', items: 'Jhabla', total: 500, status: 'shipped' },
  { Id: 4, order_id: 'ORD-4', customer_name: 'Fathima', customer_phone: '919811111111', order_date: '2026-10-15', items: 'Custom Baby Set', total: 0, status: 'draft' },
];
const INSIGHTS = {
  ok: true, warm_min_interactions: 2,
  leads: [
    { lead_id: 9, phone: '919876543210', phone_key: '9876543210', name: 'Murshid', source: 'Instagram chat', created_by: '', owner_name: 'Riya', customer_msgs: 6, bot_msgs: 6 },
    { lead_id: 10, phone: '919800000000', phone_key: '9800000000', name: 'Asha', source: 'Added manually', created_by: 'admin@shop.in', owner_name: '', customer_msgs: 1, bot_msgs: 1 },
  ],
  warm_leads: [
    { lead_id: 11, phone: '919811111111', phone_key: '9811111111', name: 'Fathima', source: 'WhatsApp chat', owner_name: 'Sam', customer_msgs: 4, bot_msgs: 4, stage: 'baby_addons', last_at: '2026-10-15T11:00:00Z', draft_order: 'ORD-4' },
  ],
};
const SESSION = { ok: true, session: { order_id: 'ORD-1', order_status: 'pending', order_date: '2026-10-15', first_at: '2026-10-15T08:30:00Z', last_at: '2026-10-15T09:10:00Z',
  minutes_to_order: 30, customer_msgs_before_order: 5, bot_msgs_before_order: 5, customer_msgs: 6, bot_msgs: 6, channel: 'instagram', stage: 'new',
  source: 'Instagram chat', owner_name: 'Riya', conversation_id: '321', recent: [{ role: 'customer', text: 'Pink set please', ts: '2026-10-15T08:59:00Z' }] } };

const row = (page, id) => page.locator('#ordersTbody tr').filter({ has: page.locator('td', { hasText: new RegExp('^#' + id + '$') }) });

async function boot(page, { style = 'baby_care', token = 'tok', createStatus = 409 } = {}) {
  const calls = [];
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url.startsWith(WORKER)) {
      const p = new URL(url).pathname;
      const body = req.postData() ? JSON.parse(req.postData()) : null;
      calls.push({ path: p, method: req.method(), body, auth: req.headers()['authorization'] || '' });
      if (p === '/ecom/client') return route.fulfill({ json: { Id: 7, bot_config: JSON.stringify({ ecom_communication_style: style }), ecom_table_ids: JSON.stringify({ orders: 'tbl' }) } });
      if (p === '/ecom/orders' && req.method() === 'GET') return route.fulfill({ json: { list: ORDERS } });
      if (p === '/ecom/orders' && req.method() === 'POST') {
        if (createStatus === 409 && !body.allow_duplicate) return route.fulfill({ status: 409, json: { error: 'duplicate', message: 'This phone number already has an open order (#ORD-2, received) from the last 24 hours.', duplicate_of: { Id: 2, order_id: 'ORD-2' } } });
        return route.fulfill({ json: { Id: 99 } });
      }
      if (p === '/ecom/orders/insights') return route.fulfill({ json: INSIGHTS });
      if (p === '/ecom/orders/session') return route.fulfill({ json: SESSION });
      return route.fulfill({ json: { list: [] } });
    }
    return route.abort();
  });
  await page.goto(ecomUrl(token ? '&token=' + token : ''), { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { /* @ts-ignore */ showTab('orders'); });
  await expect(row(page, 'ORD-1')).toBeVisible();
  return calls;
}

test('counts orders under each status and filters by a status chip', async ({ page }) => {
  await boot(page);
  const chips = page.locator('#orderStatusChips');
  await expect(chips.locator('[data-status="pending"] b')).toHaveText('1');
  await expect(chips.locator('[data-status="received"] b')).toHaveText('1');
  await expect(chips.locator('[data-status="shipped"] b')).toHaveText('1');
  await expect(chips.locator('[data-status="draft"] b')).toHaveText('1');
  await expect(chips.locator('[data-status="cancelled"] b')).toHaveText('0');
  await chips.locator('[data-status="shipped"]').click();
  await expect(page.locator('#ordersTbody tr')).toHaveCount(1);
  await expect(page.locator('#ordersTbody tr')).toContainText('ORD-3');
});

test('shows how many orders were received on a date', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#orderDayCounts [data-day="2026-10-15"] b')).toHaveText('3');
  await page.locator('#orderDateFilter').fill('2026-10-15');
  await expect(page.locator('#orderDateSummary')).toContainText('3 orders received on the 15th');
  await expect(page.locator('#ordersTbody tr')).toHaveCount(3);
  await page.locator('#orderDayCounts [data-day="2026-10-14"]').click();
  await expect(page.locator('#orderDateSummary')).toContainText('1 order received on the 14th');
});

test('flags same-phone open orders as duplicates', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#orderDupChip b')).toHaveText('2');
  await expect(row(page, 'ORD-2')).toContainText('Possible duplicate of #ORD-1');
  await expect(row(page, 'ORD-3').locator('.dup-flag')).toHaveCount(0);
  await page.locator('#orderDupChip').click();
  await expect(page.locator('#ordersTbody tr')).toHaveCount(2);
});

test('a duplicate save asks first, and saves only when confirmed', async ({ page }) => {
  const calls = await boot(page);
  await page.getByRole('button', { name: '+ Add Order' }).click();
  await page.locator('#omCustomerPhone').fill('9876543210');
  page.once('dialog', d => d.dismiss());
  await page.getByRole('button', { name: 'Save Order' }).click();
  await expect(page.locator('#orderModalMsg')).toContainText('Not saved — duplicate of #ORD-2');
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: 'Save Order' }).click();
  await expect(page.locator('#orderModalOverlay')).not.toHaveClass(/active/);
  const posts = calls.filter(c => c.path === '/ecom/orders' && c.method === 'POST');
  expect(posts.map(c => !!c.body.allow_duplicate)).toEqual([false, false, true]);
});

test('lead source + assignee per order and the warm-lead list', async ({ page }) => {
  const calls = await boot(page);
  const row1 = row(page, 'ORD-1');
  await expect(row1.locator('.src-cell')).toContainText('Instagram chat');
  await expect(row1.locator('.src-cell')).toContainText('→ Riya');
  await expect(row(page, 'ORD-3').locator('.src-cell')).toContainText('Added manually by admin@shop.in');
  await expect(row(page, 'ORD-4').locator('.src-cell')).toContainText('No chat lead');
  const warm = page.locator('#warmLeadsTbody tr');
  await expect(warm).toHaveCount(1);
  await expect(warm).toContainText('Fathima');
  await expect(warm).toContainText('Draft #ORD-4');
  await expect(warm).toContainText('Sam');
  expect(calls.find(c => c.path === '/ecom/orders/insights').auth).toBe('Bearer tok');
});

test('order session opens the chat behind an order', async ({ page }) => {
  await boot(page);
  await row(page, 'ORD-1').getByTitle('Order session — the chat behind this order').click();
  const body = page.locator('#orderSessionBody');
  await expect(body).toContainText('30 min');
  await expect(body).toContainText('5 customer · 5 AI');
  await expect(body).toContainText('Riya');
  await expect(body).toContainText('Pink set please');
});

test('without a sign-in the order list still works and says why lead details are missing', async ({ page }) => {
  await boot(page, { token: '' });
  await expect(page.locator('#warmLeadsTbody')).toContainText('Open Ecommerce from the dashboard');
  await expect(page.locator('#orderStatusChips [data-status="pending"] b')).toHaveText('1');
});

test('other ecom styles keep the Orders page unchanged', async ({ page }) => {
  const calls = await boot(page, { style: 'fashion_garments' });
  await expect(page.locator('#bcOrdersPanel')).toBeHidden();
  await expect(page.locator('#ordersTbody .src-cell')).toHaveCount(0);
  await expect(page.locator('#ordersTbody .dup-flag')).toHaveCount(0);
  await expect(page.locator('#ordersTbody tr')).toHaveCount(4);
  expect(calls.some(c => c.path === '/ecom/orders/insights')).toBe(false);
});
