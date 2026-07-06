// ── WHAT THIS IS ─────────────────────────────────────────────────────────────
// Thin API proxy, hosted on Cloudflare Workers instead of a self-hosted container
// (avoids the Docker cross-resource networking problem hit trying to do this on
// Coolify). Sits between the dashboard (browser) and NocoDB/Chatwoot/Meta:
//   - The master NocoDB token lives only here (a Worker secret), never in the
//     browser — dashboard.html currently ships it in plain JS.
//   - Each client's Chatwoot/Meta tokens are looked up here per-request from
//     NocoDB, not embedded in the page.
//   - Login re-uses Authentik (already deployed) instead of a separate password
//     system: the browser does the Authentik OIDC/PKCE exchange itself (public
//     client, no secret), then hands the resulting access_token to this Worker's
//     /session/exchange, which verifies it against Authentik's userinfo endpoint
//     and issues its own signed session token. Authentik's access tokens are
//     short-lived (minutes) — this avoids needing token-refresh logic in the
//     browser for a whole session.
//
// Known limitation: index.html, broadcast.html, and ecom.html still embed the
// master NocoDB token directly and are NOT covered by this Worker yet — same
// exposure as before, just not yet migrated. dashboard.html is the primary
// surface and is fully migrated.

const SESSION_TTL_SECONDS = 24 * 3600;
const CLIENTS_TABLE = 'mxl33bg4wi70fqj';
const DEFAULT_LEADS_TABLE = 'mvg6rcw0ia5qqrx';

function corsHeaders(origin, env){
  const allowed=(env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);
  const headers={};
  if(origin && allowed.includes(origin)){
    headers['Access-Control-Allow-Origin']=origin;
    headers['Access-Control-Allow-Headers']='Content-Type, Authorization';
    headers['Access-Control-Allow-Methods']='GET, POST, PATCH, DELETE, OPTIONS';
  }
  return headers;
}
function json(data, status, extraHeaders){
  return new Response(JSON.stringify(data), {status:status||200, headers:{'Content-Type':'application/json', ...extraHeaders}});
}

/* ── NocoDB helpers (master token, server-side only) ── */
async function ncFetch(env, path, {method='GET', body}={}){
  const r=await fetch(`${env.NOCODB_BASE}/${path}`, {
    method,
    headers:{'xc-token':env.NOCODB_TOKEN, 'Content-Type':'application/json'},
    body: body?JSON.stringify(body):undefined
  });
  return r;
}

/* ── Chatwoot Platform API (master token, server-side only) — provisions a new
   Chatwoot Account + User per client. Only reaches accounts/users it created
   itself (Chatwoot restricts Platform tokens to their own objects). ── */
async function chatwootPlatformFetch(env, path, {method='GET', body}={}){
  return fetch(`${env.CHATWOOT_INSTANCE_BASE}${path}`, {
    method,
    headers:{api_access_token:env.CHATWOOT_PLATFORM_TOKEN, 'Content-Type':'application/json'},
    body: body?JSON.stringify(body):undefined
  });
}
async function getClientById(env, clientId){
  const r=await ncFetch(env, `api/v2/tables/${CLIENTS_TABLE}/records/${clientId}`);
  if(!r.ok) return null;
  return r.json();
}
async function getClientByAuthentikEmail(env, email){
  const r=await ncFetch(env, `api/v2/tables/${CLIENTS_TABLE}/records?where=(authentik_email,eq,${encodeURIComponent(email)})&limit=1`);
  if(!r.ok) return null;
  const data=await r.json();
  if(data?.list?.[0]) return data.list[0];

  // Multi-user support: team_emails is a comma-separated list of additional Authentik emails
  // that log into the same CLIENTS row with full access (no separate invite flow — the owner
  // just adds an email, and the moment that person signs in via Authentik they land here
  // instead of getting auto-provisioned a brand-new account). NocoDB's LIKE can't safely confirm
  // an exact match within a comma list on its own, so it's used only as a prefilter here — the
  // real match is an exact, case-insensitive comparison done in JS below.
  const whereClause=`(team_emails,like,%${email}%)`;
  const r2=await ncFetch(env, `api/v2/tables/${CLIENTS_TABLE}/records?where=${encodeURIComponent(whereClause)}&limit=25`);
  if(!r2.ok) return null;
  const data2=await r2.json().catch(()=>({}));
  const wanted=email.toLowerCase();
  return (data2?.list||[]).find(row=>(row.team_emails||'').split(',').map(e=>e.trim().toLowerCase()).includes(wanted))||null;
}
async function patchClientFields(env, clientId, fields){
  const r=await ncFetch(env, `api/v2/tables/${CLIENTS_TABLE}/records`, {method:'PATCH', body:{Id:Number(clientId), ...fields}});
  if(!r.ok) throw new Error('Failed to save client record: HTTP '+r.status);
  return r.json().catch(()=>({}));
}
async function findOtherClientByField(env, field, value, excludeId){
  if(!value) return null;
  const r=await ncFetch(env, `api/v2/tables/${CLIENTS_TABLE}/records?where=(${field},eq,${encodeURIComponent(value)})&limit=5`);
  if(!r.ok) return null;
  const data=await r.json().catch(()=>({}));
  return (data?.list||[]).find(row=>String(row.Id)!==String(excludeId))||null;
}
async function findClientByField(env, field, value){
  if(!value) return null;
  const r=await ncFetch(env, `api/v2/tables/${CLIENTS_TABLE}/records?where=(${field},eq,${encodeURIComponent(value)})&limit=1`);
  if(!r.ok) return null;
  const data=await r.json().catch(()=>({}));
  return data?.list?.[0]||null;
}
/* ── Stripe REST client (fetch-based, no SDK — this Worker ships as a single
   file with no npm build step). Params are flattened to Stripe's bracket
   notation for its form-encoded API, e.g. {line_items:[{price:'x'}]} ->
   'line_items[0][price]=x'. ── */
function stripeParams(obj, prefix){
  const out=[];
  for(const [k,v] of Object.entries(obj)){
    if(v===undefined||v===null) continue;
    const key=prefix?`${prefix}[${k}]`:k;
    if(Array.isArray(v)) v.forEach((item,i)=>{
      const ik=`${key}[${i}]`;
      if(item && typeof item==='object') out.push(...stripeParams(item, ik));
      else out.push([ik, String(item)]);
    });
    else if(v && typeof v==='object') out.push(...stripeParams(v, key));
    else out.push([key, String(v)]);
  }
  return out;
}
async function stripeFetch(env, method, path, params){
  const isGet=method==='GET';
  const qs=new URLSearchParams(params?stripeParams(params):[]).toString();
  const r=await fetch(`https://api.stripe.com/v1/${path}${isGet&&qs?'?'+qs:''}`, {
    method,
    headers:{Authorization:`Bearer ${env.STRIPE_SECRET_KEY}`, ...(isGet?{}:{'Content-Type':'application/x-www-form-urlencoded'})},
    body: isGet?undefined:qs
  });
  const data=await r.json().catch(()=>({}));
  return {ok:r.ok, status:r.status, data};
}
function hex(buffer){ return [...new Uint8Array(buffer)].map(b=>b.toString(16).padStart(2,'0')).join(''); }
async function verifyStripeSignature(env, rawBody, sigHeader){
  if(!sigHeader) return false;
  const parts=Object.fromEntries(sigHeader.split(',').map(p=>p.split('=')));
  const timestamp=parts.t, v1=parts.v1;
  if(!timestamp||!v1) return false;
  if(Math.abs(Date.now()/1000 - Number(timestamp)) > 300) return false; // reject signatures older than 5 minutes (replay protection)
  const key=await crypto.subtle.importKey('raw', new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const sig=await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${rawBody}`));
  const expected=hex(sig);
  if(expected.length!==v1.length) return false;
  let diff=0;
  for(let i=0;i<expected.length;i++) diff|=expected.charCodeAt(i)^v1.charCodeAt(i);
  return diff===0;
}

function safeClient(rec){
  const {dashboard_password, ...safe}=rec;
  return safe;
}

/* ── Session token: HMAC-signed, not a full JWT — just enough to avoid a
   database round-trip on every request and to avoid depending on Authentik's
   short-lived access tokens for the rest of the session. ── */
async function signSession(env, clientId){
  const payload={cid:String(clientId), exp:Math.floor(Date.now()/1000)+SESSION_TTL_SECONDS};
  const body=btoa(JSON.stringify(payload));
  const key=await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SIGNING_KEY), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const sig=await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const sigB64=btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  return `${body}.${sigB64}`;
}
async function verifySession(env, token){
  if(!token) return null;
  const [body, sig]=token.split('.');
  if(!body||!sig) return null;
  const key=await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SIGNING_KEY), {name:'HMAC', hash:'SHA-256'}, false, ['sign','verify']);
  const expected=await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const expectedB64=btoa(String.fromCharCode(...new Uint8Array(expected))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  if(expectedB64!==sig) return null;
  let payload;
  try{ payload=JSON.parse(atob(body)); }catch(e){ return null; }
  if(!payload.cid||!payload.exp||payload.exp<Math.floor(Date.now()/1000)) return null;
  return payload;
}

async function requireSession(request, env){
  const auth=request.headers.get('Authorization')||'';
  const token=auth.startsWith('Bearer ')?auth.slice(7):'';
  const payload=await verifySession(env, token);
  if(!payload) return null;
  return payload; // { cid, exp }
}

/* ── ROUTES ── */
async function handleSessionExchange(request, env){
  const {access_token}=await request.json().catch(()=>({}));
  if(!access_token) return json({error:'access_token required'}, 400);
  const info=await fetch(`${env.AUTHENTIK_BASE}/application/o/userinfo/`, {headers:{Authorization:`Bearer ${access_token}`}});
  if(!info.ok) return json({error:'Invalid or expired Authentik session'}, 401);
  const claims=await info.json();
  const email=(claims.email||claims.preferred_username||'').toLowerCase();
  if(!email) return json({error:'Your Authentik account has no email set.'}, 400);
  const rec=await getClientByAuthentikEmail(env, email);
  if(!rec||!rec.Id){
    // Not an error condition by itself — this is also what a brand-new signup looks like on
    // first login. Return the verified email so the frontend can offer to finish provisioning
    // this account instead of just showing a dead-end error.
    return json({error:'no_account', email}, 403);
  }
  const session_token=await signSession(env, rec.Id);
  return json({session_token, client_id:String(rec.Id), client:safeClient(rec)});
}

async function handleSessionMe(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const rec=await getClientById(env, payload.cid);
  if(!rec||!rec.Id) return json({error:'Client not found'}, 404);
  return json({client_id:String(rec.Id), client:safeClient(rec)});
}

async function handleNocodbPassthrough(request, env, upstreamPath){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);

  const url=new URL(request.url);
  const qs=url.search.slice(1);

  if(qs){
    const m=decodeURIComponent(qs).match(/ClientId,eq,([^)&]+)/);
    if(m && m[1]!==payload.cid) return json({error:'client_id mismatch'}, 403);
  }
  const singleClientRecord=upstreamPath.match(new RegExp(`tables/${CLIENTS_TABLE}/records/(\\d+)$`));
  if(singleClientRecord && singleClientRecord[1]!==payload.cid) return json({error:'client_id mismatch'}, 403);

  const method=request.method;
  const hasBody=!['GET','HEAD'].includes(method);
  const body=hasBody?await request.text():undefined;
  const r=await fetch(`${env.NOCODB_BASE}/${upstreamPath}${qs?'?'+qs:''}`, {
    method,
    headers:{'xc-token':env.NOCODB_TOKEN, 'Content-Type':'application/json'},
    body
  });
  const data=await r.text();
  return new Response(data, {status:r.status, headers:{'Content-Type':'application/json'}});
}

async function handleChatSend(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const {conv_id, text}=await request.json().catch(()=>({}));
  if(!conv_id||!text) return json({error:'conv_id and text required'}, 400);
  const c=await getClientById(env, payload.cid);
  if(!c?.chatwoot_base||!c?.chatwoot_account_id||!c?.chatwoot_token) return json({error:'Chatwoot is not configured for this account.'}, 400);
  const fd=new FormData();
  fd.append('content', text); fd.append('message_type','outgoing'); fd.append('private','false');
  const r=await fetch(`${c.chatwoot_base}/api/v1/accounts/${c.chatwoot_account_id}/conversations/${conv_id}/messages`, {method:'POST', headers:{api_access_token:c.chatwoot_token}, body:fd});
  if(!r.ok) return json({error:'HTTP '+r.status}, 502);
  return json({ok:true, data:await r.json().catch(()=>({}))});
}

async function handleQuoteSend(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const form=await request.formData();
  const conv_id=form.get('conv_id'), caption=form.get('caption')||'', file=form.get('file');
  if(!conv_id||!file) return json({error:'conv_id and file required'}, 400);
  const c=await getClientById(env, payload.cid);
  if(!c?.chatwoot_base||!c?.chatwoot_account_id||!c?.chatwoot_token) return json({error:'Chatwoot is not configured for this account.'}, 400);
  const fd=new FormData();
  fd.append('message_type','outgoing'); fd.append('private','false'); fd.append('content', caption);
  fd.append('attachments[]', file, file.name||'quotation.pdf');
  const r=await fetch(`${c.chatwoot_base}/api/v1/accounts/${c.chatwoot_account_id}/conversations/${conv_id}/messages`, {method:'POST', headers:{api_access_token:c.chatwoot_token}, body:fd});
  if(!r.ok) return json({error:'HTTP '+r.status}, 502);
  return json({ok:true, data:await r.json().catch(()=>({}))});
}

async function handleWaTemplatesGet(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const c=await getClientById(env, payload.cid);
  if(!c?.waba_id||!c?.wa_token) return json({error:'WhatsApp Business Account ID / token not configured.'}, 400);
  const r=await fetch(`https://graph.facebook.com/v18.0/${c.waba_id}/message_templates?fields=name,status,language,category&limit=200`, {headers:{Authorization:`Bearer ${c.wa_token}`}});
  const data=await r.json();
  if(!r.ok) return json({error:data?.error?.message||'HTTP '+r.status}, 502);
  return json(data);
}

async function handleWaTemplatesCreate(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const {name, category, language, body}=await request.json().catch(()=>({}));
  if(!name||!body) return json({error:'name and body required'}, 400);
  const c=await getClientById(env, payload.cid);
  if(!c?.waba_id||!c?.wa_token) return json({error:'WhatsApp Business Account ID / token not configured.'}, 400);
  const r=await fetch(`https://graph.facebook.com/v18.0/${c.waba_id}/message_templates`, {
    method:'POST', headers:{Authorization:`Bearer ${c.wa_token}`, 'Content-Type':'application/json'},
    body:JSON.stringify({name, category, language, components:[{type:'BODY', text:body}]})
  });
  const data=await r.json();
  if(!r.ok) return json({error:data?.error?.message||'HTTP '+r.status}, 502);
  return json(data);
}

async function handleWaSend(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const {phone, text}=await request.json().catch(()=>({}));
  if(!phone||!text) return json({error:'phone and text required'}, 400);
  const c=await getClientById(env, payload.cid);
  if(!c?.wa_phone_id||!c?.wa_token) return json({error:'WhatsApp phone / token not configured.'}, 400);
  const r=await fetch(`https://graph.facebook.com/v18.0/${c.wa_phone_id}/messages`, {
    method:'POST', headers:{Authorization:`Bearer ${c.wa_token}`, 'Content-Type':'application/json'},
    body:JSON.stringify({messaging_product:'whatsapp', to:phone, type:'text', text:{body:text}})
  });
  const data=await r.json();
  if(!r.ok) return json({error:data?.error?.message||'HTTP '+r.status}, 502);
  return json({ok:true, data});
}

async function handleAiComplete(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const {model, temperature, max_tokens, messages}=await request.json().catch(()=>({}));
  if(!Array.isArray(messages)||!messages.length) return json({error:'messages required'}, 400);
  const c=await getClientById(env, payload.cid);
  if(!c?.openrouter_key) return json({error:'No OpenRouter API key set for this account.'}, 400);
  const r=await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method:'POST',
    headers:{Authorization:`Bearer ${c.openrouter_key}`, 'Content-Type':'application/json'},
    body:JSON.stringify({model:model||c.model||'google/gemini-2.5-flash', temperature, max_tokens, messages})
  });
  const data=await r.json();
  if(!r.ok) return json({error:data?.error?.message||'HTTP '+r.status}, 502);
  return json(data);
}

/* ── Channels module ──────────────────────────────────────────────────────
   Automates what SETUP.md used to require by hand: creating the client's
   Chatwoot account, connecting WhatsApp via Meta Embedded Signup, and adding
   other inbox types — all driven from the dashboard's Channels page. ── */
async function handleChannelsCreateAccount(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  if(!env.CHATWOOT_PLATFORM_TOKEN||!env.CHATWOOT_INSTANCE_BASE) return json({error:'Chatwoot platform credentials are not configured on the server.'}, 500);
  const c=await getClientById(env, payload.cid);
  if(!c) return json({error:'Client not found'}, 404);
  if(c.chatwoot_account_id && c.chatwoot_token) return json({error:'A Chatwoot account is already connected for this client.'}, 400);

  const acctR=await chatwootPlatformFetch(env, '/platform/api/v1/accounts', {method:'POST', body:{name:c.client_name||`Leadvyne client ${c.Id}`}});
  const acct=await acctR.json().catch(()=>({}));
  if(!acctR.ok||!acct?.id) return json({error:'Chatwoot account creation failed: '+(acct?.message||('HTTP '+acctR.status))}, 502);

  const email=c.authentik_email||`client-${c.Id}@leadvyne.local`;
  const password=crypto.randomUUID()+'Aa1!'; // random — never shown to the client, only the returned access_token is used
  const userR=await chatwootPlatformFetch(env, '/platform/api/v1/users', {method:'POST', body:{name:c.client_name||`Client ${c.Id}`, email, password}});
  const user=await userR.json().catch(()=>({}));
  if(!userR.ok||!user?.id||!user?.access_token) return json({error:'Chatwoot user creation failed: '+(user?.message||('HTTP '+userR.status))}, 502);

  const linkR=await chatwootPlatformFetch(env, `/platform/api/v1/accounts/${acct.id}/account_users`, {method:'POST', body:{user_id:user.id, role:'administrator'}});
  if(!linkR.ok) return json({error:'Failed to link the Chatwoot user to the account: HTTP '+linkR.status}, 502);

  await patchClientFields(env, payload.cid, {chatwoot_base:env.CHATWOOT_INSTANCE_BASE, chatwoot_account_id:String(acct.id), chatwoot_token:user.access_token, chatwoot_user_id:String(user.id)});
  return json({ok:true, chatwoot_base:env.CHATWOOT_INSTANCE_BASE, chatwoot_account_id:String(acct.id)});
}

async function handleChannelsWhatsappConnect(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  if(!env.META_APP_ID||!env.META_APP_SECRET) return json({error:'Meta app credentials are not configured on the server.'}, 500);
  const {code, waba_id, phone_number_id}=await request.json().catch(()=>({}));
  if(!code||!waba_id||!phone_number_id) return json({error:'code, waba_id and phone_number_id are required'}, 400);
  const c=await getClientById(env, payload.cid);
  if(!c?.chatwoot_account_id||!c?.chatwoot_token||!c?.chatwoot_base) return json({error:'Connect a Chatwoot account first.'}, 400);
  if(c.chatwoot_inbox_id && c.wa_phone_id) return json({error:'WhatsApp is already connected for this client.'}, 400);

  const collision=await findOtherClientByField(env, 'waba_id', waba_id, payload.cid) || await findOtherClientByField(env, 'wa_phone_id', phone_number_id, payload.cid);
  if(collision) return json({error:'This WhatsApp Business Account / number is already connected to a different client.'}, 409);

  const tokenR=await fetch(`https://graph.facebook.com/v18.0/oauth/access_token?client_id=${env.META_APP_ID}&client_secret=${env.META_APP_SECRET}&code=${encodeURIComponent(code)}`);
  const tokenData=await tokenR.json().catch(()=>({}));
  if(!tokenR.ok||!tokenData.access_token) return json({error:'Meta token exchange failed: '+(tokenData?.error?.message||('HTTP '+tokenR.status))}, 502);
  const wa_token=tokenData.access_token;

  // Best-effort — a failure here shouldn't block the connection; it can be re-subscribed from Meta Business Manager.
  await fetch(`https://graph.facebook.com/v18.0/${waba_id}/subscribed_apps`, {method:'POST', headers:{Authorization:`Bearer ${wa_token}`}}).catch(()=>{});

  const phoneR=await fetch(`https://graph.facebook.com/v18.0/${phone_number_id}?fields=display_phone_number`, {headers:{Authorization:`Bearer ${wa_token}`}});
  const phoneData=await phoneR.json().catch(()=>({}));
  const phone_number=phoneData?.display_phone_number||'';

  const inboxR=await fetch(`${c.chatwoot_base}/api/v1/accounts/${c.chatwoot_account_id}/inboxes`, {
    method:'POST', headers:{api_access_token:c.chatwoot_token, 'Content-Type':'application/json'},
    body:JSON.stringify({
      name:`WhatsApp${phone_number?' - '+phone_number:''}`,
      channel:{type:'whatsapp', phone_number, provider:'whatsapp_cloud', provider_config:{business_account_id:waba_id, phone_number_id, api_key:wa_token}}
    })
  });
  const inbox=await inboxR.json().catch(()=>({}));
  if(!inboxR.ok||!inbox?.id) return json({error:'Chatwoot inbox creation failed: '+(inbox?.message||('HTTP '+inboxR.status))}, 502);

  if(c.webhook_url){
    // Best-effort — wires the bot's n8n webhook onto the new inbox so no manual paste-in-Chatwoot
    // step is needed. If this fails, the client can still add it from Chatwoot's own UI.
    await fetch(`${c.chatwoot_base}/api/v1/accounts/${c.chatwoot_account_id}/webhooks`, {
      method:'POST', headers:{api_access_token:c.chatwoot_token, 'Content-Type':'application/json'},
      body:JSON.stringify({inbox_id:inbox.id, url:c.webhook_url, subscriptions:['message_created']})
    }).catch(()=>{});
  }

  await patchClientFields(env, payload.cid, {chatwoot_inbox_id:String(inbox.id), waba_id, wa_token, wa_phone_id:phone_number_id});
  return json({ok:true, chatwoot_inbox_id:String(inbox.id), waba_id, wa_phone_id:phone_number_id});
}

async function handleChannelsInboxCreate(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const body=await request.json().catch(()=>({}));
  const {type}=body;
  // Matches Chatwoot's own generic inbox API exactly (app/controllers/api/v1/accounts/inboxes_controller.rb
  // allowed_channel_types) minus 'whatsapp', which has its own OAuth-driven route above.
  if(!['web_widget','email','api','sms','telegram','line'].includes(type)) return json({error:'Unsupported channel type.'}, 400);
  const c=await getClientById(env, payload.cid);
  if(!c?.chatwoot_account_id||!c?.chatwoot_token||!c?.chatwoot_base) return json({error:'Connect a Chatwoot account first.'}, 400);

  let channel, name;
  if(type==='web_widget'){
    const {website_url, welcome_title, welcome_tagline}=body;
    if(!website_url) return json({error:'website_url is required'}, 400);
    name=`Website - ${website_url}`;
    channel={type:'web_widget', website_url, welcome_title:welcome_title||'', welcome_tagline:welcome_tagline||''};
  }else if(type==='email'){
    const {email}=body;
    if(!email) return json({error:'email is required'}, 400);
    name=`Email - ${email}`;
    channel={type:'email', email};
  }else if(type==='sms'){
    const {phone_number, account_sid, auth_token}=body;
    if(!phone_number||!account_sid||!auth_token) return json({error:'phone_number, account_sid and auth_token are required'}, 400);
    name=`SMS - ${phone_number}`;
    channel={type:'sms', phone_number, provider:'twilio', provider_config:{account_sid, auth_token}};
  }else if(type==='telegram'){
    const {bot_token}=body;
    if(!bot_token) return json({error:'bot_token is required'}, 400);
    name='Telegram';
    channel={type:'telegram', bot_token};
  }else if(type==='line'){
    const {line_channel_id, line_channel_secret, line_channel_token}=body;
    if(!line_channel_id||!line_channel_secret||!line_channel_token) return json({error:'line_channel_id, line_channel_secret and line_channel_token are required'}, 400);
    name='LINE';
    channel={type:'line', line_channel_id, line_channel_secret, line_channel_token};
  }else{
    name=body.name||'API Channel';
    channel={type:'api', webhook_url:body.webhook_url||''};
  }

  const inboxR=await fetch(`${c.chatwoot_base}/api/v1/accounts/${c.chatwoot_account_id}/inboxes`, {
    method:'POST', headers:{api_access_token:c.chatwoot_token, 'Content-Type':'application/json'},
    body:JSON.stringify({name, channel})
  });
  const inbox=await inboxR.json().catch(()=>({}));
  if(!inboxR.ok||!inbox?.id) return json({error:'Chatwoot inbox creation failed: '+(inbox?.message||('HTTP '+inboxR.status))}, 502);
  return json({ok:true, inbox_id:inbox.id, name:inbox.name||name, chatwoot_settings_url:`${c.chatwoot_base}/app/accounts/${c.chatwoot_account_id}/settings/inboxes/${inbox.id}`});
}

// Live status, read straight from Chatwoot — not just the local CLIENTS columns — so the
// Channels page always reflects what's actually connected and never offers to re-create
// something that already exists there.
async function handleChannelsStatus(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const c=await getClientById(env, payload.cid);
  if(!c) return json({error:'Client not found'}, 404);
  const hasAccount=!!(c.chatwoot_account_id && c.chatwoot_token);
  if(!hasAccount) return json({ok:true, account:null, inboxes:[], has_whatsapp:false});

  const r=await fetch(`${c.chatwoot_base}/api/v1/accounts/${c.chatwoot_account_id}/inboxes`, {headers:{api_access_token:c.chatwoot_token}});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) return json({error:'Failed to load inboxes from Chatwoot: HTTP '+r.status}, 502);
  const inboxes=(data?.payload||data?.data?.payload||[]).map(ib=>({id:ib.id, name:ib.name, channel_type:ib.channel_type}));
  const has_whatsapp=inboxes.some(ib=>ib.channel_type==='Channel::Whatsapp');
  return json({ok:true, account:{chatwoot_base:c.chatwoot_base, chatwoot_account_id:c.chatwoot_account_id}, inboxes, has_whatsapp});
}

// Shopify (and any other Chatwoot-native OAuth integration) is configured at the Chatwoot
// instance level (SHOPIFY_CLIENT_ID/SECRET) and connected per-account via Chatwoot's own
// Settings -> Integrations page — that OAuth hop has to run on Chatwoot's own domain/callback,
// it can't be done from this Worker. This route just gets the client into Chatwoot already
// logged in (via the Platform API's one-time SSO link) so they land on that page with zero
// credential friction, instead of hitting a login wall for a password they were never shown.
async function handleChannelsChatwootSso(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const c=await getClientById(env, payload.cid);
  if(!c?.chatwoot_user_id) return json({error:'Connect a Chatwoot account first.'}, 400);
  const r=await chatwootPlatformFetch(env, `/platform/api/v1/users/${c.chatwoot_user_id}/login`);
  const data=await r.json().catch(()=>({}));
  if(!r.ok||!data?.url) return json({error:'Failed to generate a Chatwoot login link: '+(data?.message||('HTTP '+r.status))}, 502);
  return json({ok:true, url:data.url});
}

/* ── Billing module (Stripe) ──────────────────────────────────────────────
   Plan subscriptions use Stripe Checkout (mode=subscription) + the Stripe
   Customer Portal for everything after signup (upgrade/downgrade/cancel/
   invoices/renewal date) — that's the supported integration path for RBI's
   e-mandate rules on India-issued cards (raw PaymentIntents/SetupIntents
   don't get e-mandate support). Add-ons (WhatsApp credit packs, voice) are
   one-time Checkout payments (mode=payment) instead of recurring items —
   that sidesteps the recurring-mandate rules entirely for these purchases.
   Fulfillment (credits granted, voice enabled) is driven by metadata set on
   the Stripe Price/Product in the Dashboard, not hardcoded here. ── */
async function ensureStripeCustomer(env, c, clientId){
  if(c.stripe_customer_id) return c.stripe_customer_id;
  const {ok, data}=await stripeFetch(env, 'POST', 'customers', {
    email:c.authentik_email||undefined,
    name:c.client_name||undefined,
    address:c.company_address?{line1:c.company_address}:undefined,
    metadata:{client_id:String(clientId)}
  });
  if(!ok||!data?.id) throw new Error('Failed to create Stripe customer: '+(data?.error?.message||'unknown error'));
  await patchClientFields(env, clientId, {stripe_customer_id:data.id});
  return data.id;
}

async function handleBillingCompanyProfile(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const {client_name, company_address}=await request.json().catch(()=>({}));
  if(!client_name) return json({error:'Company name is required.'}, 400);
  const c=await getClientById(env, payload.cid);
  if(!c) return json({error:'Client not found'}, 404);

  await patchClientFields(env, payload.cid, {client_name, company_address:company_address||''});

  // Best-effort — keeps Stripe's own invoices/receipts showing the right name+address for
  // customers who update this after they already have a Stripe Customer record.
  if(c.stripe_customer_id){
    await stripeFetch(env, 'POST', `customers/${c.stripe_customer_id}`, {
      name:client_name,
      address:company_address?{line1:company_address}:undefined
    }).catch(()=>{});
  }
  return json({ok:true});
}

async function handleBillingCheckoutSubscription(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  if(!env.STRIPE_SECRET_KEY) return json({error:'Stripe is not configured on the server.'}, 500);
  const {price_id}=await request.json().catch(()=>({}));
  const allowed=(env.STRIPE_PLAN_PRICE_IDS||'').split(',').map(s=>s.trim()).filter(Boolean);
  if(!price_id||!allowed.includes(price_id)) return json({error:'Unknown plan.'}, 400);
  const c=await getClientById(env, payload.cid);
  if(!c) return json({error:'Client not found'}, 404);
  if(c.stripe_subscription_id) return json({error:'Already subscribed — manage your plan from the Billing Portal instead.'}, 400);

  const customerId=await ensureStripeCustomer(env, c, payload.cid);
  const {ok, data}=await stripeFetch(env, 'POST', 'checkout/sessions', {
    mode:'subscription',
    customer:customerId,
    line_items:[{price:price_id, quantity:1}],
    success_url:`${env.APP_BASE_URL}?billing=success`,
    cancel_url:`${env.APP_BASE_URL}?billing=cancel`,
    metadata:{client_id:String(payload.cid)},
    subscription_data:{metadata:{client_id:String(payload.cid)}}
  });
  if(!ok||!data?.url) return json({error:'Failed to start checkout: '+(data?.error?.message||'unknown error')}, 502);
  return json({ok:true, url:data.url});
}

async function handleBillingPortal(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  if(!env.STRIPE_SECRET_KEY) return json({error:'Stripe is not configured on the server.'}, 500);
  const c=await getClientById(env, payload.cid);
  if(!c?.stripe_customer_id) return json({error:'No billing account yet — subscribe to a plan first.'}, 400);
  const {ok, data}=await stripeFetch(env, 'POST', 'billing_portal/sessions', {customer:c.stripe_customer_id, return_url:env.APP_BASE_URL});
  if(!ok||!data?.url) return json({error:'Failed to open billing portal: '+(data?.error?.message||'unknown error')}, 502);
  return json({ok:true, url:data.url});
}

// Pull-based sync, independent of the webhook entirely — the authenticated session already tells
// us which CLIENTS row this is, so unlike the webhook path there's no client_reference_id/email
// correlation to get wrong. Two uses: (1) auto-called right after returning from Checkout with a
// session_id, (2) a manual "Sync Subscription Now" button for whenever the webhook didn't land.
async function handleBillingConfirmSession(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  if(!env.STRIPE_SECRET_KEY) return json({error:'Stripe is not configured on the server.'}, 500);
  const sessionId=new URL(request.url).searchParams.get('session_id');
  if(!sessionId) return json({error:'session_id required'}, 400);

  const {ok, data:session}=await stripeFetch(env, 'GET', `checkout/sessions/${sessionId}`);
  if(!ok||!session?.id) return json({error:'Could not verify that checkout session with Stripe.'}, 502);

  if(session.customer) await patchClientFields(env, payload.cid, {stripe_customer_id:session.customer});
  if(session.subscription){
    const {ok:subOk, data:sub}=await stripeFetch(env, 'GET', `subscriptions/${session.subscription}`);
    if(subOk) await syncSubscriptionFields(env, payload.cid, sub);
  }
  return json({ok:true});
}

async function handleBillingSyncNow(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  if(!env.STRIPE_SECRET_KEY) return json({error:'Stripe is not configured on the server.'}, 500);
  const c=await getClientById(env, payload.cid);
  if(!c) return json({error:'Client not found'}, 404);

  let customerId=c.stripe_customer_id;
  if(!customerId){
    const emails=[c.authentik_email, ...(c.team_emails||'').split(',')].map(e=>e.trim()).filter(Boolean);
    for(const email of emails){
      const {ok, data}=await stripeFetch(env, 'GET', 'customers', {email, limit:5});
      if(ok && data?.data?.length){ customerId=data.data[0].id; break; }
    }
    if(!customerId) return json({error:'No Stripe customer found yet for this account\'s email(s). Make sure the checkout used one of them.'}, 404);
    await patchClientFields(env, payload.cid, {stripe_customer_id:customerId});
  }

  const {ok, data}=await stripeFetch(env, 'GET', 'subscriptions', {customer:customerId, status:'all', limit:1});
  if(!ok||!data?.data?.length) return json({error:'No subscription found yet for this Stripe customer.'}, 404);
  await syncSubscriptionFields(env, payload.cid, data.data[0]);
  return json({ok:true, plan_status:data.data[0].status});
}

async function handleBillingCheckoutAddon(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  if(!env.STRIPE_SECRET_KEY) return json({error:'Stripe is not configured on the server.'}, 500);
  const {price_id}=await request.json().catch(()=>({}));
  const allowed=(env.STRIPE_ADDON_PRICE_IDS||'').split(',').map(s=>s.trim()).filter(Boolean);
  if(!price_id||!allowed.includes(price_id)) return json({error:'Unknown add-on.'}, 400);
  const c=await getClientById(env, payload.cid);
  if(!c) return json({error:'Client not found'}, 404);

  const customerId=await ensureStripeCustomer(env, c, payload.cid);
  const {ok, data}=await stripeFetch(env, 'POST', 'checkout/sessions', {
    mode:'payment',
    customer:customerId,
    line_items:[{price:price_id, quantity:1}],
    success_url:`${env.APP_BASE_URL}?billing=success`,
    cancel_url:`${env.APP_BASE_URL}?billing=cancel`,
    metadata:{client_id:String(payload.cid), price_id}
  });
  if(!ok||!data?.url) return json({error:'Failed to start checkout: '+(data?.error?.message||'unknown error')}, 502);
  return json({ok:true, url:data.url});
}

async function fulfillAddon(env, clientId, priceId){
  const {ok, data}=await stripeFetch(env, 'GET', `prices/${priceId}`, {expand:['product']});
  if(!ok) return;
  // Price metadata wins over Product metadata, so a one-off Price can override the Product default.
  const meta={...(data?.product?.metadata||{}), ...(data?.metadata||{})};
  const c=await getClientById(env, clientId);
  if(!c) return;
  if(meta.fulfillment_type==='wa_credits'){
    const amount=Number(meta.wa_credits_amount||0);
    await patchClientFields(env, clientId, {wa_credits_balance:(Number(c.wa_credits_balance)||0)+amount});
  }else if(meta.fulfillment_type==='voice_addon'){
    await patchClientFields(env, clientId, {voice_addon_active:'Yes'});
  }
}

// Shared by both the checkout.session.completed direct-fetch path and the customer.subscription.*
// event path, so a Subscription object is synced onto CLIENTS the same way regardless of how we
// learned about it.
async function syncSubscriptionFields(env, clientId, sub){
  const item=sub.items?.data?.[0];
  const price=item?.price;
  // API versions 2025-03-31+ moved current_period_end off the Subscription object and onto
  // each SubscriptionItem — sub.current_period_end kept as a fallback for older-pinned accounts.
  const periodEnd=item?.current_period_end||sub.current_period_end;
  await patchClientFields(env, clientId, {
    stripe_subscription_id:sub.id,
    plan_status:sub.status,
    plan_renews_at:periodEnd?new Date(periodEnd*1000).toISOString():'',
    plan_name:price?.nickname||price?.id||'',
    plan_message_limit:Number(price?.metadata?.message_limit||0)||undefined,
    // Set when the customer cancels from the Portal but keeps access until the period ends —
    // the Billing page uses this to show "won't renew" instead of a normal renewal date.
    plan_cancel_at_period_end:sub.cancel_at_period_end?'Yes':'No'
  });
}

// Resolves which CLIENTS row a subscription event belongs to. Subscriptions created through our
// own /billing/checkout-subscription route carry metadata.client_id (set at creation); ones
// created through a Stripe Pricing Table embed don't — those only get client_reference_id on the
// Checkout Session, not on the Subscription itself — so we fall back to matching the CLIENTS row
// that already has this subscription id (written by the checkout.session.completed handler below).
async function resolveClientIdForSubscription(env, sub){
  if(sub.metadata?.client_id) return sub.metadata.client_id;
  const c=await findClientByField(env, 'stripe_subscription_id', sub.id);
  return c?.Id||null;
}

async function handleBillingWebhook(request, env){
  if(!env.STRIPE_WEBHOOK_SECRET) return json({error:'Webhook not configured'}, 500);
  const rawBody=await request.text();
  const valid=await verifyStripeSignature(env, rawBody, request.headers.get('Stripe-Signature'));
  if(!valid) return json({error:'Invalid signature'}, 400);
  const event=JSON.parse(rawBody);
  const obj=event.data?.object||{};

  if(event.type==='checkout.session.completed' && obj.mode==='payment'){
    const clientId=obj.metadata?.client_id, priceId=obj.metadata?.price_id;
    if(clientId && priceId) await fulfillAddon(env, clientId, priceId);
  }
  if(event.type==='checkout.session.completed' && obj.mode==='subscription'){
    // Pricing Table checkouts (and our own custom checkout) both set client_reference_id here —
    // this is the authoritative first link between a brand-new Stripe Customer/Subscription and
    // a CLIENTS row. Fetching the subscription directly (rather than waiting on a separate
    // customer.subscription.created event) avoids a race where that event arrives first and
    // can't yet resolve which client it belongs to.
    let clientId=obj.client_reference_id;
    if(!clientId){
      // Fallback if client_reference_id didn't come through (e.g. the table was opened via a
      // direct Stripe preview link rather than through dashboard.html) — match by whatever email
      // was actually used at checkout against this account's known emails (owner + teammates).
      const checkoutEmail=(obj.customer_details?.email||obj.customer_email||'').trim();
      if(checkoutEmail){
        const c=await getClientByAuthentikEmail(env, checkoutEmail);
        clientId=c?.Id||null;
      }
    }
    if(clientId && obj.customer){
      await patchClientFields(env, clientId, {stripe_customer_id:obj.customer});
      if(obj.subscription){
        const {ok, data}=await stripeFetch(env, 'GET', `subscriptions/${obj.subscription}`);
        if(ok) await syncSubscriptionFields(env, clientId, data);
      }
    }
  }
  if(event.type==='customer.subscription.created' || event.type==='customer.subscription.updated'){
    const clientId=await resolveClientIdForSubscription(env, obj);
    if(clientId) await syncSubscriptionFields(env, clientId, obj);
  }
  if(event.type==='customer.subscription.deleted'){
    const clientId=await resolveClientIdForSubscription(env, obj);
    if(clientId) await patchClientFields(env, clientId, {plan_status:'canceled'});
  }
  return json({received:true});
}

export default {
  async fetch(request, env){
    const url=new URL(request.url);
    const origin=request.headers.get('Origin');
    const cors=corsHeaders(origin, env);

    if(request.method==='OPTIONS') return new Response(null, {status:204, headers:cors});

    let res;
    try{
      if(url.pathname==='/health'){ res=json({ok:true}); }
      else if(url.pathname==='/session/exchange' && request.method==='POST'){ res=await handleSessionExchange(request, env); }
      else if(url.pathname==='/session/me' && request.method==='GET'){ res=await handleSessionMe(request, env); }
      else if(url.pathname.startsWith('/nocodb/')){ res=await handleNocodbPassthrough(request, env, url.pathname.slice('/nocodb/'.length)); }
      else if(url.pathname==='/chat/send' && request.method==='POST'){ res=await handleChatSend(request, env); }
      else if(url.pathname==='/quote/send' && request.method==='POST'){ res=await handleQuoteSend(request, env); }
      else if(url.pathname==='/wa/templates' && request.method==='GET'){ res=await handleWaTemplatesGet(request, env); }
      else if(url.pathname==='/wa/templates' && request.method==='POST'){ res=await handleWaTemplatesCreate(request, env); }
      else if(url.pathname==='/wa/send' && request.method==='POST'){ res=await handleWaSend(request, env); }
      else if(url.pathname==='/ai/complete' && request.method==='POST'){ res=await handleAiComplete(request, env); }
      else if(url.pathname==='/channels/create-account' && request.method==='POST'){ res=await handleChannelsCreateAccount(request, env); }
      else if(url.pathname==='/channels/whatsapp/connect' && request.method==='POST'){ res=await handleChannelsWhatsappConnect(request, env); }
      else if(url.pathname==='/channels/inbox' && request.method==='POST'){ res=await handleChannelsInboxCreate(request, env); }
      else if(url.pathname==='/channels/status' && request.method==='GET'){ res=await handleChannelsStatus(request, env); }
      else if(url.pathname==='/channels/chatwoot-sso' && request.method==='GET'){ res=await handleChannelsChatwootSso(request, env); }
      else if(url.pathname==='/billing/checkout-subscription' && request.method==='POST'){ res=await handleBillingCheckoutSubscription(request, env); }
      else if(url.pathname==='/billing/portal' && request.method==='GET'){ res=await handleBillingPortal(request, env); }
      else if(url.pathname==='/billing/confirm-session' && request.method==='GET'){ res=await handleBillingConfirmSession(request, env); }
      else if(url.pathname==='/billing/sync-now' && request.method==='GET'){ res=await handleBillingSyncNow(request, env); }
      else if(url.pathname==='/billing/checkout-addon' && request.method==='POST'){ res=await handleBillingCheckoutAddon(request, env); }
      else if(url.pathname==='/billing/webhook' && request.method==='POST'){ res=await handleBillingWebhook(request, env); }
      else if(url.pathname==='/billing/company-profile' && request.method==='POST'){ res=await handleBillingCompanyProfile(request, env); }
      else{ res=json({error:'Not found'}, 404); }
    }catch(e){
      res=json({error:e.message||'Internal error'}, 500);
    }

    const headers=new Headers(res.headers);
    Object.entries(cors).forEach(([k,v])=>headers.set(k,v));
    return new Response(res.body, {status:res.status, headers});
  }
};
