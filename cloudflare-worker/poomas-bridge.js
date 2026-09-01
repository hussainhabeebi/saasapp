const POOMAS_API='https://api.flypoomas.com';
const POOMAS_WEB='https://flypoomas.com';
const LEADVYNE_API='https://leadvyne-api-proxy.leadvyne.workers.dev';

function json(data,status=200,origin='*'){
  return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'Authorization, Content-Type, X-Leadvyne-Client','Access-Control-Allow-Methods':'GET, POST, PUT, OPTIONS','Vary':'Origin'}});
}
function corsOrigin(req,env){const origin=req.headers.get('Origin')||'*';const allowed=(env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);return !allowed.length||allowed.includes(origin)?origin:'null';}
function decodeLeadvynePayload(raw){
  try{
    const token=String(raw||'').replace(/^Bearer\s+/i,'').trim();
    const body=token.split('.')[0];
    if(!body)return null;
    const normalized=body.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(body.length/4)*4,'=');
    const text=decodeURIComponent(Array.from(atob(normalized)).map(c=>'%'+c.charCodeAt(0).toString(16).padStart(2,'0')).join(''));
    return JSON.parse(text);
  }catch{return null;}
}

// Authenticate with the exact same endpoint and headers used by Live Agency itself.
// Once bootstrap accepts the bearer token, the token payload is trusted only to obtain
// the already-signed client id; we do not perform a second, incompatible signature check.
async function auth(req){
  const raw=String(req.headers.get('Authorization')||'').trim();
  if(!raw)return null;
  try{
    const r=await fetch(`${LEADVYNE_API}/live-travel/bootstrap`,{headers:{Authorization:raw,'Content-Type':'application/json'}});
    if(!r.ok)return null;
    const payload=decodeLeadvynePayload(raw);
    const cid=Number(payload?.cid||payload?.client_id||payload?.clientId||0);
    if(!Number.isFinite(cid)||cid<=0)return null;
    return {clientId:cid};
  }catch{return null;}
}
async function ensureDb(env){await env.DB.prepare(`CREATE TABLE IF NOT EXISTS live_travel_poomas_settings (client_id INTEGER PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 0,api_base TEXT NOT NULL DEFAULT 'https://api.flypoomas.com',checkout_base TEXT NOT NULL DEFAULT 'https://flypoomas.com',created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`).run();}
async function setting(env,cid){await ensureDb(env);return await env.DB.prepare(`SELECT * FROM live_travel_poomas_settings WHERE client_id=?`).bind(cid).first();}
async function enabledSetting(env,cid){const s=await setting(env,cid);if(!s||!s.enabled)throw new Error('POOMAS API is not enabled for this client.');return s;}
function integrationHeaders(env){return {'Content-Type':'application/json','X-POOMAS-INTEGRATION-KEY':env.POOMAS_INTEGRATION_KEY||'','x-tenant-slug':'poomas','X-Channel':'LEADVYNE'};}
function normalizePoomasFare(f,s,clientId){
  const total=Number(f.displayPrice??f.totalFare??0);
  const isBook=Boolean(f.isBookable);
  const checkoutUrl=isBook?`${s.checkout_base||POOMAS_WEB}/book?fareId=${encodeURIComponent(f.id)}&supplier=${encodeURIComponent(f.supplier||'')}&source=leadvyne&client=${encodeURIComponent(clientId||'')}`:null;
  return {
    id:`poomas:${f.supplier}:${f.id}`,source:'poomas',supplier:'poomas',poomas_supplier:f.supplier,supplier_offer_id:f.id,
    bookable:isBook,holdable:isBook,
    airline_code:f.airline||'',airline_name:f.airlineName||f.airline||'Flight',flight_numbers:f.flightNumber||'',
    itinerary:[{origin:f.origin,destination:f.destination,departureTime:f.departureTime,arrivalTime:f.arrivalTime,duration:f.duration,stops:f.stops||0}],
    baggage:f.baggage||{},fare_rules:f.fareRules||{},
    cabin:String(f.cabinClass||'ECONOMY').toLowerCase(),seats_left:f.seatsLeft??null,
    currency:f.currency||'AED',base_amount:Number(f.baseFare||0),tax_amount:Number(f.taxes||0),
    markup_amount:Math.max(0,total-Number(f.totalFare||total)),total_amount:total,
    checkout_url:checkoutUrl,indicative:!isBook,
  };
}

export default {async fetch(req,env){
  const origin=corsOrigin(req,env);
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'Authorization, Content-Type, X-Leadvyne-Client','Access-Control-Allow-Methods':'GET, POST, PUT, OPTIONS'}});
  const u=new URL(req.url);
  if(u.pathname==='/health')return json({status:'ok',service:'leadvyne-poomas-bridge',auth:'live-travel-bootstrap-v2'},200,origin);
  const a=await auth(req);
  if(!a)return json({error:'Leadvyne Live Agency session validation failed'},401,origin);
  try{
    // GET /settings — return current POOMAS settings for this client
    if(u.pathname==='/settings'&&req.method==='GET'){
      const s=await setting(env,a.clientId);
      return json({enabled:Boolean(s?.enabled),api_base:s?.api_base||POOMAS_API,checkout_base:s?.checkout_base||POOMAS_WEB},200,origin);
    }
    // PUT /settings — update POOMAS settings
    if(u.pathname==='/settings'&&req.method==='PUT'){
      const b=await req.json().catch(()=>({})),now=new Date().toISOString(),apiBase=String(b.api_base||POOMAS_API).replace(/\/$/,''),checkoutBase=String(b.checkout_base||POOMAS_WEB).replace(/\/$/,'');
      if(!apiBase.startsWith('https://')||!checkoutBase.startsWith('https://'))return json({error:'POOMAS endpoints must use HTTPS'},400,origin);
      await ensureDb(env);
      const existing=await setting(env,a.clientId),enabled=b.enabled===undefined?Boolean(existing?.enabled):Boolean(b.enabled);
      await env.DB.prepare(`INSERT INTO live_travel_poomas_settings (client_id,enabled,api_base,checkout_base,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(client_id) DO UPDATE SET enabled=excluded.enabled,api_base=excluded.api_base,checkout_base=excluded.checkout_base,updated_at=excluded.updated_at`).bind(a.clientId,enabled?1:0,apiBase,checkoutBase,now,now).run();
      return json({ok:true,enabled,api_base:apiBase,checkout_base:checkoutBase},200,origin);
    }
    // POST /search — search flights via POOMAS v1 integration API
    if(u.pathname==='/search'&&req.method==='POST'){
      const s=await enabledSetting(env,a.clientId);
      if(!env.POOMAS_INTEGRATION_KEY)return json({error:'POOMAS integration key is not configured on Leadvyne'},503,origin);
      const b=await req.json().catch(()=>({}));
      const currency=['AED','INR','USD','SAR','EUR','GBP'].includes(String(b.currency||'').toUpperCase())?String(b.currency).toUpperCase():'AED';
      const payload={origin:String(b.origin||'').toUpperCase(),destination:String(b.destination||'').toUpperCase(),departureDate:b.departure_date||b.departureDate,adults:Number(b.adults||1),children:Number(b.children||0),infants:Number(b.infants||0),cabinClass:String(b.cabin||b.cabinClass||'economy').toUpperCase(),tripType:(b.trip_type||b.tripType)==='round_trip'?'ROUNDTRIP':'ONEWAY',currency};
      if(payload.tripType==='ROUNDTRIP')payload.returnDate=b.return_date||b.returnDate;
      const r=await fetch(`${s.api_base||POOMAS_API}/api/integrations/v1/flights/search`,{method:'POST',headers:integrationHeaders(env),body:JSON.stringify(payload)});
      const d=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(d.error||d.message||`POOMAS search failed (${r.status})`);
      return json({provider:'poomas',offers:(d.fares||d.data?.fares||[]).map(f=>normalizePoomasFare(f,s,a.clientId)),usedSuppliers:d.usedSuppliers||[],supplierErrors:d.supplierErrors||{}},200,origin);
    }
    // POST /checkout-session — exchange passenger PII for a short-lived opaque Poomas link
    if(u.pathname==='/checkout-session'&&req.method==='POST'){
      const s=await enabledSetting(env,a.clientId);
      if(!env.POOMAS_INTEGRATION_KEY)return json({error:'POOMAS integration key is not configured on Leadvyne'},503,origin);
      const b=await req.json().catch(()=>({}));
      const fareId=String(b.fare_id||b.fareId||'').trim();
      const supplier=String(b.poomas_supplier||b.supplier||'').trim().toUpperCase();
      const passengers=Array.isArray(b.passengers)?b.passengers:[];
      const contact=b.contact||{email:b.contact_email||b.email,mobile:b.contact_phone||b.mobile||b.phone};
      if(!fareId||!supplier)return json({error:'fareId and supplier are required'},400,origin);
      if(!passengers.length)return json({error:'At least one passenger is required'},400,origin);
      const r=await fetch(`${s.api_base||POOMAS_API}/api/integrations/checkout-sessions`,{method:'POST',headers:integrationHeaders(env),body:JSON.stringify({fareId,supplier,passengers,contact,source:'leadvyne',clientId:a.clientId})});
      const d=await r.json().catch(()=>({}));
      if(!r.ok)return json({error:d.error||d.message||`POOMAS checkout session failed (${r.status})`},r.status,origin);
      return json({provider:'poomas',...d},201,origin);
    }
    // POST /hold — hold a POOMAS fare
    if(u.pathname==='/hold'&&req.method==='POST'){
      const s=await enabledSetting(env,a.clientId);
      if(!env.POOMAS_INTEGRATION_KEY)return json({error:'POOMAS integration key is not configured on Leadvyne'},503,origin);
      const b=await req.json().catch(()=>({}));
      const fareId=String(b.fare_id||b.fareId||'').trim();
      if(!fareId)return json({error:'fare_id is required'},400,origin);
      const payload={fareId,supplier:String(b.poomas_supplier||b.supplier||''),passengers:b.passengers||[]};
      const r=await fetch(`${s.api_base||POOMAS_API}/api/integrations/v1/flights/hold`,{method:'POST',headers:integrationHeaders(env),body:JSON.stringify(payload)});
      const d=await r.json().catch(()=>({}));
      if(!r.ok)return json({error:d.error||d.message||`POOMAS hold failed (${r.status})`},r.status,origin);
      return json({provider:'poomas',hold_id:d.holdId||d.hold_id||d.id,hold_expires_at:d.expiresAt||d.holdExpiry||d.hold_expires_at,...d},200,origin);
    }
    // GET /booking/:id — fetch a POOMAS booking by ID
    if(u.pathname.startsWith('/booking/')&&req.method==='GET'){
      await enabledSetting(env,a.clientId);
      if(!env.POOMAS_INTEGRATION_KEY)return json({error:'POOMAS integration key is not configured on Leadvyne'},503,origin);
      const bookingId=u.pathname.slice('/booking/'.length).split('/')[0];
      if(!bookingId)return json({error:'booking ID is required'},400,origin);
      const r=await fetch(`${POOMAS_API}/api/integrations/v1/bookings/${encodeURIComponent(bookingId)}`,{headers:integrationHeaders(env)});
      const d=await r.json().catch(()=>({}));
      if(!r.ok)return json({error:d.error||d.message||`POOMAS booking lookup failed (${r.status})`},r.status,origin);
      return json({provider:'poomas',...d},200,origin);
    }
    // POST /pnr — look up a booking by PNR
    if(u.pathname==='/pnr'&&req.method==='POST'){
      await enabledSetting(env,a.clientId);
      const b=await req.json().catch(()=>({})),pnr=String(b.pnr||'').trim().toUpperCase();
      if(!pnr)return json({error:'PNR is required'},400,origin);
      if(!env.POOMAS_INTEGRATION_KEY)return json({error:'POOMAS integration key is not configured on Leadvyne'},503,origin);
      const r=await fetch(`${POOMAS_API}/api/integrations/pnr/${encodeURIComponent(pnr)}`,{headers:integrationHeaders(env)});
      const d=await r.json().catch(()=>({}));
      if(!r.ok)return json({error:d.error||d.message||`POOMAS PNR lookup failed (${r.status})`},r.status,origin);
      return json({provider:'poomas',...d},200,origin);
    }
    return json({error:'Not found'},404,origin);
  }catch(e){return json({error:e instanceof Error?e.message:String(e)},502,origin);}
}};
