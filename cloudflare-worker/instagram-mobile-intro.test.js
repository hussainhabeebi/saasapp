// Instagram leads have no phone number (key `ig:<id>`). Settings → 📸 Instagram Intro sends a
// separate intro that asks for the customer's mobile number, saves it to the lead's Mobile column,
// and never asks again once Mobile is on the lead record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineExtractMobileNumber, engineIsMobileOnlyMessage, engineInstagramMobileConfig, engineLeadMobile, engineInstagramMobileTurn } from './worker.js';

const ON = { client_name: 'Couplo', language: 'en', bot_config: JSON.stringify({ instagram_mobile_intro: { enabled: true } }) };

async function withFetch(fn) {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch {}
    sent.push({ url: String(url), method: opts.method || 'GET', body });
    return new Response(JSON.stringify({ list: [], columns: [] }), { status: 200 });
  };
  try { return await fn(sent); } finally { globalThis.fetch = realFetch; }
}
const env = { NOCODB_BASE: 'https://nc.test', NOCODB_TOKEN: 't' };
const patchesWith = (sent, key) => sent.filter((s) => s.method === 'PATCH' && key in s.body);

test('finds mobile numbers, ignores prices and dates', () => {
  assert.equal(engineExtractMobileNumber('+91 98765 43210').number, '+919876543210');
  assert.equal(engineExtractMobileNumber('my number is 050-123-4567').number, '0501234567');
  assert.equal(engineExtractMobileNumber('00971 50 123 4567').number, '+971501234567');
  assert.equal(engineExtractMobileNumber('٩٨٧٦٥٤٣٢١٠').number, '9876543210');
  for (const t of ['price 1500', 'booking on 10-12-2026', '2026-11-08', 'need 3 sets', '']) assert.equal(engineExtractMobileNumber(t), null, t);
});

test('number-only replies vs a number inside a question', () => {
  for (const t of ['9876543210', 'My WhatsApp number is +91 98765 43210', 'here: 050 123 4567 thanks'])
    assert.equal(engineIsMobileOnlyMessage(t, engineExtractMobileNumber(t)), true, t);
  const q = 'What is the price of the romper set? my number 9876543210';
  assert.equal(engineIsMobileOnlyMessage(q, engineExtractMobileNumber(q)), false);
});

test('off unless switched on in Settings', () => {
  assert.equal(engineInstagramMobileConfig({}), null);
  assert.equal(engineInstagramMobileConfig({ bot_config: '{"instagram_mobile_intro":{"enabled":false}}' }), null);
  assert.match(engineInstagramMobileConfig(ON).text, /mobile number/);
  assert.equal(engineLeadMobile({ Mobile: '' }), '');
  assert.equal(engineLeadMobile({ Mobile: '+971 50 123 4567' }), '+971 50 123 4567');
});

test('a new Instagram lead gets the Instagram intro and MobileAskedAt is stamped', () => withFetch(async (sent) => {
  const state = { channel: 'instagram', leadId: 5, lead: { Id: 5 }, name: 'Asha', activeHistory: [] };
  const turn = await engineInstagramMobileTurn(env, ON, state, 'Hi', 'text', { isNewLead: true });
  assert.equal(turn.route, 'instagram_mobile_intro');
  assert.match(turn.text, /Hi Asha! 👋 Welcome to Couplo/);
  assert.equal(patchesWith(sent, 'MobileAskedAt').length, 1);
}));

test('WhatsApp leads are left alone', () => withFetch(async () => {
  const state = { channel: 'whatsapp', leadId: 5, lead: { Id: 5 }, activeHistory: [] };
  assert.equal(await engineInstagramMobileTurn(env, ON, state, 'Hi', 'text', { isNewLead: true }), null);
}));

test('the number the customer sends is saved to the lead and thanked', () => withFetch(async (sent) => {
  const state = { channel: 'instagram', leadId: 5, lead: { Id: 5, MobileAskedAt: '2026-11-08T10:00:00Z' }, activeHistory: [{ role: 'assistant', content: 'share your mobile number' }] };
  const turn = await engineInstagramMobileTurn(env, ON, state, '+91 98765 43210', 'text', {});
  assert.equal(turn.route, 'instagram_mobile_saved');
  assert.match(turn.text, /\+919876543210/);
  assert.equal(patchesWith(sent, 'Mobile')[0].body.Mobile, '+919876543210');
  assert.equal(state.mobileSaved, '+919876543210');
}));

test('a number inside a question is saved, the question still goes to the bot', () => withFetch(async (sent) => {
  const state = { channel: 'instagram', leadId: 5, lead: { Id: 5, MobileAskedAt: 'x' }, activeHistory: [] };
  assert.equal(await engineInstagramMobileTurn(env, ON, state, 'Price of the romper set? my number 9876543210', 'text', {}), null);
  assert.equal(patchesWith(sent, 'Mobile')[0].body.Mobile, '9876543210');
}));

test('never asks again once Mobile is on the lead record', () => withFetch(async (sent) => {
  const state = { channel: 'instagram', leadId: 5, lead: { Id: 5, Mobile: '9876543210' }, activeHistory: [] };
  assert.equal(await engineInstagramMobileTurn(env, ON, state, 'Hi', 'text', { isNewLead: true, isRevisit: true }), null);
  assert.equal(sent.length, 0);
}));

test('a specific first question is answered first; asked again only on a revisit once asked', () => withFetch(async () => {
  const fresh = { channel: 'instagram', leadId: 5, lead: { Id: 5 }, activeHistory: [] };
  assert.equal(await engineInstagramMobileTurn(env, ON, fresh, 'What is the price of the romper set?', 'text', { isNewLead: true }), null);
  const askedLongChat = { channel: 'instagram', leadId: 5, lead: { Id: 5, MobileAskedAt: 'x' }, activeHistory: new Array(8).fill({ role: 'user', content: 'x' }) };
  assert.equal(await engineInstagramMobileTurn(env, ON, askedLongChat, 'ok', 'text', {}), null);
  assert.equal((await engineInstagramMobileTurn(env, ON, askedLongChat, 'Hi', 'text', { isRevisit: true })).route, 'instagram_mobile_intro');
}));

test('custom intro and thank-you texts', () => withFetch(async () => {
  const c = { client_name: 'Couplo', bot_config: JSON.stringify({ instagram_mobile_intro: { enabled: true, text: 'Hello from {{business_name}} — your number?', thanks_text: 'Got {{mobile}}!' } }) };
  const s1 = { channel: 'instagram', leadId: 5, lead: { Id: 5 }, activeHistory: [] };
  assert.equal((await engineInstagramMobileTurn(env, c, s1, 'Hi', 'text', { isNewLead: true })).text, 'Hello from Couplo — your number?');
  const s2 = { channel: 'instagram', leadId: 5, lead: { Id: 5, MobileAskedAt: 'x' }, activeHistory: [] };
  assert.equal((await engineInstagramMobileTurn(env, c, s2, '9876543210', 'text', {})).text, 'Got 9876543210!');
}));
