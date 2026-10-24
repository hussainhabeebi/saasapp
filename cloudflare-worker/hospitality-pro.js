// ── Hospitality Pro ──────────────────────────────────────────────────────────────────────────────
// An add-on module on top of the Hospitality module (worker.js "Hospitality module" section,
// migrations/0009_hospitality.sql), for resorts / homestays / houseboats that want the WhatsApp bot
// to sell, not just answer. Seven features, each borrowed from a tourism player that proved it:
//   1. Instant quote + "Hold this room" (Booking.com / Airbnb / MakeMyTrip) — dates → guests → unit
//      → priced quote → a timed hold with a deposit link (Razorpay or the resort's own UPI/bank text).
//   2. Virtual tour first, then the price (Airbnb photo-led listings, Marriott 360° tours) — the
//      unit's photos + tour links go out before the number does.
//   3. Upsells / add-ons at booking (Airbnb Experiences, Marriott, Oaky) — candlelight dinner,
//      campfire, pickup… tapped onto the quote.
//   4. Loyalty & repeat guests (Marriott Bonvoy, Taj InnerCircle) — returning numbers are welcomed
//      back and get their tier's discount automatically.
//   5. Abandoned-inquiry recovery (Expedia / MakeMyTrip "still thinking about…?") — up to N nudges
//      inside WhatsApp's 24-hour window, outside quiet hours, using only true availability numbers.
//   6. Group & event enquiries (hotel MICE desks, Cvent) — weddings / offsites / college tours are
//      routed into a short brief and handed to the team.
//   7. Digital guest registration (Duve, Canary) — ID photos collected on WhatsApp after a booking
//      is confirmed.
//
// Isolation guarantees ("no change for existing clients"):
//   - Everything is gated on hpEnabled(c): CLIENTS.hospitality_enabled==='Yes' AND
//     CLIENTS.hospitality_pro_enabled==='Yes'. A blank/missing column is "off".
//   - All data lives in new hosp_pro_* D1 tables (migrations/0109_hospitality_pro.sql). Existing
//     hospitality_* tables are only READ, except: a confirmed hold INSERTs a normal 'confirmed'
//     hospitality_bookings row (exactly what staff would add by hand), and tour photos record the
//     same hospitality_media_sent row the existing unit-photo sender writes.
//   - This file imports nothing from worker.js; worker.js passes the helpers it needs in as `deps`
//     (see HP_DEPS there), so the module can be unit-tested on its own against node:sqlite.
//
// deps shape: { json, requireSession, getClientById, reportOpsError,
//   sendText(env,c,clientId,convId,text)→bool, sendButtons(env,c,clientId,convId,text,items)→options|null|false,
//   sendPrivateNote(c,convId,text), sendUnitPhotos(env,c,clientId,convId,leadId,unit)→bool,
//   localize(env,c,text,lang)→text, getLead(env,leadId)→lead|null, isTakeover(lead)→bool }

export function hpEnabled(c){
  return !!c && c.hospitality_enabled==='Yes' && c.hospitality_pro_enabled==='Yes';
}

// ── Settings ─────────────────────────────────────────────────────────────────────────────────────
export const HP_FEATURES=['quote','tour_first','addons','loyalty','registration','recovery','groups'];
export const HP_DEFAULT_CONFIG={
  features:{quote:true, tour_first:true, addons:true, loyalty:true, registration:true, recovery:true, groups:true},
  hold_minutes:30,
  deposit_pct:25,
  payment_mode:'manual',          // 'manual' (payment_instructions text) | 'razorpay' (auto link + auto confirm)
  payment_instructions:'',
  loyalty:{silver_pct:5, gold_pct:10, platinum_pct:15},
  group_min_guests:10,
  recovery_hours:[2,20],          // idle hours before nudge 1, nudge 2… — all < 23 (WhatsApp 24h window)
  quiet_start:21, quiet_end:8,    // local hours — no automated nudges in between
  tz_offset_min:330,              // IST
  registration_message:'',
};

function hpClamp(v, min, max, dflt){
  if(v===null || v===undefined || v==='') return dflt;
  const n=Number(v);
  return Number.isFinite(n)?Math.min(max, Math.max(min, n)):dflt;
}

export function hpNormalizeConfig(raw){
  let src=raw;
  if(typeof raw==='string'){ try{ src=JSON.parse(raw||'{}'); }catch(e){ src={}; } }
  if(!src || typeof src!=='object') src={};
  const f=src.features&&typeof src.features==='object'?src.features:{};
  const features={};
  HP_FEATURES.forEach(k=>{ features[k]=f[k]===undefined?true:!!f[k]; });
  const loy=src.loyalty&&typeof src.loyalty==='object'?src.loyalty:{};
  let hours=Array.isArray(src.recovery_hours)
    ?src.recovery_hours.map(Number).filter(n=>Number.isFinite(n) && n>0 && n<23).slice(0,3)
    :[];
  if(!Array.isArray(src.recovery_hours)) hours=[...HP_DEFAULT_CONFIG.recovery_hours];
  hours.sort((a,b)=>a-b);
  return {
    features,
    hold_minutes:Math.round(hpClamp(src.hold_minutes, 15, 1440, HP_DEFAULT_CONFIG.hold_minutes)),
    deposit_pct:hpClamp(src.deposit_pct, 0, 100, HP_DEFAULT_CONFIG.deposit_pct),
    payment_mode:src.payment_mode==='razorpay'?'razorpay':'manual',
    payment_instructions:String(src.payment_instructions||'').trim().slice(0,600),
    loyalty:{
      silver_pct:hpClamp(loy.silver_pct, 0, 50, HP_DEFAULT_CONFIG.loyalty.silver_pct),
      gold_pct:hpClamp(loy.gold_pct, 0, 50, HP_DEFAULT_CONFIG.loyalty.gold_pct),
      platinum_pct:hpClamp(loy.platinum_pct, 0, 50, HP_DEFAULT_CONFIG.loyalty.platinum_pct),
    },
    group_min_guests:Math.round(hpClamp(src.group_min_guests, 4, 500, HP_DEFAULT_CONFIG.group_min_guests)),
    recovery_hours:hours,
    quiet_start:Math.round(hpClamp(src.quiet_start, 0, 23, HP_DEFAULT_CONFIG.quiet_start)),
    quiet_end:Math.round(hpClamp(src.quiet_end, 0, 23, HP_DEFAULT_CONFIG.quiet_end)),
    tz_offset_min:Math.round(hpClamp(src.tz_offset_min, -720, 840, HP_DEFAULT_CONFIG.tz_offset_min)),
    registration_message:String(src.registration_message||'').trim().slice(0,600),
  };
}

async function hpLoadSettingsRow(env, clientId){
  return await env.DB.prepare(`SELECT * FROM hosp_pro_settings WHERE client_id=?`).bind(Number(clientId)).first();
}
export async function hpLoadConfig(env, clientId){
  const row=await hpLoadSettingsRow(env, clientId);
  return hpNormalizeConfig(row?.config_json||'{}');
}

// ── Dates / money / time ─────────────────────────────────────────────────────────────────────────
export function hpAddDays(iso, n){
  const d=new Date(iso+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10);
}
export function hpNightsBetween(a, b){
  return Math.round((Date.parse(b+'T00:00:00Z')-Date.parse(a+'T00:00:00Z'))/86400000);
}
export function hpLocalToday(nowMs, tzOffsetMin){
  return new Date(nowMs+(Number(tzOffsetMin)||0)*60000).toISOString().slice(0,10);
}
export function hpIsQuietHour(nowMs, cfg){
  const h=new Date(nowMs+(Number(cfg.tz_offset_min)||0)*60000).getUTCHours();
  const s=cfg.quiet_start, e=cfg.quiet_end;
  if(s===e) return false;
  return s>e ? (h>=s || h<e) : (h>=s && h<e);
}
const HP_DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const HP_MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export function hpFmtDate(iso){
  const d=new Date(iso+'T00:00:00Z');
  return `${HP_DOW[d.getUTCDay()]}, ${d.getUTCDate()} ${HP_MON[d.getUTCMonth()]}`;
}
export function hpFmtRange(ci, co){
  const n=hpNightsBetween(ci, co);
  return `${hpFmtDate(ci)} → ${hpFmtDate(co)} (${n} night${n===1?'':'s'})`;
}
export function hpFmtTime(iso, tzOffsetMin){
  const d=new Date(Date.parse(iso)+(Number(tzOffsetMin)||0)*60000);
  let h=d.getUTCHours(); const m=String(d.getUTCMinutes()).padStart(2,'0');
  const ap=h>=12?'PM':'AM'; h=h%12||12;
  return `${h}:${m} ${ap}`;
}
const HP_CURRENCY_SYMBOL={INR:'₹', USD:'$', EUR:'€', GBP:'£'};
export function hpRound(n, currency){
  return String(currency||'INR').toUpperCase()==='INR' ? Math.round(Number(n)||0) : Math.round((Number(n)||0)*100)/100;
}
export function hpFmtMoney(n, currency){
  const cur=String(currency||'INR').toUpperCase();
  const v=hpRound(n, cur);
  const s=cur==='INR'?v.toLocaleString('en-IN'):v.toLocaleString('en-US');
  return HP_CURRENCY_SYMBOL[cur]?`${HP_CURRENCY_SYMBOL[cur]}${s}`:`${cur} ${s}`;
}

const HP_MONTH_RE='(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const HP_NOT_A_DAY='(?!\\s*(?:adults?|pax|people|persons?|guests?|members?|kids?|children|child|nights?|days?|rooms?|villas?|cottages?))';
function hpMonthNum(s){ return ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(String(s).slice(0,3).toLowerCase())+1; }
function hpIso(y, m, d){
  y=Number(y); m=Number(m); d=Number(d);
  if(!y||!m||!d||m>12||d>31) return null;
  const dt=new Date(Date.UTC(y, m-1, d));
  if(dt.getUTCFullYear()!==y || dt.getUTCMonth()!==m-1 || dt.getUTCDate()!==d) return null;
  return dt.toISOString().slice(0,10);
}
// A day+month with no year means the next time that date comes round (today counts).
function hpResolve(year, m, d, today){
  if(year){ const y=Number(year)<100?2000+Number(year):Number(year); return hpIso(y, m, d); }
  const ty=Number(today.slice(0,4));
  const iso=hpIso(ty, m, d);
  if(iso && iso>=today) return iso;
  return hpIso(ty+1, m, d);
}

// Parses the stay dates out of a free-text WhatsApp message. Understands "12-14 Dec", "12 to 14
// December 2026", "Dec 12-14", "12 Dec to 14 Dec", "12/12 - 14/12", "2026-12-12 to 2026-12-14",
// "tomorrow for 2 nights", "this weekend", "3 days 2 nights". Indian day-first order for numeric
// dates. Returns {check_in, check_out, nights} (any may be null) or null when nothing was found.
export function hpParseDateRange(text, today){
  const s=String(text||'').toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1');
  let nights=null;
  const nm=s.match(/\b(\d{1,2})\s*(?:nights?|n)\b/);
  if(nm) nights=Number(nm[1]);
  else{ const dm=s.match(/\b(\d{1,2})\s*days?\b/); if(dm) nights=Math.max(1, Number(dm[1])-1); }
  if(nights!==null && (nights<1 || nights>30)) nights=null;

  const SEP='\\s*(?:-|–|—|to|till|until|and|&)\\s*';
  let ci=null, co=null;
  let m=s.match(new RegExp(`\\b(\\d{1,2})${SEP}(\\d{1,2})\\s*(?:of\\s+)?${HP_MONTH_RE}\\b\\.?(?:,?\\s*(\\d{4}))?`));
  if(m){
    ci=hpResolve(m[4], hpMonthNum(m[3]), m[1], today);
    co=ci?hpResolve(m[4]||ci.slice(0,4), hpMonthNum(m[3]), m[2], today):null;
  }
  if(!ci){
    m=s.match(new RegExp(`\\b${HP_MONTH_RE}\\.?\\s*(\\d{1,2})${SEP}(\\d{1,2})\\b${HP_NOT_A_DAY}(?:,?\\s*(\\d{4}))?`));
    if(m){
      ci=hpResolve(m[4], hpMonthNum(m[1]), m[2], today);
      co=ci?hpResolve(m[4]||ci.slice(0,4), hpMonthNum(m[1]), m[3], today):null;
    }
  }
  if(!ci){
    const found=[];
    const scan=(re, fn)=>{ let x; re.lastIndex=0; while((x=re.exec(s))){ const r=fn(x); if(r) found.push({at:x.index, end:x.index+x[0].length, ...r}); } };
    scan(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, x=>({iso:hpIso(x[1], x[2], x[3]), year:true}));
    scan(/\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})\b/g, x=>({iso:hpResolve(x[3], x[2], x[1], today), year:true}));
    scan(/\b(\d{1,2})\/(\d{1,2})\b(?![\/.\-]\d)/g, x=>({iso:hpResolve(null, x[2], x[1], today), year:false}));
    scan(new RegExp(`\\b(\\d{1,2})\\s*(?:of\\s+)?${HP_MONTH_RE}\\b\\.?(?:,?\\s*(\\d{4}))?`, 'g'), x=>({iso:hpResolve(x[3], hpMonthNum(x[2]), x[1], today), year:!!x[3]}));
    scan(new RegExp(`\\b${HP_MONTH_RE}\\.?\\s+(\\d{1,2})\\b${HP_NOT_A_DAY}(?:,?\\s*(\\d{4}))?`, 'g'), x=>({iso:hpResolve(x[3], hpMonthNum(x[1]), x[2], today), year:!!x[3]}));
    scan(/\bday after tomorrow\b/g, ()=>({iso:hpAddDays(today, 2), year:true}));
    scan(/\btomorrow\b/g, ()=>({iso:hpAddDays(today, 1), year:true}));
    scan(/\btoday\b|\btonight\b/g, ()=>({iso:today, year:true}));
    // Greedy left-to-right, longest match first, so "12/12/2026" isn't also read as "12/12".
    found.sort((a,b)=>a.at-b.at || (b.end-b.at)-(a.end-a.at));
    const picked=[]; let lastEnd=-1;
    for(const f of found){ if(f.iso && f.at>=lastEnd){ picked.push(f); lastEnd=f.end; } }
    if(picked.length){
      ci=picked[0].iso;
      if(picked.length>1){
        co=picked[1].iso;
        if(co<=ci && !picked[1].year){ co=hpResolve(Number(co.slice(0,4))+1, co.slice(5,7), co.slice(8,10), today); }
      }
    }
  }
  if(!ci){
    const wk=s.match(/\b(this|next|coming)?\s*weekend\b/);
    if(wk){
      const dow=new Date(today+'T00:00:00Z').getUTCDay();
      let sat=hpAddDays(today, (6-dow+7)%7);
      if(wk[1]==='next') sat=hpAddDays(sat, 7);
      ci=sat; co=hpAddDays(sat, nights||1);
    }
  }
  if(ci && ci<today) ci=null;
  if(ci && co && (co<=ci || hpNightsBetween(ci, co)>30)) co=null;
  if(ci && !co && nights) co=hpAddDays(ci, nights);
  if(!ci && !nights) return null;
  return {check_in:ci, check_out:ci?co:null, nights:ci&&co?hpNightsBetween(ci, co):nights};
}

// "2 adults 1 kid", "4 pax", "family of 5", "a couple", "2+1", or (bare=true) just "4".
export function hpParseGuests(text, {bare=false}={}){
  const s=String(text||'').toLowerCase();
  const plus=s.match(/^\s*(\d{1,3})\s*\+\s*(\d{1,2})\s*$/);
  if(plus) return {adults:Number(plus[1]), children:Number(plus[2])};
  let adults=null, children=0;
  const a=s.match(/(\d{1,3})\s*(?:adults?|pax|people|persons?|guests?|members?|ppl|heads?|of us)\b/);
  if(a) adults=Number(a[1]);
  const cp=s.match(/(\d{1,2})\s*couples?\b/);
  if(cp) adults=(adults||0)+2*Number(cp[1]);
  else if(adults===null && /\bcouple\b/.test(s)) adults=2;
  const fam=s.match(/\bfamily of\s*(\d{1,2})\b/);
  if(fam && adults===null) adults=Number(fam[1]);
  const we=s.match(/\bwe\s*(?:are|r)\s*(\d{1,3})\b/);
  if(we && adults===null) adults=Number(we[1]);
  const k=s.match(/(\d{1,2})\s*(?:kids?|children|child|infants?|bab(?:y|ies))\b/);
  if(k) children=Number(k[1]);
  if(adults===null && bare){ const b=s.match(/^\s*(\d{1,3})\s*$/); if(b) adults=Number(b[1]); }
  if(adults===null || adults<1 || adults>999) return null;
  return {adults, children};
}

// Unit / add-on name matching against customer text or a (possibly truncated) button tap. Picks the
// longest matching name so "Lake View Villa" wins over "Villa".
export function hpMatchByName(text, items, key='name'){
  const lower=String(text||'').toLowerCase().normalize('NFC').trim();
  if(!lower) return null;
  const norm=s=>s.replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();
  const tapped=lower.replace(/(\.\.\.|…)$/,'').trim();
  let best=null;
  for(const it of (items||[])){
    const name=String(it?.[key]||'').toLowerCase().normalize('NFC').trim();
    if(name.length<3) continue;
    const hit=lower.includes(name)
      || (tapped.length>=4 && tapped!==lower && name.startsWith(tapped))
      || (norm(lower).length>=4 && norm(name)===norm(lower))
      || (norm(lower).length>=4 && norm(lower).includes(norm(name)) && norm(name).length>=3);
    if(hit && (!best || name.length>String(best[key]).length)) best=it;
  }
  return best;
}
function hpStripName(text, name){
  const i=String(text).toLowerCase().indexOf(String(name).toLowerCase());
  return i<0?String(text):(String(text).slice(0,i)+' '+String(text).slice(i+String(name).length));
}

// ── Pricing / loyalty ────────────────────────────────────────────────────────────────────────────
// Same rule handleHospitalityAvailability uses for the calendar: a per-date override wins, else the
// weekend rate on Sat/Sun nights when one is set, else the base rate.
export function hpNightlyRates(unit, overrides, checkIn, checkOut){
  const out=[];
  for(let d=checkIn; d<checkOut; d=hpAddDays(d, 1)){
    const dow=new Date(d+'T00:00:00Z').getUTCDay();
    const isWeekend=dow===0||dow===6;
    const rate=overrides&&overrides[d]!==undefined?Number(overrides[d]):(isWeekend&&unit.weekend_rate?Number(unit.weekend_rate):Number(unit.base_rate)||0);
    out.push({date:d, rate});
  }
  return out;
}
const HP_ADDON_PRICE_TYPES=['per_booking','per_night','per_guest','per_guest_night'];
export function hpAddonAmount(addon, nights, guests){
  const p=Number(addon.price)||0;
  switch(addon.price_type){
    case 'per_night': return p*nights;
    case 'per_guest': return p*guests;
    case 'per_guest_night': return p*guests*nights;
    default: return p;
  }
}
export function hpComputeQuote({nightly, adults=1, children=0, discountPct=0, addons=[], depositPct=0, currency='INR'}){
  const nights=nightly.length;
  const guests=(Number(adults)||0)+(Number(children)||0);
  const room_total=hpRound(nightly.reduce((s,n)=>s+n.rate, 0), currency);
  const discount_amount=hpRound(room_total*(Number(discountPct)||0)/100, currency);
  const lines=addons.map(a=>({id:a.id, name:a.name, amount:hpRound(hpAddonAmount(a, nights, guests), currency)}));
  const addons_total=hpRound(lines.reduce((s,l)=>s+l.amount, 0), currency);
  const total=hpRound(room_total-discount_amount+addons_total, currency);
  const deposit=hpRound(total*(Number(depositPct)||0)/100, currency);
  return {nights, room_total, discount_amount, addons:lines, addons_total, total, deposit};
}
export function hpLoyaltyTier(stays, loyalty){
  const n=Number(stays)||0;
  if(n>=5) return {tier:'Platinum', pct:Number(loyalty.platinum_pct)||0};
  if(n>=3) return {tier:'Gold', pct:Number(loyalty.gold_pct)||0};
  if(n>=1) return {tier:'Silver', pct:Number(loyalty.silver_pct)||0};
  return {tier:null, pct:0};
}
export function hpPhoneKey(phone){
  const d=String(phone||'').replace(/\D/g,'');
  return d.length>10?d.slice(-10):d;
}
// Past stays only (checked out, or a confirmed stay whose check-out date has passed) — a future
// booking doesn't make someone a "returning" guest yet.
export async function hpGuestHistory(env, clientId, phone, today){
  const key=hpPhoneKey(phone);
  if(key.length<6) return {stays:0, spent:0, last_unit_id:null, last_check_out:null};
  // Staff type phones by hand ("+91 98470-00707", "(984) 700 0707"…), so strip the usual
  // separators before matching the last 10 digits; hpPhoneKey re-checks exactly below.
  const {results}=await env.DB.prepare(`SELECT unit_id, guest_phone, total_amount, check_out, status FROM hospitality_bookings WHERE client_id=? AND status IN ('confirmed','checked_in','checked_out')
      AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(guest_phone,' ',''),'-',''),'+',''),'(',''),')',''),'.','') LIKE ?`)
    .bind(Number(clientId), `%${key}`).all();
  let stays=0, spent=0, last=null;
  for(const b of (results||[])){
    if(hpPhoneKey(b.guest_phone)!==key) continue;
    if(!(b.status==='checked_out' || b.check_out<=today)) continue;
    stays++; spent+=Number(b.total_amount)||0;
    if(!last || b.check_out>last.check_out) last=b;
  }
  return {stays, spent, last_unit_id:last?.unit_id||null, last_check_out:last?.check_out||null};
}

// ── Availability (bookings + blocked dates + other guests' live holds) ───────────────────────────
function hpFits(unit, adults, children){
  const ca=Number(unit.capacity_adults)||0, cc=Number(unit.capacity_children)||0;
  return adults<=ca && (adults+children)<=(ca+cc);
}
export async function hpAvailableUnits(env, clientId, checkIn, checkOut, {adults=1, children=0, leadId=null, units=null, nowIso=new Date().toISOString()}={}){
  const cid=Number(clientId);
  if(!units){
    const {results}=await env.DB.prepare(`SELECT * FROM hospitality_units WHERE client_id=? AND active=1 ORDER BY base_rate ASC, name ASC`).bind(cid).all();
    units=results||[];
  }
  const [{results:booked}, {results:blocked}, {results:held}]=await Promise.all([
    env.DB.prepare(`SELECT unit_id FROM hospitality_bookings WHERE client_id=? AND status IN ('confirmed','checked_in','checked_out') AND check_in<? AND check_out>?`).bind(cid, checkOut, checkIn).all(),
    env.DB.prepare(`SELECT unit_id FROM hospitality_blocked_dates WHERE client_id=? AND date>=? AND date<?`).bind(cid, checkIn, checkOut).all(),
    // A claimed-but-unverified payment keeps blocking for 48h so staff have time to check it.
    env.DB.prepare(`SELECT unit_id, lead_id FROM hosp_pro_holds WHERE client_id=? AND check_in<? AND check_out>? AND ((status='payment_claimed' AND updated_at>?) OR (status='active' AND expires_at>?))`)
      .bind(cid, checkOut, checkIn, new Date(Date.parse(nowIso)-48*3600e3).toISOString(), nowIso).all(),
  ]);
  const taken=new Set([...(booked||[]), ...(blocked||[])].map(r=>Number(r.unit_id)));
  (held||[]).forEach(h=>{ if(!leadId || Number(h.lead_id)!==Number(leadId)) taken.add(Number(h.unit_id)); });
  return units.filter(u=>!taken.has(Number(u.id)) && hpFits(u, adults, children));
}

async function hpRateOverrides(env, unitId, checkIn, checkOut){
  const {results}=await env.DB.prepare(`SELECT date, rate FROM hospitality_rate_overrides WHERE unit_id=? AND date>=? AND date<?`).bind(Number(unitId), checkIn, checkOut).all();
  const map={}; (results||[]).forEach(r=>{ map[r.date]=r.rate; });
  return map;
}
async function hpActiveAddons(env, clientId){
  const {results}=await env.DB.prepare(`SELECT * FROM hosp_pro_addons WHERE client_id=? AND active=1 ORDER BY sort_order ASC, id ASC`).bind(Number(clientId)).all();
  return results||[];
}

// ── Conversation state ───────────────────────────────────────────────────────────────────────────
const HP_STATE_TTL_MS={quote:48*3600e3, group:48*3600e3, registration:14*86400e3};
export async function hpGetState(env, clientId, leadId, nowMs=Date.now()){
  const row=await env.DB.prepare(`SELECT state_json, updated_at FROM hosp_pro_state WHERE client_id=? AND lead_id=?`).bind(Number(clientId), Number(leadId)).first();
  if(!row) return null;
  let st=null; try{ st=JSON.parse(row.state_json); }catch(e){}
  if(!st || !st.flow) return null;
  if(nowMs-Date.parse(row.updated_at)>(HP_STATE_TTL_MS[st.flow]||48*3600e3)) return null;
  return st;
}
export async function hpSaveState(env, clientId, leadId, st, nowMs=Date.now()){
  await env.DB.prepare(`INSERT INTO hosp_pro_state (client_id, lead_id, state_json, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(client_id, lead_id) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at`)
    .bind(Number(clientId), Number(leadId), JSON.stringify(st), new Date(nowMs).toISOString()).run();
}
export async function hpClearState(env, clientId, leadId){
  await env.DB.prepare(`DELETE FROM hosp_pro_state WHERE client_id=? AND lead_id=?`).bind(Number(clientId), Number(leadId)).run();
}

// ── Intent detection ─────────────────────────────────────────────────────────────────────────────
const HP_QUOTE_RE=/\b(book(?:ing)?|reserve|reservation|quote|quotation|hold\s+(?:the|this|a|my)\s+room|check\s+availability|availability|vacanc(?:y|ies))\b/i;
const HP_QUOTE_EXCLUDE_RE=/\b(cancel\w*|refund|modify|reschedul\w*|status|my\s+booking|booking\s+(?:id|number|ref\w*))\b/i;
const HP_PRICE_RE=/\b(price|prices|pricing|rate|rates|tariff|tariffs|cost|how\s+much|charges?)\b/i;
const HP_GROUP_RE=/\b(wedding|marriage|reception|engagement|corporate|offsite|off-site|conference|seminar|team\s+outing|team\s+building|retreat|college\s+tour|school\s+tour|study\s+tour|group\s+booking|group\s+tour|group\s+of|banquet|event|reunion|mice|delegates)\b/i;
const HP_HOLD_RE=/\bhold\b|\bconfirm\s+(?:it|this|booking)\b|\bbook\s+(?:it|now)\b/i;
const HP_PAID_RE=/\b(paid|payment\s+(?:done|made|completed|sent)|(?:done|made|sent|completed)\s+(?:the\s+)?payment|transferred|amount\s+sent)\b/i;
const HP_STOP_RE=/^\s*(cancel|stop|exit|quit|never\s*mind|nevermind|not\s+now|no\s+thanks)\s*[.!]*\s*$/i;
const HP_HUMAN_RE=/\b(talk|speak|chat|connect)\s+(?:to|with)\s+(?:the\s+|a\s+|your\s+)?(team|human|agent|someone|person|manager|staff|owner)\b/i;
const HP_DONE_RE=/^\s*(?:✅\s*)?(done|finished|completed|that'?s\s+all|all\s+sent|ok\s+done|no\s+extras|skip|no\s+thanks|continue|proceed|none)\b/i;

export function hpDetectStart(text, cfg, {datesFound=false, unitMatched=false, guests=null}={}){
  const s=String(text||'');
  if(!s.trim()) return null;
  if(cfg.features.groups){
    if(HP_GROUP_RE.test(s)) return 'group';
    if(guests && guests.adults+guests.children>=cfg.group_min_guests) return 'group';
  }
  if(!cfg.features.quote) return null;
  if(HP_QUOTE_EXCLUDE_RE.test(s)) return null;
  if(HP_QUOTE_RE.test(s)) return 'quote';
  if(HP_PRICE_RE.test(s) && (datesFound || unitMatched)) return 'quote';
  if(datesFound && (unitMatched || guests)) return 'quote';
  return null;
}

// ── Turn handler (called from handleEngineWebhook for Pro clients only) ─────────────────────────
// t: {c, clientId, convId, leadId, phone, name, userText, rawText, mediaType, mediaUrl, lang,
//     selectedUnit, optOut, humanExplicit, nowMs?}
// Returns {handled:false} to fall through to the existing hospitality/LLM path unchanged, or
// {handled:true, reply, quickReplies} when this turn's reply was already sent from here.
export async function hpHandleTurn(env, deps, t){
  const nowMs=t.nowMs||Date.now();
  const nowIso=new Date(nowMs).toISOString();
  const cid=Number(t.clientId), leadId=Number(t.leadId);
  if(!cid || !leadId) return {handled:false};
  const cfg=await hpLoadConfig(env, cid);
  const today=hpLocalToday(nowMs, cfg.tz_offset_min);
  const isMedia=(t.mediaType==='image' || t.mediaType==='file') && !!t.mediaUrl;
  const text=String((isMedia?t.rawText:(t.userText||t.rawText))||'').trim();
  const lower=text.toLowerCase();
  const ctx={env, deps, t, cfg, cid, leadId, nowMs, nowIso, today, text, lower, isMedia};

  // Any inbound message counts as activity — the recovery sweep only nudges idle leads.
  await env.DB.prepare(`UPDATE hosp_pro_recovery SET last_activity_at=?, updated_at=? WHERE client_id=? AND lead_id=? AND status='active'`)
    .bind(nowIso, nowIso, cid, leadId).run();

  let st=await hpGetState(env, cid, leadId, nowMs);
  if(t.optOut){
    await env.DB.prepare(`UPDATE hosp_pro_recovery SET status='stopped', updated_at=? WHERE client_id=? AND lead_id=?`).bind(nowIso, cid, leadId).run();
    if(st) await hpClearState(env, cid, leadId);
    return {handled:false};
  }
  if(t.humanExplicit || HP_HUMAN_RE.test(lower)){
    if(st && st.flow!=='registration') await hpClearState(env, cid, leadId);
    return {handled:false};
  }

  // Deposit paid? ("PAID", "payment done", or a screenshot while a hold is live.)
  if(!(st && st.flow==='registration')){
    const hold=await env.DB.prepare(`SELECT * FROM hosp_pro_holds WHERE client_id=? AND lead_id=? AND status IN ('active','expired','payment_claimed') AND created_at>? ORDER BY id DESC LIMIT 1`)
      .bind(cid, leadId, new Date(nowMs-24*3600e3).toISOString()).first();
    const live=hold && hold.status==='active' && hold.expires_at>nowIso;
    if(hold && (HP_PAID_RE.test(lower) || (isMedia && live))) return await hpClaimPayment(ctx, hold);
  }

  if(st){
    if(st.flow!=='registration' && HP_STOP_RE.test(lower)){
      await hpClearState(env, cid, leadId);
      return await hpSay(ctx, `No problem 👍 I've stopped that request. Anything else I can help you with?`);
    }
    if(st.flow==='registration') return await hpRegistrationTurn(ctx, st);
    if(st.flow==='group') return await hpGroupTurn(ctx, st, false);
    if(st.flow==='quote') return await hpQuoteTurn(ctx, st, false);
  }

  if(isMedia || !text) return {handled:false};
  const {results:units}=await env.DB.prepare(`SELECT * FROM hospitality_units WHERE client_id=? AND active=1 ORDER BY base_rate ASC, name ASC`).bind(cid).all();
  const unitMatch=hpMatchByName(text, units||[]);
  const dates=hpParseDateRange(unitMatch?hpStripName(text, unitMatch.name):text, today);
  const guests=hpParseGuests(text);
  const start=hpDetectStart(text, cfg, {datesFound:!!dates?.check_in, unitMatched:!!unitMatch, guests});
  if(start==='group') return await hpGroupTurn(ctx, {flow:'group', step:null, data:{}}, true);
  if(start==='quote' && (units||[]).length) return await hpQuoteTurn(ctx, {flow:'quote', step:null, data:{}}, true, units);
  return {handled:false};
}

async function hpSay(ctx, text, buttons){
  const {env, deps, t}=ctx;
  const body=t.lang && t.lang!=='en' && deps.localize ? (await deps.localize(env, t.c, text, t.lang).catch(()=>text))||text : text;
  if(buttons && buttons.length){
    const opts=await deps.sendButtons(env, t.c, String(ctx.cid), t.convId, body, buttons);
    return {handled:true, reply:body, quickReplies:Array.isArray(opts)?opts:null};
  }
  await deps.sendText(env, t.c, String(ctx.cid), t.convId, body);
  return {handled:true, reply:body};
}
function hpFirstName(name){
  const n=String(name||'').trim().split(/\s+/)[0]||'';
  return /^[+\d]/.test(n)?'':n;
}
const HP_GUEST_BUTTONS=[
  {title:'2 Adults', value:'2 adults'},
  {title:'2 Adults + 1 Child', value:'2 adults 1 child'},
  {title:'2 Adults + 2 Children', value:'2 adults 2 children'},
  {title:'3 Adults', value:'3 adults'},
  {title:'4 Adults', value:'4 adults'},
  {title:'1 Adult', value:'1 adult'},
];

// ── Quote flow ───────────────────────────────────────────────────────────────────────────────────
async function hpQuoteTurn(ctx, st, isStart, unitsIn=null){
  const {env, cid, leadId, cfg, today, nowMs}=ctx;
  const d=st.data||(st.data={});
  const units=unitsIn||((await env.DB.prepare(`SELECT * FROM hospitality_units WHERE client_id=? AND active=1 ORDER BY base_rate ASC, name ASC`).bind(cid).all()).results||[]);
  if(!units.length){ await hpClearState(env, cid, leadId); return {handled:false}; }
  let text=ctx.text;
  const lower=ctx.lower;
  let consumed=false;

  if(st.step==='confirm' && HP_HOLD_RE.test(lower) && d.check_in && d.check_out && d.unit_id) return await hpCreateHold(ctx, st, units);
  if(/\b(change|other|different|new)\s+dates?\b/i.test(lower)){
    d.check_in=null; d.check_out=null; d.unit_id=null; consumed=true;
  }
  if(st.step==='addons'){
    if(HP_DONE_RE.test(lower)){ d.addons_done=true; consumed=true; }
    else{
      const addons=await hpActiveAddons(env, cid);
      const hit=hpMatchByName(text.replace(/^\s*(?:➕|✔️|✅)\s*/,''), addons);
      if(hit){
        d.addon_ids=Array.isArray(d.addon_ids)?d.addon_ids:[];
        if(!d.addon_ids.includes(hit.id)) d.addon_ids.push(hit.id);
        consumed=true;
      }
    }
  }
  let um=st.step==='addons'?null:hpMatchByName(text, units);
  if(um){ d.unit_id=um.id; consumed=true; text=hpStripName(text, um.name); }
  // "Book / Check Availability" tapped under a unit the existing resort flow already showed.
  if(!um && isStart && !d.unit_id && ctx.t.selectedUnit){ um=hpMatchByName(ctx.t.selectedUnit, units); if(um) d.unit_id=um.id; }
  if(st.step==='unit' && /\b(show|see|view|other)\b.*\b(options?|rooms?|units?|stays?)\b/i.test(lower)) consumed=true;
  if(st.step!=='addons'){
    const dr=hpParseDateRange(text, today);
    if(dr?.check_in){
      d.check_in=dr.check_in; d.check_out=dr.check_out||(d.nights?hpAddDays(dr.check_in, d.nights):null); consumed=true;
    }else if(dr?.nights){
      d.nights=dr.nights; if(d.check_in) d.check_out=hpAddDays(d.check_in, dr.nights); consumed=true;
    }else if(st.step==='nights' && d.check_in){
      const n=lower.match(/^\s*(\d{1,2})\s*$/);
      if(n && Number(n[1])>=1 && Number(n[1])<=30){ d.check_out=hpAddDays(d.check_in, Number(n[1])); consumed=true; }
    }
    if(st.step!=='unit'){
      const g=hpParseGuests(text, {bare:st.step==='guests'});
      if(g){ d.adults=g.adults; d.children=g.children; consumed=true; }
    }
  }
  if(!isStart && !consumed){
    // Not an answer to the question we asked (a side question, small talk…) — let the normal bot
    // answer it and keep the flow parked; give up after two misses so it never traps anyone.
    st.misses=(st.misses||0)+1;
    if(st.misses>=2) await hpClearState(env, cid, leadId); else await hpSaveState(env, cid, leadId, st, nowMs);
    return {handled:false};
  }
  st.misses=0;

  const guests=(d.adults||0)+(d.children||0);
  if(cfg.features.groups && d.adults && guests>=cfg.group_min_guests){
    return await hpGroupTurn(ctx, {flow:'group', step:null, data:{group_size:guests, check_in:d.check_in||null, check_out:d.check_out||null}}, true);
  }
  if(!d.check_in){
    st.step='dates'; await hpSaveState(env, cid, leadId, st, nowMs);
    return await hpSay(ctx, `Lovely! 🌴 Which dates are you planning to stay?\n\nJust type them, e.g. *12 Dec to 14 Dec*`,
      [{title:'This weekend', value:'this weekend'}, {title:'Tomorrow, 1 night', value:'tomorrow for 1 night'}]);
  }
  if(!d.check_out){
    st.step='nights'; await hpSaveState(env, cid, leadId, st, nowMs);
    return await hpSay(ctx, `How many nights from *${hpFmtDate(d.check_in)}*?`,
      [{title:'1 night', value:'1 night'}, {title:'2 nights', value:'2 nights'}, {title:'3 nights', value:'3 nights'}]);
  }
  if(!d.adults){
    st.step='guests'; await hpSaveState(env, cid, leadId, st, nowMs);
    return await hpSay(ctx, `👥 How many guests? (or type e.g. *5 adults 2 kids*)`, HP_GUEST_BUTTONS);
  }

  const avail=await hpAvailableUnits(env, cid, d.check_in, d.check_out, {adults:d.adults, children:d.children||0, leadId, units, nowIso:ctx.nowIso});
  let note='';
  if(d.unit_id && !avail.some(u=>Number(u.id)===Number(d.unit_id))){
    const chosen=units.find(u=>Number(u.id)===Number(d.unit_id));
    note=chosen?(hpFits(chosen, d.adults, d.children||0)
      ?`😔 *${chosen.name}* is already booked for ${hpFmtRange(d.check_in, d.check_out)}.\n\n`
      :`*${chosen.name}* fits up to ${chosen.capacity_adults} adults${Number(chosen.capacity_children)?` + ${chosen.capacity_children} children`:''}.\n\n`):'';
    d.unit_id=null;
  }
  if(!d.unit_id){
    if(!avail.length){
      if(cfg.features.groups && !units.some(u=>hpFits(u, d.adults, d.children||0))){
        // No single room fits this party — that's a multi-room booking, which the team prices.
        return await hpGroupTurn(ctx, {flow:'group', step:null, data:{event_type:'Family / Friends', group_size:guests, check_in:d.check_in, check_out:d.check_out}}, true);
      }
      d.check_in=null; d.check_out=null; st.step='dates';
      await hpSaveState(env, cid, leadId, st, nowMs);
      return await hpSay(ctx, `${note}😔 Sorry, we're fully booked for those dates. Would you like to try different dates?`,
        [{title:'📅 Change dates', value:'change dates'}, {title:'💬 Talk to team', value:'talk to team'}]);
    }
    if(avail.length===1 && !note){
      d.unit_id=avail[0].id;
    }else{
      st.step='unit'; await hpSaveState(env, cid, leadId, st, nowMs);
      const history=cfg.features.loyalty?await hpGuestHistory(env, cid, ctx.t.phone, today):{stays:0};
      const lines=[];
      for(const u of avail.slice(0, 10)){
        const cap=`up to ${u.capacity_adults} adults${Number(u.capacity_children)?` + ${u.capacity_children} kids`:''}`;
        const fav=history.last_unit_id && Number(history.last_unit_id)===Number(u.id)?' ⭐ your last stay':'';
        if(cfg.features.tour_first){ lines.push(`• *${u.name}* — ${cap}${fav}`); }
        else{
          const nightly=hpNightlyRates(u, await hpRateOverrides(env, u.id, d.check_in, d.check_out), d.check_in, d.check_out);
          const tot=nightly.reduce((s,n)=>s+n.rate, 0);
          lines.push(`• *${u.name}* — ${hpFmtMoney(tot, u.currency)} (${cap})${fav}`);
        }
      }
      const lead=avail.length<=2?`Only ${avail.length} ${avail.length===1?'option is':'options are'} left for these dates:`:`Available for ${hpFmtRange(d.check_in, d.check_out)}:`;
      return await hpSay(ctx, `${note}✅ ${lead}\n\n${lines.join('\n')}\n\nWhich one would you like? 👇`,
        avail.slice(0, 10).map(u=>({title:u.name, value:u.name})));
    }
  }

  const unit=units.find(u=>Number(u.id)===Number(d.unit_id));
  if(cfg.features.tour_first && !d.toured){ await hpSendTour(ctx, unit); d.toured=true; }
  const addons=cfg.features.addons?await hpActiveAddons(env, cid):[];
  const q=await hpBuildQuote(ctx, unit, d, addons);
  if(addons.length && !d.addons_done){
    const chosen=new Set(d.addon_ids||[]);
    const remaining=addons.filter(a=>!chosen.has(a.id));
    if(remaining.length){
      st.step='addons'; await hpSaveState(env, cid, leadId, st, nowMs);
      const picked=q.quote.addons.length?`\n\nAdded so far: ${q.quote.addons.map(a=>`${a.name} (${hpFmtMoney(a.amount, q.currency)})`).join(', ')}`:'';
      const menu=remaining.slice(0, 9).map(a=>`• *${a.name}* — ${hpFmtMoney(a.price, a.currency||q.currency)}${hpAddonSuffix(a.price_type)}${a.description?` · ${a.description}`:''}`).join('\n');
      return await hpSay(ctx, `*${unit.name}* · ${hpFmtRange(d.check_in, d.check_out)}\nRoom total: *${hpFmtMoney(q.quote.room_total-q.quote.discount_amount, q.currency)}*${picked}\n\n✨ Make it special — tap to add any extras:\n${menu}`,
        [...remaining.slice(0, 9).map(a=>({title:a.name, value:a.name})), {title:'✅ Done', value:'done'}]);
    }
    d.addons_done=true;
  }
  st.step='confirm'; await hpSaveState(env, cid, leadId, st, nowMs);
  if(cfg.features.recovery) await hpUpsertRecovery(ctx, unit, d, q);
  return await hpSay(ctx, hpQuoteText(unit, d, q, cfg),
    [{title:'🔒 Hold this room', value:'hold this room'}, {title:'📅 Change dates', value:'change dates'}, {title:'💬 Talk to team', value:'talk to team'}]);
}

function hpAddonSuffix(type){
  return {per_night:' / night', per_guest:' / guest', per_guest_night:' / guest / night'}[type]||'';
}

async function hpBuildQuote(ctx, unit, d, addons){
  const {env, cid, cfg, today, t}=ctx;
  const currency=String(unit.currency||'INR').toUpperCase();
  const nightly=hpNightlyRates(unit, await hpRateOverrides(env, unit.id, d.check_in, d.check_out), d.check_in, d.check_out);
  let loyalty={tier:null, pct:0}, history={stays:0};
  if(cfg.features.loyalty){
    history=await hpGuestHistory(env, cid, t.phone, today);
    loyalty=hpLoyaltyTier(history.stays, cfg.loyalty);
  }
  const ids=new Set(d.addon_ids||[]);
  const quote=hpComputeQuote({nightly, adults:d.adults, children:d.children||0, discountPct:loyalty.pct,
    addons:(addons||[]).filter(a=>ids.has(a.id)), depositPct:cfg.deposit_pct, currency});
  return {quote, nightly, loyalty, history, currency};
}

export function hpQuoteText(unit, d, q, cfg){
  const {quote, nightly, loyalty, currency}=q;
  const L=[];
  if(loyalty.tier) L.push(`🎉 Welcome back! As a *${loyalty.tier}* guest you get ${loyalty.pct}% off the room.\n`);
  L.push(`🧾 *Your quote — ${unit.name}*`);
  L.push(`📅 ${hpFmtRange(d.check_in, d.check_out)}`);
  L.push(`👥 ${d.adults} adult${d.adults===1?'':'s'}${d.children?`, ${d.children} child${d.children===1?'':'ren'}`:''}`);
  const varies=new Set(nightly.map(n=>n.rate)).size>1;
  if(varies && nightly.length<=7){
    L.push(`🛏️ Room: ${hpFmtMoney(quote.room_total, currency)}`);
    nightly.forEach(n=>L.push(`   · ${hpFmtDate(n.date)} — ${hpFmtMoney(n.rate, currency)}`));
  }else{
    L.push(`🛏️ Room: ${hpFmtMoney(quote.room_total, currency)}${nightly.length>1&&!varies?` (${hpFmtMoney(nightly[0].rate, currency)} × ${nightly.length} nights)`:''}`);
  }
  if(quote.discount_amount) L.push(`🎁 ${loyalty.tier} discount (${loyalty.pct}%): −${hpFmtMoney(quote.discount_amount, currency)}`);
  quote.addons.forEach(a=>L.push(`✨ ${a.name}: ${hpFmtMoney(a.amount, currency)}`));
  L.push(`💰 *Total: ${hpFmtMoney(quote.total, currency)}*`);
  L.push('');
  if(quote.deposit>0) L.push(`🔒 Hold it now with a *${hpFmtMoney(quote.deposit, currency)}* deposit (${cfg.deposit_pct}%). The hold lasts ${cfg.hold_minutes} minutes.`);
  else L.push(`🔒 Tap *Hold this room* and we'll keep it for you for ${cfg.hold_minutes} minutes while our team confirms.`);
  return L.join('\n');
}

// Photos first (only the ones this lead hasn't seen for this unit), then any virtual-tour links.
async function hpSendTour(ctx, unit){
  const {env, deps, t, cid, leadId}=ctx;
  try{
    const seen=await env.DB.prepare(`SELECT id FROM hospitality_media_sent WHERE lead_id=? AND unit_id=?`).bind(leadId, Number(unit.id)).first();
    if(!seen && deps.sendUnitPhotos) await deps.sendUnitPhotos(env, t.c, String(cid), t.convId, leadId, unit);
    const {results:tours}=await env.DB.prepare(`SELECT title, url FROM hosp_pro_tours WHERE client_id=? AND active=1 AND (unit_id=? OR (property_id IS NOT NULL AND property_id=?) OR (unit_id IS NULL AND property_id IS NULL)) ORDER BY unit_id IS NULL, id ASC LIMIT 3`)
      .bind(cid, Number(unit.id), unit.property_id==null?-1:Number(unit.property_id)).all();
    if(tours && tours.length){
      const lines=tours.map(x=>`🎥 ${x.title||'Virtual tour'}: ${x.url}`).join('\n');
      await deps.sendText(env, t.c, String(cid), t.convId, `Take a look around *${unit.name}* before you decide 👇\n\n${lines}`);
    }
  }catch(e){ await deps.reportOpsError?.(env, 'hospitalityPro.sendTour', e, {clientId:cid}); }
}

async function hpUpsertRecovery(ctx, unit, d, q){
  const {env, cid, leadId, nowIso, t}=ctx;
  await env.DB.prepare(`INSERT INTO hosp_pro_recovery (client_id, lead_id, conv_id, guest_name, unit_id, check_in, check_out, adults, children, quoted_total, currency, step, last_activity_at, last_sent_at, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,NULL,'active',?,?)
    ON CONFLICT(client_id, lead_id) DO UPDATE SET conv_id=excluded.conv_id, guest_name=excluded.guest_name, unit_id=excluded.unit_id,
      check_in=excluded.check_in, check_out=excluded.check_out, adults=excluded.adults, children=excluded.children,
      quoted_total=excluded.quoted_total, currency=excluded.currency, step=0, last_activity_at=excluded.last_activity_at,
      status=CASE WHEN hosp_pro_recovery.status='stopped' THEN 'stopped' ELSE 'active' END, updated_at=excluded.updated_at`)
    .bind(cid, leadId, String(t.convId||''), String(t.name||'').slice(0,140), Number(unit.id), d.check_in, d.check_out, d.adults||1, d.children||0,
      q.quote.total, q.currency, nowIso, nowIso, nowIso).run();
}

// ── Hold + payment ───────────────────────────────────────────────────────────────────────────────
async function hpCreateHold(ctx, st, units){
  const {env, deps, t, cid, leadId, cfg, nowMs, nowIso}=ctx;
  const d=st.data;
  const unit=units.find(u=>Number(u.id)===Number(d.unit_id));
  const still=unit?await hpAvailableUnits(env, cid, d.check_in, d.check_out, {adults:d.adults||1, children:d.children||0, leadId, units:[unit], nowIso}):[];
  if(!still.length){
    d.unit_id=null; st.step=null;
    return await hpQuoteTurn(ctx, st, true, units);
  }
  const addons=cfg.features.addons?await hpActiveAddons(env, cid):[];
  const q=await hpBuildQuote(ctx, unit, d, addons);
  const expiresAt=new Date(nowMs+cfg.hold_minutes*60000).toISOString();
  await env.DB.prepare(`UPDATE hosp_pro_holds SET status='released', updated_at=? WHERE client_id=? AND lead_id=? AND status='active'`).bind(nowIso, cid, leadId).run();
  const r=await env.DB.prepare(`INSERT INTO hosp_pro_holds (client_id, unit_id, lead_id, conv_id, guest_name, guest_phone, check_in, check_out, nights, adults, children,
      room_total, discount_label, discount_amount, addons_json, addons_total, total_amount, deposit_amount, currency, status, expires_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?)`)
    .bind(cid, Number(unit.id), leadId, String(t.convId||''), String(t.name||'').slice(0,140), String(t.phone||'').slice(0,40), d.check_in, d.check_out,
      q.quote.nights, d.adults||1, d.children||0, q.quote.room_total, q.loyalty.tier?`${q.loyalty.tier} ${q.loyalty.pct}%`:'', q.quote.discount_amount,
      JSON.stringify(q.quote.addons), q.quote.addons_total, q.quote.total, q.quote.deposit, q.currency, expiresAt, nowIso, nowIso).run();
  const holdId=r.meta.last_row_id;

  let payUrl=null;
  if(q.quote.deposit>0 && cfg.payment_mode==='razorpay'){
    const link=await hpRazorpayLink(env, cid, {holdId, amount:q.quote.deposit, currency:q.currency, name:t.name, phone:t.phone,
      description:`${unit.name} · ${d.check_in} → ${d.check_out} (deposit)`, expiresAt});
    if(link?.url){
      payUrl=link.url;
      await env.DB.prepare(`UPDATE hosp_pro_holds SET payment_url=?, payment_link_id=? WHERE id=?`).bind(link.url, link.id||null, holdId).run();
    }
  }
  await env.DB.prepare(`UPDATE hosp_pro_recovery SET status='held', updated_at=? WHERE client_id=? AND lead_id=?`).bind(nowIso, cid, leadId).run();
  await hpClearState(env, cid, leadId);

  const until=hpFmtTime(expiresAt, cfg.tz_offset_min);
  const L=[`🔒 *Done! ${unit.name} is held for you* until *${until}*.`, '', `📅 ${hpFmtRange(d.check_in, d.check_out)}`, `💰 Total: *${hpFmtMoney(q.quote.total, q.currency)}*`];
  if(q.quote.deposit>0){
    L.push('', `💳 Pay the deposit of *${hpFmtMoney(q.quote.deposit, q.currency)}* to confirm:`);
    if(payUrl) L.push(payUrl);
    else if(cfg.payment_instructions) L.push(cfg.payment_instructions);
    else L.push(`Our team will share the payment details here in a moment.`);
    L.push('', `Once paid, reply *PAID* (or send the screenshot) and we'll confirm your booking.`);
  }else{
    L.push('', `Our team will confirm your booking shortly. 🙌`);
  }
  await deps.sendPrivateNote?.(t.c, t.convId, `🔒 Hospitality Pro hold #${holdId}: ${unit.name}, ${d.check_in} → ${d.check_out}, ${d.adults} adults${d.children?` + ${d.children} children`:''}. Total ${hpFmtMoney(q.quote.total, q.currency)}, deposit ${hpFmtMoney(q.quote.deposit, q.currency)}. Expires ${until}.${payUrl?'':(q.quote.deposit>0&&!cfg.payment_instructions?' ⚠️ No payment details configured — please send them to the guest.':'')} Confirm it in Hospitality → ⭐ Pro → Holds.`);
  return await hpSay(ctx, L.join('\n'));
}

async function hpClaimPayment(ctx, hold){
  const {env, deps, t, nowIso}=ctx;
  if(hold.status!=='payment_claimed'){
    await env.DB.prepare(`UPDATE hosp_pro_holds SET status='payment_claimed', payment_ref=COALESCE(payment_ref, ?), updated_at=? WHERE id=?`)
      .bind(ctx.isMedia?String(t.mediaUrl).slice(0,500):null, nowIso, hold.id).run();
    await deps.sendPrivateNote?.(t.c, t.convId, `💳 Guest says the deposit for hold #${hold.id} is paid${ctx.isMedia?' (screenshot above)':''}${hold.status==='expired'?' — note: the hold had already expired':''}. Verify and confirm it in Hospitality → ⭐ Pro → Holds.`);
  }
  return await hpSay(ctx, `🙏 Thank you! We've noted your payment. Our team will verify it and confirm your booking shortly.`);
}

// Razorpay Payment Link for a hold's deposit — same API shape as the Matrimonial module's
// handleMatriCreatePaymentLink. Returns {url, id} or null (caller falls back to manual text).
async function hpRazorpayLink(env, clientId, {holdId, amount, currency, name, phone, description, expiresAt}){
  const s=await hpLoadSettingsRow(env, clientId);
  if(!s?.razorpay_key_id || !s?.razorpay_key_secret) return null;
  try{
    const auth=btoa(`${s.razorpay_key_id}:${s.razorpay_key_secret}`);
    const expireBy=Math.max(Math.floor(Date.parse(expiresAt)/1000), Math.floor(Date.now()/1000)+16*60);
    const r=await fetch('https://api.razorpay.com/v1/payment_links', {
      method:'POST', headers:{'Content-Type':'application/json', Authorization:`Basic ${auth}`},
      body:JSON.stringify({
        amount:Math.round(Number(amount)*100), currency:String(currency||'INR').toUpperCase(),
        description:String(description||'Booking deposit').slice(0,240),
        customer:{name:String(name||phone||'Guest').slice(0,50), contact:String(phone||'')},
        notes:{kind:'hosp_pro_hold', client_id:String(clientId), hold_id:String(holdId)},
        expire_by:expireBy, reminder_enable:false,
      }),
    });
    if(!r.ok) return null;
    const data=await r.json();
    return {url:data.short_url, id:data.id};
  }catch(e){ return null; }
}

// Turns a hold into a real 'confirmed' hospitality_bookings row (re-checking overlap first), then
// tells the guest and starts digital registration. Used by staff ("Confirm" in the Pro → Holds
// tab) and by the Razorpay webhook.
export async function hpConfirmHold(env, deps, clientId, holdId, {paymentRef=null, nowMs=Date.now()}={}){
  const cid=Number(clientId);
  const nowIso=new Date(nowMs).toISOString();
  const hold=await env.DB.prepare(`SELECT * FROM hosp_pro_holds WHERE id=? AND client_id=?`).bind(Number(holdId), cid).first();
  if(!hold) return {error:'Not found', status:404};
  if(hold.status==='converted') return {ok:true, booking_id:hold.booking_id, already:true};
  if(hold.status==='released') return {error:'This hold was released.', status:409};
  const clash=await env.DB.prepare(`SELECT id FROM hospitality_bookings WHERE client_id=? AND unit_id=? AND status IN ('confirmed','checked_in','checked_out') AND check_in<? AND check_out>? LIMIT 1`)
    .bind(cid, Number(hold.unit_id), hold.check_out, hold.check_in).first();
  if(clash){
    await env.DB.prepare(`UPDATE hosp_pro_holds SET status='conflict', payment_ref=COALESCE(?, payment_ref), updated_at=? WHERE id=?`).bind(paymentRef, nowIso, hold.id).run();
    return {error:'This unit is already booked for part of that date range.', status:409};
  }
  let addons=[]; try{ addons=JSON.parse(hold.addons_json||'[]'); }catch(e){}
  const notes=[`Hospitality Pro hold #${hold.id}`,
    addons.length?`Add-ons: ${addons.map(a=>`${a.name} ${a.amount}`).join(', ')}`:'',
    hold.discount_amount?`Loyalty ${hold.discount_label}: -${hold.discount_amount}`:'',
    paymentRef||hold.payment_ref?`Payment: ${paymentRef||hold.payment_ref}`:''].filter(Boolean).join(' · ');
  const nights=Number(hold.nights)||hpNightsBetween(hold.check_in, hold.check_out)||1;
  const r=await env.DB.prepare(`INSERT INTO hospitality_bookings
    (client_id, unit_id, lead_id, guest_name, guest_phone, check_in, check_out, nights, adults, children, rate_per_night, total_amount, deposit_amount, currency, status, notes, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'confirmed',?,?)`)
    .bind(cid, Number(hold.unit_id), hold.lead_id, hold.guest_name, hold.guest_phone, hold.check_in, hold.check_out, nights, hold.adults, hold.children,
      hpRound(hold.room_total/nights, hold.currency), hold.total_amount, hold.deposit_amount, hold.currency, notes.slice(0,1000), nowIso).run();
  const bookingId=r.meta.last_row_id;
  await env.DB.prepare(`UPDATE hosp_pro_holds SET status='converted', booking_id=?, payment_ref=COALESCE(?, payment_ref), updated_at=? WHERE id=?`).bind(bookingId, paymentRef, nowIso, hold.id).run();
  if(hold.lead_id) await env.DB.prepare(`UPDATE hosp_pro_recovery SET status='converted', updated_at=? WHERE client_id=? AND lead_id=?`).bind(nowIso, cid, hold.lead_id).run();

  try{
    const c=await deps.getClientById(env, cid);
    if(c && hold.conv_id){
      const cfg=await hpLoadConfig(env, cid);
      const unit=await env.DB.prepare(`SELECT name FROM hospitality_units WHERE id=?`).bind(Number(hold.unit_id)).first();
      await deps.sendText(env, c, String(cid), hold.conv_id,
        `🎉 *Booking confirmed!*\n\n🏡 ${unit?.name||'Your stay'}\n📅 ${hpFmtRange(hold.check_in, hold.check_out)}\n💰 Total: ${hpFmtMoney(hold.total_amount, hold.currency)}${Number(hold.deposit_amount)?`\n✅ Deposit received: ${hpFmtMoney(hold.deposit_amount, hold.currency)}`:''}\n🆔 Booking ref: #${bookingId}\n\nWe can't wait to host you! 🌴`);
      if(cfg.features.registration && hold.lead_id){
        const reg=await env.DB.prepare(`INSERT INTO hosp_pro_registrations (client_id, booking_id, lead_id, guest_name, guest_phone, status, created_at, updated_at) VALUES (?,?,?,?,?,'pending',?,?)`)
          .bind(cid, bookingId, hold.lead_id, hold.guest_name, hold.guest_phone, nowIso, nowIso).run();
        await hpSaveState(env, cid, hold.lead_id, {flow:'registration', registration_id:reg.meta.last_row_id}, nowMs);
        await deps.sendButtons(env, c, String(cid), hold.conv_id, cfg.registration_message||HP_DEFAULT_REGISTRATION_MESSAGE, [{title:'✅ Done', value:'done'}]);
      }
    }
  }catch(e){ await deps.reportOpsError?.(env, 'hospitalityPro.confirmNotify', e, {clientId:cid, holdId}); }
  return {ok:true, booking_id:bookingId};
}
const HP_DEFAULT_REGISTRATION_MESSAGE=`📋 *Express check-in*\n\nTo skip the paperwork at arrival, please send a clear photo of a government ID for each adult guest (Aadhaar / Passport / Driving Licence). Foreign nationals: passport photo page + visa page please.\n\nTap *Done* when you've sent them all.`;

// ── Digital guest registration ───────────────────────────────────────────────────────────────────
async function hpRegistrationTurn(ctx, st){
  const {env, cid, leadId, nowIso, nowMs, t}=ctx;
  const reg=await env.DB.prepare(`SELECT * FROM hosp_pro_registrations WHERE id=? AND client_id=?`).bind(Number(st.registration_id), cid).first();
  if(!reg){ await hpClearState(env, cid, leadId); return {handled:false}; }
  let docs=[]; try{ docs=JSON.parse(reg.documents_json||'[]'); }catch(e){}
  if(ctx.isMedia){
    docs.push({url:String(t.mediaUrl).slice(0,1000), at:nowIso});
    await env.DB.prepare(`UPDATE hosp_pro_registrations SET documents_json=?, updated_at=? WHERE id=?`).bind(JSON.stringify(docs.slice(0,20)), nowIso, reg.id).run();
    await hpSaveState(env, cid, leadId, st, nowMs);
    return await hpSay(ctx, `✅ Got it — ${docs.length} document${docs.length===1?'':'s'} received. Send the next one, or tap *Done* when finished.`, [{title:'✅ Done', value:'done'}]);
  }
  if(HP_DONE_RE.test(ctx.lower)){
    await env.DB.prepare(`UPDATE hosp_pro_registrations SET status=?, updated_at=? WHERE id=?`).bind(docs.length?'received':'pending', nowIso, reg.id).run();
    await hpClearState(env, cid, leadId);
    return await hpSay(ctx, docs.length
      ?`🙏 Thank you! Your check-in details are saved — see you soon! 🌴`
      :`No problem — you can complete check-in at the front desk on arrival. See you soon! 🌴`);
  }
  // Anything else (a question about the stay…) goes to the normal bot; registration stays open.
  return {handled:false};
}

// ── Group & event enquiries ──────────────────────────────────────────────────────────────────────
const HP_GROUP_TYPES=[
  {title:'💍 Wedding', value:'Wedding', re:/\b(wedding|marriage|reception|engagement)\b/i},
  {title:'🏢 Corporate / Offsite', value:'Corporate / Offsite', re:/\b(corporate|offsite|off-site|conference|seminar|team\s+(?:outing|building)|retreat|mice|delegates)\b/i},
  {title:'👨‍👩‍👧 Family / Friends', value:'Family / Friends', re:/\b(family|friends|reunion|relatives)\b/i},
  {title:'🎓 College / School tour', value:'College / School tour', re:/\b(college|school|study\s+tour|students?)\b/i},
  {title:'🎉 Other event', value:'Other event', re:/\b(event|party|birthday|anniversary|function|banquet)\b/i},
];
async function hpGroupTurn(ctx, st, isStart){
  const {env, deps, t, cid, leadId, today, nowMs, nowIso}=ctx;
  const d=st.data||(st.data={});
  const text=ctx.text, lower=ctx.lower;
  let consumed=false;
  if(!d.event_type){
    const ty=HP_GROUP_TYPES.find(g=>g.re.test(text) || lower===g.value.toLowerCase() || lower===g.title.toLowerCase());
    if(ty){ d.event_type=ty.value; consumed=true; }
  }
  if(!d.group_size || st.step==='size'){
    const g=hpParseGuests(text, {bare:st.step==='size'});
    const groupOf=lower.match(/\bgroup of\s*(\d{1,4})\b/);
    const n=g?g.adults+g.children:(groupOf?Number(groupOf[1]):(st.step==='size'?Number((lower.match(/\b(\d{1,4})\b/)||[])[1])||0:0));
    if(n>0){ d.group_size=n; consumed=true; }
  }
  if(!d.check_in && st.step!=='needs'){
    const dr=hpParseDateRange(text, today);
    if(dr?.check_in){ d.check_in=dr.check_in; d.check_out=dr.check_out||null; consumed=true; }
    else if(st.step==='dates' && /\b(not\s+(?:sure|fixed|decided)|flexible|tbd|later|skip|don'?t\s+know)\b/i.test(lower)){ d.check_in='flexible'; consumed=true; }
  }
  if(st.step==='needs'){ d.requirements=/^\s*(skip|no|none|nothing|no\s+thanks)\s*$/i.test(lower)?'':text.slice(0,1000); d.needs_done=true; consumed=true; }
  if(!isStart && !consumed){
    st.misses=(st.misses||0)+1;
    if(st.misses>=2) await hpClearState(env, cid, leadId); else await hpSaveState(env, cid, leadId, st, nowMs);
    return {handled:false};
  }
  st.misses=0;
  if(!d.event_type){
    st.step='type'; await hpSaveState(env, cid, leadId, st, nowMs);
    return await hpSay(ctx, `We'd love to host your group! 🎉 What's the occasion?`, HP_GROUP_TYPES.map(g=>({title:g.title, value:g.value})));
  }
  if(!d.group_size){
    st.step='size'; await hpSaveState(env, cid, leadId, st, nowMs);
    return await hpSay(ctx, `👥 Roughly how many guests? (e.g. *40*)`);
  }
  if(!d.check_in){
    st.step='dates'; await hpSaveState(env, cid, leadId, st, nowMs);
    return await hpSay(ctx, `📅 Which dates are you considering? (e.g. *12 to 14 Dec*)`, [{title:'Dates not fixed yet', value:'flexible'}]);
  }
  if(!d.needs_done){
    st.step='needs'; await hpSaveState(env, cid, leadId, st, nowMs);
    return await hpSay(ctx, `📝 Anything we should plan for? (rooms needed, food, hall / venue, decoration, transport…)`, [{title:'Skip', value:'skip'}]);
  }
  const flexible=d.check_in==='flexible';
  const r=await env.DB.prepare(`INSERT INTO hosp_pro_groups (client_id, lead_id, conv_id, guest_name, guest_phone, event_type, group_size, check_in, check_out, requirements, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,'new',?,?)`)
    .bind(cid, leadId, String(t.convId||''), String(t.name||'').slice(0,140), String(t.phone||'').slice(0,40), d.event_type, Number(d.group_size)||0,
      flexible?null:d.check_in, flexible?null:(d.check_out||null), d.requirements||'', nowIso, nowIso).run();
  await hpClearState(env, cid, leadId);
  const when=flexible?'dates flexible':(d.check_out?hpFmtRange(d.check_in, d.check_out):hpFmtDate(d.check_in));
  await deps.sendPrivateNote?.(t.c, t.convId, `🎉 Hospitality Pro group enquiry #${r.meta.last_row_id}: ${d.event_type}, ~${d.group_size} guests, ${when}.${d.requirements?` Needs: ${d.requirements}`:''} Follow up in Hospitality → ⭐ Pro → Groups.`);
  return await hpSay(ctx, `Thank you! 🙌 Here's what we noted:\n\n🎉 ${d.event_type}\n👥 ~${d.group_size} guests\n📅 ${when}${d.requirements?`\n📝 ${d.requirements}`:''}\n\nOur events team will prepare a custom proposal and get back to you shortly.`);
}

// ── Cron: hold expiry + abandoned-inquiry recovery (worker.js "*/15 * * * *" tick) ──────────────
export async function hpRunForAllClients(env, deps, nowMs=Date.now()){
  let rows=[];
  try{
    const r=await env.DB.prepare(`SELECT DISTINCT client_id FROM hosp_pro_holds WHERE status='active' OR (status='expired' AND expiry_notified=0 AND expires_at>?)
      UNION SELECT DISTINCT client_id FROM hosp_pro_recovery WHERE status='active'`).bind(new Date(nowMs-20*3600e3).toISOString()).all();
    rows=r.results||[];
  }catch(e){
    if(!/no such table/i.test(String(e?.message))) console.error('[hospitality-pro] sweep query failed', e?.message);
    return;
  }
  for(const row of rows){
    try{ await hpRunForClient(env, deps, row.client_id, nowMs); }
    catch(e){ console.error('[hospitality-pro] sweep failed for client', row.client_id, e?.message); }
  }
}

export async function hpRunForClient(env, deps, clientId, nowMs=Date.now()){
  const cid=Number(clientId);
  const nowIso=new Date(nowMs).toISOString();
  await env.DB.prepare(`UPDATE hosp_pro_holds SET status='expired', updated_at=? WHERE client_id=? AND status='active' AND expires_at<=?`).bind(nowIso, cid, nowIso).run();
  const c=await deps.getClientById(env, cid);
  if(!hpEnabled(c)) return;
  const cfg=await hpLoadConfig(env, cid);
  if(!cfg.features.recovery || hpIsQuietHour(nowMs, cfg)) return;
  const today=hpLocalToday(nowMs, cfg.tz_offset_min);
  const {results:units}=await env.DB.prepare(`SELECT * FROM hospitality_units WHERE client_id=? AND active=1`).bind(cid).all();
  const unitById=new Map((units||[]).map(u=>[Number(u.id), u]));

  // 1. Expired holds — one "want me to hold it again?" message each.
  const {results:expired}=await env.DB.prepare(`SELECT * FROM hosp_pro_holds WHERE client_id=? AND status='expired' AND expiry_notified=0 AND expires_at>? ORDER BY id ASC LIMIT 25`)
    .bind(cid, new Date(nowMs-20*3600e3).toISOString()).all();
  for(const h of (expired||[])){
    const claim=await env.DB.prepare(`UPDATE hosp_pro_holds SET expiry_notified=1 WHERE id=? AND expiry_notified=0`).bind(h.id).run();
    if(!claim.meta.changes || !h.conv_id || !h.lead_id) continue;
    const unit=unitById.get(Number(h.unit_id));
    if(!unit || h.check_in<today) continue;
    if(!await hpLeadReachable(env, deps, h.lead_id)) continue;
    const newer=await env.DB.prepare(`SELECT id FROM hosp_pro_holds WHERE client_id=? AND lead_id=? AND id>? LIMIT 1`).bind(cid, h.lead_id, h.id).first();
    if(newer) continue;
    let addons=[]; try{ addons=JSON.parse(h.addons_json||'[]'); }catch(e){}
    await hpSaveState(env, cid, h.lead_id, {flow:'quote', step:'confirm', data:{check_in:h.check_in, check_out:h.check_out, adults:h.adults, children:h.children,
      unit_id:Number(h.unit_id), addon_ids:addons.map(a=>a.id), addons_done:true, toured:true}}, nowMs);
    const avail=await hpAvailableUnits(env, cid, h.check_in, h.check_out, {adults:h.adults, children:h.children, leadId:h.lead_id, units:[unit], nowIso});
    const first=hpFirstName(h.guest_name);
    const msg=avail.length
      ?`⏰ Hi${first?` ${first}`:''}! Your hold on *${unit.name}* for ${hpFmtRange(h.check_in, h.check_out)} has expired — but it's still available right now. Want me to hold it again?`
      :`⏰ Hi${first?` ${first}`:''}! Your hold on *${unit.name}* expired and it has since been booked 😔 Shall I check other rooms or dates for you?`;
    await deps.sendButtons(env, c, String(cid), h.conv_id, msg, avail.length
      ?[{title:'🔒 Hold again', value:'hold this room'}, {title:'📅 Change dates', value:'change dates'}]
      :[{title:'📅 Change dates', value:'change dates'}, {title:'💬 Talk to team', value:'talk to team'}]);
    await env.DB.prepare(`UPDATE hosp_pro_recovery SET status='done', updated_at=? WHERE client_id=? AND lead_id=? AND status='held'`).bind(nowIso, cid, h.lead_id).run();
  }

  // 2. Quotes nobody held — nudge after recovery_hours[step] idle hours, inside the 24h window.
  const hours=cfg.recovery_hours;
  const {results:rec}=await env.DB.prepare(`SELECT * FROM hosp_pro_recovery WHERE client_id=? AND status='active' ORDER BY id ASC LIMIT 50`).bind(cid).all();
  for(const row of (rec||[])){
    const idle=nowMs-Date.parse(row.last_activity_at);
    const finish=async(status)=>env.DB.prepare(`UPDATE hosp_pro_recovery SET status=?, updated_at=? WHERE id=?`).bind(status, nowIso, row.id).run();
    if(!row.check_in || row.check_in<today || idle>=23*3600e3 || row.step>=hours.length){ await finish('done'); continue; }
    if(idle<hours[row.step]*3600e3) continue;
    const unit=unitById.get(Number(row.unit_id));
    if(!unit || !row.conv_id){ await finish('done'); continue; }
    const lead=await deps.getLead(env, row.lead_id).catch(()=>null);
    if(lead?.OptOut==='Yes'){ await finish('stopped'); continue; }
    if(lead && (deps.isTakeover?.(lead) || lead.Stage==='human_handover')){ await finish('stopped'); continue; }
    const hold=await env.DB.prepare(`SELECT id FROM hosp_pro_holds WHERE client_id=? AND lead_id=? AND status IN ('active','payment_claimed','converted') AND created_at>=? LIMIT 1`).bind(cid, row.lead_id, row.created_at).first();
    if(hold){ await finish('held'); continue; }
    const claim=await env.DB.prepare(`UPDATE hosp_pro_recovery SET step=step+1, last_sent_at=?, updated_at=? WHERE id=? AND step=?`).bind(nowIso, nowIso, row.id, row.step).run();
    if(!claim.meta.changes) continue;
    const all=await hpAvailableUnits(env, cid, row.check_in, row.check_out, {adults:row.adults, children:row.children, leadId:row.lead_id, units:units||[], nowIso});
    const stillFree=all.some(u=>Number(u.id)===Number(unit.id));
    const first=hpFirstName(row.guest_name);
    const range=hpFmtRange(row.check_in, row.check_out);
    let msg, buttons;
    if(stillFree){
      const scarcity=all.length<=2?` Only ${all.length} ${all.length===1?'stay is':'stays are'} left for these dates.`:'';
      msg=row.step===0
        ?`Hi${first?` ${first}`:''}! 👋 Just checking in — *${unit.name}* is still available for ${range}.${scarcity} Shall I hold it for you? 🔒`
        :`Hi${first?` ${first}`:''}, still thinking about your getaway? 🌴 *${unit.name}* is open for ${range} right now.${scarcity} Tap below and I'll hold it for you.`;
      buttons=[{title:'🔒 Hold this room', value:'hold this room'}, {title:'📅 Change dates', value:'change dates'}];
    }else{
      msg=`Hi${first?` ${first}`:''}! *${unit.name}* has just been booked for ${range} 😔 ${all.length?`But ${all.length} other ${all.length===1?'option is':'options are'} still free — want to see ${all.length===1?'it':'them'}?`:'Shall I check other dates for you?'}`;
      buttons=all.length?[{title:'👀 Show options', value:'show options'}, {title:'📅 Change dates', value:'change dates'}]:[{title:'📅 Change dates', value:'change dates'}, {title:'💬 Talk to team', value:'talk to team'}];
    }
    const prev=await hpGetState(env, cid, row.lead_id, nowMs);
    const data={...(prev?.flow==='quote'?prev.data:{}), check_in:row.check_in, check_out:row.check_out, adults:row.adults, children:row.children,
      unit_id:stillFree?Number(unit.id):null, toured:true};
    if(stillFree && data.addons_done===undefined) data.addons_done=true;
    await hpSaveState(env, cid, row.lead_id, {flow:'quote', step:stillFree?'confirm':'unit', data}, nowMs);
    await deps.sendButtons(env, c, String(cid), row.conv_id, msg, buttons);
    if(row.step+1>=hours.length) await finish('done');
  }
}
async function hpLeadReachable(env, deps, leadId){
  const lead=await deps.getLead(env, leadId).catch(()=>null);
  if(!lead) return true;
  if(lead.OptOut==='Yes') return false;
  if(deps.isTakeover?.(lead) || lead.Stage==='human_handover') return false;
  return true;
}

// ── Dashboard API (/hospitality/pro/*) ───────────────────────────────────────────────────────────
export async function hpHandleRoute(request, env, deps, url){
  const path=url.pathname, method=request.method;
  const {json}=deps;
  if(path==='/hospitality/pro/razorpay/webhook' && method==='POST') return await hpRazorpayWebhook(request, env, deps);
  const payload=await deps.requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const cid=Number(payload.cid);
  const c=await deps.getClientById(env, cid);
  if(!hpEnabled(c)) return json({error:'Hospitality Pro is not enabled for this account.'}, 403);
  const body=['POST','PATCH','DELETE'].includes(method)?await request.json().catch(()=>({})):{};
  const nowIso=new Date().toISOString();

  if(path==='/hospitality/pro/settings' && method==='GET'){
    const row=await hpLoadSettingsRow(env, cid);
    return json({config:hpNormalizeConfig(row?.config_json||'{}'), razorpay_connected:!!(row?.razorpay_key_id && row?.razorpay_key_secret),
      razorpay_webhook_ready:!!row?.razorpay_webhook_secret, razorpay_key_id:row?.razorpay_key_id||''});
  }
  if(path==='/hospitality/pro/settings' && method==='PATCH'){
    const row=await hpLoadSettingsRow(env, cid);
    const merged={...hpNormalizeConfig(row?.config_json||'{}'), ...(body.config&&typeof body.config==='object'?body.config:{})};
    const cfg=hpNormalizeConfig(merged);
    const keyId=body.razorpay_key_id!==undefined?String(body.razorpay_key_id||'').trim().slice(0,100):(row?.razorpay_key_id||null);
    const keySecret=body.razorpay_key_secret?String(body.razorpay_key_secret).trim().slice(0,200):(body.razorpay_key_id===''?null:(row?.razorpay_key_secret||null));
    const hookSecret=body.razorpay_webhook_secret?String(body.razorpay_webhook_secret).trim().slice(0,200):(body.razorpay_key_id===''?null:(row?.razorpay_webhook_secret||null));
    await env.DB.prepare(`INSERT INTO hosp_pro_settings (client_id, config_json, razorpay_key_id, razorpay_key_secret, razorpay_webhook_secret, updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(client_id) DO UPDATE SET config_json=excluded.config_json, razorpay_key_id=excluded.razorpay_key_id, razorpay_key_secret=excluded.razorpay_key_secret,
        razorpay_webhook_secret=excluded.razorpay_webhook_secret, updated_at=excluded.updated_at`)
      .bind(cid, JSON.stringify(cfg), keyId||null, keySecret, hookSecret, nowIso).run();
    return json({ok:true, config:cfg, razorpay_connected:!!(keyId && keySecret), razorpay_webhook_ready:!!hookSecret});
  }

  if(path==='/hospitality/pro/overview' && method==='GET') return json(await hpOverview(env, cid));

  if(path==='/hospitality/pro/addons'){
    if(method==='GET'){
      const {results}=await env.DB.prepare(`SELECT * FROM hosp_pro_addons WHERE client_id=? ORDER BY sort_order ASC, id ASC`).bind(cid).all();
      return json({list:results||[]});
    }
    if(method==='POST'){
      if(!String(body.name||'').trim()) return json({error:'name required'}, 400);
      const r=await env.DB.prepare(`INSERT INTO hosp_pro_addons (client_id, name, description, price, price_type, currency, active, sort_order, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .bind(cid, String(body.name).trim().slice(0,80), String(body.description||'').trim().slice(0,200), Math.max(0, Number(body.price)||0),
          HP_ADDON_PRICE_TYPES.includes(body.price_type)?body.price_type:'per_booking', String(body.currency||'INR').trim().slice(0,10).toUpperCase(),
          body.active===false?0:1, Number(body.sort_order)||0, nowIso).run();
      return json({ok:true, id:r.meta.last_row_id});
    }
    if(method==='PATCH' || method==='DELETE'){
      const row=await env.DB.prepare(`SELECT id FROM hosp_pro_addons WHERE id=? AND client_id=?`).bind(Number(body.id), cid).first();
      if(!row) return json({error:'Not found'}, 404);
      if(method==='DELETE'){ await env.DB.prepare(`DELETE FROM hosp_pro_addons WHERE id=?`).bind(row.id).run(); return json({ok:true}); }
      const sets=[], vals=[];
      if(body.name!==undefined){ if(!String(body.name).trim()) return json({error:'name required'}, 400); sets.push('name=?'); vals.push(String(body.name).trim().slice(0,80)); }
      if(body.description!==undefined){ sets.push('description=?'); vals.push(String(body.description).trim().slice(0,200)); }
      if(body.price!==undefined){ sets.push('price=?'); vals.push(Math.max(0, Number(body.price)||0)); }
      if(body.price_type!==undefined){ sets.push('price_type=?'); vals.push(HP_ADDON_PRICE_TYPES.includes(body.price_type)?body.price_type:'per_booking'); }
      if(body.currency!==undefined){ sets.push('currency=?'); vals.push(String(body.currency).trim().slice(0,10).toUpperCase()); }
      if(body.active!==undefined){ sets.push('active=?'); vals.push(body.active?1:0); }
      if(body.sort_order!==undefined){ sets.push('sort_order=?'); vals.push(Number(body.sort_order)||0); }
      if(sets.length) await env.DB.prepare(`UPDATE hosp_pro_addons SET ${sets.join(', ')} WHERE id=?`).bind(...vals, row.id).run();
      return json({ok:true});
    }
  }

  if(path==='/hospitality/pro/tours'){
    if(method==='GET'){
      const {results}=await env.DB.prepare(`SELECT * FROM hosp_pro_tours WHERE client_id=? ORDER BY id ASC`).bind(cid).all();
      return json({list:results||[]});
    }
    if(method==='POST'){
      const link=String(body.url||'').trim();
      if(!/^https?:\/\/\S+$/i.test(link)) return json({error:'A valid http(s) link is required'}, 400);
      const unitId=body.unit_id?Number(body.unit_id):null, propId=body.property_id?Number(body.property_id):null;
      if(unitId && !await env.DB.prepare(`SELECT id FROM hospitality_units WHERE id=? AND client_id=?`).bind(unitId, cid).first()) return json({error:'Unit not found'}, 404);
      if(propId && !await env.DB.prepare(`SELECT id FROM hospitality_properties WHERE id=? AND client_id=?`).bind(propId, cid).first()) return json({error:'Property not found'}, 404);
      const r=await env.DB.prepare(`INSERT INTO hosp_pro_tours (client_id, unit_id, property_id, title, url, active, created_at) VALUES (?,?,?,?,?,1,?)`)
        .bind(cid, unitId, propId, String(body.title||'').trim().slice(0,80), link.slice(0,500), nowIso).run();
      return json({ok:true, id:r.meta.last_row_id});
    }
    if(method==='DELETE'){
      await env.DB.prepare(`DELETE FROM hosp_pro_tours WHERE id=? AND client_id=?`).bind(Number(body.id), cid).run();
      return json({ok:true});
    }
  }

  if(path==='/hospitality/pro/holds' && method==='GET'){
    const {results}=await env.DB.prepare(`SELECT h.*, u.name AS unit_name FROM hosp_pro_holds h LEFT JOIN hospitality_units u ON u.id=h.unit_id WHERE h.client_id=? ORDER BY h.id DESC LIMIT 300`).bind(cid).all();
    return json({list:results||[]});
  }
  if(path==='/hospitality/pro/holds/confirm' && method==='POST'){
    const r=await hpConfirmHold(env, deps, cid, body.id, {paymentRef:body.payment_ref?String(body.payment_ref).trim().slice(0,200):null});
    return json(r, r.status||200);
  }
  if(path==='/hospitality/pro/holds/release' && method==='POST'){
    const r=await env.DB.prepare(`UPDATE hosp_pro_holds SET status='released', updated_at=? WHERE id=? AND client_id=? AND status IN ('active','payment_claimed','expired','conflict')`).bind(nowIso, Number(body.id), cid).run();
    return r.meta.changes?json({ok:true}):json({error:'Hold not found or already closed'}, 404);
  }

  if(path==='/hospitality/pro/guests' && method==='GET'){
    const cfg=await hpLoadConfig(env, cid);
    return json({list:await hpGuestList(env, cid, hpLocalToday(Date.now(), cfg.tz_offset_min), cfg)});
  }

  if(path==='/hospitality/pro/registrations'){
    if(method==='GET'){
      const {results}=await env.DB.prepare(`SELECT r.*, b.check_in, b.check_out, u.name AS unit_name FROM hosp_pro_registrations r LEFT JOIN hospitality_bookings b ON b.id=r.booking_id LEFT JOIN hospitality_units u ON u.id=b.unit_id WHERE r.client_id=? ORDER BY r.id DESC LIMIT 300`).bind(cid).all();
      return json({list:results||[]});
    }
    if(method==='PATCH'){
      if(!['pending','received','verified'].includes(body.status)) return json({error:'invalid status'}, 400);
      const r=await env.DB.prepare(`UPDATE hosp_pro_registrations SET status=?, notes=COALESCE(?, notes), updated_at=? WHERE id=? AND client_id=?`)
        .bind(body.status, body.notes!==undefined?String(body.notes).slice(0,500):null, nowIso, Number(body.id), cid).run();
      return r.meta.changes?json({ok:true}):json({error:'Not found'}, 404);
    }
  }

  if(path==='/hospitality/pro/groups'){
    if(method==='GET'){
      const {results}=await env.DB.prepare(`SELECT * FROM hosp_pro_groups WHERE client_id=? ORDER BY id DESC LIMIT 300`).bind(cid).all();
      return json({list:results||[]});
    }
    if(method==='PATCH'){
      if(body.status!==undefined && !['new','quoted','won','lost'].includes(body.status)) return json({error:'invalid status'}, 400);
      const r=await env.DB.prepare(`UPDATE hosp_pro_groups SET status=COALESCE(?, status), notes=COALESCE(?, notes), updated_at=? WHERE id=? AND client_id=?`)
        .bind(body.status??null, body.notes!==undefined?String(body.notes).slice(0,1000):null, nowIso, Number(body.id), cid).run();
      return r.meta.changes?json({ok:true}):json({error:'Not found'}, 404);
    }
  }

  if(path==='/hospitality/pro/recovery' && method==='GET'){
    const {results}=await env.DB.prepare(`SELECT r.*, u.name AS unit_name FROM hosp_pro_recovery r LEFT JOIN hospitality_units u ON u.id=r.unit_id WHERE r.client_id=? ORDER BY r.updated_at DESC LIMIT 300`).bind(cid).all();
    return json({list:results||[]});
  }
  return json({error:'Not found'}, 404);
}

async function hpGuestList(env, clientId, today, cfg){
  const {results}=await env.DB.prepare(`SELECT guest_name, guest_phone, unit_id, total_amount, check_in, check_out, status FROM hospitality_bookings WHERE client_id=? AND status IN ('confirmed','checked_in','checked_out') ORDER BY check_in ASC LIMIT 5000`).bind(Number(clientId)).all();
  const map=new Map();
  for(const b of (results||[])){
    const key=hpPhoneKey(b.guest_phone);
    if(key.length<6) continue;
    const g=map.get(key)||{phone:b.guest_phone, name:'', stays:0, upcoming:0, spent:0, last_stay:null, next_stay:null};
    if(b.guest_name) g.name=b.guest_name;
    if(b.status==='checked_out' || b.check_out<=today){ g.stays++; g.spent+=Number(b.total_amount)||0; if(!g.last_stay || b.check_out>g.last_stay) g.last_stay=b.check_out; }
    else{ g.upcoming++; if(!g.next_stay || b.check_in<g.next_stay) g.next_stay=b.check_in; }
    map.set(key, g);
  }
  return [...map.values()].map(g=>({...g, spent:Math.round(g.spent), ...hpLoyaltyTier(g.stays, cfg.loyalty)}))
    .sort((a,b)=>b.stays-a.stays || b.spent-a.spent).slice(0, 500);
}

async function hpOverview(env, cid){
  const since=new Date(Date.now()-30*86400e3).toISOString();
  const one=async(sql, ...b)=>(await env.DB.prepare(sql).bind(...b).first())||{};
  const [holds, conv, rec, groups, regs]=await Promise.all([
    one(`SELECT SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) active, SUM(CASE WHEN status='payment_claimed' THEN 1 ELSE 0 END) awaiting, SUM(CASE WHEN status='conflict' THEN 1 ELSE 0 END) conflicts FROM hosp_pro_holds WHERE client_id=?`, cid),
    one(`SELECT COUNT(*) n, SUM(total_amount) revenue, SUM(addons_total) addons, SUM(discount_amount) loyalty FROM hosp_pro_holds WHERE client_id=? AND status='converted' AND updated_at>=?`, cid, since),
    one(`SELECT SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) active, SUM(CASE WHEN step>0 AND status IN ('held','converted') THEN 1 ELSE 0 END) recovered, SUM(CASE WHEN step>0 THEN 1 ELSE 0 END) nudged FROM hosp_pro_recovery WHERE client_id=? AND updated_at>=?`, cid, since),
    one(`SELECT SUM(CASE WHEN status='new' THEN 1 ELSE 0 END) open, COUNT(*) total FROM hosp_pro_groups WHERE client_id=? AND created_at>=?`, cid, since),
    one(`SELECT SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending, SUM(CASE WHEN status='received' THEN 1 ELSE 0 END) received FROM hosp_pro_registrations WHERE client_id=?`, cid),
  ]);
  const n=v=>Number(v)||0;
  return {
    holds_active:n(holds.active), holds_awaiting:n(holds.awaiting), holds_conflict:n(holds.conflicts),
    bookings_30d:n(conv.n), revenue_30d:Math.round(n(conv.revenue)), addons_30d:Math.round(n(conv.addons)), loyalty_given_30d:Math.round(n(conv.loyalty)),
    recovery_active:n(rec.active), recovery_nudged_30d:n(rec.nudged), recovery_recovered_30d:n(rec.recovered),
    groups_open:n(groups.open), groups_30d:n(groups.total),
    registrations_pending:n(regs.pending), registrations_received:n(regs.received),
  };
}

async function hpRazorpayWebhook(request, env, deps){
  const raw=await request.text();
  const sig=request.headers.get('X-Razorpay-Signature')||'';
  let evt; try{ evt=JSON.parse(raw); }catch(e){ return new Response('bad json', {status:400}); }
  const notes={...(evt?.payload?.payment?.entity?.notes||{}), ...(evt?.payload?.payment_link?.entity?.notes||{})};
  if(notes.kind!=='hosp_pro_hold' || !notes.client_id || !notes.hold_id) return new Response('ignored', {status:200});
  const s=await hpLoadSettingsRow(env, notes.client_id).catch(()=>null);
  if(!s?.razorpay_webhook_secret) return new Response('webhook secret not configured', {status:400});
  const enc=new TextEncoder();
  const key=await crypto.subtle.importKey('raw', enc.encode(s.razorpay_webhook_secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const mac=new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(raw)));
  const expected=Array.from(mac).map(b=>b.toString(16).padStart(2,'0')).join('');
  let diff=expected.length^sig.length;
  for(let i=0;i<expected.length;i++) diff|=expected.charCodeAt(i)^(sig.charCodeAt(i)||0);
  if(diff!==0) return new Response('invalid signature', {status:400});
  if(evt.event!=='payment_link.paid') return new Response('ok', {status:200});
  const paymentId=evt?.payload?.payment?.entity?.id||evt?.payload?.payment_link?.entity?.id||'razorpay';
  const r=await hpConfirmHold(env, deps, notes.client_id, notes.hold_id, {paymentRef:`razorpay:${paymentId}`});
  if(r.error){
    try{
      const hold=await env.DB.prepare(`SELECT conv_id FROM hosp_pro_holds WHERE id=?`).bind(Number(notes.hold_id)).first();
      const c=await deps.getClientById(env, notes.client_id);
      if(c && hold?.conv_id) await deps.sendPrivateNote?.(c, hold.conv_id, `⚠️ Razorpay deposit ${paymentId} was paid for hold #${notes.hold_id}, but it couldn't be auto-confirmed: ${r.error} Please sort this out with the guest.`);
    }catch(e){}
  }
  return new Response('ok', {status:200});
}
