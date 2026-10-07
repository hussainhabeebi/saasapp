// Leads tab staff scope (dashboard.html leadVisibleToMe / applyLeadsViewFilter / claimLeadIfUnowned):
// one lead belongs to one staff member — a teammate never sees a lead owned by someone else, and
// unassigned leads only show to staff while Lead Routing is off. Same hermetic file:// setup as
// leads-progressive-load.spec.js.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');

const LEADS = [
  { Id: 1, Name: 'Alice lead', Owner: 'alice@biz.com', Stage: 'new' },
  { Id: 2, Name: 'Bob lead', Owner: 'Bob@Biz.com', Stage: 'new' },
  { Id: 3, Name: 'Nobody lead', Owner: '', Stage: 'new' },
];

async function setup(page, { me, routing = {}, role, serverOwner = '' }) {
  const patches = [];
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'file:') return route.continue();
    const req = route.request();
    if (req.method() === 'PATCH') { patches.push(JSON.parse(req.postData())); return route.fulfill({ json: {} }); }
    if (/\/records\/3$/.test(url.pathname)) return route.fulfill({ json: { Id: 3, Owner: serverOwner, ConvHistory: '[]' } });
    return route.abort();
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ me, routing, role, leads }) => {
    sessionStorage.clear();
    // @ts-ignore
    clientId = '7'; myEmail = me; allLeads = leads.map((l) => ({ ...l }));
    // @ts-ignore
    clientRecord = { client_name: 'Test', authentik_email: 'owner@biz.com', team_emails: 'owner@biz.com,alice@biz.com,bob@biz.com',
      lead_routing: JSON.stringify(routing), team_permissions: JSON.stringify(role ? { [me]: { role } } : {}) };
    // @ts-ignore
    _leadsActiveView = 'all'; _leadsOwnerScopeInitialized = false;
    // @ts-ignore
    navigate('leads');
  }, { me, routing, role, leads: LEADS });
  return patches;
}
// The app shell sits behind the login gate here, so check the element's own display, not visibility.
const display = (page, sel) => page.evaluate((s) => document.querySelector(s).style.display, sel);
// @ts-ignore
const visibleIds = (page) => page.evaluate(() => applyLeadsViewFilter(allLeads).map((l) => l.Id));

test('routing on: staff see only their own leads — never a teammate\'s, never unassigned', async ({ page }) => {
  await setup(page, { me: 'bob@biz.com', routing: { enabled: true } });
  expect(await visibleIds(page)).toEqual([2]);
  expect(await display(page, '#leadsScopeBtn')).toBe('none');
  expect(await display(page, '#leadOwnerFilter')).toBe('none');
});

test('routing off: staff see their own leads plus unassigned, still never a teammate\'s', async ({ page }) => {
  await setup(page, { me: 'bob@biz.com', routing: { enabled: false } });
  expect(await visibleIds(page)).toEqual([2, 3]);
  // The old Mine/All toggle let staff flip to every lead — it's gone, and flipping the state does nothing.
  // @ts-ignore
  await page.evaluate(() => { _leadsOwnerScope = 'all'; });
  expect(await visibleIds(page)).toEqual([2, 3]);
});

test('account owner and Admin/General Manager roles see every lead', async ({ page }) => {
  await setup(page, { me: 'owner@biz.com', routing: { enabled: true } });
  expect(await visibleIds(page)).toEqual([1, 2, 3]);
  expect(await display(page, '#leadsScopeBtn')).toBe('');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await setup(page, { me: 'gm@biz.com', role: 'general_manager', routing: { enabled: true } });
  expect(await visibleIds(page)).toEqual([1, 2, 3]);
});

test('claiming an unassigned lead someone else just took does not overwrite their claim', async ({ page }) => {
  const patches = await setup(page, { me: 'bob@biz.com', serverOwner: 'alice@biz.com' });
  // @ts-ignore
  await page.evaluate(() => claimLeadIfUnowned(3, 'Note'));
  expect(patches).toEqual([]);
  // @ts-ignore
  expect(await page.evaluate(() => allLeads.find((l) => l.Id === 3).Owner)).toBe('alice@biz.com');
  expect(await visibleIds(page)).toEqual([2]);
});

test('claiming a still-unassigned lead makes it the claimer\'s', async ({ page }) => {
  const patches = await setup(page, { me: 'bob@biz.com' });
  // @ts-ignore
  await page.evaluate(() => claimLeadIfUnowned(3, 'Note'));
  expect(patches.map((p) => p.Owner)).toEqual(['bob@biz.com']);
});
