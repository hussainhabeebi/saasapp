// Lead origin stamp on the /nocodb passthrough (worker.js handleNocodbPassthrough): a lead the
// dashboard creates (Add Lead form, CSV import) is saved with CreatedVia manual / import and the
// teammate's email in CreatedBy, server-side — and the stamp never costs the lead.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';

const LEADS='mvg6rcw0ia5qqrx';
async function token(secret, cid=7, email='rita@biz.com'){
  const body=btoa(JSON.stringify({cid:String(cid), email, exp:Math.floor(Date.now()/1000)+3600}));
  const key=await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const sig=await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `${body}.${btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}`;
}
const env={SESSION_SIGNING_KEY:'s', NOCODB_BASE:'https://nc.test', NOCODB_TOKEN:'t', ALLOWED_ORIGINS:'https://app.leadvyne.com'};
let posts, refuseStamped;
beforeEach(()=>{ posts=[]; refuseStamped=false; });
async function createLead(body){
  const realFetch=globalThis.fetch;
  globalThis.fetch=async (url, opts={})=>{
    const u=String(url);
    if(u.includes('/api/v2/meta/tables/')) return Response.json({columns:[{title:'Name'}, {title:'CreatedVia'}, {title:'CreatedBy'}]});
    if(u.includes(`/tables/${LEADS}/records`) && opts.method==='POST'){
      const b=JSON.parse(opts.body); posts.push(b);
      if(refuseStamped && b.CreatedVia) return Response.json({msg:'unknown column'}, {status:400});
      return Response.json({Id:41});
    }
    return Response.json({list:[]});
  };
  try{
    const session=await token(env.SESSION_SIGNING_KEY);
    const r=await worker.fetch(new Request(`https://worker.test/nocodb/api/v2/tables/${LEADS}/records`, {method:'POST',
      headers:{Authorization:`Bearer ${session}`, 'Content-Type':'application/json'}, body:JSON.stringify(body)}), env, {});
    return {status:r.status, data:await r.json().catch(()=>null)};
  }finally{ globalThis.fetch=realFetch; }
}

test('an Add Lead form lead is stamped manual with who added it', async ()=>{
  const r=await createLead({ClientId:'7', Name:'Asha', Phone:'919800000001'});
  assert.equal(r.status, 200);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].CreatedVia, 'manual');
  assert.equal(posts[0].CreatedBy, 'rita@biz.com');
});

test('an import keeps import; anything else a browser sends becomes manual', async ()=>{
  await createLead({ClientId:'7', Name:'B', Phone:'919800000002', CreatedVia:'import'});
  await createLead({ClientId:'7', Name:'C', Phone:'919800000003', CreatedVia:'chatwoot'});
  assert.deepEqual(posts.map(p=>p.CreatedVia), ['import', 'manual']);
});

test('if NocoDB refuses the stamped row, the lead is still saved as sent', async ()=>{
  refuseStamped=true;
  const r=await createLead({ClientId:'7', Name:'D', Phone:'919800000004'});
  assert.equal(r.status, 200);
  assert.equal(posts.length, 2);
  assert.equal(posts[1].CreatedVia, undefined);
  assert.equal(r.data.Id, 41);
});

/* ── Service Category survives the create (NocoDB dropping it on insert) ── */
async function createWithStore(body, {dropOnInsert}){
  const realFetch=globalThis.fetch;
  const stored={}, calls=[];
  globalThis.fetch=async (url, opts={})=>{
    const u=String(url), m=opts.method||'GET';
    calls.push(m+' '+u.replace('https://nc.test/',''));
    if(u.includes('/api/v2/meta/tables/')) return Response.json({columns:[{title:'Name'}, {title:'CreatedVia'}, {title:'CreatedBy'}, {title:'ServiceCategory'}]});
    if(u.endsWith(`/tables/${LEADS}/records`) && m==='POST'){
      const rows=[].concat(JSON.parse(opts.body)).map((b, i)=>{ const r={...b, Id:41+i}; if(dropOnInsert) delete r.ServiceCategory; stored[r.Id]=r; return {Id:r.Id}; });
      return Response.json(rows.length===1&&!Array.isArray(JSON.parse(opts.body))?rows[0]:rows);
    }
    if(u.endsWith(`/tables/${LEADS}/records`) && m==='PATCH'){ [].concat(JSON.parse(opts.body)).forEach(p=>Object.assign(stored[p.Id], p)); return Response.json([]); }
    const one=u.match(new RegExp(`/tables/${LEADS}/records/(\\d+)`));
    if(one) return Response.json(stored[one[1]]||{});
    return Response.json({list:[]});
  };
  try{
    const session=await token(env.SESSION_SIGNING_KEY);
    const r=await worker.fetch(new Request(`https://worker.test/nocodb/api/v2/tables/${LEADS}/records`, {method:'POST',
      headers:{Authorization:`Bearer ${session}`, 'Content-Type':'application/json'}, body:JSON.stringify(body)}), env, {});
    return {status:r.status, stored, calls};
  }finally{ globalThis.fetch=realFetch; }
}

test('a category the insert dropped is saved back before the browser gets its answer', async ()=>{
  const r=await createWithStore({ClientId:'7', Name:'E', Phone:'919800000005', ServiceCategory:'Hotel'}, {dropOnInsert:true});
  assert.equal(r.status, 200);
  assert.equal(r.stored[41].ServiceCategory, 'Hotel');
  // A bulk create (CSV import) is covered row by row.
  const b=await createWithStore([{ClientId:'7', Phone:'1', ServiceCategory:'Visa'}, {ClientId:'7', Phone:'2'}], {dropOnInsert:true});
  assert.equal(b.stored[41].ServiceCategory, 'Visa');
  assert.equal(b.stored[42].ServiceCategory, undefined);
});

test('a category the insert kept, or no category at all, needs no extra write', async ()=>{
  const kept=await createWithStore({ClientId:'7', Phone:'3', ServiceCategory:'Visa'}, {dropOnInsert:false});
  assert.equal(kept.stored[41].ServiceCategory, 'Visa');
  assert.equal(kept.calls.filter(c=>c.startsWith('PATCH')).length, 0);
  const none=await createWithStore({ClientId:'7', Phone:'4'}, {dropOnInsert:true});
  assert.equal(none.calls.filter(c=>c.includes(`records/41`)).length, 0);
});
