// Hospitality Pro sub-tab (🏨 Hospitality → ⭐ Pro, frontend/hospitality-pro.js). Same hermetic
// file:// setup as meetings.spec.js — the Worker's /hospitality/* routes are answered by page.route
// stubs, everything else off-origin is blocked.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';

const SETTINGS = {
  config: {
    features: { quote: true, tour_first: true, addons: true, loyalty: true, registration: true, recovery: false, groups: true },
    hold_minutes: 30, deposit_pct: 25, payment_mode: 'manual', payment_instructions: 'UPI: resort@okhdfc',
    loyalty: { silver_pct: 5, gold_pct: 10, platinum_pct: 15 }, group_min_guests: 10, recovery_hours: [2, 20],
    quiet_start: 21, quiet_end: 8, tz_offset_min: 330, registration_message: '',
  },
  razorpay_connected: false, razorpay_webhook_ready: false, razorpay_key_id: '',
};
const OVERVIEW = { holds_active: 1, holds_awaiting: 2, holds_conflict: 0, bookings_30d: 4, revenue_30d: 58000, addons_30d: 7500, loyalty_given_30d: 900,
  recovery_active: 3, recovery_nudged_30d: 6, recovery_recovered_30d: 2, groups_open: 1, groups_30d: 2, registrations_pending: 1, registrations_received: 3 };
const HOLDS = [{ id: 11, unit_id: 1, unit_name: 'Lake View Villa', guest_name: 'Asha K', guest_phone: '919847000001', check_in: '2026-12-12', check_out: '2026-12-14',
  adults: 2, children: 0, total_amount: 14500, deposit_amount: 3625, discount_amount: 0, discount_label: '', currency: 'INR', addons_json: '[{"id":1,"name":"Candlelight Dinner","amount":2500}]',
  status: 'payment_claimed', expires_at: '2026-10-03T07:00:00Z', payment_ref: null, payment_url: null, booking_id: null }];

async function openHospitality(page, client) {
  const calls = [];
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url.startsWith(WORKER + '/hospitality/')) {
      const p = new URL(url).pathname;
      const body = req.postData() ? JSON.parse(req.postData()) : null;
      calls.push({ path: p, method: req.method(), body });
      if (p === '/hospitality/units') return route.fulfill({ json: { list: [{ Id: 1, id: 1, name: 'Lake View Villa' }] } });
      if (p === '/hospitality/bookings' || p === '/hospitality/properties') return route.fulfill({ json: { list: [] } });
      if (p === '/hospitality/stats') return route.fulfill({ json: { total_units: 1, occupancy_rate: 0, revenue_this_month: 0, upcoming_check_ins: [], upcoming_check_outs: [] } });
      if (p === '/hospitality/pro/overview') return route.fulfill({ json: OVERVIEW });
      if (p === '/hospitality/pro/settings' && req.method() === 'GET') return route.fulfill({ json: SETTINGS });
      if (p === '/hospitality/pro/settings') return route.fulfill({ json: { ok: true, config: body.config, razorpay_connected: false } });
      if (p === '/hospitality/pro/holds') return route.fulfill({ json: { list: HOLDS } });
      if (p === '/hospitality/pro/holds/confirm') return route.fulfill({ json: { ok: true, booking_id: 99 } });
    }
    return route.abort();
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate((rec) => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    document.getElementById('pageHospitality').classList.remove('hidden');
    // @ts-ignore
    clientId = 7; clientRecord = rec; sessionToken = 't';
    // @ts-ignore
    renderHospitality();
  }, client);
  return calls;
}

test('Pro tab stays hidden and is never called for clients without Pro', async ({ page }) => {
  const calls = await openHospitality(page, { Id: 7, hospitality_enabled: 'Yes', hospitality_style: 'resort' });
  await expect(page.locator('#hospContent .stat').first()).toBeVisible();
  await expect(page.locator('#hospProTab')).toBeHidden();
  expect(calls.some((c) => c.path.startsWith('/hospitality/pro/'))).toBe(false);
});

test('Pro overview, verify a paid hold, and save settings', async ({ page }) => {
  page.on('dialog', (d) => d.accept('UPI 4711'));
  const calls = await openHospitality(page, { Id: 7, hospitality_enabled: 'Yes', hospitality_pro_enabled: 'Yes' });
  await expect(page.locator('#hospProTab')).toBeVisible();
  await page.locator('#hospProTab').click();

  await expect(page.locator('#hpBody')).toContainText('Bookings via Pro (30d)');
  await expect(page.locator('#hpBody')).toContainText('₹58,000');
  await expect(page.locator('#hpBody')).toContainText('2 guests say they have paid');
  await expect(page.locator('#hpBody .hp-feat').filter({ hasText: 'Abandoned-inquiry recovery' })).toContainText('OFF');

  await page.locator('.hp-chip', { hasText: 'Holds' }).click();
  await expect(page.locator('#hpBody')).toContainText('Lake View Villa');
  await expect(page.locator('#hpBody')).toContainText('+ Candlelight Dinner');
  await expect(page.locator('#hpBody')).toContainText('Says paid');
  await page.getByRole('button', { name: '✓ Confirm' }).click();
  await expect.poll(() => calls.find((c) => c.path === '/hospitality/pro/holds/confirm')?.body).toEqual({ id: 11, payment_ref: 'UPI 4711' });

  await page.locator('.hp-chip', { hasText: 'Settings' }).click();
  await page.locator('#hpDeposit').fill('50');
  await page.locator('.hp-feat-cb[data-k="recovery"]').check();
  await page.locator('#hpRecHours').fill('3, 18');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect.poll(() => calls.find((c) => c.path === '/hospitality/pro/settings' && c.method === 'PATCH')?.body?.config).toMatchObject({
    deposit_pct: 50, recovery_hours: [3, 18], payment_instructions: 'UPI: resort@okhdfc', features: { recovery: true, quote: true },
  });
});
