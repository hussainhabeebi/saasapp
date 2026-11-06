// People & Contacts is paused in bot replies unless the worker variable BC_BOT_REPLIES=on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bcForBot } from './worker.js';

test('bot replies ignore People & Contacts unless BC_BOT_REPLIES=on', async () => {
  const env = { DB: { prepare() { throw new Error('must not read D1 while paused'); } } };
  assert.equal(await bcForBot(env, { Id: 1 }), null);
  assert.equal(await bcForBot({ ...env, BC_BOT_REPLIES: 'off' }, { Id: 1 }), null);
});
