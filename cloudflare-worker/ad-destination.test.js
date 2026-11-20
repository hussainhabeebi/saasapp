// Destination from an ad / poster (ad-destination.js + worker.js engineAdDestination /
// engineResolveLeadOwner): the lead is tagged with the destination it came in for and goes to the
// teammate who handles it.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { adDestinationCatalog, adDestinationOwnPlaces, adDestinationMatches, adDestinationDetect, adDestinationReferralTexts } from './ad-destination.js';
import { engineAdDestination, engineResolveLeadOwner } from './worker.js';

const CAT=adDestinationCatalog(['Munnar, Kerala', 'Georgia Ladies Only']);

describe('detection (pure)', ()=>{
  test('the ad headline names the place — whole words only', ()=>{
    assert.equal(adDestinationDetect({adTexts:['Goa 3N/4D from ₹9,999 — book now']}, CAT), 'Goa');
    assert.equal(adDestinationDetect({adTexts:['Score a goal this summer']}, CAT), '');
    assert.equal(adDestinationDetect({adTexts:['BALI honeymoon special']}, CAT), 'Bali');
  });

  test('a longer place wins over a part of it; origin cities are not destinations', ()=>{
    assert.deepEqual(adDestinationMatches('Kuala Lumpur & Langkawi', CAT).map(m=>m.label), ['Kuala Lumpur', 'Langkawi']);
    assert.equal(adDestinationDetect({adTexts:['Abu Dhabi city tour']}, CAT), 'Abu Dhabi');
    assert.equal(adDestinationDetect({adTexts:['Goa package from Kochi']}, CAT), 'Goa');
  });

  test("the agency's own place names come first and keep their spelling", ()=>{
    assert.equal(adDestinationDetect({adTexts:['Georgia ladies only trip — 6 days']}, CAT), 'Georgia Ladies Only');
    assert.equal(adDestinationDetect({adTexts:['munnar kerala tea gardens']}, CAT), 'Munnar, Kerala');
  });

  test('the ad first; a first message only when it names exactly one place', ()=>{
    assert.equal(adDestinationDetect({adTexts:['Dubai shopping festival'], firstText:'I want Bali'}, CAT), 'Dubai');
    assert.equal(adDestinationDetect({adTexts:['Summer offers'], firstText:'Hi, I want the Manali package details'}, CAT), 'Manali');
    assert.equal(adDestinationDetect({firstText:"I'm in Dubai, want a Kerala package"}, CAT), '');
    assert.equal(adDestinationDetect({firstText:'Hello'}, CAT), '');
  });

  test("the ad's link path and query count, its host does not", ()=>{
    const texts=adDestinationReferralTexts({source_url:'https://fb.me/offers/goa-honeymoon?utm_campaign=x', headline:'', body:'Limited seats'});
    assert.equal(adDestinationDetect({adTexts:texts}, CAT), 'Goa');
    assert.deepEqual(adDestinationReferralTexts(null), []);
  });

  test('own places: routing destinations, Lead Routing products and the flow list — no wildcards or routes', ()=>{
    const own=adDestinationOwnPlaces({}, {dsrRules:{'a@x.com':{packages:['Kashmir', '*'], resorts:['Wayanad'], flights:['Kochi - Dubai']}},
      routingRules:{'b@x.com':{products:['Andaman Special']}}, flowDestinations:[{name:'Baku'}, 'Almaty']});
    assert.deepEqual(own, ['Kashmir', 'Wayanad', 'Andaman Special', 'Baku', 'Almaty']);
  });
});

describe('the lead (worker)', ()=>{
  const OWNER='boss@acme.com', ANU='anu@acme.com', RAVI='ravi@acme.com', SAM='sam@acme.com';
  const AGENCY={Id:7, industry:'travel', authentik_email:OWNER, team_emails:`${ANU},${RAVI},${SAM}`,
    lead_routing:JSON.stringify({enabled:true, modes:['roundrobin'], rules:{[SAM]:{inPool:true}}}),
    dest_staff_routing:JSON.stringify({enabled:true, round_robin:false, rules:{
      [ANU]:{packages:['Goa', 'Kashmir'], resorts:['Munnar']}, [RAVI]:{packages:['Bali']}}})};
  const env={NOCODB_BASE:'http://nc.test', NOCODB_TOKEN:'t'};
  let realFetch, added;
  beforeEach(()=>{
    realFetch=globalThis.fetch; added=[];
    globalThis.fetch=async(url, opts={})=>{
      if(String(url).includes('/meta/tables/') && (opts.method||'GET')==='GET') return new Response(JSON.stringify({columns:[{title:'Name'}]}), {status:200});
      if(String(url).endsWith('/fields')){ added.push(JSON.parse(opts.body).title); return new Response('{}', {status:200}); }
      return new Response('{}', {status:200});
    };
  });
  afterEach(()=>{ globalThis.fetch=realFetch; });

  test('only for travel agencies', ()=>{
    assert.equal(engineAdDestination(AGENCY, {adTexts:['Goa offer']}), 'Goa');
    assert.equal(engineAdDestination({industry:'real_estate'}, {adTexts:['Goa villas']}), '');
  });

  test('a new lead from a Goa ad: Destination set and owned by the Goa teammate, ahead of round robin', async()=>{
    const body={};
    await engineResolveLeadOwner(env, AGENCY, 7, body, {phone:'1', adDestination:'Goa'}, true);
    assert.equal(body.Destination, 'Goa');
    assert.equal(body.Owner, ANU);
    assert.ok(added.includes('Destination'), 'the column is made first');
  });

  test('a resort location matches too; an unknown destination falls back to normal routing', async()=>{
    const munnar={};
    await engineResolveLeadOwner(env, AGENCY, 7, munnar, {phone:'1', adDestination:'Munnar'}, true);
    assert.equal(munnar.Owner, ANU);
    const dubai={};
    await engineResolveLeadOwner(env, AGENCY, 7, dubai, {phone:'1', adDestination:'Dubai'}, true);
    assert.equal(dubai.Destination, 'Dubai');
    assert.equal(dubai.Owner, SAM, 'round robin as before');
  });

  test('a lead that already has a destination or an owner is left alone', async()=>{
    const had={};
    await engineResolveLeadOwner(env, AGENCY, 7, had, {phone:'1', adDestination:'Bali', lead:{Destination:'Kashmir', Owner:ANU}}, false);
    assert.equal(had.Destination, undefined);
    assert.equal(had.Owner, undefined);
    const owned={};
    await engineResolveLeadOwner(env, AGENCY, 7, owned, {phone:'1', adDestination:'Bali', lead:{Owner:ANU}}, false);
    assert.equal(owned.Destination, 'Bali', 'tagged');
    assert.equal(owned.Owner, undefined, 'not taken away from its owner');
  });

  test('routing switched off: tagged, owner from Lead Routing as before', async()=>{
    const off={...AGENCY, dest_staff_routing:JSON.stringify({enabled:false, rules:{[RAVI]:{packages:['Bali']}}})};
    const body={};
    await engineResolveLeadOwner(env, off, 7, body, {phone:'1', adDestination:'Bali'}, true);
    assert.equal(body.Destination, 'Bali');
    assert.equal(body.Owner, SAM);
  });
});
