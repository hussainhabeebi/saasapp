// 📌 Status Board → 📍 destination chips (travel-status.js tsDestChipsHTML) and Edit Lead → a
// changed Destination is saved (dashboard.html saveLeadNow makes the column first). Same hermetic
// file:// setup as travel-status.spec.js.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';
const OWNER = 'boss@example.com';

async function boot(page) {
  const patches = [], fieldsAdded = [];
  await page.route('**/*', async (route) => {
    const req = route.request(), url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url.startsWith(WORKER + '/nocodb/api/v2/meta/tables/')) {
      if (req.method() === 'POST') { fieldsAdded.push(JSON.parse(req.postData()).title); return route.fulfill({ json: {} }); }
      return route.fulfill({ json: { columns: [{ title: 'Name' }] } });
    }
    if (url.startsWith(WORKER + '/nocodb/api/v2/tables/') && req.method() === 'PATCH') { patches.push(JSON.parse(req.postData())); return route.fulfill({ json: { Id: 1 } }); }
    if (url.startsWith(WORKER + '/nocodb/api/v2/tables/')) return route.fulfill({ json: { list: [], pageInfo: { isLastPage: true } } });
    return route.abort();
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ OWNER }) => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    const now = new Date().toISOString();
    // @ts-ignore
    clientId = 7; myEmail = OWNER; sessionToken = 't';
    // @ts-ignore
    clientRecord = { industry: 'travel', ta_enabled: 'No', authentik_email: OWNER, team_emails: '', team_names: '{}' };
    // @ts-ignore
    allLeads = [
      { Id: 1, Name: 'Asha', Phone: '911', Date: now, Stage: 'new', Destination: 'Goa' },
      { Id: 2, Name: 'Binu', Phone: '912', Date: now, Stage: 'new', Destination: 'goa, India' },
      { Id: 3, Name: 'Chitra', Phone: '913', Date: now, Stage: 'new', DsrDestination: 'Bali' },
      { Id: 4, Name: 'Devi', Phone: '914', Date: now, Stage: 'new', TravelStatus: 'quote_sent', Destination: 'Dubai' },
      { Id: 5, Name: 'Esha', Phone: '915', Date: now, Stage: 'new' },
    ];
    // @ts-ignore
    applyTheme('travel');
    // @ts-ignore
    navigate('tvstatus');
  }, { OWNER });
  return { patches, fieldsAdded };
}
const rows = (page) => page.locator('#tsBody .tsb-row');
const destChip = (page, key) => page.locator(`#tsBody .tsb-dests .tsb-chip[data-dest="${key}"]`);

test('a chip per destination with its count, most inquiries first; tapping one filters the board', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#tsBody .tsb-dests .tsb-chip .l')).toHaveText(['All destinations', 'Goa', 'Bali', 'Dubai', 'No destination']);
  await expect(destChip(page, 'goa').locator('.n')).toHaveText('2');
  await expect(destChip(page, '').locator('.n')).toHaveText('5');
  await destChip(page, 'goa').click();
  await expect(rows(page)).toHaveCount(2);
  await expect(destChip(page, 'goa')).toHaveAttribute('aria-pressed', 'true');
  // Works together with the status chips: Goa + Quote sent = nobody; Dubai + Quote sent = Devi.
  await page.locator('#tsBody .tsb-chip[data-status="quote_sent"]').click();
  await expect(rows(page)).toHaveCount(0);
  await destChip(page, 'dubai').click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText('Devi');
  // Tapping the chosen destination again shows every destination.
  await destChip(page, 'dubai').click();
  await page.locator('#tsBody .tsb-chip[data-status="quote_sent"]').click();
  await expect(rows(page)).toHaveCount(5);
  await destChip(page, '__none').click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText('Esha');
  await page.locator('#tsBody .tsb-clear').first().click();
  await expect(rows(page)).toHaveCount(5);
});

test('a routed destination shows on the row; no chips outside travel accounts', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#tsBody .tsb-row[data-lead="3"]')).toContainText('Bali');
  // @ts-ignore
  await page.evaluate(() => { clientRecord = { ...clientRecord, industry: 'real_estate' }; renderTravelStatus(); });
  await expect(page.locator('#tsBody .tsb-dests')).toHaveCount(0);
});

test('Edit Lead: a changed Destination is sent, after making sure the column exists', async ({ page }) => {
  const { patches, fieldsAdded } = await boot(page);
  // @ts-ignore
  await page.evaluate(() => { openEditLead(allLeads.find((l) => l.Id === 1)); document.getElementById('fDestination').value = 'Bali'; return saveLeadNow(); });
  expect(fieldsAdded).toContain('Destination');
  expect(patches.at(-1)).toMatchObject({ Id: 1, Destination: 'Bali', Name: 'Asha' });
});
