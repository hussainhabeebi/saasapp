// Ecom → Orders, Baby Care only: "Assigned To" per order (team picker, sent with the staff session),
// assignee filter, assign on Add Order, and the "Orders assigned to each person" report.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ecomUrl = (q = '') => 'file://' + path.resolve(__dirname, '../ecom.html') + '?client=7' + q;
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';

const ORDERS = [
  { Id: 1, order_id: 'ORD-1', customer_name: 'Murshid', customer_phone: '919876543210', order_date: '2026-10-15', items: 'Romper Set', total: 999, status: 'pending', assigned_to: 'a@x.com', assigned_to_name: 'Anu', assigned_by: 'auto', assigned_at: '2026-10-15T09:00:00Z' },
  { Id: 2, order_id: 'ORD-2', customer_name: 'Asha', customer_phone: '919800000000', order_date: '2026-10-15', items: 'Jhabla', total: 500, status: 'received' },
  { Id: 3, order_id: 'ORD-3', customer_name: 'Nimmi', customer_phone: '919833333333', order_date: '2026-10-16', items: 'Boots', total: 300, status: 'shipped', assigned_to: 'b@x.com', assigned_to_name: 'Bilal' },
];
const TEAM = [{ email: 'boss@x.com', name: 'Owner', owner: true, on_leave: false }, { email: 'a@x.com', name: 'Anu', owner: false, on_leave: true }, { email: 'b@x.com', name: 'Bilal', owner: false, on_leave: false }];
const REPORT = { ok: true, full_access: true, me: 'boss@x.com', total_orders: 3, rows: [], assigned_rows: [
  { assigned_to: 'a@x.com', name: 'Anu', total: 1, open: 1, done: 0, cancelled: 0 },
  { assigned_to: 'b@x.com', name: 'Bilal', total: 1, open: 0, done: 1, cancelled: 0 },
  { assigned_to: '', name: 'Unassigned', total: 1, open: 1, done: 0, cancelled: 0 },
] };
const row = (page, id) => page.locator('#ordersTbody tr').filter({ has: page.locator('td', { hasText: new RegExp('^#' + id + '$') }) });

async function boot(page, { style = 'baby_care', token = 'tok', insights = null, mode } = {}) {
  const calls = [];
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url.startsWith(WORKER)) {
      const u = new URL(url);
      const body = req.postData() ? JSON.parse(req.postData()) : null;
      calls.push({ path: u.pathname, method: req.method(), body, auth: req.headers()['authorization'] || '' });
      if (u.pathname === '/ecom/client' && req.method() === 'GET') return route.fulfill({ json: { Id: 7, bot_config: JSON.stringify({ ecom_communication_style: style, ...(mode ? { ecom_order_assign_mode: mode } : {}) }), ecom_table_ids: JSON.stringify({ orders: 'tbl' }) } });
      if (u.pathname === '/ecom/client') return route.fulfill({ json: {} });
      if (u.pathname === '/ecom/orders/assign') return route.fulfill({ json: { ok: true, assigned: body.ids.length } });
      if (u.pathname === '/ecom/orders/auto-assign') return route.fulfill({ json: { ok: true, assigned: 4, no_owner: 2 } });
      if (u.pathname === '/ecom/orders' && req.method() === 'GET') return route.fulfill({ json: { list: ORDERS.map(o => ({ ...o })) } });
      if (u.pathname === '/ecom/orders') return route.fulfill({ json: { Id: 99 } });
      if (u.pathname === '/ecom/orders/staff-report') return route.fulfill({ json: REPORT });
      if (u.pathname === '/ecom/orders/insights') return route.fulfill({ json: insights || { ok: true, leads: [], warm_leads: [], team: TEAM } });
      return route.fulfill({ json: { list: [] } });
    }
    return route.abort();
  });
  await page.goto(ecomUrl(token ? '&token=' + token : ''), { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { /* @ts-ignore */ showTab('orders'); });
  await expect(row(page, 'ORD-1')).toBeVisible();
  return calls;
}

test('each order shows who it is assigned to, and can be reassigned', async ({ page }) => {
  const calls = await boot(page);
  const sel1 = row(page, 'ORD-1').locator('.assign-sel');
  await expect(sel1).toHaveValue('a@x.com');
  await expect(sel1.locator('option:checked')).toContainText('on leave');
  await expect(row(page, 'ORD-1').locator('.assigned-cell')).toContainText('auto');
  await expect(row(page, 'ORD-2').locator('.assign-sel')).toHaveValue('');
  await row(page, 'ORD-2').locator('.assign-sel').selectOption('b@x.com');
  await expect.poll(() => calls.find(c => c.method === 'PATCH')?.body).toMatchObject({ Id: 2, assigned_to: 'b@x.com' });
  expect(calls.find(c => c.method === 'PATCH').auth).toBe('Bearer tok');
  await expect(row(page, 'ORD-2').locator('.assign-sel')).toHaveValue('b@x.com');
});

test('assigned-orders report filters the list to one person', async ({ page }) => {
  await boot(page);
  const rep = page.locator('#assignedReportTbody tr');
  await expect(rep).toHaveCount(3);
  await rep.filter({ hasText: 'Bilal' }).click();
  await expect(page.locator('#ordersTbody tr')).toHaveCount(1);
  await expect(row(page, 'ORD-3')).toBeVisible();
  await rep.filter({ hasText: 'Unassigned' }).click();
  await expect(page.locator('#ordersTbody tr')).toHaveCount(1);
  await expect(row(page, 'ORD-2')).toBeVisible();
});

test('Add Order can pick who it is assigned to; auto by default', async ({ page }) => {
  const calls = await boot(page);
  await page.getByRole('button', { name: '+ Add Order' }).click();
  await expect(page.locator('#omAssignedTo')).toHaveValue('');
  await expect(page.locator('#omAssignedTo option').first()).toContainText('Auto');
  await page.locator('#omCustomerPhone').fill('9876500000');
  await page.locator('#omAssignedTo').selectOption('b@x.com');
  await page.getByRole('button', { name: 'Save Order' }).click();
  await expect.poll(() => calls.find(c => c.method === 'POST' && c.path === '/ecom/orders')?.body?.assigned_to).toBe('b@x.com');
});

test('without a sign-in the assignment is shown but not editable', async ({ page }) => {
  await boot(page, { token: '' });
  await expect(row(page, 'ORD-1').locator('.assign-sel')).toHaveCount(0);
  await expect(row(page, 'ORD-1').locator('.assigned-cell')).toContainText('Anu');
});

test('other ecom styles: no Assigned To column', async ({ page }) => {
  await boot(page, { style: 'fashion_garments' });
  await expect(page.locator('#ordersTbody .assigned-cell')).toHaveCount(0);
});

test('choose Auto or Manual assignment for new orders', async ({ page }) => {
  const calls = await boot(page);
  await expect(page.locator('#orderAssignMode')).toHaveValue('auto');
  await page.locator('#orderAssignMode').selectOption('manual');
  await expect.poll(() => calls.find(c => c.path === '/ecom/client' && c.method === 'PATCH')?.body?.bot_config).toBeTruthy();
  const cfg = JSON.parse(calls.find(c => c.path === '/ecom/client' && c.method === 'PATCH').body.bot_config);
  expect(cfg).toMatchObject({ ecom_order_assign_mode: 'manual', ecom_communication_style: 'baby_care' });
  await expect(page.locator('#orderAssignMsg')).toContainText('Manual');
});

test('saved Manual mode is shown', async ({ page }) => {
  await boot(page, { mode: 'manual' });
  await expect(page.locator('#orderAssignMode')).toHaveValue('manual');
});

test('auto-assign existing orders from the lead owner', async ({ page }) => {
  const calls = await boot(page);
  await page.getByRole('button', { name: '⚡ Auto-assign from lead owner' }).click();
  await expect(page.locator('#orderAssignMsg')).toContainText('4 orders assigned to the lead owner · 2 with no lead owner');
  const c = calls.find(c => c.path === '/ecom/orders/auto-assign');
  expect(c.body).toEqual({ client_id: '7' });
  expect(c.auth).toBe('Bearer tok');
});

test('tick orders and assign them to one person', async ({ page }) => {
  const calls = await boot(page);
  await expect(page.locator('#bulkAssignBtn')).toBeDisabled();
  await row(page, 'ORD-1').locator('input[type=checkbox]').check();
  await row(page, 'ORD-2').locator('input[type=checkbox]').check();
  await expect(page.locator('#bulkAssignBtn')).toHaveText('Assign 2 selected');
  await page.locator('#bulkAssignTo').selectOption('b@x.com');
  await page.locator('#bulkAssignBtn').click();
  await expect(page.locator('#orderAssignMsg')).toContainText('2 orders assigned to Bilal');
  expect(calls.find(c => c.path === '/ecom/orders/assign').body).toEqual({ client_id: '7', ids: [1, 2], assigned_to: 'b@x.com' });
});

test('a failed lead read still leaves the assignment picker working', async ({ page }) => {
  await boot(page, { insights: { ok: true, leads: [], warm_leads: [], team: TEAM, leads_error: 'Could not read leads — try ↻ in a minute' } });
  await expect(page.locator('#warmLeadsTbody')).toContainText('Could not read leads');
  await expect(row(page, 'ORD-2').locator('.assign-sel')).toBeVisible();
  await expect(row(page, 'ORD-2').locator('.assign-sel option')).toHaveCount(4);
});
