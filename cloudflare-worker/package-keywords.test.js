// Package keywords: "Ladies only Georgia Trip details pls" must get the ladies-only Georgia trip,
// not the regular GEORGIA TRIP (the bug in the report).
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { taPackageKeywords, taPackagesByKeyword } from './travel-itinerary.js';
import { engineHandleTravelPackage } from './worker.js';

const pkgs=[
  {Id:1,name:'GEORGIA TRIP',destination:'Tbilisi Gudauri Kazbegi',nights:3,currency:'AED',sell_price:1200},
  {Id:2,name:'GEORGIA SPECIAL',keywords:'ladies only, women only, girls trip',destination:'Tbilisi',nights:4,currency:'AED',sell_price:1500},
  {Id:3,name:'AZERBAIJAN SPECIAL',keywords:'ladies only',destination:'Baku',nights:3,currency:'AED',sell_price:1100},
  {Id:4,name:'Bali Escape',keywords:'trip, package',destination:'Bali',nights:5,currency:'AED',sell_price:2500},
];

describe('keywords', ()=>{
  test('parsed per phrase; generic-only phrases ignored', ()=>{
    assert.deepEqual(taPackageKeywords(pkgs[1]), [['ladies','only'],['women','only'],['girls','trip']]);
    assert.deepEqual(taPackageKeywords(pkgs[3]), []);
  });
  test('a keyword wins; ties are settled by the package name in the message', ()=>{
    assert.deepEqual(taPackagesByKeyword(pkgs,'Ladies only Georgia Trip details pls').map(p=>p.Id), [2]);
    assert.deepEqual(taPackagesByKeyword(pkgs,'any women only tours?').map(p=>p.Id), [2]);
    assert.deepEqual(taPackagesByKeyword(pkgs,'ladies only trips').map(p=>p.Id), [2,3], 'both ladies-only trips');
    assert.deepEqual(taPackagesByKeyword(pkgs,'Georgia trip details'), [], 'no keyword → normal matching');
    assert.deepEqual(taPackagesByKeyword(pkgs,'only ladies azerbaijan').map(p=>p.Id), [3], 'word order does not matter');
  });
});

describe('bot', ()=>{
  const realFetch=globalThis.fetch;
  afterEach(()=>{ globalThis.fetch=realFetch; });
  const client={industry:'travel',client_name:'Tripcode',ta_table_ids:JSON.stringify({packages:'tpk'}),chatwoot_base:'https://cw.test',chatwoot_account_id:'1',chatwoot_token:'x'};
  const env={NOCODB_BASE:'https://nc.test',NOCODB_TOKEN:'t'};
  const state={convId:55,stage:'new',activeHistory:[]};
  const stub=()=>{ globalThis.fetch=async(url)=>String(url).includes('/tables/tpk/')?Response.json({list:pkgs}):Response.json({id:1}); };

  test('"Ladies only Georgia Trip details pls" → the ladies-only Georgia trip', async()=>{
    stub();
    const r=await engineHandleTravelPackage(env,client,7,state,'Ladies only Georgia Trip details pls','text');
    assert.match(r.turn.text, /GEORGIA SPECIAL/);
    assert.doesNotMatch(r.turn.text, /GEORGIA TRIP/);
  });
  test('without the keyword the regular trip still comes back', async()=>{
    stub();
    const r=await engineHandleTravelPackage(env,client,7,state,'Georgia Trip details pls','text');
    assert.match(r.turn.text, /GEORGIA TRIP/);
  });
  test('a keyword shared by two packages lists both', async()=>{
    stub();
    const r=await engineHandleTravelPackage(env,client,7,state,'ladies only trips?','text');
    assert.match(r.turn.text, /we have 2/);
    const offered=await r.turn.deliver();
    assert.deepEqual(offered.map(o=>o.value), ['TPKG:2','TPKG:3']);
  });
});
