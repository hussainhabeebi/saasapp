// Couplo (Sep 2026): "Ith oru jodi alliyo" (isn't this a pair?) about Kids T-Shirt V2 got only the
// stock product card; staff had to answer. A question about a product is now answered first, then
// the card + photo — ecomIsProductQuestion decides which messages are questions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ecomIsProductQuestion } from './worker.js';

test('questions in English, Manglish and Malayalam script', () => {
  for (const t of ['Ith oru jodi alliyo', 'Is this a pair', 'is it a set?', 'does it come with cap', 'size undo', 'cotton aano?',
    'price?', 'ethra aanu rate', 'ഇത് ജോഡി ആണോ', 'kitna hai', 'available in blue?']) {
    assert.equal(ecomIsProductQuestion(t), true, t);
  }
});

test('a product name, a tap, or a plain reply is not a question', () => {
  for (const t of ['Kids T-Shirt V2', 'Affordable Full Romper Set', 'Premium Baby Set', 'I want this', 'ok',
    'BABY_CUSTOM_ORDER', 'CHAT_ORDER_START', '']) {
    assert.equal(ecomIsProductQuestion(t), false, t);
  }
});
