// Couplo (Sep 2026): a customer's photo couldn't be read, reached the bot as a bare "(image
// received)", and after "Pic sent" the bot replied "I can't see images here". Pins the mime-type
// normalisation and the note the bot now gets instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineImageMimeType, ENGINE_IMAGE_UNREADABLE_NOTE, engineBuildFaqSystemPrompt } from './worker.js';

test('non-image content types from Chatwoot/S3 are sent to Gemini as image/jpeg', () => {
  assert.equal(engineImageMimeType('application/octet-stream'), 'image/jpeg');
  assert.equal(engineImageMimeType('binary/octet-stream'), 'image/jpeg');
  assert.equal(engineImageMimeType(''), 'image/jpeg');
  assert.equal(engineImageMimeType('image/jpg'), 'image/jpeg');
  assert.equal(engineImageMimeType('image/png; charset=binary'), 'image/png');
  assert.equal(engineImageMimeType('image/webp'), 'image/webp');
});

test('an unreadable photo tells the bot to ask again, never to say it cannot see images', () => {
  assert.match(ENGINE_IMAGE_UNREADABLE_NOTE, /resend the photo/);
  assert.match(ENGINE_IMAGE_UNREADABLE_NOTE, /Do NOT say you cannot see/);
});

test('every FAQ prompt forbids claiming images cannot be seen or sent', () => {
  const sys = engineBuildFaqSystemPrompt({ client_name: 'Couplo', industry: 'ecommerce', bot_config: '{}' }, { history: [], stage: 'new' }, '', 'ecommerce', 'en', false, 'QUESTION');
  assert.match(sys, /Never say you cannot see, view, open, receive or send images/);
});
