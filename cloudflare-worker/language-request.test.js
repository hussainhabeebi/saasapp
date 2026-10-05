// A customer chatting in Malayalam typed "Mujhe Hindi bolo" and the bot answered "Sorry, I only
// speak Malayalam" — the request was never recognised, never remembered, and the prompt forbade
// switching. These cover recognising the request, keeping it for later turns, and the prompt rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  engineDetectLanguageRequest, engineIsLanguageRequestOnly, engineIsNonHandoverSmallTalk,
  engineResolveReplyLanguage, engineReplyLanguageRule
} from './worker.js';

test('recognises a request to switch language in English, Hinglish, Manglish and native script', () => {
  const cases={
    'Mujhe Hindi bolo':'hi', 'mujhe hindi me bolo':'hi', 'Hindi mein baat karo':'hi', 'hindi me reply karo':'hi',
    'Can you speak Hindi?':'hi', 'Can you talk to me in Hindi':'hi', 'हिंदी में बात करो':'hi',
    'speak in english please':'en', 'English please':'en', 'Only English':'en', 'switch to english':'en', 'I understand only English':'en',
    'Malayalathil parayu':'ml', 'malayalam parayamo':'ml', 'മലയാളത്തിൽ പറയൂ':'ml',
    'Change language to Tamil':'ta', 'Hindi me batao price':'hi'
  };
  for(const [t, code] of Object.entries(cases)) assert.equal(engineDetectLanguageRequest(t), code, t);
});

test('a negated language is skipped and the one actually asked for wins', () => {
  assert.equal(engineDetectLanguageRequest('Malayalam venda, Hindi mathi'), 'hi');
  assert.equal(engineDetectLanguageRequest('dont speak malayalam, speak hindi'), 'hi');
  assert.equal(engineDetectLanguageRequest('Hindi please no Malayalam'), 'hi');
});

test('a language that is only part of a product question is not a request', () => {
  for(const t of ['Do you have the Hindi book?', 'Tell me about the Tamil course', 'Is the movie in Hindi?',
    'only hindi books available?', 'mujhe hindi book chahiye', 'price?', ''])
    assert.equal(engineDetectLanguageRequest(t), null, t);
});

test('a bare language request is small talk; one that also asks something is not', () => {
  for(const t of ['Mujhe Hindi bolo', 'Aap Hindi me baat karo', 'speak in english please', 'മലയാളത്തിൽ പറയൂ']){
    assert.equal(engineIsLanguageRequestOnly(t), true, t);
    assert.equal(engineIsNonHandoverSmallTalk(t), true, t);
  }
  assert.equal(engineIsLanguageRequestOnly('Hindi me batao price'), false);
  assert.equal(engineIsNonHandoverSmallTalk('Hindi me batao price'), false);
});

test('reply language: request, then a different native script, then the saved preference, then detection', () => {
  const base={fallback:'ml'};
  assert.equal(engineResolveReplyLanguage({...base, requested:'hi', preferred:'en', userText:'Mujhe Hindi bolo', detected:'ml'}), 'hi');
  // Preference sticks even when the classifier guesses the conversation's earlier language.
  assert.equal(engineResolveReplyLanguage({...base, preferred:'hi', userText:'price kitna hai', detected:'ml'}), 'hi');
  assert.equal(engineResolveReplyLanguage({...base, preferred:'hi', userText:'ok', detected:'en'}), 'hi');
  // Customer clearly writes in another script — follow them for this turn.
  assert.equal(engineResolveReplyLanguage({...base, preferred:'hi', userText:'വില എത്രയാണ്', detected:'ml'}), 'ml');
  assert.equal(engineResolveReplyLanguage({...base, preferred:'hi', userText:'कितना है', detected:'hi'}), 'hi');
  // No preference — per-message detection, then the client default.
  assert.equal(engineResolveReplyLanguage({...base, userText:'how much', detected:'en'}), 'en');
  assert.equal(engineResolveReplyLanguage({...base, userText:'?', detected:null}), 'ml');
});

test('the prompt names the language and never lets the bot refuse to switch', () => {
  const rule=engineReplyLanguageRule('hi');
  assert.match(rule, /Respond ONLY in Hindi\./);
  assert.match(rule, /explicitly asks you to talk in a different language, reply in that language/);
  assert.match(rule, /Never tell the customer you can only speak one language/);
  assert.doesNotMatch(rule, /Never switch languages/);
  assert.match(engineReplyLanguageRule('ml'), /Respond ONLY in Malayalam\./);
});
