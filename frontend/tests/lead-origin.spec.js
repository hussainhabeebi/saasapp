// Lead origin colour + badge (dashboard.html leadOriginBadge/leadOriginClass): Instagram leads
// (Channel=instagram / Phone "ig:<id>") and manually added ones (CreatedVia manual/import) are
// marked in the list, table and kanban; WhatsApp leads keep the default look. Same hermetic
// file:// setup as lead-actions.spec.js.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');

const LEADS = [
  { Id: 1, Name: 'Asha', Phone: 'ig:1784001', Channel: 'instagram', Stage: 'new', Score: 'Cold' },
  { Id: 2, Name: 'Binu', Phone: '919876543210', CreatedVia: 'manual', Stage: 'new', Score: 'Cold' },
  { Id: 3, Name: 'Chitra', Phone: '919876543211', CreatedVia: 'import', Stage: 'new', Score: 'Cold' },
  { Id: 4, Name: 'Devi', Phone: '919876543212', Channel: 'whatsapp', Stage: 'new', Score: 'Cold' },
  { Id: 5, Name: 'Esha', Phone: '919876543213', Channel: 'whatsapp', CreatedVia: 'chatwoot', ConversationID: '77', Stage: 'won', Score: 'Hot' },
  { Id: 6, Name: 'Faris', Phone: '919876543214', ConversationID: '78', Stage: 'new', Score: 'Cold' },
  { Id: 7, Name: 'Gopi', Phone: '919876543215', CreatedVia: 'lead_ad', Stage: 'lost', Score: 'Cold' },
];

async function render(page, mode) {
  await page.route('**/*', (route) => (route.request().url().startsWith('file://') ? route.continue() : route.abort()));
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(([leads, mode]) => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    document.getElementById('pageLeads').classList.remove('hidden');
    const now = new Date().toISOString();
    // @ts-ignore
    allLeads = leads.map((l) => ({ ...l, Date: now }));
    if (mode === 'table') { window.setLeadsViewMode?.('list'); document.getElementById('leadsTable').style.display = 'block'; window.renderLeadsTable(); }
    else window.renderLeadsList();
  }, [LEADS, mode]);
}

test('list: Instagram and manual leads get their own badge and colour, WhatsApp stays plain', async ({ page }) => {
  await render(page, 'list');
  const row = (name) => page.locator('#leadsList .lead-item', { hasText: name });
  await expect(row('Asha')).toHaveClass(/origin-ig/);
  await expect(row('Asha').locator('.origin-badge')).toHaveText('📷 Instagram');
  await expect(row('Binu')).toHaveClass(/origin-manual/);
  await expect(row('Binu').locator('.origin-badge')).toHaveText('✍️ Manual');
  await expect(row('Chitra').locator('.origin-badge')).toHaveText('📥 Imported');
  await expect(row('Devi').locator('.origin-badge')).toHaveCount(0);
  await expect(row('Devi')).not.toHaveClass(/origin-/);
  const igEdge = await row('Asha').evaluate((el) => getComputedStyle(el).boxShadow);
  const manualEdge = await row('Binu').evaluate((el) => getComputedStyle(el).boxShadow);
  expect(igEdge).not.toBe(manualEdge);
});

test('table: the same badges and row colour', async ({ page }) => {
  await render(page, 'table');
  await expect(page.locator('#leadsTable tr', { hasText: 'Asha' })).toHaveClass(/origin-ig/);
  await expect(page.locator('#leadsTable tr', { hasText: 'Binu' }).locator('.origin-badge')).toHaveText('✍️ Manual');
  await expect(page.locator('#leadsTable tr', { hasText: 'Devi' }).locator('.origin-badge')).toHaveCount(0);
});

test('kanban card carries the origin badge', async ({ page }) => {
  await render(page, 'list');
  const html = await page.evaluate(() => [window.kbCard(allLeads[0]), window.kbCard(allLeads[1]), window.kbCard(allLeads[3])]);
  expect(html[0]).toContain('origin-ig');
  expect(html[1]).toContain('✍️ Manual');
  expect(html[2]).not.toContain('origin-badge');
});

test('a CreatedVia value NocoDB dropped right after the column was created is written again', async ({ page }) => {
  const patches = [];
  let stored = '';
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url.includes('/api/v2/meta/tables/')) return route.fulfill({ json: { columns: [{ title: 'Name' }, { title: 'CreatedVia' }] } });
    if (/\/records\/9\?/.test(url)) return route.fulfill({ json: { Id: 9, CreatedVia: stored || null } });
    if (url.includes('/records') && req.method() === 'PATCH') { const b = JSON.parse(req.postData()); patches.push(b); stored = b[0].CreatedVia; return route.fulfill({ json: [{ Id: 9 }] }); }
    return route.abort();
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => window.ensureLeadCreatedVia([9], 'manual'));
  expect(patches).toEqual([[{ Id: 9, CreatedVia: 'manual' }]]);
  // Already saved: nothing is written.
  await page.evaluate(() => window.ensureLeadCreatedVia([9], 'manual'));
  expect(patches.length).toBe(1);
});

test('chat leads are Auto (also older ones with a conversation); lead forms get their own badge', async ({ page }) => {
  await render(page, 'list');
  const row = (name) => page.locator('#leadsList .lead-item', { hasText: name });
  // Faris is open, so he's on the default list; Esha (won) and Gopi (lost) are checked directly.
  await expect(row('Faris').locator('.origin-badge')).toHaveText('🤖 Auto');
  await expect(row('Faris')).toHaveClass(/origin-auto/);
  const badge = (id) => page.evaluate((id) => window.leadOriginBadge(allLeads.find((l) => l.Id === id)), id);
  expect(await badge(5)).toContain('🤖 Auto');
  expect(await badge(7)).toContain('📋 Lead form');
});

test('Source chips count each origin and filter the list', async ({ page }) => {
  await render(page, 'list');
  const chips = page.locator('#leadsOriginChips .lv-tab');
  await expect(chips).toHaveText(['All sources', '📷 Instagram (1)', '🤖 Auto (2)', '✍️ Manual (1)', '📥 Imported (1)', '📋 Lead form (1)']);
  await chips.filter({ hasText: 'Manual' }).click();
  await expect(page.locator('#leadsList .lead-item .li-name')).toHaveText([/Binu/]);
  await page.locator('#leadsOriginChips .lv-tab', { hasText: 'Manual' }).click();
  await expect(page.locator('#leadsList .lead-item')).toHaveCount(5);
});

test('owner: older leads without a source get a one-tap backfill', async ({ page }) => {
  await render(page, 'list');
  let called = 0, sourceCalled = 0;
  await page.route('**/leads/created-via/backfill', (route) => { called++; return route.fulfill({ json: { ok: true, updated: 3, counts: { chatwoot: 1, unknown: 2 } } }); });
  await page.route('**/leads/source/backfill', (route) => { sourceCalled++; return route.fulfill({ json: { ok: true, updated: 6, counts: { WhatsApp: 4, 'Click-to-WhatsApp ad': 2 } } }); });
  await page.evaluate(() => {
    // @ts-ignore
    clientRecord = { authentik_email: 'boss@x.com' }; myEmail = 'boss@x.com'; window.loadAll = async () => {}; renderLeadsList();
  });
  // Asha (ig), Devi, Faris have no CreatedVia; none of the fixture leads has a Source column value.
  await expect(page.locator('#leadsOriginBanner')).toContainText(/\d+ leads have no recorded source yet/);
  await page.locator('#originBackfillBtn').click();
  await expect.poll(() => called).toBe(1);
  // the Source column is filled too (Click-to-WhatsApp ad / WhatsApp / Instagram / Lead form)
  await expect.poll(() => sourceCalled).toBe(1);
});

test('lead detail says how and by whom a lead was created', async ({ page }) => {
  await render(page, 'list');
  const line = await page.evaluate(() => {
    // @ts-ignore
    clientRecord = { team_emails: 'rita@x.com', team_names: JSON.stringify({ 'rita@x.com': 'Rita' }) };
    return window.leadOriginLine({ CreatedVia: 'manual', CreatedBy: 'rita@x.com', Date: '2026-10-16T08:00:00Z' });
  });
  expect(line).toBe('Created via ✍️ Manual by Rita · 16 Oct 2026');
});

test('Leads by source report: rows per origin with open / won / lost', async ({ page }) => {
  await render(page, 'list');
  const rows = await page.evaluate(() => window.leadsSourceReportRows(allLeads, 'all').map((r) => [r.key, r.total, r.open, r.won, r.lost]));
  expect(rows).toEqual([['chatwoot', 2, 1, 1, 0], ['instagram', 1, 1, 0, 0], ['manual', 1, 1, 0, 0], ['import', 1, 1, 0, 0], ['lead_ad', 1, 0, 0, 1], ['', 1, 1, 0, 0]]);
  const html = await page.evaluate(() => window.leadsSourceReportHtml(allLeads));
  expect(html).toContain('🧭 Leads by source');
  expect(html).toContain('Not recorded');
});

test('Add Lead: a double tap saves once, and a number that already exists is flagged', async ({ page }) => {
  await render(page, 'list');
  let posts = 0;
  await page.route('**/nocodb/api/v2/**', async (route) => {
    const req = route.request();
    if (req.method() === 'POST' && /\/records$/.test(new URL(req.url()).pathname)) { posts++; await new Promise((r) => setTimeout(r, 300)); return route.fulfill({ json: { Id: 99 } }); }
    if (req.url().includes('/meta/tables/')) return route.fulfill({ json: { columns: [{ title: 'CreatedVia' }] } });
    return route.fulfill({ json: { list: [], Id: 99, CreatedVia: 'manual' } });
  });
  await page.evaluate(() => {
    // @ts-ignore
    clientId = 7; clientRecord = { authentik_email: 'boss@x.com', language: 'en' }; myEmail = 'boss@x.com'; window.loadAll = async () => {};
    window.openAddLead();
  });
  await page.locator('#fName').fill('New person');
  await page.locator('#fPhone').fill('9111111111');
  await page.evaluate(() => { window.saveLead(); window.saveLead(); });
  await expect.poll(() => posts).toBe(1);
  // Same last 10 digits as Binu (919876543210) → asked first; Cancel keeps the existing lead.
  await page.evaluate(() => window.openAddLead());
  await page.locator('#fName').fill('Binu again');
  await page.locator('#fPhone').fill('9876543210');
  page.once('dialog', (d) => { expect(d.message()).toContain('already has this number'); d.dismiss(); });
  await page.evaluate(() => window.saveLead());
  await expect(page.locator('#modalDetail')).toHaveClass(/open/);
  expect(posts).toBe(1);
});
