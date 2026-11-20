// 👤 Profiles: who gets the module, document status, reminders and the trip check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ppIsOn, ppDate, ppMonthDay, ppCleanProfile, ppCleanDocument, ppDocStatus, ppDocStep, ppRemindersDue,
  ppTravelCheck, ppNextOccurrence, ppAge, ppMask, ppAddMonths, ppReminderMessage, ppCurrentPassport } from './passenger-profiles.js';

test('only travel and hospitality accounts get Profiles', () => {
  assert.equal(ppIsOn({industry:'travel'}), true);
  assert.equal(ppIsOn({industry:'Hospitality'}), true);
  assert.equal(ppIsOn({industry:'general', ta_enabled:'Yes'}), true);
  assert.equal(ppIsOn({industry:'real_estate', hospitality_enabled:'Yes'}), true);
  for(const c of [{industry:'general'}, {industry:'ecommerce'}, {industry:'healthcare', ta_enabled:'No'}, null])
    assert.equal(ppIsOn(c), false, JSON.stringify(c));
});

test('dates: ISO and DD/MM/YYYY are read, impossible dates are not', () => {
  assert.equal(ppDate('2027-03-09'), '2027-03-09');
  assert.equal(ppDate('09/03/2027'), '2027-03-09');
  assert.equal(ppDate('2027-02-30'), '');
  assert.equal(ppDate('soon'), '');
  assert.equal(ppMonthDay('06-15'), '06-15');
  assert.equal(ppMonthDay('13-01'), '');
  assert.equal(ppAddMonths('2026-08-31', 6), '2027-02-28');
});

test('profile and document cleaning reports problems', () => {
  assert.deepEqual(ppCleanProfile({}).errors, ['First or last name is required.']);
  const ok=ppCleanProfile({first_name:' Anu ', last_name:'Mathew', email:'ANU@Mail.com', date_of_birth:'15/06/1990', gender:'Female'});
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.data.email, 'anu@mail.com');
  assert.equal(ok.data.date_of_birth, '1990-06-15');
  assert.equal(ok.data.gender, 'female');
  const bad=ppCleanDocument({type:'passport', number:'p 123 4567'});
  assert.ok(bad.errors.includes('Passport expiry date is required.'));
  assert.equal(bad.data.number, 'P1234567');
  assert.ok(ppCleanDocument({type:'visa', issue_date:'2026-05-01', expiry_date:'2026-04-01'}).errors.includes('Expiry date must be after the issue date.'));
});

const today='2026-11-20';
test('document status: 6-month window for passports, 60 days for others', () => {
  assert.equal(ppDocStatus({type:'passport', expiry_date:'2027-05-01'}, today), 'expiring');
  assert.equal(ppDocStatus({type:'passport', expiry_date:'2027-06-30'}, today), 'valid');
  assert.equal(ppDocStatus({type:'visa', expiry_date:'2027-03-01'}, today), 'valid');
  assert.equal(ppDocStatus({type:'visa', expiry_date:'2026-12-15'}, today), 'expiring');
  assert.equal(ppDocStatus({type:'passport', expiry_date:'2026-11-19'}, today), 'expired');
  assert.equal(ppDocStatus({type:'passport', expiry_date:'2026-12-01', state:'renewal'}, today), 'renewal');
  assert.equal(ppDocStatus({type:'passport', expiry_date:'2026-01-01', state:'replaced'}, today), 'replaced');
  assert.equal(ppDocStatus({type:'national_id'}, today), 'no_expiry');
});

test('one reminder step at a time — a passport 20 days out raises only the 30-day reminder', () => {
  assert.deepEqual(ppDocStep({type:'passport', expiry_date:'2026-12-10'}, today), {step:30, days:20});
  assert.deepEqual(ppDocStep({type:'passport', expiry_date:'2027-08-01'}, today), {step:270, days:254});
  assert.equal(ppDocStep({type:'passport', expiry_date:'2028-01-01'}, today), null);
  assert.deepEqual(ppDocStep({type:'visa', expiry_date:today}, today), {step:0, days:0});
  assert.equal(ppDocStep({type:'visa', expiry_date:'2026-11-01'}, today).step, 'expired');
  assert.equal(ppDocStep({type:'visa', expiry_date:'2026-11-01', state:'replaced'}, today), null);
});

test('reminders: documents, birthdays and anniversaries, with stable keys', () => {
  const profiles=[
    {id:1, first_name:'Anu', last_name:'Mathew', date_of_birth:'1990-11-25', anniversary:'11-20',
      docs:[{id:7, type:'passport', expiry_date:'2026-12-10'}, {id:8, type:'visa', visa_country:'UAE', expiry_date:'2028-01-01'}]},
    {id:2, first_name:'Ravi', date_of_birth:'1985-03-01', docs:[]},
  ];
  const rems=ppRemindersDue(profiles, today);
  assert.deepEqual(rems.map(r=>r.key), ['anniversary:1:2026-11-20:day', 'birthday:1:2026-11-25:ahead', 'doc:7:2026-12-10:30']);
  assert.match(rems[1].title, /turns 36/);
  assert.match(rems[2].title, /Passport expires in 20 days/);
  // The next day the same steps give the same keys (so nothing is raised twice).
  assert.ok(ppRemindersDue(profiles, '2026-11-21').some(r=>r.key==='doc:7:2026-12-10:30'));
});

test('birthdays: next occurrence, 29 February and age', () => {
  assert.deepEqual(ppNextOccurrence('1990-11-19', today), {date:'2027-11-19', days:364});
  assert.equal(ppNextOccurrence('2000-02-29', '2027-02-01').date, '2027-02-28');
  assert.equal(ppAge('1990-11-25', today), 35);
  assert.equal(ppAge('1990-11-20', today), 36);
});

test('trip check: 6 months after return, expiry during the trip, visas, minors', () => {
  const p={first_name:'Anu', date_of_birth:'1990-01-01'};
  const pp=e=>[{type:'passport', number:'P1', expiry_date:e}];
  assert.deepEqual(ppTravelCheck(p, pp('2028-01-01'), {departure:'2027-01-10', ret:'2027-01-20'}), []);
  assert.equal(ppTravelCheck(p, pp('2027-05-01'), {departure:'2027-01-10', ret:'2027-01-20'})[0].code, 'six_months');
  assert.equal(ppTravelCheck(p, pp('2027-01-15'), {departure:'2027-01-10', ret:'2027-01-20'})[0].code, 'expires_during');
  assert.equal(ppTravelCheck(p, pp('2027-01-01'), {departure:'2027-01-10'})[0].code, 'expired_before');
  assert.equal(ppTravelCheck(p, [], {departure:'2027-01-10'})[0].code, 'no_passport');
  const docs=[...pp('2030-01-01'), {type:'visa', visa_country:'Schengen', expiry_date:'2027-01-15'}];
  assert.equal(ppTravelCheck(p, docs, {departure:'2027-01-10', ret:'2027-01-20', destination:'schengen'})[0].code, 'visa_expires');
  assert.equal(ppTravelCheck(p, pp('2030-01-01'), {departure:'2027-01-10', destination:'Japan'})[0].code, 'no_visa');
  assert.equal(ppTravelCheck({first_name:'Kid', date_of_birth:'2015-01-01'}, pp('2030-01-01'), {departure:'2027-01-10'})[0].code, 'minor');
});

test('the current passport is the longest-lasting one that has not been replaced', () => {
  const docs=[{id:1, type:'passport', expiry_date:'2031-01-01', state:'replaced'}, {id:2, type:'passport', expiry_date:'2030-01-01'}, {id:3, type:'visa', expiry_date:'2035-01-01'}];
  assert.equal(ppCurrentPassport(docs).id, 2);
});

test('masking keeps only the end of the number', () => {
  assert.equal(ppMask('P1234567'), '•••••567');
  assert.equal(ppMask('AB12'), '•••12');
  assert.equal(ppMask(''), '');
});

test('reminder messages are friendly and name the document', () => {
  const doc={type:'passport', expiry_date:'2026-12-10'};
  const m=ppReminderMessage({kind:'passport', days:20, due_date:'2026-12-10'}, {first_name:'Anu'}, doc, 'Tripcode');
  assert.match(m, /^Hi Anu, .*Passport expires on 10 Dec 2026.*6 months.*Tripcode$/);
  assert.match(ppReminderMessage({kind:'birthday'}, {first_name:'Ravi'}, null), /Happy birthday, Ravi/);
});
