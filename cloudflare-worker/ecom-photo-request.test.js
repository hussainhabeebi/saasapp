// A bare "Pictures" after a Baby Care product card used to reach the FAQ LLM, which replied
// "I can't send pictures here" instead of sending the product's stored photo.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ecomIsPhotoRequest } from './worker.js';

test('bare and plural photo asks are photo requests', () => {
  for(const t of ['Pictures','pictures?','Photos pls','pics','any photos?','Images please','can I see it?','Do you have pictures of this','send pictures','show me the photos','send me some pics','photo again']){
    assert.equal(ecomIsPhotoRequest(t), true, t);
  }
});

test('ordinary messages are not photo requests', () => {
  for(const t of ['Newborn Frill Skirt & Romper Set','Luxury newborn baby set','price?','Is the photo frame included in the set','I saw your pictures on Instagram, do you deliver to Kochi?','hi']){
    assert.equal(ecomIsPhotoRequest(t), false, t);
  }
});

// Couplo (Sep 2026): "send all photos" / "I want to see photos" got a product-name list, no images.
import { ecomPlanGallery } from './worker.js';

test('quantified and want-to-see photo asks are photo requests', () => {
  for(const t of ['send all photos','Send all photos','I want to see photos','show me all the photos','I would love to see your photos','share your collection photos']){
    assert.equal(ecomIsPhotoRequest(t), true, t);
  }
});

describe('ecomPlanGallery', () => {
  const cats=[{id:1,name:'Newborn Sets',image_url_1:'c1a',image_url_2:'c1b'},{id:2,name:'Frocks',image_url_1:'c2a'},{id:3,name:'Rompers'}];
  const prods=[
    {name:'Newborn Frill Skirt & Romper Set',category:'Newborn Sets',image_url:'p1',price:850},
    {name:'Pink Party Frock',category:'Frocks',image_url:'p2',price:1200},
    {name:'Cotton Romper',category:'Rompers',image_url:'p3',price:450},
  ];

  test('"send all photos" sends one photo per category, product photo when the category has none', () => {
    const plan=ecomPlanGallery('send all photos', cats, prods, 'SKU1');
    assert.equal(plan.mode, 'all');
    assert.deepEqual(plan.items.map(i=>i.url), ['c1a','c2a','p3']);
    assert.ok(plan.choices.some(c=>c.value==='Frocks'));
  });

  test('a named category sends its own photos plus its products with price', () => {
    const plan=ecomPlanGallery('photos of frocks', cats, prods, 'SKU1');
    assert.equal(plan.mode, 'category');
    assert.deepEqual(plan.items.map(i=>i.url), ['c2a','p2']);
    assert.match(plan.items[1].caption, /Pink Party Frock.*1200/);
  });

  test('leaves a named product, or a bare "Pictures" after a product, to the product flow', () => {
    assert.equal(ecomPlanGallery('send photos of Pink Party Frock', cats, prods, ''), null);
    assert.equal(ecomPlanGallery('Pictures', cats, prods, 'SKU1'), null);
    assert.equal(ecomPlanGallery('I saw your pictures on Instagram, do you deliver to Kochi?', cats, prods, ''), null);
  });
});

// Ecom → Settings → "Always send photos" is opt-in: off (or absent/malformed) keeps every gate.
import { ecomPhotosUnrestricted } from './worker.js';

test('"Always send photos" is only on when explicitly enabled', () => {
  assert.equal(ecomPhotosUnrestricted({ bot_config: JSON.stringify({ ecom_photos_unrestricted: true }) }), true);
  for (const bot_config of [undefined, '', '{}', 'not json', JSON.stringify({ ecom_photos_unrestricted: 'yes' }), JSON.stringify({ ecom_photos_unrestricted: false })]) {
    assert.equal(ecomPhotosUnrestricted({ bot_config }), false, String(bot_config));
  }
});
