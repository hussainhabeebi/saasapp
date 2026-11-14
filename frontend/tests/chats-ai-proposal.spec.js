// Chats (chats.html) → Attach → 📑 AI Proposal for General accounts: pick products / services and
// quantities, add notes, review the AI draft (edit wording, prices, discount, tax), Approve & send
// puts the proposal PDF into the chat. Hermetic file:// setup like chats-hospitality-itinerary.spec.js.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chatsUrl = 'file://' + path.resolve(__dirname, '../chats.html') + '?client=48&token=t';
const minsAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
const MESSAGES = [{ role: 'user', content: 'Need hot water for a family of 6', ts: minsAgo(5) }];
const LEAD = { Id: 7, ClientId: '48', Name: 'Asha', Phone: '919800000000', ConversationID: '55', LastMsgAt: minsAgo(5), ConvHistory: JSON.stringify(MESSAGES) };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const ITEMS = [
  { id: '1', kind: 'product', name: 'Solar Water Heater', price: 42000, currency: 'INR', status: 'active', photos: ['https://img.test/heater.png'] },
  { id: '3', kind: 'service', name: 'Annual Maintenance', price: 2500, currency: 'INR', price_unit: 'year', status: 'active', photos: [] },
  { id: '4', kind: 'service', name: 'Site Survey', price: null, currency: 'INR', status: 'active', photos: [] },
  { id: '5', kind: 'product', name: 'Old Panel', status: 'inactive', photos: [] },
];
const DRAFT = { title: 'Hot water for the family', summary: 'You need hot water for 6 people.', benefits: ['Local team'], next_steps: ['Book a site visit'], terms: ['Valid 15 days'], closing: 'Thank you!',
  items: [{ id: '1', name: 'Solar Water Heater', qty: 2, unit_price: 42000, currency: 'INR', description: 'Fits a family of 6.' },
    { id: '3', name: 'Annual Maintenance', qty: 1, unit_price: 2500, currency: 'INR', price_unit: 'year', description: 'Keeps it running.' }] };

async function open(page, { industry = 'general', draftFails = false } = {}) {
  const calls = { draft: [], send: [] };
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.protocol === 'file:') return route.continue();
    if (url.hostname === 'img.test') return route.fulfill({ contentType: 'image/png', body: PNG });
    if (url.pathname.endsWith('/session/me')) return route.fulfill({ json: { email: 'owner@x.test', client: { authentik_email: 'owner@x.test', industry } } });
    if (/\/nocodb\/api\/v2\/tables\/[^/]+\/records$/.test(url.pathname)) return route.fulfill({ json: { list: [LEAD] } });
    if (url.pathname.endsWith('/chat/messages')) return route.fulfill({ json: { messages: MESSAGES } });
    if (url.pathname.endsWith('/catalog/items')) return route.fulfill({ json: { items: ITEMS } });
    if (url.pathname.endsWith('/catalog/ai-proposal')) {
      calls.draft.push(req.postDataJSON());
      if (draftFails) return route.fulfill({ status: 422, json: { error: 'AI timed out' } });
      return route.fulfill({ json: { proposal: DRAFT } });
    }
    if (url.pathname.endsWith('/catalog/chat-proposal/send')) { calls.send.push(req.postDataJSON()); return route.fulfill({ json: { ok: true, photos_sent: 1, name: 'Proposal-Asha.pdf' } }); }
    return route.abort();
  });
  await page.goto(chatsUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#list .contact', { hasText: 'Asha' }).click();
  await expect(page.locator('#thread .bubble-row')).toHaveCount(1);
  return calls;
}

test('pick items, draft from the chat, edit prices and tax, approve and send', async ({ page }) => {
  const calls = await open(page);
  await page.locator('#attachBtn').click();
  await page.locator('#attachMenu button', { hasText: 'AI Proposal' }).click();
  const ov = page.locator('#aiPropOv');
  await expect(ov).toContainText('AI Proposal for Asha');
  // Inactive items are not offered.
  await expect(ov.locator('.tpl-item')).toHaveCount(3);
  await page.locator('#aiPropSearch').fill('solar');
  await expect(ov.locator('.tpl-item')).toHaveCount(1);
  await ov.locator('.tpl-item', { hasText: 'Solar Water Heater' }).click();
  await page.locator('#aiPropSearch').fill('');
  await ov.locator('.tpl-item', { hasText: 'Annual Maintenance' }).click();
  await expect(ov.locator('.prop-row')).toHaveCount(2);
  await page.locator('#aiPropQty1').fill('2');
  await page.locator('#aiPropNotes').fill('Mention free installation');
  expect(calls.draft).toEqual([]);
  await page.getByRole('button', { name: '✨ Draft proposal' }).click();
  await expect(page.locator('#aiPropTitle')).toHaveValue('Hot water for the family');
  expect(calls.draft).toEqual([{ lead_id: 7, items: [{ id: '1', qty: 2 }, { id: '3', qty: 1 }], notes: 'Mention free installation' }]);
  await expect(page.locator('#aiPropTotals')).toContainText('INR 86,500');
  // Edit a price and add GST — the totals follow.
  await page.locator('#aiPropRPrice0').fill('40000');
  await page.locator('#aiPropTax').fill('18');
  await expect(page.locator('#aiPropTotals')).toContainText('GST (18%)');
  await expect(page.locator('#aiPropTotals')).toContainText('INR 97,350');
  await page.locator('#aiPropSummary').fill('Edited overview.');
  await page.locator('#aiPropSendPhotos').check();
  await page.getByRole('button', { name: '✅ Approve & send' }).click();
  await expect(ov).toBeHidden();
  expect(calls.send).toHaveLength(1);
  const sent = calls.send[0];
  expect(sent).toMatchObject({ lead_id: 7, send_photos: true, caption: '📄 Here is our proposal: *Hot water for the family*.' });
  expect(sent.proposal).toMatchObject({ summary: 'Edited overview.', tax_pct: 18, tax_label: 'GST', valid_days: 15, benefits: ['Local team'] });
  expect(sent.proposal.items.map((r) => [r.id, r.qty, r.unit_price])).toEqual([['1', 2, 40000], ['3', 1, 2500]]);
  await expect(page.locator('#thread .bubble.out')).toContainText('Here is our proposal');
});

test('a failed draft can be retried, and ✏️ Items keeps the selection', async ({ page }) => {
  const calls = await open(page, { draftFails: true });
  await page.evaluate(() => openAiProp());
  await page.locator('#aiPropOv .tpl-item', { hasText: 'Site Survey' }).click();
  await page.getByRole('button', { name: '✨ Draft proposal' }).click();
  await expect(page.locator('#aiPropDetail')).toContainText('AI timed out');
  await page.getByRole('button', { name: '✏️ Items' }).click();
  await expect(page.locator('#aiPropOv .prop-row')).toHaveCount(1);
  await page.getByRole('button', { name: '✨ Draft proposal' }).click();
  await expect(page.getByRole('button', { name: '↻ Try again' })).toBeVisible();
  expect(calls.draft.map((d) => d.items)).toEqual([[{ id: '4', qty: 1 }], [{ id: '4', qty: 1 }]]);
});

test('AI Proposal is only for General accounts', async ({ page }) => {
  await open(page, { industry: 'ecommerce' });
  await page.locator('#attachBtn').click();
  await expect(page.locator('#attachMenu #aiPropBtn')).toHaveCount(0);
});

test('a free-text industry counts as General', async ({ page }) => {
  await open(page, { industry: 'Marketing Agency' });
  await page.locator('#attachBtn').click();
  await expect(page.locator('#attachMenu #aiPropBtn')).toBeVisible();
});
