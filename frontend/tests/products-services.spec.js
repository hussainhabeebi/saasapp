// products-services.html (Dashboard → 📦 Products & Services, General accounts): list, add, edit
// and delete items with Drive links for photos, a voice note and a brochure. Hermetic file:// page
// with the worker's /catalog/items stubbed.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pageUrl = 'file://' + path.resolve(__dirname, '../products-services.html') + '?client=48&token=t&embed=1';

async function open(page, items = []) {
  const calls = [];
  let list = items.map((i) => ({ ...i }));
  let next = 10;
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.protocol === 'file:') return route.continue();
    if (url.pathname.endsWith('/catalog/items')) {
      const m = req.method();
      const body = m === 'GET' ? null : req.postDataJSON();
      calls.push({ method: m, body, auth: req.headers().authorization });
      if (m === 'GET') return route.fulfill({ json: { items: list } });
      if (m === 'POST') { const item = { ...body, id: String(next++), price: body.price === '' ? null : Number(body.price), photos: [] }; list.push(item); return route.fulfill({ json: { item } }); }
      if (m === 'PATCH') { const i = list.findIndex((x) => x.id === body.id); list[i] = { ...list[i], ...body, price: body.price === '' ? null : Number(body.price) }; return route.fulfill({ json: { item: list[i] } }); }
      if (m === 'DELETE') { list = list.filter((x) => x.id !== body.id); return route.fulfill({ json: { ok: true } }); }
    }
    return route.abort();
  });
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  return calls;
}

test('add an item with details and Drive media, then edit and delete it', async ({ page }) => {
  const calls = await open(page);
  await expect(page.locator('#list')).toContainText('No products or services yet');
  await page.locator('#addBtn').click();
  await page.locator('#fName').fill('Solar Water Heater');
  await page.locator('#fPrice').fill('42000');
  await page.locator('#fShort').fill('Rooftop solar heater');
  await page.locator('#fDetails').fill('Stainless steel tank, 5-year warranty.');
  await page.locator('#fKeywords').fill('geyser');
  await page.locator('#fImg1').fill('https://drive.google.com/file/d/abc123/view?usp=sharing');
  await expect(page.locator('#thumbs img')).toHaveAttribute('src', 'https://drive.google.com/thumbnail?id=abc123&sz=w400');
  await page.locator('#fVoice').fill('https://drive.google.com/file/d/voice1/view');
  await page.locator('#saveBtn').click();
  await expect(page.locator('#editor')).toBeHidden();
  const post = calls.find((c) => c.method === 'POST');
  expect(post.auth).toBe('Bearer t');
  expect(post.body).toMatchObject({ kind: 'product', name: 'Solar Water Heater', price: '42000', currency: 'INR', keywords: 'geyser',
    image_url_1: 'https://drive.google.com/file/d/abc123/view?usp=sharing', voice_note_url: 'https://drive.google.com/file/d/voice1/view', auto_send: 1, status: 'active' });
  const card = page.locator('.item', { hasText: 'Solar Water Heater' });
  await expect(card).toContainText('INR 42,000');
  await expect(card).toContainText('🎙️ Voice note');
  await expect(card).toContainText('Bot sends on mention');

  await card.getByRole('button', { name: 'Edit' }).click();
  await expect(page.locator('#fName')).toHaveValue('Solar Water Heater');
  await page.locator('#fAuto').uncheck();
  await page.locator('#saveBtn').click();
  expect(calls.find((c) => c.method === 'PATCH').body).toMatchObject({ id: '10', auto_send: 0 });
  await expect(card).toContainText('Bot: answers only');

  page.once('dialog', (d) => d.accept());
  await card.getByRole('button', { name: 'Edit' }).click();
  await page.locator('#delBtn').click();
  await expect(page.locator('.item')).toHaveCount(0);
  expect(calls.find((c) => c.method === 'DELETE').body).toEqual({ id: '10' });
});

test('search and filters; a name is required', async ({ page }) => {
  await open(page, [
    { id: '1', kind: 'product', name: 'Solar Water Heater', price: 42000, currency: 'INR', status: 'active', photos: [] },
    { id: '2', kind: 'service', name: 'Annual Maintenance', price: 2500, currency: 'INR', price_unit: 'year', status: 'active', photos: [] },
    { id: '3', kind: 'service', name: 'Site Survey', price: null, status: 'inactive', photos: [] },
  ]);
  await expect(page.locator('.item')).toHaveCount(3);
  await expect(page.locator('.item', { hasText: 'Annual Maintenance' })).toContainText('INR 2,500 / year');
  await expect(page.locator('.item', { hasText: 'Site Survey' })).toContainText('Price on request');
  await page.locator('#fKind').selectOption('service');
  await expect(page.locator('.item')).toHaveCount(2);
  await page.locator('#fStatus').selectOption('active');
  await expect(page.locator('.item')).toHaveCount(1);
  await page.locator('#fKind').selectOption('');
  await page.locator('#fStatus').selectOption('');
  await page.locator('#q').fill('heater');
  await expect(page.locator('.item')).toHaveCount(1);
  await page.locator('#addBtn').click();
  await page.locator('#saveBtn').click();
  await expect(page.locator('#edMsg')).toHaveText('Name is required');
});
