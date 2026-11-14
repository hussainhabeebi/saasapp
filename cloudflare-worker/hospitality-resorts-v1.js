// Hospitality style "Resorts V1" — a guided WhatsApp flow over the Agency module's
// Resorts & Hotels list (ta_properties), for hospitality clients who also have the Agency module on.
//
// Only clients whose hospitality_style is 'resorts_v1' (with Hospitality and Agency both enabled)
// ever reach this code. Hotel, Resort, Houseboat and H3 keep their own paths untouched.
//
//   1. Intro: the bot greets, names the locations of the active Resorts & Hotels in the text
//      ("We have resorts & hotels in Munnar, Wayanad and Vagamon") and lists them as tappable rows.
//      With fewer than two locations it goes straight to the resort list.
//   2. Location tap → the resorts & hotels in that location, each row showing its price range.
//   3. Resort tap → its photos (Photo 1–3, then a few from its Drive photos folder), then the
//      details with the PRICE RANGE only — never an exact price — and
//      "📅 Book now" / "↩ Other resorts" / "📍 Change location".
//   4. Book now (or "I want to book") → the chat is handed to a human agent and the bot stays silent
//      for that customer from then on (worker.js: engineHandoverSilenceTurn).
//
// Typed text works as well as taps: a location or resort name jumps to that step; questions go to
// the AI, whose resort data carries ranges only (rv1StripPrices is the last guard on its reply).
//
// Pure decisions only (no I/O) so they can be unit-tested; worker.js sends the messages.

import {H3_OTHER_LOCATION,H3_PRICE_Q_RE,h3LocKey,h3Locations,h3LocationTitle,h3Norm,h3Truncate,h3ExactName,
  h3MentionsName,h3WordsMatch,h3PageRows,h3HasStayPrice} from './hospitality-h3.js';
import {TA_RESORT_CATEGORY_LABEL,taPropertyMoney} from './ta-properties.js';

export const RV1_STYLE='resorts_v1';
export const RV1_NAV={
  changeLocation:'📍 Change location',
  otherResorts:'↩ Other resorts',
  allResorts:'🏨 All resorts',
  book:'📅 Book now',
  photos:'📸 More photos',
  video:'🎬 Video',
  brochure:'📄 Brochure',
};
const DESC_MAX=72;
const DETAILS_DESC_MAX=500;
export const RV1_PRICE_ON_REQUEST='Price on request';
export const RV1_NO_PRICE_NOTE='💬 Our booking team will share the price for your dates, room and meal plan when you book.';
export const RV1_EXACT_PRICE_NOTE='💬 This is the price range — the exact price for your dates, room and meal plan is confirmed by our booking team when you book.';
export const RV1_PRICE_NOTE='Each resort shows its price range — our booking team confirms the exact price for your dates when you book (tap 📅 Book now). 😊';
const PROPERTY_TYPE_LABEL={resort:'Resort',hotel:'Hotel',villa:'Villa',homestay:'Homestay',houseboat:'Houseboat',apartment:'Apartment',camp:'Camp',other:'Stay'};

const yes=v=>String(v||'').trim().toLowerCase()==='yes';
// A travel agency account: a travel industry, or the Agency / Travel module switched on.
function isAgency(c){
  const industry=String(c?.industry||'').trim().toLowerCase();
  return industry.includes('travel') || yes(c?.ta_enabled);
}
// Two ways in, both reading the Agency → Resorts & Hotels list:
//  • Hospitality clients: Hospitality on, Agency on, Settings → Hospitality → Sub-style "Resorts V1".
//  • Travel agencies: Travel Settings → 🧭 Chat Style "Resorts V1" (lt_chat_style).
export function rv1IsStyle(c){
  if(!c) return false;
  if(yes(c.hospitality_enabled) && yes(c.ta_enabled) && c.hospitality_style===RV1_STYLE) return true;
  return isAgency(c) && String(c.lt_chat_style||'').trim().toLowerCase()===RV1_STYLE;
}

export function rv1Active(properties){
  return (properties||[]).filter(p=>p && p.status!=='inactive' && String(p.name||'').trim());
}
// The resorts of one location (null = all), keeping the agency's own order (A–Z or manual).
export function rv1PropertiesIn(properties, locKey){
  return (properties||[]).filter(p=>locKey==null || h3LocKey(p.location)===locKey);
}
export function rv1UseLocationStep(locations){
  return (locations||[]).filter(l=>l.key).length>=2;
}

// The price range, built ONLY from numbers saved on the property in Resorts & Hotels — never
// made up. Price Range From / To when set; otherwise the lowest and highest of Price From,
// Season Rate and Off-season Rate. null when the property has no price at all.
export function rv1PriceBounds(p){
  const num=f=>{ const n=Number(p?.[f]); return Number.isFinite(n)&&n>0?n:null; };
  let lo=num('price_range_min'), hi=num('price_range_max');
  if(lo==null && hi==null){
    const vals=['price_from','season_price','off_season_price'].map(num).filter(n=>n!=null);
    if(!vals.length) return null;
    lo=Math.min(...vals); hi=Math.max(...vals);
  }
  return {lo, hi};
}
export function rv1RangeText(p){
  const b=rv1PriceBounds(p);
  if(!b) return '';
  const lo=taPropertyMoney(p?.currency, b.lo), hi=taPropertyMoney(p?.currency, b.hi);
  const unit=String(p?.price_unit||'per night').trim();
  if(lo&&hi) return lo===hi?`From ${lo} ${unit}`:`${lo} – ${hi} ${unit}`;
  if(lo) return `From ${lo} ${unit}`;
  return `Up to ${hi} ${unit}`;
}
export function rv1Range(p){
  return rv1RangeText(p)||RV1_PRICE_ON_REQUEST;
}
// The note under a price: range wording only when there is a price to show.
export function rv1PriceNote(p){
  return rv1RangeText(p)?RV1_EXACT_PRICE_NOTE:RV1_NO_PRICE_NOTE;
}
function stars(p){
  const n=Number(p?.star_rating)||0;
  return n>0?'⭐'.repeat(Math.min(7, n)):'';
}
function kindLabel(p){
  return TA_RESORT_CATEGORY_LABEL[p?.category]||PROPERTY_TYPE_LABEL[p?.property_type]||'Resort';
}
// List row line under a resort's name: its price range (never an exact price), then its kind.
export function rv1PropertyRowDesc(p){
  const parts=[rv1Range(p)];
  const k=[kindLabel(p), stars(p)].filter(Boolean).join(' ');
  if(k) parts.push(k);
  return h3Truncate(parts.join(' · '), DESC_MAX);
}
function oneLine(v, max){
  return String(v||'').replace(/\s*\n\s*/g, ', ').replace(/\s+/g, ' ').trim().slice(0, max);
}
export function rv1PhotoCaption(p){
  return `🏨 *${p.name}*${stars(p)?' '+stars(p):''}${p.location?`\n📍 ${String(p.location).trim()}`:''}`;
}
// The details message sent after a resort's photos: kind, location, price range, rooms,
// amenities, description. The only money in it is the range.
export function rv1DetailsText(p){
  const lines=[`🏨 *${p.name}*${stars(p)?' '+stars(p):''}`];
  if(p.location) lines.push(`📍 ${String(p.location).trim()}`);
  lines.push(`🏷️ ${kindLabel(p)}`);
  lines.push(`💰 Price range: *${rv1Range(p)}*`);
  if(p.room_types && String(p.room_types).trim()) lines.push(`🛏️ Rooms: ${oneLine(p.room_types, 200)}`);
  if(p.amenities && String(p.amenities).trim()) lines.push(`✨ Amenities: ${oneLine(p.amenities, 250)}`);
  const desc=String(p.description||'').replace(/\s+/g, ' ').trim();
  if(desc) lines.push('', desc.length>DETAILS_DESC_MAX?desc.slice(0, DETAILS_DESC_MAX-1).replace(/\s+\S*$/, '')+'…':desc);
  lines.push('', rv1PriceNote(p));
  return lines.join('\n');
}

function joinNames(names){
  const list=names.map(n=>`*${n}*`);
  if(list.length<=1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length-1]}`;
}
// Intro: greets and names the locations in the text (up to 8; "and more" after that).
export function rv1IntroText(biz, locations, {useLoc=true, count=0}={}){
  const hi=`Hi! 👋 Welcome to ${biz?`*${biz}*`:'us'}.`;
  const named=(locations||[]).filter(l=>l.key).map(l=>l.label);
  if(useLoc && named.length){
    const shown=named.slice(0, 8);
    const where=named.length>8?`${shown.map(n=>`*${n}*`).join(', ')} and more`:joinNames(shown);
    return `${hi}\n\nWe have handpicked resorts & hotels in ${where}. 🌴\n\nChoose a location to see the stays 👇`;
  }
  const one=named.length===1?` in *${named[0]}*`:'';
  return `${hi}\n\nHere ${count===1?'is our resort':'are our resorts & hotels'}${one} 🌴 Tap one for photos, details and the price range 👇`;
}
export function rv1PropertiesText(locLabel, n){
  return `🏨 ${n===1?'Our stay':'Our resorts & hotels'}${locLabel?` in *${locLabel}*`:''} — tap one for photos, details and the price range 👇`;
}
// Book now: a person takes over (price, availability, confirmation) and the bot goes silent.
export function rv1BookText(p){
  const what=p?`*${p.name}*`:'your stay';
  return `Great choice! 🎉 Our booking team will take it from here — they'll confirm availability and the exact price for ${what} shortly.\n\nTo speed things up, please send:\n1️⃣ Check-in date\n2️⃣ Check-out date\n3️⃣ Number of guests (adults & children)`;
}
// Answer to a price question: ranges only.
export function rv1PriceText({property=null, list=[], locLabel=''}){
  if(property) return `💰 *${property.name}* — price range: *${rv1Range(property)}*.\n\n${rv1PriceNote(property)}`;
  const lines=(list||[]).slice(0, 15).map(p=>`• ${p.name} — ${rv1Range(p)}`);
  return `💰 Price ranges${locLabel?` in *${locLabel}*`:''}:\n${lines.join('\n')||`• ${RV1_PRICE_ON_REQUEST}`}\n\n${RV1_EXACT_PRICE_NOTE}`;
}
// The photo links of a resort, in send order (Photo 1–3); the Drive folder is expanded by worker.js.
export function rv1PhotoUrls(p){
  return ['image_url','image_url_2','image_url_3'].map(f=>String(p?.[f]||'').trim()).filter(Boolean);
}
const hasFolder=p=>/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\//i.test(String(p?.photos_folder_url||''));
// The brochure PDF's key-fact boxes (up to 4, short) and its WhatsApp caption: name, location,
// price range (saved prices only) and the link to every photo (the Drive photos folder).
export function rv1BrochureFacts(p){
  const out=[];
  if(p?.location) out.push(['Location', String(p.location).trim()]);
  out.push(['Type', kindLabel(p)]);
  if(Number(p?.star_rating)>0) out.push(['Rating', `${Number(p.star_rating)}-star`]);
  out.push(['Price range', rv1Range(p)]);
  return out.slice(0, 4);
}
export function rv1BrochureCaption(p){
  const lines=[`📄 *${p.name}*${p?.location?` · ${String(p.location).trim()}`:''}`];
  lines.push(`💰 Price range: ${rv1Range(p)}`);
  if(hasFolder(p)) lines.push(`📸 All photos: ${String(p.photos_folder_url).trim()}`);
  return lines.join('\n');
}
// Every option offered under a resort's details, in order. (The brochure PDF already holds every
// photo, so there is no "More photos" option; an old chat's tap on it still works.) Up to 3 are WhatsApp reply buttons;
// more (a resort with a photos folder, video or brochure) become one list.
export function rv1PropertyOptions(p, {useLoc=true}={}){
  const out=[RV1_NAV.book];
  if(String(p?.video_url||'').trim()) out.push(RV1_NAV.video);
  if(String(p?.pdf_url||'').trim()) out.push(RV1_NAV.brochure);
  out.push(RV1_NAV.otherResorts);
  if(useLoc) out.push(RV1_NAV.changeLocation);
  return out.map(t=>({title:t, value:t}));
}

// "More locations · page 2" / "More resorts · page 2" rows (h3PageRows builds them).
export function rv1MoreTap(text){
  const m=String(text||'').trim().match(/^(?:more\s+)?(locations|resorts)\s*·\s*page\s*(\d+)$/i);
  return m?{kind:m[1].toLowerCase(), page:Number(m[2])}:null;
}
function navIs(text, key){
  const t=h3Norm(text);
  switch(key){
    case 'changeLocation': return /^(change|other|another|different|all)\s+(location|locations|destination|destinations|place|places)$/.test(t) || t==='locations';
    case 'otherResorts': return /^(other|another|more|different)\s+(resorts?|hotels?|properties|property|stays?|options?)$/.test(t);
    case 'allResorts': return /^(all|full|every|show\s+all|see\s+all|list\s+all)\s*(the\s+)?(resorts?|hotels?|properties|stays?|resorts\s+(and|&)\s+hotels|list)$/.test(t);
    case 'photos': return /^(more\s+)?(photos?|pics?|pictures?|images?|gallery)(\s+please|\s+pls)?$/.test(t) || /^(send|show)(\s+me)?(\s+more)?\s+(photos?|pics?|pictures?|images?)$/.test(t);
    case 'video': return /^(videos?|send\s+(the\s+)?video|show\s+(me\s+)?(the\s+)?video|tour\s+video)$/.test(t);
    case 'brochure': return /^(brochure|pdf|catalog(ue)?|send\s+(the\s+)?(brochure|pdf)|details\s+pdf)$/.test(t);
  }
  return false;
}
// "Book now", "book", "book it", "I want to book", "confirm booking", "book this resort"…
const RV1_BOOK_RE=/^(?:(?:ok(?:ay)?|yes|yeah|sure)\s+)?(?:i\s+(?:want|would\s+like|wanna|need|like)\s+to\s+|i\s+will\s+|please\s+|pls\s+|plz\s+|let\s+s\s+|can\s+you\s+|go\s+ahead\s+and\s+)?(?:book(?:ing)?|reserve|confirm(?:\s+(?:the\s+)?booking)?)(?:\s+(?:now|it|this|that|this\s+one|that\s+one|the\s+room|a\s+room|room|resort|this\s+resort|stay|please|pls|plz|for\s+me|confirm(?:ed)?))*$/;
export function rv1IsBookText(text){
  const t=h3Norm(text);
  return !!t && (RV1_BOOK_RE.test(t) || /^(?:booking\s+confirm(?:ed)?|confirm\s+(?:it|this|my\s+booking))$/.test(t));
}
// "book <resort name>" — the resort named after a booking word.
function bookWithName(text, list){
  const t=h3Norm(text);
  const m=t.match(/^(?:i\s+(?:want|would\s+like|wanna|need)\s+to\s+)?(?:book|reserve)\s+(.{3,})$/);
  if(!m) return null;
  return longestBy(list, p=>h3MentionsName(m[1], p.name)) || uniqueBy(list, p=>h3WordsMatch(m[1], p.name));
}

const RV1_GREETING_RE=/^(hi+|hello+|hey+|hai+|hlo|helo|hola|start|menu|restart|good\s+(morning|afternoon|evening|day)|namaste|namaskaram|salam|assalamu\s*alaikum|as+alam\w*)(\s+(there|team|sir|madam|mam))?[\s!.]*$/i;
const RV1_QUESTION_RE=/[?؟]|\b(?:what|which|when|where|why|how|who|is|are|does|do|did|can|could|will|would|should|any|tell|explain|include[sd]?|allowed|near|distance|far)\b/i;
const RV1_ENQUIRY_RE=/\b(rooms?|resorts?|propert(y|ies)|stays?|villas?|cottages?|hotels?|available|availability|options?|locations?|destinations?|packages?|tariffs?|rates?|prices?|photos?|pictures?|images?)\b/i;

function uniqueBy(list, pred){
  const hits=(list||[]).filter(pred);
  return hits.length===1?hits[0]:null;
}
function longestBy(list, pred){
  const hits=(list||[]).filter(pred);
  if(!hits.length) return null;
  return hits.sort((a, b)=>String(b.name).length-String(a.name).length)[0];
}

// The lead's saved choice, checked against what still exists (deactivated / renamed → dropped).
export function rv1Resolve({ctx={}, properties=[]}){
  const props=rv1Active(properties);
  const locs=h3Locations(props);
  const useLoc=rv1UseLocationStep(locs);
  const curProp=ctx.property ? props.find(p=>h3Norm(p.name)===h3Norm(ctx.property)) || null : null;
  let curLocKey=null;
  if(curProp) curLocKey=h3LocKey(curProp.location);
  else if(ctx.location){
    const k=h3Norm(ctx.location)===h3Norm(H3_OTHER_LOCATION) && !locs.some(l=>l.key===h3LocKey(ctx.location)) ? '' : h3LocKey(ctx.location);
    if(locs.some(l=>l.key===k)) curLocKey=k;
  }
  return {props, locs, useLoc, curProp, curLocKey};
}

// Options the guest can be pointing at, for the AI resolver in worker.js when no rule matched.
export function rv1AiCandidates({ctx={}, properties=[], max=150}){
  const r=rv1Resolve({ctx, properties});
  const inLoc=r.curLocKey!=null?rv1PropertiesIn(r.props, r.curLocKey):[];
  const out=[];
  for(const p of [...inLoc, ...r.props.filter(p=>!inLoc.includes(p))]) out.push({label:`Resort: ${p.name}`, action:{type:'property', propertyId:p.id}});
  if(r.useLoc) for(const l of r.locs.filter(l=>l.key)) out.push({label:`Location: ${l.label}`, action:{type:'properties', locKey:l.key, page:1}});
  return out.slice(0, max);
}

// Decides this turn's step. null = not part of the guided flow (the normal AI reply runs).
//   {type:'locations', page, intro}
//   {type:'properties', locKey, page, intro, resume}   locKey null = every resort
//   {type:'property', propertyId}
//   {type:'price', propertyId?, locKey?}
//   {type:'book', propertyId}                            propertyId null = nothing picked yet
// aiFirst:true on a step = the AI answers the question first, then the step is sent.
// ctx = the lead's saved {location, property} names.
export function rv1Decide({text, isNewLead=false, ctx={}, properties=[]}){
  const t=String(text||'').trim();
  if(!t) return null;
  const {props, locs, useLoc, curProp, curLocKey}=rv1Resolve({ctx, properties});
  if(!props.length) return null;
  const start=(intro=false)=>useLoc?{type:'locations', page:1, intro}:{type:'properties', locKey:null, page:1, intro};
  const toProps=(locKey, page=1, extra={})=>{
    if(!useLoc) return {type:'properties', locKey:null, page, ...extra};
    if(locKey==null || !locs.some(l=>l.key===locKey)) return {type:'locations', page:1};
    return {type:'properties', locKey, page, ...extra};
  };
  const inLoc=curLocKey!=null?rv1PropertiesIn(props, curLocKey):[];

  // 1. "More … · page N" rows.
  const more=rv1MoreTap(t);
  if(more){
    if(more.kind==='locations') return useLoc?{type:'locations', page:more.page}:start();
    // Paging through every resort (🏨 All resorts) keeps going through every resort.
    if(ctx.all || curLocKey==null) return {type:'properties', locKey:null, page:more.page, all:true};
    return toProps(curLocKey, more.page);
  }

  // 2. Navigation buttons and booking.
  if(h3ExactName(t, RV1_NAV.changeLocation) || navIs(t, 'changeLocation')) return useLoc?{type:'locations', page:1}:toProps(null);
  if(h3ExactName(t, RV1_NAV.allResorts) || navIs(t, 'allResorts')) return {type:'properties', locKey:null, page:1, all:true};
  if(h3ExactName(t, RV1_NAV.otherResorts) || navIs(t, 'otherResorts')) return toProps(curLocKey);
  for(const kind of ['photos', 'video', 'brochure']){
    if(curProp && (h3ExactName(t, RV1_NAV[kind]) || navIs(t, kind))) return {type:kind, propertyId:curProp.id};
  }
  if(h3ExactName(t, RV1_NAV.book) || rv1IsBookText(t)) return {type:'book', propertyId:curProp?curProp.id:null};
  const bookNamed=bookWithName(t, inLoc.length?[...inLoc, ...props.filter(p=>!inLoc.includes(p))]:props);
  if(bookNamed) return {type:'book', propertyId:bookNamed.id};

  // 3. Price questions: the range of what the guest names or is looking at.
  if(H3_PRICE_Q_RE.test(t) && t.split(/\s+/).length<=14){
    const named=longestBy(inLoc, p=>h3MentionsName(t, p.name)) || longestBy(props, p=>h3MentionsName(t, p.name));
    if(named) return {type:'price', propertyId:named.id};
    if(curProp) return {type:'price', propertyId:curProp.id};
    if(useLoc){
      const l=locs.filter(x=>x.key).find(x=>h3MentionsName(t, x.label));
      if(l) return {type:'price', locKey:l.key};
    }
    if(curLocKey!=null) return {type:'price', locKey:curLocKey};
    if(!useLoc) return {type:'price', locKey:null};
    return null; // nothing chosen yet — the AI answers with the ranges it has
  }

  // 4. A tap (or the whole message) naming a location or resort exactly.
  if(useLoc){
    const loc=locs.find(l=>h3ExactName(t, l.label) || h3ExactName(t, h3LocationTitle(l)));
    if(loc) return toProps(loc.key);
  }
  const tap=inLoc.find(p=>h3ExactName(t, p.name)) || props.find(p=>h3ExactName(t, p.name));
  if(tap) return {type:'property', propertyId:tap.id};

  // 5. A question is the AI's to answer; the matching step follows its answer when it names one.
  if(RV1_QUESTION_RE.test(t) && t.split(/\s+/).length>2){
    const p=longestBy(inLoc, x=>h3MentionsName(t, x.name)) || longestBy(props, x=>h3MentionsName(t, x.name));
    if(p) return {type:'property', propertyId:p.id, aiFirst:true};
    if(useLoc){
      const l=locs.filter(x=>x.key).find(x=>h3MentionsName(t, x.label));
      if(l) return {...toProps(l.key), aiFirst:true};
    }
    if(isNewLead) return {...start(false), aiFirst:true};
    return null;
  }

  // 6. Typed text naming a resort or location, then short forms ("bay view", "bluebell").
  const mention=longestBy(inLoc, p=>h3MentionsName(t, p.name)) || longestBy(props, p=>h3MentionsName(t, p.name));
  if(mention) return {type:'property', propertyId:mention.id};
  if(useLoc){
    const l=locs.filter(x=>x.key).find(x=>h3MentionsName(t, x.label));
    if(l) return toProps(l.key);
  }
  const short=uniqueBy(inLoc, p=>h3WordsMatch(t, p.name)) || uniqueBy(props, p=>h3WordsMatch(t, p.name));
  if(short) return {type:'property', propertyId:short.id};
  if(useLoc){
    const l=uniqueBy(locs.filter(x=>x.key), x=>h3WordsMatch(t, x.label));
    if(l) return toProps(l.key);
  }

  // 7. Greetings and first enquiries start (or resume) the flow.
  if(RV1_GREETING_RE.test(t)){
    if(!isNewLead && useLoc && curLocKey!=null) return toProps(curLocKey, 1, {resume:true});
    return start(true);
  }
  if(isNewLead) return start(true);
  if(!ctx.location && !ctx.property && RV1_ENQUIRY_RE.test(t) && t.split(/\s+/).length<=4) return start();
  return null;
}

// Last guard on AI replies: a sentence pairing money with a stay is kept only when every amount in
// it is one of the resorts' range bounds; anything else (an exact price the AI made up or took from
// elsewhere) is dropped, and the reply says once that ranges are shown and the team gives the price.
function amounts(s){
  return (String(s).match(/\d[\d,]*(?:\.\d+)?/g)||[]).map(x=>Number(x.replace(/,/g, ''))).filter(n=>n>=100);
}
const RV1_OTHER_PRICE_RE=/\b(?:packages?|flights?|tickets?|air\s*fares?|fares?|visas?|tours?|umrah|hajj|cruises?|transfers?|cabs?|taxis?|insurance)\b/i;
export function rv1StripPrices(text, properties=[]){
  const src=String(text||'');
  if(!src.trim()) return src;
  const props=rv1Active(properties);
  const names=props.map(p=>p.name);
  const allowed=new Set();
  for(const p of props){ const b=rv1PriceBounds(p); if(b){ if(b.lo) allowed.add(b.lo); if(b.hi) allowed.add(b.hi); } }
  const namesResort=s=>names.some(n=>h3MentionsName(s, n));
  const bad=s=>{
    if(!h3HasStayPrice(s, names)) return false;
    // A travel agency's package / flight / visa prices are theirs to quote — only stay prices
    // (or a price next to one of the listed resorts) are guarded.
    if(RV1_OTHER_PRICE_RE.test(s) && !namesResort(s)) return false;
    const nums=amounts(s);
    return !nums.length || !nums.every(n=>allowed.has(n));
  };
  let removed=false;
  const lines=src.split('\n').map(line=>{
    if(!bad(line)) return line;
    const parts=line.match(/[^.!?]+[.!?]*\s*/g)||[line];
    const kept=parts.filter(p=>!bad(p));
    removed=true;
    const out=kept.join('').trim();
    return (!out || /^\s*(?:[-*•]|\d+[.)])\s*$/.test(out)) ? null : out;
  }).filter(l=>l!==null);
  if(!removed) return src;
  let out=lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if(!out.includes(RV1_PRICE_NOTE)) out=out?`${out}\n\n${RV1_PRICE_NOTE}`:RV1_PRICE_NOTE;
  return out;
}

// The AI's verified resort data for this style: every resort with its range (no exact prices),
// the location / resort the guest is looking at first.
export function rv1AiContext(properties, {location='', property=''}={}){
  const props=rv1Active(properties);
  if(!props.length) return '';
  const locKey=location?h3LocKey(location):null;
  const ordered=[...props].sort((a, b)=>{
    const rank=p=>(property && h3Norm(p.name)===h3Norm(property))?0:(locKey!=null && h3LocKey(p.location)===locKey)?1:2;
    return rank(a)-rank(b);
  }).slice(0, 40);
  const lines=['', '', '## Resorts & Hotels (verified — the ONLY stays we offer)'];
  const locs=h3Locations(props).filter(l=>l.key).map(l=>l.label);
  if(locs.length) lines.push(`Locations: ${locs.join(', ')}`);
  if(property) lines.push(`The customer is looking at: ${property}`);
  else if(location) lines.push(`The customer is browsing: ${location}`);
  for(const p of ordered){
    let line=`- ${p.name} (${kindLabel(p)}${Number(p.star_rating)>0?`, ${p.star_rating}-star`:''})`;
    if(p.location) line+=` — ${String(p.location).trim()}`;
    line+=` — price range: ${rv1Range(p)}`;
    if(p.room_types) line+=` — rooms: ${oneLine(p.room_types, 150)}`;
    if(p.amenities) line+=` — amenities: ${oneLine(p.amenities, 150)}`;
    if(p.description) line+=` — ${oneLine(p.description, 200)}`;
    lines.push(line);
  }
  lines.push('PRICE RULE (strict): the price ranges above come straight from our Resorts & Hotels records and are the ONLY prices you may mention. Copy a range exactly as written for the resort it belongs to — never give an exact price, a per-night rate, a total, an estimate, a discount, a currency conversion or a range for a resort not in this list. A resort marked "Price on request" has no price: say our booking team will share it. Say our booking team confirms the exact price for the guest\'s dates when they book. Only recommend resorts from this list; it overrides any other source about which stays or destinations we offer. Never invent facts (amenities, rooms, distances, availability) that are not written above — if it is not listed, say our team will confirm. Photos are sent by the system when the guest picks a resort — never say you cannot send photos.');
  return lines.join('\n');
}
