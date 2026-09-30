// Hospital client (Sep 2026): a patient typed Manglish ("Ithinn chikilsa undo") and got a paragraph
// of formal, textbook Malayalam script back. Healthcare replies now mirror the patient's script,
// tone and words; other industries are unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hcDetectCustomerScript, hcBuildReplyStyle, hcReplyStyleInstruction, engineBuildFaqSystemPrompt } from './worker.js';

const u=content=>({role:'user', content});
const b=content=>({role:'assistant', content});

test('Manglish is detected as English-letter script', () => {
  assert.equal(hcDetectCustomerScript('Ithinn chikilsa undo', []), 'latin');
  assert.equal(hcDetectCustomerScript('Doctor evening irukkara?', []), 'latin');
});

test('native script is detected even with English words mixed in', () => {
  assert.equal(hcDetectCustomerScript('ഫീസ് എത്ര? doctor available ആണോ', []), 'native');
  assert.equal(hcDetectCustomerScript('डॉक्टर कब मिलेंगे', []), 'native');
});

test('a bare "Yes", "ok" or button payload does not flip the established script', () => {
  const hist=[u('ഡോക്ടർ ഇന്ന് ഉണ്ടോ?'), b('ഉണ്ട്. Appointment എടുക്കട്ടേ?')];
  assert.equal(hcDetectCustomerScript('Yes', hist), 'native');
  assert.equal(hcDetectCustomerScript('ok 👍', hist), 'native');
  assert.equal(hcDetectCustomerScript('HC_SVC_12', hist), 'native');
  const manglish=[u('Ithinn chikilsa undo'), b('…')];
  assert.equal(hcDetectCustomerScript('Yes', manglish), 'latin');
});

test('no readable text gives no script', () => {
  assert.equal(hcDetectCustomerScript('👍', []), null);
});

test('Manglish patients are told to get Manglish back, not Malayalam script', () => {
  const style=hcBuildReplyStyle('ml', 'Ithinn chikilsa undo', [], {customerTone:'casual', customerWords:['chikilsa']});
  assert.deepEqual(style, {lang:'ml', script:'latin', tone:'casual', words:['chikilsa']});
  const s=hcReplyStyleInstruction(style);
  assert.match(s, /Manglish/);
  assert.match(s, /English letters, NOT in the native script/);
  assert.match(s, /chikilsa/);
  assert.match(s, /no "da", "eda"/);
  assert.doesNotMatch(s, /ലഭ്യമാണ്/);
});

test('native-script patients get colloquial script with a bookish-word blocklist', () => {
  const s=hcReplyStyleInstruction(hcBuildReplyStyle('ml', 'ഡോക്ടർ ഉണ്ടോ?', [], {}));
  assert.match(s, /native script, in colloquial spoken form/);
  assert.match(s, /സ്ഥിരീകരിക്കാൻ/);
  assert.match(s, /respectful tone/);
});

test('only healthcare FAQ prompts carry the style rule', () => {
  const style=hcBuildReplyStyle('ml', 'Ithinn chikilsa undo', [], {});
  const state={activeHistory:[], stage:'new'};
  const hc={industry:'healthcare', bot_config:'{}', flow_json:'{}', _hcReplyStyle:style};
  assert.match(engineBuildFaqSystemPrompt(hc, state, '', 'healthcare', 'ml', false, 'QUESTION'), /PATIENT STYLE MIRROR/);
  const shop={industry:'ecommerce', bot_config:'{}', flow_json:'{}', _hcReplyStyle:style};
  assert.doesNotMatch(engineBuildFaqSystemPrompt(shop, state, '', 'ecommerce', 'ml', false, 'QUESTION'), /PATIENT STYLE MIRROR/);
});
