// Follow-up V3 wording & targeting guards (Couplo fix plan, Fix 5) — all off by default.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fv3Config, fv3Decide, fv3GuardText, fv3JitterMs, fv3BlockedWords, fv3ErrorAction, FV3_DEFAULTS} from './followup-v3.js';

const H=3600000, T=iso=>Date.parse(iso);
const steps={1:{step:1, type:'session', hours:1, message:'Hi {name}, A1'}, 2:{step:2, type:'session', hours:6, message:'Hi {name}, A2'}};
const lead=(o={})=>({Id:7, Name:'Asha', Stage:'new', CreatedAt:'2026-10-05T10:00:00Z', LastCustomerMsgAt:'2026-10-10T10:00:00Z', ...o});
const decide=(cfg, l={}, now=T('2026-10-10T12:00:00Z'))=>fv3Decide({lead:lead(l), steps, cfg:fv3Config(cfg), enabledAt:'2026-10-01T00:00:00Z', now, tz:'UTC'});

test('guards are off by default and existing decisions are unchanged', () => {
  for(const k of ['placeholder_guard','wording_guard','discussed_rule','stop_not_interested']) assert.equal(FV3_DEFAULTS[k], false);
  assert.equal(FV3_DEFAULTS.send_jitter_minutes, 0);
  assert.equal(decide({}, {Stage:'Not Interested'}).status, 'due');
  assert.deepEqual(fv3GuardText('Hey [Client Name]! proposal', {cfg:fv3Config({})}), {text:'Hey [Client Name]! proposal'});
});

test('placeholder guard drops name placeholders and blocks other unfilled ones', () => {
  const cfg=fv3Config({placeholder_guard:true});
  assert.equal(fv3GuardText('Hey [Client Name]! Just wanted to check in.', {cfg}).text, 'Hey! Just wanted to check in.');
  assert.equal(fv3GuardText('Hi , did the set look okay?', {cfg}).text, 'Hi, did the set look okay?');
  assert.equal(fv3GuardText('Hi {name}, your order', {cfg}).text, 'Hi, your order');
  assert.match(fv3GuardText('Hi Asha, the [product] is ready', {cfg}).block, /unfilled placeholder \[product\]/);
});

test('wording guard blocks agency words for shops only', () => {
  const cfg=fv3Config({wording_guard:true});
  assert.match(fv3GuardText('Hi Asha, any thoughts on our design proposal?', {cfg, industry:'ecommerce'}).block, /proposal/);
  assert.match(fv3GuardText('ഞാൻ വിളിച്ചതാണ്', {cfg, industry:'ecommerce'}).block, /വിളിച്ചതാണ്/);
  assert.equal(fv3GuardText('Hi Asha, did the romper set look okay?', {cfg, industry:'ecommerce'}).text, 'Hi Asha, did the romper set look okay?');
  assert.equal(fv3GuardText('Your proposal is ready', {cfg, industry:'saas_digital_marketing'}).text, 'Your proposal is ready');
  assert.deepEqual(fv3BlockedWords(fv3Config({blocked_words:['visit']}), 'ecommerce'), ['visit']);
  assert.equal(fv3ErrorAction(null, 'Wording guard: "proposal" doesn\'t fit this business').kind, 'skip');
});

test('"what we discussed" only after two real messages', () => {
  const cfg=fv3Config({discussed_rule:true});
  assert.equal(fv3GuardText('Following up on everything we discussed 😊', {cfg, realMsgCount:1}).text, 'Following up on your enquiry 😊');
  assert.equal(fv3GuardText('Following up on everything we discussed 😊', {cfg, realMsgCount:3}).text, 'Following up on everything we discussed 😊');
});

test('stop at Not Interested / supplier, and only-stages', () => {
  assert.equal(decide({stop_not_interested:true}, {Stage:'Not Interested'}).reason, 'not_interested');
  assert.equal(decide({stop_not_interested:true}, {Stage:'supplier'}).reason, 'not_interested');
  assert.equal(decide({stop_not_interested:true}, {Stage:'new'}).status, 'due');
  assert.equal(decide({only_stages:['contacted','cart']}, {Stage:'new'}).reason, 'stage_not_followed');
  assert.equal(decide({only_stages:['contacted','cart']}, {Stage:'Contacted'}).status, 'due');
});

test('send jitter spreads leads and stays stable per lead', () => {
  assert.equal(fv3JitterMs(7, 0), 0);
  assert.equal(fv3JitterMs(7, 45), fv3JitterMs(7, 45));
  const slots=new Set([1,2,3,4,5,6,7,8,9,10].map(id=>fv3JitterMs(id, 45)));
  assert.ok(slots.size>3);
  for(const s of slots) assert.ok(s>=0 && s<=45*60000);
  // A jittered nudge 1 is due later than the plain one, never earlier.
  const plain=decide({}, {}, T('2026-10-10T11:00:00Z'));
  const spread=decide({send_jitter_minutes:120}, {Id:12345}, T('2026-10-10T11:00:00Z'));
  assert.ok(Date.parse(spread.steps[0].due_at)>=Date.parse(plain.steps[0].due_at));
});
