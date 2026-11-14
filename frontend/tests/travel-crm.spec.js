// 📲 Travel CRM tools (frontend/travel-crm.js): off unless a travel agency account switches it on;
// when on — the WhatsApp number each enquiry came in on, enquiry type / route labels, the travel
// profile with travel dates (Completed once the trip is over), filters and the WhatsApp Numbers
// report. Same hermetic file:// setup as travel-status.spec.js.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';
const OWNER = 'boss@example.com';

function iso(offsetDays) {
  const d = new Date(); d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
const NUMBERS = [
  { inbox_id: '11', name: 'Calicut office', phone: '+919800000011' },
  { inbox_id: '22', name: 'Dubai office', phone: '+971500000022' },
  { inbox_id: '33', name: '', phone: '+971500000033' },
];

async function boot(page, { on = true, industry = 'travel', numbers = NUMBERS, trips = true } = {}) {
  const patches = [];
  const fieldsAdded = [];
  const detects = [];
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url.startsWith(WORKER + '/travel-crm/numbers')) return route.fulfill({ json: { ok: true, numbers } });
    if (url.startsWith(WORKER + '/travel-crm/detect')) {
      detects.push(JSON.parse(req.postData()));
      return route.fulfill({ json: { ok: true, found: true, patch: { TravelRoute: 'Calicut → Doha', TravelRouteBy: 'auto',
        TravelTrips: JSON.stringify([{ id: 'x', route: 'Calicut → Doha', depart: iso(12), ret: '', auto: true }]), TripStatus: 'Upcoming', NextTravelDate: iso(12) } } });
    }
    if (url.startsWith(WORKER + '/nocodb/api/v2/meta/tables/')) {
      if (req.method() === 'POST') { fieldsAdded.push(JSON.parse(req.postData()).title); return route.fulfill({ json: {} }); }
      return route.fulfill({ json: { columns: [{ title: 'Name' }] } });
    }
    if (url.startsWith(WORKER + '/nocodb/api/v2/tables/') && req.method() === 'PATCH') {
      patches.push(JSON.parse(req.postData()));
      return route.fulfill({ json: { Id: 1 } });
    }
    return route.abort();
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ OWNER, on, industry, past, past2, soon, trips }) => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    try { localStorage.clear(); sessionStorage.clear(); } catch (e) {}
    const now = new Date().toISOString();
    // @ts-ignore
    clientId = 7; myEmail = OWNER; sessionToken = 't';
    // @ts-ignore
    clientRecord = { industry, ta_enabled: 'No', authentik_email: OWNER, travel_crm_enabled: on ? 'Yes' : 'No', travel_trips_enabled: trips ? 'Yes' : 'No' };
    // @ts-ignore
    allLeads = [
      { Id: 1, Name: 'Asha', Phone: '911', Owner: OWNER, Date: now, Stage: 'won', InboxId: '11', EnquiryType: 'Visa', TravelRoute: 'Calicut → Dubai' },
      { Id: 2, Name: 'Ravi', Phone: '912', Owner: OWNER, Date: now, Stage: 'new', InboxId: '11', EnquiryType: 'Air Ticket', TravelRoute: 'Kochi → Dubai',
        TravelTrips: JSON.stringify([{ id: 'a', route: 'Kochi → Dubai', depart: soon, ret: '' }]) },
      { Id: 3, Name: 'Meera', Phone: '913', Owner: OWNER, Date: now, Stage: 'new', InboxId: '22', TravelDates: `${past2} → ${past}` },
      { Id: 4, Name: 'John', Phone: '914', Owner: OWNER, Date: now, Stage: 'lost' },
    ];
    // @ts-ignore
    _leadsActiveView = 'all';
    // @ts-ignore
    applyTheme(industry);
    // @ts-ignore
    updateAgencyTabVisibility();
  }, { OWNER, on, industry, past: iso(-3), past2: iso(-8), soon: iso(5), trips });
  return { patches, fieldsAdded, detects };
}
const leadRow = (page, name) => page.locator('#leadsList .lead-item', { hasText: name });

test('off with one WhatsApp number: nothing changes — no labels, filters, travel profile or report tab', async ({ page }) => {
  await boot(page, { on: false, numbers: NUMBERS.slice(0, 1), trips: false });
  // @ts-ignore
  await page.evaluate(() => { navigate('leads'); setLeadsViewMode('list'); });
  await expect(leadRow(page, 'Asha')).toBeVisible();
  await expect(page.locator('#leadsList .tc-chip')).toHaveCount(0);
  await expect(page.locator('#tcLeadsBar')).toBeHidden();
  // @ts-ignore
  await page.evaluate(() => openDetail(1));
  await expect(page.locator('#detailTravelCrm')).toBeHidden();
  // @ts-ignore
  await page.evaluate(() => renderReports());
  await expect(page.locator('#rptTabTcNumbers')).toBeHidden();
  // The old Industry Modules row is gone — the setting lives in Travel Settings now.
  await expect(page.locator('#tcSettingsRow')).toHaveCount(0);
});

test('other industries never get it, even with the flag set', async ({ page }) => {
  await boot(page, { on: true, industry: 'real_estate' });
  // @ts-ignore
  expect(await page.evaluate(() => tcOn())).toBe(false);
});

test('each enquiry shows its WhatsApp number, enquiry type and route; filters narrow the list', async ({ page }) => {
  await boot(page);
  // @ts-ignore
  await page.evaluate(() => { navigate('leads'); setLeadsViewMode('list'); });
  await expect(leadRow(page, 'Asha').locator('.tc-num')).toHaveText('📲 Calicut office');
  await expect(leadRow(page, 'Asha').locator('.tc-type')).toContainText('Visa');
  await expect(leadRow(page, 'Asha').locator('.tc-route')).toContainText('Calicut → Dubai');
  await expect(leadRow(page, 'Meera').locator('.tc-num')).toHaveText('📲 Dubai office');
  await expect(leadRow(page, 'Meera').locator('.tc-st-done')).toContainText('Completed');
  await expect(leadRow(page, 'John').locator('.tc-num')).toHaveCount(0);

  const bar = page.locator('#tcLeadsBar .tc-bar');
  await bar.locator('select[aria-label="WhatsApp number"]').selectOption('11');
  await expect(page.locator('#leadsList .lead-item')).toHaveCount(2);
  await bar.locator('select[aria-label="Route"]').selectOption('Kochi → Dubai');
  await expect(page.locator('#leadsList .lead-item')).toHaveCount(1);
  await expect(leadRow(page, 'Ravi')).toBeVisible();
  await page.locator('#tcLeadsBar .tc-clear').click();
  await page.locator('#tcLeadsBar select[aria-label="Enquiry type"]').selectOption('__none');
  await expect(page.locator('#leadsList .lead-item')).toHaveCount(2);
  await page.locator('#tcLeadsBar .tc-clear').click();
  await page.locator('#tcLeadsBar select[aria-label="Travel date"]').selectOption('completed');
  await expect(page.locator('#leadsList .lead-item')).toHaveCount(1);
  await expect(leadRow(page, 'Meera')).toBeVisible();
  await page.locator('#tcLeadsBar select[aria-label="Travel date"]').selectOption('next7');
  await expect(page.locator('#leadsList .lead-item')).toHaveCount(1);
  await expect(leadRow(page, 'Ravi')).toBeVisible();
});

test('the travel profile shows the source number and saves travel dates; past trips read Completed', async ({ page }) => {
  const { patches, fieldsAdded } = await boot(page);
  // @ts-ignore
  await page.evaluate(() => openDetail(2));
  const card = page.locator('#detailTravelCrm');
  await expect(card.locator('.tc-srcline')).toContainText('Came in on');
  await expect(card.locator('.tc-srcline .tc-num')).toHaveText('📲 Calicut office · +919800000011');
  await expect(card.locator('.tc-hd')).toContainText('Upcoming');

  await card.locator('select').first().selectOption('Holiday Package');
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toEqual({ Id: 2, EnquiryType: 'Holiday Package' });

  await card.getByRole('button', { name: '+ Add travel dates' }).click();
  await page.locator('#tcTripRoute').fill('calicut to sharjah');
  await page.locator('#tcTripDepart').fill(iso(-10));
  await page.locator('#tcTripRet').fill(iso(-4));
  await page.getByRole('button', { name: 'Save dates' }).click();
  await expect.poll(() => patches.length).toBe(2);
  const trips = JSON.parse(patches[1].TravelTrips);
  expect(trips.map(t => [t.route, t.depart, t.ret])).toEqual([['Kochi → Dubai', iso(5), ''], ['Calicut → Sharjah', iso(-10), iso(-4)]]);
  expect(patches[1]).toMatchObject({ Id: 2, TripStatus: 'Upcoming', NextTravelDate: iso(5) });
  expect(fieldsAdded).toEqual(expect.arrayContaining(['EnquiryType', 'TravelRoute', 'TravelTrips', 'TripStatus', 'NextTravelDate']));
  await expect(card.locator('.tc-trip', { hasText: 'Calicut → Sharjah' }).locator('.tc-st-done')).toContainText('Completed');

  // Removing the upcoming trip leaves only the finished one → the profile reads Completed.
  page.once('dialog', d => d.accept());
  await card.locator('.tc-trip', { hasText: 'Kochi → Dubai' }).getByRole('button', { name: 'Remove travel dates' }).click();
  await expect.poll(() => patches.length).toBe(3);
  expect(patches[2]).toMatchObject({ Id: 2, TripStatus: 'Completed' });
  await expect(card.locator('.tc-hd')).toContainText('Completed');
});

test('a lead with no WhatsApp number says so', async ({ page }) => {
  await boot(page);
  // @ts-ignore
  await page.evaluate(() => openDetail(4));
  await expect(page.locator('#detailTravelCrm')).toContainText('No WhatsApp number recorded');
});

test('Reports → WhatsApp Numbers: leads and conversions per number', async ({ page }) => {
  await boot(page);
  // @ts-ignore
  await page.evaluate(() => { navigate('reports'); renderReports(); renderReportsSubPage('tcnumbers'); });
  await expect(page.locator('#rptTabTcNumbers')).toBeVisible();
  const table = page.locator('#reportsContent table').first();
  const row = name => table.locator('tbody tr', { hasText: name });
  await expect(row('Calicut office').locator('td').nth(1)).toHaveText('2');
  await expect(row('Calicut office').locator('td').nth(3)).toHaveText('1');   // Won
  await expect(row('Calicut office').locator('td').nth(5)).toHaveText('50%');
  await expect(row('Dubai office').locator('td').nth(1)).toHaveText('1');
  await expect(row('+971500000033').locator('td').nth(1)).toHaveText('0');   // connected, no leads yet
  await expect(row('No WhatsApp number').locator('td').nth(1)).toHaveText('1');
  await expect(table.locator('tfoot')).toContainText('4');
});

test('the Status Board and Pipeline use the same filters', async ({ page }) => {
  await boot(page);
  // @ts-ignore
  await page.evaluate(() => navigate('tvstatus'));
  await expect(page.locator('#tsBody .tsb-row')).toHaveCount(4);
  await page.locator('#tsBody .tc-bar select[aria-label="WhatsApp number"]').selectOption('22');
  await expect(page.locator('#tsBody .tsb-row')).toHaveCount(1);
  await expect(page.locator('#tsBody .tsb-row')).toContainText('Meera');
  // @ts-ignore
  await page.evaluate(() => { navigate('leads'); setLeadsViewMode('pipeline'); });
  await expect(page.locator('#kanbanWrap .tsk-card')).toHaveCount(1);
  await expect(page.locator('#kanbanWrap .tsk-card .tc-num')).toHaveText('📲 Dubai office');
});

test('a save in Live Agency → Travel Settings (embedded) switches the dashboard on straight away', async ({ page }) => {
  await boot(page, { on: false, numbers: NUMBERS.slice(0, 1), trips: false });
  // @ts-ignore
  await page.evaluate(() => { navigate('leads'); setLeadsViewMode('list'); });
  await expect(page.locator('#leadsList .tc-chip')).toHaveCount(0);
  // @ts-ignore — the cached list is one number; Travel CRM tools turning on is what shows the labels.
  await expect.poll(() => page.evaluate(() => tcNumbers().length)).toBe(1);
  await page.evaluate(() => window.postMessage({ type: 'tc:settings', enabled: true, trips_enabled: true, config: { enquiry_types: ['Visa'], routes: ['Calicut → Doha'] } }, '*'));
  await expect(leadRow(page, 'Asha').locator('.tc-num')).toHaveText('📲 Calicut office');
  await expect(page.locator('#tcLeadsBar select[aria-label="Route"]')).toContainText('Calicut → Doha');
});

const ltUrl = 'file://' + path.resolve(__dirname, '../live-travel-agency.html') + '?client=7&token=t';
const ltBootstrap = { suppliers: [], searches: [], quotes: [], bookings: [], service_requests: [], wallet: [], wallet_entries: [], agents: [], commissions: [], currency_settings: { default_currency: 'AED' }, supported_currencies: [] };
test('Live Agency → Travel Settings → 📲 Travel CRM: off by default, turns on and saves the lists', async ({ page }) => {
  let saved = null;
  await page.route('**/*', async (route) => {
    const req = route.request(), url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url.endsWith('/live-travel/bootstrap')) return route.fulfill({ json: ltBootstrap });
    if (url.endsWith('/live-travel/travel-settings')) return route.fulfill({ json: { lt_show_fares: true, lt_fare_options: 2, lt_fare_style: 'classic', lt_online_booking: true } });
    if (url.endsWith('/travel-crm/settings')) {
      if (req.method() === 'PUT') {
        saved = JSON.parse(req.postData() || '{}');
        return route.fulfill({ json: { enabled: saved.enabled, trips_enabled: saved.trips_enabled, is_travel_account: true, enquiry_types: saved.enquiry_types, routes: ['Calicut → Dubai', 'Kochi → Doha'], echo_url: WORKER + '/wa/business-echoes' } });
      }
      return route.fulfill({ json: { enabled: false, is_travel_account: true, enquiry_types: ['Air Ticket', 'Visa'], routes: ['Calicut → Dubai'], echo_url: WORKER + '/wa/business-echoes' } });
    }
    return route.abort();
  });
  await page.goto(ltUrl);
  await page.getByRole('button', { name: '⚙️ Travel Settings' }).click();
  await page.getByRole('button', { name: '📲 Travel CRM' }).click();
  await expect(page.locator('#tcOn')).toHaveValue('0');
  await expect(page.locator('#tcBadge')).toHaveText('Off');
  await expect(page.locator('#tcTypes')).toHaveValue('Air Ticket\nVisa');
  await expect(page.locator('main')).toContainText('/wa/business-echoes');
  await page.selectOption('#tcOn', '1');
  await page.fill('#tcRoutes', 'Calicut → Dubai\nkochi to doha');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('#tcMsg')).toContainText('Travel CRM tools are on');
  expect(saved).toEqual({ enabled: true, trips_enabled: true, enquiry_types: ['Air Ticket', 'Visa'], routes: ['Calicut → Dubai', 'kochi to doha'] });
  await expect(page.locator('#tcRoutes')).toHaveValue('Calicut → Dubai\nKochi → Doha');
  await expect(page.locator('#tcBadge')).toHaveText('On');
});

const numVar = (loc) => loc.evaluate(el => getComputedStyle(el).getPropertyValue('--tcn-fg').trim());
test('2+ WhatsApp numbers, Travel CRM tools off: each lead shows its number in its own colour, with a number filter and report', async ({ page }) => {
  await boot(page, { on: false, trips: false });
  // @ts-ignore
  await page.evaluate(() => { navigate('leads'); setLeadsViewMode('list'); });
  const asha = leadRow(page, 'Asha').locator('.tc-num'), meera = leadRow(page, 'Meera').locator('.tc-num'), ravi = leadRow(page, 'Ravi').locator('.tc-num');
  await expect(asha).toHaveText('📲 Calicut office');
  await expect(meera).toHaveText('📲 Dubai office');
  expect(await numVar(asha)).not.toBe(await numVar(meera));     // different numbers, different colours
  expect(await numVar(asha)).toBe(await numVar(ravi));          // same number, same colour
  // Only the number — no enquiry type / route / trip labels without Travel CRM tools.
  await expect(page.locator('#leadsList .tc-type, #leadsList .tc-route, #leadsList .tc-st-done')).toHaveCount(0);
  const bar = page.locator('#tcLeadsBar .tc-bar');
  await expect(bar.locator('select')).toHaveCount(1);
  await bar.locator('select[aria-label="WhatsApp number"]').selectOption('22');
  await expect(page.locator('#leadsList .lead-item')).toHaveCount(1);
  await page.locator('#tcLeadsBar .tc-clear').click();

  // Selecting a lead: the number is the first thing in the details.
  // @ts-ignore
  await page.evaluate(() => openDetail(3));
  await expect(page.locator('#detailTravelCrm .tc-srcline')).toContainText('Came in on');
  await expect(page.locator('#detailTravelCrm .tc-num')).toHaveText('📲 Dubai office · +971500000022');
  await expect(page.locator('#detailTravelCrm .tc-card')).toHaveCount(0);

  // Reports → WhatsApp Numbers, without the enquiry type / route tables.
  // @ts-ignore
  await page.evaluate(() => { closeModal('modalDetail'); navigate('reports'); renderReports(); renderReportsSubPage('tcnumbers'); });
  await expect(page.locator('#rptTabTcNumbers')).toBeVisible();
  await expect(page.locator('#reportsContent table')).toHaveCount(1);
  await expect(page.locator('#reportsContent tbody tr', { hasText: 'Calicut office' }).locator('td').nth(3)).toHaveText('1');

  // The Status Board (Inquiries) shows the same coloured number.
  // @ts-ignore
  await page.evaluate(() => navigate('tvstatus'));
  const row = page.locator('#tsBody .tsb-row[data-lead="1"] .tc-num');
  await expect(row).toHaveText('📲 Calicut office');
  expect(await numVar(row)).toBe(await numVar(asha));
});

test('route & travel date tags are on for a travel agency by default: tags, filters, profile, Find in chat', async ({ page }) => {
  const { patches, detects } = await boot(page, { on: false, numbers: NUMBERS.slice(0, 1) });
  // @ts-ignore
  await page.evaluate(() => {
    const l = allLeads.find(x => x.Id === 2); l.TravelRouteBy = 'auto';
    l.TravelTrips = JSON.stringify([{ id: 'a', route: 'Kochi → Dubai', depart: new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10), ret: '', auto: true }]);
    navigate('leads'); setLeadsViewMode('list');
  });
  // Tags: route and travel date (dashed = picked up from the chat); Completed for a finished trip.
  await expect(leadRow(page, 'Ravi').locator('.tc-route')).toHaveText('🛫 Kochi → Dubai');
  await expect(leadRow(page, 'Ravi').locator('.tc-route')).toHaveClass(/tc-auto/);
  await expect(leadRow(page, 'Ravi').locator('.tc-st-up')).toHaveClass(/tc-auto/);
  await expect(leadRow(page, 'Asha').locator('.tc-route')).not.toHaveClass(/tc-auto/);
  await expect(leadRow(page, 'Meera').locator('.tc-st-done')).toContainText('Completed');
  // No WhatsApp number or enquiry type with one number and Travel CRM tools off.
  await expect(page.locator('#leadsList .tc-num, #leadsList .tc-type')).toHaveCount(0);
  const bar = page.locator('#tcLeadsBar .tc-bar');
  await expect(bar.locator('select')).toHaveCount(2);
  await bar.locator('select[aria-label="Route"]').selectOption('Kochi → Dubai');
  await expect(page.locator('#leadsList .lead-item')).toHaveCount(1);
  await page.locator('#tcLeadsBar .tc-clear').click();
  await page.locator('#tcLeadsBar select[aria-label="Travel date"]').selectOption('completed');
  await expect(page.locator('#leadsList .lead-item')).toHaveCount(1);
  await expect(leadRow(page, 'Meera')).toBeVisible();
  await page.locator('#tcLeadsBar .tc-clear').click();

  // Profile: route + travel dates, the auto ones marked, editable; no enquiry type without the setting.
  // @ts-ignore
  await page.evaluate(() => openDetail(2));
  const card = page.locator('#detailTravelCrm .tc-card');
  await expect(card.locator('select')).toHaveCount(0);
  await expect(card.locator('.tc-trip')).toContainText('from chat');
  await expect(card.locator('.form-label', { hasText: 'Route' })).toContainText('from chat');
  await card.locator('input[list="tcRouteList"]').fill('kochi to sharjah');
  await card.locator('input[list="tcRouteList"]').blur();
  await expect.poll(() => patches.filter(p => p.TravelRoute).length).toBe(1);
  expect(patches.find(p => p.TravelRoute)).toMatchObject({ Id: 2, TravelRoute: 'Kochi → Sharjah', TravelRouteBy: OWNER });

  // 🔎 Find in chat on a lead with nothing yet.
  // @ts-ignore
  await page.evaluate(() => openDetail(4));
  await page.getByRole('button', { name: '🔎 Find in chat' }).click();
  await expect.poll(() => detects.length).toBe(1);
  expect(detects[0]).toEqual({ lead_id: 4 });
  await expect(page.locator('#detailTravelCrm .tc-trip')).toContainText('Calicut → Doha');
  await expect(page.locator('#detailTravelCrm .tc-hd')).toContainText('Upcoming');

  // Status Board and Pipeline show the same tags and use the same filters.
  // @ts-ignore
  await page.evaluate(() => { closeModal('modalDetail'); navigate('tvstatus'); });
  await expect(page.locator('#tsBody .tsb-row[data-lead="4"] .tc-route')).toHaveText('🛫 Calicut → Doha');
  await page.locator('#tsBody .tc-bar select[aria-label="Route"]').selectOption('Calicut → Doha');
  await expect(page.locator('#tsBody .tsb-row')).toHaveCount(1);
  // @ts-ignore
  await page.evaluate(() => { navigate('leads'); setLeadsViewMode('pipeline'); });
  await expect(page.locator('#kanbanWrap .tsk-card')).toHaveCount(1);
  await expect(page.locator('#kanbanWrap .tsk-card .tc-route')).toHaveText('🛫 Calicut → Doha');
});

test('route & travel dates switched off: no tags, filters or profile', async ({ page }) => {
  await boot(page, { on: false, numbers: NUMBERS.slice(0, 1), trips: false });
  // @ts-ignore
  await page.evaluate(() => { navigate('leads'); setLeadsViewMode('list'); openDetail(2); });
  await expect(page.locator('#leadsList .tc-chip')).toHaveCount(0);
  await expect(page.locator('#tcLeadsBar')).toBeHidden();
  await expect(page.locator('#detailTravelCrm')).toBeHidden();
});

test('other industries never see the numbers, even with several connected', async ({ page }) => {
  await boot(page, { on: false, industry: 'real_estate' });
  // @ts-ignore
  await page.evaluate(() => { navigate('leads'); setLeadsViewMode('list'); });
  await expect(page.locator('#leadsList .lead-item').first()).toBeVisible();
  await expect(page.locator('#leadsList .tc-chip')).toHaveCount(0);
  // @ts-ignore
  expect(await page.evaluate(() => tcNumbersOn())).toBe(false);
});

/* ── Inbox (chats.html) ── */
const chatsUrl = 'file://' + path.resolve(__dirname, '../chats.html') + '?client=7&token=t';
const minsAgo = m => new Date(Date.now() - m * 60000).toISOString();
function conv(id, name, inbox) {
  return { lead_id: id, client_id: 7, channel: 'whatsapp', name, phone: '91980000000' + id, conv_id: String(500 + id), inbox_id: inbox, status: 'open', handover: 'No', handover_by: '',
    assignee_email: '', priority: 0, labels: '', labels_key: ',', pinned: 0, unread_count: 0, last_read_at: minsAgo(999), last_message_id: id, last_message_at: minsAgo(id),
    last_message_preview: 'hello', last_message_dir: 'in', last_sender: 'customer', last_customer_at: minsAgo(id), waiting_since: null, synced: 1, updated_at: minsAgo(60) };
}
async function openInbox(page, { travel = true, numbers = NUMBERS } = {}) {
  const rows = [conv(1, 'Asha', '11'), conv(2, 'Meera', '22'), conv(3, 'Ravi', '11')];
  await page.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname;
    if (url.protocol === 'file:') return route.continue();
    if (p.endsWith('/session/me')) return route.fulfill({ json: { email: OWNER, client: { authentik_email: OWNER, industry: travel ? 'travel' : 'general' } } });
    if (p.endsWith('/travel-crm/numbers')) return route.fulfill({ json: { ok: true, numbers } });
    if (p.endsWith('/chats/v2/bootstrap')) return route.fulfill({ json: { version: 'v1', me: { email: OWNER, staff: false, locked: false }, travel, categories_custom: [], agents: [{ email: OWNER, name: 'Boss' }],
      labels: [], inboxes: numbers.map(n => ({ id: Number(n.inbox_id), name: n.name, phone_number: n.phone, channel_type: 'Channel::Whatsapp' })), canned: [], settings: { sla_warn_min: 15, sla_breach_min: 60 }, views: [], macros: [] } });
    if (p.endsWith('/chats/v2/counts')) return route.fulfill({ json: { all: 3, unread: 0, needs: 0, mine: 0, unassigned: 3, pending: 0, snoozed: 0, resolved: 0, unread_by_channel: { whatsapp: 0, instagram: 0 } } });
    if (p.endsWith('/chats/v2/list')) return route.fulfill({ json: { rows: url.searchParams.get('updated_since') !== null ? [] : rows, cursor: null } });
    if (p.endsWith('/chats/v2/thread')) return route.fulfill({ json: { messages: [{ id: 1, role: 'user', content: 'Hi', ts: minsAgo(5) }], has_more: false, before: null, conversation: rows.find(r => String(r.lead_id) === url.searchParams.get('lead_id')) } });
    if (p.endsWith('/chats/v2/notes')) return route.fulfill({ json: { notes: [] } });
    if (/\/nocodb\/api\/v2\/tables\/[^/]+\/records\/\d+$/.test(p)) return route.fulfill({ json: {} });
    if (p.endsWith('/chats/v2/rum') || p.endsWith('/chats/v2/act')) return route.fulfill({ json: { ok: true, rows: [] } });
    return route.abort();
  });
  await page.goto(chatsUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#app')).toBeVisible();
}
const wnVar = (loc) => loc.evaluate(el => getComputedStyle(el).getPropertyValue('--wn-fg').trim());
test('Inbox: each chat shows the WhatsApp number it came in on, in that number\'s colour', async ({ page }) => {
  await openInbox(page);
  const chip = name => page.locator('#list .contact', { hasText: name }).locator('.wn');
  await expect(chip('Asha')).toHaveText('Calicut office');
  await expect(chip('Meera')).toHaveText('Dubai office');
  expect(await wnVar(chip('Asha'))).not.toBe(await wnVar(chip('Meera')));
  expect(await wnVar(chip('Asha'))).toBe(await wnVar(chip('Ravi')));
  await page.locator('#list .contact', { hasText: 'Meera' }).click();
  await expect(page.locator('#wnHdr .wn')).toHaveText('Dubai office · +971500000022');
  // Same colours as the dashboard: both read the number list the same way.
  expect(await wnVar(page.locator('#wnHdr .wn'))).toBe('#1E40AF');
});

test('Inbox: one number, or not a travel agency — no number chips', async ({ page }) => {
  await openInbox(page, { numbers: NUMBERS.slice(0, 1) });
  await expect(page.locator('#list .contact', { hasText: 'Asha' })).toBeVisible();
  await expect(page.locator('#list .wn')).toHaveCount(0);
});
test('Inbox: other industries — no number chips', async ({ page }) => {
  await openInbox(page, { travel: false });
  await expect(page.locator('#list .contact', { hasText: 'Asha' })).toBeVisible();
  await expect(page.locator('#list .wn')).toHaveCount(0);
});

test('Inbox: the contact panel shows the customer\'s route and travel dates', async ({ page }) => {
  await openInbox(page);
  // Registered after the harness's catch-all, so this one answers the lead record.
  await page.route('**/nocodb/api/v2/tables/*/records/*', route => route.fulfill({ json: { TravelRoute: 'Calicut → Dubai', TravelRouteBy: 'auto',
    TravelTrips: JSON.stringify([{ route: 'Calicut → Dubai', depart: iso(-9), ret: iso(-2) }, { route: 'Calicut → Dubai', depart: iso(20), ret: '', auto: true }]) } }));
  await page.locator('#list .contact', { hasText: 'Asha' }).click();
  // @ts-ignore
  await page.evaluate(() => toggleInfo(true));
  const panel = page.locator('#infoPanel');
  await expect(panel).toContainText('🧳 Travel');
  await expect(panel).toContainText('🛫 Calicut → Dubai');
  await expect(panel).toContainText('✅ Completed');
  await expect(panel).toContainText('🗓️ Upcoming');
});
