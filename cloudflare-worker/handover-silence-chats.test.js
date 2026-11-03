// After a handover with the bot kept silent, a customer's new message must still reach Chats:
// saved to lead_messages, LastMsgAt bumped, a resolved chat reopened — and no bot reply, no stage
// change. Before, the turn was dropped and handed-over leads never showed in Chats.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { engineHandoverSilenceTurn } from './worker.js';

const realFetch=globalThis.fetch;
afterEach(()=>{ globalThis.fetch=realFetch; });

function fakeDb(){
  const sql=[];
  const stmt=q=>({ bind(...a){ return {...stmt(q), args:a}; }, async run(){ sql.push(q); return {meta:{changes:1,last_row_id:1}}; }, async first(){ sql.push(q); return null; }, async all(){ sql.push(q); return {results:[]}; } });
  return { sql, prepare:q=>stmt(q), async batch(list){ return Promise.all(list.map(s=>s.run())); } };
}
function setup(lead){
  const nc=[], chatwoot=[];
  globalThis.fetch=async(url,opts={})=>{
    const u=String(url),method=opts.method||'GET';
    if(u.startsWith('https://nc.test')){ nc.push({u,method,body:opts.body?JSON.parse(opts.body):null}); return Response.json(method==='GET'?{list:[],columns:[]}:{Id:lead?.Id||1}); }
    if(u.startsWith('https://cw.test')){ chatwoot.push(u); return Response.json({}); }
    return Response.json({});
  };
  const env={DB:fakeDb(),NOCODB_BASE:'https://nc.test',NOCODB_TOKEN:'t'};
  const state={lead, leadId:lead?.Id||null, stage:lead?.Stage||'new', history:[], phone:'+971500000001', inboxId:'5'};
  const parsed={phone:'+971500000001',name:'Sara',convId:'77',mediaType:'text',mediaUrl:'',channel:'whatsapp'};
  return {env,state,parsed,nc,chatwoot};
}

test('handed over + silent bot: the message is saved to Chats, the chat reopens, no reply', async()=>{
  const lead={Id:42,Stage:'human_handover',Handover:'Yes',ConvResolved:'Yes'};
  const {env,state,parsed,nc,chatwoot}=setup(lead);
  const c={Id:7,industry:'travel',handover_silence_enabled:'Yes',chatwoot_base:'https://cw.test',chatwoot_account_id:'1',chatwoot_token:'x'};
  const r=await engineHandoverSilenceTurn(env,c,'7',{id:'m9',content:'Any update on my booking?'},state,parsed,'Any update on my booking?');
  const out=await r.json();
  assert.equal(out.skipped,'handed-over');
  assert.equal(out.lead_collected,true);
  assert.ok(env.DB.sql.some(q=>/INSERT[\s\S]*lead_messages/i.test(q)), 'message written to the Chats thread');
  const patch=nc.find(x=>x.method==='PATCH'&&x.body?.LastMsgAt);
  assert.ok(patch, 'lead LastMsgAt bumped');
  assert.equal(patch.body.ConvResolved,'No', 'a resolved chat reopens');
  assert.equal(patch.body.Stage, undefined, 'stage untouched');
  assert.equal(patch.body.Handover, undefined, 'handover untouched');
  assert.ok(!chatwoot.some(u=>u.includes('/messages')), 'no bot reply sent');
});

test('not handed over, or silence off → normal path (null)', async()=>{
  const {env,state,parsed}=setup({Id:1,Stage:'qualified',Handover:'No'});
  assert.equal(await engineHandoverSilenceTurn(env,{Id:7,industry:'travel',handover_silence_enabled:'Yes'},'7',{},state,parsed,'hi'), null);
  const h=setup({Id:1,Stage:'human_handover',Handover:'Yes'});
  assert.equal(await engineHandoverSilenceTurn(h.env,{Id:7,industry:'travel',handover_silence_enabled:'No'},'7',{},h.state,h.parsed,'hi'), null);
});

test('healthcare 5-hour pause also keeps the message in Chats', async()=>{
  const lead={Id:9,Stage:'human_handover',Handover:'Yes',HandoverAt:new Date(Date.now()-3600e3).toISOString()};
  const {env,state,parsed,nc}=setup(lead);
  const r=await engineHandoverSilenceTurn(env,{Id:7,industry:'healthcare'},'7',{id:'m1'},state,parsed,'Is the doctor available?');
  assert.equal((await r.json()).skipped,'healthcare-handover-5h');
  assert.ok(nc.some(x=>x.method==='PATCH'&&x.body?.LastMsgAt));
});
