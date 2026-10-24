// Razorpay (INR) subscriptions on the customer Billing page, and the admin billing console
// (Billing / Plans / API & Webhooks tabs). Same hermetic file:// setup as team-invite.spec.js —
// every Worker call is answered by a stub, everything else is blocked.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');
const adminUrl = 'file://' + path.resolve(__dirname, '../admin.html');
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';

async function stub(page, worker = () => null) {
  const calls = [];
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url.startsWith(WORKER)) {
      const u = new URL(url);
      const body = req.postData() ? JSON.parse(req.postData()) : null;
      calls.push({ path: u.pathname, search: u.search, method: req.method(), body });
      const res = worker(u.pathname, body, req.method(), u);
      if (res) return route.fulfill(res);
      return route.fulfill({ json: { ok: true } });
    }
    return route.abort();
  });
  return calls;
}

const RZP_PLANS = [
  { plan_id: 'plan_basic', name: 'Basic', amount: 99900, currency: 'INR', period: 'monthly', interval_count: 1, plan_tier: 'basic' },
  { plan_id: 'plan_bi', name: 'Business Intelligence', amount: 499900, currency: 'INR', period: 'monthly', interval_count: 1, plan_tier: 'business_intelligence' },
];
const STRIPE_PLANS = [
  { price_id: 'price_inr', name: 'Basic', unit_amount: 99900, currency: 'inr', interval: 'month', interval_count: 1 },
  { price_id: 'price_aed', name: 'Basic', unit_amount: 4900, currency: 'aed', interval: 'month', interval_count: 1 },
];

async function openBilling(page, record) {
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate((rec) => {
    try { localStorage.setItem('lv_billing_currency', 'INR'); } catch (e) {}
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    document.getElementById('pageBilling').classList.remove('hidden');
    // @ts-ignore
    clientId = 7; clientRecord = rec; sessionToken = 't'; myEmail = 'owner@acme.in'; _billingCurrency = 'INR';
    // @ts-ignore
    billingInit();
  }, record);
}

test('Indian customer sees the same plans via Razorpay and subscribes', async ({ page }) => {
  const calls = await stub(page, (p) => {
    if (p === '/billing/plans') return { json: { ok: true, plans: STRIPE_PLANS } };
    if (p === '/billing/razorpay/plans') return { json: { ok: true, enabled: true, trial_days: 15, plans: RZP_PLANS } };
    if (p === '/billing/razorpay/subscribe') return { json: { ok: true, url: 'https://rzp.io/i/abc', subscription_id: 'sub_1' } };
    if (p === '/billing/plan-status') return { json: { ok: true, plan_label: 'Legacy', is_legacy: true, limits: null, usage: { users: 1, channels: 1 }, modules: {} } };
    return null;
  });
  await page.route('https://rzp.io/**', (route) => route.fulfill({ contentType: 'text/html', body: '<p>razorpay</p>' }));
  await openBilling(page, { Id: 7, authentik_email: 'owner@acme.in', billing_email: 'billing@acme.in' });
  const wrap = page.locator('#billingPricingTableWrap');
  await expect(wrap).toContainText('UPI AutoPay');
  await expect(wrap).toContainText('15-day free trial');
  // The currency toggle lives in the plan picker; the old Add-ons card is gone.
  await expect(page.locator('#billingNoPlan #billingCurrencyToggle button')).toHaveCount(2);
  await expect(page.locator('#pageBilling')).not.toContainText('Add-ons');
  await expect(wrap).toContainText('Business Intelligence');
  await expect(wrap).toContainText('₹4,999.00/month');

  // Switching to Stripe for INR shows the Stripe price list, and back.
  await wrap.getByText('Pay with Stripe').click();
  await expect(wrap).not.toContainText('UPI AutoPay');
  await wrap.getByText('Razorpay').click();
  await expect(wrap).toContainText('UPI AutoPay');

  await wrap.locator('.card', { hasText: 'Business Intelligence' }).getByRole('button', { name: 'Subscribe' }).click();
  await page.waitForURL('https://rzp.io/i/abc');
  expect(calls.find((c) => c.path === '/billing/razorpay/subscribe').body).toEqual({ plan_id: 'plan_bi' });
});

const OVERVIEW = {
  ok: true,
  summary: { total: 3, by_status: {}, by_provider: {}, mrr: { INR: 99900, AED: 4900 }, trialing: 1, at_risk: 1, cancel_scheduled: 0, renewing_7d: 1, paying: 2 },
  gateways: { stripe: true, razorpay: true, razorpay_mode: 'test' },
  razorpay_plans: [{ ...RZP_PLANS[0], active: true, stripe_price_id: 'price_inr', sort_order: 0 }, { ...RZP_PLANS[1], active: true, stripe_price_id: '', sort_order: 1 }],
  stripe_plans: STRIPE_PLANS,
  clients: [
    { Id: 7, client_name: 'Acme', billing_email: 'billing@acme.in', provider: 'razorpay', plan_tier: 'basic', plan_name: 'Basic', plan_status: 'active', plan_renews_at: '2026-11-01T00:00:00Z', razorpay_subscription_id: 'sub_1', razorpay_status: 'active', razorpay_plan_id: 'plan_basic', amount: 99900, currency: 'INR', period: 'monthly', interval_count: 1, mrr: 99900, wa_credits_balance: 0 },
    { Id: 8, client_name: 'Dubai Co', authentik_email: 'd@dubai.ae', provider: 'stripe', plan_name: 'Basic', plan_status: 'past_due', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_s', amount: 4900, currency: 'AED', mrr: 4900, wa_credits_balance: 10 },
    { Id: 9, client_name: 'Legacy Ltd', provider: '', plan_status: '', wa_credits_balance: 0 },
  ],
};

async function adminLogin(page, worker) {
  const calls = await stub(page, (p, body, method, u) => {
    if (p === '/admin/login') return { json: { session_token: 'adm' } };
    if (p.startsWith('/admin/nocodb/')) return { json: { list: [] } };
    return worker(p, body, method, u);
  });
  await page.goto(adminUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#f-token').fill('pass');
  await page.locator('#btn-connect').click();
  await expect(page.locator('#header')).toBeVisible();
  return calls;
}

test('admin billing console: KPIs, filters, manage a Razorpay subscription, manual plan', async ({ page }) => {
  const calls = await adminLogin(page, (p) => {
    if (p === '/admin/billing/overview') return { json: OVERVIEW };
    if (p === '/admin/billing/events') return { json: { ok: true, events: [{ created_at: '2026-10-10T10:00:00Z', provider: 'razorpay', event_type: 'subscription.charged', amount: 99900, currency: 'INR', status: 'active' }] } };
    if (p === '/admin/razorpay/subscription') return { json: { ok: true, subscription: { status: 'paused' } } };
    if (p === '/admin/billing/manual-plan') return { json: { ok: true, patch: { plan_tier: 'standard' }, gateway_live: false } };
    return null;
  });
  await page.locator('#tab-billing').click();
  await expect(page.locator('#bill-kpis')).toContainText('MRR (INR)');
  await expect(page.locator('#bill-kpis')).toContainText('₹999');
  await expect(page.locator('#bill-kpis')).toContainText('Razorpay test mode');
  await expect(page.locator('#billing-tbody tr')).toHaveCount(3);

  await page.locator('#bill-provider').selectOption('stripe');
  await expect(page.locator('#billing-tbody tr')).toHaveCount(1);
  await expect(page.locator('#billing-tbody')).toContainText('Dubai Co');
  await page.locator('#bill-provider').selectOption('');
  await page.locator('#bill-status').selectOption('none');
  await expect(page.locator('#billing-tbody')).toContainText('Legacy Ltd');
  await page.locator('#bill-status').selectOption('');

  await page.locator('#billing-row-7').getByRole('button', { name: 'Manage' }).click();
  await expect(page.locator('#bill-overlay')).toBeVisible();
  await expect(page.locator('#bm-events')).toContainText('subscription.charged');
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: '⏸ Pause' }).click();
  await expect.poll(() => calls.find((c) => c.path === '/admin/razorpay/subscription')?.body).toEqual({ client_id: 7, action: 'pause' });
  // The modal re-renders with fresh data after the action.
  await expect.poll(() => calls.filter((c) => c.path === '/admin/billing/overview').length).toBe(2);
  await expect.poll(() => calls.filter((c) => c.path === '/admin/billing/events').length).toBe(2);

  await page.locator('#bm-tier').selectOption('standard');
  await page.locator('#bm-note').fill('NEFT UTR 123');
  page.once('dialog', (d) => d.accept());
  await page.locator('#bill-overlay').getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => calls.find((c) => c.path === '/admin/billing/manual-plan')?.body?.plan_tier).toBe('standard');
  expect(calls.find((c) => c.path === '/admin/billing/manual-plan').body.note).toBe('NEFT UTR 123');
});

test('admin plans tab imports Stripe plans; API tab shows secrets and webhook URLs', async ({ page }) => {
  let imported = false;
  const calls = await adminLogin(page, (p, body, method) => {
    if (p === '/admin/billing/overview') return { json: OVERVIEW };
    if (p === '/admin/razorpay/plans' && method === 'GET') return { json: { ok: true, configured: true, mode: 'test', plans: imported ? OVERVIEW.razorpay_plans : [] } };
    if (p === '/admin/razorpay/plans/import-stripe') { imported = true; return { json: { ok: true, created: OVERVIEW.razorpay_plans, skipped: [], stripe_inr_prices: 2 } }; }
    if (p === '/admin/api-status') return { json: { ok: true, checked_at: '2026-10-17T10:00:00Z', services: [
      { key: 'razorpay', name: 'Razorpay (India)', configured: true, mode: 'test', secrets: { RAZORPAY_KEY_ID: true, RAZORPAY_WEBHOOK_SECRET: false }, check: { ok: true, ms: 120 }, webhook: { url: `${WORKER}/billing/razorpay/webhook`, events: ['subscription.charged'] }, last_event: null },
    ] } };
    if (p === '/admin/billing/events') return { json: { ok: true, events: [] } };
    return null;
  });
  await page.locator('#tab-plans').click();
  await expect(page.locator('#rzp-plans-note')).toContainText('Import from Stripe');
  await expect(page.locator('#stripe-plans-tbody')).toContainText('not yet');
  page.on('dialog', (d) => d.accept());
  await page.locator('#rzp-import').click();
  await expect(page.locator('#rzp-plans-tbody tr')).toHaveCount(2);
  await expect(page.locator('#stripe-plans-tbody')).toContainText('✅ plan_basic');
  expect(calls.some((c) => c.path === '/admin/razorpay/plans/import-stripe')).toBe(true);

  await page.locator('#tab-api').click();
  await expect(page.locator('#api-services')).toContainText('✓ reachable · 120 ms');
  await expect(page.locator('#api-services .secret.missing')).toHaveText('✕ RAZORPAY_WEBHOOK_SECRET');
  await expect(page.locator('#api-services')).toContainText('/billing/razorpay/webhook');
  await expect(page.locator('#search-input')).toBeHidden();
});

test('failing Stripe customer gets a Switch to Razorpay option', async ({ page }) => {
  const record = { Id: 7, authentik_email: 'owner@acme.in', billing_email: 'billing@acme.in', stripe_subscription_id: 'sub_s',
    stripe_customer_id: 'cus_1', plan_status: 'unpaid', plan_name: 'Basic', plan_renews_at: new Date(Date.now() + 27 * 86400000).toISOString() };
  const calls = await stub(page, (p) => {
    if (p === '/billing/razorpay/plans') return { json: { ok: true, enabled: true, trial_days: 15, plans: RZP_PLANS } };
    if (p === '/billing/razorpay/subscribe') return { json: { ok: true, url: 'https://rzp.io/i/sw', subscription_id: 'sub_r', trial_days: 0 } };
    if (p === '/billing/plan-status') return { json: { ok: true, plan_label: 'Legacy', is_legacy: true, limits: null, usage: { users: 1, channels: 1 }, modules: {} } };
    return null;
  });
  await page.route('https://rzp.io/**', (route) => route.fulfill({ contentType: 'text/html', body: '<p>razorpay</p>' }));
  await openBilling(page, record);
  await expect(page.locator('#billingPastDueBanner')).toBeVisible();
  await expect(page.locator('#billingPortalBtn')).toBeVisible();
  const box = page.locator('#billingRzpSwitch');
  await expect(box).toBeVisible();
  await expect(box).toContainText('never charged twice');
  await expect(box).not.toContainText('Pay with Stripe');
  await box.locator('.card', { hasText: 'Business Intelligence' }).getByRole('button', { name: 'Switch to this plan' }).click();
  await page.waitForURL('https://rzp.io/i/sw');
  expect(calls.find((c) => c.path === '/billing/razorpay/subscribe').body).toEqual({ plan_id: 'plan_bi' });
});

test('healthy Stripe customer does not see the switch option', async ({ page }) => {
  await stub(page, (p) => p === '/billing/razorpay/plans' ? { json: { ok: true, enabled: true, plans: RZP_PLANS } } : null);
  await openBilling(page, { Id: 7, billing_email: 'b@a.in', stripe_subscription_id: 'sub_s', plan_status: 'active', plan_name: 'Basic' });
  await expect(page.locator('#billingHasPlan')).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.locator('#billingRzpSwitch')).toBeHidden();
});
