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
  return data?.list?.[0]||null;
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
      else{ res=json({error:'Not found'}, 404); }
    }catch(e){
      res=json({error:e.message||'Internal error'}, 500);
    }

    const headers=new Headers(res.headers);
    Object.entries(cors).forEach(([k,v])=>headers.set(k,v));
    return new Response(res.body, {status:res.status, headers});
  }
};
