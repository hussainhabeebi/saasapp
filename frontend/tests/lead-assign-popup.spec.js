// 🔔 Assignment popups (dashboard.html showAssignPopup / asgCheckNewlyMine): a lead assigned to me
// or shared with me pops up a card that stays until I open or dismiss it — live, and for leads
// that became mine while I was away. Same hermetic file:// setup as lead-shared-access.spec.js.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');
const ME = 'bob@biz.com';

async function setup(page, leads) {
  const state = { leads: leads.map((l) => ({ ...l })) };
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'file:') return route.continue();
    const req = route.request();
    if (req.method() === 'PATCH') return route.fulfill({ json: {} });
    if (/\/records$/.test(url.pathname)) return route.fulfill({ json: { list: state.leads, pageInfo: { isLastPage: true } } });
    return route.abort();
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ me, leads }) => {
    sessionStorage.clear(); localStorage.clear();
    // @ts-ignore
    clientId = '7'; myEmail = me; allLeads = leads.map((l) => ({ ...l }));
    // @ts-ignore
    clientRecord = { client_name: 'Test', authentik_email: 'owner@biz.com', team_emails: 'alice@biz.com,bob@biz.com',
      team_names: JSON.stringify({ 'alice@biz.com': 'Alice', 'bob@biz.com': 'Bob' }), lead_routing: JSON.stringify({ enabled: true }) };
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
  }, { me: ME, leads });
  return state;
}

const BASE = [
  { Id: 1, Name: 'Old lead', Owner: ME, Stage: 'new', Phone: '971500000001' },
  { Id: 2, Name: 'Alice lead', Owner: 'alice@biz.com', Stage: 'new', Phone: '971500000002' },
];

test('a lead assigned to me live pops up and stays until dismissed; Open lead opens it', async ({ page }) => {
  const state = await setup(page, BASE);
  // @ts-ignore
  await page.evaluate(() => asgCheckNewlyMine()); // first load on this device: remembers, no popup
  await expect(page.locator('.asg-pop')).toHaveCount(0);
  state.leads[1].Owner = ME;
  // @ts-ignore
  await page.evaluate(() => onLiveReassignEvent({ type: 'lead_reassigned', reason: 'manual', lead_id: 2, lead_name: 'Alice lead', to: 'bob@biz.com', by_name: 'Owner', at: new Date().toISOString() }));
  const pop = page.locator('.asg-pop');
  await expect(pop).toHaveCount(1); // live card only — the reload's catch-up does not repeat it
  await expect(pop).toContainText('New lead assigned to you');
  await expect(pop).toContainText('Alice lead');
  await expect(pop).toContainText('by Owner');
  await page.waitForTimeout(3500); // a toast would be gone by now
  await expect(pop).toBeVisible();
  await pop.locator('.asg-open').click();
  await expect(page.locator('.asg-pop')).toHaveCount(0);
  await expect(page.locator('#pageLeads')).toBeVisible();
});

test('a lead shared with me pops up; one for someone else does not', async ({ page }) => {
  await setup(page, BASE);
  // @ts-ignore
  await page.evaluate(() => onLiveSharedEvent({ type: 'lead_shared', lead_id: 2, lead_name: 'Alice lead', to: 'alice@biz.com', by_name: 'Owner' }));
  await expect(page.locator('.asg-pop')).toHaveCount(0);
  // @ts-ignore
  await page.evaluate(() => onLiveSharedEvent({ type: 'lead_shared', lead_id: 2, lead_name: 'Alice lead', to: 'BOB@biz.com', by_name: 'Alice' }));
  await expect(page.locator('.asg-pop')).toContainText('Lead shared with you');
  await expect(page.locator('.asg-pop')).toContainText('by Alice');
  await page.locator('.asg-pop .asg-x').click();
  await expect(page.locator('.asg-pop')).toHaveCount(0);
});

test('leads given to me while I was away pop up on the next load; many become one summary', async ({ page }) => {
  await setup(page, BASE);
  // @ts-ignore
  await page.evaluate(() => asgCheckNewlyMine());
  // Away: one lead assigned, one shared.
  // @ts-ignore
  await page.evaluate((me) => {
    allLeads.push({ Id: 3, Name: 'Assigned while away', Owner: me, Stage: 'new' }, { Id: 4, Name: 'Shared while away', Owner: 'alice@biz.com', SharedWith: `,${me},`, Stage: 'new' });
    asgCheckNewlyMine();
  }, ME);
  await expect(page.locator('.asg-pop')).toHaveCount(2);
  await expect(page.locator('.asg-pop', { hasText: 'Assigned while away' })).toContainText('New lead assigned to you');
  await expect(page.locator('.asg-pop', { hasText: 'Shared while away' })).toContainText('Lead shared with you');
  // Seen once — not again on the next load.
  // @ts-ignore
  await page.evaluate(() => { document.querySelectorAll('.asg-pop').forEach((x) => x.remove()); asgCheckNewlyMine(); });
  await expect(page.locator('.asg-pop')).toHaveCount(0);
  // Many at once → a single summary card.
  // @ts-ignore
  await page.evaluate((me) => { for (let i = 10; i < 15; i++) allLeads.push({ Id: i, Name: 'L' + i, Owner: me, Stage: 'new' }); asgCheckNewlyMine(); }, ME);
  await expect(page.locator('.asg-pop')).toHaveCount(1);
  await expect(page.locator('.asg-pop')).toContainText('5 leads are now yours');
});

test('no popup for a lead I assigned to myself or created', async ({ page }) => {
  await setup(page, BASE);
  // @ts-ignore
  await page.evaluate((me) => {
    asgCheckNewlyMine();
    _noteLeadEdits({ Id: 2, Owner: me }); allLeads[1].Owner = me;
    allLeads.push({ Id: 5, Name: 'Mine', Owner: me, CreatedBy: me, Stage: 'new' });
    asgCheckNewlyMine();
  }, ME);
  await expect(page.locator('.asg-pop')).toHaveCount(0);
});
