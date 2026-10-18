// Leads read mirror (leads-mirror.js): the D1 copy answers the dashboard's lead-list reads through
// the /nocodb passthrough only when it is switched on, built and verified up to date — everything
// else still goes to NocoDB. Runs against node:sqlite through the same tiny D1 shim the other
// module tests use; NocoDB is an in-memory fetch stub.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from './worker.js';
import { lmParseWhere, lmBuildQuery, lmBuildClient, lmRunBuilds, lmTryServeList } from './leads-mirror.js';

const LEADS='mvg6rcw0ia5qqrx';
const CID=7;

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

async function token(secret, cid=CID, email=''){
  const body=btoa(JSON.stringify({cid:String(cid), ...(email?{email}:{}), exp:Math.floor(Date.now()/1000)+3600}));
  const key=await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const sig=await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `${body}.${btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}`;
}

// ── NocoDB stub: leads for two clients, list with ClientId filter / sort / fields / paging ──
let raw, env, leads, ncCalls;
const COLS=['Id','ClientId','Name','Phone','Date','InboxId','Status','ConvHistory','CreatedAt','UpdatedAt'];
function lead(id, cid, extra={}){
  const t=new Date(Date.UTC(2026, 0, 1, 0, id)).toISOString();
  return {Id:id, ClientId:String(cid), Name:`Lead ${id}`, Phone:`91980000${String(id).padStart(4,'0')}`, Date:t,
    InboxId:null, Status:'New', ConvHistory:'[{"role":"user","text":"hi"}]', CreatedAt:t, UpdatedAt:t, ...extra};
}
function ncList(url){
  const p=url.searchParams;
  const m=decodeURIComponent(p.get('where')||'').match(/^\(ClientId,eq,(\d+)\)/);
  let rows=leads.filter(l=>!m || l.ClientId===m[1]);
  const sort=p.get('sort');
  if(sort){
    const desc=sort.startsWith('-'), f=desc?sort.slice(1):sort;
    rows=[...rows].sort((a,b)=>(a[f]<b[f]?-1:a[f]>b[f]?1:0)*(desc?-1:1));
  }
  const limit=Number(p.get('limit')||25), offset=Number(p.get('offset')||0);
  const fields=p.get('fields')?p.get('fields').split(','):null;
  const page=rows.slice(offset, offset+limit).map(r=>fields?Object.fromEntries(fields.map(f=>[f, r[f]??null])):r);
  return {list:page, pageInfo:{totalRows:rows.length, isLastPage:offset+page.length>=rows.length}};
}
function stubFetch(){
  globalThis.fetch=async (u, opts={})=>{
    const url=new URL(String(u));
    ncCalls.push(`${opts.method||'GET'} ${url.pathname}${url.search}`);
    if(url.pathname.includes('/api/v2/meta/tables/')) return Response.json({columns:COLS.map(title=>({title}))});
    if(url.pathname.endsWith(`/tables/${LEADS}/records`) && (!opts.method||opts.method==='GET')) return Response.json(ncList(url));
    if(url.pathname.endsWith(`/tables/${LEADS}/records`) && opts.method==='DELETE'){
      const ids=[].concat(JSON.parse(opts.body)).map(x=>Number(x.Id));
      leads=leads.filter(l=>!ids.includes(l.Id));
      return Response.json(ids.map(Id=>({Id})));
    }
    return Response.json({list:[]});
  };
}

const realFetch=globalThis.fetch;
beforeEach(()=>{
  globalThis.fetch=realFetch;
  raw=new DatabaseSync(':memory:');
  raw.exec(readFileSync(new URL('./migrations/0117_leads_mirror.sql', import.meta.url), 'utf8'));
  env={DB:d1(raw), SESSION_SIGNING_KEY:'s', NOCODB_BASE:'https://nc.test', NOCODB_TOKEN:'t', ALLOWED_ORIGINS:'https://app.leadvyne.com', LEADS_MIRROR:'all'};
  leads=[...Array.from({length:30}, (_, i)=>lead(i+1, CID)), lead(100, 8), lead(101, 8)];
  ncCalls=[];
  stubFetch();
});

const SLIM='Id,Name,Phone,Date,Status';
async function listViaWorker(qs){
  const session=await token(env.SESSION_SIGNING_KEY);
  const r=await worker.fetch(new Request(`https://worker.test/nocodb/api/v2/tables/${LEADS}/records?${qs}`, {headers:{Authorization:`Bearer ${session}`}}), env, {});
  return {source:r.headers.get('X-Leads-Source')||'nocodb', data:await r.json()};
}
const dashQs=(extra='')=>`where=(ClientId,eq,${CID})&sort=-Date&limit=10&offset=5&fields=${SLIM}${extra}`;
async function ready(){
  await raw.prepare(`INSERT INTO leads_mirror_state (client_id, status) VALUES (?, 'pending')`).run(CID);
  assert.equal(await lmBuildClient(env, LEADS, CID), 'ready');
}

test('where parser handles the dashboard and permission clauses, and refuses mixed ~and/~or', ()=>{
  assert.deepEqual(lmParseWhere('(ClientId,eq,7)'), {field:'ClientId', cmp:'eq', value:'7'});
  const ast=lmParseWhere('(ClientId,eq,7)~and((InboxId,blank)~or((InboxId,neq,1)~and(InboxId,neq,2)))');
  assert.equal(ast.op, 'and');
  assert.equal(ast.terms[1].op, 'or');
  assert.throws(()=>lmParseWhere('(A,eq,1)~and(B,eq,2)~or(C,eq,3)'));
  assert.throws(()=>lmParseWhere('(A,eq,1'));
});

test('only list shapes the copy can answer exactly are taken', ()=>{
  const cols=['Id','ClientId','Name','Date','UpdatedAt'];
  assert.ok(lmBuildQuery(`where=(ClientId,eq,7)&sort=-Date&fields=Id,Name`, 7, cols));
  assert.equal(lmBuildQuery(`where=(ClientId,eq,7)&sort=-Date`, 7, cols), null, 'no fields = ConvHistory too');
  assert.equal(lmBuildQuery(`where=(ClientId,eq,7)&fields=Id,ConvHistory`, 7, cols), null);
  assert.equal(lmBuildQuery(`where=(Name,eq,x)&fields=Id`, 7, cols), null, 'client filter required');
  assert.equal(lmBuildQuery(`where=(ClientId,eq,8)&fields=Id`, 7, cols), null, 'other client');
  assert.equal(lmBuildQuery(`where=(ClientId,eq,7)~and(Date,gte,2026-01-01)&fields=Id`, 7, cols), null, 'unsupported op');
  assert.equal(lmBuildQuery(`where=(ClientId,eq,7)~or(Name,eq,x)&fields=Id`, 7, cols), null, 'client filter under ~or');
  assert.equal(lmBuildQuery(`where=(ClientId,eq,7)&fields=Id&shuffle=1`, 7, cols), null, 'unknown param');
});

test('switched off, the passthrough behaves exactly as before', async ()=>{
  delete env.LEADS_MIRROR;
  const r=await listViaWorker(dashQs());
  assert.equal(r.source, 'nocodb');
  assert.equal(raw.prepare(`SELECT COUNT(*) AS n FROM leads_mirror_state`).get().n, 0);
});

test('first read registers the client and goes to NocoDB; the cron builds the copy', async ()=>{
  const r=await listViaWorker(dashQs());
  assert.equal(r.source, 'nocodb');
  assert.equal(raw.prepare(`SELECT status FROM leads_mirror_state WHERE client_id=?`).get(CID).status, 'pending');
  await lmRunBuilds(env, LEADS);
  const st=raw.prepare(`SELECT * FROM leads_mirror_state WHERE client_id=?`).get(CID);
  assert.equal(st.status, 'ready');
  assert.ok(!JSON.parse(st.columns).includes('ConvHistory'));
  assert.equal(raw.prepare(`SELECT COUNT(*) AS n FROM leads_mirror WHERE client_id=?`).get(CID).n, 30);
  assert.ok(!raw.prepare(`SELECT row FROM leads_mirror LIMIT 1`).get().row.includes('ConvHistory'));
});

test('a ready copy answers with the same rows, order, fields and paging NocoDB would', async ()=>{
  await ready();
  const fromMirror=await listViaWorker(dashQs());
  assert.equal(fromMirror.source, 'mirror');
  const expected=ncList(new URL(`https://nc.test/x?${dashQs()}`));
  assert.deepEqual(fromMirror.data.list, expected.list);
  assert.equal(fromMirror.data.pageInfo.totalRows, 30);
  assert.equal(fromMirror.data.pageInfo.isLastPage, false);
  // Other clients' leads never show.
  assert.ok(fromMirror.data.list.every(l=>l.Id<=30));
});

test('a request that needs ConvHistory still goes to NocoDB', async ()=>{
  await ready();
  const r=await listViaWorker(`where=(ClientId,eq,${CID})&sort=-Date&limit=100`);
  assert.equal(r.source, 'nocodb');
  assert.ok(r.data.list[0].ConvHistory);
});

test('edits and new leads made anywhere show on the next read', async ()=>{
  await ready();
  const later=new Date(Date.UTC(2026, 5, 1)).toISOString();
  Object.assign(leads.find(l=>l.Id===3), {Status:'Won', UpdatedAt:later});
  leads.push(lead(31, CID, {Date:later, UpdatedAt:later, Name:'Brand new'}));
  const r=await listViaWorker(`where=(ClientId,eq,${CID})&sort=-Date&limit=50&fields=${SLIM}`);
  assert.equal(r.source, 'mirror');
  assert.equal(r.data.list[0].Name, 'Brand new');
  assert.equal(r.data.list.find(l=>l.Id===3).Status, 'Won');
  assert.equal(r.data.pageInfo.totalRows, 31);
});

test('a lead deleted outside the Worker makes the copy stale → NocoDB, then the cron fixes it', async ()=>{
  await ready();
  leads=leads.filter(l=>l.Id!==4);
  const r=await listViaWorker(dashQs());
  assert.equal(r.source, 'nocodb');
  assert.equal(raw.prepare(`SELECT status FROM leads_mirror_state WHERE client_id=?`).get(CID).status, 'stale');
  await lmRunBuilds(env, LEADS);
  const again=await listViaWorker(dashQs());
  assert.equal(again.source, 'mirror');
  assert.equal(again.data.pageInfo.totalRows, 29);
});

test('a lead deleted through the passthrough leaves the copy straight away', async ()=>{
  await ready();
  const session=await token(env.SESSION_SIGNING_KEY);
  await worker.fetch(new Request(`https://worker.test/nocodb/api/v2/tables/${LEADS}/records`, {method:'DELETE',
    headers:{Authorization:`Bearer ${session}`, 'Content-Type':'application/json'}, body:JSON.stringify([{Id:5}])}), env, {});
  assert.equal(raw.prepare(`SELECT COUNT(*) AS n FROM leads_mirror WHERE id=5`).get().n, 0);
  const r=await listViaWorker(dashQs());
  assert.equal(r.source, 'mirror');
  assert.equal(r.data.pageInfo.totalRows, 29);
});

test('permission clauses (staff channel visibility) are applied to the copy too', async ()=>{
  await ready();
  for(const l of leads) if(l.Id<=10) l.InboxId='11';
  raw.prepare(`UPDATE leads_mirror SET row=json_set(row, '$."InboxId"', '11') WHERE id<=10`).run();
  const qs=`where=(ClientId,eq,${CID})~and((InboxId,blank)~or(InboxId,neq,11))&sort=-Date&limit=100&fields=${SLIM}`;
  const r=await lmTryServeList(env, LEADS, String(CID), qs);
  assert.equal(r.list.length, 20);
  assert.ok(r.list.every(l=>l.Id>10));
});

test('a pilot list only serves the clients on it', async ()=>{
  await ready();
  env.LEADS_MIRROR='12,13';
  assert.equal((await listViaWorker(dashQs())).source, 'nocodb');
  env.LEADS_MIRROR=`12,${CID}`;
  assert.equal((await listViaWorker(dashQs())).source, 'mirror');
});

test('NocoDB failing during a read falls back instead of erroring', async ()=>{
  await ready();
  globalThis.fetch=async ()=>{ throw new Error('down'); };
  const r=await lmTryServeList(env, LEADS, String(CID), dashQs());
  assert.equal(r, null);
});
