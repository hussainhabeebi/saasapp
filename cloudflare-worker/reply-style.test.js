import test from 'node:test';
import assert from 'node:assert/strict';
import { engineReplyStyleRules, engineBuildFaqSystemPrompt } from './worker.js';

const client=(cfg)=>({Id:1, client_name:'Test Realty', main_prompt:'You are the assistant.', language:'en', bot_config:JSON.stringify(cfg)});

test('no reply-style rules when no toggle is on', ()=>{
  assert.equal(engineReplyStyleRules(client({})), '');
  assert.equal(engineReplyStyleRules(client({concise_communication:false})), '');
  assert.equal(engineReplyStyleRules({bot_config:'not json'}), '');
});

test('each toggle adds only its own rule', ()=>{
  const r=engineReplyStyleRules(client({core_focus:true, direct_answers:true}));
  assert.match(r, /REPLY STYLE/);
  assert.match(r, /CORE FOCUS/);
  assert.match(r, /DIRECT ANSWERS/);
  assert.doesNotMatch(r, /CONCISE COMMUNICATION/);
  assert.doesNotMatch(r, /NO FLUFF/);
});

test('FAQ prompt ends with the reply-style rules when configured', ()=>{
  const cfg={concise_communication:true, core_focus:true, no_fluff:true, direct_answers:true};
  const sys=engineBuildFaqSystemPrompt(client(cfg), {activeHistory:[]}, '', 'real_estate', 'en', false, 'QUESTION');
  assert.ok(sys.endsWith(engineReplyStyleRules(client(cfg))));
  const plain=engineBuildFaqSystemPrompt(client({}), {activeHistory:[]}, '', 'real_estate', 'en', false, 'QUESTION');
  assert.ok(!plain.includes('REPLY STYLE'));
});
