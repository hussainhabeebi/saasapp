// sw.js: the app's own scripts must not be served from the service-worker cache once a newer copy
// is deployed — cache-first used to keep a phone on its first-ever accounting-ledger.js for good.
// Runs the real sw.js over a local HTTP server (service workers don't run on file://).
import { test, expect } from '@playwright/test';
import http from 'node:http';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SW = readFileSync(path.resolve(__dirname, '../sw.js'), 'utf8');

test('a redeployed same-origin script reaches the page on the next load', async ({ page }) => {
  let version = 'v1';
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/sw.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(SW); }
    if (p === '/app.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(`window.APP_VERSION='${version}';`); }
    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<!doctype html><script src="/app.js"></script><script>navigator.serviceWorker.register('/sw.js');</script>`);
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // Block only the CDN files sw.js precaches; everything else is local.
    await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
    await page.goto(base + '/');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload(); // now controlled by the service worker, which caches app.js
    expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    expect(await page.evaluate(() => window.APP_VERSION)).toBe('v1');
    version = 'v2'; // "deploy"
    await page.reload();
    expect(await page.evaluate(() => window.APP_VERSION)).toBe('v2');
  } finally { server.close(); }
});
