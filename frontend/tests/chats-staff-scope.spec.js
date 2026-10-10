// Standalone Chats (chats.html): with Lead Routing on, a teammate sees only the chats routed to
// them; the account owner still sees every chat. Same hermetic file:// setup as the other specs —
// /session/me and the NocoDB leads list are answered from in-memory fixtures.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chatsUrl = 'file://' + path.resolve(__dirname, '../chats.html') + '?client=48&token=t';

const hist = JSON.stringify([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]);
const LEADS = [
  { Id: 1, ClientId: '48', Name: 'Asha', Owner: 'reshma@couplo.test', ConvHistory: hist },
  { Id: 2, ClientId: '48', Name: 'Binu', Owner: 'Vinaya@Couplo.test', ConvHistory: hist },
  { Id: 3, ClientId: '48', Name: 'Chitra', Owner: '', ConvHistory: hist },
];
const client = { authentik_email: 'owner@couplo.test', lead_routing: JSON.stringify({ enabled: true, modes: ['roundrobin'] }) };

async function open(page, email, clientRec = client, { failOwnerQuery = false } = {}) {
  const listQueries = [];
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'file:') return route.continue();
    if (url.pathname.endsWith('/session/me')) return route.fulfill({ json: { email, client: clientRec } });
    if (/\/nocodb\/api\/v2\/tables\/[^/]+\/records$/.test(url.pathname)) {
      const where = url.searchParams.get('where') || '';
      listQueries.push(where);
      if (failOwnerQuery && where.includes('Owner')) return route.fulfill({ status: 422, json: { msg: 'bad filter' } });
      return route.fulfill({ json: { list: LEADS } });
    }
    return route.abort();
  });
  await page.goto(chatsUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#app')).toBeVisible();
  return listQueries;
}

test('a teammate sees only their own routed chats', async ({ page }) => {
  const queries = await open(page, 'vinaya@couplo.test');
  await expect(page.locator('#list .contact .name')).toHaveText(['Binu']);
  expect(queries[0]).toContain('(Owner,like,vinaya@couplo.test)');
});

test('the account owner sees every chat', async ({ page }) => {
  const queries = await open(page, 'owner@couplo.test');
  await expect(page.locator('#list .contact .name')).toHaveText(['Asha', 'Binu', 'Chitra']);
  expect(queries[0]).not.toContain('Owner');
});

test('with routing off (leads assigned by hand), a teammate sees their own + unassigned, never another teammate\'s', async ({ page }) => {
  const queries = await open(page, 'vinaya@couplo.test', { ...client, lead_routing: '{}' });
  await expect(page.locator('#list .contact .name')).toHaveText(['Binu', 'Chitra']);
  expect(queries[0]).toContain('((Owner,like,vinaya@couplo.test)~or(Owner,blank))');
});

test('a teammate with the Admin or General Manager role sees every chat, like the owner', async ({ page }) => {
  for (const role of ['admin', 'general_manager']) {
    const perms = JSON.stringify({ 'vinaya@couplo.test': { role } });
    const queries = await open(page, 'vinaya@couplo.test', { ...client, team_permissions: perms });
    await expect(page.locator('#list .contact .name')).toHaveText(['Asha', 'Binu', 'Chitra']);
    expect(queries[0]).not.toContain('Owner');
    await page.unrouteAll();
  }
});

test('if the Owner-narrowed query fails, chats still load (filtered in the page) instead of going blank', async ({ page }) => {
  const queries = await open(page, 'vinaya@couplo.test', client, { failOwnerQuery: true });
  await expect(page.locator('#list .contact .name')).toHaveText(['Binu']);
  expect(queries[1]).not.toContain('Owner');
});
