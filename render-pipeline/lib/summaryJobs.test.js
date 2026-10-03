const test = require('node:test');
const assert = require('node:assert/strict');
const { createSummaryJobQueue } = require('./summaryJobs');

const quietLog = { log() {}, error() {} };
const audio = Buffer.alloc(400, 1);
const job = (id, language = 'ml') => ({ jobId: id, text: 'hello', language, callbackUrl: 'https://w/cb' });

test('uses Parler when it succeeds and never starts Piper', async () => {
  const calls = [];
  const posted = [];
  const q = createSummaryJobQueue({
    primary: { name: 'parler', supportsLanguage: () => true, synthesize: async () => { calls.push('parler'); return audio; } },
    backup: { name: 'piper', supportsLanguage: () => true, synthesize: async () => { calls.push('piper'); return audio; } },
    postCallback: async (_url, payload) => { posted.push(payload); },
    log: quietLog,
  });
  q.enqueue(job('a'));
  await q.idle();
  assert.deepEqual(calls, ['parler']);
  assert.equal(posted[0].ok, true);
  assert.equal(posted[0].provider, 'parler');
  assert.equal(posted[0].audio_base64, audio.toString('base64'));
});

test('falls back to Piper when Parler fails, and reports ok:false when both fail', async () => {
  const posted = [];
  let piperWorks = true;
  const q = createSummaryJobQueue({
    primary: { name: 'parler', supportsLanguage: () => true, synthesize: async () => { throw new Error('boom'); } },
    backup: { name: 'piper', supportsLanguage: () => true, synthesize: async () => { if (!piperWorks) throw new Error('down'); return audio; } },
    postCallback: async (_url, payload) => { posted.push(payload); },
    log: quietLog,
  });
  q.enqueue(job('a'));
  await q.idle();
  piperWorks = false;
  q.enqueue(job('b'));
  await q.idle();
  assert.equal(posted[0].provider, 'piper');
  assert.equal(posted[1].ok, false);
  assert.match(posted[1].error, /parler: boom \| piper: down/);
});

test('runs jobs one at a time in order and ignores a duplicate job id', async () => {
  let active = 0;
  let maxActive = 0;
  const order = [];
  const q = createSummaryJobQueue({
    primary: {
      name: 'parler', supportsLanguage: () => true,
      synthesize: async (text) => { active++; maxActive = Math.max(maxActive, active); await new Promise(r => setTimeout(r, 10)); active--; order.push(text); return audio; },
    },
    postCallback: async () => {},
    log: quietLog,
  });
  q.enqueue({ ...job('a'), text: 'one' });
  assert.equal(q.enqueue({ ...job('a'), text: 'dup' }), false);
  q.enqueue({ ...job('b'), text: 'two' });
  await q.idle();
  assert.equal(maxActive, 1);
  assert.deepEqual(order, ['one', 'two']);
});

test('retries the callback until it is accepted', async () => {
  let attempts = 0;
  const q = createSummaryJobQueue({
    primary: { name: 'parler', supportsLanguage: () => true, synthesize: async () => audio },
    postCallback: async () => { attempts++; if (attempts < 3) throw new Error('503'); },
    callbackRetryDelaysMs: [1, 1, 1],
    log: quietLog,
  });
  q.enqueue(job('a'));
  await q.idle();
  assert.equal(attempts, 3);
});
