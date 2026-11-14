// Phone app (m.html): Home shows the dashboard's 🏆 Weekly Arena and Staff Performance table, and a
// Leads tab lists the leads this person may see — loaded without chat transcripts.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mUrl = 'file://' + path.resolve(__dirname, '../m.html');

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const call = (by, outcome, msAgo) => ({ by, outcome, at: iso(msAgo) });
const LEADS = [
  { Id: 1, ClientId: '48', Name: 'Muhsina', Phone: '918281712019', Owner: 'riya@x.test', Score: 'Hot', Stage: 'new', Date: iso(3600e3), ConversationID: '55', CallLog: JSON.stringify([call('riya@x.test', 'Answered', 1800e3)]) },
  { Id: 2, ClientId: '48', Name: 'Fathima', Phone: '919800000002', Owner: 'riya@x.test', Stage: 'won', Date: iso(7200e3), ClosedAt: iso(600e3), CallLog: JSON.stringify([call('riya@x.test', 'Answered', 3000e3)]) },
  { Id: 3, ClientId: '48', Name: 'Arjun', Phone: '919800000003', Owner: 'arun@x.test', Stage: 'new', Date: iso(5400e3), CallLog: '' },
  { Id: 4, ClientId: '48', Name: 'Nobody Yet', Phone: '919800000004', Owner: '', Stage: 'new', Date: iso(900e3), CallLog: '' },
  { Id: 5, ClientId: '48', Name: 'Shabna', Phone: '919800000005', Owner: 'riya@x.test', Stage: 'new', Date: iso(86400e3), ConversationID: '57', CallLog: JSON.stringify([call('riya@x.test', 'No Answer', 7200e3), call('riya@x.test', 'Answered', 80000e3)]) },
];
const client = (routing) => ({
  authentik_email: 'owner@x.test', client_name: 'Couplo', team_emails: 'riya@x.test,arun@x.test',
  team_names: JSON.stringify({ 'riya@x.test': 'Riya', 'arun@x.test': 'Arun' }),
  lead_routing: JSON.stringify({ enabled: routing }),
});

async function open(page, { email = 'owner@x.test', routing = false, cols = null } = {}) {
  const leadUrls = [];
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'file:') return route.continue();
    if (url.pathname.endsWith('/session/me')) return route.fulfill({ json: { email, client: client(routing), session_token: 'fresh' } });
    if (url.pathname.endsWith('/chats/v2/counts')) return route.fulfill({ json: { unread: 0, needs: 0, mine: 0, unassigned: 0 } });
    if (url.pathname.endsWith('/chats/v2/list')) return route.fulfill({ json: { rows: [] } });
    if (/\/nocodb\/api\/v2\/tables\/[^/]+\/records$/.test(url.pathname)) {
      leadUrls.push(url);
      return route.fulfill({ json: { list: url.searchParams.get('limit') === '1' ? LEADS.slice(0, 1).map((l) => ({ ...l, ConvHistory: '[]' })) : LEADS } });
    }
    return route.abort();
  });
  await page.goto(mUrl);
  await page.evaluate((c) => {
    localStorage.clear();
    localStorage.setItem('lv_cid', '48'); localStorage.setItem('lv_session', 't');
    if (c) localStorage.setItem('lv_lead_cols', JSON.stringify(c));
  }, cols);
  await page.goto(mUrl);
  return leadUrls;
}

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test('Home shows the Weekly Arena and Staff Performance; the leads load without transcripts', async ({ page }) => {
  const urls = await open(page, { cols: ['Id', 'Name', 'Phone', 'Owner', 'Stage', 'Date', 'CallLog', 'ConvHistory'] });
  await expect(page.locator('#homeArena .csa-title')).toHaveText('🏆 Weekly Arena');
  await expect(page.locator('#homeArena .csa-row').first()).toContainText('Riya');
  await expect(page.locator('#homeStaffPerf .sp-tbl tbody tr').first()).toContainText('Riya');
  await expect(page.locator('#homeStaffPerf .section-title')).toContainText('Staff Performance');
  const full = urls.find((u) => u.searchParams.get('limit') === '2000');
  expect(full.searchParams.get('fields')).toBe('Id,Name,Phone,Owner,Stage,Date,CallLog');
  // The refreshed session token is kept, like the dashboard does.
  expect(await page.evaluate(() => localStorage.getItem('lv_session'))).toBe('fresh');
  // Period buttons re-render the table in place.
  await page.locator('#homeStaffPerf .sp-periods button', { hasText: '7 days' }).click();
  await expect(page.locator('#homeStaffPerf .sp-periods button.on')).toHaveText('7 days');
});

test('Leads tab: owner sees every lead, filters and search work, a lead opens inside the app', async ({ page }) => {
  await open(page);
  await page.locator('#nav [data-tab="leads"]').click();
  await expect(page.locator('#leadList .lead')).toHaveCount(5);
  await page.locator('#leadChips .chip', { hasText: 'Hot' }).click();
  await expect(page.locator('#leadList .lead')).toHaveCount(1);
  await expect(page.locator('#leadList .lead')).toContainText('Muhsina');
  await page.locator('#leadChips').getByRole('button', { name: 'All', exact: true }).click();
  await page.locator('#leadSearch').fill('9800000003');
  await expect(page.locator('#leadList .lead')).toHaveCount(1);
  await expect(page.locator('#leadList .lead')).toContainText('Arjun');
  await page.locator('#leadSearch').fill('');
  await page.locator('#leadList .lead', { hasText: 'Nobody Yet' }).locator('.info').click();
  await expect(page.locator('#leadSheet')).toBeVisible();
  await expect(page.locator('#leadSheet h2')).toHaveText('Nobody Yet');
  expect(page.url()).toContain('m.html');
});

test('Leads tab: a staff member with routing on sees only their own leads', async ({ page }) => {
  await open(page, { email: 'arun@x.test', routing: true });
  await page.locator('#nav [data-tab="leads"]').click();
  await expect(page.locator('#leadList .lead')).toHaveCount(1);
  await expect(page.locator('#leadList .lead')).toContainText('Arjun');
  await page.locator('#nav [data-tab="home"]').click();
  await expect(page.locator('#homeStaffPerf .section-title')).toContainText('My Performance');
});

test('the chat button on a lead opens that conversation in Chats', async ({ page }) => {
  await open(page);
  await page.locator('#nav [data-tab="leads"]').click();
  await page.locator('#leadList .lead', { hasText: 'Muhsina' }).locator('[data-act="chat"]').click();
  await expect(page.locator('#tabChats')).toBeVisible();
});

test('Home → Prime attention lists not-called and unanswered leads, each with Call and Chat', async ({ page }) => {
  await open(page);
  const card = page.locator('#attn');
  await expect(card.locator('#attnNew')).toHaveText('2');
  await expect(card.locator('#attnUnans')).toHaveText('1');
  // Not called: newest first.
  await expect(card.locator('.lead .nm')).toHaveText(['Nobody Yet', 'Arjun']);
  await card.locator('.seg button', { hasText: 'Unanswered' }).click();
  await expect(card.locator('.lead')).toHaveCount(1);
  await expect(card.locator('.lead')).toContainText('Shabna');
  await expect(card.locator('.lead')).toContainText('tried 2h ago');
  await card.locator('.lead [data-act="chat"]').click();
  await expect(page.locator('#tabChats')).toBeVisible();
  await page.goBack();
  await page.locator('#nav [data-tab="leads"]').click();
  await page.locator('#leadChips .chip', { hasText: 'Unanswered' }).click();
  await expect(page.locator('#leadList .lead')).toHaveCount(1);
  await expect(page.locator('#leadList .lead')).toContainText('No answer');
});

test('Prime attention: a staff member only sees their own leads in it', async ({ page }) => {
  await open(page, { email: 'arun@x.test', routing: true });
  await expect(page.locator('#attnNew')).toHaveText('1');
  await expect(page.locator('#attnUnans')).toHaveText('0');
  await expect(page.locator('#attn .lead .nm')).toHaveText(['Arjun']);
});
