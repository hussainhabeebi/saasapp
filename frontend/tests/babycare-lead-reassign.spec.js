// Baby Care: Settings → 🔀 Lead Routing "On leave" + "Reassign unopened leads", and opening a lead
// (dashboard detail pane, Chats thread) telling the Worker so it isn't reassigned as unattended.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');
const BC = JSON.stringify({ ecom_communication_style: 'baby_care' });

async function setup(page, { babyCare = true, routing = {} } = {}) {
  const calls = [];
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.protocol === 'file:') return route.continue();
    calls.push({ path: url.pathname, method: req.method(), body: req.postData(), auth: req.headers()['authorization'] || '' });
    if (url.pathname.endsWith('/leads/opened')) return route.fulfill({ json: { ok: true } });
    if (/\/records\/\d+$/.test(url.pathname)) return route.fulfill({ json: {} });
    return route.fulfill({ json: { list: [] } });
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(([bc, rt]) => {
    // @ts-ignore
    clientId = '7'; myEmail = 'boss@x.com'; sessionToken = 'tok';
    // @ts-ignore
    clientRecord = { client_name: 'Couplo', industry: 'ecommerce', bot_config: bc, authentik_email: 'boss@x.com',
      team_emails: 'a@x.com,b@x.com', team_names: JSON.stringify({ 'a@x.com': 'Anu', 'b@x.com': 'Bilal' }), lead_routing: JSON.stringify(rt) };
    // @ts-ignore
    window.__saved = []; patchClient = async (f) => { window.__saved.push(f); clientRecord = { ...clientRecord, ...f }; };
  }, [babyCare ? BC : '{}', routing]);
  return calls;
}

test('owner marks a teammate on leave and turns on unopened-lead reassignment', async ({ page }) => {
  await setup(page, { routing: { enabled: true, modes: ['roundrobin'], rules: { 'a@x.com': { inPool: true }, 'b@x.com': { inPool: true } } } });
  // @ts-ignore
  await page.evaluate(() => renderLeadRoutingSettings());
  const card = page.locator('#leadRoutingCard');
  await expect(card).toContainText('👀 Reassign unopened leads');
  // the Settings page itself is hidden in this harness — set the inputs directly
  await page.evaluate(() => {
    document.querySelector('#leadRoutingCard [data-email="a@x.com"][data-field="onLeave"]').checked = true;
    document.getElementById('lrUnattendedEnabled').checked = true;
    document.getElementById('lrUnattendedHours').value = '2';
  });
  // @ts-ignore
  await page.evaluate(() => saveLeadRouting());
  // @ts-ignore
  const saved = JSON.parse((await page.evaluate(() => window.__saved))[0].lead_routing);
  expect(saved.rules['a@x.com']).toMatchObject({ inPool: true, onLeave: true });
  expect(saved.rules['b@x.com'].onLeave).toBe(false);
  expect(saved.unattended).toMatchObject({ enabled: true, hours: 2 });
  expect(saved.unattended.enabledAt).toBeTruthy();
  // re-rendered from the saved state
  await expect(card.locator('[data-email="a@x.com"][data-field="onLeave"]')).toBeChecked();
});

test('other stores see no on-leave column or unopened-lead option', async ({ page }) => {
  await setup(page, { babyCare: false, routing: { enabled: true, rules: {} } });
  // @ts-ignore
  await page.evaluate(() => renderLeadRoutingSettings());
  await expect(page.locator('#leadRoutingCard #lrHotEnabled')).toBeAttached();
  await expect(page.locator('#leadRoutingCard #lrUnattendedEnabled')).toHaveCount(0);
  await expect(page.locator('#leadRoutingCard [data-field="onLeave"]')).toHaveCount(0);
});

test('opening a lead records it for Baby Care only', async ({ page }) => {
  const calls = await setup(page);
  // @ts-ignore
  await page.evaluate(() => { allLeads = [{ Id: 12, Name: 'Lead 12', Phone: '919876500012', Stage: 'new', ConvHistory: '[]' }]; openDetail(12); });
  await expect.poll(() => calls.filter(c => c.path.endsWith('/leads/opened')).length).toBe(1);
  const c = calls.find(c => c.path.endsWith('/leads/opened'));
  expect(JSON.parse(c.body)).toEqual({ lead_id: 12 });
  expect(c.auth).toBe('Bearer tok');

  // @ts-ignore
  await page.evaluate(() => { clientRecord = { ...clientRecord, bot_config: '{}' }; openDetail(12); });
  await page.waitForTimeout(300);
  expect(calls.filter(c => c.path.endsWith('/leads/opened')).length).toBe(1);
});
