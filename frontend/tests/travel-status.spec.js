// Travel workspace → 📌 Status Board (frontend/travel-status.js). Same hermetic file:// setup as
// travel-view.spec.js; the Worker's NocoDB passthrough is stubbed so status saves can be checked.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';
const OWNER = 'boss@example.com';
const STAFF = 'rep@example.com';

function iso(offsetDays) {
  const d = new Date(); d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

async function boot(page, me = OWNER, saveStatus = 200) {
  const patches = [];
  const fieldsAdded = [];
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url.startsWith(WORKER + '/nocodb/api/v2/meta/tables/')) {
      if (req.method() === 'POST') { fieldsAdded.push(JSON.parse(req.postData()).title); return route.fulfill({ json: {} }); }
      return route.fulfill({ json: { columns: [{ title: 'Name' }] } });
    }
    if (url.startsWith(WORKER + '/nocodb/api/v2/tables/') && req.method() === 'PATCH') {
      patches.push(JSON.parse(req.postData()));
      return route.fulfill({ status: saveStatus, json: saveStatus === 200 ? { Id: 1 } : { msg: 'nope' } });
    }
    return route.abort();
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ OWNER, STAFF, me, yesterday }) => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    try { localStorage.removeItem('lv_travel_view_7'); } catch (e) {}
    const now = new Date().toISOString();
    // @ts-ignore
    clientId = 7; myEmail = me; sessionToken = 't';
    // @ts-ignore
    clientRecord = { industry: 'travel', ta_enabled: 'No', authentik_email: OWNER, team_emails: STAFF, team_names: JSON.stringify({ [STAFF]: 'Rita' }) };
    // @ts-ignore
    allLeads = [
      { Id: 1, Name: 'Asha', Phone: '911', Owner: STAFF, Date: now, Stage: 'new', ServiceCategory: 'Visa' },
      { Id: 2, Name: 'Ravi', Phone: '912', Owner: STAFF, Date: now, Stage: 'new', CallLog: JSON.stringify([{ outcome: 'Answered', at: now }]) },
      { Id: 3, Name: 'Meera', Phone: '913', Owner: OWNER, Date: now, Stage: 'new', TravelStatus: 'follow_up_pending', TravelFollowUpAt: yesterday },
      { Id: 4, Name: 'John', Phone: '914', Owner: '', Date: now, Stage: 'new', TravelStatus: 'booking_closed', ServiceCategory: 'Umrah and Hajj' },
    ];
    // @ts-ignore
    applyTheme('travel');
  }, { OWNER, STAFF, me, yesterday: iso(-1) });
  return { patches, fieldsAdded };
}

const tileCount = (page, label) => page.locator('.ts-tile', { hasText: label }).locator('.n');

test('status board counts every status, with auto statuses before anyone marks one', async ({ page }) => {
  await boot(page);
  await page.locator('#travelNav .dnTab[data-page="tvstatus"]').click();
  await expect(page.locator('#pageTvstatus')).toBeVisible();
  await expect(tileCount(page, 'All inquiries')).toHaveText('4');
  await expect(tileCount(page, 'New inquiry')).toHaveText('1');        // Asha — no calls
  await expect(tileCount(page, 'First call done')).toHaveText('1');    // Ravi — derived from CallLog
  await expect(tileCount(page, 'Follow up pending')).toHaveText('1');
  await expect(tileCount(page, 'Booking closed')).toHaveText('1');
  await expect(tileCount(page, 'Follow-ups due')).toHaveText('1');
  await expect(page.locator('tr[data-lead="2"]')).toContainText('auto');
  await expect(page.locator('tr[data-lead="3"] .ts-due.overdue')).toBeVisible();
  // Overdue follow-ups sort to the top.
  await expect(page.locator('.ts-tbl tbody tr').first()).toHaveAttribute('data-lead', '3');
  await page.locator('.ts-tile', { hasText: 'Booking closed' }).click();
  await expect(page.locator('.ts-tbl tbody tr')).toHaveCount(1);
  await expect(page.locator('.ts-tbl tbody tr')).toContainText('John');
});

test('marking a status saves it to the lead with who and when', async ({ page }) => {
  const { patches, fieldsAdded } = await boot(page);
  // @ts-ignore
  await page.evaluate(() => navigate('tvstatus'));
  await page.locator('tr[data-lead="1"] select.ts-sel').selectOption('first_call');
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toMatchObject({ Id: 1, TravelStatus: 'first_call', TravelStatusBy: OWNER });
  expect(patches[0].TravelStatusAt).toBeTruthy();
  expect(fieldsAdded).toEqual(['TravelStatus', 'TravelFollowUpAt', 'TravelStatusAt', 'TravelStatusBy', 'TravelStatusLog']);
  await expect(tileCount(page, 'First call done')).toHaveText('2');
  await expect(page.locator('tr[data-lead="1"]')).not.toContainText('auto');
});

test('follow up pending defaults to tomorrow and the date can be changed', async ({ page }) => {
  const { patches } = await boot(page);
  // @ts-ignore
  await page.evaluate(() => navigate('tvstatus'));
  await page.locator('tr[data-lead="2"] select.ts-sel').selectOption('follow_up_pending');
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toMatchObject({ Id: 2, TravelStatus: 'follow_up_pending', TravelFollowUpAt: iso(1) });
  await page.locator('tr[data-lead="2"] input.ts-date').fill(iso(0));
  await expect.poll(() => patches.length).toBe(2);
  expect(patches[1]).toMatchObject({ Id: 2, TravelFollowUpAt: iso(0) });
  await expect(tileCount(page, 'Follow-ups due')).toHaveText('2');
});

test('a failed save puts the old status back', async ({ page }) => {
  const { patches } = await boot(page, OWNER, 500);
  // @ts-ignore
  await page.evaluate(() => navigate('tvstatus'));
  await page.locator('tr[data-lead="4"] select.ts-sel').selectOption('cancelled');
  await expect.poll(() => patches.length).toBe(1);
  await expect(page.locator('tr[data-lead="4"] select.ts-sel')).toHaveValue('booking_closed');
});

test('Today shows a teammate only their own inquiries; the board has no Staff column', async ({ page }) => {
  await boot(page, STAFF);
  // @ts-ignore
  await page.evaluate(() => navigate('travelhome'));
  const summary = page.locator('#tvHomeBody .card', { hasText: 'Inquiry status' });
  // Rita owns Asha (new) and Ravi (first call) — Meera's overdue follow-up and John's booking aren't hers.
  await expect(summary.locator('.tv-chip')).toHaveText(['🆕 New inquiry1', '📞 First call done1']);
  await expect(summary).not.toContainText('follow-up due');
  await expect(page.locator('#tvHomeBody')).not.toContainText('Meera');
  await summary.locator('.tv-chip', { hasText: 'First call done' }).click();
  await expect(page.locator('#pageTvstatus')).toBeVisible();
  await expect(page.locator('.ts-tbl thead')).not.toContainText('Staff');
  // The full list comes back once Home is done — the board still has its own rules.
  // @ts-ignore
  expect(await page.evaluate(() => allLeads.length)).toBe(4);
});

test('Today: leads by category, with a period picker; the owner sees every lead', async ({ page }) => {
  await boot(page, OWNER);
  // @ts-ignore
  await page.evaluate(() => navigate('travelhome'));
  const report = page.locator('#tvCategoryReport');
  await expect(report.locator('tbody tr')).toHaveCount(3);
  await expect(report.locator('tbody tr', { hasText: 'Visa' }).locator('td')).toHaveText(['🛂 Visa', '1', '1', '0', '0', '0%']);
  await expect(report.locator('tfoot td')).toHaveText(['Total', '4', '4', '0', '0', '0%']);
  await report.locator('tbody tr', { hasText: 'Visa' }).click();
  await expect(page.locator('#leadCategoryFilter')).toHaveValue('Visa');
  await expect(page.locator('#leadsCategoryChips .lv-tab.active')).toContainText('Visa');
});

test('travel status and the pipeline stage move together', async ({ page }) => {
  const { patches } = await boot(page);
  const status = () => patches.filter((p) => p.TravelStatus);
  // @ts-ignore
  await page.evaluate(() => navigate('tvstatus'));
  // Booking closed → the lead is Won (and the usual won-lead bookkeeping runs: ClosedAt).
  await page.locator('tr[data-lead="1"] select.ts-sel').selectOption('booking_closed');
  await expect.poll(() => status().length).toBe(1);
  expect(status()[0]).toMatchObject({ Id: 1, TravelStatus: 'booking_closed', Stage: 'won' });
  await expect.poll(() => patches.some((p) => p.Id === 1 && p.ClosedAt)).toBe(true);
  // Back to an open status → reopened.
  await page.locator('tr[data-lead="1"] select.ts-sel').selectOption('negotiating');
  await expect.poll(() => status().length).toBe(2);
  expect(status()[1]).toMatchObject({ Id: 1, TravelStatus: 'negotiating', Stage: 'new' });
  // Cancelled → Lost; an open status on an open lead leaves Stage alone.
  await page.locator('tr[data-lead="2"] select.ts-sel').selectOption('cancelled');
  await expect.poll(() => status().length).toBe(3);
  expect(status()[2]).toMatchObject({ Id: 2, Stage: 'lost' });
  await page.locator('tr[data-lead="3"] select.ts-sel').selectOption('quote_sent');
  await expect.poll(() => status().length).toBe(4);
  expect(status()[3].Stage).toBeUndefined();
  // Marked Won elsewhere → shows Booking closed (auto).
  // @ts-ignore
  await page.evaluate(() => { allLeads.find((l) => l.Id === 3).Stage = 'won'; renderTravelStatus(); });
  await expect(page.locator('tr[data-lead="3"] select.ts-sel')).toHaveValue('booking_closed');
  await expect(page.locator('tr[data-lead="3"]')).toContainText('auto');
});
