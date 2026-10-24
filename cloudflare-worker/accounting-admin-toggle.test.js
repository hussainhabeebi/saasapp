// Admin → Edit client → 💰 Accounting module (worker.js handleAdminAccountingToggle): the flag must
// really be stored before admin is told it saved — NocoDB can silently ignore a PATCH to a column
// that was created a moment earlier, which is exactly what the first-ever enable does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';

const CLIENTS='mxl33bg4wi70fqj';
const env={SESSION_SIGNING_KEY:'s', NOCODB_BASE:'https://nc.test', NOCODB_TOKEN:'t'};
async function adminToken(secret){
  const body=btoa(JSON.stringify({role:'admin', exp:Math.floor(Date.now()/1000)+3600}));
  const key=await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const sig=await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `${body}.${btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}`;
}
async function toggle({ignorePatches}, enabled='Yes'){
  const record={Id:7, client_name:'Acme'}; let columns=[{title:'client_name'}], patches=0, created=[];
  const realFetch=globalThis.fetch, realSetTimeout=globalThis.setTimeout;
  globalThis.setTimeout=(fn)=>realSetTimeout(fn, 0);
  globalThis.fetch=async (url, opts={})=>{
    const u=String(url);
    if(u.includes(`/api/v2/meta/tables/${CLIENTS}/fields`)){ const b=JSON.parse(opts.body); created.push(b.title); columns.push({title:b.title}); return Response.json({}); }
    if(u.includes(`/api/v2/meta/tables/${CLIENTS}`)) return Response.json({columns});
    if(u.includes(`/tables/${CLIENTS}/records`) && opts.method==='PATCH'){ patches++; if(patches>ignorePatches) Object.assign(record, JSON.parse(opts.body)); return Response.json({Id:7}); }
    if(u.includes(`/tables/${CLIENTS}/records/7`)) return Response.json({...record});
    return Response.json({list:[]});
  };
  try{
    const r=await worker.fetch(new Request('https://worker.test/admin/accounting-module', {method:'POST',
      headers:{Authorization:`Bearer ${await adminToken(env.SESSION_SIGNING_KEY)}`, 'Content-Type':'application/json'}, body:JSON.stringify({client_id:7, enabled})}), env, {waitUntil(){}});
    return {status:r.status, data:await r.json(), record, patches, created};
  }finally{ globalThis.fetch=realFetch; globalThis.setTimeout=realSetTimeout; }
}

test('first enable creates the column and retries until the value is really stored', async ()=>{
  const r=await toggle({ignorePatches:1});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.created, ['accounting_enabled']);
  assert.equal(r.record.accounting_enabled, 'Yes');
  assert.equal(r.patches, 2);
});
test('a write that never sticks is reported as a failure, not "saved"', async ()=>{
  const r=await toggle({ignorePatches:99});
  assert.notEqual(r.status, 200);
  assert.match(r.data.error, /accounting_enabled/);
});
test('needs an admin session', async ()=>{
  const r=await worker.fetch(new Request('https://worker.test/admin/accounting-module', {method:'POST', body:'{}'}), env, {waitUntil(){}});
  assert.equal(r.status, 401);
});
