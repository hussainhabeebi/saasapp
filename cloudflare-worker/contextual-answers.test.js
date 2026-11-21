// Travel Settings → Contextual answers: flight follow-ups about the package being discussed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ltContextualFlightQuestion, ltPackageFlightInclusion, ltPackageDestinationAirport, ltPackageInContext, ltContextualPackageFlightReply, ltTravelAgencyPromptBlock } from './worker.js';

const kashmir={Id:1,name:'KASHMIR TRIP',destination:'Kashmir',inclusions:'["Hotel stay","Shikara ride"]',exclusions:'["Air tickets"]'};
const bali={Id:2,name:'Bali Escape',destination:'Bali, Indonesia',inclusions:'["Return air tickets from Dubai","Hotel"]'};

test('flight follow-ups without a route are contextual; routes are normal searches',()=>{
  for(const t of ['Is it including flight ticket ?','flights?','what about air ticket','is flight included'])assert.equal(ltContextualFlightQuestion(t),true,t);
  for(const t of ['DXB to COK 20 Nov','Dubai to Kochi flight','hotel included?','my ticket status'])assert.equal(ltContextualFlightQuestion(t),false,t);
});

test('flight inclusion is read from the package lists',()=>{
  assert.equal(ltPackageFlightInclusion(kashmir).status,'excluded');
  assert.equal(ltPackageFlightInclusion(bali).status,'included');
  assert.equal(ltPackageFlightInclusion({inclusions:'Hotel, Airport transfers'}).status,'unknown','airport transfers are not flights');
  assert.equal(ltPackageFlightInclusion({inclusions:'["Hotel","Flights not included"]'}).status,'excluded');
});

test('package destination airport and the package in context',()=>{
  assert.equal(ltPackageDestinationAirport(kashmir),'SXR');
  assert.equal(ltPackageDestinationAirport(bali),'DPS');
  const history=[{role:'user',content:'bali packages'},{role:'assistant',content:'📄 Itinerary PDF — KASHMIR TRIP\n\nWould you like to book *KASHMIR TRIP*?'}];
  assert.equal(ltPackageInContext([kashmir,bali],history)?.name,'KASHMIR TRIP','newest mention wins');
  assert.equal(ltPackageInContext([kashmir,bali],[{role:'user',content:'hi'}]),null);
});

test('reply answers from the package, then asks only the departure city',()=>{
  const r=ltContextualPackageFlightReply(kashmir,'SXR');
  assert.match(r,/not included in \*KASHMIR TRIP\*/);
  assert.match(r,/Where will you be flying from\?/);
  assert.match(ltContextualPackageFlightReply(bali,'DPS'),/Yes — \*Bali Escape\* includes flights/);
});

test('AI prompt gets the contextual rule only when the setting is on',()=>{
  assert.match(ltTravelAgencyPromptBlock(true,true,true),/CONTEXTUAL ANSWERS/);
  assert.doesNotMatch(ltTravelAgencyPromptBlock(true,true,false),/CONTEXTUAL ANSWERS/);
});
