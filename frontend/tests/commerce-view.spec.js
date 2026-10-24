// Store workspace (frontend/commerce-view.js): on desktop, ecommerce clients get a store-admin
// sidebar and a commerce Home; Orders/Products/Shopify screens drive the embedded ecom.html.
// Phones keep the classic mobile app. Same hermetic file:// setup as travel-view.spec.js.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';
const SHOT = process.env.CV_SHOTS || '';

const day = (n) => { const d = new Date(Date.now() - n * 86400000); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const ORDERS = [
  { Id: 1, order_id: 'ORD-1', customer_name: 'Murshid', customer_phone: '919800000001', order_date: day(0), items: '2x Kurta', total: 1200, currency: 'INR', status: 'pending', taken_by: 'ai_bot' },
  { Id: 2, order_id: 'ORD-2', customer_name: 'Asha', customer_phone: '919800000002', order_date: day(2), items: '1x Saree', total: 2500, currency: 'INR', status: 'shipped', taken_by: 'store_page' },
  { Id: 3, order_id: 'ORD-3', customer_name: 'Asha', customer_phone: '919800000002', order_date: day(40), items: '1x Kurta', total: 600, currency: 'INR', status: 'delivered', taken_by: 'riya@shop.in' },
  { Id: 4, order_id: '#1001', customer_name: 'Zara', order_date: day(3), items: '1x Dupatta', total: 300, currency: 'INR', status: 'cancelled', shopify_order_id: '5001' },
  { Id: 5, order_id: 'ORD-5', customer_name: 'Nimmi', order_date: day(1), items: '1x Kurta', total: 0, status: 'draft' },
];
const PRODUCTS = [
  { Id: 1, name: 'Kurta', stock: 3, status: 'active' },
  { Id: 2, name: 'Saree', stock: 0, status: 'active' },
  { Id: 3, name: 'Dupatta', stock: 40, status: 'active' },
];

async function openStore(page, client, { pref } = {}) {
  const calls = [];
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('file://')) return route.continue();
    if (url.startsWith(WORKER)) {
      const u = new URL(url);
      calls.push(u.pathname + u.search);
      if (u.pathname === '/ecom/orders') return route.fulfill({ json: { list: ORDERS } });
      if (u.pathname === '/ecom/products') return route.fulfill({ json: { list: PRODUCTS } });
      if (u.pathname === '/shopify/analytics') return route.fulfill({ json: { total_checkouts: 5, completed_checkouts: 3 } });
      if (u.pathname === '/ecom/shopify/orders') return route.fulfill({ json: { list: [{ shopify_order_id: '5002', fulfillment_status: 'unfulfilled' }] } });
      if (u.pathname === '/ecom/client') return route.fulfill({ json: { Id: 7, ...client, ecom_table_ids: JSON.stringify({ orders: 'o', products: 'p' }) } });
      return route.fulfill({ json: { list: [] } });
    }
    return route.abort();
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ rec, today, pref }) => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    try { if (pref) localStorage.setItem('lv_commerce_view_7', pref); else localStorage.removeItem('lv_commerce_view_7'); } catch (e) {}
    // @ts-ignore
    clientId = 7; clientRecord = rec; sessionToken = 't'; myEmail = '';
    // @ts-ignore
    allLeads = [
      { Id: 1, Name: 'Murshid', Phone: '919800000001', Date: today, Stage: 'new' },
      { Id: 2, Name: 'Ravi', Phone: '919800000009', Date: today, Stage: 'human_handover', Handover: 'Yes' },
    ];
    // @ts-ignore
    applyTheme(rec.industry);
    // @ts-ignore
    navigate('home');
  }, { rec: client, today: day(0), pref });
  return calls;
}

test.describe('store workspace (desktop)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('ecommerce client gets the store sidebar and one Home with the store dashboard on top', async ({ page }) => {
    await openStore(page, { industry: 'ecommerce', ecom_enabled: 'Yes', client_name: 'Kochi Looms' });
    await expect(page.locator('#commerceSide')).toBeVisible();
    await expect(page.locator('#desktopNav')).toBeHidden();
    await expect(page.locator('#commerceSide .cv-item.active')).toHaveAttribute('data-cv-page', 'home');
    // Everyday items are always on screen; the rest sit in collapsible groups.
    for (const label of ['Home', 'Orders', 'Products', 'Customers', 'Chats', 'Needs a human']) {
      await expect(page.locator('#commerceSide .cv-scroll > .cv-item', { hasText: label }).first()).toBeVisible();
    }
    await expect(page.locator('#commerceSide .cv-item[data-cv-page="broadcast"]')).toBeHidden();
    await page.locator('#commerceSide .cv-grp-h[aria-label="Marketing"]').click();
    await expect(page.locator('#commerceSide .cv-item[data-cv-page="broadcast"]')).toBeVisible();
    // No separate "CRM overview" any more — it's part of Home.
    await expect(page.locator('#commerceSide')).not.toContainText('CRM overview');
    await expect(page.locator('#commerceSide')).not.toContainText('Shopify orders');
    // The Shopify page is where a store gets connected, so it's listed even before connecting.
    await expect(page.locator('#commerceSide .cv-item[data-cv-page="cvshopify"]')).toContainText('Connect Shopify');

    // One Home: store greeting + quick actions on top, CRM blocks (Getting Started etc.) still there,
    // and the old CRM hero hidden.
    await expect(page.locator('#pageHome')).toBeVisible();
    await expect(page.locator('#cvHomeTop')).toContainText('Kochi Looms');
    await expect(page.locator('#cvHomeTop')).toContainText('₹3,700');
    await expect(page.locator('#cvHomeTop .cv-qa')).toContainText('Add a product');
    await expect(page.locator('#pageHome .home-hero')).toBeHidden();
    await expect(page.locator('#homeActivityCard')).toBeVisible();
    const home = page.locator('#cvHomeBody');
    // Last 30 days: ORD-1 + ORD-2 count; cancelled, draft and the 40-day-old order don't.
    await expect(home.locator('.cv-kpi', { hasText: 'Total sales' }).locator('.cv-kpi-v')).toHaveText('₹3,700');
    await expect(home.locator('.cv-kpi', { hasText: /^Orders/ }).locator('.cv-kpi-v')).toHaveText('2');
    await expect(home.locator('.cv-kpi', { hasText: 'Chats that ordered' }).locator('.cv-kpi-v')).toHaveText('100%');
    await expect(home.locator('.cv-kpi', { hasText: 'Returning customers' }).locator('.cv-kpi-v')).toHaveText('50%');
    await expect(home.locator('.cv-todo')).toContainText('1 order to pack & ship');
    await expect(home.locator('.cv-todo')).toContainText('1 customer is still ordering in WhatsApp');
    await expect(home.locator('.cv-todo')).toContainText('1 customer waiting for a person');
    await expect(home.locator('.cv-todo')).toContainText('1 product out of stock');
    await expect(home).toContainText('WhatsApp AI bot');
    await expect(home).toContainText('Store page');
    await expect(home.locator('.cv-banner')).toContainText('Connect your store');
    await expect(page.locator('#commerceSide [data-cv-count="orders"]')).toHaveText('1');
    if (SHOT) await page.screenshot({ path: `${SHOT}/cv-home.png`, fullPage: false });
  });

  test('Add a product tile opens Products with the add form open', async ({ page }) => {
    await openStore(page, { industry: 'ecommerce', ecom_enabled: 'Yes' });
    await page.locator('#cvHomeTop .cv-qa button', { hasText: 'Add a product' }).click();
    await expect(page.locator('#pageEcommerce')).toBeVisible();
    expect(await page.locator('#ecommerceFrame').getAttribute('src')).toContain('action=new');
    await expect(page.frameLocator('#ecommerceFrame').locator('#productModalOverlay')).toHaveClass(/active/);
    await expect(page.locator('#commerceSide .cv-item[data-cv-page="cvcategories"]')).toBeVisible();
  });

  test('Settings shows its sections as tabs, not a second sidebar', async ({ page }) => {
    await openStore(page, { industry: 'ecommerce', ecom_enabled: 'Yes' });
    await page.locator('#commerceSide .cv-grp-h[aria-label="Settings"]').click();
    await page.locator('#commerceSide .cv-item[data-cv-page="settings"]').click();
    await expect(page.locator('#commerceSide .cv-item.active')).toHaveAttribute('data-cv-page', 'settings');
    const dir = await page.locator('#pageSettings').evaluate(el => getComputedStyle(el).flexDirection);
    expect(dir).toBe('column');
    if (SHOT) await page.screenshot({ path: `${SHOT}/cv-settings.png` });
  });

  test('Orders / Products open ecom.html in shell mode on the right screen', async ({ page }) => {
    await openStore(page, { industry: 'ecommerce', ecom_enabled: 'Yes' });
    await page.locator('#commerceSide .cv-item[data-cv-page="cvorders"]').click();
    await expect(page.locator('#pageEcommerce')).toBeVisible();
    const src = await page.locator('#ecommerceFrame').getAttribute('src');
    expect(src).toContain('shell=commerce');
    expect(src).toContain('tab=orders');
    const frame = page.frameLocator('#ecommerceFrame');
    await expect(frame.locator('#tabOrders')).toHaveClass(/active/);
    await expect(frame.locator('#tabs')).toBeHidden();
    await expect(page.locator('#commerceSide .cv-item.active')).toHaveAttribute('data-cv-page', 'cvorders');
    await page.locator('#commerceSide .cv-item[data-cv-page="cvproducts"]').click();
    await expect(frame.locator('#tabProducts')).toHaveClass(/active/);
    await expect(page.locator('#commerceSide .cv-item.active')).toHaveAttribute('data-cv-page', 'cvproducts');
    if (SHOT) await page.screenshot({ path: `${SHOT}/cv-products.png` });
    await page.locator('#commerceSide .cv-item[data-cv-page="leads"]').click();
    await expect(page.locator('#pageLeads')).toBeVisible();
  });

  test('Shopify entries and stats appear once Shopify is connected', async ({ page }) => {
    await openStore(page, { industry: 'ecommerce', ecom_enabled: 'Yes', shopify_shop_domain: 'kochi.myshopify.com' });
    await expect(page.locator('#commerceSide')).toContainText('Shopify orders');
    await expect(page.locator('#commerceSide')).toContainText('kochi.myshopify.com');
    await expect(page.locator('#cvHomeBody .cv-todo')).toContainText('1 Shopify order unfulfilled');
    await expect(page.locator('#cvHomeBody .cv-todo')).toContainText('2 left their Shopify cart');
    await expect(page.locator('#cvHomeBody .cv-banner')).toHaveCount(0);
    await expect(page.locator('#commerceSide .cv-item[data-cv-page="cvshopify"]')).toContainText('Shopify settings');
    await page.locator('#commerceSide .cv-grp-h[aria-label="Shopify"]').click();
    await page.locator('#commerceSide .cv-item[data-cv-page="cvshopstock"]').click();
    expect(await page.locator('#ecommerceFrame').getAttribute('src')).toContain('tab=shop-stock');
  });

  test('switching to classic restores the regular nav and back', async ({ page }) => {
    await openStore(page, { industry: 'ecommerce', ecom_enabled: 'Yes' });
    await page.locator('#commerceSide .cv-item[data-cv-page="__classic"]').click();
    await expect(page.locator('#commerceSide')).toBeHidden();
    await expect(page.locator('#desktopNav')).toBeVisible();
    await expect(page.locator('#pageHome')).toBeVisible();
    await page.locator('#dnCvSwitch').click();
    await expect(page.locator('#commerceSide')).toBeVisible();
    await expect(page.locator('#cvHomeTop')).toBeVisible();
  });

  test('other industries keep the classic dashboard', async ({ page }) => {
    await openStore(page, { industry: 'healthcare' });
    await expect(page.locator('#desktopNav')).toBeVisible();
    await expect(page.locator('#commerceSide')).toBeHidden();
    await expect(page.locator('#dnCvSwitch')).toBeHidden();
  });
});

test.describe('store workspace (phone)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('phones keep the classic mobile app', async ({ page }) => {
    const calls = await openStore(page, { industry: 'ecommerce', ecom_enabled: 'Yes' });
    await expect(page.locator('#pageHome')).toBeVisible();
    await expect(page.locator('#bottomNav')).toBeVisible();
    await expect(page.locator('#commerceSide')).toBeHidden();
    await expect(page.locator('html')).not.toHaveClass(/cv-mode/);
    await page.waitForTimeout(300);
    expect(calls.some(c => c.startsWith('/ecom/'))).toBe(false);
  });
});
