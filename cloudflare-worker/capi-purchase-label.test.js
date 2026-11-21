// "Order placed" label → Purchase to Meta (Conversions API). A lead tagged with the account's
// purchase label (default "Order placed"; Reports → 💸 Ads ROI → settings) from the dashboard (the
// /nocodb passthrough) or Chats sends one Purchase with the deal value and the strongest match key.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, { capiPurchaseFromLabels } from './worker.js';
import { marHasPurchaseLabel, marSettings } from './meta-ads-report.js';

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

let db, env, origFetch, events, leads, client;
beforeEach(()=>{
  db=new DatabaseSync(':memory:');
  for(const f of ['0003_meta_capi_log.sql','0118_meta_ads_report.sql']) db.exec(readFileSync(new URL('./migrations/'+f, import.meta.url), 'utf8'));
  env={DB:d1(db), SESSION_SIGNING_KEY:'s', NOCODB_BASE:'https://nc.test', NOCODB_TOKEN:'t', ALLOWED_ORIGINS:'https://app.leadvyne.com'};
  events=[];
  client={Id:7, client_name:'Aiingo', meta_pixel_id:'744598038086701', meta_capi_token:'EAAGood', waba_id:'WABA1', deal_currency:'INR'};
  leads={
    41:{Id:41, ClientId:'7', Phone:'919876543210', Tags:'Hot', DealValue:'4500', DealCurrency:'INR', CtwaClid:'ARAk-clid'},
    42:{Id:42, ClientId:'7', Phone:'919800000002', Tags:'', MetaLeadgenId:'1234567890123456'},
    43:{Id:43, ClientId:'99', Phone:'919800000003', Tags:''},
  };
  origFetch=globalThis.fetch;
  globalThis.fetch=async (url, opts={})=>{
    const u=String(url);
    if(u.startsWith('https://graph.facebook.com/')){ events.push({url:u, body:JSON.parse(opts.body)}); return Response.json({events_received:1}); }
    if(u.includes(`/tables/${CLIENTS}/records/7`)) return Response.json(client);
    const one=u.match(new RegExp(`/tables/${LEADS}/records/(\\d+)$`));
    if(one) return leads[one[1]]?Response.json(leads[one[1]]):Response.json({}, {status:404});
    if(u.includes(`/tables/${LEADS}/records`) && opts.method==='PATCH'){
      for(const p of [].concat(JSON.parse(opts.body))) if(leads[p.Id]) Object.assign(leads[p.Id], p);
      return Response.json({Id:41});
    }
    return Response.json({list:[]});
  };
});
afterEach(()=>{ globalThis.fetch=origFetch; db.close(); });

async function patchTags(body){
  const r=await worker.fetch(new Request(`https://worker.test/nocodb/api/v2/tables/${LEADS}/records`, {method:'PATCH',
    headers:{Authorization:`Bearer ${await token(env.SESSION_SIGNING_KEY)}`, 'Content-Type':'application/json'}, body:JSON.stringify(body)}), env, {});
  return r.status;
}
const purchases=()=>events.filter(e=>e.body.data[0].event_name==='Purchase').map(e=>e.body.data[0]);

test('tagging a lead "Order placed" in the dashboard sends one Purchase with the deal value', async ()=>{
  assert.equal(await patchTags({Id:41, Tags:'Hot, Order placed'}), 200);
  const p=purchases();
  assert.equal(p.length, 1);
  assert.deepEqual(p[0].custom_data, {value:4500, currency:'INR'});
  assert.equal(p[0].user_data.ctwa_clid, 'ARAk-clid');
  assert.equal(p[0].event_id, 'lead_41_purchase');
  assert.match(events[0].url, /\/744598038086701\/events\?access_token=EAAGood$/);
  // Saved again (another tag edit) — still one Purchase.
  assert.equal(await patchTags({Id:41, Tags:'Hot, order placed, VIP'}), 200);
  assert.equal(purchases().length, 1);
  assert.deepEqual(db.prepare(`SELECT event, lead_id, match_key FROM meta_capi_events`).all().map(r=>({...r})), [{event:'purchase', lead_id:41, match_key:'ctwa_clid'}]);
});

test('other labels, or no Pixel connected: nothing is sent', async ()=>{
  await patchTags({Id:41, Tags:'Hot, Order pending'});
  assert.equal(events.length, 0);
  client.meta_pixel_id='';
  await patchTags({Id:41, Tags:'Order placed'});
  assert.equal(events.length, 0);
});

test('an Instant Form lead goes back with its form lead id; another account\'s lead never does', async ()=>{
  const r=await capiPurchaseFromLabels(env, '7', [{Id:42, Tags:'Order placed'}, {Id:43, Tags:'Order placed'}]);
  assert.deepEqual(r.map(x=>[x.id, x.ok, x.matchKey]), [[42, true, 'lead_id']]);
  const p=purchases()[0];
  assert.equal(p.action_source, 'system_generated');
  assert.equal(p.user_data.lead_id, '1234567890123456');
  assert.deepEqual(p.custom_data, {event_source:'crm', lead_event_source:'LeadVyne', value:0, currency:'INR'});
});

test('the account\'s own purchase labels replace the default; blank switches it off', async ()=>{
  db.prepare(`INSERT INTO meta_ads_report_state (client_id, config_json) VALUES (7, ?)`).run(JSON.stringify({purchase_labels:['Paid', 'Delivered']}));
  await capiPurchaseFromLabels(env, '7', [{Id:41, Tags:'Order placed'}]);
  assert.equal(events.length, 0);
  await capiPurchaseFromLabels(env, '7', [{Id:41, Tags:'delivered'}]);
  assert.equal(purchases().length, 1);
  db.prepare(`UPDATE meta_ads_report_state SET config_json=? WHERE client_id=7`).run(JSON.stringify({purchase_labels:[]}));
  await capiPurchaseFromLabels(env, '7', [{Id:42, Tags:'Paid'}]);
  assert.equal(purchases().length, 1);
});

test('label matching and settings', ()=>{
  assert.equal(marHasPurchaseLabel('Hot,  Order Placed ', ['Order placed']), true);
  assert.equal(marHasPurchaseLabel('Order placed soon', ['Order placed']), false);
  assert.equal(marHasPurchaseLabel('', ['Order placed']), false);
  assert.deepEqual(marSettings({}).purchase_labels, ['Order placed']);
  assert.deepEqual(marSettings({purchase_labels:'Paid, paid, Delivered'}).purchase_labels, ['Paid', 'Delivered']);
  assert.deepEqual(marSettings({purchase_labels:[]}).purchase_labels, []);
});
