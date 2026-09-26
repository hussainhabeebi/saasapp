// Leads list row actions (dashboard.html renderLeadsList/renderLeadsTable): Call is the first
// action, the Won/Spam outcome buttons live behind the "⋯" menu, and the Lead Ref (LD-00042) is
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

test('list row: Call comes first, Won/Spam sit behind the ⋯ menu', async ({ page }) => {
  await renderLeads(page);
  const actions = page.locator('#leadsList .li-actions').first();
  await expect(actions.locator(':scope > *').first()).toHaveClass(/call-btn-wrap/);
  await expect(page.getByRole('button', { name: 'Mark Won' })).toBeHidden();

  await actions.locator('.lead-more-btn').click();
  await expect(page.getByRole('button', { name: '✅ Mark Won' })).toBeVisible();
  await expect(page.getByRole('button', { name: '🚫 Mark Spam' })).toBeVisible();

  await page.getByRole('button', { name: '✅ Mark Won' }).click();
  expect(await page.evaluate(() => window.__won)).toBe(15787);
  await expect(page.locator('#lmd-15787')).toBeHidden();
});

test('table row: Call comes first, Won/Spam sit behind the ⋯ menu', async ({ page }) => {
  await renderLeads(page, { table: true });
  const actions = page.locator('#leadsTable .li-actions').first();
  await expect(actions.locator(':scope > *').first()).toHaveClass(/call-btn-wrap/);
  await expect(actions.getByText('✅ Won')).toHaveCount(0);
  await expect(actions.locator('.lead-more-btn')).toBeVisible();
});

test('Lead Ref shows on desktop, hidden on phones', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await renderLeads(page);
  await expect(page.locator('#leadsList .lead-ref-list').first()).toBeVisible();
  await expect(page.locator('#leadsList .lead-ref-list').first()).toHaveText(/LD-15787/);

  await page.setViewportSize({ width: 390, height: 800 });
  await expect(page.locator('#leadsList .lead-ref-list').first()).toBeHidden();
});
