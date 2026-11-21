// Hot-lead auto-reassign (Settings → 🔀 Lead Routing → "Reassign uncalled Hot leads") — decision
// helpers plus the 15-minute sweep end to end against the real lead_owner_tracking migration
// (node:sqlite through the same D1 shim cold-realloc.test.js uses) and a stubbed NocoDB.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { hotReallocSettings, hotReallocLastCallMs, hotReallocDecide, hotReallocProcessClient } from './worker.js';

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
const MIN=60000;
const ENABLED_AT='2026-09-01T00:00:00Z';

describe('helpers', ()=>{
  test('settings default and clamp', ()=>{
    assert.deepEqual(hotReallocSettings({}), {enabled:false, minutes:20, enabledAt:''});
    assert.equal(hotReallocSettings({hotRealloc:{enabled:true, minutes:5}}).minutes, 20);
    assert.equal(hotReallocSettings({hotRealloc:{enabled:true, minutes:30}}).minutes, 30);
  });
  test('last call reads ISO `at` and falls back to the locale date', ()=>{
    const log=JSON.stringify([{at:'2026-09-02T10:00:00Z'}, {date:'2026-09-03T09:00:00Z'}, {}]);
    assert.equal(hotReallocLastCallMs(log), Date.parse('2026-09-03T09:00:00Z'));
    assert.equal(hotReallocLastCallMs('nope'), 0);
  });
  test('decide: uncalled Hot past the window moves; called, Warm, pre-feature or capped leads stay', ()=>{
    const cfg={enabled:true, minutes:20, enabledAt:ENABLED_AT};
    const now=Date.parse('2026-09-05T10:30:00Z');
    const lead={Score:'Hot', CreatedAt:'2026-09-05T10:00:00Z', CallLog:''};
    const track={owner:'a@x.com', owner_since:'2026-09-05T10:00:00Z', realloc_count:0};
    assert.equal(hotReallocDecide({lead, track, cfg, nowMs:now}), 'move');
    assert.equal(hotReallocDecide({lead, track, cfg, nowMs:Date.parse('2026-09-05T10:15:00Z')}), 'none');
    assert.equal(hotReallocDecide({lead:{...lead, Score:'Warm'}, track, cfg, nowMs:now}), 'none');
    assert.equal(hotReallocDecide({lead:{...lead, CallLog:JSON.stringify([{at:'2026-09-05T10:05:00Z'}])}, track, cfg, nowMs:now}), 'none');
    assert.equal(hotReallocDecide({lead:{...lead, CreatedAt:'2026-08-30T10:00:00Z'}, track, cfg, nowMs:now}), 'none');
    assert.equal(hotReallocDecide({lead, track:{...track, realloc_count:2}, cfg, nowMs:now}), 'none');
  });
});

describe('hotReallocProcessClient', ()=>{
  let db, env, origFetch, leads, patches, emails;
  const client={Id:5, authentik_email:'boss@x.com', team_emails:'boss@x.com,a@x.com,b@x.com',
    lead_routing:JSON.stringify({hotRealloc:{enabled:true, minutes:20, enabledAt:ENABLED_AT}})};

  beforeEach(()=>{
    db=new DatabaseSync(':memory:');
    db.exec(readFileSync(new URL('./migrations/0106_lead_cold_realloc.sql', import.meta.url), 'utf8'));
    env={DB:d1(db), NOCODB_BASE:'https://noco.test', NOCODB_TOKEN:'x', RESEND_API_KEY:'k'};
    patches=[]; emails=[];
    leads=[
      {Id:1, Name:'Hot silent', Owner:'a@x.com', Stage:'new', Score:'Hot', CreatedAt:'2026-09-05T10:00:00Z', CallLog:'', NotesList:''},
      {Id:2, Name:'Hot called', Owner:'a@x.com', Stage:'new', Score:'Hot', CreatedAt:'2026-09-05T10:00:00Z', CallLog:JSON.stringify([{at:'2026-09-05T10:04:00Z', by:'a@x.com'}]), NotesList:''},
      {Id:3, Name:'Old hot', Owner:'a@x.com', Stage:'new', Score:'Hot', CreatedAt:'2026-08-20T10:00:00Z', CallLog:'', NotesList:''},
      {Id:4, Name:'Owner-held', Owner:'boss@x.com', Stage:'new', Score:'Hot', CreatedAt:'2026-09-05T10:00:00Z', CallLog:'', NotesList:''},
    ];
    origFetch=globalThis.fetch;
    globalThis.fetch=async (url, init={})=>{
      url=String(url);
      if(url.startsWith('https://api.resend.com')){ emails.push(JSON.parse(init.body)); return new Response('{}'); }
      if(init.method==='PATCH'){ const b=JSON.parse(init.body); patches.push(b); Object.assign(leads.find(x=>x.Id===b.Id), b); return new Response('{}'); }
      return new Response(JSON.stringify({list:leads}));
    };
  });
  afterEach(()=>{ globalThis.fetch=origFetch; db.close(); });

  test('moves only the uncalled new Hot lead once its window passes, and never back', async ()=>{
    await hotReallocProcessClient(env, client, new Date('2026-09-05T10:15:00Z'));
    assert.equal(patches.length, 0, 'still inside the 20-minute window');

    const r=await hotReallocProcessClient(env, client, new Date('2026-09-05T10:30:00Z'));
    assert.equal(r.moved, 1);
    assert.equal(patches[0].Id, 1);
    assert.equal(patches[0].Owner, 'b@x.com');
    assert.match(JSON.parse(patches[0].NotesList)[0].text, /not called within 20 minutes/);
    assert.equal(emails[0].to[0], 'b@x.com');

    // b@x.com doesn't call either — it can't go back to a@x.com, the only other teammate
    await hotReallocProcessClient(env, client, new Date('2026-09-05T11:30:00Z'));
    assert.equal(patches.length, 1);
  });

  test('does nothing when switched off', async ()=>{
    const off={...client, lead_routing:JSON.stringify({hotRealloc:{enabled:false}})};
    assert.deepEqual(await hotReallocProcessClient(env, off, new Date('2026-09-05T11:00:00Z')), {moved:0});
    assert.equal(patches.length, 0);
  });
});
