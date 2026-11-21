/* ═══════════════════════════════════════════════════════════════════════════
   LIVE TRAVEL — WHATSAPP MENU & GUIDED FLIGHT BOOKING
   Each travel agency sets its own WhatsApp menu (Live Agency → 💬 WhatsApp Menu):
   Flights, Visa, Packages, Umrah, Hotels, My Bookings, Talk to Agent … in its own
   order, wording and sections. "hi" / "menu" sends it as a WhatsApp list message.

   A menu row does one of:
     flight_search  live flights from the connected API (POOMAS), as buttons:
                    route → date → passengers → live fares → pick →
                    flight details → Proceed → booking form → booking-site link.
                    Shown only while the live API is connected.
     portal         lists what the agency has listed in its Travel Portal (the
                    Travel Agency module): packages, Umrah groups, visas, rental cars,
                    attestation, group fares, special fares. Tap → details → Enquire.
                    Shown only while that portal section has live listings.
     ask / link     an option the agency adds itself: its own question, or a button
                    to its own page
     handover       hands the chat to a team member
     my_bookings    the customer's Live Agency bookings, looked up by phone

   Everything here is pure (no I/O) so it can be unit-tested; the D1 storage and the
   WhatsApp sends live in worker.js.
   ═══════════════════════════════════════════════════════════════════════════ */

import {taPackageRegion,taPackageListRows,TA_PKG_REGIONS} from './travel-itinerary.js';

export const LT_MENU_ACTIONS=['flight_search','portal','ask','link','handover','my_bookings'];
// Travel Portal sections a menu row can list (Travel Agency module tables; attestation is D1).
export const LT_PORTAL_SOURCES={
  packages:{label:'Holiday Packages',noun:'package',emoji:'🏝️',category:'Package'},
  umrah:{label:'Umrah Groups',noun:'Umrah group',emoji:'🕋',category:'Umrah and Hajj'},
  visas:{label:'Visa Services',noun:'visa',emoji:'🛂',category:'Visa'},
  cars:{label:'Car Rental',noun:'car',emoji:'🚗',category:'Other Services'},
  attestation:{label:'Attestation',noun:'attestation service',emoji:'📄',category:'Certificate Attestation'},
  group_fares:{label:'Group Fares',noun:'group fare',emoji:'👥',category:'Group Ticket'},
  special_fares:{label:'Special Fares',noun:'special fare',emoji:'🔥',category:'Ticket'},
};
export const LT_PORTAL_PREFIX='TPORTAL:';
export const LT_ENQUIRE_PREFIX='TENQUIRE:';
// WhatsApp list messages carry at most 10 rows; row titles 24 chars, descriptions 72,
// section titles 24, the list button 20.
export const LT_MENU_MAX_ROWS=10;
export const LT_MENU_VALUE_PREFIX='TMENU:';

export function ltMenuDefaults(){
  return {
    enabled:false,
    greeting:'',
    button_label:'Menu',
    popular_routes:[],
    items:[
      {id:'flights',emoji:'✈️',title:'Live Flights',description:'Live fares — search and book in chat',section:'Book',action:'flight_search',category:'Air Ticket'},
      {id:'packages',emoji:'🏝️',title:'Holiday Packages',description:'Our tour packages',section:'Book',action:'portal',source:'packages',category:'Package'},
      {id:'umrah',emoji:'🕋',title:'Umrah Groups',description:'Upcoming Umrah departures',section:'Book',action:'portal',source:'umrah',category:'Umrah and Hajj'},
      {id:'group_fares',emoji:'👥',title:'Group Fares',description:'Seats on our group fares',section:'Book',action:'portal',source:'group_fares',category:'Group Ticket'},
      {id:'special_fares',emoji:'🔥',title:'Special Fares',description:'Limited-time fare offers',section:'Book',action:'portal',source:'special_fares',category:'Ticket'},
      {id:'cars',emoji:'🚗',title:'Car Rental',description:'Cars available for rent',section:'Book',action:'portal',source:'cars',category:'Other Services'},
      {id:'visas',emoji:'🛂',title:'Visa Services',description:'Visas we process',section:'Documents',action:'portal',source:'visas',category:'Visa'},
      {id:'attestation',emoji:'📄',title:'Attestation',description:'Certificate attestation',section:'Documents',action:'portal',source:'attestation',category:'Certificate Attestation'},
      {id:'bookings',emoji:'🎫',title:'My Bookings',description:'Booking status, PNR and tickets',section:'My Trip',action:'my_bookings',category:''},
      {id:'agent',emoji:'👤',title:'Talk to an Agent',description:'Chat with our travel team',section:'Help',action:'handover',category:''},
    ],
  };
}

const clip=(v,n)=>String(v??'').replace(/\s+/g,' ').trim().slice(0,n);
const clipText=(v,n)=>String(v??'').replace(/\r/g,'').trim().slice(0,n);
const slug=v=>String(v||'').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'').slice(0,24);
const code=v=>String(v||'').trim().toUpperCase().match(/^[A-Z]{3}$/)?.[0]||'';

// Any stored or posted menu → the exact shape the bot and the editor use.
export function ltMenuNormalize(raw){
  const d=ltMenuDefaults();
  if(!raw||typeof raw!=='object')return d;
  const seen=new Set();
  const items=(Array.isArray(raw.items)?raw.items:d.items).slice(0,30).map((it,i)=>{
    let id=slug(it?.id)||slug(it?.title)||`item_${i+1}`;
    while(seen.has(id))id=`${id.slice(0,20)}_${i+1}`;
    seen.add(id);
    const action=LT_MENU_ACTIONS.includes(it?.action)?it.action:'ask';
    const url=String(it?.url||'').trim();
    const source=action==='portal'?(LT_PORTAL_SOURCES[it?.source]?it.source:LT_PORTAL_SOURCES[id]?id:'packages'):'';
    return {
      id,emoji:clip(it?.emoji,8),title:clip(it?.title,24)||`Option ${i+1}`,description:clip(it?.description,72),
      section:clip(it?.section,24)||'Services',action,source,category:clip(it?.category,60),
      message:clipText(it?.message,900),url:/^https:\/\/[^\s]+$/i.test(url)?url.slice(0,500):'',button_text:clip(it?.button_text,20),
      enabled:it?.enabled!==false,
    };
  });
  const routes=(Array.isArray(raw.popular_routes)?raw.popular_routes:[]).map(r=>Array.isArray(r)?[code(r[0]),code(r[1])]:String(r||'').toUpperCase().match(/[A-Z]{3}/g)||[])
    .filter(r=>r.length===2&&r[0]&&r[1]&&r[0]!==r[1]).slice(0,8).map(r=>[r[0],r[1]]);
  return {
    enabled:raw.enabled===true||raw.enabled===1||raw.enabled==='1',
    greeting:clipText(raw.greeting,900),
    button_label:clip(raw.button_label,20)||'Menu',
    popular_routes:routes,
    items,
  };
}

// Problems that would make WhatsApp reject the list, or a row that cannot work.
export function ltMenuValidate(menu){
  const errors=[],on=menu.items.filter(i=>i.enabled);
  if(menu.enabled&&!on.length)errors.push('Turn on at least one menu option.');
  if(on.length>LT_MENU_MAX_ROWS)errors.push(`WhatsApp shows at most ${LT_MENU_MAX_ROWS} options — turn some off (${on.length} are on).`);
  const titles=new Set();
  for(const it of on){
    const t=ltMenuRowTitle(it).toLowerCase();
    if(titles.has(t))errors.push(`Two options are both called "${ltMenuRowTitle(it)}".`);
    titles.add(t);
    if(it.action==='link'&&!it.url)errors.push(`"${it.title}" opens a link — add an https:// address.`);
  }
  if(new Set(on.map(i=>i.section.toLowerCase())).size>10)errors.push('Use at most 10 sections.');
  return errors;
}

export function ltMenuRowTitle(item){
  return clip(`${item.emoji?item.emoji+' ':''}${item.title}`,24);
}
// available(item) → false hides a row the agency cannot serve right now: Live Flights without the
// API connected, or a Travel Portal section with nothing listed.
export function ltMenuVisibleItems(menu,available=null){
  return (menu?.items||[]).filter(i=>i.enabled&&(!available||available(i))).slice(0,LT_MENU_MAX_ROWS);
}
// List-message sections, in the order the agency arranged the rows.
export function ltMenuSections(menu,available=null){
  const sections=[];
  for(const it of ltMenuVisibleItems(menu,available)){
    let s=sections.find(x=>x.title.toLowerCase()===it.section.toLowerCase());
    if(!s){s={title:it.section,rows:[]};sections.push(s);}
    s.rows.push({id:LT_MENU_VALUE_PREFIX+it.id,title:ltMenuRowTitle(it),...(it.description?{description:it.description}:{})});
  }
  return sections;
}

const plain=v=>String(v||'').normalize('NFC').replace(/[^\p{L}\p{N}&]+/gu,' ').trim().toLowerCase();
// A tapped row comes back either as its id (when the tap is resolved from the stored options)
// or as its visible title (what WhatsApp itself echoes); typing the bare title also works.
export function ltMenuMatch(menu,text){
  const t=String(text||'').trim();
  if(!t)return null;
  const items=ltMenuVisibleItems(menu);
  if(t.toUpperCase().startsWith(LT_MENU_VALUE_PREFIX)){
    const id=t.slice(LT_MENU_VALUE_PREFIX.length).toLowerCase();
    return items.find(i=>i.id===id)||null;
  }
  const p=plain(t);
  if(!p)return null;
  return items.find(i=>plain(ltMenuRowTitle(i))===p||plain(i.title)===p)||null;
}

const GREETING=/^(?:hi+|hii+|hello+|hey+|hai|helo|hlo|yo|salam|salaam|as+alam+u?\s*alaikum|assalamualaikum|namaste|namaskar(?:am)?|good\s+(?:morning|afternoon|evening|day)|marhaba|ahlan)(?:\s+(?:there|team|sir|madam|ma'?am))?[\s!.,?🙏👋😊]*$/i;
const MENU_WORD=/^(?:menu|main\s*menu|show\s*menu|back\s*to\s*menu|options|services|home|start\s*over)[\s!.?]*$/i;
export function ltMenuIsMenuRequest(text){
  const t=String(text||'').replace(/^[^\p{L}\p{N}]+/u,'').trim();
  return MENU_WORD.test(t);
}
export function ltMenuIsGreeting(text){
  return GREETING.test(String(text||'').trim());
}

export function ltMenuGreetingText(menu,{agencyName='',customerName='',returning=false}={}){
  const first=String(customerName||'').trim().split(/\s+/)[0]||'';
  const name=first&&!/^\+?\d/.test(first)?first:'';
  if(menu?.greeting){
    return menu.greeting.replace(/\{name\}/gi,name||'there').replace(/\{agency\}/gi,agencyName||'us');
  }
  const hello=returning&&name?`👋 Welcome back, ${name}!`:`👋 ${name?`Hi ${name}, welcome`:'Welcome'}${agencyName?` to *${agencyName}*`:''}!`;
  return `${hello}\n\nHow can we help you today? Tap *${menu?.button_label||'Menu'}* to choose a service, or simply type your question.`;
}

// ── Guided flight search pickers ─────────────────────────────────────────────
const DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
// Titles like "18 Oct · Sat" parse back with the chat date parser even if the tap is echoed as
// the title; the value is the ISO date.
export function ltMenuDateRows(today=new Date(),count=9){
  const base=new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),today.getUTCDate()));
  return Array.from({length:count},(_,i)=>{
    const d=new Date(base.getTime()+(i+1)*86400000);
    const iso=d.toISOString().slice(0,10);
    return {title:`${d.getUTCDate()} ${MON[d.getUTCMonth()]} · ${DOW[d.getUTCDay()]}`,value:iso,...(i===0?{description:'Tomorrow'}:i===6?{description:'In one week'}:{})};
  });
}
// Routes the customer or the agency used before, most relevant first, no duplicates.
export function ltMenuRouteRows(routes,limit=8){
  const out=[],seen=new Set();
  for(const r of routes||[]){
    const o=code(r?.[0]??r?.origin),d=code(r?.[1]??r?.destination);
    if(!o||!d||o===d||seen.has(o+d))continue;
    seen.add(o+d);
    out.push({title:`${o} → ${d}`,value:`${o} to ${d}`});
    if(out.length>=limit)break;
  }
  return out;
}
export function ltMenuPaxButtons(){
  return [{title:'1 Adult',value:'1 adult'},{title:'2 Adults',value:'2 adults'},{title:'3 Adults',value:'3 adults'}];
}
// "2", "2 adults 1 child", "family of 4" → passenger counts, or null when the text has none.
export function ltMenuParsePax(text){
  const t=String(text||'').toLowerCase();
  const bare=t.trim().match(/^(\d)$/);
  if(bare)return {adults:Number(bare[1]),children:0,infants:0};
  // "2 adults" and "Adult 2" / "adults: 2" both count.
  // Counts are 1–2 digits on the same line, never part of a date ("17-11-2026⏎Adult 1").
  const num=(words)=>{const m=t.match(new RegExp(`(?<![\\d/.-])(\\d{1,2})[ \\t]*(?:${words})\\b`))||t.match(new RegExp(`\\b(?:${words})[ \\t]*[:\\-]?[ \\t]*(\\d{1,2})(?![\\d/.-])`));return m?m[1]:null;};
  const a=num('adults?|pax|persons?|people|passengers?'),c=num('children|childs?|kids?'),i=num('infants?|bab(?:y|ies)');
  if(!a&&!c&&!i)return null;
  return {adults:Math.max(1,Math.min(9,a?Number(a):1)),children:Math.min(9,c?Number(c):0),infants:Math.min(9,i?Number(i):0)};
}

// ── Checkout: flight details → Proceed → booking form → booking site ─────────
// The customer's words, or the button title WhatsApp echoes back, as one command.
export function ltCheckoutCommand(text){
  const t=String(text||'').normalize('NFC').replace(/^[^\p{L}\p{N}]+/u,'').trim().toLowerCase().replace(/[.!]+$/,'');
  if(/^(?:proceed|proceed to book(?:ing)?|continue|yes,? proceed|yes book|confirm|book now|book this|continue booking)$/.test(t))return 'proceed';
  if(/^(?:skip|skip form|skip & book|go to booking site|open booking site)$/.test(t))return 'skip_form';
  if(/^(?:other flights?|see other flights|change flight|show flights|back to flights)$/.test(t))return 'other_flights';
  if(/^(?:open checkout|checkout|complete booking|open booking form|booking link)$/.test(t))return 'open_checkout';
  return '';
}

const time=v=>{const d=new Date(v);return Number.isNaN(d.getTime())?'—':`${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;};
const day=v=>{const d=new Date(v);return Number.isNaN(d.getTime())?'':`${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;};
// Supplier times are local airport times written as ISO without an offset; reading them as UTC
// prints them unchanged.
// showFare:false (Settings → Travel Agency → Show live flight prices off) leaves the amount to checkout.
export function ltFlightDetailsText(s,{formatMoney,showFare=true}={}){
  const fare=formatMoney?formatMoney(s.total,s.currency):`${s.currency||''} ${Number(s.total||0).toLocaleString('en-US')}`.trim();
  const dur=Number(s.duration||0),stops=Number(s.stops||0);
  const bag=s.baggage||{},cabinBag=bag.cabin||bag.cabinBaggage,checked=bag.checked||bag.checkedBaggage;
  const lines=[
    '✈️ *Flight details*','',
    `*${s.airline||'Flight'}${s.flightNumber?' '+s.flightNumber:''}* (${stops===0?'Non-stop':`${stops} stop${stops===1?'':'s'}`})`,
    `🛫 Depart: ${s.origin||'—'} · ${day(s.departureTime)} ${time(s.departureTime)}`,
    `🛬 Arrive: ${s.destination||'—'} · ${day(s.arrivalTime)} ${time(s.arrivalTime)}`,
  ];
  if(dur)lines.push(`⏱️ Duration: ${Math.floor(dur/60)}h ${dur%60}m`);
  lines.push(`💺 Cabin: ${String(s.cabin||'economy').replace('_',' ').replace(/^./,c=>c.toUpperCase())}`);
  if(cabinBag||checked)lines.push(`🧳 Baggage: ${[cabinBag&&`Cabin ${cabinBag}`,checked&&`Check-in ${checked}`].filter(Boolean).join(' · ')}`);
  if(s.seatsLeft!=null&&Number(s.seatsLeft)<=5)lines.push(`⚠️ Only ${s.seatsLeft} seat${Number(s.seatsLeft)===1?'':'s'} left`);
  lines.push('',showFare?`💰 *Total: ${fare}*`:'💰 Fare: shown at checkout');
  return lines.join('\n');
}

// manual: online booking is off — the team, not a booking page, takes it from here.
// passport (Travel Settings → 🛂 Passenger details, optional, off by default): the form also asks
// for date of birth, passport number and passport expiry date.
export function ltBookingFormText(passenger={},{adults=1,manual=false,passport=false}={}){
  const missing=ltBookingFormMissing(passenger,{passport});
  const total=passport?5:2;
  const others=adults>1?`\n\nDetails for the other ${adults-1} passenger${adults===2?'':'s'} ${manual?'will be collected by our team':'are entered on the booking page'}.`:'';
  const footer=manual?'\n\nOur team will confirm the booking and send payment details here.':'';
  if(passport&&(missing.length===total||!missing.length)){
    return `📝 *Passenger details*\n\nPlease reply with the lead passenger's details, one per line:\n\n👤 *Full Name:* (as on passport)\n🎂 *Date of Birth:* DD/MM/YYYY\n🛂 *Passport Number:*\n📅 *Passport Expiry Date:* DD/MM/YYYY\n📧 *Email:*\n\nExample:\nFull Name: Hussain Aparambil\nDate of Birth: 15/04/1990\nPassport Number: N1234567\nPassport Expiry Date: 20/08/2031\nEmail: name@email.com\n\nYou can also send them one at a time.${others}${footer}`;
  }
  if(!passport&&(missing.length===2||!missing.length)){
    return `📝 *Booking ${manual?'request':'form'}*\n\nPlease reply with the lead passenger's details:\n\n*Full name* (as on passport)\n*Email address*\n\nExample:\nHussain Aparambil\nname@email.com${others}${footer}`;
  }
  const first=passenger.name?`, ${passenger.name.split(' ')[0]}`:'';
  const done=passport?`✅ ${total-missing.length} of ${total} received.\n\n`:'';
  switch(missing[0]){
    case 'name':return `${done}Thanks! Now please send the lead passenger's *full name* exactly as on the passport.`;
    case 'dob':return `${done}Thanks${first}! Now please send the passenger's 🎂 *date of birth* — e.g. *15/04/1990*.`;
    case 'passport_number':return `${done}Thanks${first}! Now please send the 🛂 *passport number* — e.g. *N1234567*.`;
    case 'passport_expiry':return `${done}Thanks${first}! Now please send the 📅 *passport expiry date* — e.g. *20/08/2031*.`;
    default:return `${done}Thanks${first}! Now please send your 📧 *email address* for the e-ticket.`;
  }
}
export function ltBookingFormMissing(p={},{passport=false}={}){
  return passport
    ?[!p.name&&'name',!p.dob&&'dob',!p.passport_number&&'passport_number',!p.passport_expiry&&'passport_expiry',!p.email&&'email'].filter(Boolean)
    :[!p.name&&'name',!p.email&&'email'].filter(Boolean);
}
const NOT_A_NAME=/^(?:ok(?:ay)?|k|thanks?|thank\s*you|thx|ty|yes|yeah|yep|no|nope|hi|hello|hey|sure|fine|done|good|great|nice|wait|later|cancel|stop|please|pls|menu|help)[\s!.]*$/i;
const PAX_MONTHS={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
// "15/04/1990", "15-04-1990", "15.04.1990", "1990-04-15", "15 Apr 1990", "April 15, 1990" → ISO.
// Day comes first in numeric dates (DD/MM/YYYY). '' when the text holds no full, valid date.
export function ltParsePassengerDate(text){
  const t=String(text||'');
  const valid=(y,m,d)=>{const dt=new Date(Date.UTC(y,m-1,d));return y>=1900&&y<=2100&&dt.getUTCFullYear()===y&&dt.getUTCMonth()===m-1&&dt.getUTCDate()===d?dt.toISOString().slice(0,10):'';};
  let m=t.match(/\b((?:19|20)\d{2})[-\/.](\d{1,2})[-\/.](\d{1,2})\b/);
  if(m)return valid(+m[1],+m[2],+m[3]);
  m=t.match(/\b(\d{1,2})[-\/.](\d{1,2})[-\/.]((?:19|20)\d{2})\b/);
  if(m)return valid(+m[3],+m[2],+m[1]);
  m=t.match(/\b(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})[\s,-]+((?:19|20)\d{2})\b/);
  if(m&&PAX_MONTHS[m[2].slice(0,3).toLowerCase()])return valid(+m[3],PAX_MONTHS[m[2].slice(0,3).toLowerCase()],+m[1]);
  m=t.match(/\b([A-Za-z]{3,9})[\s-]+(\d{1,2})(?:st|nd|rd|th)?[\s,-]+((?:19|20)\d{2})\b/);
  if(m&&PAX_MONTHS[m[1].slice(0,3).toLowerCase()])return valid(+m[3],PAX_MONTHS[m[1].slice(0,3).toLowerCase()],+m[2]);
  return '';
}
const PAX_DATE_RE=/\b(?:19|20)\d{2}[-\/.]\d{1,2}[-\/.]\d{1,2}\b|\b\d{1,2}[-\/.]\d{1,2}[-\/.](?:19|20)\d{2}\b|\b\d{1,2}(?:st|nd|rd|th)?[\s-]+[A-Za-z]{3,9}[\s,-]+(?:19|20)\d{2}\b|\b[A-Za-z]{3,9}[\s-]+\d{1,2}(?:st|nd|rd|th)?[\s,-]+(?:19|20)\d{2}\b/g;
const PAX_DOB_LABEL=/\b(?:d\.?o\.?b|date\s*of\s*birth|birth\s*date|birthday|born)\b/i;
const PAX_EXPIRY_LABEL=/\b(?:expiry|expiration|expires?|exp|valid\s*(?:till|until|upto|up\s*to)|doe)\b/i;
const PAX_PASSPORT_LABEL=/\b(?:passport|pp)\s*(?:no\.?|num(?:ber)?|#)?\s*[:\-]?\s*/i;
// Passport numbers: 6–9 letters/digits with at least one digit and at least one letter or 7+
// digits, e.g. N1234567, P12345678, 123456789. Never a date or a phone-length number.
const ltPassportToken=v=>{const t=String(v||'').toUpperCase().replace(/[\s-]/g,'');return /^(?=.*\d)[A-Z0-9]{6,9}$/.test(t)&&(/[A-Z]/.test(t)||t.length>=7)?t:'';};
// The passport fields of one reply. Labelled lines win; otherwise a past date is the date of birth
// and a future one the passport expiry. A lone expired date is reported so the bot can say so.
function ltParsePassportFields(raw,prev={},today=new Date()){
  const now=today.toISOString().slice(0,10),out={};
  let expired='';
  for(const line of String(raw||'').split(/\n|;/)){
    const date=ltParsePassengerDate(line);
    if(date&&PAX_DOB_LABEL.test(line))out.dob=date;
    else if(date&&PAX_EXPIRY_LABEL.test(line)){if(date>now)out.passport_expiry=date;else expired=date;}
    const labelled=line.match(/\b(?:passport|pp)\s*(?:no\.?|num(?:ber)?|#)?\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9 \-]{4,12})\s*$/i);
    if(labelled&&!PAX_EXPIRY_LABEL.test(line)&&ltPassportToken(labelled[1]))out.passport_number=ltPassportToken(labelled[1]);
  }
  for(const m of String(raw||'').replace(/[^\n;]*(?:\b(?:d\.?o\.?b|date\s*of\s*birth|birth\s*date|birthday|born|expiry|expiration|expires?|exp|doe)\b)[^\n;]*/gi,' ').matchAll(PAX_DATE_RE)){
    const date=ltParsePassengerDate(m[0]);if(!date)continue;
    if(date<=now){
      if(!out.dob&&!prev.dob)out.dob=date;
      else if(!out.passport_expiry&&!prev.passport_expiry)expired=date;
    }else if(!out.passport_expiry)out.passport_expiry=date;
  }
  if(!out.passport_number){
    const stripped=String(raw||'').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,' ').replace(PAX_DATE_RE,' ');
    const whole=ltPassportToken(stripped.replace(PAX_PASSPORT_LABEL,' ').trim());
    const tokens=stripped.replace(PAX_PASSPORT_LABEL,' ').split(/[\s,;:]+/).map(ltPassportToken).filter(Boolean);
    if(whole)out.passport_number=whole;
    else if(tokens.length===1)out.passport_number=tokens[0];
  }
  if(expired&&!out.passport_expiry)out.expired_passport=expired;
  return out;
}
// Free text with a name and/or an email, in any order or with "Name:" / "Email:" labels.
// passport: also date of birth, passport number and passport expiry date (labelled or not).
export function ltParseBookingForm(text,prev={},{passport=false,today=new Date()}={}){
  const raw=String(text||'');
  const email=raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]||'';
  const rest=raw.replace(email,' ').split(/\n|,|;/).map(line=>line.replace(/^\s*(?:full\s*name|name|passenger(?:\s*name)?|email(?:\s*address)?|e-?mail)\s*[:\-]\s*/i,'').trim())
    .filter(line=>line&&!/\d{3,}/.test(line)&&/^[\p{L}][\p{L}\s.'-]{1,79}$/u.test(line)&&!NOT_A_NAME.test(line)&&!(passport&&(PAX_DOB_LABEL.test(line)||PAX_EXPIRY_LABEL.test(line)||/\bpassport\b/i.test(line))));
  const nameLine=rest.find(line=>line.split(/\s+/).length>=2)||(prev.name?'':rest.find(line=>line.length>=3&&!ltCheckoutCommand(line)))||'';
  const name=nameLine.replace(/\s+/g,' ').replace(/\b\p{Ll}/gu,c=>c.toUpperCase()).slice(0,80);
  const base={name:name||prev.name||'',email:(email||prev.email||'').toLowerCase().slice(0,200)};
  if(!passport)return base;
  const pp=ltParsePassportFields(raw,prev,today);
  const out={...base,dob:pp.dob||prev.dob||'',passport_number:pp.passport_number||prev.passport_number||'',passport_expiry:pp.passport_expiry||prev.passport_expiry||''};
  if(pp.expired_passport)out.expired_passport=pp.expired_passport;
  return out;
}
// The passport lines of a booking request, for the team's note and the saved quote.
export function ltPassengerPassportLine(p={}){
  const d=v=>{const m=String(v||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);return m?`${m[3]}/${m[2]}/${m[1]}`:'—';};
  return p.dob||p.passport_number||p.passport_expiry?`🎂 DOB ${d(p.dob)} · 🛂 Passport ${p.passport_number||'—'} · 📅 Expires ${d(p.passport_expiry)}`:'';
}

// The booking-site link for the chosen fare. Contact details ride along so the site can prefill
// its form; a site that does not read them simply ignores the extra parameters.
// A checkout link with a {fareId} placeholder (Custom API connector) is used as written, with the
// same prefill parameters appended.
export function ltCheckoutUrl(selected,clientId,{passenger={},phone='',adults=0,children=0,infants=0}={}){
  const base=String(selected?.checkoutBase||'https://flypoomas.com').replace(/\/$/,'');
  const template=/\{fareId\}/i.test(base);
  const q=new URLSearchParams(template?{}:{fareId:String(selected?.fareId||''),supplier:String(selected?.supplier||''),source:'leadvyne',client:String(clientId)});
  const parts=String(passenger.name||'').trim().split(/\s+/).filter(Boolean);
  if(parts.length){q.set('first_name',parts.slice(0,-1).join(' ')||parts[0]);if(parts.length>1)q.set('last_name',parts[parts.length-1]);}
  if(passenger.email)q.set('email',passenger.email);
  const digits=String(phone||'').replace(/\D/g,'');
  if(passenger.name||passenger.email){if(digits)q.set('phone','+'+digits);}
  if(adults)q.set('adults',String(adults));
  if(children)q.set('children',String(children));
  if(infants)q.set('infants',String(infants));
  if(template){
    const url=base.replace(/\{fareId\}/gi,encodeURIComponent(String(selected?.fareId||''))).replace(/\{supplier\}/gi,encodeURIComponent(String(selected?.supplier||''))).replace(/\{client\}/gi,encodeURIComponent(String(clientId)));
    const extra=q.toString();
    return extra?`${url}${url.includes('?')?'&':'?'}${extra}`:url;
  }
  return `${base}/book?${q.toString()}`;
}

// ── Travel Portal listings ───────────────────────────────────────────────────
const money=(n,cur)=>{const v=Number(n);return Number.isFinite(v)&&v>0?`${String(cur||'').trim()||'AED'} ${v.toLocaleString('en-US',{maximumFractionDigits:2})}`:'';};
const shortDate=v=>{const d=new Date(String(v||'').slice(0,10)+'T00:00:00Z');return Number.isNaN(d.getTime())?'':`${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;};
const list=v=>{if(Array.isArray(v))return v.map(String).filter(Boolean);try{const a=JSON.parse(v);if(Array.isArray(a))return a.map(String).filter(Boolean);}catch(e){}return String(v||'').split(/\n|;|,/).map(x=>x.trim()).filter(Boolean);};
const join=(...parts)=>parts.filter(Boolean).join(' · ');
const lines=v=>String(v||'').split(/\n|;/).map(x=>x.trim()).filter(Boolean);
const STAY={'10_days':'10 days','14_days':'14 days','30_days':'30 days','60_days':'60 days','90_days':'90 days','1_year':'1 year'};
const VISA_TYPE={single_entry:'Single Entry',multiple_entry:'Multiple Entry',transit:'Transit'};
const SERVICE_ICON={transportation:'🚌',transport:'🚌','hotel stay':'🏨',hotel:'🏨',meals:'🍽️',meal:'🍽️','border fees':'🛃','border fee':'🛃','travel insurance':'🛡️',insurance:'🛡️'};

// A visa package's "Services Included" (dashboard → Visa → Services Included, or the sheet
// import): [{item,detail}] stored as JSON; a plain "a; b" list from older records also works.
export function ltVisaServicesIncluded(r){
  let v=r?.services_included;
  if(typeof v==='string'){try{v=JSON.parse(v);}catch(e){v=lines(v).map(item=>({item}));}}
  return (Array.isArray(v)?v:[]).map(x=>typeof x==='string'?{item:x.trim(),detail:''}:{item:String(x?.item||'').trim(),detail:String(x?.detail||'').trim()}).filter(x=>x.item);
}
export function ltVisaServiceLine(x){
  return `${SERVICE_ICON[x.item.toLowerCase()]||'✅'} ${x.item}${x.detail?`: ${x.detail}`:''}`;
}
// One visa for the bot's grounded travel context.
export function ltVisaContextLine(r){
  const name=join(r.visa_country,VISA_TYPE[r.visa_type]||r.visa_type).replace(' · ',' ');
  const svc=ltVisaServicesIncluded(r);
  const parts=[`- ${name} visa`,STAY[r.duration]||r.duration?`stay ${STAY[r.duration]||r.duration}`:'',r.visa_validity?`validity ${r.visa_validity}`:'',r.entry_type?`entry ${r.entry_type}`:'',
    r.processing_time?`processing ${r.processing_time}`:'',money(r.adult_price,r.currency)?`${money(r.adult_price,r.currency)} adult${money(r.child_price,r.currency)?` / ${money(r.child_price,r.currency)} child`:''}`:'price on request',
    svc.length?`includes: ${svc.map(x=>x.detail?`${x.item} (${x.detail})`:x.item).join(', ')}`:'',lines(r.not_included).length?`not included: ${lines(r.not_included).join(', ')}`:'',
    lines(r.required_documents).length?`documents: ${lines(r.required_documents).slice(0,8).join(', ')}`:'',r.notes?String(r.notes).replace(/\s+/g,' ').slice(0,200):''];
  return parts.filter(Boolean).join(' — ').slice(0,700);
}
const CLOSED=/^(?:inactive|sold[_ -]?out|closed|expired|cancelled|canceled|full|unavailable|hidden|draft)$/i;

// Raw Travel Portal records → menu rows {id,title,description,detail}. Only what a customer can
// still buy is listed: no inactive visas, past or full Umrah groups, departed or closed fares,
// cars out on hire (outCarIds), and nothing without a name. today = 'YYYY-MM-DD'.
export function ltPortalRows(source,records,{today=new Date().toISOString().slice(0,10),outCarIds=new Set()}={}){
  const rows=[];
  for(const r of records||[]){
    if(!r||CLOSED.test(String(r.status||'').trim()))continue;
    const id=String(r.Id??r.id??'').trim();
    if(!id)continue;
    let row=null;
    if(source==='packages'&&r.name){
      const price=money(Number(r.sell_price)>0?r.sell_price:r.base_price,r.currency);
      const inc=list(r.inclusions).slice(0,8),exc=list(r.exclusions).slice(0,5);
      const region=taPackageRegion(r);
      row={title:r.name,region,description:join(region&&TA_PKG_REGIONS[region].label,r.destination,r.nights?`${r.nights}N`:'',price&&`from ${price}`),
        detail:[`🏝️ *${r.name}*`,join(region&&`${TA_PKG_REGIONS[region].emoji} ${TA_PKG_REGIONS[region].label}`,r.type,r.destination),r.nights?`🌙 ${r.nights} nights`:'',(r.pax_min||r.pax_max)?`👥 ${r.pax_min||1}–${r.pax_max||r.pax_min} travellers`:'',price?`💰 *${price}* per person`:'',
          inc.length?`\n✅ *Includes*\n${inc.map(x=>'• '+x).join('\n')}`:'',exc.length?`\n❌ *Excludes*\n${exc.map(x=>'• '+x).join('\n')}`:'',r.notes?`\n${String(r.notes).slice(0,300)}`:''].filter(Boolean).join('\n')};
    }
    if(source==='umrah'&&r.name){
      if(r.departure_date&&String(r.departure_date).slice(0,10)<today)continue;
      const booked=list(r.pilgrims).length,left=Math.max(0,Number(r.seats||0)-booked);
      if(Number(r.seats||0)>0&&left<=0)continue;
      const price=money(r.price_per_pax,r.currency);
      row={title:r.name,description:join(r.departure_date&&`Departs ${shortDate(r.departure_date)}`,left?`${left} seats left`:'',price),
        detail:[`🕋 *${r.name}*`,`🛫 ${shortDate(r.departure_date)||'Date TBA'}${r.return_date?` → ${shortDate(r.return_date)}`:''}`,
          (r.makkah_hotel||r.makkah_nights)?`🏨 Makkah: ${join(r.makkah_hotel,r.makkah_nights?`${r.makkah_nights} nights`:'')}`:'',
          (r.madinah_hotel||r.madinah_nights)?`🏨 Madinah: ${join(r.madinah_hotel,r.madinah_nights?`${r.madinah_nights} nights`:'')}`:'',
          r.transport?`🚌 ${r.transport}`:'',left?`💺 ${left} seats left`:'',price?`💰 *${price}* per person`:'',r.notes?`\n${String(r.notes).slice(0,300)}`:''].filter(Boolean).join('\n')};
    }
    if(source==='visas'&&r.visa_country){
      const type=VISA_TYPE[r.visa_type]||r.visa_type,stay=STAY[r.duration]||r.duration;
      const name=join(r.visa_country,type).replace(' · ',' ');
      const adult=money(r.adult_price,r.currency),child=money(r.child_price,r.currency),docs=list(r.required_documents).slice(0,10);
      const svc=ltVisaServicesIncluded(r),exc=lines(r.not_included).slice(0,6);
      row={title:`${name} Visa`.replace(/visa visa$/i,'Visa'),description:join(stay,adult,svc.length?`${svc.length} services incl.`:r.processing_time),
        detail:[`🛂 *${name} visa*`,stay?`📅 Stay: ${stay}`:'',r.visa_validity?`⏳ Validity: ${r.visa_validity}`:'',r.entry_type?`🚪 Entry: ${r.entry_type}`:'',
          r.processing_time?`⏱️ Processing: ${r.processing_time}`:'',adult?`💰 *${adult}* adult${child?` · ${child} child`:''}`:'',
          svc.length?`\n✅ *Services included*\n${svc.slice(0,10).map(ltVisaServiceLine).join('\n')}`:'',
          exc.length?`\n❌ *Not included*\n${exc.map(x=>'• '+x).join('\n')}`:'',
          docs.length?`\n📎 *Documents needed*\n${docs.map(x=>'• '+x).join('\n')}`:'',r.notes?`\n${String(r.notes).slice(0,300)}`:''].filter(Boolean).join('\n')};
    }
    if(source==='cars'&&(r.name||r.make)){
      if(r.status&&!/^available$/i.test(r.status))continue;
      if(outCarIds.has(id))continue;
      const name=r.name||join(r.make,r.model).replace(' · ',' '),rate=money(r.daily_rate,r.currency),feat=list(r.features).slice(0,6);
      row={title:name,description:join(r.category,r.seats?`${r.seats} seats`:'',rate&&`${rate}/day`),
        detail:[`🚗 *${name}*`,join(r.year,r.category,r.color),r.seats?`💺 ${r.seats} seats`:'',rate?`💰 *${rate}* per day`:'',feat.length?`\n✨ ${feat.join(' · ')}`:''].filter(Boolean).join('\n')};
    }
    if(source==='attestation'&&r.name){
      const fee=money(r.fee,r.currency||'INR'),docs=list(r.required_docs).slice(0,8);
      row={title:r.name,description:join(r.country,fee,r.turnaround_time),
        detail:[`📄 *${r.name}*`,join(r.service_type,r.country&&`for ${r.country}`),fee?`💰 *${fee}*`:'',r.turnaround_time?`⏱️ Turnaround: ${r.turnaround_time}`:'',
          docs.length?`\n📎 *Documents needed*\n${docs.map(x=>'• '+x).join('\n')}`:''].filter(Boolean).join('\n')};
    }
    if((source==='group_fares'||source==='special_fares')&&(r.sector||r.from_city)){
      const date=String(r.departure_date||'').slice(0,10);
      if(date&&date<today)continue;
      if(r.booking_deadline&&String(r.booking_deadline).slice(0,10)<today)continue;
      if(r.fare_valid_until&&String(r.fare_valid_until).slice(0,10)<today)continue;
      if(r.available_seats!=null&&r.available_seats!==''&&Number(r.available_seats)<=0)continue;
      const sector=r.sector||join(r.from_city,r.to_city).replace(' · ',' → '),price=money(r.fare_price,r.currency);
      row={title:`${sector}${date?` ${shortDate(date)}`:''}`,description:join(join(r.airline,r.flight_number).replace(' · ',' '),price,r.available_seats?`${r.available_seats} seats`:''),
        detail:[`${source==='group_fares'?'👥':'🔥'} *${sector}*`,join(r.airline,r.flight_number).replace(' · ',' '),
          date?`🛫 ${shortDate(date)}${r.departure_time?` ${r.departure_time}`:''}${r.arrival_time?` → ${r.arrival_time}`:''}${r.return_date?` · return ${shortDate(r.return_date)}`:''}`:'',
          join(r.cabin_class,r.fare_type),r.baggage_allowance?`🧳 ${r.baggage_allowance}`:'',r.available_seats?`💺 ${r.available_seats} seats left`:'',
          price?`💰 *${price}* per person`:'',r.booking_deadline?`⏳ Book by ${shortDate(r.booking_deadline)}`:'',r.remarks?`\n${String(r.remarks).slice(0,300)}`:''].filter(Boolean).join('\n')};
    }
    if(row)rows.push({id,title:clip(row.title,60),description:clip(row.description,72),detail:row.detail,...(row.region!==undefined?{region:row.region}:{})});
  }
  // Packages sharing a name ("INTERNATIONAL TOUR") get told apart by destination and nights.
  if(source==='packages'){
    const titles=new Map(taPackageListRows((records||[]).filter(r=>rows.some(x=>x.id===String(r?.Id??r?.id??'')))).map(x=>[x.id,x.title]));
    for(const row of rows)if(titles.has(row.id))row.title=clip(titles.get(row.id),60);
  }
  return rows;
}
