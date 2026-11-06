// Settings → Travel Settings → Fare card style "Nanthana": a trip summary, then each flight as a
// FLIGHT DETAILS block between divider lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ltFormatChatOffers, ltTravelSettingsNormalize, LT_FARE_STYLES, ltAirportCityName, ltOfferRefundable } from './worker.js';

const offer=(id,airline,code,flight,dep,arr,baggage,refundable)=>({supplier:'poomas',supplier_offer_id:id,bookable:true,airline_name:airline,airline_code:code,flight_numbers:flight,total_amount:15000,currency:'INR',cabin:'economy',baggage,raw:{refundable},
  itinerary:[{origin:'TRZ',destination:'SIN',departureTime:dep,arrivalTime:arr,duration:270,stops:0}]});
const offers=[
  offer('F1','Air India Express','IX','IX 660','2026-11-11T16:25:00','2026-11-11T23:25:00',{checked:'30Kg'},true),
  offer('F2','IndiGo','6E','1007','2026-11-11T18:50:00','2026-11-12T01:45:00',{},'Yes'),
];

test('Nanthana is a saved fare style', () => {
  assert.ok(LT_FARE_STYLES.includes('nanthana'));
  assert.equal(ltTravelSettingsNormalize({ lt_fare_style: 'Nanthana' }).lt_fare_style, 'nanthana');
});

test('Nanthana layout: trip summary, then a FLIGHT DETAILS block per flight', () => {
  const text = ltFormatChatOffers(offers, { style: 'nanthana', pax: { adults: 1 }, tripType: 'one_way', limit: 3 });
  assert.match(text, /^📍 \*Route:\* TRZ → SIN\n🛫 \*Journey Type:\* One-way\n👤 \*Passengers:\* 1 Adult\n💺 \*Class:\* Economy\n\n-{30}\n\n✈️ \*FLIGHT DETAILS — OPTION 1\*\n\n✈️ Air India Express IX 660\n\n🛫 \*From:\* Trichy \(TRZ\)\n2026-11-11 04:25 PM\n🛬 \*To:\* Singapore \(SIN\)\n2026-11-11 11:25 PM\n/);
  assert.doesNotMatch(text, /IX IX/);
  assert.match(text, /🛄 \*Check-in Baggage:\* 30Kg\n💰 \*Refundable:\* Yes\n💳 \*Fare:\* INR 15,000/);
  assert.match(text, /✈️ IndiGo 6E 1007[\s\S]*2026-11-12 01:45 AM \[Next Day\]\n[\s\S]*🛄 \*Baggage:\* To be confirmed\./);
  assert.doesNotMatch(ltFormatChatOffers(offers, { style: 'nanthana', showFares: false }), /💳/);
  assert.match(ltFormatChatOffers(offers, { style: 'nanthana', pax: { adults: 2, children: 1 }, tripType: 'round_trip' }), /Round-trip\n👤 \*Passengers:\* 2 Adults, 1 Child/);
});

test('city names and refundable come only from what is known', () => {
  assert.equal(ltAirportCityName('AUH'), 'Abu Dhabi');
  assert.equal(ltAirportCityName('ZZZ'), '');
  assert.equal(ltOfferRefundable({ raw: {} }), null);
  assert.equal(ltOfferRefundable({ fare_rules: { refundable: false } }), false);
  assert.doesNotMatch(ltFormatChatOffers([{ ...offers[0], raw: {} }], { style: 'nanthana' }), /Refundable/);
});

test('a fare reply longer than WhatsApp\'s 1024-character button limit is split, never rejected', async () => {
  const { engineSplitInteractiveBody, WA_INTERACTIVE_BODY_MAX } = await import('./worker.js');
  const many = [1, 2, 3, 4, 5].map(i => ({ ...offers[0], supplier_offer_id: 'F' + i, total_amount: 15000 + i }));
  const text = ltFormatChatOffers(many, { style: 'nanthana', limit: 5, pax: { adults: 1 }, filterHint: true });
  assert.ok(text.length > WA_INTERACTIVE_BODY_MAX);
  const { lead, body } = engineSplitInteractiveBody(text);
  assert.ok(body.length <= WA_INTERACTIVE_BODY_MAX);
  assert.match(body, /Tap the option you'd like to book below/);
  assert.ok(lead.every(p => p.length <= 4096));
  // Nothing is lost: every flight block still goes out.
  assert.equal([...lead, body].join('\n\n'), text);
  assert.deepEqual(engineSplitInteractiveBody('short'), { lead: [], body: 'short' });
  assert.equal(engineSplitInteractiveBody('x'.repeat(1500)).body, 'Please choose an option below 👇');
});
