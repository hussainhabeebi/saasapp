// Regression tests for the fixes made across the "message repetition" / quick-reply-buttons
// session (see ../FIXES.md for the full log). Most of these cover pure, synchronous logic with
// zero network access; a few mock `fetch` to test the Chatwoot-send functions' return values
// without a live worker or real credentials. Run with `npm test` from this directory, or
// `node --test`.
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
  engineSendChatwootReply,
  engineBuildFaqSystemPrompt,
  engineExtractPlainOptionsFromReply,
  hcNormalizeText,
  hcQueryTokens,
  hcServiceChoiceItems,
  hcVerifiedServiceText,
  hcEmergencyMatch,
} from './worker.js';

describe('Healthcare verified-data routing', () => {
  test('normalizes natural patient wording without losing Unicode text', () => {
    assert.equal(hcNormalizeText('  Root-Canal / RCT!  '), 'root canal rct');
    assert.equal(hcNormalizeText('ദന്ത ചികിത്സ'), 'ദന്ത ചികിത്സ');
  });

  test('choice labels and values come only from saved Service records', () => {
    const rows=[
      {id:1,name:'Root Canal Treatment',short_label:'Root Canal'},
      {id:2,name:'Dental Cleaning',short_label:''},
      {id:3,name:'Root Canal Treatment',short_label:'Duplicate'},
    ];
    assert.deepEqual(hcServiceChoiceItems(rows), [
      {title:'Root Canal',value:'Root Canal Treatment'},
      {title:'Dental Cleaning',value:'Dental Cleaning'},
    ]);
  });

  test('verified service reply never invents absent price, duration, preparation or link', () => {
    const text=hcVerifiedServiceText({name:'Dental Checkup',description:'A routine dental examination.',price:0,duration_minutes:0,preparation:'',booking_url:''}, 'how much and how long?');
    assert.equal(text, '*Dental Checkup*\n\nA routine dental examination.');
  });

  test('emergency matcher catches configured phrases but respects simple negation', () => {
    const settings={emergency_keywords:'chest pain,severe bleeding'};
    assert.equal(hcEmergencyMatch(settings,'I have severe chest pain'), 'chest pain');
    assert.equal(hcEmergencyMatch(settings,'I have no chest pain'), null);
  });

  test('generic words are removed before service matching', () => {
    assert.deepEqual(hcQueryTokens('Please book a doctor appointment for root canal'), ['root','canal']);
  });
});

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

describe('engineSendChatwootReply — return value reflects actual delivery (FIXES.md #17)', () => {
  const c = { chatwoot_base: 'https://chatwoot.example', chatwoot_account_id: '1', chatwoot_token: 'tok' };
  // Minimal env: no env.DB / OPS_ALERT_* — logEngineSkip/reportOpsError both swallow their own
  // failures internally (see worker.js), so calling them against an incomplete env is safe and
  // exercises the same no-op path production takes when neither alert channel is configured.
  const env = {};

  test('returns true when Chatwoot accepts the send', async (t) => {
    t.mock.method(global, 'fetch', async () => new Response('{}', { status: 200 }));
    const ok = await engineSendChatwootReply(env, c, 'client1', 'conv1', 'hello');
    assert.equal(ok, true);
  });

  test('returns false — not just "didn\'t throw" — when Chatwoot rejects the send', async (t) => {
    t.mock.method(global, 'fetch', async () => new Response('server error', { status: 500 }));
    const ok = await engineSendChatwootReply(env, c, 'client1', 'conv1', 'hello');
    assert.equal(ok, false, 'a rejected Chatwoot send must not be reported as delivered — this is the exact gap that made Settings → Logs show "Replied" for a message the customer never received');
  });

  test('returns false when the request itself throws (network failure)', async (t) => {
    t.mock.method(global, 'fetch', async () => { throw new Error('network unreachable'); });
    const ok = await engineSendChatwootReply(env, c, 'client1', 'conv1', 'hello');
    assert.equal(ok, false);
  });

  test('returns false, not undefined, when there is nothing to send to', async () => {
    const ok = await engineSendChatwootReply(env, {}, 'client1', 'conv1', 'hello');
    assert.equal(ok, false, 'missing Chatwoot credentials must be reported as non-delivery, not silently ignored');
  });
});

describe('Button/list titles are pinned to English regardless of reply language (FIXES.md #19)', () => {
  // Real production failure: Chatwoot's own inbound WhatsApp webhook (Meta signature verification)
  // has been observed rejecting a customer's tap reply outright (401, never reaches this engine at
  // all) when its body contains non-ASCII UTF-8 bytes — Malayalam-language button taps specifically.
  // WhatsApp echoes a button's title back verbatim when tapped, so any code path that lets an
  // option/button label inherit the reply's own (non-English) language reintroduces this exact bug.

  test('the FAQ system prompt instructs the model to keep OPTIONS: labels in English even when replying in another language', () => {
    const c = { main_prompt: '', services: '[]', kb_summary: '' };
    const state = {};
    const sys = engineBuildFaqSystemPrompt(c, state, null, 'ecommerce', 'ml', false);
    assert.match(sys, /write each option itself in ENGLISH/i, 'must explicitly override "reply in the customer\'s language" for OPTIONS: labels');
    assert.doesNotMatch(sys, /write each option itself in the customer's language/i, 'the old instruction (translate options into replyLang) must not come back');
  });

  test('engineExtractPlainOptionsFromReply asks the LLM to translate extracted labels into English, not keep the reply\'s own language', async (t) => {
    let capturedSystemPrompt = null;
    t.mock.method(global, 'fetch', async (url, opts) => {
      capturedSystemPrompt = JSON.parse(opts.body).messages[0].content;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"options":["Mattress","Wooden bed"]}' } }] }), { status: 200 });
    });
    const c = { openrouter_key: 'test-key' };
    const options = await engineExtractPlainOptionsFromReply({}, c, 'നിങ്ങൾക്ക് ഒരു മെത്തയാണോ, മരം കൊണ്ടുള്ള കട്ടിലാണോ വേണ്ടത്?');
    assert.match(capturedSystemPrompt, /ALWAYS translated into English/i, 'must not let extracted option labels inherit the source reply\'s language');
    assert.doesNotMatch(capturedSystemPrompt, /keep it in the reply's own language/i, 'the old instruction must not come back');
    assert.deepEqual(options, ['Mattress', 'Wooden bed']);
  });
});
