// Travel status on the Inquiries tab (list cards + table, desktop and phone) and Reports →
// 📌 Status Changes (frontend/travel-status.js). Hermetic file:// setup; the NocoDB passthrough
// is a route stub so saves — and the status history they append — can be checked.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';
const OWNER = 'boss@example.com';
const STAFF = 'rep@example.com';

async function boot(page, { industry = 'travel', storedLog = null } = {}) {
  const patches = [];
  await page.route('**/*', async (route) => {
    const req = route.request(); const url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url.startsWith(WORKER + '/nocodb/api/v2/meta/tables/')) return route.fulfill({ json: { columns: [{ title: 'Name' }] } });
    if (url.includes('/records/1?fields=TravelStatusLog')) return route.fulfill({ json: { TravelStatusLog: storedLog } });
    if (url.startsWith(WORKER + '/nocodb/api/v2/tables/') && req.method() === 'PATCH') { patches.push(JSON.parse(req.postData())); return route.fulfill({ json: { Id: 1 } }); }
    return route.abort();
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ OWNER, STAFF, industry }) => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    try { localStorage.removeItem('lv_travel_view_7'); } catch (e) {}
    const now = new Date().toISOString();
    // @ts-ignore
    clientId = 7; myEmail = OWNER; sessionToken = 't';
    // @ts-ignore
    clientRecord = { industry, ta_enabled: 'No', authentik_email: OWNER, team_emails: STAFF, team_names: JSON.stringify({ [STAFF]: 'Rita' }) };
    // @ts-ignore
    allLeads = [
      { Id: 1, Name: 'Asha', Phone: '911', Owner: STAFF, Date: now, Stage: 'new' },
      { Id: 2, Name: 'Ravi', Phone: '912', Owner: STAFF, Date: now, Stage: 'new', TravelStatus: 'quote_sent' },
    ];
    // @ts-ignore
    applyTheme(industry);
    // @ts-ignore
    navigate('leads');
  }, { OWNER, STAFF, industry });
  return { patches };
}

test('each inquiry card has a status dropdown that saves without opening the inquiry', async ({ page }) => {
  const { patches } = await boot(page, { storedLog: JSON.stringify([{ at: '2026-10-01T09:00:00.000Z', by: STAFF, from: 'new', to: 'first_call' }]) });
  const card = page.locator('#leadsList .lead-item', { hasText: 'Asha' });
  const sel = card.locator('select.ts-sel-inline');
  await expect(sel).toHaveValue('new');
  await expect(page.locator('#leadsList .lead-item', { hasText: 'Ravi' }).locator('select.ts-sel-inline')).toHaveValue('quote_sent');
  await sel.selectOption('booking_closed');
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toMatchObject({ Id: 1, TravelStatus: 'booking_closed', TravelStatusBy: OWNER });
  // History: the new change goes on top of what was stored on the server.
  const log = JSON.parse(patches[0].TravelStatusLog);
  expect(log.map((e) => [e.from, e.to])).toEqual([['new', 'booking_closed'], ['new', 'first_call']]);
  await expect(sel).toHaveClass(/green/);
  await expect(page.locator('#modalDetail.open')).toHaveCount(0);
});

test('table view gets a Status column', async ({ page }) => {
  await boot(page);
  // @ts-ignore
  await page.evaluate(() => { _leadsTableView = true; renderLeadsCurrentView(); });
  await expect(page.locator('#leadsTable thead')).toContainText('Status');
  await expect(page.locator('#leadsTable tr', { hasText: 'Ravi' }).locator('select.ts-sel-inline')).toHaveValue('quote_sent');
});

test('non-travel clients get no status dropdown', async ({ page }) => {
  await boot(page, { industry: 'general' });
  await expect(page.locator('#leadsList .lead-item').first()).toBeVisible();
  await expect(page.locator('select.ts-sel-inline')).toHaveCount(0);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('the dropdown is full width and big enough to tap', async ({ page }) => {
    await boot(page);
    const sel = page.locator('#leadsList .lead-item', { hasText: 'Asha' }).locator('select.ts-sel-inline');
    const box = await sel.boundingBox();
    const body = await page.locator('#leadsList .lead-item', { hasText: 'Asha' }).locator('.li-body').boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(40);
    expect(box.width).toBeGreaterThan(body.width - 4);
    expect(await sel.evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px'); // no iOS zoom-on-focus
  });
});

test('Reports → Status Changes lists every change by date and time, filterable and grouped by inquiry', async ({ page }) => {
  await boot(page);
  await page.evaluate(({ STAFF, OWNER }) => {
    // @ts-ignore
    allLeads = [
      { Id: 1, Name: 'Asha', Phone: '911', Stage: 'new', TravelStatus: 'booking_closed', TravelStatusLog: JSON.stringify([
        { at: '2026-10-14T10:30:00.000Z', by: STAFF, from: 'quote_sent', to: 'booking_closed' },
        { at: '2026-10-12T08:05:00.000Z', by: STAFF, from: 'new', to: 'quote_sent' },
      ]) },
      { Id: 2, Name: 'Ravi', Phone: '912', Stage: 'new', TravelStatus: 'follow_up_pending', TravelFollowUpAt: '2026-10-20', TravelStatusLog: JSON.stringify([
        { at: '2026-10-13T15:45:00.000Z', by: OWNER, from: 'first_call', to: 'follow_up_pending', fu: '2026-10-20' },
      ]) },
      // Marked before history was kept — shows its last change.
      { Id: 3, Name: 'Meera', Phone: '913', Stage: 'new', TravelStatus: 'cancelled', TravelStatusAt: '2026-10-11T07:00:00.000Z', TravelStatusBy: STAFF },
    ];
    // @ts-ignore
    navigate('reports');
  }, { STAFF, OWNER });
  // Opened straight away, before Overview's own requests finish — Overview mustn't paint over it.
  await expect(page.locator('#rptTabTvStatus')).toBeVisible();
  await page.locator('#rptTabTvStatus').click();
  const rows = page.locator('#reportsContent .ts-rpt-tbl tbody tr');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText('Asha');
  await expect(rows.nth(0)).toContainText('Booking closed');
  await expect(rows.nth(0)).toContainText('14 Oct 2026');
  await expect(rows.nth(1)).toContainText('Ravi');
  await expect(rows.nth(1)).toContainText('2026-10-20');
  await expect(rows.nth(3)).toContainText('last change');
  await expect(page.locator('#reportsContent .stat', { hasText: 'Inquiries updated' }).locator('.stat-val')).toHaveText('3');
  await page.locator('#reportsContent select').selectOption('quote_sent');
  await expect(rows).toHaveCount(1);
  await page.locator('#reportsContent select').selectOption('');
  await page.locator('#reportsContent label', { hasText: 'Group by inquiry' }).locator('input').check();
  await expect(page.locator('#reportsContent .card', { hasText: 'Asha' }).locator('tbody tr')).toHaveCount(2);
  await page.locator('#tsRptSearch').fill('ravi');
  await expect(page.locator('#reportsContent .ts-rpt-tbl tbody tr')).toHaveCount(1);
  await expect(page.locator('#tsRptSearch')).toBeFocused();
});

test('the Status Changes tab is hidden for non-travel clients', async ({ page }) => {
  await boot(page, { industry: 'general' });
  // @ts-ignore
  await page.evaluate(() => navigate('reports'));
  await expect(page.locator('#rptTabTvStatus')).toBeHidden();
});
