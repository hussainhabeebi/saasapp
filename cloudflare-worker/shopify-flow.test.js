// Shopify-style guided shopping chat: pure helpers (shopify-flow.js) and the engine turns
// (worker.js engineShopifyFlowTurn / engineShopifyFlowResume) against mocked WhatsApp/Chatwoot/NocoDB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shopFlowParse, shopFlowIsGreeting, shopFlowIsTrackRequest, shopFlowOrderNumber, shopFlowIsPurchaseIntent,
  shopFlowCategories, shopFlowMenuItems, shopFlowCategoryProducts, shopFlowSizeOptions, shopFlowMatchOption,
  shopFlowCartLink, shopFlowProductCaption, shopFlowOrderSummary, shopFlowCustomerOrders, shopFlowProductHandle,
} from './shopify-flow.js';
import { engineShopifyFlowTurn, engineShopifyFlowResume, engineShopifyFlowOn } from './worker.js';

const SHOP = 'yuva.myshopify.com';
const PRODUCTS = [
  { Id: 1, name: "Black Men's trunk", category: "Men's Trunk", price: 189, currency: 'INR', stock: 600, sku: 'BT-28', image_url: 'https://cdn.shopify.com/s/files/black.jpg', shopify_product_url: `https://${SHOP}/products/black-mens-trunk`, description: 'Soft cotton, all-day comfort.' },
  { Id: 2, name: "Navy Men's trunk", category: "Men's Trunk", price: 189, currency: 'INR', stock: 0, sku: 'NT-28' },
  { Id: 3, name: 'Classic Brief', category: 'Briefs', price: 149, currency: 'INR', stock: 40, sku: 'CB-1', size: 'S, M, L' },
  { Id: 4, name: 'Grey trunk', category: "Men's Trunk", price: 199, currency: 'INR', stock: 999, sku: 'GT-1', shopify_product_url: `https://${SHOP}/products/grey-trunk` },
];
const VARIANTS = [
  { shopify_variant_id: '101', variant_title: '28', available: 200, tracked: 'Yes', price: 189 },
  { shopify_variant_id: '102', variant_title: '30', available: 0, tracked: 'Yes', price: 189 },
  { shopify_variant_id: '103', variant_title: '2XL', available: 5, tracked: 'Yes', price: 209 },
];

test('button values, greetings, tracking asks and order numbers are recognised', () => {
  assert.deepEqual(shopFlowParse("SHOP_CAT:Men's Trunk"), { action: 'CAT', arg: "Men's Trunk" });
  assert.deepEqual(shopFlowParse('SHOP_TRACK'), { action: 'TRACK', arg: '' });
  assert.equal(shopFlowParse('shop now'), null);
  assert.equal(shopFlowIsGreeting('Hi!'), true);
  assert.equal(shopFlowIsGreeting('menu'), true);
  assert.equal(shopFlowIsGreeting('hi do you have trunks'), false);
  assert.equal(shopFlowIsTrackRequest('Where is my order?'), true);
  assert.equal(shopFlowIsTrackRequest('track my parcel pls'), true);
  assert.equal(shopFlowIsTrackRequest('do you have track pants'), false);
  assert.equal(shopFlowIsTrackRequest('I want to order'), false);
  assert.equal(shopFlowOrderNumber('#1001'), '#1001');
  assert.equal(shopFlowOrderNumber('order no 1001'), '#1001');
  assert.equal(shopFlowOrderNumber('size 32'), '');
  assert.equal(shopFlowIsPurchaseIntent('I want this one'), true);
  assert.equal(shopFlowIsPurchaseIntent('is it cotton?'), false);
});

test('menu lists in-stock categories (most products first) plus Track my order', () => {
  assert.deepEqual(shopFlowCategories(PRODUCTS), [{ name: "Men's Trunk", count: 2 }, { name: 'Briefs', count: 1 }]);
  assert.deepEqual(shopFlowMenuItems(PRODUCTS).map(i => i.value), ["SHOP_CAT:Men's Trunk", 'SHOP_CAT:Briefs', 'SHOP_TRACK']);
  assert.deepEqual(shopFlowMenuItems([{ Id: 9, name: 'X', stock: 3 }]).map(i => i.value), ['SHOP_CAT:*', 'SHOP_TRACK']);
  assert.deepEqual(shopFlowCategoryProducts(PRODUCTS, "men's trunk").map(p => p.Id), [1, 4]); // sold-out Navy hidden
});

test('sizes come from Shopify variants with stock, else the Size field', () => {
  const opts = shopFlowSizeOptions(PRODUCTS[0], VARIANTS);
  assert.deepEqual(opts.map(o => [o.title, o.inStock]), [['28', true], ['30', false], ['2XL', true]]);
  assert.equal(shopFlowMatchOption(opts, 'SHOP_SIZE:103').title, '2XL');
  assert.equal(shopFlowMatchOption(opts, 'size 28').variantId, '101');
  assert.equal(shopFlowMatchOption(opts, '32'), null);
  assert.deepEqual(shopFlowSizeOptions(PRODUCTS[2], []).map(o => o.title), ['S', 'M', 'L']);
  assert.equal(shopFlowCartLink(SHOP, '103'), 'https://yuva.myshopify.com/cart/103:1');
  assert.equal(shopFlowProductHandle(PRODUCTS[0]), 'black-mens-trunk');
  assert.match(shopFlowProductCaption(PRODUCTS[0], opts), /Sizes in stock: 28 · 2XL/);
});

test('order summaries show status and tracking, only for the customer’s own number', () => {
  const rows = [
    { shopify_order_id: '1', fulfillment_status: 'fulfilled', name: '#1002', created_at: '2026-10-22', customer_phone: '+91 98765 43210', total: 567, currency: 'INR', financial_status: 'paid',
      line_items_json: JSON.stringify([{ title: 'Black trunk', variant_title: '28', quantity: 3 }]),
      fulfillments_json: JSON.stringify([{ company: 'Delhivery', number: 'DL123', url: 'https://t/1', shipment_status: 'in_transit' }]) },
    { shopify_order_id: '2', fulfillment_status: 'unfulfilled', name: '#1001', created_at: '2026-10-20', customer_phone: '919876543210', financial_status: 'paid', fulfillments_json: '[]' },
    { shopify_order_id: '3', fulfillment_status: 'unfulfilled', name: '#0999', created_at: '2026-10-23', customer_phone: '+911111111111', fulfillments_json: '[]' },
  ];
  const mine = shopFlowCustomerOrders(rows, '919876543210');
  assert.deepEqual(mine.map(o => o.name), ['#1002', '#1001']);
  const text = shopFlowOrderSummary(mine[0]);
  assert.match(text, /\*Order #1002\* · ₹567/);
  assert.match(text, /3x Black trunk \(28\)/);
  assert.match(text, /Status: 🚚 Shipped/);
  assert.match(text, /Tracking: Delhivery DL123\nhttps:\/\/t\/1/);
  assert.match(shopFlowOrderSummary(mine[1]), /Confirmed/);
  assert.match(shopFlowOrderSummary({ order_id: 'ORD-1', items: '1x Brief', status: 'delivered', total: 149 }), /📦 Delivered/);
});

// ── engine turns ────────────────────────────────────────────────────────────────────────────
const c = {
  Id: 7, industry: 'ecommerce', client_name: 'Yuva Signature', shopify_shop_domain: SHOP, shopify_access_token: 'tok',
  chatwoot_base: 'https://cw.test', chatwoot_account_id: 1, chatwoot_token: 't', wa_phone_id: 'P1', wa_token: 'W',
  bot_config: JSON.stringify({ ecom_communication_style: 'shopify' }),
};
const env = { MATRI_CACHE: { get: async (k) => (k === 'ecom_products:7' ? JSON.stringify(PRODUCTS) : null), put: async () => {} } };

async function withMocks(fn, { orders = [] } = {}) {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('graph.facebook.com')) { sent.push({ kind: 'interactive', body: JSON.parse(opts.body) }); return new Response('{}', { status: 200 }); }
    if (u.startsWith('https://cdn.shopify.com/')) return new Response(new Blob(['jpg'], { type: 'image/jpeg' }), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
    if (u.includes('/conversations/')) {
      const body = opts.body instanceof FormData ? { content: opts.body.get('content'), file: !!opts.body.get('attachments[]') } : JSON.parse(opts.body || '{}');
      sent.push({ kind: 'chatwoot', body });
      return new Response('{}', { status: 200 });
    }
    if (u.includes('/meta/bases/')) return new Response(JSON.stringify({ list: [{ title: 'shopify_inventory', id: 'tInv' }, { title: 'shopify_orders', id: 'tOrd' }] }), { status: 200 });
    if (u.includes('/meta/tables/')) return new Response(JSON.stringify({ base_id: 'b1', list: [] }), { status: 200 });
    if (u.includes('/tables/tInv/records')) return new Response(JSON.stringify({ list: VARIANTS }), { status: 200 });
    if (u.includes('/tables/tOrd/records')) return new Response(JSON.stringify({ list: orders }), { status: 200 });
    return new Response(JSON.stringify({ list: [] }), { status: 200 });
  };
  try { return await fn(sent); } finally { globalThis.fetch = realFetch; }
}
const pickerRows = (msg) => (msg.body.interactive.action.sections?.[0].rows || msg.body.interactive.action.buttons.map((b) => b.reply)).map((r) => r.id);
const turn = async (text, stage = '', seed = {}) => {
  const routing = { route: 'ecom_faq' };
  const state = { stage, lead: { OrderCollect: JSON.stringify(seed) } };
  const handled = await engineShopifyFlowTurn(env, c, 7, 42, '919876543210', state, text, 'en', routing);
  return { handled, routing };
};

test('the flow is on for the Shopify style unless switched off', () => {
  assert.equal(engineShopifyFlowOn(c, { ecom_communication_style: 'shopify' }), true);
  assert.equal(engineShopifyFlowOn(c, { ecom_communication_style: 'shopify', shopify_flow_enabled: false }), false);
  assert.equal(engineShopifyFlowOn(c, { ecom_communication_style: 'fashion' }), false);
});

test('"Hi" gets the welcome with category buttons and Track my order', () => withMocks(async (sent) => {
  const { handled, routing } = await turn('Hi');
  assert.equal(handled, true);
  assert.match(routing.reply, /Welcome to \*Yuva Signature\*/);
  assert.equal(routing.next, 'shop_menu');
  assert.deepEqual(pickerRows(sent[0]), ["SHOP_CAT:Men's Trunk", 'SHOP_CAT:Briefs', 'SHOP_TRACK']);
  assert.deepEqual(routing.quickReplies.map((q) => q.value), ["SHOP_CAT:Men's Trunk", 'SHOP_CAT:Briefs', 'SHOP_TRACK']);
}));

test('category tap: photos of in-stock products, then a product picker', () => withMocks(async (sent) => {
  const { routing } = await turn("SHOP_CAT:Men's Trunk", 'shop_menu');
  const photos = sent.filter((s) => s.kind === 'chatwoot' && s.body.file);
  assert.equal(photos.length, 1); // Black has a photo, Grey has none, Navy is sold out
  assert.match(photos[0].body.content, /Black Men's trunk\* · ₹189/);
  assert.deepEqual(pickerRows(sent.at(-1)), ['SHOP_PROD:1', 'SHOP_PROD:4']);
  assert.equal(routing.next, 'shop_category');
  assert.deepEqual(routing.orderCollectSeed, { shopFlow: true, category: "Men's Trunk" });
}));

test('product tap: photo with price and sizes in stock, then a size picker (sold-out sizes left out)', () => withMocks(async (sent) => {
  const { routing } = await turn('SHOP_PROD:1', 'shop_category', { category: "Men's Trunk" });
  const photo = sent.find((s) => s.kind === 'chatwoot' && s.body.file);
  assert.match(photo.body.content, /Black Men's trunk\* — ₹189/);
  assert.match(photo.body.content, /Sizes in stock: 28 · 2XL/);
  assert.deepEqual(pickerRows(sent.at(-1)), ['SHOP_SIZE:101', 'SHOP_SIZE:103']);
  assert.equal(routing.next, 'shop_product');
  assert.equal(routing.orderCollectSeed.productId, '1');
  assert.equal(routing.matchedProductSku, 'BT-28');
}));

test('size tap (or typed size): checkout link for that exact variant', () => withMocks(async (sent) => {
  const { routing } = await turn('SHOP_SIZE:103', 'shop_product', { category: "Men's Trunk", productId: 1 });
  const msg = sent.find((s) => s.kind === 'chatwoot' && /Buy now/.test(s.body.content || ''));
  assert.match(msg.body.content, /Great choice 👌 \*Black Men's trunk – 2XL\* · ₹209/);
  assert.match(msg.body.content, /https:\/\/yuva\.myshopify\.com\/cart\/103:1/);
  assert.deepEqual(pickerRows(sent.at(-1)), ["SHOP_CAT:Men's Trunk", 'SHOP_TRACK', 'SHOP_MENU']);
  assert.equal(routing.next, 'shop_menu');
  const typed = await turn('28', 'shop_product', { productId: 1 });
  assert.match(typed.routing.reply, /cart\/101:1/);
}));

test('products read from the D1 copy (nocodb_id, no Id) work the same', async () => {
  const d1 = PRODUCTS.map(({ Id, ...p }, i) => ({ id: 100 + i, nocodb_id: Id, ...p }));
  const env1 = { MATRI_CACHE: { get: async (k) => (k === 'ecom_products:7' ? JSON.stringify(d1) : null), put: async () => {} } };
  await withMocks(async (sent) => {
    const routing = { route: 'ecom_faq' };
    await engineShopifyFlowTurn(env1, c, 7, 42, '919876543210', { stage: 'shop_menu', lead: {} }, "SHOP_CAT:Men's Trunk", 'en', routing);
    assert.deepEqual(pickerRows(sent.at(-1)), ['SHOP_PROD:1', 'SHOP_PROD:4']);
    const r2 = { route: 'ecom_faq' };
    assert.equal(await engineShopifyFlowTurn(env1, c, 7, 42, '919876543210', { stage: 'shop_category', lead: {} }, 'SHOP_PROD:1', 'en', r2), true);
    assert.equal(r2.next, 'shop_product');
  });
});

test('a sold-out size says so and offers the sizes that are left', () => withMocks(async (sent) => {
  const { routing } = await turn('30', 'shop_product', { productId: 1 });
  assert.match(routing.reply, /size 30 is sold out .* In stock: 28 · 2XL/);
  assert.deepEqual(pickerRows(sent.at(-1)), ['SHOP_SIZE:101', 'SHOP_SIZE:103']);
  assert.equal(routing.next, 'shop_product');
}));

test('a question mid-flow is left for the AI answer', () => withMocks(async () => {
  const { handled } = await turn('is it pure cotton?', 'shop_product', { productId: 1 });
  assert.equal(handled, false);
  assert.equal((await turn('do you deliver to Kochi?', 'shop_category', { category: "Men's Trunk" })).handled, false);
}));

test('after the AI answer, the flow picks up where the customer was (second message)', () => withMocks(async (sent) => {
  const routing = { route: 'ecom_faq', reply: 'Yes — 100% combed cotton 😊' };
  await engineShopifyFlowResume(env, c, 7, 42, '919876543210', { stage: 'shop_product', lead: { OrderCollect: JSON.stringify({ productId: 1 }) } }, routing, 'en', null);
  assert.match(routing.reply, /^Yes — 100% combed cotton 😊\n\nWhich size would you like for \*Black Men's trunk\*\?/);
  assert.deepEqual(pickerRows(sent.at(-1)), ['SHOP_SIZE:101', 'SHOP_SIZE:103']);
  assert.equal(routing.next, 'shop_product');
  // No product in view: back to the menu.
  const r2 = { route: 'ecom_faq', reply: 'We deliver across India in 3–5 days.' };
  await engineShopifyFlowResume(env, c, 7, 42, '919876543210', { stage: '', lead: {} }, r2, 'en', null);
  assert.match(r2.reply, /Anything else I can help you with\?/);
  assert.equal(r2.next, 'shop_menu');
  // A product the AI path matched by name this turn → its sizes.
  const r3 = { route: 'ecom_faq', reply: 'Here it is!' };
  await engineShopifyFlowResume(env, c, 7, 42, '919876543210', { stage: 'shop_menu', lead: {} }, r3, 'en', PRODUCTS[0]);
  assert.equal(r3.next, 'shop_product');
  assert.equal(r3.orderCollectSeed.productId, '1');
}));

test('Track my order: this number’s orders with status and tracking; else asks for the order number', async () => {
  const orders = [{ shopify_order_id: '5', fulfillment_status: 'fulfilled', name: '#1002', created_at: '2026-10-22', customer_phone: '+919876543210', total: 567, currency: 'INR', fulfillments_json: JSON.stringify([{ company: 'Delhivery', number: 'DL123' }]) }];
  await withMocks(async (sent) => {
    const { routing } = await turn('Where is my order?');
    assert.match(routing.reply, /Order #1002/);
    assert.match(routing.reply, /Delhivery DL123/);
    assert.equal(routing.next, 'shop_menu');
  }, { orders });
  await withMocks(async () => {
    const { routing } = await turn('SHOP_TRACK');
    assert.match(routing.reply, /send your order number/);
    assert.equal(routing.next, 'shop_track');
  });
  // Someone else's order number never reveals that order.
  await withMocks(async () => {
    const { routing } = await turn('#1002', 'shop_track');
    assert.match(routing.reply, /couldn't find order #1002 for this WhatsApp number/);
  }, { orders: [{ ...orders[0], customer_phone: '+911111111111' }] });
});
