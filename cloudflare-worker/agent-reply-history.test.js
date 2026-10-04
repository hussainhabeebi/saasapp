// Leadvyne v2 (bot_config.leadvyne_v2): the bot learns from what staff do in the chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  engineV2On, engineAppendAgentReply, engineHistoryLine, engineBuildFaqSystemPrompt, engineParseStaffNote,
  engineMergeStaffNotes, engineActiveStaffNotes, engineV2Block, engineScriptLang, engineV2FollowStaffLanguage,
  engineLooksLikeStaffPromise, engineTakeoverTurns, engineWinExampleTexts, engineRecentConversationBlock,
} from './worker.js';

const TS = '2026-10-04T10:00:00Z';
const turns = [
  { role: 'user', content: 'Price for the Dubai package?' },
  { role: 'assistant', content: 'The 4-night Dubai package is AED 2,450 per person. Shall I check dates?' },
];
const hist = JSON.stringify(turns);

test('toggle reads bot_config.leadvyne_v2', () => {
  assert.equal(engineV2On({ bot_config: '{"leadvyne_v2":true}' }), true);
  assert.equal(engineV2On({ bot_config: '{}' }), false);
  assert.equal(engineV2On({}), false);
});

test('a staff message is appended as an agent turn; a template as a template turn', () => {
  const out = engineAppendAgentReply(hist, { content: 'Hi, this is Asha — I can do AED 2,200 if you book today.' }, TS);
  assert.deepEqual(out[2], { role: 'assistant', by: 'agent', content: 'Hi, this is Asha — I can do AED 2,200 if you book today.', ts: TS });
  const tpl = engineAppendAgentReply(hist, { content: 'Your trip is coming up!', additional_attributes: { template_params: { name: 'x' } } }, TS);
  assert.equal(tpl[2].by, 'template');
});

test("the bot's own echoes, attachments and quick-reply messages are skipped", () => {
  assert.equal(engineAppendAgentReply(hist, { content: 'The 4-night Dubai package is AED 2,450 per person.  Shall I check dates?' }, TS), null);
  assert.equal(engineAppendAgentReply(hist, { content: 'The 4-night Dubai package is AED 2,450 per person.' }, TS), null);
  assert.equal(engineAppendAgentReply(hist, { content: '  ' }, TS), null);
  assert.equal(engineAppendAgentReply(hist, { content: 'Brochure', attachments: [{ file_type: 'image' }] }, TS), null);
  assert.equal(engineAppendAgentReply(hist, { content: 'Pick one', content_type: 'input_select' }, TS), null);
  assert.equal(engineAppendAgentReply('not json', { content: 'Hello' }, TS).length, 1);
});

test('prompts label staff turns; without staff turns the prompt is unchanged', () => {
  assert.equal(engineHistoryLine({ role: 'assistant', by: 'agent', content: 'Done' }), 'human agent (staff): Done');
  assert.equal(engineHistoryLine({ role: 'user', content: 'ok' }), 'user: ok');
  const history = engineAppendAgentReply(hist, { content: 'I can do AED 2,200 if you book today.' }, TS);
  const sys = engineBuildFaqSystemPrompt({ main_prompt: 'You are a travel assistant.' }, { activeHistory: history }, '', 'general', 'en', false, 'FAQ');
  assert.match(sys, /human agent \(staff\): I can do AED 2,200/);
  assert.match(sys, /stay consistent with them/);
  assert.equal(engineRecentConversationBlock(turns), '\n\n## Recent Conversation\n' + turns.map(m => m.role + ': ' + m.content).join('\n'));
  assert.equal(engineRecentConversationBlock([]), '');
});

test('/bot private notes', () => {
  assert.deepEqual(engineParseStaffNote({ private: true, message_type: 'outgoing', content: '/bot offer 10% today' }), { text: 'offer 10% today' });
  assert.deepEqual(engineParseStaffNote({ private: true, message_type: 'outgoing', content: '/bot clear' }), { clear: true });
  assert.equal(engineParseStaffNote({ private: true, message_type: 'outgoing', content: 'customer seems rude' }), null);
  assert.equal(engineParseStaffNote({ private: false, message_type: 'outgoing', content: '/bot hi' }), null);
  const notes = engineMergeStaffNotes('[]', { text: 'offer 10%' }, TS);
  assert.deepEqual(engineActiveStaffNotes(JSON.stringify(notes), Date.parse(TS) + 864e5), ['offer 10%']);
  assert.deepEqual(engineActiveStaffNotes(JSON.stringify(notes), Date.parse(TS) + 15 * 864e5), []);
  assert.deepEqual(engineMergeStaffNotes(JSON.stringify(notes), { clear: true }, TS), []);
  const block = engineV2Block({ staffNotes: ['offer 10%'], winExamples: ['Happy to hold it for you till 6pm'] });
  assert.match(block, /Instructions From the Team[\s\S]*offer 10%/);
  assert.match(block, /How Our Team Has Closed Deals[\s\S]*hold it for you/);
  assert.equal(engineV2Block({}), '');
});

test('follows the staff language on a short customer reply only', () => {
  assert.equal(engineScriptLang('നമസ്കാരം'), 'ml');
  assert.equal(engineScriptLang('hello'), null);
  const h = [...turns, { role: 'assistant', by: 'agent', content: 'നാളെ വിളിക്കാം' }];
  assert.equal(engineV2FollowStaffLanguage(h, 'ok', 'en'), 'ml');
  assert.equal(engineV2FollowStaffLanguage(h, 'can you send me the full itinerary please', 'en'), null);
  assert.equal(engineV2FollowStaffLanguage(turns, 'ok', 'en'), null);
});

test('promise filter, takeover slice and won examples', () => {
  assert.equal(engineLooksLikeStaffPromise("I'll call you at 5pm"), true);
  assert.equal(engineLooksLikeStaffPromise('Thanks!'), false);
  const h = [{ role: 'user', content: 'a', ts: '2026-10-04T09:00:00Z' }, { role: 'user', content: 'b', ts: '2026-10-04T11:00:00Z' }];
  assert.deepEqual(engineTakeoverTurns(h, TS).map(m => m.content), ['b']);
  assert.deepEqual(engineTakeoverTurns(h, ''), []);
  assert.deepEqual(engineWinExampleTexts([{ role: 'assistant', by: 'agent', content: 'short' }, { role: 'assistant', by: 'agent', content: 'I can hold the villa for you until Friday evening.' }, { role: 'assistant', content: 'bot text that is long enough to count' }]), ['I can hold the villa for you until Friday evening.']);
});
