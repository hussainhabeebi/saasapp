// Shopify Orders / Stock modules — payload mapping, out-of-order guard, inventory totals, paging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shopifyOrderRow, shopifyIsStale, shopifyMergeFulfillment, shopifyInventoryRows, shopifyLevelsSummary, shopifyNextPageInfo, shopifySyncOnWebhook, shopifySettings, shopifyProductLinkPatches } from './shopify-sync.js';

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
  const c = { Id: 42, shopify_shop_domain: SHOP, shopify_access_token: 'tok' };
  await shopifySyncOnWebhook({}, deps, c, 'orders/create', { id: 5001, name: '#1001', updated_at: '2026-10-20T11:00:00Z', financial_status: 'paid' });
  assert.equal(stored.shopify_order_id, '5001');
  const writesBefore = calls.filter(([m]) => m !== 'GET').length;
  await shopifySyncOnWebhook({}, deps, c, 'orders/updated', { id: 5001, name: '#1001', updated_at: '2026-10-20T10:00:00Z', financial_status: 'pending' });
  assert.equal(calls.filter(([m, , body]) => m === 'PATCH' && body.length).length, 0);
  assert.equal(calls.filter(([m]) => m !== 'GET').length, writesBefore);
});

test('Shopify page settings default to on and read from shopify_notify_config', () => {
  assert.deepEqual(shopifySettings({}), { notify: true, ecom_orders: true, auto_links: true, low_stock: 5 });
  assert.deepEqual(shopifySettings({ shopify_notify_config: 'not json' }).notify, true);
  const s = shopifySettings({ shopify_notify_config: JSON.stringify({ config: {}, settings: { notify: false, low_stock: 2 } }) });
  assert.equal(s.notify, false);
  assert.equal(s.low_stock, 2);
  assert.equal(s.auto_links, true);
});

test('product links are filled by SKU, only ever replacing links this module wrote', () => {
  const inv = [
    { shopify_product_id: '1', shopify_variant_id: '101', sku: 'K-M', handle: 'kurta', product_status: 'active' },
    { shopify_product_id: '1', shopify_variant_id: '102', sku: 'K-L', handle: 'kurta', product_status: 'active' },
    { shopify_product_id: '2', shopify_variant_id: '201', sku: 'S-1', handle: 'saree', product_status: 'active' },
    { shopify_product_id: '3', shopify_variant_id: '301', sku: 'D-1', handle: 'draft-thing', product_status: 'draft' },
  ];
  const products = [
    { Id: 1, sku: 'k-m', shopify_product_url: '' },
    { Id: 2, sku: 'S-1', shopify_product_url: 'https://demo.myshopify.com/products/old-saree' },
    { Id: 3, sku: 'K-L', shopify_product_url: 'https://amazon.in/dp/X' },
    { Id: 4, sku: 'D-1', shopify_product_url: 'https://demo.myshopify.com/products/draft-thing' },
    { Id: 5, sku: '', shopify_product_url: '' },
    { Id: 6, sku: 'NOPE', shopify_product_url: '' },
  ];
  assert.deepEqual(shopifyProductLinkPatches(SHOP, products, inv), [
    { Id: 1, shopify_product_url: 'https://demo.myshopify.com/products/kurta?variant=101' },
    { Id: 2, shopify_product_url: 'https://demo.myshopify.com/products/saree' },
    { Id: 4, shopify_product_url: '' },
  ]);
  // A webhook only touches its own product's SKUs.
  assert.deepEqual(shopifyProductLinkPatches(SHOP, products, inv, ['S-1']), [
    { Id: 2, shopify_product_url: 'https://demo.myshopify.com/products/saree' },
  ]);
  // products/delete: the SKUs are gone from Shopify, so their links are cleared.
  assert.deepEqual(shopifyProductLinkPatches(SHOP, products, [], ['D-1', 'K-L']), [{ Id: 4, shopify_product_url: '' }]);
});
