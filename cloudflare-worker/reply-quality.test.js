// Reply Quality toggles (reply-quality.js) — cases taken from real Couplo chats (Nov 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import {rqConfig, rqDecideLanguage, rqExplicitLanguageRequest, rqIsManglish, rqIsFiller, rqIsSoftOptOut, rqOptOutReply,
  rqIsPhotoAsk, rqPhotoAskAsEnglish, rqExtractAge, rqExtractOccasion, rqKnownState, rqPromptBlock, rqUsedUnknownReply,
  rqIsOpenerText, rqBotRepliedWithin, rqIsRecentDuplicate, rqCleanName, rqIsGreetingOnly, rqFallbackButtons} from './reply-quality.js';

test('every toggle is off unless switched on', () => {
  const cfg=rqConfig({bot_config:'{}'});
  assert.equal(cfg.any, false);
  for(const k of ['burst_wait','dedupe','opener_gate','known_state','language_rule','fact_sheet','media_aware','photo_first','soft_optout']) assert.equal(cfg[k], false);
  const on=rqConfig({bot_config:JSON.stringify({rq_language_rule:true, rq_opener_signatures:'Premium baby set ₹899\nab'})});
  assert.equal(on.language_rule, true); assert.equal(on.any, true);
  assert.deepEqual(on.opener_signatures, ['Premium baby set ₹899']);
  assert.equal(rqConfig({rq_dedupe:true}).dedupe, true); // a bot_config object works too
});

test('language: explicit requests switch', () => {
  assert.equal(rqExplicitLanguageRequest('Tamil'), 'ta');
  assert.equal(rqExplicitLanguageRequest('In Malayalam'), 'ml');
  assert.equal(rqExplicitLanguageRequest('reply in english please'), 'en');
  assert.equal(rqExplicitLanguageRequest('I like the tamil design set very much today'), null);
  assert.equal(rqDecideLanguage({text:'Tamil', history:[{role:'assistant', content:'ഹായ് 😊'}]}).lang, 'ta');
});

test('language: Manglish is Malayalam, not Tamil', () => {
  assert.equal(rqIsManglish('Papasoot type ndo'), true);
  assert.equal(rqDecideLanguage({text:'Papasoot type ndo', detected:'ta'}).lang, 'ml');
  assert.equal(rqDecideLanguage({text:'Price ethra aanu?', detected:'en'}).lang, 'ml');
});

test('language: ok / K / sorry keep the current language', () => {
  assert.equal(rqIsFiller('K'), true); assert.equal(rqIsFiller('Sorry'), true); assert.equal(rqIsFiller('👍'), true);
  const ml=[{role:'user', content:'In Malayalam'}, {role:'assistant', content:'പാപ്പാസൂട്ട് ടൈപ്പ് പ്രീമിയം ബേബി സെറ്റ്'}];
  assert.equal(rqDecideLanguage({text:'Sorry', history:ml, detected:'en'}).lang, 'ml');
  const ta=[{role:'user', content:'Tamil'}, {role:'assistant', content:'வணக்கம் 😊'}];
  assert.equal(rqDecideLanguage({text:'K', history:ta, detected:'en'}).lang, 'ta');
  // A language asked for earlier sticks for a short English-letter message.
  assert.equal(rqDecideLanguage({text:'price?', history:ta, detected:'en'}).lang, 'ta');
  // A real English sentence gets English.
  assert.equal(rqDecideLanguage({text:'Nainika name 10 months girl baby dress', history:[], detected:'ml'}).lang, 'en');
  assert.equal(rqDecideLanguage({text:'കുഞ്ഞിന് 3 മാസം', history:[], detected:'en'}).lang, 'ml');
});

test('soft opt-out: real asks match, ordinary chat does not', () => {
  assert.equal(rqIsSoftOptOut('Please dont message me again'), true);
  assert.equal(rqIsSoftOptOut('stop sending me messages'), true);
  assert.equal(rqIsSoftOptOut('no need to message me, I will msg if I want'), true);
  assert.equal(rqIsSoftOptOut('ഇടയ്ക്കിടയ്ക്ക് മെസ്സേജ് അയക്കേണ്ട ആവശ്യമില്ല'), true);
  assert.equal(rqIsSoftOptOut('msg ayakkanda'), true);
  assert.equal(rqIsSoftOptOut('no need blue, send pink'), false);
  assert.equal(rqIsSoftOptOut('stop, I will check and tell you'), false);
  assert.equal(rqIsSoftOptOut('send me the photos'), false);
  assert.match(rqOptOutReply('ml'), /ഇനി ഞങ്ങൾ മെസ്സേജ് അയക്കില്ല/);
});

test('photo asks in Malayalam and Manglish', () => {
  for(const t of ['T-shirt photos ayakkamo?', 'ഫോട്ടോ അയക്കാമോ', 'design kaanikku', 'pic venam', '📸 സെറ്റുകൾ കാണാം', 'View Our Catalog 📸'])
    assert.equal(rqIsPhotoAsk(t), true, t);
  for(const t of ['Price ethra aanu?', 'Ok', 'name print cheyyumo']) assert.equal(rqIsPhotoAsk(t), false, t);
  assert.equal(rqPhotoAskAsEnglish('T-shirt photos ayakkamo?'), 'send T-shirt photos');
  assert.equal(rqPhotoAskAsEnglish('ഫോട്ടോ അയക്കാമോ'), 'send photos');
});

test('known state: age, occasion, product, stage', () => {
  assert.equal(rqExtractAge('4 years old'), '4 years');
  assert.equal(rqExtractAge('3 month'), '3 months');
  assert.equal(rqExtractAge('1 Age boy'), null);
  assert.equal(rqExtractAge('കുഞ്ഞിന് 3 മാസം'), '3 months');
  assert.equal(rqExtractOccasion('for naming ceremony next week'), 'naming ceremony');
  const k=rqKnownState({history:[{role:'user', content:'4 years old'}], userText:'Price', lead:{InterestedProduct:'Cord Set'}, lang:'ml', stage:'new'});
  assert.deepEqual(k, {baby_age:'4 years', occasion:'', product_interest:'Cord Set', language:'Malayalam', stage:'browsing'});
});

test('prompt block only carries the rules that are on', () => {
  assert.equal(rqPromptBlock(rqConfig({})), '');
  const cfg=rqConfig({rq_known_state:true, rq_language_rule:true, rq_media_aware:true, rq_fact_sheet:true, rq_fact_sheet_text:'COD: no'});
  const p=rqPromptBlock(cfg, {known:{baby_age:'3 months', language:'Malayalam'}, lang:'ml', babycare:true});
  assert.match(p, /KNOWN SO FAR: baby_age: 3 months/);
  assert.match(p, /never ask for it again/);
  assert.match(p, /Age guide/);
  assert.match(p, /never say you can only reply in one language/);
  assert.match(p, /You CAN send photos/);
  assert.match(p, /SHOP FACTS[\s\S]*ടീമിനോട് ചോദിച്ച്[\s\S]*COD: no/);
  const generic=rqPromptBlock(rqConfig({rq_known_state:true}), {known:{product_interest:'Villa'}});
  assert.doesNotMatch(generic, /baby_age|Age guide/);
  assert.equal(rqUsedUnknownReply(cfg, 'ml', 'ടീമിനോട് ചോദിച്ച് ഉടനെ പറയാം 😊'), true);
  assert.equal(rqUsedUnknownReply(cfg, 'ml', '₹899 ആണ്'), false);
});

test('opener detection and the 24-hour window', () => {
  const sigs=['Premium baby set ₹899'];
  assert.equal(rqIsOpenerText('ഹായ് 😊 കുഞ്ഞിന്റെ പേര് print ചെയ്ത Premium baby set ₹899 മുതൽ… കുഞ്ഞിന് എത്ര മാസമായി?', {signatures:sigs}), true);
  assert.equal(rqIsOpenerText('Full Romper Set is ₹999', {signatures:sigs}), false);
  const now=Date.parse('2026-11-21T10:00:00Z');
  assert.equal(rqBotRepliedWithin([{role:'assistant', content:'x', ts:'2026-11-21T06:00:00Z'}], now), true);
  assert.equal(rqBotRepliedWithin([{role:'assistant', content:'x', ts:'2026-11-19T06:00:00Z'}], now), false);
  assert.equal(rqBotRepliedWithin([], now, undefined, now-3600000), true);
  assert.equal(rqIsGreetingOnly('Hi 👋'), true); assert.equal(rqIsGreetingOnly('Hi price?'), false);
  assert.equal(rqFallbackButtons('ml').length, 3);
});

test('duplicate drop within 60 seconds', () => {
  const now=1_000_000;
  const recent=[{text:'No problem at all! How can I help you today? 😊', at:now-20000}];
  assert.equal(rqIsRecentDuplicate('No problem at all!  How can I help you today?', recent, now), true);
  assert.equal(rqIsRecentDuplicate('No problem at all! How can I help you today?', recent, now+61000), false);
  assert.equal(rqIsRecentDuplicate('Something else', recent, now), false);
});

test('clean names for greetings', () => {
  assert.equal(rqCleanName('Subi🥰N🥰7510305788'), 'Subi');
  assert.equal(rqCleanName('❤❤'), '');
  assert.equal(rqCleanName('zakkiii😊'), 'Zakkiii');
});
