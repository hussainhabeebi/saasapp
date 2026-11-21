// Unassigned-lead auto-assign (Settings → 🔀 Lead Routing → "Auto-assign unassigned leads to the
// pool") — pool and eligibility helpers plus the 15-minute sweep end to end against an in-memory
// D1 (node:sqlite shim, as idle-realloc.test.js) and a stubbed NocoDB.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { assignUnassignedSettings, assignUnassignedPool, assignUnassignedEligible, assignUnassignedProcessClient,
  UNASSIGNED_ASSIGN_MAX_PER_RUN } from './worker.js';

function d1(db){
  return {prepare(sql){
    let args=[];
    const st={
      bind(...a){ args=a; return st; },
      async run(){ const r=db.prepare(sql).run(...args); return {meta:{changes:Number(r.changes), last_row_id:Number(r.lastInsertRowid)}}; },
      async all(){ return {results:db.prepare(sql).all(...args)}; },
      async first(){ return db.prepare(sql).get(...args)||null; },
    };
    return st;
  }};
}
const routing=(extra={})=>JSON.stringify({enabled:true, modes:['roundrobin'], assignUnassigned:{enabled:true},
  rules:{'a@x.com':{inPool:true}, 'b@x.com':{inPool:true}, 'c@x.com':{}}, ...extra});
const client=(lr=routing())=>({Id:5, authentik_email:'boss@x.com', team_emails:'boss@x.com,a@x.com,b@x.com,c@x.com', lead_routing:lr});

describe('helpers', ()=>{
  test('settings default off', ()=>{
    assert.deepEqual(assignUnassignedSettings({}), {enabled:false});
    assert.deepEqual(assignUnassignedSettings({assignUnassigned:{enabled:true}}), {enabled:true});
  });
  test('pool is the In pool teammates, else every teammate but the account owner', ()=>{
    assert.deepEqual(assignUnassignedPool(client()), ['a@x.com', 'b@x.com']);
    assert.deepEqual(assignUnassignedPool(client(routing({rules:{}}))), ['a@x.com', 'b@x.com', 'c@x.com']);
  });
  test('only open leads with no owner', ()=>{
    assert.equal(assignUnassignedEligible({Owner:'', Stage:'new'}), true);
    assert.equal(assignUnassignedEligible({Owner:'a@x.com', Stage:'new'}), false);
    assert.equal(assignUnassignedEligible({Owner:'', Stage:'won'}), false);
    assert.equal(assignUnassignedEligible({Owner:'', OptOut:'Yes'}), false);
    assert.equal(assignUnassignedEligible({Owner:'', HandoverOutcome:'Spam'}), false);
  });
});

describe('assignUnassignedProcessClient', ()=>{
  let db, env, origFetch, leads, patches, emails;
  beforeEach(()=>{
    db=new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE lead_rr_counter (client_id INTEGER PRIMARY KEY, n INTEGER NOT NULL, updated_at TEXT);
      CREATE TABLE channel_inbox_assignments (client_id INTEGER NOT NULL, inbox_id INTEGER NOT NULL, assigned_email TEXT NOT NULL DEFAULT '', PRIMARY KEY (client_id, inbox_id));`);
    env={DB:d1(db), NOCODB_BASE:'https://noco.test', NOCODB_TOKEN:'x', RESEND_API_KEY:'k'};
    patches=[]; emails=[];
    leads=[
      {Id:1, Name:'One', Owner:'', Stage:'new', NotesList:''},
      {Id:2, Name:'Two', Owner:'', Stage:'new', NotesList:''},
      {Id:3, Name:'Three', Owner:'', Stage:'new', NotesList:''},
      {Id:4, Name:'Closed', Owner:'', Stage:'lost', NotesList:''},
      {Id:5, Name:'Channel', Owner:'', Stage:'new', InboxId:9, NotesList:''},
    ];
    origFetch=globalThis.fetch;
    globalThis.fetch=async (url, init={})=>{
      url=String(url);
      if(url.startsWith('https://api.resend.com')){ emails.push(JSON.parse(init.body)); return new Response('{}'); }
      if(init.method==='PATCH'){ const b=JSON.parse(init.body); patches.push(b); Object.assign(leads.find(x=>x.Id===b.Id), b); return new Response('{}'); }
      return new Response(JSON.stringify({list:leads.filter(l=>!l.Owner)}));
    };
  });
  afterEach(()=>{ globalThis.fetch=origFetch; db.close(); });

  test('hands open unassigned leads out round-robin, channel leads to their channel owner', async ()=>{
    db.prepare(`INSERT INTO channel_inbox_assignments VALUES (5, 9, 'c@x.com')`).run();
    const r=await assignUnassignedProcessClient(env, client());
    assert.equal(r.assigned, 4);
    const owner=id=>patches.find(p=>p.Id===id)?.Owner;
    assert.deepEqual([owner(1), owner(2), owner(3)], ['a@x.com', 'b@x.com', 'a@x.com']);
    assert.equal(owner(5), 'c@x.com');
    assert.equal(owner(4), undefined, 'a lost lead stays put');
    assert.match(JSON.parse(patches[0].NotesList)[0].text, /Auto-assigned to a@x.com/);
    assert.deepEqual(emails.map(e=>e.to[0]).sort(), ['a@x.com', 'b@x.com', 'c@x.com']);
    assert.match(emails.find(e=>e.to[0]==='a@x.com').subject, /2 leads assigned/);
    // nothing left to do on the next tick
    assert.deepEqual(await assignUnassignedProcessClient(env, client()), {assigned:0});
  });

  test('caps the leads per run', async ()=>{
    leads=Array.from({length:UNASSIGNED_ASSIGN_MAX_PER_RUN+10}, (_, i)=>({Id:100+i, Name:`L${i}`, Owner:'', Stage:'new', NotesList:''}));
    assert.equal((await assignUnassignedProcessClient(env, client())).assigned, UNASSIGNED_ASSIGN_MAX_PER_RUN);
  });

  test('does nothing when switched off', async ()=>{
    const off=client(routing({assignUnassigned:{enabled:false}}));
    assert.deepEqual(await assignUnassignedProcessClient(env, off), {assigned:0});
    assert.equal(patches.length, 0);
  });
});
