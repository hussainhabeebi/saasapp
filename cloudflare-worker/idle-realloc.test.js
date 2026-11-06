// Not-called / unanswered lead auto-reassign (Settings → 🔀 Lead Routing → "Reassign not-called &
// unanswered leads") — decision helpers plus the 15-minute sweep end to end against the real
// lead_owner_tracking migration (node:sqlite D1 shim, as hot-realloc.test.js) and a stubbed NocoDB.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { idleReallocSettings, idleReallocLastCall, idleReallocDecide, idleReallocProcessClient,
  IDLE_REALLOC_MAX_PER_RUN } from './worker.js';

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
const H=3600000;
const ENABLED_AT='2026-10-01T00:00:00Z';
const calls=(...c)=>JSON.stringify(c);

describe('helpers', ()=>{
  test('settings default and clamp', ()=>{
    assert.deepEqual(idleReallocSettings({}), {enabled:false, hours:24, enabledAt:''});
    assert.equal(idleReallocSettings({idleRealloc:{enabled:true, hours:500}}).hours, 24);
    assert.equal(idleReallocSettings({idleRealloc:{enabled:true, hours:48}}).hours, 48);
  });
  test('last call is the newest by time, with its outcome', ()=>{
    assert.deepEqual(idleReallocLastCall(calls({at:'2026-10-02T10:00:00Z', outcome:'Answered'}, {date:'2026-10-03T09:00:00Z', outcome:'No Answer'})),
      {ms:Date.parse('2026-10-03T09:00:00Z'), outcome:'No Answer'});
    assert.equal(idleReallocLastCall('nope'), null);
    assert.equal(idleReallocLastCall(''), null);
  });
  test('decide: not called / unanswered past the window move; answered, early, closed, stale or capped stay', ()=>{
    const cfg={enabled:true, hours:24, enabledAt:ENABLED_AT};
    const now=Date.parse('2026-10-06T12:00:00Z');
    const lead={Owner:'a@x.com', Stage:'new', CreatedAt:'2026-10-05T10:00:00Z', CallLog:''};
    const track={owner:'a@x.com', owner_since:'2026-10-05T10:00:00Z', realloc_count:0};
    assert.equal(idleReallocDecide({lead, track, cfg, nowMs:now}), 'not_called');
    assert.equal(idleReallocDecide({lead, track, cfg, nowMs:Date.parse('2026-10-06T09:00:00Z')}), 'none', 'inside the window');
    assert.equal(idleReallocDecide({lead:{...lead, CallLog:calls({at:'2026-10-05T11:00:00Z', outcome:'No Answer'})}, track, cfg, nowMs:now}), 'unanswered');
    assert.equal(idleReallocDecide({lead:{...lead, CallLog:calls({at:'2026-10-05T11:00:00Z', outcome:'Answered'})}, track, cfg, nowMs:now}), 'none');
    assert.equal(idleReallocDecide({lead:{...lead, Tags:'VIP, No Answer', CallLog:calls({at:'2026-10-05T11:00:00Z', outcome:''})}, track, cfg, nowMs:now}), 'unanswered');
    // a call by the previous owner doesn't count for the current one
    assert.equal(idleReallocDecide({lead:{...lead, CallLog:calls({at:'2026-10-04T11:00:00Z', outcome:'Answered'})}, track, cfg, nowMs:now}), 'not_called');
    assert.equal(idleReallocDecide({lead:{...lead, Stage:'won'}, track, cfg, nowMs:now}), 'none');
    assert.equal(idleReallocDecide({lead:{...lead, HandoverOutcome:'Spam'}, track, cfg, nowMs:now}), 'none');
    assert.equal(idleReallocDecide({lead, track:{...track, realloc_count:3}, cfg, nowMs:now}), 'none');
    assert.equal(idleReallocDecide({lead, track, cfg, nowMs:now+40*24*H}), 'none', 'inactive for over 30 days');
    assert.equal(idleReallocDecide({lead, track, cfg:{...cfg, enabled:false}, nowMs:now}), 'none');
  });
});

describe('idleReallocProcessClient', ()=>{
  let db, env, origFetch, leads, patches, emails;
  const client={Id:5, authentik_email:'boss@x.com', team_emails:'boss@x.com,a@x.com,b@x.com,c@x.com',
    lead_routing:JSON.stringify({idleRealloc:{enabled:true, hours:24, enabledAt:ENABLED_AT}})};

  beforeEach(()=>{
    db=new DatabaseSync(':memory:');
    db.exec(readFileSync(new URL('./migrations/0106_lead_cold_realloc.sql', import.meta.url), 'utf8'));
    env={DB:d1(db), NOCODB_BASE:'https://noco.test', NOCODB_TOKEN:'x', RESEND_API_KEY:'k'};
    patches=[]; emails=[];
    leads=[
      {Id:1, Name:'Never called', Owner:'a@x.com', Stage:'new', CreatedAt:'2026-10-05T10:00:00Z', CallLog:'', NotesList:''},
      {Id:2, Name:'No answer', Owner:'a@x.com', Stage:'new', CreatedAt:'2026-10-05T10:00:00Z', CallLog:calls({at:'2026-10-05T12:00:00Z', outcome:'No Answer', by:'a@x.com'}), NotesList:''},
      {Id:3, Name:'Reached', Owner:'a@x.com', Stage:'contacted', CreatedAt:'2026-10-05T10:00:00Z', CallLog:calls({at:'2026-10-05T12:00:00Z', outcome:'Answered', by:'a@x.com'}), NotesList:''},
      {Id:4, Name:'Owner-held', Owner:'boss@x.com', Stage:'new', CreatedAt:'2026-10-05T10:00:00Z', CallLog:'', NotesList:''},
      {Id:5, Name:'Backlog', Owner:'b@x.com', Stage:'new', CreatedAt:'2026-09-20T10:00:00Z', CallLog:'', NotesList:''},
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

  test('moves not-called and unanswered leads after a day, one digest email per new owner', async ()=>{
    await idleReallocProcessClient(env, client, new Date('2026-10-05T20:00:00Z'));
    assert.equal(patches.length, 0, 'still inside the 24-hour window');

    const r=await idleReallocProcessClient(env, client, new Date('2026-10-06T10:30:00Z'));
    assert.equal(r.moved, 2);
    assert.deepEqual(patches.map(p=>[p.Id, p.Owner]).sort(), [[1, 'b@x.com'], [2, 'b@x.com']]);
    assert.match(JSON.parse(patches.find(p=>p.Id===1).NotesList)[0].text, /not called by a@x.com within 24 hours/);
    assert.match(JSON.parse(patches.find(p=>p.Id===2).NotesList)[0].text, /last call unanswered/);
    assert.equal(emails.length, 1);
    assert.equal(emails[0].to[0], 'b@x.com');
    assert.match(emails[0].subject, /2 leads reassigned/);
  });

  test('a lead waiting before switch-on gets the full window from first sighting', async ()=>{
    await idleReallocProcessClient(env, client, new Date('2026-10-06T10:30:00Z'));
    assert.ok(!patches.some(p=>p.Id===5), 'backlog lead first seen now');
    await idleReallocProcessClient(env, client, new Date('2026-10-07T10:31:00Z'));
    assert.equal(patches.find(p=>p.Id===5)?.Owner, 'c@x.com');
  });

  test('a moved lead never goes back and stops after 3 moves', async ()=>{
    leads=[leads[0]];
    let t=Date.parse('2026-10-06T10:30:00Z');
    for(let i=0;i<5;i++){ await idleReallocProcessClient(env, client, new Date(t)); t+=25*H; }
    assert.deepEqual(patches.map(p=>p.Owner), ['b@x.com', 'c@x.com'], 'only a, b, c in the team — never back to a');
  });

  test('caps the moves per run', async ()=>{
    leads=Array.from({length:IDLE_REALLOC_MAX_PER_RUN+5}, (_, i)=>({Id:100+i, Name:`L${i}`, Owner:'a@x.com', Stage:'new', CreatedAt:'2026-10-05T10:00:00Z', CallLog:'', NotesList:''}));
    const r=await idleReallocProcessClient(env, client, new Date('2026-10-06T10:30:00Z'));
    assert.equal(r.moved, IDLE_REALLOC_MAX_PER_RUN);
  });

  test('does nothing when switched off', async ()=>{
    const off={...client, lead_routing:JSON.stringify({idleRealloc:{enabled:false}})};
    assert.deepEqual(await idleReallocProcessClient(env, off, new Date('2026-10-08T11:00:00Z')), {moved:0});
    assert.equal(patches.length, 0);
  });
});
