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
  constructor(){this.db=new DatabaseSync(':memory:');this.db.exec(readFileSync(new URL('./migrations/0069_live_travel_agency.sql',import.meta.url),'utf8'));this.db.exec(readFileSync(new URL('./migrations/0070_live_travel_client_credentials.sql',import.meta.url),'utf8'));this.db.exec(readFileSync(new URL('./migrations/0074_live_travel_credentials_reapply.sql',import.meta.url),'utf8'));}
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

test('Live Travel authenticated D1 workflow remains tenant scoped and operational',async()=>{
  const DB=new D1Database(),env={DB,SESSION_SIGNING_KEY:'integration-secret',ALLOWED_ORIGINS:'https://app.leadvyne.com'},session=await token(env.SESSION_SIGNING_KEY);

  let r=await call(env,session,'/live-travel/bootstrap');
  assert.equal(r.status,200);
  assert.deepEqual(r.data.suppliers.map(s=>s.supplier),['serpapi','riya','tripjack','poomas']);
  assert.equal(r.data.suppliers.filter(s=>s.supplier!=='poomas').every(s=>s.credentials_configured===false),true);
  assert.equal(r.data.suppliers.find(s=>s.supplier==='poomas')?.credentials_configured,true);

  r=await call(env,session,'/live-travel/poomas/settings','PATCH',{enabled:true,api_base:'https://api.flypoomas.com',checkout_base:'https://flypoomas.com'});
  assert.equal(r.status,200);
  assert.equal(r.data.enabled,true);
  r=await call(env,session,'/live-travel/poomas/settings','PATCH',{api_base:'https://api.flypoomas.com',checkout_base:'https://checkout.flypoomas.com'});
  assert.equal(r.status,200);
  assert.equal(r.data.enabled,true,'editing POOMAS URLs must not silently disable live ticketing');

  r=await call(env,session,'/live-travel/suppliers','PATCH',{supplier:'tripjack',enabled:true,mode:'sandbox',markup_type:'percent',markup_value:5,priority:10,credentials:{api_key:'tenant-tripjack-key'},endpoints:{search:'https://sandbox.tripjack.test/search',revalidate:'https://sandbox.tripjack.test/revalidate'}});
  assert.equal(r.status,200);
  assert.equal(r.data.enabled,1);
  assert.equal(r.data.credentials_configured,true);
  assert.equal(JSON.stringify(r.data).includes('tenant-tripjack-key'),false);

  r=await call(env,session,'/live-travel/agents','POST',{name:'Dubai Master',agent_type:'master_agent',credit_limit:25000});
  assert.equal(r.status,200);
  const agentRef=r.data.agent_ref;

  r=await call(env,session,'/live-travel/wallet','POST',{agent_ref:agentRef,entry_type:'credit',amount:5000,currency:'AED'});
  assert.equal(r.status,200);
  assert.equal(r.data.balance,5000);

  const now=new Date().toISOString(),expires=new Date(Date.now()+600000).toISOString();
  const search=(await DB.prepare(`INSERT INTO live_travel_searches (client_id,search_ref,origin,destination,departure_date,status,created_at,expires_at) VALUES (7,'FS-TEST','DXB','DEL','2026-09-01','complete',?,?)`).bind(now,expires).run()).meta.last_row_id;
  const offer=(await DB.prepare(`INSERT INTO live_travel_offers (client_id,search_id,offer_ref,supplier,supplier_offer_id,bookable,currency,base_amount,tax_amount,markup_amount,total_amount,last_validated_at,expires_at,created_at) VALUES (7,?,'OF-TEST','tripjack','TJ-TEST',1,'AED',800,150,50,1000,?,?,?)`).bind(search,now,expires,now).run()).meta.last_row_id;

  r=await call(env,session,'/live-travel/quotes','POST',{offer_id:offer,customer_name:'Test Traveller',customer_phone:'+971500000000',service_fee:50});
  assert.equal(r.status,200);
  assert.equal(r.data.total_amount,1050);
  const quoteId=r.data.id;

  r=await call(env,session,'/live-travel/bookings','POST',{quote_id:quoteId,passengers:[{title:'Mr',first_name:'Test',last_name:'Traveller',passport_number:'P123'}]});
  assert.equal(r.status,200);
  assert.equal(r.data.balance_due,1050);
  const bookingId=r.data.id;

  r=await call(env,session,'/live-travel/passengers','POST',{booking_id:bookingId,passenger_type:'child',first_name:'Young',last_name:'Traveller'});
  assert.equal(r.status,200);
  assert.equal(r.data.passenger_type,'child');

  r=await call(env,session,'/live-travel/payments','POST',{booking_id:bookingId,amount:500,method:'bank_transfer'});
  assert.equal(r.status,200);
  assert.equal(r.data.booking.payment_status,'partial');
  assert.equal(r.data.booking.balance_due,550);

  r=await call(env,session,'/live-travel/commissions','POST',{booking_id:bookingId,agent_ref:agentRef,commission_type:'percent',commission_value:10});
  assert.equal(r.status,200);
  assert.equal(r.data.commission_amount,105);

  r=await call(env,session,'/live-travel/service-requests','POST',{booking_id:bookingId,request_type:'reissue',reason:'Date change requested'});
  assert.equal(r.status,200);
  assert.equal(r.data.status,'open');

  const otherTenant=await token(env.SESSION_SIGNING_KEY,8,'other@example.com');
  r=await call(env,otherTenant,`/live-travel/bookings?id=${bookingId}`);
  assert.equal(r.status,404);
});


test('POOMAS search rejects fares outside the exact requested route',async()=>{
  const DB=new D1Database(),env={DB,SESSION_SIGNING_KEY:'integration-secret',POOMAS_API_KEY:'test-key',ALLOWED_ORIGINS:'https://app.leadvyne.com'},session=await token(env.SESSION_SIGNING_KEY);
  let r=await call(env,session,'/live-travel/poomas/settings','PATCH',{enabled:true,api_base:'https://api.flypoomas.com',checkout_base:'https://flypoomas.com'});
  assert.equal(r.status,200);

  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(url)=>{
    assert.equal(String(url),'https://api.flypoomas.com/api/search');
    return new Response(JSON.stringify({fares:[
      {id:'wrong-mct',supplier:'DUFFEL',isBookable:true,origin:'CCJ',destination:'MCT',displayPrice:250},
      {id:'wrong-doh',supplier:'DUFFEL',isBookable:true,origin:'CCJ',destination:'DOH',displayPrice:250},
      {id:'exact-shj',supplier:'DUFFEL',isBookable:true,origin:'CCJ',destination:'SHJ',displayPrice:300}
    ]}),{status:200,headers:{'Content-Type':'application/json'}});
  };
  try{
    r=await call(env,session,'/live-travel/poomas/search','POST',{origin:'CCJ',destination:'SHJ',departureDate:'2026-09-15',adults:1});
  }finally{
    globalThis.fetch=originalFetch;
  }

  assert.equal(r.status,200);
  assert.equal(r.data.exactRouteOnly,true);
  assert.equal(r.data.rejectedRouteMismatches,2);
  assert.equal(r.data.offers.length,1);
  assert.equal(r.data.offers[0].itinerary[0].origin,'CCJ');
  assert.equal(r.data.offers[0].itinerary[0].destination,'SHJ');
});
