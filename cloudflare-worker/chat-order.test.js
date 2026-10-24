// Conversational in-chat order (stage 'chat_order'): a product with no online link used to get
// "I'll connect you with our team" + a handover. The LLM now takes the order like a shop assistant;
// these pin the guard rails the code enforces around it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ecomChatOrderSeed, ecomApplyChatOrderTurn, ecomChatOrderItems, ecomChatOrderSystemPrompt, ecomChatOrderExtras } from './worker.js';

const product = { name: 'Affordable Full Romper Set', sku: 'AFR1', price: 999, currency: 'INR',
  description: "Full Romper + Cap. Baby's name printed. Bows optional: ₹60 per bow." };
const turn = (o) => JSON.stringify(o);

test('the prompt carries the verbatim product facts and price, and the reply language', () => {
  const sys = ecomChatOrderSystemPrompt({ client_name: 'Couplo Design Studio' }, ecomChatOrderSeed(product), 'ml');
  assert.match(sys, /Affordable Full Romper Set/);
  assert.match(sys, /₹999/);
  assert.match(sys, /Bows optional: ₹60 per bow/);
  assert.match(sys, /ISO code: ml/);
});

test('details accumulate across turns and earlier values are kept', () => {
  let seed = ecomChatOrderSeed(product);
  seed = ecomApplyChatOrderTurn(seed, turn({ reply: "Lovely! What's your baby's name for the print?", status: 'collecting', details: { customisation: '' } })).seed;
  seed = ecomApplyChatOrderTurn(seed, turn({ reply: 'Aww, Ayra 💕 How many bows?', status: 'collecting', details: { customisation: 'Name: Ayra' } })).seed;
  const r = ecomApplyChatOrderTurn(seed, turn({ reply: 'And your name + address?', status: 'collecting', details: { notes: '2 bows' } }));
  assert.equal(r.seed.details.customisation, 'Name: Ayra');
  assert.equal(r.seed.details.notes, '2 bows');
  assert.equal(ecomChatOrderItems(r.seed), 'Affordable Full Romper Set | Name: Ayra | 2 bows');
});

test('never "confirmed" without a summary shown first and a name + address', () => {
  const seed = ecomChatOrderSeed(product);
  // jumps straight to confirmed with no details → back to collecting
  assert.equal(ecomApplyChatOrderTurn(seed, turn({ reply: 'Done!', status: 'confirmed', details: {} })).status, 'collecting');
  // has name + address but no summary was shown yet → must show the summary (confirm) first
  const full = { customer_name: 'Murshid', delivery_address: 'Kochi 682001' };
  const r1 = ecomApplyChatOrderTurn(seed, turn({ reply: 'Done!', status: 'confirmed', details: full }));
  assert.equal(r1.status, 'confirm');
  // summary shown (status confirm), customer says yes → confirmed
  const r2 = ecomApplyChatOrderTurn(r1.seed, turn({ reply: 'Thank you! 🎉', status: 'confirmed', details: {} }));
  assert.equal(r2.status, 'confirmed');
});

test('unusable model output returns null; off_topic passes through', () => {
  const seed = ecomChatOrderSeed(product);
  assert.equal(ecomApplyChatOrderTurn(seed, 'not json'), null);
  assert.equal(ecomApplyChatOrderTurn(seed, turn({ reply: '', status: 'collecting' })), null);
  assert.equal(ecomApplyChatOrderTurn(seed, turn({ reply: '', status: 'off_topic' })).status, 'off_topic');
});

test('details mentioned in passing land in the order: size/colour in items, the rest in their own fields', () => {
  const sys = ecomChatOrderSystemPrompt({}, ecomChatOrderSeed(product), 'en');
  for (const k of ['size', 'colour', 'landmark', 'customer_email', 'alternate_phone', 'payment_method', 'delivery_date', 'gift_message'])
    assert.match(sys, new RegExp(`"${k}":""`), k);
  const r = ecomApplyChatOrderTurn(ecomChatOrderSeed(product), turn({ reply: 'Noted 😊', status: 'collecting',
    details: { size: '0-3 months', colour: 'Pink', customisation: 'Name: Ayra', delivery_address: 'Kochi 682001', landmark: 'near St. Mary\'s church',
      customer_email: 'murshid@example.com', payment_method: 'COD', delivery_date: 'before 10th', gift_message: 'Happy 1st month!' } }));
  assert.equal(ecomChatOrderItems(r.seed), 'Affordable Full Romper Set | Size: 0-3 months | Colour: Pink | Name: Ayra');
  assert.deepEqual(ecomChatOrderExtras(r.seed.details), {
    delivery_address: "Kochi 682001 — Landmark: near St. Mary's church",
    customer_email: 'murshid@example.com', payment_method: 'COD',
    notes: 'Wanted by: before 10th\nGift message: Happy 1st month!\nPayment: COD' });
  // a non-email in the email slot is dropped, nothing given → nothing written
  assert.deepEqual(ecomChatOrderExtras({ customer_email: 'call me' }), {});
});
