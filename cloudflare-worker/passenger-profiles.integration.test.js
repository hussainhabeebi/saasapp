// 👤 Profiles routes end to end on an in-memory D1: who may use them, masking + reveal audit,
// duplicates, renewal closing reminders, the trip check and the daily owner email.
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
const iso=days=>new Date(Date.now()+days*864e5).toISOString().slice(0,10);

async function run(industry, fn){
  const cid=900+Math.floor(Math.random()*1e5);
  const db=new DatabaseSync(':memory:');
  const env={SESSION_SIGNING_KEY:'s', NOCODB_BASE:'https://nc.test', NOCODB_TOKEN:'t', DB:d1(db), RESEND_API_KEY:'re'};
  const client={Id:cid, client_name:'Tripcode Travels', industry, authentik_email:'owner@tripcode.test'};
  const emails=[];
  const realFetch=globalThis.fetch;
  globalThis.fetch=async (url, opts={})=>{
    const u=String(url);
    if(u.includes('api.resend.com')){ emails.push(JSON.parse(opts.body)); return Response.json({id:'e1'}); }
    if(u.includes(`/tables/${CLIENTS}/records/${cid}`)) return Response.json(client);
    return Response.json({list:[]});
  };
  const token=await sign(env.SESSION_SIGNING_KEY, {cid, email:'agent@tripcode.test'});
  const call=async (path, {method='GET', body}={})=>{
    const r=await worker.fetch(new Request('https://worker.test'+path, {method, headers:{Authorization:`Bearer ${token}`, 'Content-Type':'application/json'}, ...(body?{body:JSON.stringify(body)}:{})}), env, {waitUntil(){}});
    return {status:r.status, data:await r.json()};
  };
  try{ return await fn({call, db, env, emails}); }
  finally{ globalThis.fetch=realFetch; }
}

test('general accounts are refused; travel and hospitality get the module', async () => {
  await run('general', async ({call})=>{ assert.equal((await call('/profiles')).status, 403); });
  await run('hospitality', async ({call})=>{ const r=await call('/profiles'); assert.equal(r.status, 200); assert.deepEqual(r.data.profiles, []); });
});

test('profile + passport: masked in lists, full number only via reveal (audited)', async () => {
  await run('travel', async ({call})=>{
    const bad=await call('/profiles', {method:'POST', body:{phone:'12'}});
    assert.equal(bad.status, 400);
    const p=(await call('/profiles', {method:'POST', body:{first_name:'Anu', last_name:'Mathew', phone:'+91 98470 12345', date_of_birth:'1990-06-15'}})).data.profile;
    assert.equal(p.name, 'Anu Mathew');
    assert.equal(p.age>=35, true);
    const dup=await call('/profiles', {method:'POST', body:{first_name:'Anu', last_name:'Mathew', phone:'9847012345'}});
    assert.equal(dup.status, 409); assert.equal(dup.data.duplicate_id, p.id);

    const withDoc=(await call('/profiles/documents', {method:'POST', body:{profile_id:p.id, type:'passport', number:'M1234567', issuing_country:'India', expiry_date:iso(20)}})).data.profile;
    const doc=withDoc.docs[0];
    assert.equal(doc.number, undefined);
    assert.equal(doc.number_masked, '•••••567');
    assert.equal(doc.status, 'expiring');
    const list=await call('/profiles');
    assert.ok(!JSON.stringify(list.data).includes('M1234567'));
    assert.equal((await call(`/profiles/reveal?doc_id=${doc.id}`)).data.number, 'M1234567');
    const audit=(await call(`/profiles/audit?id=${p.id}`)).data.audit.map(a=>a.action);
    assert.deepEqual(audit.slice(0,3), ['number_viewed', 'document_added', 'profile_created']);

    // Same passport number on another person is caught.
    const q=(await call('/profiles', {method:'POST', body:{first_name:'Ravi'}})).data.profile;
    assert.equal((await call('/profiles/documents', {method:'POST', body:{profile_id:q.id, type:'passport', number:'M1234567', expiry_date:iso(900)}})).status, 409);
  });
});

test('reminders are raised once, renewal closes them, trip check flags the 6-month rule', async () => {
  await run('travel', async ({call, env, emails})=>{
    const p=(await call('/profiles', {method:'POST', body:{first_name:'Anu', whatsapp:'+971 50 123 4567', date_of_birth:`1990-${iso(3).slice(5)}`}})).data.profile;
    const doc=(await call('/profiles/documents', {method:'POST', body:{profile_id:p.id, type:'passport', number:'M1234567', expiry_date:iso(20)}})).data.profile.docs[0];

    const r1=(await call('/profiles/reminders')).data.reminders;
    assert.deepEqual(r1.map(r=>r.kind).sort(), ['birthday', 'passport']);
    const pass=r1.find(r=>r.kind==='passport');
    assert.match(pass.message, /^Hi Anu, .*Passport expires on/);
    assert.equal(pass.phone, '+971 50 123 4567');
    assert.equal((await call('/profiles/reminders')).data.reminders.length, 2, 'not raised twice');

    // The daily job emails only what is new (nothing — the page already raised them).
    const { default: w }=await import('./worker.js');
    await w.scheduled({cron:'0 2 * * *'}, env, {waitUntil(p){ p.catch(()=>{}); }});

    const check=(await call('/profiles/check', {method:'POST', body:{profile_ids:[p.id], departure:iso(15), return:iso(25)}})).data.results[0];
    assert.equal(check.issues[0].code, 'expires_during');

    // Renewed: the open passport reminder is done automatically.
    await call('/profiles/documents', {method:'PATCH', body:{id:doc.id, type:'passport', expiry_date:iso(3650)}});
    const r2=(await call('/profiles/reminders')).data.reminders;
    assert.equal(r2.find(r=>r.kind==='passport').status, 'done');
    assert.equal(r2.find(r=>r.kind==='passport').done_by, 'auto: renewed');
    const bday=r2.find(r=>r.kind==='birthday');
    assert.equal((await call('/profiles/reminders', {method:'PATCH', body:{id:bday.id, status:'done'}})).status, 200);
    assert.equal(emails.length, 0);
  });
});

test('daily job emails the owner a digest of new reminders', async () => {
  await run('hospitality', async ({call, env, emails, db})=>{
    const p=(await call('/profiles', {method:'POST', body:{first_name:'Guest', anniversary:iso(0).slice(5)}})).data.profile;
    assert.ok(p.id);
    const { default: w }=await import('./worker.js');
    const jobs=[];
    await w.scheduled({cron:'0 2 * * *'}, env, {waitUntil(p){ jobs.push(p.catch(()=>{})); }});
    await Promise.all(jobs);
    const mine=emails.filter(e=>e.to[0]==='owner@tripcode.test');
    assert.equal(mine.length, 1);
    assert.match(mine[0].subject, /anniversary today/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM pp_reminders').get().n, 1);
  });
});

test('deleting a profile removes its documents and reminders', async () => {
  await run('travel', async ({call, db})=>{
    const p=(await call('/profiles', {method:'POST', body:{first_name:'Anu'}})).data.profile;
    await call('/profiles/documents', {method:'POST', body:{profile_id:p.id, type:'visa', visa_country:'UAE', expiry_date:iso(5)}});
    await call('/profiles/reminders');
    assert.equal((await call('/profiles', {method:'DELETE', body:{id:p.id}})).status, 200);
    for(const t of ['pp_profiles', 'pp_documents', 'pp_reminders']) assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, 0, t);
  });
});
