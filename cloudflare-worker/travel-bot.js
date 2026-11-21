// ── Travel bot layer (Settings → Bot Behavior → ✈️ Travel bot) ───────────────────────────────────
// For travel agencies (Nanthana Air Travels, Nov 2026): the bot hit dead ends on fares and unknown
// words ("P4 login"), answered a 👍 with "I'm not sure I got that", and had no way to turn a price
// question into a booking lead. This layer adds, each behind its own bot_config switch (off by default):
//   tr_fallback_menu   when the bot is stuck it offers a list: Flight / Visa / Umrah / Package /
//                      My booking / Talk to agent (tr_menu_items overrides the labels, one per line)
//   tr_fare_collect    a fare / visa / Umrah / package price ask (when live fares aren't connected)
//                      collects what an agent needs, confirms it, then hands over with a summary
//   tr_doc_detect      a passport / visa / ticket photo or a PDF gets "Got your … 👍", a label and a
//                      handover — the bot never repeats document numbers back
// Pure functions only; worker.js does the I/O (D1 session, AI extraction, sending, handover).

function parseObj(raw){
  if(raw && typeof raw==='object') return raw;
  try{ const o=JSON.parse(raw||'{}'); return o&&typeof o==='object'?o:{}; }catch(e){ return {}; }
}
export function trConfig(c){
  const bc=parseObj(c&&Object.prototype.hasOwnProperty.call(c,'bot_config')?c.bot_config:c);
  const out={fallback_menu:bc.tr_fallback_menu===true, fare_collect:bc.tr_fare_collect===true, doc_detect:bc.tr_doc_detect===true};
  out.menu_items=trMenuItems(bc.tr_menu_items);
  out.any=out.fallback_menu||out.fare_collect||out.doc_detect;
  return out;
}

// ── Fallback menu ────────────────────────────────────────────────────────────────────────────────
// Values are plain asks the bot already understands (and that start the fare collector).
export const TR_DEFAULT_MENU=[
  {title:'✈️ Flight ticket', value:'I need a flight ticket'},
  {title:'🛂 Visa', value:'I need a visa'},
  {title:'🕋 Umrah', value:'I want Umrah package details'},
  {title:'🏝️ Holiday package', value:'I want holiday package details'},
  {title:'🧾 My booking / PNR', value:'I have a question about my booking'},
  {title:'👤 Talk to agent', value:'I want to talk to an agent'},
];
// One label per line; "label | message sent when tapped" sets the value too.
export function trMenuItems(raw){
  const lines=String(raw||'').split('\n').map(l=>l.trim()).filter(Boolean).slice(0,10);
  if(!lines.length) return TR_DEFAULT_MENU;
  return lines.map(l=>{
    const [title, ...rest]=l.split('|').map(x=>x.trim());
    const value=rest.join('|').trim()||title.replace(/^[^\p{L}\p{N}]+/u,'').trim()||title;
    return {title:title.slice(0,24), value:value.slice(0,200)};
  }).filter(x=>x.title);
}
export function trMenuText(lang){
  if(lang==='ta') return 'மன்னிக்கவும், உங்களுக்கு என்ன தேவை என்று கீழே தேர்ந்தெடுங்கள் 👇';
  if(lang==='ml') return 'ക്ഷമിക്കണം, എന്താണ് വേണ്ടതെന്ന് താഴെ നിന്ന് തിരഞ്ഞെടുക്കാമോ? 👇';
  if(lang==='hi') return 'माफ़ कीजिए, नीचे से चुनिए आपको क्या चाहिए 👇';
  return 'Sorry, I didn\'t get that. What do you need help with? Pick one below 👇';
}

// ── Fare / trip asks ─────────────────────────────────────────────────────────────────────────────
const KIND_RES=[
  ['umrah', /\b(?:umrah|umra|ummrah|hajj|haj)\b|உம்ரா|ഉംറ|ഹജ്ജ്/i],
  ['visa', /\b(?:visa|vissa|visit\s*visa|employment\s*visa|work\s*visa|tourist\s*visa|attestation)\b|விசா|വിസ/i],
  ['package', /\b(?:package|packages|pkg|tour|holiday|honeymoon|trip\s+to)\b|பேக்கேஜ்|ടൂർ|പാക്കേജ്/i],
  ['flight', /\b(?:flight|flights|ticket|tickets|tkt|air\s*fare|airfare|fare|one\s*way|oneway|return|round\s*trip|plane)\b|டிக்கெட்|விமான|ടിക്കറ്റ്|ഫ്ലൈറ്റ്|വിമാന/i],
];
export function trDetectKind(text){
  const t=String(text||'');
  for(const [kind, re] of KIND_RES) if(re.test(t)) return kind;
  return null;
}
const PRICE_RE=/\b(?:price|prices|rate|rates|fare|fares|cost|charge|charges|fee|fees|how\s+much|amount|tariff|evlo|evvalavu|evalo|ethra|ethrayanu|ethraya|kitna|kitne|budget|cheap|cheapest|lowest|best\s+(?:price|fare|rate)|available|availability|book|booking)\b|விலை|கட்டணம்|எவ்வளவு|എത്ര|നിരക്ക്|ചാർജ്|കിതനാ|कितना|किराया/i;
const ROUTE_RE=/\b[a-z]{3,}\s*(?:to|-|–|→|>)\s*[a-z]{3,}\b|\b[a-z]{3,}\s*(?:ku|kku|lekk?u|ilekk?u)\b/i;
// A price / booking ask about a flight, visa, Umrah or package, or a route ("Trichy to Dubai").
export function trIsFareAsk(text){
  const t=String(text||'');
  if(!t.trim() || t.length>400) return false;
  const kind=trDetectKind(t);
  if(kind && PRICE_RE.test(t)) return true;
  if(kind==='flight' && ROUTE_RE.test(t)) return true;
  if(PRICE_RE.test(t) && ROUTE_RE.test(t)) return true;
  // Menu taps from TR_DEFAULT_MENU.
  return /^I (?:need a flight ticket|need a visa|want Umrah package details|want holiday package details)$/i.test(t.trim());
}

// What an agent needs before quoting. Asked in this order.
export const TR_SLOTS={
  flight:['from','to','date','trip_type','pax'],
  umrah:['month','days','pax','room_sharing','from'],
  visa:['country','visa_type','nationality','travel_date'],
  package:['destination','date','pax'],
};
const SLOT_HELP={
  from:'departure city or airport', to:'destination city or airport', date:'travel date (keep the customer\'s words, e.g. "12 Dec" or "next Friday")',
  trip_type:'"one_way" or "return" (with return_date if given)', pax:'passengers, e.g. "2 adults, 1 child"', month:'travel month',
  days:'number of days', room_sharing:'room sharing, e.g. "double", "triple", "quad"', country:'destination country',
  visa_type:'"visit", "tourist", "employment", "business", "transit" or as said', nationality:'passport nationality',
  travel_date:'planned travel date', destination:'destination', budget:'budget if mentioned',
};
export function trExtractPrompt(kind){
  const keys=[...(TR_SLOTS[kind]||TR_SLOTS.flight), ...(kind==='flight'?['return_date']:[]), ...(kind==='package'?['budget']:[])];
  return `Extract travel booking details from the customer's WhatsApp message (it may be English, Tamil, Malayalam, Hindi, or Tamil/Malayalam written in English letters). Use the recent conversation only to resolve short answers like "2" or "next week" to the question the agent just asked.
Return ONLY compact JSON with any of these keys that the customer actually gave — leave a key out when it wasn't given, never guess:
${keys.map(k=>`- ${k}: ${SLOT_HELP[k]||k}`).join('\n')}
Write city and country names in English (e.g. "Trichy", "Dubai", "Saudi Arabia").`;
}
export function trParseExtraction(raw, kind){
  let o=null;
  try{ o=JSON.parse((String(raw||'').replace(/```json|```/gi,'').match(/\{[\s\S]*\}/)||['{}'])[0]); }catch(e){ o=null; }
  if(!o || typeof o!=='object') return {};
  const allowed=new Set([...(TR_SLOTS[kind]||TR_SLOTS.flight), 'return_date', 'budget']);
  const out={};
  for(const [k, v] of Object.entries(o)){
    if(!allowed.has(k) || v===null || v===undefined) continue;
    const s=String(v).replace(/\s+/g,' ').trim().slice(0,60);
    if(!s || /^(?:unknown|n\/?a|none|null|not\s+given|-)$/i.test(s)) continue;
    out[k]=k==='trip_type'?(/one|single|oneway/i.test(s)?'one-way':/return|round/i.test(s)?'return':s):s;
  }
  return out;
}
export function trMergeSlots(prev={}, add={}){ return {...(prev||{}), ...(add||{})}; }
export function trNextMissing(kind, slots={}){ return (TR_SLOTS[kind]||TR_SLOTS.flight).find(k=>!String(slots?.[k]||'').trim())||null; }
const QUESTIONS={
  from:'Which city are you flying from? ✈️', to:'Where would you like to go?', date:'Which date would you like to travel? 📅',
  trip_type:'One-way or return?', pax:'How many passengers — adults, children and infants?',
  month:'Which month are you planning your Umrah? 🕋', days:'For how many days?', room_sharing:'Which room sharing would you like — double, triple or quad?',
  country:'Which country is the visa for? 🛂', visa_type:'Which visa — visit, tourist, employment or business?', nationality:'What is the passport nationality?',
  travel_date:'When are you planning to travel? 📅', destination:'Which destination are you looking at? 🏝️',
};
export function trQuestion(kind, slot){
  if(kind==='umrah' && slot==='from') return 'Which city will you start from?';
  if(kind==='umrah' && slot==='pax') return 'How many people are travelling?';
  if(kind==='package' && slot==='pax') return 'How many people are travelling?';
  if(kind==='package' && slot==='date') return 'When are you planning to travel? 📅';
  return QUESTIONS[slot]||'Could you share the travel details?';
}
const KIND_LABEL={flight:'✈️ Flight', umrah:'🕋 Umrah', visa:'🛂 Visa', package:'🏝️ Package'};
export function trSummary(kind, s={}){
  const parts=[];
  if(kind==='flight'){
    if(s.from||s.to) parts.push(`${s.from||'?'} → ${s.to||'?'}`);
    if(s.date) parts.push(s.date);
    if(s.trip_type) parts.push(s.trip_type+(s.return_date?` (back ${s.return_date})`:''));
    if(s.pax) parts.push(s.pax);
  } else if(kind==='umrah'){
    if(s.month) parts.push(s.month); if(s.days) parts.push(`${s.days} days`); if(s.pax) parts.push(s.pax);
    if(s.room_sharing) parts.push(`${s.room_sharing} sharing`); if(s.from) parts.push(`from ${s.from}`);
  } else if(kind==='visa'){
    parts.push([s.country, s.visa_type].filter(Boolean).join(' ')+' visa'); if(s.nationality) parts.push(`${s.nationality} passport`); if(s.travel_date) parts.push(`travel ${s.travel_date}`);
  } else {
    if(s.destination) parts.push(s.destination); if(s.date) parts.push(s.date); if(s.pax) parts.push(s.pax); if(s.budget) parts.push(`budget ${s.budget}`);
  }
  return `${KIND_LABEL[kind]||'✈️ Trip'}: ${parts.filter(Boolean).join(' · ')}`;
}
export function trConfirmText(kind, slots){ return `Just to confirm — ${trSummary(kind, slots)}. Is that right?`; }
export const TR_YES='TR_FARE_YES', TR_CHANGE='TR_FARE_CHANGE';
export function trConfirmButtons(){ return [{title:'✅ Yes, correct', value:TR_YES}, {title:'✏️ Change', value:TR_CHANGE}]; }
export function trIsYes(text){
  const t=String(text||'').trim();
  return t===TR_YES || /^(?:👍|✅|👌)+$/u.test(t)
    || /^(?:yes|yeah|yep|ya|yup|correct|right|ok|okay|confirm(?:ed)?|sari|seri|sheri|aama|aamam|athe|haan|ha)(?:\s+(?:correct|right|please|pls|sir|confirm))?[\s!.👍]*$/iu.test(t)
    || /^(?:ஆமா|ஆமாம்|சரி|അതെ|ശരി|हाँ|हां)/.test(t);
}
export function trIsChange(text){ const t=String(text||'').trim(); return t===TR_CHANGE || /^(?:no|nope|change|wrong|not\s+correct|illa|illai|venda|alla|nahi)\b/i.test(t) || /^(?:नहीं|இல்லை|ഇല്ല|അല്ല)/.test(t); }
export function trWaitText(kind){
  return kind==='visa'
    ? 'Thank you! 🙏 Our visa expert will check the requirements and charges and reply here in a few minutes.'
    : 'Thank you! 🙏 Our travel expert is checking the best fares for you and will share them here in a few minutes ✈️';
}

// ── Documents ────────────────────────────────────────────────────────────────────────────────────
// Reads the AI's description of a photo (never sends it back).
const DOC_RES=[['passport', /\bpassport\b/i], ['visa', /\bvisa\b|\bresidence\s+permit\b|\biqama\b/i],
  ['ticket', /\b(?:e-?ticket|air\s*ticket|flight\s+ticket|boarding\s+pass|itinerary|pnr|booking\s+(?:confirmation|reference))\b/i],
  ['id', /\b(?:emirates\s+id|aadhaa?r|national\s+id|identity\s+card|id\s+card|driving\s+licen[cs]e|pan\s+card)\b/i]];
export function trDocKind(description, mediaType='image'){
  if(mediaType==='document') return 'document';
  const d=String(description||'');
  const hit=DOC_RES.find(([, re])=>re.test(d));
  return hit?hit[0]:null;
}
const DOC_NAMES={passport:{en:'passport copy', ta:'பாஸ்போர்ட் காப்பி', ml:'പാസ്പോർട്ട് കോപ്പി', hi:'पासपोर्ट कॉपी'},
  visa:{en:'visa copy', ta:'விசா காப்பி', ml:'വിസ കോപ്പി', hi:'वीज़ा कॉपी'}, ticket:{en:'ticket', ta:'டிக்கெட்', ml:'ടിക്കറ്റ്', hi:'टिकट'},
  id:{en:'ID copy', ta:'ID காப்பி', ml:'ID കോപ്പി', hi:'ID कॉपी'}, document:{en:'document', ta:'ஆவணம்', ml:'ഡോക്യുമെന്റ്', hi:'दस्तावेज़'}};
export function trDocReply(kind, lang){
  const n=(DOC_NAMES[kind]||DOC_NAMES.document)[lang]||(DOC_NAMES[kind]||DOC_NAMES.document).en;
  if(lang==='ta') return `உங்கள் ${n} கிடைத்தது 👍 எங்கள் டீம் சரிபார்த்து விரைவில் பதில் தருவார்கள்.`;
  if(lang==='ml') return `നിങ്ങളുടെ ${n} കിട്ടി 👍 ഞങ്ങളുടെ ടീം നോക്കിയിട്ട് ഉടനെ മറുപടി തരും.`;
  if(lang==='hi') return `आपकी ${n} मिल गई 👍 हमारी टीम जाँच करके जल्दी जवाब देगी।`;
  return `Got your ${n} 👍 Our team will check it and reply shortly.`;
}
