// Travel Agency packages as a customer-facing itinerary: the WhatsApp text an agent would type by
// hand (header, price, day-by-day plan, includes/excludes, notes) and a designed PDF the bot can
// attach on a "📄 PDF Itinerary" tap — agency logo, cover photo, and a photo + short description for
// each place in the plan. Day-by-day plans come from the agency's own Itineraries (ta_itineraries),
// or from "DAY 1 - … DAY 2 - …" written in the package notes; nothing here invents a day the agency
// did not write. Place photos and descriptions are looked up on Wikipedia (Wikimedia Commons).

export const TA_PKG_PREFIX='TPKG:';
export const TA_PKG_PDF_PREFIX='TPKGPDF:';
export const TA_PKG_ENQUIRE_PREFIX='TPKGENQ:';

const ITEM_ICON={flight:'✈️',hotel:'🏨',activity:'📍',transfer:'🚌',meal:'🍽️',note:'📝'};
const MEAL_LABEL={B:'Breakfast',L:'Lunch',D:'Dinner'};
const ITEM_LABEL={flight:'Flight',hotel:'Hotel',activity:'Visit',transfer:'Transfer',meal:'Meal',note:'Note'};
// Words that name the kind of listing rather than which one, so "hyderabad train" finds
// "HYDERABAD TRAIN PACKAGE" and "hyderabad package" alone matches none of three Hyderabad packages.
const GENERIC=new Set(['package','packages','pkg','tour','tours','trip','trips','holiday','holidays','the','a','an','of','for','and','with']);
// Plan entries that are activities rather than places — never looked up for a photo.
const NOT_A_PLACE=/^(?:shopping|free time|leisure|at leisure|rest|relax|check[ -]?in|check[ -]?out|arrival|arrive|departure|depart|return|transfer|pick ?up|drop|breakfast|lunch|dinner|overnight.*|night stay|stay|hotel|airport|railway station|station|local sightseeing|sightseeing|city tour)$/i;

export function taList(v){
  if(Array.isArray(v))return v.map(x=>String(x).trim()).filter(Boolean);
  if(v==null||v==='')return [];
  try{const a=JSON.parse(v);if(Array.isArray(a))return a.map(x=>String(x).trim()).filter(Boolean);}catch(e){}
  return String(v).split(/\n|;/).map(x=>x.trim()).filter(Boolean);
}
function days(v){
  let d=v;
  if(typeof d==='string'){try{d=JSON.parse(d);}catch(e){d=[];}}
  return (Array.isArray(d)?d:[]).map((x,i)=>({day_no:Number(x?.day_no)||i+1,title:String(x?.title||'').trim(),
    description:String(x?.description||'').trim(),overnight:String(x?.overnight||'').trim(),
    meals:(Array.isArray(x?.meals)?x.meals:[]).filter(m=>MEAL_LABEL[m]),
    items:(Array.isArray(x?.items)?x.items:[]).map(it=>({type:ITEM_ICON[it?.type]?it.type:'note',time:String(it?.time||'').trim(),description:String(it?.description||'').trim(),image:String(it?.image||'')})).filter(it=>it.description)}))
    .filter(x=>x.title||x.items.length||x.description);
}
const norm=s=>String(s||'').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const words=s=>norm(s).split(' ').filter(Boolean);

// Same price the dashboard's package card shows: sell_price, else base_price.
export function taPackagePrice(p){
  const s=Number(p?.sell_price),b=Number(p?.base_price);
  return s>0?s:b>0?b:0;
}
// Child / infant rates set on the package (dashboard → Packages): [{label,amount}] for each one > 0.
export function taChildRates(p){
  return [['Child (with bed)',p?.child_price],['Child (no bed)',p?.child_nobed_price],['Infant',p?.infant_price]]
    .map(([label,v])=>({label,amount:Number(v)||0})).filter(r=>r.amount>0);
}
export function taMoney(n,cur){
  const v=Number(n);
  return v>0?`${String(cur||'').trim()||'AED'} ${v.toLocaleString('en-US',{maximumFractionDigits:2})}`:'';
}

// The itinerary built for this package: Itineraries created from a package (🗺️ on its card) take
// the package name as their title, so an exact name match wins, then one name containing the other.
export function taMatchItinerary(pkg,itineraries){
  const name=norm(pkg?.name);
  if(!name)return null;
  const withDays=(itineraries||[]).filter(it=>days(it?.days).length);
  return withDays.find(it=>norm(it.title)===name)
    ||(name.length>=6?withDays.find(it=>{const t=norm(it.title);return t.length>=6&&(t.includes(name)||name.includes(t));}):null)
    ||null;
}

// "DAY 01 - Sightseeing Golconda Fort, Seven Tombs, … DAY 2 - Salar Jung Museum, …" typed into
// the package notes → days whose items are the comma-separated places. Text before the first day
// stays as notes. Also catches a day glued to the previous word ("Buddha StatueDAY 2").
export function taParseNotesPlan(notes){
  const text=String(notes||'');
  const marks=[];
  for(const re of [/(?<![A-Za-z])day\s*0?(\d{1,2})\s*[-–—:.)]/gi,/(?<=[a-z])DAY\s*0?(\d{1,2})\s*[-–—:.)]/g]){
    for(const m of text.matchAll(re))if(!marks.some(x=>x.index===m.index))marks.push({index:m.index,end:m.index+m[0].length,day:Number(m[1])});
  }
  marks.sort((a,b)=>a.index-b.index);
  if(!marks.length)return {days:[],notes:text.trim()};
  const out=marks.map((m,i)=>{
    let body=text.slice(m.end,marks[i+1]?.index??text.length).replace(/\s+/g,' ').trim().replace(/[.,;]+$/,'');
    let title='';
    const lead=/^(sightseeing|local sightseeing|city tour|visit(?:ing)?|explore|excursion)\b\s*[:\-–]?\s*/i.exec(body);
    if(lead){title=lead[1].replace(/\b\w/g,c=>c.toUpperCase());body=body.slice(lead[0].length);}
    const parts=body.split(/\s*,\s*|\s+&\s+|\s+and\s+/i).map(x=>x.trim()).filter(Boolean);
    if(!title&&parts.length===1){title=parts[0];return {day_no:m.day,title,items:NOT_A_PLACE.test(parts[0])?[]:[{type:'activity',description:parts[0],image:''}]};}
    const places=parts.filter(p=>!NOT_A_PLACE.test(p));
    const summary=places.length>2?`${places[0]}, ${places[1]} & more`:places.join(' & ');
    title=title&&summary?`${title}: ${summary}`:title||summary;
    return {day_no:m.day,title,items:parts.map(p=>({type:'activity',description:p,image:''}))};
  }).filter(d=>d.title||d.items.length);
  return {days:out,notes:text.slice(0,marks[0].index).trim()};
}

// The day plan and leftover notes for a package: its matched Itinerary, else days in its notes.
export function taItineraryPlan(pkg,itin){
  const fromItin=days(itin?.days);
  const pkgNotes=String(pkg?.notes||'').trim(),itinNotes=String(itin?.notes||'').trim();
  const extra=itinNotes&&itinNotes!==pkgNotes&&!/^includes:/i.test(itinNotes)?itinNotes:'';
  if(fromItin.length)return {days:fromItin,notes:[pkgNotes,extra].filter(Boolean).join('\n\n')};
  const parsed=taParseNotesPlan(pkgNotes);
  return {days:parsed.days,notes:[parsed.notes,extra].filter(Boolean).join('\n\n')};
}

// The one package a message names, or null when it names none or can't be told apart.
export function taFindPackageInText(packages,text){
  const have=new Set(words(text));
  if(!have.size)return null;
  let best=null,bestScore=0,tie=false;
  for(const p of packages||[]){
    const all=words(p?.name);
    if(!all.length)continue;
    const key=all.filter(w=>!GENERIC.has(w));
    const need=key.length?key:all;
    if(!need.every(w=>have.has(w)))continue;
    const score=need.length;
    if(score>bestScore){best=p;bestScore=score;tie=false;}
    else if(score===bestScore)tie=true;
  }
  return tie?null:best;
}

// "details" / "itinerary" / "send pdf" style follow-ups that refer back to the package the bot
// just described. 'pdf' when the PDF itself is asked for.
export function taPackageFollowUp(text){
  const t=norm(text);
  if(!t||t.split(' ').length>6)return null;
  if(/\bpdf\b/.test(t))return 'pdf';
  if(/\b(itinerary|itenary|itinerery|details?|day wise|daywise|schedule|plan|full info|more info|inclusions?)\b/.test(t))return 'details';
  return null;
}

function nightsLine(n){
  const v=Number(n)||0;
  return v>0?`${v} night${v===1?'':'s'} / ${v+1} days`:'';
}
function paxLine(p){
  const min=Number(p?.pax_min)||0,max=Number(p?.pax_max)||0;
  if(min>1&&max&&max<99)return `${min}–${max} travellers`;
  if(min>1)return `Minimum ${min} travellers`;
  if(max&&max<99)return `Up to ${max} travellers`;
  return '';
}
function dateLine(it){
  const f=String(it?.from_date||'').slice(0,10),t=String(it?.to_date||'').slice(0,10);
  return f&&t?`${f} to ${t}`:f||'';
}
const titleCase=s=>/[a-z]/.test(s)?s:s.toLowerCase().replace(/\b\p{L}/gu,c=>c.toUpperCase());

// The WhatsApp message: what an agent would type out by hand for this package.
export function taPackageItineraryText(pkg,itin){
  const price=taMoney(taPackagePrice(pkg),pkg?.currency);
  const plan=taItineraryPlan(pkg,itin);
  const inc=taList(pkg?.inclusions),exc=taList(pkg?.exclusions);
  const out=[`🏝️ *${String(pkg?.name||'Package').trim()}*`];
  const meta=[pkg?.destination?`📍 ${titleCase(String(pkg.destination).trim())}`:'',nightsLine(pkg?.nights)?`🌙 ${nightsLine(pkg.nights)}`:''].filter(Boolean).join('  ·  ');
  if(meta)out.push(meta);
  if(dateLine(itin))out.push(`📅 ${dateLine(itin)}`);
  if(paxLine(pkg))out.push(`👥 ${paxLine(pkg)}`);
  if(price)out.push(`💰 *${price}* per person`);
  if(price)taChildRates(pkg).forEach(r=>out.push(`👶 ${r.label}: *${taMoney(r.amount,pkg?.currency)}*`));
  if(plan.days.length){
    out.push('','🗓️ *Day-wise itinerary*');
    plan.days.forEach(d=>{
      out.push('',`*Day ${d.day_no}${d.title?` – ${d.title}`:''}*`);
      if(d.description)out.push(d.description);
      d.items.filter(it=>!(it.description===d.title&&d.items.length===1)).forEach(it=>out.push(`${ITEM_ICON[it.type]} ${it.time?it.time+' ':''}${it.description}`));
      if(d.meals?.length)out.push(`🍽️ ${d.meals.map(m=>MEAL_LABEL[m]).join(', ')}`);
      if(d.overnight)out.push(`🌙 Overnight: ${d.overnight}`);
    });
  }
  if(inc.length)out.push('','✅ *Includes*',...inc.map(x=>`• ${x}`));
  if(exc.length)out.push('','❌ *Excludes*',...exc.map(x=>`• ${x}`));
  if(plan.notes)out.push('',`📝 ${plan.notes.slice(0,600)}`);
  if(price)out.push('','_Price is per person and subject to availability at the time of booking._');
  return out.join('\n');
}

/* ── Images ──────────────────────────────────────────────────────────────────────────────────── */

function jpegInfo(b){
  if(!(b?.[0]===0xFF&&b[1]===0xD8))return null;
  let i=2;
  while(i<b.length-9){
    if(b[i]!==0xFF){i++;continue;}
    const m=b[i+1];
    if(m>=0xC0&&m<=0xCF&&m!==0xC4&&m!==0xC8&&m!==0xCC)return {h:(b[i+5]<<8)|b[i+6],w:(b[i+7]<<8)|b[i+8],comps:b[i+9]};
    if(m===0xD8||m===0x01||(m>=0xD0&&m<=0xD7)){i+=2;continue;}
    i+=2+((b[i+2]<<8)|b[i+3]);
  }
  return null;
}
async function streamBytes(bytes,stream){
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}
// Non-interlaced PNG → RGB (+ alpha) pixels. Logos are mostly PNG, so this matters.
async function pngDecode(b){
  const sig=[137,80,78,71,13,10,26,10];
  if(!sig.every((v,i)=>b[i]===v))return null;
  const dv=new DataView(b.buffer,b.byteOffset,b.byteLength);
  let p=8,w=0,h=0,depth=0,type=0,interlace=0,palette=null,trns=null;const idat=[];
  while(p+8<=b.length){
    const len=dv.getUint32(p),t=String.fromCharCode(b[p+4],b[p+5],b[p+6],b[p+7]),d=b.subarray(p+8,p+8+len);
    if(t==='IHDR'){w=dv.getUint32(p+8);h=dv.getUint32(p+12);depth=d[8];type=d[9];interlace=d[12];}
    else if(t==='PLTE')palette=d;
    else if(t==='tRNS')trns=d;
    else if(t==='IDAT')idat.push(d);
    else if(t==='IEND')break;
    p+=12+len;
  }
  if(!w||!h||interlace||w*h>1.5e6||!idat.length)return null;
  const ch={0:1,2:3,3:1,4:2,6:4}[type];
  if(!ch||(depth!==8&&!(depth<8&&(type===0||type===3))))return null;
  const raw=await streamBytes(new Uint8Array(await new Blob(idat).arrayBuffer()),new DecompressionStream('deflate'));
  const bpp=Math.max(1,ch*depth/8),stride=Math.ceil(w*ch*depth/8);
  const px=new Uint8Array(stride*h);let prev=new Uint8Array(stride);
  for(let y=0,o=0;y<h;y++){
    const f=raw[o++],row=px.subarray(y*stride,(y+1)*stride);
    for(let x=0;x<stride;x++){
      const a=x>=bpp?row[x-bpp]:0,up=prev[x],c=x>=bpp?prev[x-bpp]:0,v=raw[o++];
      let pred=0;
      if(f===1)pred=a;else if(f===2)pred=up;else if(f===3)pred=(a+up)>>1;
      else if(f===4){const q=a+up-c,pa=Math.abs(q-a),pb=Math.abs(q-up),pc=Math.abs(q-c);pred=pa<=pb&&pa<=pc?a:pb<=pc?up:c;}
      row[x]=(v+pred)&255;
    }
    prev=row;
  }
  const rgb=new Uint8Array(w*h*3);let alpha=null;
  if(type===4||type===6||(type===3&&trns))alpha=new Uint8Array(w*h);
  const sample=(row,x)=>{if(depth===8)return row[x];const per=8/depth,byte=row[Math.floor(x/per)],shift=(per-1-(x%per))*depth;return (byte>>shift)&((1<<depth)-1);};
  for(let y=0;y<h;y++){
    const row=px.subarray(y*stride,(y+1)*stride);
    for(let x=0;x<w;x++){
      const i=y*w+x;let r,g,bl,a=255;
      if(type===2){r=row[x*3];g=row[x*3+1];bl=row[x*3+2];}
      else if(type===6){r=row[x*4];g=row[x*4+1];bl=row[x*4+2];a=row[x*4+3];}
      else if(type===4){r=g=bl=row[x*2];a=row[x*2+1];}
      else if(type===3){const k=sample(row,x);r=palette?.[k*3]??0;g=palette?.[k*3+1]??0;bl=palette?.[k*3+2]??0;if(trns)a=trns[k]??255;}
      else{const v=sample(row,x);r=g=bl=depth===8?v:Math.round(v*255/((1<<depth)-1));}
      rgb[i*3]=r;rgb[i*3+1]=g;rgb[i*3+2]=bl;if(alpha)alpha[i]=a;
    }
  }
  if(alpha&&alpha.every(v=>v===255))alpha=null;
  return {w,h,rgb,alpha};
}
// Image bytes → what the PDF embeds: JPEG as-is (DCTDecode), PNG as deflated RGB with an alpha
// SMask. Anything else (WEBP, GIF, SVG) → null and the PDF simply leaves that photo out.
export async function taPrepareImage(bytes){
  try{
    if(!bytes?.length)return null;
    const j=jpegInfo(bytes);
    if(j&&j.w&&j.h&&[1,3,4].includes(j.comps))return {filter:'DCTDecode',data:bytes,w:j.w,h:j.h,cs:j.comps===1?'DeviceGray':j.comps===4?'DeviceCMYK':'DeviceRGB',decode:j.comps===4};
    const png=await pngDecode(bytes);
    if(!png)return null;
    const deflate=d=>streamBytes(d,new CompressionStream('deflate'));
    return {filter:'FlateDecode',data:await deflate(png.rgb),w:png.w,h:png.h,cs:'DeviceRGB',smask:png.alpha?await deflate(png.alpha):null};
  }catch(e){return null;}
}
function dataUrlBytes(u){
  const m=/^data:image\/[a-z+]+;base64,(.+)$/i.exec(String(u||''));
  if(!m)return null;
  const s=atob(m[1]);const out=new Uint8Array(s.length);for(let i=0;i<s.length;i++)out[i]=s.charCodeAt(i);
  return out;
}
async function fetchBytes(url,fetchImpl,timeoutMs){
  const inline=dataUrlBytes(url);
  if(inline)return inline;
  if(!/^https?:\/\//i.test(String(url||'')))return null;
  const ctrl=new AbortController(),t=setTimeout(()=>ctrl.abort(),timeoutMs);
  try{
    const r=await fetchImpl(url,{signal:ctrl.signal,headers:{'User-Agent':WIKI_UA}});
    if(!r.ok)return null;
    const buf=new Uint8Array(await r.arrayBuffer());
    return buf.length<=3e6?buf:null;
  }catch(e){return null;}finally{clearTimeout(t);}
}

// Wikipedia (Wikimedia Commons photos): one search per place returns the best article's lead
// photo and opening sentences. Kept only when the article title shares a real word with the place,
// so "Shopping" or a typo never pulls an unrelated page. Cached per isolate.
const WIKI_UA='LeadvyneItinerary/1.0 (https://app.leadvyne.com; travel itinerary PDF)';
const wikiCache=new Map();
function wikiLookup(query,place,fetchImpl,timeoutMs){
  const key=norm(query);
  if(wikiCache.has(key))return wikiCache.get(key);
  const work=(async()=>{
    const url=`https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&generator=search&gsrlimit=1&gsrsearch=${encodeURIComponent(query)}&prop=pageimages%7Cextracts&piprop=thumbnail&pithumbsize=720&exintro=1&explaintext=1&exsentences=2&redirects=1`;
    const ctrl=new AbortController(),t=setTimeout(()=>ctrl.abort(),timeoutMs);
    try{
      const r=await fetchImpl(url,{signal:ctrl.signal,headers:{'User-Agent':WIKI_UA,'Api-User-Agent':WIKI_UA}});
      if(!r.ok)return null;
      const page=(await r.json())?.query?.pages?.[0];
      if(!page)return null;
      const placeWords=words(place).filter(w=>w.length>2&&!GENERIC.has(w));
      const titleWords=new Set(words(page.title));
      if(placeWords.length&&!placeWords.some(w=>titleWords.has(w)))return null;
      const extract=String(page.extract||'').replace(/\s*\([^()]*\)/g,'').replace(/\s+/g,' ').trim();
      return {title:page.title,extract,thumb:page.thumbnail?.source||''};
    }catch(e){return null;}finally{clearTimeout(t);}
  })();
  wikiCache.set(key,work);
  if(wikiCache.size>300)wikiCache.delete(wikiCache.keys().next().value);
  work.then(v=>{if(!v)wikiCache.delete(key);});
  return work;
}

const placeKey=s=>norm(s);
// Places in the plan worth a photo: short visit entries ("Charminar"), not "Check-in at hotel".
function photoPlaces(plan){
  const seen=new Set(),out=[];
  for(const d of plan.days)for(const it of d.items){
    const k=placeKey(it.description);
    if(!k||seen.has(k)||it.type!=='activity'||it.description.length>48||NOT_A_PLACE.test(it.description.trim()))continue;
    seen.add(k);out.push(it);
  }
  return out;
}

// Everything the PDF shows that lives elsewhere: logo, cover photo, and per-place photo + blurb.
export async function taFetchItineraryAssets(pkg,itin,{logoUrl='',fetchImpl=globalThis.fetch,maxPlaces=12,timeoutMs=5000}={}){
  const plan=taItineraryPlan(pkg,itin);
  const dest=titleCase(String(pkg?.destination||'').trim());
  const places=photoPlaces(plan).slice(0,maxPlaces);
  const photo=async(bytesP)=>taPrepareImage(await bytesP);
  const [logo,cover,...placeInfo]=await Promise.all([
    logoUrl?photo(fetchBytes(logoUrl,fetchImpl,timeoutMs)):null,
    dest?wikiLookup(dest,dest,fetchImpl,timeoutMs).then(async w=>w?{...w,image:w.thumb?await photo(fetchBytes(w.thumb,fetchImpl,timeoutMs)):null}:null):null,
    ...places.map(async it=>{
      const own=it.image?await photo(fetchBytes(it.image,fetchImpl,timeoutMs)):null;
      const w=await wikiLookup(dest&&!norm(it.description).includes(norm(dest))?`${it.description} ${dest}`:it.description,it.description,fetchImpl,timeoutMs);
      const image=own||(w?.thumb?await photo(fetchBytes(w.thumb,fetchImpl,timeoutMs)):null);
      return [placeKey(it.description),{image,extract:w?.extract||'',wiki:!!(w&&(!own&&image||w.extract))}];
    }),
  ]);
  return {logo,cover,places:new Map(placeInfo)};
}

/* ── PDF ─────────────────────────────────────────────────────────────────────────────────────── */

// Helvetica advance widths (1/1000 em) for ASCII 32–126; bold is close enough at ×1.07 for wrapping.
const HW=[278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const textWidth=(s,size,bold)=>{let w=0;for(const ch of s){const c=ch.charCodeAt(0);w+=c>=32&&c<=126?HW[c-32]:556;}return w*size/1000*(bold?1.07:1);};
// Standard Type1 fonts only carry WinAnsi glyphs: keep Latin-1, map common punctuation, drop the rest (emoji, ₹ …).
const pdfSafe=s=>String(s||'').replace(/₹/g,'INR ').replace(/[★☆]/g,'*').replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/[–—]/g,'-').replace(/…/g,'...').replace(/•/g,'-')
  .normalize('NFC').replace(/[^\x20-\x7E\xA0-\xFF\n]/g,'').replace(/[ \t]+/g,' ');
const esc=s=>s.replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)').replace(/[\xA0-\xFF]/g,ch=>'\\'+ch.charCodeAt(0).toString(8).padStart(3,'0'));
function wrap(text,size,bold,width,maxLines=Infinity){
  const lines=[];
  for(const para of pdfSafe(text).split('\n')){
    let line='';
    for(const word of para.split(' ').filter(Boolean)){
      let w=word;
      while(textWidth(w,size,bold)>width){ // a single word wider than the line: hard-break it
        let cut=w.length;while(cut>1&&textWidth(w.slice(0,cut),size,bold)>width)cut--;
        if(line){lines.push(line);line='';}
        lines.push(w.slice(0,cut));w=w.slice(cut);
      }
      const next=line?`${line} ${w}`:w;
      if(textWidth(next,size,bold)>width){lines.push(line);line=w;}else line=next;
    }
    lines.push(line);
  }
  if(lines.length>maxLines){
    const cut=lines.slice(0,maxLines);let last=cut[maxLines-1];
    while(last&&textWidth(last+'...',size,bold)>width)last=last.replace(/\s*\S+$/,'');
    cut[maxLines-1]=(last||'').replace(/[,;:.\s]+$/,'')+'...';
    return cut;
  }
  return lines;
}
function hexRgb(hex,fallback){
  const m=/^#?([0-9a-f]{6})$/i.exec(String(hex||'').trim());
  if(!m)return fallback;
  return [0,2,4].map(i=>parseInt(m[1].slice(i,i+2),16)/255);
}

// A4 itinerary PDF (Uint8Array): header band with the agency logo, cover photo with the package
// title, key facts, an "About <destination>" intro, the day-by-day plan with a photo and short
// description per place, inclusions / exclusions side by side, notes, and a footer with the agency
// contact and page numbers. `assets` comes from taFetchItineraryAssets (all optional).
export function taBuildItineraryPdf(pkg,itin,{agencyName='',agencyPhone='',accent='#0F7377',assets={}}={}){
  const W=595,H=842,MX=44,CW=W-MX*2,BOTTOM=64;
  const AC=hexRgb(accent,[0.06,0.45,0.47]).map(v=>v.toFixed(3)).join(' ');
  const plan=taItineraryPlan(pkg,itin);
  const name=pdfSafe(String(pkg?.name||'Package').trim());
  const agency=pdfSafe(agencyName).trim();
  const dest=titleCase(String(pkg?.destination||'').trim());
  const images=[];const imgName=img=>{if(!img)return null;let i=images.indexOf(img);if(i<0){images.push(img);i=images.length-1;}return `Im${i+1}`;};
  const logo=assets.logo,cover=assets.cover?.image,places=assets.places||new Map();
  let usedWiki=!!(assets.cover&&(cover||assets.cover.extract));

  const pages=[];let ops=[],y=0;
  const o=s=>ops.push(s);
  const txt=(x,yy,s,size,bold,rgb='0.13 0.15 0.19')=>o(`BT ${rgb} rg /${bold?'F2':'F1'} ${size} Tf ${x.toFixed(1)} ${yy.toFixed(1)} Td (${esc(s)}) Tj ET`);
  const rect=(x,yy,w,h,rgb)=>o(`${rgb} rg ${x.toFixed(1)} ${yy.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re f`);
  const round=(x,yy,w,h,r,rgb,stroke)=>{const k=0.5523*r;o(`${rgb} ${stroke?'RG 0.8 w':'rg'} ${x+r} ${yy} m ${x+w-r} ${yy} l ${x+w-r+k} ${yy} ${x+w} ${yy+r-k} ${x+w} ${yy+r} c ${x+w} ${yy+h-r} l ${x+w} ${yy+h-r+k} ${x+w-r+k} ${yy+h} ${x+w-r} ${yy+h} c ${x+r} ${yy+h} l ${x+r-k} ${yy+h} ${x} ${yy+h-r+k} ${x} ${yy+h-r} c ${x} ${yy+r} l ${x} ${yy+r-k} ${x+r-k} ${yy} ${x+r} ${yy} c h ${stroke?'S':'f'}`);};
  // Image scaled to cover the box (cropped by a clip), or to fit inside it.
  const image=(img,x,yy,w,h,{fit=false,radius=0,topOnly=false}={})=>{
    const n=imgName(img);if(!n)return;
    const s=fit?Math.min(w/img.w,h/img.h):Math.max(w/img.w,h/img.h),dw=img.w*s,dh=img.h*s;
    o('q');
    if(radius&&topOnly){const r=radius,k=0.5523*r;o(`${x} ${yy} m ${x+w} ${yy} l ${x+w} ${yy+h-r} l ${x+w} ${yy+h-r+k} ${x+w-r+k} ${yy+h} ${x+w-r} ${yy+h} c ${x+r} ${yy+h} l ${x+r-k} ${yy+h} ${x} ${yy+h-r+k} ${x} ${yy+h-r} c h W n`);}
    else if(radius){const r=radius,k=0.5523*r;o(`${x+r} ${yy} m ${x+w-r} ${yy} l ${x+w-r+k} ${yy} ${x+w} ${yy+r-k} ${x+w} ${yy+r} c ${x+w} ${yy+h-r} l ${x+w} ${yy+h-r+k} ${x+w-r+k} ${yy+h} ${x+w-r} ${yy+h} c ${x+r} ${yy+h} l ${x+r-k} ${yy+h} ${x} ${yy+h-r+k} ${x} ${yy+h-r} c ${x} ${yy+r} l ${x} ${yy+r-k} ${x+r-k} ${yy} ${x+r} ${yy} c h W n`);}
    else o(`${x.toFixed(1)} ${yy.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re W n`);
    o(`${dw.toFixed(2)} 0 0 ${dh.toFixed(2)} ${(x+(w-dw)/2).toFixed(2)} ${(yy+(h-dh)/2).toFixed(2)} cm /${n} Do Q`);
  };
  const lines=(arr,x,size,bold,rgb,gap=3)=>arr.forEach(l=>{txt(x,y-size,l,size,bold,rgb);y-=size+gap;});

  const header=first=>{
    const hh=first?84:46;
    rect(0,H-hh,W,hh,AC);
    let tx=MX;
    if(logo){
      const box=first?60:32,by=H-hh+(hh-box)/2;
      round(MX,by,box*1.6,box,6,'1 1 1');
      image(logo,MX+5,by+4,box*1.6-10,box-8,{fit:true});
      tx=MX+box*1.6+14;
    }
    if(first){
      txt(tx,H-38,(agency||'Travel Itinerary').slice(0,40),19,true,'1 1 1');
      if(agencyPhone)txt(tx,H-56,pdfSafe(agencyPhone).slice(0,40),10,false,'0.88 0.96 0.96');
      const tag='TRAVEL ITINERARY';txt(W-MX-textWidth(tag,9,true),H-38,tag,9,true,'0.88 0.96 0.96');
    }else{
      txt(tx,H-28,`${agency?agency.slice(0,40)+'  |  ':''}${name.slice(0,50)}`,10,true,'1 1 1');
    }
    y=H-hh;
  };
  const newPage=()=>{pages.push(ops);ops=[];header(false);y-=22;};
  const need=h=>{if(y-h<BOTTOM)newPage();};
  // A heading never ends a page alone: it brings `follow` points of its content with it.
  const section=(title,follow=40)=>{
    need(48+follow);y-=18;
    rect(MX,y-18,4,18,AC);
    txt(MX+12,y-14,pdfSafe(title),14,true,AC);
    y-=30;
  };

  // ── Cover ──
  header(true);
  const sub=[dest,nightsLine(pkg?.nights)].filter(Boolean).join('  |  ');
  if(cover){
    const ch=250;
    image(cover,0,y-ch,W,ch);
    o('q /GS1 gs');rect(0,y-ch,W,96,'0 0 0');o('Q');
    const tl=wrap(name,24,true,CW,2);
    let ty=y-ch+20+(sub?18:0)+(tl.length-1)*28;
    tl.forEach(l=>{txt(MX,ty,l,24,true,'1 1 1');ty-=28;});
    if(sub)txt(MX,y-ch+18,pdfSafe(sub),11.5,false,'0.92 0.95 0.95');
    y-=ch+18;
  }else{
    y-=26;
    lines(wrap(name,24,true,CW,3),MX,24,true,'0.13 0.15 0.19',6);
    if(sub){lines([pdfSafe(sub)],MX,12,false,'0.4 0.43 0.48');}
    y-=10;
  }
  // ── Key facts ──
  const price=taMoney(taPackagePrice(pkg),pkg?.currency);
  const facts=[['DESTINATION',dest],['DURATION',nightsLine(pkg?.nights)],['TRAVEL DATES',dateLine(itin)],['TRAVELLERS',paxLine(pkg)],['PRICE PER PERSON',price]].filter(f=>f[1]).slice(0,4);
  if(facts.length){
    const gap=10,bw=(CW-gap*(facts.length-1))/facts.length,bh=50;
    facts.forEach(([k,v],i)=>{
      const x=MX+i*(bw+gap);
      round(x,y-bh,bw,bh,8,'0.95 0.97 0.97');
      txt(x+12,y-19,k,7.5,true,'0.45 0.5 0.55');
      const vl=wrap(v,k.startsWith('PRICE')?12.5:11,true,bw-20,1)[0];
      txt(x+12,y-37,vl,k.startsWith('PRICE')?12.5:11,true,k.startsWith('PRICE')?AC:'0.13 0.15 0.19');
    });
    y-=bh+6;
  }
  // ── About the destination ──
  if(assets.cover?.extract){
    section(`About ${dest}`);
    for(const l of wrap(assets.cover.extract,10.5,false,CW,6)){need(15);txt(MX,y-10.5,l,10.5,false,'0.25 0.28 0.32');y-=15;}
  }
  // ── Day by day ──
  if(plan.days.length){
    section('Your Day-by-Day Plan',270);
    plan.days.forEach(d=>{
      const first=d.items.find(it=>!(it.description===d.title&&d.items.length===1&&!places.get(placeKey(it.description))?.image));
      need(first&&places.get(placeKey(first.description))?.image?60+200:60+40);
      y-=6;
      o(`${AC} rg ${MX+15} ${y-15} m ${MX+15+8.28} ${y-15} ${MX+30} ${y-15-6.72} ${MX+30} ${y-30} c ${MX+30} ${y-30-8.28} ${MX+15+8.28} ${y-45} ${MX+15} ${y-45} c ${MX+15-8.28} ${y-45} ${MX} ${y-30-8.28} ${MX} ${y-30} c ${MX} ${y-30+8.28} ${MX+15-8.28} ${y-15} ${MX+15} ${y-15} c f`);
      const num=String(d.day_no).padStart(2,'0');
      txt(MX+15-textWidth(num,12,true)/2,y-34,num,12,true,'1 1 1');
      txt(MX+42,y-25,`DAY ${d.day_no}`,8.5,true,AC);
      txt(MX+42,y-41,wrap(d.title||`Day ${d.day_no}`,14,true,CW-42,1)[0],14,true);
      y-=54;
      const items=d.items.filter(it=>!(it.description===d.title&&d.items.length===1&&!places.get(placeKey(it.description))?.image));
      // Places with a photo go in a two-column grid of cards; everything else is a bullet line.
      const gw=(CW-12)/2,ph=118;
      const card=it=>{
        const info=places.get(placeKey(it.description));
        const head=wrap(it.description,11,true,gw-20,2);
        const body=info.extract?wrap(info.extract,8.8,false,gw-20,4):[];
        return {info,head,body,h:ph+16+head.length*14+body.length*11.8+8};
      };
      const flush=row=>{
        if(!row.length)return;
        const cards=row.map(card),rh=Math.max(...cards.map(c=>c.h));
        need(rh+10);
        cards.forEach((c,i)=>{
          const x=MX+i*(gw+12);
          round(x,y-rh,gw,rh,8,'0.965 0.972 0.98');
          image(c.info.image,x,y-ph,gw,ph,{radius:8,topOnly:true});
          let ty=y-ph-16;
          c.head.forEach(l=>{txt(x+10,ty,l,11,true);ty-=14;});
          c.body.forEach(l=>{txt(x+10,ty,l,8.8,false,'0.36 0.39 0.44');ty-=11.8;});
        });
        y-=rh+10;
      };
      let row=[];
      items.forEach(it=>{
        const info=it.type==='activity'?places.get(placeKey(it.description)):null;
        if(info?.wiki)usedWiki=true;
        if(info?.image){row.push(it);if(row.length===2){flush(row);row=[];}return;}
        flush(row);row=[];
        const label=it.type==='activity'?'':`${ITEM_LABEL[it.type]}: `;
        const head=wrap(label+it.description,10.8,true,CW-24);
        const body=info?.extract?wrap(info.extract,9.2,false,CW-24,3):[];
        need(head.length*14+body.length*12.5+8);
        o(`${AC} rg ${MX+7} ${y-7.5} m ${MX+9.2} ${y-7.5} ${MX+11} ${y-9.3} ${MX+11} ${y-11.5} c ${MX+11} ${y-13.7} ${MX+9.2} ${y-15.5} ${MX+7} ${y-15.5} c ${MX+4.8} ${y-15.5} ${MX+3} ${y-13.7} ${MX+3} ${y-11.5} c ${MX+3} ${y-9.3} ${MX+4.8} ${y-7.5} ${MX+7} ${y-7.5} c f`);
        head.forEach(l=>{txt(MX+18,y-14.5,l,10.8,true);y-=14;});
        body.forEach(l=>{txt(MX+18,y-12.5,l,9.2,false,'0.36 0.39 0.44');y-=12.5;});
        y-=8;
      });
      flush(row);
      y-=6;
    });
  }
  // ── Inclusions / exclusions ──
  const inc=taList(pkg?.inclusions),exc=taList(pkg?.exclusions);
  if(inc.length||exc.length){
    const cols=[[inc,'check','0.09 0.6 0.34','INCLUDED'],[exc,'cross','0.82 0.2 0.2','NOT INCLUDED']].filter(c=>c[0].length);
    const cw=cols.length>1?(CW-16)/2:CW;
    const rows=cols.map(([list])=>list.map(x=>wrap(x,10,false,cw-30)));
    const colH=rows.map(r=>r.reduce((s,l)=>s+l.length*13+5,0)+34);
    const bh=Math.max(...colH);
    section(inc.length?"What's Included":"What's Not Included",Math.min(bh,H-BOTTOM-160));
    cols.forEach(([,mark,rgb,label],ci)=>{
      const x=MX+ci*(cw+16);let cy=y;
      const myH=Math.min(bh,y-BOTTOM);
      round(x,y-myH,cw,myH,8,'0.975 0.98 0.985');
      txt(x+14,cy-18,label,8,true,rgb);cy-=30;
      rows[ci].forEach(ls=>{
        if(cy-ls.length*13<BOTTOM)return;
        const mx=x+15,my=cy-9.5;
        o(mark==='check'?`${rgb} RG 1.6 w 1 J 1 j ${mx} ${my+3.5} m ${mx+3} ${my+0.5} l ${mx+8} ${my+7} l S`
          :`${rgb} RG 1.6 w 1 J ${mx+0.5} ${my+0.5} m ${mx+7} ${my+7} l ${mx+0.5} ${my+7} m ${mx+7} ${my+0.5} l S`);
        ls.forEach(l=>{txt(x+30,cy-10,l,10,false,'0.2 0.23 0.27');cy-=13;});
        cy-=5;
      });
    });
    y-=bh+6;
  }
  // ── Notes & terms ──
  if(plan.notes){section('Good to Know');for(const l of wrap(plan.notes,10,false,CW)){need(14);txt(MX,y-10,l,10,false,'0.25 0.28 0.32');y-=14;}}
  need(40);y-=14;
  for(const l of wrap(`${price?'Prices are per person. ':''}All services are subject to availability at the time of booking. Please contact us to confirm dates and the final price.`,8.5,false,CW)){txt(MX,y-8.5,l,8.5,false,'0.45 0.5 0.55');y-=11.5;}
  if(usedWiki){y-=2;txt(MX,y-8,'Place photos and descriptions: Wikipedia / Wikimedia Commons (CC BY-SA).',7.5,false,'0.55 0.58 0.62');}
  pages.push(ops);

  const total=pages.length;
  const contact=[agency,pdfSafe(agencyPhone).trim()].filter(Boolean).join('   |   ');
  pages.forEach((p,i)=>{
    p.push(`${AC} rg 0 0 ${W} 4 re f`);
    p.push(`0.86 0.88 0.9 RG 0.6 w ${MX} 44 m ${W-MX} 44 l S`);
    if(contact)p.push(`BT 0.42 0.45 0.5 rg /F2 8.5 Tf ${MX} 28 Td (${esc(contact.slice(0,90))}) Tj ET`);
    const label=`Page ${i+1} of ${total}`;
    p.push(`BT 0.42 0.45 0.5 rg /F1 8.5 Tf ${(W-MX-textWidth(label,8.5)).toFixed(1)} 28 Td (${label}) Tj ET`);
  });

  // ── Assemble: 1 catalog, 2 pages, 3–4 fonts, 5 ExtGState, then images (+SMasks), then pages ──
  const enc=new TextEncoder();
  const parts=[];let pos=0;const offs=[];
  const put=x=>{const b=typeof x==='string'?enc.encode(x):x;parts.push(b);pos+=b.length;};
  const objs=[];const reserve=()=>{objs.push(null);return objs.length;};
  const cat=reserve(),pagesObj=reserve(),f1=reserve(),f2=reserve(),gs=reserve();
  const imgObjs=images.map(img=>{const id=reserve();const sm=img.smask?reserve():0;return {img,id,sm};});
  const pageObjs=pages.map(()=>({page:reserve(),content:reserve()}));
  objs[cat-1]='<</Type /Catalog /Pages 2 0 R>>';
  objs[pagesObj-1]=`<</Type /Pages /Kids [${pageObjs.map(p=>`${p.page} 0 R`).join(' ')}] /Count ${total}>>`;
  objs[f1-1]='<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding>>';
  objs[f2-1]='<</Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding>>';
  objs[gs-1]='<</Type /ExtGState /ca 0.5>>';
  imgObjs.forEach(({img,id,sm})=>{
    objs[id-1]={dict:`<</Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /${img.cs} /BitsPerComponent 8 /Filter /${img.filter}${img.decode?' /Decode [1 0 1 0 1 0 1 0]':''}${sm?` /SMask ${sm} 0 R`:''} /Length ${img.data.length}>>`,data:img.data};
    if(sm)objs[sm-1]={dict:`<</Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${img.smask.length}>>`,data:img.smask};
  });
  const xobjs=imgObjs.map((x,i)=>`/Im${i+1} ${x.id} 0 R`).join(' ');
  const res=`<</Font <</F1 ${f1} 0 R /F2 ${f2} 0 R>> /ExtGState <</GS1 ${gs} 0 R>>${xobjs?` /XObject <<${xobjs}>>`:''}>>`;
  pages.forEach((p,i)=>{
    const content=enc.encode(p.join('\n'));
    objs[pageObjs[i].page-1]=`<</Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${pageObjs[i].content} 0 R /Resources ${res}>>`;
    objs[pageObjs[i].content-1]={dict:`<</Length ${content.length}>>`,data:content};
  });
  put('%PDF-1.4\n');
  objs.forEach((ob,i)=>{
    offs[i+1]=pos;
    if(typeof ob==='string')put(`${i+1} 0 obj\n${ob}\nendobj\n`);
    else{put(`${i+1} 0 obj\n${ob.dict}\nstream\n`);put(ob.data);put('\nendstream\nendobj\n');}
  });
  const xref=pos;
  put(`xref\n0 ${objs.length+1}\n0000000000 65535 f \n`);
  for(let n=1;n<=objs.length;n++)put(`${String(offs[n]).padStart(10,'0')} 00000 n \n`);
  put(`trailer\n<</Size ${objs.length+1} /Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`);
  const out=new Uint8Array(pos);let at=0;for(const b of parts){out.set(b,at);at+=b.length;}
  return out;
}

export function taItineraryPdfName(pkg){
  return `Itinerary-${String(pkg?.name||'package').replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'').slice(0,60)||'package'}.pdf`;
}
