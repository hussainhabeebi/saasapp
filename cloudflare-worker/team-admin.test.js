// User Management fixes and the new team-admin routes: create-user rolls back on failure, a removed
// or half-created teammate never gets an empty account at sign-in, an empty account created by
// mistake can be moved into the team, and the new member routes (list, update, deactivate,
// reactivate, resend, revoke, bulk invite, audit, transfer ownership). Authentik + NocoDB stubbed,
// D1 in memory.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker, { handleTeamCreateUser, handleTeamCheckUser, handleTeamInvite } from './worker.js';
import { tmIsOrphanAccount, tmDerivedName, tmParseBulk, tmApplyMemberUpdate, tmMembers, tmEmailMessage } from './team-admin.js';

class D1Statement {
  constructor(db,sql,args=[]){this.db=db;this.sql=sql;this.args=args;}
  bind(...args){return new D1Statement(this.db,this.sql,args);}
  async run(){const r=this.db.prepare(this.sql).run(...this.args);return {success:true,meta:{last_row_id:Number(r.lastInsertRowid),changes:r.changes}};}
  async first(){return this.db.prepare(this.sql).get(...this.args)||null;}
  async all(){return {results:this.db.prepare(this.sql).all(...this.args)};}
}
class D1Database { constructor(){this.db=new DatabaseSync(':memory:');} prepare(sql){return new D1Statement(this.db,sql);} async batch(s){return Promise.all(s.map(x=>x.run()));} }

describe('rules', ()=>{
  test('an empty auto-created account is recognised; a used one never is', ()=>{
    const row={Id:9,authentik_email:'anu@gmail.com',client_name:tmDerivedName('anu@gmail.com'),industry:'general'};
    assert.equal(row.client_name,'Anu');
    assert.equal(tmIsOrphanAccount(row,'anu@gmail.com'),true);
    assert.equal(tmIsOrphanAccount(row,'anu@gmail.com',{leadCount:1}),false,'has leads');
    assert.equal(tmIsOrphanAccount({...row,client_name:'Anu Travels'},'anu@gmail.com'),false,'renamed');
    assert.equal(tmIsOrphanAccount({...row,industry:'travel'},'anu@gmail.com'),false,'set up');
    assert.equal(tmIsOrphanAccount({...row,chatwoot_account_id:'3'},'anu@gmail.com'),false,'Chatwoot connected');
    assert.equal(tmIsOrphanAccount({...row,team_emails:'x@y.com'},'anu@gmail.com'),false,'has a team');
    assert.equal(tmIsOrphanAccount(row,'other@gmail.com'),false,'not the owner');
  });
  test('bulk lines: name/email/role in any order, header and duplicates handled', ()=>{
    const {rows,errors}=tmParseBulk('name,email,role\nSara, sara@x.com, telecaller\nbob@x.com\nno email here\nSARA@x.com');
    assert.deepEqual(rows.map(r=>[r.name,r.email,r.role]),[['Sara','sara@x.com','telecaller'],['','bob@x.com',null]]);
    assert.equal(errors.length,2);
  });
  test('member update: roles and modules are checked; all modules = no restriction', ()=>{
    const c={team_permissions:JSON.stringify({'a@x.com':{leadCategories:['Visa']}})};
    assert.match(tmApplyMemberUpdate(c,'a@x.com',{role:'king'}).error,/Unknown role/);
    assert.match(tmApplyMemberUpdate(c,'a@x.com',{modules:['nope']}).error,/Unknown module/);
    const {next}=tmApplyMemberUpdate(c,'a@x.com',{role:'telecaller',modules:['leads','chats']});
    assert.deepEqual(JSON.parse(next.team_permissions)['a@x.com'],{leadCategories:['Visa'],role:'telecaller',modules:['leads','chats']},'lead categories kept');
  });
  test('members: team plus deactivated people, statuses from the record', ()=>{
    const c={authentik_email:'boss@x.com',team_emails:'a@x.com,b@x.com',team_names:JSON.stringify({'a@x.com':'Anu'})};
    const past=new Date(Date.now()-86400000).toISOString();
    const list=tmMembers(c,[{email:'a@x.com',status:'pending',expires_at:past},{email:'c@x.com',status:'deactivated',name:'Cyril'}]);
    assert.deepEqual(list.map(m=>[m.email,m.status,m.name]),[['a@x.com','expired','Anu'],['b@x.com','active','b'],['c@x.com','deactivated','Cyril']]);
  });
  test('messages tell owner and teammate-elsewhere apart', ()=>{
    assert.match(tmEmailMessage('other_account',{otherName:'Zed'}),/owns another Leadvyne account \(“Zed”\)/);
    assert.match(tmEmailMessage('other_team'),/teammate on another/);
  });
});

// ── Worker routes ────────────────────────────────────────────────────────────
const SECRET='team-secret';
async function session(cid,email){
  const body=btoa(JSON.stringify({cid:String(cid),email,exp:Math.floor(Date.now()/1000)+3600}));
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const sig=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(body));
  return `${body}.${btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}`;
}
let env,clients,users,leads,calls,authentikFail,invitations,nextClientId,invSeq;
const realFetch=globalThis.fetch;
beforeEach(()=>{
  env={DB:new D1Database(),SESSION_SIGNING_KEY:SECRET,NOCODB_BASE:'https://nc.test',NOCODB_TOKEN:'nc',AUTHENTIK_BASE:'https://auth.test',AUTHENTIK_API_TOKEN:'ak'};
  clients=[{Id:7,client_name:'Acme Travels',authentik_email:'boss@x.com',team_emails:'a@x.com',team_names:'{}',industry:'travel'}];
  users=[{pk:1,username:'boss',email:'boss@x.com',last_login:'2026-11-01'}];
  leads=[];calls=[];authentikFail=null;invitations=[];nextClientId=100;invSeq=0;
  globalThis.fetch=async(url,init={})=>{
    url=String(url);const method=init.method||'GET';
    const body=init.body&&typeof init.body==='string'?JSON.parse(init.body):null;
    calls.push({url,method,body});
    const ok=(d,status=200)=>new Response(JSON.stringify(d),{status});
    let m;
    if(url.startsWith('https://nc.test')){
      const u=new URL(url);
      if((m=u.pathname.match(/\/records\/(\d+)$/)))return ok(clients.find(c=>String(c.Id)===m[1])||{});
      const where=u.searchParams.get('where')||'';
      if(u.pathname.includes('mvg6rcw0ia5qqrx'))return ok({list:leads.filter(l=>where.includes(`(ClientId,eq,${l.ClientId})`))});
      if(method==='GET'){
        if((m=where.match(/^\(authentik_email,eq,(.+)\)$/)))return ok({list:clients.filter(c=>c.authentik_email===m[1])});
        if((m=where.match(/^\(team_emails,like,%(.+)%\)$/)))return ok({list:clients.filter(c=>String(c.team_emails||'').includes(m[1]))});
        return ok({list:[]});
      }
      if(method==='PATCH'&&u.pathname.endsWith('/tables/mxl33bg4wi70fqj/records')){const c=clients.find(x=>x.Id===Number(body.Id));Object.assign(c,body);return ok({});}
      if(method==='POST'&&u.pathname.endsWith('/tables/mxl33bg4wi70fqj/records')){const c={Id:nextClientId++,...body};clients.push(c);return ok(c);}
      return ok({});
    }
    if(url==='https://auth.test/application/o/userinfo/')return ok({email:init.headers.Authorization.slice(7)});
    if((m=url.match(/\/core\/users\/\?email=(.*)$/)))return ok({results:users.filter(u=>u.email===decodeURIComponent(m[1]))});
    if((m=url.match(/\/core\/users\/\?username=(.*)$/)))return ok({results:users.filter(u=>u.username===decodeURIComponent(m[1]))});
    if(url==='https://auth.test/api/v3/core/users/'&&method==='POST'){
      if(authentikFail==='create')return ok({detail:'server error'},500);
      const u={pk:50+users.length,...body};users.push(u);return ok(u,201);
    }
    if((m=url.match(/\/core\/users\/(\d+)\/$/))&&method==='DELETE'){users=users.filter(u=>String(u.pk)!==m[1]);return new Response(null,{status:204});}
    if(url.endsWith('/set_password/'))return authentikFail==='password'?ok({detail:'nope'},400):ok({});
    if(url.endsWith('/recovery/'))return ok({link:'https://auth.test/recover/abc'});
    if(url.includes('/flows/instances/'))return ok({pk:'flow-1'});
    if(url.endsWith('/stages/invitation/invitations/')&&method==='POST'){const inv={pk:`inv${++invSeq}`};invitations.push(inv);return ok(inv,201);}
    if(url.includes('/stages/invitation/invitations/')&&method==='DELETE'){invitations=invitations.filter(i=>!url.includes(i.pk));return new Response(null,{status:204});}
    return ok({},404);
  };
});
afterEach(()=>{globalThis.fetch=realFetch;});
const acme=()=>clients.find(c=>c.Id===7);
async function call(path,payload,{as='boss@x.com',method='POST'}={}){
  const r=await worker.fetch(new Request('https://w.test'+path,{method,headers:{Authorization:'Bearer '+await session(7,as),'Content-Type':'application/json'},body:method==='GET'?undefined:JSON.stringify(payload||{})}),env,{});
  return {status:r.status,data:await r.json()};
}
async function login(email){
  const r=await worker.fetch(new Request('https://w.test/session/exchange',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({access_token:email})}),env,{});
  return {status:r.status,data:await r.json()};
}

describe('create user', ()=>{
  test('a failed login creation leaves nothing behind: off the team, no record, logged', async()=>{
    authentikFail='create';
    const r=await call('/team/create-user',{name:'Anurag',email:'anurag@gmail.com',password:'longenough'});
    assert.equal(r.status,502);
    assert.equal(acme().team_emails,'a@x.com','rolled back');
    const audit=await call('/team/audit',null,{method:'GET'});
    assert.equal(audit.data.entries[0].action,'create_failed');
    // Trying again works normally.
    authentikFail=null;
    const again=await call('/team/create-user',{name:'Anurag',email:'anurag@gmail.com',password:'longenough'});
    assert.equal(again.status,200,JSON.stringify(again.data));
    assert.equal(acme().team_emails,'a@x.com,anurag@gmail.com');
  });
  test('a failed password step deletes the new login and rolls back', async()=>{
    authentikFail='password';
    const r=await call('/team/create-user',{email:'anurag@gmail.com',password:'longenough'});
    assert.equal(r.status,502);
    assert.equal(acme().team_emails,'a@x.com');
    assert.ok(!users.some(u=>u.email==='anurag@gmail.com'),'login deleted');
  });
  test('the new teammate lands on the team at sign-in and shows active from then on', async()=>{
    await call('/team/create-user',{name:'Anurag',email:'anurag@gmail.com'});
    let list=(await call('/team/members',null,{method:'GET'})).data;
    assert.equal(list.members.find(m=>m.email==='anurag@gmail.com').status,'pending');
    const s=await login('anurag@gmail.com');
    assert.equal(s.status,200);
    assert.equal(s.data.client_id,'7');
    list=(await call('/team/members',null,{method:'GET'})).data;
    const m=list.members.find(x=>x.email==='anurag@gmail.com');
    assert.equal(m.status,'active');
    assert.ok(m.last_login_at);
  });
});

describe('sign-in guard', ()=>{
  test('a removed teammate gets a clear message, not an empty account of their own', async()=>{
    await call('/team/create-user',{name:'Anurag',email:'anurag@gmail.com',password:'longenough'});
    // Removed the old way (the dashboard patches team_emails directly).
    acme().team_emails='a@x.com';
    const s=await login('anurag@gmail.com');
    assert.equal(s.status,403);
    assert.equal(s.data.code,'TEAM_ACCESS_REMOVED');
    assert.match(s.data.error,/Acme Travels/);
    assert.equal(clients.length,1,'no account was created');
  });
  test('someone User Management never saw still signs up as before', async()=>{
    const s=await login('fresh@gmail.com');
    assert.equal(s.status,200);
    assert.equal(s.data.isNewSignup,true);
    assert.equal(clients.length,2);
  });
});

describe('stuck users', ()=>{
  test('an empty account created by mistake: clear status, then "Move to my team"', async()=>{
    clients.push({Id:55,client_name:'Anuragmc914',authentik_email:'anuragmc914@gmail.com',industry:'general'});
    users.push({pk:9,username:'anuragmc914',email:'anuragmc914@gmail.com'});
    const chk=await handleTeamCheckUser(new Request('https://w.test/team/check-user',{method:'POST',headers:{Authorization:'Bearer '+await session(7,'boss@x.com')},body:JSON.stringify({email:'anuragmc914@gmail.com'})}),env);
    const cd=await chk.json();
    assert.equal(cd.email.status,'orphan_account');
    assert.equal(cd.email.repairable,true);
    const diag=await call('/team/diagnose',{email:'anuragmc914@gmail.com'});
    assert.equal(diag.data.fix,'repair');
    assert.equal(diag.data.other_account.empty,true);
    const r=await call('/team/repair',{email:'anuragmc914@gmail.com'});
    assert.equal(r.status,200,JSON.stringify(r.data));
    const archived=clients.find(c=>c.Id===55);
    assert.equal(archived.signup_status,'archived');
    assert.match(archived.client_name,/\(archived\)/);
    assert.notEqual(archived.authentik_email,'anuragmc914@gmail.com');
    assert.equal(acme().team_emails,'a@x.com,anuragmc914@gmail.com');
    assert.equal((await login('anuragmc914@gmail.com')).data.client_id,'7','now signs in to the team');
  });
  test('a real account is never touched', async()=>{
    clients.push({Id:56,client_name:'Zed Tours',authentik_email:'zed@gmail.com',industry:'travel'});
    const r=await call('/team/repair',{email:'zed@gmail.com'});
    assert.equal(r.status,409);
    const inv=await handleTeamInvite(new Request('https://w.test/team/invite',{method:'POST',headers:{Authorization:'Bearer '+await session(7,'boss@x.com')},body:JSON.stringify({email:'zed@gmail.com'})}),env);
    assert.match((await inv.json()).error,/owns another Leadvyne account \(“Zed Tours”\)/);
  });
  test('a teammate of another account is told so', async()=>{
    clients.push({Id:57,client_name:'Other Co',authentik_email:'own@o.com',team_emails:'pat@o.com'});
    const r=await handleTeamCreateUser(new Request('https://w.test/team/create-user',{method:'POST',headers:{Authorization:'Bearer '+await session(7,'boss@x.com')},body:JSON.stringify({email:'pat@o.com'})}),env);
    assert.equal(r.status,409);
    assert.equal((await r.json()).code,'OTHER_TEAM');
  });
});

describe('member routes', ()=>{
  test('invite → resend → revoke', async()=>{
    let r=await call('/team/invite',{name:'Vin',email:'vin@x.com'});
    assert.equal(r.status,200,JSON.stringify(r.data));
    assert.equal(invitations.length,1);
    r=await call('/team/member/resend',{email:'vin@x.com'});
    assert.equal(r.status,200,JSON.stringify(r.data));
    assert.deepEqual(invitations.map(i=>i.pk),['inv2'],'old invitation deleted, only the newest works');
    r=await call('/team/member/revoke',{email:'vin@x.com'});
    assert.equal(r.status,200);
    assert.equal(invitations.length,0);
    assert.equal(acme().team_emails,'a@x.com');
    assert.equal((await login('vin@x.com')).data.isNewSignup,true,'a revoked invite is forgotten');
  });
  test('deactivate keeps settings and blocks sign-in; reactivate restores', async()=>{
    await call('/team/add-existing',{email:'a2@x.com'}).catch(()=>{});
    users.push({pk:7,username:'a',email:'a@x.com'});
    await call('/team/member/update',{email:'a@x.com',role:'telecaller',name:'Anu'});
    let r=await call('/team/member/deactivate',{email:'a@x.com'});
    assert.equal(r.status,200);
    assert.equal(acme().team_emails,'');
    assert.equal(JSON.parse(acme().team_permissions)['a@x.com'].role,'telecaller','settings kept');
    assert.equal((await login('a@x.com')).status,403);
    const list=(await call('/team/members',null,{method:'GET'})).data;
    assert.equal(list.members.find(m=>m.email==='a@x.com').status,'deactivated');
    r=await call('/team/member/reactivate',{email:'a@x.com'});
    assert.equal(r.status,200,JSON.stringify(r.data));
    assert.equal(acme().team_emails,'a@x.com');
    assert.equal((await login('a@x.com')).data.client_id,'7');
  });
  test('only the owner changes roles; admins manage membership; others read only', async()=>{
    acme().team_emails='a@x.com,adm@x.com';
    acme().team_permissions=JSON.stringify({'adm@x.com':{role:'admin'}});
    let r=await call('/team/member/update',{email:'a@x.com',role:'admin'},{as:'adm@x.com'});
    assert.equal(r.status,403);
    r=await call('/team/member/update',{email:'a@x.com',name:'Anu'},{as:'adm@x.com'});
    assert.equal(r.status,200);
    r=await call('/team/member/deactivate',{email:'adm@x.com'},{as:'adm@x.com'});
    assert.equal(r.status,400,'not yourself');
    r=await call('/team/member/deactivate',{email:'adm@x.com'},{as:'a@x.com'});
    assert.equal(r.status,403,'a plain teammate cannot manage');
    r=await call('/team/members',null,{method:'GET',as:'a@x.com'});
    assert.equal(r.data.me.can_manage,false);
  });
  test('bulk invite reports each row; transfer ownership needs a typed confirmation', async()=>{
    let r=await call('/team/bulk-invite',{text:'Sara, sara@x.com, telecaller\nboss@x.com\nbad line'});
    assert.equal(r.status,200);
    assert.deepEqual(r.data.results.map(x=>[x.email,x.ok]),[['sara@x.com',true],['boss@x.com',false]]);
    assert.equal(JSON.parse(acme().team_permissions)['sara@x.com'].role,'telecaller');
    assert.equal(r.data.errors.length,1);
    users.push({pk:8,username:'a',email:'a@x.com',last_login:'2026-11-02'});
    r=await call('/team/transfer-ownership',{email:'a@x.com',confirm:'wrong'});
    assert.equal(r.status,400);
    r=await call('/team/transfer-ownership',{email:'a@x.com',confirm:'a@x.com'});
    assert.equal(r.status,200);
    assert.equal(acme().authentik_email,'a@x.com');
    assert.ok(acme().team_emails.split(',').includes('boss@x.com'));
    assert.equal(JSON.parse(acme().team_permissions)['boss@x.com'].role,'admin');
  });
});
