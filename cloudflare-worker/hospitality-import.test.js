// Hospitality → API Import (hospitality-import.js) — mapping of differently-shaped feeds, paging,
// and the sync itself (add / update / unchanged / switched off / back on / deleted-stays-deleted)
// end to end against the real hospitality migrations on node:sqlite. fetch is a recorded fake.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  hiUrlError, hiAuthHeaders, hiMoney, hiMedia, hiMapProperty, hiMapUnits, hiExtractList, hiPageInfo, hiFetchAll,
  hiSyncSource, hiRunDue, hiDue, hiHandleRoute,
} from './hospitality-import.js';

function d1(db){
  return {prepare(sql){
    let args=[];
    const st={
      bind(...a){ args=a.map(v=>v===undefined?null:v); return st; },
      async run(){ const r=db.prepare(sql).run(...args); return {meta:{changes:Number(r.changes), last_row_id:Number(r.lastInsertRowid)}}; },
      async all(){ return {results:db.prepare(sql).all(...args)}; },
      async first(){ return db.prepare(sql).get(...args)||null; },
    };
    return st;
  }};
}
const MIGRATIONS=['0009_hospitality.sql','0010_hospitality_media.sql','0066_resort_properties.sql','0067_hospitality_units_resort_fields.sql',
  '0092_hospitality_property_location.sql','0125_hospitality_api_import.sql'];
function freshDb(){
  const db=new DatabaseSync(':memory:');
  for(const f of MIGRATIONS) db.exec(readFileSync(new URL(`./migrations/${f}`, import.meta.url), 'utf8'));
  return db;
}
const CID=7;
const NOW=Date.parse('2026-10-28T06:00:00Z');
const jsonRes=(data, status=200)=>new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json'}});

function fakeDeps(pages){
  const log={fetches:[]};
  return {
    log,
    json:(data, status)=>jsonRes(data, status||200),
    requireSession:async req=>req.headers.get('Authorization')==='Bearer ok'?{cid:CID}:null,
    getClientById:async()=>({Id:CID, hospitality_enabled:'Yes'}),
    reportOpsError:async(env, where, e)=>{ throw e; },
    encrypt:async(env, plain)=>'enc:'+plain,
    decrypt:async(env, stored)=>String(stored).startsWith('enc:')?String(stored).slice(4):null,
    now:()=>NOW,
    fetch:async(url, init)=>{ log.fetches.push({url, headers:init?.headers}); return pages(new URL(url), init); },
  };
}

// A feed shaped like the one in the request: {data:[…], meta:{page, total_pages}}.
function feed(props){
  return url=>{
    const page=Number(url.searchParams.get('page')||1), limit=Number(url.searchParams.get('limit')||20);
    const slice=props.slice((page-1)*limit, page*limit);
    return jsonRes({data:slice, meta:{page, limit, total:props.length, total_pages:Math.max(1, Math.ceil(props.length/limit))}});
  };
}
const munnar={
  id:12, slug:'tea-valley-resort', name:'Tea Valley Resort', destination:{name:'Munnar'},
  description:'<p>Hilltop resort &amp; spa</p>', amenities:['Pool',{name:'Spa'}],
  images:[{url:'https://cdn.example.com/a.jpg'},'https://cdn.example.com/b.jpg',{url:'https://www.youtube.com/watch?v=x', type:'video'}],
  rooms:[
    {id:'r1', name:'Deluxe Room', price:'₹4,500', max_adults:2, max_children:1, images:['https://cdn.example.com/d.jpg']},
    {id:'r2', name:'Pool Villa', base_price:{amount:12000, currency:'INR'}, capacity:{adults:4, children:2}, weekend_price:14000},
  ],
};
const alleppey={id:13, name:'Lake Houseboat', location:'Alleppey', price_from:9000, currency:'INR', max_guests:6, cover_image:'https://cdn.example.com/h.jpg'};

describe('mapping', ()=>{
  test('urls and auth', ()=>{
    assert.equal(hiUrlError('https://gosanchari.com/api/v1/properties'), '');
    assert.match(hiUrlError('http://gosanchari.com/api'), /https/);
    assert.match(hiUrlError('https://localhost/x'), /reachable/);
    assert.match(hiUrlError('https://192.168.1.4/x'), /reachable/);
    assert.match(hiUrlError('nope'), /full API link/);
    assert.deepEqual(hiAuthHeaders('bearer', 'k1'), {Authorization:'Bearer k1'});
    assert.deepEqual(hiAuthHeaders('x-api-key', 'k1'), {'X-API-Key':'k1'});
    assert.deepEqual(hiAuthHeaders('none', 'k1'), {});
  });
  test('money and media', ()=>{
    assert.equal(hiMoney('₹ 4,500 / night'), 4500);
    assert.equal(hiMoney({amount:'1200.50'}), 1200.5);
    assert.equal(hiMoney('on request'), null);
    const m=hiMedia(munnar);
    assert.deepEqual(m.images, ['https://cdn.example.com/a.jpg','https://cdn.example.com/b.jpg']);
    assert.deepEqual(m.videos, ['https://www.youtube.com/watch?v=x']);
  });
  test('property with rooms', ()=>{
    const p=hiMapProperty(munnar);
    assert.equal(p.external_id, '12');
    assert.equal(p.name, 'Tea Valley Resort');
    assert.equal(p.location, 'Munnar');
    assert.equal(p.description, 'Hilltop resort & spa');
    assert.equal(p.amenities, 'Pool, Spa');
    const units=hiMapUnits(munnar, p);
    assert.equal(units.length, 2);
    assert.deepEqual([units[0].name, units[0].base_rate, units[0].currency, units[0].capacity_adults, units[0].capacity_children, units[0].image_url_1], ['Deluxe Room', 4500, 'INR', 2, 1, 'https://cdn.example.com/d.jpg']);
    assert.deepEqual([units[1].base_rate, units[1].weekend_rate, units[1].capacity_adults, units[1].capacity_children], [12000, 14000, 4, 2]);
    assert.equal(units[1].image_url_1, 'https://cdn.example.com/a.jpg'); // falls back to the property's photos
    assert.equal(units[0].external_id, '12::r1');
  });
  test('property without rooms becomes one unit', ()=>{
    const p=hiMapProperty(alleppey);
    const [u]=hiMapUnits(alleppey, p);
    assert.deepEqual([u.name, u.base_rate, u.capacity_adults, u.external_id], ['Lake Houseboat', 9000, 6, '13::self']);
  });
  test('list wrappers and paging info', ()=>{
    assert.equal(hiExtractList([munnar]).length, 1);
    assert.equal(hiExtractList({properties:[munnar, alleppey]}).length, 2);
    assert.equal(hiExtractList({data:{items:[munnar]}}).length, 1);
    assert.equal(hiExtractList({data:munnar}).length, 1); // single-property endpoint
    assert.deepEqual(hiPageInfo({meta:{total_pages:3}}, 1, 50, 50), {more:true});
    assert.deepEqual(hiPageInfo({meta:{total_pages:3}}, 3, 50, 50), {more:false});
    assert.deepEqual(hiPageInfo({links:{next:'https://x.com/p?page=2'}}, 1, 50, 50), {next:'https://x.com/p?page=2'});
    assert.deepEqual(hiPageInfo({has_more:false}, 1, 50, 50), {more:false});
  });
});

describe('fetching', ()=>{
  test('follows pages and sends the key', async()=>{
    const props=Array.from({length:45}, (_, i)=>({id:i+1, name:`Stay ${i+1}`}));
    const deps=fakeDeps(feed(props));
    const {records, complete}=await hiFetchAll(deps, {url:'https://gosanchari.com/api/v1/properties?limit=20', auth_style:'bearer'}, 'k1');
    assert.equal(records.length, 45);
    assert.equal(complete, true);
    assert.equal(deps.log.fetches.length, 3);
    assert.equal(deps.log.fetches[0].headers.Authorization, 'Bearer k1');
  });
  test('an API that ignores ?page= is read once', async()=>{
    const props=Array.from({length:50}, (_, i)=>({id:i+1, name:`Stay ${i+1}`}));
    const deps=fakeDeps(()=>jsonRes(props));
    const {records}=await hiFetchAll(deps, {url:'https://x.example.com/props', auth_style:'none'}, '');
    assert.equal(records.length, 50);
    assert.equal(deps.log.fetches.length, 2);
  });
  test('never follows a next link to another origin', async()=>{
    const deps=fakeDeps(()=>jsonRes({data:[{id:1, name:'A'}], links:{next:'https://evil.example.net/steal'}}));
    await hiFetchAll(deps, {url:'https://x.example.com/props', auth_style:'bearer'}, 'k1');
    assert.equal(deps.log.fetches.length, 1);
  });
  test('clear errors', async()=>{
    await assert.rejects(hiFetchAll(fakeDeps(()=>jsonRes({error:'bad key'}, 401)), {url:'https://x.example.com/p', auth_style:'bearer'}, 'k'), /refused the key/);
    await assert.rejects(hiFetchAll(fakeDeps(()=>new Response('<html>')), {url:'https://x.example.com/p', auth_style:'bearer'}, 'k'), /did not return JSON/);
  });
});

describe('sync', ()=>{
  let db, env, deps, props;
  const addSource=(o={})=>Number(db.prepare(`INSERT INTO hospitality_api_sources (client_id, name, url, auth_style, api_key_enc, sync_minutes, created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(CID, 'GoSanchari', o.url||'https://gosanchari.com/api/v1/properties', 'bearer', 'enc:k1', o.minutes||60, 'now').lastInsertRowid);
  const src=id=>db.prepare(`SELECT * FROM hospitality_api_sources WHERE id=?`).get(id);
  beforeEach(()=>{
    db=freshDb(); env={DB:d1(db)};
    props=[structuredClone(munnar), structuredClone(alleppey)];
    deps=fakeDeps(url=>feed(props)(url));
  });

  test('imports properties and units, then only writes what changed', async()=>{
    const id=addSource();
    let r=await hiSyncSource(env, deps, src(id));
    assert.equal(r.ok, true, r.error);
    assert.deepEqual([r.counts.properties_added, r.counts.units_added], [2, 3]);
    const p=db.prepare(`SELECT * FROM hospitality_properties WHERE client_id=? ORDER BY name`).all(CID);
    assert.deepEqual(p.map(x=>[x.name, x.location, x.active]), [['Lake Houseboat','Alleppey',1],['Tea Valley Resort','Munnar',1]]);
    const u=db.prepare(`SELECT * FROM hospitality_units WHERE client_id=? ORDER BY base_rate`).all(CID);
    assert.deepEqual(u.map(x=>[x.name, x.base_rate]), [['Deluxe Room',4500],['Lake Houseboat',9000],['Pool Villa',12000]]);
    assert.equal(u[0].property_id, p[1].id);
    assert.equal(src(id).last_status, 'ok');

    r=await hiSyncSource(env, deps, src(id), {nowMs:NOW+3600e3});
    assert.match(r.summary, /No changes/);
    assert.equal(r.counts.units_updated, 0);

    props[0].rooms[0].price=5000;
    r=await hiSyncSource(env, deps, src(id), {nowMs:NOW+7200e3});
    assert.deepEqual([r.counts.units_updated, r.counts.properties_updated], [1, 0]);
    assert.equal(db.prepare(`SELECT base_rate FROM hospitality_units WHERE name='Deluxe Room'`).get().base_rate, 5000);
  });

  test('records leaving the feed are switched off, and back on when they return', async()=>{
    const id=addSource();
    await hiSyncSource(env, deps, src(id));
    const removedRoom=props[0].rooms.pop();
    props.pop(); // the houseboat goes
    let r=await hiSyncSource(env, deps, src(id), {nowMs:NOW+3600e3});
    assert.equal(r.counts.deactivated, 3); // houseboat property + its unit + the villa
    assert.equal(db.prepare(`SELECT active FROM hospitality_units WHERE name='Pool Villa'`).get().active, 0);
    assert.equal(db.prepare(`SELECT active FROM hospitality_properties WHERE name='Lake Houseboat'`).get().active, 0);
    props[0].rooms.push(removedRoom);
    r=await hiSyncSource(env, deps, src(id), {nowMs:NOW+7200e3});
    assert.equal(db.prepare(`SELECT active FROM hospitality_units WHERE name='Pool Villa'`).get().active, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM hospitality_units`).get().n, 3); // reused, not re-created
  });

  test('an empty feed switches nothing off; a deleted record stays deleted', async()=>{
    const id=addSource();
    await hiSyncSource(env, deps, src(id));
    const saved=props; props=[];
    await hiSyncSource(env, deps, src(id), {nowMs:NOW+3600e3});
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM hospitality_units WHERE active=1`).get().n, 3);
    props=saved;
    db.prepare(`DELETE FROM hospitality_units WHERE name='Deluxe Room'`).run();
    const r=await hiSyncSource(env, deps, src(id), {nowMs:NOW+7200e3});
    assert.equal(r.counts.units_added, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM hospitality_units WHERE name='Deluxe Room'`).get().n, 0);
  });

  test('errors are recorded on the source', async()=>{
    const id=addSource();
    deps=fakeDeps(()=>jsonRes({}, 500));
    const r=await hiSyncSource(env, deps, src(id));
    assert.equal(r.ok, false);
    assert.equal(src(id).last_status, 'error');
    assert.match(src(id).last_error, /HTTP 500/);
  });

  test('cron syncs only what is due', async()=>{
    const a=addSource({minutes:60}), b=addSource({minutes:15});
    db.prepare(`UPDATE hospitality_api_sources SET last_sync_at=?, last_status='ok' WHERE id=?`).run(new Date(NOW-20*60000).toISOString(), a);
    db.prepare(`UPDATE hospitality_api_sources SET last_sync_at=?, last_status='ok' WHERE id=?`).run(new Date(NOW-20*60000).toISOString(), b);
    assert.equal(hiDue(src(a), NOW), false);
    assert.equal(hiDue(src(b), NOW), true);
    await hiRunDue(env, deps, NOW);
    assert.equal(src(b).last_sync_at, new Date(NOW).toISOString());
    assert.equal(src(a).last_sync_at, new Date(NOW-20*60000).toISOString());
  });
});

describe('dashboard API', ()=>{
  let db, env, deps;
  const call=async(method, path, body)=>{
    const req=new Request(`https://w.example.com/hospitality/import${path}`, {method, headers:{Authorization:'Bearer ok', 'Content-Type':'application/json'}, body:body?JSON.stringify(body):undefined});
    const r=await hiHandleRoute(req, env, deps, new URL(req.url));
    return {status:r.status, body:await r.json()};
  };
  beforeEach(()=>{ db=freshDb(); env={DB:d1(db)}; deps=fakeDeps(feed([munnar, alleppey])); });

  test('test → create (syncs at once) → list → delete', async()=>{
    let r=await call('POST', '/test', {url:'https://gosanchari.com/api/v1/properties', api_key:'k1', auth_style:'bearer'});
    assert.equal(r.body.ok, true);
    assert.equal(r.body.found, 2);
    assert.equal(r.body.sample[0].units.length, 2);

    r=await call('POST', '/sources', {url:'https://gosanchari.com/api/v1/properties', api_key:'k1secretkey', name:'GoSanchari', sync_minutes:30});
    assert.equal(r.status, 200);
    assert.equal(r.body.result.ok, true);
    assert.equal(r.body.source.has_key, true);
    assert.equal(r.body.source.api_key_enc, undefined);
    assert.equal(r.body.source.key_hint, 'k1se…tkey');
    const id=r.body.source.id;

    r=await call('GET', '/sources');
    assert.deepEqual([r.body.list[0].properties, r.body.list[0].units, r.body.list[0].sync_minutes], [2, 3, 30]);

    r=await call('PATCH', '/sources', {id, sync_enabled:false});
    assert.equal(r.body.source.sync_enabled, 0);

    r=await call('DELETE', '/sources', {id});
    assert.equal(r.body.ok, true);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM hospitality_units WHERE active=1`).get().n, 3); // imported rows stay
  });

  test('validation and ownership', async()=>{
    let r=await call('POST', '/sources', {url:'http://insecure.example.com/x', api_key:'k'});
    assert.equal(r.status, 400);
    r=await call('POST', '/sources', {url:'https://gosanchari.com/api/v1/properties'});
    assert.match(r.body.error, /API key/);
    db.prepare(`INSERT INTO hospitality_api_sources (client_id, url, created_at) VALUES (99, 'https://o.example.com/p', 'now')`).run();
    r=await call('POST', '/sync', {id:1});
    assert.equal(r.status, 404);
  });
});
