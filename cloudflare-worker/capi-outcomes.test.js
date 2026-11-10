// Settings → Integrations → Meta Ads → 📤 Report to Meta: Qualified Lead, Non Qualified, Won and
// Lost are each ticked on/off and sent as the Meta event the owner picked (a standard Pixel/CAPI
// event or a custom name). Only ticked outcomes reach Meta.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, { metaCapiOutcomes, metaCapiBuildEvent } from './worker.js';

const LEADS='mvg6rcw0ia5qqrx', CLIENTS='mxl33bg4wi70fqj';
function d1(db){
  const mk=(sql)=>{ let args=[]; const st={ bind(...a){ args=a; return st; },
    async run(){ const r=db.prepare(sql).run(...args); return {meta:{changes:Number(r.changes), last_row_id:Number(r.lastInsertRowid)}}; },
    async all(){ return {results:db.prepare(sql).all(...args)}; }, async first(){ return db.prepare(sql).get(...args)||null; } }; return st; };
  return {prepare:mk, async batch(list){ const out=[]; for(const st of list) out.push(await st.run()); return out; }};
}
async function token(secret, cid=7, email='boss@biz.com'){
  const body=btoa(JSON.stringify({cid:String(cid), email, exp:Math.floor(Date.now()/1000)+3600}));
  const key=await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const sig=await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `${body}.${btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}`;
}

let db, env, origFetch, events, client, columns, graphChecks;
beforeEach(()=>{
  db=new DatabaseSync(':memory:');
  for(const f of ['0003_meta_capi_log.sql','0118_meta_ads_report.sql']) db.exec(readFileSync(new URL('./migrations/'+f, import.meta.url), 'utf8'));
  env={DB:d1(db), SESSION_SIGNING_KEY:'s', NOCODB_BASE:'https://nc.test', NOCODB_TOKEN:'t', ALLOWED_ORIGINS:'https://app.leadvyne.com'};
  events=[]; graphChecks=0; columns=['Id','meta_pixel_id','meta_capi_token'];
  client={Id:7, meta_pixel_id:'744598038086701', meta_capi_token:'EAAGood', deal_currency:'INR'};
  origFetch=globalThis.fetch;
  globalThis.fetch=async (url, opts={})=>{
    const u=String(url);
    if(u.includes('/events?access_token=')){ events.push(JSON.parse(opts.body).data[0]); return Response.json({events_received:1}); }
    if(u.startsWith('https://graph.facebook.com/')){ graphChecks++; return Response.json({data:[]}); }
    if(u.includes(`/api/v2/meta/tables/${CLIENTS}/fields`) && opts.method==='POST'){ columns.push(JSON.parse(opts.body).title); return Response.json({}); }
    if(u.includes(`/api/v2/meta/tables/${CLIENTS}`)) return Response.json({columns:columns.map(title=>({title, column_name:title}))});
    if(u.includes(`/tables/${CLIENTS}/records`) && opts.method==='PATCH'){
      for(const [k,v] of Object.entries(JSON.parse(opts.body))) if(columns.includes(k)) client[k]=v;
      return Response.json({Id:7});
    }
    if(u.includes(`/tables/${CLIENTS}/records/7`)) return Response.json(client);
    if(u.match(new RegExp(`/tables/${LEADS}/records/41$`))) return Response.json({Id:41, ClientId:'7', Phone:'919876543210', DealValue:'9000', CtwaClid:'ARAk'});
    return Response.json({list:[]});
  };
});
afterEach(()=>{ globalThis.fetch=origFetch; db.close(); });

async function call(path, body){
  const r=await worker.fetch(new Request('https://worker.test'+path, {method:body?'POST':'GET',
    headers:{Authorization:`Bearer ${await token(env.SESSION_SIGNING_KEY)}`, 'Content-Type':'application/json'}, body:body?JSON.stringify(body):undefined}), env, {});
  return {status:r.status, data:await r.json().catch(()=>null)};
}

test('defaults: what was always sent — Qualified, Non Qualified, Won on; Lost off', ()=>{
  assert.deepEqual(metaCapiOutcomes(undefined), {
    qualified:{on:true, event:'QualifiedLead'}, non_qualified:{on:true, event:'DisqualifiedLead'},
    won:{on:true, event:'Purchase'}, lost:{on:false, event:'LostLead'}});
  assert.deepEqual(metaCapiOutcomes('{"lost":{"on":true,"event":"Bad name!"}}').lost, {on:true, event:'Badname'});
});

test('only ticked outcomes are sent, each as the event the owner picked', async ()=>{
  const save=await call('/meta/capi/config', {meta_capi_outcomes:{qualified:{on:true, event:'SubmitApplication'}, non_qualified:{on:false}, won:{on:true, event:'Purchase'}, lost:{on:true, event:'LostLead'}}});
  assert.equal(save.status, 200);
  assert.equal(graphChecks, 0, 'ticking outcomes does not re-check the token with Meta');
  assert.equal(save.data.meta_capi_outcomes.qualified.event, 'SubmitApplication');
  for(const event of ['qualified','disqualified','purchase','lost']) assert.equal((await call('/meta/capi/lead-event', {lead_id:41, event, ...(event==='purchase'?{value:9000}:{})})).status, 200);
  assert.deepEqual(events.map(e=>e.event_name), ['SubmitApplication','Purchase','LostLead']);
  assert.deepEqual(events[1].custom_data, {value:9000, currency:'INR'});
  // Logged under the same keys whatever the name, so Ads ROI reports keep counting them.
  assert.deepEqual(db.prepare('SELECT event FROM meta_capi_events ORDER BY id').all().map(r=>r.event), ['qualified','purchase','lost']);
  const st=await call('/meta/capi/status');
  assert.equal(st.data.outcomes.non_qualified.on, false);
  assert.ok(st.data.standard_events.includes('CompleteRegistration'));
});

test('Won mapped to another event still carries the value; Purchase on any outcome carries it', ()=>{
  const c={meta_capi_outcomes:JSON.stringify({won:{on:true, event:'CompleteRegistration'}, qualified:{on:true, event:'Purchase'}})};
  const won=metaCapiBuildEvent(c, 'purchase', {Id:1, CtwaClid:'x'}, {value:500, currency:'inr'}).event;
  assert.equal(won.event_name, 'CompleteRegistration');
  assert.deepEqual(won.custom_data, {value:500, currency:'INR'});
  const q=metaCapiBuildEvent({...c, deal_currency:'AED'}, 'qualified', {Id:1, CtwaClid:'x'}).event;
  assert.equal(q.event_name, 'Purchase');
  assert.deepEqual(q.custom_data, {value:0, currency:'AED'});
});
