// Settings → Integrations → Meta Ads "Save" (POST /meta/capi/config): the Ad Account ID didn't
// stick on a CLIENTS table without a meta_ad_account_id column — NocoDB dropped the field and the
// dashboard still said "Saved". Now the column is created first, the id is normalised, and a value
// that doesn't read back is reported.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { metaNormalizeAdAccountId } from './worker.js';

const CLIENTS='mxl33bg4wi70fqj';
async function token(secret, cid=7, email='boss@biz.com'){
  const body=btoa(JSON.stringify({cid:String(cid), email, exp:Math.floor(Date.now()/1000)+3600}));
  const key=await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const sig=await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `${body}.${btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}`;
}
const env={SESSION_SIGNING_KEY:'s', NOCODB_BASE:'https://nc.test', NOCODB_TOKEN:'t', ALLOWED_ORIGINS:'https://app.leadvyne.com'};

// A clients table that, like production, has the Pixel columns but not meta_ad_account_id, and
// silently ignores fields it doesn't have (what NocoDB does on PATCH).
let columns, row, created, canCreate;
beforeEach(()=>{ columns=['Id','meta_pixel_id','meta_capi_token']; row={Id:7, meta_pixel_id:'', meta_capi_token:'TOK'}; created=[]; canCreate=true; });
async function save(body){
  const realFetch=globalThis.fetch;
  globalThis.fetch=async (url, opts={})=>{
    const u=String(url);
    if(u.includes(`/api/v2/meta/tables/${CLIENTS}/fields`) && opts.method==='POST'){
      if(!canCreate) return Response.json({msg:'forbidden'}, {status:403});
      const t=JSON.parse(opts.body).title; created.push(t); columns.push(t); return Response.json({});
    }
    if(u.includes(`/api/v2/meta/tables/${CLIENTS}`)) return Response.json({columns:columns.map(title=>({title, column_name:title}))});
    if(u.includes(`/tables/${CLIENTS}/records`) && opts.method==='PATCH'){
      const b=JSON.parse(opts.body);
      for(const [k,v] of Object.entries(b)) if(columns.includes(k)) row[k]=v;
      return Response.json({Id:7});
    }
    if(u.includes(`/tables/${CLIENTS}/records/7`)) return Response.json(row);
    return Response.json({list:[]});
  };
  try{
    const r=await worker.fetch(new Request('https://worker.test/meta/capi/config', {method:'POST',
      headers:{Authorization:`Bearer ${await token(env.SESSION_SIGNING_KEY)}`, 'Content-Type':'application/json'}, body:JSON.stringify(body)}), env, {});
    return {status:r.status, data:await r.json().catch(()=>null)};
  }finally{ globalThis.fetch=realFetch; }
}

test('the Ad Account ID column is created first, so the id actually saves', async ()=>{
  const r=await save({meta_pixel_id:'744598038086701', meta_ad_account_id:'act_1234567890123'});
  assert.equal(r.status, 200);
  assert.deepEqual(created, ['meta_ad_account_id']);
  assert.equal(row.meta_ad_account_id, '1234567890123');
  assert.equal(row.meta_pixel_id, '744598038086701');
  assert.equal(r.data.meta_ad_account_id, '1234567890123');
});

test('a value that does not stick is reported, not shown as saved', async ()=>{
  canCreate=false;
  const r=await save({meta_pixel_id:'744598038086701', meta_ad_account_id:'1234567890123'});
  assert.equal(r.status, 502);
  assert.match(r.data.error, /Not saved: meta_ad_account_id/);
});

test('a wrong-looking id is refused with a plain message; blank clears it', async ()=>{
  const bad=await save({meta_ad_account_id:'my ad account'});
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /Ad Account ID should be the number/);
  row.meta_ad_account_id='123'; columns.push('meta_ad_account_id');
  const clear=await save({meta_pixel_id:'744598038086701', meta_ad_account_id:''});
  assert.equal(clear.status, 200);
  assert.equal(row.meta_ad_account_id, '');
});

test('ad account id normalisation', ()=>{
  assert.equal(metaNormalizeAdAccountId('act_1234567890123'), '1234567890123');
  assert.equal(metaNormalizeAdAccountId(' 1234 5678 9012 '), '123456789012');
  assert.equal(metaNormalizeAdAccountId(''), '');
  assert.equal(metaNormalizeAdAccountId('abc'), null);
});
