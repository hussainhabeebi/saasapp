// Cold-lead auto-reallocation (Settings → 🔀 Lead Routing) — decision helpers, plus the daily
// sweep end to end against the real migration (node:sqlite through the same D1 shim
// meetings.test.js uses) and a stubbed NocoDB.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  coldReallocSettings,
  coldReallocLastOwnerNoteMs,
  coldReallocPickNext,
  coldReallocDecide,
  coldReallocProcessClient,
} from './worker.js';

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
const DAY=86400000;
const CFG={enabled:true, days:7, maxHops:3, enabledAt:''};

describe('helpers', ()=>{
  test('settings default and clamp', ()=>{
    assert.deepEqual(coldReallocSettings({}), {enabled:false, days:7, maxHops:3, enabledAt:''});
    assert.deepEqual(coldReallocSettings({coldRealloc:{enabled:true, days:0, maxHops:99}}), {enabled:true, days:7, maxHops:3, enabledAt:''});
    assert.equal(coldReallocSettings({coldRealloc:{enabled:true, days:10}}).days, 10);
  });

  test('last owner note ignores other authors and the system note', ()=>{
    const notes=JSON.stringify([
      {text:'x', ts:'2026-09-20T00:00:00Z', author:'auto-allocation'},
      {text:'y', ts:'2026-09-19T00:00:00Z', author:'b@x.com'},
      {text:'z', ts:'2026-09-10T00:00:00Z', author:'A@x.com'},
      {text:'old', ts:'2026-09-05T00:00:00Z'},
    ]);
    assert.equal(coldReallocLastOwnerNoteMs(notes, 'a@x.com'), Date.parse('2026-09-10T00:00:00Z'));
    assert.equal(coldReallocLastOwnerNoteMs('not json', 'a@x.com'), 0);
  });

  test('pick next skips previous owners and wraps', ()=>{
    const pool=['c@x.com','a@x.com','b@x.com'];
    assert.equal(coldReallocPickNext(pool, 'a@x.com', []), 'b@x.com');
    assert.equal(coldReallocPickNext(pool, 'c@x.com', []), 'a@x.com');
    assert.equal(coldReallocPickNext(pool, 'a@x.com', ['b@x.com']), 'c@x.com');
    assert.equal(coldReallocPickNext(pool, 'a@x.com', ['b@x.com','c@x.com']), null);
    assert.equal(coldReallocPickNext(pool, 'owner@x.com', []), 'a@x.com');
  });

  test('decide: move, warn, note resets clock, hot is never moved, hop cap', ()=>{
    const now=Date.parse('2026-09-27T02:00:00Z');
    const track={owner:'a@x.com', owner_since:new Date(now-8*DAY).toISOString(), realloc_count:0, warned_at:null};
    assert.equal(coldReallocDecide({lead:{Score:'Cold'}, track, cfg:CFG, nowMs:now}).action, 'move');
    assert.equal(coldReallocDecide({lead:{Score:'Hot'}, track, cfg:CFG, nowMs:now}).action, 'none');
    assert.equal(coldReallocDecide({lead:{Score:'Cold'}, track:{...track, realloc_count:3}, cfg:CFG, nowMs:now}).action, 'none');
    const noted={Score:'Cold', NotesList:JSON.stringify([{text:'called, busy', ts:new Date(now-2*DAY).toISOString(), author:'a@x.com'}])};
    assert.equal(coldReallocDecide({lead:noted, track, cfg:CFG, nowMs:now}).action, 'none');
    const t6={...track, owner_since:new Date(now-5.5*DAY).toISOString()};
    assert.equal(coldReallocDecide({lead:{Score:'Cold'}, track:t6, cfg:CFG, nowMs:now}).action, 'warn');
    assert.equal(coldReallocDecide({lead:{Score:'Cold'}, track:{...t6, warned_at:new Date(now-DAY).toISOString()}, cfg:CFG, nowMs:now}).action, 'none');
  });
});

describe('coldReallocProcessClient', ()=>{
  let db, env, origFetch, leads, patches, emails;
  const client={Id:5, authentik_email:'boss@x.com', team_emails:'boss@x.com,a@x.com,b@x.com,c@x.com',
    lead_routing:JSON.stringify({coldRealloc:{enabled:true, days:7, maxHops:3}})};

  beforeEach(()=>{
    db=new DatabaseSync(':memory:');
    db.exec(readFileSync(new URL('./migrations/0106_lead_cold_realloc.sql', import.meta.url), 'utf8'));
    env={DB:d1(db), NOCODB_BASE:'https://noco.test', NOCODB_TOKEN:'x', RESEND_API_KEY:'k'};
    patches=[]; emails=[];
    leads=[
      {Id:1, Name:'Cold silent', Owner:'a@x.com', Stage:'new', Score:'Cold', NotesList:''},
      {Id:2, Name:'Cold noted', Owner:'a@x.com', Stage:'new', Score:'Cold', NotesList:''},
      {Id:3, Name:'Warm', Owner:'a@x.com', Stage:'new', Score:'Warm', NotesList:''},
      {Id:4, Name:'Won', Owner:'a@x.com', Stage:'won', Score:'Cold', NotesList:''},
      {Id:5, Name:'Owner-held', Owner:'boss@x.com', Stage:'new', Score:'Cold', NotesList:''},
    ];
    origFetch=globalThis.fetch;
    globalThis.fetch=async (url, init={})=>{
      url=String(url);
      if(url.startsWith('https://api.resend.com')){ emails.push(JSON.parse(init.body)); return new Response('{}'); }
      if(init.method==='PATCH'){ const b=JSON.parse(init.body); patches.push(b); const l=leads.find(x=>x.Id===b.Id); Object.assign(l, b); return new Response('{}'); }
      return new Response(JSON.stringify({list:leads}));
    };
  });
  afterEach(()=>{ globalThis.fetch=origFetch; db.close(); });

  test('moves only the cold lead with no owner note, after the configured days', async ()=>{
    const t0=new Date('2026-09-01T02:00:00Z');
    await coldReallocProcessClient(env, client, t0); // first sighting starts the clock
    assert.equal(patches.length, 0);
    const day3=new Date(t0.getTime()+3*DAY);
    leads[1].NotesList=JSON.stringify([{text:'will call Monday', ts:day3.toISOString(), author:'a@x.com'}]);

    const day5=new Date(t0.getTime()+5*DAY);
    await coldReallocProcessClient(env, client, day5);
    assert.equal(emails.length, 1, 'warning email 2 days before');
    assert.equal(emails[0].to[0], 'a@x.com');

    const day7=new Date(t0.getTime()+7*DAY);
    const res=await coldReallocProcessClient(env, client, day7);
    assert.equal(res.moved, 1);
    assert.deepEqual(patches.map(p=>[p.Id, p.Owner]), [[1, 'b@x.com']]);
    assert.match(JSON.parse(leads[0].NotesList)[0].text, /Auto-reallocated from a@x.com to b@x.com/);
    assert.equal(emails.at(-1).to[0], 'b@x.com');
    const row=db.prepare('SELECT * FROM lead_owner_tracking WHERE lead_id=1').get();
    assert.equal(row.owner, 'b@x.com');
    assert.equal(row.realloc_count, 1);
    assert.deepEqual(JSON.parse(row.previous_owners), ['a@x.com']);

    // Next week it moves on to c, never back to a; after that the pool is exhausted.
    await coldReallocProcessClient(env, client, new Date(t0.getTime()+14*DAY));
    assert.equal(leads[0].Owner, 'c@x.com');
    await coldReallocProcessClient(env, client, new Date(t0.getTime()+21*DAY));
    assert.equal(leads[0].Owner, 'c@x.com');
  });

  test('a manual reassignment restarts the clock', async ()=>{
    const t0=new Date('2026-09-01T02:00:00Z');
    await coldReallocProcessClient(env, client, t0);
    leads[0].Owner='c@x.com';
    await coldReallocProcessClient(env, client, new Date(t0.getTime()+6*DAY));
    await coldReallocProcessClient(env, client, new Date(t0.getTime()+8*DAY));
    assert.equal(patches.filter(p=>p.Id===1).length, 0);
    await coldReallocProcessClient(env, client, new Date(t0.getTime()+13*DAY));
    assert.equal(leads[0].Owner, 'b@x.com', 'skips a, who had it before the manual move');
  });

  test('disabled does nothing', async ()=>{
    const off={...client, lead_routing:'{}'};
    await coldReallocProcessClient(env, off, new Date());
    assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_owner_tracking').get().n, 0);
  });
});
