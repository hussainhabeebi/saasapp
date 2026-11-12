// Chat header: Call always dials an international number (+ country code), and a visible WhatsApp
// button opens the chat in the person's own WhatsApp — on Android an intent with no fixed package,
// so they can pick WhatsApp or WhatsApp Business (another number). Hermetic file:// setup.
import { test, expect, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chatsUrl = 'file://' + path.resolve(__dirname, '../chats.html') + '?client=48&token=t';
const MESSAGES = [{ role: 'user', content: 'Call me on 98470 12345', ts: '2026-09-28T09:00:00.000Z' }];
const LEAD = { Id: 7, ClientId: '48', Name: 'Asha', Phone: '919800000000', ConversationID: '55', LastMsgAt: '2026-09-28T09:00:00.000Z', ConvHistory: JSON.stringify(MESSAGES) };

async function open(page, lead = LEAD) {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'file:') return route.continue();
    if (url.pathname.endsWith('/session/me')) return route.fulfill({ json: { email: 'owner@x.test', client: { authentik_email: 'owner@x.test' } } });
    if (/\/nocodb\/api\/v2\/tables\/[^/]+\/records$/.test(url.pathname)) return route.fulfill({ json: { list: [{ ...lead }] } });
    if (url.pathname.endsWith('/chat/messages')) return route.fulfill({ json: { messages: MESSAGES } });
    return route.abort();
  });
  await page.goto(chatsUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#list .contact', { hasText: 'Asha' }).click();
  await expect(page.locator('#thread .bubble-row')).toHaveCount(1);
}

test('call dials +country code; WhatsApp button opens wa.me', async ({ page }) => {
  await open(page);
  await expect(page.locator('#callBtn')).toHaveAttribute('href', 'tel:+919800000000');
  await expect(page.locator('#waBtn')).toBeVisible();
  await expect(page.locator('#waBtn')).toHaveAttribute('href', 'https://wa.me/919800000000');
  // A local number in a message is linked with the default code too.
  await expect(page.locator('#thread a[href^="tel:"]')).toHaveAttribute('href', 'tel:+919847012345');
});

test('a hand-typed local number gets the default country code', async ({ page }) => {
  await open(page, { ...LEAD, Phone: '09800000000' });
  await expect(page.locator('#callBtn')).toHaveAttribute('href', 'tel:+919800000000');
  const r = await page.evaluate(() => [intlTel('+971 50 123 4567'), intlTel('0044 20 7946 0958'), intlTel('12')]);
  expect(r).toEqual(['+971501234567', '+442079460958', '']);
});

test.describe('on an Android phone', () => {
  const { defaultBrowserType, ...pixel } = devices['Pixel 7'];
  test.use(pixel);
  test('WhatsApp button is visible and lets Android pick the WhatsApp app', async ({ page }) => {
    await open(page);
    const wa = page.locator('#waBtn');
    await expect(wa).toBeVisible();
    await expect(page.locator('#callBtn')).toBeVisible();
    const href = await wa.getAttribute('href');
    expect(href).toBe('intent://send/?phone=919800000000#Intent;scheme=whatsapp;S.browser_fallback_url=https%3A%2F%2Fwa.me%2F919800000000;end');
    expect(href).not.toContain('package=');
  });
});
