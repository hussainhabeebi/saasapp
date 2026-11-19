import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHealthChecks, overallHealthStatus } from './worker.js';

// D1 stand-in: rows per table (or a function of sql/binds); a table not listed doesn't exist yet.
function fakeDb(tables={}){
  const probe={};
  const route=(sql,b)=>{
    if(/health_probe/.test(sql)) return [{token:probe[b[0]]}];
    if(/SELECT 1/.test(sql)) return [{ok:1}];
    const t=(sql.match(/FROM (\w+)/)||[])[1];
    if(!(t in tables)) throw new Error(`D1_ERROR: no such table: ${t}`);
    return typeof tables[t]==='function'?tables[t](sql,b):tables[t];
  };
  return {prepare(sql){
    let binds=[];
    const st={bind(...b){binds=b;return st;}, async all(){return {results:route(sql,binds)};}, async first(){return route(sql,binds)[0]||null;},
      async run(){ if(/INSERT INTO health_probe/.test(sql)) probe[binds[0]]=binds[1]; return {meta:{}}; }};
    return st;
  }};
}
const NC='https://nc.test';
const env=(steps=[],tables={})=>({DB:fakeDb({followup_ladder_steps:steps,...tables}),SESSION_SIGNING_KEY:'k',NOCODB_BASE:NC,NOCODB_TOKEN:'t',GEMINI_API_KEY:'g',WORKER_BASE_URL:'https://w.test'});
// The CRM database (NocoDB) answering with these leads.
const nocodb=(leads=[])=>url=>{
  const u=String(url);
  if(!u.startsWith(NC)) return null;
  if(u.includes('/records/')) return ok({Id:1});
  return ok({list:leads,pageInfo:{isLastPage:true}});
};
const byKey=rs=>Object.fromEntries(rs.map(r=>[r.key,r]));
async function withFetch(handler,fn){
  const real=globalThis.fetch;globalThis.fetch=handler;
  try{return await fn();}finally{globalThis.fetch=real;}
}
const ok=body=>new Response(JSON.stringify(body),{status:200});

test('Fresh account: optional and not-applicable items are "off", not warnings',async()=>{
  const rs=byKey(await withFetch(async url=>{const r=nocodb()(url);if(r)return r;throw new Error('no network expected');},()=>runHealthChecks(env(),{Id:96})));
  assert.equal(rs.whatsapp.status,'warn');
  assert.match(rs.whatsapp.hint,/Connect WhatsApp/);
  assert.equal(rs.chatwoot.status,'warn');
  for(const k of ['resend','sheet_leads','sheet_prospect','sheet_ecom_products','sheet_ecom_orders','recovery_engine'])assert.equal(rs[k].status,'off',k);
  assert.match(rs.sheet_ecom_products.detail,/E-commerce module not enabled/);
  assert.match(rs.recovery_engine.detail,/Waiting for Chatwoot/);
  assert.equal(rs.followup_config.status,'warn');
  // Nothing to test yet on a fresh account: not tested, not failing.
  for(const k of ['webhooks','crm_lead_creation','crm_lead_assignment','crm_contacts','crm_messaging','crm_tasks','crm_campaigns','crm_reports',
    'bot_incoming','bot_responses','bot_response_time','bot_duplicates','bot_handover','n8n_workflows','followup_delivery','scheduled_messages','db_lead_updates','db_duplicates'])assert.equal(rs[k].status,'off',k);
  for(const k of ['api_auth','webhook_errors','db_connectivity','db_write'])assert.equal(rs[k].status,'ok',k);
  assert.equal(rs.bot_kb.status,'warn');
  assert.ok(!Object.values(rs).some(r=>r.status==='fail'),'a fresh account has no errors');
  assert.equal(overallHealthStatus(Object.values(rs)),'warn');
  // Only "off" items: healthy.
  assert.equal(overallHealthStatus([{status:'off'},{status:'ok'}]),'ok');
});

test('Connected account: detailed WhatsApp, Chatwoot, Resend and follow-up results',async()=>{
  const c={Id:5,wa_phone_id:'111',wa_token:'t',chatwoot_base:'https://cw.test/',chatwoot_account_id:'1',chatwoot_token:'x',resend_api_key:'re',
    leads_table_id:'m1',recovery_heartbeat_at:new Date(Date.now()-30*60000).toISOString(),industry:'ecommerce',ecom_products_sheet:'https://docs.google.com/spreadsheets/d/abc/edit#gid=0'};
  const rs=byKey(await withFetch(async url=>{
    const u=String(url);
    const nc=nocodb()(url);if(nc)return nc;
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
    const nc=nocodb()(url);if(nc)return nc;
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

const iso=msAgo=>new Date(Date.now()-msAgo).toISOString();
const H=3600000;
const botRow=(o={})=>({phone:'971500000001',conv_id:'7',user_text:'hello',route:'faq',reply:'Hi! How can I help?',ok:1,steps_json:JSON.stringify([{ms:10,step:'ai_request'},{ms:2400,step:'ai_final'}]),created_at:iso(H),...o});

test('Chatbot: responses, duplicates, response time, language and handover from the reply log',async()=>{
  const c={Id:7,wa_phone_id:'1',wa_token:'t',chatwoot_base:'https://cw.test',chatwoot_account_id:'1',chatwoot_token:'x',language:'en',kb_summary:'word '.repeat(60)};
  const rows=[
    botRow({created_at:iso(2*H)}),
    botRow({created_at:iso(2*H-60000)}), // same reply to the same chat a minute later → duplicate
    botRow({conv_id:'8',reply:'Sorry, our team will reply soon.',ok:0,created_at:iso(3*H),steps_json:JSON.stringify([{ms:40000,step:'ai_gave_up'}])}),
    botRow({conv_id:'9',route:'human',reply:'Connecting you to our team',created_at:iso(5*H)}),
  ];
  const rs=byKey(await withFetch(async url=>{
    const nc=nocodb()(url);if(nc)return nc;
    if(String(url).endsWith('/webhooks'))return ok({payload:[{id:1,url:'https://w.test/engine/webhook/abc'}]});
    return ok({});
  },()=>runHealthChecks(env([{step:1,type:'session',message:'hi'}],{bot_reply_log:(sql)=>/route='human'/.test(sql)?[{n:1,last:iso(5*H)}]:/MAX\(created_at\)/.test(sql)?[{last:iso(2*H)}]:rows,hot_lead_alerts:[{status:'sent'},{status:'failed'}]}),c)));
  assert.equal(rs.bot_incoming.status,'ok');
  assert.match(rs.bot_incoming.detail,/^3 in 24h/);
  assert.equal(rs.bot_responses.status,'warn');
  assert.match(rs.bot_responses.detail,/3 of 4 repl\(ies\) sent in 7 days \(75%\) · 1 used a fallback answer/);
  assert.equal(rs.bot_duplicates.status,'warn');
  assert.match(rs.bot_duplicates.detail,/1 duplicate repl\(ies\) in 1 conversation/);
  assert.equal(rs.bot_response_time.status,'warn');
  assert.match(rs.bot_response_time.detail,/Typical 2\.4s · slowest 5% 40\.0s/);
  assert.equal(rs.bot_language.status,'ok');
  assert.equal(rs.bot_kb.status,'ok');
  assert.equal(rs.bot_handover.status,'fail');
  assert.match(rs.bot_handover.detail,/1 chat\(s\) handed to the team .* 1 of 2 team alert\(s\) delivered/);
  assert.equal(rs.crm_messaging.status,'warn');
  assert.match(rs.crm_messaging.detail,/Last 24h: 3 sent, 1 failed/);
  assert.equal(rs.webhooks.status,'ok');
  assert.match(rs.webhooks.detail,/bot engine connected/);
});

test('CRM and database: lead creation, assignment, contacts, duplicates; messages without new leads are an error',async()=>{
  const c={Id:8,wa_phone_id:'1',wa_token:'t'};
  const leads=[
    {Id:3,Phone:'+971 50 111 2222',Owner:'a@x.com',Stage:'new',CreatedAt:iso(10*24*H),UpdatedAt:iso(9*24*H)},
    {Id:2,Phone:'971501112222',Owner:'',Stage:'new',CreatedAt:iso(11*24*H)},
    {Id:1,Phone:'',Email:'',Stage:'',CreatedAt:iso(12*24*H)},
  ];
  const rows=Array.from({length:6},(_,i)=>botRow({conv_id:String(i),user_text:'hi '+i,created_at:iso(H*(i+1))}));
  const rs=byKey(await withFetch(async url=>nocodb(leads)(url)||ok({}),
    ()=>runHealthChecks(env([],{bot_reply_log:sql=>/MAX\(created_at\)/.test(sql)?[{last:iso(H)}]:rows,pm_tasks:[{status:'todo',due_date:'2000-01-01'}],pm_queue_failures:[{n:0}]}),c)));
  assert.equal(rs.crm_lead_creation.status,'fail');
  assert.match(rs.crm_lead_creation.detail,/Last lead created 10d ago · 0 in the last 7 days — but 6 message\(s\) arrived since/);
  assert.equal(rs.crm_lead_assignment.status,'off');
  assert.equal(rs.crm_contacts.status,'warn');
  assert.match(rs.crm_contacts.detail,/1 have no phone or email/);
  assert.equal(rs.crm_reports.status,'ok');
  assert.match(rs.crm_reports.detail,/3 recent lead\(s\) across 1 pipeline stage/);
  assert.equal(rs.crm_tasks.status,'warn');
  assert.match(rs.crm_tasks.detail,/1 open task\(s\), 1 overdue/);
  assert.equal(rs.db_duplicates.status,'fail');
  assert.match(rs.db_duplicates.detail,/1 phone number\(s\) appear on 2 leads/);
  assert.equal(rs.db_lead_updates.status,'fail');
  assert.equal(rs.db_write.status,'ok');
  assert.equal(rs.db_connectivity.status,'ok');
  assert.equal(rs.webhooks.status,'off');
});

test('Automation: stuck scheduled messages, failing follow-ups, webhook errors; a CRM outage fails the CRM checks',async()=>{
  const c={Id:9};
  const rs=byKey(await withFetch(async url=>String(url).startsWith(NC)?new Response('{}',{status:500}):ok({}),
    ()=>runHealthChecks(env([],{
      chat_scheduled:[{status:'scheduled',send_at:iso(2*H)},{status:'sent',send_at:iso(5*H)}],
      followup_sends:[{n:1,last:iso(H)}], followup_send_failures:[{n:4,err:'Template not approved'}],
      meta_capi_errors:[{n:2}], meta_leadgen_events:[{n:0}],
    }),c)));
  assert.equal(rs.scheduled_messages.status,'fail');
  assert.equal(rs.scheduled_messages.detail,'1 sent, 0 failed, 1 overdue (7 days)');
  assert.equal(rs.followup_delivery.status,'fail');
  assert.match(rs.followup_delivery.detail,/1 follow-up\(s\) sent, 4 failed .* "Template not approved"/);
  assert.equal(rs.webhook_errors.status,'warn');
  assert.match(rs.webhook_errors.detail,/2 Meta conversion event\(s\) rejected/);
  assert.equal(rs.crm_lead_creation.status,'fail');
  assert.match(rs.crm_lead_creation.detail,/CRM database HTTP 500/);
  assert.equal(rs.db_connectivity.status,'fail');
  assert.match(rs.db_connectivity.detail,/CRM database unreachable — HTTP 500/);
});
