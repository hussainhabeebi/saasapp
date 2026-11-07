// Agency → Itineraries: the detailed builder (trip facts, per-day details, adult/child rates) and
// child rates on Send Quotation. Hermetic file:// load with every network request blocked; the
// builder, PDF and line-item functions are driven directly since there's no NocoDB behind them.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pageUrl = 'file://' + path.resolve(__dirname, '../travel-agency.html') + '?client=7&token=t';

async function open(page) {
  await page.route('**/*', (route) => (route.request().url().startsWith('file://') ? route.continue() : route.abort()));
  await page.goto(pageUrl);
  await page.waitForFunction(() => typeof openItinModal === 'function');
}

test('builder keeps per-day details and shows the adult + child total', async ({ page }) => {
  await open(page);
  await page.evaluate(() => openItinModal(null, {
    title: 'Hyderabad Bus Package', from_date: '2026-11-14', currency: 'INR',
    adults: 2, children: 1, adult_price: 15000, child_price: 9000,
    days: [{ day_no: 1, title: 'Arrival', items: [] }, { day_no: 2, title: 'City tour', items: [] }],
  }));
  await expect(page.locator('#itinRateTotal')).toHaveText('Estimated total: 2 × Adult @ INR 15,000 + 1 × Child (with bed) @ INR 9,000 = INR 39,000');
  await expect(page.locator('#itinDaysList')).toContainText('Sat, 14 Nov 2026');
  await page.locator('#itinDaysList textarea').first().fill('Reach Hyderabad, check in.');
  await page.locator('#itinDaysList input[placeholder^="Overnight"]').first().fill('Hotel Sitara');
  await page.locator('#itinDaysList label:has-text("Breakfast") input').first().check();
  await page.getByTitle('Move down').first().click();
  const days = await page.evaluate(() => _itinDays);
  expect(days.map((d) => [d.day_no, d.title])).toEqual([[1, 'City tour'], [2, 'Arrival']]);
  expect(days[1]).toMatchObject({ description: 'Reach Hyderabad, check in.', overnight: 'Hotel Sitara', meals: ['B'] });
});

test('quotation line items add child and infant rows after the adult row', async ({ page }) => {
  await open(page);
  const { rows, subtotal } = await page.evaluate(() => sqBuildLineItems(
    { type: 'package', rec: { name: 'HYDERABAD BUSS PACKAGE', inclusions: '[]' } }, 'package', 15000, 'INR', 2,
    [{ label: 'Child (with bed)', price: 9000, count: 1 }, { label: 'Infant', price: 2000, count: 1 }]));
  expect(rows.map((r) => [r.desc, r.persons, r.total])).toEqual([
    ['HYDERABAD BUSS PACKAGE — Adult', 2, 30000],
    ['HYDERABAD BUSS PACKAGE — Child (with bed)', 1, 9000],
    ['HYDERABAD BUSS PACKAGE — Infant', 1, 2000],
  ]);
  expect(subtotal).toBe(41000);
});

test('full itinerary PDF renders the detailed trip with its price table', async ({ page }) => {
  await open(page);
  const pages = await page.evaluate(async () => {
    clientRecord = { client_name: 'Test Travels' };
    await loadJsPdf();
    const it = {
      title: 'Hyderabad Bus Package', destination: 'Hyderabad', from_date: '2026-11-14', to_date: '2026-11-16', nights: 2,
      departure_city: 'Kozhikode', hotel_category: '3 Star', meal_plan: 'Breakfast (CP)', transport: 'AC bus',
      adults: 2, children: 1, currency: 'INR', adult_price: 15000, child_price: 9000,
      inclusions: '["Hotel","Breakfast"]', exclusions: '["Entry tickets"]',
      days: [{ day_no: 1, title: 'Arrival', description: 'Reach Hyderabad.', meals: ['B'], overnight: 'Hotel Sitara',
        image_links: ['https://drive.google.com/drive/folders/abc123'],
        items: [{ type: 'activity', time: '16:00', description: 'Charminar' }] }],
    };
    const doc = itinBuildFullPdfDoc({ Name: 'Test' }, it, 'ITN-0001');
    return { n: doc.getNumberOfPages(), out: doc.output() };
  });
  expect(pages.n).toBeGreaterThan(0);
  expect(pages.out).toContain('drive.google.com/drive/folders/abc123');
});

test('manual builder keeps per-day Google Drive photo links and shares them', async ({ page }) => {
  await open(page);
  await page.evaluate(() => openItinModal(null, {
    title: 'Hyderabad Bus Package', from_date: '2026-11-14', currency: 'INR',
    days: [{ day_no: 1, title: 'Arrival', items: [] }, { day_no: 2, title: 'City tour', items: [] }],
  }));
  const link = 'https://drive.google.com/drive/folders/abc123';
  await page.locator('#itinImgLink1').fill(link);
  await page.locator('#itinImgLink1').press('Enter');
  await expect(page.locator('#itinDaysList a[href="' + link + '"]')).toHaveCount(1);
  await page.locator('#itinImgLink0').fill('not a link');
  await page.locator('#itinDaysList button:has-text("+ Add link")').first().click();
  await expect(page.locator('#itinImgLinkMsg0')).toContainText('https://');
  const days = await page.evaluate(() => _itinDays);
  expect(days[0].image_links || []).toEqual([]);
  expect(days[1].image_links).toEqual([link]);
  const wa = await page.evaluate(() => itinWaText({ title: 'T', days: _itinDays }));
  expect(wa).toContain('📷 Photos: ' + link);
  await page.getByTitle('Remove link').click();
  expect(await page.evaluate(() => _itinDays[1].image_links)).toEqual([]);
});

test('package editor waits for the fresh copy so a stale snapshot cannot blank saved photos', async ({ page }) => {
  await open(page);
  const photo = await page.evaluate(async () => {
    _taPackages = [{ Id: 5, name: 'Old', image_url: '' }];
    _taFresh = false;
    let done;
    _taFreshPromise = new Promise((r) => { done = r; });
    openPkgModal(5);
    const before = $id('pkgImage1').value;
    _taPackages = [{ Id: 5, name: 'Old', image_url: 'https://drive.google.com/file/d/1AbC/view' }];
    _taFresh = true; done(); await _taFreshPromise; await new Promise((r) => setTimeout(r, 0));
    return { before, after: $id('pkgImage1').value };
  });
  expect(photo).toEqual({ before: '', after: 'https://drive.google.com/file/d/1AbC/view' });
});

test('day photo links (Drive files) are drawn as images in the itinerary PDF; folders stay links', async ({ page }) => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const asked = [];
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith('file://')) return route.continue();
    if (u.includes('/travel/drive-image')) { asked.push(new URL(u).searchParams.get('id')); return route.fulfill({ json: { data_url: png } }); }
    return route.abort();
  });
  await page.goto(pageUrl);
  await page.waitForFunction(() => typeof openItinModal === 'function');
  const r = await page.evaluate(async () => {
    clientRecord = { client_name: 'Test Travels' };
    await loadJsPdf();
    const it = await itinWithAutoImages({ title: 'T', from_date: '2026-11-14', days: [{ day_no: 1, title: 'Arrival', items: [],
      image_links: ['https://drive.google.com/file/d/FILEID12345/view?usp=sharing', 'https://drive.google.com/drive/folders/FOLDER12345'] }] });
    const out = itinBuildFullPdfDoc({ Name: 'Test' }, it, 'ITN-0001').output();
    return { photos: it.days[0].photo_images.map((p) => p.url), hasImage: /\/Subtype \/Image/.test(out), folderLink: out.includes('FOLDER12345'), fileLink: out.includes('FILEID12345') };
  });
  expect(asked).toEqual(['FILEID12345']);
  expect(r).toEqual({ photos: ['https://drive.google.com/file/d/FILEID12345/view?usp=sharing'], hasImage: true, folderLink: true, fileLink: true });
});

test('✨ AI Itinerary on a package opens the builder with the drafted days and shrunk photos', async ({ page }) => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  let sent = null;
  await page.route('**/*', (route) => {
    const r = route.request(); const u = r.url();
    if (u.startsWith('file://')) return route.continue();
    if (u.includes('/travel/ai-itinerary')) {
      sent = JSON.parse(r.postData());
      return route.fulfill({ json: { days: [
        { day_no: 1, title: 'Arrival & Charminar', description: 'Reach Hyderabad.', overnight: 'Hyderabad', meals: ['D'], image_links: ['https://drive.google.com/file/d/PKG1/view'],
          items: [{ type: 'activity', time: '16:00', description: 'Visit Charminar', image: png }] },
        { day_no: 2, title: 'Departure', description: '', overnight: '', meals: ['B'], image_links: [], items: [] },
      ] } });
    }
    return route.abort();
  });
  await page.goto(pageUrl);
  await page.waitForFunction(() => typeof pkgAiItinerary === 'function');
  await page.evaluate(() => {
    _taPackages = [{ Id: 9, name: 'Hyderabad Bus Package', destination: 'Hyderabad', nights: 1, sell_price: 15000, currency: 'INR', image_url: 'https://drive.google.com/file/d/PKG1/view' }];
    document.body.insertAdjacentHTML('beforeend', `<div id="cardHost">${renderPkgCard(_taPackages[0])}</div>`);
  });
  await page.locator('#cardHost button:has-text("AI Itinerary")').click();
  await expect(page.locator('#itinModalTitle')).toHaveText('New Itinerary');
  await expect(page.locator('#itinTitle')).toHaveValue('Hyderabad Bus Package');
  expect(sent.package).toMatchObject({ name: 'Hyderabad Bus Package', destination: 'Hyderabad', nights: 1 });
  const days = await page.evaluate(() => _itinDays);
  expect(days.map((d) => d.title)).toEqual(['Arrival & Charminar', 'Departure']);
  expect(days[0].items[0].image).toMatch(/^data:image\/jpeg;base64,/);
  expect(days[0].image_links).toEqual(['https://drive.google.com/file/d/PKG1/view']);
  await expect(page.locator('#itinDaysList input[placeholder^="e.g. flight"]').first()).toHaveValue('Visit Charminar');
  await expect(page.locator('#cardHost button:has-text("AI Itinerary")')).toBeEnabled();
});
