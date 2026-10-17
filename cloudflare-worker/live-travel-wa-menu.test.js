import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ltMenuDefaults, ltMenuNormalize, ltMenuValidate, ltMenuSections, ltMenuMatch, ltMenuIsGreeting, ltMenuIsMenuRequest,
  ltMenuGreetingText, ltMenuDateRows, ltMenuRouteRows, ltMenuParsePax, ltCheckoutCommand, ltParseBookingForm, ltBookingFormMissing,
  ltCheckoutUrl, ltFlightDetailsText } from './live-travel-wa-menu.js';

test('default menu normalizes to WhatsApp-safe rows grouped by section', () => {
  const menu = ltMenuNormalize({ ...ltMenuDefaults(), enabled: true });
  assert.deepEqual(ltMenuValidate(menu), []);
  const sections = ltMenuSections(menu);
  assert.deepEqual(sections.map(s => s.title), ['Book', 'Documents', 'My Trip', 'Help']);
  const rows = sections.flatMap(s => s.rows);
  assert.ok(rows.length <= 10);
  assert.ok(!rows.some(r => r.id === 'TMENU:attestation'), 'switched-off rows are not sent');
  for (const r of rows) { assert.ok(r.title.length <= 24, r.title); assert.ok((r.description || '').length <= 72); }
  assert.equal(rows[0].title, '✈️ Flight Tickets');
});

test('normalize cleans bad input: ids, actions, links, routes', () => {
  const menu = ltMenuNormalize({ enabled: 1, items: [
    { title: 'Visa', action: 'nope' }, { title: 'Visa' }, { title: 'Site', action: 'link', url: 'javascript:alert(1)' },
  ], popular_routes: ['dxb-cok', ['SHJ', 'CCJ'], ['DXB', 'DXB'], 'bad'] });
  assert.equal(menu.enabled, true);
  assert.deepEqual(menu.items.map(i => i.id), ['visa', 'visa_2', 'site']);
  assert.equal(menu.items[0].action, 'ask');
  assert.equal(menu.items[2].url, '');
  assert.deepEqual(menu.popular_routes, [['DXB', 'COK'], ['SHJ', 'CCJ']]);
  const errors = ltMenuValidate(menu);
  assert.ok(errors.some(e => e.includes('Two options')));
  assert.ok(errors.some(e => e.includes('https://')));
});

test('more than 10 options on is rejected', () => {
  const items = Array.from({ length: 11 }, (_, i) => ({ title: `Option ${i}` }));
  assert.match(ltMenuValidate(ltMenuNormalize({ enabled: true, items })).join(' '), /at most 10/);
});

test('a tap matches by id, by the echoed title, or by the bare title', () => {
  const menu = ltMenuNormalize({ ...ltMenuDefaults(), enabled: true });
  assert.equal(ltMenuMatch(menu, 'TMENU:visa').id, 'visa');
  assert.equal(ltMenuMatch(menu, '🛂 Visa Services').id, 'visa');
  assert.equal(ltMenuMatch(menu, 'visa services').id, 'visa');
  assert.equal(ltMenuMatch(menu, 'TMENU:attestation'), null, 'a switched-off row never runs');
  assert.equal(ltMenuMatch(menu, 'I need a visa for my wife'), null);
});

test('greetings and menu words open the menu; real questions do not', () => {
  for (const t of ['hi', 'Hii', 'Hello!', 'hey there', 'Assalamu alaikum', 'good morning', 'salam 🙏']) assert.ok(ltMenuIsGreeting(t), t);
  for (const t of ['hi I need ticket to dubai', 'hello, price?', 'history']) assert.ok(!ltMenuIsGreeting(t), t);
  for (const t of ['menu', 'Main Menu', '📋 Menu', 'back to menu']) assert.ok(ltMenuIsMenuRequest(t), t);
  assert.ok(!ltMenuIsMenuRequest('menu for the hotel restaurant'));
});

test('greeting text uses the agency, the customer first name and custom text', () => {
  const menu = ltMenuDefaults();
  assert.match(ltMenuGreetingText(menu, { agencyName: 'Al Noor Travels', customerName: 'Hussain Aparambil' }), /Hi Hussain, welcome to \*Al Noor Travels\*/);
  assert.match(ltMenuGreetingText(menu, { customerName: '+971500000000' }), /^👋 Welcome!/);
  assert.match(ltMenuGreetingText(menu, { customerName: 'Asha', returning: true }), /Welcome back, Asha/);
  assert.equal(ltMenuGreetingText({ ...menu, greeting: 'Hello {name} from {agency}' }, { agencyName: 'X', customerName: 'Asha' }), 'Hello Asha from X');
});

test('date and route pickers', () => {
  const rows = ltMenuDateRows(new Date('2026-10-17T10:00:00Z'));
  assert.equal(rows.length, 9);
  assert.deepEqual(rows[0], { title: '18 Oct · Sun', value: '2026-10-18', description: 'Tomorrow' });
  assert.ok(rows.every(r => r.title.length <= 24));
  assert.deepEqual(ltMenuRouteRows([['SHJ', 'CCJ'], { origin: 'shj', destination: 'ccj' }, ['CCJ', 'SHJ'], ['X', 'Y']]),
    [{ title: 'SHJ → CCJ', value: 'SHJ to CCJ' }, { title: 'CCJ → SHJ', value: 'CCJ to SHJ' }]);
});

test('passenger answers', () => {
  assert.deepEqual(ltMenuParsePax('2'), { adults: 2, children: 0, infants: 0 });
  assert.deepEqual(ltMenuParsePax('2 Adults'), { adults: 2, children: 0, infants: 0 });
  assert.deepEqual(ltMenuParsePax('2 adults 1 child 1 infant'), { adults: 2, children: 1, infants: 1 });
  assert.equal(ltMenuParsePax('tomorrow'), null);
});

test('checkout commands accept the echoed button titles', () => {
  assert.equal(ltCheckoutCommand('✅ Proceed to Book'), 'proceed');
  assert.equal(ltCheckoutCommand('book now'), 'proceed');
  assert.equal(ltCheckoutCommand('⏭️ Skip form'), 'skip_form');
  assert.equal(ltCheckoutCommand('🔁 Other Flights'), 'other_flights');
  assert.equal(ltCheckoutCommand('checkout'), 'open_checkout');
  assert.equal(ltCheckoutCommand('proceed with visa too'), '');
});

test('booking form parses name and email in any shape, and ignores chatter', () => {
  assert.deepEqual(ltParseBookingForm('Hussain Aparambil\nhussain@Example.com'), { name: 'Hussain Aparambil', email: 'hussain@example.com' });
  assert.deepEqual(ltParseBookingForm('Name: asha mary, Email: asha@mail.in'), { name: 'Asha Mary', email: 'asha@mail.in' });
  assert.deepEqual(ltParseBookingForm('ravi@x.co', { name: 'Ravi Kumar' }), { name: 'Ravi Kumar', email: 'ravi@x.co' });
  assert.deepEqual(ltParseBookingForm('thanks', {}), { name: '', email: '' });
  assert.deepEqual(ltParseBookingForm('ok'), { name: '', email: '' });
  assert.deepEqual(ltBookingFormMissing({ name: 'A B' }), ['email']);
});

test('booking-site link carries the fare and prefilled contact details', () => {
  const url = new URL(ltCheckoutUrl({ fareId: 'F 1', supplier: 'DUFFEL', checkoutBase: 'https://flypoomas.com/' }, 7,
    { passenger: { name: 'Hussain Aparambil', email: 'h@x.com' }, phone: '+971 50 000 0000', adults: 2 }));
  assert.equal(url.origin + url.pathname, 'https://flypoomas.com/book');
  assert.equal(url.searchParams.get('fareId'), 'F 1');
  assert.equal(url.searchParams.get('client'), '7');
  assert.equal(url.searchParams.get('first_name'), 'Hussain');
  assert.equal(url.searchParams.get('last_name'), 'Aparambil');
  assert.equal(url.searchParams.get('phone'), '+971500000000');
  assert.equal(url.searchParams.get('adults'), '2');
  const bare = new URL(ltCheckoutUrl({ fareId: 'F2' }, 7, { phone: '+97150' }));
  assert.equal(bare.searchParams.get('phone'), null, 'no contact details without the form');
});

test('flight details card', () => {
  const text = ltFlightDetailsText({ airline: 'Air India', flightNumber: 'AI 6509', origin: 'CCJ', destination: 'AUH', departureTime: '2026-11-17T20:00:00',
    arrivalTime: '2026-11-17T22:30:00', duration: 240, stops: 0, cabin: 'economy', baggage: { cabin: '7kg', checked: '30kg' }, seatsLeft: 2, total: 650, currency: 'AED' },
  { formatMoney: (n, c) => `${c} ${n}` });
  assert.match(text, /\*Air India AI 6509\* \(Non-stop\)/);
  assert.match(text, /Depart: CCJ · 17 Nov 2026 20:00/);
  assert.match(text, /Arrive: AUH · 17 Nov 2026 22:30/);
  assert.match(text, /Duration: 4h 0m/);
  assert.match(text, /Cabin 7kg · Check-in 30kg/);
  assert.match(text, /Only 2 seats left/);
  assert.match(text, /\*Total: AED 650\*/);
});
