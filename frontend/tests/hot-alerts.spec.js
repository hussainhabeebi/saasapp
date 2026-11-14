// 🔥 Hot Lead Alerts + staff WhatsApp numbers (User Management), 📋 Lead Forms card
// (Integrations), the ?lead= deep link from an alert, and the call-outcome fixes. Same hermetic
// file:// setup as meetings.spec.js — Worker routes answered by page.route stubs.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';

const PRESET = { name: 'hot_lead_alert_leadvyne', language: 'en', body: '🔥 Hot lead for you: {{1}} ({{2}}) {{3}}.' };
const CFG = { enabled: false, template_name: '', template_lang: 'en', notify_owner_too: false, on_hot: true, on_hot_moment: true, on_lead_ad: true, cooldown_hours: 12 };

async function boot(page, { pageId, me = 'boss@x.com', teamWhatsapp = {}, leadgen } = {}) {
  const calls = [];
  let cfg = { ...CFG };
  let wa = { ...teamWhatsapp };
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url.startsWith(WORKER)) {
      const p = new URL(url).pathname;
      const body = req.postData() ? JSON.parse(req.postData()) : null;
      calls.push({ path: p, method: req.method(), body });
      if (p === '/hot-alerts/config' && req.method() === 'GET') return route.fulfill({ json: { config: cfg, team_whatsapp: wa, preset: PRESET, log: [] } });
      if (p === '/hot-alerts/config') { cfg = { ...cfg, ...body }; return route.fulfill({ json: { ok: true, config: cfg } }); }
      if (p === '/hot-alerts/template-preset') return route.fulfill({ json: { ok: true, name: PRESET.name, language: 'en', status: 'PENDING' } });
      if (p === '/team/whatsapp') { wa = { ...wa, [body.email]: body.phone.replace(/\D/g, '') }; return route.fulfill({ json: { ok: true, team_whatsapp: wa } }); }
      if (p === '/meta-leadgen/config' && req.method() === 'GET') return route.fulfill({ json: leadgen });
      if (p === '/meta-leadgen/connect') return route.fulfill({ json: { ok: true, config: { ...leadgen.config, enabled: true, page_id: body.page_id, page_name: 'Acme Page' } } });
      if (p === '/meta-leadgen/config') return route.fulfill({ json: { ok: true, config: { ...leadgen.config, ...body } } });
      if (p === '/wa/send') return route.fulfill({ status: 400, json: { error: 'Outside 24h window' } });
    }
    return route.abort();
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ pageId, me }) => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    document.getElementById(pageId).classList.remove('hidden');
    // @ts-ignore
    clientId = 7; clientRecord = { Id: 7, authentik_email: 'boss@x.com', team_emails: 'a@x.com' }; sessionToken = 't'; myEmail = me;
    // @ts-ignore
    allLeads = [{ Id: 42, Name: 'Asha K', Phone: '919876543210', Stage: 'new' }];
  }, { pageId, me });
  return calls;
}

test('owner turns alerts on, creates the template and sees who is missing a number', async ({ page }) => {
  const calls = await boot(page, { pageId: 'pageUsermanagement', teamWhatsapp: { 'boss@x.com': '919000000001' } });
  await page.evaluate(() => window.renderHotAlertsCard());
  const card = page.locator('#hotAlertsCard');
  await expect(card.locator('#hotAlertsBadge')).toHaveText('Off');
  await expect(card).toContainText('+919000000001');
  await expect(card).toContainText('No number');

  await card.getByRole('button', { name: '✨ Create ready-made template' }).click();
  await expect(card.locator('#haTemplate')).toHaveValue('hot_lead_alert_leadvyne');
  await card.locator('#haEnabled').check();
  await card.locator('#haOwnerToo').check();
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(card.locator('#hotAlertsBadge')).toHaveText('On');
  const save = calls.find((c) => c.path === '/hot-alerts/config' && c.method === 'POST');
  expect(save.body).toMatchObject({ enabled: true, notify_owner_too: true, template_name: 'hot_lead_alert_leadvyne', cooldown_hours: 12 });
});

test('a teammate can add their own WhatsApp number from their profile', async ({ page }) => {
  const calls = await boot(page, { pageId: 'pageUsermanagement', me: 'a@x.com' });
  await page.evaluate(() => window.openUserProfile('a@x.com'));
  await page.locator('#upWhatsapp').fill('+91 98888 77777');
  await page.locator('#userProfileBody').getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('#upWhatsappMsg')).toHaveText('✓ Saved');
  expect(calls.find((c) => c.path === '/team/whatsapp').body).toEqual({ email: 'a@x.com', phone: '+91 98888 77777' });
  await expect(page.locator('#teamMembersList')).toContainText('📱');
  // …but can't edit someone else's.
  await page.evaluate(() => window.openUserProfile('boss@x.com'));
  await expect(page.locator('#upWhatsapp')).toHaveCount(0);
});

test('lead forms card: connect a Page and pick template variables', async ({ page }) => {
  const leadgen = {
    config: { enabled: false, page_id: '', page_name: '', template_name: '', template_lang: 'en', params: [], default_country_code: '91' },
    connected: false, webhook_url: WORKER + '/meta/leadgen/webhook', verify_token_configured: true,
    param_keys: ['first_name', 'full_name', 'business_name', 'form_name', 'campaign_name', 'ad_name'],
    preset: { name: 'lead_form_welcome_leadvyne', language: 'en', body: 'Hi {{1}}, thank you for your enquiry with {{2}}.', params: ['first_name', 'business_name'] },
    log: [],
  };
  const calls = await boot(page, { pageId: 'pageIntegrations', leadgen });
  await page.evaluate(() => window.leadgenInit());
  const card = page.locator('#leadgenCard');
  await expect(card.locator('#leadgenBadge')).toHaveText('Off');
  await card.locator('#lgPageId').fill('555');
  await card.locator('#lgPageToken').fill('EAAG-token');
  await card.getByRole('button', { name: 'Connect Page' }).click();
  await expect(card).toContainText('Connected to Page Acme Page');
  await expect(card.locator('#leadgenBadge')).toHaveText('On');
  expect(calls.find((c) => c.path === '/meta-leadgen/connect').body).toEqual({ page_id: '555', page_token: 'EAAG-token' });

  await card.locator('#lgTemplate').fill('lead_form_welcome_leadvyne');
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(card.locator('#lgSaveMsg')).toHaveText('✓ Saved');
  const save = calls.find((c) => c.path === '/meta-leadgen/config' && c.method === 'POST');
  expect(save.body.params).toEqual(['first_name', 'business_name']);
  expect(save.body.template_name).toBe('lead_form_welcome_leadvyne');
});

test('?lead= deep link from an alert opens that lead with Call ready', async ({ page }) => {
  await boot(page, { pageId: 'pageLeads' });
  await page.evaluate(() => window.openLeadFromAlert(42));
  await expect(page.locator('#detailName')).toHaveText('Asha K');
  const call = page.locator('#detailActions a', { hasText: 'Call' });
  await expect(call).toHaveAttribute('href', 'tel:+919876543210');
  await expect(call).toHaveAttribute('onclick', 'startCallTimer(42)');
});

test('No Answer follow-up reports a failed WhatsApp send instead of claiming success', async ({ page }) => {
  const calls = await boot(page, { pageId: 'pageLeads' });
  await page.evaluate(() => window.autoWaFollowUp(42));
  const send = calls.find((c) => c.path === '/wa/send');
  expect(send.body.text).toContain('Hi Asha');
  expect(send.body.message).toBeUndefined();
  await expect(page.locator('body')).toContainText('WhatsApp follow-up not sent: Outside 24h window');
});
