// Hospitality Pro Suite (hospitality-suite.js) — config defaults (everything off), pure helpers
// (iCal, pricing, summary, ID masking), the WhatsApp flows, the cron jobs and the dashboard API,
// end to end against the real hospitality + Pro + suite migrations on node:sqlite. deps are
// recorded fakes, so nothing leaves the box.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  hsNormalizeConfig, hsOn, hsAnyOn, HS_FEATURES, hsIcalParse, hsIcalExport, hsSuggestPrices, hsOccupancyMap, hsSummaryText,
  hsParseTime, hsMaskId, hsFlatten, hsMonthDay, hsCruisePlan, hsHandleTurn, hsRunForClient, hsHandleRoute, hsGetState,
  hsBalancePaid, hsIcalExportRoute, hsMoneyOf,
} from './hospitality-suite.js';

function d1(db){
  return {prepare(sql){
    let args=[];
    const st={
      bind(...a){ args=a.map(v=>v===undefined?null:v); return st; },
      async run(){ const r=db.prepare(sql).run(...args); return {meta:{changes:Number(r.changes), last_row_id:Number(r.lastInsertRowid)}}; },
      async all(){ return {results:db.prepare(sql).all(...args)}; },
      async first(){ return db.prepare(sql).get(...args)||null; },
    };
    return st;
  }};
}
const MIGRATIONS=['0009_hospitality.sql','0010_hospitality_media.sql','0066_resort_properties.sql','0067_hospitality_units_resort_fields.sql',
  '0092_hospitality_property_location.sql','0109_hospitality_pro.sql','0123_hospitality_suite.sql'];
function freshDb(){
  const db=new DatabaseSync(':memory:');
  for(const f of MIGRATIONS) db.exec(readFileSync(new URL(`./migrations/${f}`, import.meta.url), 'utf8'));
  return db;
}

const TODAY='2026-10-03'; // Saturday
const NOON_IST=Date.parse('2026-10-03T06:30:00Z'); // 12:00 IST
const CID=7;
const PRO_CLIENT={Id:CID, client_name:'Lake Resort', hospitality_enabled:'Yes', hospitality_pro_enabled:'Yes', hospitality_style:'houseboat'};

function fakeDeps(client=PRO_CLIENT){
  const log={texts:[], buttons:[], notes:[], templates:[], fetches:[]};
  const deps={
    log,
    json:(data, status)=>new Response(JSON.stringify(data), {status:status||200, headers:{'Content-Type':'application/json'}}),
    requireSession:async(req)=>req.headers.get('Authorization')==='Bearer ok'?{cid:CID}:null,
    getClientById:async()=>client,
    reportOpsError:async(env, where, e)=>{ throw e; },
    sendText:async(env, c, cid, convId, text)=>{ log.texts.push({convId, text}); return true; },
    sendButtons:async(env, c, cid, convId, text, items)=>{ log.buttons.push({convId, text, items}); return items; },
    sendPrivateNote:async(c, convId, text)=>{ log.notes.push({convId, text}); },
    localize:async(env, c, text)=>text,
    findConversation:async()=>'conv-found',
    sendTemplate:async(env, c, phone, name, lang, params)=>{ log.templates.push({phone, name, params}); },
    readIdImage:async()=>({name:'Anu Thomas', id_type:'Aadhaar', id_number:'1234 5678 9012', dob:'1990-01-01', nationality:'Indian'}),
    aiText:async()=>'Thank you so much for staying with us! — Team Lake Resort',
    razorpayLink:async()=>({url:'https://rzp.io/l/bal', id:'plink_1'}),
    now:()=>NOON_IST,
    fetch:async(u)=>{ log.fetches.push(u); return deps._fetch(u); },
    _fetch:async()=>new Response('', {status:404}),
  };
  return deps;
}
function seed(db){
  const now='2026-01-01T00:00:00Z';
  db.prepare(`INSERT INTO hospitality_units (id, client_id, name, unit_type, capacity_adults, capacity_children, base_rate, weekend_rate, currency, active, created_at) VALUES (1, ?, 'Kayal Queen', 'Houseboat', 4, 2, 8000, 9000, 'INR', 1, ?)`).run(CID, now);
  db.prepare(`INSERT INTO hospitality_units (id, client_id, name, unit_type, capacity_adults, capacity_children, base_rate, weekend_rate, currency, active, created_at) VALUES (2, ?, 'Royal Palace', 'Houseboat', 6, 2, 14000, NULL, 'INR', 1, ?)`).run(CID, now);
}
function enable(db, features, extra={}){
  db.prepare(`INSERT INTO hosp_suite_settings (client_id, config_json, updated_at) VALUES (?,?,?) ON CONFLICT(client_id) DO UPDATE SET config_json=excluded.config_json`)
    .run(CID, JSON.stringify({features:Object.fromEntries(features.map(f=>[f, true])), ...extra}), 'now');
}
function booking(db, o){
  const r=db.prepare(`INSERT INTO hospitality_bookings (client_id, unit_id, lead_id, guest_name, guest_phone, check_in, check_out, nights, adults, children, rate_per_night, total_amount, deposit_amount, currency, status, notes, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'INR',?,'',?)`).run(CID, o.unit||1, o.lead??100, o.name||'Anu Thomas', o.phone||'+91 98470 00707', o.ci, o.co, o.nights||1, o.adults||2, 0, 8000, o.total??10000, o.deposit??2500, o.status||'confirmed', 'now');
  return Number(r.lastInsertRowid);
}
function contact(db, leadId, phone, at){
  db.prepare(`INSERT INTO hosp_suite_contacts (client_id, lead_id, phone_key, conv_id, last_inbound_at) VALUES (?,?,?,?,?)`).run(CID, leadId, phone.replace(/\D/g,'').slice(-10), 'conv-'+leadId, at);
}
const turn=(env, deps, text, extra={})=>hsHandleTurn(env, deps, {c:PRO_CLIENT, clientId:String(CID), convId:'conv-100', leadId:100, phone:'+919847000707', name:'Anu Thomas', userText:text, rawText:text, nowMs:NOON_IST, ...extra});
function req(method, path, body, auth='Bearer ok'){
  return [new Request(`https://w.test${path}`, {method, headers:{Authorization:auth, 'Content-Type':'application/json'}, body:body?JSON.stringify(body):undefined}), new URL(`https://w.test${path}`)];
}
async function call(env, deps, method, path, body){
  const [r, u]=req(method, path, body);
  const res=await hsHandleRoute(r, env, deps, u);
  return {status:res.status, data:await res.json()};
}

describe('config', ()=>{
  test('every feature is OFF by default — nothing changes for an existing client', ()=>{
    const cfg=hsNormalizeConfig({});
    assert.equal(HS_FEATURES.length, 30);
    assert.ok(HS_FEATURES.every(k=>cfg.features[k]===false));
    assert.equal(hsAnyOn(cfg), false);
    assert.equal(hsNormalizeConfig('not json').features.fleet, false);
  });
  test('a feature that builds on another needs that one on too', ()=>{
    const cfg=hsNormalizeConfig({features:{agent_quotes:true, id_scan:true}});
    assert.equal(hsOn(cfg, 'agent_quotes'), false);
    assert.equal(hsOn(cfg, 'id_scan'), false);
    cfg.features.agents=true; cfg.features.web_checkin=true;
    assert.equal(hsOn(cfg, 'agent_quotes'), true);
    assert.equal(hsOn(cfg, 'id_scan'), true);
  });
  test('values are clamped and the template name sanitised', ()=>{
    const cfg=hsNormalizeConfig({balance_days:[1, 7, 7, 99], template_name:'Hosp Update!', upsell_days:0, google_review_url:'javascript:alert(1)'});
    assert.deepEqual(cfg.balance_days, [7, 1]);
    assert.equal(cfg.template_name, 'hospupdate');
    assert.equal(cfg.upsell_days, 1);
    assert.equal(cfg.google_review_url, '');
  });
});

describe('pure helpers', ()=>{
  test('iCal parse: folded lines, DATE and DATE-TIME, cancelled events skipped, past nights dropped', ()=>{
    const ics=['BEGIN:VCALENDAR','BEGIN:VEVENT','DTSTART;VALUE=DATE:20261005','DTEND;VALUE=DATE:20261008','SUMMARY:Reserved','END:VEVENT',
      'BEGIN:VEVENT','DTSTART:20261001T140000Z','DTEND:20261004T100000Z','END:VEVENT',
      'BEGIN:VEVENT','DTSTART;VALUE=DATE:20261020','DTEND;VALUE=DATE:20261021','STATUS:CANCELLED','END:VEVENT','END:VCALENDAR'].join('\r\n');
    const r=hsIcalParse(ics, TODAY);
    assert.deepEqual(r.dates, ['2026-10-03','2026-10-05','2026-10-06','2026-10-07']);
    assert.equal(r.events, 2);
  });
  test('iCal export: bookings plus merged runs of blocked dates, no guest names', ()=>{
    const out=hsIcalExport({unit:{id:1, name:'Kayal Queen'}, bookings:[{id:9, check_in:'2026-10-05', check_out:'2026-10-07', guest_name:'Secret'}],
      blockedDates:['2026-10-10','2026-10-11','2026-10-13'], nowIso:'2026-10-03T00:00:00.000Z'});
    assert.match(out, /DTSTART;VALUE=DATE:20261005\r\nDTEND;VALUE=DATE:20261007/);
    assert.match(out, /DTSTART;VALUE=DATE:20261010\r\nDTEND;VALUE=DATE:20261012/);
    assert.match(out, /DTSTART;VALUE=DATE:20261013\r\nDTEND;VALUE=DATE:20261014/);
    assert.doesNotMatch(out, /Secret/);
    assert.deepEqual(hsIcalParse(out, TODAY).dates, ['2026-10-05','2026-10-06','2026-10-10','2026-10-11','2026-10-13']);
  });
  test('pricing: rules add up, overrides are never suggested away without a rule', ()=>{
    const units=[{id:1, base_rate:8000, weekend_rate:9000}];
    const rules=[{kind:'weekend', name:'Weekend', pct:10}, {kind:'event', name:'Boat race', start_date:'2026-10-09', end_date:'2026-10-09', pct:30},
      {kind:'last_minute', name:'Last minute', pct:-15, days:1, threshold:50}];
    const list=hsSuggestPrices({units, rules, overrides:{1:{'2026-10-06':7000}}, occupancy:{'2026-10-03':100}, today:TODAY, days:7});
    const by=Object.fromEntries(list.map(s=>[s.date, s]));
    assert.equal(by['2026-10-03'].suggested_rate, 9900); // Sat: weekend rate 9000 +10% (full, so no last-minute cut)
    assert.equal(by['2026-10-04'].suggested_rate, 7650); // Sun: 9000 −15% last minute (Sun isn't a Fri/Sat night)
    assert.equal(by['2026-10-09'].suggested_rate, 11200); // Fri: 8000 +10% +30%
    assert.equal(by['2026-10-06'], undefined); // manual override, no rule → left alone
    assert.match(by['2026-10-09'].reason, /Boat race \+30%/);
  });
  test('occupancy map counts booked nights per date', ()=>{
    const m=hsOccupancyMap([{check_in:'2026-10-02', check_out:'2026-10-05'}], 2, TODAY, 3);
    assert.deepEqual(m, {'2026-10-03':50, '2026-10-04':50, '2026-10-05':0});
  });
  test('summary text gives a plain-language nudge', ()=>{
    const t=hsSummaryText({today:TODAY, name:'Lake Resort', arrivals:2, departures:1, inHouse:3, occNext7:30, occPrev7:42, revenueMtd:120000, balanceDue:5000, openTasks:1, openAlerts:0, pendingSugg:4, lowRatings:0});
    assert.match(t, /Next 7 days: 30% booked \(down 12 pts vs last 7 days\)/);
    assert.match(t, /consider a weekday offer/);
    assert.match(t, /₹1,20,000/);
    assert.match(t, /4 price suggestions/);
  });
  test('time, ID masking, template flattening, month-day', ()=>{
    assert.equal(hsParseTime('around 3'), '15:00');
    assert.equal(hsParseTime('11:30 am'), '11:30');
    assert.equal(hsParseTime('12 pm'), '12:00');
    assert.equal(hsParseTime('no idea'), null);
    assert.deepEqual(hsMaskId({name:'A', id_type:'Aadhaar', id_number:'1234 5678 9012'}), {name:'A', id_type:'Aadhaar', id_number:'XXXX XXXX 9012'});
    assert.equal(hsMaskId({id_type:'Passport', id_number:'Z1234567'}).id_number, 'Z1234567');
    assert.equal(hsFlatten('*Hi*\n\nLine two'), 'Hi · Line two');
    assert.equal(hsMonthDay('1990-03-07'), '03-07');
    assert.equal(hsMonthDay('7/3'), '03-07');
    assert.equal(hsMonthDay('13-40'), '');
  });
  test('cruise plan follows the jetty windows', ()=>{
    const p=hsCruisePlan({trip_type:'overnight'}, {boarding_time:'11:30', cruise_start:'12:00', cruise_end:'17:30', checkout_time:'09:00'});
    assert.equal(p[0].at, '11:30');
    assert.ok(p.some(s=>s.what==='Anchor for the night' && s.at==='17:30'));
  });
  test('money: extras add to the total, deposit counts once', ()=>{
    const m=hsMoneyOf({total_amount:10000, deposit_amount:2500, currency:'INR'}, [{kind:'balance', amount:3000, status:'paid'}], [{amount:1500}]);
    assert.deepEqual([m.total, m.received, m.balance], [11500, 5500, 6000]);
  });
});

describe('WhatsApp turn', ()=>{
  let db, env, deps;
  beforeEach(()=>{ db=freshDb(); env={DB:d1(db)}; deps=fakeDeps(); seed(db); });

  test('with no suite feature on, the turn is untouched and nothing is written', async()=>{
    const r=await turn(env, deps, 'towels please');
    assert.equal(r.handled, false);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM hosp_suite_contacts`).get().n, 0);
  });
  test('non-Pro client: never handled even with features on', async()=>{
    enable(db, ['instay_requests']);
    const r=await hsHandleTurn(env, deps, {c:{...PRO_CLIENT, hospitality_pro_enabled:'No'}, clientId:CID, leadId:100, userText:'towels', nowMs:NOON_IST});
    assert.equal(r.handled, false);
  });
  test('in-stay request becomes a task for an in-house guest only', async()=>{
    enable(db, ['instay_requests']);
    assert.equal((await turn(env, deps, 'need extra towels')).handled, false); // no stay
    booking(db, {ci:'2026-10-02', co:'2026-10-04', status:'checked_in'});
    const r=await turn(env, deps, 'The AC is not working');
    assert.equal(r.handled, true);
    const t=db.prepare(`SELECT * FROM hosp_suite_tasks`).get();
    assert.equal(t.kind, 'maintenance'); assert.equal(t.priority, 'high'); assert.equal(t.source, 'guest');
    assert.equal((await turn(env, deps, 'what time is lunch?')).handled, false);
  });
  test('web check-in: ETA → preferences → ID photo (scanned, Aadhaar masked) → done', async()=>{
    enable(db, ['web_checkin','id_scan','guest_profiles']);
    const bid=booking(db, {ci:'2026-10-04', co:'2026-10-05'});
    contact(db, 100, '+919847000707', '2026-10-03T05:00:00Z');
    await hsRunForClient(env, deps, CID, NOON_IST);
    assert.match(deps.log.buttons.at(-1).text, /Express check-in/);
    assert.equal((await hsGetState(env, CID, 100, NOON_IST)).step, 'eta');
    await turn(env, deps, '3 pm');
    await turn(env, deps, 'Vegetarian, it is our anniversary');
    const r=await turn(env, deps, '', {mediaType:'image', mediaUrl:'https://cdn/id.jpg'});
    assert.match(r.reply, /1 ID received \(Anu Thomas\)/);
    await turn(env, deps, 'done');
    const row=db.prepare(`SELECT * FROM hosp_suite_booking WHERE booking_id=?`).get(bid);
    assert.deepEqual([row.eta, row.checkin_status], ['15:00', 'done']);
    assert.match(row.preferences, /anniversary/);
    assert.equal(JSON.parse(db.prepare(`SELECT fields_json FROM hosp_suite_idscans`).get().fields_json).id_number, 'XXXX XXXX 9012');
    assert.match(db.prepare(`SELECT preferences FROM hosp_suite_guests`).get().preferences, /Vegetarian/);
    assert.equal(await hsGetState(env, CID, 100, NOON_IST), null);
  });
  test('feedback: 5★ gets the Google link, 2★ raises an alert and asks what went wrong', async()=>{
    enable(db, ['feedback'], {google_review_url:'https://g.page/r/lake'});
    db.prepare(`INSERT INTO hosp_suite_state (client_id, lead_id, state_json, updated_at) VALUES (?,?,?,?)`).run(CID, 100, JSON.stringify({flow:'feedback', booking_id:5}), '2026-10-03T06:00:00Z');
    const r=await turn(env, deps, '5');
    assert.match(r.reply, /g\.page\/r\/lake/);
    db.prepare(`INSERT INTO hosp_suite_state (client_id, lead_id, state_json, updated_at) VALUES (?,?,?,?) ON CONFLICT DO UPDATE SET state_json=excluded.state_json`).run(CID, 100, JSON.stringify({flow:'feedback', booking_id:6}), '2026-10-03T06:00:00Z');
    await turn(env, deps, '⭐⭐');
    assert.equal(db.prepare(`SELECT kind FROM hosp_suite_alerts`).get().kind, 'low_rating');
    await turn(env, deps, 'Room was not clean');
    assert.equal(db.prepare(`SELECT feedback FROM hosp_suite_booking WHERE booking_id=6`).get().feedback, 'Room was not clean');
  });
  test('staff bot: list, report an issue, mark done (clean task cleans the room)', async()=>{
    enable(db, ['staff_tasks','staff_bot','housekeeping']);
    db.prepare(`INSERT INTO hosp_suite_staff (client_id, name, role, phone, phone_key, active, created_at) VALUES (?,?,?,?,?,1,?)`).run(CID, 'Ravi', 'housekeeping', '9847000707', '9847000707', 'now');
    db.prepare(`INSERT INTO hosp_suite_tasks (client_id, kind, title, unit_id, status, priority, source, auto_key, created_at, updated_at) VALUES (?,?,?,1,'open','high','auto','clean:1',?,?)`).run(CID, 'housekeeping', 'Clean Kayal Queen', 'now', 'now');
    db.prepare(`INSERT INTO hosp_suite_room_status (unit_id, client_id, status, updated_at) VALUES (1, ?, 'dirty', 'now')`).run(CID);
    assert.match((await turn(env, deps, 'tasks')).reply, /#1 🟠 Clean Kayal Queen/);
    assert.match((await turn(env, deps, 'issue: generator leaking on Royal Palace')).reply, /task #2 \(Royal Palace\)/);
    assert.equal(db.prepare(`SELECT priority FROM hosp_suite_tasks WHERE id=2`).get().priority, 'urgent');
    await turn(env, deps, 'done 1');
    assert.equal(db.prepare(`SELECT status FROM hosp_suite_tasks WHERE id=1`).get().status, 'done');
    assert.equal(db.prepare(`SELECT status FROM hosp_suite_room_status WHERE unit_id=1`).get().status, 'clean');
    assert.equal((await turn(env, deps, 'hello')).handled, false); // plain chat from staff falls through
  });
  test('agent quote → net rates → booking request with commission', async()=>{
    enable(db, ['agents','agent_quotes']);
    db.prepare(`INSERT INTO hosp_suite_agents (client_id, name, company, phone, phone_key, commission_pct, active, created_at) VALUES (?,?,?,?,?,15,1,?)`).run(CID, 'Sam', 'Kerala Trails', '9847000707', '9847000707', 'now');
    const q=await turn(env, deps, 'rates for 10 oct to 11 oct 4 adults');
    assert.match(q.reply, /Kayal Queen\* — guest rate ₹9,000 · your net \*₹7,650\*/); // Sat night: weekend rate
    const b=await turn(env, deps, 'Kayal Queen');
    assert.match(b.reply, /Request #1 received/);
    const bk=db.prepare(`SELECT * FROM hospitality_bookings`).get();
    assert.equal(bk.status, 'inquiry');
    const s=db.prepare(`SELECT * FROM hosp_suite_booking`).get();
    assert.deepEqual([s.agent_id, s.commission_amount, s.commission_status], [1, 1350, 'due']);
  });
});

describe('cron', ()=>{
  let db, env, deps;
  beforeEach(()=>{ db=freshDb(); env={DB:d1(db)}; deps=fakeDeps(); seed(db); });

  test('nothing runs for a client with every feature off', async()=>{
    booking(db, {ci:'2026-10-04', co:'2026-10-05'});
    await hsRunForClient(env, deps, CID, NOON_IST);
    assert.equal(deps.log.texts.length+deps.log.buttons.length+deps.log.templates.length, 0);
  });
  test('balance reminder: free text inside the 24h window, template outside, alert when neither', async()=>{
    enable(db, ['balance_reminders'], {template_name:'hosp_update'});
    const b1=booking(db, {ci:'2026-10-04', co:'2026-10-05', lead:100});
    const b2=booking(db, {ci:'2026-10-09', co:'2026-10-10', lead:101, phone:'9000000001'});
    contact(db, 100, '9847000707', '2026-10-03T05:00:00Z');
    await hsRunForClient(env, deps, CID, NOON_IST);
    assert.match(deps.log.texts[0].text, /Balance due: \*₹7,500\*/);
    assert.equal(deps.log.templates.length, 1);
    assert.equal(deps.log.templates[0].name, 'hosp_update');
    assert.match(deps.log.templates[0].params[1], /in 6 days/);
    // b2 is 6 days out: bal_7 sent, bal_1 not yet — and nothing is re-sent on the next tick.
    assert.deepEqual(Object.keys(JSON.parse(db.prepare(`SELECT sent_json FROM hosp_suite_booking WHERE booking_id=?`).get(b2).sent_json)), ['bal_7']);
    await hsRunForClient(env, deps, CID, NOON_IST+15*60e3);
    assert.equal(deps.log.texts.length+deps.log.templates.length, 2);
    // No template configured + outside window → staff alert instead.
    enable(db, ['balance_reminders']);
    booking(db, {ci:'2026-10-05', co:'2026-10-06', lead:102, phone:'9000000002', name:'Joe'});
    await hsRunForClient(env, deps, CID, NOON_IST);
    assert.match(db.prepare(`SELECT title FROM hosp_suite_alerts WHERE kind='unsent'`).get().title, /Balance reminder not sent — Joe/);
    assert.ok(b1);
  });
  test('quiet hours: no guest messages at night', async()=>{
    enable(db, ['balance_reminders'], {template_name:'hosp_update'});
    booking(db, {ci:'2026-10-04', co:'2026-10-05'});
    await hsRunForClient(env, deps, CID, Date.parse('2026-10-03T17:30:00Z')); // 23:00 IST
    assert.equal(deps.log.templates.length, 0);
  });
  test('housekeeping: clean task for departures (urgent on same-day turnover), prepare task for arrivals', async()=>{
    enable(db, ['housekeeping']);
    booking(db, {ci:'2026-10-01', co:TODAY, status:'checked_in', lead:1});
    booking(db, {ci:TODAY, co:'2026-10-05', lead:2, name:'Meera'});
    await hsRunForClient(env, deps, CID, NOON_IST);
    await hsRunForClient(env, deps, CID, NOON_IST); // idempotent
    const tasks=db.prepare(`SELECT title, priority FROM hosp_suite_tasks ORDER BY id`).all();
    assert.deepEqual(tasks.map(t=>[t.title, t.priority]), [['Clean Kayal Queen after check-out', 'urgent'], ['Prepare Kayal Queen for Meera', 'high']]);
    assert.equal(db.prepare(`SELECT status FROM hosp_suite_room_status`).get().status, 'dirty');
  });
  test('iCal sync blocks OTA nights, removes them when gone, never touches manual blocks', async()=>{
    enable(db, ['ical_sync']);
    db.prepare(`INSERT INTO hospitality_blocked_dates (client_id, unit_id, date, reason, created_at) VALUES (?,1,'2026-10-06','Owner',?)`).run(CID, 'now');
    db.prepare(`INSERT INTO hosp_suite_ical (client_id, unit_id, source, url, created_at) VALUES (?,1,'Airbnb','https://airbnb/ics',?)`).run(CID, 'now');
    let ics='BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART;VALUE=DATE:20261005\nDTEND;VALUE=DATE:20261007\nEND:VEVENT\nEND:VCALENDAR';
    deps._fetch=async()=>new Response(ics);
    await hsRunForClient(env, deps, CID, NOON_IST);
    const dates=()=>db.prepare(`SELECT date, reason FROM hospitality_blocked_dates ORDER BY date`).all().map(r=>`${r.date}:${r.reason}`);
    assert.deepEqual(dates(), ['2026-10-05:OTA: Airbnb', '2026-10-06:Owner']);
    ics='BEGIN:VCALENDAR\nEND:VCALENDAR';
    await hsRunForClient(env, deps, CID, NOON_IST+2*3600e3);
    assert.deepEqual(dates(), ['2026-10-06:Owner']);
  });
  test('maintenance: service-due alert once per service cycle', async()=>{
    enable(db, ['maintenance']);
    db.prepare(`INSERT INTO hosp_suite_fleet (unit_id, client_id, engine_hours, service_interval_hours, last_service_hours, updated_at) VALUES (1, ?, 480, 250, 250, 'now')`).run(CID);
    await hsRunForClient(env, deps, CID, NOON_IST);
    await hsRunForClient(env, deps, CID, NOON_IST);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM hosp_suite_alerts WHERE kind='service'`).get().n, 1);
  });
  test('daily summary goes to the owner via template once a day', async()=>{
    enable(db, ['daily_summary'], {owner_phone:'9999900000', template_name:'hosp_update', summary_hour:9});
    await hsRunForClient(env, deps, CID, NOON_IST);
    await hsRunForClient(env, deps, CID, NOON_IST+3600e3);
    assert.equal(deps.log.templates.length, 1);
    assert.match(deps.log.templates[0].params[1], /Next 7 days/);
  });
});

describe('dashboard API', ()=>{
  let db, env, deps;
  beforeEach(()=>{ db=freshDb(); env={DB:d1(db)}; deps=fakeDeps(); seed(db); });

  test('desk bootstrap works for a non-Pro hospitality client; suite routes do not', async()=>{
    deps=fakeDeps({...PRO_CLIENT, hospitality_pro_enabled:'No'});
    booking(db, {ci:'2026-10-02', co:'2026-10-05', status:'checked_in'});
    const r=await call(env, deps, 'GET', '/hospitality/desk/bootstrap');
    assert.equal(r.status, 200);
    assert.equal(r.data.units.length, 2);
    assert.equal(r.data.pro, null);
    assert.equal(r.data.stats.in_house, 1);
    assert.equal((await call(env, deps, 'GET', '/hospitality/suite/settings')).status, 403);
    deps=fakeDeps({...PRO_CLIENT, hospitality_enabled:'No'});
    assert.equal((await call(env, deps, 'GET', '/hospitality/desk/bootstrap')).status, 403);
  });
  test('unauthenticated → 401', async()=>{
    const [r, u]=req('GET', '/hospitality/suite/settings', null, 'Bearer nope');
    assert.equal((await hsHandleRoute(r, env, deps, u)).status, 401);
  });
  test('each feature gates its own routes', async()=>{
    assert.equal((await call(env, deps, 'GET', '/hospitality/suite/staff')).status, 403);
    const s=await call(env, deps, 'PATCH', '/hospitality/suite/settings', {config:{features:{staff_tasks:true}}});
    assert.equal(s.data.config.features.staff_tasks, true);
    assert.equal(s.data.config.features.fleet, false);
    assert.equal((await call(env, deps, 'POST', '/hospitality/suite/staff', {name:'Ravi', role:'cook', phone:'+91 98470 11111'})).status, 200);
    assert.equal(db.prepare(`SELECT phone_key FROM hosp_suite_staff`).get().phone_key, '9847011111');
    assert.equal((await call(env, deps, 'GET', '/hospitality/suite/fleet')).status, 403);
    // Another PATCH keeps earlier switches.
    const s2=await call(env, deps, 'PATCH', '/hospitality/suite/settings', {config:{features:{fleet:true}}});
    assert.deepEqual([s2.data.config.features.staff_tasks, s2.data.config.features.fleet], [true, true]);
  });
  test('pricing: generate, apply writes the rate override', async()=>{
    enable(db, ['pricing_rules']);
    await call(env, deps, 'POST', '/hospitality/suite/rules', {kind:'event', name:'Onam', start_date:'2026-10-10', end_date:'2026-10-10', pct:25});
    const g=await call(env, deps, 'POST', '/hospitality/suite/suggestions/generate');
    assert.equal(g.data.count, 2);
    const list=(await call(env, deps, 'GET', '/hospitality/suite/suggestions')).data.list;
    await call(env, deps, 'POST', '/hospitality/suite/suggestions/apply', {ids:[list[0].id]});
    const ov=db.prepare(`SELECT unit_id, date, rate FROM hospitality_rate_overrides`).all();
    assert.equal(ov.length, 1); assert.equal(ov[0].date, '2026-10-10');
  });
  test('allotment blocks dates, agent still sees them, confirm releases them into the booking', async()=>{
    enable(db, ['agents','agent_quotes','allotments']);
    await call(env, deps, 'POST', '/hospitality/suite/agents', {name:'Sam', phone:'9847000707', commission_pct:10});
    const a=await call(env, deps, 'POST', '/hospitality/suite/allotments', {agent_id:1, unit_id:2, start_date:'2026-10-10', end_date:'2026-10-12', release_days:3});
    assert.equal(a.data.blocked, 2);
    const q=await turn(env, deps, 'availability 10 oct to 12 oct 2 adults');
    assert.match(q.reply, /Royal Palace/);
    await turn(env, deps, 'Royal Palace');
    const bid=db.prepare(`SELECT id FROM hospitality_bookings WHERE unit_id=2`).get().id;
    const c=await call(env, deps, 'POST', '/hospitality/suite/agents/confirm', {booking_id:bid, guest_name:'Mr Rao'});
    assert.equal(c.status, 200);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM hospitality_blocked_dates WHERE unit_id=2`).get().n, 0);
    assert.deepEqual(Object.values(db.prepare(`SELECT status, guest_name FROM hospitality_bookings WHERE id=?`).get(bid)), ['confirmed', 'Mr Rao']);
  });
  test('competitor rate well below ours raises an alert', async()=>{
    enable(db, ['competitor_rates']);
    await call(env, deps, 'POST', '/hospitality/suite/competitors', {name:'Backwater Bliss'});
    const r=await call(env, deps, 'POST', '/hospitality/suite/comp-rates', {competitor_id:1, date:'2026-10-07', rate:6500});
    assert.match(r.data.alert, /19% below your lowest rate \(₹8,000\)/);
    const ok=await call(env, deps, 'POST', '/hospitality/suite/comp-rates', {competitor_id:1, date:'2026-10-07', rate:7900});
    assert.equal(ok.data.alert, null);
  });
  test('review reply draft, journey board money, iCal export route', async()=>{
    enable(db, ['review_replies','refunds','ical_sync']);
    await call(env, deps, 'POST', '/hospitality/suite/reviews', {source:'Google', author:'Priya', rating:5, text:'Loved the food!'});
    const d=await call(env, deps, 'POST', '/hospitality/suite/reviews/draft', {id:1});
    assert.match(d.data.reply, /Team Lake Resort/);
    const bid=booking(db, {ci:'2026-10-04', co:'2026-10-05'});
    await call(env, deps, 'POST', '/hospitality/suite/payments', {booking_id:bid, kind:'balance', amount:4000});
    const j=(await call(env, deps, 'GET', '/hospitality/suite/journey')).data.list[0];
    assert.deepEqual([j.money.received, j.money.balance], [6500, 3500]);
    const ical=(await call(env, deps, 'GET', '/hospitality/suite/ical')).data;
    const res=await hsIcalExportRoute(env, new URL('https://w.test'+ical.exports[0].path));
    assert.equal(res.status, 200);
    assert.match(await res.text(), /BEGIN:VCALENDAR/);
    assert.equal((await hsIcalExportRoute(env, new URL('https://w.test/hospitality/ical/0000000000000000/1.ics'))).status, 404);
  });
  test('Razorpay balance payment is recorded once and the guest is thanked', async()=>{
    enable(db, ['balance_reminders']);
    const bid=booking(db, {ci:'2026-10-04', co:'2026-10-05'});
    contact(db, 100, '9847000707', new Date().toISOString());
    await hsBalancePaid(env, deps, CID, bid, 7500, 'pay_1');
    await hsBalancePaid(env, deps, CID, bid, 7500, 'pay_1');
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM hosp_suite_payments`).get().n, 1);
    assert.match(deps.log.texts.at(-1).text, /Payment received — ₹7,500/);
  });
});
