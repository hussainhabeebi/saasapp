// Standalone Chats (chats.html) ⋮ menu: a person can take a chat over from the bot and hand it
// back (POST /chat/handover), a bar in the thread shows while the bot is paused, and the menu no
// longer links to the Matrimonial profile. Hermetic file:// setup like the other specs.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chatsUrl = 'file://' + path.resolve(__dirname, '../chats.html') + '?client=48&token=t';

const MESSAGES = [{ role: 'user', content: 'Price', ts: '2026-09-28T09:00:00.000Z' }];
const LEAD = { Id: 7, ClientId: '48', Name: 'Asha', Phone: '919800000000', ConversationID: '55', LastMsgAt: '2026-09-28T09:00:00.000Z', ConvHistory: JSON.stringify(MESSAGES) };

async function open(page, lead = LEAD) {
  const calls = [];
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.protocol === 'file:') return route.continue();
    if (url.pathname.endsWith('/session/me')) return route.fulfill({ json: { email: 'owner@x.test', client: { authentik_email: 'owner@x.test' } } });
    if (/\/nocodb\/api\/v2\/tables\/[^/]+\/records$/.test(url.pathname)) return route.fulfill({ json: { list: [{ ...lead }] } });
    if (url.pathname.endsWith('/chat/messages')) return route.fulfill({ json: { messages: MESSAGES } });
    if (url.pathname.endsWith('/chat/handover')) {
      const b = req.postDataJSON();
      calls.push(b);
      return route.fulfill({ json: { ok: true, lead: b.takeover ? { Handover: 'Yes', HandoverBy: 'owner@x.test' } : { Handover: 'No', HandoverBy: '' } } });
    }
    return route.abort();
  });
  await page.goto(chatsUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#list .contact', { hasText: 'Asha' }).click();
  await expect(page.locator('#thread .bubble-row')).toHaveCount(1);
  return calls;
}

test('take over from the bot, then hand it back', async ({ page }) => {
  const calls = await open(page);
  await expect(page.locator('#handoverBar')).toBeHidden();

  await page.locator('[onclick="toggleMenu()"]').click();
  await page.locator('#chatMenu button', { hasText: 'Take over from bot' }).click();
  await expect.poll(() => calls).toEqual([{ lead_id: 7, takeover: true }]);
  await expect(page.locator('#handoverBar')).toBeVisible();

  await page.locator('[onclick="toggleMenu()"]').click();
  await expect(page.locator('#chatMenu button', { hasText: 'Hand back to bot' })).toBeVisible();
  await page.locator('[onclick="toggleMenu()"]').click();

  await page.locator('#handoverBar button').click();
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[1]).toEqual({ lead_id: 7, takeover: false });
  await expect(page.locator('#handoverBar')).toBeHidden();
});

test('a chat already handed over shows the bar and offers Hand back', async ({ page }) => {
  await open(page, { ...LEAD, Handover: 'Yes' });
  await expect(page.locator('#handoverBar')).toBeVisible();
  await page.locator('[onclick="toggleMenu()"]').click();
  await expect(page.locator('#chatMenu button', { hasText: 'Hand back to bot' })).toBeVisible();
});

test('the menu no longer links to the Matrimonial profile', async ({ page }) => {
  await open(page);
  await page.locator('[onclick="toggleMenu()"]').click();
  await expect(page.locator('#chatMenu button', { hasText: 'View lead details' })).toBeVisible();
  await expect(page.locator('#chatMenu')).not.toContainText('Matrimonial');
});
