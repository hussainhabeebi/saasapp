// ── Hospitality → API Import ─────────────────────────────────────────────────────────────────────
// Lets a hospitality client point us at another system's property API — e.g. a property site that
// says "GET https://example.com/api/v1/properties, send the key as Authorization: Bearer <key>" —
// and import its properties and their units/rooms into hospitality_properties / hospitality_units,
// then keep them in sync on the 15-minute cron (each source has its own interval).
//
// Feeds differ, so mapping is tolerant: the list can be a bare array or under data / properties /
// items / results; a property's rooms can be under units / rooms / room_types / …; prices can be
// numbers, "₹4,500" strings or {amount, currency}; images strings or {url}. A property with no
// rooms list becomes one unit of its own, so non-resort clients (who only use units) get something
// bookable too. A link to a single property ("/properties/<slug>") imports just that one.
//
// Sync rules:
//   - The feed is the source of truth for the fields it fills; a changed record overwrites them,
//     an unchanged one (same hash) is not written at all.
//   - A record that leaves the feed is switched off (active=0), never deleted — bookings keep
//     their unit. It is switched back on if it returns. A full sync that returns nothing at all
//     switches nothing off (more likely an API hiccup than an empty catalogue).
//   - A record the client deleted here stays deleted; the sync doesn't bring it back.
//   - The key is only ever sent to the link's own origin, including on "next page" links.
//
// Like hospitality-suite.js, this imports nothing from worker.js; worker.js passes helpers in as
// `deps` (HI_DEPS there): json, requireSession, getClientById, reportOpsError,
// encrypt(env, plain)→string, decrypt(env, stored)→string|null, and optionally fetch / now.

const PAGE_LIMIT=50;
const MAX_PAGES=20;
const MAX_BODY_BYTES=5*1024*1024;
const FETCH_TIMEOUT_MS=20000;
const SOURCES_PER_TICK=5;
const RUNNING_STALE_MS=10*60*1000;
export const HI_SYNC_MINUTES=[15,30,60,180,360,720,1440];
export const HI_AUTH_STYLES=['bearer','x-api-key','none'];

const SCHEMA=[
  `CREATE TABLE IF NOT EXISTS hospitality_api_sources (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, name TEXT NOT NULL DEFAULT '', url TEXT NOT NULL, auth_style TEXT NOT NULL DEFAULT 'bearer', api_key_enc TEXT NOT NULL DEFAULT '', key_hint TEXT NOT NULL DEFAULT '', sync_enabled INTEGER NOT NULL DEFAULT 1, sync_minutes INTEGER NOT NULL DEFAULT 60, last_sync_at TEXT, last_status TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '', last_summary TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_hosp_api_sources_client ON hospitality_api_sources(client_id)`,
  `CREATE TABLE IF NOT EXISTS hospitality_api_links (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, source_id INTEGER NOT NULL, kind TEXT NOT NULL, external_id TEXT NOT NULL, local_id INTEGER NOT NULL, hash TEXT NOT NULL DEFAULT '', removed INTEGER NOT NULL DEFAULT 0, seen_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_hosp_api_links_ext ON hospitality_api_links(source_id, kind, external_id)`,
  `CREATE INDEX IF NOT EXISTS idx_hosp_api_links_local ON hospitality_api_links(client_id, kind, local_id)`,
];
const _ready=new WeakMap();
export function hiEnsureSchema(env){
  let p=_ready.get(env.DB);
  if(!p){
    p=(async()=>{ for(const sql of SCHEMA) await env.DB.prepare(sql).run(); })().catch(e=>{ _ready.delete(env.DB); throw e; });
    _ready.set(env.DB, p);
  }
  return p;
}

const all=async(env, sql, ...a)=>(await env.DB.prepare(sql).bind(...a).all()).results||[];
const first=(env, sql, ...a)=>env.DB.prepare(sql).bind(...a).first();
const run=(env, sql, ...a)=>env.DB.prepare(sql).bind(...a).run();

// ── URL + auth ───────────────────────────────────────────────────────────────────────────────────
// https only, and no hosts that only make sense inside a private network.
export function hiUrlError(raw){
  let u;
  try{ u=new URL(String(raw||'').trim()); }catch(e){ return 'Paste the full API link, starting with https://'; }
  if(u.protocol!=='https:') return 'The API link must start with https://';
  if(u.username||u.password) return 'Put the key in the API key box, not in the link';
  const h=u.hostname.toLowerCase().replace(/^\[|\]$/g,'');
  if(!h.includes('.')||h==='localhost'||h.endsWith('.localhost')||h.endsWith('.local')||h.endsWith('.internal')) return 'That host isn\'t reachable from the internet';
  if(/^(?:0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\.|^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return 'That host isn\'t reachable from the internet';
  if(h.includes(':')) return 'Use the API\'s domain name, not an IP address';
  return '';
}
export function hiAuthHeaders(style, key){
  const k=String(key||'').trim();
  if(!k||style==='none') return {};
  return style==='x-api-key'?{'X-API-Key':k}:{Authorization:`Bearer ${k}`};
}
export function hiKeyHint(key){
  const k=String(key||'').trim();
  return k?(k.length>8?`${k.slice(0,4)}…${k.slice(-4)}`:'••••'):'';
}

// ── Value helpers ────────────────────────────────────────────────────────────────────────────────
const isObj=v=>v&&typeof v==='object'&&!Array.isArray(v);
function pick(o, keys){
  for(const k of keys){ const v=o?.[k]; if(v!==undefined&&v!==null&&v!=='') return v; }
  return undefined;
}
function text(v, max){
  if(v==null) return '';
  if(isObj(v)) v=pick(v, ['name','title','label','value','text','en'])??'';
  if(Array.isArray(v)) v=v.map(x=>text(x, max)).filter(Boolean).join(', ');
  return String(v).replace(/<br\s*\/?>/gi,'\n').replace(/<\/p>/gi,'\n').replace(/<[^>]+>/g,'')
    .replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
    .replace(/[ \t]+/g,' ').replace(/\n\s*\n+/g,'\n').trim().slice(0, max);
}
// 4500, "4,500", "₹ 4,500/night", {amount:4500}, {value:"4500"} → 4500; anything else → null.
export function hiMoney(v){
  if(v==null||v==='') return null;
  if(isObj(v)) return hiMoney(pick(v, ['amount','value','price','min','from','base']));
  if(typeof v==='number') return Number.isFinite(v)&&v>=0?v:null;
  const m=String(v).replace(/,/g,'').match(/\d+(?:\.\d+)?/);
  return m?Number(m[0]):null;
}
function currencyOf(...vals){
  for(const v of vals){
    if(v==null) continue;
    if(isObj(v)){ const c=currencyOf(v.currency, v.currency_code); if(c) return c; continue; }
    const s=String(v).trim();
    if(/^[A-Za-z]{3}$/.test(s)) return s.toUpperCase();
    if(/₹|\bRs\.?|\bINR\b/i.test(s)) return 'INR';
    if(/\$/.test(s)) return 'USD';
    if(/€/.test(s)) return 'EUR';
    if(/£/.test(s)) return 'GBP';
    if(/\bAED\b/i.test(s)) return 'AED';
  }
  return '';
}
function int(v, def){
  if(isObj(v)) v=pick(v, ['adults','max','value']);
  const n=parseInt(v, 10);
  return Number.isFinite(n)&&n>=0&&n<1000?n:def;
}
function httpUrl(v){
  const s=String(v||'').trim();
  return /^https?:\/\/\S+$/i.test(s)&&s.length<=500?s:'';
}
function mediaUrl(v){
  if(typeof v==='string') return httpUrl(v);
  if(isObj(v)) return httpUrl(pick(v, ['url','src','href','original','large','full','image_url','image','file','path','link','secure_url']));
  return '';
}
const isVideoUrl=u=>/youtu\.?be|vimeo\.com|\.(?:mp4|mov|webm|m4v)(?:$|[?#])/i.test(u);
function isVideoItem(v){
  if(isObj(v)&&/video/i.test(String(v.type||v.media_type||v.kind||v.mime_type||''))) return true;
  return isVideoUrl(mediaUrl(v));
}
// {images:[…5], videos:[…2]} from whatever image/video fields the record has.
export function hiMedia(o){
  const images=[], videos=[];
  const add=(v, forceVideo)=>{
    if(Array.isArray(v)){ v.forEach(x=>add(x, forceVideo)); return; }
    const u=mediaUrl(v);
    if(!u) return;
    const list=forceVideo||isVideoItem(v)?videos:images;
    if(!list.includes(u)) list.push(u);
  };
  for(const k of ['cover_image','featured_image','main_image','thumbnail','image','image_url','photo','cover']) add(o?.[k], false);
  for(const k of ['images','photos','gallery','pictures','media','image_urls','photo_urls']) add(o?.[k], false);
  for(let i=1;i<=5;i++) add(o?.[`image_url_${i}`], false);
  for(const k of ['video','video_url','youtube','youtube_url','videos','video_urls']) add(o?.[k], true);
  for(let i=1;i<=2;i++) add(o?.[`video_url_${i}`], true);
  return {images:images.slice(0,5), videos:videos.slice(0,2)};
}
export function hiExternalId(o){
  const v=pick(o, ['id','uuid','_id','external_id','slug','code','sku']);
  if(v!==undefined&&!isObj(v)) return String(v).slice(0,200);
  const n=text(pick(o, ['name','title']), 200);
  return n?`name:${n.toLowerCase()}`:'';
}
// Stable short hash of what we'd write, so an unchanged record costs no write.
export function hiHash(obj){
  const s=JSON.stringify(obj);
  let h=0x811c9dc5;
  for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h, 0x01000193); }
  return (h>>>0).toString(36)+':'+s.length.toString(36);
}

// ── Mapping ──────────────────────────────────────────────────────────────────────────────────────
const UNIT_LIST_KEYS=['units','rooms','room_types','roomTypes','unit_types','room_categories','accommodations','accommodation_types','categories','inventory'];

export function hiMapProperty(raw){
  if(!isObj(raw)) return null;
  const name=text(pick(raw, ['name','title','property_name','display_name']), 140);
  const external_id=hiExternalId(raw);
  if(!name||!external_id) return null;
  const loc=pick(raw, ['destination','location','city','town','area','region','place']);
  let location=text(loc, 100);
  if(!location&&isObj(raw.address)) location=text(pick(raw.address, ['city','town','locality','district','state']), 100);
  const m=hiMedia(raw);
  return {
    external_id, name, location,
    description:text(pick(raw, ['description','short_description','summary','about','overview','details']), 1000),
    amenities:text(pick(raw, ['amenities','facilities','features','highlights']), 500),
    image_url_1:m.images[0]||null, image_url_2:m.images[1]||null, image_url_3:m.images[2]||null, image_url_4:m.images[3]||null, image_url_5:m.images[4]||null,
    video_url_1:m.videos[0]||null, video_url_2:m.videos[1]||null,
  };
}

function mapUnit(raw, prop, fallbackName){
  if(!isObj(raw)) return null;
  const name=text(pick(raw, ['name','title','room_name','room_type','type','category'])??fallbackName, 140);
  if(!name) return null;
  const cap=raw.capacity;
  const adults=int(pick(raw, ['max_adults','capacity_adults','adults','max_occupancy','occupancy','max_guests','guests','sleeps'])??cap, 2)||2;
  const children=int(pick(raw, ['max_children','capacity_children','children'])??(isObj(cap)?cap.children:undefined), 0);
  const priceRaw=pick(raw, ['base_rate','price','base_price','rate','price_per_night','nightly_rate','starting_price','price_from','tariff','min_price','pricing']);
  const m=hiMedia(raw);
  const pm=m.images.length?m:{images:[prop.image_url_1,prop.image_url_2,prop.image_url_3,prop.image_url_4,prop.image_url_5].filter(Boolean), videos:[prop.video_url_1,prop.video_url_2].filter(Boolean)};
  return {
    name,
    unit_type:text(pick(raw, ['unit_type','room_type','type','category','kind','property_type']), 80),
    capacity_adults:adults, capacity_children:children,
    amenities:text(pick(raw, ['amenities','facilities','features']), 500)||(fallbackName?prop.amenities:''),
    base_rate:hiMoney(priceRaw)??0,
    weekend_rate:hiMoney(pick(raw, ['weekend_rate','weekend_price','weekend_tariff'])),
    currency:(currencyOf(raw.currency, raw.currency_code, priceRaw, raw.price_display, raw.price_label)||'INR').slice(0,10),
    description:text(pick(raw, ['description','short_description','summary','about']), 1000)||(fallbackName?prop.description:''),
    image_url_1:pm.images[0]||null, image_url_2:pm.images[1]||null, image_url_3:pm.images[2]||null, image_url_4:pm.images[3]||null, image_url_5:pm.images[4]||null,
    video_url:pm.videos[0]||null, video_url_2:pm.videos[1]||null,
  };
}

// The property's units, each with an external id unique within the source. No rooms list → the
// property itself as a single unit.
export function hiMapUnits(raw, prop){
  let list=null;
  for(const k of UNIT_LIST_KEYS){ if(Array.isArray(raw?.[k])&&raw[k].length&&raw[k].some(isObj)){ list=raw[k]; break; } }
  const out=[];
  const seen=new Set();
  if(list){
    list.forEach((u, i)=>{
      const mapped=mapUnit(u, prop);
      if(!mapped) return;
      let ext=`${prop.external_id}::${hiExternalId(u)||'i'+i}`;
      while(seen.has(ext)) ext+='+';
      seen.add(ext);
      out.push({...mapped, external_id:ext});
    });
  }
  if(!out.length){
    const self=mapUnit(raw, prop, prop.name);
    if(self) out.push({...self, name:prop.name, external_id:`${prop.external_id}::self`});
  }
  return out;
}

const LIST_KEYS=['data','properties','items','results','records','listings','hotels','resorts','rows','list'];
// The array of records in a response body, however it's wrapped.
export function hiExtractList(body){
  if(Array.isArray(body)) return body;
  if(!isObj(body)) return [];
  for(const k of LIST_KEYS){
    const v=body[k];
    if(Array.isArray(v)) return v;
    if(isObj(v)){ const inner=hiExtractList(v); if(inner.length) return inner; }
  }
  // A single-property endpoint: {data:{…}} or the property itself.
  if(isObj(body.data)&&pick(body.data, ['name','title'])) return [body.data];
  if(isObj(body.property)) return [body.property];
  if(pick(body, ['name','title'])&&(pick(body, ['id','slug','uuid'])!==undefined)) return [body];
  return [];
}

// What the response says about further pages: {next} (an absolute URL to follow), {more:true|false}
// or {} when it says nothing.
export function hiPageInfo(body, page, count, limit){
  if(!isObj(body)) return {};
  const metas=[body, body.meta, body.pagination, body.paging, body.page_info, body.links, body.meta?.pagination].filter(isObj);
  for(const m of metas){
    const nx=pick(m, ['next','next_page_url','next_url','nextPage']);
    if(typeof nx==='string'&&/^https?:\/\//i.test(nx)) return {next:nx};
  }
  for(const m of metas){
    const hm=pick(m, ['has_more','hasMore','has_next','hasNext','has_next_page','hasNextPage']);
    if(typeof hm==='boolean') return {more:hm};
    const pages=Number(pick(m, ['total_pages','totalPages','last_page','lastPage','pages','page_count']));
    if(Number.isFinite(pages)&&pages>0) return {more:page<pages};
    const total=Number(pick(m, ['total','total_count','totalCount','total_results','count_total']));
    if(Number.isFinite(total)&&total>=0) return {more:page*limit<total&&count>0};
    if('next' in m&&(m.next===null||m.next===false)) return {more:false};
  }
  return {};
}

const LIMIT_PARAMS=['limit','per_page','page_size','pageSize','perPage'];
// The page size the link asks for itself, else ours.
function pageLimit(base){
  const u=new URL(base);
  for(const k of LIMIT_PARAMS){ const n=Number(u.searchParams.get(k)); if(Number.isFinite(n)&&n>0) return n; }
  return PAGE_LIMIT;
}
function pageUrl(base, page){
  const u=new URL(base);
  if(!LIMIT_PARAMS.some(k=>u.searchParams.has(k))) u.searchParams.set('limit', String(PAGE_LIMIT));
  u.searchParams.set('page', String(page));
  return u.toString();
}

// Redirects are followed by hand, and only within the same origin, so the key never leaves it.
async function fetchJson(deps, url, headers){
  const f=deps.fetch||fetch;
  let r;
  for(let hop=0;;hop++){
    try{ r=await f(url, {headers:{Accept:'application/json', 'User-Agent':'Leadvyne-Hospitality-Import/1.0', ...headers}, redirect:'manual', signal:AbortSignal.timeout?.(FETCH_TIMEOUT_MS)}); }
    catch(e){ throw new Error(`Couldn't reach the API (${e?.name==='TimeoutError'?'timed out':e?.message||'network error'})`); }
    if(r.status<300||r.status>=400) break;
    const loc=r.headers.get('location');
    let next=null;
    try{ next=loc?new URL(loc, url):null; }catch(e){}
    if(!next||next.origin!==new URL(url).origin||hop>=3) throw new Error(`The API redirected (HTTP ${r.status}) — paste the final link`);
    url=next.toString();
  }
  if(r.status===401||r.status===403) throw new Error(`The API refused the key (HTTP ${r.status}) — check the key and how it's sent`);
  if(r.status===404) throw new Error('The API link was not found (HTTP 404)');
  if(r.status===429) throw new Error('The API is rate-limiting us (HTTP 429) — try a longer sync interval');
  if(!r.ok) throw new Error(`The API returned HTTP ${r.status}`);
  const len=Number(r.headers.get('content-length')||0);
  if(len>MAX_BODY_BYTES) throw new Error('The API response is too large');
  const body=await r.text();
  if(body.length>MAX_BODY_BYTES) throw new Error('The API response is too large');
  try{ return JSON.parse(body); }catch(e){ throw new Error('The API did not return JSON'); }
}

// Every raw property record from the source, following its pagination. `complete` is false when
// we stopped at the page cap — the sync then switches nothing off, since it hasn't seen everything.
export async function hiFetchAll(deps, src, apiKey, {maxPages=MAX_PAGES}={}){
  const origin=new URL(src.url).origin;
  const headers=hiAuthHeaders(src.auth_style, apiKey);
  const limit=pageLimit(src.url);
  const records=[];
  const seenFirst=new Set();
  let url=src.url, page=1, usePageParam=true, complete=true;
  for(;;){
    const body=await fetchJson(deps, usePageParam?pageUrl(src.url, page):url, headers);
    const list=hiExtractList(body);
    if(page===1&&!list.length&&!(isObj(body)&&LIST_KEYS.some(k=>k in body))&&!Array.isArray(body)){
      throw new Error('Couldn\'t find a list of properties in the API response');
    }
    // An API that ignores ?page= serves page 1 again — stop instead of importing it twice.
    const firstId=list.length?hiExternalId(list[0]):'';
    if(page>1&&firstId&&seenFirst.has(firstId)) break;
    if(firstId) seenFirst.add(firstId);
    records.push(...list);
    const info=hiPageInfo(body, page, list.length, limit);
    let more;
    if(info.next){
      if(new URL(info.next).origin!==origin) break; // never send the key elsewhere
      url=info.next; usePageParam=false; more=true;
    }else if(typeof info.more==='boolean') more=info.more&&list.length>0;
    else more=list.length>=limit;
    if(!more) break;
    if(page>=maxPages){ complete=false; break; }
    page++;
  }
  return {records, complete};
}

// ── Sync ─────────────────────────────────────────────────────────────────────────────────────────
const PROP_COLS=['name','description','amenities','location','image_url_1','image_url_2','image_url_3','image_url_4','image_url_5','video_url_1','video_url_2'];
const UNIT_COLS=['name','unit_type','capacity_adults','capacity_children','amenities','base_rate','weekend_rate','currency','description','image_url_1','image_url_2','image_url_3','image_url_4','image_url_5','video_url','video_url_2','property_id'];

// Links and local ids are loaded once per sync, so an unchanged record costs no query at all.
async function upsert(env, ctx, kind, rec, cols){
  const table=kind==='property'?'hospitality_properties':'hospitality_units';
  const values=Object.fromEntries(cols.map(c=>[c, rec[c]===undefined?null:rec[c]]));
  const hash=hiHash(values);
  const link=ctx.links.get(`${kind}|${rec.external_id}`);
  if(link){
    ctx.seen.add(link.id);
    if(!ctx.localIds[kind].has(Number(link.local_id))){ ctx.counts.skipped++; return null; } // deleted here on purpose — keep it deleted
    const changed=link.hash!==hash;
    if(!changed&&!Number(link.removed)) return Number(link.local_id);
    const sets=changed?cols.map(c=>`${c}=?`):[];
    const vals=changed?cols.map(c=>values[c]):[];
    if(Number(link.removed)) sets.push('active=1');
    await run(env, `UPDATE ${table} SET ${sets.join(', ')} WHERE id=? AND client_id=?`, ...vals, link.local_id, ctx.cid);
    await run(env, `UPDATE hospitality_api_links SET hash=?, removed=0, seen_at=? WHERE id=?`, hash, ctx.nowIso, link.id);
    ctx.counts[kind==='property'?'properties_updated':'units_updated']++;
    return Number(link.local_id);
  }
  const r=await run(env, `INSERT INTO ${table} (client_id, ${cols.join(', ')}, active, created_at) VALUES (?, ${cols.map(()=>'?').join(', ')}, 1, ?)`, ctx.cid, ...cols.map(c=>values[c]), ctx.nowIso);
  const id=Number(r.meta.last_row_id);
  const lr=await run(env, `INSERT INTO hospitality_api_links (client_id, source_id, kind, external_id, local_id, hash, removed, seen_at) VALUES (?,?,?,?,?,?,0,?)`, ctx.cid, ctx.src.id, kind, rec.external_id, id, hash, ctx.nowIso);
  const newLink={id:Number(lr.meta.last_row_id), local_id:id, hash, removed:0};
  ctx.links.set(`${kind}|${rec.external_id}`, newLink);
  ctx.seen.add(newLink.id);
  ctx.localIds[kind].add(id);
  ctx.counts[kind==='property'?'properties_added':'units_added']++;
  return id;
}

export function hiSummaryText(c){
  const parts=[];
  const add=(n, label)=>{ if(n) parts.push(`${n} ${label}`); };
  add(c.properties_added, 'properties added'); add(c.properties_updated, 'properties updated');
  add(c.units_added, 'units added'); add(c.units_updated, 'units updated');
  add(c.deactivated, 'switched off (no longer in the feed)');
  if(!parts.length) parts.push(`No changes — ${c.properties_seen} properties, ${c.units_seen} units up to date`);
  if(c.incomplete) parts.push(`stopped at ${MAX_PAGES} pages`);
  return parts.join(', ');
}

// One source, end to end. Returns {ok, counts, summary} or {ok:false, error}; also records the
// outcome on the source row.
export async function hiSyncSource(env, deps, src, {nowMs}={}){
  const now=nowMs??(deps.now?.()??Date.now());
  const nowIso=new Date(now).toISOString();
  const cid=Number(src.client_id);
  await run(env, `UPDATE hospitality_api_sources SET last_status='running', last_sync_at=? WHERE id=?`, nowIso, src.id);
  const counts={properties_seen:0, units_seen:0, properties_added:0, properties_updated:0, units_added:0, units_updated:0, deactivated:0, skipped:0, incomplete:false};
  try{
    const apiKey=src.api_key_enc?await deps.decrypt(env, src.api_key_enc):'';
    if(src.api_key_enc&&!apiKey) throw new Error('The saved API key can\'t be read any more — enter it again');
    const {records, complete}=await hiFetchAll(deps, src, apiKey);
    counts.incomplete=!complete;
    const linkRows=await all(env, `SELECT id, kind, external_id, local_id, hash, removed FROM hospitality_api_links WHERE source_id=?`, src.id);
    const ids=async table=>new Set((await all(env, `SELECT id FROM ${table} WHERE client_id=?`, cid)).map(r=>Number(r.id)));
    const ctx={src, cid, nowIso, counts, seen:new Set(),
      links:new Map(linkRows.map(l=>[`${l.kind}|${l.external_id}`, l])),
      localIds:{property:await ids('hospitality_properties'), unit:await ids('hospitality_units')}};
    const seenProps=new Set();
    for(const raw of records){
      const prop=hiMapProperty(raw);
      if(!prop||seenProps.has(prop.external_id)) continue;
      seenProps.add(prop.external_id);
      counts.properties_seen++;
      const propertyId=await upsert(env, ctx, 'property', prop, PROP_COLS);
      if(propertyId==null) continue; // the property was deleted here — so are its rooms
      for(const unit of hiMapUnits(raw, prop)){
        counts.units_seen++;
        await upsert(env, ctx, 'unit', {...unit, property_id:propertyId}, UNIT_COLS);
      }
    }
    if(complete&&counts.properties_seen>0){
      const gone=[...ctx.links.values()].filter(l=>!ctx.seen.has(l.id)&&!Number(l.removed));
      for(const l of gone){
        const table=l.kind==='property'?'hospitality_properties':'hospitality_units';
        await run(env, `UPDATE ${table} SET active=0 WHERE id=? AND client_id=?`, l.local_id, cid);
        await run(env, `UPDATE hospitality_api_links SET removed=1 WHERE id=?`, l.id);
        counts.deactivated++;
      }
    }
    const summary=hiSummaryText(counts);
    await run(env, `UPDATE hospitality_api_sources SET last_status='ok', last_error='', last_summary=?, last_sync_at=? WHERE id=?`, summary, nowIso, src.id);
    return {ok:true, counts, summary};
  }catch(e){
    const error=String(e?.message||e).slice(0,300);
    await run(env, `UPDATE hospitality_api_sources SET last_status='error', last_error=?, last_sync_at=? WHERE id=?`, error, nowIso, src.id);
    return {ok:false, error, counts};
  }
}

export function hiDue(src, nowMs){
  if(!Number(src.sync_enabled)) return false;
  const last=Date.parse(src.last_sync_at||'');
  if(!Number.isFinite(last)) return true;
  if(src.last_status==='running') return nowMs-last>RUNNING_STALE_MS;
  return nowMs-last>=(Number(src.sync_minutes)||60)*60000-30000; // a tick's jitter early is still on time
}

// 15-minute cron: the most overdue few sources whose client still has Hospitality on.
export async function hiRunDue(env, deps, nowMs=Date.now()){
  let rows;
  try{ rows=await all(env, `SELECT * FROM hospitality_api_sources WHERE sync_enabled=1 ORDER BY COALESCE(last_sync_at,'') ASC LIMIT 200`); }
  catch(e){ if(/no such table/i.test(String(e?.message))) return; throw e; }
  const due=rows.filter(s=>hiDue(s, nowMs)).slice(0, SOURCES_PER_TICK);
  for(const src of due){
    try{
      const c=await deps.getClientById(env, src.client_id);
      if(String(c?.hospitality_enabled||'')!=='Yes') continue;
      await hiSyncSource(env, deps, src, {nowMs});
    }catch(e){ await deps.reportOpsError?.(env, 'hospitalityImport.sync', e, {clientId:src.client_id, sourceId:src.id}).catch(()=>{}); }
  }
}

// ── Dashboard API (/hospitality/import/*) ────────────────────────────────────────────────────────
function publicSource(s, links){
  const {api_key_enc, ...rest}=s;
  return {...rest, has_key:!!api_key_enc, Id:s.id, properties:links?.property||0, units:links?.unit||0};
}
function cleanSourceInput(body, partial){
  const v={};
  if(!partial||'url' in body){
    const url=String(body.url||'').trim();
    const err=hiUrlError(url);
    if(err) return {error:err};
    v.url=url.slice(0,500);
  }
  if(!partial||'name' in body) v.name=String(body.name||'').trim().slice(0,80)||(v.url?new URL(v.url).hostname:'');
  if(!partial||'auth_style' in body) v.auth_style=HI_AUTH_STYLES.includes(body.auth_style)?body.auth_style:'bearer';
  if(!partial||'sync_minutes' in body){ const n=Number(body.sync_minutes); v.sync_minutes=HI_SYNC_MINUTES.includes(n)?n:60; }
  if(!partial||'sync_enabled' in body) v.sync_enabled=body.sync_enabled===false||body.sync_enabled===0?0:1;
  return {values:v};
}

export async function hiHandleRoute(request, env, deps, url){
  const payload=await deps.requireSession(request, env);
  if(!payload) return deps.json({error:'Invalid or expired session'}, 401);
  if(!env.DB) return deps.json({error:'Database not configured'}, 500);
  const cid=Number(payload.cid);
  await hiEnsureSchema(env);
  const path=url.pathname.replace(/^\/hospitality\/import/,'');
  const method=request.method;
  const body=method==='GET'?{}:await request.json().catch(()=>({}));
  const own=async id=>id?await first(env, `SELECT * FROM hospitality_api_sources WHERE id=? AND client_id=?`, Number(id), cid):null;

  if(path==='/sources'&&method==='GET'){
    const sources=await all(env, `SELECT * FROM hospitality_api_sources WHERE client_id=? ORDER BY id ASC`, cid);
    const counts=await all(env, `SELECT source_id, kind, COUNT(*) AS n FROM hospitality_api_links WHERE client_id=? AND removed=0 GROUP BY source_id, kind`, cid);
    const by={};
    counts.forEach(r=>{ (by[r.source_id]||(by[r.source_id]={}))[r.kind]=Number(r.n); });
    return deps.json({list:sources.map(s=>publicSource(s, by[s.id])), sync_minutes:HI_SYNC_MINUTES});
  }

  if(path==='/test'&&method==='POST'){
    const src=body.id?await own(body.id):null;
    if(body.id&&!src) return deps.json({error:'Not found'}, 404);
    const urlIn=String(body.url??src?.url??'').trim();
    const err=hiUrlError(urlIn);
    if(err) return deps.json({error:err}, 400);
    const auth=HI_AUTH_STYLES.includes(body.auth_style)?body.auth_style:(src?.auth_style||'bearer');
    let key=String(body.api_key||'').trim();
    if(!key&&src?.api_key_enc) key=await deps.decrypt(env, src.api_key_enc)||'';
    try{
      const {records}=await hiFetchAll(deps, {url:urlIn, auth_style:auth}, key, {maxPages:1});
      const props=records.map(hiMapProperty).filter(Boolean);
      const sample=records.slice(0,5).map(r=>{ const p=hiMapProperty(r); return p?{name:p.name, location:p.location, photos:[p.image_url_1,p.image_url_2,p.image_url_3,p.image_url_4,p.image_url_5].filter(Boolean).length, units:hiMapUnits(r, p).map(u=>({name:u.name, base_rate:u.base_rate, currency:u.currency, capacity_adults:u.capacity_adults}))}:null; }).filter(Boolean);
      return deps.json({ok:true, found:props.length, skipped:records.length-props.length, sample});
    }catch(e){ return deps.json({ok:false, error:String(e?.message||e)}, 200); }
  }

  if(path==='/sources'&&method==='POST'){
    const {values, error}=cleanSourceInput(body, false);
    if(error) return deps.json({error}, 400);
    const key=String(body.api_key||'').trim();
    if(!key&&values.auth_style!=='none') return deps.json({error:'Paste the API key (or choose "No key")'}, 400);
    let enc='';
    if(key){ try{ enc=await deps.encrypt(env, key); }catch(e){ return deps.json({error:'API keys can\'t be stored on this server yet (encryption secret missing)'}, 500); } }
    const nowIso=new Date(deps.now?.()??Date.now()).toISOString();
    const r=await run(env, `INSERT INTO hospitality_api_sources (client_id, name, url, auth_style, api_key_enc, key_hint, sync_enabled, sync_minutes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      cid, values.name, values.url, values.auth_style, enc, hiKeyHint(key), values.sync_enabled, values.sync_minutes, nowIso, nowIso);
    let src=await first(env, `SELECT * FROM hospitality_api_sources WHERE id=?`, Number(r.meta.last_row_id));
    let result=null;
    if(body.sync_now!==false){ result=await hiSyncSource(env, deps, src); src=await own(src.id); }
    return deps.json({source:publicSource(src), result});
  }

  if(path==='/sources'&&method==='PATCH'){
    const src=await own(body.id);
    if(!src) return deps.json({error:'Not found'}, 404);
    const {values, error}=cleanSourceInput(body, true);
    if(error) return deps.json({error}, 400);
    if('api_key' in body&&String(body.api_key||'').trim()){
      const key=String(body.api_key).trim();
      try{ values.api_key_enc=await deps.encrypt(env, key); }catch(e){ return deps.json({error:'API keys can\'t be stored on this server yet (encryption secret missing)'}, 500); }
      values.key_hint=hiKeyHint(key);
    }
    const cols=Object.keys(values);
    if(cols.length){
      await run(env, `UPDATE hospitality_api_sources SET ${cols.map(c=>`${c}=?`).join(', ')}, updated_at=? WHERE id=?`, ...cols.map(c=>values[c]), new Date(deps.now?.()??Date.now()).toISOString(), src.id);
    }
    return deps.json({source:publicSource(await own(src.id))});
  }

  if(path==='/sources'&&method==='DELETE'){
    const src=await own(body.id);
    if(!src) return deps.json({error:'Not found'}, 404);
    // Imported properties/units stay (bookings may point at them); they just stop syncing.
    // remove_records:true switches them off as well.
    if(body.remove_records){
      const links=await all(env, `SELECT kind, local_id FROM hospitality_api_links WHERE source_id=?`, src.id);
      for(const l of links) await run(env, `UPDATE ${l.kind==='property'?'hospitality_properties':'hospitality_units'} SET active=0 WHERE id=? AND client_id=?`, l.local_id, cid);
    }
    await run(env, `DELETE FROM hospitality_api_links WHERE source_id=?`, src.id);
    await run(env, `DELETE FROM hospitality_api_sources WHERE id=?`, src.id);
    return deps.json({ok:true});
  }

  if(path==='/sync'&&method==='POST'){
    const src=await own(body.id);
    if(!src) return deps.json({error:'Not found'}, 404);
    if(src.last_status==='running'&&!hiDue({...src, sync_enabled:1}, deps.now?.()??Date.now())) return deps.json({error:'A sync is already running for this link'}, 409);
    const result=await hiSyncSource(env, deps, src);
    return deps.json({source:publicSource(await own(src.id)), result});
  }

  return deps.json({error:'Not found'}, 404);
}
