// Lead Routing → Destination Staff Routing "Save" didn't stick on a CLIENTS table without a
// dest_staff_routing column: NocoDB ignores a PATCH field it doesn't have, the column create only
// tried /fields, and the route echoed back what it meant to save. Now the column is created as
// LongText (via /columns when /fields is refused) and the save is read back before reporting ✓.
import {test, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';

const CLIENTS='mxl33bg4wi70fqj';
async function token(secret, cid=7, email='boss@x.com'){
  const body=btoa(JSON.stringify({cid:String(cid), email, exp:Math.floor(Date.now()/1000)+3600}));
  const key=await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const sig=await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `${body}.${btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}`;
}
const env={SESSION_SIGNING_KEY:'s', NOCODB_BASE:'https://nc.test', NOCODB_TOKEN:'t', ALLOWED_ORIGINS:'https://app.leadvyne.com'};
let columns, row, created, fieldsRoute, columnsRoute;
beforeEach(()=>{
  columns=['Id','industry','authentik_email','team_emails']; created=[]; fieldsRoute=false; columnsRoute=true;
  row={Id:7, industry:'travel', authentik_email:'boss@x.com', team_emails:'anu@x.com,sam@x.com'};
});
async function call(method, body){
  const real=globalThis.fetch;
  globalThis.fetch=async(url, opts={})=>{
    const u=String(url), m=opts.method||'GET';
    if(m==='POST' && (u.endsWith(`/meta/tables/${CLIENTS}/fields`) || u.endsWith(`/meta/tables/${CLIENTS}/columns`))){
      const ok=u.endsWith('/fields')?fieldsRoute:columnsRoute;
      if(!ok) return Response.json({msg:'nope'}, {status:404});
      const b=JSON.parse(opts.body); created.push(b); columns.push(b.title); return Response.json({});
    }
    if(u.includes(`/meta/tables/${CLIENTS}`)) return Response.json({columns:columns.map(title=>({title}))});
    if(u.includes(`/tables/${CLIENTS}/records`) && m==='PATCH'){
      for(const [k,v] of Object.entries(JSON.parse(opts.body))) if(columns.includes(k)) row[k]=v;
      return Response.json({Id:7});
    }
    if(u.includes(`/tables/${CLIENTS}/records/7`)) return Response.json(row);
    const f=new URL(u).searchParams.get('fields');
    if(f && f.split(',').some(x=>!columns.includes(x))) return Response.json({msg:'Field not found'}, {status:404});
    return Response.json({list:[]});
  };
  try{
    const r=await worker.fetch(new Request('https://w.test/dest-routing/settings', {method, headers:{Authorization:`Bearer ${await token(env.SESSION_SIGNING_KEY)}`, 'Content-Type':'application/json'},
      ...(body?{body:JSON.stringify(body)}:{})}), env, {});
    return {status:r.status, data:await r.json().catch(()=>null)};
  }finally{ globalThis.fetch=real; }
}
const SETTINGS={enabled:true, rules:{'anu@x.com':{resorts:['Munnar','Wayanad'], packages:['Kashmir'], flights:['Kochi - Dubai']}, 'sam@x.com':{packages:['Bali'], phone:'+91 90000 00002'}},
  customer_text:'x'.repeat(900)};

test('missing column (and /fields refused): created as LongText through /columns, saved and read back', async()=>{
  const r=await call('POST', SETTINGS);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(created.map(c=>[c.title, c.uidt]), [['dest_staff_routing','LongText']]);
  const stored=JSON.parse(row.dest_staff_routing);
  assert.equal(stored.enabled, true);
  assert.deepEqual(stored.rules['anu@x.com'].resorts, ['Munnar','Wayanad']);
  assert.equal(stored.rules['sam@x.com'].phone, '919000000002');
  assert.equal(r.data.config.enabled, true, 'the reply is what was stored');
  assert.ok(row.dest_staff_routing.length>255, 'longer than a short text column');
});

test('the column cannot be created → an error, not ✓ Saved', async()=>{
  columnsRoute=false;
  const orig=console.error; console.error=()=>{};
  try{
    const r=await call('POST', SETTINGS);
    assert.equal(r.status, 500);
    assert.match(r.data.error, /Destination routing could not be saved/);
  }finally{ console.error=orig; }
});
