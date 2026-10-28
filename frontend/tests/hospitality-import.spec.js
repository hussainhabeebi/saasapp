// Hospitality → API Import sub-tab (🏨 Hospitality → 🔗 API Import, frontend/hospitality-import.js).
// Same hermetic file:// setup as hospitality-pro.spec.js — /hospitality/* is answered by
// page.route stubs, everything else off-origin is blocked.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';

const SAVED = { id: 3, name: 'GoSanchari', url: 'https://gosanchari.com/api/v1/properties', auth_style: 'bearer', key_hint: 'k1se…tkey', has_key: true,
  sync_enabled: 1, sync_minutes: 60, last_sync_at: new Date().toISOString(), last_status: 'ok', last_error: '', last_summary: '2 properties added, 3 units added', properties: 2, units: 3 };

async function openImport(page) {
  const calls = [];
  let sources = [];
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url.startsWith(WORKER + '/hospitality/')) {
      const p = new URL(url).pathname;
      const body = req.postData() ? JSON.parse(req.postData()) : null;
      calls.push({ path: p, method: req.method(), body });
      if (p === '/hospitality/units' || p === '/hospitality/bookings' || p === '/hospitality/properties') return route.fulfill({ json: { list: [] } });
      if (p === '/hospitality/stats') return route.fulfill({ json: { total_units: 0, occupancy_rate: 0, revenue_this_month: 0, upcoming_check_ins: [], upcoming_check_outs: [] } });
      if (p === '/hospitality/import/sources' && req.method() === 'GET') return route.fulfill({ json: { list: sources, sync_minutes: [15, 30, 60, 180, 360, 720, 1440] } });
      if (p === '/hospitality/import/test') return route.fulfill({ json: { ok: true, found: 2, skipped: 0, sample: [
        { name: 'Tea Valley Resort', location: 'Munnar', photos: 2, units: [{ name: 'Deluxe Room', base_rate: 4500, currency: 'INR', capacity_adults: 2 }] }] } });
      if (p === '/hospitality/import/sources' && req.method() === 'POST') { sources = [SAVED]; return route.fulfill({ json: { source: SAVED, result: { ok: true, summary: '2 properties added, 3 units added' } } }); }
      if (p === '/hospitality/import/sources' && req.method() === 'PATCH') return route.fulfill({ json: { source: { ...SAVED, ...body } } });
      if (p === '/hospitality/import/sync') return route.fulfill({ json: { source: SAVED, result: { ok: true, summary: 'No changes' } } });
    }
    return route.abort();
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    document.getElementById('pageHospitality').classList.remove('hidden');
    // @ts-ignore
    clientId = 7; clientRecord = { Id: 7, hospitality_enabled: 'Yes', hospitality_style: 'resort' }; sessionToken = 't';
    // @ts-ignore
    renderHospitality();
  });
  return calls;
}

test('test a link, import it, then change its sync interval and sync now', async ({ page }) => {
  const calls = await openImport(page);
  await page.locator('.hosp-tab[data-hosp="import"]').click();
  await expect(page.locator('#hiAddCard')).toBeVisible();

  await page.locator('#hiUrl').fill('https://gosanchari.com/api/v1/properties');
  await page.locator('#hiKey').fill('k1secretkey');
  await page.locator('#hiTestBtn').click();
  await expect(page.locator('#hiPreview')).toContainText('Found 2 properties');
  await expect(page.locator('#hiPreview')).toContainText('Deluxe Room (INR 4,500, 2 adults)');
  expect(calls.find((c) => c.path === '/hospitality/import/test').body).toMatchObject({ url: 'https://gosanchari.com/api/v1/properties', api_key: 'k1secretkey', auth_style: 'bearer' });

  await page.locator('#hiAddBtn').click();
  const card = page.locator('[data-hi-source="3"]');
  await expect(card).toContainText('GoSanchari');
  await expect(card).toContainText('2 properties added, 3 units added');
  await expect(card).toContainText('k1se…tkey');

  await card.locator('[data-hi-every]').selectOption('30');
  await expect.poll(() => calls.find((c) => c.path === '/hospitality/import/sources' && c.method === 'PATCH')?.body).toEqual({ id: 3, sync_minutes: 30 });

  await card.locator('[data-hi-sync]').click();
  await expect.poll(() => calls.some((c) => c.path === '/hospitality/import/sync')).toBe(true);
});
