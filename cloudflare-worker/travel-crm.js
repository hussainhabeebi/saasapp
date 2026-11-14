/* ── Travel CRM tools (travel agency accounts, optional) ──────────────────────────────────────────
   Dashboard → Settings → 🧩 Industry Modules → 📲 Travel CRM tools. Off unless the account turns it
   on (CLIENTS.travel_crm_enabled = 'Yes'), and only for travel agency accounts (industry 'travel'
   or the Travel Agency module on) — every other account works exactly as before.
   What it adds (frontend/travel-crm.js does the screens):
     • which connected WhatsApp number each enquiry came in on (the lead's InboxId → /travel-crm/numbers)
     • enquiry type, route and travel dates on the lead (EnquiryType, TravelRoute, TravelTrips)
     • TripStatus: Upcoming / Travelling / Completed — worked out from the travel dates, and stamped
       on the lead every morning (runTravelCrmTripStatus) so a trip that has ended shows Completed
     • replies typed in the WhatsApp Business app (Meta "coexistence" smb_message_echoes) land in
       the Chats inbox as a team reply ("WhatsApp Business app").
   Pure logic + injected deps, so it is unit-tested without a network (travel-crm.test.js). ── */

export const TCRM_APP_SENDER='📱 WhatsApp Business app';
export const TCRM_DEFAULT_ENQUIRY_TYPES=['Air Ticket','Holiday Package','Visa','Hotel Booking','Umrah / Hajj','Group Booking','Other'];
export const TCRM_DEFAULT_ROUTES=['Calicut → Dubai','Calicut → Sharjah','Kochi → Dubai'];
export const TCRM_LEAD_FIELDS=['EnquiryType','TravelRoute','TravelRouteBy',['TravelTrips','LongText'],'TripStatus','NextTravelDate'];

const yes=v=>String(v||'').trim().toLowerCase()==='yes';
export function travelCrmIsTravelAccount(c){ return String(c?.industry||'')==='travel' || yes(c?.ta_enabled); }
export function travelCrmOn(c){ return travelCrmIsTravelAccount(c) && yes(c?.travel_crm_enabled); }
// Route & travel dates (tags, travel profile, Completed, auto-detection from chats): on for every
// travel agency account unless switched off in Travel Settings → 📲 Travel CRM.
export function travelCrmTripsOn(c){ return travelCrmIsTravelAccount(c) && String(c?.travel_trips_enabled||'').trim().toLowerCase()!=='no'; }

// "Calicut to Dubai", "calicut-dubai", "Calicut > Dubai", "CCJ → DXB" → "Calicut → Dubai".
export function travelCrmNormRoute(raw){
  const s=String(raw||'').replace(/\s+/g,' ').trim();
  if(!s) return '';
  // A bare hyphen only separates when there are no spaces ("Calicut-Dubai"), so "Ras Al-Khaimah"
  // stays one place.
  let parts=s.split(/\s*(?:→|->|=>|>|–|—|\/)\s*|\s+to\s+|\s+-\s+/i).map(x=>x.trim()).filter(Boolean);
  if(parts.length<2 && !/\s/.test(s)) parts=s.split('-').map(x=>x.trim()).filter(Boolean);
  const cap=w=>w.length<=3&&w===w.toUpperCase()?w:w.replace(/\b\w/g,ch=>ch.toUpperCase());
  if(parts.length>=2) return `${cap(parts[0])} → ${cap(parts[parts.length-1])}`.slice(0,80);
  return cap(s).slice(0,80);
}

export function travelCrmConfig(c){
  let cfg={}; try{ cfg=JSON.parse(c?.travel_crm_config||'{}')||{}; }catch(e){}
  const list=(v, d)=>{
    const a=Array.isArray(v)?v.map(x=>String(x||'').trim().slice(0,60)).filter(Boolean):[];
    return a.length?[...new Set(a)]:d.slice();
  };
  return {enquiry_types:list(cfg.enquiry_types, TCRM_DEFAULT_ENQUIRY_TYPES),
    routes:list(Array.isArray(cfg.routes)?cfg.routes.map(travelCrmNormRoute):cfg.routes, TCRM_DEFAULT_ROUTES)};
}

const ISO=/^\d{4}-\d{2}-\d{2}$/;
const day=v=>{ const s=String(v||'').trim().slice(0,10); return ISO.test(s)?s:''; };
export function travelCrmParseTrips(raw){
  let v=raw; if(typeof v==='string'){ try{ v=JSON.parse(v||'[]'); }catch(e){ v=[]; } }
  return (Array.isArray(v)?v:[]).filter(t=>t&&typeof t==='object').map(t=>({
    id:String(t.id||'').slice(0,40), route:travelCrmNormRoute(t.route), depart:day(t.depart), ret:day(t.ret), note:String(t.note||'').slice(0,300),
    ...(t.auto===true?{auto:true}:{}),
  })).filter(t=>t.depart||t.ret);
}
// The trips a lead has: TravelTrips, else the older single "from → to" TravelDates field.
export function travelCrmLeadTrips(lead){
  const trips=travelCrmParseTrips(lead?.TravelTrips);
  if(trips.length) return trips;
  const [a,b]=String(lead?.TravelDates||'').split('→').map(x=>day(x));
  return a||b?[{id:'legacy', route:travelCrmNormRoute(lead?.TravelRoute||''), depart:a||b, ret:b||'', note:''}]:[];
}
export function travelCrmTripStatus(trip, today){
  const start=trip.depart||trip.ret, end=trip.ret||trip.depart;
  if(!start) return '';
  if(end<today) return 'Completed';
  if(start<=today) return 'Travelling';
  return 'Upcoming';
}
// The lead's status across all its trips: travelling now beats an upcoming trip, which beats
// trips that are all over. '' when there are no travel dates.
export function travelCrmLeadTripStatus(lead, today){
  const st=travelCrmLeadTrips(lead).map(t=>travelCrmTripStatus(t, today));
  if(!st.length) return '';
  if(st.includes('Travelling')) return 'Travelling';
  if(st.includes('Upcoming')) return 'Upcoming';
  return 'Completed';
}
// The date the lead is "about": the next trip still to start, else the latest one.
export function travelCrmNextDate(lead, today){
  const ds=travelCrmLeadTrips(lead).map(t=>t.depart||t.ret).filter(Boolean).sort();
  return ds.find(d=>d>=today)||ds[ds.length-1]||'';
}
// The Leads PATCH that brings TripStatus / NextTravelDate up to date, or null when nothing changed.
export function travelCrmTripPatch(lead, today){
  const status=travelCrmLeadTripStatus(lead, today), next=travelCrmNextDate(lead, today);
  if(String(lead?.TripStatus||'')===status && String(lead?.NextTravelDate||'').slice(0,10)===next) return null;
  return {Id:Number(lead.Id), TripStatus:status, NextTravelDate:next};
}

// Daily, per account: every lead with travel dates gets its TripStatus refreshed, so an enquiry
// whose travel date has passed reads Completed without anyone touching it.
//   deps.listLeads(clientId) → leads with Id, TravelTrips, TravelDates, TripStatus, NextTravelDate
//   deps.patch(rows); deps.broadcast(clientId, payload)
export async function travelCrmTripStatusProcessClient(c, deps, now=new Date()){
  if(!travelCrmTripsOn(c)) return {updated:0};
  const today=now.toISOString().slice(0,10);
  const patches=(await deps.listLeads(c.Id)||[]).map(l=>travelCrmTripPatch(l, today)).filter(Boolean);
  for(let i=0;i<patches.length;i+=50) await deps.patch(patches.slice(i,i+50));
  if(patches.length){
    try{ await deps.broadcast(c.Id, {type:'lead_updated', lead_ids:patches.map(p=>p.Id).slice(0,100), fields:['TripStatus','NextTravelDate'], by:'auto', at:now.toISOString()}); }catch(e){}
  }
  return {updated:patches.length};
}

/* ── WhatsApp numbers ─────────────────────────────────────────────────────────────────────────── */
// Chatwoot inboxes + saved Meta credentials → [{inbox_id, name, phone}] for the WhatsApp numbers.
export function travelCrmNumbers(inboxes, credentials=[]){
  const byId=new Map();
  for(const ib of inboxes||[]){
    if(ib?.channel_type!=='Channel::Whatsapp') continue;
    byId.set(String(ib.id), {inbox_id:String(ib.id), name:String(ib.name||'').slice(0,80), phone:String(ib.phone_number||'').slice(0,30)});
  }
  for(const cr of credentials||[]){
    const id=String(cr?.inbox_id||''); if(!id) continue;
    const row=byId.get(id)||{inbox_id:id, name:'', phone:''};
    if(!row.phone && cr.display_phone) row.phone=String(cr.display_phone).slice(0,30);
    byId.set(id, row);
  }
  return [...byId.values()];
}

/* ── WhatsApp Business app replies (Meta coexistence: smb_message_echoes) ─────────────────────── */
// Meta webhook body → [{phone_number_id, to, id, ts, text}] for each message the business sent from
// the WhatsApp Business app on its phone.
export function travelCrmParseEchoes(body){
  const out=[];
  if(body?.object!=='whatsapp_business_account') return out;
  for(const entry of body.entry||[]) for(const ch of entry?.changes||[]){
    if(ch?.field!=='smb_message_echoes') continue;
    const v=ch.value||{}, pid=String(v.metadata?.phone_number_id||'');
    for(const m of v.message_echoes||[]){
      const to=String(m?.to||'').replace(/\D/g,'');
      if(!pid||to.length<8) continue;
      const type=String(m.type||'text');
      const text=type==='text'?String(m.text?.body||''):
        (String(m[type]?.caption||'').trim() ? `[${type}] ${m[type].caption}` : `[${type}]`);
      const sec=Number(m.timestamp);
      out.push({phone_number_id:pid, to, id:String(m.id||''), ts:new Date(Number.isFinite(sec)&&sec>0?sec*1000:Date.now()).toISOString(), text:text.trim().slice(0,4000)});
    }
  }
  return out;
}
const normText=s=>String(s||'').toLowerCase().replace(/\s+/g,' ').trim();
// Already in the thread? (Chatwoot may deliver the same reply, or a replayed webhook.)
export function travelCrmEchoSeen(text, recent){
  const n=normText(text);
  if(!n) return true;
  return (recent||[]).some(r=>{ const x=normText(r?.content); return x && (x===n || (n.length>=20 && x.includes(n))); });
}
// deps.clientForPhoneNumberId(pid) → client row | null
// deps.leadForPhone(clientId, digits) → lead {Id} | null
// deps.recentAssistant(leadId) → [{content}] latest assistant rows
// deps.insert(leadId, clientId, msg); deps.markAgentReply(leadId, ts)
export async function travelCrmProcessEchoes(body, deps){
  const echoes=travelCrmParseEchoes(body);
  let saved=0;
  const clients=new Map();
  for(const e of echoes){
    if(!clients.has(e.phone_number_id)) clients.set(e.phone_number_id, await deps.clientForPhoneNumberId(e.phone_number_id).catch(()=>null));
    const c=clients.get(e.phone_number_id);
    if(!c || !travelCrmOn(c)) continue;
    const lead=await deps.leadForPhone(c.Id, e.to).catch(()=>null);
    if(!lead?.Id) continue;
    if(travelCrmEchoSeen(e.text, await deps.recentAssistant(lead.Id).catch(()=>[]))) continue;
    await deps.insert(lead.Id, c.Id, {role:'assistant', content:e.text, ts:e.ts, sender_type:'agent', sender_name:TCRM_APP_SENDER});
    try{ await deps.markAgentReply(lead.Id, e.ts); }catch(err){}
    saved++;
  }
  return {received:echoes.length, saved};
}

/* ── Settings (Live Agency → ⚙️ Travel Settings → 📲 Travel CRM; worker GET/PUT /travel-crm/settings) ── */
export function travelCrmSettingsView(c){
  return {enabled:travelCrmOn(c), trips_enabled:travelCrmTripsOn(c), is_travel_account:travelCrmIsTravelAccount(c), ...travelCrmConfig(c)};
}
// PUT body {enabled, enquiry_types[], routes[]} → the CLIENTS fields to save, or {error}.
export function travelCrmSettingsPatch(body, c){
  if(!travelCrmIsTravelAccount(c)) return {error:'Travel CRM tools are for travel agency accounts.'};
  for(const k of ['enabled','trips_enabled']) if(k in (body||{}) && typeof body[k]!=='boolean') return {error:`${k} must be true or false`};
  for(const k of ['enquiry_types','routes']) if(k in (body||{}) && !Array.isArray(body[k])) return {error:`${k} must be a list`};
  const cur=travelCrmConfig(c);
  const types=Array.isArray(body?.enquiry_types)?[...new Set(body.enquiry_types.map(x=>String(x||'').trim().slice(0,60)).filter(Boolean))].slice(0,40):cur.enquiry_types;
  const routes=Array.isArray(body?.routes)?[...new Set(body.routes.map(travelCrmNormRoute).filter(Boolean))].slice(0,100):cur.routes;
  const enabled='enabled' in body?body.enabled:travelCrmOn(c);
  const trips='trips_enabled' in body?body.trips_enabled:travelCrmTripsOn(c);
  return {fields:{travel_crm_enabled:enabled?'Yes':'No', travel_trips_enabled:trips?'Yes':'No', travel_crm_config:JSON.stringify({enquiry_types:types.length?types:TCRM_DEFAULT_ENQUIRY_TYPES, routes:routes.length?routes:TCRM_DEFAULT_ROUTES})}};
}

/* ── Route & travel dates from the chat ───────────────────────────────────────────────────────────
   Each customer message is read for a route ("Calicut to Dubai", "dubai kochi ticket") and travel
   dates ("15 Dec", "15/12/2026", "Dec 15 to Dec 22"). What it finds goes on the lead as one
   auto-detected trip (auto:true) and the lead's route (TravelRouteBy 'auto'); a later message
   updates them. Once someone edits the trip or the route by hand it is theirs and is left alone —
   a new date the customer mentions then becomes a new auto trip. The parsers come from the worker
   (the same airport list and date reader the flight bot uses), so this stays pure. */
const DATE_CONTEXT=/\b(?:on|date|dates|travel|travelling|traveling|flight|flights|ticket|tickets|going|leaving|leave|depart|departure|return|returning|back|journey|trip|fly|flying|visit|reach|arrive|arriving|from|to|till|until)\b/i;
const NOT_TRAVEL_DATE=/\b(?:dob|d\.o\.b|date\s+of\s+birth|birth|born|birthday|passport|expiry|expires|expiring|valid\s+(?:till|until|upto)|issued?|issue\s+date|age)\b/i;
const MONTHS='jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const DATE_RE=new RegExp(`\\b20\\d{2}[-/.]\\d{1,2}[-/.]\\d{1,2}\\b|\\b\\d{1,2}[-/.]\\d{1,2}(?:[-/.]\\d{2,4})?\\b(?!\\s*(?:people|persons?|pax|adults?|kids?|child(?:ren)?|kg|kgs|nights?|days?|%))|\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+20\\d{2})?\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTHS})\\b\\.?(?:,?\\s+20\\d{2})?|\\btomorrow\\b`, 'gi');
// The travel dates in one message, in the order written (at most 2: going, and back). Only dates
// from today up to ~13 months ahead count — and a date written without a year that would only come
// round again in 11+ months ("we went on 5 Nov") is taken as past and skipped; birth / passport
// dates are ignored, and a bare "12/5" needs a travel word, a route in the message, or a route
// already on the enquiry.
export function travelCrmDatesFromText(text, parseDate, now=new Date(), {hasRoute=false}={}){
  const t=String(text||'');
  if(!t.trim() || NOT_TRAVEL_DATE.test(t)) return [];
  const today=now.toISOString().slice(0,10), max=new Date(now.getTime()+400*864e5).toISOString().slice(0,10);
  const noYearMax=new Date(now.getTime()+330*864e5).toISOString().slice(0,10);
  const out=[];
  for(const m of t.matchAll(DATE_RE)){
    const raw=m[0];
    let iso='';
    if(/^tomorrow$/i.test(raw)) iso=new Date(now.getTime()+864e5).toISOString().slice(0,10);
    else{
      if(/^\d{1,2}[-/.]\d{1,2}$/.test(raw) && !hasRoute && !DATE_CONTEXT.test(t)) continue;
      iso=String(parseDate(raw.replace(/\bof\s+/i,''), now)||'').slice(0,10);
    }
    if(!ISO.test(iso) || iso<today || iso>max || out.includes(iso)) continue;
    if(!/\b20\d{2}\b/.test(raw) && !/^tomorrow$/i.test(raw) && iso>noYearMax) continue;
    out.push(iso);
    if(out.length===2) break;
  }
  return out;
}
// One message → {route, depart, ret} (any of them may be missing), or null.
// `known`: the enquiry already has a route, so a bare "10/12" is read as a travel date.
export function travelCrmDetect(text, {routeOf, parseDate}, now=new Date(), {known=false}={}){
  const route=travelCrmNormRoute(routeOf(text)||'');
  const dates=travelCrmDatesFromText(text, parseDate, now, {hasRoute:!!route||known});
  if(!route && !dates.length) return null;
  const [a,b]=dates;
  const depart=a&&b?(a<b?a:b):(a||''), ret=a&&b?(a<b?b:a):'';
  return {...(route?{route}:{}), ...(depart?{depart}:{}), ...(ret?{ret}:{})};
}
const newId=(now)=>'a'+now.getTime().toString(36)+Math.random().toString(36).slice(2,5);
// What a detection changes on the lead → a Leads PATCH (without Id), or null when nothing changes.
export function travelCrmMergeDetection(lead, det, now=new Date()){
  if(!det || (!det.route && !det.depart)) return null;
  const today=now.toISOString().slice(0,10);
  const patch={};
  const curRoute=travelCrmNormRoute(lead?.TravelRoute);
  if(det.route && det.route!==curRoute && (!curRoute || String(lead?.TravelRouteBy||'')==='auto')){
    patch.TravelRoute=det.route; patch.TravelRouteBy='auto';
  }
  let trips=travelCrmParseTrips(lead?.TravelTrips);
  const stored=trips.length>0;
  if(!stored) trips=travelCrmLeadTrips(lead).map(t=>({...t, id:t.id==='legacy'?newId(now)+'l':t.id}));
  const auto=trips.find(t=>t.auto);
  let changed=false;
  if(auto){
    const next={...auto,
      route:det.route||auto.route||travelCrmNormRoute(patch.TravelRoute||curRoute),
      depart:det.depart||auto.depart,
      ret:det.depart?(det.ret||(det.depart===auto.depart?auto.ret:'')):(det.ret||auto.ret)};
    if(next.ret && next.ret<next.depart) next.ret='';
    if(JSON.stringify(next)!==JSON.stringify(auto)){ trips=trips.map(t=>t===auto?next:t); changed=true; }
  } else if(det.depart && !trips.some(t=>t.depart===det.depart)){
    trips.push({id:newId(now), route:det.route||travelCrmNormRoute(patch.TravelRoute||curRoute), depart:det.depart, ret:det.ret||'', note:'', auto:true});
    changed=true;
  }
  if(changed){
    patch.TravelTrips=JSON.stringify(trips.slice(-30));
    const probe={...lead, ...patch};
    patch.TripStatus=travelCrmLeadTripStatus(probe, today);
    patch.NextTravelDate=travelCrmNextDate(probe, today);
  }
  return Object.keys(patch).length?patch:null;
}
// A whole conversation (oldest first) → the PATCH for an existing lead ("🔎 Find in chat").
export function travelCrmDetectHistory(lead, messages, parsers, now=new Date()){
  let cur={...lead}, patch={};
  for(const m of messages||[]){
    if(m?.role!=='user' || typeof m.content!=='string') continue;
    const p=travelCrmMergeDetection(cur, travelCrmDetect(m.content, parsers, now, {known:!!travelCrmNormRoute(cur.TravelRoute)}), now);
    if(p){ cur={...cur, ...p}; patch={...patch, ...p}; }
  }
  return Object.keys(patch).length?patch:null;
}
