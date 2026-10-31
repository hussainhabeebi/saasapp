import test from 'node:test';
import assert from 'node:assert/strict';
import { engineBusinessNameMl, engineBusinessNameMlRule, engineBuildFaqSystemPrompt } from './worker.js';

const NAME_ML='പുലാമന്തോൾ മൂസ്';
const client=(cfg)=>({Id:1, client_name:'Pulamanthole Mooss Ayurveda', main_prompt:'You are the assistant.', language:'ml', bot_config:JSON.stringify(cfg)});

test('name_ml is read from bot_config and trimmed', ()=>{
  assert.equal(engineBusinessNameMl(client({name_ml:`  ${NAME_ML} `})), NAME_ML);
  assert.equal(engineBusinessNameMl(client({})), '');
  assert.equal(engineBusinessNameMl({bot_config:'not json'}), '');
});

test('rule pins the exact spelling only for Malayalam replies', ()=>{
  const c=client({name_ml:NAME_ML});
  const rule=engineBusinessNameMlRule(c, 'ml');
  assert.match(rule, new RegExp(NAME_ML));
  assert.match(rule, /Pulamanthole Mooss Ayurveda/);
  assert.equal(engineBusinessNameMlRule(c, 'en'), '');
  assert.equal(engineBusinessNameMlRule(c, 'hi'), '');
  assert.equal(engineBusinessNameMlRule(client({}), 'ml'), '');
});

test('FAQ prompt includes the Malayalam name rule when configured', ()=>{
  const sys=engineBuildFaqSystemPrompt(client({name_ml:NAME_ML}), {activeHistory:[]}, '', 'general', 'ml', false, 'QUESTION');
  assert.ok(sys.includes(NAME_ML));
  assert.ok(sys.includes('PROPER NOUNS RULE'));
  const plain=engineBuildFaqSystemPrompt(client({}), {activeHistory:[]}, '', 'general', 'ml', false, 'QUESTION');
  assert.ok(!plain.includes('BUSINESS NAME IN MALAYALAM'));
});
