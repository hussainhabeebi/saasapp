// Manual takeover from Chats: the bot stays silent only when a person took the chat over
// (Handover='Yes' + HandoverBy). A bot-triggered handover (HandoverBy blank) keeps the old behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineManualTakeoverActive } from './worker.js';

test('a chat a person took over silences the bot', ()=>{
  assert.equal(engineManualTakeoverActive({Handover:'Yes', HandoverBy:'reshma@couplo.test'}), true);
});
test('a bot-triggered handover does not', ()=>{
  assert.equal(engineManualTakeoverActive({Handover:'Yes', HandoverBy:''}), false);
  assert.equal(engineManualTakeoverActive({Handover:'Yes'}), false);
});
test('a chat handed back (Handover No) does not, even if HandoverBy lingers', ()=>{
  assert.equal(engineManualTakeoverActive({Handover:'No', HandoverBy:'reshma@couplo.test'}), false);
});
test('no lead yet does not', ()=>{
  assert.equal(engineManualTakeoverActive(null), false);
});
