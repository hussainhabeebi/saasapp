// Resorts V1 on a travel agency (Travel Settings → Chat Style "Resorts V1"), end to end on an
// in-memory D1 with Chatwoot stubbed: intro with every location + "All resorts", a location's
// resorts with price ranges, a resort's details with the full set of options, and booking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker, { engineResortsV1Turn, hospRv1FormSubmitted, hospRv1FlowToken } from './worker.js';

class D1Statement {
  constructor(db,sql,args=[]){this.db=db;this.sql=sql;this.args=args;}
  bind(...args){return new D1Statement(this.db,this.sql,args);}
  async run(){const r=this.db.prepare(this.sql).run(...this.args);return {success:true,meta:{last_row_id:Number(r.lastInsertRowid),changes:r.changes}};}
  async first(){return this.db.prepare(this.sql).get(...this.args)||null;}
  async all(){return {results:this.db.prepare(this.sql).all(...this.args)};}
}
class D1Database {
  constructor(){this.db=new DatabaseSync(':memory:');}
  prepare(sql){return new D1Statement(this.db,sql);}
  async batch(list){return Promise.all(list.map(s=>s.run()));}
}

test('travel agency + Chat Style Resorts V1: lists, buttons and booking from Resorts & Hotels', async()=>{
  const DB=new D1Database(), env={DB, NOCODB_BASE:'https://nc.test', NOCODB_TOKEN:'t'};
  const sent=[];
  const realFetch=globalThis.fetch;
  globalThis.fetch=async(url,opts={})=>{
    const u=String(url);
    if(u.startsWith('https://cw.test/')){
      let body=opts.body, content='', items=null, type='';
      if(typeof body==='string'){ const j=JSON.parse(body); content=j.content; items=j.content_attributes?.items||null; type=j.content_type||''; }
      let file=null;
      if(body?.get){ content=body.get('content'); items=body.get('content_attributes')?JSON.parse(body.get('content_attributes')).items:null; file=body.get('attachments[]'); type=file?'attachment':''; }
      sent.push({url:u, content, items, type, file});
      return Response.json({id:sent.length});
    }
    return Response.json({list:[]});
  };
  try{
    const c={Id:7, industry:'travel', client_name:'Kerala Holidays', language:'en', lt_chat_style:'resorts_v1',
      chatwoot_base:'https://cw.test', chatwoot_account_id:'1', chatwoot_token:'x'};
    // Agency → Resorts & Hotels (created through the real API).
    const add=async b=>{ const r=await worker.fetch(new Request('https://w.test/ta/properties',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:'7',...b})}),env,{}); assert.equal(r.status,200,await r.clone().text()); };
    await add({name:'Misty Hills Resort', location:'Munnar, Kerala', price_range_min:8000, price_range_max:15000, price_from:8500, amenities:'Pool',
      photos_folder_url:'https://drive.google.com/drive/folders/abcdefghij12', video_url:'https://drive.google.com/file/d/vid123/view', pdf_url:'https://drive.google.com/file/d/pdf123/view'});
    await add({name:'Tea Valley Stay', location:'Munnar', price_range_min:4000, price_range_max:6000});
    await add({name:'Lake Palace Houseboat', location:'Alleppey', property_type:'houseboat'});
    await add({name:'Forest Edge', location:'Wayanad', price_range_max:20000, status:'inactive'});

    const state={convId:'55', stage:'new', leadId:'91', lead:{Id:91}};
    const run=async text=>{ sent.length=0; const r=await engineResortsV1Turn(env,c,'7',state,text,false); if(r?.turn?.deliver) await r.turn.deliver(); return r; };

    // 1. Intro: names the active locations and lists them, plus "All resorts".
    let r=await engineResortsV1Turn(env,c,'7',{...state,leadId:null,lead:null},'Hi',true);
    sent.length=0; await r.turn.deliver();
    const intro=sent.at(-1);
    assert.match(intro.content, /resorts & hotels in \*Alleppey\* and \*Munnar\*/);
    assert.doesNotMatch(intro.content, /Wayanad/, 'inactive resorts are not offered');
    assert.deepEqual(intro.items.map(i=>i.title), ['Alleppey (1)', 'Munnar (2)', '🏨 All resorts']);
    assert.equal(r.patch()?.location, '', 'brand-new lead: place saved once it has an id');

    // 2. Location → its resorts with ranges, never the exact price.
    await run('Munnar (2)');
    const list=sent.find(m=>m.items);
    assert.deepEqual(list.items.map(i=>i.title), ['Misty Hills Resort', 'Tea Valley Stay', '📍 Change location']);
    // 3 rows → WhatsApp reply buttons (no description line), so the ranges are in the text.
    assert.match(list.content, /\*Misty Hills Resort\* — ₹8,000 – ₹15,000 per night/);
    assert.match(list.content, /\*Tea Valley Stay\* — ₹4,000 – ₹6,000 per night/);
    assert.doesNotMatch(list.content, /8,500/);
    // Picking a destination sends the trip details form once (here as a message: no WhatsApp
    // Cloud credentials in this test, so no Meta Flow).
    const form=sent.find(m=>/please reply with these details/.test(m.content||''));
    assert.ok(form, 'details form sent after the destination list');
    assert.match(form.content, /in \*Munnar\*/);
    for(const q of ['Name','Phone number','Adults','Kids','Rooms needed','Check-in date','Budget']) assert.match(form.content, new RegExp(q));
    await run('Alleppey (1)');
    assert.ok(!sent.some(m=>/please reply with these details/.test(m.content||'')), 'not sent again');
    await run('Munnar (2)');

    // 2b. All resorts: every active one.
    await run('🏨 All resorts');
    const all=sent.at(-1);
    assert.deepEqual(all.items.map(i=>i.title), ['Lake Palace Houseboat', 'Misty Hills Resort', 'Tea Valley Stay', '📍 Change location']);
    assert.match(all.items[1].description, /^₹8,000 – ₹15,000 per night/, '4+ rows → a list with the range under each name');

    // 3. Resort → photos then details with the range and every option.
    await run('Misty Hills Resort');
    const details=sent.at(-1);
    assert.match(details.content, /Price range: \*₹8,000 – ₹15,000 per night\*/);
    assert.doesNotMatch(details.content, /8,500/);
    assert.deepEqual(details.items.map(i=>i.title), ['📅 Book now', '🎬 Video', '📄 Brochure', '↩ Other resorts', '📍 Change location']);
    // One brochure PDF (all photos + range + photos link) instead of separate photo messages.
    const pdfs=sent.filter(m=>m.type==='attachment');
    assert.equal(pdfs.length, 1, JSON.stringify(sent.map(m=>[m.type, String(m.content).slice(0,40)])));
    assert.match(pdfs[0].content, /📄 \*Misty Hills Resort\* · Munnar, Kerala/);
    assert.match(pdfs[0].content, /Price range: ₹8,000 – ₹15,000 per night/);
    assert.match(pdfs[0].content, /All photos: https:\/\/drive\.google\.com\/drive\/folders\/abcdefghij12/);
    assert.equal(pdfs[0].file?.type, 'application/pdf');
    assert.ok(pdfs[0].file.size>1000, 'a real PDF');

    // A resort with no media / range: the short set, "Price on request".
    await run('Lake Palace Houseboat');
    assert.match(sent.at(-1).content, /Price on request/);
    assert.deepEqual(sent.at(-1).items.map(i=>i.title), ['📅 Book now', '↩ Other resorts', '📍 Change location']);

    // 4. Book now → handover turn (the chat is the team's; silence is engineHandoverSilenceTurn's).
    await run('Misty Hills Resort');
    r=await engineResortsV1Turn(env,c,'7',state,'📅 Book now',false);
    assert.equal(r.turn.route, 'human');
    assert.equal(r.turn.next, 'human_handover');
    assert.match(r.turn.text, /Misty Hills Resort/);

    // While the form is out, a typed reply with details → handover + a Trip (partial details count).
    const st2={convId:'56', stage:'new', leadId:'92', lead:{Id:92}, phone:'+919800000002', qualAnswers:{}};
    sent.length=0; let t=await engineResortsV1Turn(env,c,'7',st2,'Munnar (2)',false); await t.turn.deliver();
    await DB.prepare(`UPDATE hosp_h3_state SET form='sent' WHERE client_id=7 AND lead_id=92`).run();
    t=await engineResortsV1Turn(env,c,'7',st2,'Rahul, 2 adults 1 kid, 20 Dec, budget 25000',false);
    assert.equal(t.turn.route, 'human');
    assert.equal(t.turn.next, 'human_handover');
    assert.match(t.turn.text, /Thank you Rahul! 🙏 We've received your details for \*Munnar\*/);
    assert.match(t.turn.text, /travel expert will contact you shortly with further details/);
    assert.equal(t.turn.qualAnswers.destination, 'Munnar');
    assert.equal(t.turn.qualAnswers.adults, '2');
    assert.equal(t.turn.qualAnswers.children, '1');
    assert.match(t.turn.qualAnswers.travel_date, /^\d{4}-12-20$/);
    assert.deepEqual({...t.turn.tripRequest, notes:undefined}, {complete:true, force:true, notes:undefined, service:'Hotel Booking'});
    assert.ok(t.turn.tripRequest.notes.includes('Budget: 25000'));
    assert.deepEqual(t.leadPatch, {Name:'Rahul'});
    assert.deepEqual(t.patch(), {form:'done'});
    // A tap in the flow is still a tap, not the details.
    assert.equal((await engineResortsV1Turn(env,c,'7',st2,'Tea Valley Stay',false)).turn.route, 'faq');

    // A question is left to the AI (normal path).
    assert.equal(await engineResortsV1Turn(env,c,'7',state,'is breakfast included?',false), null);
  }finally{ globalThis.fetch=realFetch; }
});

test('Resorts V1 details form submitted (WhatsApp Flow): Trip with partial details, handover, thanks', async()=>{
  const DB=new D1Database(), env={DB, NOCODB_BASE:'https://nc.test', NOCODB_TOKEN:'t'};
  const calls=[];
  const realFetch=globalThis.fetch;
  const tripCols=['Id','client_id','client_name','client_phone','package_name','destination','travel_month','adults','children','children_ages','departure_city','pax','status','source','lead_id','assigned_to','requested_at','status_changed_at','missing_info','lost_reason','duplicate_of','created_at','service','return_date','lead_trip_id','notes','departure_date','alerted_at','currency'];
  globalThis.fetch=async(url,opts={})=>{
    const u=String(url), method=opts.method||'GET';
    const body=typeof opts.body==='string'?JSON.parse(opts.body):null;
    calls.push({u, method, body, form:opts.body?.get?Object.fromEntries([...opts.body.entries()].map(([k,v])=>[k,typeof v==='string'?v:'[file]'])):null});
    if(u.includes('/api/v2/meta/tables/tbk')) return Response.json({columns:tripCols.map(title=>({title}))});
    if(u.includes('/api/v2/tables/tbk/records')) return method==='POST'?Response.json({Id:501}):Response.json({list:[]});
    if(u.includes('/records?where=(Phone,eq,')) return Response.json({list:[{Id:91, ClientId:'7', Phone:'+919800000001', Stage:'faq', ConvHistory:'[]', QualAnswers:'{}'}]});
    return Response.json({list:[]});
  };
  try{
    const c={Id:7, industry:'travel', client_name:'Kerala Holidays', language:'en', lt_chat_style:'resorts_v1', ta_table_ids:JSON.stringify({bookings:'tbk'}),
      chatwoot_base:'https://cw.test', chatwoot_account_id:'1', chatwoot_token:'x'};
    // The token round-trips who / where (non-Latin names included).
    const tok=hospRv1FlowToken({clientId:7, convId:'55', phone:'+919800000001', location:'Munnar', property:'Misty Hills Resort'});
    const meta=JSON.parse(atob(tok));
    assert.equal(meta.k, 'rv1'); assert.equal(decodeURIComponent(meta.loc), 'Munnar');
    assert.equal(decodeURIComponent(JSON.parse(atob(hospRv1FlowToken({clientId:7, location:'മൂന്നാർ'}))).loc), 'മൂന്നാർ');

    // Partial: no name, phone, kids or budget.
    await hospRv1FormSubmitted(env, c, '7', {phone:'+919800000001', convId:'55', location:'Munnar', property:''}, {adults:'2', rooms:'1', date:'2026-12-20'});
    const leadPatch=calls.find(x=>x.method==='PATCH' && x.body?.Stage==='human_handover');
    assert.ok(leadPatch, 'lead handed over');
    assert.equal(leadPatch.body.Handover, 'Yes');
    assert.equal(JSON.parse(leadPatch.body.QualAnswers).destination, 'Munnar');
    const trip=calls.find(x=>x.u.includes('/api/v2/tables/tbk/records') && x.method==='POST');
    assert.ok(trip, 'trip created on Trips');
    assert.equal(trip.body.destination, 'Munnar');
    assert.equal(trip.body.adults, '2');
    assert.equal(trip.body.departure_date, '2026-12-20');
    assert.equal(trip.body.status, 'requested');
    assert.equal(trip.body.service, 'Hotel Booking');
    assert.equal(trip.body.lead_id, '91');
    assert.match(trip.body.notes, /Rooms needed: 1/);
    assert.match(trip.body.notes, /Not given yet: your name, phone number, kids, budget/);
    const thanks=calls.find(x=>x.u.startsWith('https://cw.test/') && /travel expert will contact you shortly/.test(x.body?.content||x.form?.content||''));
    assert.ok(thanks, 'guest told an agent will send further details');

    // Only a destination (empty form) still files the trip.
    calls.length=0;
    await hospRv1FormSubmitted(env, c, '7', {phone:'+919800000001', convId:'55', location:'Alleppey'}, {});
    assert.ok(calls.some(x=>x.u.includes('/api/v2/tables/tbk/records') && x.method==='POST' && x.body.destination==='Alleppey'));
  }finally{ globalThis.fetch=realFetch; }
});
