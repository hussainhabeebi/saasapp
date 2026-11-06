// Meta Pixel on the public order / booking pages (lv-pixel.js): the ad click id (fbclid) is kept as
// _fbc, the page sends the same event id to the Worker (Conversions API copy) as it gives the Pixel
// event, so Meta keeps one; with the consent banner on nothing loads until the visitor allows it.
// Pages are served from a fake https origin so cookies work; Meta's script and the Worker are stubbed.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ORIGIN = 'https://shop.example.test';
const PIXEL = '123456789012345';

async function serve(page, { consent = false, posted }) {
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.origin === ORIGIN) {
      const f = path.join(ROOT, u.pathname);
      if (fs.existsSync(f)) return route.fulfill({ body: fs.readFileSync(f), contentType: f.endsWith('.js') ? 'application/javascript' : 'text/html' });
      return route.fulfill({ status: 404, body: '' });
    }
    // Meta's fbevents.js: an empty script, so fbq calls stay in fbq.queue where the test reads them.
    if (u.hostname === 'connect.facebook.net') return route.fulfill({ body: '/* stub */', contentType: 'application/javascript' });
    const p = u.pathname;
    if (p === '/ecom/public/client') return route.fulfill({ json: { client_name: 'Acme', meta_pixel_id: PIXEL, pixel_consent_banner: consent } });
    if (p === '/ecom/public/products') return route.fulfill({ json: { list: [{ sku: 'S1', name: 'Shoe', price: 1200, currency: 'INR' }] } });
    if (p === '/appt/public/client') return route.fulfill({ json: { client_name: 'Clinic', meta_pixel_id: PIXEL, pixel_consent_banner: consent } });
    if (p === '/appt/public/services') return route.fulfill({ json: { list: [{ Id: 1, name: 'Checkup' }] } });
    if (p === '/appt/public/doctors') return route.fulfill({ json: { list: [] } });
    if (p === '/ecom/public/order' || p === '/appt/public/book') {
      posted.push(JSON.parse(route.request().postData() || '{}'));
      return route.fulfill({ json: { ok: true, order_id: 7 } });
    }
    return route.abort();
  });
}
const fbqCalls = (page) => page.evaluate(() => (window.fbq?.queue || []).map((a) => Array.from(a)));

test('order page: fbclid kept as _fbc; the Purchase event id matches the Conversions API copy', async ({ page }) => {
  const posted = [];
  await serve(page, { posted });
  await page.goto(`${ORIGIN}/order.html?client=5&sku=S1&fbclid=AbCdEfGhIjKlMnOp`);
  await expect(page.locator('#submitBtn')).toBeVisible();
  expect(await page.evaluate(() => document.cookie)).toMatch(/_fbc=fb\.1\.\d+\.AbCdEfGhIjKlMnOp/);
  let calls = await fbqCalls(page);
  expect(calls[0]).toEqual(['init', PIXEL]);
  expect(calls.map((c) => c[1])).toEqual([PIXEL, 'PageView', 'ViewContent']);

  await page.fill('#fPhone', '919876543210');
  await page.fill('#fAddress', '12 MG Road, Kochi');
  await page.click('#submitBtn');
  await expect(page.locator('h2')).toHaveText('Order placed!');
  const capi = posted[0].capi;
  expect(capi.event_id).toMatch(/^web_order_/);
  expect(capi.fbc).toMatch(/^fb\.1\.\d+\.AbCdEfGhIjKlMnOp$/);
  expect(capi.url).toContain('/order.html');
  calls = await fbqCalls(page);
  const purchase = calls.find((c) => c[1] === 'Purchase');
  expect(purchase[2]).toMatchObject({ value: 1200, currency: 'INR', content_ids: ['S1'] });
  expect(purchase[3]).toEqual({ eventID: capi.event_id });
});

test('consent banner: nothing loads and no click id is shared until the visitor allows', async ({ page }) => {
  const posted = [];
  await serve(page, { consent: true, posted });
  await page.goto(`${ORIGIN}/order.html?client=5&sku=S1&fbclid=AbCdEfGhIjKlMnOp`);
  await expect(page.locator('#lvConsent')).toBeVisible();
  expect(await page.evaluate(() => typeof window.fbq)).toBe('undefined');
  expect(await page.evaluate(() => LVPixel.capi('x').fbc)).toBeUndefined();

  await page.click('#lvConsentYes');
  await expect(page.locator('#lvConsent')).toHaveCount(0);
  // ViewContent fired before consent was queued and goes out once the Pixel loads.
  expect((await fbqCalls(page)).map((c) => c[1])).toEqual([PIXEL, 'PageView', 'ViewContent']);
  expect(await page.evaluate(() => LVPixel.capi('x').fbc)).toMatch(/AbCdEfGhIjKlMnOp$/);

  // Remembered on the next visit — no banner.
  await page.reload();
  await expect(page.locator('#submitBtn')).toBeVisible();
  await expect(page.locator('#lvConsent')).toHaveCount(0);
});

test('declining keeps the Pixel off and sends no click ids', async ({ page }) => {
  const posted = [];
  await serve(page, { consent: true, posted });
  await page.goto(`${ORIGIN}/order.html?client=5&sku=S1&fbclid=AbCdEfGhIjKlMnOp`);
  await page.click('#lvConsentNo');
  await page.fill('#fPhone', '919876543210');
  await page.fill('#fAddress', '12 MG Road, Kochi');
  await page.click('#submitBtn');
  await expect(page.locator('h2')).toHaveText('Order placed!');
  expect(posted[0].capi.fbc).toBeUndefined();
  expect(posted[0].capi.event_id).toMatch(/^web_order_/);
  expect(await page.evaluate(() => typeof window.fbq)).toBe('undefined');
});

test('booking page: the Schedule event id matches the Conversions API copy', async ({ page }) => {
  const posted = [];
  await serve(page, { posted });
  await page.goto(`${ORIGIN}/book.html?client=5&fbclid=ZyXwVuTsRqPoNmLk`);
  await expect(page.locator('#fPhone')).toBeVisible();
  await page.fill('#fPhone', '919876543210');
  await page.locator('#submitBtn').click();
  await expect(page.locator('h2')).toHaveText('Request sent!');
  const capi = posted[0].capi;
  expect(capi.event_id).toMatch(/^web_book_/);
  expect(capi.fbc).toMatch(/ZyXwVuTsRqPoNmLk$/);
  const schedule = (await fbqCalls(page)).find((c) => c[1] === 'Schedule');
  expect(schedule[3]).toEqual({ eventID: capi.event_id });
});
