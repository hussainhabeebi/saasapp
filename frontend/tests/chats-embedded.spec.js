// Chats inside the CRM: dashboard.html's Chats tab embeds chats.html in an iframe (no new browser
// tab), and the two talk over postMessage — "View lead details" opens the CRM's lead card, and a
// live-notification jump (chatSelectLead) opens that conversation in the embedded page.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');

const hist = JSON.stringify([{ role: 'user', content: 'hi there' }, { role: 'assistant', content: 'hello!' }]);
const LEADS = [
  { Id: 7, ClientId: '48', Name: 'Asha', Phone: '919800000000', ConversationID: '55', LastMsgAt: '2026-09-28T09:00:00.000Z', ConvHistory: hist },
  { Id: 8, ClientId: '48', Name: 'Binu', Phone: '919800000001', ConversationID: '56', LastMsgAt: '2026-09-28T08:00:00.000Z', ConvHistory: hist },
];

async function openChats(page) {
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'file:') return route.continue();
    if (url.pathname.endsWith('/session/me')) return route.fulfill({ json: { email: 'owner@x.test', client: { authentik_email: 'owner@x.test' } } });
    if (/\/nocodb\/api\/v2\/tables\/[^/]+\/records$/.test(url.pathname)) return route.fulfill({ json: { list: LEADS } });
    if (url.pathname.endsWith('/chat/messages')) return route.fulfill({ json: { messages: JSON.parse(hist) } });
    return route.abort();
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate((leads) => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    // @ts-ignore
    clientId = '48'; sessionToken = 't'; allLeads = leads;
    // @ts-ignore
    window.openDetail = (id) => { window.__openedLead = id; };
    // @ts-ignore
    navigate('chats');
  }, LEADS);
  return page.frameLocator('#chatsFrame');
}

test('Chats opens inside the CRM, not in a new tab', async ({ page, context }) => {
  let popups = 0;
  context.on('page', () => popups++);
  const chats = await openChats(page);
  await expect(page.locator('#pageChats')).toBeVisible();
  await expect(chats.locator('#list .contact .name')).toHaveText(['Asha', 'Binu']);
  // The CRM's own navigation replaces the standalone page's "← Dashboard" button.
  await expect(chats.locator('.dash-btn')).toBeHidden();
  expect(popups).toBe(0);
});

test('tapping the contact header opens that lead in the CRM', async ({ page }) => {
  const chats = await openChats(page);
  await chats.locator('#list .contact', { hasText: 'Binu' }).click();
  await chats.locator('.chat-meta').click();
  await expect.poll(() => page.evaluate(() => window.__openedLead)).toBe(8);
  // @ts-ignore
  await expect.poll(() => page.evaluate(() => _chatLeadId)).toBe(8);
});

test('a notification jump opens the conversation in the embedded Chats', async ({ page }) => {
  const chats = await openChats(page);
  await expect(chats.locator('#list .contact')).toHaveCount(2);
  // @ts-ignore
  await page.evaluate(() => chatSelectLead(8));
  await expect(chats.locator('.chat-name')).toHaveText('Binu');
  await expect(chats.locator('#thread .bubble')).toHaveCount(2);
});
