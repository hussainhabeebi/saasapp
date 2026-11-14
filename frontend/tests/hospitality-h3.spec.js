// Hospitality style H3 → Properties tab: Location column with location type-ahead and a location
// filter. Resort keeps its table exactly as before (no Location column). Same hermetic file://
// setup as hospitality-import.spec.js.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';

const PROPS = [
  { id: 1, name: 'Aadhisakthi Resort', location: 'Munnar, Kerala', amenities: 'Pool, Wi-Fi', description: '', active: 1 },
  { id: 2, name: 'Bay View Suites', location: 'Munnar', amenities: '', description: '', active: 1 },
  { id: 3, name: 'Calinz Thekkady', location: 'Thekkady', amenities: '', description: '', active: 1 },
  { id: 4, name: 'Cinnamon Stay', location: '', amenities: '', description: '', active: 1 },
];

async function openProperties(page, style) {
  const calls = [];
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url.startsWith(WORKER + '/hospitality/')) {
      const p = new URL(url).pathname;
      const body = req.postData() ? JSON.parse(req.postData()) : null;
      calls.push({ path: p, method: req.method(), body });
      if (p === '/hospitality/properties' && req.method() === 'GET') return route.fulfill({ json: { list: PROPS.map((x) => ({ ...x, Id: x.id })) } });
      if (p === '/hospitality/properties' && req.method() === 'POST') return route.fulfill({ json: { Id: 9, name: 'New property', location: body.location || '', active: 1 } });
      if (p === '/hospitality/properties') return route.fulfill({ json: { ok: true } });
      if (p === '/hospitality/units' || p === '/hospitality/bookings') return route.fulfill({ json: { list: [] } });
      if (p === '/hospitality/stats') return route.fulfill({ json: { total_units: 0, occupancy_rate: 0, revenue_this_month: 0, upcoming_check_ins: [], upcoming_check_outs: [] } });
      return route.fulfill({ json: {} });
    }
    return route.abort();
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate((s) => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    document.getElementById('pageHospitality').classList.remove('hidden');
    // @ts-ignore
    clientId = 7; clientRecord = { Id: 7, hospitality_enabled: 'Yes', hospitality_style: s }; sessionToken = 't';
    // @ts-ignore
    renderHospitality();
  }, style);
  await page.locator('#hospPropertiesTab').click();
  await expect(page.locator('tr[data-prop-row]')).toHaveCount(4);
  return calls;
}

test('H3: Location column, location filter and saving a location', async ({ page }) => {
  const calls = await openProperties(page, 'h3');
  await expect(page.locator('#hospContent thead')).toContainText('Location');
  await expect(page.locator('#hospContent')).toContainText('1 property has no location');
  const datalist = await page.locator('#hospLocList option').evaluateAll((o) => o.map((x) => x.value));
  expect(datalist).toEqual(['Munnar', 'Thekkady']);

  const filter = page.locator('#hospContent select[title="Filter by location"]');
  await filter.selectOption('munnar');
  await expect(page.locator('tr[data-prop-row]')).toHaveCount(2);
  await filter.selectOption('__none');
  await expect(page.locator('tr[data-prop-row]')).toHaveCount(1);
  await filter.selectOption('');

  const loc = page.locator('tr[data-prop-row="4"] input[data-field="location"]');
  await loc.fill('Vagamon');
  await loc.blur();
  await expect.poll(() => calls.find((c) => c.method === 'PATCH' && c.body?.location === 'Vagamon')?.body).toEqual({ id: 4, location: 'Vagamon' });

  // Adding while filtered to a location pre-fills that location.
  await filter.selectOption('thekkady');
  await page.getByRole('button', { name: '+ Add Property' }).click();
  await expect.poll(() => calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'New property', location: 'Thekkady' });
});

test('Resort is unchanged: no Location column or filter', async ({ page }) => {
  await openProperties(page, 'resort');
  await expect(page.locator('#hospContent thead')).not.toContainText('Location');
  await expect(page.locator('#hospContent select[title="Filter by location"]')).toHaveCount(0);
  await expect(page.locator('#hospLocList')).toHaveCount(0);
});

test('H3 settings row shows only for the H3 style', async ({ page }) => {
  await openProperties(page, 'h3');
  await page.evaluate(() => { /* @ts-ignore */ initHospitalitySettings(); });
  // The Settings page itself is hidden in this harness, so check the row's own display.
  await expect(page.locator('#hospH3SettingsRow')).toHaveCSS('display', 'flex');
  await expect(page.locator('#cfgHospitalityStyle option[value="h3"]')).toHaveText('H3 — Location guided');
  await page.evaluate(() => { /* @ts-ignore */ clientRecord.hospitality_style = 'resort'; /* @ts-ignore */ initHospitalitySettings(); });
  await expect(page.locator('#hospH3SettingsRow')).toHaveCSS('display', 'none');
});

test('Resorts V1: option, how-it-works row, and the Agency warning while Agency is off', async ({ page }) => {
  await openProperties(page, 'h3');
  await page.evaluate(() => { /* @ts-ignore */ clientRecord.hospitality_style = 'resorts_v1'; /* @ts-ignore */ clientRecord.ta_enabled = 'No'; /* @ts-ignore */ initHospitalitySettings(); });
  await expect(page.locator('#cfgHospitalityStyle option[value="resorts_v1"]')).toHaveText('Resorts V1 — Agency Resorts & Hotels');
  await expect(page.locator('#cfgHospitalityStyle')).toHaveValue('resorts_v1');
  await expect(page.locator('#hospRv1SettingsRow')).toHaveCSS('display', 'flex');
  await expect(page.locator('#hospH3SettingsRow')).toHaveCSS('display', 'none');
  await expect(page.locator('#hospRv1AgencyWarn')).toHaveCSS('display', 'block');
  await page.evaluate(() => { /* @ts-ignore */ clientRecord.ta_enabled = 'Yes'; /* @ts-ignore */ initHospitalitySettings(); });
  await expect(page.locator('#hospRv1AgencyWarn')).toHaveCSS('display', 'none');
  await page.evaluate(() => { /* @ts-ignore */ clientRecord.hospitality_style = 'h3'; /* @ts-ignore */ initHospitalitySettings(); });
  await expect(page.locator('#hospRv1SettingsRow')).toHaveCSS('display', 'none');
});
