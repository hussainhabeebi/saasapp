// Reports → 📋 Leads & Calls: leads and telecaller call numbers side by side, never mixed. Same
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
    const call = (by, at, outcome) => ({ outcome, at, date: '', by, duration: 2 });
    // @ts-ignore
    myEmail = OWNER;
    // @ts-ignore
    clientRecord = { authentik_email: OWNER, client_name: 'Boss', team_emails: STAFF, team_names: JSON.stringify({ [STAFF]: 'Rita' }) };
    // @ts-ignore
    allLeads = [
      // Arrived today, Rita called 3 times: answered, no answer, answered
      { Id: 1, Name: 'Customer A', Owner: STAFF, Stage: 'new', Date: today(5),
        CallLog: JSON.stringify([call(STAFF, today(4), 'Answered'), call(STAFF, today(3), 'No Answer'), call(STAFF, today(2), 'Answered')].reverse()) },
      // Arrived today, Boss called once (voicemail = missed)
      { Id: 2, Name: 'Customer B', Owner: OWNER, Stage: 'new', Date: today(6),
        CallLog: JSON.stringify([call(OWNER, today(1), 'Voicemail')]) },
      // Old lead with an old answered call — outside "Today"
      { Id: 3, Name: 'Old', Owner: OWNER, Stage: 'new', Date: daysAgo(40),
        CallLog: JSON.stringify([call(OWNER, daysAgo(40), 'Answered')]) },
    ];
  }, { OWNER, STAFF });
  await page.evaluate(() => {
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    document.getElementById('pageReports').classList.remove('hidden');
  });
}

const statVal = (page, card, label) =>
  page.locator(`#${card} .stat`, { has: page.locator('.stat-lbl', { hasText: new RegExp(`^${label}$`) }) }).locator('.stat-val');

test('All Time: separate leads and telecaller call totals', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.renderReportsSubPage('leadscalls'));
  await expect(page.locator('#reportsSubNav .hosp-tab.active')).toHaveAttribute('data-reports', 'leadscalls');
  await expect(statVal(page, 'lcLeads', 'Total Leads')).toHaveText('3');
  await expect(statVal(page, 'lcLeads', 'New Leads Today')).toHaveText('2');
  await expect(statVal(page, 'lcCalls', 'Total Calls Made')).toHaveText('5');
  await expect(statVal(page, 'lcCalls', 'Answered Calls')).toHaveText('3');
  await expect(statVal(page, 'lcCalls', 'Missed / Unanswered Calls')).toHaveText('2');
  await expect(statVal(page, 'lcCalls', 'Customers Called')).toHaveText('3');
  // Per telecaller: Rita 3 calls (2 answered), Boss 2 calls (1 answered) across 2 customers
  const rita = page.locator('#lcAgents tbody tr', { hasText: 'Rita' });
  await expect(rita.locator('td')).toHaveText([/Rita/, '3', '2', '1', '67%', '1']);
  const boss = page.locator('#lcAgents tbody tr', { hasText: 'boss@example.com' });
  await expect(boss.locator('td')).toHaveText([/boss@example\.com/, '2', '1', '1', '50%', '2']);
  // Day-by-day: 7 rows for All Time, today's row first
  const rows = page.locator('#lcDays tbody tr');
  await expect(rows).toHaveCount(7);
  await expect(rows.first().locator('td')).toHaveText([/.+/, '2', '4', '2', '2', '2']);
});

test('Today + member filter narrow both sections independently', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { window.renderReportsSubPage('leadscalls'); window.setRptPeriod('today'); });
  await expect(statVal(page, 'lcLeads', 'Total Leads')).toHaveText('2');
  await expect(statVal(page, 'lcCalls', 'Total Calls Made')).toHaveText('4');
  await expect(page.locator('#lcDays tbody tr')).toHaveCount(1);

  await page.locator('#rptMember').selectOption('rep@example.com');
  await expect(statVal(page, 'lcLeads', 'Total Leads')).toHaveText('1');
  await expect(statVal(page, 'lcCalls', 'Total Calls Made')).toHaveText('3');
  await expect(statVal(page, 'lcCalls', 'Answered Calls')).toHaveText('2');
  await expect(statVal(page, 'lcCalls', 'Customers Called')).toHaveText('1');
  await expect(page.locator('#lcAgents tbody tr')).toHaveCount(1);
});

test('Log Call has no direction field', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#callDirection')).toHaveCount(0);
});

test('Leads Not Called: count excludes spam, tapping it builds the PDF call sheet', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const now = Date.now();
    // @ts-ignore
    allLeads.push(
      { Id: 7, Name: 'Fresh Uncalled', Phone: '919111111111', Owner: 'rep@example.com', Stage: 'new', Source: 'Meta Ads', Date: new Date(now - 60e3).toISOString() },
      { Id: 8, Name: 'Older Uncalled', Phone: '919222222222', Owner: '', Stage: 'new', Date: new Date(now - 3 * 86400e3).toISOString() },
      { Id: 9, Name: 'Spam Uncalled', Phone: '919333333333', Owner: '', Stage: 'new', HandoverOutcome: 'Spam', Date: new Date(now - 120e3).toISOString() },
    );
    // Stub jsPDF (CDN is blocked here) and capture the table + file name
    window.__pdf = {};
    // @ts-ignore
    window.jspdf = { jsPDF: function () {
      return { internal: { pageSize: { getWidth: () => 842, getHeight: () => 595 }, getNumberOfPages: () => 1 },
        setFont() {}, setFontSize() {}, setTextColor() {}, text(t) { (window.__pdf.text ||= []).push(String(t)); },
        autoTable(o) { window.__pdf.head = o.head; window.__pdf.body = o.body; o.didDrawPage?.(); },
        save(name) { window.__pdf.saved = name; } };
    } };
    window.renderReportsSubPage('leadscalls');
  });
  await expect(statVal(page, 'lcLeads', 'Leads Not Called')).toHaveText('2');
  await page.locator('#lcUncalledStat').click();
  const pdf = await page.evaluate(() => window.__pdf);
  expect(pdf.saved).toMatch(/^leads-not-called-\d{4}-\d{2}-\d{2}\.pdf$/);
  expect(pdf.head[0]).toEqual(['#', 'Ref', 'Name', 'Phone', 'Owner', 'Source', 'Stage', 'Received']);
  expect(pdf.body.map((r) => r.slice(0, 7))).toEqual([
    ['1', 'LD-00007', 'Fresh Uncalled', '919111111111', 'Rita', 'Meta Ads', 'New'],
    ['2', 'LD-00008', 'Older Uncalled', '919222222222', 'Unassigned', '—', 'New'],
  ]);
  expect(pdf.text.join(' ')).toContain('Leads Not Called');
});

test('Leads Not Called: nothing to list shows a toast instead of an empty PDF', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.renderReportsSubPage('leadscalls'));
  await expect(statVal(page, 'lcLeads', 'Leads Not Called')).toHaveText('0');
  await page.locator('#lcUncalledStat').click();
  await expect(page.locator('body')).toContainText('Every lead in this period has been called');
});
