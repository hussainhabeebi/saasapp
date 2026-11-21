// Hospitality style "Hillora" — a short guided WhatsApp flow over the Hospitality module's units.
// Picked in Settings → Modules → Hospitality → Sub-style "Hillora".
//
//   1. Intro: written from the bot's main prompt (engineBuildFirstTouchIntro in worker.js), then
//      the active Hospitality units as buttons (a list when there are more than 3).
//   2. Unit tap → the photos and details of that unit only.
//   3. Then the stay details form (a WhatsApp form, else the same questions as a message):
//      check-in date, check-out date, how many rooms, requirement (Resort / Homestay), pool
//      preference (With Pool / Without Pool), adults (above 12 years), age 6–12, below 6.
//   4. Details received → the chat is handed to the team, the guest gets a "Chat with Staff"
//      button (a WhatsApp link to the staff number), and the bot stays silent for that guest.
//   5. Two days after the handover it lifts by itself: the bot answers again and the lead is
//      marked as a new lead (worker.js: hilloraReleaseLead, on the 15-minute cron and on the
//      guest's next message).
//
// Pure decisions only (no I/O) so they can be unit-tested; worker.js sends the messages.

import {h3Norm, h3Truncate, h3ExactName, h3MentionsName, h3WordsMatch, h3PageRows} from './hospitality-h3.js';
import {rv1ParseDate} from './hospitality-resorts-v1.js';

export const HILLORA_STYLE='hillora';
export const HILLORA_NAV={
  otherUnits:'↩ Other units',
};
// The handover lifts by itself this long after it started.
export const HILLORA_HANDOVER_MS=2*24*60*60*1000;
export const HILLORA_CHAT_BUTTON='Chat with Staff';
const DESC_MAX=72;

export function hilloraIsStyle(c){
  return !!c && String(c.hospitality_enabled||'').toLowerCase()==='yes' && c.hospitality_style===HILLORA_STYLE;
}

function natCmp(a, b){
  return String(a).localeCompare(String(b), undefined, {numeric:true, sensitivity:'base'});
}
export function hilloraUnits(units){
  return (units||[]).filter(u=>u && String(u.name||'').trim()).slice().sort((a, b)=>natCmp(a.name, b.name));
}

// One line under a unit's name in the list: guests and type.
export function hilloraUnitDesc(u){
  const parts=[];
  const a=Number(u?.capacity_adults)||0, k=Number(u?.capacity_children)||0;
  if(a) parts.push(`${a} adult${a===1?'':'s'}${k?` + ${k} child${k===1?'':'ren'}`:''}`);
  if(u?.unit_type && String(u.unit_type).trim()) parts.push(String(u.unit_type).trim());
  return h3Truncate(parts.join(' · '), DESC_MAX);
}
export function hilloraUnitRows(units){
  return hilloraUnits(units).map(u=>({title:u.name, value:u.name, desc:hilloraUnitDesc(u)}));
}
// The units as one WhatsApp message's options (up to 10, "More units · page N" past that).
export function hilloraUnitPage(units, page=1){
  return h3PageRows(hilloraUnitRows(units), 'units', page);
}
export function hilloraMoreTap(text){
  const m=String(text||'').trim().match(/^(?:more\s+)?units\s*·\s*page\s*(\d+)$/i);
  return m?{page:Number(m[1])}:null;
}
export const HILLORA_UNITS_PROMPT='Please choose a unit below 👇';

// The details sent with a unit's photos: name, guests, type, amenities and description (no price —
// the team shares it once the details are in).
export function hilloraUnitDetailsText(u, property=null){
  const lines=[`*${u.name}*${property?.name?` · ${property.name}`:''}`];
  const d=hilloraUnitDesc(u); if(d) lines.push(`👥 ${d}`);
  if(Number(u.bedrooms)>0) lines.push(`🛏️ ${u.bedrooms} bedroom${Number(u.bedrooms)===1?'':'s'}`);
  if(u.amenities && String(u.amenities).trim()) lines.push(`✨ ${String(u.amenities).trim().replace(/\s*\n\s*/g, ', ')}`);
  if(u.description && String(u.description).trim()) lines.push('', String(u.description).trim());
  return lines.join('\n');
}
export function hilloraPhotoUrls(u){
  return [u?.image_url_1, u?.image_url_2, u?.image_url_3, u?.image_url_4, u?.image_url_5].map(x=>String(x||'').trim()).filter(Boolean);
}

function navIsOtherUnits(text){
  const t=h3Norm(text);
  return h3ExactName(text, HILLORA_NAV.otherUnits)
    || /^(other|another|all|more|different|show)\s+(units?|rooms?|villas?|cottages?|options?)$/.test(t)
    || /^(units|rooms|menu)$/.test(t);
}
const GREETING_RE=/^(hi+|hello+|hey+|hai+|hlo|helo|hola|start|menu|restart|good\s+(morning|afternoon|evening|day)|namaste|namaskaram|salam|assalamu\s*alaikum|as+alam\w*)(\s+(there|team|sir|madam|mam))?[\s!.]*$/i;
const QUESTION_RE=/[?؟]|\b(?:what|which|when|where|why|how|who|is|are|does|do|did|can|could|will|would|should|any|tell|explain|include[sd]?|allowed|near|distance|far)\b/i;
const ENQUIRY_RE=/\b(units?|rooms?|villas?|cottages?|stays?|resorts?|homestays?|available|availability|options?|book(ing)?|photos?|pictures?|images?)\b/i;

function uniqueBy(list, pred){
  const hits=(list||[]).filter(pred);
  return hits.length===1?hits[0]:null;
}
function longestBy(list, pred){
  const hits=(list||[]).filter(pred);
  if(!hits.length) return null;
  return hits.sort((a, b)=>String(b.name).length-String(a.name).length)[0];
}

// Decides this turn's step. Returns null when the message isn't part of the guided flow (the
// normal AI reply then runs — or, while the form is out, the reply is read as the details), else:
//   {type:'units', page, intro, aiFirst?}   the unit buttons (aiFirst: after the AI's answer)
//   {type:'unit', unitId}                  a unit picked → its photos + details, then the form
// ctx = the lead's saved {unit, form}.
export function hilloraDecide({text, isNewLead=false, ctx={}, units=[]}){
  const t=String(text||'').trim();
  if(!t) return null;
  const list=hilloraUnits(units);
  if(!list.length) return null;

  const more=hilloraMoreTap(t);
  if(more) return {type:'units', page:more.page};
  if(navIsOtherUnits(t)) return {type:'units', page:1};

  // A tap (or the whole message) naming a unit exactly.
  const tap=list.find(u=>h3ExactName(t, u.name));
  if(tap) return {type:'unit', unitId:tap.id};

  // While the form is out, anything else is read as the details first (worker.js).
  if(ctx.form==='sent') return null;

  if(QUESTION_RE.test(t) && t.split(/\s+/).length>2){
    if(isNewLead) return {type:'units', page:1, intro:false, aiFirst:true};
    return null;
  }
  const named=longestBy(list, u=>h3MentionsName(t, u.name)) || uniqueBy(list, u=>h3WordsMatch(t, u.name));
  if(named) return {type:'unit', unitId:named.id};

  if(GREETING_RE.test(t) || isNewLead) return {type:'units', page:1, intro:true};
  if(!ctx.unit && ENQUIRY_RE.test(t) && t.split(/\s+/).length<=4) return {type:'units', page:1};
  return null;
}

// ── Stay details form ───────────────────────────────────────────────────────────────────────────
export const HILLORA_FORM_SCREEN='STAY';
export const HILLORA_FORM_VERSION='1';
export const HILLORA_FORM_FIELDS=['checkin','checkout','rooms','requirement','pool','adults','kids_6_12','kids_below_6'];
export const HILLORA_FORM_LABEL={
  checkin:'Check-in Date', checkout:'Check-out Date', rooms:'How many rooms', requirement:'Requirement',
  pool:'Pool Preference', adults:'Adults (Above 12 years)', kids_6_12:'Age 6–12 years', kids_below_6:'Below 6 years',
};
export const HILLORA_REQUIREMENTS=['Resort','Homestay'];
export const HILLORA_POOL=['With Pool','Without Pool'];

// Flow JSON (v3.0). The unit is shown at the top from the message's data; Submit posts to the
// shared Flow endpoint (data_exchange), so the answers reach the worker directly.
export function hilloraFormFlowJson(){
  const L=HILLORA_FORM_LABEL;
  const num=(name, required)=>({type:'TextInput', name, label:L[name], 'input-type':'number', required});
  const radio=(name, options)=>({type:'RadioButtonsGroup', name, label:L[name], required:true,
    'data-source':options.map(o=>({id:o, title:o}))});
  const fields=[
    {type:'DatePicker', name:'checkin', label:L.checkin, required:true},
    {type:'DatePicker', name:'checkout', label:L.checkout, required:true},
    num('rooms', true),
    radio('requirement', HILLORA_REQUIREMENTS),
    radio('pool', HILLORA_POOL),
    num('adults', true),
    num('kids_6_12', false),
    num('kids_below_6', false),
  ];
  return {
    version:'3.0',
    screens:[
      {id:HILLORA_FORM_SCREEN, title:'Your stay details', terminal:false,
        data:{unit:{type:'string', __example__:'Pool Villa'}},
        layout:{type:'SingleColumnLayout', children:[
          {type:'TextSubheading', text:'${data.unit}'},
          {type:'TextBody', text:'Share your dates and guests — our team will confirm availability and the best price.'},
          {type:'Form', name:'form', children:[
            ...fields,
            {type:'Footer', label:'Submit', 'on-click-action':{name:'data_exchange', payload:Object.fromEntries(fields.map(f=>[f.name, '${form.'+f.name+'}']))}},
          ]},
        ]}},
      {id:'SUCCESS', title:'Thank you', terminal:true, success:true, data:{}, layout:{type:'SingleColumnLayout', children:[
        {type:'TextBody', text:'Thanks! Our team will contact you shortly.'},
      ]}},
    ],
  };
}
export function hilloraFormInviteText(unit){
  return `📝 To check availability${unit?` for *${unit}*`:''}, tap *Fill details* and share your dates, rooms and guests. Our team will confirm the best price. 🌿`;
}
export function hilloraFormTextFallback(unit){
  const L=HILLORA_FORM_LABEL;
  return `📝 To check availability${unit?` for *${unit}*`:''}, please reply with these details:\n\n`
    +`1️⃣ ${L.checkin}:\n2️⃣ ${L.checkout}:\n3️⃣ ${L.rooms}:\n4️⃣ ${L.requirement}: Resort / Homestay\n5️⃣ ${L.pool}: With Pool / Without Pool\n`
    +`6️⃣ ${L.adults}:\n7️⃣ ${L.kids_6_12}:\n8️⃣ ${L.kids_below_6}:\n\n`
    +`Example: _20 Dec, 22 Dec, 1 room, Resort, With Pool, 2 adults, 1, 0_`;
}
export function hilloraThanksText(unit){
  return `Thank you! 🙏 We've received your details${unit?` for *${unit}*`:''}.\n\nOur team will confirm availability and share the best price shortly. Tap below to chat with our staff 👇`;
}
// The "Chat with Staff" button's WhatsApp link: the staff number, with a first message that names
// the unit and dates so the guest doesn't have to repeat them. '' when no usable number.
export function hilloraStaffLink(phone, {unit='', f={}}={}){
  const digits=String(phone||'').replace(/\D/g, '');
  if(digits.length<8 || digits.length>15) return '';
  const dates=[f.checkin, f.checkout].filter(Boolean).join(' to ');
  const msg=`Hi, I'd like to book${unit?` ${unit}`:''}${dates?` (${dates})`:''}.`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(msg)}`;
}

const count=v=>{ const m=String(v??'').match(/\d{1,3}/); const n=m?Number(m[0]):NaN; return Number.isFinite(n)&&n>=0&&n<=500?String(n):''; };
function cleanRequirement(v){
  const s=String(v??'').toLowerCase();
  const home=/home\s*-?\s*stay/.test(s), resort=/resort/.test(s);
  if(home===resort) return ''; // neither, or both ("Resort / Homestay" left as written)
  return home?'Homestay':'Resort';
}
function cleanPool(v){
  const s=String(v??'').toLowerCase().trim();
  if(!s) return '';
  const without=/without|\bno\b|\bnon\b|not\s+needed|don'?t|dont|\bnope\b/.test(s);
  const withPool=/\bwith\b(?!out)|\byes\b|\bneed(?:ed)?\b(?<!not\s+needed)/.test(s) || (!without && /pool/.test(s));
  if(without && /\bwith\s+pool\b/.test(s)) return ''; // "With Pool / Without Pool" left as written
  if(without) return 'Without Pool';
  return withPool?'With Pool':'';
}
// Cleans a set of answers (from the Flow or the parser): only well-formed values are kept.
export function hilloraCleanDetails(raw={}, today=new Date()){
  const out={};
  const ci=rv1ParseDate(raw.checkin, today); if(ci) out.checkin=ci;
  let co=rv1ParseDate(raw.checkout, today);
  // "22 Dec" after a 20 Dec check-in is this trip, even across a new year ("2 Jan" after "30 Dec").
  if(co && ci && co<ci){
    const next=`${Number(co.slice(0,4))+1}${co.slice(4)}`;
    co=next>ci?next:'';
  }
  if(co) out.checkout=co;
  for(const k of ['rooms','adults','kids_6_12','kids_below_6']){ const n=count(raw[k]); if(n!=='') out[k]=n; }
  const r=cleanRequirement(raw.requirement); if(r) out.requirement=r;
  const p=cleanPool(raw.pool); if(p) out.pool=p;
  return out;
}
export function hilloraHasDetails(f){
  return !!f && HILLORA_FORM_FIELDS.some(k=>f[k]!=null && String(f[k])!=='');
}
// A typed message counts as the guest's details when it gives at least two of them (one stray
// number or word is not the form), or three when it reads as a question.
export function hilloraIsDetailsReply(text, f){
  const n=HILLORA_FORM_FIELDS.filter(k=>f?.[k]!=null && String(f[k])!=='').length;
  return /[?؟]/.test(String(text||''))?n>=3:n>=2;
}

// Which field a typed label names ("Adults (Above 12 years)", "check out", "age 6-12", "pool").
function labelField(label){
  const l=String(label||'').toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
  if(/below\s*6|under\s*6|<\s*6|less\s+than\s*6|infant|toddler/.test(l)) return 'kids_below_6';
  if(/6\s*(?:-|to)\s*12|child|kid/.test(l)) return 'kids_6_12';
  if(/adult|above\s*12|elder|pax|guests?/.test(l)) return 'adults';
  if(/check\s*-?\s*out|departure|leaving|till|until|^to$/.test(l)) return 'checkout';
  if(/check\s*-?\s*in|arrival|^from$|^date$/.test(l)) return 'checkin';
  if(/room/.test(l)) return 'rooms';
  if(/pool/.test(l)) return 'pool';
  if(/require|type|stay|property|resort|homestay/.test(l)) return 'requirement';
  return '';
}
// Every date written in the text, in order (for "20 Dec to 22 Dec").
function datesIn(text, today){
  const s=String(text||'');
  const out=[];
  const re=/\b(?:20\d\d-\d{1,2}-\d{1,2}|\d{1,2}[\/.\-]\d{1,2}(?:[\/.\-]\d{2,4})?|\d{1,2}(?:st|nd|rd|th)?\s*(?:of\s+)?[a-z]{3,9}\.?(?:,?\s*\d{4})?|[a-z]{3,9}\.?\s*\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?)\b/gi;
  for(const m of s.matchAll(re)){
    const d=rv1ParseDate(m[0], today);
    if(d) out.push(d);
  }
  return out;
}
// Reads the stay details the guest typed: "Label: value" lines, the numbered answers in the
// questions' order (1–8), or free text ("20 Dec to 22 Dec, 1 room, homestay, no pool, 2 adults").
// Only what is actually written is returned — nothing is guessed.
export function hilloraParseDetails(text, today=new Date()){
  const src=String(text||'').replace(/\r/g, '').trim();
  if(!src) return {};
  const raw={};
  const lines=src.split(/\n+/).map(l=>l.replace(/^\s*(?:\d+\s*[.)]\s+|\d️⃣\s*|[•*-]\s+)/u, '').trim()).filter(Boolean);
  // 1. "Label: value" lines.
  let labelled=0;
  for(const line of lines){
    const m=line.match(/^([^:=]{2,40}?)\s*[:=]\s*(.*)$/);
    if(!m) continue;
    const k=labelField(m[1]);
    if(!k) continue;
    labelled++;
    if(raw[k]==null && m[2].trim()) raw[k]=m[2].trim();
  }
  // 2. Free text anywhere in the message.
  const all=src.replace(/\n/g, ' ');
  const grab=(re, k)=>{ if(raw[k]==null){ const m=all.match(re); if(m) raw[k]=m[1]; } };
  grab(/\b(\d{1,3})\s*(?:adults?|adlts?|elders|pax|persons?|people)\b/i, 'adults');
  grab(/\b(\d{1,2})\s*rooms?\b/i, 'rooms');
  grab(/\b(\d{1,2})\s*(?:kids?|child(?:ren)?)\s*(?:\(?\s*(?:aged?\s*)?(?:below|under)\s*6)/i, 'kids_below_6');
  grab(/\b(\d{1,2})\s*(?:kids?|child(?:ren)?)\s*\(?\s*(?:aged?\s*)?6\s*(?:-|–|to)\s*12/i, 'kids_6_12');
  grab(/\b(\d{1,2})\s*(?:infants?|bab(?:y|ies)|toddlers?)\b/i, 'kids_below_6');
  if(raw.requirement==null){ const r=cleanRequirement(all); if(r) raw.requirement=r; }
  if(raw.pool==null && /pool/i.test(all)) raw.pool=/(?:without|no|non[-\s]?)\s*(?:a\s+)?pool|pool\s*(?:not\s+needed|no\b)/i.test(all)?'without':'with';
  if(raw.checkin==null || raw.checkout==null){
    const ds=datesIn(all, today);
    if(raw.checkin==null && ds[0]) raw.checkin=ds[0];
    if(raw.checkout==null && ds[1]) raw.checkout=ds[1];
  }
  // 3. Bare answers in the questions' order ("20 Dec, 22 Dec, 1, Resort, With Pool, 2, 1, 0").
  if(!labelled){
    const parts=(lines.length>=3?lines:src.split(/\s*[,;]\s*/)).map(x=>x.trim()).filter(Boolean);
    if(parts.length>=3){
      parts.slice(0, HILLORA_FORM_FIELDS.length).forEach((p, i)=>{
        const k=HILLORA_FORM_FIELDS[i];
        if(/^\d{1,3}$/.test(p) && ['rooms','adults','kids_6_12','kids_below_6'].includes(k)) raw[k]=p;
      });
    }
  }
  return hilloraCleanDetails(raw, today);
}

// The details → the lead's qualification answers, and one line per detail for the team.
export function hilloraQual(f, unit=''){
  const q={};
  if(unit) q.hillora_unit=String(unit);
  for(const k of HILLORA_FORM_FIELDS) if(f?.[k]) q[`hillora_${k}`]=String(f[k]);
  if(f?.checkin){ q.travel_date=f.checkin; q.travel_month=f.checkin.slice(0, 7); }
  if(f?.adults) q.adults=f.adults;
  if(f?.rooms) q.rooms=f.rooms;
  return q;
}
export function hilloraSummaryLines(f, unit=''){
  const L=HILLORA_FORM_LABEL;
  const lines=[];
  if(unit) lines.push(`Unit: ${unit}`);
  for(const k of HILLORA_FORM_FIELDS) lines.push(`${L[k]}: ${f?.[k]!=null && String(f[k])!=='' ? f[k] : '—'}`);
  return lines;
}

// Whether the handover on this lead is old enough to lift (HANDOVER_MS after HandoverAt).
export function hilloraHandoverExpired(lead, nowMs=Date.now()){
  if(!lead || lead.Handover!=='Yes') return false;
  const at=Date.parse(lead.HandoverAt||'');
  if(!Number.isFinite(at)) return false;
  return Number(nowMs)-at>=HILLORA_HANDOVER_MS;
}
// Only the bot's handover lifts by itself — a teammate who took the chat over by hand in Chats
// (HandoverBy set) keeps it until they hand it back.
export function hilloraHandoverLiftable(lead, nowMs=Date.now()){
  return hilloraHandoverExpired(lead, nowMs) && !String(lead?.HandoverBy||'').trim();
}
// The lead fields written when the handover lifts. The lead goes back to "new" only from the
// handover stage — one the team has since moved on (booked, won, lost…) keeps its stage.
export function hilloraReleasePatch(lead){
  const patch={Handover:'No', HandoverBy:'', HandoverAt:'', SlaAlerted:'No'};
  const stage=String(lead?.Stage||'');
  if(!stage || stage==='human_handover' || stage==='new') patch.Stage='new';
  return patch;
}
