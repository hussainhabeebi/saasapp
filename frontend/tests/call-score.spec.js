// Call & Convert score (call-score.js): the Leads page's personal strip + "Attend Next" card, and
// Reports → 📞 Calls & Conversions. Same hermetic file:// setup as lead-actions.spec.js — no
// backend, the page's own global render functions are driven directly with seeded leads.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');

const OWNER = 'boss@example.com';
const STAFF = 'rep@example.com';

async function boot(page, { me = OWNER } = {}) {
  await page.route('**/*', (route) => (route.request().url().startsWith('file://') ? route.continue() : route.abort()));
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ me, OWNER, STAFF }) => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    const now = Date.now();
    const iso = (msAgo) => new Date(now - msAgo).toISOString();
    const call = (by, msAgo, outcome = 'Answered') => ({ outcome, at: iso(msAgo), date: '', by, duration: 3 });
    // @ts-ignore
    myEmail = me;
    // @ts-ignore
    clientRecord = { authentik_email: OWNER, client_name: 'Boss', team_emails: STAFF, team_names: JSON.stringify({ [STAFF]: 'Rita' }),
      bot_config: JSON.stringify({ call_targets: { default: { calls: 2, won: 1 }, users: {} }, power_hour: { enabled: false } }) };
    // @ts-ignore
    allLeads = [
      // Rita: two calls today (target 2 → hit), one conversion
      { Id: 1, Name: 'Won Lead', Phone: '919000000001', Owner: STAFF, Stage: 'won', Score: 'Hot', Date: iso(3 * 3600e3), ClosedAt: iso(60e3),
        CallLog: JSON.stringify([call(STAFF, 2 * 3600e3)].reverse()) },
      { Id: 2, Name: 'No Answer Lead', Phone: '919000000002', Owner: STAFF, Stage: 'new', Date: iso(5 * 86400e3),
        CallLog: JSON.stringify([call(STAFF, 4 * 86400e3, 'No Answer'), call(STAFF, 3 * 86400e3, 'No Answer'), call(STAFF, 3600e3, 'No Answer')].reverse()) },
      // Boss's own leads: one fresh Hot uncalled (attend next), one stale Hot uncalled 2 days (leakage + penalty)
      { Id: 3, Name: 'Fresh Hot', Phone: '919000000003', Owner: OWNER, Stage: 'new', Score: 'Hot', Date: iso(60e3) },
      { Id: 4, Name: 'Stale Hot', Phone: '919000000004', Owner: OWNER, Stage: 'new', Score: 'Hot', Date: iso(2 * 86400e3) },
      { Id: 5, Name: 'Called Already', Phone: '919000000005', Owner: OWNER, Stage: 'new', Date: iso(0), CallLog: JSON.stringify([call(OWNER, 600e3)]) },
    ];
  }, { me, OWNER, STAFF });
}

test('Leads page: personal strip and one Attend Next card with a single Call button', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    document.getElementById('pageLeads').classList.remove('hidden');
    window.renderLeadsMomentumStrip();
  });
  const strip = page.locator('#leadsMomentumStrip .cs-strip');
  await expect(strip).toContainText('1/2 calls');
  await expect(strip).toContainText('0/1 converted');
  // 1 answered call today (+15) minus 1 Hot lead uncalled 24h+ (−10)
  await expect(strip).toContainText('5 pts');

  const card = page.locator('#leadsMomentumStrip .cs-next');
  await expect(card).toHaveCount(1);
  // Both never called + Hot — the one that arrived a minute ago comes first (speed to lead)
  await expect(card).toContainText('Fresh Hot');
  await expect(card).toContainText('+30 if answered'); // answered +15, plus +15 for calling within 5 min
  await expect(card).toContainText('if converted');
  await expect(card.locator('.call-btn-wrap')).toHaveCount(1); // the card's only action
  await expect(card.locator('.call-main')).toBeVisible();
});

test('a staff member only sees their own numbers in the report', async ({ page }) => {
  await boot(page, { me: STAFF });
  await page.evaluate(() => {
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    document.getElementById('pageReports').classList.remove('hidden');
    window.renderReportsSubPage('calls');
  });
  const scorecard = page.locator('#reportsContent table.leads-tbl').first();
  await expect(scorecard.locator('tbody tr')).toHaveCount(1);
  await expect(scorecard).toContainText('Rita');
  await expect(page.locator('#reportsContent')).not.toContainText('Daily targets');
  await expect(page.locator('#reportsContent')).toContainText("You're #1 of 2");
});

test('owner report: scorecard, funnel, leakage and target editor', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    document.getElementById('pageReports').classList.remove('hidden');
    window.renderReportsSubPage('calls');
  });
  const content = page.locator('#reportsContent');
  const scorecard = content.locator('table.leads-tbl').first();
  await expect(scorecard.locator('tbody tr')).toHaveCount(2);
  const rita = scorecard.locator('tbody tr', { hasText: 'Rita' });
  // 4 calls, 1 answered, 1 converted out of 2 leads called
  await expect(rita.locator('td').nth(2)).toHaveText('4');
  await expect(rita.locator('td').nth(3)).toHaveText('25%');
  await expect(rita.locator('td').nth(5)).toHaveText('1');
  await expect(rita.locator('td').nth(6)).toHaveText('50%');

  await expect(content).toContainText('Call-to-convert funnel');
  await expect(content.locator('.card', { hasText: 'Hot leads not called in 24h+' })).toContainText('Stale Hot');
  await expect(content.locator('.card', { hasText: '3+ No Answers' })).toContainText('No Answer Lead');

  // Targets: save a per-user override through patchClient
  await page.evaluate(() => {
    // @ts-ignore
    window.patchClient = async (f) => { window.__saved = JSON.parse(f.bot_config); };
  });
  await content.locator('tr[data-email="rep@example.com"] .cs-tgt-calls').fill('40');
  await content.getByRole('button', { name: 'Save targets' }).click();
  await expect(page.locator('#csTgtMsg')).toHaveText('✓ Saved');
  const saved = await page.evaluate(() => window.__saved.call_targets);
  expect(saved).toEqual({ default: { calls: 2, won: 1 }, users: { 'rep@example.com': { calls: 40 } } });
});

test('CSV export picks up the report tables', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    document.getElementById('pageReports').classList.remove('hidden');
    window.renderReportsSubPage('calls');
  });
  const download = page.waitForEvent('download');
  await page.evaluate(() => window.exportReportCsv());
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^report-calls-/);
});

// Home → 🏆 Weekly Arena. Seeds calls at fixed offsets from the current week's start (Sunday) so
// the test doesn't depend on which weekday it runs.
async function bootArena(page, { me = OWNER } = {}) {
  await boot(page, { me });
  await page.evaluate(({ OWNER, STAFF }) => {
    const MANU = 'manu@example.com';
    // @ts-ignore
    clientRecord.team_emails = `${STAFF},${MANU}`;
    // @ts-ignore
    clientRecord.team_names = JSON.stringify({ [STAFF]: 'Rita', [MANU]: 'Manu' });
    const wk = window.csWeekStart(0).getTime(), lastWk = window.csWeekStart(-1).getTime();
    const at = (base, mins) => new Date(base + mins * 60000).toISOString();
    const calls = (by, base, n, outcome = 'Answered') => Array.from({ length: n }, (_, i) => ({ outcome, at: at(base, 10 + i), by }));
    let id = 100;
    const lead = (owner, base, callList, extra = {}) => ({ Id: id++, Name: 'L' + id, Phone: '91900000' + id, Owner: owner, Stage: 'new',
      Date: at(base, 0), CallLog: JSON.stringify(callList.slice().reverse()), ...extra });
    // @ts-ignore
    allLeads = [
      // This week: Manu 4 answered (60), Rita 1 conversion + 1 answered (65 + 15 = 80 w/o Hot), Boss 2 no-answers (6)
      lead(MANU, wk, calls(MANU, wk, 4)),
      lead(STAFF, wk, calls(STAFF, wk, 1), { Stage: 'won', ClosedAt: at(wk, 60) }),
      lead(OWNER, wk, calls(OWNER, wk, 2, 'No Answer')),
      // Last week: Manu converted → last week's champion
      lead(MANU, lastWk, calls(MANU, lastWk, 1), { Stage: 'won', ClosedAt: at(lastWk, 60) }),
    ];
  }, { OWNER, STAFF });
  await page.evaluate(() => window.renderHome());
}

test('Home arena: hero, quests, champion, league list, badges', async ({ page }) => {
  await bootArena(page);
  const arena = page.locator('#homeArena');
  await expect(arena).toBeVisible();
  // Boss: 6 pts, Rookie tier, #3 of 3 scorers; Manu (60) is 55 pts ahead → within reach, so the chase message shows
  await expect(arena.locator('.csa-pts')).toContainText('6');
  await expect(arena.locator('.csa-ring-in')).toContainText('#3');
  await expect(arena.locator('.csa-sub')).toContainText('Rookie');
  await expect(arena.locator('.csa-line')).toContainText('55 pts to pass Manu');
  await expect(arena.locator('.csa-today .csa-chip')).toHaveCount(3);
  await expect(arena.locator('.csa-champ-line')).toContainText('Manu');
  // badges & rules are tucked behind "more"
  await expect(arena.locator('.csa-badges')).toBeHidden();
  await arena.locator('.csa-more summary').click();
  const rows = arena.locator('.csa-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Rita');
  await expect(rows.nth(0)).toContainText('65');
  await expect(rows.nth(1)).toContainText('Manu');
  await expect(rows.nth(2)).toHaveClass(/me/);
  await expect(arena.locator('.csa-badge', { hasText: 'Closer' })).toContainText('Rita');
  await expect(arena.locator('.csa-badge', { hasText: 'Call Machine' })).toContainText('Manu');
});

test('Home arena: zero-point teammates are grouped, emails become names, big gaps show a tier goal', async ({ page }) => {
  await bootArena(page);
  await page.evaluate(() => {
    // @ts-ignore
    clientRecord.team_emails += ',sona.k@aiingo.com';
    // Rita and Manu each convert 2 more leads → too big a gap for Boss to chase
    const wk = window.csWeekStart(0).getTime();
    for (let i = 0; i < 4; i++) allLeads.push({ Id: 900 + i, Name: 'W' + i, Phone: '9190000009' + i, Owner: i % 2 ? 'manu@example.com' : 'rep@example.com', Stage: 'won', Date: new Date(wk).toISOString(), ClosedAt: new Date(wk + 3600e3).toISOString() });
    window.renderHome();
  });
  const arena = page.locator('#homeArena');
  await expect(arena.locator('.csa-idle')).toContainText('1 yet to score');
  await expect(arena.locator('.csa-idle .csa-av')).toHaveText('SK');
  await expect(arena).not.toContainText('sona.k@aiingo.com');
  await expect(arena.locator('.csa-line')).toContainText('to 🥉 Bronze');
});

test('Home arena: a solo account sees its own progress and an invite, no league', async ({ page }) => {
  await bootArena(page);
  await page.evaluate(() => {
    // @ts-ignore
    clientRecord.team_emails = '';
    window.renderHome();
  });
  const arena = page.locator('#homeArena');
  await expect(arena.locator('.csa-row')).toHaveCount(0);
  await expect(arena.locator('.csa-pts')).toContainText('6');
  await expect(arena).toContainText('Add teammates');
});

test('tasks & projects earn points: on-time/priority bonus, project finish, duplicates counted once, overdue penalty', async ({ page }) => {
  await bootArena(page);
  const r = await page.evaluate(() => {
    const MANU = 'manu@example.com', OWNER = 'boss@example.com';
    const wk = window.csWeekStart(0).getTime();
    const iso = (ms) => new Date(ms).toISOString();
    const day = (ms) => window.csDayKey(ms);
    const tomorrow = day(Date.now() + 86400e3), longAgo = '2020-01-01';
    // Projects tool (D1): project 7 has two tasks, both done by Manu → finished
    // @ts-ignore — top-level `let` in call-score.js, not a window property
    _csWork = {
      at: Date.now(),
      projects: [{ id: 7, name: 'Website revamp', status: 'active' }],
      tasks: [
        { id: 1, project_id: 7, title: 'Design', assignee_email: MANU, status: 'done', done_at: iso(wk + 3600e3), due_date: tomorrow, priority: 'high' },
        { id: 2, project_id: 7, title: 'Build', assignee_email: MANU, status: 'done', done_at: iso(wk + 7200e3), due_date: '', priority: 'medium' },
        // same task as the dashboard one below (copied into Projects on create) — not done here
        { id: 3, project_id: 0, title: 'Send quote', assignee_email: OWNER, status: 'todo', due_date: '', priority: 'medium' },
        // overdue, still open
        { id: 4, project_id: 0, title: 'Old chore', assignee_email: OWNER, status: 'todo', due_date: longAgo, priority: 'low' },
      ],
    };
    // Dashboard Tasks list: the done copy of "Send quote"
    // @ts-ignore
    clientRecord.manual_tasks = JSON.stringify({ items: [{ id: 'a', title: 'Send quote', assignee_email: OWNER, status: 'done', completed_at: iso(wk + 3600e3) }] });
    // @ts-ignore
    _csCache = null;
    const range = window.csWeekRange(0);
    const manu = window.csUserStats(MANU, range), boss = window.csUserStats(OWNER, range);
    return { manuTasks: manu.tasks, manuProjects: manu.projects, manuOnTime: manu.tasksOnTime, bossTasks: boss.tasks,
      manuTaskPts: window.csEvents().filter((e) => e.by === MANU && (e.kind === 'task' || e.kind === 'project')).reduce((s, e) => s + e.pts, 0),
      bossOverdue: window.csTodaySummary(OWNER).overdue };
  });
  // Design: 10 + 5 on time + 5 high = 20; Build: 10; project finished: +30
  expect(r).toEqual({ manuTasks: 2, manuProjects: 1, manuOnTime: 1, bossTasks: 1, manuTaskPts: 60, bossOverdue: 1 });

  await page.evaluate(() => window.renderHome());
  const arena = page.locator('#homeArena');
  await expect(arena.locator('.csa-chip.warn')).toContainText('1 overdue');
});

test('first call within 5 minutes and power-hour calls earn double', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(() => {
    const now = Date.now(), h = new Date().getHours();
    // power hour = the current hour, effective since yesterday
    // @ts-ignore
    clientRecord.bot_config = JSON.stringify({ power_hour: { enabled: true, start: h, end: h + 1, since: new Date(now - 86400e3).toISOString() } });
    // @ts-ignore
    allLeads = [{ Id: 50, Name: 'Fast', Phone: '91900', Owner: 'rep@example.com', Stage: 'new', Date: new Date(now - 60e3).toISOString(),
      CallLog: JSON.stringify([{ outcome: 'Answered', at: new Date(now - 10e3).toISOString(), by: 'rep@example.com' }]) }];
    // @ts-ignore
    _csCache = null;
    const evs = window.csEvents().filter((e) => e.leadId === 50);
    return { kinds: evs.map((e) => e.kind).sort(), pts: evs.reduce((s, e) => s + e.pts, 0), active: window.csPowerState().active };
  });
  expect(r).toEqual({ kinds: ['answered', 'fast', 'power'], pts: 45, active: true });
  await page.evaluate(() => window.renderHome());
  await expect(page.locator('#homeArena .csa-power')).toContainText('2× points');
});

test('weekly team goal bar and personal-best celebration', async ({ page }) => {
  await bootArena(page);
  const msg = await page.evaluate(() => {
    // @ts-ignore
    clientRecord.bot_config = JSON.stringify({ power_hour: { enabled: false }, team_goal: { won: 5 } });
    const now = Date.now(), lastWeek = now - 8 * 86400e3, me = 'boss@example.com';
    const calls = (base, n) => Array.from({ length: n }, (_, i) => ({ outcome: 'No Answer', at: new Date(base + i * 60e3).toISOString(), by: me }));
    // best day so far: 6 calls last week; today: 7 calls → new record
    // @ts-ignore
    allLeads.push({ Id: 700, Name: 'PB1', Phone: '1', Owner: me, Stage: 'new', Date: new Date(lastWeek).toISOString(), CallLog: JSON.stringify(calls(lastWeek, 6).reverse()) });
    // @ts-ignore
    allLeads.push({ Id: 701, Name: 'PB2', Phone: '2', Owner: me, Stage: 'new', Date: new Date(now - 3600e3).toISOString(), CallLog: JSON.stringify(calls(now - 8 * 60e3, 7).reverse()) });
    // @ts-ignore
    _csCache = null;
    window.renderHome();
    return window.csCheckRecords();
  });
  expect(msg).toContain('New record! 7 calls in a day');
  await expect(page.locator('#homeArena .csa-goal')).toContainText('1/5 conversions');
  await expect(page.locator('#homeArena .csa-sub')).toContainText('best 6 calls/day');
});

test('new-lead alert: banner with 5-minute 2× countdown, Call button, dismiss', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.csNewLeadAlert({ Id: 3, Name: 'Fresh Hot', Phone: '919000000003', Date: new Date(Date.now() - 60e3).toISOString() }, 'new'));
  const alert = page.locator('#csLeadAlert');
  await expect(alert).toHaveClass(/show/);
  await expect(alert).toContainText('Fresh Hot');
  await expect(alert).toContainText('2× points');
  await expect(alert.locator('.cs-alert-timer')).toHaveText(/⏱ [34]:\d\d/);
  await expect(alert.locator('a.cs-alert-call')).toHaveAttribute('href', 'tel:+919000000003');
  await alert.locator('.cs-alert-x').click();
  await expect(alert).not.toHaveClass(/show/);
});
