// Couplo (Oct 2026): every Baby Care customer was offered the newborn sets, even for a 9-month-old.
// The baby's age is read from the chat and product pickers keep only age-appropriate products.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { babyAgeMonthsFromText, babyAgeMonthsFromConversation, babyAgeRangeFromLabel, ecomFilterProductsByBabyAge, ecomCategoriesWithProducts, engineBuildFaqSystemPrompt,
  babyGenderFromText, babyOccasionFromText, babyBudgetFromText, babyProductTypesFromText, babyNameFromText, babyProfileFromConversation,
  ecomFilterProductsForBabyProfile, babyProfileQualAnswers } from './worker.js';

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

test('reads boy/girl, occasion, budget, product type and baby name', () => {
  assert.equal(babyGenderFromText('ente mol 6 maasam'), 'Girl');
  assert.equal(babyGenderFromText('for my son'), 'Boy');
  assert.equal(babyGenderFromText('aankuttikku'), 'Boy');
  assert.equal(babyGenderFromText('twins, boy and girl'), null);
  assert.equal(babyOccasionFromText('1st birthday dress venam'), 'First birthday');
  assert.equal(babyOccasionFromText('noolukettu function'), 'Naming ceremony');
  assert.equal(babyOccasionFromText('gift for my niece'), 'Gift');
  assert.equal(babyBudgetFromText('under 800'), 800);
  assert.equal(babyBudgetFromText('budget ₹1,500'), 1500);
  assert.equal(babyBudgetFromText('500 il thazhe undo'), 500);
  assert.equal(babyBudgetFromText('6 months'), null);
  assert.deepEqual(babyProductTypesFromText('tshirt and shorts venam'), ['T-shirt', 'Shorts / pants']);
  assert.equal(babyNameFromText("baby's name is ayra"), 'Ayra');
  assert.equal(babyNameFromText('kunjinte peru Ivaan'), 'Ivaan');
  assert.equal(babyNameFromText('name is not decided'), null);
});

test('builds the profile from the whole chat and puts it on the lead card', () => {
  const history = [{ role: 'user', content: 'Hi, ente mol 9 maasam aayi' }, { role: 'assistant', content: 'Nice!' }, { role: 'user', content: 'first birthday-kku t-shirt venam, under 700' }];
  const profile = babyProfileFromConversation("baby's name is Ayra", history);
  assert.deepEqual(profile, { ageMonths: 9, gender: 'Girl', babyName: 'Ayra', occasion: 'First birthday', budget: 700, lookingFor: ['T-shirt'] });
  assert.deepEqual(babyProfileQualAnswers(profile), { 'Baby Age': '9 months', Baby: 'Girl', 'Baby Name': 'Ayra', Occasion: 'First birthday', Budget: 'Up to ₹700', 'Looking For': 'T-shirt' });
  assert.equal(babyProfileQualAnswers({ ageMonths: 0 })['Baby Age'], 'Newborn');
});

test('profile filter: age, boy/girl, budget, then what they asked for first', () => {
  const catalogue = [
    { name: 'Newborn Swaddle Set', age_group: '0-3 Months', price: 600 },
    { name: 'Boys Polo T-Shirt', age_group: '6-24 months', price: 450 },
    { name: 'Party Frock', age_group: '6-24 months', price: 1200 },
    { name: 'Cotton Frock', age_group: '6-24 months', price: 550 },
    { name: 'Unisex T-Shirt', age_group: '6-24 months', price: 400 },
  ];
  const names = ecomFilterProductsForBabyProfile(catalogue, { ageMonths: 9, gender: 'Girl', budget: 700, lookingFor: ['T-shirt'] }).map(p => p.name);
  assert.deepEqual(names, ['Unisex T-Shirt', 'Cotton Frock']);
  // A filter that would leave nothing is skipped instead of showing an empty picker.
  assert.deepEqual(ecomFilterProductsForBabyProfile(catalogue, { ageMonths: 9, budget: 100 }).length, 4);
});

test('the reply prompt carries the baby profile', () => {
  const sys = engineBuildFaqSystemPrompt({ main_prompt: 'Shop' }, { activeHistory: [], babyProfile: { ageMonths: 9, gender: 'Girl' } }, '', 'ecommerce', 'en', false, 'QUESTION');
  assert.match(sys, /BABY PROFILE/);
  assert.match(sys, /- Baby Age: 9 months/);
  assert.match(sys, /- Baby: Girl/);
  const unknown = engineBuildFaqSystemPrompt({ main_prompt: 'Shop' }, { activeHistory: [], babyProfile: {} }, '', 'ecommerce', 'en', false, 'QUESTION');
  assert.match(unknown, /ask once, warmly, how old the baby is/);
  const asked = engineBuildFaqSystemPrompt({ main_prompt: 'Shop' }, { activeHistory: [{ role: 'assistant', content: 'How old is your baby?' }], babyProfile: {} }, '', 'ecommerce', 'en', false, 'QUESTION');
  assert.doesNotMatch(asked, /ask once/);
  const none = engineBuildFaqSystemPrompt({ main_prompt: 'Shop' }, { activeHistory: [] }, '', 'ecommerce', 'en', false, 'QUESTION');
  assert.doesNotMatch(none, /BABY PROFILE/);
});
