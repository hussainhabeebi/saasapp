// Chats (chats.html): photos sent and received show as real images (not the AI's description of
// them), voice notes show their transcript, and approved WhatsApp templates can be sent from the
// chat — with a banner once the 24-hour window has closed. Hermetic file:// setup like the others.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chatsUrl = 'file://' + path.resolve(__dirname, '../chats.html') + '?client=48&token=t';

const MESSAGES = [
  { role: 'user', content: 'A red cotton dress on a hanger.', ts: '2026-09-20T09:00:00.000Z', attachment: { kind: 'image', url: 'https://cw.test/in.jpg', caption: 'Do you have this?', ai_text: true } },
  { role: 'user', content: 'A blue shirt.', ts: '2026-09-20T09:01:00.000Z', attachment: { kind: 'image', url: 'https://cw.test/in2.jpg', caption: '', ai_text: true } },
  { role: 'user', content: 'what is the price', ts: '2026-09-20T09:02:00.000Z', attachment: { kind: 'voice', url: 'https://cw.test/v.ogg', caption: '', ai_text: true } },
  { role: 'assistant', content: 'Here is our bestseller', ts: '2026-09-20T09:03:00.000Z', attachment: { kind: 'image', url: 'https://cw.test/out.jpg' } },
];
const TEMPLATES = { data: [
  { name: 'order_update', status: 'APPROVED', language: 'en', category: 'UTILITY', components: [
    { type: 'BODY', text: 'Hi {{1}}, your order {{2}} is ready.' },
    { type: 'FOOTER', text: 'Reply STOP to opt out' },
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Track order' }] },
  ] },
  { name: 'draft_one', status: 'PENDING', language: 'en', components: [{ type: 'BODY', text: 'x' }] },
] };

async function open(page, lead) {
  const calls = { chatwootTpl: [], metaTpl: [] };
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.protocol === 'file:') return route.continue();
    if (url.pathname.endsWith('/session/me')) return route.fulfill({ json: { email: 'owner@x.test', client: { authentik_email: 'owner@x.test' } } });
    if (/\/nocodb\/api\/v2\/tables\/[^/]+\/records$/.test(url.pathname)) return route.fulfill({ json: { list: [lead] } });
    if (url.pathname.endsWith('/chat/messages')) return route.fulfill({ json: { messages: MESSAGES } });
    if (url.pathname.endsWith('/wa/templates')) return route.fulfill({ json: TEMPLATES });
    if (url.pathname.endsWith('/broadcast/send-template')) { calls.chatwootTpl.push(req.postDataJSON()); return route.fulfill({ json: { ok: true } }); }
    if (url.pathname.endsWith('/wa/send-template')) { calls.metaTpl.push(req.postDataJSON()); return route.fulfill({ json: { ok: true } }); }
    return route.abort();
  });
  await page.goto(chatsUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#list .contact').first().click();
  await expect(page.locator('#thread .bubble-row')).toHaveCount(4);
  return calls;
}
const LEAD = { Id: 7, ClientId: '48', Name: 'Asha', Phone: '919800000000', ConversationID: '55', LastMsgAt: '2026-09-20T09:03:00.000Z', LastCustomerMsgAt: '2026-09-20T09:02:00.000Z', ConvHistory: JSON.stringify(MESSAGES) };

test('received and sent photos show as images, with the customer\'s caption instead of the AI description', async ({ page }) => {
  await open(page, LEAD);
  const rows = page.locator('#thread .bubble-row');
  await expect(rows.nth(0).locator('img.media')).toHaveAttribute('src', 'https://cw.test/in.jpg');
  await expect(rows.nth(0)).toContainText('Do you have this?');
  await expect(rows.nth(0)).not.toContainText('red cotton dress');
  // A photo with no caption is a WhatsApp-style image-only bubble.
  await expect(rows.nth(1).locator('.bubble')).toHaveClass(/media-only/);
  await expect(rows.nth(2).locator('.transcript')).toHaveText('what is the price');
  await expect(rows.nth(3).locator('img.media')).toHaveAttribute('src', 'https://cw.test/out.jpg');
  await expect(page.locator('#list .preview')).toContainText('Here is our bestseller');
});

test('after 24h the composer offers a template; sending one fills {{1}} with the name', async ({ page }) => {
  const calls = await open(page, LEAD);
  await expect(page.locator('#windowBar')).toBeVisible();
  await page.locator('#windowBar button').click();
  await expect(page.locator('#tplItems .tpl-item')).toHaveCount(1); // only APPROVED templates
  await page.locator('#tplItems .tpl-item', { hasText: 'order_update' }).click();
  await expect(page.locator('#tplV_1')).toHaveValue('Asha');
  await page.locator('#tplV_2').fill('#1042');
  await expect(page.locator('#tplPreview')).toContainText('Hi Asha, your order #1042 is ready.');
  await expect(page.locator('#tplPreview .tpl-btns')).toHaveText('Track order');
  await page.locator('#tplDetail .send').click();
  await expect(page.locator('#tplOv')).toBeHidden();
  await expect.poll(() => calls.chatwootTpl.length).toBe(1);
  expect(calls.chatwootTpl[0]).toMatchObject({ conv_id: '55', lead_id: 7, template_name: 'order_update', processed_params: { 1: 'Asha', 2: '#1042' }, buttons: ['Track order'] });
  const sent = page.locator('#thread .bubble.out').last();
  await expect(sent.locator('.tpl-tag')).toContainText('order_update');
  await expect(sent).toContainText('your order #1042 is ready');
  await expect(sent.locator('.checks')).toBeVisible();
});

test('a template to a contact with no Chatwoot conversation goes straight to Meta', async ({ page }) => {
  const calls = await open(page, { ...LEAD, ConversationID: '' });
  await page.locator('#attachBtn').click();
  await page.locator('#attachMenu button', { hasText: 'Template' }).click();
  await page.locator('#tplItems .tpl-item').first().click();
  await page.locator('#tplDetail .send').click();
  await expect(page.locator('#tplErr')).toHaveText('Fill in every variable.');
  await page.locator('#tplV_2').fill('#7');
  await page.locator('#tplDetail .send').click();
  await expect.poll(() => calls.metaTpl.length).toBe(1);
  expect(calls.metaTpl[0]).toMatchObject({ phone: '919800000000', template_name: 'order_update', lead_id: 7,
    components: [{ type: 'body', parameters: [{ type: 'text', text: 'Asha' }, { type: 'text', text: '#7' }] }] });
});

test('no window banner while the customer wrote recently', async ({ page }) => {
  await open(page, { ...LEAD, LastCustomerMsgAt: new Date().toISOString() });
  await expect(page.locator('#windowBar')).toBeHidden();
});
