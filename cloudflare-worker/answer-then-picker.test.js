// Couplo (Sep 2026): a category enquiry ("New born baby aanu") got only "Please choose a product
// from Premium Baby Set:" + a picker. The reply to what they said now goes first as its own
// message; the verified product options follow as a short, separate picker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineSendAnswerThenPicker } from './worker.js';

test('answer is sent first, then a short picker with the product options', async () => {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const body = opts.body instanceof FormData ? Object.fromEntries(opts.body) : JSON.parse(opts.body || '{}');
    sent.push({ url: String(url), body });
    return new Response('{}', { status: 200 });
  };
  try {
    const c = { chatwoot_base: 'https://cw.test', chatwoot_account_id: 1, chatwoot_token: 't' };
    const answer = 'For a 23-day-old, our Newborn sets fit perfectly 😊';
    const r = await engineSendAnswerThenPicker({}, c, 7, 42, '919000000000', answer, 'Tap a set to see details and photos 👇',
      [{ title: 'Affordable Full Romper Set', value: 'Affordable Full Romper Set' }, { title: 'Premium Onesie Set', value: 'Premium Onesie Set' }]);
    const toConv = sent.filter((s) => s.url.includes('/conversations/42/messages'));
    assert.equal(toConv[0].body.content, answer);
    assert.match(JSON.stringify(toConv[toConv.length - 1].body), /Tap a set to see details/);
    assert.match(JSON.stringify(toConv[toConv.length - 1].body), /Affordable Full Romper Set/);
    assert.equal(r.reply, `${answer}\n\nTap a set to see details and photos 👇`);
  } finally { globalThis.fetch = realFetch; }
});
