// Chats → ✨ AI Itinerary for Hospitality accounts (hospitality_enabled='Yes'): the agent picks one
// of the account's properties (and optionally a room), fills in the guest profile and the stay
// dates, and the AI drafts a day-by-day *stay* plan — check-in, on-property experiences from the
// property's own amenities, and well-known sightseeing around its location, check-out on the last
// day. The draft shows in the chat with photos (the property's and room's own photos, plus a
// Wikimedia photo per day's place); "Approve & send" puts a PDF with those photos into the chat.
//
// The parse / retry / Wikimedia photo steps are the travel ones (travel-ai-itinerary.js); this
// module only supplies the stay prompt and the property → package-like shape they read.
// No price is ever written: the booking team gives the price personally, as in the H3 bot flow.

import {taAiItinerary,taAiTraveller,TA_AI_PACES,TA_AI_MAX_DAYS} from './travel-ai-itinerary.js';

const str=(v,max)=>String(v??'').replace(/\s+/g,' ').trim().slice(0,max);
export const HOSP_AI_MAX_NIGHTS=TA_AI_MAX_DAYS-1;
export const HOSP_AI_IMAGE_FIELDS=['image_url_1','image_url_2','image_url_3','image_url_4','image_url_5'];

export function hospAiNights(v){
  const n=parseInt(v,10);
  return Math.min(HOSP_AI_MAX_NIGHTS,Math.max(1,Number.isFinite(n)&&n>0?n:2));
}
// YYYY-MM-DD or '' — and the check-out date that many nights later.
export function hospAiDate(v){
  const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v||'').trim());
  if(!m)return '';
  const d=new Date(Date.UTC(+m[1],+m[2]-1,+m[3]));
  return Number.isNaN(d.getTime())||d.toISOString().slice(0,10)!==m[0]?'':m[0];
}
export function hospAiCheckOut(checkIn,nights){
  const d=hospAiDate(checkIn);
  if(!d)return '';
  const t=new Date(d+'T00:00:00Z');t.setUTCDate(t.getUTCDate()+hospAiNights(nights));
  return t.toISOString().slice(0,10);
}
export const hospAiPhotos=row=>HOSP_AI_IMAGE_FIELDS.map(f=>str(row?.[f],1000)).filter(u=>/^https?:\/\//i.test(u));

// The property (+ room) as the package shape the travel itinerary code reads. No price fields.
export function hospAiStayPkg(property,room,nights){
  const loc=str(property?.location,200);
  return {
    name:str(property?.name,200),
    destination:loc,
    nights:hospAiNights(nights),
    type:'stay',
    // Amenities go to the AI in the prompt and on the PDF's "Your Stay" cards — not as a
    // "What's Included" list, since an amenity isn't necessarily part of the guest's booking.
    inclusions:'',exclusions:'',notes:'',
  };
}

// Guest profile: pax mix, kids' ages, pace and interests (same rules as the travel profile; a stay
// has no multi-city route, so destinations are dropped).
export function hospAiGuest(g){
  const t=taAiTraveller(g);
  return {...t,destinations:[]};
}

export function hospAiItineraryPrompt(property,room,{nights,guest,checkIn}={}){
  const n=hospAiNights(nights),days=n+1;
  const t=hospAiGuest(guest);
  const pname=str(property?.name,200)||'the property';
  const loc=str(property?.location,200);
  const rules=[];
  if(t.pace)rules.push(`- Pace: ${TA_AI_PACES[t.pace]}.`);
  if(t.interests.length)rules.push('- Favour experiences matching the Interests; still include the area\'s best-known sights.');
  if(t.children||t.infants)rules.push('- The guests include children/infants: keep days family-friendly, with short drives, rest time and early evenings; note age/height limits where an attraction has them.');
  const system=`You are the guest-relations manager of ${pname}${loc?`, ${loc}`:''}, writing a warm, customer-facing, day-by-day itinerary for a guest's stay. Write in clear, friendly English. Respond with ONLY compact JSON, no commentary, in exactly this shape:
{"days":[{"title":"short day title, max 8 words","description":"1-2 short sentences describing the day","overnight":"${pname.replace(/"/g,"'")} for every night, empty string on the last day","meals":["B","L","D" — only meals the property's amenities/inclusions say are included that day],"items":[{"type":"one of: hotel, activity, transfer, meal, note","time":"HH:MM 24h or empty string","description":"one line, max 15 words","place":"name of the landmark/attraction for a photo search, or empty string"}]}]}
Rules:
- Exactly ${days} days (${n} night${n>1?'s':''}). Day 1 is arrival and check-in at ${pname}; the last day is check-out and departure.
- Every night is spent at ${pname} — never suggest another hotel, resort or property.
- Mix relaxed time at the property (use ONLY the amenities listed — never invent a spa, pool, restaurant or activity it doesn't list) with real, well-known sightseeing, nature and food experiences in and around ${loc||'the property\'s area'} within an easy day trip.
- Never give any price, rate, discount or total — the booking team gives the price personally. Never invent phone numbers, opening hours or ticket prices.
- "place" is set for every "activity" item that is a real, named attraction or area near the property (e.g. "Eravikulam National Park"), using its well-known English name — it is used to find a photo. Leave it empty for on-property items.
- Tailor the plan to the guest profile (Guests, Pace, Interests) when it is given.${rules.length?'\n'+rules.join('\n'):''}`;
  const pax=[t.adults&&`${t.adults} adult${t.adults>1?'s':''}`,
    t.children&&`${t.children} child${t.children>1?'ren':''}${t.child_ages.length?` (age${t.child_ages.length>1?'s':''} ${t.child_ages.join(', ')})`:''}`,
    t.infants&&`${t.infants} infant${t.infants>1?'s':''}`].filter(Boolean).join(', ');
  const facts=[
    ['Property',pname],['Location',loc],
    ['About the property',str(property?.description,1500)],
    ['Property amenities',str(property?.amenities,1500)],
    ['Room',str(room?.name,200)],['Room type',str(room?.unit_type,80)],
    ['Room amenities',str(room?.amenities,800)],['About the room',str(room?.description,800)],
    ['Nights',String(n)],['Check-in date',hospAiDate(checkIn)],
    ['Guests',pax],['Pace',t.pace?TA_AI_PACES[t.pace]:''],['Interests',t.interests.join('; ')],
  ].filter(([,v])=>v).map(([k,v])=>`${k}: ${v}`).join('\n');
  return {system,user:facts};
}

// The whole draft: (system,user) → model text generator injected, like taAiItinerary.
export async function hospAiItinerary(property,room,generate,opts={}){
  if(!str(property?.name,200))return {error:'This property has no name yet.'};
  const pkg=hospAiStayPkg(property,room,opts.nights);
  const prompt=hospAiItineraryPrompt(property,room,opts);
  const out=await taAiItinerary(pkg,generate,{...opts,prompt});
  if(out.error)return out;
  // Property photos are shown on their own; the PDF draws Wikimedia place photos per day.
  out.days.forEach(d=>{d.image_links=[];});
  return out;
}

// Guest line for the PDF's key facts ("2 adults, 1 child").
export function hospAiGuestLine(g){
  const t=hospAiGuest(g);
  return [t.adults&&`${t.adults} adult${t.adults>1?'s':''}`,t.children&&`${t.children} child${t.children>1?'ren':''}`,
    t.infants&&`${t.infants} infant${t.infants>1?'s':''}`].filter(Boolean).join(', ');
}

// "20-22 Dec 2026", or "30 Dec - 2 Jan" across months — short enough for a key-fact box.
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export function hospAiDateRange(from,to){
  const [fy,fm,fd]=from.split('-').map(Number),[ty,tm,td]=to.split('-').map(Number);
  if(fy===ty&&fm===tm)return `${fd}-${td} ${MONTHS[fm-1]} ${fy}`;
  return `${fd} ${MONTHS[fm-1]} - ${td} ${MONTHS[tm-1]}`;
}
// Key-fact boxes for the PDF (at most 4 are drawn): location, stay length, dates, guests.
export function hospAiStayFacts(property,room,{nights,checkIn,guest}={}){
  const n=hospAiNights(nights),cin=hospAiDate(checkIn);
  return [
    ['Location',str(property?.location,120)],
    ['Stay',`${n} night${n>1?'s':''} / ${n+1} days`],
    ['Dates',cin?hospAiDateRange(cin,hospAiCheckOut(cin,n)):''],
    ['Guests',hospAiGuestLine(guest)],
    ['Room',str(room?.name,80)],
  ].filter(f=>f[1]).slice(0,4);
}
export const HOSP_AI_FOOTNOTE='Rooms are subject to availability at the time of booking. Our team confirms your dates and gives you the price personally when you book.';
export function hospAiPdfName(property){
  return `Stay-Itinerary-${String(property?.name||'stay').replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'').slice(0,60)||'stay'}.pdf`;
}

// ── Agency "Resorts & Hotels" (ta_properties) in the same picker ──
// A travel agency's Resorts & Hotels list is offered next to the Hospitality module's properties.
// Its rows get an "a-<id>" id (Hospitality properties keep their plain number) and are reshaped
// to the hospitality_properties columns the prompt, photos and PDF read. Its "room_types" text
// ("Deluxe, Pool Villa" or one per line) becomes the room choices, as "a-<id>-r<n>" — no photos.
export const HOSP_AI_AGENCY_PREFIX='a-';
export function hospAiParseId(id){
  const s=String(id??'').trim();
  const m=/^a-(\d+)(?:-r(\d+))?$/.exec(s);
  if(m)return {source:'agency',id:Number(m[1]),room:m[2]?Number(m[2]):0};
  return /^\d+$/.test(s)?{source:'hospitality',id:Number(s),room:0}:null;
}
const TYPE_LABEL={resort:'Resort',hotel:'Hotel',villa:'Villa',homestay:'Homestay',houseboat:'Houseboat',apartment:'Apartment',camp:'Camp'};
export function hospAiAgencyProperty(p){
  const type=String(p?.property_type||'').toLowerCase();
  const stars=Number(p?.star_rating)||0;
  return {
    id:HOSP_AI_AGENCY_PREFIX+p.id,source:'agency',
    name:str(p?.name,200),location:str(p?.location,200),
    description:[stars?`${stars}-star ${TYPE_LABEL[type]||'property'}.`:TYPE_LABEL[type]?`${TYPE_LABEL[type]}.`:'',str(p?.description,1400)].filter(Boolean).join(' '),
    amenities:str(p?.amenities,1500),
    image_url_1:str(p?.image_url,1000),image_url_2:str(p?.image_url_2,1000),image_url_3:str(p?.image_url_3,1000),
    photos_folder_url:str(p?.photos_folder_url,1000),
    property_type:type,
  };
}
export function hospAiAgencyRooms(p){
  const seen=new Set();
  return String(p?.room_types||'').split(/\n|,|;|\|/).map(x=>str(x,120)).filter(x=>{const k=x.toLowerCase();if(!x||seen.has(k))return false;seen.add(k);return true;})
    .slice(0,20).map((name,i)=>({id:`${HOSP_AI_AGENCY_PREFIX}${p.id}-r${i+1}`,name,unit_type:'',amenities:'',description:''}));
}

// ── Optional price range (Chats → "💰 Price range" on the stay form) ──
// Off by default (the guest gets the exact price from the team at booking). When the agent ticks
// it, the range they typed — pre-filled from the room / property rates — goes on the PDF and in
// the message. The AI never sees or writes a price.
export const HOSP_AI_PRICE_UNITS=['per night','per person','per couple','per room','for the stay'];
const num=v=>{const n=Number(String(v??'').replace(/[,\s]/g,''));return Number.isFinite(n)&&n>0?Math.round(n*100)/100:0;};
export function hospAiPrice(raw){
  if(!raw||typeof raw!=='object')return null;
  let from=num(raw.from),to=num(raw.to);
  if(!from&&to){from=to;to=0;}
  if(!from)return null;
  if(to&&to<from)[from,to]=[to,from];
  const currency=str(raw.currency,8).toUpperCase().replace(/[^A-Z₹$€£]/g,'')||'INR';
  const unit=HOSP_AI_PRICE_UNITS.includes(String(raw.unit||'').toLowerCase().trim())?String(raw.unit).toLowerCase().trim():'per night';
  return {from,to:to&&to!==from?to:0,currency,unit};
}
const money=(n,cur)=>Number(n).toLocaleString(cur==='INR'?'en-IN':'en-US',{maximumFractionDigits:2});
export function hospAiPriceLine(p){
  p=hospAiPrice(p);
  if(!p)return '';
  return `${p.currency} ${money(p.from,p.currency)}${p.to?` - ${money(p.to,p.currency)}`:''} ${p.unit}`;
}
// The pre-fill for the form: lowest and highest of the given rates.
export function hospAiPriceHint(rates,currency,unit){
  const r=(rates||[]).map(num).filter(Boolean);
  if(!r.length)return null;
  const from=Math.min(...r),to=Math.max(...r);
  return {from,to:to>from?to:0,currency:str(currency,8).toUpperCase()||'INR',unit:HOSP_AI_PRICE_UNITS.includes(String(unit||'').toLowerCase().trim())?String(unit).toLowerCase().trim():'per night'};
}
export const HOSP_AI_PRICE_FOOTNOTE='The price range is indicative. Rooms are subject to availability; our team confirms the exact price for your dates when you book.';

// ── Resorts & Hotels → PDF only (no day-by-day plan) ──
// For an Agency Resorts & Hotels property the Chats itinerary is a one-PDF brochure: the property
// name, its location, the price range the agent confirms, and every photo — Photo 1-3 links, then
// all images in its Google Drive photos folder (up to HOSP_AI_BROCHURE_MAX). Nothing else is sent:
// no AI plan, no separate photo messages.
export const HOSP_AI_BROCHURE_MAX=30;
// Price pre-fill for a Resorts & Hotels row: its own price range first, else price-from / season /
// off-season prices.
export function hospAiAgencyPriceHint(row){
  const range=[row?.price_range_min,row?.price_range_max];
  const useRange=range.some(v=>Number(v)>0);
  return hospAiPriceHint(useRange?range:[row?.price_from,row?.season_price,row?.off_season_price],row?.currency,row?.price_unit);
}
// Photo links first (as typed), then the folder's image ids as Drive links, no repeats, capped.
export function hospAiBrochurePhotoList(property,folderIds,max=HOSP_AI_BROCHURE_MAX){
  const out=[],seen=new Set();
  const driveId=u=>(/\/file\/d\/([a-zA-Z0-9_-]+)/.exec(u)||/[?&]id=([a-zA-Z0-9_-]+)/.exec(u)||[])[1]||'';
  for(const url of hospAiPhotos(property)){const k=driveId(url)||url;if(!seen.has(k)){seen.add(k);out.push({url});}}
  for(const id of folderIds||[]){if(id&&!seen.has(id)){seen.add(id);out.push({drive_id:id});}}
  return out.slice(0,max);
}
export function hospAiBrochurePdfName(property){
  return `${String(property?.name||'property').replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'').slice(0,60)||'property'}.pdf`;
}
