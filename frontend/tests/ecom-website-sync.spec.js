// Ecom → 🌐 Website Sync page: connect a custom website API, see the webhook link, sync, disconnect.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ecomUrl = 'file://' + path.resolve(__dirname, '../ecom.html') + '?client=7&token=sess-1&tab=website';
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';
const SHOT = process.env.ECOM_SHOTS || '';

const CONNECTED = {
  connected: true, name: '4L Fashion', base_url: 'https://4lfashion.com.qa/api/v1', auth_style: 'bearer', key_hint: '4lf_…9a2c',
  has_secret: true, currency: 'QAR', paths: { ping: '/ping', products: '/products', orders: '/orders', inventory: '/inventory' },
  sync_products: true, sync_orders: true, sync_categories: true, delete_missing: true, enabled: true, sync_minutes: 60,
  webhook_url: `${WORKER}/ecom/website/hook/abc123abc123abc123abc123abc123abc123abc123abc1`,
  last_sync_at: new Date(Date.now() - 120000).toISOString(), last_status: 'ok', last_error: '',
  last_summary: '12 products added · 3 categories added · 40 orders added', last_webhook_at: '', last_webhook_event: '',
};

async function boot(page, { connected = false } = {}) {
  const calls = [];
  let state = connected ? { ...CONNECTED } : { connected: false };
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (!url.startsWith(WORKER)) return route.fulfill({ status: 204, body: '' });
    const u = new URL(url);
    const body = req.method() === 'POST' ? JSON.parse(req.postData() || '{}') : null;
    calls.push({ path: u.pathname, method: req.method(), body, auth: req.headers()['authorization'] || '' });
    if (u.pathname === '/ecom/client') return route.fulfill({ json: { Id: 7, client_name: '4L Fashion', ecom_table_ids: JSON.stringify({ orders: 'o', products: 'p' }) } });
    if (u.pathname === '/ecom/products') return route.fulfill({ json: { list: [{ Id: 1, name: 'Linen Abaya', sku: 'AB-41', price: 399, currency: 'QAR', stock: 5, status: 'active', website_product_id: '41' }] } });
    if (u.pathname === '/ecom/website/status') return route.fulfill({ json: state });
    if (u.pathname === '/ecom/website/test') return route.fulfill({ json: { ok: true, ping: true, orders_ok: true, products_sample: [{ name: 'Linen Abaya', sku: 'AB-41', price: 399, stock: 5, category: 'Abayas', status: 'active' }] } });
    if (u.pathname === '/ecom/website/connect') { state = { ...CONNECTED, name: body.name, base_url: body.base_url }; return route.fulfill({ json: { ok: true, config: state, result: { ok: true, summary: '12 products added · 40 orders added' } } }); }
    if (u.pathname === '/ecom/website/sync') return route.fulfill({ json: { ok: true, summary: 'Everything already up to date', config: state } });
    if (u.pathname === '/ecom/website/disconnect') { state = { connected: false }; return route.fulfill({ json: { ok: true, config: state } }); }
    return route.fulfill({ json: { list: [] } });
  });
  await page.goto(ecomUrl);
  return calls;
}

test('connect a website: test, connect & sync, webhook link shown; key never echoed', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const calls = await boot(page);
  await expect(page.locator('#tabWebsite')).toHaveClass(/active/);
  await page.fill('#wsyName', '4L Fashion');
  await page.fill('#wsyBaseUrl', 'https://4lfashion.com.qa/api/v1');
  await page.fill('#wsyApiKey', '4lf_secretkey');
  await page.fill('#wsySecret', 'whsec_1');
  await page.fill('#wsyCurrency', 'QAR');
  await page.click('#wsyTestBtn');
  await expect(page.locator('#wsyTestOut')).toContainText('Connected');
  await expect(page.locator('#wsyTestOut')).toContainText('Linen Abaya');
  await page.click('#wsySaveBtn');
  await expect(page.locator('#wsyMsg')).toContainText('12 products added');
  const connect = calls.find(c => c.path === '/ecom/website/connect');
  expect(connect.auth).toBe('Bearer sess-1');
  expect(connect.body).toMatchObject({ base_url: 'https://4lfashion.com.qa/api/v1', api_key: '4lf_secretkey', webhook_secret: 'whsec_1', currency: 'QAR', delete_missing: true, sync_now: true });
  await expect(page.locator('#wsyHookCard')).toBeVisible();
  await expect(page.locator('#wsyHookUrl')).toHaveValue(/\/ecom\/website\/hook\//);
  await expect(page.locator('#wsyApiKey')).toHaveValue('');
  await expect(page.locator('#wsyKeyHint')).toContainText('4lf_…9a2c');
  await expect(page.locator('#wsyLive')).toHaveText('Live sync');
  if (SHOT) await page.screenshot({ path: path.join(SHOT, 'website-sync.png'), fullPage: true });
});

test('connected: sync now and disconnect; synced products show the Website badge with read-only stock', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const calls = await boot(page, { connected: true });
  await expect(page.locator('#wsyBaseUrl')).toHaveValue('https://4lfashion.com.qa/api/v1');
  await expect(page.locator('#wsyStatusRow')).toContainText('40 orders added');
  await page.click('#wsySyncBtn');
  await expect(page.locator('#wsyMsg')).toContainText('up to date');
  page.once('dialog', d => d.accept());
  await page.click('#wsyDisconnectBtn');
  await expect(page.locator('#wsyHookCard')).toBeHidden();
  expect(calls.some(c => c.path === '/ecom/website/disconnect')).toBe(true);
  await page.click('[data-tab="products"]');
  await expect(page.locator('#productsTbody')).toContainText('🌐 Website');
  await expect(page.locator('#productsTbody .stock-input').first()).toHaveAttribute('readonly', '');
});
