// Chats (chats.html) → Attach → ✨ AI Itinerary (Travel Agency accounts only): pick a package, the
// AI drafts the plan, review it, Approve & send puts the PDF into the chat. Hermetic file:// setup
// like chats-composer.spec.js, with the worker's travel endpoints stubbed.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chatsUrl = 'file://' + path.resolve(__dirname, '../chats.html') + '?client=48&token=t';
const minsAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
const MESSAGES = [{ role: 'user', content: 'Do you have a Bali trip?', ts: minsAgo(5) }];
const LEAD = { Id: 7, ClientId: '48', Name: 'Asha', Phone: '919800000000', ConversationID: '55', LastMsgAt: minsAgo(5), ConvHistory: JSON.stringify(MESSAGES) };
const DAYS = [
  { day_no: 1, title: 'Arrival in Bali', description: 'Airport pickup and hotel check-in.', overnight: 'Kuta', meals: ['D'], items: [{ type: 'activity', time: '17:00', description: 'Kuta Beach sunset' }] },
  { day_no: 2, title: 'Ubud tour', items: [{ type: 'activity', description: 'Tegallalang rice terraces' }] },
];

async function open(page, { industry = 'travel', draftFails = false } = {}) {
  const calls = { draft: [], send: [] };
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.protocol === 'file:') return route.continue();
    if (url.pathname.endsWith('/session/me')) return route.fulfill({ json: { email: 'owner@x.test', client: { authentik_email: 'owner@x.test', industry } } });
    if (/\/nocodb\/api\/v2\/tables\/[^/]+\/records$/.test(url.pathname)) return route.fulfill({ json: { list: [LEAD] } });
    if (url.pathname.endsWith('/chat/messages')) return route.fulfill({ json: { messages: MESSAGES } });
    if (url.pathname.endsWith('/travel/chat-packages')) return route.fulfill({ json: { packages: [
      { id: '3', name: 'Bali 4N/5D', destination: 'Bali', nights: 4, price: 2500, currency: 'AED' },
      { id: '4', name: 'Kashmir Delight', destination: 'Kashmir', nights: 5, price: 32000, currency: 'INR' },
    ] } });
    if (url.pathname.endsWith('/travel/ai-itinerary')) {
      calls.draft.push(req.postDataJSON());
      if (draftFails) return route.fulfill({ status: 422, json: { error: 'AI timed out' } });
      return route.fulfill({ json: { days: DAYS } });
    }
    if (url.pathname.endsWith('/travel/chat-itinerary/send')) { calls.send.push(req.postDataJSON()); return route.fulfill({ json: { ok: true } }); }
    return route.abort();
  });
  await page.goto(chatsUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#list .contact', { hasText: 'Asha' }).click();
  await expect(page.locator('#thread .bubble-row')).toHaveCount(1);
  return calls;
}

test('pick a package, review the AI draft, approve and send the PDF into the chat', async ({ page }) => {
  const calls = await open(page);
  await page.locator('#attachBtn').click();
  await page.locator('#attachMenu button', { hasText: 'AI Itinerary' }).click();
  const ov = page.locator('#aiItinOv');
  await expect(ov).toContainText('AI Itinerary for Asha');
  await page.locator('#aiItinSearch').fill('bali');
  await expect(ov.locator('.tpl-item')).toHaveCount(1);
  await ov.locator('.tpl-item', { hasText: 'Bali 4N/5D' }).click();
  await expect(ov.locator('.ai-itin-day')).toHaveCount(2);
  await expect(ov.locator('.ai-itin-day').first()).toContainText('Kuta Beach sunset');
  await expect(ov.locator('.ai-itin-day').first()).toContainText('Dinner · 🌙 Kuta');
  expect(calls.draft).toEqual([{ package_id: '3' }]);
  await page.getByRole('button', { name: '✅ Approve & send' }).click();
  await expect(ov).toBeHidden();
  expect(calls.send).toHaveLength(1);
  expect(calls.send[0]).toMatchObject({ lead_id: 7, package_id: '3', caption: '📄 Here is the itinerary for *Bali 4N/5D*.' });
  expect(calls.send[0].days.map((d) => d.title)).toEqual(['Arrival in Bali', 'Ubud tour']);
  await expect(page.locator('#thread .bubble.out')).toContainText('itinerary for');
});

test('a failed draft says why and can be retried', async ({ page }) => {
  await open(page, { draftFails: true });
  await page.evaluate(() => openAiItin());
  await page.locator('#aiItinOv .tpl-item', { hasText: 'Kashmir' }).click();
  await expect(page.locator('#aiItinDetail')).toContainText('AI timed out');
  await expect(page.getByRole('button', { name: '↻ Try again' })).toBeVisible();
});

test('the AI Itinerary option only shows for Travel Agency accounts', async ({ page }) => {
  await open(page, { industry: 'ecommerce' });
  await page.locator('#attachBtn').click();
  await expect(page.locator('#attachMenu button', { hasText: 'AI Itinerary' })).toHaveCount(0);
});
