// 4L style (four-l.js): Baby Care + bot answers product questions only, team handles the rest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fourLDecide, fourLIsProductQuery, fourLIsStyle, ecomStyleIsBabyCare, fourLHandoffText, fourLExtraKeywords, FOUR_L_DEFAULT_HANDOFF } from './four-l.js';
import { ecomIsBabyCare } from './worker.js';

const c4l = { bot_config: JSON.stringify({ ecom_communication_style: 'four_l' }) };

test('4L is a style of its own and runs everything Baby Care runs', () => {
  assert.equal(fourLIsStyle(c4l), true);
  assert.equal(fourLIsStyle({ bot_config: JSON.stringify({ ecom_communication_style: 'baby_care' }) }), false);
  assert.equal(ecomStyleIsBabyCare('four_l'), true);
  assert.equal(ecomStyleIsBabyCare('baby_care'), true);
  assert.equal(ecomStyleIsBabyCare('fashion'), false);
  assert.equal(ecomIsBabyCare(c4l), true);
});

test('size, colour, price, stock, fabric and photo questions are product questions', () => {
  for (const q of ['What sizes do you have?', 'Is this available in red colour?', 'price?', 'Do you have XL?',
    'Is it cotton?', 'send photos', 'any new arrivals', 'size 38 undo', 'kalar ethra und', 'വില എത്ര'])
    assert.equal(fourLIsProductQuery(q), true, q);
});

test('a product named in the message counts, other questions do not', () => {
  const products = [{ name: 'Princess Frill Set', sku: 'BABY-PINK-01', category: 'Baby Sets' }];
  assert.equal(fourLIsProductQuery('princess frill set', { products }), true);
  assert.equal(fourLIsProductQuery('Where is your shop located?', { products }), false);
  assert.equal(fourLIsProductQuery('I want a refund for the red dress', { products }), false);
});

test('decide: greeting and product questions → bot, anything else → team', () => {
  assert.equal(fourLDecide({ text: 'Hi', isNewLead: true }), 'bot');
  assert.equal(fourLDecide({ text: 'What sizes are available?' }), 'bot');
  assert.equal(fourLDecide({ text: 'Where is my order?' }), 'handoff');
  assert.equal(fourLDecide({ text: 'What time do you close today?' }), 'handoff');
  assert.equal(fourLDecide({ text: 'BABY_TIER_PREMIUM' }), 'bot');
  // In a shopping step, typed answers (name, address) belong to the flow.
  assert.equal(fourLDecide({ text: 'Rahul, MG Road Kochi', stage: 'order_collect_address' }), 'bot');
});

test('while with the team: product questions in between are still answered, the rest stays silent', () => {
  const lead = { Handover: 'Yes', Stage: 'human_handover' };
  assert.equal(fourLDecide({ text: 'Do you have this in blue colour?', lead, stage: 'human_handover' }), 'bot');
  assert.equal(fourLDecide({ text: 'any update on my complaint?', lead, stage: 'human_handover' }), 'queue');
  assert.equal(fourLDecide({ text: 'hi', lead, stage: 'human_handover' }), 'queue');
  assert.equal(fourLDecide({ text: 'ok thanks', lead, stage: 'human_handover' }), 'queue');
});

test('acknowledgements never trigger a team handoff', () => {
  assert.equal(fourLDecide({ text: 'ok', stage: 'enquiry' }), 'queue');
});

test('handoff note: custom text, welcome line for a new customer', () => {
  assert.equal(fourLHandoffText(c4l), FOUR_L_DEFAULT_HANDOFF);
  const custom = { bot_config: { ecom_communication_style: 'four_l', four_l_handoff_text: 'Our team will reply soon.' } };
  assert.equal(fourLHandoffText(custom), 'Our team will reply soon.');
  assert.match(fourLHandoffText(custom, { isNewLead: true, name: 'Anu K', business: '4L Fashion' }), /^Hi Anu 👋 Welcome to 4L Fashion!/);
});

test('extra keywords from settings count as product questions', () => {
  const c = { bot_config: { four_l_product_keywords: 'anarkali, co-ord' } };
  const extraKeywords = fourLExtraKeywords(c);
  assert.deepEqual(extraKeywords, ['anarkali', 'co-ord']);
  assert.equal(fourLDecide({ text: 'anarkali undo?', extraKeywords }), 'bot');
});
