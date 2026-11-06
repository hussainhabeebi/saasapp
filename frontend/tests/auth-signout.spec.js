// Sign out (dashboard.html signOut) must end Authentik's session too, not just clear this app's
// token — otherwise the next Sign in / silent re-auth hands the same account straight back.
// Sign in is a single same-tab redirect to Authentik's authorize endpoint (no popup).
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');

async function trapAuthentik(page) {
  const hits = [];
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'file:') return route.continue();
    if (url.hostname === 'secure.leadvyne.com') { hits.push(url); return route.fulfill({ body: 'authentik', contentType: 'text/html' }); }
    return route.abort();
  });
  return hits;
}

test('Sign out clears the local session and goes to Authentik\'s logout flow', async ({ page }) => {
  const hits = await trapAuthentik(page);
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.setItem('lv_cid', '7'); localStorage.setItem('lv_session', 'tok'); localStorage.setItem('lv_me_email', 'a@b.com'); });
  await Promise.all([
    page.waitForURL(/secure\.leadvyne\.com/),
    // @ts-ignore
    page.evaluate(() => signOut()),
  ]);
  expect(hits.some((u) => u.pathname === '/if/flow/default-invalidation-flow/')).toBe(true);
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  const left = await page.evaluate(() => ['lv_cid', 'lv_session', 'lv_me_email'].map((k) => localStorage.getItem(k)));
  expect(left).toEqual([null, null, null]);
});

test('?logout=1 from another page runs the same sign out', async ({ page }) => {
  const hits = await trapAuthentik(page);
  await page.goto(dashboardUrl + '?logout=1', { waitUntil: 'domcontentloaded' });
  await page.waitForURL(/secure\.leadvyne\.com/);
  expect(hits.some((u) => u.pathname === '/if/flow/default-invalidation-flow/')).toBe(true);
});

test('Sign in redirects this tab to Authentik — no popup', async ({ page }) => {
  const hits = await trapAuthentik(page);
  let popups = 0; page.on('popup', () => popups++);
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#gBtn')).toHaveText('Sign in', { timeout: 5000 });
  await Promise.all([page.waitForURL(/secure\.leadvyne\.com/), page.click('#gBtn')]);
  const authorize = hits.find((u) => u.pathname === '/application/o/authorize/');
  expect(authorize?.searchParams.get('code_challenge_method')).toBe('S256');
  expect(popups).toBe(0);
});
