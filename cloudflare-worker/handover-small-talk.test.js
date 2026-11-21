// Couplo (Sep 2026): "Hi" then "Hy" got the same (correct) welcome twice, which the anti-loop
// detector read as a stuck bot — the next message was force-handed to a human and, with handover
// silence on, the bot went quiet. "Only English/Hindi" was also sometimes classified WANTS_HUMAN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineIsNonHandoverSmallTalk, engineRouteFlow } from './worker.js';

test('greetings and language preferences are small talk', () => {
  for(const t of ['Hy','hi','Hii 😊','Hello there','Good morning','Only English/Hindi','only english','Hindi please','can you speak Hindi?','English or Malayalam']){
    assert.equal(engineIsNonHandoverSmallTalk(t), true, t);
  }
  for(const t of ['I want to talk to a person','Price of the pink set?','Only 1','Hindi me batao price','send photos','any']){
    assert.equal(engineIsNonHandoverSmallTalk(t), false, t);
  }
});

const c={industry:'ecommerce', bot_config:'{}', flow_json:'{}', qual_questions:'[]'};
const cls=intent=>({intent, intentData:{}, sentiment:'Neutral', objectionCategory:'none', confidence:0.9});
const loopingState={stage:'new', looping:true, botMsgs:['Welcome to our store!','Welcome to our store!'], history:[], qualAnswers:{}};

test('a detected loop never escalates a greeting or language preference to a human', () => {
  assert.notEqual(engineRouteFlow(c, loopingState, 'Hy', cls('SHORT_NEUTRAL')).route, 'human');
  assert.notEqual(engineRouteFlow(c, loopingState, 'Only English/Hindi', cls('QUESTION')).route, 'human');
});

test('a real loop on a substantive message still escalates', () => {
  assert.equal(engineRouteFlow(c, loopingState, 'any', cls('QUESTION')).route, 'human');
});
