// ── Ecom → 🌐 Website Sync (a merchant's own e-commerce website) ─────────────────────────────────
// Connects a custom store website that exposes a small REST API — e.g. 4L Fashion's
//   Base URL https://…/api/v1 · Authorization: Bearer <key>
//   GET /orders?updated_since=…   GET /orders/{id}   GET /products   GET /products/{id}
//   GET /inventory                GET /ping
// and webhooks POSTed as {id, event, created_at, data} with X-…-Event / X-…-Timestamp /
// X-…-Signature: sha256=HMAC(secret, timestamp + "." + body).
//
// The website's products, orders and categories become ordinary Ecom Products / Orders /
// Categories, so the Products and Orders pages, Reports, the storefront and the WhatsApp bot use
// them exactly like ones added by hand:
//   - Existing items are adopted, not duplicated: a product is matched by its website id, else
//     SKU, else exact name; an order by its website id, else its order number; a category by name.
//   - Deleted on the website → deleted here: product.deleted / order.deleted webhooks delete the
//     row, and a full sync deletes linked products (and categories the sync created) the website
//     no longer returns. Hand-made items are never touched. A full sync that returns nothing, or
//     stops at the page cap, deletes nothing (an API hiccup must not wipe a catalogue).
//   - Webhooks keep things live; the 15-minute cron polls orders with updated_since (the cursor is
//     the newest updated_at seen) and re-reads the catalogue every sync interval, so a missed
//     webhook is caught up.
//
// Like hospitality-import.js this imports nothing from worker.js; worker.js passes helpers in as
// `deps` (WEBSITE_SYNC_DEPS): json, requireSession, getClientById, reportOpsError, encrypt,
// decrypt, ecomTable(env, cid, kind), listRows(env, tableId, cid, whereSuffix, fields),
// bulkWrite(env, tableId, method, rows), ensureProductFields(env, tableId),
// ensureOrderFields(env, tableId), productsSaved(env, cid, rows), productsDeleted(env, cid, ids),
// listCategories(env, cid), createCategory(env, cid, name), deleteCategory(env, cid, id),
// webhookBase(env); optionally fetch / now.

import {hiUrlError, hiKeyHint, hiPageInfo} from './hospitality-import.js';
import {shopifyEcomNextStatus, shopifyHtmlToText} from './shopify-sync.js';

const PAGE_LIMIT=100;
const MAX_PRODUCT_PAGES=50;
const MAX_ORDER_PAGES=20;
const MAX_BODY_BYTES=8*1024*1024;
const FETCH_TIMEOUT_MS=20000;
const CONFIGS_PER_TICK=4;
const RUNNING_STALE_MS=10*60*1000;
const FIRST_ORDER_DAYS=90;
const SIGNATURE_MAX_AGE_S=15*60;
export const WS_SYNC_MINUTES=[15,30,60,180,360,720,1440];
export const WS_AUTH_STYLES=['bearer','x-api-key'];
export const WS_DEFAULT_PATHS={ping:'/ping', products:'/products', orders:'/orders', inventory:'/inventory'};

const SCHEMA=[
  `CREATE TABLE IF NOT EXISTS ecom_website_sync (client_id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '', base_url TEXT NOT NULL, auth_style TEXT NOT NULL DEFAULT 'bearer', api_key_enc TEXT NOT NULL DEFAULT '', key_hint TEXT NOT NULL DEFAULT '', webhook_token TEXT NOT NULL, webhook_secret_enc TEXT NOT NULL DEFAULT '', currency TEXT NOT NULL DEFAULT '', paths_json TEXT NOT NULL DEFAULT '{}', sync_products INTEGER NOT NULL DEFAULT 1, sync_orders INTEGER NOT NULL DEFAULT 1, sync_categories INTEGER NOT NULL DEFAULT 1, delete_missing INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1, sync_minutes INTEGER NOT NULL DEFAULT 60, orders_cursor TEXT NOT NULL DEFAULT '', category_ids_json TEXT NOT NULL DEFAULT '[]', last_sync_at TEXT, last_status TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '', last_summary TEXT NOT NULL DEFAULT '', last_webhook_at TEXT, last_webhook_event TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ecom_website_sync_token ON ecom_website_sync(webhook_token)`,
  `CREATE TABLE IF NOT EXISTS ecom_website_sync_events (client_id INTEGER NOT NULL, event_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (client_id, event_id))`,
];
const _ready=new WeakMap();
export function wsEnsureSchema(env){
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
const nowIso=deps=>new Date(deps.now?.()??Date.now()).toISOString();

// ── Value helpers (pure) ─────────────────────────────────────────────────────────────────────────
const isObj=v=>v&&typeof v==='object'&&!Array.isArray(v);
function pick(o, keys){
  for(const k of keys){ const v=o?.[k]; if(v!==undefined&&v!==null&&v!=='') return v; }
  return undefined;
}
const idStr=v=>(v===undefined||v===null)?'':String(v).trim();
function txt(v, max=500){
  if(v==null) return '';
  if(isObj(v)) v=pick(v, ['name','title','label','value','en'])??'';
  if(Array.isArray(v)) v=v.map(x=>txt(x, max)).filter(Boolean).join(', ');
  return String(v).trim().slice(0, max);
}
// 120, "120.50", "QAR 1,200", {amount:120} → number; anything else → null.
export function wsMoney(v){
  if(v==null||v==='') return null;
  if(typeof v==='number') return Number.isFinite(v)?v:null;
  if(isObj(v)) return wsMoney(pick(v, ['amount','value','price','decimal']));
  const m=String(v).replace(/,/g,'').match(/-?\d+(?:\.\d+)?/);
  return m?Number(m[0]):null;
}
const intOrNull=v=>{ const n=wsMoney(v); return n==null?null:Math.round(n); };
const key=v=>String(v||'').trim().toLowerCase();
// NocoDB hands numbers back as "599.00" or 599 — compare those as numbers, everything else as text.
const sameValue=(a, b)=>{
  const x=String(a??''), y=String(b??'');
  if(x===y) return true;
  return x!==''&&y!==''&&Number.isFinite(Number(x))&&Number(x)===Number(y);
};
// Values used inside NocoDB's where=(field,op,value) DSL.
const safeWhere=v=>String(v).replace(/[(),~]/g, '');

const LIST_KEYS=['data','items','products','orders','inventory','results','records','rows','list','stock'];
export function wsExtractList(body){
  if(Array.isArray(body)) return body;
  if(!isObj(body)) return [];
  for(const k of LIST_KEYS){
    const v=body[k];
    if(Array.isArray(v)) return v;
    if(isObj(v)){ const inner=wsExtractList(v); if(inner.length) return inner; }
  }
  return [];
}
// A single-record response: {data:{…}}, {product:{…}}, {order:{…}} or the record itself.
export function wsExtractOne(body, kind){
  if(!isObj(body)) return null;
  for(const k of [kind, 'data', 'item', 'record']){
    if(isObj(body[k])) return isObj(body[k][kind])?body[k][kind]:body[k];
  }
  return body;
}
export function wsExternalId(o){ return idStr(pick(o, ['id','product_id','order_id','uuid','_id'])); }

const INACTIVE=/^(draft|inactive|archived|hidden|disabled|unpublished|private|unlisted|out_of_catalog|discontinued)$/i;
export function wsIsDeleted(o){
  return !!(o?.deleted===true||o?.is_deleted===true||o?.deleted_at||/^(deleted|trashed|trash)$/i.test(String(o?.status||'')));
}
function mediaUrl(v){
  if(!v) return '';
  if(typeof v==='string') return /^https?:\/\//i.test(v.trim())?v.trim():'';
  if(isObj(v)) return mediaUrl(pick(v, ['url','src','image','original','large','full','path']));
  return '';
}
function variantList(p){
  const v=pick(p, ['variants','variations','options_stock','skus','sizes_stock']);
  return Array.isArray(v)?v.filter(isObj):[];
}
const variantColor=v=>txt(pick(v, ['color','colour','color_name','colour_name'])??pick(v?.options, ['color','colour','Color','Colour']), 60);
const variantSize=v=>txt(pick(v, ['size','size_name'])??pick(v?.options, ['size','Size']), 40);
const variantStock=v=>intOrNull(pick(v, ['stock','quantity','qty','stock_quantity','inventory','inventory_quantity','available']));
const uniq=list=>[...new Set(list.filter(Boolean))];

// The product's category names (first one is "the" category on the Ecom product).
export function wsProductCategories(p){
  const out=[];
  const one=pick(p, ['category','category_name','product_type','type','collection']);
  if(one) out.push(txt(one, 80));
  const many=pick(p, ['categories','collections']);
  if(Array.isArray(many)) many.forEach(c=>out.push(txt(c, 80)));
  return uniq(out.map(s=>s.trim()));
}

// One website product → the Ecom product fields the website owns. Optional fields are only set
// when the website has them, so anything a merchant added here on top (extra photos, audio, style
// fields …) is kept.
export function wsProductFields(p, {baseUrl='', currency=''}={}){
  if(!isObj(p)) return null;
  const id=wsExternalId(p);
  const name=txt(pick(p, ['name','title','product_name']), 250);
  if(!id||!name) return null;
  const variants=variantList(p);
  const variantPrices=variants.map(v=>wsMoney(pick(v, ['sale_price','price']))).filter(n=>n!=null&&n>0);
  const sale=wsMoney(pick(p, ['sale_price','special_price','offer_price','discounted_price']));
  const regular=wsMoney(pick(p, ['price','regular_price','base_price','amount']));
  const price=sale&&sale>0&&(!regular||sale<=regular)?sale:(regular??(variantPrices.length?Math.min(...variantPrices):null));
  const vStocks=variants.map(variantStock).filter(n=>n!=null);
  const ownStock=intOrNull(pick(p, ['stock','quantity','qty','stock_quantity','inventory','inventory_quantity','total_stock','available']));
  const stock=vStocks.length?vStocks.reduce((s, n)=>s+Math.max(0, n), 0):ownStock;
  const flagOff=[p.active, p.is_active, p.published, p.is_published, p.visible, p.enabled].some(v=>v===false||v===0||v==='0');
  const active=!flagOff&&!INACTIVE.test(String(p.status||p.visibility||''));
  const sku=txt(pick(p, ['sku','code','item_code','barcode'])??variants.map(v=>pick(v, ['sku','code'])).find(Boolean), 120);
  const f={name, sku, status:active?'active':'inactive', website_product_id:id};
  if(price!=null) f.price=price;
  if(stock!=null) f.stock=Math.max(0, stock);
  const images=[];
  [pick(p, ['image','image_url','thumbnail','featured_image','main_image','cover'])].concat(Array.isArray(p.images)?p.images:Array.isArray(p.gallery)?p.gallery:Array.isArray(p.photos)?p.photos:[])
    .forEach(v=>{ const u=mediaUrl(v); if(u&&!images.includes(u)) images.push(u); });
  let link=mediaUrl(pick(p, ['url','permalink','link','product_url','web_url']));
  if(!link&&baseUrl&&pick(p, ['slug','handle'])){
    try{ link=`${new URL(baseUrl).origin}/products/${encodeURIComponent(pick(p, ['slug','handle']))}`; }catch(e){}
  }
  const colors=uniq(variants.map(variantColor).concat((Array.isArray(p.colors)?p.colors:Array.isArray(p.colours)?p.colours:[]).map(c=>txt(c, 60))));
  const sizes=uniq(variants.map(variantSize).concat((Array.isArray(p.sizes)?p.sizes:[]).map(s=>txt(s, 40))));
  const optional={
    description:shopifyHtmlToText(pick(p, ['description','body_html','details','short_description'])||'').slice(0, 3000),
    category:wsProductCategories(p)[0]||'', brand:txt(pick(p, ['brand','vendor','manufacturer']), 120),
    color:typeof p.color==='string'?p.color:colors.join(', '), size:typeof p.size==='string'?p.size:sizes.join(', '),
    variant:variants.length>1?uniq(variants.map(v=>txt(pick(v, ['title','name'])??[variantColor(v), variantSize(v)].filter(Boolean).join(' / '), 80))).join(', ').slice(0, 500):'',
    product_link:active?link:'',
    image_url:images[0], image_url_2:images[1], image_url_3:images[2], image_url_4:images[3], image_url_5:images[4],
  };
  Object.entries(optional).forEach(([k, v])=>{ if(v) f[k]=v; });
  f._currency=txt(pick(p, ['currency','currency_code']), 8)||currency;
  return f;
}

// Matches website products to the client's Ecom products. Returns rows to create, rows to update
// and Ecom Ids to delete (products deleted on the website, or — on a full sync with deleteMissing —
// linked products the website no longer returns).
export function wsProductPlan(existing, products, {baseUrl='', currency='', replaceAll=false, deleteMissing=true, deletedIds=[]}={}){
  const byExt=new Map(), bySku=new Map(), byName=new Map();
  (existing||[]).forEach(e=>{
    if(e.website_product_id){ byExt.set(String(e.website_product_id), e); return; }
    if(e.shopify_product_id) return; // Shopify owns those
    const s=key(e.sku); if(s&&!bySku.has(s)) bySku.set(s, e);
    const n=key(e.name); if(n&&!byName.has(n)) byName.set(n, e);
  });
  const creates=[], updates=[], deletes=new Set(), seen=new Set(), gone=new Set((deletedIds||[]).map(String));
  (products||[]).forEach(p=>{
    if(wsIsDeleted(p)){ const id=wsExternalId(p); if(id) gone.add(id); return; }
    const fields=wsProductFields(p, {baseUrl, currency});
    if(!fields) return;
    const cur=fields._currency; delete fields._currency;
    let e=byExt.get(fields.website_product_id);
    if(!e){
      const cands=[bySku.get(key(fields.sku)), ...variantList(p).map(v=>bySku.get(key(pick(v, ['sku','code'])))), byName.get(key(fields.name))];
      e=cands.find(m=>m&&!seen.has(m.Id));
    }
    if(e){
      seen.add(e.Id);
      if(Object.keys(fields).some(k=>!sameValue(e[k], fields[k]))) updates.push({Id:e.Id, ...fields});
    }else if(fields.status==='active'&&!creates.some(c=>c.website_product_id===fields.website_product_id)){
      creates.push(cur?{...fields, currency:cur}:fields);
    }
  });
  (existing||[]).forEach(e=>{
    if(!e.website_product_id||seen.has(e.Id)) return;
    if(gone.has(String(e.website_product_id))||(replaceAll&&deleteMissing)) deletes.add(e.Id);
  });
  return {creates, updates, deletes:[...deletes]};
}

// ── Orders ───────────────────────────────────────────────────────────────────────────────────────
function personName(o){
  if(!o) return '';
  if(typeof o==='string') return o.trim();
  return txt(pick(o, ['name','full_name','fullName']), 120)||[o.first_name, o.last_name].filter(Boolean).join(' ').trim();
}
function orderItems(o){
  const list=pick(o, ['items','line_items','lines','products','order_items']);
  return (Array.isArray(list)?list:[]).filter(isObj).map(li=>{
    const qty=intOrNull(pick(li, ['quantity','qty','count']))??1;
    const unit=wsMoney(pick(li, ['price','unit_price','sale_price','rate']));
    const lineTotal=wsMoney(pick(li, ['total','line_total','subtotal','amount']));
    const opts=[txt(pick(li, ['color','colour']), 40), txt(pick(li, ['size']), 30), txt(pick(li, ['variant','variant_title','variant_name']), 60)].filter(Boolean);
    return {
      title:txt(pick(li, ['name','title','product_name','product_title']), 200)||txt(pick(li?.product, ['name','title']), 200)||'Item',
      quantity:qty, price:unit??(lineTotal!=null&&qty?lineTotal/qty:0), sku:txt(pick(li, ['sku','code']), 120),
      options:opts.join(' / '), cancelled:!!(li.cancelled||li.is_cancelled||/cancel/i.test(String(li.status||''))),
    };
  });
}
// Website order → Ecom Orders status (received/processing/shipped/delivered/cancelled).
export function wsOrderStatus(o){
  const s=key(pick(o, ['status','order_status','state']));
  const pay=key(pick(o, ['payment_status','financial_status','payment_state']));
  const ful=key(pick(o, ['fulfillment_status','fulfilment_status','shipping_status','delivery_status']));
  const items=orderItems(o);
  if(o?.cancelled_at||/cancel|void|refunded|returned|rejected|failed/.test(s)||/refunded|voided/.test(pay)||(items.length&&items.every(i=>i.cancelled))) return 'cancelled';
  if(/deliver|complete|closed|collected|picked_up/.test(s)||/deliver/.test(ful)) return 'delivered';
  if(/ship|dispatch|transit|out_for|fulfilled|sent/.test(s)||/ship|dispatch|transit|fulfilled|partial/.test(ful)||pick(o, ['tracking_number','tracking_url'])) return 'shipped';
  if(/process|prepar|pack|confirm|paid|accepted|ready/.test(s)||/^paid|partially_paid|captured|success/.test(pay)) return 'processing';
  if(/pending|draft|new|unpaid|await/.test(s)) return 'pending';
  return 'received';
}
function addressText(a){
  if(!a) return '';
  if(typeof a==='string') return a.trim().slice(0, 500);
  return [pick(a, ['address1','line1','street','address','building']), pick(a, ['address2','line2','area','zone']), pick(a, ['city','town']), pick(a, ['country'])]
    .map(v=>txt(v, 120)).filter(Boolean).join(', ');
}
export function wsOrderFields(clientId, o, status){
  const id=wsExternalId(o);
  const cust=isObj(o?.customer)?o.customer:{};
  const ship=pick(o, ['shipping_address','delivery_address','address','shipping'])||'';
  const items=orderItems(o);
  const active=items.filter(i=>!i.cancelled);
  const number=txt(pick(o, ['order_number','number','reference','order_no','name','code']), 60);
  const total=wsMoney(pick(o, ['total','grand_total','total_amount','total_price','amount']));
  return {
    client_id:String(clientId), website_order_id:id, status:status||wsOrderStatus(o),
    order_id:number?(/^[#A-Za-z]/.test(number)?number:'#'+number):'#'+id,
    customer_name:personName(cust)||txt(pick(o, ['customer_name','name_on_order']), 120)||personName(isObj(ship)?ship:null),
    customer_phone:String(pick(cust, ['phone','mobile','whatsapp'])??pick(o, ['customer_phone','phone','mobile'])??(isObj(ship)?pick(ship, ['phone','mobile']):'')??'').replace(/[^0-9+]/g, ''),
    customer_email:txt(pick(cust, ['email'])??pick(o, ['customer_email','email']), 200),
    order_date:String(pick(o, ['created_at','date','order_date','placed_at'])||'').slice(0, 10),
    items:(active.length?active:items).map(i=>`${i.quantity}x ${i.title}${i.options?` (${i.options})`:''}`).join(', ').slice(0, 2000),
    line_items_json:JSON.stringify(items.map(({title, quantity, price, sku, cancelled})=>({title, quantity, price, sku, ...(cancelled?{cancelled:true}:{})}))),
    total:total??active.reduce((s, i)=>s+i.price*i.quantity, 0),
    currency:txt(pick(o, ['currency','currency_code']), 8),
    delivery_address:addressText(ship),
  };
}
// Creates/updates for Ecom Orders; only orders that changed are written. A sync never moves an
// order's status backwards (staff may have moved it on by hand); cancelled always wins.
export function wsOrderPlan(clientId, existing, orders, {status='', currency=''}={}){
  const byExt=new Map(), byNumber=new Map();
  (existing||[]).forEach(e=>{
    if(e.website_order_id) byExt.set(String(e.website_order_id), e);
    else if(e.order_id&&!e.shopify_order_id&&!byNumber.has(key(e.order_id))) byNumber.set(key(e.order_id), e);
  });
  const creates=[], updates=[];
  (orders||[]).filter(o=>wsExternalId(o)).forEach(o=>{
    const fields=wsOrderFields(clientId, o, status);
    if(!fields.currency) fields.currency=currency;
    let e=byExt.get(fields.website_order_id);
    if(!e){ e=byNumber.get(key(fields.order_id))||byNumber.get(key(fields.order_id.replace(/^#/, ''))); if(e) byNumber.delete(key(e.order_id)); }
    if(!e){ creates.push(fields); byExt.set(fields.website_order_id, fields); return; }
    fields.status=shopifyEcomNextStatus(e.status, fields.status);
    // The same order twice in one batch (it changed while we paged): the later copy wins.
    if(!e.Id){ Object.assign(e, fields); return; }
    byExt.set(fields.website_order_id, {...e, ...fields});
    if(Object.keys(fields).some(k=>!sameValue(e[k], fields[k]))){
      const i=updates.findIndex(u=>u.Id===e.Id);
      if(i>=0) updates[i]={Id:e.Id, ...fields}; else updates.push({Id:e.Id, ...fields});
    }
  });
  return {creates, updates};
}
export function wsOrderUpdatedAt(o){ return String(pick(o, ['updated_at','updatedAt','modified_at','created_at'])||''); }

// ── Inventory (GET /inventory: one row per size/colour) ───────────────────────────────────────────
// → Map(product external id → total stock).
export function wsInventoryTotals(rows){
  const out=new Map();
  (rows||[]).filter(isObj).forEach(r=>{
    const pid=idStr(pick(r, ['product_id','productId','item_id'])??pick(r?.product, ['id']));
    const q=intOrNull(pick(r, ['stock','quantity','qty','available','on_hand']));
    if(!pid||q==null) return;
    out.set(pid, (out.get(pid)||0)+Math.max(0, q));
  });
  return out;
}

// ── Webhook signature ────────────────────────────────────────────────────────────────────────────
function headerEndingWith(headers, suffix){
  for(const [k, v] of headers.entries()) if(k.toLowerCase().endsWith(suffix)) return v;
  return '';
}
const hex=buf=>[...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2, '0')).join('');
export async function wsHmacHex(secret, message){
  const k=await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message)));
}
function safeEqual(a, b){
  if(a.length!==b.length) return false;
  let d=0; for(let i=0;i<a.length;i++) d|=a.charCodeAt(i)^b.charCodeAt(i);
  return d===0;
}
// '' when valid, else the reason. Timestamp may be unix seconds, ms or ISO.
export async function wsVerifySignature(secret, headers, body, nowMs=Date.now()){
  const sig=headerEndingWith(headers, '-signature')||headers.get('x-signature')||'';
  const ts=headerEndingWith(headers, '-timestamp')||'';
  if(!sig||!ts) return 'missing signature headers';
  let t=Number(ts);
  if(!Number.isFinite(t)) t=Date.parse(ts)/1000; else if(t>1e12) t=t/1000;
  if(!Number.isFinite(t)||Math.abs(nowMs/1000-t)>SIGNATURE_MAX_AGE_S) return 'timestamp too old';
  const want=await wsHmacHex(secret, `${ts}.${body}`);
  const got=String(sig).trim().replace(/^sha256=/i, '').toLowerCase();
  return safeEqual(got, want)?'':'bad signature';
}

// ── Website API ──────────────────────────────────────────────────────────────────────────────────
export function wsAuthHeaders(style, apiKey){
  const k=String(apiKey||'').trim();
  if(!k) return {};
  return style==='x-api-key'?{'X-API-Key':k}:{Authorization:`Bearer ${k}`};
}
function paths(cfg){
  let p={}; try{ p=JSON.parse(cfg.paths_json||'{}')||{}; }catch(e){}
  return {...WS_DEFAULT_PATHS, ...Object.fromEntries(Object.entries(p).filter(([, v])=>typeof v==='string'&&v.startsWith('/')))};
}
export function wsApiUrl(base, path, params){
  const u=new URL(String(base).replace(/\/+$/, '')+path);
  Object.entries(params||{}).forEach(([k, v])=>{ if(v!==undefined&&v!==null&&v!=='') u.searchParams.set(k, String(v)); });
  return u.toString();
}
// Redirects are followed by hand and only within the same origin, so the key never leaves it.
async function getJson(deps, url, headers){
  const f=deps.fetch||fetch;
  let r;
  for(let hop=0;;hop++){
    try{ r=await f(url, {headers:{Accept:'application/json', 'User-Agent':'Leadvyne-Website-Sync/1.0', ...headers}, redirect:'manual', signal:AbortSignal.timeout?.(FETCH_TIMEOUT_MS)}); }
    catch(e){ throw new Error(`Couldn't reach the website (${e?.name==='TimeoutError'?'timed out':e?.message||'network error'})`); }
    if(r.status<300||r.status>=400) break;
    let next=null;
    try{ next=r.headers.get('location')?new URL(r.headers.get('location'), url):null; }catch(e){}
    if(!next||next.origin!==new URL(url).origin||hop>=3) throw new Error(`The website redirected (HTTP ${r.status}) — check the API base URL`);
    url=next.toString();
  }
  if(r.status===401||r.status===403) throw new Error(`The website refused the API key (HTTP ${r.status})`);
  if(r.status===404) return {notFound:true};
  if(r.status===429) throw new Error('The website is rate-limiting us (HTTP 429) — try a longer sync interval');
  if(!r.ok) throw new Error(`The website returned HTTP ${r.status}`);
  const body=await r.text();
  if(body.length>MAX_BODY_BYTES) throw new Error('The website response is too large');
  try{ return {body:JSON.parse(body)}; }catch(e){ throw new Error('The website did not return JSON — check the API base URL'); }
}
async function getPaged(deps, cfg, apiKey, path, params, maxPages){
  const headers=wsAuthHeaders(cfg.auth_style, apiKey);
  const origin=new URL(cfg.base_url).origin;
  const out=[], seenFirst=new Set();
  let url=wsApiUrl(cfg.base_url, path, {...params, limit:PAGE_LIMIT, page:1}), page=1, complete=true;
  for(;;){
    const res=await getJson(deps, url, headers);
    if(res.notFound) throw new Error(`${path} was not found on the website (HTTP 404)`);
    const list=wsExtractList(res.body);
    const firstId=list.length?wsExternalId(list[0]):'';
    if(page>1&&firstId&&seenFirst.has(firstId)) break; // API ignores ?page= — don't import page 1 twice
    if(firstId) seenFirst.add(firstId);
    out.push(...list);
    const info=hiPageInfo(res.body, page, list.length, PAGE_LIMIT);
    let more;
    if(info.next){ if(new URL(info.next).origin!==origin) break; url=info.next; more=true; }
    else{ more=typeof info.more==='boolean'?info.more&&list.length>0:list.length>=PAGE_LIMIT; url=wsApiUrl(cfg.base_url, path, {...params, limit:PAGE_LIMIT, page:page+1}); }
    if(!more) break;
    if(page>=maxPages){ complete=false; break; }
    page++;
  }
  return {items:out, complete};
}
async function getOne(deps, cfg, apiKey, path, id, kind){
  const res=await getJson(deps, wsApiUrl(cfg.base_url, `${path}/${encodeURIComponent(id)}`), wsAuthHeaders(cfg.auth_style, apiKey));
  return res.notFound?null:wsExtractOne(res.body, kind);
}

// ── Writes into the Ecom module ──────────────────────────────────────────────────────────────────
async function applyProducts(env, deps, cfg, products, opts){
  const cid=cfg.client_id;
  const tableId=await deps.ecomTable(env, cid, 'products');
  if(!tableId) return {created:0, updated:0, deleted:0};
  await deps.ensureProductFields(env, tableId);
  const single=!opts.replaceAll&&products.length+(opts.deletedIds||[]).length===1?(wsExternalId(products[0])||opts.deletedIds[0]):'';
  let existing=single?await deps.listRows(env, tableId, cid, `~and(website_product_id,eq,${safeWhere(single)})`):[];
  // First sight of a product (or a full sync) needs the whole catalogue to match SKUs/names.
  if(!existing.length&&products.length) existing=await deps.listRows(env, tableId, cid);
  const plan=wsProductPlan(existing, products, {baseUrl:cfg.base_url, currency:cfg.currency, deleteMissing:!!cfg.delete_missing, ...opts});
  const created=await deps.bulkWrite(env, tableId, 'POST', plan.creates.map(f=>({...f, client_id:String(cid), currency:f.currency||cfg.currency||''})));
  await deps.bulkWrite(env, tableId, 'PATCH', plan.updates);
  const byId=new Map(existing.map(e=>[e.Id, e]));
  const saved=[...plan.updates.map(u=>({...byId.get(u.Id), ...u})), ...plan.creates.map((f, i)=>({...f, Id:created?.[i]?.Id}))].filter(p=>p.Id);
  if(saved.length) await deps.productsSaved(env, cid, saved);
  if(plan.deletes.length){
    await deps.bulkWrite(env, tableId, 'DELETE', plan.deletes.map(Id=>({Id})));
    await deps.productsDeleted(env, cid, plan.deletes);
  }
  return {created:plan.creates.length, updated:plan.updates.length, deleted:plan.deletes.length};
}

async function applyOrders(env, deps, cfg, orders, status=''){
  const list=(orders||[]).filter(o=>wsExternalId(o));
  if(!list.length) return {created:0, updated:0};
  const cid=cfg.client_id;
  const tableId=await deps.ecomTable(env, cid, 'orders');
  if(!tableId) return {created:0, updated:0};
  await deps.ensureOrderFields(env, tableId);
  let existing=[];
  if(list.length===1){
    const f=wsOrderFields(cid, list[0]);
    existing=await deps.listRows(env, tableId, cid, `~and(website_order_id,eq,${safeWhere(f.website_order_id)})`);
    if(!existing.length) existing=await deps.listRows(env, tableId, cid, `~and(order_id,eq,${safeWhere(f.order_id)})`);
  }else existing=await deps.listRows(env, tableId, cid);
  const plan=wsOrderPlan(cid, existing, list, {status, currency:cfg.currency});
  await deps.bulkWrite(env, tableId, 'POST', plan.creates);
  await deps.bulkWrite(env, tableId, 'PATCH', plan.updates);
  return {created:plan.creates.length, updated:plan.updates.length};
}

async function deleteOrders(env, deps, cfg, externalIds){
  const cid=cfg.client_id;
  const tableId=await deps.ecomTable(env, cid, 'orders');
  if(!tableId) return 0;
  const ids=[];
  for(const ext of externalIds){
    const rows=await deps.listRows(env, tableId, cid, `~and(website_order_id,eq,${safeWhere(ext)})`, 'Id');
    rows.forEach(r=>ids.push(r.Id));
  }
  if(ids.length) await deps.bulkWrite(env, tableId, 'DELETE', ids.map(Id=>({Id})));
  return ids.length;
}

// Ensures every website category exists in Ecom → Categories (matched by name, case-insensitive).
// With full=true, categories this sync created that the website no longer has are deleted;
// categories made by hand are never touched.
export function wsCategoryPlan(existing, names, ownedIds, {full=false, deleteMissing=true}={}){
  const byName=new Map((existing||[]).map(c=>[key(c.name), c]));
  const want=new Map(); (names||[]).forEach(n=>{ const k=key(n); if(k&&!want.has(k)) want.set(k, n.trim().slice(0, 80)); });
  const create=[...want.entries()].filter(([k])=>!byName.has(k)).map(([, n])=>n);
  const owned=new Set((ownedIds||[]).map(Number));
  const remove=full&&deleteMissing?(existing||[]).filter(c=>owned.has(Number(c.id))&&!want.has(key(c.name))).map(c=>Number(c.id)):[];
  return {create, remove};
}
async function applyCategories(env, deps, cfg, names, {full=false}={}){
  let owned=[]; try{ owned=JSON.parse(cfg.category_ids_json||'[]'); }catch(e){}
  const existing=await deps.listCategories(env, cfg.client_id);
  const plan=wsCategoryPlan(existing, names, owned, {full, deleteMissing:!!cfg.delete_missing});
  const ownedSet=new Set(owned.map(Number));
  for(const name of plan.create){ const id=await deps.createCategory(env, cfg.client_id, name); if(id) ownedSet.add(Number(id)); }
  for(const id of plan.remove){ await deps.deleteCategory(env, cfg.client_id, id); ownedSet.delete(id); }
  if(plan.create.length||plan.remove.length){
    cfg.category_ids_json=JSON.stringify([...ownedSet]);
    await run(env, `UPDATE ecom_website_sync SET category_ids_json=? WHERE client_id=?`, cfg.category_ids_json, cfg.client_id);
  }
  return {created:plan.create.length, deleted:plan.remove.length};
}

// ── Full / scheduled sync ────────────────────────────────────────────────────────────────────────
export function wsSummaryText(c){
  const parts=[];
  const add=(n, label)=>{ if(n) parts.push(`${n} ${label}`); };
  add(c.products_created, 'products added'); add(c.products_updated, 'products updated'); add(c.products_deleted, 'products deleted');
  add(c.categories_created, 'categories added'); add(c.categories_deleted, 'categories deleted');
  add(c.orders_created, 'orders added'); add(c.orders_updated, 'orders updated'); add(c.orders_deleted, 'orders deleted');
  if(c.note) parts.push(c.note);
  return parts.length?parts.join(' · '):'Everything already up to date';
}

export async function wsSync(env, deps, cfg, {full=true}={}){
  const startedAt=nowIso(deps);
  await run(env, `UPDATE ecom_website_sync SET last_status='running', last_sync_at=? WHERE client_id=?`, startedAt, cfg.client_id);
  const counts={};
  try{
    const apiKey=cfg.api_key_enc?await deps.decrypt(env, cfg.api_key_enc):'';
    if(cfg.api_key_enc&&!apiKey) throw new Error('The saved API key can\'t be read — paste it again');
    const p=paths(cfg);
    if(full&&(cfg.sync_products||cfg.sync_categories)){
      const {items, complete}=await getPaged(deps, cfg, apiKey, p.products, {}, MAX_PRODUCT_PAGES);
      // Stock from /inventory when the product list itself carries none.
      if(items.length&&items.every(x=>wsProductFields(x)?.stock==null)){
        const inv=await getPaged(deps, cfg, apiKey, p.inventory, {}, MAX_PRODUCT_PAGES).catch(()=>null);
        const totals=wsInventoryTotals(inv?.items);
        if(totals.size) items.forEach(x=>{ const t=totals.get(wsExternalId(x)); if(t!=null) x.stock=t; });
      }
      // Deleting on a partial or empty read would wipe a catalogue over an API hiccup.
      const replaceAll=complete&&items.length>0;
      if(!complete) counts.note='catalogue too large to read in one go — nothing was deleted';
      if(cfg.sync_categories){
        const names=uniq(items.filter(x=>!wsIsDeleted(x)).flatMap(wsProductCategories));
        const c=await applyCategories(env, deps, cfg, names, {full:replaceAll});
        counts.categories_created=c.created; counts.categories_deleted=c.deleted;
      }
      if(cfg.sync_products){
        const r=await applyProducts(env, deps, cfg, items, {replaceAll});
        counts.products_created=r.created; counts.products_updated=r.updated; counts.products_deleted=r.deleted;
      }
    }
    if(cfg.sync_orders){
      const since=cfg.orders_cursor||new Date((deps.now?.()??Date.now())-FIRST_ORDER_DAYS*86400000).toISOString();
      const {items}=await getPaged(deps, cfg, apiKey, p.orders, {updated_since:since}, MAX_ORDER_PAGES);
      // The list may be a summary — read each order in full when it has no items.
      const fullOrders=[];
      let fetched=0;
      for(const o of items){
        if(!wsIsDeleted(o)&&!orderItems(o).length&&fetched<60){ fetched++; fullOrders.push((await getOne(deps, cfg, apiKey, p.orders, wsExternalId(o), 'order').catch(()=>null))||o); }
        else fullOrders.push(o);
      }
      const gone=fullOrders.filter(wsIsDeleted).map(wsExternalId).filter(Boolean);
      const r=await applyOrders(env, deps, cfg, fullOrders.filter(o=>!wsIsDeleted(o)));
      if(gone.length) counts.orders_deleted=await deleteOrders(env, deps, cfg, gone);
      counts.orders_created=r.created; counts.orders_updated=r.updated;
      const newest=items.map(wsOrderUpdatedAt).filter(s=>Number.isFinite(Date.parse(s))).sort((a, b)=>Date.parse(a)-Date.parse(b)).pop();
      if(newest&&Date.parse(newest)>Date.parse(since)) cfg.orders_cursor=newest;
    }
    const summary=wsSummaryText(counts);
    await run(env, `UPDATE ecom_website_sync SET last_status='ok', last_error='', last_summary=?, orders_cursor=?, last_sync_at=? WHERE client_id=?`, summary, cfg.orders_cursor||'', startedAt, cfg.client_id);
    return {ok:true, summary, ...counts};
  }catch(e){
    const msg=String(e?.message||e).slice(0, 400);
    await run(env, `UPDATE ecom_website_sync SET last_status='error', last_error=? WHERE client_id=?`, msg, cfg.client_id).catch(()=>{});
    return {ok:false, error:msg};
  }
}

export function wsDue(cfg, nowMs){
  if(!Number(cfg.enabled)) return false;
  const last=Date.parse(cfg.last_sync_at||'');
  if(cfg.last_status==='running'&&Number.isFinite(last)&&nowMs-last<RUNNING_STALE_MS) return false;
  if(!Number.isFinite(last)) return true;
  return nowMs-last>=Number(cfg.sync_minutes||60)*60000-60000;
}
// 15-minute cron: a few due stores per tick, oldest first. Also prunes old webhook event ids.
export async function wsRunDue(env, deps, nowMs=Date.now()){
  if(!env.DB) return;
  await wsEnsureSchema(env);
  const rows=await all(env, `SELECT * FROM ecom_website_sync WHERE enabled=1 ORDER BY COALESCE(last_sync_at,'') ASC LIMIT 50`);
  for(const cfg of rows.filter(r=>wsDue(r, nowMs)).slice(0, CONFIGS_PER_TICK)){
    const r=await wsSync(env, deps, cfg);
    if(!r.ok) await deps.reportOpsError(env, 'website sync', new Error(r.error), {clientId:cfg.client_id});
  }
  await run(env, `DELETE FROM ecom_website_sync_events WHERE created_at<?`, new Date(nowMs-7*86400000).toISOString()).catch(()=>{});
}

// ── Webhook ──────────────────────────────────────────────────────────────────────────────────────
export async function wsHandleWebhookEvent(env, deps, cfg, evt){
  const event=String(evt?.event||evt?.type||evt?.topic||'').toLowerCase();
  const data=isObj(evt?.data)?evt.data:(isObj(evt?.payload)?evt.payload:{});
  const apiKey=cfg.api_key_enc?await deps.decrypt(env, cfg.api_key_enc):'';
  const p=paths(cfg);
  const out={event};
  if(event.startsWith('order.')){
    if(!cfg.sync_orders) return {...out, skipped:'orders sync is off'};
    const order=isObj(data.order)?data.order:data;
    const id=wsExternalId(order);
    if(!id) return {...out, skipped:'no order id'};
    if(event==='order.deleted'){ out.deleted=await deleteOrders(env, deps, cfg, [id]); return out; }
    let full=order;
    if(!orderItems(order).length||event==='order.cancelled') full=(await getOne(deps, cfg, apiKey, p.orders, id, 'order').catch(()=>null))||order;
    if(wsIsDeleted(full)){ out.deleted=await deleteOrders(env, deps, cfg, [id]); return out; }
    // An order.cancelled for the whole order with no status of its own still reads as cancelled.
    const hasStatus=pick(full, ['status','order_status','state']);
    Object.assign(out, await applyOrders(env, deps, cfg, [full], event==='order.cancelled'&&!hasStatus&&!orderItems(full).some(i=>!i.cancelled)?'cancelled':''));
    return out;
  }
  if(event.startsWith('product.')){
    const prod=isObj(data.product)?data.product:data;
    const id=wsExternalId(prod);
    if(!id) return {...out, skipped:'no product id'};
    if(event==='product.deleted'){
      if(cfg.sync_products) Object.assign(out, await applyProducts(env, deps, cfg, [], {deletedIds:[id]}));
      return out;
    }
    let full=prod;
    if(!pick(prod, ['name','title','product_name'])||pick(prod, ['price','sale_price','stock','quantity'])===undefined) full=(await getOne(deps, cfg, apiKey, p.products, id, 'product').catch(()=>null))||prod;
    if(cfg.sync_categories){ const c=await applyCategories(env, deps, cfg, wsProductCategories(full)); out.categories_created=c.created; }
    if(cfg.sync_products) Object.assign(out, await applyProducts(env, deps, cfg, [full], {deletedIds:wsIsDeleted(full)?[id]:[]}));
    return out;
  }
  if(event.startsWith('inventory.')||event.startsWith('stock.')){
    if(!cfg.sync_products) return {...out, skipped:'products sync is off'};
    const rows=wsExtractList(data).length?wsExtractList(data):[data];
    const pids=uniq(rows.map(r=>idStr(pick(r, ['product_id','productId'])??pick(r?.product, ['id'])))).slice(0, 20);
    if(!pids.length){ const r=await wsSync(env, deps, {...cfg, sync_orders:0, sync_categories:0}); return {...out, ...r}; }
    const products=[];
    for(const id of pids){ const prod=await getOne(deps, cfg, apiKey, p.products, id, 'product').catch(()=>null); if(prod) products.push(prod); }
    if(products.some(x=>wsProductFields(x)?.stock==null)){
      const inv=await getPaged(deps, cfg, apiKey, p.inventory, {}, MAX_PRODUCT_PAGES).catch(()=>null);
      const totals=wsInventoryTotals(inv?.items);
      products.forEach(x=>{ const t=totals.get(wsExternalId(x)); if(t!=null) x.stock=t; });
    }
    let created=0, updated=0;
    for(const prod of products){ const r=await applyProducts(env, deps, cfg, [prod], {}); created+=r.created; updated+=r.updated; }
    return {...out, created, updated};
  }
  return {...out, skipped:'event not handled'};
}

async function handleWebhook(request, env, deps, token){
  if(!token||token.length<20) return deps.json({error:'Not found'}, 404);
  const cfg=await first(env, `SELECT * FROM ecom_website_sync WHERE webhook_token=?`, token);
  if(!cfg) return deps.json({error:'Not found'}, 404);
  const body=await request.text();
  if(body.length>MAX_BODY_BYTES) return deps.json({error:'Too large'}, 413);
  if(cfg.webhook_secret_enc){
    const secret=await deps.decrypt(env, cfg.webhook_secret_enc);
    const bad=secret?await wsVerifySignature(secret, request.headers, body, deps.now?.()??Date.now()):'secret unreadable';
    if(bad) return deps.json({error:'Invalid signature: '+bad}, 401);
  }
  let evt; try{ evt=JSON.parse(body); }catch(e){ return deps.json({error:'Body must be JSON'}, 400); }
  if(!evt.event) evt.event=headerEndingWith(request.headers, '-event');
  if(!Number(cfg.enabled)) return deps.json({ok:true, skipped:'sync is paused'});
  const eventId=idStr(evt.id);
  if(eventId){
    const ins=await run(env, `INSERT OR IGNORE INTO ecom_website_sync_events (client_id, event_id, created_at) VALUES (?,?,?)`, cfg.client_id, eventId.slice(0, 120), nowIso(deps));
    if(!ins.meta?.changes) return deps.json({ok:true, duplicate:true});
  }
  await run(env, `UPDATE ecom_website_sync SET last_webhook_at=?, last_webhook_event=? WHERE client_id=?`, nowIso(deps), String(evt.event||'').slice(0, 60), cfg.client_id);
  try{
    const result=await wsHandleWebhookEvent(env, deps, cfg, evt);
    return deps.json({ok:true, ...result});
  }catch(e){
    // Let the website retry: forget the event id so the retry isn't treated as a duplicate.
    if(eventId) await run(env, `DELETE FROM ecom_website_sync_events WHERE client_id=? AND event_id=?`, cfg.client_id, eventId.slice(0, 120)).catch(()=>{});
    await deps.reportOpsError(env, `website webhook ${evt.event}`, e, {clientId:cfg.client_id});
    return deps.json({error:'Sync failed: '+String(e?.message||e).slice(0, 200)}, 500);
  }
}

// ── Settings routes (session-gated; the key and secret never leave the Worker) ───────────────────
function randomToken(){
  const b=crypto.getRandomValues(new Uint8Array(24));
  return [...b].map(x=>x.toString(16).padStart(2, '0')).join('');
}
function publicConfig(env, deps, cfg){
  if(!cfg) return {connected:false};
  let p={}; try{ p=JSON.parse(cfg.paths_json||'{}')||{}; }catch(e){}
  return {
    connected:true, name:cfg.name, base_url:cfg.base_url, auth_style:cfg.auth_style, key_hint:cfg.key_hint,
    has_secret:!!cfg.webhook_secret_enc, currency:cfg.currency, paths:{...WS_DEFAULT_PATHS, ...p},
    sync_products:!!cfg.sync_products, sync_orders:!!cfg.sync_orders, sync_categories:!!cfg.sync_categories,
    delete_missing:!!cfg.delete_missing, enabled:!!cfg.enabled, sync_minutes:cfg.sync_minutes,
    webhook_url:`${deps.webhookBase(env)}/ecom/website/hook/${cfg.webhook_token}`,
    last_sync_at:cfg.last_sync_at||'', last_status:cfg.last_status, last_error:cfg.last_error, last_summary:cfg.last_summary,
    last_webhook_at:cfg.last_webhook_at||'', last_webhook_event:cfg.last_webhook_event||'', orders_cursor:cfg.orders_cursor||'',
  };
}
const bool=(v, dflt)=>v===undefined?dflt:(v===true||v===1||v==='1'||v==='true')?1:0;
function cleanInput(body, cur){
  const v={};
  if(!cur||'base_url' in body){
    const u=String(body.base_url||'').trim().replace(/\/+$/, '');
    const err=hiUrlError(u);
    if(err) return {error:err.replace('API link', 'API base URL')};
    v.base_url=u;
  }
  if('name' in body) v.name=String(body.name||'').trim().slice(0, 80);
  if('auth_style' in body) v.auth_style=WS_AUTH_STYLES.includes(body.auth_style)?body.auth_style:'bearer';
  if('currency' in body) v.currency=String(body.currency||'').trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
  if('sync_minutes' in body) v.sync_minutes=WS_SYNC_MINUTES.includes(Number(body.sync_minutes))?Number(body.sync_minutes):60;
  for(const k of ['sync_products','sync_orders','sync_categories','delete_missing','enabled']) if(k in body) v[k]=bool(body[k], 1);
  if(isObj(body.paths)){
    const p={};
    Object.keys(WS_DEFAULT_PATHS).forEach(k=>{ const s=String(body.paths[k]||'').trim(); if(s&&s!==WS_DEFAULT_PATHS[k]){ if(!/^\/[\w\-./{}]*$/.test(s)) return; p[k]=s; } });
    v.paths_json=JSON.stringify(p);
  }
  return {values:v};
}

async function testConnection(deps, cfg, apiKey){
  const p=paths(cfg);
  const headers=wsAuthHeaders(cfg.auth_style, apiKey);
  const ping=await getJson(deps, wsApiUrl(cfg.base_url, p.ping), headers).catch(e=>({error:e.message}));
  if(ping.error) return {ok:false, error:ping.error};
  const prod=await getJson(deps, wsApiUrl(cfg.base_url, p.products, {limit:5, page:1}), headers).catch(e=>({error:e.message}));
  if(prod.error) return {ok:false, error:prod.error};
  if(prod.notFound) return {ok:false, error:`${p.products} was not found on the website — check the API base URL`};
  const list=wsExtractList(prod.body);
  const sample=list.map(x=>wsProductFields(x, {baseUrl:cfg.base_url, currency:cfg.currency})).filter(Boolean)
    .map(f=>({name:f.name, sku:f.sku, price:f.price, stock:f.stock, category:f.category||'', status:f.status}));
  const ord=await getJson(deps, wsApiUrl(cfg.base_url, p.orders, {limit:1, page:1, updated_since:new Date(Date.now()-FIRST_ORDER_DAYS*86400000).toISOString()}), headers).catch(e=>({error:e.message}));
  return {ok:true, ping:!ping.notFound, products_sample:sample, orders_ok:!ord.error&&!ord.notFound, orders_error:ord.error||(ord.notFound?`${p.orders} not found`:'')};
}

export async function wsHandleRoute(request, env, deps, url){
  const path=url.pathname.replace(/^\/ecom\/website/, '');
  const method=request.method;
  if(!env.DB) return deps.json({error:'Database not configured'}, 500);
  await wsEnsureSchema(env);
  const hook=path.match(/^\/hook\/([A-Za-z0-9]+)$/);
  if(hook&&method==='POST') return handleWebhook(request, env, deps, hook[1]);

  const payload=await deps.requireSession(request, env);
  if(!payload) return deps.json({error:'Sign in again (open Ecommerce from the dashboard) to manage Website Sync'}, 401);
  const cid=Number(payload.cid);
  const want=url.searchParams.get('client_id');
  if(want&&String(want)!==String(cid)) return deps.json({error:'Forbidden'}, 403);
  const body=method==='GET'?{}:await request.json().catch(()=>({}));
  const load=()=>first(env, `SELECT * FROM ecom_website_sync WHERE client_id=?`, cid);
  const encryptOr=async plain=>{ try{ return await deps.encrypt(env, plain); }catch(e){ return null; } };

  if(path==='/status'&&method==='GET') return deps.json({...publicConfig(env, deps, await load()), sync_minutes_options:WS_SYNC_MINUTES});

  if(path==='/test'&&method==='POST'){
    const cur=await load();
    const {values, error}=cleanInput({...body, base_url:body.base_url??cur?.base_url}, null);
    if(error) return deps.json({ok:false, error}, 400);
    const cfg={paths_json:'{}', ...(cur||{}), ...values, auth_style:values.auth_style||cur?.auth_style||'bearer'};
    let apiKey=String(body.api_key||'').trim();
    if(!apiKey&&cur?.api_key_enc) apiKey=await deps.decrypt(env, cur.api_key_enc)||'';
    if(!apiKey) return deps.json({ok:false, error:'Paste the API key from your website'}, 400);
    return deps.json(await testConnection(deps, cfg, apiKey));
  }

  if(path==='/connect'&&method==='POST'){
    const cur=await load();
    const {values, error}=cleanInput(body, cur);
    if(error) return deps.json({error}, 400);
    const apiKey=String(body.api_key||'').trim();
    if(!cur&&!apiKey) return deps.json({error:'Paste the API key from your website'}, 400);
    if(apiKey){
      const enc=await encryptOr(apiKey);
      if(!enc) return deps.json({error:'API keys can\'t be stored on this server yet (encryption secret missing)'}, 500);
      values.api_key_enc=enc; values.key_hint=hiKeyHint(apiKey);
    }
    if('webhook_secret' in body){
      const s=String(body.webhook_secret||'').trim();
      if(s){ const enc=await encryptOr(s); if(!enc) return deps.json({error:'Secrets can\'t be stored on this server yet (encryption secret missing)'}, 500); values.webhook_secret_enc=enc; }
      else if(body.clear_secret) values.webhook_secret_enc='';
    }
    // Check the key works before saving it.
    const probe={...(cur||{auth_style:'bearer', paths_json:'{}'}), ...values};
    const key=apiKey||(cur?.api_key_enc?await deps.decrypt(env, cur.api_key_enc):'');
    const t=await testConnection(deps, probe, key);
    if(!t.ok) return deps.json({error:t.error}, 400);
    const ts=nowIso(deps);
    if(!cur){
      const cols={name:'', auth_style:'bearer', currency:'', paths_json:'{}', sync_products:1, sync_orders:1, sync_categories:1, delete_missing:1, enabled:1, sync_minutes:60, ...values};
      const names=Object.keys(cols);
      await run(env, `INSERT INTO ecom_website_sync (client_id, webhook_token, created_at, updated_at, ${names.join(', ')}) VALUES (?,?,?,?, ${names.map(()=>'?').join(', ')})`,
        cid, randomToken(), ts, ts, ...names.map(n=>cols[n]));
    }else{
      const names=Object.keys(values);
      if(values.base_url&&values.base_url!==cur.base_url){ names.push('orders_cursor'); values.orders_cursor=''; }
      if(names.length) await run(env, `UPDATE ecom_website_sync SET ${names.map(n=>`${n}=?`).join(', ')}, updated_at=? WHERE client_id=?`, ...names.map(n=>values[n]), ts, cid);
    }
    let result=null;
    if(body.sync_now!==false){ const cfg=await load(); if(Number(cfg.enabled)) result=await wsSync(env, deps, cfg); }
    return deps.json({ok:true, config:publicConfig(env, deps, await load()), result});
  }

  if(path==='/sync'&&method==='POST'){
    const cfg=await load();
    if(!cfg) return deps.json({error:'Connect your website first'}, 400);
    const last=Date.parse(cfg.last_sync_at||'');
    if(cfg.last_status==='running'&&Number.isFinite(last)&&Date.now()-last<RUNNING_STALE_MS) return deps.json({error:'A sync is already running — try again in a minute'}, 409);
    if(body.full_orders) cfg.orders_cursor='';
    const result=await wsSync(env, deps, cfg);
    return deps.json({...result, config:publicConfig(env, deps, await load())}, result.ok?200:502);
  }

  if(path==='/rotate-hook'&&method==='POST'){
    if(!await load()) return deps.json({error:'Connect your website first'}, 400);
    await run(env, `UPDATE ecom_website_sync SET webhook_token=?, updated_at=? WHERE client_id=?`, randomToken(), nowIso(deps), cid);
    return deps.json({ok:true, config:publicConfig(env, deps, await load())});
  }

  if(path==='/disconnect'&&method==='POST'){
    // Synced products/orders stay (now as ordinary items); only the connection is removed.
    await run(env, `DELETE FROM ecom_website_sync WHERE client_id=?`, cid);
    await run(env, `DELETE FROM ecom_website_sync_events WHERE client_id=?`, cid);
    return deps.json({ok:true, config:{connected:false}});
  }

  return deps.json({error:'Not found'}, 404);
}
