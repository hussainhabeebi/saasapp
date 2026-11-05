/* ═══════════════════════════════════════════════════════════════════════════
   TRAVEL FLOWS: AI-first booking flows (Travel Settings → 🧩 Flows)
   Optional. A flow runs only when the agency has built it, published it (status "active") and
   left the master switch "Use flows" on. Agencies without flows see no change at all.

   A flow starts from one of two triggers:
     • keyword: a phrase in the customer's message ("umrah", "ladies trip"), matched the way package
       keywords are (word order does not matter, generic words such as "trip" are ignored);
     • package: the bot identifies one of the chosen packages (name, package keyword, or a tap).

   AI-first: once a flow is running, every message still goes to the AI. The flow only tells the AI
   which booking details are still missing. The AI pulls any details out of the message (one
   message can fill several steps), answers anything else the customer asked from the main prompt,
   knowledge base and package, then asks for the next missing detail. A clear change of topic
   pauses the flow so the normal bot takes over; "continue booking" or the trigger again resumes it.

   Pure (no I/O). Storage, the AI call and WhatsApp sends live in worker.js.
   ═══════════════════════════════════════════════════════════════════════════ */

import {flyindoParseDate,flyindoCheckDate,flyindoDateLabel} from './flyindo-flow.js';
import {taPackageKeywords,taPackagePrice,taMoney} from './travel-itinerary.js';

export const TF_PREFIX='TFLOW:';
export const TF_CONTINUE_VALUE=`${TF_PREFIX}continue`;
export const TF_MAX_FLOWS=20;
export const TF_MAX_STEPS=12;
export const TF_MAX_OPTIONS=10;
export const TF_MAX_KEYWORDS=10;
export const TF_STATE_TTL_MS=24*60*60*1000;
// Turns in a row where the customer gives no new detail before the flow steps aside (pauses) and
// the normal bot carries the chat. The AI answers each of those turns, so this is generous.
export const TF_MAX_DETOURS=5;
export const TF_STATUSES=['draft','active','paused'];
export const TF_TRIGGER_TYPES=['keyword','package'];
export const TF_ASK_TYPES=['ask_date','ask_travellers','ask_city','ask_custom'];
export const TF_ACTION_TYPES=['send_package','quote','payment','handover'];
export const TF_STEP_TYPES=[...TF_ASK_TYPES,...TF_ACTION_TYPES];
export const TF_ENDING_TYPES=['handover','payment'];

export const TF_STEP_META={
  ask_date:{icon:'📅',label:'Travel date',question:'📅 When would you like to travel? Please share your travel date (or the month, if it is not fixed yet).'},
  ask_travellers:{icon:'👨‍👩‍👧',label:'Travellers',question:'🧳 How many people are travelling? Please tell us the number of adults and children.'},
  ask_city:{icon:'🛫',label:'Departure city',question:'🛫 Which city will you be travelling from?'},
  ask_custom:{icon:'❓',label:'Question',question:''},
  send_package:{icon:'📦',label:'Send package details'},
  quote:{icon:'💰',label:'Price estimate'},
  payment:{icon:'💳',label:'Payment'},
  handover:{icon:'👤',label:'Hand over to consultant'},
};
const AGES_QUESTION='🎂 How old are the children? Their ages help us price the trip correctly.';
const DEFAULT_PAYMENT_TEXT='💳 To confirm your booking, an advance payment is needed. Our team will confirm the exact amount with you here.';
const DEFAULT_HANDOVER_TEXT='Thank you! 🙏 Our travel consultant will contact you shortly to confirm availability and the final price.';
const DEFAULT_COMPLETE_TEXT='Thank you! 🙏 Our team will get back to you here shortly.';

const clip=(v,n)=>String(v??'').replace(/\s+/g,' ').trim().slice(0,n);
const clipText=(v,n)=>String(v??'').replace(/\r/g,'').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim().slice(0,n);
const norm=s=>String(s||'').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const words=s=>norm(s).split(' ').filter(Boolean);
const optKey=s=>norm(String(s||'').replace(/\p{Extended_Pictographic}/gu,''));
const MONTH_FULL=['January','February','March','April','May','June','July','August','September','October','November','December'];

// ── Flow model ───────────────────────────────────────────────────────────────
function newId(prefix){ return `${prefix}${Math.random().toString(36).slice(2,8)}`; }
function cleanId(v,prefix){ const s=String(v||'').trim().toLowerCase(); return /^[a-z0-9_]{1,24}$/.test(s)?s:newId(prefix); }

export function tfNormalizeStep(raw={}){
  const type=TF_STEP_TYPES.includes(raw?.type)?raw.type:'ask_custom';
  const step={id:cleanId(raw?.id,'s'),type,enabled:raw?.enabled!==false,note:clipText(raw?.note,300)};
  if(TF_ASK_TYPES.includes(type)){
    step.required=raw?.required!==false;
    step.question=clipText(raw?.question,300);
  }
  if(type==='ask_custom') step.label=clip(raw?.label,40);
  if(type==='ask_city'||type==='ask_custom'){
    const seen=new Set();
    step.options=(Array.isArray(raw?.options)?raw.options:String(raw?.options||'').split(/\n|,/))
      .map(o=>clip(o,24)).filter(o=>o&&!seen.has(o.toLowerCase())&&seen.add(o.toLowerCase())).slice(0,TF_MAX_OPTIONS);
  }
  if(type==='ask_travellers') step.ask_ages=raw?.ask_ages!==false;
  if(type==='send_package'){
    step.package_id=clip(raw?.package_id,40);
    step.details=raw?.details!==false;
    step.photos=raw?.photos!==false;
    step.pdf=raw?.pdf===true;
  }
  if(type==='payment'){ step.text=clipText(raw?.text,500); step.send_qr=raw?.send_qr!==false; }
  if(type==='handover') step.message=clipText(raw?.message,500);
  return step;
}

export function tfNormalizeFlow(raw={}){
  const t=raw?.trigger||{};
  const type=TF_TRIGGER_TYPES.includes(t.type)?t.type:'keyword';
  const seenKw=new Set();
  const keywords=(Array.isArray(t.keywords)?t.keywords:String(t.keywords||'').split(/\n|,/))
    .map(k=>clip(k,60)).filter(k=>k&&!seenKw.has(k.toLowerCase())&&seenKw.add(k.toLowerCase())).slice(0,TF_MAX_KEYWORDS);
  const package_ids=[...new Set((Array.isArray(t.package_ids)?t.package_ids:[]).map(x=>clip(x,40)).filter(Boolean))].slice(0,50);
  const ids=new Set();
  const steps=(Array.isArray(raw?.steps)?raw.steps:[]).slice(0,TF_MAX_STEPS).map(tfNormalizeStep).map(s=>{
    while(ids.has(s.id)) s.id=newId('s');
    ids.add(s.id); return s;
  });
  return {
    id:cleanId(raw?.id,'f'),
    name:clip(raw?.name,60)||'Untitled flow',
    status:TF_STATUSES.includes(raw?.status)?raw.status:'draft',
    version:Math.max(1,parseInt(raw?.version,10)||1),
    trigger:{type,keywords,package_ids,when:t.when==='start'?'start':'any'},
    note:clipText(raw?.note,500),
    steps,
    updated_at:String(raw?.updated_at||''),
    updated_by:clip(raw?.updated_by,120),
  };
}

const enabledSteps=flow=>(flow?.steps||[]).filter(s=>s.enabled!==false);

// Problems that block publishing (errors) and things worth a look (warnings).
export function tfValidateFlow(flow,{packages=[],flows=[]}={}){
  const errors=[],warnings=[];
  const steps=enabledSteps(flow);
  const pkgIds=new Set((packages||[]).map(p=>String(p?.Id??p?.id??'')));
  const pkgName=id=>String((packages||[]).find(p=>String(p?.Id??p?.id??'')===id)?.name||id);
  if(!String(flow?.name||'').trim()||flow.name==='Untitled flow') errors.push('Give the flow a name.');
  if(flow.trigger.type==='keyword'){
    const usable=flow.trigger.keywords.filter(k=>taPackageKeywords({keywords:k}).length);
    if(!usable.length) errors.push('Add at least one keyword. Words such as "trip" or "package" alone are too general.');
    else if(usable.length<flow.trigger.keywords.length) warnings.push('Some keywords are only general words (like "trip") and are ignored.');
    for(const k of usable){
      const kw=taPackageKeywords({keywords:k})[0];
      const pk=(packages||[]).filter(p=>taPackageKeywords(p).some(x=>x.join(' ')===kw.join(' ')));
      if(pk.length) warnings.push(`"${k}" is also a package keyword for ${pk.map(p=>p.name).join(', ')}. Consider a package trigger instead.`);
    }
  }else{
    if(!flow.trigger.package_ids.length) errors.push('Choose at least one package that starts this flow.');
    const missing=flow.trigger.package_ids.filter(id=>pkgIds.size&&!pkgIds.has(id));
    if(missing.length) warnings.push(`${missing.length} chosen package${missing.length>1?'s are':' is'} no longer in your Packages list.`);
  }
  if(!steps.length) errors.push('Add at least one step.');
  else{
    if(!steps.some(s=>TF_ASK_TYPES.includes(s.type))) warnings.push('This flow asks no questions.');
    const last=steps[steps.length-1];
    if(!TF_ENDING_TYPES.includes(last.type)) errors.push('End the flow with a "Hand over to consultant" or "Payment" step.');
    const hi=steps.findIndex(s=>s.type==='handover');
    if(hi>=0&&hi<steps.length-1) errors.push('"Hand over to consultant" must be the last step: steps after it would never run.');
  }
  for(const s of steps){
    if(s.type==='ask_custom'&&!s.label&&!s.question) errors.push('Each custom question needs a label or a question.');
    if((s.options||[]).length>TF_MAX_OPTIONS) errors.push(`WhatsApp lists hold up to ${TF_MAX_OPTIONS} options.`);
    if(s.type==='send_package'&&!s.package_id&&flow.trigger.type==='keyword') warnings.push('"Send package details" is skipped unless the customer names a package (or you pick one in the step).');
    if(s.type==='send_package'&&s.package_id&&pkgIds.size&&!pkgIds.has(s.package_id)) warnings.push('The package picked in "Send package details" is no longer in your Packages list.');
    if(s.type==='quote'&&flow.trigger.type==='keyword'&&!steps.some(x=>x.type==='send_package'&&x.package_id)) warnings.push('"Price estimate" needs a package with a price; it is skipped when there is none.');
    if(s.type==='quote'&&!steps.some(x=>x.type==='ask_travellers')) warnings.push('"Price estimate" works best after a "Travellers" step.');
  }
  // Clashes with the agency's other published flows.
  for(const o of (flows||[]).filter(f=>f.id!==flow.id&&f.status==='active')){
    if(flow.trigger.type==='package'&&o.trigger.type==='package'){
      const both=flow.trigger.package_ids.filter(id=>o.trigger.package_ids.includes(id));
      if(both.length) errors.push(`${both.map(pkgName).join(', ')} already start${both.length>1?'':'s'} the active flow "${o.name}". A package can belong to one active flow.`);
    }
    if(flow.trigger.type==='keyword'&&o.trigger.type==='keyword'){
      const mine=new Set(flow.trigger.keywords.map(k=>taPackageKeywords({keywords:k})[0]?.slice().sort().join(' ')).filter(Boolean));
      const both=o.trigger.keywords.filter(k=>mine.has(taPackageKeywords({keywords:k})[0]?.slice().sort().join(' ')));
      if(both.length) errors.push(`The keyword "${both[0]}" already starts the active flow "${o.name}".`);
    }
  }
  return {errors:[...new Set(errors)],warnings:[...new Set(warnings)]};
}

// ── Templates ────────────────────────────────────────────────────────────────
export const TF_TEMPLATES=[
  {key:'package_booking',name:'Package enquiry → Booking',description:'Package details, travel date, travellers, departure city, price estimate, then your consultant.',
    flow:{name:'Package booking',trigger:{type:'package',package_ids:[]},note:'',steps:[
      {type:'send_package',details:true,photos:true,pdf:false},
      {type:'ask_date',required:true},
      {type:'ask_travellers',required:true,ask_ages:true},
      {type:'ask_city',required:false,options:[]},
      {type:'quote'},
      {type:'handover'}]}},
  {key:'visa',name:'Visa enquiry',description:'Country, nationality, travel date and travellers, then your visa desk.',
    flow:{name:'Visa enquiry',trigger:{type:'keyword',keywords:['tourist visa','visit visa','visa enquiry']},note:'',steps:[
      {type:'ask_custom',label:'Visa country',question:'🌍 Which country do you need the visa for?',required:true},
      {type:'ask_custom',label:'Nationality',question:'🛂 What is your nationality (passport country)?',required:true},
      {type:'ask_date',required:true},
      {type:'ask_travellers',required:true,ask_ages:false},
      {type:'handover'}]}},
  {key:'group_trip',name:'Group / ladies-only trip',description:'Departure batch, seats, room sharing, estimate and advance payment.',
    flow:{name:'Group trip',trigger:{type:'keyword',keywords:['group trip','ladies trip']},note:'',steps:[
      {type:'ask_date',required:true,question:'📅 Which departure date (batch) would you like to join?'},
      {type:'ask_travellers',required:true,ask_ages:false},
      {type:'ask_custom',label:'Room sharing',question:'🛏️ Which room sharing would you prefer?',options:['Twin sharing','Triple sharing','Single room'],required:true},
      {type:'quote'},
      {type:'payment',send_qr:true},
      {type:'handover'}]}},
  {key:'honeymoon',name:'Honeymoon',description:'Dates, hotel category and departure city, then your consultant.',
    flow:{name:'Honeymoon',trigger:{type:'keyword',keywords:['honeymoon']},note:'Be warm and congratulate the couple.',steps:[
      {type:'ask_date',required:true},
      {type:'ask_custom',label:'Hotel category',question:'🏨 Which hotel category would you like?',options:['3 Star','4 Star','5 Star'],required:true},
      {type:'ask_city',required:false,options:[]},
      {type:'handover'}]}},
  {key:'umrah',name:'Umrah / pilgrimage',description:'Preferred month, number of pilgrims and passport, then your consultant.',
    flow:{name:'Umrah',trigger:{type:'keyword',keywords:['umrah']},note:'',steps:[
      {type:'ask_date',required:true,question:'📅 Which month would you like to travel for Umrah?'},
      {type:'ask_travellers',required:true,ask_ages:false,question:'🧳 How many pilgrims will travel (adults and children)?'},
      {type:'ask_custom',label:'Passport ready',question:'🛂 Do all travellers have a passport valid for at least 6 months?',options:['Yes','No','Some of us'],required:true},
      {type:'handover'}]}},
];
export function tfTemplateFlow(key){
  const t=TF_TEMPLATES.find(x=>x.key===key);
  return t?tfNormalizeFlow({...JSON.parse(JSON.stringify(t.flow)),status:'draft'}):null;
}

// ── Triggers ─────────────────────────────────────────────────────────────────
// The package a message identifies: a package button tap, a package keyword (one package), or the
// package's name. Returns the package or null.
export function tfPackageInMessage(packages,text,{byKeyword=null,findInText=null}={}){
  const tap=/^(?:TPKG|TPKGENQ):(.+)$/i.exec(String(text||'').trim());
  if(tap) return (packages||[]).find(p=>String(p?.Id??p?.id??'')===tap[1].trim())||null;
  if(byKeyword){ const kw=byKeyword(packages,text); if(kw.length===1) return kw[0]; if(kw.length>1) return null; }
  return findInText?findInText(packages,text):null;
}
// Score of the best keyword of a flow found in the text (number of words), 0 for none.
export function tfKeywordScore(flow,text){
  const have=new Set(words(text));
  if(!have.size) return 0;
  let best=0;
  for(const k of flow?.trigger?.keywords||[])
    for(const kw of taPackageKeywords({keywords:k})) if(kw.every(w=>have.has(w))) best=Math.max(best,kw.length);
  return best;
}
// The active flow a message starts: a package trigger first (most specific), then the keyword flow
// whose keyword matches most words. {flow, pkg} or null.
export function tfMatchTrigger(flows,text,{pkg=null,isNewChat=true}={}){
  const live=(flows||[]).filter(f=>f.status==='active'&&(f.trigger.when!=='start'||isNewChat));
  if(pkg){
    const id=String(pkg?.Id??pkg?.id??'');
    const f=live.find(f=>f.trigger.type==='package'&&f.trigger.package_ids.includes(id));
    if(f) return {flow:f,pkg};
  }
  let best=null,score=0;
  for(const f of live.filter(f=>f.trigger.type==='keyword')){
    const s=tfKeywordScore(f,text);
    if(s>score){best=f;score=s;}
  }
  return best?{flow:best,pkg}:null;
}

// ── Running state ────────────────────────────────────────────────────────────
export function tfPkgSnapshot(p){
  if(!p) return null;
  return {id:String(p?.Id??p?.id??''),name:clip(p.name,80),destination:clip(p.destination,120),nights:Number(p.nights)||0,
    currency:clip(p.currency,8),price:taPackagePrice(p),child_price:Number(p.child_price)||0,child_nobed_price:Number(p.child_nobed_price)||0,infant_price:Number(p.infant_price)||0};
}
// A copy of the flow travels with the chat, so editing a published flow never breaks a customer
// who is half-way through it: they finish on the version they started.
export function tfStart(flow,pkg=null,now=new Date()){
  return {flow_id:flow.id,version:flow.version,flow:{id:flow.id,name:flow.name,note:flow.note,trigger_type:flow.trigger.type,steps:enabledSteps(flow)},
    pkg:tfPkgSnapshot(pkg),answers:{},asked:{},skipped:{},done:{},current:'',detours:0,paused:false,started_at:now.toISOString()};
}
function travellersComplete(step,v){
  if(!v||!(v.adults>=1)) return false;
  if(step.ask_ages&&v.children>0&&(v.ages||[]).length<v.children) return false;
  return true;
}
export function tfStepAnswered(step,state){
  const v=state.answers?.[step.id];
  if(v==null||v==='') return false;
  return step.type==='ask_travellers'?travellersComplete(step,v):true;
}
// Ask steps still open (not answered, not skipped), in flow order.
export function tfPending(state){
  return (state.flow?.steps||[]).filter(s=>TF_ASK_TYPES.includes(s.type)&&!tfStepAnswered(s,state)&&!state.skipped?.[s.id]);
}
export function tfStepLabel(step){ return step.type==='ask_custom'?(step.label||clip(step.question,40)||'Answer'):TF_STEP_META[step.type]?.label||step.type; }
export function tfStepQuestion(step,state){
  if(step.type==='ask_travellers'){
    const v=state?.answers?.[step.id];
    if(v&&v.adults>=1&&!travellersComplete(step,v)) return AGES_QUESTION;
  }
  if(step.question) return step.question;
  if(step.type==='ask_custom') return `${step.label}?`;
  if(step.type==='ask_city'&&state?.pkg?.name) return `🛫 Which city will you be travelling from for *${state.pkg.name}*?`;
  if(step.type==='ask_date'&&state?.pkg?.name) return `📅 When would you like to travel for *${state.pkg.name}*? Please share your travel date (or the month, if it is not fixed yet).`;
  return TF_STEP_META[step.type]?.question||'';
}

// ── Answers ──────────────────────────────────────────────────────────────────
const WORD_NUM={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,no:0,zero:0};
const num=s=>{const t=String(s||'').toLowerCase();return /^\d+$/.test(t)?Number(t):t in WORD_NUM?WORD_NUM[t]:null;};
// "2 adults 1 child (6)", "2 adults and 2 kids aged 5 and 8", "3 pax", "just 2" → travellers.
export function tfParseTravellers(text){
  const s=String(text||'').toLowerCase().replace(/[,;&+]/g,' ');
  const N='(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|no|zero)';
  const pick=re=>{const m=s.match(new RegExp(`${N}\\s*(?:${re})\\b`));return m?num(m[1]):null;};
  let adults=pick('adults?|adlts?|elders?|grown ?ups?|pax|people|persons?|members?|travell?ers?|guests?|pilgrims?|ladies|couples?');
  if(adults!=null&&/\bcouples?\b/.test(s)&&!/\bpax|people|persons?\b/.test(s)) adults=adults*2;
  const children=pick('child(?:ren)?|kids?|kid|boys?|girls?|sons?|daughters?')??0;
  const infants=pick('infants?|bab(?:y|ies)|toddlers?')??0;
  if(adults==null){
    const lone=s.match(/^\s*(?:just|only)?\s*(\d{1,2})\s*$/);
    if(lone) adults=Number(lone[1]);
    else if(/\b(?:couple|me and my (?:wife|husband|partner))\b/.test(s)) adults=2;
    else if(/\b(?:just me|only me|myself|alone|solo)\b/.test(s)) adults=1;
  }
  if(!(adults>=1)) return null;
  const agesPart=s.split(/\bage[sd]?\b|\byears?\b|\byrs?\b/).length>1?s:'';
  const ages=agesPart?[...agesPart.replace(new RegExp(`${N}\\s*(?:adults?|child(?:ren)?|kids?|infants?|pax|people|persons?)`,'g'),' ').matchAll(/\b(\d{1,2})\b/g)].map(m=>Number(m[1])).filter(a=>a<18):[];
  return {adults,children,infants,ages:ages.slice(0,children||0)};
}
function monthValue(v,today){
  const m=/^(\d{4})-(\d{2})$/.exec(String(v||'').trim());
  if(!m) return null;
  const y=+m[1],mo=+m[2];
  if(mo<1||mo>12) return null;
  const nowIdx=today.getUTCFullYear()*12+today.getUTCMonth(),idx=y*12+mo-1;
  if(idx<nowIdx||idx>nowIdx+18) return null;
  return {date:`${m[1]}-${m[2]}`,label:`${MONTH_FULL[mo-1]} ${y}`};
}
// "December", "dec 2026", "next month" → YYYY-MM.
function parseMonth(text,today){
  const s=String(text||'').trim().toLowerCase();
  if(/^(?:in\s+)?next month$/.test(s)){const d=new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth()+1,1));return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;}
  if(/^(?:in\s+)?this month$/.test(s))return `${today.getUTCFullYear()}-${String(today.getUTCMonth()+1).padStart(2,'0')}`;
  const m=s.match(/^(?:in\s+|by\s+|end of\s+|mid\s+)?([a-z]+)\.?(?:\s+(\d{4}))?$/);
  if(!m) return '';
  const i=MONTH_FULL.findIndex(x=>m[1].length>=3&&x.toLowerCase().startsWith(m[1].slice(0,3)));
  if(i<0) return '';
  let y=m[2]?+m[2]:today.getUTCFullYear();
  if(!m[2]&&i<today.getUTCMonth()) y++;
  return `${y}-${String(i+1).padStart(2,'0')}`;
}
// A value from the AI (or a typed reply) checked for one step. The stored value, or null.
export function tfAcceptAnswer(step,value,today=new Date()){
  if(value==null||value==='') return null;
  if(step.type==='ask_date'){
    const raw=typeof value==='object'?value.date:value;
    const s=String(raw||'').trim();
    if(/^\d{4}-\d{2}-\d{2}$/.test(s)){const c=flyindoCheckDate(s,today);return c.ok?{date:s,label:flyindoDateLabel(s)}:null;}
    const mv=monthValue(s,today); if(mv) return mv;
    const iso=flyindoParseDate(s,today);
    if(iso){const c=flyindoCheckDate(iso,today);return c.ok?{date:iso,label:flyindoDateLabel(iso)}:null;}
    const pm=parseMonth(s,today);
    return pm?monthValue(pm,today):null;
  }
  if(step.type==='ask_travellers'){
    let v=value;
    if(typeof v!=='object'){v=tfParseTravellers(v);if(!v)return null;}
    const int=(x,max)=>{const n=parseInt(x,10);return Number.isFinite(n)&&n>=0?Math.min(n,max):0;};
    const out={adults:int(v.adults,60),children:int(v.children,30),infants:int(v.infants,10),
      ages:(Array.isArray(v.ages)?v.ages:[]).map(a=>parseInt(a,10)).filter(a=>Number.isFinite(a)&&a>=0&&a<18).slice(0,30)};
    return out.adults>=1?out:null;
  }
  const s=clip(typeof value==='object'?(value.value??value.text??''):value,80);
  if(!s) return null;
  const opt=(step.options||[]).find(o=>optKey(o)===optKey(s));
  return opt||s;
}
export function tfAnswerText(step,v){
  if(v==null) return '';
  if(step.type==='ask_date') return v.label||v.date||'';
  if(step.type==='ask_travellers'){
    const parts=[`${v.adults} adult${v.adults===1?'':'s'}`];
    if(v.children) parts.push(`${v.children} child${v.children===1?'':'ren'}${(v.ages||[]).length?` (age${v.ages.length>1?'s':''} ${v.ages.join(', ')})`:''}`);
    if(v.infants) parts.push(`${v.infants} infant${v.infants===1?'':'s'}`);
    return parts.join(', ');
  }
  return String(v);
}

// The reply a tap or a short typed answer gives the step being asked, without the AI: an option
// title, a valid date, a traveller count. {answers} (maybe empty) and whether it was a clean answer.
export function tfDirectAnswer(state,text,today=new Date()){
  const step=(state.flow?.steps||[]).find(s=>s.id===state.current);
  const t=String(text||'').trim();
  if(!step||!t||t.length>80) return {answers:{},clean:false};
  if(step.options?.length){
    const opt=step.options.find(o=>optKey(o)===optKey(t));
    if(opt) return {answers:{[step.id]:opt},clean:true};
  }
  if(step.type==='ask_date'){
    const v=tfAcceptAnswer(step,t,today);
    if(v&&(flyindoParseDate(t,today)||parseMonth(t,today))) return {answers:{[step.id]:v},clean:true};
  }
  if(step.type==='ask_travellers'){
    const prev=state.answers?.[step.id];
    if(prev&&prev.adults>=1&&step.ask_ages&&prev.children>0){
      const ages=[...t.matchAll(/\b(\d{1,2})\b/g)].map(m=>Number(m[1])).filter(a=>a<18);
      if(ages.length&&/^[\d\s,&and+yrsyearsold.-]+$/i.test(t)) return {answers:{[step.id]:{...prev,ages:[...(prev.ages||[]),...ages].slice(0,prev.children)}},clean:true};
    }
    const v=tfParseTravellers(t);
    if(v&&/^[\p{N}\s\p{L},&+()-]{1,60}$/u.test(t)&&!/\?/.test(t)&&t.split(/\s+/).length<=10) return {answers:{[step.id]:v},clean:!step.ask_ages||!v.children||v.ages.length>=v.children};
  }
  return {answers:{},clean:false};
}

// ── AI prompt ────────────────────────────────────────────────────────────────
export function tfBuildAiPrompt(state,{text='',agency='',mainPrompt='',kb='',packageText='',history=[],lang='en',langName='English',replyStyle='',today=new Date()}={}){
  const pending=tfPending(state);
  const have=(state.flow?.steps||[]).filter(s=>TF_ASK_TYPES.includes(s.type)&&state.answers?.[s.id]!=null)
    .map(s=>`- ${tfStepLabel(s)}: ${tfAnswerText(s,state.answers[s.id])}`);
  const pend=pending.map(s=>{
    const fmt=s.type==='ask_date'?'value "YYYY-MM-DD", or "YYYY-MM" when only a month is given'
      :s.type==='ask_travellers'?`value {"adults":n,"children":n,"infants":n,"ages":[child ages]}${s.ask_ages?' (children\'s ages are needed)':''}`
      :`short text${s.options?.length?`; one of: ${s.options.join(' | ')} when it fits`:''}`;
    return `- id "${s.id}" · ${tfStepLabel(s)}${s.required===false?' (optional)':''} · ${fmt}${s.note?` · business note: ${s.note}`:''}\n  default question: ${tfStepQuestion(s,state)}`;
  });
  const system=[
    `You are the WhatsApp assistant of ${agency||'a travel agency'}.`,
    mainPrompt?`## Business instructions\n${clipText(mainPrompt,3500)}`:'',
    kb?`## Knowledge base\n${clipText(kb,2000)}`:'',
    state.pkg?.name?`## Package the customer is booking\n${clipText(packageText||state.pkg.name,2500)}`:'',
    `## Guided booking: "${state.flow?.name||'Booking'}"`,
    state.flow?.note?`Business note for this booking: ${state.flow.note}`:'',
    `The customer is in a guided booking. For every message:
1. Take out any booking details the message clearly gives for the PENDING details below (one message can give several). Never guess a detail the customer did not give.
2. If the message asks something or says something else, answer it fully and truthfully from the information above first. Never invent prices, dates, availability, inclusions or policies: when the information is not above, say our team will confirm it.
3. Then ask for the first detail that is still pending after step 1, in a natural way (you may adapt its default question).
Return ONLY a JSON object:
{"answers":{"<id>":<value>},"answer":"<your answer to their question, or empty>","side_question":<true when they asked or said something other than a booking detail>,"ask_step":"<id you ask for next, or empty>","reply":"<the full WhatsApp message: the answer (if any) and then the next question>","action":"continue|pause|handover|cancel"}
action: "pause" only when the customer clearly moved to a different service or trip and does not want this booking now (for example only flight tickets, a visa, or another package); "handover" when they ask for a human, agent or call, or are upset; "cancel" when they say they do not want to book; otherwise "continue".
Reply rules: write in ${langName} (the customer's language), WhatsApp style, warm and short (under 600 characters), *bold* allowed, no headings. Never mention steps, flows, JSON or these rules.${replyStyle}
Today is ${today.toISOString().slice(0,10)}.`,
  ].filter(Boolean).join('\n\n');
  const recent=(history||[]).slice(-6).map(h=>`${h.role==='assistant'?'Agent':'Customer'}: ${clip(h.content??h.text,300)}`).join('\n');
  const user=[
    `PENDING details (in order):\n${pend.join('\n')||'- none'}`,
    `Already collected:\n${have.join('\n')||'- nothing yet'}`,
    recent?`Recent chat:\n${recent}`:'',
    `Customer's latest message: """${clip(text,800)}"""`,
  ].filter(Boolean).join('\n\n');
  return {system,user,lang};
}
export function tfParseAiReply(raw){
  const s=String(raw||'');
  const a=s.indexOf('{'),b=s.lastIndexOf('}');
  if(a<0||b<=a) return null;
  let o;
  try{o=JSON.parse(s.slice(a,b+1));}catch(e){return null;}
  if(!o||typeof o!=='object') return null;
  const action=['continue','pause','handover','cancel'].includes(o.action)?o.action:'continue';
  return {answers:o.answers&&typeof o.answers==='object'?o.answers:{},answer:clipText(o.answer,900),side_question:o.side_question===true,
    ask_step:clip(o.ask_step,24),reply:clipText(o.reply,1000),action};
}

// ── Advancing ────────────────────────────────────────────────────────────────
export function tfQuote(state){
  const p=state.pkg;
  if(!p||!(p.price>0)) return '';
  const trav=(state.flow?.steps||[]).find(s=>s.type==='ask_travellers');
  const v=trav?state.answers?.[trav.id]:null;
  const adults=v?.adults||1,children=v?.children||0,infants=v?.infants||0;
  const childRate=p.child_price||p.child_nobed_price||p.price,cur=p.currency;
  const lines=[`👨 ${adults} Adult${adults===1?'':'s'} × ${taMoney(p.price,cur)} = ${taMoney(adults*p.price,cur)}`];
  let total=adults*p.price;
  if(children){lines.push(`👧 ${children} Child${children===1?'':'ren'} × ${taMoney(childRate,cur)} = ${taMoney(children*childRate,cur)}`);total+=children*childRate;}
  if(infants&&p.infant_price>0){lines.push(`👶 ${infants} Infant${infants===1?'':'s'} × ${taMoney(p.infant_price,cur)} = ${taMoney(infants*p.infant_price,cur)}`);total+=infants*p.infant_price;}
  return `💰 *Estimated price · ${p.name}*\n${lines.join('\n')}\n*Total: ${taMoney(total,cur)}*\n_${v?'':'Per adult. '}The final price is confirmed by our team (dates and availability)._`;
}
export function tfSummary(state){
  const lines=[];
  if(state.pkg?.name) lines.push(`📦 Package: ${state.pkg.name}`);
  for(const s of state.flow?.steps||[]){
    if(!TF_ASK_TYPES.includes(s.type)||state.answers?.[s.id]==null) continue;
    lines.push(`${s.type==='ask_custom'?'▫️':TF_STEP_META[s.type].icon} ${tfStepLabel(s)}: ${tfAnswerText(s,state.answers[s.id])}`);
  }
  return lines.length?`📝 *Your booking request*\n${lines.join('\n')}`:'';
}
// Lead fields for the booking details (shown in Leads, used by routing and follow-ups).
export function tfQualAnswers(state){
  const out={travel_flow:state.flow?.name||''};
  if(state.pkg?.name){out.package=state.pkg.name;if(state.pkg.destination)out.destination=state.pkg.destination;}
  for(const s of state.flow?.steps||[]){
    const v=state.answers?.[s.id];
    if(v==null) continue;
    if(s.type==='ask_date') out.travel_date=v.date;
    else if(s.type==='ask_travellers'){out.adults=String(v.adults);out.children=String(v.children||0);if(v.infants)out.infants=String(v.infants);if((v.ages||[]).length)out.children_ages=v.ages.join(', ');}
    else if(s.type==='ask_city') out.departure_city=String(v);
    else out[norm(tfStepLabel(s)).replace(/ /g,'_').slice(0,30)||s.id]=String(v);
  }
  return out;
}

// Runs the action steps that are due (package, quote, payment) until the next open question or the
// end. Returns {ask, outputs, end:'handover'|'complete'|null}.
export function tfAdvance(state,pkgAvailable=true){
  const outputs=[];
  for(const s of state.flow?.steps||[]){
    if(TF_ASK_TYPES.includes(s.type)){
      if(tfStepAnswered(s,state)||state.skipped?.[s.id]) continue;
      return {ask:s,outputs,end:null};
    }
    if(state.done?.[s.id]) continue;
    state.done[s.id]=true;
    if(s.type==='send_package'){
      const id=s.package_id||state.pkg?.id;
      if(id&&pkgAvailable) outputs.push({kind:'package',step:s.id,package_id:id,details:s.details!==false,photos:s.photos!==false,pdf:s.pdf===true});
    }else if(s.type==='quote'){
      const q=tfQuote(state);
      if(q) outputs.push({kind:'quote',step:s.id,text:q});
    }else if(s.type==='payment'){
      outputs.push({kind:'payment',step:s.id,text:s.text||DEFAULT_PAYMENT_TEXT,send_qr:s.send_qr!==false});
    }else if(s.type==='handover'){
      const summary=tfSummary(state);
      outputs.push({kind:'handover',step:s.id,text:[summary,s.message||DEFAULT_HANDOVER_TEXT].filter(Boolean).join('\n\n')});
      return {ask:null,outputs,end:'handover'};
    }
  }
  const summary=tfSummary(state);
  outputs.push({kind:'complete',text:[summary,DEFAULT_COMPLETE_TEXT].filter(Boolean).join('\n\n')});
  return {ask:null,outputs,end:'complete'};
}

// One customer message applied to a running flow. ai: tfParseAiReply's result (or null when the
// AI was skipped or failed); direct: tfDirectAnswer's result. Mutates and returns state, plus what
// to send. reply is the text message; outputs are the package / quote / payment / handover parts.
export function tfApplyTurn(state,{ai=null,direct={answers:{}},today=new Date(),pkgAvailable=true,firstTurn=false}={}){
  const steps=state.flow?.steps||[];
  const asked=steps.find(s=>s.id===state.current);
  if(ai?.action==='handover') return {state,action:'handover'};
  if(ai?.action==='cancel') return {state,action:'cancel',reply:ai.answer||ai.reply||''};
  if(ai?.action==='pause'&&!firstTurn){state.paused=true;state.detours=0;return {state,action:'pause'};}
  let progressed=false;
  const merge=(id,val)=>{
    const s=steps.find(x=>x.id===id);
    if(!s||!TF_ASK_TYPES.includes(s.type)) return;
    let v=tfAcceptAnswer(s,val,today);
    if(v==null) return;
    if(s.type==='ask_travellers'){
      const prev=state.answers[s.id];
      if(prev&&prev.adults>=1&&(!v.ages||!v.ages.length)&&prev.ages?.length) v={...v,ages:prev.ages};
      if(prev&&prev.children>0&&v.adults===prev.adults&&!v.children&&v.ages?.length) v={...prev,ages:v.ages.slice(0,prev.children)};
    }
    const before=JSON.stringify(state.answers[s.id]??null);
    state.answers[s.id]=v;
    delete state.skipped[s.id];
    if(JSON.stringify(v)!==before) progressed=true;
  };
  for(const [id,val] of Object.entries(direct?.answers||{})) merge(id,val);
  for(const [id,val] of Object.entries(ai?.answers||{})) merge(id,val);
  // An optional question that was asked and not answered (and not just put aside for a question
  // of their own) is skipped, so the customer is never asked it twice.
  if(asked&&asked.required===false&&!tfStepAnswered(asked,state)&&!ai?.side_question&&!progressed&&!firstTurn) state.skipped[asked.id]=true;
  state.detours=progressed||firstTurn?0:(state.detours||0)+1;
  if(state.detours>=TF_MAX_DETOURS){state.paused=true;state.detours=0;return {state,action:'pause'};}
  const adv=tfAdvance(state,pkgAvailable);
  const lead=ai?.answer||'';
  let reply='',usedAi=false;
  if(adv.ask){
    const q=tfStepQuestion(adv.ask,state);
    // The AI's wording is used when it asks for the same detail the flow needs next and nothing
    // else (package, quote, payment) has to go out in between.
    if(ai?.reply&&ai.ask_step===adv.ask.id&&!adv.outputs.length&&!(adv.ask.type==='ask_travellers'&&q===AGES_QUESTION&&!/age/i.test(ai.reply))){reply=ai.reply;usedAi=true;}
    else reply=[lead,q].filter(Boolean).join('\n\n');
    state.asked[adv.ask.id]=true;
    state.current=adv.ask.id;
  }else{
    reply=lead;
    state.current='';
  }
  return {state,action:adv.end==='handover'?'finished_handover':adv.end?'finished':'continue',ask:adv.ask,outputs:adv.outputs,reply,usedAi,leadText:lead,progressed};
}
// The buttons or list for a question: its options (WhatsApp takes 3 buttons or a 10-row list).
export function tfQuestionRows(step){
  return (step?.options||[]).slice(0,TF_MAX_OPTIONS).map(o=>({title:o,value:o}));
}
export function tfIsContinue(text){
  const t=String(text||'').trim();
  return t===TF_CONTINUE_VALUE||/^(?:▶️\s*)?(?:continue|resume)(?:\s+(?:my\s+)?(?:booking|enquiry|request))?$/i.test(t);
}
export function tfIsCancel(text){
  return /^(?:cancel|cancel (?:my |the |this )?(?:booking|enquiry|request)|stop (?:the )?booking|not interested|exit)$/i.test(String(text||'').trim());
}
export function tfWantsHuman(text){
  return /^(?:👤\s*)?(?:talk|speak|chat|connect)\s+(?:to|with|me to)\s+(?:an?\s+)?(?:agent|human|person|team|consultant|staff)$|^(?:agent|human|call me|need (?:a )?call)$/i.test(String(text||'').trim());
}
