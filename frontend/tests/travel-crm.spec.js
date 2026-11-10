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

async function boot(page, { on = true, industry = 'travel' } = {}) {
  const patches = [];
  const fieldsAdded = [];
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url.startsWith(WORKER + '/travel-crm/numbers')) return route.fulfill({ json: { ok: true, numbers: NUMBERS } });
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
  await page.evaluate(({ OWNER, on, industry, past, past2, soon }) => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    try { localStorage.clear(); sessionStorage.clear(); } catch (e) {}
    const now = new Date().toISOString();
    // @ts-ignore
    clientId = 7; myEmail = OWNER; sessionToken = 't';
    // @ts-ignore
    clientRecord = { industry, ta_enabled: 'No', authentik_email: OWNER, travel_crm_enabled: on ? 'Yes' : 'No' };
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
  }, { OWNER, on, industry, past: iso(-3), past2: iso(-8), soon: iso(5) });
  return { patches, fieldsAdded };
}
const leadRow = (page, name) => page.locator('#leadsList .lead-item', { hasText: name });

test('off: nothing changes — no labels, filters, travel profile or report tab', async ({ page }) => {
  await boot(page, { on: false });
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
  await expect(card).toContainText('Came in on Calicut office · +919800000011');
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
  await boot(page, { on: false });
  // @ts-ignore
  await page.evaluate(() => { navigate('leads'); setLeadsViewMode('list'); });
  await expect(page.locator('#leadsList .tc-chip')).toHaveCount(0);
  await page.evaluate(() => window.postMessage({ type: 'tc:settings', enabled: true, config: { enquiry_types: ['Visa'], routes: ['Calicut → Doha'] } }, '*'));
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
        return route.fulfill({ json: { enabled: saved.enabled, is_travel_account: true, enquiry_types: saved.enquiry_types, routes: ['Calicut → Dubai', 'Kochi → Doha'], echo_url: WORKER + '/wa/business-echoes' } });
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
  expect(saved).toEqual({ enabled: true, enquiry_types: ['Air Ticket', 'Visa'], routes: ['Calicut → Dubai', 'kochi to doha'] });
  await expect(page.locator('#tcRoutes')).toHaveValue('Calicut → Dubai\nKochi → Doha');
  await expect(page.locator('#tcBadge')).toHaveText('On');
});
