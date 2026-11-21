// Hospitality style "Hillora" (hospitality-hillora.js): units → photos & details → stay form → handover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HILLORA_NAV, HILLORA_HANDOVER_MS, hilloraIsStyle, hilloraDecide, hilloraUnitPage, hilloraMoreTap, hilloraUnitDetailsText,
  hilloraFormFlowJson, hilloraCleanDetails, hilloraParseDetails, hilloraIsDetailsReply, hilloraStaffLink, hilloraQual,
  hilloraSummaryLines, hilloraHandoverExpired, hilloraHandoverLiftable, hilloraReleasePatch, hilloraFormTextFallback } from './hospitality-hillora.js';

const U=(id, name, extra={})=>({id, name, capacity_adults:2, capacity_children:1, unit_type:'Villa', ...extra});
const units=[U(1, 'Pool Villa', {amenities:'Private pool\nWi-Fi', description:'Hill view villa.', image_url_1:'https://x/1.jpg'}), U(2, 'Garden Cottage'), U(3, 'Tree House', {capacity_children:0})];
const today=new Date('2026-11-21T00:00:00Z');
const decide=(text, o={})=>hilloraDecide({text, units, ctx:{}, ...o});

test('Hillora needs Hospitality on and the style', ()=>{
  assert.equal(hilloraIsStyle({hospitality_enabled:'Yes', hospitality_style:'hillora'}), true);
  assert.equal(hilloraIsStyle({hospitality_enabled:'No', hospitality_style:'hillora'}), false);
  for(const s of ['h3', 'resorts_v1', 'resort', 'hotel', '']) assert.equal(hilloraIsStyle({hospitality_enabled:'Yes', hospitality_style:s}), false);
});

test('a greeting or a new guest gets the intro with the unit buttons', ()=>{
  assert.deepEqual(decide('hi'), {type:'units', page:1, intro:true});
  assert.deepEqual(decide('Hello there!'), {type:'units', page:1, intro:true});
  assert.deepEqual(decide('ok', {isNewLead:true}), {type:'units', page:1, intro:true});
  // No units set up → the normal bot answers.
  assert.equal(hilloraDecide({text:'hi', units:[]}), null);
});

test('a new guest\'s question is answered by the AI first, then the units follow', ()=>{
  assert.deepEqual(decide('is breakfast included in the stay?', {isNewLead:true}), {type:'units', page:1, intro:false, aiFirst:true});
  assert.equal(decide('is breakfast included in the stay?'), null);
});

test('a unit tap, its name or a short form picks that unit', ()=>{
  assert.deepEqual(decide('Pool Villa'), {type:'unit', unitId:1});
  assert.deepEqual(decide('pool villa please'), {type:'unit', unitId:1});
  assert.deepEqual(decide('tree house'), {type:'unit', unitId:3});
  assert.deepEqual(decide('garden'), {type:'unit', unitId:2});
});

test('other units / more pages show the list again', ()=>{
  assert.deepEqual(decide(HILLORA_NAV.otherUnits), {type:'units', page:1});
  assert.deepEqual(decide('other rooms'), {type:'units', page:1});
  assert.deepEqual(hilloraMoreTap('More units · page 2'), {page:2});
  const many=Array.from({length:14}, (_, i)=>U(i+1, `Unit ${i+1}`));
  const p1=hilloraUnitPage(many, 1);
  assert.equal(p1.rows.length, 10);
  assert.equal(p1.rows[9].title, 'More units · page 2');
  assert.deepEqual(hilloraDecide({text:p1.rows[9].title, units:many}), {type:'units', page:2});
  assert.equal(hilloraUnitPage(many, 2).rows.at(-1).title, 'More units · page 1');
});

test('while the form is out, only a unit tap or "other units" is a flow step', ()=>{
  const ctx={unit:'Pool Villa', form:'sent'};
  assert.equal(decide('20 Dec, 22 Dec, 1 room', {ctx}), null);
  assert.equal(decide('hi', {ctx}), null);
  assert.deepEqual(decide('Garden Cottage', {ctx}), {type:'unit', unitId:2});
  assert.deepEqual(decide(HILLORA_NAV.otherUnits, {ctx}), {type:'units', page:1});
});

test('unit details: name, guests, type, amenities and description, no price', ()=>{
  const t=hilloraUnitDetailsText({...units[0], base_rate:9000});
  assert.match(t, /\*Pool Villa\*/);
  assert.match(t, /2 adults \+ 1 child · Villa/);
  assert.match(t, /Private pool, Wi-Fi/);
  assert.match(t, /Hill view villa\./);
  assert.doesNotMatch(t, /9000|₹/);
});

test('the WhatsApp form asks exactly the stay questions', ()=>{
  const flow=hilloraFormFlowJson();
  const form=flow.screens[0].layout.children.find(x=>x.type==='Form');
  const names=form.children.filter(x=>x.name).map(x=>x.name);
  assert.deepEqual(names, ['checkin','checkout','rooms','requirement','pool','adults','kids_6_12','kids_below_6']);
  const req=form.children.find(x=>x.name==='requirement');
  assert.deepEqual(req['data-source'].map(o=>o.title), ['Resort','Homestay']);
  const pool=form.children.find(x=>x.name==='pool');
  assert.deepEqual(pool['data-source'].map(o=>o.title), ['With Pool','Without Pool']);
  const footer=form.children.find(x=>x.type==='Footer');
  assert.equal(footer['on-click-action'].payload.kids_below_6, '${form.kids_below_6}');
  assert.match(hilloraFormTextFallback('Pool Villa'), /Check-out Date[\s\S]*Below 6 years/);
});

test('form answers are cleaned; checkout before checkin rolls to the next year', ()=>{
  assert.deepEqual(hilloraCleanDetails({checkin:'2026-12-30', checkout:'2 Jan', rooms:'1', requirement:'Resort', pool:'Without Pool', adults:'2', kids_6_12:'', kids_below_6:'0'}, today),
    {checkin:'2026-12-30', checkout:'2027-01-02', rooms:'1', requirement:'Resort', pool:'Without Pool', adults:'2', kids_below_6:'0'});
  // Flow DatePicker sends epoch ms.
  assert.equal(hilloraCleanDetails({checkin:String(Date.UTC(2026, 11, 20))}, today).checkin, '2026-12-20');
  assert.deepEqual(hilloraCleanDetails({requirement:'Resort / Homestay', pool:'With Pool / Without Pool'}, today), {});
});

test('typed details: labelled lines, free text and bare answers', ()=>{
  const labelled=hilloraParseDetails(`1️⃣ Check-in Date: 20 Dec\n2️⃣ Check-out Date: 22 Dec\n3️⃣ How many rooms: 2\n4️⃣ Requirement: Homestay\n5️⃣ Pool Preference: With Pool\n6️⃣ Adults (Above 12 years): 4\n7️⃣ Age 6–12 years: 1\n8️⃣ Below 6 years: 1`, today);
  assert.deepEqual(labelled, {checkin:'2026-12-20', checkout:'2026-12-22', rooms:'2', requirement:'Homestay', pool:'With Pool', adults:'4', kids_6_12:'1', kids_below_6:'1'});
  const free=hilloraParseDetails('20 Dec to 22 Dec, 1 room, resort, no pool, 2 adults', today);
  assert.deepEqual(free, {checkin:'2026-12-20', checkout:'2026-12-22', rooms:'1', requirement:'Resort', pool:'Without Pool', adults:'2'});
  const bare=hilloraParseDetails('20 Dec, 22 Dec, 1, Resort, With Pool, 2, 1, 0', today);
  assert.deepEqual(bare, {checkin:'2026-12-20', checkout:'2026-12-22', rooms:'1', requirement:'Resort', pool:'With Pool', adults:'2', kids_6_12:'1', kids_below_6:'0'});
  assert.equal(hilloraIsDetailsReply('2 adults', hilloraParseDetails('2 adults', today)), false);
  assert.equal(hilloraIsDetailsReply('20 Dec, 2 adults', hilloraParseDetails('20 Dec, 2 adults', today)), true);
  assert.equal(hilloraIsDetailsReply('is the pool open?', hilloraParseDetails('is the pool open?', today)), false);
});

test('staff chat link names the unit and dates', ()=>{
  const link=hilloraStaffLink('+91 98765 43210', {unit:'Pool Villa', f:{checkin:'2026-12-20', checkout:'2026-12-22'}});
  assert.equal(link, 'https://wa.me/919876543210?text='+encodeURIComponent("Hi, I'd like to book Pool Villa (2026-12-20 to 2026-12-22)."));
  assert.equal(hilloraStaffLink(''), '');
  assert.equal(hilloraStaffLink('123'), '');
});

test('details become qual answers and a summary for the team', ()=>{
  const f={checkin:'2026-12-20', rooms:'1', adults:'2'};
  const q=hilloraQual(f, 'Pool Villa');
  assert.equal(q.hillora_unit, 'Pool Villa');
  assert.equal(q.hillora_checkin, '2026-12-20');
  assert.equal(q.travel_month, '2026-12');
  const lines=hilloraSummaryLines(f, 'Pool Villa');
  assert.equal(lines[0], 'Unit: Pool Villa');
  assert.ok(lines.includes('Check-out Date: —'));
  assert.ok(lines.includes('Adults (Above 12 years): 2'));
});

test('the handover lifts after 2 days; a teammate\'s manual takeover does not', ()=>{
  const now=Date.parse('2026-11-21T12:00:00Z');
  const at=iso=>({Handover:'Yes', HandoverAt:iso, Stage:'human_handover'});
  assert.equal(hilloraHandoverExpired(at(new Date(now-HILLORA_HANDOVER_MS+60000).toISOString()), now), false);
  assert.equal(hilloraHandoverExpired(at(new Date(now-HILLORA_HANDOVER_MS).toISOString()), now), true);
  assert.equal(hilloraHandoverExpired({Handover:'No', HandoverAt:'2026-01-01'}, now), false);
  assert.equal(hilloraHandoverExpired({Handover:'Yes', HandoverAt:''}, now), false);
  assert.equal(hilloraHandoverLiftable({...at('2026-11-01T00:00:00Z'), HandoverBy:'staff@x.com'}, now), false);
  assert.equal(hilloraHandoverLiftable(at('2026-11-01T00:00:00Z'), now), true);
});

test('lifting marks the lead new, unless the team moved its stage on', ()=>{
  assert.deepEqual(hilloraReleasePatch({Stage:'human_handover'}), {Handover:'No', HandoverBy:'', HandoverAt:'', SlaAlerted:'No', Stage:'new'});
  assert.equal(hilloraReleasePatch({Stage:'booked'}).Stage, undefined);
  assert.equal(hilloraReleasePatch({Stage:'booked'}).Handover, 'No');
});

// ── worker.js: silence while handed over, and the 2-day lift ──
import { afterEach } from 'node:test';
import { engineHandoverSilenceTurn, hilloraReleaseProcessClient } from './worker.js';
const realFetch=globalThis.fetch;
afterEach(()=>{ globalThis.fetch=realFetch; });
function fakeDb(){
  const sql=[];
  const stmt=q=>({ bind(...a){ return {...stmt(q), args:a}; }, async run(){ sql.push(q); return {meta:{changes:1,last_row_id:1}}; }, async first(){ sql.push(q); return null; }, async all(){ sql.push(q); return {results:[]}; } });
  return { sql, prepare:q=>stmt(q), async batch(list){ return Promise.all(list.map(s=>s.run())); } };
}
function setup(lead, listLeads=[]){
  const nc=[], chatwoot=[];
  globalThis.fetch=async(url,opts={})=>{
    const u=String(url),method=opts.method||'GET';
    if(u.startsWith('https://nc.test')){ nc.push({u,method,body:opts.body?JSON.parse(opts.body):null}); return Response.json(method==='GET'?{list:/Handover,eq,Yes/.test(decodeURIComponent(u))?listLeads:[],columns:[]}:{Id:lead?.Id||1}); }
    if(u.startsWith('https://cw.test')){ chatwoot.push({u, body:opts.body}); return Response.json({}); }
    return Response.json({});
  };
  const env={DB:fakeDb(),NOCODB_BASE:'https://nc.test',NOCODB_TOKEN:'t'};
  const state={lead, leadId:lead?.Id||null, stage:lead?.Stage||'new', history:[], phone:'+919800000001', inboxId:'5'};
  const parsed={phone:'+919800000001',name:'Asha',convId:'77',mediaType:'text',mediaUrl:'',channel:'whatsapp'};
  return {env,state,parsed,nc,chatwoot};
}
const hc={Id:7, hospitality_enabled:'Yes', hospitality_style:'hillora', industry:'hospitality', chatwoot_base:'https://cw.test', chatwoot_account_id:'1', chatwoot_token:'x'};

test('Hillora: handed over less than 2 days ago → silent (message saved, no reply)', async()=>{
  const lead={Id:42, Stage:'human_handover', Handover:'Yes', HandoverAt:new Date(Date.now()-3600e3).toISOString()};
  const {env,state,parsed}=setup(lead);
  const r=await engineHandoverSilenceTurn(env, hc, '7', {id:'m1'}, state, parsed, 'any update?');
  assert.equal((await r.json()).skipped, 'hillora-handover');
});

test('Hillora: after 2 days the handover lifts on the next message, the lead is new and the bot answers', async()=>{
  const lead={Id:42, Stage:'human_handover', Handover:'Yes', HandoverAt:new Date(Date.now()-HILLORA_HANDOVER_MS-60e3).toISOString(), ConversationID:'77'};
  const {env,state,parsed,nc}=setup(lead);
  const r=await engineHandoverSilenceTurn(env, hc, '7', {id:'m1'}, state, parsed, 'hi');
  assert.equal(r, null);
  const patch=nc.find(x=>x.method==='PATCH' && x.body?.Handover==='No');
  assert.ok(patch);
  assert.equal(patch.body.Stage, 'new');
  assert.equal(state.stage, 'new');
  assert.equal(state.hilloraFresh, true);
});

test('Hillora cron: lifts only expired bot handovers', async()=>{
  const old=new Date(Date.now()-HILLORA_HANDOVER_MS-60e3).toISOString();
  const leads=[
    {Id:1, Stage:'human_handover', Handover:'Yes', HandoverAt:old, ConversationID:'11'},
    {Id:2, Stage:'human_handover', Handover:'Yes', HandoverAt:new Date().toISOString()},
    {Id:3, Stage:'human_handover', Handover:'Yes', HandoverAt:old, HandoverBy:'staff@x.com'},
    {Id:4, Stage:'booked', Handover:'Yes', HandoverAt:old},
  ];
  const {env,nc}=setup(null, leads);
  const out=await hilloraReleaseProcessClient(env, hc);
  assert.equal(out.released, 2);
  const patched=nc.filter(x=>x.method==='PATCH' && x.body?.Handover==='No');
  assert.deepEqual(patched.map(x=>x.body.Id).sort(), [1, 4]);
  assert.equal(patched.find(x=>x.body.Id===1).body.Stage, 'new');
  assert.equal(patched.find(x=>x.body.Id===4).body.Stage, undefined);
  // Not a Hillora client → nothing.
  assert.deepEqual(await hilloraReleaseProcessClient(env, {...hc, hospitality_style:'h3'}), {released:0});
});
