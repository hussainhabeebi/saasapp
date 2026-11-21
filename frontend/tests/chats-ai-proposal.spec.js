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
    { id: '3', name: 'Annual Maintenance', qty: 1, unit_price: 2500, currency: 'INR', price_unit: 'year', description: 'Keeps it running.', inclusions: ['One visit a year'], exclusions: [] }],
  inclusions: [], exclusions: [] };
DRAFT.items[0].inclusions = ['Standard installation', 'Roof stand']; DRAFT.items[0].exclusions = ['Civil work'];

async function open(page, { industry = 'general', draftFails = false, oldChat = false, tplStatus = 'APPROVED' } = {}) {
  const calls = { draft: [], send: [], tpl: [] };
  const msgs = oldChat ? [{ role: 'user', content: 'Need hot water for a family of 6', ts: minsAgo(3000) }] : MESSAGES;
  const lead = oldChat ? { ...LEAD, LastMsgAt: minsAgo(3000), ConvHistory: JSON.stringify(msgs) } : LEAD;
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.protocol === 'file:') return route.continue();
    if (url.hostname === 'img.test') return route.fulfill({ contentType: 'image/png', body: PNG });
    if (url.pathname.endsWith('/session/me')) return route.fulfill({ json: { email: 'owner@x.test', client: { authentik_email: 'owner@x.test', industry } } });
    if (/\/nocodb\/api\/v2\/tables\/[^/]+\/records$/.test(url.pathname)) return route.fulfill({ json: { list: [lead] } });
    if (url.pathname.endsWith('/chat/messages')) return route.fulfill({ json: { messages: msgs } });
    if (url.pathname.endsWith('/catalog/proposal-template')) { calls.tpl.push(url.search); return route.fulfill({ json: { template: { name: 'leadvyne_proposal_link', language: 'en', status: tplStatus, body: 'Hi {{1}}, please find attached our proposal "{{2}}". You can view and download the PDF here: {{3}}\n\nPlease reply to this message if you have any questions.' } } }); }
    if (url.pathname.endsWith('/catalog/items')) return route.fulfill({ json: { items: ITEMS } });
    if (url.pathname.endsWith('/catalog/ai-proposal')) {
      calls.draft.push(req.postDataJSON());
      if (draftFails) return route.fulfill({ status: 422, json: { error: 'AI timed out' } });
      return route.fulfill({ json: { proposal: DRAFT, customer: { name: 'Asha Nair', phone: '919800000000', email: '', company: '', address: 'TC 12/345, Pattom\nThiruvananthapuram 695004', gstin: '' } } });
    }
    if (url.pathname.endsWith('/catalog/chat-proposal/send')) {
      const b = req.postDataJSON(); calls.send.push(b);
      if (b.window_closed) return route.fulfill({ json: { ok: true, via: 'template', content: 'Hi Asha, please find attached our proposal "Hot water for the family". You can view and download the PDF here: https://w.test/p/abc', link: 'https://w.test/p/abc', ref: 'PRP-2026-0008', stage: 'proposal_sent' } });
      return route.fulfill({ json: { ok: true, photos_sent: 1, name: 'Proposal-Asha.pdf', ref: 'PRP-2026-0007', stage: 'proposal_sent' } });
    }
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
  // "Prepared for": starts from the worker's customer block (the last proposal's address); editable.
  await expect(page.locator('#aiPropCName')).toHaveValue('Asha Nair');
  await expect(page.locator('#aiPropCAddr')).toHaveValue('TC 12/345, Pattom\nThiruvananthapuram 695004');
  await page.locator('#aiPropCCompany').fill('Nair Residence');
  await page.locator('#aiPropCEmail').fill('asha@example.com');
  await page.locator('#aiPropBy').fill('Rahul');
  // Inclusions / exclusions: each item's come from the catalogue (editable), plus the whole job's.
  await expect(page.locator('#aiPropR0Inc')).toHaveValue('Standard installation\nRoof stand');
  await expect(page.locator('#aiPropR0Exc')).toHaveValue('Civil work');
  await page.locator('#aiPropR0Exc').fill('Civil work\nPlumbing beyond 10 m');
  await page.locator('#aiPropGExc').fill('Permits');
  await page.locator('#aiPropSendPhotos').check();
  await page.getByRole('button', { name: '✅ Approve & send' }).click();
  await expect(ov).toBeHidden();
  expect(calls.send).toHaveLength(1);
  const sent = calls.send[0];
  expect(sent).toMatchObject({ lead_id: 7, send_photos: true, caption: '📄 Here is our proposal: *Hot water for the family*.' });
  expect(sent.proposal).toMatchObject({ summary: 'Edited overview.', tax_pct: 18, tax_label: 'GST', valid_days: 15, benefits: ['Local team'] });
  expect(sent.proposal.items.map((r) => [r.id, r.qty, r.unit_price])).toEqual([['1', 2, 40000], ['3', 1, 2500]]);
  expect(sent.proposal.customer).toEqual({ name: 'Asha Nair', company: 'Nair Residence', address: 'TC 12/345, Pattom\nThiruvananthapuram 695004', phone: '919800000000', email: 'asha@example.com', gstin: '' });
  expect(sent.proposal.prepared_by).toBe('Rahul');
  expect(sent.proposal.items.map((r) => [r.inclusions, r.exclusions])).toEqual([[['Standard installation', 'Roof stand'], ['Civil work', 'Plumbing beyond 10 m']], [['One visit a year'], []]]);
  expect([sent.proposal.inclusions, sent.proposal.exclusions]).toEqual([[], ['Permits']]);
  await expect(page.locator('#thread .bubble.out')).toContainText('Here is our proposal');
  // The lead moved to Proposal Sent — only Follow-up V3's proposal templates go to it now.
  await expect(page.locator('#toast')).toContainText('stage: Proposal Sent');
  await expect(page.locator('#toast')).toContainText('PRP-2026-0007');
});

test('opening AI Proposal makes sure the proposal-link template exists', async ({ page }) => {
  const calls = await open(page);
  await page.locator('#attachBtn').click();
  await expect(page.locator('#attachLockNote')).toBeHidden();
  await page.keyboard.press('Escape');
  await page.evaluate(() => openAiProp());
  await expect.poll(() => calls.tpl.length).toBe(1);
  // Inside the window nothing changes: the PDF goes into the chat.
  await page.locator('#aiPropOv .tpl-item', { hasText: 'Solar Water Heater' }).click();
  await page.getByRole('button', { name: '✨ Draft proposal' }).click();
  await expect(page.locator('#aiPropWin')).toHaveCount(0);
  await expect(page.locator('#aiPropCaption')).toBeVisible();
});

test('after 24 hours the proposal goes as the approved template with a PDF link', async ({ page }) => {
  const calls = await open(page, { oldChat: true });
  // The chat is locked to templates, but Attach → AI Proposal still opens (other options don't).
  await page.locator('#attachBtn').click();
  await expect(page.locator('#attachLockNote')).toBeVisible();
  await expect(page.locator('#attachMenu button', { hasText: 'Document' })).toBeDisabled();
  await expect(page.locator('#attachMenu #aiPropBtn')).toBeEnabled();
  await page.locator('#attachMenu #aiPropBtn').click();
  await expect(page.locator('#aiPropOv')).toBeVisible();
  await page.locator('#aiPropOv .tpl-item', { hasText: 'Solar Water Heater' }).click();
  await page.getByRole('button', { name: '✨ Draft proposal' }).click();
  await expect(page.locator('#aiPropWin')).toContainText('24-hour window closed');
  await expect(page.locator('#aiPropWin')).toContainText('Hi Asha, please find attached our proposal "Hot water for the family". You can view and download the PDF here: (link to the PDF)');
  await expect(page.locator('#aiPropCaption')).toHaveCount(0);
  await expect(page.locator('#aiPropSendPhotos')).toHaveCount(0);
  await page.getByRole('button', { name: '✅ Approve & send link' }).click();
  await expect(page.locator('#aiPropOv')).toBeHidden();
  expect(calls.send[0]).toMatchObject({ lead_id: 7, window_closed: true, send_photos: false });
  await expect(page.locator('#thread .bubble.out').last()).toContainText('https://w.test/p/abc');
  await expect(page.locator('#toast')).toContainText('sent as a WhatsApp template');
});

test('after 24 hours, a template still waiting for Meta blocks the send and can be re-checked', async ({ page }) => {
  const calls = await open(page, { oldChat: true, tplStatus: 'PENDING' });
  await page.evaluate(() => openAiProp());
  await page.locator('#aiPropOv .tpl-item', { hasText: 'Solar Water Heater' }).click();
  await page.getByRole('button', { name: '✨ Draft proposal' }).click();
  await expect(page.locator('#aiPropWin')).toContainText("waiting for Meta's approval");
  await expect(page.getByRole('button', { name: '✅ Approve & send link' })).toBeDisabled();
  await page.getByRole('button', { name: '↻ Check again' }).click();
  await expect.poll(() => calls.tpl.filter((q) => q.includes('refresh=1')).length).toBe(1);
  expect(calls.send).toHaveLength(0);
});

test('send is blocked without a customer name or with a bad email', async ({ page }) => {
  const calls = await open(page);
  await page.evaluate(() => openAiProp());
  await page.locator('#aiPropOv .tpl-item', { hasText: 'Solar Water Heater' }).click();
  await page.getByRole('button', { name: '✨ Draft proposal' }).click();
  await page.locator('#aiPropCName').fill('');
  await page.getByRole('button', { name: '✅ Approve & send' }).click();
  await expect(page.locator('#aiPropErr')).toContainText('customer name');
  await page.locator('#aiPropCName').fill('Asha');
  await page.locator('#aiPropCEmail').fill('not-an-email');
  await page.getByRole('button', { name: '✅ Approve & send' }).click();
  await expect(page.locator('#aiPropErr')).toContainText('email');
  expect(calls.send).toHaveLength(0);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });
  test('pick several items from the list, continue, step quantities, and go back without losing them', async ({ page }) => {
    const calls = await open(page);
    await page.evaluate(() => openAiProp());
    const ov = page.locator('#aiPropOv');
    // Picking stays on the list; the bar at the bottom counts the selection.
    await ov.locator('.tpl-item', { hasText: 'Solar Water Heater' }).tap();
    await expect(page.locator('#aiPropItems')).toBeVisible();
    await ov.locator('.tpl-item', { hasText: 'Annual Maintenance' }).tap();
    await expect(page.locator('#aiPropPickBar')).toContainText('2 items selected');
    await expect(page.locator('#aiPropDetail')).toBeHidden();
    await page.getByRole('button', { name: 'Continue →' }).tap();
    await expect(page.locator('#aiPropItems')).toBeHidden();
    await expect(ov.locator('.prop-row')).toHaveCount(2);
    await ov.locator('.prop-row').first().getByRole('button', { name: 'More' }).tap();
    await expect(page.locator('#aiPropQty1')).toHaveValue('2');
    // Inputs are 16px so iOS doesn't zoom in on focus.
    expect(await page.locator('#aiPropNotes').evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px');
    // Back shows the list again with the selection kept.
    await page.locator('#aiPropOv .bar .icon-btn').tap();
    await expect(page.locator('#aiPropPickBar')).toContainText('2 items selected');
    await page.getByRole('button', { name: 'Continue →' }).tap();
    await expect(page.locator('#aiPropQty1')).toHaveValue('2');
    await page.getByRole('button', { name: '✨ Draft proposal' }).tap();
    await expect(page.locator('#aiPropStep')).toHaveText('2 · Review & send');
    // The send button stays in view at the bottom of the review.
    await expect(page.getByRole('button', { name: '✅ Approve & send' })).toBeInViewport();
    expect(calls.draft[0].items).toEqual([{ id: '1', qty: 2 }, { id: '3', qty: 1 }]);
  });
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
