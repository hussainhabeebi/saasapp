// Settings → Integrations → Meta Ads "Save" (POST /meta/capi/config): the Ad Account ID didn't
// stick on a CLIENTS table without a meta_ad_account_id column — NocoDB dropped the field and the
// dashboard still said "Saved". Now the column is created first, the id is normalised, and a value
// that doesn't read back is reported.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { metaNormalizeAdAccountId, metaCleanToken } from './worker.js';

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
let columns, row, created, canCreate, graph, graphCalls;
// Meta's view of tokens: GOOD has ads_read and sees account 1234567890123; NOREAD lacks ads_read.
const GOOD='EAAGoodToken123', NOREAD='EAANoAdsRead456';
beforeEach(()=>{ columns=['Id','meta_pixel_id','meta_capi_token']; row={Id:7, meta_pixel_id:'', meta_capi_token:GOOD}; created=[]; canCreate=true; graphCalls=[];
  graph=(u)=>{
    const tok=new URL(u).searchParams.get('access_token');
    if(tok!==GOOD && tok!==NOREAD) return Response.json({error:{message:'Invalid OAuth access token - Cannot parse access token', type:'OAuthException', code:190}}, {status:400});
    if(u.includes('/me/permissions')) return Response.json({data:[{permission:'ads_management', status:'granted'}, ...(tok===GOOD?[{permission:'ads_read', status:'granted'}]:[])]});
    if(u.includes('/act_1234567890123?')) return Response.json({name:'Aiingo Ads', currency:'INR'});
    return Response.json({error:{message:'(#100) Missing permissions', code:100}}, {status:400});
  };
});
async function save(body){
  const realFetch=globalThis.fetch;
  globalThis.fetch=async (url, opts={})=>{
    const u=String(url);
    if(u.startsWith('https://graph.facebook.com/')){ graphCalls.push(u); return graph(u); }
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

test('a token pasted with line breaks, spaces or quotes is cleaned, checked with Meta and saved', async ()=>{
  const r=await save({meta_capi_token:` "EAAGood\nToken 123" `, meta_ad_account_id:'act_1234567890123'});
  assert.equal(r.status, 200);
  assert.equal(row.meta_capi_token, GOOD);
  assert.deepEqual([r.data.check.token_ok, r.data.check.ads_read, r.data.check.account_name, r.data.check.warnings], [true, true, 'Aiingo Ads', []]);
});

test('a token Meta can\'t parse is refused and the old one is kept', async ()=>{
  const r=await save({meta_capi_token:'EAAtruncat', meta_ad_account_id:'1234567890123'});
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Meta says this token isn't valid \(Invalid OAuth access token - Cannot parse access token\)/);
  assert.equal(row.meta_capi_token, GOOD);
});

test('saving only the ad account checks the saved token and warns when it is broken', async ()=>{
  row.meta_capi_token='EAAbroken';
  const r=await save({meta_ad_account_id:'1234567890123'});
  assert.equal(r.status, 200, 'the ad account still saves');
  assert.equal(row.meta_ad_account_id, '1234567890123');
  assert.equal(r.data.check.invalid, true);
});

test('missing ads_read and an ad account the token can\'t open come back as warnings', async ()=>{
  const r=await save({meta_capi_token:NOREAD, meta_ad_account_id:'999999999'});
  assert.equal(r.status, 200);
  assert.equal(row.meta_capi_token, NOREAD);
  assert.equal(r.data.check.ads_read, false);
  assert.match(r.data.check.warnings.join(' '), /missing the ads_read permission/);
  assert.match(r.data.check.warnings.join(' '), /can't open ad account 999999999/);
});

test('token cleaning', ()=>{
  assert.equal(metaCleanToken(' Bearer EAA1\n2 3 '), 'EAA123');
  assert.equal(metaCleanToken('access_token=EAA9'), 'EAA9');
  assert.equal(metaCleanToken("'EAA7'"), 'EAA7');
  assert.equal(metaCleanToken('   '), '');
});
