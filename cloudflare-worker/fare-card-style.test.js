// Settings → Travel Settings → Fare card style: "Highlighted" labels the options, uses a compact
// layout and shows (+1) for next-day arrivals; "Classic" (the default) is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ltFormatChatOffers, ltChatFareTags, ltArrivalDayOffset, ltChatFarePrefs, ltTravelSettingsNormalize } from './worker.js';

const offer=(id,airline,flight,total,dep,arr,duration,baggage,seats)=>({supplier:'poomas',supplier_offer_id:id,bookable:true,airline_name:airline,flight_numbers:flight,total_amount:total,currency:'INR',cabin:'economy',seats_left:seats,baggage,
  itinerary:[{origin:'CCJ',destination:'AUH',departureTime:dep,arrivalTime:arr,duration,stops:0}]});
// The three flights from the agency's screenshot (CCJ → AUH, 10 Nov 2026).
const offers=[
  offer('F1','AI Express','359',17365,'2026-11-10T20:00:00','2026-11-10T22:30:00',240,{cabin:'7 kg',checked:'30 kg'},1),
  offer('F2','Air Arabia Abu Dhabi','201',17791,'2026-11-10T05:20:00','2026-11-10T07:50:00',240,{cabin:'7 Kg + Personal Item (Max 3Kg)',checked:'Paid Baggage as per airlines policy'},9),
  offer('F3','IndiGo','1435',17865,'2026-11-10T21:45:00','2026-11-11T00:25:00',250,{cabin:'7 kg',checked:'30 kg'},2),
];

test('Classic (the default) is exactly the existing message',()=>{
  const classic=ltFormatChatOffers(offers,{limit:3,filterHint:true});
  assert.equal(ltFormatChatOffers(offers,{limit:3,filterHint:true,style:'classic'}),classic);
  assert.match(classic,/\*Option 1: AI Express 359\* \(Direct\)\nDeparts 20:00, arrives 22:30 · 4h 0m\nBaggage: Cabin 7 kg · Check-in 30 kg\nFare: \*INR 17,365\* · only 1 seat left/);
  assert.match(classic,/Departs 21:45, arrives 00:25 · 4h 10m/,'no (+1) in classic');
  assert.doesNotMatch(classic,/Cheapest|Fastest|🔥/);
  assert.equal(ltChatFarePrefs({}).style,'classic');
  assert.equal(ltTravelSettingsNormalize({lt_fare_style:'bogus'}).lt_fare_style,'classic');
  assert.equal(ltTravelSettingsNormalize({lt_fare_style:'highlighted'}).lt_fare_style,'highlighted');
});

test('Highlighted: labels, compact cards, +1 day',()=>{
  const text=ltFormatChatOffers(offers,{limit:3,filterHint:true,style:'highlighted'});
  assert.ok(text.includes('*Option 1 · AI Express 359*\n💰 Cheapest · ⚡ Fastest\n🕗 20:00 → 22:30 · 4h 0m · Direct\n🧳 Cabin 7 kg · Check-in 30 kg\n💳 *INR 17,365* · 🔥 Only 1 seat left'),text);
  // Same 4h duration as Option 1: a tie for fastest labels both.
  assert.ok(text.includes('*Option 2 · Air Arabia Abu Dhabi 201*\n⚡ Fastest\n🕗 05:20 → 07:50 · 4h 0m · Direct'),text);
  assert.ok(text.includes('💳 *INR 17,791* · 9 seats left'),text);
  assert.ok(text.includes('*Option 3 · IndiGo 1435*\n🕗 21:45 → 00:25 (+1) · 4h 10m · Direct'),text);
  assert.ok(text.includes('💳 *INR 17,865* · 🔥 Only 2 seats left'),text);
  // Header and footer stay the same as Classic.
  assert.match(text,/^✈️ I found 3 flights from CCJ to AUH on 10 Nov 2026 \(economy\)\./);
  assert.match(text,/Tap the option you'd like to book below\./);
});

test('labels only when they tell options apart; hidden prices never get a cheapest label',()=>{
  assert.deepEqual(ltChatFareTags([offers[0]]),[[]],'a single option gets no label');
  const tie=[offers[0],{...offers[1],total_amount:17365}];
  assert.deepEqual(ltChatFareTags(tie),[[],[]],'equal fares and durations: no label');
  assert.deepEqual(ltChatFareTags(offers,false),[['⚡ Fastest'],['⚡ Fastest'],[]]);
  const hidden=ltFormatChatOffers(offers,{limit:3,showFares:false,style:'highlighted'});
  assert.doesNotMatch(hidden,/Cheapest|INR/);
  assert.match(hidden,/🔥 Only 1 seat left/);
});

test('next-day arrival offset',()=>{
  assert.equal(ltArrivalDayOffset('2026-11-10T21:45:00','2026-11-11T00:25:00'),1);
  assert.equal(ltArrivalDayOffset('2026-11-10T20:00:00','2026-11-10T22:30:00'),0);
  assert.equal(ltArrivalDayOffset('2026-11-10T23:00:00','2026-11-12T06:00:00'),2);
  assert.equal(ltArrivalDayOffset('','2026-11-12T06:00:00'),0);
});
