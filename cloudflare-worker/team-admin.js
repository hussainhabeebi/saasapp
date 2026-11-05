/* ═══════════════════════════════════════════════════════════════════════════
   TEAM ADMIN: shared rules for User Management (users.html and the existing dashboard page).
   Pure (no I/O). Storage, Authentik and NocoDB calls live in worker.js.

   A teammate's access still comes only from CLIENTS.team_emails (owner = authentik_email), exactly
   as before. What is new is a per-account record of everyone added through User Management
   (D1 team_member_meta): pending / active / deactivated / removed, when they were invited, when
   they last signed in. That record is what lets a login tell "a teammate whose access was removed"
   apart from "a brand-new signup", so a removed or half-created teammate is never handed an empty
   account of their own again.
   ═══════════════════════════════════════════════════════════════════════════ */

export const TM_STATUSES=['pending','active','deactivated','removed'];
export const TM_INVITE_KINDS=['invite','login','existing'];
// Same keys as dashboard.html ROLES; 'custom' means "my own module selection, no preset".
export const TM_ROLE_KEYS=['admin','general_manager','sales_manager','marketing_manager','telecaller'];
// Same keys as dashboard.html MODULE_PERMISSIONS.
export const TM_MODULE_KEYS=['home','humandeals','chats','leads','tasks','team','reports','knowledgebase','accounting','billing','ecommerce',
  'businessservices','saasops','b2b','agency','recruit','appointments','hospitality','realestate','healthcare','matrimonial','evcharging','broadcast','settings'];
// Roles that may manage the team (besides the account owner).
export const TM_MANAGER_ROLES=['admin'];
export const TM_BULK_MAX=25;

export const tmEmail=v=>String(v||'').trim().toLowerCase();
export const TM_EMAIL_RE=/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
export function tmTeamEmails(c){ return String(c?.team_emails||'').split(',').map(tmEmail).filter(Boolean); }
export function tmJson(v,fallback){ if(v&&typeof v==='object')return v; try{const o=JSON.parse(v||'');return o&&typeof o==='object'?o:fallback;}catch(e){return fallback;} }
export function tmIsOwner(c,email){ const e=tmEmail(email); return !!e&&e===tmEmail(c?.authentik_email); }
export function tmRoleOf(c,email){ return tmJson(c?.team_permissions,{})[tmEmail(email)]?.role||null; }
export function tmCanManage(c,email){ return tmIsOwner(c,email)||TM_MANAGER_ROLES.includes(tmRoleOf(c,email)); }

// The business name a brand-new signup is given (worker.js deriveBusinessNameServer).
export function tmDerivedName(email){
  const local=(String(email||'').split('@')[0]||'').replace(/[._-]+/g,' ').trim();
  return local.replace(/\b\w/g,ch=>ch.toUpperCase())||'New Business';
}
// An account that was only ever auto-created at someone's first sign-in and never used: owned by
// this email, nobody else on it, still its generated name, no industry chosen, no Chatwoot, no
// WhatsApp, no plan, not archived, and no leads. Only such an account can be folded into a team;
// anything that looks used is left alone.
export function tmIsOrphanAccount(row,email,{leadCount=0}={}){
  if(!row||tmEmail(row.authentik_email)!==tmEmail(email))return false;
  if(tmTeamEmails(row).length)return false;
  if(String(row.signup_status||'')==='archived')return false;
  if(String(row.client_name||'').trim()!==tmDerivedName(email))return false;
  if(!['','general'].includes(String(row.industry||'').trim().toLowerCase()))return false;
  for(const k of ['chatwoot_account_id','wa_phone_id','plan_tier','razorpay_subscription_id','shopify_domain'])if(String(row[k]||'').trim())return false;
  return Number(leadCount)===0;
}

// "Can this email join this account?" with a message that says what to do about it.
//   owner | team | other_account | other_team | orphan_account | has_login | new
export function tmEmailMessage(status,{otherName=''}={}){
  const acc=otherName?` (“${otherName}”)`:'';
  return {
    owner:"That's the account owner's email. The owner already has full access.",
    team:'This person is already on your team.',
    other_account:`This email owns another Leadvyne account${acc}. One login belongs to one account: ask them to use a different email, or contact support to merge the accounts.`,
    other_team:`This person is already a teammate on another Leadvyne account${acc}. Ask that account's admin to remove them first, or use a different email.`,
    orphan_account:'This email has an empty Leadvyne account that was created by mistake (for example after an earlier attempt failed). You can move them to your team.',
  }[status]||null;
}

// What the members list shows for one person.
export function tmMemberView(c,email,meta={},{names=null,perms=null,whatsapp=null,chatwootUsers=null}={}){
  const e=tmEmail(email);
  names=names||tmJson(c?.team_names,{});perms=perms||tmJson(c?.team_permissions,{});
  whatsapp=whatsapp||tmJson(c?.team_whatsapp,{});chatwootUsers=chatwootUsers||tmJson(c?.team_chatwoot_users,{});
  const onTeam=tmTeamEmails(c).includes(e);
  let status=meta?.status||'active';
  if(onTeam&&(status==='deactivated'||status==='removed'))status='active';
  if(!onTeam&&(status==='active'||status==='pending'))status='removed';
  const expired=status==='pending'&&meta?.expires_at&&new Date(meta.expires_at)<new Date();
  const p=perms[e]||{};
  return {email:e,name:names[e]||meta?.name||e.split('@')[0],status:expired?'expired':status,on_team:onTeam,
    role:p.role||null,modules:Array.isArray(p.modules)?p.modules:null,lead_categories:Array.isArray(p.leadCategories)?p.leadCategories:null,
    whatsapp:String(whatsapp[e]||''),chatwoot:!!chatwootUsers[e],
    invite_kind:meta?.invite_kind||null,invited_at:meta?.invited_at||null,invited_by:meta?.invited_by||null,expires_at:meta?.expires_at||null,
    last_login_at:meta?.last_login_at||null,deactivated_at:meta?.deactivated_at||null};
}
// Everyone User Management should list: the team plus anyone deactivated (they can be brought
// back). Removed people are not listed.
export function tmMembers(c,metaRows=[]){
  const byEmail=new Map((metaRows||[]).map(r=>[tmEmail(r.email),r]));
  const seen=new Set(),out=[];
  for(const e of tmTeamEmails(c)){if(seen.has(e)||tmIsOwner(c,e))continue;seen.add(e);out.push(tmMemberView(c,e,byEmail.get(e)||{}));}
  for(const r of metaRows||[]){const e=tmEmail(r.email);if(seen.has(e)||r.status!=='deactivated'||tmIsOwner(c,e))continue;seen.add(e);out.push(tmMemberView(c,e,r));}
  return out;
}

// Role / module / name edits, checked. Returns {next, error}.
export function tmApplyMemberUpdate(c,email,body={}){
  const e=tmEmail(email);
  const perms=tmJson(c?.team_permissions,{}),names=tmJson(c?.team_names,{});
  const cur={...(perms[e]||{})};
  if('role' in body){
    const role=body.role==null||body.role===''||body.role==='custom'?null:String(body.role);
    if(role&&!TM_ROLE_KEYS.includes(role))return {error:`Unknown role "${role}".`};
    if(role)cur.role=role;else delete cur.role;
  }
  if('modules' in body){
    if(body.modules===null)cur.modules=null;
    else{
      if(!Array.isArray(body.modules))return {error:'modules must be a list or null.'};
      const bad=body.modules.filter(m=>!TM_MODULE_KEYS.includes(m));
      if(bad.length)return {error:`Unknown module "${bad[0]}".`};
      const uniq=[...new Set(body.modules)];
      cur.modules=uniq.length>=TM_MODULE_KEYS.length?null:uniq;
    }
  }
  const fields={};
  if('role' in body||'modules' in body){perms[e]=cur;fields.team_permissions=JSON.stringify(perms);}
  if('name' in body){
    const n=String(body.name||'').replace(/\s+/g,' ').trim().slice(0,80);
    if(!n)return {error:'Name cannot be empty.'};
    names[e]=n;fields.team_names=JSON.stringify(names);
  }
  return {next:fields};
}

// Bulk invite from pasted CSV / lines: "name, email[, role]" or "email". Returns {rows, errors}.
export function tmParseBulk(text){
  const rows=[],errors=[],seen=new Set();
  String(text||'').split(/\r?\n/).map(l=>l.trim()).filter(Boolean).forEach((line,i)=>{
    const parts=line.split(/[,;\t]/).map(s=>s.trim().replace(/^"|"$/g,''));
    if(i===0&&/^(name|email)$/i.test(parts[0]||''))return; // header row
    const email=tmEmail(parts.find(p=>p.includes('@')));
    if(!email||!TM_EMAIL_RE.test(email)){errors.push({line:i+1,error:'No valid email on this line.'});return;}
    if(seen.has(email)){errors.push({line:i+1,error:`${email} is listed twice.`});return;}
    seen.add(email);
    const rest=parts.filter(p=>tmEmail(p)!==email);
    const roleRaw=rest.find(p=>TM_ROLE_KEYS.includes(p.toLowerCase().replace(/[\s-]+/g,'_')));
    const role=roleRaw?roleRaw.toLowerCase().replace(/[\s-]+/g,'_'):null;
    const name=rest.find(p=>p&&p!==roleRaw)||'';
    rows.push({line:i+1,name,email,role});
  });
  if(rows.length>TM_BULK_MAX)errors.push({line:0,error:`Up to ${TM_BULK_MAX} people per upload: only the first ${TM_BULK_MAX} are invited.`});
  return {rows:rows.slice(0,TM_BULK_MAX),errors};
}

// Readable line for the activity log.
export function tmAuditText(a){
  const d=tmJson(a?.details_json,{});
  const t=a?.target||'';
  return ({
    invited:`Invited ${t}${d.role?` as ${d.role}`:''}`,
    created_login:`Created a login for ${t}`,
    added_existing:`Added ${t} (existing login)`,
    resent:`Resent the invite to ${t}`,
    revoked:`Revoked ${t}'s invite`,
    deactivated:`Deactivated ${t}`,
    reactivated:`Reactivated ${t}`,
    removed:`Removed ${t}`,
    updated:`Updated ${t}${d.role!==undefined?`: role ${d.role||'custom'}`:''}${d.modules!==undefined?' (module access)':''}${d.name?`: name ${d.name}`:''}`,
    repaired:`Moved ${t} to this team (archived their empty account #${d.archived_client_id||'?'})`,
    ownership_transferred:`Transferred ownership to ${t}`,
    create_failed:`Creating ${t} failed and was rolled back${d.reason?`: ${d.reason}`:''}`,
  })[a?.action]||`${a?.action||'Change'} ${t}`;
}
