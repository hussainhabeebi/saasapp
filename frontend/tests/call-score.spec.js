// Call & Convert score (call-score.js): the Leads page's personal strip + "Attend Next" card, and
// Reports → 📞 Calls & Conversions. Same hermetic file:// setup as lead-actions.spec.js — no
// backend, the page's own global render functions are driven directly with seeded leads.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');

const OWNER = 'boss@example.com';
const STAFF = 'rep@example.com';

async function boot(page, { me = OWNER } = {}) {
  await page.route('**/*', (route) => (route.request().url().startsWith('file://') ? route.continue() : route.abort()));
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ me, OWNER, STAFF }) => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    const now = Date.now();
    const iso = (msAgo) => new Date(now - msAgo).toISOString();
    const call = (by, msAgo, outcome = 'Answered') => ({ outcome, at: iso(msAgo), date: '', by, duration: 3 });
    // @ts-ignore
    myEmail = me;
    // @ts-ignore
    clientRecord = { authentik_email: OWNER, client_name: 'Boss', team_emails: STAFF, team_names: JSON.stringify({ [STAFF]: 'Rita' }),
      bot_config: JSON.stringify({ call_targets: { default: { calls: 2, won: 1 }, users: {} } }) };
    // @ts-ignore
    allLeads = [
      // Rita: two calls today (target 2 → hit), one conversion
      { Id: 1, Name: 'Won Lead', Phone: '919000000001', Owner: STAFF, Stage: 'won', Score: 'Hot', Date: iso(3 * 3600e3), ClosedAt: iso(60e3),
        CallLog: JSON.stringify([call(STAFF, 2 * 3600e3)].reverse()) },
      { Id: 2, Name: 'No Answer Lead', Phone: '919000000002', Owner: STAFF, Stage: 'new', Date: iso(5 * 86400e3),
        CallLog: JSON.stringify([call(STAFF, 4 * 86400e3, 'No Answer'), call(STAFF, 3 * 86400e3, 'No Answer'), call(STAFF, 3600e3, 'No Answer')].reverse()) },
      // Boss's own leads: one fresh Hot uncalled (attend next), one stale Hot uncalled 2 days (leakage + penalty)
      { Id: 3, Name: 'Fresh Hot', Phone: '919000000003', Owner: OWNER, Stage: 'new', Score: 'Hot', Date: iso(60e3) },
      { Id: 4, Name: 'Stale Hot', Phone: '919000000004', Owner: OWNER, Stage: 'new', Score: 'Hot', Date: iso(2 * 86400e3) },
      { Id: 5, Name: 'Called Already', Phone: '919000000005', Owner: OWNER, Stage: 'new', Date: iso(0), CallLog: JSON.stringify([call(OWNER, 600e3)]) },
    ];
  }, { me, OWNER, STAFF });
}

test('Leads page: personal strip and one Attend Next card with a single Call button', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    document.getElementById('pageLeads').classList.remove('hidden');
    window.renderLeadsMomentumStrip();
  });
  const strip = page.locator('#leadsMomentumStrip .cs-strip');
  await expect(strip).toContainText('1/2 calls');
  await expect(strip).toContainText('0/1 converted');
  // 1 answered call today (+15) minus 1 Hot lead uncalled 24h+ (−10)
  await expect(strip).toContainText('5 pts');

  const card = page.locator('#leadsMomentumStrip .cs-next');
  await expect(card).toHaveCount(1);
  // Both never called + Hot — the one that arrived a minute ago comes first (speed to lead)
  await expect(card).toContainText('Fresh Hot');
  await expect(card).toContainText('+30 if answered'); // answered +15, plus +15 for calling within 5 min
  await expect(card).toContainText('if converted');
  await expect(card.locator('.call-btn-wrap')).toHaveCount(1); // the card's only action
  await expect(card.locator('.call-main')).toBeVisible();
});

test('a staff member only sees their own numbers in the report', async ({ page }) => {
  await boot(page, { me: STAFF });
  await page.evaluate(() => {
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    document.getElementById('pageReports').classList.remove('hidden');
    window.renderReportsSubPage('calls');
  });
  const scorecard = page.locator('#reportsContent table.leads-tbl').first();
  await expect(scorecard.locator('tbody tr')).toHaveCount(1);
  await expect(scorecard).toContainText('Rita');
  await expect(page.locator('#reportsContent')).not.toContainText('Daily targets');
  await expect(page.locator('#reportsContent')).toContainText("You're #1 of 2");
});

test('owner report: scorecard, funnel, leakage and target editor', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    document.getElementById('pageReports').classList.remove('hidden');
    window.renderReportsSubPage('calls');
  });
  const content = page.locator('#reportsContent');
  const scorecard = content.locator('table.leads-tbl').first();
  await expect(scorecard.locator('tbody tr')).toHaveCount(2);
  const rita = scorecard.locator('tbody tr', { hasText: 'Rita' });
  // 4 calls, 1 answered, 1 converted out of 2 leads called
  await expect(rita.locator('td').nth(2)).toHaveText('4');
  await expect(rita.locator('td').nth(3)).toHaveText('25%');
  await expect(rita.locator('td').nth(5)).toHaveText('1');
  await expect(rita.locator('td').nth(6)).toHaveText('50%');

  await expect(content).toContainText('Call-to-convert funnel');
  await expect(content.locator('.card', { hasText: 'Hot leads not called in 24h+' })).toContainText('Stale Hot');
  await expect(content.locator('.card', { hasText: '3+ No Answers' })).toContainText('No Answer Lead');

  // Targets: save a per-user override through patchClient
  await page.evaluate(() => {
    // @ts-ignore
    window.patchClient = async (f) => { window.__saved = JSON.parse(f.bot_config); };
  });
  await content.locator('tr[data-email="rep@example.com"] .cs-tgt-calls').fill('40');
  await content.getByRole('button', { name: 'Save targets' }).click();
  await expect(page.locator('#csTgtMsg')).toHaveText('✓ Saved');
  const saved = await page.evaluate(() => window.__saved.call_targets);
  expect(saved).toEqual({ default: { calls: 2, won: 1 }, users: { 'rep@example.com': { calls: 40 } } });
});

test('CSV export picks up the report tables', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    document.getElementById('pageReports').classList.remove('hidden');
    window.renderReportsSubPage('calls');
  });
  const download = page.waitForEvent('download');
  await page.evaluate(() => window.exportReportCsv());
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^report-calls-/);
});
