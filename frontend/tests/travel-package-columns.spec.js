// Saving a package on a ta_packages table created before child/infant prices existed has to add
// those columns first. NocoDB's v2 meta API creates columns at /meta/tables/{id}/columns — there
// is no /fields route, so posting there 404'd and the save failed with "HTTP 404".
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';

test('saving a package adds missing price columns via /columns, then saves', async ({ page }) => {
  const ids = { packages: 'tp', bookings: 'tb', cases: 'tc', itineraries: 'ti', umrah_groups: 'tu' };
  const addedColumns = [];
  let created = null;
  await page.route('**/*', async (route) => {
    const req = route.request(), url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (!url.startsWith(WORKER)) return route.abort();
    const u = new URL(url);
    if (u.pathname.endsWith('/records/7')) return route.fulfill({ json: { Id: 7, ta_enabled: 'Yes', ta_table_ids: JSON.stringify(ids) } });
    if (u.pathname.endsWith('/meta/tables/tp')) return route.fulfill({ json: { columns: [{ title: 'name' }, { title: 'sell_price' }] } });
    if (u.pathname.endsWith('/meta/tables/tp/columns') && req.method() === 'POST') { addedColumns.push(req.postDataJSON().title); return route.fulfill({ json: {} }); }
    if (u.pathname.includes('/meta/')) return route.fulfill({ status: 404, json: { msg: 'Not found' } });
    if (u.pathname.endsWith('/tables/tp/records') && req.method() === 'POST') { created = req.postDataJSON(); return route.fulfill({ json: { Id: 1 } }); }
    return route.fulfill({ json: { list: [] } });
  });
  await page.goto('file://' + path.resolve(__dirname, '../travel-agency.html') + '?client=7&token=t&embed=1&shell=travel&tab=packages', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#agencyContent')).toBeVisible();
  // @ts-ignore
  await page.evaluate(() => { _editPkgId = null; openModal('modalPkg'); });
  await page.fill('#pkgName', 'Bali 5N');
  await page.fill('#pkgChildPrice', '500');
  await page.click('#savePkgBtn');
  await expect(page.locator('#savePkgMsg')).toHaveText('✓ Saved');
  expect(addedColumns.sort()).toEqual(['child_nobed_price', 'child_price', 'infant_price']);
  expect(created).toMatchObject({ name: 'Bali 5N', child_price: 500, client_id: '7' });
});
