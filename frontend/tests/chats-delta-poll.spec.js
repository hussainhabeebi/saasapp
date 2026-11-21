// Standalone Chats (chats.html): the 12s background poll asks NocoDB only for leads whose
// LastMsgAt moved (delta) and merges them into the list, instead of re-downloading every lead with
// its full ConvHistory. Every 5th tick is still a full reload. Same hermetic file:// setup as the
// other specs; the page clock is faked so the poll runs without waiting.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chatsUrl = 'file://' + path.resolve(__dirname, '../chats.html') + '?client=48&token=t';

const hist = JSON.stringify([{ role: 'user', content: 'hi' }]);
const lead = (Id, Name, LastMsgAt) => ({ Id, ClientId: '48', Name, LastMsgAt, ConvHistory: hist });

async function open(page, { failDelta = false } = {}) {
  const queries = [];
  const state = { full: [lead(1, 'Asha', '2026-09-30T10:00:00.000Z'), lead(2, 'Binu', '2026-09-30T09:00:00.000Z')], delta: [] };
  await page.clock.install();
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'file:') return route.continue();
    if (url.pathname.endsWith('/session/me')) return route.fulfill({ json: { email: 'owner@x.test', client: { authentik_email: 'owner@x.test' } } });
    if (/\/nocodb\/api\/v2\/tables\/[^/]+\/records$/.test(url.pathname)) {
      const where = url.searchParams.get('where') || '';
      queries.push(where);
      if (where.includes('LastMsgAt')) {
        if (failDelta) return route.fulfill({ status: 422, json: { msg: 'bad filter' } });
        return route.fulfill({ json: { list: state.delta } });
      }
      return route.fulfill({ json: { list: state.full } });
    }
    return route.abort();
  });
  await page.goto(chatsUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#app')).toBeVisible();
  return { queries, state };
}

test('the poll fetches only leads newer than the newest one held, and merges them in', async ({ page }) => {
  const { queries, state } = await open(page);
  await expect(page.locator('#list .contact .name')).toHaveText(['Asha', 'Binu']);
  expect(queries[0]).not.toContain('LastMsgAt');

  state.delta = [lead(2, 'Binu', '2026-09-30T11:00:00.000Z'), lead(3, 'Chitra', '2026-09-30T10:30:00.000Z')];
  await page.clock.runFor(12000);
  await expect(page.locator('#list .contact .name')).toHaveText(['Binu', 'Chitra', 'Asha']);
  expect(queries[1]).toContain('(LastMsgAt,gte,2026-09-30T10:00:00.000Z)');

  await page.clock.runFor(12000);
  await expect.poll(() => queries.length).toBe(3);
  expect(queries[2]).toContain('(LastMsgAt,gte,2026-09-30T11:00:00.000Z)');
});

test('every 5th tick is a full reload', async ({ page }) => {
  const { queries } = await open(page);
  for (let i = 0; i < 5; i++) {
    await page.clock.runFor(12000);
    await expect.poll(() => queries.length).toBe(i + 2);
  }
  expect(queries.slice(1, 5).every(q => q.includes('LastMsgAt'))).toBe(true);
  expect(queries[5]).not.toContain('LastMsgAt');
});

test('if the delta query fails, the poll falls back to a full reload', async ({ page }) => {
  const { queries, state } = await open(page, { failDelta: true });
  state.full = [...state.full, lead(3, 'Chitra', '2026-09-30T08:00:00.000Z')];
  await page.clock.runFor(12000);
  await expect(page.locator('#list .contact .name')).toHaveText(['Asha', 'Binu', 'Chitra']);
  expect(queries[1]).toContain('LastMsgAt');
  expect(queries[2]).not.toContain('LastMsgAt');
});
