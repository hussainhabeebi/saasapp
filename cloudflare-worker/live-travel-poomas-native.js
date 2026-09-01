const POOMAS_API='https://api.flypoomas.com';
const POOMAS_WEB='https://flypoomas.com';

function json(data,status=200,origin='*'){
  return new Response(JSON.stringify(data),{status,headers:{
    'Content-Type':'application/json',
    'Access-Control-Allow-Origin':origin,
    'Access-Control-Allow-Headers':'Authorization, Content-Type',
    'Access-Control-Allow-Methods':'GET, POST, PUT, OPTIONS',
    'Vary':'Origin'
  }});
}

function allowedOrigin(req,env){
  const origin=req.headers.get('Origin')||'*';
  const allowed=String(env.ALLOWED_ORIGINS||'').split(',').map(v=>v.trim()).filter(Boolean);
  return !allowed.length||allowed.includes(origin)?origin:'null';
}

function decodeSessionClient(req){
  try{
    const raw=String(req.headers.get('Authorization')||'').replace(/^Bearer\s+/i,'').trim();
    const body=raw.split('.')[0];
    if(!body)return 0;
    const normalized=body.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(body.length/4)*4,'=');
    const payload=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(normalized),c=>c.charCodeAt(0))));
    const cid=Number(payload.cid||payload.client_id||payload.clientId||0);
    return Number.isFinite(cid)&&cid>0?cid:0;
  }catch{return 0;}
}

async function authenticate(req,env,ctx,legacy){
  const authReq=new Request(new URL('/live-travel/bootstrap',req.url),{
    method:'GET',
    headers:req.headers
  });
  const validation=await legacy.fetch(authReq,env,ctx);
  if(!validation.ok)return null;
  const clientId=decodeSessionClient(req);
  if(!clientId)return null;
  return {clientId};
}

async function ensureDb(env){
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS live_travel_poomas_settings (
    client_id INTEGER PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    api_base TEXT NOT NULL DEFAULT 'https://api.flypoomas.com',
    checkout_base TEXT NOT NULL DEFAULT 'https://flypoomas.com',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`).run();
}

async function setting(env,cid){
  await ensureDb(env);
  return env.DB.prepare('SELECT * FROM live_travel_poomas_settings WHERE client_id=?').bind(cid).first();
}

async function enabledSetting(env,cid){
  const row=await setting(env,cid);
  if(!row||!row.enabled)throw new Error('POOMAS API is not enabled for this client.');
  return row;
}

function normalizePoomasFare(f,s,cid){
  const total=Number(f.displayPrice??f.totalFare??0);
  const supplier=String(f.supplier||'').toUpperCase();
  const bookable=Boolean(f.isBookable&&supplier==='DUFFEL');
  return {
    id:`poomas:${supplier}:${f.id}`,
    source:'poomas',
    supplier:'poomas',
    poomas_supplier:supplier,
    supplier_offer_id:f.id,
    bookable,
    airline_code:f.airline||'',
    airline_name:f.airlineName||f.airline||'Flight',
    flight_numbers:f.flightNumber||'',
    itinerary:[{origin:f.origin,destination:f.destination,departureTime:f.departureTime,arrivalTime:f.arrivalTime,duration:f.duration,stops:f.stops}],
    baggage:f.baggage||{},
    fare_rules:f.fareRules||{},
    cabin:String(f.cabinClass||'ECONOMY').toLowerCase(),
    seats_left:f.seatsLeft??null,
    currency:f.currency||'AED',
    base_amount:Number(f.baseFare||0),
    tax_amount:Number(f.taxes||0),
    markup_amount:Math.max(0,total-Number(f.totalFare||total)),
    total_amount:total,
    checkout_url:bookable?`${s.checkout_base||POOMAS_WEB}/book?fareId=${encodeURIComponent(f.id)}&supplier=DUFFEL&source=leadvyne&client=${encodeURIComponent(cid)}`:null,
    indicative:!bookable
  };
}

export async function handleNativePoomas(req,env,ctx,legacy){
  const origin=allowedOrigin(req,env);
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:{
    'Access-Control-Allow-Origin':origin,
    'Access-Control-Allow-Headers':'Authorization, Content-Type',
    'Access-Control-Allow-Methods':'GET, POST, PUT, PATCH, DELETE, OPTIONS'
  }});

  const auth=await authenticate(req,env,ctx,legacy);
  if(!auth)return json({error:'Invalid or expired Leadvyne session'},401,origin);
  const path=new URL(req.url).pathname;

  try{
    if(path==='/live-travel/poomas/settings'&&req.method==='GET'){
      const row=await setting(env,auth.clientId);
      return json({enabled:Boolean(row?.enabled),api_base:row?.api_base||POOMAS_API,checkout_base:row?.checkout_base||POOMAS_WEB},200,origin);
    }

    if(path==='/live-travel/poomas/settings'&&(req.method==='PUT'||req.method==='PATCH')){
      const body=await req.json().catch(()=>({}));
      const existing=await setting(env,auth.clientId);
      const enabled=body.enabled===undefined?Boolean(existing?.enabled):Boolean(body.enabled);
      const apiBase=String(body.api_base||POOMAS_API).replace(/\/$/,'');
      const checkoutBase=String(body.checkout_base||POOMAS_WEB).replace(/\/$/,'');
      if(!apiBase.startsWith('https://')||!checkoutBase.startsWith('https://'))return json({error:'POOMAS endpoints must use HTTPS'},400,origin);
      const now=new Date().toISOString();
      await ensureDb(env);
      await env.DB.prepare(`INSERT INTO live_travel_poomas_settings (client_id,enabled,api_base,checkout_base,created_at,updated_at)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(client_id) DO UPDATE SET enabled=excluded.enabled,api_base=excluded.api_base,checkout_base=excluded.checkout_base,updated_at=excluded.updated_at`)
        .bind(auth.clientId,enabled?1:0,apiBase,checkoutBase,now,now).run();
      return json({ok:true,enabled,api_base:apiBase,checkout_base:checkoutBase},200,origin);
    }

    if(path==='/live-travel/poomas/search'&&req.method==='POST'){
      const s=await enabledSetting(env,auth.clientId);
      const b=await req.json().catch(()=>({}));
      const requestedCurrency=String(b.currency||'AED').toUpperCase();
      const currency=['AED','INR','USD','SAR','EUR','GBP'].includes(requestedCurrency)?requestedCurrency:'AED';
      const payload={
        origin:String(b.origin||'').toUpperCase(),
        destination:String(b.destination||'').toUpperCase(),
        departureDate:b.departure_date||b.departureDate,
        adults:Number(b.adults||1),
        children:Number(b.children||0),
        infants:Number(b.infants||0),
        cabinClass:String(b.cabin||b.cabinClass||'economy').toUpperCase(),
        tripType:(b.trip_type||b.tripType)==='round_trip'?'ROUNDTRIP':'ONEWAY',
        currency
      };
      if(payload.tripType==='ROUNDTRIP')payload.returnDate=b.return_date||b.returnDate;
      if(!(env.POOMAS_API_KEY||env.POOMAS_INTEGRATION_KEY))return json({error:'POOMAS_API_KEY is not configured on leadvyne-api-proxy'},503,origin);
      const response=await fetch(`${s.api_base||POOMAS_API}/api/search`,{
        method:'POST',
        headers:{'Content-Type':'application/json','X-API-Key':env.POOMAS_API_KEY||env.POOMAS_INTEGRATION_KEY||'','x-tenant-slug':'poomas','X-Channel':'LEADVYNE'},
        body:JSON.stringify(payload)
      });
      const result=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(result.error||`POOMAS search failed (${response.status})`);
      return json({provider:'poomas',offers:(result.fares||[]).map(f=>normalizePoomasFare(f,s,auth.clientId)),usedSuppliers:result.usedSuppliers||[],supplierErrors:result.supplierErrors||{}},200,origin);
    }

    if(path==='/live-travel/poomas/checkout-session'&&req.method==='POST'){
      const s=await enabledSetting(env,auth.clientId);
      if(!env.POOMAS_INTEGRATION_KEY)return json({error:'POOMAS_INTEGRATION_KEY is not configured on leadvyne-api-proxy'},503,origin);
      const b=await req.json().catch(()=>({}));
      const fareId=String(b.fare_id||b.fareId||'').trim();
      const supplier=String(b.poomas_supplier||b.supplier||'').trim().toUpperCase();
      const passengers=Array.isArray(b.passengers)?b.passengers:[];
      const contact=b.contact||{email:b.contact_email||b.email,mobile:b.contact_phone||b.mobile||b.phone};
      if(!fareId||!supplier)return json({error:'fareId and supplier are required'},400,origin);
      if(!passengers.length)return json({error:'At least one passenger is required'},400,origin);
      const response=await fetch(`${s.api_base||POOMAS_API}/api/integrations/checkout-sessions`,{
        method:'POST',
        headers:{'Content-Type':'application/json','X-POOMAS-INTEGRATION-KEY':env.POOMAS_INTEGRATION_KEY,'x-tenant-slug':'poomas','X-Channel':'LEADVYNE'},
        body:JSON.stringify({fareId,supplier,passengers,contact,source:'leadvyne',clientId:auth.clientId})
      });
      const result=await response.json().catch(()=>({}));
      if(!response.ok)return json({error:result.error||result.message||`POOMAS checkout session failed (${response.status})`},response.status,origin);
      return json({provider:'poomas',...result},201,origin);
    }

    if(path==='/live-travel/poomas/pnr'&&req.method==='POST'){
      const s=await enabledSetting(env,auth.clientId);
      const body=await req.json().catch(()=>({}));
      const pnr=String(body.pnr||'').trim().toUpperCase();
      if(!pnr)return json({error:'PNR is required'},400,origin);
      if(!env.POOMAS_INTEGRATION_KEY)return json({error:'POOMAS_INTEGRATION_KEY is not configured on leadvyne-api-proxy'},503,origin);
      const response=await fetch(`${s.api_base||POOMAS_API}/api/integrations/pnr/${encodeURIComponent(pnr)}`,{
        headers:{'X-POOMAS-INTEGRATION-KEY':env.POOMAS_INTEGRATION_KEY,'x-tenant-slug':'poomas'}
      });
      const result=await response.json().catch(()=>({}));
      if(!response.ok)return json({error:result.error||`POOMAS PNR lookup failed (${response.status})`},response.status,origin);
      return json({provider:'poomas',...result},200,origin);
    }

    return json({error:'Not found'},404,origin);
  }catch(error){
    return json({error:error instanceof Error?error.message:String(error)},502,origin);
  }
}
