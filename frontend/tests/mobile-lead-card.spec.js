// Phone app (m.html): a lead opens in a card inside the app; Call dials and then asks how it went,
// saving the call to the lead's CallLog exactly like the dashboard's Log Call; Chat stays in the app.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mUrl = 'file://' + path.resolve(__dirname, '../m.html');
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

function leads() {
  return [
    { Id: 11, ClientId: '48', Name: 'Sahilath P', Phone: '919562999000', Owner: '', Score: 'Hot', Stage: 'new', Date: iso(8 * 86400e3), ConversationID: '61', Email: 'sahilath@x.test', CallLog: '' },
    { Id: 12, ClientId: '48', Name: 'Jio', Phone: '918921779948', Owner: 'riya@x.test', Stage: 'new', Date: iso(41 * 86400e3), CallLog: JSON.stringify([{ by: 'riya@x.test', outcome: 'No Answer', at: iso(3600e3) }]) },
  ];
}

async function open(page, { owner = '' } = {}) {
  const data = leads();
  if (owner) data[0].Owner = owner;
  const patches = [], waSends = [];
  await page.route('**/*', (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.protocol === 'file:') return route.continue();
    if (url.pathname.endsWith('/session/me')) return route.fulfill({ json: { email: 'sales@x.test', client: { authentik_email: 'owner@x.test', client_name: 'Aiingo', team_emails: 'sales@x.test,riya@x.test', team_names: JSON.stringify({ 'sales@x.test': 'Sales', 'riya@x.test': 'Riya' }), team_permissions: JSON.stringify({ 'sales@x.test': { role: 'admin' } }) } } });
    if (url.pathname.endsWith('/chats/v2/counts')) return route.fulfill({ json: {} });
    if (url.pathname.endsWith('/chats/v2/list')) return route.fulfill({ json: { rows: [] } });
    if (url.pathname.endsWith('/wa/send')) { waSends.push(req.postDataJSON()); return route.fulfill({ json: { ok: true } }); }
    if (/\/records$/.test(url.pathname) && req.method() === 'PATCH') {
      const b = req.postDataJSON(); patches.push(b);
      const l = data.find((x) => x.Id === b.Id); Object.assign(l, b);
      return route.fulfill({ json: { Id: b.Id } });
    }
    const one = url.pathname.match(/\/records\/(\d+)$/);
    if (one) return route.fulfill({ json: { ConvHistory: '[]', ...data.find((x) => x.Id === Number(one[1])) } });
    if (/\/records$/.test(url.pathname)) return route.fulfill({ json: { list: data } });
    return route.abort();
  });
  await page.goto(mUrl);
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('lv_cid', '48'); localStorage.setItem('lv_session', 't'); });
  await page.goto(mUrl);
  await expect(page.locator('#attn .lead').first()).toBeVisible();
  return { patches, waSends };
}

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test('tapping a lead opens its card inside the app, with details and call history; Back closes it', async ({ page }) => {
  await open(page);
  await page.locator('#nav [data-tab="leads"]').click();
  await page.locator('#leadList .lead', { hasText: 'Jio' }).locator('.info').click();
  const card = page.locator('#leadSheet');
  await expect(card.locator('h2')).toHaveText('Jio');
  await expect(card).toContainText('LD-00012');
  await expect(card.locator('.calls')).toContainText('No Answer');
  await expect(card.locator('.calls')).toContainText('Riya');
  await expect(card.locator('.kv', { hasText: 'Owner' })).toContainText('Riya');
  expect(page.url()).toContain('m.html');
  await page.goBack();
  await expect(card).toBeHidden();
  await expect(page.locator('#tabLeads')).toBeVisible();
});

test('Call dials from the app, then the outcome is saved to CallLog like the dashboard (and claims an unassigned lead)', async ({ page }) => {
  const { patches, waSends } = await open(page);
  // The dialer can't open in a test browser; start the call the way the button does, minus the tel: hop.
  await page.evaluate(() => { localStorage.setItem(`lv_m_call_48`, JSON.stringify({ id: '11', start: Date.now() - 125000 })); claimIfUnowned(findLead('11'), 'Call'); });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const sheet = page.locator('#callSheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('#csDur')).toHaveValue('2');
  await sheet.getByRole('button', { name: /No Answer/ }).click();
  await sheet.locator('#csNotes').fill('Busy, try evening');
  await sheet.getByRole('button', { name: 'Save call' }).click();
  await expect(sheet).toBeHidden();
  await expect.poll(() => patches.find((p) => p.CallLog)).toBeTruthy();
  const entry = JSON.parse(patches.find((p) => p.CallLog).CallLog)[0];
  expect(entry).toMatchObject({ outcome: 'No Answer', by: 'sales@x.test', notes: 'Busy, try evening', duration: '2', src: 'dial' });
  expect(entry.secs).toBeGreaterThanOrEqual(125);
  expect(patches.find((p) => p.Owner)).toMatchObject({ Id: 11, Owner: 'sales@x.test' });
  // Same follow-up as the dashboard: a WhatsApp "we tried calling" message.
  await expect.poll(() => waSends.length).toBe(1);
  expect(waSends[0].phone).toBe('919562999000');
  // It now counts as unanswered, not "not called".
  await expect(page.locator('#attnUnans')).toHaveText('2');
  await expect(page.locator('#attnNew')).toHaveText('0');
  expect(await page.evaluate(() => localStorage.getItem('lv_m_call_48'))).toBeNull();
});

test('Call from inside the lead card still asks how it went on return, so the lead leaves "Not called"', async ({ page }) => {
  const { patches } = await open(page, { owner: 'sales@x.test' });
  await page.locator('#attn .lead', { hasText: 'Sahilath' }).locator('.info').click();
  await expect(page.locator('#leadSheet')).toBeVisible();
  // The card's Call button, minus the tel: hop the test browser can't make.
  await page.evaluate(() => { localStorage.setItem('lv_m_call_48', JSON.stringify({ id: '11', start: Date.now() - 60000 })); });
  // Back from the dialer with the card still open.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const sheet = page.locator('#callSheet');
  await expect(sheet).toBeVisible();
  await expect(page.locator('#leadSheet')).toBeHidden();
  await sheet.getByRole('button', { name: /Answered/ }).click();
  await sheet.getByRole('button', { name: 'Save call' }).click();
  await expect.poll(() => patches.find((p) => p.CallLog)).toBeTruthy();
  expect(JSON.parse(patches.find((p) => p.CallLog).CallLog)[0]).toMatchObject({ outcome: 'Answered', src: 'dial' });
  await expect(page.locator('#attnNew')).toHaveText('0');
});

test('Call on a lead row starts the in-app call flow instead of opening the dashboard', async ({ page }) => {
  await open(page);
  // Stop the actual tel: navigation; check what was asked for.
  await page.route('tel:*', (r) => r.abort());
  await page.locator('#attn .lead', { hasText: 'Sahilath' }).locator('[data-act="call"]').click().catch(() => {});
  const pending = await page.evaluate(() => JSON.parse(localStorage.getItem('lv_m_call_48') || 'null'));
  expect(pending?.id).toBe('11');
  expect(page.url()).toContain('m.html');
});

test('Log call by hand and Chat from the lead card stay in the app', async ({ page }) => {
  const { patches } = await open(page, { owner: 'sales@x.test' });
  await page.locator('#attn .lead', { hasText: 'Sahilath' }).locator('.info').click();
  await page.locator('#leadSheet').getByRole('button', { name: 'Log call' }).click();
  await page.locator('#callSheet').getByRole('button', { name: /Answered/ }).click();
  await page.locator('#callSheet').getByRole('button', { name: 'Save call' }).click();
  await expect.poll(() => patches.find((p) => p.CallLog)).toBeTruthy();
  expect(JSON.parse(patches.find((p) => p.CallLog).CallLog)[0]).toMatchObject({ outcome: 'Answered', src: 'manual' });
  // Called now, so it has left Prime attention's "Not called" list — open it from Leads.
  await expect(page.locator('#attn .lead', { hasText: 'Sahilath' })).toHaveCount(0);
  await page.locator('#nav [data-tab="leads"]').click();
  await page.locator('#leadList .lead', { hasText: 'Sahilath' }).locator('.info').click();
  await expect(page.locator('#leadSheet .calls')).toContainText('Answered');
  await page.locator('#leadSheet').getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(page.locator('#leadSheet')).toBeHidden();
  await expect(page.locator('#tabChats')).toBeVisible();
});

test('lead card → Staff: the contact stops being a lead (tag + bot stopped) and leaves the lists', async ({ page }) => {
  const { patches } = await open(page, { owner: 'sales@x.test' });
  page.on('dialog', (d) => d.accept());
  await page.locator('#attn .lead', { hasText: 'Sahilath' }).locator('.info').click();
  await page.locator('#leadSheet').getByRole('button', { name: '🧑‍💼 Staff' }).click();
  await expect.poll(() => patches.find((p) => p.OptOut)).toBeTruthy();
  expect(patches.find((p) => p.OptOut)).toEqual({ Id: 11, Tags: 'Staff', OptOut: 'Yes' });
  await expect(page.locator('#leadSheet')).toBeHidden();
  await expect(page.locator('#attn .lead', { hasText: 'Sahilath' })).toHaveCount(0);
  await page.locator('#nav [data-tab="leads"]').click();
  await expect(page.locator('#leadList .lead', { hasText: 'Sahilath' })).toHaveCount(0);
});
