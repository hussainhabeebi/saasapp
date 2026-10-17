// User Management → Invite Teammate (POST /team/invite, handleTeamInvite). Authentik and NocoDB
// are stubbed; asserts what's sent to Authentik's Invitations API and what lands on the CLIENTS row.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleTeamInvite, teamInviteLink } from './worker.js';

const env={SESSION_SIGNING_KEY:'test-key', NOCODB_BASE:'https://nc.test', NOCODB_TOKEN:'nc', AUTHENTIK_BASE:'https://auth.test', AUTHENTIK_API_TOKEN:'ak'};

// Same token format as signSession in worker.js.
async function session(cid, email){
  const body=btoa(JSON.stringify({cid:String(cid), email, exp:Math.floor(Date.now()/1000)+3600}));
  const key=await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SIGNING_KEY), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const sig=await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `${body}.${btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}`;
}
async function invite(payload){
  const req=new Request('https://w.test/team/invite', {method:'POST', headers:{Authorization:'Bearer '+await session(7, 'boss@x.com')}, body:JSON.stringify(payload)});
  const r=await handleTeamInvite(req, env);
  return {status:r.status, data:await r.json()};
}

const realFetch=globalThis.fetch;
let calls, client, authentikUsers, flowExists;
beforeEach(()=>{
  calls=[]; authentikUsers=[]; flowExists=true;
  client={Id:7, client_name:'Acme', authentik_email:'boss@x.com', team_emails:'a@x.com', team_names:'{}'};
  globalThis.fetch=async(url, init={})=>{
    url=String(url); const method=init.method||'GET';
    const body=init.body?JSON.parse(init.body):null;
    calls.push({url, method, body});
    const ok=(d, status=200)=>new Response(JSON.stringify(d), {status});
    if(url.startsWith('https://nc.test') && url.endsWith('/records/7')) return ok(client);
    if(url.startsWith('https://nc.test') && method==='GET') return ok({list:[]});
    if(url.startsWith('https://nc.test') && method==='PATCH'){ Object.assign(client, body); return ok({}); }
    if(url.startsWith('https://auth.test/api/v3/core/users/?email=')) return ok({results:authentikUsers});
    if(url==='https://auth.test/api/v3/flows/instances/leadvyne-team-invite/') return flowExists?ok({pk:'flow-uuid', slug:'leadvyne-team-invite'}):ok({detail:'Not found.'}, 404);
    if(url==='https://auth.test/api/v3/stages/invitation/invitations/' && method==='POST') return ok({pk:'0b0c5c8e-1111-4222-8333-944445555666'}, 201);
    throw new Error('unexpected fetch '+method+' '+url);
  };
});
afterEach(()=>{ globalThis.fetch=realFetch; });

describe('POST /team/invite', ()=>{
  test('creates a single-use Authentik invitation with the email fixed, and adds them to the team', async()=>{
    const {status, data}=await invite({name:'Sara K', email:' Sara@X.com '});
    assert.equal(status, 200);
    assert.equal(data.email, 'sara@x.com');
    assert.equal(data.inviteLink, 'https://app.leadvyne.com/dashboard.html?invite=0b0c5c8e-1111-4222-8333-944445555666');
    const inv=calls.find(c=>c.url.endsWith('/stages/invitation/invitations/'));
    assert.equal(inv.body.single_use, true);
    assert.equal(inv.body.flow, 'flow-uuid');
    assert.deepEqual(inv.body.fixed_data, {email:'sara@x.com', username:'sara@x.com', name:'Sara K'});
    assert.match(inv.body.name, /^leadvyne-7-[0-9a-f]{10}$/);
    assert.ok(new Date(inv.body.expires)>new Date(Date.now()+6*86400000));
    assert.equal(client.team_emails, 'a@x.com,sara@x.com');
    assert.deepEqual(JSON.parse(client.team_names), {'sara@x.com':'Sara K'});
    assert.ok(!calls.some(c=>c.url.includes('/core/users/') && c.method==='POST'), 'no Authentik user is created up front');
  });

  test('someone who already has an Authentik login is just added, no invitation', async()=>{
    authentikUsers=[{pk:5, email:'sara@x.com'}];
    const {status, data}=await invite({email:'sara@x.com'});
    assert.equal(status, 200);
    assert.equal(data.alreadyHasLogin, true);
    assert.equal(client.team_emails, 'a@x.com,sara@x.com');
    assert.ok(!calls.some(c=>c.url.includes('/invitations/')));
  });

  test('re-inviting an existing teammate does not duplicate them', async()=>{
    const {status}=await invite({email:'a@x.com'});
    assert.equal(status, 200);
    assert.equal(client.team_emails, 'a@x.com');
    assert.ok(!calls.some(c=>c.method==='PATCH'));
  });

  test('missing invite flow fails clearly and changes nothing', async()=>{
    flowExists=false;
    const {status, data}=await invite({email:'sara@x.com'});
    assert.equal(status, 503);
    assert.equal(data.code, 'INVITE_FLOW_MISSING');
    assert.equal(client.team_emails, 'a@x.com');
  });

  test('rejects bad emails and the owner\'s own email', async()=>{
    assert.equal((await invite({email:'nope'})).status, 400);
    assert.equal((await invite({email:'a@x.com,b@x.com'})).status, 400);
    assert.equal((await invite({email:'BOSS@x.com'})).status, 409);
  });

  test('requires a session', async()=>{
    const r=await handleTeamInvite(new Request('https://w.test/team/invite', {method:'POST', body:'{}'}), env);
    assert.equal(r.status, 401);
  });

  test('APP_BASE_URL overrides where invite links point', ()=>{
    assert.equal(teamInviteLink({APP_BASE_URL:'https://staging.leadvyne.com/'}, 'abc'), 'https://staging.leadvyne.com/dashboard.html?invite=abc');
  });
});
