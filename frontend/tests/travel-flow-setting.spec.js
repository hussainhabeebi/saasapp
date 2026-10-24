// Dashboard → Settings → Industry Modules → ✈️ Travel Flow: an optional switch under the Travel
// Agency module, shown only while that module is on, saved through the worker (PUT /live-travel/travel-flow).
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');

test('Travel Flow is an optional Travel Agency setting, off by default', async ({ page }) => {
  const puts = [];
  await page.route('**/*', async (route) => {
    const req = route.request(), url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url.endsWith('/live-travel/travel-flow') && req.method() === 'GET') return route.fulfill({ json: { enabled: false } });
    if (url.endsWith('/live-travel/travel-flow') && req.method() === 'PUT') { const b = JSON.parse(req.postData()); puts.push(b); return route.fulfill({ json: { enabled: b.enabled } }); }
    return route.abort();
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  const row = page.locator('#taFlowRow');
  await page.evaluate(() => {
    // @ts-ignore
    clientRecord = { Id: 7, industry: 'travel', ta_enabled: 'No' }; initTaSettings();
  });
  await expect(row).toBeHidden();
  const patches = await page.evaluate(async () => {
    const sent = [];
    // @ts-ignore
    clientRecord = { Id: 7, industry: 'travel', ta_enabled: 'Yes' };
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    // @ts-ignore
    try { navigate('modules'); } catch (e) {}
    // @ts-ignore
    initTaSettings();
    // @ts-ignore
    window.ncGet = async () => ({ columns: [{ title: 'travel_flow_enabled' }] });
    // @ts-ignore
    window.patchClient = async (fields) => { sent.push(fields); };
    // @ts-ignore
    ncGet = window.ncGet; patchClient = window.patchClient;
    // @ts-ignore
    window.__sent = sent;
    return sent;
  });
  expect(patches).toEqual([]);
  await expect(row).toBeVisible();
  await expect(page.locator('#cfgTaFlow')).toHaveValue('No');
  await expect(page.locator('#taFlowStatusBadge')).toHaveText('— Inactive');
  await page.locator('#cfgTaFlow').selectOption('Yes');
  await page.locator('#saveTaFlow').click();
  await expect(page.locator('#saveTaFlowMsg')).toContainText('Travel Flow is on');
  expect(puts).toEqual([{ enabled: true }]);
  await expect(page.locator('#taFlowStatusBadge')).toHaveText('✓ Active');
});
