import { test } from 'node:test';
import assert from 'node:assert/strict';
import { travelStaleDue, travelStalePatch, travelStaleProcessClient, travelAutoFollowupOn, TS_STALE_DAYS } from './travel-status-auto.js';

const NOW=new Date('2026-11-06T02:00:00.000Z');
const daysAgo=d=>new Date(NOW.getTime()-d*864e5).toISOString();
const CLIENT={Id:7, industry:'travel', authentik_email:'Boss@x.com'};

test('only open statuses left alone for 2+ days are due', ()=>{
  const n=NOW.getTime();
  assert.equal(travelStaleDue({TravelStatus:'quote_sent', TravelStatusAt:daysAgo(2)}, n), true);
  assert.equal(travelStaleDue({TravelStatus:'payment_pending', TravelStatusAt:daysAgo(5)}, n), true);
  assert.equal(travelStaleDue({TravelStatus:'quote_sent', TravelStatusAt:daysAgo(1.5)}, n), false);
  assert.equal(travelStaleDue({TravelStatus:'follow_up_pending', TravelStatusAt:daysAgo(9)}, n), false);
  assert.equal(travelStaleDue({TravelStatus:'booking_closed', TravelStatusAt:daysAgo(9)}, n), false);
  assert.equal(travelStaleDue({TravelStatus:'quote_sent', TravelStatusAt:''}, n), false);
  assert.equal(TS_STALE_DAYS, 2);
});

test('the patch moves it to follow up today and keeps the history', ()=>{
  const p=travelStalePatch({Id:3, TravelStatus:'negotiating', TravelStatusLog:JSON.stringify([{at:'x', to:'negotiating'}])}, NOW);
  assert.equal(p.TravelStatus, 'follow_up_pending');
  assert.equal(p.TravelFollowUpAt, '2026-11-06');
  assert.equal(p.TravelStatusBy, 'auto');
  const log=JSON.parse(p.TravelStatusLog);
  assert.equal(log.length, 2);
  assert.deepEqual({by:log[0].by, from:log[0].from, to:log[0].to, fu:log[0].fu}, {by:'auto', from:'negotiating', to:'follow_up_pending', fu:'2026-11-06'});
});

test('a client run patches due leads, tells dashboards and emails each owner once', async()=>{
  const patched=[], mails=[], sent=[];
  const deps={
    listLeads:async()=>[
      {Id:1, Name:'Asha', Owner:'rita@x.com', TravelStatus:'quote_sent', TravelStatusAt:daysAgo(3)},
      {Id:2, Name:'Ravi', Owner:'rita@x.com', TravelStatus:'docs_pending', TravelStatusAt:daysAgo(4)},
      {Id:3, Name:'John', Owner:'', TravelStatus:'negotiating', TravelStatusAt:daysAgo(2)},
      {Id:4, Name:'Fresh', Owner:'rita@x.com', TravelStatus:'quote_sent', TravelStatusAt:daysAgo(1)},
    ],
    patch:async rows=>{ patched.push(...rows); },
    email:async(to, subject)=>{ mails.push([to, subject]); },
    broadcast:async(cid, msg)=>{ sent.push([cid, msg]); },
  };
  const out=await travelStaleProcessClient(CLIENT, deps, NOW);
  assert.equal(out.moved, 3);
  assert.deepEqual(patched.map(p=>p.Id), [1,2,3]);
  assert.deepEqual(sent[0][1].lead_ids, [1,2,3]);
  assert.equal(sent[0][1].type, 'lead_updated');
  assert.deepEqual(mails.map(m=>m[0]).sort(), ['boss@x.com', 'rita@x.com']);
  assert.match(mails.find(m=>m[0]==='rita@x.com')[1], /2 inquiries/);
});

test('off for non-travel accounts and when switched off', async()=>{
  assert.equal(travelAutoFollowupOn({industry:'ecom'}), false);
  assert.equal(travelAutoFollowupOn({industry:'travel', travel_auto_followup:'No'}), false);
  assert.equal(travelAutoFollowupOn({industry:'travel'}), true);
  let listed=false;
  const out=await travelStaleProcessClient({...CLIENT, travel_auto_followup:'No'}, {listLeads:async()=>{ listed=true; return []; }}, NOW);
  assert.equal(out.moved, 0); assert.equal(listed, false);
});
