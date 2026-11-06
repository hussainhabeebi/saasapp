// Full Chatwoot history on a lead: every older Chatwoot conversation of the customer is brought into
// the Chats thread once (no duplicates of what it already has), and a reply a teammate types inside
// Chatwoot reaches the thread for every account — also when it lands on an older conversation than
// the one the lead points at. D1 via node:sqlite; NocoDB and Chatwoot stubbed.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { chatwootHistoryRows, chatwootHistoryIndex, chatwootHistoryDedupe, chatsImportChatwootHistory, engineRecordStaffReply, chatwootBodyPhone } from './worker.js';
import { chatsV2Ready } from './chats-v2.js';

const sec=iso=>Math.floor(Date.parse(iso)/1000);
describe('rows and duplicates', ()=>{
  test('a Chatwoot message becomes thread rows with who sent it; notes and activity are skipped', ()=>{
    const [r]=chatwootHistoryRows({id:1201, message_type:1, content:'Your visa is ready', created_at:sec('2026-09-01T10:00:00Z'), sender:{type:'user', name:'Anu', email:'Anu@acme.com'}});
    assert.deepEqual(r, {role:'assistant', content:'Your visa is ready', ts:'2026-09-01T10:00:00.201Z', sender_type:'agent', sender_name:'Anu', sender_email:'anu@acme.com', cw_id:1201});
    assert.equal(chatwootHistoryRows({id:2, message_type:0, content:'hi', created_at:sec('2026-09-01T10:00:00Z')})[0].sender_type, 'customer');
    assert.equal(chatwootHistoryRows({id:3, message_type:1, content:'x', created_at:1, sender:{type:'agent_bot'}})[0].sender_type, 'bot');
    assert.equal(chatwootHistoryRows({id:4, message_type:3, content:'x', created_at:1})[0].sender_type, 'automation');
    assert.deepEqual(chatwootHistoryRows({id:5, message_type:1, private:true, content:'note', created_at:1}), []);
    assert.deepEqual(chatwootHistoryRows({id:6, message_type:2, content:'Assigned to Anu', created_at:1}), []);
    const media=chatwootHistoryRows({id:7, message_type:0, content:'my passport', created_at:sec('2026-09-01T10:00:00Z'), attachments:[{file_type:'image', data_url:'https://cw/p.jpg'}]});
    assert.equal(media[0].attachment.kind, 'image');
    assert.equal(media[0].content, 'my passport');
    assert.equal(media[0].cw_id, 7);
  });
  test('already in the thread: same Chatwoot id, same text within 15 minutes, or the same longer text anywhere', ()=>{
    const idx=chatwootHistoryIndex([
      {role:'assistant', content:'Hello! How can I help you today?', ts:'2026-09-01T09:00:00.000Z', attachment:'{}'},
      {role:'user', content:'ok', ts:'2026-09-01T10:00:30.000Z', attachment:'{}'},
      {role:'assistant', content:'', ts:'2026-09-01T11:00:00.000Z', attachment:'{"kind":"image","cw_id":99}', cw_id:null},
    ]);
    const rows=[
      {role:'assistant', content:'hello!  how can I help you today?', ts:'2026-09-03T09:00:00.000Z'}, // long, seen
      {role:'user', content:'OK', ts:'2026-09-01T10:01:00.000Z'},                                   // short, within 15m
      {role:'user', content:'ok', ts:'2026-09-05T10:00:00.000Z'},                                   // short, days later → new
      {role:'assistant', content:'', ts:'2026-09-01T11:00:00.000Z', attachment:{kind:'image'}, cw_id:99}, // same id
      {role:'assistant', content:'Price is 450 AED', ts:'2026-09-02T12:00:00.000Z', cw_id:100},   // new
    ];
    assert.deepEqual(chatwootHistoryDedupe(idx, rows).map(r=>r.content), ['ok', 'Price is 450 AED']);
    // Remembered: the same rows again add nothing.
    assert.deepEqual(chatwootHistoryDedupe(idx, rows), []);
  });
  test('the contact phone of a webhook', ()=>{
    assert.equal(chatwootBodyPhone({conversation:{meta:{sender:{phone_number:'+971 50 123 4567'}}}}), '971501234567');
    assert.equal(chatwootBodyPhone({conversation:{}}), '');
  });
});

function d1(db){
  const prep=sql=>{
    let args=[];
    const st={
      bind(...a){ args=a.map(v=>v===undefined?null:v); return st; },
      async run(){ const r=db.prepare(sql).run(...args); return {meta:{changes:Number(r.changes), last_row_id:Number(r.lastInsertRowid)}}; },
      async all(){ return {results:db.prepare(sql).all(...args)}; },
      async first(){ return db.prepare(sql).get(...args)||null; },
    };
    return st;
  };
  return {prepare:prep, async batch(stmts){ const out=[]; for(const s of stmts) out.push(await s.run()); return out; }};
}

const C={Id:7, chatwoot_base:'https://cw.test', chatwoot_account_id:'3', chatwoot_token:'tok', authentik_email:'boss@acme.com'};
describe('import and live capture', ()=>{
  const realFetch=globalThis.fetch;
  let raw, env, cw, leads;
  const thread=id=>raw.prepare('SELECT role, content, sender_type, sender_name FROM lead_messages WHERE lead_id=? ORDER BY ts, id').all(id).map(r=>({...r}));
  beforeEach(async()=>{
    raw=new DatabaseSync(':memory:');
    raw.exec(readFileSync(new URL('./migrations/0076_lead_messages.sql', import.meta.url), 'utf8'));
    env={DB:d1(raw), NOCODB_BASE:'https://nc.test', NOCODB_TOKEN:'nc'};
    assert.equal(await chatsV2Ready(env), true);
    // Conversation 50 (old, Rahul replied) and 80 (current, the bot).
    cw={
      50:[{id:501, message_type:0, content:'Need a Dubai visa', created_at:sec('2026-08-01T09:00:00Z')},
          {id:502, message_type:1, content:'Sure, send your passport copy please', created_at:sec('2026-08-01T09:05:00Z'), sender:{type:'user', name:'Rahul'}},
          {id:503, message_type:1, private:true, content:'internal', created_at:sec('2026-08-01T09:06:00Z')}],
      80:[{id:801, message_type:0, content:'hello again', created_at:sec('2026-10-01T09:00:00Z')}],
    };
    leads=[{Id:9, ClientId:'7', Phone:'971501234567', ConversationID:'80', ConvHistory:'[]'}];
    globalThis.fetch=async(url)=>{
      const u=new URL(String(url));
      const ok=d=>new Response(JSON.stringify(d), {status:200});
      if(u.host==='cw.test'){
        let m;
        if((m=u.pathname.match(/\/conversations\/(\d+)\/messages$/))){ const before=Number(u.searchParams.get('before'))||Infinity; return ok({payload:(cw[m[1]]||[]).filter(x=>x.id<before)}); }
        if((m=u.pathname.match(/\/conversations\/(\d+)$/))) return ok({id:Number(m[1]), meta:{sender:{id:44}}});
        if(u.pathname.endsWith('/contacts/44/conversations')) return ok({payload:[{id:80, last_activity_at:200}, {id:50, last_activity_at:100}]});
        return ok({});
      }
      if(u.host==='nc.test'){
        const where=u.searchParams.get('where')||'';
        if(where.includes('(ConversationID,eq,80)')) return ok({list:leads});
        if(where.includes('ConversationID')) return ok({list:[]});
        if(where.includes('(Phone,like,%1501234567)')) return ok({list:leads});
        return ok({list:[]});
      }
      return ok({});
    };
  });
  afterEach(()=>{ globalThis.fetch=realFetch; });

  test("every conversation of the customer comes in once, oldest first, with the earlier owner's name", async()=>{
    // The thread already has the current conversation's message (from the webhook).
    raw.prepare(`INSERT INTO lead_messages (lead_id, client_id, role, content, ts) VALUES (9,7,'user','hello again','2026-10-01T09:00:02.123Z')`).run();
    const out=await chatsImportChatwootHistory(env, C, 7, leads[0]);
    assert.deepEqual(out, {added:2, conversations:2});
    assert.deepEqual(thread(9), [
      {role:'user', content:'Need a Dubai visa', sender_type:'customer', sender_name:''},
      {role:'assistant', content:'Sure, send your passport copy please', sender_type:'agent', sender_name:'Rahul'},
      {role:'user', content:'hello again', sender_type:'', sender_name:''},
    ]);
    // One-off on open; "Load full history" runs again (adding nothing new) — but not twice a minute.
    assert.equal((await chatsImportChatwootHistory(env, C, 7, leads[0])).skipped, 'done');
    raw.prepare(`UPDATE lead_history_import SET at='2000-01-01T00:00:00.000Z'`).run();
    assert.deepEqual(await chatsImportChatwootHistory(env, C, 7, leads[0], {force:true}), {added:0, conversations:2});
    assert.equal((await chatsImportChatwootHistory(env, C, 7, leads[0], {force:true})).skipped, 'recent');
    assert.equal(thread(9).length, 3);
  });
  test('no Chatwoot connected: nothing happens', async()=>{
    assert.equal((await chatsImportChatwootHistory(env, {Id:7}, 7, leads[0])).skipped, 'not-configured');
  });
  test("a teammate's reply typed in Chatwoot on an older conversation reaches the lead's thread, once", async()=>{
    const body={id:777, message_type:'outgoing', content:'Your visa got approved 🎉', conversation:{id:50, meta:{sender:{phone_number:'+971501234567'}}}, sender:{type:'user', name:'Rahul', email:'rahul@acme.com'}};
    assert.equal(await engineRecordStaffReply(env, C, 7, body), true);
    assert.deepEqual(thread(9), [{role:'assistant', content:'Your visa got approved 🎉', sender_type:'agent', sender_name:'Rahul'}]);
    assert.equal(await engineRecordStaffReply(env, C, 7, body), false, 'replayed webhook');
    // The bot's own reply echoing back (already in the thread as the bot) is not a staff reply.
    raw.prepare(`INSERT INTO lead_messages (lead_id, client_id, role, content, ts, sender_type) VALUES (9,7,'assistant','We have 3 packages for you','2026-10-02T00:00:00.000Z','bot')`).run();
    assert.equal(await engineRecordStaffReply(env, C, 7, {...body, id:778, content:'We have 3 packages for you'}), false);
  });
});
