// Reports → 💸 Ads ROI growth tools: sales-based rules turned into suggested budget / pause changes
// the owner approves (and can undo), the staff-capacity guard, tracking health with the Conversion
// Leads checklist, CRM audiences, and the settings that drive them. Worker routes stubbed, UTC browser.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test.use({ timezoneId: 'UTC' });
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');
const OWNER = 'boss@example.com';
const dayStr = (n) => new Date(Date.now() - n * 86400e3).toISOString().slice(0, 10);
const D = dayStr(2);

// Couples (ad set 2001) runs on a campaign budget (CBO); UAE (2002) has its own budget but is paused.
const DATA = {
  connected: true, account_name: 'Acme Ads', currency: 'INR', tz_offset_min: 0, last_ok_at: new Date().toISOString(), hourly_from: D,
  ads: [
    { ad_id: '3001', ad_name: 'Reel', adset_id: '2001', adset_name: 'Couples', campaign_id: '1001', campaign_name: 'Kerala', spend: 1900, meta_leads: 0, meta_chats: 20,
      status: 'ACTIVE', adset_status: 'ACTIVE', campaign_status: 'ACTIVE', adset_budget: 0, campaign_budget: 2000 },
    { ad_id: '3002', ad_name: 'Promo', adset_id: '2002', adset_name: 'UAE', campaign_id: '1002', campaign_name: 'Dubai', spend: 600, meta_leads: 0, meta_chats: 2,
      status: 'PAUSED', adset_status: 'PAUSED', campaign_status: 'ACTIVE', adset_budget: 500, campaign_budget: 0 },
  ],
  ad_days: [{ day: D, ad_id: '3001', spend: 1900, meta_leads: 0, meta_chats: 20 }, { day: D, ad_id: '3002', spend: 600, meta_leads: 0, meta_chats: 2 }],
  hours: [], changes: [], days: [],
};
const RULE = { id: 'r1', enabled: true, metric: 'cost_per_sale', op: 'above', value: 1000, days: 7, min_spend: 500, level: 'adset', action: 'budget_down', pct: 20 };
const SETTINGS = {
  can_edit: true, connected: true, whatsapp_users: [],
  config: { rules: [RULE], capacity_guard: { enabled: false, max_uncalled: 20, pct: 20 }, max_change_pct: 30, min_daily_budget: 0,
    funnel_map: { qualified: 'QualifiedLead' }, send_junk: true, audiences_enabled: true, audience_country: 'IN', audience_ratio: 1 },
  audiences: [
    { key: 'buyers', name: 'LeadVyne — Buyers (last 180 days)', lookalike: true, desc: 'Won leads', audience_id: '9001', lookalike_id: '9002', size: 140, last_run_at: `${D}T03:00:00Z` },
    { key: 'hot_not_bought', name: 'LeadVyne — Hot, not bought (90 days)', desc: 'Hot leads', last_error: 'Accept the Custom Audience terms' },
  ],
  actions: [{ id: 11, at: `${D}T08:00:00Z`, target_type: 'adset', target_id: '2002', target_name: 'UAE', action: 'pause', before_json: '{"status":"ACTIVE"}', after_json: '{"status":"PAUSED"}', status: 'ok' }],
};
const HEALTH = {
  days: 7, pixel_connected: true, sent: 40, failed: 5, last_sent_at: new Date().toISOString(),
  by_event: [{ event: 'lead', sent: 30, failed: 5, strong: 20 }, { event: 'funnel:qualifiedlead', sent: 10, failed: 0, strong: 10 }],
  match: { lead_id: 20, ctwa_clid: 10, fbc: 0, hashed: 10 }, errors: [{ error: 'Invalid parameter', code: '100', n: 5 }],
  meta: { ok: true, received: { Lead: 31, QualifiedLead: 10 } },
};

async function boot(page, { settings = SETTINGS, leads, calls = [] } = {}) {
  await page.route('**/*', (route) => (route.request().url().startsWith('file://') ? route.continue() : route.abort()));
  await page.route('**/meta/ads-report/**', (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname.replace(/^.*\/meta\/ads-report/, '');
    if (req.method() === 'POST') {
      calls.push({ path: p, body: JSON.parse(req.postData() || '{}') });
      if (p === '/actions/apply') return route.fulfill({ json: { id: 12, name: 'Kerala', before: { daily_budget: 200000 }, after: { daily_budget: 160000 } } });
      if (p === '/settings') return route.fulfill({ json: { ok: true, config: calls.at(-1).body.config } });
      return route.fulfill({ json: { ok: true, results: [] } });
    }
    if (p === '/data') return route.fulfill({ json: DATA });
    if (p === '/first-messages') return route.fulfill({ json: { messages: {} } });
    if (p === '/settings') return route.fulfill({ json: settings });
    if (p === '/capi') return route.fulfill({ json: { rows: [] } });
    if (p === '/health') return route.fulfill({ json: HEALTH });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ OWNER, D, leads }) => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    // @ts-ignore
    myEmail = OWNER; clientRecord = { authentik_email: OWNER, client_name: 'Boss', deal_currency: 'INR', meta_leadgen_connected: true,
      flow_json: JSON.stringify({ stages: { qualified: {}, quote_sent: {} } }) };
    // @ts-ignore
    _rptOlder.at = Date.now(); _rptOlder.complete = true;
    // @ts-ignore
    allLeads = leads || [
      { Id: 1, Name: 'Buyer', AdId: '3001', Stage: 'won', DealValue: '9000', CreatedAt: `${D}T10:00:00Z`, Owner: OWNER },
      { Id: 2, Name: 'Asker', AdId: '3001', Stage: 'new', CreatedAt: `${D}T11:00:00Z`, Owner: OWNER },
      { Id: 3, Name: 'Dubai', AdId: '3002', Stage: 'new', CreatedAt: `${D}T11:00:00Z`, Owner: OWNER },
    ];
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    document.getElementById('pageReports').classList.remove('hidden');
    window.renderReportsSubPage('ads');
  }, { OWNER, D, leads });
}

test('a triggered rule becomes a suggestion; approving sends it to Meta; past changes can be undone', async ({ page }) => {
  const calls = [];
  await boot(page, { calls });
  const items = page.locator('#adsProposals > div');
  // Couples: ₹1,900 for 1 sale > ₹1,000 → cut 20%; its budget is on the Kerala campaign (CBO), so the
  // change targets the campaign. UAE has no sale but is paused, so nothing is suggested for it.
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText('Cut daily budget 20% (₹2,000 → ₹1,600) — Kerala (campaign budget)');
  await expect(items.first()).toContainText('Cost per sale ₹1,900 above ₹1,000 over 7 days');
  await items.first().getByRole('button', { name: 'Approve' }).click();
  await expect.poll(() => calls.find((c) => c.path === '/actions/apply')?.body).toMatchObject({ target_type: 'campaign', target_id: '1001', action: 'budget_down', pct: 20 });

  await expect(page.locator('#adsActionLog')).toContainText('UAE · Paused · ok');
  await page.locator('#adsActionLog').getByRole('button', { name: '↩ Undo' }).click();
  await expect.poll(() => calls.find((c) => c.path === '/actions/undo')?.body).toEqual({ id: 11 });
});

test('staff-capacity guard: too many ad leads waiting for a call → slow the WhatsApp ads', async ({ page }) => {
  const now = Date.now();
  const recent = (i) => ({ Id: 10 + i, Name: 'Wait ' + i, AdId: '3001', Stage: 'new', CreatedAt: new Date(now - (i + 1) * 3600e3).toISOString(), Owner: OWNER });
  const settings = { ...SETTINGS, config: { ...SETTINGS.config, rules: [], capacity_guard: { enabled: true, max_uncalled: 3, pct: 25 } } };
  await boot(page, { settings, leads: [0, 1, 2, 3].map(recent) });
  await expect(page.locator('#adsActions')).toContainText('4 ad leads are waiting for a first call');
  const items = page.locator('#adsProposals > div');
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText('Cut daily budget 25% (₹2,000 → ₹1,500) — Kerala (campaign budget)');
});

test('read-only staff see suggestions but cannot approve', async ({ page }) => {
  await boot(page, { settings: { ...SETTINGS, can_edit: false } });
  await expect(page.locator('#adsProposals > div')).toHaveCount(1);
  await expect(page.locator('#adsProposals button')).toHaveCount(0);
  await expect(page.locator('#adsActions')).toContainText('the account owner approves it');
});

test('tracking health: totals, events with Meta counts, refusals and the Conversion Leads checklist', async ({ page }) => {
  await boot(page);
  const stat = (label) => page.locator('#adsHealth .stat', { has: page.locator('.stat-lbl', { hasText: new RegExp(`^${label}$`) }) }).locator('.stat-val');
  await expect(stat('Events sent')).toHaveText('40');
  await expect(stat('Refused by Meta')).toHaveText('5');
  await expect(stat('Matched by ad click')).toHaveText('75%');
  await expect(page.locator('#adsHealthEvents tbody tr').nth(1).locator('td')).toHaveText(['QualifiedLead', '10', '0', '100%', '10']);
  await expect(page.locator('#adsHealthErrors')).toContainText('5× Invalid parameter (code 100)');
  const cl = page.locator('#adsCLChecklist');
  await expect(cl).toContainText('✅ Lead forms connected');
  await expect(cl).toContainText('⚠️ Funnel stages mapped to events (1)');
  await expect(cl).toContainText('✅ Funnel events reached Meta (10)');
  await expect(cl).toContainText('⚠️ Meta accepts the events');
});

test('CRM audiences: sizes, lookalike, errors and Refresh now', async ({ page }) => {
  const calls = [];
  await boot(page, { calls });
  await expect(page.locator('#adsAudTbl tbody tr').first().locator('td').nth(1)).toHaveText('140');
  await expect(page.locator('#adsAudTbl tbody tr').first().locator('td').nth(2)).toHaveText('✅ created');
  await expect(page.locator('#adsAudTbl tbody tr').nth(1)).toContainText('Accept the Custom Audience terms');
  await page.locator('#adsAudRefresh').click();
  await expect.poll(() => calls.some((c) => c.path === '/audiences/refresh')).toBe(true);
});

test('settings: funnel events, audiences, rules and the capacity guard are saved', async ({ page }) => {
  const calls = [];
  await boot(page, { calls });
  await expect(page.locator('#adsFunnelMap input[data-stage="qualified"]')).toHaveValue('QualifiedLead');
  await page.locator('#adsFunnelMap input[data-stage="won"]').fill('Purchase Done');
  await page.locator('#adsRulesBox button', { hasText: 'Pause when spend with no sale is above 3000' }).click();
  await expect(page.locator('#adsRules .ads-rule')).toHaveCount(2);
  await page.locator('#adsCapOn').check();
  await page.locator('#adsCapMax').fill('15');
  await page.locator('#adsAudCountry').fill('ae');
  await page.locator('#adsSettingsSave').click();
  await expect.poll(() => calls.find((c) => c.path === '/settings')?.body.config).toMatchObject({
    funnel_map: { qualified: 'QualifiedLead', won: 'Purchase Done' },
    send_junk: true, audiences_enabled: true, audience_country: 'AE',
    capacity_guard: { enabled: true, max_uncalled: 15, pct: 20 },
    rules: [{ id: 'r1', metric: 'cost_per_sale', value: 1000, action: 'budget_down', pct: 20 },
      { metric: 'no_sales_spend', op: 'above', value: 3000, action: 'pause', level: 'adset', days: 7 }],
  });
});
