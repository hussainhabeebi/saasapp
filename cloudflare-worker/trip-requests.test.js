// Trip requests: bot travel details → a draft trip on Trips (trip-requests.js + tripRequestSync).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tripRequestFields, tripRequestEligible, tripRequestMissing, tripRequestRecord, tripRequestDiff, tripRequestPlan,
  tripRouteOwner, tripLeadFields, tripSummaryLine, tripPaxLabel, samePhone, sameDestination,
  tripChatService, tripChatFields, tripChatEligible, tripChatRecord, tripChatSummary, tripChatDiff, TRIP_SOURCE_CHAT } from './trip-requests.js';
import { tripRequestSync, tripChatSync, hotLeadAlertReasonText } from './worker.js';
import { flyindoQualAnswers } from './flyindo-flow.js';

const NOW=new Date('2026-11-08T10:00:00Z');

describe('fields', ()=>{
  test('flyindo answers', ()=>{
    const f=tripRequestFields({destination:'Kashmir',travel_date:'2027-04-29',adults:'5',children:'0'});
    assert.equal(f.destination,'Kashmir'); assert.equal(f.travel_month,'2027-04');
    assert.equal(tripSummaryLine(f),'Kashmir · 29 Apr 2027 · 5A');
    assert.deepEqual(tripRequestMissing(f),[]);
  });
  test('travel flow answers: package stands in for destination', ()=>{
    const f=tripRequestFields({package:'Bali Honeymoon',travel_date:'2027-01-10',adults:'2',children:'1',infants:'1'});
    assert.equal(f.destination,'Bali Honeymoon'); assert.equal(tripPaxLabel(f),'2A + 1C + 1I');
  });
  test('partial: month only', ()=>{
    const f=tripRequestFields({destination:'Goa',travel_date:'',travel_month:'2027-02',adults:'',children:'0'});
    assert.ok(tripRequestEligible(f));
    assert.deepEqual(tripRequestMissing(f),['exact date','travellers']);
    assert.equal(tripSummaryLine(f),'Goa · Feb 2027');
  });
  test('destination alone is not enough', ()=>{
    assert.equal(tripRequestEligible(tripRequestFields({destination:'Goa',children:'0'})),false);
    assert.equal(tripRequestEligible(tripRequestFields({adults:'2'})),false);
  });
  test('flyindo keeps the month while the day is still open', ()=>{
    assert.equal(flyindoQualAnswers({destination:'Goa',month:'2027-02',ages:[]}).travel_month,'2027-02');
    assert.equal(flyindoQualAnswers({destination:'Goa',date:'2027-02-03',ages:[]}).travel_month,undefined);
  });
});

describe('record and diff', ()=>{
  const f=tripRequestFields({destination:'Kashmir',travel_date:'2027-04-29',adults:'5',children:'0'});
  test('record', ()=>{
    const r=tripRequestRecord(f,{name:'Asha',phone:'919876543210',leadId:42,owner:'Rep@x.com',now:NOW});
    assert.equal(r.status,'requested'); assert.equal(r.pax,5); assert.equal(r.departure_date,'2027-04-29');
    assert.equal(r.lead_id,'42'); assert.equal(r.assigned_to,'rep@x.com'); assert.equal(r.missing_info,'');
    assert.equal(r.package_name,'Kashmir'); assert.equal(r.source,'whatsapp_bot');
  });
  test('no name → phone', ()=>{
    assert.equal(tripRequestRecord(f,{phone:'91 98765',now:NOW}).client_name,'+9198765');
  });
  test('changes are listed, first fills are not', ()=>{
    const existing={destination:'Kashmir',departure_date:'2027-04-29',travel_month:'2027-04',adults:'5',children:'',pax:5,missing_info:'',package_name:'Kashmir'};
    const next=tripRequestRecord(tripRequestFields({destination:'Kashmir',travel_date:'2027-04-29',adults:'6',children:'2'}),{now:NOW});
    const {patch,changes}=tripRequestDiff(existing,next);
    assert.equal(patch.adults,'6'); assert.equal(patch.children,'2'); assert.equal(patch.pax,8);
    assert.deepEqual(changes,['Adults: 5 → 6']);
  });
  test('a date is never blanked', ()=>{
    const {patch}=tripRequestDiff({departure_date:'2027-04-29'},tripRequestRecord(tripRequestFields({destination:'X',travel_month:'2027-04',adults:'2'}),{now:NOW}));
    assert.ok(!('departure_date' in patch));
  });
});

describe('plan', ()=>{
  const req={leadId:42,phone:'+91 98765 43210',destination:'Kashmir'};
  test('own open trip before quote → update', ()=>{
    assert.equal(tripRequestPlan([{Id:1,lead_id:'42',destination:'Kashmir',status:'requested'}],req).action,'update');
  });
  test('own quoted trip → note only', ()=>{
    assert.equal(tripRequestPlan([{Id:1,lead_id:'42',destination:'Kashmir',status:'quoted'}],req).action,'note');
  });
  test('closed trips are ignored', ()=>{
    assert.deepEqual(tripRequestPlan([{Id:1,lead_id:'42',destination:'Kashmir',status:'cancelled'}],req),{action:'create',duplicateOf:''});
  });
  test('hand-made trip for the same phone + place → duplicate flag', ()=>{
    assert.deepEqual(tripRequestPlan([{Id:7,client_phone:'9876543210',package_name:'Kashmir Delight',status:'quoted'}],req),{action:'create',duplicateOf:'7'});
  });
  test('another destination → new trip, no flag', ()=>{
    assert.deepEqual(tripRequestPlan([{Id:1,lead_id:'42',destination:'Goa',status:'requested'}],req),{action:'create',duplicateOf:''});
  });
  test('phone / destination matching', ()=>{
    assert.ok(samePhone('+971 50 123 4567','0501234567'));
    assert.ok(!samePhone('123','123'));
    assert.ok(sameDestination('kashmir','Kashmir Delight'));
    assert.ok(!sameDestination('Goa',''));
  });
});

describe('routing and lead fields', ()=>{
  const routing={enabled:true,modes:['product','roundrobin'],rules:{'a@x.com':{products:['Kashmir','Ladakh']},'b@x.com':{products:['Dubai']}}};
  test('destination rule', ()=>{
    assert.equal(tripRouteOwner(routing,'Kashmir'),'a@x.com');
    assert.equal(tripRouteOwner(routing,'Bali'),'');
    assert.equal(tripRouteOwner({...routing,enabled:false},'Kashmir'),'');
    assert.equal(tripRouteOwner(routing,'Kashmir',e=>e!=='a@x.com'),'');
  });
  test('lead fields', ()=>{
    assert.deepEqual(tripLeadFields(tripRequestFields({destination:'Goa',travel_month:'2027-02',adults:'2',children:'1'})),{Destination:'Goa',TravelDates:'2027-02',PaxCount:'3'});
  });
  test('alert text', ()=>{
    assert.equal(hotLeadAlertReasonText('trip_request','Kashmir · 29 Apr 2027 · 5A'),'sent a trip request: Kashmir · 29 Apr 2027 · 5A');
  });
});

// tripRequestSync end to end against an in-memory Trips table (NocoDB REST stubbed).
function nocoStub(rows=[]){
  const calls=[], leads=[];
  const cols=new Set(['client_id','client_name','client_phone','package_name','departure_date','pax','status','notes']);
  let nextId=100;
  const fetch=async(url,opts={})=>{
    const u=new URL(url), method=opts.method||'GET', body=opts.body?JSON.parse(opts.body):null;
    calls.push({method,path:u.pathname,body});
    const ok=d=>new Response(JSON.stringify(d),{status:200,headers:{'content-type':'application/json'}});
    if(u.pathname.includes('/meta/tables/') && /\/(fields|columns)$/.test(u.pathname)){ cols.add(body.title); return ok({}); }
    if(u.pathname.includes('/meta/tables/')) return ok({columns:[...cols].map(title=>({title}))});
    if(u.pathname.includes('/tables/trips/records')){
      if(method==='GET'){
        const w=u.searchParams.get('where')||'';
        const lead=(w.match(/\(lead_id,eq,([^)]*)\)/)||[])[1];
        const like=(w.match(/\(client_phone,like,%([^%]*)%\)/)||[])[1];
        return ok({list:rows.filter(r=>lead?String(r.lead_id)===lead:like?String(r.client_phone||'').includes(like):false)});
      }
      if(method==='POST'){ const r={...body,Id:nextId++}; rows.push(r); return ok({Id:r.Id}); }
      if(method==='PATCH'){ const r=rows.find(x=>x.Id===body.Id); Object.assign(r,body); return ok({Id:r.Id}); }
    }
    if(u.pathname.includes('/records')){ leads.push(body); return ok({Id:body?.Id||1}); }
    return ok({});
  };
  return {fetch,rows,calls,leads};
}
async function withStub(stub,fn){
  const real=globalThis.fetch; globalThis.fetch=stub.fetch;
  try{ return await fn(); }finally{ globalThis.fetch=real; }
}
const env={NOCODB_BASE:'https://noco.test',NOCODB_TOKEN:'t',DB:null};
const client={ta_table_ids:JSON.stringify({bookings:'trips'}),team_emails:'a@x.com',authentik_email:'boss@x.com',
  lead_routing:JSON.stringify({enabled:true,modes:['product'],rules:{'a@x.com':{products:['Kashmir']}}})};

describe('tripRequestSync', ()=>{
  test('partial → draft trip, finished → same trip updated and alerted once', async()=>{
    const stub=nocoStub();
    const state={phone:'919876543210',lead:{Name:'Asha',Owner:''},convId:null};
    await withStub(stub,async()=>{
      const r1=await tripRequestSync(env,client,7,42,state,{Name:'Asha'},{destination:'Kashmir',travel_month:'2027-04',children:'0'},{complete:false});
      assert.equal(r1.created,true); assert.equal(r1.alert,null); assert.equal(r1.owner,'a@x.com');
      assert.equal(stub.rows.length,1);
      const t=stub.rows[0];
      assert.equal(t.status,'requested'); assert.equal(t.lead_id,'42'); assert.equal(t.missing_info,'exact date, travellers');
      assert.equal(t.client_id,'7'); assert.match(t.notes,/has not finished/);
      assert.ok(stub.leads.some(l=>l.Owner==='a@x.com'),'lead moved to the destination owner');

      const r2=await tripRequestSync(env,client,7,42,state,{Name:'Asha'},{destination:'Kashmir',travel_date:'2027-04-29',adults:'5',children:'0'},{complete:true});
      assert.equal(r2.created,false); assert.equal(r2.alert,'Kashmir · 29 Apr 2027 · 5A');
      assert.equal(stub.rows.length,1);
      assert.equal(t.departure_date,'2027-04-29'); assert.equal(t.adults,'5'); assert.equal(t.missing_info,''); assert.ok(t.alerted_at);

      const r3=await tripRequestSync(env,client,7,42,state,{Name:'Asha'},{destination:'Kashmir',travel_date:'2027-04-29',adults:'6',children:'0'},{complete:true});
      assert.equal(r3.alert,null,'only one alert per trip');
      assert.equal(t.adults,'6'); assert.match(t.notes,/Adults: 5 → 6/);
    });
  });
  test('quoted trip keeps sales values; change goes to notes', async()=>{
    const stub=nocoStub([{Id:5,client_id:'7',lead_id:'42',destination:'Kashmir',adults:'5',status:'quoted',client_phone:'919876543210'}]);
    await withStub(stub,async()=>{
      await tripRequestSync(env,client,7,42,{phone:'919876543210',lead:{}},{},{destination:'Kashmir',travel_date:'2027-04-29',adults:'7'},{complete:true});
    });
    assert.equal(stub.rows[0].adults,'5'); assert.match(stub.rows[0].notes,/not applied/);
  });
  test('off switch and missing Trips table', async()=>{
    const stub=nocoStub();
    await withStub(stub,async()=>{
      assert.equal(await tripRequestSync(env,{...client,ta_auto_trips:'No'},7,42,{phone:'1'},{},{destination:'Goa',adults:'2'}),null);
      assert.equal(await tripRequestSync(env,{},7,42,{phone:'1'},{},{destination:'Goa',adults:'2'}),null);
    });
    assert.equal(stub.calls.length,0);
  });
});

// Anticipated trips from the chat, for every service (tripChat* + tripChatSync).
describe('chat trips — helpers', ()=>{
  test('service: the lead says, else the message, else a ticket for a route', ()=>{
    assert.equal(tripChatService({ServiceCategory:'Visa'},'Calicut to Dubai 15 Dec'),'Visa');
    assert.equal(tripChatService({EnquiryType:'Hotel Booking'},'x'),'Hotel Booking');
    assert.equal(tripChatService({},'need dubai visit visa from 20 dec'),'Visa');
    assert.equal(tripChatService({},'umrah in january'),'Umrah / Hajj');
    assert.equal(tripChatService({},'hotel in dubai 3 nights from 12 dec'),'Hotel Booking');
    assert.equal(tripChatService({},'Calicut to Dubai 15 Dec',{hasRoute:true}),'Air Ticket');
    assert.equal(tripChatService({},'15 Dec'),'');
  });
  test('fields from the auto trip: route split into from / to, return kept', ()=>{
    const f=tripChatFields({},{route:'Calicut → Dubai',depart:'2026-12-15',ret:'2026-12-22'},'Air Ticket');
    assert.equal(f.destination,'Dubai'); assert.equal(f.departure_city,'Calicut'); assert.equal(f.route,'Calicut → Dubai');
    assert.equal(f.travel_date,'2026-12-15'); assert.equal(f.return_date,'2026-12-22'); assert.equal(f.travel_month,'2026-12');
    assert.ok(tripChatEligible(f));
    // No route: the lead's destination.
    const g=tripChatFields({Destination:'Baku'},{depart:'2026-12-20'},'Visa');
    assert.equal(g.destination,'Baku'); assert.equal(g.departure_city,''); assert.ok(tripChatEligible(g));
    assert.equal(tripChatEligible(tripChatFields({},{depart:'2026-12-20'},'Visa')),false,'nowhere to go');
    assert.equal(tripChatEligible(tripChatFields({},{route:'Calicut → Dubai'},'Air Ticket')),false,'no date');
  });
  test('record and summary', ()=>{
    const f=tripChatFields({},{route:'Calicut → Dubai',depart:'2026-12-15',ret:'2026-12-22'},'Air Ticket');
    const r=tripChatRecord(f,{name:'Ravi',phone:'971500000001',leadId:9,now:NOW});
    assert.equal(r.source,TRIP_SOURCE_CHAT); assert.equal(r.status,'requested');
    assert.equal(r.package_name,'Air Ticket · Calicut → Dubai'); assert.equal(r.service,'Air Ticket');
    assert.equal(r.departure_date,'2026-12-15'); assert.equal(r.return_date,'2026-12-22'); assert.equal(r.departure_city,'Calicut');
    assert.equal(r.missing_info,'travellers');
    assert.equal(tripChatSummary(f),'Air Ticket · Calicut → Dubai · 15 Dec 2026 → 22 Dec 2026');
  });
  test('diff: own chat trip follows the chat; others only get blanks; quoted gets a note', ()=>{
    const f=tripChatFields({},{route:'Calicut → Dubai',depart:'2026-12-18'},'Air Ticket');
    const own=tripChatDiff({source:TRIP_SOURCE_CHAT,status:'requested',departure_date:'2026-12-15',destination:'Dubai',departure_city:'Calicut',service:'Air Ticket'},f);
    assert.deepEqual(own.patch,{departure_date:'2026-12-18',travel_month:'2026-12'}); assert.deepEqual(own.changes,['Travel date: 2026-12-15 → 2026-12-18']);
    const bot=tripChatDiff({source:'whatsapp_bot',status:'requested',departure_date:'2026-12-15',destination:'Dubai'},f);
    assert.deepEqual(bot.patch,{departure_city:'Calicut',service:'Air Ticket'}); assert.equal(bot.applied,false);
    const quoted=tripChatDiff({source:TRIP_SOURCE_CHAT,status:'quoted',departure_date:'2026-12-15',destination:'Dubai',departure_city:'Calicut',service:'Air Ticket'},f);
    assert.deepEqual(quoted.patch,{}); assert.equal(quoted.changes.length,1);
  });
});

describe('tripChatSync', ()=>{
  const AUTO=JSON.stringify([{id:'a1',route:'Calicut → Dubai',depart:'2026-12-15',ret:'',note:'',auto:true}]);
  const lead={Id:9,Name:'Ravi',Phone:'971500000001',TravelTrips:AUTO,TravelRoute:'Calicut → Dubai'};
  test('a ticket enquiry from the chat becomes a requested trip; a new date moves the same trip', async()=>{
    const stub=nocoStub();
    await withStub(stub,async()=>{
      const r=await tripChatSync(env,client,7,lead,'Calicut to Dubai 15 Dec ticket',{now:NOW});
      assert.equal(r.created,true);
      assert.equal(stub.rows.length,1);
      const t=stub.rows[0];
      assert.equal(t.source,'whatsapp_chat'); assert.equal(t.status,'requested'); assert.equal(t.lead_id,'9');
      assert.equal(t.service,'Air Ticket'); assert.equal(t.destination,'Dubai'); assert.equal(t.departure_date,'2026-12-15');
      assert.equal(t.lead_trip_id,'a1'); assert.match(t.notes,/Picked up from the chat/);
      // Customer moves the date — and the place: the linked trip follows.
      const moved={...lead,TravelTrips:JSON.stringify([{id:'a1',route:'Calicut → Sharjah',depart:'2026-12-18',ret:'2026-12-28',note:'',auto:true}])};
      const r2=await tripChatSync(env,client,7,moved,'make it sharjah 18 dec back 28',{now:NOW});
      assert.equal(r2.created,false); assert.equal(stub.rows.length,1);
      assert.equal(t.departure_date,'2026-12-18'); assert.equal(t.return_date,'2026-12-28'); assert.equal(t.destination,'Sharjah');
      assert.equal(t.package_name,'Air Ticket · Calicut → Sharjah'); assert.match(t.notes,/updated in chat/);
    });
  });
  test('visa / hotel enquiries are filed too, under their service', async()=>{
    const stub=nocoStub();
    await withStub(stub,async()=>{
      await tripChatSync(env,client,7,{Id:11,Phone:'919800000011',Destination:'Baku',TravelTrips:JSON.stringify([{id:'v1',depart:'2026-12-20',auto:true}])},'baku visa for 20 dec',{now:NOW});
    });
    assert.equal(stub.rows[0].service,'Visa'); assert.equal(stub.rows[0].package_name,'Visa · Baku');
  });
  test('a package already filed by the booking bot is left to the bot', async()=>{
    const stub=nocoStub([{Id:5,client_id:'7',lead_id:'9',destination:'Kashmir',status:'requested',source:'whatsapp_bot'}]);
    await withStub(stub,async()=>{
      assert.equal(await tripChatSync(env,client,7,{...lead,ServiceCategory:'Package'},'x',{now:NOW}),null);
    });
    assert.equal(stub.rows.length,1);
  });
  test('off switch, no Trips table, past or missing auto trip', async()=>{
    const stub=nocoStub();
    await withStub(stub,async()=>{
      assert.equal(await tripChatSync(env,{...client,ta_auto_trips:'No'},7,lead,'x',{now:NOW}),null);
      assert.equal(await tripChatSync(env,{},7,lead,'x',{now:NOW}),null);
      assert.equal(await tripChatSync(env,client,7,{...lead,TravelTrips:JSON.stringify([{id:'a',depart:'2026-01-02',auto:true}])},'x',{now:NOW}),null);
      assert.equal(await tripChatSync(env,client,7,{...lead,TravelTrips:JSON.stringify([{id:'m',depart:'2026-12-15'}])},'x',{now:NOW}),null,'a trip staff added by hand is theirs');
    });
    assert.equal(stub.calls.length,0);
  });
});

describe('tripRequestSync → travel profile', ()=>{
  test("the bot's travel date lands on the lead's TravelTrips for Departures", async()=>{
    const stub=nocoStub();
    const c={...client,industry:'travel'};
    await withStub(stub,async()=>{
      await tripRequestSync(env,c,7,42,{phone:'919876543210',lead:{Name:'Asha'}},{Name:'Asha'},{destination:'Kashmir',departure_city:'Kochi',travel_date:'2027-04-29',adults:'2'},{complete:true});
    });
    const lp=stub.leads.find(l=>l?.TravelTrips);
    assert.ok(lp,'lead patched with TravelTrips');
    const trips=JSON.parse(lp.TravelTrips);
    assert.equal(trips[0].depart,'2027-04-29'); assert.equal(trips[0].route,'Kochi → Kashmir'); assert.equal(trips[0].auto,true);
    assert.equal(lp.TripStatus,'Upcoming');
  });
});
