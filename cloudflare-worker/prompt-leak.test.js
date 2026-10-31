// Vserveindia (Oct 2026): a Malayalam category answer went out followed by the system prompt
// itself ("IMAGES: Never say you cannot see…", "Never claim a human agent…", "Default style (follow
// this"). Pins that the leaked part is cut and the real answer kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineStripPromptLeak, engineFindPromptLeak, engineBuildFaqSystemPrompt } from './worker.js';

const answer = 'Mattress-ഉം Wooden Cot-ഉം ആണ് നിങ്ങൾക്ക് വേണ്ടതെന്ന് മനസ്സിലായി.\n\nWooden Cot-ൽ ഏത് തരം മരമാണ്? Acacia, Treated Mahogany, Teak wood എന്നിവ ലഭ്യമാണ്.';
const leaked = answer + '\n\nIMAGES: Never say you cannot see, view, open, receive or send images or photos. A photo the customer sent appears…\n\nNever claim a human agent, advisor, or your team is "already" looking into something\n\nDefault style (follow this';

test('the real answer survives, the recited instructions are cut', () => {
  assert.equal(engineStripPromptLeak(leaked), answer);
});

test('a clean reply is left untouched', () => {
  assert.equal(engineStripPromptLeak(answer), answer);
  assert.equal(engineFindPromptLeak(answer), -1);
});

test('a reply that is only leaked instructions becomes empty', () => {
  assert.equal(engineStripPromptLeak('Never claim a human agent, advisor, or your team is "already"…'), '');
});

test('headings and instruction sentences of this turn\'s prompt are caught too', () => {
  const sys = 'You sell cots.\n\nCUSTOM SHOP RULE: Mention free delivery.\n\nNever quote a delivery date unless the customer gives their pincode first.';
  assert.equal(engineStripPromptLeak('Yes, we have cots.\nCUSTOM SHOP RULE: Mention free delivery.', sys), 'Yes, we have cots.');
  assert.equal(engineStripPromptLeak('Yes. Never quote a delivery date unless the customer gives their pincode first.', sys), 'Yes.');
});

test('the full engine prompt recited back is caught', () => {
  const sys = engineBuildFaqSystemPrompt({ Id: 1 }, { botMsgs: [] }, '', 'ecommerce', 'ml', false, 'faq');
  const tail = sys.slice(sys.indexOf('IMAGES:'), sys.indexOf('IMAGES:') + 400);
  assert.equal(engineStripPromptLeak(answer + '\n\n' + tail, sys), answer);
});
