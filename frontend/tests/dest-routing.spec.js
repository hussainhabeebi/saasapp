// 📍 Destination Staff Routing card (User Management): the 🔄 Round robin option and the live
// summary of which destinations rotate between whom. Hermetic file:// setup as hot-alerts.spec.js.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';
const TEAM = [['sruthi@x.com', 'Sruthi'], ['rinsha@x.com', 'Rinsha'], ['adil@x.com', 'Adil'], ['ismail@x.com', 'Ismail']]
  .map(([email, name]) => ({ email, name, whatsapp: '919000000001', inbox_id: '', inbox_phone: '', inbox_can_send: false }));
const PRESETS = { staff: { name: 's', language: 'en', body: 'x' }, customer: { name: 'c', language: 'en', body: 'y' } };

async function boot(page, config) {
  const posts = [];
  let cfg = config;
  await page.route('**/*', async (route) => {
    const req = route.request(), url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url.startsWith(WORKER) && new URL(url).pathname === '/dest-routing/settings') {
      if (req.method() === 'POST') { const b = JSON.parse(req.postData()); posts.push(b); cfg = { ...cfg, ...b }; }
      return route.fulfill({ json: { ok: true, agency: true, config: cfg, team: TEAM, presets: PRESETS } });
    }
    return route.abort();
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    document.getElementById('pageUsermanagement').classList.remove('hidden');
    // @ts-ignore
    clientId = 7; clientRecord = { Id: 7, industry: 'travel', authentik_email: 'boss@x.com', team_emails: 'sruthi@x.com,rinsha@x.com,adil@x.com,ismail@x.com' }; sessionToken = 't'; myEmail = 'boss@x.com';
  });
  await page.evaluate(() => window.renderDestRoutingCard());
  return posts;
}
const BASE = { enabled: true, kinds: { resort: true, package: true, flight: true }, customer_text: '', notify_owner_too: false, start_from_staff_number: true,
  staff_template_name: '', staff_template_lang: 'en', customer_template_name: '', customer_template_lang: 'en',
  rules: { 'sruthi@x.com': { resorts: ['Ooty'] }, 'rinsha@x.com': { resorts: ['Wayanad'] }, 'adil@x.com': { resorts: ['Wayanad', 'Ooty'] }, 'ismail@x.com': { resorts: ['ooty'] } } };

test('round robin is on by default and the card lists who each shared destination rotates between', async ({ page }) => {
  const posts = await boot(page, BASE);
  const card = page.locator('#destRoutingCard');
  await expect(card.locator('#dsrRoundRobin')).toBeChecked();
  const groups = card.locator('#dsrGroups');
  await expect(groups).toContainText('Round robin');
  await expect(groups).toContainText('Ooty: Sruthi → Adil → Ismail');
  await expect(groups).toContainText('Wayanad: Rinsha → Adil');
  // Typing updates it before saving.
  await card.locator('[data-dsr-email="rinsha@x.com"][data-dsr-field="resorts"]').fill('Wayanad, Ooty');
  await expect(groups).toContainText('Ooty: Sruthi → Rinsha → Adil → Ismail');
  // Turning it off says the first name takes every lead, and saves round_robin:false.
  await card.locator('#dsrRoundRobin').uncheck();
  await expect(groups).toContainText('Round robin is off');
  await card.getByRole('button', { name: 'Save destination routing' }).click();
  await expect(card.locator('#dsrMsg')).toHaveText('✓ Saved');
  expect(posts.at(-1).round_robin).toBe(false);
  await expect(card.locator('#dsrRoundRobin')).not.toBeChecked();
});

test('nothing shared yet → says how to set up a rotation', async ({ page }) => {
  await boot(page, { ...BASE, rules: { 'sruthi@x.com': { resorts: ['Ooty'] } } });
  await expect(page.locator('#dsrGroups')).toContainText('No destination is shared yet');
});
