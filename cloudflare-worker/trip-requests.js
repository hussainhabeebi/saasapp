/* ── Trip requests: bot travel details → Trips (Travel Agency → ta_bookings) ─────────────────────
   When a WhatsApp booking bot (Flyindo chat style or a Travel Settings → 🧩 Flow) has collected
   enough about a trip, the details land on Trips as a draft trip with status `requested`, linked to
   the lead, so the sales team works them from one pipeline instead of retyping the chat. Nothing
   changes for the customer: the bot's messages are the same, this only files what it collected.

   Pure helpers live here (and are unit tested); the worker does the NocoDB reads and writes
   (tripRequestSync in worker.js).

   Pipeline (the `status` column; quoted / confirmed / completed / cancelled are the values Trips
   always had, so older rows keep working):
     requested → contacted → quoted → advance_paid → confirmed → completed (travelled) | cancelled (lost)
── */

export const TRIP_STATUSES=[
  {key:'requested',label:'New request'},
  {key:'contacted',label:'Contacted'},
  {key:'quoted',label:'Quoted'},
  {key:'advance_paid',label:'Advance paid'},
  {key:'confirmed',label:'Confirmed'},
  {key:'completed',label:'Travelled'},
  {key:'cancelled',label:'Lost / Cancelled'},
];
// Before a quote: the bot may still update these from the chat.
export const TRIP_PRE_QUOTE=['requested','contacted'];
export const TRIP_CLOSED=['completed','cancelled'];
export const TRIP_SOURCE_BOT='whatsapp_bot';

// Columns Trips gains for requests (added on first use, both by the worker and by the dashboard).
// adults/children stay text: the bot offers "10 or more" as 10+.
export const TRIP_REQUEST_COLUMNS=[
  {title:'lead_id'},{title:'source'},{title:'destination'},{title:'travel_month'},
  {title:'adults'},{title:'children'},{title:'children_ages'},{title:'departure_city'},
  {title:'assigned_to'},{title:'requested_at'},{title:'status_changed_at'},
  {title:'missing_info'},{title:'lost_reason'},{title:'duplicate_of'},{title:'created_at'},
];

const str=v=>v==null?'':String(v).trim();
const ISO_DAY=/^\d{4}-\d{2}-\d{2}$/, ISO_MONTH=/^\d{4}-\d{2}$/;

// The travel details in a lead's qualification answers — the same keys both bots write
// (flyindoQualAnswers / tfQualAnswers): destination, package, travel_date, travel_month, adults,
// children, children_ages, infants, departure_city.
export function tripRequestFields(qual){
  const q=qual&&typeof qual==='object'?qual:{};
  const date=str(q.travel_date);
  const month=str(q.travel_month);
  return {
    destination:str(q.destination)||str(q.package),
    package:str(q.package),
    travel_date:ISO_DAY.test(date)?date:'',
    travel_month:ISO_DAY.test(date)?date.slice(0,7):ISO_MONTH.test(month)?month:'',
    adults:str(q.adults),
    children:str(q.children),
    children_ages:str(q.children_ages),
    infants:str(q.infants),
    departure_city:str(q.departure_city),
  };
}

// Enough to be worth a sales call: where, plus one of when / how many.
export function tripRequestEligible(f){
  return !!(f&&f.destination&&(f.travel_date||f.travel_month||f.adults));
}

// What the consultant still has to ask for.
export function tripRequestMissing(f){
  const out=[];
  if(!f.travel_date) out.push(f.travel_month?'exact date':'travel date');
  if(!f.adults) out.push('travellers');
  return out;
}

export function tripPax(f){
  const n=v=>{ const x=parseInt(String(v||'').replace(/\D/g,''),10); return Number.isFinite(x)?x:0; };
  return n(f.adults)+n(f.children)+n(f.infants);
}

const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export function tripDateLabel(f){
  if(f.travel_date){ const [y,m,d]=f.travel_date.split('-'); return `${Number(d)} ${MONTHS[Number(m)-1]} ${y}`; }
  if(f.travel_month){ const [y,m]=f.travel_month.split('-'); return `${MONTHS[Number(m)-1]} ${y}`; }
  return '';
}
// "5A + 2C" — the short traveller count shown on cards and alerts.
export function tripPaxLabel(f){
  if(!f.adults) return '';
  const c=parseInt(f.children,10)||0, i=parseInt(f.infants,10)||0;
  return `${f.adults}A${c?` + ${c}C`:''}${i?` + ${i}I`:''}`;
}
// "Kashmir · 29 Apr 2027 · 5A" — one line for the agent alert.
export function tripSummaryLine(f){
  return [f.destination,tripDateLabel(f),tripPaxLabel(f)].filter(Boolean).join(' · ');
}

// The Trips row a request becomes (create), or the bot-owned fields of it (update).
export function tripRequestRecord(f,{name='',phone='',leadId='',owner='',currency='',now=new Date()}={}){
  const iso=now.toISOString();
  const missing=tripRequestMissing(f);
  const rec={
    client_name:str(name)||(phone?'+'+String(phone).replace(/\D/g,''):'WhatsApp customer'),
    client_phone:str(phone),
    package_name:f.package||f.destination,
    destination:f.destination,
    travel_month:f.travel_month,
    adults:f.adults,
    children:f.children||(f.adults?'0':''),
    children_ages:f.children_ages,
    departure_city:f.departure_city,
    pax:tripPax(f)||1,
    status:'requested',
    source:TRIP_SOURCE_BOT,
    lead_id:str(leadId),
    assigned_to:str(owner).toLowerCase(),
    requested_at:iso,
    status_changed_at:iso,
    missing_info:missing.join(', '),
    created_at:iso.slice(0,10),
  };
  if(f.travel_date) rec.departure_date=f.travel_date;
  if(currency) rec.currency=currency;
  return rec;
}

// The fields the bot keeps up to date while a trip is still before its quote.
const BOT_FIELDS=[
  ['destination','Destination'],['package_name','Package'],['departure_date','Travel date'],
  ['travel_month','Travel month'],['adults','Adults'],['children','Children'],
  ['children_ages',"Children's ages"],['departure_city','Departure city'],['pax','Pax'],
  ['missing_info','Missing'],
];
const same=(a,b)=>str(a).slice(0,10)===str(b).slice(0,10)||(str(a)===''&&str(b)==='');
// {patch, changes}: the fields to write, and "Adults: 5 → 6" lines for what the customer changed
// (a value filled in for the first time is not a change).
export function tripRequestDiff(existing,rec){
  const patch={}, changes=[];
  for(const [k,label] of BOT_FIELDS){
    if(!(k in rec)&&k!=='departure_date') continue;
    const was=existing?.[k], now=rec[k]??'';
    if(same(was,now)) continue;
    if(k==='departure_date'&&!now) continue; // never blank a date someone entered
    patch[k]=now;
    if(str(was)&&k!=='missing_info'&&k!=='pax') changes.push(`${label}: ${str(was).slice(0,10)} → ${str(now)||'—'}`);
  }
  return {patch,changes};
}

const digits=p=>String(p||'').replace(/\D/g,'');
export function samePhone(a,b){
  const x=digits(a), y=digits(b);
  if(x.length<7||y.length<7) return false;
  return x.slice(-9)===y.slice(-9);
}
const normDest=v=>str(v).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
export function sameDestination(a,b){
  const x=normDest(a), y=normDest(b);
  return !!x&&!!y&&(x===y||x.includes(y)||y.includes(x));
}

/* What to do with a request given this customer's existing trips (any order):
     {action:'update', trip}    this lead's own open trip to the same place, still before its quote
     {action:'note', trip}      this lead's own open trip to the same place, already quoted or later:
                                sales owns its values now, only a note is added
     {action:'create', duplicateOf}  a new trip; duplicateOf = the Id of another open trip for the
                                same phone and destination (made by hand, or from another lead) */
export function tripRequestPlan(trips,{leadId,phone,destination}){
  const open=(trips||[]).filter(t=>t&&!TRIP_CLOSED.includes(str(t.status)||'quoted'));
  const lid=str(leadId);
  const own=open.find(t=>lid&&str(t.lead_id)===lid&&sameDestination(t.destination||t.package_name,destination));
  if(own) return {action:TRIP_PRE_QUOTE.includes(str(own.status))?'update':'note',trip:own};
  // A request from this lead to a new place is its own trip; it is not a duplicate of the lead's own.
  const dup=open.find(t=>str(t.lead_id)!==lid&&samePhone(t.client_phone,phone)&&sameDestination(t.destination||t.package_name,destination));
  return {action:'create',duplicateOf:dup?str(dup.Id):''};
}

// The owner a destination is routed to: Settings → Lead routing, "Product" rules, whose product
// list can hold destinations ("Kashmir", "Dubai"). '' when none matches.
export function tripRouteOwner(routing,destination,isStaff=()=>true){
  const r=routing&&typeof routing==='object'?routing:{};
  if(!r.enabled||!(r.modes||[]).includes('product')||!destination) return '';
  for(const [email,rule] of Object.entries(r.rules||{})){
    const e=str(email).toLowerCase();
    if(!isStaff(e)) continue;
    if([...(rule?.products||[]),...(rule?.destinations||[])].some(p=>sameDestination(p,destination)&&normDest(p).length>=3)) return e;
  }
  return '';
}

// Lead fields the Inquiries page and Today read (Destination / TravelDates / PaxCount).
export function tripLeadFields(f){
  const out={};
  if(f.destination) out.Destination=f.destination;
  if(f.travel_date) out.TravelDates=f.travel_date;
  else if(f.travel_month) out.TravelDates=f.travel_month;
  const pax=tripPax(f);
  if(pax) out.PaxCount=String(pax);
  return out;
}

// The note line appended to a trip.
export function tripNoteLine(text,now=new Date()){
  return `[${now.toISOString().slice(0,16).replace('T',' ')} · bot] ${text}`;
}
