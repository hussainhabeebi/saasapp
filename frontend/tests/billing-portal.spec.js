// Customer Billing page sections (billing-portal.js): plan summary, plan & usage meters, compare
// plans + change, payment method, invoices, history, cancel-with-reason, GST details, help, and
// the phone action bar. Hermetic file:// setup like billing-razorpay.spec.js.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString();

const TIERS = [
  { key: 'basic', label: 'Basic', max_users: 1, max_channels: 1, modules: [], prices: { INR: { amount: 99900, currency: 'INR', period: 'monthly', interval_count: 1, gateway: 'razorpay', id: 'plan_basic' }, AED: { amount: 4900, currency: 'AED', period: 'monthly', interval_count: 1, gateway: 'stripe', id: 'price_b_aed' } } },
  { key: 'standard', label: 'Standard', max_users: 3, max_channels: 2, modules: ['Appointment Booking'], prices: { INR: { amount: 199900, currency: 'INR', period: 'monthly', interval_count: 1, gateway: 'razorpay', id: 'plan_std' }, AED: { amount: 9900, currency: 'AED', period: 'monthly', interval_count: 1, gateway: 'stripe', id: 'price_s_aed' } } },
  { key: 'marketing_pro', label: 'Enterprise', max_users: 15, max_channels: 10, modules: ['Appointment Booking', 'Travel Agency'], prices: {} },
];
function overview(extra = {}) {
  return { ok: true, provider: 'razorpay', status: 'active', status_info: { label: 'Active', tone: 'ok' }, has_plan: true,
    plan: { name: 'Basic', tier: 'basic', tier_label: 'Basic', amount: 99900, currency: 'INR', period: 'monthly', interval_count: 1 },
    renews_at: inDays(10), cancel_at_period_end: false, trial_end: null, payment_method: { type: 'upi', gateway: 'razorpay' },
    tiers: TIERS, gst: { gstin: '', billing_state: '' }, support: { email: 'help@leadvyne.com', whatsapp: '919800000000' }, ...extra };
}
const RZP_RECORD = { Id: 7, client_name: 'Acme', authentik_email: 'owner@acme.in', billing_email: 'billing@acme.in', billing_provider: 'razorpay',
  razorpay_subscription_id: 'sub_1', razorpay_status: 'active', razorpay_plan_id: 'plan_basic', plan_name: 'Basic', plan_tier: 'basic',
  plan_status: 'active', plan_renews_at: inDays(10) };

async function setup(page, record, handler = () => null, { mobile = false } = {}) {
  if (mobile) await page.setViewportSize({ width: 390, height: 800 });
  const calls = [];
  let rec = { ...record };
  await page.route('**/*', async (route) => {
    const req = route.request(), url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (!url.startsWith(WORKER)) return route.abort();
    const p = new URL(url).pathname, body = req.postData() ? JSON.parse(req.postData()) : null;
    calls.push({ path: p, body });
    const r = handler(p, body, rec, (patch) => { rec = { ...rec, ...patch }; });
    if (r) return route.fulfill(r);
    if (p === '/session/me') return route.fulfill({ json: { client: rec } });
    if (p === '/billing/plan-status') return route.fulfill({ json: { ok: true, plan_label: 'Basic', is_legacy: false, limits: { max_users: 1, max_channels: 2 }, usage: { users: 1, channels: 1 }, modules: {} } });
    if (p === '/billing/portal/invoices') return route.fulfill({ json: { ok: true, invoices: [{ gateway: 'razorpay', id: 'inv_1', number: 'INV-001', date: 1760000000, amount: 99900, currency: 'INR', status: 'paid', url: 'https://rzp.io/inv/1', pdf: '' }] } });
    if (p === '/billing/portal/history') return route.fulfill({ json: { ok: true, events: [{ date: '2026-10-01T00:00:00Z', title: 'Payment received', tone: 'ok', amount: 99900, currency: 'INR', gateway: 'razorpay' }] } });
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate((r) => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    document.getElementById('pageBilling').classList.remove('hidden');
    // @ts-ignore
    clientId = 7; clientRecord = r; sessionToken = 't'; myEmail = 'owner@acme.in'; _billingCurrency = 'INR';
    // @ts-ignore
    billingInit();
  }, record);
  return calls;
}

test('plan summary, usage meters, invoices, history and help for a Razorpay customer', async ({ page }) => {
  await setup(page, RZP_RECORD, (p) => p === '/billing/portal/overview' ? { json: overview() } : null);
  await expect(page.locator('#billingPlanName')).toHaveText('Basic');
  await expect(page.locator('#billingPlanPrice')).toHaveText('₹999/month');
  await expect(page.locator('#billingStatusBadge')).toHaveText('Active');
  await expect(page.locator('#billingPaidVia')).toHaveText('UPI AutoPay');
  await expect(page.locator('#billingBilledTo')).toHaveText('billing@acme.in');
  await expect(page.locator('#billingPortalBtn')).toBeHidden();
  await expect(page.locator('#planUsageUsers')).toHaveText('1 of 1');
  await expect(page.locator('#planUsageUsersBar')).toHaveClass('bad');
  await expect(page.locator('#planLimitNote')).toContainText("reached your plan's limit for users");
  await expect(page.locator('#billingInvoices')).toContainText('INV-001');
  await expect(page.locator('#billingInvoices')).toContainText('₹999.00');
  await expect(page.locator('#billingHistory')).toContainText('Payment received');
  await expect(page.locator('#billingPmTitle')).toHaveText('UPI AutoPay');
  await expect(page.locator('#billingHelpContacts a').first()).toHaveAttribute('href', /wa\.me\/919800000000/);
  await expect(page.locator('#billingHelpContacts')).toContainText('help@leadvyne.com');
  await expect(page.locator('#pageBilling')).not.toContainText('price_');
});

test('compare plans: current plan marked, upgrade now via Razorpay, unpriced tier says talk to us', async ({ page }) => {
  const calls = await setup(page, RZP_RECORD, (p, body) => {
    if (p === '/billing/portal/overview') return { json: overview() };
    if (p === '/billing/razorpay/change-plan') return { json: { ok: true, scheduled: false } };
    return null;
  });
  const cards = page.locator('#billingCompare .bp-tier');
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toContainText('Your plan');
  await expect(cards.nth(0).getByRole('button')).toHaveText('Current plan');
  await expect(cards.nth(1)).toContainText('₹1,999');
  await expect(cards.nth(2).getByRole('button')).toHaveText('Talk to us');
  page.once('dialog', (d) => d.accept());
  await cards.nth(1).getByRole('button', { name: 'Upgrade' }).click();
  await expect(page.locator('#billingActionMsg')).toContainText("you're now on Standard");
  expect(calls.find((c) => c.path === '/billing/razorpay/change-plan').body).toEqual({ plan_id: 'plan_std', when: 'now' });
});

test('Stripe customer: card expiring warning, change plan goes to the Stripe confirm page', async ({ page }) => {
  const rec = { Id: 7, billing_email: 'b@a.ae', billing_provider: 'stripe', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_s', plan_name: 'price_1Tq7Ch', plan_status: 'active', plan_tier: 'basic', plan_renews_at: inDays(20) };
  const now = new Date();
  const calls = await setup(page, rec, (p) => {
    if (p === '/billing/portal/overview') return { json: overview({ provider: 'stripe', plan: { name: 'Basic', tier: 'basic', tier_label: 'Basic', amount: 4900, currency: 'AED', period: 'monthly', interval_count: 1 },
      payment_method: { type: 'card', brand: 'visa', last4: '4242', exp_month: now.getUTCMonth() + 1, exp_year: now.getUTCFullYear(), expiring_soon: true, gateway: 'stripe' } }) };
    if (p === '/billing/portal/stripe-change') return { json: { ok: true, url: 'https://billing.stripe.com/confirm' } };
    return null;
  });
  await page.route('https://billing.stripe.com/**', (r) => r.fulfill({ contentType: 'text/html', body: 'stripe' }));
  await expect(page.locator('#billingPlanName')).toHaveText('Basic');
  await expect(page.locator('#billingPaidVia')).toHaveText('Visa •••• 4242');
  await expect(page.locator('#billingCardWarn')).toBeVisible();
  await expect(page.locator('#billingPortalBtn')).toBeVisible();
  await expect(page.locator('#billingCompare .bp-tier').nth(1)).toContainText('AED 99');
  await page.locator('#billingCompare .bp-tier').nth(1).getByRole('button', { name: 'Upgrade' }).click();
  await page.waitForURL('https://billing.stripe.com/confirm');
  expect(calls.find((c) => c.path === '/billing/portal/stripe-change').body).toEqual({ price_id: 'price_s_aed' });
});

test('cancel asks for a reason, offers a cheaper plan, then cancels at period end', async ({ page }) => {
  const rec = { ...RZP_RECORD, razorpay_plan_id: 'plan_std', plan_tier: 'standard', plan_name: 'Standard' };
  const calls = await setup(page, rec, (p, body, cur, patch) => {
    if (p === '/billing/portal/overview') return { json: overview({ plan: { name: 'Standard', tier: 'standard', tier_label: 'Standard', amount: 199900, currency: 'INR', period: 'monthly', interval_count: 1 } }) };
    if (p === '/billing/razorpay/cancel') { patch({ plan_cancel_at_period_end: 'Yes' }); return { json: { ok: true, status: 'active', at_cycle_end: true } }; }
    return null;
  });
  await page.locator('#billingCancelBtn').click();
  const modal = page.locator('#billingCancelModal');
  await expect(modal).toBeVisible();
  await expect(page.locator('#billingCancelConfirm')).toBeDisabled();
  await modal.getByText('Too expensive').click();
  await expect(page.locator('#billingCancelAlt')).toContainText('Basic costs less');
  await page.locator('#billingCancelDetail').fill('Budget cut');
  await page.locator('#billingCancelConfirm').click();
  await expect(modal).toBeHidden();
  await expect(page.locator('#billingCancelBanner')).toBeVisible();
  await expect(page.locator('#billingActionMsg')).toContainText("won't be charged again");
  expect(calls.find((c) => c.path === '/billing/portal/cancel-feedback').body).toEqual({ reason: 'too_expensive', detail: 'Budget cut', outcome: 'cancelled' });
  expect(calls.find((c) => c.path === '/billing/razorpay/cancel').body).toEqual({ at_cycle_end: true });
});

test('GST details: state fills from the GSTIN, bad GSTIN is caught before saving', async ({ page }) => {
  const calls = await setup(page, RZP_RECORD, (p) => p === '/billing/portal/overview' ? { json: overview() } : null);
  await page.locator('#cfgGstin').fill('32abcde1234f1z5');
  await expect(page.locator('#cfgBillingState')).toHaveValue('Kerala');
  await page.getByRole('button', { name: 'Save details' }).click();
  await expect(page.locator('#companyProfileMsg')).toHaveText('Saved.');
  expect(calls.find((c) => c.path === '/billing/company-profile').body).toMatchObject({ gstin: '32ABCDE1234F1Z5', billing_state: 'Kerala', billing_email: 'billing@acme.in' });
  await page.locator('#cfgGstin').fill('12345');
  await page.getByRole('button', { name: 'Save details' }).click();
  await expect(page.locator('#companyProfileMsg')).toContainText("GSTIN doesn't look right");
});

test('phone: sticky action bar shows Fix payment for a failed payment', async ({ page }) => {
  const rec = { ...RZP_RECORD, plan_status: 'past_due', razorpay_status: 'pending' };
  await setup(page, rec, (p) => p === '/billing/portal/overview' ? { json: overview({ status: 'past_due', status_info: { label: 'Payment retrying', tone: 'warn' } }) } : null, { mobile: true });
  await expect(page.locator('#billingStatusBadge')).toHaveText('Payment retrying');
  await expect(page.locator('#billingPastDueBanner')).toBeVisible();
  await expect(page.locator('#billingStickyCta')).toBeVisible();
  await expect(page.locator('#billingStickyBtn')).toHaveText('Fix payment');
});

test('no plan: compare plans lets a new customer choose, sticky says Choose a plan on phones', async ({ page }) => {
  const calls = await setup(page, { Id: 7, billing_email: 'b@a.in' }, (p) => {
    if (p === '/billing/portal/overview') return { json: overview({ provider: '', status: '', has_plan: false, status_info: { label: 'No plan', tone: 'off' }, plan: { name: '', tier: '', tier_label: 'Legacy' }, payment_method: null }) };
    if (p === '/billing/razorpay/plans') return { json: { ok: true, enabled: true, plans: [] } };
    if (p === '/billing/plans') return { json: { ok: true, plans: [] } };
    if (p === '/billing/razorpay/subscribe') return { json: { ok: true, url: 'https://rzp.io/i/new', subscription_id: 'sub_n' } };
    return null;
  }, { mobile: true });
  await page.route('https://rzp.io/**', (r) => r.fulfill({ contentType: 'text/html', body: 'rzp' }));
  await expect(page.locator('#billingNoPlan')).toBeVisible();
  await expect(page.locator('#billingStickyBtn')).toHaveText('Choose a plan');
  await expect(page.locator('#billingPaymentCard')).toBeHidden();
  await page.locator('#billingCompare .bp-tier').nth(1).getByRole('button', { name: 'Choose' }).click();
  await page.waitForURL('https://rzp.io/i/new');
  expect(calls.find((c) => c.path === '/billing/razorpay/subscribe').body).toEqual({ plan_id: 'plan_std' });
});
