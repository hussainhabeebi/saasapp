// Ecom desktop UX: Home overview, grouped sidebar, and the Shopify Orders / Stock modules
// (desktop only, Shopify connected). Phones keep the original tab row and Products landing.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ecomUrl = 'file://' + path.resolve(__dirname, '../ecom.html') + '?client=7';
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';
const SHOT = process.env.ECOM_SHOTS || '';

const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const iso = (n) => new Date(Date.now() - n * 3600000).toISOString();
const ORDERS = [
  { Id: 1, order_id: 'ORD-1', customer_name: 'Murshid', order_date: day(0), CreatedAt: iso(1), items: '2x Kurta', total: 1200, currency: 'INR', status: 'pending' },
  { Id: 2, order_id: 'ORD-2', customer_name: 'Asha', order_date: day(3), CreatedAt: iso(72), items: '1x Saree', total: 2500, currency: 'INR', status: 'shipped' },
  { Id: 3, order_id: 'ORD-3', customer_name: 'Nimmi', order_date: day(5), CreatedAt: iso(120), items: '1x Kurta', total: 600, currency: 'INR', status: 'cancelled' },
];
const PRODUCTS = [
  { Id: 1, name: 'Kurta', price: 600, stock: 3, status: 'active' },
  { Id: 2, name: 'Saree', price: 2500, stock: 0, status: 'active' },
  { Id: 3, name: 'Dupatta', price: 300, stock: 40, status: 'active' },
];
const SHOP_ORDERS = [
  { shopify_order_id: '5001', name: '#1001', created_at: iso(2), customer_name: 'Asha K', customer_phone: '+919999900000', financial_status: 'paid', fulfillment_status: 'unfulfilled', total: 1299, subtotal: 1199, shipping_total: 50, total_tax: 50, currency: 'INR', items_count: 2, line_items_json: JSON.stringify([{ title: 'Kurta', variant_title: 'M', sku: 'K-M', quantity: 2, price: 599.5 }]), shipping_address: JSON.stringify({ name: 'Asha K', address1: '1 MG Rd', city: 'Kochi', country: 'India' }), fulfillments_json: '[]', source_name: 'web' },
  { shopify_order_id: '5002', name: '#1002', created_at: iso(30), customer_name: 'Ravi', financial_status: 'pending', fulfillment_status: 'fulfilled', total: 800, currency: 'INR', items_count: 1, line_items_json: '[]', fulfillments_json: JSON.stringify([{ id: '1', company: 'Delhivery', number: 'DL123', url: 'https://t/1', shipment_status: 'delivered' }]) },
  { shopify_order_id: '5003', name: '#1003', created_at: iso(50), customer_name: 'Zara', financial_status: 'refunded', fulfillment_status: null, cancelled_at: iso(40), total: 400, currency: 'INR', items_count: 1, line_items_json: '[]', fulfillments_json: '[]' },
];
const SHOP_STOCK = [
  { shopify_product_id: '1', shopify_variant_id: '101', product_title: 'Kurta', variant_title: 'M', sku: 'K-M', price: 599, available: 2, tracked: 'Yes', product_status: 'active', product_type: 'Apparel', vendor: 'Own', updated_at: iso(1) },
  { shopify_product_id: '1', shopify_variant_id: '102', product_title: 'Kurta', variant_title: 'L', sku: 'K-L', price: 599, available: 0, tracked: 'Yes', product_status: 'active', product_type: 'Apparel', vendor: 'Own', updated_at: iso(3) },
  { shopify_product_id: '2', shopify_variant_id: '201', product_title: 'Saree', variant_title: '', sku: 'S-1', price: 2500, available: 30, tracked: 'Yes', product_status: 'active', product_type: 'Ethnic', vendor: 'Weaver', updated_at: iso(5), levels_json: JSON.stringify({ 1: 20, 2: 10 }) },
  { shopify_product_id: '3', shopify_variant_id: '301', product_title: 'Gift card', variant_title: '', sku: '', price: 500, available: 0, tracked: 'No', product_status: 'draft', product_type: 'Gift', vendor: 'Own', updated_at: iso(9) },
];

async function boot(page, { shopify = true, scopes = { orders: true, products: true, inventory: true } } = {}) {
  const calls = [];
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url.startsWith(WORKER)) {
      const u = new URL(url);
      calls.push({ path: u.pathname, method: req.method() });
      if (u.pathname === '/ecom/client' && req.method() === 'GET') return route.fulfill({ json: { Id: 7, client_name: 'Kochi Looms', ecom_table_ids: JSON.stringify({ orders: 'o', products: 'p' }), ...(shopify ? { shopify_shop_domain: 'kochi.myshopify.com' } : {}) } });
      if (u.pathname === '/ecom/orders') return route.fulfill({ json: { list: ORDERS } });
      if (u.pathname === '/ecom/products') return route.fulfill({ json: { list: PRODUCTS } });
      if (u.pathname === '/ecom/shopify/status') return route.fulfill({ json: { connected: true, shop: 'kochi.myshopify.com', scopes } });
      if (u.pathname === '/ecom/shopify/orders') return route.fulfill({ json: { connected: true, list: SHOP_ORDERS } });
      if (u.pathname === '/ecom/shopify/stock') return route.fulfill({ json: { connected: true, list: SHOP_STOCK } });
      if (u.pathname === '/ecom/shopify/resync') return route.fulfill({ json: { ok: true, orders: 3, variants: 4 } });
      return route.fulfill({ json: { list: [] } });
    }
    return route.abort();
  });
  await page.goto(ecomUrl, { waitUntil: 'domcontentloaded' });
  return calls;
}

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('lands on Home with store KPIs, attention list and recent orders', async ({ page }) => {
    await boot(page);
    await expect(page.locator('#tabHome')).toHaveClass(/active/);
    await expect(page.locator('#homeGreeting')).toContainText('Kochi Looms');
    await expect(page.locator('#homeKpis .kpi').first()).toContainText('3,700'); // cancelled excluded
    await expect(page.locator('#homeAttention')).toContainText('1 order to fulfil');
    await expect(page.locator('#homeAttention')).toContainText('1 product out of stock');
    await expect(page.locator('#homeAttention')).toContainText('Shopify order');
    await expect(page.locator('#homeRecent .mini-row')).toHaveCount(3);
    await expect(page.locator('#homeChart rect')).toHaveCount(30);
    if (SHOT) await page.screenshot({ path: `${SHOT}/home.png`, fullPage: true });
  });

  test('Shopify Orders: views, search and the order drawer', async ({ page }) => {
    await boot(page);
    await page.locator('.tab[data-tab="shop-orders"]').click();
    await expect(page.locator('#shopOrdersTbody tr')).toHaveCount(3);
    await expect(page.locator('#navShopOrdersCount')).toHaveText('1');
    await page.locator('#shopOrderViews .view', { hasText: 'Unfulfilled' }).click();
    await expect(page.locator('#shopOrdersTbody tr')).toHaveCount(1);
    await page.locator('#shopOrderViews .view', { hasText: 'All' }).first().click();
    await page.locator('#shopOrderSearch').fill('delhivery');
    await expect(page.locator('#shopOrdersTbody')).toContainText('No orders match');
    await page.locator('#shopOrderSearch').fill('');
    await expect(page.locator('#shopOrdersTbody tr', { hasText: '#1002' }).locator('.pill').last()).toHaveText('Delivered');
    await expect(page.locator('#shopOrdersTbody tr', { hasText: '#1003' })).toContainText('Cancelled');
    await page.locator('#shopOrdersTbody tr', { hasText: '#1001' }).click();
    await expect(page.locator('#shopDrawer')).toHaveClass(/open/);
    await expect(page.locator('#sdBody')).toContainText('Kurta');
    await expect(page.locator('#sdBody')).toContainText('Kochi');
    await expect(page.locator('#sdBody a', { hasText: 'Open in Shopify' })).toHaveAttribute('href', 'https://kochi.myshopify.com/admin/orders/5001');
    if (SHOT) await page.screenshot({ path: `${SHOT}/shop-orders-drawer.png` });
    await page.keyboard.press('Escape');
    await expect(page.locator('#shopDrawer')).not.toHaveClass(/open/);
    if (SHOT) await page.screenshot({ path: `${SHOT}/shop-orders.png`, fullPage: true });
  });

  test('Shopify Stock: levels, low/out views, threshold and resync', async ({ page }) => {
    const calls = await boot(page);
    await page.locator('.tab[data-tab="shop-stock"]').click();
    await expect(page.locator('#shopStockTbody tr')).toHaveCount(4);
    await expect(page.locator('#navShopStockCount')).toHaveText('2');
    await page.locator('#shopStockViews .view', { hasText: 'Out of stock' }).click();
    await expect(page.locator('#shopStockTbody tr')).toHaveCount(1);
    await page.locator('#shopStockViews .view', { hasText: 'Low stock' }).click();
    await expect(page.locator('#shopStockTbody tr')).toHaveCount(1);
    await page.locator('#shopLowThreshold').fill('40');
    
    await expect(page.locator('#shopStockTbody tr')).toHaveCount(2);
    await page.locator('#shopStockViews .view', { hasText: 'All' }).first().click();
    await expect(page.locator('#shopStockTbody')).toContainText('2 locations');
    await expect(page.locator('#shopStockTbody')).toContainText('Not tracked');
    await page.locator('#shopResyncBtn2').click();
    await expect.poll(() => calls.some(c => c.path === '/ecom/shopify/resync' && c.method === 'POST')).toBe(true);
    await expect(page.locator('#shopResyncBtn2')).toContainText('3 orders');
    await page.locator('#shopLowThreshold').fill('5');
    
    if (SHOT) await page.screenshot({ path: `${SHOT}/shop-stock.png`, fullPage: true });
  });

  test('stores connected before stock sync are told to reconnect', async ({ page }) => {
    await boot(page, { scopes: { orders: true, products: false, inventory: false } });
    await page.locator('.tab[data-tab="shop-stock"]').click();
    await expect(page.locator('#shopStockBanner')).toContainText('Stock sync needs one more permission');
    await expect(page.locator('#shopStockLive')).toHaveText('Sync paused');
    await expect(page.locator('#shopOrdersBanner')).toBeEmpty();
  });

  test('without Shopify connected the Shopify modules stay hidden and are never fetched', async ({ page }) => {
    const calls = await boot(page, { shopify: false });
    await expect(page.locator('#tabHome')).toHaveClass(/active/);
    await expect(page.locator('.tab[data-tab="shop-orders"]')).toBeHidden();
    await expect(page.locator('.tab[data-tab="shop-stock"]')).toBeHidden();
    await expect(page.locator('.tab[data-tab="shopify"]')).toBeVisible();
    await expect(page.locator('#homeShopifyPanel')).toBeHidden();
    await page.waitForTimeout(300);
    expect(calls.some(c => c.path.startsWith('/ecom/shopify/'))).toBe(false);
  });
});

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('keeps the original tabs and Products landing, no Shopify module fetches', async ({ page }) => {
    const calls = await boot(page);
    await expect(page.locator('#tabProducts')).toHaveClass(/active/);
    await expect(page.locator('#tabHome')).not.toHaveClass(/active/);
    const visible = await page.locator('#tabs > *:visible').evaluateAll(els => els.map(e => e.dataset.tab));
    // The original tabs keep their order; 📲 WhatsApp Shop (a new feature, not a redesign) sits after Orders.
    expect(visible.slice(0, 8)).toEqual(['products', 'categories', 'promotions', 'testimonials', 'orders', 'washop', 'shopify', 'settings']);
    await expect(page.locator('#hdrStore')).toBeHidden();
    await page.waitForTimeout(300);
    expect(calls.some(c => c.path.startsWith('/ecom/shopify/'))).toBe(false);
  });
});

// The one Shopify page: Ecom → 🛍️ Shopify (connect via the Shopify app, switches, templates, log).
async function bootPage(page, { shopify = true, scopes = { orders: true, products: true, inventory: true }, query = '', notifyConfig = '' } = {}) {
  const calls = [];
  await page.addInitScript(() => { try { localStorage.setItem('lv_session', 'sess-token'); } catch (e) {} });
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url.startsWith(WORKER)) {
      const u = new URL(url);
      calls.push({ path: u.pathname, method: req.method(), body: req.postData(), auth: req.headers().authorization || '' });
      if (u.pathname === '/ecom/client' && req.method() === 'GET') return route.fulfill({ json: {
        Id: 7, client_name: 'Kochi Looms', ecom_table_ids: JSON.stringify({ orders: 'o', products: 'p' }),
        external_store_link: 'https://kochilooms.in', shopify_connected_at: '2026-10-01T10:00:00Z',
        shopify_notify_log: JSON.stringify([{ ts: '2026-10-20T10:00:00Z', event: 'received', order: '#1001', phone: '+9199', status: 'sent', detail: 'wamid' }]),
        ...(notifyConfig ? { shopify_notify_config: notifyConfig } : {}),
        ...(shopify ? { shopify_shop_domain: 'kochi.myshopify.com' } : {}),
      } });
      if (u.pathname === '/ecom/shopify/status') return route.fulfill({ json: { connected: true, shop: 'kochi.myshopify.com', scopes } });
      if (u.pathname === '/ecom/shopify/resync') return route.fulfill({ json: { ok: true, orders: 3, variants: 4, products: 2 } });
      if (u.pathname === '/shopify/oauth/start') return route.fulfill({ json: { ok: true, url: 'about:blank#shopify-authorize' } });
      if (u.pathname === '/ecom/products') return route.fulfill({ json: { list: [
        { Id: 1, name: 'Kurta', sku: 'K-M', price: 599, stock: 2, status: 'active', shopify_product_id: '1', shopify_product_url: 'https://kochi.myshopify.com/products/kurta' },
        { Id: 2, name: 'Hand-made bag', sku: 'B-1', price: 300, stock: 4, status: 'active' },
      ] } });
      return route.fulfill({ json: { list: [] } });
    }
    return route.abort();
  });
  await page.goto(ecomUrl + query, { waitUntil: 'domcontentloaded' });
  return calls;
}

test.describe('Shopify page', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('connected: status, switches, shared low-stock threshold and the log in one place', async ({ page }) => {
    const calls = await bootPage(page, { query: '&tab=shopify', notifyConfig: JSON.stringify({ config: {}, settings: { low_stock: 3 } }) });
    await expect(page.locator('#tabShopify')).toHaveClass(/active/);
    await expect(page.locator('#spShop')).toHaveText('kochi.myshopify.com');
    await expect(page.locator('#spScopes')).toHaveText('✓ Orders · ✓ Products · ✓ Inventory');
    await expect(page.locator('#spGrantBtn')).toBeHidden();
    await expect(page.locator('#spSetNotify')).toBeChecked();
    await expect(page.locator('#spSetLowStock')).toHaveValue('3');
    await expect(page.locator('#shopLowThreshold')).toHaveValue('3');
    await expect(page.locator('#spStoreLinkNote')).toContainText('https://kochilooms.in');
    await expect(page.locator('#spLogTbody')).toContainText('#1001');
    await expect(page.locator('#spTplBlocks .s-lbl')).toHaveCount(5);
    await page.locator('label:has(#spSetNotify)').click();
    await expect.poll(() => calls.filter(c => c.path === '/ecom/client' && c.method === 'PATCH').length).toBe(1);
    const saved = JSON.parse(JSON.parse(calls.find(c => c.method === 'PATCH').body).shopify_notify_config);
    expect(saved.settings).toEqual({ notify: false, low_stock: 3 });
    if (SHOT) await page.screenshot({ path: `${SHOT}/shopify-page.png`, fullPage: true });
  });

  test('missing permission: Grant access reconnects the same store, no disconnect', async ({ page }) => {
    const calls = await bootPage(page, { query: '&tab=shopify', scopes: { orders: true, products: false, inventory: false } });
    await expect(page.locator('#spBanner')).toContainText('One more permission needed');
    await expect(page.locator('#spGrantBtn')).toBeVisible();
    await page.locator('#spGrantBtn').click();
    await expect.poll(() => calls.find(c => c.path === '/shopify/oauth/start')).toBeTruthy();
    const start = calls.find(c => c.path === '/shopify/oauth/start');
    expect(JSON.parse(start.body)).toEqual({ shop: 'kochi.myshopify.com' });
    expect(start.auth).toBe('Bearer sess-token');
  });

  test('not connected: connect with the store name only', async ({ page }) => {
    const calls = await bootPage(page, { shopify: false, query: '&tab=shopify' });
    await expect(page.locator('#spNotConnected')).toBeVisible();
    await expect(page.locator('#spConfigured')).toBeHidden();
    await page.locator('#spDomain').fill('KochiLooms');
    await page.locator('#spConnectBtn').click();
    await expect.poll(() => calls.find(c => c.path === '/shopify/oauth/start')).toBeTruthy();
    expect(JSON.parse(calls.find(c => c.path === '/shopify/oauth/start').body)).toEqual({ shop: 'kochilooms.myshopify.com' });
  });

  test('back from Shopify: lands on the Shopify page and runs the first sync', async ({ page }) => {
    const calls = await bootPage(page, { query: '&embed=1&tab=shopify&shopify=connected' });
    await expect(page.locator('#tabShopify')).toHaveClass(/active/);
    await expect.poll(() => calls.some(c => c.path === '/ecom/shopify/resync' && c.method === 'POST')).toBe(true);
    await expect(page.locator('#shopResyncBtn3')).toContainText('2 products updated');
  });
});

test.describe('Shopify products in Products', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('synced products are marked and their Shopify fields are read-only', async ({ page }) => {
    await bootPage(page);
    await page.locator('.tab[data-tab="products"]').click();
    await expect(page.locator('#productsTbody tr', { hasText: 'Kurta' })).toContainText('🛍️ Shopify');
    await expect(page.locator('#productsTbody tr', { hasText: 'Hand-made bag' })).not.toContainText('🛍️ Shopify');
    await expect(page.locator('#productsTbody tr', { hasText: 'Kurta' }).locator('.stock-input')).toHaveJSProperty('readOnly', true);
    await page.locator('#productsTbody tr', { hasText: 'Kurta' }).locator('button[title="Edit product"]').click();
    await expect(page.locator('#pmShopifyUrl')).toHaveJSProperty('readOnly', true);
    await expect(page.locator('#pmShopifyUrlHint')).toContainText('Synced from Shopify');
  });
});
