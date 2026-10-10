// ── Chats v2 ─────────────────────────────────────────────────────────────────────────────────────
// The inbox read model behind frontend/chats.html (design: docs/chats-v2-design.md). One D1 row per
// conversation (`conversations`) carries everything the chat list shows (preview, assignee, status,
// labels, unread, waiting-since), so the list, its counts and a thread open never touch NocoDB on
// the hot path. NocoDB stays the system of record for leads; this table is kept in step three ways:
//   1. every message write (worker.js d1InsertLeadMessage/d1InsertLeadMessages) calls
//      chatsV2AfterInsert, which updates the row and pushes a `conv` delta to open tabs;
//   2. every inbox action (/chats/v2/act) writes NocoDB's own fields (Owner, Tags, ConvResolved,
//      Pinned, Handover…) first, then the row, so the bot and the Leads tab see the same state;
//   3. chatsV2Reconcile pulls the chat-relevant lead fields from NocoDB (first run: a full backfill,
//      then at most every RECONCILE_MS, in the background) to catch writes made anywhere else.
// Fail-open throughout: if D1 or this module errors, worker.js's message writes still land and the
// page falls back to its v1 endpoints.
//
// This file imports nothing from worker.js; worker.js passes helpers in as `deps` (CHATS_V2_DEPS):
//   { json, requireSession, getClientById, ncFetch, leadsTable, broadcast(env,cid,obj),
//     handover(env,payload,leadId,takeover)→fields, ensureLeadsColumns(env,cols),
//     seedLead(env,cid,leadId)→lead|null, backfillMedia(env,c,cid,lead) }

export const CHATS_V2_SCHEMA=[
  `CREATE TABLE IF NOT EXISTS conversations (
    lead_id INTEGER PRIMARY KEY,
    client_id INTEGER NOT NULL,
    channel TEXT NOT NULL DEFAULT 'whatsapp',
    name TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    conv_id TEXT NOT NULL DEFAULT '',
    inbox_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    snoozed_until TEXT,
    handover TEXT NOT NULL DEFAULT 'No',
    handover_by TEXT NOT NULL DEFAULT '',
    assignee_email TEXT NOT NULL DEFAULT '',
    priority INTEGER NOT NULL DEFAULT 0,
    labels TEXT NOT NULL DEFAULT '',
    labels_key TEXT NOT NULL DEFAULT ',',
    pinned INTEGER NOT NULL DEFAULT 0,
    unread_count INTEGER NOT NULL DEFAULT 0,
    last_read_at TEXT,
    last_message_id INTEGER,
    last_message_at TEXT NOT NULL,
    last_message_preview TEXT NOT NULL DEFAULT '',
    last_message_dir TEXT NOT NULL DEFAULT 'in',
    last_sender TEXT NOT NULL DEFAULT '',
    last_customer_at TEXT,
    waiting_since TEXT,
    synced INTEGER NOT NULL DEFAULT 0,
    media_backfilled INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_conv_recent ON conversations(client_id, pinned, last_message_at DESC, lead_id DESC)`,
  `CREATE INDEX IF NOT EXISTS ix_conv_status ON conversations(client_id, status, last_message_at DESC)`,
  `CREATE INDEX IF NOT EXISTS ix_conv_assignee ON conversations(client_id, assignee_email, last_message_at DESC)`,
  `CREATE INDEX IF NOT EXISTS ix_conv_waiting ON conversations(client_id, waiting_since) WHERE waiting_since IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS ix_conv_updated ON conversations(client_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS canned_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    shortcut TEXT NOT NULL,
    body TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(client_id, shortcut)
  )`,
  `CREATE TABLE IF NOT EXISTS chat_ai_cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS chat_sync_state (
    client_id INTEGER PRIMARY KEY,
    backfilled_at TEXT,
    reconciled_at TEXT
  )`,
];
// Additive columns on the existing lead_messages table (migrations/0076_lead_messages.sql). Run one
// by one: SQLite has no ADD COLUMN IF NOT EXISTS, so "duplicate column" on a re-run is expected.
export const CHATS_V2_MESSAGE_COLUMNS=[
  `ALTER TABLE lead_messages ADD COLUMN sender_type TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE lead_messages ADD COLUMN sender_email TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE lead_messages ADD COLUMN sender_name TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE lead_messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'`,
  `ALTER TABLE lead_messages ADD COLUMN meta TEXT NOT NULL DEFAULT '{}'`,
];

const schemaReady=new WeakMap();
// true once the schema is in place for this D1 binding (cached per isolate); false if it couldn't
// be created, in which case callers keep the v1 behaviour.
export async function chatsV2Ready(env){
  if(!env?.DB) return false;
  let p=schemaReady.get(env.DB);
  if(!p){
    p=(async()=>{
      for(const sql of CHATS_V2_SCHEMA) await env.DB.prepare(sql).run();
      for(const sql of CHATS_V2_MESSAGE_COLUMNS){
        try{ await env.DB.prepare(sql).run(); }
        catch(e){ if(!/duplicate column/i.test(String(e?.message||e))) throw e; }
      }
      return true;
    })().catch(()=>{ schemaReady.delete(env.DB); return false; });
    schemaReady.set(env.DB, p);
  }
  return p;
}

// ── Pure helpers ────────────────────────────────────────────────────────────────────────────────

// Markdown → WhatsApp formatting for anything a person or the bot sends. WhatsApp bolds with a
// single *, so "**x**" reaches the customer as literal asterisks. Code spans/fences are left alone.
export function toWhatsApp(text){
  if(typeof text!=='string'||!text) return text;
  const parts=text.split(/(```[\s\S]*?```)/);
  return parts.map((p,i)=>i%2?p:p
    .replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm,'*$1*')
    .replace(/\*\*(?=\S)([^*\n]+?)\*\*/g,'*$1*')
    .replace(/__(?=\S)([^_\n]+?)__/g,'_$1_')
    .replace(/~~(?=\S)([^~\n]+?)~~/g,'~$1~')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,(m,label,url)=>label===url?url:`${label}: ${url}`)
    .replace(/^([ \t]*)\*[ \t]+/gm,'$1• ')
  ).join('');
}

export function chatsV2Kind(msg){
  if(msg?.kind&&['note','event'].includes(msg.kind)) return msg.kind;
  const a=msg?.attachment&&typeof msg.attachment==='object'?msg.attachment:null;
  if(a?.kind==='template') return 'template';
  if(a?.kind&&['image','video','voice','audio','document','location','contacts'].includes(a.kind)) return a.kind==='voice'?'audio':a.kind;
  if(a&&Object.keys(a).length) return 'document';
  if(msg?.media?.url) return msg.media.type==='video'?'video':'image';
  return 'text';
}

function fmtDur(s){ s=Math.max(0, Math.round(Number(s)||0)); return Math.floor(s/60)+':'+String(s%60).padStart(2,'0'); }
// What the chat list shows under the name — never blank: media becomes a labelled kind.
export function chatsV2Preview(msg){
  const a=msg?.attachment&&typeof msg.attachment==='object'?msg.attachment:{};
  // A customer's photo/voice note is stored with the AI's reading as content; show their caption.
  const raw=a.ai_text?String(a.caption||''):String(msg?.content||'');
  const text=raw.replace(/\s+/g,' ').trim();
  const kind=chatsV2Kind(msg);
  const label=kind==='template'?`📋 ${a.name||'Template'}`
    :kind==='image'?'📷 Photo'
    :kind==='video'?'🎥 Video'
    :kind==='audio'?(a.kind==='voice'?`🎤 Voice note${a.duration?' '+fmtDur(a.duration):''}`:'🎧 Audio')
    :kind==='location'?'📍 Location'
    :kind==='contacts'?'👤 Contact'
    :kind==='document'?`📄 ${a.name||'Document'}`:'';
  if(kind==='template') return label.slice(0,120);
  if(label&&text) return `${label.split(' ')[0]} ${text}`.slice(0,120);
  return (text||label||'Message').slice(0,120);
}

export function chatsV2SenderOf(msg){
  if(msg?.sender_type) return msg.sender_type;
  if(msg?.role==='user') return 'customer';
  if(msg?.role==='system') return 'system';
  return '';
}

const lc=s=>String(s||'').trim().toLowerCase();
export function chatsV2LabelsKey(labels){
  const list=String(labels||'').split(',').map(lc).filter(Boolean);
  return ','+[...new Set(list)].join(',')+(list.length?',':'');
}
function labelsOf(s){ return [...new Set(String(s||'').split(',').map(x=>x.trim()).filter(Boolean))]; }

// NocoDB lead → the conversation columns it owns. Status: NocoDB only knows resolved or not, so a
// D1-only state (snoozed/pending) survives a reconcile unless NocoDB says resolved.
export function chatsV2FieldsFromLead(lead, existing){
  const resolved=lead.ConvResolved==='Yes';
  const prev=existing?.status||'open';
  const status=resolved?'resolved':(prev==='resolved'?'open':prev);
  const out={
    name:String(lead.Name||'').slice(0,140),
    phone:String(lead.Phone||'').slice(0,40),
    channel:String(lead.Channel||'whatsapp')==='instagram'?'instagram':'whatsapp',
    conv_id:String(lead.ConversationID||lead.ConversationId||lead.chatwoot_conv_id||''),
    inbox_id:String(lead.InboxId||''),
    handover:lead.Handover==='Yes'?'Yes':'No',
    handover_by:String(lead.HandoverBy||'').slice(0,140),
    assignee_email:lc(lead.Owner),
    labels:labelsOf(lead.Tags).join(', '),
    labels_key:chatsV2LabelsKey(lead.Tags),
    pinned:lead.Pinned==='Yes'?1:0,
    status,
  };
  if(status!=='snoozed') out.snoozed_until=null;
  const lca=lead.LastCustomerMsgAt?String(lead.LastCustomerMsgAt):'';
  if(lca&&(!existing?.last_customer_at||lca>existing.last_customer_at)) out.last_customer_at=lca;
  return out;
}

// ── Message write hook ──────────────────────────────────────────────────────────────────────────

async function convRow(env, leadId){
  return env.DB.prepare('SELECT * FROM conversations WHERE lead_id=?').bind(Number(leadId)).first();
}

// After a message row actually landed (INSERT changed a row) — update the list row, then push the
// delta. `seed`: history being copied in (ConvHistory → D1), not a new message: no reopen, and a
// conversation first created by it starts read.
export async function chatsV2AfterInsert(env, leadId, clientId, msg, messageId, {seed=false, broadcast}={}){
  const kind=chatsV2Kind(msg);
  if(kind==='note'||kind==='event') return null;
  const ts=String(msg.ts||new Date().toISOString());
  const dir=msg.role==='user'?'in':'out';
  const sender=chatsV2SenderOf(msg);
  const now=new Date().toISOString();
  const agentRead=dir==='out'&&sender==='agent';
  const reopen=!seed&&dir==='in'?1:0;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO conversations (lead_id, client_id, last_message_id, last_message_at, last_message_preview, last_message_dir, last_sender, last_customer_at, last_read_at, updated_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
      ON CONFLICT(lead_id) DO UPDATE SET
        last_message_id=CASE WHEN excluded.last_message_at>=conversations.last_message_at THEN excluded.last_message_id ELSE conversations.last_message_id END,
        last_message_preview=CASE WHEN excluded.last_message_at>=conversations.last_message_at THEN excluded.last_message_preview ELSE conversations.last_message_preview END,
        last_message_dir=CASE WHEN excluded.last_message_at>=conversations.last_message_at THEN excluded.last_message_dir ELSE conversations.last_message_dir END,
        last_sender=CASE WHEN excluded.last_message_at>=conversations.last_message_at THEN excluded.last_sender ELSE conversations.last_sender END,
        last_message_at=MAX(conversations.last_message_at, excluded.last_message_at),
        last_customer_at=CASE WHEN excluded.last_customer_at IS NOT NULL AND (conversations.last_customer_at IS NULL OR excluded.last_customer_at>conversations.last_customer_at) THEN excluded.last_customer_at ELSE conversations.last_customer_at END,
        status=CASE WHEN ?11=1 AND conversations.status IN ('resolved','snoozed') THEN 'open' ELSE conversations.status END,
        snoozed_until=CASE WHEN ?11=1 THEN NULL ELSE conversations.snoozed_until END,
        updated_at=excluded.updated_at`)
      .bind(Number(leadId), Number(clientId), messageId||null, ts, chatsV2Preview(msg), dir, sender,
        dir==='in'?ts:null, (seed||dir==='out')?ts:null, now, reopen),
    // An agent replying has read the chat.
    env.DB.prepare(`UPDATE conversations SET last_read_at=?2 WHERE lead_id=?1 AND ?3=1 AND (last_read_at IS NULL OR last_read_at<?2)`)
      .bind(Number(leadId), ts, agentRead?1:0),
    // Unread and waiting-since are derived from the messages themselves (indexed on lead_id, ts),
    // so a replayed, reordered or duplicated webhook can't drift them.
    env.DB.prepare(`UPDATE conversations SET
        unread_count=(SELECT COUNT(*) FROM lead_messages m WHERE m.lead_id=conversations.lead_id AND m.role='user' AND m.ts>COALESCE(conversations.last_read_at,'')),
        waiting_since=(SELECT MIN(m.ts) FROM lead_messages m WHERE m.lead_id=conversations.lead_id AND m.role='user'
          AND m.ts>COALESCE((SELECT MAX(o.ts) FROM lead_messages o WHERE o.lead_id=conversations.lead_id AND o.role='assistant'),''))
      WHERE lead_id=?1`).bind(Number(leadId)),
  ]);
  const row=await convRow(env, leadId);
  // Deltas carry ids only, never names or message text: every tab of the account shares this
  // socket, including teammates who may not see this chat. The page fetches the changed rows
  // through /chats/v2/list?updated_since=…, which applies the same access rules as the list.
  if(broadcast&&row) await broadcast(env, clientId, {type:'conv', lead_ids:[Number(leadId)], dir:seed?'':(dir==='in'?'in':'out')});
  return row;
}

// A NocoDB lead PATCH made by some other path (v1 /chat/* routes, the engine's lead upsert, the
// dashboard's NocoDB passthrough) mirrored onto the conversation row straight away, instead of
// waiting for the next reconcile. Only touches a row that already exists; only fields present.
export async function chatsV2ApplyLeadPatch(env, leadId, patch, {broadcast}={}){
  if(!leadId||!patch||typeof patch!=='object'||!await chatsV2Ready(env)) return null;
  const set=[], vals=[];
  const put=(col, v)=>{ set.push(`${col}=?`); vals.push(v); };
  if('Name' in patch) put('name', String(patch.Name||'').slice(0,140));
  if('Phone' in patch) put('phone', String(patch.Phone||'').slice(0,40));
  if('Channel' in patch) put('channel', String(patch.Channel||'whatsapp')==='instagram'?'instagram':'whatsapp');
  if('Owner' in patch) put('assignee_email', lc(patch.Owner));
  if('Handover' in patch) put('handover', patch.Handover==='Yes'?'Yes':'No');
  if('HandoverBy' in patch) put('handover_by', String(patch.HandoverBy||'').slice(0,140));
  if('Pinned' in patch) put('pinned', patch.Pinned==='Yes'?1:0);
  if('Tags' in patch){ put('labels', labelsOf(patch.Tags).join(', ')); put('labels_key', chatsV2LabelsKey(patch.Tags)); }
  if('ConversationID' in patch&&patch.ConversationID) put('conv_id', String(patch.ConversationID));
  if('InboxId' in patch&&patch.InboxId) put('inbox_id', String(patch.InboxId));
  // A full lead record (has ClientId) carries every field the row needs: mark it filled in.
  if('ClientId' in patch&&'Name' in patch) put('synced', 1);
  if('ConvResolved' in patch){
    set.push(`status=CASE WHEN ?='Yes' THEN 'resolved' WHEN status='resolved' THEN 'open' ELSE status END`); vals.push(patch.ConvResolved==='Yes'?'Yes':'No');
    set.push(`snoozed_until=CASE WHEN ?='Yes' THEN NULL ELSE snoozed_until END`); vals.push(patch.ConvResolved==='Yes'?'Yes':'No');
  }
  if('LastCustomerMsgAt' in patch&&patch.LastCustomerMsgAt){
    set.push(`last_customer_at=CASE WHEN last_customer_at IS NULL OR last_customer_at<? THEN ? ELSE last_customer_at END`);
    vals.push(String(patch.LastCustomerMsgAt), String(patch.LastCustomerMsgAt));
  }
  if(!set.length) return null;
  try{
    const r=await env.DB.prepare(`UPDATE conversations SET ${set.join(', ')}, updated_at=? WHERE lead_id=?`).bind(...vals, new Date().toISOString(), Number(leadId)).run();
    if(!r?.meta?.changes) return null;
    const row=await convRow(env, leadId);
    if(row&&broadcast) await broadcast(env, row.client_id, {type:'conv', lead_ids:[Number(leadId)]});
    return row;
  }catch(e){ return null; }
}

// ── Sync from NocoDB ────────────────────────────────────────────────────────────────────────────

const RECONCILE_MS=120*1000;
const LIST_FIELDS='Id,Name,Phone,Channel,Owner,Handover,HandoverBy,ConvResolved,Pinned,Tags,LastMsgAt,LastCustomerMsgAt,ConversationID,InboxId';

async function ncList(env, deps, where, {fields=LIST_FIELDS, limit=200, offset=0}={}){
  const base=`api/v2/tables/${deps.leadsTable}/records?where=${encodeURIComponent(where)}&limit=${limit}&offset=${offset}&sort=-LastMsgAt`;
  let r=await deps.ncFetch(env, fields?`${base}&fields=${fields}`:base);
  // A self-healing column (Pinned, ConvResolved, HandoverBy) that doesn't exist yet on this table
  // can make NocoDB reject the field list — the unfiltered row is a superset, so retry without it.
  if(!r.ok&&fields) r=await deps.ncFetch(env, base);
  if(!r.ok) throw new Error('NocoDB '+r.status);
  const d=await r.json().catch(()=>({}));
  return {list:d.list||[], more:!(d.pageInfo?.isLastPage??((d.list||[]).length<limit))};
}

function lastHistoryEntry(lead){
  try{ const h=JSON.parse(lead.ConvHistory||'[]'); return Array.isArray(h)&&h.length?h[h.length-1]:null; }catch(e){ return null; }
}

function setClause(fields){
  const keys=Object.keys(fields);
  return {sql:keys.map(k=>`${k}=?`).join(', '), vals:keys.map(k=>fields[k])};
}

// First run per client: every lead with chat activity gets a conversation row (preview from the
// newest D1 message, else the last ConvHistory entry). Unread starts at 0 — the old per-browser
// read map can't be carried over server-side.
export async function chatsV2Backfill(env, deps, cid, {maxPages=20}={}){
  const now=new Date().toISOString();
  let count=0;
  for(let page=0;page<maxPages;page++){
    const {list, more}=await ncList(env, deps, `(ClientId,eq,${cid})~and(LastMsgAt,notblank)`, {fields:'', limit:100, offset:page*100});
    const stmts=[];
    const ids=list.map(l=>Number(l?.Id)).filter(Boolean);
    const latest=new Map();
    if(ids.length){
      const {results}=await env.DB.prepare(`SELECT m.lead_id, m.id, m.role, m.content, m.attachment, m.ts, m.sender_type, m.kind FROM lead_messages m
        WHERE m.lead_id IN (${ids.map(()=>'?').join(',')}) AND m.kind NOT IN ('note','event')
          AND m.ts=(SELECT MAX(x.ts) FROM lead_messages x WHERE x.lead_id=m.lead_id AND x.kind NOT IN ('note','event'))`).bind(...ids).all();
      for(const r of results||[]) if(!latest.has(Number(r.lead_id))||r.id>latest.get(Number(r.lead_id)).id) latest.set(Number(r.lead_id), r);
    }
    for(const lead of list){
      if(!lead?.Id) continue;
      const hasHist=lead.ConvHistory&&lead.ConvHistory!=='[]';
      const lastD1=latest.get(Number(lead.Id))||null;
      if(!hasHist&&!lastD1) continue;
      let last=lastD1?{...lastD1, attachment:safeJson(lastD1.attachment)}:lastHistoryEntry(lead)||{};
      const ts=String(lastD1?.ts||lead.LastMsgAt||now);
      const f=chatsV2FieldsFromLead(lead, null);
      stmts.push(env.DB.prepare(`INSERT INTO conversations (lead_id, client_id, channel, name, phone, conv_id, inbox_id, status, handover, handover_by, assignee_email, labels, labels_key, pinned,
          unread_count, last_read_at, last_message_id, last_message_at, last_message_preview, last_message_dir, last_sender, last_customer_at, synced, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,1,?)
        ON CONFLICT(lead_id) DO UPDATE SET channel=excluded.channel, name=excluded.name, phone=excluded.phone, conv_id=excluded.conv_id, inbox_id=excluded.inbox_id,
          handover=excluded.handover, handover_by=excluded.handover_by, assignee_email=excluded.assignee_email, labels=excluded.labels, labels_key=excluded.labels_key,
          pinned=excluded.pinned, status=CASE WHEN excluded.status='resolved' THEN 'resolved' WHEN conversations.status='resolved' THEN 'open' ELSE conversations.status END,
          synced=1, updated_at=excluded.updated_at`)
        .bind(Number(lead.Id), Number(cid), f.channel, f.name, f.phone, f.conv_id, f.inbox_id, f.status, f.handover, f.handover_by, f.assignee_email, f.labels, f.labels_key, f.pinned,
          ts, lastD1?.id||null, ts, chatsV2Preview(last), last.role==='user'?'in':'out', chatsV2SenderOf(last), f.last_customer_at||null, now));
    }
    for(let i=0;i<stmts.length;i+=50) await env.DB.batch(stmts.slice(i, i+50));
    count+=stmts.length;
    if(!more) break;
  }
  await env.DB.prepare(`INSERT INTO chat_sync_state (client_id, backfilled_at, reconciled_at) VALUES (?,?,?)
    ON CONFLICT(client_id) DO UPDATE SET backfilled_at=excluded.backfilled_at, reconciled_at=excluded.reconciled_at`).bind(Number(cid), now, now).run();
  return count;
}

// Pulls the chat-relevant fields of the most recently active leads and fixes any row that drifted
// (an Owner changed in the Leads tab, a handover the engine set, Tags edited elsewhere…). Changed
// rows are pushed to open tabs as one `conv` delta (ids only).
export async function chatsV2Reconcile(env, deps, cid){
  const now=new Date().toISOString();
  await env.DB.prepare(`INSERT INTO chat_sync_state (client_id, reconciled_at) VALUES (?,?) ON CONFLICT(client_id) DO UPDATE SET reconciled_at=excluded.reconciled_at`).bind(Number(cid), now).run();
  const {list}=await ncList(env, deps, `(ClientId,eq,${cid})~and(LastMsgAt,notblank)`, {limit:500});
  if(!list.length) return 0;
  const ids=list.map(l=>Number(l.Id)).filter(Boolean);
  const existing=new Map();
  for(let i=0;i<ids.length;i+=90){
    const chunk=ids.slice(i, i+90);
    const {results}=await env.DB.prepare(`SELECT * FROM conversations WHERE lead_id IN (${chunk.map(()=>'?').join(',')})`).bind(...chunk).all();
    for(const r of results||[]) existing.set(Number(r.lead_id), r);
  }
  const stmts=[], changedIds=[];
  for(const lead of list){
    const row=existing.get(Number(lead.Id));
    if(!row) continue; // never had a D1 message — created by the next message write or backfill
    const f=chatsV2FieldsFromLead(lead, row);
    const diff={};
    for(const [k,v] of Object.entries(f)) if((row[k]??null)!==(v??null)) diff[k]=v;
    if(!row.synced) diff.synced=1;
    if(!Object.keys(diff).length) continue;
    diff.updated_at=now;
    const {sql, vals}=setClause(diff);
    stmts.push(env.DB.prepare(`UPDATE conversations SET ${sql} WHERE lead_id=?`).bind(...vals, Number(lead.Id)));
    changedIds.push(Number(lead.Id));
  }
  for(let i=0;i<stmts.length;i+=50) await env.DB.batch(stmts.slice(i, i+50));
  if(changedIds.length&&deps.broadcast) await deps.broadcast(env, cid, {type:'conv', lead_ids:changedIds});
  return changedIds.length;
}

async function rowsByIds(env, ids){
  const out=[];
  for(let i=0;i<ids.length;i+=90){
    const chunk=ids.slice(i, i+90);
    const {results}=await env.DB.prepare(`SELECT * FROM conversations WHERE lead_id IN (${chunk.map(()=>'?').join(',')})`).bind(...chunk).all();
    out.push(...(results||[]));
  }
  return out;
}

// Rows created by a message write before their lead details were known (a brand-new lead) get
// Name/Phone/Owner… filled in with one NocoDB call for the whole page.
async function fillUnsynced(env, deps, cid, rows){
  const missing=rows.filter(r=>!r.synced).map(r=>Number(r.lead_id));
  if(!missing.length) return rows;
  try{
    const {list}=await ncList(env, deps, `(ClientId,eq,${cid})~and(Id,in,${missing.join(',')})`, {limit:missing.length});
    const now=new Date().toISOString();
    const stmts=[];
    for(const lead of list){
      const row=rows.find(r=>Number(r.lead_id)===Number(lead.Id));
      if(!row) continue;
      const f={...chatsV2FieldsFromLead(lead, row), synced:1, updated_at:now};
      Object.assign(row, f);
      const {sql, vals}=setClause(f);
      stmts.push(env.DB.prepare(`UPDATE conversations SET ${sql} WHERE lead_id=?`).bind(...vals, Number(lead.Id)));
    }
    if(stmts.length) await env.DB.batch(stmts);
  }catch(e){}
  return rows;
}

// ── Access ──────────────────────────────────────────────────────────────────────────────────────

const FULL_ACCESS_ROLES=['admin','general_manager'];
function parse(s, d){ try{ const v=JSON.parse(s||''); return v??d; }catch(e){ return d; } }
function safeJson(s){ return parse(s, {})||{}; }
// Same rule chats.html applied client-side in v1 (isStaff/staffLocked/visibleToMe), now enforced on
// the server: a teammate without a full-access role sees only chats assigned to them, plus
// unassigned ones when Lead Routing is off.
export function chatsV2Access(c, email){
  const me=lc(email);
  const owner=lc(c?.authentik_email);
  const role=parse(c?.team_permissions, {})?.[me]?.role;
  const staff=!!me&&me!==owner&&!FULL_ACCESS_ROLES.includes(role);
  const locked=staff&&!!parse(c?.lead_routing, {})?.enabled;
  return {me, staff, locked};
}
function scopeSql(acc){
  if(!acc.staff) return {sql:'', vals:[]};
  return acc.locked?{sql:' AND assignee_email=?', vals:[acc.me]}:{sql:` AND assignee_email IN (?, '')`, vals:[acc.me]};
}
function canSee(acc, row){
  if(!acc.staff) return true;
  return row.assignee_email===acc.me||(!acc.locked&&!row.assignee_email);
}

export function chatsV2Agents(c){
  const names=parse(c?.team_names, {})||{};
  const emails=[lc(c?.authentik_email), ...String(c?.team_emails||'').split(',').map(lc)].filter(Boolean);
  return [...new Set(emails)].map(email=>({email, name:String(names[email]||email.split('@')[0]).slice(0,80)}));
}

// ── Views ───────────────────────────────────────────────────────────────────────────────────────

const VIEWS={
  all:{sql:` AND status<>'snoozed'`, vals:()=>[]},
  unread:{sql:` AND unread_count>0 AND status<>'snoozed'`, vals:()=>[]},
  needs:{sql:` AND handover='Yes' AND status NOT IN ('resolved','snoozed')`, vals:()=>[]},
  mine:{sql:` AND assignee_email=? AND status<>'snoozed'`, vals:acc=>[acc.me]},
  unassigned:{sql:` AND assignee_email='' AND status NOT IN ('resolved','snoozed')`, vals:()=>[]},
  pending:{sql:` AND status='pending'`, vals:()=>[]},
  snoozed:{sql:` AND status='snoozed'`, vals:()=>[]},
  resolved:{sql:` AND status='resolved'`, vals:()=>[]},
};
export const CHATS_V2_VIEWS=Object.keys(VIEWS);

function filterSql(q, acc){
  let sql='', vals=[];
  const v=VIEWS[q.view]||VIEWS.all;
  sql+=v.sql; vals.push(...v.vals(acc));
  if(q.channel==='whatsapp'||q.channel==='instagram'){ sql+=' AND channel=?'; vals.push(q.channel); }
  if(q.handler==='human'){ sql+=` AND handover='Yes'`; }
  else if(q.handler==='bot'){ sql+=` AND handover<>'Yes'`; }
  const labels=String(q.labels||'').split(',').map(lc).filter(Boolean).slice(0,10);
  if(labels.length){ sql+=` AND (${labels.map(()=>`labels_key LIKE ?`).join(' OR ')})`; vals.push(...labels.map(l=>`%,${l.replace(/[%_]/g,'')},%`)); }
  const s=scopeSql(acc); sql+=s.sql; vals.push(...s.vals);
  return {sql, vals};
}

function encCursor(a, b){ return btoa(JSON.stringify([a, b])); }
function decCursor(s){ try{ const v=JSON.parse(atob(String(s||''))); return Array.isArray(v)?v:null; }catch(e){ return null; } }

export async function chatsV2List(env, cid, acc, q){
  const limit=Math.min(Math.max(Number(q.limit)||30, 1), 100);
  const {sql:fs, vals:fv}=filterSql(q, acc);
  const sort=['oldest','waiting'].includes(q.sort)?q.sort:'newest';
  const cur=decCursor(q.cursor);
  let rows=[];
  if(sort==='newest'){
    // Pinned chats ride on top of the first page only; paging runs over the unpinned ones.
    if(!cur){
      const {results}=await env.DB.prepare(`SELECT * FROM conversations WHERE client_id=? AND pinned=1${fs} ORDER BY last_message_at DESC LIMIT 50`).bind(Number(cid), ...fv).all();
      rows.push(...(results||[]));
    }
    const {results}=await env.DB.prepare(`SELECT * FROM conversations WHERE client_id=? AND pinned=0${fs}${cur?' AND (last_message_at<? OR (last_message_at=? AND lead_id<?))':''} ORDER BY last_message_at DESC, lead_id DESC LIMIT ?`)
      .bind(Number(cid), ...fv, ...(cur?[cur[0], cur[0], Number(cur[1])]:[]), limit+1).all();
    rows.push(...(results||[]));
  }else if(sort==='oldest'){
    const {results}=await env.DB.prepare(`SELECT * FROM conversations WHERE client_id=?${fs}${cur?' AND (last_message_at>? OR (last_message_at=? AND lead_id>?))':''} ORDER BY last_message_at ASC, lead_id ASC LIMIT ?`)
      .bind(Number(cid), ...fv, ...(cur?[cur[0], cur[0], Number(cur[1])]:[]), limit+1).all();
    rows.push(...(results||[]));
  }else{
    const {results}=await env.DB.prepare(`SELECT * FROM conversations WHERE client_id=? AND waiting_since IS NOT NULL AND status NOT IN ('resolved','snoozed')${fs}${cur?' AND (waiting_since>? OR (waiting_since=? AND lead_id>?))':''} ORDER BY waiting_since ASC, lead_id ASC LIMIT ?`)
      .bind(Number(cid), ...fv, ...(cur?[cur[0], cur[0], Number(cur[1])]:[]), limit+1).all();
    rows.push(...(results||[]));
  }
  const pinnedCount=sort==='newest'&&!cur?rows.filter(r=>r.pinned).length:0;
  const paged=rows.slice(pinnedCount);
  const more=paged.length>limit;
  const page=[...rows.slice(0, pinnedCount), ...paged.slice(0, limit)];
  const last=paged[Math.min(limit, paged.length)-1];
  const key=sort==='waiting'?'waiting_since':'last_message_at';
  return {rows:page, cursor:more&&last?encCursor(last[key], last.lead_id):null};
}

export async function chatsV2Counts(env, cid, acc){
  const s=scopeSql(acc);
  const row=await env.DB.prepare(`SELECT
      SUM(CASE WHEN status<>'snoozed' THEN 1 ELSE 0 END) AS all_n,
      SUM(CASE WHEN unread_count>0 AND status<>'snoozed' THEN 1 ELSE 0 END) AS unread,
      SUM(CASE WHEN handover='Yes' AND status NOT IN ('resolved','snoozed') THEN 1 ELSE 0 END) AS needs,
      SUM(CASE WHEN assignee_email=? AND status<>'snoozed' THEN 1 ELSE 0 END) AS mine,
      SUM(CASE WHEN assignee_email='' AND status NOT IN ('resolved','snoozed') THEN 1 ELSE 0 END) AS unassigned,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='snoozed' THEN 1 ELSE 0 END) AS snoozed,
      SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) AS resolved,
      SUM(CASE WHEN channel='whatsapp' AND unread_count>0 AND status<>'snoozed' THEN 1 ELSE 0 END) AS unread_whatsapp,
      SUM(CASE WHEN channel='instagram' AND unread_count>0 AND status<>'snoozed' THEN 1 ELSE 0 END) AS unread_instagram
    FROM conversations WHERE client_id=?${s.sql}`).bind(acc.me, Number(cid), ...s.vals).first();
  const n=k=>Number(row?.[k])||0;
  return {all:n('all_n'), unread:n('unread'), needs:n('needs'), mine:n('mine'), unassigned:n('unassigned'),
    pending:n('pending'), snoozed:n('snoozed'), resolved:n('resolved'),
    unread_by_channel:{whatsapp:n('unread_whatsapp'), instagram:n('unread_instagram')}};
}

export function chatsV2MessageOut(r){
  const m={id:r.id, role:r.role, content:r.content, ts:r.ts};
  const a=safeJson(r.attachment); if(Object.keys(a).length) m.attachment=a;
  const rt=safeJson(r.reply_to); if(Object.keys(rt).length) m.reply_to=rt;
  if(r.sender_type) m.sender_type=r.sender_type;
  if(r.sender_name) m.sender_name=r.sender_name;
  if(r.sender_email) m.sender_email=r.sender_email;
  if(r.kind&&r.kind!=='text') m.kind=r.kind;
  const meta=safeJson(r.meta); if(Object.keys(meta).length) m.meta=meta;
  return m;
}

// Newest `limit` messages (returned oldest → newest), or the page before a (ts, id) cursor, or —
// with `after` — everything newer than a timestamp (catch-up after a delta or reconnect).
export async function chatsV2Thread(env, leadId, q){
  const limit=Math.min(Math.max(Number(q.limit)||30, 1), 200);
  if(q.after){
    const {results}=await env.DB.prepare(`SELECT * FROM lead_messages WHERE lead_id=? AND ts>? ORDER BY ts ASC, id ASC LIMIT 200`).bind(Number(leadId), String(q.after)).all();
    return {messages:(results||[]).map(chatsV2MessageOut), has_more:false};
  }
  const cur=decCursor(q.before);
  const {results}=await env.DB.prepare(`SELECT * FROM lead_messages WHERE lead_id=?${cur?' AND (ts<? OR (ts=? AND id<?))':''} ORDER BY ts DESC, id DESC LIMIT ?`)
    .bind(Number(leadId), ...(cur?[cur[0], cur[0], Number(cur[1])]:[]), limit+1).all();
  const rows=results||[];
  const more=rows.length>limit;
  const page=rows.slice(0, limit).reverse();
  return {messages:page.map(chatsV2MessageOut), has_more:more, before:more&&page[0]?encCursor(page[0].ts, page[0].id):null};
}

// ── Actions ─────────────────────────────────────────────────────────────────────────────────────

async function insertEvent(env, leadId, cid, text, meta, actor){
  const ts=new Date().toISOString();
  await env.DB.prepare(`INSERT OR IGNORE INTO lead_messages (lead_id, client_id, role, content, attachment, reply_to, ts, sender_type, sender_email, sender_name, kind, meta)
    VALUES (?,?,'system',?,'{}','{}',?,'system',?,?,'event',?)`)
    .bind(Number(leadId), Number(cid), String(text).slice(0,300), ts, actor.email||'', actor.name||'', JSON.stringify(meta||{})).run();
  return {role:'system', kind:'event', content:text, ts, meta, sender_type:'system', sender_name:actor.name||''};
}

function snoozeLabel(iso){
  try{ return new Date(iso).toISOString().slice(0,16).replace('T',' ')+' UTC'; }catch(e){ return String(iso); }
}

async function ncPatchLeads(env, deps, patches){
  if(!patches.length) return;
  const r=await deps.ncFetch(env, `api/v2/tables/${deps.leadsTable}/records`, {method:'PATCH', body:patches});
  if(!r.ok) throw new Error('Could not update the lead ('+r.status+')');
}

const ACT_OPS=['mark_read','mark_unread','resolve','reopen','snooze','pending','assign','handler','pin','labels','label_add','label_remove','priority'];

export async function chatsV2Act(env, deps, payload, c, acc, body){
  const op=String(body.op||'');
  if(!ACT_OPS.includes(op)) throw Object.assign(new Error('Unknown action'), {status:400});
  const ids=[...new Set((Array.isArray(body.ids)?body.ids:[body.lead_id]).map(Number).filter(Boolean))].slice(0,100);
  if(!ids.length) throw Object.assign(new Error('ids required'), {status:400});
  const cid=Number(payload.cid);
  const rows=(await rowsByIds(env, ids)).filter(r=>Number(r.client_id)===cid&&canSee(acc, r));
  if(!rows.length) throw Object.assign(new Error('Conversation not found'), {status:404});
  const now=new Date().toISOString();
  const agents=chatsV2Agents(c);
  const nameOf=e=>agents.find(a=>a.email===lc(e))?.name||e;
  const actor={email:acc.me, name:nameOf(acc.me)||'Team'};
  const a=body.args||{};
  const events=[];
  const d1=[]; // [sql, vals] per row
  const nc=[];
  for(const row of rows){
    const id=Number(row.lead_id);
    const set={};
    let ev=null;
    switch(op){
      case 'mark_read': set.last_read_at=now; set.unread_count=0; break;
      case 'mark_unread': set.unread_count=Math.max(1, Number(row.unread_count)||0); break;
      case 'resolve': set.status='resolved'; set.snoozed_until=null; nc.push({Id:id, ConvResolved:'Yes'}); ev=[`Resolved by ${actor.name}`, {type:'resolved'}]; break;
      case 'reopen': set.status='open'; set.snoozed_until=null; nc.push({Id:id, ConvResolved:'No'}); ev=[`Reopened by ${actor.name}`, {type:'reopened'}]; break;
      case 'pending': set.status='pending'; set.snoozed_until=null; nc.push({Id:id, ConvResolved:'No'}); ev=[`Marked pending by ${actor.name}`, {type:'pending'}]; break;
      case 'snooze': {
        const until=new Date(a.until||'');
        if(isNaN(until)||until.getTime()<=Date.now()) throw Object.assign(new Error('Pick a time in the future'), {status:400});
        set.status='snoozed'; set.snoozed_until=until.toISOString(); nc.push({Id:id, ConvResolved:'No'});
        ev=[`Snoozed until ${snoozeLabel(until)} by ${actor.name}`, {type:'snoozed', until:until.toISOString()}]; break;
      }
      case 'assign': {
        const to=lc(a.email);
        if(to&&!agents.some(x=>x.email===to)) throw Object.assign(new Error('Not a teammate on this account'), {status:400});
        if(acc.staff&&to&&to!==acc.me) throw Object.assign(new Error('Only an admin can assign chats to someone else'), {status:403});
        set.assignee_email=to; nc.push({Id:id, Owner:to});
        ev=[to?`Assigned to ${nameOf(to)} by ${actor.name}`:`Unassigned by ${actor.name}`, {type:'assigned', to}]; break;
      }
      case 'pin': set.pinned=a.pinned?1:0; nc.push({Id:id, Pinned:a.pinned?'Yes':'No'}); break;
      case 'priority': set.priority=Math.max(0, Math.min(4, Number(a.value)||0)); break;
      case 'labels': case 'label_add': case 'label_remove': {
        const cur=labelsOf(row.labels);
        const given=(Array.isArray(a.labels)?a.labels:[a.label]).map(x=>String(x||'').trim().slice(0,40)).filter(Boolean);
        const next=op==='labels'?given:op==='label_add'?[...cur, ...given.filter(g=>!cur.some(x=>lc(x)===lc(g)))]:cur.filter(x=>!given.some(g=>lc(g)===lc(x)));
        set.labels=next.join(', '); set.labels_key=chatsV2LabelsKey(set.labels); nc.push({Id:id, Tags:set.labels});
        const added=next.filter(x=>!cur.some(y=>lc(y)===lc(x))), removed=cur.filter(x=>!next.some(y=>lc(y)===lc(x)));
        if(added.length||removed.length) ev=[[added.length?`Label ${added.join(', ')} added`:'', removed.length?`Label ${removed.join(', ')} removed`:''].filter(Boolean).join(' · ')+` by ${actor.name}`, {type:'labels', added, removed}];
        break;
      }
      case 'handler': {
        const takeover=a.mode==='human';
        const fields=await deps.handover(env, payload, id, takeover);
        set.handover=fields?.Handover==='Yes'?'Yes':'No'; set.handover_by=String(fields?.HandoverBy||'');
        ev=[takeover?`${actor.name} took over from the bot`:`${actor.name} handed the chat back to the bot`, {type:'handler', mode:takeover?'human':'bot'}];
        break;
      }
    }
    if(Object.keys(set).length){ set.updated_at=now; d1.push([id, set]); }
    if(ev) events.push([id, ev]);
  }
  if(nc.length){
    // Pinned/ConvResolved are self-healing Leads columns (see worker.js handleChatPinLead).
    const used=[...new Set(nc.flatMap(p=>Object.keys(p)).filter(k=>k==='Pinned'||k==='ConvResolved'))];
    if(used.length&&deps.ensureLeadsColumns) await deps.ensureLeadsColumns(env, used);
    await ncPatchLeads(env, deps, nc);
  }
  const stmts=d1.map(([id, set])=>{ const {sql, vals}=setClause(set); return env.DB.prepare(`UPDATE conversations SET ${sql} WHERE lead_id=?`).bind(...vals, id); });
  for(let i=0;i<stmts.length;i+=50) await env.DB.batch(stmts.slice(i, i+50));
  const evOut={};
  for(const [id, [text, meta]] of events) evOut[id]=await insertEvent(env, id, cid, text, {...meta, by:actor.email}, actor);
  const fresh=await rowsByIds(env, rows.map(r=>Number(r.lead_id)));
  if(deps.broadcast) await deps.broadcast(env, cid, {type:'conv', lead_ids:fresh.map(r=>Number(r.lead_id)), by:acc.me});
  return {rows:fresh, events:evOut};
}

// ── AI assist ───────────────────────────────────────────────────────────────────────────────────
// Rewrite a draft, suggest replies, translate a message, summarise a chat — on the client's own AI
// setup (deps.ai = the engine's provider chain), cached per message so reopening is free.

export const CHATS_V2_REWRITE={
  rephrase:'Rephrase it in different words with the same meaning and tone.',
  friendlier:'Make it warmer and friendlier, still professional.',
  shorter:'Make it shorter and more direct. Keep every fact, price, date and link.',
  grammar:'Fix spelling, grammar and punctuation only. Change nothing else.',
  malayalam:'Translate it into natural Malayalam (Malayalam script) as a Kerala business would write on WhatsApp.',
  english:'Translate it into clear, simple English.',
};
const AI_RULES='Keep any {{variables}}, URLs, phone numbers, prices and dates exactly as written. Use WhatsApp formatting (*bold*, _italic_) only, never Markdown. Reply with the message text only — no quotes, no preface, no explanation.';

export function chatsV2Transcript(rows, max=4000){
  const lines=[];
  for(const r of rows){
    if(r.kind==='event'||r.kind==='note') continue;
    const who=r.role==='user'?'Customer':(r.sender_type==='bot'?'Business (bot)':'Business');
    const a=safeJson(r.attachment);
    const text=String(a.ai_text?(a.caption||r.content||''):(r.content||'')).replace(/\s+/g,' ').trim();
    const label=a.kind==='template'?'[template] ':a.kind&&a.kind!=='template'?`[${a.kind}] `:'';
    if(text||label) lines.push(`${who}: ${label}${text}`.slice(0,600));
  }
  let out=lines.join('\n');
  while(out.length>max&&lines.length>1){ lines.shift(); out=lines.join('\n'); }
  return out;
}
export function chatsV2ParseSuggestions(text){
  const t=String(text||'');
  const m=t.match(/\[[\s\S]*\]/);
  if(m){ try{ const a=JSON.parse(m[0]); if(Array.isArray(a)) return a.map(x=>String(x||'').trim()).filter(Boolean).slice(0,3).map(x=>x.slice(0,500)); }catch(e){} }
  return t.split('\n').map(x=>x.replace(/^\s*(?:[-*•]|\d+[.)])\s*/,'').replace(/^"|"$/g,'').trim()).filter(Boolean).slice(0,3).map(x=>x.slice(0,500));
}
async function aiCached(env, key, make){
  const hit=await env.DB.prepare('SELECT value FROM chat_ai_cache WHERE key=?').bind(key).first().catch(()=>null);
  if(hit) return JSON.parse(hit.value);
  const value=await make();
  if(value!=null) await env.DB.prepare('INSERT OR REPLACE INTO chat_ai_cache (key, value, at) VALUES (?,?,?)').bind(key, JSON.stringify(value), new Date().toISOString()).run().catch(()=>{});
  return value;
}
export async function chatsV2Ai(env, deps, c, acc, body){
  if(!deps.ai) throw Object.assign(new Error('AI is not available on this account'), {status:501});
  const op=String(body.op||'');
  const business=String(c?.client_name||c?.business_name||'the business').slice(0,80);
  if(op==='rewrite'){
    const mode=CHATS_V2_REWRITE[body.mode]?body.mode:'rephrase';
    const text=String(body.text||'').trim().slice(0,3000);
    if(!text) throw Object.assign(new Error('Nothing to rewrite'), {status:400});
    const out=await deps.ai(env, c, `You edit WhatsApp replies that ${business}'s team sends to customers. ${CHATS_V2_REWRITE[mode]} ${AI_RULES}`, text, {temperature:0.4, maxOutputTokens:600});
    if(!out) throw Object.assign(new Error('The AI did not answer — try again'), {status:502});
    return {text:toWhatsApp(String(out).trim().replace(/^"([\s\S]*)"$/,'$1'))};
  }
  if(op==='translate'){
    const target=body.target==='ml'?'Malayalam (Malayalam script)':'English';
    const text=String(body.text||'').trim().slice(0,3000);
    if(!text) throw Object.assign(new Error('Nothing to translate'), {status:400});
    const key=body.message_id?`tr:${Number(body.message_id)}:${body.target==='ml'?'ml':'en'}`:null;
    const make=async()=>{
      const out=await deps.ai(env, c, `Translate the customer's WhatsApp message into ${target}. It may be Malayalam, Manglish (Malayalam typed in English letters), Hindi, Arabic or English. ${AI_RULES}`, text, {temperature:0.1, maxOutputTokens:600});
      return out?{text:String(out).trim()}:null;
    };
    const res=key?await aiCached(env, key, make):await make();
    if(!res) throw Object.assign(new Error('The AI did not answer — try again'), {status:502});
    return res;
  }
  if(op==='suggest'||op==='summary'){
    const leadId=Number(body.lead_id);
    const row=await convRow(env, leadId);
    if(!row||Number(row.client_id)!==Number(c.Id)||!canSee(acc, row)) throw Object.assign(new Error('Conversation not found'), {status:404});
    const {results}=await env.DB.prepare(`SELECT role, content, attachment, sender_type, kind, ts FROM lead_messages WHERE lead_id=? ORDER BY ts DESC, id DESC LIMIT ${op==='summary'?80:20}`).bind(leadId).all();
    const transcript=chatsV2Transcript((results||[]).reverse(), op==='summary'?8000:4000);
    if(!transcript) return op==='summary'?{summary:''}:{suggestions:[]};
    const key=`${op}:${leadId}:${row.last_message_id||row.last_message_at}`;
    return aiCached(env, key, async()=>{
      if(op==='summary'){
        const out=await deps.ai(env, c, `Summarise this WhatsApp chat between a customer and ${business} for a team member taking it over. 3–6 short bullet lines starting with "• ": who the customer is, what they want, what was already offered or promised (prices, dates), and what is still open. Plain text, no Markdown headings.`, transcript, {temperature:0.2, maxOutputTokens:500});
        return {summary:String(out||'').trim()};
      }
      const out=await deps.ai(env, c, `You suggest the next reply ${business}'s team could send in this WhatsApp chat. Give 3 different, short, ready-to-send replies (one or two sentences each) that answer the customer's latest message. Never invent prices, stock, dates or policies that are not in the chat — ask or offer to check instead. Write in the customer's language. Return a JSON array of 3 strings and nothing else.`, transcript, {temperature:0.5, maxOutputTokens:500});
      return {suggestions:chatsV2ParseSuggestions(out).map(toWhatsApp)};
    });
  }
  throw Object.assign(new Error('Unknown AI action'), {status:400});
}

// ── Routes ──────────────────────────────────────────────────────────────────────────────────────

async function ensureSynced(env, deps, cid, ctx){
  const st=await env.DB.prepare('SELECT backfilled_at, reconciled_at FROM chat_sync_state WHERE client_id=?').bind(Number(cid)).first().catch(()=>null);
  if(!st?.backfilled_at){ await chatsV2Backfill(env, deps, cid); return; }
  if(!st.reconciled_at||Date.now()-Date.parse(st.reconciled_at)>RECONCILE_MS){
    const p=chatsV2Reconcile(env, deps, cid).catch(()=>{});
    if(ctx?.waitUntil) ctx.waitUntil(p); else await p;
  }
}

async function wakeSnoozed(env, deps, cid){
  const now=new Date().toISOString();
  const {results}=await env.DB.prepare(`SELECT lead_id FROM conversations WHERE client_id=? AND status='snoozed' AND snoozed_until<=?`).bind(Number(cid), now).all();
  if(!results?.length) return;
  await env.DB.prepare(`UPDATE conversations SET status='open', snoozed_until=NULL, updated_at=? WHERE client_id=? AND status='snoozed' AND snoozed_until<=?`).bind(now, Number(cid), now).run();
  if(deps.broadcast) await deps.broadcast(env, cid, {type:'conv', lead_ids:results.map(r=>Number(r.lead_id))});
}

async function hashOf(obj){
  const buf=await crypto.subtle.digest('SHA-1', new TextEncoder().encode(JSON.stringify(obj)));
  return [...new Uint8Array(buf)].slice(0,8).map(b=>b.toString(16).padStart(2,'0')).join('');
}

export async function chatsV2HandleRoute(request, env, deps, url, ctx=null){
  const {json}=deps;
  const path=url.pathname, method=request.method;
  const payload=await deps.requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  if(!await chatsV2Ready(env)) return json({error:'Chats v2 is unavailable'}, 503);
  const cid=Number(payload.cid);
  const c=await deps.getClientById(env, cid);
  if(!c) return json({error:'Client not found'}, 404);
  const acc=chatsV2Access(c, payload.email);
  const qp=Object.fromEntries(url.searchParams);
  const t0=Date.now();
  try{
    if(path==='/chats/v2/bootstrap'&&method==='GET'){
      const {results:canned}=await env.DB.prepare('SELECT id, shortcut, body FROM canned_responses WHERE client_id=? ORDER BY shortcut LIMIT 500').bind(cid).all();
      const {results:lab}=await env.DB.prepare(`SELECT labels FROM conversations WHERE client_id=? AND labels<>'' GROUP BY labels LIMIT 500`).bind(cid).all();
      const labels=[...new Set((lab||[]).flatMap(r=>labelsOf(r.labels)))].sort((x,y)=>x.localeCompare(y));
      const settings={sla_warn_min:Number(c.chats_sla_warn_min)||15, sla_breach_min:Number(c.chats_sla_breach_min)||60};
      const data={me:{email:acc.me, staff:acc.staff, locked:acc.locked}, agents:chatsV2Agents(c), labels, canned:canned||[], settings};
      const version=await hashOf(data);
      if(qp.v&&qp.v===version) return json({version, unchanged:true});
      return json({version, ...data});
    }
    if(path==='/chats/v2/list'&&method==='GET'){
      await ensureSynced(env, deps, cid, ctx);
      await wakeSnoozed(env, deps, cid);
      if(qp.updated_since){
        const s=scopeSql(acc);
        const {results}=await env.DB.prepare(`SELECT * FROM conversations WHERE client_id=? AND updated_at>?${s.sql} ORDER BY updated_at ASC LIMIT 500`).bind(cid, String(qp.updated_since), ...s.vals).all();
        return json({rows:await fillUnsynced(env, deps, cid, results||[]), server_time:new Date().toISOString()});
      }
      const out=await chatsV2List(env, cid, acc, qp);
      out.rows=await fillUnsynced(env, deps, cid, out.rows);
      return json({...out, server_time:new Date().toISOString(), ms:Date.now()-t0});
    }
    if(path==='/chats/v2/counts'&&method==='GET'){
      return json(await chatsV2Counts(env, cid, acc));
    }
    if(path==='/chats/v2/search'&&method==='GET'){
      const q=String(qp.q||'').trim().slice(0,80);
      if(q.length<2) return json({rows:[]});
      const like=`%${q.replace(/[%_]/g,'')}%`;
      const s=scopeSql(acc);
      const {results:byName}=await env.DB.prepare(`SELECT * FROM conversations WHERE client_id=? AND (name LIKE ? OR phone LIKE ?)${s.sql} ORDER BY last_message_at DESC LIMIT 30`).bind(cid, like, like, ...s.vals).all();
      const {results:hits}=await env.DB.prepare(`SELECT lead_id, MAX(ts) AS ts FROM lead_messages WHERE client_id=? AND kind NOT IN ('event') AND content LIKE ? GROUP BY lead_id ORDER BY ts DESC LIMIT 30`).bind(cid, like).all();
      const extra=(hits||[]).map(h=>Number(h.lead_id)).filter(id=>!(byName||[]).some(r=>Number(r.lead_id)===id));
      const more=(await rowsByIds(env, extra)).filter(r=>Number(r.client_id)===cid&&canSee(acc, r));
      return json({rows:[...(byName||[]), ...more]});
    }
    if(path==='/chats/v2/thread'&&method==='GET'){
      const leadId=Number(qp.lead_id);
      if(!leadId) return json({error:'lead_id required'}, 400);
      let row=await convRow(env, leadId);
      if(!row){
        // A chat this table hasn't seen yet (never had a D1 message): copy its history in first.
        const lead=await deps.seedLead(env, cid, leadId);
        if(!lead) return json({error:'Conversation not found'}, 404);
        row=await convRow(env, leadId);
      }
      if(!row||Number(row.client_id)!==cid||!canSee(acc, row)) return json({error:'Conversation not found'}, 404);
      if(!row.media_backfilled&&!qp.before&&!qp.after&&deps.backfillMedia){
        await env.DB.prepare('UPDATE conversations SET media_backfilled=1 WHERE lead_id=?').bind(leadId).run();
        const p=deps.backfillMedia(env, c, cid, {Id:leadId, ConversationID:row.conv_id}).catch(()=>{});
        if(ctx?.waitUntil) ctx.waitUntil(p);
      }
      const out=await chatsV2Thread(env, leadId, qp);
      return json({...out, conversation:row, ms:Date.now()-t0});
    }
    if(path==='/chats/v2/act'&&method==='POST'){
      const body=await request.json().catch(()=>({}));
      return json({ok:true, ...await chatsV2Act(env, deps, payload, c, acc, body)});
    }
    if(path==='/chats/v2/ai'&&method==='POST'){
      const body=await request.json().catch(()=>({}));
      return json(await chatsV2Ai(env, deps, c, acc, body));
    }
    if(path==='/chats/v2/canned'&&method==='POST'){
      const body=await request.json().catch(()=>({}));
      const shortcut=String(body.shortcut||'').trim().replace(/^\//,'').replace(/\s+/g,'-').toLowerCase().slice(0,40);
      const text=String(body.body||'').trim().slice(0,4000);
      if(!shortcut||!text) return json({error:'Shortcut and message are both required'}, 400);
      await env.DB.prepare(`INSERT INTO canned_responses (client_id, shortcut, body, updated_at) VALUES (?,?,?,?)
        ON CONFLICT(client_id, shortcut) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at`).bind(cid, shortcut, text, new Date().toISOString()).run();
      if(deps.broadcast) await deps.broadcast(env, cid, {type:'cfg'});
      return json({ok:true});
    }
    if(path==='/chats/v2/canned'&&method==='DELETE'){
      await env.DB.prepare('DELETE FROM canned_responses WHERE client_id=? AND id=?').bind(cid, Number(qp.id)).run();
      if(deps.broadcast) await deps.broadcast(env, cid, {type:'cfg'});
      return json({ok:true});
    }
    if(path==='/chats/v2/rum'&&method==='POST'){
      const body=await request.json().catch(()=>({}));
      const marks=Object.fromEntries(Object.entries(body.marks||{}).filter(([k,v])=>/^[a-z-]{1,40}$/.test(k)&&Number.isFinite(Number(v))).slice(0,20).map(([k,v])=>[k, Math.round(Number(v))]));
      console.log(JSON.stringify({chats_rum:true, cid, mode:String(body.mode||'').slice(0,8), marks}));
      return json({ok:true});
    }
    return json({error:'Not found'}, 404);
  }catch(e){
    return json({error:e?.message||'Chats error'}, e?.status||500);
  }
}
