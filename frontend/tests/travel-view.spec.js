// Travel workspace (frontend/travel-view.js): travel clients get their own nav, a "Today" home and
// a Departures calendar; Trips/Quotes/… drive the embedded travel-agency.html. Same hermetic
// file:// setup as hospitality-pro.spec.js — every off-origin request is blocked.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');

function iso(offsetDays) {
  const d = new Date(); d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

async function openTravel(page, client) {
  await page.route('**/*', (route) => (route.request().url().startsWith('file://') ? route.continue() : route.abort()));
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ rec, today, soon, later }) => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    try { localStorage.removeItem('lv_travel_view_7'); } catch (e) {}
    // @ts-ignore
    clientId = 7; clientRecord = rec; sessionToken = 't'; myEmail = '';
    // @ts-ignore
    allLeads = [
      { Id: 1, Name: 'Asha', Phone: '9190000001', Date: today, Stage: 'new', Destination: 'Dubai', TravelDates: `${soon} → ${later}`, ServiceCategory: 'Package' },
      { Id: 2, Name: 'Ravi', Phone: '9190000002', Date: today, Stage: 'human_handover', Handover: 'Yes', Destination: 'Dubai' },
    ];
    // @ts-ignore
    _taBookings = [
      { Id: 5, client_name: 'Meera', package_name: 'Bali 5N', departure_date: today, pax: 2, currency: 'AED', cost_price: 3000, sell_price: 4000, deposit: 1000, status: 'confirmed', CreatedAt: today },
      { Id: 6, client_name: 'John', package_name: 'Baku 4N', departure_date: soon, pax: 1, currency: 'AED', cost_price: 1000, sell_price: 1500, deposit: 0, status: 'quoted', CreatedAt: today },
    ];
    // @ts-ignore
    applyTheme(rec.industry);
    // @ts-ignore
    navigate('travelhome');
  }, { rec: client, today: iso(0), soon: iso(3), later: iso(8) });
}

test.describe('travel workspace', () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test('travel client gets the travel nav and Today home', async ({ page }) => {
    await openTravel(page, { industry: 'travel', ta_enabled: 'Yes', client_name: 'Acme Travels' });
    await expect(page.locator('#travelNav')).toBeVisible();
    await expect(page.locator('#desktopNav')).toBeHidden();
    await expect(page.locator('#travelNav .dnTab[data-page="travelhome"]')).toHaveClass(/active/);
    await expect(page.locator('#travelNav')).toContainText('Inquiries');
    await expect(page.locator('#travelNav')).toContainText('Departures');

    const home = page.locator('#tvHomeBody');
    await expect(home).toContainText('Acme Travels');
    await expect(home.locator('.tv-kpi', { hasText: 'Departures today' }).locator('.stat-val')).toHaveText('1');
    await expect(home.locator('.tv-kpi', { hasText: 'Waiting for agent' }).locator('.stat-val')).toHaveText('1');
    await expect(home.locator('.tv-kpi', { hasText: 'Open quotes' })).toContainText('AED 1,500');
    // Balance due: 4000-1000 for Meera, 1500 for John
    await expect(home.locator('.tv-kpi', { hasText: 'Balance due' })).toContainText('AED 4,500');
    await expect(home.locator('.tv-kpi', { hasText: 'Sales this month' })).toContainText('margin AED 1,500');
    await expect(home).toContainText('Dubai');
  });

  test('departures calendar shows trips and inquiry travel dates', async ({ page }) => {
    await openTravel(page, { industry: 'travel', ta_enabled: 'Yes' });
    await page.locator('#travelNav .dnTab[data-page="departures"]').click();
    const dep = page.locator('#tvDepBody');
    await expect(dep.locator('.tv-ev.booking', { hasText: 'Meera' }).first()).toBeVisible();
    await expect(dep.locator('.tv-row', { hasText: 'Asha' }).first()).toBeVisible();
    await dep.locator('input[type="checkbox"]').uncheck();
    await expect(dep.locator('.tv-row', { hasText: 'Asha' })).toHaveCount(0);
  });

  test('departures calendar shows each inquiry\'s travel-profile trips — from chat, with returns, route filter and Completed', async ({ page }) => {
    await openTravel(page, { industry: 'travel', ta_enabled: 'Yes' });
    // @ts-ignore
    await page.evaluate(({ dep, ret, past1, past2 }) => {
      allLeads.push(
        { Id: 3, Name: 'Fathima', Phone: '9190000003', Date: dep, Stage: 'new', TravelRoute: 'Calicut → Dubai', TravelRouteBy: 'auto',
          TravelTrips: JSON.stringify([{ id: 'a', route: 'Calicut → Dubai', depart: dep, ret, auto: true }]) },
        { Id: 4, Name: 'Noor', Phone: '9190000004', Date: dep, Stage: 'new', TravelRoute: 'Kochi → Sharjah',
          TravelTrips: JSON.stringify([{ id: 'b', route: 'Kochi → Sharjah', depart: dep, ret: '' }, { id: 'c', route: 'Kochi → Sharjah', depart: past1, ret: past2 }]) });
      navigate('travelhome');
    }, { dep: iso(4), ret: iso(9), past1: iso(-9), past2: iso(-6) });
    // Today → "travelling in the next 14 days" shows the route and where the date came from.
    const soon = page.locator('#tvHomeBody .card', { hasText: 'travelling in the next 14 days' });
    await expect(soon.locator('.tv-row', { hasText: 'Fathima' })).toContainText('Calicut → Dubai');
    await expect(soon.locator('.tv-row', { hasText: 'Fathima' })).toContainText('from chat');

    await page.locator('#travelNav .dnTab[data-page="departures"]').click();
    const dep = page.locator('#tvDepBody');
    // @ts-ignore — look at the month of Fathima's travel date (the test may run at a month end).
    await page.evaluate((m) => { _tvCalMonth = m; renderDepartures(); }, iso(4).slice(0, 7));
    const ev = dep.locator('.tv-cal .tv-ev', { hasText: 'Fathima' }).first();
    await expect(ev).toContainText('Fathima · Calicut → Dubai');
    await expect(ev).toHaveClass(/inquiry/);
    await expect(ev).toHaveClass(/auto/);
    await expect(dep.locator('.tv-row', { hasText: 'Fathima' }).first()).toContainText('from chat');
    // The return shows too (route reversed) — check in its own month.
    // @ts-ignore
    await page.evaluate((m) => { _tvCalMonth = m; renderDepartures(); }, iso(9).slice(0, 7));
    await expect(dep.locator('.tv-cal .tv-ev.return', { hasText: 'Fathima' })).toContainText('Dubai → Calicut');
    // Route filter: only that route's inquiries.
    // @ts-ignore
    await page.evaluate((m) => { _tvCalMonth = m; renderDepartures(); }, iso(4).slice(0, 7));
    await dep.locator('select[aria-label="Inquiry route"]').selectOption('Kochi → Sharjah');
    await expect(dep.locator('.tv-cal .tv-ev.inquiry', { hasText: 'Fathima' })).toHaveCount(0);
    await expect(dep.locator('.tv-cal .tv-ev.inquiry', { hasText: 'Noor' }).first()).toBeVisible();
    // A finished trip is shown as Completed.
    // @ts-ignore
    await page.evaluate((m) => { tvSetCalRoute(''); _tvCalMonth = m; renderDepartures(); }, iso(-9).slice(0, 7));
    await expect(dep.locator('.tv-cal .tv-ev.inquiry.done', { hasText: 'Noor' })).toBeVisible();
    await expect(dep.locator('.tv-row', { hasText: 'Noor' }).first()).toContainText('Completed');
    // Tapping an inquiry opens its travel profile.
    await dep.locator('.tv-cal .tv-ev.inquiry.done', { hasText: 'Noor' }).click();
    await expect(page.locator('#detailTravelCrm .tc-card')).toContainText('Kochi → Sharjah');
  });

  test('Trips opens the agency frame on bookings in travel-shell mode', async ({ page }) => {
    await openTravel(page, { industry: 'travel', ta_enabled: 'Yes' });
    await page.locator('#travelNav .dnTab[data-page="tvtrips"]').click();
    await expect(page.locator('#pageAgency')).toBeVisible();
    const src = await page.locator('#agencyFrame').getAttribute('src');
    expect(src).toContain('tab=bookings');
    expect(src).toContain('shell=travel');
  });

  test('agency pages are hidden when the Travel Agency module is off', async ({ page }) => {
    await openTravel(page, { industry: 'travel', ta_enabled: 'No' });
    await expect(page.locator('#travelNav .dnTab[data-page="tvtrips"]')).toHaveCount(0);
    await expect(page.locator('#travelNav .dnTab[data-page="leads"]')).toHaveCount(1);
    await expect(page.locator('#tvHomeBody .tv-banner')).toContainText('Travel Agency');
  });

  test('switching to classic view restores the regular nav and back', async ({ page }) => {
    await openTravel(page, { industry: 'travel', ta_enabled: 'Yes' });
    await page.evaluate(() => { /* @ts-ignore */ tvGo('__classic'); });
    await expect(page.locator('#desktopNav')).toBeVisible();
    await expect(page.locator('#travelNav')).toBeHidden();
    await expect(page.locator('#pageHome')).toBeVisible();
    await page.locator('#dnTvSwitch').click();
    await expect(page.locator('#travelNav')).toBeVisible();
    await expect(page.locator('#pageTravelhome')).toBeVisible();
  });

  test('non-travel clients are unaffected', async ({ page }) => {
    await openTravel(page, { industry: 'healthcare', ta_enabled: 'No' });
    await expect(page.locator('#travelNav')).toBeHidden();
    await expect(page.locator('#desktopNav')).toBeVisible();
    await expect(page.locator('#dnTvSwitch')).toBeHidden();
  });
});

test.describe('travel workspace — fast loading', () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test('Today paints trips from the session cache before taLoad returns', async ({ page }) => {
    await page.route('**/*', (route) => (route.request().url().startsWith('file://') ? route.continue() : route.abort()));
    await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
    await page.evaluate((today) => {
      document.getElementById('app').classList.add('show');
      document.getElementById('gate')?.style.setProperty('display', 'none');
      sessionStorage.setItem('lv_tv_ta_7', JSON.stringify({ ts: Date.now(), bookings: [
        { client_name: 'Cached Meera', package_name: 'Bali 5N', departure_date: today, pax: 2, currency: 'AED', sell_price: 4000, deposit: 4000, status: 'confirmed' },
      ], umrah: [], cars: [] }));
      // @ts-ignore
      clientId = 7; clientRecord = { industry: 'travel', ta_enabled: 'Yes' }; sessionToken = 't'; myEmail = ''; allLeads = [];
      // @ts-ignore
      applyTheme('travel'); navigate('travelhome');
    }, iso(0));
    await expect(page.locator('#tvHomeBody')).toContainText('Cached Meera');
  });

  test('the Trips frame preloads in the background', async ({ page }) => {
    await openTravel(page, { industry: 'travel', ta_enabled: 'Yes' });
    await expect(page.locator('#pageAgency')).toBeHidden();
    await expect(page.locator('#agencyFrame')).toHaveAttribute('src', /shell=travel.*tab=bookings/, { timeout: 10000 });
  });
});

test('travel-agency.html loads slim leads in parallel and falls back to full rows', async ({ page }) => {
  const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';
  const ids = { packages: 'tp', bookings: 'tb', cases: 'tc', itineraries: 'ti', umrah_groups: 'tu' };
  const leadUrls = [];
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('file://')) return route.continue();
    if (!url.startsWith(WORKER)) return route.abort();
    const u = new URL(url);
    if (u.pathname.endsWith('/records/7')) return route.fulfill({ json: { Id: 7, ta_enabled: 'Yes', ta_table_ids: JSON.stringify(ids) } });
    if (u.pathname.includes('/tables/mvg6rcw0ia5qqrx/records')) {
      leadUrls.push(url);
      if (u.searchParams.get('fields')) return route.fulfill({ status: 422, json: { msg: 'Field not found' } });
      return route.fulfill({ json: { list: [{ Id: 1, Name: 'Asha', Phone: '1', ServiceCategory: 'Package' }] } });
    }
    if (u.pathname.includes('/tables/tb/records')) return route.fulfill({ json: { list: [{ Id: 9, client_name: 'Meera', package_name: 'Bali 5N', status: 'confirmed', sell_price: 10, deposit: 10 }] } });
    if (u.pathname.includes('/tables/')) return route.fulfill({ json: { list: [] } });
    return route.fulfill({ json: { list: [] } });
  });
  const url = 'file://' + path.resolve(__dirname, '../travel-agency.html') + '?client=7&token=t&embed=1&shell=travel&tab=bookings';
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#agencyContent')).toContainText('Meera');
  await expect(page.locator('#tabs')).toBeHidden();
  // First request asks for slim fields (no ConvHistory); the 422 falls back to full rows.
  expect(leadUrls[0]).toContain('fields=');
  expect(decodeURIComponent(leadUrls[0])).not.toContain('ConvHistory');
  expect(leadUrls.some((u) => !new URL(u).searchParams.get('fields'))).toBe(true);
  // jsPDF is no longer loaded with the page.
  expect(await page.evaluate(() => typeof window.jspdf)).toBe('undefined');
  // …and loads on demand from the self-hosted copy, with autotable, when a PDF is built.
  // @ts-ignore
  await page.evaluate(() => loadJsPdf());
  expect(await page.evaluate(() => typeof window.jspdf?.jsPDF?.API?.autoTable)).toBe('function');
});

test('travel lead form and Leads filter list every service category', async ({ page }) => {
  await openTravel(page, { industry: 'travel', ta_enabled: 'Yes' });
  const expected = ['Package', 'Package + Hotel (Single)', 'Hotel', 'Family Resort', 'Couple Resort', 'Air Ticket', 'Ticket', 'Group Ticket', 'Visa', 'Global Visa',
    'Passport', 'Certificate Attestation', 'Saudi Services', 'Umrah and Hajj', 'Marketing Messages', 'Other Services'];
  const formValues = await page.locator('#fServiceCategory option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
  expect(formValues).toEqual(expected);
  const filterValues = await page.locator('#leadCategoryFilter option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
  expect(filterValues).toEqual(expected);
  // Re-applying the theme (e.g. after saving Business Setup) must not duplicate the options.
  await page.evaluate(() => { /* @ts-ignore */ applyTheme('travel'); });
  await expect(page.locator('#fServiceCategory option')).toHaveCount(expected.length + 1);
});
