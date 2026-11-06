// Reports → 💸 Ads ROI: leads with no ad id matched to ads (ad code in the first message, message vs
// the ad's headline, time-window share across the ads running in that hour/day), ads running in the
// period with their timeline and status changes, day by day, creative leaderboard with fatigue,
// the leads behind a number and ▲/▼ vs the previous period. Worker routes stubbed, UTC browser.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test.use({ timezoneId: 'UTC' });
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');
const OWNER = 'boss@example.com';
const dayStr = (n) => new Date(Date.now() - n * 86400e3).toISOString().slice(0, 10);
const D = dayStr(2), D1 = dayStr(3), D2 = dayStr(4), D3 = dayStr(5);

const DATA = {
  connected: true, account_name: 'Acme Ads', currency: 'INR', tz_offset_min: 0, last_ok_at: new Date().toISOString(), hourly_from: D,
  ads: [
    { ad_id: 'A1', ad_name: 'Reel 3 #K26', adset_id: 'S1', adset_name: 'Couples', campaign_id: 'C1', campaign_name: 'Kerala', spend: 1500, meta_leads: 0, meta_chats: 27, status: 'ACTIVE', headline: 'Kerala honeymoon houseboat package' },
    { ad_id: 'A2', ad_name: 'Promo', adset_id: 'S2', adset_name: 'UAE', campaign_id: 'C2', campaign_name: 'Dubai', spend: 600, meta_leads: 0, meta_chats: 2, status: 'PAUSED', headline: 'Dubai visa 30 days' },
    { ad_id: 'A3', ad_name: 'Story', adset_id: 'S1', adset_name: 'Couples', campaign_id: 'C1', campaign_name: 'Kerala', spend: 400, meta_leads: 0, meta_chats: 0, status: 'DISAPPROVED', headline: 'Munnar tea gardens trip' },
  ],
  ad_days: [
    { day: D3, ad_id: 'A1', spend: 100, meta_leads: 0, meta_chats: 10 },
    { day: D2, ad_id: 'A1', spend: 100, meta_leads: 0, meta_chats: 10 },
    { day: D1, ad_id: 'A1', spend: 300, meta_leads: 0, meta_chats: 3 },
    { day: D, ad_id: 'A1', spend: 1000, meta_leads: 0, meta_chats: 4 },
    { day: D, ad_id: 'A2', spend: 600, meta_leads: 0, meta_chats: 2 },
    { day: D, ad_id: 'A3', spend: 400, meta_leads: 0, meta_chats: 0 },
  ],
  hours: [
    { day: D, hour: 10, ad_id: 'A1', spend: 100, meta_leads: 0, meta_chats: 2 },
    { day: D, hour: 10, ad_id: 'A2', spend: 100, meta_leads: 0, meta_chats: 2 },
    { day: D, hour: 14, ad_id: 'A1', spend: 100, meta_leads: 0, meta_chats: 2 },
  ],
  changes: [{ day: D, ad_id: 'A2', ad_name: 'Promo', campaign_name: 'Dubai', kind: 'status', detail: 'Active → Paused' }],
  days: [],
};
const PREV = { ...DATA, ads: DATA.ads.map((a) => ({ ...a, spend: a.spend / 2 })), ad_days: [], hours: [], changes: [] };
const MSGS = { 1: 'Hi I want the offer #K26', 2: 'Is the Dubai visa for 30 days available?', 3: 'hello', 4: 'hi', 5: 'hi there' };

async function boot(page) {
  await page.route('**/*', (route) => (route.request().url().startsWith('file://') ? route.continue() : route.abort()));
  await page.route('**/meta/ads-report/**', (route) => {
    const u = new URL(route.request().url());
    const p = u.pathname.replace(/^.*\/meta\/ads-report/, '');
    if (p === '/data') return route.fulfill({ json: u.searchParams.get('to') < D3 ? PREV : DATA });
    if (p === '/first-messages') return route.fulfill({ json: { messages: MSGS } });
    if (p === '/settings') return route.fulfill({ json: { config: {}, can_edit: false, whatsapp_users: [] } });
    if (p === '/capi') return route.fulfill({ json: { rows: [] } });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ OWNER, D }) => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    const at = (hm) => `${D}T${hm}:00Z`;
    // @ts-ignore
    myEmail = OWNER; clientRecord = { authentik_email: OWNER, client_name: 'Boss', deal_currency: 'INR' };
    // @ts-ignore
    _rptOlder.at = Date.now(); _rptOlder.complete = true;
    // @ts-ignore
    allLeads = [
      { Id: 1, Name: 'Code Lead', Source: 'WhatsApp', CreatedVia: 'chatwoot', Stage: 'new', CreatedAt: at('09:00'), Owner: OWNER },
      { Id: 2, Name: 'Headline Lead', Source: 'WhatsApp', CreatedVia: 'chatwoot', Stage: 'new', CreatedAt: at('11:00'), Owner: OWNER },
      { Id: 3, Name: 'Hour Lead A', Source: 'WhatsApp', CreatedVia: 'chatwoot', Stage: 'new', CreatedAt: at('10:20'), Owner: OWNER },
      { Id: 4, Name: 'Hour Lead B', Source: 'WhatsApp', CreatedVia: 'chatwoot', Stage: 'new', CreatedAt: at('10:40'), Owner: OWNER },
      { Id: 5, Name: 'Night Lead', Source: 'WhatsApp', CreatedVia: 'chatwoot', Stage: 'new', CreatedAt: at('03:00'), Owner: OWNER },
      { Id: 6, Name: 'Buyer', Source: 'Click-to-WhatsApp ad', CreatedVia: 'chatwoot', Stage: 'won', DealValue: '9000', CreatedAt: at('14:30'), Owner: OWNER },
      { Id: 7, Name: 'Walk-in', Source: 'Walk-in', CreatedVia: 'manual', Stage: 'won', DealValue: '5000', CreatedAt: at('12:00'), Owner: OWNER },
    ];
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    document.getElementById('pageReports').classList.remove('hidden');
    window.renderReportsSubPage('ads');
  }, { OWNER, D });
}
const statVal = (page, box, label) => page.locator(`#${box} .stat`, { has: page.locator('.stat-lbl', { hasText: new RegExp(`^${label}$`) }) }).locator('.stat-val');
const row = (page, table, name) => page.locator(`#${table} tbody tr`, { has: page.locator('td', { hasText: name }) }).first().locator('td');

test('every lead matched by its strongest method; coverage adds up', async ({ page }) => {
  await boot(page);
  // Code → A1; headline → A2; 10:xx chats share A1/A2 50/50 (hour buckets); 03:00 has no hourly
  // chats → shared by the day's 4:2; the ad-sourced buyer at 14:30 → A1 (the only ad with chats then).
  await expect(statVal(page, 'adsCoverage', 'Exact')).toHaveText('0');
  await expect(statVal(page, 'adsCoverage', 'Ad code')).toHaveText('1');
  await expect(statVal(page, 'adsCoverage', 'Message match')).toHaveText('1');
  await expect(statVal(page, 'adsCoverage', 'Time-window share')).toHaveText('4');
  await expect(statVal(page, 'adsKpis', 'Ad leads in CRM')).toHaveText('6');
  await expect(row(page, 'adsTable', 'Kerala')).toHaveText([/Kerala/, '₹1,900', '27', '1 + 2.7 est.', '1', '1', '₹9,000', '₹518', '₹1,900', '₹1,900', '4.7×']);
  await expect(row(page, 'adsTable', 'Dubai')).toHaveText([/Dubai/, '₹600', '2', '1 + 1.3 est.', '0', '0', '₹0', '₹257', '—', '—', '—']);
});

test('estimates can be left out; the leads behind a number show how each was matched', async ({ page }) => {
  await boot(page);
  await page.locator('#adsLeadsList').waitFor({ state: 'detached' }).catch(() => {});
  await row(page, 'adsTable', 'Kerala').nth(3).locator('a').click();
  const list = page.locator('#adsLeadsList tbody tr');
  await expect(list).toHaveCount(5);
  await expect(page.locator('#adsLeadsList tbody tr', { hasText: 'Code Lead' }).locator('td').nth(2)).toHaveText('Ad code');
  await expect(page.locator('#adsLeadsList tbody tr', { hasText: 'Night Lead' }).locator('td').nth(3)).toHaveText('67%');
  await expect(page.locator('#adsLeadsList tbody tr', { hasText: 'Buyer' }).locator('td').nth(2)).toHaveText('Time-window share');
  await page.locator('#adsLeadsPop button').click();
  await expect(page.locator('#adsLeadsList')).toHaveCount(0);
  await page.locator('#adsInclEst').uncheck();
  await expect(row(page, 'adsTable', 'Kerala').nth(3)).toHaveText('1');
  await expect(statVal(page, 'adsKpis', 'Ad leads in CRM')).toHaveText('2');
});

test('ads running in the period: status, first/last day, timeline, what changed', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#adsRunning .s-head').first()).toHaveText('🟢 Ads running in this period (3)');
  await expect(row(page, 'adsRunningTbl', 'Reel 3').nth(1)).toHaveText(/Active/);
  await expect(row(page, 'adsRunningTbl', 'Reel 3').nth(2)).toHaveText(D3);
  await expect(row(page, 'adsRunningTbl', 'Reel 3').nth(3)).toHaveText(D);
  await expect(row(page, 'adsRunningTbl', 'Reel 3').nth(4)).toHaveText('4');
  // Leads and sales per ad: Reel 3 = code lead + half of each 10:xx chat + 4/6 of the night chat + the buyer.
  await expect(row(page, 'adsRunningTbl', 'Reel 3').nth(7)).toHaveText('3.7');
  await expect(row(page, 'adsRunningTbl', 'Reel 3').nth(8)).toHaveText('1');
  await expect(row(page, 'adsRunningTbl', 'Reel 3').nth(9)).toHaveText('₹1,500');
  await expect(row(page, 'adsRunningTbl', 'Promo').nth(7)).toHaveText('2.3');
  await expect(row(page, 'adsRunningTbl', 'Story').nth(7)).toHaveText('0');
  await expect(row(page, 'adsRunningTbl', 'Promo').nth(1)).toHaveText(/Paused/);
  await expect(row(page, 'adsRunningTbl', 'Story').nth(1)).toHaveText(/Rejected/);
  await expect(row(page, 'adsRunningTbl', 'Reel 3').nth(10).locator('span')).toHaveCount(90);
  await expect(page.locator('#adsChanges')).toContainText('Promo (Dubai) — Active → Paused');
});

test('day by day, leaderboard with fatigue, heatmap and change vs the previous period', async ({ page }) => {
  await boot(page);
  await expect(row(page, 'adsDays', D)).toHaveText([D, '₹2,000', '3', '6', '6', '1', '₹333']);
  const top = page.locator('#adsLeaders tbody tr').first().locator('td');
  await expect(top.nth(1)).toContainText('Reel 3');
  await expect(top.nth(7)).toHaveText('1');
  await expect(top.nth(9)).toHaveText('₹1,500');
  await expect(top.nth(10)).toHaveText(/⚠️ \+\d+%/);
  await expect(page.locator('#adsHeatmap > span')).toHaveCount(25 + 7 * 25);
  // Previous period: same ads at half the spend → spend ▲ 100%.
  await expect(page.locator('#adsKpis .stat', { has: page.locator('.stat-lbl', { hasText: /^Spend$/ }) })).toContainText('▲ 100% vs prev.');
});
