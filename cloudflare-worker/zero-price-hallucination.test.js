// Ecom Settings → Zero Price Hallucinations: the deterministic price check behind the toggle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineFindHallucinatedPrice, ecomZeroPriceHallucinationOn, enginePriceGuardOpts } from './worker.js';

const catalog = '## Product Catalog\n- Cotton Baby Set [sku:B1] — INR 1299 — in stock\n- Cot Mattress — AED 450.00 — in stock';

test('prices that appear in the catalog pass, whatever the formatting', () => {
  assert.equal(engineFindHallucinatedPrice('The Cotton Baby Set is ₹1,299 😊', catalog), null);
  assert.equal(engineFindHallucinatedPrice('Cot Mattress is AED 450', catalog), null);
  assert.equal(engineFindHallucinatedPrice('Only 1299/- today', catalog), null);
  assert.equal(engineFindHallucinatedPrice('It costs 450 AED', catalog), null);
});

test('an invented price is caught', () => {
  assert.equal(engineFindHallucinatedPrice('The Cotton Baby Set is ₹999', catalog), '₹999');
  assert.equal(engineFindHallucinatedPrice('Two sets come to Rs. 2,598', catalog), 'Rs. 2,598');
  assert.equal(engineFindHallucinatedPrice('A 72x60 mattress is 650 AED', catalog), '650 AED');
});

test('numbers that are not prices are ignored', () => {
  assert.equal(engineFindHallucinatedPrice('Delivery in 3 days, sizes 0-6 months, 72x60 inches', catalog), null);
});

test('toggle reads bot_config and is off by default', () => {
  assert.equal(ecomZeroPriceHallucinationOn({ bot_config: '{}' }), false);
  assert.equal(ecomZeroPriceHallucinationOn({ bot_config: '{"ecom_zero_price_hallucination":true}' }), true);
  assert.equal(enginePriceGuardOpts({ bot_config: '{}' }, catalog, 'hi', 'en'), undefined);
  const g = enginePriceGuardOpts({ bot_config: '{"ecom_zero_price_hallucination":true}' }, catalog, 'my budget is ₹800', 'en');
  assert.equal(engineFindHallucinatedPrice('Within your ₹800 budget', g.priceSource), null);
});
