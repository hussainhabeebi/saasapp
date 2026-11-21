// Cal.com Meetings card (Settings → Integrations, dashboard.html mtgInit and friends). Same
// hermetic file:// setup as lead-actions.spec.js — the Worker's /meetings/* routes are answered by
// page.route stubs, everything else off-origin is blocked.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';

async function openCard(page, config, list) {
  const calls = [];
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url.startsWith(WORKER + '/meetings/')) {
      const p = new URL(url).pathname;
      const body = req.postData() ? JSON.parse(req.postData()) : null;
      calls.push({ path: p, method: req.method(), body });
      if (p === '/meetings/config' && req.method() === 'GET') return route.fulfill({ json: { config } });
      if (p === '/meetings/config') {
        config = { ...config, links: body.links, settings: body.settings, webhook_secret: config.webhook_secret || 'gen-secret', enabled: body.links.length > 0 };
        return route.fulfill({ json: { ok: true, config } });
      }
      if (p === '/meetings/list') return route.fulfill({ json: list });
      if (p === '/meetings/send') return route.fulfill({ json: { ok: true, id: 5, url: WORKER + '/m/abc12345', whatsapp_sent: true } });
      if (p === '/meetings/outcome') return route.fulfill({ json: { ok: true } });
    }
    return route.abort();
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    document.getElementById('pageIntegrations').classList.remove('hidden');
    // @ts-ignore
    clientId = 7; clientRecord = { Id: 7 }; sessionToken = 't';
    // @ts-ignore
    allLeads = [{ Id: 42, Name: 'Asha K', Phone: '919876543210' }, { Id: 43, Name: 'Ravi', Phone: '919000000001' }];
    // @ts-ignore
    window.mtgSyncBotLinks = async () => {};
    // @ts-ignore
    window.mtgInit();
  });
  return calls;
}

const OFF = { links: [], webhook_secret: '', settings: {}, enabled: false, last_event_at: null };
const EMPTY_LIST = { upcoming: [], needs_outcome: [], recent: [], stats: {} };

test('off until a link is saved, then the rest of the module appears', async ({ page }) => {
  const calls = await openCard(page, OFF, EMPTY_LIST);
  const card = page.locator('#mtgCard');
  await expect(card.locator('#mtgStatusBadge')).toHaveText('Off');
  await expect(card.locator('#mtgSetupMore')).toBeHidden();
  await expect(card.locator('#mtgLive')).toBeHidden();

  await card.locator('.mtg-link-name').first().fill('15-min intro');
  await card.locator('.mtg-link-url').first().fill('https://cal.com/acme/intro');
  await card.getByRole('button', { name: 'Save' }).click();

  await expect(card.locator('#mtgStatusBadge')).toHaveText('On');
  await expect(card.locator('#mtgSetupMore')).toBeVisible();
  await expect(card.locator('#mtgLive')).toBeVisible();
  await expect(card.locator('#mtgWebhookUrl')).toHaveValue(WORKER + '/calcom/meetings/7');
  await expect(card.locator('#mtgWebhookSecret')).toHaveValue('gen-secret');
  await expect(card.locator('#mtgConnStatus')).toContainText('Nothing received');
  const save = calls.find((c) => c.path === '/meetings/config' && c.method === 'POST');
  expect(save.body.links).toEqual([{ name: '15-min intro', url: 'https://cal.com/acme/intro' }]);
  expect(save.body.settings.remind24).toBe(true);
});

test('rejects a non-https link', async ({ page }) => {
  await openCard(page, OFF, EMPTY_LIST);
  const card = page.locator('#mtgCard');
  await card.locator('.mtg-link-url').first().fill('cal.com/acme/intro');
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(card.locator('#mtgSaveMsg')).toHaveText(/https:\/\//);
});

test('send a tracked link, see meetings and record an outcome', async ({ page }) => {
  const on = { links: [{ name: 'Intro call', url: 'https://cal.com/acme/intro' }, { name: 'Demo', url: 'https://cal.com/acme/demo' }], webhook_secret: 's', settings: { confirm: true }, enabled: true, last_event_at: new Date().toISOString(), last_event_type: 'PING' };
  const soon = new Date(Date.now() + 86400e3).toISOString();
  const list = {
    upcoming: [{ id: 1, lead_name: 'Asha K', title: 'Intro call', status: 'scheduled', start_at: soon, join_url: 'https://meet.google.com/x' }],
    needs_outcome: [{ id: 2, lead_name: 'Ravi', title: 'Demo', status: 'completed', start_at: soon }],
    recent: [],
    stats: { sent: 4, clicked: 3, booked: 2, attended: 1, no_show: 0, converted: 1, this_week: 1, reps: {} },
  };
  const calls = await openCard(page, on, list);
  const card = page.locator('#mtgCard');
  await expect(card.locator('#mtgConnStatus')).toContainText('Connected');
  await expect(card.locator('#mtgStats')).toContainText('Links sent');
  await expect(card.locator('#mtgStats')).toContainText('50%');
  await expect(card.locator('#mtgLists')).toContainText('Asha K');
  await expect(card.locator('#mtgLists').getByRole('link', { name: 'Join' })).toHaveAttribute('href', 'https://meet.google.com/x');

  await card.locator('#mtgLeadSearch').fill('asha');
  await card.locator('.mtg-lead-hit').first().click();
  await card.locator('#mtgSendLink').selectOption('1');
  await card.getByRole('button', { name: 'Send on WhatsApp' }).click();
  await expect(card.locator('#mtgSendMsg')).toContainText('Sent to Asha K');
  const send = calls.find((c) => c.path === '/meetings/send');
  expect(send.body).toMatchObject({ lead_id: 42, link_index: 1, send: true });

  await card.getByRole('button', { name: '👍 Interested' }).click();
  await expect.poll(() => calls.find((c) => c.path === '/meetings/outcome')?.body).toEqual({ id: 2, outcome: 'interested' });
});
