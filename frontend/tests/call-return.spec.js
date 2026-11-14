// Calling a lead from the phone: coming back to the app keeps the rep on the lead they called
// (dashboard.html startCallTimer / callReturnRestore / the visibilitychange handler), and live
// updates that pile up while they're on the phone don't each start a full reload (liveRefresh).
// Same hermetic file:// setup as lead-origin.spec.js.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');

const LEADS = [
  { Id: 1, Name: 'Asha', Phone: '919876543210', Stage: 'new', Score: 'Cold' },
  { Id: 2, Name: 'Binu', Phone: '919876543211', Stage: 'new', Score: 'Cold' },
];

async function boot(page) {
  await page.route('**/*', (route) => (route.request().url().startsWith('file://') ? route.continue() : route.abort()));
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate((leads) => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    // @ts-ignore
    clientId = 7; allLeads = leads.map((l) => ({ ...l, Date: new Date().toISOString() }));
    window.navigate('home');
  }, LEADS);
}
const isOpen = (page, id) => page.evaluate((id) => document.getElementById(id).classList.contains('open'), id);

test('back from a call made from a lead: stays on that screen with the lead and Log Call open', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { window.openDetail(1); window.startCallTimer(1); });
  // the phone app takes over, then the rep comes back
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => document.getElementById('pageHome').classList.contains('hidden'))).toBe(false);
  expect(await page.evaluate(() => document.getElementById('pageLeads').classList.contains('hidden'))).toBe(true);
  expect(await isOpen(page, 'modalDetail')).toBe(true);
  expect(await isOpen(page, 'modalCall')).toBe(true);
});

test('app closed by the phone mid-call: reopening lands on the same lead with Log Call up', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { window.navigate('chats'); window.openDetail(2); window.startCallTimer(2); });
  const saved = await page.evaluate(() => localStorage.getItem('lv_call_return_7'));
  expect(JSON.parse(saved)).toMatchObject({ leadId: 2, page: 'chats', detail: true });
  // a fresh load: the in-memory state is gone, localStorage survives
  await boot(page);
  await page.evaluate(() => window.callReturnRestore());
  expect(await page.evaluate(() => document.getElementById('pageChats').classList.contains('hidden'))).toBe(false);
  expect(await page.evaluate(() => currentLead?.Id)).toBe(2);
  expect(await isOpen(page, 'modalDetail')).toBe(true);
  expect(await isOpen(page, 'modalCall')).toBe(true);
  // logging (or dismissing) the call forgets it, so the next launch is a normal one
  await page.evaluate(() => window.dismissCallLog());
  expect(await page.evaluate(() => localStorage.getItem('lv_call_return_7'))).toBeNull();
});

test('a stale call (over 3 hours old) is not restored', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => localStorage.setItem('lv_call_return_7', JSON.stringify({ leadId: 1, start: Date.now() - 4 * 3600e3, page: 'leads', detail: true })));
  await page.evaluate(() => window.callReturnRestore());
  expect(await isOpen(page, 'modalCall')).toBe(false);
  expect(await page.evaluate(() => localStorage.getItem('lv_call_return_7'))).toBeNull();
});

test('a burst of live updates runs one refresh plus one queued, not one each', async ({ page }) => {
  await boot(page);
  const calls = await page.evaluate(async () => {
    let n = 0;
    // @ts-ignore
    loadAll = async () => { n++; await new Promise((r) => setTimeout(r, 50)); };
    await Promise.all([1, 2, 3, 4, 5].map(() => window.liveRefresh()));
    return n;
  });
  expect(calls).toBe(2);
});
