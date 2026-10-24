// ── Shopify order notifications over WhatsApp templates, sent through Chatwoot ──────────────────
// A new Shopify order (and paid / shipped / delivered / abandoned-cart events) sends the customer
// an approved WhatsApp template — always through Chatwoot, never straight to Meta, so every
// notification sits in the customer's Chatwoot conversation next to the rest of the chat.
//
//  • Template: the Order Received template is created automatically (SHOPIFY_TEMPLATE_PRESETS —
//    wording + variable mapping) the first time it's needed: on connecting Shopify, from the
//    Notifications tab, or on the first order. Chatwoot can't create templates, so creation goes
//    to Meta with the inbox's own credentials, then Chatwoot is asked to sync. Other events use
//    whatever template is chosen in Ecom → Shopify, or "Set up automatically" in Notifications.
//  • Conversation: the customer's Chatwoot contact + WhatsApp conversation is found or created
//    from the order's phone (a buyer who has never messaged the store gets one).
//  • Tracking: every attempt is a row in D1 shopify_notify_sends (sent / delivered / read /
//    failed / skipped / pending), deduped per order + event so Shopify's webhook retries never
//    send twice. The Notifications tab (ecom.html) lists them; delivery status is refreshed from
//    the Chatwoot message (Meta's delivered/read/failed comes back there).
//
// worker.js passes helpers in as `deps` (SHOPIFY_NOTIFY_DEPS): { json, requireSession,
//   getClientById, patchClientFields, resolveOrDetectMetaCredentials, reportOpsError,
//   logWaTemplateSend, shopifySettings }

export const SHOPIFY_NOTIFY_KINDS=['received','paid','shipped','delivered','abandoned'];
export const SHOPIFY_NOTIFY_LABELS={received:'Order received', paid:'Payment received', shipped:'Order shipped', delivered:'Order delivered', abandoned:'Abandoned cart'};

// Ready-made template per event: wording, Meta category and which order value fills each {{n}}.
// Names are kept stable — stores that created one before keep using it.
export const SHOPIFY_TEMPLATE_PRESETS={
  received:{
    name:'order_received_leadvyne', category:'UTILITY', language:'en_US',
    body:'Hi {{1}}, thanks for your order {{2}}! Total: {{3}}. Items: {{4}}. We will notify you when it ships.',
    params:['customer_name','order_number','total','items'],
  },
  paid:{
    name:'order_payment_received_leadvyne', category:'UTILITY', language:'en_US',
    body:'Hi {{1}}, we have received your payment for order {{2}} ({{3}}). Thank you for your purchase!',
    params:['customer_name','order_number','total'],
  },
  shipped:{
    name:'order_shipped_leadvyne', category:'UTILITY', language:'en_US',
    body:'Hi {{1}}, your order {{2}} has shipped! Tracking number: {{3}}. Track it here: {{4}}',
    params:['customer_name','order_number','tracking_number','tracking_url'],
  },
  delivered:{
    name:'order_delivered_leadvyne', category:'UTILITY', language:'en_US',
    body:'Hi {{1}}, your order {{2}} has been delivered. We would love your feedback: {{3}}',
    params:['customer_name','order_number','review_link'],
  },
  abandoned:{
    name:'cart_reminder_leadvyne', category:'MARKETING', language:'en_US',
    body:'Hi {{1}}, you left some items in your cart at {{2}}. Complete your order here: {{3}}',
    params:['customer_name','store_name','checkout_url'],
  },
};

// ── Pure helpers (exported for tests) ─────────────────────────────────────────────────────────
const DIAL={IN:'91', US:'1', CA:'1', GB:'44', AE:'971', SA:'966', QA:'974', KW:'965', OM:'968', BH:'973', SG:'65', MY:'60', AU:'61', NZ:'64', LK:'94', NP:'977', BD:'880', PK:'92'};
// WhatsApp number (digits, with country code) from a Shopify phone. A bare 10-digit local number
// takes the order's country dialling code (India by default).
export function shopifyNotifyPhone(raw, countryCode){
  const s=String(raw||'').trim();
  let d=s.replace(/\D/g, '').replace(/^00/, '');
  if(!d) return '';
  if(!s.startsWith('+') && d.length===11 && d.startsWith('0')) d=d.slice(1);
  if(!s.startsWith('+') && d.length===10) d=(DIAL[String(countryCode||'').toUpperCase()]||'91')+d;
  return d.length>=8&&d.length<=15?d:'';
}

// Template variable values in {{n}} order, from the event's values and the template's mapping.
export function shopifyNotifyParams(cfg, vars){
  const values=(cfg?.params||[]).map(key=>String((key&&vars?.[key])??'').trim()||'-');
  const processed={};
  values.forEach((v, i)=>{ processed[String(i+1)]=v; });
  return {values, processed};
}
export function shopifyNotifyContent(body, values){
  return String(body||'').replace(/\{\{(\d+)\}\}/g, (m, n)=>values[Number(n)-1]??m);
}

const findTemplate=(templates, name, lang)=>(templates||[]).find(t=>t?.name===name&&(!lang||!t.language||t.language===lang))
  ||(templates||[]).find(t=>t?.name===name)||null;
export function shopifyNotifyTemplateBody(templates, name, lang){
  const t=findTemplate(templates, name, lang);
  return (t?.components||[]).find(x=>String(x.type).toUpperCase()==='BODY')?.text||'';
}
export function shopifyNotifyTemplateStatus(templates, name, lang){
  return String(findTemplate(templates, name, lang)?.status||'').toUpperCase();
}

// Chatwoot message → our status. Chatwoot records what Meta reported for the WhatsApp message.
export function shopifyNotifyDeliveryStatus(msg){
  const s=String(msg?.status||'').toLowerCase();
  const err=msg?.content_attributes?.external_error||'';
  if(s==='failed') return {status:'failed', detail:err||'WhatsApp did not deliver this message'};
  if(s==='read') return {status:'read', detail:''};
  if(s==='delivered') return {status:'delivered', detail:''};
  return {status:'sent', detail:''};
}

export function shopifyNotifyStats(rows, now=Date.now()){
  const week=now-7*86400000;
  const recent=(rows||[]).filter(r=>Date.parse(r.created_at)>=week);
  const n=st=>recent.filter(r=>st.includes(r.status)).length;
  return {sent:n(['sent','delivered','read']), delivered:n(['delivered','read']), read:n(['read']), failed:n(['failed']), waiting:n(['pending','skipped'])};
}

// ── D1 log ────────────────────────────────────────────────────────────────────────────────────
const _schemaReady=new WeakSet(); // per D1 binding
async function ensureSchema(env){
  if(!env.DB) return false;
  if(_schemaReady.has(env.DB)) return true;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS shopify_notify_sends (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, kind TEXT NOT NULL, order_ref TEXT NOT NULL DEFAULT '', order_name TEXT NOT NULL DEFAULT '', customer_name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', template_name TEXT NOT NULL DEFAULT '', template_lang TEXT NOT NULL DEFAULT '', params_json TEXT NOT NULL DEFAULT '[]', content TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', conv_id TEXT NOT NULL DEFAULT '', message_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_shopify_notify_client_time ON shopify_notify_sends(client_id, created_at)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_shopify_notify_order ON shopify_notify_sends(client_id, kind, order_ref)`),
  ]);
  _schemaReady.add(env.DB);
  return true;
}
async function insertRow(env, row){
  const now=new Date().toISOString();
  const r=await env.DB.prepare(`INSERT INTO shopify_notify_sends (client_id, kind, order_ref, order_name, customer_name, phone, template_name, template_lang, params_json, content, status, detail, conv_id, message_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(Number(row.client_id), row.kind, row.order_ref||'', row.order_name||'', row.customer_name||'', row.phone||'', row.template_name||'', row.template_lang||'', JSON.stringify(row.values||[]), row.content||'', row.status, String(row.detail||'').slice(0, 500), String(row.conv_id||''), String(row.message_id||''), now, now).run();
  return r?.meta?.last_row_id||null;
}
async function updateRow(env, id, fields){
  const keys=Object.keys(fields);
  if(!keys.length) return;
  await env.DB.prepare(`UPDATE shopify_notify_sends SET ${keys.map(k=>`${k}=?`).join(', ')}, updated_at=? WHERE id=?`)
    .bind(...keys.map(k=>String(fields[k]??'')), new Date().toISOString(), id).run();
}

// ── Chatwoot ──────────────────────────────────────────────────────────────────────────────────
const cwReady=c=>!!(c?.chatwoot_base&&c?.chatwoot_account_id&&c?.chatwoot_token);
async function cw(c, path, opts={}){
  const r=await fetch(`${c.chatwoot_base}/api/v1/accounts/${c.chatwoot_account_id}${path}`, {
    method:opts.method||'GET',
    headers:{api_access_token:c.chatwoot_token, ...(opts.body?{'Content-Type':'application/json'}:{})},
    ...(opts.body?{body:JSON.stringify(opts.body)}:{}),
  });
  const data=await r.json().catch(()=>({}));
  return {ok:r.ok, status:r.status, data};
}
const payloadOf=d=>d?.payload??d?.data?.payload??d;
const digitsOf=v=>String(v||'').replace(/\D/g, '');

export function shopifyNotifyInboxId(c, deps){
  return String(c?.shopify_notify_inbox_id||deps?.inboxIdFor?.(c)||c?.chatwoot_inbox_id||'');
}

async function inboxTemplates(c, inboxId){
  const r=await cw(c, `/inboxes/${inboxId}`);
  return r.ok?(r.data?.message_templates||payloadOf(r.data)?.message_templates||[]):[];
}
async function syncTemplates(c, inboxId){
  await cw(c, `/inboxes/${inboxId}/sync_templates`, {method:'POST'}).catch(()=>null);
}

// The customer's WhatsApp conversation in this inbox — found, or created (contact, contact inbox,
// conversation) for a buyer who has never messaged the store.
export async function shopifyNotifyConversation(c, inboxId, digits, name){
  const search=await cw(c, `/contacts/search?q=${encodeURIComponent(digits)}`);
  const found=(Array.isArray(payloadOf(search.data))?payloadOf(search.data):[])
    .find(x=>digitsOf(x.phone_number)===digits)
    ||(Array.isArray(payloadOf(search.data))?payloadOf(search.data):[]).find(x=>digitsOf(x.phone_number).endsWith(digits.slice(-10))&&digits.slice(-10).length===10);
  let contact=found||null, sourceId='';
  if(!contact){
    const created=await cw(c, '/contacts', {method:'POST', body:{inbox_id:Number(inboxId), name:name||`+${digits}`, phone_number:`+${digits}`}});
    const p=payloadOf(created.data);
    contact=p?.contact||p;
    sourceId=p?.contact_inbox?.source_id||'';
    if(!created.ok||!contact?.id) return {error:`Chatwoot could not create the contact (HTTP ${created.status})`};
  }
  const convs=await cw(c, `/contacts/${contact.id}/conversations`);
  const list=(Array.isArray(payloadOf(convs.data))?payloadOf(convs.data):[]).filter(v=>String(v.inbox_id)===String(inboxId));
  if(list.length){
    list.sort((a, b)=>(b.last_activity_at||b.id||0)-(a.last_activity_at||a.id||0));
    return {convId:String(list[0].id), contactId:contact.id};
  }
  if(!sourceId){
    sourceId=(contact.contact_inboxes||[]).find(ci=>String(ci.inbox?.id??ci.inbox_id)===String(inboxId))?.source_id||'';
    if(!sourceId){
      const ci=await cw(c, `/contacts/${contact.id}/contact_inboxes`, {method:'POST', body:{inbox_id:Number(inboxId), source_id:digits}});
      sourceId=payloadOf(ci.data)?.source_id||digits;
    }
  }
  const conv=await cw(c, '/conversations', {method:'POST', body:{source_id:sourceId, inbox_id:Number(inboxId), contact_id:contact.id, status:'open'}});
  const id=payloadOf(conv.data)?.id??conv.data?.id;
  return conv.ok&&id?{convId:String(id), contactId:contact.id}:{error:`Chatwoot could not open a conversation (HTTP ${conv.status})`};
}

// ── Template auto-setup ───────────────────────────────────────────────────────────────────────
function readStored(c){
  let st={}; try{ st=JSON.parse(c?.shopify_notify_config||'{}')||{}; }catch(e){}
  return {...st, config:{...(st.config||{})}};
}

// Makes sure `kind` has a template: keeps one already chosen, else creates the preset on Meta
// (with the WhatsApp inbox's own credentials), saves its variable mapping and asks Chatwoot to sync.
export async function shopifyEnsureNotifyTemplate(env, deps, c, kind){
  const preset=SHOPIFY_TEMPLATE_PRESETS[kind];
  if(!preset) return {error:'Unknown notification'};
  const stored=readStored(c);
  if(stored.config[kind]?.name) return {cfg:stored.config[kind], existing:true};
  const inboxId=shopifyNotifyInboxId(c, deps);
  const creds=await deps.resolveOrDetectMetaCredentials(env, c, c.Id, {inbox_id:inboxId}).catch(()=>null);
  if(!creds?.waba_id||!creds?.wa_token) return {error:'Meta credentials for the WhatsApp channel are needed to create a template — use Detect credentials in Settings → Channels.'};
  const r=await fetch(`https://graph.facebook.com/v18.0/${creds.waba_id}/message_templates`, {
    method:'POST', headers:{Authorization:`Bearer ${creds.wa_token}`, 'Content-Type':'application/json'},
    body:JSON.stringify({name:preset.name, category:preset.category, language:preset.language, components:[{type:'BODY', text:preset.body}]}),
  });
  const data=await r.json().catch(()=>({}));
  const exists=/already exists/i.test(data?.error?.error_user_msg||data?.error?.message||'')||data?.error?.error_subcode===2388024;
  if(!r.ok&&!exists) return {error:`Meta: ${data?.error?.error_user_msg||data?.error?.message||'HTTP '+r.status}`};
  const cfg={name:preset.name, lang:preset.language, category:preset.category, params:preset.params.slice(), auto:true};
  stored.config[kind]=cfg;
  const value=JSON.stringify(stored);
  await deps.patchClientFields(env, c.Id, {shopify_notify_config:value});
  c.shopify_notify_config=value;
  if(cwReady(c)&&inboxId) await syncTemplates(c, inboxId);
  return {cfg, created:!exists, status:data?.status||(exists?'':'PENDING')};
}

// ── Send ──────────────────────────────────────────────────────────────────────────────────────
// `vars`: values for the template variables; `meta`: {phone, order (name), ref (order id / checkout
// token — dedupe key), country, customer}. Never throws.
export async function shopifySendNotification(env, deps, c, kind, vars, meta={}, {retryOf=null}={}){
  try{
    if(deps.shopifySettings(c).notify===false) return {status:'off'};
    if(!await ensureSchema(env)) return {status:'no_db'};
    const ref=String(meta.ref||meta.order||'');
    if(!retryOf && ref){
      const dup=await env.DB.prepare(`SELECT id FROM shopify_notify_sends WHERE client_id=? AND kind=? AND order_ref=? AND status IN ('sent','delivered','read') LIMIT 1`).bind(Number(c.Id), kind, ref).first();
      if(dup) return {status:'duplicate'};
    }
    const base={client_id:c.Id, kind, order_ref:ref, order_name:meta.order||'', customer_name:meta.customer||vars?.customer_name||''};
    const record=async(row)=>{
      if(retryOf){ await updateRow(env, retryOf, {status:row.status, detail:row.detail||'', conv_id:row.conv_id||'', message_id:row.message_id||'', template_name:row.template_name||'', content:row.content||''}); return {...row, id:retryOf}; }
      return {...row, id:await insertRow(env, {...base, ...row})};
    };

    let cfg=readStored(c).config[kind];
    if(!cfg?.name && kind==='received'){
      const made=await shopifyEnsureNotifyTemplate(env, deps, c, kind);
      cfg=made.cfg;
      if(!cfg) return record({status:'skipped', detail:`No template yet — ${made.error}`, phone:meta.phone||''});
    }
    if(!cfg?.name) return record({status:'skipped', detail:'No template chosen for this event (Ecom → Shopify, or Set up automatically in Notifications)', phone:meta.phone||''});
    const phone=shopifyNotifyPhone(meta.phone, meta.country);
    const {values, processed}=shopifyNotifyParams(cfg, vars);
    const common={phone, template_name:cfg.name, template_lang:cfg.lang||'en', values};
    if(!phone) return record({...common, status:'skipped', detail:'No customer phone on this order'});
    const inboxId=shopifyNotifyInboxId(c, deps);
    if(!cwReady(c)||!inboxId) return record({...common, status:'skipped', detail:'Chatwoot WhatsApp inbox not connected (Settings → Channels)'});

    const templates=await inboxTemplates(c, inboxId);
    const tStatus=shopifyNotifyTemplateStatus(templates, cfg.name, cfg.lang);
    const body=shopifyNotifyTemplateBody(templates, cfg.name, cfg.lang)||Object.values(SHOPIFY_TEMPLATE_PRESETS).find(p=>p.name===cfg.name)?.body||'';
    const content=shopifyNotifyContent(body, values)||`${cfg.name}: ${values.join(' · ')}`;
    if(tStatus==='REJECTED') return record({...common, content, status:'failed', detail:'Meta rejected this template — choose or create another'});
    if(tStatus&&tStatus!=='APPROVED'){
      await syncTemplates(c, inboxId);
      return record({...common, content, status:'pending', detail:`Template is ${tStatus.toLowerCase()} at Meta — retry once it's approved`});
    }
    if(!tStatus) await syncTemplates(c, inboxId); // not in Chatwoot's copy yet — refresh it, send anyway

    const conv=await shopifyNotifyConversation(c, inboxId, phone, meta.customer||vars?.customer_name||'');
    if(conv.error) return record({...common, content, status:'failed', detail:conv.error});
    const sent=await cw(c, `/conversations/${conv.convId}/messages`, {method:'POST', body:{
      content, message_type:'outgoing', private:false,
      template_params:{name:cfg.name, category:cfg.category||SHOPIFY_TEMPLATE_PRESETS[kind]?.category||'UTILITY', language:cfg.lang||'en', processed_params:processed},
    }});
    if(!sent.ok) return record({...common, content, conv_id:conv.convId, status:'failed', detail:`Chatwoot HTTP ${sent.status}: ${String(sent.data?.error||sent.data?.message||'').slice(0, 200)}`});
    const msg=payloadOf(sent.data);
    const st=shopifyNotifyDeliveryStatus(msg);
    await deps.logWaTemplateSend(env, c.Id, 'shopify', {template:cfg.name, phone});
    return record({...common, content, conv_id:conv.convId, message_id:String(msg?.id||''), status:st.status, detail:st.detail});
  }catch(e){
    await deps.reportOpsError(env, `shopify notification ${kind}`, e, {clientId:c?.Id});
    return {status:'error'};
  }
}

// Delivery status for recent sends, from their Chatwoot messages (Meta reports delivered / read /
// failed there). Bounded: the 15 newest still-"sent" rows from the last 7 days.
async function refreshStatuses(env, c){
  if(!cwReady(c)) return;
  const since=new Date(Date.now()-7*86400000).toISOString();
  const {results}=await env.DB.prepare(`SELECT id, conv_id, message_id FROM shopify_notify_sends WHERE client_id=? AND status IN ('sent','delivered') AND message_id!='' AND created_at>=? ORDER BY id DESC LIMIT 15`).bind(Number(c.Id), since).all();
  const byConv=new Map();
  for(const row of results||[]){
    if(!byConv.has(row.conv_id)){
      const r=await cw(c, `/conversations/${row.conv_id}/messages`);
      byConv.set(row.conv_id, r.ok?(payloadOf(r.data)||[]):[]);
    }
    const msg=(byConv.get(row.conv_id)||[]).find(m=>String(m.id)===String(row.message_id));
    if(!msg) continue;
    const st=shopifyNotifyDeliveryStatus(msg);
    await updateRow(env, row.id, {status:st.status, detail:st.detail});
  }
}

// ── Routes (dashboard session — these rows carry customer phone numbers) ─────────────────────
async function sessionClient(request, env, deps){
  const payload=await deps.requireSession(request, env);
  if(!payload) return {error:deps.json({error:'Invalid or expired session'}, 401)};
  const c=await deps.getClientById(env, payload.cid);
  if(!c) return {error:deps.json({error:'Client not found'}, 404)};
  return {c};
}

async function handleList(request, env, deps){
  const {c, error}=await sessionClient(request, env, deps);
  if(error) return error;
  if(!await ensureSchema(env)) return deps.json({rows:[], stats:shopifyNotifyStats([]), templates:[]});
  const url=new URL(request.url);
  if(url.searchParams.get('refresh')==='1') await refreshStatuses(env, c).catch(()=>{});
  const {results}=await env.DB.prepare(`SELECT id, kind, order_ref, order_name, customer_name, phone, template_name, content, status, detail, conv_id, created_at, updated_at FROM shopify_notify_sends WHERE client_id=? ORDER BY id DESC LIMIT 500`).bind(Number(c.Id)).all();
  const rows=results||[];
  const stored=readStored(c);
  const inboxId=shopifyNotifyInboxId(c, deps);
  const templates=cwReady(c)&&inboxId?await inboxTemplates(c, inboxId).catch(()=>[]):[];
  return deps.json({
    rows, stats:shopifyNotifyStats(rows),
    chatwoot:{ready:cwReady(c)&&!!inboxId, base:c.chatwoot_base||'', account:String(c.chatwoot_account_id||''), inbox:inboxId},
    notify_on:deps.shopifySettings(c).notify!==false,
    templates:SHOPIFY_NOTIFY_KINDS.map(kind=>{
      const cfg=stored.config[kind];
      return {kind, label:SHOPIFY_NOTIFY_LABELS[kind], name:cfg?.name||'', lang:cfg?.lang||'', auto:!!cfg?.auto,
        status:cfg?.name?(shopifyNotifyTemplateStatus(templates, cfg.name, cfg.lang)||'SYNCING'):'', preset:SHOPIFY_TEMPLATE_PRESETS[kind].body};
    }),
  });
}

async function handleSetup(request, env, deps){
  const {c, error}=await sessionClient(request, env, deps);
  if(error) return error;
  const {kind}=await request.json().catch(()=>({}));
  const out=await shopifyEnsureNotifyTemplate(env, deps, c, kind);
  if(out.error) return deps.json({error:out.error}, 400);
  return deps.json({ok:true, name:out.cfg.name, created:!!out.created, existing:!!out.existing});
}

async function handleRetry(request, env, deps){
  const {c, error}=await sessionClient(request, env, deps);
  if(error) return error;
  if(!await ensureSchema(env)) return deps.json({error:'Database unavailable'}, 500);
  const {id}=await request.json().catch(()=>({}));
  const row=await env.DB.prepare(`SELECT * FROM shopify_notify_sends WHERE id=? AND client_id=?`).bind(Number(id), Number(c.Id)).first();
  if(!row) return deps.json({error:'Not found'}, 404);
  if(['sent','delivered','read'].includes(row.status)) return deps.json({error:'Already sent'}, 400);
  // Re-send with the values captured the first time, through the event's current template.
  const cfg=readStored(c).config[row.kind]||{};
  let values=[]; try{ values=JSON.parse(row.params_json||'[]'); }catch(e){}
  const vars={};
  (cfg.params||[]).forEach((key, i)=>{ if(key&&values[i]!==undefined&&values[i]!=='-') vars[key]=values[i]; });
  if(!vars.customer_name&&row.customer_name) vars.customer_name=row.customer_name;
  const out=await shopifySendNotification(env, deps, c, row.kind, vars, {phone:row.phone?`+${row.phone}`:'', order:row.order_name, ref:row.order_ref, customer:row.customer_name}, {retryOf:row.id});
  return deps.json({ok:true, status:out.status, detail:out.detail||''});
}

export async function shopifyNotifyHandleRoute(request, env, deps, url){
  const p=url.pathname, m=request.method;
  if(p==='/ecom/shopify/notifications'&&m==='GET') return handleList(request, env, deps);
  if(p==='/ecom/shopify/notifications/setup'&&m==='POST') return handleSetup(request, env, deps);
  if(p==='/ecom/shopify/notifications/retry'&&m==='POST') return handleRetry(request, env, deps);
  return null;
}
