// Shopify Orders / Stock modules — payload mapping, out-of-order guard, inventory totals, paging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shopifyOrderRow, shopifyIsStale, shopifyMergeFulfillment, shopifyInventoryRows, shopifyLevelsSummary, shopifyNextPageInfo, shopifySyncOnWebhook, shopifySettings, shopifyEcomProductFields, shopifyEcomProductPlan, shopifyEcomOrderStatus, shopifyEcomNextStatus, shopifyEcomOrderFields, shopifyEcomOrderPlan, shopifyStockFromVariants, shopifyHtmlToText, SHOPIFY_UNTRACKED_STOCK } from './shopify-sync.js';

const SHOP = 'demo.myshopify.com';

test('order payload maps to a shopify_orders row', () => {
  const row = shopifyOrderRow(42, SHOP, {
    id: 5001, name: '#1001', created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T11:00:00Z',
    email: 'a@b.in', financial_status: 'paid', fulfillment_status: null, total_price: '1299.00', subtotal_price: '1199.00',
    total_discounts: '0.00', total_tax: '50.00', currency: 'INR', shipping_lines: [{ price: '50.00' }],
    customer: { first_name: 'Asha', last_name: 'K' }, shipping_address: { first_name: 'Asha', address1: '1 MG Rd', city: 'Kochi', country: 'India', phone: '+919999' },
    line_items: [{ title: 'Kurta', variant_title: 'M', quantity: 2, price: '599.50', sku: 'K-M', variant_id: 9 }],
    fulfillments: [{ id: 7, status: 'success', tracking_number: 'TRK1', tracking_url: 'https://t/1' }],
    payment_gateway_names: ['razorpay'], tags: 'vip',
  });
  assert.equal(row.client_id, '42');
  assert.equal(row.shopify_order_id, '5001');
  assert.equal(row.customer_name, 'Asha K');
  assert.equal(row.customer_phone, '+919999');
  assert.equal(row.fulfillment_status, 'unfulfilled');
  assert.equal(row.total, 1299);
  assert.equal(row.shipping_total, 50);
  assert.equal(row.items_count, 2);
  assert.equal(row.gateway, 'razorpay');
  assert.equal(JSON.parse(row.line_items_json)[0].sku, 'K-M');
  assert.equal(JSON.parse(row.fulfillments_json)[0].number, 'TRK1');
  assert.equal(JSON.parse(row.shipping_address).city, 'Kochi');
});

test('an older webhook never overwrites a newer row', () => {
  assert.equal(shopifyIsStale('2026-10-20T11:00:00Z', '2026-10-20T10:59:00Z'), true);
  assert.equal(shopifyIsStale('2026-10-20T11:00:00Z', '2026-10-20T11:00:00Z'), false);
  assert.equal(shopifyIsStale('', '2026-10-20T11:00:00Z'), false);
});

test('fulfillment updates merge into the stored list by id', () => {
  let j = shopifyMergeFulfillment('', { id: 7, status: 'success', tracking_number: 'A' });
  j = shopifyMergeFulfillment(j, { id: 7, status: 'success', shipment_status: 'delivered', tracking_number: 'A' });
  j = shopifyMergeFulfillment(j, { id: 8, status: 'success', tracking_numbers: ['B'] });
  const list = JSON.parse(j);
  assert.equal(list.length, 2);
  assert.equal(list[0].shipment_status, 'delivered');
  assert.equal(list[1].number, 'B');
});

test('product payload maps to one inventory row per variant', () => {
  const rows = shopifyInventoryRows(42, SHOP, {
    id: 1, title: 'Kurta', product_type: 'Apparel', vendor: 'Own', status: 'active', handle: 'kurta',
    image: { src: 'https://img/main.jpg' }, images: [{ id: 11, src: 'https://img/main.jpg' }, { id: 12, src: 'https://img/red.jpg' }],
    variants: [
      { id: 101, title: 'Default Title', sku: 'K', price: '599', inventory_quantity: 4, inventory_item_id: 9001, inventory_management: 'shopify' },
      { id: 102, title: 'Red', image_id: 12, price: '649', inventory_quantity: -1, inventory_item_id: 9002, inventory_management: null },
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].variant_title, '');
  assert.equal(rows[0].available, 4);
  assert.equal(rows[0].tracked, 'Yes');
  assert.equal(rows[1].image_url, 'https://img/red.jpg');
  assert.equal(rows[1].tracked, 'No');
  assert.equal(rows[1].inventory_item_id, '9002');
});

test('stock available is the total across locations', () => {
  const s = shopifyLevelsSummary([
    { inventory_item_id: 9001, location_id: 1, available: 3 },
    { inventory_item_id: 9001, location_id: 2, available: 5 },
    { inventory_item_id: 9002, location_id: 1, available: 99 },
  ], 9001);
  assert.equal(s.available, 8);
  assert.deepEqual(JSON.parse(s.levels_json), { 1: 3, 2: 5 });
});

test('Link header paging', () => {
  assert.equal(shopifyNextPageInfo('<https://x.myshopify.com/admin/api/2026-07/products.json?limit=250&page_info=abc>; rel="next"'), 'abc');
  assert.equal(shopifyNextPageInfo('<https://x/a?page_info=p>; rel="previous", <https://x/a?page_info=n>; rel="next"'), 'n');
  assert.equal(shopifyNextPageInfo('<https://x/a?page_info=p>; rel="previous"'), '');
  assert.equal(shopifyNextPageInfo(null), '');
});

test('order webhook creates the row, a stale retry is skipped', async () => {
  const calls = [];
  let stored = null;
  const deps = {
    clientsTable: 'clients', apiVersion: '2026-07', json: (d) => d, getClientById: async () => null,
    reportOpsError: async (env, ctx, e) => { throw e; },
    ncTableMeta: async () => ({ info: { base_id: 'b1' } }),
    ncFetch: async (env, path, opts = {}) => {
      calls.push([opts.method || 'GET', path, opts.body]);
      if (path.startsWith('api/v2/meta/bases/')) return { ok: true, json: async () => ({ list: [{ title: 'shopify_orders', id: 'tOrders' }] }) };
      if ((opts.method || 'GET') === 'GET') return { ok: true, json: async () => ({ list: stored ? [stored] : [] }) };
      if (opts.method === 'POST') stored = { Id: 1, ...opts.body[0] };
      return { ok: true, json: async () => ({}) };
    },
  };
  const ecomOrders = [];
  deps.syncEcomOrders = async (env, c, orders) => { ecomOrders.push(...orders.map(o => o.id)); };
  const c = { Id: 42, shopify_shop_domain: SHOP, shopify_access_token: 'tok' };
  await shopifySyncOnWebhook({}, deps, c, 'orders/create', { id: 5001, name: '#1001', updated_at: '2026-10-20T11:00:00Z', financial_status: 'paid' });
  assert.equal(stored.shopify_order_id, '5001');
  const writesBefore = calls.filter(([m]) => m !== 'GET').length;
  await shopifySyncOnWebhook({}, deps, c, 'orders/updated', { id: 5001, name: '#1001', updated_at: '2026-10-20T10:00:00Z', financial_status: 'pending' });
  assert.equal(calls.filter(([m, , body]) => m === 'PATCH' && body.length).length, 0);
  assert.equal(calls.filter(([m]) => m !== 'GET').length, writesBefore);
  // Copied into Ecom Orders once — the stale retry isn't.
  assert.deepEqual(ecomOrders, [5001]);
});

test('Shopify page settings default to on and read from shopify_notify_config', () => {
  assert.deepEqual(shopifySettings({}), { notify: true, low_stock: 5 });
  assert.equal(shopifySettings({ shopify_notify_config: 'not json' }).notify, true);
  const s = shopifySettings({ shopify_notify_config: JSON.stringify({ config: {}, settings: { notify: false, low_stock: 2 } }) });
  assert.equal(s.notify, false);
  assert.equal(s.low_stock, 2);
});

const KURTA = {
  id: 1, title: 'Kurta', handle: 'kurta', status: 'active', product_type: 'Apparel', vendor: 'Own',
  body_html: '<p>Soft <b>cotton</b> &amp; linen</p><ul><li>Hand wash</li></ul>',
  options: [{ name: 'Size', values: ['M', 'L'] }, { name: 'Color', values: ['Blue'] }],
  variants: [
    { id: 101, title: 'M / Blue', sku: 'K-M', price: '649.00', inventory_management: 'shopify', inventory_quantity: 2 },
    { id: 102, title: 'L / Blue', sku: 'K-L', price: '599.00', inventory_management: 'shopify', inventory_quantity: -1 },
  ],
  images: [{ src: 'https://cdn/k1.jpg' }, { src: 'https://cdn/k2.jpg' }],
};

test('a Shopify product maps to one Ecom product', () => {
  const f = shopifyEcomProductFields(SHOP, KURTA);
  assert.equal(f.name, 'Kurta');
  assert.equal(f.sku, 'K-M');
  assert.equal(f.price, 599);
  assert.equal(f.stock, 2); // oversold variant counts as 0
  assert.equal(f.status, 'active');
  assert.equal(f.shopify_product_id, '1');
  assert.equal(f.shopify_product_url, 'https://demo.myshopify.com/products/kurta');
  assert.equal(f.size, 'M, L');
  assert.equal(f.color, 'Blue');
  assert.equal(f.variant, 'M / Blue, L / Blue');
  assert.equal(f.category, 'Apparel');
  assert.equal(f.brand, 'Own');
  assert.equal(f.description, 'Soft cotton & linen\n• Hand wash');
  assert.equal(f.image_url, 'https://cdn/k1.jpg');
  assert.equal(f.image_url_2, 'https://cdn/k2.jpg');
  assert.equal('image_url_3' in f, false); // a photo added in Ecom stays
  const draft = shopifyEcomProductFields(SHOP, { ...KURTA, status: 'draft' });
  assert.equal(draft.status, 'inactive');
  assert.equal(draft.shopify_product_url, '');
});

test('stock: tracked variants are summed, any untracked one means always available', () => {
  assert.equal(shopifyStockFromVariants([{ tracked: true, available: 3 }, { tracked: true, available: 4 }]), 7);
  assert.equal(shopifyStockFromVariants([{ tracked: true, available: 0 }, { tracked: false, available: 0 }]), SHOPIFY_UNTRACKED_STOCK);
  assert.equal(shopifyStockFromVariants([]), 0);
  assert.equal(shopifyHtmlToText('a<br>b&nbsp;c'), 'a\nb c');
});

test('product plan: update linked, adopt by SKU, create new, skip new drafts, deactivate what left Shopify', () => {
  const saree = { id: 2, title: 'Saree', handle: 'saree', status: 'active', variants: [{ id: 201, sku: 'S-1', price: '2500', inventory_management: null }] };
  const draft = { id: 3, title: 'Draft', handle: 'draft', status: 'draft', variants: [{ id: 301, sku: 'D-1', price: '10' }] };
  const shawl = { id: 4, title: 'Shawl', handle: 'shawl', status: 'active', variants: [{ id: 401, sku: 'SH-1', price: '900', inventory_management: 'shopify', inventory_quantity: 5 }] };
  const existing = [
    { Id: 10, shopify_product_id: '1', name: 'Old kurta', sku: 'K-M', price: 649, stock: 2, status: 'active' },
    { Id: 11, sku: 's-1', name: 'Saree (hand made)', status: 'active', audio_url: 'https://a' },
    { Id: 12, shopify_product_id: '9', name: 'Gone', status: 'active' },
    { Id: 13, sku: 'X', name: 'Not on Shopify', status: 'active' },
  ];
  const { creates, updates } = shopifyEcomProductPlan(SHOP, existing, [KURTA, saree, draft, shawl], { replaceAll: true });
  assert.deepEqual(creates.map(c => c.name), ['Shawl']);
  assert.equal(creates[0].stock, 5);
  assert.deepEqual(updates.map(u => u.Id), [10, 11, 12]);
  assert.equal(updates[0].name, 'Kurta');
  assert.equal(updates[1].shopify_product_id, '2');
  assert.equal(updates[1].stock, SHOPIFY_UNTRACKED_STOCK);
  assert.equal('audio_url' in updates[1], false);
  assert.deepEqual(updates[2], { Id: 12, status: 'inactive' });
  // A webhook (no replaceAll) never deactivates other products; unchanged rows aren't rewritten.
  const same = { Id: 10, ...shopifyEcomProductFields(SHOP, KURTA) };
  assert.deepEqual(shopifyEcomProductPlan(SHOP, [same, existing[2]], [KURTA]), { creates: [], updates: [] });
  // products/delete
  assert.deepEqual(shopifyEcomProductPlan(SHOP, existing, [], { deletedIds: [9] }).updates, [{ Id: 12, status: 'inactive' }]);
});

test('order status follows Shopify and never moves backwards', () => {
  assert.equal(shopifyEcomOrderStatus({ financial_status: 'pending' }), 'received');
  assert.equal(shopifyEcomOrderStatus({ financial_status: 'paid' }), 'processing');
  assert.equal(shopifyEcomOrderStatus({ financial_status: 'paid', fulfillment_status: 'partial' }), 'shipped');
  assert.equal(shopifyEcomOrderStatus({ fulfillments: [{ shipment_status: 'delivered' }] }), 'delivered');
  assert.equal(shopifyEcomOrderStatus({ fulfillments: [{ shipment_status: 'delivered' }, { shipment_status: 'in_transit' }] }), 'shipped');
  assert.equal(shopifyEcomOrderStatus({ financial_status: 'paid', cancelled_at: '2026-10-20' }), 'cancelled');
  assert.equal(shopifyEcomOrderStatus({ financial_status: 'refunded' }), 'cancelled');
  assert.equal(shopifyEcomNextStatus('delivered', 'shipped'), 'delivered');
  assert.equal(shopifyEcomNextStatus('received', 'processing'), 'processing');
  assert.equal(shopifyEcomNextStatus('shipped', 'cancelled'), 'cancelled');
  assert.equal(shopifyEcomNextStatus('cancelled', 'processing'), 'cancelled');
  assert.equal(shopifyEcomNextStatus('', 'received'), 'received');
  assert.equal(shopifyEcomNextStatus('on hold', 'processing'), 'processing');
});

test('a Shopify order maps to an Ecom order row', () => {
  const f = shopifyEcomOrderFields(42, { id: 5001, name: '#1001', created_at: '2026-10-20T10:00:00Z', financial_status: 'paid', total_price: '1299.00', currency: 'INR',
    customer: { first_name: 'Asha', last_name: 'K' }, shipping_address: { phone: '+9199', address1: '1 MG Rd', city: 'Kochi', country: 'India' },
    line_items: [{ title: 'Kurta', quantity: 2, price: '599.50', sku: 'K-M' }] });
  assert.deepEqual({ ...f, line_items_json: JSON.parse(f.line_items_json) }, {
    client_id: '42', shopify_order_id: '5001', status: 'processing', order_id: '#1001', customer_name: 'Asha K', customer_phone: '+9199',
    order_date: '2026-10-20', items: '2x Kurta', line_items_json: [{ title: 'Kurta', quantity: 2, price: 599.5, sku: 'K-M' }],
    total: 1299, currency: 'INR', delivery_address: '1 MG Rd, Kochi, India',
  });
  assert.equal(shopifyEcomOrderFields(42, { id: 1 }, 'shipped').status, 'shipped');
});

test('order plan writes only new or changed orders', () => {
  const o = { id: 5001, name: '#1001', created_at: '2026-10-20T10:00:00Z', financial_status: 'paid', total_price: '1299.00', line_items: [] };
  const row = { Id: 7, ...shopifyEcomOrderFields(42, o), total: '1299.00' };
  assert.deepEqual(shopifyEcomOrderPlan(42, [row], [o]), { creates: [], updates: [] });
  const shipped = { ...o, fulfillment_status: 'fulfilled' };
  assert.equal(shopifyEcomOrderPlan(42, [row], [shipped]).updates[0].status, 'shipped');
  // Staff marked it delivered by hand: a later "paid" sync changes nothing.
  assert.deepEqual(shopifyEcomOrderPlan(42, [{ ...row, status: 'delivered' }], [o]).updates, []);
  const fresh = shopifyEcomOrderPlan(42, [], [o, { ...o }]);
  assert.equal(fresh.creates.length, 1);
});
