// Shopify order notifications: WhatsApp templates sent through Chatwoot (find/create the customer's
// conversation), auto-created Order Received template, per-send log for Ecom → 🔔 Notifications.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  shopifyNotifyPhone, shopifyNotifyParams, shopifyNotifyContent, shopifyNotifyTemplateStatus, shopifyNotifyTemplateBody,
  shopifyNotifyDeliveryStatus, shopifyNotifyStats, shopifySendNotification, shopifyEnsureNotifyTemplate, shopifyNotifyHandleRoute,
  SHOPIFY_TEMPLATE_PRESETS,
} from './shopify-notify.js';

function d1(db){
  const prep=(sql)=>{
    let args=[];
    const st={
      bind(...a){ args=a; return st; },
      async run(){ const r=db.prepare(sql).run(...args); return {meta:{changes:Number(r.changes), last_row_id:Number(r.lastInsertRowid)}}; },
      async all(){ return {results:db.prepare(sql).all(...args)}; },
      async first(){ return db.prepare(sql).get(...args)||null; },
    };
    return st;
  };
  return {prepare:prep, async batch(list){ for(const st of list) await st.run(); }};
}

const PRESET = SHOPIFY_TEMPLATE_PRESETS.received;
const APPROVED = [{ name: PRESET.name, language: 'en_US', status: 'APPROVED', components: [{ type: 'BODY', text: PRESET.body }] }];
const order = { vars: { customer_name: 'Asha', order_number: '#1001', total: '₹567', items: "3x Black Men's trunk (28)", store_name: 'Yuva' },
  meta: { phone: '+91 98765 43210', order: '#1001', ref: '5001', customer: 'Asha K', country: 'IN' } };

function setup({ templates = APPROVED, config = { received: { name: PRESET.name, lang: 'en_US', params: PRESET.params } }, settings = {}, contacts = [], convs = [], metaCreate = { ok: true } } = {}) {
  const db = new DatabaseSync(':memory:');
  const env = { DB: d1(db) };
  const calls = [];
  const patches = [];
  const state = { contacts: [...contacts], convs: [...convs], messages: {} };
  const deps = {
    json: (d, s = 200) => new Response(JSON.stringify(d), { status: s }),
    requireSession: async (req) => (req.headers.get('Authorization') === 'Bearer ok' ? { cid: 7 } : null),
    getClientById: async () => c,
    patchClientFields: async (env, id, f) => { patches.push(f); },
    resolveOrDetectMetaCredentials: async () => ({ waba_id: 'WABA', wa_token: 'TOK' }),
    reportOpsError: async (env, where, e) => { throw e; },
    logWaTemplateSend: async () => {},
    shopifySettings: (cl) => ({ notify: true, ...settings }),
    inboxIdFor: () => '5',
  };
  const c = { Id: 7, client_name: 'Yuva', chatwoot_base: 'https://cw.test', chatwoot_account_id: 1, chatwoot_token: 't', chatwoot_inbox_id: '5',
    shopify_notify_config: JSON.stringify({ config, templates: [], settings }) };
  const fetchMock = async (url, opts = {}) => {
    const u = String(url); const m = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ m, u, body });
    const ok = (d, s = 200) => new Response(JSON.stringify(d), { status: s });
    if (u.startsWith('https://graph.facebook.com/')) return metaCreate.ok ? ok({ id: 'T1', status: 'PENDING' }) : ok({ error: { message: metaCreate.message || 'bad', error_subcode: metaCreate.subcode } }, 400);
    if (u.endsWith('/inboxes/5')) return ok({ id: 5, message_templates: templates });
    if (u.endsWith('/inboxes/5/sync_templates')) return ok({ message: 'ok' });
    if (u.includes('/contacts/search')) return ok({ payload: state.contacts });
    if (u.endsWith('/contacts') && m === 'POST') { const ct = { id: 900, phone_number: body.phone_number, name: body.name }; state.contacts.push(ct); return ok({ payload: { contact: ct, contact_inbox: { source_id: 'SRC1' } } }); }
    if (/\/contacts\/\d+\/conversations$/.test(u)) return ok({ payload: state.convs });
    if (u.endsWith('/conversations') && m === 'POST') { const cv = { id: 77, inbox_id: 5 }; state.convs.push(cv); return ok(cv); }
    if (/\/conversations\/\d+\/messages$/.test(u) && m === 'POST') { const msg = { id: 555, status: 'sent' }; return ok(msg); }
    if (/\/conversations\/\d+\/messages$/.test(u)) return ok({ payload: state.messages[u] || [] });
    return ok({});
  };
  return { env, deps, c, calls, patches, state, fetchMock, db };
}
async function withFetch(fetchMock, fn) {
  const real = globalThis.fetch; globalThis.fetch = fetchMock;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

test('phones become WhatsApp numbers; values fill the template in {{n}} order', () => {
  assert.equal(shopifyNotifyPhone('+91 98765 43210'), '919876543210');
  assert.equal(shopifyNotifyPhone('09876543210', 'IN'), '919876543210');
  assert.equal(shopifyNotifyPhone('9876543210', 'AE'), '9719876543210');
  assert.equal(shopifyNotifyPhone('+1 (415) 555-0101'), '14155550101');
  assert.equal(shopifyNotifyPhone(''), '');
  const { values, processed } = shopifyNotifyParams({ params: PRESET.params }, order.vars);
  assert.deepEqual(values, ['Asha', '#1001', '₹567', "3x Black Men's trunk (28)"]);
  assert.deepEqual(processed, { 1: 'Asha', 2: '#1001', 3: '₹567', 4: "3x Black Men's trunk (28)" });
  assert.equal(shopifyNotifyParams({ params: ['customer_name', 'tracking_url'] }, { customer_name: 'A' }).values[1], '-'); // Meta rejects empty params
  assert.equal(shopifyNotifyContent(PRESET.body, values), "Hi Asha, thanks for your order #1001! Total: ₹567. Items: 3x Black Men's trunk (28). We will notify you when it ships.");
  assert.equal(shopifyNotifyTemplateStatus(APPROVED, PRESET.name, 'en_US'), 'APPROVED');
  assert.equal(shopifyNotifyTemplateStatus(APPROVED, 'nope', 'en'), '');
  assert.equal(shopifyNotifyTemplateBody(APPROVED, PRESET.name, 'en_US'), PRESET.body);
  assert.deepEqual(shopifyNotifyDeliveryStatus({ status: 'failed', content_attributes: { external_error: '131026: not on WhatsApp' } }), { status: 'failed', detail: '131026: not on WhatsApp' });
  assert.equal(shopifyNotifyDeliveryStatus({ status: 'read' }).status, 'read');
  const now = Date.parse('2026-10-24T12:00:00Z');
  assert.deepEqual(shopifyNotifyStats([{ status: 'read', created_at: '2026-10-24T10:00:00Z' }, { status: 'failed', created_at: '2026-10-23T10:00:00Z' }, { status: 'sent', created_at: '2026-10-01T10:00:00Z' }], now),
    { sent: 1, delivered: 1, read: 1, failed: 1, waiting: 0 });
});

test('a new order: new customer gets a Chatwoot contact + conversation, then the template via Chatwoot', async () => {
  const s = setup();
  const out = await withFetch(s.fetchMock, () => shopifySendNotification(s.env, s.deps, s.c, 'received', order.vars, order.meta));
  assert.equal(out.status, 'sent');
  assert.ok(!s.calls.some((x) => x.u.includes('graph.facebook.com')), 'never straight to Meta');
  const created = s.calls.find((x) => x.u.endsWith('/contacts') && x.m === 'POST');
  assert.deepEqual(created.body, { inbox_id: 5, name: 'Asha K', phone_number: '+919876543210' });
  assert.deepEqual(s.calls.find((x) => x.u.endsWith('/conversations') && x.m === 'POST').body, { source_id: 'SRC1', inbox_id: 5, contact_id: 900, status: 'open' });
  const send = s.calls.find((x) => /conversations\/77\/messages$/.test(x.u) && x.m === 'POST');
  assert.deepEqual(send.body.template_params, { name: PRESET.name, category: 'UTILITY', language: 'en_US', processed_params: { 1: 'Asha', 2: '#1001', 3: '₹567', 4: "3x Black Men's trunk (28)" } });
  assert.match(send.body.content, /^Hi Asha, thanks for your order #1001!/);
  const row = s.db.prepare('SELECT * FROM shopify_notify_sends').get();
  assert.equal(row.status, 'sent'); assert.equal(row.phone, '919876543210'); assert.equal(row.conv_id, '77'); assert.equal(row.message_id, '555'); assert.equal(row.order_name, '#1001');
  // Shopify retries the webhook: nothing is sent twice.
  const again = await withFetch(s.fetchMock, () => shopifySendNotification(s.env, s.deps, s.c, 'received', order.vars, order.meta));
  assert.equal(again.status, 'duplicate');
  assert.equal(s.calls.filter((x) => /messages$/.test(x.u) && x.m === 'POST').length, 1);
});

test('an existing customer’s WhatsApp conversation is reused', async () => {
  const s = setup({ contacts: [{ id: 42, phone_number: '+919876543210' }], convs: [{ id: 11, inbox_id: 9 }, { id: 12, inbox_id: 5, last_activity_at: 2 }] });
  await withFetch(s.fetchMock, () => shopifySendNotification(s.env, s.deps, s.c, 'received', order.vars, order.meta));
  assert.ok(!s.calls.some((x) => x.m === 'POST' && (x.u.endsWith('/contacts') || x.u.endsWith('/conversations'))));
  assert.ok(s.calls.some((x) => /conversations\/12\/messages$/.test(x.u) && x.m === 'POST'));
});

test('no template yet: the Order Received template is created on Meta with its variables, Chatwoot synced', async () => {
  const s = setup({ config: {}, templates: [] });
  const made = await withFetch(s.fetchMock, () => shopifyEnsureNotifyTemplate(s.env, s.deps, s.c, 'received'));
  assert.equal(made.created, true);
  const meta = s.calls.find((x) => x.u.includes('graph.facebook.com'));
  assert.equal(meta.u, 'https://graph.facebook.com/v18.0/WABA/message_templates');
  assert.deepEqual(meta.body, { name: PRESET.name, category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: PRESET.body }] });
  assert.ok(s.calls.some((x) => x.u.endsWith('/inboxes/5/sync_templates')));
  const saved = JSON.parse(s.patches[0].shopify_notify_config);
  assert.deepEqual(saved.config.received, { name: PRESET.name, lang: 'en_US', category: 'UTILITY', params: PRESET.params, auto: true });
  // A template Meta already has is adopted, not an error.
  const s2 = setup({ config: {}, metaCreate: { ok: false, message: 'Content in this language already exists', subcode: 2388024 } });
  const made2 = await withFetch(s2.fetchMock, () => shopifyEnsureNotifyTemplate(s2.env, s2.deps, s2.c, 'received'));
  assert.equal(made2.cfg.name, PRESET.name);
});

test('first order before approval: template created, send held as "pending" (retry later)', async () => {
  const s = setup({ config: {}, templates: [] });
  // Chatwoot's copy shows it pending once synced.
  const pending = [{ ...APPROVED[0], status: 'PENDING' }];
  const fm = async (url, opts) => (String(url).endsWith('/inboxes/5') ? new Response(JSON.stringify({ message_templates: pending })) : s.fetchMock(url, opts));
  const out = await withFetch(fm, () => shopifySendNotification(s.env, s.deps, s.c, 'received', order.vars, order.meta));
  assert.equal(out.status, 'pending');
  assert.match(out.detail, /pending at Meta/);
  assert.ok(!s.calls.some((x) => /messages$/.test(x.u) && x.m === 'POST'));
});

test('skips are logged with the reason', async () => {
  const noPhone = setup();
  const r1 = await withFetch(noPhone.fetchMock, () => shopifySendNotification(noPhone.env, noPhone.deps, noPhone.c, 'received', order.vars, { ...order.meta, phone: '' }));
  assert.equal(r1.status, 'skipped'); assert.match(r1.detail, /No customer phone/);
  const noTpl = setup({ config: {} });
  const r2 = await withFetch(noTpl.fetchMock, () => shopifySendNotification(noTpl.env, noTpl.deps, noTpl.c, 'shipped', {}, order.meta));
  assert.equal(r2.status, 'skipped'); assert.match(r2.detail, /No template chosen/);
  const off = setup({ settings: { notify: false } });
  assert.equal((await withFetch(off.fetchMock, () => shopifySendNotification(off.env, off.deps, off.c, 'received', order.vars, order.meta))).status, 'off');
  const noCw = setup(); noCw.c.chatwoot_token = '';
  const r3 = await withFetch(noCw.fetchMock, () => shopifySendNotification(noCw.env, noCw.deps, noCw.c, 'received', order.vars, order.meta));
  assert.match(r3.detail, /Chatwoot WhatsApp inbox not connected/);
});

test('Notifications API: list with delivery status refreshed from Chatwoot, setup and retry (session only)', async () => {
  const s = setup();
  await withFetch(s.fetchMock, () => shopifySendNotification(s.env, s.deps, s.c, 'received', order.vars, order.meta));
  s.state.messages['https://cw.test/api/v1/accounts/1/conversations/77/messages'] = [{ id: 555, status: 'read' }];
  const req = (path, init = {}) => new Request(`https://w.test${path}`, { ...init, headers: { Authorization: 'Bearer ok', 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const route = (r) => withFetch(s.fetchMock, () => shopifyNotifyHandleRoute(r, s.env, s.deps, new URL(r.url)));
  assert.equal((await route(new Request('https://w.test/ecom/shopify/notifications'))).status, 401);
  const list = await (await route(req('/ecom/shopify/notifications?refresh=1'))).json();
  assert.equal(list.rows[0].status, 'read');
  assert.equal(list.stats.read, 1);
  assert.deepEqual(list.templates.map((t) => [t.kind, t.status]), [['received', 'APPROVED'], ['paid', ''], ['shipped', ''], ['delivered', ''], ['abandoned', '']]);
  // Set up a missing event's template.
  const setupRes = await (await route(req('/ecom/shopify/notifications/setup', { method: 'POST', body: JSON.stringify({ kind: 'shipped' }) }))).json();
  assert.equal(setupRes.name, 'order_shipped_leadvyne');
  // Retry a failed send.
  s.db.prepare(`UPDATE shopify_notify_sends SET status='failed', detail='x'`).run();
  const retry = await (await route(req('/ecom/shopify/notifications/retry', { method: 'POST', body: JSON.stringify({ id: 1 }) }))).json();
  assert.equal(retry.status, 'sent');
  const sends = s.calls.filter((x) => /messages$/.test(x.u) && x.m === 'POST');
  assert.deepEqual(sends.at(-1).body.template_params.processed_params, { 1: 'Asha', 2: '#1001', 3: '₹567', 4: "3x Black Men's trunk (28)" });
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM shopify_notify_sends').get().n, 1, 'retry updates the same row');
});
