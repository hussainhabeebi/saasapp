// Chats v2 (chats-v2.js) — formatting/preview helpers, the message-write hook that keeps the
// conversations list row in step, list paging/views/staff scoping, counts, thread paging, inbox
// actions and the query plans the list relies on. Runs against the real lead_messages migration plus
// the module's own schema, through node:sqlite and the same tiny D1 shim the other module tests use.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  toWhatsApp, chatsV2Preview, chatsV2Kind, chatsV2LabelsKey, chatsV2FieldsFromLead, chatsV2Access,
  chatsV2Ready, chatsV2AfterInsert, chatsV2ApplyLeadPatch, chatsV2List, chatsV2Counts, chatsV2Thread,
  chatsV2Act, chatsV2Backfill, chatsV2Reconcile, chatsV2HandleRoute, chatsV2Ai, chatsV2CompileFilter, chatsV2RunScheduled,
} from './chats-v2.js';

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

const CID=7, OWNER='boss@acme.com', SHAFNA='shafna@acme.com', RAHUL='rahul@acme.com';
const CLIENT={Id:CID, authentik_email:OWNER, team_emails:`${SHAFNA},${RAHUL}`, team_names:JSON.stringify({[SHAFNA]:'Shafna', [RAHUL]:'Rahul'}),
  team_permissions:JSON.stringify({[SHAFNA]:{role:'admin'}})};

let db, env, sent, ncPatches, ncLeads;
async function fresh(client=CLIENT){
  const raw=new DatabaseSync(':memory:');
  raw.exec(readFileSync(new URL('./migrations/0076_lead_messages.sql', import.meta.url), 'utf8'));
  db=raw; env={DB:d1(raw)};
  assert.equal(await chatsV2Ready(env), true);
  sent=[]; ncPatches=[]; ncLeads=[];
  return client;
}
function deps(client=CLIENT){
  return {
    json:(data, status)=>new Response(JSON.stringify(data), {status:status||200, headers:{'Content-Type':'application/json'}}),
    requireSession:async req=>{
      const a=req.headers.get('Authorization')||'';
      return a==='Bearer owner'?{cid:String(CID), email:OWNER}:a==='Bearer rahul'?{cid:String(CID), email:RAHUL}:null;
    },
    getClientById:async()=>client,
    leadsTable:'leads',
    ncFetch:async(env, path, opts={})=>{
      if(opts.method==='PATCH'){ ncPatches.push(...[].concat(opts.body)); return new Response('{}'); }
      return new Response(JSON.stringify({list:ncLeads, pageInfo:{isLastPage:true}}));
    },
    ensureLeadsColumns:async()=>{},
    broadcast:async(env, cid, obj)=>{ sent.push(obj); },
    handover:async(env, payload, id, takeover)=>takeover?{Handover:'Yes', HandoverBy:payload.email}:{Handover:'No', HandoverBy:''},
    seedLead:async()=>null,
  };
}
async function insertMsg(leadId, msg, opts={}){
  const ts=msg.ts||new Date().toISOString();
  const r=db.prepare(`INSERT OR IGNORE INTO lead_messages (lead_id, client_id, role, content, attachment, reply_to, ts, sender_type, kind) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(leadId, CID, msg.role, msg.content||'', JSON.stringify(msg.attachment||{}), '{}', ts, msg.sender_type||'', chatsV2Kind(msg));
  if(!r.changes) return null;
  return chatsV2AfterInsert(env, leadId, CID, {...msg, ts}, Number(r.lastInsertRowid), {broadcast:deps().broadcast, ...opts});
}
const row=id=>db.prepare('SELECT * FROM conversations WHERE lead_id=?').get(id);
const T=(m)=>`2026-10-10T${m}:00.000Z`;

describe('formatting and preview', ()=>{
  test('toWhatsApp converts Markdown the LLM or an agent writes', ()=>{
    assert.equal(toWhatsApp('**Price:** AED 375'), '*Price:* AED 375');
    assert.equal(toWhatsApp('## Visa options'), '*Visa options*');
    assert.equal(toWhatsApp('~~old~~ new __soft__'), '~old~ new _soft_');
    assert.equal(toWhatsApp('*   one\n* two'), '• one\n• two');
    assert.equal(toWhatsApp('[Pay here](https://pay.example/x)'), 'Pay here: https://pay.example/x');
    assert.equal(toWhatsApp('*bold* _it_ stay'), '*bold* _it_ stay');
    assert.equal(toWhatsApp('```**keep**```'), '```**keep**```');
    assert.equal(toWhatsApp('2 ** 3 and a*b'), '2 ** 3 and a*b');
  });
  test('previews are never blank and label media', ()=>{
    assert.equal(chatsV2Preview({role:'user', content:'  hello\n there '}), 'hello there');
    assert.equal(chatsV2Preview({role:'user', content:'', attachment:{kind:'voice', duration:12}}), '🎤 Voice note 0:12');
    assert.equal(chatsV2Preview({role:'user', content:'a cat on a sofa', attachment:{kind:'image', ai_text:true, caption:''}}), '📷 Photo');
    assert.equal(chatsV2Preview({role:'user', content:'x', attachment:{kind:'image', ai_text:true, caption:'is this in stock?'}}), '📷 is this in stock?');
    assert.equal(chatsV2Preview({role:'assistant', content:'Hi {{1}}', attachment:{kind:'template', name:'welcome'}}), '📋 welcome');
    assert.equal(chatsV2Preview({role:'assistant', content:'', attachment:{name:'quote.pdf'}}), '📄 quote.pdf');
    assert.equal(chatsV2Preview({role:'user', content:''}), 'Message');
  });
  test('labels key and lead field mapping', ()=>{
    assert.equal(chatsV2LabelsKey('Hot, Kerala ,hot'), ',hot,kerala,');
    assert.equal(chatsV2LabelsKey(''), ',');
    const f=chatsV2FieldsFromLead({Name:'Asha', Owner:' Shafna@Acme.com ', Tags:'Hot, Kerala', Handover:'Yes', ConvResolved:'No', ConversationID:44}, {status:'snoozed'});
    assert.equal(f.assignee_email, SHAFNA);
    assert.equal(f.labels, 'Hot, Kerala');
    assert.equal(f.status, 'snoozed');
    assert.equal(f.conv_id, '44');
    assert.equal(chatsV2FieldsFromLead({ConvResolved:'Yes'}, {status:'snoozed'}).status, 'resolved');
    assert.equal(chatsV2FieldsFromLead({ConvResolved:'No'}, {status:'resolved'}).status, 'open');
  });
  test('access mirrors the v1 staff rules', ()=>{
    assert.deepEqual(chatsV2Access(CLIENT, OWNER), {me:OWNER, staff:false, locked:false});
    assert.deepEqual(chatsV2Access(CLIENT, SHAFNA), {me:SHAFNA, staff:false, locked:false});
    assert.deepEqual(chatsV2Access(CLIENT, RAHUL), {me:RAHUL, staff:true, locked:false});
    assert.equal(chatsV2Access({...CLIENT, lead_routing:'{"enabled":true}'}, RAHUL).locked, true);
  });
});

describe('message write hook', ()=>{
  beforeEach(()=>fresh());
  test('an inbound message creates the row unread and waiting, and pushes a delta', async()=>{
    await insertMsg(1, {role:'user', content:'hi', ts:T('10:00')});
    const r=row(1);
    assert.equal(r.unread_count, 1);
    assert.equal(r.waiting_since, T('10:00'));
    assert.equal(r.last_message_preview, 'hi');
    assert.equal(r.last_customer_at, T('10:00'));
    assert.equal(r.synced, 0);
    assert.deepEqual(sent.at(-1), {type:'conv', lead_ids:[1], dir:'in'});
  });
  test('a bot reply clears waiting but not unread; an agent reply reads the chat', async()=>{
    await insertMsg(1, {role:'user', content:'hi', ts:T('10:00')});
    await insertMsg(1, {role:'user', content:'price?', ts:T('10:01')});
    assert.equal(row(1).unread_count, 2);
    await insertMsg(1, {role:'assistant', sender_type:'bot', content:'**AED 375**', ts:T('10:02')});
    assert.equal(row(1).waiting_since, null);
    assert.equal(row(1).unread_count, 2);
    assert.equal(row(1).last_sender, 'bot');
    await insertMsg(1, {role:'user', content:'ok', ts:T('10:05')});
    assert.equal(row(1).waiting_since, T('10:05'));
    await insertMsg(1, {role:'assistant', sender_type:'agent', content:'Sure', ts:T('10:06')});
    assert.equal(row(1).unread_count, 0);
    assert.equal(row(1).last_read_at, T('10:06'));
  });
  test('a late, older message does not replace the preview', async()=>{
    await insertMsg(1, {role:'user', content:'newest', ts:T('10:05')});
    await insertMsg(1, {role:'assistant', content:'', attachment:{kind:'image', url:'x'}, ts:T('10:01')});
    assert.equal(row(1).last_message_preview, 'newest');
    assert.equal(row(1).last_message_at, T('10:05'));
  });
  test('a customer message reopens a resolved or snoozed chat; seeding history does not', async()=>{
    await insertMsg(1, {role:'user', content:'hi', ts:T('10:00')});
    db.prepare(`UPDATE conversations SET status='resolved' WHERE lead_id=1`).run();
    await insertMsg(1, {role:'user', content:'back', ts:T('11:00')}, {seed:true});
    assert.equal(row(1).status, 'resolved');
    await insertMsg(1, {role:'user', content:'again', ts:T('12:00')});
    assert.equal(row(1).status, 'open');
    db.prepare(`UPDATE conversations SET status='snoozed', snoozed_until='2099-01-01' WHERE lead_id=1`).run();
    await insertMsg(1, {role:'user', content:'?', ts:T('12:30')});
    assert.equal(row(1).status, 'open');
    assert.equal(row(1).snoozed_until, null);
  });
  test('seeded history starts read', async()=>{
    await insertMsg(2, {role:'user', content:'old', ts:T('09:00')}, {seed:true});
    assert.equal(row(2).unread_count, 0);
  });
  test('lead patches from elsewhere mirror onto an existing row only', async()=>{
    await insertMsg(1, {role:'user', content:'hi', ts:T('10:00')});
    await chatsV2ApplyLeadPatch(env, 1, {Owner:'Rahul@acme.com', Tags:'Hot', ConvResolved:'Yes', Handover:'Yes'}, {broadcast:deps().broadcast});
    const r=row(1);
    assert.equal(r.assignee_email, RAHUL);
    assert.equal(r.labels_key, ',hot,');
    assert.equal(r.status, 'resolved');
    assert.equal(r.handover, 'Yes');
    assert.deepEqual(sent.at(-1), {type:'conv', lead_ids:[1]});
    assert.equal(await chatsV2ApplyLeadPatch(env, 99, {Owner:'x'}, {}), null);
    assert.equal(row(99), undefined);
  });
});

describe('list, counts, thread', ()=>{
  beforeEach(async()=>{
    await fresh();
    for(let i=1;i<=7;i++) await insertMsg(i, {role:'user', content:'m'+i, ts:T(`10:0${i}`)});
    db.prepare(`UPDATE conversations SET synced=1`).run();
    db.prepare(`UPDATE conversations SET assignee_email=? WHERE lead_id IN (1,2)`).run(RAHUL);
    db.prepare(`UPDATE conversations SET assignee_email=? WHERE lead_id=3`).run(SHAFNA);
    db.prepare(`UPDATE conversations SET status='resolved', unread_count=0 WHERE lead_id=4`).run();
    db.prepare(`UPDATE conversations SET handover='Yes' WHERE lead_id=5`).run();
    db.prepare(`UPDATE conversations SET pinned=1 WHERE lead_id=1`).run();
    db.prepare(`UPDATE conversations SET labels='Hot', labels_key=',hot,' WHERE lead_id IN (6,2)`).run();
  });
  const owner=chatsV2Access(CLIENT, OWNER), rahul=chatsV2Access(CLIENT, RAHUL);
  test('newest first with pinned on top, keyset paging with no gaps or repeats', async()=>{
    const p1=await chatsV2List(env, CID, owner, {view:'all', limit:3});
    assert.deepEqual(p1.rows.map(r=>r.lead_id), [1, 7, 6, 5]);
    assert.ok(p1.cursor);
    const p2=await chatsV2List(env, CID, owner, {view:'all', limit:3, cursor:p1.cursor});
    assert.deepEqual(p2.rows.map(r=>r.lead_id), [4, 3, 2]);
    assert.equal(p2.cursor, null);
  });
  test('views and filters', async()=>{
    const ids=async q=>(await chatsV2List(env, CID, owner, q)).rows.map(r=>r.lead_id);
    assert.deepEqual(await ids({view:'mine'}), []);
    assert.deepEqual(await ids({view:'unassigned'}), [7, 6, 5]);
    assert.deepEqual(await ids({view:'resolved'}), [4]);
    assert.deepEqual(await ids({view:'needs'}), [5]);
    assert.deepEqual(await ids({view:'all', handler:'human'}), [5]);
    assert.deepEqual(await ids({view:'all', labels:'hot'}), [6, 2]);
    assert.deepEqual(await ids({view:'all', sort:'waiting'}), [1, 2, 3, 5, 6, 7]);
    assert.deepEqual(await ids({view:'unread'}), [1, 7, 6, 5, 3, 2]);
  });
  test('staff see their own and unassigned chats; locked routing hides unassigned', async()=>{
    const ids=async acc=>(await chatsV2List(env, CID, acc, {view:'all'})).rows.map(r=>r.lead_id);
    assert.deepEqual(await ids(rahul), [1, 7, 6, 5, 4, 2]);
    assert.deepEqual(await ids(chatsV2Access({...CLIENT, lead_routing:'{"enabled":true}'}, RAHUL)), [1, 2]);
  });
  test('counts in one query, scoped like the list', async()=>{
    const c=await chatsV2Counts(env, CID, owner);
    assert.deepEqual({all:c.all, unread:c.unread, needs:c.needs, mine:c.mine, unassigned:c.unassigned, resolved:c.resolved},
      {all:7, unread:6, needs:1, mine:0, unassigned:3, resolved:1});
    const r=await chatsV2Counts(env, CID, rahul);
    assert.equal(r.all, 6);
    assert.equal(r.mine, 2);
  });
  test('thread pages newest-first and returns oldest → newest', async()=>{
    for(let i=0;i<5;i++) await insertMsg(1, {role:i%2?'assistant':'user', content:'t'+i, ts:T(`11:0${i}`)});
    const a=await chatsV2Thread(env, 1, {limit:4});
    assert.deepEqual(a.messages.map(m=>m.content), ['t1', 't2', 't3', 't4']);
    assert.equal(a.has_more, true);
    const b=await chatsV2Thread(env, 1, {limit:4, before:a.before});
    assert.deepEqual(b.messages.map(m=>m.content), ['m1', 't0']);
    assert.equal(b.has_more, false);
    const c=await chatsV2Thread(env, 1, {after:T('11:02')});
    assert.deepEqual(c.messages.map(m=>m.content), ['t3', 't4']);
  });
  test('the list queries use an index and need no sort pass', ()=>{
    const plan=sql=>db.prepare('EXPLAIN QUERY PLAN '+sql).all(CID).map(r=>r.detail).join(' | ');
    const p=plan(`SELECT * FROM conversations WHERE client_id=? AND pinned=0 AND status<>'snoozed' ORDER BY last_message_at DESC, lead_id DESC LIMIT 31`);
    assert.match(p, /USING INDEX ix_conv_recent/);
    assert.doesNotMatch(p, /TEMP B-TREE/);
    const t=db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM lead_messages WHERE lead_id=? ORDER BY ts DESC, id DESC LIMIT 31`).all(1).map(r=>r.detail).join(' | ');
    assert.match(t, /idx_lm_(lead_ts|dedup)/);
  });
});

describe('actions', ()=>{
  beforeEach(async()=>{
    await fresh();
    for(let i=1;i<=3;i++) await insertMsg(i, {role:'user', content:'m'+i, ts:T(`10:0${i}`)});
    sent=[];
  });
  const P={cid:String(CID), email:OWNER};
  test('bulk resolve: NocoDB first, one event per chat, one broadcast', async()=>{
    const out=await chatsV2Act(env, deps(), P, CLIENT, chatsV2Access(CLIENT, OWNER), {op:'resolve', ids:[1,2]});
    assert.deepEqual(ncPatches, [{Id:1, ConvResolved:'Yes'}, {Id:2, ConvResolved:'Yes'}]);
    assert.equal(row(1).status, 'resolved');
    assert.equal(row(3).status, 'open');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].lead_ids, [1, 2]);
    const ev=db.prepare(`SELECT * FROM lead_messages WHERE lead_id=1 AND kind='event'`).get();
    assert.equal(ev.content, 'Resolved by boss');
    assert.equal(out.events[1].meta.type, 'resolved');
    // events don't count as unread or move the preview
    assert.equal(row(1).last_message_preview, 'm1');
  });
  test('assign writes Owner and checks the teammate; staff can only take a chat themselves', async()=>{
    await chatsV2Act(env, deps(), P, CLIENT, chatsV2Access(CLIENT, OWNER), {op:'assign', ids:[1], args:{email:'Shafna@acme.com'}});
    assert.equal(row(1).assignee_email, SHAFNA);
    assert.deepEqual(ncPatches.at(-1), {Id:1, Owner:SHAFNA});
    assert.match(db.prepare(`SELECT content FROM lead_messages WHERE kind='event'`).get().content, /Assigned to Shafna by boss/);
    await assert.rejects(chatsV2Act(env, deps(), P, CLIENT, chatsV2Access(CLIENT, OWNER), {op:'assign', ids:[1], args:{email:'stranger@x.com'}}), /Not a teammate/);
    const rahul=chatsV2Access(CLIENT, RAHUL);
    await assert.rejects(chatsV2Act(env, deps(), {cid:String(CID), email:RAHUL}, CLIENT, rahul, {op:'assign', ids:[2], args:{email:SHAFNA}}), /Only an admin/);
    await chatsV2Act(env, deps(), {cid:String(CID), email:RAHUL}, CLIENT, rahul, {op:'assign', ids:[2], args:{email:RAHUL}});
    assert.equal(row(2).assignee_email, RAHUL);
    // chat 1 is Shafna's now: invisible to Rahul
    await assert.rejects(chatsV2Act(env, deps(), {cid:String(CID), email:RAHUL}, CLIENT, rahul, {op:'resolve', ids:[1]}), /not found/);
  });
  test('snooze needs a future time; labels add/remove; handler goes through the handover hook', async()=>{
    const owner=chatsV2Access(CLIENT, OWNER);
    await assert.rejects(chatsV2Act(env, deps(), P, CLIENT, owner, {op:'snooze', ids:[1], args:{until:'2000-01-01'}}), /future/);
    await chatsV2Act(env, deps(), P, CLIENT, owner, {op:'snooze', ids:[1], args:{until:'2099-01-01T09:00:00Z'}});
    assert.equal(row(1).status, 'snoozed');
    await chatsV2Act(env, deps(), P, CLIENT, owner, {op:'label_add', ids:[2], args:{label:'Hot'}});
    await chatsV2Act(env, deps(), P, CLIENT, owner, {op:'label_add', ids:[2], args:{label:'hot'}});
    await chatsV2Act(env, deps(), P, CLIENT, owner, {op:'label_add', ids:[2], args:{label:'Kerala'}});
    assert.equal(row(2).labels, 'Hot, Kerala');
    await chatsV2Act(env, deps(), P, CLIENT, owner, {op:'label_remove', ids:[2], args:{label:'HOT'}});
    assert.equal(row(2).labels, 'Kerala');
    assert.deepEqual(ncPatches.at(-1), {Id:2, Tags:'Kerala'});
    await chatsV2Act(env, deps(), P, CLIENT, owner, {op:'handler', ids:[3], args:{mode:'human'}});
    assert.equal(row(3).handover, 'Yes');
    assert.equal(row(3).handover_by, OWNER);
    await chatsV2Act(env, deps(), P, CLIENT, owner, {op:'mark_read', ids:[3]});
    assert.equal(row(3).unread_count, 0);
    await chatsV2Act(env, deps(), P, CLIENT, owner, {op:'mark_unread', ids:[3]});
    assert.equal(row(3).unread_count, 1);
  });
});

describe('sync and routes', ()=>{
  beforeEach(()=>fresh());
  test('backfill creates rows from NocoDB leads, preview from D1 or ConvHistory', async()=>{
    db.prepare(`INSERT INTO lead_messages (lead_id, client_id, role, content, ts) VALUES (11, ?, 'user', 'from d1', ?)`).run(CID, T('09:00'));
    ncLeads=[
      {Id:11, Name:'Asha', Phone:'919', Owner:RAHUL, LastMsgAt:T('09:00'), ConvHistory:'[]'},
      {Id:12, Name:'Binu', LastMsgAt:T('08:00'), ConvHistory:JSON.stringify([{role:'assistant', content:'**Hi** there'}]), ConvResolved:'Yes'},
      {Id:13, Name:'No chat', LastMsgAt:T('07:00'), ConvHistory:'[]'},
    ];
    assert.equal(await chatsV2Backfill(env, deps(), CID), 2);
    assert.equal(row(11).last_message_preview, 'from d1');
    assert.equal(row(11).assignee_email, RAHUL);
    assert.equal(row(11).unread_count, 0);
    assert.equal(row(12).last_message_preview, '**Hi** there');
    assert.equal(row(12).status, 'resolved');
    assert.equal(row(13), undefined);
  });
  test('reconcile fixes drifted rows and pushes them', async()=>{
    await insertMsg(21, {role:'user', content:'hi', ts:T('10:00')});
    sent=[];
    ncLeads=[{Id:21, Name:'Chitra', Owner:SHAFNA, Handover:'Yes', LastMsgAt:T('10:00')}];
    assert.equal(await chatsV2Reconcile(env, deps(), CID), 1);
    assert.equal(row(21).name, 'Chitra');
    assert.equal(row(21).synced, 1);
    assert.deepEqual(sent[0], {type:'conv', lead_ids:[21]});
    assert.equal(await chatsV2Reconcile(env, deps(), CID), 0);
  });
  test('routes: auth, bootstrap version, list, thread scoping, canned', async()=>{
    ncLeads=[];
    const call=async(path, {method='GET', who='owner', body}={})=>{
      const req=new Request('https://w'+path, {method, headers:{Authorization:'Bearer '+who, 'Content-Type':'application/json'}, body:body?JSON.stringify(body):undefined});
      const r=await chatsV2HandleRoute(req, env, deps(), new URL(req.url));
      return {status:r.status, data:await r.json()};
    };
    assert.equal((await call('/chats/v2/list', {who:'nobody'})).status, 401);
    await insertMsg(31, {role:'user', content:'hello', ts:T('10:00')});
    await insertMsg(32, {role:'user', content:'yo', ts:T('10:01')});
    db.prepare(`UPDATE conversations SET synced=1, assignee_email=? WHERE lead_id=32`).run(SHAFNA);
    const b=await call('/chats/v2/bootstrap');
    assert.equal(b.data.agents.length, 3);
    assert.equal(b.data.settings.sla_warn_min, 15);
    assert.equal((await call('/chats/v2/bootstrap?v='+b.data.version)).data.unchanged, true);
    const l=await call('/chats/v2/list?view=all');
    assert.deepEqual(l.data.rows.map(r=>r.lead_id), [32, 31]);
    assert.equal((await call('/chats/v2/thread?lead_id=32', {who:'rahul'})).status, 404);
    const t=await call('/chats/v2/thread?lead_id=31', {who:'rahul'});
    assert.equal(t.data.messages[0].content, 'hello');
    assert.equal((await call('/chats/v2/canned', {method:'POST', body:{shortcut:'/Price List', body:'Hi {{name}}'}})).status, 200);
    const b2=await call('/chats/v2/bootstrap');
    assert.deepEqual(b2.data.canned.map(x=>x.shortcut), ['price-list']);
    assert.notEqual(b2.data.version, b.data.version);
    const s=await call('/chats/v2/search?q=yo', {who:'rahul'});
    assert.deepEqual(s.data.rows.map(r=>r.lead_id), []);
    assert.deepEqual((await call('/chats/v2/search?q=hel')).data.rows.map(r=>r.lead_id), [31]);
  });
});

describe('AI assist', ()=>{
  beforeEach(()=>fresh());
  const aiDeps=(answers)=>{ const log=[]; return {...deps(), log, ai:async(env, c, sys, user)=>{ log.push({sys, user}); return answers.shift()??null; }}; };
  const owner=chatsV2Access(CLIENT, OWNER);
  test('rewrite keeps WhatsApp formatting and refuses empty text', async()=>{
    const d=aiDeps(['"**Sure!** We can deliver tomorrow."']);
    assert.deepEqual(await chatsV2Ai(env, d, CLIENT, owner, {op:'rewrite', mode:'friendlier', text:'we deliver tomorrow'}), {text:'*Sure!* We can deliver tomorrow.'});
    assert.match(d.log[0].sys, /warmer and friendlier/);
    await assert.rejects(chatsV2Ai(env, d, CLIENT, owner, {op:'rewrite', text:'  '}), /Nothing to rewrite/);
  });
  test('suggestions read the transcript, parse JSON or lines, and are cached per last message', async()=>{
    await insertMsg(1, {role:'user', content:'Do you deliver to Kochi?', ts:T('10:00')});
    const d=aiDeps(['["Yes, we deliver to Kochi.","Could you share your pincode?","Delivery takes 2 days."]']);
    const a=await chatsV2Ai(env, d, CLIENT, owner, {op:'suggest', lead_id:1});
    assert.equal(a.suggestions.length, 3);
    assert.match(d.log[0].user, /Customer: Do you deliver to Kochi\?/);
    const b=await chatsV2Ai(env, d, CLIENT, owner, {op:'suggest', lead_id:1});
    assert.deepEqual(b, a);
    assert.equal(d.log.length, 1);
    await insertMsg(1, {role:'user', content:'?', ts:T('10:05')});
    d.ai=async()=>'1. Yes\n2. Sure thing\n- Let me check';
    assert.deepEqual((await chatsV2Ai(env, d, CLIENT, owner, {op:'suggest', lead_id:1})).suggestions, ['Yes', 'Sure thing', 'Let me check']);
    const rahul=chatsV2Access(CLIENT, RAHUL);
    db.prepare(`UPDATE conversations SET assignee_email=? WHERE lead_id=1`).run(SHAFNA);
    await assert.rejects(chatsV2Ai(env, d, CLIENT, rahul, {op:'suggest', lead_id:1}), /not found/);
  });
  test('translate caches by message id', async()=>{
    const d=aiDeps(['Is it available?']);
    assert.deepEqual(await chatsV2Ai(env, d, CLIENT, owner, {op:'translate', target:'en', text:'ithu available aano?', message_id:5}), {text:'Is it available?'});
    assert.deepEqual(await chatsV2Ai(env, d, CLIENT, owner, {op:'translate', target:'en', text:'ithu available aano?', message_id:5}), {text:'Is it available?'});
    assert.equal(d.log.length, 1);
  });
});

describe('advanced filters, scheduling, block, transcript, macros', ()=>{
  beforeEach(()=>fresh());
  const owner=chatsV2Access(CLIENT, OWNER);
  const call=async(d, path, {method='GET', body, who='owner'}={})=>{
    const req=new Request('https://w'+path, {method, headers:{Authorization:'Bearer '+who, 'Content-Type':'application/json'}, body:body?JSON.stringify(body):undefined});
    const r=await chatsV2HandleRoute(req, env, d, new URL(req.url));
    return {status:r.status, data:await r.json()};
  };
  test('filters compile from a whitelist and narrow the list', async()=>{
    assert.throws(()=>chatsV2CompileFilter({all:[{f:'name; DROP TABLE x', op:'eq', v:1}]}, owner), /Unsupported/);
    const now=Date.parse(T('12:00'));
    // 1: hot, Shafna, 30 min old · 2: hot, Shafna, 4h old · 3: not hot, 4h old
    await insertMsg(1, {role:'user', content:'x', ts:T('11:30')});
    await insertMsg(2, {role:'user', content:'x', ts:T('08:00')});
    await insertMsg(3, {role:'user', content:'x', ts:T('08:00')});
    db.prepare(`UPDATE conversations SET synced=1`).run();
    db.prepare(`UPDATE conversations SET labels_key=',hot,', assignee_email=? WHERE lead_id IN (1,2)`).run(SHAFNA);
    const f={all:[{f:'label', op:'has', v:'Hot'}, {f:'assignee', op:'eq', v:SHAFNA}, {f:'last_message_age', op:'gt', v:2}]};
    const c=chatsV2CompileFilter(f, owner, now);
    const ids=db.prepare(`SELECT lead_id FROM conversations WHERE client_id=?${c.sql} ORDER BY lead_id`).all(CID, ...c.vals).map(r=>r.lead_id);
    assert.deepEqual(ids, [2]);
    const l=await chatsV2List(env, CID, owner, {view:'all', filter:JSON.stringify({all:[{f:'label', op:'has', v:'hot'}]})});
    assert.deepEqual(l.rows.map(r=>r.lead_id).sort(), [1, 2]);
  });
  test('saved views and macros come back in bootstrap; bad macros are rejected', async()=>{
    const d=deps();
    assert.equal((await call(d, '/chats/v2/views', {method:'POST', body:{name:'Hot leads Kerala', filter:{all:[{f:'label', op:'has', v:'Hot'}]}, shared:true}})).status, 200);
    assert.equal((await call(d, '/chats/v2/views', {method:'POST', body:{name:'x', filter:{all:[{f:'evil', op:'eq'}]}}})).status, 400);
    assert.equal((await call(d, '/chats/v2/macros', {method:'POST', body:{name:'Hot lead', ops:[{op:'label_add', args:{label:'Hot'}}, {op:'assign', args:{email:SHAFNA}}, {op:'drop_db'}]}})).status, 200);
    assert.equal((await call(d, '/chats/v2/macros', {method:'POST', body:{name:'Empty', ops:[{op:'nope'}]}})).status, 400);
    const b=(await call(d, '/chats/v2/bootstrap')).data;
    assert.equal(b.views[0].name, 'Hot leads Kerala');
    assert.deepEqual(b.macros[0].ops.map(o=>o.op), ['label_add', 'assign']);
    const rahulView=(await call(d, '/chats/v2/bootstrap', {who:'rahul'})).data.views;
    assert.equal(rahulView.length, 1); // shared
  });
  test('scheduled messages send when due, or fail with a reason outside the 24h window', async()=>{
    const sentTexts=[];
    const d={...deps(), sendText:async(env, c, payload, body)=>{ sentTexts.push(body); }};
    const now=Date.now();
    await insertMsg(1, {role:'user', content:'hi', ts:new Date(now-3600e3).toISOString()});
    await insertMsg(2, {role:'user', content:'old', ts:new Date(now-30*3600e3).toISOString()});
    db.prepare(`UPDATE conversations SET conv_id='55', channel='whatsapp'`).run();
    assert.equal((await call(d, '/chats/v2/schedule', {method:'POST', body:{lead_id:1, text:'See you at 9', send_at:new Date(now+10*60e3).toISOString()}})).status, 200);
    assert.equal((await call(d, '/chats/v2/schedule', {method:'POST', body:{lead_id:1, text:'x', send_at:new Date(now-60e3).toISOString()}})).status, 400);
    await call(d, '/chats/v2/schedule', {method:'POST', body:{lead_id:2, text:'Following up', send_at:new Date(now+5*60e3).toISOString()}});
    assert.equal(await chatsV2RunScheduled(env, d, now), 0); // nothing due yet
    assert.equal(await chatsV2RunScheduled(env, d, now+20*60e3), 1);
    assert.deepEqual(sentTexts.map(x=>x.text), ['See you at 9']);
    const failed=db.prepare(`SELECT status, error FROM chat_scheduled WHERE lead_id=2`).get();
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /24-hour window/);
    assert.match(db.prepare(`SELECT content FROM lead_messages WHERE lead_id=2 AND kind='event'`).get().content, /not sent/);
    assert.equal(await chatsV2RunScheduled(env, d, now+40*60e3), 0); // never twice
  });
  test('block goes to Meta first, then marks the lead; transcript email needs an address', async()=>{
    await insertMsg(1, {role:'user', content:'spam', ts:T('10:00')});
    db.prepare(`UPDATE conversations SET phone='919800000001'`).run();
    const blocked=[];
    const d={...deps(), waBlock:async(env, c, phone, inbox, block)=>{ blocked.push([phone, block]); return {ok:true}; },
      sendEmail:async(env, to, subject, html)=>{ blocked.push([to, subject, html]); return {ok:true}; }};
    assert.equal((await call(d, '/chats/v2/block', {method:'POST', body:{lead_id:1}})).status, 200);
    assert.deepEqual(blocked[0], ['919800000001', true]);
    assert.deepEqual(ncPatches.at(-1), {Id:1, Blocked:'Yes', OptOut:'Yes'});
    const fail={...d, waBlock:async()=>({ok:false, error:'no creds'})};
    assert.equal((await call(fail, '/chats/v2/block', {method:'POST', body:{lead_id:1}})).data.error, 'no creds');
    assert.equal((await call(d, '/chats/v2/email-transcript', {method:'POST', body:{lead_id:1, to:'nope'}})).status, 400);
    assert.equal((await call(d, '/chats/v2/email-transcript', {method:'POST', body:{lead_id:1, to:'boss@acme.com'}})).status, 200);
    assert.match(blocked.at(-1)[2], /spam/);
  });
});
