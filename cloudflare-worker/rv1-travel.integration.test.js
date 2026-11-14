// Resorts V1 on a travel agency (Travel Settings → Chat Style "Resorts V1"), end to end on an
// in-memory D1 with Chatwoot stubbed: intro with every location + "All resorts", a location's
// resorts with price ranges, a resort's details with the full set of options, and booking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker, { engineResortsV1Turn } from './worker.js';

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
    const list=sent.at(-1);
    assert.deepEqual(list.items.map(i=>i.title), ['Misty Hills Resort', 'Tea Valley Stay', '📍 Change location']);
    // 3 rows → WhatsApp reply buttons (no description line), so the ranges are in the text.
    assert.match(list.content, /\*Misty Hills Resort\* — ₹8,000 – ₹15,000 per night/);
    assert.match(list.content, /\*Tea Valley Stay\* — ₹4,000 – ₹6,000 per night/);
    assert.doesNotMatch(list.content, /8,500/);

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

    // A question is left to the AI (normal path).
    assert.equal(await engineResortsV1Turn(env,c,'7',state,'is breakfast included?',false), null);
  }finally{ globalThis.fetch=realFetch; }
});
