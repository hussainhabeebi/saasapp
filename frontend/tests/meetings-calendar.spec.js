// meetings-calendar.html (Dashboard → 📅 Meetings): month view with each day's meetings, day view
// with an hour timeline and agenda (Join, Open chat). Hermetic: /meetings/calendar stubbed.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const at = (date, h, m = 0) => new Date(`${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`).toISOString();
const DAY = '2026-11-16';
const MEETINGS = [
  { id: 1, lead_id: 7, lead_name: 'Asha Nair', title: 'Product demo', status: 'scheduled', start_at: at(DAY, 11), end_at: at(DAY, 11, 45), mode: 'video', join_url: 'https://meet.google.com/abc-defg-hij', owner: 'rita@biz.com', source: 'chat', note: 'Asked about bulk pricing' },
  { id: 2, lead_id: 8, lead_name: 'Ravi', title: 'Intro call', status: 'scheduled', start_at: at(DAY, 11, 30), end_at: at(DAY, 12), mode: 'phone', join_url: '', source: 'calcom' },
  { id: 3, lead_id: 9, lead_name: 'Meera', title: 'Site visit', status: 'cancelled', start_at: at(DAY, 15), end_at: at(DAY, 16), mode: 'in_person', location: 'MG Road office' },
  { id: 4, lead_id: 10, lead_name: 'Old', title: 'Demo', status: 'completed', outcome: 'interested', start_at: at('2026-11-03', 10), end_at: at('2026-11-03', 10, 30), mode: 'video' },
  ...[1, 2, 3].map((i) => ({ id: 10 + i, lead_id: 20 + i, lead_name: `Busy ${i}`, title: 'Call', status: 'scheduled', start_at: at('2026-11-20', 9 + i), end_at: at('2026-11-20', 9 + i, 30), mode: 'phone' })),
  { id: 14, lead_id: 24, lead_name: 'Busy 4', title: 'Call', status: 'scheduled', start_at: at('2026-11-20', 14), end_at: at('2026-11-20', 14, 30), mode: 'phone' },
];

async function open(page, query = `date=${DAY}`) {
  const calls = [];
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'file:') return route.continue();
    if (url.pathname.endsWith('/meetings/notes')) { const b = route.request().postDataJSON(); calls.push({ notes: b }); return route.fulfill({ json: { ok: true, note: b.note } }); }
    if (url.pathname.endsWith('/meetings/calendar')) {
      calls.push({ from: url.searchParams.get('from'), to: url.searchParams.get('to'), auth: route.request().headers().authorization });
      const f = Date.parse(url.searchParams.get('from')), t = Date.parse(url.searchParams.get('to'));
      return route.fulfill({ json: { meetings: MEETINGS.filter((m) => Date.parse(m.start_at) >= f && Date.parse(m.start_at) < t) } });
    }
    return route.abort();
  });
  await page.goto('file://' + path.resolve(__dirname, '../meetings-calendar.html') + `?token=tok&embed=1&${query}`, { waitUntil: 'domcontentloaded' });
  return calls;
}

test('month view: each day shows its meetings, busy days say "+n more"', async ({ page }) => {
  const calls = await open(page);
  await expect(page.locator('#title')).toHaveText(/November 2026/);
  expect(calls[0].auth).toBe('Bearer tok');
  // Monday-first 6-week grid covering November 2026: 26 Oct → 7 Dec.
  expect(new Date(calls[0].from).getDate()).toBe(26);
  const day = page.locator(`.day[data-date="${DAY}"]`);
  await expect(day.locator('.chip')).toHaveCount(3);
  await expect(day.locator('.chip.cancelled')).toContainText('Meera');
  await expect(page.locator('.day[data-date="2026-11-20"] .chip')).toHaveCount(3);
  await expect(page.locator('.day[data-date="2026-11-20"] .more')).toHaveText('+1 more');
  await expect(page.locator('#summary')).toContainText('8 meetings this month');
});

test('day view: timeline blocks side by side when they overlap, agenda with Join and Open chat', async ({ page }) => {
  await open(page);
  await page.locator(`.day[data-date="${DAY}"]`).click();
  await expect(page.locator('#title')).toHaveText(/Monday, 16 November 2026|Monday, November 16, 2026/);
  await expect(page.locator('.block')).toHaveCount(3);
  // Asha (11:00-11:45) and Ravi (11:30-12:00) overlap → two lanes.
  const a = await page.locator('.block', { hasText: 'Asha Nair' }).boundingBox();
  const r = await page.locator('.block', { hasText: 'Ravi' }).boundingBox();
  expect(Math.abs(a.width - r.width)).toBeLessThan(2);
  expect(r.x).toBeGreaterThan(a.x + a.width - 6);
  const agenda = page.locator('.agenda');
  await expect(agenda.locator('.item')).toHaveCount(3);
  const asha = agenda.locator('.item', { hasText: 'Product demo' });
  await expect(asha.getByRole('link', { name: 'Join ↗' })).toHaveAttribute('href', 'https://meet.google.com/abc-defg-hij');
  await expect(asha).toContainText('from Chats');
  await expect(agenda.locator('.item', { hasText: 'Site visit' })).toContainText('Cancelled');
  await expect(agenda.locator('.item', { hasText: 'Site visit' }).getByRole('link', { name: 'Join ↗' })).toHaveCount(0);
  // Open chat inside the dashboard calls the parent's openLeadChat; standalone opens Chats.
  await page.evaluate(() => { window.opened = []; window.open = (u) => window.opened.push(u); });
  await asha.getByRole('button', { name: /Open chat/ }).click();
  expect(await page.evaluate(() => window.opened)).toEqual(['chats.html?lead=7']);
  // Clicking a block highlights its agenda entry.
  await page.locator('.block', { hasText: 'Ravi' }).click();
  await expect(agenda.locator('.item.sel')).toContainText('Intro call');
});

test('navigation: next/previous day and month, Today, back to month', async ({ page }) => {
  const calls = await open(page, `date=${DAY}&view=day`);
  await expect(page.locator('.block')).toHaveCount(3);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('.agenda')).toContainText('No meetings on this day.');
  expect(calls).toHaveLength(1); // the same month grid is reused
  await page.getByRole('tab', { name: 'Month' }).click();
  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(page.locator('#title')).toHaveText(/October 2026/);
  expect(calls).toHaveLength(2);
});

test('a failed load says why', async ({ page }) => {
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'file:') return route.continue();
    return route.fulfill({ status: 401, json: { error: 'Invalid or expired session' } });
  });
  await page.goto('file://' + path.resolve(__dirname, '../meetings-calendar.html') + '?token=bad&embed=1');
  await expect(page.locator('#cal')).toContainText('Invalid or expired session');
});

test('pre-meeting notes: shown on the agenda, added and edited in place', async ({ page }) => {
  const calls = await open(page, `date=${DAY}&view=day`);
  const agenda = page.locator('.agenda');
  const asha = agenda.locator('.item', { hasText: 'Product demo' });
  await expect(asha.locator('.note')).toHaveText('📝 Asked about bulk pricing');
  await expect(page.locator('.block', { hasText: 'Asha Nair' })).toContainText('📝');
  const ravi = agenda.locator('.item', { hasText: 'Intro call' });
  await ravi.getByRole('button', { name: /Add pre-meeting notes/ }).click();
  await page.locator('#noteText').fill('Decision maker joins; send the deck first');
  await page.getByRole('button', { name: 'Save notes' }).click();
  await expect(ravi.locator('.note')).toHaveText('📝 Decision maker joins; send the deck first');
  expect(calls.find((c) => c.notes).notes).toEqual({ id: 2, note: 'Decision maker joins; send the deck first' });
  await asha.getByRole('button', { name: /Edit notes/ }).click();
  await expect(page.locator('#noteText')).toHaveValue('Asked about bulk pricing');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(asha.locator('.note')).toHaveText('📝 Asked about bulk pricing');
});
