// CEO Bot tab (projects.html → 🤖 CEO Bot, frontend/ceo-bot.js) and its card in Reports → Team.
// Hermetic file:// setup like the other specs — Worker routes are answered by page.route stubs,
// everything else off-origin is blocked.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectsUrl = 'file://' + path.resolve(__dirname, '../projects.html') + '?client=7&token=t';
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';

const CLIENT = { Id: 7, client_name: 'Acme', authentik_email: 'boss@acme.com', team_emails: 'rahul@acme.com', team_names: '{}', ceo_bot_enabled: 'Yes' };
const CONFIG = {
  active: true, paused: false, autonomy: 'suggest', persona: { name: 'CEO Bot', language: 'English' },
  playbooks: { brief: true, reminders: true, escalation: true, standup: false, wrap: true, weekly: true, recognition: true },
  schedule: { brief: '09:00', standup: '10:00', wrap: '18:30', weekly_day: 1, weekly_time: '09:30', work_days: [1, 2, 3, 4, 5, 6], quiet_start: 21, quiet_end: 7, tz_offset_min: 330 },
  escalation: { staff_after_days: 1, admin_after_days: 2 }, staff_delay_needs_approval: true, project_scope: [], staff: {}, admin_phone: '',
  template: { name: '', lang: 'en' }, monthly_ai_cap: 300,
};
const TEAM = [
  { email: 'boss@acme.com', name: 'Anil', isAdmin: true, phone: '919800000001', standup: true, muted: false },
  { email: 'rahul@acme.com', name: 'Rahul K', isAdmin: false, phone: '919800000002', standup: true, muted: false },
];
const REPORT = { days: 30, from: '2026-09-07', to: '2026-10-06', totals: { done: 5, on_time_pct: 80, overdue: 2, blocked: 1, open: 9, created: 7, hours: 12.5 },
  members: [{ email: 'rahul@acme.com', name: 'Rahul K', is_admin: false, has_whatsapp: true, open: 4, overdue: 2, blocked: 1, done: 5, on_time_pct: 80, hours: 12.5,
    standups_asked: 5, standups_answered: 4, bot_updates: 3, nudges: 2, score: 76 }] };

async function openProjects(page, status) {
  const calls = [];
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (!url.startsWith(WORKER)) return route.abort();
    const p = new URL(url).pathname;
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    calls.push({ path: p, method: req.method(), body });
    if (p === '/session/me') return route.fulfill({ json: { client_id: 7, client: CLIENT } });
    if (p === '/pm/automation-health') return route.fulfill({ json: { active_workflows: 0, failed_jobs: 0 } });
    if (p.startsWith('/pm/')) return route.fulfill({ json: { list: [] } });
    if (p === '/support/tickets') return route.fulfill({ json: { tickets: [] } });
    if (p === '/ceo/status') return route.fulfill({ json: status });
    if (p === '/ceo/config' && req.method() === 'GET') return route.fulfill({ json: { config: CONFIG, team: TEAM, projects: [{ id: 1, name: 'Website', status: 'active' }],
      channel: { connected: true, wa_phone_id: '555', display_phone: '+91 98000 99999', has_app_secret: false, webhook_url: WORKER + '/ceo/wa/webhook/abc', verify_token: 'abc' } } });
    if (p === '/ceo/config') return route.fulfill({ json: { ok: true, config: { ...CONFIG, ...body.config } } });
    if (p === '/ceo/actions') return route.fulfill({ json: { actions: [{ id: 3, kind: 'update_task', summary: '#12 Homepage: due → 9 Oct', status: 'pending', requested_via: 'whatsapp', created_at: '2026-10-06T04:00:00Z' }] } });
    if (p === '/ceo/actions/decide') return route.fulfill({ json: { ok: true, message: '✅ Approved A3' } });
    if (p === '/ceo/chat') return route.fulfill({ json: { reply: 'Rahul has 2 overdue tasks.' } });
    if (p === '/ceo/team-report') return route.fulfill({ json: REPORT });
    if (p === '/ceo/standups') return route.fulfill({ json: { standups: [{ name: 'Rahul K', standup_date: '2026-10-06', answer: 'Banner today', answered_at: 'x' }] } });
    if (p === '/ceo/threads') return route.fulfill({ json: { threads: [{ phone: '919800000002', name: 'Rahul K', party_role: 'staff', body: 'DONE 12', direction: 'in', created_at: '2026-10-06T04:00:00Z', total: 2 }] } });
    if (p === '/ceo/messages') return route.fulfill({ json: { messages: [
      { id: 1, direction: 'in', kind: 'reply', body: 'DONE 12', status: 'received', created_at: '2026-10-06T04:00:00Z' },
      { id: 2, direction: 'out', kind: 'reply', body: '✅ Marked #12 done.', status: 'sent', created_at: '2026-10-06T04:00:01Z' }] } });
    return route.fulfill({ json: {} });
  });
  await page.goto(projectsUrl, { waitUntil: 'domcontentloaded' });
  return calls;
}

test('CEO Bot tab is hidden for staff and for accounts without the add-on', async ({ page }) => {
  await openProjects(page, { enabled: true, admin: false });
  await expect(page.locator('.viewtab[data-view="board"]')).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.locator('#ceoViewTab')).toHaveCount(0);
});

test('owner: overview, chat, approvals, chats, team report and settings save', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const calls = await openProjects(page, { enabled: true, admin: true });
  await page.locator('#ceoViewTab').click();
  await expect(page.locator('#viewCeo')).toContainText('Staff tasks only');
  await expect(page.locator('#viewCeo')).toContainText('1 change waiting for your OK');
  await expect(page.locator('#viewBoard')).toBeHidden();

  await page.fill('#ceoChatInput', "what's overdue?");
  await page.locator('#viewCeo button', { hasText: 'Send' }).first().click();
  await expect(page.locator('#ceoChatLog')).toContainText('Rahul has 2 overdue tasks.');

  await page.locator('.ceo-tab', { hasText: 'Approvals' }).click();
  await page.locator('#viewCeo button', { hasText: 'Approve' }).click();
  expect(calls.find((c) => c.path === '/ceo/actions/decide').body).toEqual({ id: 3, decision: 'approve' });

  await page.locator('.ceo-tab', { hasText: 'Chats' }).click();
  await page.locator('.ceo-thread', { hasText: 'Rahul K' }).click();
  await expect(page.locator('#ceoThreadLog')).toContainText('Marked #12 done');

  await page.locator('.ceo-tab', { hasText: 'Team report' }).click();
  await expect(page.locator('#viewCeo table')).toContainText('Rahul K');
  await expect(page.locator('#viewCeo table')).toContainText('76');
  await expect(page.locator('#viewCeo')).toContainText('Banner today');

  await page.locator('.ceo-tab', { hasText: 'Settings' }).click();
  await expect(page.locator('#viewCeo .ceo-copy').first()).toContainText('/ceo/wa/webhook/abc');
  await page.selectOption('#ceoAutonomy', 'auto_safe');
  await page.locator('[data-pb="standup"]').check();
  await page.fill('[data-phone="rahul@acme.com"]', '+91 98111 22222');
  await page.locator('#viewCeo button', { hasText: 'Save settings' }).click();
  const save = calls.filter((c) => c.path === '/ceo/config' && c.method === 'POST').pop();
  expect(save.body.config.autonomy).toBe('auto_safe');
  expect(save.body.config.playbooks.standup).toBe(true);
  expect(save.body.config.staff['rahul@acme.com'].phone).toBe('+91 98111 22222');
  expect(save.body.config.schedule.tz_offset_min).toBe(330);
});

test('Reports → Team shows the CEO Bot scorecard to the owner only', async ({ page }) => {
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('file://')) return route.continue();
    if (url.startsWith(WORKER + '/ceo/team-report')) return route.fulfill({ json: REPORT });
    if (url.startsWith(WORKER)) return route.fulfill({ json: {} });
    return route.abort();
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  const render = (rec, email) => page.evaluate(([r, e]) => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    document.getElementById('pageReports').classList.remove('hidden');
    // @ts-ignore
    clientId = 7; clientRecord = r; sessionToken = 't'; myEmail = e;
    // @ts-ignore
    renderReportsTeamReport();
  }, [rec, email]);
  await render(CLIENT, 'boss@acme.com');
  await expect(page.locator('#reportsCeoScore')).toContainText('Rahul K');
  await expect(page.locator('#reportsCeoScore')).toContainText('80% on time');
  await render(CLIENT, 'rahul@acme.com');
  await expect(page.locator('#reportsCeoScore')).toHaveCount(0);
  await render({ ...CLIENT, ceo_bot_enabled: 'No' }, 'boss@acme.com');
  await expect(page.locator('#reportsCeoScore')).toHaveCount(0);
});
