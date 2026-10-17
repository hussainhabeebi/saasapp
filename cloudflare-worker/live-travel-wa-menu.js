/* ═══════════════════════════════════════════════════════════════════════════
   LIVE TRAVEL — WHATSAPP MENU & GUIDED FLIGHT BOOKING
   Each travel agency sets its own WhatsApp menu (Live Agency → 💬 WhatsApp Menu):
   Flights, Visa, Packages, Umrah, Hotels, My Bookings, Talk to Agent … in its own
   order, wording and sections. "hi" / "menu" sends it as a WhatsApp list message.

   A menu row does one of:
     flight_search  guided flight search on the connected live API (POOMAS):
                    route → date → passengers buttons → live fares → pick →
                    flight details → Proceed → booking form → booking-site link
     ask            sends the agency's question and tags the lead's Service Category;
                    the customer's answer continues with the normal AI reply
     link           a button that opens the agency's own page (packages, visa form…)
     handover       hands the chat to a team member
     my_bookings    the customer's Live Agency bookings, looked up by phone

   Everything here is pure (no I/O) so it can be unit-tested; the D1 storage and the
   WhatsApp sends live in worker.js.
   ═══════════════════════════════════════════════════════════════════════════ */

export const LT_MENU_ACTIONS=['flight_search','ask','link','handover','my_bookings'];
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
      {id:'flights',emoji:'✈️',title:'Flight Tickets',description:'Live fares — search and book in chat',section:'Book',action:'flight_search',category:'Air Ticket'},
      {id:'packages',emoji:'🏝️',title:'Holiday Packages',description:'Tours, honeymoon and family trips',section:'Book',action:'ask',category:'Package',
        message:'🏝️ Great choice! Which destination are you interested in?\n\nPlease share your travel month and how many people are travelling.'},
      {id:'umrah',emoji:'🕋',title:'Umrah & Hajj',description:'Umrah packages and visas',section:'Book',action:'ask',category:'Umrah and Hajj',
        message:'🕋 We arrange Umrah and Hajj packages.\n\nWhen would you like to travel, from which city, and how many people?'},
      {id:'hotels',emoji:'🏨',title:'Hotels',description:'Hotel bookings worldwide',section:'Book',action:'ask',category:'Hotel',
        message:'🏨 Which city do you need a hotel in?\n\nPlease share check-in and check-out dates and the number of guests.'},
      {id:'visa',emoji:'🛂',title:'Visa Services',description:'Visit, tourist and work visas',section:'Documents',action:'ask',category:'Visa',
        message:'🛂 Which country is the visa for?\n\nPlease share your nationality, visa type (visit / tourist / work) and travel date.'},
      {id:'attestation',emoji:'📄',title:'Attestation',description:'Certificate attestation',section:'Documents',action:'ask',category:'Certificate Attestation',enabled:false,
        message:'📄 Which certificate needs attestation, and for which country?'},
      {id:'bookings',emoji:'🎫',title:'My Bookings',description:'Booking status, PNR and tickets',section:'My Trip',action:'my_bookings',category:''},
      {id:'agent',emoji:'👤',title:'Talk to an Agent',description:'Chat with our travel team',section:'Help',action:'handover',category:'',
        message:'👤 Sure — connecting you with our travel team. Someone will reply here shortly.'},
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
    return {
      id,emoji:clip(it?.emoji,8),title:clip(it?.title,24)||`Option ${i+1}`,description:clip(it?.description,72),
      section:clip(it?.section,24)||'Services',action,category:clip(it?.category,60),
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
export function ltMenuVisibleItems(menu){
  return (menu?.items||[]).filter(i=>i.enabled).slice(0,LT_MENU_MAX_ROWS);
}
// List-message sections, in the order the agency arranged the rows.
export function ltMenuSections(menu){
  const sections=[];
  for(const it of ltMenuVisibleItems(menu)){
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
  const a=t.match(/(\d+)\s*(?:adults?|pax|persons?|people|passengers?)\b/),c=t.match(/(\d+)\s*(?:children|childs?|kids?)\b/),i=t.match(/(\d+)\s*(?:infants?|bab(?:y|ies))\b/);
  if(!a&&!c&&!i)return null;
  return {adults:Math.max(1,Math.min(9,a?Number(a[1]):1)),children:Math.min(9,c?Number(c[1]):0),infants:Math.min(9,i?Number(i[1]):0)};
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
