// People & Contacts is paused in bot replies unless the worker variable BC_BOT_REPLIES=on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bcForBot } from './worker.js';

test('bot replies ignore People & Contacts unless BC_BOT_REPLIES=on', async () => {
  const env = { DB: { prepare() { throw new Error('must not read D1 while paused'); } } };
  assert.equal(await bcForBot(env, { Id: 1 }), null);
  assert.equal(await bcForBot({ ...env, BC_BOT_REPLIES: 'off' }, { Id: 1 }), null);
});

test('contact-request card reads People & Contacts even while the prompt block is paused', async () => {
  const { bcForContactCard } = await import('./worker.js');
  const data = JSON.stringify({ identity: { phone: '+971 52 931 9100' }, departments: [] });
  const env = { DB: { prepare() { return { run: async () => ({}), bind() { return { first: async () => ({ data_json: data, updated_at: 'x' }) }; } }; } } };
  const got = await bcForContactCard(env, { Id: 7 });
  assert.equal(got.identity.phone, '+971 52 931 9100');
  assert.equal(await bcForContactCard({ ...env, BC_CONTACT_CARDS: 'off' }, { Id: 8 }), null);
});
