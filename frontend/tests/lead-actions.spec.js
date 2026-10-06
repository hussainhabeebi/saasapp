// Leads list row actions (dashboard.html renderLeadsList/renderLeadsTable): Call is the first
// action, Spam is a single 🚫 icon (with Undo), Won lives behind the "⋯" menu, and the Lead Ref (LD-00042) is
// a small desktop-only lookup aid hidden on phones. Same hermetic file:// setup as
// qual-questions.spec.js — no backend, the page's own global render functions are driven directly.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');

async function renderLeads(page, { table = false } = {}) {
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('file://')) return route.continue();
    return route.abort();
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate((table) => {
    // The app shell stays hidden (behind the #gate login overlay) until login — reveal it and only the Leads page so layout (and
    // the phone breakpoint) is real.
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    document.getElementById('pageLeads').classList.remove('hidden');
    // @ts-ignore
    window.markLeadWon = async (id) => { window.__won = id; };
    // @ts-ignore
    allLeads = [{ Id: 15787, Name: 'ANOOP', Phone: '919876543265', Stage: 'new', Score: 'Cold', Date: new Date().toISOString() }];
    if (table) { window.setLeadsViewMode?.('list'); document.getElementById('leadsTable').style.display = 'block'; window.renderLeadsTable(); }
    else window.renderLeadsList();
  }, table);
}

test('list row: Call comes first, Spam is one icon, Won sits behind the ⋯ menu', async ({ page }) => {
  await renderLeads(page);
  const actions = page.locator('#leadsList .li-actions').first();
  await expect(actions.locator(':scope > *').first()).toHaveClass(/call-btn-wrap/);
  await expect(actions.locator('.lead-spam-btn')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark Won' })).toBeHidden();

  await actions.locator('.lead-more-btn').click();
  await expect(page.getByRole('button', { name: '✅ Mark Won' })).toBeVisible();

  await page.getByRole('button', { name: '✅ Mark Won' }).click();
  expect(await page.evaluate(() => window.__won)).toBe(15787);
  await expect(page.locator('#lmd-15787')).toBeHidden();
});

test('table row: Call comes first, Spam icon + ⋯ menu', async ({ page }) => {
  await renderLeads(page, { table: true });
  const actions = page.locator('#leadsTable .li-actions').first();
  await expect(actions.locator(':scope > *').first()).toHaveClass(/call-btn-wrap/);
  await expect(actions.getByText('✅ Won')).toHaveCount(0);
  await expect(actions.locator('.lead-more-btn')).toBeVisible();
  await expect(actions.locator('.lead-spam-btn')).toBeVisible();
});

test('Lead Ref shows on desktop, hidden on phones', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await renderLeads(page);
  await expect(page.locator('#leadsList .lead-ref-list').first()).toBeVisible();
  await expect(page.locator('#leadsList .lead-ref-list').first()).toHaveText(/LD-15787/);

  await page.setViewportSize({ width: 390, height: 800 });
  await expect(page.locator('#leadsList .lead-ref-list').first()).toBeHidden();
});

test('spam: one tap hides the lead, Undo brings it back', async ({ page }) => {
  await renderLeads(page);
  await page.evaluate(() => {
    // @ts-ignore
    window.__patches = [];
    // @ts-ignore
    window.claimLeadIfUnowned = async () => {};
    // @ts-ignore
    window.reportLeadQualityChange = () => {};
    // @ts-ignore
    window.ncPatch = async (_url, body) => { window.__patches.push(body); };
    // @ts-ignore
    _leadsActiveView = 'all';
    window.renderLeadsList();
  });
  await page.locator('#leadsList .lead-spam-btn').first().click();
  await expect(page.locator('#leadsList .lead-item')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('#leadsList .lead-item')).toHaveCount(1);
  const last = await page.evaluate(() => window.__patches.at(-1));
  expect(last).toMatchObject({ Id: 15787, Stage: 'new', OptOut: null, HandoverOutcome: null });
});

test('called leads move down: never-called first, then follow-up due, then oldest call first', async ({ page }) => {
  await renderLeads(page);
  const order = await page.evaluate(() => {
    const now = Date.now();
    const iso = (msAgo) => new Date(now - msAgo).toISOString();
    const log = (msAgo) => JSON.stringify([{ outcome: 'Answered', at: iso(msAgo) }]);
    // @ts-ignore
    allLeads = [
      { Id: 1, Name: 'JustCalled', Stage: 'new', Date: iso(0), CallLog: log(60000) },
      { Id: 2, Name: 'CalledYesterday', Stage: 'new', Date: iso(0), CallLog: log(86400000) },
      { Id: 3, Name: 'FreshOld', Stage: 'new', Date: iso(7200000) },
      { Id: 4, Name: 'FreshNew', Stage: 'new', Date: iso(0) },
      { Id: 5, Name: 'CallbackDue', Stage: 'new', Date: iso(0), CallLog: log(3 * 3600000), ReminderDate: iso(3600000).slice(0, 16) },
      { Id: 6, Name: 'CallbackOverdue', Stage: 'new', Date: iso(0), CallLog: log(9 * 3600000), ReminderDate: iso(5 * 3600000).slice(0, 16) },
      { Id: 7, Name: 'ClosedWon', Stage: 'won', Date: iso(0) },
    ];
    // @ts-ignore
    _leadsActiveView = 'all';
    window.renderLeadsList();
    return [...document.querySelectorAll('#leadsList .li-name')].map((e) => e.textContent.trim());
  });
  expect(order).toEqual(['FreshNew', 'FreshOld', 'CallbackOverdue', 'CallbackDue', 'CalledYesterday', 'JustCalled', 'ClosedWon']);
  await expect(page.locator('#leadsList')).toContainText('1st call done · 1m ago');
});

test('phone: row shows only Call, Spam and ⋯; snooze/follow-up/template live in ⋯; outcomes go below the row', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await renderLeads(page);
  const actions = page.locator('#leadsList .li-actions').first();
  await expect(actions.locator('.li-sec')).toHaveCount(3);
  for (const b of await actions.locator('.li-sec').all()) await expect(b).toBeHidden();
  await expect(actions.locator('.call-main')).toBeVisible();
  await expect(actions.locator('.lead-spam-btn')).toBeVisible();

  // the whole row fits — nothing clipped off the right edge
  const box = await actions.boundingBox();
  const more = await actions.locator('.lead-more-btn').boundingBox();
  expect(more.x + more.width).toBeLessThanOrEqual(box.x + box.width + 1);

  await actions.locator('.lead-more-btn').click();
  await expect(page.getByRole('button', { name: '⏰ Snooze reminder' })).toBeVisible();
  await expect(page.getByRole('button', { name: '📣 WhatsApp template' })).toBeVisible();
  await page.mouse.click(5, 5);

  await page.evaluate(() => window.showInlineOutcomeChips(15787));
  const chips = page.locator('#leadsList .outcome-chips');
  await expect(chips).toBeVisible();
  await expect(actions.locator('.outcome-chips')).toHaveCount(0); // not squeezed inside the action row
  const btnH = (await actions.locator('.call-main').boundingBox()).height;
  expect(btnH).toBeLessThan(50); // buttons keep their normal height
});

test('desktop: ⋯ menu does not repeat the row buttons', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await renderLeads(page);
  const actions = page.locator('#leadsList .li-actions').first();
  await expect(actions.locator('.li-sec').first()).toBeVisible();
  await actions.locator('.lead-more-btn').click();
  await expect(page.getByRole('button', { name: '⏰ Snooze reminder' })).toBeHidden();
});
