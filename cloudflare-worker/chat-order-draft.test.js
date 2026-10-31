// Baby Care: half-taken in-chat orders show on the Orders tab as 'draft' rows that follow the chat,
// and later customer changes ("change the address to …") update the order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ecomChatOrderSeed, ecomDraftOrderFields, ecomDraftOrderChanges, ECOM_DRAFT_ORDER_STAGES,
  ecomOrderUpdateWorthChecking, ecomParseOrderUpdate, ecomOrderUpdatePrompt } from './worker.js';

const product = { name: 'Affordable Full Romper Set', sku: 'AFR1', price: 999, currency: 'INR', description: 'Name printed.' };

test('every in-progress Baby Care order step counts as a draft stage', () => {
  for (const s of ['chat_order', 'baby_quality_select', 'baby_customize', 'baby_print_theme', 'baby_addons', 'baby_order_details', 'baby_order_confirm'])
    assert.ok(ECOM_DRAFT_ORDER_STAGES.has(s), s);
  assert.ok(!ECOM_DRAFT_ORDER_STAGES.has('new'));
  assert.ok(!ECOM_DRAFT_ORDER_STAGES.has('human_handover'));
});

test('conversational order: draft carries product, customisation, qty-priced total, name, address', () => {
  const seed = { ...ecomChatOrderSeed(product), details: { quantity: '2', customisation: 'Name: Ayra', customer_name: 'Murshid', delivery_address: 'Kochi 682001' } };
  assert.deepEqual(ecomDraftOrderFields(seed), {
    items: 'Affordable Full Romper Set × 2 | Name: Ayra', total: 1998, currency: 'INR',
    customer_name: 'Murshid', delivery_address: 'Kochi 682001' });
});

test('button custom-set flow: draft lists the choices made so far', () => {
  const f = ecomDraftOrderFields({ babyCareFlow: true, qualityTier: 'Premium', accentColor: 'Pink' });
  assert.equal(f.items, 'Custom Baby Set | Quality: Premium | Accent colour: Pink');
  assert.equal(f.customer_name, undefined);
  assert.equal(f.delivery_address, undefined);
  assert.deepEqual(ecomDraftOrderFields({ some: 'other flow' }), {});
});

test('only fields the chat actually changed are written, so staff edits survive other turns', () => {
  const prev = { babyCareFlow: true, qualityTier: 'Premium', accentColor: 'Pink', draftOrderId: 7 };
  assert.deepEqual(ecomDraftOrderChanges(prev, { ...prev }), {});
  assert.deepEqual(ecomDraftOrderChanges(prev, { ...prev, address: 'Calicut 673001', customerName: 'Fathima' }),
    { customer_name: 'Fathima', delivery_address: 'Calicut 673001' });
  // customer changes their colour → items rewritten
  assert.deepEqual(Object.keys(ecomDraftOrderChanges(prev, { ...prev, accentColor: 'Blue' })), ['items']);
});

test('later-update check skips button taps and small talk', () => {
  assert.equal(ecomOrderUpdateWorthChecking('BABY_CONFIRM'), false);
  assert.equal(ecomOrderUpdateWorthChecking('ok'), false);
  assert.equal(ecomOrderUpdateWorthChecking('Thank you!'), false);
  assert.equal(ecomOrderUpdateWorthChecking('address maattanam: Thrissur 680001'), true);
});

test('customer update: only real changes are patched, items keep their full text', () => {
  const order = { items: 'Romper Set | Name: Aira', customer_name: 'Murshid', delivery_address: 'Kochi 682001', notes: '' };
  assert.match(ecomOrderUpdatePrompt(order), /Name: Aira/);
  assert.equal(ecomParseOrderUpdate(order, '{"changed":false}'), null);
  assert.equal(ecomParseOrderUpdate(order, 'not json'), null);
  // "changed" but nothing actually differs → no write
  assert.equal(ecomParseOrderUpdate(order, '{"changed":true,"customer_name":"Murshid"}'), null);
  const u = ecomParseOrderUpdate(order, '```json\n{"changed":true,"items":"Romper Set | Name: Ayra","delivery_address":"Thrissur 680001","customer_name":"","summary":"Name spelling and address changed"}\n```');
  assert.deepEqual(u.patch, { items: 'Romper Set | Name: Ayra', delivery_address: 'Thrissur 680001' });
  assert.equal(u.summary, 'Name spelling and address changed');
});

test('draft picks up email + payment from the chat but leaves notes to staff', () => {
  const seed = { ...ecomChatOrderSeed(product), details: { customer_email: 'a@b.co', payment_method: 'UPI', delivery_date: 'Sunday' } };
  const f = ecomDraftOrderFields(seed);
  assert.equal(f.customer_email, 'a@b.co');
  assert.equal(f.payment_method, 'UPI');
  assert.equal(f.notes, undefined);
});

test('customer update: email/payment patched, a wanted-by date is appended as a note', () => {
  const order = { items: 'Romper Set', customer_name: 'Murshid', delivery_address: 'Kochi', notes: 'Staff: gift wrap' };
  assert.match(ecomOrderUpdatePrompt(order), /Payment method:/);
  const u = ecomParseOrderUpdate(order, '{"changed":true,"payment_method":"COD","customer_email":"not an email","notes":"Wanted by: 10 Oct","summary":"Pays COD, needs it by 10 Oct"}');
  assert.deepEqual(u.patch, { payment_method: 'COD' });
  assert.equal(u.note, 'Wanted by: 10 Oct');
  // only a note, already on the order → nothing to do
  assert.equal(ecomParseOrderUpdate({ ...order, notes: 'Wanted by: 10 Oct' }, '{"changed":true,"notes":"Wanted by: 10 Oct"}'), null);
});
