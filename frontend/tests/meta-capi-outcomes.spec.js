// Settings → Integrations → Meta Ads → 📤 Report to Meta: Qualified Lead / Non Qualified / Won /
// Lost each ticked on its own with a Meta standard event (or custom name); Save sends only that.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');

test('outcomes render from what the worker has saved, and save only what is ticked', async ({ page }) => {
  const sent = [];
  await page.route('**/*', (route) => (route.request().url().startsWith('file://') ? route.continue() : route.abort()));
  await page.route('**/meta/capi/status', (route) => route.fulfill({ json: { connected: true, outcomes: { qualified: { on: true, event: 'Lead' }, non_qualified: { on: true, event: 'DisqualifiedLead' }, won: { on: true, event: 'Purchase' }, lost: { on: false, event: 'LostLead' } } } }));
  await page.route('**/meta/capi/config', (route) => {
    const b = JSON.parse(route.request().postData()); sent.push(b);
    return route.fulfill({ json: { ok: true, meta_capi_outcomes: { qualified: { on: true, event: 'Lead' }, non_qualified: { on: false, event: 'DisqualifiedLead' }, won: { on: true, event: 'Purchase' }, lost: { on: true, event: 'DealLost' } } } });
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    // @ts-ignore
    clientRecord = { meta_pixel_id: '744598038086701' };
    // @ts-ignore
    loadMetaCapiStatus();
    // Show the Integrations card without logging in: unhide its ancestors.
    document.getElementById('gate')?.remove();
    for (let el = document.getElementById('metaCapiOutcomes'); el; el = el.parentElement) { el.classList.remove('hidden'); if (getComputedStyle(el).display === 'none') el.style.display = 'block'; }
  });
  const row = (k) => page.locator(`#metaCapiOutcomes [data-outcome="${k}"]`);
  await expect(row('qualified').locator('[data-role=event]')).toHaveValue('Lead');
  await expect(row('won').locator('[data-role=event]')).toHaveValue('Purchase');
  await expect(row('lost').locator('[data-role=on]')).not.toBeChecked();
  await expect(row('qualified').locator('option[value="CompleteRegistration"]')).toHaveCount(1);

  // The page sits behind the login gate here, so set the controls directly (a click would land on it).
  await page.evaluate(() => {
    const q = (k, r) => document.querySelector(`#metaCapiOutcomes [data-outcome="${k}"] [data-role=${r}]`);
    q('non_qualified', 'on').checked = false;
    q('lost', 'on').checked = true;
    const sel = q('lost', 'event'); sel.value = '__custom'; sel.dispatchEvent(new Event('change'));
    q('lost', 'custom').value = 'Deal Lost';
  });
  await expect(row('lost').locator('[data-role=custom]')).toHaveCSS('display', /^(?!none)/);
  await page.evaluate(() => window.saveMetaCapiOutcomes());
  await expect(page.locator('#saveMetaCapiOutcomesMsg')).toHaveText('✓ Saved · reporting Qualified Lead → Lead, Won → Purchase, Lost → DealLost');
  expect(sent[0]).toEqual({ meta_capi_outcomes: {
    qualified: { on: true, event: 'Lead' }, non_qualified: { on: false, event: 'DisqualifiedLead' },
    won: { on: true, event: 'Purchase' }, lost: { on: true, event: 'DealLost' } } });
  await expect(row('lost').locator('[data-role=event]')).toHaveValue('DealLost');
});
