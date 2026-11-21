import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followupGuardOn, withinSendWindow, chatLanguage, guardPromptRules } from './followup-guard.js';

const client = (bc) => ({ bot_config: JSON.stringify(bc) });

test('guard needs Leadvyne v2 and the switch', () => {
  assert.equal(followupGuardOn(client({ leadvyne_v2: true, v2_followup_guard: true })), true);
  assert.equal(followupGuardOn(client({ v2_followup_guard: true })), false);
  assert.equal(followupGuardOn(client({ leadvyne_v2: true })), false);
  assert.equal(followupGuardOn({ bot_config: 'not json' }), false);
});

test('send window: default 18–21 India time, no 4 AM sends', () => {
  const c = client({});
  assert.equal(withinSendWindow(c, new Date('2026-10-08T13:30:00Z')), true);  // 19:00 IST
  assert.equal(withinSendWindow(c, new Date('2026-10-07T22:30:00Z')), false); // 04:00 IST
  assert.equal(withinSendWindow(client({ followup_quiet_hours_enabled: false }), new Date('2026-10-07T22:30:00Z')), true);
  assert.equal(withinSendWindow(client({ timezone: 'Asia/Dubai', followup_window_start_hour: 9, followup_window_end_hour: 20 }), new Date('2026-10-08T06:00:00Z')), true); // 10:00 Dubai
});

test('chat language from our last message; prompt rules name it', () => {
  assert.equal(chatLanguage([{ role: 'assistant', content: 'നാളെ ഫ്രീയാണോ?' }], 'en'), 'ml');
  assert.equal(chatLanguage([{ role: 'assistant', content: 'Ready-to-use or custom?' }], 'ml'), 'en');
  assert.equal(chatLanguage([], 'hi'), 'hi');
  assert.match(guardPromptRules('ml'), /Malayalam/);
  assert.match(guardPromptRules('en'), /never assume their answer/);
});
