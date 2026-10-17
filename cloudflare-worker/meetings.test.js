// Cal.com Meetings module (Integrations → 📞 Cal.com Meetings) — payload parsing, reminder/nudge
// timing, and the webhook + cron paths end to end against the real migration (node:sqlite through
// the same tiny D1 shim monthly-marketing.test.js uses).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import {
  mtgNormalizeLinks,
  mtgNormalizeSettings,
  mtgBuildBookingUrl,
  mtgParseCalcomPayload,
  mtgStatusForTrigger,
  mtgReminderDue,
  mtgNudgeDue,
  mtgSummarize,
  handleCalcomMeetingsWebhook,
  handleMeetingLinkRedirect,
  runMeetingsForAllClients,
} from './worker.js';

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
  db.exec(readFileSync(new URL('./migrations/0104_calcom_meetings.sql', import.meta.url), 'utf8'));
  return db;
}
const SETTINGS={confirm:true, remind24:true, remind1:true, nudge:true, cancel_followup:true};

describe('config normalisation', ()=>{
  test('links must be https URLs, names default, capped', ()=>{
    const out=mtgNormalizeLinks([{name:'Intro', url:'https://cal.com/a/intro'}, {url:'http://cal.com/x'}, {name:'', url:'https://cal.com/a/demo'}, {url:'javascript:alert(1)'}]);
    assert.deepEqual(out, [{name:'Intro', url:'https://cal.com/a/intro'}, {name:'Meeting', url:'https://cal.com/a/demo'}]);
  });
  test('settings keep defaults and sanitise the template name', ()=>{
    const s=mtgNormalizeSettings({remind24:false, template_name:'meeting reminder!'});
    assert.equal(s.remind24, false);
    assert.equal(s.confirm, true);
    assert.equal(s.template_name, 'meetingreminder');
  });
});

describe('mtgBuildBookingUrl', ()=>{
  test('prefills the form and tags the booking with lead + meeting ids', ()=>{
    const u=new URL(mtgBuildBookingUrl('https://cal.com/acme/intro?month=2026-09', {name:'Asha K', email:'a@x.com', phone:'91 98765 43210', leadId:42, mtgId:9}));
    assert.equal(u.searchParams.get('month'), '2026-09');
    assert.equal(u.searchParams.get('name'), 'Asha K');
    assert.equal(u.searchParams.get('attendeePhoneNumber'), '+919876543210');
    assert.equal(u.searchParams.get('metadata[lead_id]'), '42');
    assert.equal(u.searchParams.get('metadata[mtg_id]'), '9');
  });
});

describe('mtgParseCalcomPayload', ()=>{
  test('reads attendee, times, metadata and the video link', ()=>{
    const p=mtgParseCalcomPayload({triggerEvent:'BOOKING_CREATED', payload:{uid:'u1', title:'Intro between A and B', eventTitle:'Intro call',
      startTime:'2026-09-30T09:30:00Z', endTime:'2026-09-30T10:00:00Z', attendees:[{name:'Asha', email:'ASHA@X.COM'}],
      responses:{attendeePhoneNumber:{value:'+91 98765 43210'}}, metadata:{lead_id:'42', videoCallUrl:'https://meet.google.com/abc'}}});
    assert.equal(p.uid, 'u1');
    assert.equal(p.title, 'Intro call');
    assert.equal(p.email, 'asha@x.com');
    assert.equal(p.phone, '919876543210');
    assert.equal(p.leadId, 42);
    assert.equal(p.joinUrl, 'https://meet.google.com/abc');
  });
  test('reschedule carries the old uid; unknown triggers map to no status', ()=>{
    assert.equal(mtgParseCalcomPayload({triggerEvent:'BOOKING_RESCHEDULED', payload:{uid:'new', rescheduleUid:'old'}}).oldUid, 'old');
    assert.equal(mtgStatusForTrigger('BOOKING_REJECTED'), 'cancelled');
    assert.equal(mtgStatusForTrigger('BOOKING_PAID'), null);
  });
});

describe('reminder and nudge timing', ()=>{
  const now=new Date('2026-09-24T10:00:00Z');
  const row=o=>({status:'scheduled', booked_at:'2026-09-20T10:00:00Z', ...o});
  test('24h reminder inside the last day, 1h reminder inside the last 75 minutes', ()=>{
    assert.equal(mtgReminderDue(row({start_at:'2026-09-25T08:00:00Z'}), SETTINGS, now), 'remind24');
    assert.equal(mtgReminderDue(row({start_at:'2026-09-24T11:00:00Z'}), SETTINGS, now), 'remind1');
    assert.equal(mtgReminderDue(row({start_at:'2026-09-26T08:00:00Z'}), SETTINGS, now), null);
  });
  test('no 24h reminder for a meeting booked less than a day ahead, or already reminded', ()=>{
    assert.equal(mtgReminderDue(row({start_at:'2026-09-25T08:00:00Z', booked_at:'2026-09-24T09:00:00Z'}), SETTINGS, now), null);
    assert.equal(mtgReminderDue(row({start_at:'2026-09-25T08:00:00Z', remind24_at:'x'}), SETTINGS, now), null);
    assert.equal(mtgReminderDue(row({start_at:'2026-09-25T08:00:00Z'}), {...SETTINGS, remind24:false}, now), null);
  });
  test('nudge only between 24h and 72h after an unbooked link', ()=>{
    const r=o=>({status:'link_sent', phone:'91900', ...o});
    assert.equal(mtgNudgeDue(r({sent_at:'2026-09-23T09:00:00Z'}), SETTINGS, now), true);
    assert.equal(mtgNudgeDue(r({sent_at:'2026-09-24T01:00:00Z'}), SETTINGS, now), false);
    assert.equal(mtgNudgeDue(r({sent_at:'2026-09-20T09:00:00Z'}), SETTINGS, now), false);
    assert.equal(mtgNudgeDue(r({sent_at:'2026-09-23T09:00:00Z', status:'scheduled'}), SETTINGS, now), false);
  });
});

test('mtgSummarize counts the funnel and per-rep numbers', ()=>{
  const s=mtgSummarize([
    {sent_at:'x', clicked_at:'x', booked_at:'x', status:'completed', outcome:'interested', sent_by:'a@x'},
    {sent_at:'x', status:'link_sent', sent_by:'a@x'},
    {booked_at:'x', status:'completed', outcome:'no_show'},
    {booked_at:'x', status:'scheduled', start_at:'2026-09-26T10:00:00Z'},
  ], new Date('2026-09-24T10:00:00Z'));
  assert.deepEqual({sent:s.sent, clicked:s.clicked, booked:s.booked, attended:s.attended, no_show:s.no_show, converted:s.converted, this_week:s.this_week},
    {sent:2, clicked:1, booked:3, attended:1, no_show:1, converted:1, this_week:1});
  assert.deepEqual(s.reps['a@x'], {sent:2, booked:1, attended:1, no_show:0});
});

describe('webhook + cron end to end', ()=>{
  let db, env, graphCalls, origFetch;
  const SECRET='s3cret';
  const client={Id:7, wa_phone_id:'123', waba_id:'456', wa_token:'tok', bot_config:JSON.stringify({followup_quiet_hours_enabled:false, timezone:'Asia/Kolkata'})};
  const lead={Id:42, ClientId:7, Name:'Asha K', Phone:'+91 98765 43210', Email:''};
  const hook=async body=>{
    const raw=JSON.stringify(body);
    const sig=createHmac('sha256', SECRET).update(raw).digest('hex');
    const res=await handleCalcomMeetingsWebhook(new Request('https://w.test/calcom/meetings/7', {method:'POST', body:raw, headers:{'X-Cal-Signature-256':sig}}), env, '7');
    return res.json();
  };
  const row=id=>db.prepare(`SELECT * FROM meetings WHERE id=?`).get(id);
  beforeEach(()=>{
    db=freshDb(); graphCalls=[];
    env={DB:d1(db), NOCODB_BASE:'https://noco.test', NOCODB_TOKEN:'x', WORKER_BASE_URL:'https://w.test'};
    const now=new Date().toISOString();
    db.prepare(`INSERT INTO meetings_config (client_id, links_json, webhook_secret, settings_json, created_at, updated_at) VALUES (7,?,?,?,?,?)`)
      .run(JSON.stringify([{name:'Intro call', url:'https://cal.com/acme/intro'}]), SECRET, JSON.stringify(SETTINGS), now, now);
    origFetch=globalThis.fetch;
    globalThis.fetch=async (url, init={})=>{
      const u=String(url);
      if(u.includes('/records/7')) return new Response(JSON.stringify(client));
      if(u.includes('/records/42')) return new Response(JSON.stringify(lead));
      if(u.startsWith('https://noco.test/api/v2/tables/')) return new Response(JSON.stringify({list:u.includes('98765')||u.includes('876543210')?[lead]:[]}));
      if(u.startsWith('https://graph.facebook.com/')){ graphCalls.push(JSON.parse(init.body)); return new Response(JSON.stringify({messages:[{id:'wamid'}]})); }
      throw new Error('unexpected fetch '+u);
    };
  });
  afterEach(()=>{ globalThis.fetch=origFetch; db.close(); });

  test('rejects a bad signature and records a PING', async ()=>{
    const bad=await handleCalcomMeetingsWebhook(new Request('https://w.test/x', {method:'POST', body:'{}', headers:{'X-Cal-Signature-256':'nope'}}), env, '7');
    assert.equal(bad.status, 401);
    await hook({triggerEvent:'PING', payload:{}});
    assert.equal(db.prepare(`SELECT last_event_type FROM meetings_config`).get().last_event_type, 'PING');
  });

  test('tracked link → click → booking → confirmation → reschedule → cancel', async ()=>{
    const now=new Date().toISOString();
    db.prepare(`INSERT INTO meetings (client_id, token, lead_id, lead_name, phone, link_name, link_url, sent_at, status, created_at, updated_at) VALUES (7,'tok12345abc',42,'Asha K','919876543210','Intro call','https://cal.com/acme/intro',?,'link_sent',?,?)`).run(now, now, now);
    const redirect=await handleMeetingLinkRedirect(new Request('https://w.test/m/tok12345abc'), env, 'tok12345abc');
    assert.equal(redirect.status, 302);
    assert.equal(new URL(redirect.headers.get('Location')).searchParams.get('metadata[mtg_id]'), '1');
    assert.equal(row(1).status, 'clicked');

    const start=new Date(Date.now()+3*86400e3).toISOString();
    await hook({triggerEvent:'BOOKING_CREATED', payload:{uid:'u1', eventTitle:'Intro call', startTime:start, endTime:start, attendees:[{name:'Asha'}], metadata:{mtg_id:'1', lead_id:'42', videoCallUrl:'https://meet.google.com/abc'}}});
    assert.equal(row(1).status, 'scheduled');
    assert.equal(row(1).calcom_uid, 'u1');
    assert.ok(row(1).confirm_at);
    assert.equal(graphCalls.length, 1);
    assert.match(graphCalls[0].text.body, /confirmed/);
    assert.match(graphCalls[0].text.body, /meet\.google\.com\/abc/);

    // Duplicate delivery of the same event doesn't re-send the confirmation.
    await hook({triggerEvent:'BOOKING_CREATED', payload:{uid:'u1', startTime:start, metadata:{mtg_id:'1'}}});
    assert.equal(graphCalls.length, 1);

    const moved=new Date(Date.now()+4*86400e3).toISOString();
    await hook({triggerEvent:'BOOKING_RESCHEDULED', payload:{uid:'u2', rescheduleUid:'u1', startTime:moved, endTime:moved}});
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM meetings`).get().n, 1);
    assert.equal(row(1).calcom_uid, 'u2');
    assert.equal(row(1).start_at, moved);
    assert.match(graphCalls[1].text.body, /moved/);

    await hook({triggerEvent:'BOOKING_CANCELLED', payload:{uid:'u2', startTime:moved}});
    assert.equal(row(1).status, 'cancelled');
    assert.match(graphCalls[2].text.body, /another time\? https:\/\/w\.test\/m\/tok12345abc/);
  });

  test('a booking without a tracked link is matched to the lead by phone', async ()=>{
    const start=new Date(Date.now()+3*86400e3).toISOString();
    await hook({triggerEvent:'BOOKING_CREATED', payload:{uid:'u9', startTime:start, attendees:[{name:'Asha', phoneNumber:'+91 98765 43210'}]}});
    const r=row(1);
    assert.equal(r.lead_id, 42);
    assert.equal(r.status, 'scheduled');
    // Cancelling an unknown booking is ignored, not inserted.
    await hook({triggerEvent:'BOOKING_CANCELLED', payload:{uid:'nope'}});
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM meetings`).get().n, 1);
  });

  test('cron sends each reminder once, nudges unbooked links, and auto-completes past meetings', async ()=>{
    const now=new Date('2026-09-24T10:00:00Z');
    const ins=(o)=>db.prepare(`INSERT INTO meetings (client_id, lead_name, phone, token, link_name, link_url, status, start_at, end_at, booked_at, sent_at, created_at, updated_at) VALUES (7,'Asha','919876543210',?,?,?,?,?,?,?,?,?,?)`)
      .run(o.token||null, 'Intro call', 'https://cal.com/acme/intro', o.status, o.start_at||null, o.end_at||null, o.booked_at||null, o.sent_at||null, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');
    ins({status:'scheduled', start_at:'2026-09-25T08:00:00Z', end_at:'2026-09-25T08:30:00Z', booked_at:'2026-09-20T00:00:00Z'}); // 24h reminder
    ins({status:'scheduled', start_at:'2026-09-24T10:45:00Z', end_at:'2026-09-24T11:15:00Z', booked_at:'2026-09-20T00:00:00Z'}); // 1h reminder
    ins({status:'link_sent', token:'nudgetok1', sent_at:'2026-09-23T06:00:00Z'});                                             // nudge
    ins({status:'scheduled', start_at:'2026-09-24T08:00:00Z', end_at:'2026-09-24T08:30:00Z', booked_at:'2026-09-20T00:00:00Z'}); // past → completed
    await runMeetingsForAllClients(env, now);
    assert.equal(graphCalls.length, 3);
    assert.ok(row(1).remind24_at && row(2).remind1_at && row(3).nudge_at);
    assert.match(graphCalls.find(c=>/pick a time/.test(c.text.body)).text.body, /https:\/\/w\.test\/m\/nudgetok1/);
    assert.equal(row(4).status, 'completed');
    await runMeetingsForAllClients(env, now);
    assert.equal(graphCalls.length, 3);
  });
});
