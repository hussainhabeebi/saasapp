// Chats (chats.html) → Attach → 📍 location chips for Travel Agency accounts: Wayanad / Vythiri /
// Munnar open the stay itinerary picker on that location's properties, with location tabs on top.
// A teammate the worker marks `restricted` (Destination Staff Routing → Hotels & Resorts locations)
// only gets their own locations. Other industries get none of this. Hermetic file:// setup like
// chats-hospitality-itinerary.spec.js.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chatsUrl = 'file://' + path.resolve(__dirname, '../chats.html') + '?client=48&token=t';
const minsAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
const MESSAGES = [{ role: 'user', content: 'Need a resort for 2 nights', ts: minsAgo(5) }];
const LEAD = { Id: 7, ClientId: '48', Name: 'Asha', Phone: '919800000000', ConversationID: '55', LastMsgAt: minsAgo(5), ConvHistory: JSON.stringify(MESSAGES) };
const prop = (id, name, location) => ({ id: 'a-' + id, source: 'agency', brochure: true, name, location, photos: [], rooms: [] });
const ALL = [prop(1, 'Bay View Resort', 'Wayanad'), prop(2, 'Green Valley', 'Vythiri'), prop(3, 'Misty Hills', 'Munnar, Kerala'), prop(4, 'Tea Estate Villa', 'Munnar')];

async function open(page, { industry = 'travel', restricted = null, cached = false } = {}) {
  const calls = { props: 0, me: 0 };
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'file:') return route.continue();
    if (url.pathname.endsWith('/session/me')) { calls.me++; return route.fulfill({ json: { email: 'anu@x.test', client: { authentik_email: 'owner@x.test', industry } } }); }
    if (/\/nocodb\/api\/v2\/tables\/[^/]+\/records$/.test(url.pathname)) return route.fulfill({ json: { list: [LEAD] } });
    if (url.pathname.endsWith('/chat/messages')) return route.fulfill({ json: { messages: MESSAGES } });
    if (url.pathname.endsWith('/hospitality/chat-properties')) {
      calls.props++;
      const props = restricted ? ALL.filter((p) => restricted.some((l) => p.location.includes(l))) : ALL;
      return route.fulfill({ json: { properties: props, my_locations: restricted || [], restricted: !!restricted } });
    }
    return route.abort();
  });
  if (cached) await page.addInitScript(() => localStorage.setItem('lv_chats_me_48', JSON.stringify({ t: 't', me: { email: 'anu@x.test', client: { industry: 'travel' } } })));
  await page.goto(chatsUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#list .contact', { hasText: 'Asha' }).click();
  await expect(page.locator('#thread .bubble-row')).toHaveCount(1);
  return calls;
}

test('travel agency: Attach lists each location; a chip opens that location with tabs', async ({ page }) => {
  const calls = await open(page);
  await page.locator('#attachBtn').click();
  const chips = page.locator('#attachLocs .chips button');
  await expect(chips).toHaveText(['📍 Munnar', '📍 Vythiri', '📍 Wayanad']);
  expect(calls.props).toBe(1); // prefetched once in the background, shared with the picker
  await chips.filter({ hasText: 'Wayanad' }).click();
  const ov = page.locator('#hospItinOv');
  await expect(ov.locator('.tpl-item')).toHaveText([/Bay View Resort/]);
  await expect(ov.locator('#hItinLocs .pill.active')).toHaveText('📍 Wayanad');
  await ov.locator('#hItinLocs .pill', { hasText: 'Munnar' }).click();
  await expect(ov.locator('.tpl-item')).toHaveText([/Misty Hills/, /Tea Estate Villa/]);
  await ov.locator('#hItinLocs .pill', { hasText: 'All' }).click();
  await expect(ov.locator('.tpl-item')).toHaveCount(4);
  expect(calls.props).toBe(1);
});

test('restricted teammate: only their own locations, in Attach and in the picker', async ({ page }) => {
  await open(page, { restricted: ['Wayanad'] });
  await page.locator('#attachBtn').click();
  await expect(page.locator('#attachLocs .lbl')).toHaveText('📍 Your locations');
  await expect(page.locator('#attachLocs .chips button')).toHaveText(['📍 Wayanad']);
  await page.locator('#hospItinBtn').click();
  const ov = page.locator('#hospItinOv');
  await expect(ov.locator('.tpl-item')).toHaveText([/Bay View Resort/]);
  await expect(ov.locator('#hItinLocs .pill')).toHaveText(['All my locations', '📍 Wayanad']);
  await expect(ov.locator('.h-loc-note')).toContainText('Wayanad');
});

test('not a travel agency: no location chips or tabs', async ({ page }) => {
  const calls = await open(page, { industry: 'hospitality' });
  await page.locator('#attachBtn').click();
  await expect(page.locator('#attachLocs')).toHaveCount(0);
  expect(calls.props).toBe(0);
});

test('fast open: a cached session for the same token paints without waiting, and is re-checked', async ({ page }) => {
  const calls = await open(page, { cached: true });
  expect(calls.me).toBe(1);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('lv_chats_me_48')).me.email)).toBe('anu@x.test');
});

test('fast open: a refused session hides the cached view', async ({ page }) => {
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'file:') return route.continue();
    if (url.pathname.endsWith('/session/me')) return route.fulfill({ status: 401, json: { error: 'expired' } });
    if (/\/nocodb\/api\/v2\/tables\/[^/]+\/records$/.test(url.pathname)) return route.fulfill({ json: { list: [LEAD] } });
    return route.abort();
  });
  await page.addInitScript(() => localStorage.setItem('lv_chats_me_48', JSON.stringify({ t: 't', me: { email: 'anu@x.test', client: { industry: 'travel' } } })));
  await page.goto(chatsUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#loadingText')).toHaveText(/Session expired/);
  await expect(page.locator('#app')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('lv_chats_me_48'))).toBeNull();
});
