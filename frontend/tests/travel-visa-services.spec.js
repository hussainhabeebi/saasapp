// Visa packages carry a "Services Included" list (transportation, hotel stay, meals, border fees
// …) entered on the form or imported from the agency's Google Sheet as CSV, and the Agency module
// paints its last loaded copy at once while the fresh one loads.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';
const PAGE = 'file://' + path.resolve(__dirname, '../travel-agency.html') + '?client=7&token=t&embed=1&shell=travel&tab=visas';
const ids = { packages: 'tp', bookings: 'tb', cases: 'tc', itineraries: 'ti', umrah_groups: 'tu', visas: 'tv' };

function mock(page, { visas = [], visaDelay = 0, posts = [], patches = [], fetches = [] } = {}) {
  return page.route('**/*', async (route) => {
    const req = route.request(), url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (!url.startsWith(WORKER)) return route.abort();
    const u = new URL(url);
    if (u.pathname.endsWith('/records/7')) return route.fulfill({ json: { Id: 7, ta_enabled: 'Yes', ta_table_ids: JSON.stringify(ids) } });
    if (u.pathname.endsWith('/meta/tables/tv')) return route.fulfill({ json: { columns: ['visa_country', 'services_included', 'not_included', 'notes'].map(title => ({ title })) } });
    if (u.pathname.includes('/meta/')) return route.fulfill({ status: 404, json: { msg: 'Not found' } });
    if (u.pathname.endsWith('/tables/tv/records')) {
      if (req.method() === 'POST') { posts.push(req.postDataJSON()); return route.fulfill({ json: { Id: 50 + posts.length } }); }
      if (req.method() === 'PATCH') { patches.push(req.postDataJSON()); return route.fulfill({ json: {} }); }
      fetches.push(url);
      if (visaDelay) await new Promise(r => setTimeout(r, visaDelay));
      return route.fulfill({ json: { list: visas } });
    }
    return route.fulfill({ json: { list: [] } });
  });
}

test('visa form saves Services Included, validity and exclusions', async ({ page }) => {
  const posts = [];
  await mock(page, { posts });
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#agencyContent')).toContainText('Visa Catalogue');
  // @ts-ignore
  await page.evaluate(() => openVisaModal());
  await page.fill('#visaCountry', 'Oman');
  await page.fill('#visaSvcDetail_transport', 'Dubai ⇄ Oman border, AC bus');
  await expect(page.locator('#visaSvc_transport')).toBeChecked();
  await page.fill('#visaSvcDetail_hotel', '1 night 3★');
  await page.check('#visaSvc_border_fees');
  await page.fill('#visaValidity', '30 days from entry');
  await page.fill('#visaOtherServices', 'Sightseeing: Khasab city tour');
  await page.fill('#visaNotIncluded', 'Flight tickets');
  await page.click('#saveVisaBtn');
  await expect(page.locator('#saveVisaMsg')).toHaveText('✓ Saved');
  expect(JSON.parse(posts[0].services_included)).toEqual([
    { item: 'Transportation', detail: 'Dubai ⇄ Oman border, AC bus' }, { item: 'Hotel Stay', detail: '1 night 3★' },
    { item: 'Border Fees', detail: '' }, { item: 'Sightseeing', detail: 'Khasab city tour' }]);
  expect(posts[0]).toMatchObject({ visa_country: 'Oman', visa_validity: '30 days from entry', not_included: 'Flight tickets' });
});

test('a visa sheet exported as CSV imports with its services, matching by country + type + duration', async ({ page }) => {
  const posts = [], patches = [];
  await mock(page, { posts, patches, visas: [{ Id: 9, visa_country: 'Oman', visa_type: 'single_entry', duration: '30_days', adult_price: 300 }] });
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#visaList')).toContainText('Oman');
  // @ts-ignore
  await page.evaluate(() => taOpenImport('visas'));
  const csv = [
    'Country,Visa Type,Duration,Price,Currency,Validity,Transport,Hotel,Meals,Border Fees,Services Included,Documents',
    'Oman,Single Entry,30 Days,350,aed,30 days,"Dubai ⇄ Oman, AC bus",1 night 3★,Breakfast,Yes,Khasab tour,Passport copy;Photo',
    'Georgia,Multiple Entry,60 Days,900,AED,1 year,No,,,,,Passport',
  ].join('\n');
  await page.locator('#taImportFile').setInputFiles({ name: 'tripcod.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.locator('#taImportSummary')).toContainText('1 new, 1 updating existing');
  await page.click('#taImportConfirmBtn');
  await expect(page.locator('#taImportMsg')).toHaveText('✓ Imported 2 record(s)');
  expect(patches[0]).toMatchObject({ Id: 9, visa_type: 'single_entry', duration: '30_days', adult_price: 350, currency: 'AED', visa_validity: '30 days', required_documents: 'Passport copy\nPhoto' });
  expect(JSON.parse(patches[0].services_included)).toEqual([
    { item: 'Transportation', detail: 'Dubai ⇄ Oman, AC bus' }, { item: 'Hotel Stay', detail: '1 night 3★' },
    { item: 'Meals', detail: 'Breakfast' }, { item: 'Border Fees', detail: '' }, { item: 'Khasab tour', detail: '' }]);
  expect(posts[0]).toMatchObject({ visa_country: 'Georgia', visa_type: 'multiple_entry', duration: '60_days', services_included: '[]' });
});

test('reopening the module paints the last loaded copy before the fresh one arrives', async ({ page }) => {
  const fetches = [];
  await mock(page, { fetches, visaDelay: 4000, visas: [{ Id: 1, visa_country: 'Georgia' }] });
  await page.addInitScript(() => {
    localStorage.setItem('ta_snapshot_v1_7', JSON.stringify({ at: Date.now(), data: { visas: [{ Id: 1, visa_country: 'Thailand (cached)' }] } }));
  });
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#visaList')).toContainText('Thailand (cached)', { timeout: 2500 });
  await expect(page.locator('#visaList')).toContainText('Georgia', { timeout: 8000 });
  // @ts-ignore — after a save only the changed table is refetched
  const before = fetches.length;
  await page.evaluate(() => taLoad(['visas']));
  expect(fetches.length).toBe(before + 1);
});
