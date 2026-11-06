import test from 'node:test';
import assert from 'node:assert/strict';
import {engineIsPleasantry, engineReplyEchoesCustomer, ENGINE_PLEASANTRY_REPLY} from './worker.js';

test('thanks / ok / emoji-only messages are pleasantries', ()=>{
  for(const t of ['Thank you so much 👍😊','thanks','Ok thank you','ok','👍','🙏😊','Thanks a lot dear','tq','Noted, thanks!','thank u','Shukran','നന്ദി'])
    assert.equal(engineIsPleasantry(t), true, t);
});

test('real questions are not pleasantries', ()=>{
  for(const t of ['Thanks, what is the price for Kashmir?','ok send me the itinerary','How much is the visa','Rate ??','Hello! Can I get more info on this?','no','hi','','Thank you, I want to book 2 tickets to Dubai'])
    assert.equal(engineIsPleasantry(t), false, t);
});

test('the echo check would have thrown away a thank-you answering a thank-you', ()=>{
  // engineCallLlm now skips this check when the customer message is a pleasantry.
  assert.equal(engineReplyEchoesCustomer('Thank you so much! 😊', ['Thank you so much 👍😊']), true);
  assert.equal(engineIsPleasantry('Thank you so much 👍😊'), true);
});

test('pleasantry fallback is a friendly reply, not "not sure I got that"', ()=>{
  assert.match(ENGINE_PLEASANTRY_REPLY, /welcome/i);
  assert.doesNotMatch(ENGINE_PLEASANTRY_REPLY, /not sure/i);
});
