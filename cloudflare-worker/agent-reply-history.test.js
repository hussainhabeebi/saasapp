// A human agent's outgoing Chatwoot message joins ConvHistory so the bot's next reply builds on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineAppendAgentReply, engineHistoryLine, engineBuildFaqSystemPrompt } from './worker.js';

const TS = '2026-10-04T10:00:00Z';
const hist = JSON.stringify([
  { role: 'user', content: 'Price for the Dubai package?' },
  { role: 'assistant', content: 'The 4-night Dubai package is AED 2,450 per person. Shall I check dates?' },
]);

test('a staff message is appended as an agent-tagged assistant turn', () => {
  const out = engineAppendAgentReply(hist, { content: 'Hi, this is Asha — I can do AED 2,200 if you book today.' }, TS);
  assert.equal(out.length, 3);
  assert.deepEqual(out[2], { role: 'assistant', by: 'agent', content: 'Hi, this is Asha — I can do AED 2,200 if you book today.', ts: TS });
});

test("the bot's own reply echoing back is skipped", () => {
  assert.equal(engineAppendAgentReply(hist, { content: 'The 4-night Dubai package is AED 2,450 per person.  Shall I check dates?' }, TS), null);
  assert.equal(engineAppendAgentReply(hist, { content: 'The 4-night Dubai package is AED 2,450 per person.' }, TS), null);
});

test('empty text, attachments and unreadable history are handled', () => {
  assert.equal(engineAppendAgentReply(hist, { content: '  ' }, TS), null);
  assert.equal(engineAppendAgentReply(hist, { content: 'Brochure', attachments: [{ file_type: 'image' }] }, TS), null);
  assert.equal(engineAppendAgentReply('not json', { content: 'Hello' }, TS).length, 1);
});

test('reply prompts label staff turns and tell the bot to continue from them', () => {
  assert.equal(engineHistoryLine({ role: 'assistant', by: 'agent', content: 'Done' }), 'human agent (staff): Done');
  assert.equal(engineHistoryLine({ role: 'user', content: 'ok' }), 'user: ok');
  const history = engineAppendAgentReply(hist, { content: 'I can do AED 2,200 if you book today.' }, TS);
  const sys = engineBuildFaqSystemPrompt({ main_prompt: 'You are a travel assistant.' }, { activeHistory: history }, '', 'general', 'en', false, 'FAQ');
  assert.match(sys, /human agent \(staff\): I can do AED 2,200/);
  assert.match(sys, /stay consistent with them/);
  const plain = engineBuildFaqSystemPrompt({ main_prompt: 'x' }, { activeHistory: JSON.parse(hist) }, '', 'general', 'en', false, 'FAQ');
  assert.doesNotMatch(plain, /human agent \(staff\)/);
});
