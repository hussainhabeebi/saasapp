// Click-to-WhatsApp ad clicks (ctwa_clid + ad id) are saved on the lead before any early exit of
// the engine webhook, and parked in D1 when the lead row doesn't exist yet (the referral message
// was skipped, e.g. superseded by a quick second message) until the lead's first save.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { engineCaptureAdClickEarly, engineFlushPendingAdClick } from './worker.js';

function d1(db){
  const prepare=(sql)=>{ let args=[]; const st={
    bind(...a){ args=a.map(v=>v===undefined?null:v); return st; },
    async run(){ const r=db.prepare(sql).run(...args); return {meta:{changes:Number(r.changes)}}; },
    async all(){ return {results:db.prepare(sql).all(...args)}; },
    async first(){ return db.prepare(sql).get(...args)||null; } }; return st; };
  return {prepare};
}
async function withEnv(fn){
  const db=new DatabaseSync(':memory:');
  const env={NOCODB_BASE:'https://nc.test', NOCODB_TOKEN:'t', DB:d1(db)};
  const patches=[];
  const realFetch=globalThis.fetch;
  globalThis.fetch=async (url, opts={})=>{
    if(opts.method==='PATCH' && /\/records$/.test(String(url))) patches.push(JSON.parse(opts.body));
    return Response.json({list:[], columns:[]});
  };
  try{ return await fn({env, db, patches}); }
  finally{ globalThis.fetch=realFetch; }
}
const adBody=clid=>({content_attributes:{referral:{source_type:'ad', source_id:'120208877665544', ctwa_clid:clid, headline:'Name printed baby set'}}});

test('existing lead: the ad click is saved at once, with Source when the lead has none', ()=>withEnv(async ({env, patches})=>{
  const state={leadId:7, phone:'919999999999', channel:'whatsapp', lead:{Id:7}};
  await engineCaptureAdClickEarly(env, 48, adBody('ARAk-1'), state, 'Hi');
  const p=patches.find(x=>x.CtwaClid);
  assert.equal(p.Id, 7); assert.equal(p.CtwaClid, 'ARAk-1'); assert.equal(p.AdId, '120208877665544'); assert.equal(p.Source, 'Click-to-WhatsApp ad');
  assert.equal(state.adSourceSaved, true);
  // Same click again later in the turn / a redelivery: nothing new to write.
  patches.length=0;
  await engineCaptureAdClickEarly(env, 48, adBody('ARAk-1'), state, 'Hi');
  assert.equal(patches.length, 0);
}));

test('existing lead with a Source: a new ad click updates only the click ids', ()=>withEnv(async ({env, patches})=>{
  const state={leadId:8, phone:'91888', lead:{Id:8, Source:'WhatsApp', CtwaClid:'old', AdId:'120208877665544'}};
  await engineCaptureAdClickEarly(env, 48, adBody('ARAk-new'), state, 'Hi');
  assert.deepEqual(patches.find(x=>x.CtwaClid), {Id:8, AdId:'120208877665544', CtwaClid:'ARAk-new'});
}));

test('no lead yet: the click is parked and applied on the lead\'s first save', ()=>withEnv(async ({env, db, patches})=>{
  const state={leadId:null, phone:'91777', channel:'whatsapp', lead:null};
  await engineCaptureAdClickEarly(env, 48, adBody('ARAk-p'), state, 'Hello! Can I get more info on this?');
  assert.equal(patches.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM engine_pending_ad_clicks').get().n, 1);
  await engineFlushPendingAdClick(env, '48', '91777', 55);
  const p=patches.find(x=>x.CtwaClid);
  assert.equal(p.Id, 55); assert.equal(p.CtwaClid, 'ARAk-p'); assert.equal(p.AdId, '120208877665544');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM engine_pending_ad_clicks').get().n, 0);
  // Nothing pending for another contact / before the table exists: no write, no error.
  patches.length=0;
  await engineFlushPendingAdClick(env, '48', '91000', 56);
  assert.equal(patches.length, 0);
}));

test('a chat without an ad referral writes nothing', ()=>withEnv(async ({env, patches})=>{
  await engineCaptureAdClickEarly(env, 48, {content_attributes:{}}, {leadId:9, phone:'9', lead:{}}, 'hi');
  assert.equal(patches.length, 0);
}));

// ── POST /leads/ctwa/backfill: ad ids from Chatwoot's message history ──
import worker, { ctwaLatestReferral } from './worker.js';

test('ctwaLatestReferral picks the newest incoming ad referral', ()=>{
  const ref=(clid,at)=>({id:at, created_at:at, message_type:0, content_attributes:{referral:{source_type:'ad', source_id:'120208877665544', ctwa_clid:clid}}});
  assert.equal(ctwaLatestReferral([ref('old',1), {id:2, message_type:1, content_attributes:{}}, ref('new',3)]).click.CtwaClid, 'new');
  assert.equal(ctwaLatestReferral([{id:1, message_type:0, content_attributes:{}}]), null);
  // A referral on an outgoing message (an echo) is not a customer's ad click.
  assert.equal(ctwaLatestReferral([{...ref('x',1), message_type:1}]), null);
});

async function sign(secret, payload){
  const body=btoa(JSON.stringify({...payload, exp:Math.floor(Date.now()/1000)+3600}));
  const key=await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const sig=await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `${body}.${btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}`;
}
async function backfillEnv({columns=['CtwaClid','AdId','Source'], leads, chats, convRefs={}}, fn){
  const db=new DatabaseSync(':memory:');
  const env={SESSION_SIGNING_KEY:'s', NOCODB_BASE:'https://nc.test', NOCODB_TOKEN:'t', DB:d1(db)};
  const client={Id:48, authentik_email:'owner@couplo.test', chatwoot_base:'https://cw.test', chatwoot_account_id:'48', chatwoot_token:'tok'};
  const patches=[];
  const realFetch=globalThis.fetch;
  globalThis.fetch=async (url, opts={})=>{
    const u=decodeURIComponent(String(url));
    if(u.startsWith('https://cw.test/')){
      const conv=u.match(/conversations\/(\d+)$/);
      if(conv) return convRefs[conv[1]]?Response.json({id:Number(conv[1]), additional_attributes:{referral:convRefs[conv[1]]}}):Response.json({id:Number(conv[1]), additional_attributes:{}});
      const m=u.match(/conversations\/(\d+)\/messages/);
      return chats[m[1]]?Response.json({payload:chats[m[1]]}):new Response('{}', {status:404});
    }
    if(u.includes('/meta/tables/mvg6rcw0ia5qqrx')) return Response.json({columns:columns.map(title=>({title}))});
    if(u.includes('/tables/mxl33bg4wi70fqj/records/48')) return Response.json(client);
    if(opts.method==='PATCH' && u.includes('/tables/mvg6rcw0ia5qqrx/records')){ patches.push(JSON.parse(opts.body)); return Response.json({}); }
    // Like Couplo's NocoDB: a field list / blank filter naming an unknown field → 404.
    if(u.includes('/tables/mvg6rcw0ia5qqrx/records') && (u.includes('fields=')||u.includes('notblank'))) return new Response('{"msg":"Field not found"}', {status:404});
    if(u.includes('/tables/mvg6rcw0ia5qqrx/records')){
      const after=Number((u.match(/\(Id,gt,(\d+)\)/)||[])[1]||0);
      return Response.json({list:leads.filter(l=>l.Id>after)});
    }
    return Response.json({list:[]});
  };
  const token=await sign(env.SESSION_SIGNING_KEY, {cid:48, email:'owner@couplo.test'});
  const call=async body=>{
    const r=await worker.fetch(new Request('https://worker.test/leads/ctwa/backfill', {method:'POST', headers:{Authorization:`Bearer ${token}`, 'Content-Type':'application/json'}, body:JSON.stringify(body)}), env, {waitUntil(){}});
    return {status:r.status, data:await r.json()};
  };
  try{ return await fn({call, patches}); }
  finally{ globalThis.fetch=realFetch; }
}
const adMsg=(id,clid)=>({id, created_at:id, message_type:0, content:'Hello! Can I get more info on this?', content_attributes:{referral:{source_type:'ad', source_id:'120208877665544', ctwa_clid:clid, headline:'Name printed baby set'}}});

test('backfill fills ad ids from Chatwoot history, skipping leads that have them or no ad', ()=>backfillEnv({
  leads:[{Id:1, ConversationID:'3243', Source:''}, {Id:2, ConversationID:'3244', Source:'WhatsApp'}, {Id:3, ConversationID:'3245', CtwaClid:'have'}],
  chats:{'3243':[adMsg(10,'ARAk-a'), {id:11, message_type:1, content_attributes:{}}], '3244':[{id:20, message_type:0, content_attributes:{}}]},
}, async ({call, patches})=>{
  const {status, data}=await call({after_id:0, limit:40});
  assert.equal(status, 200);
  assert.equal(data.saved, 1); assert.equal(data.already, 1); assert.equal(data.no_referral, 1); assert.equal(data.done, true);
  const p=patches.find(x=>x.CtwaClid);
  assert.equal(p.Id, 1); assert.equal(p.CtwaClid, 'ARAk-a'); assert.equal(p.AdId, '120208877665544'); assert.equal(p.Source, 'Click-to-WhatsApp ad');
}));

test('check mode shows the referral Chatwoot holds for one chat', ()=>backfillEnv({leads:[], chats:{'3243':[adMsg(10,'ARAk-abcdefghijklmnop')]}}, async ({call})=>{
  const {data}=await call({conversation_id:'3243'});
  assert.equal(data.referrals.length, 1);
  assert.equal(data.referrals[0].source_id, '120208877665544');
  assert.match(data.referrals[0].ctwa_clid, /^ARAk-abcdefg/);
  assert.deepEqual(data.would_save, {AdId:'120208877665544', CtwaClid:'ARAk-abcdefghijklmnop'});
}));

test('missing CtwaClid column is reported instead of silently dropping the ids', ()=>backfillEnv({columns:['Source'], leads:[{Id:1, ConversationID:'3243'}], chats:{}}, async ({call, patches})=>{
  const {status, data}=await call({});
  assert.equal(status, 409);
  assert.match(data.error, /CtwaClid/);
  assert.equal(patches.length, 0);
}));

// Newer Chatwoot keeps the ad on the conversation (the "Ad" card at the top of the chat), not on
// the message — Couplo's case.
import { engineLeadAdClick as adClick } from './worker.js';
const convRef={source_type:'ad', source_id:'120208877665544', ctwa_clid:'ARAk-conv', headline:'Name printed baby set'};

test('live webhook: an ad on conversation.additional_attributes.referral is read', ()=>{
  const body={id:5, content:'Hi', content_attributes:{}, conversation:{id:3243, additional_attributes:{referral:convRef}}};
  assert.deepEqual(adClick(body), {AdId:'120208877665544', CtwaClid:'ARAk-conv'});
  // The message's own referral wins when both exist.
  const both={...body, content_attributes:{referral:{...convRef, ctwa_clid:'ARAk-msg'}}};
  assert.equal(adClick(both).CtwaClid, 'ARAk-msg');
  assert.equal(adClick({conversation:{additional_attributes:{referral:{}}}}), null);
});

test('backfill and check read the conversation-level ad referral', ()=>backfillEnv({
  leads:[{Id:1, ConversationID:'3243', Source:''}], chats:{'3243':[{id:10, message_type:0, content:'Hi', content_attributes:{}}]}, convRefs:{'3243':convRef},
}, async ({call, patches})=>{
  const check=await call({conversation_id:'3243'});
  assert.equal(check.data.referrals[0].message_id, 'conversation');
  assert.deepEqual(check.data.would_save, {AdId:'120208877665544', CtwaClid:'ARAk-conv'});
  const {data}=await call({after_id:0});
  assert.equal(data.saved, 1);
  const p=patches.find(x=>x.CtwaClid);
  assert.equal(p.Id, 1); assert.equal(p.CtwaClid, 'ARAk-conv'); assert.equal(p.AdId, '120208877665544');
}));
