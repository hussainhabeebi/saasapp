// Channel (Chatwoot inbox) assignment: a channel assigned to a user owns every lead from it — new
// leads are routed to that user whether or not lead routing is on, existing leads move over (on
// their next message, and in bulk when the channel is assigned), and its chats are hidden from
// everyone else in Chats v2. Runs against node:sqlite through the same tiny D1 shim the other
// module tests use; NocoDB is a fetch stub.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { engineResolveLeadOwner, backfillChannelLeadOwner } from './worker.js';
import { chatsV2Ready, chatsV2Access, chatsV2HiddenInboxes, chatsV2List, chatsV2Counts, chatsV2AfterInsert, chatsV2Kind } from './chats-v2.js';

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

const CID=7, OWNER='boss@acme.com', RITA='rita@acme.com', SAM='sam@acme.com';
const CLIENT={Id:CID, authentik_email:OWNER, team_emails:`${RITA},${SAM}`, lead_routing:JSON.stringify({enabled:false})};

let raw, env;
async function fresh(){
  raw=new DatabaseSync(':memory:');
  raw.exec(readFileSync(new URL('./migrations/0076_lead_messages.sql', import.meta.url), 'utf8'));
  raw.exec(readFileSync(new URL('./migrations/0081_channel_inbox_assignments.sql', import.meta.url), 'utf8'));
  env={DB:d1(raw), NOCODB_BASE:'http://nc.test', NOCODB_TOKEN:'t'};
  // Inbox 11 → Rita, inbox 22 → Sam, inbox 33 unassigned.
  const now=new Date().toISOString();
  raw.prepare(`INSERT INTO channel_inbox_assignments (client_id,inbox_id,assigned_email,chatwoot_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`).run(CID, 11, RITA, 0, now, now);
  raw.prepare(`INSERT INTO channel_inbox_assignments (client_id,inbox_id,assigned_email,chatwoot_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`).run(CID, 22, SAM, 0, now, now);
}

describe('lead owner from an assigned channel', ()=>{
  beforeEach(fresh);

  test('a new lead from an assigned channel goes to its user even with lead routing off', async()=>{
    const body={};
    await engineResolveLeadOwner(env, CLIENT, CID, body, {phone:'1', inboxId:11}, true);
    assert.equal(body.Owner, RITA);
  });

  test('an existing lead from an assigned channel moves to its user on its next message', async()=>{
    const body={};
    await engineResolveLeadOwner(env, CLIENT, CID, body, {phone:'1', inboxId:22, lead:{Owner:RITA}}, false);
    assert.equal(body.Owner, SAM);
    const same={};
    await engineResolveLeadOwner(env, CLIENT, CID, same, {phone:'1', inboxId:22, lead:{Owner:'SAM@acme.com'}}, false);
    assert.equal(same.Owner, undefined, 'already owned by the channel user — no write');
  });

  test('channel assignment beats lead routing rules', async()=>{
    const c={...CLIENT, lead_routing:JSON.stringify({enabled:true, modes:['product'], rules:{[SAM]:{products:['dubai']}}})};
    const body={Destination:'Dubai'};
    await engineResolveLeadOwner(env, c, CID, body, {phone:'1', inboxId:11}, true);
    assert.equal(body.Owner, RITA);
  });

  test('an unassigned channel leaves an existing lead alone', async()=>{
    const body={};
    await engineResolveLeadOwner(env, CLIENT, CID, body, {phone:'1', inboxId:33, lead:{Owner:SAM}}, false);
    assert.equal(body.Owner, undefined);
  });
});

describe('assigning a channel moves its existing leads', ()=>{
  beforeEach(fresh);

  test('patches every lead from that channel not already owned by the user, and the chats list', async()=>{
    assert.equal(await chatsV2Ready(env), true);
    raw.prepare(`INSERT INTO conversations (lead_id, client_id, inbox_id, assignee_email, last_message_at, updated_at) VALUES (1, ?, '11', '', '2026-10-01', '2026-10-01'), (2, ?, '33', '', '2026-10-01', '2026-10-01')`).run(CID, CID);
    const patched=[]; const realFetch=globalThis.fetch;
    globalThis.fetch=async(url, opts={})=>{
      if((opts.method||'GET')==='PATCH'){ patched.push(...JSON.parse(opts.body)); return new Response('{}'); }
      assert.match(decodeURIComponent(url), /\(ClientId,eq,7\)~and\(InboxId,eq,11\)/);
      return new Response(JSON.stringify({list:[{Id:1, Owner:''}, {Id:2, Owner:'Rita@acme.com'}, {Id:3, Owner:SAM}], pageInfo:{isLastPage:true}}));
    };
    try{
      const n=await backfillChannelLeadOwner(env, CID, 11, 'Rita@Acme.com');
      assert.equal(n, 2);
      assert.deepEqual(patched, [{Id:1, Owner:RITA}, {Id:3, Owner:RITA}]);
    }finally{ globalThis.fetch=realFetch; }
    const moved=raw.prepare('SELECT assignee_email, updated_at FROM conversations WHERE lead_id=1').get();
    assert.equal(moved.assignee_email, RITA);
    assert.notEqual(moved.updated_at, '2026-10-01', 'bumped so open Chats tabs pick it up');
    assert.equal(raw.prepare('SELECT assignee_email FROM conversations WHERE lead_id=2').get().assignee_email, '');
  });
});

describe('Chats v2 hides channels assigned to someone else', ()=>{
  beforeEach(async()=>{
    await fresh();
    assert.equal(await chatsV2Ready(env), true);
    const add=async(id, inbox, assignee)=>{
      const ts=`2026-10-10T10:0${id}:00.000Z`;
      const r=raw.prepare(`INSERT INTO lead_messages (lead_id, client_id, role, content, attachment, reply_to, ts, sender_type, kind) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(id, CID, 'user', 'hi', '{}', '{}', ts, '', chatsV2Kind({role:'user', content:'hi'}));
      await chatsV2AfterInsert(env, id, CID, {role:'user', content:'hi', ts}, Number(r.lastInsertRowid));
      raw.prepare('UPDATE conversations SET synced=1, inbox_id=?, assignee_email=? WHERE lead_id=?').run(inbox, assignee, id);
    };
    await add(1, '11', RITA);   // Rita's channel
    await add(2, '22', SAM);    // Sam's channel
    await add(3, '33', '');     // unassigned channel
    await add(4, '', '');       // older chat with no channel recorded
  });
  const ids=async email=>{
    const acc=chatsV2Access(CLIENT, email, await chatsV2HiddenInboxes(env, CID, email));
    return {list:(await chatsV2List(env, CID, acc, {view:'all'})).rows.map(r=>r.lead_id).sort(), all:(await chatsV2Counts(env, CID, acc)).all};
  };

  test('each user sees their own channel plus unassigned ones; the owner sees no assigned channel', async()=>{
    assert.deepEqual(await ids(RITA), {list:[1, 3, 4], all:3});
    assert.deepEqual(await ids(SAM), {list:[2, 3, 4], all:3});
    assert.deepEqual(await ids(OWNER), {list:[3, 4], all:2});
  });

  test('no assignments table yet means nothing is hidden', async()=>{
    raw.exec('DROP TABLE channel_inbox_assignments');
    assert.deepEqual(await chatsV2HiddenInboxes(env, CID, OWNER), []);
  });
});
