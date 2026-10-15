// Settings → Channels: assigning a channel to a user keeps its AI Reply setting, shows the
// assigned user even when the stored email differs in case, and reports how many existing leads
// moved over. Same hermetic file:// setup as the other specs — the Worker is a route stub.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';

test('assigning a channel keeps AI Reply off, preselects the user and reports moved leads', async ({ page }) => {
  const puts = [];
  await page.route('**/*', async (route) => {
    const req = route.request(); const url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url === WORKER + '/channels/inbox-assignments') return route.fulfill({ json: { ok: true, assignments: [{ inbox_id: 5, assigned_email: 'rita@acme.com', bot_reply_disabled: 1 }] } });
    if (url === WORKER + '/channels/inbox-assignment') { puts.push(JSON.parse(req.postData())); return route.fulfill({ json: { ok: true, reassigned: 3 } }); }
    return route.abort();
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    // @ts-ignore
    clientId = 7; myEmail = 'boss@acme.com'; sessionToken = 't'; allLeads = [];
    // @ts-ignore
    clientRecord = { authentik_email: 'boss@acme.com', team_emails: 'Rita@Acme.com,sam@acme.com', team_names: JSON.stringify({ 'Rita@Acme.com': 'Rita', 'sam@acme.com': 'Sam' }) };
    // @ts-ignore
    loadAll = async () => {};
    // Show the real list on the Channels settings page, without its network-backed init.
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    let el = document.getElementById('chConnectedList');
    for (; el; el = el.parentElement) { el.classList?.remove('hidden'); if (el.style?.display === 'none') el.style.display = ''; }
    // @ts-ignore
    await chLoadAndRenderInboxList([{ id: 5, name: 'Sales WhatsApp', channel_type: 'Channel::Whatsapp' }]);
  });
  const sel = page.locator('#chConnectedList select');
  await expect(sel).toHaveValue('Rita@Acme.com');
  await sel.selectOption('sam@acme.com');
  await expect.poll(() => puts.length).toBe(1);
  expect(puts[0]).toEqual({ inbox_id: 5, assigned_email: 'sam@acme.com', chatwoot_user_id: 0, bot_reply_disabled: true });
  await expect(page.locator('#_toast')).toContainText('3 existing leads moved to sam@acme.com');
});

test('"Move existing leads" moves a channel\'s leads and reports how many', async ({ page }) => {
  const posts = [];
  await page.route('**/*', async (route) => {
    const req = route.request(); const url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url === WORKER + '/channels/inbox-assignments') return route.fulfill({ json: { ok: true, assignments: [{ inbox_id: 5, assigned_email: 'rita@acme.com' }, { inbox_id: 6, assigned_email: '' }] } });
    if (url === WORKER + '/channels/inbox-assignment/sync') { posts.push(JSON.parse(req.postData())); return route.fulfill({ json: { ok: true, reassigned: 9 } }); }
    return route.abort();
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    // @ts-ignore
    clientId = 7; myEmail = 'boss@acme.com'; sessionToken = 't'; allLeads = [];
    // @ts-ignore
    clientRecord = { authentik_email: 'boss@acme.com', team_emails: 'rita@acme.com' };
    // @ts-ignore
    loadAll = async () => {};
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    let el = document.getElementById('chConnectedList');
    for (; el; el = el.parentElement) { el.classList?.remove('hidden'); if (el.style?.display === 'none') el.style.display = ''; }
    // @ts-ignore
    await chLoadAndRenderInboxList([{ id: 5, name: 'Sales', channel_type: 'Channel::Whatsapp' }, { id: 6, name: 'Support', channel_type: 'Channel::Whatsapp' }]);
  });
  // Only the assigned channel gets the button.
  await expect(page.locator('#chConnectedList button', { hasText: 'Move existing leads' })).toHaveCount(1);
  await page.locator('#chConnectedList button', { hasText: 'Move existing leads' }).click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toEqual({ inbox_id: 5 });
  await expect(page.locator('#_toast')).toContainText('9 leads moved');
});
