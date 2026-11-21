// Chats ⋮ menu → "Mark as personal (no reply)": same rule as the dashboard's markLeadPersonal —
// Tags gains "Personal" and OptOut=Yes, so the bot stops replying. The menu then offers
// "Make a lead again", which clears both.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chatsUrl = 'file://' + path.resolve(__dirname, '../chats.html') + '?client=48&token=t';
const MESSAGES = [{ role: 'user', content: 'Hi', ts: '2026-09-28T09:00:00.000Z' }];
const LEAD = { Id: 7, ClientId: '48', Name: 'Asha', Phone: '919800000000', ConversationID: '55', Tags: 'Hot', OptOut: 'No', LastMsgAt: '2026-09-28T09:00:00.000Z', ConvHistory: JSON.stringify(MESSAGES) };

test('mark as personal, then make a lead again', async ({ page }) => {
  const patches = [];
  page.on('dialog', d => d.accept());
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.protocol === 'file:') return route.continue();
    if (url.pathname.endsWith('/session/me')) return route.fulfill({ json: { email: 'owner@x.test', client: { authentik_email: 'owner@x.test' } } });
    if (/\/records$/.test(url.pathname) && req.method() === 'PATCH') { patches.push(req.postDataJSON()); return route.fulfill({ json: { Id: 7 } }); }
    if (/\/nocodb\/api\/v2\/tables\/[^/]+\/records$/.test(url.pathname)) return route.fulfill({ json: { list: [{ ...LEAD }] } });
    if (/\/records\/7$/.test(url.pathname)) return route.fulfill({ json: { ...LEAD } });
    if (url.pathname.endsWith('/chat/messages')) return route.fulfill({ json: { messages: MESSAGES } });
    return route.abort();
  });
  await page.goto(chatsUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#list .contact', { hasText: 'Asha' }).click();
  await expect(page.locator('#thread .bubble-row')).toHaveCount(1);

  await page.locator('[onclick="toggleMenu()"]').click();
  await page.locator('#chatMenu button', { hasText: 'Mark as personal (no reply)' }).click();
  await expect.poll(() => patches).toEqual([{ Id: 7, Tags: 'Hot, Personal', OptOut: 'Yes' }]);
  await expect(page.locator('#botPill')).toContainText('Personal · no reply');

  await page.locator('[onclick="toggleMenu()"]').click();
  await page.locator('#chatMenu button', { hasText: 'Make a lead again' }).click();
  await expect.poll(() => patches.length).toBe(2);
  expect(patches[1]).toEqual({ Id: 7, Tags: 'Hot', OptOut: 'No' });
  await expect(page.locator('#botPill')).toContainText('Bot active');
});
