// Admin → Edit client → 💰 Accounting module: the switch is stored in D1 (client_modules) and read
// back by GET /accounting/module-status (dashboard tab + accounting.html) and the ledger routes. A
// client switched on under the old NocoDB column (clients.accounting_enabled) stays on — the first
// read copies that value into D1. Each test uses its own client id: the Worker memoises the flag
// per isolate for a short while.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from './worker.js';

const CLIENTS='mxl33bg4wi70fqj';
function d1(db){
  const prepare=(sql)=>{ let args=[]; const st={
    bind(...a){ args=a.map(v=>v===undefined?null:v); return st; },
    async run(){ const r=db.prepare(sql).run(...args); return {meta:{changes:Number(r.changes), last_row_id:Number(r.lastInsertRowid)}}; },
    async all(){ return {results:db.prepare(sql).all(...args)}; },
    async first(){ return db.prepare(sql).get(...args)||null; } }; return st; };
  return {prepare, async batch(stmts){ const out=[]; for(const s of stmts) out.push(await s.run()); return out; }};
}
async function sign(secret, payload){
  const body=btoa(JSON.stringify({...payload, exp:Math.floor(Date.now()/1000)+3600}));
  const key=await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const sig=await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `${body}.${btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}`;
}
// records: NocoDB client rows by id (the legacy column). Every NocoDB write is counted — the toggle
// must not depend on NocoDB any more.
async function run(records, fn){
  const db=new DatabaseSync(':memory:');
  const env={SESSION_SIGNING_KEY:'s', NOCODB_BASE:'https://nc.test', NOCODB_TOKEN:'t', DB:d1(db)};
  const nc={writes:0};
  const realFetch=globalThis.fetch;
  globalThis.fetch=async (url, opts={})=>{
    const u=String(url);
    if(opts.method && opts.method!=='GET'){ nc.writes++; return Response.json({}); }
    const m=u.match(new RegExp(`/tables/${CLIENTS}/records/(\\d+)`));
    if(m) return records[m[1]]?Response.json(records[m[1]]):new Response('{}', {status:404});
    return Response.json({list:[]});
  };
  const call=async (path, {method='GET', token, body}={})=>{
    const r=await worker.fetch(new Request('https://worker.test'+path, {method, headers:{...(token?{Authorization:`Bearer ${token}`}:{}), 'Content-Type':'application/json'}, ...(body?{body:JSON.stringify(body)}:{})}), env, {waitUntil(){}});
    return {status:r.status, data:await r.json()};
  };
  try{ return await fn({env, db, nc, call, admin:await sign(env.SESSION_SIGNING_KEY, {role:'admin'}), client:cid=>sign(env.SESSION_SIGNING_KEY, {cid})}); }
  finally{ globalThis.fetch=realFetch; }
}

test('admin switches Accounting on and off in D1 — no NocoDB column or write needed', async ()=>{
  await run({101:{Id:101, client_name:'Acme'}}, async ({db, nc, call, admin, client})=>{
    const tok=await client(101);
    assert.equal((await call('/accounting/module-status', {token:tok})).data.accounting_enabled, 'No');
    const on=await call('/admin/accounting-module', {method:'POST', token:admin, body:{client_id:101, enabled:'Yes'}});
    assert.equal(on.status, 200, JSON.stringify(on.data));
    assert.equal(db.prepare(`SELECT accounting_enabled FROM client_modules WHERE client_id=101`).get().accounting_enabled, 1);
    assert.equal((await call('/accounting/module-status', {token:tok})).data.accounting_enabled, 'Yes');
    assert.deepEqual((await call('/admin/accounting-module', {token:admin})).data.modules, [{client_id:101, accounting_enabled:'Yes'}]);
    await call('/admin/accounting-module', {method:'POST', token:admin, body:{client_id:101, enabled:'No'}});
    assert.equal((await call('/accounting/module-status', {token:tok})).data.accounting_enabled, 'No');
    assert.equal(nc.writes, 0);
  });
});
test('a client switched on under the old NocoDB column stays on and is copied into D1', async ()=>{
  await run({102:{Id:102, client_name:'Aiingo', accounting_enabled:'Yes'}}, async ({db, call, client})=>{
    assert.equal((await call('/accounting/module-status', {token:await client(102)})).data.accounting_enabled, 'Yes');
    assert.deepEqual({...db.prepare(`SELECT accounting_enabled, updated_by FROM client_modules WHERE client_id=102`).get()}, {accounting_enabled:1, updated_by:'migrated-from-nocodb'});
  });
});
test('the D1 value wins over the old column once admin has set it', async ()=>{
  await run({103:{Id:103, client_name:'Beta', accounting_enabled:'Yes'}}, async ({call, admin, client})=>{
    await call('/admin/accounting-module', {method:'POST', token:admin, body:{client_id:103, enabled:'No'}});
    assert.equal((await call('/accounting/module-status', {token:await client(103)})).data.accounting_enabled, 'No');
  });
});
test('the switch and the list need an admin session; the status needs a client session', async ()=>{
  await run({}, async ({call, client})=>{
    assert.equal((await call('/admin/accounting-module', {method:'POST', body:{client_id:1, enabled:'Yes'}})).status, 401);
    assert.equal((await call('/admin/accounting-module', {token:await client(104)})).status, 401);
    assert.equal((await call('/accounting/module-status')).status, 401);
  });
});
