// Live Agency → 💬 WhatsApp Menu (frontend/live-travel-agency.html): edit the per-agency menu,
// see it in the phone preview, save it. Hermetic file:// load; the worker API is stubbed.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pageUrl = 'file://' + path.resolve(__dirname, '../live-travel-agency.html') + '?client=7&token=t';
const items = [
  { id: 'flights', emoji: '✈️', title: 'Flight Tickets', description: 'Live fares', section: 'Book', action: 'flight_search', category: 'Air Ticket', message: '', url: '', button_text: '', enabled: true },
  { id: 'visa', emoji: '🛂', title: 'Visa Services', description: 'Visit visas', section: 'Documents', action: 'ask', category: 'Visa', message: 'Which country?', url: '', button_text: '', enabled: true },
  { id: 'agent', emoji: '👤', title: 'Talk to an Agent', description: '', section: 'Help', action: 'handover', category: '', message: '', url: '', button_text: '', enabled: true },
];
const menuResponse = {
  menu: { enabled: false, greeting: '', button_label: 'Menu', popular_routes: [], items },
  defaults: { enabled: false, greeting: '', button_label: 'Menu', popular_routes: [], items },
  flights_connected: true, suggested_routes: [['SHJ', 'CCJ']], categories: ['Air Ticket', 'Visa', 'Package'],
};
const bootstrap = { suppliers: [], searches: [], quotes: [], bookings: [], service_requests: [], wallet: [], wallet_entries: [], agents: [], commissions: [], currency_settings: { default_currency: 'AED' } };

test('agency edits, previews and saves its WhatsApp menu', async ({ page }) => {
  let saved = null;
  await page.route('**/*', async (route) => {
    const req = route.request(), url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url.endsWith('/live-travel/bootstrap')) return route.fulfill({ json: bootstrap });
    if (url.endsWith('/live-travel/whatsapp-menu') && req.method() === 'GET') return route.fulfill({ json: menuResponse });
    if (url.endsWith('/live-travel/whatsapp-menu') && req.method() === 'PUT') { saved = JSON.parse(req.postData()).menu; return route.fulfill({ json: { menu: saved, saved_at: 'now' } }); }
    return route.abort();
  });
  await page.goto(pageUrl);
  await page.getByRole('button', { name: '💬 WhatsApp Menu' }).click();
  const preview = page.locator('#wmPreview');
  await expect(preview).toContainText('✈️ Flight Tickets');
  await expect(preview).toContainText('Documents');
  await expect(page.locator('.badge').filter({ hasText: '/ 10 on' })).toHaveText('3 / 10 on');

  await page.getByText('Send this menu on WhatsApp').click();
  await page.locator('.wmtitle').nth(1).fill('Visa');
  await expect(preview).toContainText('🛂 Visa');
  await page.getByRole('button', { name: '＋ Add option' }).click();
  await page.locator('.wmtitle').nth(3).fill('Packages');
  await page.locator('.wmitem').nth(3).locator('select').selectOption('link');
  await page.locator('.wmitem').nth(3).getByPlaceholder('https://youragency.com/packages').fill('https://agency.test/packages');
  await page.getByRole('button', { name: '＋ SHJ → CCJ' }).click();
  await expect(page.locator('#wmRoutes')).toHaveValue('SHJ-CCJ');
  await page.getByRole('button', { name: '💾 Save menu' }).click();
  await expect(page.locator('#wmErr')).toContainText('customers get this menu on WhatsApp now');
  expect(saved.enabled).toBe(true);
  expect(saved.items.map(i => i.title)).toEqual(['Flight Tickets', 'Visa', 'Talk to an Agent', 'Packages']);
  expect(saved.items[3]).toMatchObject({ action: 'link', url: 'https://agency.test/packages' });
  expect(saved.popular_routes).toEqual([['SHJ', 'CCJ']]);
});
