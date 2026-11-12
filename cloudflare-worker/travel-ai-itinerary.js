// Travel Agency → Packages → "✨ AI Itinerary": drafts a day-by-day itinerary from one package for
// the agent to review in the itinerary builder (nothing is saved here, and the WhatsApp bot's own
// itinerary flow in travel-itinerary.js is not involved). The model writes the plan as JSON; this
// module builds the prompt, cleans the reply into the builder's day shape, and finds one place
// photo per day on Wikipedia (Wikimedia Commons), returned as its image link.

const TYPES=['flight','hotel','activity','transfer','meal','note'];
const MEALS=['B','L','D'];
export const TA_AI_MAX_DAYS=30;

const str=(v,max)=>String(v??'').replace(/\s+/g,' ').trim().slice(0,max);
function list(v){
  if(Array.isArray(v))return v.map(x=>str(x,200)).filter(Boolean);
  if(v==null||v==='')return [];
  try{const a=JSON.parse(v);if(Array.isArray(a))return a.map(x=>str(x,200)).filter(Boolean);}catch(e){}
  return String(v).split(/\n|;/).map(x=>str(x,200)).filter(Boolean);
}
export function taAiDayCount(pkg){
  const n=parseInt(pkg?.nights,10);
  return Math.min(TA_AI_MAX_DAYS,Math.max(1,(Number.isFinite(n)&&n>0?n:1)+1));
}

// Optional traveller profile from the agent (who is travelling and how they like to travel); every
// field is optional and each one only adds a line to the prompt when it is filled in.
export const TA_AI_PACES={relaxed:'relaxed — 1-2 items a day, late starts, free time',balanced:'balanced — 2-3 items a day',packed:'packed — 3-5 items a day, early starts'};
const count=(v,max)=>{const n=parseInt(v,10);return Number.isFinite(n)&&n>0?Math.min(n,max):0;};
export function taAiTraveller(t){
  t=t&&typeof t==='object'?t:{};
  const ages=(Array.isArray(t.child_ages)?t.child_ages:String(t.child_ages??'').split(/[,;\s]+/))
    .map(a=>parseInt(a,10)).filter(a=>Number.isFinite(a)&&a>=0&&a<18).slice(0,10);
  const pace=String(t.pace||'').toLowerCase().trim();
  return {adults:count(t.adults,50),children:Math.max(count(t.children,20),ages.length),infants:count(t.infants,10),child_ages:ages,
    pace:TA_AI_PACES[pace]?pace:'',interests:list(t.interests).slice(0,15).map(x=>x.slice(0,60)),
    destinations:list(t.destinations).slice(0,10).map(x=>x.slice(0,120))};
}
function travellerFacts(t){
  const pax=[t.adults&&`${t.adults} adult${t.adults>1?'s':''}`,
    t.children&&`${t.children} child${t.children>1?'ren':''}${t.child_ages.length?` (age${t.child_ages.length>1?'s':''} ${t.child_ages.join(', ')})`:''}`,
    t.infants&&`${t.infants} infant${t.infants>1?'s':''}`].filter(Boolean).join(', ');
  return [['Travellers',pax],['Pace',t.pace?TA_AI_PACES[t.pace]:''],['Interests',t.interests.join('; ')],
    ['Route (in this order)',t.destinations.join(' → ')]];
}
function travellerRules(t){
  const r=[];
  if(t.destinations.length)r.push('- Follow the Route in the given order, splitting the nights as written (e.g. "Dubai 3N"); if nights per stop are not given, split them sensibly, with travel between stops on its own transfer item. "overnight" is the stop for that night.');
  if(t.pace)r.push(`- Pace: ${TA_AI_PACES[t.pace]}.`);
  if(t.interests.length)r.push('- Favour activities matching the Interests; still include the destination\'s must-sees.');
  if(t.children||t.infants)r.push('- Travellers include children/infants: keep days family-friendly, avoid long drives without breaks and late nights, and note age/height limits where an attraction has them.');
  return r.length?'\n'+r.join('\n'):'';
}

export function taAiItineraryPrompt(pkg,traveller){
  const days=taAiDayCount(pkg);
  const t=taAiTraveller(traveller);
  const system=`You are a senior travel consultant writing a customer-facing, day-by-day tour itinerary for a travel agency. Write in clear, friendly English. Respond with ONLY compact JSON, no commentary, in exactly this shape:
{"days":[{"title":"short day title, max 8 words","description":"1-2 short sentences describing the day","overnight":"city or hotel for the night, or empty string on the last day","meals":["B","L","D" — only the meals included that day],"items":[{"type":"one of: ${TYPES.join(', ')}","time":"HH:MM 24h or empty string","description":"one line, max 15 words","place":"name of the landmark/attraction for a photo search, or empty string"}]}]}
Rules:
- Exactly ${days} days (${days-1} nights). Day 1 is arrival, the last day is departure.
- If the agency's notes already describe the days, follow them exactly — same order, same places — and only tidy the wording.
- Otherwise plan realistic, well-known sightseeing for the destination at a comfortable pace (2-4 items a day).
- Use only facts from the package for hotels, flights, transport and meals; never invent hotel names, flight numbers, prices or phone numbers. Use the city name for "overnight" unless a hotel is given.
- Meals: follow the package's inclusions / meal plan; if unknown, use breakfast from day 2.
- "place" is set for every "activity" item that is a real, named attraction or area (e.g. "Golconda Fort", "Calangute Beach"), using its well-known English name — it is used to find a photo.
- Tailor the plan to the traveller profile (Travellers, Pace, Interests, Route) when it is given; the agency's notes still win where they describe specific days.${travellerRules(t)}`;
  const facts=[
    ['Package',str(pkg?.name,200)],['Type',str(pkg?.type,40)],['Destination',str(pkg?.destination,200)],
    ['Nights',String(days-1)],['Inclusions',list(pkg?.inclusions).join('; ')],['Exclusions',list(pkg?.exclusions).join('; ')],
    ['Agency notes',String(pkg?.notes||'').trim().slice(0,3000)],
    ...travellerFacts(t),
  ].filter(([,v])=>v).map(([k,v])=>`${k}: ${v}`).join('\n');
  return {system,user:facts};
}

function hhmm(v){
  const m=/^(\d{1,2})[:.](\d{2})/.exec(String(v||'').trim());
  if(!m)return '';
  const h=Number(m[1]),mi=Number(m[2]);
  return h<24&&mi<60?`${String(h).padStart(2,'0')}:${String(mi).padStart(2,'0')}`:'';
}
// The complete {...} day objects in a reply cut off mid-way (output token limit): everything up to
// the last day that closed properly is kept, so a long trip isn't thrown away for one broken day.
function salvageDays(text){
  const start=text.search(/"days"\s*:\s*\[/);
  let i=start<0?text.indexOf('['):text.indexOf('[',start);
  if(i<0)return null;
  const out=[];let depth=0,from=-1,inStr=false,escp=false;
  for(i=i+1;i<text.length;i++){
    const ch=text[i];
    if(inStr){ if(escp)escp=false; else if(ch==='\\')escp=true; else if(ch==='"')inStr=false; continue; }
    if(ch==='"'){inStr=true;continue;}
    if(ch==='{'){ if(depth===0)from=i; depth++; }
    else if(ch==='}'){ depth--; if(depth===0&&from>=0){ try{out.push(JSON.parse(text.slice(from,i+1)));}catch(e){} from=-1; } }
    else if(ch===']'&&depth===0)break;
  }
  return out.length?out:null;
}
// Model reply → the builder's day shape, exactly the package's day count (missing days are blank).
export function taAiItineraryParse(raw,pkg){
  const text=String(raw||'').replace(/```json|```/gi,'');
  let data=null;
  try{data=JSON.parse((text.match(/\{[\s\S]*\}|\[[\s\S]*\]/)||[''])[0]);}catch(e){}
  const src=Array.isArray(data?.days)?data.days:Array.isArray(data)?data:salvageDays(text);
  if(!src||!src.length)return null;
  const count=taAiDayCount(pkg);
  const out=[];
  for(let i=0;i<count;i++){
    const d=src[i]&&typeof src[i]==='object'?src[i]:{};
    const meals=(Array.isArray(d.meals)?d.meals:[]).map(m=>String(m||'').trim().charAt(0).toUpperCase());
    out.push({
      day_no:i+1,title:str(d.title,120),description:str(d.description,800),overnight:str(d.overnight,120),
      meals:MEALS.filter(m=>meals.includes(m)),image_links:[],
      items:(Array.isArray(d.items)?d.items:[]).slice(0,10).map(it=>({
        type:TYPES.includes(String(it?.type||'').toLowerCase())?String(it.type).toLowerCase():'activity',
        time:hhmm(it?.time),description:str(it?.description,300),image:'',place:str(it?.place,120),
      })).filter(it=>it.description),
    });
  }
  return out.some(d=>d.title||d.items.length)?out:null;
}

// One Wikipedia lead photo per day (the day's first named place), kept only when the article
// title shares a word with the place so a vague query never pulls an unrelated photo.
const UA='LeadvyneItinerary/1.0 (https://app.leadvyne.com; travel itinerary builder)';
const words=s=>String(s||'').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu,' ').trim().split(' ').filter(w=>w.length>2);
async function timed(fetchImpl,url,timeoutMs){
  const ctrl=new AbortController(),t=setTimeout(()=>ctrl.abort(),timeoutMs);
  try{return await fetchImpl(url,{signal:ctrl.signal,headers:{'User-Agent':UA,'Api-User-Agent':UA}});}
  catch(e){return null;}finally{clearTimeout(t);}
}
async function wikiThumb(place,dest,fetchImpl,timeoutMs){
  const q=dest&&!words(place).some(w=>words(dest).includes(w))?`${place} ${dest}`:place;
  const r=await timed(fetchImpl,`https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&generator=search&gsrlimit=1&gsrsearch=${encodeURIComponent(q)}&prop=pageimages&piprop=thumbnail&pithumbsize=640&redirects=1`,timeoutMs);
  if(!r?.ok)return '';
  const page=(await r.json().catch(()=>null))?.query?.pages?.[0];
  if(!page?.thumbnail?.source)return '';
  const title=new Set(words(page.title));
  return words(place).some(w=>title.has(w))?page.thumbnail.source:'';
}
export async function taAiItineraryPhotos(days,pkg,{fetchImpl=globalThis.fetch,timeoutMs=5000}={}){
  const dest=str(pkg?.destination,120);
  // Stored as the Wikimedia thumbnail link (a few dozen bytes), not image data: the itinerary's
  // `days` column can't hold several embedded photos. The PDF fetches the image when it's built.
  const usable=u=>/^https:\/\/upload\.wikimedia\.org\/.+\.(?:jpe?g|png)$/i.test(u)?u:'';
  const used=new Set();
  await Promise.all(days.map(async d=>{
    // Each named place of the day in turn (up to 3 lookups) until one has a matching photo…
    const candidates=d.items.filter(it=>it.type==='activity'&&(it.place||it.description)).slice(0,3);
    for(const it of candidates){
      const thumb=usable(await wikiThumb(it.place||it.description,dest,fetchImpl,timeoutMs));
      if(thumb){ it.image=thumb; used.add(thumb); return; }
    }
  }));
  // …and a day still without one gets a photo of its overnight city or the destination, on its
  // first activity / item, without repeating a photo another day already shows.
  for(const d of days){
    if(d.items.some(it=>it.image)||!d.items.length)continue;
    for(const place of [d.overnight,dest].filter(Boolean)){
      const thumb=usable(await wikiThumb(place,'',fetchImpl,timeoutMs));
      if(thumb&&!used.has(thumb)){ (d.items.find(it=>it.type==='activity')||d.items[0]).image=thumb; used.add(thumb); break; }
    }
  }
  // The package's own photos (Drive links) go on day 1, where the PDF draws them as images.
  const own=['image_url','image_url_2','image_url_3'].map(f=>str(pkg?.[f],500)).filter(u=>/^https?:\/\//i.test(u));
  if(days[0]&&own.length)days[0].image_links=own;
  days.forEach(d=>d.items.forEach(it=>{delete it.place;}));
  return days;
}

// Whole flow with an injected text generator: (system,user) → model text, or null / {error} when
// the AI gave no reply (the error is passed on so the agent sees why).
export async function taAiItinerary(pkg,generate,opts={}){
  if(!str(pkg?.name,200)&&!str(pkg?.destination,200))return {error:'Add a package name or destination first.'};
  const {system,user}=taAiItineraryPrompt(pkg,opts.traveller);
  const why=[];
  const ask=async sys=>{
    const r=await generate(sys,user);
    const text=typeof r==='string'?r:r?.text;
    if(!text){why.push(str((r&&r.error)||'no reply from the AI',200));return null;}
    const days=taAiItineraryParse(text,pkg);
    if(!days)why.push(`reply was not a readable itinerary (${str(text,80)}…)`);
    return days;
  };
  let days=await ask(system);
  if(!days)days=await ask(system+'\nYour previous reply was not valid JSON. Reply with the JSON object only, and keep every description short.');
  if(!days)return {error:`The AI could not draft this itinerary: ${why[why.length-1]||'unknown error'}. Please try again.`,reasons:why};
  return {days:await taAiItineraryPhotos(days,pkg,opts)};
}
