// Agency → Itineraries: the detailed builder (trip facts, per-day details, adult/child rates) and
// child rates on Send Quotation. Hermetic file:// load with every network request blocked; the
// builder, PDF and line-item functions are driven directly since there's no NocoDB behind them.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pageUrl = 'file://' + path.resolve(__dirname, '../travel-agency.html') + '?client=7&token=t';

async function open(page) {
  await page.route('**/*', (route) => (route.request().url().startsWith('file://') ? route.continue() : route.abort()));
  await page.goto(pageUrl);
  await page.waitForFunction(() => typeof openItinModal === 'function');
}

test('builder keeps per-day details and shows the adult + child total', async ({ page }) => {
  await open(page);
  await page.evaluate(() => openItinModal(null, {
    title: 'Hyderabad Bus Package', from_date: '2026-11-14', currency: 'INR',
    adults: 2, children: 1, adult_price: 15000, child_price: 9000,
    days: [{ day_no: 1, title: 'Arrival', items: [] }, { day_no: 2, title: 'City tour', items: [] }],
  }));
  await expect(page.locator('#itinRateTotal')).toHaveText('Estimated total: 2 × Adult @ INR 15,000 + 1 × Child (with bed) @ INR 9,000 = INR 39,000');
  await expect(page.locator('#itinDaysList')).toContainText('Sat, 14 Nov 2026');
  await page.locator('#itinDaysList textarea').first().fill('Reach Hyderabad, check in.');
  await page.locator('#itinDaysList input[placeholder^="Overnight"]').first().fill('Hotel Sitara');
  await page.locator('#itinDaysList label:has-text("Breakfast") input').first().check();
  await page.getByTitle('Move down').first().click();
  const days = await page.evaluate(() => _itinDays);
  expect(days.map((d) => [d.day_no, d.title])).toEqual([[1, 'City tour'], [2, 'Arrival']]);
  expect(days[1]).toMatchObject({ description: 'Reach Hyderabad, check in.', overnight: 'Hotel Sitara', meals: ['B'] });
});

test('quotation line items add child and infant rows after the adult row', async ({ page }) => {
  await open(page);
  const { rows, subtotal } = await page.evaluate(() => sqBuildLineItems(
    { type: 'package', rec: { name: 'HYDERABAD BUSS PACKAGE', inclusions: '[]' } }, 'package', 15000, 'INR', 2,
    [{ label: 'Child (with bed)', price: 9000, count: 1 }, { label: 'Infant', price: 2000, count: 1 }]));
  expect(rows.map((r) => [r.desc, r.persons, r.total])).toEqual([
    ['HYDERABAD BUSS PACKAGE — Adult', 2, 30000],
    ['HYDERABAD BUSS PACKAGE — Child (with bed)', 1, 9000],
    ['HYDERABAD BUSS PACKAGE — Infant', 1, 2000],
  ]);
  expect(subtotal).toBe(41000);
});

test('full itinerary PDF renders the detailed trip with its price table', async ({ page }) => {
  await open(page);
  const pages = await page.evaluate(async () => {
    clientRecord = { client_name: 'Test Travels' };
    await loadJsPdf();
    const it = {
      title: 'Hyderabad Bus Package', destination: 'Hyderabad', from_date: '2026-11-14', to_date: '2026-11-16', nights: 2,
      departure_city: 'Kozhikode', hotel_category: '3 Star', meal_plan: 'Breakfast (CP)', transport: 'AC bus',
      adults: 2, children: 1, currency: 'INR', adult_price: 15000, child_price: 9000,
      inclusions: '["Hotel","Breakfast"]', exclusions: '["Entry tickets"]',
      days: [{ day_no: 1, title: 'Arrival', description: 'Reach Hyderabad.', meals: ['B'], overnight: 'Hotel Sitara',
        items: [{ type: 'activity', time: '16:00', description: 'Charminar' }] }],
    };
    return itinBuildFullPdfDoc({ Name: 'Test' }, it, 'ITN-0001').getNumberOfPages();
  });
  expect(pages).toBeGreaterThan(0);
});
