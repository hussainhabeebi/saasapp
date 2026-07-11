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
// Known limitation: index.html and broadcast.html still embed the master
// NocoDB token directly and are NOT covered by this Worker yet — same
// exposure as before, just not yet migrated. dashboard.html and ecom.html
// (via the /ecom/* routes) are fully migrated.

const SESSION_TTL_SECONDS = 24 * 3600;
const CLIENTS_TABLE = 'mxl33bg4wi70fqj';
const DEFAULT_LEADS_TABLE = 'mvg6rcw0ia5qqrx';
// Create these two tables once in NocoDB (shared across all clients, rows scoped by a
// client_id column — see SETUP.md "Email Marketing module") and paste their real ids here.
const EMAIL_CAMPAIGNS_TABLE = 'md3ghcfigac4yqs';
const EMAIL_SENDS_TABLE = 'mr5fvzaq97s6etq';

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
// client_slug is the short, human-readable handle used in onshope.com URLs (onshope.com/<slug>)
// instead of the raw numeric client_id, so a storefront link doesn't reveal or let visitors
// enumerate other clients' ids.
async function getClientBySlug(env, slug){
  const r=await ncFetch(env, `api/v2/tables/${CLIENTS_TABLE}/records?where=(client_slug,eq,${encodeURIComponent(slug)})&limit=1`);
  if(!r.ok) return null;
  const data=await r.json().catch(()=>({}));
  return data?.list?.[0]||null;
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

// Strips fields that must never reach the browser — dashboard_password obviously, but
// resend_api_key, smtp_pass and shopify_access_token are live send-capable credentials too, and
// the rest of this object (clientRecord) sits in a page-lifetime JS variable in
// dashboard.html/broadcast.html, inspectable via devtools for as long as the tab is open.
function safeClient(rec){
  const {dashboard_password, resend_api_key, smtp_pass, shopify_access_token, meta_capi_token, ...safe}=rec;
  return {...safe, meta_capi_connected:!!meta_capi_token};
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

/* ── Admin session: same HMAC scheme as the per-client session token above, reusing
   SESSION_SIGNING_KEY, but with a distinct payload shape ({role:'admin'}, no cid) so the two
   token types can never be confused for each other. Replaces admin.html's old design of
   comparing a typed passcode against a hardcoded JS constant and then using a master NocoDB
   token straight from the browser — both are gone; the passcode check and every credential now
   live only in the Worker. ── */
async function hmacSignB64(env, body){
  const key=await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SIGNING_KEY), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const sig=await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
async function signAdminSession(env){
  const payload={role:'admin', exp:Math.floor(Date.now()/1000)+SESSION_TTL_SECONDS};
  const body=btoa(JSON.stringify(payload));
  return `${body}.${await hmacSignB64(env, body)}`;
}
async function requireAdminSession(request, env){
  const auth=request.headers.get('Authorization')||'';
  const token=auth.startsWith('Bearer ')?auth.slice(7):'';
  const [body, sig]=token.split('.');
  if(!body||!sig) return false;
  if(await hmacSignB64(env, body)!==sig) return false;
  let payload;
  try{ payload=JSON.parse(atob(body)); }catch(e){ return false; }
  return payload.role==='admin' && !!payload.exp && payload.exp>=Math.floor(Date.now()/1000);
}
async function handleAdminLogin(request, env){
  if(!env.ADMIN_PASSCODE) return json({error:'Admin login is not configured on the server.'}, 500);
  const {passcode}=await request.json().catch(()=>({}));
  if(!passcode||passcode!==env.ADMIN_PASSCODE) return json({error:'Wrong passcode.'}, 401);
  return json({session_token:await signAdminSession(env)});
}
async function handleAdminNocodbPassthrough(request, env, upstreamPath){
  if(!await requireAdminSession(request, env)) return json({error:'Invalid or expired admin session'}, 401);
  const url=new URL(request.url);
  const qs=url.search.slice(1);
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
async function handleAdminClientsBilling(request, env){
  if(!await requireAdminSession(request, env)) return json({error:'Invalid or expired admin session'}, 401);
  const r=await ncFetch(env, `api/v2/tables/${CLIENTS_TABLE}/records?limit=200`);
  if(!r.ok) return json({error:'Failed to load clients: HTTP '+r.status}, 502);
  const data=await r.json().catch(()=>({}));
  const clients=(data?.list||[]).map(c=>({
    Id:c.Id,
    client_name:c.client_name||'',
    authentik_email:c.authentik_email||'',
    stripe_customer_id:c.stripe_customer_id||'',
    stripe_subscription_id:c.stripe_subscription_id||'',
    plan_name:c.plan_name||'',
    plan_status:c.plan_status||'',
    plan_renews_at:c.plan_renews_at||'',
    plan_cancel_at_period_end:c.plan_cancel_at_period_end||'',
    wa_credits_balance:c.wa_credits_balance||0,
    voice_addon_active:c.voice_addon_active||'No'
  }));
  return json({ok:true, clients});
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
  // Individual verified email of whoever just logged in — distinct from the account's own
  // authentik_email when a teammate (added via team_emails) signs in to a shared client account.
  // The frontend keeps this for "assigned to me" task filtering, since the session token itself
  // only ever carries the shared account's cid, not which specific person is behind it.
  return json({session_token, client_id:String(rec.Id), client:safeClient(rec), email});
}

async function handleSessionMe(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const rec=await getClientById(env, payload.cid);
  if(!rec||!rec.Id) return json({error:'Client not found'}, 404);
  return json({client_id:String(rec.Id), client:safeClient(rec)});
}

/* ── Team user creation (User Management) — provisions a real Authentik account (username +
   password) for a teammate directly, instead of requiring them to self-serve through Authentik's
   own hosted signup page first. Uses a service-account API token (AUTHENTIK_API_TOKEN, a Worker
   secret — needs the authentik_core.add_user and authentik_core.reset_user_password permissions,
   or a superuser token) against Authentik's Core API; the password is set directly on the
   Authentik user and never stored anywhere in NocoDB/this Worker. On success the new email is
   added to the client's team_emails the same way the existing "add by email" flow does. ── */
async function authentikApiFetch(env, path, opts={}){
  return fetch(`${env.AUTHENTIK_BASE}/api/v3${path}`, {
    ...opts,
    headers:{Authorization:`Bearer ${env.AUTHENTIK_API_TOKEN}`, 'Content-Type':'application/json', ...(opts.headers||{})}
  });
}
// Best-effort companion to Authentik user creation below — creates a Chatwoot Platform user with
// the same name/email/password, links them to the client's existing Chatwoot account as an
// 'agent' (not 'administrator' — matches a teammate's actual role, distinct from the account
// owner's own Chatwoot user created by handleChannelsCreateAccount), and generates a one-time SSO
// login link via the same Platform API `/users/{id}/login` endpoint handleChannelsChatwootSso
// uses. Failure here never fails the overall user-creation request — Chatwoot may not be
// connected for this client yet, or the email may already exist as a Chatwoot Platform user.
async function createChatwootAgent(env, c, {name, email, password}){
  try{
    const userR=await chatwootPlatformFetch(env, '/platform/api/v1/users', {method:'POST', body:{name, email, password}});
    const user=await userR.json().catch(()=>({}));
    if(!userR.ok||!user?.id) return {ok:false, error:user?.message||('HTTP '+userR.status)};

    const linkR=await chatwootPlatformFetch(env, `/platform/api/v1/accounts/${c.chatwoot_account_id}/account_users`, {method:'POST', body:{user_id:user.id, role:'agent'}});
    if(!linkR.ok) return {ok:false, error:'Failed to link Chatwoot agent to account: HTTP '+linkR.status};

    const ssoR=await chatwootPlatformFetch(env, `/platform/api/v1/users/${user.id}/login`);
    const sso=await ssoR.json().catch(()=>({}));
    const inbox_url=c.chatwoot_inbox_id
      ? `${c.chatwoot_base}/app/accounts/${c.chatwoot_account_id}/inbox/${c.chatwoot_inbox_id}`
      : `${c.chatwoot_base}/app/accounts/${c.chatwoot_account_id}/dashboard`;
    return {ok:true, user_id:user.id, sso_url:ssoR.ok?(sso?.url||null):null, inbox_url};
  }catch(e){
    return {ok:false, error:e.message||'Chatwoot agent creation failed'};
  }
}
async function handleTeamCreateUser(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  if(!env.AUTHENTIK_API_TOKEN) return json({error:'Authentik admin API is not configured on the server.'}, 500);
  const {name, username, email, password}=await request.json().catch(()=>({}));
  if(!username||!email||!password) return json({error:'username, email and password are required'}, 400);
  if(String(password).length<8) return json({error:'Password must be at least 8 characters.'}, 400);
  const emailNorm=String(email).trim().toLowerCase();
  const existing=await getClientByAuthentikEmail(env, emailNorm);
  if(existing) return json({error:'This email is already linked to an account.'}, 409);
  const c=await getClientById(env, payload.cid);
  if(!c) return json({error:'Client not found'}, 404);

  const createR=await authentikApiFetch(env, '/core/users/', {
    method:'POST',
    body:JSON.stringify({username:String(username).trim(), email:emailNorm, name:String(name||username).trim(), is_active:true})
  });
  const createData=await createR.json().catch(()=>({}));
  if(!createR.ok){
    const detail=createData?.username?.[0]||createData?.email?.[0]||createData?.detail||('HTTP '+createR.status);
    return json({error:'Authentik rejected the new user: '+detail}, 502);
  }

  const userId=createData.pk;
  const pwR=await authentikApiFetch(env, `/core/users/${userId}/set_password/`, {method:'POST', body:JSON.stringify({password})});
  if(!pwR.ok){
    // Don't leave a passwordless, unreachable account behind — best-effort cleanup.
    await authentikApiFetch(env, `/core/users/${userId}/`, {method:'DELETE'}).catch(()=>{});
    const pwData=await pwR.json().catch(()=>({}));
    return json({error:'Failed to set password: '+(pwData?.password?.[0]||pwData?.detail||'HTTP '+pwR.status)}, 502);
  }

  let chatwoot=null;
  if(c.chatwoot_account_id && env.CHATWOOT_PLATFORM_TOKEN){
    chatwoot=await createChatwootAgent(env, c, {name:String(name||username).trim(), email:emailNorm, password});
    if(chatwoot.ok && chatwoot.user_id){
      // Persists which Chatwoot user belongs to this email so handleChannelsChatwootSso can mint
      // this specific teammate their own SSO link later, not just at creation time.
      let teamUsers={}; try{ teamUsers=JSON.parse(c.team_chatwoot_users||'{}'); }catch(e){}
      teamUsers[emailNorm]=chatwoot.user_id;
      await patchClientFields(env, payload.cid, {team_chatwoot_users:JSON.stringify(teamUsers)}).catch(()=>{});
    }
  }
  return json({ok:true, email:emailNorm, chatwoot});
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
  const r=await fetch(`https://graph.facebook.com/v18.0/${c.waba_id}/message_templates?fields=name,status,language,category,components&limit=200`, {headers:{Authorization:`Bearer ${c.wa_token}`}});
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

// Template sends go straight to Meta's Graph API, bypassing Chatwoot entirely — needed for
// leads outside the 24h session window, where only an approved template is allowed, and
// avoids depending on Chatwoot's own whatsapp_templates sync (which some inboxes 404 on).
async function handleWaSendTemplate(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const {phone, template_name, language, components}=await request.json().catch(()=>({}));
  if(!phone||!template_name) return json({error:'phone and template_name required'}, 400);
  const c=await getClientById(env, payload.cid);
  if(!c?.wa_phone_id||!c?.wa_token) return json({error:'WhatsApp Business API is not connected for this account — connect it from Settings → Channels.'}, 400);
  const r=await fetch(`https://graph.facebook.com/v18.0/${c.wa_phone_id}/messages`, {
    method:'POST', headers:{Authorization:`Bearer ${c.wa_token}`, 'Content-Type':'application/json'},
    body:JSON.stringify({messaging_product:'whatsapp', to:phone, type:'template', template:{name:template_name, language:{code:language||'en'}, components:components||[]}})
  });
  const data=await r.json().catch(()=>({}));
  if(!r.ok) return json({error:data?.error?.message||'HTTP '+r.status}, 502);
  return json({ok:true, message_id:data?.messages?.[0]?.id});
}

// Task assignment / follow-up nudge emails, via Resend (simple fetch-based REST API, no SDK).
// Best-effort by design — a client that hasn't set RESEND_API_KEY yet should still be able to
// create and manage tasks; it just won't get the email side until that's configured.
async function handleTaskEmailNotify(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const {to, subject, title, notes, due_date, due_time, lead_name}=await request.json().catch(()=>({}));
  if(!to||!subject||!title) return json({error:'to, subject and title required'}, 400);
  if(!env.RESEND_API_KEY) return json({error:'Email notifications aren\'t configured on the server yet (RESEND_API_KEY missing).'}, 400);
  const from=env.RESEND_FROM_EMAIL||'Leadvyne Tasks <tasks@leadvyne.com>';
  const lines=[
    `<p><strong>${esc(title)}</strong></p>`,
    notes?`<p>${esc(notes)}</p>`:'',
    due_date?`<p>Due: ${esc(due_date)}${due_time?' '+esc(due_time):''}</p>`:'',
    lead_name?`<p>Related to: ${esc(lead_name)}</p>`:''
  ].filter(Boolean).join('');
  const r=await fetch('https://api.resend.com/emails', {
    method:'POST', headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`, 'Content-Type':'application/json'},
    body:JSON.stringify({from, to:[to], subject, html:lines})
  });
  const data=await r.json().catch(()=>({}));
  if(!r.ok) return json({error:data?.message||'Resend API HTTP '+r.status}, 502);
  return json({ok:true});
}
function esc(s){ return String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// ── EMAIL INTEGRATION (Bulk Marketing module — per-client Resend account) ──
// Distinct from env.RESEND_API_KEY above, which is a platform-level key used only for internal
// task-notification emails. This is the client's own Resend account/API key, used so marketing
// email goes out under their own verified sending domain and their own Resend billing/quota.
// Stored on the client row like wa_token/chatwoot_token; no route here ever returns the key
// itself back to the browser — only connection status derived from calling Resend with it.
const EMAIL_CLIENT_WRITE_FIELDS=['resend_api_key','resend_from_email','resend_from_name'];

async function handleEmailClientUpdate(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const body=await request.json().catch(()=>({}));
  const fields={};
  EMAIL_CLIENT_WRITE_FIELDS.forEach(k=>{ if(k in body) fields[k]=body[k]; });
  if(!Object.keys(fields).length) return json({error:'Nothing to save'}, 400);
  await patchClientFields(env, payload.cid, fields);
  return json({ok:true});
}

async function handleEmailStatus(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const c=await getClientById(env, payload.cid);
  const from_email=c?.resend_from_email||'', from_name=c?.resend_from_name||'';
  if(!c?.resend_api_key) return json({connected:false, from_email, from_name});
  const r=await fetch('https://api.resend.com/domains', {headers:{Authorization:`Bearer ${c.resend_api_key}`}});
  if(!r.ok) return json({connected:false, from_email, from_name, error:r.status===401?'API key is invalid or revoked.':'Resend API HTTP '+r.status});
  const data=await r.json().catch(()=>({}));
  const domains=(data?.data||[]).map(d=>({name:d.name, status:d.status}));
  return json({connected:true, from_email, from_name, domains});
}

// ── META ADS CONVERSIONS API (CAPI) — lead-quality reporting ──────────────────────────────
// Feeds CRM lead-quality signals back to Meta (Lead → QualifiedLead/DisqualifiedLead → Schedule)
// so ad delivery optimizes for real quality, not just WhatsApp message volume. Per-client
// meta_pixel_id/meta_capi_token (Events Manager → Conversions API → a generated access token),
// stored on the client row like resend_api_key — meta_capi_token never reaches the browser
// (stripped by safeClient) and is only ever written via /meta/capi/config below, never through
// the generic /nocodb/ passthrough the dashboard uses for its own row.
// Matching relies on the lead's phone/email (hashed, never sent in the clear) — there's no
// ctwa_clid (Click-to-WhatsApp ad click id) capture yet since WhatsApp inbound messages are
// handled by the n8n engine, outside this repo; if that's ever wired through, add it to
// user_data.ctwa_clid below (unhashed) for much stronger attribution. See SETUP.md.
const META_CAPI_WRITE_FIELDS=['meta_pixel_id','meta_capi_token'];
const META_CAPI_EVENTS={
  lead:         {name:'Lead'},         // fired once, when a lead is first captured
  qualified:    {name:'QualifiedLead'},// custom event — lead scored Hot / marked good
  disqualified: {name:'DisqualifiedLead'}, // custom event — negative signal matters too
  booked:       {name:'Schedule'},     // standard event — reached a terminal/booked pipeline stage
};
async function sha256Hex(str){
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)));
}
async function capiHashEmail(email){
  const v=String(email||'').trim().toLowerCase();
  return v?await sha256Hex(v):undefined;
}
async function capiHashPhone(phone){
  const digits=String(phone||'').replace(/[^0-9]/g,'');
  return digits?await sha256Hex(digits):undefined;
}
async function sendMetaCapiEvent(env, c, eventKey, lead, extra={}){
  const def=META_CAPI_EVENTS[eventKey];
  if(!def) return {ok:false, error:'Unknown event type'};
  if(!c?.meta_pixel_id||!c?.meta_capi_token) return {ok:false, skipped:true};
  const user_data={};
  const em=await capiHashEmail(lead.Email); if(em) user_data.em=[em];
  const ph=await capiHashPhone(lead.Phone); if(ph) user_data.ph=[ph];
  if(!em && !ph) return {ok:false, error:'Lead has no email or phone to match on'};
  const event={
    event_name:def.name,
    event_time:Math.floor(Date.now()/1000),
    // Stable per lead+stage — dedupes retries and lines up with a future client-side Pixel event_id.
    event_id:`lead_${lead.Id}_${eventKey}`,
    action_source:'business_messaging',
    messaging_channel:'whatsapp',
    user_data,
  };
  if(extra.value) event.custom_data={value:Number(extra.value), currency:extra.currency||'INR'};
  const r=await fetch(`https://graph.facebook.com/v18.0/${c.meta_pixel_id}/events?access_token=${encodeURIComponent(c.meta_capi_token)}`, {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({data:[event]})
  });
  const data=await r.json().catch(()=>({}));
  return {ok:r.ok, status:r.status, data};
}
async function handleMetaCapiLeadEvent(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const {lead_id, event, value, currency}=await request.json().catch(()=>({}));
  if(!lead_id||!event) return json({error:'lead_id and event required'}, 400);
  if(!META_CAPI_EVENTS[event]) return json({error:'Unknown event type'}, 400);
  const c=await getClientById(env, payload.cid);
  if(!c) return json({error:'Client not found'}, 404);
  if(!c.meta_pixel_id||!c.meta_capi_token) return json({ok:true, skipped:true});
  const leadR=await ncFetch(env, `api/v2/tables/${DEFAULT_LEADS_TABLE}/records/${lead_id}`);
  const lead=await leadR.json().catch(()=>null);
  if(!leadR.ok||!lead) return json({error:'Lead not found'}, 404);
  if(String(lead.ClientId)!==String(payload.cid)) return json({error:'Not your lead'}, 403);
  const result=await sendMetaCapiEvent(env, c, event, lead, {value, currency});
  if(!result.ok && !result.skipped) return json({error:result.data?.error?.message||result.error||'Meta rejected the event'}, 502);
  return json({ok:true, sent:result.ok===true});
}
async function handleMetaCapiConfigSet(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const body=await request.json().catch(()=>({}));
  const fields={};
  META_CAPI_WRITE_FIELDS.forEach(k=>{ if(k in body) fields[k]=String(body[k]||'').trim(); });
  if(!Object.keys(fields).length) return json({error:'Nothing to save'}, 400);
  await patchClientFields(env, payload.cid, fields);
  return json({ok:true});
}
async function handleMetaCapiStatus(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const c=await getClientById(env, payload.cid);
  return json({connected:!!(c?.meta_pixel_id&&c?.meta_capi_token), pixel_id:c?.meta_pixel_id||''});
}

// Shared by handleEmailTest and the campaign send-one route below — the only difference between
// a test send and a campaign send is the subject/html, so this is the one place that talks to
// Resend on a client's own account.
async function sendClientResendEmail(c, {to, subject, html}){
  if(!c?.resend_api_key) return {ok:false, error:'Connect Resend first.'};
  if(!c?.resend_from_email) return {ok:false, error:'Set a from-email first.'};
  const from=`${c.resend_from_name||c.client_name||'Bulk Marketing'} <${c.resend_from_email}>`;
  const r=await fetch('https://api.resend.com/emails', {
    method:'POST', headers:{Authorization:`Bearer ${c.resend_api_key}`, 'Content-Type':'application/json'},
    body:JSON.stringify({from, to:[to], subject, html})
  });
  const data=await r.json().catch(()=>({}));
  if(!r.ok) return {ok:false, error:data?.message||'Resend API HTTP '+r.status};
  return {ok:true};
}

async function handleEmailTest(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const {to}=await request.json().catch(()=>({}));
  if(!to) return json({error:'to required'}, 400);
  const c=await getClientById(env, payload.cid);
  const result=await sendClientResendEmail(c, {to, subject:'Test email from your Bulk Marketing integration', html:'<p>This is a test email — if you got this, your Resend integration is working.</p>'});
  if(!result.ok) return json({error:result.error}, result.error==='Connect Resend first.'||result.error==='Set a from-email first.'?400:502);
  return json({ok:true});
}

/* ── EMAIL MARKETING MODULE (Phase 1 — Resend only, see SETUP.md) ──
   Campaigns/Sends are shared platform-wide tables (like the ecom module's products/orders),
   rows scoped by client_id, with an email_table_ids override field for a client who wants a
   bespoke table — same two-tier pattern as ecomResolveTable/ecom_table_ids. Every route below
   derives the client from the session (payload.cid), never a client-supplied id — the stronger
   of the two auth patterns already in this codebase (the weaker one, trusting a client-supplied
   client_id, is what the older ecom.html routes do and is documented there as a known gap). ── */
async function emailResolveTable(env, clientId, kind){
  const c=await getClientById(env, clientId);
  if(!c) return null;
  let ids={}; try{ ids=JSON.parse(c.email_table_ids||'{}'); }catch(e){}
  const DEFAULTS={campaigns:EMAIL_CAMPAIGNS_TABLE, sends:EMAIL_SENDS_TABLE};
  return ids[kind]||DEFAULTS[kind]||null;
}

// Sanitizes the same way ecomSanitizeFilterValue does — segment_filter values are shop-owner/
// staff-authored (not end-customer input), but still shouldn't be able to break out of their
// own where() clause.
function emailSanitizeFilterValue(v){ return String(v).replace(/[(),~]/g,'').trim(); }

// Builds the NocoDB where clause a campaign's audience resolves to. Every campaign send is
// implicitly scoped to leads that (a) have an email address at all and (b) haven't opted out of
// email specifically — segment_filter only narrows further from there.
function emailAudienceWhereClause(clientId, segmentFilter){
  const clauses=[`(ClientId,eq,${clientId})`, `(Email,notblank)`, `(EmailOptOut,neq,Yes)`];
  const f=segmentFilter||{};
  if(Array.isArray(f.stage)&&f.stage.length){
    clauses.push('('+f.stage.map(s=>`(Stage,eq,${emailSanitizeFilterValue(s)})`).join('~or')+')');
  }
  if(Array.isArray(f.tags_any)&&f.tags_any.length){
    clauses.push('('+f.tags_any.map(t=>`(Tags,like,${emailSanitizeFilterValue(t)})`).join('~or')+')');
  }
  return clauses.join('~and');
}

async function handleEmailCampaignsList(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const tableId=await emailResolveTable(env, payload.cid, 'campaigns');
  if(!tableId) return json({list:[]});
  const r=await ncFetch(env, `api/v2/tables/${tableId}/records?where=${encodeURIComponent(`(client_id,eq,${payload.cid})`)}&sort=-created_at&limit=200`);
  const data=await r.json().catch(()=>({}));
  return json(data, r.status);
}

async function handleEmailCampaignCreate(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const body=await request.json().catch(()=>({}));
  if(!body.subject||!body.html_body) return json({error:'subject and html_body required'}, 400);
  const tableId=await emailResolveTable(env, payload.cid, 'campaigns');
  if(!tableId) return json({error:'Email campaigns table not configured — see SETUP.md'}, 400);
  const r=await ncFetch(env, `api/v2/tables/${tableId}/records`, {method:'POST', body:{
    client_id:payload.cid, subject:body.subject, html_body:body.html_body,
    segment_filter:JSON.stringify(body.segment_filter||{}), status:'draft',
    created_at:new Date().toISOString(), total_recipients:0, total_sent:0, total_failed:0,
  }});
  const data=await r.json().catch(()=>({}));
  return json(data, r.status);
}

async function handleEmailCampaignUpdate(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const body=await request.json().catch(()=>({}));
  const id=parseInt(body.Id,10);
  if(!id) return json({error:'Id required'}, 400);
  const tableId=await emailResolveTable(env, payload.cid, 'campaigns');
  if(!tableId) return json({error:'Email campaigns table not configured'}, 400);
  const existingR=await ncFetch(env, `api/v2/tables/${tableId}/records/${id}`);
  const existing=await existingR.json().catch(()=>null);
  if(!existingR.ok||!existing||String(existing.client_id)!==String(payload.cid)) return json({error:'Not found'}, 404);
  if(existing.status!=='draft') return json({error:'Only draft campaigns can be edited'}, 400);
  const fields={};
  ['subject','html_body'].forEach(k=>{ if(k in body) fields[k]=body[k]; });
  if('segment_filter' in body) fields.segment_filter=JSON.stringify(body.segment_filter||{});
  const r=await ncFetch(env, `api/v2/tables/${tableId}/records`, {method:'PATCH', body:{Id:id, ...fields}});
  const data=await r.json().catch(()=>({}));
  return json(data, r.status);
}

async function handleEmailCampaignDelete(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const body=await request.json().catch(()=>({}));
  const id=parseInt(body.Id,10);
  if(!id) return json({error:'Id required'}, 400);
  const tableId=await emailResolveTable(env, payload.cid, 'campaigns');
  if(!tableId) return json({error:'Email campaigns table not configured'}, 400);
  const existingR=await ncFetch(env, `api/v2/tables/${tableId}/records/${id}`);
  const existing=await existingR.json().catch(()=>null);
  if(!existingR.ok||!existing||String(existing.client_id)!==String(payload.cid)) return json({error:'Not found'}, 404);
  // Deleting a sending/sent campaign would orphan its EmailSends history — drafts only.
  if(existing.status!=='draft') return json({error:'Only draft campaigns can be deleted'}, 400);
  const r=await ncFetch(env, `api/v2/tables/${tableId}/records`, {method:'DELETE', body:{Id:id}});
  const data=await r.json().catch(()=>({}));
  return json(data, r.status);
}

async function handleEmailAudiencePreview(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const url=new URL(request.url);
  let segmentFilter={};
  try{ segmentFilter=JSON.parse(url.searchParams.get('segment_filter')||'{}'); }catch(e){}
  const where=emailAudienceWhereClause(payload.cid, segmentFilter);
  const r=await ncFetch(env, `api/v2/tables/${DEFAULT_LEADS_TABLE}/records?where=${encodeURIComponent(where)}&limit=5&fields=Id,Name,Email`);
  const data=await r.json().catch(()=>({}));
  if(!r.ok) return json(data, r.status);
  // NocoDB's standard list response already includes pageInfo.totalRows for the given where
  // clause, regardless of the page's own limit — no separate count call needed.
  return json({count:data?.pageInfo?.totalRows??(data.list||[]).length, sample:(data.list||[]).slice(0,5)});
}

async function handleEmailCampaignSendInit(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const body=await request.json().catch(()=>({}));
  const campaignId=parseInt(body.campaign_id,10);
  if(!campaignId) return json({error:'campaign_id required'}, 400);
  const campaignsTable=await emailResolveTable(env, payload.cid, 'campaigns');
  const sendsTable=await emailResolveTable(env, payload.cid, 'sends');
  if(!campaignsTable||!sendsTable) return json({error:'Email tables not configured'}, 400);

  const campR=await ncFetch(env, `api/v2/tables/${campaignsTable}/records/${campaignId}`);
  const campaign=await campR.json().catch(()=>null);
  if(!campR.ok||!campaign||String(campaign.client_id)!==String(payload.cid)) return json({error:'Not found'}, 404);
  if(campaign.status!=='draft') return json({error:'Campaign already sent or sending'}, 400);

  let segmentFilter={}; try{ segmentFilter=JSON.parse(campaign.segment_filter||'{}'); }catch(e){}
  const where=emailAudienceWhereClause(payload.cid, segmentFilter);
  const leadsR=await ncFetch(env, `api/v2/tables/${DEFAULT_LEADS_TABLE}/records?where=${encodeURIComponent(where)}&limit=1000&fields=Id,Email`);
  const leadsData=await leadsR.json().catch(()=>({}));
  const leads=leadsData.list||[];
  if(!leads.length) return json({error:'No eligible recipients for this segment'}, 400);

  const CHUNK=40; // matches handleEcomDelete's bulk-write chunk size — NocoDB rejects overly large bulk arrays with a 422
  const rows=leads.map(l=>({client_id:payload.cid, campaign_id:campaignId, lead_id:l.Id, recipient_email:l.Email, status:'queued'}));
  const sendIds=[];
  for(let i=0;i<rows.length;i+=CHUNK){
    const r=await ncFetch(env, `api/v2/tables/${sendsTable}/records`, {method:'POST', body:rows.slice(i,i+CHUNK)});
    const created=await r.json().catch(()=>[]);
    // NocoDB's bulk-insert response is an array of the created rows (with their new Ids) —
    // the frontend needs these back so it has something concrete to loop send-one calls over.
    (Array.isArray(created)?created:[]).forEach(row=>{ if(row?.Id) sendIds.push(row.Id); });
  }
  await ncFetch(env, `api/v2/tables/${campaignsTable}/records`, {method:'PATCH', body:{Id:campaignId, status:'sending', total_recipients:leads.length}});
  return json({ok:true, total_recipients:leads.length, send_ids:sendIds});
}

async function handleEmailCampaignSendOne(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const body=await request.json().catch(()=>({}));
  const sendId=parseInt(body.send_id,10);
  if(!sendId) return json({error:'send_id required'}, 400);
  const sendsTable=await emailResolveTable(env, payload.cid, 'sends');
  const campaignsTable=await emailResolveTable(env, payload.cid, 'campaigns');
  if(!sendsTable||!campaignsTable) return json({error:'Email tables not configured'}, 400);

  const sendR=await ncFetch(env, `api/v2/tables/${sendsTable}/records/${sendId}`);
  const sendRow=await sendR.json().catch(()=>null);
  if(!sendR.ok||!sendRow||String(sendRow.client_id)!==String(payload.cid)) return json({error:'Not found'}, 404);
  if(sendRow.status!=='queued') return json({ok:true, skipped:true});

  // Defensive re-check — a long-running campaign send can overlap with a lead unsubscribing
  // partway through; send-init already filtered the audience, this is the last line of defense.
  const leadR=await ncFetch(env, `api/v2/tables/${DEFAULT_LEADS_TABLE}/records/${sendRow.lead_id}`);
  const lead=await leadR.json().catch(()=>null);
  if(leadR.ok && lead?.EmailOptOut==='Yes'){
    await ncFetch(env, `api/v2/tables/${sendsTable}/records`, {method:'PATCH', body:{Id:sendId, status:'failed', error:'Lead unsubscribed before send'}});
    return json({ok:true, skipped:true});
  }

  const campR=await ncFetch(env, `api/v2/tables/${campaignsTable}/records/${sendRow.campaign_id}`);
  const campaign=await campR.json().catch(()=>null);
  if(!campR.ok||!campaign) return json({error:'Campaign not found'}, 404);
  const c=await getClientById(env, payload.cid);

  const unsubToken=await hmacHex(env, `unsub:${sendRow.lead_id}`);
  const unsubLink=`${new URL(request.url).origin}/email/unsubscribe?lead_id=${sendRow.lead_id}&token=${unsubToken}`;
  const html=`${campaign.html_body}<p style="font-size:11px;color:#888;margin-top:24px">Don't want these emails? <a href="${unsubLink}">Unsubscribe</a>.</p>`;

  const result=await sendClientResendEmail(c, {to:sendRow.recipient_email, subject:campaign.subject, html});
  if(result.ok){
    await ncFetch(env, `api/v2/tables/${sendsTable}/records`, {method:'PATCH', body:{Id:sendId, status:'sent', sent_at:new Date().toISOString()}});
    await ncFetch(env, `api/v2/tables/${campaignsTable}/records`, {method:'PATCH', body:{Id:sendRow.campaign_id, total_sent:(campaign.total_sent||0)+1}});
  }else{
    await ncFetch(env, `api/v2/tables/${sendsTable}/records`, {method:'PATCH', body:{Id:sendId, status:'failed', error:result.error}});
    await ncFetch(env, `api/v2/tables/${campaignsTable}/records`, {method:'PATCH', body:{Id:sendRow.campaign_id, total_failed:(campaign.total_failed||0)+1}});
  }
  return json(result);
}

// Stateless HMAC helper, reusing SESSION_SIGNING_KEY with a domain-separation prefix rather than
// provisioning a new secret — same crypto.subtle HMAC pattern as signSession/verifySession.
async function hmacHex(env, message){
  const key=await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SIGNING_KEY), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const sig=await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return hex(sig);
}

async function handleEmailUnsubscribe(request, env){
  const url=new URL(request.url);
  const leadId=parseInt(url.searchParams.get('lead_id'),10);
  const token=url.searchParams.get('token')||'';
  if(!leadId||!token) return new Response('Invalid unsubscribe link.', {status:400});
  const expected=await hmacHex(env, `unsub:${leadId}`);
  if(expected.length!==token.length) return new Response('Invalid unsubscribe link.', {status:400});
  let diff=0;
  for(let i=0;i<expected.length;i++) diff|=expected.charCodeAt(i)^token.charCodeAt(i);
  if(diff!==0) return new Response('Invalid unsubscribe link.', {status:400});
  await ncFetch(env, `api/v2/tables/${DEFAULT_LEADS_TABLE}/records`, {method:'PATCH', body:{Id:leadId, EmailOptOut:'Yes'}});
  return new Response('<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:60px 20px"><h2>You\'ve been unsubscribed</h2><p>You won\'t receive any more marketing emails from us.</p></body></html>', {status:200, headers:{'Content-Type':'text/html'}});
}

// ── HEALTH CHECKS (Integrations tab — on-demand "Run Check Now" and once-daily Cron Trigger) ──
// Every check here is read-only and cheap by design, since the daily run fires unattended for
// every client: it only confirms a credential/config still works, it never sends a real
// message/email. "Send yourself a test message" stays a manual, on-demand action elsewhere in
// the Integrations tab, not something this loop does automatically.
function sheetCsvUrl(sheetUrl){
  const m=String(sheetUrl||'').match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if(!m) return null;
  const gidMatch=String(sheetUrl).match(/[#&?]gid=(\d+)/);
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv${gidMatch?'&gid='+gidMatch[1]:''}`;
}

async function checkSheet(url){
  if(!url) return {status:'warn', detail:'Not configured'};
  const csvUrl=sheetCsvUrl(url);
  if(!csvUrl) return {status:'fail', detail:'Not a recognizable Google Sheets URL'};
  try{
    const r=await fetch(csvUrl, {redirect:'follow'});
    const text=await r.text();
    if(!r.ok) return {status:'fail', detail:'HTTP '+r.status+' — check sharing is set to "Anyone with the link can view"'};
    if(/<html/i.test(text.slice(0,200))) return {status:'fail', detail:'Sheet is not publicly viewable — check sharing settings'};
    if(!text.trim()) return {status:'warn', detail:'Sheet is empty'};
    return {status:'ok', detail:Math.max(text.trim().split('\n').length-1,0)+' row(s)'};
  }catch(e){ return {status:'fail', detail:e.message||'Fetch failed'}; }
}

const HEALTH_CHECKS=[
  { key:'whatsapp', label:'WhatsApp (Meta)', category:'integration', fn: async (env,c)=>{
    if(!c.wa_phone_id||!c.wa_token) return {status:'warn', detail:'Not connected'};
    const r=await fetch(`https://graph.facebook.com/v18.0/${c.wa_phone_id}?fields=display_phone_number,quality_rating`, {headers:{Authorization:`Bearer ${c.wa_token}`}});
    const data=await r.json().catch(()=>({}));
    if(!r.ok) return {status:'fail', detail:data?.error?.message||'HTTP '+r.status};
    if(data.quality_rating==='RED') return {status:'warn', detail:'Connected, but number quality rating is RED'};
    return {status:'ok', detail:data.display_phone_number||'Connected'};
  }},
  { key:'resend', label:'Resend (Email)', category:'integration', fn: async (env,c)=>{
    if(!c.resend_api_key) return {status:'warn', detail:'Not connected'};
    const r=await fetch('https://api.resend.com/domains', {headers:{Authorization:`Bearer ${c.resend_api_key}`}});
    if(!r.ok) return {status:'fail', detail:r.status===401?'API key invalid or revoked':'HTTP '+r.status};
    const data=await r.json().catch(()=>({}));
    const verified=(data?.data||[]).some(d=>d.status==='verified');
    return {status:verified?'ok':'warn', detail:verified?'Domain verified':'Connected, but no verified sending domain yet'};
  }},
  { key:'chatwoot', label:'Chatwoot', category:'integration', fn: async (env,c)=>{
    if(!c.chatwoot_base||!c.chatwoot_account_id||!c.chatwoot_token) return {status:'warn', detail:'Not connected'};
    const r=await fetch(`${c.chatwoot_base}/api/v1/accounts/${c.chatwoot_account_id}/inboxes`, {headers:{api_access_token:c.chatwoot_token}});
    if(!r.ok) return {status:'fail', detail:'HTTP '+r.status};
    return {status:'ok', detail:'Connected'};
  }},
  { key:'sheet_leads', label:'Google Sheet — Leads Export', category:'sheets', fn: async (env,c)=>checkSheet(c.gsheet_url) },
  { key:'sheet_prospect', label:'Google Sheet — Prospect Import', category:'sheets', fn: async (env,c)=>checkSheet(c.prospect_gsheet_url) },
  { key:'sheet_ecom_products', label:'Google Sheet — Ecom Products', category:'sheets', fn: async (env,c)=>checkSheet(c.ecom_products_sheet) },
  { key:'sheet_ecom_orders', label:'Google Sheet — Ecom Orders', category:'sheets', fn: async (env,c)=>checkSheet(c.ecom_orders_sheet) },
  { key:'recovery_engine', label:'Follow-up Recovery Engine', category:'core', fn: async (env,c)=>{
    if(c.recovery_enabled==='No') return {status:'warn', detail:'Disabled for this account'};
    if(!c.recovery_heartbeat_at) return {status:'warn', detail:'Never run yet for this account'};
    const hrs=(Date.now()-new Date(c.recovery_heartbeat_at).getTime())/3600000;
    if(hrs>36) return {status:'fail', detail:'No heartbeat in '+Math.round(hrs)+'h — engine may be down'};
    return {status:'ok', detail:'Last run '+Math.round(hrs)+'h ago'};
  }},
  { key:'followup_config', label:'Follow-up Sequence Config', category:'core', fn: async (env,c)=>{
    const count=parseInt(c.followup_count||0);
    if(!count) return {status:'warn', detail:'Not configured'};
    const hours=(c.followup_hours||'').split(',').map(s=>s.trim()).filter(Boolean);
    const msgs=(c.followup_messages||'').split('\n').map(s=>s.trim()).filter(Boolean);
    if(hours.length<count||msgs.length<count) return {status:'fail', detail:`Configured for ${count} steps but only ${hours.length} hour(s) / ${msgs.length} message(s) set`};
    return {status:'ok', detail:count+'-step sequence configured correctly'};
  }},
];

async function runHealthChecks(env, client){
  const results=[];
  for(const check of HEALTH_CHECKS){
    let result;
    try{ result=await check.fn(env, client); }
    catch(e){ result={status:'fail', detail:e.message||'Check threw an error'}; }
    results.push({key:check.key, label:check.label, category:check.category, ...result});
  }
  return results;
}

function overallHealthStatus(results){
  if(results.some(r=>r.status==='fail')) return 'fail';
  if(results.some(r=>r.status==='warn')) return 'warn';
  return 'ok';
}

async function saveHealthResults(env, client, results){
  let log=[]; try{ log=JSON.parse(client.integration_health_log||'[]'); }catch(e){}
  log.push({ts:new Date().toISOString(), results});
  if(log.length>14) log=log.slice(-14); // ~2 weeks of daily runs
  await patchClientFields(env, client.Id, {
    integration_health_log: JSON.stringify(log),
    integration_health_status: overallHealthStatus(results),
    integration_health_checked_at: new Date().toISOString(),
  });
}

async function handleHealthRun(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const c=await getClientById(env, payload.cid);
  if(!c) return json({error:'Client not found'}, 404);
  const results=await runHealthChecks(env, c);
  await saveHealthResults(env, c, results);
  return json({ok:true, status:overallHealthStatus(results), results, checked_at:new Date().toISOString()});
}

// Daily Cron Trigger entry point — see wrangler.toml [triggers]. Loops every client (paginated)
// instead of relying on each client's browser being open, so the check genuinely runs once a
// day for everyone, not just for whoever happens to visit Settings that day.
async function runDailyHealthCheckForAllClients(env){
  let page=1;
  while(true){
    const r=await ncFetch(env, `api/v2/tables/${CLIENTS_TABLE}/records?limit=200&offset=${(page-1)*200}`);
    if(!r.ok) break;
    const data=await r.json().catch(()=>({}));
    const rows=data?.list||[];
    if(!rows.length) break;
    for(const c of rows){
      try{
        const results=await runHealthChecks(env, c);
        await saveHealthResults(env, c, results);
      }catch(e){ console.error('[health] check failed for client', c.Id, e.message); }
    }
    if(rows.length<200) break;
    page++;
  }
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

/* ── Campaigns module (broadcast.html) — Chatwoot template list/create + send
   routes, so chatwoot_token never reaches the browser (previously broadcast.html
   embedded both the master NocoDB token and the client's own chatwoot_token
   directly, readable via view-source — see SETUP.md's "Known gap" note). Lead
   reads/writes for the Follow-ups tab and the Tracking log reuse the existing
   generic /nocodb/* passthrough below — only the actual Chatwoot sends and the
   template list/create need a dedicated route, since those are the only calls
   that require the client's chatwoot_token. ── */
// Chatwoot has no "whatsapp_templates" sub-resource (that route 404s on every inbox — it doesn't
// exist in Chatwoot's API at all). The real API surface, confirmed against Chatwoot's own source:
// templates are synced from Meta asynchronously via POST .../sync_templates (fire-and-forget, no
// templates in the response), and the last-synced list is exposed as a flat `message_templates`
// field on the ordinary GET .../inboxes/:id (inbox show) response.
async function handleBroadcastTemplatesGet(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const c=await getClientById(env, payload.cid);
  if(!c?.chatwoot_base||!c?.chatwoot_account_id||!c?.chatwoot_token||!c?.chatwoot_inbox_id) return json({error:'Chatwoot is not fully configured for this account.'}, 400);
  const r=await fetch(`${c.chatwoot_base}/api/v1/accounts/${c.chatwoot_account_id}/inboxes/${c.chatwoot_inbox_id}`, {headers:{api_access_token:c.chatwoot_token}});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) return json({error:data?.message||'Chatwoot API '+r.status}, 502);
  return json({ok:true, templates:data?.message_templates||[], last_updated:data?.message_templates_last_updated||null});
}

// Triggers Chatwoot's async template sync job (pulls the latest approved templates from Meta into
// Chatwoot's cache). It only enqueues the job and returns immediately — the caller should wait a
// few seconds and then call handleBroadcastTemplatesGet again to see the refreshed list.
async function handleBroadcastTemplatesSync(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const c=await getClientById(env, payload.cid);
  if(!c?.chatwoot_base||!c?.chatwoot_account_id||!c?.chatwoot_token||!c?.chatwoot_inbox_id) return json({error:'Chatwoot is not fully configured for this account.'}, 400);
  const r=await fetch(`${c.chatwoot_base}/api/v1/accounts/${c.chatwoot_account_id}/inboxes/${c.chatwoot_inbox_id}/sync_templates`, {
    method:'POST', headers:{api_access_token:c.chatwoot_token}
  });
  const data=await r.json().catch(()=>({}));
  if(!r.ok) return json({error:data?.error||data?.message||'Chatwoot API '+r.status}, 502);
  return json({ok:true, message:data?.message||'Template sync initiated'});
}

// Chatwoot only *syncs* templates from Meta — it has no API to create a new one, since a template
// must be submitted straight to Meta for approval. So creating one still requires the client's own
// Meta WhatsApp Business API credentials (waba_id/wa_token) — this is a real limitation of Chatwoot
// itself, not something we can route around, unlike listing/sending which Chatwoot fully supports.
async function handleBroadcastTemplatesCreate(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const {name, category, language, body, header, footer}=await request.json().catch(()=>({}));
  if(!name||!body) return json({error:'name and body required'}, 400);
  const c=await getClientById(env, payload.cid);
  if(!c?.waba_id||!c?.wa_token) return json({error:'Creating a new template requires connecting your Meta WhatsApp Business API (Settings → Channels) — Chatwoot can only sync templates that already exist on Meta, not create new ones. Alternatively, create the template directly in Meta Business Manager, then use Refresh to pull it in.'}, 400);
  const components=[{type:'BODY', text:body}];
  if(header) components.unshift({type:'HEADER', format:'TEXT', text:header});
  if(footer) components.push({type:'FOOTER', text:footer});
  const r=await fetch(`https://graph.facebook.com/v18.0/${c.waba_id}/message_templates`, {
    method:'POST', headers:{Authorization:`Bearer ${c.wa_token}`, 'Content-Type':'application/json'},
    body:JSON.stringify({name, category, language, components})
  });
  const data=await r.json().catch(()=>({}));
  if(!r.ok) return json({error:data?.error?.message||'HTTP '+r.status}, 502);
  return json({ok:true, data});
}

// Plain message send, with an optional image/video attachment — the "Direct Message" tab
// (leads still inside WhatsApp's 24h session window, so a free-text message is allowed).
async function handleBroadcastSendDm(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const form=await request.formData().catch(()=>null);
  if(!form) return json({error:'multipart form data required'}, 400);
  const conv_id=form.get('conv_id');
  const content=form.get('content')||'';
  const file=form.get('file');
  if(!conv_id||(!content&&!file)) return json({error:'conv_id and content (or file) required'}, 400);
  const c=await getClientById(env, payload.cid);
  if(!c?.chatwoot_base||!c?.chatwoot_account_id||!c?.chatwoot_token) return json({error:'Chatwoot is not configured for this account.'}, 400);
  const fd=new FormData();
  fd.append('message_type','outgoing'); fd.append('private','false');
  if(content) fd.append('content', content);
  if(file && file.size) fd.append('attachments[]', file, file.name||'attachment');
  const r=await fetch(`${c.chatwoot_base}/api/v1/accounts/${c.chatwoot_account_id}/conversations/${conv_id}/messages`, {method:'POST', headers:{api_access_token:c.chatwoot_token}, body:fd});
  if(!r.ok) return json({error:'HTTP '+r.status}, 502);
  return json({ok:true, data:await r.json().catch(()=>({}))});
}

// Approved-template send — for leads outside the 24h window, or any lead you want to reach
// with a formal WhatsApp Business template. The "Template Broadcast" tab.
async function handleBroadcastSendTemplate(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const {conv_id, content, template_name, category, language, processed_params}=await request.json().catch(()=>({}));
  if(!conv_id||!content||!template_name) return json({error:'conv_id, content, and template_name required'}, 400);
  const c=await getClientById(env, payload.cid);
  if(!c?.chatwoot_base||!c?.chatwoot_account_id||!c?.chatwoot_token) return json({error:'Chatwoot is not configured for this account.'}, 400);
  const r=await fetch(`${c.chatwoot_base}/api/v1/accounts/${c.chatwoot_account_id}/conversations/${conv_id}/messages`, {
    method:'POST', headers:{api_access_token:c.chatwoot_token, 'Content-Type':'application/json'},
    body:JSON.stringify({content, message_type:'outgoing', private:false, template_params:{name:template_name, category:category||'MARKETING', language:language||'en', processed_params:processed_params||{}}})
  });
  if(!r.ok) return json({error:'HTTP '+r.status}, 502);
  return json({ok:true, data:await r.json().catch(()=>({}))});
}

// Manual "send next follow-up now" — a rep's on-demand override alongside the automated
// classic follow-up sequence (followup-template.json) and the recovery ladder (recovery.js).
// Only covers the classic followup_messages sequence, not the recovery_* ladder, which stays
// automation-only and read-only in the Follow-ups tab (see SETUP.md).
async function handleBroadcastFollowupSend(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const {lead_id}=await request.json().catch(()=>({}));
  if(!lead_id) return json({error:'lead_id required'}, 400);
  const c=await getClientById(env, payload.cid);
  if(!c?.chatwoot_base||!c?.chatwoot_account_id||!c?.chatwoot_token) return json({error:'Chatwoot is not configured for this account.'}, 400);

  const leadR=await ncFetch(env, `api/v2/tables/${DEFAULT_LEADS_TABLE}/records/${lead_id}`);
  if(!leadR.ok) return json({error:'Lead not found'}, 404);
  const lead=await leadR.json();
  if(String(lead.ClientId)!==String(payload.cid)) return json({error:'Not your lead'}, 403);
  const convId=lead.ConversationID||lead.conv_id||lead.ConversationId||lead.chatwoot_conv_id;
  if(!convId) return json({error:'This lead has no conversation yet.'}, 400);

  const messages=(c.followup_messages||'').split('\n').map(s=>s.trim()).filter(Boolean);
  const count=parseInt(c.followup_count||0);
  let nextIdx=-1;
  for(let i=0;i<Math.min(count,3);i++){ if(lead['Follow up '+(i+1)]!=='Yes'){ nextIdx=i; break; } }
  if(nextIdx===-1) return json({error:'No follow-up steps left to send for this lead.'}, 400);
  const tmpl=messages[nextIdx]||messages[messages.length-1];
  if(!tmpl) return json({error:'No follow-up message configured for this client.'}, 400);
  const text=tmpl.replace(/\{name\}/gi, lead.Name||'there');

  const fd=new FormData();
  fd.append('content', text); fd.append('message_type','outgoing'); fd.append('private','false');
  const r=await fetch(`${c.chatwoot_base}/api/v1/accounts/${c.chatwoot_account_id}/conversations/${convId}/messages`, {method:'POST', headers:{api_access_token:c.chatwoot_token}, body:fd});
  if(!r.ok) return json({error:'HTTP '+r.status}, 502);

  await ncFetch(env, `api/v2/tables/${DEFAULT_LEADS_TABLE}/records`, {method:'PATCH', body:{Id:Number(lead_id), ['Follow up '+(nextIdx+1)]:'Yes'}});
  return json({ok:true, stage:nextIdx+1, sentText:text});
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

  // wa_phone_id is Meta's internal phone-number-id (needed for API calls), not something a
  // customer can dial — wa_display_phone is the actual number (e.g. "+91 94969 71950") and is
  // what the public storefront's "Order on WhatsApp" links use, so they open the exact same
  // WhatsApp thread this bot/inbox replies from instead of a different, unrelated number.
  await patchClientFields(env, payload.cid, {chatwoot_inbox_id:String(inbox.id), waba_id, wa_token, wa_phone_id:phone_number_id, wa_display_phone:phone_number});
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
// it can't be done from this Worker. This route just gets the caller into Chatwoot already
// logged in (via the Platform API's one-time SSO link) so they land on that page with zero
// credential friction, instead of hitting a login wall for a password they were never shown.
//
// Also used by the "Log in to Chatwoot" link in the Chats tab — an optional ?email= (the
// caller's own verified Authentik email, from dashboard.html's `myEmail`) picks that specific
// person's own Chatwoot agent (team_chatwoot_users, populated by createChatwootAgent above) so
// each teammate lands in Chatwoot as themselves, not borrowing the account owner's identity.
// Falls back to the owner's chatwoot_user_id when no email is given or no per-user agent exists
// for it (e.g. they were added via "Add Existing Authentik User", which never provisions one).
async function handleChannelsChatwootSso(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const c=await getClientById(env, payload.cid);
  const requestedEmail=(new URL(request.url).searchParams.get('email')||'').trim().toLowerCase();
  let chatwootUserId=c?.chatwoot_user_id;
  if(requestedEmail && requestedEmail!==String(c?.authentik_email||'').toLowerCase()){
    let teamUsers={}; try{ teamUsers=JSON.parse(c?.team_chatwoot_users||'{}'); }catch(e){}
    const key=Object.keys(teamUsers).find(k=>k.toLowerCase()===requestedEmail);
    if(key) chatwootUserId=teamUsers[key];
  }
  if(!chatwootUserId) return json({error:'Connect a Chatwoot account first.'}, 400);
  const r=await chatwootPlatformFetch(env, `/platform/api/v1/users/${chatwootUserId}/login`);
  const data=await r.json().catch(()=>({}));
  if(!r.ok||!data?.url) return json({error:'Failed to generate a Chatwoot login link: '+(data?.message||('HTTP '+r.status))}, 502);
  return json({ok:true, url:data.url});
}

/* ── Shopify module (Integrations tab connect + order/fulfillment/checkout webhooks) ────────
   A one-click OAuth connect that lets this Worker read a client's Shopify store directly —
   order/fulfillment webhooks trigger WhatsApp notifications straight from here, and checkout
   webhooks feed an abandoned-cart nudge, all without n8n in the loop. Contrast with
   handleChannelsChatwootSso above: that's Chatwoot's own Shopify sidebar integration (order
   context inside a conversation); this is a separate connection whose token/data live on the
   client row here, used for WhatsApp notifications (and, later, WhatsApp Catalog sync).
   Requires SHOPIFY_API_KEY / SHOPIFY_API_SECRET (a Shopify Partners app's credentials) and a
   `shopify_checkouts` NocoDB table (id below) — see SETUP.md "Shopify module". ── */
// Keep in sync with the "Webhooks API version" set on the app in Shopify Partners — Shopify only
// supports a given version for ~9-12 months after release, so this needs bumping periodically
// (quarterly releases: -01, -04, -07, -10).
const SHOPIFY_API_VERSION='2026-07';
const SHOPIFY_SCOPES='read_orders,read_fulfillments,read_checkouts';
// Create this table once in NocoDB (fields: client_id, checkout_token, phone, customer_name,
// cart_summary, total, currency, recovery_url, created_at, nudge_sent, completed) and paste its
// id here — same pattern as EMAIL_CAMPAIGNS_TABLE/EMAIL_SENDS_TABLE above.
const SHOPIFY_CHECKOUTS_TABLE='REPLACE_SHOPIFY_CHECKOUTS_TABLE_ID';
// Sent via WhatsApp when each event fires — 'abandoned' is swept in by cron, the rest by webhook.
const SHOPIFY_EVENT_KINDS=['received','paid','shipped','delivered','abandoned'];

function isValidShopDomain(shop){ return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(String(shop||'')); }

// Same HMAC scheme as signAdminSession/hmacSignB64 above, reused so the OAuth `state` param can
// carry the client id through Shopify's redirect round-trip with no server-side session store —
// Shopify hands `state` back verbatim on the callback. 10-minute expiry: this only needs to
// survive one redirect hop, not a whole session.
async function signShopifyState(env, clientId){
  const payload={cid:String(clientId), exp:Math.floor(Date.now()/1000)+600, n:crypto.randomUUID()};
  const body=btoa(JSON.stringify(payload));
  return `${body}.${await hmacSignB64(env, body)}`;
}
async function verifyShopifyState(env, token){
  if(!token) return null;
  const [body, sig]=String(token).split('.');
  if(!body||!sig) return null;
  if(await hmacSignB64(env, body)!==sig) return null;
  let payload; try{ payload=JSON.parse(atob(body)); }catch(e){ return null; }
  if(!payload?.cid||!payload?.exp||payload.exp<Math.floor(Date.now()/1000)) return null;
  return payload;
}

// Shopify's OAuth callback signs every query param (except hmac/signature) with the app's
// client secret — sorted key=value pairs joined with '&', hex HMAC-SHA256. Same idea as
// verifyStripeSignature above, just over query params instead of a raw body.
async function verifyShopifyOauthHmac(env, searchParams){
  const hmac=searchParams.get('hmac');
  if(!hmac) return false;
  const pairs=[...searchParams.entries()].filter(([k])=>k!=='hmac'&&k!=='signature').sort(([a],[b])=>a<b?-1:1);
  const message=pairs.map(([k,v])=>`${k}=${v}`).join('&');
  const key=await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SHOPIFY_API_SECRET), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const sig=await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  const expected=hex(sig);
  if(expected.length!==hmac.length) return false;
  let diff=0; for(let i=0;i<expected.length;i++) diff|=expected.charCodeAt(i)^hmac.charCodeAt(i);
  return diff===0;
}

// Shopify signs webhook bodies with a base64 HMAC-SHA256 (X-Shopify-Hmac-Sha256) over the raw,
// unparsed request body — must be verified before the body is touched as JSON.
async function verifyShopifyWebhookHmac(env, rawBody, hmacHeader){
  if(!hmacHeader) return false;
  const key=await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SHOPIFY_API_SECRET), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const sig=await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expected=btoa(String.fromCharCode(...new Uint8Array(sig)));
  if(expected.length!==hmacHeader.length) return false;
  let diff=0; for(let i=0;i<expected.length;i++) diff|=expected.charCodeAt(i)^hmacHeader.charCodeAt(i);
  return diff===0;
}

async function shopifyFetch(env, shop, token, path, opts={}){
  return fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}${path}`, {
    ...opts,
    headers:{'X-Shopify-Access-Token':token, 'Content-Type':'application/json', ...(opts.headers||{})}
  });
}

async function handleShopifyOauthStart(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  if(!env.SHOPIFY_API_KEY||!env.SHOPIFY_API_SECRET) return json({error:'Shopify app credentials are not configured on the server.'}, 500);
  const {shop}=await request.json().catch(()=>({}));
  if(!isValidShopDomain(shop)) return json({error:'Enter your store as yourstore.myshopify.com'}, 400);
  const c=await getClientById(env, payload.cid);
  if(!c) return json({error:'Client not found'}, 404);
  if(c.shopify_shop_domain && c.shopify_access_token) return json({error:'A Shopify store is already connected for this client. Disconnect it first to switch stores.'}, 400);

  const state=await signShopifyState(env, payload.cid);
  const redirectUri=`${env.WORKER_BASE_URL}/shopify/oauth/callback`;
  const url=`https://${shop}/admin/oauth/authorize?client_id=${env.SHOPIFY_API_KEY}&scope=${encodeURIComponent(SHOPIFY_SCOPES)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`;
  return json({ok:true, url});
}

// Browser redirect target, not an XHR call — Shopify itself lands the merchant here after they
// approve the install, so failures redirect back into the dashboard with a query param instead
// of returning JSON (there's no frontend JS listening on this response).
async function handleShopifyOauthCallback(request, env){
  const url=new URL(request.url);
  const appBase=env.APP_BASE_URL||'https://app.leadvyne.com/dashboard.html';
  const fail=(msg)=>Response.redirect(`${appBase}?shopify=error&msg=${encodeURIComponent(msg)}`, 302);
  if(!env.SHOPIFY_API_KEY||!env.SHOPIFY_API_SECRET) return fail('Shopify app credentials are not configured on the server.');

  if(!await verifyShopifyOauthHmac(env, url.searchParams)) return fail('Shopify signature verification failed');
  const shop=url.searchParams.get('shop');
  const code=url.searchParams.get('code');
  const state=url.searchParams.get('state');
  if(!isValidShopDomain(shop)||!code) return fail('Invalid callback from Shopify');
  const statePayload=await verifyShopifyState(env, state);
  if(!statePayload) return fail('This connection link expired — try connecting again from Integrations');

  const collision=await findOtherClientByField(env, 'shopify_shop_domain', shop, statePayload.cid);
  if(collision) return fail('This Shopify store is already connected to a different client');

  const tokenR=await fetch(`https://${shop}/admin/oauth/access_token`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({client_id:env.SHOPIFY_API_KEY, client_secret:env.SHOPIFY_API_SECRET, code})
  });
  const tokenData=await tokenR.json().catch(()=>({}));
  if(!tokenR.ok||!tokenData.access_token) return fail('Token exchange failed: '+(tokenData?.error||'HTTP '+tokenR.status));
  const access_token=tokenData.access_token;

  // Best-effort — registers the webhooks this module depends on. A client re-connecting after a
  // revoke can just disconnect and connect again to re-register them.
  const topics=['orders/create','orders/paid','orders/cancelled','fulfillments/create','fulfillments/update','checkouts/create','checkouts/update','app/uninstalled'];
  const webhookUri=`${env.WORKER_BASE_URL}/shopify/webhook`;
  await Promise.all(topics.map(topic=>
    shopifyFetch(env, shop, access_token, '/webhooks.json', {method:'POST', body:JSON.stringify({webhook:{topic, address:webhookUri, format:'json'}})}).catch(()=>{})
  ));

  await patchClientFields(env, statePayload.cid, {shopify_shop_domain:shop, shopify_access_token:access_token, shopify_connected_at:new Date().toISOString()});
  return Response.redirect(`${appBase}?client=${statePayload.cid}&shopify=connected`, 302);
}

async function handleShopifyDisconnect(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  await patchClientFields(env, payload.cid, {shopify_shop_domain:'', shopify_access_token:'', shopify_connected_at:''});
  return json({ok:true});
}

// Fires a WhatsApp template straight through Meta's Graph API (same shape as
// handleWaSendTemplate above) and records the attempt in shopify_notify_log regardless of
// outcome, so the Shopify Notifications page (ecom.html) has something to show even for a
// skipped/failed send. `kind` indexes into shopify_notify_config.config; `vars` supplies the
// values available for that event's template variable mapping.
async function sendShopifyNotification(env, c, kind, vars, logMeta){
  let stored={}; try{ stored=JSON.parse(c.shopify_notify_config||'{}'); }catch(e){}
  const cfg=stored?.config?.[kind];
  let log=[]; try{ log=JSON.parse(c.shopify_notify_log||'[]'); }catch(e){}
  const entry={ts:new Date().toISOString(), event:kind, order:logMeta.order||'', phone:logMeta.phone||''};

  if(!cfg?.name){ entry.status='skipped'; entry.detail='Not configured'; }
  else if(!c.wa_phone_id||!c.wa_token){ entry.status='skipped'; entry.detail='WhatsApp not connected'; }
  else if(!logMeta.phone){ entry.status='skipped'; entry.detail='No customer phone on this order'; }
  else{
    const params=cfg.params||[];
    const components=params.length ? [{type:'body', parameters:params.map(key=>({type:'text', text:String((key&&vars[key])||'')}))}] : [];
    const r=await fetch(`https://graph.facebook.com/v18.0/${c.wa_phone_id}/messages`, {
      method:'POST', headers:{Authorization:`Bearer ${c.wa_token}`, 'Content-Type':'application/json'},
      body:JSON.stringify({messaging_product:'whatsapp', to:logMeta.phone, type:'template', template:{name:cfg.name, language:{code:cfg.lang||'en'}, components}})
    });
    const data=await r.json().catch(()=>({}));
    entry.status=r.ok?'sent':'failed';
    entry.detail=r.ok?(data?.messages?.[0]?.id||'sent'):(data?.error?.message||'HTTP '+r.status);
  }
  log.push(entry);
  if(log.length>30) log=log.slice(-30); // ~last 30 events is plenty for the log view, not an audit trail
  await patchClientFields(env, c.Id, {shopify_notify_log:JSON.stringify(log)});
}

async function findShopifyCheckoutRow(env, clientId, token){
  if(!token) return null;
  const r=await ncFetch(env, `api/v2/tables/${SHOPIFY_CHECKOUTS_TABLE}/records?where=(client_id,eq,${clientId})~and(checkout_token,eq,${encodeURIComponent(token)})&limit=1`);
  if(!r.ok) return null;
  const data=await r.json().catch(()=>({}));
  return data?.list?.[0]||null;
}

async function upsertShopifyCheckout(env, clientId, payload){
  const token=payload.token||payload.cart_token;
  if(!token) return;
  const fields={
    client_id:clientId, checkout_token:token,
    phone:payload.phone||payload.shipping_address?.phone||payload.billing_address?.phone||'',
    customer_name:[payload.billing_address?.first_name, payload.billing_address?.last_name].filter(Boolean).join(' '),
    cart_summary:(payload.line_items||[]).map(li=>`${li.quantity}x ${li.title}`).join(', '),
    total:payload.total_price||'', currency:payload.currency||'',
    recovery_url:payload.abandoned_checkout_url||'', created_at:payload.created_at||new Date().toISOString(),
  };
  const existing=await findShopifyCheckoutRow(env, clientId, token);
  if(existing) await ncFetch(env, `api/v2/tables/${SHOPIFY_CHECKOUTS_TABLE}/records`, {method:'PATCH', body:{Id:existing.Id, ...fields}});
  else await ncFetch(env, `api/v2/tables/${SHOPIFY_CHECKOUTS_TABLE}/records`, {method:'POST', body:{...fields, nudge_sent:'No', completed:'No'}});
}

async function markShopifyCheckoutCompleted(env, clientId, token){
  if(!token) return;
  const existing=await findShopifyCheckoutRow(env, clientId, token);
  if(existing) await ncFetch(env, `api/v2/tables/${SHOPIFY_CHECKOUTS_TABLE}/records`, {method:'PATCH', body:{Id:existing.Id, completed:'Yes'}});
}

async function findEcomOrderByShopifyId(env, tableId, clientId, shopifyOrderId){
  const r=await ncFetch(env, `api/v2/tables/${tableId}/records?where=(client_id,eq,${clientId})~and(shopify_order_id,eq,${shopifyOrderId})&limit=1`);
  if(!r.ok) return null;
  const data=await r.json().catch(()=>({}));
  return data?.list?.[0]||null;
}

// Mirrors upsertShopifyCheckout's find-then-patch-or-create pattern, keeping the client's own
// Ecommerce module Orders page (ecom.html — ORDER_FIELDS there is the authoritative column list
// this must match) in sync with Shopify's order lifecycle, not just the WhatsApp notifications
// sendShopifyNotification fires. Matched on `shopify_order_id` (Shopify's own numeric order id,
// stable across every webhook for that order) rather than `order_id`/name, which a merchant could
// edit in Shopify after the fact. Requires a `shopify_order_id` column on the orders table (both
// the shared default and any client's own — see SETUP.md); silently no-ops if the client has no
// orders table resolvable at all (ecomResolveTable falls back to the shared default, so in
// practice this only skips if that default table id itself is ever cleared).
async function syncShopifyOrderToEcom(env, c, order, status){
  const tableId=await ecomResolveTable(env, c.Id, 'orders');
  if(!tableId||!order?.id) return;
  const fields={
    client_id:c.Id, shopify_order_id:String(order.id), status,
    order_id:order.name||('#'+(order.order_number||order.id)),
    customer_name:[order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' '),
    customer_phone:order.phone||order.shipping_address?.phone||order.customer?.phone||'',
    order_date:(order.created_at||'').slice(0,10),
    items:(order.line_items||[]).map(li=>`${li.quantity}x ${li.title}`).join(', '),
    total:order.total_price||'', currency:order.currency||'',
    delivery_address:[order.shipping_address?.address1, order.shipping_address?.city, order.shipping_address?.country].filter(Boolean).join(', '),
  };
  const existing=await findEcomOrderByShopifyId(env, tableId, c.Id, fields.shopify_order_id);
  if(existing) await ncFetch(env, `api/v2/tables/${tableId}/records`, {method:'PATCH', body:{Id:existing.Id, ...fields}});
  else await ncFetch(env, `api/v2/tables/${tableId}/records`, {method:'POST', body:fields});
}

// Webhook receiver — server-to-server from Shopify, so auth is the HMAC header, not a session.
// Reads the raw body first and verifies before touching it as JSON (order matters: the HMAC is
// computed over the exact bytes Shopify sent).
async function handleShopifyWebhook(request, env){
  const rawBody=await request.text();
  if(!await verifyShopifyWebhookHmac(env, rawBody, request.headers.get('X-Shopify-Hmac-Sha256'))) return json({error:'Invalid signature'}, 401);
  const shop=request.headers.get('X-Shopify-Shop-Domain');
  const topic=request.headers.get('X-Shopify-Topic');
  const c=await findClientByField(env, 'shopify_shop_domain', shop);
  // Unknown shop (e.g. a leftover webhook after disconnect) — ack with 200 so Shopify doesn't
  // keep retrying; there's no client row left to act on.
  if(!c) return json({ok:true});
  let data; try{ data=JSON.parse(rawBody); }catch(e){ return json({ok:true}); }

  if(topic==='orders/create'){
    const phone=data.phone||data.shipping_address?.phone||data.customer?.phone||'';
    await sendShopifyNotification(env, c, 'received', {
      customer_name:data.customer?.first_name||'', order_number:String(data.name||data.order_number||''),
      total:data.total_price||'', items:(data.line_items||[]).map(li=>`${li.quantity}x ${li.title}`).join(', '),
      store_name:c.client_name||''
    }, {phone, order:data.name||''});
    await markShopifyCheckoutCompleted(env, c.Id, data.checkout_token||data.cart_token);
    await syncShopifyOrderToEcom(env, c, data, 'received');
  }
  else if(topic==='orders/paid'){
    const phone=data.phone||data.shipping_address?.phone||data.customer?.phone||'';
    await sendShopifyNotification(env, c, 'paid', {
      customer_name:data.customer?.first_name||'', order_number:String(data.name||data.order_number||''),
      total:data.total_price||'', items:(data.line_items||[]).map(li=>`${li.quantity}x ${li.title}`).join(', '),
      store_name:c.client_name||''
    }, {phone, order:data.name||''});
    await syncShopifyOrderToEcom(env, c, data, 'processing');
  }
  else if(topic==='orders/cancelled'){
    await syncShopifyOrderToEcom(env, c, data, 'cancelled');
  }
  else if(topic==='fulfillments/create'){
    const orderR=await shopifyFetch(env, shop, c.shopify_access_token, `/orders/${data.order_id}.json`);
    const order=await orderR.json().catch(()=>null);
    const phone=order?.order?.phone||order?.order?.shipping_address?.phone||'';
    await sendShopifyNotification(env, c, 'shipped', {
      customer_name:order?.order?.customer?.first_name||'', order_number:String(order?.order?.name||''),
      tracking_number:data.tracking_number||'', tracking_url:(data.tracking_urls||[])[0]||'', store_name:c.client_name||''
    }, {phone, order:order?.order?.name||''});
    if(order?.order) await syncShopifyOrderToEcom(env, c, order.order, 'shipped');
  }
  else if(topic==='fulfillments/update'){
    // Shopify only reports 'delivered' when the carrier is one it tracks natively — best-effort,
    // not every order will get this event. See SETUP.md "Shopify module" for the caveat.
    if(data.shipment_status==='delivered'){
      const orderR=await shopifyFetch(env, shop, c.shopify_access_token, `/orders/${data.order_id}.json`);
      const order=await orderR.json().catch(()=>null);
      const phone=order?.order?.phone||order?.order?.shipping_address?.phone||'';
      await sendShopifyNotification(env, c, 'delivered', {
        customer_name:order?.order?.customer?.first_name||'', order_number:String(order?.order?.name||''),
        review_link:c.review_link||'', store_name:c.client_name||''
      }, {phone, order:order?.order?.name||''});
      if(order?.order) await syncShopifyOrderToEcom(env, c, order.order, 'delivered');
    }
  }
  else if(topic==='checkouts/create'||topic==='checkouts/update'){
    await upsertShopifyCheckout(env, c.Id, data);
  }
  else if(topic==='app/uninstalled'){
    await patchClientFields(env, c.Id, {shopify_shop_domain:'', shopify_access_token:'', shopify_connected_at:''});
  }
  return json({ok:true});
}

// Cron-swept abandoned-cart nudge (see wrangler.toml's second, more frequent cron entry) —
// replaces the n8n followup-template.json pattern for Shopify carts specifically.
async function sweepAbandonedShopifyCheckouts(env){
  const nudgeAfterMs=Date.now()-60*60*1000; // wait 60 min after abandonment before nudging
  const staleBeforeMs=Date.now()-48*60*60*1000; // ignore anything older than 48h
  // Every qualifying row gets nudge_sent flipped to 'Yes' before the next fetch, which is what
  // keeps this at offset 0 instead of paginating — the matching set shrinks under the same
  // filter as rows are processed, so a fixed offset would silently skip rows (see NocoDB's
  // offset pagination + concurrent-mutation interaction). A hard iteration cap just guards
  // against ever looping forever if a row's mutation doesn't stick for some reason.
  for(let i=0;i<50;i++){
    const r=await ncFetch(env, `api/v2/tables/${SHOPIFY_CHECKOUTS_TABLE}/records?where=(completed,eq,No)~and(nudge_sent,eq,No)&limit=100`);
    if(!r.ok) break;
    const data=await r.json().catch(()=>({}));
    const rows=data?.list||[];
    if(!rows.length) break;
    for(const row of rows){
      const createdMs=new Date(row.created_at).getTime();
      if(!createdMs || createdMs>nudgeAfterMs || createdMs<staleBeforeMs || !row.phone){
        // Not eligible yet (too new) or too stale to bother — mark 'nudge_sent' anyway only for
        // the stale case, so it stops being re-fetched every sweep; too-new rows are left alone
        // to be picked up once they cross the 60-minute mark.
        if(createdMs && createdMs<staleBeforeMs) await ncFetch(env, `api/v2/tables/${SHOPIFY_CHECKOUTS_TABLE}/records`, {method:'PATCH', body:{Id:row.Id, nudge_sent:'Yes'}});
        continue;
      }
      try{
        const c=await getClientById(env, row.client_id);
        if(c) await sendShopifyNotification(env, c, 'abandoned', {
          customer_name:row.customer_name||'', items:row.cart_summary||'', total:row.total||'',
          checkout_url:row.recovery_url||'', store_name:c.client_name||''
        }, {phone:row.phone, order:row.checkout_token});
      }catch(e){ console.error('[shopify] abandoned nudge failed for checkout', row.Id, e.message); }
      await ncFetch(env, `api/v2/tables/${SHOPIFY_CHECKOUTS_TABLE}/records`, {method:'PATCH', body:{Id:row.Id, nudge_sent:'Yes'}});
    }
    if(rows.length<100) break;
  }
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

// Feeds dashboard.html's own plan-picker UI (replaces the Stripe-hosted Pricing Table so the
// Worker sees and controls the checkout call instead of the browser talking to Stripe directly).
// STRIPE_PLAN_PRICE_IDS may contain not-yet-created placeholder entries (e.g. "REPLACE_..." —
// see wrangler.toml) which are skipped here rather than surfaced as broken plan cards.
async function handleBillingPlans(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  if(!env.STRIPE_SECRET_KEY) return json({error:'Stripe is not configured on the server.'}, 500);
  const ids=(env.STRIPE_PLAN_PRICE_IDS||'').split(',').map(s=>s.trim()).filter(id=>id && !id.startsWith('REPLACE_'));
  const plans=[];
  for(const price_id of ids){
    const {ok, data}=await stripeFetch(env, 'GET', `prices/${price_id}`, {expand:['product']});
    if(!ok||!data?.id||data.active===false) continue;
    plans.push({
      price_id:data.id,
      name:data.nickname||data.product?.name||data.id,
      unit_amount:data.unit_amount,
      currency:data.currency,
      interval:data.recurring?.interval||'',
      interval_count:data.recurring?.interval_count||1
    });
  }
  return json({ok:true, plans});
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
    // {CHECKOUT_SESSION_ID} is a Stripe-substituted placeholder — it's what lets billingInit() in
    // dashboard.html call /billing/confirm-session with a real session_id on return, instead of
    // relying solely on the webhook (or the manual "Sync Subscription Now" button) to land in time.
    success_url:`${env.APP_BASE_URL}?billing=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:`${env.APP_BASE_URL}?billing=cancel`,
    metadata:{client_id:String(payload.cid)},
    subscription_data:{metadata:{client_id:String(payload.cid)}}
  });
  if(!ok||!data?.url) return json({error:'Failed to start checkout: '+(data?.error?.message||'unknown error')}, 502);
  return json({ok:true, url:data.url});
}

// Shared by the customer's own "Manage Billing" button and the admin's "Open Stripe Portal" —
// the only difference is which clientId the caller is allowed to act on.
async function runBillingPortalLink(env, clientId){
  const c=await getClientById(env, clientId);
  if(!c?.stripe_customer_id) return json({error:'No billing account yet for this client.'}, 400);
  const {ok, data}=await stripeFetch(env, 'POST', 'billing_portal/sessions', {customer:c.stripe_customer_id, return_url:env.APP_BASE_URL});
  if(!ok||!data?.url) return json({error:'Failed to open billing portal: '+(data?.error?.message||'unknown error')}, 502);
  return json({ok:true, url:data.url});
}
async function handleBillingPortal(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  if(!env.STRIPE_SECRET_KEY) return json({error:'Stripe is not configured on the server.'}, 500);
  return runBillingPortalLink(env, payload.cid);
}
async function handleAdminBillingPortalLink(request, env){
  if(!await requireAdminSession(request, env)) return json({error:'Invalid or expired admin session'}, 401);
  if(!env.STRIPE_SECRET_KEY) return json({error:'Stripe is not configured on the server.'}, 500);
  const {client_id}=await request.json().catch(()=>({}));
  if(!client_id) return json({error:'client_id required'}, 400);
  return runBillingPortalLink(env, client_id);
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

// Shared by the customer's own "Sync Subscription Now" button and the admin's per-client
// "Refresh from Stripe" — the only difference is which clientId the caller is allowed to act on.
async function runBillingSync(env, clientId){
  const c=await getClientById(env, clientId);
  if(!c) return json({error:'Client not found'}, 404);

  let customerId=c.stripe_customer_id;
  if(!customerId){
    const emails=[c.authentik_email, ...(c.team_emails||'').split(',')].map(e=>e.trim()).filter(Boolean);
    for(const email of emails){
      const {ok, data}=await stripeFetch(env, 'GET', 'customers', {email, limit:5});
      if(ok && data?.data?.length){ customerId=data.data[0].id; break; }
    }
    if(!customerId) return json({error:'No Stripe customer found yet for this account\'s email(s). Make sure the checkout used one of them.'}, 404);
    await patchClientFields(env, clientId, {stripe_customer_id:customerId});
  }

  const {ok, data}=await stripeFetch(env, 'GET', 'subscriptions', {customer:customerId, status:'all', limit:1});
  if(!ok||!data?.data?.length) return json({error:'No subscription found yet for this Stripe customer.'}, 404);
  await syncSubscriptionFields(env, clientId, data.data[0]);
  return json({ok:true, plan_status:data.data[0].status});
}
async function handleBillingSyncNow(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  if(!env.STRIPE_SECRET_KEY) return json({error:'Stripe is not configured on the server.'}, 500);
  return runBillingSync(env, payload.cid);
}
async function handleAdminBillingRefresh(request, env){
  if(!await requireAdminSession(request, env)) return json({error:'Invalid or expired admin session'}, 401);
  if(!env.STRIPE_SECRET_KEY) return json({error:'Stripe is not configured on the server.'}, 500);
  const {client_id}=await request.json().catch(()=>({}));
  if(!client_id) return json({error:'client_id required'}, 400);
  return runBillingSync(env, client_id);
}

// Admin-only: resets a client's billing cycle to start now instead of waiting for the current
// period to end. Stripe's Subscription Update only accepts 'now'/'unchanged' here (not an
// arbitrary date) — an exact custom renewal date would need a Subscription Schedule instead.
// prorate controls whether the customer is charged/credited for the shortened/lengthened period.
async function handleAdminBillingResetAnchor(request, env){
  if(!await requireAdminSession(request, env)) return json({error:'Invalid or expired admin session'}, 401);
  if(!env.STRIPE_SECRET_KEY) return json({error:'Stripe is not configured on the server.'}, 500);
  const {client_id, prorate}=await request.json().catch(()=>({}));
  if(!client_id) return json({error:'client_id required'}, 400);
  const c=await getClientById(env, client_id);
  if(!c?.stripe_subscription_id) return json({error:'This client has no active subscription.'}, 400);

  const {ok, data}=await stripeFetch(env, 'POST', `subscriptions/${c.stripe_subscription_id}`, {
    billing_cycle_anchor:'now',
    proration_behavior: prorate?'create_prorations':'none'
  });
  if(!ok||!data?.id) return json({error:'Failed to reset billing cycle: '+(data?.error?.message||'unknown error')}, 502);
  await syncSubscriptionFields(env, client_id, data);
  return json({ok:true, plan_renews_at:data.items?.data?.[0]?.current_period_end||data.current_period_end});
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

// idempotencyKey is the Checkout Session id — Stripe redelivers webhooks on retry (e.g. a slow
// or briefly-failing response), and this event otherwise grants credits/enables the add-on again
// on replay. fulfilled_addon_events is a capped, comma-separated list of session ids already
// applied to this client, stored on the same row so the check-and-set stays a single NocoDB patch.
async function fulfillAddon(env, clientId, priceId, idempotencyKey){
  const c=await getClientById(env, clientId);
  if(!c) return;
  const applied=(c.fulfilled_addon_events||'').split(',').map(s=>s.trim()).filter(Boolean);
  if(idempotencyKey && applied.includes(idempotencyKey)) return;

  const {ok, data}=await stripeFetch(env, 'GET', `prices/${priceId}`, {expand:['product']});
  if(!ok) return;
  // Price metadata wins over Product metadata, so a one-off Price can override the Product default.
  const meta={...(data?.product?.metadata||{}), ...(data?.metadata||{})};
  const patch={};
  if(meta.fulfillment_type==='wa_credits'){
    const amount=Number(meta.wa_credits_amount||0);
    patch.wa_credits_balance=(Number(c.wa_credits_balance)||0)+amount;
  }else if(meta.fulfillment_type==='voice_addon'){
    patch.voice_addon_active='Yes';
  }else{
    return; // unrecognized fulfillment_type — nothing to apply, nothing to record
  }
  if(idempotencyKey) patch.fulfilled_addon_events=[...applied, idempotencyKey].slice(-20).join(',');
  await patchClientFields(env, clientId, patch);
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
    if(clientId && priceId) await fulfillAddon(env, clientId, priceId, obj.id);
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

/* ── ECOMMERCE (ecom.html) — the master NocoDB token used to live directly in
   ecom.html's JS, giving anyone who viewed page source full read/write access
   to every table in the base (not just ecom data — the whole clients table,
   leads, everything). ecom.html has no login/session of its own (just a
   client_id in the URL), so these endpoints can't check "is this really that
   client" the way session-based routes do — but they do confine every
   operation to (a) only the client's own configured products/orders table,
   (b) only rows whose client_id column matches, since that table is shared
   across all clients and rows are separated only by that column, and (c) only
   a small whitelist of non-secret client fields for the settings endpoints.
   That closes "read/write the entire database" down to "read/write one
   client's own ecom data" — full protection against someone else's client_id
   being guessed would need real per-client authentication, which ecom.html
   doesn't have today. ── */
// shopify_shop_domain/connected_at are read-only here — only the OAuth callback sets them.
// shopify_access_token is deliberately excluded (never reaches the browser).
const ECOM_CLIENT_READ_FIELDS=['Id','client_name','ecom_table_ids','ecom_products_sheet','ecom_orders_sheet','ecom_products_column_map','ecom_orders_column_map','review_link','ecom_wa_templates','shopify_shop_domain','shopify_connected_at','shopify_notify_config','shopify_notify_log'];
const ECOM_CLIENT_WRITE_FIELDS=['ecom_table_ids','ecom_products_sheet','ecom_orders_sheet','ecom_products_column_map','ecom_orders_column_map','review_link','ecom_wa_templates','shopify_notify_config'];

// Shared default tables used until a client explicitly saves their own table
// ID in Settings — mirrors ecom.html's client-side DEFAULT_ECOM_IDS fallback.
const ECOM_DEFAULT_TABLE_IDS={products:'mjlc2vi6iqbp87c', orders:'mjqaeatoe88gay6'};

async function ecomResolveTable(env, clientId, kind){
  const c=await getClientById(env, clientId);
  if(!c) return null;
  let ids={}; try{ ids=JSON.parse(c.ecom_table_ids||'{}'); }catch(e){}
  return ids[kind]||ECOM_DEFAULT_TABLE_IDS[kind]||null;
}

async function handleEcomClientGet(request, env){
  const url=new URL(request.url);
  const clientId=String(url.searchParams.get('client_id')||'');
  if(!clientId) return json({error:'client_id required'},400);
  const c=await getClientById(env, clientId);
  if(!c) return json({error:'Client not found'},404);
  const out={};
  ECOM_CLIENT_READ_FIELDS.forEach(k=>{ out[k]=c[k]; });
  return json(out);
}

async function handleEcomClientUpdate(request, env){
  const body=await request.json().catch(()=>({}));
  const clientId=String(body.client_id||'');
  if(!clientId) return json({error:'client_id required'},400);
  const fields={};
  ECOM_CLIENT_WRITE_FIELDS.forEach(k=>{ if(k in body) fields[k]=body[k]; });
  if(!Object.keys(fields).length) return json({error:'No valid fields to update'},400);
  const r=await ncFetch(env, `api/v2/tables/${CLIENTS_TABLE}/records`, {method:'PATCH', body:{Id:Number(clientId), ...fields}});
  const data=await r.json().catch(()=>({}));
  return json(data, r.status);
}

// client_id-based like the rest of /ecom/* (see the comment on handleEcomList below) — ecom.html
// has no Authentik session of its own, so the Shopify Notifications page's template picker needs
// a route it can call directly instead of going through session-authed /wa/templates. Same Graph
// API call as handleWaTemplatesGet, just keyed by client_id instead of a session token, and with
// no n8n hop (unlike the existing "Order Delivery Notifications" section's loadWaTemplates()).
async function handleEcomWaTemplatesGet(request, env){
  const url=new URL(request.url);
  const clientId=String(url.searchParams.get('client_id')||'');
  if(!clientId) return json({error:'client_id required'},400);
  const c=await getClientById(env, clientId);
  if(!c?.waba_id||!c?.wa_token) return json({error:'WhatsApp Business Account ID / token not configured.'}, 400);
  const r=await fetch(`https://graph.facebook.com/v18.0/${c.waba_id}/message_templates?fields=name,status,language,category,components&limit=200`, {headers:{Authorization:`Bearer ${c.wa_token}`}});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) return json({error:data?.error?.message||'HTTP '+r.status}, 502);
  return json(data);
}

// Ready-made WhatsApp templates for the Shopify Notifications module's most common
// order-lifecycle events, so a client with no templates yet isn't stuck hand-writing one in Meta
// Business Manager before this module can send anything. `params` is the vars key for each
// {{n}} placeholder, in order — matches the `vars` object sendShopifyNotification already builds
// for each event (see handleShopifyWebhook), and becomes that event's saved `params` config
// directly, no manual mapping needed once Meta approves the template. UTILITY for genuine
// post-purchase confirmations (cheapest per-conversation pricing tier); `abandoned` is MARKETING
// since it's a re-engagement nudge, not a transactional confirmation — Meta's own category
// guidelines, and miscategorizing it risks template rejection.
const SHOPIFY_TEMPLATE_PRESETS={
  received:{
    name:'order_received_leadvyne', category:'UTILITY', language:'en_US',
    body:'Hi {{1}}, thanks for your order {{2}}! Total: {{3}}. Items: {{4}}. We will notify you when it ships.',
    params:['customer_name','order_number','total','items']
  },
  paid:{
    name:'order_payment_received_leadvyne', category:'UTILITY', language:'en_US',
    body:'Hi {{1}}, we have received your payment for order {{2}} ({{3}}). Thank you for your purchase!',
    params:['customer_name','order_number','total']
  },
  shipped:{
    name:'order_shipped_leadvyne', category:'UTILITY', language:'en_US',
    body:'Hi {{1}}, your order {{2}} has shipped! Tracking number: {{3}}. Track it here: {{4}}',
    params:['customer_name','order_number','tracking_number','tracking_url']
  },
  delivered:{
    name:'order_delivered_leadvyne', category:'UTILITY', language:'en_US',
    body:'Hi {{1}}, your order {{2}} has been delivered. We would love your feedback: {{3}}',
    params:['customer_name','order_number','review_link']
  },
  abandoned:{
    name:'cart_reminder_leadvyne', category:'MARKETING', language:'en_US',
    body:'Hi {{1}}, you left some items in your cart at {{2}}. Complete your order here: {{3}}',
    params:['customer_name','store_name','checkout_url']
  },
};
async function handleEcomWaTemplatesCreatePreset(request, env){
  const {client_id, kind}=await request.json().catch(()=>({}));
  if(!client_id||!kind) return json({error:'client_id and kind required'}, 400);
  const preset=SHOPIFY_TEMPLATE_PRESETS[kind];
  if(!preset) return json({error:'Unknown template kind'}, 400);
  const c=await getClientById(env, client_id);
  if(!c?.waba_id||!c?.wa_token) return json({error:'WhatsApp Business Account ID / token not configured.'}, 400);
  const r=await fetch(`https://graph.facebook.com/v18.0/${c.waba_id}/message_templates`, {
    method:'POST', headers:{Authorization:`Bearer ${c.wa_token}`, 'Content-Type':'application/json'},
    body:JSON.stringify({name:preset.name, category:preset.category, language:preset.language, components:[{type:'BODY', text:preset.body}]})
  });
  const data=await r.json().catch(()=>({}));
  if(!r.ok) return json({error:data?.error?.message||'HTTP '+r.status}, 502);
  return json({ok:true, name:preset.name, language:preset.language, params:preset.params, status:data?.status||'PENDING'});
}

// Sort is a small whitelist mapped to real NocoDB sort strings, not passed through raw — this
// endpoint has no session of its own (see ecomResolveTable's comment above), so an arbitrary
// caller-supplied sort field would be an unnecessary way to let a stranger probe column names.
const ECOM_SORT_MAP={
  price_asc:'price', price_desc:'-price',
  newest:'-CreatedAt', oldest:'CreatedAt',
  stock_desc:'-stock', name_asc:'name',
};
// Strips characters that have syntactic meaning in NocoDB's `where=(field,op,value)` filter DSL,
// so a color/size/category value can't break out of its own clause or inject another one.
function ecomSanitizeFilterValue(v){ return String(v).replace(/[(),~]/g,'').trim(); }

async function handleEcomList(request, env, kind){
  const url=new URL(request.url);
  const clientId=String(url.searchParams.get('client_id')||'');
  if(!clientId) return json({error:'client_id required'},400);
  const tableId=await ecomResolveTable(env, clientId, kind);
  if(!tableId) return json({list:[]});
  const limit=Math.min(parseInt(url.searchParams.get('limit')||'200',10)||200, 1000);

  const clauses=[`(client_id,eq,${clientId})`];
  if(kind==='products'){
    // Partial + case-insensitive by nature of `like` — color/category are shop-owner free text
    // ("Green" vs "green" vs "Bottle Green"), so an exact `eq` would miss real matches too often.
    const color=url.searchParams.get('color');
    const category=url.searchParams.get('category');
    // Size stays an exact match — S/M/L/XL (or numeric sizes) are short coded buckets, not prose,
    // and a `like` match on "S" would also match "M" via no value at all / partial noise.
    const size=url.searchParams.get('size');
    const minPrice=parseFloat(url.searchParams.get('min_price'));
    const maxPrice=parseFloat(url.searchParams.get('max_price'));
    const inStock=url.searchParams.get('in_stock')==='true';
    const includeInactive=url.searchParams.get('include_inactive')==='true';
    if(color) clauses.push(`(color,like,${ecomSanitizeFilterValue(color)})`);
    if(category) clauses.push(`(category,like,${ecomSanitizeFilterValue(category)})`);
    if(size) clauses.push(`(size,eq,${ecomSanitizeFilterValue(size)})`);
    if(!isNaN(minPrice)) clauses.push(`(price,gte,${minPrice})`);
    if(!isNaN(maxPrice)) clauses.push(`(price,lte,${maxPrice})`);
    if(inStock) clauses.push(`(stock,gt,0)`);
    if(!includeInactive) clauses.push(`(status,neq,inactive)`);
  }

  const qs=new URLSearchParams({where:clauses.join('~and'), limit:String(limit)});
  const sortParam=url.searchParams.get('sort')||'';
  if(sortParam){
    const sortVal=ECOM_SORT_MAP[sortParam];
    if(!sortVal) return json({error:`Invalid sort value. Use one of: ${Object.keys(ECOM_SORT_MAP).join(', ')}`},400);
    qs.set('sort', sortVal);
  }
  const r=await ncFetch(env, `api/v2/tables/${tableId}/records?${qs.toString()}`);
  const data=await r.json().catch(()=>({}));
  return json(data, r.status);
}

async function handleEcomCreate(request, env, kind){
  const body=await request.json().catch(()=>({}));
  const clientId=String(body.client_id||'');
  if(!clientId) return json({error:'client_id required'},400);
  const tableId=await ecomResolveTable(env, clientId, kind);
  if(!tableId) return json({error:kind+' table not configured for this client'},400);
  const { client_id, Id, ...fields }=body;
  const r=await ncFetch(env, `api/v2/tables/${tableId}/records`, {method:'POST', body:{...fields, client_id:clientId}});
  const data=await r.json().catch(()=>({}));
  return json(data, r.status);
}

async function handleEcomUpdate(request, env, kind){
  const body=await request.json().catch(()=>({}));
  const clientId=String(body.client_id||'');
  const id=parseInt(body.Id,10);
  if(!clientId||!id) return json({error:'client_id and Id required'},400);
  const tableId=await ecomResolveTable(env, clientId, kind);
  if(!tableId) return json({error:kind+' table not configured for this client'},400);
  const existingR=await ncFetch(env, `api/v2/tables/${tableId}/records/${id}`);
  const existing=await existingR.json().catch(()=>null);
  if(!existingR.ok || !existing || String(existing.client_id)!==clientId) return json({error:'Not found'},404);
  const { client_id, Id, ...fields }=body;
  const r=await ncFetch(env, `api/v2/tables/${tableId}/records`, {method:'PATCH', body:{Id:id, ...fields}});
  const data=await r.json().catch(()=>({}));
  return json(data, r.status);
}

async function handleEcomDelete(request, env, kind){
  const body=await request.json().catch(()=>({}));
  const clientId=String(body.client_id||'');
  const ids=(Array.isArray(body.ids)?body.ids:[body.Id]).map(v=>parseInt(v,10)).filter(Boolean);
  if(!clientId||!ids.length) return json({error:'client_id and ids required'},400);
  const tableId=await ecomResolveTable(env, clientId, kind);
  if(!tableId) return json({error:kind+' table not configured for this client'},400);
  // Confirm ownership of every requested Id in one query, then only delete that
  // verified subset — otherwise one client could delete another's row in this
  // shared table just by guessing its Id.
  const ownedR=await ncFetch(env, `api/v2/tables/${tableId}/records?where=(client_id,eq,${clientId})~and(Id,in,${ids.join(',')})&fields=Id&limit=1000`);
  const owned=await ownedR.json().catch(()=>({list:[]}));
  const ownedIds=(owned.list||[]).map(row=>row.Id);
  if(!ownedIds.length) return json({deleted:0, requested:ids.length});
  const CHUNK=40; // NocoDB rejects overly large bulk-delete arrays with a 422
  let deleted=0;
  for(let i=0;i<ownedIds.length;i+=CHUNK){
    const chunk=ownedIds.slice(i,i+CHUNK);
    const r=await ncFetch(env, `api/v2/tables/${tableId}/records`, {method:'DELETE', body:chunk.map(id=>({Id:id}))});
    if(r.ok) deleted+=chunk.length;
  }
  return json({deleted, requested:ids.length});
}

/* ── ECOMMERCE PUBLIC STOREFRONT (store.html, and onshope.com's onshope-store.html /
   onshope-home.html) — unlike every /ecom/* route above, these are meant to be opened directly
   by end customers (shared as a WhatsApp link), so they must not give a customer any of what a
   client's own staff can do in ecom.html. Three separate cuts enforce that: (1) GET only — no
   create/update/delete handler exists under this prefix at all, so there's no write path to
   wire up by mistake; (2) a fixed field whitelist on both the client record and each product
   row, so columns like NocoDB table ids, sheet URLs, cost price, Meta API tokens, or internal
   notes can never leak even though the underlying tables hold them; (3) no access to
   leads/orders/CRM tables whatsoever — this code path never touches them. Client/product lookup
   accepts either client_id (store.html) or client_slug (onshope.com, so its URLs don't reveal or
   let visitors enumerate other clients' numeric ids). Closing the last gap — someone guessing
   another client's slug or id — needs real per-client auth, which neither surface has today. ── */
const ECOM_PUBLIC_CLIENT_FIELDS=['Id','client_name','client_slug','review_link'];
const ECOM_PUBLIC_PRODUCT_FIELDS=['Id','name','sku','category','color','size','price','currency','stock','image_url'];
const ECOM_PUBLIC_MAX_LIMIT=60;
const ECOM_PUBLIC_STORES_MAX=200;

function ecomPublicPick(row, fields){
  const out={};
  fields.forEach(k=>{ out[k]=row[k]===undefined?null:row[k]; });
  return out;
}
// wa_display_phone (the real dialable number, saved when the client connects WhatsApp — see
// handleChannelsWhatsappConnect) is preferred; support_phone is a manually-entered fallback for
// clients who haven't connected the native WhatsApp Cloud API integration yet. Never expose
// wa_phone_id/wa_token themselves — those are Meta API credentials, not a dialable number.
function ecomPublicClientOut(row){
  return {...ecomPublicPick(row, ECOM_PUBLIC_CLIENT_FIELDS), whatsapp_phone: row.wa_display_phone||row.support_phone||null};
}

// Both public endpoints resolve a client by client_id (store.html, already shipped) or by
// client_slug (onshope.com's onshope-store.html) — same handler, same whitelist either way.
async function ecomPublicResolveClient(env, url){
  const clientId=String(url.searchParams.get('client_id')||'');
  if(clientId) return getClientById(env, clientId);
  const slug=String(url.searchParams.get('slug')||'');
  if(slug) return getClientBySlug(env, slug);
  return null;
}

async function handleEcomPublicClient(request, env){
  const url=new URL(request.url);
  const c=await ecomPublicResolveClient(env, url);
  if(!c) return json({error:'Store not found'},404);
  return json(ecomPublicClientOut(c));
}

async function handleEcomPublicProducts(request, env){
  const url=new URL(request.url);
  const c=await ecomPublicResolveClient(env, url);
  if(!c) return json({error:'Store not found'},404);
  const tableId=await ecomResolveTable(env, c.Id, 'products');
  if(!tableId) return json({list:[]});
  // Filtering/search is done client-side against this one fetch — capped well below the admin
  // endpoint's 1000 so this can't be used to scrape a large catalog quickly.
  const limit=Math.min(parseInt(url.searchParams.get('limit')||String(ECOM_PUBLIC_MAX_LIMIT),10)||ECOM_PUBLIC_MAX_LIMIT, ECOM_PUBLIC_MAX_LIMIT);
  const qs=new URLSearchParams({where:`(client_id,eq,${c.Id})~and(status,neq,inactive)`, limit:String(limit), sort:'-stock'});
  const r=await ncFetch(env, `api/v2/tables/${tableId}/records?${qs.toString()}`);
  const data=await r.json().catch(()=>({}));
  if(!r.ok) return json(data, r.status);
  const list=(data.list||[]).map(row=>ecomPublicPick(row, ECOM_PUBLIC_PRODUCT_FIELDS));
  return json({list});
}

// Directory/homepage listing for onshope.com — every client that has published a store (has a
// client_slug set) and has the ecommerce module on. Same whitelist discipline as the two
// handlers above; still no leads/orders/internal fields.
async function handleEcomPublicStores(request, env){
  const r=await ncFetch(env, `api/v2/tables/${CLIENTS_TABLE}/records?limit=${ECOM_PUBLIC_STORES_MAX}`);
  const data=await r.json().catch(()=>({}));
  if(!r.ok) return json(data, r.status);
  const stores=(data.list||[])
    .filter(c=>c.client_slug && c.industry==='ecommerce')
    .map(c=>({client_slug:c.client_slug, client_name:c.client_name||c.client_slug}));
  return json({list:stores});
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
      else if(url.pathname==='/team/create-user' && request.method==='POST'){ res=await handleTeamCreateUser(request, env); }
      else if(url.pathname.startsWith('/nocodb/')){ res=await handleNocodbPassthrough(request, env, url.pathname.slice('/nocodb/'.length)); }
      else if(url.pathname==='/chat/send' && request.method==='POST'){ res=await handleChatSend(request, env); }
      else if(url.pathname==='/quote/send' && request.method==='POST'){ res=await handleQuoteSend(request, env); }
      else if(url.pathname==='/wa/templates' && request.method==='GET'){ res=await handleWaTemplatesGet(request, env); }
      else if(url.pathname==='/wa/templates' && request.method==='POST'){ res=await handleWaTemplatesCreate(request, env); }
      else if(url.pathname==='/wa/send' && request.method==='POST'){ res=await handleWaSend(request, env); }
      else if(url.pathname==='/wa/send-template' && request.method==='POST'){ res=await handleWaSendTemplate(request, env); }
      else if(url.pathname==='/tasks/notify' && request.method==='POST'){ res=await handleTaskEmailNotify(request, env); }
      else if(url.pathname==='/email/client' && request.method==='POST'){ res=await handleEmailClientUpdate(request, env); }
      else if(url.pathname==='/email/status' && request.method==='GET'){ res=await handleEmailStatus(request, env); }
      else if(url.pathname==='/email/test' && request.method==='POST'){ res=await handleEmailTest(request, env); }
      else if(url.pathname==='/email/campaigns' && request.method==='GET'){ res=await handleEmailCampaignsList(request, env); }
      else if(url.pathname==='/email/campaigns' && request.method==='POST'){ res=await handleEmailCampaignCreate(request, env); }
      else if(url.pathname==='/email/campaigns' && request.method==='PATCH'){ res=await handleEmailCampaignUpdate(request, env); }
      else if(url.pathname==='/email/campaigns' && request.method==='DELETE'){ res=await handleEmailCampaignDelete(request, env); }
      else if(url.pathname==='/email/audience/preview' && request.method==='GET'){ res=await handleEmailAudiencePreview(request, env); }
      else if(url.pathname==='/email/campaigns/send-init' && request.method==='POST'){ res=await handleEmailCampaignSendInit(request, env); }
      else if(url.pathname==='/email/campaigns/send-one' && request.method==='POST'){ res=await handleEmailCampaignSendOne(request, env); }
      else if(url.pathname==='/email/unsubscribe' && request.method==='GET'){ res=await handleEmailUnsubscribe(request, env); }
      else if(url.pathname==='/meta/capi/lead-event' && request.method==='POST'){ res=await handleMetaCapiLeadEvent(request, env); }
      else if(url.pathname==='/meta/capi/config' && request.method==='POST'){ res=await handleMetaCapiConfigSet(request, env); }
      else if(url.pathname==='/meta/capi/status' && request.method==='GET'){ res=await handleMetaCapiStatus(request, env); }
      else if(url.pathname==='/health/run' && request.method==='POST'){ res=await handleHealthRun(request, env); }
      else if(url.pathname==='/ecom/client' && request.method==='GET'){ res=await handleEcomClientGet(request, env); }
      else if(url.pathname==='/ecom/client' && request.method==='PATCH'){ res=await handleEcomClientUpdate(request, env); }
      else if(url.pathname==='/ecom/products' && request.method==='GET'){ res=await handleEcomList(request, env, 'products'); }
      else if(url.pathname==='/ecom/products' && request.method==='POST'){ res=await handleEcomCreate(request, env, 'products'); }
      else if(url.pathname==='/ecom/products' && request.method==='PATCH'){ res=await handleEcomUpdate(request, env, 'products'); }
      else if(url.pathname==='/ecom/products' && request.method==='DELETE'){ res=await handleEcomDelete(request, env, 'products'); }
      else if(url.pathname==='/ecom/orders' && request.method==='GET'){ res=await handleEcomList(request, env, 'orders'); }
      else if(url.pathname==='/ecom/orders' && request.method==='POST'){ res=await handleEcomCreate(request, env, 'orders'); }
      else if(url.pathname==='/ecom/orders' && request.method==='PATCH'){ res=await handleEcomUpdate(request, env, 'orders'); }
      else if(url.pathname==='/ecom/orders' && request.method==='DELETE'){ res=await handleEcomDelete(request, env, 'orders'); }
      else if(url.pathname==='/ecom/public/client' && request.method==='GET'){ res=await handleEcomPublicClient(request, env); }
      else if(url.pathname==='/ecom/public/products' && request.method==='GET'){ res=await handleEcomPublicProducts(request, env); }
      else if(url.pathname==='/ecom/public/stores' && request.method==='GET'){ res=await handleEcomPublicStores(request, env); }
      else if(url.pathname==='/ecom/wa-templates' && request.method==='GET'){ res=await handleEcomWaTemplatesGet(request, env); }
      else if(url.pathname==='/ecom/wa-templates/create-preset' && request.method==='POST'){ res=await handleEcomWaTemplatesCreatePreset(request, env); }
      else if(url.pathname==='/ai/complete' && request.method==='POST'){ res=await handleAiComplete(request, env); }
      else if(url.pathname==='/broadcast/templates' && request.method==='GET'){ res=await handleBroadcastTemplatesGet(request, env); }
      else if(url.pathname==='/broadcast/templates' && request.method==='POST'){ res=await handleBroadcastTemplatesCreate(request, env); }
      else if(url.pathname==='/broadcast/templates/sync' && request.method==='POST'){ res=await handleBroadcastTemplatesSync(request, env); }
      else if(url.pathname==='/broadcast/send-dm' && request.method==='POST'){ res=await handleBroadcastSendDm(request, env); }
      else if(url.pathname==='/broadcast/send-template' && request.method==='POST'){ res=await handleBroadcastSendTemplate(request, env); }
      else if(url.pathname==='/broadcast/followup-send' && request.method==='POST'){ res=await handleBroadcastFollowupSend(request, env); }
      else if(url.pathname==='/channels/create-account' && request.method==='POST'){ res=await handleChannelsCreateAccount(request, env); }
      else if(url.pathname==='/channels/whatsapp/connect' && request.method==='POST'){ res=await handleChannelsWhatsappConnect(request, env); }
      else if(url.pathname==='/channels/inbox' && request.method==='POST'){ res=await handleChannelsInboxCreate(request, env); }
      else if(url.pathname==='/channels/status' && request.method==='GET'){ res=await handleChannelsStatus(request, env); }
      else if(url.pathname==='/channels/chatwoot-sso' && request.method==='GET'){ res=await handleChannelsChatwootSso(request, env); }
      else if(url.pathname==='/shopify/oauth/start' && request.method==='POST'){ res=await handleShopifyOauthStart(request, env); }
      else if(url.pathname==='/shopify/oauth/callback' && request.method==='GET'){ res=await handleShopifyOauthCallback(request, env); }
      else if(url.pathname==='/shopify/webhook' && request.method==='POST'){ res=await handleShopifyWebhook(request, env); }
      else if(url.pathname==='/shopify/disconnect' && request.method==='POST'){ res=await handleShopifyDisconnect(request, env); }
      else if(url.pathname==='/billing/plans' && request.method==='GET'){ res=await handleBillingPlans(request, env); }
      else if(url.pathname==='/billing/checkout-subscription' && request.method==='POST'){ res=await handleBillingCheckoutSubscription(request, env); }
      else if(url.pathname==='/billing/portal' && request.method==='GET'){ res=await handleBillingPortal(request, env); }
      else if(url.pathname==='/billing/confirm-session' && request.method==='GET'){ res=await handleBillingConfirmSession(request, env); }
      else if(url.pathname==='/billing/sync-now' && request.method==='GET'){ res=await handleBillingSyncNow(request, env); }
      else if(url.pathname==='/billing/checkout-addon' && request.method==='POST'){ res=await handleBillingCheckoutAddon(request, env); }
      else if(url.pathname==='/billing/webhook' && request.method==='POST'){ res=await handleBillingWebhook(request, env); }
      else if(url.pathname==='/billing/company-profile' && request.method==='POST'){ res=await handleBillingCompanyProfile(request, env); }
      else if(url.pathname==='/admin/login' && request.method==='POST'){ res=await handleAdminLogin(request, env); }
      else if(url.pathname.startsWith('/admin/nocodb/')){ res=await handleAdminNocodbPassthrough(request, env, url.pathname.slice('/admin/nocodb/'.length)); }
      else if(url.pathname==='/admin/clients-billing' && request.method==='GET'){ res=await handleAdminClientsBilling(request, env); }
      else if(url.pathname==='/admin/billing-refresh' && request.method==='POST'){ res=await handleAdminBillingRefresh(request, env); }
      else if(url.pathname==='/admin/billing-portal-link' && request.method==='POST'){ res=await handleAdminBillingPortalLink(request, env); }
      else if(url.pathname==='/admin/billing-reset-anchor' && request.method==='POST'){ res=await handleAdminBillingResetAnchor(request, env); }
      else{ res=json({error:'Not found'}, 404); }
    }catch(e){
      res=json({error:e.message||'Internal error'}, 500);
    }

    const headers=new Headers(res.headers);
    Object.entries(cors).forEach(([k,v])=>headers.set(k,v));
    return new Response(res.body, {status:res.status, headers});
  },

  // Cloudflare Cron Triggers — see wrangler.toml [triggers]. Two schedules share this one
  // entry point: the daily health check, and the more frequent Shopify abandoned-cart sweep.
  async scheduled(event, env, ctx){
    if(event.cron==='0 2 * * *') ctx.waitUntil(runDailyHealthCheckForAllClients(env));
    else ctx.waitUntil(sweepAbandonedShopifyCheckouts(env));
  }
};
