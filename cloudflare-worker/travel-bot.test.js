// Travel bot layer (travel-bot.js) + the general stuck-turn helpers in reply-quality.js.
// Cases from the Nanthana Air Travels chat (Nov 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import {trConfig, trMenuItems, TR_DEFAULT_MENU, trDetectKind, trIsFareAsk, trParseExtraction, trMergeSlots, trNextMissing, trQuestion,
  trSummary, trConfirmText, trIsYes, trIsChange, TR_YES, TR_CHANGE, trDocKind, trDocReply, trExtractPrompt} from './travel-bot.js';
import {rqConfig, rqIsDontUnderstand, rqLastBotWasStuck, rqIsEmojiOnly, rqIsNoReplyNeeded, rqHandoverText, rqCheckingText, rqMissedTopic,
  rqDecideLanguage, rqIsTanglish, rqPromptBlock, rqKnownState} from './reply-quality.js';

test('travel switches are off by default', () => {
  const t=trConfig({bot_config:'{}'});
  assert.equal(t.any, false); assert.equal(t.fallback_menu, false); assert.equal(t.fare_collect, false); assert.equal(t.doc_detect, false);
  const r=rqConfig({bot_config:'{}'});
  for(const k of ['handover_after_fallback','ignore_reactions','ai_error_path','missed_log','delivery_alert']) assert.equal(r[k], false);
});

test('fallback menu: defaults and custom labels', () => {
  assert.equal(trConfig({}).menu_items, TR_DEFAULT_MENU);
  assert.deepEqual(trMenuItems('✈️ Flight ticket\n🇦🇪 Dubai visa | I need a Dubai visit visa'),
    [{title:'✈️ Flight ticket', value:'Flight ticket'}, {title:'🇦🇪 Dubai visa', value:'I need a Dubai visit visa'}]);
});

test('stuck replies are recognised in every language the Nanthana bot used', () => {
  assert.equal(rqIsDontUnderstand("I'm not sure I got that — could you share more details so I can help you?"), true);
  assert.equal(rqIsDontUnderstand('மன்னிக்கவும், நீங்கள் P4 லாகின் பற்றி கேட்கிறீர்களா என்று எனக்குப் புரியவில்லை. நீங்கள் வேறு ஏதேனும் விவரங்களை வழங்க முடியுமா?'), true);
  assert.equal(rqIsDontUnderstand('മന്നിക്കണം, എനിക്ക് മനസ്സിലായില്ല'), true);
  assert.equal(rqIsDontUnderstand('Trichy to Dubai flights start from ₹14,500. Shall I check your date?'), false);
  const hist=[{role:'user', content:'P4 login'}, {role:'assistant', content:'மன்னிக்கவும், P4 லாகின் பற்றி எனக்குத் தெரியவில்லை.'}];
  assert.equal(rqLastBotWasStuck(hist), true);
  assert.equal(rqLastBotWasStuck([{role:'assistant', content:'Which date?'}]), false);
});

test('reactions and bare acknowledgements need no reply', () => {
  assert.equal(rqIsEmojiOnly('👍'), true); assert.equal(rqIsEmojiOnly('🙏🙏'), true); assert.equal(rqIsEmojiOnly('ok 👍'), false);
  const afterStatement=[{role:'assistant', content:'Our expert will share the fares shortly.'}];
  const afterQuestion=[{role:'assistant', content:'Shall I book this for you?'}];
  assert.equal(rqIsNoReplyNeeded('👍', afterQuestion), true);
  assert.equal(rqIsNoReplyNeeded('ok', afterStatement), true);
  assert.equal(rqIsNoReplyNeeded('ok', afterQuestion), false); // "ok" answers the question
  assert.equal(rqIsNoReplyNeeded('ok', []), false);
  assert.equal(rqIsNoReplyNeeded('Dubai ticket', afterStatement), false);
  assert.equal(rqIsNoReplyNeeded('anything', [], true), true); // a WhatsApp reaction
});

test('handover and checking messages', () => {
  assert.match(rqHandoverText('en', true), /travel expert/);
  assert.match(rqHandoverText('ta', true), /டிராவல்/);
  assert.match(rqCheckingText('en'), /One moment, checking for you/);
});

test('Tanglish is Tamil', () => {
  assert.equal(rqIsTanglish('Dubai ku ticket evlo'), true);
  assert.equal(rqDecideLanguage({text:'Dubai ku ticket evlo', detected:'en'}).lang, 'ta');
  assert.equal(rqDecideLanguage({text:'Dubai ticket ethra', detected:'en'}).lang, 'ml');
  // 👍 keeps the chat's language.
  assert.equal(rqDecideLanguage({text:'👍', history:[{role:'assistant', content:'மன்னிக்கவும்'}], detected:'en'}).lang, 'ta');
});

test('fare asks and their kind', () => {
  for(const t of ['Dubai ku ticket evlo', 'Trichy to Dubai fare', 'flight ticket price to Singapore', 'Saudi visit visa rate', 'Umrah package ethra', 'I need a flight ticket', 'Maldives honeymoon package cost'])
    assert.equal(trIsFareAsk(t), true, t);
  for(const t of ['P4 login', '👍', 'what time is your office open', 'thanks']) assert.equal(trIsFareAsk(t), false, t);
  assert.equal(trDetectKind('Saudi visit visa rate'), 'visa');
  assert.equal(trDetectKind('Umrah package ethra'), 'umrah');
  assert.equal(trDetectKind('Dubai ku ticket evlo'), 'flight');
});

test('slot extraction, merging and the next question', () => {
  assert.match(trExtractPrompt('flight'), /from:[\s\S]*pax:[\s\S]*return_date/);
  const got=trParseExtraction('```json\n{"from":"Trichy","to":"Dubai","date":null,"trip_type":"oneway","pax":"unknown","colour":"red"}\n```', 'flight');
  assert.deepEqual(got, {from:'Trichy', to:'Dubai', trip_type:'one-way'});
  assert.deepEqual(trParseExtraction('not json', 'flight'), {});
  let s=trMergeSlots({}, got);
  assert.equal(trNextMissing('flight', s), 'date');
  assert.match(trQuestion('flight', 'date'), /date/);
  s=trMergeSlots(s, {date:'12 Dec', pax:'2 adults'});
  assert.equal(trNextMissing('flight', s), null);
  assert.equal(trSummary('flight', s), '✈️ Flight: Trichy → Dubai · 12 Dec · one-way · 2 adults');
  assert.match(trConfirmText('flight', s), /Just to confirm — ✈️ Flight: Trichy → Dubai/);
  assert.equal(trNextMissing('visa', {country:'Saudi Arabia'}), 'visa_type');
  assert.equal(trSummary('visa', {country:'Saudi Arabia', visa_type:'visit', nationality:'Indian'}), '🛂 Visa: Saudi Arabia visit visa · Indian passport');
});

test('confirm answers', () => {
  for(const t of [TR_YES, 'yes', 'Yes correct', 'ok', '👍', 'சரி', 'ശരി']) assert.equal(trIsYes(t), true, t);
  for(const t of ['yes but change the date to 14', 'Dubai']) assert.equal(trIsYes(t), false, t);
  for(const t of [TR_CHANGE, 'no', 'change date', 'இல்லை']) assert.equal(trIsChange(t), true, t);
});

test('documents', () => {
  assert.equal(trDocKind('A photo of an Indian passport data page with a name and number'), 'passport');
  assert.equal(trDocKind('Screenshot of an e-ticket from IndiGo with PNR AB12CD'), 'ticket');
  assert.equal(trDocKind('A beach at sunset'), null);
  assert.equal(trDocKind('', 'document'), 'document');
  assert.equal(trDocReply('passport', 'en'), 'Got your passport copy 👍 Our team will check it and reply shortly.');
  assert.match(trDocReply('passport', 'ta'), /பாஸ்போர்ட்/);
});

test('missed-question topics group by route / visa', () => {
  assert.equal(rqMissedTopic('x', {kind:'flight', slots:{from:'Trichy', to:'Dubai'}}), 'Trichy–Dubai fare');
  assert.equal(rqMissedTopic('x', {kind:'visa', slots:{country:'Saudi', visa_type:'visit'}}), 'Saudi visit visa');
  assert.equal(rqMissedTopic('What is the P4 login?'), 'p4 login');
});

test('travel Known-so-far block and team answers', () => {
  const cfg=rqConfig({rq_known_state:true, rq_answers:[{q:'What is P4 login?', a:'P4 is our agent portal. Our team will send the link.'}]});
  const known=rqKnownState({lang:'ta', travel:{kind:'flight', slots:{from:'Trichy', to:'Dubai', adults:2}}});
  assert.equal(known.from, 'Trichy'); assert.equal(known.passengers, '2 adults'); assert.equal(known.language, 'Tamil');
  const p=rqPromptBlock(cfg, {known, lang:'ta', travel:true});
  assert.match(p, /service: flight, from: Trichy, to: Dubai/);
  assert.match(p, /P4 login/);
  assert.match(p, /Never quote an air fare/);
  assert.match(p, /TEAM ANSWERS[\s\S]*P4 is our agent portal/);
});
