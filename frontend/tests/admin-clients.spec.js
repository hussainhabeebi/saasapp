// Admin → Clients: summary + filters, health checks (view / run / run all), guarded delete.
// Hermetic file:// setup like billing-razorpay.spec.js; the clients list comes from the stubbed
// admin NocoDB passthrough.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const adminUrl = 'file://' + path.resolve(__dirname, '../admin.html');
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';
const now = new Date().toISOString();
const LOG = JSON.stringify([{ ts: now, results: [
  { key: 'whatsapp', label: 'WhatsApp (Meta)', category: 'integration', status: 'fail', detail: 'Token expired' },
  { key: 'resend', label: 'Resend (Email)', category: 'integration', status: 'ok', detail: 'leadvyne.com' },
] }]);
const CLIENTS = [
  { Id: 1, client_name: 'Moulavi Travels', authentik_email: 'moulavi@aiingo.com', active: 'Yes', last_seen: now, integration_health_status: 'fail', integration_health_checked_at: now, integration_health_log: LOG },
  { Id: 2, client_name: 'Aiingo Technologies LLP', authentik_email: 'sales@aiingo.com', active: 'Yes', stripe_subscription_id: 'sub_s', plan_status: 'unpaid', plan_name: 'price_1Tq', integration_health_status: 'ok' },
  { Id: 3, client_name: 'Vintage', authentik_email: 'vintage@aiingo.com', active: 'No' },
];

async function login(page, extra = () => null) {
  const calls = [];
  await page.route('**/*', async (route) => {
    const req = route.request(), url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (!url.startsWith(WORKER)) return route.abort();
    const p = new URL(url).pathname, body = req.postData() ? JSON.parse(req.postData()) : null;
    calls.push({ path: p, body });
    if (p === '/admin/login') return route.fulfill({ json: { session_token: 'adm' } });
    if (p.includes(`/tables/mxl33bg4wi70fqj/records`)) return route.fulfill({ json: { list: CLIENTS, pageInfo: { isLastPage: true } } });
    if (p.includes('/tables/')) return route.fulfill({ json: { list: [{ ClientId: 1 }, { ClientId: 1, error: 'x' }] } });
    const r = extra(p, body);
    return r ? route.fulfill(r) : route.fulfill({ json: { ok: true } });
  });
  await page.goto(adminUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#f-token').fill('pass');
  await page.locator('#btn-connect').click();
  await expect(page.locator('.client-card')).toHaveCount(3);
  return calls;
}

test('clients render with billing + health chips, summary tiles filter, search and sort', async ({ page }) => {
  await login(page);
  await expect(page.locator('#card-2')).toContainText('unpaid');
  await expect(page.locator('#card-1 .health-chip')).toContainText('Failing');
  await expect(page.locator('#card-3 .health-chip')).toContainText('Not checked');
  await expect(page.locator('#msgs-1')).toHaveText('2');
  await page.locator('#cl-summary [data-quick="suspended"]').click();
  await expect(page.locator('.client-card')).toHaveCount(1);
  await expect(page.locator('#card-3')).toBeVisible();
  await page.locator('#cl-summary [data-quick="suspended"]').click();
  await page.locator('#search-input').fill('sales@aiingo');
  await expect(page.locator('.client-card')).toHaveCount(1);
  await page.locator('#search-input').fill('');
  await page.locator('#cl-sort').selectOption('health');
  await expect(page.locator('.client-card').first()).toHaveAttribute('id', 'card-1');
});

test('health modal shows each check and can re-run them', async ({ page }) => {
  const calls = await login(page, (p) => p === '/admin/clients/health-run'
    ? { json: { ok: true, status: 'ok', checked_at: new Date().toISOString(), results: [{ key: 'whatsapp', label: 'WhatsApp (Meta)', category: 'integration', status: 'ok', detail: '+91 98' }] } }
    : null);
  await page.locator('#card-1').getByRole('button', { name: '🩺 Health' }).click();
  await expect(page.locator('#health-modal-body')).toContainText('Token expired');
  await page.locator('#health-run-one').click();
  await expect(page.locator('#health-modal-body')).toContainText('+91 98');
  expect(calls.find((c) => c.path === '/admin/clients/health-run').body).toEqual({ client_id: 1 });
  await page.locator('#health-modal-close').click();
  await expect(page.locator('#card-1 .health-chip')).toContainText('Healthy');

  page.once('dialog', (d) => d.accept());
  await page.locator('#cl-run-all').click();
  await expect.poll(() => calls.filter((c) => c.path === '/admin/clients/health-run').length).toBe(4);
});

test('delete needs the exact name and removes the card', async ({ page }) => {
  const calls = await login(page);
  await page.locator('#card-3 [data-delete]').click();
  const btn = page.locator('#delete-confirm');
  await expect(btn).toBeDisabled();
  await page.locator('#delete-confirm-input').fill('vintage');
  await expect(btn).toBeDisabled();
  await page.locator('#delete-confirm-input').fill('Vintage');
  await btn.click();
  await expect(page.locator('.client-card')).toHaveCount(2);
  expect(calls.find((c) => c.path === '/admin/clients/delete').body).toEqual({ client_id: 3, confirm_name: 'Vintage' });

  // A client with a live subscription gets the warning up front.
  await page.locator('#card-2 [data-delete]').click();
  await expect(page.locator('#delete-modal-info')).toContainText('live Stripe subscription');
});
