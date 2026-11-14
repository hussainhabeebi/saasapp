// Live Agency → Suppliers → Custom API connector: the card's fields and what Save sends.
// Hermetic file:// load; the worker API is stubbed.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pageUrl = 'file://' + path.resolve(__dirname, '../live-travel-agency.html') + '?client=7&token=t';

const custom = { supplier: 'custom', enabled: 0, mode: 'sandbox', priority: 50, markup_type: 'fixed', markup_value: 0, endpoints: {}, credentials_configured: false, credential_fields: [] };
const bootstrap = {
  suppliers: [{ supplier: 'poomas', enabled: 1, mode: 'production', priority: 40, markup_type: 'fixed', markup_value: 0, endpoints: {}, credentials_configured: true, credential_fields: [] }, custom],
  poomas_settings: { enabled: true, api_base: 'https://api.flypoomas.com', checkout_base: 'https://flypoomas.com' },
  searches: [], quotes: [], bookings: [], service_requests: [], wallet: [], wallet_entries: [], agents: [], commissions: [],
  currency_settings: { default_currency: 'AED', allow_currency_override: 1 },
  supported_currencies: [{ code: 'AED', name: 'UAE Dirham' }, { code: 'INR', name: 'Indian Rupee' }, { code: 'USD', name: 'US Dollar' }],
};

test('the Custom API card saves the key, endpoints, checkout links and default currency', async ({ page }) => {
  let saved = null;
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('file://')) return route.continue();
    if (url.endsWith('/live-travel/bootstrap')) {
      const suppliers = saved ? bootstrap.suppliers.map((s) => s.supplier === 'custom' ? { ...s, enabled: 1, endpoints: saved.endpoints, credentials_configured: true, credential_fields: ['api_key'] } : s) : bootstrap.suppliers;
      return route.fulfill({ json: { ...bootstrap, suppliers } });
    }
    if (url.endsWith('/live-travel/suppliers')) { saved = JSON.parse(route.request().postData() || '{}'); return route.fulfill({ json: {} }); }
    return route.abort();
  });
  await page.goto(pageUrl);
  await page.getByRole('button', { name: '🔌 Suppliers' }).click();

  await expect(page.getByText('Save the API key, search endpoint and checkout link to activate')).toBeVisible();
  await page.fill('#cname-custom', 'TripCod');
  await page.fill('#skey-custom', 'pmsk_live_123');
  await page.fill('#search-custom', 'https://api.tripcod.com/api/search');
  await page.fill('#checkout-custom', 'https://tripcod.com');
  await page.fill('#checkout_session-custom', 'https://api.tripcod.com/api/checkout/session');
  await page.selectOption('#ccur-custom', 'INR');
  await page.selectOption('#sen-custom', '1');
  await page.locator('#cname-custom').scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('custom-api-card.png'), fullPage: false });
  await page.locator('#cname-custom').locator('xpath=ancestor::div[contains(@class,"card")][1]').getByRole('button', { name: 'Save settings' }).click();

  await expect.poll(() => saved).not.toBeNull();
  expect(saved.supplier).toBe('custom');
  expect(saved.enabled).toBe(true);
  expect(saved.credentials.api_key).toBe('pmsk_live_123');
  expect(saved.endpoints).toMatchObject({ name: 'TripCod', search: 'https://api.tripcod.com/api/search', checkout: 'https://tripcod.com', checkout_session: 'https://api.tripcod.com/api/checkout/session', currency: 'INR' });
  expect(saved.markup_value).toBe('0');
  // After saving, the card shows the connector's own name and that it is ready.
  await expect(page.getByRole('heading', { name: 'TripCod' })).toBeVisible();
  await expect(page.getByText('API key and links saved — ready to enable')).toBeVisible();
});
