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
