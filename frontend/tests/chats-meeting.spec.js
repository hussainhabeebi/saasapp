// Chats (chats.html) → Attach → 📅 Meeting for General accounts with the meetings module on:
// schedule a Google Meet (confirmation into the chat, stage → Meeting Scheduled) or share a Cal.com
// booking link. Hermetic file:// setup like chats-ai-proposal.spec.js.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chatsUrl = 'file://' + path.resolve(__dirname, '../chats.html') + '?client=48&token=t';
const minsAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
const MESSAGES = [{ role: 'user', content: 'Can we talk tomorrow?', ts: minsAgo(5) }];
const LEAD = { Id: 7, ClientId: '48', Name: 'Asha Nair', Phone: '919800000000', ConversationID: '55', LastMsgAt: minsAgo(5), ConvHistory: JSON.stringify(MESSAGES) };
const CFG = { enabled: true, chat_enabled: true, links: [{ name: 'Intro call', url: 'https://cal.com/biz/intro' }, { name: 'Demo', url: 'https://cal.com/biz/demo' }], settings: { meet_url: 'https://meet.google.com/abc-defg-hij' } };

async function open(page, { industry = 'general', cfg = CFG, exists = false } = {}) {
  const calls = [];
  let refused = exists;
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.protocol === 'file:') return route.continue();
    if (url.pathname.endsWith('/session/me')) return route.fulfill({ json: { email: 'owner@x.test', client: { authentik_email: 'owner@x.test', industry } } });
    if (/\/nocodb\/api\/v2\/tables\/[^/]+\/records$/.test(url.pathname)) return route.fulfill({ json: { list: [LEAD] } });
    if (url.pathname.endsWith('/chat/messages')) return route.fulfill({ json: { messages: MESSAGES } });
    if (url.pathname.endsWith('/meetings/config')) return route.fulfill({ json: { config: cfg } });
    if (url.pathname.endsWith('/meetings/lead')) return route.fulfill({ json: { meetings: [], state: null } });
    if (url.pathname.endsWith('/meetings/chat-share')) {
      const body = req.postDataJSON(); calls.push(body);
      if (refused && !body.force) return route.fulfill({ status: 409, json: { error: 'Asha Nair already has a meeting on Mon, 16 Nov, 11:00 AM.', code: 'MEETING_EXISTS' } });
      return route.fulfill({ json: body.kind === 'meet'
        ? { ok: true, kind: 'meet', id: 3, stage: 'meeting_scheduled', text: 'Hi Asha! ✅ Your Product demo is confirmed for Mon, 16 Nov, 11:00 AM.\nJoin: https://meet.google.com/abc-defg-hij' }
        : { ok: true, kind: 'cal', id: 4, url: 'https://w.test/m/tok', stage: 'new', text: 'Hi Asha! 📅 Here\'s the link to pick a time for our Demo: https://w.test/m/tok' } });
    }
    return route.abort();
  });
  await page.goto(chatsUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#list .contact', { hasText: 'Asha' }).click();
  await expect(page.locator('#thread .bubble-row')).toHaveCount(1);
  return calls;
}

test('schedule a Google Meet: date, time, Meet link → confirmation in the chat, stage Meeting Scheduled', async ({ page }) => {
  const calls = await open(page);
  await page.locator('#attachBtn').click();
  await page.locator('#attachMenu #mtgChatBtn').click();
  const ov = page.locator('#mtgOv');
  await expect(ov).toContainText('Meeting with Asha Nair');
  await expect(page.locator('#mtgMeetUrl')).toHaveValue('https://meet.google.com/abc-defg-hij');
  await expect(ov.getByRole('link', { name: /Create a new Google Meet/ })).toHaveAttribute('href', 'https://meet.google.com/new');
  await page.locator('#mtgTitle').fill('Product demo');
  const d = new Date(Date.now() + 2 * 86400e3);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  await page.locator('#mtgDate').fill(date);
  await page.locator('#mtgTime').fill('11:00');
  await page.locator('#mtgDur').selectOption('45');
  await page.getByRole('button', { name: '📅 Schedule & send' }).click();
  await expect(ov).toBeHidden();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ lead_id: 7, kind: 'meet', duration_min: 45, title: 'Product demo', meet_url: 'https://meet.google.com/abc-defg-hij', message: '', force: false });
  expect(new Date(calls[0].start_at).getTime()).toBe(new Date(`${date}T11:00`).getTime());
  await expect(page.locator('#thread .bubble.out')).toContainText('Your Product demo is confirmed');
  await expect(page.locator('#toast')).toContainText('stage: Meeting Scheduled');
});

test('share a Cal.com booking link with a custom message', async ({ page }) => {
  const calls = await open(page);
  await page.evaluate(() => openMtgShare());
  await page.getByRole('tab', { name: /Booking link/ }).click();
  await expect(page.locator('#mtgMeetForm')).toBeHidden();
  await page.locator('#mtgCalLink').selectOption('1');
  await page.locator('#mtgCalMsg').fill('Pick a slot: {link}');
  await page.getByRole('button', { name: '🔗 Send booking link' }).click();
  await expect(page.locator('#mtgOv')).toBeHidden();
  expect(calls[0]).toEqual({ lead_id: 7, kind: 'cal', link_index: 1, message: 'Pick a slot: {link}', force: false });
  await expect(page.locator('#toast')).toContainText('Booking link sent');
});

test('a lead that already has a meeting asks before scheduling another; bad input is caught', async ({ page }) => {
  const calls = await open(page, { exists: true });
  await page.evaluate(() => openMtgShare());
  await page.locator('#mtgMeetUrl').fill('meet.google.com/x');
  await page.getByRole('button', { name: '📅 Schedule & send' }).click();
  await expect(page.locator('#mtgErr')).toContainText('Paste the Google Meet link');
  expect(calls).toHaveLength(0);
  await page.locator('#mtgMeetUrl').fill('https://meet.google.com/new-room-abc');
  page.once('dialog', (dlg) => { expect(dlg.message()).toContain('already has a meeting'); dlg.accept(); });
  await page.getByRole('button', { name: '📅 Schedule & send' }).click();
  await expect(page.locator('#mtgOv')).toBeHidden();
  expect(calls.map((c) => c.force)).toEqual([false, true]);
});

test('only for General accounts with a meeting link set up', async ({ page }) => {
  await open(page, { cfg: { enabled: false, chat_enabled: false, links: [], settings: {} } });
  await page.locator('#attachBtn').click();
  await expect(page.locator('#attachMenu #mtgChatBtn')).toBeHidden();
});

test('no Meeting option for other industries', async ({ page }) => {
  await open(page, { industry: 'ecommerce' });
  await page.locator('#attachBtn').click();
  await expect(page.locator('#attachMenu #mtgChatBtn')).toHaveCount(0);
});

test('Google Meet only (no Cal.com links): no booking-link tab', async ({ page }) => {
  await open(page, { cfg: { enabled: false, chat_enabled: true, links: [], settings: { meet_url: 'https://meet.google.com/abc-defg-hij' } } });
  await page.locator('#attachBtn').click();
  await page.locator('#attachMenu #mtgChatBtn').click();
  await expect(page.getByRole('tab')).toHaveCount(1);
});
