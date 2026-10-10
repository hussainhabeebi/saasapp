// Chats v2 (chats.html against the Worker's /chats/v2/* API — see cloudflare-worker/chats-v2.js):
// paged list from the D1 read model with server-side views and counts, row badges, the thread with
// sender attribution / activity events / unread divider, header actions, canned responses, the
// 24-hour lock and the background sync. Hermetic file:// setup like the other specs; the v2 API is
// faked in page.route.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chatsUrl = 'file://' + path.resolve(__dirname, '../chats.html') + '?client=48&token=t';
const minsAgo = m => new Date(Date.now() - m * 60000).toISOString();
const ME = 'owner@x.test', SHAFNA = 'shafna@x.test';

function conv(id, over = {}) {
  return { lead_id: id, client_id: 48, channel: 'whatsapp', name: `Lead ${id}`, phone: `9198000000${String(id).padStart(2, '0')}`, conv_id: String(500 + id), inbox_id: '9',
    status: 'open', snoozed_until: null, handover: 'No', handover_by: '', assignee_email: '', priority: 0, labels: '', labels_key: ',', pinned: 0,
    unread_count: 0, last_read_at: minsAgo(9999), last_message_id: id, last_message_at: minsAgo(id), last_message_preview: `hello ${id}`,
    last_message_dir: 'in', last_sender: 'customer', last_customer_at: minsAgo(id), waiting_since: null, synced: 1, updated_at: minsAgo(60), ...over };
}

async function open(page, { rows, thread = {}, failBootstrap = false, clock = false } = {}) {
  const calls = { list: [], act: [], thread: [], nocodbList: 0, canned: [] };
  const state = {
    rows: rows || [
      conv(1, { name: 'Asha', unread_count: 2, last_read_at: minsAgo(20), waiting_since: minsAgo(70), assignee_email: SHAFNA, labels: 'Hot, Kerala, VIP', labels_key: ',hot,kerala,vip,', handover: 'Yes', handover_by: SHAFNA }),
      conv(2, { name: 'Binu', waiting_since: minsAgo(20), last_message_dir: 'out', last_sender: 'bot', last_message_preview: 'Our price is AED 375' }),
      conv(3, { name: 'Chitra', status: 'resolved' }),
    ],
    updated: [],
  };
  const messages = thread.messages || [
    { id: 11, role: 'user', content: 'Hi', ts: minsAgo(40), sender_type: 'customer' },
    { id: 12, role: 'assistant', content: '**Welcome!** How can I help?', ts: minsAgo(39), sender_type: 'bot' },
    { id: 13, role: 'system', kind: 'event', content: 'Assigned to Shafna by Boss', ts: minsAgo(30), sender_type: 'system' },
    { id: 14, role: 'assistant', content: 'I can help with that', ts: minsAgo(29), sender_type: 'agent', sender_name: 'Shafna', sender_email: SHAFNA },
    { id: 15, role: 'user', content: 'Price please', ts: minsAgo(10) },
    { id: 16, role: 'user', content: 'And delivery?', ts: minsAgo(9) },
  ];
  if (clock) await page.clock.install();
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.protocol === 'file:') return route.continue();
    const p = url.pathname;
    if (p.endsWith('/session/me')) return route.fulfill({ json: { email: ME, client: { authentik_email: ME, team_emails: SHAFNA, team_names: JSON.stringify({ [SHAFNA]: 'Shafna' }) } } });
    if (p.endsWith('/chats/v2/bootstrap')) {
      if (failBootstrap) return route.fulfill({ status: 503, json: { error: 'down' } });
      return route.fulfill({ json: { version: 'v1', me: { email: ME, staff: false, locked: false }, agents: [{ email: ME, name: 'Boss' }, { email: SHAFNA, name: 'Shafna' }],
        labels: ['Hot'], canned: [{ id: 1, shortcut: 'price-list', body: 'Hi {{name}}, here is our price list' }, { id: 2, shortcut: 'order', body: 'Your order {{order_id}} is ready' }],
        settings: { sla_warn_min: 15, sla_breach_min: 60 },
        views: [{ id: 7, name: 'Hot leads', shared: 1, filter: { all: [{ f: 'label', op: 'has', v: 'Hot' }] } }],
        macros: [{ id: 3, name: 'Mark as Hot lead', ops: [{ op: 'label_add', args: { label: 'Hot' } }, { op: 'assign', args: { email: SHAFNA } }] }] } });
    }
    if (p.endsWith('/chats/v2/counts')) return route.fulfill({ json: { all: 3, unread: 1, needs: 1, mine: 0, unassigned: 1, pending: 0, snoozed: 0, resolved: 1, unread_by_channel: { whatsapp: 1, instagram: 0 } } });
    if (p.endsWith('/chats/v2/list')) {
      const q = Object.fromEntries(url.searchParams);
      calls.list.push(q);
      if (q.updated_since !== undefined) return route.fulfill({ json: { rows: state.updated } });
      let rs = state.rows.filter(r => (q.view === 'resolved' ? r.status === 'resolved' : q.view === 'unassigned' ? !r.assignee_email && r.status !== 'resolved' : r.status !== 'snoozed'));
      if (q.handler === 'human') rs = rs.filter(r => r.handover === 'Yes');
      if (q.filter) { calls.filter = JSON.parse(q.filter); rs = rs.filter(r => r.labels_key.includes(',hot,')); }
      if (q.channel === 'whatsapp' || q.channel === 'instagram') rs = rs.filter(r => r.channel === q.channel);
      rs.sort((a, b) => b.last_message_at.localeCompare(a.last_message_at));
      const start = q.cursor ? Number(q.cursor) : 0, limit = Number(q.limit || 40);
      return route.fulfill({ json: { rows: rs.slice(start, start + limit), cursor: start + limit < rs.length ? String(start + limit) : null } });
    }
    if (p.endsWith('/chats/v2/ai')) {
      const b = req.postDataJSON();
      calls.ai = (calls.ai || []).concat([b]);
      if (b.op === 'rewrite') return route.fulfill({ json: { text: 'Hello! Happy to help 😊' } });
      if (b.op === 'suggest') return route.fulfill({ json: { suggestions: ['The price is AED 375.', 'Can I call you?', 'Let me check and revert.'] } });
      if (b.op === 'translate') return route.fulfill({ json: { text: 'And what about delivery?' } });
      if (b.op === 'summary') return route.fulfill({ json: { summary: '• Asha wants a price\n• Asked about delivery' } });
    }
    if (/\/nocodb\/api\/v2\/tables\/[^/]+\/records$/.test(p) && req.method() === 'PATCH') { calls.patch = (calls.patch || []).concat([req.postDataJSON()]); return route.fulfill({ json: {} }); }
    if (p.endsWith('/chats/v2/schedule')) {
      if (req.method() === 'POST') { calls.schedule = (calls.schedule || []).concat([req.postDataJSON()]); return route.fulfill({ json: { ok: true } }); }
      return route.fulfill({ json: { items: (calls.schedule || []).map((x, i) => ({ id: i + 1, text: x.text, send_at: x.send_at, status: 'scheduled' })) } });
    }
    if (p.endsWith('/pm/tasks')) { calls.task = req.postDataJSON(); return route.fulfill({ json: { ok: true } }); }
    if (p.endsWith('/chats/v2/send-probe')) return route.fulfill({ json: {} });
    if (p.endsWith('/chat/send')) { calls.send = (calls.send || []).concat([req.postDataJSON()]); return route.fulfill({ json: { ok: true } }); }
    if (p.endsWith('/chats/v2/thread')) {
      calls.thread.push(Object.fromEntries(url.searchParams));
      const row = state.rows.find(r => String(r.lead_id) === url.searchParams.get('lead_id'));
      return route.fulfill({ json: { messages, has_more: false, before: null, conversation: row } });
    }
    if (p.endsWith('/chats/v2/act')) {
      const body = req.postDataJSON();
      calls.act.push(body);
      const out = state.rows.filter(r => body.ids.map(String).includes(String(r.lead_id))).map(r => {
        const n = { ...r, updated_at: new Date().toISOString() };
        if (body.op === 'assign') n.assignee_email = body.args.email;
        if (body.op === 'handler') { n.handover = body.args.mode === 'human' ? 'Yes' : 'No'; n.handover_by = body.args.mode === 'human' ? ME : ''; }
        if (body.op === 'snooze') { n.status = 'snoozed'; n.snoozed_until = body.args.until; }
        if (body.op === 'resolve') n.status = 'resolved';
        if (body.op === 'mark_read') n.unread_count = 0;
        if (body.op === 'label_add') { const l = n.labels ? n.labels.split(', ') : []; if (!l.includes(body.args.label)) l.push(body.args.label); n.labels = l.join(', '); n.labels_key = ',' + l.map(x => x.toLowerCase()).join(',') + ','; }
        if (body.op === 'priority') n.priority = body.args.value;
        Object.assign(r, n);
        return n;
      });
      return route.fulfill({ json: { ok: true, rows: out, events: {} } });
    }
    if (p.endsWith('/chats/v2/canned')) { calls.canned.push(req.postDataJSON()); return route.fulfill({ json: { ok: true } }); }
    if (/\/nocodb\/api\/v2\/tables\/[^/]+\/records$/.test(p)) { calls.nocodbList++; return route.fulfill({ json: { list: [] } }); }
    if (/\/nocodb\/api\/v2\/tables\/[^/]+\/records\/\d+$/.test(p)) return route.fulfill({ json: { NotesList: JSON.stringify([{ text: 'Prefers calls after 6pm', author: 'Shafna' }]), Email: 'asha@example.com', Destination: 'Dubai', Budget: '50000', Source: 'Instagram ad' } });
    if (p.endsWith('/chats/v2/rum')) return route.fulfill({ json: { ok: true } });
    return route.abort();
  });
  await page.goto(chatsUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#app')).toBeVisible();
  return { calls, state };
}

test('the list comes from the v2 API with row badges, never the NocoDB lead list', async ({ page }) => {
  const { calls } = await open(page);
  // "All" includes resolved chats, as it always has; only snoozed ones are tucked away.
  await expect(page.locator('#list .contact .name')).toHaveText(['Asha', 'Binu', 'Chitra']);
  expect(calls.nocodbList).toBe(0);
  expect(calls.list[0]).toMatchObject({ view: 'all', channel: 'whatsapp', sort: 'newest' });
  const asha = page.locator('#list .contact', { hasText: 'Asha' });
  await expect(asha.locator('.hnd')).toHaveText('👤');
  await expect(asha.locator('.asg')).toHaveText('S');
  await expect(asha.locator('.wait')).toHaveClass(/breach/);
  await expect(asha.locator('.badge')).toHaveText('2');
  await expect(asha.locator('.lbl')).toHaveText(['Hot', 'Kerala', '+1']);
  const binu = page.locator('#list .contact', { hasText: 'Binu' });
  await expect(binu.locator('.hnd')).toHaveText('🤖');
  await expect(binu.locator('.wait')).toHaveClass(/warn/);
  await expect(binu.locator('.preview')).toContainText('🤖 Our price is AED 375');
  await expect(page.locator('#filters .pill')).toHaveText(['All3', 'Unread1', 'Needs you1', 'Mine0', 'Unassigned1', 'Pending0', 'Snoozed0', 'Resolved1', 'Hot leads']);
});

test('tabs and the bot/human filter are server views', async ({ page }) => {
  const { calls } = await open(page);
  await page.locator('#filters .pill', { hasText: 'Resolved' }).click();
  await expect(page.locator('#list .contact .name')).toHaveText(['Chitra']);
  expect(calls.list.at(-1).view).toBe('resolved');
  await page.locator('#filters .pill', { hasText: 'All' }).click();
  await page.locator('#segRow .pill', { hasText: 'Human' }).click();
  await expect(page.locator('#list .contact .name')).toHaveText(['Asha']);
  expect(calls.list.at(-1)).toMatchObject({ view: 'all', handler: 'human' });
});

test('a long list is virtualised and pages in as you scroll', async ({ page }) => {
  const rows = Array.from({ length: 130 }, (_, i) => conv(i + 1));
  const { calls } = await open(page, { rows });
  await expect(page.locator('#list .contact').first()).toContainText('Lead 1');
  expect(await page.locator('#list .contact').count()).toBeLessThan(40);
  for (let i = 0; i < 6; i++) await page.locator('#list').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect.poll(() => calls.list.filter(q => q.cursor).length).toBeGreaterThanOrEqual(2);
  await page.locator('#list').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(page.locator('#list .contact', { hasText: 'Lead 130' })).toBeVisible();
  expect(await page.locator('#list .contact').count()).toBeLessThan(40);
});

test('the thread shows who sent each reply, activity events and an unread divider', async ({ page }) => {
  const { calls } = await open(page);
  await page.locator('#list .contact', { hasText: 'Asha' }).click();
  await expect(page.locator('#thread .bubble-row')).toHaveCount(5);
  await expect(page.locator('#thread .who')).toHaveText(['🤖 AI Bot', 'Shafna']);
  await expect(page.locator('#thread .bubble b', { hasText: 'Welcome!' })).toBeVisible();
  await expect(page.locator('#thread .event')).toContainText('Assigned to Shafna by Boss');
  await expect(page.locator('#unreadDiv')).toHaveText('2 unread messages');
  await expect.poll(() => calls.act.find(a => a.op === 'mark_read')).toMatchObject({ ids: [1] });
  await expect(page.locator('#list .contact', { hasText: 'Asha' }).locator('.badge')).toHaveCount(0);
});

test('header: take over from the bot, assign, and snooze from Resolve ▾', async ({ page }) => {
  const { calls } = await open(page);
  await page.locator('#list .contact', { hasText: 'Binu' }).click();
  await expect(page.locator('#botPill')).toContainText('Bot active');
  await page.locator('#botPill').click();
  await expect(page.locator('#botPill')).toContainText('Human');
  expect(calls.act.at(-1)).toMatchObject({ op: 'handler', ids: [2], args: { mode: 'human' } });

  await page.locator('#assignBtn').click();
  await page.locator('#asgQ').fill('shaf');
  await page.locator('#ddMenu button', { hasText: 'Shafna' }).click();
  await expect(page.locator('#assignBtn')).toContainText('Shafna');
  expect(calls.act.at(-1)).toMatchObject({ op: 'assign', args: { email: SHAFNA } });

  await page.locator('.split button').nth(1).click();
  await page.locator('#ddMenu button', { hasText: '1 hour' }).click();
  const snooze = calls.act.at(-1);
  expect(snooze.op).toBe('snooze');
  const mins = (Date.parse(snooze.args.until) - Date.now()) / 60000;
  expect(mins).toBeGreaterThan(55);
  expect(mins).toBeLessThan(65);
  await expect(page.locator('#list .contact', { hasText: 'Binu' })).toHaveCount(0);
});

test('typing / offers canned responses; Enter inserts with {{name}} filled, unknown variables block sending', async ({ page }) => {
  await open(page);
  await page.locator('#list .contact', { hasText: 'Binu' }).click();
  const box = page.locator('#msg');
  await box.fill('');
  await box.pressSequentially('/pri');
  await expect(page.locator('#cannedPanel button')).toHaveCount(1);
  await box.press('Enter');
  await expect(box).toHaveValue('Hi Binu, here is our price list');
  await box.fill('');
  await box.pressSequentially('/order');
  await box.press('Enter');
  await expect(box).toHaveValue('Your order {{order_id}} is ready');
  await page.locator('#actionBtn').click();
  await expect(page.locator('#toast')).toContainText('Fill in {{order_id}}');
  await expect(box).toHaveValue('Your order {{order_id}} is ready');
});

test('outside the 24-hour window free text is locked to templates; notes still work', async ({ page }) => {
  await open(page, { rows: [conv(5, { name: 'Dev', last_customer_at: minsAgo(60 * 30), last_message_at: minsAgo(60 * 30) })],
    thread: { messages: [{ id: 1, role: 'user', content: 'Hello?', ts: minsAgo(60 * 30) }] } });
  await page.locator('#list .contact', { hasText: 'Dev' }).click();
  await expect(page.locator('#windowBar')).toBeVisible();
  await expect(page.locator('#msg')).toBeDisabled();
  await expect(page.locator('#msg')).toHaveAttribute('placeholder', /Session expired/);
  await page.locator('#noteMode').click();
  await expect(page.locator('#msg')).toBeEnabled();
  await page.locator('#replyMode').click();
  await expect(page.locator('#msg')).toBeDisabled();
});

test('changed chats are pulled in by the background sync', async ({ page }) => {
  const { state, calls } = await open(page, { clock: true });
  await expect(page.locator('#list .contact .name')).toHaveText(['Asha', 'Binu', 'Chitra']);
  state.updated = [conv(2, { name: 'Binu', last_message_at: new Date(Date.now() + 1000).toISOString(), last_message_preview: 'New message!', unread_count: 1, updated_at: new Date().toISOString() })];
  await page.clock.runFor(61000);
  await expect.poll(() => calls.list.some(q => q.updated_since !== undefined)).toBe(true);
  await expect(page.locator('#list .contact .name')).toHaveText(['Binu', 'Asha', 'Chitra']);
  await expect(page.locator('#list .contact', { hasText: 'Binu' }).locator('.preview')).toContainText('New message!');
});

test('if the v2 API is unavailable, Chats falls back to the v1 lead list', async ({ page }) => {
  const { calls } = await open(page, { failBootstrap: true });
  await expect.poll(() => calls.nocodbList).toBeGreaterThan(0);
  await expect(page.locator('#list .empty-list')).toBeVisible();
});

test('labels: pick or create from the header; filter the list by label', async ({ page }) => {
  const { calls } = await open(page);
  await page.locator('#list .contact', { hasText: 'Binu' }).click();
  await page.locator('#labelBtn').click();
  await page.locator('#lblQ').fill('Payment due');
  await page.locator('#ddMenu button', { hasText: 'Create' }).click();
  expect(calls.act.at(-1)).toMatchObject({ op: 'label_add', ids: [2], args: { label: 'Payment due' } });
  await expect(page.locator('#labelBtn')).toContainText('Payment due');
  await expect(page.locator('#list .contact', { hasText: 'Binu' }).locator('.lbl')).toHaveText(['Payment due']);
  await page.locator('#prioBtn').click();
  await page.locator('#ddMenu button', { hasText: 'Urgent' }).click();
  expect(calls.act.at(-1)).toMatchObject({ op: 'priority', args: { value: 4 } });
  await expect(page.locator('#list .contact', { hasText: 'Binu' }).locator('.prio.p4')).toBeVisible();
  await page.locator('#labelFilterBtn').click();
  await page.locator('#ddMenu button', { hasText: 'Hot' }).click();
  await expect.poll(() => calls.list.at(-1).labels).toBe('Hot');
  await expect(page.locator('#list .contact .name')).toHaveText(['Asha']);
});

test('bulk: select rows, then resolve them in one go; right-click opens the row menu', async ({ page }) => {
  const { calls } = await open(page);
  await page.locator('#list .contact', { hasText: 'Asha' }).hover();
  await page.locator('#list .contact', { hasText: 'Asha' }).locator('.ck').click();
  await page.locator('#list .contact', { hasText: 'Binu' }).click(); // in selection mode a click selects
  await expect(page.locator('#bulkBar b')).toHaveText('2 selected');
  await page.locator('#bulkBar button', { hasText: 'Resolve' }).click();
  expect(calls.act.at(-1)).toMatchObject({ op: 'resolve', ids: ['1', '2'] });
  await expect(page.locator('#bulkBar')).toHaveCount(0);
  await page.locator('#filters .pill', { hasText: 'Resolved' }).click();
  await page.locator('#list .contact', { hasText: 'Chitra' }).click({ button: 'right' });
  await page.locator('#ddMenu button', { hasText: 'Reopen' }).click();
  expect(calls.act.at(-1)).toMatchObject({ op: 'reopen', ids: ['3'] });
});

test('send & resolve, clickable phone numbers and emails, and the 24-hour countdown', async ({ page }) => {
  const { calls } = await open(page, { thread: { messages: [
    { id: 1, role: 'user', content: 'Call me on +91 98765 43210 or mail asha@example.com', ts: minsAgo(90) },
  ] } });
  await page.locator('#list .contact', { hasText: 'Binu' }).click();
  await expect(page.locator('#thread a[href="tel:+919876543210"]')).toHaveText('+91 98765 43210');
  await expect(page.locator('#thread a[href="mailto:asha@example.com"]')).toBeVisible();
  await expect(page.locator('#winTimer')).toContainText(/23h \d+m/);
  await page.locator('#msg').fill('Done, sent the quote');
  await page.locator('#msg').press('Control+Enter');
  await expect.poll(() => (calls.send || []).length).toBe(1);
  await expect.poll(() => calls.act.some(a => a.op === 'resolve' && a.ids[0] === 2)).toBe(true);
});

test('search in conversation highlights matches and steps through them', async ({ page }) => {
  await open(page);
  await page.locator('#list .contact', { hasText: 'Asha' }).click();
  await page.locator('[title="Search in conversation"]').first().click();
  await page.locator('#threadSearchInput').fill('help');
  await expect(page.locator('#thread mark')).toHaveCount(2);
  await expect(page.locator('#tsCount')).toHaveText('2/2');
  await page.locator('#threadSearchInput').press('Enter');
  await expect(page.locator('#tsCount')).toHaveText('1/2');
  await expect(page.locator('#thread mark.cur')).toHaveCount(1);
});

test('keyboard: J/K move between chats, E resolves', async ({ page }) => {
  const { calls } = await open(page);
  await page.locator('#list .contact', { hasText: 'Asha' }).click();
  await page.locator('#thread').click();
  await page.keyboard.press('j');
  await expect(page.locator('.chat-name')).toHaveText('Binu');
  await page.keyboard.press('k');
  await expect(page.locator('.chat-name')).toHaveText('Asha');
  await page.keyboard.press('e');
  await expect.poll(() => calls.act.at(-1)).toMatchObject({ op: 'resolve', ids: [1] });
});

test('AI: suggested replies when a customer waits on a person, ✨ rewrite with undo, translate', async ({ page }) => {
  const { calls } = await open(page);
  await page.locator('#list .contact', { hasText: 'Asha' }).click();
  await expect(page.locator('#suggestRow button')).toHaveText(['The price is AED 375.', 'Can I call you?', 'Let me check and revert.']);
  await page.locator('#suggestRow button').first().click();
  await expect(page.locator('#msg')).toHaveValue('The price is AED 375.');
  await page.locator('#msg').fill('hi how can help');
  await page.locator('#aiBtn').click();
  await page.locator('#ddMenu button', { hasText: 'Make friendlier' }).click();
  await expect(page.locator('#msg')).toHaveValue('Hello! Happy to help 😊');
  expect(calls.ai.find(a => a.op === 'rewrite')).toMatchObject({ mode: 'friendlier', text: 'hi how can help' });
  await page.locator('#aiUndo button').click();
  await expect(page.locator('#msg')).toHaveValue('hi how can help');
  const row = page.locator('#thread .bubble-row', { hasText: 'And delivery?' });
  await row.hover();
  await row.locator('[data-act="translate"]').click();
  await expect(row.locator('.tr')).toContainText('And what about delivery?');
  expect(calls.ai.find(a => a.op === 'translate')).toMatchObject({ target: 'en', message_id: 16 });
});

test('no AI suggestions for a chat the bot is handling', async ({ page }) => {
  const { calls } = await open(page);
  await page.locator('#list .contact', { hasText: 'Binu' }).click();
  await expect(page.locator('#thread .bubble-row').first()).toBeVisible();
  await expect(page.locator('#suggestRow')).toBeHidden();
  expect((calls.ai || []).filter(a => a.op === 'suggest')).toHaveLength(0);
});

test('contact sidebar: edit fields, see details and notes, summarise, add a note', async ({ page }) => {
  const { calls } = await open(page);
  await page.locator('#list .contact', { hasText: 'Asha' }).click();
  await page.locator('#infoBtn').click();
  const panel = page.locator('#infoPanel');
  await expect(panel.locator('input[data-k="Email"]')).toHaveValue('asha@example.com');
  await expect(panel.locator('input[data-k="Destination"]')).toHaveValue('Dubai');
  await expect(panel).toContainText('Prefers calls after 6pm');
  await panel.locator('input[data-k="Name"]').fill('Asha Menon');
  await panel.locator('input[data-k="Name"]').press('Tab');
  await expect.poll(() => (calls.patch || []).at(-1)).toMatchObject({ Id: 1, Name: 'Asha Menon' });
  await expect(page.locator('#list .contact .name').first()).toHaveText('Asha Menon');
  await panel.locator('button', { hasText: 'Summarise this chat' }).click();
  await expect(panel.locator('.sum')).toContainText('Asha wants a price');
  await panel.locator('#infoNote').fill('VIP — offer free upgrade');
  await panel.locator('#infoNote').press('Enter');
  await expect.poll(() => (calls.patch || []).at(-1)?.NotesList || '').toContain('VIP — offer free upgrade');
});

test('location and contact cards; a failed send says why', async ({ page }) => {
  const { calls } = await open(page, { thread: { messages: [
    { id: 1, role: 'user', content: '', ts: minsAgo(5), attachment: { kind: 'location', lat: 9.93, lng: 76.26, name: 'Marine Drive', url: 'https://maps.google.com/?q=9.93,76.26' } },
    { id: 2, role: 'user', content: '', ts: minsAgo(4), attachment: { kind: 'contacts', name: 'Ravi', phone: '+91 98470 00000' } },
  ] } });
  await page.route('**/chat/send', r => r.fulfill({ status: 502, json: { error: '(#131047) Re-engagement message' } }));
  await page.locator('#list .contact', { hasText: 'Binu' }).click();
  await expect(page.locator('#thread .card', { hasText: 'Marine Drive' })).toHaveAttribute('href', 'https://maps.google.com/?q=9.93,76.26');
  await expect(page.locator('#thread .card', { hasText: 'Ravi' }).locator('a', { hasText: 'WhatsApp' })).toHaveAttribute('href', 'https://wa.me/919847000000');
  await page.locator('#msg').fill('hello');
  await page.locator('#msg').press('Enter');
  await expect(page.locator('#thread .fail-why')).toHaveText('Not delivered · 24-hour window closed — send a template');
});

test('All channels shows a channel badge; saved views and the filter builder query the server', async ({ page }) => {
  const { calls } = await open(page, { rows: [conv(1, { name: 'Asha', labels: 'Hot', labels_key: ',hot,' }), conv(2, { name: 'Insta Ian', channel: 'instagram' })] });
  await expect(page.locator('#list .contact .name')).toHaveText(['Asha']);
  await page.locator('#allChannelPill').click();
  await expect(page.locator('#list .contact .name')).toHaveText(['Asha', 'Insta Ian']);
  await expect(page.locator('#list .contact', { hasText: 'Insta Ian' }).locator('.ch-badge')).toHaveText('📸');
  await page.locator('#filters .view-pill', { hasText: 'Hot leads' }).click();
  await expect(page.locator('#list .contact .name')).toHaveText(['Asha']);
  expect(calls.filter).toEqual({ all: [{ f: 'label', op: 'has', v: 'Hot' }] });
  await page.locator('#filters .view-pill', { hasText: 'Hot leads' }).click();
  await page.locator('#filterBtn').click();
  await page.locator('#ddMenu button', { hasText: 'Apply' }).click();
  await expect.poll(() => calls.filter?.all?.[0]?.f).toBe('label');
});

test('macros run their steps in order; schedule, forward and create a task', async ({ page }) => {
  const { calls } = await open(page);
  await page.locator('#list .contact', { hasText: 'Binu' }).click();
  await page.locator('#infoBtn').click();
  await page.locator('#infoPanel button', { hasText: 'Mark as Hot lead' }).click();
  await expect.poll(() => calls.act.slice(-2).map(a => a.op)).toEqual(['label_add', 'assign']);
  await page.locator('#infoBtn').click();
  await page.locator('#msg').fill('Reminder: your visa appointment is tomorrow');
  await page.locator('#sendMore').click();
  await page.locator('#ddMenu button', { hasText: 'Schedule' }).last().click();
  await expect.poll(() => (calls.schedule || []).length).toBe(1);
  expect(calls.schedule[0]).toMatchObject({ lead_id: 2, text: 'Reminder: your visa appointment is tomorrow' });
  await expect(page.locator('#schedBar')).toContainText('Reminder: your visa');
  await expect(page.locator('#msg')).toHaveValue('');
  const row = page.locator('#thread .bubble-row', { hasText: 'I can help with that' });
  await row.hover();
  await row.locator('[data-act="task"]').click();
  await page.locator('#ddMenu button', { hasText: 'Create' }).click();
  await expect.poll(() => calls.task).toMatchObject({ lead_id: 2, title: 'Follow up: I can help with that', assignee_email: ME });
  await row.hover();
  await row.locator('[data-act="forward"]').click();
  await page.locator('#fwdQ').fill('asha');
  await page.locator('#ddMenu button', { hasText: 'Asha' }).click();
  await expect.poll(() => (calls.send || []).at(-1)).toMatchObject({ lead_id: 1, text: 'I can help with that' });
});

test('@mention picker in internal notes', async ({ page }) => {
  await open(page);
  await page.locator('#list .contact', { hasText: 'Binu' }).click();
  await page.locator('#noteMode').click();
  await page.locator('#msg').pressSequentially('Please call @sha');
  await expect(page.locator('#cannedPanel button')).toHaveText([/@Shafna/]);
  await page.locator('#msg').press('Enter');
  await expect(page.locator('#msg')).toHaveValue('Please call @Shafna ');
});
