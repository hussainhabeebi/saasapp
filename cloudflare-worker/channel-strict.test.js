// 🔒 Strict channels: only the assigned user and the account owner see them — admins and general
// managers included in the hiding. Every toggle on Connected Channels saves on its own without
// resetting the others, and only the owner / admins can change them.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, { channelHiddenAssignments, channelVisibilityClause } from './worker.js';
import { chatsV2Ready, chatsV2Access, chatsV2HiddenInboxes, chatsV2List, chatsV2AfterInsert, chatsV2Kind } from './chats-v2.js';

function d1(db){
  const prep=sql=>{ let args=[]; const st={
    bind(...a){ args=a.map(v=>v===undefined?null:v); return st; },
    async run(){ const r=db.prepare(sql).run(...args); return {meta:{changes:Number(r.changes), last_row_id:Number(r.lastInsertRowid)}}; },
    async all(){ return {results:db.prepare(sql).all(...args)}; },
    async first(){ return db.prepare(sql).get(...args)||null; } }; return st; };
  return {prepare:prep, async batch(stmts){ const out=[]; for(const s of stmts) out.push(await s.run()); return out; }};
}
const CID=7, OWNER='boss@acme.com', ADMIN='admin@acme.com', RITA='rita@acme.com', SAM='sam@acme.com';
const CLIENT={Id:CID, authentik_email:OWNER, team_emails:`${ADMIN},${RITA},${SAM}`, chatwoot_account_id:'1', chatwoot_token:'t', chatwoot_base:'https://cw.test',
  lead_routing:JSON.stringify({enabled:false}), team_permissions:JSON.stringify({[ADMIN]:{role:'admin'}})};

let raw, env;
async function fresh(){
  raw=new DatabaseSync(':memory:');
  raw.exec(readFileSync(new URL('./migrations/0076_lead_messages.sql', import.meta.url), 'utf8'));
  raw.exec(readFileSync(new URL('./migrations/0081_channel_inbox_assignments.sql', import.meta.url), 'utf8'));
  raw.exec(`ALTER TABLE channel_inbox_assignments ADD COLUMN bot_reply_disabled INTEGER NOT NULL DEFAULT 0`);
  raw.exec(readFileSync(new URL('./migrations/0126_channel_strict.sql', import.meta.url), 'utf8'));
  env={DB:d1(raw), NOCODB_BASE:'http://nc.test', NOCODB_TOKEN:'t', SESSION_SIGNING_KEY:'k'};
  const now=new Date().toISOString();
  // Inbox 11 → Rita (strict), inbox 22 → Sam (not strict).
  raw.prepare(`INSERT INTO channel_inbox_assignments (client_id,inbox_id,assigned_email,chatwoot_user_id,strict,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).run(CID, 11, RITA, 0, 1, now, now);
  raw.prepare(`INSERT INTO channel_inbox_assignments (client_id,inbox_id,assigned_email,chatwoot_user_id,strict,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).run(CID, 22, SAM, 0, 0, now, now);
}

describe('who sees a strict channel', ()=>{
  beforeEach(fresh);
  test('Leads list: an admin loses only the strict channel; staff lose every other channel; the owner nothing', ()=>{
    const asg=raw.prepare('SELECT inbox_id,assigned_email,strict FROM channel_inbox_assignments').all();
    assert.equal(channelVisibilityClause(channelHiddenAssignments(CLIENT, asg, ADMIN), ADMIN), '(InboxId,blank)~or(InboxId,neq,11)');
    assert.equal(channelVisibilityClause(channelHiddenAssignments(CLIENT, asg, SAM), SAM), '(InboxId,blank)~or(InboxId,neq,11)');
    assert.equal(channelVisibilityClause(channelHiddenAssignments(CLIENT, asg, RITA), RITA), '(InboxId,blank)~or(InboxId,neq,22)');
    assert.deepEqual(channelHiddenAssignments(CLIENT, asg, OWNER), []);
  });
  test('Chats: same rule', async()=>{
    assert.equal(await chatsV2Ready(env), true);
    for(const [id, inbox, who] of [[1,'11',RITA],[2,'22',SAM],[3,'33','']]){
      const ts=`2026-10-10T10:0${id}:00.000Z`;
      const r=raw.prepare(`INSERT INTO lead_messages (lead_id, client_id, role, content, attachment, reply_to, ts, sender_type, kind) VALUES (?,?,?,?,?,?,?,?,?)`).run(id, CID, 'user', 'hi', '{}', '{}', ts, '', chatsV2Kind({role:'user', content:'hi'}));
      await chatsV2AfterInsert(env, id, CID, {role:'user', content:'hi', ts}, Number(r.lastInsertRowid));
      raw.prepare('UPDATE conversations SET synced=1, inbox_id=?, assignee_email=? WHERE lead_id=?').run(inbox, who, id);
    }
    const see=async(email, full)=>(await chatsV2List(env, CID, chatsV2Access(CLIENT, email, await chatsV2HiddenInboxes(env, CID, email, {fullAccess:full})), {view:'all'})).rows.map(r=>r.lead_id).sort();
    assert.deepEqual(await see(ADMIN, true), [2,3], 'admin: strict channel hidden');
    assert.deepEqual(await see(RITA, false), [1,3]);
    assert.deepEqual(await see(OWNER, false), [1,2,3]);
  });
});

async function token(cid, email){
  const body=btoa(JSON.stringify({cid:String(cid), email, exp:Math.floor(Date.now()/1000)+3600}));
  const key=await crypto.subtle.importKey('raw', new TextEncoder().encode('k'), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const sig=await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `${body}.${btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}`;
}
describe('PUT /channels/inbox-assignment', ()=>{
  const realFetch=globalThis.fetch;
  beforeEach(async()=>{ await fresh(); globalThis.fetch=async(url)=>{ const u=String(url);
    if(u.includes(`/records/${CID}`)) return Response.json(CLIENT);
    if(u.startsWith('http://nc.test')) return Response.json({list:[], columns:[]});
    return Response.json({data:{payload:[]}}); }; });
  afterEach(()=>{ globalThis.fetch=realFetch; });
  const put=async(email, body)=>{ const r=await worker.fetch(new Request('https://w.test/channels/inbox-assignment',{method:'PUT',headers:{Authorization:'Bearer '+await token(CID,email),'Content-Type':'application/json'},body:JSON.stringify(body)}), env, {}); return {status:r.status, data:await r.json()}; };
  const row=id=>({...raw.prepare('SELECT assigned_email,bot_reply_disabled,strict FROM channel_inbox_assignments WHERE inbox_id=?').get(id)});

  test('each toggle saves alone and keeps the rest', async()=>{
    let r=await put(OWNER,{inbox_id:11, bot_reply_disabled:true});
    assert.equal(r.status,200,JSON.stringify(r.data));
    assert.deepEqual(row(11),{assigned_email:RITA, bot_reply_disabled:1, strict:1});
    r=await put(OWNER,{inbox_id:11, strict:false});
    assert.deepEqual(row(11),{assigned_email:RITA, bot_reply_disabled:1, strict:0});
    r=await put(OWNER,{inbox_id:11, assigned_email:SAM});
    assert.deepEqual(row(11),{assigned_email:SAM, bot_reply_disabled:1, strict:0}, 're-assigning keeps both toggles');
  });
  test('strict needs an assigned user; assignee must be on the team', async()=>{
    assert.equal((await put(OWNER,{inbox_id:55, strict:true})).status,400);
    assert.equal((await put(OWNER,{inbox_id:11, assigned_email:'stranger@x.com'})).status,400);
  });
  test('only the owner or an admin can change channels', async()=>{
    assert.equal((await put(RITA,{inbox_id:11, strict:false})).status,403);
    assert.equal(row(11).strict,1);
    assert.equal((await put(ADMIN,{inbox_id:22, strict:true})).status,200);
    assert.equal(row(22).strict,1);
  });
});
