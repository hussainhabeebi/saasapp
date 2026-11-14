// Chats (chats.html) → Attach → ✨ AI Itinerary for Hospitality accounts: pick a property and room,
// fill in the stay, review the AI draft with the property's / room's photos and a photo per place,
// Approve & send puts the photos and the stay PDF into the chat. Hermetic file:// setup like
// chats-ai-itinerary.spec.js, with the worker's hospitality endpoints stubbed.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chatsUrl = 'file://' + path.resolve(__dirname, '../chats.html') + '?client=48&token=t';
const minsAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
const MESSAGES = [{ role: 'user', content: 'Planning 2 nights in Munnar', ts: minsAgo(5) }];
const LEAD = { Id: 7, ClientId: '48', Name: 'Asha', Phone: '919800000000', ConversationID: '55', LastMsgAt: minsAgo(5), ConvHistory: JSON.stringify(MESSAGES) };
// 1×1 PNG so the <img> tags load instead of being removed by onerror.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const PROPS = [
  { id: '3', name: 'Misty Hills Resort', location: 'Munnar, Kerala', amenities: 'Infinity pool, Spa', photos: ['https://img.test/prop1.png', 'https://img.test/prop2.png'],
    price: { from: 4500, to: 9000, currency: 'INR', unit: 'per night' },
    rooms: [{ id: '9', name: 'Valley View Suite', capacity_adults: 3, photos: ['https://img.test/room1.png'], price: { from: 6000, to: 7500, currency: 'INR', unit: 'per night' } }, { id: '10', name: 'Garden Cottage', photos: [] }] },
  { id: '4', name: 'Lake Palace', location: 'Alleppey', photos: [], rooms: [] },
];
const AGENCY = { id: 'a-7', source: 'agency', name: 'Bay View Resort', location: 'Wayanad', photos: ['https://img.test/bay.png'], rooms: [{ id: 'a-7-r1', name: 'Deluxe', photos: [] }] };
const DAYS = [
  { day_no: 1, title: 'Arrival & check-in', overnight: 'Misty Hills Resort', meals: ['D'], items: [{ type: 'hotel', time: '14:00', description: 'Check in and settle in' }] },
  { day_no: 2, title: 'Tea country', meals: ['B'], items: [{ type: 'activity', description: 'Eravikulam National Park', image: 'https://img.test/eravikulam.png' }] },
  { day_no: 3, title: 'Check-out', items: [{ type: 'hotel', description: 'Check out' }] },
];

async function open(page, { industry = 'hospitality', hospitality = 'Yes', draftFails = false, withAgency = false } = {}) {
  const calls = { draft: [], send: [] };
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.protocol === 'file:') return route.continue();
    if (url.hostname === 'img.test') return route.fulfill({ contentType: 'image/png', body: PNG });
    if (url.pathname.endsWith('/session/me')) return route.fulfill({ json: { email: 'owner@x.test', client: { authentik_email: 'owner@x.test', industry, hospitality_enabled: hospitality } } });
    if (/\/nocodb\/api\/v2\/tables\/[^/]+\/records$/.test(url.pathname)) return route.fulfill({ json: { list: [LEAD] } });
    if (url.pathname.endsWith('/chat/messages')) return route.fulfill({ json: { messages: MESSAGES } });
    if (url.pathname.endsWith('/hospitality/chat-properties')) return route.fulfill({ json: { properties: withAgency ? [AGENCY, ...PROPS] : PROPS } });
    if (url.pathname.endsWith('/hospitality/ai-itinerary')) {
      calls.draft.push(req.postDataJSON());
      if (draftFails) return route.fulfill({ status: 422, json: { error: 'AI timed out' } });
      return route.fulfill({ json: { days: DAYS } });
    }
    if (url.pathname.endsWith('/hospitality/chat-itinerary/send')) { calls.send.push(req.postDataJSON()); return route.fulfill({ json: { ok: true, photos_sent: 3, name: 'Stay-Itinerary-Misty-Hills-Resort.pdf' } }); }
    return route.abort();
  });
  await page.goto(chatsUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#list .contact', { hasText: 'Asha' }).click();
  await expect(page.locator('#thread .bubble-row')).toHaveCount(1);
  return calls;
}

test('pick a property and room, review the draft with photos, approve and send', async ({ page }) => {
  const calls = await open(page);
  await page.locator('#attachBtn').click();
  await page.locator('#attachMenu button', { hasText: 'AI Itinerary' }).click();
  const ov = page.locator('#hospItinOv');
  await expect(ov).toContainText('AI Itinerary for Asha');
  await expect(ov.locator('.tpl-item')).toHaveCount(2);
  await page.locator('#hItinSearch').fill('valley');
  await expect(ov.locator('.tpl-item')).toHaveCount(1);
  await ov.locator('.tpl-item', { hasText: 'Misty Hills Resort' }).click();
  // Property photos show straight away; choosing a room adds its photo.
  await expect(ov.locator('#hItinPhotos img')).toHaveCount(2);
  await page.locator('#hItinNights').fill('2');
  await page.locator('#hItinRoom').selectOption('9');
  await expect(ov.locator('#hItinPhotos img')).toHaveCount(3);
  await expect(page.locator('#hItinNights')).toHaveValue('2');
  await page.locator('#hItinCheckIn').fill('2026-12-20');
  await page.locator('#hItinChildren').fill('1');
  await page.locator('#hItinAges').fill('6');
  await page.locator('#hItinInterests label', { hasText: 'Nature' }).click();
  expect(calls.draft).toEqual([]);
  await page.getByRole('button', { name: '✨ Draft itinerary' }).click();
  await expect(ov.locator('.ai-itin-day')).toHaveCount(3);
  await expect(ov.locator('.ai-itin-day').nth(1).locator('li.has-img img')).toHaveCount(1);
  await expect(ov.locator('.ai-itin-day').first()).toContainText('Dinner · 🌙 Misty Hills Resort');
  await expect(ov.locator('.ai-itin-pkg')).toContainText('Valley View Suite · 2 nights · from 2026-12-20');
  expect(calls.draft).toEqual([{ property_id: '3', room_id: '9', nights: '2', check_in: '2026-12-20',
    guest: { adults: '2', children: '1', infants: '', child_ages: '6', pace: '', interests: ['Nature'] } }]);
  // ✏️ Stay details reopens the form with what was entered.
  await page.getByRole('button', { name: '✏️ Stay details' }).click();
  await expect(page.locator('#hItinAges')).toHaveValue('6');
  await expect(page.locator('#hItinRoom')).toHaveValue('9');
  await page.getByRole('button', { name: '✨ Draft itinerary' }).click();
  await expect(ov.locator('.ai-itin-day')).toHaveCount(3);
  await expect(page.locator('#hItinSendPhotos')).toBeChecked();
  await page.getByRole('button', { name: '✅ Approve & send' }).click();
  await expect(ov).toBeHidden();
  expect(calls.send).toHaveLength(1);
  expect(calls.send[0]).toMatchObject({ lead_id: 7, property_id: '3', room_id: '9', nights: '2', check_in: '2026-12-20', send_photos: true,
    caption: '📄 Here is your stay itinerary for *Misty Hills Resort*.' });
  expect(calls.send[0].days.map((d) => d.title)).toEqual(['Arrival & check-in', 'Tea country', 'Check-out']);
  await expect(page.locator('#thread .bubble.out')).toContainText('stay itinerary for');
});

test('a property without photos or rooms still drafts; a failed draft can be retried', async ({ page }) => {
  const calls = await open(page, { draftFails: true });
  await page.evaluate(() => openHospItin());
  await page.locator('#hospItinOv .tpl-item', { hasText: 'Lake Palace' }).click();
  await expect(page.locator('#hItinRoom')).toHaveCount(0);
  await page.getByRole('button', { name: '✨ Draft itinerary' }).click();
  await expect(page.locator('#hItinDetail')).toContainText('AI timed out');
  await expect(page.getByRole('button', { name: '↻ Try again' })).toBeVisible();
  expect(calls.draft[0]).toMatchObject({ property_id: '4', nights: '2' });
  expect(calls.draft[0].room_id).toBeUndefined();
});

test('the hospitality AI Itinerary only shows when Hospitality is on', async ({ page }) => {
  await open(page, { industry: 'ecommerce', hospitality: 'No' });
  await page.locator('#attachBtn').click();
  await expect(page.locator('#attachMenu button', { hasText: 'AI Itinerary' })).toHaveCount(0);
});

test('shows for a hospitality-industry account even without the module flag', async ({ page }) => {
  await open(page, { industry: 'hospitality', hospitality: '' });
  await page.locator('#attachBtn').click();
  await expect(page.locator('#attachMenu #hospItinBtn')).toHaveText(/AI Itinerary/);
});

test('a travel agency with Hospitality on gets both itineraries', async ({ page }) => {
  await open(page, { industry: 'travel', hospitality: 'Yes' });
  await page.locator('#attachBtn').click();
  await expect(page.locator('#attachMenu #aiItinBtn')).toBeVisible();
  await expect(page.locator('#attachMenu #hospItinBtn')).toHaveText(/AI Stay Itinerary/);
  await page.locator('#attachMenu #hospItinBtn').click();
  await expect(page.locator('#hospItinOv .tpl-item')).toHaveCount(2);
});

test('a travel agency gets stay itineraries from its Resorts & Hotels, listed with the Hospitality properties', async ({ page }) => {
  const calls = await open(page, { industry: 'travel', hospitality: 'No', withAgency: true });
  await page.locator('#attachBtn').click();
  await page.locator('#attachMenu #hospItinBtn').click();
  const ov = page.locator('#hospItinOv');
  await expect(ov.locator('.tpl-item')).toHaveCount(3);
  await expect(ov.locator('.tpl-item', { hasText: 'Bay View Resort' })).toContainText('Resorts & Hotels · Wayanad');
  await ov.locator('.tpl-item', { hasText: 'Bay View Resort' }).click();
  await page.locator('#hItinRoom').selectOption('a-7-r1');
  await page.getByRole('button', { name: '✨ Draft itinerary' }).click();
  await expect(ov.locator('.ai-itin-day')).toHaveCount(3);
  expect(calls.draft[0]).toMatchObject({ property_id: 'a-7', room_id: 'a-7-r1' });
});

test('optional price range: off by default, pre-filled from the room, editable, sent with the PDF', async ({ page }) => {
  const calls = await open(page);
  await page.evaluate(() => openHospItin());
  const ov = page.locator('#hospItinOv');
  await ov.locator('.tpl-item', { hasText: 'Misty Hills Resort' }).click();
  await expect(page.locator('#hItinPriceOn')).not.toBeChecked();
  await expect(page.locator('#hItinPriceFrom')).toHaveCount(0);
  await page.locator('#hItinPriceOn').check();
  await expect(page.locator('#hItinPriceFrom')).toHaveValue('4500');
  await expect(page.locator('#hItinPriceTo')).toHaveValue('9000');
  // Choosing a room switches to that room's rates.
  await page.locator('#hItinRoom').selectOption('9');
  await expect(page.locator('#hItinPriceOn')).toBeChecked();
  await expect(page.locator('#hItinPriceFrom')).toHaveValue('6000');
  await page.locator('#hItinPriceTo').fill('8000');
  await page.getByRole('button', { name: '✨ Draft itinerary' }).click();
  await expect(ov.locator('.ai-itin-day')).toHaveCount(3);
  await expect(page.locator('#hItinPriceLine')).toHaveText('💰 INR 6,000 - 8,000 per night');
  await expect(page.locator('#hItinCaption')).toHaveValue('📄 Here is your stay itinerary for *Misty Hills Resort*. 💰 Price range: INR 6,000 - 8,000 per night');
  // The AI draft never gets the price; the send does.
  expect(calls.draft[0].price).toBeUndefined();
  await page.getByRole('button', { name: '✅ Approve & send' }).click();
  await expect(ov).toBeHidden();
  expect(calls.send[0].price).toEqual({ from: 6000, to: 8000, currency: 'INR', unit: 'per night' });
});

test('price range ticked with no rates asks for one before drafting', async ({ page }) => {
  const calls = await open(page);
  await page.evaluate(() => openHospItin());
  await page.locator('#hospItinOv .tpl-item', { hasText: 'Lake Palace' }).click();
  await page.locator('#hItinPriceOn').check();
  await expect(page.locator('#hItinPriceBox')).toContainText('No rates saved');
  await page.getByRole('button', { name: '✨ Draft itinerary' }).click();
  expect(calls.draft).toEqual([]);
  await page.locator('#hItinPriceFrom').fill('3000');
  await page.getByRole('button', { name: '✨ Draft itinerary' }).click();
  await expect.poll(() => calls.draft.length).toBe(1);
});
