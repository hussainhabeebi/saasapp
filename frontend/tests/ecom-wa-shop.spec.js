// Ecom → 📲 WhatsApp Shop: the five-step setup (catalog, sync, cart orders, payment, share) talks to
// the session-authed /ecom/wa-shop/* routes (cloudflare-worker/wa-commerce.js).
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ecomUrl = (q = '') => 'file://' + path.resolve(__dirname, '../ecom.html') + '?client=7' + q;
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';

function statusFor(over = {}) {
  return {
    config: { catalog_id: '', linked_at: '', synced_at: '', synced_count: 0, skipped: [], carts: false, payment_mode: 'cod', gateway: 'razorpay', payment_config: '', send_in_chat: true, ...over },
    whatsapp: true, has_catalog_token: false, shopify: false, chatwoot_target: 'https://chat.x/webhooks/whatsapp/+9194',
    stats: { carts: 3, paid: 1, revenue: 4200, recent: [{ order_ref: 'WA-261024-AB12', phone: '919800000001', total: 1198, created_at: '2026-10-24T10:00:00Z' }] },
  };
}

async function boot(page, { token = 'tok', status = statusFor(), connect = null, sync = null, network = false } = {}) {
  const calls = [];
  let current = status;
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url.startsWith(WORKER)) {
      const u = new URL(url);
      const body = req.postData() ? JSON.parse(req.postData()) : null;
      if (u.pathname.startsWith('/ecom/wa-shop/')) calls.push({ path: u.pathname, body, auth: req.headers()['authorization'] || '' });
      if (u.pathname === '/ecom/client') return route.fulfill({ json: { Id: 7, ecom_table_ids: JSON.stringify({ orders: 'o', products: 'p' }) } });
      if (u.pathname === '/ecom/products') return route.fulfill({ json: { list: [{ Id: 1, name: 'Kurta', category: 'Kurtas', price: 599 }] } });
      if (u.pathname === '/ecom/wa-shop/status') return route.fulfill({ json: current });
      if (u.pathname === '/ecom/wa-shop/connect') {
        if (network) return route.abort('failed');
        if (connect) { const r = connect(body); if (r.status >= 400) return route.fulfill({ status: r.status, json: r.json }); current = statusFor({ ...current.config, ...(r.config || {}) }); return route.fulfill({ json: r.json }); }
        current = statusFor({ ...current.config, catalog_id: body.catalog_id, linked_at: '2026-10-24T10:00:00Z' }); return route.fulfill({ json: { ok: true } });
      }
      if (u.pathname === '/ecom/wa-shop/sync' && sync) { const r = sync(body); if (r.status >= 400) return route.fulfill({ status: r.status, json: r.json }); current = statusFor({ ...current.config, ...(r.config || {}) }); return route.fulfill({ json: r.json }); }
      if (u.pathname === '/ecom/wa-shop/sync') { current = statusFor({ ...current.config, synced_at: '2026-10-24T10:00:00Z', synced_count: 12, skipped: [{ id: 3, name: 'Dupatta', reason: 'no photo' }] }); return route.fulfill({ json: { ok: true, synced: 12, removed: 1, skipped: [] } }); }
      if (u.pathname === '/ecom/wa-shop/carts') { current = statusFor({ ...current.config, carts: body.enable }); return route.fulfill({ json: { ok: true, carts: body.enable } }); }
      if (u.pathname === '/ecom/wa-shop/send') return route.fulfill({ json: { ok: true, count: 9 } });
      if (u.pathname === '/ecom/wa-shop/config') {
        if (body.payment_mode === 'whatsapp_pay' && !body.payment_config) return route.fulfill({ status: 400, json: { error: 'Add the payment configuration name from WhatsApp Manager → Payments to use WhatsApp Pay.' } });
        current = statusFor({ ...current.config, ...body }); return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({ json: { list: [] } });
    }
    return route.abort();
  });
  await page.goto(ecomUrl(token ? '&token=' + token : ''), { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { /* @ts-ignore */ showTab('washop'); });
  return calls;
}

test('setup walks through catalog link, product sync and cart orders with the staff session', async ({ page }) => {
  const calls = await boot(page);
  await expect(page.locator('#wsState')).toHaveText('Setup needed');
  await expect(page.locator('#wsStats')).toContainText('₹4,200');
  await expect(page.locator('#wsRecent')).toContainText('WA-261024-AB12');

  await page.locator('#wsCatalogId').fill('1234567890');
  await page.getByRole('button', { name: 'Link to my WhatsApp' }).click();
  await expect(page.locator('#wsDone1')).toHaveText('✓ Linked');
  expect(calls.find(c => c.path === '/ecom/wa-shop/connect').body).toEqual({ catalog_id: '1234567890' });
  expect(calls.every(c => c.auth === 'Bearer tok')).toBe(true);

  await page.getByRole('button', { name: /Sync products now/ }).click();
  await expect(page.locator('#wsMsg2')).toContainText('12 products sent, 1 removed');
  await expect(page.locator('#wsSkipped')).toContainText('Dupatta — no photo');
  await expect(page.locator('#wsState')).toHaveText('● Catalog live');

  page.once('dialog', d => d.accept());
  await page.locator('#wsStep3 .toggle-slider').click();
  await expect(page.locator('#wsDone3')).toHaveText('✓ On');
  expect(calls.find(c => c.path === '/ecom/wa-shop/carts').body).toEqual({ enable: true });
  await expect(page.locator('#wsState')).toHaveText('● Live — taking orders');
});

test('payment option: WhatsApp Pay needs a configuration name; Shopify checkout only for Shopify stores', async ({ page }) => {
  const calls = await boot(page);
  await expect(page.locator('#wsPayShopifyOpt')).toBeHidden();
  await page.locator('input[name="wsPay"][value="whatsapp_pay"]').check();
  await expect(page.locator('#wsPayCfg')).toBeVisible();
  await page.getByRole('button', { name: 'Save payment option' }).click();
  await expect(page.locator('#wsMsg4')).toContainText('payment configuration name');
  await page.locator('#wsGateway').selectOption('payu');
  await page.locator('#wsPayConfig').fill('kochi-payu');
  await page.getByRole('button', { name: 'Save payment option' }).click();
  await expect(page.locator('#wsMsg4')).toContainText('✓ Payment option saved');
  expect(calls.filter(c => c.path === '/ecom/wa-shop/config').at(-1).body).toEqual({ payment_mode: 'whatsapp_pay', gateway: 'payu', payment_config: 'kochi-payu' });
});

test('staff can send the catalog (or one category) to a customer', async ({ page }) => {
  const calls = await boot(page, { status: statusFor({ catalog_id: '1', linked_at: 'x', synced_at: '2026-10-24T10:00:00Z', synced_count: 12 }) });
  await page.locator('#wsSendPhone').fill('919800000001');
  await page.locator('#wsSendCat').selectOption('Kurtas');
  await page.getByRole('button', { name: 'Send catalog' }).click();
  await expect(page.locator('#wsMsg5')).toContainText('Sent 9 products');
  expect(calls.find(c => c.path === '/ecom/wa-shop/send').body).toEqual({ phone: '919800000001', category: 'Kurtas' });
});

test('without the dashboard sign-in it asks to open Ecom from the dashboard', async ({ page }) => {
  const calls = await boot(page, { token: '' });
  await expect(page.locator('#wsState')).toHaveText('Sign in needed');
  await expect(page.locator('#wsBanner')).toContainText('Open Ecommerce from your Leadvyne dashboard');
  expect(calls.length).toBe(0);
});

// Couplo (Oct 2026): catalog already connected in WhatsApp Manager, 24 products added in Meta.
test('an already-connected Meta catalog links, shows its name and product count, and needs no sync', async ({ page }) => {
  const items = Array.from({ length: 24 }, (_, i) => ({ rid: 'SKU' + i, name: 'Set ' + i, price: 899, category: 'Baby Sets' }));
  const calls = await boot(page, { connect: (b) => ({ json: { ok: true, already_linked: true, catalog_name: 'Couplo catalog', product_count: 24 },
    config: { catalog_id: b.catalog_id, linked_at: '2026-10-28T10:00:00Z', catalog_name: 'Couplo catalog', catalog_count: 24, meta_items: items } }) });
  await page.locator('#wsCatalogId').fill('1484032813531427');
  await page.getByRole('button', { name: 'Link to my WhatsApp' }).click();
  await expect(page.locator('#wsMsg1')).toContainText('Catalog was already connected');
  await expect(page.locator('#wsMsg1')).toContainText('“Couplo catalog” · 24 products');
  await expect(page.locator('#wsDone1')).toHaveText('✓ Linked — Couplo catalog');
  await expect(page.locator('#wsStats .stat').first()).toContainText('24');
  await expect(page.locator('#wsDone2')).toContainText('Using the 24 products already in your Meta catalog');
  await expect(page.locator('#wsState')).toHaveText('● Catalog live');
  expect(calls.find(c => c.path === '/ecom/wa-shop/connect').body).toEqual({ catalog_id: '1484032813531427' });
});

test('a Meta refusal stays on screen instead of fading out', async ({ page }) => {
  await boot(page, { connect: () => ({ status: 502, json: { error: 'Meta says the token isn\'t allowed to connect this catalog (#200)' } }) });
  await page.locator('#wsCatalogId').fill('1484032813531427');
  await page.getByRole('button', { name: 'Link to my WhatsApp' }).click();
  await expect(page.locator('#wsMsg1')).toContainText('⚠ Meta says the token');
  await page.waitForTimeout(3500);
  await expect(page.locator('#wsMsg1')).toContainText('⚠ Meta says the token');
});

test('no answer from the server ("Failed to fetch") is explained, and an empty ID is caught first', async ({ page }) => {
  const calls = await boot(page, { network: true });
  await page.getByRole('button', { name: 'Link to my WhatsApp' }).click();
  await expect(page.locator('#wsMsg1')).toContainText('Enter the catalog ID');
  expect(calls.some(c => c.path === '/ecom/wa-shop/connect')).toBe(false);
  await page.locator('#wsCatalogId').fill('1484032813531427');
  await page.getByRole('button', { name: 'Link to my WhatsApp' }).click();
  await expect(page.locator('#wsMsg1')).toContainText('Couldn’t reach Leadvyne’s server');
});

test('syncing into a Meta-managed catalog asks first', async ({ page }) => {
  const calls = await boot(page, { sync: (b) => (!b.confirm
    ? { status: 409, json: { error: 'meta_managed', message: 'Your catalog already has 24 products added in Meta. Sync anyway?' } }
    : { json: { ok: true, synced: 5, removed: 0, skipped: [] }, config: { synced_at: '2026-10-28T10:00:00Z', synced_count: 5 } }) });
  page.once('dialog', d => d.dismiss());
  await page.getByRole('button', { name: /Sync products now/ }).click();
  await expect(page.locator('#wsMsg2')).toContainText('24 products added in Meta');
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: /Sync products now/ }).click();
  await expect(page.locator('#wsMsg2')).toContainText('5 products sent');
  expect(calls.filter(c => c.path === '/ecom/wa-shop/sync').map(c => c.body)).toEqual([{}, {}, { confirm: true }]);
});
