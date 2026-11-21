// Settings → Logs: each bot message is logged with the steps that led to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { botTraceStart, botTraceTurn, botTrace, botTraceSnapshot } from './worker.js';

test('a bot turn collects its route, AI attempts and fallback, clipped and capped', () => {
  const c = { Id: 7 };
  botTrace(c, 'ignored_before_start');
  assert.equal(botTraceSnapshot(c), null);
  botTraceStart(c, { phone: '971500000000', user_text: 'how can i book this' });
  botTraceTurn(c, { route: 'travel_faq' });
  botTrace(c, 'ai_shared_gemini', { ok: false, error: 'quota', empty: '', missing: undefined });
  botTrace(c, 'fallback_used', { text: 'x'.repeat(1000) });
  const snap = botTraceSnapshot(c);
  assert.deepEqual(snap.turn, { phone: '971500000000', user_text: 'how can i book this', route: 'travel_faq' });
  assert.equal(snap.steps[0].step, 'ai_shared_gemini');
  assert.equal(snap.steps[0].error, 'quota');
  assert.ok(!('empty' in snap.steps[0]) && !('missing' in snap.steps[0]));
  assert.equal(snap.steps[1].text.length, 300);
  for (let i = 0; i < 100; i++) botTrace(c, 'x');
  assert.equal(botTraceSnapshot(c).steps.length, 40);
  // A separate client object (another request) has its own trace.
  assert.equal(botTraceSnapshot({ Id: 7 }), null);
});
