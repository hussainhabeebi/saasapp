// Leads → 📍 Destination filter (travel agencies): the customer's preferred destination from the
// Destination field, else Destination Staff Routing, else the bot's answers; "Goa" shows only Goa
// enquiries, a destination chip filters too, and select-all → Assign to… works on the filtered list.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');

const LEADS = [
  { Id: 1, Name: 'Asha', Phone: '919800000001', Destination: 'Goa' },
  { Id: 2, Name: 'Binu', Phone: '919800000002', Destination: 'goa, India' },
  { Id: 3, Name: 'Chitra', Phone: '919800000003', DsrDestination: 'Munnar' },
  { Id: 4, Name: 'Devi', Phone: '919800000004', DsrDestination: 'Kochi → Dubai' },
  { Id: 5, Name: 'Esha', Phone: '919800000005', QualAnswers: JSON.stringify({ destination: 'Goa' }) },
  { Id: 6, Name: 'Faris', Phone: '919800000006' },
];

async function render(page, client) {
  await page.route('**/*', (route) => (route.request().url().startsWith('file://') ? route.continue() : route.abort()));
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(([leads, client]) => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    document.getElementById('pageLeads').classList.remove('hidden');
    // @ts-ignore
    clientRecord = { ...(window.clientRecord || {}), ...client };
    const now = new Date().toISOString();
    // @ts-ignore
    allLeads = leads.map((l) => ({ Stage: 'new', Score: 'Cold', ...l, Date: now }));
    // @ts-ignore
    _leadsActiveView = 'all';
    window.renderLeadsList();
  }, [LEADS, client]);
}
const names = (page) => page.locator('#leadsList .li-name').allInnerTexts().then((t) => t.map((s) => s.trim().split(/\s/)[0]).sort());

test('travel agency: filter by destination, grouped case-insensitively, with counts', async ({ page }) => {
  await render(page, { industry: 'travel' });
  await expect(page.locator('#leadDestFilter')).toBeVisible();
  const opts = await page.locator('#leadDestFilter option').allInnerTexts();
  expect(opts).toEqual(['All destinations', 'Goa (3)', 'Dubai (1)', 'Munnar (1)', 'No destination (1)']);
  await page.selectOption('#leadDestFilter', 'goa');
  expect(await names(page)).toEqual(['Asha', 'Binu', 'Esha']);
  await expect(page.locator('#leadsActiveFilters .lf-pill')).toHaveText(/📍 Goa/);
  await page.selectOption('#leadDestFilter', 'dubai');
  expect(await names(page)).toEqual(['Devi']);
  await page.selectOption('#leadDestFilter', '__none');
  expect(await names(page)).toEqual(['Faris']);
  // A destination chip on a lead card filters to that destination.
  await page.selectOption('#leadDestFilter', '');
  await page.locator('#leadsList .tag', { hasText: '🌍 Munnar' }).first().click();
  await expect(page.locator('#leadDestFilter')).toHaveValue('munnar');
  expect(await names(page)).toEqual(['Chitra']);
});

test('not a travel agency: no destination filter', async ({ page }) => {
  await render(page, { industry: 'retail' });
  await expect(page.locator('#leadDestFilter')).toBeHidden();
  await expect(page.locator('#leadsList .tag', { hasText: '🌍' })).toHaveCount(0);
});

test('Agency module on (any industry) gets the filter too', async ({ page }) => {
  await render(page, { industry: 'hospitality', ta_enabled: 'Yes' });
  await expect(page.locator('#leadDestFilter')).toBeVisible();
});
