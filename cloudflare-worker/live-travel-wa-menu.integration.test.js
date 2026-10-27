// WhatsApp menu → guided flight search on the live API → flight details → Proceed → booking form →
// booking-site link, end to end on an in-memory D1 with POOMAS, Meta and Chatwoot stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, { engineHandleTravelMenu, engineHandleLiveTicketingChat, engineHandleLiveTicketCheckoutChat, ltChatFlightIntent, ltChatFlightAsk, ltTravelFlowOn } from './worker.js';
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
  const DB=new D1Database(),env={DB,SESSION_SIGNING_KEY:'integration-secret',POOMAS_API_KEY:'poomas-test-key',NOCODB_BASE:'https://nc.test',NOCODB_TOKEN:'nc'},session=await token(env.SESSION_SIGNING_KEY);
  DB.db.exec(`CREATE TABLE attest_services (id INTEGER PRIMARY KEY, client_id INTEGER, name TEXT, service_type TEXT, country TEXT, fee REAL, currency TEXT, turnaround_time TEXT, required_docs TEXT, status TEXT)`);
  // Travel Portal: this agency lists one package and one visa; its Umrah table is empty.
  const portal={tpk:[{Id:1,client_id:'7',name:'Baku 4N/5D',destination:'Baku',nights:4,currency:'AED',sell_price:1999,inclusions:'["Flights","Hotel"]'}],
    tvi:[{Id:5,client_id:'7',visa_country:'UAE',visa_type:'Visit Visa',duration:'30 days',adult_price:350,currency:'AED',processing_time:'3 days',required_documents:'Passport\nPhoto',status:'active'}],tum:[]};
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
    if(u.startsWith('https://nc.test/api/v2/tables/')){const t=u.split('/tables/')[1].split('/')[0];return portal[t]?new Response(JSON.stringify({list:portal[t]})):new Response('{}',{status:404});}
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
    assert.ok('packages' in r.data.portal_counts);
    const tooMany={...r.data.menu,enabled:true,items:Array.from({length:11},(_,i)=>({title:`Opt ${i}`}))};
    assert.equal((await call(env,session,'/live-travel/whatsapp-menu','PUT',{menu:tooMany})).status,400);
    r=await call(env,session,'/live-travel/whatsapp-menu','PUT',{menu:{...r.data.menu,enabled:true,popular_routes:[['SHJ','CCJ']]}});
    assert.equal(r.status,200,JSON.stringify(r.data));
    assert.equal(r.data.menu.enabled,true);
    assert.equal((await call(env,session,'/live-travel/suppliers','PATCH',{supplier:'poomas',enabled:true,priority:10})).status,200);

    const c={Id:7,travel_flow_enabled:'Yes',ta_table_ids:JSON.stringify({packages:'tpk',visas:'tvi',umrah_groups:'tum'}),industry:'travel',client_name:'Al Noor Travels',language:'en',chatwoot_base:'https://cw.test',chatwoot_account_id:'1',chatwoot_token:'cw',wa_phone_id:'PHONE',wa_token:'TOKEN'};
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
    // Only Live Flights (API connected) and the Travel Portal sections with listings are offered.
    assert.deepEqual(list.interactive.action.sections.map(s=>[s.title,s.rows.map(r=>r.title)]),[
      ['Book',['✈️ Live Flights','🏝️ Holiday Packages']],['Documents',['🛂 Visa Services']],['My Trip',['🎫 My Bookings']],['Help',['👤 Talk to an Agent']]]);
    assert.ok(offered.some(o=>o.title==='🛂 Visa Services'&&o.value==='TMENU:visas'),'options are kept for the tap resolution');

    // ── Visa Services: the visas listed in the Travel Portal ──
    turn=await engineHandleTravelMenu(env,c,7,state,phone,'','TMENU:visas','text',false);
    assert.equal(turn.turn.serviceCategory,'Visa');
    assert.equal(turn.turn.historyUserText,'🛂 Visa Services');
    assert.match(turn.turn.text,/We have 1 visa available/);
    assert.deepEqual(await turn.turn.deliver(),[{title:'UAE Visit Visa',value:'TPORTAL:visas:5'}]);
    const visaList=meta.pop();
    assert.equal(visaList.interactive.action.button,'View list');
    assert.deepEqual(visaList.interactive.action.sections[0].rows,[{id:'TPORTAL:visas:5',title:'UAE Visit Visa',description:'30 days · AED 350 · 3 days'}]);
    // Tap → the visa's details
    turn=await engineHandleTravelMenu(env,c,7,state,phone,'','TPORTAL:visas:5','text',false);
    assert.match(turn.turn.text,/🛂 \*UAE Visit Visa visa\*|🛂 \*UAE Visit Visa\*/);
    assert.match(turn.turn.text,/Documents needed\*\n• Passport\n• Photo/);
    assert.deepEqual(turn.turn.buttons.map(b=>b.value),['TENQUIRE:visas:5','menu','talk to agent']);
    // Enquire → a hot booking enquiry, filed under Visa
    turn=await engineHandleTravelMenu(env,c,7,state,phone,'','TENQUIRE:visas:5','text',false);
    assert.equal(turn.turn.intent,'BOOKING');
    assert.equal(turn.turn.serviceCategory,'Visa');
    assert.match(turn.turn.text,/UAE Visit Visa[\s\S]*travel date/);
    // A listing taken down since the list was sent
    turn=await engineHandleTravelMenu(env,c,7,state,phone,'','TPORTAL:visas:99','text',false);
    assert.match(turn.turn.text,/no longer available/);
    // Packages list
    turn=await engineHandleTravelMenu(env,c,7,state,phone,'','🏝️ Holiday Packages','text',false);
    assert.deepEqual(await turn.turn.deliver(),[{title:'Baku 4N/5D',value:'TPORTAL:packages:1'}]);
    assert.match(meta.pop().interactive.action.sections[0].rows[0].description,/Baku · 4N · from AED 1,999/);
    // Umrah has nothing listed → not offered; typed anyway → no fake list
    turn=await engineHandleTravelMenu(env,c,7,state,phone,'','TMENU:umrah','text',false);
    assert.match(turn.turn.text,/no umrah groups listed right now/i);
    // ── Talk to an Agent → the normal handover ──
    turn=await engineHandleTravelMenu(env,c,7,state,phone,'','👤 Talk to an Agent','text',false);
    assert.equal(turn.introAction.intent,'WANTS_HUMAN');
    // ── My Bookings with none on file ──
    turn=await engineHandleTravelMenu(env,c,7,state,phone,'','TMENU:bookings','text',false);
    assert.match(turn.turn.text,/couldn't find a booking/);

    // ── Flights: route picker (agency pinned route offered) ──
    turn=await engineHandleTravelMenu(env,c,7,state,phone,'','✈️ Live Flights','text',false);
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
    await engineHandleTravelMenu(env,c,7,state,phone,'','TMENU:visas','text',false);
    assert.equal(DB.db.prepare(`SELECT COUNT(*) n FROM live_travel_chat_search_state WHERE client_id=7`).get().n,0);

    // ── An agency without the live API: no Live Flights row ──
    const s9=await token(env.SESSION_SIGNING_KEY,9);
    r=await call(env,s9,'/live-travel/whatsapp-menu');
    assert.equal((await call(env,s9,'/live-travel/whatsapp-menu','PUT',{menu:{...r.data.menu,enabled:true}})).status,200);
    turn=await engineHandleTravelMenu(env,{...c,Id:9},9,state,phone,'','hi','text',true);
    await turn.turn.deliver();
    assert.ok(!meta.pop().interactive.action.sections.flatMap(s=>s.rows).some(r=>r.title.includes('Live Flights')));
  }finally{globalThis.fetch=realFetch;}
});

test('with Travel Flow on, asking for flights in any common way opens the live search',()=>{
  for(const t of ['flights?','Flight','live flights','air ticket','flight details','flight prices pls','show me flights','any flights','need flight booking','cheapest flights','Dubai to Kochi on 20 Nov'])
    assert.ok(ltChatFlightAsk(t),t);
  for(const t of ['my flight details','flight status','what is the visa price','hi'])
    assert.ok(!ltChatFlightAsk(t),t);
  // The everyday detector other agencies use is unchanged.
  assert.equal(ltChatFlightIntent('flights?'),false);
  assert.equal(ltChatFlightIntent('live flights'),false);
});

test('Travel Flow is optional and off by default',()=>{
  assert.equal(ltTravelFlowOn({industry:'travel'}),false);
  assert.equal(ltTravelFlowOn({industry:'travel',travel_flow_enabled:'No'}),false);
  assert.equal(ltTravelFlowOn({industry:'travel',travel_flow_enabled:'Yes'}),true);
  assert.equal(ltTravelFlowOn({industry:'ecommerce',travel_flow_enabled:'Yes'}),false,'only travel agencies');
});

test('agencies without Travel Flow keep the original bot: no menu, no buttons, booking link on pick',async()=>{
  const DB=new D1Database(),env={DB,SESSION_SIGNING_KEY:'integration-secret',POOMAS_API_KEY:'poomas-test-key'},session=await token(env.SESSION_SIGNING_KEY);
  const realFetch=globalThis.fetch,meta=[],chatwoot=[];
  globalThis.fetch=async(url,opts={})=>{
    const u=String(url);
    if(u==='https://api.flypoomas.com/api/search')return new Response(JSON.stringify({fares:[{id:'FARE-1',isBookable:true,supplier:'DUFFEL',displayPrice:650,totalFare:650,currency:'AED',airline:'AI',airlineName:'Air India',flightNumber:'AI 6509',origin:'SHJ',destination:'CCJ',departureTime:'2026-12-01T20:00:00',arrivalTime:'2026-12-01T23:59:00',duration:240,stops:0}]}));
    if(u.startsWith('https://graph.facebook.com/')){meta.push(JSON.parse(opts.body));return new Response('{}');}
    if(u.startsWith('https://cw.test/')){chatwoot.push({content:opts.body.get?.('content'),items:opts.body.get?.('content_attributes')?JSON.parse(opts.body.get('content_attributes')).items:null});return new Response('{"id":1}');}
    return new Response('{}',{status:404});
  };
  try{
    // Even with a saved menu, nothing changes until Travel Flow is switched on.
    let r=await call(env,session,'/live-travel/whatsapp-menu');
    assert.equal(r.data.travel_flow,false);
    assert.equal((await call(env,session,'/live-travel/whatsapp-menu','PUT',{menu:{...r.data.menu,enabled:true}})).status,200);
    assert.equal((await call(env,session,'/live-travel/suppliers','PATCH',{supplier:'poomas',enabled:true,priority:10})).status,200);
    const c={Id:7,industry:'travel',language:'en',chatwoot_base:'https://cw.test',chatwoot_account_id:'1',chatwoot_token:'cw',wa_phone_id:'PHONE',wa_token:'TOKEN'};
    const phone='+971500000002',state={convId:'56',stage:'new',name:'Asha'};
    assert.equal(await engineHandleTravelMenu(env,c,7,state,phone,'','hi','text',true),null);
    assert.equal(await engineHandleTravelMenu(env,c,7,state,phone,'','TMENU:flights','text',false),null);
    // "flights?" is not picked up by the live search for these agencies (unchanged behaviour)
    assert.equal(await engineHandleLiveTicketingChat(env,c,7,'flights?',[],phone),null);
    // Missing details: the original text-only reply, no pickers
    let step=await engineHandleLiveTicketingChat(env,c,7,'flight from SHJ to CCJ',[],phone);
    assert.match(step.reply,/I saved the details received so far/);
    assert.equal(step.buttons,undefined);
    // Full request: live fares as before
    step=await engineHandleLiveTicketingChat(env,c,7,'SHJ to CCJ on 2026-12-01, 1 adult',[],phone);
    assert.deepEqual(step.buttons.map(b=>b.title),['Book Option 1']);
    // Pick: the original selected-flight message and the POOMAS "Book Now" link straight away
    const co=await engineHandleLiveTicketCheckoutChat(env,c,7,'56',phone,'Book Option 1','text','');
    assert.equal(co.step,'checkout_ready');
    const msg=chatwoot.pop();
    assert.match(msg.content,/^Selected flight:/);
    assert.deepEqual(msg.items.map(i=>i.title),['Book Now','New Search','Continue Previous']);
    const cta=meta.pop();
    assert.equal(cta.interactive.action.parameters.display_text,'Book Now');
    assert.equal(cta.interactive.action.parameters.url,'https://flypoomas.com/book?fareId=FARE-1&supplier=DUFFEL&source=leadvyne&client=7');
  }finally{globalThis.fetch=realFetch;}
});

test('Travel Flow: a new flight request starts the buttons instead of re-running an old route',async()=>{
  const DB=new D1Database(),env={DB,SESSION_SIGNING_KEY:'integration-secret',POOMAS_API_KEY:'poomas-test-key'},session=await token(env.SESSION_SIGNING_KEY);
  const realFetch=globalThis.fetch,searches=[];
  globalThis.fetch=async(url,opts={})=>{
    const u=String(url);
    if(u==='https://api.flypoomas.com/api/search'){searches.push(JSON.parse(opts.body));return new Response(JSON.stringify({fares:[{id:'F1',isBookable:true,supplier:'DUFFEL',displayPrice:650,totalFare:650,currency:'AED',airline:'AI',airlineName:'Air India',flightNumber:'AI 6509',origin:'CCJ',destination:'AUH',departureTime:'2026-11-17T20:00:00',arrivalTime:'2026-11-17T22:30:00',duration:240,stops:0}]}));}
    return new Response('{}',{status:404});
  };
  try{
    assert.equal((await call(env,session,'/live-travel/suppliers','PATCH',{supplier:'poomas',enabled:true,priority:10})).status,200);
    const c={Id:7,industry:'travel',travel_flow_enabled:'Yes',language:'en'};
    const phone='+971500000003';
    // The chat from the screenshot: an earlier DXB → CCJ request, then "looking for flight ticket".
    const history=[{role:'user',content:'DXB to CCJ 01 Nov'},{role:'assistant',content:'✈️ I found 3 flights from DXB to CCJ'},{role:'user',content:'Hi'}];
    let step=await engineHandleLiveTicketingChat(env,c,7,'looking for flight ticket',history,phone);
    assert.equal(searches.length,0,'no search on an old route');
    assert.match(step.reply,/Where are you flying from and to/);
    assert.equal(step.picker.button,'Choose route');
    // Air India style answer in one message: route, date and "Adult 1" → straight to live fares.
    step=await engineHandleLiveTicketingChat(env,c,7,'CCJ to AUH\n17-11-2026\nAdult 1',history,phone);
    assert.equal(searches.length,1);
    assert.equal(searches[0].adults??searches[0].passengers?.adults??1,1);
    assert.match(step.reply,/Option 1: Air India AI 6509/);
    // Without a passenger count the steps ask for it before searching.
    step=await engineHandleLiveTicketingChat(env,c,7,'flight ticket SHJ to CCJ 2026-11-20',history,'+971500000004');
    assert.match(step.reply,/How many passengers/);
    assert.equal(searches.length,1);
  }finally{globalThis.fetch=realFetch;}
});

test('the Travel Flow switch saves even when NocoDB cannot take the new column yet',async()=>{
  const DB=new D1Database(),env={DB,SESSION_SIGNING_KEY:'integration-secret',NOCODB_BASE:'https://nc.test',NOCODB_TOKEN:'nc'},session=await token(env.SESSION_SIGNING_KEY);
  const realFetch=globalThis.fetch;
  // NocoDB rejects every write, like a just-created column still missing from its schema cache.
  globalThis.fetch=async()=>new Response('{"msg":"Field travel_flow_enabled not found"}',{status:400});
  try{
    let r=await call(env,session,'/live-travel/travel-flow');
    assert.deepEqual(r.data,{enabled:false});
    r=await call(env,session,'/live-travel/travel-flow','PUT',{enabled:true});
    assert.equal(r.status,200,JSON.stringify(r.data));
    assert.deepEqual((await call(env,session,'/live-travel/travel-flow')).data,{enabled:true});
    // The WhatsApp Menu page sees the same switch, and saving the menu keeps it.
    r=await call(env,session,'/live-travel/whatsapp-menu');
    assert.equal(r.data.travel_flow,true);
    assert.equal((await call(env,session,'/live-travel/whatsapp-menu','PUT',{menu:r.data.menu})).status,200);
    assert.equal((await call(env,session,'/live-travel/whatsapp-menu')).data.travel_flow,true);
    r=await call(env,session,'/live-travel/travel-flow','PUT',{enabled:false});
    assert.deepEqual((await call(env,session,'/live-travel/travel-flow')).data,{enabled:false});
    assert.equal((await call(env,session,'/live-travel/travel-flow','PUT',{enabled:'yes'})).status,400);
  }finally{globalThis.fetch=realFetch;}
});

test('Travel Settings save to D1, keep unsent fields and reject out-of-range values',async()=>{
  const DB=new D1Database(),env={DB,SESSION_SIGNING_KEY:'integration-secret',NOCODB_BASE:'https://nc.test',NOCODB_TOKEN:'nc'},session=await token(env.SESSION_SIGNING_KEY);
  const realFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response('{"msg":"Field lt_fare_options not found"}',{status:400});
  try{
    let r=await call(env,session,'/live-travel/travel-settings');
    assert.deepEqual(r.data,{itin_share_pdf:false,itin_auto_images:true,lt_show_fares:true,lt_fare_options:3});
    r=await call(env,session,'/live-travel/travel-settings','PUT',{itin_share_pdf:true,lt_fare_options:5});
    assert.equal(r.status,200,JSON.stringify(r.data));
    r=await call(env,session,'/live-travel/travel-settings','PUT',{lt_show_fares:false});
    assert.deepEqual(r.data,{itin_share_pdf:true,itin_auto_images:true,lt_show_fares:false,lt_fare_options:5});
    assert.deepEqual((await call(env,session,'/live-travel/travel-settings')).data,r.data);
    assert.equal((await call(env,session,'/live-travel/travel-settings','PUT',{lt_fare_options:6})).status,400);
    assert.equal((await call(env,session,'/live-travel/travel-settings','PUT',{lt_fare_options:0})).status,400);
    assert.equal((await call(env,session,'/live-travel/travel-settings','PUT',{lt_show_fares:'no'})).status,400);
  }finally{globalThis.fetch=realFetch;}
});
