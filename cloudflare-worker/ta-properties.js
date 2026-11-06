// Travel Agency "Resorts & Hotels" catalog: the properties an agency sells as products, each with
// its own Google Drive photos, video and PDF brochure. The bot answers from these records (see
// taPropertyContextLines) and forwards a property's media straight into the chat when a lead names
// it, asks for its photos/video/brochure, or the bot's own reply recommends it (taPropertyMediaPlan).
// Pure helpers only — storage, routes and the Chatwoot send live in worker.js.

export const TA_PROPERTY_TYPES=['resort','hotel','villa','homestay','houseboat','apartment','camp','other'];
// Who a resort is for. 'both' is a Family and a Couple resort at once; '' is a general property.
export const TA_RESORT_CATEGORIES=['family','couple','both'];
export const TA_RESORT_CATEGORY_LABEL={family:'Family Resort',couple:'Couple Resort',both:'Family & Couple Resort'};
// The lead's CRM Service Category for each (the CRM's built-in category list has both).
export const TA_RESORT_SERVICE_CATEGORY={family:'Family Resort',couple:'Couple Resort'};
export const TA_PROPERTY_FIELDS=['name','property_type','category','location','star_rating','room_types','price_from','currency','price_unit','amenities','description','image_url','image_url_2','image_url_3','video_url','pdf_url','status'];
export const TA_PROPERTY_MEDIA_FIELDS=['image_url','image_url_2','image_url_3','video_url','pdf_url'];
const MEDIA_LABEL={image_url:'Photo 1',image_url_2:'Photo 2',image_url_3:'Photo 3',video_url:'Video',pdf_url:'PDF brochure'};

// Words that say what kind of property it is rather than which one — "the beach resort" must not
// match every property whose name ends in "Resort".
const GENERIC=new Set(['resort','resorts','hotel','hotels','villa','villas','homestay','houseboat','apartment','apartments','camp','spa','and','the','a','an','of','by','at','in','&']);

export function taPropertyNormalize(v){
  return String(v||'').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu,' ').replace(/\s+/g,' ').trim();
}

// A Drive folder can't be forwarded as one attachment, and a Drive link we can't pull a file id out
// of would fail silently at send time — reject both when the agency saves the property instead.
export function taPropertyMediaUrlError(field, value){
  const url=String(value||'').trim();
  if(!url) return '';
  const label=MEDIA_LABEL[field]||field;
  if(!/^https?:\/\//i.test(url)) return `${label}: paste a full link starting with https://`;
  if(/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\//i.test(url)) return `${label}: paste the Google Drive link of the file itself, not a folder. Share it as "Anyone with the link can view."`;
  if(/(?:drive|docs)\.google\.com/i.test(url)&&!/\/(?:file|document|presentation|spreadsheets)\/d\/[\w-]+|[?&]id=[\w-]+/.test(url)) return `${label}: this doesn't look like a Google Drive file share link.`;
  return '';
}

// Cleans a create/update body into column values. `partial` keeps only the keys that were sent
// (PATCH); otherwise every field is filled. Returns {values} or {error}.
export function taPropertyClean(body, partial=false){
  const values={};
  for(const f of TA_PROPERTY_FIELDS){
    if(partial&&!(f in (body||{}))) continue;
    let v=body?.[f];
    if(f==='star_rating'){ const n=Number(v); v=Number.isFinite(n)&&n>=1&&n<=7?Math.round(n):null; }
    else if(f==='price_from'){ const n=Number(v); v=v!==''&&v!=null&&Number.isFinite(n)&&n>=0?n:null; }
    else if(f==='status') v=v==='inactive'?'inactive':'active';
    else if(f==='property_type') v=TA_PROPERTY_TYPES.includes(v)?v:'resort';
    else if(f==='category') v=TA_RESORT_CATEGORIES.includes(v)?v:'';
    else if(f==='currency') v=String(v||'INR').trim().toUpperCase().slice(0,3)||'INR';
    else if(f==='price_unit') v=String(v||'per night').trim().slice(0,40)||'per night';
    else v=String(v??'').trim().slice(0,f==='description'?2000:f.endsWith('_url')?600:500);
    if(TA_PROPERTY_MEDIA_FIELDS.includes(f)){ const err=taPropertyMediaUrlError(f,v); if(err) return {error:err}; }
    values[f]=v;
  }
  if(!partial&&!values.name) return {error:'Property name is required'};
  if(partial&&'name' in values&&!values.name) return {error:'Property name is required'};
  return {values};
}

export function taPropertyHasMedia(p){
  return TA_PROPERTY_MEDIA_FIELDS.some(f=>String(p?.[f]||'').trim());
}

// What media the lead is asking for, or null when the message isn't a media request at all.
// An ask that names no kind ("more details", "show me") gets everything.
export function taPropertyMediaRequest(text){
  const t=taPropertyNormalize(text);
  if(!t) return null;
  const images=/\b(?:photos?|pics?|pictures?|images?|imgs?|snaps?|gallery|look like|looks like)\b/.test(t);
  const video=/\b(?:videos?|clips?|reels?|walk ?through|tour video)\b/.test(t);
  const pdf=/\b(?:pdf|brochures?|catalog(?:ue)?|documents?|details? (?:file|sheet)|tariff sheet|rate card)\b/.test(t);
  if(images||video||pdf) return {images,video,pdf};
  if(/\b(?:show me|have a look|more details|full details)\b/.test(t)) return {images:true,video:true,pdf:true};
  return null;
}

export function taPropertyInCategory(p, cat){
  return !!cat&&(p?.category===cat||p?.category==='both');
}

// Which kind of resort the lead is after: 'family' (kids, parents, family trip) or 'couple'
// (honeymoon, romantic, anniversary, wife/husband). Children mean family. null when neither, or
// when it says both ("family and couple").
const FAMILY_RE=/\b(?:family|families|kids?|children|child|parents|grand ?parents|toddlers?|infants?|baby|babies|son|daughter|kid friendly|family friendly)\b/;
const KIDS_RE=/\b(?:kids?|children|child|toddlers?|infants?|baby|babies|\d+ (?:kids?|children|child))\b/;
const COUPLE_RE=/\b(?:couples?|honey ?moon(?:ers?)?|romantic|romance|anniversary|wife|husband|newly ?weds?|newly married|just married|partner|girlfriend|boyfriend|fianc[eé]e?|candle ?light|private pool villa|2 adults|two adults|for two)\b/;
export function taResortCategoryFromText(text){
  const t=taPropertyNormalize(text);
  if(!t) return null;
  // Children along make it a family trip even for "2 adults and 2 kids".
  if(KIDS_RE.test(t)) return 'family';
  const fam=FAMILY_RE.test(t), cpl=COUPLE_RE.test(t);
  return fam===cpl?null:fam?'family':'couple';
}

// The CRM Service Category to file the lead under this turn ('Family Resort' / 'Couple Resort'),
// or null. Only when the agency actually lists a resort of that kind, and never over a category
// the lead already has for something else (a Visa or Package lead stays where it is).
export function taResortLeadCategory(properties, {userText='', sentProperties=[], currentCategory=''}={}){
  const cur=String(currentCategory||'').trim();
  if(cur&&!['Hotel','Family Resort','Couple Resort'].includes(cur)) return null;
  let cat=taResortCategoryFromText(userText);
  if(!cat){
    const cats=new Set((sentProperties||[]).map(p=>p?.category).filter(c=>c==='family'||c==='couple'));
    if(cats.size===1) cat=[...cats][0];
  }
  if(!cat||!(properties||[]).some(p=>p&&p.status!=='inactive'&&taPropertyInCategory(p,cat))) return null;
  const out=TA_RESORT_SERVICE_CATEGORY[cat];
  return out===cur?null:out;
}

// The properties a text names. A name matches whole-word on its own, or on its distinctive words
// (the ones left after GENERIC) when those are specific enough — so "spice village" finds
// "Spice Village Resort" but "beach" alone doesn't find "Beach Resort" and "Beach Hotel" both.
export function taPropertiesInText(properties, text){
  const hay=' '+taPropertyNormalize(text)+' ';
  if(hay.trim()==='') return [];
  const out=[];
  for(const p of properties||[]){
    const name=taPropertyNormalize(p?.name);
    if(name.length<3) continue;
    if(hay.includes(' '+name+' ')){ out.push(p); continue; }
    const core=name.split(' ').filter(w=>!GENERIC.has(w)).join(' ');
    if(core.length>=6&&core!==name&&hay.includes(' '+core+' ')) out.push(p);
  }
  return out;
}

// Decides which property's media to forward this turn, and which kinds of media.
//   1. The lead's own message names properties → those (they asked about them by name).
//   2. The lead asked for photos/video/PDF without a name → the one property the bot's reply, or
//      else its previous reply, was talking about; or the only property when there is just one.
//   3. Otherwise, the bot's reply recommends one or two properties → those (a longer list is a
//      comparison answer, not a recommendation, and sending every gallery would flood the chat).
// `explicit` is true when the lead asked for media — the caller re-sends even if sent before.
export function taPropertyMediaPlan(properties, {userText='', replyText='', previousBotText=''}={}){
  const withMedia=(properties||[]).filter(p=>p&&p.status!=='inactive'&&taPropertyHasMedia(p));
  if(!withMedia.length) return null;
  const ask=taPropertyMediaRequest(userText);
  const all={images:true,video:true,pdf:true};
  const named=taPropertiesInText(withMedia, userText);
  if(named.length) return {properties:named.slice(0,3), kinds:ask||all, explicit:!!ask};
  if(ask){
    const inReply=taPropertiesInText(withMedia, replyText);
    if(inReply.length===1) return {properties:inReply, kinds:ask, explicit:true};
    const inPrev=inReply.length?[]:taPropertiesInText(withMedia, previousBotText);
    if(inPrev.length===1) return {properties:inPrev, kinds:ask, explicit:true};
    // "Photos of your couple resorts" — the only one of that kind, when there is just one.
    const cat=taResortCategoryFromText(userText);
    const ofCat=cat?withMedia.filter(p=>taPropertyInCategory(p,cat)):[];
    if(ofCat.length===1) return {properties:ofCat, kinds:ask, explicit:true};
    if(withMedia.length===1) return {properties:withMedia, kinds:ask, explicit:true};
    return null;
  }
  const mentioned=taPropertiesInText(withMedia, replyText);
  if(mentioned.length>=1&&mentioned.length<=2) return {properties:mentioned, kinds:all, explicit:false};
  return null;
}

// The Drive links to forward for one property, in send order: photos, video, then brochure.
// The first item carries the property's name as its caption.
export function taPropertyMediaItems(p, kinds={images:true,video:true,pdf:true}){
  const items=[];
  if(kinds.images) ['image_url','image_url_2','image_url_3'].forEach(f=>{ if(String(p?.[f]||'').trim()) items.push({field:f, url:String(p[f]).trim()}); });
  if(kinds.video&&String(p?.video_url||'').trim()) items.push({field:'video_url', url:String(p.video_url).trim()});
  if(kinds.pdf&&String(p?.pdf_url||'').trim()) items.push({field:'pdf_url', url:String(p.pdf_url).trim(), filename:taPropertyNormalize(p.name).replace(/ /g,'-').slice(0,60)+'-brochure.pdf'});
  if(items.length) items[0].caption=taPropertyCaption(p);
  return items;
}

export function taPropertyCaption(p){
  const stars=Number(p?.star_rating)>0?' '+'⭐'.repeat(Math.min(7,Number(p.star_rating))):'';
  const where=p?.location?` — ${p.location}`:'';
  const price=Number(p?.price_from)>0?`\nFrom ${p.currency||'INR'} ${Number(p.price_from).toLocaleString('en-IN')} ${p.price_unit||'per night'}`:'';
  return `🏨 ${p?.name||''}${stars}${where}${price}`;
}

// Lines for the bot's grounded travel context. Media itself is never described to the model — it
// only needs to know that real files exist and are sent by the system, so it doesn't apologise for
// "not being able to send photos".
export function taPropertyContextLines(properties){
  const active=(properties||[]).filter(p=>p&&p.status!=='inactive'&&p.name).slice(0,30);
  if(!active.length) return [];
  const lines=['## Resorts & Hotels'];
  // Family resorts first, then couple, then the rest — the model reads them grouped.
  const rank=p=>({family:0,both:1,couple:2}[p.category]??3);
  active.slice().sort((a,b)=>rank(a)-rank(b)).forEach(p=>{
    let line=`- ${p.name} (${TA_RESORT_CATEGORY_LABEL[p.category]||p.property_type||'resort'}${Number(p.star_rating)>0?`, ${p.star_rating}-star`:''})`;
    if(p.location) line+=` — ${p.location}`;
    line+=Number(p.price_from)>0?` — from ${p.currency||'INR'} ${p.price_from} ${p.price_unit||'per night'}`:' — price on request';
    if(p.room_types) line+=` — rooms: ${String(p.room_types).replace(/\s*\n\s*/g,', ').slice(0,150)}`;
    if(p.amenities) line+=` — amenities: ${String(p.amenities).replace(/\s*\n\s*/g,', ').slice(0,150)}`;
    if(p.description) line+=` — ${String(p.description).replace(/\s+/g,' ').slice(0,200)}`;
    const media=[];
    if(p.image_url||p.image_url_2||p.image_url_3) media.push('photos');
    if(p.video_url) media.push('video');
    if(p.pdf_url) media.push('PDF brochure');
    if(media.length) line+=` — ${media.join(', ')} available`;
    lines.push(line);
  });
  if(active.some(p=>p.category)) lines.push('Resort categories: for a family trip (kids, parents) recommend Family Resorts; for a honeymoon, anniversary or a couple recommend Couple Resorts ("Family & Couple" suits both). Ask who is travelling if it is not clear, and only recommend from this list.');
  lines.push('When a resort/hotel above has photos, video or a PDF brochure, the system sends those files to the customer automatically whenever you name that property or the customer asks for them — always use the property\'s exact name, never say you cannot send photos/videos, and never write image placeholders.');
  return lines;
}
