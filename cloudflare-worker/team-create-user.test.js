// User Management → Create user with a password (POST /team/create-user), the inline check
// (POST /team/check-user) and Add existing user (POST /team/add-existing). Authentik + NocoDB stubbed.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleTeamCreateUser, handleTeamCheckUser, handleTeamAddExisting, usernameBaseFrom } from './worker.js';

const env={SESSION_SIGNING_KEY:'test-key', NOCODB_BASE:'https://nc.test', NOCODB_TOKEN:'nc', AUTHENTIK_BASE:'https://auth.test', AUTHENTIK_API_TOKEN:'ak'};
async function session(cid, email){
  const body=btoa(JSON.stringify({cid:String(cid), email, exp:Math.floor(Date.now()/1000)+3600}));
  const key=await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SIGNING_KEY), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const sig=await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `${body}.${btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}`;
}
async function call(handler, path, payload){
  const req=new Request('https://w.test'+path, {method:'POST', headers:{Authorization:'Bearer '+await session(7, 'boss@x.com')}, body:JSON.stringify(payload)});
  const r=await handler(req, env);
  return {status:r.status, data:await r.json()};
}

const realFetch=globalThis.fetch;
let calls, client, users;
beforeEach(()=>{
  calls=[];
  users=[{pk:1, username:'nishmalpm', email:'someone@else.com'}];
  client={Id:7, client_name:'Acme', authentik_email:'boss@x.com', team_emails:'a@x.com', team_names:'{}'};
  globalThis.fetch=async(url, init={})=>{
    url=String(url); const method=init.method||'GET';
    const body=init.body?JSON.parse(init.body):null;
    calls.push({url, method, body});
    const ok=(d, status=200)=>new Response(JSON.stringify(d), {status});
    if(url.startsWith('https://nc.test') && url.endsWith('/records/7')) return ok(client);
    if(url.startsWith('https://nc.test') && method==='GET') return ok({list:[]});
    if(url.startsWith('https://nc.test') && method==='PATCH'){ Object.assign(client, body); return ok({}); }
    let m;
    if((m=url.match(/\/core\/users\/\?email=(.*)$/))) return ok({results:users.filter(u=>u.email===decodeURIComponent(m[1]))});
    if((m=url.match(/\/core\/users\/\?username=(.*)$/))) return ok({results:users.filter(u=>u.username===decodeURIComponent(m[1]))});
    if(url==='https://auth.test/api/v3/core/users/' && method==='POST'){ const u={pk:99, ...body}; users.push(u); return ok(u, 201); }
    if(url.endsWith('/set_password/')) return ok({});
    if(url.endsWith('/recovery/')) return ok({detail:'no flow'}, 400);
    throw new Error('unexpected fetch '+method+' '+url);
  };
});
afterEach(()=>{ globalThis.fetch=realFetch; });

describe('POST /team/create-user', ()=>{
  test('a taken username is a field error with a free suggestion — nothing is created', async()=>{
    const {status, data}=await call(handleTeamCreateUser, '/team/create-user', {name:'Nishmal', username:'nishmalpm', email:'pmnishmal@gmail.com', password:'nishmal@123'});
    assert.equal(status, 409);
    assert.equal(data.field, 'username');
    assert.equal(data.code, 'USERNAME_TAKEN');
    assert.equal(data.suggestion, 'nishmalpm2');
    assert.ok(!calls.some(c=>c.method==='POST' && c.url.endsWith('/core/users/')));
  });

  test('blank username is derived from the email and the user is added to the team server-side', async()=>{
    const {status, data}=await call(handleTeamCreateUser, '/team/create-user', {name:'Sara K', email:'Sara.K@x.com', password:'longenough'});
    assert.equal(status, 200);
    assert.equal(data.username, 'sara.k');
    assert.equal(data.explicitPassword, true);
    assert.equal(client.team_emails, 'a@x.com,sara.k@x.com');
    assert.deepEqual(JSON.parse(client.team_names), {'sara.k@x.com':'Sara K'});
  });

  test('derived username skips taken ones', async()=>{
    users.push({pk:2, username:'sara', email:'sara@other.com'});
    const {data}=await call(handleTeamCreateUser, '/team/create-user', {email:'sara@x.com', password:'longenough'});
    assert.equal(data.username, 'sara2');
  });

  test('an email that already has a login is just granted access; its password is not touched', async()=>{
    users.push({pk:3, username:'pm', email:'pm@x.com'});
    const {status, data}=await call(handleTeamCreateUser, '/team/create-user', {username:'whatever', email:'pm@x.com', password:'longenough'});
    assert.equal(status, 200);
    assert.equal(data.alreadyHasLogin, true);
    assert.equal(data.passwordIgnored, true);
    assert.ok(!calls.some(c=>c.url.includes('set_password')));
    assert.equal(client.team_emails, 'a@x.com,pm@x.com');
  });

  test('owner and existing teammates are rejected with a clear email field error', async()=>{
    let r=await call(handleTeamCreateUser, '/team/create-user', {email:'boss@x.com'});
    assert.equal(r.status, 409); assert.equal(r.data.field, 'email'); assert.match(r.data.error, /account owner/);
    r=await call(handleTeamCreateUser, '/team/create-user', {email:'a@x.com'});
    assert.equal(r.status, 409); assert.match(r.data.error, /already on your team/);
  });
});

describe('POST /team/check-user', ()=>{
  test('reports email status and username availability', async()=>{
    const {data}=await call(handleTeamCheckUser, '/team/check-user', {email:'new@x.com', username:'nishmalpm'});
    assert.equal(data.email.status, 'new');
    assert.deepEqual(data.username, {taken:true, suggestion:'nishmalpm2'});
  });
});

describe('POST /team/add-existing', ()=>{
  test('adds someone with a login', async()=>{
    users.push({pk:4, username:'z', email:'z@x.com', name:'Zed'});
    const {status}=await call(handleTeamAddExisting, '/team/add-existing', {email:'z@x.com'});
    assert.equal(status, 200);
    assert.equal(client.team_emails, 'a@x.com,z@x.com');
  });
  test('someone without a login gets NO_LOGIN instead of a silent add', async()=>{
    const {status, data}=await call(handleTeamAddExisting, '/team/add-existing', {email:'nobody@x.com'});
    assert.equal(status, 404); assert.equal(data.code, 'NO_LOGIN');
    assert.equal(client.team_emails, 'a@x.com');
  });
  test('owner email is explained', async()=>{
    const {status, data}=await call(handleTeamAddExisting, '/team/add-existing', {email:'boss@x.com'});
    assert.equal(status, 409); assert.equal(data.code, 'OWNER');
  });
});

test('usernameBaseFrom', ()=>{
  assert.equal(usernameBaseFrom('PM.Nishmal+1@gmail.com'), 'pm.nishmal1');
  assert.equal(usernameBaseFrom('', ''), 'user');
});
