import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHealthChecks, overallHealthStatus } from './worker.js';

const env=(steps=[])=>({DB:{prepare:()=>({bind:()=>({all:async()=>({results:steps})})})}});
const byKey=rs=>Object.fromEntries(rs.map(r=>[r.key,r]));
async function withFetch(handler,fn){
  const real=globalThis.fetch;globalThis.fetch=handler;
  try{return await fn();}finally{globalThis.fetch=real;}
}
const ok=body=>new Response(JSON.stringify(body),{status:200});

test('Fresh account: optional and not-applicable items are "off", not warnings',async()=>{
  const rs=byKey(await withFetch(async()=>{throw new Error('no network expected');},()=>runHealthChecks(env(),{Id:96})));
  assert.equal(rs.whatsapp.status,'warn');
  assert.match(rs.whatsapp.hint,/Connect WhatsApp/);
  assert.equal(rs.chatwoot.status,'warn');
  for(const k of ['resend','sheet_leads','sheet_prospect','sheet_ecom_products','sheet_ecom_orders','recovery_engine'])assert.equal(rs[k].status,'off',k);
  assert.match(rs.sheet_ecom_products.detail,/E-commerce module not enabled/);
  assert.match(rs.recovery_engine.detail,/Waiting for Chatwoot/);
  assert.equal(rs.followup_config.status,'warn');
  assert.equal(overallHealthStatus(Object.values(rs)),'warn');
  // Only "off" items: healthy.
  assert.equal(overallHealthStatus([{status:'off'},{status:'ok'}]),'ok');
});

test('Connected account: detailed WhatsApp, Chatwoot, Resend and follow-up results',async()=>{
  const c={Id:5,wa_phone_id:'111',wa_token:'t',chatwoot_base:'https://cw.test/',chatwoot_account_id:'1',chatwoot_token:'x',resend_api_key:'re',
    leads_table_id:'m1',recovery_heartbeat_at:new Date(Date.now()-30*60000).toISOString(),industry:'ecommerce',ecom_products_sheet:'https://docs.google.com/spreadsheets/d/abc/edit#gid=0'};
  const rs=byKey(await withFetch(async url=>{
    const u=String(url);
    if(u.startsWith('https://graph.facebook.com/'))return ok({display_phone_number:'+971 50 000 0000',verified_name:'Acme',quality_rating:'GREEN',messaging_limit_tier:'TIER_1K',name_status:'APPROVED',code_verification_status:'VERIFIED',platform_type:'CLOUD_API'});
    if(u==='https://cw.test/api/v1/accounts/1/inboxes')return ok({payload:[{channel_type:'Channel::Whatsapp'},{channel_type:'Channel::WebWidget'}]});
    if(u==='https://api.resend.com/domains')return ok({data:[{name:'acme.com',status:'not_started'}]});
    if(u.startsWith('https://docs.google.com/'))return new Response('Name,Price\nShirt,10\nCap,5\n');
    return new Response('{}',{status:404});
  },()=>runHealthChecks(env([{step:1,type:'session',message:'hi'},{step:2,type:'template',template_name:''}]),c)));
  assert.equal(rs.whatsapp.status,'ok');
  assert.equal(rs.whatsapp.detail,'+971 50 000 0000 · "Acme" · quality High · limit 1,000/day');
  assert.equal(typeof rs.whatsapp.ms,'number');
  assert.equal(rs.followup_config.ms,undefined,'no API call, no response time');
  assert.equal(rs.chatwoot.status,'ok');
  assert.equal(rs.chatwoot.detail,'2 inbox(es): Whatsapp, WebWidget');
  assert.equal(rs.resend.status,'warn');
  assert.match(rs.resend.detail,/acme\.com \(not started\)/);
  assert.equal(rs.sheet_ecom_products.status,'ok');
  assert.equal(rs.sheet_ecom_products.detail,'2 row(s) · 2 column(s): Name, Price');
  assert.equal(rs.sheet_ecom_orders.status,'off');
  assert.equal(rs.recovery_engine.status,'ok');
  assert.match(rs.recovery_engine.detail,/Last run 30m ago/);
  assert.equal(rs.followup_config.status,'fail');
  assert.match(rs.followup_config.detail,/Step\(s\) 2 missing/);
});

test('Failures explain the cause: expired WhatsApp token, bad Chatwoot token, stale recovery engine',async()=>{
  const c={Id:6,wa_phone_id:'111',wa_token:'t',chatwoot_base:'https://cw.test',chatwoot_account_id:'1',chatwoot_token:'x',leads_table_id:'m1',recovery_heartbeat_at:new Date(Date.now()-30*3600000).toISOString()};
  const rs=byKey(await withFetch(async url=>{
    const u=String(url);
    if(u.startsWith('https://graph.facebook.com/'))return new Response(JSON.stringify({error:{code:190,message:'Session has expired'}}),{status:401});
    return new Response('{}',{status:401});
  },()=>runHealthChecks(env([{step:1,type:'session',message:'hi'}]),c)));
  assert.equal(rs.whatsapp.status,'fail');
  assert.match(rs.whatsapp.detail,/expired or revoked — Session has expired/);
  assert.match(rs.whatsapp.hint,/new permanent/);
  assert.equal(rs.chatwoot.status,'fail');
  assert.match(rs.chatwoot.detail,/invalid, expired or revoked \(HTTP 401\)/);
  assert.equal(rs.recovery_engine.status,'fail');
  assert.match(rs.recovery_engine.detail,/Last run 30h ago/);
  assert.equal(rs.followup_config.status,'ok');
  assert.equal(overallHealthStatus(Object.values(rs)),'fail');
});
