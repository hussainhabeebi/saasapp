// 📲 Travel CRM tools (travel-crm.js): off unless a travel agency account turns it on; travel dates →
// Upcoming / Travelling / Completed; WhatsApp numbers; WhatsApp Business app replies into Chats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  travelCrmOn, travelCrmNormRoute, travelCrmConfig, travelCrmParseTrips, travelCrmLeadTrips, travelCrmTripStatus,
  travelCrmLeadTripStatus, travelCrmNextDate, travelCrmTripPatch, travelCrmTripStatusProcessClient, travelCrmNumbers,
  travelCrmParseEchoes, travelCrmEchoSeen, travelCrmProcessEchoes, TCRM_APP_SENDER, TCRM_DEFAULT_ROUTES,
  travelCrmSettingsView, travelCrmSettingsPatch, travelCrmTripsOn, travelCrmMergeDetection, travelCrmDetectHistory,
} from './travel-crm.js';
import { engineStaffSender, travelCrmDetectText, travelCrmRouteOf, TRAVEL_CRM_PARSERS, engineTravelCrmDetectLater } from './worker.js';

const ON={Id:7, industry:'travel', travel_crm_enabled:'Yes'};

test('only travel agency accounts that switched it on', ()=>{
  assert.equal(travelCrmOn(ON), true);
  assert.equal(travelCrmOn({industry:'travel'}), false);
  assert.equal(travelCrmOn({industry:'travel', travel_crm_enabled:'No'}), false);
  assert.equal(travelCrmOn({industry:'ecommerce', travel_crm_enabled:'Yes'}), false);
  assert.equal(travelCrmOn({industry:'general', ta_enabled:'Yes', travel_crm_enabled:'yes'}), true);
});

test('routes are written one way, however they are typed', ()=>{
  assert.equal(travelCrmNormRoute('calicut to dubai'), 'Calicut → Dubai');
  assert.equal(travelCrmNormRoute('Calicut-Sharjah'), 'Calicut → Sharjah');
  assert.equal(travelCrmNormRoute('Kochi > Dubai'), 'Kochi → Dubai');
  assert.equal(travelCrmNormRoute('CCJ -> DXB'), 'CCJ → DXB');
  assert.equal(travelCrmNormRoute('Kochi → Ras Al-Khaimah'), 'Kochi → Ras Al-Khaimah');
  assert.equal(travelCrmNormRoute('Ras Al-Khaimah'), 'Ras Al-Khaimah');
  assert.equal(travelCrmNormRoute('  '), '');
});

test('settings fall back to the defaults and drop blanks / repeats', ()=>{
  assert.deepEqual(travelCrmConfig({}).routes, TCRM_DEFAULT_ROUTES);
  const cfg=travelCrmConfig({travel_crm_config:JSON.stringify({routes:['calicut to doha','Calicut → Doha',''], enquiry_types:['Visa','Visa',' Ticket ']})});
  assert.deepEqual(cfg.routes, ['Calicut → Doha']);
  assert.deepEqual(cfg.enquiry_types, ['Visa','Ticket']);
  assert.ok(travelCrmConfig({travel_crm_config:'not json'}).enquiry_types.length>0);
});

test('trips: TravelTrips, else the older TravelDates field', ()=>{
  assert.deepEqual(travelCrmParseTrips('[{"id":"a","route":"kochi to dubai","depart":"2026-12-01","ret":"2026-12-09"},{"note":"no dates"}]'),
    [{id:'a', route:'Kochi → Dubai', depart:'2026-12-01', ret:'2026-12-09', note:''}]);
  assert.deepEqual(travelCrmLeadTrips({TravelDates:'2026-10-01 → 2026-10-05'}).map(t=>[t.depart,t.ret]), [['2026-10-01','2026-10-05']]);
  assert.deepEqual(travelCrmLeadTrips({TravelDates:'2026-10-01'}).map(t=>[t.depart,t.ret]), [['2026-10-01','']]);
  assert.deepEqual(travelCrmLeadTrips({TravelDates:'next month'}), []);
});

test('a trip is Completed once its last day has passed', ()=>{
  const T='2026-11-10';
  assert.equal(travelCrmTripStatus({depart:'2026-11-20', ret:'2026-11-25'}, T), 'Upcoming');
  assert.equal(travelCrmTripStatus({depart:'2026-11-08', ret:'2026-11-12'}, T), 'Travelling');
  assert.equal(travelCrmTripStatus({depart:'2026-11-10', ret:''}, T), 'Travelling');
  assert.equal(travelCrmTripStatus({depart:'2026-11-01', ret:'2026-11-09'}, T), 'Completed');
  assert.equal(travelCrmTripStatus({depart:'2026-11-09', ret:''}, T), 'Completed');
  const lead={TravelTrips:JSON.stringify([{depart:'2026-01-01', ret:'2026-01-05'}, {depart:'2027-02-01'}])};
  assert.equal(travelCrmLeadTripStatus(lead, T), 'Upcoming');
  assert.equal(travelCrmNextDate(lead, T), '2027-02-01');
  assert.equal(travelCrmLeadTripStatus(lead, '2027-03-01'), 'Completed');
  assert.equal(travelCrmNextDate(lead, '2027-03-01'), '2027-02-01');
  assert.equal(travelCrmLeadTripStatus({}, T), '');
});

test('the daily run only patches leads whose status moved, and not when route & dates are switched off', async ()=>{
  const leads=[
    {Id:1, TravelTrips:JSON.stringify([{depart:'2026-11-01', ret:'2026-11-05'}]), TripStatus:'Upcoming', NextTravelDate:'2026-11-01'},
    {Id:2, TravelTrips:JSON.stringify([{depart:'2026-12-01'}]), TripStatus:'Upcoming', NextTravelDate:'2026-12-01'},
    {Id:3, TravelDates:'2026-10-01 → 2026-10-03'},
  ];
  const patched=[], told=[];
  const deps={listLeads:async ()=>leads, patch:async rows=>patched.push(...rows), broadcast:async (cid, m)=>told.push(m)};
  const now=new Date('2026-11-10T03:00:00Z');
  assert.deepEqual(await travelCrmTripStatusProcessClient({...ON, travel_trips_enabled:'No'}, deps, now), {updated:0});
  assert.deepEqual(await travelCrmTripStatusProcessClient({Id:9, industry:'ecommerce'}, deps, now), {updated:0});
  assert.equal(patched.length, 0);
  assert.deepEqual(await travelCrmTripStatusProcessClient(ON, deps, now), {updated:2});
  assert.deepEqual(patched, [
    {Id:1, TripStatus:'Completed', NextTravelDate:'2026-11-01'},
    {Id:3, TripStatus:'Completed', NextTravelDate:'2026-10-01'},
  ]);
  assert.deepEqual(told[0].lead_ids, [1,3]);
  assert.equal(travelCrmTripPatch(leads[1], '2026-11-10'), null);
});

test('WhatsApp numbers come from the WhatsApp inboxes, with saved numbers filling gaps', ()=>{
  const n=travelCrmNumbers([
    {id:11, name:'Sales', channel_type:'Channel::Whatsapp', phone_number:'+971500000001'},
    {id:12, name:'Web chat', channel_type:'Channel::WebWidget'},
    {id:13, name:'Visa desk', channel_type:'Channel::Whatsapp'},
  ], [{inbox_id:'13', display_phone:'+971500000003'}, {inbox_id:'14', display_phone:'+971500000004'}]);
  assert.deepEqual(n, [
    {inbox_id:'11', name:'Sales', phone:'+971500000001'},
    {inbox_id:'13', name:'Visa desk', phone:'+971500000003'},
    {inbox_id:'14', name:'', phone:'+971500000004'},
  ]);
});

const echoBody=(messages, pid='PID1')=>({object:'whatsapp_business_account', entry:[{id:'WABA', changes:[
  {field:'smb_message_echoes', value:{messaging_product:'whatsapp', metadata:{phone_number_id:pid}, message_echoes:messages}},
  {field:'messages', value:{metadata:{phone_number_id:pid}, messages:[{from:'971500000009', text:{body:'customer'}}]}},
]}]});

test('echo webhook: only the business app replies are read', ()=>{
  const out=travelCrmParseEchoes(echoBody([
    {from:'971400000000', to:'919800000001', id:'wamid.1', timestamp:'1794268800', type:'text', text:{body:'Your Dubai visa is approved ✅'}},
    {from:'971400000000', to:'919800000001', id:'wamid.2', timestamp:'1794268801', type:'image', image:{caption:'Ticket'}},
    {from:'971400000000', to:'919800000001', id:'wamid.3', timestamp:'1794268802', type:'document', document:{}},
  ]));
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], {phone_number_id:'PID1', to:'919800000001', id:'wamid.1', ts:new Date(1794268800000).toISOString(), text:'Your Dubai visa is approved ✅'});
  assert.equal(out[1].text, '[image] Ticket');
  assert.equal(out[2].text, '[document]');
  assert.deepEqual(travelCrmParseEchoes({object:'page'}), []);
});

test('echo webhook: saved into the chat as a team reply, once', async ()=>{
  const inserted=[], marked=[];
  const thread=[{content:'Hi, how can we help?'}];
  const deps={
    clientForPhoneNumberId:async pid=>pid==='PID1'?ON:pid==='PID2'?{Id:8, industry:'travel'}:null,
    leadForPhone:async (cid, d)=>d==='919800000001'?{Id:41}:null,
    recentAssistant:async ()=>thread,
    insert:async (leadId, cid, msg)=>{ inserted.push({leadId, cid, msg}); thread.unshift({content:msg.content}); },
    markAgentReply:async (id, ts)=>marked.push(id),
  };
  const msg={from:'971400000000', to:'919800000001', id:'wamid.1', timestamp:'1794268800', type:'text', text:{body:'Your Dubai visa is approved'}};
  const r=await travelCrmProcessEchoes(echoBody([msg, {...msg, id:'wamid.1b'}, {...msg, to:'919800000099'}]), deps);
  assert.deepEqual(r, {received:3, saved:1});
  assert.equal(inserted[0].leadId, 41);
  assert.deepEqual({role:inserted[0].msg.role, content:inserted[0].msg.content, sender_type:inserted[0].msg.sender_type, sender_name:inserted[0].msg.sender_name},
    {role:'assistant', content:'Your Dubai visa is approved', sender_type:'agent', sender_name:TCRM_APP_SENDER});
  assert.deepEqual(marked, [41]);
  // An account without the setting on gets nothing.
  assert.deepEqual(await travelCrmProcessEchoes(echoBody([{...msg, text:{body:'other text'}}], 'PID2'), deps), {received:1, saved:0});
  assert.equal(travelCrmEchoSeen('', []), true);
});

test('a reply echoed into Chatwoot with no sender is labelled only for Travel CRM accounts', ()=>{
  assert.equal(engineStaffSender({content:'x'}, ON).sender_name, TCRM_APP_SENDER);
  assert.equal(engineStaffSender({content:'x'}, {industry:'travel'}).sender_name, '');
  assert.equal(engineStaffSender({content:'x'}).sender_name, '');
  assert.equal(engineStaffSender({content:'x', sender:{name:'Asha'}}, ON).sender_name, 'Asha');
});

test('Travel Settings → 📲 Travel CRM: saves on/off and the lists, travel accounts only', ()=>{
  const TA={Id:7, industry:'travel'};
  assert.deepEqual(travelCrmSettingsView(TA), {enabled:false, trips_enabled:true, is_travel_account:true, enquiry_types:travelCrmConfig({}).enquiry_types, routes:TCRM_DEFAULT_ROUTES});
  const out=travelCrmSettingsPatch({enabled:true, enquiry_types:['Visa',' Visa ','Ticket'], routes:['calicut to doha','']}, TA);
  assert.deepEqual(out.fields, {travel_crm_enabled:'Yes', travel_trips_enabled:'Yes', travel_crm_config:JSON.stringify({enquiry_types:['Visa','Ticket'], routes:['Calicut → Doha']})});
  assert.equal(travelCrmSettingsView({...TA, ...out.fields}).enabled, true);
  // Leaving a field out keeps what is saved; empty lists fall back to the defaults.
  const off=travelCrmSettingsPatch({enabled:false}, {...TA, ...out.fields});
  assert.equal(JSON.parse(off.fields.travel_crm_config).routes[0], 'Calicut → Doha');
  assert.equal(off.fields.travel_crm_enabled, 'No');
  assert.deepEqual(JSON.parse(travelCrmSettingsPatch({routes:[]}, TA).fields.travel_crm_config).routes, TCRM_DEFAULT_ROUTES);
  assert.match(travelCrmSettingsPatch({enabled:'yes'}, TA).error, /true or false/);
  assert.match(travelCrmSettingsPatch({routes:'x'}, TA).error, /list/);
  assert.match(travelCrmSettingsPatch({enabled:true}, {industry:'ecommerce'}).error, /travel agency/);
});

test('route & travel dates are on for travel agencies unless switched off', ()=>{
  assert.equal(travelCrmTripsOn({industry:'travel'}), true);
  assert.equal(travelCrmTripsOn({industry:'travel', travel_trips_enabled:'No'}), false);
  assert.equal(travelCrmTripsOn({industry:'general', ta_enabled:'Yes'}), true);
  assert.equal(travelCrmTripsOn({industry:'ecommerce'}), false);
  assert.equal(travelCrmSettingsPatch({trips_enabled:false}, {industry:'travel'}).fields.travel_trips_enabled, 'No');
  assert.match(travelCrmSettingsPatch({trips_enabled:'no'}, {industry:'travel'}).error, /true or false/);
});

const NOW=new Date('2026-11-10T08:00:00Z');
test('a route and travel dates are read from what the customer writes', ()=>{
  assert.equal(travelCrmRouteOf('need ticket calicut to dubai'), 'Calicut → Dubai');
  assert.equal(travelCrmRouteOf('dubai kochi ticket'), 'Dubai → Kochi');
  assert.equal(travelCrmRouteOf('hi'), '');
  assert.deepEqual(travelCrmDetectText('Calicut to Dubai on 15 Dec, return 22 Dec', NOW), {route:'Calicut → Dubai', depart:'2026-12-15', ret:'2026-12-22'});
  assert.deepEqual(travelCrmDetectText('tomorrow kochi to doha', NOW), {route:'Kochi → Doha', depart:'2026-11-11'});
  assert.deepEqual(travelCrmDetectText('flight on 20/12', NOW), {depart:'2026-12-20'});
  assert.deepEqual(travelCrmDetectText('15th of january 2027 trip', NOW), {depart:'2027-01-15'});
  // Not travel dates: birth / passport dates, people counts, a fraction, past or far-off dates.
  for(const t of ['my dob 12/05/1990', 'passport expiry 15 dec 2026', '2/3 people for the trip', 'price is 1/2 off', 'we went on 5 Nov', 'hello', 'trip in Dec 2030'])
    assert.equal(travelCrmDetectText(t, NOW), null, t);
});

test('what is found becomes one auto trip and the route; later messages update it', ()=>{
  let lead={Id:5};
  const p1=travelCrmMergeDetection(lead, travelCrmDetectText('calicut to dubai', NOW), NOW);
  assert.deepEqual(p1, {TravelRoute:'Calicut → Dubai', TravelRouteBy:'auto'});   // route only: no trip yet
  lead={...lead, ...p1};
  const p2=travelCrmMergeDetection(lead, travelCrmDetectText('on 15 dec', NOW), NOW);
  const t2=JSON.parse(p2.TravelTrips);
  assert.equal(t2.length, 1);
  assert.deepEqual({route:t2[0].route, depart:t2[0].depart, ret:t2[0].ret, auto:t2[0].auto}, {route:'Calicut → Dubai', depart:'2026-12-15', ret:'', auto:true});
  assert.deepEqual({s:p2.TripStatus, n:p2.NextTravelDate}, {s:'Upcoming', n:'2026-12-15'});
  lead={...lead, ...p2};
  // The customer changes the date and adds a return: the same auto trip is updated.
  const p3=travelCrmMergeDetection(lead, travelCrmDetectText('make it 18 dec, back 25 dec', NOW), NOW);
  const t3=JSON.parse(p3.TravelTrips);
  assert.equal(t3.length, 1);
  assert.deepEqual([t3[0].depart, t3[0].ret], ['2026-12-18', '2026-12-25']);
  lead={...lead, ...p3};
  assert.equal(travelCrmMergeDetection(lead, travelCrmDetectText('18 dec', NOW), NOW), null);   // nothing new
});

test('what staff set by hand is left alone', ()=>{
  const lead={Id:5, TravelRoute:'Kochi → Doha', TravelRouteBy:'rita@agency.com',
    TravelTrips:JSON.stringify([{id:'m1', route:'Kochi → Doha', depart:'2026-12-01', ret:'2026-12-09'}])};
  const p=travelCrmMergeDetection(lead, travelCrmDetectText('calicut to dubai on 15 dec', NOW), NOW);
  assert.equal(p.TravelRoute, undefined);                      // a person's route wins
  const trips=JSON.parse(p.TravelTrips);
  assert.equal(trips.length, 2);                               // the manual trip stays; a new auto trip is added
  assert.deepEqual(trips[0], {id:'m1', route:'Kochi → Doha', depart:'2026-12-01', ret:'2026-12-09', note:''});
  assert.deepEqual([trips[1].route, trips[1].depart, trips[1].auto], ['Calicut → Dubai', '2026-12-15', true]);
  // The same date as a manual trip is not added again.
  assert.equal(travelCrmMergeDetection(lead, travelCrmDetectText('on 1 dec', NOW), NOW), null);
  // An older TravelDates value is kept as a trip when the first auto trip is added.
  const old=travelCrmMergeDetection({Id:6, TravelDates:'2026-11-20 → 2026-11-25'}, travelCrmDetectText('20 jan', NOW), NOW);
  assert.deepEqual(JSON.parse(old.TravelTrips).map(t=>[t.depart, !!t.auto]), [['2026-11-20', false], ['2027-01-20', true]]);
});

test('🔎 Find in chat reads the whole conversation, customer messages only', ()=>{
  const hist=[
    {role:'user', content:'hi, need tickets'},
    {role:'assistant', content:'Sure! Where from? e.g. Kochi to Doha on 1 Dec'},
    {role:'user', content:'calicut to sharjah'},
    {role:'user', content:'10/12 please'},
  ];
  const p=travelCrmDetectHistory({Id:7}, hist, TRAVEL_CRM_PARSERS, NOW);
  assert.equal(p.TravelRoute, 'Calicut → Sharjah');
  assert.deepEqual(JSON.parse(p.TravelTrips).map(t=>[t.route, t.depart]), [['Calicut → Sharjah', '2026-12-10']]);
  assert.equal(travelCrmDetectHistory({Id:7}, [{role:'user', content:'hello'}], TRAVEL_CRM_PARSERS, NOW), null);
});

test('a chat message is saved on its lead after the turn (worker path)', async ()=>{
  const realFetch=globalThis.fetch, patches=[];
  globalThis.fetch=async (url, opts={})=>{
    const u=String(url);
    if(u.includes('/api/v2/meta/tables/')) return Response.json({columns:[], fields:[]});
    if(u.includes('/records') && opts.method==='PATCH'){ patches.push(JSON.parse(opts.body)); return Response.json({Id:41}); }
    if(u.includes('/records')) return Response.json({list:[{Id:41, ClientId:'7', ConversationID:'900'}]});
    return Response.json({});
  };
  try{
    const env={NOCODB_BASE:'https://nc.test', NOCODB_TOKEN:'t'};
    const p=await engineTravelCrmDetectLater(env, 7, {conversation:{id:900}}, 'Calicut to Dubai 15 Dec', {wait:0});
    assert.equal(p.TravelRoute, 'Calicut → Dubai');
    const saved=patches.find(x=>x.TravelTrips);
    assert.equal(saved.Id, 41);
    assert.equal(JSON.parse(saved.TravelTrips)[0].auto, true);
    assert.equal(await engineTravelCrmDetectLater(env, 7, {conversation:{id:900}}, 'thanks', {wait:0}), null);
  }finally{ globalThis.fetch=realFetch; }
});

test('a ticket enquiry in the chat also files an anticipated trip on Trips (worker path)', async ()=>{
  const realFetch=globalThis.fetch, trips=[];
  globalThis.fetch=async (url, opts={})=>{
    const u=new URL(String(url)), m=opts.method||'GET';
    if(u.pathname.includes('/api/v2/meta/tables/trips')) return Response.json({columns:[{title:'client_id'},{title:'status'}]});
    if(u.pathname.includes('/api/v2/meta/tables/')) return Response.json({columns:[], fields:[]});
    if(u.pathname.includes('/tables/trips/records')){
      if(m==='POST'){ const r={...JSON.parse(opts.body), Id:500+trips.length}; trips.push(r); return Response.json({Id:r.Id}); }
      if(m==='PATCH'){ const b=JSON.parse(opts.body); Object.assign(trips.find(t=>t.Id===b.Id), b); return Response.json({Id:b.Id}); }
      return Response.json({list:trips});
    }
    if(u.pathname.includes('/records') && m==='PATCH') return Response.json({Id:41});
    if(u.pathname.includes('/records')) return Response.json({list:[{Id:41, ClientId:'7', ConversationID:'900', Name:'Ravi', Phone:'971500000001'}]});
    return Response.json({});
  };
  try{
    const env={NOCODB_BASE:'https://nc.test', NOCODB_TOKEN:'t'};
    const c={Id:7, industry:'travel', ta_table_ids:JSON.stringify({bookings:'trips'})};
    const when=new Date(Date.now()+30*864e5), d=`${when.getUTCDate()} ${when.toLocaleString('en-GB',{month:'short', timeZone:'UTC'})}`;
    await engineTravelCrmDetectLater(env, 7, {conversation:{id:900}}, `Calicut to Dubai ticket ${d}`, {wait:0, c});
    assert.equal(trips.length, 1);
    assert.equal(trips[0].source, 'whatsapp_chat');
    assert.equal(trips[0].status, 'requested');
    assert.equal(trips[0].service, 'Air Ticket');
    assert.equal(trips[0].destination, 'Dubai');
    assert.equal(trips[0].departure_city, 'Calicut');
    assert.equal(trips[0].lead_id, '41');
    // Without the account (older callers) nothing is filed.
    await engineTravelCrmDetectLater(env, 7, {conversation:{id:900}}, `Kochi to Doha ${d}`, {wait:0});
    assert.equal(trips.length, 1);
  }finally{ globalThis.fetch=realFetch; }
});
