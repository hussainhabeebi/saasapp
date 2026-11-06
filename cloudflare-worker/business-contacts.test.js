// Settings → 📇 People & Contacts: the prompt section and the invented phone/email check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bcNormalize, bcPromptBlock, bcFindInventedContact, bcStripInvented, bcAllowedSource, bcPhoneKey, bcPhonesIn, bcEmpty, bcHasContent, bcParse } from './business-contacts.js';

const data=bcNormalize({
  identity:{official_name:'Tripcode Travels LLC', address:'Office 12, Deira, Dubai', phone:'+971 52 931 9100', email:'Hello@Tripcode.ae'},
  departments:[
    {name:'Sales', person:'Rahul', phone:'+971 52 931 9100', handles:'packages, bookings', is_default:true},
    {name:'Visa', person:'Anu', phone:'+971 50 111 2222', handles:'visa status'},
    {name:'Accounts', person:'Owner', phone:'+971 55 999 8888', public:false},
  ],
}).data;
const block=bcPromptBlock(data);
const source=bcAllowedSource(data, 'You are the assistant for Tripcode Travels.'+block);

test('the screenshot case: an invented second number is caught, the real one passes', () => {
  const reply='നിങ്ങൾക്ക് ഈ നമ്പറുകളിൽ ബന്ധപ്പെടാം:\n\n📞 +971 52 795 3891\n📞 +971 52 931 9100';
  assert.equal(bcFindInventedContact(reply, source), '+971 52 795 3891');
  const cleaned=bcStripInvented(reply, source);
  assert.ok(cleaned.includes('+971 52 931 9100'));
  assert.ok(!cleaned.includes('795'));
  assert.equal(bcFindInventedContact(cleaned, source), null);
});

test('the real number written other ways still passes', () => {
  for(const p of ['+971529319100', '052 931 9100', '00971 52 931 9100', '(052) 931-9100'])
    assert.equal(bcFindInventedContact(`Call ${p} please`, source), null, p);
});

test('hidden departments are not in the prompt and their number counts as invented', () => {
  assert.ok(!block.includes('Accounts'));
  assert.ok(!block.includes('999 8888'));
  assert.equal(bcFindInventedContact('Call +971 55 999 8888', bcAllowedSource(data, block)), '+971 55 999 8888');
});

test('prices, dates, times and references are not treated as phone numbers', () => {
  for(const t of ['Package is AED 12500 per person', 'Travel on 2026-11-06 to 2026-11-12', 'Flight at 09:15', 'Booking ref 45829173', 'PNR 12345678', 'Total ₹ 1,29,900', 'Order #102938475'])
    assert.equal(bcFindInventedContact(t, source), null, t);
  assert.deepEqual(bcPhonesIn('Call 3891\n9100'), []);
});

test('invented email addresses are caught, real ones pass', () => {
  assert.equal(bcFindInventedContact('Mail hello@tripcode.ae', source), null);
  assert.equal(bcFindInventedContact('Mail support@tripcode.ae', source), 'support@tripcode.ae');
});

test('a number the customer gave is allowed back', () => {
  const s=bcAllowedSource(data, block, 'my number is 9846012345');
  assert.equal(bcFindInventedContact('We will call you on 9846012345', s), null);
});

test('prompt section: details, one default, rules, and nothing when empty', () => {
  assert.ok(block.includes('## Official business details'));
  assert.ok(block.includes('Official name: Tripcode Travels LLC'));
  assert.ok(block.includes('Email: hello@tripcode.ae'));
  assert.equal(block.split('\n').filter(l=>l.startsWith('- ')&&l.endsWith('[DEFAULT]')).length, 1);
  assert.match(block, /- Sales \(packages, bookings\): Rahul — \+971 52 931 9100.*\[DEFAULT\]/);
  assert.ok(block.includes('Never invent'));
  assert.equal(bcPromptBlock(bcEmpty()), '');
  assert.equal(bcPromptBlock(null), '');
  assert.equal(bcHasContent(bcEmpty()), false);
});

test('normalize: validation, one default, hidden rows never default, bad links dropped', () => {
  const r=bcNormalize({identity:{email:'nope', website:'javascript:alert(1)', logo_url:'http://x/y.png'},
    departments:[{name:'A', phone:'12', public:false, is_default:true}, {name:'B', email:'b@x.com'}, {name:'b'}]});
  assert.ok(r.errors.some(e=>/Main email/.test(e)));
  assert.ok(r.errors.some(e=>/Website/.test(e)));
  assert.ok(r.errors.some(e=>/A: phone/.test(e)));
  assert.ok(r.errors.some(e=>/same name/.test(e)));
  assert.equal(r.data.identity.website, '');
  assert.equal(r.data.identity.logo_url, '');
  assert.deepEqual(r.data.departments.map(d=>d.is_default), [false, true, false]);
  assert.equal(bcPhoneKey('+971 52 931 9100'), bcPhoneKey('0529319100'));
  assert.equal(bcParse('not json'), null);
  assert.equal(bcParse(JSON.stringify(data)).identity.official_name, 'Tripcode Travels LLC');
});
