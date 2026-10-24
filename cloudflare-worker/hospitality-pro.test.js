// Hospitality Pro module (hospitality-pro.js) — parsing/pricing helpers, then the WhatsApp quote →
// hold → confirm → registration flow, group enquiries, the recovery/expiry sweep and the dashboard
// API, end to end against the real hospitality + hospitality-pro migrations (node:sqlite through
// the same tiny D1 shim meetings.test.js uses). deps are recorded fakes, so nothing leaves the box.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import {
  hpEnabled, hpNormalizeConfig, hpParseDateRange, hpParseGuests, hpMatchByName, hpNightlyRates,
  hpComputeQuote, hpLoyaltyTier, hpIsQuietHour, hpFmtMoney, hpDetectStart, hpHandleTurn,
  hpConfirmHold, hpRunForClient, hpHandleRoute, hpGetState,
} from './hospitality-pro.js';

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
const MIGRATIONS=['0009_hospitality.sql','0010_hospitality_media.sql','0066_resort_properties.sql','0067_hospitality_units_resort_fields.sql','0092_hospitality_property_location.sql','0109_hospitality_pro.sql'];
function freshDb(){
  const db=new DatabaseSync(':memory:');
  for(const f of MIGRATIONS) db.exec(readFileSync(new URL(`./migrations/${f}`, import.meta.url), 'utf8'));
  return db;
}

const TODAY='2026-10-03'; // a Saturday
const NOON_IST=Date.parse('2026-10-03T06:30:00Z');
const CID=7;
const PRO_CLIENT={Id:CID, hospitality_enabled:'Yes', hospitality_pro_enabled:'Yes', chatwoot_base:'https://cw', chatwoot_account_id:'1', chatwoot_token:'t'};

function fakeDeps(client=PRO_CLIENT, leads={}){
  const log={texts:[], buttons:[], notes:[], photos:[]};
  const deps={
    log,
    json:(data, status)=>new Response(JSON.stringify(data), {status:status||200, headers:{'Content-Type':'application/json'}}),
    requireSession:async(req)=>req.headers.get('Authorization')==='Bearer ok'?{cid:CID}:null,
    getClientById:async()=>client,
    reportOpsError:async(env, where, e)=>{ throw e; },
    sendText:async(env, c, cid, convId, text)=>{ log.texts.push({convId, text}); return true; },
    sendButtons:async(env, c, cid, convId, text, items)=>{ log.buttons.push({convId, text, items}); return items.map(i=>({title:i.title, value:i.value})); },
    sendPrivateNote:async(c, convId, text)=>{ log.notes.push({convId, text}); },
    sendUnitPhotos:async(env, c, cid, convId, leadId, unit)=>{ log.photos.push({leadId, unit:unit.name}); return true; },
    localize:async(env, c, text)=>text,
    getLead:async(env, id)=>leads[id]||{Id:id},
    isTakeover:lead=>lead?.ManualTakeover==='Yes',
  };
  return deps;
}
function seed(db){
  const now='2026-01-01T00:00:00Z';
  db.prepare(`INSERT INTO hospitality_units (id, client_id, name, unit_type, capacity_adults, capacity_children, base_rate, weekend_rate, currency, active, created_at) VALUES (1, ?, 'Lake View Villa', 'Villa', 2, 1, 5000, 6000, 'INR', 1, ?)`).run(CID, now);
  db.prepare(`INSERT INTO hospitality_units (id, client_id, name, unit_type, capacity_adults, capacity_children, base_rate, weekend_rate, currency, active, created_at) VALUES (2, ?, 'Garden Cottage', 'Cottage', 4, 2, 3000, NULL, 'INR', 1, ?)`).run(CID, now);
  db.prepare(`INSERT INTO hosp_pro_addons (client_id, name, price, price_type, currency, active, sort_order, created_at) VALUES (?, 'Candlelight Dinner', 2500, 'per_booking', 'INR', 1, 0, ?)`).run(CID, now);
}
function turn(env, deps, leadId, text, extra={}){
  return hpHandleTurn(env, deps, {c:PRO_CLIENT, clientId:String(CID), convId:`conv${leadId}`, leadId, phone:`9198470000${leadId}`, name:'Asha K',
    userText:text, rawText:text, mediaType:'text', mediaUrl:null, lang:'en', nowMs:NOON_IST, ...extra});
}

describe('gating + config', ()=>{
  test('Pro is on only when both flags are Yes', ()=>{
    assert.equal(hpEnabled({hospitality_enabled:'Yes', hospitality_pro_enabled:'Yes'}), true);
    assert.equal(hpEnabled({hospitality_enabled:'Yes'}), false);
    assert.equal(hpEnabled({hospitality_enabled:'No', hospitality_pro_enabled:'Yes'}), false);
    assert.equal(hpEnabled({hospitality_enabled:'Yes', hospitality_pro_enabled:''}), false);
    assert.equal(hpEnabled(null), false);
  });
  test('config defaults, clamps and keeps recovery inside the 24h window', ()=>{
    const d=hpNormalizeConfig('');
    assert.equal(d.hold_minutes, 30); assert.equal(d.deposit_pct, 25); assert.deepEqual(d.recovery_hours, [2,20]);
    assert.equal(d.features.quote, true);
    const c=hpNormalizeConfig({hold_minutes:2, deposit_pct:150, recovery_hours:[30, 5, 1], features:{groups:false}, payment_mode:'evil'});
    assert.equal(c.hold_minutes, 15); assert.equal(c.deposit_pct, 100); assert.deepEqual(c.recovery_hours, [1,5]);
    assert.equal(c.features.groups, false); assert.equal(c.features.addons, true); assert.equal(c.payment_mode, 'manual');
  });
  test('quiet hours wrap past midnight in local time', ()=>{
    const cfg=hpNormalizeConfig({});
    assert.equal(hpIsQuietHour(NOON_IST, cfg), false);
    assert.equal(hpIsQuietHour(Date.parse('2026-10-03T17:00:00Z'), cfg), true);  // 22:30 IST
    assert.equal(hpIsQuietHour(Date.parse('2026-10-03T01:00:00Z'), cfg), true);  // 06:30 IST
  });
});

describe('hpParseDateRange', ()=>{
  const cases=[
    ['12-14 Dec', '2026-12-12', '2026-12-14'],
    ['Dec 12 to 14', '2026-12-12', '2026-12-14'],
    ['12th December to 14th December 2026', '2026-12-12', '2026-12-14'],
    ['from 12/12 - 14/12 please', '2026-12-12', '2026-12-14'],
    ['2026-12-12 to 2026-12-14', '2026-12-12', '2026-12-14'],
    ['30 Dec to 2 Jan', '2026-12-30', '2027-01-02'],
    ['tomorrow for 2 nights', '2026-10-04', '2026-10-06'],
    ['this weekend', '2026-10-03', '2026-10-04'],
    ['12 dec 2 nights', '2026-12-12', '2026-12-14'],
  ];
  for(const [text, ci, co] of cases){
    test(text, ()=>{ const r=hpParseDateRange(text, TODAY); assert.equal(r?.check_in, ci); assert.equal(r?.check_out, co); });
  }
  test('a single date with no length leaves check-out open', ()=>{
    assert.deepEqual(hpParseDateRange('15 Mar', TODAY), {check_in:'2027-03-15', check_out:null, nights:null});
  });
  test('guest counts and "may" are not dates', ()=>{
    assert.equal(hpParseDateRange('2 adults 1 child', TODAY), null);
    assert.equal(hpParseDateRange('may 2 adults come?', TODAY), null);
    assert.equal(hpParseDateRange('is breakfast included?', TODAY), null);
  });
  test('"3 days 2 nights" is a length without dates', ()=>{
    assert.deepEqual(hpParseDateRange('3 days 2 nights package', TODAY), {check_in:null, check_out:null, nights:2});
  });
});

describe('guests, names, pricing, loyalty', ()=>{
  test('hpParseGuests', ()=>{
    assert.deepEqual(hpParseGuests('2 adults 1 kid'), {adults:2, children:1});
    assert.deepEqual(hpParseGuests('we are 5'), {adults:5, children:0});
    assert.deepEqual(hpParseGuests('a couple and 2 children'), {adults:2, children:2});
    assert.deepEqual(hpParseGuests('2+1'), {adults:2, children:1});
    assert.equal(hpParseGuests('4'), null);
    assert.deepEqual(hpParseGuests('4', {bare:true}), {adults:4, children:0});
  });
  test('hpMatchByName prefers the longest name and handles truncated taps', ()=>{
    const units=[{name:'Villa'}, {name:'Lake View Villa'}, {name:'Premium Tea Garden View'}];
    assert.equal(hpMatchByName('book the lake view villa', units).name, 'Lake View Villa');
    assert.equal(hpMatchByName('Premium Tea Garden...', units).name, 'Premium Tea Garden View');
    assert.equal(hpMatchByName('hello', units), null);
  });
  test('nightly rates: override > weekend rate on Sat/Sun > base', ()=>{
    const unit={base_rate:5000, weekend_rate:6000};
    const n=hpNightlyRates(unit, {'2026-12-14':9000}, '2026-12-12', '2026-12-15');
    assert.deepEqual(n.map(x=>x.rate), [6000, 6000, 9000]);
  });
  test('quote maths', ()=>{
    const q=hpComputeQuote({nightly:[{rate:6000},{rate:6000}], adults:2, children:1, discountPct:10,
      addons:[{id:1, name:'Dinner', price:2500, price_type:'per_booking'}, {id:2, name:'Breakfast', price:300, price_type:'per_guest_night'}], depositPct:25});
    assert.equal(q.room_total, 12000); assert.equal(q.discount_amount, 1200);
    assert.equal(q.addons_total, 2500+300*3*2); assert.equal(q.total, 12000-1200+4300); assert.equal(q.deposit, Math.round(15100*0.25));
  });
  test('loyalty tiers + money format', ()=>{
    const loy=hpNormalizeConfig({}).loyalty;
    assert.deepEqual(hpLoyaltyTier(0, loy), {tier:null, pct:0});
    assert.deepEqual(hpLoyaltyTier(1, loy), {tier:'Silver', pct:5});
    assert.deepEqual(hpLoyaltyTier(3, loy), {tier:'Gold', pct:10});
    assert.deepEqual(hpLoyaltyTier(7, loy), {tier:'Platinum', pct:15});
    assert.equal(hpFmtMoney(145000, 'INR'), '₹1,45,000');
  });
  test('intent detection', ()=>{
    const cfg=hpNormalizeConfig({});
    assert.equal(hpDetectStart('I want to book a room', cfg), 'quote');
    assert.equal(hpDetectStart('what is the price', cfg), null);
    assert.equal(hpDetectStart('price for 12-14 dec?', cfg, {datesFound:true}), 'quote');
    assert.equal(hpDetectStart('I want to cancel my booking', cfg), null);
    assert.equal(hpDetectStart('planning a wedding', cfg), 'group');
    assert.equal(hpDetectStart('planning a wedding', hpNormalizeConfig({features:{groups:false}})), null);
    assert.equal(hpDetectStart('is wifi available?', cfg), null);
  });
});

describe('WhatsApp flow: quote → hold → paid → confirm → registration', ()=>{
  let db, env, deps;
  beforeEach(()=>{ db=freshDb(); seed(db); env={DB:d1(db)}; deps=fakeDeps(); });

  test('full happy path with tour-before-price and an add-on', async()=>{
    let r=await turn(env, deps, 101, 'Hi, I want to book a stay');
    assert.equal(r.handled, true);
    assert.match(r.reply, /Which dates/);
    assert.equal((await hpGetState(env, CID, 101, NOON_IST)).step, 'dates');

    r=await turn(env, deps, 101, '12-14 Dec');
    assert.match(r.reply, /How many guests/);

    r=await turn(env, deps, 101, '2 adults');
    assert.match(r.reply, /Lake View Villa/); assert.match(r.reply, /Garden Cottage/);
    assert.doesNotMatch(r.reply, /₹/, 'tour-first: no price in the picker');
    assert.deepEqual(r.quickReplies.map(o=>o.value), ['Garden Cottage', 'Lake View Villa']);

    r=await turn(env, deps, 101, 'Lake View Villa');
    assert.deepEqual(deps.log.photos, [{leadId:101, unit:'Lake View Villa'}], 'photos go out before the price');
    assert.match(r.reply, /Candlelight Dinner/);
    assert.match(r.reply, /₹12,000/, 'two weekend nights at the weekend rate');

    r=await turn(env, deps, 101, 'Candlelight Dinner');
    assert.match(r.reply, /Your quote — Lake View Villa/);
    assert.match(r.reply, /Total: ₹14,500/);
    assert.match(r.reply, /₹3,625/);
    assert.deepEqual(r.quickReplies.map(o=>o.value), ['hold this room', 'change dates', 'talk to team']);
    assert.equal(db.prepare(`SELECT status FROM hosp_pro_recovery WHERE lead_id=101`).get().status, 'active');

    r=await turn(env, deps, 101, 'hold this room');
    assert.match(r.reply, /held for you/);
    assert.match(r.reply, /reply \*PAID\*/);
    const hold=db.prepare(`SELECT * FROM hosp_pro_holds WHERE lead_id=101`).get();
    assert.equal(hold.status, 'active'); assert.equal(hold.total_amount, 14500); assert.equal(hold.deposit_amount, 3625);
    assert.equal(hold.expires_at, new Date(NOON_IST+30*60000).toISOString());
    assert.equal(await hpGetState(env, CID, 101, NOON_IST), null);
    assert.equal(db.prepare(`SELECT status FROM hosp_pro_recovery WHERE lead_id=101`).get().status, 'held');
    assert.match(deps.log.notes.at(-1).text, /hold #\d+/);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM hospitality_bookings`).get().n, 0, 'a hold is not a booking yet');

    // Someone else asking for the same dates no longer sees the held villa.
    r=await turn(env, deps, 202, 'book 12-14 dec for 2 adults');
    assert.match(r.reply, /Garden Cottage/); assert.doesNotMatch(r.reply, /Lake View Villa/);

    r=await turn(env, deps, 101, 'PAID');
    assert.match(r.reply, /noted your payment/);
    assert.equal(db.prepare(`SELECT status FROM hosp_pro_holds WHERE id=?`).get(hold.id).status, 'payment_claimed');

    const conf=await hpConfirmHold(env, deps, CID, hold.id, {paymentRef:'UPI 123', nowMs:NOON_IST});
    assert.equal(conf.ok, true);
    const b=db.prepare(`SELECT * FROM hospitality_bookings WHERE id=?`).get(conf.booking_id);
    assert.equal(b.status, 'confirmed'); assert.equal(b.total_amount, 14500); assert.equal(b.deposit_amount, 3625); assert.equal(b.lead_id, 101);
    assert.match(b.notes, /Candlelight Dinner/);
    assert.match(deps.log.texts.at(-1).text, /Booking confirmed/);
    assert.match(deps.log.buttons.at(-1).text, /Express check-in/);
    assert.equal(db.prepare(`SELECT status FROM hosp_pro_recovery WHERE lead_id=101`).get().status, 'converted');

    r=await turn(env, deps, 101, '', {mediaType:'image', mediaUrl:'https://cw/id1.jpg', userText:'[image: an ID card]'});
    assert.match(r.reply, /1 document received/);
    r=await turn(env, deps, 101, 'done');
    assert.match(r.reply, /check-in details are saved/);
    const reg=db.prepare(`SELECT * FROM hosp_pro_registrations WHERE booking_id=?`).get(conf.booking_id);
    assert.equal(reg.status, 'received'); assert.equal(JSON.parse(reg.documents_json)[0].url, 'https://cw/id1.jpg');

    // Confirming twice is a no-op, not a second booking.
    const again=await hpConfirmHold(env, deps, CID, hold.id, {nowMs:NOON_IST});
    assert.equal(again.already, true);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM hospitality_bookings`).get().n, 1);
  });

  test('a single message with everything goes straight to the quote', async()=>{
    const r=await turn(env, deps, 303, 'Can I book Garden Cottage 12-14 dec for 2 adults 1 kid?');
    assert.match(r.reply, /✨ Make it special/);
    assert.match(r.reply, /₹6,000/);
  });

  test('side questions fall through to the normal bot, and the flow gives up after two', async()=>{
    await turn(env, deps, 404, 'I want to book');
    let r=await turn(env, deps, 404, 'is there a swimming pool?');
    assert.equal(r.handled, false);
    assert.equal((await hpGetState(env, CID, 404, NOON_IST)).misses, 1);
    r=await turn(env, deps, 404, 'and wifi?');
    assert.equal(r.handled, false);
    assert.equal(await hpGetState(env, CID, 404, NOON_IST), null);
  });

  test('messages without a booking intent are not touched', async()=>{
    for(const text of ['hi', 'what is the price?', 'show me photos', 'is breakfast included']){
      const r=await turn(env, deps, 505, text);
      assert.equal(r.handled, false, text);
    }
    assert.equal(deps.log.texts.length+deps.log.buttons.length, 0);
  });

  test('asking for a human or opting out releases the lead', async()=>{
    await turn(env, deps, 606, 'I want to book');
    let r=await turn(env, deps, 606, 'talk to team');
    assert.equal(r.handled, false);
    assert.equal(await hpGetState(env, CID, 606, NOON_IST), null);
    db.prepare(`INSERT INTO hosp_pro_recovery (client_id, lead_id, step, last_activity_at, status, created_at, updated_at) VALUES (?, 606, 0, ?, 'active', ?, ?)`).run(CID, 'x', 'x', 'x');
    r=await turn(env, deps, 606, 'STOP', {optOut:true});
    assert.equal(r.handled, false);
    assert.equal(db.prepare(`SELECT status FROM hosp_pro_recovery WHERE lead_id=606`).get().status, 'stopped');
  });

  test('returning guests get their loyalty discount', async()=>{
    db.prepare(`INSERT INTO hospitality_bookings (client_id, unit_id, guest_name, guest_phone, check_in, check_out, nights, total_amount, status, created_at) VALUES (?, 2, 'Asha', '+91 984700 00707', '2026-05-01', '2026-05-03', 2, 6000, 'checked_out', 'x')`).run(CID);
    const r=await turn(env, deps, 707, 'book Garden Cottage 12-14 dec for 2 adults');
    db.prepare(`DELETE FROM hosp_pro_addons`).run();
    const r2=await turn(env, deps, 707, 'done');
    assert.match(r.reply+r2.reply, /Silver/);
    assert.match(r2.reply, /Welcome back/);
    assert.match(r2.reply, /−₹300/);
  });

  test('parties too big for any room become a group enquiry', async()=>{
    const r=await turn(env, deps, 808, 'book 12-14 dec for 8 adults');
    assert.match(r.reply, /Anything we should plan for/);
    const r2=await turn(env, deps, 808, 'need 2 rooms and dinner');
    assert.match(r2.reply, /events team/);
    const g=db.prepare(`SELECT * FROM hosp_pro_groups WHERE lead_id=808`).get();
    assert.equal(g.group_size, 8); assert.equal(g.event_type, 'Family / Friends'); assert.equal(g.check_in, '2026-12-12');
  });

  test('wedding enquiry brief', async()=>{
    let r=await turn(env, deps, 909, 'Planning a wedding for 80 people on 12-14 dec');
    assert.match(r.reply, /Anything we should plan for/);
    r=await turn(env, deps, 909, 'Need the banquet hall and food for 2 days');
    assert.match(r.reply, /💍|Wedding/);
    const g=db.prepare(`SELECT * FROM hosp_pro_groups WHERE lead_id=909`).get();
    assert.equal(g.event_type, 'Wedding'); assert.equal(g.group_size, 80); assert.match(g.requirements, /banquet/);
    assert.match(deps.log.notes.at(-1).text, /group enquiry/);
  });

  test('a booking made by staff in between turns the hold into a conflict, not a double booking', async()=>{
    for(const t of ['book Lake View Villa 12-14 dec for 2 adults', 'done', 'hold']) await turn(env, deps, 111, t);
    const hold=db.prepare(`SELECT * FROM hosp_pro_holds WHERE lead_id=111`).get();
    db.prepare(`INSERT INTO hospitality_bookings (client_id, unit_id, check_in, check_out, status, created_at) VALUES (?, 1, '2026-12-13', '2026-12-15', 'confirmed', 'x')`).run(CID);
    const r=await hpConfirmHold(env, deps, CID, hold.id, {nowMs:NOON_IST});
    assert.equal(r.status, 409);
    assert.equal(db.prepare(`SELECT status FROM hosp_pro_holds WHERE id=?`).get(hold.id).status, 'conflict');
  });
});

describe('sweep: hold expiry + abandoned-inquiry recovery', ()=>{
  let db, env, deps;
  beforeEach(()=>{ db=freshDb(); seed(db); env={DB:d1(db)}; deps=fakeDeps(); });
  const ago=h=>new Date(NOON_IST-h*3600e3).toISOString();
  function rec(leadId, idleH, step=0){
    db.prepare(`INSERT INTO hosp_pro_recovery (client_id, lead_id, conv_id, guest_name, unit_id, check_in, check_out, adults, children, step, last_activity_at, status, created_at, updated_at)
      VALUES (?, ?, ?, 'Asha K', 1, '2026-12-12', '2026-12-14', 2, 0, ?, ?, 'active', ?, ?)`).run(CID, leadId, `conv${leadId}`, step, ago(idleH), ago(idleH), ago(idleH));
  }

  test('nudges an idle quote once per step, honestly, and parks the lead at "Hold this room"', async()=>{
    rec(1, 3);
    rec(2, 1);   // not idle long enough yet
    await hpRunForClient(env, deps, CID, NOON_IST);
    assert.equal(deps.log.buttons.length, 1);
    assert.match(deps.log.buttons[0].text, /Lake View Villa\* is still available/);
    assert.match(deps.log.buttons[0].text, /Only 2 stays are left/);
    assert.equal(db.prepare(`SELECT step FROM hosp_pro_recovery WHERE lead_id=1`).get().step, 1);
    assert.equal((await hpGetState(env, CID, 1, NOON_IST)).step, 'confirm');
    await hpRunForClient(env, deps, CID, NOON_IST);
    assert.equal(deps.log.buttons.length, 1, 'same tick twice does not double-send');
    // Tapping the nudge's button picks the flow back up.
    const r=await turn(env, deps, 1, '🔒 Hold this room');
    assert.match(r.reply, /held for you/);
  });

  test('nothing is sent in quiet hours, after 23h, to opted-out leads, or when Pro is off', async()=>{
    rec(1, 3);
    await hpRunForClient(env, deps, CID, Date.parse('2026-10-03T17:00:00Z'));
    assert.equal(deps.log.buttons.length, 0);
    db.prepare(`DELETE FROM hosp_pro_recovery`).run();
    rec(2, 23.5);
    await hpRunForClient(env, deps, CID, NOON_IST);
    assert.equal(db.prepare(`SELECT status FROM hosp_pro_recovery WHERE lead_id=2`).get().status, 'done');
    rec(3, 3);
    await hpRunForClient(env, fakeDeps(PRO_CLIENT, {3:{Id:3, OptOut:'Yes'}}), CID, NOON_IST);
    assert.equal(db.prepare(`SELECT status FROM hosp_pro_recovery WHERE lead_id=3`).get().status, 'stopped');
    rec(4, 3);
    const off=fakeDeps({...PRO_CLIENT, hospitality_pro_enabled:'No'});
    await hpRunForClient(env, off, CID, NOON_IST);
    assert.equal(off.log.buttons.length+off.log.texts.length, 0);
    assert.equal(db.prepare(`SELECT status FROM hosp_pro_recovery WHERE lead_id=4`).get().status, 'active');
  });

  test('expired holds are closed and the guest is offered to hold again', async()=>{
    for(const t of ['book Lake View Villa 12-14 dec for 2 adults', 'done', 'hold']) await turn(env, deps, 5, t);
    const later=NOON_IST+45*60000;
    await hpRunForClient(env, deps, CID, later);
    assert.equal(db.prepare(`SELECT status FROM hosp_pro_holds WHERE lead_id=5`).get().status, 'expired');
    assert.match(deps.log.buttons.at(-1).text, /has expired — but it's still available/);
    const n=deps.log.buttons.length;
    await hpRunForClient(env, deps, CID, later);
    assert.equal(deps.log.buttons.length, n, 'expiry notice is sent once');
  });
});

describe('dashboard API', ()=>{
  let db, env, deps;
  beforeEach(()=>{ db=freshDb(); seed(db); env={DB:d1(db)}; deps=fakeDeps(); });
  const call=(d, method, path, body, auth='Bearer ok')=>hpHandleRoute(new Request(`https://w${path}`, {method, headers:{Authorization:auth, 'Content-Type':'application/json'}, body:body?JSON.stringify(body):undefined}), env, d, new URL(`https://w${path}`));

  test('session required, and 403 unless Pro is enabled', async()=>{
    assert.equal((await call(deps, 'GET', '/hospitality/pro/addons', null, 'Bearer nope')).status, 401);
    const off=fakeDeps({...PRO_CLIENT, hospitality_pro_enabled:'No'});
    assert.equal((await call(off, 'GET', '/hospitality/pro/addons')).status, 403);
    assert.equal((await call(deps, 'GET', '/hospitality/pro/addons')).status, 200);
  });

  test('settings never echo Razorpay secrets', async()=>{
    const r=await call(deps, 'PATCH', '/hospitality/pro/settings', {config:{deposit_pct:50}, razorpay_key_id:'rzp_test', razorpay_key_secret:'sec', razorpay_webhook_secret:'hook'});
    assert.equal(r.status, 200);
    const g=await (await call(deps, 'GET', '/hospitality/pro/settings')).json();
    assert.equal(g.config.deposit_pct, 50); assert.equal(g.razorpay_connected, true);
    assert.equal(JSON.stringify(g).includes('sec'), false);
  });

  test('add-on + tour CRUD is scoped to the client', async()=>{
    const a=await (await call(deps, 'POST', '/hospitality/pro/addons', {name:'Campfire', price:800, price_type:'per_night'})).json();
    assert.ok(a.id);
    assert.equal((await call(deps, 'POST', '/hospitality/pro/tours', {url:'javascript:alert(1)'})).status, 400);
    assert.equal((await call(deps, 'POST', '/hospitality/pro/tours', {url:'https://youtu.be/x', unit_id:999})).status, 404);
    assert.equal((await call(deps, 'POST', '/hospitality/pro/tours', {url:'https://youtu.be/x', unit_id:1, title:'Villa walkthrough'})).status, 200);
    db.prepare(`INSERT INTO hosp_pro_addons (client_id, name, created_at) VALUES (99, 'Other client', 'x')`).run();
    const list=await (await call(deps, 'GET', '/hospitality/pro/addons')).json();
    assert.deepEqual(list.list.map(x=>x.name), ['Candlelight Dinner', 'Campfire']);
    assert.equal((await call(deps, 'PATCH', '/hospitality/pro/addons', {id:3, price:1})).status, 404);
  });

  test('Razorpay webhook confirms the hold only with a valid signature', async()=>{
    await call(deps, 'PATCH', '/hospitality/pro/settings', {razorpay_key_id:'rzp', razorpay_key_secret:'s', razorpay_webhook_secret:'whsec'});
    for(const t of ['book Lake View Villa 12-14 dec for 2 adults', 'done', 'hold']) await turn(env, deps, 9, t);
    const hold=db.prepare(`SELECT * FROM hosp_pro_holds WHERE lead_id=9`).get();
    const body=JSON.stringify({event:'payment_link.paid', payload:{payment:{entity:{id:'pay_1', notes:{}}}, payment_link:{entity:{id:'pl_1', notes:{kind:'hosp_pro_hold', client_id:String(CID), hold_id:String(hold.id)}}}}});
    const send=sig=>hpHandleRoute(new Request('https://w/hospitality/pro/razorpay/webhook', {method:'POST', headers:{'X-Razorpay-Signature':sig}, body}), env, deps, new URL('https://w/hospitality/pro/razorpay/webhook'));
    assert.equal((await send('deadbeef')).status, 400);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM hospitality_bookings`).get().n, 0);
    assert.equal((await send(createHmac('sha256', 'whsec').update(body).digest('hex'))).status, 200);
    const b=db.prepare(`SELECT * FROM hospitality_bookings`).get();
    assert.equal(b.status, 'confirmed'); assert.match(b.notes, /razorpay:pay_1/);
  });

  test('guests list aggregates past stays into tiers', async()=>{
    for(const [ci, co] of [['2026-01-01','2026-01-02'], ['2026-03-01','2026-03-02'], ['2026-05-01','2026-05-02']])
      db.prepare(`INSERT INTO hospitality_bookings (client_id, unit_id, guest_name, guest_phone, check_in, check_out, total_amount, status, created_at) VALUES (?, 1, 'Ravi', '9847011111', ?, ?, 5000, 'checked_out', 'x')`).run(CID, ci, co);
    const g=await (await call(deps, 'GET', '/hospitality/pro/guests')).json();
    assert.equal(g.list[0].stays, 3); assert.equal(g.list[0].tier, 'Gold'); assert.equal(g.list[0].spent, 15000);
  });
});
