// Destination Staff Routing — travel agencies (Lead Routing → 📍 Destination Staff Routing).
//
// Each teammate lists the destinations they handle, per kind of enquiry:
//   • Hotels & Resorts  — Resorts V1 locations ("Munnar", "Wayanad")
//   • Holiday Packages  — package destinations or names ("Kashmir", "Bali", "Georgia Ladies Only")
//   • Flight routes     — "Kochi - Dubai", "COK-DXB", or one city for every route to/from it ("Dubai")
// "*" in a list catches every enquiry of that kind no other rule matched.
//
// The moment a customer picks a destination on the main WhatsApp number (a Resorts V1 location, a
// Flyindo destination, a package, or a flight route they type) and a teammate's rule matches:
//   1. the lead is classified (DsrKind / DsrDestination) and assigned to that teammate (Owner,
//      DsrStaff) — Chats and Leads show it under them;
//   2. the customer gets one last message on the main number: their expert's name and WhatsApp
//      number (with a wa.me link), and the bot on the main number goes silent for that customer;
//   3. the teammate gets a WhatsApp alert on their own number with the customer's details and a
//      wa.me link to message them;
//   4. when the teammate has their own WhatsApp channel (Channels → inbox assignment) and an
//      approved intro template, the first message to the customer goes out from that number, so
//      the conversation carries on there (in the Chats inbox, under that channel).
//
// Pure decisions only (no I/O) so they can be unit-tested; worker.js does the sends.

export const DSR_KINDS=['resort','package','flight'];
export const DSR_KIND_LABEL={resort:'Hotels & Resorts', package:'Holiday Package', flight:'Flight'};
const RULE_FIELD={resort:'resorts', package:'packages', flight:'flights'};
const LIST_MAX=60;
export const DSR_TEXT_MAX=1000;

// Staff alert (main number → teammate's own WhatsApp). Meta rejects a body that starts or ends on
// a variable, so the link is never last.
export const DSR_STAFF_TEMPLATE={
  name:'destination_lead_leadvyne', category:'UTILITY', language:'en',
  body:'📍 New {{1}} enquiry for you: {{2}} ({{3}}) chose {{4}}. Please message them on WhatsApp now: {{5}} - sent by Leadvyne.',
  example:['Holiday Package', 'Priya', '+919876543210', 'Munnar', 'https://wa.me/919876543210'],
};
// Optional first message to the customer from the teammate's own WhatsApp channel.
export const DSR_CUSTOMER_TEMPLATE={
  name:'destination_expert_intro_leadvyne', category:'UTILITY', language:'en',
  body:'Hi {{1}}, this is {{2}} from {{3}}. I am your travel expert for {{4}} and will help you with your enquiry from this number. Please reply here with any questions.',
  example:['Priya', 'Anu', 'Acme Tours', 'Munnar'],
};

const str=v=>String(v??'').trim();
const digits=v=>String(v??'').replace(/\D/g, '');
const yes=v=>str(v).toLowerCase()==='yes';
function cleanList(v){
  const arr=(Array.isArray(v)?v:[v]).flatMap(x=>String(x??'').split(/[,\n]/));
  const out=[];
  for(const x of arr){
    const s=str(x).replace(/\s+/g, ' ').slice(0, 80);
    if(s && !out.some(o=>o.toLowerCase()===s.toLowerCase())) out.push(s);
  }
  return out.slice(0, LIST_MAX);
}

// A travel agency account: a travel industry, or the Agency module switched on.
export function dsrIsAgency(c){
  return str(c?.industry).toLowerCase().includes('travel') || yes(c?.ta_enabled);
}

// Saved settings (CLIENTS.dest_staff_routing, JSON) → a clean object.
export function dsrNormalizeSettings(raw){
  let s=raw;
  if(typeof s==='string'){ try{ s=JSON.parse(s||'{}'); }catch(e){ s={}; } }
  if(!s || typeof s!=='object') s={};
  const kinds={};
  for(const k of DSR_KINDS) kinds[k]=s.kinds?.[k]!==false;
  const rules={};
  for(const [email, r] of Object.entries(s.rules&&typeof s.rules==='object'?s.rules:{})){
    const e=str(email).toLowerCase();
    if(!e || !e.includes('@')) continue;
    const rule={resorts:cleanList(r?.resorts), packages:cleanList(r?.packages), flights:cleanList(r?.flights)};
    const phone=digits(r?.phone);
    if(phone.length>=8 && phone.length<=15) rule.phone=phone;
    if(rule.resorts.length || rule.packages.length || rule.flights.length || rule.phone) rules[e]=rule;
  }
  return {
    enabled:s.enabled===true,
    kinds,
    rules,
    customer_text:str(s.customer_text).slice(0, DSR_TEXT_MAX),
    notify_owner_too:s.notify_owner_too===true,
    staff_template_name:str(s.staff_template_name).slice(0, 512),
    staff_template_lang:str(s.staff_template_lang||'en').slice(0, 15)||'en',
    start_from_staff_number:s.start_from_staff_number!==false,
    customer_template_name:str(s.customer_template_name).slice(0, 512),
    customer_template_lang:str(s.customer_template_lang||'en').slice(0, 15)||'en',
  };
}
export function dsrSettings(c){ return dsrNormalizeSettings(c?.dest_staff_routing); }
export function dsrOn(c){ return dsrIsAgency(c) && dsrSettings(c).enabled; }

// ── Matching ─────────────────────────────────────────────────────────────────────────────────────
export function dsrNorm(s){
  return String(s??'').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}
// "Munnar" ↔ "Munnar, Kerala", "munnar hills" ↔ "Munnar": whole words, at least 3 letters.
export function dsrPlaceMatch(rule, place){
  const a=dsrNorm(rule), b=dsrNorm(place);
  if(a.length<3 || b.length<3) return false;
  if(a===b) return true;
  return ` ${b} `.includes(` ${a} `) || ` ${a} `.includes(` ${b} `);
}
// ── Location-based view for travel-agency staff ──────────────────────────────────────────────────
// A teammate's Hotels & Resorts destinations ("Wayanad", "Vythiri", "Munnar") also limit which
// properties they see and send from Chats (Attach → location tabs, AI Stay Itinerary), so Wayanad
// staff work only with Wayanad's details. null = no limit: no rule for them, or a "*" entry.
// Applies whether or not routing itself is switched on — the list is the teammate's locations.
export function dsrStaffLocations(cfg, email){
  const e=str(email).toLowerCase();
  if(!e) return null;
  const key=Object.keys(cfg?.rules||{}).find(k=>k.toLowerCase()===e);
  const list=key?cleanList(cfg.rules[key]?.resorts):[];
  if(!list.length || list.some(x=>x==='*')) return null;
  return list;
}
// Is a property (its location, or its name) inside one of those locations?
export function dsrLocationAllowed(locs, ...places){
  if(!locs) return true;
  return places.map(str).filter(Boolean).some(p=>locs.some(l=>dsrPlaceMatch(l, p)));
}
// A flight rule: "Kochi - Dubai" / "COK→DXB" / "Kochi to Dubai" (that route, either direction off)
// or one place ("Dubai": every route from or to it).
export function dsrParseRoute(rule){
  const parts=String(rule||'').split(/\s*(?:→|->|–|—|-|\bto\b)\s*/i).map(str).filter(Boolean);
  if(parts.length===2) return {from:parts[0], to:parts[1]};
  return {any:str(rule)};
}
// ask.origin / ask.destination: {code, name} of the customer's route.
function sideMatch(rulePlace, side){
  if(!side) return false;
  const r=dsrNorm(rulePlace);
  if(r.length===3 && side.code && r===dsrNorm(side.code)) return true;
  return [side.name, side.code].filter(Boolean).some(x=>dsrPlaceMatch(rulePlace, x));
}
function ruleMatches(kind, entry, ask){
  if(kind==='flight'){
    const route=dsrParseRoute(entry);
    if(route.any) return sideMatch(route.any, ask.destination) || sideMatch(route.any, ask.origin);
    return sideMatch(route.from, ask.origin) && sideMatch(route.to, ask.destination);
  }
  const names=[ask.destination, ...(ask.names||[])].map(str).filter(Boolean);
  return names.some(n=>dsrPlaceMatch(entry, n));
}
// Every teammate who could take this enquiry, in the settings table's order: those with a named
// destination/route that matches; only when nobody has one, those with a "*" for that kind. One
// entry per teammate. isStaff filters out anyone no longer on the team (or on leave).
// Returns [{email, rule, entry, wildcard}] — empty when nobody matches.
export function dsrMatchAll(cfg, ask, isStaff=()=>true){
  if(!cfg?.enabled || !ask || !DSR_KINDS.includes(ask.kind) || cfg.kinds?.[ask.kind]===false) return [];
  const field=RULE_FIELD[ask.kind];
  const named=[], wild=[];
  for(const [email, rule] of Object.entries(cfg.rules||{})){
    if(!isStaff(email)) continue;
    let hit=null, star=null;
    for(const entry of rule?.[field]||[]){
      if(str(entry)==='*'){ star=star||{email, rule, entry:'*', wildcard:true}; continue; }
      if(ruleMatches(ask.kind, entry, ask)){ hit={email, rule, entry, wildcard:false}; break; }
    }
    if(hit) named.push(hit); else if(star) wild.push(star);
  }
  return named.length?named:wild;
}
// The first of them (the settings order) — what the preview shows when there's no rotation.
export function dsrMatch(cfg, ask, isStaff=()=>true){
  return dsrMatchAll(cfg, ask, isStaff)[0]||null;
}
// Round robin between the teammates sharing a destination: one counter per kind + group of
// teammates (sorted, so the table's order doesn't matter). A new teammate joining or leaving the
// group starts a fresh rotation. turn = how many leads this group has had before this one.
export function dsrRotationKey(kind, hits){
  return `${kind}:${[...new Set((hits||[]).map(h=>str(h.email).toLowerCase()))].sort().join(',')}`;
}
export function dsrPickRoundRobin(hits, turn){
  if(!hits?.length) return null;
  const n=Number.isFinite(Number(turn))&&Number(turn)>=0?Math.floor(Number(turn)):0;
  return hits[n%hits.length];
}

// What the customer picked, as one label for messages and the lead ("Munnar", "Kochi → Dubai").
export function dsrDestinationLabel(ask){
  if(!ask) return '';
  if(ask.kind==='flight'){
    const n=s=>str(s?.name||s?.code);
    return n(ask.origin)&&n(ask.destination)?`${n(ask.origin)} → ${n(ask.destination)}`:n(ask.destination)||str(ask.label);
  }
  return str(ask.label||ask.destination);
}

// ── Messages ─────────────────────────────────────────────────────────────────────────────────────
export function dsrWaLink(phone, text=''){
  const d=digits(phone);
  if(!d) return '';
  return `https://wa.me/${d}${text?`?text=${encodeURIComponent(text)}`:''}`;
}
const firstName=n=>str(n).split(/\s+/)[0]||'';
// The last message on the main number. A custom text may use {{customer_name}}, {{destination}},
// {{service}}, {{staff_name}}, {{staff_phone}} and {{staff_link}}.
// The customer's opening line in the teammate's chat (pre-filled by the wa.me link).
function dsrHelloText({staffName='', destination='', business=''}={}){
  return `Hi ${staffName||''}, I enquired about ${destination||'a trip'}${business?` with ${business}`:''}.`.replace(/\s+/g, ' ');
}
// linkLine:false drops the default text's "chat with them directly 👉 link" line — used when the
// link goes out as a tappable WhatsApp button right after (dsrChatButton).
export function dsrCustomerText({customText='', customerName='', destination='', kind='', staffName='', staffPhone='', business='', linkLine=true}={}){
  const phone=digits(staffPhone);
  const link=phone?dsrWaLink(phone, dsrHelloText({staffName, destination, business})):'';
  if(str(customText)){
    return str(customText)
      .replace(/\{\{\s*customer_name\s*\}\}/gi, firstName(customerName)||'there')
      .replace(/\{\{\s*destination\s*\}\}/gi, destination||'your trip')
      .replace(/\{\{\s*service\s*\}\}/gi, DSR_KIND_LABEL[kind]||'trip')
      .replace(/\{\{\s*staff_name\s*\}\}/gi, staffName||'our travel expert')
      .replace(/\{\{\s*staff_phone\s*\}\}/gi, phone?`+${phone}`:'')
      .replace(/\{\{\s*staff_link\s*\}\}/gi, link)
      .trim();
  }
  const first=firstName(customerName);
  const who=staffName?`*${staffName}*`:'our travel expert';
  const lines=[`Thank you${first?` ${first}`:''}! 🙏`, '',
    `Your${destination?` *${destination}*`:''} enquiry is now with ${who}, our ${destination?`${destination} `:''}travel expert. They will message you on WhatsApp${phone?` from *+${phone}*`:''} shortly with the best options.`];
  if(link && linkLine) lines.push('', `You can also chat with them directly 👉 ${link}`);
  return lines.join('\n');
}
// The click-to-chat button sent with a hand-over when the chat is with a teammate: a WhatsApp
// cta_url message (body ≤1024, button title ≤20) opening the teammate's own WhatsApp with a
// pre-filled hello. null without a usable number.
export function dsrChatButton({staffName='', staffPhone='', destination='', business=''}={}){
  const phone=digits(staffPhone);
  if(phone.length<8 || phone.length>15) return null;
  const name=str(staffName);
  const label=name && !name.includes('@') ? name : '';
  const first=firstName(label);
  const button=first && `Chat with ${first}`.length<=20 ? `Chat with ${first}` : 'Chat on WhatsApp';
  const text=`💬 Chat directly with ${label?`*${label}*`:'your travel expert'} on WhatsApp (+${phone}). Tap the button below 👇`;
  return {text:text.slice(0, 1024), button, url:dsrWaLink(phone, dsrHelloText({staffName:label, destination, business})), phone};
}
// WhatsApp template parameters can't carry newlines, tabs, 4+ spaces in a row, or be empty.
function param(v, max=160){ return str(v).replace(/\s+/g, ' ').slice(0, max)||'-'; }
export function dsrStaffAlertParams({kind, customerName, customerPhone, destination, staffName='', business=''}){
  const d=digits(customerPhone);
  const hello=`Hi ${firstName(customerName)||'there'}, this is ${staffName||'your travel expert'}${business?` from ${business}`:''} about your ${destination||'trip'} enquiry.`;
  return [param(DSR_KIND_LABEL[kind]||'travel', 40), param(customerName||'New customer', 60), d?`+${d}`:'-', param(destination||'-', 80),
    param(d?dsrWaLink(d, hello):'-', 400)];
}
export function dsrStaffAlertText(params){
  const [kind, name, phone, dest, link]=params;
  return `📍 New ${kind} enquiry for you: ${name} (${phone}) chose ${dest}.\nMessage them on WhatsApp now 👉 ${link}`;
}
export function dsrCustomerTemplateParams({customerName, staffName, business, destination}){
  return [param(firstName(customerName)||'there', 40), param(staffName||'your travel expert', 60), param(business||'our team', 80), param(destination||'your trip', 80)];
}
// The private note on the main number's chat, so the team sees why the bot stopped.
export function dsrNoteText({kind, destination, staffName, staffEmail, staffPhone, alert='', intro=''}){
  const parts=[`📍 Destination routing: ${DSR_KIND_LABEL[kind]||'Enquiry'} — ${destination||'-'} → ${staffName||staffEmail}${staffPhone?` (+${digits(staffPhone)})`:''}.`,
    'The bot on this number is now silent for this customer; further communication is from the staff member\'s number.'];
  if(alert) parts.push(`Staff alert: ${alert}.`);
  if(intro) parts.push(`First message from the staff number: ${intro}.`);
  return parts.join(' ');
}

// Settings saved from the dashboard: only known fields, rules only for present teammates.
export function dsrSettingsPatch(body, current, isMember=()=>true){
  const next={...current};
  if('enabled' in body) next.enabled=body.enabled===true;
  if(body.kinds && typeof body.kinds==='object') next.kinds={...current.kinds, ...Object.fromEntries(DSR_KINDS.filter(k=>k in body.kinds).map(k=>[k, body.kinds[k]!==false]))};
  if(body.rules && typeof body.rules==='object'){
    const rules={};
    for(const [email, r] of Object.entries(body.rules)) if(isMember(str(email).toLowerCase())) rules[email]=r;
    next.rules=rules;
  }
  for(const k of ['customer_text','staff_template_name','staff_template_lang','customer_template_name','customer_template_lang']) if(k in body) next[k]=body[k];
  for(const k of ['notify_owner_too','start_from_staff_number']) if(k in body) next[k]=body[k]===true;
  return dsrNormalizeSettings(next);
}
