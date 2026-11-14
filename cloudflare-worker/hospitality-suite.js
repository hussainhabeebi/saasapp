// ── Hospitality Pro Suite ────────────────────────────────────────────────────────────────────────
// Six full modules on top of Hospitality Pro (hospitality-pro.js), plus the data API behind the
// desktop Hospitality workspace (frontend/hospitality.html):
//   1. Guest Journey     — balance reminders + payment links, refunds ledger, web check-in (ETA,
//                          preferences, ID photos), AI ID scan, pre-arrival upsell + upgrade offer,
//                          welcome / checkout messages, in-stay requests → tasks
//   2. Houseboat Ops     — fleet details (bedrooms, deck, AC, trip rates), jetties + cruise plan,
//                          weather alerts (Open-Meteo), crew assignment, meal pre-order, pickup
//                          message + "boat ready" update, fuel / service log with service-due alerts
//   3. Revenue & Channel — two-way iCal sync with OTAs, pricing rules → suggestions the owner
//                          approves, competitor rates with drop alerts, daily owner summary
//   4. Housekeeping      — room status board, auto clean / prepare tasks, staff tasks, staff
//                          WhatsApp bot ("tasks", "done 12", "issue: AC leaking in Villa 2")
//   5. Reviews & Memory  — guest profiles (birthday, anniversary, preferences), post-stay rating →
//                          Google review link or manager alert, AI review replies, rebooking and
//                          birthday / anniversary offers
//   6. Agent Desk        — travel agents, WhatsApp agent quotes at net rates, allotments, commissions
//
// Isolation guarantees ("no change for existing clients"):
//   - Every feature is its own toggle in hosp_suite_settings and is OFF until switched on; a
//     client with nothing switched on gets no extra queries in the WhatsApp turn or the cron.
//   - Everything also requires hpEnabled(c) (Hospitality + Hospitality Pro both 'Yes').
//   - All data lives in new hosp_suite_* tables (migrations/0123_hospitality_suite.sql). Existing
//     hospitality_* tables are only written the way staff already write them by hand: blocked dates
//     (iCal imports / allotments — tracked in hosp_suite_blocks so only those are ever removed),
//     rate overrides (a pricing suggestion the owner approved), and an 'inquiry' booking for an
//     agent's booking request.
//   - Like hospitality-pro.js, this file imports nothing from worker.js; worker.js passes helpers
//     in as `deps` (HS_DEPS there), so it is unit-tested on its own against node:sqlite.
//
// deps shape: HP deps (json, requireSession, getClientById, reportOpsError, sendText, sendButtons,
//   sendPrivateNote, getLead, isTakeover) plus
//   findConversation(env,c,clientId,phone)→convId|null, sendTemplate(env,c,phone,name,lang,params),
//   readIdImage(env,url)→{name,id_type,id_number,dob,nationality}|null, aiText(env,system,user)→text|null,
//   razorpayLink(env,clientId,opts)→{url,id}|null, fetch and now() (optional, for tests).

import {
  hpEnabled, hpLoadConfig, hpAddDays, hpNightsBetween, hpLocalToday, hpIsQuietHour, hpFmtDate, hpFmtRange,
  hpFmtMoney, hpRound, hpParseDateRange, hpParseGuests, hpPhoneKey, hpNightlyRates, hpMatchByName, hpGetState, hpAddonAmount,
} from './hospitality-pro.js';

// ── Features (each its own toggle) ───────────────────────────────────────────────────────────────
export const HS_MODULES=[
  {key:'journey', label:'Guest Journey', features:{
    balance_reminders:'Balance reminders + payment links', refunds:'Payments & refunds ledger',
    web_checkin:'Web check-in on WhatsApp (ETA, preferences, IDs)', id_scan:'AI ID scan (reads ID photos)',
    prearrival_upsell:'Pre-arrival upsell + upgrade offer', stay_messages:'Welcome & checkout messages',
    instay_requests:'In-stay requests → staff tasks'}},
  {key:'houseboat', label:'Houseboat Operations', features:{
    fleet:'Fleet details & trip types', cruise_plan:'Jetties & cruise plan', weather_alerts:'Weather alerts',
    crew:'Crew assignment', meal_preorder:'Meal pre-order on WhatsApp', pickup:'Pickup & boat-ready updates',
    maintenance:'Fuel & maintenance tracker'}},
  {key:'revenue', label:'Revenue & Channels', features:{
    ical_sync:'iCal sync with OTAs', pricing_rules:'Smart pricing suggestions', competitor_rates:'Competitor rates & alerts',
    daily_summary:'Daily owner summary'}},
  {key:'housekeeping', label:'Housekeeping & Staff', features:{
    housekeeping:'Room status board & auto cleaning tasks', staff_tasks:'Staff tasks & maintenance tickets',
    staff_bot:'Staff WhatsApp task bot'}},
  {key:'reviews', label:'Reviews & Guest Memory', features:{
    guest_profiles:'Guest profiles (preferences, birthdays)', feedback:'Post-stay feedback → Google review',
    review_replies:'AI review replies', rebooking:'Rebooking offers', occasions:'Birthday & anniversary offers'}},
  {key:'agents', label:'Agent Desk', features:{
    agents:'Travel agent directory', agent_quotes:'Agent quotes on WhatsApp', allotments:'Agent allotments',
    commissions:'Commission ledger'}},
];
export const HS_FEATURES=HS_MODULES.flatMap(m=>Object.keys(m.features));
// A feature only works while the feature it builds on is on too.
const HS_REQUIRES={id_scan:'web_checkin', staff_bot:'staff_tasks', agent_quotes:'agents', allotments:'agents', commissions:'agents', occasions:'guest_profiles'};

export const HS_DEFAULT_CONFIG={
  balance_days:[7,1], upsell_days:3, checkin_days:2, meal_days:2,
  welcome_hour:12, welcome_text:'', checkout_hour:8, checkout_text:'', feedback_hour:15,
  pickup_hour:18, pickup_text:'', google_review_url:'',
  rebook_days:60, offer_pct:10, offer_text:'', occasion_days:7,
  template_name:'', template_lang:'en', owner_phone:'', summary_hour:9,
  weather_lat:null, weather_lng:null, rain_mm:20, wind_kmh:40,
  competitor_alert_pct:10, ical_sync_minutes:60, instay_reply:'',
};

function clamp(v, min, max, dflt){
  if(v===null || v===undefined || v==='') return dflt;
  const n=Number(v);
  return Number.isFinite(n)?Math.min(max, Math.max(min, n)):dflt;
}
const str=(v, n)=>String(v??'').trim().slice(0, n);

export function hsNormalizeConfig(raw){
  let src=raw;
  if(typeof raw==='string'){ try{ src=JSON.parse(raw||'{}'); }catch(e){ src={}; } }
  if(!src || typeof src!=='object') src={};
  const f=src.features&&typeof src.features==='object'?src.features:{};
  const features={};
  HS_FEATURES.forEach(k=>{ features[k]=f[k]===true; });
  const D=HS_DEFAULT_CONFIG;
  let days=Array.isArray(src.balance_days)?src.balance_days.map(Number).filter(n=>Number.isInteger(n) && n>=0 && n<=60).slice(0,3):[...D.balance_days];
  days=[...new Set(days)].sort((a,b)=>b-a);
  const lat=clamp(src.weather_lat, -90, 90, null), lng=clamp(src.weather_lng, -180, 180, null);
  return {
    features, balance_days:days,
    upsell_days:Math.round(clamp(src.upsell_days, 1, 30, D.upsell_days)),
    checkin_days:Math.round(clamp(src.checkin_days, 0, 30, D.checkin_days)),
    meal_days:Math.round(clamp(src.meal_days, 0, 14, D.meal_days)),
    welcome_hour:Math.round(clamp(src.welcome_hour, 0, 23, D.welcome_hour)), welcome_text:str(src.welcome_text, 800),
    checkout_hour:Math.round(clamp(src.checkout_hour, 0, 23, D.checkout_hour)), checkout_text:str(src.checkout_text, 800),
    feedback_hour:Math.round(clamp(src.feedback_hour, 0, 23, D.feedback_hour)),
    pickup_hour:Math.round(clamp(src.pickup_hour, 0, 23, D.pickup_hour)), pickup_text:str(src.pickup_text, 800),
    google_review_url:/^https?:\/\/\S+$/i.test(str(src.google_review_url, 500))?str(src.google_review_url, 500):'',
    rebook_days:Math.round(clamp(src.rebook_days, 7, 365, D.rebook_days)),
    offer_pct:clamp(src.offer_pct, 0, 50, D.offer_pct), offer_text:str(src.offer_text, 500),
    occasion_days:Math.round(clamp(src.occasion_days, 0, 30, D.occasion_days)),
    template_name:str(src.template_name, 120).replace(/[^a-z0-9_]/gi,'').toLowerCase(),
    template_lang:str(src.template_lang||'en', 10)||'en',
    owner_phone:str(src.owner_phone, 30),
    summary_hour:Math.round(clamp(src.summary_hour, 0, 23, D.summary_hour)),
    weather_lat:lat, weather_lng:lng,
    rain_mm:clamp(src.rain_mm, 1, 500, D.rain_mm), wind_kmh:clamp(src.wind_kmh, 5, 200, D.wind_kmh),
    competitor_alert_pct:clamp(src.competitor_alert_pct, 1, 90, D.competitor_alert_pct),
    ical_sync_minutes:Math.round(clamp(src.ical_sync_minutes, 15, 1440, D.ical_sync_minutes)),
    instay_reply:str(src.instay_reply, 400),
  };
}
export function hsOn(cfg, key){
  if(!cfg?.features?.[key]) return false;
  const need=HS_REQUIRES[key];
  return need?hsOn(cfg, need):true;
}
export function hsAnyOn(cfg){ return HS_FEATURES.some(k=>hsOn(cfg, k)); }

async function hsSettingsRow(env, cid){
  return await env.DB.prepare(`SELECT * FROM hosp_suite_settings WHERE client_id=?`).bind(Number(cid)).first();
}
export async function hsLoadConfig(env, cid){
  try{ return hsNormalizeConfig((await hsSettingsRow(env, cid))?.config_json||'{}'); }
  catch(e){ if(/no such table/i.test(String(e?.message))) return hsNormalizeConfig({}); throw e; }
}

// ── Small helpers ────────────────────────────────────────────────────────────────────────────────
const DAY=86400e3, HOUR=3600e3;
function localHour(nowMs, tz){ return new Date(nowMs+(Number(tz)||0)*60000).getUTCHours(); }
function firstName(name){
  const n=String(name||'').trim().split(/\s+/)[0]||'';
  return /^[+\d]/.test(n)?'':n;
}
function parseJson(s, dflt){ try{ const v=JSON.parse(s||''); return v??dflt; }catch(e){ return dflt; } }
async function all(env, sql, ...b){ return (await env.DB.prepare(sql).bind(...b).all()).results||[]; }
async function one(env, sql, ...b){ return await env.DB.prepare(sql).bind(...b).first(); }
async function run(env, sql, ...b){ return await env.DB.prepare(sql).bind(...b).run(); }
function randHex(n){ const a=new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a).map(x=>x.toString(16).padStart(2,'0')).join(''); }
// WhatsApp template parameters may not contain newlines, tabs or 4+ spaces in a row.
export function hsFlatten(text){
  return String(text||'').replace(/\*/g,'').replace(/\s*\n+\s*/g,' · ').replace(/\s{2,}/g,' ').trim().slice(0, 900);
}
// "2 pm", "14:30", "2.30pm", "around 3" → "14:00" style; null when no time is found.
export function hsParseTime(text){
  const s=String(text||'').toLowerCase();
  const m=s.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/);
  if(!m) return null;
  let h=Number(m[1]); const min=Number(m[2]||0);
  if(h>23 || min>59) return null;
  const ap=m[3]?m[3][0]:null;
  if(ap==='p' && h<12) h+=12;
  if(ap==='a' && h===12) h=0;
  if(!ap && !m[2] && h>=1 && h<=7) h+=12; // "around 3" for an arrival means afternoon
  return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
}
async function hsRunOnce(env, cid, job, date){
  const r=await run(env, `INSERT OR IGNORE INTO hosp_suite_runs (client_id, job, date) VALUES (?,?,?)`, Number(cid), job, date);
  return !!r.meta.changes;
}
async function hsAlert(env, cid, kind, title, body, ref, nowIso){
  if(ref){
    const dup=await one(env, `SELECT id FROM hosp_suite_alerts WHERE client_id=? AND kind=? AND ref=? LIMIT 1`, Number(cid), kind, String(ref));
    if(dup) return dup.id;
  }
  const r=await run(env, `INSERT INTO hosp_suite_alerts (client_id, kind, title, body, ref, status, created_at) VALUES (?,?,?,?,?,'open',?)`,
    Number(cid), kind, str(title, 200), str(body, 2000), str(ref, 200), nowIso);
  return r.meta.last_row_id;
}

// ── Suite booking rows (what was sent, check-in details, trip, agent) ───────────────────────────
async function hsBookingRow(env, cid, bookingId){
  return await one(env, `SELECT * FROM hosp_suite_booking WHERE booking_id=? AND client_id=?`, Number(bookingId), Number(cid));
}
async function hsUpsertBooking(env, cid, bookingId, patch, nowIso){
  const cols=Object.keys(patch);
  await run(env, `INSERT INTO hosp_suite_booking (booking_id, client_id, updated_at) VALUES (?,?,?) ON CONFLICT(booking_id) DO NOTHING`, Number(bookingId), Number(cid), nowIso);
  if(cols.length) await run(env, `UPDATE hosp_suite_booking SET ${cols.map(k=>`${k}=?`).join(', ')}, updated_at=? WHERE booking_id=? AND client_id=?`,
    ...cols.map(k=>patch[k]), nowIso, Number(bookingId), Number(cid));
}
async function hsMarkSent(env, cid, bookingId, keys, status, nowIso){
  const row=await hsBookingRow(env, cid, bookingId);
  const sent=parseJson(row?.sent_json, {});
  (Array.isArray(keys)?keys:[keys]).forEach(k=>{ sent[k]={s:status, at:nowIso}; });
  await hsUpsertBooking(env, cid, bookingId, {sent_json:JSON.stringify(sent)}, nowIso);
}

// ── Messaging: free text inside WhatsApp's 24h window, else the approved template, else an alert
//    so staff can send it by hand (the workspace shows a click-to-WhatsApp link) ────────────────
export async function hsContactFor(env, cid, {leadId=null, phone=''}){
  if(leadId){
    const r=await one(env, `SELECT * FROM hosp_suite_contacts WHERE client_id=? AND lead_id=?`, Number(cid), Number(leadId));
    if(r) return r;
  }
  const key=hpPhoneKey(phone);
  if(key.length>=6) return await one(env, `SELECT * FROM hosp_suite_contacts WHERE client_id=? AND phone_key=? ORDER BY last_inbound_at DESC LIMIT 1`, Number(cid), key);
  return null;
}
// to: {leadId, phone, name, convId}. Returns 'sent' | 'template' | 'skipped'.
export async function hsSend(env, deps, c, cid, cfg, to, text, buttons, nowMs=Date.now(), {alertRef=null, alertTitle='Message not sent'}={}){
  const contact=await hsContactFor(env, cid, to);
  const inWindow=!!contact && nowMs-Date.parse(contact.last_inbound_at)<23*HOUR;
  let convId=to.convId||contact?.conv_id||null;
  try{
    if(inWindow){
      if(!convId && to.phone && deps.findConversation) convId=await deps.findConversation(env, c, String(cid), to.phone).catch(()=>null);
      if(convId){
        if(buttons && buttons.length) await deps.sendButtons(env, c, String(cid), convId, text, buttons);
        else await deps.sendText(env, c, String(cid), convId, text);
        return 'sent';
      }
    }
    if(cfg.template_name && to.phone && deps.sendTemplate){
      await deps.sendTemplate(env, c, to.phone, cfg.template_name, cfg.template_lang, [firstName(to.name)||'there', hsFlatten(text)]);
      return 'template';
    }
  }catch(e){ await deps.reportOpsError?.(env, 'hospitalitySuite.send', e, {clientId:cid}).catch(()=>{}); }
  if(alertRef) await hsAlert(env, cid, 'unsent', `${alertTitle}${to.name?` — ${to.name}`:''}`, text, alertRef+(to.phone?`|${to.phone}`:''), new Date(nowMs).toISOString());
  return 'skipped';
}
function bookingTo(b){ return {leadId:b.lead_id||null, phone:b.guest_phone||'', name:b.guest_name||''}; }

// ── Suite conversation state ─────────────────────────────────────────────────────────────────────
const HS_STATE_TTL=7*DAY;
export async function hsGetState(env, cid, leadId, nowMs=Date.now()){
  const row=await one(env, `SELECT state_json, updated_at FROM hosp_suite_state WHERE client_id=? AND lead_id=?`, Number(cid), Number(leadId));
  if(!row) return null;
  const st=parseJson(row.state_json, null);
  if(!st?.flow || nowMs-Date.parse(row.updated_at)>HS_STATE_TTL) return null;
  return st;
}
export async function hsSaveState(env, cid, leadId, st, nowMs=Date.now()){
  await run(env, `INSERT INTO hosp_suite_state (client_id, lead_id, state_json, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(client_id, lead_id) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at`,
    Number(cid), Number(leadId), JSON.stringify(st), new Date(nowMs).toISOString());
}
export async function hsClearState(env, cid, leadId){
  await run(env, `DELETE FROM hosp_suite_state WHERE client_id=? AND lead_id=?`, Number(cid), Number(leadId));
}
// A guest flow only starts when the guest isn't already mid-way through another one (ours or Pro's).
async function hsFree(env, cid, leadId, nowMs){
  if(!leadId) return false;
  if(await hsGetState(env, cid, leadId, nowMs)) return false;
  if(await hpGetState(env, cid, leadId, nowMs).catch(()=>null)) return false;
  return true;
}

// ── Money per booking ────────────────────────────────────────────────────────────────────────────
export async function hsBookingMoney(env, cid, b){
  const pays=await all(env, `SELECT kind, amount, status FROM hosp_suite_payments WHERE client_id=? AND booking_id=?`, Number(cid), Number(b.id));
  const extras=await all(env, `SELECT amount, status FROM hosp_suite_extras WHERE client_id=? AND booking_id=? AND status IN ('requested','confirmed')`, Number(cid), Number(b.id));
  return hsMoneyOf(b, pays, extras);
}
export function hsMoneyOf(b, pays, extras){
  const cur=b.currency||'INR';
  const extrasTotal=(extras||[]).reduce((s,x)=>s+(Number(x.amount)||0), 0);
  const paid=(pays||[]).filter(p=>p.status==='paid' && p.kind!=='refund').reduce((s,p)=>s+(Number(p.amount)||0), 0);
  const refunded=(pays||[]).filter(p=>p.kind==='refund' && p.status!=='pending').reduce((s,p)=>s+(Number(p.amount)||0), 0);
  // A deposit taken through Hospitality Pro is already on the booking row; a ledger 'deposit' line
  // replaces it rather than counting twice.
  const ledgerDeposit=(pays||[]).some(p=>p.kind==='deposit');
  const received=hpRound(paid+(ledgerDeposit?0:Number(b.deposit_amount)||0), cur);
  const total=hpRound((Number(b.total_amount)||0)+extrasTotal, cur);
  return {total, extras:hpRound(extrasTotal, cur), received, refunded:hpRound(refunded, cur), balance:hpRound(Math.max(0, total-received), cur), currency:cur};
}

// ── iCal (OTA calendar sync) ─────────────────────────────────────────────────────────────────────
// Occupied nights from an iCal feed: every VEVENT's [DTSTART, DTEND) as YYYY-MM-DD dates, from
// today up to maxDays ahead. Handles folded lines, DATE and DATE-TIME values, and a missing DTEND.
export function hsIcalParse(text, today, maxDays=400){
  const lines=String(text||'').replace(/\r\n[ \t]/g,'').replace(/\n[ \t]/g,'').split(/\r?\n/);
  const dates=new Set(); let ev=null, events=0;
  const limit=hpAddDays(today, maxDays);
  const toIso=v=>{ const m=String(v||'').match(/(\d{4})(\d{2})(\d{2})/); return m?`${m[1]}-${m[2]}-${m[3]}`:null; };
  for(const line of lines){
    if(/^BEGIN:VEVENT/i.test(line)){ ev={}; continue; }
    if(/^END:VEVENT/i.test(line)){
      if(ev?.start && !/CANCELLED/i.test(ev.status||'')){
        let end=ev.end && ev.end>ev.start?ev.end:hpAddDays(ev.start, 1);
        if(end>limit) end=limit;
        let d=ev.start<today?today:ev.start, n=0;
        for(; d<end && n<400; d=hpAddDays(d, 1), n++) dates.add(d);
        if(n) events++;
      }
      ev=null; continue;
    }
    if(!ev) continue;
    const m=line.match(/^(DTSTART|DTEND|STATUS)(?:;[^:]*)?:(.*)$/i);
    if(!m) continue;
    const k=m[1].toUpperCase();
    if(k==='DTSTART') ev.start=toIso(m[2]);
    else if(k==='DTEND') ev.end=toIso(m[2]);
    else ev.status=m[2];
  }
  return {dates:[...dates].sort(), events};
}
function icalDate(iso){ return iso.replace(/-/g,''); }
function icalEsc(s){ return String(s||'').replace(/[\;,]/g, m=>'\\'+m).replace(/\n/g,'\\n'); }
// Export feed for one unit: bookings plus runs of blocked dates, as all-day events. Guest names are
// left out on purpose — OTAs only need "not available".
export function hsIcalExport({unit, bookings, blockedDates, nowIso}){
  const stamp=nowIso.replace(/[-:]/g,'').replace(/\.\d+/,'');
  const L=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Leadvyne//Hospitality//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH',`X-WR-CALNAME:${icalEsc(unit.name)}`];
  const ev=(uid, s, e, summary)=>L.push('BEGIN:VEVENT', `UID:${uid}@leadvyne`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${icalDate(s)}`, `DTEND;VALUE=DATE:${icalDate(e)}`, `SUMMARY:${icalEsc(summary)}`, 'END:VEVENT');
  for(const b of bookings||[]) ev(`b${b.id}-u${unit.id}`, b.check_in, b.check_out, 'Booked');
  const ds=[...new Set(blockedDates||[])].sort();
  for(let i=0;i<ds.length;){
    let j=i; while(j+1<ds.length && ds[j+1]===hpAddDays(ds[j], 1)) j++;
    ev(`x${unit.id}-${ds[i]}`, ds[i], hpAddDays(ds[j], 1), 'Not available');
    i=j+1;
  }
  L.push('END:VCALENDAR');
  return L.join('\r\n')+'\r\n';
}

// ── Smart pricing ────────────────────────────────────────────────────────────────────────────────
// Rules → suggested nightly rate per unit per date. Starts from the unit's own base / weekend rate
// (ignoring overrides) and adds up every matching rule's %. Only dates where at least one rule
// matched AND the result differs from today's effective rate become suggestions, so a manual
// override the owner set by hand is never "suggested away" by an empty rule set.
//   weekend      Fri & Sat nights              season / event  start_date..end_date
//   high_demand  occupancy ≥ threshold %       last_minute     ≤ days away AND occupancy < threshold %
export function hsSuggestPrices({units, rules, overrides={}, occupancy={}, today, days=60}){
  const out=[];
  const act=(rules||[]).filter(r=>r.active!==0 && r.active!==false);
  for(const u of units||[]){
    const ov=overrides[u.id]||{};
    for(let i=0;i<days;i++){
      const d=hpAddDays(today, i);
      const base=hpNightlyRates(u, {}, d, hpAddDays(d, 1))[0].rate;
      if(!base) continue;
      const dow=new Date(d+'T00:00:00Z').getUTCDay();
      const occ=Number(occupancy[d])||0;
      let pct=0; const why=[];
      for(const r of act){
        if(r.unit_id && Number(r.unit_id)!==Number(u.id)) continue;
        let hit=false;
        if(r.kind==='weekend') hit=dow===5||dow===6;
        else if(r.kind==='season'||r.kind==='event') hit=!!r.start_date && d>=r.start_date && d<=(r.end_date||r.start_date);
        else if(r.kind==='high_demand') hit=occ>=Number(r.threshold||0);
        else if(r.kind==='last_minute') hit=i<=Number(r.days||0) && occ<Number(r.threshold||100);
        if(hit){ pct+=Number(r.pct)||0; why.push(`${r.name||r.kind} ${Number(r.pct)>0?'+':''}${Number(r.pct)}%`); }
      }
      if(!why.length) continue;
      const suggested=Math.max(0, Math.round(base*(1+pct/100)/10)*10);
      const current=ov[d]!==undefined?Number(ov[d]):base;
      if(suggested===Math.round(current)) continue;
      out.push({unit_id:u.id, date:d, current_rate:current, suggested_rate:suggested, reason:why.join(', ')});
    }
  }
  return out;
}
// Booked share of active units per date, 0–100.
export function hsOccupancyMap(bookings, unitCount, from, days){
  const m={};
  for(let i=0;i<days;i++) m[hpAddDays(from, i)]=0;
  for(const b of bookings||[]){
    for(let d=b.check_in<from?from:b.check_in; d<b.check_out; d=hpAddDays(d, 1)){ if(d in m) m[d]++; else break; }
  }
  for(const k in m) m[k]=unitCount?Math.round(m[k]/unitCount*100):0;
  return m;
}

// ── Daily summary (plain language, deterministic) ───────────────────────────────────────────────
export function hsSummaryText(s){
  const cur=s.currency||'INR';
  const L=[`📊 ${hpFmtDate(s.today)} — ${s.name||'Your property'}`];
  L.push(`🛬 ${s.arrivals} arriving · 🛫 ${s.departures} leaving · 🏠 ${s.inHouse} in-house today`);
  const diff=s.occNext7-s.occPrev7;
  let occ=`📈 Next 7 days: ${s.occNext7}% booked`;
  if(Math.abs(diff)>=5) occ+=` (${diff>0?'up':'down'} ${Math.abs(diff)} pts vs last 7 days)`;
  L.push(occ);
  if(s.occNext7<40) L.push(`💡 Occupancy is low next week — consider a weekday offer or a last-minute pricing rule.`);
  else if(s.occNext7>=85) L.push(`💡 Almost full next week — a good time to raise rates on the remaining dates.`);
  L.push(`💰 Revenue this month: ${hpFmtMoney(s.revenueMtd, cur)}`);
  if(s.balanceDue>0) L.push(`💳 Balances still due for the next 7 days: ${hpFmtMoney(s.balanceDue, cur)}`);
  if(s.openTasks) L.push(`🧹 ${s.openTasks} open task${s.openTasks===1?'':'s'}`);
  if(s.openAlerts) L.push(`⚠️ ${s.openAlerts} alert${s.openAlerts===1?'':'s'} waiting`);
  if(s.pendingSugg) L.push(`🏷️ ${s.pendingSugg} price suggestion${s.pendingSugg===1?'':'s'} to review`);
  if(s.lowRatings) L.push(`😟 ${s.lowRatings} low guest rating${s.lowRatings===1?'':'s'} in the last 7 days`);
  return L.join('\n');
}

// ── Cruise plan (houseboats) ─────────────────────────────────────────────────────────────────────
// trip_type: day_cruise | overnight | night_stay. Times come from the jetty's own windows.
export function hsCruisePlan(trip, jetty){
  const j=jetty||{boarding_time:'12:00', cruise_start:'12:00', cruise_end:'17:30', checkout_time:'09:00'};
  const board=trip.boarding_time||j.boarding_time;
  if(trip.trip_type==='day_cruise') return [
    {at:board, what:'Boarding'}, {at:j.cruise_start, what:'Cruise starts'}, {at:'13:00', what:'Lunch on board'}, {at:j.cruise_end, what:'Back at jetty'}];
  if(trip.trip_type==='night_stay') return [
    {at:board>='17:00'?board:'17:30', what:'Boarding (anchored stay, no cruising)'}, {at:'20:00', what:'Dinner'}, {at:'08:00', what:'Breakfast', next:true}, {at:j.checkout_time, what:'Check-out', next:true}];
  return [
    {at:board, what:'Boarding & welcome drink'}, {at:j.cruise_start, what:'Cruise starts'}, {at:'13:00', what:'Lunch on board'},
    {at:j.cruise_end, what:'Anchor for the night'}, {at:'20:00', what:'Dinner'}, {at:'08:00', what:'Breakfast', next:true},
    {at:j.checkout_time, what:'Check-out at jetty', next:true}];
}

// ── Cron (worker.js "*/15 * * * *" tick) ────────────────────────────────────────────────────────
export async function hsRunForAllClients(env, deps, nowMs=Date.now()){
  let rows=[];
  try{ rows=await all(env, `SELECT client_id, config_json FROM hosp_suite_settings`); }
  catch(e){ if(!/no such table/i.test(String(e?.message))) console.error('[hospitality-suite] sweep query failed', e?.message); return; }
  for(const row of rows){
    if(!hsAnyOn(hsNormalizeConfig(row.config_json))) continue;
    try{ await hsRunForClient(env, deps, row.client_id, nowMs); }
    catch(e){ await deps.reportOpsError?.(env, 'hospitalitySuite.sweep', e, {clientId:row.client_id}).catch(()=>{}); }
  }
}

export async function hsRunForClient(env, deps, clientId, nowMs=Date.now()){
  const cid=Number(clientId);
  const c=await deps.getClientById(env, cid);
  if(!hpEnabled(c)) return;
  const cfg=await hsLoadConfig(env, cid);
  if(!hsAnyOn(cfg)) return;
  const pro=await hpLoadConfig(env, cid);
  const tz=pro.tz_offset_min;
  const today=hpLocalToday(nowMs, tz), hour=localHour(nowMs, tz);
  const nowIso=new Date(nowMs).toISOString();
  const quiet=hpIsQuietHour(nowMs, pro);
  const ctx={env, deps, c, cid, cfg, pro, today, hour, nowMs, nowIso, quiet, weather:new Map()};

  const lookahead=Math.max(...cfg.balance_days, cfg.upsell_days, cfg.checkin_days, cfg.meal_days, 2);
  const bookings=await all(env, `SELECT * FROM hospitality_bookings WHERE client_id=? AND status IN ('confirmed','checked_in','checked_out')
      AND check_in<=? AND check_out>=? ORDER BY check_in ASC LIMIT 500`, cid, hpAddDays(today, lookahead), hpAddDays(today, -2));
  const units=await all(env, `SELECT * FROM hospitality_units WHERE client_id=?`, cid);
  ctx.unitById=new Map(units.map(u=>[Number(u.id), u]));

  if(!quiet){
    for(const b of bookings){
      try{ await hsBookingJobs(ctx, b); }
      catch(e){ await deps.reportOpsError?.(env, 'hospitalitySuite.bookingJobs', e, {clientId:cid, bookingId:b.id}).catch(()=>{}); }
    }
    if(hsOn(cfg, 'rebooking')) await hsRebookJob(ctx).catch(e=>deps.reportOpsError?.(env, 'hospitalitySuite.rebook', e, {clientId:cid}));
    if(hsOn(cfg, 'occasions')) await hsOccasionJob(ctx).catch(e=>deps.reportOpsError?.(env, 'hospitalitySuite.occasions', e, {clientId:cid}));
  }
  if(hsOn(cfg, 'housekeeping')) await hsHousekeepingJob(ctx, bookings).catch(e=>deps.reportOpsError?.(env, 'hospitalitySuite.housekeeping', e, {clientId:cid}));
  if(hsOn(cfg, 'maintenance')) await hsMaintenanceJob(ctx).catch(e=>deps.reportOpsError?.(env, 'hospitalitySuite.maintenance', e, {clientId:cid}));
  if(hsOn(cfg, 'ical_sync')) await hsIcalSyncDue(ctx).catch(e=>deps.reportOpsError?.(env, 'hospitalitySuite.ical', e, {clientId:cid}));
  if(hsOn(cfg, 'allotments')) await hsAllotmentReleaseJob(ctx).catch(e=>deps.reportOpsError?.(env, 'hospitalitySuite.allotments', e, {clientId:cid}));
  if(hsOn(cfg, 'pricing_rules') && hour>=5 && await hsRunOnce(env, cid, 'pricing', today))
    await hsGenerateSuggestions(env, cid, today).catch(e=>deps.reportOpsError?.(env, 'hospitalitySuite.pricing', e, {clientId:cid}));
  if(hsOn(cfg, 'daily_summary') && hour>=cfg.summary_hour && await hsRunOnce(env, cid, 'summary', today))
    await hsDailySummary(ctx, true).catch(e=>deps.reportOpsError?.(env, 'hospitalitySuite.summary', e, {clientId:cid}));
}

// Per-booking guest messages. At most one conversation flow is started per booking per tick.
async function hsBookingJobs(ctx, b){
  const {env, cid, cfg, today, hour}=ctx;
  const row=await hsBookingRow(env, cid, b.id);
  const sent=parseJson(row?.sent_json, {});
  const daysTo=hpNightsBetween(today, b.check_in);
  const upcoming=b.status==='confirmed' && daysTo>=0;
  const send=(text, buttons, ref, title)=>hsSend(env, ctx.deps, ctx.c, cid, cfg, bookingTo(b), text, buttons, ctx.nowMs, {alertRef:ref, alertTitle:title});

  if(hsOn(cfg, 'balance_reminders') && upcoming){
    const due=cfg.balance_days.filter(d=>daysTo<=d && !sent['bal_'+d]);
    if(due.length){
      const money=await hsBookingMoney(env, cid, b);
      if(money.balance>0) await hsSendBalance(ctx, b, money, `bal:${b.id}`);
      await hsMarkSent(env, cid, b.id, due.map(d=>'bal_'+d), money.balance>0?'sent':'none', ctx.nowIso);
    }
  }
  if(hsOn(cfg, 'pickup') && upcoming && !sent.pickup && (daysTo===0 || (daysTo===1 && hour>=cfg.pickup_hour))){
    const text=await hsPickupText(ctx, b, row);
    if(text){ const s=await send(text, null, `pickup:${b.id}`, 'Pickup details not sent'); await hsMarkSent(env, cid, b.id, 'pickup', s, ctx.nowIso); }
    else await hsMarkSent(env, cid, b.id, 'pickup', 'none', ctx.nowIso);
  }
  if(hsOn(cfg, 'weather_alerts') && upcoming && daysTo<=2 && !sent.weather){
    const w=await hsWeatherFor(ctx, b, row);
    if(w){
      if(w.bad){
        const unit=ctx.unitById.get(Number(b.unit_id));
        await hsAlert(env, cid, 'weather', `Weather warning for ${b.guest_name||'guest'} on ${hpFmtDate(b.check_in)}`, `${unit?.name||''}: ${w.text}`, `weather:${b.id}`, ctx.nowIso);
        const free=await hsFree(env, cid, b.lead_id, ctx.nowMs);
        const msg=`🌧️ Weather update for your trip on *${hpFmtDate(b.check_in)}*: ${w.text}.\n\nSafety comes first — we'll keep you posted. Would you like to keep your plan or talk about new dates?`;
        const s=await send(msg, [{title:'👍 Keep my plan', value:'keep my plan'}, {title:'📅 Reschedule', value:'reschedule'}], `weather:${b.id}`, 'Weather alert not sent');
        if(free && s!=='skipped') await hsSaveState(env, cid, b.lead_id, {flow:'weather', booking_id:b.id}, ctx.nowMs);
      }
      await hsMarkSent(env, cid, b.id, 'weather', w.bad?'sent':'clear', ctx.nowIso);
    }
  }
  if(b.check_in===today && hsOn(cfg, 'stay_messages') && !sent.welcome && hour>=cfg.welcome_hour && b.status!=='checked_out'){
    const unit=ctx.unitById.get(Number(b.unit_id));
    const text=`🌴 Welcome${firstName(b.guest_name)?`, ${firstName(b.guest_name)}`:''}! We're so happy to host you at *${unit?.name||'our property'}* today.${cfg.welcome_text?`\n\n${cfg.welcome_text}`:''}\n\nNeed anything during your stay? Just message us here.`;
    await hsMarkSent(env, cid, b.id, 'welcome', await send(text, null, `welcome:${b.id}`, 'Welcome message not sent'), ctx.nowIso);
  }
  if(b.check_out===today && hsOn(cfg, 'stay_messages') && !sent.checkout && hour>=cfg.checkout_hour && b.status!=='checked_out'){
    const money=await hsBookingMoney(env, cid, b);
    const text=`☀️ Good morning! Today is check-out day.${cfg.checkout_text?`\n\n${cfg.checkout_text}`:''}\n\n🧾 Total: ${hpFmtMoney(money.total, money.currency)}\n✅ Paid: ${hpFmtMoney(money.received, money.currency)}${money.balance>0?`\n💳 Balance: *${hpFmtMoney(money.balance, money.currency)}*`:''}\n\nThank you for staying with us! 🙏`;
    await hsMarkSent(env, cid, b.id, 'checkout', await send(text, null, `checkout:${b.id}`, 'Checkout message not sent'), ctx.nowIso);
  }

  // Conversation flows (one at a time, only when the guest isn't mid-way through another).
  if(!b.lead_id || !await hsFree(env, cid, b.lead_id, ctx.nowMs)) return;
  if(hsOn(cfg, 'feedback') && !sent.feedback && b.status!=='cancelled'
    && ((b.check_out===today && hour>=cfg.feedback_hour) || (b.check_out<today && b.check_out>=hpAddDays(today, -2)))){
    const s=await send(`Thank you for staying with us${firstName(b.guest_name)?`, ${firstName(b.guest_name)}`:''}! 🙏\n\nHow was your stay? Please rate us from 1 to 5 ⭐`,
      [{title:'⭐⭐⭐⭐⭐ 5', value:'5'}, {title:'⭐⭐⭐⭐ 4', value:'4'}, {title:'⭐⭐⭐ 3', value:'3'}, {title:'⭐⭐ 2', value:'2'}, {title:'⭐ 1', value:'1'}], null);
    await hsMarkSent(env, cid, b.id, 'feedback', s, ctx.nowIso);
    if(s!=='skipped') await hsSaveState(env, cid, b.lead_id, {flow:'feedback', booking_id:b.id}, ctx.nowMs);
    return;
  }
  if(!upcoming) return;
  if(hsOn(cfg, 'web_checkin') && !sent.checkin && daysTo<=cfg.checkin_days && row?.checkin_status!=='done'){
    const s=await send(`📋 *Express check-in* for ${hpFmtRange(b.check_in, b.check_out)}\n\nSave time at arrival — 3 quick questions here on WhatsApp.\n\n🕑 First: what time will you arrive?`,
      HS_ETA_BUTTONS, `checkin:${b.id}`, 'Check-in invite not sent');
    await hsMarkSent(env, cid, b.id, 'checkin', s, ctx.nowIso);
    if(s!=='skipped') await hsSaveState(env, cid, b.lead_id, {flow:'checkin', step:'eta', booking_id:b.id}, ctx.nowMs);
    return;
  }
  if(hsOn(cfg, 'prearrival_upsell') && !sent.upsell && daysTo<=cfg.upsell_days && daysTo>=1){
    const offer=await hsUpsellOffer(ctx, b);
    if(offer.buttons.length){
      const s=await send(offer.text, offer.buttons, null);
      await hsMarkSent(env, cid, b.id, 'upsell', s, ctx.nowIso);
      if(s!=='skipped') await hsSaveState(env, cid, b.lead_id, {flow:'upsell', booking_id:b.id, upgrade:offer.upgrade||null}, ctx.nowMs);
      return;
    }
    await hsMarkSent(env, cid, b.id, 'upsell', 'none', ctx.nowIso);
  }
  if(hsOn(cfg, 'meal_preorder') && !sent.meal && daysTo<=cfg.meal_days){
    const meals=await hsMealsFor(env, cid);
    if(!meals.length){ await hsMarkSent(env, cid, b.id, 'meal', 'none', ctx.nowIso); return; }
    const st={flow:'meal', booking_id:b.id, meals:meals.map(m=>m.meal), idx:0, picked:{}};
    const first=await hsMealPrompt(env, cid, st, true);
    const s=await send(first.text, first.buttons, `meal:${b.id}`, 'Meal menu not sent');
    await hsMarkSent(env, cid, b.id, 'meal', s, ctx.nowIso);
    if(s!=='skipped') await hsSaveState(env, cid, b.lead_id, st, ctx.nowMs);
  }
}
const HS_ETA_BUTTONS=[{title:'Before 12 PM', value:'11:00'}, {title:'12 – 3 PM', value:'13:30'}, {title:'3 – 6 PM', value:'16:30'}, {title:'After 6 PM', value:'19:00'}];

async function hsSendBalance(ctx, b, money, ref){
  const {env, deps, cid, cfg, pro, nowMs, nowIso}=ctx;
  let url=null;
  if(pro.payment_mode==='razorpay' && deps.razorpayLink){
    const link=await deps.razorpayLink(env, cid, {amount:money.balance, currency:money.currency, name:b.guest_name, phone:b.guest_phone,
      description:`Balance for booking #${b.id} (${b.check_in} → ${b.check_out})`, expiresAt:new Date(nowMs+7*DAY).toISOString(),
      notes:{kind:'hosp_suite_balance', client_id:String(cid), booking_id:String(b.id)}}).catch(()=>null);
    if(link?.url){ url=link.url; await hsUpsertBooking(env, cid, b.id, {payment_url:link.url, payment_link_id:link.id||null}, nowIso); }
  }
  const days=hpNightsBetween(ctx.today, b.check_in);
  const L=[`Hi${firstName(b.guest_name)?` ${firstName(b.guest_name)}`:''}! 🌴 Your stay is ${days===0?'*today*':days===1?'*tomorrow*':`in *${days} days*`} (${hpFmtRange(b.check_in, b.check_out)}).`, '',
    `💳 Balance due: *${hpFmtMoney(money.balance, money.currency)}*`];
  if(url) L.push(`Pay securely here: ${url}`);
  else if(pro.payment_instructions) L.push(pro.payment_instructions);
  else L.push(`You can pay at check-in, or reply here for payment details.`);
  L.push('', `Reply *PAID* once done. See you soon! 🙌`);
  return await hsSend(env, deps, ctx.c, cid, cfg, bookingTo(b), L.join('\n'), null, nowMs, {alertRef:ref, alertTitle:'Balance reminder not sent'});
}

async function hsPickupText(ctx, b, row){
  const {env, cid, cfg}=ctx;
  const fleet=await one(env, `SELECT jetty_id FROM hosp_suite_fleet WHERE unit_id=? AND client_id=?`, Number(b.unit_id), cid);
  const jettyId=row?.jetty_id||fleet?.jetty_id;
  const jetty=jettyId?await one(env, `SELECT * FROM hosp_suite_jetties WHERE id=? AND client_id=?`, Number(jettyId), cid):null;
  if(!jetty && !cfg.pickup_text) return null;
  const unit=ctx.unitById.get(Number(b.unit_id));
  const crew=await all(env, `SELECT s.name, s.role, s.phone FROM hosp_suite_crew_assign a JOIN hosp_suite_staff s ON s.id=a.staff_id WHERE a.client_id=? AND a.booking_id=? AND s.role IN ('driver','manager')`, cid, b.id);
  const L=[`🚤 *Your pickup details* — ${hpFmtDate(b.check_in)}`, `🏡 ${unit?.name||''}`];
  if(jetty){
    L.push(`📍 Boarding point: *${jetty.name}*${jetty.map_url?`\n${jetty.map_url}`:''}`);
    L.push(`🕑 Boarding time: *${row?.boarding_time||jetty.boarding_time}*`);
    if(jetty.notes) L.push(jetty.notes);
  }
  crew.forEach(x=>L.push(`👤 ${x.role==='driver'?'Captain':'Contact'}: ${x.name}${x.phone?` (${x.phone})`:''}`));
  if(row?.eta) L.push(`We have your arrival time as ${row.eta}.`);
  if(cfg.pickup_text) L.push('', cfg.pickup_text);
  L.push('', `We'll message you here when your boat is ready. Safe travels! 🙏`);
  return L.join('\n');
}

async function hsWeatherFor(ctx, b, row){
  const {env, cid, cfg, deps}=ctx;
  let lat=cfg.weather_lat, lng=cfg.weather_lng;
  const fleet=await one(env, `SELECT jetty_id FROM hosp_suite_fleet WHERE unit_id=? AND client_id=?`, Number(b.unit_id), cid);
  const jettyId=row?.jetty_id||fleet?.jetty_id;
  if(jettyId){ const j=await one(env, `SELECT lat, lng FROM hosp_suite_jetties WHERE id=? AND client_id=?`, Number(jettyId), cid); if(j?.lat!=null && j?.lng!=null){ lat=j.lat; lng=j.lng; } }
  if(lat==null || lng==null) return null;
  const key=`${lat},${lng}`;
  if(!ctx.weather.has(key)) ctx.weather.set(key, await hsForecast(deps, lat, lng).catch(()=>null));
  const fc=ctx.weather.get(key);
  if(!fc) return null;
  const i=fc.time.indexOf(b.check_in);
  if(i<0) return null;
  const rain=Number(fc.rain[i])||0, wind=Number(fc.wind[i])||0;
  const bad=rain>=cfg.rain_mm || wind>=cfg.wind_kmh;
  const parts=[];
  if(rain>=cfg.rain_mm) parts.push(`heavy rain expected (~${Math.round(rain)} mm)`);
  if(wind>=cfg.wind_kmh) parts.push(`strong winds (up to ${Math.round(wind)} km/h)`);
  return {bad, rain, wind, text:parts.join(' and ')||'clear'};
}
export async function hsForecast(deps, lat, lng){
  const f=deps.fetch||fetch;
  const r=await f(`https://api.open-meteo.com/v1/forecast?latitude=${Number(lat)}&longitude=${Number(lng)}&daily=precipitation_sum,wind_speed_10m_max,weather_code&timezone=auto&forecast_days=7`);
  if(!r.ok) return null;
  const d=(await r.json())?.daily;
  if(!d?.time) return null;
  return {time:d.time, rain:d.precipitation_sum||[], wind:d.wind_speed_10m_max||[], code:d.weather_code||[]};
}

// Add-ons not on the booking yet, plus an upgrade to the cheapest pricier unit that is free.
async function hsUpsellOffer(ctx, b){
  const {env, cid}=ctx;
  const addons=await all(env, `SELECT * FROM hosp_pro_addons WHERE client_id=? AND active=1 ORDER BY sort_order ASC, id ASC`, cid);
  const have=new Set((await all(env, `SELECT addon_id FROM hosp_suite_extras WHERE client_id=? AND booking_id=?`, cid, b.id)).map(x=>Number(x.addon_id)));
  const list=addons.filter(a=>!have.has(Number(a.id)) && !String(b.notes||'').includes(a.name)).slice(0, 8);
  const unit=ctx.unitById.get(Number(b.unit_id));
  let upgrade=null;
  if(unit){
    const nights=hpNightsBetween(b.check_in, b.check_out)||1;
    const cands=[...ctx.unitById.values()].filter(u=>u.active && Number(u.id)!==Number(unit.id) && Number(u.base_rate)>Number(unit.base_rate)
      && Number(u.capacity_adults)>=Number(b.adults||1)).sort((x,y)=>x.base_rate-y.base_rate);
    for(const u of cands){
      const clash=await one(env, `SELECT id FROM hospitality_bookings WHERE client_id=? AND unit_id=? AND status IN ('confirmed','checked_in','checked_out') AND check_in<? AND check_out>? LIMIT 1`, cid, u.id, b.check_out, b.check_in);
      const blocked=await one(env, `SELECT id FROM hospitality_blocked_dates WHERE unit_id=? AND date>=? AND date<? LIMIT 1`, u.id, b.check_in, b.check_out);
      if(clash || blocked) continue;
      const extra=hpRound((Number(u.base_rate)-Number(unit.base_rate))*nights, b.currency||'INR');
      upgrade={unit_id:u.id, name:u.name, amount:extra};
      break;
    }
  }
  const cur=b.currency||'INR';
  const L=[`✨ Your stay is coming up on *${hpFmtDate(b.check_in)}*! Want to make it extra special?`, ''];
  list.forEach(a=>L.push(`• *${a.name}* — ${hpFmtMoney(a.price, a.currency||cur)}${a.description?` · ${a.description}`:''}`));
  if(upgrade) L.push(`• ⬆️ *Upgrade to ${upgrade.name}* — just ${hpFmtMoney(upgrade.amount, cur)} more`);
  L.push('', 'Tap to add — we\'ll get it ready for you.');
  const buttons=list.map(a=>({title:a.name, value:a.name}));
  if(upgrade) buttons.push({title:`⬆️ Upgrade`, value:'upgrade'});
  if(buttons.length) buttons.push({title:'No thanks', value:'no thanks'});
  return {text:L.join('\n'), buttons:buttons.slice(0, 10), upgrade};
}

const HS_MEAL_ORDER=['breakfast','lunch','snacks','dinner'];
async function hsMealsFor(env, cid){
  const rows=await all(env, `SELECT DISTINCT meal FROM hosp_suite_menu WHERE client_id=? AND active=1`, cid);
  return rows.sort((a,b)=>HS_MEAL_ORDER.indexOf(a.meal)-HS_MEAL_ORDER.indexOf(b.meal));
}
async function hsMealPrompt(env, cid, st, intro){
  const meal=st.meals[st.idx];
  const items=await all(env, `SELECT * FROM hosp_suite_menu WHERE client_id=? AND meal=? AND active=1 ORDER BY sort_order ASC, id ASC LIMIT 9`, cid, meal);
  const label=meal[0].toUpperCase()+meal.slice(1);
  const L=[];
  if(intro) L.push(`🍛 *Pre-order your meals on board* — our cook will prepare your Kerala favourites fresh.`, '');
  L.push(`*${label}* — tap everything you'd like:`);
  items.forEach(i=>L.push(`• ${i.veg?'🟢':'🔴'} ${i.name}${Number(i.price)?` (+${hpFmtMoney(i.price)})`:''}`));
  return {text:L.join('\n'), buttons:[...items.map(i=>({title:i.name, value:i.name})), {title:'✅ Done', value:'done'}], items};
}

async function hsRebookJob(ctx){
  const {env, cid, cfg, today}=ctx;
  const from=hpAddDays(today, -cfg.rebook_days-3), to=hpAddDays(today, -cfg.rebook_days);
  const rows=await all(env, `SELECT * FROM hospitality_bookings WHERE client_id=? AND status IN ('checked_out','confirmed') AND check_out>=? AND check_out<=? LIMIT 50`, cid, from, to);
  for(const b of rows){
    const row=await hsBookingRow(env, cid, b.id);
    if(parseJson(row?.sent_json, {}).rebook) continue;
    const future=await one(env, `SELECT id FROM hospitality_bookings WHERE client_id=? AND guest_phone=? AND check_in>? AND status IN ('confirmed','checked_in') LIMIT 1`, cid, b.guest_phone, today);
    let s='none';
    if(!future){
      const text=`Hi${firstName(b.guest_name)?` ${firstName(b.guest_name)}`:''}! 🌴 We miss having you with us. Come back for another getaway — as a returning guest you get *${cfg.offer_pct}% off* your next stay.${cfg.offer_text?`\n\n${cfg.offer_text}`:''}\n\nReply with your dates and we'll check availability!`;
      s=await hsSend(env, ctx.deps, ctx.c, cid, cfg, bookingTo(b), text, null, ctx.nowMs);
    }
    await hsMarkSent(env, cid, b.id, 'rebook', s, ctx.nowIso);
  }
}

async function hsOccasionJob(ctx){
  const {env, cid, cfg, today}=ctx;
  const year=today.slice(0,4);
  const window=new Set(Array.from({length:cfg.occasion_days+1}, (_, i)=>hpAddDays(today, i).slice(5)));
  const guests=await all(env, `SELECT * FROM hosp_suite_guests WHERE client_id=? AND (birthday<>'' OR anniversary<>'') LIMIT 2000`, cid);
  for(const g of guests){
    const sentMap=parseJson(g.occasion_sent_json, {});
    for(const kind of ['birthday','anniversary']){
      const md=g[kind];
      if(!md || !window.has(md) || sentMap[`${kind}:${year}`]) continue;
      sentMap[`${kind}:${year}`]=ctx.nowIso;
      await run(env, `UPDATE hosp_suite_guests SET occasion_sent_json=?, updated_at=? WHERE client_id=? AND phone_key=?`, JSON.stringify(sentMap), ctx.nowIso, cid, g.phone_key);
      const what=kind==='birthday'?'🎂 birthday':'💍 anniversary';
      const text=`Hi${firstName(g.name)?` ${firstName(g.name)}`:''}! Your ${what} is coming up — celebrate it with us! 🎉 Enjoy *${cfg.offer_pct}% off* a stay around your special day.${cfg.offer_text?`\n\n${cfg.offer_text}`:''}\n\nReply with your dates and we'll plan something special.`;
      await hsSend(env, ctx.deps, ctx.c, cid, cfg, {phone:g.phone, name:g.name}, text, null, ctx.nowMs);
    }
  }
}

// Clean tasks for today's departures, prepare tasks for today's and tomorrow's arrivals.
export async function hsHousekeepingJob(ctx, bookings){
  const {env, cid, today, nowIso}=ctx;
  const tomorrow=hpAddDays(today, 1);
  const arrivingToday=new Set(bookings.filter(b=>b.check_in===today && b.status!=='checked_out').map(b=>Number(b.unit_id)));
  for(const b of bookings){
    const unit=ctx.unitById.get(Number(b.unit_id));
    if(!unit) continue;
    if(b.check_out===today){
      const r=await run(env, `INSERT OR IGNORE INTO hosp_suite_tasks (client_id, kind, title, unit_id, booking_id, priority, status, due_date, source, notes, auto_key, created_at, updated_at)
        VALUES (?,?,?,?,?,?,'open',?,'auto',?,?,?,?)`, cid, 'housekeeping', `Clean ${unit.name} after check-out`, unit.id, b.id,
        arrivingToday.has(Number(unit.id))?'urgent':'normal', today, arrivingToday.has(Number(unit.id))?'Same-day arrival — clean first':'', `clean:${b.id}`, nowIso, nowIso);
      if(r.meta.changes) await run(env, `INSERT INTO hosp_suite_room_status (unit_id, client_id, status, note, updated_at) VALUES (?,?,'dirty','',?)
        ON CONFLICT(unit_id) DO UPDATE SET status='dirty', updated_at=excluded.updated_at`, unit.id, cid, nowIso);
    }
    if((b.check_in===today || b.check_in===tomorrow) && b.status==='confirmed'){
      const row=await hsBookingRow(env, cid, b.id);
      const notes=[row?.eta?`ETA ${row.eta}`:'', row?.preferences||''].filter(Boolean).join(' · ');
      await run(env, `INSERT OR IGNORE INTO hosp_suite_tasks (client_id, kind, title, unit_id, booking_id, priority, status, due_date, source, notes, auto_key, created_at, updated_at)
        VALUES (?,?,?,?,?,?,'open',?,'auto',?,?,?,?)`, cid, 'housekeeping', `Prepare ${unit.name} for ${b.guest_name||'arrival'}`, unit.id, b.id,
        b.check_in===today?'high':'normal', b.check_in, notes.slice(0,500), `prep:${b.id}`, nowIso, nowIso);
    }
  }
}

async function hsMaintenanceJob(ctx){
  const {env, cid, nowIso}=ctx;
  const rows=await all(env, `SELECT f.*, u.name FROM hosp_suite_fleet f JOIN hospitality_units u ON u.id=f.unit_id WHERE f.client_id=?`, cid);
  for(const f of rows){
    const since=Number(f.engine_hours)-Number(f.last_service_hours);
    if(!(Number(f.service_interval_hours)>0) || since<Number(f.service_interval_hours)*0.9) continue;
    if(f.service_alerted_at_hours!=null && Number(f.service_alerted_at_hours)===Number(f.last_service_hours)) continue;
    await hsAlert(env, cid, 'service', `${f.name}: engine service due`, `${Math.round(since)} engine hours since the last service (interval ${f.service_interval_hours} h).`, `service:${f.unit_id}:${f.last_service_hours}`, nowIso);
    await run(env, `UPDATE hosp_suite_fleet SET service_alerted_at_hours=? WHERE unit_id=?`, f.last_service_hours, f.unit_id);
  }
}

async function hsIcalSyncDue(ctx){
  const {env, cid, cfg, nowMs}=ctx;
  const cutoff=new Date(nowMs-cfg.ical_sync_minutes*60000).toISOString();
  const feeds=await all(env, `SELECT * FROM hosp_suite_ical WHERE client_id=? AND (last_sync_at IS NULL OR last_sync_at<?) ORDER BY last_sync_at ASC LIMIT 10`, cid, cutoff);
  for(const f of feeds) await hsIcalSync(env, ctx.deps, cid, f, ctx.today, ctx.nowIso);
}
export async function hsIcalSync(env, deps, cid, feed, today, nowIso){
  let status='ok', events=0;
  try{
    const r=await (deps.fetch||fetch)(feed.url, {headers:{'User-Agent':'Leadvyne-iCal/1.0'}});
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const text=await r.text();
    if(!/BEGIN:VCALENDAR/i.test(text)) throw new Error('Not an iCal feed');
    const parsed=hsIcalParse(text, today);
    events=parsed.events;
    const origin=`ical:${feed.id}`;
    const mine=new Set((await all(env, `SELECT date FROM hosp_suite_blocks WHERE client_id=? AND origin=? AND unit_id=?`, cid, origin, feed.unit_id)).map(x=>x.date));
    const want=new Set(parsed.dates);
    for(const d of want){
      if(mine.has(d)) continue;
      const ins=await run(env, `INSERT OR IGNORE INTO hospitality_blocked_dates (client_id, unit_id, date, reason, created_at) VALUES (?,?,?,?,?)`, cid, feed.unit_id, d, `OTA: ${feed.source||'iCal'}`.slice(0,140), nowIso);
      if(ins.meta.changes) await run(env, `INSERT OR IGNORE INTO hosp_suite_blocks (client_id, origin, unit_id, date) VALUES (?,?,?,?)`, cid, origin, feed.unit_id, d);
    }
    for(const d of mine){
      if(want.has(d) || d<today) continue;
      await run(env, `DELETE FROM hospitality_blocked_dates WHERE unit_id=? AND date=? AND client_id=?`, feed.unit_id, d, cid);
      await run(env, `DELETE FROM hosp_suite_blocks WHERE unit_id=? AND date=? AND origin=?`, feed.unit_id, d, origin);
    }
  }catch(e){ status=String(e?.message||e).slice(0,200); }
  await run(env, `UPDATE hosp_suite_ical SET last_sync_at=?, last_status=?, events=? WHERE id=?`, nowIso, status, events, feed.id);
  return {status, events};
}
async function hsRemoveOrigin(env, cid, origin, {fromDate=null, toDate=null}={}){
  const rows=await all(env, `SELECT unit_id, date FROM hosp_suite_blocks WHERE client_id=? AND origin=?`, cid, origin);
  for(const r of rows){
    if(fromDate && r.date<fromDate) continue;
    if(toDate && r.date>toDate) continue;
    await run(env, `DELETE FROM hospitality_blocked_dates WHERE unit_id=? AND date=? AND client_id=?`, r.unit_id, r.date, cid);
    await run(env, `DELETE FROM hosp_suite_blocks WHERE unit_id=? AND date=? AND origin=?`, r.unit_id, r.date, origin);
  }
}

async function hsAllotmentReleaseJob(ctx){
  const {env, cid, today}=ctx;
  const rows=await all(env, `SELECT * FROM hosp_suite_allotments WHERE client_id=? AND status='active'`, cid);
  for(const a of rows){
    const releaseUpTo=hpAddDays(today, Number(a.release_days)||0);
    await hsRemoveOrigin(env, cid, `allot:${a.id}`, {toDate:releaseUpTo});
    if(hpAddDays(a.end_date, -1)<=releaseUpTo) await run(env, `UPDATE hosp_suite_allotments SET status='released' WHERE id=?`, a.id);
  }
}

export async function hsGenerateSuggestions(env, cid, today, days=60){
  const units=await all(env, `SELECT * FROM hospitality_units WHERE client_id=? AND active=1`, cid);
  const rules=await all(env, `SELECT * FROM hosp_suite_price_rules WHERE client_id=? AND active=1`, cid);
  const end=hpAddDays(today, days);
  const ovRows=await all(env, `SELECT unit_id, date, rate FROM hospitality_rate_overrides WHERE client_id=? AND date>=? AND date<?`, cid, today, end);
  const overrides={}; ovRows.forEach(r=>{ (overrides[r.unit_id]=overrides[r.unit_id]||{})[r.date]=r.rate; });
  const bookings=await all(env, `SELECT check_in, check_out FROM hospitality_bookings WHERE client_id=? AND status IN ('confirmed','checked_in','checked_out') AND check_in<? AND check_out>?`, cid, end, today);
  const occupancy=hsOccupancyMap(bookings, units.length, today, days);
  const list=hsSuggestPrices({units, rules, overrides, occupancy, today, days});
  const nowIso=new Date().toISOString();
  await run(env, `DELETE FROM hosp_suite_price_suggestions WHERE client_id=? AND (status='pending' OR date<?)`, cid, today);
  for(const s of list){
    await run(env, `INSERT INTO hosp_suite_price_suggestions (client_id, unit_id, date, current_rate, suggested_rate, reason, status, created_at) VALUES (?,?,?,?,?,?,'pending',?)
      ON CONFLICT(client_id, unit_id, date) DO UPDATE SET current_rate=excluded.current_rate, suggested_rate=excluded.suggested_rate, reason=excluded.reason,
        status='pending', created_at=excluded.created_at
      WHERE hosp_suite_price_suggestions.status<>'dismissed' OR hosp_suite_price_suggestions.suggested_rate<>excluded.suggested_rate`,
      cid, s.unit_id, s.date, s.current_rate, s.suggested_rate, s.reason, nowIso);
  }
  return list.length;
}

export async function hsSummaryData(env, cid, today, c){
  const units=await all(env, `SELECT id, currency FROM hospitality_units WHERE client_id=? AND active=1`, cid);
  const from=hpAddDays(today, -7), to=hpAddDays(today, 7);
  const bookings=await all(env, `SELECT * FROM hospitality_bookings WHERE client_id=? AND status IN ('confirmed','checked_in','checked_out') AND check_in<? AND check_out>?`, cid, to, from);
  const prevOcc=hsOccupancyMap(bookings, units.length, from, 7), nextOcc=hsOccupancyMap(bookings, units.length, today, 7);
  const avg=m=>{ const v=Object.values(m); return v.length?Math.round(v.reduce((a,b)=>a+b, 0)/v.length):0; };
  const monthStart=today.slice(0,8)+'01';
  const rev=await one(env, `SELECT SUM(total_amount) t FROM hospitality_bookings WHERE client_id=? AND status IN ('confirmed','checked_in','checked_out') AND check_in>=? AND check_in<=?`, cid, monthStart, today);
  let balanceDue=0;
  for(const b of bookings.filter(b=>b.check_in>=today && b.check_in<to && b.status==='confirmed')) balanceDue+=(await hsBookingMoney(env, cid, b)).balance;
  const n=async(sql, ...b)=>Number((await one(env, sql, ...b))?.n)||0;
  return {
    name:c?.client_name||c?.business_name||'', today, currency:units[0]?.currency||'INR',
    arrivals:bookings.filter(b=>b.check_in===today).length, departures:bookings.filter(b=>b.check_out===today).length,
    inHouse:bookings.filter(b=>b.check_in<=today && b.check_out>today).length,
    occNext7:avg(nextOcc), occPrev7:avg(prevOcc), revenueMtd:Math.round(Number(rev?.t)||0), balanceDue:Math.round(balanceDue),
    openTasks:await n(`SELECT COUNT(*) n FROM hosp_suite_tasks WHERE client_id=? AND status<>'done'`, cid),
    openAlerts:await n(`SELECT COUNT(*) n FROM hosp_suite_alerts WHERE client_id=? AND status='open'`, cid),
    pendingSugg:await n(`SELECT COUNT(*) n FROM hosp_suite_price_suggestions WHERE client_id=? AND status='pending' AND date>=?`, cid, today),
    lowRatings:await n(`SELECT COUNT(*) n FROM hosp_suite_booking WHERE client_id=? AND rating IS NOT NULL AND rating<=3 AND updated_at>=?`, cid, new Date(Date.parse(today)-7*DAY).toISOString()),
  };
}
async function hsDailySummary(ctx, send){
  const {env, cid, cfg, today, nowIso}=ctx;
  const text=hsSummaryText(await hsSummaryData(env, cid, today, ctx.c));
  let sent=0;
  if(send && cfg.owner_phone && cfg.template_name && ctx.deps.sendTemplate){
    try{ await ctx.deps.sendTemplate(env, ctx.c, cfg.owner_phone, cfg.template_name, cfg.template_lang, ['there', hsFlatten(text)]); sent=1; }
    catch(e){ await ctx.deps.reportOpsError?.(env, 'hospitalitySuite.summarySend', e, {clientId:cid}).catch(()=>{}); }
  }
  await run(env, `INSERT INTO hosp_suite_summaries (client_id, date, text, sent, created_at) VALUES (?,?,?,?,?)
    ON CONFLICT(client_id, date) DO UPDATE SET text=excluded.text, sent=MAX(hosp_suite_summaries.sent, excluded.sent), created_at=excluded.created_at`, cid, today, text, sent, nowIso);
  return {text, sent:!!sent};
}

// ── WhatsApp turn (called from handleEngineWebhook BEFORE Hospitality Pro, Pro clients only) ────
// t: {c, clientId, convId, leadId, phone, name, userText, rawText, mediaType, mediaUrl, lang, optOut, humanExplicit, nowMs?}
// Returns {handled:false} to fall through to Hospitality Pro / the normal bot unchanged.
const HS_PAID_RE=/\b(paid|payment\s+(?:done|made|completed|sent)|(?:done|made|sent|completed)\s+(?:the\s+)?payment|transferred)\b/i;
const HS_DONE_RE=/^\s*(?:✅\s*)?(done|finished|that'?s\s+all|no\s+more|skip|no\s+thanks|nothing|none|continue)\b/i;
const HS_STOP_RE=/^\s*(cancel|stop|exit|quit|never\s*mind|not\s+now)\s*[.!]*\s*$/i;
const HS_REQUEST_RE=/\b(towels?|cleaning|clean\s+(?:the\s+)?room|housekeeping|drinking\s+water|bottles?\s+of\s+water|tea|coffee|ice|extra\s+(?:bed|pillows?|blankets?|mattress)|blankets?|pillows?|a\.?c\.?\s+(?:is\s+)?not|air\s*con\w*|fan\s+(?:is\s+)?not|lights?\s+(?:is\s+|are\s+)?not|no\s+(?:power|electricity|water|hot\s+water)|hot\s+water|geyser|toilet|flush|leak\w*|broken|not\s+working|repair|room\s+service|laundry|iron(?:ing)?\s+box|mosquito\w*|insects?)\b/i;
const HS_REPAIR_RE=/\b(not\s+working|broken|leak\w*|repair|no\s+(?:power|electricity|water|hot\s+water)|a\.?c\.?\s+(?:is\s+)?not|fan|lights?|geyser|toilet|flush)\b/i;

export async function hsHandleTurn(env, deps, t){
  const nowMs=t.nowMs||Date.now();
  const cid=Number(t.clientId), leadId=Number(t.leadId);
  if(!cid || !leadId || !hpEnabled(t.c)) return {handled:false};
  const cfg=await hsLoadConfig(env, cid);
  if(!hsAnyOn(cfg)) return {handled:false};
  const nowIso=new Date(nowMs).toISOString();
  const phoneKey=hpPhoneKey(t.phone);
  await run(env, `INSERT INTO hosp_suite_contacts (client_id, lead_id, phone_key, conv_id, last_inbound_at) VALUES (?,?,?,?,?)
    ON CONFLICT(client_id, lead_id) DO UPDATE SET phone_key=excluded.phone_key, conv_id=COALESCE(excluded.conv_id, hosp_suite_contacts.conv_id), last_inbound_at=excluded.last_inbound_at`,
    cid, leadId, phoneKey, t.convId?String(t.convId):null, nowIso);
  if(t.optOut){ await hsClearState(env, cid, leadId); return {handled:false}; }
  const pro=await hpLoadConfig(env, cid);
  const isMedia=(t.mediaType==='image' || t.mediaType==='file') && !!t.mediaUrl;
  const text=String((isMedia?t.rawText:(t.userText||t.rawText))||'').trim();
  const ctx={env, deps, t, cfg, pro, cid, leadId, nowMs, nowIso, today:hpLocalToday(nowMs, pro.tz_offset_min), text, lower:text.toLowerCase(), isMedia, phoneKey};
  if(t.humanExplicit){ await hsClearState(env, cid, leadId); return {handled:false}; }

  if(hsOn(cfg, 'staff_bot') && phoneKey.length>=6){
    const staff=await one(env, `SELECT * FROM hosp_suite_staff WHERE client_id=? AND phone_key=? AND active=1 LIMIT 1`, cid, phoneKey);
    if(staff && /^\s*(tasks?|my\s+tasks|done|start|new|issue|report|help)\b|^\s*✅\s*\d/i.test(text)) return await hsStaffTurn(ctx, staff);
  }
  const st=await hsGetState(env, cid, leadId, nowMs);
  if(hsOn(cfg, 'agent_quotes') && phoneKey.length>=6){
    const agent=await one(env, `SELECT * FROM hosp_suite_agents WHERE client_id=? AND phone_key=? AND active=1 LIMIT 1`, cid, phoneKey);
    if(agent && (st?.flow==='agent' || /\b(rates?|quote|availab\w*|book|price|tariff|net)\b/i.test(text) || hpParseDateRange(text, ctx.today)?.check_in))
      return await hsAgentTurn(ctx, agent, st?.flow==='agent'?st:{flow:'agent', data:{}});
  }
  if(st && st.flow!=='agent'){
    if(HS_STOP_RE.test(ctx.lower)){ await hsClearState(env, cid, leadId); return await hsSay(ctx, `No problem 👍 Anything else I can help you with?`); }
    const h=st.flow==='checkin'?await hsCheckinTurn(ctx, st)
      :st.flow==='upsell'?await hsUpsellTurn(ctx, st)
      :st.flow==='meal'?await hsMealTurn(ctx, st)
      :st.flow==='weather'?await hsWeatherTurn(ctx, st)
      :st.flow==='feedback'?await hsFeedbackTurn(ctx, st):null;
    if(h?.handled) return h;
  }
  if(isMedia || !text) return {handled:false};

  const stay=await hsCurrentStay(ctx);
  if(stay && hsOn(cfg, 'balance_reminders') && HS_PAID_RE.test(ctx.lower)){
    const money=await hsBookingMoney(env, cid, stay);
    const row=await hsBookingRow(env, cid, stay.id);
    if(money.balance>0 && Object.keys(parseJson(row?.sent_json, {})).some(k=>k.startsWith('bal_'))){
      await hsAlert(env, cid, 'payment', `${stay.guest_name||'Guest'} says the balance is paid`, `Booking #${stay.id}: balance ${hpFmtMoney(money.balance, money.currency)}. Verify and record it in Guest Journey → Payments.`, `paid:${stay.id}:${nowIso.slice(0,10)}`, nowIso);
      await deps.sendPrivateNote?.(t.c, t.convId, `💳 Guest says the balance for booking #${stay.id} (${hpFmtMoney(money.balance, money.currency)}) is paid. Verify it and record the payment in the Hospitality workspace.`);
      return await hsSay(ctx, `🙏 Thank you! We've noted your payment — our team will verify it shortly.`);
    }
  }
  if(stay && hsOn(cfg, 'instay_requests') && stay.check_in<=ctx.today && HS_REQUEST_RE.test(text)){
    const repair=HS_REPAIR_RE.test(text);
    const unit=await one(env, `SELECT name FROM hospitality_units WHERE id=?`, Number(stay.unit_id));
    const r=await run(env, `INSERT INTO hosp_suite_tasks (client_id, kind, title, unit_id, booking_id, priority, status, due_date, source, notes, created_at, updated_at)
      VALUES (?,?,?,?,?,?,'open',?,'guest',?,?,?)`, cid, repair?'maintenance':'request', `${unit?.name||'Guest'}: ${text.slice(0,120)}`, stay.unit_id, stay.id,
      repair?'high':'normal', ctx.today, `From ${stay.guest_name||t.name||'guest'} on WhatsApp`, nowIso, nowIso);
    await deps.sendPrivateNote?.(t.c, t.convId, `🛎️ In-stay request → task #${r.meta.last_row_id} (${repair?'maintenance':'request'}): "${text.slice(0,200)}"`);
    return await hsSay(ctx, cfg.instay_reply||`👍 Got it! I've passed this to our team — someone will take care of it shortly.`);
  }
  return {handled:false};
}

async function hsSay(ctx, text, buttons){
  const {env, deps, t}=ctx;
  const body=t.lang && t.lang!=='en' && deps.localize ? (await deps.localize(env, t.c, text, t.lang).catch(()=>text))||text : text;
  if(buttons && buttons.length){
    const opts=await deps.sendButtons(env, t.c, String(ctx.cid), t.convId, body, buttons);
    return {handled:true, reply:body, quickReplies:Array.isArray(opts)?opts:null};
  }
  await deps.sendText(env, t.c, String(ctx.cid), t.convId, body);
  return {handled:true, reply:body};
}

// The guest's current or next stay (arriving within 30 days, in-house, or leaving today).
async function hsCurrentStay(ctx){
  const {env, cid, leadId, phoneKey, today}=ctx;
  const rows=await all(env, `SELECT * FROM hospitality_bookings WHERE client_id=? AND status IN ('confirmed','checked_in') AND check_out>=? AND check_in<=? ORDER BY check_in ASC LIMIT 20`,
    cid, today, hpAddDays(today, 30));
  return rows.find(b=>Number(b.lead_id)===leadId) || (phoneKey.length>=6?rows.find(b=>hpPhoneKey(b.guest_phone)===phoneKey):null) || null;
}

async function hsCheckinTurn(ctx, st){
  const {env, cid, leadId, cfg, nowMs, nowIso}=ctx;
  const b=await one(env, `SELECT * FROM hospitality_bookings WHERE id=? AND client_id=?`, Number(st.booking_id), cid);
  if(!b){ await hsClearState(env, cid, leadId); return {handled:false}; }
  if(st.step==='eta'){
    const eta=hsParseTime(ctx.text);
    if(!eta){ st.misses=(st.misses||0)+1; if(st.misses>=2) await hsClearState(env, cid, leadId); else await hsSaveState(env, cid, leadId, st, nowMs); return {handled:false}; }
    await hsUpsertBooking(env, cid, b.id, {eta, checkin_status:'started'}, nowIso);
    st.step='prefs'; st.misses=0; await hsSaveState(env, cid, leadId, st, nowMs);
    return await hsSay(ctx, `✅ Noted — arriving around *${eta}*.\n\n📝 Anything we should know? Food preferences, allergies, a birthday or anniversary, bed setup…`, [{title:'Nothing special', value:'skip'}]);
  }
  if(st.step==='prefs'){
    if(ctx.isMedia) return {handled:false};
    const prefs=HS_DONE_RE.test(ctx.lower)?'':ctx.text.slice(0,500);
    await hsUpsertBooking(env, cid, b.id, {preferences:prefs}, nowIso);
    if(prefs && hsOn(cfg, 'guest_profiles') && hpPhoneKey(b.guest_phone).length>=6){
      await run(env, `INSERT INTO hosp_suite_guests (client_id, phone_key, name, phone, preferences, updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(client_id, phone_key) DO UPDATE SET preferences=TRIM(hosp_suite_guests.preferences||' '||excluded.preferences), updated_at=excluded.updated_at`,
        cid, hpPhoneKey(b.guest_phone), b.guest_name||'', b.guest_phone||'', prefs, nowIso);
    }
    st.step='ids'; await hsSaveState(env, cid, leadId, st, nowMs);
    return await hsSay(ctx, `🪪 Last step: send a clear photo of a government ID for each adult (Aadhaar / Passport / Driving Licence). Foreign nationals: passport + visa page.\n\nTap *Done* when you've sent them all.`, [{title:'✅ Done', value:'done'}]);
  }
  if(st.step==='ids'){
    if(ctx.isMedia){
      let fields={};
      if(hsOn(cfg, 'id_scan') && ctx.deps.readIdImage) fields=hsMaskId(await ctx.deps.readIdImage(env, ctx.t.mediaUrl).catch(()=>null)||{});
      await run(env, `INSERT INTO hosp_suite_idscans (client_id, booking_id, image_url, fields_json, created_at) VALUES (?,?,?,?,?)`, cid, b.id, String(ctx.t.mediaUrl).slice(0,1000), JSON.stringify(fields), nowIso);
      const n=Number((await one(env, `SELECT COUNT(*) n FROM hosp_suite_idscans WHERE client_id=? AND booking_id=?`, cid, b.id))?.n)||1;
      await hsSaveState(env, cid, leadId, st, nowMs);
      return await hsSay(ctx, `✅ Got it — ${n} ID${n===1?'':'s'} received${fields.name?` (${fields.name})`:''}. Send the next one, or tap *Done*.`, [{title:'✅ Done', value:'done'}]);
    }
    if(HS_DONE_RE.test(ctx.lower)){
      await hsUpsertBooking(env, cid, b.id, {checkin_status:'done'}, nowIso);
      await hsClearState(env, cid, leadId);
      await ctx.deps.sendPrivateNote?.(ctx.t.c, ctx.t.convId, `📋 Express check-in completed for booking #${b.id}. See Guest Journey in the Hospitality workspace.`);
      return await hsSay(ctx, `🙏 All set! Your express check-in is complete — see you on *${hpFmtDate(b.check_in)}*! 🌴`);
    }
    return {handled:false};
  }
  await hsClearState(env, cid, leadId);
  return {handled:false};
}
// Aadhaar numbers are stored masked (last 4 digits only), as UIDAI requires.
export function hsMaskId(f){
  const out={};
  for(const k of ['name','id_type','id_number','dob','nationality']) if(f && f[k]) out[k]=String(f[k]).slice(0,80);
  const digits=String(out.id_number||'').replace(/\D/g,'');
  if(out.id_number && (/aadh?aar/i.test(out.id_type||'') || /^\d{12}$/.test(digits))) out.id_number='XXXX XXXX '+digits.slice(-4);
  return out;
}

async function hsUpsellTurn(ctx, st){
  const {env, cid, leadId, nowMs, nowIso, t}=ctx;
  const b=await one(env, `SELECT * FROM hospitality_bookings WHERE id=? AND client_id=?`, Number(st.booking_id), cid);
  if(!b){ await hsClearState(env, cid, leadId); return {handled:false}; }
  if(HS_DONE_RE.test(ctx.lower)){
    await hsClearState(env, cid, leadId);
    return await hsSay(ctx, `👍 No problem! We look forward to welcoming you on *${hpFmtDate(b.check_in)}*. 🌴`);
  }
  const cur=b.currency||'INR';
  if(st.upgrade && /\bupgrade\b/i.test(ctx.lower)){
    await run(env, `INSERT INTO hosp_suite_extras (client_id, booking_id, addon_id, name, amount, source, status, created_at) VALUES (?,?,NULL,?,?,'upgrade','requested',?)`,
      cid, b.id, `Upgrade to ${st.upgrade.name}`, st.upgrade.amount, nowIso);
    await run(env, `INSERT INTO hosp_suite_tasks (client_id, kind, title, unit_id, booking_id, priority, status, due_date, source, notes, created_at, updated_at) VALUES (?,?,?,?,?,'high','open',?,'guest',?,?,?)`,
      cid, 'other', `Confirm upgrade: ${b.guest_name||'guest'} → ${st.upgrade.name}`, b.unit_id, b.id, b.check_in, `+${hpFmtMoney(st.upgrade.amount, cur)} · move the booking to ${st.upgrade.name} once confirmed`, nowIso, nowIso);
    await ctx.deps.sendPrivateNote?.(t.c, t.convId, `⬆️ Guest wants the upgrade to ${st.upgrade.name} (+${hpFmtMoney(st.upgrade.amount, cur)}) for booking #${b.id}. Confirm it and move the booking.`);
    const upName=st.upgrade.name;
    st.upgrade=null; await hsSaveState(env, cid, leadId, st, nowMs);
    return await hsSay(ctx, `⬆️ Lovely choice! We've requested your upgrade to *${upName}* — our team will confirm it shortly. Anything else?`, [{title:'✅ Done', value:'done'}]);
  }
  const addons=await all(env, `SELECT * FROM hosp_pro_addons WHERE client_id=? AND active=1`, cid);
  const parts=ctx.text.split(/\s*(?:,|\band\b|&|\+)\s*/i).filter(Boolean);
  const picked=[];
  for(const p of parts){ const a=hpMatchByName(p, addons); if(a && !picked.includes(a)) picked.push(a); }
  if(!picked.length){ st.misses=(st.misses||0)+1; if(st.misses>=2) await hsClearState(env, cid, leadId); else await hsSaveState(env, cid, leadId, st, nowMs); return {handled:false}; }
  const nights=hpNightsBetween(b.check_in, b.check_out)||1, guests=(Number(b.adults)||1)+(Number(b.children)||0);
  for(const a of picked){
    await run(env, `INSERT INTO hosp_suite_extras (client_id, booking_id, addon_id, name, amount, source, status, created_at) VALUES (?,?,?,?,?,'prearrival','requested',?)`,
      cid, b.id, a.id, a.name, hpRound(hpAddonAmount(a, nights, guests), cur), nowIso);
  }
  await ctx.deps.sendPrivateNote?.(t.c, t.convId, `✨ Pre-arrival add-on for booking #${b.id}: ${picked.map(a=>a.name).join(', ')}. See Guest Journey → Extras.`);
  st.misses=0; await hsSaveState(env, cid, leadId, st, nowMs);
  return await hsSay(ctx, `✅ Added: *${picked.map(a=>a.name).join(', ')}* (${hpFmtMoney(picked.reduce((s,a)=>s+hpAddonAmount(a, nights, guests), 0), cur)}). Anything else?`, [{title:'✅ Done', value:'done'}]);
}

async function hsMealTurn(ctx, st){
  const {env, cid, leadId, nowMs, nowIso}=ctx;
  const meal=st.meals[st.idx];
  if(!meal){ await hsClearState(env, cid, leadId); return {handled:false}; }
  st.picked=st.picked||{};
  const items=await all(env, `SELECT * FROM hosp_suite_menu WHERE client_id=? AND meal=? AND active=1`, cid, meal);
  if(HS_DONE_RE.test(ctx.lower)){
    await run(env, `INSERT INTO hosp_suite_meal_orders (client_id, booking_id, meal, items_json, notes, updated_at) VALUES (?,?,?,?,'',?)
      ON CONFLICT(booking_id, meal) DO UPDATE SET items_json=excluded.items_json, updated_at=excluded.updated_at`, cid, Number(st.booking_id), meal, JSON.stringify(st.picked[meal]||[]), nowIso);
    st.idx++;
    if(st.idx>=st.meals.length){
      await hsClearState(env, cid, leadId);
      const sum=st.meals.map(m=>`• ${m[0].toUpperCase()+m.slice(1)}: ${(st.picked[m]||[]).map(x=>x.name).join(', ')||'chef\'s choice'}`).join('\n');
      await ctx.deps.sendPrivateNote?.(ctx.t.c, ctx.t.convId, `🍛 Meal pre-order for booking #${st.booking_id}:\n${sum}`);
      return await hsSay(ctx, `🙏 Thank you! Your meal order is with our cook:\n\n${sum}`);
    }
    await hsSaveState(env, cid, leadId, st, nowMs);
    const p=await hsMealPrompt(env, cid, st, false);
    return await hsSay(ctx, p.text, p.buttons);
  }
  const parts=ctx.text.split(/\s*(?:,|\band\b|&|\+)\s*/i).filter(Boolean);
  const hits=[];
  for(const part of parts){ const it=hpMatchByName(part, items); if(it && !hits.includes(it)) hits.push(it); }
  if(!hits.length){
    // Free text for this meal ("no onion", "only veg") is kept as the order note.
    if(ctx.isMedia) return {handled:false};
    await run(env, `INSERT INTO hosp_suite_meal_orders (client_id, booking_id, meal, items_json, notes, updated_at) VALUES (?,?,?,'[]',?,?)
      ON CONFLICT(booking_id, meal) DO UPDATE SET notes=excluded.notes, updated_at=excluded.updated_at`, cid, Number(st.booking_id), meal, ctx.text.slice(0,300), nowIso);
    await hsSaveState(env, cid, leadId, st, nowMs);
    return await hsSay(ctx, `📝 Noted for ${meal}: "${ctx.text.slice(0,100)}". Tap more dishes, or *Done*.`, [{title:'✅ Done', value:'done'}]);
  }
  const list=st.picked[meal]||(st.picked[meal]=[]);
  hits.forEach(h=>{ if(!list.some(x=>x.id===h.id)) list.push({id:h.id, name:h.name}); });
  await hsSaveState(env, cid, leadId, st, nowMs);
  return await hsSay(ctx, `✅ ${meal[0].toUpperCase()+meal.slice(1)}: ${list.map(x=>x.name).join(', ')}. Tap more, or *Done* for the next meal.`, [{title:'✅ Done', value:'done'}]);
}

async function hsWeatherTurn(ctx, st){
  const {env, cid, leadId, nowIso, t}=ctx;
  await hsClearState(env, cid, leadId);
  if(/\bresched\w*|change|new\s+date|postpone|another\s+date/i.test(ctx.lower)){
    const b=await one(env, `SELECT * FROM hospitality_bookings WHERE id=? AND client_id=?`, Number(st.booking_id), cid);
    await run(env, `INSERT INTO hosp_suite_tasks (client_id, kind, title, booking_id, unit_id, priority, status, due_date, source, notes, created_at, updated_at) VALUES (?,?,?,?,?,'urgent','open',?,'guest','Weather alert — guest asked to reschedule',?,?)`,
      cid, 'request', `Reschedule (weather): ${b?.guest_name||'guest'}`, st.booking_id, b?.unit_id||null, ctx.today, nowIso, nowIso);
    await ctx.deps.sendPrivateNote?.(t.c, t.convId, `🌧️ Guest wants to reschedule booking #${st.booking_id} because of the weather. Please call them with new dates.`);
    return await hsSay(ctx, `👍 Understood. Our team will contact you shortly with new date options — no charges for weather changes.`);
  }
  if(/\bkeep|ok|fine|continue|same|go\s+ahead|👍/i.test(ctx.lower)) return await hsSay(ctx, `👍 Great — we'll keep everything ready and update you if anything changes. Stay safe!`);
  return {handled:false};
}

async function hsFeedbackTurn(ctx, st){
  const {env, cid, leadId, cfg, nowIso, nowMs, t}=ctx;
  if(st.step==='comment'){
    await hsClearState(env, cid, leadId);
    if(ctx.isMedia) return {handled:false};
    await hsUpsertBooking(env, cid, st.booking_id, {feedback:ctx.text.slice(0,1000)}, nowIso);
    await hsAlert(env, cid, 'feedback', `Guest feedback (${st.rating}★) — booking #${st.booking_id}`, ctx.text.slice(0,1000), `fbtext:${st.booking_id}`, nowIso);
    return await hsSay(ctx, `🙏 Thank you for telling us. Our manager will personally look into this and get back to you.`);
  }
  const m=ctx.lower.match(/^\s*(?:⭐\s*)*([1-5])\b/) || (/^(⭐\s*){1,5}$/.test(ctx.text)?[null, String((ctx.text.match(/⭐/g)||[]).length)]:null);
  if(!m){ await hsClearState(env, cid, leadId); return {handled:false}; }
  const rating=Number(m[1]);
  await hsUpsertBooking(env, cid, st.booking_id, {rating}, nowIso);
  const b=await one(env, `SELECT guest_name, guest_phone FROM hospitality_bookings WHERE id=?`, Number(st.booking_id));
  if(rating>=4){
    await hsClearState(env, cid, leadId);
    return await hsSay(ctx, `🥰 Thank you so much! ${cfg.google_review_url?`Would you share your experience on Google? It really helps a small business like ours 🙏\n\n${cfg.google_review_url}`:'We hope to welcome you back soon! 🌴'}`);
  }
  await hsAlert(env, cid, 'low_rating', `${rating}★ rating from ${b?.guest_name||'a guest'}`, `Booking #${st.booking_id}${b?.guest_phone?` · ${b.guest_phone}`:''}. Call the guest today.`, `rating:${st.booking_id}`, nowIso);
  await ctx.deps.sendPrivateNote?.(t.c, t.convId, `😟 ${rating}★ rating for booking #${st.booking_id}. Manager follow-up needed.`);
  await hsSaveState(env, cid, leadId, {flow:'feedback', step:'comment', booking_id:st.booking_id, rating}, nowMs);
  return await hsSay(ctx, `😔 We're sorry your stay wasn't perfect. Could you tell us what went wrong? We'd really like to make it right.`);
}

// Staff WhatsApp bot: "tasks", "start 12", "done 12" / "✅ 12", "issue: AC leaking in Villa 2", "help".
async function hsStaffTurn(ctx, staff){
  const {env, cid, nowIso, lower, text}=ctx;
  const idm=lower.match(/^\s*(?:(done|start)\s*#?|✅\s*#?)(\d+)/);
  if(idm){
    const id=Number(idm[2]), status=idm[1]==='start'?'in_progress':'done';
    const task=await one(env, `SELECT * FROM hosp_suite_tasks WHERE id=? AND client_id=?`, id, cid);
    if(!task) return await hsSay(ctx, `I couldn't find task #${id}. Send *tasks* to see yours.`);
    await hsSetTaskStatus(env, cid, task, status, nowIso, staff.id);
    return await hsSay(ctx, status==='done'?`✅ Task #${id} marked done. Thank you, ${firstName(staff.name)||'team'}!`:`▶️ Task #${id} started.`);
  }
  const nm=text.match(/^\s*(?:new|issue|report)\s*[:\-–]?\s*(.+)$/is);
  if(nm){
    const units=await all(env, `SELECT id, name FROM hospitality_units WHERE client_id=?`, cid);
    const unit=hpMatchByName(nm[1], units);
    const r=await run(env, `INSERT INTO hosp_suite_tasks (client_id, kind, title, unit_id, priority, status, due_date, source, notes, created_at, updated_at) VALUES (?,?,?,?,?,'open',?,'staff',?,?,?)`,
      cid, 'maintenance', nm[1].trim().slice(0,160), unit?.id||null, /\burgent|asap|leak|no\s+power|fire\b/i.test(nm[1])?'urgent':'normal', ctx.today, `Reported by ${staff.name} on WhatsApp`, nowIso, nowIso);
    return await hsSay(ctx, `🛠️ Logged as task #${r.meta.last_row_id}${unit?` (${unit.name})`:''}. The manager can see it now.`);
  }
  if(/^\s*help\b/i.test(text)) return await hsSay(ctx, `Commands:\n• *tasks* — your open tasks\n• *start 12* — start task 12\n• *done 12* — finish task 12\n• *issue: AC leaking in Villa 2* — report a problem`);
  const tasks=await all(env, `SELECT t.*, u.name AS unit_name FROM hosp_suite_tasks t LEFT JOIN hospitality_units u ON u.id=t.unit_id
    WHERE t.client_id=? AND t.status<>'done' AND (t.assignee_id=? OR t.assignee_id IS NULL) ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.due_date ASC LIMIT 15`, cid, staff.id);
  if(!tasks.length) return await hsSay(ctx, `🎉 No open tasks right now, ${firstName(staff.name)||'team'}!`);
  return await hsSay(ctx, `📋 *Open tasks*\n${tasks.map(x=>`#${x.id} ${x.priority==='urgent'?'🔴':x.priority==='high'?'🟠':'⚪'} ${x.title}${x.assignee_id?'':' (unassigned)'}${x.status==='in_progress'?' ▶️':''}`).join('\n')}\n\nReply *done 12* when finished.`);
}
export async function hsSetTaskStatus(env, cid, task, status, nowIso){
  await run(env, `UPDATE hosp_suite_tasks SET status=?, updated_at=?, done_at=? WHERE id=? AND client_id=?`, status, nowIso, status==='done'?nowIso:null, task.id, cid);
  if(status==='done' && task.kind==='housekeeping' && task.unit_id && String(task.auto_key||'').startsWith('clean:')){
    await run(env, `INSERT INTO hosp_suite_room_status (unit_id, client_id, status, note, updated_at) VALUES (?,?,'clean','',?)
      ON CONFLICT(unit_id) DO UPDATE SET status='clean', updated_at=excluded.updated_at`, task.unit_id, cid, nowIso);
  }
}

// ── Agent quotes ─────────────────────────────────────────────────────────────────────────────────
// Units free for this agent: no booking / live hold overlap, and every blocked date in the range is
// one of THIS agent's own allotment blocks.
export async function hsAgentAvailable(env, cid, agentId, ci, co, adults, children, nowIso){
  const units=await all(env, `SELECT * FROM hospitality_units WHERE client_id=? AND active=1 ORDER BY base_rate ASC`, cid);
  const booked=new Set((await all(env, `SELECT unit_id FROM hospitality_bookings WHERE client_id=? AND status IN ('confirmed','checked_in','checked_out') AND check_in<? AND check_out>?`, cid, co, ci)).map(r=>Number(r.unit_id)));
  const held=new Set((await all(env, `SELECT unit_id FROM hosp_pro_holds WHERE client_id=? AND check_in<? AND check_out>? AND ((status='active' AND expires_at>?) OR status='payment_claimed')`, cid, co, ci, nowIso)).map(r=>Number(r.unit_id)));
  const own=new Set((await all(env, `SELECT id FROM hosp_suite_allotments WHERE client_id=? AND agent_id=? AND status='active'`, cid, Number(agentId))).map(a=>`allot:${a.id}`));
  const blocks=await all(env, `SELECT b.unit_id, b.date, s.origin FROM hospitality_blocked_dates b LEFT JOIN hosp_suite_blocks s ON s.unit_id=b.unit_id AND s.date=b.date WHERE b.client_id=? AND b.date>=? AND b.date<?`, cid, ci, co);
  const blocked=new Set(blocks.filter(x=>!own.has(x.origin)).map(x=>Number(x.unit_id)));
  return units.filter(u=>!booked.has(Number(u.id)) && !held.has(Number(u.id)) && !blocked.has(Number(u.id))
    && adults<=Number(u.capacity_adults) && adults+children<=Number(u.capacity_adults)+Number(u.capacity_children));
}
async function hsUnitGross(env, u, ci, co){
  const ov={}; (await all(env, `SELECT date, rate FROM hospitality_rate_overrides WHERE unit_id=? AND date>=? AND date<?`, u.id, ci, co)).forEach(r=>{ ov[r.date]=r.rate; });
  return hpNightlyRates(u, ov, ci, co).reduce((s,n)=>s+n.rate, 0);
}
async function hsAgentTurn(ctx, agent, st){
  const {env, cid, leadId, nowMs, nowIso, today, t}=ctx;
  const d=st.data||(st.data={});
  const dr=hpParseDateRange(ctx.text, today);
  if(dr?.check_in){ d.check_in=dr.check_in; d.check_out=dr.check_out||(dr.nights?hpAddDays(dr.check_in, dr.nights):null); }
  else if(dr?.nights && d.check_in) d.check_out=hpAddDays(d.check_in, dr.nights);
  const g=hpParseGuests(ctx.text, {bare:st.step==='guests'});
  if(g){ d.adults=g.adults; d.children=g.children; }
  if(st.step==='pick' && d.check_in && d.check_out){
    const units=await hsAgentAvailable(env, cid, agent.id, d.check_in, d.check_out, d.adults||2, d.children||0, nowIso);
    const u=hpMatchByName(ctx.text, units);
    if(u) return await hsAgentBook(ctx, agent, u, d);
  }
  if(!d.check_in){ st.step='dates'; await hsSaveState(env, cid, leadId, st, nowMs); return await hsSay(ctx, `Hi ${firstName(agent.name)||'there'} 👋 Which dates do you need? (e.g. *12 to 14 Dec*)`); }
  if(!d.check_out){ st.step='nights'; await hsSaveState(env, cid, leadId, st, nowMs); return await hsSay(ctx, `How many nights from *${hpFmtDate(d.check_in)}*?`); }
  if(!d.adults){ st.step='guests'; await hsSaveState(env, cid, leadId, st, nowMs); return await hsSay(ctx, `How many guests? (e.g. *4 adults 2 kids*)`); }
  const units=await hsAgentAvailable(env, cid, agent.id, d.check_in, d.check_out, d.adults, d.children||0, nowIso);
  if(!units.length){ st.step='dates'; d.check_in=null; d.check_out=null; await hsSaveState(env, cid, leadId, st, nowMs); return await hsSay(ctx, `😔 Nothing free for those dates and guests. Try other dates?`); }
  const pct=Number(agent.commission_pct)||0;
  const L=[`🧾 *Agent rates* — ${hpFmtRange(d.check_in, d.check_out)}, ${d.adults} adult${d.adults===1?'':'s'}${d.children?` + ${d.children} child${d.children===1?'':'ren'}`:''}`, ''];
  for(const u of units.slice(0, 9)){
    const gross=await hsUnitGross(env, u, d.check_in, d.check_out);
    L.push(`• *${u.name}* — guest rate ${hpFmtMoney(gross, u.currency)} · your net *${hpFmtMoney(gross*(1-pct/100), u.currency)}* (${pct}% commission)`);
  }
  L.push('', 'Tap a unit to request the booking.');
  st.step='pick'; await hsSaveState(env, cid, leadId, st, nowMs);
  return await hsSay(ctx, L.join('\n'), units.slice(0, 9).map(u=>({title:u.name, value:u.name})));
}
async function hsAgentBook(ctx, agent, u, d){
  const {env, cid, leadId, nowIso, t}=ctx;
  const gross=hpRound(await hsUnitGross(env, u, d.check_in, d.check_out), u.currency);
  const nights=hpNightsBetween(d.check_in, d.check_out);
  const r=await run(env, `INSERT INTO hospitality_bookings (client_id, unit_id, lead_id, guest_name, guest_phone, check_in, check_out, nights, adults, children, rate_per_night, total_amount, deposit_amount, currency, status, notes, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,'inquiry',?,?)`, cid, u.id, leadId, `Agent: ${agent.name}${agent.company?` (${agent.company})`:''}`, agent.phone||'', d.check_in, d.check_out, nights,
    d.adults||1, d.children||0, hpRound(gross/nights, u.currency), gross, u.currency||'INR', `Agent booking request via WhatsApp · ${agent.commission_pct}% commission`, nowIso);
  const bid=r.meta.last_row_id;
  await hsUpsertBooking(env, cid, bid, {agent_id:agent.id, commission_amount:hpRound(gross*(Number(agent.commission_pct)||0)/100, u.currency), commission_status:'due'}, nowIso);
  await hsClearState(env, cid, leadId);
  await hsAlert(env, cid, 'agent', `Agent booking request — ${agent.name}`, `${u.name}, ${hpFmtRange(d.check_in, d.check_out)}. Confirm it in Agent Desk.`, `agentreq:${bid}`, nowIso);
  await ctx.deps.sendPrivateNote?.(t.c, t.convId, `🤝 Agent booking request #${bid}: ${u.name}, ${d.check_in} → ${d.check_out}. Confirm in the Hospitality workspace → Agent Desk.`);
  return await hsSay(ctx, `✅ Request #${bid} received for *${u.name}*, ${hpFmtRange(d.check_in, d.check_out)}. We'll confirm shortly. Please send the guest name when you have it.`);
}

// ── Desk bootstrap (/hospitality/desk/bootstrap) — every Hospitality client, Pro or not ─────────
// One round trip paints the whole desktop workspace: units, a booking window, today's numbers and
// (for Pro clients) feature switches + counts. Lean columns only, so it stays fast.
export async function hsDeskBootstrap(env, c, cid, nowMs=Date.now()){
  const pro=hpEnabled(c);
  const proCfg=await hpLoadConfig(env, cid).catch(()=>null);
  const tz=proCfg?.tz_offset_min??330;
  const today=hpLocalToday(nowMs, tz);
  const [units, bookings]=await Promise.all([
    all(env, `SELECT id, name, unit_type, capacity_adults, capacity_children, base_rate, weekend_rate, currency, active, property_id, amenities, description, image_url_1 FROM hospitality_units WHERE client_id=? ORDER BY name ASC`, cid),
    all(env, `SELECT id, unit_id, lead_id, guest_name, guest_phone, check_in, check_out, nights, adults, children, total_amount, deposit_amount, currency, status, notes, created_at
      FROM hospitality_bookings WHERE client_id=? AND check_out>=? AND check_in<=? ORDER BY check_in ASC LIMIT 1500`, cid, hpAddDays(today, -45), hpAddDays(today, 150)),
  ]);
  const occ=bookings.filter(b=>['confirmed','checked_in','checked_out'].includes(b.status));
  const active=units.filter(u=>u.active).length;
  const monthStart=today.slice(0,8)+'01';
  const revenue=occ.filter(b=>b.check_in>=monthStart && b.check_in<=hpAddDays(monthStart, 31) && b.check_in.slice(0,7)===today.slice(0,7)).reduce((s,b)=>s+(Number(b.total_amount)||0), 0);
  const next7=hsOccupancyMap(occ, active, today, 7);
  const out={
    client:{id:cid, name:c.client_name||c.business_name||'', style:c.hospitality_style||'hotel', pro},
    today, tz, units, bookings,
    stats:{
      arrivals:occ.filter(b=>b.check_in===today && b.status!=='checked_out').length,
      departures:occ.filter(b=>b.check_out===today).length,
      in_house:occ.filter(b=>b.check_in<=today && b.check_out>today && b.status!=='checked_out').length,
      occupancy_today:next7[today]||0,
      occupancy_7:Math.round(Object.values(next7).reduce((a,b)=>a+b, 0)/7),
      revenue_month:Math.round(revenue), inquiries:bookings.filter(b=>b.status==='inquiry').length,
    },
    pro:null,
  };
  if(pro){
    const cfg=await hsLoadConfig(env, cid);
    const n=async(sql, ...b)=>{ try{ return Number((await one(env, sql, ...b))?.n)||0; }catch(e){ return 0; } };
    const summary=hsOn(cfg, 'daily_summary')?await one(env, `SELECT date, text FROM hosp_suite_summaries WHERE client_id=? ORDER BY date DESC LIMIT 1`, cid).catch(()=>null):null;
    out.pro={
      features:proCfg?.features||{}, suite:cfg.features,
      holds_awaiting:await n(`SELECT COUNT(*) n FROM hosp_pro_holds WHERE client_id=? AND status IN ('active','payment_claimed')`, cid),
      groups_new:await n(`SELECT COUNT(*) n FROM hosp_pro_groups WHERE client_id=? AND status='new'`, cid),
      alerts_open:await n(`SELECT COUNT(*) n FROM hosp_suite_alerts WHERE client_id=? AND status='open'`, cid),
      tasks_open:await n(`SELECT COUNT(*) n FROM hosp_suite_tasks WHERE client_id=? AND status<>'done'`, cid),
      suggestions:await n(`SELECT COUNT(*) n FROM hosp_suite_price_suggestions WHERE client_id=? AND status='pending' AND date>=?`, cid, today),
      summary,
    };
  }
  return out;
}

// ── Field sanitizers for the simple CRUD tables ─────────────────────────────────────────────────
const V={
  text:n=>v=>str(v, n),
  num:(min, max, d=0)=>v=>clamp(v, min, max, d),
  numOrNull:(min, max)=>v=>clamp(v, min, max, null),
  int:(min, max, d=0)=>v=>Math.round(clamp(v, min, max, d)),
  idOrNull:v=>Number(v)>0?Math.round(Number(v)):null,
  bool:v=>v===false||v===0||v==='0'||v==='false'?0:1,
  oneOf:(list, d)=>v=>list.includes(v)?v:d,
  date:v=>/^\d{4}-\d{2}-\d{2}$/.test(String(v||''))?String(v):null,
  hhmm:d=>v=>{ const m=String(v||'').match(/^(\d{1,2}):(\d{2})$/); return m&&Number(m[1])<24&&Number(m[2])<60?`${m[1].padStart(2,'0')}:${m[2]}`:d; },
  url:v=>/^https?:\/\/\S+$/i.test(str(v, 500))?str(v, 500):'',
};
export function hsMonthDay(v){
  const s=String(v||'').trim();
  const m=s.match(/^(?:\d{4}-)?(\d{1,2})-(\d{1,2})$/) || s.match(/^(\d{1,2})\/(\d{1,2})$/)&&[null, s.split('/')[1], s.split('/')[0]];
  if(!m) return '';
  const mm=Number(m[1]), dd=Number(m[2]);
  if(!(mm>=1&&mm<=12&&dd>=1&&dd<=31)) return '';
  return `${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
}
const STAFF_ROLES=['cook','driver','helper','housekeeping','maintenance','front_desk','manager'];
const HS_TABLES={
  jetties:{table:'hosp_suite_jetties', features:['cruise_plan','pickup','weather_alerts','fleet'], required:['name'], order:'name ASC', fields:{
    name:V.text(80), map_url:V.url, lat:V.numOrNull(-90, 90), lng:V.numOrNull(-180, 180), boarding_time:V.hhmm('12:00'),
    cruise_start:V.hhmm('12:00'), cruise_end:V.hhmm('17:30'), checkout_time:V.hhmm('09:00'), notes:V.text(500)}},
  staff:{table:'hosp_suite_staff', features:['staff_tasks','crew','housekeeping'], required:['name'], order:'active DESC, name ASC', fields:{
    name:V.text(80), role:V.oneOf(STAFF_ROLES, 'housekeeping'), phone:V.text(30), active:V.bool},
    derive:r=>r.phone!==undefined?{phone_key:hpPhoneKey(r.phone)}:{}},
  menu:{table:'hosp_suite_menu', features:['meal_preorder'], required:['name'], order:'sort_order ASC, id ASC', fields:{
    meal:V.oneOf(HS_MEAL_ORDER, 'lunch'), name:V.text(60), veg:V.bool, price:V.num(0, 1e7), active:V.bool, sort_order:V.int(-1e6, 1e6)}},
  rules:{table:'hosp_suite_price_rules', features:['pricing_rules'], required:['kind'], order:'id ASC', fields:{
    kind:V.oneOf(['weekend','season','event','high_demand','last_minute'], 'season'), name:V.text(80), unit_id:V.idOrNull,
    start_date:V.date, end_date:V.date, pct:V.num(-90, 300), threshold:V.num(0, 100), days:V.int(0, 365), active:V.bool}},
  competitors:{table:'hosp_suite_competitors', features:['competitor_rates'], required:['name'], order:'name ASC', fields:{name:V.text(80), url:V.url}},
  reviews:{table:'hosp_suite_reviews', features:['review_replies'], required:['text'], order:'id DESC', updated:true, fields:{
    source:V.text(40), author:V.text(80), rating:V.numOrNull(1, 5), text:V.text(4000), reply:V.text(4000), status:V.oneOf(['new','drafted','replied'], 'new')}},
  agents:{table:'hosp_suite_agents', features:['agents'], required:['name'], order:'active DESC, name ASC', fields:{
    name:V.text(80), company:V.text(120), phone:V.text(30), email:V.text(120), commission_pct:V.num(0, 60, 10), credit_limit:V.num(0, 1e9), active:V.bool, notes:V.text(500)},
    derive:r=>r.phone!==undefined?{phone_key:hpPhoneKey(r.phone)}:{}},
  tasks:{table:'hosp_suite_tasks', features:['staff_tasks','housekeeping','instay_requests'], required:['title'], updated:true,
    order:`CASE status WHEN 'done' THEN 1 ELSE 0 END, CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, due_date ASC, id DESC`, limit:500, fields:{
    kind:V.oneOf(['housekeeping','maintenance','request','other'], 'other'), title:V.text(160), unit_id:V.idOrNull, booking_id:V.idOrNull,
    assignee_id:V.idOrNull, priority:V.oneOf(['low','normal','high','urgent'], 'normal'), status:V.oneOf(['open','in_progress','done'], 'open'),
    due_date:V.date, notes:V.text(1000)}},
};
async function hsCrud(env, json, spec, cid, method, body, nowIso){
  const T=spec.table;
  if(method==='GET') return json({list:await all(env, `SELECT * FROM ${T} WHERE client_id=? ORDER BY ${spec.order} LIMIT ${spec.limit||1000}`, cid)});
  const pick=(partial)=>{
    const vals={};
    for(const [k, fn] of Object.entries(spec.fields)) if(body[k]!==undefined || !partial) vals[k]=fn(body[k]);
    Object.assign(vals, spec.derive?spec.derive(vals):{});
    return vals;
  };
  if(method==='POST'){
    const vals=pick(false);
    for(const k of spec.required) if(vals[k]===null || vals[k]==='') return json({error:`${k} required`}, 400);
    if(spec.table==='hosp_suite_staff' || spec.table==='hosp_suite_agents') vals.phone_key=hpPhoneKey(vals.phone);
    vals.client_id=cid; vals.created_at=nowIso; if(spec.updated) vals.updated_at=nowIso;
    if(spec.table==='hosp_suite_tasks'){ vals.source=str(body.source||'staff', 20)||'staff'; if(vals.status==='done') vals.done_at=nowIso; }
    const cols=Object.keys(vals);
    const r=await run(env, `INSERT INTO ${T} (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`, ...cols.map(k=>vals[k]));
    return json({ok:true, id:r.meta.last_row_id});
  }
  const row=await one(env, `SELECT * FROM ${T} WHERE id=? AND client_id=?`, Number(body.id), cid);
  if(!row) return json({error:'Not found'}, 404);
  if(method==='DELETE'){ await run(env, `DELETE FROM ${T} WHERE id=?`, row.id); return json({ok:true}); }
  if(method==='PATCH'){
    const vals=pick(true);
    for(const k of spec.required) if(k in vals && (vals[k]===null || vals[k]==='')) return json({error:`${k} required`}, 400);
    if(spec.updated) vals.updated_at=nowIso;
    const cols=Object.keys(vals);
    if(cols.length) await run(env, `UPDATE ${T} SET ${cols.map(k=>`${k}=?`).join(', ')} WHERE id=?`, ...cols.map(k=>vals[k]), row.id);
    if(spec.table==='hosp_suite_tasks' && vals.status && vals.status!==row.status) await hsSetTaskStatus(env, cid, row, vals.status, nowIso);
    return json({ok:true});
  }
  return json({error:'Method not allowed'}, 405);
}

// ── Public iCal export (/hospitality/ical/<token>/<unit id>.ics) ────────────────────────────────
export async function hsIcalExportRoute(env, url){
  const m=url.pathname.match(/^\/hospitality\/ical\/([a-f0-9]{16,64})\/(\d+)\.ics$/);
  if(!m) return new Response('Not found', {status:404});
  const s=await one(env, `SELECT client_id, config_json FROM hosp_suite_settings WHERE ical_token=?`, m[1]);
  if(!s || !hsOn(hsNormalizeConfig(s.config_json), 'ical_sync')) return new Response('Not found', {status:404});
  const unit=await one(env, `SELECT id, name FROM hospitality_units WHERE id=? AND client_id=?`, Number(m[2]), s.client_id);
  if(!unit) return new Response('Not found', {status:404});
  const today=new Date().toISOString().slice(0,10);
  const bookings=await all(env, `SELECT id, check_in, check_out FROM hospitality_bookings WHERE unit_id=? AND client_id=? AND status IN ('confirmed','checked_in') AND check_out>? LIMIT 1000`, unit.id, s.client_id, today);
  const blocked=(await all(env, `SELECT date FROM hospitality_blocked_dates WHERE unit_id=? AND client_id=? AND date>=? LIMIT 2000`, unit.id, s.client_id, today)).map(r=>r.date);
  return new Response(hsIcalExport({unit, bookings, blockedDates:blocked, nowIso:new Date().toISOString()}), {status:200, headers:{'Content-Type':'text/calendar; charset=utf-8', 'Cache-Control':'max-age=300'}});
}

// ── Razorpay balance link paid (dispatched from hospitality-pro.js's verified webhook) ─────────
export async function hsBalancePaid(env, deps, clientId, bookingId, amount, paymentId){
  const cid=Number(clientId), nowIso=new Date().toISOString();
  const b=await one(env, `SELECT * FROM hospitality_bookings WHERE id=? AND client_id=?`, Number(bookingId), cid);
  if(!b) return {error:'Booking not found'};
  const ref=`razorpay:${paymentId}`;
  if(await one(env, `SELECT id FROM hosp_suite_payments WHERE client_id=? AND ref=?`, cid, ref)) return {ok:true, already:true};
  await run(env, `INSERT INTO hosp_suite_payments (client_id, booking_id, kind, amount, method, ref, status, note, created_at) VALUES (?,?,'balance',?,'razorpay',?,'paid','',?)`, cid, b.id, Number(amount)||0, ref, nowIso);
  try{
    const c=await deps.getClientById(env, cid);
    const cfg=await hsLoadConfig(env, cid);
    if(c) await hsSend(env, deps, c, cid, cfg, bookingTo(b), `✅ Payment received — ${hpFmtMoney(amount, b.currency)}. Thank you! See you on *${hpFmtDate(b.check_in)}* 🌴`, null);
  }catch(e){}
  return {ok:true};
}

// ── Dashboard API (/hospitality/suite/*) ────────────────────────────────────────────────────────
export async function hsHandleRoute(request, env, deps, url){
  const path=url.pathname, method=request.method;
  const {json}=deps;
  const payload=await deps.requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const cid=Number(payload.cid);
  const c=await deps.getClientById(env, cid);
  if(path==='/hospitality/desk/bootstrap' && method==='GET'){
    if(!c || c.hospitality_enabled!=='Yes') return json({error:'Hospitality is not enabled for this account.'}, 403);
    return json(await hsDeskBootstrap(env, c, cid, deps.now?deps.now():Date.now()));
  }
  // Tape chart: every unit's bookings, blocked dates and rate overrides for a date window, in one call.
  if(path==='/hospitality/desk/calendar' && method==='GET'){
    if(!c || c.hospitality_enabled!=='Yes') return json({error:'Hospitality is not enabled for this account.'}, 403);
    const start=V.date(url.searchParams.get('start')), end=V.date(url.searchParams.get('end'));
    if(!start || !end || end<=start || hpNightsBetween(start, end)>92) return json({error:'start and end (up to 92 days) required'}, 400);
    const [bookings, blocked, rates]=await Promise.all([
      all(env, `SELECT id, unit_id, guest_name, guest_phone, check_in, check_out, adults, children, total_amount, deposit_amount, currency, status, notes FROM hospitality_bookings
        WHERE client_id=? AND status<>'cancelled' AND check_in<? AND check_out>? ORDER BY check_in ASC LIMIT 3000`, cid, end, start),
      all(env, `SELECT unit_id, date, reason FROM hospitality_blocked_dates WHERE client_id=? AND date>=? AND date<?`, cid, start, end),
      all(env, `SELECT unit_id, date, rate FROM hospitality_rate_overrides WHERE client_id=? AND date>=? AND date<?`, cid, start, end),
    ]);
    return json({start, end, bookings, blocked, rates});
  }
  if(!hpEnabled(c)) return json({error:'Hospitality Pro is not enabled for this account.'}, 403);
  const body=['POST','PATCH','PUT','DELETE'].includes(method)?await request.json().catch(()=>({})):{};
  const nowMs=deps.now?deps.now():Date.now(), nowIso=new Date(nowMs).toISOString();
  const cfg=await hsLoadConfig(env, cid);
  const pro=await hpLoadConfig(env, cid);
  const today=hpLocalToday(nowMs, pro.tz_offset_min);
  const sub=path.slice('/hospitality/suite/'.length);
  const need=(...keys)=>keys.some(k=>hsOn(cfg, k))?null:json({error:`Switch on ${keys.map(k=>HS_MODULES.find(m=>m.features[k])?.features[k]||k).join(' or ')} in Settings first.`}, 403);
  const q=k=>url.searchParams.get(k);

  if(sub==='settings'){
    if(method==='GET'){
      const row=await hsSettingsRow(env, cid);
      return json({config:cfg, modules:HS_MODULES, requires:HS_REQUIRES, ical_token:row?.ical_token||null});
    }
    if(method==='PATCH'){
      const merged={...cfg, ...(body.config&&typeof body.config==='object'?body.config:{})};
      if(body.config?.features) merged.features={...cfg.features, ...body.config.features};
      const next=hsNormalizeConfig(merged);
      await run(env, `INSERT INTO hosp_suite_settings (client_id, config_json, updated_at) VALUES (?,?,?) ON CONFLICT(client_id) DO UPDATE SET config_json=excluded.config_json, updated_at=excluded.updated_at`, cid, JSON.stringify(next), nowIso);
      return json({ok:true, config:next});
    }
  }
  if(HS_TABLES[sub]){
    const spec=HS_TABLES[sub];
    const off=need(...spec.features); if(off) return off;
    return await hsCrud(env, json, spec, cid, method, body, nowIso);
  }

  if(sub==='alerts'){
    if(method==='GET') return json({list:await all(env, `SELECT * FROM hosp_suite_alerts WHERE client_id=? AND (status='open' OR created_at>?) ORDER BY status='open' DESC, id DESC LIMIT 200`, cid, new Date(nowMs-14*DAY).toISOString())});
    if(method==='PATCH'){
      if(body.all) await run(env, `UPDATE hosp_suite_alerts SET status='done' WHERE client_id=? AND status='open'`, cid);
      else await run(env, `UPDATE hosp_suite_alerts SET status=? WHERE id=? AND client_id=?`, body.status==='open'?'open':'done', Number(body.id), cid);
      return json({ok:true});
    }
  }
  if(sub==='summary'){
    const off=need('daily_summary'); if(off) return off;
    if(method==='GET'){
      const latest=await one(env, `SELECT * FROM hosp_suite_summaries WHERE client_id=? ORDER BY date DESC LIMIT 1`, cid);
      if(latest?.date===today) return json(latest);
      return json({date:today, text:hsSummaryText(await hsSummaryData(env, cid, today, c)), live:true});
    }
    if(method==='POST') return json(await hsDailySummary({env, deps, c, cid, cfg, today, nowIso}, !!body.send));
  }

  // ── Guest Journey ──
  if(sub==='journey' && method==='GET'){
    const from=V.date(q('from'))||hpAddDays(today, -3), to=V.date(q('to'))||hpAddDays(today, 30);
    const bookings=await all(env, `SELECT b.*, u.name AS unit_name FROM hospitality_bookings b LEFT JOIN hospitality_units u ON u.id=b.unit_id
      WHERE b.client_id=? AND b.status IN ('confirmed','checked_in','checked_out') AND b.check_out>=? AND b.check_in<=? ORDER BY b.check_in ASC LIMIT 400`, cid, from, to);
    const ids=bookings.map(b=>b.id);
    const inList=ids.length?ids.join(','):'0';
    const [rows, pays, extras, scans]=await Promise.all([
      all(env, `SELECT * FROM hosp_suite_booking WHERE client_id=? AND booking_id IN (${inList})`, cid),
      all(env, `SELECT * FROM hosp_suite_payments WHERE client_id=? AND booking_id IN (${inList}) ORDER BY id ASC`, cid),
      all(env, `SELECT * FROM hosp_suite_extras WHERE client_id=? AND booking_id IN (${inList}) ORDER BY id ASC`, cid),
      all(env, `SELECT booking_id, COUNT(*) n FROM hosp_suite_idscans WHERE client_id=? AND booking_id IN (${inList}) GROUP BY booking_id`, cid),
    ]);
    const by=(arr, k='booking_id')=>arr.reduce((m, x)=>((m[x[k]]=m[x[k]]||[]).push(x), m), {});
    const P=by(pays), E=by(extras), R=Object.fromEntries(rows.map(r=>[r.booking_id, r])), S=Object.fromEntries(scans.map(s=>[s.booking_id, s.n]));
    return json({today, list:bookings.map(b=>({...b, suite:{...(R[b.id]||{}), sent:parseJson(R[b.id]?.sent_json, {})}, payments:P[b.id]||[], extras:E[b.id]||[],
      id_count:S[b.id]||0, money:hsMoneyOf(b, (P[b.id]||[]).filter(p=>p.status!=='pending'), (E[b.id]||[]).filter(x=>['requested','confirmed'].includes(x.status)))}))});
  }
  if(sub==='payments'){
    const off=need('refunds','balance_reminders'); if(off) return off;
    if(method==='POST'){
      const b=await one(env, `SELECT id FROM hospitality_bookings WHERE id=? AND client_id=?`, Number(body.booking_id), cid);
      if(!b) return json({error:'Booking not found'}, 404);
      const amount=clamp(body.amount, 0, 1e9, 0);
      if(!amount) return json({error:'amount required'}, 400);
      const r=await run(env, `INSERT INTO hosp_suite_payments (client_id, booking_id, kind, amount, method, ref, status, note, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        cid, b.id, V.oneOf(['deposit','balance','extra','refund'], 'balance')(body.kind), amount, str(body.method, 40), str(body.ref, 120),
        V.oneOf(['paid','pending','refunded'], 'paid')(body.status), str(body.note, 300), nowIso);
      return json({ok:true, id:r.meta.last_row_id});
    }
    if(method==='PATCH'){
      await run(env, `UPDATE hosp_suite_payments SET status=? WHERE id=? AND client_id=?`, V.oneOf(['paid','pending','refunded'], 'paid')(body.status), Number(body.id), cid);
      return json({ok:true});
    }
    if(method==='DELETE'){ await run(env, `DELETE FROM hosp_suite_payments WHERE id=? AND client_id=?`, Number(body.id), cid); return json({ok:true}); }
  }
  if(sub==='extras'){
    if(method==='POST'){
      const b=await one(env, `SELECT id FROM hospitality_bookings WHERE id=? AND client_id=?`, Number(body.booking_id), cid);
      if(!b || !str(body.name, 80)) return json({error:'booking_id and name required'}, 400);
      const r=await run(env, `INSERT INTO hosp_suite_extras (client_id, booking_id, addon_id, name, amount, source, status, created_at) VALUES (?,?,?,?,?,'staff','confirmed',?)`,
        cid, b.id, V.idOrNull(body.addon_id), str(body.name, 80), clamp(body.amount, 0, 1e9, 0), nowIso);
      return json({ok:true, id:r.meta.last_row_id});
    }
    if(method==='PATCH'){
      await run(env, `UPDATE hosp_suite_extras SET status=? WHERE id=? AND client_id=?`, V.oneOf(['requested','confirmed','cancelled'], 'confirmed')(body.status), Number(body.id), cid);
      return json({ok:true});
    }
  }
  if(sub==='booking' && method==='PATCH'){
    const b=await one(env, `SELECT id FROM hospitality_bookings WHERE id=? AND client_id=?`, Number(body.booking_id), cid);
    if(!b) return json({error:'Booking not found'}, 404);
    const patch={};
    if(body.eta!==undefined) patch.eta=str(body.eta, 20);
    if(body.preferences!==undefined) patch.preferences=str(body.preferences, 500);
    if(body.checkin_status!==undefined) patch.checkin_status=V.oneOf(['','started','done'], '')(body.checkin_status);
    if(body.trip_type!==undefined) patch.trip_type=V.oneOf(['','day_cruise','overnight','night_stay'], '')(body.trip_type);
    if(body.jetty_id!==undefined) patch.jetty_id=V.idOrNull(body.jetty_id);
    if(body.boarding_time!==undefined) patch.boarding_time=V.hhmm('')(body.boarding_time);
    await hsUpsertBooking(env, cid, b.id, patch, nowIso);
    return json({ok:true});
  }
  if(sub==='idscans' && method==='GET'){
    return json({list:(await all(env, `SELECT * FROM hosp_suite_idscans WHERE client_id=? AND booking_id=? ORDER BY id ASC`, cid, Number(q('booking_id')))).map(x=>({...x, fields:parseJson(x.fields_json, {})}))});
  }
  if(sub==='journey/send' && method==='POST'){
    const b=await one(env, `SELECT * FROM hospitality_bookings WHERE id=? AND client_id=?`, Number(body.booking_id), cid);
    if(!b) return json({error:'Booking not found'}, 404);
    const units=await all(env, `SELECT * FROM hospitality_units WHERE client_id=?`, cid);
    const ctx={env, deps, c, cid, cfg, pro, today, hour:localHour(nowMs, pro.tz_offset_min), nowMs, nowIso, unitById:new Map(units.map(u=>[Number(u.id), u])), weather:new Map()};
    const row=await hsBookingRow(env, cid, b.id);
    const to=bookingTo(b);
    let status='skipped';
    const kind=String(body.kind||'');
    if(kind==='balance'){ const money=await hsBookingMoney(env, cid, b); if(money.balance<=0) return json({error:'No balance due on this booking.'}, 400); status=await hsSendBalance(ctx, b, money, null); }
    else if(kind==='pickup'){ const text=await hsPickupText(ctx, b, row); if(!text) return json({error:'Add a jetty to the boat (Fleet) or pickup text in Settings first.'}, 400); status=await hsSend(env, deps, c, cid, cfg, to, text, null, nowMs); }
    else if(kind==='boat_ready') status=await hsSend(env, deps, c, cid, cfg, to, `🚤 Your boat is ready and waiting at the jetty! ${str(body.text, 300)||'See you in a few minutes.'}`, null, nowMs);
    else if(kind==='driver_on_way') status=await hsSend(env, deps, c, cid, cfg, to, `🚗 Your driver is on the way! ${str(body.text, 300)}`, null, nowMs);
    else if(kind==='custom'){ if(!str(body.text, 1000)) return json({error:'text required'}, 400); status=await hsSend(env, deps, c, cid, cfg, to, str(body.text, 1000), null, nowMs); }
    else if(['checkin','upsell','meal','feedback','welcome','checkout'].includes(kind)){
      // Clear the matching "sent" mark and run the booking jobs as the scheduler would, right now.
      const sent=parseJson(row?.sent_json, {}); delete sent[kind];
      await hsUpsertBooking(env, cid, b.id, {sent_json:JSON.stringify(sent)}, nowIso);
      const forced={...cfg, features:Object.fromEntries(HS_FEATURES.map(k=>[k, false]))};
      const map={checkin:'web_checkin', upsell:'prearrival_upsell', meal:'meal_preorder', feedback:'feedback', welcome:'stay_messages', checkout:'stay_messages'};
      forced.features[map[kind]]=true;
      if(kind==='checkin') forced.checkin_days=365;
      if(kind==='upsell') forced.upsell_days=365;
      if(kind==='meal') forced.meal_days=365;
      if(kind==='welcome'){ forced.welcome_hour=0; }
      if(kind==='checkout'){ forced.checkout_hour=0; }
      if(kind==='feedback'){ forced.feedback_hour=0; }
      if(b.lead_id) await hsClearState(env, cid, b.lead_id);
      const bb=kind==='welcome'?{...b, check_in:today}:kind==='checkout'||kind==='feedback'?{...b, check_out:today}:b;
      await hsBookingJobs({...ctx, cfg:forced}, bb);
      status=parseJson((await hsBookingRow(env, cid, b.id))?.sent_json, {})[kind]?.s||'skipped';
    }
    else return json({error:'Unknown message kind'}, 400);
    return json({ok:status!=='skipped', status, wa_link:status==='skipped'&&b.guest_phone?`https://wa.me/${String(b.guest_phone).replace(/\D/g,'')}`:null});
  }

  // ── Houseboat operations ──
  if(sub==='fleet'){
    const off=need('fleet','maintenance','cruise_plan'); if(off) return off;
    if(method==='GET') return json({list:await all(env, `SELECT u.id AS unit_id, u.name, u.unit_type, u.capacity_adults, u.base_rate, u.currency, u.active, f.* FROM hospitality_units u LEFT JOIN hosp_suite_fleet f ON f.unit_id=u.id WHERE u.client_id=? ORDER BY u.name ASC`, cid)});
    if(method==='PUT'){
      const u=await one(env, `SELECT id FROM hospitality_units WHERE id=? AND client_id=?`, Number(body.unit_id), cid);
      if(!u) return json({error:'Unit not found'}, 404);
      const f={bedrooms:V.int(0, 20, 1), deck_type:V.text(40), ac:V.oneOf(['ac','non_ac','partial'], 'ac'), category:V.text(40), day_cruise_rate:V.num(0, 1e7),
        overnight_rate:V.num(0, 1e7), night_stay_rate:V.num(0, 1e7), jetty_id:V.idOrNull, engine_hours:V.num(0, 1e6), service_interval_hours:V.num(0, 1e5, 250),
        last_service_hours:V.num(0, 1e6), last_service_date:V.date};
      const existing=await one(env, `SELECT * FROM hosp_suite_fleet WHERE unit_id=?`, u.id);
      const vals={}; for(const [k, fn] of Object.entries(f)) vals[k]=body[k]!==undefined?fn(body[k]):(existing?existing[k]:fn(undefined));
      const cols=Object.keys(vals);
      await run(env, `INSERT INTO hosp_suite_fleet (unit_id, client_id, ${cols.join(',')}, updated_at) VALUES (?,?,${cols.map(()=>'?').join(',')},?)
        ON CONFLICT(unit_id) DO UPDATE SET ${cols.map(k=>`${k}=excluded.${k}`).join(', ')}, updated_at=excluded.updated_at`, u.id, cid, ...cols.map(k=>vals[k]), nowIso);
      return json({ok:true});
    }
  }
  if(sub==='boatlog'){
    const off=need('maintenance'); if(off) return off;
    if(method==='GET') return json({list:await all(env, `SELECT l.*, u.name AS unit_name FROM hosp_suite_boatlog l LEFT JOIN hospitality_units u ON u.id=l.unit_id WHERE l.client_id=? ${q('unit_id')?'AND l.unit_id=?':''} ORDER BY l.date DESC, l.id DESC LIMIT 300`, cid, ...(q('unit_id')?[Number(q('unit_id'))]:[]))});
    if(method==='POST'){
      const u=await one(env, `SELECT id FROM hospitality_units WHERE id=? AND client_id=?`, Number(body.unit_id), cid);
      if(!u) return json({error:'Unit not found'}, 404);
      const kind=V.oneOf(['fuel','service','repair'], 'fuel')(body.kind), date=V.date(body.date)||today, hours=V.numOrNull(0, 1e6)(body.engine_hours);
      const r=await run(env, `INSERT INTO hosp_suite_boatlog (client_id, unit_id, kind, date, litres, cost, engine_hours, note, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        cid, u.id, kind, date, clamp(body.litres, 0, 1e6, 0), clamp(body.cost, 0, 1e9, 0), hours, str(body.note, 300), nowIso);
      await run(env, `INSERT INTO hosp_suite_fleet (unit_id, client_id, updated_at) VALUES (?,?,?) ON CONFLICT(unit_id) DO NOTHING`, u.id, cid, nowIso);
      if(hours!=null) await run(env, `UPDATE hosp_suite_fleet SET engine_hours=MAX(engine_hours, ?), updated_at=? WHERE unit_id=?`, hours, nowIso, u.id);
      if(kind==='service') await run(env, `UPDATE hosp_suite_fleet SET last_service_hours=COALESCE(?, engine_hours), last_service_date=?, updated_at=? WHERE unit_id=?`, hours, date, nowIso, u.id);
      return json({ok:true, id:r.meta.last_row_id});
    }
    if(method==='DELETE'){ await run(env, `DELETE FROM hosp_suite_boatlog WHERE id=? AND client_id=?`, Number(body.id), cid); return json({ok:true}); }
  }
  if(sub==='crew'){
    const off=need('crew'); if(off) return off;
    if(method==='GET'){
      const from=V.date(q('from'))||today, to=V.date(q('to'))||hpAddDays(today, 14);
      return json({list:await all(env, `SELECT a.*, s.name AS staff_name, s.role AS staff_role, s.phone AS staff_phone, b.check_in, b.check_out, b.guest_name, b.unit_id
        FROM hosp_suite_crew_assign a JOIN hosp_suite_staff s ON s.id=a.staff_id JOIN hospitality_bookings b ON b.id=a.booking_id
        WHERE a.client_id=? AND b.check_out>=? AND b.check_in<=? ORDER BY b.check_in ASC`, cid, from, to)});
    }
    if(method==='POST'){
      const b=await one(env, `SELECT id, check_in, check_out FROM hospitality_bookings WHERE id=? AND client_id=?`, Number(body.booking_id), cid);
      const s=await one(env, `SELECT id, role, name FROM hosp_suite_staff WHERE id=? AND client_id=?`, Number(body.staff_id), cid);
      if(!b || !s) return json({error:'Booking or staff not found'}, 404);
      const clash=await one(env, `SELECT b2.id, b2.guest_name FROM hosp_suite_crew_assign a JOIN hospitality_bookings b2 ON b2.id=a.booking_id WHERE a.client_id=? AND a.staff_id=? AND a.booking_id<>? AND b2.status IN ('confirmed','checked_in') AND b2.check_in<? AND b2.check_out>? LIMIT 1`, cid, s.id, b.id, b.check_out, b.check_in);
      await run(env, `INSERT OR IGNORE INTO hosp_suite_crew_assign (client_id, booking_id, staff_id, role, created_at) VALUES (?,?,?,?,?)`, cid, b.id, s.id, s.role, nowIso);
      return json({ok:true, warning:clash?`${s.name} is also on booking #${clash.id} (${clash.guest_name||'guest'}) for overlapping dates.`:null});
    }
    if(method==='DELETE'){ await run(env, `DELETE FROM hosp_suite_crew_assign WHERE id=? AND client_id=?`, Number(body.id), cid); return json({ok:true}); }
  }
  if(sub==='cruise' && method==='GET'){
    const off=need('cruise_plan','crew','meal_preorder','pickup'); if(off) return off;
    const date=V.date(q('date'))||today;
    const bookings=await all(env, `SELECT b.*, u.name AS unit_name, f.jetty_id AS fleet_jetty, f.bedrooms, f.deck_type, f.ac FROM hospitality_bookings b JOIN hospitality_units u ON u.id=b.unit_id
      LEFT JOIN hosp_suite_fleet f ON f.unit_id=b.unit_id WHERE b.client_id=? AND b.status IN ('confirmed','checked_in') AND b.check_in<=? AND b.check_out>=? ORDER BY b.check_in ASC`, cid, date, date);
    const jetties=await all(env, `SELECT * FROM hosp_suite_jetties WHERE client_id=?`, cid);
    const J=Object.fromEntries(jetties.map(j=>[j.id, j]));
    const ids=bookings.map(b=>b.id).join(',')||'0';
    const [rows, crew, meals]=await Promise.all([
      all(env, `SELECT * FROM hosp_suite_booking WHERE client_id=? AND booking_id IN (${ids})`, cid),
      all(env, `SELECT a.id, a.booking_id, s.name, s.role, s.phone FROM hosp_suite_crew_assign a JOIN hosp_suite_staff s ON s.id=a.staff_id WHERE a.client_id=? AND a.booking_id IN (${ids})`, cid),
      all(env, `SELECT * FROM hosp_suite_meal_orders WHERE client_id=? AND booking_id IN (${ids})`, cid),
    ]);
    const R=Object.fromEntries(rows.map(r=>[r.booking_id, r]));
    return json({date, list:bookings.map(b=>{
      const r=R[b.id]||{};
      const jetty=J[r.jetty_id||b.fleet_jetty]||null;
      const trip={trip_type:r.trip_type||(b.check_in===b.check_out?'day_cruise':'overnight'), boarding_time:r.boarding_time||''};
      return {...b, suite:r, jetty, trip_type:trip.trip_type, plan:b.check_in===date?hsCruisePlan(trip, jetty):[],
        crew:crew.filter(x=>x.booking_id===b.id), meals:meals.filter(x=>x.booking_id===b.id).map(m=>({...m, items:parseJson(m.items_json, [])}))};
    })});
  }
  if(sub==='meals'){
    const off=need('meal_preorder'); if(off) return off;
    if(method==='GET'){
      const date=V.date(q('date'))||today;
      const list=await all(env, `SELECT m.*, b.guest_name, b.adults, b.children, b.check_in, b.check_out, u.name AS unit_name FROM hosp_suite_meal_orders m JOIN hospitality_bookings b ON b.id=m.booking_id
        LEFT JOIN hospitality_units u ON u.id=b.unit_id WHERE m.client_id=? AND b.check_in<=? AND b.check_out>=? AND b.status IN ('confirmed','checked_in') ORDER BY u.name ASC`, cid, date, date);
      return json({date, list:list.map(m=>({...m, items:parseJson(m.items_json, [])}))});
    }
    if(method==='PUT'){
      const b=await one(env, `SELECT id FROM hospitality_bookings WHERE id=? AND client_id=?`, Number(body.booking_id), cid);
      if(!b) return json({error:'Booking not found'}, 404);
      const meal=V.oneOf(HS_MEAL_ORDER, null)(body.meal);
      if(!meal) return json({error:'meal required'}, 400);
      const menu=await all(env, `SELECT id, name FROM hosp_suite_menu WHERE client_id=? AND meal=?`, cid, meal);
      const ids=new Set((Array.isArray(body.items)?body.items:[]).map(Number));
      const items=menu.filter(m=>ids.has(Number(m.id))).map(m=>({id:m.id, name:m.name}));
      await run(env, `INSERT INTO hosp_suite_meal_orders (client_id, booking_id, meal, items_json, notes, updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(booking_id, meal) DO UPDATE SET items_json=excluded.items_json, notes=excluded.notes, updated_at=excluded.updated_at`, cid, b.id, meal, JSON.stringify(items), str(body.notes, 300), nowIso);
      return json({ok:true});
    }
  }
  if(sub==='weather' && method==='GET'){
    const off=need('weather_alerts'); if(off) return off;
    const lat=V.numOrNull(-90, 90)(q('lat'))??cfg.weather_lat, lng=V.numOrNull(-180, 180)(q('lng'))??cfg.weather_lng;
    if(lat==null || lng==null) return json({error:'Set the property location (latitude / longitude) in Settings, or on a jetty.'}, 400);
    const fc=await hsForecast(deps, lat, lng).catch(()=>null);
    if(!fc) return json({error:'Weather service unavailable right now.'}, 502);
    return json({lat, lng, days:fc.time.map((d, i)=>({date:d, rain:fc.rain[i], wind:fc.wind[i], code:fc.code[i], bad:(Number(fc.rain[i])||0)>=cfg.rain_mm||(Number(fc.wind[i])||0)>=cfg.wind_kmh}))});
  }

  // ── Revenue & channels ──
  if(sub==='ical' || sub==='ical/sync'){
    const off=need('ical_sync'); if(off) return off;
    if(sub==='ical' && method==='GET'){
      let row=await hsSettingsRow(env, cid);
      if(!row?.ical_token){
        const token=randHex(20);
        await run(env, `INSERT INTO hosp_suite_settings (client_id, config_json, ical_token, updated_at) VALUES (?,?,?,?) ON CONFLICT(client_id) DO UPDATE SET ical_token=COALESCE(hosp_suite_settings.ical_token, excluded.ical_token)`, cid, JSON.stringify(cfg), token, nowIso);
        row=await hsSettingsRow(env, cid);
      }
      const units=await all(env, `SELECT id, name FROM hospitality_units WHERE client_id=? ORDER BY name ASC`, cid);
      return json({feeds:await all(env, `SELECT * FROM hosp_suite_ical WHERE client_id=? ORDER BY unit_id, id`, cid),
        exports:units.map(u=>({unit_id:u.id, name:u.name, path:`/hospitality/ical/${row.ical_token}/${u.id}.ics`}))});
    }
    if(sub==='ical' && method==='POST'){
      const u=await one(env, `SELECT id FROM hospitality_units WHERE id=? AND client_id=?`, Number(body.unit_id), cid);
      const link=V.url(String(body.url||'').replace(/^webcal:/i, 'https:'));
      if(!u || !link) return json({error:'Pick a unit and paste the calendar (iCal) link from the OTA.'}, 400);
      const r=await run(env, `INSERT INTO hosp_suite_ical (client_id, unit_id, source, url, created_at) VALUES (?,?,?,?,?)`, cid, u.id, str(body.source, 40)||'OTA', link, nowIso);
      const feed=await one(env, `SELECT * FROM hosp_suite_ical WHERE id=?`, r.meta.last_row_id);
      return json({ok:true, id:feed.id, sync:await hsIcalSync(env, deps, cid, feed, today, nowIso)});
    }
    if(sub==='ical' && method==='DELETE'){
      const f=await one(env, `SELECT id FROM hosp_suite_ical WHERE id=? AND client_id=?`, Number(body.id), cid);
      if(!f) return json({error:'Not found'}, 404);
      await hsRemoveOrigin(env, cid, `ical:${f.id}`, {fromDate:today});
      await run(env, `DELETE FROM hosp_suite_blocks WHERE client_id=? AND origin=?`, cid, `ical:${f.id}`);
      await run(env, `DELETE FROM hosp_suite_ical WHERE id=?`, f.id);
      return json({ok:true});
    }
    if(sub==='ical/sync' && method==='POST'){
      const f=await one(env, `SELECT * FROM hosp_suite_ical WHERE id=? AND client_id=?`, Number(body.id), cid);
      if(!f) return json({error:'Not found'}, 404);
      return json({ok:true, ...(await hsIcalSync(env, deps, cid, f, today, nowIso))});
    }
  }
  if(sub.startsWith('suggestions')){
    const off=need('pricing_rules'); if(off) return off;
    if(sub==='suggestions' && method==='GET') return json({list:await all(env, `SELECT s.*, u.name AS unit_name, u.currency FROM hosp_suite_price_suggestions s LEFT JOIN hospitality_units u ON u.id=s.unit_id WHERE s.client_id=? AND s.date>=? AND s.status='pending' ORDER BY s.date ASC, u.name ASC LIMIT 1000`, cid, today)});
    if(sub==='suggestions/generate' && method==='POST') return json({ok:true, count:await hsGenerateSuggestions(env, cid, today)});
    if((sub==='suggestions/apply' || sub==='suggestions/dismiss') && method==='POST'){
      const ids=Array.isArray(body.ids)?body.ids.map(Number).filter(Boolean):[];
      const rows=body.all?await all(env, `SELECT * FROM hosp_suite_price_suggestions WHERE client_id=? AND status='pending' AND date>=?`, cid, today)
        :ids.length?await all(env, `SELECT * FROM hosp_suite_price_suggestions WHERE client_id=? AND status='pending' AND id IN (${ids.join(',')})`, cid):[];
      for(const s of rows){
        if(sub==='suggestions/apply') await run(env, `INSERT INTO hospitality_rate_overrides (client_id, unit_id, date, rate, created_at) VALUES (?,?,?,?,?) ON CONFLICT(unit_id, date) DO UPDATE SET rate=excluded.rate`, cid, s.unit_id, s.date, s.suggested_rate, nowIso);
        await run(env, `UPDATE hosp_suite_price_suggestions SET status=? WHERE id=?`, sub==='suggestions/apply'?'applied':'dismissed', s.id);
      }
      return json({ok:true, count:rows.length});
    }
  }
  if(sub==='comp-rates'){
    const off=need('competitor_rates'); if(off) return off;
    if(method==='GET') return json({list:await all(env, `SELECT r.*, c.name AS competitor FROM hosp_suite_comp_rates r JOIN hosp_suite_competitors c ON c.id=r.competitor_id WHERE r.client_id=? AND r.date>=? ORDER BY r.date ASC, c.name ASC LIMIT 1000`, cid, V.date(q('from'))||hpAddDays(today, -7))});
    if(method==='POST'){
      const comp=await one(env, `SELECT * FROM hosp_suite_competitors WHERE id=? AND client_id=?`, Number(body.competitor_id), cid);
      const date=V.date(body.date), rate=clamp(body.rate, 0, 1e8, 0);
      if(!comp || !date || !rate) return json({error:'competitor, date and rate required'}, 400);
      const r=await run(env, `INSERT INTO hosp_suite_comp_rates (client_id, competitor_id, date, rate, room_label, created_at) VALUES (?,?,?,?,?,?)`, cid, comp.id, date, rate, str(body.room_label, 60), nowIso);
      // Compare with our cheapest unit's rate for that night.
      const units=await all(env, `SELECT * FROM hospitality_units WHERE client_id=? AND active=1`, cid);
      const ovs=await all(env, `SELECT unit_id, rate FROM hospitality_rate_overrides WHERE client_id=? AND date=?`, cid, date);
      const ovm=Object.fromEntries(ovs.map(o=>[o.unit_id, {[date]:o.rate}]));
      const ours=units.map(u=>hpNightlyRates(u, ovm[u.id]||{}, date, hpAddDays(date, 1))[0].rate).filter(x=>x>0);
      const min=ours.length?Math.min(...ours):0;
      let alert=null;
      if(min && rate<=min*(1-cfg.competitor_alert_pct/100)){
        alert=`${comp.name} is at ${hpFmtMoney(rate)} on ${hpFmtDate(date)} — ${Math.round((1-rate/min)*100)}% below your lowest rate (${hpFmtMoney(min)}).`;
        await hsAlert(env, cid, 'competitor', `Competitor price drop — ${comp.name}`, alert, `comp:${comp.id}:${date}:${rate}`, nowIso);
      }
      return json({ok:true, id:r.meta.last_row_id, our_rate:min, alert});
    }
    if(method==='DELETE'){ await run(env, `DELETE FROM hosp_suite_comp_rates WHERE id=? AND client_id=?`, Number(body.id), cid); return json({ok:true}); }
  }

  // ── Housekeeping ──
  if(sub==='room-status'){
    const off=need('housekeeping'); if(off) return off;
    if(method==='GET') return json({list:await all(env, `SELECT u.id AS unit_id, u.name, u.unit_type, u.active, COALESCE(r.status,'clean') AS status, r.note, r.updated_at FROM hospitality_units u LEFT JOIN hosp_suite_room_status r ON r.unit_id=u.id WHERE u.client_id=? ORDER BY u.name ASC`, cid)});
    if(method==='PUT'){
      const u=await one(env, `SELECT id FROM hospitality_units WHERE id=? AND client_id=?`, Number(body.unit_id), cid);
      if(!u) return json({error:'Unit not found'}, 404);
      await run(env, `INSERT INTO hosp_suite_room_status (unit_id, client_id, status, note, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(unit_id) DO UPDATE SET status=excluded.status, note=excluded.note, updated_at=excluded.updated_at`,
        u.id, cid, V.oneOf(['clean','dirty','inspected','out_of_order'], 'clean')(body.status), str(body.note, 200), nowIso);
      return json({ok:true});
    }
  }
  if(sub==='housekeeping/generate' && method==='POST'){
    const off=need('housekeeping'); if(off) return off;
    const units=await all(env, `SELECT * FROM hospitality_units WHERE client_id=?`, cid);
    const bookings=await all(env, `SELECT * FROM hospitality_bookings WHERE client_id=? AND status IN ('confirmed','checked_in','checked_out') AND check_in<=? AND check_out>=?`, cid, hpAddDays(today, 1), today);
    await hsHousekeepingJob({env, cid, today, nowIso, unitById:new Map(units.map(u=>[Number(u.id), u]))}, bookings);
    return json({ok:true});
  }
  if(sub==='tasks/notify' && method==='POST'){
    const off=need('staff_tasks'); if(off) return off;
    const task=await one(env, `SELECT t.*, u.name AS unit_name FROM hosp_suite_tasks t LEFT JOIN hospitality_units u ON u.id=t.unit_id WHERE t.id=? AND t.client_id=?`, Number(body.id), cid);
    const staff=task?.assignee_id?await one(env, `SELECT * FROM hosp_suite_staff WHERE id=? AND client_id=?`, task.assignee_id, cid):null;
    if(!task || !staff?.phone) return json({error:'Assign the task to a staff member with a phone number first.'}, 400);
    const text=`📋 New task #${task.id}${task.priority==='urgent'?' 🔴 URGENT':task.priority==='high'?' 🟠':''}: ${task.title}${task.notes?`\n${task.notes}`:''}${hsOn(cfg, 'staff_bot')?`\n\nReply *done ${task.id}* when finished.`:''}`;
    const status=await hsSend(env, deps, c, cid, cfg, {phone:staff.phone, name:staff.name}, text, null, nowMs);
    return json({ok:status!=='skipped', status, wa_link:`https://wa.me/${String(staff.phone).replace(/\D/g,'')}?text=${encodeURIComponent(text)}`});
  }

  // ── Reviews & guest memory ──
  if(sub==='guests'){
    const off=need('guest_profiles'); if(off) return off;
    if(method==='GET'){
      const bookings=await all(env, `SELECT guest_name, guest_phone, total_amount, check_in, check_out, status FROM hospitality_bookings WHERE client_id=? AND status IN ('confirmed','checked_in','checked_out') ORDER BY check_in ASC LIMIT 5000`, cid);
      const profiles=await all(env, `SELECT * FROM hosp_suite_guests WHERE client_id=?`, cid);
      const map=new Map();
      for(const p of profiles) map.set(p.phone_key, {...p, stays:0, spent:0, last_stay:null, next_stay:null});
      for(const b of bookings){
        const key=hpPhoneKey(b.guest_phone); if(key.length<6) continue;
        const g=map.get(key)||{phone_key:key, phone:b.guest_phone, name:'', birthday:'', anniversary:'', preferences:'', notes:'', stays:0, spent:0, last_stay:null, next_stay:null};
        if(b.guest_name && !g.name) g.name=b.guest_name;
        if(!g.phone) g.phone=b.guest_phone;
        if(b.check_out<=today || b.status==='checked_out'){ g.stays++; g.spent+=Number(b.total_amount)||0; if(!g.last_stay || b.check_out>g.last_stay) g.last_stay=b.check_out; }
        else if(!g.next_stay || b.check_in<g.next_stay) g.next_stay=b.check_in;
        map.set(key, g);
      }
      return json({list:[...map.values()].map(g=>({...g, spent:Math.round(g.spent)})).sort((a,b)=>b.stays-a.stays || String(a.name).localeCompare(String(b.name))).slice(0, 2000)});
    }
    if(method==='PUT'){
      const key=hpPhoneKey(body.phone);
      if(key.length<6) return json({error:'A valid phone number is required'}, 400);
      await run(env, `INSERT INTO hosp_suite_guests (client_id, phone_key, name, phone, birthday, anniversary, preferences, notes, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(client_id, phone_key) DO UPDATE SET name=excluded.name, phone=excluded.phone, birthday=excluded.birthday, anniversary=excluded.anniversary,
          preferences=excluded.preferences, notes=excluded.notes, updated_at=excluded.updated_at`,
        cid, key, str(body.name, 120), str(body.phone, 30), hsMonthDay(body.birthday), hsMonthDay(body.anniversary), str(body.preferences, 1000), str(body.notes, 1000), nowIso);
      return json({ok:true});
    }
  }
  if(sub==='feedback' && method==='GET'){
    const off=need('feedback'); if(off) return off;
    return json({list:await all(env, `SELECT s.booking_id, s.rating, s.feedback, s.updated_at, b.guest_name, b.guest_phone, b.check_in, b.check_out, u.name AS unit_name FROM hosp_suite_booking s
      JOIN hospitality_bookings b ON b.id=s.booking_id LEFT JOIN hospitality_units u ON u.id=b.unit_id WHERE s.client_id=? AND s.rating IS NOT NULL ORDER BY s.updated_at DESC LIMIT 300`, cid)});
  }
  if(sub==='reviews/draft' && method==='POST'){
    const off=need('review_replies'); if(off) return off;
    const rv=await one(env, `SELECT * FROM hosp_suite_reviews WHERE id=? AND client_id=?`, Number(body.id), cid);
    if(!rv) return json({error:'Not found'}, 404);
    const biz=c.client_name||c.business_name||'our property';
    const system=`You write public replies to online reviews for ${biz}, a hospitality business (style: ${c.hospitality_style||'hotel'}). Reply in the same language as the review. Be warm, specific to what the guest said, and short (40-90 words). Thank them; for criticism, apologise sincerely without excuses, say what is being done, and invite them to contact the manager directly. Never invent facts, offers, names or prices. Sign off as "Team ${biz}". Output only the reply text.`;
    const draft=deps.aiText?await deps.aiText(env, system, `Review on ${rv.source}${rv.rating?` (${rv.rating}/5)`:''} by ${rv.author||'a guest'}:\n\n${rv.text}`).catch(()=>null):null;
    if(!draft) return json({error:'Could not draft a reply right now — please try again.'}, 502);
    await run(env, `UPDATE hosp_suite_reviews SET reply=?, status='drafted', updated_at=? WHERE id=?`, draft.slice(0,4000), nowIso, rv.id);
    return json({ok:true, reply:draft});
  }

  // ── Agent desk ──
  if(sub==='allotments'){
    const off=need('allotments'); if(off) return off;
    if(method==='GET') return json({list:await all(env, `SELECT a.*, g.name AS agent_name, u.name AS unit_name FROM hosp_suite_allotments a LEFT JOIN hosp_suite_agents g ON g.id=a.agent_id LEFT JOIN hospitality_units u ON u.id=a.unit_id WHERE a.client_id=? ORDER BY a.status='active' DESC, a.start_date ASC LIMIT 300`, cid)});
    if(method==='POST'){
      const agent=await one(env, `SELECT id, name FROM hosp_suite_agents WHERE id=? AND client_id=?`, Number(body.agent_id), cid);
      const u=await one(env, `SELECT id FROM hospitality_units WHERE id=? AND client_id=?`, Number(body.unit_id), cid);
      const s=V.date(body.start_date), e=V.date(body.end_date);
      if(!agent || !u || !s || !e || e<=s || hpNightsBetween(s, e)>366) return json({error:'Agent, unit and a valid date range (up to a year) are required'}, 400);
      const r=await run(env, `INSERT INTO hosp_suite_allotments (client_id, agent_id, unit_id, start_date, end_date, release_days, status, created_at) VALUES (?,?,?,?,?,?,'active',?)`,
        cid, agent.id, u.id, s, e, V.int(0, 90, 7)(body.release_days), nowIso);
      const id=r.meta.last_row_id;
      let blocked=0, skipped=0;
      const busy=new Set();
      for(const b of await all(env, `SELECT check_in, check_out FROM hospitality_bookings WHERE unit_id=? AND status IN ('confirmed','checked_in','checked_out') AND check_in<? AND check_out>?`, u.id, e, s))
        for(let d=b.check_in; d<b.check_out; d=hpAddDays(d, 1)) busy.add(d);
      for(let d=s<today?today:s; d<e; d=hpAddDays(d, 1)){
        if(busy.has(d)){ skipped++; continue; }
        const ins=await run(env, `INSERT OR IGNORE INTO hospitality_blocked_dates (client_id, unit_id, date, reason, created_at) VALUES (?,?,?,?,?)`, cid, u.id, d, `Allotment: ${agent.name}`.slice(0,140), nowIso);
        if(ins.meta.changes){ blocked++; await run(env, `INSERT OR IGNORE INTO hosp_suite_blocks (client_id, origin, unit_id, date) VALUES (?,?,?,?)`, cid, `allot:${id}`, u.id, d); }
        else skipped++;
      }
      return json({ok:true, id, blocked, skipped});
    }
    if(method==='DELETE'){
      const a=await one(env, `SELECT id FROM hosp_suite_allotments WHERE id=? AND client_id=?`, Number(body.id), cid);
      if(!a) return json({error:'Not found'}, 404);
      await hsRemoveOrigin(env, cid, `allot:${a.id}`);
      await run(env, `UPDATE hosp_suite_allotments SET status='released' WHERE id=?`, a.id);
      return json({ok:true});
    }
  }
  if(sub==='agent-bookings'){
    const off=need('agents'); if(off) return off;
    if(method==='GET') return json({list:await all(env, `SELECT s.booking_id, s.agent_id, s.commission_amount, s.commission_status, b.guest_name, b.check_in, b.check_out, b.total_amount, b.currency, b.status, u.name AS unit_name, g.name AS agent_name, g.commission_pct
      FROM hosp_suite_booking s JOIN hospitality_bookings b ON b.id=s.booking_id LEFT JOIN hospitality_units u ON u.id=b.unit_id LEFT JOIN hosp_suite_agents g ON g.id=s.agent_id
      WHERE s.client_id=? AND s.agent_id IS NOT NULL ORDER BY b.check_in DESC LIMIT 500`, cid)});
    if(method==='PUT'){
      // Link an existing booking to an agent (or change the agent) — commission from the agent's %.
      const b=await one(env, `SELECT * FROM hospitality_bookings WHERE id=? AND client_id=?`, Number(body.booking_id), cid);
      const agent=body.agent_id?await one(env, `SELECT * FROM hosp_suite_agents WHERE id=? AND client_id=?`, Number(body.agent_id), cid):null;
      if(!b) return json({error:'Booking not found'}, 404);
      await hsUpsertBooking(env, cid, b.id, agent?{agent_id:agent.id, commission_amount:hpRound((Number(b.total_amount)||0)*(Number(agent.commission_pct)||0)/100, b.currency), commission_status:'due'}
        :{agent_id:null, commission_amount:0, commission_status:''}, nowIso);
      return json({ok:true});
    }
    if(method==='PATCH'){
      const off2=need('commissions'); if(off2) return off2;
      await run(env, `UPDATE hosp_suite_booking SET commission_status=?, commission_amount=COALESCE(?, commission_amount), updated_at=? WHERE booking_id=? AND client_id=? AND agent_id IS NOT NULL`,
        V.oneOf(['due','paid','void'], 'due')(body.commission_status), body.commission_amount!==undefined?clamp(body.commission_amount, 0, 1e9, 0):null, nowIso, Number(body.booking_id), cid);
      return json({ok:true});
    }
  }
  if(sub==='agents/confirm' && method==='POST'){
    const off=need('agents'); if(off) return off;
    const row=await hsBookingRow(env, cid, body.booking_id);
    const b=row?.agent_id?await one(env, `SELECT * FROM hospitality_bookings WHERE id=? AND client_id=?`, Number(body.booking_id), cid):null;
    if(!b) return json({error:'Agent booking not found'}, 404);
    const clash=await one(env, `SELECT id FROM hospitality_bookings WHERE client_id=? AND unit_id=? AND id<>? AND status IN ('confirmed','checked_in','checked_out') AND check_in<? AND check_out>? LIMIT 1`, cid, b.unit_id, b.id, b.check_out, b.check_in);
    if(clash) return json({error:`Unit already booked (booking #${clash.id}) for part of these dates.`}, 409);
    // This agent's own allotment blocks for the stay are released into the booking.
    for(const a of await all(env, `SELECT id FROM hosp_suite_allotments WHERE client_id=? AND agent_id=? AND unit_id=?`, cid, row.agent_id, b.unit_id)){
      for(let d=b.check_in; d<b.check_out; d=hpAddDays(d, 1)){
        const mine=await one(env, `SELECT 1 x FROM hosp_suite_blocks WHERE unit_id=? AND date=? AND origin=?`, b.unit_id, d, `allot:${a.id}`);
        if(mine){ await run(env, `DELETE FROM hospitality_blocked_dates WHERE unit_id=? AND date=? AND client_id=?`, b.unit_id, d, cid); await run(env, `DELETE FROM hosp_suite_blocks WHERE unit_id=? AND date=?`, b.unit_id, d); }
      }
    }
    const guest=str(body.guest_name, 140);
    await run(env, `UPDATE hospitality_bookings SET status='confirmed'${guest?', guest_name=?':''} WHERE id=?`, ...(guest?[guest]:[]), b.id);
    if(b.lead_id){
      const contact=await hsContactFor(env, cid, {leadId:b.lead_id});
      if(contact?.conv_id) await deps.sendText(env, c, String(cid), contact.conv_id, `✅ Booking #${b.id} confirmed — ${hpFmtRange(b.check_in, b.check_out)}. Thank you!`).catch(()=>{});
    }
    return json({ok:true});
  }
  return json({error:'Not found'}, 404);
}
