// Destination Staff Routing end to end on an in-memory D1 with Chatwoot / Meta / NocoDB stubbed:
// a Resorts V1 destination pick and a typed flight route are handed to the matching teammate —
// customer told their expert's number on the main number, teammate alerted on their own number,
// first message from the teammate's own channel, and the bot silent for that customer afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker, { engineResortsV1Turn, engineDsrApply, engineDsrLeadFields, engineDsrAfterHandoff, engineDsrFlightTurn, engineHandoverSilenceTurn } from './worker.js';

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

const routing={enabled:true, rules:{
  'anu@kh.test':{resorts:['Munnar'], flights:['Kochi - Dubai']},
  'ravi@kh.test':{resorts:['Alleppey'], phone:'+91 98000 00077'},
}};
const client=()=>({Id:7, industry:'travel', client_name:'Kerala Holidays', language:'en', lt_chat_style:'resorts_v1',
  authentik_email:'owner@kh.test', team_emails:'anu@kh.test,ravi@kh.test', team_names:JSON.stringify({'anu@kh.test':'Anu', 'ravi@kh.test':'Ravi'}),
  team_whatsapp:JSON.stringify({'anu@kh.test':'919800000002'}),
  chatwoot_base:'https://cw.test', chatwoot_account_id:'1', chatwoot_token:'x', chatwoot_inbox_id:'1',
  wa_token:'main-token', wa_phone_id:'MAINPID', waba_id:'WABA',
  meta_channel_credentials:JSON.stringify([{inbox_id:'1', wa_token:'main-token', wa_phone_id:'MAINPID', waba_id:'WABA', display_phone:'+91 90000 00000'},
    {inbox_id:'2', wa_token:'anu-token', wa_phone_id:'ANUPID', waba_id:'WABA', display_phone:'+91 98000 00055'}]),
  dest_staff_routing:JSON.stringify({...routing, customer_template_name:'destination_expert_intro_leadvyne'})});

function stubFetch(sent){
  return async(url,opts={})=>{
    const u=String(url), method=opts.method||'GET';
    let body=null; try{ body=typeof opts.body==='string'?JSON.parse(opts.body):null; }catch(e){}
    if(opts.body?.get) body={content:opts.body.get('content'), private:opts.body.get('private')==='true'};
    sent.push({u, method, body, auth:opts.headers?.Authorization||''});
    if(u.startsWith('https://graph.facebook.com/')) return Response.json({messages:[{id:'wamid.'+sent.length}]});
    if(u.startsWith('https://cw.test/')) return Response.json({id:sent.length});
    return Response.json({list:[]});
  };
}

test('Resorts V1 destination picked → the teammate, not the form; alert, intro from their number, then silent', async()=>{
  const DB=new D1Database(), env={DB, NOCODB_BASE:'https://nc.test', NOCODB_TOKEN:'t'};
  const sent=[], realFetch=globalThis.fetch;
  globalThis.fetch=stubFetch(sent);
  try{
    const c=client();
    const add=async b=>{ const r=await worker.fetch(new Request('https://w.test/ta/properties',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:'7',...b})}),env,{}); assert.equal(r.status,200,await r.clone().text()); };
    await add({name:'Misty Hills Resort', location:'Munnar, Kerala', price_range_min:8000, price_range_max:15000});
    await add({name:'Lake Palace Houseboat', location:'Alleppey', property_type:'houseboat'});
    await add({name:'Beach Inn', location:'Kovalam'});
    // Anu's own WhatsApp channel (Channels → inbox assignment).
    await DB.prepare(`CREATE TABLE IF NOT EXISTS channel_inbox_assignments (client_id INTEGER NOT NULL,inbox_id INTEGER NOT NULL,assigned_email TEXT NOT NULL DEFAULT '',chatwoot_user_id INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY (client_id,inbox_id))`).run();
    await DB.prepare(`INSERT INTO channel_inbox_assignments VALUES (7,2,'anu@kh.test',0,'x','x')`).run();

    const state={convId:'55', stage:'new', leadId:'91', lead:{Id:91, Name:'Priya'}, phone:'+919800000001', qualAnswers:{}, inboxId:'1'};

    // Munnar → Anu. The flow's step (the details form) is replaced by the handoff.
    let r=await engineResortsV1Turn(env,c,'7',state,'Munnar (1)',false);
    assert.deepEqual(r.turn.dsr, {kind:'resort', destination:'Munnar'});
    const turn=await engineDsrApply(env,c,'7',state,r.turn);
    assert.equal(turn.route, 'human'); assert.equal(turn.next, 'human_handover');
    assert.equal(turn.dsrPlan.email, 'anu@kh.test');
    assert.equal(turn.dsrPlan.staffPhone, '919800000055', 'her own channel\'s number');
    assert.equal(turn.qualAnswers.destination, 'Munnar');
    sent.length=0;
    await turn.deliver();
    const cw=sent.filter(m=>m.u.startsWith("https://cw.test/") && m.body?.content);
    assert.equal(cw.length, 1, JSON.stringify(cw.map(m=>m.body.content)));
    assert.match(cw[0].body.content, /Your \*Munnar\* enquiry is now with \*Anu\*/);
    assert.match(cw[0].body.content, /\+919800000055/);
    assert.doesNotMatch(cw[0].body.content, /wa\.me/, 'the link goes in the button, not the text');
    assert.doesNotMatch(cw[0].body.content, /please reply with these details/, 'no form');
    // Her WhatsApp as a tap-to-chat button, from the main number to the customer.
    const btn=sent.find(m=>m.u.startsWith('https://graph.facebook.com/') && m.body?.interactive?.type==='cta_url');
    assert.ok(btn, 'chat button sent');
    assert.match(btn.u, /MAINPID/); assert.equal(btn.body.to, '919800000001');
    assert.equal(btn.body.interactive.action.parameters.display_text, 'Chat with Anu');
    assert.match(btn.body.interactive.action.parameters.url, /^https:\/\/wa\.me\/919800000055\?text=/);

    const fields=engineDsrLeadFields(turn.dsrPlan, '2026-11-15T00:00:00.000Z');
    assert.deepEqual(fields, {Owner:'anu@kh.test', Handover:'Yes', Stage:'human_handover', DsrStaff:'anu@kh.test', DsrKind:'resort',
      DsrDestination:'Munnar', DsrAt:'2026-11-15T00:00:00.000Z', Destination:'Munnar'});

    sent.length=0;
    const out=await engineDsrAfterHandoff(env,c,'7',91,state,{Name:'Priya', Phone:'+919800000001'},turn.dsrPlan);
    const graph=sent.filter(m=>m.u.startsWith('https://graph.facebook.com/'));
    const alert=graph.find(m=>m.body.to==='919800000002');
    assert.ok(alert, 'teammate alerted on her own number');
    assert.match(alert.u, /MAINPID/, 'from the main number');
    assert.match(alert.body.text.body, /New Hotels & Resorts enquiry for you: Priya \(\+919800000001\) chose Munnar/);
    assert.match(alert.body.text.body, /wa\.me\/919800000001/);
    const intro=graph.find(m=>m.body.to==='919800000001');
    assert.ok(intro, 'first message to the customer');
    assert.match(intro.u, /ANUPID/, 'from Anu\'s number'); assert.equal(intro.auth, 'Bearer anu-token');
    assert.equal(intro.body.template.name, 'destination_expert_intro_leadvyne');
    assert.deepEqual(intro.body.template.components[0].parameters.map(p=>p.text), ['Priya', 'Anu', 'Kerala Holidays', 'Munnar']);
    assert.match(out.alert, /sent to \+919800000002/); assert.match(out.intro, /sent from \+919800000055/);
    const note=sent.find(m=>m.u.startsWith('https://cw.test/') && m.body?.private);
    assert.match(note.body.content, /Destination routing: Hotels & Resorts — Munnar → Anu/);
    const logged=await DB.prepare(`SELECT status, reason FROM hot_lead_alerts`).all();
    assert.deepEqual(logged.results.map(x=>`${x.reason}:${x.status}`), ['destination:sent']);

    // Afterwards the bot on the main number is silent for that customer.
    sent.length=0;
    const routed={...state, stage:'human_handover', lead:{...state.lead, ...fields, Phone:'+919800000001'}};
    const silent=await engineHandoverSilenceTurn(env,c,'7',{id:'m2'},routed,{phone:'+919800000001', name:'Priya', convId:'55', mediaType:'text'},'what is the price?');
    assert.equal((await silent.json()).skipped, 'destination-routed');
    assert.ok(!sent.some(m=>m.u.startsWith('https://cw.test/') && m.body?.content && !m.body.private), 'no bot reply');

    // Alleppey → Ravi: his override number; no WhatsApp on his profile → the owner can't be
    // paged either (no number), so the alert is skipped and logged.
    r=await engineResortsV1Turn(env,c,'7',{...state, leadId:'92', lead:{Id:92}},'Alleppey',false);
    const t2=await engineDsrApply(env,c,'7',{...state, leadId:'92', lead:{Id:92}},r.turn);
    assert.equal(t2.dsrPlan.email, 'ravi@kh.test'); assert.equal(t2.dsrPlan.staffPhone, '919800000077');
    const o2=await engineDsrAfterHandoff(env,c,'7',92,state,{},t2.dsrPlan);
    assert.match(o2.alert, /no WhatsApp number/); assert.equal(o2.intro, '', 'no channel of his own');

    // Kovalam: nobody's rule → the normal form.
    r=await engineResortsV1Turn(env,c,'7',{...state, leadId:'93', lead:{Id:93}},'Kovalam',false);
    const t3=await engineDsrApply(env,c,'7',{...state, leadId:'93', lead:{Id:93}},r.turn);
    assert.equal(t3, r.turn, 'unchanged');
    assert.equal(t3.route, 'faq');

    // Switched off → unchanged.
    const off={...c, dest_staff_routing:JSON.stringify({...routing, enabled:false})};
    r=await engineResortsV1Turn(env,off,'7',state,'Munnar (1)',false);
    assert.equal((await engineDsrApply(env,off,'7',state,r.turn)).route, 'faq');
  }finally{ globalThis.fetch=realFetch; }
});

test('a typed flight route goes to the teammate who handles it', async()=>{
  const env={NOCODB_BASE:'https://nc.test', NOCODB_TOKEN:'t'};
  const sent=[], realFetch=globalThis.fetch;
  globalThis.fetch=stubFetch(sent);
  try{
    const c={...client(), lt_chat_style:''};
    const state={convId:'56', stage:'new', leadId:'94', lead:{Id:94, Name:'Rahul'}, phone:'+919800000009', qualAnswers:{}, inboxId:'1'};
    const t=await engineDsrFlightTurn(env,c,'7',state,'Kochi to Dubai',  'text');
    assert.ok(t, 'routed');
    assert.equal(t.dsrPlan.email, 'anu@kh.test');
    assert.equal(t.dsrPlan.destination, 'Kochi → Dubai');
    assert.equal(t.qualAnswers.departure_city, 'Kochi'); assert.equal(t.qualAnswers.destination, 'Dubai');
    assert.equal(engineDsrLeadFields(t.dsrPlan).TravelRoute, 'Kochi → Dubai');
    assert.equal(t.dsrPlan.staffPhone, '919800000002', 'no D1 here → her profile number');
    assert.match(t.text, /Kochi → Dubai\* enquiry is now with \*Anu\*/);
    assert.equal(await engineDsrFlightTurn(env,c,'7',state,'Dubai to Kochi','text'), null, 'nobody handles the return route');
    assert.equal(await engineDsrFlightTurn(env,c,'7',state,'is breakfast included','text'), null);
    // Already with a teammate → not routed again.
    assert.equal(await engineDsrFlightTurn(env,c,'7',{...state, lead:{...state.lead, DsrStaff:'anu@kh.test', Handover:'Yes'}},'Kochi to Dubai','text'), null);
  }finally{ globalThis.fetch=realFetch; }
});
