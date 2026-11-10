// Lead detail → 📝 Notes (dashboard.html renderDetailNotes / addNote / doMerge). Same hermetic
// file:// setup as travel-status.spec.js: the Worker is stubbed so saves can be checked.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';
const OWNER = 'boss@example.com';
const STAFF = 'rep@example.com';

async function boot(page, lead = {}) {
  const patches = [];
  // What the "NocoDB" lead record holds — PATCHes change it, GETs read it.
  const stored = { Id: 1, NotesList: lead.NotesList || '' };
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url.startsWith(WORKER + '/nocodb/api/v2/meta/tables/')) return route.fulfill({ json: { columns: [{ title: 'Name' }] } });
    if (url.startsWith(WORKER + '/nocodb/api/v2/tables/') && req.method() === 'PATCH') {
      const b = JSON.parse(req.postData()); patches.push(b);
      if (b.Id === 1) Object.assign(stored, b);
      return route.fulfill({ json: { Id: b.Id } });
    }
    if (url.startsWith(WORKER + '/nocodb/api/v2/tables/') && /\/records\/1\b/.test(url)) return route.fulfill({ json: stored });
    return route.abort();
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ OWNER, STAFF, lead }) => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    // @ts-ignore
    clientId = 7; myEmail = OWNER; sessionToken = 't';
    // @ts-ignore
    clientRecord = { authentik_email: OWNER, team_emails: STAFF, team_names: JSON.stringify({ [STAFF]: 'Rita' }) };
    // @ts-ignore
    allLeads = [{ Id: 1, Name: 'Asha', Phone: '911', Owner: OWNER, Date: new Date().toISOString(), Stage: 'new', ...lead }];
    // @ts-ignore
    claimLeadIfUnowned = async () => {};
  }, { OWNER, STAFF, lead });
  return { patches, stored };
}

test('two notes typed quickly are saved one after the other and both stay', async ({ page }) => {
  await boot(page);
  const order = [];
  let saved = [];
  let inFlight = 0, maxInFlight = 0;
  await page.route(WORKER + '/chats/v2/note', async (route) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    const b = route.request().postDataJSON(); order.push(b.text);
    await new Promise((r) => setTimeout(r, 150));
    const n = { text: b.text, author: OWNER, ts: new Date().toISOString() };
    saved = [...saved, n];
    inFlight--;
    return route.fulfill({ json: { ok: true, note: n, notes: saved } });
  });
  // @ts-ignore
  await page.evaluate(() => openDetail(1));
  await page.locator('#noteInput').fill('Called, busy');
  await page.locator('#noteInput').press('Control+Enter');
  await expect(page.locator('#noteInput')).toHaveValue('');
  await page.locator('#noteInput').fill('Send Bali package');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect.poll(() => order).toEqual(['Called, busy', 'Send Bali package']);
  expect(maxInFlight).toBe(1);
  await expect(page.locator('#detailNotes .note-item:not(.saving)')).toHaveCount(2);
  await expect(page.locator('#detailNotes .note-item').first()).toContainText('Send Bali package');
  await expect(page.locator('#detailNotesCount')).toHaveText('2');
});

test('when the server refuses the note, it is saved straight to the lead without losing a teammate\'s note', async ({ page }) => {
  const teammate = { text: 'Teammate note', author: STAFF, ts: '2026-01-01T00:00:00.000Z' };
  const { stored } = await boot(page);
  stored.NotesList = JSON.stringify([teammate]); // added after this page loaded the lead
  await page.route(WORKER + '/chats/v2/note', (route) => route.fulfill({ status: 404, json: { error: 'Conversation not found' } }));
  // @ts-ignore
  await page.evaluate(() => openDetail(1));
  await page.locator('#noteInput').fill('Wants a sea-view room');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect.poll(() => JSON.parse(stored.NotesList || '[]').map((n) => n.text)).toEqual(['Wants a sea-view room', 'Teammate note']);
  await expect(page.locator('#detailNotes .note-item')).toContainText(['Wants a sea-view room', 'Teammate note']);
  expect(stored.NotesList).not.toContain('_saving');
});

test('a note that fails to save is put back in the box', async ({ page }) => {
  await boot(page);
  await page.route(WORKER + '/chats/v2/note', (route) => route.fulfill({ status: 500, json: { error: 'boom' } }));
  // @ts-ignore
  await page.evaluate(() => openDetail(1));
  await page.locator('#noteInput').fill('Do not lose me');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(page.locator('#noteInput')).toHaveValue('Do not lose me');
  await expect(page.locator('#detailNotes')).not.toContainText('Do not lose me');
});

test('the Edit Lead note and the spam reason are shown on top of the notes', async ({ page }) => {
  await boot(page, {
    Notes: 'Met at the travel expo',
    HandoverOutcome: 'Spam', SpamReason: 'Fake / wrong number: shop number',
    NotesList: JSON.stringify([{ text: 'Called twice', author: STAFF, ts: new Date().toISOString() }]),
  });
  // @ts-ignore
  await page.evaluate(() => openDetail(1));
  const items = page.locator('#detailNotes .note-item');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toHaveClass(/spam/);
  await expect(items.nth(0)).toContainText('Fake / wrong number: shop number');
  await expect(items.nth(1)).toHaveClass(/pinned/);
  await expect(items.nth(1)).toContainText('Met at the travel expo');
  await expect(items.nth(2)).toContainText('Called twice');
  await expect(items.nth(2)).toContainText('Rita');
});

test('long note lists show the newest five with "Show all"', async ({ page }) => {
  const list = Array.from({ length: 8 }, (_, i) => ({ text: 'note ' + i, ts: new Date(Date.UTC(2026, 0, i + 1)).toISOString() }));
  await boot(page, { NotesList: JSON.stringify(list) });
  // @ts-ignore
  await page.evaluate(() => openDetail(1));
  await expect(page.locator('#detailNotes .note-item')).toHaveCount(5);
  await expect(page.locator('#detailNotes .note-item').first()).toContainText('note 7');
  await page.getByRole('button', { name: 'Show all 8 notes' }).click();
  await expect(page.locator('#detailNotes .note-item')).toHaveCount(8);
});

test('merging two leads keeps both notes lists as one readable list', async ({ page }) => {
  const { patches } = await boot(page, { NotesList: JSON.stringify([{ text: 'mine', ts: '2026-02-01T00:00:00.000Z' }]) });
  await page.route(WORKER + '/nocodb/api/v2/tables/**', (route) => route.request().method() === 'DELETE' ? route.fulfill({ json: {} }) : route.fallback());
  const merged = await page.evaluate(async () => {
    // @ts-ignore
    allLeads.push({ Id: 2, Name: 'Asha dup', Phone: '911', Notes: 'old box note', NotesList: JSON.stringify([{ text: 'theirs', ts: '2026-03-01T00:00:00.000Z' }]) });
    // @ts-ignore
    currentLead = allLeads[0];
    // @ts-ignore
    await doMerge(2).catch(() => {});
  });
  const p = patches.find((x) => x.Id === 1 && 'NotesList' in x);
  const texts = JSON.parse(p.NotesList).map((n) => n.text);
  expect(texts.slice(0, 2)).toEqual(['theirs', 'mine']);
  expect(texts[2]).toContain('old box note');
});
