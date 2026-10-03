// Standalone Chats (chats.html) composer: WhatsApp-style text/reply sends, retry on failure, media
// preview + caption, voice-note recording and playback. Hermetic file:// setup like the other specs;
// Chromium's fake microphone stands in for a real one.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chatsUrl = 'file://' + path.resolve(__dirname, '../chats.html') + '?client=48&token=t';
const sandboxChromium = '/opt/pw-browsers/chromium';

test.use({
  permissions: ['microphone'],
  launchOptions: {
    ...(existsSync(sandboxChromium) ? { executablePath: sandboxChromium } : {}),
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  },
});

const MESSAGES = [
  { role: 'user', content: 'Hi, is this *available*?', ts: '2026-09-28T09:00:00.000Z' },
  { role: 'user', content: '', ts: '2026-09-28T09:01:00.000Z', attachment: { kind: 'voice', url: 'https://cdn.test/v.ogg', duration: 7 } },
  { role: 'assistant', content: 'Here you go', ts: '2026-09-28T09:02:00.000Z', attachment: { name: 'brochure.pdf', size: 20480, url: 'https://cdn.test/b.pdf' } },
];
const LEAD = { Id: 7, ClientId: '48', Name: 'Asha', Phone: '919800000000', ConversationID: '55', LastMsgAt: '2026-09-28T09:02:00.000Z', ConvHistory: JSON.stringify(MESSAGES) };

async function open(page, { failSends = 0 } = {}) {
  const calls = { send: [], upload: [] };
  let failures = failSends;
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.protocol === 'file:') return route.continue();
    if (url.pathname.endsWith('/session/me')) return route.fulfill({ json: { email: 'owner@x.test', client: { authentik_email: 'owner@x.test' } } });
    if (/\/nocodb\/api\/v2\/tables\/[^/]+\/records$/.test(url.pathname)) return route.fulfill({ json: { list: [LEAD] } });
    if (url.pathname.endsWith('/chat/messages')) return route.fulfill({ json: { messages: MESSAGES } });
    if (url.pathname.endsWith('/chat/send')) {
      calls.send.push(req.postDataJSON());
      if (failures-- > 0) return route.fulfill({ status: 502, json: { error: 'HTTP 502' } });
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname.endsWith('/quote/send')) {
      calls.upload.push(req.postDataBuffer()?.toString('latin1') || '');
      return route.fulfill({ json: { ok: true, data: { attachments: [{ data_url: 'https://cdn.test/up' }] } } });
    }
    return route.abort();
  });
  await page.goto(chatsUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#list .contact', { hasText: 'Asha' }).click();
  await expect(page.locator('#thread .bubble-row')).toHaveCount(3);
  return calls;
}

test('renders WhatsApp formatting, a voice-note player and a document card', async ({ page }) => {
  await open(page);
  await expect(page.locator('#thread .bubble b', { hasText: 'available' })).toBeVisible();
  await expect(page.locator('#thread .vp .vp-time')).toHaveText('0:07');
  await expect(page.locator('#thread .doc')).toContainText('brochure.pdf');
  await expect(page.locator('#thread .doc')).toContainText('20 KB');
});

test('mic turns into send when typing; a reply carries the quoted message', async ({ page }) => {
  const calls = await open(page);
  const action = page.locator('#actionBtn');
  await expect(action).toHaveAttribute('data-state', 'mic');
  await page.locator('#thread .bubble-row').first().hover();
  await page.locator('#thread .bubble-row').first().locator('[data-act="reply"]').click();
  await expect(page.locator('#replyBox .reply-card')).toContainText('Hi, is this *available*?');
  await page.locator('#msg').fill('Yes, it is!');
  await expect(action).toHaveAttribute('data-state', 'send');
  await action.click();
  await expect(page.locator('#thread .bubble.out', { hasText: 'Yes, it is!' }).locator('.checks')).toBeVisible();
  expect(calls.send[0]).toMatchObject({ conv_id: '55', lead_id: 7, text: 'Yes, it is!', reply_to: { who: 'Asha' } });
  await expect(page.locator('#replyBox')).toBeHidden();
  await expect(action).toHaveAttribute('data-state', 'mic');
});

test('a failed send stays in the thread with Retry, and retrying delivers it', async ({ page }) => {
  const calls = await open(page, { failSends: 1 });
  await page.locator('#msg').fill('Are you there?');
  await page.locator('#msg').press('Enter');
  const retry = page.locator('#thread .tick-failed');
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(page.locator('#thread .bubble.out', { hasText: 'Are you there?' }).locator('.checks')).toBeVisible();
  expect(calls.send).toHaveLength(2);
});

test('attachments open a preview with a caption before sending', async ({ page }) => {
  const calls = await open(page);
  await page.locator('#fileInput').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('89504e47', 'hex') });
  await expect(page.locator('#previewOv')).toBeVisible();
  await page.locator('#capInput').fill('Latest photo');
  await page.locator('#previewOv .send').click();
  await expect(page.locator('#previewOv')).toBeHidden();
  await expect.poll(() => calls.upload.length).toBe(1);
  expect(calls.upload[0]).toContain('name="lead_id"\r\n\r\n7');
  expect(calls.upload[0]).toContain('Latest photo');
  await expect(page.locator('#thread .bubble.out', { hasText: 'Latest photo' }).locator('.checks')).toBeVisible();
});

test('tap the mic to record, then send a voice note', async ({ page }) => {
  const calls = await open(page);
  await page.locator('#actionBtn').click();
  await expect(page.locator('#recRow')).toBeVisible();
  await expect(page.locator('#recTime')).toHaveText('0:01', { timeout: 5000 });
  await page.locator('#recPause').click();
  await expect(page.locator('#recPlay')).toBeVisible();
  await page.locator('#recPause').click();
  await expect(page.locator('#recTime')).toHaveText('0:02', { timeout: 5000 });
  await page.locator('#actionBtn').click();
  await expect(page.locator('#recRow')).toBeHidden();
  await expect.poll(() => calls.upload.length, { timeout: 10000 }).toBe(1);
  expect(calls.upload[0]).toContain('name="kind"\r\n\r\nvoice');
  expect(calls.upload[0]).toMatch(/filename="voice-[^"]+\.(mp3|ogg|webm)"/);
  await expect(page.locator('#thread .bubble.out .vp .vp-mic.voice')).toBeVisible();
});

test('deleting a recording sends nothing', async ({ page }) => {
  const calls = await open(page);
  await page.locator('#actionBtn').click();
  await expect(page.locator('#recTime')).toHaveText('0:01', { timeout: 5000 });
  await page.locator('#recRow .rec-trash').click();
  await expect(page.locator('#recRow')).toBeHidden();
  await expect(page.locator('#inputWrap')).toBeVisible();
  await page.waitForTimeout(300);
  expect(calls.upload).toHaveLength(0);
});

test('hold the mic to record and release to send; sliding left cancels', async ({ page }) => {
  const calls = await open(page);
  const box = await page.locator('#actionBtn').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await expect(page.locator('#recHint')).toBeVisible();
  await expect(page.locator('#recTime')).toHaveText('0:01', { timeout: 5000 });
  await page.mouse.up();
  await expect.poll(() => calls.upload.length, { timeout: 10000 }).toBe(1);

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await expect(page.locator('#recTime')).toHaveText('0:01', { timeout: 5000 });
  await page.mouse.move(cx - 150, cy, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('#recRow')).toBeHidden();
  await page.waitForTimeout(300);
  expect(calls.upload).toHaveLength(1);
});
