// Reports → 📋 Leads & Calls: leads and incoming-call numbers side by side, never mixed. Same
// hermetic file:// setup as call-score.spec.js — no backend, seeded allLeads, render fn driven directly.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');

const OWNER = 'boss@example.com';
const STAFF = 'rep@example.com';

async function boot(page) {
  await page.route('**/*', (route) => (route.request().url().startsWith('file://') ? route.continue() : route.abort()));
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ OWNER, STAFF }) => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    const now = Date.now();
    const sod = new Date(); sod.setHours(0, 0, 0, 0);
    // "today" timestamps stay after local midnight however early the test runs
    const today = (n) => new Date(Math.max(sod.getTime() + n * 1000, now - 1000 * n)).toISOString();
    const daysAgo = (d) => new Date(now - d * 86400e3).toISOString();
    const call = (by, at, outcome, dir) => ({ outcome, at, date: '', by, duration: 2, ...(dir ? { dir } : {}) });
    // @ts-ignore
    myEmail = OWNER;
    // @ts-ignore
    clientRecord = { authentik_email: OWNER, client_name: 'Boss', team_emails: STAFF, team_names: JSON.stringify({ [STAFF]: 'Rita' }) };
    // @ts-ignore
    allLeads = [
      // Arrived today, called us twice: one answered, one missed. Plus one outgoing (legacy, no dir).
      { Id: 1, Name: 'Caller A', Owner: STAFF, Stage: 'new', Date: today(5),
        CallLog: JSON.stringify([call(STAFF, today(4), 'Answered', 'in'), call(STAFF, today(3), 'No Answer', 'in'), call(STAFF, today(2), 'Answered')].reverse()) },
      // Arrived today, called us once (voicemail = missed)
      { Id: 2, Name: 'Caller B', Owner: OWNER, Stage: 'new', Date: today(6),
        CallLog: JSON.stringify([call(OWNER, today(1), 'Voicemail', 'in')]) },
      // Old lead with an old incoming call — outside "Today"
      { Id: 3, Name: 'Old', Owner: OWNER, Stage: 'new', Date: daysAgo(40),
        CallLog: JSON.stringify([call(OWNER, daysAgo(40), 'Answered', 'in')]) },
    ];
  }, { OWNER, STAFF });
  await page.evaluate(() => {
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    document.getElementById('pageReports').classList.remove('hidden');
  });
}

const statVal = (page, card, label) =>
  page.locator(`#${card} .stat`, { has: page.locator('.stat-lbl', { hasText: new RegExp(`^${label}$`) }) }).locator('.stat-val');

test('All Time: separate leads and incoming-call totals', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.renderReportsSubPage('leadscalls'));
  await expect(page.locator('#reportsSubNav .hosp-tab.active')).toHaveAttribute('data-reports', 'leadscalls');
  await expect(statVal(page, 'lcLeads', 'Total Leads')).toHaveText('3');
  await expect(statVal(page, 'lcLeads', 'New Leads Today')).toHaveText('2');
  await expect(statVal(page, 'lcCalls', 'Total Incoming Calls')).toHaveText('4');
  await expect(statVal(page, 'lcCalls', 'Answered Calls')).toHaveText('2');
  await expect(statVal(page, 'lcCalls', 'Missed / Unanswered Calls')).toHaveText('2');
  await expect(statVal(page, 'lcCalls', 'Customers Who Called')).toHaveText('3');
  await expect(page.locator('#lcCalls')).toContainText('Outgoing calls made by the team in this period: 1');
  // Day-by-day: 7 rows for All Time, today's row first
  const rows = page.locator('#reportsContent table.leads-tbl tbody tr');
  await expect(rows).toHaveCount(7);
  await expect(rows.first().locator('td')).toHaveText([/.+/, '2', '3', '1', '2', '2']);
});

test('Today + member filter narrow both sections independently', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { window.renderReportsSubPage('leadscalls'); window.setRptPeriod('today'); });
  await expect(statVal(page, 'lcLeads', 'Total Leads')).toHaveText('2');
  await expect(statVal(page, 'lcCalls', 'Total Incoming Calls')).toHaveText('3');
  await expect(page.locator('#reportsContent table.leads-tbl tbody tr')).toHaveCount(1);

  await page.locator('#rptMember').selectOption('rep@example.com');
  await expect(statVal(page, 'lcLeads', 'Total Leads')).toHaveText('1');
  await expect(statVal(page, 'lcCalls', 'Total Incoming Calls')).toHaveText('2');
  await expect(statVal(page, 'lcCalls', 'Answered Calls')).toHaveText('1');
  await expect(statVal(page, 'lcCalls', 'Customers Who Called')).toHaveText('1');
});

test('Log Call records the direction and resets it to outgoing', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    // @ts-ignore
    window.patchDetailField = async () => {};
    // @ts-ignore
    currentLead = allLeads[2];
    window.openCallLog();
  });
  await page.locator('#callDirection').selectOption('in');
  await page.locator('#callOutcome').selectOption('Answered');
  await page.evaluate(() => window.saveCall());
  const first = await page.evaluate(() => JSON.parse(allLeads[2].CallLog)[0]);
  expect(first.dir).toBe('in');
  await expect(page.locator('#callDirection')).toHaveValue('out');
  await expect(page.locator('#detailCalls')).toContainText('📥 Incoming');
});
