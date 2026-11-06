// Leads toolbar: "call status" (No answer / Callback / Answered / Never called) and Country filters,
// the removable active-filter pills, and the phone layout (filters folded behind ⚙ Filters, table
// rows rendered as labelled cards). Same hermetic file:// setup as lead-origin.spec.js.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');

const call = (outcome) => ({ outcome, date: '1/1/2026', at: '2026-01-01T10:00:00Z' });
const LEADS = [
  { Id: 1, Name: 'Asha', Phone: '919876543210', CallLog: JSON.stringify([call('No Answer'), call('No Answer'), call('No Answer')]) },
  { Id: 2, Name: 'Binu', Phone: '971501234567', CallLog: JSON.stringify([call('No Answer')]) },
  { Id: 3, Name: 'Chitra', Phone: '919876543211', CallLog: JSON.stringify([call('Answered'), call('No Answer')]) },
  { Id: 4, Name: 'Devi', Phone: '447700900123', Tags: 'No Answer' },
  { Id: 5, Name: 'Esha', Phone: '5551234', Country: 'Qatar', CallLog: JSON.stringify([call('Callback Requested')]) },
  { Id: 6, Name: 'Faris', Phone: '' },
];

async function render(page, mode) {
  await page.route('**/*', (route) => (route.request().url().startsWith('file://') ? route.continue() : route.abort()));
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(([leads, mode]) => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    document.getElementById('pageLeads').classList.remove('hidden');
    const now = new Date().toISOString();
    // @ts-ignore
    allLeads = leads.map((l) => ({ Stage: 'new', Score: 'Cold', ...l, Date: now }));
    // @ts-ignore
    _leadsActiveView = 'all';
    if (mode === 'table') { window.setLeadsViewMode?.('list'); document.getElementById('leadsTable').style.display = 'block'; window.renderLeadsTable(); }
    else window.renderLeadsList();
  }, [LEADS, mode]);
}
const names = (page) => page.locator('#leadsList .li-name').allInnerTexts().then((t) => t.map((s) => s.trim().split(/\s/)[0]).sort());

test('call status filter: no answer, 3+ no answers, callback, answered, never called', async ({ page }) => {
  await render(page, 'list');
  const pick = async (v) => { await page.selectOption('#leadCallFilter', v); return names(page); };
  expect(await pick('no_answer')).toEqual(['Asha', 'Binu', 'Devi']);
  expect(await pick('no_answer_3')).toEqual(['Asha']);
  expect(await pick('callback')).toEqual(['Esha']);
  expect(await pick('answered')).toEqual(['Chitra']);
  expect(await pick('never')).toEqual(['Faris']);
});

test('country filter: Country field, else phone code, plus Unknown', async ({ page }) => {
  await render(page, 'list');
  const opts = await page.locator('#leadCountryFilter option').allInnerTexts();
  expect(opts[1]).toBe('India (2)');
  expect(opts).toContain('Qatar (1)');
  expect(opts).toContain('United Kingdom (1)');
  await page.selectOption('#leadCountryFilter', 'India');
  expect(await names(page)).toEqual(['Asha', 'Chitra']);
  await page.selectOption('#leadCountryFilter', 'Qatar');
  expect(await names(page)).toEqual(['Esha']);
  await page.selectOption('#leadCountryFilter', '__none');
  expect(await names(page)).toEqual(['Faris']);
});

test('active filters show as pills that clear the filter', async ({ page }) => {
  await render(page, 'list');
  await page.selectOption('#leadCallFilter', 'no_answer');
  await page.selectOption('#leadCountryFilter', 'India');
  const pills = page.locator('#leadsActiveFilters .lf-pill');
  await expect(pills).toHaveCount(2);
  await expect(pills.nth(1)).toHaveText(/India/);
  await expect(pills.nth(1)).not.toHaveText(/\(\d+\)/);
  expect(await names(page)).toEqual(['Asha']);
  await pills.nth(0).locator('button').click();
  await expect(page.locator('#leadCallFilter')).toHaveValue('');
  expect(await names(page)).toEqual(['Asha', 'Chitra']);
  await page.locator('#leadsActiveFilters .lf-clear').count().then((n) => expect(n).toBe(0));
});

test('phone: secondary filters fold behind the Filters button; table rows become labelled cards', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await render(page, 'table');
  await expect(page.locator('#leadCallFilter')).toBeHidden();
  await page.click('#leadsFiltersBtn');
  await expect(page.locator('#leadCallFilter')).toBeVisible();
  await page.selectOption('#leadCountryFilter', 'India');
  await expect(page.locator('#leadsFiltersBtn .lf-count')).toHaveText('1');
  await expect(page.locator('#leadsTable thead')).toBeHidden();
  const row = page.locator('#leadsTable tbody tr', { hasText: 'Asha' });
  await expect(row.locator('td', { hasText: 'India' }).last()).toHaveAttribute('data-label', 'Country');
  expect(await row.evaluate((el) => getComputedStyle(el).display)).toBe('grid');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
