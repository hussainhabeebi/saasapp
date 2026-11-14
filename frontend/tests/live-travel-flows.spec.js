// Live Agency → ⚙️ Travel Settings → 🧩 Flows: AI-first booking flows (worker /live-travel/flows).
// Hermetic file:// load; the worker API is stubbed.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pageUrl = 'file://' + path.resolve(__dirname, '../live-travel-agency.html') + '?client=7&token=t';
const bootstrap = { suppliers: [], searches: [], quotes: [], bookings: [], service_requests: [], wallet: [], wallet_entries: [], agents: [], commissions: [], currency_settings: { default_currency: 'AED' }, supported_currencies: [] };
const visa = { id: 'fvisa', name: 'Visa enquiry', status: 'draft', version: 1, note: '', trigger: { type: 'keyword', keywords: ['tourist visa'], package_ids: [], when: 'any' },
  steps: [{ id: 's1', type: 'ask_custom', enabled: true, required: true, label: 'Visa country', question: 'Which country?', options: [] }, { id: 's2', type: 'handover', enabled: true, message: '' }] };
const flowsPayload = (flows) => ({ enabled: true, flows, stats: { fvisa: { started: 4, handed_over: 2, side_answers: 3 } },
  packages: [{ id: '1', name: 'GEORGIA SPECIAL', keywords: '', destination: 'Tbilisi', price: 1500, currency: 'AED' }],
  templates: [{ key: 'visa', name: 'Visa enquiry', description: 'Country, nationality…', flow: visa }], payment_qrs: 0, handover_enabled: true });

test('flows: list with stats, edit, test chat with the real preview endpoint, publish', async ({ page }) => {
  let flows = [visa], saved = null, preview = null;
  await page.route('**/*', async (route) => {
    const req = route.request(), url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url.endsWith('/live-travel/bootstrap')) return route.fulfill({ json: bootstrap });
    if (url.endsWith('/live-travel/flows')) return route.fulfill({ json: flowsPayload(flows) });
    if (url.endsWith('/live-travel/flows/save')) {
      saved = JSON.parse(req.postData()).flow;
      flows = [saved];
      return route.fulfill({ json: { flow: saved, errors: [], warnings: [] } });
    }
    if (url.endsWith('/live-travel/flows/preview')) {
      preview = JSON.parse(req.postData());
      return route.fulfill({ json: { action: 'continue', lead: '', outputs: [], question: 'Which country do you need the visa for?', options: ['UAE', 'Georgia'], state: { s: 1 }, collected: { travel_flow: 'Visa enquiry' } } });
    }
    return route.abort();
  });
  await page.goto(pageUrl);
  await page.getByRole('button', { name: '⚙️ Travel Settings' }).click();
  await page.getByRole('button', { name: '🧩 Flows' }).click();
  await expect(page.getByText('Use flows for this account')).toBeVisible();
  await expect(page.getByText('Visa enquiry')).toBeVisible();
  await expect(page.getByText(/Started 4/)).toBeVisible();

  await page.getByRole('button', { name: 'Edit' }).click();
  await page.locator('#tfIn').fill('I need a tourist visa');
  await page.locator('#tfIn').press('Enter');
  await expect(page.locator('#tfChat')).toContainText('Which country do you need the visa for?');
  expect(preview.flow.id).toBe('fvisa');
  expect(preview.state).toBeNull();
  // An option chip sends that option as the next message, with the state from the first turn.
  await page.locator('#tfChat .chip', { hasText: 'Georgia' }).click();
  await expect.poll(() => preview.message).toBe('Georgia');
  expect(preview.state).toEqual({ s: 1 });

  await page.getByRole('button', { name: '▶️ Publish' }).click();
  await expect(page.getByText('Published: it runs on the next matching message')).toBeVisible();
  expect(saved.status).toBe('active');
  await page.screenshot({ path: test.info().outputPath('flows-editor.png') });
});

test('flows: publishing errors from the worker are shown and nothing is marked active', async ({ page }) => {
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('file://')) return route.continue();
    if (url.endsWith('/live-travel/bootstrap')) return route.fulfill({ json: bootstrap });
    if (url.endsWith('/live-travel/flows')) return route.fulfill({ json: flowsPayload([]) });
    if (url.endsWith('/live-travel/flows/save')) return route.fulfill({ status: 400, json: { error: 'Give the flow a name.', errors: ['Give the flow a name.', 'Add at least one keyword.'], warnings: [] } });
    return route.abort();
  });
  await page.goto(pageUrl);
  await page.getByRole('button', { name: '⚙️ Travel Settings' }).click();
  await page.getByRole('button', { name: '🧩 Flows' }).click();
  await expect(page.getByText('No flows yet. Your AI bot works as usual.')).toBeVisible();
  await page.getByRole('button', { name: '＋ Create flow' }).click();
  await page.getByText('Blank flow').click();
  await page.locator('#tfAdd').selectOption('ask_city');
  await expect(page.locator('#tfSteps')).toContainText('Ask: departure city');
  await page.getByRole('button', { name: '▶️ Publish' }).click();
  await expect(page.getByText('Fix before publishing')).toBeVisible();
  await expect(page.getByText('Add at least one keyword.')).toBeVisible();
  await expect(page.locator('.badge', { hasText: 'Draft' })).toBeVisible();
});
