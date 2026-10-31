// Live Agency → ⚙️ Travel Settings: one page with tabs for live fares & booking, currency, the
// WhatsApp menu and itineraries (worker /live-travel/travel-settings and the existing endpoints).
// Hermetic file:// load; the worker API is stubbed.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pageUrl = 'file://' + path.resolve(__dirname, '../live-travel-agency.html') + '?client=7&token=t';
const bootstrap = { suppliers: [], searches: [], quotes: [], bookings: [], service_requests: [], wallet: [], wallet_entries: [], agents: [], commissions: [], currency_settings: { default_currency: 'AED' }, supported_currencies: [] };

test('live fares & booking: load, preview the chosen style and save only those fields — fare settings load, preview the chosen style and save only the live-fare fields', async ({ page }) => {
  let saved = null;
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('file://')) return route.continue();
    if (url.endsWith('/live-travel/bootstrap')) return route.fulfill({ json: bootstrap });
    if (url.endsWith('/live-travel/travel-settings')) {
      if (route.request().method() === 'PUT') { saved = JSON.parse(route.request().postData() || '{}'); return route.fulfill({ json: { itin_share_pdf: true, itin_auto_images: true, ...saved } }); }
      return route.fulfill({ json: { itin_share_pdf: true, itin_auto_images: true, lt_show_fares: true, lt_fare_options: 2, lt_fare_style: 'classic', lt_online_booking: true } });
    }
    return route.abort();
  });
  await page.goto(pageUrl);
  await page.getByRole('button', { name: '⚙️ Travel Settings' }).click();
  await expect(page.locator('#fsBooking')).toHaveValue('1');

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
  await page.selectOption('#fsBooking', '0');
  await page.screenshot({ path: test.info().outputPath('settings.png') });
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('#fsMsg')).toContainText('Saved');
  expect(saved).toEqual({ lt_show_fares: true, lt_fare_options: 3, lt_fare_style: 'highlighted', lt_online_booking: false });
});

test('currency, WhatsApp menu and itineraries are tabs of the same page; the old menu items are gone', async ({ page }) => {
  let itin = null;
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('file://')) return route.continue();
    if (url.endsWith('/live-travel/bootstrap')) return route.fulfill({ json: { ...bootstrap, currency_settings: { default_currency: 'AED', fx_buffer_pct: 1.5, rounding: 'auto', allow_currency_override: 1, auto_detect_phone_currency: 1 }, supported_currencies: [{ code: 'AED', name: 'UAE Dirham' }], fx: { rates: [] } } });
    if (url.endsWith('/live-travel/whatsapp-menu')) return route.fulfill({ json: { menu: { enabled: false, items: [] }, defaults: { items: [] }, travel_flow: false, flights_connected: true, suggested_routes: [], categories: [], portal_counts: {}, portal_sources: [] } });
    if (url.endsWith('/live-travel/travel-settings')) {
      if (route.request().method() === 'PUT') { itin = JSON.parse(route.request().postData() || '{}'); return route.fulfill({ json: { itin_share_pdf: true, itin_auto_images: false } }); }
      return route.fulfill({ json: { itin_share_pdf: false, itin_auto_images: true, lt_show_fares: true, lt_fare_options: 3, lt_fare_style: 'classic', lt_online_booking: true } });
    }
    return route.abort();
  });
  await page.goto(pageUrl);
  await expect(page.locator('#nav')).not.toContainText('💱 Currency');
  await expect(page.locator('#nav')).not.toContainText('💬 WhatsApp Menu');
  await page.getByRole('button', { name: '⚙️ Travel Settings' }).click();
  await page.getByRole('button', { name: '💱 Currency' }).click();
  await expect(page.locator('#cxCur')).toBeVisible();
  await page.getByRole('button', { name: '💬 WhatsApp Menu' }).click();
  await expect(page.getByRole('heading', { name: 'WhatsApp Menu' })).toBeVisible();
  await expect(page.getByRole('button', { name: '✈️ Live fares & booking' })).toBeVisible();
  await page.getByRole('button', { name: '🗺️ Itineraries' }).click();
  await expect(page.locator('#itPdf')).toHaveValue('0');
  await page.selectOption('#itPdf', '1');
  await page.selectOption('#itImg', '0');
  await page.screenshot({ path: test.info().outputPath('itinerary.png') });
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('#itMsg')).toContainText('Saved');
  expect(itin).toEqual({ itin_share_pdf: true, itin_auto_images: false });
});
