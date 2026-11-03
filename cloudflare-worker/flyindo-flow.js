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

   Every step is a tap. Anything typed that isn't an answer to the current step gets the same
   options again. Pure (no I/O) — storage and WhatsApp sends live in worker.js.
   ═══════════════════════════════════════════════════════════════════════════ */

export const FLYINDO_STYLE='flyindo';
export const FLYINDO_PREFIX='FLY:';
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
export function flyindoNormalizeStyle(v){ return String(v||'').trim().toLowerCase()===FLYINDO_STYLE?FLYINDO_STYLE:''; }
export function flyindoOn(c={}){ return flyindoNormalizeStyle(c?.lt_chat_style)===FLYINDO_STYLE; }

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
export function flyindoSummaryText(s, agency){
  const lines=[`📍 Destination: ${s.destination}`,`📅 Travel Date: ${flyindoDateLabel(s.date)}`,`👨 Adults: ${s.adults}`,`👧 Children: ${s.children||0}`];
  if((s.ages||[]).length) lines.push(`🎂 Children's ages: ${s.ages.map(ageTitle).join(', ')}`);
  return `Thank you for sharing your travel details! 🎉\n\nHere is your booking request:\n\n${lines.join('\n')}\n\nOur travel consultant will contact you shortly to discuss package details, pricing and booking confirmation.\n\nThank you for choosing *${agency||'us'}*! ❤️`;
}

// ── The step machine ─────────────────────────────────────────────────────────
// state: {step, destination, date, adults, children, ages:[]} — step is one of
// destination | month | week | day | adults | children | ages | done.
// Returns {state, text, rows, button, done?}. `rows` are the options to send (list/buttons).
export function flyindoPrompt(state, {agency='', destinations=[], today=new Date(), note=''}={}){
  const pre=note?`${note}\n\n`:'';
  switch(state.step){
    case 'destination':
      return {text:pre+flyindoWelcomeText(agency),rows:destinations.map((d,i)=>({title:`${d.emoji?d.emoji+' ':''}${d.name}`,value:`${FLYINDO_PREFIX}dest:${i}`})),button:'Destinations',section:'Destinations'};
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

// Applies the customer's message to the current step. Returns {state, note} — note is set when the
// message didn't fit the step (the same step is then asked again with that note on top).
export function flyindoAdvance(state, input, {destinations=[], askAges=true, today=new Date()}={}){
  const s={...state, ages:[...(state.ages||[])]};
  let raw=String(input||'').trim();
  // A tapped row can arrive as its title rather than its id — map it back to the id.
  if(!raw.toUpperCase().startsWith(FLYINDO_PREFIX)){
    const norm=v=>String(v||'').toLowerCase().normalize('NFC').replace(/\s+/g,' ').trim();
    const hit=(flyindoPrompt(state,{destinations,today}).rows||[]).find(r=>norm(r.title)===norm(raw));
    if(hit) raw=hit.value;
  }
  const tap=raw.toUpperCase().startsWith(FLYINDO_PREFIX)?raw.slice(FLYINDO_PREFIX.length):'';
  const [kind,a,b]=tap.split(':');
  const again=note=>({state, note});
  switch(s.step){
    case 'destination':{
      let d=kind==='dest'?destinations[Number(a)]:null;
      if(!d && !tap){ const low=raw.toLowerCase(); d=destinations.find(x=>low.includes(x.name.toLowerCase())); }
      if(!d) return again('Please select a destination from the list below 👇');
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
    ...((s.ages||[]).length?{children_ages:s.ages.map(ageTitle).join(', ')}:{})};
}
