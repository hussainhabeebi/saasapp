// Lead meetings (dashboard.html "LEAD MEETINGS"): a lead row keeps just Call + ⋯ — the meeting
// actions live in ⋯ and the lead only gets a small badge. Same hermetic file:// setup as
// lead-actions.spec.js / meetings.spec.js; the Worker's /meetings/* routes are page.route stubs.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';

async function setup(page, states = {}) {
  const calls = [];
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url.startsWith(WORKER + '/meetings/')) {
      const p = new URL(url).pathname;
      const body = req.postData() ? JSON.parse(req.postData()) : null;
      calls.push({ path: p, body });
      if (p === '/meetings/lead-states') return route.fulfill({ json: { states } });  // remembers saves below, like the Worker
      if (p === '/meetings/config') return route.fulfill({ json: { config: { links: [], settings: {}, enabled: false } } });
      if (p === '/meetings/points') return route.fulfill({ json: { weights: { scheduled: 25, held: 20 }, reps: {}, events: [] } });
      if (p === '/meetings/manual') {
        const st = body.status === 'agreed' ? { state: 'pending', id: 9, active: true } : { state: 'scheduled', id: 9, active: true, start_at: body.start_at, title: body.title };
        states = { ...states, [body.lead_id]: st };
        return route.fulfill({ json: { ok: true, id: 9, state: st, notified: body.notify ? true : undefined } });
      }
      if (p === '/meetings/cancel') return route.fulfill({ json: { ok: true } });
      if (p === '/meetings/lead') return route.fulfill({ json: { meetings: [], state: null } });
    }
    return route.abort();
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    document.getElementById('pageLeads').classList.remove('hidden');
    // @ts-ignore
    clientId = 7; clientRecord = { Id: 7 }; sessionToken = 't'; myEmail = 'rita@biz.com';
    // @ts-ignore
    window.saveTasksState = async () => {};
    // @ts-ignore
    allLeads = [{ Id: 42, Name: 'Asha K', Phone: '919876543210', Stage: 'new', Score: 'Warm', Date: new Date().toISOString() }];
    // @ts-ignore
    await window.mtgLoadLeadStates(true);
    // @ts-ignore
    window.renderLeadsList();
  });
  return calls;
}

test('no meeting: the row stays Call + ⋯; ⋯ offers Mark meeting scheduled and Meeting pending', async ({ page }) => {
  await setup(page);
  const row = page.locator('#leadsList .lead-item').first();
  await expect(row.locator('.mtg-badge')).toHaveCount(0);
  await expect(row.locator('.li-actions > button')).toHaveCount(1);
  await row.locator('.lead-more-btn').click();
  await expect(page.getByRole('menuitem', { name: '📅 Mark meeting scheduled' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '🕓 Meeting pending' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '❌ Cancel meeting' })).toHaveCount(0);
});

test('mark meeting scheduled → form → saved, badge appears', async ({ page }) => {
  const calls = await setup(page);
  await page.locator('#leadsList .lead-more-btn').first().click();
  await page.getByRole('menuitem', { name: '📅 Mark meeting scheduled' }).click();
  await expect(page.locator('#modalMeeting')).toBeVisible();
  await page.fill('#mtgFTitle', 'Site visit');
  await page.selectOption('#mtgFMode', 'in_person');
  await page.fill('#mtgFWhere', 'MG Road office');
  await page.click('#mtgModalSave');
  await expect(page.locator('#leadsList .mtg-badge[data-mtg="scheduled"]')).toBeVisible();
  const save = calls.find((c) => c.path === '/meetings/manual');
  expect(save.body).toMatchObject({ lead_id: 42, status: 'scheduled', title: 'Site visit', mode: 'in_person', location: 'MG Road office', notify: true });
  await expect(page.locator('#leadsList .mtg-badge[data-mtg="scheduled"]')).toBeVisible();
});

test('a scheduled lead shows 📅 badge; ⋯ offers Reschedule / Cancel instead of Mark scheduled', async ({ page }) => {
  const start = new Date(Date.now() + 86400e3).toISOString();
  await setup(page, { 42: { state: 'scheduled', id: 3, active: true, start_at: start, title: 'Demo' } });
  await expect(page.locator('#leadsList .mtg-badge')).toContainText('📅 Tomorrow');
  await page.locator('#leadsList .lead-more-btn').first().click();
  await expect(page.getByRole('menuitem', { name: '✏️ Reschedule meeting' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '❌ Cancel meeting' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '📅 Mark meeting scheduled' })).toHaveCount(0);
});

test('meeting pending marks the lead agreed; Meeting filter narrows the list', async ({ page }) => {
  const calls = await setup(page, { 42: { state: 'pending', id: 3, active: true } });
  await expect(page.locator('#leadsList .mtg-badge')).toContainText('🕓 Meeting pending');
  await page.selectOption('#leadMeetingFilter', 'scheduled');
  await expect(page.locator('#leadsList .lead-item')).toHaveCount(0);
  await page.selectOption('#leadMeetingFilter', 'pending');
  await expect(page.locator('#leadsList .lead-item')).toHaveCount(1);
  expect(calls.some((c) => c.path === '/meetings/lead-states')).toBe(true);
});

test('Log Call → Next step "Meeting pending" marks it', async ({ page }) => {
  const calls = await setup(page);
  await page.evaluate(() => {
    // @ts-ignore
    window.appendCallLog = async () => {};
    // @ts-ignore
    window.claimLeadIfUnowned = async () => {};
    // @ts-ignore
    window.renderDetailCalls = () => {};
    // @ts-ignore
    window.openCallLog(42);
  });
  await page.selectOption('#callNextStep', 'pending');
  await page.evaluate(() => window.saveCall());
  await expect.poll(() => calls.find((c) => c.path === '/meetings/manual')?.body?.status).toBe('agreed');
});
