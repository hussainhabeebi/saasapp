// Flights → ⚙️ Travel Settings → 🧩 Optional WhatsApp chat extras: a direct-flights list layout,
// a travel date picker with a "type a date" option, and passport details in the booking form.
// All three are off by default and change nothing until an agency turns them on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ltFormatChatOffers, ltChatFarePrefs, ltTravelSettingsNormalize, LT_TRAVEL_SETTINGS_DEFAULTS, ltChatDateRows, ltChatTypeDateAsk, ltChatDatePickerText, ltManualBookingStaffNote } from './worker.js';
import { ltBookingFormText, ltBookingFormMissing, ltParseBookingForm, ltParsePassengerDate, ltPassengerPassportLine } from './live-travel-wa-menu.js';

const offer=(id,airline,flight,total,dep,arr,duration,stops)=>({supplier:'poomas',supplier_offer_id:id,bookable:true,airline_name:airline,flight_numbers:flight,total_amount:total,currency:'INR',cabin:'economy',seats_left:4,baggage:{cabin:'7 kg',checked:'30 kg'},
  itinerary:[{origin:'CCJ',destination:'AUH',departureTime:dep,arrivalTime:arr,duration,stops}]});
const offers=[
  offer('F1','AI Express','359',17365,'2026-11-10T20:00:00','2026-11-10T22:30:00',240,0),
  offer('F2','Saudia','771',15100,'2026-11-10T03:00:00','2026-11-10T11:00:00',600,1),
  offer('F3','IndiGo','1435',17865,'2026-11-10T21:45:00','2026-11-11T00:25:00',250,0),
];

test('all three extras are off by default and saved as true/false', () => {
  for (const k of ['lt_direct_list', 'lt_date_picker', 'lt_passport_details']) assert.equal(LT_TRAVEL_SETTINGS_DEFAULTS[k], false);
  const prefs = ltChatFarePrefs({});
  assert.deepEqual([prefs.directList, prefs.datePicker, prefs.passport], [false, false, false]);
  const on = ltTravelSettingsNormalize({ lt_direct_list: 'Yes', lt_date_picker: true, lt_passport_details: 'No' });
  assert.deepEqual([on.lt_direct_list, on.lt_date_picker, on.lt_passport_details], [true, true, false]);
});

test('direct flights list: off keeps the current layout, on lists direct flights in their own section', () => {
  assert.equal(ltFormatChatOffers(offers, { limit: 3, directList: false }), ltFormatChatOffers(offers, { limit: 3 }));
  const text = ltFormatChatOffers(offers, { limit: 3, directList: true });
  assert.match(text, /✈️ \*Direct flights \(2\)\*\n━+\n\n\*1\. AI Express 359\*\n• 🛫 Departs: CCJ · 20:00\n• 🛬 Arrives: AUH · 22:30\n• ⏱️ Duration: 4h 0m\n• 🔀 Stops: Direct \(non-stop\)\n• 🧳 Baggage: Cabin 7 kg · Check-in 30 kg\n• 💳 Fare: \*INR 17,365\*/);
  // A blank line separates every flight, and the connecting flight sits in its own section.
  assert.match(text, /4 seats left\n\n\*2\. IndiGo 1435\*/);
  assert.match(text, /00:25 \(\+1 day\)/);
  assert.match(text, /🔁 \*Connecting flights \(1\)\*\n━+\n\n\*3\. Saudia 771\*\n[\s\S]*• 🔀 Stops: 1 stop/);
  // Option numbers follow the Book Option buttons (direct first, then cheapest).
  assert.ok(text.indexOf('*1. AI Express') < text.indexOf('*2. IndiGo') && text.indexOf('*2. IndiGo') < text.indexOf('*3. Saudia'));
  const hidden = ltFormatChatOffers(offers, { limit: 3, directList: true, showFares: false });
  assert.doesNotMatch(hidden, /💳 Fare/);
});

test('travel date picker: the next days plus a "type a date" row, within the 10-row WhatsApp list', () => {
  const rows = ltChatDateRows({ typeOption: true, today: new Date('2026-11-06T09:00:00Z') });
  assert.equal(rows.length, 10);
  assert.equal(rows[0].value, '2026-11-07');
  assert.equal(rows.at(-1).value, 'type a date');
  assert.equal(ltChatDateRows({ today: new Date('2026-11-06T09:00:00Z') }).length, 9);
  for (const t of ['type a date', '✍️ Type a date', 'enter the travel date']) assert.ok(ltChatTypeDateAsk(t), t);
  for (const t of ['20 Nov', 'type a message', 'date please?']) assert.ok(!ltChatTypeDateAsk(t), t);
  assert.match(ltChatDatePickerText({ origin: 'CCJ', destination: 'AUH' }), /When are you flying \*CCJ → AUH\*\?[\s\S]*Pick a date[\s\S]*type the date/);
});

test('passenger details: off keeps name + email only', () => {
  assert.deepEqual(ltBookingFormMissing({}), ['name', 'email']);
  assert.deepEqual(ltParseBookingForm('Hussain Aparambil\nname@email.com'), { name: 'Hussain Aparambil', email: 'name@email.com' });
  assert.doesNotMatch(ltBookingFormText({}), /Passport Number/);
});

test('passenger details: full name, date of birth, passport number and expiry in one message', () => {
  const today = new Date('2026-11-06T00:00:00Z');
  const form = ltBookingFormText({}, { passport: true });
  for (const f of ['Full Name', 'Date of Birth', 'Passport Number', 'Passport Expiry Date']) assert.ok(form.includes(f), f);
  const labelled = ltParseBookingForm('Full Name: hussain aparambil\nDate of Birth: 15/04/1990\nPassport Number: N1234567\nPassport Expiry Date: 20/08/2031\nEmail: name@email.com', {}, { passport: true, today });
  assert.deepEqual(labelled, { name: 'Hussain Aparambil', email: 'name@email.com', dob: '1990-04-15', passport_number: 'N1234567', passport_expiry: '2031-08-20' });
  const plain = ltParseBookingForm('Hussain Aparambil\n15 Apr 1990\nN1234567\n2031-08-20\nname@email.com', {}, { passport: true, today });
  assert.deepEqual(plain, labelled);
  assert.deepEqual(ltBookingFormMissing(plain, { passport: true }), []);
});

test('passenger details: one field at a time, and an expired passport is flagged', () => {
  const today = new Date('2026-11-06T00:00:00Z');
  let p = ltParseBookingForm('Hussain Aparambil', {}, { passport: true, today });
  assert.equal(ltBookingFormMissing(p, { passport: true })[0], 'dob');
  assert.match(ltBookingFormText(p, { passport: true }), /1 of 5 received[\s\S]*date of birth/);
  p = ltParseBookingForm('15-04-1990', p, { passport: true, today });
  assert.equal(p.dob, '1990-04-15');
  p = ltParseBookingForm('P 1234567', p, { passport: true, today });
  assert.equal(p.passport_number, 'P1234567');
  const expired = ltParseBookingForm('01/01/2020', p, { passport: true, today });
  assert.equal(expired.passport_expiry, '');
  assert.equal(expired.expired_passport, '2020-01-01');
  p = ltParseBookingForm('20/08/2031', p, { passport: true, today });
  assert.equal(p.passport_expiry, '2031-08-20');
  assert.deepEqual(ltBookingFormMissing(p, { passport: true }), ['email']);
  assert.equal(ltParsePassengerDate('31/02/1990'), '');
  assert.equal(ltPassengerPassportLine(p), '🎂 DOB 15/04/1990 · 🛂 Passport P1234567 · 📅 Expires 20/08/2031');
  assert.match(ltManualBookingStaffNote({ airline: 'IndiGo', origin: 'CCJ', destination: 'AUH' }, { ...p, email: 'a@b.co' }, '971500000000'), /🛂 Passport P1234567/);
  assert.doesNotMatch(ltManualBookingStaffNote({ airline: 'IndiGo' }, { name: 'A B', email: 'a@b.co' }, '1'), /Passport/);
});
