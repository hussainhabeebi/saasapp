// Ecom → 🌐 Website Sync (website-sync.js): mapping, matching existing items, deletes, signatures,
// and the webhook → Ecom flow against in-memory fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wsProductFields, wsProductPlan, wsOrderFields, wsOrderPlan, wsOrderStatus, wsCategoryPlan,
  wsInventoryTotals, wsExtractList, wsVerifySignature, wsHmacHex, wsDue, wsHandleRoute, wsSync,
} from './website-sync.js';

const P4L={id:41, name:'Linen Abaya', sku:'AB-41', price:'450.00', sale_price:'399.00', status:'active',
  category:{id:3, name:'Abayas'}, brand:'4L', description:'<p>Soft <b>linen</b></p>',
  images:[{url:'https://cdn.4l.qa/a.jpg'}, 'https://cdn.4l.qa/b.jpg'], url:'https://4lfashion.com.qa/p/linen-abaya',
  variants:[{sku:'AB-41-S-BLK', size:'S', color:'Black', stock:3}, {sku:'AB-41-M-BLK', size:'M', color:'Black', stock:2}, {sku:'AB-41-M-BEI', size:'M', colour:'Beige', stock:-1}]};

test('a website product maps to Ecom fields: sale price, summed variant stock, sizes/colours, photos, link', ()=>{
  const f=wsProductFields(P4L, {baseUrl:'https://4lfashion.com.qa/api/v1', currency:'QAR'});
  assert.equal(f.name, 'Linen Abaya');
  assert.equal(f.website_product_id, '41');
  assert.equal(f.price, 399);
  assert.equal(f.stock, 5);
  assert.equal(f.status, 'active');
  assert.equal(f.category, 'Abayas');
  assert.equal(f.size, 'S, M');
  assert.equal(f.color, 'Black, Beige');
  assert.equal(f.description, 'Soft linen');
  assert.equal(f.image_url, 'https://cdn.4l.qa/a.jpg');
  assert.equal(f.image_url_2, 'https://cdn.4l.qa/b.jpg');
  assert.equal(f.product_link, 'https://4lfashion.com.qa/p/linen-abaya');
  assert.equal(f._currency, 'QAR');
  assert.equal(wsProductFields({id:1, name:'X', status:'draft'}).status, 'inactive');
  assert.equal(wsProductFields({id:1, name:'X', is_active:false}).status, 'inactive');
  assert.equal(wsProductFields({name:'no id'}), null);
});

test('existing Ecom products are adopted by website id, then SKU, then name — never duplicated', ()=>{
  const existing=[
    {Id:1, name:'Old name', sku:'AB-41', price:450},                 // matched by SKU
    {Id:2, name:'Silk Scarf', sku:'', price:80},                    // matched by name
    {Id:3, name:'Shopify thing', sku:'SC-1', shopify_product_id:'9'}, // Shopify's — never adopted
    {Id:4, name:'Hand made', sku:'HM-1'},                            // untouched
  ];
  const {creates, updates, deletes}=wsProductPlan(existing, [P4L, {id:42, name:'silk scarf', price:90}, {id:43, name:'New Kaftan', sku:'SC-1', price:200}]);
  assert.deepEqual(updates.map(u=>[u.Id, u.website_product_id]), [[1, '41'], [2, '42']]);
  assert.equal(creates.length, 1);
  assert.equal(creates[0].name, 'New Kaftan');
  assert.deepEqual(deletes, []);
});

test('deleted on the website → deleted here; a full sync deletes linked products it no longer sees, never hand-made ones', ()=>{
  const existing=[
    {Id:1, name:'A', website_product_id:'1', status:'active', price:10},
    {Id:2, name:'B', website_product_id:'2', status:'active', price:10},
    {Id:3, name:'C', website_product_id:'3', status:'active', price:10},
    {Id:9, name:'Mine', status:'active'},
  ];
  assert.deepEqual(wsProductPlan(existing, [], {deletedIds:['2']}).deletes, [2]);
  assert.deepEqual(wsProductPlan(existing, [{id:3, name:'C', deleted_at:'2026-11-20'}]).deletes, [3]);
  const full=wsProductPlan(existing, [{id:1, name:'A', price:10, status:'active'}], {replaceAll:true});
  assert.deepEqual(full.deletes.sort(), [2, 3]);
  assert.deepEqual(wsProductPlan(existing, [{id:1, name:'A', price:10}], {replaceAll:true, deleteMissing:false}).deletes, []);
  // Unchanged product → nothing written.
  assert.equal(full.updates.length, 0);
});

test('orders: mapping, status, matching existing by number, never moving status backwards', ()=>{
  const o={id:'o-77', order_number:'1077', status:'processing', payment_status:'paid', source:'pos',
    customer:{first_name:'Sara', last_name:'Ali', phone:'+974 5555 1234', email:'s@x.qa'},
    shipping_address:{address1:'Street 5', city:'Doha', country:'Qatar'}, total:'798.00', currency:'QAR',
    items:[{name:'Linen Abaya', quantity:2, price:'399.00', sku:'AB-41-S-BLK', size:'S'}], created_at:'2026-11-20T08:00:00Z', updated_at:'2026-11-20T09:00:00Z'};
  const f=wsOrderFields(7, o);
  assert.equal(f.order_id, '#1077');
  assert.equal(f.status, 'processing');
  assert.equal(f.customer_name, 'Sara Ali');
  assert.equal(f.customer_phone, '+97455551234');
  assert.equal(f.items, '2x Linen Abaya (S)');
  assert.equal(f.total, 798);
  assert.equal(f.delivery_address, 'Street 5, Doha, Qatar');
  assert.equal(f.order_date, '2026-11-20');
  assert.equal(wsOrderStatus({status:'cancelled'}), 'cancelled');
  assert.equal(wsOrderStatus({status:'shipped'}), 'shipped');
  assert.equal(wsOrderStatus({status:'completed'}), 'delivered');
  assert.equal(wsOrderStatus({items:[{name:'x', cancelled:true}]}), 'cancelled');

  const existing=[{Id:5, order_id:'#1077', status:'delivered'}, {Id:6, website_order_id:'o-78', status:'received', order_id:'#1078'}];
  const plan=wsOrderPlan(7, existing, [o, {id:'o-78', order_number:'1078', status:'cancelled'}, {id:'o-79', order_number:'1079'}]);
  assert.deepEqual(plan.updates.map(u=>[u.Id, u.status, u.website_order_id]), [[5, 'delivered', 'o-77'], [6, 'cancelled', 'o-78']]);
  assert.equal(plan.creates.length, 1);
  // The same order twice in one batch → one create with the later copy.
  const twice=wsOrderPlan(7, [], [{id:'n1', order_number:'1', status:'pending'}, {id:'n1', order_number:'1', status:'shipped'}]);
  assert.equal(twice.creates.length, 1);
  assert.equal(twice.creates[0].status, 'shipped');
});

test('categories: created by name, only sync-created ones are deleted on a full sync', ()=>{
  const existing=[{id:1, name:'Abayas'}, {id:2, name:'Old Sync Cat'}, {id:3, name:'Hand Made'}];
  const plan=wsCategoryPlan(existing, ['abayas', 'Kaftans', 'Kaftans'], [2], {full:true});
  assert.deepEqual(plan.create, ['Kaftans']);
  assert.deepEqual(plan.remove, [2]);
  assert.deepEqual(wsCategoryPlan(existing, ['Kaftans'], [2]).remove, [], 'webhooks never delete categories');
});

test('inventory rows sum per product; list extraction handles common wrappers', ()=>{
  const t=wsInventoryTotals([{product_id:41, size:'S', colour:'Black', stock:3}, {product_id:41, size:'M', stock:2}, {product_id:42, quantity:'7'}]);
  assert.equal(t.get('41'), 5); assert.equal(t.get('42'), 7);
  assert.equal(wsExtractList({data:[1, 2]}).length, 2);
  assert.equal(wsExtractList({data:{products:[1]}}).length, 1);
  assert.equal(wsExtractList([1, 2, 3]).length, 3);
});

test('webhook signature: sha256=HMAC(secret, timestamp + "." + body), fresh timestamps only', async ()=>{
  const body='{"id":"e1","event":"order.created","data":{}}';
  const ts='1795000000';
  const sig='sha256='+await wsHmacHex('s3cret', `${ts}.${body}`);
  const h=new Headers({'X-4L-Timestamp':ts, 'X-4L-Signature':sig});
  assert.equal(await wsVerifySignature('s3cret', h, body, 1795000000*1000+5000), '');
  assert.equal(await wsVerifySignature('wrong', h, body, 1795000000*1000), 'bad signature');
  assert.equal(await wsVerifySignature('s3cret', h, body, (1795000000+3600)*1000), 'timestamp too old');
  assert.equal(await wsVerifySignature('s3cret', new Headers(), body), 'missing signature headers');
});

test('due: interval elapsed, not paused, not already running', ()=>{
  const now=Date.parse('2026-11-21T10:00:00Z');
  assert.equal(wsDue({enabled:1, sync_minutes:60, last_sync_at:'2026-11-21T08:59:00Z'}, now), true);
  assert.equal(wsDue({enabled:1, sync_minutes:60, last_sync_at:'2026-11-21T09:30:00Z'}, now), false);
  assert.equal(wsDue({enabled:0, sync_minutes:60}, now), false);
  assert.equal(wsDue({enabled:1, sync_minutes:15, last_status:'running', last_sync_at:'2026-11-21T09:55:00Z'}, now), false);
});

// ── End to end with fakes: a D1 that understands just the statements website-sync.js sends ─────
function fakeDb(){
  const cfgs=new Map(), events=new Set();
  const stmt=(sql, args)=>({
    async run(){
      if(/^CREATE/.test(sql)) return {meta:{}};
      if(/^INSERT INTO ecom_website_sync \(/.test(sql)){
        const cols=sql.match(/\(([^)]*)\) VALUES/)[1].split(',').map(x=>x.trim());
        const row={}; cols.forEach((c, i)=>{ row[c]=args[i]; }); cfgs.set(Number(row.client_id), row);
        return {meta:{changes:1}};
      }
      if(/^INSERT OR IGNORE INTO ecom_website_sync_events/.test(sql)){ const k=args[0]+'|'+args[1]; const had=events.has(k); events.add(k); return {meta:{changes:had?0:1}}; }
      if(/^DELETE FROM ecom_website_sync_events WHERE client_id=\? AND/.test(sql)){ events.delete(args[0]+'|'+args[1]); return {meta:{}}; }
      if(/^UPDATE ecom_website_sync SET/.test(sql)){
        const cols=sql.match(/SET (.*) WHERE/)[1].split(', ').map(x=>x.split('=')[0]);
        const cid=args[args.length-1]; const row=cfgs.get(Number(cid)); if(!row) return {meta:{}};
        let i=0; cols.forEach(c=>{ const lit=sql.match(new RegExp(`${c}='([^']*)'`)); row[c]=lit?lit[1]:args[i++]; });
        return {meta:{}};
      }
      return {meta:{}};
    },
    async first(){ if(/WHERE webhook_token=\?/.test(sql)) return [...cfgs.values()].find(c=>c.webhook_token===args[0])||null; if(/WHERE client_id=\?/.test(sql)) return cfgs.get(Number(args[0]))||null; return null; },
    async all(){ return {results:[...cfgs.values()]}; },
  });
  return {cfgs, prepare:sql=>({bind:(...a)=>stmt(sql, a), ...stmt(sql, [])})};
}
function fakeDeps(site){
  const products=[], orders=[], cats=[], deletedFromMirror=[];
  let nextId=100;
  const deps={
    json:(d, status=200)=>new Response(JSON.stringify(d), {status, headers:{'Content-Type':'application/json'}}),
    requireSession:async()=>({cid:7}), getClientById:async()=>({Id:7}), reportOpsError:async()=>{},
    encrypt:async(env, s)=>'enc:'+s, decrypt:async(env, s)=>String(s).replace(/^enc:/, ''),
    webhookBase:()=>'https://w.example', ecomTable:async(env, cid, kind)=>kind,
    listRows:async(env, table, cid, where)=>{
      const rows=table==='products'?products:orders;
      const m=String(where||'').match(/\((\w+),eq,([^)]*)\)/);
      return m?rows.filter(r=>String(r[m[1]])===m[2]):rows.slice();
    },
    bulkWrite:async(env, table, method, rows)=>{
      const list=table==='products'?products:orders;
      if(method==='POST') return rows.map(r=>{ const row={...r, Id:nextId++}; list.push(row); return {Id:row.Id}; });
      if(method==='PATCH') rows.forEach(r=>Object.assign(list.find(x=>x.Id===r.Id), r));
      if(method==='DELETE') rows.forEach(r=>list.splice(list.findIndex(x=>x.Id===r.Id), 1));
      return [];
    },
    ensureProductFields:async()=>{}, ensureOrderFields:async()=>{},
    productsSaved:async()=>{}, productsDeleted:async(env, cid, ids)=>deletedFromMirror.push(...ids),
    listCategories:async()=>cats.slice(), createCategory:async(env, cid, name)=>{ const id=cats.length+1; cats.push({id, name}); return id; },
    deleteCategory:async(env, cid, id)=>cats.splice(cats.findIndex(c=>c.id===id), 1),
    fetch:async(url, init)=>{
      assert.equal(init.headers.Authorization, 'Bearer 4lf_key');
      const u=new URL(url);
      const path=u.pathname.replace('/api/v1', '');
      const body=site(path, u.searchParams);
      return body===undefined?new Response('{}', {status:404}):new Response(JSON.stringify(body), {status:200});
    },
  };
  return {deps, products, orders, cats, deletedFromMirror};
}

test('connect → full sync → webhooks: creates, adopts, updates, deletes', async ()=>{
  let catalog=[P4L, {id:42, name:'Silk Scarf', price:80, stock:4, category:'Scarves'}];
  const siteOrders=[{id:'o1', order_number:'1001', status:'paid', total:'399', items:[{name:'Linen Abaya', quantity:1, price:399}], updated_at:'2026-11-20T10:00:00Z', customer:{name:'Sara', phone:'+97455550000'}}];
  const site=(path, qs)=>{
    if(path==='/ping') return {ok:true};
    if(path==='/products') return {data:qs.get('page')==='1'?catalog:[], meta:{last_page:1}};
    if(path==='/orders') return {data:qs.get('page')==='1'?siteOrders:[]};
    if(path.startsWith('/products/')) return {data:catalog.find(p=>String(p.id)===path.split('/')[2])};
    if(path.startsWith('/orders/')) return {data:siteOrders.find(o=>o.id===path.split('/')[2])};
    if(path==='/inventory') return {data:[]};
  };
  const {deps, products, orders, cats, deletedFromMirror}=fakeDeps(site);
  products.push({Id:1, name:'Silk Scarf', sku:'', price:70, status:'active'}); // hand-made, to be adopted
  const env={DB:fakeDb()};
  const call=async(path, body, method='POST', headers={})=>{
    const r=await wsHandleRoute(new Request('https://w.example'+path, {method, headers, body:method==='GET'?undefined:(typeof body==='string'?body:JSON.stringify(body||{}))}), env, deps, new URL('https://w.example'+path));
    return {status:r.status, body:await r.json()};
  };

  const c=await call('/ecom/website/connect', {base_url:'https://4lfashion.com.qa/api/v1/', api_key:'4lf_key', currency:'QAR', webhook_secret:'whsec'});
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.result.ok, true, JSON.stringify(c.body.result));
  assert.equal(products.length, 2, 'scarf adopted, abaya created');
  assert.equal(products.find(p=>p.Id===1).website_product_id, '42');
  assert.equal(products.find(p=>p.website_product_id==='41').currency, 'QAR');
  assert.deepEqual(cats.map(c=>c.name).sort(), ['Abayas', 'Scarves']);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].status, 'processing');
  assert.equal(c.body.config.key_hint, '••••', 'short keys are fully masked');
  assert.equal(JSON.stringify(c.body).includes('4lf_key'), false, 'the key never goes back to the browser');
  assert.match(c.body.config.webhook_url, /^https:\/\/w\.example\/ecom\/website\/hook\/[0-9a-f]{48}$/);
  const hookPath=new URL(c.body.config.webhook_url).pathname;

  // Signed webhook: product deleted on the website → deleted here.
  const send=async(evt)=>{
    const body=JSON.stringify(evt); const ts=String(Math.floor(Date.now()/1000));
    return call(hookPath, body, 'POST', {'X-4L-Event':evt.event, 'X-4L-Timestamp':ts, 'X-4L-Signature':'sha256='+await wsHmacHex('whsec', `${ts}.${body}`)});
  };
  const bad=await call(hookPath, JSON.stringify({id:'x', event:'product.deleted', data:{id:41}}), 'POST', {'X-4L-Timestamp':String(Math.floor(Date.now()/1000)), 'X-4L-Signature':'sha256=00'});
  assert.equal(bad.status, 401);
  let r=await send({id:'e1', event:'product.deleted', data:{id:41}});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(products.some(p=>p.website_product_id==='41'), false);
  assert.equal(deletedFromMirror.length, 1);
  r=await send({id:'e1', event:'product.deleted', data:{id:41}});
  assert.equal(r.body.duplicate, true);

  // Order cancelled, then the test order deleted.
  siteOrders[0].status='cancelled';
  await send({id:'e2', event:'order.cancelled', data:{id:'o1'}});
  assert.equal(orders[0].status, 'cancelled');
  await send({id:'e3', event:'order.deleted', data:{id:'o1'}});
  assert.equal(orders.length, 0);

  // A product removed from the website without a webhook goes on the next full sync, and the
  // category the sync created for it with it; the adopted hand-made Silk Scarf stays linked.
  catalog=[{id:42, name:'Silk Scarf', price:85, stock:4, category:'Scarves'}];
  products.push({Id:50, name:'Ghost', website_product_id:'99', status:'active'});
  const cfg=await env.DB.prepare('SELECT * FROM ecom_website_sync WHERE client_id=?').bind(7).first();
  const s=await wsSync(env, deps, cfg);
  assert.equal(s.ok, true, s.error);
  assert.deepEqual(products.map(p=>p.Id), [1]);
  assert.equal(products[0].price, 85);
  assert.deepEqual(cats.map(c=>c.name), ['Scarves']);

  // An empty catalogue response deletes nothing.
  catalog=[];
  await wsSync(env, deps, await env.DB.prepare('SELECT * FROM ecom_website_sync WHERE client_id=?').bind(7).first());
  assert.equal(products.length, 1);
});

test('website photos with relative or protocol-relative links are kept (absolute)', async () => {
  const { wsProductFields, wsMediaUrl } = await import('./website-sync.js');
  assert.equal(wsMediaUrl('//cdn.shop.com/a.jpg'), 'https://cdn.shop.com/a.jpg');
  assert.equal(wsMediaUrl('/uploads/a.jpg', 'https://4lfashion.com.qa/'), 'https://4lfashion.com.qa/uploads/a.jpg');
  assert.equal(wsMediaUrl('uploads/a.jpg', ''), '');
  const f = wsProductFields({ id: 'p1', name: 'Floral Embroidery Kurti', url: 'https://4lfashion.com.qa/products/p1',
    images: ['/uploads/k1.jpg', { src: '/uploads/k2.webp' }] }, { baseUrl: 'https://api.4lfashion.com.qa/v1' });
  assert.equal(f.image_url, 'https://4lfashion.com.qa/uploads/k1.jpg');
  assert.equal(f.image_url_2, 'https://4lfashion.com.qa/uploads/k2.webp');
});
