// A bare "Pictures" after a Baby Care product card used to reach the FAQ LLM, which replied
// "I can't send pictures here" instead of sending the product's stored photo.
import { test } from 'node:test';
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
