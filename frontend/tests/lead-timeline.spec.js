// Lead detail → 🕒 Timeline on a phone: one oldest-first list of what happened to the lead —
// arrived, first reply, assignment, each call (first call with its speed-to-lead), follow-ups sent,
// meetings, notes — ending with the lead's current stage.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
test.use({ viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true });

const T = (h) => new Date(Date.UTC(2026, 9, 20, 9) + h * 3600e3).toISOString();

test('lead timeline lists the journey in order and ends with the current stage', async ({ page }) => {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'file:') return route.continue();
    if (url.pathname.endsWith('/followups/v3/lead')) return route.fulfill({ json: { enabled: true, status: 'scheduled',
      history: [{ step: 1, label: 'Follow-up 1', sent_at: T(30), replied_at: T(31) }] } });
    if (url.pathname.endsWith('/meetings/lead')) return route.fulfill({ json: { meetings: [
      { title: 'Demo', status: 'scheduled', start_at: T(72), created_at: T(40), scheduled_by: 'rep@x.com' }] } });
    return route.fulfill({ json: { list: [] } });
  });
  await page.goto('file://' + path.resolve(__dirname, '../dashboard.html'), { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ T0, T1, T2, T3, T5, T24 }) => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    // @ts-ignore
    myEmail = 'boss@x.com';
    // @ts-ignore
    clientRecord = { authentik_email: 'boss@x.com', team_emails: 'rep@x.com', team_names: JSON.stringify({ 'rep@x.com': 'Rita' }) };
    // @ts-ignore
    allLeads = [{ Id: 7, Name: 'kkante mmu', Phone: '919000000000', Stage: 'interested', Date: T0, CreatedVia: 'chatwoot',
      ConvHistory: JSON.stringify([
        { role: 'user', content: 'Hi, price for gift box?', ts: T0 },
        { role: 'assistant', content: 'Hello!', ts: T0.replace(':00:00', ':01:00') },
        { role: 'system', content: 'Assigned to rep@x.com — first activity: Call log', ts: T2 },
      ]),
      CallLog: JSON.stringify([
        { outcome: 'Answered', duration: 5, notes: 'for gift purpose', at: T24, by: 'rep@x.com' },
        { outcome: 'No Answer', at: T2, by: 'rep@x.com' },
      ]),
      NotesList: JSON.stringify([{ text: 'Wants delivery Friday', ts: T5, author: 'rep@x.com' }]),
    }];
    window.openDetail(7);
  }, { T0: T(0), T1: T(1), T2: T(2), T3: T(3), T5: T(5), T24: T(24) });

  await page.locator('#detailTimelineBtn').tap();
  const items = page.locator('#ltlList .bp-timeline > li');
  await expect(page.locator('#ltlList')).not.toContainText('Loading follow-ups');
  const titles = await items.evaluateAll((els) => els.map((e) => e.querySelector('div').textContent.trim()));
  expect(titles).toEqual([
    '📥 Lead arrived',
    '💬 First message from customer',
    '🤖 First reply sent',
    '👤 Assigned to Rita',
    '📞 First call — No Answer',
    '📝 Note by Rita',
    '📞 2nd call — Answered',
    '📤 Follow-up 1 sent',
    expect.stringMatching(/^📅 Demo for /),
    '📍 Now: Interested',
  ]);
  await expect(items.nth(2)).toContainText('1 min after arrival');
  await expect(items.nth(4)).toContainText('2h after arrival');
  await expect(items.nth(6)).toContainText('5 min · by Rita · for gift purpose');
  await expect(items.nth(7)).toContainText('Customer replied');
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  // fits the phone: no sideways scroll
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
