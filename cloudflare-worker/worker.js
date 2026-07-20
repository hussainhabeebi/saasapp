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
// Create this table once in NocoDB (fields: client_id, lead_id, type, title, brand,
// line_items_json, currency, subtotal, tax_pct, total, status, public_slug, view_count,
// last_viewed_at, accepted_at, created_at, expires_at, notes — see SETUP.md "B2B module"), then
// either set it as a Worker var/secret named B2B_DOCUMENTS_TABLE (Cloudflare dashboard → Settings
// → Variables and Secrets, or `wrangler secret put B2B_DOCUMENTS_TABLE`) — no redeploy needed —
// or paste its real id over the placeholder below and redeploy. b2bDocumentsTable(env) below
// prefers the env var when set, so either path works.
const B2B_DOCUMENTS_TABLE = 'REPLACE_B2B_DOCUMENTS_TABLE_ID';
function b2bDocumentsTable(env){ return env.B2B_DOCUMENTS_TABLE || B2B_DOCUMENTS_TABLE; }
// Create this table once in NocoDB (fields: client_id, lead_id, type, title, line_items_json,
// currency, subtotal, tax_pct, tax_amount, total, status, linked_doc_id, notes, erpnext_doctype,
// erpnext_doc_name, erpnext_sync_status, erpnext_sync_error, erpnext_synced_at, doc_created_at —
// named doc_created_at, not created_at, because newer NocoDB versions auto-add their own hidden
// system "Created At" field to every new table, which collides with a custom field of that same
// name — see SETUP.md "Accounting module"), then set it as ACCOUNTING_DOCUMENTS_TABLE the same
// way B2B_DOCUMENTS_TABLE above works (env var preferred, falls back to the placeholder below).
const ACCOUNTING_DOCUMENTS_TABLE = 'REPLACE_ACCOUNTING_DOCUMENTS_TABLE_ID';
function accountingDocumentsTable(env){ return env.ACCOUNTING_DOCUMENTS_TABLE || ACCOUNTING_DOCUMENTS_TABLE; }

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

/* ── Platform-level error monitoring — deliberately NOT client-facing (see clients' own
   slack_webhook_url, used by n8n/notifications.json for hot-lead/handover business alerts; this
   is a separate, operator-facing channel for "the platform itself is broken"). Both destinations
   are optional and independent — set either, both, or neither; every call site here is
   best-effort and never throws, so a broken alert channel can't itself take anything down.
   OPS_ALERT_WEBHOOK_URL: any URL accepting a JSON {text:"..."} POST (a Slack incoming webhook
   works as-is). OPS_ALERT_EMAIL: requires RESEND_API_KEY (already used elsewhere in this file,
   e.g. sendBillingEmail) to actually send. ── */
async function reportOpsError(env, context, error, extra){
  const detail=error?.stack||error?.message||String(error);
  const message=`Leadvyne platform error — ${context}${extra?` (${JSON.stringify(extra)})`:''}\n${detail}`;
  console.error(message);
  try{
    if(env.OPS_ALERT_WEBHOOK_URL){
      await fetch(env.OPS_ALERT_WEBHOOK_URL, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({text:message})});
    }
  }catch(e){}
  try{
    if(env.RESEND_API_KEY && env.OPS_ALERT_EMAIL){
      await fetch('https://api.resend.com/emails', {
        method:'POST', headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`, 'Content-Type':'application/json'},
        body:JSON.stringify({
          from:env.RESEND_FROM_EMAIL||'Leadvyne Tasks <tasks@leadvyne.com>', to:[env.OPS_ALERT_EMAIL],
          subject:`Leadvyne platform error — ${context}`, html:`<pre style="white-space:pre-wrap;font-family:monospace">${esc(message)}</pre>`
        })
      });
    }
  }catch(e){}
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
  const body=await request.json().catch(()=>({}));
  let access_token=body.access_token;
  // Login-flow fast path: the browser hands over the authorization `code` + PKCE `code_verifier`
  // directly instead of exchanging them for an access_token itself first. Doing the code→token
  // exchange here (still a public-client PKCE exchange — client_id/redirect_uri aren't secrets,
  // both already sit in dashboard.html's own CONFIG) collapses two sequential browser round trips
  // (browser→Authentik token endpoint, then browser→Worker) into one, and lets the Worker→
  // Authentik hops below run over Cloudflare's own network instead of the user's connection —
  // this is the "waiting on the login screen again" gap on a mobile full-page redirect back from
  // Authentik. `{access_token}` alone (the old shape) still works, used by autoProvisionAndLogin's
  // second call after a brand-new signup finishes onboarding.
  if(!access_token && body.code && body.code_verifier){
    const tr=await fetch(`${env.AUTHENTIK_BASE}/application/o/token/`, {
      method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({
        grant_type:'authorization_code', client_id:body.client_id||'', redirect_uri:body.redirect_uri||'',
        code:body.code, code_verifier:body.code_verifier
      })
    });
    const tok=await tr.json().catch(()=>({}));
    if(!tr.ok||!tok.access_token) return json({error:tok.error_description||'Login failed'}, 401);
    access_token=tok.access_token;
  }
  if(!access_token) return json({error:'access_token required'}, 400);
  const info=await fetch(`${env.AUTHENTIK_BASE}/application/o/userinfo/`, {headers:{Authorization:`Bearer ${access_token}`}});
  if(!info.ok) return json({error:'Invalid or expired Authentik session'}, 401);
  const claims=await info.json();
  const email=(claims.email||claims.preferred_username||'').toLowerCase();
  if(!email) return json({error:'Your Authentik account has no email set.'}, 400);
  const rec=await getClientByAuthentikEmail(env, email);
  if(!rec||!rec.Id){
    // Not an error condition by itself — this is also what a brand-new signup looks like on
    // first login. Return the verified email (and access_token, if this request arrived as a
    // code+verifier — autoProvisionAndLogin's follow-up call needs it) so the frontend can offer
    // to finish provisioning this account instead of just showing a dead-end error.
    return json({error:'no_account', email, access_token:body.code?access_token:undefined}, 403);
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

  // dashboard.html's Settings saves write most CLIENTS fields straight through this generic
  // passthrough (no dedicated handler per field). Any successful PATCH to the client's own row is
  // a cheap opportunity to double-check their primary Chatwoot webhook still points at
  // /engine/webhook — matters most right after WhatsApp gets connected during onboarding, since
  // chatwoot_inbox_id (required by engineSyncChatwootWebhook) or a legacy webhook_url can become
  // available/stale slightly out of order relative to other Settings saves. No-ops quickly if
  // already correct, so this is safe to run on every save rather than sniffing for one field.
  if(r.ok && method==='PATCH' && upstreamPath.startsWith(`api/v2/tables/${CLIENTS_TABLE}/records`) && body){
    try{
      const c=await getClientById(env, payload.cid);
      if(c) await engineSyncChatwootWebhook(env, c);
    }catch(e){}
  }

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
  // Meta rejects a non-string text.body with a cryptic JSON-schema error instead of a clear one —
  // catch it here so a caller that (accidentally) sends {"text":{"body":"..."}} instead of a plain
  // string gets a readable error, and unwrap that one common accidental shape rather than failing.
  const textBody=typeof text==='string'?text:(text&&typeof text==='object'&&typeof text.body==='string'?text.body:null);
  if(!textBody) return json({error:'text must be a non-empty string'}, 400);
  const c=await getClientById(env, payload.cid);
  if(!c?.wa_phone_id||!c?.wa_token) return json({error:'WhatsApp phone / token not configured.'}, 400);
  const r=await fetch(`https://graph.facebook.com/v18.0/${c.wa_phone_id}/messages`, {
    method:'POST', headers:{Authorization:`Bearer ${c.wa_token}`, 'Content-Type':'application/json'},
    body:JSON.stringify({messaging_product:'whatsapp', to:phone, type:'text', text:{body:textBody}})
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

// Builds the NocoDB where clause a {stage:[...], tags_any:[...]} segment_filter resolves to,
// scoped to one client's leads — shared by the Email Marketing module's campaigns and the
// Automations module's flow audiences below, since both use the exact same filter shape.
function leadsAudienceWhereClause(clientId, segmentFilter){
  const clauses=[`(ClientId,eq,${clientId})`];
  const f=segmentFilter||{};
  if(Array.isArray(f.stage)&&f.stage.length){
    clauses.push('('+f.stage.map(s=>`(Stage,eq,${emailSanitizeFilterValue(s)})`).join('~or')+')');
  }
  if(Array.isArray(f.tags_any)&&f.tags_any.length){
    clauses.push('('+f.tags_any.map(t=>`(Tags,like,${emailSanitizeFilterValue(t)})`).join('~or')+')');
  }
  return clauses.join('~and');
}

// Email sends narrow further: every campaign send is implicitly scoped to leads that (a) have an
// email address at all and (b) haven't opted out of email specifically.
function emailAudienceWhereClause(clientId, segmentFilter){
  return leadsAudienceWhereClause(clientId, segmentFilter)+'~and(Email,notblank)~and(EmailOptOut,neq,Yes)';
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

// One-off/rerunnable admin action — walks every CLIENTS row and calls engineSyncChatwootWebhook
// for any client with Chatwoot already connected, so engine_webhook_secret gets generated and the
// /engine/webhook registration happens without each client needing to individually re-save a
// Settings field first. Safe to run repeatedly: engineSyncChatwootWebhook is itself idempotent
// (no-ops if already correct) and untouched for clients with no Chatwoot connection yet or with
// engine_disabled='Yes'. Does NOT touch Chatwoot's separate Agent Bots feature (Settings → Bots) —
// only the inbox-level Webhooks API; a bot wired there still needs its Webhook URL fixed by hand.
async function handleAdminBackfillEngineWebhooks(request, env){
  if(!await requireAdminSession(request, env)) return json({error:'Invalid or expired admin session'}, 401);
  let page=1, processed=0, synced=0, skipped=0;
  const errors=[];
  while(true){
    const r=await ncFetch(env, `api/v2/tables/${CLIENTS_TABLE}/records?limit=200&offset=${(page-1)*200}`);
    if(!r.ok) break;
    const data=await r.json().catch(()=>({}));
    const rows=data?.list||[];
    if(!rows.length) break;
    for(const c of rows){
      processed++;
      if(!c.chatwoot_base||!c.chatwoot_account_id||!c.chatwoot_token||!c.chatwoot_inbox_id){ skipped++; continue; }
      try{
        await engineSyncChatwootWebhook(env, c);
        synced++;
      }catch(e){ errors.push({client_id:c.Id, client_name:c.client_name||'', error:e.message}); }
    }
    if(rows.length<200) break;
    page++;
  }
  return json({ok:true, processed, synced, skipped, errors});
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

// Automation entry point for objection/trust-signal handling — meant to be called by the
// external n8n bot as ONE step inside its own reply flow (not an independent Chatwoot webhook
// listener), so n8n stays the single point of truth for what actually gets sent to the customer
// and there's no risk of two systems replying to the same message. Client_id-based like
// /ecom/order-link, since n8n has no Authentik session. Grounds its answer in the same
// business_policies/review_link data the dashboard's Trust Signals widget and Deal Coach already
// use — see SETUP.md's "Trust Signals & grounded objection-handling" section. Returns
// {handled:false} for anything that isn't an objection/trust question, so n8n's own flow can
// carry on normally — this never tries to handle a whole conversation turn, only this one
// narrow slice of it.
async function handleAiObjectionReply(request, env){
  const body=await request.json().catch(()=>({}));
  const clientId=String(body.client_id||'');
  const message=String(body.message||'').trim();
  if(!clientId||!message) return json({error:'client_id and message required'}, 400);
  const c=await getClientById(env, clientId);
  if(!c) return json({error:'Client not found'}, 404);
  if(!c.openrouter_key) return json({error:'No OpenRouter API key set for this account.'}, 400);

  let pol={}; try{ pol=JSON.parse(c.business_policies||'{}'); }catch(e){}
  const policyLines=[];
  if(pol.refund) policyLines.push(`Refund policy: ${pol.refund}`);
  if(pol.delivery) policyLines.push(`Delivery policy: ${pol.delivery}`);
  if(pol.cancellation) policyLines.push(`Cancellation policy: ${pol.cancellation}`);
  const reviewLink=c.review_link||'';

  const system=`You are screening one incoming WhatsApp message for a business named "${c.client_name||'this business'}" to decide if it raises an objection or trust concern (refund, delivery, cancellation, pricing doubt, "is this legit" etc.) that can be answered directly from the policies below. If it does, write a short, natural, on-brand WhatsApp reply that answers it directly using the real policy text — quote the actual terms, never invent anything not listed. You may mention the review link if it genuinely strengthens trust. If the message is NOT an objection/trust question (a normal question, a greeting, an order request with no objection, etc.), respond with exactly {"handled":false}. Respond with ONLY valid JSON: {"handled":true,"reply":"..."} or {"handled":false}.

${policyLines.length?policyLines.join('\n'):'No policies configured yet — if the message is an objection you can\'t ground in a real policy, respond {"handled":false} rather than inventing one.'}
${reviewLink?`Review link: ${reviewLink}`:''}`;

  const r=await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method:'POST',
    headers:{Authorization:`Bearer ${c.openrouter_key}`, 'Content-Type':'application/json'},
    body:JSON.stringify({
      model:c.model||'google/gemini-2.5-flash', temperature:0.3, max_tokens:250,
      messages:[{role:'system',content:system},{role:'user',content:message}]
    })
  });
  const data=await r.json().catch(()=>({}));
  if(!r.ok) return json({error:data?.error?.message||'HTTP '+r.status}, 502);
  const raw=data?.choices?.[0]?.message?.content?.trim()||'{"handled":false}';
  let parsed={handled:false};
  try{ parsed=JSON.parse(raw); }catch(e){}
  return json({handled:!!parsed.handled, reply:parsed.handled?String(parsed.reply||'').trim():undefined});
}

// Fetches the last few messages on a Chatwoot conversation, formatted as plain "Customer: .../
// Bot: ..." lines — used to resolve short replies that carry no signal on their own, like "Order
// m size" or "the 30 min one", back to whichever specific product/service was actually being
// discussed. Without this, a detector looking only at the single incoming message has no way to
// connect "M size" to a product name it was never told — exactly the gap that let a real customer
// reply "Order m size" to a shown product and get "we don't have anything matching" back instead
// of an order link, because the classifier had no idea a product had just been shown at all.
// Assumes Chatwoot's messages-list response is oldest-first (`payload`, ascending by created_at) —
// the standard REST-list convention, but unverified against a live payload from this specific
// Chatwoot instance/version, same honest caveat as elsewhere this repo parses Chatwoot's API shape.
async function fetchRecentChatwootContext(c, conversationId, limit){
  if(!c.chatwoot_base||!c.chatwoot_account_id||!c.chatwoot_token||!conversationId) return '';
  try{
    const r=await fetch(`${c.chatwoot_base}/api/v1/accounts/${c.chatwoot_account_id}/conversations/${conversationId}/messages`, {headers:{api_access_token:c.chatwoot_token}});
    if(!r.ok) return '';
    const data=await r.json().catch(()=>({}));
    const msgs=(data?.payload||[]).slice(-limit);
    return msgs.map(m=>`${m.message_type==='incoming'?'Customer':'Bot'}: ${String(m.content||'').slice(0,300)}`).join('\n');
  }catch(e){ return ''; }
}

// Core detection logic, shared by the HTTP endpoint below (handleAiOrderSignal, for n8n to call)
// and handleChatwootIncomingOrderSignal's own direct auto-send path (no n8n involved — see that
// function for why). A "signal" isn't just an explicit "I want to buy X" — a specific-variant
// question (size, color, stock, price of one item) is just as strong a buying signal for a
// physical-goods business, so those count too. `contextText` (recent conversation, see
// fetchRecentChatwootContext above) is optional but important: it's what lets a bare reply like
// "M size" resolve back to whichever product was actually just shown, instead of matching nothing.
// When the model can confidently match to one product, `sku` comes back too. Never sends anything
// — purely a screen.
async function detectOrderSignal(env, c, clientId, message, contextText){
  if(!c.openrouter_key) return {signal:false, error:'No OpenRouter API key set for this account.'};

  const productsTable=await ecomResolveTable(env, clientId, 'products');
  let productList='';
  if(productsTable){
    const pr=await ncFetch(env, `api/v2/tables/${productsTable}/records?where=(client_id,eq,${clientId})&limit=100&fields=name,sku,color,size,category`);
    const pd=await pr.json().catch(()=>({}));
    productList=(pd?.list||[]).map(p=>`- ${p.name}${p.sku?' [sku:'+p.sku+']':''}${p.color?' color:'+p.color:''}${p.size?' size:'+p.size:''}`).join('\n');
  }

  const system=`You are screening one incoming WhatsApp message for a business selling physical products. Classify it into exactly one of:
- "order": the customer clearly wants to buy/order right now — "order this", "I'll take it", "buy it", "yes place my order", "order pls", confirming they want to proceed after being shown a product.
- "enquiry": genuine interest in a specific product without yet committing to buy — a size/color/stock/price question about one item, "tell me more", "give me the details", "do you have it in red".
- neither (not a signal at all) — general browsing, greetings, or unrelated questions.
If "order" or "enquiry", try to match it to exactly one product from the catalog below.
- Match by reasonable everyday judgment, not exact string equality — a customer writes informally, the catalog doesn't. "Green shirt" should match a catalog color of "Light Green" or "Bottle Green"; "greenshirt" and "green shirt" are the same query; a size like "S"/"small"/"S size" are the same detail. Don't withhold sku just because the wording isn't identical to the catalog fields — withhold it only when you genuinely can't tell which product (or no product) is meant.
- A message with NO distinguishing detail of its own — "order it", "M size" alone, "that one", "yes please" — should be resolved using the recent conversation below, if given: it very likely refers to whichever product was just discussed.
- A message that names its own distinguishing detail (a color, size, or product name) should be matched against the catalog by that detail. If it's consistent with the product just discussed (e.g. "size M" right after that same shirt was shown), match to that one. If it conflicts with the product just discussed (e.g. "red shirt" right after a green shirt was shown), treat it as asking about a NEW product and match fresh by the new detail — don't keep reusing the old product's sku just because it was recently discussed. Only omit sku (or classify as neither, if it's clearly asking for something not carried at all) when the named detail truly doesn't correspond to anything in the catalog.
- Always also include product_name (the catalog product's plain name) whenever you include sku, or whenever you're confident which product is meant even if you're not 100% sure you copied the sku exactly right — copying a product's name correctly is much more reliable than copying an alphanumeric code, and product_name lets a name-based lookup succeed even if the sku string doesn't match exactly.
Respond with ONLY valid JSON: {"signal":true,"mode":"order","sku":"...","product_name":"..."} or {"signal":true,"mode":"enquiry","sku":"...","product_name":"..."} (sku/product_name omitted if no confident match) or {"signal":false}.
${contextText?`\nRecent conversation (oldest first — use this to resolve references back to a specific product):\n${contextText}\n`:''}
Product catalog:
${productList||'(no products listed)'}`;

  const r=await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method:'POST',
    headers:{Authorization:`Bearer ${c.openrouter_key}`, 'Content-Type':'application/json'},
    body:JSON.stringify({
      model:c.model||'google/gemini-2.5-flash', temperature:0.2, max_tokens:150,
      messages:[{role:'system',content:system},{role:'user',content:message}]
    })
  });
  const data=await r.json().catch(()=>({}));
  if(!r.ok) return {signal:false, error:data?.error?.message||'HTTP '+r.status};
  const raw=data?.choices?.[0]?.message?.content?.trim()||'{"signal":false}';
  let parsed={signal:false};
  try{ parsed=JSON.parse(raw); }catch(e){}
  const mode=parsed.mode==='order'?'order':'enquiry'; // defaults to the more conservative 'enquiry' (no link sent) if the model omits mode or returns something unrecognized
  return {
    signal:!!parsed.signal, mode,
    sku:parsed.signal?(parsed.sku||undefined):undefined,
    productName:parsed.signal?(parsed.product_name||undefined):undefined
  };
}

// Classifies one incoming message for order-readiness — same n8n-calls-Cloudflare shape as
// handleAiObjectionReply above (client_id-based, no session; n8n orchestrates, this only
// classifies). n8n should then call POST /ecom/order-link with the returned sku (and the
// customer's phone) to actually build+send+log the link; this endpoint only decides *whether* and
// *for what*, it never sends anything itself. Optional body.context lets n8n pass its own recent-
// conversation text if it has one handy; otherwise there's none here (n8n calls this standalone,
// with just the one message) — see detectOrderSignal's comment for why context matters.
async function handleAiOrderSignal(request, env){
  const body=await request.json().catch(()=>({}));
  const clientId=String(body.client_id||'');
  const message=String(body.message||'').trim();
  if(!clientId||!message) return json({error:'client_id and message required'}, 400);
  const c=await getClientById(env, clientId);
  if(!c) return json({error:'Client not found'}, 404);
  const result=await detectOrderSignal(env, c, clientId, message, String(body.context||''));
  if(result.error) return json({error:result.error}, result.error.startsWith('No OpenRouter')?400:502);
  return json({signal:result.signal, sku:result.sku});
}

// Booking-industry equivalent of handleAiOrderSignal above — same n8n-calls-Cloudflare shape
// (client_id-based, no session, pure detection, no side effects), but screens for booking
// readiness (wants to schedule/book, or asks about availability/duration/price of a specific
// service) instead of purchase readiness, and matches against the Appointment module's Services
// catalog (apptResolveTable(c,'services')) instead of an ecom product catalog — the two aren't the
// same table, so handleAiOrderSignal can't be reused as-is for a services business. Completes the
// same two-step pattern /ai/order-signal + /ecom/order-link already gives ecom clients: n8n calls
// this on incoming messages, and on signal:true calls POST /leads/booking-link (passing service_id
// if matched) to actually send the link — kept as two calls, not merged into one, so n8n stays in
// control of whether its own bot also replies to the same message (the same double-reply-risk
// reasoning that kept detection and action separate for /ai/order-signal).
// Core detection logic, shared by the HTTP endpoint below (handleAiBookingSignal, for n8n to call)
// and handleChatwootMessageHook's own direct auto-send path (no n8n involved at all — see that
// function for why). `contextText` (fetchRecentChatwootContext, above) resolves bare replies like
// "the 30 min one" back to whichever service was actually just discussed. Returns
// {signal, service_id?} — never sends anything, purely a screen.
async function detectBookingSignal(env, c, clientId, message, contextText){
  if(!c.openrouter_key) return {signal:false, error:'No OpenRouter API key set for this account.'};

  const servicesTable=apptResolveTable(c, 'services');
  let serviceList='';
  if(servicesTable){
    const sr=await ncFetch(env, `api/v2/tables/${servicesTable}/records?where=(client_id,eq,${clientId})~and(status,neq,inactive)&limit=100&fields=Id,name,duration_minutes,price,currency`);
    const sd=await sr.json().catch(()=>({}));
    serviceList=(sd?.list||[]).map(s=>`- ${s.name} [service_id:${s.Id}]${s.duration_minutes?' ('+s.duration_minutes+' min)':''}${s.price?' '+((s.currency||'')+' '+s.price):''}`).join('\n');
  }

  const system=`You are screening one incoming WhatsApp message for a services business (healthcare, consultancy, salon, etc), to decide if it's a booking-readiness signal — either an explicit request to book/schedule an appointment, OR a specific question about availability, duration, or price of one particular service that shows they're close to booking. General browsing questions, greetings, or unrelated questions are NOT signals.
If it is a signal, try to match it to exactly one service from the list below by name — include its service_id only if you're confident of the match, otherwise omit it (don't guess). A short reply like "the 30 min one" or "yes book it" with no service name still counts as a signal and should be matched using the recent conversation below, if given. Respond with ONLY valid JSON: {"signal":true,"service_id":"..."} or {"signal":true} (no confident match) or {"signal":false}.
${contextText?`\nRecent conversation (oldest first — use this to resolve references back to a specific service):\n${contextText}\n`:''}
Services offered:
${serviceList||'(no services listed)'}`;

  const r=await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method:'POST',
    headers:{Authorization:`Bearer ${c.openrouter_key}`, 'Content-Type':'application/json'},
    body:JSON.stringify({
      model:c.model||'google/gemini-2.5-flash', temperature:0.2, max_tokens:150,
      messages:[{role:'system',content:system},{role:'user',content:message}]
    })
  });
  const data=await r.json().catch(()=>({}));
  if(!r.ok) return {signal:false, error:data?.error?.message||'HTTP '+r.status};
  const raw=data?.choices?.[0]?.message?.content?.trim()||'{"signal":false}';
  let parsed={signal:false};
  try{ parsed=JSON.parse(raw); }catch(e){}
  return {signal:!!parsed.signal, service_id:parsed.signal?(parsed.service_id||undefined):undefined};
}

// Optional body.context lets n8n pass its own recent-conversation text if it has one handy — see
// detectBookingSignal's comment for why context matters for bare replies like "yes, the 30 min one".
async function handleAiBookingSignal(request, env){
  const body=await request.json().catch(()=>({}));
  const clientId=String(body.client_id||'');
  const message=String(body.message||'').trim();
  if(!clientId||!message) return json({error:'client_id and message required'}, 400);
  const c=await getClientById(env, clientId);
  if(!c) return json({error:'Client not found'}, 404);
  const result=await detectBookingSignal(env, c, clientId, message, String(body.context||''));
  if(result.error) return json({error:result.error}, result.error.startsWith('No OpenRouter')?400:502);
  return json({signal:result.signal, service_id:result.service_id});
}

// Plain lookup, no AI — "has this phone number ordered before, and what's the status" — so a
// returning customer ("where's my order?", "I already paid") gets recognized instead of the bot
// starting a fresh sales pitch. Cheap enough to call on every incoming message; n8n decides what
// to do with the result (reference the existing order, skip re-pushing an order link, etc.).
async function handleEcomOrderLookup(request, env){
  const url=new URL(request.url);
  const clientId=String(url.searchParams.get('client_id')||'');
  const phone=String(url.searchParams.get('phone')||'').replace(/[^0-9+]/g,'');
  if(!clientId||!phone) return json({error:'client_id and phone required'}, 400);
  const ordersTable=await ecomResolveTable(env, clientId, 'orders');
  if(!ordersTable) return json({found:false, orders:[]});
  const r=await ncFetch(env, `api/v2/tables/${ordersTable}/records?where=(client_id,eq,${clientId})~and(customer_phone,eq,${encodeURIComponent(phone)})&sort=-order_date&limit=5`);
  const data=await r.json().catch(()=>({}));
  const orders=(data?.list||[]).map(o=>({order_id:o.order_id, status:o.status, items:o.items, total:o.total, currency:o.currency, order_date:o.order_date}));
  return json({found:orders.length>0, orders});
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
  const clientId=String(payload.cid);

  // Voice Follow-ups (Settings → Voice) — same Sarvam pipeline as live voice-to-voice replies,
  // applied to this scheduled/manual send instead. Unlike engineDeliverReply's fire-and-forget
  // voice attempt, this is a rep clicking a button expecting real success/failure feedback in the
  // UI, so a failed voice send falls through to the normal text send below rather than silently
  // reporting success — same "customer never gets nothing" principle, but the rep still sees the
  // true outcome instead of it being swallowed into an ops-only alert.
  let sentViaVoice=false;
  if(c.voice_followup_enabled==='Yes'){
    const bcp47=ENGINE_TTS_LANG_MAP[(c.language||'en').toLowerCase()];
    if(bcp47){
      const audioBuf=await engineSarvamTts(env, text, bcp47);
      if(audioBuf){
        const vfd=new FormData();
        vfd.append('content', engineExtractLinkPriceCaption(text));
        vfd.append('message_type','outgoing'); vfd.append('private','false');
        vfd.append('attachments[]', new Blob([audioBuf], {type:'audio/ogg; codecs=opus'}), 'followup.ogg');
        const vr=await fetch(`${c.chatwoot_base}/api/v1/accounts/${c.chatwoot_account_id}/conversations/${convId}/messages`, {method:'POST', headers:{api_access_token:c.chatwoot_token}, body:vfd});
        sentViaVoice=vr.ok;
        if(!vr.ok) await reportOpsError(env, 'handleBroadcastFollowupSend — voice send failed, falling back to text', new Error('HTTP '+vr.status), {clientId, convId});
      }
    }
  }

  if(!sentViaVoice){
    const fd=new FormData();
    fd.append('content', text); fd.append('message_type','outgoing'); fd.append('private','false');
    const r=await fetch(`${c.chatwoot_base}/api/v1/accounts/${c.chatwoot_account_id}/conversations/${convId}/messages`, {method:'POST', headers:{api_access_token:c.chatwoot_token}, body:fd});
    if(!r.ok) return json({error:'HTTP '+r.status}, 502);
  }

  await ncFetch(env, `api/v2/tables/${DEFAULT_LEADS_TABLE}/records`, {method:'PATCH', body:{Id:Number(lead_id), ['Follow up '+(nextIdx+1)]:'Yes'}});
  return json({ok:true, stage:nextIdx+1, sentText:text, sentViaVoice});
}

/* ── Automations & Flow module (frontend/broadcast.html — "⚡ Automations" tab) ─────────────
   A standalone module inside the Campaigns/Broadcast page: build a small ordered "flow" of
   steps a lead walks through once enrolled, entered either automatically (new lead, stage
   change, gone quiet) or by picking a segment and enrolling it once. It's deliberately built by
   *reusing* the two sibling modules' own facilities rather than re-implementing sends:
     - WhatsApp steps use the exact same Chatwoot call shape as the Broadcast module's
       handleBroadcastSendDm/handleBroadcastSendTemplate above (and recovery.js's ladder).
     - Email steps reuse sendClientResendEmail (the Email Marketing module's Resend helper) and
       the same unsubscribe-link footer handleEmailCampaignSendOne sends.
     - Audience matching reuses leadsAudienceWhereClause — the Email module's own
       {stage:[...], tags_any:[...]} segment_filter shape, unchanged.
   Flow definitions live as one JSON field on the client row (automation_flows) — same
   config-blob-on-CLIENTS pattern as followup_messages/recovery_gaps_hours, since a client has a
   handful of flows, not thousands of rows needing their own table. Per-lead progress lives in
   one JSON field on the Leads table (flow_state), auto-created the first time the engine touches
   a client — the same ensureRecoveryFields()-at-runtime pattern recovery.js uses for its own
   recovery_* fields, just issued through this file's ncFetch/master-token helper instead of a
   raw per-client-token fetch.
   Execution is a Cron Trigger tick (runAutomationFlowsForAllClients, every 15 min — see
   wrangler.toml), not a browser send-loop like the Email/Broadcast modules use for one-shot
   blasts: a flow can contain multi-hour/day `wait` steps, and nothing guarantees the tab that
   built the flow stays open that long. Manual "enroll this segment now" is the one action that
   still comes from an explicit request rather than the tick, mirroring the Email module's
   send-init/send-one split (enroll now, sends still happen on the flow's own schedule). ── */

const AUTOMATION_STEP_TYPES = new Set(['wait','send_whatsapp_dm','send_whatsapp_template','send_email','update_field']);
const AUTOMATION_TRIGGER_TYPES = new Set(['manual','new_lead','stage_enter','no_reply']);
// Same closed-out stages recovery.js already refuses to touch — a flow (especially a broad
// "no reply in N hours" one) shouldn't keep nudging a lead that's Converted/Lost/Closed/opted out.
const AUTOMATION_TERMINAL_STAGES = new Set(['Converted','Lost','Closed','Opt Out']);

function validateAutomationFlow(body){
  const name=String(body?.name||'').trim();
  if(!name) return 'name required';
  const trigger=body?.trigger||{};
  if(!AUTOMATION_TRIGGER_TYPES.has(trigger.type)) return 'invalid trigger.type';
  if(trigger.type==='no_reply' && !(parseFloat(trigger.no_reply_hours)>0)) return 'no_reply trigger needs no_reply_hours > 0';
  if(trigger.type==='stage_enter' && !(Array.isArray(body?.segment?.stage)&&body.segment.stage.length)) return 'a stage-enter trigger needs at least one Stage selected';
  const steps=Array.isArray(body?.steps)?body.steps:[];
  if(!steps.length) return 'at least one step required';
  for(const s of steps){
    if(!AUTOMATION_STEP_TYPES.has(s?.type)) return 'invalid step type: '+s?.type;
    if(s.type==='wait' && !(parseFloat(s.hours)>0)) return 'a Wait step needs hours > 0';
    if(s.type==='send_whatsapp_dm' && !String(s.message||'').trim()) return 'a Send WhatsApp DM step needs a message';
    if(s.type==='send_whatsapp_template' && !String(s.template_name||'').trim()) return 'a Send WhatsApp Template step needs a template_name';
    if(s.type==='send_email' && (!String(s.subject||'').trim()||!String(s.html_body||'').trim())) return 'a Send Email step needs a subject and html_body';
    if(s.type==='update_field' && !String(s.field||'').trim()) return 'an Update Field step needs a field name';
  }
  return null;
}

async function getAutomationFlows(env, clientId){
  const c=await getClientById(env, clientId);
  let list=[]; try{ list=JSON.parse(c?.automation_flows||'[]'); }catch(e){}
  return {client:c, list};
}
async function saveAutomationFlows(env, clientId, list){
  await patchClientFields(env, clientId, {automation_flows:JSON.stringify(list)});
}

async function handleAutomationFlowsList(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const {list}=await getAutomationFlows(env, payload.cid);
  return json({list});
}

async function handleAutomationFlowCreate(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const body=await request.json().catch(()=>({}));
  const err=validateAutomationFlow(body);
  if(err) return json({error:err}, 400);
  const {list}=await getAutomationFlows(env, payload.cid);
  const flow={
    id:'fl_'+Date.now().toString(36)+Math.random().toString(36).slice(2,8),
    name:String(body.name).trim(),
    active:false,
    trigger:{type:body.trigger.type, no_reply_hours:parseFloat(body.trigger.no_reply_hours)||null},
    segment:{stage:Array.isArray(body.segment?.stage)?body.segment.stage:[], tags_any:Array.isArray(body.segment?.tags_any)?body.segment.tags_any:[]},
    steps:body.steps,
    stats:{enrolled:0, completed:0},
    created_at:new Date().toISOString(),
  };
  list.push(flow);
  await saveAutomationFlows(env, payload.cid, list);
  return json({ok:true, flow});
}

async function handleAutomationFlowUpdate(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const body=await request.json().catch(()=>({}));
  if(!body.id) return json({error:'id required'}, 400);
  const {list}=await getAutomationFlows(env, payload.cid);
  const idx=list.findIndex(f=>f.id===body.id);
  if(idx===-1) return json({error:'Flow not found'}, 404);
  // Flipping just `active` (pause/resume) skips re-validation — the steps were already valid
  // the last time they were saved. Anything touching name/trigger/segment/steps re-validates
  // the full merged shape before persisting.
  const touchesShape=['name','trigger','segment','steps'].some(k=>k in body);
  if(touchesShape){
    const merged={...list[idx], name:body.name??list[idx].name, trigger:body.trigger??list[idx].trigger, segment:body.segment??list[idx].segment, steps:body.steps??list[idx].steps};
    const err=validateAutomationFlow(merged);
    if(err) return json({error:err}, 400);
    list[idx]={...list[idx], name:merged.name, trigger:merged.trigger, segment:merged.segment, steps:merged.steps};
  }
  if('active' in body) list[idx].active=!!body.active;
  await saveAutomationFlows(env, payload.cid, list);
  return json({ok:true, flow:list[idx]});
}

async function handleAutomationFlowDelete(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const body=await request.json().catch(()=>({}));
  if(!body.id) return json({error:'id required'}, 400);
  const {list}=await getAutomationFlows(env, payload.cid);
  const next=list.filter(f=>f.id!==body.id);
  if(next.length===list.length) return json({error:'Flow not found'}, 404);
  await saveAutomationFlows(env, payload.cid, next);
  return json({ok:true});
}

async function handleAutomationAudiencePreview(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const url=new URL(request.url);
  let segmentFilter={}; try{ segmentFilter=JSON.parse(url.searchParams.get('segment_filter')||'{}'); }catch(e){}
  const where=leadsAudienceWhereClause(payload.cid, segmentFilter);
  const r=await ncFetch(env, `api/v2/tables/${DEFAULT_LEADS_TABLE}/records?where=${encodeURIComponent(where)}&limit=5&fields=Id,Name,Phone`);
  const data=await r.json().catch(()=>({}));
  if(!r.ok) return json(data, r.status);
  return json({count:data?.pageInfo?.totalRows??(data.list||[]).length, sample:(data.list||[]).slice(0,5)});
}

// Auto-creates the flow_state field the first time any client's flow engine touches the Leads
// table — mirrors recovery.js's ensureRecoveryFields, just routed through this file's own
// ncFetch/master-token helper instead of a raw per-client-token fetch. Memoized per Worker
// isolate (best-effort — a cold start just re-checks once, no correctness impact either way).
let _flowStateFieldEnsured=false;
async function ensureFlowStateField(env){
  if(_flowStateFieldEnsured) return;
  try{
    const existingR=await ncFetch(env, `api/v2/meta/tables/${DEFAULT_LEADS_TABLE}/fields`);
    const existing=await existingR.json().catch(()=>({}));
    const names=new Set((existing.list||[]).map(f=>f.title));
    if(!names.has('flow_state')){
      await ncFetch(env, `api/v2/meta/tables/${DEFAULT_LEADS_TABLE}/fields`, {method:'POST', body:{title:'flow_state', uidt:'LongText'}});
    }
    _flowStateFieldEnsured=true;
  }catch(e){ console.error('[automations] ensureFlowStateField failed', e.message); }
}

function parseFlowState(lead){ try{ return JSON.parse(lead.flow_state||'{}'); }catch(e){ return {}; } }
function flowLeadConvId(lead){ return lead.ConversationID||lead.conv_id||lead.ConversationId||lead.chatwoot_conv_id||null; }
function fillFlowTokens(text, lead){
  return String(text||'').replace(/\{name\}/gi, lead.Name||'there').replace(/\{stage\}/gi, lead.Stage||'').replace(/\{phone\}/gi, lead.Phone||'');
}

// Manual "Enroll matching leads now" — the one enrollment path triggered by an explicit request
// instead of the cron tick (same split as the Email module's send-init vs. its own cron-free
// send-one loop). Leads already enrolled (active or done) in this flow are left alone.
async function handleAutomationFlowEnroll(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const body=await request.json().catch(()=>({}));
  if(!body.id) return json({error:'id required'}, 400);
  const {list}=await getAutomationFlows(env, payload.cid);
  const flow=list.find(f=>f.id===body.id);
  if(!flow) return json({error:'Flow not found'}, 404);
  await ensureFlowStateField(env);

  const where=leadsAudienceWhereClause(payload.cid, flow.segment);
  let enrolled=0, page=1;
  while(true){
    const r=await ncFetch(env, `api/v2/tables/${DEFAULT_LEADS_TABLE}/records?where=${encodeURIComponent(where)}&limit=200&offset=${(page-1)*200}&fields=Id,flow_state,OptOut,Handover,Stage`);
    if(!r.ok) break;
    const data=await r.json().catch(()=>({}));
    const rows=data?.list||[];
    if(!rows.length) break;
    for(const lead of rows){
      if(lead.OptOut==='Yes'||lead.Handover==='Yes'||AUTOMATION_TERMINAL_STAGES.has(lead.Stage)) continue;
      const state=parseFlowState(lead);
      if(state[flow.id]) continue;
      state[flow.id]={step:0, next_at:new Date().toISOString(), enrolled_at:new Date().toISOString(), status:'active'};
      await ncFetch(env, `api/v2/tables/${DEFAULT_LEADS_TABLE}/records`, {method:'PATCH', body:{Id:lead.Id, flow_state:JSON.stringify(state)}});
      enrolled++;
    }
    if(rows.length<200) break;
    page++;
  }
  flow.stats=flow.stats||{enrolled:0,completed:0};
  flow.stats.enrolled=(flow.stats.enrolled||0)+enrolled;
  await saveAutomationFlows(env, payload.cid, list);
  return json({ok:true, enrolled});
}

// Same Chatwoot call shape as handleBroadcastSendDm above / recovery.js's sendPlainMessage.
async function sendFlowWhatsappDm(c, convId, content){
  const r=await fetch(`${c.chatwoot_base}/api/v1/accounts/${c.chatwoot_account_id}/conversations/${convId}/messages`, {
    method:'POST', headers:{api_access_token:c.chatwoot_token, 'Content-Type':'application/json'},
    body:JSON.stringify({content, message_type:'outgoing', private:false})
  });
  if(!r.ok) throw new Error('Chatwoot send failed: HTTP '+r.status);
}
// Same Chatwoot template shape as handleBroadcastSendTemplate above.
async function sendFlowWhatsappTemplate(c, convId, step, leadName){
  const r=await fetch(`${c.chatwoot_base}/api/v1/accounts/${c.chatwoot_account_id}/conversations/${convId}/messages`, {
    method:'POST', headers:{api_access_token:c.chatwoot_token, 'Content-Type':'application/json'},
    body:JSON.stringify({content:step.template_name, message_type:'outgoing', private:false, template_params:{
      name:step.template_name, category:step.category||'MARKETING', language:step.language||'en',
      processed_params:{1:leadName||'there'}
    }})
  });
  if(!r.ok) throw new Error('Chatwoot template send failed: HTTP '+r.status);
}
// Reuses sendClientResendEmail plus the same unsubscribe-link footer handleEmailCampaignSendOne
// sends — a flow's email step is just a one-recipient version of the same campaign send.
async function sendFlowEmail(env, c, lead, step){
  if(!lead.Email || lead.EmailOptOut==='Yes') return; // same channel-specific opt-out email campaigns respect
  const unsubToken=await hmacHex(env, `unsub:${lead.Id}`);
  const unsubLink=`${env.WORKER_BASE_URL}/email/unsubscribe?lead_id=${lead.Id}&token=${unsubToken}`;
  const html=`${step.html_body}<p style="font-size:11px;color:#888;margin-top:24px">Don't want these emails? <a href="${unsubLink}">Unsubscribe</a>.</p>`;
  const result=await sendClientResendEmail(c, {to:lead.Email, subject:step.subject, html});
  if(!result.ok) throw new Error(result.error||'Resend send failed');
}

// Runs every step starting at entry.step that doesn't need a wait, stopping at the next
// unexpired 'wait' (or the end of the flow). Mutates `entry` (step/next_at/status) in place —
// the caller persists lead.flow_state right after this returns.
async function advanceFlowLead(env, c, lead, flow, entry){
  while(entry.step<flow.steps.length){
    const step=flow.steps[entry.step];
    if(step.type==='wait'){
      entry.next_at=new Date(Date.now()+step.hours*3600000).toISOString();
      entry.step++;
      return {completed:false};
    }
    const convId=flowLeadConvId(lead);
    if(step.type==='send_whatsapp_dm'){
      if(convId && c.chatwoot_base && c.chatwoot_account_id && c.chatwoot_token) await sendFlowWhatsappDm(c, convId, fillFlowTokens(step.message, lead));
    }else if(step.type==='send_whatsapp_template'){
      if(convId && c.chatwoot_base && c.chatwoot_account_id && c.chatwoot_token) await sendFlowWhatsappTemplate(c, convId, step, lead.Name);
    }else if(step.type==='send_email'){
      await sendFlowEmail(env, c, lead, step);
    }else if(step.type==='update_field'){
      await ncFetch(env, `api/v2/tables/${DEFAULT_LEADS_TABLE}/records`, {method:'PATCH', body:{Id:lead.Id, [step.field]:step.value}});
    }
    entry.step++;
  }
  entry.status='done';
  entry.next_at=null;
  return {completed:true};
}

// Cron Trigger entry point (every 15 min — see wrangler.toml [triggers]). Loops every client
// with at least one active flow, same paginated-CLIENTS-scan shape as
// runDailyHealthCheckForAllClients above.
async function runAutomationFlowsForAllClients(env){
  let page=1;
  while(true){
    const r=await ncFetch(env, `api/v2/tables/${CLIENTS_TABLE}/records?limit=200&offset=${(page-1)*200}`);
    if(!r.ok) break;
    const data=await r.json().catch(()=>({}));
    const rows=data?.list||[];
    if(!rows.length) break;
    for(const c of rows){
      let flows=[]; try{ flows=JSON.parse(c.automation_flows||'[]'); }catch(e){}
      const activeFlows=flows.filter(f=>f.active);
      if(!activeFlows.length) continue;
      try{ await processClientAutomationFlows(env, c, flows, activeFlows); }
      catch(e){ console.error('[automations] tick failed for client', c.Id, e.message); }
    }
    if(rows.length<200) break;
    page++;
  }
}

async function processClientAutomationFlows(env, c, allFlows, activeFlows){
  if(!c.chatwoot_base && !c.resend_api_key) return; // nothing this client could actually send with
  await ensureFlowStateField(env);
  let flowsChanged=false;

  for(const flow of activeFlows){
    // ── Ongoing auto-enrollment (manual-trigger flows only enroll via handleAutomationFlowEnroll) ──
    if(flow.trigger.type==='new_lead' || flow.trigger.type==='stage_enter'){
      const where=leadsAudienceWhereClause(c.Id, flow.segment);
      const r=await ncFetch(env, `api/v2/tables/${DEFAULT_LEADS_TABLE}/records?where=${encodeURIComponent(where)}&limit=100&sort=-Date&fields=Id,flow_state,OptOut,Handover,Stage`);
      const data=await r.json().catch(()=>({}));
      for(const lead of (data?.list||[])){
        if(lead.OptOut==='Yes'||lead.Handover==='Yes'||AUTOMATION_TERMINAL_STAGES.has(lead.Stage)) continue;
        const state=parseFlowState(lead);
        if(state[flow.id]) continue;
        state[flow.id]={step:0, next_at:new Date().toISOString(), enrolled_at:new Date().toISOString(), status:'active'};
        await ncFetch(env, `api/v2/tables/${DEFAULT_LEADS_TABLE}/records`, {method:'PATCH', body:{Id:lead.Id, flow_state:JSON.stringify(state)}});
        flow.stats=flow.stats||{enrolled:0,completed:0}; flow.stats.enrolled++; flowsChanged=true;
      }
    }
    // "No reply in N hours" — same silence signal recovery.js's ladder already uses
    // (LastMsgAt), just enrolling into this flow's own steps instead of a hardcoded ladder.
    // Still honors the flow's own segment (e.g. restrict to certain Stages/tags) on top of that.
    if(flow.trigger.type==='no_reply'){
      const where=leadsAudienceWhereClause(c.Id, flow.segment)+'~and(LastMsgAt,notblank)';
      const r=await ncFetch(env, `api/v2/tables/${DEFAULT_LEADS_TABLE}/records?where=${encodeURIComponent(where)}&limit=200&fields=Id,flow_state,OptOut,Handover,Stage,LastMsgAt`);
      const data=await r.json().catch(()=>({}));
      const cutoffMs=Date.now()-flow.trigger.no_reply_hours*3600000;
      for(const lead of (data?.list||[])){
        if(lead.OptOut==='Yes'||lead.Handover==='Yes'||AUTOMATION_TERMINAL_STAGES.has(lead.Stage)) continue;
        if(new Date(lead.LastMsgAt).getTime()>cutoffMs) continue; // still within the reply window
        const state=parseFlowState(lead);
        if(state[flow.id]) continue;
        state[flow.id]={step:0, next_at:new Date().toISOString(), enrolled_at:new Date().toISOString(), status:'active'};
        await ncFetch(env, `api/v2/tables/${DEFAULT_LEADS_TABLE}/records`, {method:'PATCH', body:{Id:lead.Id, flow_state:JSON.stringify(state)}});
        flow.stats=flow.stats||{enrolled:0,completed:0}; flow.stats.enrolled++; flowsChanged=true;
      }
    }

    // ── Advance leads already enrolled and due ──
    // flow_state is a LongText JSON blob, so it can't be filtered "due now" server-side — narrow
    // with a cheap `like` on the flow id (present as a JSON object key), then check next_at
    // precisely in memory. Same trade-off recovery.js accepts for its own ladder fields.
    const dueWhere=`(ClientId,eq,${c.Id})~and(flow_state,like,%22${flow.id}%22)`;
    let page=1;
    while(true){
      const r=await ncFetch(env, `api/v2/tables/${DEFAULT_LEADS_TABLE}/records?where=${encodeURIComponent(dueWhere)}&limit=100&offset=${(page-1)*100}`);
      if(!r.ok) break;
      const data=await r.json().catch(()=>({}));
      const rows=data?.list||[];
      if(!rows.length) break;
      for(const lead of rows){
        const state=parseFlowState(lead);
        const entry=state[flow.id];
        if(!entry || entry.status!=='active') continue;
        if(lead.OptOut==='Yes'||lead.Handover==='Yes'||AUTOMATION_TERMINAL_STAGES.has(lead.Stage)){
          entry.status='exited';
          await ncFetch(env, `api/v2/tables/${DEFAULT_LEADS_TABLE}/records`, {method:'PATCH', body:{Id:lead.Id, flow_state:JSON.stringify(state)}});
          continue;
        }
        if(new Date(entry.next_at).getTime()>Date.now()) continue; // not due yet

        try{
          const advanced=await advanceFlowLead(env, c, lead, flow, entry);
          if(advanced.completed){ flow.stats=flow.stats||{enrolled:0,completed:0}; flow.stats.completed++; flowsChanged=true; }
          await ncFetch(env, `api/v2/tables/${DEFAULT_LEADS_TABLE}/records`, {method:'PATCH', body:{Id:lead.Id, flow_state:JSON.stringify(state)}});
        }catch(e){ console.error('[automations] step failed for lead', lead.Id, 'flow', flow.id, e.message); }
        await new Promise(res=>setTimeout(res, 300)); // pacing, same spirit as recovery.js's SEND_DELAY_MS
      }
      if(rows.length<100) break;
      page++;
    }
  }

  if(flowsChanged){
    try{ await patchClientFields(env, c.Id, {automation_flows:JSON.stringify(allFlows)}); }catch(e){}
  }
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

  // Best-effort — wires this Worker's /engine/webhook onto the new inbox (see
  // engineSyncChatwootWebhook) so no manual paste-in-Chatwoot step is needed, for every industry.
  // If this fails, it can still be added/fixed from Chatwoot's own UI, or re-synced later by
  // resaving any Settings field (handleNocodbPassthrough re-checks it on every CLIENTS PATCH).
  await engineSyncChatwootWebhook(env, {...c, chatwoot_inbox_id:String(inbox.id)});

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
  // Real connection state (same check renderChannelsStatus/hasAccount uses elsewhere) — distinct
  // from chatwoot_user_id below, which only exists for accounts this Worker itself provisioned
  // via handleChannelsCreateAccount's Platform API call. A client connected the older way
  // (Settings → Channels' manual base/account/inbox/token paste — still a fully working
  // connection, chats/sends work fine off chatwoot_token alone) has no chatwoot_user_id at all,
  // so it must not be treated as "not connected" just because SSO isn't available for it.
  if(!c?.chatwoot_account_id||!c?.chatwoot_base) return json({error:'Connect a Chatwoot account first.'}, 400);

  const requestedEmail=(new URL(request.url).searchParams.get('email')||'').trim().toLowerCase();
  let chatwootUserId=c?.chatwoot_user_id;
  if(requestedEmail && requestedEmail!==String(c?.authentik_email||'').toLowerCase()){
    let teamUsers={}; try{ teamUsers=JSON.parse(c?.team_chatwoot_users||'{}'); }catch(e){}
    const key=Object.keys(teamUsers).find(k=>k.toLowerCase()===requestedEmail);
    if(key) chatwootUserId=teamUsers[key];
  }
  // No Platform-API user on file for this identity — most likely a manually-connected account,
  // or a teammate added via "Add Existing Authentik User" (which never provisions a Chatwoot
  // agent). Can't mint a one-time SSO link without a Platform-API user id, so fall back to a
  // direct (not-pre-authenticated) link — still gets them to the right place, just requires
  // their own Chatwoot login, instead of a misleading "not connected" error.
  if(!chatwootUserId) return json({ok:true, sso:false, url:`${c.chatwoot_base}/app/accounts/${c.chatwoot_account_id}/dashboard`});

  const r=await chatwootPlatformFetch(env, `/platform/api/v1/users/${chatwootUserId}/login`);
  const data=await r.json().catch(()=>({}));
  if(!r.ok||!data?.url) return json({error:'Failed to generate a Chatwoot login link: '+(data?.message||('HTTP '+r.status))}, 502);
  return json({ok:true, sso:true, url:data.url});
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
// Every new plan subscription starts with a 15-day free trial before the first charge. Stripe
// owns the whole lifecycle from here — status starts 'trialing' (already synced into plan_status
// by syncSubscriptionFields), no charge happens until day 15, and Stripe fires
// customer.subscription.trial_will_end 3 days before that first charge, which doubles as the RBI
// pre-debit notice for it (see the trial_will_end handler in handleBillingWebhook below).
const TRIAL_PERIOD_DAYS = 15;

const EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Requires billing_email — deliberately no silent fallback to authentik_email (the login
// address, which is sometimes a shared/ops account rather than who should actually own the
// Stripe account/receive invoices). Callers (handleBillingCheckoutSubscription,
// handleBillingCheckoutAddon) check this up front and return a clean 400 before ever reaching
// here; the throw below is a safety net, not the primary guard.
async function ensureStripeCustomer(env, c, clientId){
  if(c.stripe_customer_id) return c.stripe_customer_id;
  if(!c.billing_email) throw new Error('A billing email is required before a Stripe account can be created.');
  const {ok, data}=await stripeFetch(env, 'POST', 'customers', {
    email:c.billing_email,
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
  const {client_name, company_address, billing_email}=await request.json().catch(()=>({}));
  if(!client_name) return json({error:'Company name is required.'}, 400);
  if(billing_email && !EMAIL_RE.test(billing_email)) return json({error:'That doesn\'t look like a valid email address.'}, 400);
  const c=await getClientById(env, payload.cid);
  if(!c) return json({error:'Client not found'}, 404);

  await patchClientFields(env, payload.cid, {client_name, company_address:company_address||'', billing_email:billing_email||''});

  // Best-effort — keeps Stripe's own invoices/receipts/pre-debit notices going to the right
  // name+address+email for customers who update this after they already have a Stripe Customer
  // record (ensureStripeCustomer above only sets email at creation time, not on every checkout).
  if(c.stripe_customer_id){
    await stripeFetch(env, 'POST', `customers/${c.stripe_customer_id}`, {
      name:client_name,
      address:company_address?{line1:company_address}:undefined,
      email:billing_email||undefined
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
  if(!c.billing_email) return json({error:'Set your Billing Email in Company Profile before subscribing.'}, 400);

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
    // client_reference_id is what the checkout.session.completed/expired handlers below key off
    // (also mirrored into metadata.client_id, which is what subscription_data.metadata carries
    // onto the Subscription itself once created).
    client_reference_id:String(payload.cid),
    metadata:{client_id:String(payload.cid)},
    subscription_data:{trial_period_days:TRIAL_PERIOD_DAYS, metadata:{client_id:String(payload.cid)}},
    // Lets a customer who abandons Checkout (e.g. drops off mid-3DS) resume from where they left
    // off via a link Stripe attaches to the expired Session — checkout.session.expired below emails
    // it. Confirmed supported for mode=subscription, not just one-time payments.
    after_expiration:{recovery:{enabled:true}}
  });
  if(!ok||!data?.url) return json({error:'Failed to start checkout: '+(data?.error?.message||'unknown error')}, 502);
  return json({ok:true, url:data.url});
}

// Also reused by the payment-failed/action-required billing emails below, which link straight to
// the Portal so a customer can fix their payment method without first finding the dashboard.
async function createBillingPortalSession(env, customerId){
  const {ok, data}=await stripeFetch(env, 'POST', 'billing_portal/sessions', {customer:customerId, return_url:env.APP_BASE_URL});
  return {ok:ok&&!!data?.url, url:data?.url, error:data?.error?.message};
}
// Shared by the customer's own "Manage Billing" button and the admin's "Open Stripe Portal" —
// the only difference is which clientId the caller is allowed to act on.
async function runBillingPortalLink(env, clientId){
  const c=await getClientById(env, clientId);
  if(!c?.stripe_customer_id) return json({error:'No billing account yet for this client.'}, 400);
  const {ok, url, error}=await createBillingPortalSession(env, c.stripe_customer_id);
  if(!ok) return json({error:'Failed to open billing portal: '+(error||'unknown error')}, 502);
  return json({ok:true, url});
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
  if(!c.billing_email) return json({error:'Set your Billing Email in Company Profile before buying an add-on.'}, 400);

  const customerId=await ensureStripeCustomer(env, c, payload.cid);
  const {ok, data}=await stripeFetch(env, 'POST', 'checkout/sessions', {
    mode:'payment',
    customer:customerId,
    line_items:[{price:price_id, quantity:1}],
    success_url:`${env.APP_BASE_URL}?billing=success`,
    cancel_url:`${env.APP_BASE_URL}?billing=cancel`,
    metadata:{client_id:String(payload.cid), price_id},
    after_expiration:{recovery:{enabled:true}}
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

/* ── Billing emails (Resend) ──────────────────────────────────────────────
   Branded receipts/dunning/trial-ending/auth-required notices, sent from the webhook handlers
   below. This is the practical RBI backup layer: Stripe's own e-mandate notification is the
   actual compliance mechanism (see SETUP.md "RBI pre-debit notification"), these are a second,
   Leadvyne-branded touchpoint plus an audit trail of what a customer was told and when — the
   n8n workflow that used to fill this role was deleted from the repo, so it now lives here
   instead of a separate system. Every send is best-effort: a Resend outage must never fail
   Stripe's webhook delivery (Stripe retries on non-2xx, which would just re-run fulfillment). ── */

// Invoice events carry the Stripe Customer id directly (unlike Subscription events, which prefer
// metadata.client_id) — straight lookup, no fallback chain needed.
async function resolveClientIdForCustomer(env, customerId){
  if(!customerId) return null;
  const c=await findClientByField(env, 'stripe_customer_id', customerId);
  return c?.Id||null;
}

// Stripe amounts are integers in the currency's smallest unit — both INR and AED (the only
// currencies this app bills in today) are 2-decimal, so this is a flat /100, not a
// zero-decimal-currency table.
function formatBillingAmount(amount, currency){
  const symbol={inr:'₹', aed:'AED '}[String(currency||'').toLowerCase()]||(String(currency||'').toUpperCase()+' ');
  return `${symbol}${(Number(amount||0)/100).toFixed(2)}`;
}
function formatBillingDate(unixSeconds){
  if(!unixSeconds) return '';
  return new Date(unixSeconds*1000).toLocaleDateString('en-IN', {day:'numeric', month:'short', year:'numeric'});
}

// Shared branded wrapper — one place to keep receipts, dunning notices, trial reminders and
// auth-required prompts visually consistent instead of ad hoc HTML per event.
function renderBillingEmailHtml({heading, bodyHtml, ctaLabel, ctaUrl}){
  const cta=ctaLabel&&ctaUrl?`<p style="margin:28px 0 0"><a href="${esc(ctaUrl)}" style="background:#4f46e5;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600;display:inline-block">${esc(ctaLabel)}</a></p>`:'';
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1f2937">
    <div style="padding:24px 0 8px;border-bottom:2px solid #4f46e5"><strong style="font-size:18px;color:#4f46e5">Leadvyne</strong></div>
    <div style="padding:28px 0">
      <h2 style="margin:0 0 16px;font-size:20px">${esc(heading)}</h2>
      ${bodyHtml}
      ${cta}
    </div>
    <div style="padding:16px 0;border-top:1px solid #e5e7eb;color:#6b7280;font-size:12px">
      Leadvyne — you're receiving this because of billing activity on your account. Manage your
      subscription any time from the Billing page in your dashboard.
    </div>
  </div>`;
}

// Reuses the same platform-level RESEND_API_KEY as /tasks/notify, but its own From address so
// billing mail is visually and domain-distinct from task nudges.
async function sendBillingEmail(env, {to, subject, heading, bodyHtml, ctaLabel, ctaUrl}){
  if(!env.RESEND_API_KEY||!to) return;
  const from=env.BILLING_FROM_EMAIL||'Leadvyne Billing <billing@leadvyne.com>';
  try{
    await fetch('https://api.resend.com/emails', {
      method:'POST', headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`, 'Content-Type':'application/json'},
      body:JSON.stringify({from, to:[to], subject, html:renderBillingEmailHtml({heading, bodyHtml, ctaLabel, ctaUrl})})
    });
  }catch(e){ console.error('sendBillingEmail failed', e); }
}

// Dedupe key is '<event>:<stripe_object_id>', stored in a capped comma-list on the CLIENTS row —
// same pattern as fulfilled_addon_events, so a redelivered webhook (Stripe retries on any non-2xx
// or timeout) never sends the same receipt/dunning/reminder email twice.
function billingEmailAlreadySent(c, key){
  return (c.billing_emails_sent||'').split(',').map(s=>s.trim()).includes(key);
}
async function markBillingEmailSent(env, clientId, c, key){
  const sent=(c.billing_emails_sent||'').split(',').map(s=>s.trim()).filter(Boolean);
  await patchClientFields(env, clientId, {billing_emails_sent:[...sent, key].slice(-20).join(',')});
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

  // Fires ~3 days before the trial converts to a paid subscription (Stripe's default lead time,
  // not configurable per-event) — this is the RBI pre-debit notice for that first charge, plus a
  // clear reminder that cancelling from the Portal (linked below) avoids the charge entirely.
  if(event.type==='customer.subscription.trial_will_end'){
    const clientId=await resolveClientIdForSubscription(env, obj);
    const c=clientId&&await getClientById(env, clientId);
    if(c?.billing_email||c?.authentik_email){
      const key=`trial_will_end:${obj.id}`;
      if(!billingEmailAlreadySent(c, key)){
        const item=obj.items?.data?.[0];
        const amount=formatBillingAmount(item?.price?.unit_amount, item?.price?.currency);
        const chargeDate=formatBillingDate(obj.trial_end);
        const {url:portalUrl}=obj.customer?await createBillingPortalSession(env, obj.customer):{};
        await sendBillingEmail(env, {
          to:c.billing_email||c.authentik_email,
          subject:'Your Leadvyne trial ends soon',
          heading:'Your free trial ends in a few days',
          bodyHtml:`<p>Your 15-day trial ends on <strong>${esc(chargeDate)}</strong>. After that, we'll
            automatically charge <strong>${esc(amount)}</strong> to your saved payment method to
            continue your subscription.</p><p>Nothing to do if you want to continue — if you'd
            rather cancel first, use the button below.</p>`,
          ctaLabel:'Manage subscription', ctaUrl:portalUrl
        });
        await markBillingEmailSent(env, clientId, c, key);
      }
    }
  }

  if(event.type==='invoice.payment_succeeded'){
    const clientId=await resolveClientIdForCustomer(env, obj.customer);
    const c=clientId&&await getClientById(env, clientId);
    if(c?.billing_email||c?.authentik_email){
      const key=`payment_succeeded:${obj.id}`;
      if(!billingEmailAlreadySent(c, key)){
        const amount=formatBillingAmount(obj.amount_paid, obj.currency);
        const nextRenewal=formatBillingDate(obj.lines?.data?.[0]?.period?.end);
        await sendBillingEmail(env, {
          to:c.billing_email||c.authentik_email,
          subject:`Payment received — ${amount}`,
          heading:'Payment received, thank you',
          bodyHtml:`<p>We've charged <strong>${esc(amount)}</strong> to your payment method
            for ${esc(obj.lines?.data?.[0]?.description||'your Leadvyne subscription')}.</p>
            ${nextRenewal?`<p>Your subscription renews next on <strong>${esc(nextRenewal)}</strong>.</p>`:''}`,
          ctaLabel:'View invoice', ctaUrl:obj.hosted_invoice_url
        });
        await markBillingEmailSent(env, clientId, c, key);
      }
    }
  }

  if(event.type==='invoice.payment_failed'){
    const clientId=await resolveClientIdForCustomer(env, obj.customer);
    const c=clientId&&await getClientById(env, clientId);
    if(c?.billing_email||c?.authentik_email){
      const key=`payment_failed:${obj.id}`;
      if(!billingEmailAlreadySent(c, key)){
        const amount=formatBillingAmount(obj.amount_due, obj.currency);
        const retryDate=formatBillingDate(obj.next_payment_attempt);
        const {url:portalUrl}=await createBillingPortalSession(env, obj.customer);
        await sendBillingEmail(env, {
          to:c.billing_email||c.authentik_email,
          subject:`Payment failed — action needed`,
          heading:'We couldn\'t process your payment',
          bodyHtml:`<p>A charge of <strong>${esc(amount)}</strong> for your Leadvyne subscription
            didn't go through.</p><p>${retryDate?`We'll automatically retry on <strong>${esc(retryDate)}</strong> — `:''}
            to avoid any interruption, please check your payment method is still valid.</p>`,
          ctaLabel:'Update payment method', ctaUrl:portalUrl||obj.hosted_invoice_url
        });
        await markBillingEmailSent(env, clientId, c, key);
      }
    }
  }

  // Fires when a charge needs Additional Factor Authentication (RBI's AFA requirement for
  // recurring debits above the auto-debit cap) — hosted_invoice_url is Stripe's own page for
  // completing that authentication, so this email is the actual unblock action, not just a notice.
  if(event.type==='invoice.payment_action_required'){
    const clientId=await resolveClientIdForCustomer(env, obj.customer);
    const c=clientId&&await getClientById(env, clientId);
    if(c?.billing_email||c?.authentik_email){
      const key=`payment_action_required:${obj.id}`;
      if(!billingEmailAlreadySent(c, key)){
        const amount=formatBillingAmount(obj.amount_due, obj.currency);
        await sendBillingEmail(env, {
          to:c.billing_email||c.authentik_email,
          subject:'Action needed to complete your payment',
          heading:'Your bank needs you to confirm this payment',
          bodyHtml:`<p>A charge of <strong>${esc(amount)}</strong> for your Leadvyne subscription
            needs one more step — your bank requires you to confirm it before it can go through.</p>`,
          ctaLabel:'Confirm payment', ctaUrl:obj.hosted_invoice_url
        });
        await markBillingEmailSent(env, clientId, c, key);
      }
    }
  }

  // Fires when a Checkout Session (subscription or add-on) expires without completing — e.g. the
  // customer dropped off mid-3DS challenge. after_expiration.recovery.url (set because both
  // checkout-creation routes pass after_expiration.recovery.enabled) resumes that exact session
  // rather than making them start over from the plan picker.
  if(event.type==='checkout.session.expired'){
    const clientId=obj.client_reference_id||obj.metadata?.client_id;
    const c=clientId&&await getClientById(env, clientId);
    const recoveryUrl=obj.after_expiration?.recovery?.url;
    if((c?.billing_email||c?.authentik_email)&&recoveryUrl){
      const key=`checkout_expired:${obj.id}`;
      if(!billingEmailAlreadySent(c, key)){
        await sendBillingEmail(env, {
          to:c.billing_email||c.authentik_email,
          subject:'You left something in checkout',
          heading:'Your checkout is still waiting for you',
          bodyHtml:`<p>You started ${obj.mode==='subscription'?'subscribing to a Leadvyne plan':'a Leadvyne add-on purchase'}
            but didn't finish — often this happens when a bank's OTP/authentication step times out.</p>
            <p>Pick up right where you left off, no need to start over.</p>`,
          ctaLabel:'Resume checkout', ctaUrl:recoveryUrl
        });
        await markBillingEmailSent(env, clientId, c, key);
      }
    }
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
const ECOM_CLIENT_READ_FIELDS=['Id','client_name','ecom_table_ids','ecom_products_sheet','ecom_orders_sheet','ecom_products_column_map','ecom_orders_column_map','review_link','ecom_wa_templates','shopify_shop_domain','shopify_connected_at','shopify_notify_config','shopify_notify_log','support_phone','wa_display_phone'];
const ECOM_CLIENT_WRITE_FIELDS=['ecom_table_ids','ecom_products_sheet','ecom_orders_sheet','ecom_products_column_map','ecom_orders_column_map','review_link','ecom_wa_templates','shopify_notify_config','support_phone'];

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

// Verifies a PATCH actually stuck before returning success, retrying through NocoDB's schema-
// cache lag right after a column was just created — the same root cause found (and fixed, in
// dashboard.html's patchClient) for Appointments/Travel Agency/Recruitment's setup flows. This
// route's own caller (ecom.html's patchClient) doesn't even check the HTTP response, let alone
// verify the field landed, so — unlike those three — a failure here has been silently invisible
// on both ends: ecom_table_ids could fail to save with literally no error anywhere, leaving
// ecomResolveTable() falling back to the shared default products table instead of this client's
// own, which reads as "the bot can't find a product that's clearly in the catalog" with no clue
// why. Fixing it here, server-side, covers ecom.html without needing a matching frontend change.
async function ncPatchVerified(env, clientId, fields){
  const MAX_ATTEMPTS=3;
  let lastResp=null;
  for(let attempt=1; attempt<=MAX_ATTEMPTS; attempt++){
    const r=await ncFetch(env, `api/v2/tables/${CLIENTS_TABLE}/records`, {method:'PATCH', body:{Id:Number(clientId), ...fields}});
    const data=await r.json().catch(()=>({}));
    if(!r.ok) return {ok:false, status:r.status, data};
    const fresh=await getClientById(env, clientId);
    const stuck=fresh?Object.keys(fields).filter(k=>String(fresh[k]??'')!==String(fields[k]??'')):Object.keys(fields);
    if(!stuck.length) return {ok:true, status:r.status, data};
    lastResp={ok:false, status:502, data:{error:`Save didn't take effect for: ${stuck.join(', ')} — check these columns exist in NocoDB (see SETUP.md)`}};
    if(attempt<MAX_ATTEMPTS) await new Promise(res=>setTimeout(res, 900*attempt));
  }
  return lastResp;
}

async function handleEcomClientUpdate(request, env){
  const body=await request.json().catch(()=>({}));
  const clientId=String(body.client_id||'');
  if(!clientId) return json({error:'client_id required'},400);
  const fields={};
  ECOM_CLIENT_WRITE_FIELDS.forEach(k=>{ if(k in body) fields[k]=body[k]; });
  if(!Object.keys(fields).length) return json({error:'No valid fields to update'},400);
  const result=await ncPatchVerified(env, clientId, fields);
  return json(result.data, result.status);
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

// Meta's Template Library — pre-vetted Utility templates that (per Meta's own docs) skip the
// review queue entirely, unlike SHOPIFY_TEMPLATE_PRESETS above which submits custom wording and
// waits hours for approval. `library_template_name` values below are confirmed real entries
// (screenshotted from WhatsApp Manager → Message templates → Create template → Browse the
// template library, Utility category) — Meta's library catalog is global, not per-WABA, so the
// same three names are reused for every client; no re-lookup needed per client or over time.
// No confirmed library equivalent exists for `delivered`/`abandoned` yet, so those still only
// have the from-scratch preset path above.
// Deliberately doesn't guess a `params` mapping the way SHOPIFY_TEMPLATE_PRESETS does — the
// library template's fixed wording ("Hi {{text}}, ... order number is {{text}} ...") has more
// than one same-typed placeholder per template with no documented way (found while building this)
// to confirm which slot means what without a live WABA to test against. So after creation this
// falls through to the exact same manual param-mapping UI (ecom.html's renderShopifyParamMap)
// already used for every other synced template — nothing new to build, and no risk of silently
// mismatching e.g. order number into the delivery-date slot.
const SHOPIFY_LIBRARY_TEMPLATES={
  received:{ name:'order_received_leadvyne', library_template_name:'order_management_1', language:'en_US', category:'UTILITY' },
  paid:{ name:'order_payment_received_leadvyne', library_template_name:'payment_confirmation_4', language:'en_US', category:'UTILITY' },
  shipped:{ name:'order_shipped_leadvyne', library_template_name:'shipment_confirmation_1', language:'en_US', category:'UTILITY' },
};
async function handleEcomWaTemplatesCreateFromLibrary(request, env){
  const {client_id, kind}=await request.json().catch(()=>({}));
  if(!client_id||!kind) return json({error:'client_id and kind required'}, 400);
  const lib=SHOPIFY_LIBRARY_TEMPLATES[kind];
  if(!lib) return json({error:'No library template available for this event yet'}, 400);
  const c=await getClientById(env, client_id);
  if(!c?.waba_id||!c?.wa_token) return json({error:'WhatsApp Business Account ID / token not configured.'}, 400);
  const r=await fetch(`https://graph.facebook.com/v18.0/${c.waba_id}/message_templates`, {
    method:'POST', headers:{Authorization:`Bearer ${c.wa_token}`, 'Content-Type':'application/json'},
    body:JSON.stringify({name:lib.name, category:lib.category, language:lib.language, library_template_name:lib.library_template_name})
  });
  const data=await r.json().catch(()=>({}));
  if(!r.ok) return json({error:data?.error?.message||'HTTP '+r.status}, 502);
  return json({ok:true, name:lib.name, language:lib.language, status:data?.status||'APPROVED'});
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

// Automation entry point for "order intent detected" — meant to be called by the client's own
// conversational bot (the external n8n engine, not this repo — see SETUP.md's "Trust Signals"
// section for why) the moment it decides a customer wants to buy, without a dashboard session:
// same client_id-based auth model as the rest of /ecom/*, since n8n has no Authentik session.
// Builds the same storefront link a product card's own "Order on WhatsApp" button already uses
// (onshope.com/<slug> if the client has one, else store.html?client=<id>, with &sku= for a
// specific product), sends it directly via Meta's Graph API (bypassing Chatwoot, same as
// handleWaSend), and always logs a 'pending' row in the client's ecom orders table — so "order
// intent" leaves a paper trail even if the WhatsApp send itself fails (e.g. outside the 24h
// free-form-message window) or the customer never finishes checking out.
// Shared by handleEcomOrderLink and the KB-payload guidance's server-side equivalents — a client's
// own external_store_link (Shopify or any other storefront they actually sell through, set in
// Settings → Order Link) always wins; the built-in Ecommerce module's own storefront link
// (onshope.com/<slug> or store.html?client=<id>) is only the fallback when it's blank. sku
// deep-linking only applies to the built-in link — an external URL has no known query-param
// scheme to append one to, so it's returned as-is.
function buildOrderLink(c, clientId, sku){
  const ext=(c.external_store_link||'').trim();
  if(ext) return ext;
  const slug=c.client_slug;
  const base=slug?`https://onshope.com/${slug}`:`https://app.leadvyne.com/store.html?client=${clientId}`;
  if(!sku) return base;
  return slug?`${base}?sku=${encodeURIComponent(sku)}`:`${base}&sku=${encodeURIComponent(sku)}`;
}

// Shared by both order-link senders below — resolves the optional matched product and logs the
// `pending` order row, the one part that happens regardless of how the WhatsApp message gets sent.
// Previously never checked whether the write actually succeeded (same silent-failure shape found
// and fixed elsewhere this file, e.g. ncPatchVerified) — a rejected/failed POST (bad field type,
// NocoDB schema-cache lag right after the client's orders table was first configured, etc.) still
// returned a fake order_id as if it had landed, so an order could be sent to the customer over
// WhatsApp and never appear on the Orders page at all, with nothing in the logs to explain why.
async function logPendingOrder(env, c, clientId, phone, name, product){
  const ordersTable=await ecomResolveTable(env, clientId, 'orders');
  if(!ordersTable) return null;
  const order_id='ORD-'+Date.now();
  const body={
    client_id:clientId, order_id,
    customer_name:name||'', customer_phone:phone,
    order_date:new Date().toISOString().slice(0,10),
    items:product?product.name:'Catalog link sent',
    total:product?.price||0, currency:product?.currency||'',
    status:'pending', notes:'Order intent detected — link sent automatically'
  };
  const r=await ncFetch(env, `api/v2/tables/${ordersTable}/records`, {method:'POST', body});
  if(!r.ok){
    const data=await r.json().catch(()=>({}));
    await reportOpsError(env, 'logPendingOrder', new Error(data?.msg||data?.error||`HTTP ${r.status}`), {clientId, phone, ordersTable});
    return null;
  }
  return order_id;
}

async function ecomFindProductBySku(env, clientId, sku){
  if(!sku) return null;
  const productsTable=await ecomResolveTable(env, clientId, 'products');
  if(!productsTable) return null;
  const pr=await ncFetch(env, `api/v2/tables/${productsTable}/records?where=(client_id,eq,${clientId})~and(sku,eq,${encodeURIComponent(sku)})&limit=1`);
  const pd=await pr.json().catch(()=>({}));
  return pd?.list?.[0]||null;
}

// Fuzzy fallback for when detectOrderSignal is confident WHICH product but didn't reproduce its
// exact sku string closely enough for ecomFindProductBySku's exact match — an LLM copying a
// natural-language product name is far more reliable than copying an alphanumeric code. Observed
// live: a customer confirmed "Yes" right after the bot itself named a specific product in its own
// immediately-prior message; detectOrderSignal correctly classified mode:'order' but the sku it
// returned didn't match any real product, so the customer got "which item would you like?"
// immediately after the bot had just told them. Case-insensitive substring match either direction
// (catalog name contains the guess, or the guess contains the catalog name) against the same
// client's products, capped the same as detectOrderSignal's own catalog scan.
async function ecomResolveProduct(env, clientId, sku, productName){
  const bySku=await ecomFindProductBySku(env, clientId, sku);
  if(bySku) return bySku;
  const guess=(productName||'').trim().toLowerCase();
  if(!guess) return null;
  const productsTable=await ecomResolveTable(env, clientId, 'products');
  if(!productsTable) return null;
  const pr=await ncFetch(env, `api/v2/tables/${productsTable}/records?where=(client_id,eq,${clientId})~and(status,neq,inactive)&limit=100`);
  const pd=await pr.json().catch(()=>({}));
  const products=pd?.list||[];
  return products.find(p=>{
    const name=(p.name||'').trim().toLowerCase();
    return name && (name.includes(guess) || guess.includes(name));
  })||null;
}

async function resolveOrderProductAndText(env, c, clientId, name, sku, link){
  const product=await ecomFindProductBySku(env, clientId, sku);
  const displayName=name||'there';
  const text=product
    ? `Hi ${displayName}! Here's the item you were asking about:\n\n*${product.name}* — ${product.currency||''} ${product.price||''}\n\nOrder it here: ${link}`
    : `Hi ${displayName}! Here's our full catalog — order directly from here:\n${link}`;
  return {product, text};
}

// The "just asking" reply — full product detail available as context, no order/checkout link.
// Deliberately never mentions ordering or includes a link: a customer asking about a product
// (size, color, stock, price) should get an answer and the photo, and only see an order link once
// they've actually said they want to order (detectOrderSignal's separate 'order' mode, handled
// elsewhere) — conflating "interested" with "ready to buy" was pushing a checkout link into every
// product question, whether the customer had asked for it or not.
// LLM-generated rather than a fixed name/price/color/size/stock template that always dumped every
// field regardless of what was actually asked — observed live: a plain "Hi" got a long, salesy
// paragraph reciting sizes/colors nobody asked about, and price was always volunteered even when
// the customer only asked about availability. This tells the model everything it's allowed to say
// but leaves *what to actually say* up to what the customer asked.
function engineBuildProductEnquirySystemPrompt(c, product, replyLang, checkoutLink){
  const lang=replyLang||c.language||'en';
  const lines=[`Name: ${product.name}`];
  if(product.price) lines.push(`Price: ${product.currency||''} ${product.price}`.trim());
  if(product.color) lines.push(`Color: ${product.color}`);
  if(product.size) lines.push(`Size options: ${product.size}`);
  if(product.category) lines.push(`Category: ${product.category}`);
  const stockNum=Number(product.stock);
  lines.push(Number.isFinite(stockNum) && stockNum<=0 ? 'Currently out of stock' : 'In stock');
  // main_prompt goes first, same as engineBuildFaqSystemPrompt/engineBuildObjectionSystemPrompt/
  // engineBuildFirstTouchIntro — this was the one reply-generating prompt in the engine that left
  // it out entirely, so a client's own persona/tone/closing-style instructions had zero effect on
  // product-enquiry replies specifically, no matter what they wrote in Main Prompt. Every hardcoded
  // instruction below is phrased the same "Default X — follow this unless the persona/instructions
  // above specify otherwise" way as the other three prompts, so main_prompt stays authoritative.
  let sys=c.main_prompt||'';
  sys+=`\n\nYou are replying to a customer asking about one specific product. Everything you know about it:\n${lines.join('\n')}`;
  sys+='\n\nAnswer only what the customer actually asked — do not recite every field above like a spec sheet. Default style (follow this unless the persona/instructions above specify a different tone, reply length, or closing style — in that case, follow those instead): do not mention the price unless the customer\'s message is about price/cost, or you genuinely need it to answer their question. Keep your reply conversational and to the point, not a paragraph — but a short question is never a reason to leave out the actual fact/detail being asked for (price, size, stock, etc.); a brief reply that skips the real answer is worse than a slightly longer one that actually answers it. Sound like a real person texting a quick reply, not a scripted sales pitch — natural and warm, no corporate phrasing, no more than one emoji.';
  // Opt-in per client (Ecommerce → Settings → "Share order link on product questions",
  // ecom_link_on_enquiry) — the default product behavior deliberately withholds the checkout link
  // until real order intent (see the routing comment at this prompt's call site), but a client can
  // choose to share it earlier, e.g. as soon as a customer asks about size/stock and sounds ready to
  // move forward. Framed as available-if-natural, not forced into every reply, so a customer who
  // only asked "is this in stock" doesn't get an unsolicited checkout link shoved at them.
  if(checkoutLink) sys+=`\n\nYou may also share this checkout link if it naturally helps answer their question or they seem ready to move forward (for example, right after confirming their size or stock is available) — not forced into every reply, only when it fits: ${checkoutLink}`;
  sys+=`\n\nRespond ONLY in ${lang}. Never switch languages.`;
  return sys;
}

// order.html's checkout form (frontend/order.html) — collects size, delivery address, phone and
// email and creates a full order row (handleEcomPublicOrder), unlike the bare "intent detected"
// row logPendingOrder writes here. Only used for the built-in Ecommerce module's own storefront; a
// client selling through their own external_store_link (Shopify etc.) has no in-house checkout
// page for this to point at, so that link is used unchanged, same as buildOrderLink above.
function buildCheckoutLink(c, clientId, sku){
  const ext=(c.external_store_link||'').trim();
  if(ext) return ext;
  return `https://app.leadvyne.com/order.html?client=${clientId}&sku=${encodeURIComponent(sku)}`;
}

// Core "actually send the order link" logic — direct Meta Graph API, bypassing Chatwoot. Kept as
// the implementation POST /ecom/order-link uses, and as sendOrderLinkViaChatwoot's fallback below.
async function sendOrderLinkNow(env, c, clientId, phone, name, sku){
  if(!c.wa_phone_id||!c.wa_token) return {error:'WhatsApp phone / token not configured.'};
  const link=buildOrderLink(c, clientId, sku);
  const {product, text}=await resolveOrderProductAndText(env, c, clientId, name, sku, link);
  const waR=await fetch(`https://graph.facebook.com/v18.0/${c.wa_phone_id}/messages`, {
    method:'POST', headers:{Authorization:`Bearer ${c.wa_token}`, 'Content-Type':'application/json'},
    body:JSON.stringify({messaging_product:'whatsapp', to:phone, type:'text', text:{body:text}})
  });
  const waData=await waR.json().catch(()=>({}));
  const order_id=await logPendingOrder(env, c, clientId, phone, name, product);
  return {ok:true, link, order_id, whatsapp_sent:waR.ok, whatsapp_error:waR.ok?undefined:(waData?.error?.message||'HTTP '+waR.status), via:'graph'};
}

// Used only by the ecom auto-send path (handleChatwootIncomingOrderSignal below) — same reasoning
// as sendBookingLinkViaChatwoot: this webhook fires because of a real message on a real Chatwoot
// conversation, so its id is already known, and routing the reply through Chatwoot's own message
// endpoint means it shows up in the rep's inbox and Chatwoot's own WhatsApp channel does the relay,
// instead of this repo hand-building a Graph API payload for a path Chatwoot never learns about.
async function sendOrderLinkViaChatwoot(env, c, clientId, conversationId, phone, name, sku){
  if(!c.chatwoot_base||!c.chatwoot_account_id||!c.chatwoot_token) return {error:'Chatwoot is not configured for this account.'};
  const link=buildOrderLink(c, clientId, sku);
  const {product, text}=await resolveOrderProductAndText(env, c, clientId, name, sku, link);
  const fd=new FormData();
  fd.append('content', text); fd.append('message_type','outgoing'); fd.append('private','false');
  // Attach the actual product photo, same as the primary inline-order path
  // (engineSendChatwootImageReply) — best-effort, falls straight through to a text-only send if
  // there's no image or the fetch fails.
  const directUrl=product?.image_url?engineResolveDirectImageUrl(product.image_url):'';
  if(directUrl){
    try{
      const imgR=await fetch(directUrl);
      if(imgR.ok) fd.append('attachments[]', await imgR.blob(), 'product.jpg');
    }catch(e){}
  }
  const r=await fetch(`${c.chatwoot_base}/api/v1/accounts/${c.chatwoot_account_id}/conversations/${conversationId}/messages`, {method:'POST', headers:{api_access_token:c.chatwoot_token}, body:fd});
  const order_id=await logPendingOrder(env, c, clientId, phone, name, product);
  return {ok:true, link, order_id, whatsapp_sent:r.ok, whatsapp_error:r.ok?undefined:('HTTP '+r.status), via:'chatwoot'};
}

async function handleEcomOrderLink(request, env){
  const body=await request.json().catch(()=>({}));
  const clientId=String(body.client_id||'');
  const phone=String(body.phone||'').replace(/[^0-9+]/g,'');
  if(!clientId||!phone) return json({error:'client_id and phone required'}, 400);
  const c=await getClientById(env, clientId);
  if(!c) return json({error:'Client not found'}, 404);
  const result=await sendOrderLinkNow(env, c, clientId, phone, body.name, body.sku);
  if(result.error) return json({error:result.error}, 400);
  return json(result);
}

// Non-ecom equivalent of /ecom/order-link, for healthcare/services/consultancy-style clients
// where the conversion event is a booking, not a purchase — there's no product/order to log, so
// instead of writing to the ecom orders table this advances the matching lead and drops a
// follow-up task. Reuses external_store_link (Settings -> Order Link) as the booking link — same
// field ecom clients use for their storefront override, here holding a Calendly/Cal.com/booking
// page URL instead; and reuses manual_tasks, the same JSON-on-CLIENTS field the dashboard's Tasks
// page already reads/writes, so no new table for either.
const BOOKING_TERMINAL_STAGES=['appt_booked','consultation_booked','visit_booked'];

// A client's own Appointment Booking module tables (Settings -> Modules -> Appointment Booking),
// created on demand by apptSetupTables() in dashboard.html — same per-client-tables model as
// Travel/Recruit, not the shared-table-with-client_id model Ecommerce uses, so there's no default
// table id to fall back to here.
function apptResolveTable(c, kind){
  try{ return (JSON.parse(c.appt_table_ids||'{}'))[kind]||null; }catch(e){ return null; }
}

// Shared by handleLeadBookingLink and handleChatwootMessageHook's non-ecom fallback below — finds
// the lead by phone, advances it to a booking-terminal stage (only one the client has actually
// defined in their own flow_json — never writes a stage value they haven't configured), drops a
// follow-up task via manual_tasks (the same JSON-on-CLIENTS field the Tasks page itself uses), and
// — if the client has set up the Appointment Booking module — logs a `requested` row there too.
// `explicitWhen` is optional {date, time} — set by handleApptPublicBook when a customer submits a
// real date/time through the public booking page, vs. the other callers here which only know
// *intent*, not a specific slot yet. When set: source is 'public' instead of 'bot', the row always
// gets inserted (a real distinct booking, not just intent, so no "already has one requested"
// dedupe), and the task is worded as "review", not "confirm the link landed". Returns
// {lead_id, stage_advanced} for the caller to report back.
async function advanceLeadBookingAndTask(env, c, clientId, phone, name, service, explicitWhen){
  const leadR=await ncFetch(env, `api/v2/tables/${DEFAULT_LEADS_TABLE}/records?where=(client_id,eq,${clientId})~and(Phone,eq,${encodeURIComponent(phone)})&limit=1`);
  const leadD=await leadR.json().catch(()=>({}));
  const lead=leadD?.list?.[0]||null;

  let stage_advanced=null;
  if(lead){
    let flow={}; try{ flow=JSON.parse(c.flow_json||'{}'); }catch(e){}
    const stageKeys=Object.keys(flow.stages||{});
    const target=BOOKING_TERMINAL_STAGES.find(s=>stageKeys.includes(s));
    if(target && lead.Stage!==target){
      await ncFetch(env, `api/v2/tables/${DEFAULT_LEADS_TABLE}/records`, {method:'PATCH', body:{Id:lead.Id, Stage:target}});
      stage_advanced=target;
    }
  }

  const whenText=explicitWhen?.date?` on ${explicitWhen.date}${explicitWhen.time?' '+explicitWhen.time:''}`:'';
  let manual={items:[],dismissed:[],projects:[]};
  try{ manual={...manual, ...JSON.parse(c.manual_tasks||'{}')}; }catch(e){}
  if(!Array.isArray(manual.items)) manual.items=[];
  manual.items.push({
    id:'t_'+Date.now()+'_'+Math.random().toString(36).slice(2,7),
    title:`${explicitWhen?'Review booking':'Confirm booking'} — ${name||phone}${service?.name?' ('+service.name+')':''}${whenText}`,
    notes:explicitWhen?'Booked via the public booking page — review and confirm.':'Booking link sent — confirm the appointment landed.',
    due_date:new Date().toISOString().slice(0,10), due_time:'',
    lead_id:lead?lead.Id:null, lead_name:lead?.Name||name||'',
    assignee_email:'', category:'', project_id:'', status:'open', created_at:new Date().toISOString()
  });
  await patchClientFields(env, clientId, {manual_tasks:JSON.stringify(manual)});

  const bookingsTable=apptResolveTable(c, 'bookings');
  if(bookingsTable){
    const insert=async()=>ncFetch(env, `api/v2/tables/${bookingsTable}/records`, {method:'POST', body:{
      client_id:clientId, customer_name:name||'', customer_phone:phone,
      service_id:service?String(service.Id):'', service_name:service?.name||'',
      appt_date:explicitWhen?.date||'', appt_time:explicitWhen?.time||'',
      status:'requested', source:explicitWhen?'public':'bot', lead_id:lead?String(lead.Id):'', calcom_uid:'',
      notes:explicitWhen?'Booked via the public booking page — awaiting confirmation.':'Booking link sent — awaiting confirmed date/time.',
      created_at:new Date().toISOString()
    }}).catch(()=>{});
    if(explicitWhen){
      // A real, distinct booking with its own date/time — always insert, no dedupe.
      await insert();
    }else{
      // Intent only, no specific slot yet — dedupe on "this phone already has a requested row" so
      // the auto-tracking webhook (which can call this repeatedly as the bot repeats the link
      // across turns) doesn't spam duplicate rows.
      const existR=await ncFetch(env, `api/v2/tables/${bookingsTable}/records?where=(client_id,eq,${clientId})~and(customer_phone,eq,${encodeURIComponent(phone)})~and(status,eq,requested)&limit=1`);
      const existD=await existR.json().catch(()=>({}));
      if(!existD?.list?.length) await insert();
    }
  }

  return {lead_id:lead?.Id||null, stage_advanced};
}

// Shared by both senders below — resolves the optional matched service (only if the Appointment
// module is set up) and builds the message text. Split out so sendBookingLinkNow (direct Graph
// API) and sendBookingLinkViaChatwoot (routes through Chatwoot instead) don't duplicate it.
async function resolveApptServiceAndText(env, c, clientId, name, serviceId, link){
  let service=null;
  if(serviceId){
    const servicesTable=apptResolveTable(c, 'services');
    if(servicesTable){
      const sr=await ncFetch(env, `api/v2/tables/${servicesTable}/records?where=(client_id,eq,${clientId})~and(Id,eq,${Number(serviceId)})&limit=1`);
      const sd=await sr.json().catch(()=>({}));
      service=sd?.list?.[0]||null;
    }
  }
  const displayName=name||'there';
  const text=service
    ? `Hi ${displayName}! Here's the link to book your *${service.name}*${service.duration_minutes?' ('+service.duration_minutes+' min)':''}: ${link}`
    : `Hi ${displayName}! Here's the link to book: ${link}`;
  return {service, text};
}

// Core "actually send the booking link" logic — shared by the HTTP endpoint below
// (handleLeadBookingLink, for n8n or a rep-triggered flow to call) and used as the fallback when
// sendBookingLinkViaChatwoot below has no Chatwoot conversation to send through. serviceId is
// optional and only resolved if the Appointment module is set up; without it the message is just
// the plain booking-link text.
async function sendBookingLinkNow(env, c, clientId, phone, name, serviceId){
  const link=(c.external_store_link||'').trim();
  if(!link) return {error:'No booking link configured — set one in Settings → Order Link.'};
  if(!c.wa_phone_id||!c.wa_token) return {error:'WhatsApp phone / token not configured.'};

  const {service, text}=await resolveApptServiceAndText(env, c, clientId, name, serviceId, link);
  const waR=await fetch(`https://graph.facebook.com/v18.0/${c.wa_phone_id}/messages`, {
    method:'POST', headers:{Authorization:`Bearer ${c.wa_token}`, 'Content-Type':'application/json'},
    body:JSON.stringify({messaging_product:'whatsapp', to:phone, type:'text', text:{body:text}})
  });
  const waData=await waR.json().catch(()=>({}));

  const {lead_id, stage_advanced}=await advanceLeadBookingAndTask(env, c, clientId, phone, name, service);
  return {ok:true, link, whatsapp_sent:waR.ok, whatsapp_error:waR.ok?undefined:(waData?.error?.message||'HTTP '+waR.status), via:'graph', lead_id, stage_advanced};
}

// Used only by the auto-send path (handleChatwootIncomingBookingSignal), which is triggered by a
// Chatwoot webhook that already tells us which conversation the customer's message is in — sends
// the reply through Chatwoot's own message endpoint (same FormData/content pattern as
// handleWaReplyChatwoot above) instead of building a Meta Graph API payload directly. Two wins
// over the direct-Graph-API path: (1) the message actually shows up in the rep's Chatwoot inbox,
// instead of only existing as a raw API call this repo made that Chatwoot never learns about; (2)
// Chatwoot's own WhatsApp Cloud API channel config (set up with this same wa_token/wa_phone_id
// during WhatsApp connect — see handleChannelsWhatsappConnect) does the actual Meta relay, so this
// path never has to hand-build a Graph API text payload at all.
async function sendBookingLinkViaChatwoot(env, c, clientId, conversationId, phone, name, serviceId){
  const link=(c.external_store_link||'').trim();
  if(!link) return {error:'No booking link configured — set one in Settings → Order Link.'};
  if(!c.chatwoot_base||!c.chatwoot_account_id||!c.chatwoot_token) return {error:'Chatwoot is not configured for this account.'};

  const {service, text}=await resolveApptServiceAndText(env, c, clientId, name, serviceId, link);
  const fd=new FormData();
  fd.append('content', text); fd.append('message_type','outgoing'); fd.append('private','false');
  const r=await fetch(`${c.chatwoot_base}/api/v1/accounts/${c.chatwoot_account_id}/conversations/${conversationId}/messages`, {method:'POST', headers:{api_access_token:c.chatwoot_token}, body:fd});

  const {lead_id, stage_advanced}=await advanceLeadBookingAndTask(env, c, clientId, phone, name, service);
  return {ok:true, link, whatsapp_sent:r.ok, whatsapp_error:r.ok?undefined:('HTTP '+r.status), via:'chatwoot', lead_id, stage_advanced};
}

async function handleLeadBookingLink(request, env){
  const body=await request.json().catch(()=>({}));
  const clientId=String(body.client_id||'');
  const phone=String(body.phone||'').replace(/[^0-9+]/g,'');
  if(!clientId||!phone) return json({error:'client_id and phone required'}, 400);
  const c=await getClientById(env, clientId);
  if(!c) return json({error:'Client not found'}, 404);
  const result=await sendBookingLinkNow(env, c, clientId, phone, body.name, body.service_id);
  if(result.error) return json({error:result.error}, 400);
  return json(result);
}

// Cal.com's HMAC is hex-encoded (X-Cal-Signature-256), unlike Shopify's base64
// (verifyShopifyWebhookHmac above) — and the secret is per-client, not one app-wide secret, since
// each client creates their own webhook in their own Cal.com account (Settings -> Developer ->
// Webhooks) and picks the secret themselves, pasted into Settings -> Cal.com Sync.
async function verifyCalcomWebhookHmac(secret, rawBody, sigHeader){
  if(!secret||!sigHeader) return false;
  const key=await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const sig=await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expected=Array.from(new Uint8Array(sig)).map(b=>b.toString(16).padStart(2,'0')).join('');
  if(expected.length!==sigHeader.length) return false;
  let diff=0; for(let i=0;i<expected.length;i++) diff|=expected.charCodeAt(i)^sigHeader.charCodeAt(i);
  return diff===0;
}

// Receives Cal.com's booking webhooks (client_id comes from the URL path they pasted into their
// own Cal.com webhook config — see Settings -> Cal.com Sync). Upserts into the client's own
// Appointment Booking module (appt_table_ids.bookings — apptSetupTables() in dashboard.html),
// keyed by Cal.com's own booking uid so BOOKING_RESCHEDULED/BOOKING_CANCELLED update the same row
// instead of creating duplicates.
async function handleCalcomWebhook(request, env, clientId){
  const rawBody=await request.text();
  const c=await getClientById(env, clientId);
  // Unknown/removed client — ack with 200 so Cal.com doesn't keep retrying; nothing to act on.
  if(!c) return json({ok:true});
  const sig=request.headers.get('X-Cal-Signature-256');
  if(!(await verifyCalcomWebhookHmac(c.calcom_webhook_secret, rawBody, sig))) return json({error:'Invalid signature'}, 401);

  let data; try{ data=JSON.parse(rawBody); }catch(e){ return json({ok:true}); }
  const trigger=data.triggerEvent||'';
  const b=data.payload||{};
  const uid=b.uid||b.uuid||'';
  if(!uid) return json({ok:true});

  const bookingsTable=apptResolveTable(c, 'bookings');
  if(!bookingsTable) return json({ok:true, skipped:'no-bookings-table'});

  const attendee=(b.attendees||[])[0]||{};
  const start=b.startTime||'';
  const statusMap={BOOKING_CREATED:'confirmed', BOOKING_RESCHEDULED:'confirmed', BOOKING_CANCELLED:'cancelled', BOOKING_REQUESTED:'requested'};
  const fields={
    client_id:clientId, calcom_uid:uid,
    customer_name:attendee.name||'', customer_phone:attendee.phone||attendee.phoneNumber||'',
    service_name:b.title||b.eventType?.title||'',
    appt_date:start?start.slice(0,10):'', appt_time:start?start.slice(11,16):'',
    status:statusMap[trigger]||'confirmed', source:'calcom', notes:b.description||'',
  };

  const existR=await ncFetch(env, `api/v2/tables/${bookingsTable}/records?where=(client_id,eq,${clientId})~and(calcom_uid,eq,${encodeURIComponent(uid)})&limit=1`);
  const existD=await existR.json().catch(()=>({}));
  const existing=existD?.list?.[0]||null;
  if(existing) await ncFetch(env, `api/v2/tables/${bookingsTable}/records`, {method:'PATCH', body:{Id:existing.Id, ...fields}});
  else await ncFetch(env, `api/v2/tables/${bookingsTable}/records`, {method:'POST', body:{...fields, created_at:new Date().toISOString()}});

  return json({ok:true});
}

// One-time setup (dashboard "Enable Auto Order-Tracking" button): registers a *second*,
// independent Chatwoot webhook on the client's WhatsApp inbox, alongside whichever one already
// feeds n8n's bot (see the c.webhook_url registration above, in the WhatsApp-connect flow). This
// second webhook points at handleChatwootMessageHook below instead — n8n's own webhook/workflow
// is completely untouched, it doesn't even know this one exists. Chatwoot fires both on every
// message_created event.
async function handleEcomEnableOrderTracking(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const c=await getClientById(env, payload.cid);
  if(!c?.chatwoot_account_id||!c?.chatwoot_token||!c?.chatwoot_base) return json({error:'Connect a Chatwoot account first.'}, 400);
  if(!c?.chatwoot_inbox_id) return json({error:'Connect a WhatsApp inbox first.'}, 400);
  if(!env.WORKER_BASE_URL) return json({error:'WORKER_BASE_URL is not configured on the server.'}, 500);
  const hookUrl=`${env.WORKER_BASE_URL}/hooks/chatwoot-message`;

  const listR=await fetch(`${c.chatwoot_base}/api/v1/accounts/${c.chatwoot_account_id}/webhooks`, {headers:{api_access_token:c.chatwoot_token}}).catch(()=>null);
  const listD=listR?await listR.json().catch(()=>null):null;
  const existingList=Array.isArray(listD)?listD:(Array.isArray(listD?.payload)?listD.payload:null);
  if(existingList?.some(w=>w.url===hookUrl)) return json({ok:true, already_enabled:true});

  const r=await fetch(`${c.chatwoot_base}/api/v1/accounts/${c.chatwoot_account_id}/webhooks`, {
    method:'POST', headers:{api_access_token:c.chatwoot_token, 'Content-Type':'application/json'},
    body:JSON.stringify({inbox_id:Number(c.chatwoot_inbox_id), url:hookUrl, subscriptions:['message_created']})
  });
  if(!r.ok) return json({error:'Chatwoot webhook registration failed: HTTP '+r.status}, 502);
  return json({ok:true});
}

// Receives Chatwoot's message_created event for every message on the client's WhatsApp inbox
// (registered by handleEcomEnableOrderTracking above). Only acts on the bot's own OUTGOING
// replies, and only ever performs a silent DB write — it never sends anything to the customer —
// so it can never race or double-reply against n8n's own bot response to the same conversation.
// The link it looks for is exactly the one buildKbProcessorText() (dashboard.html) already
// instructs the bot to share in its own words, so detecting it needs no n8n/engine.json changes.
// Three shapes: the built-in ecom module's own onshope.com/store.html link (sku extractable from
// it), this repo's own public booking page (book.html — no sku), or — once external_store_link is
// set (Settings → Order Link) — that client's own Shopify/Cal.com/other URL, matched as a plain
// substring since an arbitrary external domain has no known sku query-param scheme to parse out.
const CHATWOOT_HOOK_LINK_RE=/https:\/\/(?:onshope\.com\/([a-z0-9-]+)|app\.leadvyne\.com\/store\.html\?client=(\d+)|app\.leadvyne\.com\/book\.html\?client=(\d+))(?:[?&]sku=([^\s&"']+))?/i;

// Direct, Cloudflare-only auto-send for booking-industry clients: screens the customer's own
// INCOMING message for booking intent and, if detected, sends the booking link itself right here
// — no n8n call involved. This is a deliberate, narrow exception to the "n8n calls Cloudflare, so
// n8n stays in control of whether it also replies" rule the rest of this file follows for anything
// that talks to the customer (see /ai/order-signal's and /ai/booking-signal's comments) — it
// carries a real, accepted risk: if the client's n8n bot also replies to this same incoming
// message with its own text, the customer gets two messages. Scoped tightly to limit that: only
// clients with no ecom orders table (i.e. not an ecom client), only once the AI actually screens
// the message as a signal, and only once per lead (dedupe below) so it can't fire repeatedly in
// one conversation.
async function handleChatwootIncomingBookingSignal(env, c, clientId, content, body){
  const link=(c.external_store_link||'').trim();
  if(!link) return json({ok:true, skipped:'no-booking-link'});
  const ordersTable=await ecomResolveTable(env, clientId, 'orders');
  if(ordersTable) return json({ok:true, skipped:'ecom-client'});
  if(!c.wa_phone_id||!c.wa_token) return json({ok:true, skipped:'whatsapp-not-configured'});
  if(!c.openrouter_key) return json({ok:true, skipped:'no-openrouter-key'});

  const phone=String(
    body.conversation?.meta?.sender?.phone_number ||
    body.conversation?.contact_inbox?.source_id ||
    ''
  ).replace(/[^0-9+]/g,'');
  if(!phone) return json({ok:true, skipped:'no-phone'});

  const leadR=await ncFetch(env, `api/v2/tables/${DEFAULT_LEADS_TABLE}/records?where=(client_id,eq,${clientId})~and(Phone,eq,${encodeURIComponent(phone)})&limit=1`);
  const leadD=await leadR.json().catch(()=>({}));
  const lead=leadD?.list?.[0]||null;
  if(lead && BOOKING_TERMINAL_STAGES.includes(lead.Stage)) return json({ok:true, skipped:'already-booked'});

  // Dedupe before spending an AI call on every follow-up message — skip if this phone already has
  // a requested appointment (only checkable once the Appointment module is set up).
  const bookingsTable=apptResolveTable(c, 'bookings');
  if(bookingsTable){
    const existR=await ncFetch(env, `api/v2/tables/${bookingsTable}/records?where=(client_id,eq,${clientId})~and(customer_phone,eq,${encodeURIComponent(phone)})~and(status,eq,requested)&limit=1`);
    const existD=await existR.json().catch(()=>({}));
    if(existD?.list?.length) return json({ok:true, skipped:'duplicate-requested'});
  }

  const conversationId=body.conversation?.id;
  const contextText=await fetchRecentChatwootContext(c, conversationId, 8);
  const detection=await detectBookingSignal(env, c, clientId, content, contextText);
  if(!detection.signal) return json({ok:true, skipped:'no-signal'});

  const name=body.conversation?.meta?.sender?.name;
  // Prefer routing through Chatwoot — this webhook fired because of a message on an existing
  // conversation, so conversationId should always be present; sendBookingLinkNow (direct Graph
  // API) is only a fallback for the unlikely case Chatwoot's payload omits it or isn't configured.
  const result=(conversationId && c.chatwoot_base && c.chatwoot_account_id && c.chatwoot_token)
    ? await sendBookingLinkViaChatwoot(env, c, clientId, conversationId, phone, name, detection.service_id)
    : await sendBookingLinkNow(env, c, clientId, phone, name, detection.service_id);
  return json({ok:true, auto_sent:true, ...result});
}

// Ecom counterpart of handleChatwootIncomingBookingSignal above — same direct, Cloudflare-only
// auto-send exception to "n8n stays in control," same double-reply-risk tradeoff, just for clients
// with an ecom orders table instead of booking-industry ones. Built specifically to close a real,
// observed gap: a customer replying "Order M size" to a product the bot had just shown got "we
// don't have anything matching your preferences" back — the client's own n8n flow wasn't
// connecting the size reply to the product it had itself just displayed. This path uses
// fetchRecentChatwootContext so the same short reply resolves correctly against what was actually
// just discussed, instead of depending on whatever matching logic n8n's own flow has.
async function handleChatwootIncomingOrderSignal(env, c, clientId, content, body, ordersTable){
  if(!c.wa_phone_id||!c.wa_token) return json({ok:true, skipped:'whatsapp-not-configured'});
  if(!c.openrouter_key) return json({ok:true, skipped:'no-openrouter-key'});

  const phone=String(
    body.conversation?.meta?.sender?.phone_number ||
    body.conversation?.contact_inbox?.source_id ||
    ''
  ).replace(/[^0-9+]/g,'');
  if(!phone) return json({ok:true, skipped:'no-phone'});

  // Dedupe before spending an AI call — skip if this phone already has a pending auto-sent order.
  const existR=await ncFetch(env, `api/v2/tables/${ordersTable}/records?where=(client_id,eq,${clientId})~and(customer_phone,eq,${encodeURIComponent(phone)})~and(status,eq,pending)&limit=1`);
  const existD=await existR.json().catch(()=>({}));
  if(existD?.list?.length) return json({ok:true, skipped:'duplicate-pending'});

  const conversationId=body.conversation?.id;
  const contextText=await fetchRecentChatwootContext(c, conversationId, 8);
  const detection=await detectOrderSignal(env, c, clientId, content, contextText);
  if(!detection.signal) return json({ok:true, skipped:'no-signal'});

  const name=body.conversation?.meta?.sender?.name;
  const result=(conversationId && c.chatwoot_base && c.chatwoot_account_id && c.chatwoot_token)
    ? await sendOrderLinkViaChatwoot(env, c, clientId, conversationId, phone, name, detection.sku)
    : await sendOrderLinkNow(env, c, clientId, phone, name, detection.sku);
  return json({ok:true, auto_sent:true, ...result});
}

async function handleChatwootMessageHook(request, env){
  const body=await request.json().catch(()=>({}));
  const msgType=String(body.message_type ?? '');
  const content=String(body.content||'');
  const accountId=String(body.account?.id||'');
  if(!accountId||!content) return json({ok:true, skipped:'no-account-or-content'});

  const c=await findClientByField(env, 'chatwoot_account_id', accountId);
  if(!c) return json({ok:true, skipped:'client-not-found'});
  const clientId=String(c.Id);

  if(msgType==='incoming' || msgType==='0'){
    const incomingOrdersTable=await ecomResolveTable(env, clientId, 'orders');
    return incomingOrdersTable
      ? await handleChatwootIncomingOrderSignal(env, c, clientId, content, body, incomingOrdersTable)
      : await handleChatwootIncomingBookingSignal(env, c, clientId, content, body);
  }
  if(msgType!=='outgoing' && msgType!=='1') return json({ok:true, skipped:'not-outgoing'});

  const ext=(c.external_store_link||'').trim();
  const m=content.match(CHATWOOT_HOOK_LINK_RE);
  if(!m && !(ext && content.includes(ext))) return json({ok:true, skipped:'no-link-in-message'});

  const sku=m?.[4]?decodeURIComponent(m[4]):null;
  const phone=String(
    body.conversation?.meta?.sender?.phone_number ||
    body.conversation?.contact_inbox?.source_id ||
    ''
  ).replace(/[^0-9+]/g,'');
  if(!phone) return json({ok:true, skipped:'no-phone'});

  const ordersTable=await ecomResolveTable(env, clientId, 'orders');
  // No ecom module configured for this client at all — treat it as a booking-style client
  // (healthcare/services/consultancy) instead: advance the lead + drop a follow-up task, same
  // action handleLeadBookingLink performs, just triggered by the bot's own reply instead of an
  // explicit n8n call. Dedupe here is "lead already at a booking-terminal stage" rather than a
  // pending-order check, since there's no orders table to check against.
  if(!ordersTable){
    const leadR=await ncFetch(env, `api/v2/tables/${DEFAULT_LEADS_TABLE}/records?where=(client_id,eq,${clientId})~and(Phone,eq,${encodeURIComponent(phone)})&limit=1`);
    const leadD=await leadR.json().catch(()=>({}));
    const lead=leadD?.list?.[0]||null;
    if(lead && BOOKING_TERMINAL_STAGES.includes(lead.Stage)) return json({ok:true, skipped:'already-booked'});
    const {lead_id, stage_advanced}=await advanceLeadBookingAndTask(env, c, clientId, phone, body.conversation?.meta?.sender?.name);
    return json({ok:true, lead_id, stage_advanced});
  }

  // Dedupe — skip if this phone already has an auto-logged order still pending, so a bot that
  // repeats the link across several turns of the same conversation doesn't spam duplicate rows.
  const existR=await ncFetch(env, `api/v2/tables/${ordersTable}/records?where=(client_id,eq,${clientId})~and(customer_phone,eq,${phone})~and(status,eq,pending)&limit=1`);
  const existD=await existR.json().catch(()=>({}));
  if(existD?.list?.length) return json({ok:true, skipped:'duplicate-pending'});

  let product=null;
  if(sku){
    const productsTable=await ecomResolveTable(env, clientId, 'products');
    if(productsTable){
      const pr=await ncFetch(env, `api/v2/tables/${productsTable}/records?where=(client_id,eq,${clientId})~and(sku,eq,${encodeURIComponent(sku)})&limit=1`);
      const pd=await pr.json().catch(()=>({}));
      product=pd?.list?.[0]||null;
    }
  }
  const order_id='ORD-'+Date.now();
  await ncFetch(env, `api/v2/tables/${ordersTable}/records`, {method:'POST', body:{
    client_id:clientId, order_id,
    customer_name:body.conversation?.meta?.sender?.name||'', customer_phone:phone,
    order_date:new Date().toISOString().slice(0,10),
    items:product?product.name:'Catalog link shared', total:product?.price||0, currency:product?.currency||'',
    status:'pending', notes:'Order intent detected — bot shared store link (auto-logged, no n8n changes)'
  }});
  return json({ok:true, order_id});
}

/* ── CONVERSATION ENGINE, all industries (replaces n8n's engine.json entirely) ──
   Point every client's Chatwoot inbox "message_created" webhook at POST
   /engine/webhook/<their-secret> instead of n8n's own webhook URL (registered automatically —
   see engineSyncChatwootWebhook), and this one endpoint does everything engine.json's n8n workflow did,
   for every industry: tenant + lead lookup, media→text, AI intent/sentiment classification, the
   flow_json state machine (FAQ/qualify/objection/human-handover routing), sending the reply via
   Chatwoot, and upserting the LEADS row + analytics. The client is resolved the same way
   handleChatwootMessageHook already does (chatwoot_account_id -> CLIENTS row), so there's no more
   per-client "wrapper workflow" to stamp out in n8n — one URL serves every client, and
   engineSyncChatwootWebhook (below) registers it automatically the moment a client connects
   WhatsApp, so a brand-new signup never touches n8n at all. FAQ grounding is industry-aware
   (engineRouteFlow's `industryFaqRoute`): 'ecommerce' gets the product/order-catalog context
   (engineBuildEcomContext), 'travel' gets the Travel Agency module's packages/Umrah-groups/cars
   context (engineBuildTravelContext), everything else (general/insurance/real_estate/healthcare/
   education/automotive/consultancy) gets the plain main_prompt+services+kb_summary grounding —
   matching engine.json's own three-way `industry === 'ecommerce' ? 'ecom_faq' : (industry ===
   'travel' ? 'travel_faq' : 'faq')` split. Order-intent auto-send (ecommerce) and booking-intent
   auto-send (every other industry, once a booking link is configured) are both folded into the
   same turn — see the bottom of handleEngineWebhook.

   Ported field-for-field from the supplied engine.json ("Leadvyne · Engine v3"), with these
   deliberate deviations from what that workflow literally does today:
   - Voice notes are still never transcribed — same "(sent a voice note)" placeholder text goes
     to the AI. That's not a shortcut taken here; it's what engine.json itself actually does
     (there's no transcription node wired to the voice branch despite docs describing one).
   - Once a lead's Handover is 'Yes' or Stage is 'human_handover', the bot goes fully silent —
     matches engine.json's own Code·State hard-stop and SETUP.md's documented "never talk over a
     live agent" behavior. The HandoverFaqCount/_isPostHandover branch later in that workflow's
     routing code is unreachable dead code as a result of that same hard-stop; not ported.
   - ConvHistory is rebuilt from the lead's real accumulated history (state.history below), not
     from the trimmed activeHistory the source workflow's Prep-lead node ends up using because of
     a field-name mismatch (slim() drops `history`, keeping only `activeHistory`, but Prep-lead
     reads `sc.history`) — that mismatch silently caps saved conversation history at ~8 messages
     and, as a side effect, permanently dead-codes the "Warm" score fallback that depends on real
     history length. Both are fixed here rather than reproduced, since neither is a documented
     design choice — they read as an accidental regression, not intended behavior. Worth
     independently patching in the n8n workflow too if it keeps running for non-ecom clients.
   - For a human-handover reply, the customer is sent whichever message was actually computed
     (the time-aware "we'll call you today/tomorrow at 9am" text, or the Frustrated-specific
     apology) instead of a separate hardcoded "Sure 🙏 connecting you..." string — in engine.json
     the Switch·Route "human" output wires straight to a fixed-text HTTP node, so that computed
     message is built but never sent and the saved ConvHistory silently disagrees with what the
     customer actually received. Falls back to the same fixed text only when nothing more
     specific was computed (a plain "talk to a human" request with no final-stage/frustration
     context), matching the one case where the original fixed string was actually the intent.
   - The "Leadvyne · Ecom Context" n8n sub-workflow engine.json calls out to wasn't available to
     port (it isn't in this repo). engineBuildEcomContext below is a from-scratch equivalent built
     directly off this Worker's own product/order tables (top active products + this phone's
     recent order status) rather than whatever that sub-workflow used to assemble.
   Order-signal auto-send (previously a second, independent Chatwoot webhook —
   handleChatwootIncomingOrderSignal above) is folded into this same turn instead of firing as a
   separate webhook delivery, since this engine now generates the primary reply itself and no
   longer needs to watch its own outgoing messages for a link pattern to detect what it just sent. ── */

const ENGINE_ANALYTICS_TABLE='m2in19v8n7phitr';
const ENGINE_OPT_OUT_WORDS=['stop','unsubscribe','opt out','opt-out','optout'];
// Matches engine.json's "Google Gemini Chat Model" node (modelName: 'models/gemini-2.0-flash'),
// which the "AI Agent · Sentiment & Intent" node ran on — a dedicated Gemini credential shared
// across all clients (REPLACE_GEMINI_CRED), not each client's own per-tenant OpenRouter key.
const ENGINE_GEMINI_MODEL='gemini-2.0-flash';
// Real observed failure: a customer asked about a free-trial offer that WAS explicitly written in
// this client's own main_prompt (so the model had the correct answer in context) and still got
// told there wasn't one — a plain accuracy/instruction-following gap in gemini-2.0-flash, the same
// gap already fixed for voice transcription (see ENGINE_TRANSCRIBE_MODEL above). The customer-
// facing reply itself (engineCallLlm — every FAQ/objection/product-enquiry answer, for every
// client) is worth the extra cost/latency of a stronger model; the classifier/translation calls
// elsewhere stay on the fast/cheap model since a wrong intent guess or a slightly-off translation
// is a much smaller miss than the actual answer being factually wrong.
const ENGINE_REPLY_MODEL='gemini-2.5-flash';

// Direct Google Generative Language API call (env.GEMINI_API_KEY — a Worker secret, shared across
// all clients, same as the n8n workflow's single Gemini credential). Returns the model's raw text
// output, or null if the key isn't configured or the call fails — callers fall back accordingly.
// Real observed failure: a customer's first message got the reply "Hello! Leadvyne is an
// AI-powered" — cut off mid-sentence, nothing after, sent as-is to the customer. Root cause:
// gemini-2.5-flash (ENGINE_REPLY_MODEL/ENGINE_TRANSCRIBE_MODEL — switched to from gemini-2.0-flash
// for accuracy) has "thinking" (internal reasoning) on by default, and unlike OpenAI's models,
// Google counts those invisible thinking tokens against the SAME maxOutputTokens budget as the
// visible reply — a 2.5 model can burn 90-98% of a short reply's budget on reasoning alone,
// truncating the actual visible text wherever the budget runs out. None of this engine's calls
// benefit from extended reasoning (a classifier verdict or a short customer reply isn't a
// chain-of-thought task), so thinking is switched off whenever a 2.5 model is in use, keeping the
// whole budget for real output. gemini-2.0-flash has no thinking mode, so this is a no-op there.
function engineGeminiGenerationConfig(model, opts){
  const cfg={temperature:opts.temperature??0.3, maxOutputTokens:opts.maxOutputTokens||300, ...(opts.json?{responseMimeType:'application/json'}:{})};
  if(model.startsWith('gemini-2.5')) cfg.thinkingConfig={thinkingBudget:0};
  return cfg;
}

async function engineGeminiGenerate(env, systemText, userText, opts={}){
  if(!env.GEMINI_API_KEY) return null;
  try{
    const model=opts.model||ENGINE_GEMINI_MODEL;
    const reqBody={
      contents:[{role:'user', parts:[{text:userText}]}],
      generationConfig:engineGeminiGenerationConfig(model, opts)
    };
    if(systemText) reqBody.systemInstruction={parts:[{text:systemText}]};
    const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(reqBody)
    });
    if(!r.ok) return null;
    const data=await r.json().catch(()=>({}));
    const parts=data?.candidates?.[0]?.content?.parts||[];
    const outText=parts.map(p=>p.text||'').join('').trim();
    return outText||null;
  }catch(e){ return null; }
}

function engineArrayBufferToBase64(buf){
  const bytes=new Uint8Array(buf);
  let binary='';
  const chunkSize=0x8000; // avoid a stack-overflowing single String.fromCharCode.apply call on large files
  for(let i=0;i<bytes.length;i+=chunkSize) binary+=String.fromCharCode.apply(null, bytes.subarray(i,i+chunkSize));
  return btoa(binary);
}

// Retries a fetch once (after a short fixed delay) on a thrown network error or a likely-transient
// status (429 rate limit, or 5xx) — covers the "momentary blip" case for the voice-to-voice
// pipeline's external calls (media download, Gemini STT, Sarvam TTS) without retrying a real
// client error (bad key, malformed request) that would just fail identically a second time. Not
// applied engine-wide — scoped to this one pipeline, where a customer getting silently downgraded
// to text/placeholder on a single transient failure is the specific problem being solved here.
async function engineFetchWithRetry(url, options){
  for(let attempt=0; ; attempt++){
    let r, thrown=null;
    try{ r=await fetch(url, options); }catch(e){ thrown=e; }
    const transient=thrown || r.status===429 || r.status>=500;
    if(!transient || attempt>=1) { if(thrown) throw thrown; return r; }
    await new Promise(res=>setTimeout(res, 400));
  }
}

const ENGINE_TRANSCRIBE_PROMPT='Transcribe this voice note to plain text, in whatever language it is spoken in. Respond with ONLY the transcription, written in that language\'s own native script — no commentary, no quotes, no translation, no romanization.';

// gemini-2.0-flash (ENGINE_GEMINI_MODEL, used for the fast text classifier/reply calls elsewhere)
// measurably under-transcribes audio next to Gemini's newer models, and that gap is worse for
// lower-resource Indic languages (Malayalam, etc.) than for English — accuracy, not just speed, is
// what matters for a customer's actual words, so transcription gets its own, stronger model rather
// than reusing the fast/cheap one.
const ENGINE_TRANSCRIBE_MODEL='gemini-2.5-flash';

// ISO 639-1 → language name, for a hint in the transcription prompt below (CLIENTS.language, e.g.
// 'ml' for a Malayalam-speaking client base). Forcing the model to simultaneously guess which
// language is being spoken AND transcribe it blind is a harder task than transcribing with a
// steer — Gemini's own docs note a language hint "noticeably improves accuracy on multilingual or
// accented audio". Not a hard constraint: the prompt still says "if it's actually a different
// language, transcribe that instead" so a customer who doesn't match the client's configured
// default language isn't mistranscribed into it.
const ENGINE_LANG_NAMES={en:'English', ml:'Malayalam', hi:'Hindi', ta:'Tamil', te:'Telugu', kn:'Kannada', bn:'Bengali', gu:'Gujarati', mr:'Marathi', pa:'Punjabi', or:'Odia', ar:'Arabic'};

// Downloads the voice note once (shared by both transcription attempts below, so a Gemini failure
// followed by the OpenRouter fallback doesn't re-fetch the same file from Meta/Chatwoot a second
// time) and base64-encodes it. Null on any fetch failure or an unexpectedly large file. Every
// failure branch reports via reportOpsError (not just STT's own two functions below) since a
// silent null here was previously indistinguishable from "transcription itself failed" — same
// blind spot that let the Sarvam TTS speaker-name bug go unnoticed. Retries once on a transient
// network/5xx blip (engineFetchWithRetry) before giving up.
async function engineFetchAudioBase64(env, mediaUrl){
  try{
    const audioR=await engineFetchWithRetry(mediaUrl, {});
    if(!audioR.ok){ await reportOpsError(env, 'engineFetchAudioBase64 — media fetch returned non-OK', new Error(`HTTP ${audioR.status}`), {mediaUrl}); return null; }
    // Chatwoot/Meta serve WhatsApp voice notes as "audio/ogg; codecs=opus" — strip the codec
    // parameter before handing this to Gemini's inline_data.mime_type, which expects a bare type.
    const rawContentType=audioR.headers.get('content-type')||'audio/ogg';
    const mimeType=rawContentType.split(';')[0].trim()||'audio/ogg';
    const buf=await audioR.arrayBuffer();
    if(buf.byteLength>15*1024*1024){ await reportOpsError(env, 'engineFetchAudioBase64 — audio file too large', new Error(`${buf.byteLength} bytes`), {mediaUrl}); return null; }
    // Real observed case: a near-instant tap-and-release voice note showed as 00:00 in Chatwoot's
    // own player — a file this small is essentially silence/container-only, not real speech.
    // Transcribing it anyway risks Gemini hallucinating plausible-sounding text from noise; treating
    // it as "too short" up front (tooShort, not null — a distinct outcome from a real fetch/size
    // failure) lets the caller ask the customer to resend instead of guessing.
    if(buf.byteLength<800) return {tooShort:true};
    return {mimeType, base64:engineArrayBufferToBase64(buf)};
  }catch(e){ await reportOpsError(env, 'engineFetchAudioBase64 — fetch threw', e, {mediaUrl}); return null; }
}

// Real voice transcription, via the same shared Gemini credential as the intent classifier —
// engine.json never actually had this wired up (voice notes went to the AI as a literal
// "(sent a voice note)" placeholder despite the docs describing transcription). Requires
// GEMINI_API_KEY; falls back to the literal placeholder in engineResolveUserText if it's unset or
// the call fails. Deliberately Gemini-only — no OpenRouter fallback (unlike text generation
// elsewhere in this file) since that path used OpenRouter's `input_audio` content part, which was
// never verified against a live call and was a plausible source of bad transcripts in its own
// right rather than a safety net.
async function engineGeminiTranscribeVoice(env, mimeType, base64, langHintCode, vocabHint){
  if(!env.GEMINI_API_KEY || !base64) return null;
  const langName=ENGINE_LANG_NAMES[(langHintCode||'').toLowerCase()];
  let prompt=langName
    ? `${ENGINE_TRANSCRIBE_PROMPT} This customer usually writes in ${langName}, so expect ${langName} unless the audio is clearly a different language — in that case transcribe the language actually spoken instead.`
    : ENGINE_TRANSCRIBE_PROMPT;
  // Business-specific vocabulary — brand/product/service names are exactly the kind of term a
  // general-purpose ASR model most commonly mishears (unfamiliar words, no context to disambiguate
  // against). A short list alongside the audio gives it real terms to match against instead of
  // guessing phonetically. Not a hard constraint: still transcribe whatever's actually said if it
  // doesn't match anything here.
  if(vocabHint) prompt+=` This business's own name/product/service names — spell these exactly as given if you hear something close to one, even if pronunciation is unclear: ${vocabHint}.`;
  try{
    const r=await engineFetchWithRetry(`https://generativelanguage.googleapis.com/v1beta/models/${ENGINE_TRANSCRIBE_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      // thinkingConfig disabled — see engineGeminiGenerationConfig's comment: gemini-2.5-flash
      // thinks by default and those tokens count against the same output budget, adding pure
      // latency/cost here with no benefit (transcription isn't a reasoning task).
      body:JSON.stringify({contents:[{role:'user', parts:[
        {text:prompt},
        {inline_data:{mime_type:mimeType, data:base64}}
      ]}], generationConfig:{thinkingConfig:{thinkingBudget:0}}})
    });
    if(!r.ok){
      const bodyText=await r.text().catch(()=>'');
      await reportOpsError(env, 'engineGeminiTranscribeVoice — Gemini returned non-OK', new Error(`HTTP ${r.status}: ${bodyText.slice(0,500)}`), {mimeType});
      return null;
    }
    const data=await r.json().catch(()=>({}));
    const parts=data?.candidates?.[0]?.content?.parts||[];
    const text=parts.map(p=>p.text||'').join('').trim();
    if(!text) await reportOpsError(env, 'engineGeminiTranscribeVoice — empty transcript in response', new Error(JSON.stringify(data).slice(0,500)), {mimeType});
    return text||null;
  }catch(e){ await reportOpsError(env, 'engineGeminiTranscribeVoice — request threw', e, {mimeType}); return null; }
}

// Direct Gemini text generation (engineGeminiGenerate) with an OpenRouter-routed Gemini model as
// backup when it's unavailable or fails, for plain-text (non-audio) generation calls — voice
// transcription (engineGeminiTranscribeVoice above) has no such fallback, deliberately Gemini-only.
// Deliberately hardcodes a Gemini model here rather than using the client's own `c.model` — the
// point of this fallback is specifically "still get a Gemini-quality answer", not "fall back to
// whatever model this client happens to have configured".
async function engineGeminiGenerateWithFallback(env, c, systemText, userText, opts={}){
  const direct=await engineGeminiGenerate(env, systemText, userText, opts);
  if(direct) return direct;
  if(!c?.openrouter_key) return null;
  try{
    const r=await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method:'POST', headers:{Authorization:`Bearer ${c.openrouter_key}`, 'Content-Type':'application/json'},
      body:JSON.stringify({
        model:'google/gemini-2.5-flash', temperature:opts.temperature??0.3, max_tokens:opts.maxOutputTokens||300,
        messages:[...(systemText?[{role:'system', content:systemText}]:[]), {role:'user', content:userText}]
      })
    });
    if(!r.ok) return null;
    const data=await r.json().catch(()=>({}));
    return data?.choices?.[0]?.message?.content?.trim()||null;
  }catch(e){ return null; }
}

function engineParseJsonField(raw, fallback){ try{ const v=JSON.parse(raw||''); return v??fallback; }catch(e){ return fallback; } }
function engineParseSalesReps(raw){
  try{ const a=JSON.parse(raw||'[]'); if(Array.isArray(a)&&a.length) return a; }catch(e){}
  return (raw||'').split('\n').map(s=>s.trim()).filter(Boolean);
}

function engineParseChatwootPayload(body){
  if(body.message_type && body.message_type!=='incoming') return null;
  if(body.private) return null;
  const conv=body.conversation||{};
  const sender=conv?.meta?.sender||body.sender||{};
  let phone=(sender.phone_number||sender.identifier||'').replace(/[^0-9+]/g,'').replace(/^\+/,'');
  if(phone.startsWith('00')) phone=phone.slice(2);
  const atts=body.attachments||body.message?.attachments||[];
  let mediaType='text', mediaUrl='';
  if(atts.length){
    const a=atts[0];
    mediaUrl=a.data_url||a.file_url||'';
    if((a.file_type||'').includes('audio')) mediaType='voice';
    else if((a.file_type||'').includes('image')) mediaType='image';
  }
  const text=(body.content||body.message?.content||'').trim();
  if(!phone) return null;
  if(mediaType==='text' && !text) return null;
  return {convId:conv?.id||null, phone, name:sender.name||'', text, mediaType, mediaUrl};
}

// Mirrors "HTTP · Get lead" + "Code · State": pulls every LEADS row for this phone across ALL
// clients (not scoped by client_id — same as engine.json), so a phone that's already a lead for
// a different client shows up as isDuplicate, matching the original's cross-tenant reporting.
async function engineGetLeadState(env, clientId, phone){
  const r=await ncFetch(env, `api/v2/tables/${DEFAULT_LEADS_TABLE}/records?where=(Phone,eq,${encodeURIComponent(phone)})&limit=100`);
  const d=await r.json().catch(()=>({}));
  const rows=d?.list||[];
  const lead=rows.find(l=>String(l.ClientId)===String(clientId))||null;
  const isDuplicate=rows.some(l=>String(l.ClientId)!==String(clientId));
  let history=[]; try{ history=JSON.parse(lead?.ConvHistory||'[]'); }catch(e){}
  const botMsgs=history.filter(m=>m.role==='assistant').slice(-3).map(m=>m.content);
  const looping=botMsgs.length===3 && botMsgs.every(m=>m===botMsgs[0]);
  // 20, not 6 — keep roughly the last 10 customer/bot exchanges as working memory instead of ~3,
  // so the bot still recalls what was discussed several turns back (ConvHistory itself has no
  // date-based staleness at all, only this count-based trim of what's "active" for the prompts).
  const activeHistory=history.length>20?history.slice(-20):history;
  let qualAnswers={}; try{ qualAnswers=JSON.parse(lead?.QualAnswers||'{}'); }catch(e){}
  return {
    lead, leadId:lead?.Id||null, stage:lead?.Stage||'new', history, activeHistory, looping,
    qualAnswers, isDuplicate, leadOptOut:lead?.OptOut||'No', owner:lead?.Owner||null,
    winProbabilityManual:lead?.WinProbabilityManual||'No', lastMsgAt:lead?.LastMsgAt||null
  };
}

// Mirrors "HTTP · Vision" + "Code · image→text" / "Code · text→text" — resolves whatever the
// customer sent into a single text string for the classifier + FAQ prompt to work with. Voice
// notes now get real transcription (engineGeminiTranscribeVoice, shared Gemini key) instead of
// engine.json's literal placeholder text; falls back to that same placeholder if transcription
// isn't available (no GEMINI_API_KEY set, fetch failure, oversized file, etc.) so the turn still
// completes instead of failing outright.
const ENGINE_IMAGE_DESCRIBE_PROMPT='Describe what this image shows in one short sentence, focused on anything relevant to a product or order enquiry.';

// Direct Gemini vision call (shared GEMINI_API_KEY), tried first — same Gemini-first-with-
// OpenRouter-fallback pattern as every other LLM call in this engine now uses. Null on any
// failure so engineResolveUserText falls back to the client's own OpenRouter key/model below.
async function engineGeminiDescribeImage(env, mediaUrl){
  if(!env.GEMINI_API_KEY || !mediaUrl) return null;
  try{
    const imgR=await fetch(mediaUrl);
    if(!imgR.ok) return null;
    const mimeType=imgR.headers.get('content-type')||'image/jpeg';
    const buf=await imgR.arrayBuffer();
    if(buf.byteLength>15*1024*1024) return null;
    const base64=engineArrayBufferToBase64(buf);
    const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${ENGINE_GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({contents:[{role:'user', parts:[
        {text:ENGINE_IMAGE_DESCRIBE_PROMPT},
        {inline_data:{mime_type:mimeType, data:base64}}
      ]}]})
    });
    if(!r.ok) return null;
    const data=await r.json().catch(()=>({}));
    const parts=data?.candidates?.[0]?.content?.parts||[];
    const t=parts.map(p=>p.text||'').join('').trim();
    return t||null;
  }catch(e){ return null; }
}

// Domain-vocabulary hint for engineGeminiTranscribeVoice — the business's own name plus its
// product/service names (same c.services field engineBuildFaqSystemPrompt already reads), since a
// customer's voice note mentioning these is exactly the kind of term a general-purpose ASR model
// most commonly mishears (unfamiliar brand/product names it has zero prior context for). Capped
// short — this rides along on every single voice note, so it stays a lightweight nudge rather than
// a full catalog dump inflating every transcription call.
function engineBuildTranscribeVocabHint(c){
  const terms=[];
  if(c.client_name) terms.push(c.client_name);
  const services=engineParseJsonField(c.services, []);
  for(const s of services){
    if(s?.name) terms.push(s.name);
    if(terms.length>=15) break;
  }
  return terms.join(', ');
}

async function engineResolveUserText(env, c, mediaType, mediaUrl, text){
  if(mediaType==='image' && mediaUrl){
    const geminiDesc=await engineGeminiDescribeImage(env, mediaUrl);
    if(geminiDesc) return geminiDesc;
    try{
      const r=await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method:'POST', headers:{Authorization:`Bearer ${c.openrouter_key}`, 'Content-Type':'application/json'},
        body:JSON.stringify({model:c.model||'google/gemini-2.5-flash', max_tokens:100, messages:[{role:'user', content:[
          {type:'text', text:ENGINE_IMAGE_DESCRIBE_PROMPT},
          {type:'image_url', image_url:{url:mediaUrl}}
        ]}]})
      });
      const data=await r.json().catch(()=>({}));
      return data?.choices?.[0]?.message?.content||'(image received)';
    }catch(e){ return '(image received)'; }
  }
  if(mediaType==='voice' && mediaUrl){
    const audio=await engineFetchAudioBase64(env, mediaUrl);
    // A too-short/near-silent recording skips the Gemini call entirely (see
    // engineFetchAudioBase64) — there's nothing real to transcribe, and asking Gemini anyway risks
    // it hallucinating plausible-sounding text from noise. Distinct placeholder from the generic
    // one below so the AI's reply naturally asks the customer to resend, rather than answering a
    // fabricated question.
    if(audio?.tooShort) return '(sent a voice note that was too short/silent to make out — ask them to resend)';
    const transcript=audio?await engineGeminiTranscribeVoice(env, audio.mimeType, audio.base64, c.language, engineBuildTranscribeVocabHint(c)):null;
    return transcript || '(sent a voice note)';
  }
  return text || (mediaType==='voice'?'(sent a voice note)':'');
}

// Mirrors "AI Agent · Sentiment & Intent" + "Code · Intent classify" — structured
// intent/sentiment/objection/win-probability classification, with the same deterministic regex
// fast-paths/fallback ladder layered on top (instant, free, and safety-critical for WANTS_HUMAN,
// so a lead can always reach a human even if the AI call fails, times out, or returns garbage).
// Tries the shared Gemini credential first (matching engine.json's actual node setup — this
// classifier ran on a dedicated Google Gemini model, not each client's own OpenRouter key), and
// only falls back to the client's own OpenRouter key/model if GEMINI_API_KEY isn't configured on
// this Worker or the Gemini call fails — so classification still works before that secret is set.
// temperature 0.1 (was 0.3) — observed live, the identical message classified differently on two
// separate deliveries a moment apart, one of which triggered a false-positive human handover (see
// engineRouteFlow's humanReason for the actual fix); lower temperature won't make classification
// perfectly deterministic, but reduces exactly this kind of unforced flip on unambiguous input.
// Serializes flow_json's configured stages into one consistent block, shared by
// engineClassifyIntent (asks the model which stage the conversation is now at) and the FAQ/
// objection reply prompts (lets the model naturally work toward the current stage's point in its
// own words) — one view of this data feeding whichever LLM call needs it, instead of a separate
// deterministic dispatcher that owned it exclusively (see SETUP.md's "Conversation Engine" for the
// designs that preceded this one). Empty string when the client hasn't configured any stages, so
// a client not using this feature pays nothing extra for it.
function engineFlowStagesBlock(c, currentStage){
  const flow=engineParseJsonField(c.flow_json, {});
  const stageIds=Object.keys(flow.stages||{}).filter(k=>k!=='new');
  if(!stageIds.length) return '';
  const lines=stageIds.map((id,i)=>`${i+1}. "${id}": ${flow.messages?.['msg_'+id]||''}`).join('\n');
  return `\n\nSales stages configured for this business, in order:\n${lines}\n\nCurrently at stage: "${currentStage||stageIds[0]}".`;
}

async function engineClassifyIntent(env, c, userText, activeHistory, currentStage){
  const low=userText.trim().toLowerCase();
  const recent=(activeHistory||[]).slice(-4).map(m=>m.role+': '+m.content).join('\n');
  const flow=engineParseJsonField(c.flow_json, {});
  const stageIds=Object.keys(flow.stages||{}).filter(k=>k!=='new');
  // Folds flow_json's stage progression into this same classification call as one more judgment
  // call — the model reports next_stage the same way it already reports intent/sentiment/language
  // — instead of a separate rigid state-machine lookup with its own message-sending path. Same
  // reliability trade-off the rest of this classifier already lives with: a judgment call, not a
  // deterministic lookup, validated against the real configured stage ids below before use.
  const stageInstruction=stageIds.length?', next_stage (see Sales stages below — whichever listed stage id best reflects where this conversation stands after the latest message; usually unchanged unless it has clearly progressed toward or past the next one; must be exactly one of the listed ids, quoted exactly as given)':'';
  const systemText=`You are a classifier for a WhatsApp sales conversation. Given the latest customer message and recent conversation, return ONLY compact JSON (no prose, no markdown, no code fences) with keys: intent (one of DELAY, BOOKING, AFFIRMATIVE, WATCHED, FORM_DONE, QUESTION, WANTS_HUMAN, SHORT_NEUTRAL), sentiment (one of Positive, Neutral, Negative, Frustrated), objection (one of none, price, competitor, timing, trust), confidence (number 0 to 1), win_probability (integer 0 to 100 — your best estimate of the odds this lead closes, based on their tone, urgency, and how the conversation is going), language (ISO 639-1 two-letter code of the language the LATEST message itself is written in, e.g. "en", "ml", "hi", "ar", "ta" — your best guess even for a short message; if genuinely unreadable/ambiguous, use the language of the recent conversation instead)${stageInstruction}.${engineFlowStagesBlock(c, currentStage)}`;
  const userPrompt=`Recent conversation:\n${recent}\n\nLatest message: ${userText}`;

  // Both attempts below used to swallow every failure via a bare `catch(e){}` — with aiResult left
  // null, customerLanguage below falls back to c.language (usually 'en'), so a classifier failure
  // silently reads as "reply in English" for a customer who spoke/wrote another language entirely,
  // with zero trace of why. reportOpsError here closes that blind spot (same fix already applied
  // to voice transcription and Sarvam TTS above).
  let aiResult=null;
  try{
    const geminiRaw=await engineGeminiGenerate(env, systemText, userPrompt, {temperature:0.1, maxOutputTokens:200, json:true});
    if(geminiRaw){
      try{ aiResult=JSON.parse(geminiRaw); }
      catch(e){ await reportOpsError(env, 'engineClassifyIntent — Gemini returned unparseable JSON', e, {geminiRaw:geminiRaw.slice(0,500)}); }
    }
  }catch(e){ await reportOpsError(env, 'engineClassifyIntent — Gemini request threw', e); }

  if(!aiResult && c.openrouter_key){
    try{
      const r=await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method:'POST', headers:{Authorization:`Bearer ${c.openrouter_key}`, 'Content-Type':'application/json'},
        body:JSON.stringify({
          model:c.model||'google/gemini-2.5-flash', temperature:0.1, max_tokens:200,
          messages:[{role:'system', content:systemText}, {role:'user', content:userPrompt}]
        })
      });
      if(!r.ok){
        const bodyText=await r.text().catch(()=>'');
        await reportOpsError(env, 'engineClassifyIntent — OpenRouter returned non-OK', new Error(`HTTP ${r.status}: ${bodyText.slice(0,500)}`));
      }else{
        const data=await r.json().catch(()=>({}));
        const raw=data?.choices?.[0]?.message?.content||'';
        const m=raw.replace(/```json|```/gi,'').match(/\{[\s\S]*\}/);
        if(m){
          try{ aiResult=JSON.parse(m[0]); }
          catch(e){ await reportOpsError(env, 'engineClassifyIntent — OpenRouter returned unparseable JSON', e, {raw:raw.slice(0,500)}); }
        }else{
          await reportOpsError(env, 'engineClassifyIntent — no JSON object in OpenRouter response', new Error(raw.slice(0,500)));
        }
      }
    }catch(e){ await reportOpsError(env, 'engineClassifyIntent — OpenRouter request threw', e); }
  }

  if(!aiResult) await reportOpsError(env, 'engineClassifyIntent — both Gemini and OpenRouter failed, using keyword/default fallback for intent+language', new Error('no aiResult'), {hasOpenrouterKey:!!c.openrouter_key});

  const VALID_INTENTS=new Set(['DELAY','BOOKING','AFFIRMATIVE','WATCHED','FORM_DONE','QUESTION','WANTS_HUMAN','SHORT_NEUTRAL']);
  const VALID_SENTIMENT=new Set(['Positive','Neutral','Negative','Frustrated']);
  const VALID_OBJECTION=new Set(['none','price','competitor','timing','trust']);
  let intent=null, intentData={};

  if(/\b(human|agent|person|speak to|talk to|call me|contact me|representative|support|helpline|manager)\b/.test(low)) intent='WANTS_HUMAN';
  if(!intent){
    const bookMatch=low.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|\d{1,2}[:\/\-]\d{1,2}|\d{1,2}\s*(am|pm)|morning|afternoon|evening|tonight|next week)\b/);
    if(bookMatch){ intent='BOOKING'; intentData={booking_time:userText}; }
  }
  if(!intent && aiResult && VALID_INTENTS.has(aiResult.intent) && (aiResult.confidence===undefined||aiResult.confidence>=0.5)){
    intent=aiResult.intent;
    if(intent==='BOOKING') intentData={booking_time:userText};
  }
  if(!intent && /\b(watched|seen it|already watched|i saw|viewed|i watched|just watched)\b/.test(low)) intent='WATCHED';
  if(!intent && /\b(filled|submitted|done the form|form done|completed the form|i filled|i submitted)\b/.test(low)) intent='FORM_DONE';
  if(!intent && /\b(later|not now|busy|maybe later|some other time|not interested yet|remind me|another time|not ready|will think)\b/.test(low)) intent='DELAY';
  if(!intent && /^(hi|hello|hey|hii|helo|hola|salam|namaste|good morning|good afternoon|good evening|sup|yo)[\.!]*$/.test(low)) intent='SHORT_NEUTRAL';
  if(!intent && /^(yes|yeah|yep|yup|ok|okay|sure|alright|confirmed|confirm|agreed|agree|proceed|go ahead|done|noted|sounds good|perfect|absolutely|definitely|of course)[\.!]*$/.test(low)) intent='AFFIRMATIVE';
  if(!intent){ intent='QUESTION'; intentData={question:userText}; }

  const sentiment=(aiResult && VALID_SENTIMENT.has(aiResult.sentiment))?aiResult.sentiment:'Neutral';
  const objectionCategory=(aiResult && VALID_OBJECTION.has(aiResult.objection))?aiResult.objection:'none';
  const wpRaw=Number(aiResult?.win_probability);
  const aiWinProbability=Number.isFinite(wpRaw)?Math.max(0,Math.min(100,Math.round(wpRaw))):null;
  // Per-message detected language, not the client's fixed CLIENTS.language setting — a client
  // configures one default language for their own scripted content (flow_json, qual_questions),
  // but an actual customer can write in any language, and both the AI-generated replies and (via
  // engineLocalizeReply) the client's static scripted text should follow the customer, not a
  // one-size-fits-all default. Null when the model didn't return a recognizable 2-letter code —
  // callers fall back to CLIENTS.language themselves.
  const rawLang=typeof aiResult?.language==='string'?aiResult.language.trim().toLowerCase():'';
  const customerLanguage=/^[a-z]{2}$/.test(rawLang)?rawLang:null;
  const rawStage=typeof aiResult?.next_stage==='string'?aiResult.next_stage.trim():'';
  const nextStage=stageIds.includes(rawStage)?rawStage:null;
  return {intent, intentData, sentiment, objectionCategory, aiWinProbability, customerLanguage, nextStage};
}

// Mirrors "Code · Intent + flow" — decides where this turn goes (human handover / qualify / FAQ /
// objection) and what the next stage is. FAQ routing is industry-aware (industryFaqRoute below),
// matching engine.json's own industry-conditional routing rather than hardcoding one industry's
// behavior. flow_json's configured stages no longer own a dispatch path of their own — see
// engineFlowStagesBlock/engineClassifyIntent's own comments for why (two designs that gave stage
// content its own message-sending path both caused real, observed bugs: a glued-together bubble,
// then a verbatim message repeating itself every single question a prospect asked in a row).
// Stage progression is now `cls.nextStage`, the classifier's own judgment call (same reliability
// trade-off as intent/sentiment/language already are), and stage content only ever reaches the
// customer as guidance inside the same FAQ/objection reply — see engineBuildFaqSystemPrompt.
function engineRouteFlow(c, state, userText, cls){
  const {intent, intentData, sentiment, objectionCategory, aiWinProbability, customerLanguage, nextStage}=cls;
  const lowText=userText.toLowerCase().trim();
  const isOptOut=ENGINE_OPT_OUT_WORDS.includes(lowText);
  const isResub=lowText==='start' && state.leadOptOut==='Yes';
  if(isOptOut) return {route:'qualify_next', next:state.stage, reply:'You have been unsubscribed. Reply START to re-subscribe.', qualAnswers:state.qualAnswers, intentData:{}, intent, sentiment, objectionCategory, aiWinProbability, customerLanguage, isOptOut:true, isResub:false};
  if(isResub) return {route:'qualify_next', next:'new', reply:'Welcome back! You are re-subscribed.', qualAnswers:state.qualAnswers, intentData:{}, intent, sentiment, objectionCategory, aiWinProbability, customerLanguage, isOptOut:false, isResub:true};

  const botConfig=engineParseJsonField(c.bot_config, {});
  const qualQuestions=engineParseJsonField(c.qual_questions, []);
  const flow=engineParseJsonField(c.flow_json, {});
  // Mirrors engine.json's `industry === 'ecommerce' ? 'ecom_faq' : (industry === 'travel' ?
  // 'travel_faq' : 'faq')` — which industry-specific FAQ context (if any) this client's grounded
  // answers should pull in.
  const industry=c.industry||'general';
  const industryFaqRoute=industry==='ecommerce'?'ecom_faq':(industry==='travel'?'travel_faq':'faq');
  let effIntent=intent;
  if(state.looping && botConfig.antiloop_enabled!==false) effIntent='WANTS_HUMAN';

  const qualDone=!qualQuestions.length || botConfig.qual_enabled===false || (state.stage && !state.stage.startsWith('qual_') && state.stage!=='new');
  const qualStage=state.stage?.startsWith('qual_')?parseInt(state.stage.replace('qual_','')):null;

  const POSITIVE=new Set(['AFFIRMATIVE','WATCHED','FORM_DONE','BOOKING','SHORT_NEUTRAL']);
  const NEGATIVE=new Set(['DELAY','WANTS_MORE_INFO']);
  const allStages=Object.keys(flow.stages||{}).filter(k=>k!=='new');
  // Real observed failure: a client with only ONE stage configured (still finishing their
  // funnel setup) had every lead auto-escalate to a human on the very first positive reply — a
  // plain "ok" or even just a greeting — because with just one stage, it's trivially both the
  // first AND the last stage, so engine.json's own "reached the final stage with a positive
  // reply → handover" signal (correct for a real, completed multi-stage funnel) fired
  // immediately for everyone. Requiring at least 2 real stages before honoring that signal means
  // an unfinished/minimal funnel just gets normal FAQ replies instead of blanket premature
  // handover, while a genuinely completed funnel (2+ stages) keeps the original behavior exactly.
  const isFinalStage=allStages.length>1 && state.stage===allStages[allStages.length-1];

  let reply='', route='', humanReason=null;
  let next=nextStage||state.stage;

  // humanReason distinguishes a genuine "customer wants a human" moment (explicit ask, or real
  // frustration) from the isFinalStage+POSITIVE branch below — an internal funnel-completion
  // heuristic ("a positive reply on the last configured stage probably means ready to talk to
  // someone"), not an actual signal the customer asked for a person. That heuristic can misfire on
  // AI intent-classification noise: the exact same message ("Red Shirt small size") was observed
  // live getting classified as AFFIRMATIVE on one delivery and QUESTION on an identical resend a
  // moment later, sending the first copy to a human-handover reply instead of the product details
  // the second copy correctly got. handleEngineWebhook's order-signal check (which runs before this
  // whole dispatch) uses humanReason to still recognize an unambiguous product enquiry/order even
  // when route ends up 'human' for this non-explicit reason, but never overrides an explicit ask or
  // real frustration — see that check's own comment.
  if(effIntent==='WANTS_HUMAN' && botConfig.handover_enabled!==false){ route='human'; humanReason='explicit'; }
  else if(isFinalStage && POSITIVE.has(effIntent) && botConfig.handover_enabled!==false){
    // Reached the end of the funnel with a positive reply — this used to hand straight over to a
    // human with no order/trial link ever sent. Real product requirement: when a self-serve link
    // is configured (Order Link in Integrations, or a Cal.com link), try to let the customer
    // convert themselves right here first — 'selfserve' is a plain scripted send (handled in
    // handleEngineWebhook exactly like qualify_next), not an LLM reply, so this exact link always
    // goes out. Human handover for this internal heuristic (not an actual request from the
    // customer) is now reserved for the genuine case: no self-serve link exists at all, so a human
    // really is the only way forward — see this file's "human handover only when exactly required"
    // requirement. An explicit WANTS_HUMAN or Frustrated-sentiment handover (both below/above) are
    // untouched by this — those are real requests, always honored immediately regardless of link.
    const selfServeLink=(c.external_store_link||c.cal_link||'').trim();
    if(selfServeLink){
      route='selfserve';
      reply=(botConfig.selfserve_msg||"Great, you're all set! Go ahead right here:")+'\n\n👉 '+selfServeLink;
    } else {
      route='human'; humanReason='final_stage_positive';
      const tz=botConfig.timezone||'Asia/Kolkata';
      const nowLocal=new Date(new Date().toLocaleString('en-US',{timeZone:tz}));
      const hour=nowLocal.getHours(), day=nowLocal.getDay();
      let callLabel='tomorrow';
      if(hour<9 && day>=1 && day<=5) callLabel='today';
      else if(day===6) callLabel='on Monday';
      else if(day===0) callLabel='tomorrow (Monday)';
      reply=botConfig.callback_msg||`Thank you! 🙏 Our team will contact you ${callLabel} at 9am. We look forward to speaking with you!`;
    }
  }
  // Reachable only when a client has opted into CLIENTS.handover_silence_enabled='Yes' (Settings →
  // Human Handover — off by default, so the bot keeps replying after handover unless a client
  // explicitly wants it silenced). handleEngineWebhook's own hard-stop already returns before
  // routing is computed at all in the default (silence-off) case; when that hard-stop IS skipped
  // (handover_silence_enabled='No'), without this exception every such reply would still get
  // forced to 'drop' right here regardless.
  else if(state.stage==='human_handover' && c.handover_silence_enabled==='Yes') route='drop';
  // A QUESTION (or NEGATIVE) always gets a clean FAQ answer before qualification even gets a
  // chance to run — matches the original precedence (a customer asking something mid-qualification
  // still gets answered, not another qualifying question).
  else if(effIntent==='QUESTION' || NEGATIVE.has(effIntent)) route=industryFaqRoute;
  else if(!qualDone && qualStage===null) route='qualify';
  else if(!qualDone && qualStage!==null) route='qualify_next';
  else route=industryFaqRoute;

  if(sentiment==='Frustrated' && route!=='human' && botConfig.handover_enabled!==false){
    route='human'; humanReason='explicit';
    reply=botConfig.callback_msg_frustrated||botConfig.callback_msg||"I'm sorry about that — connecting you with our team right now so we can help properly.";
  } else if(objectionCategory!=='none' && ['faq','ecom_faq','travel_faq'].includes(route) && botConfig.objection_handling_enabled!==false){
    route='objection';
  }

  let qualAnswers={...state.qualAnswers};
  if(route==='qualify_next'){
    const currentIdx=qualStage!==null?qualStage:0;
    const nextIdx=currentIdx+1;
    if(qualQuestions[currentIdx]) qualAnswers[qualQuestions[currentIdx]]=userText;
    if(nextIdx<qualQuestions.length){
      // qual_questions is documented/expected as an array of plain strings, but it's client-
      // editable JSON with no schema enforcement — coerce defensively so a malformed entry (an
      // object, a number, etc.) can never reach the Chatwoot/WhatsApp send as a non-string value.
      reply=typeof qualQuestions[nextIdx]==='string'?qualQuestions[nextIdx]:String(qualQuestions[nextIdx]??'');
      next='qual_'+nextIdx;
    } else {
      // The one place flow_json content is still sent verbatim — the single, one-time transition
      // from "just finished qualifying" to "now starting the sales stages." Unlike the old
      // per-question stage dispatch this doesn't re-fire on every turn (it only happens once per
      // lead, the moment qualification completes), so the verbatim-repetition bug class this file
      // moved away from elsewhere doesn't apply here.
      const firstStage=Object.keys(flow.stages||{}).filter(k=>k!=='new')[0]||'new';
      const firstAction=(flow.stages?.[firstStage]||{})['*']||{next:firstStage, msg:null};
      const vars=flow.variables||{};
      reply=(flow.messages?.[firstAction.msg]||'Great, thanks! Let me share some information 😊').replace(/\[(\w+)\]/g,(_,k)=>vars[k]??'');
      next=firstAction.next||firstStage;
    }
  }

  if(effIntent==='BOOKING' && c.cal_link && !reply.includes(c.cal_link)){
    reply=(reply||'Great! You can book your slot here 📅')+'\n\n👉 '+c.cal_link;
  }

  return {route, next, reply, qualStage, qualAnswers, intentData, intent:effIntent, sentiment, objectionCategory, aiWinProbability, customerLanguage, isOptOut:false, isResub:false, humanReason};
}

// From-scratch equivalent of the "Leadvyne · Ecom Context" n8n sub-workflow (not in this repo) —
// live product catalog + this phone's recent order status, built off the same ecom tables
// ecom.html and /ecom/* already read.
async function engineBuildEcomContext(env, c, clientId, phone){
  const lines=[];
  const productsTable=await ecomResolveTable(env, clientId, 'products');
  if(productsTable){
    const pr=await ncFetch(env, `api/v2/tables/${productsTable}/records?where=(client_id,eq,${clientId})~and(status,neq,inactive)&limit=30&fields=name,sku,price,currency,stock,color,size,category`);
    const pd=await pr.json().catch(()=>({}));
    const products=pd?.list||[];
    if(products.length){
      lines.push('## Product Catalog (partial — ask if something specific isn\'t listed)');
      products.forEach(p=>lines.push(`- ${p.name}${p.sku?' [sku:'+p.sku+']':''} — ${p.currency||''} ${p.price??''}${p.color?' color:'+p.color:''}${p.size?' size:'+p.size:''}${p.category?' category:'+p.category:''} — ${(p.stock>0)?'in stock':'out of stock'}`));
    }
  }
  const ordersTable=await ecomResolveTable(env, clientId, 'orders');
  if(ordersTable && phone){
    const or=await ncFetch(env, `api/v2/tables/${ordersTable}/records?where=(client_id,eq,${clientId})~and(customer_phone,eq,${encodeURIComponent(phone)})&limit=5&sort=-order_date`);
    const od=await or.json().catch(()=>({}));
    const orders=od?.list||[];
    if(orders.length){
      lines.push('## This customer\'s recent orders');
      orders.forEach(o=>lines.push(`- ${o.order_id}: ${o.items||'(items unspecified)'} — ${o.currency||''} ${o.total??''} — status: ${o.status}`));
    }
  }
  lines.push(`## Order Link\nWhen a customer is ready to buy, share this link: ${buildOrderLink(c, clientId)}`);
  return lines.length?('\n\n'+lines.join('\n')):'';
}

// Same per-client per-kind lookup pattern as ecomResolveTable/apptResolveTable, for the Travel
// Agency module's own tables (ta_table_ids — see TA_TABLE_TITLES in dashboard.html).
function taResolveTable(c, kind){
  try{ return (JSON.parse(c.ta_table_ids||'{}'))[kind]||null; }catch(e){ return null; }
}

// Shared by every TA list-type field (packages.inclusions/exclusions, cars.features, ...) — all
// of them are saved as a JSON-stringified array by both the dashboard form and CSV import (see
// dashboard.html's taParseImportRows / package+car save handlers). Parsing back to a plain list
// here is what keeps raw ["a","b"] JSON syntax from ever reaching a customer-facing reply.
function taFormatList(raw){
  const v=engineParseJsonField(raw, null);
  if(Array.isArray(v)) return v.filter(Boolean).join(', ');
  return raw||'';
}

// Travel-industry equivalent of engineBuildEcomContext, for the 'travel_faq' route — engine.json's
// "Leadvyne · TA Context" sub-workflow wasn't available to port either, so this is the same
// from-scratch approach: built directly off the Travel Agency module's own packages/Umrah-group/
// car-rental tables instead of whatever that sub-workflow used to assemble.
async function engineBuildTravelContext(env, c, clientId){
  const lines=[];
  const today=new Date().toISOString().slice(0,10);
  const packagesTable=taResolveTable(c, 'packages');
  if(packagesTable){
    const pr=await ncFetch(env, `api/v2/tables/${packagesTable}/records?where=(client_id,eq,${clientId})&limit=25&fields=name,type,destination,nights,pax_min,pax_max,currency,sell_price,inclusions,exclusions`);
    const pd=await pr.json().catch(()=>({}));
    const pkgs=pd?.list||[];
    if(pkgs.length){
      lines.push('## Travel Packages');
      pkgs.forEach(p=>{
        const incText=taFormatList(p.inclusions);
        const excText=taFormatList(p.exclusions);
        let line=`- ${p.name} (${p.type||'package'}) — ${p.destination||''}, ${p.nights??''} nights, ${p.pax_min??''}-${p.pax_max??''} pax — ${p.currency||''} ${p.sell_price??''}`;
        if(incText) line+=' — includes: '+incText.slice(0,150);
        if(excText) line+=' — excludes: '+excText.slice(0,100);
        lines.push(line);
      });
    }
  }
  const umrahTable=taResolveTable(c, 'umrah_groups');
  if(umrahTable){
    // departure_date filter drops trips that have already left; pilgrims is fetched so remaining
    // seats (not the gross `seats` capacity) is what actually gets quoted, and groups with no
    // seats left are excluded rather than being offered as if they were bookable — mirrors the
    // dashboard's own upcoming-groups filter (generateDealCoach's umrahText) and pilgrims/seats fill math.
    const ur=await ncFetch(env, `api/v2/tables/${umrahTable}/records?where=(client_id,eq,${clientId})~and(departure_date,gte,${today})&limit=25&fields=name,departure_date,return_date,seats,makkah_hotel,madinah_hotel,makkah_nights,madinah_nights,price_per_pax,currency,pilgrims`);
    const ud=await ur.json().catch(()=>({}));
    const groups=(ud?.list||[]).map(g=>{
      const pilgrims=engineParseJsonField(g.pilgrims, []);
      const booked=Array.isArray(pilgrims)?pilgrims.length:0;
      return {...g, remaining:Math.max(0,(g.seats||0)-booked)};
    }).filter(g=>g.remaining>0).slice(0,15);
    if(groups.length){
      lines.push('## Umrah Groups');
      groups.forEach(g=>{
        const nightsText=(g.makkah_nights||g.madinah_nights)?`, ${g.makkah_nights??0}N Makkah / ${g.madinah_nights??0}N Madinah`:'';
        lines.push(`- ${g.name} — departs ${g.departure_date||'TBA'}, returns ${g.return_date||'TBA'}${nightsText}, ${g.remaining} seat(s) left — Makkah: ${g.makkah_hotel||''}, Madinah: ${g.madinah_hotel||''} — price ${g.currency||''} ${g.price_per_pax??''} per pax`);
      });
    }
  }
  const carsTable=taResolveTable(c, 'cars');
  if(carsTable){
    const cr=await ncFetch(env, `api/v2/tables/${carsTable}/records?where=(client_id,eq,${clientId})~and(status,eq,available)&limit=30&fields=Id,name,make,model,year,category,seats,daily_rate,currency,features`);
    const cd=await cr.json().catch(()=>({}));
    let cars=cd?.list||[];
    // The `status` column alone is stale — a car can stay marked "available" while it's out on an
    // active booking. Cross-check ta_car_bookings the same way dashboard.html's own per-car status
    // badge does (pickup_date<=today<=dropoff_date on a non-cancelled/completed booking) so the bot
    // never offers a car that is actually on the road right now.
    const carBookingsTable=cars.length?taResolveTable(c, 'car_bookings'):null;
    if(carBookingsTable){
      const br=await ncFetch(env, `api/v2/tables/${carBookingsTable}/records?where=(client_id,eq,${clientId})~and(status,neq,cancelled)~and(status,neq,completed)~and(pickup_date,lte,${today})~and(dropoff_date,gte,${today})&limit=100&fields=car_id`);
      const bd=await br.json().catch(()=>({}));
      const outNow=new Set((bd?.list||[]).map(b=>String(b.car_id)));
      cars=cars.filter(car=>!outNow.has(String(car.Id)));
    }
    cars=cars.slice(0,15);
    if(cars.length){
      lines.push('## Rental Cars Available');
      cars.forEach(car=>{
        const featText=taFormatList(car.features);
        lines.push(`- ${car.name||(car.make+' '+car.model)} (${car.year??''}, ${car.category||''}, ${car.seats??''} seats) — ${car.currency||''} ${car.daily_rate??''}/day${featText?' — features: '+featText.slice(0,100):''}`);
      });
    }
  }
  return lines.length?('\n\n'+lines.join('\n')):'';
}

// Mirrors "Code · FAQ prep" (contextBlock omitted, industry !== 'ecommerce'/'travel') /
// "Code · Ecom FAQ prep" (industry === 'ecommerce') / "Code · Travel FAQ prep"
// (industry === 'travel') — one function, parameterized, instead of three near-duplicates.
function engineBuildFaqSystemPrompt(c, state, contextBlock, industry, replyLang, isNewLead){
  const history=state.activeHistory||[];
  const lang=replyLang||c.language||'en';
  let sys=c.main_prompt||'';
  const services=engineParseJsonField(c.services, []);
  const defaultCurrency=industry==='ecommerce'?'INR':'AED';
  const defaultUnit=industry==='ecommerce'?'item':'person';
  if(services.length){
    sys+='\n\n## Services\n'+services.map(s=>`- ${s.name}: ${s.description||''} | Price: ${s.currency||defaultCurrency} ${s.price} per ${s.per||defaultUnit}`).join('\n');
  }
  if(c.kb_summary && c.kb_summary.trim()) sys+='\n\n## Knowledge Base\n'+c.kb_summary.slice(0,2000);
  if(contextBlock) sys+=contextBlock;
  // First-ever message from this lead — give a short, natural intro to what the business offers
  // (drawing on Services/Knowledge Base above) before/alongside answering, instead of jumping
  // straight into an answer with no context on who they're talking to. Short and blended into the
  // reply, not a separate canned welcome message — the "keep it as short as the customer's own
  // message" instruction below still applies on top of this.
  if(isNewLead) sys+='\n\nThis is this customer\'s very first message to you. Before or alongside your answer, briefly introduce what the business offers in one short sentence (from the Services/Knowledge Base above) — a natural, warm opener, not a full catalog dump.';
  // Last ~10 exchanges (activeHistory is already capped there) — a short attribute-only reply
  // ("order M size") needs the assistant's own prior product-listing message to still be in view
  // to resolve against (see the instruction below), and a returning customer's earlier stated
  // preferences should still be visible several turns later, not just the last couple of messages.
  if(history.length) sys+='\n\n## Recent Conversation\n'+history.slice(-20).map(m=>m.role+': '+m.content).join('\n');

  // Observed real failure: with no concrete data to answer from (e.g. an unconfigured product/
  // package catalog), the model didn't just say it would connect the customer with support — it
  // fabricated "our human agent is ALREADY looking into this and will be in touch shortly," when
  // no handover of any kind had actually happened. That's a trust problem independent of whatever
  // data gap caused it: never imply a human is already engaged unless one genuinely is (this route
  // only runs pre-handover in the first place — see engineRouteFlow — so it never legitimately is).
  sys+='\n\nNever claim a human agent, advisor, or your team is "already" looking into something or has been notified — that has not happened. If you cannot answer from the data above, say plainly that you do not have that specific information and will find out / connect them with the team, as something you are about to do, not something already in progress.';

  // Observed real failure #1: a customer's plain "Hi" got a long, salesy paragraph back — a full
  // "welcome to the store, what are you looking for, let me know your size and color" pitch nobody
  // asked for. Match the customer's own effort/length instead of maximizing how much gets said in
  // one reply, and never volunteer price unless it's actually asked about or genuinely needed to
  // answer — a real salesperson doesn't open with a price list either.
  // Observed real failure #2, the opposite direction: a customer's short, specific question (how
  // many days is the free trial — info that WAS in main_prompt above) got an equally short reply
  // that answered wrong rather than giving the real number, seemingly because "match their length"
  // pushed toward brevity over substance. A short question is about tone/effort, not permission to
  // skip the actual fact being asked for — so the two failure modes get distinct instructions
  // instead of one rule that (as observed) can be read as license for either.
  sys+='\n\nDefault style (follow this unless the persona/instructions above specify a different tone, reply length, closing style, or message format — in that case, follow those instead): a short greeting or small talk deserves a short, natural reply, not a long pitch covering everything you could possibly say — but a short, specific question (a number, a policy, a fact) always deserves the real, complete answer, even if that makes the reply a bit longer than the question itself; never trade accuracy or completeness for brevity. Do not volunteer price unless the customer asked about price/cost or you genuinely need to state it to answer their question. Sound like a real person texting, not a scripted sales script — warm and natural, no corporate phrasing, no more than one emoji per message.';

  if(industry==='ecommerce'){
    sys+='\n\nCurrent stage: '+(state.stage||'new')+'. Respond ONLY in '+lang+'. Never switch languages. You are an ecommerce assistant — answer questions about products, orders, pricing, and delivery using the data above.';
    // Observed real failure, paired with the routing change above: a product listed sizes "S, M,
    // L, XL" (one row, no per-size stock breakdown in this data model — the size field just lists
    // every size that product comes in), and the assistant still told the customer "we don't have
    // any products in that size" — fabricating a specific-size stock answer the data can't
    // actually support. Only the whole product's `stock` count is real; there is no per-size
    // number to check.
    sys+=' A product\'s size field lists every size it is made in — never claim a size listed there is out of stock or unavailable; only the product\'s overall stock count (available vs. not) is real data you have. If stock is 0 or the product genuinely is not in the catalog, say that honestly instead of guessing.';
    // Closes an observed real failure: a customer replied "Order M size" to a product the
    // assistant had just shown sizes for, and got "we don't have anything matching" back instead
    // of the shown product — because a bare size/color reply carries no signal on its own, only in
    // light of what was just discussed. detectOrderSignal (the separate order-link auto-send) has
    // its own version of this same instruction; this is the main conversational reply's version.
    sys+=' A short reply that only mentions a size, color, quantity, or says something like "that one"/"the green one" — with no product name — almost always refers to whichever specific product you (the assistant) most recently described in the Recent Conversation above. Resolve it to that exact product (use its real SKU/price/stock from the catalog above) instead of treating it as a fresh, unscoped catalog search — only ask which product they mean if the recent conversation genuinely doesn\'t make it clear. If specific details are not available even after resolving the product, politely say you will connect them with support.';
  } else if(industry==='travel'){
    sys+='\n\nCurrent stage: '+(state.stage||'new')+'. Respond ONLY in '+lang+'. Never switch languages. You are a travel assistant — answer questions about packages, Umrah groups, itineraries, and car rentals using the data above. A short reply like "the 30 min one" or "that package" with no name almost always refers to whichever specific package/service you most recently described in the Recent Conversation above — resolve it to that one rather than asking a fresh, unscoped question. If specific details are not available, politely say you will connect them with an advisor.';
  } else {
    sys+="\n\nIf the lead has clearly stated a pain point or goal earlier in the conversation, proactively include ONE brief, relevant insight, tip, or comparison tied to that stated problem in your answer — do not just answer what was literally asked. Keep it natural and only do this once per conversation (check Recent Conversation above so you do not repeat an insight already given).";
    sys+='\n\nCurrent stage: '+(state.stage||'new')+'. Respond ONLY in '+lang+'. Never switch languages. For any question not answerable from your knowledge, politely say you will connect them with an advisor.';
  }

  // Folds flow_json's configured stages into this same reply as guidance instead of a separate
  // dispatcher with its own message-sending path — see engineFlowStagesBlock/engineClassifyIntent's
  // own comments for the two prior designs this replaced and the real bugs each one caused.
  const stagesBlock=engineFlowStagesBlock(c, state.stage);
  if(stagesBlock) sys+=stagesBlock+'\n\nDefault stage progression (follow this unless the persona/instructions above specify a different pacing or approach to moving through stages): if the conversation is naturally ready for it, work toward the current stage\'s point in your own words — do not quote it verbatim, do not force it if the customer is still asking unrelated questions, and do not repeat something you have already substantially covered (check Recent Conversation above).';
  return sys;
}

// A brand-new lead's very first bot reply, when the route is 'qualify' — previously just the raw
// first qual_questions entry with zero context on who's texting them or what the business does.
// One extra LLM call, but only ever once per lead's whole lifetime (isNewLead), so the cost is
// negligible. Falls back to the plain question on any failure — same "never leave the customer
// with nothing" principle as engineCallLlm's own fallback.
async function engineBuildFirstTouchIntro(env, c, firstQuestion, replyLang){
  const lang=replyLang||c.language||'en';
  const services=engineParseJsonField(c.services, []);
  let sys=c.main_prompt||'';
  if(services.length) sys+='\n\n## Services\n'+services.map(s=>`- ${s.name}: ${s.description||''}`).join('\n');
  if(c.kb_summary && c.kb_summary.trim()) sys+='\n\n## Knowledge Base\n'+c.kb_summary.slice(0,1000);
  sys+=`\n\nThis is a brand-new lead's very first message. Default format (follow this unless the persona/instructions above specify a different length or format): write a short WhatsApp reply, in ${lang}: one short, warm sentence introducing what the business offers (from the Services/Knowledge Base above), then this exact question on its own line: "${firstQuestion}". Nothing else — no extra questions, no long pitch.`;
  const out=await engineCallLlm(env, c, sys, '(new conversation)', 150);
  return out && out.trim() && out!=='One moment 🙏' ? out : firstQuestion;
}

// Mirrors "Code · Objection prep".
function engineBuildObjectionSystemPrompt(c, state, objectionCategory, replyLang){
  const history=state.activeHistory||[];
  const lang=replyLang||c.language||'en';
  const playbook=engineParseJsonField(c.objection_playbook, []);
  const match=playbook.find(o=>(o.category||'').toLowerCase()===objectionCategory)||null;
  let sys=c.main_prompt||'';
  const services=engineParseJsonField(c.services, []);
  if(services.length) sys+='\n\n## Services\n'+services.map(s=>`- ${s.name}: ${s.description||''} | Price: ${s.currency||'AED'} ${s.price} per ${s.per||'person'}`).join('\n');
  if(c.kb_summary && c.kb_summary.trim()) sys+='\n\n## Knowledge Base\n'+c.kb_summary.slice(0,2000);
  sys+=`\n\n## Objection Handling\nThe lead just raised a "${objectionCategory}" objection.`;
  if(match && match.approved_response) sys+=` Use this approved response strategy: ${match.approved_response}`;
  else sys+=' Acknowledge the concern briefly and honestly, respond confidently without over-promising. Default closing (follow this unless the persona/instructions above specify a different closing style): always end by proposing one concrete next step (a call, a demo, or answering one more question) rather than just apologising.';
  if(objectionCategory==='price'){
    sys+=c.quote_validity_days
      ? ` Create gentle urgency: mention that this pricing is confirmed for the next ${c.quote_validity_days} day(s) and encourage a decision within that window.`
      : ' Create gentle urgency by encouraging a decision soon rather than leaving it open-ended — do not invent a specific discount or deadline that is not backed by real data above.';
  }
  if(history.length) sys+='\n\n## Recent Conversation\n'+history.slice(-20).map(m=>m.role+': '+m.content).join('\n');
  sys+='\n\nCurrent stage: '+(state.stage||'new')+'. Respond ONLY in '+lang+'. Never switch languages. Default length (follow this unless the persona/instructions above specify a different reply length): keep it to 2-4 sentences.';
  // See engineBuildFaqSystemPrompt's matching comment.
  const stagesBlock=engineFlowStagesBlock(c, state.stage);
  if(stagesBlock) sys+=stagesBlock+'\n\nDefault stage progression (follow this unless the persona/instructions above specify a different pacing or approach to moving through stages): after addressing the objection, if the conversation is naturally ready for it, work toward the current stage\'s point in your own words — do not quote it verbatim, and do not repeat something already substantially covered (check Recent Conversation above).';
  return sys;
}

// The main conversational agent — every FAQ/objection/product-enquiry reply across every client,
// any industry, goes through this one function. Gemini-first (shared GEMINI_API_KEY, same pattern
// as the rest of this engine), falling back to OpenRouter with the client's own openrouter_key/
// model — deliberately the client's own configured model on this fallback (not a hardcoded Gemini
// model the way engineGeminiGenerateWithFallback's OpenRouter leg is) so a client who chose a
// specific model for a reason still gets it as the safety net, not a second Gemini-shaped attempt
// that would fail the same way during a real Gemini-side outage. Previously OpenRouter-only with
// no Gemini path at all — a single shared point of failure for every client's core reply text, and
// on top of that any failure (thrown fetch, non-OK response, empty response body) was swallowed
// completely silently, collapsing to the same generic "One moment 🙏" with zero logging regardless
// of client or cause — indistinguishable from a real "let me check" delay to whoever's reading
// Chatwoot. Only logs (reportOpsError) when BOTH Gemini and OpenRouter have failed, i.e. when a
// real customer is actually about to receive that generic fallback — matches this file's existing
// principle that a customer getting nothing/genuinely-wrong is worth alerting on, ordinary
// single-layer fallbacks elsewhere aren't (see SETUP.md "Error monitoring").
async function engineCallLlm(env, c, systemPrompt, userText, maxTokens){
  const geminiReply=await engineGeminiGenerate(env, systemPrompt, userText, {temperature:0.5, maxOutputTokens:maxTokens||300, model:ENGINE_REPLY_MODEL});
  if(geminiReply) return geminiReply;
  try{
    const r=await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method:'POST', headers:{Authorization:`Bearer ${c.openrouter_key}`, 'Content-Type':'application/json'},
      body:JSON.stringify({model:c.model||'google/gemini-2.5-flash', max_tokens:maxTokens||300, messages:[{role:'system',content:systemPrompt},{role:'user',content:userText}]})
    });
    const data=await r.json().catch(()=>({}));
    const text=data?.choices?.[0]?.message?.content?.trim();
    if(text) return text;
    await reportOpsError(env, 'engineCallLlm — Gemini and OpenRouter both returned no usable reply', new Error(JSON.stringify(data).slice(0,500)), {clientId:c?.Id});
  }catch(e){
    await reportOpsError(env, 'engineCallLlm — Gemini failed and the OpenRouter fallback threw', e, {clientId:c?.Id});
  }
  return 'One moment 🙏';
}

// flow_json stage messages, qual_questions, and callback_msg/callback_msg_frustrated are static
// text a client typed once (usually in whatever language they themselves work in) — unlike the
// LLM-generated FAQ/objection/enquiry replies (which take a language directly in their own system
// prompt), these can't dynamically adapt to whichever language a given customer is actually
// writing in. Observed live: a customer's FAQ answer correctly matched their language, but the
// flow's own scripted follow-up stayed in a different one, reading like two different people —
// this is the same fix applied to scripted content instead of AI-generated content. `targetLang`
// is the per-message language engineClassifyIntent detected for the CUSTOMER (not
// CLIENTS.language, a fixed client-wide default) — a no-op when it's English or wasn't confidently
// detected, so the common English-conversation case never pays for an extra LLM call. No caching:
// same trade-off as every other per-turn LLM call in this engine — a fixed message translated
// repeatedly costs a small amount of extra latency/spend, accepted over adding cache
// infrastructure this file doesn't otherwise have. Always falls back to the original text on any
// failure — a message in the "wrong" language is a far better outcome than no message at all.
async function engineLocalizeReply(env, c, text, targetLang){
  const trimmed=(typeof text==='string'?text:'').trim();
  if(!trimmed || !targetLang || targetLang==='en') return text;
  const system=`Translate the following WhatsApp message into the language with ISO 639-1 code "${targetLang}". Keep any URLs, product SKUs/codes, numbers, and emoji exactly as they are — translate only the natural-language wording around them. Respond with ONLY the translated text, no explanation, no quotes, no markdown.`;
  try{
    const geminiRaw=await engineGeminiGenerate(env, system, trimmed, {temperature:0.2, maxOutputTokens:400});
    if(geminiRaw) return geminiRaw;
  }catch(e){}
  if(c.openrouter_key){
    try{
      const r=await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method:'POST', headers:{Authorization:`Bearer ${c.openrouter_key}`, 'Content-Type':'application/json'},
        body:JSON.stringify({model:c.model||'google/gemini-2.5-flash', temperature:0.2, max_tokens:400, messages:[{role:'system',content:system},{role:'user',content:trimmed}]})
      });
      const data=await r.json().catch(()=>({}));
      const out=data?.choices?.[0]?.message?.content?.trim();
      if(out) return out;
    }catch(e){}
  }
  return text;
}

// The one delivery point a customer's reply actually depends on — a silent failure here means
// the customer gets nothing and nobody finds out, so (unlike most best-effort sends elsewhere in
// this file) this specifically reports to reportOpsError on both a thrown fetch and a non-OK
// response. Coerces/trims `text` defensively — a non-string value (e.g. a malformed qual_questions
// entry) or a whitespace-only string would both pass a bare `!text` truthiness check but shouldn't
// be forwarded as real content. NOTE a real limit this can't close: Chatwoot accepts a message
// (200 OK here) and relays it to WhatsApp *asynchronously* — a downstream Meta rejection (e.g.
// "text.body" schema errors) happens after this function has already returned successfully, and
// only shows up in Chatwoot's own UI as "Failed to send." That class of failure is invisible to
// this synchronous check by construction; it isn't something r.ok can catch.
async function engineSendChatwootReply(env, c, clientId, convId, text){
  const trimmed=(typeof text==='string'?text:(text==null?'':String(text))).trim();
  if(!c.chatwoot_base||!c.chatwoot_account_id||!c.chatwoot_token||!convId||!trimmed) return;
  if(typeof text!=='string'){
    await reportOpsError(env, 'engineSendChatwootReply — reply was not a string', new Error(`typeof=${typeof text} value=${JSON.stringify(text)?.slice(0,300)}`), {clientId, convId});
  }
  try{
    const fd=new FormData();
    fd.append('content', trimmed); fd.append('message_type','outgoing'); fd.append('private','false');
    const r=await fetch(`${c.chatwoot_base}/api/v1/accounts/${c.chatwoot_account_id}/conversations/${convId}/messages`, {method:'POST', headers:{api_access_token:c.chatwoot_token}, body:fd});
    if(!r.ok){
      const errBody=await r.text().catch(()=>'');
      await reportOpsError(env, 'engineSendChatwootReply — Chatwoot rejected the send', new Error(`HTTP ${r.status} — ${errBody.slice(0,500)}`), {clientId, convId});
    }
  }catch(e){
    await reportOpsError(env, 'engineSendChatwootReply — send threw', e, {clientId, convId});
  }
}

// Mirrors store.html's own toImageUrl() — a Google Drive "share" link
// (drive.google.com/file/d/<id>/view or ?id=<id>) isn't directly fetchable as raw image bytes;
// this resolves it to Drive's thumbnail endpoint, which is. Any non-Drive URL (Shopify CDN,
// direct image host, etc.) passes through unchanged.
function engineResolveDirectImageUrl(url){
  if(!url) return '';
  if(!/drive\.google\.com/.test(url)) return url;
  const pathMatch=url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  const queryMatch=url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  const id=(pathMatch&&pathMatch[1])||(queryMatch&&queryMatch[1])||null;
  return id?`https://drive.google.com/thumbnail?id=${id}&sz=w1000`:url;
}

// Sends a matched product's actual photo as a WhatsApp image attachment (via Chatwoot, the same
// relay a human agent's own attachments use) with the reply text as its caption, instead of a
// text-only message that just links to the storefront to see what it looks like. Real observed
// ask: customers asking about a specific product should see the product, not just a name/price/
// link. Falls back to a plain text reply (engineSendChatwootReply) whenever there's no image, or
// fetching/attaching one fails for any reason — a customer getting the text-only reply they'd
// have gotten before this existed is a far better failure mode than getting nothing at all.
async function engineSendChatwootImageReply(env, c, clientId, convId, imageUrl, captionText){
  const directUrl=engineResolveDirectImageUrl(imageUrl);
  if(!directUrl) return engineSendChatwootReply(env, c, clientId, convId, captionText);
  if(!c.chatwoot_base||!c.chatwoot_account_id||!c.chatwoot_token||!convId) return;
  try{
    const imgR=await fetch(directUrl);
    if(!imgR.ok) return engineSendChatwootReply(env, c, clientId, convId, captionText);
    const blob=await imgR.blob();
    const trimmed=(typeof captionText==='string'?captionText:'').trim();
    const fd=new FormData();
    fd.append('content', trimmed); fd.append('message_type','outgoing'); fd.append('private','false');
    fd.append('attachments[]', blob, 'product.jpg');
    const r=await fetch(`${c.chatwoot_base}/api/v1/accounts/${c.chatwoot_account_id}/conversations/${convId}/messages`, {method:'POST', headers:{api_access_token:c.chatwoot_token}, body:fd});
    if(!r.ok){
      const errBody=await r.text().catch(()=>'');
      await reportOpsError(env, 'engineSendChatwootImageReply — Chatwoot rejected the send', new Error(`HTTP ${r.status} — ${errBody.slice(0,500)}`), {clientId, convId});
      return engineSendChatwootReply(env, c, clientId, convId, captionText);
    }
  }catch(e){
    await reportOpsError(env, 'engineSendChatwootImageReply — send threw', e, {clientId, convId});
    return engineSendChatwootReply(env, c, clientId, convId, captionText);
  }
}


// Sends a Sarvam AI-generated voice note (female speaker) as the customer's reply attachment,
// same Chatwoot-attachment relay engineSendChatwootImageReply already uses for product photos.
// Sent as .ogg/audio+opus (matching engineSarvamTts's output_audio_codec) — that's the one format
// WhatsApp's Cloud API renders as a native voice-note bubble instead of a generic file attachment.
// Falls back to a plain text reply (engineSendChatwootReply) on any failure — a customer getting
// the text-only reply they'd have gotten before this existed is a far better failure mode than
// getting nothing at all, same reasoning as the image-reply fallback above.
async function engineSendChatwootAudioReply(env, c, clientId, convId, audioBuf, captionText, fallbackText){
  if(!c.chatwoot_base||!c.chatwoot_account_id||!c.chatwoot_token||!convId||!audioBuf) return engineSendChatwootReply(env, c, clientId, convId, fallbackText);
  try{
    const blob=new Blob([audioBuf], {type:'audio/ogg; codecs=opus'});
    const trimmed=(typeof captionText==='string'?captionText:'').trim();
    const fd=new FormData();
    fd.append('content', trimmed); fd.append('message_type','outgoing'); fd.append('private','false');
    fd.append('attachments[]', blob, 'reply.ogg');
    const r=await fetch(`${c.chatwoot_base}/api/v1/accounts/${c.chatwoot_account_id}/conversations/${convId}/messages`, {method:'POST', headers:{api_access_token:c.chatwoot_token}, body:fd});
    if(!r.ok){
      const errBody=await r.text().catch(()=>'');
      await reportOpsError(env, 'engineSendChatwootAudioReply — Chatwoot rejected the send', new Error(`HTTP ${r.status} — ${errBody.slice(0,500)}`), {clientId, convId});
      return engineSendChatwootReply(env, c, clientId, convId, fallbackText);
    }
  }catch(e){
    await reportOpsError(env, 'engineSendChatwootAudioReply — send threw', e, {clientId, convId});
    return engineSendChatwootReply(env, c, clientId, convId, fallbackText);
  }
}

// ISO 639-1 (engineClassifyIntent's `customerLanguage`) → Sarvam's BCP-47 target_language_code.
// Sarvam AI's TTS is Indic-language-focused — deliberately not a general-purpose fallback for
// every language this engine can detect (e.g. Arabic customers, common in this product's UAE
// client base, get a normal text reply instead of voice, not a mistranslated/unsupported one).
// Endpoint, header, request/response shape, and this language list have been checked against
// Sarvam's current docs (docs.sarvam.ai) and confirmed correct for bulbul:v2.
const ENGINE_TTS_LANG_MAP={en:'en-IN', ml:'ml-IN', hi:'hi-IN', ta:'ta-IN', te:'te-IN', kn:'kn-IN', bn:'bn-IN', gu:'gu-IN', mr:'mr-IN', pa:'pa-IN', or:'od-IN'};
const ENGINE_TTS_SPEAKER='anushka'; // bulbul:v2's default female voice — 'meera' (previously used here) isn't a valid bulbul:v2 speaker, which made every real Sarvam call fail

// Real TTS call — env.SARVAM_API_KEY (Worker secret, see wrangler.toml). Returns a decoded audio
// ArrayBuffer, or null on any failure so callers fall back to text. Text is capped defensively —
// a long FAQ paragraph shouldn't become a multi-minute voice note even after
// engineBuildSpokenReply's own shortening.
// output_audio_codec:'opus' (Ogg/Opus) instead of Sarvam's default WAV — WhatsApp's Cloud API only
// renders audio as a native voice-note bubble for Ogg/Opus; a WAV attachment either gets rejected
// outright or arrives as a generic file, not a playable voice note (this was the "message format
// not suitable" bug). speech_sample_rate:16000 because Opus itself only supports 8/12/16/24/48kHz —
// Sarvam's general 22050Hz default (valid for its other codecs) isn't a legal Opus rate.
// Every failure branch reports via reportOpsError instead of just returning null silently, so any
// future regression (bad speaker name, changed API shape, etc.) surfaces instead of every
// voice-note customer silently and permanently getting a text reply with zero trace of why.
// Missing SARVAM_API_KEY is the one expected/unconfigured case and does NOT report — that's
// just voice-to-voice not being set up yet for this environment, not a bug.
async function engineSarvamTts(env, text, targetLangCode){
  if(!text || !targetLangCode) return null;
  if(!env.SARVAM_API_KEY){ await reportOpsError(env, 'engineSarvamTts — SARVAM_API_KEY not configured', new Error('missing secret')); return null; }
  try{
    const r=await engineFetchWithRetry('https://api.sarvam.ai/text-to-speech', {
      method:'POST',
      headers:{'api-subscription-key':env.SARVAM_API_KEY, 'Content-Type':'application/json'},
      body:JSON.stringify({text:text.slice(0,500), target_language_code:targetLangCode, speaker:ENGINE_TTS_SPEAKER, model:'bulbul:v2', speech_sample_rate:16000, output_audio_codec:'opus'})
    });
    if(!r.ok){
      const bodyText=await r.text().catch(()=>'');
      await reportOpsError(env, 'engineSarvamTts — Sarvam API returned non-OK', new Error(`HTTP ${r.status}: ${bodyText.slice(0,500)}`), {targetLangCode});
      return null;
    }
    const data=await r.json().catch(()=>({}));
    const b64=data?.audios?.[0];
    if(!b64){
      await reportOpsError(env, 'engineSarvamTts — no audio in Sarvam response', new Error(JSON.stringify(data).slice(0,500)), {targetLangCode});
      return null;
    }
    const bin=atob(b64);
    const bytes=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
    // A well-formed Opus reply is never this small (even a one-word reply is comfortably above a
    // few hundred bytes) — guards against sending a customer a broken/silent "voice note" that's
    // actually just container bytes with no real audio, same principle as the too-short-recording
    // check on the inbound side above.
    if(bytes.buffer.byteLength<200){
      await reportOpsError(env, 'engineSarvamTts — decoded audio suspiciously small, treating as failure', new Error(`${bytes.buffer.byteLength} bytes`), {targetLangCode});
      return null;
    }
    return bytes.buffer;
  }catch(e){
    await reportOpsError(env, 'engineSarvamTts — request threw', e, {targetLangCode});
    return null;
  }
}

// Rewrites an already-composed reply into a short, natural, spoken sentence — never the literal
// reply text, which may be a multi-sentence FAQ answer full of links/prices unsuitable to read
// aloud. Same shared Gemini credential as the intent classifier/transcriber. Explicitly told to
// drop links/prices/long numbers rather than speak them — those are preserved separately as a
// text caption by engineExtractLinkPriceCaption instead.
async function engineBuildSpokenReply(env, c, replyText, langCode){
  const sys='Rewrite the following customer-service reply as ONE short, natural sentence the way a friendly person would actually say it out loud on a voice note — real spoken style, not written text. Keep the exact same language and meaning. Never speak a URL, link, price, currency amount, or long number — if the reply mainly exists to share one of those, say something short and natural instead (for example, that the details are shared below/above in text). Respond with ONLY the spoken sentence — no quotes, no commentary, no markdown.';
  const spoken=await engineGeminiGenerateWithFallback(env, c, sys, replyText, {temperature:0.4, maxOutputTokens:120});
  if(spoken) return spoken;
  // Fallback if Gemini is unavailable: best-effort strip links/prices instead of speaking them,
  // and cap length, rather than failing the voice reply outright.
  return replyText.replace(/https?:\/\/\S+/g,'').replace(/(?:AED|USD|INR|EUR|GBP|₹|\$|€|£)\s?[\d,]+(?:\.\d+)?/gi,'').replace(/\s{2,}/g,' ').trim().slice(0,220);
}

// Pulls any link/price out of the real reply text so it still reaches the customer as a short
// one-line text caption on the voice message, even though the voice itself is instructed to never
// say them out loud (engineBuildSpokenReply above). Empty string when the reply has neither.
function engineExtractLinkPriceCaption(replyText){
  const links=[...new Set(replyText.match(/https?:\/\/\S+/g)||[])];
  const prices=[...new Set(replyText.match(/(?:AED|USD|INR|EUR|GBP|₹|\$|€|£)\s?[\d,]+(?:\.\d+)?/gi)||[])];
  const parts=[];
  if(prices.length) parts.push('💰 '+prices.join(', '));
  if(links.length) parts.push('🔗 '+links.join(' '));
  return parts.join('  ');
}

// Single reply-delivery dispatcher for handleEngineWebhook — every route (human/qualify/FAQ/
// objection/order-detected) sends its final reply through here instead of calling
// engineSendChatwootReply/engineSendChatwootImageReply directly, so voice-to-voice is one code
// path instead of eight near-duplicate branches. Voice-to-voice reply: when the customer sent a
// voice note and this client has the paid voice add-on (voice_addon_active), reply with a
// WhatsApp voice note instead of text — mirrors the customer's own input modality, which is the
// point of the feature. Falls back to the normal text/image reply whenever voice isn't possible
// (no add-on, no Sarvam key, unsupported/undetected language, a product-image reply already in
// play, or the TTS call itself fails) so a voice hiccup never costs the customer a reply outright.
// Follow-up messages (followup-template.json) are NOT routed through here — voice follow-ups are
// out of scope for now, this only covers live conversational replies.
async function engineDeliverReply(env, c, clientId, convId, replyText, {mediaType, langCode, imageUrl}={}){
  // CLIENTS.bot_reply_disabled ('Yes'/'No', Settings → Bot Auto-Reply) — unlike engine_disabled
  // above, this is the ONLY choke point gated by this flag: classification, routing, lead
  // upsert/CRM fields, analytics logging, last_seen, and order/booking-signal detection in
  // handleEngineWebhook all still run normally. Only the actual outbound WhatsApp message (text,
  // image caption, or voice) stops going out — for a client who wants their own bot (e.g. a
  // custom n8n workflow wired to the same Chatwoot inbox) to own the reply, while this CRM keeps
  // tracking leads/stages/analytics off the same conversation exactly as if the built-in bot were
  // still replying.
  if(c.bot_reply_disabled==='Yes') return;
  const trimmed=(typeof replyText==='string'?replyText:(replyText==null?'':String(replyText))).trim();
  if(!trimmed) return;
  const bcp47=ENGINE_TTS_LANG_MAP[(langCode||'').toLowerCase()];
  // voice_reply_enabled — Integrations → Voice-to-Voice Reply toggle (dashboard.html). This is the
  // only gate: not tied to voice_addon_active/billing at all (deliberately — see the toggle's own
  // comment in dashboard.html), so a client controls this purely by flipping the toggle on or off.
  if(mediaType==='voice' && c.voice_reply_enabled==='Yes' && !imageUrl && bcp47){
    const spokenText=await engineBuildSpokenReply(env, c, trimmed, langCode);
    const audioBuf=await engineSarvamTts(env, spokenText, bcp47);
    if(audioBuf) return engineSendChatwootAudioReply(env, c, clientId, convId, audioBuf, engineExtractLinkPriceCaption(trimmed), trimmed);
  }
  if(imageUrl) return engineSendChatwootImageReply(env, c, clientId, convId, imageUrl, trimmed);
  return engineSendChatwootReply(env, c, clientId, convId, trimmed);
}

async function engineSendHandoverLabel(c, convId){
  if(!c.chatwoot_base||!c.chatwoot_account_id||!c.chatwoot_token||!convId) return;
  try{
    await fetch(`${c.chatwoot_base}/api/v1/accounts/${c.chatwoot_account_id}/conversations/${convId}/labels`, {
      method:'POST', headers:{api_access_token:c.chatwoot_token, 'Content-Type':'application/json'},
      body:JSON.stringify({labels:['human-requested']})
    });
  }catch(e){}
}

// Mirrors "Code · Prep lead" — hot-moment/qual-score/win-probability/round-robin-owner
// computation and the LEADS upsert body. See the file-header comment above for the ConvHistory
// and human-handover-message fixes vs. the source workflow. `messageId` (Chatwoot's own message
// id, when available) is persisted as LastProcessedMessageId for handleEngineWebhook's
// idempotency check. `isNewLead` must be the "did this lead already exist" snapshot taken before
// engineClaimMessage ran (state.leadId itself is no longer reliable for that by this point — a
// brand-new lead may already have a stub row and leadId from the claim).
function engineBuildLeadUpsertBody(c, clientId, state, routing, userText, messageId, isNewLead){
  const {next:routeNext, qualAnswers, intentData, intent, sentiment, objectionCategory, aiWinProbability, isOptOut, isResub}=routing;
  const reply=routing.reply;
  let next=routeNext;
  const isHuman=routing.route==='human';

  const history=(state.history||[]).slice();
  if(userText) history.push({role:'user', content:userText});
  if(reply) history.push({role:'assistant', content:reply});

  const body={
    ClientId:String(clientId), Phone:state.phone, Name:state.name, ConversationID:state.convId,
    Date:new Date().toISOString(), Language:routing.customerLanguage||c.language||'en',
    ConvHistory:JSON.stringify(history.slice(-40)), LastMsgAt:new Date().toISOString()
  };
  if(messageId) body.LastProcessedMessageId=messageId;
  if(qualAnswers && Object.keys(qualAnswers).length) body.QualAnswers=JSON.stringify(qualAnswers);
  if(isHuman){ body.Stage='human_handover'; body.Handover='Yes'; }
  else body.Stage=next;
  if(!isHuman && next!==state.stage){ body['Follow up 1']='No'; body['Follow up 2']='No'; body['Follow up 3']='No'; }
  if(intentData?.booking_time) body.BookingTime=intentData.booking_time;

  let score='Cold';
  if(intent==='BOOKING' || intentData?.booking_time || body.Stage==='consultation_booked') score='Hot';
  else if(['AFFIRMATIVE','WATCHED','FORM_DONE'].includes(intent) && state.stage!=='new') score='Warm';
  else if(state.stage!=='new' && (state.history||[]).length>2) score='Warm';
  body.Score=score;
  if(state.isDuplicate) body.IsDuplicate='Yes';
  if(isOptOut) body.OptOut='Yes';
  if(isResub){ body.OptOut='No'; body.Stage='new'; }

  const HOT_PHRASES=['how much','price','cost','available','when can','book','ready to','interested in','want to','sign up','start','confirm','deposit','payment','package','deal','offer','buy','purchase','enroll','register'];
  const msgLower=(userText||'').toLowerCase();
  const hotPhrase=HOT_PHRASES.find(p=>msgLower.includes(p));
  if(hotPhrase){ body.HotMoment='Yes'; body.HotMomentText=(userText||'').slice(0,200); }

  const flow=engineParseJsonField(c.flow_json, {});
  const stageKeys=Object.keys(flow.stages||{}).filter(k=>k!=='new');
  const stageIdx=stageKeys.indexOf(state.stage);
  const stageProgress=stageKeys.length>0?(stageIdx+1)/stageKeys.length:0;
  const histLen=(state.history||[]).length;
  let qualScore=Math.round((stageProgress*4)+(score==='Hot'?3:score==='Warm'?2:0)+(hotPhrase?1.5:0)+Math.min(histLen/20,1.5));
  qualScore=Math.max(1, Math.min(10, qualScore));
  body.QualScore=qualScore;

  if(state.winProbabilityManual!=='Yes'){
    let wp=(typeof aiWinProbability==='number')?aiWinProbability:Math.round(stageProgress*80+(score==='Hot'?20:score==='Warm'?10:0));
    if(isHuman) wp=Math.max(wp,55);
    if(isOptOut) wp=0;
    body.WinProbability=Math.max(0, Math.min(100, wp));
  }
  if(c.deal_currency && isNewLead) body.DealCurrency=c.deal_currency;

  if(isNewLead && !state.owner){
    const reps=engineParseSalesReps(c.agents);
    if(reps.length){
      let h=0; const phoneStr=String(state.phone||'');
      for(let i=0;i<phoneStr.length;i++) h=(h*31+phoneStr.charCodeAt(i))|0;
      body.Owner=reps[Math.abs(h)%reps.length];
    }
  }

  if(sentiment) body.Sentiment=sentiment;
  if(objectionCategory && objectionCategory!=='none') body.LastObjectionCategory=objectionCategory;
  if(isHuman && state.stage!=='human_handover'){ body.HandoverAt=new Date().toISOString(); body.SlaAlerted='No'; }

  return {body, method:state.leadId?'PATCH':'POST', leadId:state.leadId};
}

async function engineUpsertLead(env, method, leadId, body){
  if(leadId) body.Id=leadId;
  await ncFetch(env, `api/v2/tables/${DEFAULT_LEADS_TABLE}/records`, {method, body});
}

// Called by handleEngineWebhook right before the slow classify/LLM work — see that call site's
// comment for why. Best-effort: if this write fails for any reason, falls back to the original
// leadId (or null) so the turn proceeds exactly as it would have before this existed, rather than
// aborting a real customer message over a claim-step failure.
async function engineClaimMessage(env, clientId, phone, leadId, messageId){
  try{
    if(leadId){
      await ncFetch(env, `api/v2/tables/${DEFAULT_LEADS_TABLE}/records`, {method:'PATCH', body:{Id:leadId, LastProcessedMessageId:messageId}});
      return leadId;
    }
    const r=await ncFetch(env, `api/v2/tables/${DEFAULT_LEADS_TABLE}/records`, {method:'POST', body:{ClientId:String(clientId), Phone:phone, Stage:'new', LastProcessedMessageId:messageId}});
    const d=await r.json().catch(()=>null);
    return d?.Id||leadId||null;
  }catch(e){ return leadId||null; }
}

async function engineLogAnalytics(env, entry){
  try{ await ncFetch(env, `api/v2/tables/${ENGINE_ANALYTICS_TABLE}/records`, {method:'POST', body:entry}); }catch(e){}
}

// Chatwoot has no built-in webhook signing (unlike Shopify/Cal.com, both verified elsewhere in
// this file via verifyShopifyWebhookHmac/verifyCalcomWebhookHmac against a secret the client
// configures on their side) — its webhook feature just POSTs JSON to whatever URL you give it, no
// signature header, no secret field in its own UI. `secret` is this route's equivalent: a random
// 192-bit per-client token baked into the URL path itself (`/engine/webhook/<secret>`, same
// URL-path-token pattern already used by `/calcom/webhook/<clientId>`), registered by
// engineSyncChatwootWebhook and never exposed anywhere a browser or a client sees it. Without the
// exact secret, a request is rejected before any client data is touched — same practical
// unforgeability as a bearer token, since knowing a client's numeric id or chatwoot_account_id
// (both are exposed in various places already) no longer gets an attacker anywhere.
async function handleEngineWebhook(request, env, secret){
  const startMs=Date.now();
  // Global kill switch — a config-only flag (wrangler.toml [vars], requires a redeploy to flip,
  // not instant, but a one-line change is still far faster than debugging/reverting code under
  // pressure). Intentionally goes silent everywhere rather than falling back to some other
  // behavior: if the engine itself is suspected of causing harm (bad deploy, corrupted data),
  // "stop replying" is the safer failure mode than "keep executing possibly-broken logic."
  if(env.ENGINE_ENABLED==='false') return json({ok:true, skipped:'engine-disabled-global'});
  if(!secret) return json({ok:true, skipped:'no-secret'});
  const c=await findClientByField(env, 'engine_webhook_secret', secret);
  if(!c) return json({ok:true, skipped:'invalid-secret'});
  const clientId=String(c.Id);
  if(c.active==='No') return json({ok:true, skipped:'client-inactive'});
  // Per-client kill switch (CLIENTS.engine_disabled, 'Yes'/'No') — same "go silent" reasoning as
  // the global one, scoped to one client whose flow_json/data is causing a problem, without
  // taking down every other client. engineSyncChatwootWebhook also respects this flag (leaves
  // that client's webhooks alone entirely) so an admin can manually restore their old n8n webhook
  // in Chatwoot without the next Settings-save sync immediately undoing it.
  if(c.engine_disabled==='Yes') return json({ok:true, skipped:'engine-disabled-client'});

  const body=await request.json().catch(()=>({}));
  // Defense in depth, not the actual security boundary (the secret already is): if the payload's
  // own account id disagrees with this client's on-record chatwoot_account_id, something is
  // wrong (a misconfigured/reused webhook, most likely) — safer to drop it than guess.
  const accountId=String(body.account?.id||body.conversation?.account_id||'');
  if(accountId && c.chatwoot_account_id && accountId!==String(c.chatwoot_account_id)) return json({ok:true, skipped:'account-mismatch'});

  let phone=null;
  try{
    const parsed=engineParseChatwootPayload(body);
    if(!parsed) return json({ok:true, skipped:'not-actionable'});
    const {convId, name, text, mediaType, mediaUrl}=parsed;
    phone=parsed.phone;

    if(c.test_mode==='Yes' && c.test_phone && phone!==c.test_phone.replace(/[^0-9]/g,'')) return json({ok:true, skipped:'test-mode'});
    if(!c.openrouter_key) return json({ok:true, skipped:'no-openrouter-key'});

    const state=await engineGetLeadState(env, clientId, phone);
    state.phone=phone; state.name=name; state.convId=convId;

    // Idempotency — Chatwoot may redeliver the same message_created event (timeout, network
    // retry); without this, a redelivery after this turn already completed would generate and
    // send a second reply. messageId is Chatwoot's own message id (unverified against a live
    // payload from this specific Chatwoot version, same honest caveat as elsewhere this repo
    // parses Chatwoot's shape) — if it's ever absent, dedup is simply skipped rather than falling
    // back to a fragile content-based guess, since a false-positive skip would silently eat a real
    // customer message. Persisted as part of the normal lead upsert at the end of a *successful*
    // turn (engineBuildLeadUpsertBody), never written any earlier — so a genuine mid-processing
    // crash (after the reply is sent, before the upsert completes) is NOT protected against and
    // could still double-reply on retry. Accepted trade-off: the alternative (marking "processed"
    // before work starts) risks silently dropping a real message if processing then fails, which
    // is worse for a sales/support bot than an occasional duplicate reply.
    const messageId=String(body.id||body.message?.id||'');
    if(messageId && state.lead?.LastProcessedMessageId===messageId) return json({ok:true, skipped:'duplicate-delivery'});

    // engine.json's own Code·State hard-stop ("the bot stops writing to the lead entirely once
    // handed over ... so it can never talk over a live agent") is now opt-in, not the default — set
    // CLIENTS.handover_silence_enabled='Yes' (Settings → Human Handover, off by default) for a
    // client who wants that. Left off, the bot keeps replying (ordinary FAQ-style, via
    // engineRouteFlow's own matching exception — its human_handover→'drop' branch needs the same
    // gate, since this check alone isn't enough) even after handover; the lead still shows
    // Handover='Yes'/Stage='human_handover' in the CRM either way — only whether the bot keeps
    // replying changes.
    if(state.lead && (state.lead.Handover==='Yes' || state.stage==='human_handover') && c.handover_silence_enabled==='Yes') return json({ok:true, skipped:'handed-over'});
    if(state.leadOptOut==='Yes' && text.trim().toLowerCase()!=='start') return json({ok:true, skipped:'opted-out'});

    const botConfig=engineParseJsonField(c.bot_config, {});
    const rateLimitMs=parseInt(botConfig.rate_limit_ms)||4000;
    const lastMsgAt=state.lastMsgAt?new Date(state.lastMsgAt).getTime():0;
    if(Date.now()-lastMsgAt<rateLimitMs) return json({ok:true, skipped:'rate-limited'});

    // Claim this message id now, before the slow classify/LLM/context work below — observed in
    // production as a genuine duplicate reply (identical product-lookup message sent twice, ~1
    // minute apart): Chatwoot's webhook delivery times out waiting for a response (this turn can
    // run several LLM + NocoDB round-trips deep) and redelivers the same message_created event
    // independently of whatever status this handler eventually returns, so the original
    // end-of-turn-only idempotency write (engineBuildLeadUpsertBody, below) was still in flight
    // when the redelivery's own idempotency check ran and found nothing to skip yet. Claiming here
    // shrinks that race window down to the handful of fast, synchronous checks above instead of
    // the whole turn. Still not a true atomic compare-and-swap (NocoDB has no such primitive
    // available here), so it isn't airtight — just far smaller. isNewLead is captured before this
    // can mutate state.leadId, since engineBuildLeadUpsertBody uses "no leadId yet" to decide
    // Owner/DealCurrency assignment for a genuinely brand-new lead.
    const isNewLead=!state.leadId;
    if(messageId) state.leadId=await engineClaimMessage(env, clientId, phone, state.leadId, messageId);

    const userText=await engineResolveUserText(env, c, mediaType, mediaUrl, text);
    const cls=await engineClassifyIntent(env, c, userText, state.activeHistory, state.stage);
    const routing=engineRouteFlow(c, state, userText, cls);
    // Per-message detected language for THIS customer (engineClassifyIntent), not
    // CLIENTS.language (a fixed client-wide default used only as the fallback when detection
    // isn't confident) — see engineLocalizeReply's own comment for the scripted-content half of
    // this; the AI-generated branches below pass this straight into their own system prompt.
    const replyLang=routing.customerLanguage||c.language||'en';

    let sentText=null;
    let orderHandledInline=false;
    // Order-readiness overrides the flow_json state machine's own routing entirely, not just
    // within the ecom_faq branch — observed real failure: a customer given a product's full detail
    // card said "Order this" next, and instead of the order link got a scripted, unrelated
    // flow-stage message, because engineRouteFlow's own intent classification had already picked a
    // different route before this ever got a chance to run. Checked before the route dispatch
    // below, for every route except 'drop' (opt-out/dedup-adjacent, nothing should reply) and a
    // 'human' route caused by an explicit ask or real frustration (routing.humanReason==='explicit')
    // — that stays a handover even if phrased alongside product talk. A 'human' route caused by the
    // OTHER trigger (isFinalStage+POSITIVE, an internal "wrap up the funnel" heuristic, not an
    // actual request for a person) does NOT block this check — observed live: the identical message
    // "Red Shirt small size" got classified as AFFIRMATIVE on one delivery (triggering that
    // heuristic → a false "connecting you to our advisor" reply) and correctly as a product
    // question on an identical resend a moment later — the AI intent classifier isn't perfectly
    // deterministic, so this heuristic alone isn't reliable enough to override an unambiguous
    // product match from detectOrderSignal, a purpose-built, catalog-aware classifier.
    //
    // Enquiry vs. order intent are handled differently, per an explicit product requirement: never
    // share the order/checkout link until real order intent is detected — a size/color/stock/price
    // question ("enquiry" mode) only ever gets product details in text, no link and no photo,
    // however confidently detectOrderSignal matched a product, unless ecom_link_on_enquiry is
    // switched on (see engineBuildProductEnquirySystemPrompt); only "order" mode (an explicit
    // "order this"/"buy it"/confirmed yes) gets the checkout link, and only once a specific
    // product is actually known — an ambiguous "order" with no resolvable product asks a
    // clarifying question instead of sending a link to nothing in particular. The product photo
    // is likewise only ever attached alongside an actual link, never on a link-less text reply —
    // another explicit product requirement, don't over-send media on a plain question.
    const humanBlocksOrderCheck=routing.route==='human' && routing.humanReason==='explicit';
    if(c.industry==='ecommerce' && c.openrouter_key && routing.route!=='drop' && !humanBlocksOrderCheck){
      const contextText=(state.activeHistory||[]).slice(-8).map(m=>`${m.role==='user'?'Customer':'Bot'}: ${m.content}`).join('\n');
      const detection=await detectOrderSignal(env, c, clientId, userText, contextText);
      if(detection.signal){
        const product=await ecomResolveProduct(env, clientId, detection.sku, detection.productName);
        if(detection.mode==='order' && product){
          const link=buildCheckoutLink(c, clientId, detection.sku);
          sentText=await engineLocalizeReply(env, c, `Great choice! 🛍️ Please complete your order here — pick your size and add your delivery details:\n${link}`, replyLang);
          routing.reply=sentText;
          await engineDeliverReply(env, c, clientId, convId, sentText, {mediaType, langCode:replyLang, imageUrl:product.image_url});
          await logPendingOrder(env, c, clientId, phone, name, product);
          orderHandledInline=true;
        } else if(detection.mode==='order' && !product){
          sentText=await engineLocalizeReply(env, c, 'Happy to help you order! Which item would you like — could you share the product name so I can get you the checkout link?', replyLang);
          routing.reply=sentText;
          await engineDeliverReply(env, c, clientId, convId, sentText, {mediaType, langCode:replyLang});
          orderHandledInline=true;
        } else if(detection.mode==='enquiry' && product){
          // Opt-in (ecom_link_on_enquiry) — see engineBuildProductEnquirySystemPrompt's own
          // comment on this parameter for why it's off by default.
          const enquiryLink=c.ecom_link_on_enquiry==='Yes' ? buildCheckoutLink(c, clientId, product.sku) : null;
          const sysPrompt=engineBuildProductEnquirySystemPrompt(c, product, replyLang, enquiryLink);
          sentText=await engineCallLlm(env, c, sysPrompt, userText, 200);
          routing.reply=sentText;
          // Photo only sent alongside an actual checkout link — a plain product question with no
          // link (ecom_link_on_enquiry off, the common case) stays text-only, so a customer isn't
          // sent a photo on every single size/color/stock question, only when there's also
          // somewhere for that photo to lead (real product requirement: don't over-send media).
          await engineDeliverReply(env, c, clientId, convId, sentText, {mediaType, langCode:replyLang, imageUrl:enquiryLink?product.image_url:undefined});
          // Only logged as a pending order when the link was actually made available this turn —
          // an enquiry reply with the toggle off shares no link, so there's nothing to log yet.
          if(enquiryLink) await logPendingOrder(env, c, clientId, phone, name, product);
          orderHandledInline=true;
        }
        // enquiry with no confident product match falls through to the normal FAQ/flow handling
        // below (no canned reply, no link) — the context-aware FAQ LLM can respond naturally,
        // e.g. "we don't carry that, but here's what we do have."
      }
      // If this turn overrode a false-positive 'human' route (humanBlocksOrderCheck was false only
      // because humanReason wasn't 'explicit'), routing.route is still 'human' at this point —
      // engineBuildLeadUpsertBody's isHuman check would otherwise force Stage='human_handover'/
      // Handover='Yes' onto the lead even though no actual handover happened this turn, just a
      // product reply. Reset it so the lead record matches what was actually sent.
      if(orderHandledInline && routing.route==='human') routing.route='ecom_faq';
    }

    if(orderHandledInline){
      // Reply already sent above — Stage/qualAnswers bookkeeping from engineRouteFlow's own
      // decision is left untouched so the flow/qualification funnel resumes from wherever it was
      // on the next turn; only the reply actually sent to the customer this turn changes.
    } else if(routing.route==='human'){
      sentText=await engineLocalizeReply(env, c, routing.reply || 'Sure 🙏 connecting you to our advisor now. Someone will be with you shortly.', replyLang);
      routing.reply=sentText; // keep ConvHistory consistent with what was actually sent
      await engineDeliverReply(env, c, clientId, convId, sentText, {mediaType, langCode:replyLang});
      await engineSendHandoverLabel(c, convId);
    } else if(routing.route==='selfserve'){
      // Reached the end of the funnel with a positive reply and a self-serve link is configured —
      // send the order/booking link itself, a plain scripted send like qualify_next (not an LLM
      // reply), instead of handing over to a human. See engineRouteFlow's own comment.
      sentText=await engineLocalizeReply(env, c, routing.reply, replyLang);
      routing.reply=sentText;
      await engineDeliverReply(env, c, clientId, convId, sentText, {mediaType, langCode:replyLang});
    } else if(routing.route==='drop'){
      // no reply
    } else if(routing.route==='qualify'){
      const qualQuestions=engineParseJsonField(c.qual_questions, []);
      const firstQ=typeof qualQuestions[0]==='string'?qualQuestions[0]:'';
      routing.next='qual_0';
      // A brand-new lead gets a short intro to what the business offers ahead of the first
      // qualifying question — see engineBuildFirstTouchIntro. A returning lead landing on this
      // route again (edge case, e.g. a re-subscribe) just gets the plain scripted question.
      sentText=isNewLead
        ? await engineBuildFirstTouchIntro(env, c, firstQ||'Could you tell me a bit more about what you are looking for?', replyLang)
        : await engineLocalizeReply(env, c, firstQ||'Could you tell me a bit more about what you are looking for?', replyLang);
      routing.reply=sentText;
      await engineDeliverReply(env, c, clientId, convId, sentText, {mediaType, langCode:replyLang});
    } else if(routing.route==='qualify_next'){
      sentText=routing.reply?await engineLocalizeReply(env, c, routing.reply, replyLang):null;
      routing.reply=sentText;
      if(sentText) await engineDeliverReply(env, c, clientId, convId, sentText, {mediaType, langCode:replyLang});
    } else if(['faq','ecom_faq','travel_faq'].includes(routing.route)){
      let contextBlock=null;
      if(routing.route==='ecom_faq') contextBlock=await engineBuildEcomContext(env, c, clientId, phone);
      else if(routing.route==='travel_faq') contextBlock=await engineBuildTravelContext(env, c, clientId);
      const sysPrompt=engineBuildFaqSystemPrompt(c, state, contextBlock, c.industry||'general', replyLang, isNewLead);
      let reply=await engineCallLlm(env, c, sysPrompt, userText, 300);
      routing.reply=reply; sentText=reply;
      await engineDeliverReply(env, c, clientId, convId, sentText, {mediaType, langCode:replyLang});
    } else if(routing.route==='objection'){
      const sysPrompt=engineBuildObjectionSystemPrompt(c, state, routing.objectionCategory, replyLang);
      let reply=await engineCallLlm(env, c, sysPrompt, userText, 300);
      routing.reply=reply; sentText=reply;
      await engineDeliverReply(env, c, clientId, convId, sentText, {mediaType, langCode:replyLang});
    }

    const {body:leadBody, method, leadId}=engineBuildLeadUpsertBody(c, clientId, state, routing, userText, messageId, isNewLead);
    await engineUpsertLead(env, method, leadId, leadBody);

    // Awaited, not fire-and-forget — this Worker's fetch handler has no `ctx.waitUntil`, so a
    // background promise left running past the returned Response risks being cut off mid-flight.
    await engineLogAnalytics(env, {
      ClientId:clientId, ClientName:c.client_name||'', Phone:phone, Intent:routing.intent||'', Route:routing.route||'',
      Stage:state.stage||'', NextStage:leadBody.Stage||'', ResponseMs:Date.now()-startMs, IsError:false, ErrorMsg:'',
      Timestamp:new Date().toISOString()
    });
    await patchClientFields(env, clientId, {last_seen:new Date().toISOString()}).catch(()=>{});

    // Signal auto-send, folded into this same turn — previously a second, independent Chatwoot
    // webhook (handleChatwootIncomingOrderSignal / handleChatwootIncomingBookingSignal above).
    // Ecommerce clients are fully handled by the order-check above now (it runs for every
    // non-human/drop route, not just after other routing already happened), so this block is only
    // the booking-industry equivalent (healthcare/consultancy/travel/etc) — running it again for
    // ecommerce here would just re-call detectOrderSignal a second, redundant time, and could
    // violate the "never send a link before order intent" rule for the one case the order-check
    // above deliberately leaves unhandled (an enquiry with no confident product match).
    if(c.bot_reply_disabled!=='Yes' && c.industry!=='ecommerce' && !['human','drop'].includes(routing.route) && !routing.isOptOut && !routing.isResub && c.wa_phone_id && c.wa_token && (c.external_store_link||'').trim()){
      // Only runs once a booking link is actually configured, and skips a lead already at a
      // booking-terminal stage or one with a `requested` appointment already pending.
      const alreadyBooked=BOOKING_TERMINAL_STAGES.includes(state.stage);
      let alreadyRequested=false;
      const bookingsTable=apptResolveTable(c, 'bookings');
      if(!alreadyBooked && bookingsTable){
        const existR=await ncFetch(env, `api/v2/tables/${bookingsTable}/records?where=(client_id,eq,${clientId})~and(customer_phone,eq,${encodeURIComponent(phone)})~and(status,eq,requested)&limit=1`);
        const existD=await existR.json().catch(()=>({}));
        alreadyRequested=!!existD?.list?.length;
      }
      if(!alreadyBooked && !alreadyRequested){
        const contextText=(state.activeHistory||[]).slice(-8).map(m=>`${m.role==='user'?'Customer':'Bot'}: ${m.content}`).join('\n');
        const detection=await detectBookingSignal(env, c, clientId, userText, contextText);
        if(detection.signal){
          if(convId && c.chatwoot_base && c.chatwoot_account_id && c.chatwoot_token) await sendBookingLinkViaChatwoot(env, c, clientId, convId, phone, name, detection.service_id);
          else await sendBookingLinkNow(env, c, clientId, phone, name, detection.service_id);
        }
      }
    }

    return json({ok:true, route:routing.route, sent:!!sentText});
  }catch(e){
    // Rich context (clientId, phone) beyond what the router's own global catch-all would have —
    // caught here rather than left to propagate, so the alert carries useful debugging
    // information and Chatwoot gets a clean 200 (a 500 could trigger a Chatwoot-side retry,
    // interacting with the idempotency check above in ways worth avoiding on top of an already-
    // failing turn).
    await reportOpsError(env, 'handleEngineWebhook', e, {clientId, phone});
    return json({ok:true, skipped:'internal-error'});
  }
}

// 192 bits of randomness, hex-encoded — the actual security boundary for /engine/webhook (see the
// comment on handleEngineWebhook above). crypto.getRandomValues is the standard Workers/Web Crypto
// API, not Math.random, so this is genuinely unguessable, not just "hard to guess."
function engineGenerateWebhookSecret(){
  const bytes=new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');
}

// Generates and persists a client's engine_webhook_secret on first use; a no-op read on every
// call after that. Requires the `engine_webhook_secret` column to already exist on the CLIENTS
// table in NocoDB (Single line text — added once by hand, see SETUP.md; not auto-created here,
// same as most other CLIENTS fields in this codebase). Returns null (rather than throwing) if the
// column doesn't exist yet or the write otherwise fails, so callers can skip registering a
// webhook rather than register one with no working secret.
async function engineEnsureWebhookSecret(env, c){
  if(c.engine_webhook_secret) return c.engine_webhook_secret;
  const secret=engineGenerateWebhookSecret();
  try{ await patchClientFields(env, c.Id, {engine_webhook_secret:secret}); }catch(e){ return null; }
  c.engine_webhook_secret=secret;
  return secret;
}

// Keeps the client's PRIMARY conversational-reply webhook pointed at this Worker's
// /engine/webhook/<their-secret> — every industry now runs on the Cloudflare engine
// (handleEngineWebhook has no industry gate), so there's no branching left to do here; this just
// guarantees the correct URL is registered and cleans up n8n's old per-client webhook_url if it's
// still sitting there from before migration, so n8n can never reply to the same message a second
// time. Called from handleChannelsWhatsappConnect (first WhatsApp connect — the normal signup
// path, fully automatic, no manual Chatwoot step) and handleNocodbPassthrough below (as a safety
// net after any Settings save that touches this client's own CLIENTS row, in case
// chatwoot_inbox_id or webhook_url only became available after connect time). Only ever touches a
// webhook whose URL is under this Worker's own /engine/webhook/ prefix or exactly the client's own
// (legacy) n8n webhook_url — the separate Auto Order-Tracking webhook
// (handleEcomEnableOrderTracking) and anything a client registered by hand in Chatwoot are left
// alone. Best-effort throughout: a failure here never blocks the caller (WhatsApp connect /
// Settings save), it just means the webhook may need fixing by hand later.
async function engineSyncChatwootWebhook(env, c){
  if(!c.chatwoot_base||!c.chatwoot_account_id||!c.chatwoot_token||!c.chatwoot_inbox_id||!env.WORKER_BASE_URL) return;
  // Per-client kill switch (see handleEngineWebhook) — while disabled, leave this client's
  // webhooks entirely alone, so an admin can manually restore their old n8n webhook in Chatwoot
  // without the next Settings-save sync immediately deleting it again.
  if(c.engine_disabled==='Yes') return;
  const secret=await engineEnsureWebhookSecret(env, c);
  if(!secret) return; // no secret to register safely under (e.g. the NocoDB column isn't set up yet)
  const engineUrl=`${env.WORKER_BASE_URL}/engine/webhook/${secret}`;
  const engineUrlPrefix=`${env.WORKER_BASE_URL}/engine/webhook/`;
  const n8nUrl=c.webhook_url||'';

  try{
    const listR=await fetch(`${c.chatwoot_base}/api/v1/accounts/${c.chatwoot_account_id}/webhooks`, {headers:{api_access_token:c.chatwoot_token}});
    if(!listR.ok) return;
    const listD=await listR.json().catch(()=>null);
    const existingList=Array.isArray(listD)?listD:(Array.isArray(listD?.payload)?listD.payload:[]);

    // Drop a leftover n8n webhook (pre-migration) so it never replies alongside the engine.
    if(n8nUrl){
      const staleN8n=existingList.find(w=>w.url===n8nUrl);
      if(staleN8n) await fetch(`${c.chatwoot_base}/api/v1/accounts/${c.chatwoot_account_id}/webhooks/${staleN8n.id}`, {method:'DELETE', headers:{api_access_token:c.chatwoot_token}}).catch(()=>{});
    }

    // Drop any stale engine registration under a since-rotated secret — only relevant if
    // engine_webhook_secret is ever changed by hand later; harmless no-op otherwise.
    for(const w of existingList){
      if(w.url.startsWith(engineUrlPrefix) && w.url!==engineUrl){
        await fetch(`${c.chatwoot_base}/api/v1/accounts/${c.chatwoot_account_id}/webhooks/${w.id}`, {method:'DELETE', headers:{api_access_token:c.chatwoot_token}}).catch(()=>{});
      }
    }

    if(!existingList.some(w=>w.url===engineUrl)){
      await fetch(`${c.chatwoot_base}/api/v1/accounts/${c.chatwoot_account_id}/webhooks`, {
        method:'POST', headers:{api_access_token:c.chatwoot_token, 'Content-Type':'application/json'},
        body:JSON.stringify({inbox_id:Number(c.chatwoot_inbox_id), url:engineUrl, subscriptions:['message_created']})
      });
    }
  }catch(e){}
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

// The one write path this public surface has for orders — order.html's checkout form. Same shape
// as handleApptPublicBook below: always creates a `pending` row, never reads/updates/deletes
// anything else, so a spammed/malicious submission can only ever add order-page noise for staff to
// review, not corrupt existing data. This is what actually captures size, delivery address and
// email — logPendingOrder (handleEngineWebhook's own "order intent detected" row, written the
// moment the bot sends this checkout link) only ever had product name/price, no space for any of
// that, by design (it exists so intent leaves a trail even if the customer never opens the link at
// all). A customer who does complete checkout ends up with two order rows: the bare intent one and
// this fuller one — an accepted duplicate, not a bug, since staff can tell them apart by `notes`
// and there's no reliable way to know from here whether they're "the same" order.
async function handleEcomPublicOrder(request, env){
  const body=await request.json().catch(()=>({}));
  const clientId=String(body.client_id||'');
  if(!clientId) return json({error:'client_id required'}, 400);
  const c=await getClientById(env, clientId);
  if(!c) return json({error:'Store not found'}, 404);
  const ordersTable=await ecomResolveTable(env, clientId, 'orders');
  if(!ordersTable) return json({error:'Ordering is not set up for this business yet — please contact us directly.'}, 400);

  const name=String(body.name||'').trim().slice(0,120);
  const phone=String(body.phone||'').replace(/[^0-9+]/g,'');
  if(!phone) return json({error:'Phone number is required.'}, 400);
  const email=String(body.email||'').trim().slice(0,200);
  const address=String(body.address||'').trim().slice(0,500);
  if(!address) return json({error:'Delivery address is required.'}, 400);
  const size=String(body.size||'').trim().slice(0,40);
  const notes=String(body.notes||'').trim().slice(0,500);
  const sku=String(body.sku||'').trim();

  const product=await ecomFindProductBySku(env, clientId, sku);
  if(!product) return json({error:'That product could not be found — please go back and try again.'}, 404);

  const order_id='ORD-'+Date.now();
  const items=`${product.name}${product.color?' — '+product.color:''}${size?', Size '+size:''}`;
  const orderBody={
    client_id:clientId, order_id,
    customer_name:name||'', customer_phone:phone, customer_email:email,
    order_date:new Date().toISOString().slice(0,10),
    items, total:product.price||0, currency:product.currency||'',
    delivery_address:address, status:'pending',
    notes:notes?`Placed via the order page.\n\nCustomer notes: ${notes}`:'Placed via the order page.'
  };
  const r=await ncFetch(env, `api/v2/tables/${ordersTable}/records`, {method:'POST', body:orderBody});
  if(!r.ok){
    const data=await r.json().catch(()=>({}));
    await reportOpsError(env, 'handleEcomPublicOrder', new Error(data?.msg||data?.error||`HTTP ${r.status}`), {clientId, ordersTable});
    return json({error:'Something went wrong saving your order — please try again or contact us directly.'}, 502);
  }
  return json({ok:true, order_id});
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

/* ── APPOINTMENT PUBLIC BOOKING PAGE (frontend/book.html) — same three cuts as the ecommerce
   public storefront above: (1) only one write path exists at all, the booking submission itself,
   and it can only ever create a `requested` row, never read/update/delete anything; (2) a fixed
   field whitelist on both the client record and each service row; (3) no access to any other
   table. This is the manual, customer-self-serve counterpart to the Cal.com sync and the AI
   auto-send — a client with no Cal.com account (or who just wants a simple always-available link)
   can hand out `book.html?client=<id>` directly. ── */
const APPT_PUBLIC_CLIENT_FIELDS=['Id','client_name','client_slug'];
const APPT_PUBLIC_SERVICE_FIELDS=['Id','name','duration_minutes','price','currency','description'];

async function apptPublicResolveClient(env, url){
  const clientId=String(url.searchParams.get('client')||url.searchParams.get('client_id')||'');
  if(clientId) return getClientById(env, clientId);
  const slug=String(url.searchParams.get('slug')||'');
  if(slug) return getClientBySlug(env, slug);
  return null;
}

async function handleApptPublicClient(request, env){
  const url=new URL(request.url);
  const c=await apptPublicResolveClient(env, url);
  if(!c || c.appt_enabled!=='Yes') return json({error:'Booking page not found'}, 404);
  return json(ecomPublicPick(c, APPT_PUBLIC_CLIENT_FIELDS));
}

async function handleApptPublicServices(request, env){
  const url=new URL(request.url);
  const c=await apptPublicResolveClient(env, url);
  if(!c || c.appt_enabled!=='Yes') return json({error:'Booking page not found'}, 404);
  const servicesTable=apptResolveTable(c, 'services');
  if(!servicesTable) return json({list:[]});
  const r=await ncFetch(env, `api/v2/tables/${servicesTable}/records?where=(client_id,eq,${c.Id})~and(status,neq,inactive)&limit=100`);
  const data=await r.json().catch(()=>({}));
  if(!r.ok) return json(data, r.status);
  return json({list:(data.list||[]).map(row=>ecomPublicPick(row, APPT_PUBLIC_SERVICE_FIELDS))});
}

// The one write path this whole public surface has — always creates a `requested` row (never
// confirms/updates/deletes), so a spammed or malicious submission can only ever add noise for
// staff to dismiss, not corrupt existing data.
async function handleApptPublicBook(request, env){
  const body=await request.json().catch(()=>({}));
  const clientId=String(body.client_id||'');
  if(!clientId) return json({error:'client_id required'}, 400);
  const c=await getClientById(env, clientId);
  if(!c || c.appt_enabled!=='Yes') return json({error:'Booking page not found'}, 404);
  const bookingsTable=apptResolveTable(c, 'bookings');
  if(!bookingsTable) return json({error:'Appointment booking is not set up for this business yet.'}, 400);

  const name=String(body.name||'').trim().slice(0,120);
  const phone=String(body.phone||'').replace(/[^0-9+]/g,'');
  if(!phone) return json({error:'Phone is required.'}, 400);
  const date=String(body.date||'').slice(0,10);
  const time=String(body.time||'').slice(0,5);
  const notes=String(body.notes||'').trim().slice(0,500);

  let service=null;
  if(body.service_id){
    const servicesTable=apptResolveTable(c, 'services');
    if(servicesTable){
      const sr=await ncFetch(env, `api/v2/tables/${servicesTable}/records?where=(client_id,eq,${clientId})~and(Id,eq,${Number(body.service_id)})&limit=1`);
      const sd=await sr.json().catch(()=>({}));
      service=sd?.list?.[0]||null;
    }
  }

  const {lead_id, stage_advanced}=await advanceLeadBookingAndTask(env, c, clientId, phone, name, service, {date, time});
  // notes from the public form aren't in advanceLeadBookingAndTask's fixed shape — patch them
  // onto the row it just inserted rather than threading a free-text field through that helper.
  if(notes){
    const r=await ncFetch(env, `api/v2/tables/${bookingsTable}/records?where=(client_id,eq,${clientId})~and(customer_phone,eq,${encodeURIComponent(phone)})~and(source,eq,public)&sort=-created_at&limit=1`);
    const d=await r.json().catch(()=>({}));
    const row=d?.list?.[0];
    if(row) await ncFetch(env, `api/v2/tables/${bookingsTable}/records`, {method:'PATCH', body:{Id:row.Id, notes:`Booked via the public booking page — awaiting confirmation.\n\nCustomer notes: ${notes}`}}).catch(()=>{});
  }

  return json({ok:true, lead_id, stage_advanced});
}

/* ── B2B MODULE (frontend/b2b.html) — Smart Documents (quotes/catalogs) with trackable public
   links and click-to-accept. Smart Lists (saved segment rules) live as a plain b2b_segments_json
   CLIENTS column, and Brand/Country classification live as plain LEADS columns — both are
   read/written straight through the existing /nocodb/* passthrough from b2b.html, exactly like
   every other CLIENTS/LEADS field in dashboard.html, since that passthrough already protects
   LEADS via its ClientId (PascalCase) cross-tenant check and CLIENTS via its single-record-Id
   check. Only Documents get dedicated routes here: B2B_DOCUMENTS_TABLE uses a lowercase
   client_id column, which that same passthrough guard does NOT match (it only regexes the
   literal "ClientId,eq,"), so ownership has to be enforced server-side instead — same reasoning
   as why /ecom/products etc. are dedicated routes rather than raw passthrough. ── */

// Auto-creates the Brand/Country/b2b_events Leads columns the first time the B2B module touches
// them — mirrors ensureFlowStateField above (memoized per Worker isolate, best-effort).
let _b2bLeadFieldsEnsured=false;
async function ensureB2bLeadFields(env){
  if(_b2bLeadFieldsEnsured) return;
  try{
    const existingR=await ncFetch(env, `api/v2/meta/tables/${DEFAULT_LEADS_TABLE}/fields`);
    const existing=await existingR.json().catch(()=>({}));
    const names=new Set((existing.list||[]).map(f=>f.title));
    if(!names.has('Brand')) await ncFetch(env, `api/v2/meta/tables/${DEFAULT_LEADS_TABLE}/fields`, {method:'POST', body:{title:'Brand', uidt:'SingleLineText'}});
    if(!names.has('Country')) await ncFetch(env, `api/v2/meta/tables/${DEFAULT_LEADS_TABLE}/fields`, {method:'POST', body:{title:'Country', uidt:'SingleLineText'}});
    if(!names.has('b2b_events')) await ncFetch(env, `api/v2/meta/tables/${DEFAULT_LEADS_TABLE}/fields`, {method:'POST', body:{title:'b2b_events', uidt:'LongText'}});
    _b2bLeadFieldsEnsured=true;
  }catch(e){ console.error('[b2b] ensureB2bLeadFields failed', e.message); }
}

// Called once by b2b.html on load — ensures the Leads columns Brand/Country/b2b_events exist
// before the page starts writing to them directly through /nocodb/*.
// Mirrors ensureB2bLeadFields but for the CLIENTS table — b2b_enabled already gets its own
// check-and-create step in dashboard.html's Settings save handler (same pattern as ta_enabled),
// but b2b_segments_json is only ever written from b2b.html's Smart Lists save, which had no such
// step — on a fresh NocoDB base that PATCH would just fail with "Save didn't take effect" the
// first time a Smart List was created. Ensuring it here, on every b2b.html load, closes that gap.
let _b2bClientFieldsEnsured=false;
async function ensureB2bClientFields(env){
  if(_b2bClientFieldsEnsured) return;
  try{
    const existingR=await ncFetch(env, `api/v2/meta/tables/${CLIENTS_TABLE}/fields`);
    const existing=await existingR.json().catch(()=>({}));
    const names=new Set((existing.list||[]).map(f=>f.title));
    if(!names.has('b2b_segments_json')) await ncFetch(env, `api/v2/meta/tables/${CLIENTS_TABLE}/fields`, {method:'POST', body:{title:'b2b_segments_json', uidt:'LongText'}});
    _b2bClientFieldsEnsured=true;
  }catch(e){ console.error('[b2b] ensureB2bClientFields failed', e.message); }
}

async function handleB2bInit(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  await ensureB2bLeadFields(env);
  await ensureB2bClientFields(env);
  return json({ok:true});
}

function computeB2bDocSubtotal(lineItems){
  let subtotal=0;
  (Array.isArray(lineItems)?lineItems:[]).forEach(li=>{ subtotal += (Number(li.qty)||0) * (Number(li.price)||0); });
  return subtotal;
}
async function findB2bDocument(env, id){
  const r=await ncFetch(env, `api/v2/tables/${b2bDocumentsTable(env)}/records/${id}`);
  if(!r.ok) return null;
  return r.json().catch(()=>null);
}
async function findB2bDocumentBySlug(env, slug){
  const r=await ncFetch(env, `api/v2/tables/${b2bDocumentsTable(env)}/records?where=${encodeURIComponent(`(public_slug,eq,${slug})`)}&limit=1`);
  if(!r.ok) return null;
  const data=await r.json().catch(()=>({}));
  return data?.list?.[0]||null;
}
// Appends one event to a lead's b2b_events log (capped at the last 50) — feeds Smart Lists'
// "viewed/accepted a document in the last N days" rule. Best-effort: never blocks the public
// view/accept response on this bookkeeping succeeding.
async function appendB2bLeadEvent(env, leadId, type, meta){
  if(!leadId) return;
  try{
    const leadR=await ncFetch(env, `api/v2/tables/${DEFAULT_LEADS_TABLE}/records/${leadId}`);
    if(!leadR.ok) return;
    const lead=await leadR.json();
    let events=[]; try{ events=JSON.parse(lead.b2b_events||'[]'); }catch(e){}
    events.push({type, at:new Date().toISOString(), meta:meta||{}});
    if(events.length>50) events=events.slice(-50);
    await ncFetch(env, `api/v2/tables/${DEFAULT_LEADS_TABLE}/records`, {method:'PATCH', body:{Id:Number(leadId), b2b_events:JSON.stringify(events)}});
  }catch(e){}
}

async function handleB2bDocumentsList(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const r=await ncFetch(env, `api/v2/tables/${b2bDocumentsTable(env)}/records?where=${encodeURIComponent(`(client_id,eq,${payload.cid})`)}&sort=-created_at&limit=500`);
  const data=await r.json().catch(()=>({}));
  if(!r.ok) return json(data, r.status);
  return json({list:data.list||[]});
}

async function handleB2bDocumentCreate(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const body=await request.json().catch(()=>({}));
  const type=body.type==='catalog'?'catalog':'quote';
  const lineItems=Array.isArray(body.line_items)?body.line_items:[];
  const subtotal=computeB2bDocSubtotal(lineItems);
  const taxPct=Number(body.tax_pct)||0;
  const total=subtotal + subtotal*(taxPct/100);
  const fields={
    client_id:String(payload.cid), lead_id:body.lead_id?String(body.lead_id):'',
    type, title:String(body.title||'').trim().slice(0,200), brand:String(body.brand||'').trim().slice(0,100),
    line_items_json:JSON.stringify(lineItems), currency:String(body.currency||'').trim().slice(0,10),
    subtotal, tax_pct:taxPct, total, status:'draft',
    public_slug:crypto.randomUUID().replace(/-/g,''), view_count:0, last_viewed_at:'', accepted_at:'',
    created_at:new Date().toISOString(), expires_at:body.expires_at||'', notes:String(body.notes||'').trim().slice(0,1000)
  };
  const r=await ncFetch(env, `api/v2/tables/${b2bDocumentsTable(env)}/records`, {method:'POST', body:fields});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) return json(data, r.status);
  return json({...fields, Id:data.Id});
}

async function handleB2bDocumentUpdate(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const body=await request.json().catch(()=>({}));
  if(!body.id) return json({error:'id required'}, 400);
  const existing=await findB2bDocument(env, body.id);
  if(!existing || String(existing.client_id)!==String(payload.cid)) return json({error:'Not found'}, 404);
  const fields={Id:Number(body.id)};
  if(body.title!==undefined) fields.title=String(body.title).trim().slice(0,200);
  if(body.brand!==undefined) fields.brand=String(body.brand).trim().slice(0,100);
  if(body.status!==undefined) fields.status=String(body.status);
  if(body.notes!==undefined) fields.notes=String(body.notes).trim().slice(0,1000);
  if(body.expires_at!==undefined) fields.expires_at=body.expires_at;
  if(Array.isArray(body.line_items)){
    const subtotal=computeB2bDocSubtotal(body.line_items);
    const taxPct=body.tax_pct!==undefined?(Number(body.tax_pct)||0):(Number(existing.tax_pct)||0);
    fields.line_items_json=JSON.stringify(body.line_items);
    fields.subtotal=subtotal; fields.tax_pct=taxPct; fields.total=subtotal+subtotal*(taxPct/100);
  }
  const r=await ncFetch(env, `api/v2/tables/${b2bDocumentsTable(env)}/records`, {method:'PATCH', body:fields});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) return json(data, r.status);
  return json({ok:true});
}

async function handleB2bDocumentDelete(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const body=await request.json().catch(()=>({}));
  if(!body.id) return json({error:'id required'}, 400);
  const existing=await findB2bDocument(env, body.id);
  if(!existing || String(existing.client_id)!==String(payload.cid)) return json({error:'Not found'}, 404);
  const r=await ncFetch(env, `api/v2/tables/${b2bDocumentsTable(env)}/records`, {method:'DELETE', body:{Id:Number(body.id)}});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) return json(data, r.status);
  return json({ok:true});
}

// Public — no session, by design: hit by the B2B client's own customer opening a trackable
// quote/catalog link (b2b.html?slug=...). Logs a view and appends a b2b_events entry on the
// linked lead so Smart Lists can target "viewed a document in the last N days".
const B2B_PUBLIC_DOC_FIELDS=['Id','type','title','brand','line_items_json','currency','subtotal','tax_pct','total','status','view_count','accepted_at','expires_at'];
async function handleB2bDocPublicGet(request, env, slug){
  await ensureB2bLeadFields(env);
  const doc=await findB2bDocumentBySlug(env, slug);
  if(!doc) return json({error:'Not found'}, 404);
  const patch={view_count:(Number(doc.view_count)||0)+1, last_viewed_at:new Date().toISOString()};
  if(doc.status==='draft'||doc.status==='sent') patch.status='viewed';
  await ncFetch(env, `api/v2/tables/${b2bDocumentsTable(env)}/records`, {method:'PATCH', body:{Id:doc.Id, ...patch}});
  await appendB2bLeadEvent(env, doc.lead_id, 'doc_view', {slug});
  const out={}; B2B_PUBLIC_DOC_FIELDS.forEach(k=>{ out[k]=doc[k]; });
  out.view_count=patch.view_count; out.status=patch.status||doc.status;
  return json(out);
}

// Public — no session. Click-to-accept only (no e-signature) — records an acceptance timestamp,
// nothing more.
async function handleB2bDocPublicAccept(request, env, slug){
  await ensureB2bLeadFields(env);
  const doc=await findB2bDocumentBySlug(env, slug);
  if(!doc) return json({error:'Not found'}, 404);
  if(doc.status==='accepted') return json({ok:true, already:true});
  const acceptedAt=new Date().toISOString();
  await ncFetch(env, `api/v2/tables/${b2bDocumentsTable(env)}/records`, {method:'PATCH', body:{Id:doc.Id, status:'accepted', accepted_at:acceptedAt}});
  await appendB2bLeadEvent(env, doc.lead_id, 'doc_accepted', {slug});
  return json({ok:true, accepted_at:acceptedAt});
}

/* ── ACCOUNTING MODULE (frontend/dashboard.html — "💰 Accounting") — Quotation → Invoice →
   Receipt lifecycle for any client's existing leads, with optional one-way push to a client's own
   ERPNext (Frappe Cloud) site. Same ACCOUNTING_DOCUMENTS_TABLE-uses-a-lowercase-client_id-column
   reasoning as B2B_DOCUMENTS_TABLE above (see that module's comment) — dedicated routes, not the
   generic /nocodb/* passthrough, since ownership has to be enforced server-side here too.
   Deliberately industry-agnostic (not gated behind b2b_enabled or any industry flag) — any
   client's lead can be quoted/invoiced regardless of what they sell. ── */

function computeAccountingDocTotals(lineItems, taxPct){
  let subtotal=0;
  (Array.isArray(lineItems)?lineItems:[]).forEach(li=>{ subtotal += (Number(li.qty)||0) * (Number(li.price)||0); });
  const pct=Number(taxPct)||0;
  const taxAmount=subtotal*(pct/100);
  return {subtotal, taxAmount, total:subtotal+taxAmount};
}

async function findAccountingDocument(env, id){
  const r=await ncFetch(env, `api/v2/tables/${accountingDocumentsTable(env)}/records/${id}`);
  if(!r.ok) return null;
  return r.json().catch(()=>null);
}

async function handleAccountingDocumentsList(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const url=new URL(request.url);
  const leadId=url.searchParams.get('lead_id');
  let where=`(client_id,eq,${payload.cid})`;
  if(leadId) where+=`~and(lead_id,eq,${leadId})`;
  const r=await ncFetch(env, `api/v2/tables/${accountingDocumentsTable(env)}/records?where=${encodeURIComponent(where)}&sort=-doc_created_at&limit=500`);
  const data=await r.json().catch(()=>({}));
  if(!r.ok) return json(data, r.status);
  return json({list:data.list||[]});
}

async function handleAccountingDocumentCreate(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const body=await request.json().catch(()=>({}));
  const VALID_TYPES=new Set(['quotation','invoice','receipt']);
  const type=VALID_TYPES.has(body.type)?body.type:'quotation';
  const lineItems=Array.isArray(body.line_items)?body.line_items:[];
  const taxPct=Number(body.tax_pct)||0;
  const {subtotal, taxAmount, total}=computeAccountingDocTotals(lineItems, taxPct);
  const fields={
    client_id:String(payload.cid), lead_id:body.lead_id?String(body.lead_id):'',
    type, title:String(body.title||'').trim().slice(0,200),
    line_items_json:JSON.stringify(lineItems), currency:String(body.currency||'').trim().slice(0,10),
    subtotal, tax_pct:taxPct, tax_amount:taxAmount, total, status:'draft',
    linked_doc_id:body.linked_doc_id?String(body.linked_doc_id):'',
    notes:String(body.notes||'').trim().slice(0,1000),
    erpnext_doctype:'', erpnext_doc_name:'', erpnext_sync_status:'', erpnext_sync_error:'', erpnext_synced_at:'',
    doc_created_at:new Date().toISOString(),
  };
  const r=await ncFetch(env, `api/v2/tables/${accountingDocumentsTable(env)}/records`, {method:'POST', body:fields});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) return json(data, r.status);
  return json({...fields, Id:data.Id});
}

async function handleAccountingDocumentUpdate(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const body=await request.json().catch(()=>({}));
  if(!body.id) return json({error:'id required'}, 400);
  const existing=await findAccountingDocument(env, body.id);
  if(!existing || String(existing.client_id)!==String(payload.cid)) return json({error:'Not found'}, 404);
  const fields={Id:Number(body.id)};
  if(body.title!==undefined) fields.title=String(body.title).trim().slice(0,200);
  if(body.status!==undefined) fields.status=String(body.status);
  if(body.notes!==undefined) fields.notes=String(body.notes).trim().slice(0,1000);
  if(body.currency!==undefined) fields.currency=String(body.currency).trim().slice(0,10);
  if(Array.isArray(body.line_items)){
    const taxPct=body.tax_pct!==undefined?(Number(body.tax_pct)||0):(Number(existing.tax_pct)||0);
    const {subtotal, taxAmount, total}=computeAccountingDocTotals(body.line_items, taxPct);
    fields.line_items_json=JSON.stringify(body.line_items);
    fields.subtotal=subtotal; fields.tax_pct=taxPct; fields.tax_amount=taxAmount; fields.total=total;
  }
  const r=await ncFetch(env, `api/v2/tables/${accountingDocumentsTable(env)}/records`, {method:'PATCH', body:fields});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) return json(data, r.status);
  return json({ok:true});
}

async function handleAccountingDocumentDelete(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const body=await request.json().catch(()=>({}));
  if(!body.id) return json({error:'id required'}, 400);
  const existing=await findAccountingDocument(env, body.id);
  if(!existing || String(existing.client_id)!==String(payload.cid)) return json({error:'Not found'}, 404);
  const r=await ncFetch(env, `api/v2/tables/${accountingDocumentsTable(env)}/records`, {method:'DELETE', body:{Id:Number(body.id)}});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) return json(data, r.status);
  return json({ok:true});
}

// Quotation → Invoice → Receipt — a new draft document in the next stage, pre-filled from the
// source (line items, totals, lead), linked back via linked_doc_id. Deliberately a new record
// rather than mutating the source in place — the original quotation/invoice should stay exactly as
// it was sent, since that's what the customer actually saw/agreed to.
const ACCOUNTING_CONVERT_MAP={quotation:'invoice', invoice:'receipt'};
async function handleAccountingDocumentConvert(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const body=await request.json().catch(()=>({}));
  if(!body.id) return json({error:'id required'}, 400);
  const src=await findAccountingDocument(env, body.id);
  if(!src || String(src.client_id)!==String(payload.cid)) return json({error:'Not found'}, 404);
  const toType=ACCOUNTING_CONVERT_MAP[src.type];
  if(!toType) return json({error:`Cannot convert a ${src.type} — only quotation→invoice and invoice→receipt are supported`}, 400);
  const fields={
    client_id:String(payload.cid), lead_id:src.lead_id||'',
    type:toType, title:src.title||'', line_items_json:src.line_items_json||'[]',
    currency:src.currency||'', subtotal:src.subtotal||0, tax_pct:src.tax_pct||0, tax_amount:src.tax_amount||0, total:src.total||0,
    status:'draft', linked_doc_id:String(src.Id), notes:src.notes||'',
    erpnext_doctype:'', erpnext_doc_name:'', erpnext_sync_status:'', erpnext_sync_error:'', erpnext_synced_at:'',
    doc_created_at:new Date().toISOString(),
  };
  const r=await ncFetch(env, `api/v2/tables/${accountingDocumentsTable(env)}/records`, {method:'POST', body:fields});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) return json(data, r.status);
  return json({...fields, Id:data.Id});
}

// ── ERPNext (Frappe) push integration — per-client credentials (erpnext_base_url/
// erpnext_api_key/erpnext_api_secret, CLIENTS fields, same plaintext-on-CLIENTS convention as
// wa_token/chatwoot_token/openrouter_key elsewhere in this file), since each of THIS app's clients
// runs their own separate ERPNext/Frappe Cloud site — one-way push only (create in ERPNext when a
// document is created here), never pulled back. Frappe's REST API uses token auth
// (`Authorization: token {api_key}:{api_secret}`) — see https://frappeframework.com/docs for the
// resource API shape assumed below (POST /api/resource/<Doctype>, filters as a JSON array).
function erpnextConfigured(c){ return !!(c.erpnext_base_url && c.erpnext_api_key && c.erpnext_api_secret); }
async function erpnextFetch(c, path, options={}){
  const base=(c.erpnext_base_url||'').trim().replace(/\/+$/,'');
  return fetch(`${base}${path}`, {
    ...options,
    headers:{Authorization:`token ${c.erpnext_api_key}:${c.erpnext_api_secret}`, 'Content-Type':'application/json', ...(options.headers||{})}
  });
}
function erpnextErrorMessage(data, status){
  // Frappe's error shape varies — validation errors come back as `exception` (a formatted string)
  // or `_server_messages` (a JSON-encoded array of {message} objects); neither is guaranteed.
  if(data?.exception) return String(data.exception).slice(0,500);
  if(data?._server_messages){
    try{ const msgs=JSON.parse(data._server_messages); return msgs.map(m=>{ try{ return JSON.parse(m).message; }catch(e){ return m; } }).join('; ').slice(0,500); }
    catch(e){ /* fall through */ }
  }
  return `HTTP ${status}`;
}

// Finds an existing Customer by name, or creates a minimal one. ERPNext's Quotation/Sales
// Invoice/Payment Entry doctypes all require a real Customer record to exist first — there's no
// way to post a sales document against a bare name string.
async function erpnextResolveCustomer(c, leadName, leadPhone){
  const name=String(leadName||leadPhone||'Customer').trim().slice(0,140)||'Customer';
  const filters=encodeURIComponent(JSON.stringify([['customer_name','=',name]]));
  const searchR=await erpnextFetch(c, `/api/resource/Customer?filters=${filters}&limit_page_length=1`);
  const searchData=await searchR.json().catch(()=>({}));
  if(searchR.ok && searchData?.data?.[0]?.name) return searchData.data[0].name;
  const createR=await erpnextFetch(c, '/api/resource/Customer', {method:'POST', body:JSON.stringify({customer_name:name, customer_type:'Individual'})});
  const createData=await createR.json().catch(()=>({}));
  if(!createR.ok) throw new Error('Customer — '+erpnextErrorMessage(createData, createR.status));
  return createData?.data?.name;
}

// Finds an existing Item by name, or creates a minimal non-stock service item. Same "must exist
// first" constraint as Customer above — a line item's `item_code` has to reference a real Item.
// Auto-creating on first use (rather than requiring the client to pre-map every service to an
// ERPNext item code) trades some chart-of-accounts tidiness for the document actually syncing
// instead of hard-failing on the first unmapped line item — a client who wants tighter control can
// still pre-create the exact Item names in ERPNext themselves, since this only creates one when no
// matching name is found.
async function erpnextResolveItem(c, itemName){
  const name=String(itemName||'Service').trim().slice(0,140)||'Service';
  const filters=encodeURIComponent(JSON.stringify([['item_name','=',name]]));
  const searchR=await erpnextFetch(c, `/api/resource/Item?filters=${filters}&limit_page_length=1`);
  const searchData=await searchR.json().catch(()=>({}));
  if(searchR.ok && searchData?.data?.[0]?.name) return searchData.data[0].name;
  const createR=await erpnextFetch(c, '/api/resource/Item', {method:'POST', body:JSON.stringify({item_code:name, item_name:name, item_group:'Services', is_stock_item:0, stock_uom:'Nos'})});
  const createData=await createR.json().catch(()=>({}));
  if(!createR.ok) throw new Error('Item — '+erpnextErrorMessage(createData, createR.status));
  return createData?.data?.name;
}

// Pushes a quotation/invoice as a real ERPNext Quotation or Sales Invoice — resolves the customer
// and every line item's Item first (both required to exist before the parent document can be
// created), then posts the document with a flat percentage tax line if tax_pct is set. Returns the
// new document's ERPNext name (e.g. "SINV-2026-00001").
async function erpnextPushSalesDoc(c, erpDoctype, doc, lead){
  const customer=await erpnextResolveCustomer(c, lead?.Name, lead?.Phone);
  const lineItems=engineParseJsonField(doc.line_items_json, []);
  const items=[];
  for(const li of lineItems){
    const itemCode=await erpnextResolveItem(c, li.name);
    items.push({item_code:itemCode, qty:Number(li.qty)||1, rate:Number(li.price)||0});
  }
  if(!items.length) throw new Error('No line items to send');
  const payload={customer, items};
  const taxPct=Number(doc.tax_pct)||0;
  if(taxPct>0) payload.taxes=[{charge_type:'On Net Total', description:'Tax', rate:taxPct, account_head:''}];
  const r=await erpnextFetch(c, `/api/resource/${encodeURIComponent(erpDoctype)}`, {method:'POST', body:JSON.stringify(payload)});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(erpnextErrorMessage(data, r.status));
  return data?.data?.name;
}

// Pushes a receipt as an ERPNext Payment Entry — a "Receive" payment from the customer, linked
// back to the source invoice's own ERPNext document if one was pushed (allocates the payment
// against that invoice; without a linked/synced invoice it's still recorded as an unallocated
// receipt against the customer rather than blocking the sync entirely).
async function erpnextPushPaymentEntry(c, doc, lead, invoiceErpnextName){
  const customer=await erpnextResolveCustomer(c, lead?.Name, lead?.Phone);
  const amount=Number(doc.total)||0;
  const payload={
    payment_type:'Receive', party_type:'Customer', party:customer,
    paid_amount:amount, received_amount:amount,
    references:invoiceErpnextName?[{reference_doctype:'Sales Invoice', reference_name:invoiceErpnextName, allocated_amount:amount}]:[],
  };
  const r=await erpnextFetch(c, '/api/resource/Payment Entry', {method:'POST', body:JSON.stringify(payload)});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(erpnextErrorMessage(data, r.status));
  return data?.data?.name;
}

const ACCOUNTING_ERPNEXT_DOCTYPE_MAP={quotation:'Quotation', invoice:'Sales Invoice', receipt:'Payment Entry'};
async function handleAccountingDocumentSyncErpnext(request, env){
  const payload=await requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const body=await request.json().catch(()=>({}));
  if(!body.id) return json({error:'id required'}, 400);
  const c=await getClientById(env, payload.cid);
  if(!c || !erpnextConfigured(c)) return json({error:'ERPNext is not connected for this account — add your Frappe Cloud site URL and API key/secret in Settings → Accounting.'}, 400);
  const doc=await findAccountingDocument(env, body.id);
  if(!doc || String(doc.client_id)!==String(payload.cid)) return json({error:'Not found'}, 404);
  const erpDoctype=ACCOUNTING_ERPNEXT_DOCTYPE_MAP[doc.type];
  if(!erpDoctype) return json({error:'Unknown document type'}, 400);

  let lead=null;
  if(doc.lead_id){
    const leadR=await ncFetch(env, `api/v2/tables/${DEFAULT_LEADS_TABLE}/records/${doc.lead_id}`);
    if(leadR.ok) lead=await leadR.json().catch(()=>null);
  }

  try{
    let erpName;
    if(doc.type==='receipt'){
      let invoiceErpName=null;
      if(doc.linked_doc_id){
        const linked=await findAccountingDocument(env, doc.linked_doc_id);
        invoiceErpName=linked?.erpnext_doc_name||null;
      }
      erpName=await erpnextPushPaymentEntry(c, doc, lead, invoiceErpName);
    }else{
      erpName=await erpnextPushSalesDoc(c, erpDoctype, doc, lead);
    }
    await ncFetch(env, `api/v2/tables/${accountingDocumentsTable(env)}/records`, {method:'PATCH', body:{
      Id:doc.Id, erpnext_doctype:erpDoctype, erpnext_doc_name:erpName||'', erpnext_sync_status:'synced', erpnext_sync_error:'', erpnext_synced_at:new Date().toISOString()
    }});
    return json({ok:true, erpnext_doc_name:erpName});
  }catch(e){
    const msg=String(e.message||e).slice(0,500);
    await ncFetch(env, `api/v2/tables/${accountingDocumentsTable(env)}/records`, {method:'PATCH', body:{
      Id:doc.Id, erpnext_sync_status:'failed', erpnext_sync_error:msg
    }});
    await reportOpsError(env, 'handleAccountingDocumentSyncErpnext — ERPNext push failed', e, {clientId:payload.cid, docId:doc.Id, type:doc.type});
    return json({error:'ERPNext sync failed: '+msg}, 502);
  }
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
      else if(url.pathname==='/ecom/order-link' && request.method==='POST'){ res=await handleEcomOrderLink(request, env); }
      else if(url.pathname==='/leads/booking-link' && request.method==='POST'){ res=await handleLeadBookingLink(request, env); }
      else if(url.pathname.startsWith('/calcom/webhook/') && request.method==='POST'){ res=await handleCalcomWebhook(request, env, url.pathname.slice('/calcom/webhook/'.length)); }
      else if(url.pathname==='/ecom/order-lookup' && request.method==='GET'){ res=await handleEcomOrderLookup(request, env); }
      else if(url.pathname==='/ecom/enable-order-tracking' && request.method==='POST'){ res=await handleEcomEnableOrderTracking(request, env); }
      else if(url.pathname==='/hooks/chatwoot-message' && request.method==='POST'){ res=await handleChatwootMessageHook(request, env); }
      else if(url.pathname.startsWith('/engine/webhook/') && request.method==='POST'){ res=await handleEngineWebhook(request, env, url.pathname.slice('/engine/webhook/'.length)); }
      else if(url.pathname==='/ecom/public/client' && request.method==='GET'){ res=await handleEcomPublicClient(request, env); }
      else if(url.pathname==='/ecom/public/products' && request.method==='GET'){ res=await handleEcomPublicProducts(request, env); }
      else if(url.pathname==='/ecom/public/order' && request.method==='POST'){ res=await handleEcomPublicOrder(request, env); }
      else if(url.pathname==='/ecom/public/stores' && request.method==='GET'){ res=await handleEcomPublicStores(request, env); }
      else if(url.pathname==='/appt/public/client' && request.method==='GET'){ res=await handleApptPublicClient(request, env); }
      else if(url.pathname==='/appt/public/services' && request.method==='GET'){ res=await handleApptPublicServices(request, env); }
      else if(url.pathname==='/appt/public/book' && request.method==='POST'){ res=await handleApptPublicBook(request, env); }
      else if(url.pathname==='/ecom/wa-templates' && request.method==='GET'){ res=await handleEcomWaTemplatesGet(request, env); }
      else if(url.pathname==='/ecom/wa-templates/create-preset' && request.method==='POST'){ res=await handleEcomWaTemplatesCreatePreset(request, env); }
      else if(url.pathname==='/ecom/wa-templates/create-from-library' && request.method==='POST'){ res=await handleEcomWaTemplatesCreateFromLibrary(request, env); }
      else if(url.pathname==='/ai/complete' && request.method==='POST'){ res=await handleAiComplete(request, env); }
      else if(url.pathname==='/ai/objection-reply' && request.method==='POST'){ res=await handleAiObjectionReply(request, env); }
      else if(url.pathname==='/ai/order-signal' && request.method==='POST'){ res=await handleAiOrderSignal(request, env); }
      else if(url.pathname==='/ai/booking-signal' && request.method==='POST'){ res=await handleAiBookingSignal(request, env); }
      else if(url.pathname==='/broadcast/templates' && request.method==='GET'){ res=await handleBroadcastTemplatesGet(request, env); }
      else if(url.pathname==='/broadcast/templates' && request.method==='POST'){ res=await handleBroadcastTemplatesCreate(request, env); }
      else if(url.pathname==='/broadcast/templates/sync' && request.method==='POST'){ res=await handleBroadcastTemplatesSync(request, env); }
      else if(url.pathname==='/broadcast/send-dm' && request.method==='POST'){ res=await handleBroadcastSendDm(request, env); }
      else if(url.pathname==='/broadcast/send-template' && request.method==='POST'){ res=await handleBroadcastSendTemplate(request, env); }
      else if(url.pathname==='/broadcast/followup-send' && request.method==='POST'){ res=await handleBroadcastFollowupSend(request, env); }
      else if(url.pathname==='/automations/flows' && request.method==='GET'){ res=await handleAutomationFlowsList(request, env); }
      else if(url.pathname==='/automations/flows' && request.method==='POST'){ res=await handleAutomationFlowCreate(request, env); }
      else if(url.pathname==='/automations/flows' && request.method==='PATCH'){ res=await handleAutomationFlowUpdate(request, env); }
      else if(url.pathname==='/automations/flows' && request.method==='DELETE'){ res=await handleAutomationFlowDelete(request, env); }
      else if(url.pathname==='/automations/flows/enroll' && request.method==='POST'){ res=await handleAutomationFlowEnroll(request, env); }
      else if(url.pathname==='/automations/audience-preview' && request.method==='GET'){ res=await handleAutomationAudiencePreview(request, env); }
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
      else if(url.pathname==='/admin/backfill-engine-webhooks' && request.method==='POST'){ res=await handleAdminBackfillEngineWebhooks(request, env); }
      else if(url.pathname==='/admin/billing-refresh' && request.method==='POST'){ res=await handleAdminBillingRefresh(request, env); }
      else if(url.pathname==='/admin/billing-portal-link' && request.method==='POST'){ res=await handleAdminBillingPortalLink(request, env); }
      else if(url.pathname==='/admin/billing-reset-anchor' && request.method==='POST'){ res=await handleAdminBillingResetAnchor(request, env); }
      else if(url.pathname==='/b2b/init' && request.method==='GET'){ res=await handleB2bInit(request, env); }
      else if(url.pathname==='/b2b/documents' && request.method==='GET'){ res=await handleB2bDocumentsList(request, env); }
      else if(url.pathname==='/b2b/documents' && request.method==='POST'){ res=await handleB2bDocumentCreate(request, env); }
      else if(url.pathname==='/b2b/documents' && request.method==='PATCH'){ res=await handleB2bDocumentUpdate(request, env); }
      else if(url.pathname==='/b2b/documents' && request.method==='DELETE'){ res=await handleB2bDocumentDelete(request, env); }
      else if(url.pathname.startsWith('/b2b/doc/') && url.pathname.endsWith('/accept') && request.method==='POST'){ res=await handleB2bDocPublicAccept(request, env, url.pathname.slice('/b2b/doc/'.length, -'/accept'.length)); }
      else if(url.pathname.startsWith('/b2b/doc/') && request.method==='GET'){ res=await handleB2bDocPublicGet(request, env, url.pathname.slice('/b2b/doc/'.length)); }
      else if(url.pathname==='/accounting/documents' && request.method==='GET'){ res=await handleAccountingDocumentsList(request, env); }
      else if(url.pathname==='/accounting/documents' && request.method==='POST'){ res=await handleAccountingDocumentCreate(request, env); }
      else if(url.pathname==='/accounting/documents' && request.method==='PATCH'){ res=await handleAccountingDocumentUpdate(request, env); }
      else if(url.pathname==='/accounting/documents' && request.method==='DELETE'){ res=await handleAccountingDocumentDelete(request, env); }
      else if(url.pathname==='/accounting/documents/convert' && request.method==='POST'){ res=await handleAccountingDocumentConvert(request, env); }
      else if(url.pathname==='/accounting/documents/sync-erpnext' && request.method==='POST'){ res=await handleAccountingDocumentSyncErpnext(request, env); }
      else{ res=json({error:'Not found'}, 404); }
    }catch(e){
      res=json({error:e.message||'Internal error'}, 500);
      await reportOpsError(env, `unhandled — ${request.method} ${url.pathname}`, e);
    }

    const headers=new Headers(res.headers);
    Object.entries(cors).forEach(([k,v])=>headers.set(k,v));
    return new Response(res.body, {status:res.status, headers});
  },

  // Cloudflare Cron Triggers — see wrangler.toml [triggers]. Three schedules share this one
  // entry point: the daily health check, the Automations module's flow-advance tick, and the
  // Shopify abandoned-cart sweep.
  async scheduled(event, env, ctx){
    if(event.cron==='0 2 * * *') ctx.waitUntil(runDailyHealthCheckForAllClients(env));
    else if(event.cron==='*/15 * * * *') ctx.waitUntil(runAutomationFlowsForAllClients(env));
    else ctx.waitUntil(sweepAbandonedShopifyCheckouts(env));
  }
};
