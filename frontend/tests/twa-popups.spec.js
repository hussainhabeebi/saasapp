// Android app (TWA): frontend/twa.js makes every window.open() land on screen inside the app, and
// does nothing at all in a normal browser.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mUrl = 'file://' + path.resolve(__dirname, '../m.html');

async function open(page, qs = '') {
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'file:' || url.protocol === 'blob:') return route.continue();
    if (url.pathname.endsWith('/session/me')) return route.fulfill({ json: { email: 'owner@x.test', client: { authentik_email: 'owner@x.test' } } });
    if (url.pathname.endsWith('/chats/v2/counts')) return route.fulfill({ json: {} });
    if (url.pathname.endsWith('/chats/v2/list')) return route.fulfill({ json: { rows: [] } });
    if (/\/records$/.test(url.pathname)) return route.fulfill({ json: { list: [] } });
    return route.abort();
  });
  await page.goto(mUrl);
  await page.evaluate(() => { localStorage.setItem('lv_cid', '48'); localStorage.setItem('lv_session', 't'); });
  await page.goto(mUrl + qs);
}

test.use({ viewport: { width: 390, height: 844 } });

test('in a normal browser nothing changes: window.open is the browser\'s own', async ({ page }) => {
  await open(page);
  expect(await page.evaluate(() => window.LV_TWA)).toBe(false);
  expect(await page.evaluate(() => /\[native code\]/.test(String(window.open)))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.classList.contains('in-twa'))).toBe(false);
});

test('in the app: a print/report window opens as an in-app sheet that can be written to and closed', async ({ page }) => {
  await open(page, '?src=twa');
  expect(await page.evaluate(() => window.LV_TWA)).toBe(true);
  await page.evaluate(() => {
    const w = window.open('', '_blank', 'width=1000,height=750');
    w.document.write('<!DOCTYPE html><title>Leads Report</title><h2>Report body</h2>');
    w.document.close();
    window.__w = w;
  });
  await expect(page.frameLocator('iframe >> nth=-1').locator('h2')).toHaveText('Report body');
  await expect(page.getByText('Leads Report')).toBeVisible();
  await page.evaluate(() => window.__w.close());
  await expect(page.getByText('Leads Report')).toHaveCount(0);
});

test('in the app: the flag survives moving between pages in the same tab', async ({ page }) => {
  await open(page, '?src=twa');
  await page.goto(mUrl + '#more');
  expect(await page.evaluate(() => window.LV_TWA)).toBe(true);
});

test('in the app: an HTML blob preview shows in the sheet; our own pages open in the app', async ({ page }) => {
  await open(page, '?src=twa');
  await page.evaluate(() => {
    const u = URL.createObjectURL(new Blob(['<title>Scheduled report</title><p>Preview here</p>'], { type: 'text/html' }));
    window.open(u, '_blank');
  });
  await expect(page.frameLocator('iframe >> nth=-1').locator('p')).toHaveText('Preview here');
  await page.getByRole('button', { name: 'Close' }).click();
  const nav = page.waitForURL(/email-marketing\.html/);
  await page.evaluate(() => window.open('email-marketing.html', '_blank'));
  await nav;
});

test('in the app: a blocked tab to another site shows an Open bar that opens it from a tap', async ({ page }) => {
  // Make the browser block every pop-up, like Chrome does for one opened after a slow request.
  await page.addInitScript(() => { window.__opened = []; window.open = (u) => { window.__opened.push(String(u)); return null; }; });
  await open(page, '?src=twa');
  await page.evaluate(() => window.open('https://wa.me/919800000000', '_blank', 'noopener'));
  await expect(page.getByText('Open wa.me?')).toBeVisible();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByText('Open wa.me?')).toHaveCount(0);
  // Tried once on its own (blocked), then again from the tap.
  expect(await page.evaluate(() => window.__opened)).toEqual(['https://wa.me/919800000000', 'https://wa.me/919800000000']);
});

test('in the app: tel: links are handed to the page itself (Android opens the dialer), not a pop-up', async ({ page }) => {
  await page.addInitScript(() => { window.__opened = []; window.open = (u) => { window.__opened.push(String(u)); return null; }; });
  await open(page, '?src=twa');
  const r = await page.evaluate(() => window.open('tel:+919800000000'));
  expect(r).toBeNull();
  expect(await page.evaluate(() => window.__opened)).toEqual([]);
  await expect(page.getByText(/^Open .*\?$/)).toHaveCount(0);
});
