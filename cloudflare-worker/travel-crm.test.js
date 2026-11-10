// 📲 Travel CRM tools (travel-crm.js): off unless a travel agency account turns it on; travel dates →
// Upcoming / Travelling / Completed; WhatsApp numbers; WhatsApp Business app replies into Chats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  travelCrmOn, travelCrmNormRoute, travelCrmConfig, travelCrmParseTrips, travelCrmLeadTrips, travelCrmTripStatus,
  travelCrmLeadTripStatus, travelCrmNextDate, travelCrmTripPatch, travelCrmTripStatusProcessClient, travelCrmNumbers,
  travelCrmParseEchoes, travelCrmEchoSeen, travelCrmProcessEchoes, TCRM_APP_SENDER, TCRM_DEFAULT_ROUTES,
  travelCrmSettingsView, travelCrmSettingsPatch,
} from './travel-crm.js';
import { engineStaffSender } from './worker.js';

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

test('the daily run only patches leads whose status moved, and only when switched on', async ()=>{
  const leads=[
    {Id:1, TravelTrips:JSON.stringify([{depart:'2026-11-01', ret:'2026-11-05'}]), TripStatus:'Upcoming', NextTravelDate:'2026-11-01'},
    {Id:2, TravelTrips:JSON.stringify([{depart:'2026-12-01'}]), TripStatus:'Upcoming', NextTravelDate:'2026-12-01'},
    {Id:3, TravelDates:'2026-10-01 → 2026-10-03'},
  ];
  const patched=[], told=[];
  const deps={listLeads:async ()=>leads, patch:async rows=>patched.push(...rows), broadcast:async (cid, m)=>told.push(m)};
  const now=new Date('2026-11-10T03:00:00Z');
  assert.deepEqual(await travelCrmTripStatusProcessClient({...ON, travel_crm_enabled:'No'}, deps, now), {updated:0});
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
  assert.deepEqual(travelCrmSettingsView(TA), {enabled:false, is_travel_account:true, enquiry_types:travelCrmConfig({}).enquiry_types, routes:TCRM_DEFAULT_ROUTES});
  const out=travelCrmSettingsPatch({enabled:true, enquiry_types:['Visa',' Visa ','Ticket'], routes:['calicut to doha','']}, TA);
  assert.deepEqual(out.fields, {travel_crm_enabled:'Yes', travel_crm_config:JSON.stringify({enquiry_types:['Visa','Ticket'], routes:['Calicut → Doha']})});
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
