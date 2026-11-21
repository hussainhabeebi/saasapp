// Session language: the reply language follows the customer's last 3 messages, so a button tap
// in English doesn't flip an Arabic (or Malayalam, …) chat to English.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineSessionLanguage } from './worker.js';

const ar1 = 'أحتاج إلى معلومات حول باقة حيدر أباد.';
const ar2 = 'كم السعر؟';

test('an English button tap in an Arabic chat keeps the reply in Arabic', () => {
  const h = [
    { role: 'user', content: 'مرحبا' },
    { role: 'assistant', content: 'فلاي إندو هوليدايز ترحب بك' },
    { role: 'user', content: ar1 },
    { role: 'assistant', content: 'هل تبحث عن باقة طيران أم قطار أم حافلة؟' },
  ];
  assert.equal(engineSessionLanguage(h, 'Train', 'en'), 'ar');
});

test('two English messages in a row switch the session to English', () => {
  const h = [{ role: 'user', content: ar1 }, { role: 'user', content: 'Train' }];
  assert.equal(engineSessionLanguage(h, 'what is the price', 'en'), null);
});

test('a message written in its own script always wins straight away', () => {
  const h = [{ role: 'user', content: ar1 }, { role: 'user', content: ar2 }];
  assert.equal(engineSessionLanguage(h, 'നമസ്കാരം', 'ml'), null);
});

test('one earlier Arabic message is not enough to override English', () => {
  const h = [{ role: 'user', content: 'hello' }, { role: 'user', content: ar1 }];
  assert.equal(engineSessionLanguage(h, 'ok', 'en'), null);
});

test('only customer messages count, and an empty history changes nothing', () => {
  const h = [{ role: 'assistant', content: ar1 }, { role: 'assistant', content: ar2 }];
  assert.equal(engineSessionLanguage(h, 'Train', 'en'), null);
  assert.equal(engineSessionLanguage([], 'Train', 'en'), null);
  assert.equal(engineSessionLanguage(undefined, 'Bus', null), null);
});

test('already detected in the session language: nothing to change', () => {
  const h = [{ role: 'user', content: ar1 }, { role: 'user', content: ar2 }];
  assert.equal(engineSessionLanguage(h, 'Train', 'ar'), null);
});

test('Malayalam chat, English button tap: stays Malayalam', () => {
  const h = [{ role: 'user', content: 'ഹൈദരാബാദ് പാക്കേജ് വേണം' }, { role: 'user', content: 'എത്ര രൂപ?' }];
  assert.equal(engineSessionLanguage(h, 'Flight', 'en'), 'ml');
});
