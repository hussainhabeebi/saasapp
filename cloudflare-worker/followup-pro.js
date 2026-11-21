// ── Follow-up V3 · Pro add-ons ───────────────────────────────────────────────────────────────────
// Five opt-in switches on top of Follow-up V3 (followup-v3.js). Every one is OFF by default, so an
// account that never opens them keeps exactly the V3 behaviour it had before:
//   pro_smart_send     — Smart send time+: when a lead has no writing-hour history yet, use the
//                        account's busiest reply hour; nudge 2 also moves to that hour when it still
//                        fits inside the 24-hour WhatsApp window (Klaviyo Smart Send Time, Braze).
//   pro_nba_home       — Next-best-action score (0-100) and the one action to take, for the
//                        "who to contact now" card on Home (Salesforce Einstein, Gong deal boards).
//   pro_objections     — Objection-aware branching: "later / next week / after salary" snoozes the
//                        sequence to that date; price / trust / competitor / timing / family get a
//                        nudge written for that objection even without a Playbook entry, and price /
//                        family nudges carry the quote PDF when that switch is on too (Gong, Kommo).
//   pro_quote_pdf      — Quote / proposal PDF in one tap from the products the lead picked, with
//                        product photos (PandaDoc / Qwilr style), sent into the chat.
//   pro_auto_language  — Follow-ups in the lead's own language: session nudges are translated, and a
//                        template step uses the same template approved in the lead's language when
//                        WhatsApp has one (respond.io, Interakt multi-language templates).
// Pure helpers live here so the sweep, routes and tests share one answer. Nothing here sends.

import {taPrepareImage} from './travel-itinerary.js';

const H=3600000, D=24*H;
const ms=(v)=>{ const t=Date.parse(v||''); return Number.isFinite(t)?t:null; };

export const FP_FLAGS=['pro_smart_send', 'pro_nba_home', 'pro_objections', 'pro_quote_pdf', 'pro_auto_language'];
export const FP_DEFAULTS={pro_smart_send:false, pro_nba_home:false, pro_objections:false, pro_quote_pdf:false, pro_auto_language:false, pro_quote_valid_days:7, pro_quote_note:''};

// ── Smart send time+ ─────────────────────────────────────────────────────────────────────────────
// The account's busiest customer-writing hour, from every lead's hours_json (followup_v3_leads).
// Needs 20+ messages and a clear peak (the best hour holds at least 8% of them) to be trusted.
export function fpAccountHour(stateRows){
  const sum=Array(24).fill(0); let total=0;
  for(const r of stateRows||[]){
    let h=r?.hours_json; if(typeof h==='string'){ try{ h=JSON.parse(h||'{}'); }catch(e){ h=null; } }
    if(!h||typeof h!=='object') continue;
    for(const [k, v] of Object.entries(h)){ const i=Number(k), n=Number(v)||0; if(Number.isInteger(i)&&i>=0&&i<24&&n>0){ sum[i]+=n; total+=n; } }
  }
  if(total<20) return null;
  let best=0; for(let i=1; i<24; i++) if(sum[i]>sum[best]) best=i;
  return sum[best]/total>=0.08?best:null;
}

// ── Objections ───────────────────────────────────────────────────────────────────────────────────
// Keyword fallback for the engine classifier's LastObjectionCategory (price/competitor/timing/trust)
// plus "family" (needs to ask someone), which the classifier has no bucket for. English, Manglish,
// Hinglish, Malayalam, Hindi, Tamil and Arabic phrasing that shows up in real chats.
const OBJ_RULES=[
  ['family', /\b(discuss|consult|talk|check|ask)\w*\s+(with\s+)?(my\s+)?(family|wife|husband|parents?|father|mother|dad|mom|boss|partner|team|manager)\b|\b(family|wife|husband|parents?)\s+(ne|nod|se|oda|kitta)?\s*(chodich|chodikk|poochh|puchh|discuss|ask)|veettil\s+chodich|ghar\s+(pe|par)\s+(baat|pooch)|ഭാര്യ|ഭർത്താവ്|വീട്ടിൽ\s*ചോദി|घर\s*(पर|में)\s*(बात|पूछ)|पत्नी\s*से|عائلت|زوجت/i],
  ['price', /\b(too\s+(costly|expensive|much|high)|expensive|costly|price\s+(is\s+)?(high|too)|budget|discount|cheaper|reduce|best\s+price|last\s+price|final\s+price|any\s+offer|kurach|kurakk|vila\s+kooduthal|mehenga|mahenga|sasta|kam\s+karo|paisa\s+nahi|vilai\s+adhigam)\b|വില\s*കൂടുതൽ|കുറച്ച്|महंगा|सस्ता|कम\s*करो|விலை\s*அதிகம்|غالي|خصم|تخفيض/i],
  ['competitor', /\b(other\s+(company|shop|agency|store|seller)|another\s+(company|shop|agency|store)|compare|comparing|competitor|elsewhere|cheaper\s+(there|elsewhere)|got\s+(a\s+)?(better|lower)\s+(quote|price|offer))\b|दूसरी\s*(कंपनी|दुकान)|വേറെ\s*(കമ്പനി|കട)/i],
  ['trust', /\b(is\s+(this|it)\s+(genuine|legit|real|safe|original)|fake|scam|fraud|trust|reviews?|guarantee|warranty|refund|original\s+product)\b|ഒറിജിനൽ|असली|نصاب|احتيال|ضمان/i],
  ['timing', /\b(later|not\s+now|next\s+(week|month|year)|after\s+(salary|onam|eid|diwali|vacation|holiday|exams?)|busy\s+now|some\s+other\s+time|will\s+let\s+you\s+know|will\s+tell\s+you|think\s+(about\s+it|and\s+tell)|pinne|pinneed|pinnedu|baad\s+mein|baad\s+me|kal\s+bata|sochke|yosichu|appuram)\b|പിന്നെ|പിന്നീട്|बाद\s*में|सोच\s*कर|பிறகு|لاحقا|بعدين/i],
];
export function fpClassifyObjection(text){
  const t=String(text||'').slice(0, 1000);
  if(!t.trim()) return null;
  for(const [cat, re] of OBJ_RULES) if(re.test(t)) return cat;
  return null;
}
// The objection to answer now: the engine classifier's own category wins (it read the whole
// conversation); the keyword pass covers "family" and accounts whose classifier said "none".
export function fpObjectionFor(lead, state){
  const cls=String(lead?.LastObjectionCategory||'').trim().toLowerCase();
  const fromText=fpClassifyObjection(state?.last_text);
  if(fromText==='family') return 'family';
  if(['price', 'competitor', 'timing', 'trust'].includes(cls)) return cls;
  return fromText;
}
// What to say for each objection when the account has no Playbook answer for it — the approach,
// never invented facts (AI is told to use only what the business wrote in its prompt / catalog).
export const FP_OBJECTION_GUIDE={
  price:'They feel the price is high. Acknowledge it, restate the value in one line, and offer to share options in a lower budget or a part-payment / EMI option if the business offers one. If a quote is attached, mention it.',
  family:'They want to discuss with family / a decision-maker first. Respect that, and offer a short summary they can share (mention the attached quote if there is one). Ask when would be a good time to check back.',
  competitor:'They are comparing with another provider. Do not criticise anyone; mention one or two genuine strengths of this business and offer to answer any comparison question.',
  trust:'They are unsure whether the business is genuine. Reassure calmly, offer reviews, a call, or a visit, and mention any guarantee only if the business has one.',
  timing:'They said now is not a good time. Keep it light, no pressure, and ask when would suit them better.',
};

// "Later" with a date → when to resume. Understands tomorrow / day after / tonight / this
// evening / weekend / next week / next month / in N days|weeks|months / after salary (1st of next
// month) / weekday names, in English plus common Manglish / Hinglish words. Returns ms at 10:00
// local time (18:00 for "evening"/"tonight"), or null. `tz` is the client's timezone.
const WEEKDAYS={sun:0, sunday:0, mon:1, monday:1, tue:2, tues:2, tuesday:2, wed:3, wednesday:3, thu:4, thur:4, thurs:4, thursday:4, fri:5, friday:5, sat:6, saturday:6};
function localYmd(msv, tz){
  const p=new Intl.DateTimeFormat('en-CA', {timeZone:tz, year:'numeric', month:'2-digit', day:'2-digit', weekday:'short'}).formatToParts(new Date(msv));
  const g=t=>p.find(x=>x.type===t)?.value;
  return {y:Number(g('year')), m:Number(g('month')), d:Number(g('day')), dow:['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday'))};
}
// Local wall-clock (y,m,d,h) in tz → UTC ms (two-pass offset correction, DST-safe enough here).
function zonedMs(y, m, d, h, tz){
  let guess=Date.UTC(y, m-1, d, h);
  for(let i=0; i<2; i++){
    const p=new Intl.DateTimeFormat('en-US', {timeZone:tz, year:'numeric', month:'numeric', day:'numeric', hour:'numeric', minute:'numeric', hourCycle:'h23'}).formatToParts(new Date(guess));
    const g=t=>Number(p.find(x=>x.type===t)?.value);
    const asUtc=Date.UTC(g('year'), g('month')-1, g('day'), g('hour'), g('minute'));
    guess+=Date.UTC(y, m-1, d, h)-asUtc;
  }
  return guess;
}
export function fpParseLater(text, now=Date.now(), tz='Asia/Kolkata'){
  const t=String(text||'').toLowerCase().slice(0, 600);
  if(!t.trim()) return null;
  let zone=tz; try{ new Intl.DateTimeFormat('en-US', {timeZone:zone}); }catch(e){ zone='Asia/Kolkata'; }
  const today=localYmd(now, zone);
  const at=(addDays, hour=10)=>{ const base=new Date(Date.UTC(today.y, today.m-1, today.d+addDays)); return zonedMs(base.getUTCFullYear(), base.getUTCMonth()+1, base.getUTCDate(), hour, zone); };
  const evening=/\b(evening|tonight|night)\b|vaikunneram|raathri|shaam|രാത്രി|വൈകുന്നേരം|शाम/.test(t);
  let r=null;
  let m;
  if((m=/\b(?:in|after)\s+(\d{1,2}|a|one|two|three|four|five|six)\s+(day|days|week|weeks|month|months)\b/.exec(t))){
    const n={a:1, one:1, two:2, three:3, four:4, five:5, six:6}[m[1]]??Number(m[1]);
    const unit=m[2].startsWith('day')?1:m[2].startsWith('week')?7:30;
    r=at(Math.min(n*unit, 180));
  }
  else if(/\b(day\s+after\s+tomorrow|parso|maranaal|mattannal)\b|മറ്റന്നാൾ|परसों/.test(t)) r=at(2, evening?18:10);
  else if(/\b(tomorrow|tmrw|tmr|nale|naale|kal\s+(bata|baat|call|message|msg)|naalai)\b|നാളെ|कल|நாளை|بكرة|غدا/.test(t)) r=at(1, evening?18:10);
  else if(/\b(after\s+(salary|payday|pay\s*day|month\s*end)|salary\s+(varumbo|aane|aaya|aate))\b|ശമ്പളം/.test(t)){ const nm=new Date(Date.UTC(today.y, today.m, 1)); r=zonedMs(nm.getUTCFullYear(), nm.getUTCMonth()+1, 2, 10, zone); }
  else if(/\b(next\s+month|adutha\s+maasam|agle\s+mahine)\b|അടുത്ത\s*മാസം|अगले\s*महीने|الشهر\s*القادم/.test(t)){ const nm=new Date(Date.UTC(today.y, today.m, 1)); r=zonedMs(nm.getUTCFullYear(), nm.getUTCMonth()+1, 1, 10, zone); }
  else if(/\b(next\s+week|adutha\s+aazhcha|agle\s+hafte)\b|അടുത്ത\s*ആഴ്ച|अगले\s*हफ्ते|الأسبوع\s*القادم/.test(t)) r=at(((8-today.dow)%7)||7); // next Monday
  else if(/\b(this\s+)?weekend\b/.test(t)) r=at(((6-today.dow+7)%7)||7);
  else if((m=/\b(?:on|by|next|this|coming)\s+(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)\b/.exec(t))){
    const want=WEEKDAYS[m[1]]; let add=(want-today.dow+7)%7; if(add===0) add=7; r=at(add, evening?18:10);
  }
  else if(evening && /\b(call|message|msg|tell|talk|reply|bata|parayam)\b/.test(t)) r=at(0, 18);
  if(r===null || r<=now+30*60000) return null;
  return Math.min(r, now+180*D);
}

// ── Language ─────────────────────────────────────────────────────────────────────────────────────
const LANG_NAMES={en:'English', ml:'Malayalam', hi:'Hindi', ta:'Tamil', te:'Telugu', kn:'Kannada', bn:'Bengali', mr:'Marathi', gu:'Gujarati', pa:'Punjabi', ur:'Urdu',
  ar:'Arabic', fr:'French', es:'Spanish', de:'German', pt:'Portuguese', id:'Indonesian', ms:'Malay', tr:'Turkish', ru:'Russian', zh:'Chinese', si:'Sinhala', ne:'Nepali', fa:'Persian', sw:'Swahili', th:'Thai', vi:'Vietnamese'};
export function fpLangName(code){ return LANG_NAMES[String(code||'').toLowerCase().slice(0, 2)]||''; }
// Script-based detection for the cases that matter most here; returns null for Latin text (the
// engine classifier's per-message language covers Manglish / Hinglish written in English letters).
export function fpScriptLang(text){
  const t=String(text||'');
  if(/[\u0D00-\u0D7F]/.test(t)) return 'ml';
  if(/[\u0B80-\u0BFF]/.test(t)) return 'ta';
  if(/[\u0C00-\u0C7F]/.test(t)) return 'te';
  if(/[\u0C80-\u0CFF]/.test(t)) return 'kn';
  if(/[\u0980-\u09FF]/.test(t)) return 'bn';
  if(/[\u0A80-\u0AFF]/.test(t)) return 'gu';
  if(/[\u0A00-\u0A7F]/.test(t)) return 'pa';
  if(/[\u0900-\u097F]/.test(t)) return 'hi';
  if(/[\u0600-\u06FF]/.test(t)) return /[\u067E\u0686\u0698\u06AF\u06A9\u06CC]/.test(t)&&/[\u0679\u0688\u0691\u06BA\u06BE\u06C1\u06D2]/.test(t)?'ur':'ar';
  if(/[\u0E00-\u0E7F]/.test(t)) return 'th';
  if(/[\u0400-\u04FF]/.test(t)) return 'ru';
  return null;
}
// The language to follow up in: the latest message's detected language (stored at inbound), else
// the lead's Language column, else the account language. Two-letter lower-case.
export function fpLeadLanguage(lead, state, c){
  const pick=v=>{ const s=String(v||'').trim().toLowerCase().slice(0, 2); return /^[a-z]{2}$/.test(s)?s:''; };
  return pick(state?.last_lang)||pick(lead?.Language)||pick(c?.language)||'en';
}
// Meta template language codes to try for a lead's language (the template's own code first).
const META_LANG={en:['en', 'en_US', 'en_GB'], ar:['ar'], es:['es', 'es_ES', 'es_MX'], pt:['pt_BR', 'pt_PT'], zh:['zh_CN', 'zh_HK', 'zh_TW'], fr:['fr'], de:['de'], ms:['ms'], id:['id'],
  hi:['hi'], ml:['ml'], ta:['ta'], te:['te'], kn:['kn'], bn:['bn'], mr:['mr'], gu:['gu'], pa:['pa'], ur:['ur'], tr:['tr'], ru:['ru'], th:['th'], vi:['vi'], fa:['fa'], sw:['sw']};
export function fpTemplateLanguages(lang, current){
  const l=String(lang||'').toLowerCase().slice(0, 2);
  const cur=String(current||'').toLowerCase();
  if(!l || cur.startsWith(l)) return [];
  return (META_LANG[l]||[l]).filter(x=>x.toLowerCase()!==cur);
}

// ── Next-best-action score ───────────────────────────────────────────────────────────────────────
const CLOSED=/^(won|converted|lost|closed|closed_won|closed_lost|opt out|booked|consultation_booked|visit_booked|appt_booked)$/i;
const HOT_STAGES=/quot|proposal|payment|negotiat|demo|invoice|deposit|advance|token|checkout|site_visit|visit_scheduled/i;
const ACTION_FOR_OBJECTION={
  price:'Send the quote with a budget option or part-payment', family:'Share a quote they can show the family, and agree a call-back time',
  competitor:'Show what makes you different — offer a quick call', trust:'Share reviews / guarantee and offer a call', timing:'Agree a date to check back',
};
// in: {lead, state (followup_v3_leads row), sends ([{sent_at, replied_at}]), now}
// out: null for closed / opted-out leads, else {score 0-100, band, action, reasons[], waiting_hours}
export function fpNbaScore({lead, state=null, sends=[], now=Date.now()}={}){
  if(!lead) return null;
  const stage=String(lead.Stage||'');
  if(lead.OptOut==='Yes' || CLOSED.test(stage)) return null;
  const lastCust=ms(lead.LastCustomerMsgAt)||ms(lead.LastMsgAt)||ms(lead.Date)||ms(lead.CreatedAt);
  if(!lastCust) return null;
  const agentAt=ms(lead.LastAgentMsgAt)||0;
  const lastSend=Math.max(0, ...(sends||[]).map(s=>ms(s.sent_at)||0));
  const age=(now-lastCust)/H;
  const reasons=[]; let score=0;
  // Recency — the strongest single signal for WhatsApp leads.
  if(age<2){ score+=30; reasons.push('wrote in the last 2h'); }
  else if(age<24){ score+=22; reasons.push('wrote today'); }
  else if(age<72){ score+=12; }
  else if(age<168){ score+=5; }
  // Waiting on your team: handed over to a person, and the customer wrote after the team's last
  // reply. (Bot replies don't set LastAgentMsgAt, so bot-handled chats never count as "waiting".)
  const handedOver=lead.Handover==='Yes' || stage==='human_handover';
  const waiting=handedOver && lastCust>agentAt+60000 && lastCust>lastSend;
  const waitingHours=waiting?Math.max(0, Math.round(age)):0;
  if(waiting && age<24){ score+=25; reasons.push(`waiting for your team ${waitingHours<1?'<1':waitingHours}h`); }
  // Engagement.
  const repliedRecently=(sends||[]).some(s=>ms(s.replied_at)&&now-(ms(s.replied_at)||0)<14*D);
  if(repliedRecently){ score+=12; reasons.push('replied to a follow-up'); }
  let msgs=0; try{ const h=typeof state?.hours_json==='string'?JSON.parse(state.hours_json||'{}'):(state?.hours_json||{}); msgs=Object.values(h||{}).reduce((a, v)=>a+(Number(v)||0), 0); }catch(e){}
  if(msgs>=10){ score+=10; reasons.push(`${msgs} messages`); } else if(msgs>=4) score+=6; else if(msgs>=1) score+=2;
  // Deal signals.
  const wp=Number(lead.WinProbability);
  if(Number.isFinite(wp) && wp>0){ score+=Math.round(Math.min(100, wp)*0.18); if(wp>=60) reasons.push(`win chance ${Math.round(wp)}%`); }
  const sc=String(lead.Score||'');
  if(/hot/i.test(sc)){ score+=8; reasons.push('hot lead'); } else if(/warm/i.test(sc)) score+=4;
  if(HOT_STAGES.test(stage)){ score+=12; reasons.push(`stage: ${stage.replace(/_/g, ' ')}`); }
  if(Number(lead.DealValue)>0) score+=4;
  const sent=String(lead.Sentiment||'');
  if(/positive/i.test(sent)) score+=5; else if(/frustrated|negative/i.test(sent)){ score-=6; reasons.push(`sentiment: ${sent.toLowerCase()}`); }
  const objection=fpObjectionFor(lead, state);
  if(objection) reasons.push(`objection: ${objection}`);
  const snooze=ms(state?.snooze_until);
  if(snooze && snooze>now){ score-=15; reasons.push('asked to talk later'); }
  if(waiting && age<24) score=Math.max(score, 72); // a customer waiting on a person is always top of the list
  score=Math.max(0, Math.min(100, Math.round(score)));
  const band=score>=70?'critical':score>=45?'warm':score>=25?'nurture':'cold';
  // One action, most urgent first.
  const left=Math.max(1, Math.round(24-age));
  let action;
  if(waiting && age<24) action=`Reply now — they're waiting for your team (WhatsApp window closes in ${left}h)`;
  else if(waiting) action='Reply now — they wrote after your last reply (send a template: the 24h window is closed)';
  else if(snooze && snooze>now) action=`Check back ${new Date(snooze).toISOString().slice(0, 10)} as they asked`;
  else if(objection) action=ACTION_FOR_OBJECTION[objection];
  else if(repliedRecently) action='Call now — they replied to a follow-up';
  else if(HOT_STAGES.test(stage)) action=`Ask for the decision — send the payment / booking link${age<24?' while the chat is open':''}`;
  else if(age<24) action=`Message now while the WhatsApp window is open (${left}h left)`;
  else if(age>=168) action='Let follow-ups re-engage, or try a call';
  else action='Send a template follow-up (the 24h window is closed)';
  return {score, band, action, reasons:reasons.slice(0, 4), waiting_hours:waitingHours, objection:objection||null};
}

// ── Quote / proposal PDF ─────────────────────────────────────────────────────────────────────────
const norm=s=>String(s||'').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const STOP=new Set(['the', 'a', 'an', 'of', 'for', 'and', 'with', 'in', 'to', 'my', 'your', 'i', 'want', 'need', 'price', 'details', 'pls', 'please']);
// Products the lead chose: an exact SKU (LastProductSku) wins, then names the lead's
// InterestedProduct / Brand / ProductCategory point to (word overlap), best first. Max `limit`.
export function fpMatchProducts(products, lead, limit=3){
  const list=(products||[]).filter(p=>p&&String(p.name||'').trim());
  const sku=String(lead?.LastProductSku||'').trim().toLowerCase();
  const out=[]; const seen=new Set();
  const add=p=>{ const k=String(p.id??p.name); if(!seen.has(k)){ seen.add(k); out.push(p); } };
  if(sku) list.filter(p=>String(p.sku||'').trim().toLowerCase()===sku).forEach(add);
  const wanted=[lead?.InterestedProduct, lead?.Brand, lead?.ProductCategory].map(norm).filter(Boolean);
  if(wanted.length){
    const scored=list.map(p=>{
      const name=norm(p.name), words=new Set(name.split(' ').filter(w=>w.length>1&&!STOP.has(w)));
      const cat=norm(p.category);
      let s=0;
      wanted.forEach((w, wi)=>{
        if(!w) return;
        if(name===w) s+=100;
        else if(name.includes(w)||w.includes(name)) s+=40;
        const ww=w.split(' ').filter(x=>x.length>1&&!STOP.has(x));
        const hit=ww.filter(x=>words.has(x)).length;
        if(ww.length) s+=hit/ww.length*30*(wi===0?1:0.5);
        if(cat && (cat===w || w.includes(cat))) s+=wi===2?15:5;
      });
      return {p, s};
    }).filter(x=>x.s>=15).sort((a, b)=>b.s-a.s);
    scored.forEach(x=>add(x.p));
  }
  return out.slice(0, limit);
}
// One catalog row (ecom products, travel packages…) → what the quote needs.
export function fpQuoteItem(p, {qty=1, currency=''}={}){
  const images=[p.image_url, p.image_url_1, p.image_url_2, p.image_url_3, p.image_url_4, p.image_url_5, ...(Array.isArray(p.images)?p.images:[])]
    .map(u=>String(u||'').trim()).filter(u=>/^https?:\/\//i.test(u));
  const price=Number(p.sell_price)>0?Number(p.sell_price):Number(p.price)>0?Number(p.price):Number(p.base_price)>0?Number(p.base_price):0;
  return {id:p.id??p.Id??null, name:String(p.name||'').trim().slice(0, 120), sku:String(p.sku||'').trim().slice(0, 60),
    description:String(p.description||p.short_label||p.notes||'').replace(/\s+/g, ' ').trim().slice(0, 400),
    price, currency:String(p.currency||currency||'').trim().slice(0, 6), qty:Math.max(1, Math.min(999, Math.round(Number(qty)||1))),
    images:[...new Set(images)].slice(0, 3)};
}
export function fpQuoteTotals(items, discount=0){
  const subtotal=(items||[]).reduce((a, it)=>a+(Number(it.price)||0)*(Number(it.qty)||1), 0);
  const disc=Math.max(0, Math.min(subtotal, Number(discount)||0));
  return {subtotal:Math.round(subtotal*100)/100, discount:Math.round(disc*100)/100, total:Math.round((subtotal-disc)*100)/100};
}
export function fpQuoteNumber(leadId, now=Date.now()){
  const d=new Date(now);
  return `Q-${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}-${String(leadId||0).slice(-5)}`;
}
export function fpQuoteFileName(quoteNo){ return `Quotation-${String(quoteNo||'quote').replace(/[^a-z0-9-]+/gi, '-')}.pdf`; }

async function fetchImage(url, fetchImpl, timeoutMs){
  if(!/^https?:\/\//i.test(String(url||''))) return null;
  const ctrl=new AbortController(), t=setTimeout(()=>ctrl.abort(), timeoutMs);
  try{
    const r=await fetchImpl(url, {signal:ctrl.signal});
    if(!r.ok) return null;
    const buf=new Uint8Array(await r.arrayBuffer());
    return buf.length<=3e6?await taPrepareImage(buf):null;
  }catch(e){ return null; }finally{ clearTimeout(t); }
}
// Product photos (first image per item, plus up to 2 more for the first item) and the logo.
// JPEG and PNG only (WEBP/GIF are left out; the card then shows without a photo).
export async function fpFetchQuoteAssets(items, {logoUrl='', fetchImpl=globalThis.fetch, timeoutMs=5000}={}){
  const jobs=[];
  const photos=new Map();
  (items||[]).slice(0, 12).forEach((it, i)=>{
    (it.images||[]).slice(0, i===0?3:1).forEach((u, k)=>jobs.push(fetchImage(u, fetchImpl, timeoutMs).then(img=>{ if(img) photos.set(`${i}:${k}`, img); })));
  });
  let logo=null;
  if(logoUrl) jobs.push(fetchImage(logoUrl, fetchImpl, timeoutMs).then(img=>{ logo=img; }));
  await Promise.all(jobs);
  return {logo, photos};
}

// Helvetica widths (ASCII 32-126) for wrapping; Standard Type1 fonts carry WinAnsi only, so text
// is kept to Latin-1 (the chat message that carries the PDF is in the lead's own language).
const HW=[278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const textWidth=(s, size, bold)=>{ let w=0; for(const ch of s){ const c=ch.charCodeAt(0); w+=c>=32&&c<=126?HW[c-32]:556; } return w*size/1000*(bold?1.07:1); };
export const fpPdfSafe=s=>String(s||'').replace(/₹/g, 'INR ').replace(/€/g, 'EUR ').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/•/g, '-')
  .normalize('NFC').replace(/[^\x20-\x7E\xA0-\xFF\n]/g, '').replace(/[ \t]+/g, ' ');
const esc=s=>s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/[\xA0-\xFF]/g, ch=>'\\'+ch.charCodeAt(0).toString(8).padStart(3, '0'));
function wrap(text, size, bold, width, maxLines=Infinity){
  const lines=[];
  for(const para of fpPdfSafe(text).split('\n')){
    let line='';
    for(const word of para.split(' ').filter(Boolean)){
      let w=word;
      while(textWidth(w, size, bold)>width){ let cut=w.length; while(cut>1&&textWidth(w.slice(0, cut), size, bold)>width) cut--; if(line){ lines.push(line); line=''; } lines.push(w.slice(0, cut)); w=w.slice(cut); }
      const next=line?`${line} ${w}`:w;
      if(textWidth(next, size, bold)>width){ lines.push(line); line=w; } else line=next;
    }
    lines.push(line);
  }
  if(lines.length>maxLines){ const cut=lines.slice(0, maxLines); cut[maxLines-1]=(cut[maxLines-1]||'').replace(/\s*\S+$/, '')+'...'; return cut; }
  return lines;
}
function hexRgb(hex, fallback){
  const m=/^#?([0-9a-f]{6})$/i.exec(String(hex||'').trim());
  return m?[0, 2, 4].map(i=>parseInt(m[1].slice(i, i+2), 16)/255):fallback;
}
export function fpMoney(n, cur){
  const v=Number(n)||0;
  const s=v.toLocaleString('en-US', {minimumFractionDigits:v%1?2:0, maximumFractionDigits:2});
  return `${fpPdfSafe(String(cur||'').trim())||''}${cur?' ':''}${s}`.trim();
}

// A4 quotation (Uint8Array): header band with logo + business, quote number / date / valid-until,
// "Prepared for", one card per product with its photo(s), description, qty × price, then subtotal,
// discount, total, notes and a footer. `assets` from fpFetchQuoteAssets (all optional).
export function fpBuildQuotePdf({items=[], business='', phone='', email='', address='', leadName='', leadPhone='', quoteNo='', date=Date.now(), validDays=7, currency='', discount=0, note='', accent='#0F7377', assets={}}={}){
  const W=595, Hh=842, MX=44, CW=W-MX*2, BOTTOM=58;
  const AC=hexRgb(accent, [0.06, 0.45, 0.47]).map(v=>v.toFixed(3)).join(' ');
  const cur=currency||items.find(i=>i.currency)?.currency||'';
  const totals=fpQuoteTotals(items, discount);
  const images=[]; const imgName=img=>{ if(!img) return null; let i=images.indexOf(img); if(i<0){ images.push(img); i=images.length-1; } return `Im${i+1}`; };
  const pages=[]; let ops=[], y=0;
  const o=s=>ops.push(s);
  const txt=(x, yy, s, size, bold, rgb='0.13 0.15 0.19')=>o(`BT ${rgb} rg /${bold?'F2':'F1'} ${size} Tf ${x.toFixed(1)} ${yy.toFixed(1)} Td (${esc(fpPdfSafe(s))}) Tj ET`);
  const rtxt=(xr, yy, s, size, bold, rgb)=>txt(xr-textWidth(fpPdfSafe(s), size, bold), yy, s, size, bold, rgb);
  const rect=(x, yy, w, h, rgb)=>o(`${rgb} rg ${x.toFixed(1)} ${yy.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re f`);
  const round=(x, yy, w, h, r, rgb)=>{ const k=0.5523*r; o(`${rgb} rg ${x+r} ${yy} m ${x+w-r} ${yy} l ${x+w-r+k} ${yy} ${x+w} ${yy+r-k} ${x+w} ${yy+r} c ${x+w} ${yy+h-r} l ${x+w} ${yy+h-r+k} ${x+w-r+k} ${yy+h} ${x+w-r} ${yy+h} c ${x+r} ${yy+h} l ${x+r-k} ${yy+h} ${x} ${yy+h-r+k} ${x} ${yy+h-r} c ${x} ${yy+r} l ${x} ${yy+r-k} ${x+r-k} ${yy} ${x+r} ${yy} c h f`); };
  const image=(img, x, yy, w, h, fit=false)=>{
    const n=imgName(img); if(!n) return;
    const s=fit?Math.min(w/img.w, h/img.h):Math.max(w/img.w, h/img.h), dw=img.w*s, dh=img.h*s;
    o(`q ${x.toFixed(1)} ${yy.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re W n ${dw.toFixed(2)} 0 0 ${dh.toFixed(2)} ${(x+(w-dw)/2).toFixed(2)} ${(yy+(h-dh)/2).toFixed(2)} cm /${n} Do Q`);
  };
  const biz=fpPdfSafe(business).trim()||'Quotation';
  const header=first=>{
    const hh=first?92:46;
    rect(0, Hh-hh, W, hh, AC);
    let tx=MX;
    if(assets.logo){ const bh=first?60:30, bw=bh*1.6, by=Hh-hh+(hh-bh)/2; round(MX, by, bw, bh, 6, '1 1 1'); image(assets.logo, MX+4, by+4, bw-8, bh-8, true); tx=MX+bw+14; }
    if(first){
      txt(tx, Hh-40, biz.slice(0, 42), 19, true, '1 1 1');
      const contact=[phone, email].map(fpPdfSafe).filter(Boolean).join('   |   ');
      if(contact) txt(tx, Hh-58, contact.slice(0, 70), 9.5, false, '0.88 0.96 0.96');
      if(address) txt(tx, Hh-72, fpPdfSafe(address).replace(/\n/g, ', ').slice(0, 80), 8.5, false, '0.88 0.96 0.96');
      rtxt(W-MX, Hh-40, 'QUOTATION', 16, true, '1 1 1');
    } else txt(tx, Hh-29, `${biz.slice(0, 40)}  |  Quotation ${fpPdfSafe(quoteNo)}`, 10, true, '1 1 1');
    y=Hh-hh;
  };
  const newPage=()=>{ pages.push(ops); ops=[]; header(false); y-=20; };
  const need=h=>{ if(y-h<BOTTOM) newPage(); };
  header(true);
  // Meta row: prepared for / quote no / date / valid until.
  y-=22;
  const dt=new Date(date), until=new Date(Number(date)+Math.max(1, validDays)*D);
  const fmt=d=>d.toLocaleDateString('en-GB', {day:'2-digit', month:'short', year:'numeric'});
  const boxes=[['PREPARED FOR', [leadName, leadPhone].map(fpPdfSafe).filter(Boolean).join('  ·  ')||'Customer'], ['QUOTE NO.', quoteNo], ['DATE', fmt(dt)], ['VALID UNTIL', fmt(until)]];
  const gap=10, widths=[CW*0.34, CW*0.27, CW*0.19, CW*0.20].map(w=>w-gap*3/4);
  let bx=MX;
  boxes.forEach(([k, v], i)=>{
    round(bx, y-48, widths[i], 48, 8, '0.95 0.97 0.97');
    txt(bx+11, y-18, k, 7.5, true, '0.45 0.5 0.55');
    const size=textWidth(fpPdfSafe(v), 10.5, true)<=widths[i]-20?10.5:9;
    txt(bx+11, y-35, wrap(v, size, true, widths[i]-20, 1)[0], size, true);
    bx+=widths[i]+gap;
  });
  y-=66;
  // Product cards.
  const photo=(i, k)=>assets.photos?.get?.(`${i}:${k}`)||null;
  items.forEach((it, i)=>{
    const ph=photo(i, 0);
    const extras=[photo(i, 1), photo(i, 2)].filter(Boolean);
    const imgW=ph?150:0, tx=MX+14+(ph?imgW+14:0), tw=CW-28-(ph?imgW+14:0);
    const nameL=wrap(it.name, 13, true, tw, 2);
    const descL=it.description?wrap(it.description, 9.5, false, tw, 5):[];
    const textH=nameL.length*16+(it.sku?13:0)+descL.length*12.5+40;
    const cardH=Math.max(ph?120:0, textH)+20+(extras.length?78:0);
    need(cardH+12);
    round(MX, y-cardH, CW, cardH, 10, '0.975 0.98 0.985');
    if(ph) image(ph, MX+10, y-10-120, imgW, 120);
    let ty=y-26;
    nameL.forEach(l=>{ txt(tx, ty, l, 13, true); ty-=16; });
    if(it.sku){ txt(tx, ty, `SKU: ${it.sku}`, 8, false, '0.45 0.5 0.55'); ty-=13; }
    descL.forEach(l=>{ txt(tx, ty, l, 9.5, false, '0.32 0.35 0.4'); ty-=12.5; });
    ty-=6;
    const line=`${it.qty} x ${fpMoney(it.price, it.currency||cur)}`;
    txt(tx, ty, line, 10, false, '0.32 0.35 0.4');
    rtxt(MX+CW-14, ty, fpMoney(it.price*it.qty, it.currency||cur), 12.5, true, AC);
    if(extras.length){ const ey=y-cardH+10; extras.forEach((img, k)=>{ image(img, MX+10+k*(98+8), ey, 98, 66); }); }
    y-=cardH+12;
  });
  // Totals, kept on the same page as the terms below them.
  const terms=[note, `This quotation is valid until ${fmt(until)}. Prices and availability are confirmed at the time of booking / order.`].map(s=>String(s||'').trim()).filter(Boolean).join('\n');
  const termLines=wrap(terms, 9, false, CW);
  need((totals.discount?92:74)+30+termLines.length*13);
  y-=4;
  const tw=230, tx0=MX+CW-tw;
  const row=(label, value, bold=false, rgb)=>{ txt(tx0+12, y-14, label, bold?12:10, bold, rgb||'0.32 0.35 0.4'); rtxt(MX+CW-12, y-14, value, bold?14:10.5, bold, rgb); y-=bold?26:18; };
  const boxH=totals.discount?92:74, boxBottom=y-boxH;
  round(tx0, boxBottom, tw, boxH, 10, '0.95 0.97 0.97');
  y-=8;
  row('Subtotal', fpMoney(totals.subtotal, cur));
  if(totals.discount) row('Discount', '- '+fpMoney(totals.discount, cur), false, '0.09 0.55 0.3');
  row('Total', fpMoney(totals.total, cur), true, AC);
  y=boxBottom-18;
  // Notes / terms.
  for(const l of termLines){ need(13); txt(MX, y-9, l, 9, false, '0.42 0.45 0.5'); y-=13; }
  pages.push(ops);
  const total=pages.length;
  pages.forEach((p, i)=>{
    p.push(`${AC} rg 0 0 ${W} 4 re f`);
    p.push(`0.86 0.88 0.9 RG 0.6 w ${MX} 46 m ${W-MX} 46 l S`);
    p.push(`BT 0.42 0.45 0.5 rg /F2 8.5 Tf ${MX} 30 Td (${esc(fpPdfSafe([biz, phone].filter(Boolean).join('   |   ')).slice(0, 90))}) Tj ET`);
    const label=`Page ${i+1} of ${total}`;
    p.push(`BT 0.42 0.45 0.5 rg /F1 8.5 Tf ${(W-MX-textWidth(label, 8.5)).toFixed(1)} 30 Td (${label}) Tj ET`);
  });
  // Assemble.
  const enc=new TextEncoder();
  const parts=[]; let pos=0; const offs=[];
  const put=x=>{ const b=typeof x==='string'?enc.encode(x):x; parts.push(b); pos+=b.length; };
  const objs=[]; const reserve=()=>{ objs.push(null); return objs.length; };
  const cat=reserve(), pagesObj=reserve(), f1=reserve(), f2=reserve();
  const imgObjs=images.map(img=>{ const id=reserve(); const sm=img.smask?reserve():0; return {img, id, sm}; });
  const pageObjs=pages.map(()=>({page:reserve(), content:reserve()}));
  objs[cat-1]=`<</Type /Catalog /Pages ${pagesObj} 0 R>>`;
  objs[pagesObj-1]=`<</Type /Pages /Kids [${pageObjs.map(p=>`${p.page} 0 R`).join(' ')}] /Count ${total}>>`;
  objs[f1-1]='<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding>>';
  objs[f2-1]='<</Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding>>';
  imgObjs.forEach(({img, id, sm})=>{
    objs[id-1]={dict:`<</Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /${img.cs} /BitsPerComponent 8 /Filter /${img.filter}${img.decode?' /Decode [1 0 1 0 1 0 1 0]':''}${sm?` /SMask ${sm} 0 R`:''} /Length ${img.data.length}>>`, data:img.data};
    if(sm) objs[sm-1]={dict:`<</Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${img.smask.length}>>`, data:img.smask};
  });
  const xobjs=imgObjs.map((x, i)=>`/Im${i+1} ${x.id} 0 R`).join(' ');
  const res=`<</Font <</F1 ${f1} 0 R /F2 ${f2} 0 R>>${xobjs?` /XObject <<${xobjs}>>`:''}>>`;
  pages.forEach((p, i)=>{
    const content=enc.encode(p.join('\n'));
    objs[pageObjs[i].page-1]=`<</Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${W} ${Hh}] /Contents ${pageObjs[i].content} 0 R /Resources ${res}>>`;
    objs[pageObjs[i].content-1]={dict:`<</Length ${content.length}>>`, data:content};
  });
  put('%PDF-1.4\n');
  objs.forEach((ob, i)=>{
    offs[i+1]=pos;
    if(typeof ob==='string') put(`${i+1} 0 obj\n${ob}\nendobj\n`);
    else { put(`${i+1} 0 obj\n${ob.dict}\nstream\n`); put(ob.data); put('\nendstream\nendobj\n'); }
  });
  const xref=pos;
  put(`xref\n0 ${objs.length+1}\n0000000000 65535 f \n`);
  for(let n=1; n<=objs.length; n++) put(`${String(offs[n]).padStart(10, '0')} 00000 n \n`);
  put(`trailer\n<</Size ${objs.length+1} /Root ${cat} 0 R>>\nstartxref\n${xref}\n%%EOF\n`);
  const out=new Uint8Array(pos); let at=0; for(const b of parts){ out.set(b, at); at+=b.length; }
  return out;
}
