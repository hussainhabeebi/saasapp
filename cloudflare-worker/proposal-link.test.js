// Chats → 📑 AI Proposal after the 24-hour window: the "proposal link" WhatsApp template is created
// in the account's WABA the first time AI Proposal opens (POST /catalog/proposal-template), and a
// proposal sent once the window has closed goes as that template with a private link to the PDF
// (GET /p/<token>, opens counted — link-preview crawlers aside).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from './worker.js';

const CLIENTS='mxl33bg4wi70fqj', LEADS='mvg6rcw0ia5qqrx';
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
const PROPOSAL={title:'Hot water for the family', summary:'You need hot water for 6 people.', items:[{id:'1', qty:2}],
  customer:{name:'Asha Nair'}, valid_days:15};

async function run(cid, fn){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE lead_messages (id INTEGER PRIMARY KEY, lead_id INTEGER, client_id INTEGER, role TEXT, content TEXT, ts TEXT)`);
  const r2=new Map();
  const bucket={async put(k,v){ r2.set(k, v instanceof Uint8Array?v:new Uint8Array(v)); }, async get(k){ return r2.has(k)?{body:r2.get(k)}:null; }};
  const env={SESSION_SIGNING_KEY:'s', NOCODB_BASE:'https://nc.test', NOCODB_TOKEN:'t', DB:d1(db), ECOM_CATEGORY_MEDIA:bucket};
  const client={Id:cid, client_name:'Sunrise Solar', industry:'general', waba_id:'waba1', wa_token:'tok', wa_phone_id:'ph1'};
  const lead={Id:7, ClientId:String(cid), Name:'Asha Nair', Phone:'919800000000', Stage:'new'};
  const meta={templates:[], created:[], sent:[], status:'PENDING'};
  const realFetch=globalThis.fetch;
  globalThis.fetch=async (url, opts={})=>{
    const u=String(url), method=opts.method||'GET';
    if(u.includes(`/tables/${CLIENTS}/records/${cid}`)) return Response.json(client);
    if(u.includes(`/tables/${CLIENTS}/records`)) return Response.json({list:[client]});
    if(u.includes(`/tables/${LEADS}/records/7`)) return Response.json(lead);
    if(u.includes('graph.facebook.com/v18.0/waba1/message_templates')){
      if(method==='POST'){ const b=JSON.parse(opts.body); meta.created.push(b); meta.templates.push({name:b.name, language:b.language}); return Response.json({id:'t1', status:'PENDING'}); }
      const name=new URL(u).searchParams.get('name');
      return Response.json({data:meta.templates.filter(t=>t.name===name).map(t=>({...t, status:meta.status}))});
    }
    if(u.includes('graph.facebook.com/v18.0/ph1/messages')){ meta.sent.push(JSON.parse(opts.body)); return Response.json({messages:[{id:'wamid.1'}]}); }
    return Response.json({list:[]});
  };
  const token=await sign(env.SESSION_SIGNING_KEY, {cid});
  const call=async (path, {method='GET', body, auth=true, ua}={})=>{
    const r=await worker.fetch(new Request('https://worker.test'+path, {method, headers:{...(auth?{Authorization:`Bearer ${token}`}:{}), 'Content-Type':'application/json', ...(ua?{'User-Agent':ua}:{})}, ...(body?{body:JSON.stringify(body)}:{})}), env, {waitUntil(){}});
    const ct=r.headers.get('content-type')||'';
    return {status:r.status, ct, data:/json/.test(ct)?await r.json():new Uint8Array(await r.arrayBuffer())};
  };
  try{
    db.exec(`CREATE TABLE IF NOT EXISTS pc_items (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'product', name TEXT NOT NULL, category TEXT, sku TEXT, short_description TEXT, details TEXT, features TEXT, keywords TEXT, price REAL, currency TEXT NOT NULL DEFAULT 'INR', price_unit TEXT, image_url_1 TEXT, image_url_2 TEXT, image_url_3 TEXT, image_url_4 TEXT, image_url_5 TEXT, video_url TEXT, voice_note_url TEXT, brochure_url TEXT, auto_send INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'active', sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT)`);
    db.prepare(`INSERT INTO pc_items (id,client_id,name,price,currency,created_at) VALUES (1,?,?,?,?,?)`).run(cid,'Solar Water Heater',42000,'INR',new Date().toISOString());
    return await fn({db, meta, call, r2, lead});
  }finally{ globalThis.fetch=realFetch; }
}

test('opening AI Proposal creates the template once; it is re-read until Meta approves it', async ()=>{
  await run(301, async ({meta, call})=>{
    const first=await call('/catalog/proposal-template', {method:'POST'});
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(first.data.template.status, 'PENDING');
    assert.equal(meta.created.length, 1);
    const t=meta.created[0];
    assert.equal(t.name, 'leadvyne_proposal_link');
    assert.equal(t.category, 'UTILITY');
    assert.equal(t.allow_category_change, true);
    assert.equal(t.components[0].example.body_text[0].length, 3);
    // Within 10 minutes the stored status answers; nothing new goes to Meta.
    await call('/catalog/proposal-template', {method:'POST'});
    assert.equal(meta.created.length, 1);
    meta.status='APPROVED';
    assert.equal((await call('/catalog/proposal-template?refresh=1', {method:'POST'})).data.template.status, 'APPROVED');
    assert.equal(meta.created.length, 1, 'an existing template is never created again');
  });
});

test('after 24 hours the proposal goes as the template with a private PDF link; opens are counted', async ()=>{
  await run(302, async ({db, meta, call, r2})=>{
    // The customer last wrote two days ago.
    db.prepare(`INSERT INTO lead_messages (lead_id,client_id,role,content,ts) VALUES (7,302,'user','hi',?)`).run(new Date(Date.now()-48*3600e3).toISOString());
    const blocked=await call('/catalog/chat-proposal/send', {method:'POST', body:{lead_id:7, proposal:PROPOSAL}});
    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.code, 'TEMPLATE_NOT_READY');
    assert.match(blocked.data.error, /waiting for Meta's approval/);
    assert.equal(meta.sent.length, 0);

    meta.status='APPROVED';
    await call('/catalog/proposal-template?refresh=1', {method:'POST'});
    const ok=await call('/catalog/chat-proposal/send', {method:'POST', body:{lead_id:7, proposal:PROPOSAL, window_closed:true}});
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.via, 'template');
    assert.match(ok.data.link, /^https:\/\/worker\.test\/p\/[A-Za-z0-9]{22}$/);
    assert.equal(meta.sent.length, 1);
    const msg=meta.sent[0];
    assert.equal(msg.to, '919800000000');
    assert.equal(msg.template.name, 'leadvyne_proposal_link');
    assert.deepEqual(msg.template.components[0].parameters.map(p=>p.text), ['Asha', 'Hot water for the family', ok.data.link]);
    assert.match(ok.data.content, /^Hi Asha, please find attached our proposal "Hot water for the family"/);
    const row=db.prepare(`SELECT sent_via, share_token, view_count FROM pc_proposals`).get();
    assert.equal(row.sent_via, 'template');
    assert.ok(r2.has(`proposals/${row.share_token}.pdf`));

    const path='/p/'+row.share_token;
    const preview=await call(path, {auth:false, ua:'WhatsApp/2.23.20.0 A'});
    assert.equal(preview.status, 200);
    assert.equal(preview.ct, 'application/pdf');
    assert.equal(new TextDecoder('latin1').decode(preview.data.slice(0,8)), '%PDF-1.4');
    assert.equal(db.prepare(`SELECT view_count FROM pc_proposals`).get().view_count, 0, 'link previews are not opens');
    await call(path, {auth:false, ua:'Mozilla/5.0 (iPhone)'});
    await call(path, {auth:false, ua:'Mozilla/5.0 (iPhone)'});
    assert.equal(db.prepare(`SELECT view_count FROM pc_proposals`).get().view_count, 2);
    const list=await call('/catalog/proposals');
    assert.equal(list.data.proposals[0].view_count, 2);
    assert.equal(list.data.proposals[0].link, ok.data.link);
    assert.equal(list.data.proposals[0].sent_via, 'template');
    assert.equal((await call('/p/notARealToken12345', {auth:false})).status, 404);
    assert.equal((await call('/p/bad$token', {auth:false})).status, 404);
  });
});
