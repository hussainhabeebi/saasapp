// CEO Bot (ceo-bot.js) — config/date/command parsing, then the cron playbooks, the WhatsApp
// webhook (staff updates, owner instructions with approvals) and the /ceo/* API, end to end against
// the real Projects + CEO Bot migrations (node:sqlite through the same tiny D1 shim the other
// module tests use). deps are recorded fakes, so nothing leaves the box.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import {
  ceoEnabled, ceoNormalizeConfig, ceoParseDate, ceoParseStaffCommand, ceoIsQuiet, ceoTemplateParam,
  ceoRunForClient, ceoHandleRoute, ceoScorecard, ceoBuildContext,
} from './ceo-bot.js';

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
const MIGRATIONS=['0050_pm_projects_tasks.sql','0051_pm_phase2.sql','0052_pm_merge_legacy_tasks.sql','0058_project_automation.sql','0110_ceo_bot.sql'];
function freshDb(){
  const db=new DatabaseSync(':memory:');
  for(const f of MIGRATIONS) db.exec(readFileSync(new URL(`./migrations/${f}`, import.meta.url), 'utf8'));
  return db;
}

const CID=7;
const TODAY='2026-10-06'; // a Tuesday
const at=(hm, date=TODAY)=>Date.parse(`${date}T${hm}:00+05:30`); // IST wall clock → ms
const OWNER='boss@acme.com', RAHUL='rahul@acme.com', PRIYA='priya@acme.com';
const PHONES={[OWNER]:'919800000001', [RAHUL]:'919800000002', [PRIYA]:'919800000003'};
const CLIENT={Id:CID, client_name:'Acme', ceo_bot_enabled:'Yes', authentik_email:OWNER, team_emails:`${RAHUL},${PRIYA}`,
  team_names:JSON.stringify({[OWNER]:'Anil Boss', [RAHUL]:'Rahul K', [PRIYA]:'Priya S'}), team_whatsapp:JSON.stringify(PHONES), wa_phone_id:'111'};
const APP_SECRET='app-secret';

function fakeDeps(client=CLIENT){
  const log={sent:[], changed:[], ai:[]};
  const aiQueue=[];
  const deps={
    log, aiQueue,
    json:(data, status)=>new Response(JSON.stringify(data), {status:status||200, headers:{'Content-Type':'application/json'}}),
    requireSession:async(req)=>{
      const a=req.headers.get('Authorization')||'';
      return a==='Bearer owner'?{cid:CID, email:OWNER}:a==='Bearer staff'?{cid:CID, email:RAHUL}:null;
    },
    getClientById:async()=>client,
    reportOpsError:async(env, where, e)=>{ throw e; },
    parseTeamWhatsapp:c=>{ try{ return JSON.parse(c.team_whatsapp||'{}'); }catch(e){ return {}; } },
    normalizePhone:raw=>{ let d=String(raw||'').replace(/\D/g,''); if(d.length===10) d='91'+d; return d.length>=8?d:''; },
    ai:async(env, c, sys, user)=>{ log.ai.push({sys, user}); return aiQueue.length?aiQueue.shift():null; },
    encrypt:async(env, plain)=>'enc:'+plain,
    decrypt:async(env, stored)=>String(stored).startsWith('enc:')?String(stored).slice(4):null,
    verifySignature:async(secret, raw, sig)=>sig==='sha256='+createHmac('sha256', secret).update(raw).digest('hex'),
    metaAppSecret:()=>APP_SECRET,
    onTaskChanged:async(env, cid, taskId, prev)=>{ log.changed.push({taskId, prev}); },
    waSend:async(creds, body)=>{ log.sent.push(body); return {ok:true, id:'wamid.out'}; },
    waLookup:async(creds)=>creds.wa_token==='good'?{ok:true, display_phone:'+91 98000 99999'}:{ok:false, error:'Invalid OAuth access token'},
    webhookBase:()=>'https://api.example',
  };
  return deps;
}

let db, env, deps;
function seed(cfg={}){
  const now='2026-09-01T00:00:00Z';
  db.prepare(`INSERT INTO pm_projects (id, client_id, name, created_at) VALUES (1, ?, 'Website', ?)`).run(CID, now);
  db.prepare(`INSERT INTO pm_projects (id, client_id, name, status, created_at) VALUES (2, ?, 'Old', 'archived', ?)`).run(CID, now);
  const t=(id, title, assignee, due, status='todo', project=1, extra={})=>db.prepare(`INSERT INTO pm_tasks (id, client_id, project_id, title, status, assignee_email, due_date, done_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, CID, project, title, status, assignee, due, extra.done_at||null, extra.created_at||now, now);
  t(10, 'Homepage banner', RAHUL, '2026-10-03');           // 3 days late
  t(11, 'Pricing page copy', RAHUL, '2026-10-06');         // due today
  t(12, 'Blog post', PRIYA, '2026-10-07');                 // due tomorrow
  t(13, 'Logo files', PRIYA, '2026-10-05', 'done', 1, {done_at:'2026-10-05T10:00:00Z'}); // done yesterday, on time
  t(14, 'Archived thing', RAHUL, '2026-09-01', 'todo', 2); // archived project → ignored
  t(15, 'Contact form', RAHUL, '2026-10-05', 'blocked');   // 1 day late, blocked
  const config=ceoNormalizeConfig({active:true, ...cfg});
  db.prepare(`INSERT INTO ceo_bot_settings (client_id, config_json, wa_phone_id, display_phone, wa_token_enc, app_secret_enc, hook_key, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(CID, JSON.stringify(config), '555', '+91 98000 99999', 'enc:tok', '', 'a'.repeat(32), now);
}
// Open the WhatsApp 24h window for these phones (as if they had written in recently).
function openWindow(phones, whenMs){
  for(const p of phones) db.prepare(`INSERT INTO ceo_bot_contacts (client_id, phone, last_inbound_at) VALUES (?,?,?) ON CONFLICT(client_id, phone) DO UPDATE SET last_inbound_at=excluded.last_inbound_at`)
    .run(CID, p, new Date(whenMs-3600000).toISOString());
}
const sentTo=to=>deps.log.sent.filter(b=>b.to===to);
const textOf=b=>b.text?.body||b.interactive?.body?.text||b.template?.components?.[0]?.parameters?.[0]?.text||'';
function req(method, path, {auth='owner', body}={}){
  return new Request('https://api.example'+path, {method, headers:{Authorization:'Bearer '+auth, 'Content-Type':'application/json'}, body:body?JSON.stringify(body):undefined});
}
async function call(method, path, opts){
  const r=req(method, path, opts);
  const res=await ceoHandleRoute(r, env, deps, new URL(r.url));
  return {status:res.status, body:await res.json()};
}
let msgSeq=0;
async function inbound(from, msg){
  const payload={object:'whatsapp_business_account', entry:[{changes:[{field:'messages', value:{metadata:{phone_number_id:'555'},
    messages:[{from, id:msg.id||`wamid.in.${++msgSeq}`, ...(msg.button?{type:'interactive', interactive:{type:'button_reply', button_reply:{id:msg.button, title:'x'}}}:{type:'text', text:{body:msg.text}})}]}}]}]};
  const raw=JSON.stringify(payload);
  const sig='sha256='+createHmac('sha256', msg.secret||APP_SECRET).update(raw).digest('hex');
  const r=new Request('https://api.example/ceo/wa/webhook/'+'a'.repeat(32), {method:'POST', headers:{'X-Hub-Signature-256':sig}, body:raw});
  return ceoHandleRoute(r, env, deps, new URL(r.url));
}

beforeEach(()=>{ db=freshDb(); env={DB:d1(db)}; deps=fakeDeps(); msgSeq=0; });

describe('gating, config and parsing', ()=>{
  test('enabled only when the super-admin flag is Yes', ()=>{
    assert.equal(ceoEnabled({ceo_bot_enabled:'Yes'}), true);
    assert.equal(ceoEnabled({ceo_bot_enabled:'No'}), false);
    assert.equal(ceoEnabled({}), false);
    assert.equal(ceoEnabled(null), false);
  });
  test('config defaults and clamps', ()=>{
    const d=ceoNormalizeConfig('');
    assert.equal(d.active, false); assert.equal(d.autonomy, 'suggest'); assert.equal(d.schedule.brief, '09:00');
    assert.equal(d.playbooks.standup, false); assert.equal(d.staff_delay_needs_approval, true);
    const c=ceoNormalizeConfig({autonomy:'god', schedule:{brief:'25:00', tz_offset_min:9999, work_days:[1,1,9]}, monthly_ai_cap:-5, template:{name:'ceo update!'}});
    assert.equal(c.autonomy, 'suggest'); assert.equal(c.schedule.brief, '09:00'); assert.equal(c.schedule.tz_offset_min, 840);
    assert.deepEqual(c.schedule.work_days, [1]); assert.equal(c.monthly_ai_cap, 0); assert.equal(c.template.name, 'ceoupdate');
  });
  test('quiet hours wrap past midnight', ()=>{
    const cfg=ceoNormalizeConfig({schedule:{quiet_start:21, quiet_end:7}});
    assert.equal(ceoIsQuiet(22, cfg), true); assert.equal(ceoIsQuiet(3, cfg), true); assert.equal(ceoIsQuiet(9, cfg), false);
  });
  test('dates', ()=>{
    assert.equal(ceoParseDate('tomorrow', TODAY), '2026-10-07');
    assert.equal(ceoParseDate('by friday', TODAY), '2026-10-09');
    assert.equal(ceoParseDate('tuesday', TODAY), '2026-10-13'); // same weekday → next week
    assert.equal(ceoParseDate('in 3 days', TODAY), '2026-10-09');
    assert.equal(ceoParseDate('2026-11-02', TODAY), '2026-11-02');
    assert.equal(ceoParseDate('12/10', TODAY), '2026-10-12');
    assert.equal(ceoParseDate('15 nov', TODAY), '2026-11-15');
    assert.equal(ceoParseDate('jan 3', TODAY), '2027-01-03');
    assert.equal(ceoParseDate('31/02', TODAY), null);
    assert.equal(ceoParseDate('soon', TODAY), null);
  });
  test('staff commands', ()=>{
    assert.deepEqual(ceoParseStaffCommand('DONE 12'), {verb:'done', id:12, rest:''});
    assert.deepEqual(ceoParseStaffCommand('blocked #15 waiting for API keys'), {verb:'blocked', id:15, rest:'waiting for API keys'});
    assert.deepEqual(ceoParseStaffCommand('delay 11 friday'), {verb:'delay', id:11, rest:'friday'});
    assert.deepEqual(ceoParseStaffCommand('finished'), {verb:'done', id:null, rest:''});
    assert.equal(ceoParseStaffCommand('working on it'), null);
    assert.equal(ceoParseStaffCommand('hello'), null);
  });
  test('template variable is flattened for Meta', ()=>{
    assert.equal(ceoTemplateParam('a\n\nb\n  c\td'), 'a · b · c d');
  });
});

describe('API access', ()=>{
  test('status is readable; everything else is owner-only and needs the flag', async()=>{
    seed();
    assert.deepEqual((await call('GET', '/ceo/status', {auth:'staff'})).body, {enabled:true, admin:false});
    assert.equal((await call('GET', '/ceo/config', {auth:'staff'})).status, 403);
    assert.equal((await call('GET', '/ceo/threads', {auth:'staff'})).status, 403);
    assert.equal((await call('GET', '/ceo/config', {auth:'nobody'})).status, 401);
    deps=fakeDeps({...CLIENT, ceo_bot_enabled:'No'});
    assert.deepEqual((await call('GET', '/ceo/status')).body, {enabled:false, admin:true});
    assert.equal((await call('GET', '/ceo/config')).status, 403);
  });
  test('config save merges and normalizes; secrets never come back', async()=>{
    seed();
    const r=await call('POST', '/ceo/config', {body:{config:{autonomy:'auto_safe', playbooks:{standup:true}, schedule:{brief:'08:30'}}}});
    assert.equal(r.body.config.autonomy, 'auto_safe'); assert.equal(r.body.config.playbooks.standup, true);
    assert.equal(r.body.config.playbooks.brief, true); assert.equal(r.body.config.schedule.brief, '08:30'); assert.equal(r.body.config.schedule.wrap, '18:30');
    const g=await call('GET', '/ceo/config');
    assert.equal(g.body.config.autonomy, 'auto_safe');
    assert.equal(g.body.channel.connected, true);
    assert.equal(g.body.channel.webhook_url, 'https://api.example/ceo/wa/webhook/'+'a'.repeat(32));
    assert.ok(!JSON.stringify(g.body).includes('enc:tok'));
    assert.deepEqual(g.body.team.map(m=>m.email), [OWNER, RAHUL, PRIYA]);
  });
  test('channel: refuses the leads number and bad tokens, saves a good one', async()=>{
    assert.equal((await call('POST', '/ceo/channel', {body:{wa_phone_id:'111', wa_token:'good'}})).status, 400);
    const bad=await call('POST', '/ceo/channel', {body:{wa_phone_id:'222', wa_token:'bad'}});
    assert.equal(bad.status, 400); assert.match(bad.body.error, /Invalid OAuth/);
    const ok=await call('POST', '/ceo/channel', {body:{wa_phone_id:'222', wa_token:'good', app_secret:'s3'}});
    assert.equal(ok.body.channel.connected, true); assert.equal(ok.body.channel.display_phone, '+91 98000 99999');
    assert.match(ok.body.channel.verify_token, /^[a-f0-9]{32}$/);
    const row=db.prepare(`SELECT * FROM ceo_bot_settings WHERE client_id=?`).get(CID);
    assert.equal(row.wa_token_enc, 'enc:good'); assert.equal(row.app_secret_enc, 'enc:s3');
    const off=await call('POST', '/ceo/channel', {body:{disconnect:true}});
    assert.equal(off.body.channel.connected, false);
  });
});

describe('scheduled playbooks', ()=>{
  test('morning: owner brief + staff lists, once per day', async()=>{
    seed();
    const now=at('09:05');
    openWindow(Object.values(PHONES), now);
    const r=await ceoRunForClient(env, deps, CID, now);
    assert.ok(r.sent.includes('brief'));
    const brief=textOf(sentTo(PHONES[OWNER])[0]);
    assert.match(brief, /Good morning, Anil/);
    assert.match(brief, /Overdue: 2/);                       // #10 and #15 (archived #14 ignored)
    assert.match(brief, /#10 Homepage banner — Rahul K, 3d late/);
    assert.match(brief, /Done yesterday: 1/);
    assert.doesNotMatch(brief, /Archived thing/);
    const rahul=textOf(sentTo(PHONES[RAHUL])[0]);
    assert.match(rahul, /#10 Homepage banner — 3d late/); assert.match(rahul, /#11 Pricing page copy — due today/);
    assert.match(textOf(sentTo(PHONES[PRIYA])[0]), /#12 Blog post — due tomorrow/);
    const n=deps.log.sent.length;
    await ceoRunForClient(env, deps, CID, at('09:20'));
    assert.equal(deps.log.sent.length, n, 'nothing is sent twice');
  });
  test('outside the 24h window: template when set, otherwise logged as skipped', async()=>{
    seed();
    await ceoRunForClient(env, deps, CID, at('09:05'));
    assert.equal(deps.log.sent.length, 0);
    const skipped=db.prepare(`SELECT COUNT(*) n FROM ceo_bot_messages WHERE status='skipped'`).get().n;
    assert.ok(skipped>=3);
    db.exec(`DELETE FROM ceo_bot_runs`);
    db.prepare(`UPDATE ceo_bot_settings SET config_json=?`).run(JSON.stringify(ceoNormalizeConfig({active:true, template:{name:'ceo_update', lang:'en'}})));
    await ceoRunForClient(env, deps, CID, at('09:06'));
    const b=sentTo(PHONES[OWNER])[0];
    assert.equal(b.type, 'template'); assert.equal(b.template.name, 'ceo_update');
    assert.ok(!textOf(b).includes('\n'));
  });
  test('escalation: staff nudge with buttons, owner alert once per task', async()=>{
    seed();
    const now=at('10:15');
    openWindow(Object.values(PHONES), now);
    await ceoRunForClient(env, deps, CID, now);
    const nudge=sentTo(PHONES[RAHUL]).find(b=>b.type==='interactive');
    assert.ok(nudge);
    assert.match(textOf(nudge), /2 of your tasks are overdue/);
    assert.deepEqual(nudge.interactive.action.buttons.map(b=>b.reply.id), ['ceo:done:10','ceo:delay:10','ceo:blocked:10']);
    const alert=sentTo(PHONES[OWNER]).map(textOf).find(t=>t.includes('Overdue escalation'));
    assert.match(alert, /#10 Homepage banner/);
    assert.doesNotMatch(alert, /#15/); // only 1 day late, admin threshold is 2
    deps.log.sent=[];
    await ceoRunForClient(env, deps, CID, at('11:00'));
    assert.equal(deps.log.sent.filter(b=>textOf(b).includes('overdue')||textOf(b).includes('Overdue')).length, 0);
  });
  test('paused, inactive, quiet hours and non-work days send nothing', async()=>{
    seed({paused:true});
    openWindow(Object.values(PHONES), at('09:05'));
    assert.deepEqual(await ceoRunForClient(env, deps, CID, at('09:05')), {skipped:'inactive'});
    db.prepare(`UPDATE ceo_bot_settings SET config_json=?`).run(JSON.stringify(ceoNormalizeConfig({active:true})));
    assert.deepEqual(await ceoRunForClient(env, deps, CID, at('22:30')), {skipped:'quiet'});
    db.prepare(`UPDATE ceo_bot_settings SET config_json=?`).run(JSON.stringify(ceoNormalizeConfig({active:true, schedule:{work_days:[1]}})));
    const r=await ceoRunForClient(env, deps, CID, at('09:05'));
    assert.deepEqual(r.sent, []);
    deps=fakeDeps({...CLIENT, ceo_bot_enabled:'No'});
    assert.deepEqual(await ceoRunForClient(env, deps, CID, at('09:05')), {skipped:'disabled'});
  });
  test('standup asked, answer logged — "Done the banner…" is an answer, not a command', async()=>{
    seed({playbooks:{standup:true, brief:false, reminders:false, escalation:false}});
    openWindow(Object.values(PHONES), at('10:05'));
    await ceoRunForClient(env, deps, CID, at('10:05'));
    assert.match(textOf(sentTo(PHONES[RAHUL])[0]), /Quick standup/);
    assert.equal(sentTo(PHONES[OWNER]).length, 0, 'owner is not asked for a standup');
    // The webhook dates the answer from the real clock (Date.now()) — pin it to the fixture's day,
    // otherwise this only passes while it's still TODAY in IST.
    const realNow=Date.now; Date.now=()=>at('10:30');
    try{ await inbound(PHONES[RAHUL], {text:'Done the banner draft. Today pricing copy. Blocked on API keys'}); }
    finally{ Date.now=realNow; }
    const s=db.prepare(`SELECT * FROM ceo_bot_standups WHERE member_email=?`).get(RAHUL);
    assert.match(s.answer, /banner draft/); assert.ok(s.answered_at);
    assert.equal(db.prepare(`SELECT status FROM pm_tasks WHERE id=10`).get().status, 'todo');
    assert.match(sentTo(PHONES[OWNER]).map(textOf).join('\n'), /standup mentions a blocker/);
  });
  test('weekly report + recognition on the weekly day', async()=>{
    seed({schedule:{weekly_day:2, weekly_time:'09:30'}, playbooks:{brief:false, reminders:false, escalation:false}});
    for(const id of [20,21,22]) db.prepare(`INSERT INTO pm_tasks (id, client_id, project_id, title, status, assignee_email, due_date, done_at, created_at, updated_at) VALUES (?,?,1,?,'done',?,?,?,?,?)`)
      .run(id, CID, 'Task '+id, PRIYA, '2026-10-06', '2026-10-04T08:00:00Z', '2026-10-01T00:00:00Z', '2026-10-04T08:00:00Z');
    openWindow(Object.values(PHONES), at('09:35'));
    await ceoRunForClient(env, deps, CID, at('09:35'));
    const rep=textOf(sentTo(PHONES[OWNER])[0]);
    assert.match(rep, /Weekly CEO report/); assert.match(rep, /Top performer: Priya S \(4 done\)/);
    assert.match(textOf(sentTo(PHONES[PRIYA])[0]), /Great week, Priya! You closed 4 tasks, all on time/);
    assert.equal(sentTo(PHONES[RAHUL]).length, 0);
  });
});

describe('WhatsApp webhook', ()=>{
  test('verify handshake and signature', async()=>{
    seed();
    const g=new Request('https://api.example/ceo/wa/webhook/'+'a'.repeat(32)+'?hub.mode=subscribe&hub.verify_token='+'a'.repeat(32)+'&hub.challenge=42');
    assert.equal(await (await ceoHandleRoute(g, env, deps, new URL(g.url))).text(), '42');
    assert.equal((await inbound(PHONES[RAHUL], {text:'DONE 10', secret:'wrong'})).status, 401);
    const nope=new Request('https://api.example/ceo/wa/webhook/'+'b'.repeat(32), {method:'POST', body:'{}'});
    assert.equal((await ceoHandleRoute(nope, env, deps, new URL(nope.url))).status, 404);
  });
  test('staff DONE updates the task, fires the Projects automation hook, replies; duplicates ignored', async()=>{
    seed();
    await inbound(PHONES[RAHUL], {text:'DONE 10', id:'wamid.X'});
    const t=db.prepare(`SELECT status, done_at FROM pm_tasks WHERE id=10`).get();
    assert.equal(t.status, 'done'); assert.ok(t.done_at);
    assert.deepEqual(deps.log.changed, [{taskId:10, prev:'todo'}]);
    assert.match(textOf(sentTo(PHONES[RAHUL])[0]), /Marked #10 "Homepage banner" done/);
    await inbound(PHONES[RAHUL], {text:'DONE 10', id:'wamid.X'});
    assert.equal(sentTo(PHONES[RAHUL]).length, 1);
    await inbound(PHONES[RAHUL], {text:'done 12'});
    assert.match(textOf(sentTo(PHONES[RAHUL])[1]), /isn't one of your open tasks/);
    assert.equal(db.prepare(`SELECT status FROM pm_tasks WHERE id=12`).get().status, 'todo');
  });
  test('blocked button → asks reason → marks blocked and alerts the owner', async()=>{
    seed();
    openWindow(Object.values(PHONES), Date.now());
    await inbound(PHONES[RAHUL], {button:'ceo:blocked:11'});
    assert.match(textOf(sentTo(PHONES[RAHUL])[0]), /What's blocking/);
    await inbound(PHONES[RAHUL], {text:'Waiting for prices from finance'});
    assert.equal(db.prepare(`SELECT status FROM pm_tasks WHERE id=11`).get().status, 'blocked');
    assert.match(textOf(sentTo(PHONES[OWNER])[0]), /Rahul K is blocked on #11.*\n"Waiting for prices from finance"/);
  });
  test('delay needs owner approval; APPROVE moves the date and tells staff', async()=>{
    seed();
    openWindow(Object.values(PHONES), Date.now());
    await inbound(PHONES[RAHUL], {text:'delay 11 friday'});
    assert.equal(db.prepare(`SELECT due_date FROM pm_tasks WHERE id=11`).get().due_date, '2026-10-06');
    const act=db.prepare(`SELECT * FROM ceo_bot_actions`).get();
    assert.equal(act.status, 'pending');
    const ask=sentTo(PHONES[OWNER])[0];
    assert.match(textOf(ask), /Rahul K asks to move #11/);
    await inbound(PHONES[OWNER], {button:`ceoa:approve:${act.id}`});
    assert.equal(db.prepare(`SELECT due_date FROM pm_tasks WHERE id=11`).get().due_date, '2026-10-09');
    assert.equal(db.prepare(`SELECT status FROM ceo_bot_actions WHERE id=?`).get(act.id).status, 'executed');
    assert.match(sentTo(PHONES[RAHUL]).map(textOf).join('\n'), /now due 9 Oct/);
  });
  test('unknown numbers get one internal-only notice and nothing else', async()=>{
    seed();
    await inbound('14155550000', {text:'price?'});
    await inbound('14155550000', {text:'hello?'});
    assert.equal(sentTo('14155550000').length, 1);
    assert.match(textOf(sentTo('14155550000')[0]), /internal team number/);
    assert.equal(deps.log.ai.length, 0);
  });
  test('owner instruction via AI: suggest → pending; APPROVE executes and notifies the assignee', async()=>{
    seed();
    openWindow(Object.values(PHONES), Date.now());
    deps.aiQueue.push(JSON.stringify({reply:'Sure.', actions:[
      {type:'update_task', task_id:10, due_date:'2026-10-09'},
      {type:'update_task', task_id:12, assignee_email:'stranger@x.com'},
      {type:'create_task', title:'Fix footer', project_id:1, assignee_email:PRIYA, due_date:'2026-10-08'}]}));
    await inbound(PHONES[OWNER], {text:'move the banner to friday, give Priya a footer fix task'});
    const reply=textOf(sentTo(PHONES[OWNER])[0]);
    assert.match(reply, /Needs your OK/); assert.match(reply, /stranger@x.com is not on the team/);
    assert.match(deps.log.ai[0].user, /"id":10,"title":"Homepage banner"/);
    assert.doesNotMatch(deps.log.ai[0].user, /Archived thing/);
    const pend=db.prepare(`SELECT id FROM ceo_bot_actions WHERE status='pending' ORDER BY id`).all().map(r=>r.id);
    assert.equal(pend.length, 2);
    await inbound(PHONES[OWNER], {text:`APPROVE ${pend.join(',')}`});
    assert.equal(db.prepare(`SELECT due_date FROM pm_tasks WHERE id=10`).get().due_date, '2026-10-09');
    const created=db.prepare(`SELECT * FROM pm_tasks WHERE title='Fix footer'`).get();
    assert.equal(created.assignee_email, PRIYA); assert.equal(created.ai_created, 1);
    assert.match(sentTo(PHONES[PRIYA]).map(textOf).join('\n'), /New task for you, Priya: #\d+ "Fix footer"/);
  });
  test('autonomy auto_safe runs safe changes, holds reassignments; observe changes nothing', async()=>{
    seed({autonomy:'auto_safe'});
    deps.aiQueue.push(JSON.stringify({reply:'Done.', actions:[{type:'update_task', task_id:10, priority:'urgent'}, {type:'update_task', task_id:10, assignee_email:PRIYA}]}));
    await inbound(PHONES[OWNER], {text:'make the banner urgent and give it to Priya'});
    assert.equal(db.prepare(`SELECT priority, assignee_email FROM pm_tasks WHERE id=10`).get().priority, 'urgent');
    assert.equal(db.prepare(`SELECT assignee_email FROM pm_tasks WHERE id=10`).get().assignee_email, RAHUL);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ceo_bot_actions WHERE status='pending'`).get().n, 1);
    db.prepare(`UPDATE ceo_bot_settings SET config_json=?`).run(JSON.stringify(ceoNormalizeConfig({active:true, autonomy:'observe'})));
    deps.aiQueue.push(JSON.stringify({reply:'Ok', actions:[{type:'update_task', task_id:11, status:'done'}]}));
    await inbound(PHONES[OWNER], {text:'close 11'});
    assert.equal(db.prepare(`SELECT status FROM pm_tasks WHERE id=11`).get().status, 'todo');
    assert.match(sentTo(PHONES[OWNER]).map(textOf).join('\n'), /Observe mode/);
  });
  test('owner keywords: PAUSE stops the cron, BRIEF answers without AI', async()=>{
    seed();
    await inbound(PHONES[OWNER], {text:'pause'});
    assert.equal(JSON.parse(db.prepare(`SELECT config_json FROM ceo_bot_settings`).get().config_json).paused, true);
    assert.deepEqual(await ceoRunForClient(env, deps, CID, at('09:05')), {skipped:'inactive'});
    await inbound(PHONES[OWNER], {text:'brief'});
    assert.match(textOf(sentTo(PHONES[OWNER])[1]), /Open: 4/);
    assert.equal(deps.log.ai.length, 0);
  });
});

describe('console, chats and Team report', ()=>{
  test('web console chat, thread list and messages are owner-only', async()=>{
    seed();
    deps.aiQueue.push(JSON.stringify({reply:'Rahul has 3 open tasks.', actions:[]}));
    const r=await call('POST', '/ceo/chat', {body:{text:'how is rahul doing?'}});
    assert.equal(r.body.reply, 'Rahul has 3 open tasks.');
    await inbound(PHONES[RAHUL], {text:'DONE 10'});
    const th=(await call('GET', '/ceo/threads')).body.threads;
    assert.deepEqual(th.map(t=>t.name).sort(), ['Rahul K', 'Web console']);
    const msgs=(await call('GET', `/ceo/messages?phone=${PHONES[RAHUL]}`)).body.messages;
    assert.deepEqual(msgs.map(m=>m.direction), ['in','out']);
    assert.equal((await call('GET', `/ceo/messages?phone=${PHONES[RAHUL]}`, {auth:'staff'})).status, 403);
  });
  test('team report scorecard', async()=>{
    seed();
    await inbound(PHONES[RAHUL], {text:'DONE 11'});
    const ctx=await ceoBuildContext(env, deps, CLIENT, db.prepare(`SELECT * FROM ceo_bot_settings`).get(), at('12:00'));
    const sc=await ceoScorecard(env, ctx, 30);
    const rahul=sc.members.find(m=>m.email===RAHUL), priya=sc.members.find(m=>m.email===PRIYA);
    assert.equal(rahul.done, 1); assert.equal(rahul.overdue, 2); assert.equal(rahul.blocked, 1); assert.equal(rahul.bot_updates, 1);
    assert.equal(priya.done, 1); assert.equal(priya.on_time_pct, 100); assert.equal(priya.score, 100);
    assert.equal(sc.totals.done, 2);
    const api=await call('GET', '/ceo/team-report?days=7');
    assert.equal(api.status, 200); assert.equal(api.body.days, 7);
    assert.equal((await call('GET', '/ceo/team-report', {auth:'staff'})).status, 403);
  });
  test('manual run + actions inbox + decide via API', async()=>{
    seed();
    openWindow([PHONES[OWNER]], Date.now());
    const r=await call('POST', '/ceo/run', {body:{kind:'brief'}});
    assert.equal(r.body.ok, true); assert.match(r.body.text, /Good morning/);
    deps.aiQueue.push(JSON.stringify({reply:'Queued.', actions:[{type:'message_staff', email:PRIYA, text:'Please send the blog draft'}]}));
    await call('POST', '/ceo/chat', {body:{text:'ask priya for the blog draft'}});
    const pending=(await call('GET', '/ceo/actions?status=pending')).body.actions;
    assert.equal(pending.length, 1);
    const d=await call('POST', '/ceo/actions/decide', {body:{id:pending[0].id, decision:'reject'}});
    assert.match(d.body.message, /Rejected/);
    assert.equal((await call('POST', '/ceo/actions/decide', {body:{id:pending[0].id, decision:'approve'}})).status, 400);
  });
});
