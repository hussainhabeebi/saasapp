// Home → 👥 Staff Performance (frontend/staff-performance.js). Same hermetic file:// setup as
// leads-calls-report.spec.js — no backend, seeded allLeads, render fn driven directly.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');

const OWNER = 'boss@example.com';
const STAFF = 'rep@example.com';

async function boot(page, me, industry = 'general') {
  await page.route('**/*', (route) => (route.request().url().startsWith('file://') ? route.continue() : route.abort()));
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ OWNER, STAFF, me, industry }) => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 60 * 86400e3).toISOString();
    const call = (outcome) => JSON.stringify([{ outcome, at: now, by: STAFF }]);
    try { localStorage.removeItem('lv_sp_period_7'); localStorage.removeItem('lv_travel_view_7'); } catch (e) {}
    // @ts-ignore
    clientId = 7; myEmail = me; sessionToken = 't';
    // @ts-ignore
    clientRecord = { industry, authentik_email: OWNER, client_name: 'Boss', team_emails: STAFF, team_names: JSON.stringify({ [STAFF]: 'Rita' }) };
    // @ts-ignore
    allLeads = [
      { Id: 1, Name: 'A', Owner: STAFF, Date: now, Stage: 'won', CallLog: call('Answered') },
      { Id: 2, Name: 'B', Owner: STAFF, Date: now, Stage: 'new', CallLog: call('No Answer') },
      { Id: 3, Name: 'C', Owner: STAFF, Date: now, Stage: 'new' },
      { Id: 4, Name: 'D', Owner: STAFF, Date: now, Stage: 'lost' },
      { Id: 5, Name: 'E', Owner: OWNER, Date: now, Stage: 'new', CallLog: call('Answered') },
      { Id: 6, Name: 'F', Owner: '', Date: now, Stage: 'new', Tags: 'No Answer' },
      { Id: 7, Name: 'G', Owner: STAFF, Date: old, Stage: 'new' },
      { Id: 8, Name: 'H', Owner: 'gone@example.com', Date: now, Stage: 'new' },
    ];
    // @ts-ignore
    applyTheme(industry);
  }, { OWNER, STAFF, me, industry });
}

const rowCells = async (page, root, name) =>
  page.locator(`${root} .sp-tbl tbody tr`, { hasText: name }).locator('td').evaluateAll((tds) => tds.map((td) => td.firstElementChild?.textContent?.trim() ?? td.textContent.trim()));

test('owner sees every staff member with assigned / called / not attended / converted / not responding', async ({ page }) => {
  await boot(page, OWNER);
  // @ts-ignore
  await page.evaluate(() => renderHome());
  const card = page.locator('#homeStaffPerf');
  await expect(card).toContainText('Staff Performance');
  // Rita: 4 assigned in 30 days (G is 60 days old), 2 called, 1 not attended (C), 1 won, 1 not responding (B).
  // Score = 60% × 2/4 + 40% × (25% / best 25%) = 70.
  expect(await rowCells(page, '#homeStaffPerf', 'Rita')).toEqual(['Rita', '70', '4', '2', '1', '1', '1']);
  // Owner: 1 assigned, called, not won → 60% × 1 + 40% × 0 = 60.
  expect(await rowCells(page, '#homeStaffPerf', 'boss@example.com')).toEqual(['Boss', '60', '1', '1', '0', '0', '0']);
  // Former owner and unassigned leads still show up.
  await expect(card.locator('tbody tr', { hasText: 'gone@example.com' })).toContainText('not on the team any more');
  expect(await rowCells(page, '#homeStaffPerf', 'Unassigned')).toEqual(['📭 Unassigned', '—', '1', '0', '1', '0', '1']);
  await expect(card.locator('tfoot')).toContainText('7');
});

test('period switch recounts and is remembered', async ({ page }) => {
  await boot(page, OWNER);
  // @ts-ignore
  await page.evaluate(() => renderHome());
  await page.locator('#homeStaffPerf .sp-periods button', { hasText: 'All time' }).click();
  expect((await rowCells(page, '#homeStaffPerf', 'Rita'))[2]).toBe('5');
  expect(await page.evaluate(() => localStorage.getItem('lv_sp_period_7'))).toBe('all');
});

test('staff only see their own row', async ({ page }) => {
  await boot(page, STAFF);
  // @ts-ignore
  await page.evaluate(() => renderHome());
  const card = page.locator('#homeStaffPerf');
  await expect(card).toContainText('My Performance');
  await expect(card.locator('tbody tr')).toHaveCount(1);
  await expect(card.locator('tbody tr')).toContainText('Rita');
});

test('travel Today page shows the same report', async ({ page }) => {
  await boot(page, OWNER, 'travel');
  // @ts-ignore
  await page.evaluate(() => navigate('travelhome'));
  expect(await rowCells(page, '#tvStaffPerf', 'Rita')).toEqual(['Rita', '70', '4', '2', '1', '1', '1']);
});
