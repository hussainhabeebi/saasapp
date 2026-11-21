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
  assert.match(fourLHandoffText(custom, { isNewLead: true, name: 'Anu K', business: '4L Fashion' }), /^Hi Anu 🌸 Welcome to \*4L Fashion\* 💖/);
});

test('extra keywords from settings count as product questions', () => {
  const c = { bot_config: { four_l_product_keywords: 'anarkali, co-ord' } };
  const extraKeywords = fourLExtraKeywords(c);
  assert.deepEqual(extraKeywords, ['anarkali', 'co-ord']);
  assert.equal(fourLDecide({ text: 'anarkali undo?', extraKeywords }), 'bot');
});

test('a cut-off or partly typed product name still counts as a product question', async () => {
  const { fourLMentionsCatalogue } = await import('./four-l.js');
  const products = [{ name: 'Royal Ivory Embroidered Sharara Suit Set', sku: 'RIS-01', category: 'Salwar Suits' }];
  assert.equal(fourLMentionsCatalogue('Royal Ivory Embroidered Sharara Suit Se', { products }), true);
  assert.equal(fourLMentionsCatalogue('royal ivory sharara', { products }), true);
  assert.equal(fourLMentionsCatalogue('is the shop open on friday', { products }), false);
  assert.equal(fourLDecide({ text: 'Royal Ivory Embroidered Sharara Suit Se', products }), 'bot');
  assert.equal(fourLDecide({ text: 'CHAT_ORDER_START' }), 'bot');
});

test('product card and checkout text carry the checkout link', async () => {
  const { fourLProductCard, fourLCheckoutText } = await import('./four-l.js');
  assert.match(fourLProductCard('*Suit*\nQAR 190', 'https://4l.example/p/1'), /Check out here:\nhttps:\/\/4l\.example\/p\/1$/);
  assert.equal(fourLProductCard('*Suit*', ''), '*Suit*');
  assert.match(fourLCheckoutText({ name: 'Suit' }, 'https://x.y/z'), /\*Suit\*[\s\S]*https:\/\/x\.y\/z/);
});

test('4L card: no baby emoji, one checkout link; photos in order', async () => {
  const { fourLCardText, fourLProductImages, fourLPhotoCaption } = await import('./four-l.js');
  const p = { name: 'Embroidered Straight-Cut Suit Set', description: 'Elegant suit.', price: 150, currency: 'QAR', size: 'M, L', color: 'Ivory white',
    product_link: 'https://4lfashion.com.qa/products/1', image_url: '//cdn.x/a.webp', image_url_2: 'https://cdn.x/b.jpg', image_url_3: 'https://cdn.x/b.jpg' };
  const card = fourLCardText(p, 'https://4lfashion.com.qa/products/1');
  assert.doesNotMatch(card, /🍼/);
  assert.equal(card.match(/https:\/\/4lfashion/g).length, 1);
  assert.match(card, /QAR 150/);
  assert.deepEqual(fourLProductImages(p), ['https://cdn.x/a.webp', 'https://cdn.x/b.jpg']);
  assert.equal(fourLPhotoCaption(p), '🌸 *Embroidered Straight-Cut Suit Set*\n💖 QAR 150');
});

test('4L finds same-name variants and dedupes menu rows', async () => {
  const { fourLFindProducts, fourLDedupeItems } = await import('./four-l.js');
  const products = [{ name: 'Elegant Embroidered Straight-Cut Suit Set', sku: 'A', color: 'Ivory' }, { name: 'Elegant Embroidered Straight-Cut Suit Set', sku: 'B', color: 'Aqua Green' }, { name: 'Embroidered Straight-Cut Suit Set', sku: 'C' }];
  assert.deepEqual(fourLFindProducts('Elegant Embroidered Straight-Cut Suit Set', products).map(p => p.sku), ['A', 'B']);
  assert.deepEqual(fourLFindProducts('Embroidered Straight-Cut Suit Set', products).map(p => p.sku), ['C']);
  assert.deepEqual(fourLDedupeItems([{ title: 'Kurta & sets' }, { title: 'Kurta & Sets' }, { title: 'Kurta and sets' }, { title: 'Salwar suits' }]).map(i => i.title), ['Kurta & sets', 'Salwar suits']);
});

test('variant choice shows name and colour only, never the size list', async () => {
  const { fourLVariantTitle } = await import('./four-l.js');
  const p = { name: 'Floral Embroidery Kurti', color: 'Deep Teal Green', size: '3XL, 4XL, 5XL, L, M, XL, XXL', variant: 'Deep Teal Green / 3XL, Deep Teal Green / 4XL' };
  assert.equal(fourLVariantTitle(p), 'Floral Embroidery Kurti – Deep Teal Green');
  assert.equal(fourLVariantTitle({ name: 'Floral Embroidery Kurti', variant: 'Blue / 3XL, Blue / 4XL' }), 'Floral Embroidery Kurti – Blue');
  assert.equal(fourLVariantTitle({ name: 'Plain Kurti' }), 'Plain Kurti');
});

test('AI catalogue context puts the asked-for product first, even deep in a big catalogue', async () => {
  const { ecomRankProductsForQuery } = await import('./worker.js');
  const products = Array.from({ length: 150 }, (_, i) => ({ name: `Plain Suit ${i}`, category: 'Salwar suits' }));
  products.push({ name: 'Floral Embroidery Kurti', color: 'Blue', category: 'Kurtis' });
  const top = ecomRankProductsForQuery(products, 'Floral Embroidery').slice(0, 30);
  assert.equal(top[0].name, 'Floral Embroidery Kurti');
  assert.equal(ecomRankProductsForQuery(products, '')[0].name, 'Plain Suit 0');
});
