// Settings → Bot Behavior → Ecom Communication Style: the "Shopify / general store" style has a
// Guided shopping chat switch (bot_config.shopify_flow_enabled, on unless switched off).
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');

test('the switch shows only for the Shopify style and saves into bot_config', async ({ page }) => {
  await page.route('**/*', (route) => (route.request().url().startsWith('file://') ? route.continue() : route.abort()));
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    // @ts-ignore
    clientRecord = { authentik_email: 'boss@x.com', bot_config: JSON.stringify({ ecom_communication_style: 'shopify', quick_reply_buttons_enabled: true }) };
    // @ts-ignore
    window.__saved = []; window.patchClient = async (f) => { window.__saved.push(f); };
    document.getElementById('cfgEcomCommunicationStyle').value = 'shopify';
    document.getElementById('cfgShopifyFlowEnabled').checked = JSON.parse(clientRecord.bot_config).shopify_flow_enabled !== false;
    // @ts-ignore
    renderShopifyFlowRow();
    document.getElementById('ecomCommunicationStyleCard').scrollIntoView();
  });
  const row = page.locator('#shopifyFlowRow');
  await expect(row).toHaveCSS('display', 'flex');
  await expect(page.locator('#cfgShopifyFlowEnabled')).toBeChecked();
  await page.locator('#cfgShopifyFlowEnabled').evaluate((el) => { el.checked = false; });
  await page.locator('#saveEcomCommunicationStyle').evaluate((el) => el.click());
  await expect.poll(() => page.evaluate(() => window.__saved.length)).toBe(1);
  const saved = JSON.parse(await page.evaluate(() => window.__saved[0].bot_config));
  expect(saved).toEqual({ ecom_communication_style: 'shopify', quick_reply_buttons_enabled: true, shopify_flow_enabled: false });
  await page.locator('#cfgEcomCommunicationStyle').evaluate((el) => { el.value = 'fashion'; el.dispatchEvent(new Event('change')); });
  await expect(row).toHaveCSS('display', 'none');
});
