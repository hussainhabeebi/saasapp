// Dashboard → 📑 Proposals (proposals.html): every proposal sent from Chats → AI Proposal, with
// status tabs, stats and a status sheet (accepted can also mark the lead Won). Hermetic file://.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pageUrl = 'file://' + path.resolve(__dirname, '../proposals.html') + '?client=48&token=t';
const daysFromNow = (d) => new Date(Date.now() + d * 864e5).toISOString();
const ROWS = [
  { id: 3, lead_id: 7, ref: 'PRP-2026-0003', title: 'Hot water for the family', total: 99120, currency: 'INR', items: [{ id: '1' }, { id: '4' }], customer: { name: 'Asha Nair', company: 'Nair Residence', phone: '9198' },
    has_pdf: true, sent_by: 'rahul@x.test', sent_at: daysFromNow(-1), valid_until: daysFromNow(2), stored_status: 'sent', status: 'sent', customer_replied_at: daysFromNow(-0.5) },
  { id: 2, lead_id: 8, ref: 'PRP-2026-0002', title: 'Office AMC', total: 30000, currency: 'INR', items: [{ id: '3' }], customer: { name: 'Bina' },
    has_pdf: true, sent_at: daysFromNow(-5), valid_until: daysFromNow(10), stored_status: 'accepted', status: 'accepted', status_at: daysFromNow(-2), status_note: 'Paid advance' },
  { id: 1, lead_id: 9, ref: 'PRP-2026-0001', title: 'Old quote', total: null, currency: 'INR', items: [], customer: { name: 'Chen' },
    has_pdf: false, pdf_url: '', sent_at: daysFromNow(-40), valid_until: daysFromNow(-25), stored_status: 'sent', status: 'expired' },
];

async function open(page) {
  const calls = { patch: [] };
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.protocol === 'file:') return route.continue();
    if (url.pathname.endsWith('/catalog/proposals') && req.method() === 'GET') return route.fulfill({ json: { proposals: ROWS } });
    if (url.pathname.endsWith('/catalog/proposals') && req.method() === 'PATCH') { calls.patch.push(req.postDataJSON()); return route.fulfill({ json: { ok: true, status: 'accepted', stage: 'won' } }); }
    return route.abort();
  });
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.prop')).toHaveCount(3);
  return calls;
}

test('lists proposals with stats, status pills, expiry and replies', async ({ page }) => {
  await open(page);
  await expect(page.locator('#stats')).toContainText('Proposals sent');
  await expect(page.locator('#stats')).toContainText('INR 99,120');
  await expect(page.locator('#stats')).toContainText('100%');
  const first = page.locator('.prop').first();
  await expect(first).toContainText('PRP-2026-0003');
  await expect(first).toContainText('Asha Nair · Nair Residence');
  await expect(first).toContainText('2 days left');
  await expect(first).toContainText('Customer replied');
  await expect(page.locator('.prop').nth(1)).toContainText('Paid advance');
  await expect(page.locator('.prop').nth(2).locator('.pill')).toContainText('Expired');
  await expect(page.locator('.prop').nth(2).getByRole('button', { name: '📄 PDF' })).toBeDisabled();
});

test('tabs and search filter the list', async ({ page }) => {
  await open(page);
  await page.getByRole('tab', { name: /Accepted/ }).click();
  await expect(page.locator('.prop')).toHaveCount(1);
  await expect(page.locator('.prop')).toContainText('Office AMC');
  await page.getByRole('tab', { name: /^All/ }).click();
  await page.locator('#q').fill('chen');
  await expect(page.locator('.prop')).toHaveCount(1);
});

test('mark a proposal accepted and the lead won', async ({ page }) => {
  const calls = await open(page);
  await page.locator('.prop').first().getByRole('button', { name: 'Update status' }).click();
  await expect(page.locator('#shWonRow')).toBeHidden();
  await page.locator('#shOpts label', { hasText: 'Accepted' }).click();
  await expect(page.locator('#shWonRow')).toBeVisible();
  await page.locator('#shNote').fill('Signed copy received');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('#toast')).toContainText('lead moved to Won');
  expect(calls.patch).toEqual([{ id: 3, status: 'accepted', note: 'Signed copy received', mark_won: true }]);
});
