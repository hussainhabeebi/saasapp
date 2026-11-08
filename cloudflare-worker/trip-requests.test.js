// Trip requests: bot travel details → a draft trip on Trips (trip-requests.js + tripRequestSync).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tripRequestFields, tripRequestEligible, tripRequestMissing, tripRequestRecord, tripRequestDiff, tripRequestPlan,
  tripRouteOwner, tripLeadFields, tripSummaryLine, tripPaxLabel, samePhone, sameDestination } from './trip-requests.js';
import { tripRequestSync, hotLeadAlertReasonText } from './worker.js';
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
