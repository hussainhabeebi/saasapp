/* ═══════════════════════════════════════════════════════════════════════════
   LIVE TRAVEL — CURRENCY & EXCHANGE RATES
   Every agency picks a default currency (Live Agency → Currency). Supplier fares
   arrive in the supplier's own currency (Riya/TripJack usually INR, POOMAS AED)
   and are converted to that default before markup, rounding and sorting, so all
   offers in one search are comparable and a fixed markup means the same money
   for every supplier.

   Rates are USD-based. Live rates come from Open Exchange Rates when
   FX_API_KEY is set, otherwise from ExchangeRate-API's keyless open endpoint.
   Every Live Agency client uses ONE platform-wide snapshot (live_travel_fx_rates),
   refreshed by one provider call per 6-hour slot, max 4 per UTC day for all
   clients together — see "Rate storage".
   If the provider is down the last snapshot keeps being used, and if none was
   ever stored the USD pegs below still cover the Gulf currencies. A non-pegged
   currency (INR, KWD, EUR, GBP) with no stored rate is never guessed: the offer
   stays in its supplier currency and is flagged fx_status:'unconverted'.
   ═══════════════════════════════════════════════════════════════════════════ */

export const LT_FX_CURRENCIES={
  INR:{name:'Indian Rupee',decimals:2,rounding:'up_1'},
  AED:{name:'UAE Dirham',decimals:2,rounding:'up_1'},
  SAR:{name:'Saudi Riyal',decimals:2,rounding:'up_1'},
  QAR:{name:'Qatari Riyal',decimals:2,rounding:'up_1'},
  OMR:{name:'Omani Rial',decimals:3,rounding:'none'},
  KWD:{name:'Kuwaiti Dinar',decimals:3,rounding:'none'},
  BHD:{name:'Bahraini Dinar',decimals:3,rounding:'none'},
  USD:{name:'US Dollar',decimals:2,rounding:'none'},
  EUR:{name:'Euro',decimals:2,rounding:'none'},
  GBP:{name:'British Pound',decimals:2,rounding:'none'},
};
export const LT_FX_CODES=Object.keys(LT_FX_CURRENCIES);
export const LT_FX_ROUNDING_MODES=['auto','none','up_1','up_5','up_10'];
// Currencies hard-pegged to USD — safe to use when no live rate was ever stored.
export const LT_FX_USD_PEGS={USD:1,AED:3.6725,SAR:3.75,QAR:3.64,OMR:0.3845,BHD:0.376};
export const LT_FX_MAX_REFRESHES_PER_DAY=4;
export const LT_FX_SLOT_HOURS=24/LT_FX_MAX_REFRESHES_PER_DAY;
// Rates older than two missed slots are flagged stale in the UI (they are still used).
export const LT_FX_STALE_MS=12*60*60*1000;
export const LT_FX_DEFAULT_SETTINGS={default_currency:'AED',fx_buffer_pct:1.5,rounding:'auto',allow_currency_override:1,auto_detect_phone_currency:1};

// Longest prefix first so +1 never shadows anything longer.
const LT_FX_PHONE_PREFIXES=[['971','AED'],['966','SAR'],['974','QAR'],['968','OMR'],['965','KWD'],['973','BHD'],['91','INR'],['44','GBP'],['1','USD']];

let _tableReady=false;

export function ltFxCode(value){
  const code=String(value||'').trim().toUpperCase();
  return LT_FX_CURRENCIES[code]?code:'';
}
export function ltFxDecimals(currency){ return LT_FX_CURRENCIES[ltFxCode(currency)]?.decimals??2; }

export function ltFxNormalizeSettings(row){
  const s={...LT_FX_DEFAULT_SETTINGS,...(row||{})};
  const buffer=Number(s.fx_buffer_pct);
  return {
    default_currency:ltFxCode(s.default_currency)||'AED',
    fx_buffer_pct:Number.isFinite(buffer)?Math.min(10,Math.max(0,Math.round(buffer*100)/100)):LT_FX_DEFAULT_SETTINGS.fx_buffer_pct,
    rounding:LT_FX_ROUNDING_MODES.includes(s.rounding)?s.rounding:'auto',
    allow_currency_override:s.allow_currency_override===false||Number(s.allow_currency_override)===0?0:1,
    auto_detect_phone_currency:s.auto_detect_phone_currency===false||Number(s.auto_detect_phone_currency)===0?0:1,
  };
}

// Rate to multiply an amount in `from` by to get `to`. Null when either side is unknown.
export function ltFxRate(from,to,rates){
  const f=ltFxCode(from)||String(from||'').toUpperCase(),t=ltFxCode(to)||String(to||'').toUpperCase();
  if(!f||!t)return null;
  if(f===t)return 1;
  const rf=Number(rates?.[f]),rt=Number(rates?.[t]);
  return rf>0&&rt>0?rt/rf:null;
}

export function ltFxRound(amount,currency,mode='auto'){
  const n=Number(amount);
  if(!Number.isFinite(n))return 0;
  const decimals=ltFxDecimals(currency),scale=10**decimals;
  const effective=mode==='auto'?(LT_FX_CURRENCIES[ltFxCode(currency)]?.rounding||'none'):mode;
  const step={up_1:1,up_5:5,up_10:10}[effective];
  // Strip float noise (e.g. 1050.0000000001) before rounding up so exact values stay put.
  const clean=Math.round(n*scale)/scale;
  return step?Math.ceil(clean/step-1e-9)*step:clean;
}

export function ltFxFormat(amount,currency){
  const code=String(currency||'').toUpperCase(),n=Number(amount||0);
  const decimals=Number.isInteger(n)&&LT_FX_CURRENCIES[code]?.rounding==='up_1'?0:ltFxDecimals(code);
  return `${code} ${n.toLocaleString('en-US',{minimumFractionDigits:decimals,maximumFractionDigits:decimals})}`.trim();
}

export function ltFxCurrencyFromPhone(phone){
  const digits=String(phone||'').replace(/\D/g,'').replace(/^00/,'');
  if(digits.length<8)return '';
  for(const [prefix,code] of LT_FX_PHONE_PREFIXES)if(digits.startsWith(prefix))return code;
  return '';
}

// Explicit currency a customer wrote ("in INR", "rupees", "₹", "qatari riyal"). Bare
// "riyal"/"dinar" are ambiguous across Gulf states, so they are ignored.
export function ltFxCurrencyFromText(text){
  const t=String(text||'');
  const code=t.match(new RegExp(`\\b(${LT_FX_CODES.join('|')})\\b`,'i'));
  if(code)return code[1].toUpperCase();
  const words=[[/₹|\brupees?\b/i,'INR'],[/\bdirhams?\b/i,'AED'],[/\bsaudi\s+riyals?\b/i,'SAR'],[/\bqatari?\s+riyals?\b/i,'QAR'],[/\bomani\s+rials?\b/i,'OMR'],[/\bkuwaiti\s+dinars?\b/i,'KWD'],[/\bbahraini\s+dinars?\b/i,'BHD'],[/\bdollars?\b|\$/i,'USD'],[/€|\beuros?\b/i,'EUR'],[/£|\bpounds?\b/i,'GBP']];
  for(const [pattern,c] of words)if(pattern.test(t))return c;
  return '';
}

/* Converts a normalized offer (amounts in supplier currency) into ctx.fx.target.
   ctx.fx = {target, rates, buffer_pct, rounding, fetched_at, source}
   ctx.markup_type/markup_value are applied AFTER conversion, in the target currency. */
export function ltFxApplyToOffer(offer,ctx={}){
  const fx=ctx.fx;
  const supplierCurrency=String(offer.currency||'').toUpperCase();
  // What the supplier itself charges, in its own currency — excludes our markup.
  const supplierTotal=Math.round((Number(offer.total_amount||0)-Number(offer.markup_amount||0))*1000)/1000;
  const out={...offer,supplier_currency:supplierCurrency,supplier_total:supplierTotal,fx_rate:1,fx_rate_at:null,fx_source:'',fx_status:'native'};
  if(!fx?.target||!supplierCurrency||supplierCurrency===fx.target){
    if(fx?.target&&supplierCurrency===fx.target&&fx.rounding)out.total_amount=ltFxApplyRounding(out,fx.target,fx.rounding);
    return out;
  }
  const base=ltFxRate(supplierCurrency,fx.target,fx.rates);
  if(!base){out.fx_status='unconverted';return out;}
  const rate=base*(1+Math.max(0,Number(fx.buffer_pct||0))/100);
  const conv=v=>Math.round(Number(v||0)*rate*1000)/1000;
  // Markup is re-applied in the target currency, on the converted supplier price.
  const price=conv(supplierTotal);
  const markup=ltFxMarkup(price,ctx.markup_type,ctx.markup_value);
  Object.assign(out,{
    currency:fx.target,
    base_amount:conv(offer.base_amount),
    tax_amount:conv(offer.tax_amount),
    markup_amount:markup,
    total_amount:price+markup,
    fx_rate:Math.round(rate*1e8)/1e8,
    fx_rate_at:fx.fetched_at||null,
    fx_source:fx.source||'',
    fx_status:'converted',
  });
  out.total_amount=ltFxApplyRounding(out,fx.target,fx.rounding);
  return out;
}
function ltFxMarkup(price,type,value){
  const v=Math.max(0,Number(value)||0);
  return type==='percent'?Math.round(price*v)/100:v;
}
// Rounds the total and folds the rounding difference into markup so base+tax+markup stays = total.
function ltFxApplyRounding(offer,currency,mode){
  const raw=Number(offer.total_amount||0),rounded=ltFxRound(raw,currency,mode||'auto');
  const scale=10**ltFxDecimals(currency),r=v=>Math.round(v*scale)/scale;
  const base=Number(offer.base_amount||0),tax=Number(offer.tax_amount||0),markup=Number(offer.markup_amount||0);
  // Whatever part of the total the supplier didn't break down (often 0) is preserved as-is.
  const other=raw-(base+tax+markup);
  offer.base_amount=r(base);
  offer.tax_amount=r(tax);
  offer.markup_amount=r(rounded-offer.base_amount-offer.tax_amount-other);
  return rounded;
}

// How far the market rate has moved against the agency since `lockedRate` (which already
// includes the buffer). Positive = the supplier fare now costs more in agency currency.
export function ltFxDriftPct(lockedRate,from,to,rates,bufferPct=0){
  const now=ltFxRate(from,to,rates),locked=Number(lockedRate);
  if(!now||!(locked>0))return 0;
  const lockedMarket=locked/(1+Math.max(0,Number(bufferPct)||0)/100);
  return Math.round(((now-lockedMarket)/lockedMarket)*10000)/100;
}

/* ── Rate storage ──
   ONE platform-wide snapshot (row base='USD' in live_travel_fx_rates — no client_id) is the only
   source of rates for every Live Agency client and every path: search, revalidate, quotes,
   booking drift check, payments, wallet, WhatsApp and the Currency page. There is deliberately no
   per-isolate memory cache, so no Worker instance can ever price with a different rate.

   No API wastage: the rate provider is called at most LT_FX_MAX_REFRESHES_PER_DAY (4) times per
   UTC day for the whole platform, and at most once per 6-hour UTC slot (00:00, 06:00, 12:00,
   18:00). Every call counts, successful or not, and a failed slot is not retried until the
   next slot (the last snapshot stays in use meanwhile). The slot, the daily count and a
   60-second lock are claimed atomically in D1 before the call, so concurrent isolates can't
   double-call. Agencies cannot trigger a refresh. Reads never call the provider, except to seed
   a brand-new deployment, and that goes through the same slot claim. */
async function ltFxEnsureTable(env){
  if(_tableReady)return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS live_travel_fx_rates (base TEXT PRIMARY KEY,rates_json TEXT NOT NULL,source TEXT NOT NULL DEFAULT '',fetched_at TEXT NOT NULL)`).run();
  // Refresh bookkeeping added after 0108 shipped — ignore "duplicate column" on later runs.
  for(const col of [`refresh_day TEXT NOT NULL DEFAULT ''`,`refresh_count INTEGER NOT NULL DEFAULT 0`,`refreshing_until TEXT`,`last_attempt_at TEXT`]){
    try{await env.DB.prepare(`ALTER TABLE live_travel_fx_rates ADD COLUMN ${col}`).run();}catch(e){}
  }
  _tableReady=true;
}
function ltFxPegFallback(){
  return {base:'USD',rates:{...LT_FX_USD_PEGS},source:'usd_peg_fallback',fetched_at:null,stale:true,refreshes_today:0};
}
async function ltFxFetchLive(env,fetchImpl=fetch){
  const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),8000);
  try{
    if(env?.FX_API_KEY){
      const r=await fetchImpl(`https://openexchangerates.org/api/latest.json?app_id=${encodeURIComponent(env.FX_API_KEY)}&base=USD`,{signal:ctl.signal});
      const d=await r.json().catch(()=>({}));
      if(!r.ok||!d?.rates)throw new Error(d?.description||`Open Exchange Rates HTTP ${r.status}`);
      return {rates:d.rates,source:'openexchangerates'};
    }
    const r=await fetchImpl('https://open.er-api.com/v6/latest/USD',{signal:ctl.signal});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||d?.result!=='success'||!d?.rates)throw new Error(d?.['error-type']||`ExchangeRate-API HTTP ${r.status}`);
    return {rates:d.rates,source:'exchangerate-api'};
  }finally{clearTimeout(timer);}
}
function ltFxPick(rates){
  const out={};
  for(const code of LT_FX_CODES){const v=Number(rates?.[code]);if(v>0)out[code]=v;}
  out.USD=1;
  return out;
}
const ltFxDay=d=>d.toISOString().slice(0,10);
// Start of the current 6-hour UTC slot.
export function ltFxSlotStart(now=new Date()){
  const d=new Date(now);d.setUTCMinutes(0,0,0);d.setUTCHours(Math.floor(d.getUTCHours()/LT_FX_SLOT_HOURS)*LT_FX_SLOT_HOURS);return d;
}
export function ltFxNextSlot(now=new Date()){
  return new Date(ltFxSlotStart(now).getTime()+LT_FX_SLOT_HOURS*3600*1000);
}
async function ltFxReadRow(env){
  try{await ltFxEnsureTable(env);return await env.DB.prepare(`SELECT * FROM live_travel_fx_rates WHERE base='USD'`).first();}catch(e){return null;}
}
function ltFxFromRow(row,now=new Date()){
  const callsToday=row&&row.refresh_day===ltFxDay(now)?Number(row.refresh_count||0):0;
  let rates=null;try{rates=JSON.parse(row?.rates_json||'null')}catch(e){}
  const meta={refreshes_today:callsToday,last_attempt_at:row?.last_attempt_at||null};
  if(!row?.fetched_at||!rates||!Object.keys(rates).length)return {...ltFxPegFallback(),...meta};
  return {base:'USD',rates:{...LT_FX_USD_PEGS,...rates},source:row.source,fetched_at:row.fetched_at,
    stale:now.getTime()-new Date(row.fetched_at).getTime()>LT_FX_STALE_MS,...meta};
}

/* The rates every Live Agency calculation uses: the one stored snapshot. Never throws and never
   calls the provider — except on a brand-new deployment with no snapshot at all, where it makes
   the current slot's (single, capped) attempt so the first search isn't stuck on peg-only rates. */
export async function ltFxRates(env,opts={}){
  const current=ltFxFromRow(await ltFxReadRow(env));
  if(current.fetched_at||opts.allowFetch===false)return current;
  return (await ltFxRefresh(env,opts)).rates;
}

/* Claims this slot's single provider call and makes it.
   Returns {refreshed, reason, rates}; reason: 'ok' | 'slot_used' | 'daily_limit' | 'in_progress' | 'provider_error'. */
export async function ltFxRefresh(env,opts={}){
  const now=opts.now||new Date(),day=ltFxDay(now),nowIso=now.toISOString(),slotIso=ltFxSlotStart(now).toISOString();
  try{
    await ltFxEnsureTable(env);
    await env.DB.prepare(`INSERT OR IGNORE INTO live_travel_fx_rates (base,rates_json,source,fetched_at,refresh_day,refresh_count) VALUES ('USD','{}','','',?,0)`).bind(day).run();
    // The call is counted when claimed, so a failing provider can never burn more than 4 calls a day.
    const claim=await env.DB.prepare(`UPDATE live_travel_fx_rates
      SET refresh_count=CASE WHEN refresh_day=? THEN refresh_count+1 ELSE 1 END,refresh_day=?,last_attempt_at=?,refreshing_until=?
      WHERE base='USD' AND (refreshing_until IS NULL OR refreshing_until<?) AND (last_attempt_at IS NULL OR last_attempt_at<?) AND (refresh_day<>? OR refresh_count<?)`)
      .bind(day,day,nowIso,new Date(now.getTime()+60000).toISOString(),nowIso,slotIso,day,LT_FX_MAX_REFRESHES_PER_DAY).run();
    if(!(claim?.meta?.changes>0)){
      const row=await ltFxReadRow(env),current=ltFxFromRow(row,now);
      const reason=row?.refreshing_until&&row.refreshing_until>=nowIso?'in_progress':row?.last_attempt_at&&row.last_attempt_at>=slotIso?'slot_used':'daily_limit';
      return {refreshed:false,reason,rates:current};
    }
  }catch(e){return {refreshed:false,reason:'provider_error',rates:ltFxFromRow(await ltFxReadRow(env),now)};}
  try{
    const live=await ltFxFetchLive(env,opts.fetchImpl);
    await env.DB.prepare(`UPDATE live_travel_fx_rates SET rates_json=?,source=?,fetched_at=?,refreshing_until=NULL WHERE base='USD'`)
      .bind(JSON.stringify(ltFxPick(live.rates)),live.source,nowIso).run();
    return {refreshed:true,reason:'ok',rates:ltFxFromRow(await ltFxReadRow(env),now)};
  }catch(e){
    try{await env.DB.prepare(`UPDATE live_travel_fx_rates SET refreshing_until=NULL WHERE base='USD'`).run();}catch(e2){}
    return {refreshed:false,reason:'provider_error',error:String(e?.message||e),rates:ltFxFromRow(await ltFxReadRow(env),now)};
  }
}

// Cron hook (every 15 min): the first tick of each 6-hour UTC slot makes that slot's one call;
// every other tick is a single D1 update that matches no row.
export async function ltFxRefreshIfStale(env,opts={}){
  try{return await ltFxRefresh(env,opts);}catch(e){return {refreshed:false,reason:'provider_error'};}
}

/* ── Per-agency settings ── */
export async function ltFxEnsureSettingsTable(env){
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS live_travel_currency_settings (client_id INTEGER PRIMARY KEY,default_currency TEXT NOT NULL DEFAULT 'AED',fx_buffer_pct REAL NOT NULL DEFAULT 1.5,rounding TEXT NOT NULL DEFAULT 'auto',allow_currency_override INTEGER NOT NULL DEFAULT 1,auto_detect_phone_currency INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`).run();
}
export async function ltFxSettings(env,cid){
  try{
    await ltFxEnsureSettingsTable(env);
    return ltFxNormalizeSettings(await env.DB.prepare(`SELECT * FROM live_travel_currency_settings WHERE client_id=?`).bind(Number(cid)).first());
  }catch(e){return ltFxNormalizeSettings(null);}
}
export async function ltFxSaveSettings(env,cid,body={}){
  const current=await ltFxSettings(env,cid);
  const next=ltFxNormalizeSettings({...current,...Object.fromEntries(Object.entries(body).filter(([,v])=>v!==undefined&&v!==null&&v!==''))});
  if(body.default_currency!==undefined&&!ltFxCode(body.default_currency))throw new Error(`Unsupported currency. Use one of: ${LT_FX_CODES.join(', ')}.`);
  const now=new Date().toISOString();
  await env.DB.prepare(`INSERT INTO live_travel_currency_settings (client_id,default_currency,fx_buffer_pct,rounding,allow_currency_override,auto_detect_phone_currency,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(client_id) DO UPDATE SET default_currency=excluded.default_currency,fx_buffer_pct=excluded.fx_buffer_pct,rounding=excluded.rounding,allow_currency_override=excluded.allow_currency_override,auto_detect_phone_currency=excluded.auto_detect_phone_currency,updated_at=excluded.updated_at`)
    .bind(Number(cid),next.default_currency,next.fx_buffer_pct,next.rounding,next.allow_currency_override,next.auto_detect_phone_currency,now,now).run();
  return next;
}

// Builds ctx.fx for ltFxApplyToOffer from settings + a chosen target currency.
export function ltFxContext(settings,rates,target){
  return {target:ltFxCode(target)||settings.default_currency,rates:rates.rates,buffer_pct:settings.fx_buffer_pct,rounding:settings.rounding,fetched_at:rates.fetched_at,source:rates.source};
}

// Public rate table relative to the agency currency, for the settings screen.
export function ltFxRateTable(rates,target){
  return LT_FX_CODES.filter(c=>c!==target).map(code=>({currency:code,name:LT_FX_CURRENCIES[code].name,rate_to_default:ltFxRate(code,target,rates.rates),rate_from_default:ltFxRate(target,code,rates.rates)}));
}
