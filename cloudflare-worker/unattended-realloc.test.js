// Baby Care: leads reassigned when their owner is On leave or hasn't opened them in time
// (Settings → 🔀 Lead Routing), lead-open tracking, and on-leave staff skipped by new-lead routing.
// Sweep run end to end against the real migrations (node:sqlite D1 shim) and a stubbed NocoDB.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { unattendedReallocSettings, staffOnLeave, unattendedPool, unattendedDecide, recordLeadOpen,
  unattendedReallocProcessClient, engineResolveLeadOwner } from './worker.js';

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
const BC=JSON.stringify({ecom_communication_style:'baby_care'});
const routing=(extra={})=>JSON.stringify({enabled:true, modes:['roundrobin'], unattended:{enabled:true, hours:4, enabledAt:ENABLED_AT},
  rules:{'a@x.com':{inPool:true}, 'b@x.com':{inPool:true}, 'c@x.com':{inPool:true}}, ...extra});
const client=(lr=routing())=>({Id:5, industry:'ecommerce', bot_config:BC, authentik_email:'boss@x.com', team_emails:'boss@x.com,a@x.com,b@x.com,c@x.com', lead_routing:lr});

describe('helpers', ()=>{
  test('settings default and clamp', ()=>{
    assert.deepEqual(unattendedReallocSettings({}), {enabled:false, hours:4, enabledAt:''});
    assert.equal(unattendedReallocSettings({unattended:{enabled:true, hours:100}}).hours, 4);
    assert.equal(unattendedReallocSettings({unattended:{enabled:true, hours:2}}).hours, 2);
  });
  test('on leave is Baby Care only; the pool skips anyone on leave', ()=>{
    const lr=routing({rules:{'a@x.com':{inPool:true, onLeave:true}, 'b@x.com':{inPool:true}, 'c@x.com':{inPool:true}}});
    assert.deepEqual([...staffOnLeave(client(lr))], ['a@x.com']);
    assert.deepEqual([...staffOnLeave({...client(lr), bot_config:'{}'})], []);
    assert.deepEqual(unattendedPool(client(lr)).sort(), ['b@x.com', 'c@x.com']);
  });
  test('decide: unopened past the window moves; opened, early, old, capped or inactive leads stay', ()=>{
    const cfg={enabled:true, hours:4, enabledAt:ENABLED_AT};
    const now=Date.parse('2026-10-17T15:00:00Z');
    const lead={Owner:'a@x.com', Stage:'new', LastMsgAt:'2026-10-17T10:00:00Z'};
    const track={owner:'a@x.com', owner_since:'2026-10-17T10:00:00Z', realloc_count:0};
    assert.equal(unattendedDecide({lead, track, openedMs:0, cfg, onLeave:new Set(), nowMs:now}), 'unopened');
    assert.equal(unattendedDecide({lead, track, openedMs:Date.parse('2026-10-17T11:00:00Z'), cfg, onLeave:new Set(), nowMs:now}), 'none');
    // opened before they got it doesn't count
    assert.equal(unattendedDecide({lead, track, openedMs:Date.parse('2026-10-17T09:00:00Z'), cfg, onLeave:new Set(), nowMs:now}), 'unopened');
    assert.equal(unattendedDecide({lead, track, openedMs:0, cfg, onLeave:new Set(), nowMs:Date.parse('2026-10-17T13:00:00Z')}), 'none');
    assert.equal(unattendedDecide({lead, track:{...track, owner_since:'2026-09-20T10:00:00Z'}, openedMs:0, cfg, onLeave:new Set(), nowMs:Date.parse('2026-09-21T10:00:00Z')}), 'none');
    assert.equal(unattendedDecide({lead, track:{...track, realloc_count:3}, openedMs:0, cfg, onLeave:new Set(), nowMs:now}), 'none');
    assert.equal(unattendedDecide({lead:{...lead, Stage:'won'}, track, openedMs:0, cfg, onLeave:new Set(), nowMs:now}), 'none');
    // on leave: moves at once, even when "unopened" is switched off — but not a lead quiet for weeks
    assert.equal(unattendedDecide({lead, track, openedMs:now, cfg:{...cfg, enabled:false}, onLeave:new Set(['a@x.com']), nowMs:Date.parse('2026-10-17T10:30:00Z')}), 'leave');
    assert.equal(unattendedDecide({lead:{...lead, LastMsgAt:'2026-09-01T10:00:00Z'}, track:{...track, owner_since:'2026-09-01T10:00:00Z'}, openedMs:0, cfg, onLeave:new Set(['a@x.com']), nowMs:now}), 'none');
  });
});

const withOrders=c=>({...c, ecom_table_ids:JSON.stringify({orders:'ord1'})});
describe('unattendedReallocProcessClient', ()=>{
  let db, env, origFetch, leads, orders, patches, emails;
  beforeEach(()=>{
    db=new DatabaseSync(':memory:');
    db.exec(readFileSync(new URL('./migrations/0106_lead_cold_realloc.sql', import.meta.url), 'utf8'));
    db.exec(readFileSync(new URL('./migrations/0115_lead_opens.sql', import.meta.url), 'utf8'));
    env={DB:d1(db), NOCODB_BASE:'https://noco.test', NOCODB_TOKEN:'x', RESEND_API_KEY:'k'};
    patches=[]; emails=[];
    leads=[
      {Id:1, Name:'Unopened', Phone:'919876543210', Owner:'a@x.com', Stage:'new', CreatedAt:'2026-10-17T10:00:00Z', LastMsgAt:'2026-10-17T10:00:00Z', NotesList:''},
      {Id:2, Name:'Opened', Phone:'919800000000', Owner:'a@x.com', Stage:'new', CreatedAt:'2026-10-17T10:00:00Z', LastMsgAt:'2026-10-17T10:00:00Z', NotesList:''},
      {Id:3, Name:'Owner-held', Phone:'919811111111', Owner:'boss@x.com', Stage:'new', CreatedAt:'2026-10-17T10:00:00Z', LastMsgAt:'2026-10-17T10:00:00Z', NotesList:''},
    ];
    orders=[{Id:50, client_id:'5', customer_phone:'919876543210', status:'pending', assigned_to:'a@x.com', order_date:'2026-10-17'},
            {Id:51, client_id:'5', customer_phone:'919876543210', status:'delivered', assigned_to:'a@x.com', order_date:'2026-10-17'}];
    origFetch=globalThis.fetch;
    globalThis.fetch=async (url, init={})=>{
      url=String(url);
      if(url.startsWith('https://api.resend.com')){ emails.push(JSON.parse(init.body)); return new Response('{}'); }
      const isOrders=url.includes('/tables/ord1/');
      if(init.method==='PATCH'){
        const b=JSON.parse(init.body); patches.push({table:isOrders?'orders':'leads', body:b});
        for(const x of [].concat(b)) Object.assign((isOrders?orders:leads).find(r=>r.Id===x.Id)||{}, x);
        return new Response('{}');
      }
      if(isOrders) return new Response(JSON.stringify({list:orders}));
      if(url.includes('/tables/mxl33bg4wi70fqj/records/5')) return new Response(JSON.stringify(withOrders(client())));
      return new Response(JSON.stringify({list:leads}));
    };
  });
  afterEach(()=>{ globalThis.fetch=origFetch; db.close(); });
c=>({...c, ecom_table_ids:JSON.stringify({orders:'ord1'})});

  test('moves only the lead its owner never opened, after the window, with its open orders', async ()=>{
    await recordLeadOpen(env, 5, 2, 'A@x.com', new Date('2026-10-17T11:00:00Z'));
    await unattendedReallocProcessClient(env, withOrders(client()), new Date('2026-10-17T12:00:00Z'));
    assert.equal(patches.length, 0, 'still inside the 4-hour window');

    const r=await unattendedReallocProcessClient(env, withOrders(client()), new Date('2026-10-17T14:30:00Z'));
    assert.equal(r.moved, 1);
    const lp=patches.filter(p=>p.table==='leads');
    assert.equal(lp.length, 1);
    assert.equal(lp[0].body.Id, 1);
    assert.equal(lp[0].body.Owner, 'b@x.com');
    assert.match(JSON.parse(lp[0].body.NotesList)[0].text, /not opened by a@x.com within 4 hours/);
    assert.equal(emails[0].to[0], 'b@x.com');
    // the open order follows the lead; the delivered one stays with whoever handled it
    assert.equal(orders[0].assigned_to, 'b@x.com');
    assert.equal(orders[0].assigned_by, 'auto-reassign');
    assert.equal(orders[1].assigned_to, 'a@x.com');
  });

  test('a teammate on leave hands over their active leads at once', async ()=>{
    const lr=routing({unattended:{enabled:false}, rules:{'a@x.com':{inPool:true, onLeave:true}, 'b@x.com':{inPool:true}, 'c@x.com':{inPool:true}}});
    const r=await unattendedReallocProcessClient(env, client(lr), new Date('2026-10-17T10:05:00Z'));
    assert.equal(r.moved, 2);
    const owners=patches.filter(p=>p.table==='leads').map(p=>p.body.Owner);
    assert.ok(owners.every(o=>o==='b@x.com'||o==='c@x.com'), owners.join());
    assert.match(JSON.parse(patches[0].body.NotesList)[0].text, /a@x.com is on leave/);
  });

  test('other ecom styles are never touched', async ()=>{
    const r=await unattendedReallocProcessClient(env, {...client(), bot_config:'{}'}, new Date('2026-10-18T10:00:00Z'));
    assert.deepEqual(r, {moved:0});
    assert.equal(patches.length, 0);
  });
});

describe('new-lead routing skips teammates on leave (Baby Care)', ()=>{
  let origFetch;
  beforeEach(()=>{ origFetch=globalThis.fetch; globalThis.fetch=async ()=>new Response('{}'); });
  afterEach(()=>{ globalThis.fetch=origFetch; });
  test('round-robin and a catch-all on leave', async ()=>{
    const env={NOCODB_BASE:'https://noco.test', NOCODB_TOKEN:'x'};
    const lr=JSON.stringify({enabled:true, modes:['roundrobin'], rules:{'a@x.com':{inPool:true, onLeave:true}, 'b@x.com':{inPool:true}}});
    for(let i=0;i<3;i++){
      const body={};
      await engineResolveLeadOwner(env, client(lr), 5, body, {phone:'91999'+i}, true);
      assert.equal(body.Owner, 'b@x.com');
    }
    const ca=JSON.stringify({enabled:true, modes:[], catchall:'a@x.com', rules:{'a@x.com':{onLeave:true}}});
    const body={};
    await engineResolveLeadOwner(env, client(ca), 5, body, {phone:'91999'}, true);
    assert.ok(['b@x.com','c@x.com'].includes(body.Owner), body.Owner);
    // same settings on a non-Baby-Care store: on-leave is ignored
    const other={};
    await engineResolveLeadOwner(env, {...client(ca), bot_config:'{}'}, 5, other, {phone:'91999'}, true);
    assert.equal(other.Owner, 'a@x.com');
  });
});
