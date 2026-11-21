// 🛍️ WhatsApp Shop (wa-commerce.js): catalog items, product lists, carts → Ecom orders, WhatsApp Pay,
// Shopify checkout and the Chatwoot relay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  waShopRetailerId, waShopParseRetailerId, waShopFindProduct, waShopCatalogRequests, waShopIsCatalogAsk,
  waShopProductListPayload, waShopParseOrder, waShopOrderFields, waShopPaymentPayload, waShopParsePayment,
  waShopShopifyCartUrl, waShopChatwootTarget, waShopConfig, waShopProcessWebhook, waShopHandleRoute,
} from './wa-commerce.js';

const PRODUCTS = [
  { Id: 11, name: 'Kurta', sku: 'K-1', price: 599, currency: 'INR', stock: 4, status: 'active', category: 'Kurtas', image_url: 'https://img/k.jpg', image_url_2: 'https://img/k2.jpg', brand: 'Looms' },
  { Id: 12, name: 'Saree', sku: 'S-1', price: 2500, stock: 0, status: 'active', category: 'Sarees', image_url: 'https://img/s.jpg', shopify_product_id: '777', shopify_product_url: 'https://kochi.myshopify.com/products/saree' },
  { Id: 13, name: 'Dupatta', price: 300, status: 'active', category: 'Kurtas' },
  { Id: 14, name: 'Old shawl', price: 100, status: 'inactive', image_url: 'https://img/o.jpg' },
];

test('retailer ids: our own, Shopify channel ids and plain SKUs all map back to the product', () => {
  assert.equal(waShopRetailerId(PRODUCTS[0]), 'lv_11');
  assert.equal(waShopRetailerId({ nocodb_id: 11, id: 3 }), 'lv_11');
  assert.deepEqual(waShopParseRetailerId('shopify_IN_777_9001'), { shopifyProductId: '777', shopifyVariantId: '9001' });
  assert.equal(waShopFindProduct(PRODUCTS, 'lv_11').name, 'Kurta');
  assert.equal(waShopFindProduct(PRODUCTS, 'shopify_IN_777_9001').name, 'Saree');
  assert.equal(waShopFindProduct(PRODUCTS, 'k-1').name, 'Kurta');
  assert.equal(waShopFindProduct(PRODUCTS, 'lv_999'), null);
});

test('catalog batch: upserts sellable products, removes inactive ones, lists what can\'t be synced', () => {
  const { requests, skipped } = waShopCatalogRequests(PRODUCTS, { fallbackLink: 'https://onshope.com/kochi', resolveImageUrl: u => u + '?direct' });
  const kurta = requests.find(r => r.data.id === 'lv_11');
  assert.equal(kurta.method, 'UPDATE');
  assert.equal(kurta.data.price, '599.00 INR');
  assert.equal(kurta.data.availability, 'in stock');
  assert.equal(kurta.data.inventory, 4);
  assert.equal(kurta.data.link, 'https://onshope.com/kochi');
  assert.equal(kurta.data.image_link, 'https://img/k.jpg?direct');
  assert.equal(kurta.data.additional_image_link, 'https://img/k2.jpg?direct');
  const saree = requests.find(r => r.data.id === 'lv_12');
  assert.equal(saree.data.availability, 'out of stock');
  assert.equal(saree.data.link, 'https://kochi.myshopify.com/products/saree');
  assert.deepEqual(requests.find(r => r.data.id === 'lv_14'), { method: 'DELETE', data: { id: 'lv_14' } });
  assert.deepEqual(skipped, [{ id: 13, name: 'Dupatta', reason: 'no photo' }]);
});

test('browse asks are recognised; ordinary chat is not', () => {
  for (const t of ['Show me your catalogue', 'send collection pls', 'what do you sell?', 'price list', 'show your products']) assert.ok(waShopIsCatalogAsk(t), t);
  for (const t of ['hi', 'is the kurta available in M', 'where is my order']) assert.ok(!waShopIsCatalogAsk(t), t);
});

test('product list: grouped by category, capped at 30 items / 10 sections, optional category filter', () => {
  const p = waShopProductListPayload('+91 98000 00001', '555', PRODUCTS.slice(0, 2));
  assert.equal(p.to, '919800000001');
  assert.equal(p.interactive.type, 'product_list');
  assert.equal(p.interactive.action.catalog_id, '555');
  assert.deepEqual(p.interactive.action.sections.map(s => s.title), ['Kurtas', 'Sarees']);
  const many = Array.from({ length: 50 }, (_, i) => ({ Id: i + 1, category: 'C' + (i % 12) }));
  const capped = waShopProductListPayload('9198', '1', many);
  assert.equal(capped.interactive.action.sections.length, 10);
  assert.ok(capped.interactive.action.sections.reduce((s, x) => s + x.product_items.length, 0) <= 30);
  assert.equal(waShopProductListPayload('9198', '1', PRODUCTS, { category: 'sarees' }).interactive.action.sections[0].product_items[0].product_retailer_id, 'lv_12');
  assert.equal(waShopProductListPayload('9198', '1', PRODUCTS, { category: 'Shoes' }), null);
});

test('a cart becomes an Ecom order at the price WhatsApp showed', () => {
  const cart = waShopParseOrder({ order: { catalog_id: '555', text: 'gift wrap', product_items: [
    { product_retailer_id: 'lv_11', quantity: 2, item_price: 549, currency: 'INR' },
    { product_retailer_id: 'lv_12', quantity: 1, item_price: 2500, currency: 'INR' },
  ] } });
  const o = waShopOrderFields(7, cart, PRODUCTS, { phone: '919800000001', name: 'Asha', now: new Date('2026-10-24T10:00:00Z'), ref: 'WA-1' });
  assert.equal(o.total, 3598);
  assert.equal(o.items, '2x Kurta, 1x Saree');
  assert.equal(o.status, 'pending');
  assert.equal(o.taken_by, 'whatsapp_cart');
  assert.match(o.notes, /gift wrap/);
  assert.equal(JSON.parse(o.line_items_json)[0].product_id, '11');
});

test('WhatsApp Pay message carries the order in paise and the gateway configuration', () => {
  const lines = [{ title: 'Kurta', quantity: 2, price: 549, product_id: '11' }];
  const p = waShopPaymentPayload('919800000001', { order_id: 'WA-1', total: 1098, currency: 'INR' }, lines, { gateway: 'razorpay', configName: 'kochi-rzp' });
  const a = p.interactive.action;
  assert.equal(p.interactive.type, 'order_details');
  assert.equal(a.name, 'review_and_pay');
  assert.equal(a.parameters.reference_id, 'WA-1');
  assert.deepEqual(a.parameters.total_amount, { value: 109800, offset: 100 });
  assert.deepEqual(a.parameters.payment_settings[0], { type: 'payment_gateway', payment_gateway: { type: 'razorpay', configuration_name: 'kochi-rzp' } });
  assert.equal(a.parameters.order.items[0].retailer_id, 'lv_11');
});

test('payment statuses, Shopify cart links and the Chatwoot relay target', () => {
  const paid = waShopParsePayment({ id: 'x', type: 'payment', status: 'captured', payment: { reference_id: 'WA-1', amount: { value: 109800, offset: 100 }, transaction: { id: 'pay_1', type: 'razorpay', status: 'success' } } });
  assert.deepEqual(paid, { ref: 'WA-1', paid: true, failed: false, txn: 'pay_1', method: 'razorpay', amount: 1098 });
  assert.equal(waShopParsePayment({ type: 'message', status: 'read' }), null);
  assert.equal(waShopShopifyCartUrl('kochi.myshopify.com', [{ variantId: '9001', quantity: 2 }, { variantId: '', quantity: 1 }]), 'https://kochi.myshopify.com/cart/9001:2');
  const c = { chatwoot_base: 'https://chat.example.com/', wa_display_phone: '+91 94969 71950' };
  assert.equal(waShopChatwootTarget(c, waShopConfig({}), null), 'https://chat.example.com/webhooks/whatsapp/+919496971950');
  assert.equal(waShopChatwootTarget(c, waShopConfig({ wa_shop_config: JSON.stringify({ chatwoot_webhook_url: 'https://x/y' }) }), null), 'https://x/y');
});

// ── flows with mocked Meta / NocoDB ──
function harness({ config = {}, shopify = false } = {}) {
  const sent = [], posted = [], patched = [], events = new Set();
  const c = { Id: 7, wa_shop_config: JSON.stringify({ catalog_id: '555', ...config }), ...(shopify ? { shopify_shop_domain: 'kochi.myshopify.com', shopify_access_token: 't' } : {}) };
  const orders = [];
  const env = { DB: { prepare: (sql) => ({ bind: (...a) => ({
    run: async () => { if (/INSERT OR IGNORE/.test(sql)) { const had = events.has(a[0]); events.add(a[0]); return { meta: { changes: had ? 0 : 1 } }; } return {}; },
    all: async () => ({ results: [] }) }), run: async () => ({}) }) } };
  const deps = {
    json: (d, s) => ({ d, s }), reportOpsError: async (e, ctx, err) => { throw err; },
    getClientById: async () => c, resolveMetaCredentials: () => ({ wa_token: 'tok', wa_phone_id: 'PH', waba_id: 'W' }),
    ecomResolveTable: async (env, cid, kind) => kind,
    ecomListClientRows: async () => PRODUCTS,
    ensureEcomOrderFields: async () => {},
    ncFetch: async (env, path, opts = {}) => {
      if (opts.method === 'POST') { posted.push(opts.body); orders.push({ Id: 90, ...opts.body }); return { ok: true, json: async () => ({ Id: 90 }) }; }
      if (opts.method === 'PATCH') { patched.push(opts.body); return { ok: true, json: async () => ({}) }; }
      return { ok: true, json: async () => ({ list: orders }) };
    },
    shopifyFetch: async () => ({ ok: true, json: async () => ({ product: { variants: [{ id: 9001, inventory_management: 'shopify', inventory_quantity: 0 }, { id: 9002, inventory_management: 'shopify', inventory_quantity: 3 }] } }) }),
  };
  globalThis.fetch = async (url, opts) => { sent.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null }); return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.out' }] }) }; };
  return { c, env, deps, sent, posted, patched };
}
const cartHook = (id = 'wamid.1') => ({ entry: [{ changes: [{ field: 'messages', value: {
  metadata: { phone_number_id: 'PH' }, contacts: [{ wa_id: '919800000001', profile: { name: 'Asha' } }],
  messages: [{ id, from: '919800000001', type: 'order', order: { catalog_id: '555', product_items: [{ product_retailer_id: 'lv_11', quantity: 2, item_price: 599, currency: 'INR' }] } }],
} }] }] });

test('cash on delivery: cart → pending Ecom order + summary; a redelivered webhook is ignored', async () => {
  const h = harness();
  await waShopProcessWebhook(h.env, h.deps, h.c, cartHook());
  await waShopProcessWebhook(h.env, h.deps, h.c, cartHook());
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0].customer_name, 'Asha');
  assert.equal(h.posted[0].total, 1198);
  const msgs = h.sent.filter(s => s.url.endsWith('/PH/messages'));
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].body.text.body, /Cash on delivery/);
  assert.match(msgs[0].body.text.body, /Total: ₹1,198/);
});

test('WhatsApp Pay: review-and-pay message, and the payment webhook marks the order paid', async () => {
  const h = harness({ config: { payment_mode: 'whatsapp_pay', payment_config: 'kochi-rzp' } });
  await waShopProcessWebhook(h.env, h.deps, h.c, cartHook());
  const types = h.sent.filter(s => s.url.endsWith('/PH/messages')).map(s => s.body.type === 'interactive' ? s.body.interactive.type : s.body.type);
  assert.deepEqual(types, ['order_details', 'text']);
  const ref = h.posted[0].order_id;
  await waShopProcessWebhook(h.env, h.deps, h.c, { entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PH' },
    statuses: [{ id: 'st1', type: 'payment', status: 'captured', payment: { reference_id: ref, amount: { value: 119800, offset: 100 }, transaction: { id: 'pay_9', type: 'razorpay', status: 'success' } } }] } }] }] });
  assert.equal(h.patched[0].status, 'processing');
  assert.match(h.patched[0].notes, /pay_9/);
  assert.match(h.sent.at(-1).body.text.body, /Payment received/);
});

test('Shopify checkout: cart link with an in-stock variant, no Ecom order created here', async () => {
  const h = harness({ config: { payment_mode: 'shopify_checkout' }, shopify: true });
  const hook = cartHook();
  hook.entry[0].changes[0].value.messages[0].order.product_items[0].product_retailer_id = 'lv_12';
  await waShopProcessWebhook(h.env, h.deps, h.c, hook);
  assert.equal(h.posted.length, 0);
  const msg = h.sent.find(s => s.url.endsWith('/PH/messages')).body;
  assert.equal(msg.interactive.type, 'cta_url');
  assert.equal(msg.interactive.action.parameters.url, 'https://kochi.myshopify.com/cart/9002:2');
});

test('relay: Meta verification uses the per-client token; webhooks reach Chatwoot first, unchanged', async () => {
  const h = harness({ config: { chatwoot_webhook_url: 'https://chat.example.com/webhooks/whatsapp/+9194' } });
  h.deps.hmacSignB64 = async () => 'ab+c/d=';
  const bad = await waShopHandleRoute(new Request('https://w/wa/shop/webhook/7?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42'), h.env, h.deps, new URL('https://w/wa/shop/webhook/7?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42'));
  assert.equal(bad.status, 403);
  const okUrl = 'https://w/wa/shop/webhook/7?hub.mode=subscribe&hub.verify_token=abcd&hub.challenge=42';
  const ok = await waShopHandleRoute(new Request(okUrl), h.env, h.deps, new URL(okUrl));
  assert.equal(await ok.text(), '42');
  const raw = JSON.stringify(cartHook('wamid.9'));
  const res = await waShopHandleRoute(new Request('https://w/wa/shop/webhook/7', { method: 'POST', body: raw, headers: { 'X-Hub-Signature-256': 'sha256=x' } }), h.env, h.deps, new URL('https://w/wa/shop/webhook/7'));
  assert.equal(res.status, 200);
  assert.equal(h.sent[0].url, 'https://chat.example.com/webhooks/whatsapp/+9194');
  assert.equal(JSON.stringify(h.sent[0].body), raw);
  assert.equal(h.posted.length, 1);
});
