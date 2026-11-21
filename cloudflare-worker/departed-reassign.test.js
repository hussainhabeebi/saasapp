// Leads owned by staff who left → present staff; "Assigned To" in the Google Sheet; routing never
// hands a lead to someone who left. NocoDB stubbed.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { departedReassignProcessClient, departedLeadsSummary, presentStaffEmails, staffDisplayName, gsheetParseCols, departedPickLeastLoaded } from './worker.js';

const env={NOCODB_BASE:'https://nc.test', NOCODB_TOKEN:'nc'};
const realFetch=globalThis.fetch;
let leads, patches, client;
beforeEach(()=>{
  patches=[];
  client={Id:7, client_name:'Acme', authentik_email:'boss@x.com', team_emails:'a@x.com,b@x.com', team_names:'{"a@x.com":"Asha","b@x.com":"Bilal"}', lead_routing:'{}'};
  leads=[
    {Id:1, Name:'L1', Owner:'gone@x.com', Stage:'new'},
    {Id:2, Name:'L2', Owner:'gone@x.com', Stage:'won'},
    {Id:3, Name:'L3', Owner:'a@x.com', Stage:'new'},
    {Id:4, Name:'L4', Owner:'old@x.com', Stage:'qualified'},
    {Id:5, Name:'L5', Owner:'Rahul', Stage:'new'},
  ];
  globalThis.fetch=async(url, init={})=>{
    url=String(url); const method=init.method||'GET';
    if(method==='PATCH'){ const b=JSON.parse(init.body); patches.push(...(Array.isArray(b)?b:[b])); for(const p of (Array.isArray(b)?b:[b])){ const l=leads.find(x=>x.Id===p.Id); if(l) Object.assign(l,p);} return new Response('{}'); }
    if(url.includes('/records?')) return new Response(JSON.stringify({list:leads.filter(l=>l.Owner), pageInfo:{isLastPage:true}}));
    return new Response('{}');
  };
});
afterEach(()=>{ globalThis.fetch=realFetch; });

describe('departed staff', ()=>{
  test('roster = owner + team', ()=>{
    assert.deepEqual([...presentStaffEmails(client)].sort(), ['a@x.com','b@x.com','boss@x.com']);
  });
  test('summary lists only people no longer on the team', async()=>{
    const s=await departedLeadsSummary(env, client);
    assert.deepEqual(s, [{email:'gone@x.com', count:2}, {email:'old@x.com', count:1}, {email:'rahul', count:1}]);
  });
  test('spreads evenly to least-loaded present staff and notes why', async()=>{
    const r=await departedReassignProcessClient(env, client, {emailOnly:true});
    assert.equal(r.moved, 3); assert.equal(r.remaining, 0);
    const owners=leads.filter(l=>[1,2,4].includes(l.Id)).map(l=>l.Owner);
    assert.ok(owners.every(o=>['a@x.com','b@x.com'].includes(o)));
    // a@x.com already holds an open lead, so b@x.com gets the first open one
    assert.equal(leads.find(l=>l.Id===1).Owner, 'b@x.com');
    assert.match(JSON.parse(patches[0].NotesList)[0].text, /no longer on the team/);
    assert.equal(leads.find(l=>l.Id===5).Owner, 'Rahul', 'free-text owners untouched in emailOnly mode');
    assert.equal(leads.find(l=>l.Id===3).Owner, 'a@x.com', 'present staff untouched');
  });
  test('specific from → to', async()=>{
    const r=await departedReassignProcessClient(env, client, {from:'gone@x.com', to:'boss@x.com'});
    assert.equal(r.moved, 2);
    assert.equal(leads.find(l=>l.Id===4).Owner, 'old@x.com');
    assert.ok([1,2].every(id=>leads.find(l=>l.Id===id).Owner==='boss@x.com'));
  });
  test('refuses a target who is not on the team, or a source who still is', async()=>{
    await assert.rejects(departedReassignProcessClient(env, client, {to:'gone@x.com'}), /currently on your team/);
    await assert.rejects(departedReassignProcessClient(env, client, {from:'a@x.com'}), /still on your team/);
  });
  test('least-loaded pick', ()=>{
    assert.equal(departedPickLeastLoaded(['a','b','c'], new Map([['a',2],['b',0],['c',1]])), 'b');
  });
});

describe('Assigned To column', ()=>{
  test('display names', ()=>{
    assert.equal(staffDisplayName(client, 'A@x.com'), 'Asha');
    assert.equal(staffDisplayName(client, 'boss@x.com'), 'Acme');
    assert.equal(staffDisplayName(client, 'gone@x.com'), 'gone@x.com');
  });
  test('legacy saved columns get Assigned To once; new-format saves are respected', ()=>{
    assert.deepEqual(gsheetParseCols('["Phone","Name"]'), ['Phone','Name','AssignedTo']);
    assert.deepEqual(gsheetParseCols('{"v":2,"cols":["Phone","Name"]}'), ['Phone','Name']);
    assert.ok(gsheetParseCols('').includes('AssignedTo'));
  });
});
