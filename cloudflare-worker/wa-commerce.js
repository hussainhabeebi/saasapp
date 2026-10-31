// ── WhatsApp Shop (Ecom → 🛍️ WhatsApp Shop) ──────────────────────────────────────────────────────
// Shopping inside WhatsApp, built on the client's own Ecom Products and Orders (which, for a
// Shopify-connected store, are the Shopify catalog and orders — see shopify-sync.js):
//   1. Catalog   — every active Ecom product is pushed to the client's Meta catalog (Commerce
//                  Manager) as one item, retailer_id `lv_<Ecom product Id>`, then the catalog is
//                  linked to the WhatsApp number with the cart switched on.
//   2. Browse    — the AI assistant answers "show me your collection / catalogue" with a WhatsApp
//                  multi-product message (tap a product → photos, price, Add to cart), grouped by
//                  category; staff can also send it from Ecom.
//   3. Cart      — a customer's "Place order" arrives as a WhatsApp `order` message. Chatwoot (the
//                  inbox every other message goes through) drops that payload's content — the same
//                  Chatwoot gap the Native Forms module works around (chatwoot/chatwoot#13970) — so
//                  carts need the relay below. The cart becomes an Ecom order (status pending),
//                  or, for a Shopify store set to "Shopify checkout", a Shopify cart link.
//   4. Pay       — Cash on delivery, WhatsApp Pay (India: an order_details "Review and pay" message
//                  through the Razorpay/PayU configuration set up in WhatsApp Manager — the payment
//                  status webhook marks the order paid), or the Shopify checkout link.
// Relay: Meta lets a WABA override its webhook URL for this app (POST /{waba}/subscribed_apps with
// override_callback_uri). With carts on, this number's webhooks come to /wa/shop/webhook/<client>,
// which forwards every request byte-for-byte to the client's Chatwoot WhatsApp webhook FIRST (so the
// inbox, bot and agents keep working exactly as before) and only then reads `order` messages and
// payment statuses. A failed forward answers 502 so Meta retries; cart processing is idempotent on
// the WhatsApp message id. Turning carts off removes the override.
// Built from Meta's published Cloud API / Catalog Batch API docs and not verified against a live
// Meta account yet, same as Native Forms — check one real cart end to end before relying on it.
//
// This file imports nothing from worker.js; worker.js passes helpers in as `deps`
// (WA_SHOP_DEPS): { json, requireSession, getClientById, ncFetch, patchClientFields,
//   ensureClientColumns, ecomResolveTable, ecomListClientRows, ecomListActiveProducts,
//   ensureEcomOrderFields(env, tableId), resolveMetaCredentials, verifyMetaWebhookSignature,
//   hmacSignB64, shopifyFetch, resolveImageUrl, reportOpsError, sendChatwootNote(env, c, convId, text) }

export const WA_SHOP_GRAPH='https://graph.facebook.com/v21.0';
export const WA_SHOP_CONFIG_FIELD='wa_shop_config';
export const WA_SHOP_TOKEN_FIELD='wa_shop_catalog_token';
export const WA_SHOP_TAKEN_BY='whatsapp_cart';
export const WA_SHOP_PAYMENT_MODES=['cod','whatsapp_pay','shopify_checkout'];
export const WA_SHOP_GATEWAYS=['razorpay','payu','billdesk','zaakpay'];
const RID_PREFIX='lv_';

const num=v=>{ const n=Number(v); return Number.isFinite(n)?n:0; };
const digits=v=>String(v||'').replace(/\D/g,'');

export function waShopConfig(c){
  let cfg={}; try{ cfg=JSON.parse(c?.[WA_SHOP_CONFIG_FIELD]||'{}')||{}; }catch(e){}
  return {
    catalog_id:String(cfg.catalog_id||''), inbox_id:String(cfg.inbox_id||''),
    send_in_chat:cfg.send_in_chat!==false, carts:cfg.carts===true,
    payment_mode:WA_SHOP_PAYMENT_MODES.includes(cfg.payment_mode)?cfg.payment_mode:'cod',
    gateway:WA_SHOP_GATEWAYS.includes(cfg.gateway)?cfg.gateway:'razorpay',
    payment_config:String(cfg.payment_config||''), chatwoot_webhook_url:String(cfg.chatwoot_webhook_url||''),
    linked_at:cfg.linked_at||'', synced_at:cfg.synced_at||'', synced_count:num(cfg.synced_count), skipped:Array.isArray(cfg.skipped)?cfg.skipped:[],
    // The catalog as Meta reports it (refreshed on Link and daily) — a catalog whose products were
    // added in Commerce Manager itself, not by Leadvyne's sync, is used as it is.
    catalog_name:String(cfg.catalog_name||''), catalog_count:cfg.catalog_count===undefined||cfg.catalog_count===null?null:num(cfg.catalog_count),
    meta_items:Array.isArray(cfg.meta_items)?cfg.meta_items:[], meta_items_at:cfg.meta_items_at||'',
  };
}
// Products to show in WhatsApp: Leadvyne-synced ones, else the Meta catalog's own items.
export function waShopHasProducts(cfg){ return !!cfg.synced_at || (cfg.meta_items||[]).length>0; }
// A Meta catalog item → the product shape the payload / cart helpers use (retailer id kept as is).
export function waShopMetaItemProduct(it){
  return {_rid:String(it.rid||''), sku:String(it.rid||''), name:String(it.name||it.rid||''), price:num(it.price), category:String(it.category||''), image_url:'meta', currency:it.currency||'INR'};
}
// "₹899.00" / "INR 899" / "899,00 €" → 899
export function waShopParseMetaPrice(v){
  const m=String(v||'').replace(/,(?=\d{3}\b)/g,'').match(/(\d+(?:[.,]\d+)?)/);
  return m?num(m[1].replace(',', '.')):0;
}

/* ── Pure helpers (exported for tests) ────────────────────────────────────────────────────── */
export function waShopRetailerId(p){ return p?._rid?String(p._rid):RID_PREFIX+String(p?.nocodb_id??p?.Id??p?.id??''); }
// Our own `lv_<id>`, or a Shopify "Facebook & Instagram" channel id (shopify_<CC>_<product>_<variant>)
// for a store that linked the catalog Shopify itself keeps in sync.
export function waShopParseRetailerId(rid){
  const s=String(rid||'');
  if(s.startsWith(RID_PREFIX)) return {ecomId:s.slice(RID_PREFIX.length)};
  const m=s.match(/^shopify_[A-Z]{2}_(\d+)_(\d+)$/);
  if(m) return {shopifyProductId:m[1], shopifyVariantId:m[2]};
  return {sku:s};
}
export function waShopFindProduct(products, rid){
  const ref=waShopParseRetailerId(rid);
  const list=products||[];
  if(ref.ecomId) return list.find(p=>String(p.nocodb_id??p.Id)===ref.ecomId)||null;
  if(ref.shopifyProductId) return list.find(p=>String(p.shopify_product_id||'')===ref.shopifyProductId)||null;
  const k=String(ref.sku||'').trim().toLowerCase();
  return k?list.find(p=>String(p.sku||'').trim().toLowerCase()===k)||null:null;
}

// One Catalog Batch API request per product. Meta needs a price, an image and a link — products
// missing one are returned in `skipped` with the reason, so the merchant can fix them.
export function waShopCatalogRequests(products, {currency='INR', fallbackLink='', resolveImageUrl=u=>u}={}){
  const requests=[], skipped=[];
  for(const p of products||[]){
    const name=String(p?.name||'').trim();
    const inactive=String(p?.status||'').toLowerCase()==='inactive';
    if(inactive){ requests.push({method:'DELETE', data:{id:waShopRetailerId(p)}}); continue; }
    const price=num(p?.price), image=String(p?.image_url||'').trim();
    const why=!name?'no name':!(price>0)?'no price':!image?'no photo':'';
    if(why){ skipped.push({id:p?.nocodb_id??p?.Id, name:name||'(unnamed)', reason:why}); continue; }
    const extra=[p.image_url_2,p.image_url_3,p.image_url_4,p.image_url_5].filter(Boolean).map(resolveImageUrl);
    const stock=p.stock===''||p.stock===null||p.stock===undefined?null:num(p.stock);
    const data={
      id:waShopRetailerId(p), title:name.slice(0,150),
      description:(String(p.description||'').trim()||name).slice(0,5000),
      availability:stock!==null&&stock<=0?'out of stock':'in stock', condition:'new',
      price:`${price.toFixed(2)} ${String(p.currency||currency||'INR').toUpperCase()}`,
      link:String(p.shopify_product_url||p.product_link||'').trim()||fallbackLink,
      image_link:resolveImageUrl(image), brand:String(p.brand||'').trim()||undefined,
    };
    if(extra.length) data.additional_image_link=extra.join(',');
    if(p.category) data.product_type=String(p.category).slice(0,750);
    if(stock!==null) data.inventory=Math.max(0, Math.round(stock));
    Object.keys(data).forEach(k=>data[k]===undefined&&delete data[k]);
    requests.push({method:'UPDATE', data});
  }
  return {requests, skipped};
}

// "show me your catalogue", "what do you sell", "collection", "price list" — a browse ask. A named
// category narrows the list to it.
const CATALOG_ASK_RE=/\b(?:catalog(?:ue)?s?|collections?|price\s*list|all\s+(?:the\s+)?(?:products|items|designs|models)|what\s+(?:all\s+)?(?:do|did)\s+you\s+(?:have|sell)|what\s+(?:products|items)\s+(?:do\s+you\s+have|are\s+there)|show\s+(?:me\s+)?(?:your\s+|the\s+)?(?:products|items|shop|store|range))\b/i;
export function waShopIsCatalogAsk(text){ return CATALOG_ASK_RE.test(String(text||'')); }

// WhatsApp multi-product message: ≤10 sections, ≤30 products in total, section titles ≤24 chars.
export function waShopProductListPayload(to, catalogId, products, {header='Our collection', body='Tap a product to see photos and price, then add it to your cart 🛒', category=''}={}){
  const want=String(category||'').trim().toLowerCase();
  const pool=(products||[]).filter(p=>!want||String(p.category||'').trim().toLowerCase()===want);
  const groups=new Map();
  for(const p of pool){
    const k=String(p.category||'').trim()||'More';
    if(!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  // Every category gets a fair share of the 30 slots, so a big one doesn't push the rest out.
  const share=Math.max(1, Math.floor(30/Math.min(groups.size||1, 10)));
  const sections=[]; let total=0;
  for(const [title, list] of groups){
    if(sections.length>=10||total>=30) break;
    const items=list.slice(0, Math.min(share, 30-total)).map(p=>({product_retailer_id:waShopRetailerId(p)}));
    if(!items.length) continue;
    sections.push({title:title.slice(0,24), product_items:items});
    total+=items.length;
  }
  if(!total) return null;
  return {messaging_product:'whatsapp', recipient_type:'individual', to:digits(to), type:'interactive', interactive:{
    type:'product_list', header:{type:'text', text:String(header).slice(0,60)}, body:{text:String(body).slice(0,1024)},
    action:{catalog_id:String(catalogId), sections},
  }};
}

// Inbound `order` message → the cart.
export function waShopParseOrder(message){
  const o=message?.order; if(!o) return null;
  return {catalogId:String(o.catalog_id||''), note:String(o.text||''), items:(o.product_items||[]).map(it=>({
    rid:String(it.product_retailer_id||''), qty:Math.max(1, Math.round(num(it.quantity))||1), price:num(it.item_price), currency:String(it.currency||'INR').toUpperCase(),
  }))};
}
// Cart → Ecom Orders fields. The cart's own price is what WhatsApp showed the customer, so it wins
// over a product price edited since.
export function waShopOrderFields(clientId, cart, products, {phone='', name='', now=new Date(), ref=''}={}){
  const lines=cart.items.map(it=>{
    const p=waShopFindProduct(products, it.rid);
    return {title:p?.name||it.rid, quantity:it.qty, price:it.price||num(p?.price), sku:p?.sku||'', product_id:String(p?.nocodb_id??p?.Id??'')};
  });
  const total=Math.round(lines.reduce((s,l)=>s+l.price*l.quantity, 0)*100)/100;
  const day=new Date(now.getTime()-now.getTimezoneOffset()*60000).toISOString().slice(0,10);
  return {
    client_id:String(clientId), order_id:ref||waShopOrderRef(now), customer_name:name, customer_phone:digits(phone),
    order_date:day, items:lines.map(l=>`${l.quantity}x ${l.title}`).join(', '), line_items_json:JSON.stringify(lines),
    total, currency:cart.items[0]?.currency||'INR', status:'pending',
    notes:`WhatsApp cart${cart.note?` — "${cart.note}"`:''}. Waiting for delivery address.`,
    taken_by:WA_SHOP_TAKEN_BY, taken_by_name:'WhatsApp shop (cart)', taken_by_at:now.toISOString(),
  };
}
export function waShopOrderRef(now=new Date()){
  return 'WA-'+now.toISOString().slice(2,10).replace(/-/g,'')+'-'+Math.random().toString(36).slice(2,6).toUpperCase();
}
export function waShopOrderSummary(order, lines){
  const cur=order.currency==='INR'?'₹':order.currency+' ';
  return `🛒 *Order ${order.order_id}*\n${lines.map(l=>`• ${l.quantity} × ${l.title} — ${cur}${(l.price*l.quantity).toLocaleString('en-IN')}`).join('\n')}\n*Total: ${cur}${Number(order.total).toLocaleString('en-IN')}*`;
}
// India-only WhatsApp Pay "Review and pay" message for an Ecom order.
export function waShopPaymentPayload(to, order, lines, {gateway='razorpay', configName=''}={}){
  const paise=v=>Math.round(num(v)*100);
  return {messaging_product:'whatsapp', recipient_type:'individual', to:digits(to), type:'interactive', interactive:{
    type:'order_details', body:{text:`Thanks for your order! Tap below to review and pay ${order.currency==='INR'?'₹':order.currency+' '}${Number(order.total).toLocaleString('en-IN')}.`},
    action:{name:'review_and_pay', parameters:{
      reference_id:order.order_id, type:'physical-goods', currency:order.currency||'INR',
      payment_settings:[{type:'payment_gateway', payment_gateway:{type:gateway, configuration_name:configName}}],
      total_amount:{value:paise(order.total), offset:100},
      order:{status:'pending', items:lines.map(l=>({retailer_id:l.product_id?RID_PREFIX+l.product_id:l.sku||l.title, name:String(l.title).slice(0,60), amount:{value:paise(l.price), offset:100}, quantity:l.quantity})),
        subtotal:{value:paise(order.total), offset:100}, tax:{value:0, offset:100}},
    }},
  }};
}
// A payment status from the webhook (statuses[].type === 'payment').
export function waShopParsePayment(st){
  if(st?.type!=='payment'||!st.payment) return null;
  const p=st.payment, t=p.transaction||{};
  const state=String(t.status||st.status||'').toLowerCase();
  return {ref:String(p.reference_id||''), paid:['success','captured'].includes(state), failed:['failed','canceled','cancelled'].includes(state),
    txn:String(t.id||''), method:String(t.type||''), amount:num(p.amount?.value)/(num(p.amount?.offset)||100)};
}
export function waShopShopifyCartUrl(shop, lines){
  const parts=lines.filter(l=>l.variantId).map(l=>`${l.variantId}:${l.quantity}`);
  return parts.length?`https://${shop}/cart/${parts.join(',')}`:'';
}
// Where this number's Chatwoot inbox listens for WhatsApp Cloud webhooks.
export function waShopChatwootTarget(c, cfg, creds){
  if(cfg.chatwoot_webhook_url) return cfg.chatwoot_webhook_url;
  const phone=digits(creds?.display_phone||c?.wa_display_phone);
  return c?.chatwoot_base&&phone?`${String(c.chatwoot_base).replace(/\/$/,'')}/webhooks/whatsapp/+${phone}`:'';
}

/* ── Graph / store helpers ─────────────────────────────────────────────────────────────────── */
function creds(deps, c, cfg){
  return deps.resolveMetaCredentials(c, cfg.inbox_id?{inbox_id:cfg.inbox_id}:{});
}
// 15s cap: a hung Meta call used to hold the request until the platform cut it off, which the
// browser only reports as "Failed to fetch" — now it comes back as a readable error.
async function graph(path, token, {method='GET', body}={}){
  const ctl=new AbortController(); const timer=setTimeout(()=>ctl.abort(), 15000);
  try{
    const r=await fetch(`${WA_SHOP_GRAPH}/${path}`, {method, headers:{Authorization:`Bearer ${token}`, ...(body?{'Content-Type':'application/json'}:{})}, body:body?JSON.stringify(body):undefined, signal:ctl.signal});
    const data=await r.json().catch(()=>({}));
    return {ok:r.ok, status:r.status, data, code:data?.error?.code, error:data?.error?.error_user_msg||data?.error?.message||(r.ok?'':`HTTP ${r.status}`)};
  }catch(e){
    return {ok:false, status:0, data:{}, error:e?.name==='AbortError'?'Meta did not answer in time — try again in a minute.':`Could not reach Meta: ${e?.message||e}`};
  }finally{ clearTimeout(timer); }
}
// Tries each token in turn (the catalog System User token first for catalog calls, then the
// WhatsApp token) — returns the first success, else the most useful failure.
async function graphAny(path, tokens, opts){
  let last={ok:false, error:'No access token saved.'};
  for(const t of tokens){ const r=await graph(path, t, opts); if(r.ok) return {...r, token:t}; last=r; }
  return last;
}
// Couplo (Oct 2026): "✓ Token saved" yet Link only ever tried the WhatsApp token — NocoDB drops a
// PATCH field whose column couldn't be created, silently. The token is now also kept server-side in
// KV (never returned to the browser) and read from there whenever the column comes back empty.
const tokenKey=cid=>`wa_shop_catalog_token:${cid}`;
async function withCatalogToken(env, c){
  if(!c||String(c[WA_SHOP_TOKEN_FIELD]||'').trim()||!env?.MATRI_CACHE) return c;
  const t=await env.MATRI_CACHE.get(tokenKey(c.Id)).catch(()=>null);
  return t?{...c, [WA_SHOP_TOKEN_FIELD]:t}:c;
}
export function waShopTokens(c, cr, prefer='catalog'){
  const cat=String(c?.[WA_SHOP_TOKEN_FIELD]||'').trim(), wa=String(cr?.wa_token||'').trim();
  return [...new Set(prefer==='catalog'?[cat, wa]:[wa, cat])].filter(Boolean);
}
// Name, product count and up to 200 items of the catalog, straight from Meta.
async function fetchCatalogInfo(catalogId, tokens){
  const head=await graphAny(`${catalogId}?fields=name,product_count`, tokens);
  if(!head.ok) return {ok:false, error:head.error};
  const items=[]; let path=`${catalogId}/products?fields=retailer_id,name,price,currency,category,availability&limit=100`;
  for(let page=0; page<2 && path; page++){
    const r=await graph(path, head.token);
    if(!r.ok) break;
    for(const it of r.data?.data||[]) if(it.retailer_id) items.push({rid:String(it.retailer_id), name:String(it.name||'').slice(0,80), price:waShopParseMetaPrice(it.price), currency:String(it.currency||'INR').toUpperCase(), category:String(it.category||'').slice(0,60), available:String(it.availability||'in stock')!=='out of stock'});
    const next=r.data?.paging?.next||''; path=next?next.replace(`${WA_SHOP_GRAPH}/`, ''):'';
  }
  return {ok:true, name:String(head.data?.name||''), count:num(head.data?.product_count)||items.length, items};
}
async function sendWa(cr, payload){ return graph(`${cr.wa_phone_id}/messages`, cr.wa_token, {method:'POST', body:payload}); }
function storedConfig(c){ try{ return JSON.parse(c?.[WA_SHOP_CONFIG_FIELD]||'{}')||{}; }catch(e){ return {}; } }
async function saveConfig(env, deps, c, patch){
  const next={...storedConfig(c), ...patch};
  await deps.ensureClientColumns(env, [WA_SHOP_CONFIG_FIELD]);
  await deps.patchClientFields(env, c.Id, {[WA_SHOP_CONFIG_FIELD]:JSON.stringify(next)});
  return next;
}
async function verifyToken(env, deps, cid){ return (await deps.hmacSignB64(env, `wa-shop:${cid}`)).replace(/[^A-Za-z0-9]/g,'').slice(0,40); }

async function ensureEventsTable(env){
  if(!env.DB) return false;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS wa_shop_events (id TEXT PRIMARY KEY, client_id INTEGER NOT NULL, kind TEXT NOT NULL, order_ref TEXT, phone TEXT, total REAL, currency TEXT, detail TEXT, created_at TEXT NOT NULL)`).run().catch(()=>{});
  return true;
}
// First writer wins — a webhook Meta redelivers is skipped.
async function claimEvent(env, row){
  if(!await ensureEventsTable(env)) return true;
  const r=await env.DB.prepare(`INSERT OR IGNORE INTO wa_shop_events (id, client_id, kind, order_ref, phone, total, currency, detail, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(row.id, Number(row.client_id), row.kind, row.order_ref||'', row.phone||'', row.total||0, row.currency||'', row.detail||'', new Date().toISOString()).run().catch(()=>null);
  return !!r?.meta?.changes;
}

async function syncCatalog(env, deps, c){
  const cfg=waShopConfig(c);
  if(!cfg.catalog_id) throw new Error('Add your Meta catalog ID first.');
  const cr=creds(deps, c, cfg);
  const token=c[WA_SHOP_TOKEN_FIELD]||cr?.wa_token;
  if(!token) throw new Error('Connect WhatsApp first (Settings → Channels).');
  const tableId=await deps.ecomResolveTable(env, c.Id, 'products');
  const products=tableId?await deps.ecomListClientRows(env, tableId, c.Id):[];
  const fallbackLink=c.client_slug?`https://onshope.com/${encodeURIComponent(c.client_slug)}`:`https://app.leadvyne.com/store.html?client=${c.Id}`;
  const {requests, skipped}=waShopCatalogRequests(products, {currency:c.currency||'INR', fallbackLink, resolveImageUrl:deps.resolveImageUrl});
  const handles=[];
  for(let i=0; i<requests.length; i+=500){
    const r=await graph(`${cfg.catalog_id}/items_batch`, token, {method:'POST', body:{item_type:'PRODUCT_ITEM', allow_upsert:true, requests:requests.slice(i, i+500)}});
    if(!r.ok) throw new Error(`Meta catalog: ${r.error}${/permission|catalog_management/i.test(r.error)?' — the token needs the catalog_management permission (add a Catalog access token below).':''}`);
    handles.push(...(r.data?.handles||[]));
  }
  const synced=requests.filter(q=>q.method==='UPDATE').length;
  await saveConfig(env, deps, c, {synced_at:new Date().toISOString(), synced_count:synced, skipped:skipped.slice(0,50)});
  return {synced, removed:requests.length-synced, skipped, handles};
}

/* ── Routes (session — these change what the WhatsApp number does) ───────────────────────── */
async function session(request, env, deps){
  const payload=await deps.requireSession(request, env);
  if(!payload) return {error:deps.json({error:'Sign in again to change WhatsApp Shop settings.'}, 401)};
  const c=await withCatalogToken(env, await deps.getClientById(env, payload.cid));
  if(!c) return {error:deps.json({error:'Client not found'}, 404)};
  return {c, cid:payload.cid};
}

async function handleStatus(request, env, deps){
  const {c, error}=await session(request, env, deps); if(error) return error;
  const cfg=waShopConfig(c), cr=creds(deps, c, cfg);
  let stats={carts:0, paid:0, revenue:0, recent:[]};
  if(await ensureEventsTable(env)){
    const rows=(await env.DB.prepare(`SELECT kind, order_ref, phone, total, currency, detail, created_at FROM wa_shop_events WHERE client_id=? ORDER BY created_at DESC LIMIT 200`).bind(Number(c.Id)).all().catch(()=>({results:[]})))?.results||[];
    const since=new Date(Date.now()-30*86400000).toISOString();
    const recent=rows.filter(r=>r.created_at>=since);
    stats={carts:recent.filter(r=>r.kind==='cart').length, paid:recent.filter(r=>r.kind==='payment').length,
      revenue:Math.round(recent.filter(r=>r.kind==='cart').reduce((s,r)=>s+num(r.total),0)), recent:rows.filter(r=>r.kind==='cart').slice(0,10)};
  }
  return deps.json({config:cfg, whatsapp:!!cr?.wa_phone_id, has_catalog_token:!!c[WA_SHOP_TOKEN_FIELD], shopify:!!c.shopify_shop_domain,
    display_phone:cr?.display_phone||c.wa_display_phone||'', chatwoot_target:waShopChatwootTarget(c, cfg, cr), stats});
}

async function handleConfig(request, env, deps){
  const {c, error}=await session(request, env, deps); if(error) return error;
  const b=await request.json().catch(()=>({}));
  const patch={};
  if('catalog_id' in b){ const id=digits(b.catalog_id); if(b.catalog_id&&!id) return deps.json({error:'The catalog ID is the number shown in Commerce Manager.'}, 400); patch.catalog_id=id; }
  if('payment_mode' in b){ if(!WA_SHOP_PAYMENT_MODES.includes(b.payment_mode)) return deps.json({error:'Unknown payment option.'}, 400);
    if(b.payment_mode==='shopify_checkout'&&!c.shopify_shop_domain) return deps.json({error:'Connect Shopify to use Shopify checkout.'}, 400); patch.payment_mode=b.payment_mode; }
  if('gateway' in b){ if(!WA_SHOP_GATEWAYS.includes(b.gateway)) return deps.json({error:'Unknown payment gateway.'}, 400); patch.gateway=b.gateway; }
  if('payment_config' in b) patch.payment_config=String(b.payment_config||'').trim().slice(0,100);
  if('send_in_chat' in b) patch.send_in_chat=!!b.send_in_chat;
  if('inbox_id' in b) patch.inbox_id=digits(b.inbox_id);
  if('chatwoot_webhook_url' in b){ const u=String(b.chatwoot_webhook_url||'').trim(); if(u&&!/^https:\/\//.test(u)) return deps.json({error:'The Chatwoot webhook URL must start with https://'}, 400); patch.chatwoot_webhook_url=u; }
  if((patch.payment_mode||waShopConfig(c).payment_mode)==='whatsapp_pay'&&!(patch.payment_config??waShopConfig(c).payment_config))
    return deps.json({error:'Add the payment configuration name from WhatsApp Manager → Payments to use WhatsApp Pay.'}, 400);
  const fields={};
  if(Object.keys(patch).length){ await deps.ensureClientColumns(env, [WA_SHOP_CONFIG_FIELD]); fields[WA_SHOP_CONFIG_FIELD]=JSON.stringify({...storedConfig(c), ...patch}); }
  const hasToken='catalog_token' in b, token=String(b.catalog_token||'').trim();
  if(hasToken){
    if(token&&!/^EA[A-Za-z0-9]{20,}$/.test(token)) return deps.json({error:'That doesn\'t look like a Meta access token — it starts with EAA and has no spaces.'}, 400);
    await deps.ensureClientColumns(env, [WA_SHOP_TOKEN_FIELD]); fields[WA_SHOP_TOKEN_FIELD]=token;
  }
  if(!Object.keys(fields).length) return deps.json({error:'Nothing to save'}, 400);
  await deps.patchClientFields(env, c.Id, fields);
  if(!hasToken) return deps.json({ok:true});
  const kv=env?.MATRI_CACHE;
  let inKv=false;
  if(kv) try{ token?await kv.put(tokenKey(c.Id), token):await kv.delete(tokenKey(c.Id)); inKv=true; }catch(e){}
  const fresh=await deps.getClientById(env, c.Id).catch(()=>null);
  const inDb=String(fresh?.[WA_SHOP_TOKEN_FIELD]||'').trim()===token;
  if(token&&!inDb&&!inKv) return deps.json({error:'The token could not be stored — try again, or ask support to add the wa_shop_catalog_token column.'}, 500);
  return deps.json({ok:true, token_saved:!!token});
}

// Links the catalog to the WhatsApp Business account and shows it (with the cart) on the number.
// Couplo (Oct 2026): catalog already connected in WhatsApp Manager + a System User token saved
// here, and "Link to my WhatsApp" did nothing. It only ever used the WhatsApp messaging token
// (not the saved catalog_management token) and treated Meta's "this catalog is already connected"
// refusal as a failure unless the text said "already". Now: an already-connected catalog counts
// as linked, both tokens are tried, and the catalog's real name / product count is read back.
async function handleConnect(request, env, deps){
  const {c, error}=await session(request, env, deps); if(error) return error;
  const b=await request.json().catch(()=>({}));
  const cfg=waShopConfig(c), cr=creds(deps, c, cfg);
  // The ID typed in the box wins (and is saved below), so a just-saved setting can't be missed.
  if(b.catalog_id!==undefined){ const id=digits(b.catalog_id); if(!id) return deps.json({error:'Enter the catalog ID — the long number shown in Commerce Manager.'}, 400); cfg.catalog_id=id; }
  if(!cfg.catalog_id) return deps.json({error:'Add your Meta catalog ID first.'}, 400);
  if(!cr?.wa_phone_id||!cr.waba_id) return deps.json({error:'Connect WhatsApp first (Settings → Channels).'}, 400);
  const tokens=waShopTokens(c, cr, 'catalog');
  if(!tokens.length) return deps.json({error:'No Meta access token — connect WhatsApp (Settings → Channels) or save a catalog access token below.'}, 400);
  // 1. Is it already connected to this WhatsApp Business account (e.g. done in WhatsApp Manager)?
  const list=await graphAny(`${cr.waba_id}/product_catalogs?fields=id,name`, tokens);
  let alreadyLinked=list.ok && (list.data?.data||[]).some(x=>String(x.id)===cfg.catalog_id);
  const otherCatalog=list.ok ? (list.data?.data||[]).find(x=>String(x.id)!==cfg.catalog_id) : null;
  // 2. If not, connect it.
  if(!alreadyLinked){
    const link=await graphAny(`${cr.waba_id}/product_catalogs`, tokens, {method:'POST', body:{catalog_id:cfg.catalog_id}});
    // Meta's "already connected to this account" refusal = done; anything else (e.g. a different
    // catalog holds the WhatsApp account's one slot) is a real failure.
    if(link.ok || (!otherCatalog && /\balready\b/i.test(link.error))) alreadyLinked=!link.ok;
    else if(otherCatalog) return deps.json({error:waShopLinkError(link, otherCatalog)}, 502);
    else return deps.json({error:await diagnoseLink(c, cr, cfg.catalog_id, link)}, 502);
  }
  // 3. Show the catalog and the cart on the number. A refusal here no longer throws away the link
  // that just worked (Couplo, Oct 2026: "An unknown error has occurred") — it's reported as a warning.
  const show=await showOnNumber(cr, waShopTokens(c, cr, 'whatsapp'));
  // 4. What's in it, as Meta sees it.
  const info=await fetchCatalogInfo(cfg.catalog_id, tokens);
  await saveConfig(env, deps, c, {catalog_id:cfg.catalog_id, linked_at:new Date().toISOString(),
    ...(info.ok?{catalog_name:info.name, catalog_count:info.count, meta_items:info.items.slice(0,100), meta_items_at:new Date().toISOString()}:{})});
  return deps.json({ok:true, already_linked:alreadyLinked, catalog_name:info.ok?info.name:'', product_count:info.ok?info.count:null,
    shown:show.ok, ...(show.ok?{}:{show_error:show.error}),
    ...(info.ok?{}:{warning:`Linked, but the catalog's products couldn't be read: ${info.error}`})});
}
// Catalog icon + cart on the number: skipped when already on (e.g. switched on in WhatsApp Manager),
// else each token is tried, with one retry for Meta's transient "unknown error" (codes 1 / 2).
async function showOnNumber(cr, tokens){
  const cur=await graphAny(`${cr.wa_phone_id}/whatsapp_commerce_settings`, tokens);
  const s=cur.ok?(cur.data?.data||[])[0]:null;
  if(s?.is_catalog_visible&&s?.is_cart_enabled) return {ok:true};
  const path=`${cr.wa_phone_id}/whatsapp_commerce_settings?is_catalog_visible=true&is_cart_enabled=true`;
  let r=await graphAny(path, tokens, {method:'POST'});
  if(!r.ok&&[1,2].includes(Number(r.code))){ await new Promise(res=>setTimeout(res, 1500)); r=await graphAny(path, tokens, {method:'POST'}); }
  return r.ok?{ok:true}:{ok:false, error:r.error};
}
// Couplo (Oct 2026): Meta answered "invalid product catalogue ID" for a real catalog, even with a
// System User token saved — that text also covers "this token can't see it" and "the catalog belongs
// to a different business than the WhatsApp account". Ask Meta which one it is, per token.
async function diagnoseLink(c, cr, catalogId, link){
  const cat=String(c?.[WA_SHOP_TOKEN_FIELD]||'').trim(), wa=String(cr?.wa_token||'').trim();
  const tokens=[...(cat?[['catalog token', cat]]:[]), ...(wa&&wa!==cat?[['WhatsApp token', wa]]:[])];
  let catalog=null, waba=null; const blind=[];
  for(const [label, t] of tokens){
    const r=await graph(`${catalogId}?fields=id,name,business{id,name}`, t);
    if(r.ok){ catalog=catalog||r.data; } else blind.push(`${label}: ${r.error}`);
    if(!waba){ const w=await graph(`${cr.waba_id}?fields=id,name,owner_business_info`, t); if(w.ok) waba=w.data; }
  }
  return waShopLinkDiagnosis({catalogId, catalog, waba, blind, linkError:link?.error});
}
export function waShopLinkDiagnosis({catalogId, catalog, waba, blind=[], linkError=''}){
  if(!catalog) return `None of your saved tokens can open catalog ${catalogId} (${blind.join('; ')||linkError}). `+
    `Either the ID isn't the catalog's (Commerce Manager → the catalog → Settings → Catalog ID — not the Business or Commerce account ID), `+
    `or the System User behind the catalog token isn't assigned to this catalog (Business Settings → Data sources → Catalogs → Assign people → your System User, Full control), then generate a new token.`;
  const cb=catalog.business||{}, wb=waba?.owner_business_info||{};
  const name=catalog.name?`"${catalog.name}"`:catalogId;
  if(cb.id&&wb.id&&String(cb.id)!==String(wb.id))
    return `Catalog ${name} belongs to the business "${cb.name||cb.id}", but your WhatsApp account belongs to "${wb.name||wb.id}". `+
      `Meta only links a catalog owned by the same business as the WhatsApp account — create the catalog in Commerce Manager under "${wb.name||wb.id}" and use that ID.`;
  return `Catalog ${name} exists and your token can see it, but Meta still refused to link it (${linkError}). `+
    `Link it once by hand — WhatsApp Manager → Account tools → Catalog → Choose a catalog (or Commerce Manager → Settings → Business assets → WhatsApp accounts) — then press "Link to my WhatsApp" again.`;
}
// A Meta refusal in words the merchant can act on.
export function waShopLinkError(r, otherCatalog=null){
  const e=String(r?.error||'');
  if(otherCatalog) return `Your WhatsApp account already has another catalog connected (${otherCatalog.name||otherCatalog.id}). Disconnect it in WhatsApp Manager → Catalog, or enter that catalog's ID here.`;
  if(/permission|not authori[sz]ed|\(#10\)|\(#200\)|catalog_management|whatsapp_business_management/i.test(e))
    return `Meta says the token isn't allowed to connect this catalog (${e}). The System User needs catalog_management and whatsapp_business_management, and must be assigned to both the catalog and the WhatsApp account in Business Settings.`;
  if(/does not exist|unsupported get request|invalid/i.test(e)) return `Meta can't find that catalog — check the Catalog ID in Commerce Manager (${e}).`;
  return `Couldn't link the catalog to your WhatsApp account: ${e}`;
}

async function handleSync(request, env, deps){
  const {c, error}=await session(request, env, deps); if(error) return error;
  const b=await request.json().catch(()=>({}));
  const cfg=waShopConfig(c);
  const managed=cfg.meta_items.filter(it=>!String(it.rid).startsWith(RID_PREFIX)).length;
  if(managed && !cfg.synced_at && b.confirm!==true)
    return deps.json({error:'meta_managed', message:`Your catalog already has ${managed} products added in Meta, and they are already used in WhatsApp. Syncing adds your Leadvyne products to it as well, which can show the same product twice. Sync anyway?`, managed}, 409);
  try{ return deps.json({ok:true, ...await syncCatalog(env, deps, c)}); }
  catch(e){ return deps.json({error:e.message}, 400); }
}

// Carts on → this number's webhooks come through the relay; off → back to the app default.
async function handleCarts(request, env, deps){
  const {c, cid, error}=await session(request, env, deps); if(error) return error;
  const {enable}=await request.json().catch(()=>({}));
  const cfg=waShopConfig(c), cr=creds(deps, c, cfg);
  if(!cr?.wa_token||!cr.waba_id) return deps.json({error:'Connect WhatsApp first (Settings → Channels).'}, 400);
  if(enable){
    if(!waShopChatwootTarget(c, cfg, cr)) return deps.json({error:'Your Chatwoot WhatsApp webhook URL is unknown — add it under Advanced so messages keep reaching your inbox.'}, 400);
    const r=await graph(`${cr.waba_id}/subscribed_apps`, cr.wa_token, {method:'POST', body:{override_callback_uri:`${env.WORKER_BASE_URL}/wa/shop/webhook/${cid}`, verify_token:await verifyToken(env, deps, cid)}});
    if(!r.ok) return deps.json({error:`Meta refused the webhook change: ${r.error}`}, 502);
  }else{
    await graph(`${cr.waba_id}/subscribed_apps`, cr.wa_token, {method:'DELETE'});
    const r=await graph(`${cr.waba_id}/subscribed_apps`, cr.wa_token, {method:'POST'});
    if(!r.ok) return deps.json({error:`Couldn't restore the default webhook: ${r.error} — re-subscribe the app in Meta Business Manager.`}, 502);
  }
  await saveConfig(env, deps, c, {carts:!!enable});
  return deps.json({ok:true, carts:!!enable});
}

// Staff: send the catalog (or one category of it) to a customer from Ecom.
async function handleSend(request, env, deps){
  const {c, error}=await session(request, env, deps); if(error) return error;
  const {phone, category}=await request.json().catch(()=>({}));
  if(digits(phone).length<8) return deps.json({error:'Enter the customer’s WhatsApp number with country code.'}, 400);
  const r=await sendCatalog(env, deps, c, phone, {category});
  return r.ok?deps.json({ok:true, count:r.count}):deps.json({error:r.error}, 400);
}

async function sendCatalog(env, deps, c, phone, {category='', inboxId=''}={}){
  const cfg=waShopConfig(c);
  if(!cfg.catalog_id||!waShopHasProducts(cfg)) return {ok:false, error:'Link your catalog (or sync your products to it) first.'};
  const cr=deps.resolveMetaCredentials(c, inboxId?{inbox_id:inboxId}:cfg.inbox_id?{inbox_id:cfg.inbox_id}:{});
  if(!cr?.wa_token||!cr.wa_phone_id) return {ok:false, error:'WhatsApp is not connected for this number.'};
  const skippedIds=new Set(cfg.skipped.map(s=>String(s.id)));
  const products=cfg.synced_at
    ? (await deps.ecomListActiveProducts(env, c.Id)||[]).filter(p=>!skippedIds.has(String(p.nocodb_id??p.Id))&&num(p.price)>0&&p.image_url&&!(p.stock!==null&&p.stock!==''&&p.stock!==undefined&&num(p.stock)<=0))
    : cfg.meta_items.filter(it=>it.available!==false).map(waShopMetaItemProduct);
  const payload=waShopProductListPayload(phone, cfg.catalog_id, products, {category, header:category?String(category):'Our collection'});
  if(!payload) return {ok:false, error:category?`No products in “${category}” to show.`:'No products to show yet.'};
  const r=await sendWa(cr, payload);
  if(!r.ok) return {ok:false, error:`WhatsApp refused the catalog message: ${r.error}`};
  return {ok:true, count:payload.interactive.action.sections.reduce((s,x)=>s+x.product_items.length,0)};
}

// Engine hook (worker.js handleEngineWebhook): a browse ask gets the catalog as a WhatsApp product
// list instead of photos. Returns the history text, or null when it doesn't apply.
export async function waShopMaybeSendCatalog(env, deps, c, {phone, convId, inboxId, text, categories=[]}){
  const cfg=waShopConfig(c);
  if(!cfg.send_in_chat||!cfg.catalog_id||!waShopHasProducts(cfg)||!cfg.linked_at||!waShopIsCatalogAsk(text)) return null;
  const low=` ${String(text||'').toLowerCase()} `;
  const category=(categories||[]).find(n=>{ const k=String(n||'').trim().toLowerCase(); return k.length>=3&&low.includes(` ${k} `); })||'';
  const r=await sendCatalog(env, deps, c, phone, {category, inboxId});
  if(!r.ok) return null;
  if(convId) await deps.sendChatwootNote(env, c, convId, `🛍️ Sent the WhatsApp catalog${category?` (${category})`:''} — ${r.count} product${r.count===1?'':'s'}. The customer can add to cart and order right in WhatsApp.`).catch(()=>{});
  // What the customer saw — kept in the conversation history the AI reads next turn.
  return `Here's our ${category?category+' ':''}collection on WhatsApp 🛍️ Tap a product to see photos and price, add it to your cart, and send the order right here.`;
}

/* ── Relay: Meta → (Chatwoot, untouched) → carts and payments ─────────────────────────────── */
async function handleWebhookVerify(request, env, deps, cid){
  const url=new URL(request.url);
  if(url.searchParams.get('hub.mode')==='subscribe'&&url.searchParams.get('hub.verify_token')===await verifyToken(env, deps, cid))
    return new Response(url.searchParams.get('hub.challenge')||'', {status:200});
  return new Response('Verification failed', {status:403});
}

async function handleWebhook(request, env, deps, cid, ctx){
  const raw=await request.text();
  const c=await deps.getClientById(env, cid);
  if(!c) return new Response('ok', {status:200});
  const cfg=waShopConfig(c), cr=creds(deps, c, cfg);
  const target=waShopChatwootTarget(c, cfg, cr);
  let forwarded=!target;
  if(target){
    const ctl=new AbortController(); const timer=setTimeout(()=>ctl.abort(), 9000);
    try{
      const headers={'Content-Type':'application/json'};
      const sig=request.headers.get('X-Hub-Signature-256'); if(sig) headers['X-Hub-Signature-256']=sig;
      const r=await fetch(target, {method:'POST', headers, body:raw, signal:ctl.signal});
      forwarded=r.status<500;
    }catch(e){ forwarded=false; }
    finally{ clearTimeout(timer); }
  }
  const work=(async()=>{
    if(env.META_APP_SECRET&&!await deps.verifyMetaWebhookSignature(env, raw, request.headers.get('X-Hub-Signature-256'))) return;
    let body; try{ body=JSON.parse(raw); }catch(e){ return; }
    await waShopProcessWebhook(env, deps, c, body);
  })().catch(e=>deps.reportOpsError(env, 'wa shop webhook', e, {clientId:cid}));
  if(ctx?.waitUntil) ctx.waitUntil(work); else await work;
  // Chatwoot didn't take it → let Meta retry (cart processing is idempotent on the message id).
  if(!forwarded) await deps.reportOpsError(env, 'wa shop relay → Chatwoot forward failed', new Error(target), {clientId:cid});
  return new Response(forwarded?'ok':'retry', {status:forwarded?200:502});
}

export async function waShopProcessWebhook(env, deps, c, body){
  for(const entry of body?.entry||[]) for(const ch of entry.changes||[]){
    const v=ch.value||{};
    if(ch.field!=='messages') continue;
    const cr=deps.resolveMetaCredentials(c, {wa_phone_id:v.metadata?.phone_number_id})||creds(deps, c, waShopConfig(c));
    if(!cr?.wa_token) continue;
    const names=Object.fromEntries((v.contacts||[]).map(x=>[String(x.wa_id), x.profile?.name||'']));
    for(const m of v.messages||[]) if(m.type==='order') await handleCart(env, deps, c, cr, m, names[String(m.from)]||'');
    for(const st of v.statuses||[]){ const pay=waShopParsePayment(st); if(pay) await handlePayment(env, deps, c, cr, st, pay); }
  }
}

async function handleCart(env, deps, c, cr, m, name){
  const cart=waShopParseOrder(m);
  if(!cart?.items.length) return;
  const cfg=waShopConfig(c);
  const tableId=await deps.ecomResolveTable(env, c.Id, 'products');
  // Meta-managed catalog items (retailer ids not ours) resolve by their retailer id → name.
  const products=[...(tableId?await deps.ecomListClientRows(env, tableId, c.Id):[]), ...cfg.meta_items.map(waShopMetaItemProduct)];
  const order=waShopOrderFields(c.Id, cart, products, {phone:m.from, name});
  if(!await claimEvent(env, {id:m.id, client_id:c.Id, kind:'cart', order_ref:order.order_id, phone:order.customer_phone, total:order.total, currency:order.currency})) return;
  const lines=JSON.parse(order.line_items_json);

  // Shopify checkout: Shopify takes the payment and its order syncs back into Ecom Orders by webhook.
  if(cfg.payment_mode==='shopify_checkout'&&c.shopify_shop_domain&&c.shopify_access_token){
    const withVariants=[];
    for(const it of cart.items){
      const ref=waShopParseRetailerId(it.rid), p=waShopFindProduct(products, it.rid);
      let variantId=ref.shopifyVariantId||'';
      if(!variantId&&p?.shopify_product_id){
        const r=await deps.shopifyFetch(env, c.shopify_shop_domain, c.shopify_access_token, `/products/${p.shopify_product_id}.json?fields=variants`).catch(()=>null);
        const vs=r?.ok?((await r.json().catch(()=>({})))?.product?.variants||[]):[];
        variantId=String((vs.find(v=>!v.inventory_management||num(v.inventory_quantity)>0)||vs[0]||{}).id||'');
      }
      withVariants.push({variantId, quantity:it.qty});
    }
    const url=waShopShopifyCartUrl(c.shopify_shop_domain, withVariants);
    if(url){
      await sendWa(cr, {messaging_product:'whatsapp', to:order.customer_phone, type:'interactive', interactive:{type:'cta_url',
        body:{text:`${waShopOrderSummary(order, lines)}\n\nTap below to add your address and pay securely.`},
        action:{name:'cta_url', parameters:{display_text:'Checkout', url}}}});
      return;
    }
  }

  const ordersTable=await deps.ecomResolveTable(env, c.Id, 'orders');
  if(ordersTable){
    await deps.ensureEcomOrderFields(env, ordersTable);
    const r=await deps.ncFetch(env, `api/v2/tables/${ordersTable}/records`, {method:'POST', body:order});
    if(!r.ok) await deps.reportOpsError(env, 'wa shop cart → Ecom order', new Error(`HTTP ${r.status}`), {clientId:c.Id, ref:order.order_id});
  }
  const summary=waShopOrderSummary(order, lines);
  if(cfg.payment_mode==='whatsapp_pay'&&cfg.payment_config){
    const pay=await sendWa(cr, waShopPaymentPayload(order.customer_phone, order, lines, {gateway:cfg.gateway, configName:cfg.payment_config}));
    await sendWa(cr, {messaging_product:'whatsapp', to:order.customer_phone, type:'text', text:{body:`${summary}\n\n📍 Please reply with your full delivery address and pincode.`}});
    if(!pay.ok) await deps.reportOpsError(env, 'wa shop payment message', new Error(pay.error), {clientId:c.Id, ref:order.order_id});
    return;
  }
  await sendWa(cr, {messaging_product:'whatsapp', to:order.customer_phone, type:'text', text:{body:`${summary}\n\n💵 Cash on delivery.\n📍 Please reply with your full delivery address and pincode to confirm.`}});
}

async function handlePayment(env, deps, c, cr, st, pay){
  if(!pay.ref||!(pay.paid||pay.failed)) return;
  if(!await claimEvent(env, {id:`pay:${st.id||pay.txn}:${pay.paid?'ok':'fail'}`, client_id:c.Id, kind:pay.paid?'payment':'payment_failed', order_ref:pay.ref, total:pay.amount, detail:pay.txn})) return;
  const ordersTable=await deps.ecomResolveTable(env, c.Id, 'orders');
  if(!ordersTable) return;
  const r=await deps.ncFetch(env, `api/v2/tables/${ordersTable}/records?where=${encodeURIComponent(`(client_id,eq,${c.Id})~and(order_id,eq,${pay.ref})`)}&limit=1`);
  const row=((await r.json().catch(()=>({})))?.list||[])[0];
  if(!row) return;
  if(pay.paid){
    await deps.ncFetch(env, `api/v2/tables/${ordersTable}/records`, {method:'PATCH', body:{Id:row.Id, status:'processing', notes:`${row.notes||''} Paid on WhatsApp${pay.method?` (${pay.method})`:''}${pay.txn?` · txn ${pay.txn}`:''}.`.trim()}});
    if(row.customer_phone) await sendWa(cr, {messaging_product:'whatsapp', to:digits(row.customer_phone), type:'text', text:{body:`✅ Payment received for order ${pay.ref}. Thank you! We'll let you know when it ships.`}});
  }else if(row.customer_phone){
    await sendWa(cr, {messaging_product:'whatsapp', to:digits(row.customer_phone), type:'text', text:{body:`⚠️ The payment for order ${pay.ref} didn't go through. You can try again from the payment message above, or reply "COD" for cash on delivery.`}});
  }
}

// Daily: keep price, stock and photos in the WhatsApp catalog in step with Ecom Products.
export async function waShopDailySync(env, deps, client){
  const c=await withCatalogToken(env, client);
  const cfg=waShopConfig(c);
  if(cfg.catalog_id && cfg.linked_at){
    const info=await fetchCatalogInfo(cfg.catalog_id, waShopTokens(c, creds(deps, c, cfg), 'catalog')).catch(()=>null);
    if(info?.ok) await saveConfig(env, deps, c, {catalog_name:info.name, catalog_count:info.count, meta_items:info.items.slice(0,100), meta_items_at:new Date().toISOString()}).catch(()=>{});
  }
  if(!cfg.catalog_id||!cfg.synced_at) return;
  try{ await syncCatalog(env, deps, c); }catch(e){ await deps.reportOpsError(env, 'wa shop daily catalog sync', e, {clientId:c.Id}); }
}

export async function waShopHandleRoute(request, env, deps, url, ctx){
  const p=url.pathname, m=request.method;
  const hook=p.match(/^\/wa\/shop\/webhook\/(\d+)$/);
  if(hook) return m==='GET'?handleWebhookVerify(request, env, deps, hook[1]):m==='POST'?handleWebhook(request, env, deps, hook[1], ctx):null;
  if(p==='/ecom/wa-shop/status'&&m==='GET') return handleStatus(request, env, deps);
  if(p==='/ecom/wa-shop/config'&&m==='POST') return handleConfig(request, env, deps);
  if(p==='/ecom/wa-shop/connect'&&m==='POST') return handleConnect(request, env, deps);
  if(p==='/ecom/wa-shop/sync'&&m==='POST') return handleSync(request, env, deps);
  if(p==='/ecom/wa-shop/carts'&&m==='POST') return handleCarts(request, env, deps);
  if(p==='/ecom/wa-shop/send'&&m==='POST') return handleSend(request, env, deps);
  return null;
}
