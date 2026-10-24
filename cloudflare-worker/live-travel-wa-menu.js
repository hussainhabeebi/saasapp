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
export function ltFlightDetailsText(s,{formatMoney}={}){
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
  lines.push('',`💰 *Total: ${fare}*`);
  return lines.join('\n');
}

export function ltBookingFormText(passenger={},{adults=1}={}){
  const missing=ltBookingFormMissing(passenger);
  if(missing.length===2||!missing.length){
    return `📝 *Booking form*\n\nPlease reply with the lead passenger's details:\n\n*Full name* (as on passport)\n*Email address*\n\nExample:\nHussain Aparambil\nname@email.com${adults>1?`\n\nDetails for the other ${adults-1} passenger${adults===2?'':'s'} are entered on the booking page.`:''}`;
  }
  return missing[0]==='name'
    ? `Thanks! Now please send the lead passenger's *full name* exactly as on the passport.`
    : `Thanks${passenger.name?`, ${passenger.name.split(' ')[0]}`:''}! Now please send your *email address* for the e-ticket.`;
}
export function ltBookingFormMissing(p={}){
  return [!p.name&&'name',!p.email&&'email'].filter(Boolean);
}
const NOT_A_NAME=/^(?:ok(?:ay)?|k|thanks?|thank\s*you|thx|ty|yes|yeah|yep|no|nope|hi|hello|hey|sure|fine|done|good|great|nice|wait|later|cancel|stop|please|pls|menu|help)[\s!.]*$/i;
// Free text with a name and/or an email, in any order or with "Name:" / "Email:" labels.
export function ltParseBookingForm(text,prev={}){
  const raw=String(text||'');
  const email=raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]||'';
  const rest=raw.replace(email,' ').split(/\n|,|;/).map(line=>line.replace(/^\s*(?:full\s*name|name|passenger(?:\s*name)?|email(?:\s*address)?|e-?mail)\s*[:\-]\s*/i,'').trim())
    .filter(line=>line&&!/\d{3,}/.test(line)&&/^[\p{L}][\p{L}\s.'-]{1,79}$/u.test(line)&&!NOT_A_NAME.test(line));
  const nameLine=rest.find(line=>line.split(/\s+/).length>=2)||(prev.name?'':rest.find(line=>line.length>=3&&!ltCheckoutCommand(line)))||'';
  const name=nameLine.replace(/\s+/g,' ').replace(/\b\p{Ll}/gu,c=>c.toUpperCase()).slice(0,80);
  return {name:name||prev.name||'',email:(email||prev.email||'').toLowerCase().slice(0,200)};
}

// The booking-site link for the chosen fare. Contact details ride along so the site can prefill
// its form; a site that does not read them simply ignores the extra parameters.
export function ltCheckoutUrl(selected,clientId,{passenger={},phone='',adults=0,children=0,infants=0}={}){
  const base=String(selected?.checkoutBase||'https://flypoomas.com').replace(/\/$/,'');
  const q=new URLSearchParams({fareId:String(selected?.fareId||''),supplier:String(selected?.supplier||''),source:'leadvyne',client:String(clientId)});
  const parts=String(passenger.name||'').trim().split(/\s+/).filter(Boolean);
  if(parts.length){q.set('first_name',parts.slice(0,-1).join(' ')||parts[0]);if(parts.length>1)q.set('last_name',parts[parts.length-1]);}
  if(passenger.email)q.set('email',passenger.email);
  const digits=String(phone||'').replace(/\D/g,'');
  if(passenger.name||passenger.email){if(digits)q.set('phone','+'+digits);}
  if(adults)q.set('adults',String(adults));
  if(children)q.set('children',String(children));
  if(infants)q.set('infants',String(infants));
  return `${base}/book?${q.toString()}`;
}

// ── Travel Portal listings ───────────────────────────────────────────────────
const money=(n,cur)=>{const v=Number(n);return Number.isFinite(v)&&v>0?`${String(cur||'').trim()||'AED'} ${v.toLocaleString('en-US',{maximumFractionDigits:2})}`:'';};
const shortDate=v=>{const d=new Date(String(v||'').slice(0,10)+'T00:00:00Z');return Number.isNaN(d.getTime())?'':`${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;};
const list=v=>{if(Array.isArray(v))return v.map(String).filter(Boolean);try{const a=JSON.parse(v);if(Array.isArray(a))return a.map(String).filter(Boolean);}catch(e){}return String(v||'').split(/\n|;|,/).map(x=>x.trim()).filter(Boolean);};
const join=(...parts)=>parts.filter(Boolean).join(' · ');
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
      row={title:r.name,description:join(r.destination,r.nights?`${r.nights}N`:'',price&&`from ${price}`),
        detail:[`🏝️ *${r.name}*`,join(r.type,r.destination),r.nights?`🌙 ${r.nights} nights`:'',(r.pax_min||r.pax_max)?`👥 ${r.pax_min||1}–${r.pax_max||r.pax_min} travellers`:'',price?`💰 *${price}* per person`:'',
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
      const name=join(r.visa_country,r.visa_type).replace(' · ',' ');
      const adult=money(r.adult_price,r.currency),child=money(r.child_price,r.currency),docs=list(r.required_documents).slice(0,10);
      row={title:`${name} Visa`.replace(/visa visa$/i,'Visa'),description:join(r.duration,adult,r.processing_time),
        detail:[`🛂 *${name} visa*`,r.duration?`📅 Stay: ${r.duration}`:'',r.visa_validity?`⏳ Validity: ${r.visa_validity}`:'',r.entry_type?`🚪 Entry: ${r.entry_type}`:'',
          r.processing_time?`⏱️ Processing: ${r.processing_time}`:'',adult?`💰 *${adult}* adult${child?` · ${child} child`:''}`:'',
          docs.length?`\n📎 *Documents needed*\n${docs.map(x=>'• '+x).join('\n')}`:''].filter(Boolean).join('\n')};
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
    if(row)rows.push({id,title:clip(row.title,60),description:clip(row.description,72),detail:row.detail});
  }
  return rows;
}
