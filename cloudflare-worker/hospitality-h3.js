// Hospitality style "H3" — a guided WhatsApp flow: Location → Property → Room → Book.
//
// Only clients whose hospitality_style is 'h3' ever reach this code. Hotel, Resort and Houseboat
// keep their own paths in worker.js untouched.
//
//   1. Intro: the bot greets and lists the locations of the active properties as tappable rows
//      ("Munnar (12)"). Skipped when the location step is switched off in Hospitality Settings
//      (hospitality_h3_locations='off') or when there are fewer than two locations — then the
//      bot starts at the property list.
//   2. Location tap → the properties in that location, as a list with "From ₹… · amenities".
//   3. Property tap → a photo of each room with its capacity and rate, then the room list.
//   4. Room tap → the room's photos and details, then "📅 Book now" / "↩ Other rooms" /
//      "📍 Change location".
//   5. Book now → Hospitality Pro's quote flow when Pro is on (it catches "book" before this
//      module runs); otherwise the bot asks for dates and guests and the AI carries on with the
//      chosen room as context.
//
// Typed text works as well as taps: "Munnar", a property name or a room name jumps straight to
// that step. Anything this module doesn't recognise returns null and the normal AI reply runs.
//
// This file holds the pure decisions (no I/O) so they can be unit-tested; worker.js sends the
// messages and saves the chosen location / property / room on the lead.

export const H3_STYLE='h3';
export const H3_NAV={
  changeLocation:'📍 Change location',
  otherProperties:'↩ Other properties',
  otherRooms:'↩ Other rooms',
  book:'📅 Book now',
};
export const H3_OTHER_LOCATION='Other';
const LIST_MAX=10;      // WhatsApp list rows
const TITLE_MAX=24;     // WhatsApp list row title
const BUTTON_MAX=20;    // WhatsApp reply button title
const DESC_MAX=72;      // WhatsApp list row description

export function h3IsStyle(c){
  return !!c && c.hospitality_enabled==='Yes' && c.hospitality_style===H3_STYLE;
}
// The location step is on unless switched off in Hospitality Settings.
export function h3LocationStepOn(c){
  return String(c?.hospitality_h3_locations||'on').toLowerCase()!=='off';
}

// Same key worker.js uses for resort locations: the first comma part, so "Munnar, Kerala" and a
// hand-typed "Munnar" are one location.
export function h3LocKey(loc){
  return String(loc||'').split(',')[0].trim().toLowerCase();
}
function h3LocLabel(loc){
  return String(loc||'').split(',')[0].trim().replace(/\s+/g, ' ');
}
export function h3Norm(s){
  return String(s||'').toLowerCase().normalize('NFC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}
// Mirrors engineTruncateButtonTitle in worker.js — WhatsApp echoes a tapped row's (possibly cut)
// title back as the message text, so a cut title must still resolve to its full name.
export function h3Truncate(title, cap){
  const t=String(title||'').trim();
  if(t.length<=cap) return t;
  const slice=t.slice(0, cap-1);
  const lastSpace=slice.lastIndexOf(' ');
  const cut=lastSpace>Math.floor(cap*0.4) ? slice.slice(0, lastSpace) : slice;
  return cut.trimEnd();
}
function natCmp(a, b){
  return String(a).localeCompare(String(b), undefined, {numeric:true, sensitivity:'base'});
}

// Distinct locations of the given (active) properties: [{key, label, count}], A–Z, with the
// properties that have no location grouped last as "Other" (key '').
export function h3Locations(properties){
  const map=new Map();
  for(const p of properties||[]){
    const key=h3LocKey(p.location);
    if(!map.has(key)) map.set(key, {key, label:key?h3LocLabel(p.location):H3_OTHER_LOCATION, count:0});
    map.get(key).count++;
  }
  const list=[...map.values()];
  list.sort((a, b)=>(a.key==='')-(b.key==='') || natCmp(a.label, b.label));
  return list;
}
// Location step only when switched on and there is a real choice (two or more named locations).
export function h3UseLocationStep(stepOn, locations){
  return !!stepOn && (locations||[]).filter(l=>l.key).length>=2;
}
export function h3PropertiesIn(properties, locKey){
  const list=(properties||[]).filter(p=>locKey==null || h3LocKey(p.location)===locKey);
  return list.sort((a, b)=>natCmp(a.name, b.name));
}
export function h3RoomsOf(units, property){
  const list=(units||[]).filter(u=>property ? Number(u.property_id)===Number(property.id) : true);
  return list.sort((a, b)=>natCmp(a.name, b.name));
}

function money(cur, n){
  const v=Number(n);
  if(!(v>0)) return '';
  const c=String(cur||'INR').toUpperCase();
  const sym=c==='INR'?'₹':(c==='USD'?'$':(c==='AED'?'AED ':c+' '));
  return `${sym}${v.toLocaleString('en-IN')}`;
}
export function h3LocationTitle(loc){
  const withCount=`${loc.label} (${loc.count})`;
  return withCount.length<=TITLE_MAX ? withCount : h3Truncate(loc.label, TITLE_MAX);
}
export function h3PropertyDesc(p, units){
  const rates=h3RoomsOf(units, p).map(u=>Number(u.base_rate)).filter(v=>v>0);
  const cur=(h3RoomsOf(units, p).find(u=>Number(u.base_rate)>0)||{}).currency;
  const parts=[];
  if(rates.length) parts.push(`From ${money(cur, Math.min(...rates))}`);
  if(p.amenities && String(p.amenities).trim()) parts.push(String(p.amenities).trim());
  return h3Truncate(parts.join(' · '), DESC_MAX);
}
export function h3RoomDesc(u){
  const parts=[];
  const a=Number(u.capacity_adults)||0, k=Number(u.capacity_children)||0;
  if(a) parts.push(`${a} adult${a===1?'':'s'}${k?` + ${k} child${k===1?'':'ren'}`:''}`);
  const r=money(u.currency, u.base_rate);
  if(r) parts.push(`${r}/night`);
  if(u.unit_type && String(u.unit_type).trim()) parts.push(String(u.unit_type).trim());
  return h3Truncate(parts.join(' · '), DESC_MAX);
}
export function h3RoomCaption(u){
  const lines=[`*${u.name}*`];
  const d=h3RoomDesc(u);
  if(d) lines.push(d);
  return lines.join('\n');
}

// Pages rows into one WhatsApp list: up to 10 rows including the navigation rows. Longer lists
// show what fits plus a "More <kind> · page N" row (wrapping back to page 1 after the last page).
export function h3PageRows(rows, kind, page=1, navRows=[]){
  const all=rows||[], nav=navRows||[];
  if(all.length+nav.length<=LIST_MAX) return {rows:[...all, ...nav], page:1, pages:1};
  const per=Math.max(1, LIST_MAX-1-nav.length);
  const pages=Math.ceil(all.length/per);
  const p=Math.min(Math.max(1, Math.floor(Number(page))||1), pages);
  const next=p<pages?p+1:1;
  let label=`More ${kind} · page ${next}`;
  if(label.length>TITLE_MAX) label=`${kind[0].toUpperCase()}${kind.slice(1)} · page ${next}`;
  return {rows:[...all.slice((p-1)*per, p*per), {title:label, value:label}, ...nav], page:p, pages};
}
export function h3MoreTap(text){
  const m=String(text||'').trim().match(/^(?:more\s+)?(locations|properties|rooms)\s*·\s*page\s*(\d+)$/i);
  return m?{kind:m[1].toLowerCase(), page:Number(m[2])}:null;
}

// Tap / typed text that names exactly this item (whole text, ignoring emoji and a trailing count),
// including a WhatsApp-cut title.
function tapCore(text){
  return h3Norm(String(text||'').replace(/\s*\(\d+\)\s*$/, '').replace(/(?:…|\.\.\.)\s*$/, ''));
}
export function h3ExactName(text, name){
  const core=tapCore(text), n=h3Norm(name);
  if(!core || !n) return false;
  if(core===n) return true;
  for(const cap of [TITLE_MAX, BUTTON_MAX]){
    const cut=h3Norm(h3Truncate(name, cap));
    if(cut.length>=4 && cut!==n && core===cut) return true;
  }
  return false;
}
// Typed text that mentions the name as whole words ("rooms at bay view suites please").
export function h3MentionsName(text, name){
  const n=h3Norm(name);
  if(n.length<4) return false;
  return ` ${h3Norm(text)} `.includes(` ${n} `);
}
function navIs(text, key){
  const t=h3Norm(text);
  switch(key){
    case 'changeLocation': return /^(change|other|another|different|all)\s+(location|locations|destination|destinations|place|places)$/.test(t) || t==='locations';
    case 'otherProperties': return /^(other|another|all|more|different)\s+(properties|property|resorts|resort|hotels|stays)$/.test(t);
    case 'otherRooms': return /^(other|another|all|different)\s+(rooms|room|units|villas)$/.test(t);
    case 'book': return /^(book now|book|book this|book it|i want to book|book this room)$/.test(t);
  }
  return false;
}
const H3_GREETING_RE=/^(hi+|hello+|hey+|hai+|hlo|helo|hola|start|menu|restart|good\s+(morning|afternoon|evening|day)|namaste|namaskaram|salam|assalamu\s*alaikum|as+alam\w*)(\s+(there|team|sir|madam|mam))?[\s!.]*$/i;
const H3_ENQUIRY_RE=/\b(rooms?|resorts?|propert(y|ies)|stays?|villas?|cottages?|hotels?|available|availability|options?|locations?|destinations?|packages?|book(ing)?|tariffs?|rates?|prices?|photos?|pictures?|images?)\b/i;

function uniqueBy(list, pred){
  const hits=(list||[]).filter(pred);
  return hits.length===1?hits[0]:null;
}
function longestBy(list, pred){
  const hits=(list||[]).filter(pred);
  if(!hits.length) return null;
  return hits.sort((a, b)=>String(b.name).length-String(a.name).length)[0];
}

// Decides this turn's H3 step. Returns null when the message isn't part of the guided flow (the
// normal AI reply then runs), otherwise one of:
//   {type:'locations', page, intro}
//   {type:'properties', locKey, page, resume}   locKey null = all properties
//   {type:'rooms', propertyId, page}             propertyId null = all rooms (no properties set up)
//   {type:'room', unitId}
//   {type:'book', unitId}
// ctx = the lead's saved {location, property, unit} names.
export function h3Decide({text, isNewLead=false, ctx={}, properties=[], units=[], locationStep=true}){
  const t=String(text||'').trim();
  if(!t) return null;
  const props=properties||[], rooms=units||[];
  const locs=h3Locations(props);
  const useLoc=h3UseLocationStep(locationStep, locs);
  const start=(intro=false)=>{
    if(!props.length) return rooms.length?{type:'rooms', propertyId:null, page:1, intro}:null;
    return useLoc?{type:'locations', page:1, intro}:{type:'properties', locKey:null, page:1, intro};
  };
  const toProps=(locKey, page=1, extra={})=>{
    if(!useLoc) return {type:'properties', locKey:null, page, ...extra};
    if(locKey==null || !locs.some(l=>l.key===locKey)) return {type:'locations', page:1};
    return {type:'properties', locKey, page, ...extra};
  };

  // What the lead picked before — ignored when it no longer exists (deactivated / renamed).
  const curProp=ctx.property ? props.find(p=>h3Norm(p.name)===h3Norm(ctx.property)) || null : null;
  let curLocKey=null;
  if(curProp) curLocKey=h3LocKey(curProp.location);
  else if(ctx.location){
    const k=h3Norm(ctx.location)===h3Norm(H3_OTHER_LOCATION) && !locs.some(l=>l.key===h3LocKey(ctx.location)) ? '' : h3LocKey(ctx.location);
    if(locs.some(l=>l.key===k)) curLocKey=k;
  }
  const scopeRooms=curProp?h3RoomsOf(rooms, curProp):(props.length?[]:rooms);
  const curUnit=ctx.unit ? (scopeRooms.find(u=>h3Norm(u.name)===h3Norm(ctx.unit)) || uniqueBy(rooms, u=>h3Norm(u.name)===h3Norm(ctx.unit))) : null;

  // 1. "More … · page N" rows.
  const more=h3MoreTap(t);
  if(more){
    if(more.kind==='locations') return useLoc?{type:'locations', page:more.page}:start();
    if(more.kind==='properties') return toProps(curLocKey, more.page);
    if(curProp) return {type:'rooms', propertyId:curProp.id, page:more.page};
    return props.length?start():{type:'rooms', propertyId:null, page:more.page};
  }

  // 2. Navigation buttons.
  if(h3ExactName(t, H3_NAV.changeLocation) || navIs(t, 'changeLocation')) return useLoc?{type:'locations', page:1}:toProps(null);
  if(h3ExactName(t, H3_NAV.otherProperties) || navIs(t, 'otherProperties')) return toProps(curLocKey);
  if(h3ExactName(t, H3_NAV.otherRooms) || navIs(t, 'otherRooms')) return curProp?{type:'rooms', propertyId:curProp.id, page:1}:start();
  if(h3ExactName(t, H3_NAV.book) || navIs(t, 'book')){
    if(curUnit) return {type:'book', unitId:curUnit.id};
    return null; // "book" with nothing chosen — let the AI / Pro answer it.
  }

  // 3. A tap (or the whole message) naming a location, room or property exactly.
  if(useLoc){
    const loc=locs.find(l=>h3ExactName(t, l.label) || h3ExactName(t, h3LocationTitle(l)));
    if(loc) return toProps(loc.key);
  }
  const roomTap=scopeRooms.find(u=>h3ExactName(t, u.name));
  if(roomTap) return {type:'room', unitId:roomTap.id};
  const inLoc=curLocKey!=null?h3PropertiesIn(props, curLocKey):[];
  const propTap=inLoc.find(p=>h3ExactName(t, p.name)) || props.find(p=>h3ExactName(t, p.name));
  if(propTap) return {type:'rooms', propertyId:propTap.id, page:1};
  const anyRoomTap=uniqueBy(rooms, u=>h3ExactName(t, u.name));
  if(anyRoomTap) return {type:'room', unitId:anyRoomTap.id};

  // 4. Typed text that mentions one by name.
  const propMention=longestBy(inLoc, p=>h3MentionsName(t, p.name)) || longestBy(props, p=>h3MentionsName(t, p.name));
  if(propMention) return {type:'rooms', propertyId:propMention.id, page:1};
  const roomMention=longestBy(scopeRooms, u=>h3MentionsName(t, u.name));
  if(roomMention) return {type:'room', unitId:roomMention.id};
  if(useLoc){
    const locMention=locs.filter(l=>l.key).find(l=>h3MentionsName(t, l.label));
    if(locMention) return toProps(locMention.key);
  }

  // 5. Greetings and first enquiries start (or resume) the flow.
  if(H3_GREETING_RE.test(t)){
    if(!isNewLead && useLoc && curLocKey!=null) return toProps(curLocKey, 1, {resume:true});
    return start(true);
  }
  if(isNewLead) return start(true);
  if(!ctx.location && !ctx.property && !ctx.unit && H3_ENQUIRY_RE.test(t) && t.split(/\s+/).length<=8) return start();
  return null;
}
