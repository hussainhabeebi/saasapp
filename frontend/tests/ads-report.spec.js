// Reports → 💸 Ads ROI (ads-report.js): Meta spend joined with the CRM's own ad leads — spend vs
// sales per campaign/ad set/ad, lead quality, speed to lead, staff, Conversions API results and the
// summary/alerts/accounting settings. Hermetic file:// page; the Worker's /meta/ads-report/* routes
// are stubbed, everything else is blocked.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');
const OWNER = 'boss@example.com';
const STAFF = 'rep@example.com';

const DATA = {
  connected: true, account_name: 'Acme Ads', currency: 'INR', last_ok_at: new Date().toISOString(), last_error: '',
  ads: [
    { ad_id: 'A1', ad_name: 'Reel 3', adset_id: 'S1', adset_name: 'Couples 25-40', campaign_id: 'C1', campaign_name: 'Kerala', spend: 3000, impressions: 9000, clicks: 90, meta_leads: 5, meta_chats: 0 },
    { ad_id: 'A2', ad_name: 'Promo', adset_id: 'S2', adset_name: 'UAE', campaign_id: 'C2', campaign_name: 'Dubai', spend: 1000, impressions: 4000, clicks: 10, meta_leads: 0, meta_chats: 2 },
  ],
  days: [],
};
const SETTINGS = {
  config: { summary_enabled: true, summary_staff: [STAFF], summary_emails: [OWNER], summary_template: '', summary_template_lang: 'en', alerts_enabled: false, alert_spend_no_leads: 0, alert_cpl_max: 0, alert_junk_pct: 0, accounting_post: false },
  can_edit: true, accounting_enabled: true, whatsapp_users: [STAFF], whatsapp_connected: true, currency: 'INR',
  sends: [], expense_posts: [{ month: '2026-10', amount: 4000, currency: 'INR', status: 'posted' }],
};
const CAPI = { pixel_connected: true, rows: [{ event: 'lead', match_key: 'ctwa_clid', n: 3 }, { event: 'purchase', match_key: 'lead_id', n: 1 }, { event: 'qualified', match_key: 'hashed', n: 1 }] };

async function boot(page, { data = DATA, settings = SETTINGS } = {}) {
  const posts = [];
  await page.route('**/*', (route) => (route.request().url().startsWith('file://') ? route.continue() : route.abort()));
  await page.route('**/meta/ads-report/**', (route) => {
    const u = new URL(route.request().url());
    const p = u.pathname.replace(/^.*\/meta\/ads-report/, '');
    if (route.request().method() === 'POST') {
      posts.push({ path: p, body: route.request().postData() });
      const body = p === '/settings' ? { ok: true, config: JSON.parse(route.request().postData()).config } : { ok: true, results: [{ to: STAFF, ok: true }] };
      return route.fulfill({ json: body });
    }
    if (p === '/data') return route.fulfill({ json: { ...data, from: u.searchParams.get('from'), to: u.searchParams.get('to') } });
    if (p === '/settings') return route.fulfill({ json: settings });
    if (p === '/capi') return route.fulfill({ json: CAPI });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ OWNER, STAFF }) => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    const now = Date.now();
    const ago = (h) => new Date(now - h * 3600e3).toISOString();
    const after = (iso, min) => new Date(Date.parse(iso) + min * 60e3).toISOString();
    const call = (at, outcome) => ({ outcome, at, by: STAFF, duration: 2 });
    const t1 = ago(50), t2 = ago(40), t3 = ago(30), t4 = ago(20), t5 = ago(10), t6 = ago(5);
    // @ts-ignore
    myEmail = OWNER;
    // @ts-ignore
    clientRecord = { authentik_email: OWNER, client_name: 'Boss', deal_currency: 'INR', team_emails: STAFF, team_names: JSON.stringify({ [STAFF]: 'Rita' }) };
    // @ts-ignore
    _rptOlder.at = Date.now(); _rptOlder.complete = true;
    // @ts-ignore
    allLeads = [
      // Kerala / Reel 3: won (₹30,000), called 3 min after arriving
      { Id: 1, Name: 'Won Couple', AdId: 'A1', CtwaClid: 'clid1', Score: 'Hot', Stage: 'won', DealValue: '30000', Owner: STAFF, CreatedAt: t1, Date: ago(1),
        CallLog: JSON.stringify([call(after(t1, 3), 'Answered')]) },
      // Kerala / Reel 3: called after 2 hours, never answered
      { Id: 2, Name: 'No Pickup', AdId: 'A1', Score: 'Warm', Stage: 'new', Owner: STAFF, CreatedAt: t2, CallLog: JSON.stringify([call(after(t2, 120), 'No Answer')]) },
      // Dubai: junk
      { Id: 3, Name: 'Spammer', AdId: 'A2', HandoverOutcome: 'Spam', Stage: 'lost', Owner: OWNER, CreatedAt: t3 },
      // Kerala by campaign name only (older lead-form lead), not called
      { Id: 4, Name: 'Form Lead', LeadSource: 'Facebook Lead Ad', AdCampaign: 'Kerala', Score: 'Cold', Stage: 'new', Owner: OWNER, CreatedAt: t4 },
      // Not an ad lead
      { Id: 5, Name: 'Organic', Source: 'WhatsApp', Stage: 'won', DealValue: '9999', Owner: OWNER, CreatedAt: t5 },
      // Ad lead from a campaign that isn't in the synced spend
      { Id: 6, Name: 'Old Campaign', LeadSource: 'Instagram Lead Ad', AdCampaign: 'Summer 2024', Stage: 'new', Owner: OWNER, CreatedAt: t6 },
    ];
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    document.getElementById('pageReports').classList.remove('hidden');
  }, { OWNER, STAFF });
  return posts;
}

const statVal = (page, box, label) =>
  page.locator(`#${box} .stat`, { has: page.locator('.stat-lbl', { hasText: new RegExp(`^${label}$`) }) }).locator('.stat-val');
const row = (page, table, name) => page.locator(`#${table} tbody tr`, { has: page.locator('td', { hasText: name }) }).first().locator('td');

test('spend vs sales per campaign, totals and ROAS', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.renderReportsSubPage('ads'));
  await expect(page.locator('#reportsSubNav .hosp-tab.active')).toHaveAttribute('data-reports', 'ads');
  await expect(statVal(page, 'adsKpis', 'Spend')).toHaveText('₹4,000');
  await expect(statVal(page, 'adsKpis', 'Ad leads in CRM')).toHaveText('5');
  await expect(statVal(page, 'adsKpis', 'Qualified')).toHaveText('1');
  await expect(statVal(page, 'adsKpis', 'Junk')).toHaveText('1');
  await expect(statVal(page, 'adsKpis', 'Sales')).toHaveText('1');
  await expect(statVal(page, 'adsKpis', 'Revenue')).toHaveText('₹30,000');
  await expect(statVal(page, 'adsKpis', 'ROAS')).toHaveText('7.5×');
  await expect(statVal(page, 'adsKpis', 'Cost / lead')).toHaveText('₹800');
  // Campaign | Spend | Meta counted | CRM leads | Qualified | Sales | Revenue | Cost/lead | Cost/qualified | Cost/sale | ROAS
  await expect(row(page, 'adsTable', 'Kerala')).toHaveText([/Kerala/, '₹3,000', '5', '3', '1', '1', '₹30,000', '₹1,000', '₹3,000', '₹3,000', '10.0×']);
  await expect(row(page, 'adsTable', 'Dubai')).toHaveText([/Dubai/, '₹1,000', '2', '1', '0', '0', '₹0', '₹1,000', '—', '—', '—']);
  await expect(row(page, 'adsTable', 'not matched')).toHaveText([/not matched/, '₹0', '0', '1', '0', '0', '₹0', '—', '—', '—', '—']);
  await expect(page.locator('#adsTable tbody tr')).toHaveCount(3);
});

test('ad level splits Kerala into the ad and its campaign-level-only lead', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.renderReportsSubPage('ads'));
  await page.locator('#adsLevelBtns [data-level="ad"]').click();
  await expect(page.locator('#adsTable thead th').first()).toHaveText('Ad');
  await expect(row(page, 'adsTable', 'Reel 3')).toHaveText([/Reel 3.*Kerala › Couples 25-40/, '₹3,000', '5', '2', '1', '1', '₹30,000', '₹1,500', '₹3,000', '₹3,000', '10.0×']);
  await expect(row(page, 'adsTable', 'Ad not known')).toHaveText([/Kerala.*Ad not known/, '₹0', '0', '1', '0', '0', '₹0', '—', '—', '—', '—']);
  await expect(page.locator('#adsTable tbody tr')).toHaveCount(4);
});

test('lead quality, speed to lead and staff on ad leads', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.renderReportsSubPage('ads'));
  // Campaign | Leads | Hot | Warm | Cold | Junk | Not reachable | Lost | Qualified rate
  await expect(row(page, 'adsQuality', 'Kerala')).toHaveText(['Kerala', '3', '1', '1', '1', '0 (0%)', '1 (33%)', '0', '33%']);
  await expect(row(page, 'adsQuality', 'Dubai')).toHaveText(['Dubai', '1', '0', '1', '0', '1 (100%)', '0 (0%)', '0', '0%']);
  // Junk left out: 4 leads — 1 called in 3 min, 1 after 2 h, 2 never
  await expect(statVal(page, 'adsSpeed', 'Called within 5 min')).toHaveText('25%');
  await expect(statVal(page, 'adsSpeed', 'Within 24 hours')).toHaveText('50%');
  await expect(statVal(page, 'adsSpeed', 'Never called')).toHaveText('2');
  await expect(statVal(page, 'adsSpeed', 'Median first call')).toHaveText('3 min');
  await expect(page.locator('#adsNotCalled a')).toHaveText([/^Form Lead/, /^Old Campaign/]);
  // Staff | Ad leads | Called | Answered | Median first call | Qualified | Sales | Revenue | Conversion
  await expect(row(page, 'adsStaff', 'Rita')).toHaveText(['Rita', '2', '100%', '50%', '3 min', '1', '1', '₹30,000', '50%']);
  await expect(row(page, 'adsStaff', 'Boss')).toHaveText(['Boss', '3', '0%', '0%', '—', '0', '0', '₹0', '0%']);
});

test('member filter narrows leads but keeps account spend, with a note', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { window.renderReportsSubPage('ads'); window.rptPopulateMemberFilter(); });
  await expect(statVal(page, 'adsKpis', 'Ad leads in CRM')).toHaveText('5');
  await page.locator('#rptMember').selectOption(STAFF);
  await expect(statVal(page, 'adsKpis', 'Ad leads in CRM')).toHaveText('2');
  await expect(statVal(page, 'adsKpis', 'Spend')).toHaveText('₹4,000');
  await expect(page.locator('#reportsContent')).toContainText('Spend is for the whole ad account');
});

test('not connected: spend columns blank, CRM numbers still shown', async ({ page }) => {
  await boot(page, { data: { connected: false, ads: [], days: [] } });
  await page.evaluate(() => window.renderReportsSubPage('ads'));
  await expect(page.locator('#adsNotConnected')).toContainText('Spend isn\'t connected');
  await expect(statVal(page, 'adsKpis', 'Spend')).toHaveText('—');
  await expect(statVal(page, 'adsKpis', 'Ad leads in CRM')).toHaveText('5');
  // Nothing synced to match against: every ad lead is "not matched"
  await expect(row(page, 'adsTable', 'not matched')).toHaveText([/not matched/, '—', '—', '5', '1', '1', '₹30,000', '—', '—', '—', '—']);
});

test('results sent to Meta by match key, and the settings save', async ({ page }) => {
  const posts = await boot(page);
  await page.evaluate(() => window.renderReportsSubPage('ads'));
  const capiRow = (name) => page.locator('#adsCapi tbody tr', { has: page.locator('td', { hasText: new RegExp(`^${name}$`) }) }).locator('td');
  await expect(capiRow('Lead')).toHaveText(['Lead', '3', '0', '0', '0', '3']);
  await expect(capiRow('Purchase')).toHaveText(['Purchase', '0', '1', '0', '0', '1']);
  await expect(page.locator('#adsCapi')).toContainText('80% matched by the ad click itself');

  await expect(page.locator('#adsSumOn')).toBeChecked();
  await expect(page.locator(`#adsSumStaff input[value="${STAFF}"]`)).toBeChecked();
  await expect(page.locator(`#adsSumStaff input[value="${OWNER}"]`)).toBeDisabled(); // no WhatsApp number on file
  await expect(page.locator('#adsExpensePosts')).toContainText('2026-10 · ₹4,000 · posted');
  await page.locator('#adsAlertOn').check();
  await page.locator('#adsAlertSpend').fill('500');
  await page.locator('#adsSettingsSave').click();
  await expect(page.locator('#adsSettingsMsg')).toHaveText('✓ Saved');
  const saved = JSON.parse(posts.find((p) => p.path === '/settings').body).config;
  expect(saved).toMatchObject({ summary_enabled: true, summary_staff: [STAFF], summary_emails: OWNER, alerts_enabled: true, alert_spend_no_leads: 500, accounting_post: false });
});

test('a teammate sees the settings read-only', async ({ page }) => {
  await boot(page, { settings: { ...SETTINGS, can_edit: false } });
  await page.evaluate(() => window.renderReportsSubPage('ads'));
  await expect(page.locator('#adsSettings')).toContainText('Only the account owner can change these');
  await expect(page.locator('#adsSumOn')).toBeDisabled();
  await expect(page.locator('#adsSettingsSave')).toHaveCount(0);
});
