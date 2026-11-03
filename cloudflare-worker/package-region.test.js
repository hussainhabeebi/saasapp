// International / Domestic packages: the Region field (or the word in a package's name), the
// typed "international tour" ask, packages sharing one name, and WhatsApp rows told apart.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { taPackageRegion, taPackageRegionCounts, taRegionInText, taPackagesNamedInText, taPackageListRows } from './travel-itinerary.js';
import { ltPortalRows } from './live-travel-wa-menu.js';
import { engineHandleTravelPackage } from './worker.js';

// Like the agency in the bug report: packages named by kind, told apart only by destination.
const pkgs=[
  {Id:1,name:'INTERNATIONAL TOUR',destination:'Bali, Indonesia',nights:5,currency:'INR',sell_price:45000},
  {Id:2,name:'INTERNATIONAL TOUR',destination:'Dubai',nights:4,currency:'INR',sell_price:38000},
  {Id:3,name:'DOMESTIC TOUR',destination:'Munnar',nights:2,currency:'INR',sell_price:9000},
  {Id:4,name:'Kashmir Delight',region:'domestic',destination:'Srinagar',nights:5,currency:'INR',sell_price:21000},
  {Id:5,name:'Thailand Explorer',region:'International',destination:'Bangkok',nights:4,currency:'INR',sell_price:32000},
  {Id:6,name:'Goa Weekend',destination:'Goa',nights:2,currency:'INR',sell_price:7000},
];

describe('region', ()=>{
  test('Region field first, else the word in name/type, else none', ()=>{
    assert.deepEqual(pkgs.map(taPackageRegion), ['international','international','domestic','domestic','international','']);
    assert.deepEqual(taPackageRegionCounts(pkgs), {international:3, domestic:2});
  });
  test('typed asks', ()=>{
    assert.equal(taRegionInText('INTERNATIONAL TOUR'), 'international');
    assert.equal(taRegionInText('do you have any domestic packages?'), 'domestic');
    assert.equal(taRegionInText('abroad trip'), 'international');
    assert.equal(taRegionInText('international'), 'international');
    assert.equal(taRegionInText('international flights to dubai'), null, 'flights keep their own path');
    assert.equal(taRegionInText('is visa needed for international travel'), null);
    assert.equal(taRegionInText('i want to talk about something international and long winded'), null);
  });
  test('a shared name returns every package with it', ()=>{
    assert.deepEqual(taPackagesNamedInText(pkgs,'INTERNATIONAL TOUR').map(p=>p.Id), [1,2]);
    assert.deepEqual(taPackagesNamedInText(pkgs,'kashmir delight').map(p=>p.Id), [4]);
  });
  test('list rows are told apart by destination when names repeat', ()=>{
    const rows=taPackageListRows(pkgs.slice(0,3));
    assert.deepEqual(rows.map(r=>r.title), ['Bali · 5N','Dubai · 4N','DOMESTIC TOUR']);
    assert.equal(rows[0].value, 'TPKG:1');
    assert.match(rows[0].description, /^International · INTERNATIONAL TOUR · 5N\/6D · from /);
    const portal=ltPortalRows('packages', pkgs);
    assert.deepEqual(portal.slice(0,2).map(r=>r.title), ['Bali · 5N','Dubai · 4N']);
    assert.equal(portal[0].region, 'international');
    assert.match(portal[0].detail, /🌍 International/);
  });
});

describe('bot', ()=>{
  const realFetch=globalThis.fetch;
  afterEach(()=>{ globalThis.fetch=realFetch; });
  const client={industry:'travel',client_name:'Fly Indo',ta_table_ids:JSON.stringify({packages:'tpk'}),chatwoot_base:'https://cw.test',chatwoot_account_id:'1',chatwoot_token:'x'};
  const env={NOCODB_BASE:'https://nc.test',NOCODB_TOKEN:'t'};
  const sent=[];
  const stub=()=>{ sent.length=0; globalThis.fetch=async(url,opts={})=>{
    const u=String(url);
    if(u.includes('/tables/tpk/')) return Response.json({list:pkgs});
    if(u.includes('/messages')){ sent.push(opts.body?.get?Object.fromEntries(opts.body):JSON.parse(opts.body||'{}')); return Response.json({id:1}); }
    return Response.json({});
  }; };
  const state={convId:55,stage:'new',activeHistory:[]};

  test('"INTERNATIONAL TOUR" lists the international packages instead of handing over', async()=>{
    stub();
    const r=await engineHandleTravelPackage(env,client,7,state,'INTERNATIONAL TOUR','text');
    assert.match(r.turn.text, /🌍 \*International packages\* — we have 3/);
    assert.match(r.turn.text, /Bali · 5N/);
    assert.doesNotMatch(r.turn.text, /Munnar/);
    const offered=await r.turn.deliver();
    assert.deepEqual(offered.map(o=>o.value), ['TPKG:1','TPKG:2','TPKG:5']);
  });
  test('the Holiday Packages region buttons', async()=>{
    stub();
    let r=await engineHandleTravelPackage(env,client,7,state,'TPKGREG:domestic','text');
    assert.match(r.turn.text, /Domestic packages\* — we have 2/);
    r=await engineHandleTravelPackage(env,client,7,state,'TPKGREG:all','text');
    assert.match(r.turn.text, /we have 6/);
  });
  test('picking one from the list gives its details', async()=>{
    stub();
    const r=await engineHandleTravelPackage(env,client,7,state,'TPKG:1','text');
    assert.match(r.turn.text, /Bali/);
  });
  test('no packages of that kind says so and offers the other kind', async()=>{
    stub();
    const only=pkgs.filter(p=>taPackageRegion(p)==='international');
    globalThis.fetch=async(url)=>String(url).includes('/tables/tpk/')?Response.json({list:only}):Response.json({});
    const r=await engineHandleTravelPackage(env,client,7,state,'domestic packages','text');
    assert.match(r.turn.text, /don't have any \*domestic\* packages/);
    assert.deepEqual(r.turn.buttons.map(b=>b.value), ['TPKGREG:international','INTRO_HUMAN']);
  });
});
