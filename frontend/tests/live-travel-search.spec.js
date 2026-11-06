// Live Agency → Flight Search (frontend/live-travel-agency.html): airport picker, quick buttons,
// browser-side validation and remembered routes. Hermetic file:// load; the worker API is stubbed.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pageUrl = 'file://' + path.resolve(__dirname, '../live-travel-agency.html') + '?client=7&token=t';

function iso(offsetDays) {
  const d = new Date(); d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const bootstrap = {
  suppliers: [], searches: [
    { origin: 'SHJ', destination: 'CCJ', trip_type: 'one_way', departure_date: iso(-3), cabin: 'economy', adults: 2, children: 0, infants: 0, created_at: '2026-10-10T10:00:00Z' },
    { origin: 'SHJ', destination: 'COK', trip_type: 'round_trip', departure_date: iso(5), return_date: iso(12), cabin: 'economy', adults: 1, children: 0, infants: 0, created_at: '2026-10-09T10:00:00Z' },
  ],
  quotes: [], bookings: [], service_requests: [], wallet: [], wallet_entries: [], agents: [], commissions: [],
  currency_settings: { default_currency: 'AED', allow_currency_override: 1 }, supported_currencies: [],
};

async function openSearch(page, onSearch) {
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('file://')) return route.continue();
    if (url.endsWith('/live-travel/bootstrap')) return route.fulfill({ json: bootstrap });
    if (url.endsWith('/live-travel/search')) { onSearch?.(JSON.parse(route.request().postData() || '{}')); return route.fulfill({ json: { offers: [] } }); }
    return route.abort();
  });
  await page.goto(pageUrl);
  await page.getByRole('button', { name: '🔎 Flight Search' }).click();
}

test('typing a city suggests airports and resolves to the IATA code', async ({ page }) => {
  let sent;
  await openSearch(page, (b) => { sent = b; });
  // Most-used origin from the agency's history is pre-filled.
  await expect(page.locator('#origin')).toHaveValue('SHJ');
  await page.locator('#destination').fill('calic');
  await expect(page.locator('#destinationList .apopt').first()).toContainText('CCJ');
  await page.locator('#destination').press('Enter');
  await expect(page.locator('#destination')).toHaveValue('CCJ');
  await expect(page.locator('#destinationHint')).toContainText('Calicut International');
  await page.locator('#tripType').selectOption('one_way');
  await page.getByRole('button', { name: 'Tomorrow' }).click();
  await page.getByRole('button', { name: '🔎 Search live fares' }).click();
  await expect.poll(() => sent).toMatchObject({ origin: 'SHJ', destination: 'CCJ', departure_date: iso(1) });
});

test('city names typed without picking are converted, not truncated', async ({ page }) => {
  let sent;
  await openSearch(page, (b) => { sent = b; });
  await page.locator('#origin').fill('Dubai International');
  await page.locator('#destination').fill('kochi');
  await page.locator('#tripType').selectOption('one_way');
  await page.locator('#departure').fill(iso(4));
  await page.getByRole('button', { name: '🔎 Search live fares' }).click();
  await expect.poll(() => sent).toMatchObject({ origin: 'DXB', destination: 'COK' });
});

test('blocks same airport, ambiguous cities and bad dates before searching', async ({ page }) => {
  let calls = 0;
  await openSearch(page, () => { calls++; });
  await page.locator('#tripType').selectOption('one_way');
  await page.locator('#departure').fill(iso(4));
  await page.locator('#destination').fill('SHJ');
  await page.getByRole('button', { name: '🔎 Search live fares' }).click();
  await expect(page.locator('#searchErr')).toContainText('same airport');
  await page.locator('#destination').fill('London');
  await page.getByRole('button', { name: '🔎 Search live fares' }).click();
  await expect(page.locator('#searchErr')).toContainText('several airports match');
  await page.locator('#destination').fill('LHR');
  await page.locator('#tripType').selectOption('round_trip');
  await page.locator('#returnDate').fill(iso(2));
  await page.getByRole('button', { name: '🔎 Search live fares' }).click();
  await expect(page.locator('#searchErr')).toContainText('before the departure');
  expect(calls).toBe(0);
});

test('swap, recent routes, saved routes and the form draft are remembered', async ({ page }) => {
  await openSearch(page);
  await expect(page.locator('#routeChips')).toContainText('SHJ → CCJ');
  await page.getByRole('button', { name: 'SHJ → COK' }).click();
  await page.getByRole('button', { name: '⇄ Swap' }).click();
  await expect(page.locator('#origin')).toHaveValue('COK');
  await expect(page.locator('#destination')).toHaveValue('SHJ');
  await page.locator('#favBtn').click();
  await expect(page.locator('#favBtn')).toHaveText('★ Saved route');
  await page.getByRole('button', { name: 'More Adults' }).click();
  await page.getByRole('button', { name: '📊 Dashboard' }).click();
  await page.getByRole('button', { name: '🔎 Flight Search' }).click();
  await expect(page.locator('#origin')).toHaveValue('COK');
  await expect(page.locator('#adults')).toHaveValue('2');
  await expect(page.locator('#routeChips')).toContainText('★ COK → SHJ');
});

test('repeat last search refills the route but drops a past date', async ({ page }) => {
  await openSearch(page);
  await page.getByRole('button', { name: '🔁 Repeat last search' }).click();
  await expect(page.locator('#destination')).toHaveValue('CCJ');
  await expect(page.locator('#adults')).toHaveValue('2');
  await expect(page.locator('#departure')).toHaveValue('');
  await expect(page.locator('#searchErr')).toContainText('date that has passed');
});
