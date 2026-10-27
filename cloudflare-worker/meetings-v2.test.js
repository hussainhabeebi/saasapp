// Meetings V2 (worker.js "Cal.com Meetings"): meetings a rep marks by hand from the lead ⋯ menu,
// the per-lead meeting state behind the badges / follow-up pause / bot prompt, sales-team points,
// and the rep's pre-meeting brief — against the real migrations through the same D1 shim as
// meetings.test.js, and the real router with a signed session.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, {
  mtgLeadState,
  mtgLeadStatesByLead,
  mtgBotPromptText,
  mtgRepPoints,
  mtgNormalizePoints,
  mtgBriefDue,
  mtgBriefText,
  mtgActiveLeadIds,
  runMeetingsForAllClients,
  MTG_DEFAULT_POINTS,
} from './worker.js';
import { fv3Decide } from './followup-v3.js';

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
function freshDb({v2=true}={}){
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('./migrations/0104_calcom_meetings.sql', import.meta.url), 'utf8'));
  if(v2){
    // The v2 columns come from mtgEnsureSchema at runtime (0119 only adds the index), so a "v2"
    // database here is one where that already happened.
    for(const [c, type] of [['source','TEXT'],['mode','TEXT'],['location','TEXT'],['scheduled_by','TEXT'],['notify','INTEGER'],['note','TEXT'],['brief_at','TEXT']])
      db.exec(`ALTER TABLE meetings ADD COLUMN ${c} ${type}`);
    db.exec(readFileSync(new URL('./migrations/0119_meetings_manual.sql', import.meta.url), 'utf8'));
  }
  return db;
}
async function token(secret, cid=7, email='rita@biz.com'){
  const body=btoa(JSON.stringify({cid:String(cid), email, exp:Math.floor(Date.now()/1000)+3600}));
  const key=await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const sig=await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `${body}.${btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}`;
}

const NOW=new Date('2026-10-20T10:00:00Z');
const iso=h=>new Date(NOW.getTime()+h*3600e3).toISOString();

describe('mtgLeadState', ()=>{
  test('no rows → null; an upcoming meeting is scheduled and active', ()=>{
    assert.equal(mtgLeadState([], NOW), null);
    const st=mtgLeadState([{id:1, status:'scheduled', start_at:iso(5), end_at:iso(6), title:'Demo', scheduled_by:'a@x'}], NOW);
    assert.equal(st.state, 'scheduled');
    assert.equal(st.active, true);
    assert.equal(st.owner, 'a@x');
  });
  test('agreed (time not fixed) is pending and active; a fresh link is pending but not active', ()=>{
    assert.deepEqual([mtgLeadState([{id:1, status:'agreed'}], NOW)].map(s=>[s.state, s.active]), [['pending', true]]);
    const link=mtgLeadState([{id:1, status:'link_sent', sent_at:iso(-5), token:'t'}], NOW);
    assert.equal(link.state, 'pending');
    assert.equal(link.link, true);
    assert.equal(link.active, false);
    assert.equal(mtgLeadState([{id:1, status:'link_sent', sent_at:iso(-24*20)}], NOW), null);
  });
  test('past without outcome → awaiting_outcome; no-show / cancelled → rebook; outcome → done', ()=>{
    assert.equal(mtgLeadState([{id:1, status:'completed', start_at:iso(-3), end_at:iso(-2)}], NOW).state, 'awaiting_outcome');
    assert.equal(mtgLeadState([{id:1, status:'completed', outcome:'no_show', outcome_at:iso(-2)}], NOW).state, 'rebook');
    assert.equal(mtgLeadState([{id:1, status:'cancelled', updated_at:iso(-2)}], NOW).state, 'rebook');
    assert.equal(mtgLeadState([{id:1, status:'completed', outcome:'interested', outcome_at:iso(-2)}], NOW).state, 'done');
  });
  test('a newer meeting decides: an old no-show with a new booking is scheduled', ()=>{
    const st=mtgLeadState([{id:1, status:'completed', outcome:'no_show', outcome_at:iso(-48)}, {id:2, status:'scheduled', start_at:iso(24), end_at:iso(25)}], NOW);
    assert.equal(st.state, 'scheduled');
    assert.equal(st.id, 2);
  });
  test('mtgLeadStatesByLead drops done leads', ()=>{
    const out=mtgLeadStatesByLead([
      {id:1, lead_id:5, status:'scheduled', start_at:iso(2), end_at:iso(3)},
      {id:2, lead_id:6, status:'completed', outcome:'interested', outcome_at:iso(-1)},
    ], NOW);
    assert.deepEqual(Object.keys(out), ['5']);
  });
});

test('mtgBotPromptText tells the bot not to ask for another meeting', ()=>{
  const sched=mtgBotPromptText({state:'scheduled', active:true, title:'Demo', start_at:'2026-10-21T09:30:00Z', join_url:'https://meet.x/1'}, 'Asia/Kolkata');
  assert.match(sched, /already has a Demo booked for/);
  assert.match(sched, /Do NOT ask them to schedule/);
  assert.match(sched, /meet\.x\/1/);
  assert.match(mtgBotPromptText({state:'pending', active:true, title:'meeting'}), /already agreed/);
  assert.equal(mtgBotPromptText({state:'pending', active:false, link:true}), '');
  assert.equal(mtgBotPromptText(null), '');
});

describe('mtgRepPoints', ()=>{
  const W=MTG_DEFAULT_POINTS;
  const since=NOW.getTime()-7*86400e3;
  test('booking is provisional until held; held + fast outcome + interested add up', ()=>{
    const r=mtgRepPoints([
      {id:1, lead_id:1, status:'scheduled', scheduled_by:'a@x', booked_at:iso(-10), start_at:iso(20), end_at:iso(21)},
      {id:2, lead_id:2, status:'completed', scheduled_by:'a@x', booked_at:iso(-48), start_at:iso(-24), end_at:iso(-23), outcome:'interested', outcome_at:iso(-22)},
    ], W, {since, now:NOW});
    assert.equal(r['a@x'].provisional, W.scheduled);
    assert.equal(r['a@x'].points, W.scheduled+W.held+W.outcome_fast+W.interested);
    assert.equal(r['a@x'].scheduled, 2);
    assert.equal(r['a@x'].held, 1);
  });
  test('events list every award with its date, for the Weekly Arena', ()=>{
    const events=[];
    mtgRepPoints([{id:2, lead_id:2, status:'completed', scheduled_by:'a@x', booked_at:iso(-48), start_at:iso(-24), end_at:iso(-23), outcome:'interested', outcome_at:iso(-22)}], W, {since, now:NOW, events});
    assert.deepEqual(events.map(e=>e.kind).sort(), ['mtg_booked','mtg_fast','mtg_held','mtg_interested']);
    assert.equal(events.find(e=>e.kind==='mtg_booked').ms, Date.parse(iso(-48)));
    assert.equal(events.reduce((s,e)=>s+e.pts,0), W.scheduled+W.held+W.outcome_fast+W.interested);
  });
  test('only one booking per lead counts; no-shows earn nothing; rebooking after a no-show earns the bonus', ()=>{
    const r=mtgRepPoints([
      {id:1, lead_id:1, status:'completed', sent_by:'b@x', booked_at:iso(-100), start_at:iso(-80), end_at:iso(-79), outcome:'no_show', outcome_at:iso(-78)},
      {id:2, lead_id:1, status:'scheduled', sent_by:'b@x', booked_at:iso(-30), start_at:iso(30), end_at:iso(31)},
      {id:3, lead_id:1, status:'scheduled', sent_by:'b@x', booked_at:iso(-20), start_at:iso(40), end_at:iso(41)},
    ], W, {since, now:NOW});
    assert.equal(r['b@x'].scheduled, 2);   // the no-show booking + one rebooking (the third is the same lead)
    assert.equal(r['b@x'].no_show, 1);
    assert.equal(r['b@x'].provisional, W.scheduled);
    assert.equal(r['b@x'].points, W.rebook);
  });
  test('an outcome left unlogged for 48h costs points; credit goes to scheduled_by over sent_by', ()=>{
    const r=mtgRepPoints([{id:1, lead_id:3, status:'completed', sent_by:'b@x', scheduled_by:'c@x', start_at:iso(-80), end_at:iso(-79)}], W, {since, now:NOW});
    assert.equal(r['c@x'].points, W.late_outcome);
    assert.equal(r['b@x'], undefined);
  });
  test('custom point values are clamped and keep defaults', ()=>{
    const p=mtgNormalizePoints({scheduled:'8', held:1000, rebook:''});
    assert.equal(p.scheduled, 8);
    assert.equal(p.held, 100);
    assert.equal(p.rebook, MTG_DEFAULT_POINTS.rebook);
  });
});

test('mtgBriefDue / mtgBriefText', ()=>{
  const row={status:'scheduled', start_at:iso(0.4), title:'Demo', lead_name:'Asha', phone:'919800000001', join_url:'https://meet.x/1'};
  assert.equal(mtgBriefDue(row, {rep_brief:true}, NOW), true);
  assert.equal(mtgBriefDue(row, {rep_brief:false}, NOW), false);
  assert.equal(mtgBriefDue({...row, brief_at:'x'}, {rep_brief:true}, NOW), false);
  assert.equal(mtgBriefDue({...row, start_at:iso(2)}, {rep_brief:true}, NOW), false);
  const text=mtgBriefText(row, {Stage:'qualified', Score:'Hot', QualAnswers:JSON.stringify({Budget:'5L'}), ConvHistory:JSON.stringify([{role:'user', content:'Can we talk pricing?'}])}, 'Asia/Kolkata', 'https://app/x?lead=1');
  assert.match(text, /Meeting in ~30 min: Demo with Asha/);
  assert.match(text, /Stage: qualified · Score: Hot/);
  assert.match(text, /Budget: 5L/);
  assert.match(text, /Can we talk pricing\?/);
  assert.match(text, /lead=1/);
});

test('Follow-up V3 holds a lead with a meeting', ()=>{
  const lead={Id:1, Stage:'contacted', LastCustomerMsgAt:new Date(Date.now()-3*3600e3).toISOString(), Date:new Date(Date.now()-86400e3).toISOString()};
  const d=fv3Decide({lead, steps:{1:{step:1, type:'session', message:'Hi', hours:1}}, hasMeeting:true});
  assert.equal(d.status, 'meeting');
  assert.equal(d.reason, 'meeting_booked');
  assert.notEqual(fv3Decide({lead, steps:{1:{step:1, type:'session', message:'Hi', hours:1}}}).status, 'meeting');
});

describe('routes', ()=>{
  let db, env, graphCalls, origFetch, session;
  const client={Id:7, wa_phone_id:'123', waba_id:'456', wa_token:'tok', authentik_email:'boss@biz.com', team_whatsapp:JSON.stringify({'rita@biz.com':'919811111111'}),
    bot_config:JSON.stringify({followup_quiet_hours_enabled:false, timezone:'Asia/Kolkata'})};
  const lead={Id:42, ClientId:7, Name:'Asha K', Phone:'+91 98765 43210', Email:'', Stage:'qualified'};
  const call=async (path, body, method=body?'POST':'GET')=>{
    const r=await worker.fetch(new Request('https://worker.test'+path, {method, headers:{Authorization:`Bearer ${session}`, 'Content-Type':'application/json'}, body:body?JSON.stringify(body):undefined}), env, {waitUntil(){}});
    return {status:r.status, data:await r.json().catch(()=>null)};
  };
  const row=id=>db.prepare(`SELECT * FROM meetings WHERE id=?`).get(id);
  beforeEach(async ()=>{
    db=freshDb(); graphCalls=[];
    env={DB:d1(db), SESSION_SIGNING_KEY:'s', NOCODB_BASE:'https://noco.test', NOCODB_TOKEN:'x', WORKER_BASE_URL:'https://w.test', ALLOWED_ORIGINS:'https://app.leadvyne.com'};
    session=await token('s');
    origFetch=globalThis.fetch;
    globalThis.fetch=async (url, init={})=>{
      const u=String(url);
      if(u.includes('/records/42')) return new Response(JSON.stringify(lead));
      if(u.includes('/records/7') || u.includes('(Id,eq,7)')) return new Response(JSON.stringify(u.includes('where=')?{list:[client]}:client));
      if(u.startsWith('https://noco.test/')) return new Response(JSON.stringify({list:[]}));
      if(u.startsWith('https://graph.facebook.com/')){ graphCalls.push({url:u, body:JSON.parse(init.body)}); return new Response(JSON.stringify({messages:[{id:'wamid'}]})); }
      throw new Error('unexpected fetch '+u);
    };
  });
  afterEach(()=>{ globalThis.fetch=origFetch; db.close(); });

  test('mark scheduled → confirmation; a second mark is refused; reschedule resets reminders', async ()=>{
    const start=new Date(Date.now()+2*86400e3).toISOString();
    const a=await call('/meetings/manual', {lead_id:42, start_at:start, duration_min:45, title:'Site visit', mode:'in_person', location:'MG Road office', notify:true});
    assert.equal(a.status, 200, JSON.stringify(a.data));
    assert.equal(a.data.state.state, 'scheduled');
    assert.equal(a.data.notified, true);
    const r=row(a.data.id);
    assert.equal(r.source, 'manual');
    assert.equal(r.scheduled_by, 'rita@biz.com');
    assert.equal(r.phone, '919876543210');
    assert.ok(r.booked_at && r.confirm_at);
    assert.equal(Date.parse(r.end_at)-Date.parse(r.start_at), 45*60e3);
    assert.match(graphCalls[0].body.text.body, /Site visit is confirmed/);
    assert.match(graphCalls[0].body.text.body, /Where: MG Road office/);

    const dup=await call('/meetings/manual', {lead_id:42, start_at:start});
    assert.equal(dup.status, 409);
    assert.equal(dup.data.code, 'MEETING_EXISTS');

    db.prepare(`UPDATE meetings SET remind24_at='x' WHERE id=?`).run(a.data.id);
    const moved=new Date(Date.now()+3*86400e3).toISOString();
    const b=await call('/meetings/manual', {id:a.data.id, lead_id:42, start_at:moved, title:'Site visit', mode:'in_person', location:'MG Road office', notify:true});
    assert.equal(b.status, 200);
    assert.equal(row(a.data.id).remind24_at, null);
    assert.match(graphCalls[1].body.text.body, /moved to/);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM meetings`).get().n, 1);
  });

  test('pending (agreed) then time fixed updates the same row; notify off sends nothing', async ()=>{
    const a=await call('/meetings/manual', {lead_id:42, status:'agreed', title:'Demo'});
    assert.equal(a.status, 200);
    assert.equal(a.data.state.state, 'pending');
    assert.equal(row(a.data.id).booked_at, null);
    const b=await call('/meetings/manual', {lead_id:42, start_at:new Date(Date.now()+86400e3).toISOString(), title:'Demo', notify:false});
    assert.equal(b.status, 200);
    assert.equal(b.data.id, a.data.id);
    assert.equal(row(a.data.id).status, 'scheduled');
    assert.equal(row(a.data.id).notify, 0);
    assert.equal(graphCalls.length, 0);
  });

  test('a booking link to a lead with a fixed meeting needs force', async ()=>{
    db.prepare(`INSERT INTO meetings_config (client_id, links_json, settings_json, created_at, updated_at) VALUES (7,?, '{}', 'x','x')`).run(JSON.stringify([{name:'Intro', url:'https://cal.com/a/intro'}]));
    await call('/meetings/manual', {lead_id:42, start_at:new Date(Date.now()+86400e3).toISOString(), notify:false});
    const r=await call('/meetings/send', {lead_id:42, send:false});
    assert.equal(r.status, 409);
    assert.equal((await call('/meetings/send', {lead_id:42, send:false, force:true})).status, 200);
  });

  test('lead states, history, cancel and points', async ()=>{
    const a=await call('/meetings/manual', {lead_id:42, start_at:new Date(Date.now()+86400e3).toISOString(), notify:false});
    const st=await call('/meetings/lead-states');
    assert.equal(st.data.states['42'].state, 'scheduled');
    assert.deepEqual([...(await mtgActiveLeadIds(env, 7))], [42]);
    const hist=await call('/meetings/lead?lead_id=42');
    assert.equal(hist.data.meetings.length, 1);
    const pts=await call('/meetings/points?days=7');
    assert.equal(pts.data.reps['rita@biz.com'].provisional, MTG_DEFAULT_POINTS.scheduled);
    assert.deepEqual(pts.data.events, []);   // nothing confirmed until the meeting is held
    assert.equal((await call('/meetings/cancel', {id:a.data.id})).status, 200);
    assert.equal((await call('/meetings/lead-states')).data.states['42'].state, 'rebook');
    assert.deepEqual([...(await mtgActiveLeadIds(env, 7))], []);
  });

  test('manual meetings get reminders without Cal.com set up; the rep brief goes to the rep', async ()=>{
    const now=new Date();
    db.prepare(`INSERT INTO meetings_config (client_id, links_json, settings_json, created_at, updated_at) VALUES (7,'[]',?, 'x','x')`).run(JSON.stringify({rep_brief:true}));
    const ins=(start, notify)=>db.prepare(`INSERT INTO meetings (client_id, lead_id, lead_name, phone, status, start_at, end_at, booked_at, source, scheduled_by, notify, created_at, updated_at) VALUES (7,42,'Asha','919876543210','scheduled',?,?,?,'manual','rita@biz.com',?,'x','x')`)
      .run(start, new Date(Date.parse(start)+30*60e3).toISOString(), '2026-01-01T00:00:00Z', notify);
    ins(new Date(now.getTime()+20*60e3).toISOString(), 1);
    ins(new Date(now.getTime()+50*60e3).toISOString(), 0);
    await runMeetingsForAllClients(env, now);
    const toLead=graphCalls.filter(c=>c.body.to==='919876543210');
    const toRep=graphCalls.filter(c=>c.body.to==='919811111111');
    assert.equal(toLead.length, 1);            // 1h reminder only for the notify=1 meeting
    assert.match(toLead[0].body.text.body, /starts in about an hour/);
    assert.equal(toRep.length, 1);              // brief for the one starting in 20 min
    assert.match(toRep[0].body.text.body, /Meeting in ~30 min/);
    await runMeetingsForAllClients(env, now);
    assert.equal(graphCalls.length, 2);
  });

  test('works on a database without migration 0119 (columns added lazily)', async ()=>{
    db.close(); db=freshDb({v2:false}); env.DB=d1(db);
    const a=await call('/meetings/manual', {lead_id:42, status:'agreed'});
    assert.equal(a.status, 200);
    assert.equal(row(a.data.id).source, 'manual');
  });
});
