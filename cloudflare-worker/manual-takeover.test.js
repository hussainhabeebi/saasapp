// Manual takeover from Chats: the bot stays silent only when a person took the chat over
// (Handover='Yes' + HandoverBy). A bot-triggered handover (HandoverBy blank) keeps the old behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineManualTakeoverActive, engineKeepStaffLeadChanges } from './worker.js';

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

// A rep marks Won / takes over while a bot turn is still running: the turn's end-of-turn save
// must not put the old stage back.
const turnBody=()=>({Stage:'stage_2', 'Follow up 1':'No', LastMsgAt:'x'});
test('a stage a person changed mid-turn is kept', ()=>{
  const b=engineKeepStaffLeadChanges(turnBody(), {stage:'stage_1', lead:{}}, {Stage:'won'});
  assert.equal(b.Stage, undefined); assert.equal(b['Follow up 1'], undefined); assert.equal(b.LastMsgAt, 'x');
});
test('a takeover made mid-turn is kept, even when the bot routed to a handover', ()=>{
  const b=engineKeepStaffLeadChanges({...turnBody(), Stage:'human_handover', Handover:'Yes', HandoverAt:'t', SlaAlerted:'No'},
    {stage:'stage_2', lead:{Handover:'No'}}, {Stage:'stage_2', Handover:'Yes', HandoverBy:'rep@x.test'});
  assert.equal(b.Stage, undefined); assert.equal(b.HandoverAt, undefined); assert.equal(b.SlaAlerted, undefined);
});
test('nothing changed mid-turn: the turn saves as before', ()=>{
  assert.deepEqual(engineKeepStaffLeadChanges(turnBody(), {stage:'stage_1', lead:{}}, {Stage:'stage_1'}), turnBody());
  assert.deepEqual(engineKeepStaffLeadChanges(turnBody(), {stage:'stage_1', lead:{}}, null), turnBody());
});
