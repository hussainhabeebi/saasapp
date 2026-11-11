/* ═══════════════════════════════════════════════════════════════════════════
   FLYINDO CHAT STYLE — guided, buttons-only travel booking
   Flights → ⚙️ Travel Settings → 🧭 Chat Style → "Flyindo". Optional and off by default.
   Instead of answering questions, the bot walks every customer through one booking request
   and then hands the chat to a travel consultant:

     1. Welcome            "Hello! 👋 Welcome to {agency}! … Where would you like to travel?"
     2. Destination        WhatsApp list of the agency's destinations (up to 10)
     3. Travel date        list: next 7 days or a month → week → day; a typed date also works.
                           Only real future dates up to FLYINDO_MAX_DAYS_AHEAD are accepted.
     4. Travellers         adults (list) → children (list) → each child's age (when enabled)
     5. Handover           booking summary, then the chat goes to the team (Stage human_handover)

   Every step is a tap. AI upgrade (Chat Style → "AI answers questions", on by default): anything
   the customer types that isn't a clean answer — a question about prices, a package, visas,
   hotels, a reply to a staff message — is answered by the AI from the bot prompt and knowledge
   base, and the customer is then taken back to the current step's options. A typed message that
   also gives the step's answer ("Goa package price?") moves the booking on. Without the AI (off,
   no key, an error) the same options are shown again, as before.
   Pure (no I/O) — storage, the AI call and WhatsApp sends live in worker.js.
   ═══════════════════════════════════════════════════════════════════════════ */

export const FLYINDO_STYLE='flyindo';
export const FLYINDO_PREFIX='FLY:';
// Chat Style "Greetings only": the customer's first message gets the Flyindo welcome (no menu),
// the chat is handed to the team and the bot stays silent for that customer from then on.
export const GREETING_STYLE='greeting';
export const CHAT_STYLES=[FLYINDO_STYLE,GREETING_STYLE];
export const GREETING_TEXT_MAX=1000;
export const FLYINDO_MAX_DESTINATIONS=10;
export const FLYINDO_MAX_DAYS_AHEAD=550;   // ~18 months
export const FLYINDO_MAX_ADULTS=9;         // the last row is "10 or more"
export const FLYINDO_MAX_CHILDREN=6;
export const FLYINDO_STATE_TTL_MS=24*60*60*1000;

export const FLYINDO_DEFAULT_DESTINATIONS=[
  {emoji:'🏔️',name:'Munnar'},
  {emoji:'🏖️',name:'Goa'},
  {emoji:'🌴',name:'Wayanad'},
  {emoji:'🏝️',name:'Maldives'},
  {emoji:'🏔️',name:'Kashmir'},
];
// Common pricing bands: infants travel almost free, children pay a child fare, 12+ pay as adults.
export const FLYINDO_CHILD_AGES=[
  {id:'0-1',title:'Below 2 years',description:'Infant'},
  {id:'2-4',title:'2 – 4 years'},
  {id:'5-7',title:'5 – 7 years'},
  {id:'8-11',title:'8 – 11 years'},
  {id:'12-17',title:'12 – 17 years'},
];

const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTH_FULL=['January','February','March','April','May','June','July','August','September','October','November','December'];
const DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const clip=(v,n)=>String(v??'').replace(/\s+/g,' ').trim().slice(0,n);

// Saved destinations (array or JSON text) → [{emoji,name}], defaults when nothing usable is saved.
export function flyindoNormalizeDestinations(raw){
  let list=raw;
  if(typeof raw==='string'){ try{ list=JSON.parse(raw||'[]'); }catch(e){ list=[]; } }
  const seen=new Set();
  const out=(Array.isArray(list)?list:[]).map(d=>({emoji:clip(d?.emoji,8),name:clip(d?.name,40)}))
    .filter(d=>d.name && !seen.has(d.name.toLowerCase()) && seen.add(d.name.toLowerCase()))
    .slice(0,FLYINDO_MAX_DESTINATIONS);
  return out.length?out:FLYINDO_DEFAULT_DESTINATIONS.map(d=>({...d}));
}
export function flyindoNormalizeStyle(v){ const s=String(v||'').trim().toLowerCase(); return CHAT_STYLES.includes(s)?s:''; }
export function flyindoOn(c={}){ return flyindoNormalizeStyle(c?.lt_chat_style)===FLYINDO_STYLE; }
export function greetingOnlyOn(c={}){ return flyindoNormalizeStyle(c?.lt_chat_style)===GREETING_STYLE; }

// ── Dates ────────────────────────────────────────────────────────────────────
const utcDay=d=>new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()));
const isoDay=d=>d.toISOString().slice(0,10);
const addDays=(d,n)=>new Date(d.getTime()+n*86400000);
// "Tue, 15 Dec 2026" — used in the summary and the confirmations.
export function flyindoDateLabel(iso){
  const d=new Date(`${iso}T00:00:00Z`);
  if(Number.isNaN(d.getTime())) return String(iso||'');
  return `${DOW[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTH_FULL[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
// A valid booking date is from tomorrow up to FLYINDO_MAX_DAYS_AHEAD days out.
export function flyindoCheckDate(iso, today=new Date()){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(iso||''))) return {ok:false, reason:'invalid'};
  const d=new Date(`${iso}T00:00:00Z`);
  if(Number.isNaN(d.getTime()) || isoDay(d)!==iso) return {ok:false, reason:'invalid'};
  const t=utcDay(today);
  if(d<=t) return {ok:false, reason:'past'};
  if(d>addDays(t,FLYINDO_MAX_DAYS_AHEAD)) return {ok:false, reason:'too_far'};
  return {ok:true, iso};
}
// A typed date → YYYY-MM-DD (not yet validated), or ''. Understands "15 December", "Dec 15",
// "15/12", "15-12-2026", "2026-12-15", "tomorrow". A day+month with no year means its next
// occurrence.
export function flyindoParseDate(text, today=new Date()){
  const s=String(text||'').trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g,'$1').replace(/,/g,' ');
  const t=utcDay(today);
  if(/^tomorrow$/.test(s)) return isoDay(addDays(t,1));
  let m=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if(m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  const monthIdx=w=>{ const i=MONTH_FULL.findIndex(x=>x.toLowerCase().startsWith(w.slice(0,3))); return w.length>=3&&i>=0?i:-1; };
  const build=(day,mon,year)=>{
    if(!(day>=1&&day<=31&&mon>=0&&mon<=11)) return '';
    let y=year?(year<100?2000+year:year):t.getUTCFullYear();
    let iso=`${y}-${String(mon+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    if(!year && new Date(`${iso}T00:00:00Z`)<=t) iso=`${y+1}-${String(mon+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    return iso;
  };
  m=s.match(/^(\d{1,2})\s*[\/\-.]\s*(\d{1,2})(?:\s*[\/\-.]\s*(\d{2,4}))?$/);
  if(m) return build(+m[1], +m[2]-1, m[3]?+m[3]:0);
  m=s.match(/^(\d{1,2})\s+([a-z]+)\.?(?:\s+(\d{2,4}))?$/);
  if(m&&monthIdx(m[2])>=0) return build(+m[1], monthIdx(m[2]), m[3]?+m[3]:0);
  m=s.match(/^([a-z]+)\.?\s+(\d{1,2})(?:\s+(\d{2,4}))?$/);
  if(m&&monthIdx(m[1])>=0) return build(+m[2], monthIdx(m[1]), m[3]?+m[3]:0);
  return '';
}
// Step 3a: "next 7 days" + the next months (WhatsApp lists hold 10 rows).
export function flyindoMonthRows(today=new Date()){
  const t=utcDay(today),rows=[{title:'⚡ Next 7 days',value:`${FLYINDO_PREFIX}week:${isoDay(addDays(t,1))}`,description:'Pick a day this week'}];
  for(let i=0;rows.length<10;i++){
    const first=new Date(Date.UTC(t.getUTCFullYear(),t.getUTCMonth()+i,1));
    const last=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0));
    if(last<=t) continue; // this month is over (today is its last day)
    rows.push({title:`📅 ${MONTH_FULL[first.getUTCMonth()]} ${first.getUTCFullYear()}`,value:`${FLYINDO_PREFIX}month:${isoDay(first).slice(0,7)}`});
  }
  return rows;
}
// Step 3b: the weeks of a month (only days from tomorrow on).
export function flyindoWeekRows(ym, today=new Date()){
  const [y,mo]=String(ym||'').split('-').map(Number);
  if(!y||!mo) return [];
  const t=utcDay(today),first=new Date(Date.UTC(y,mo-1,1)),last=new Date(Date.UTC(y,mo,0)),rows=[];
  for(let start=first;start<=last;start=addDays(start,7)){
    let a=start,b=addDays(start,6); if(b>last) b=last;
    if(b<=t) continue;
    if(a<=t) a=addDays(t,1);
    if(a>addDays(t,FLYINDO_MAX_DAYS_AHEAD)) break;
    rows.push({title:`${a.getUTCDate()}${a.getTime()===b.getTime()?'':` – ${b.getUTCDate()}`} ${MON[mo-1]}`,value:`${FLYINDO_PREFIX}week:${isoDay(a)}:${isoDay(b)}`});
  }
  return rows;
}
// Step 3c: each day of a week (or the next 7 days).
export function flyindoDayRows(from, to='', today=new Date()){
  const a=new Date(`${from}T00:00:00Z`);
  if(Number.isNaN(a.getTime())) return [];
  const b=to?new Date(`${to}T00:00:00Z`):addDays(a,6),rows=[];
  for(let d=a;d<=b&&rows.length<10;d=addDays(d,1)){
    if(!flyindoCheckDate(isoDay(d),today).ok) continue;
    const diff=Math.round((d-utcDay(today))/86400000);
    rows.push({title:`${d.getUTCDate()} ${MON[d.getUTCMonth()]} · ${DOW[d.getUTCDay()]}`,value:`${FLYINDO_PREFIX}date:${isoDay(d)}`,...(diff===1?{description:'Tomorrow'}:{})});
  }
  return rows;
}

// ── Travellers ───────────────────────────────────────────────────────────────
export function flyindoAdultRows(){
  return [...Array.from({length:FLYINDO_MAX_ADULTS},(_,i)=>({title:`${i+1} Adult${i?'s':''}`,value:`${FLYINDO_PREFIX}adults:${i+1}`})),
    {title:'10 or more',value:`${FLYINDO_PREFIX}adults:10+`,description:'Our team will confirm the group size'}];
}
export function flyindoChildRows(){
  return [{title:'No children',value:`${FLYINDO_PREFIX}kids:0`},
    ...Array.from({length:FLYINDO_MAX_CHILDREN},(_,i)=>({title:`${i+1} Child${i?'ren':''}`,value:`${FLYINDO_PREFIX}kids:${i+1}`}))];
}
export function flyindoAgeRows(){ return FLYINDO_CHILD_AGES.map(a=>({title:a.title,value:`${FLYINDO_PREFIX}age:${a.id}`,...(a.description?{description:a.description}:{})})); }
const ageTitle=id=>FLYINDO_CHILD_AGES.find(a=>a.id===id)?.title||id;
// A typed count ("2", "2 adults", "two") → number, or null.
const WORDS={zero:0,no:0,none:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10};
export function flyindoParseCount(text){
  const s=String(text||'').trim().toLowerCase();
  const m=s.match(/^(\d{1,2})\+?\b/);
  if(m) return Number(m[1]);
  const w=s.split(/\s+/)[0];
  return w in WORDS?WORDS[w]:null;
}

// ── Messages ─────────────────────────────────────────────────────────────────
export function flyindoWelcomeText(agency){
  return `Hello! 👋 Welcome to *${agency||'our travel team'}*!\nWe're happy to help you plan your next trip. 🌍\n\nWhere would you like to travel today?\n\nPlease select your preferred destination below 👇`;
}
// "Greetings only": the Flyindo welcome without the destination list. A custom text (Chat Style
// → Greeting message) replaces it; {agency} in it becomes the agency name.
export function greetingOnlyText(agency, custom=''){
  const name=agency||'our travel team';
  const t=String(custom||'').replace(/\r/g,'').trim().slice(0,GREETING_TEXT_MAX);
  if(t) return t.replace(/\{agency\}/gi,name);
  return `Hello! 👋 Welcome to *${name}*!\nWe're happy to help you plan your next trip. 🌍\n\nWhere would you like to travel today?\n\nOur travel consultant will reply to you shortly. 😊`;
}
export function flyindoSummaryText(s, agency){
  const lines=[`📍 Destination: ${s.destination}`,`📅 Travel Date: ${flyindoDateLabel(s.date)}`,`👨 Adults: ${s.adults}`,`👧 Children: ${s.children||0}`];
  if((s.ages||[]).length) lines.push(`🎂 Children's ages: ${s.ages.map(ageTitle).join(', ')}`);
  return `Thank you for sharing your travel details! 🎉\n\nHere is your booking request:\n\n${lines.join('\n')}\n\nOur travel consultant will contact you shortly to discuss package details, pricing and booking confirmation.\n\nThank you for choosing *${agency||'us'}*! ❤️`;
}

// ── The step machine ─────────────────────────────────────────────────────────
// state: {step, destination, date, adults, children, ages:[]} — step is one of
// destination | month | week | day | adults | children | ages | done.
// Returns {state, text, rows, button, done?}. `rows` are the options to send (list/buttons).
// `resume` (an answer or note in a chat already under way): the destination step asks again in a
// short line instead of repeating the whole welcome.
export function flyindoPrompt(state, {agency='', destinations=[], today=new Date(), note='', resume=false}={}){
  const pre=note?`${note}\n\n`:'';
  switch(state.step){
    case 'destination':
      return {text:note&&resume?`${pre}🌍 *Where would you like to travel?*\nPlease select a destination from the list below 👇`:pre+flyindoWelcomeText(agency),rows:destinations.map((d,i)=>({title:`${d.emoji?d.emoji+' ':''}${d.name}`,value:`${FLYINDO_PREFIX}dest:${i}`})),button:'Destinations',section:'Destinations'};
    case 'month':
      return {text:`${pre}Great choice! 😊\n\nWhen are you planning to visit *${state.destination}*?\n\n📅 Please choose your travel month below.`,rows:flyindoMonthRows(today),button:'Choose month',section:'Travel month'};
    case 'week':
      return {text:`${pre}📅 Which week in *${state.monthLabel||''}*?`,rows:flyindoWeekRows(state.month,today),button:'Choose week',section:'Week'};
    case 'day':
      return {text:`${pre}📅 Please choose your travel date.`,rows:flyindoDayRows(state.from,state.to,today),button:'Choose date',section:'Travel date'};
    case 'adults':
      return {text:`${pre}How many people will be travelling? 🧳\n\n👨 *Adults:* please choose the number of adults (12 years and above).`,rows:flyindoAdultRows(),button:'Adults',section:'Adults'};
    case 'children':
      return {text:`${pre}👧 *Children:* how many children (below 12 years) are travelling?`,rows:flyindoChildRows(),button:'Children',section:'Children'};
    case 'ages':{
      const n=(state.ages||[]).length+1;
      return {text:`${pre}🎂 Child ${n}${state.children>1?` of ${state.children}`:''} — how old ${state.children>1?'is this child':'is your child'}?\n\n_Prices can depend on age._`,rows:flyindoAgeRows(),button:'Choose age',section:'Age'};
    }
    default:
      return {text:flyindoSummaryText(state,agency),rows:[],done:true};
  }
}

// A tapped row can arrive as its title rather than its id — map it back to the id. Returns the
// message unchanged when it isn't one of the current step's rows.
export function flyindoTapValue(state, input, {destinations=[], today=new Date()}={}){
  const raw=String(input||'').trim();
  if(raw.toUpperCase().startsWith(FLYINDO_PREFIX)) return raw;
  const norm=v=>String(v||'').toLowerCase().normalize('NFC').replace(/\s+/g,' ').trim();
  const hit=(flyindoPrompt(state,{destinations,today}).rows||[]).find(r=>norm(r.title)===norm(raw));
  return hit?hit.value:raw;
}
// Applies the customer's message to the current step. Returns {state, note} — note is set when the
// message didn't fit the step (the same step is then asked again with that note on top).
export function flyindoAdvance(state, input, {destinations=[], askAges=true, today=new Date()}={}){
  const s={...state, ages:[...(state.ages||[])]};
  const raw=flyindoTapValue(state,input,{destinations,today});
  const tap=raw.toUpperCase().startsWith(FLYINDO_PREFIX)?raw.slice(FLYINDO_PREFIX.length):'';
  const [kind,a,b]=tap.split(':');
  const again=note=>({state, note});
  switch(s.step){
    case 'destination':{
      let d=kind==='dest'?destinations[Number(a)]:null;
      if(!d && !tap){ const low=raw.toLowerCase(); d=destinations.find(x=>low.includes(x.name.toLowerCase())); }
      if(!d) return again('Sorry, I didn\'t catch that 🙂');
      return {state:{...s, step:'month', destination:d.name}};
    }
    case 'month': case 'week': case 'day':{
      if(kind==='month'&&/^\d{4}-\d{2}$/.test(a||'')){
        const [y,m]=a.split('-').map(Number);
        const rows=flyindoWeekRows(a,today);
        if(!rows.length) return again('That month is no longer available. Please choose another 👇');
        return {state:{...s, step:'week', month:a, monthLabel:`${MONTH_FULL[m-1]} ${y}`}};
      }
      if(kind==='week'&&/^\d{4}-\d{2}-\d{2}$/.test(a||'')) return {state:{...s, step:'day', from:a, to:/^\d{4}-\d{2}-\d{2}$/.test(b||'')?b:''}};
      const iso=kind==='date'?a:(!tap?flyindoParseDate(raw,today):'');
      if(!iso) return again(tap?'Please choose a date from the list below 👇':'Please choose your travel date below 👇 (or type it, e.g. *15 December*).');
      const chk=flyindoCheckDate(iso,today);
      if(!chk.ok){
        const msg=chk.reason==='past'?`⚠️ ${flyindoDateLabel(iso)} has already passed or is today. Please choose a future date.`
          :chk.reason==='too_far'?`⚠️ We can only take bookings up to ${Math.round(FLYINDO_MAX_DAYS_AHEAD/30)} months ahead. Please choose an earlier date.`
          :'⚠️ That doesn\'t look like a valid date. Please choose one below 👇';
        return {state:{...s, step:'month'}, note:msg};
      }
      const {month,monthLabel,from,to,...rest}=s;
      return {state:{...rest, step:'adults', date:chk.iso}};
    }
    case 'adults':{
      let n=kind==='adults'?(a==='10+'?'10+':Number(a)):(!tap?flyindoParseCount(raw):null);
      if(n===null||n===undefined||Number.isNaN(n)||(typeof n==='number'&&(n<1||n>99))) return again('Please choose the number of adults below 👇');
      if(typeof n==='number'&&n>=10) n=String(n);
      return {state:{...s, step:'children', adults:n}};
    }
    case 'children':{
      const n=kind==='kids'?Number(a):(!tap?flyindoParseCount(raw):null);
      if(n===null||Number.isNaN(n)||n<0||n>20) return again('Please choose the number of children below 👇');
      const next=n>0&&askAges&&n<=FLYINDO_MAX_CHILDREN?'ages':'done';
      return {state:{...s, step:next, children:n, ages:[]}};
    }
    case 'ages':{
      let id=kind==='age'&&FLYINDO_CHILD_AGES.some(x=>x.id===a)?a:'';
      if(!id&&!tap){ const n=flyindoParseCount(raw); if(n!==null&&n>=0&&n<18) id=FLYINDO_CHILD_AGES.find(x=>{const [lo,hi]=x.id.split('-').map(Number);return n>=lo&&n<=hi;})?.id||''; }
      if(!id) return again('Please choose the child\'s age below 👇');
      s.ages.push(id);
      return {state:{...s, step:s.ages.length>=s.children?'done':'ages'}};
    }
    default: return {state:s};
  }
}
export function flyindoStart(){ return {step:'destination', ages:[]}; }
// Lead qualification answers saved with the handover so the team sees the request on the lead.
export function flyindoQualAnswers(s){
  return {destination:s.destination||'', travel_date:s.date||'', adults:String(s.adults??''), children:String(s.children??0),
    // Month picked but no day yet: kept so a request the customer leaves half-way still says when.
    ...(!s.date&&s.month?{travel_month:s.month}:{}),
    ...((s.ages||[]).length?{children_ages:s.ages.map(ageTitle).join(', ')}:{})};
}

// ── AI upgrade: answer anything, then back to the menu ──────────────────────────
const FLYINDO_QUESTION_RE=/^(?:what|whats|what's|how|which|when|where|why|who|whom|is|are|was|were|do|does|did|can|could|will|would|should|shall|may|any|price|prices|cost|rate|rates|rs|tariff|budget|cheap|tell|send|share|need|want|i want|i need|details|info|information|available|availability|include|includes|including|package|packages|offer|offers|discount|visa|hotel|hotels|flight|flights|ticket|tickets)\b/i;
// True when a typed message should go to the AI: it isn't a tap, and it either didn't fit the
// step (`adv.note`) or reads like a question/request even though a value was found in it.
// `tapValue` is flyindoTapValue's result for the same message.
export function flyindoWantsAi(text, adv, tapValue=text){
  const t=String(text||'').trim();
  if(!t||String(tapValue||'').toUpperCase().startsWith(FLYINDO_PREFIX)) return false;
  if(adv?.note) return true;
  return /[?？]/.test(t)||FLYINDO_QUESTION_RE.test(t)||t.split(/\s+/).length>6;
}
const STEP_VALUE={
  destination:'the destination name exactly as listed, when the customer clearly chose one of them',
  month:'"YYYY-MM-DD" for a travel date, or "YYYY-MM" when only the month is given',
  week:'"YYYY-MM-DD" for a travel date, or "YYYY-MM" when only the month is given',
  day:'"YYYY-MM-DD" for a travel date',
  adults:'the number of adults (12 years and above) as a number',
  children:'the number of children (below 12 years) as a number; 0 for "no children"',
  ages:'the child\'s age in years as a number',
};
const STEP_LABEL={destination:'the destination',month:'the travel date or month',week:'the travel date',day:'the travel date',adults:'the number of adults',children:'the number of children',ages:'the child\'s age'};
export function flyindoBuildAiPrompt(state, {text='', agency='', mainPrompt='', kb='', destinations=[], history=[], langName='English', replyStyle='', today=new Date()}={}){
  const have=[state.destination&&`- Destination: ${state.destination}`, state.date&&`- Travel date: ${flyindoDateLabel(state.date)}`,
    !state.date&&state.monthLabel&&`- Travel month: ${state.monthLabel}`, state.adults!=null&&`- Adults: ${state.adults}`,
    state.children!=null&&state.step!=='children'&&`- Children: ${state.children}`].filter(Boolean);
  const system=[
    `You are the WhatsApp assistant of ${agency||'a travel agency'}.`,
    mainPrompt?`## Business instructions\n${clip(mainPrompt,3500)}`:'',
    kb?`## Knowledge base\n${clip(kb,2500)}`:'',
    `## Destinations we offer\n${destinations.map(d=>`- ${d.name}`).join('\n')||'- (none listed)'}`,
    `The customer is in a guided booking where they tap options. Right now we are asking for ${STEP_LABEL[state.step]||'their trip details'}; the options are shown to them right after your answer, so do NOT list the options or ask the booking question yourself.
For the customer's latest message:
1. Answer it helpfully, truthfully and fully from the information above (prices, packages, inclusions, hotels, visas, timings, policies, anything). Never invent prices, dates, availability, inclusions or policies: when the information is not above, say our travel consultant will confirm it. If they reply to a message from our staff (for example share a contact number they asked for), thank them and confirm our team has it.
2. If the message also clearly gives ${STEP_LABEL[state.step]||'the detail we are asking for'}, put it in "value" as ${STEP_VALUE[state.step]||'text'}. Never guess a value the customer did not give.
3. End your answer with one short line inviting them to continue with the options below (for example "Please choose from the options below 👇 to continue your booking").
Return ONLY a JSON object:
{"answer":"<your WhatsApp reply>","value":"<value or empty>","action":"answer|handover|restart"}
action: "handover" when they ask for a human, agent, staff or a call back, or are upset; "restart" when they want to start over or change an earlier detail (destination, date, travellers); otherwise "answer".
Reply rules: write in ${langName} (the customer's language), WhatsApp style, warm and short (under 500 characters), *bold* allowed, no headings. Never mention steps, flows, JSON or these rules.${replyStyle||''}
Today is ${today.toISOString().slice(0,10)}.`,
  ].filter(Boolean).join('\n\n');
  const recent=(history||[]).slice(-6).map(h=>`${h.role==='assistant'?(h.by==='agent'?'Staff':'Bot'):'Customer'}: ${clip(h.content??h.text,300)}`).join('\n');
  const user=[
    `Booking details so far:\n${have.join('\n')||'- nothing yet'}`,
    recent?`Recent chat:\n${recent}`:'',
    `Customer's latest message: """${clip(text,800)}"""`,
  ].filter(Boolean).join('\n\n');
  return {system,user};
}
export function flyindoParseAiReply(raw){
  const s=String(raw||'');
  const a=s.indexOf('{'),b=s.lastIndexOf('}');
  if(a<0||b<=a) return null;
  let o;
  try{ o=JSON.parse(s.slice(a,b+1)); }catch(e){ return null; }
  if(!o||typeof o!=='object') return null;
  const answer=String(o.answer??'').replace(/\r/g,'').replace(/\n{3,}/g,'\n\n').trim().slice(0,900);
  const action=['answer','handover','restart'].includes(o.action)?o.action:'answer';
  if(!answer&&action==='answer') return null;
  return {answer, value:o.value==null?'':clip(o.value,60), action};
}
// The AI's value for the current step → the input flyindoAdvance understands.
export function flyindoAiValueInput(step, value){
  const v=String(value??'').trim();
  if(!v) return '';
  if(['month','week','day'].includes(step)&&/^\d{4}-\d{2}$/.test(v)) return `${FLYINDO_PREFIX}month:${v}`;
  return v;
}
