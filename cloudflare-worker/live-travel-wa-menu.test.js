import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ltMenuDefaults, ltMenuNormalize, ltMenuValidate, ltMenuSections, ltMenuMatch, ltMenuIsGreeting, ltMenuIsMenuRequest,
  ltMenuGreetingText, ltMenuDateRows, ltMenuRouteRows, ltMenuParsePax, ltCheckoutCommand, ltParseBookingForm, ltBookingFormMissing,
  ltCheckoutUrl, ltFlightDetailsText, ltPortalRows, LT_PORTAL_SOURCES, ltVisaContextLine } from './live-travel-wa-menu.js';

test('default menu normalizes to WhatsApp-safe rows grouped by section', () => {
  const menu = ltMenuNormalize({ ...ltMenuDefaults(), enabled: true });
  assert.deepEqual(ltMenuValidate(menu), []);
  const sections = ltMenuSections(menu);
  assert.deepEqual(sections.map(s => s.title), ['Book', 'Documents', 'My Trip', 'Help']);
  const rows = sections.flatMap(s => s.rows);
  assert.equal(rows.length, 10);
  for (const r of rows) { assert.ok(r.title.length <= 24, r.title); assert.ok((r.description || '').length <= 72); }
  assert.equal(rows[0].title, '✈️ Live Flights');
  // Other services are Travel Portal sections only — no hand-written Hotels/ask rows by default.
  const others = menu.items.filter(i => !['flight_search', 'my_bookings', 'handover'].includes(i.action));
  assert.ok(others.every(i => i.action === 'portal'));
  assert.deepEqual(others.map(i => i.source).sort(), Object.keys(LT_PORTAL_SOURCES).sort());
});

test('rows the agency cannot serve are hidden', () => {
  const menu = ltMenuNormalize({ ...ltMenuDefaults(), enabled: true });
  const counts = { packages: 3, visas: 1 };
  const available = i => i.action === 'flight_search' ? false : i.action === 'portal' ? (counts[i.source] || 0) > 0 : true;
  assert.deepEqual(ltMenuSections(menu, available).flatMap(s => s.rows.map(r => r.id)),
    ['TMENU:packages', 'TMENU:visas', 'TMENU:bookings', 'TMENU:agent'], 'no Live Flights without the API, no empty portal sections');
});

test('Travel Portal listings: only what can still be bought, with details', () => {
  const today = '2026-10-17';
  const pk = ltPortalRows('packages', [
    { Id: 1, name: 'Baku 4N/5D', type: 'Tour', destination: 'Baku', nights: 4, pax_min: 2, pax_max: 6, currency: 'AED', sell_price: 1999, inclusions: '["Flights","Hotel 4*"]', exclusions: 'Visa' },
    { Id: 2, name: '' },
  ], { today });
  assert.equal(pk.length, 1);
  assert.deepEqual([pk[0].id, pk[0].title, pk[0].description], ['1', 'Baku 4N/5D', 'Baku · 4N · from AED 1,999']);
  assert.match(pk[0].detail, /✅ \*Includes\*\n• Flights\n• Hotel 4\*/);
  // Only a Base Price entered (Sell Price saved as 0): quote it, as the dashboard card does.
  const basePk = ltPortalRows('packages', [{ Id: 3, name: 'Hyderabad Train', destination: 'Hyderabad', nights: 3, currency: 'INR', sell_price: 0, base_price: 11499 }], { today });
  assert.equal(basePk[0].description, 'Hyderabad · 3N · from INR 11,499');
  const umrah = ltPortalRows('umrah', [
    { Id: 1, name: 'Nov Umrah', departure_date: '2026-11-10', seats: 2, pilgrims: '["a","b"]' },
    { Id: 2, name: 'Old', departure_date: '2026-09-01', seats: 40 },
    { Id: 3, name: 'Dec Umrah', departure_date: '2026-12-05', seats: 40, pilgrims: '["a"]', price_per_pax: 2500, currency: 'SAR', makkah_hotel: 'Hilton', makkah_nights: 5 },
  ], { today });
  assert.deepEqual(umrah.map(r => r.title), ['Dec Umrah'], 'full and departed groups are not offered');
  assert.equal(umrah[0].description, 'Departs 5 Dec · 39 seats left · SAR 2,500');
  const visas = ltPortalRows('visas', [
    { Id: 5, visa_country: 'UAE', visa_type: 'Visit Visa', duration: '30 days', adult_price: 350, currency: 'AED', processing_time: '3 days', required_documents: 'Passport\nPhoto' },
    { Id: 6, visa_country: 'Oman', visa_type: 'Visit', status: 'inactive' },
  ], { today });
  assert.deepEqual(visas.map(v => v.title), ['UAE Visit Visa']);
  assert.match(visas[0].detail, /Documents needed\*\n• Passport\n• Photo/);
  const cars = ltPortalRows('cars', [{ Id: 1, name: 'Corolla', status: 'available', daily_rate: 120 }, { Id: 2, name: 'Patrol', status: 'maintenance' }, { Id: 3, name: 'Camry', status: 'available' }], { today, outCarIds: new Set(['3']) });
  assert.deepEqual(cars.map(c => c.title), ['Corolla']);
  const fares = ltPortalRows('group_fares', [
    { Id: 1, sector: 'CCJ-DXB', airline: 'IX', flight_number: '343', departure_date: '2026-11-01', fare_price: 450, currency: 'AED', available_seats: 9, status: 'available' },
    { Id: 2, sector: 'COK-DXB', departure_date: '2026-11-01', available_seats: 0 },
    { Id: 3, sector: 'TRV-DXB', departure_date: '2026-11-01', status: 'sold_out' },
    { Id: 4, sector: 'CNN-DXB', departure_date: '2026-10-01' },
  ], { today });
  assert.deepEqual(fares.map(f => f.title), ['CCJ-DXB 1 Nov']);
  assert.equal(fares[0].description, 'IX 343 · AED 450 · 9 seats');
  const special = ltPortalRows('special_fares', [{ Id: 1, from_city: 'Dubai', to_city: 'Kochi', departure_date: '2026-11-01', fare_valid_until: '2026-10-01' }], { today });
  assert.equal(special.length, 0, 'an expired offer is not shown');
  assert.equal(ltPortalRows('attestation', [{ id: 9, name: 'Degree certificate', country: 'UAE', fee: 2500, currency: 'INR' }], { today })[0].description, 'UAE · INR 2,500');
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
  assert.equal(ltMenuMatch(menu, 'TMENU:visas').id, 'visas');
  assert.equal(ltMenuMatch(menu, '🛂 Visa Services').id, 'visas');
  assert.equal(ltMenuMatch(menu, 'visa services').id, 'visas');
  const off = ltMenuNormalize({ ...menu, items: menu.items.map(i => i.id === 'cars' ? { ...i, enabled: false } : i) });
  assert.equal(ltMenuMatch(off, 'TMENU:cars'), null, 'a switched-off row never runs');
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
  assert.deepEqual(ltMenuParsePax('Adult 1'), { adults: 1, children: 0, infants: 0 });
  assert.deepEqual(ltMenuParsePax('CCJ to AUH\n17-11-2026\nAdult 1'), { adults: 1, children: 0, infants: 0 }, 'the year is not a passenger count');
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
  const hidden = ltFlightDetailsText({ airline: 'Air India', total: 650, currency: 'AED' }, { formatMoney: (n, c) => `${c} ${n}`, showFare: false });
  assert.doesNotMatch(hidden, /AED/);
  assert.match(hidden, /Fare: shown at checkout/);
});

test('visa packages show their Services Included, not included and notes', () => {
  const oman = { Id: 7, visa_country: 'Oman', visa_type: 'single_entry', duration: '30_days', adult_price: 350, child_price: 300, currency: 'AED',
    visa_validity: '30 days from entry', processing_time: '2-3 working days',
    services_included: JSON.stringify([{ item: 'Transportation', detail: 'Dubai ⇄ Oman border, AC bus' }, { item: 'Hotel Stay', detail: '1 night 3★' },
      { item: 'Meals', detail: 'Breakfast' }, { item: 'Border Fees', detail: '' }, { item: 'Khasab city tour', detail: '' }]),
    not_included: 'Flight tickets\nPersonal expenses', required_documents: 'Passport copy\nPhoto', notes: 'Same-day border crossing' };
  const [row] = ltPortalRows('visas', [oman]);
  assert.equal(row.title, 'Oman Single Entry Visa');
  assert.equal(row.description, '30 days · AED 350 · 5 services incl.');
  assert.match(row.detail, /📅 Stay: 30 days\n⏳ Validity: 30 days from entry/);
  assert.match(row.detail, /✅ \*Services included\*\n🚌 Transportation: Dubai ⇄ Oman border, AC bus\n🏨 Hotel Stay: 1 night 3★\n🍽️ Meals: Breakfast\n🛃 Border Fees\n✅ Khasab city tour/);
  assert.match(row.detail, /❌ \*Not included\*\n• Flight tickets\n• Personal expenses/);
  assert.match(row.detail, /Same-day border crossing/);
  const line = ltVisaContextLine(oman);
  assert.match(line, /^- Oman Single Entry visa — stay 30 days — validity 30 days from entry/);
  assert.match(line, /includes: Transportation \(Dubai ⇄ Oman border, AC bus\), Hotel Stay \(1 night 3★\), Meals \(Breakfast\), Border Fees, Khasab city tour/);
  assert.match(line, /not included: Flight tickets, Personal expenses/);
  // an older visa with no services keeps its old layout
  assert.doesNotMatch(ltPortalRows('visas', [{ Id: 8, visa_country: 'UAE', adult_price: 100 }])[0].detail, /Services included/);
});
