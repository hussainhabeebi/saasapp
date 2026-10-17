// WhatsApp menu → guided flight search on the live API → flight details → Proceed → booking form →
// booking-site link, end to end on an in-memory D1 with POOMAS, Meta and Chatwoot stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, { engineHandleTravelMenu, engineHandleLiveTicketingChat, engineHandleLiveTicketCheckoutChat } from './worker.js';
import { ltMenuDateRows } from './live-travel-wa-menu.js';

class D1Statement {
  constructor(db,sql,args=[]){this.db=db;this.sql=sql;this.args=args;}
  bind(...args){return new D1Statement(this.db,this.sql,args);}
  async run(){const r=this.db.prepare(this.sql).run(...this.args);return {success:true,meta:{last_row_id:Number(r.lastInsertRowid),changes:r.changes}};}
  async first(){return this.db.prepare(this.sql).get(...this.args)||null;}
  async all(){return {results:this.db.prepare(this.sql).all(...this.args)};}
}
class D1Database {
  constructor(){this.db=new DatabaseSync(':memory:');for(const f of ['0069_live_travel_agency','0070_live_travel_client_credentials','0074_live_travel_credentials_reapply','0080_live_travel_poomas'])this.db.exec(readFileSync(new URL(`./migrations/${f}.sql`,import.meta.url),'utf8'));}
  prepare(sql){return new D1Statement(this.db,sql);}
  async batch(statements){return Promise.all(statements.map(statement=>statement.run()));}
}
async function token(secret,cid=7,email='agent@example.com'){
  const body=btoa(JSON.stringify({cid:String(cid),email,exp:Math.floor(Date.now()/1000)+3600}));
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const sig=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(body));
  return `${body}.${btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}`;
}
async function call(env,session,path,method='GET',body){
  const r=await worker.fetch(new Request(`https://worker.test${path}`,{method,headers:{Authorization:`Bearer ${session}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),env,{});
  return {status:r.status,data:await r.json()};
}

test('WhatsApp menu: settings API, menu taps and the full flight booking flow',async()=>{
  const DB=new D1Database(),env={DB,SESSION_SIGNING_KEY:'integration-secret',POOMAS_API_KEY:'poomas-test-key'},session=await token(env.SESSION_SIGNING_KEY);
  const realFetch=globalThis.fetch,meta=[],chatwoot=[],poomas=[];
  const day=ltMenuDateRows()[2];
  globalThis.fetch=async(url,opts={})=>{
    const u=String(url);
    if(u==='https://api.flypoomas.com/api/search'){
      poomas.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({fares:[
        {id:'FARE-1',isBookable:true,supplier:'DUFFEL',displayPrice:650,totalFare:650,currency:'AED',airline:'AI',airlineName:'Air India',flightNumber:'AI 6509',origin:'SHJ',destination:'CCJ',departureTime:`${day.value}T20:00:00`,arrivalTime:`${day.value}T23:59:00`,duration:240,stops:0,baggage:{cabin:'7kg',checked:'30kg'},seatsLeft:4},
        {id:'FARE-2',isBookable:true,supplier:'DUFFEL',displayPrice:720,totalFare:720,currency:'AED',airline:'G9',airlineName:'Air Arabia',flightNumber:'G9 452',origin:'SHJ',destination:'CCJ',departureTime:`${day.value}T09:00:00`,arrivalTime:`${day.value}T14:30:00`,duration:240,stops:0},
      ]}));
    }
    if(u.startsWith('https://graph.facebook.com/')){meta.push(JSON.parse(opts.body));return new Response('{}');}
    if(u.startsWith('https://cw.test/')){
      const fd=opts.body;chatwoot.push({content:fd.get?.('content'),items:fd.get?.('content_attributes')?JSON.parse(fd.get('content_attributes')).items:null});
      return new Response('{"id":1}');
    }
    return new Response('{}',{status:404});
  };
  try{
    // ── Settings API ──
    let r=await call(env,session,'/live-travel/whatsapp-menu');
    assert.equal(r.status,200);
    assert.equal(r.data.menu.enabled,false,'off until the agency turns it on');
    assert.ok(r.data.categories.includes('Visa'));
    const tooMany={...r.data.menu,enabled:true,items:Array.from({length:11},(_,i)=>({title:`Opt ${i}`}))};
    assert.equal((await call(env,session,'/live-travel/whatsapp-menu','PUT',{menu:tooMany})).status,400);
    r=await call(env,session,'/live-travel/whatsapp-menu','PUT',{menu:{...r.data.menu,enabled:true,popular_routes:[['SHJ','CCJ']]}});
    assert.equal(r.status,200,JSON.stringify(r.data));
    assert.equal(r.data.menu.enabled,true);
    assert.equal((await call(env,session,'/live-travel/suppliers','PATCH',{supplier:'poomas',enabled:true,priority:10})).status,200);

    const c={Id:7,industry:'travel',client_name:'Al Noor Travels',language:'en',chatwoot_base:'https://cw.test',chatwoot_account_id:'1',chatwoot_token:'cw',wa_phone_id:'PHONE',wa_token:'TOKEN'};
    const phone='+971500000001',state={convId:'55',stage:'new',name:'Hussain Aparambil',leadId:'91'};

    // Other agencies / ordinary messages are untouched.
    assert.equal(await engineHandleTravelMenu(env,{...c,Id:8},8,state,phone,'','hi','text',true),null);
    assert.equal(await engineHandleTravelMenu(env,c,7,state,phone,'','what is the baggage on air india?','text',false),null);

    // ── "hi" → the menu as a WhatsApp list ──
    let turn=await engineHandleTravelMenu(env,c,7,state,phone,'','hi','text',true);
    assert.match(turn.turn.text,/Hi Hussain, welcome to \*Al Noor Travels\*/);
    const offered=await turn.turn.deliver();
    const list=meta.pop();
    assert.equal(list.interactive.type,'list');
    assert.equal(list.interactive.action.button,'Menu');
    assert.deepEqual(list.interactive.action.sections.map(s=>s.title),['Book','Documents','My Trip','Help']);
    assert.ok(offered.some(o=>o.title==='🛂 Visa Services'&&o.value==='TMENU:visa'),'options are kept for the tap resolution');

    // ── Visa: the agency's question, filed under Visa ──
    turn=await engineHandleTravelMenu(env,c,7,state,phone,'','TMENU:visa','text',false);
    assert.match(turn.turn.text,/Which country is the visa for/);
    assert.equal(turn.turn.serviceCategory,'Visa');
    assert.equal(turn.turn.historyUserText,'🛂 Visa Services');
    assert.deepEqual(turn.turn.buttons.map(b=>b.value),['menu','talk to agent']);
    // ── Talk to an Agent → the normal handover ──
    turn=await engineHandleTravelMenu(env,c,7,state,phone,'','👤 Talk to an Agent','text',false);
    assert.equal(turn.introAction.intent,'WANTS_HUMAN');
    // ── My Bookings with none on file ──
    turn=await engineHandleTravelMenu(env,c,7,state,phone,'','TMENU:bookings','text',false);
    assert.match(turn.turn.text,/couldn't find a booking/);

    // ── Flights: route picker (agency pinned route offered) ──
    turn=await engineHandleTravelMenu(env,c,7,state,phone,'','✈️ Flight Tickets','text',false);
    assert.equal(turn.turn.serviceCategory,'Air Ticket');
    assert.match(turn.turn.text,/Where are you flying from and to/);
    const routes=await turn.turn.deliver();
    assert.deepEqual(routes,[{title:'SHJ → CCJ',value:'SHJ to CCJ'}]);
    assert.deepEqual(chatwoot.pop().items.map(i=>i.title),['SHJ → CCJ'],'one route → a reply button through Chatwoot');

    // Route → date picker
    let step=await engineHandleLiveTicketingChat(env,c,7,'SHJ to CCJ',[],phone);
    assert.match(step.reply,/When are you flying \*SHJ → CCJ\*/);
    assert.equal(step.buttons.length,9);
    assert.equal(step.picker.button,'Choose date');
    // The tapped date comes back as its title → passengers
    step=await engineHandleLiveTicketingChat(env,c,7,day.title,[],phone);
    assert.match(step.reply,/How many passengers/);
    assert.deepEqual(step.buttons.map(b=>b.title),['1 Adult','2 Adults','3 Adults']);
    assert.equal(poomas.length,0,'no search until the passengers are known');
    // Passengers → live search on the connected API
    step=await engineHandleLiveTicketingChat(env,c,7,'2 Adults',[],phone);
    assert.equal(poomas.length,1);
    assert.match(step.reply,/Option 1: Air India AI 6509/);
    assert.deepEqual(step.buttons.map(b=>b.title),['Book Option 1','Book Option 2']);

    // ── Pick → full flight details, no booking link yet ──
    let co=await engineHandleLiveTicketCheckoutChat(env,c,7,'55',phone,'Book Option 1','text','','91');
    assert.equal(co.step,'confirm');
    let msg=chatwoot.pop();
    assert.match(msg.content,/Flight details/);
    assert.match(msg.content,/Depart: SHJ/);
    assert.match(msg.content,/Total: AED 650/);
    assert.deepEqual(msg.items.map(i=>i.title),['✅ Proceed to Book','🔁 Other Flights','🆕 New Search']);
    assert.equal(meta.length,0,'the booking site is only offered after Proceed');

    // ── Proceed → booking form ──
    co=await engineHandleLiveTicketCheckoutChat(env,c,7,'55',phone,'✅ Proceed to Book','text','','91');
    msg=chatwoot.pop();
    assert.match(msg.content,/Booking form/);
    assert.match(msg.content,/other 1 passenger/);
    // A question mid-form goes back to the normal reply path
    assert.equal(await engineHandleLiveTicketCheckoutChat(env,c,7,'55',phone,'is baggage included?','text','','91'),null);
    // Name first, then email
    await engineHandleLiveTicketCheckoutChat(env,c,7,'55',phone,'Hussain Aparambil','text','','91');
    assert.match(chatwoot.pop().content,/email address/);
    co=await engineHandleLiveTicketCheckoutChat(env,c,7,'55',phone,'hussain@example.com','text','','91');
    assert.equal(co.step,'checkout_ready');

    // ── Booking site button, prefilled ──
    const cta=meta.pop();
    assert.equal(cta.interactive.type,'cta_url');
    assert.equal(cta.interactive.action.parameters.display_text,'Complete Booking');
    assert.match(cta.interactive.body.text,/Thanks Hussain/);
    const url=new URL(cta.interactive.action.parameters.url);
    assert.equal(url.searchParams.get('fareId'),'FARE-1');
    assert.equal(url.searchParams.get('first_name'),'Hussain');
    assert.equal(url.searchParams.get('email'),'hussain@example.com');
    assert.equal(url.searchParams.get('adults'),'2');
    // The completed form lands in Live Agency → Quotes for the team
    const quote=DB.db.prepare(`SELECT * FROM live_travel_quotes WHERE client_id=7`).get();
    assert.equal(quote.customer_name,'Hussain Aparambil');
    assert.equal(quote.customer_email,'hussain@example.com');
    assert.equal(quote.total_amount,650);
    assert.match(quote.notes,/WhatsApp booking form · Air India AI 6509 · SHJ → CCJ/);
    // "checkout" later resends the same link
    await engineHandleLiveTicketCheckoutChat(env,c,7,'55',phone,'checkout','text','','91');
    assert.equal(new URL(meta.pop().interactive.action.parameters.url).searchParams.get('email'),'hussain@example.com');

    // ── A visa tap after a half-finished flight search does not continue the flight draft ──
    await engineHandleTravelMenu(env,c,7,state,phone,'','TMENU:flights','text',false);
    await engineHandleTravelMenu(env,c,7,state,phone,'','TMENU:visa','text',false);
    assert.equal(DB.db.prepare(`SELECT COUNT(*) n FROM live_travel_chat_search_state WHERE client_id=7`).get().n,0);
  }finally{globalThis.fetch=realFetch;}
});
