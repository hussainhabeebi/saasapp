// Leadvyne v2 (bot_config.leadvyne_v2): the bot learns from what staff do in the chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  engineV2On, engineAppendAgentReply, engineHistoryLine, engineBuildFaqSystemPrompt, engineParseStaffNote,
  engineMergeStaffNotes, engineActiveStaffNotes, engineV2Block, engineScriptLang, engineV2FollowStaffLanguage,
  engineLooksLikeStaffPromise, engineTakeoverTurns, engineWinExampleTexts, engineRecentConversationBlock, engineV2WelcomeVideo,
  engineV2SourceText, engineV2IsFreshLead, engineV2NudgeSettings, engineV2NudgeDue, engineV2NudgeText, engineStaffScore,
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

test('welcome video config and the prompt note after it was sent', () => {
  assert.equal(engineV2WelcomeVideo({ bot_config: '{"leadvyne_v2":true}' }), null);
  assert.deepEqual(engineV2WelcomeVideo({ bot_config: JSON.stringify({ v2_welcome_video_url: ' https://drive.google.com/file/d/abc/view ', v2_welcome_video_caption: 'Hi {name}' }) }),
    { url: 'https://drive.google.com/file/d/abc/view', caption: 'Hi {name}', rule: '' });
  assert.match(engineV2Block({ welcomeVideoSent: true }), /360° business video[\s\S]*Do not send or promise it again/);
});

test('video per ad or source: first matching rule wins, else the default', () => {
  const c = { bot_config: JSON.stringify({
    v2_welcome_video_url: 'https://drive.google.com/d/general',
    v2_source_videos: [
      { match: 'Villa Offer', video_url: 'https://drive.google.com/d/villa', caption: 'Villa tour' },
      { match: 'inbox:12', video_url: 'https://drive.google.com/d/kochi', caption: '' },
    ] }) };
  const fromAd = engineV2SourceText({ content_attributes: { referral: { headline: 'Villa offer — 20% off' } } }, null, 'Hi', 7);
  assert.equal(engineV2WelcomeVideo(c, fromAd).url, 'https://drive.google.com/d/villa');
  assert.equal(engineV2WelcomeVideo(c, engineV2SourceText({}, null, 'hello', 12)).url, 'https://drive.google.com/d/kochi');
  assert.equal(engineV2WelcomeVideo(c, engineV2SourceText({}, { AdCampaign: 'VILLA OFFER Oct' }, 'hi', 3)).rule, 'Villa Offer');
  assert.equal(engineV2WelcomeVideo(c, 'something else').url, 'https://drive.google.com/d/general');
  assert.equal(engineV2IsFreshLead({ leadId: null }), true);
  assert.equal(engineV2IsFreshLead({ leadId: 5, history: [{ role: 'assistant', content: 'template' }] }), true);
  assert.equal(engineV2IsFreshLead({ leadId: 5, history: [{ role: 'user', content: 'hi' }] }), false);
});

test('reply-gap nudge: settings, when it is due, and the text', () => {
  assert.equal(engineV2NudgeSettings({ bot_config: '{"v2_nudge_enabled":true}' }), null);
  assert.deepEqual(engineV2NudgeSettings({ bot_config: '{"leadvyne_v2":true,"v2_nudge_enabled":true}' }), { hours: 2, text: '' });
  const NOW = Date.parse('2026-10-04T12:00:00Z');
  const at = h => new Date(NOW - h * 3600e3).toISOString();
  const lead = (o = {}) => ({ ConversationID: 9, Stage: 'new', LastCustomerMsgAt: at(3),
    ConvHistory: JSON.stringify([{ role: 'user', content: 'hi', ts: at(3) }, { role: 'assistant', content: 'Welcome!', ts: at(3) }]), ...o });
  assert.equal(engineV2NudgeDue(lead(), 2, NOW), true);
  assert.equal(engineV2NudgeDue(lead(), 4, NOW), false, 'not quiet long enough');
  assert.equal(engineV2NudgeDue(lead({ Handover: 'Yes' }), 2, NOW), false);
  assert.equal(engineV2NudgeDue(lead({ OptOut: 'Yes' }), 2, NOW), false);
  assert.equal(engineV2NudgeDue(lead({ LastAgentMsgAt: at(1) }), 2, NOW), false, 'staff replied');
  assert.equal(engineV2NudgeDue(lead({ LastCustomerMsgAt: at(23.5) }), 2, NOW), false, 'outside the 24h window');
  assert.equal(engineV2NudgeDue(lead({ ConvHistory: JSON.stringify([{ role: 'assistant', content: 'x', ts: at(5) }, { role: 'user', content: 'ok', ts: at(3) }]) }), 2, NOW), false, 'customer spoke last');
  assert.match(engineV2NudgeText({ text: '' }, { Name: 'Riya' }, true), /^Hi Riya, did you get a chance to watch the video/);
  assert.equal(engineV2NudgeText({ text: 'Hey {name}!' }, { Name: 'Riya' }, false), 'Hey Riya!');
});

test('staff quality score: first responder, reply time, win rate', () => {
  const t = m => `2026-10-04T10:${String(m).padStart(2, '0')}:00Z`;
  const leads = [
    { Id: 1, Stage: 'won', ConvHistory: [
      { role: 'user', content: 'price?', ts: t(0) }, { role: 'assistant', content: 'AED 99', ts: t(0) },
      { role: 'user', content: 'discount?', ts: t(10) }, { role: 'assistant', by: 'agent', agent: 'Asha', content: '10% off', ts: t(16) } ] },
    { Id: 2, Stage: 'new', ConvHistory: [
      { role: 'user', content: 'hi', ts: t(0) }, { role: 'user', content: 'there?', ts: t(1) }, { role: 'assistant', by: 'agent', agent: 'Asha', content: 'yes', ts: t(4) } ] },
  ];
  const s = engineStaffScore(leads, Date.parse('2026-10-01T00:00:00Z'));
  assert.deepEqual(s.bot, { name: 'Bot', replies: 1, median_reply_sec: 0, leads: 1, won: 1, win_rate: 100 });
  assert.deepEqual(s.staff, [{ name: 'Asha', replies: 2, median_reply_sec: 300, leads: 2, won: 1, win_rate: 50 }]);
});
