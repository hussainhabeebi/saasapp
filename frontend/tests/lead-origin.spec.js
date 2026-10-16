// Lead origin colour + badge (dashboard.html leadOriginBadge/leadOriginClass): Instagram leads
// (Channel=instagram / Phone "ig:<id>") and manually added ones (CreatedVia manual/import) are
// marked in the list, table and kanban; WhatsApp leads keep the default look. Same hermetic
// file:// setup as lead-actions.spec.js.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');

const LEADS = [
  { Id: 1, Name: 'Asha', Phone: 'ig:1784001', Channel: 'instagram', Stage: 'new', Score: 'Cold' },
  { Id: 2, Name: 'Binu', Phone: '919876543210', CreatedVia: 'manual', Stage: 'new', Score: 'Cold' },
  { Id: 3, Name: 'Chitra', Phone: '919876543211', CreatedVia: 'import', Stage: 'new', Score: 'Cold' },
  { Id: 4, Name: 'Devi', Phone: '919876543212', Channel: 'whatsapp', Stage: 'new', Score: 'Cold' },
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
    allLeads = leads.map((l) => ({ ...l, Date: now }));
    if (mode === 'table') { window.setLeadsViewMode?.('list'); document.getElementById('leadsTable').style.display = 'block'; window.renderLeadsTable(); }
    else window.renderLeadsList();
  }, [LEADS, mode]);
}

test('list: Instagram and manual leads get their own badge and colour, WhatsApp stays plain', async ({ page }) => {
  await render(page, 'list');
  const row = (name) => page.locator('#leadsList .lead-item', { hasText: name });
  await expect(row('Asha')).toHaveClass(/origin-ig/);
  await expect(row('Asha').locator('.origin-badge')).toHaveText('📷 Instagram');
  await expect(row('Binu')).toHaveClass(/origin-manual/);
  await expect(row('Binu').locator('.origin-badge')).toHaveText('✍️ Manual');
  await expect(row('Chitra').locator('.origin-badge')).toHaveText('✍️ Imported');
  await expect(row('Devi').locator('.origin-badge')).toHaveCount(0);
  await expect(row('Devi')).not.toHaveClass(/origin-/);
  const igEdge = await row('Asha').evaluate((el) => getComputedStyle(el).boxShadow);
  const manualEdge = await row('Binu').evaluate((el) => getComputedStyle(el).boxShadow);
  expect(igEdge).not.toBe(manualEdge);
});

test('table: the same badges and row colour', async ({ page }) => {
  await render(page, 'table');
  await expect(page.locator('#leadsTable tr', { hasText: 'Asha' })).toHaveClass(/origin-ig/);
  await expect(page.locator('#leadsTable tr', { hasText: 'Binu' }).locator('.origin-badge')).toHaveText('✍️ Manual');
  await expect(page.locator('#leadsTable tr', { hasText: 'Devi' }).locator('.origin-badge')).toHaveCount(0);
});

test('kanban card carries the origin badge', async ({ page }) => {
  await render(page, 'list');
  const html = await page.evaluate(() => [window.kbCard(allLeads[0]), window.kbCard(allLeads[1]), window.kbCard(allLeads[3])]);
  expect(html[0]).toContain('origin-ig');
  expect(html[1]).toContain('✍️ Manual');
  expect(html[2]).not.toContain('origin-badge');
});

test('a CreatedVia value NocoDB dropped right after the column was created is written again', async ({ page }) => {
  const patches = [];
  let stored = '';
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url.includes('/api/v2/meta/tables/')) return route.fulfill({ json: { columns: [{ title: 'Name' }, { title: 'CreatedVia' }] } });
    if (/\/records\/9\?/.test(url)) return route.fulfill({ json: { Id: 9, CreatedVia: stored || null } });
    if (url.includes('/records') && req.method() === 'PATCH') { const b = JSON.parse(req.postData()); patches.push(b); stored = b[0].CreatedVia; return route.fulfill({ json: [{ Id: 9 }] }); }
    return route.abort();
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => window.ensureLeadCreatedVia([9], 'manual'));
  expect(patches).toEqual([[{ Id: 9, CreatedVia: 'manual' }]]);
  // Already saved: nothing is written.
  await page.evaluate(() => window.ensureLeadCreatedVia([9], 'manual'));
  expect(patches.length).toBe(1);
});
