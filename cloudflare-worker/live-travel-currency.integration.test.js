import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from './worker.js';

class D1Statement {
  constructor(db,sql,args=[]){this.db=db;this.sql=sql;this.args=args;}
  bind(...args){return new D1Statement(this.db,this.sql,args);}
  async run(){const r=this.db.prepare(this.sql).run(...this.args);return {success:true,meta:{last_row_id:Number(r.lastInsertRowid),changes:r.changes}};}
  async first(){return this.db.prepare(this.sql).get(...this.args)||null;}
  async all(){return {results:this.db.prepare(this.sql).all(...this.args)};}
}
class D1Database {
  constructor(){this.db=new DatabaseSync(':memory:');this.db.exec(readFileSync(new URL('./migrations/0069_live_travel_agency.sql',import.meta.url),'utf8'));this.db.exec(readFileSync(new URL('./migrations/0070_live_travel_client_credentials.sql',import.meta.url),'utf8'));this.db.exec(readFileSync(new URL('./migrations/0074_live_travel_credentials_reapply.sql',import.meta.url),'utf8'));this.db.exec(readFileSync(new URL('./migrations/0080_live_travel_poomas.sql',import.meta.url),'utf8'));this.db.exec(readFileSync(new URL('./migrations/0108_live_travel_currency.sql',import.meta.url),'utf8'));}
  prepare(sql){return new D1Statement(this.db,sql);}
  async batch(statements){return Promise.all(statements.map(statement=>statement.run()));}
}
async function token(secret,cid=7,email='agent@example.com'){
  const body=btoa(JSON.stringify({cid:String(cid),email,exp:Math.floor(Date.now()/1000)+3600}));
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const sig=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(body));
  const encoded=btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  return `${body}.${encoded}`;
}
async function call(env,session,path,method='GET',body){
  const r=await worker.fetch(new Request(`https://worker.test${path}`,{method,headers:{Authorization:`Bearer ${session}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),env,{});
  return {status:r.status,data:await r.json()};
}

// Separate file (= separate process) from live-travel.integration.test.js: ltEnsureSchema runs once
// per process, and this test needs the runtime FX columns on its own fresh database.
test('Live Agency converts mixed-currency supplier fares to the agency currency and locks the rate',async()=>{
  const DB=new D1Database(),env={DB,SESSION_SIGNING_KEY:'integration-secret',POOMAS_API_KEY:'poomas-test-key'},session=await token(env.SESSION_SIGNING_KEY);
  const setRates=rates=>{DB.db.prepare(`INSERT INTO live_travel_fx_rates (base,rates_json,source,fetched_at) VALUES ('USD',?,'test',?) ON CONFLICT(base) DO UPDATE SET rates_json=excluded.rates_json,fetched_at=excluded.fetched_at`).run(JSON.stringify(rates),new Date().toISOString());};
  setRates({USD:1,INR:88,AED:3.6725,SAR:3.75,QAR:3.64});
  const realFetch=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,opts={})=>{
    calls.push(String(url));
    if(String(url).startsWith('https://sandbox.tripjack.test/search'))return new Response(JSON.stringify({offers:[{id:'TJ-INR',totalPrice:25000,taxes:5000,currency:'INR',airline_code:'6E'}]}));
    if(String(url)==='https://api.flypoomas.com/api/search')return new Response(JSON.stringify({fares:[{id:'PM-AED',isBookable:true,supplier:'DUFFEL',displayPrice:1100,totalFare:1100,currency:'AED',airline:'EK',origin:'DXB',destination:'DEL'}]}));
    throw new Error(`unexpected network call ${url}`);
  };
  try{
    let r=await call(env,session,'/live-travel/bootstrap');
    assert.equal(r.status,200);
    assert.equal(r.data.currency_settings.default_currency,'AED');
    assert.ok(r.data.supported_currencies.some(c=>c.code==='QAR'));

    r=await call(env,session,'/live-travel/currency-settings','PATCH',{default_currency:'XYZ'});
    assert.equal(r.status,400);
    r=await call(env,session,'/live-travel/currency-settings','PATCH',{default_currency:'AED',fx_buffer_pct:1.5,rounding:'auto'});
    assert.equal(r.status,200);
    assert.equal(r.data.settings.fx_buffer_pct,1.5);
    assert.ok(r.data.fx.rates.find(x=>x.currency==='INR').rate_to_default>0);

    r=await call(env,session,'/live-travel/suppliers','PATCH',{supplier:'tripjack',enabled:true,markup_type:'fixed',markup_value:20,priority:10,credentials:{api_key:'k'},endpoints:{search:'https://sandbox.tripjack.test/search'}});
    assert.equal(r.status,200);
    r=await call(env,session,'/live-travel/suppliers','PATCH',{supplier:'poomas',enabled:true,priority:20});
    assert.equal(r.status,200);

    // No currency sent → agency default.
    r=await call(env,session,'/live-travel/search','POST',{trip_type:'one_way',origin:'DXB',destination:'DEL',departure_date:'2026-11-01'});
    assert.equal(r.status,200,JSON.stringify(r.data));
    assert.equal(r.data.search.currency,'AED');
    assert.deepEqual(r.data.offers.map(o=>[o.supplier,o.currency,o.total_amount]),[['tripjack','AED',1079],['poomas','AED',1100]],
      'the INR fare (25,000) is converted and ranks as the cheaper option');
    const tj=r.data.offers[0];
    assert.equal(tj.supplier_currency,'INR');
    assert.equal(tj.supplier_total,25000);
    assert.equal(tj.fx_status,'converted');

    DB.db.prepare(`UPDATE live_travel_offers SET last_validated_at=? WHERE id=?`).run(new Date().toISOString(),tj.id);
    r=await call(env,session,'/live-travel/quotes','POST',{offer_id:tj.id,customer_name:'FX Traveller'});
    assert.equal(r.status,200);
    assert.equal(r.data.currency,'AED');
    assert.equal(r.data.supplier_currency,'INR');
    assert.equal(r.data.fx_rate,tj.fx_rate);
    const quoteId=r.data.id;

    // INR strengthens 10% — beyond the 1.5% buffer — booking must stop and ask.
    setRates({USD:1,INR:80,AED:3.6725,SAR:3.75,QAR:3.64});
    r=await call(env,session,'/live-travel/bookings','POST',{quote_id:quoteId,passengers:[{first_name:'FX',last_name:'Traveller'}]});
    assert.equal(r.status,409);
    assert.equal(r.data.code,'fx_drift');
    assert.equal(r.data.fx_drift_pct,10);
    r=await call(env,session,'/live-travel/bookings','POST',{quote_id:quoteId,confirm_fx_drift:true,passengers:[{first_name:'FX',last_name:'Traveller'}]});
    assert.equal(r.status,200);
    assert.equal(r.data.total_amount,1079,'booked at the quoted price');
    assert.equal(r.data.fx_rate,tj.fx_rate,'booking keeps the quote\'s locked rate');
    const bookingId=r.data.id;

    // A payment in INR is credited to the AED booking at today's rate.
    r=await call(env,session,'/live-travel/payments','POST',{booking_id:bookingId,amount:8000,currency:'INR'});
    assert.equal(r.status,200);
    assert.equal(r.data.booking.amount_paid,367.25);

    // Wallet stays in AED: an INR entry for this booking converts at the booking's locked rate.
    r=await call(env,session,'/live-travel/wallet','POST',{entry_type:'credit',amount:25000,currency:'INR',booking_id:bookingId});
    assert.equal(r.status,200);
    assert.equal(r.data.currency,'AED');
    assert.equal(r.data.amount,Math.round(25000*tj.fx_rate*100)/100);

    // Staff may show a search in another currency while overriding is allowed…
    r=await call(env,session,'/live-travel/search','POST',{trip_type:'one_way',origin:'DXB',destination:'DEL',departure_date:'2026-11-01',currency:'QAR'});
    assert.equal(r.data.search.currency,'QAR');
    assert.ok(r.data.offers.every(o=>o.currency==='QAR'));
    // …and not once the agency locks its currency.
    await call(env,session,'/live-travel/currency-settings','PATCH',{allow_currency_override:0});
    r=await call(env,session,'/live-travel/search','POST',{trip_type:'one_way',origin:'DXB',destination:'DEL',departure_date:'2026-11-01',currency:'QAR'});
    assert.equal(r.data.search.currency,'AED');
    assert.equal(calls.some(u=>/er-api|openexchangerates/.test(u)),false,'fresh stored rates mean no provider calls');
  }finally{globalThis.fetch=realFetch;}
});
