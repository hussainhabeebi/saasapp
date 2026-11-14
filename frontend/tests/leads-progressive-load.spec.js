// Progressive leads load (dashboard.html loadAll/hydrateConvHistory): the newest page arrives with
// every column, the rest without ConvHistory (the heavy chat transcript), which is then filled in
// by one background request. Same hermetic file:// setup as lead-actions.spec.js — the NocoDB list
// endpoint is answered from an in-memory fixture instead of the real Worker.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');

const TOTAL = 250;
const LEADS = Array.from({ length: TOTAL }, (_, i) => ({
  Id: TOTAL - i,
  ClientId: '7',
  Name: 'Lead ' + (TOTAL - i),
  Phone: '9198765' + String(TOTAL - i).padStart(5, '0'),
  Stage: 'new',
  Score: 'Cold',
  Date: new Date(Date.now() - i * 60000).toISOString(),
  ConvHistory: JSON.stringify([{ role: 'user', content: 'hello from ' + (TOTAL - i) }, { role: 'assistant', content: 'hi' }]),
}));

async function setup(page) {
  const requests = [];
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'file:') return route.continue();
    const single = url.pathname.match(/\/nocodb\/api\/v2\/tables\/[^/]+\/records\/(\d+)$/);
    const isList = /\/nocodb\/api\/v2\/tables\/[^/]+\/records$/.test(url.pathname);
    if (!single && !isList) return route.abort();
    requests.push(url.search);
    const fields = url.searchParams.get('fields');
    const pick = (l) => (fields ? Object.fromEntries(fields.split(',').filter((f) => f in l).map((f) => [f, l[f]])) : { ...l });
    if (single) return route.fulfill({ json: pick(LEADS.find((l) => l.Id === Number(single[1]))) });
    const offset = Number(url.searchParams.get('offset') || 0);
    const limit = Number(url.searchParams.get('limit') || 25);
    const list = LEADS.slice(offset, offset + limit).map(pick);
    return route.fulfill({ json: { list, pageInfo: { isLastPage: offset + limit >= TOTAL } } });
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    sessionStorage.clear();
    localStorage.removeItem('lv_lead_cols');
    // @ts-ignore
    clientId = '7'; clientRecord = { client_name: 'Test' };
  });
  return requests;
}

test('newest page first, the rest without ConvHistory, transcripts hydrated after', async ({ page }) => {
  const requests = await setup(page);
  // @ts-ignore
  await page.evaluate(() => loadAll());
  // @ts-ignore
  await expect.poll(() => page.evaluate(() => allLeads.length)).toBe(TOTAL);
  // @ts-ignore
  await expect.poll(() => page.evaluate(() => allLeads.every((l) => typeof l.ConvHistory === 'string'))).toBe(true);

  const list = requests.map((q) => new URLSearchParams(q));
  expect(list[0].get('limit')).toBe('100');
  expect(list[0].get('fields')).toBeNull();
  expect(list[1].get('offset')).toBe('100');
  const slim = list[1].get('fields').split(',');
  expect(slim).toContain('Name');
  expect(slim).not.toContain('ConvHistory');
  expect(list[2].get('fields')).toBe('Id,ConvHistory');

  // The tab cache holds no transcripts (they used to overflow sessionStorage's quota).
  const cached = await page.evaluate(() => JSON.parse(sessionStorage.getItem('lv_leads_7')));
  expect(cached.list).toHaveLength(TOTAL);
  expect(cached.list.some((l) => 'ConvHistory' in l)).toBe(false);
});

test('opening an older lead before hydration loads just its transcript', async ({ page }) => {
  await setup(page);
  // @ts-ignore
  await page.evaluate(() => { allLeads = [{ Id: 12, Name: 'Lead 12', Phone: '919876500012', Stage: 'new' }]; openDetail(12); });
  await expect(page.locator('#detailThread')).toContainText('hello from 12');
  // @ts-ignore
  expect(await page.evaluate(() => typeof allLeads[0].ConvHistory)).toBe('string');
});

test('a small account needs only the one request', async ({ page }) => {
  const requests = await setup(page);
  await page.unroute('**/*');
  const few = LEADS.slice(0, 30);
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'file:') return route.continue();
    requests.push(url.search);
    return route.fulfill({ json: { list: few, pageInfo: { isLastPage: true } } });
  });
  requests.length = 0;
  // @ts-ignore
  await page.evaluate(() => loadAll());
  // @ts-ignore
  await expect.poll(() => page.evaluate(() => allLeads.length)).toBe(30);
  await page.waitForTimeout(200);
  expect(requests).toHaveLength(1);
});

test('a refresh with nothing changed skips re-downloading transcripts', async ({ page }) => {
  const requests = await setup(page);
  // @ts-ignore
  await page.evaluate(() => loadAll());
  // @ts-ignore
  await expect.poll(() => page.evaluate(() => allLeads.every((l) => typeof l.ConvHistory === 'string'))).toBe(true);
  requests.length = 0;
  // @ts-ignore
  await page.evaluate(() => loadAll(true, true));
  await page.waitForTimeout(300);
  expect(requests.map((q) => new URLSearchParams(q).get('fields'))).not.toContain('Id,ConvHistory');
  // @ts-ignore
  expect(await page.evaluate(() => allLeads.every((l) => typeof l.ConvHistory === 'string'))).toBe(true);
});
