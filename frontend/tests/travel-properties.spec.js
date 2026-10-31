// Resorts & Hotels tab: properties are listed from /ta/properties with their Drive photo as the
// card thumbnail, and the save form posts every field (incl. Drive media links) and surfaces the
// worker's validation error (e.g. a Drive folder pasted instead of a file) instead of "Saved".
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';

test('lists resorts/hotels and saves a new property with Drive media', async ({ page }) => {
  const ids = { packages: 'tp', bookings: 'tb', cases: 'tc', itineraries: 'ti', umrah_groups: 'tu' };
  const posts = [];
  await page.route('**/*', async (route) => {
    const req = route.request(), url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (!url.startsWith(WORKER)) return route.abort();
    const u = new URL(url);
    if (u.pathname.endsWith('/records/7')) return route.fulfill({ json: { Id: 7, ta_enabled: 'Yes', ta_table_ids: JSON.stringify(ids) } });
    if (u.pathname === '/ta/properties' && req.method() === 'GET') return route.fulfill({ json: { list: [
      { id: 1, name: 'Spice Village Resort', property_type: 'resort', location: 'Thekkady', star_rating: 4, price_from: 8500, currency: 'INR', price_unit: 'per night',
        image_url: 'https://drive.google.com/file/d/abc123/view', video_url: 'https://drive.google.com/file/d/v1/view', status: 'active' },
    ] } });
    if (u.pathname === '/ta/properties' && req.method() === 'POST') {
      const body = req.postDataJSON(); posts.push(body);
      if (body.image_url.includes('/folders/')) return route.fulfill({ status: 400, json: { error: 'Photo 1: paste the Google Drive link of the file itself, not a folder.' } });
      return route.fulfill({ json: { ok: true, id: 2 } });
    }
    return route.fulfill({ json: { list: [] } });
  });
  await page.goto('file://' + path.resolve(__dirname, '../travel-agency.html') + '?client=7&token=t&embed=1&shell=travel&tab=properties', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#agencyContent')).toContainText('Spice Village Resort');
  await expect(page.locator('#agencyContent')).toContainText('From INR 8,500');
  await expect(page.locator('#agencyContent')).toContainText('📷 1 · 🎬 Video');
  const thumb = await page.locator('#agencyContent [style*="thumbnail?id=abc123"]').count();
  expect(thumb).toBe(1);

  await page.click('text=+ Add Property');
  await page.fill('#propName', 'Taj Bekal');
  await page.selectOption('#propType', 'hotel');
  await page.fill('#propImg1', 'https://drive.google.com/drive/folders/xyz');
  await page.click('#savePropBtn');
  await expect(page.locator('#savePropMsg')).toContainText('not a folder');

  await page.fill('#propImg1', 'https://drive.google.com/file/d/img9/view');
  await page.fill('#propPdf', 'https://drive.google.com/file/d/pdf9/view');
  await page.click('#savePropBtn');
  await expect(page.locator('#savePropMsg')).toHaveText('✓ Saved');
  expect(posts.at(-1)).toMatchObject({ client_id: '7', name: 'Taj Bekal', property_type: 'hotel', status: 'active', currency: 'INR', price_unit: 'per night',
    image_url: 'https://drive.google.com/file/d/img9/view', pdf_url: 'https://drive.google.com/file/d/pdf9/view' });
});

test('Family and Couple resorts get their own sections and filter chips; category is saved', async ({ page }) => {
  const ids = { packages: 'tp', bookings: 'tb', cases: 'tc', itineraries: 'ti', umrah_groups: 'tu' };
  const posts = [];
  const list = [
    { id: 1, name: 'Kids Paradise', category: 'family', status: 'active' },
    { id: 2, name: 'Honeymoon Hills', category: 'couple', status: 'active' },
    { id: 3, name: 'Lake Breeze', category: 'both', status: 'active' },
    { id: 4, name: 'City Inn', property_type: 'hotel', category: '', status: 'active' },
  ];
  await page.route('**/*', async (route) => {
    const req = route.request(), url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (!url.startsWith(WORKER)) return route.abort();
    const u = new URL(url);
    if (u.pathname.endsWith('/records/7')) return route.fulfill({ json: { Id: 7, ta_enabled: 'Yes', ta_table_ids: JSON.stringify(ids) } });
    if (u.pathname === '/ta/properties' && req.method() === 'GET') return route.fulfill({ json: { list } });
    if (u.pathname === '/ta/properties' && req.method() === 'POST') { posts.push(req.postDataJSON()); return route.fulfill({ json: { ok: true, id: 9 } }); }
    return route.fulfill({ json: { list: [] } });
  });
  await page.goto('file://' + path.resolve(__dirname, '../travel-agency.html') + '?client=7&token=t&embed=1&shell=travel&tab=properties', { waitUntil: 'domcontentloaded' });
  const content = page.locator('#agencyContent');
  await expect(content).toContainText('Kids Paradise');
  const names = (sec) => content.locator(`.prop-sec[data-sec="${sec}"] .ta-card div[style*="font-weight:700"]`).allTextContents();
  expect(await names('family')).toEqual(['Kids Paradise', 'Lake Breeze']);
  expect(await names('couple')).toEqual(['Honeymoon Hills', 'Lake Breeze']);
  expect(await names('other')).toEqual(['City Inn']);
  await expect(content.locator('[data-propcat="family"]')).toContainText('2');
  await expect(content.locator('[data-propcat="couple"]')).toContainText('2');
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });

  await content.locator('[data-propcat="couple"]').click();
  await expect(content.locator('.prop-sec')).toHaveCount(1);
  expect(await names('couple')).toEqual(['Honeymoon Hills', 'Lake Breeze']);
  await expect(content.locator('.prop-sec[data-sec="couple"] .prop-cat').first()).toHaveText('💑 Couple');

  await page.click('text=+ Add Property');
  await page.fill('#propName', 'Tiny Tots Resort');
  await page.selectOption('#propCategory', 'family');
  await page.click('#savePropBtn');
  await expect(page.locator('#savePropMsg')).toHaveText('✓ Saved');
  expect(posts.at(-1)).toMatchObject({ name: 'Tiny Tots Resort', category: 'family' });
});
