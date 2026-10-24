// ── Shopify Orders + Stock modules (ecom.html desktop "Shopify" section) ─────────────────────────
// Two NocoDB tables this module owns, auto-provisioned in the clients table's base the first time
// they're needed (same convention as worker.js getShopifyCheckoutsTableId):
//   shopify_orders     one row per Shopify order — the full Shopify view (payment + fulfillment
//                      status, line items, tracking), separate from the shared Ecom orders table
//                      that worker.js syncShopifyOrderToEcom keeps feeding as before.
//   shopify_inventory  one row per product variant — price, SKU and stock available summed over
//                      every location.
// Kept in step by Shopify webhooks (orders/*, fulfillments/*, products/*, inventory_levels/update,
// forwarded from worker.js handleShopifyWebhook) and backfilled by POST /ecom/shopify/resync, which
// also registers any webhook a store connected before this module is missing. Every row carries
// `shop` so data from a previously connected store never shows after switching stores.
//
// This file imports nothing from worker.js; worker.js passes helpers in as `deps`
// (SHOPIFY_SYNC_DEPS): { json, ncFetch, getClientById, ncTableMeta, clientsTable, apiVersion,
//   reportOpsError, webhookUri(env) }

export const SHOPIFY_SYNC_WEBHOOK_TOPICS={
  read_orders:['orders/create','orders/updated','orders/paid','orders/cancelled','orders/fulfilled','fulfillments/create','fulfillments/update'],
  read_products:['products/create','products/update','products/delete'],
  read_inventory:['inventory_levels/update'],
};

const ORDER_COLUMNS=[
  ['client_id','SingleLineText'],['shop','SingleLineText'],['shopify_order_id','SingleLineText'],
  ['name','SingleLineText'],['created_at','SingleLineText'],['updated_at','SingleLineText'],
  ['customer_name','SingleLineText'],['customer_email','SingleLineText'],['customer_phone','SingleLineText'],
  ['financial_status','SingleLineText'],['fulfillment_status','SingleLineText'],
  ['cancelled_at','SingleLineText'],['cancel_reason','SingleLineText'],
  ['total','Decimal'],['subtotal','Decimal'],['total_discounts','Decimal'],['total_tax','Decimal'],['shipping_total','Decimal'],
  ['currency','SingleLineText'],['items_count','Number'],['line_items_json','LongText'],
  ['shipping_address','LongText'],['fulfillments_json','LongText'],['tags','SingleLineText'],
  ['note','LongText'],['source_name','SingleLineText'],['gateway','SingleLineText'],['order_status_url','LongText'],
];
const INVENTORY_COLUMNS=[
  ['client_id','SingleLineText'],['shop','SingleLineText'],['shopify_product_id','SingleLineText'],
  ['shopify_variant_id','SingleLineText'],['inventory_item_id','SingleLineText'],
  ['product_title','SingleLineText'],['variant_title','SingleLineText'],['sku','SingleLineText'],
  ['barcode','SingleLineText'],['price','Decimal'],['compare_at_price','Decimal'],
  ['product_type','SingleLineText'],['vendor','SingleLineText'],['product_status','SingleLineText'],
  ['handle','SingleLineText'],['image_url','LongText'],['available','Number'],['tracked','SingleLineText'],
  ['levels_json','LongText'],['updated_at','SingleLineText'],
];

const _tableIds={};
async function ensureTable(env, deps, title, columns){
  if(_tableIds[title]) return _tableIds[title];
  const {info}=await deps.ncTableMeta(env, deps.clientsTable);
  const baseId=info.base_id;
  const tablesR=await deps.ncFetch(env, `api/v2/meta/bases/${baseId}/tables`);
  const tables=await tablesR.json().catch(()=>({list:[]}));
  let table=(tables.list||[]).find(t=>t.title===title);
  if(!table){
    const createR=await deps.ncFetch(env, `api/v2/meta/bases/${baseId}/tables`, {method:'POST', body:{
      title, columns:columns.map(([name, uidt])=>({column_name:name, title:name, uidt})),
    }});
    table=await createR.json().catch(()=>null);
    if(!table?.id) throw new Error(`Failed to auto-create the ${title} table in NocoDB`);
  }
  _tableIds[title]=table.id;
  return table.id;
}
const ordersTable=(env, deps)=>ensureTable(env, deps, 'shopify_orders', ORDER_COLUMNS);
const inventoryTable=(env, deps)=>ensureTable(env, deps, 'shopify_inventory', INVENTORY_COLUMNS);

const num=v=>{ const n=Number(v); return Number.isFinite(n)?n:0; };
const idStr=v=>(v===null||v===undefined||v==='')?'':String(v);
const personName=p=>[p?.first_name, p?.last_name].filter(Boolean).join(' ');

// ── Pure mappers (exported for tests) ─────────────────────────────────────────────────────────
export function shopifyFulfillmentEntry(f){
  return {
    id:idStr(f?.id), status:f?.status||'', shipment_status:f?.shipment_status||'',
    company:f?.tracking_company||'', number:f?.tracking_number||(f?.tracking_numbers||[])[0]||'',
    url:f?.tracking_url||(f?.tracking_urls||[])[0]||'', created_at:f?.created_at||'', updated_at:f?.updated_at||'',
  };
}

export function shopifyOrderRow(clientId, shop, o){
  const addr=o?.shipping_address||null;
  const lineItems=(o?.line_items||[]).map(li=>({
    title:li.title||'', variant_title:li.variant_title||'', sku:li.sku||'',
    quantity:num(li.quantity), price:num(li.price), variant_id:idStr(li.variant_id), product_id:idStr(li.product_id),
  }));
  return {
    client_id:String(clientId), shop, shopify_order_id:idStr(o?.id),
    name:o?.name||('#'+(o?.order_number||o?.id||'')),
    created_at:o?.created_at||'', updated_at:o?.updated_at||o?.created_at||'',
    customer_name:personName(o?.customer)||personName(addr)||personName(o?.billing_address),
    customer_email:o?.email||o?.contact_email||o?.customer?.email||'',
    customer_phone:o?.phone||addr?.phone||o?.customer?.phone||o?.billing_address?.phone||'',
    financial_status:o?.financial_status||'',
    fulfillment_status:o?.fulfillment_status||'unfulfilled',
    cancelled_at:o?.cancelled_at||'', cancel_reason:o?.cancel_reason||'',
    total:num(o?.total_price), subtotal:num(o?.subtotal_price), total_discounts:num(o?.total_discounts), total_tax:num(o?.total_tax),
    shipping_total:(o?.shipping_lines||[]).reduce((s, l)=>s+num(l.price), 0),
    currency:o?.currency||'',
    items_count:lineItems.reduce((s, li)=>s+li.quantity, 0),
    line_items_json:JSON.stringify(lineItems),
    shipping_address:addr?JSON.stringify({
      name:personName(addr), address1:addr.address1||'', address2:addr.address2||'', city:addr.city||'',
      province:addr.province||'', zip:addr.zip||'', country:addr.country||'', phone:addr.phone||'',
    }):'',
    fulfillments_json:JSON.stringify((o?.fulfillments||[]).map(shopifyFulfillmentEntry)),
    tags:o?.tags||'', note:o?.note||'', source_name:o?.source_name||'',
    gateway:(o?.payment_gateway_names||[]).join(', '),
    order_status_url:o?.order_status_url||'',
  };
}

// Webhooks can arrive out of order (Shopify retries, parallel deliveries) — never let an older
// payload overwrite a newer one already stored.
export function shopifyIsStale(existingUpdatedAt, incomingUpdatedAt){
  const a=Date.parse(existingUpdatedAt||''), b=Date.parse(incomingUpdatedAt||'');
  return Number.isFinite(a)&&Number.isFinite(b)&&b<a;
}

// Merges one fulfillments/* webhook into an order row's stored fulfillments list.
export function shopifyMergeFulfillment(fulfillmentsJson, f){
  let list=[]; try{ list=JSON.parse(fulfillmentsJson||'[]'); }catch(e){}
  if(!Array.isArray(list)) list=[];
  const entry=shopifyFulfillmentEntry(f);
  const i=list.findIndex(x=>x.id===entry.id);
  if(i>=0) list[i]={...list[i], ...entry}; else list.push(entry);
  return JSON.stringify(list);
}

export function shopifyInventoryRows(clientId, shop, p){
  const images=p?.images||[];
  const imageFor=v=>{
    const own=v?.image_id?images.find(im=>String(im.id)===String(v.image_id)):null;
    return own?.src||p?.image?.src||images[0]?.src||'';
  };
  return (p?.variants||[]).map(v=>({
    client_id:String(clientId), shop, shopify_product_id:idStr(p.id), shopify_variant_id:idStr(v.id),
    inventory_item_id:idStr(v.inventory_item_id),
    product_title:p.title||'', variant_title:(v.title&&v.title!=='Default Title')?v.title:'',
    sku:v.sku||'', barcode:v.barcode||'', price:num(v.price), compare_at_price:num(v.compare_at_price),
    product_type:p.product_type||'', vendor:p.vendor||'', product_status:p.status||'active', handle:p.handle||'',
    image_url:imageFor(v), available:num(v.inventory_quantity),
    tracked:v.inventory_management?'Yes':'No',
    updated_at:v.updated_at||p.updated_at||new Date().toISOString(),
  }));
}

// /inventory_levels.json response → per-location map + total for one inventory item.
export function shopifyLevelsSummary(levels, inventoryItemId){
  const mine=(levels||[]).filter(l=>String(l.inventory_item_id)===String(inventoryItemId));
  const byLocation={};
  mine.forEach(l=>{ byLocation[String(l.location_id)]=num(l.available); });
  return {available:Object.values(byLocation).reduce((s, n)=>s+n, 0), levels_json:JSON.stringify(byLocation)};
}

// Shopify REST pagination: Link: <https://…?page_info=abc&limit=250>; rel="next"
export function shopifyNextPageInfo(linkHeader){
  const m=String(linkHeader||'').split(',').find(part=>/rel="next"/.test(part));
  if(!m) return '';
  const u=m.match(/<([^>]+)>/);
  if(!u) return '';
  try{ return new URL(u[1]).searchParams.get('page_info')||''; }catch(e){ return ''; }
}

// ── NocoDB helpers ────────────────────────────────────────────────────────────────────────────
async function listAll(env, deps, tableId, where, fields, max=5000){
  const out=[];
  for(let offset=0; offset<max; offset+=1000){
    const qs=new URLSearchParams({where, limit:'1000', offset:String(offset)});
    if(fields) qs.set('fields', fields);
    const r=await deps.ncFetch(env, `api/v2/tables/${tableId}/records?${qs.toString()}`);
    if(!r.ok) break;
    const data=await r.json().catch(()=>({}));
    const list=data?.list||[];
    out.push(...list);
    if(list.length<1000) break;
  }
  return out;
}
async function bulkWrite(env, deps, tableId, method, rows){
  for(let i=0; i<rows.length; i+=100){
    const r=await deps.ncFetch(env, `api/v2/tables/${tableId}/records`, {method, body:rows.slice(i, i+100)});
    if(!r.ok){
      const data=await r.json().catch(()=>({}));
      throw new Error(`NocoDB ${method} ${r.status}: ${data?.msg||data?.error||''}`);
    }
  }
}
const scopeWhere=(clientId, shop)=>`(client_id,eq,${clientId})~and(shop,eq,${shop})`;

async function upsertOrders(env, deps, c, orders){
  const tableId=await ordersTable(env, deps);
  const shop=c.shopify_shop_domain;
  const rows=orders.filter(o=>o?.id).map(o=>shopifyOrderRow(c.Id, shop, o));
  if(!rows.length) return 0;
  let existing;
  if(rows.length===1){
    const r=await deps.ncFetch(env, `api/v2/tables/${tableId}/records?where=${encodeURIComponent(`${scopeWhere(c.Id, shop)}~and(shopify_order_id,eq,${rows[0].shopify_order_id})`)}&limit=1&fields=Id,shopify_order_id,updated_at`);
    existing=((await r.json().catch(()=>({})))?.list)||[];
  }else existing=await listAll(env, deps, tableId, scopeWhere(c.Id, shop), 'Id,shopify_order_id,updated_at');
  const byId=new Map(existing.map(e=>[String(e.shopify_order_id), e]));
  const creates=[], updates=[];
  rows.forEach(row=>{
    const e=byId.get(row.shopify_order_id);
    if(!e) creates.push(row);
    else if(!shopifyIsStale(e.updated_at, row.updated_at)) updates.push({Id:e.Id, ...row});
  });
  await bulkWrite(env, deps, tableId, 'POST', creates);
  await bulkWrite(env, deps, tableId, 'PATCH', updates);
  return creates.length+updates.length;
}

async function upsertProducts(env, deps, c, products, {replaceAll=false}={}){
  const tableId=await inventoryTable(env, deps);
  const shop=c.shopify_shop_domain;
  const rows=products.flatMap(p=>shopifyInventoryRows(c.Id, shop, p));
  let where=scopeWhere(c.Id, shop);
  if(!replaceAll&&products.length===1) where+=`~and(shopify_product_id,eq,${products[0].id})`;
  const existing=await listAll(env, deps, tableId, where, 'Id,shopify_variant_id,shopify_product_id');
  const byVariant=new Map(existing.map(e=>[String(e.shopify_variant_id), e]));
  const keep=new Set(rows.map(r=>r.shopify_variant_id));
  const creates=[], updates=[];
  rows.forEach(row=>{ const e=byVariant.get(row.shopify_variant_id); if(e) updates.push({Id:e.Id, ...row}); else creates.push(row); });
  // A webhook carries one product: drop its variants that no longer exist. A full resync replaces
  // the whole catalog, so anything Shopify no longer returns is gone.
  const touched=new Set(products.map(p=>String(p.id)));
  const deletes=existing.filter(e=>!keep.has(String(e.shopify_variant_id))&&(replaceAll||touched.has(String(e.shopify_product_id)))).map(e=>({Id:e.Id}));
  await bulkWrite(env, deps, tableId, 'POST', creates);
  await bulkWrite(env, deps, tableId, 'PATCH', updates);
  await bulkWrite(env, deps, tableId, 'DELETE', deletes);
  return rows.length;
}

async function shopifyGet(env, deps, c, path){
  return fetch(`https://${c.shopify_shop_domain}/admin/api/${deps.apiVersion}${path}`, {headers:{'X-Shopify-Access-Token':c.shopify_access_token}});
}

async function grantedScopes(env, deps, c){
  const r=await fetch(`https://${c.shopify_shop_domain}/admin/oauth/access_scopes.json`, {headers:{'X-Shopify-Access-Token':c.shopify_access_token}});
  if(!r.ok) return null;
  const data=await r.json().catch(()=>({}));
  // write_* implies read_* in Shopify's scope model.
  return new Set((data?.access_scopes||[]).map(s=>String(s.handle).replace(/^write_/, 'read_')));
}

// ── Webhook entry (called by worker.js handleShopifyWebhook after its own handling) ─────────────
export async function shopifySyncOnWebhook(env, deps, c, topic, data){
  try{
    if(String(topic).startsWith('orders/')){
      await upsertOrders(env, deps, c, [data]);
    }else if(topic==='fulfillments/create'||topic==='fulfillments/update'){
      const tableId=await ordersTable(env, deps);
      const r=await deps.ncFetch(env, `api/v2/tables/${tableId}/records?where=${encodeURIComponent(`${scopeWhere(c.Id, c.shopify_shop_domain)}~and(shopify_order_id,eq,${data.order_id})`)}&limit=1&fields=Id,fulfillments_json`);
      const row=((await r.json().catch(()=>({})))?.list||[])[0];
      if(row) await deps.ncFetch(env, `api/v2/tables/${tableId}/records`, {method:'PATCH', body:{Id:row.Id, fulfillments_json:shopifyMergeFulfillment(row.fulfillments_json, data)}});
    }else if(topic==='products/create'||topic==='products/update'){
      await upsertProducts(env, deps, c, [data]);
    }else if(topic==='products/delete'){
      const tableId=await inventoryTable(env, deps);
      const rows=await listAll(env, deps, tableId, `${scopeWhere(c.Id, c.shopify_shop_domain)}~and(shopify_product_id,eq,${data.id})`, 'Id');
      await bulkWrite(env, deps, tableId, 'DELETE', rows.map(r=>({Id:r.Id})));
    }else if(topic==='inventory_levels/update'){
      // The payload has one location's level; re-read every location so `available` stays a true total.
      const tableId=await inventoryTable(env, deps);
      const rows=await listAll(env, deps, tableId, `${scopeWhere(c.Id, c.shopify_shop_domain)}~and(inventory_item_id,eq,${data.inventory_item_id})`, 'Id');
      if(!rows.length) return;
      const lr=await shopifyGet(env, deps, c, `/inventory_levels.json?inventory_item_ids=${data.inventory_item_id}&limit=250`);
      const levels=lr.ok?((await lr.json().catch(()=>({})))?.inventory_levels||[]):[data];
      const sum=shopifyLevelsSummary(levels, data.inventory_item_id);
      await bulkWrite(env, deps, tableId, 'PATCH', rows.map(r=>({Id:r.Id, ...sum, updated_at:data.updated_at||new Date().toISOString()})));
    }
  }catch(e){ await deps.reportOpsError(env, `shopifySyncOnWebhook ${topic}`, e, {clientId:c.Id}); }
}

// ── Routes ────────────────────────────────────────────────────────────────────────────────────
// client_id-keyed like the rest of /ecom/* (see worker.js handleEcomList) — ecom.html has no
// session of its own. Only this client's own synced rows are ever returned; the access token
// never leaves the Worker.
async function clientFor(env, deps, clientId){
  if(!clientId) return {error:deps.json({error:'client_id required'}, 400)};
  const c=await deps.getClientById(env, clientId);
  if(!c) return {error:deps.json({error:'Client not found'}, 404)};
  return {c, connected:!!(c.shopify_shop_domain&&c.shopify_access_token)};
}

async function handleStatus(env, deps, clientId){
  const {c, connected, error}=await clientFor(env, deps, clientId);
  if(error) return error;
  if(!connected) return deps.json({connected:false});
  const scopes=await grantedScopes(env, deps, c).catch(()=>null);
  return deps.json({
    connected:true, shop:c.shopify_shop_domain, connected_at:c.shopify_connected_at||'',
    scopes:scopes?{orders:scopes.has('read_orders'), products:scopes.has('read_products'), inventory:scopes.has('read_inventory')}:null,
  });
}

async function handleList(env, deps, clientId, kind){
  const {c, connected, error}=await clientFor(env, deps, clientId);
  if(error) return error;
  if(!connected) return deps.json({connected:false, list:[]});
  const tableId=kind==='orders'?await ordersTable(env, deps):await inventoryTable(env, deps);
  const list=await listAll(env, deps, tableId, scopeWhere(c.Id, c.shopify_shop_domain));
  if(kind==='orders') list.sort((a, b)=>String(b.created_at).localeCompare(String(a.created_at)));
  else list.sort((a, b)=>String(a.product_title).localeCompare(String(b.product_title))||String(a.variant_title).localeCompare(String(b.variant_title)));
  return deps.json({connected:true, shop:c.shopify_shop_domain, list});
}

async function fetchPaged(env, deps, c, path, key, maxPages){
  const out=[];
  let pageInfo='';
  for(let page=0; page<maxPages; page++){
    const p=pageInfo?`${path.split('?')[0]}?limit=250&page_info=${encodeURIComponent(pageInfo)}`:path;
    const r=await shopifyGet(env, deps, c, p);
    if(!r.ok) return {items:out, status:r.status};
    const data=await r.json().catch(()=>({}));
    out.push(...(data?.[key]||[]));
    pageInfo=shopifyNextPageInfo(r.headers.get('Link'));
    if(!pageInfo) break;
  }
  return {items:out, status:200};
}

async function handleResync(request, env, deps){
  const body=await request.json().catch(()=>({}));
  const {c, connected, error}=await clientFor(env, deps, String(body.client_id||''));
  if(error) return error;
  if(!connected) return deps.json({error:'Connect Shopify first (Settings → Integrations).'}, 400);
  const scopes=await grantedScopes(env, deps, c);
  if(!scopes) return deps.json({error:'Shopify rejected the stored access token — disconnect and connect Shopify again.'}, 502);

  // Register any webhook this store is missing (stores connected before this module only had
  // the order/checkout set). Topics need their scope granted, so ungranted ones are skipped.
  const hooksR=await shopifyGet(env, deps, c, '/webhooks.json?limit=250');
  const have=new Set(hooksR.ok?((await hooksR.json().catch(()=>({})))?.webhooks||[]).map(w=>w.topic):[]);
  const want=Object.entries(SHOPIFY_SYNC_WEBHOOK_TOPICS).filter(([scope])=>scopes.has(scope)).flatMap(([, topics])=>topics);
  const address=deps.webhookUri(env);
  await Promise.all(want.filter(t=>!have.has(t)).map(topic=>
    fetch(`https://${c.shopify_shop_domain}/admin/api/${deps.apiVersion}/webhooks.json`, {
      method:'POST', headers:{'X-Shopify-Access-Token':c.shopify_access_token, 'Content-Type':'application/json'},
      body:JSON.stringify({webhook:{topic, address, format:'json'}}),
    }).catch(()=>{})
  ));

  const out={ok:true, orders:0, variants:0, missing_scopes:[]};
  try{
    if(scopes.has('read_orders')){
      const since=new Date(Date.now()-90*86400000).toISOString();
      const {items}=await fetchPaged(env, deps, c, `/orders.json?status=any&limit=250&updated_at_min=${encodeURIComponent(since)}`, 'orders', 4);
      out.orders=await upsertOrders(env, deps, c, items);
    }else out.missing_scopes.push('read_orders');
    if(scopes.has('read_products')){
      const {items, status}=await fetchPaged(env, deps, c, '/products.json?limit=250', 'products', 8);
      if(status===200) out.variants=await upsertProducts(env, deps, c, items, {replaceAll:true});
    }else out.missing_scopes.push('read_products');
    if(!scopes.has('read_inventory')) out.missing_scopes.push('read_inventory');
  }catch(e){
    await deps.reportOpsError(env, 'shopify resync', e, {clientId:c.Id});
    return deps.json({error:'Sync failed: '+e.message}, 502);
  }
  return deps.json(out);
}

export async function shopifySyncHandleRoute(request, env, deps, url){
  const p=url.pathname, m=request.method;
  const clientId=String(url.searchParams.get('client_id')||'');
  if(p==='/ecom/shopify/status'&&m==='GET') return handleStatus(env, deps, clientId);
  if(p==='/ecom/shopify/orders'&&m==='GET') return handleList(env, deps, clientId, 'orders');
  if(p==='/ecom/shopify/stock'&&m==='GET') return handleList(env, deps, clientId, 'stock');
  if(p==='/ecom/shopify/resync'&&m==='POST') return handleResync(request, env, deps);
  return null;
}
