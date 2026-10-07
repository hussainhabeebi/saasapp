// Power Dial v3 (dashboard.html #powerDialer): one card with three states — idle (Call) → live
// (End & log) → outcome (text list) — plus the "Continue on WhatsApp" bottom sheet. Same hermetic
// file:// setup as lead-actions.spec.js: no backend, ncPatch/fetch stubbed in the page.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');

async function openDialer(page, { waConnected = false, convHistory = '' } = {}) {
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('file://')) return route.continue();
    return route.abort();
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ waConnected, convHistory }) => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    // @ts-ignore
    window.__patches = [];
    // @ts-ignore
    window.__sent = [];
    // @ts-ignore
    window.ncPatch = async (_url, body) => { window.__patches.push(body); };
    // @ts-ignore
    window.freshConvHistory = async (l) => JSON.parse(l.ConvHistory || '[]');
    // @ts-ignore
    window.autoWaFollowUp = () => {};
    // @ts-ignore
    window.renderLeadsCurrentView = () => {};
    // @ts-ignore
    window.__nav = [];
    // @ts-ignore
    window.navigate = (p) => window.__nav.push(p);
    // @ts-ignore
    window.chatSelectLead = (id) => window.__nav.push('lead:' + id);
    const realFetch = window.fetch;
    // @ts-ignore
    window.fetch = async (url, opts) => {
      if (String(url).endsWith('/wa/send')) { window.__sent.push(JSON.parse(opts.body)); return new Response('{"ok":true}', { status: 200 }); }
      return realFetch(url, opts);
    };
    // @ts-ignore
    clientRecord = waConnected ? { wa_phone_id: '1', wa_token_connected: true } : {};
    // @ts-ignore
    allLeads = [
      { Id: 1, Name: 'Rahul Menon', Phone: '919847012345', Stage: 'contacted', ConvHistory: convHistory },
      { Id: 2, Name: 'Asha K', Phone: '919800000002', Stage: 'new',
        CallLog: JSON.stringify([{ outcome: 'Moved to WhatsApp', at: new Date().toISOString() }]) },
    ];
    // @ts-ignore
    window.buildPowerDialerQueue([1, 2]);
  }, { waConnected, convHistory });
  return page.locator('#powerDialer');
}

test('idle shows one primary Call action, no outcome list', async ({ page }) => {
  const pd = await openDialer(page);
  await expect(pd).toHaveAttribute('data-state', 'idle');
  await expect(pd.locator('#pdName')).toHaveText('Rahul Menon');
  await expect(pd.locator('#pdProgress')).toHaveText('1 of 2');
  await expect(pd.locator('.pd-primary:visible')).toHaveCount(1);
  await expect(pd.getByRole('button', { name: /Continue on WhatsApp/ })).toBeHidden();
});

test('Call → End & log → outcome list; picking one logs and advances', async ({ page }) => {
  const pd = await openDialer(page);
  // Same as the real pdStartCall minus the tel: hand-off, which would leave the page.
  await page.evaluate(() => { window.pdStartCall = (e) => { e?.preventDefault(); _pdCallStart = Date.now(); _pdSaveState(); pdSetState('live'); }; });
  await pd.locator('#pdCallBtn').click();
  await expect(pd).toHaveAttribute('data-state', 'live');
  await pd.getByRole('button', { name: 'End & log call' }).click();
  await expect(pd).toHaveAttribute('data-state', 'outcome');
  await pd.getByRole('button', { name: /Answered/ }).click();
  await expect(pd.locator('#pdName')).toHaveText('Asha K');
  await expect(pd).toHaveAttribute('data-state', 'idle');
  const log = await page.evaluate(() => JSON.parse(allLeads[0].CallLog));
  expect(log[0].outcome).toBe('Answered');
});

test('keyboard: 1–4 log outcomes, W opens the WhatsApp sheet', async ({ page }) => {
  const pd = await openDialer(page);
  await page.evaluate(() => pdSetState('outcome'));
  await page.keyboard.press('w');
  await expect(pd).toHaveClass(/pd-sheet-open/);
  await page.keyboard.press('Escape');
  await expect(pd).not.toHaveClass(/pd-sheet-open/);
  await page.keyboard.press('2');
  await expect(pd.locator('#pdName')).toHaveText('Asha K');
  expect(await page.evaluate(() => JSON.parse(allLeads[0].CallLog)[0].outcome)).toBe('No Answer');
});

test('lead whose last call moved to WhatsApp is labelled "Prefers WhatsApp"', async ({ page }) => {
  const pd = await openDialer(page);
  await expect(pd.locator('#pdPref')).toBeHidden();
  await page.evaluate(() => pdNext());
  await expect(pd.locator('#pdPref')).toBeVisible();
});

test('WhatsApp inside the 24h window: Send goes from the business number and logs "Moved to WhatsApp"', async ({ page }) => {
  const recent = JSON.stringify([{ role: 'user', content: 'hi', ts: new Date().toISOString() }]);
  const pd = await openDialer(page, { waConnected: true, convHistory: recent });
  await page.evaluate(() => pdSetState('outcome'));
  await pd.getByRole('button', { name: /Continue on WhatsApp/ }).click();
  await expect(pd.locator('#pdSheetTitle')).toHaveText('Message Rahul');
  await expect(pd.locator('#pdWaText')).toHaveValue(/^Hi Rahul, thanks for your time/);
  await pd.locator('#pdWaPrimary').click();
  await expect(pd.locator('#pdName')).toHaveText('Asha K');
  const sent = await page.evaluate(() => window.__sent);
  expect(sent).toHaveLength(1);
  expect(sent[0].phone).toBe('919847012345');
  expect(await page.evaluate(() => JSON.parse(allLeads[0].CallLog)[0].outcome)).toBe('Moved to WhatsApp');
});

test('WhatsApp outside the 24h window: offers a template via Chats, keeps the queue minimized', async ({ page }) => {
  const pd = await openDialer(page, { waConnected: true });
  await page.evaluate(() => pdSetState('outcome'));
  await pd.getByRole('button', { name: /Continue on WhatsApp/ }).click();
  await expect(pd.locator('#pdWaPrimary')).toHaveText('Choose a template');
  await expect(pd.locator('#pdWaNote')).toContainText('24 hours');
  await pd.locator('#pdWaPrimary').click();
  await expect(pd).toBeHidden();
  await expect(page.locator('#pdResume')).toBeVisible();
  await expect(page.locator('#pdResume')).toContainText('2 of 2');
  expect(await page.evaluate(() => window.__nav)).toEqual(['chats', 'lead:1']);
  expect(await page.evaluate(() => window.__sent)).toHaveLength(0);
  await page.locator('#pdResume').click();
  await expect(pd.locator('#pdName')).toHaveText('Asha K');
});

test('no Business API: opens WhatsApp with the message pre-filled', async ({ page }) => {
  const pd = await openDialer(page);
  await page.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); }; pdSetState('outcome'); });
  await pd.getByRole('button', { name: /Continue on WhatsApp/ }).click();
  await expect(pd.locator('#pdWaPrimary')).toHaveText('Open WhatsApp');
  await expect(pd.locator('#pdWaSecondary')).toBeHidden();
  await pd.locator('#pdWaPrimary').click();
  const opened = await page.evaluate(() => window.__opened);
  expect(opened[0]).toMatch(/^https:\/\/wa\.me\/919847012345\?text=Hi%20Rahul/);
});

test('phone width: no horizontal scroll, sheet fits', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  const pd = await openDialer(page);
  await page.evaluate(() => { pdSetState('outcome'); pdOpenWaSheet(); });
  const box = await pd.locator('#pdSheet').boundingBox();
  expect(box.width).toBeLessThanOrEqual(375);
  expect(await page.evaluate(() => document.getElementById('powerDialer').scrollWidth)).toBeLessThanOrEqual(375);
});
