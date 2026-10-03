// Ecom → Orders: Baby Care chat drafts ("Draft (in chat)"), staff editing an order, "Fill from chat"
// and "Sync from chats". Hermetic file:// setup — Worker routes answered by page.route stubs.
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
      if (p === '/ecom/orders/from-chat') return route.fulfill({ json: { ok: true, suggested: { items: 'Romper Set | Name: Ayra', customer_name: 'Murshid', delivery_address: 'Kochi 682001', notes: 'Wants delivery before 10th' } } });
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
  await page.locator('#omTotal').fill('1059');
  await page.getByRole('button', { name: 'Save Order' }).click();
  await expect.poll(() => calls.find(c => c.path === '/ecom/orders' && c.method === 'PATCH')?.body).toMatchObject(
    { Id: 1, client_id: '7', order_id: 'ORD-1', items: 'Romper Set | Name: Ayra', delivery_address: 'Kochi 682001', total: 1059, status: 'draft' });
});

test('"Sync from chats" reports what it found and reloads the list', async ({ page }) => {
  const calls = await boot(page);
  await page.getByRole('button', { name: '🔄 Sync from chats' }).click();
  await expect(page.locator('#ordersSyncMsg')).toContainText('2 new draft order(s), 1 refreshed');
  expect(calls.find(c => c.path === '/ecom/orders/sync-chats').body).toEqual({ client_id: '7' });
});
