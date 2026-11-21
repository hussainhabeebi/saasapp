// Dead-end handling in the FAQ path (worker.js engineRqStuckTurn) — the Nanthana chat.
import test from 'node:test';
import assert from 'node:assert/strict';
import {engineRqStuckTurn, hotLeadAlertReasonText} from './worker.js';

const travel=cfg=>({Id:9, industry:'travel', client_name:'Nanthana', bot_config:JSON.stringify(cfg)});
const stuckHistory=[{role:'user', content:'P4 login'}, {role:'assistant', content:'மன்னிக்கவும், P4 லாகின் பற்றி எனக்குத் தெரியவில்லை.'}];
const env={};

test('nothing changes when every switch is off', async () => {
  assert.equal(await engineRqStuckTurn(env, travel({}), 9, {activeHistory:stuckHistory}, {userText:'👍', reply:"I'm not sure I got that — could you share more details so I can help you?", usedFallback:true}), null);
});

test('a normal answer is not a dead end', async () => {
  assert.equal(await engineRqStuckTurn(env, travel({rq_handover_after_fallback:true, tr_fallback_menu:true}), 9, {activeHistory:[]}, {userText:'Dubai fare', reply:'Our agent will share fares.'}), null);
});

test('first dead end on a travel account → the travel menu', async () => {
  const out=await engineRqStuckTurn(env, travel({rq_handover_after_fallback:true, tr_fallback_menu:true}), 9, {activeHistory:[{role:'assistant', content:'Welcome to Nanthana Air Travels!'}]},
    {userText:'P4 login', reply:'மன்னிக்கவும், எனக்குப் புரியவில்லை.', lang:'ta'});
  assert.equal(out.handover, undefined);
  assert.equal(out.menu.length, 6);
  assert.equal(out.menu[0].title, '✈️ Flight ticket');
  assert.match(out.reply, /கீழே/);
  assert.equal(out.reason, 'no_answer');
});

test('second dead end in a row → handover to the travel expert', async () => {
  const out=await engineRqStuckTurn(env, travel({rq_handover_after_fallback:true, tr_fallback_menu:true}), 9, {activeHistory:stuckHistory},
    {userText:'P4 login', reply:'மன்னிக்கவும், P4 லாகின் பற்றி எனக்குத் தெரியவில்லை.', lang:'ta'});
  assert.equal(out.handover, true);
  assert.match(out.reply, /டிராவல் எக்ஸ்பர்ட்/);
});

test('AI error after the retry → "checking for you", never "I didn\'t understand"', async () => {
  const out=await engineRqStuckTurn(env, travel({rq_ai_error_path:true, rq_handover_after_fallback:true}), 9, {activeHistory:[]},
    {userText:'Dubai flight', reply:"I'm not sure I got that — could you share more details so I can help you?", usedFallback:true, aiError:true, lang:'en'});
  assert.equal(out.reply, 'One moment, checking for you 🙏');
  assert.equal(out.handover, true);
  assert.equal(out.reason, 'ai_error');
});

test('owner alert wording for the new handover reasons', () => {
  assert.match(hotLeadAlertReasonText('bot_handover', 'P4 login'), /could not answer: "P4 login"/);
  assert.match(hotLeadAlertReasonText('fare_request', 'Trichy → Dubai · 12 Dec'), /wants fares: Trichy → Dubai/);
  assert.match(hotLeadAlertReasonText('document', 'passport copy'), /sent a passport copy/);
});
