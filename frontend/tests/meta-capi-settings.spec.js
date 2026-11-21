// Settings → Integrations → Meta Ads → Save: shows what Meta said about the token (worker
// metaCheckToken) — valid / ads_read / ad account name, or a warning in red — instead of a bare
// "Saved" that hid a token Meta couldn't parse.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');

async function boot(page, reply) {
  const sent = [];
  await page.route('**/*', (route) => (route.request().url().startsWith('file://') ? route.continue() : route.abort()));
  await page.route('**/meta/capi/status', (route) => route.fulfill({ json: { connected: true, ads_read_configured: true, ad_account_id: '1234567890123' } }));
  await page.route('**/meta/capi/config', (route) => { sent.push(JSON.parse(route.request().postData())); return route.fulfill(reply); });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    // @ts-ignore
    clientRecord = { authentik_email: 'boss@x.com', meta_pixel_id: '744598038086701' };
    document.getElementById('cfgMetaPixelId').value = '744598038086701';
    document.getElementById('cfgMetaCapiToken').value = 'EAAGood';
    document.getElementById('cfgMetaAdAccountId').value = 'act_1234567890123';
  });
  return sent;
}

test('a good token: saved, valid, ads_read and the ad account name', async ({ page }) => {
  const sent = await boot(page, { json: { ok: true, meta_pixel_id: '744598038086701', meta_ad_account_id: '1234567890123', check: { token_ok: true, ads_read: true, account_name: 'Aiingo Ads', account_currency: 'INR', warnings: [] } } });
  await page.evaluate(() => window.saveMetaCapiConfig());
  await expect(page.locator('#saveMetaCapiMsg')).toHaveText('✓ Saved · token valid · ads_read ✓ · ad account "Aiingo Ads" (INR)');
  expect(sent[0]).toEqual({ meta_pixel_id: '744598038086701', meta_ad_account_id: 'act_1234567890123', meta_capi_token: 'EAAGood' });
  await expect(page.locator('#cfgMetaCapiToken')).toHaveValue('');
  expect(await page.evaluate(() => clientRecord.meta_ad_account_id)).toBe('1234567890123');
});

test('a token Meta can\'t parse: the error is shown, nothing says Saved', async ({ page }) => {
  await boot(page, { status: 400, json: { error: 'Meta says this token isn\'t valid (Invalid OAuth access token - Cannot parse access token). Copy the whole token again.' } });
  await page.evaluate(() => window.saveMetaCapiConfig());
  await expect(page.locator('#saveMetaCapiMsg')).toContainText('Error: Meta says this token isn\'t valid');
  await expect(page.locator('#saveMetaCapiMsg')).toHaveClass(/err/);
});

test('saved, but the saved token is broken or lacks ads_read: warned in red', async ({ page }) => {
  await boot(page, { json: { ok: true, meta_ad_account_id: '1234567890123', check: { invalid: true, error: 'Meta says this token isn\'t valid (Cannot parse access token).' } } });
  await page.evaluate(() => window.saveMetaCapiConfig());
  await expect(page.locator('#saveMetaCapiMsg')).toContainText('⚠️ Meta says this token isn\'t valid');
  await expect(page.locator('#saveMetaCapiMsg')).toHaveClass(/err/);
});
