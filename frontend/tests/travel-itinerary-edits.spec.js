// Agency → Itineraries: details that used to go missing after a save, the Client (address) fields
// and the Discount box. Same hermetic file:// load as travel-itinerary-builder.spec.js; a tiny
// in-memory "NocoDB" stands behind the itineraries table so saves can be read back.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pageUrl = 'file://' + path.resolve(__dirname, '../travel-agency.html') + '?client=7&token=t';

// `keep(field, value)` decides what the table actually stores — used to fake a column that drops data.
async function open(page, { keep = (_k, v) => v, columns = null } = {}) {
  const rows = new Map();
  const added = [];
  let nextId = 1;
  await page.route('**/*', async (route) => {
    const r = route.request(); const u = r.url();
    if (u.startsWith('file://')) return route.continue();
    if (u.includes('/meta/tables/') && u.endsWith('/columns') && r.method() === 'POST') { added.push(JSON.parse(r.postData()).title); return route.fulfill({ json: {} }); }
    if (u.includes('/meta/tables/')) return route.fulfill({ json: { columns: (columns || []).map((title) => ({ title })) } });
    const m = /\/tables\/i\/records(?:\/(\d+))?/.exec(u);
    if (m) {
      const store = (body) => { const row = rows.get(body.Id) || { Id: body.Id }; for (const [k, v] of Object.entries(body)) row[k] = keep(k, v); rows.set(body.Id, row); return row; };
      if (r.method() === 'POST') { const b = JSON.parse(r.postData()); const id = nextId++; store({ ...b, Id: id }); return route.fulfill({ json: { Id: id } }); }
      if (r.method() === 'PATCH') { store(JSON.parse(r.postData())); return route.fulfill({ json: {} }); }
      if (r.method() === 'GET' && m[1]) return route.fulfill({ json: rows.get(Number(m[1])) || {} });
      return route.fulfill({ json: { list: [...rows.values()] } });
    }
    return route.abort();
  });
  await page.goto(pageUrl);
  await page.waitForFunction(() => typeof openItinModal === 'function');
  await page.evaluate(() => {
    // @ts-ignore
    clientRecord = { client_name: 'Test Travels', ta_table_ids: JSON.stringify({ packages: 'p', bookings: 'b', cases: 'c', itineraries: 'i', umrah_groups: 'u' }) };
  });
  return { rows, added };
}

test('a currency, hotel category or meal plan not in the list is kept, not wiped on save', async ({ page }) => {
  const { rows } = await open(page);
  await page.evaluate(() => openItinModal(null, { title: 'Bangkok 4N', currency: 'thb', hotel_category: 'Boutique', meal_plan: 'Breakfast + Dinner', days: [{ day_no: 1, title: 'Arrive', items: [] }] }));
  await expect(page.locator('#itinCurrency')).toHaveValue('THB');
  await expect(page.locator('#itinHotelCat')).toHaveValue('Boutique');
  await expect(page.locator('#itinMealPlan')).toHaveValue('Breakfast + Dinner');
  await page.evaluate(() => saveItin());
  await expect(page.locator('#saveItinMsg')).toHaveText('✓ Saved');
  expect(rows.get(1)).toMatchObject({ currency: 'THB', hotel_category: 'Boutique', meal_plan: 'Breakfast + Dinner' });
  // Reopening a normal itinerary drops the extra option again.
  await page.evaluate(() => openItinModal(null, { title: 'Dubai', currency: 'AED', days: [] }));
  await expect(page.locator('#itinCurrency option[data-extra]')).toHaveCount(0);
});

test('a day photo link pasted but not "+ Add link"-ed is saved', async ({ page }) => {
  const { rows } = await open(page);
  await page.evaluate(() => openItinModal(null, { title: 'Kashmir', days: [{ day_no: 1, title: 'Srinagar', items: [] }] }));
  await page.locator('#itinImgLink0').fill('https://drive.google.com/file/d/abc/view');
  await page.evaluate(() => saveItin());
  await expect(page.locator('#saveItinMsg')).toHaveText('✓ Saved');
  expect(JSON.parse(rows.get(1).days)[0].image_links).toEqual(['https://drive.google.com/file/d/abc/view']);
});

test('a detail the table did not keep is reported instead of silently going missing', async ({ page }) => {
  // The days column cuts long text short (what a too-small database column does).
  await open(page, { keep: (k, v) => (k === 'days' && typeof v === 'string' ? v.slice(0, 40) : v) });
  await page.evaluate(() => openItinModal(null, { title: 'Long trip', days: [{ day_no: 1, title: 'Arrival and a long city tour', description: 'x'.repeat(200), items: [] }] }));
  await page.evaluate(() => saveItin());
  await expect(page.locator('#saveItinMsg')).toContainText('did not stick: Day-by-day plan');
  await expect(page.locator('#saveItinMsg')).toHaveClass(/err/);
});

test('a column missing from the table is added and the save retried', async ({ page }) => {
  // The table forgets client_address until the column is (re)added.
  let hasColumn = false;
  const { rows, added } = await open(page, { keep: (k, v) => (k === 'client_address' && !hasColumn ? undefined : v) });
  await page.exposeFunction('__colAdded', () => { hasColumn = true; });
  await page.evaluate(() => {
    // @ts-ignore — the first column check says everything exists (a stale cache), the retry adds it.
    _taColumnsChecked.add('itineraries');
    const orig = ncPost;
    // @ts-ignore
    ncPost = async (url, body) => { if (/\/columns$/.test(url)) await window.__colAdded(); return orig(url, body); };
    openItinModal(null, { title: 'Goa', client_address: 'Flat 4B, Marine Drive\nKochi', days: [] });
  });
  await page.evaluate(() => saveItin());
  await expect(page.locator('#saveItinMsg')).toHaveText('✓ Saved');
  expect(added).toContain('client_address');
  expect(rows.get(1).client_address).toBe('Flat 4B, Marine Drive\nKochi');
});

test('client details and the discount are saved, shown on the total and on the PDF', async ({ page }) => {
  const { rows } = await open(page);
  await page.evaluate(() => openItinModal(null, { title: 'Kerala 3N', currency: 'INR', adults: 2, adult_price: 10000, days: [{ day_no: 1, title: 'Kochi', items: [] }] }));
  await page.locator('#itinClientName').fill('Rahul Menon');
  await page.locator('#itinClientPhone').fill('+91 98470 00000');
  await page.locator('#itinClientAddress').fill('12 MG Road\nKochi 682016');
  await page.locator('#itinDiscountType').selectOption('percent');
  await page.locator('#itinDiscountValue').fill('10');
  await page.locator('#itinDiscountLabel').fill('Early bird');
  await expect(page.locator('#itinRateTotal')).toHaveText('Estimated total: 2 × Adult @ INR 10,000 = INR 20,000 − discount INR 2,000 = INR 18,000');
  await page.evaluate(() => saveItin());
  await expect(page.locator('#saveItinMsg')).toHaveText('✓ Saved');
  expect(rows.get(1)).toMatchObject({ client_name: 'Rahul Menon', client_phone: '+91 98470 00000', client_address: '12 MG Road\nKochi 682016',
    discount_type: 'percent', discount_value: 10, discount_label: 'Early bird' });

  const pdf = await page.evaluate(async (rec) => {
    await loadJsPdf();
    return itinBuildFullPdfDoc({}, { ...rec, days: JSON.parse(rec.days) }, 'ITN-0001').output();
  }, rows.get(1));
  for (const text of ['Rahul Menon', '12 MG Road', 'Kochi 682016', 'Subtotal', 'Early bird \\(10%\\)', '- INR 2,000', 'INR 18,000']) expect(pdf).toContain(text);

  const wa = await page.evaluate((rec) => itinWaText({ ...rec, days: JSON.parse(rec.days) }), rows.get(1));
  expect(wa).toContain('Early bird (10%): -INR 2,000');
  expect(wa).toContain('*Total: INR 18,000*');

  // Editing brings every field back.
  await page.evaluate((rec) => { _taFresh = true; _taItineraries = [{ ...rec, days: JSON.parse(rec.days) }]; openItinModal(String(rec.Id)); }, rows.get(1));
  await expect(page.locator('#itinClientAddress')).toHaveValue('12 MG Road\nKochi 682016');
  await expect(page.locator('#itinDiscountType')).toHaveValue('percent');
  await expect(page.locator('#itinDiscountValue')).toHaveValue('10');
});

test('an amount discount with no traveller counts shows as "off" and never exceeds the total', async ({ page }) => {
  await open(page);
  const out = await page.evaluate(() => ({
    text: itinDiscountText({ discount_type: 'amount', discount_value: 500 }, 'AED'),
    capped: itinDiscountOf({ discount_type: 'amount', discount_value: 5000 }, 1200).amount,
    pct: itinDiscountOf({ discount_type: 'percent', discount_value: 150 }, 1000).amount,
  }));
  expect(out).toEqual({ text: 'AED 500 off', capped: 1200, pct: 1000 });
});
