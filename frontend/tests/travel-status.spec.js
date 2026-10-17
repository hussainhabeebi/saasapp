// Travel workspace → 📌 Status Board (frontend/travel-status.js). Same hermetic file:// setup as
// travel-view.spec.js; the Worker's NocoDB passthrough is stubbed so status saves can be checked.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';
const OWNER = 'boss@example.com';
const STAFF = 'rep@example.com';

function iso(offsetDays) {
  const d = new Date(); d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

async function boot(page, me = OWNER, saveStatus = 200) {
  const patches = [];
  const fieldsAdded = [];
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url.startsWith(WORKER + '/nocodb/api/v2/meta/tables/')) {
      if (req.method() === 'POST') { fieldsAdded.push(JSON.parse(req.postData()).title); return route.fulfill({ json: {} }); }
      return route.fulfill({ json: { columns: [{ title: 'Name' }] } });
    }
    if (url.startsWith(WORKER + '/nocodb/api/v2/tables/') && req.method() === 'PATCH') {
      patches.push(JSON.parse(req.postData()));
      return route.fulfill({ status: saveStatus, json: saveStatus === 200 ? { Id: 1 } : { msg: 'nope' } });
    }
    return route.abort();
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ OWNER, STAFF, me, yesterday }) => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    try { localStorage.removeItem('lv_travel_view_7'); } catch (e) {}
    const now = new Date().toISOString();
    // @ts-ignore
    clientId = 7; myEmail = me; sessionToken = 't';
    // @ts-ignore
    clientRecord = { industry: 'travel', ta_enabled: 'No', authentik_email: OWNER, team_emails: STAFF, team_names: JSON.stringify({ [STAFF]: 'Rita' }) };
    // @ts-ignore
    allLeads = [
      { Id: 1, Name: 'Asha', Phone: '911', Owner: STAFF, Date: now, Stage: 'new', ServiceCategory: 'Visa' },
      { Id: 2, Name: 'Ravi', Phone: '912', Owner: STAFF, Date: now, Stage: 'new', CallLog: JSON.stringify([{ outcome: 'Answered', at: now }]) },
      { Id: 3, Name: 'Meera', Phone: '913', Owner: OWNER, Date: now, Stage: 'new', TravelStatus: 'follow_up_pending', TravelFollowUpAt: yesterday },
      { Id: 4, Name: 'John', Phone: '914', Owner: '', Date: now, Stage: 'new', TravelStatus: 'booking_closed', ServiceCategory: 'Umrah and Hajj' },
    ];
    // @ts-ignore
    applyTheme('travel');
  }, { OWNER, STAFF, me, yesterday: iso(-1) });
  return { patches, fieldsAdded };
}

const tileCount = (page, label) => page.locator('.ts-tile', { hasText: label }).locator('.n');

test('status board counts every status, with auto statuses before anyone marks one', async ({ page }) => {
  await boot(page);
  await page.locator('#travelNav .dnTab[data-page="tvstatus"]').click();
  await expect(page.locator('#pageTvstatus')).toBeVisible();
  await expect(tileCount(page, 'All inquiries')).toHaveText('4');
  await expect(tileCount(page, 'New inquiry')).toHaveText('1');        // Asha — no calls
  await expect(tileCount(page, 'First call done')).toHaveText('1');    // Ravi — derived from CallLog
  await expect(tileCount(page, 'Follow up pending')).toHaveText('1');
  await expect(tileCount(page, 'Booking closed')).toHaveText('1');
  await expect(tileCount(page, 'Follow-ups due')).toHaveText('1');
  await expect(page.locator('tr[data-lead="2"]')).toContainText('auto');
  await expect(page.locator('tr[data-lead="3"] .ts-due.overdue')).toBeVisible();
  // Overdue follow-ups sort to the top.
  await expect(page.locator('.ts-tbl tbody tr').first()).toHaveAttribute('data-lead', '3');
  await page.locator('.ts-tile', { hasText: 'Booking closed' }).click();
  await expect(page.locator('.ts-tbl tbody tr')).toHaveCount(1);
  await expect(page.locator('.ts-tbl tbody tr')).toContainText('John');
});

test('marking a status saves it to the lead with who and when', async ({ page }) => {
  const { patches, fieldsAdded } = await boot(page);
  // @ts-ignore
  await page.evaluate(() => navigate('tvstatus'));
  await page.locator('tr[data-lead="1"] select.ts-sel').selectOption('first_call');
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toMatchObject({ Id: 1, TravelStatus: 'first_call', TravelStatusBy: OWNER });
  expect(patches[0].TravelStatusAt).toBeTruthy();
  expect(fieldsAdded).toEqual(['TravelStatus', 'TravelFollowUpAt', 'TravelStatusAt', 'TravelStatusBy', 'TravelStatusLog']);
  await expect(tileCount(page, 'First call done')).toHaveText('2');
  await expect(page.locator('tr[data-lead="1"]')).not.toContainText('auto');
});

test('follow up pending defaults to tomorrow and the date can be changed', async ({ page }) => {
  const { patches } = await boot(page);
  // @ts-ignore
  await page.evaluate(() => navigate('tvstatus'));
  await page.locator('tr[data-lead="2"] select.ts-sel').selectOption('follow_up_pending');
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toMatchObject({ Id: 2, TravelStatus: 'follow_up_pending', TravelFollowUpAt: iso(1) });
  await page.locator('tr[data-lead="2"] input.ts-date').fill(iso(0));
  await expect.poll(() => patches.length).toBe(2);
  expect(patches[1]).toMatchObject({ Id: 2, TravelFollowUpAt: iso(0) });
  await expect(tileCount(page, 'Follow-ups due')).toHaveText('2');
});

test('a failed save puts the old status back', async ({ page }) => {
  const { patches } = await boot(page, OWNER, 500);
  // @ts-ignore
  await page.evaluate(() => navigate('tvstatus'));
  await page.locator('tr[data-lead="4"] select.ts-sel').selectOption('cancelled');
  await expect.poll(() => patches.length).toBe(1);
  await expect(page.locator('tr[data-lead="4"] select.ts-sel')).toHaveValue('booking_closed');
});

test('Today shows a teammate only their own inquiries; the board has no Staff column', async ({ page }) => {
  await boot(page, STAFF);
  // @ts-ignore
  await page.evaluate(() => navigate('travelhome'));
  const summary = page.locator('#tvHomeBody .card', { hasText: 'Inquiry status' });
  // Rita owns Asha (new) and Ravi (first call) — Meera's overdue follow-up and John's booking aren't hers.
  await expect(summary.locator('.tv-chip')).toHaveText(['🆕 New inquiry1', '📞 First call done1']);
  await expect(summary).not.toContainText('follow-up due');
  await expect(page.locator('#tvHomeBody')).not.toContainText('Meera');
  await summary.locator('.tv-chip', { hasText: 'First call done' }).click();
  await expect(page.locator('#pageTvstatus')).toBeVisible();
  await expect(page.locator('.ts-tbl thead')).not.toContainText('Staff');
  // The full list comes back once Home is done — the board still has its own rules.
  // @ts-ignore
  expect(await page.evaluate(() => allLeads.length)).toBe(4);
});

test('Today: leads by category, with a period picker; the owner sees every lead', async ({ page }) => {
  await boot(page, OWNER);
  // @ts-ignore
  await page.evaluate(() => navigate('travelhome'));
  const report = page.locator('#tvCategoryReport');
  await expect(report.locator('tbody tr')).toHaveCount(3);
  await expect(report.locator('tbody tr', { hasText: 'Visa' }).locator('td')).toHaveText(['🛂 Visa', '1', '1', '0', '0', '0%']);
  await expect(report.locator('tfoot td')).toHaveText(['Total', '4', '4', '0', '0', '0%']);
  await report.locator('tbody tr', { hasText: 'Visa' }).click();
  await expect(page.locator('#leadCategoryFilter')).toHaveValue('Visa');
  await expect(page.locator('#leadsCategoryChips .lv-tab.active')).toContainText('Visa');
});

test('travel status and the pipeline stage move together', async ({ page }) => {
  const { patches } = await boot(page);
  const status = () => patches.filter((p) => p.TravelStatus);
  // @ts-ignore
  await page.evaluate(() => navigate('tvstatus'));
  // Booking closed → the lead is Won (and the usual won-lead bookkeeping runs: ClosedAt).
  await page.locator('tr[data-lead="1"] select.ts-sel').selectOption('booking_closed');
  await expect.poll(() => status().length).toBe(1);
  expect(status()[0]).toMatchObject({ Id: 1, TravelStatus: 'booking_closed', Stage: 'won' });
  await expect.poll(() => patches.some((p) => p.Id === 1 && p.ClosedAt)).toBe(true);
  // Back to an open status → reopened.
  await page.locator('tr[data-lead="1"] select.ts-sel').selectOption('negotiating');
  await expect.poll(() => status().length).toBe(2);
  expect(status()[1]).toMatchObject({ Id: 1, TravelStatus: 'negotiating', Stage: 'new' });
  // Cancelled → Lost; an open status on an open lead leaves Stage alone.
  await page.locator('tr[data-lead="2"] select.ts-sel').selectOption('cancelled');
  await expect.poll(() => status().length).toBe(3);
  expect(status()[2]).toMatchObject({ Id: 2, Stage: 'lost' });
  await page.locator('tr[data-lead="3"] select.ts-sel').selectOption('quote_sent');
  await expect.poll(() => status().length).toBe(4);
  expect(status()[3].Stage).toBeUndefined();
  // Marked Won elsewhere → shows Booking closed (auto).
  // @ts-ignore
  await page.evaluate(() => { allLeads.find((l) => l.Id === 3).Stage = 'won'; renderTravelStatus(); });
  await expect(page.locator('tr[data-lead="3"] select.ts-sel')).toHaveValue('booking_closed');
  await expect(page.locator('tr[data-lead="3"]')).toContainText('auto');
});

/* ── Service Category picker + Reports → 🗂️ Service Category ── */
test('the Leads table category picker saves the category on the lead', async ({ page }) => {
  const { patches, fieldsAdded } = await boot(page);
  // @ts-ignore
  await page.evaluate(() => { navigate('leads'); _leadsActiveView = 'all'; if (!_leadsTableView) toggleLeadsView(); });
  await expect(page.locator('#leadsTable thead')).toContainText('Category');
  const sel = page.locator('#leadsTable tr', { hasText: 'Ravi' }).locator('select.ts-cat');
  await expect(sel).toHaveValue('');
  await sel.selectOption('Air Ticket');
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toEqual({ Id: 2, ServiceCategory: 'Air Ticket' });
  expect(fieldsAdded).toEqual(['ServiceCategory']);
  // @ts-ignore
  expect(await page.evaluate(() => allLeads.find(l => l.Id === 2).ServiceCategory)).toBe('Air Ticket');
  // Clearing is saved too.
  await page.locator('#leadsTable tr', { hasText: 'Asha' }).locator('select.ts-cat').selectOption('');
  await expect.poll(() => patches.length).toBe(2);
  expect(patches[1]).toEqual({ Id: 1, ServiceCategory: '' });
});

test('a failed category save puts the old category back', async ({ page }) => {
  const { patches } = await boot(page, OWNER, 500);
  // @ts-ignore
  await page.evaluate(() => navigate('tvstatus'));
  await page.locator('tr[data-lead="1"] select.ts-cat').selectOption('Hotel');
  await expect.poll(() => patches.length).toBe(1);
  await expect(page.locator('tr[data-lead="1"] select.ts-cat')).toHaveValue('Visa');
  // @ts-ignore
  expect(await page.evaluate(() => allLeads.find(l => l.Id === 1).ServiceCategory)).toBe('Visa');
});

test('Edit Lead saves a cleared category and keeps one that is not in the list', async ({ page }) => {
  const { patches } = await boot(page);
  await page.evaluate(() => {
    // @ts-ignore
    allLeads.push({ Id: 5, Name: 'Old', Phone: '915', Owner: '', Date: new Date().toISOString(), Stage: 'new', ServiceCategory: 'Cruise' });
    // @ts-ignore
    window.loadAll = async () => {};
    // @ts-ignore
    openEditLead(allLeads.find(l => l.Id === 5));
  });
  await expect(page.locator('#fServiceCategory')).toHaveValue('Cruise');
  // @ts-ignore
  await page.evaluate(() => { openEditLead(allLeads.find(l => l.Id === 1)); $id('fServiceCategory').value = ''; return saveLead(); });
  await expect.poll(() => patches.find(p => p.Id === 1)).toBeTruthy();
  expect(patches.find(p => p.Id === 1).ServiceCategory).toBe('');
});

test('Reports → Service Category counts leads per category and the filter narrows reports', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    // @ts-ignore
    _rptOlder = { at: Date.now(), list: [], complete: true, loading: null };
    // @ts-ignore
    allLeads[0].Stage = 'won'; allLeads[0].DealValue = 500;
    // @ts-ignore
    navigate('reports'); renderReportsSubPage('category');
  });
  await expect(page.locator('#rptTabCategory')).toBeVisible();
  await expect(page.locator('#rptCategory')).toBeVisible();
  const row = c => page.locator('#rptCatTbl tbody tr', { hasText: c });
  await expect(row('Visa')).toContainText('100%');
  await expect(row('Umrah and Hajj')).toBeVisible();
  await expect(row('Uncategorised').locator('td').nth(1)).toHaveText('2');
  await expect(page.locator('#rptCatTbl tfoot')).toContainText('4');
  await expect(page.locator('#rptCatOwnerTbl')).toContainText('Rita');
  await page.locator('#rptCategory').selectOption('Visa');
  await expect(page.locator('#rptCatTbl tbody tr')).toHaveCount(1);
  // @ts-ignore
  expect(await page.evaluate(() => rptLeads().map(l => l.Id))).toEqual([1]);
});

/* ── Custom service categories (Settings → 🗂️ Service Categories) ── */
test('custom categories from Settings show in every picker, and can be added and removed', async ({ page }) => {
  const { patches, fieldsAdded } = await boot(page);
  // patchClient re-reads the client record to confirm the save — echo back what was patched.
  let saved = JSON.stringify(['Cruise']);
  await page.route(/\/nocodb\/api\/v2\/tables\/[^/]+\/records\/7$/, (route) => route.fulfill({ json: { Id: 7, industry: 'travel', lead_categories_custom: saved } }));
  page.on('request', (req) => { if (req.method() === 'PATCH' && /lead_categories_custom/.test(req.postData() || '')) saved = JSON.parse(req.postData()).lead_categories_custom; });
  await page.evaluate(() => {
    // @ts-ignore
    clientRecord.lead_categories_custom = JSON.stringify(['Cruise', 'Hotel']); // a duplicate of a built-in is ignored
    // @ts-ignore
    applyTheme('travel');
  });
  const values = sel => page.locator(sel + ' option').evaluateAll(os => os.map(o => o.value).filter(Boolean));
  expect((await values('#fServiceCategory')).slice(-3)).toEqual(['Marketing Messages', 'Other Services', 'Cruise']);
  expect(await values('#leadCategoryFilter')).toContain('Cruise');
  // @ts-ignore
  await page.evaluate(() => navigate('tvstatus'));
  expect(await values('tr[data-lead="1"] select.ts-cat')).toContain('Cruise');
  expect(await values('tr[data-lead="1"] select.ts-cat')).toContain('Marketing Messages');

  // Settings: add one, then remove one.
  await page.evaluate(() => { /* @ts-ignore */ navigate('settings'); /* @ts-ignore */ populateSettings(); });
  await expect(page.locator('#leadCatSettings')).toBeVisible();
  await expect(page.locator('#leadCatBuiltIn')).toContainText('Marketing Messages');
  await expect(page.locator('#leadCatCustom')).toContainText('Cruise');
  await page.locator('#leadCatNew').fill('Visa');
  await page.locator('#leadCatAddBtn').click();
  await expect(page.locator('#leadCatMsg')).toContainText('already in the list');
  await page.locator('#leadCatNew').fill('Holiday Homes');
  await page.locator('#leadCatAddBtn').click();
  await expect(page.locator('#leadCatMsg')).toContainText('Added Holiday Homes');
  expect(patches.at(-1)).toEqual({ Id: 7, lead_categories_custom: JSON.stringify(['Cruise', 'Holiday Homes']) });
  expect(fieldsAdded).toContain('lead_categories_custom');
  expect(await values('#fServiceCategory')).toContain('Holiday Homes');
  page.once('dialog', d => d.accept());
  await page.locator('#leadCatCustom button[aria-label="Remove Cruise"]').click();
  await expect(page.locator('#leadCatMsg')).toContainText('Removed Cruise');
  expect(patches.at(-1)).toEqual({ Id: 7, lead_categories_custom: JSON.stringify(['Holiday Homes']) });
  expect(await values('#fServiceCategory')).not.toContain('Cruise');
});

test('Service Categories settings are hidden for non-travel accounts', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { /* @ts-ignore */ clientRecord.industry = 'healthcare'; /* @ts-ignore */ navigate('settings'); /* @ts-ignore */ populateSettings(); });
  await expect(page.locator('#leadCatSettings')).toBeHidden();
});

test('a teammate\'s category change shows on an open dashboard without a reload, and survives a refresh', async ({ page }) => {
  await boot(page);
  await page.route(/\/nocodb\/api\/v2\/tables\/[^/]+\/records\/2\?fields=Id,ServiceCategory$/, (route) => route.fulfill({ json: { Id: 2, ServiceCategory: 'Umrah and Hajj' } }));
  // @ts-ignore
  await page.evaluate(() => { navigate('leads'); _leadsActiveView = 'all'; if (!_leadsTableView) toggleLeadsView(); });
  const sel = page.locator('#leadsTable select.ts-cat[data-lead="2"]');
  await expect(sel).toHaveValue('');
  // What the Worker broadcasts after a teammate's confirmed save.
  // @ts-ignore
  await page.evaluate(() => onLiveLeadUpdatedEvent({ type: 'lead_updated', lead_ids: [2], fields: ['ServiceCategory'], by: 'rep@example.com' }));
  await expect(sel).toHaveValue('Umrah and Hajj');
  // @ts-ignore
  expect(await page.evaluate(() => allLeads.find(l => l.Id === 2).ServiceCategory)).toBe('Umrah and Hajj');
  // The session cache a refresh paints first carries it too.
  // @ts-ignore
  const cached = await page.evaluate(() => JSON.parse(sessionStorage.getItem(_CACHE_KEY())).list.find(l => l.Id === 2).ServiceCategory);
  expect(cached).toBe('Umrah and Hajj');
});
