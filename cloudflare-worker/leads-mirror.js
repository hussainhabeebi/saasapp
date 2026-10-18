// ── Leads read mirror (D1) ───────────────────────────────────────────────────────────────────────
// NocoDB stays the source of truth for leads: every write still goes to NocoDB exactly as before.
// This module keeps a read copy of each enabled client's leads in D1 (every column except the
// heavy ConvHistory transcript) and answers the dashboard's big lead-list reads from it, so those
// no longer pull up to 2,000 rows across the network from NocoDB on every page load / 60s poll.
//
// Safety rules — whenever any of them fails the request simply goes to NocoDB, as it always has:
//   • off unless LEADS_MIRROR is set: "all", or a comma list of client ids for a pilot ("7,12")
//   • a client is served only once its copy is fully built (status 'ready')
//   • before each read: a small delta pull (newest-updated + newest-created rows) brings the copy
//     up to date, then NocoDB's row count for the client must equal the copy's — a mismatch
//     (a lead deleted or written somewhere we didn't see) marks the copy stale and skips it
//   • only the query shapes the dashboard actually sends are translated (eq / neq / blank /
//     notblank joined by ~and / ~or, one sort field, fields that are all in the copy)
// Copies are built and rebuilt by the cron (lmRunBuilds): pending / stale ones every 15 minutes,
// every ready one again nightly, which also clears out anything the checks above missed.

export const LM_EXCLUDED_FIELDS=['ConvHistory'];
const LM_DELTA_OVERLAP_MS=120000;  // re-read rows updated up to 2 min before the cursor
const LM_DELTA_PAGE=100;
const LM_MAX_LEADS=20000;          // bigger clients stay on NocoDB
const LM_PAGE=1000;
const LM_MAX_ROW_BYTES=900000;     // D1's row limit is 2 MB; a row this big means it isn't for us
const LM_FRESH_MS=3000;            // reads within this window of a delta skip the next delta
const LM_BUILD_STALE_MS=20*60*1000;

let _lmSchema=null;
const _lmFresh=new Map(); // client id → time of the last successful delta (per isolate)

export function lmEnabledFor(env, cid){
  const v=String(env?.LEADS_MIRROR||'').trim();
  if(!v || !env.DB) return false;
  if(v==='all') return true;
  return v.split(',').map(s=>s.trim()).includes(String(Number(cid)));
}

export function lmEnsureSchema(env){
  if(!_lmSchema) _lmSchema=(async()=>{
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS leads_mirror (
      id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL, updated_ms INTEGER NOT NULL DEFAULT 0,
      gen INTEGER NOT NULL DEFAULT 0, row TEXT NOT NULL)`).run();
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_leads_mirror_client ON leads_mirror (client_id, updated_ms)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS leads_mirror_state (
      client_id INTEGER PRIMARY KEY, status TEXT NOT NULL, gen INTEGER NOT NULL DEFAULT 0,
      cursor_ms INTEGER NOT NULL DEFAULT 0, columns TEXT NOT NULL DEFAULT '[]',
      started_at TEXT, synced_at TEXT, error TEXT)`).run();
  })().catch(e=>{ _lmSchema=null; throw e; });
  return _lmSchema;
}

// Any lead write the Worker makes may change what a list should show — the next read re-syncs.
export function lmTouched(){ _lmFresh.clear(); }

// A lead deleted through the Worker leaves the copy right away (body: {Id} or [{Id}…]).
export async function lmForget(env, ids){
  const list=[].concat(ids||[]).map(Number).filter(n=>n>0);
  _lmFresh.clear();
  if(!list.length || !env?.DB) return;
  try{
    await lmEnsureSchema(env);
    for(let i=0;i<list.length;i+=90){
      const part=list.slice(i,i+90);
      await env.DB.prepare(`DELETE FROM leads_mirror WHERE id IN (${part.map(()=>'?').join(',')})`).bind(...part).run();
    }
  }catch(e){ console.error('[leads-mirror] forget failed:', e.message); }
}

/* ── NocoDB `where` → SQL ──
   Grammar: expr := term (('~and'|'~or') term)* ; term := '(' expr ')' | '(' Field,op[,value] ')'.
   Mixing ~and and ~or at one level is ambiguous in NocoDB, so it's refused (→ NocoDB). */
export function lmParseWhere(src){
  let i=0;
  const s=String(src||'');
  const expr=()=>{
    const terms=[term()]; let joiner=null;
    while(s.startsWith('~and',i)||s.startsWith('~or',i)){
      const j=s.startsWith('~and',i)?'and':'or';
      if(joiner && joiner!==j) throw new Error('mixed ~and/~or');
      joiner=j; i+=j==='and'?4:3;
      terms.push(term());
    }
    return terms.length===1?terms[0]:{op:joiner, terms};
  };
  const term=()=>{
    if(s[i]!=='(') throw new Error('expected (');
    i++;
    if(s[i]==='('){
      const e=expr();
      if(s[i]!==')') throw new Error('expected )');
      i++; return e;
    }
    const end=s.indexOf(')', i);
    if(end<0) throw new Error('unclosed condition');
    const parts=s.slice(i, end).split(',');
    i=end+1;
    if(parts.length<2) throw new Error('bad condition');
    return {field:parts[0].trim(), cmp:parts[1].trim(), value:parts.slice(2).join(',')};
  };
  const out=expr();
  if(i!==s.length) throw new Error('trailing input');
  return out;
}

const LM_FIELD_RE=/^[A-Za-z0-9_ ]{1,64}$/;
const lmPath=f=>`$."${f}"`;

// Returns {sql, args} for the conditions other than the client filter, and whether the client
// filter was found at the top level (required — it's what the passthrough checked).
export function lmWhereToSql(ast, cid){
  let sawClient=false;
  const conv=(n, top)=>{
    if(n.terms){
      const parts=n.terms.map(t=>conv(t, top && n.op==='and'));
      return {sql:'('+parts.map(p=>p.sql).join(n.op==='and'?' AND ':' OR ')+')', args:parts.flatMap(p=>p.args)};
    }
    if(!LM_FIELD_RE.test(n.field)) throw new Error('unsupported field');
    if(n.field==='ClientId'){
      if(n.cmp!=='eq' || !top || String(n.value)!==String(cid)) throw new Error('unsupported ClientId filter');
      sawClient=true;
      return {sql:'1', args:[]};
    }
    const v=n.field==='Id'?'id':'json_extract(row, ?)';
    const vArgs=n.field==='Id'?[]:[lmPath(n.field)];
    const text=n.field==='Id'?'id':'CAST(json_extract(row, ?) AS TEXT)';
    switch(n.cmp){
      case 'eq':
        if(/^(true|false)$/i.test(n.value)) throw new Error('boolean compare');
        return {sql:`${text} = ?`, args:[...vArgs, n.field==='Id'?Number(n.value):n.value]};
      case 'neq':
        if(/^(true|false)$/i.test(n.value)) throw new Error('boolean compare');
        return {sql:`(${v} IS NULL OR ${text} <> ?)`, args:[...vArgs, ...vArgs, n.field==='Id'?Number(n.value):n.value]};
      case 'blank':
        return {sql:`(${v} IS NULL OR ${text} = '')`, args:[...vArgs, ...vArgs]};
      case 'notblank':
        return {sql:`(${v} IS NOT NULL AND ${text} <> '')`, args:[...vArgs, ...vArgs]};
      default: throw new Error('unsupported operator '+n.cmp);
    }
  };
  const out=conv(ast, true);
  return {...out, sawClient};
}

// The list query the passthrough would send to NocoDB, answered from the copy — or null.
export function lmBuildQuery(qs, cid, columns){
  const p=new URLSearchParams(qs||'');
  for(const k of p.keys()) if(!['where','fields','sort','limit','offset'].includes(k)) return null;
  const fields=String(p.get('fields')||'').split(',').map(s=>s.trim()).filter(Boolean);
  if(!fields.length) return null; // no field list = every column, ConvHistory included
  const have=new Set(columns);
  if(fields.some(f=>!have.has(f))) return null;
  let where;
  try{
    where=lmWhereToSql(lmParseWhere(p.get('where')||''), cid);
    if(!where.sawClient) return null;
  }catch(e){ return null; }
  let order='id ASC';
  const sort=String(p.get('sort')||'').trim();
  if(sort){
    const desc=sort.startsWith('-');
    const f=desc?sort.slice(1):sort;
    if(!LM_FIELD_RE.test(f) || sort.includes(',')) return null;
    if(f!=='Id' && !have.has(f)) return null;
    order=f==='Id'?`id ${desc?'DESC':'ASC'}`:`json_extract(row, '${lmPath(f)}') ${desc?'DESC':'ASC'}, id ASC`;
  }
  const limit=Math.min(Math.max(parseInt(p.get('limit')||'25',10)||25, 1), 2000);
  const offset=Math.max(parseInt(p.get('offset')||'0',10)||0, 0);
  return {fields, where, order, limit, offset};
}

const lmUpdatedMs=r=>Date.parse(r?.UpdatedAt||r?.CreatedAt||'')||0;

async function lmNc(env, table, params){
  const r=await fetch(`${env.NOCODB_BASE}/api/v2/tables/${table}/records?${params}`, {headers:{'xc-token':env.NOCODB_TOKEN}});
  if(!r.ok) throw new Error(`NocoDB ${r.status}`);
  return r.json();
}

function lmUpsertStmt(env, cid, row, gen, rebuild){
  const json=JSON.stringify(row);
  if(json.length>LM_MAX_ROW_BYTES) throw new Error('row too large');
  // A rebuild re-stamps gen on every row it saw, even when the copy already holds a newer
  // version (written by a delta meanwhile), so the end-of-build sweep never drops it.
  return env.DB.prepare(`INSERT INTO leads_mirror (id, client_id, updated_ms, gen, row) VALUES (?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET client_id=excluded.client_id,
      ${rebuild?'gen=excluded.gen,':''}
      row=CASE WHEN excluded.updated_ms>=leads_mirror.updated_ms THEN excluded.row ELSE leads_mirror.row END,
      updated_ms=MAX(excluded.updated_ms, leads_mirror.updated_ms)`)
    .bind(Number(row.Id), Number(cid), lmUpdatedMs(row), gen, json);
}
async function lmWriteRows(env, cid, rows, gen, rebuild){
  for(let i=0;i<rows.length;i+=50){
    await env.DB.batch(rows.slice(i,i+50).filter(r=>Number(r?.Id)>0).map(r=>lmUpsertStmt(env, cid, r, gen, rebuild)));
  }
}
async function lmSetState(env, cid, fields){
  const keys=Object.keys(fields);
  await env.DB.prepare(`UPDATE leads_mirror_state SET ${keys.map(k=>`${k}=?`).join(', ')} WHERE client_id=?`)
    .bind(...keys.map(k=>fields[k]), Number(cid)).run();
}

// Brings a ready copy up to date. Returns false when the copy can't be trusted for this read.
async function lmDelta(env, table, cid, st){
  const cols=JSON.parse(st.columns||'[]');
  const f=encodeURIComponent(cols.join(','));
  const w=encodeURIComponent(`(ClientId,eq,${cid})`);
  const [byUpdate, byNew]=await Promise.all([
    lmNc(env, table, `where=${w}&sort=-UpdatedAt&fields=${f}&limit=${LM_DELTA_PAGE}`),
    lmNc(env, table, `where=${w}&sort=-Id&fields=${f}&limit=25`),
  ]);
  const changed=byUpdate.list||[];
  const floor=Number(st.cursor_ms)-LM_DELTA_OVERLAP_MS;
  // A full page that never gets back to the cursor means more changed than one page holds.
  if(changed.length>=LM_DELTA_PAGE && !byUpdate.pageInfo?.isLastPage && lmUpdatedMs(changed[changed.length-1])>=floor) return false;
  const total=Number(byUpdate.pageInfo?.totalRows);
  if(!Number.isFinite(total)) return false;
  await lmWriteRows(env, cid, changed.filter(r=>lmUpdatedMs(r)>=floor).concat(byNew.list||[]), Number(st.gen), false);
  const cnt=await env.DB.prepare(`SELECT COUNT(*) AS n FROM leads_mirror WHERE client_id=?`).bind(Number(cid)).first();
  if(Number(cnt?.n)!==total) return false;
  const maxMs=Math.max(Number(st.cursor_ms)||0, ...changed.map(lmUpdatedMs));
  await lmSetState(env, cid, {cursor_ms:maxMs, synced_at:new Date().toISOString()});
  return true;
}

// Called by the /nocodb passthrough for a lead-list GET (after its own permission clauses were
// added to qs). Returns {list, pageInfo} served from D1, or null to send the request to NocoDB.
export async function lmTryServeList(env, table, cid, qs){
  if(!lmEnabledFor(env, cid)) return null;
  try{
    await lmEnsureSchema(env);
    const st=await env.DB.prepare(`SELECT * FROM leads_mirror_state WHERE client_id=?`).bind(Number(cid)).first();
    if(!st){
      await env.DB.prepare(`INSERT OR IGNORE INTO leads_mirror_state (client_id, status) VALUES (?, 'pending')`).bind(Number(cid)).run();
      return null;
    }
    if(st.status!=='ready') return null;
    const q=lmBuildQuery(qs, cid, JSON.parse(st.columns||'[]'));
    if(!q) return null;
    const last=_lmFresh.get(Number(cid));
    if(!last || Date.now()-last>LM_FRESH_MS){
      if(!await lmDelta(env, table, cid, st)){
        await lmSetState(env, cid, {status:'stale'});
        return null;
      }
      _lmFresh.set(Number(cid), Date.now());
    }
    const whereSql=`client_id=? AND ${q.where.sql}`;
    const args=[Number(cid), ...q.where.args];
    const [rows, count]=await Promise.all([
      env.DB.prepare(`SELECT row FROM leads_mirror WHERE ${whereSql} ORDER BY ${q.order} LIMIT ? OFFSET ?`).bind(...args, q.limit, q.offset).all(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM leads_mirror WHERE ${whereSql}`).bind(...args).first(),
    ]);
    const list=(rows.results||[]).map(r=>{
      const full=JSON.parse(r.row);
      return Object.fromEntries(q.fields.map(f=>[f, full[f]===undefined?null:full[f]]));
    });
    const totalRows=Number(count?.n)||0;
    return {list, pageInfo:{totalRows, page:Math.floor(q.offset/q.limit)+1, pageSize:q.limit,
      isFirstPage:q.offset===0, isLastPage:q.offset+list.length>=totalRows}};
  }catch(e){
    console.error('[leads-mirror] read fell back to NocoDB:', e.message);
    return null;
  }
}

// Full (re)build of one client's copy: every lead, every column but ConvHistory.
export async function lmBuildClient(env, table, cid){
  await lmEnsureSchema(env);
  const st=await env.DB.prepare(`SELECT * FROM leads_mirror_state WHERE client_id=?`).bind(Number(cid)).first();
  const gen=(Number(st?.gen)||0)+1;
  // started_at marks a build in progress (cleared when it ends); a ready copy keeps serving reads
  // while it is rebuilt.
  await lmSetState(env, cid, {started_at:new Date().toISOString(), error:null});
  try{
    const meta=await fetch(`${env.NOCODB_BASE}/api/v2/meta/tables/${table}`, {headers:{'xc-token':env.NOCODB_TOKEN}});
    if(!meta.ok) throw new Error(`NocoDB meta ${meta.status}`);
    const cols=((await meta.json()).columns||[]).map(c=>c.title).filter(t=>t && !LM_EXCLUDED_FIELDS.includes(t));
    if(!cols.includes('Id') || !cols.includes('UpdatedAt')) throw new Error('leads table has no Id/UpdatedAt');
    const f=encodeURIComponent(cols.join(','));
    const w=encodeURIComponent(`(ClientId,eq,${cid})`);
    let offset=0, maxMs=0;
    for(;;){
      const d=await lmNc(env, table, `where=${w}&sort=Id&fields=${f}&limit=${LM_PAGE}&offset=${offset}`);
      const list=d.list||[];
      await lmWriteRows(env, cid, list, gen, true);
      for(const r of list) maxMs=Math.max(maxMs, lmUpdatedMs(r));
      offset+=list.length;
      if(offset>LM_MAX_LEADS){ await lmSetState(env, cid, {status:'too_big', gen, started_at:null}); return 'too_big'; }
      if(!list.length || d.pageInfo?.isLastPage) break;
    }
    // Rows this build didn't see are gone from NocoDB — unless a read's delta saved them after
    // the build began (newer than anything the build read).
    await env.DB.prepare(`DELETE FROM leads_mirror WHERE client_id=? AND gen<>? AND updated_ms<=?`).bind(Number(cid), gen, maxMs).run();
    await lmSetState(env, cid, {status:'ready', gen, cursor_ms:maxMs, columns:JSON.stringify(cols), synced_at:new Date().toISOString(), started_at:null});
    _lmFresh.delete(Number(cid));
    return 'ready';
  }catch(e){
    await lmSetState(env, cid, {status:'error', error:String(e.message).slice(0,300), started_at:null}).catch(()=>{});
    console.error('[leads-mirror] build failed for client', cid, ':', e.message);
    return 'error';
  }
}

// Cron: nightly=false (every 15 min) builds pending / stale copies; nightly=true also retries
// failed ones and rebuilds every ready one, oldest first. A build still running (or one that died mid-way less
// than 20 minutes ago) is left alone.
export async function lmRunBuilds(env, table, {nightly=false, maxClients=nightly?50:5}={}){
  if(!String(env?.LEADS_MIRROR||'').trim() || !env.DB) return;
  try{
    await lmEnsureSchema(env);
    const statuses=nightly?`'pending','stale','error','ready'`:`'pending','stale'`;
    const rows=(await env.DB.prepare(`SELECT client_id, started_at FROM leads_mirror_state WHERE status IN (${statuses})
      ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'stale' THEN 1 WHEN 'error' THEN 2 ELSE 3 END, synced_at ASC LIMIT ?`)
      .bind(maxClients).all()).results||[];
    for(const r of rows){
      if(!lmEnabledFor(env, r.client_id)) continue;
      const started=Date.parse(r.started_at||'')||0;
      if(started && Date.now()-started<LM_BUILD_STALE_MS) continue;
      await lmBuildClient(env, table, r.client_id);
    }
  }catch(e){ console.error('[leads-mirror] build sweep failed:', e.message); }
}
