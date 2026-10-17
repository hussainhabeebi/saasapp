// Couplo (Sep 2026): a click-to-WhatsApp ad opener "Hi! I'd like the price & photos of the name
// printed baby set" got only the canned intro ("Welcome to Couplo… How can I help you today?").
// A first message with a real ask is now answered first; the intro follows in the same reply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineIsSpecificFirstQuestion, engineBuildFaqSystemPrompt } from './worker.js';

test('specific first asks skip the canned intro', () => {
  for (const t of [
    "Hi! I'd like the price & photos of the name printed baby set 👶",
    'Hello, what is the price?',
    'Do you have size 2-3 years?',
    'Where is your shop',
    'Is COD available',
    'ഈ സെറ്റിന്റെ വില എത്രയാണ്',
  ]) assert.equal(engineIsSpecificFirstQuestion(t), true, t);
});

test('greetings and the generic ad opener still get the intro', () => {
  for (const t of ['Hi', 'Hy', 'Hello!', 'Good morning', 'Only English', 'Hello! Can I get more info on this?', '👋', ''])
    assert.equal(engineIsSpecificFirstQuestion(t), false, t);
});

test('new-lead prompt says answer first, intro after', () => {
  const sys = engineBuildFaqSystemPrompt({ client_name: 'Couplo', industry: 'ecommerce' }, { history: [] }, null, 'ecommerce', 'en', true, 'QUESTION');
  assert.match(sys, /answer that FIRST and completely; only then, after the answer/);
});
