// Regression tests for the fixes made across the "message repetition" / quick-reply-buttons
// session (see ../FIXES.md for the full log). These cover the pure, synchronous logic only —
// no NocoDB/Chatwoot/OpenRouter calls, no live worker — so they run in plain Node with zero
// network access and zero setup. Run with `npm test` from this directory, or `node --test`.
//
// Before editing any function tested here, read its entry in ../FIXES.md — these tests encode
// real, previously-observed production failures, not hypothetical edge cases.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  engineTruncateButtonTitle,
  engineTextSimilarity,
  engineQualQuestionText,
  engineQualQuestionOptional,
  engineQualQuestionOptions,
  engineExtractReplyOptions,
  engineHandoverCannedTexts,
  engineRouteFlow,
} from './worker.js';

describe('engineTruncateButtonTitle — WhatsApp title-length safety (FIXES.md #5)', () => {
  test('leaves a short title untouched', () => {
    assert.equal(engineTruncateButtonTitle('Mattress', 24), 'Mattress');
  });

  test('truncates a long title at a word boundary with an ellipsis', () => {
    const out = engineTruncateButtonTitle('Semi Medicated Orthopedic Mattress', 24);
    assert.ok(out.length <= 24, `expected <=24 chars, got ${out.length}: "${out}"`);
    assert.ok(out.endsWith('…'));
    assert.ok(!out.includes('  '), 'should not leave a double space before the ellipsis');
  });

  test('never exceeds the cap even with no good word boundary', () => {
    const out = engineTruncateButtonTitle('Supercalifragilisticexpialidocious', 20);
    assert.ok(out.length <= 20, `expected <=20 chars, got ${out.length}: "${out}"`);
    assert.ok(out.endsWith('…'));
  });
});

describe('engineTextSimilarity — near-duplicate loop detection (FIXES.md #13)', () => {
  test('identical text scores 1', () => {
    assert.equal(engineTextSimilarity('hello there', 'hello there'), 1);
  });

  test('the exact Wellness Virtue near-duplicate case scores above the 0.7 loop threshold', () => {
    const a = 'For general health and wellness, our Glutathione Tablets are an excellent choice! They offer antioxidant support, immunity support, and detox benefits. Would you like to know more about them?';
    const b = 'For general health, our Glutathione Tablets are an excellent choice! They offer antioxidant support, immunity support, and detox benefits. Would you like to know more about them?';
    assert.ok(engineTextSimilarity(a, b) >= 0.7, 'reworded near-duplicate replies must be caught by the loop detector');
  });

  test('genuinely different replies stay below the loop threshold', () => {
    const a = 'Our delivery takes 3-5 business days within Kerala.';
    const b = 'Our Glutathione Tablets support immunity and detox benefits.';
    assert.ok(engineTextSimilarity(a, b) < 0.7, 'unrelated replies must not false-positive as a loop');
  });

  test('short unrelated replies do not false-positive on shared function words', () => {
    assert.ok(engineTextSimilarity('Do you need help?', 'Do you want more?') < 0.7);
  });
});

describe('engineQualQuestion* — qual_questions options shape (FIXES.md #8)', () => {
  test('reads a legacy plain-string entry as required, no options', () => {
    const q = 'What is your budget?';
    assert.equal(engineQualQuestionText(q), 'What is your budget?');
    assert.equal(engineQualQuestionOptional(q), false);
    assert.deepEqual(engineQualQuestionOptions(q), []);
  });

  test('reads the new {text, optional, options} shape, trimming/dropping blanks', () => {
    const q = { text: 'Do you need a mattress, a wooden bed, or something else?', optional: false, options: ['Mattress', ' Wooden bed ', '', 'Something else'] };
    assert.equal(engineQualQuestionText(q), 'Do you need a mattress, a wooden bed, or something else?');
    assert.deepEqual(engineQualQuestionOptions(q), ['Mattress', 'Wooden bed', 'Something else']);
  });

  test('a malformed (non-array) options field never reaches the send path', () => {
    assert.deepEqual(engineQualQuestionOptions({ text: 'x', options: 'not-an-array' }), []);
    assert.deepEqual(engineQualQuestionOptions({ text: 'x' }), []);
    assert.deepEqual(engineQualQuestionOptions(null), []);
  });
});

describe('engineExtractReplyOptions — the OPTIONS: marker parser', () => {
  test('splits and strips a trailing OPTIONS: line', () => {
    const { text, options } = engineExtractReplyOptions('Pick one!\nOPTIONS: Skincare | Wellness | Diet plan');
    assert.equal(text, 'Pick one!');
    assert.deepEqual(options, ['Skincare', 'Wellness', 'Diet plan']);
  });

  test('leaves ordinary replies untouched', () => {
    const { text, options } = engineExtractReplyOptions('We deliver within 3-5 days.');
    assert.equal(text, 'We deliver within 3-5 days.');
    assert.equal(options, null);
  });
});

describe('engineRouteFlow — anti-loop escalation (FIXES.md #1, #13, #14)', () => {
  const baseC = { bot_config: '{}', qual_questions: '[]', flow_json: '{}', industry: 'ecommerce' };
  const baseCls = { intent: 'QUESTION', sentiment: 'Neutral', objectionCategory: 'none', aiWinProbability: null, customerLanguage: null, nextStage: null, confidence: null, productInterest: '' };

  test('a real (non-canned-text) loop forces a human handover and reports loopDetected', () => {
    const state = { looping: true, botMsgs: ['Some AI-generated pitch, reworded each time.'], stage: 'new', qualAnswers: {}, leadOptOut: 'No' };
    const result = engineRouteFlow(baseC, state, 'yes', baseCls);
    assert.equal(result.route, 'human');
    assert.equal(result.loopDetected, true, 'engineRouteFlow must surface loopDetected for handleEngineWebhook to alert on');
  });

  test('a repeated handover confirmation is NOT treated as a stuck loop', () => {
    const cannedText = 'Sure 🙏 connecting you to our advisor now. Someone will be with you shortly.';
    const state = { looping: true, botMsgs: [cannedText], stage: 'human_handover', qualAnswers: {}, leadOptOut: 'No' };
    const result = engineRouteFlow(baseC, state, 'hi', baseCls);
    assert.equal(result.loopDetected, false, 'a correctly-repeated handover confirmation must not re-trigger the loop escalation');
  });

  test('antiloop_enabled=false opts a client out entirely', () => {
    const c = { ...baseC, bot_config: JSON.stringify({ antiloop_enabled: false }) };
    const state = { looping: true, botMsgs: ['Reworded pitch again.'], stage: 'new', qualAnswers: {}, leadOptOut: 'No' };
    const result = engineRouteFlow(c, state, 'yes', baseCls);
    assert.equal(result.loopDetected, false);
  });
});

describe('engineRouteFlow — qualifying-question choices carry through (FIXES.md #8)', () => {
  test('qualify_next surfaces the next question\'s configured options', () => {
    const c = {
      bot_config: '{}', flow_json: '{}', industry: 'ecommerce',
      qual_questions: JSON.stringify([
        { text: 'What is your name?', optional: false, options: [] },
        { text: 'Do you need a mattress, a wooden bed, or something else?', optional: false, options: ['Mattress', 'Wooden bed', 'Something else'] },
      ]),
    };
    const state = { looping: false, botMsgs: [], stage: 'qual_0', qualAnswers: {}, leadOptOut: 'No' };
    const cls = { ...baseClsFor(), intent: 'AFFIRMATIVE' };
    const result = engineRouteFlow(c, state, 'John', cls);
    assert.equal(result.route, 'qualify_next');
    assert.equal(result.next, 'qual_1');
    assert.deepEqual(result.qualNextOptions, ['Mattress', 'Wooden bed', 'Something else']);
  });
});

function baseClsFor() {
  return { intent: 'QUESTION', sentiment: 'Neutral', objectionCategory: 'none', aiWinProbability: null, customerLanguage: null, nextStage: null, confidence: null, productInterest: '' };
}
