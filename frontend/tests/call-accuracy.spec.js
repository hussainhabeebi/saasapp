// Call logging accuracy: every call a telecaller logs reaches the reports exactly once, and the
// reports show which calls were logged without dialing from the app. Hermetic file:// setup — the
// NocoDB list/record endpoints are answered from an in-memory server copy of the leads.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');

const OWNER = 'boss@example.com';
const STAFF = 'rep@example.com';
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const call = (by, msAgo, outcome = 'Answered', extra = {}) => ({ outcome, at: iso(msAgo), date: '', by, ...extra });

// server: Id → lead row as NocoDB holds it. loaded: the Ids the page's allLeads starts with.
async function boot(page, { server, loaded, failPatch = false }) {
  const patches = [];
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.protocol === 'file:') return route.continue();
    const single = url.pathname.match(/\/nocodb\/api\/v2\/tables\/[^/]+\/records\/(\d+)$/);
    const isList = /\/nocodb\/api\/v2\/tables\/[^/]+\/records$/.test(url.pathname);
    if (!single && !isList) return route.abort();
    if (req.method() === 'PATCH') {
      if (failPatch) return route.fulfill({ status: 500, json: { error: 'down' } });
      const body = req.postDataJSON();
      patches.push(body);
      Object.assign(server[body.Id] ||= {}, body);
      return route.fulfill({ json: { Id: body.Id } });
    }
    if (req.method() === 'DELETE') return route.fulfill({ json: {} });
    if (single) return route.fulfill({ json: { ...server[Number(single[1])] } });
    const rows = Object.values(server).sort((a, b) => Date.parse(b.Date) - Date.parse(a.Date));
    const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 25);
    return route.fulfill({ json: { list: rows.slice(offset, offset + limit), pageInfo: { isLastPage: offset + limit >= rows.length } } });
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ OWNER, STAFF, leads }) => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    // @ts-ignore
    myEmail = OWNER;
    // @ts-ignore
    clientRecord = { authentik_email: OWNER, client_name: 'Boss', team_emails: STAFF, team_names: JSON.stringify({ [STAFF]: 'Rita' }) };
    // @ts-ignore
    allLeads = leads;
  }, { OWNER, STAFF, leads: loaded.map((id) => ({ ...server[id] })) });
  return patches;
}

async function openReport(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    document.getElementById('pageReports').classList.remove('hidden');
    window.renderReportsSubPage('leadscalls');
  });
}
const statVal = (page, card, label) =>
  page.locator(`#${card} .stat`, { has: page.locator('.stat-lbl', { hasText: new RegExp(`^${label}$`) }) }).locator('.stat-val');

test('calls on a lead merged by the old merge ("[..]\\n[..]") are counted again', async ({ page }) => {
  const glued = JSON.stringify([call(STAFF, 1000)]) + '\n' + JSON.stringify([call(STAFF, 5000, 'No Answer'), call(OWNER, 9000)]);
  const server = { 1: { Id: 1, Name: 'Merged', Owner: STAFF, Date: iso(86400e3), CallLog: glued } };
  await boot(page, { server, loaded: [1] });
  await openReport(page);
  await expect(statVal(page, 'lcCalls', 'Total Calls Made')).toHaveText('3');
  await expect(statVal(page, 'lcCalls', 'Answered Calls')).toHaveText('2');
  await expect(statVal(page, 'lcLeads', 'Leads Not Called')).toHaveText('0');
});

test('merging duplicates keeps one valid call log with every call, newest first', async ({ page }) => {
  const server = {
    1: { Id: 1, Name: 'Main', Date: iso(86400e3), CallLog: JSON.stringify([call(STAFF, 1000), call(STAFF, 9000)]) },
    2: { Id: 2, Name: 'Dup', Date: iso(2 * 86400e3), CallLog: JSON.stringify([call(OWNER, 5000, 'No Answer')]) },
  };
  const patches = await boot(page, { server, loaded: [1, 2] });
  await page.evaluate(async () => {
    // @ts-ignore
    currentLead = allLeads[0];
    window.loadAll = async () => {};
    await window.doMerge(2);
  });
  const merged = JSON.parse(patches.find((p) => p.Id === 1).CallLog);
  expect(merged.map((c) => c.outcome)).toEqual(['Answered', 'No Answer', 'Answered']);
});

test("logging a call keeps a teammate's call saved after this tab loaded the lead", async ({ page }) => {
  const server = { 1: { Id: 1, Name: 'Shared', Owner: STAFF, Date: iso(86400e3), CallLog: '[]' } };
  const patches = await boot(page, { server, loaded: [1] });
  // A teammate logs a call on the server after this tab loaded the (empty) call log
  server[1].CallLog = JSON.stringify([call(STAFF, 60e3, 'No Answer')]);
  await page.evaluate(async () => {
    // @ts-ignore
    currentLead = allLeads[0];
    window.openCallLog();
    document.getElementById('callOutcome').value = 'Answered';
    await window.saveCall();
  });
  const saved = JSON.parse(patches.at(-1).CallLog);
  expect(saved.map((c) => [c.outcome, c.by])).toEqual([['Answered', OWNER], ['No Answer', STAFF]]);
  expect(await page.evaluate(() => parseCallLog(allLeads[0].CallLog).length)).toBe(2);
});

test('a failed save is not shown as a logged call', async ({ page }) => {
  const server = { 1: { Id: 1, Name: 'Offline', Owner: STAFF, Date: iso(86400e3), CallLog: '[]' } };
  await boot(page, { server, loaded: [1], failPatch: true });
  await page.evaluate(async () => {
    // @ts-ignore
    currentLead = allLeads[0];
    window.openCallLog();
    await window.saveCall();
  });
  await expect(page.locator('body')).toContainText('Call not saved');
  expect(await page.evaluate(() => parseCallLog(allLeads[0].CallLog).length)).toBe(0);
  await expect(page.locator('#modalCall')).toBeVisible(); // still open so it can be retried
});

test('double-tapping Save logs the call once', async ({ page }) => {
  const server = { 1: { Id: 1, Name: 'Twice', Owner: STAFF, Date: iso(86400e3), CallLog: '[]' } };
  const patches = await boot(page, { server, loaded: [1] });
  await page.evaluate(async () => {
    // @ts-ignore
    currentLead = allLeads[0];
    window.openCallLog();
    await Promise.all([window.saveCall(), window.saveCall()]);
  });
  expect(patches.filter((p) => 'CallLog' in p)).toHaveLength(1);
  expect(JSON.parse(server[1].CallLog)).toHaveLength(1);
});

test('calls are marked dialed vs typed in, and the report flags the typed-in ones per telecaller', async ({ page }) => {
  const server = {
    1: { Id: 1, Name: 'Dialed', Owner: OWNER, Date: iso(86400e3), CallLog: '[]' },
    2: { Id: 2, Name: 'Typed', Owner: OWNER, Date: iso(86400e3), CallLog: '[]' },
    3: { Id: 3, Name: 'Rita typed', Owner: STAFF, Date: iso(86400e3),
      CallLog: JSON.stringify([call(STAFF, 3000, 'Answered', { src: 'manual' }), call(STAFF, 4000, 'Answered', { src: 'dial', secs: 95 }), call(STAFF, 5000)]) },
  };
  await boot(page, { server, loaded: [1, 2, 3] });
  const [dialed, typed] = await page.evaluate(async () => {
    // Lead 1: tapped the app's Call button (tel: navigation stubbed out), then logged
    window.openModal = () => {};
    _callInProgress[1] = { start: Date.now() - 42000 };
    // @ts-ignore
    currentLead = allLeads[0];
    await window.saveCall();
    // Lead 2: "+ Log Call" with no Call tap
    // @ts-ignore
    currentLead = allLeads[1];
    await window.saveCall();
    return [parseCallLog(allLeads[0].CallLog)[0], parseCallLog(allLeads[1].CallLog)[0]];
  });
  expect(dialed.src).toBe('dial');
  expect(dialed.secs).toBeGreaterThanOrEqual(42);
  expect(typed.src).toBe('manual');

  await openReport(page);
  await expect(page.locator('#lcManualNote')).toContainText('2 of these 5 calls were logged without dialing');
  // Last column = Logged Without Dialing; Rita's legacy call (no src) is not flagged
  await expect(page.locator('#lcAgents tbody tr', { hasText: 'Rita' }).locator('td').last()).toHaveText('⚠️ 1');
  await expect(page.locator('#lcAgents tbody tr', { hasText: OWNER }).locator('td').last()).toHaveText('⚠️ 1');
});

test('Power Dial: "Log outcome" without calling is marked typed in; after Call it is dialed; a double press logs once', async ({ page }) => {
  const server = {
    1: { Id: 1, Name: 'PD One', Phone: '919000000001', Owner: OWNER, Date: iso(86400e3), CallLog: '[]' },
    2: { Id: 2, Name: 'PD Two', Phone: '919000000002', Owner: OWNER, Date: iso(86400e3), CallLog: '[]' },
  };
  const patches = await boot(page, { server, loaded: [1, 2] });
  await page.evaluate(async () => {
    _pdQueue = allLeads.slice(); _pdIdx = 0; _pdCallStart = null;
    await Promise.all([window.pdLogOutcome('Answered', { toast: false }), window.pdLogOutcome('Answered', { toast: false })]);
    _pdCallStart = Date.now() - 30000; // tapped Call 30s ago
    await window.pdLogOutcome('No Answer', { toast: false });
  });
  const one = JSON.parse(server[1].CallLog), two = JSON.parse(server[2].CallLog);
  expect(one).toHaveLength(1);
  expect(one[0].src).toBe('manual');
  expect(two[0].src).toBe('dial');
  expect(two[0].secs).toBeGreaterThanOrEqual(30);
  expect(patches.filter((p) => 'CallLog' in p)).toHaveLength(2);
});

test('report pages in leads beyond the loaded list so their calls are counted', async ({ page }) => {
  const server = {
    1: { Id: 1, Name: 'New', Owner: OWNER, Date: iso(3600e3), CallLog: JSON.stringify([call(OWNER, 1000)]) },
    2: { Id: 2, Name: 'Old called', Owner: STAFF, Date: iso(400 * 86400e3), CallLog: JSON.stringify([call(STAFF, 399 * 86400e3, 'No Answer')]) },
    3: { Id: 3, Name: 'Old uncalled', Owner: STAFF, Date: iso(500 * 86400e3), CallLog: '' },
  };
  await boot(page, { server, loaded: [1] }); // allLeads only has the newest lead
  await openReport(page);
  await expect(page.locator('#lcCoverage')).toHaveText('Includes all 3 leads on the account.');
  await expect(statVal(page, 'lcLeads', 'Total Leads')).toHaveText('3');
  await expect(statVal(page, 'lcCalls', 'Total Calls Made')).toHaveText('2');
  await expect(statVal(page, 'lcCalls', 'Missed / Unanswered Calls')).toHaveText('1');
  await expect(statVal(page, 'lcLeads', 'Leads Not Called')).toHaveText('1');
});
