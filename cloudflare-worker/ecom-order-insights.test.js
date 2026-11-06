// Baby Care Orders tab: lead source / assignee per order, warm leads, order session, duplicates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ecomIsBabyCare, ecomPhoneKey, ecomFindDuplicateOrder, ecomLeadSourceLabel, ecomOrderLeadInsight,
  ecomWarmLeads, ecomOrderSessionSummary } from './worker.js';

const NOW = Date.parse('2026-10-15T12:00:00Z');
const hist = (n, from = '2026-10-15T09:00:00Z') => JSON.stringify(Array.from({ length: n * 2 }, (_, i) => ({
  role: i % 2 ? 'assistant' : 'user', content: `m${i}`, ts: new Date(Date.parse(from) + i * 60000).toISOString() })));

test('only Baby Care stores get the new Orders features', () => {
  assert.equal(ecomIsBabyCare({ bot_config: JSON.stringify({ ecom_communication_style: 'baby_care' }) }), true);
  assert.equal(ecomIsBabyCare({ bot_config: JSON.stringify({ ecom_communication_style: 'fashion_garments' }) }), false);
  assert.equal(ecomIsBabyCare({ bot_config: 'not json' }), false);
  assert.equal(ecomIsBabyCare(null), false);
});

test('phone formats of the same customer match', () => {
  assert.equal(ecomPhoneKey('+91 98765 43210'), '9876543210');
  assert.equal(ecomPhoneKey('919876543210'), ecomPhoneKey('9876543210'));
  assert.equal(ecomPhoneKey(''), '');
});

test('duplicate: same phone, open order in the last 24h', () => {
  const orders = [
    { Id: 1, customer_phone: '919876543210', status: 'pending', items: 'Romper Set | Name: Ayra', CreatedAt: '2026-10-15T10:00:00Z', order_id: 'ORD-1' },
    { Id: 2, customer_phone: '919876543210', status: 'delivered', items: 'Jhabla', CreatedAt: '2026-10-15T11:00:00Z' },
    { Id: 3, customer_phone: '919800000000', status: 'pending', items: 'Jhabla', CreatedAt: '2026-10-15T11:00:00Z' },
  ];
  assert.equal(ecomFindDuplicateOrder(orders, { customer_phone: '+91 98765 43210', items: 'Anything' }, { now: NOW })?.Id, 1);
  // bot confirmations only count the same items as a duplicate
  assert.equal(ecomFindDuplicateOrder(orders, { customer_phone: '9876543210', items: 'Other set' }, { now: NOW, sameItemsOnly: true }), null);
  assert.equal(ecomFindDuplicateOrder(orders, { customer_phone: '9876543210', items: 'romper set |  name: ayra' }, { now: NOW, sameItemsOnly: true })?.Id, 1);
  // older than 24h, cancelled, or the row itself → not a duplicate
  assert.equal(ecomFindDuplicateOrder(orders, { customer_phone: '9876543210' }, { now: NOW + 2 * 86400000 }), null);
  assert.equal(ecomFindDuplicateOrder([{ ...orders[0], status: 'cancelled' }], { customer_phone: '9876543210' }, { now: NOW }), null);
  assert.equal(ecomFindDuplicateOrder(orders, { Id: 1, customer_phone: '9876543210' }, { now: NOW }), null);
  assert.equal(ecomFindDuplicateOrder(orders, { customer_phone: '' }, { now: NOW }), null);
});

test('lead source in plain words', () => {
  assert.equal(ecomLeadSourceLabel({ CreatedVia: 'chatwoot', Channel: 'whatsapp' }), 'WhatsApp chat');
  assert.equal(ecomLeadSourceLabel({ CreatedVia: 'chatwoot', Channel: 'instagram' }), 'Instagram chat');
  assert.equal(ecomLeadSourceLabel({ CreatedVia: 'lead_ad', LeadSource: 'Instagram Lead Ad' }), 'Instagram Lead Ad');
  assert.equal(ecomLeadSourceLabel({ CreatedVia: 'manual' }), 'Added manually');
  assert.equal(ecomLeadSourceLabel({ ConversationID: '55' }), 'WhatsApp chat');
  assert.equal(ecomLeadSourceLabel({}), 'Unknown');
});

test('lead insight: assignee name from the team, message counts, no message text', () => {
  const i = ecomOrderLeadInsight({ Id: 9, Name: 'Murshid', Phone: '919876543210', Owner: 'Riya@Shop.in', CreatedVia: 'manual', CreatedBy: 'admin@shop.in',
    ConvHistory: hist(3), LastMsgAt: '2026-10-15T09:05:00Z' }, { 'riya@shop.in': 'Riya' });
  assert.equal(i.owner_name, 'Riya');
  assert.equal(i.source, 'Added manually');
  assert.equal(i.created_by, 'admin@shop.in');
  assert.equal(i.customer_msgs, 3);
  assert.equal(i.bot_msgs, 3);
  assert.equal(i.first_at, '2026-10-15T09:00:00.000Z');
  assert.ok(!JSON.stringify(i).includes('m0'));
  assert.equal(ecomOrderLeadInsight({ Owner: 'sam@shop.in' }).owner_name, 'sam');
});

test('warm leads: several AI interactions and no placed order yet', () => {
  const leads = [
    ecomOrderLeadInsight({ Id: 1, Phone: '919876543210', ConvHistory: hist(3), LastMsgAt: '2026-10-15T09:00:00Z' }),
    ecomOrderLeadInsight({ Id: 2, Phone: '919800000000', ConvHistory: hist(4), LastMsgAt: '2026-10-15T10:00:00Z' }), // ordered
    ecomOrderLeadInsight({ Id: 3, Phone: '919811111111', ConvHistory: hist(1) }), // one message only
    ecomOrderLeadInsight({ Id: 4, Phone: '919822222222', ConvHistory: hist(5), OptOut: 'Yes' }),
    ecomOrderLeadInsight({ Id: 5, Phone: '919833333333', ConvHistory: hist(2), LastMsgAt: '2026-10-15T11:00:00Z' }), // draft only
  ];
  const orders = [
    { Id: 10, customer_phone: '9800000000', status: 'pending' },
    { Id: 11, customer_phone: '919876543210', status: 'cancelled' },
    { Id: 12, customer_phone: '919833333333', status: 'draft', order_id: 'ORD-12' },
  ];
  const warm = ecomWarmLeads(leads, orders);
  assert.deepEqual(warm.map(l => l.lead_id), [5, 1]);
  assert.equal(warm[0].draft_order, 'ORD-12');
  assert.equal(warm[1].draft_order, null);
});

test('order session: start, time to order, messages before the order, recent lines', () => {
  const s = ecomOrderSessionSummary({ Id: 3, order_id: 'ORD-3', status: 'pending', CreatedAt: '2026-10-15T09:03:30Z' },
    { Phone: '919876543210', Owner: 'riya@shop.in', CreatedVia: 'chatwoot', ConvHistory: hist(5) }, { 'riya@shop.in': 'Riya' });
  assert.equal(s.order_id, 'ORD-3');
  assert.equal(s.minutes_to_order, 4);
  assert.equal(s.customer_msgs_before_order, 3);
  assert.equal(s.bot_msgs_before_order, 2);
  assert.equal(s.customer_msgs, 5);
  assert.equal(s.recent.length, 8);
  assert.equal(s.recent[0].role, 'customer');
  assert.equal(s.owner_name, 'Riya');
  // no chat for this order → zeros, not a crash
  const none = ecomOrderSessionSummary({ Id: 4 }, null);
  assert.equal(none.customer_msgs, 0);
  assert.equal(none.minutes_to_order, null);
});
