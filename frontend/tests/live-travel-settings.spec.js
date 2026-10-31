// Live Agency → ⚙️ Settings: live-fare options for the WhatsApp bot (worker /live-travel/travel-settings).
// Hermetic file:// load; the worker API is stubbed.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pageUrl = 'file://' + path.resolve(__dirname, '../live-travel-agency.html') + '?client=7&token=t';
const bootstrap = { suppliers: [], searches: [], quotes: [], bookings: [], service_requests: [], wallet: [], wallet_entries: [], agents: [], commissions: [], currency_settings: { default_currency: 'AED' }, supported_currencies: [] };

test('fare settings load, preview the chosen style and save only the live-fare fields', async ({ page }) => {
  let saved = null;
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('file://')) return route.continue();
    if (url.endsWith('/live-travel/bootstrap')) return route.fulfill({ json: bootstrap });
    if (url.endsWith('/live-travel/travel-settings')) {
      if (route.request().method() === 'PUT') { saved = JSON.parse(route.request().postData() || '{}'); return route.fulfill({ json: { itin_share_pdf: true, itin_auto_images: true, ...saved } }); }
      return route.fulfill({ json: { itin_share_pdf: true, itin_auto_images: true, lt_show_fares: true, lt_fare_options: 2, lt_fare_style: 'classic' } });
    }
    return route.abort();
  });
  await page.goto(pageUrl);
  await page.getByRole('button', { name: '⚙️ Settings' }).click();

  await expect(page.locator('#fsCount')).toHaveValue('2');
  await expect(page.locator('#fsStyle')).toHaveValue('classic');
  await expect(page.locator('#fsPreview')).toContainText('Departs 21:45, arrives 00:25');
  await page.selectOption('#fsStyle', 'highlighted');
  await expect(page.locator('#fsPreview')).toContainText('🕗 21:45 → 00:25 (+1)');
  await expect(page.locator('#fsPreview')).toContainText('💰 Cheapest');
  await page.selectOption('#fsShow', '0');
  await expect(page.locator('#fsPreview')).not.toContainText('INR');
  await page.selectOption('#fsShow', '1');
  await page.selectOption('#fsCount', '3');
  await page.screenshot({ path: test.info().outputPath('settings.png') });
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('#fsMsg')).toContainText('Saved');
  expect(saved).toEqual({ lt_show_fares: true, lt_fare_options: 3, lt_fare_style: 'highlighted' });
});
