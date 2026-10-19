// Couplo (Oct 2026) bot + reporting fixes: no echo of the customer's own words, the prompt's own
// first reply, Baby Care prompt-led catalogue, link-sent intents aren't conversions, chat lead
// sources, and the Follow-up V3 coverage breakdown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineCustomerLinesFromPrompt, engineReplyEchoesCustomer, engineMainPromptDefinesFirstReply,
  ecomIsExplicitBrowseRequest, ecomIsPriceQuestion, ecomOrderIsConversion, ECOM_INTENT_ORDER_NOTE,
  engineLeadAdSource, engineLeadSourceGuess } from './worker.js';
import { fv3CoverageRows } from './followup-v3.js';

test('1. a reply that is the customer\'s own message is caught', () => {
  const sys = 'Business prompt…\n\n## Recent Conversation\nuser: Hello! Can I get more info on this?\nassistant: Hi! Our baby sets start at ₹899.';
  const lines = engineCustomerLinesFromPrompt(sys, 'Rate ??');
  assert.ok(lines.includes('Hello! Can I get more info on this?'));
  assert.equal(engineReplyEchoesCustomer('Hello! Can I get more info on this?', lines), true);
  assert.equal(engineReplyEchoesCustomer('hello can i get more info on this', lines), true);
  assert.equal(engineReplyEchoesCustomer('Our Premium baby set is ₹899 with free delivery. How old is your baby?', lines), false);
  assert.equal(engineReplyEchoesCustomer('Rate ??', lines), true);
  assert.equal(engineReplyEchoesCustomer('ok', ['ok']), false); // too short to judge
});

test('3. a prompt that spells out the first reply is recognised', () => {
  assert.equal(engineMainPromptDefinesFirstReply('First reply: Premium set ₹899 + free delivery, then ask the baby\'s age. Max 2 options.'), true);
  assert.equal(engineMainPromptDefinesFirstReply('When a new customer messages, start with the price…'), true);
  assert.equal(engineMainPromptDefinesFirstReply('Welcome message: Hi! 👶 Our sets…'), true);
  assert.equal(engineMainPromptDefinesFirstReply('You are a helpful assistant for a baby clothing shop.'), false);
});

test('2/4. Baby Care: only an explicit browse opens the catalogue; price questions are recognised', () => {
  for (const t of ['show all products', 'Catalogue', 'what do you have', 'send me your designs', 'more options', 'categories'])
    assert.equal(ecomIsExplicitBrowseRequest(t), true, t);
  for (const t of ['Baby set', 'Rate ??', 'Prize?', 'premium set', 'Hi'])
    assert.equal(ecomIsExplicitBrowseRequest(t), false, t);
  for (const t of ['Rate ??', 'Prize?', 'price', 'how much', 'ethra aanu', 'വില?', 'kitna'])
    assert.equal(ecomIsPriceQuestion(t), true, t);
  for (const t of ['Baby set', 'Hi', 'delivery to Kochi?'])
    assert.equal(ecomIsPriceQuestion(t), false, t);
});

test('9. a link-sent intent row is not a conversion until someone confirms it', () => {
  assert.equal(ecomOrderIsConversion({ status: 'pending', notes: ECOM_INTENT_ORDER_NOTE, items: 'Kids Cord Set' }), false);
  assert.equal(ecomOrderIsConversion({ status: 'pending', items: 'Catalog link sent' }), false);
  assert.equal(ecomOrderIsConversion({ status: 'received', notes: ECOM_INTENT_ORDER_NOTE }), true);
  assert.equal(ecomOrderIsConversion({ status: 'pending', notes: 'Order taken in the WhatsApp conversation' }), true);
  assert.equal(ecomOrderIsConversion({ status: 'draft' }), false);
  assert.equal(ecomOrderIsConversion({ status: 'cancelled' }), false);
});

test('8. chat leads get a source: the ad from Meta\'s referral, the ad opener, else the channel', () => {
  const body = { content_attributes: { referral: { source_type: 'ad', source_id: '1202', headline: 'Name printed baby set', source_url: 'https://fb.me/abc', ctwa_clid: 'x' } } };
  assert.deepEqual(engineLeadAdSource(body, 'Hello! Can I get more info on this?'), {
    Source: 'Click-to-WhatsApp ad', LeadSource: 'Click-to-WhatsApp ad', AdName: 'Name printed baby set', AdCampaign: 'Ad ID 1202', AdSourceUrl: 'https://fb.me/abc' });
  assert.deepEqual(engineLeadAdSource({}, 'Hello! Can I get more info on this?'), { Source: 'Click-to-WhatsApp ad', LeadSource: 'Click-to-WhatsApp ad (prefilled message)' });
  assert.deepEqual(engineLeadAdSource({}, 'Baby set price?'), { Source: 'WhatsApp' });
  assert.deepEqual(engineLeadAdSource({}, 'hi', 'instagram'), { Source: 'Instagram' });
});

test('8. backfill guess for older leads', () => {
  const hist = (t) => JSON.stringify([{ role: 'user', content: t }, { role: 'assistant', content: 'Hi' }]);
  assert.equal(engineLeadSourceGuess({ ConvHistory: hist('Hello! Can I get more info on this?') }), 'Click-to-WhatsApp ad');
  assert.equal(engineLeadSourceGuess({ LeadSource: 'Instagram Lead Ad' }), 'Instagram Lead Ad');
  assert.equal(engineLeadSourceGuess({ MetaLeadgenId: '9' }), 'Lead form');
  assert.equal(engineLeadSourceGuess({ Channel: 'instagram' }), 'Instagram');
  assert.equal(engineLeadSourceGuess({ ConversationID: '12', ConvHistory: hist('Rate?') }), 'WhatsApp');
  assert.equal(engineLeadSourceGuess({}), '');
});

test('7. Follow-up V3 coverage: gaps first with a fix, healthy rows last', () => {
  const rows = fv3CoverageRows([{ reason: 'scheduled', n: 40 }, { reason: 'existing_lead', n: 700 }, { reason: 'human_handling', n: 150 }, { reason: 'ordered', n: 5 }], { include_existing_leads: false });
  assert.deepEqual(rows.map(r => r.reason), ['existing_lead', 'human_handling', 'scheduled', 'ordered']);
  assert.equal(rows[0].setting, 'include_existing_leads');
  assert.match(rows[1].fix, /handover/i);
  assert.equal(rows[2].ok, true);
  // already switched on → no "Turn on" button
  assert.equal(fv3CoverageRows([{ reason: 'existing_lead', n: 3 }], { include_existing_leads: true })[0].setting, '');
});
