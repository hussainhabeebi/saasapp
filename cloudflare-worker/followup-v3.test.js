// Follow-up V3 (followup-v3.js) — the per-lead decision, reply credit, error handling, templates,
// report, and a sweep/inbound/setup run against node:sqlite through a tiny D1 shim.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  fv3Config, fv3Decide, fv3AttributeReply, fv3ErrorAction, fv3TemplatePreset, fv3TemplateParams,
  fv3Health, fv3DeliveryStatus, fv3StepsForLead, fv3BuildReport, fv3PreferredHour, fv3NextAllowedMs, fv3OrderCounts, fv3OnInbound, fv3ProcessClient,
  fv3Setup, fv3SaveSettings, fv3GetSettings, fv3IsEnabled, fv3EnsureSchema, fv3LeadFields, fv3RunClient,
} from './followup-v3.js';

const H=3600000, D=24*H;
const T=(iso)=>Date.parse(iso);
const iso=(ms)=>new Date(ms).toISOString();
const steps={
  1:{step:1, type:'session', hours:1, message:'Hi {name}, A1', message_b:''},
  2:{step:2, type:'session', hours:6, message:'Hi {name}, A2', message_b:''},
  3:{step:3, type:'template', template_name:'tpl3', template_body_vars:1},
  4:{step:4, type:'template', template_name:'tpl4', template_body_vars:1},
  5:{step:5, type:'template', template_name:'tpl5', template_body_vars:1},
};
const cfg=fv3Config({});
const ENABLED='2026-10-01T00:00:00Z';
const lead=(o={})=>({Id:7, Name:'Asha K', Phone:'919876543210', Stage:'new', CreatedAt:'2026-10-05T10:00:00Z', LastCustomerMsgAt:'2026-10-10T10:00:00Z', ...o});
const decide=(o={})=>fv3Decide({lead:lead(o.lead), steps:o.steps||steps, cfg:o.cfg||cfg, state:o.state||null, sends:o.sends||[], enabledAt:ENABLED, now:o.now, tz:'UTC', hasOrder:!!o.hasOrder, reengageReady:!!o.reengageReady});

describe('fv3Decide', ()=>{
  test('nudge 1 is scheduled after its hours, then due', ()=>{
    let d=decide({now:T('2026-10-10T10:30:00Z')});
    assert.equal(d.status, 'scheduled'); assert.equal(d.next.step, 1); assert.equal(d.next.due_at, '2026-10-10T11:00:00.000Z');
    d=decide({now:T('2026-10-10T11:05:00Z')});
    assert.equal(d.status, 'due'); assert.equal(d.next.step, 1);
  });

  test('no back-to-back nudges: a lead who went quiet at night gets nudge 2 a gap after nudge 1', ()=>{
    const l={LastCustomerMsgAt:'2026-10-10T22:30:00Z'};
    // Nudge 1 waits for the morning (quiet 21-9), not 23:30.
    let d=decide({lead:l, now:T('2026-10-10T23:30:00Z')});
    assert.equal(d.status, 'scheduled'); assert.equal(d.next.due_at, '2026-10-11T09:00:00.000Z');
    // It went out at 09:00; at 09:15 nudge 2 (6h after the message) must wait min_gap_hours (3h).
    const sends=[{step:1, kind:'ladder', variant:'A', sent_at:'2026-10-11T09:00:00Z'}];
    d=decide({lead:l, sends, now:T('2026-10-11T09:15:00Z')});
    assert.equal(d.status, 'scheduled'); assert.equal(d.next.step, 2); assert.equal(d.next.due_at, '2026-10-11T12:00:00.000Z');
    assert.equal(d.steps[0].state, 'sent');
  });

  test('a session nudge that can no longer go out inside 24h is skipped and the template step takes over', ()=>{
    const d=decide({now:T('2026-10-11T10:30:00Z'), sends:[{step:1, kind:'ladder', sent_at:'2026-10-10T11:00:00Z'}]});
    assert.equal(d.steps[1].state, 'expired');
    assert.equal(d.next.step, 3); assert.equal(d.next.due_at, '2026-10-11T11:00:00.000Z');
  });

  test('template step waits for the lead\'s usual hour when smart send time knows it', ()=>{
    const d=decide({now:T('2026-10-11T10:30:00Z'), sends:[{step:1, sent_at:'2026-10-10T11:00:00Z'}, {step:2, sent_at:'2026-10-10T16:00:00Z'}],
      state:{hours_json:JSON.stringify({19:3, 8:1})}});
    assert.equal(d.next.step, 3); assert.equal(d.next.due_at, '2026-10-11T19:00:00.000Z');
  });

  test('stop reasons', ()=>{
    const now=T('2026-10-10T12:00:00Z');
    assert.equal(decide({now, lead:{OptOut:'Yes'}}).status, 'stopped');
    assert.equal(decide({now, lead:{Handover:'Yes'}}).status, 'human');
    assert.equal(decide({now, lead:{Stage:'won'}}).status, 'goal_reached');
    assert.equal(decide({now, lead:{Stage:'visit_booked'}}).reason, 'booked');
    assert.equal(decide({now, hasOrder:true}).reason, 'ordered');
    assert.equal(decide({now, lead:{Stage:'lost'}}).status, 'stopped');
    assert.equal(decide({now, lead:{Stage:'quote_sent'}, cfg:fv3Config({exit_stages:['quote_sent']})}).reason, 'exit_stage');
    assert.equal(decide({now, cfg:fv3Config({paused:true})}).status, 'paused');
    assert.equal(decide({now, lead:{CreatedAt:'2026-09-01T00:00:00Z'}}).status, 'not_enrolled');
    assert.equal(decide({now, lead:{CreatedAt:'2026-09-01T00:00:00Z'}, cfg:fv3Config({include_existing_leads:true})}).status, 'due');
  });

  test('your team replying pauses it, but our own follow-up message does not count as a team reply', ()=>{
    const now=T('2026-10-10T18:00:00Z');
    assert.equal(decide({now, cfg:fv3Config({staff_reply_hours:0}), lead:{LastAgentMsgAt:'2026-10-10T12:00:00Z'}}).status, 'agent_replied');
    const resumed=decide({now,lead:{LastAgentMsgAt:'2026-10-10T12:00:00Z'}});
    assert.equal(resumed.status,'scheduled'); assert.ok(Date.parse(resumed.next.due_at)>=T('2026-10-11T12:00:00Z'));
    const sends=[{step:1, sent_at:'2026-10-10T11:00:00Z'}];
    assert.notEqual(decide({now, sends, lead:{LastAgentMsgAt:'2026-10-10T11:00:02Z'}}).status, 'agent_replied');
    // The bot's own instant answer (within 90s of the customer) isn't a human reply either.
    assert.notEqual(decide({now, lead:{LastAgentMsgAt:'2026-10-10T10:00:30Z'}}).status, 'agent_replied');
  });

  test('missing template shows as waiting for approval; skipped steps are passed over', ()=>{
    const noTpl={...steps, 3:{step:3, type:'template', template_name:''}, 4:{step:4, type:'template', template_name:''}, 5:{step:5, type:'template', template_name:''}};
    const sends=[{step:1, sent_at:'2026-10-10T11:00:00Z'}, {step:2, sent_at:'2026-10-10T16:00:00Z'}];
    const d=decide({steps:noTpl, sends, now:T('2026-10-11T12:00:00Z')});
    assert.equal(d.status, 'waiting_template'); assert.equal(d.steps[2].state, 'pending_template');
    const skipped=decide({now:T('2026-10-10T11:05:00Z'), state:{skip_json:JSON.stringify({cycle:'2026-10-10T10:00:00.000Z', steps:[1]})}});
    assert.equal(skipped.steps[0].state, 'skipped'); assert.equal(skipped.next.step, 2);
  });

  test('an old silence never gets a late template blast; re-engage takes over when ready', ()=>{
    const old={LastCustomerMsgAt:'2026-08-01T10:00:00Z', CreatedAt:'2026-08-01T09:00:00Z'};
    const now=T('2026-10-10T12:00:00Z');
    const d=decide({lead:old, now, cfg:fv3Config({include_existing_leads:true})});
    assert.equal(d.next, null); assert.ok(d.steps.slice(2).every(s=>s.state==='expired'));
    const r=decide({lead:old, now, cfg:fv3Config({include_existing_leads:true}), reengageReady:true});
    assert.equal(r.status, 'due'); assert.equal(r.next.kind, 'reengage'); assert.equal(r.next.step, 6);
    const twice=[{step:6, kind:'reengage', sent_at:'2026-08-31T12:00:00Z'}, {step:6, kind:'reengage', sent_at:'2026-09-30T12:00:00Z'}];
    assert.equal(decide({lead:old, now, cfg:fv3Config({include_existing_leads:true}), reengageReady:true, sends:twice}).status, 'completed');
  });

  test('per-lead 30-day cap', ()=>{
    const sends=Array.from({length:8}, (_, i)=>({step:6, kind:'reengage', sent_at:iso(T('2026-10-01T00:00:00Z')+i*D)}));
    assert.equal(decide({now:T('2026-10-10T12:00:00Z'), sends}).status, 'capped');
  });
});

test('quiet hours push to the morning; preferred hour needs real signal', ()=>{
  assert.equal(iso(fv3NextAllowedMs(T('2026-10-10T23:10:00Z'), 'UTC', 21, 9)), '2026-10-11T09:00:00.000Z');
  assert.equal(iso(fv3NextAllowedMs(T('2026-10-10T12:10:00Z'), 'UTC', 21, 9)), '2026-10-10T12:10:00.000Z');
  assert.equal(fv3PreferredHour({19:3}), 19);
  assert.equal(fv3PreferredHour({19:1, 8:1}), null);
  assert.equal(fv3PreferredHour('{}'), null);
});

test('a reply credits only the latest follow-up, and only inside the window', ()=>{
  const now=T('2026-10-10T12:00:00Z');
  const sends=[{id:1, sent_at:'2026-10-09T10:00:00Z'}, {id:2, sent_at:'2026-10-10T09:00:00Z'}];
  assert.equal(fv3AttributeReply(sends, now, 72).id, 2);
  assert.equal(fv3AttributeReply(sends, now, 2), null);
  assert.equal(fv3AttributeReply([{id:3, sent_at:'2026-10-10T09:00:00Z', replied_at:'2026-10-10T09:30:00Z'}], now, 72), null);
});

test('send errors map to an action', ()=>{
  assert.deepEqual(fv3ErrorAction(131049), {kind:'defer', hours:24});
  assert.equal(fv3ErrorAction(131050).kind, 'stop_marketing');
  assert.equal(fv3ErrorAction(190).kind, 'client_error');
  assert.equal(fv3ErrorAction(null, 'This lead has no conversation yet.').kind, 'skip');
  assert.equal(fv3ErrorAction(null, 'HTTP 502').kind, 'retry');
});

test('order counts only if placed around or after this conversation', ()=>{
  const l=lead();
  assert.equal(fv3OrderCounts({date:'2026-10-10'}, l), true);
  assert.equal(fv3OrderCounts({date:'2026-06-01'}, l), false);
  assert.equal(fv3OrderCounts(null, l), false);
});

test('template presets: variables never first/last, example per variable, params fill from the lead', ()=>{
  for(const kind of ['s3', 's4', 's5', 'reengage']){
    const p=fv3TemplatePreset(kind, {industry:'real_estate', businessName:'Acme Homes'});
    const vars=p.body.match(/\{\{\d\}\}/g);
    assert.equal(vars.length, p.params.length, kind);
    assert.equal(p.example.length, p.params.length, kind);
    assert.ok(!/^\s*\{\{/.test(p.body) && !/\}\}\s*\.?\s*$/.test(p.body), kind);
    assert.match(p.body, /STOP/);
  }
  assert.deepEqual(fv3TemplateParams(['name', 'business', 'interest'], {Name:'Asha K', InterestedProduct:''}, {client_name:'Acme\nHomes'}, 'travel'),
    ['Asha', 'Acme Homes', 'your trip plans']);
});

test('report: totals, per-step health, A/B, heatmap, best slot', ()=>{
  const rows=[];
  for(let i=0; i<20; i++) rows.push({lead_id:i, step:1, variant:i%2?'B':'A', sent_at:'2026-10-06T10:00:00Z', replied_at:i<6?'2026-10-06T19:00:00Z':null, converted_at:i<2?'2026-10-07T00:00:00Z':null, revenue:i<2?500:null, opted_out_at:i===19?'2026-10-06T11:00:00Z':null});
  rows.push({lead_id:99, step:6, kind:'reengage', variant:'A', sent_at:'2026-10-08T10:00:00Z'});
  const r=fv3BuildReport(rows, {tz:'UTC', now:T('2026-10-10T12:00:00Z'), weeks:2});
  assert.equal(r.totals.sent, 21); assert.equal(r.totals.replied, 6); assert.equal(r.totals.converted, 2); assert.equal(r.totals.revenue, 1000);
  assert.equal(r.totals.leads_reengaged, 6);
  const s1=r.steps.find(s=>s.step===1);
  assert.equal(s1.reply_rate, 30); assert.equal(s1.opt_out_rate, 5); assert.equal(s1.health, 'watch');
  assert.deepEqual(s1.variants.map(v=>v.variant), ['A', 'B']);
  assert.ok(r.steps.find(s=>s.step===6));
  assert.deepEqual(r.best_slot, {dow:2, hour:19, replies:6}); // Tuesday 19:00 UTC
  assert.equal(r.trend.reduce((a, w)=>a+w.sent, 0), 21);
});

// ── D1-backed runs ────────────────────────────────────────────────────────────────────────────────
function d1(db){
  return {prepare(sql){
    let args=[];
    const st={
      bind(...a){ args=a; return st; },
      async run(){ const r=db.prepare(sql).run(...args); return {meta:{changes:Number(r.changes), last_row_id:Number(r.lastInsertRowid)}}; },
      async all(){ return {results:db.prepare(sql).all(...args)}; },
      async first(){ return db.prepare(sql).get(...args)||null; },
    };
    return st;
  }};
}
function freshDb(){
  const db=new DatabaseSync(':memory:');
  for(const f of ['0007_followup_engine.sql', '0047_followup_ladder.sql', '0048_followup_ladder_variants.sql', '0087_followup_send_failures.sql', '0114_followup_v3.sql'])
    db.exec(readFileSync(new URL('./migrations/'+f, import.meta.url), 'utf8'));
  return db;
}

describe('with D1', ()=>{
  let db, env, realFetch, graphCalls;
  const client={Id:42, client_name:'Acme', industry:'travel', chatwoot_base:'https://cw.test', chatwoot_account_id:1, chatwoot_token:'t', bot_config:JSON.stringify({timezone:'UTC'})};
  beforeEach(()=>{ db=freshDb(); env={DB:d1(db)}; realFetch=globalThis.fetch; graphCalls=[]; });
  afterEach(()=>{ globalThis.fetch=realFetch; });

  test('off by default; switching on records when, and only the first time', async ()=>{
    assert.equal(await fv3IsEnabled(env, 42), false);
    const s=await fv3SaveSettings(env, 42, {enabled:true, industry:'travel'});
    assert.equal(await fv3IsEnabled(env, 42), true);
    await fv3SaveSettings(env, 42, {enabled:false});
    const again=await fv3SaveSettings(env, 42, {enabled:true});
    assert.equal(again.enabled_at, s.enabled_at);
    const cfg=(await fv3SaveSettings(env, 42, {config:{min_gap_hours:999}})).cfg;
    assert.equal(cfg.min_gap_hours, 48);
  });

  test('inbound: credits only the latest send, marks an opt-out, learns the hour; no-op while V3 is off', async ()=>{
    const now=Date.now();
    db.prepare(`INSERT INTO followup_sends (client_id, lead_id, step, variant, sent_at) VALUES (42,7,1,'A',?),(42,7,2,'A',?)`).run(iso(now-5*H), iso(now-H));
    assert.equal(await fv3OnInbound(env, client, 7, {}), false);
    await fv3SaveSettings(env, 42, {enabled:true});
    assert.equal(await fv3OnInbound(env, client, 7, {optOut:true, at:now}), true);
    const rows=db.prepare(`SELECT step, replied_at, opted_out_at FROM followup_sends ORDER BY step`).all();
    assert.equal(rows[0].replied_at, null);
    assert.ok(rows[1].replied_at); assert.ok(rows[1].opted_out_at);
    const st=db.prepare(`SELECT hours_json FROM followup_v3_leads WHERE lead_id=7`).get();
    assert.equal(JSON.parse(st.hours_json)[new Date(now).getUTCHours()], 1);
  });

  test('setup fills nudges 1-2, submits templates, attaches them once approved', async ()=>{
    const settings=await fv3SaveSettings(env, 42, {enabled:true, industry:'travel'});
    let approved=false;
    globalThis.fetch=async (url, opts={})=>{
      graphCalls.push({url:String(url), body:opts.body?JSON.parse(opts.body):null});
      if((opts.method||'GET')==='POST') return new Response(JSON.stringify({id:'1', status:'PENDING'}));
      const name=new URL(String(url)).searchParams.get('name');
      return new Response(JSON.stringify({data:[{name, status:approved?'APPROVED':'PENDING', language:'en'}]}));
    };
    const deps={metaCreds:()=>({waba_id:'W', wa_token:'tok', wa_phone_id:'P'}), ai:async()=>'Hey {name}, still keen on your trip?'};
    const rep=await fv3Setup(env, deps, client, settings);
    assert.equal(rep.session[1], 'created');
    const s1=db.prepare(`SELECT message, message_b FROM followup_ladder_steps WHERE client_id=42 AND step=1`).get();
    assert.match(s1.message, /\{name\}/); assert.equal(s1.message_b, 'Hey {name}, still keen on your trip?');
    const posts=graphCalls.filter(c=>c.body);
    assert.deepEqual(posts.map(c=>c.body.name), ['lv_followup_s3', 'lv_followup_s4', 'lv_followup_s5', 'lv_followup_reengage']);
    assert.equal(posts[0].body.category, 'MARKETING');
    assert.equal(db.prepare(`SELECT template_name FROM followup_ladder_steps WHERE client_id=42 AND step=3`).get().template_name, '');
    approved=true;
    await fv3Setup(env, deps, client, await fv3GetSettings(env, 42));
    const s3=db.prepare(`SELECT template_name, template_body_vars FROM followup_ladder_steps WHERE client_id=42 AND step=3`).get();
    assert.deepEqual({...s3}, {template_name:'lv_followup_s3', template_body_vars:3});
    // A merchant's own template choice is never overwritten.
    db.prepare(`UPDATE followup_ladder_steps SET template_name='my_tpl' WHERE client_id=42 AND step=4`).run();
    await fv3Setup(env, deps, client, await fv3GetSettings(env, 42));
    assert.equal(db.prepare(`SELECT template_name FROM followup_ladder_steps WHERE client_id=42 AND step=4`).get().template_name, 'my_tpl');
  });

  test('sweep: sends what is due, respects the daily cap, records status, defers on a Meta frequency hold', async ()=>{
    await fv3EnsureSchema(env);
    const now=Date.now();
    const settings=await fv3SaveSettings(env, 42, {enabled:true, industry:'travel', config:{quiet_start:0, quiet_end:0, warmup_cap:1, objection_branching:false}});
    db.prepare(`UPDATE followup_v3_settings SET maint_at=?, enabled_at=? WHERE client_id=42`).run(iso(now), iso(now-5*D));
    const ins=db.prepare(`INSERT INTO followup_ladder_steps (client_id, step, type, hours, message, template_name, template_body_vars, updated_at) VALUES (42,?,?,?,?,?,?,?)`);
    ins.run(1, 'session', 1, 'Hi {name} about {product}', '', 0, iso(now));
    ins.run(3, 'template', 25, '', 'lv_followup_s3', 3, iso(now));
    db.prepare(`INSERT INTO followup_v3_templates (client_id, kind, name, status, params, submitted_at) VALUES (42,'s3','lv_followup_s3','APPROVED','["name","business","interest"]',?)`).run(iso(now));
    const leads=[
      {Id:1, Name:'Asha', Phone:'91900', Stage:'new', CreatedAt:iso(now-3*D), LastCustomerMsgAt:iso(now-2*H)},   // nudge 1 due
      {Id:2, Name:'Ravi', Phone:'91901', Stage:'new', CreatedAt:iso(now-3*D), LastCustomerMsgAt:iso(now-27*H)},  // template step 3 due
      {Id:3, Name:'Old', Phone:'91902', Stage:'new', CreatedAt:iso(now-40*D), LastCustomerMsgAt:iso(now-2*H)},   // came in before V3 — not enrolled
    ];
    globalThis.fetch=async url=>new Response(JSON.stringify({data:[{name:new URL(url).searchParams.get('name'),status:'APPROVED',language:'en_US'}]}));
    const sent=[];
    let fail=null;
    const deps={
      leadsTable:'L', ncFetch:async(e,path)=>new Response(JSON.stringify(/records\/\d+$/.test(path)?{...leads.find(l=>l.Id===Number(path.split('/').pop())),ClientId:42}:{list:leads})), ensureLeadsColumns:async()=>{},
      metaCreds:()=>({waba_id:'W', wa_token:'tok', wa_phone_id:'P'}),
      sendStep:async(env2, c, lead, step, stepCfg, opts)=>{
        if(fail){ const e=new Error('held'); e.code=fail; e.definiteFailure=true; throw e; }
        sent.push({lead:lead.Id, step, opts});
        db.prepare(`INSERT INTO followup_sends (client_id, lead_id, step, variant, sent_at, v3, kind) VALUES (42,?,?,?,?,1,?)`).run(lead.Id, step, 'A', iso(now), opts.kind);
      },
    };
    let r=await fv3ProcessClient(env, deps, client, await fv3GetSettings(env, 42), {now});
    assert.equal(r.due, 2); assert.equal(r.sent, 1, 'warm-up cap of 1/day');
    assert.equal(sent[0].lead, 2, 'the longest-overdue goes first');
    assert.deepEqual(sent[0].opts.templateParams, ['Ravi', 'Acme', 'your trip plans']);
    const st=Object.fromEntries(db.prepare(`SELECT lead_id, status FROM followup_v3_leads`).all().map(x=>[x.lead_id, x.status]));
    assert.equal(st[1], 'due'); assert.equal(st[3], 'not_enrolled');
    // Cap lifted; Meta holds the next one → deferred a day and logged once with its code.
    db.prepare(`UPDATE followup_v3_settings SET config=? WHERE client_id=42`).run(JSON.stringify({...settings.cfg, warmup_cap:50}));
    fail=131049;
    r=await fv3ProcessClient(env, deps, client, await fv3GetSettings(env, 42), {now});
    const defer=db.prepare(`SELECT defer_until FROM followup_v3_leads WHERE lead_id=1`).get().defer_until;
    assert.ok(Date.parse(defer)>now+23*H);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM followup_send_failures WHERE error_code=131049`).get().n, 1);
    fail=null;
    r=await fv3ProcessClient(env, deps, client, await fv3GetSettings(env, 42), {now});
    assert.equal(sent.length, 1, 'deferred lead not retried before its time');
  });
  test('sweep asks NocoDB only for columns the leads table has (an unknown field fails the whole read)', async ()=>{
    await fv3EnsureSchema(env);
    const now=Date.now();
    await fv3SaveSettings(env, 42, {enabled:true, config:{quiet_start:0, quiet_end:0, objection_branching:false}});
    db.prepare(`UPDATE followup_v3_settings SET maint_at=?, enabled_at=? WHERE client_id=42`).run(iso(now), iso(now-5*D));
    db.prepare(`INSERT INTO followup_ladder_steps (client_id, step, type, hours, message, updated_at) VALUES (42,1,'session',1,'Hi {name}',?)`).run(iso(now));
    const columns=['Id', 'Name', 'Phone', 'Stage', 'OptOut', 'ClientId', 'CreatedAt', 'LastCustomerMsgAt', 'ConversationID'];
    const leads=[{Id:7, Name:'Mia', Stage:'new', CreatedAt:iso(now-D), LastCustomerMsgAt:iso(now-2*H)}];
    const deps={
      leadsTable:'L', ensureLeadsColumns:async()=>{}, leadColumns:async()=>columns,
      ncFetch:async(env2, path)=>{
        if(/records\/\d+$/.test(path)) return new Response(JSON.stringify({...leads[0],ClientId:42}));
        const fields=decodeURIComponent(new URL('http://x/'+path).searchParams.get('fields')||'').split(',');
        if(fields.some(f=>!columns.includes(f))) return new Response('{"msg":"Field not found"}', {status:404});
        return new Response(JSON.stringify({list:leads}));
      },
      sendStep:async()=>{},
    };
    const r=await fv3ProcessClient(env, deps, client, await fv3GetSettings(env, 42), {now});
    assert.equal(r.sent, 1);
    assert.equal(db.prepare(`SELECT status FROM followup_v3_leads WHERE lead_id=7`).get().status, 'due');
    // A read that still fails is reported, not silently treated as "no leads".
    deps.leadColumns=async()=>null;
    await assert.rejects(fv3ProcessClient(env, deps, client, await fv3GetSettings(env, 42), {now}), /NocoDB 404/);
    assert.deepEqual(fv3LeadFields(['Name']), ['Id', 'Name']);
  });
  test('run now (Leads opened): sends what is due, at most once per 2 minutes, never alongside another sweep', async ()=>{
    await fv3EnsureSchema(env);
    const now=Date.now();
    await fv3SaveSettings(env, 42, {enabled:true, config:{quiet_start:0, quiet_end:0, objection_branching:false}});
    db.prepare(`UPDATE followup_v3_settings SET maint_at=?, enabled_at=? WHERE client_id=42`).run(iso(now), iso(now-5*D));
    db.prepare(`INSERT INTO followup_ladder_steps (client_id, step, type, hours, message, updated_at) VALUES (42,1,'session',1,'Hi {name}',?)`).run(iso(now));
    const leads=[{Id:8, Name:'Zed', Stage:'new', CreatedAt:iso(now-D), LastCustomerMsgAt:iso(now-2*H)}];
    let sends=0;
    const deps={leadsTable:'L', ensureLeadsColumns:async()=>{}, ncFetch:async(e,path)=>new Response(JSON.stringify(/records\/\d+$/.test(path)?{...leads.find(l=>l.Id===Number(path.split('/').pop())),ClientId:42}:{list:leads})),
      sendStep:async(e, c, lead, step)=>{ sends++; db.prepare(`INSERT INTO followup_sends (client_id, lead_id, step, variant, sent_at, v3) VALUES (42,?,?,'A',?,1)`).run(lead.Id, step, iso(now)); }};
    const s=await fv3GetSettings(env, 42);
    assert.equal((await fv3RunClient(env, deps, client, s, {now, minGapMs:120000})).sent, 1);
    assert.equal((await fv3RunClient(env, deps, client, s, {now:now+60000, minGapMs:120000})).skipped, 'recent');
    // A sweep still holding the lock blocks a second one, even past the gap.
    db.prepare(`UPDATE followup_v3_settings SET sweep_lock_until=? WHERE client_id=42`).run(iso(now+10*60000));
    assert.equal((await fv3RunClient(env, deps, client, s, {now:now+3*60000})).skipped, 'recent');
    db.prepare(`UPDATE followup_v3_settings SET sweep_lock_until=NULL WHERE client_id=42`).run();
    await fv3RunClient(env, deps, client, s, {now:now+3*60000});
    assert.equal(sends, 1, 'nothing new was due');
    assert.equal(db.prepare(`SELECT sweep_lock_until FROM followup_v3_settings WHERE client_id=42`).get().sweep_lock_until, null, 'lock released');
  });
  async function fixture(){
    const now=Date.now();
    await fv3SaveSettings(env,42,{enabled:true,config:{quiet_start:0,quiet_end:0,objection_branching:false,weekly_digest:false}});
    db.prepare(`UPDATE followup_v3_settings SET maint_at=?,enabled_at=? WHERE client_id=42`).run(iso(now),iso(now-5*D));
    db.prepare(`INSERT INTO followup_ladder_steps (client_id,step,type,hours,message,updated_at) VALUES (42,1,'session',1,'Hello {name}',?)`).run(iso(now));
    const l={Id:7,ClientId:42,Name:'Test',Stage:'new',CreatedAt:iso(now-D),LastCustomerMsgAt:iso(now-2*H)};
    let count=0;
    const deps={leadsTable:'L',ncFetch:async(e,path)=>new Response(JSON.stringify(/records\/\d+$/.test(path)?l:{list:[l]})),sendStep:async()=>{count++;}};
    return {now,l,deps,count:()=>count,settings:()=>fv3GetSettings(env,42)};
  }
  test('preview evaluates leads with no sends, template setup, state writes, or send claims',async()=>{
    const f=await fixture();
    f.deps.ai=()=>{throw new Error('Preview must not generate messages');};
    const before=db.prepare(`SELECT COUNT(*) n FROM followup_v3_leads`).get().n;
    const r=await fv3ProcessClient(env,f.deps,client,await f.settings(),{preview:true});
    assert.equal(r.checked,1);assert.equal(r.due,1);assert.equal(r.sent,0);assert.equal(f.count(),0);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM followup_v3_leads`).get().n,before);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM followup_v3_jobs`).get().n,0);
  });
  test('fresh customer reply or opt-out between evaluation and sending cancels the send',async()=>{
    const f=await fixture();const get=f.deps.ncFetch;
    f.deps.ncFetch=async(e,path)=>/records\/\d+$/.test(path)?new Response(JSON.stringify({...f.l,OptOut:'Yes'})):get(e,path);
    await fv3ProcessClient(env,f.deps,client,await f.settings());assert.equal(f.count(),0);
    f.deps.ncFetch=async(e,path)=>/records\/\d+$/.test(path)?new Response(JSON.stringify({...f.l,LastCustomerMsgAt:iso(Date.now())})):get(e,path);
    await fv3ProcessClient(env,f.deps,client,await f.settings());assert.equal(f.count(),0);
  });
  test('atomic claim prevents duplicate send even when send-history persistence was lost',async()=>{
    const f=await fixture();
    await fv3ProcessClient(env,f.deps,client,await f.settings());
    await fv3ProcessClient(env,f.deps,client,await f.settings());assert.equal(f.count(),1);
  });
  test('ambiguous timeout holds the lead instead of automatically sending again',async()=>{
    const f=await fixture();let attempts=0;
    f.deps.sendStep=async()=>{attempts++;throw new Error('Connection timed out');};
    await fv3ProcessClient(env,f.deps,client,await f.settings());
    const r=await fv3ProcessClient(env,f.deps,client,await f.settings());
    assert.equal(attempts,1);assert.equal(r.reasons.delivery_unknown,1);
    assert.equal(db.prepare(`SELECT status FROM followup_v3_jobs`).get().status,'uncertain');
  });
  test('failed lead reads are visible in health and never reported as successful runs',async()=>{
    const f=await fixture();f.deps.ncFetch=async()=>new Response('Unavailable',{status:503});
    await assert.rejects(fv3RunClient(env,f.deps,client,await f.settings()),/NocoDB 503/);
    let h=fv3Health(await f.settings());assert.equal(h.status,'failed');assert.match(h.error,/503/);assert.equal(h.last_success_at,null);
    f.deps.ncFetch=async()=>new Response(JSON.stringify({list:[]}));
    await fv3RunClient(env,f.deps,client,await f.settings(),{now:Date.now()+1});h=fv3Health(await f.settings());
    assert.equal(h.status,'healthy');assert.equal(h.error,null);assert.ok(h.last_success_at);
    assert.equal(fv3Health(await f.settings(),Date.now()+31*60000).status,'delayed');
  });
  test('delivery callbacks are idempotent and cannot downgrade read receipts',async()=>{
    await fv3EnsureSchema(env);
    db.prepare(`INSERT INTO followup_sends (client_id,lead_id,step,variant,sent_at,provider_message_id) VALUES (42,7,1,'A',?,'wamid.123')`).run(iso(Date.now()));
    const event=status=>({entry:[{changes:[{value:{statuses:[{id:'wamid.123',status,timestamp:String(Math.floor(Date.now()/1000))}]}}]}]});
    await fv3DeliveryStatus(env,event('read'));await fv3DeliveryStatus(env,event('sent'));await fv3DeliveryStatus(env,event('delivered'));
    const row=db.prepare(`SELECT * FROM followup_sends`).get();assert.equal(row.delivery_status,'read');assert.ok(row.read_at);assert.ok(row.delivered_at);
    await fv3DeliveryStatus(env,{entry:[{changes:[{value:{statuses:[{id:'unknown',status:'failed',timestamp:'1'}]}}]}]});
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM followup_sends`).get().n,1);
  });
  test('status write failure aborts the run before any send',async()=>{
    const f=await fixture();const original=env.DB.prepare;
    env.DB.prepare=function(sql){if(sql.startsWith('INSERT INTO followup_v3_leads')) return {bind(){return this;},async run(){throw new Error('D1 write failed');}};return original.call(this,sql);};
    await assert.rejects(fv3RunClient(env,f.deps,client,await f.settings()),/D1 write failed/);assert.equal(f.count(),0);
    assert.equal(fv3Health(await f.settings()).status,'failed');
  });

});


test('stage sequences override wording while preserving exit rules and session expiry',()=>{
  const custom=fv3Config({stage_sequences:{quote_sent:{1:{message:'Questions about the quote?',hours:3},3:{template_name:'quote_day1',template_language:'en_US'}}}});
  const l=lead({Stage:'quote_sent'}),effective=fv3StepsForLead(steps,custom,l);
  assert.equal(effective[1].message,'Questions about the quote?');assert.equal(effective[1].message_b,'');assert.equal(effective[3].template_name,'quote_day1');
  const d=fv3Decide({lead:l,steps,cfg:custom,now:T('2026-10-11T12:00:00Z'),tz:'UTC'});
  assert.equal(d.steps[0].state,'expired');assert.equal(d.next.step,3);
  assert.equal(fv3Decide({lead:{...l,Handover:'Yes'},steps,cfg:custom,now:T('2026-10-11T12:00:00Z')}).status,'human');
});
