// WhatsApp Shop optional growth features (Nov 2026): catalog with a new customer's first reply,
// ad → product card, and catalog-template broadcasts. All off by default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waShopHandleRoute, waShopInboundPlan, waShopOnInbound, waShopConfig, waShopCleanAdMap, waShopCatalogTemplateBody,
  waShopCatalogTemplateSend, waShopIsCatalogTemplate, waShopSections } from './wa-commerce.js';

const LINKED = { catalog_id: '555', linked_at: '2026-11-08', synced_at: '2026-11-08' };
const PRODUCTS = [
  { Id: 1, name: 'Pink cord set', price: 899, image_url: 'x.jpg', category: 'Cord Sets' },
  { Id: 2, name: 'Blue cord set', price: 899, image_url: 'x.jpg', category: 'Cord Sets' },
  { Id: 3, name: 'Gift box', price: 1499, image_url: 'x.jpg', category: 'Premium Sets' },
];

function harness(config = {}, { leads = [], orders = [] } = {}) {
  let saved = { ...LINKED, ...config };
  const sentWa = [], graph = [];
  const kv = new Map(), db = new Set();
  const env = {
    MATRI_CACHE: { get: async k => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async k => { kv.delete(k); } },
    DB: { prepare: sql => ({ bind: (...a) => ({
      run: async () => { if (/INSERT OR IGNORE/.test(sql)) { if (db.has(a[0])) return { meta: { changes: 0 } }; db.add(a[0]); } return { meta: { changes: 1 } }; },
      all: async () => ({ results: /meta_ads_ads/.test(sql) ? [{ ad_id: '120200001', ad_name: 'Pink set ad', campaign_name: 'Nov', status: 'ACTIVE' }] : [] }),
    }), run: async () => ({}) }) },
  };
  const deps = {
    json: (d, s = 200) => ({ d, s }),
    requireSession: async () => ({ cid: 7 }),
    getClientById: async () => ({ Id: 7, wa_shop_config: JSON.stringify(saved) }),
    resolveMetaCredentials: () => ({ wa_token: 'WATOK', wa_phone_id: 'PH', waba_id: 'WABA' }),
    ensureClientColumns: async () => {},
    patchClientFields: async (e, id, f) => { if (f.wa_shop_config) saved = JSON.parse(f.wa_shop_config); },
    reportOpsError: async () => {},
    ecomListActiveProducts: async () => PRODUCTS,
    ecomResolveTable: async (e, cid, kind) => kind,
    ecomListClientRows: async () => orders,
    ncFetch: async (e, path) => ({ ok: true, json: async () => ({ list: /records/.test(path) ? leads : [] }) }),
    leadsTable: 'LEADS',
  };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url), body = opts.body ? JSON.parse(opts.body) : null;
    graph.push({ u, method: opts.method || 'GET', body });
    if (u.endsWith('PH/messages')) { sentWa.push(body); return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'w' }] }) }; }
    if (u.includes('WABA/message_templates?')) return { ok: true, status: 200, json: async () => ({ data: [
      { name: 'new_arrivals', language: 'en', status: 'APPROVED', components: [{ type: 'HEADER', text: 'New arrivals' }, { type: 'BODY', text: 'Tap to shop' }, { type: 'BUTTONS', buttons: [{ type: 'MPM', text: 'View items' }] }] },
      { name: 'hello_plain', language: 'en', status: 'APPROVED', components: [{ type: 'BODY', text: 'Hi' }] },
    ] }) };
    if (u.endsWith('WABA/message_templates')) return { ok: true, status: 200, json: async () => ({ id: 't1', status: 'PENDING' }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const call = (path, body, method = 'POST') => waShopHandleRoute(new Request('https://w' + path, method === 'GET' ? {} : { method, body: JSON.stringify(body || {}) }), env, deps, new URL('https://w' + path));
  return { env, deps, call, sentWa, graph, saved: () => saved, client: () => ({ Id: 7, wa_shop_config: JSON.stringify(saved) }) };
}

test('everything is off by default — no plan, nothing sent', async () => {
  const cfg = waShopConfig({ wa_shop_config: JSON.stringify(LINKED) });
  assert.deepEqual([cfg.first_catalog, cfg.ads_on, cfg.broadcast_on, cfg.ad_map], [false, false, false, []]);
  assert.equal(waShopInboundPlan(cfg, { isNewLead: true, adId: '120200001' }), null);
  const h = harness();
  assert.equal(await waShopOnInbound(h.env, h.deps, h.client(), { phone: '919744250000', isNewLead: true }), '');
  assert.equal(h.sentWa.length, 0);
});

test('plan: ad mapping wins over first catalog; Instagram and unlinked catalogs never get one', () => {
  const ad_map = waShopCleanAdMap([{ ad_id: '120200001', kind: 'product', target: 'lv_1', label: 'Pink cord set' }, { ad_id: '120200001', target: 'dup' }, { ad_id: 'x', target: 'y' }]);
  assert.equal(ad_map.length, 1);
  const cfg = waShopConfig({ wa_shop_config: JSON.stringify({ ...LINKED, first_catalog: true, ads_on: true, ad_map }) });
  assert.equal(waShopInboundPlan(cfg, { isNewLead: true, adId: '120200001' }).kind, 'ad_product');
  assert.equal(waShopInboundPlan(cfg, { isNewLead: true, adId: '999999' }).kind, 'first_catalog');
  assert.equal(waShopInboundPlan(cfg, { isNewLead: false }), null);
  assert.equal(waShopInboundPlan(cfg, { isNewLead: true, channel: 'instagram' }), null);
  assert.equal(waShopInboundPlan({ ...cfg, linked_at: '' }, { isNewLead: true }), null);
});

test('first reply: a new customer gets the whole catalog and the AI is told', async () => {
  const h = harness({ first_catalog: true });
  const note = await waShopOnInbound(h.env, h.deps, h.client(), { phone: '919744250000', isNewLead: true });
  assert.match(note, /just sent our product catalog/);
  assert.equal(h.sentWa.length, 1);
  assert.equal(h.sentWa[0].interactive.type, 'product_list');
  assert.equal(h.sentWa[0].interactive.action.sections.reduce((s, x) => s + x.product_items.length, 0), 3);
  // an existing customer gets nothing extra
  assert.equal(await waShopOnInbound(h.env, h.deps, h.client(), { phone: '919744250000', isNewLead: false }), '');
  assert.equal(h.sentWa.length, 1);
});

test('ad → product card, ad → category catalog', async () => {
  const h = harness({ ads_on: true, ad_map: [{ ad_id: '120200001', kind: 'product', target: 'lv_1', label: 'Pink cord set' }, { ad_id: '120200002', kind: 'category', target: 'Premium Sets' }] });
  const note = await waShopOnInbound(h.env, h.deps, h.client(), { phone: '919744250000', adId: '120200001' });
  assert.match(note, /our ad for "Pink cord set"/);
  assert.deepEqual(h.sentWa[0].interactive, { type: 'product', body: { text: 'Tap to see photos and price, then add it to your cart 🛒' }, action: { catalog_id: '555', product_retailer_id: 'lv_1' } });
  await waShopOnInbound(h.env, h.deps, h.client(), { phone: '919744250001', adId: '120200002' });
  assert.equal(h.sentWa[1].interactive.type, 'product_list');
  assert.deepEqual(h.sentWa[1].interactive.action.sections.map(s => s.title), ['Premium Sets']);
});

test('settings: toggles and ad map save; ads list comes from Ads ROI with products to pick', async () => {
  const h = harness();
  await h.call('/ecom/wa-shop/config', { first_catalog: true, ads_on: true, broadcast_on: true, ad_map: [{ ad_id: '120200001', kind: 'category', target: 'Cord Sets' }] });
  const cfg = waShopConfig({ wa_shop_config: JSON.stringify(h.saved()) });
  assert.deepEqual([cfg.first_catalog, cfg.ads_on, cfg.broadcast_on, cfg.ad_map[0].target], [true, true, true, 'Cord Sets']);
  const r = await h.call('/ecom/wa-shop/ads', null, 'GET');
  assert.equal(r.d.ads[0].ad_name, 'Pink set ad');
  assert.deepEqual(r.d.categories, ['Cord Sets', 'Premium Sets']);
  assert.equal(r.d.products[0].rid, 'lv_1');
});

test('broadcast: refused while off; lists only catalog templates; creates a View items template', async () => {
  const off = harness();
  assert.equal((await off.call('/ecom/wa-shop/bc/templates', null, 'GET')).s, 400);
  const h = harness({ broadcast_on: true });
  const list = await h.call('/ecom/wa-shop/bc/templates', null, 'GET');
  assert.deepEqual(list.d.templates.map(t => t.name), ['new_arrivals']);
  const bad = await h.call('/ecom/wa-shop/bc/templates', { name: 'New Arrivals!', header: 'x', body: 'y' });
  assert.equal(bad.s, 400);
  const ok = await h.call('/ecom/wa-shop/bc/templates', { name: 'new arrivals nov', header: 'New arrivals 🍼', body: 'Tap to shop' });
  assert.equal(ok.d.name, 'new_arrivals_nov');
  const posted = h.graph.find(g => g.u.endsWith('WABA/message_templates') && g.method === 'POST').body;
  assert.deepEqual(posted, waShopCatalogTemplateBody({ name: 'new_arrivals_nov', language: 'en', header: 'New arrivals 🍼', body: 'Tap to shop' }));
  assert.equal(waShopIsCatalogTemplate({ components: posted.components.map(c => ({ ...c, type: c.type })) }), true);
});

test('broadcast audience: opted-out, Instagram and duplicate numbers left out', async () => {
  const leads = [{ Phone: '+91 97442 50000' }, { Phone: '919744250000' }, { Phone: '919000000001', OptOut: 'Yes' }, { Phone: '919000000002', Channel: 'instagram' }, { Phone: '123' }];
  const h = harness({ broadcast_on: true }, { leads, orders: [{ customer_phone: '919000000001' }, { customer_phone: '918888888888' }] });
  const l = await h.call('/ecom/wa-shop/bc/audience', { audience: 'leads' });
  assert.deepEqual(l.d.phones, ['919744250000']);
  const cst = await h.call('/ecom/wa-shop/bc/audience', { audience: 'customers' });
  assert.deepEqual(cst.d.phones, ['918888888888']);
});

test('broadcast send: MPM template with product sections; a retried batch never double-sends', async () => {
  const h = harness({ broadcast_on: true });
  const body = { template: 'new_arrivals', language: 'en', phones: ['919744250000', '918888888888'], run_id: 'r1' };
  const r = await h.call('/ecom/wa-shop/bc/send', body);
  assert.deepEqual([r.d.sent, r.d.failed.length], [2, 0]);
  assert.deepEqual(h.sentWa[0], waShopCatalogTemplateSend('919744250000', { name: 'new_arrivals', language: 'en' }, waShopSections(PRODUCTS)));
  assert.equal(h.sentWa[0].template.components[0].parameters[0].action.thumbnail_product_retailer_id, 'lv_1');
  const again = await h.call('/ecom/wa-shop/bc/send', body);
  assert.equal(again.d.sent, 0);
  assert.equal(h.sentWa.length, 2);
});
