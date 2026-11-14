// Lead ⋯ menu → "Personal chat / Staff — not a lead" (dashboard.html markLeadPersonal): the contact
// leaves every lead list and count, the bot is stopped (OptOut=Yes), and Leads → "Personal & staff"
// turns it back into a lead. Same hermetic setup as lead-actions.spec.js.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');

async function renderLeads(page) {
  await page.route('**/*', (route) => (route.request().url().startsWith('file://') ? route.continue() : route.abort()));
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    document.getElementById('pageLeads').classList.remove('hidden');
    // @ts-ignore
    window.__patches = [];
    // @ts-ignore
    window.ncPatch = async (_url, body) => { window.__patches.push(body); };
    // @ts-ignore
    window.renderHome = () => {};
    // @ts-ignore
    _leadsActiveView = 'all';
    // @ts-ignore
    allLeads = _splitPersonal([
      { Id: 1, Name: 'Sahilath', Phone: '919562999000', Stage: 'new', Tags: 'Hot', Date: new Date().toISOString() },
      { Id: 2, Name: 'Sona (staff)', Phone: '919800000002', Stage: 'new', Tags: 'Staff', OptOut: 'Yes', Date: new Date().toISOString() },
    ]);
    window.renderLeadsList();
  });
}

test('a contact already tagged Staff is not a lead: not in the list, counted under Personal & staff', async ({ page }) => {
  await renderLeads(page);
  await expect(page.locator('#leadsList .lead-item')).toHaveCount(1);
  await expect(page.locator('#leadsList .lead-item')).toContainText('Sahilath');
  await expect(page.locator('#personalBtn')).toHaveText('👤 Personal & staff (1)');
  expect(await page.evaluate(() => allLeads.map((l) => l.Id))).toEqual([1]);
});

test('⋯ → Personal chat: the lead leaves the list, the bot is stopped, Undo puts it back', async ({ page }) => {
  await renderLeads(page);
  await page.locator('#leadsList .lead-more-btn').first().click();
  await page.getByRole('menuitem', { name: '👤 Personal chat — not a lead' }).click();
  await expect(page.locator('#leadsList .lead-item')).toHaveCount(0);
  expect(await page.evaluate(() => window.__patches[0])).toEqual({ Id: 1, Tags: 'Hot, Personal', OptOut: 'Yes' });
  await expect(page.locator('#personalBtn')).toHaveText('👤 Personal & staff (2)');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('#leadsList .lead-item')).toHaveCount(1);
  expect(await page.evaluate(() => window.__patches.at(-1))).toEqual({ Id: 1, Tags: 'Hot', OptOut: null });
});

test('Personal & staff list: "Make a lead again" brings the contact back and lets the bot reply', async ({ page }) => {
  await renderLeads(page);
  await page.locator('#personalBtn').click();
  await expect(page.locator('#personalList')).toContainText('Sona (staff)');
  await page.locator('#personalList').getByRole('button', { name: 'Make a lead again' }).click();
  expect(await page.evaluate(() => window.__patches.at(-1))).toEqual({ Id: 2, Tags: '', OptOut: 'No' });
  await expect(page.locator('#personalBtn')).toBeHidden();
  await expect(page.locator('#leadsList .lead-item')).toHaveCount(2);
});

test('on a phone, the ⋯ menu of a lead near the bottom of the screen stays fully on screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await renderLeads(page);
  // Push the row down to the bottom of the screen.
  await page.evaluate(() => { document.getElementById('leadsList').style.paddingTop = '520px'; });
  const btn = page.locator('#leadsList .lead-more-btn').first();
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  const box = await page.locator('#lmd-1').boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(700);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.getByRole('menuitem', { name: '🧑‍💼 Staff — not a lead' }).click();
  expect(await page.evaluate(() => window.__patches[0])).toEqual({ Id: 1, Tags: 'Hot, Staff', OptOut: 'Yes' });
});
