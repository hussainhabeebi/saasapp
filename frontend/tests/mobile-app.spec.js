// Phones: dashboard.html sends a signed-in phone to m.html (Home · Chats · More, WhatsApp-style),
// Chats opens full-screen with the bottom bar hidden, Back closes the chat, and big photos are
// shrunk before upload so WhatsApp's 5 MB image limit and slow mobile data don't stop them.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mUrl = 'file://' + path.resolve(__dirname, '../m.html');
const chatsUrl = 'file://' + path.resolve(__dirname, '../chats.html') + '?client=48&token=t';

const ROWS = [
  { lead_id: 7, name: 'Asha', phone: '919800000000', channel: 'whatsapp', status: 'open', unread_count: 2, last_message_at: new Date().toISOString(), last_message_preview: 'Is it available?', last_message_dir: 'in', conv_id: '55' },
  { lead_id: 8, name: 'Binu', phone: '919800000001', channel: 'whatsapp', status: 'open', unread_count: 0, last_message_at: new Date(Date.now() - 3600e3).toISOString(), last_message_preview: 'Thanks', last_message_dir: 'out', conv_id: '56' },
];
const COUNTS = { all: 2, unread: 1, needs: 3, mine: 0, unassigned: 4, pending: 0, snoozed: 0, resolved: 0, unread_by_channel: { whatsapp: 1, instagram: 0 }, by_category: {}, by_source: {} };
const LEADS = ROWS.map((r) => ({ Id: r.lead_id, ClientId: '48', Name: r.name, Phone: r.phone, ConversationID: r.conv_id, LastMsgAt: r.last_message_at, ConvHistory: JSON.stringify([{ role: 'user', content: 'hi' }]) }));

async function routes(page, calls = { upload: [] }) {
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.protocol === 'file:') return route.continue();
    if (url.pathname.endsWith('/session/me')) return route.fulfill({ json: { email: 'asha.owner@x.test', client: { authentik_email: 'asha.owner@x.test', client_name: 'Couplo' } } });
    if (url.pathname.endsWith('/chats/v2/counts')) return route.fulfill({ json: COUNTS });
    if (url.pathname.endsWith('/chats/v2/list') && url.searchParams.get('limit') === '8') return route.fulfill({ json: { rows: ROWS } });
    if (/\/nocodb\/api\/v2\/tables\/[^/]+\/records$/.test(url.pathname)) return route.fulfill({ json: { list: LEADS } });
    if (url.pathname.endsWith('/chat/messages')) return route.fulfill({ json: { messages: [{ role: 'user', content: 'hi' }] } });
    if (url.pathname.endsWith('/quote/send')) {
      calls.upload.push(req.postDataBuffer() || Buffer.alloc(0));
      return route.fulfill({ json: { ok: true, data: { attachments: [{ data_url: 'https://cdn.test/up' }] } } });
    }
    return route.abort();
  });
  return calls;
}

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('Home shows chat counts and recent chats; a recent chat opens full-screen and Back closes it', async ({ page }) => {
    await routes(page);
    await page.goto(mUrl);
    await page.evaluate(() => { localStorage.setItem('lv_cid', '48'); localStorage.setItem('lv_session', 't'); });
    await page.goto(mUrl);
    await expect(page.locator('#cUnread')).toHaveText('1');
    await expect(page.locator('#cNeeds')).toHaveText('3');
    await expect(page.locator('#chatDot')).toHaveText('1');
    await expect(page.locator('#recent .row .nm')).toHaveText(['Asha', 'Binu']);
    await expect(page.locator('#biz')).toHaveText('Couplo');

    await page.locator('#recent .row', { hasText: 'Binu' }).click();
    await expect(page.locator('#tabChats')).toBeVisible();
    const chats = page.frameLocator('#chatsFrame');
    await expect(chats.locator('.chat-name')).toHaveText('Binu');
    // WhatsApp-style: an open chat takes the whole screen.
    await expect(page.locator('#nav')).toBeHidden();

    await page.goBack();
    await expect(page.locator('#nav')).toBeVisible();
    await expect(chats.locator('#main')).not.toHaveClass(/open/);
    await expect(page.locator('#tabChats')).toBeVisible();
    await page.goBack();
    await expect(page.locator('#tabHome')).toBeVisible();
  });

  test('Back closes a menu sheet open inside Chats instead of leaving the Chats tab', async ({ page }) => {
    await routes(page);
    await page.goto(mUrl);
    await page.evaluate(() => { localStorage.setItem('lv_cid', '48'); localStorage.setItem('lv_session', 't'); });
    await page.goto(mUrl + '#chats');
    const frame = page.frameLocator('#chatsFrame');
    await expect(frame.locator('#list .contact').first()).toBeVisible();
    const chats = page.frames().find((f) => f.url().includes('chats.html'));
    // Chats tells the app a sheet opened (it does this from syncBackdrop), and counts close requests.
    await chats.evaluate(() => {
      window.__closes = 0;
      addEventListener('message', (e) => { if (e.data?.source === 'lv-dashboard' && e.data.close) window.__closes++; });
      parent.postMessage({ source: 'lv-chats', type: 'sheet', open: true }, '*');
    });
    await expect.poll(() => page.evaluate(() => history.state?.lvChatSheet)).toBe(1);
    await page.goBack();
    await expect.poll(() => chats.evaluate(() => window.__closes)).toBe(1);
    await expect(page.locator('#tabChats')).toBeVisible();
    await expect(page.locator('#nav')).toBeVisible();
  });

  test('More opens CRM pages in the full dashboard', async ({ page }) => {
    await routes(page);
    await page.goto(mUrl);
    await page.evaluate(() => { localStorage.setItem('lv_cid', '48'); localStorage.setItem('lv_session', 't'); });
    await page.goto(mUrl + '#more');
    await expect(page.locator('#tabMore')).toBeVisible();
    const nav = page.waitForURL(/dashboard\.html\?full=1&page=reports/);
    await page.locator('#tabMore .item', { hasText: 'Reports' }).click();
    await nav;
  });

  test('a signed-in phone opening the dashboard lands in the light app', async ({ page }) => {
    await routes(page);
    await page.goto(mUrl);
    await page.evaluate(() => { localStorage.setItem('lv_cid', '48'); localStorage.setItem('lv_session', 't'); });
    await page.goto('file://' + path.resolve(__dirname, '../dashboard.html'));
    await page.waitForURL(/m\.html/);
  });
});

test('a large phone photo is shrunk to a JPEG before upload', async ({ page }) => {
  const calls = await routes(page);
  await page.goto(chatsUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#list .contact', { hasText: 'Asha' }).click();
  // A 2400×1600 noisy PNG, well over the shrink threshold — like a camera photo. Built in the page
  // and handed to the file input directly; type left empty like some Android galleries do.
  const bigSize = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 2400; c.height = 1600;
    const x = c.getContext('2d'); const d = x.createImageData(2400, 1600);
    for (let i = 0; i < d.data.length; i++) d.data[i] = (i & 3) === 3 ? 255 : (Math.random() * 256) | 0;
    x.putImageData(d, 0, 0);
    const b = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer(); dt.items.add(new File([b], 'IMG_2041.png', { type: '' }));
    const inp = document.getElementById('fileInput'); inp.files = dt.files; inp.dispatchEvent(new Event('change'));
    return b.size;
  });
  expect(bigSize).toBeGreaterThan(900 * 1024);
  await page.locator('#previewOv .send').click();
  await expect.poll(() => calls.upload.length, { timeout: 10000 }).toBe(1);
  const body = calls.upload[0];
  expect(body.length).toBeLessThan(bigSize);
  expect(body.toString('latin1')).toContain('filename="IMG_2041.jpg"');
  expect(body.toString('latin1')).toContain('Content-Type: image/jpeg');
});
