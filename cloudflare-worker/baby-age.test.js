// Couplo (Oct 2026): every Baby Care customer was offered the newborn sets, even for a 9-month-old.
// The baby's age is read from the chat and product pickers keep only age-appropriate products.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { babyAgeMonthsFromText, babyAgeMonthsFromConversation, babyAgeRangeFromLabel, ecomFilterProductsByBabyAge, ecomCategoriesWithProducts, engineBuildFaqSystemPrompt } from './worker.js';

test('reads the baby age from English, Manglish, Malayalam and Hindi', () => {
  const cases = {
    '23 days old': 0.8, '2 weeks old': 0.5, 'New born baby aanu': 0, 'pregnant aanu': 0,
    'ente mol 6 maasam aayi': 6, 'aaru maasam': 6, '6 മാസം': 6, '6 mahine ka baby': 6,
    '9 months baby': 9, '6m baby': 6, '1 vayassu': 12, '1.5 years': 18, 'one and half year': 18,
    '1 year 3 months': 15, '3-6 months size undo?': 4.5,
  };
  for (const [text, months] of Object.entries(cases)) assert.equal(babyAgeMonthsFromText(text), months, text);
});

test('ignores durations that are not the baby age', () => {
  for (const text of ['3 days delivery?', 'delivery within 5 days', '2 years back I bought', 'price?', 'M size', 'BABY_CUSTOM_ORDER'])
    assert.equal(babyAgeMonthsFromText(text), null, text);
});

test('uses the newest age the customer gave in the conversation', () => {
  const history = [{ role: 'user', content: '2 months old' }, { role: 'assistant', content: '10 months warranty' }, { role: 'user', content: 'actually 9 months' }];
  assert.equal(babyAgeMonthsFromConversation('price?', history), 9);
  assert.equal(babyAgeMonthsFromConversation('7 months', history), 7);
});

test('reads product age groups', () => {
  assert.deepEqual(babyAgeRangeFromLabel('0-3 Months'), { min: 0, max: 3 });
  assert.deepEqual(babyAgeRangeFromLabel('6M-1Y'), { min: 6, max: 12 });
  assert.deepEqual(babyAgeRangeFromLabel('1-2 years'), { min: 12, max: 24 });
  assert.deepEqual(babyAgeRangeFromLabel('6M+'), { min: 6, max: 96 });
  assert.deepEqual(babyAgeRangeFromLabel('Newborn Romper Set'), { min: 0, max: 3 });
  assert.equal(babyAgeRangeFromLabel('Premium Baby Set'), null);
});

const products = [
  { name: 'Newborn Swaddle Set', category: 'Newborn', age_group: '0-3 Months' },
  { name: 'Kids T-Shirt', category: 'T-Shirts', age_group: '6-24 months' },
  { name: 'Premium Baby Set', category: 'Sets' },
];

test('a 9-month-old gets T-shirts, not newborn sets', () => {
  assert.deepEqual(ecomFilterProductsByBabyAge(products, 9).map(p => p.name), ['Kids T-Shirt', 'Premium Baby Set']);
  assert.deepEqual(ecomCategoriesWithProducts(['Newborn', 'T-Shirts', 'Sets'], ecomFilterProductsByBabyAge(products, 9)), ['T-Shirts', 'Sets']);
});

test('a newborn gets newborn sets; unknown age or no match keeps the full list', () => {
  assert.deepEqual(ecomFilterProductsByBabyAge(products, 0.8).map(p => p.name), ['Newborn Swaddle Set', 'Premium Baby Set']);
  assert.equal(ecomFilterProductsByBabyAge(products, null).length, 3);
  assert.deepEqual(ecomFilterProductsByBabyAge([products[0]], 9).map(p => p.name), ['Newborn Swaddle Set']);
});

test('the reply prompt tells the AI the baby age', () => {
  const sys = engineBuildFaqSystemPrompt({ main_prompt: 'Shop' }, { activeHistory: [], babyAgeMonths: 9 }, '', 'ecommerce', 'en', false, 'QUESTION');
  assert.match(sys, /BABY AGE: The customer's baby is about 9 months old/);
  const none = engineBuildFaqSystemPrompt({ main_prompt: 'Shop' }, { activeHistory: [] }, '', 'ecommerce', 'en', false, 'QUESTION');
  assert.doesNotMatch(none, /BABY AGE/);
});
