// WhatsApp Shop → "Link to my WhatsApp" (Couplo, Oct 2026): a catalog already connected in
// WhatsApp Manager, 24 products added in Meta, a System User catalog token saved in Leadvyne.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waShopHandleRoute, waShopProcessWebhook, waShopTokens, waShopLinkError, waShopLinkDiagnosis, waShopParseMetaPrice,
  waShopMetaItemProduct, waShopProductListPayload, waShopConfig, waShopHasProducts } from './wa-commerce.js';

const ITEMS = Array.from({ length: 24 }, (_, i) => ({ id: 'm' + i, retailer_id: 'CP-' + i, name: 'Baby set ' + i, price: '₹899.00', currency: 'INR', category: i < 12 ? 'Premium Sets' : 'Cord Sets', availability: 'in stock' }));

function harness({ meta = {}, config = { catalog_id: '' }, catalogToken = 'CATTOK' } = {}) {
  const graph = [];
  let saved = { ...config };
  const c = { Id: 7, wa_shop_config: JSON.stringify(saved), wa_shop_catalog_token: catalogToken };
  const deps = {
    json: (d, s = 200) => ({ d, s }),
    requireSession: async () => ({ cid: 7, email: 'boss@x.com' }),
    getClientById: async () => ({ ...c, wa_shop_config: JSON.stringify(saved) }),
    resolveMetaCredentials: () => ({ wa_token: 'WATOK', wa_phone_id: 'PH', waba_id: 'WABA', display_phone: '917736370175' }),
    ensureClientColumns: async () => {},
    patchClientFields: async (env, id, f) => { saved = JSON.parse(f.wa_shop_config); },
    reportOpsError: async () => {},
    ecomResolveTable: async (env, cid, kind) => kind, ecomListClientRows: async () => [], ensureEcomOrderFields: async () => {},
    ncFetch: async () => ({ ok: true, json: async () => ({ Id: 1 }) }),
  };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url), tok = String(opts.headers?.Authorization || '').replace('Bearer ', ''), method = opts.method || 'GET';
    graph.push({ u, tok, method });
    const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
    const key = Object.keys(meta).find(k => u.includes(k) && (!meta[k].method || meta[k].method === method) && (!meta[k].token || meta[k].token === tok));
    if (key) return reply(meta[key].status || 200, meta[key].body);
    return reply(200, {});
  };
  const call = async (path, body) => {
    const req = new Request('https://w' + path, { method: 'POST', body: JSON.stringify(body || {}) });
    return waShopHandleRoute(req, {}, deps, new URL('https://w' + path));
  };
  return { call, graph, saved: () => saved };
}

test('already connected in WhatsApp Manager: no re-link, cart shown, catalog name / count / items read back', async () => {
  const h = harness({ meta: {
    'WABA/product_catalogs': { method: 'GET', body: { data: [{ id: '1484032813531427', name: 'Couplo' }] } },
    '1484032813531427?fields=name,product_count': { body: { name: 'Couplo', product_count: 24 } },
    '1484032813531427/products': { body: { data: ITEMS } },
  } });
  const r = await h.call('/ecom/wa-shop/connect', { catalog_id: '1484 0328 1353 1427' });
  assert.equal(r.s, 200);
  assert.deepEqual({ already: r.d.already_linked, name: r.d.catalog_name, n: r.d.product_count }, { already: true, name: 'Couplo', n: 24 });
  assert.ok(!h.graph.some(g => g.u.endsWith('WABA/product_catalogs') && g.method === 'POST'), 'no second link attempt');
  // the catalog_management token is tried first for catalog calls
  assert.equal(h.graph.find(g => g.u.includes('WABA/product_catalogs')).tok, 'CATTOK');
  assert.ok(h.graph.some(g => g.u.includes('PH/whatsapp_commerce_settings?is_catalog_visible=true&is_cart_enabled=true') && g.method === 'POST'));
  const cfg = waShopConfig({ wa_shop_config: JSON.stringify(h.saved()) });
  assert.equal(cfg.catalog_id, '1484032813531427');
  assert.ok(cfg.linked_at);
  assert.equal(cfg.catalog_count, 24);
  assert.equal(cfg.meta_items.length, 24);
  assert.deepEqual(cfg.meta_items[0], { rid: 'CP-0', name: 'Baby set 0', price: 899, currency: 'INR', category: 'Premium Sets', available: true });
  assert.equal(waShopHasProducts(cfg), true);
});

test('not yet connected: links it, falling back to the WhatsApp token when the catalog token is refused', async () => {
  const h = harness({ meta: {
    'WABA/product_catalogs?fields': { method: 'GET', body: { data: [] } },
    'WABA/product_catalogs': { method: 'POST', token: 'CATTOK', status: 400, body: { error: { message: '(#200) Permissions error' } } },
    '555?fields=name,product_count': { body: { name: 'Shop', product_count: 2 } },
  }, catalogToken: 'CATTOK' });
  const r = await h.call('/ecom/wa-shop/connect', { catalog_id: '555' });
  assert.equal(r.s, 200, JSON.stringify(r.d));
  const posts = h.graph.filter(g => g.u.endsWith('WABA/product_catalogs') && g.method === 'POST').map(g => g.tok);
  assert.deepEqual(posts, ['CATTOK', 'WATOK']);
  assert.equal(r.d.already_linked, false);
});

test('Meta errors come back in plain words; an empty ID is refused before calling Meta', async () => {
  const h = harness({ meta: { 'WABA/product_catalogs?fields': { method: 'GET', body: { data: [{ id: '999', name: 'Old catalog' }] } },
    'WABA/product_catalogs': { method: 'POST', status: 400, body: { error: { message: 'Only one catalog can be connected' } } } } });
  const r = await h.call('/ecom/wa-shop/connect', { catalog_id: '555' });
  assert.equal(r.s, 502);
  assert.match(r.d.error, /already has another catalog connected \(Old catalog\)/);
  const e = await harness().call('/ecom/wa-shop/connect', { catalog_id: 'abc' });
  assert.equal(e.s, 400);
  assert.match(waShopLinkError({ error: '(#200) Requires catalog_management' }), /catalog_management and whatsapp_business_management/);
});

test('sync into a Meta-managed catalog needs a confirm', async () => {
  const items = [{ rid: 'CP-1', name: 'Set', price: 899 }];
  const h = harness({ config: { catalog_id: '555', linked_at: 'x', meta_items: items } });
  const r = await h.call('/ecom/wa-shop/sync', {});
  assert.equal(r.s, 409);
  assert.equal(r.d.error, 'meta_managed');
});

test('Meta items: prices parsed, product list uses their own retailer ids, carts get the real names', async () => {
  assert.equal(waShopParseMetaPrice('₹899.00'), 899);
  assert.equal(waShopParseMetaPrice('INR 1,299.50'), 1299.5);
  assert.equal(waShopParseMetaPrice(''), 0);
  const products = [{ rid: 'CP-1', name: 'Premium set', price: 899, category: 'Premium Sets' }, { rid: 'CP-2', name: 'Cord set', price: 750, category: 'Cord Sets' }].map(waShopMetaItemProduct);
  const p = waShopProductListPayload('917736370175', '1484032813531427', products);
  assert.deepEqual(p.interactive.action.sections.map(s => s.product_items[0].product_retailer_id), ['CP-1', 'CP-2']);

  const posted = [];
  const c = { Id: 7, wa_shop_config: JSON.stringify({ catalog_id: '1484032813531427', meta_items: [{ rid: 'CP-1', name: 'Premium set', price: 899 }] }) };
  const deps = { resolveMetaCredentials: () => ({ wa_token: 't', wa_phone_id: 'PH' }), ecomResolveTable: async (e, id, k) => k, ecomListClientRows: async () => [],
    ensureEcomOrderFields: async () => {}, reportOpsError: async () => {},
    ncFetch: async (env, path, o = {}) => { if (o.method === 'POST') posted.push(o.body); return { ok: true, json: async () => ({}) }; } };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  await waShopProcessWebhook({}, deps, c, { entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PH' }, contacts: [{ wa_id: '91980', profile: { name: 'Asha' } }],
    messages: [{ id: 'w1', from: '91980', type: 'order', order: { catalog_id: '1', product_items: [{ product_retailer_id: 'CP-1', quantity: 1, item_price: 899, currency: 'INR' }] } }] } }] }] });
  assert.equal(posted[0].items, '1x Premium set');
});

test('tokens: catalog token first for catalog calls, WhatsApp token first for the number', () => {
  assert.deepEqual(waShopTokens({ wa_shop_catalog_token: 'C' }, { wa_token: 'W' }), ['C', 'W']);
  assert.deepEqual(waShopTokens({ wa_shop_catalog_token: 'C' }, { wa_token: 'W' }, 'whatsapp'), ['W', 'C']);
  assert.deepEqual(waShopTokens({}, { wa_token: 'W' }), ['W']);
});

test('"invalid catalogue ID" from Meta: says whether the token can see it and which business owns it', async () => {
  const h = harness({ meta: {
    'WABA/product_catalogs?fields': { method: 'GET', body: { data: [] } },
    'WABA/product_catalogs': { method: 'POST', status: 400, body: { error: { message: 'Cannot link WhatsApp Business account with an invalid product catalogue ID.' } } },
    '1484032813531427?fields=id,name,business': { body: { id: '1484032813531427', name: 'Couplo', business: { id: 'B1', name: 'Couplo Kids' } } },
    'WABA?fields=id,name,owner_business_info': { body: { id: 'WABA', owner_business_info: { id: 'B2', name: 'Couplo WhatsApp' } } },
  } });
  const r = await h.call('/ecom/wa-shop/connect', { catalog_id: '1484032813531427' });
  assert.equal(r.s, 502);
  assert.match(r.d.error, /belongs to the business "Couplo Kids", but your WhatsApp account belongs to "Couplo WhatsApp"/);

  assert.match(waShopLinkDiagnosis({ catalogId: '1', catalog: null, blind: ['catalog token: (#100) Unsupported get request'] }), /None of your saved tokens can open catalog 1 \(catalog token: \(#100\)/);
  assert.match(waShopLinkDiagnosis({ catalogId: '1', catalog: { name: 'Shop', business: { id: 'B' } }, waba: { owner_business_info: { id: 'B' } }, linkError: 'x' }), /Link it once by hand — WhatsApp Manager/);
});
