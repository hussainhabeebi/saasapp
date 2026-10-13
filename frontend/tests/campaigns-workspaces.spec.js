// Campaigns page (broadcast.html) — Campaigns and Follow-ups workspaces. Hermetic: file://, every
// Worker request answered by the route stub below, nothing reaches a real backend.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pageUrl = 'file://' + path.resolve(__dirname, '../broadcast.html');
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

const LEADS = [
  { Id: 1, Name: 'Asha', Phone: '919800000001', Stage: 'new', Score: 'Hot', LastMsgAt: iso(now - 2 * 3600e3) },
  { Id: 2, Name: 'Ravi', Phone: '919800000002', Stage: 'contacted', Score: 'Warm', LastMsgAt: iso(now - 3 * 86400e3) },
  { Id: 3, Name: 'Meera', Phone: '919800000003', Stage: 'new', OptOut: 'Yes', LastMsgAt: iso(now - 86400e3 * 9) },
];
const LADDER = [
  { step: 1, type: 'session', hours: 1, message: 'Hi {name}', message_b: 'Hey {name}' },
  { step: 2, type: 'session', hours: 6, message: '' },
  { step: 3, type: 'template', template_name: 'lv_followup_s3' },
  { step: 4, type: 'template', template_name: '' },
  { step: 5, type: 'template', template_name: '' },
];
const REPORT = {
  days: 30, in_sequence: 4, currency: 'INR',
  totals: { sent: 40, replied: 10, reply_rate: 25, converted: 3, revenue: 4500, opted_out: 1, opt_out_rate: 2.5, leads_contacted: 30, leads_reengaged: 9 },
  steps: [{ step: 1, label: 'Nudge 1 · after 1h', sent: 30, replied: 9, reply_rate: 30, converted: 3, revenue: 4500, opted_out: 1, opt_out_rate: 3.3, conversion_rate: 10, health: 'watch', variants: [{ variant: 'A', sent: 30, replied: 9, reply_rate: 30 }] }],
  trend: [{ week_start: '2026-10-05', sent: 40, replied: 10, converted: 3 }],
  heatmap: Array.from({ length: 7 }, () => Array(24).fill(0)), best_slot: null, failures: [], templates: [], benchmark: null, status_counts: {},
};

async function open(page, { v3 = false, query = '' } = {}) {
  const settings = v3
    ? { enabled: true, enabled_at: iso(now - 86400e3), config: { paused: false, reengage_enabled: true, reengage_after_days: 30 }, checklist: [{ key: 'reengage', status: 'PENDING', label: 'Re-engage template' }] }
    : { enabled: false, config: {}, checklist: [] };
  await page.addInitScript(() => { localStorage.setItem('lv_cid', '42'); localStorage.setItem('lv_session', 'tok'); });
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('file://')) return route.continue();
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/records/42')) return json({ Id: 42, client_name: 'Acme Travel', industry: 'travel' });
    if (url.includes('/records?where=(ClientId')) return json({ list: LEADS, pageInfo: { isLastPage: true } });
    if (url.includes('/followups/ladder')) return json({ list: LADDER });
    if (url.includes('/followups/stats')) return json({ list: [{ step: 1, variant: 'A', sent: 12, replied: 3, reply_rate: 25 }] });
    if (url.includes('/followups/v3/settings')) return json(settings);
    if (url.includes('/followups/v3/report')) return json(REPORT);
    if (url.includes('/followups/v3/upcoming')) return json({ list: [{ lead_id: 1, lead_name: 'Asha', status: 'scheduled', next_step: 2, next_due_at: iso(now + 3 * 3600e3), label: 'Nudge 2 · after 6h' }] });
    if (url.includes('/followups/smart')) return json({ enabled: false });
    return json({});
  });
  await page.goto(pageUrl + query);
  await expect(page.locator('#main')).toBeVisible();
}

test('opens on the Campaigns home: start cards, audience numbers, follow-up status', async ({ page }) => {
  await open(page);
  await expect(page.locator('#view-home')).toBeVisible();
  await expect(page.locator('#wsFollowupsHead')).toBeHidden();
  await expect(page.locator('.cp-card')).toHaveCount(4);
  await expect(page.locator('#cpDmCount')).toHaveText('1 lead reachable now');
  await expect(page.locator('#cpAudience')).toContainText('3');
  await expect(page.locator('#cpFuText')).toContainText('Classic follow-ups');
  // Follow-up items aren't in the campaign sidebar any more.
  await expect(page.locator('#csb-fuengine')).toHaveCount(0);
  await page.locator('.cp-card', { hasText: 'Template broadcast' }).click();
  await expect(page.locator('#view-meta')).toBeVisible();
});

test('Follow-ups workspace, V3 off: header, promo, sequence map flags what is missing', async ({ page }) => {
  await open(page, { query: '?view=followups' });
  await expect(page.locator('#wsFollowupsHead')).toBeVisible();
  await expect(page.locator('.campaign-sidebar')).toBeHidden();
  await expect(page.locator('#fuHeadPill')).toHaveText('Classic');
  await expect(page.locator('#fuV3Promo')).toBeVisible();
  await expect(page.locator('#fuHeadKpis')).toContainText('25%');
  await page.locator('[data-fu="sequence"]').click();
  const nodes = page.locator('#fuTimeline .fu-node');
  await expect(nodes).toHaveCount(5);
  await expect(nodes.nth(0)).toContainText('A/B');
  await expect(nodes.nth(1)).toContainText('No message yet');
  await expect(nodes.nth(2)).toContainText('lv_followup_s3');
  await expect(nodes.nth(3)).toContainText('Pick a template');
  await page.locator('[data-fu="leads"]').click();
  await expect(page.locator('#view-followups')).toBeVisible();
});

test('Follow-ups workspace, V3 on: numbers from the report, re-engage step, upcoming list', async ({ page }) => {
  await open(page, { v3: true, query: '?view=followups' });
  await expect(page.locator('#fuHeadPill')).toHaveText('● V3 running');
  await expect(page.locator('#fuHeadKpis')).toContainText('INR 4,500');
  await expect(page.locator('#fuV3Promo')).toBeHidden();
  await expect(page.locator('#fv3ReportCard')).toBeVisible();
  await page.locator('[data-fu="sequence"]').click();
  await expect(page.locator('#fuTimeline .fu-node')).toHaveCount(6);
  await expect(page.locator('#fuTimeline .fu-node').nth(3)).toContainText('waiting for approval');
  await page.locator('[data-fu="upcoming"]').click();
  await expect(page.locator('#fv3Upcoming')).toContainText('Asha');
});

test('switching workspace from the standalone top bar, and a cross-link into Follow-ups settings', async ({ page }) => {
  await open(page);
  await page.locator('.ws-switch [data-ws="followups"]').click();
  await expect(page.locator('#wsFollowupsHead')).toBeVisible();
  await page.locator('.ws-switch [data-ws="campaigns"]').click();
  await expect(page.locator('#view-home')).toBeVisible();
  await page.evaluate(() => window.showTab('fuengine'));
  await expect(page.locator('#wsFollowupsHead')).toBeVisible();
});

test('dashboard: Campaigns and Follow-ups open inside Leadvyne, one shared embedded page', async ({ page }) => {
  const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');
  // No backend: the embedded page can't load the account, so it must show its own retry message
  // rather than reloading the whole dashboard.
  await page.route('**/*', (route) => (route.request().url().startsWith('file://') ? route.continue() : route.abort()));
  await page.addInitScript(() => { localStorage.setItem('lv_cid', '42'); localStorage.setItem('lv_session', 'tok'); });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  const opened = [];
  await page.exposeFunction('__opened', (u) => opened.push(u));
  await page.evaluate(() => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    window.open = (u) => { window.__opened(String(u)); return null; };
  });
  await page.locator('#dnFollowupsTab').click();
  await expect(page.locator('#pageBroadcast')).toBeVisible();
  await expect(page.locator('#campaignsFrame')).toHaveAttribute('src', 'broadcast.html?embed=1&view=followups');
  await expect(page.locator('#dnFollowupsTab')).toHaveClass(/active/);
  await page.locator('#dnCampaignsTab').click();
  await expect(page.locator('#pageBroadcast')).toBeVisible();
  await expect(page.locator('#campaignsFrame')).toHaveAttribute('src', 'broadcast.html?embed=1&view=followups'); // not reloaded
  await expect(page.locator('#dnCampaignsTab')).toHaveClass(/active/);
  expect(opened).toEqual([]);
  await expect(page.frameLocator('#campaignsFrame').locator('#gErr')).toContainText('try again');
  expect(page.url()).toBe(dashboardUrl);
});
