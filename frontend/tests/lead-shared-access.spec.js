// Lead shared access on the Leads tab (dashboard.html leadVisibilityFilter / Edit Lead "👥 Shared
// with"): a lead shared with a teammate shows in their list (also under My leads), and only the
// lead's owner or an admin can change who it is shared with. Same hermetic file:// setup as
// leads-staff-scope.spec.js.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');

const LEADS = [
  { Id: 1, Name: 'Alice lead', Owner: 'alice@biz.com', Stage: 'new', Phone: '971500000001', SharedWith: ',bob@biz.com,' },
  { Id: 2, Name: 'Bob lead', Owner: 'bob@biz.com', Stage: 'new', Phone: '971500000002' },
  { Id: 3, Name: 'Other lead', Owner: 'alice@biz.com', Stage: 'new', Phone: '971500000003' },
];

async function setup(page, { me, role }) {
  const patches = [];
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'file:') return route.continue();
    const req = route.request();
    if (req.method() === 'PATCH') { patches.push(JSON.parse(req.postData())); return route.fulfill({ json: {} }); }
    if (/\/records$/.test(url.pathname)) return route.fulfill({ json: { list: [], pageInfo: { isLastPage: true } } });
    return route.abort();
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ me, role, leads }) => {
    sessionStorage.clear();
    // @ts-ignore
    clientId = '7'; myEmail = me; allLeads = leads.map((l) => ({ ...l }));
    // @ts-ignore
    clientRecord = { client_name: 'Test', authentik_email: 'owner@biz.com', team_emails: 'alice@biz.com,bob@biz.com',
      team_names: JSON.stringify({ 'alice@biz.com': 'Alice', 'bob@biz.com': 'Bob' }),
      lead_routing: JSON.stringify({ enabled: true }), team_permissions: JSON.stringify(role ? { [me]: { role } } : {}) };
    // @ts-ignore
    _leadsActiveView = 'all'; _leadsOwnerScopeInitialized = false;
    // @ts-ignore
    navigate('leads');
  }, { me, role, leads: LEADS });
  return patches;
}
// @ts-ignore
const visibleIds = (page) => page.evaluate(() => applyLeadsViewFilter(allLeads).map((l) => l.Id));

test('a lead shared with a teammate shows in their list next to their own; others stay hidden', async ({ page }) => {
  await setup(page, { me: 'bob@biz.com' });
  expect((await visibleIds(page)).sort()).toEqual([1, 2]);
  // @ts-ignore
  await page.evaluate(() => openDetail(1));
  await expect(page.locator('#detailSub')).toContainText('👥 Bob');
});

test("the lead's owner shares it from Edit Lead; only changes are sent", async ({ page }) => {
  const patches = await setup(page, { me: 'alice@biz.com' });
  // @ts-ignore
  await page.evaluate(() => openEditLead(allLeads.find((l) => l.Id === 3)));
  const boxes = page.locator('#fSharedWith .f-shared');
  // Everyone but the owner can be ticked.
  await expect(boxes).toHaveCount(2);
  await expect(page.locator('#fSharedWith')).not.toContainText('Alice');
  // The app shell sits behind the login gate here, so tick the box directly.
  await page.evaluate(() => { document.querySelector('#fSharedWith .f-shared[value="bob@biz.com"]').checked = true; });
  // @ts-ignore
  await page.evaluate(() => saveLeadNow());
  expect(patches.at(-1).SharedWith).toBe(',bob@biz.com,');

  // An edit that leaves sharing alone doesn't send it. (The save reloaded the list from the stub.)
  // @ts-ignore
  await page.evaluate((leads) => { allLeads = leads.map((l) => ({ ...l })); openEditLead(allLeads.find((l) => l.Id === 1)); }, LEADS);
  // @ts-ignore
  await page.evaluate(() => saveLeadNow());
  expect('SharedWith' in patches.at(-1)).toBe(false);
});

test('a shared teammate sees who it is shared with but cannot change it; Add Lead has no sharing', async ({ page }) => {
  await setup(page, { me: 'bob@biz.com' });
  // @ts-ignore
  await page.evaluate(() => openEditLead(allLeads.find((l) => l.Id === 1)));
  await expect(page.locator('#fSharedWith .f-shared[value="bob@biz.com"]')).toBeChecked();
  await expect(page.locator('#fSharedWith .f-shared[value="bob@biz.com"]')).toBeDisabled();
  await expect(page.locator('#fSharedHint')).not.toHaveClass(/hidden/);
  // @ts-ignore
  await page.evaluate(() => openAddLead());
  await expect(page.locator('#fSharedWrap')).toHaveClass(/hidden/);
});
