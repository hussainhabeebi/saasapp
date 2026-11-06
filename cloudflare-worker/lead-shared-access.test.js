// Lead shared access (Leads → Edit Lead "👥 Shared with", Chats → 👥 Share): teammates added to a lead
// get the owner's access — they see it in Chats whatever its channel, it counts under "Mine", they can
// reply — while unshared leads (every existing one) behave exactly as before. Chats v2 against
// node:sqlite; the dashboard passthrough through worker.fetch with NocoDB stubbed.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, { leadSharedList, leadSharedValue, leadSharedWithMe, leadSharedClause, channelVisibilityClause, chatSendRefusal, _resetLeadsSharedReady } from './worker.js';
import { chatsV2Ready, chatsV2AfterInsert, chatsV2Access, chatsV2List, chatsV2Counts, chatsV2Act, chatsV2ApplyLeadPatch, chatsV2FieldsFromLead, chatsV2SharedKey, chatsV2Kind } from './chats-v2.js';

const CID=7, OWNER='boss@acme.com', RAHUL='rahul@acme.com', ANU='anu@acme.com';
const CLIENT={Id:CID, authentik_email:OWNER, team_emails:`${RAHUL},${ANU}`, team_names:JSON.stringify({[RAHUL]:'Rahul', [ANU]:'Anu'})};

describe('stored format', ()=>{
  test('cleaned, lower-cased, de-duplicated, comma-wrapped; empty means not shared', ()=>{
    assert.equal(leadSharedValue(' Anu@Acme.com, rahul@acme.com,anu@acme.com, junk'), ',anu@acme.com,rahul@acme.com,');
    assert.equal(leadSharedValue([]), '');
    assert.equal(chatsV2SharedKey(['Anu@acme.com']), ',anu@acme.com,');
    assert.deepEqual(leadSharedList(',anu@acme.com,rahul@acme.com,'), [ANU, RAHUL]);
    assert.equal(leadSharedWithMe({SharedWith:',anu@acme.com,'}, 'ANU@acme.com'), true);
    assert.equal(leadSharedWithMe({SharedWith:',joanu@acme.com,'}, ANU), false, 'whole emails only');
    assert.equal(leadSharedWithMe({}, ANU), false);
  });
  test('Leads list clause: a shared lead stays visible on a hidden channel; unchanged without it', ()=>{
    const asg=[{inbox_id:11, assigned_email:OWNER}];
    assert.equal(channelVisibilityClause(asg, RAHUL), '(InboxId,blank)~or(InboxId,neq,11)~or(Owner,like,rahul%40acme.com)');
    assert.equal(channelVisibilityClause(asg, RAHUL, {shared:true}), `(InboxId,blank)~or(InboxId,neq,11)~or(Owner,like,rahul%40acme.com)~or${leadSharedClause(RAHUL)}`);
    assert.equal(leadSharedClause(RAHUL), '(SharedWith,like,%25%2Crahul%40acme.com%2C%25)');
  });
  test('reply: a shared teammate may reply like the owner, even on a channel hidden from them', ()=>{
    const acc=chatsV2Access({...CLIENT, lead_routing:'{"enabled":true}'}, RAHUL, ['11']);
    const lead={Owner:ANU, InboxId:'11'};
    assert.match(chatSendRefusal(acc, lead), /channel assigned to someone else/);
    assert.equal(chatSendRefusal(acc, {...lead, SharedWith:',rahul@acme.com,'}), '');
    assert.equal(chatSendRefusal(chatsV2Access({...CLIENT, lead_routing:'{"enabled":true}'}, RAHUL), {Owner:ANU, SharedWith:',someone@acme.com,'}), 'This chat is assigned to someone else.');
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

describe('Chats', ()=>{
  let db, env, ncPatches, shared, sharedOk;
  const deps=()=>({
    leadsTable:'leads',
    ncFetch:async(env, path, opts={})=>{ if(opts.method==='PATCH') ncPatches.push(...[].concat(opts.body)); return new Response(JSON.stringify({list:[], pageInfo:{isLastPage:true}})); },
    ensureLeadsColumns:async()=>{},
    broadcast:async()=>{},
    sharedReady:async()=>sharedOk,
    onShared:async(env, c, cid, items, by)=>{ shared.push({items, by}); },
  });
  const row=id=>db.prepare('SELECT * FROM conversations WHERE lead_id=?').get(id);
  beforeEach(async()=>{
    const raw=new DatabaseSync(':memory:');
    raw.exec(readFileSync(new URL('./migrations/0076_lead_messages.sql', import.meta.url), 'utf8'));
    db=raw; env={DB:d1(raw)}; ncPatches=[]; shared=[]; sharedOk=true;
    assert.equal(await chatsV2Ready(env), true);
    for(let i=1;i<=3;i++){
      const msg={role:'user', content:'m'+i, ts:`2026-10-10T10:0${i}:00.000Z`};
      const r=raw.prepare(`INSERT INTO lead_messages (lead_id, client_id, role, content, attachment, reply_to, ts, kind) VALUES (?,?,?,?,?,?,?,?)`).run(i, CID, msg.role, msg.content, '{}', '{}', msg.ts, chatsV2Kind(msg));
      await chatsV2AfterInsert(env, i, CID, msg, Number(r.lastInsertRowid), {});
    }
    raw.prepare(`UPDATE conversations SET synced=1, assignee_email=?`).run(ANU);
  });
  const locked={...CLIENT, lead_routing:'{"enabled":true}'};
  const ids=async (acc, q={view:'all'})=>(await chatsV2List(env, CID, acc, q)).rows.map(r=>r.lead_id);

  test('existing chats are unshared and staff scoping is unchanged', async()=>{
    assert.equal(row(1).shared_with, '');
    assert.deepEqual(await ids(chatsV2Access(locked, RAHUL)), []);
    assert.deepEqual(await ids(chatsV2Access(locked, ANU)), [3, 2, 1]);
  });
  test('the owner shares a chat: the teammate sees it (also under Mine and on a hidden channel) and is told', async()=>{
    const P={cid:String(CID), email:OWNER};
    await chatsV2Act(env, deps(), P, locked, chatsV2Access(locked, OWNER), {op:'share', ids:[2], args:{emails:['Rahul@acme.com', ANU]}});
    // The assignee is never in their own shared list.
    assert.equal(row(2).shared_with, ',rahul@acme.com,');
    assert.deepEqual(ncPatches, [{Id:2, SharedWith:',rahul@acme.com,'}]);
    assert.deepEqual(shared.map(s=>[s.by, s.items.map(i=>[i.lead_id, i.to])]), [[OWNER, [[2, RAHUL]]]]);
    const ev=db.prepare(`SELECT content FROM lead_messages WHERE lead_id=2 AND kind='event'`).get();
    assert.equal(ev.content, 'Shared with Rahul by boss');
    const rahul=chatsV2Access(locked, RAHUL);
    assert.deepEqual(await ids(rahul), [2]);
    assert.deepEqual(await ids(rahul, {view:'mine'}), [2]);
    assert.equal((await chatsV2Counts(env, CID, rahul)).mine, 1);
    db.prepare(`UPDATE conversations SET inbox_id='55' WHERE lead_id=2`).run();
    assert.deepEqual(await ids(chatsV2Access(locked, RAHUL, ['55'])), [2]);
    // Rahul can act on it (e.g. resolve), like the owner.
    await chatsV2Act(env, deps(), {cid:String(CID), email:RAHUL}, locked, chatsV2Access(locked, RAHUL), {op:'resolve', ids:[2]});
    assert.equal(row(2).status, 'resolved');
    // Unsharing takes it away again.
    await chatsV2Act(env, deps(), P, locked, chatsV2Access(locked, OWNER), {op:'share', ids:[2], args:{emails:[]}});
    assert.equal(row(2).shared_with, '');
    assert.deepEqual(await ids(rahul, {view:'resolved'}), []);
  });
  test("only the chat's owner or an admin can change sharing; teammates must be on the team", async()=>{
    const P=e=>({cid:String(CID), email:e});
    await chatsV2Act(env, deps(), P(ANU), locked, chatsV2Access(locked, ANU), {op:'share', ids:[1], args:{emails:[RAHUL]}});
    assert.equal(row(1).shared_with, ',rahul@acme.com,', 'the assignee may share their own chat');
    await assert.rejects(chatsV2Act(env, deps(), P(RAHUL), locked, chatsV2Access(locked, RAHUL), {op:'share', ids:[1], args:{emails:[]}}), /owner or an admin/);
    await assert.rejects(chatsV2Act(env, deps(), P(OWNER), locked, chatsV2Access(locked, OWNER), {op:'share', ids:[1], args:{emails:['x@other.com']}}), /Not a teammate/);
    sharedOk=false;
    await assert.rejects(chatsV2Act(env, deps(), P(OWNER), locked, chatsV2Access(locked, OWNER), {op:'share', ids:[3], args:{emails:[RAHUL]}}), /isn't available yet/);
  });
  test('a SharedWith edit from the Leads tab reaches the chat row; a lead without the column leaves it alone', async()=>{
    await chatsV2ApplyLeadPatch(env, 3, {SharedWith:',rahul@acme.com,'});
    assert.equal(row(3).shared_with, ',rahul@acme.com,');
    assert.equal(chatsV2FieldsFromLead({Name:'x', Owner:ANU}, row(3)).shared_with, undefined);
    assert.equal(chatsV2FieldsFromLead({Name:'x', Owner:ANU, SharedWith:null}, row(3)).shared_with, '');
  });
});

// ── Leads tab: SharedWith through the dashboard passthrough ─────────────────
const SECRET='share-secret';
async function session(cid, email){
  const body=btoa(JSON.stringify({cid:String(cid), email, exp:Math.floor(Date.now()/1000)+3600}));
  const key=await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const sig=await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `${body}.${btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}`;
}
describe('Leads tab passthrough', ()=>{
  const realFetch=globalThis.fetch;
  let env, lead, patches, emails;
  beforeEach(()=>{
    _resetLeadsSharedReady();
    env={SESSION_SIGNING_KEY:SECRET, NOCODB_BASE:'https://nc.test', NOCODB_TOKEN:'nc', RESEND_API_KEY:'re'};
    lead={Id:5, ClientId:'7', Owner:ANU, Name:'Fatima', SharedWith:null};
    patches=[]; emails=[];
    globalThis.fetch=async(url, init={})=>{
      url=String(url); const method=init.method||'GET';
      const ok=d=>new Response(JSON.stringify(d), {status:200});
      if(url.startsWith('https://api.resend.com')){ emails.push(JSON.parse(init.body)); return ok({}); }
      if(!url.startsWith('https://nc.test')) return ok({});
      const u=new URL(url);
      if(u.pathname.includes('/meta/tables/')) return ok({columns:[{title:'Owner'}, {title:'SharedWith'}]});
      if(u.pathname.endsWith('/records/5')) return ok(lead);
      if(/\/records\/7$/.test(u.pathname)) return ok({...CLIENT, team_permissions:JSON.stringify({[RAHUL]:{role:'telecaller'}})});
      if(method==='PATCH'){ const b=JSON.parse(init.body); patches.push(b); Object.assign(lead, b); return ok(b); }
      return ok({list:[]});
    };
  });
  afterEach(()=>{ globalThis.fetch=realFetch; });
  const save=async(as, body)=>{
    const r=await worker.fetch(new Request('https://w.test/nocodb/api/v2/tables/mvg6rcw0ia5qqrx/records', {method:'PATCH', headers:{Authorization:'Bearer '+await session(7, as), 'Content-Type':'application/json'}, body:JSON.stringify(body)}), env, {});
    return {status:r.status, data:await r.json().catch(()=>({}))};
  };

  test("the lead's owner shares it: cleaned to teammates (never the owner), new teammate emailed", async()=>{
    const r=await save(ANU, {Id:5, Name:'Fatima', SharedWith:',Rahul@acme.com,anu@acme.com,stranger@x.com,'});
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(patches.at(-1).SharedWith, ',rahul@acme.com,');
    assert.equal(emails.length, 1);
    assert.deepEqual(emails[0].to, [RAHUL]);
    assert.match(emails[0].subject, /shared with you: Fatima/);
  });
  test('a teammate who is not the owner cannot change sharing, but can save the lead with it unchanged', async()=>{
    lead.SharedWith=',rahul@acme.com,';
    let r=await save(RAHUL, {Id:5, SharedWith:''});
    assert.equal(r.status, 403);
    assert.match(r.data.error, /owner or an admin/);
    assert.equal(patches.length, 0);
    r=await save(RAHUL, {Id:5, Name:'Fatima K', SharedWith:',rahul@acme.com,'});
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(lead.Name, 'Fatima K');
    assert.equal(emails.length, 0, 'nobody newly added');
  });
  test('saves without SharedWith are untouched (no extra reads, no checks)', async()=>{
    const r=await save(RAHUL, {Id:5, Name:'Only a name'});
    assert.equal(r.status, 200);
    assert.deepEqual(patches, [{Id:5, Name:'Only a name'}]);
  });
});
