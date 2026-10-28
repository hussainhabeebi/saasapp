// Hospitality workspace (frontend/hospitality.html + hospitality-desk.js / -suite.js). Hermetic
// file:// setup like hospitality-pro.spec.js — Worker routes are answered by page.route stubs,
// everything else off-origin is blocked.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const deskFile = 'file://' + path.resolve(__dirname, '../hospitality.html');
const deskUrl = deskFile + '?embed=1'; // the Front Desk screens run embedded in the CRM
const goTo = (page, k) => page.evaluate(k => go(k), k);
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';
const TODAY = '2026-10-03';

const UNITS = [
  { id: 1, name: 'Kayal Queen', unit_type: 'Houseboat', capacity_adults: 4, capacity_children: 2, base_rate: 8000, weekend_rate: 9000, currency: 'INR', active: 1 },
  { id: 2, name: 'Royal Palace', unit_type: 'Houseboat', capacity_adults: 6, capacity_children: 2, base_rate: 14000, weekend_rate: null, currency: 'INR', active: 1 },
];
const BOOKINGS = [
  { id: 41, unit_id: 1, guest_name: 'Anu Thomas', guest_phone: '9847000707', check_in: TODAY, check_out: '2026-10-04', adults: 2, children: 0, total_amount: 9000, deposit_amount: 2000, currency: 'INR', status: 'confirmed', notes: '' },
  { id: 42, unit_id: 2, guest_name: 'Rahul Nair', guest_phone: '9847000708', check_in: '2026-10-01', check_out: TODAY, adults: 4, children: 0, total_amount: 28000, deposit_amount: 0, currency: 'INR', status: 'checked_in', notes: '' },
  { id: 43, unit_id: 2, guest_name: 'Meera', guest_phone: '9847000709', check_in: '2026-10-06', check_out: '2026-10-08', adults: 2, children: 1, total_amount: 28000, deposit_amount: 5000, currency: 'INR', status: 'inquiry', notes: '' },
];
function bootstrap(pro) {
  return {
    client: { id: 7, name: 'Lake Resort', style: 'houseboat', pro: !!pro }, today: TODAY, tz: 330, units: UNITS, bookings: BOOKINGS,
    stats: { arrivals: 1, departures: 1, in_house: 1, occupancy_today: 50, occupancy_7: 36, revenue_month: 65000, inquiries: 1 },
    pro: pro ? { features: {}, suite: pro, holds_awaiting: 2, groups_new: 0, alerts_open: 3, tasks_open: 1, suggestions: 0, summary: null } : null,
  };
}
const MODULES = [
  { key: 'journey', label: 'Guest Journey', features: { balance_reminders: 'Balance reminders + payment links', web_checkin: 'Web check-in on WhatsApp (ETA, preferences, IDs)' } },
  { key: 'housekeeping', label: 'Housekeeping & Staff', features: { housekeeping: 'Room status board & auto cleaning tasks', staff_tasks: 'Staff tasks & maintenance tickets' } },
  { key: 'revenue', label: 'Revenue & Channels', features: { pricing_rules: 'Smart pricing suggestions' } },
];

async function openDesk(page, { pro = null, width = 1400, extra = null } = {}) {
  const calls = [];
  let suite = pro ? { ...pro } : null;
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(() => { localStorage.setItem('lv_cid', '7'); localStorage.setItem('lv_session', 'tok'); });
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url.startsWith(WORKER)) {
      const p = new URL(url).pathname;
      const body = req.postData() ? JSON.parse(req.postData()) : null;
      calls.push({ path: p, method: req.method(), body, auth: req.headers()['authorization'] });
      if (extra) { const r = extra(p, req); if (r) return route.fulfill(r); }
      if (p === '/hospitality/desk/bootstrap') return route.fulfill({ json: bootstrap(suite) });
      if (p === '/session/me') return route.fulfill({ json: { email: 'o@x.com', client: { Id: 7 } } });
      if (p === '/hospitality/desk/calendar') return route.fulfill({ json: { start: TODAY, end: '2026-10-24', bookings: BOOKINGS, blocked: [{ unit_id: 1, date: '2026-10-10', reason: 'OTA: Airbnb' }], rates: [{ unit_id: 2, date: '2026-10-09', rate: 18000 }] } });
      if (p === '/hospitality/bookings') return route.fulfill({ json: req.method() === 'GET' ? { list: BOOKINGS } : { ok: true } });
      if (p === '/hospitality/suite/settings' && req.method() === 'GET') return route.fulfill({ json: { config: { features: suite, balance_days: [7, 1], template_name: '' }, modules: MODULES, requires: { staff_bot: 'staff_tasks' } } });
      if (p === '/hospitality/suite/settings') { suite = { ...suite, ...body.config.features }; return route.fulfill({ json: { ok: true, config: { features: suite, balance_days: [7, 1] } } }); }
      if (p === '/hospitality/suite/room-status') return route.fulfill({ json: { list: [{ unit_id: 1, name: 'Kayal Queen', active: 1, status: 'dirty' }, { unit_id: 2, name: 'Royal Palace', active: 1, status: 'clean' }] } });
      if (p === '/hospitality/suite/tasks') return route.fulfill({ json: { list: [{ id: 5, kind: 'housekeeping', title: 'Clean Kayal Queen after check-out', status: 'open', priority: 'urgent', source: 'auto', unit_id: 1 }] } });
      if (p === '/hospitality/suite/staff') return route.fulfill({ json: { list: [] } });
      if (p === '/hospitality/pro/overview') return route.fulfill({ json: { holds_active: 1, holds_awaiting: 2, holds_conflict: 0, bookings_30d: 4, revenue_30d: 58000, addons_30d: 0, loyalty_given_30d: 0, recovery_active: 0, recovery_nudged_30d: 0, recovery_recovered_30d: 0, groups_open: 0, groups_30d: 0, registrations_pending: 0, registrations_received: 0 } });
      if (p === '/hospitality/pro/settings') return route.fulfill({ json: { config: { features: { quote: true, tour_first: true, addons: true, loyalty: true, registration: true, recovery: true, groups: true }, hold_minutes: 30, deposit_pct: 25, payment_mode: 'manual', payment_instructions: '', loyalty: { silver_pct: 5, gold_pct: 10, platinum_pct: 15 }, group_min_guests: 10, recovery_hours: [2, 20], quiet_start: 21, quiet_end: 8, tz_offset_min: 330 }, razorpay_connected: false } });
      return route.fulfill({ status: 404, json: { error: 'not stubbed' } });
    }
    return route.abort();
  });
  await page.goto(deskUrl, { waitUntil: 'domcontentloaded' });
  return calls;
}

test('front desk for a non-Pro hospitality client: one bootstrap call, Today, no Pro menu', async ({ page }) => {
  const calls = await openDesk(page);
  await expect(page.locator('#bizName')).toHaveText('Lake Resort');
  await expect(page.locator('.stat-val').first()).toHaveText('1');
  await expect(page.getByText('Arriving today')).toBeVisible();
  await expect(page.locator('.ni[data-k="sales"]')).toHaveCount(0);
  await expect(page.locator('.ni[data-k="housekeeping"]')).toHaveCount(0);
  await expect(page.locator('.ni[data-k="rooms"]')).toHaveText(/Boats/);
  expect(calls.filter(c => c.path === '/hospitality/desk/bootstrap')[0].auth).toBe('Bearer tok');
  // No CRM-sized libraries are loaded.
  const scripts = await page.evaluate(() => [...document.scripts].map(s => s.src).filter(Boolean));
  expect(scripts.some(s => /chart|pdf|jspdf|mammoth/i.test(s))).toBe(false);

  await page.getByRole('button', { name: 'Check in' }).click();
  await expect.poll(() => calls.find(c => c.path === '/hospitality/bookings' && c.method === 'PATCH')?.body).toEqual({ id: 41, status: 'checked_in' });

  await goTo(page, 'settings');
  await expect(page.getByText('Hospitality Pro is not switched on')).toBeVisible();
});

test('Pro client: only switched-on suite screens are in the menu; a switch adds its screen', async ({ page }) => {
  const calls = await openDesk(page, { pro: { housekeeping: true, staff_tasks: false, pricing_rules: false, balance_reminders: false, web_checkin: false } });
  await expect(page.locator('.ni[data-k="sales"]')).toHaveCount(1);
  await expect(page.locator('.ni[data-k="housekeeping"]')).toHaveCount(1);
  await expect(page.locator('.ni[data-k="pricing"]')).toHaveCount(0);
  await expect(page.locator('.ni[data-k="journey"]')).toHaveCount(0);

  await goTo(page, 'housekeeping');
  await expect(page.getByText('Clean Kayal Queen after check-out')).toBeVisible();

  await goTo(page, 'settings');
  await expect(page.getByText('Smart pricing suggestions')).toBeVisible();
  await page.locator('.feat', { hasText: 'Smart pricing suggestions' }).locator('.sw span').click();
  await expect.poll(() => calls.find(c => c.path === '/hospitality/suite/settings' && c.method === 'PATCH')?.body).toEqual({ config: { features: { pricing_rules: true } } });
  await expect(page.locator('.ni[data-k="pricing"]')).toHaveCount(1);
});

test('calendar draws bookings, blocks and special rates from one call', async ({ page }) => {
  const calls = await openDesk(page);
  await goTo(page, 'calendar');
  await expect(page.locator('.bar', { hasText: 'Anu Thomas' })).toBeVisible();
  await expect(page.locator('.bar.inquiry', { hasText: 'Meera' })).toBeVisible();
  await expect(page.locator('td.blk')).toHaveCount(1);
  await expect(page.locator('.rate.ov')).toHaveText('18000');
  expect(calls.filter(c => c.path === '/hospitality/desk/calendar')).toHaveLength(1);
});

test('new booking from the top bar posts to the existing bookings API', async ({ page }) => {
  const calls = await openDesk(page);
  await page.getByRole('button', { name: '＋ New booking' }).click();
  await page.locator('[name=guest_name]').fill('Priya');
  await page.locator('[name=guest_phone]').fill('9000000001');
  await page.locator('[name=check_out]').fill('2026-10-05');
  await page.locator('[name=check_out]').dispatchEvent('change');
  await page.getByRole('button', { name: 'Create booking' }).click();
  await expect.poll(() => calls.find(c => c.path === '/hospitality/bookings' && c.method === 'POST')?.body).toMatchObject({ guest_name: 'Priya', unit_id: 1, check_in: TODAY, check_out: '2026-10-05', total_amount: 16000 });
});

test('Direct Sales reuses the existing Hospitality Pro screens', async ({ page }) => {
  await openDesk(page, { pro: { housekeeping: false } });
  await goTo(page, 'sales');
  await expect(page.locator('.hp-chip', { hasText: 'Holds' })).toBeVisible();
});

test('phones keep the light app — hospitality.html sends them to m.html', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.addInitScript(() => { localStorage.setItem('lv_cid', '7'); localStorage.setItem('lv_session', 'tok'); });
  await page.route('**/*', route => route.request().url().startsWith('file://') ? route.continue() : route.abort());
  await page.goto(deskFile, { waitUntil: 'commit' });
  await page.waitForURL(/m\.html/);
});

test('with every feature on, every screen opens without an error', async ({ page }) => {
  const all = Object.fromEntries(['balance_reminders','refunds','web_checkin','id_scan','prearrival_upsell','stay_messages','instay_requests','fleet','cruise_plan','weather_alerts','crew','meal_preorder','pickup','maintenance',
    'ical_sync','pricing_rules','competitor_rates','daily_summary','housekeeping','staff_tasks','staff_bot','guest_profiles','feedback','review_replies','rebooking','occasions','agents','agent_quotes','allotments','commissions'].map(k => [k, true]));
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const extra = (p, req) => {
    if (!p.startsWith('/hospitality/suite/')) return null;
    if (p.endsWith('/ical')) return ({ json: { feeds: [{ id: 1, unit_id: 1, source: 'Airbnb', last_status: 'ok', events: 2, last_sync_at: '2026-10-03T05:00:00Z' }], exports: [{ unit_id: 1, name: 'Kayal Queen', path: '/hospitality/ical/abc/1.ics' }] } });
    if (p.endsWith('/weather')) return ({ json: { lat: 9.5, lng: 76.3, days: [{ date: TODAY, rain: 30, wind: 20, bad: true }] } });
    if (p.endsWith('/summary')) return ({ json: { date: TODAY, text: '📊 Sat, 3 Oct — Lake Resort' } });
    if (p.endsWith('/journey')) return ({ json: { today: TODAY, list: [{ ...BOOKINGS[0], unit_name: 'Kayal Queen', suite: { sent: { bal_7: { s: 'template', at: '2026-10-01T00:00:00Z' } }, eta: '15:00', checkin_status: 'done' }, payments: [], extras: [], id_count: 0, money: { total: 9000, received: 2000, refunded: 0, balance: 7000, currency: 'INR' } }] } });
    if (p.endsWith('/cruise')) return ({ json: { date: TODAY, list: [{ ...BOOKINGS[0], unit_name: 'Kayal Queen', suite: {}, jetty: { name: 'Finishing Point', map_url: '' }, trip_type: 'overnight', plan: [{ at: '12:00', what: 'Boarding' }], crew: [], meals: [] }] } });
    if (p.endsWith('/meals')) return ({ json: { date: TODAY, list: [] } });
    if (p.endsWith('/settings') && req.method() === 'GET') return ({ json: { config: { features: all, balance_days: [7, 1] }, modules: MODULES, requires: {} } });
    return ({ json: { list: [] } });
  };
  await openDesk(page, { pro: all, extra });
  const keys = await page.locator('.ni[data-k]').evaluateAll(els => els.map(e => e.dataset.k));
  expect(keys).toEqual(expect.arrayContaining(['journey', 'agents', 'housekeeping', 'tasks', 'cruise', 'fleet', 'meals', 'pricing', 'channels', 'competitors', 'insights', 'feedback', 'reviews', 'alerts']));
  for (const k of keys.filter(k => k !== 'chats')) {
    await goTo(page, k);
    await expect(page.locator('#view .skel')).toHaveCount(0);
    await expect(page.locator('#view')).not.toContainText("Couldn't load");
  }
  for (const [k, tab] of [['tasks', 'Staff & crew'], ['tasks', 'Crew assignment'], ['fleet', 'Jetties & cruise hours'], ['fleet', 'Fuel & maintenance'], ['fleet', 'Weather'], ['meals', 'Menu'], ['pricing', 'Rules'], ['agents', 'Bookings & commissions'], ['agents', 'Allotments']]) {
    await goTo(page, k);
    await page.locator('.tab', { hasText: tab }).click();
    await expect(page.locator('#view .skel')).toHaveCount(0);
    await expect(page.locator('#view')).not.toContainText("Couldn't load");
  }
  await goTo(page, 'journey');
  await page.getByText('Anu Thomas').click();
  await expect(page.locator('#mBody')).toContainText('Balance');
  expect(errors).toEqual([]);
});

const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');
async function openDashboard(page, { width, flag, search = '', twa = false }) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(([flag, twa]) => {
    localStorage.setItem('lv_cid', '7'); localStorage.setItem('lv_session', 'tok');
    if (flag) localStorage.setItem('lv_hosp_desk', '1');
    if (twa) sessionStorage.setItem('lv_twa', '1');
  }, [flag, twa]);
  await page.route('**/*', route => route.request().url().startsWith('file://') ? route.continue() : route.abort());
  await page.goto(dashboardUrl + search, { waitUntil: 'commit' });
}
test('the CRM is the first view on a PC — no redirect, even with the old workspace flag', async ({ page }) => {
  await openDashboard(page, { width: 1400, flag: true });
  await page.waitForLoadState('domcontentloaded');
  expect(page.url()).toMatch(/dashboard\.html$/);
});
test('hospitality.html opened on its own hands over to the CRM', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(() => { localStorage.setItem('lv_cid', '7'); localStorage.setItem('lv_session', 'tok'); });
  await page.route('**/*', route => route.request().url().startsWith('file://') ? route.continue() : route.abort());
  await page.goto(deskFile, { waitUntil: 'commit' });
  await page.waitForURL(/dashboard\.html$/);
});
test('phones still go to the light app', async ({ page }) => {
  await openDashboard(page, { width: 390, flag: true });
  await page.waitForURL(/m\.html/);
});

// ── CRM side (hospitality-view.js): 🛎️ Front Desk menu, new Home, chats inside the CRM ──
async function openCrmHome(page, { pro = null } = {}) {
  const calls = [];
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(() => { localStorage.setItem('lv_cid', '7'); localStorage.setItem('lv_session', 'tok'); });
  await page.route('**/*', async (route) => {
    const req = route.request(); const url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url.startsWith(WORKER)) {
      const p = new URL(url).pathname;
      calls.push({ path: p, method: req.method(), body: req.postData() ? JSON.parse(req.postData()) : null });
      if (p === '/hospitality/desk/bootstrap') return route.fulfill({ json: bootstrap(pro) });
      if (p === '/hospitality/bookings') return route.fulfill({ json: req.method() === 'GET' ? { list: BOOKINGS } : { ok: true } });
      return route.fulfill({ json: { list: [] } });
    }
    return route.abort();
  });
  await page.goto(dashboardUrl + '?full=1', { waitUntil: 'domcontentloaded' });
  await page.evaluate((rec) => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    // @ts-ignore
    clientId = 7; clientRecord = rec; sessionToken = 'tok'; allLeads = [{ Id: 900, Name: 'Anu Thomas', Phone: '+91 98470 00707' }];
    // @ts-ignore
    hvApply(); navigate('home');
  }, { Id: 7, client_name: 'Lake Resort', hospitality_enabled: 'Yes', hospitality_style: 'houseboat', hospitality_pro_enabled: pro ? 'Yes' : 'No' });
  return calls;
}
test('CRM Home: new hospitality block on top, Weekly Arena and Staff Performance kept', async ({ page }) => {
  const calls = await openCrmHome(page);
  await expect(page.locator('#hvHome .hv-hero')).toContainText('Lake Resort');
  await expect(page.locator('#hvHome')).toContainText('Arriving today');
  await expect(page.locator('#pageHome .home-hero')).toBeHidden();
  const order = await page.evaluate(() => [...document.querySelectorAll('#hvHome,#homeArena,#homeStaffPerfCard')].map(e => e.id));
  expect(order).toEqual(['hvHome', 'homeArena', 'homeStaffPerfCard']);
  await expect(page.locator('#homeStaffPerfCard')).toBeVisible();
  await page.locator('#hvHome .hv-btn.pri', { hasText: 'Check in' }).click();
  await expect.poll(() => calls.find(c => c.path === '/hospitality/bookings' && c.method === 'PATCH')?.body).toEqual({ id: 41, status: 'checked_in' });
});
test('🛎️ Front Desk menu lists the switched-on screens and opens them inside the CRM', async ({ page }) => {
  await openCrmHome(page, { pro: { housekeeping: true, pricing_rules: false } });
  const items = page.locator('#dnHvGroup .dnTab');
  await expect(items.filter({ hasText: 'Housekeeping' })).toHaveCount(1);
  await expect(items.filter({ hasText: 'Smart Pricing' })).toHaveCount(0);
  await expect(items.filter({ hasText: 'Boats' })).toHaveCount(1);
  await page.locator('#dnHvGroup .dnGroupBtn').hover();
  await items.filter({ hasText: 'Calendar' }).click();
  await expect(page.locator('#pageHospdesk')).toBeVisible();
  await expect(page.locator('#hospDeskFrame')).toHaveAttribute('src', /hospitality\.html\?embed=1#calendar/);
  expect(page.context().pages()).toHaveLength(1); // no new tab
});
test('a chat requested by a Front Desk screen opens in the CRM Chats, matched by phone', async ({ page }) => {
  await openCrmHome(page);
  await page.evaluate(() => { /* @ts-ignore */ hvGo('bookings'); });
  await expect(page.frameLocator('#hospDeskFrame').locator('body')).toContainText('Anu Thomas');
  // @ts-ignore
  await page.evaluate(() => { window._sel = []; const o = chatSelectLead; chatSelectLead = id => { window._sel.push(id); o(id); }; });
  // @ts-ignore
  await page.frame({ url: /hospitality\.html/ }).evaluate(() => openChat(null, '9847000707'));
  await expect(page.locator('#pageChats')).toBeVisible();
  // @ts-ignore
  await expect.poll(() => page.evaluate(() => window._sel)).toEqual([900]);
  expect(page.context().pages()).toHaveLength(1);
});
