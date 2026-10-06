// ── CEO Bot ──────────────────────────────────────────────────────────────────────────────────────
// An add-on on top of the Projects module (worker.js "Projects module", migrations/0050…0058): an
// AI operations manager for STAFF TASKS that talks to the account owner and the team on its own,
// dedicated WhatsApp number. Ideas borrowed from the market:
//   - Daily brief / day wrap / weekly report (Asana AI status updates, MS Planner PM agent, Linear)
//   - Ask anything about the team's work, give instructions in plain words (ClickUp Brain, Rovo)
//   - Approval gates + autonomy levels before the bot changes anything (Asana AI Teammates)
//   - Async standups on chat (Geekbot, Standuply)
//   - Overdue nudges → escalation, update-by-reply buttons (Jira/Rovo risk alerts, Motion)
//   - Per-person scorecards + recognition (15Five, Lattice) — also shown in Reports → Team
//
// Isolation guarantees ("no change for existing"):
//   - Gated on ceoEnabled(c): CLIENTS.ceo_bot_enabled==='Yes', which only the super-admin can set
//     (it is in worker.js PLAN_MANAGED_FIELDS, so a client session can't grant it to itself).
//   - Only the account owner (CLIENTS.authentik_email) can open, configure or read its chats; every
//     /ceo/* route 403s for anyone else. Staff only ever see their own WhatsApp thread.
//   - Separate WhatsApp number with its own webhook (/ceo/wa/webhook/<hook_key>) — never Chatwoot,
//     never the lead-reply engine, never a lead or customer.
//   - All data in new ceo_bot_* tables (migrations/0110_ceo_bot.sql). The only existing table it
//     writes is pm_tasks (status/due date/assignee/new task) — the same columns the Projects page
//     writes — and each change is passed to deps.onTaskChanged so the existing reminder/automation
//     queue sees it exactly as if it had been made in the Projects page.
//   - This file imports nothing from worker.js; worker.js passes helpers in as `deps` (CEO_DEPS).
//
// deps shape: { json, requireSession, getClientById, reportOpsError,
//   parseTeamWhatsapp(c)→{email:digits}, normalizePhone(raw,c)→digits|'',
//   ai(env,c,systemText,userText,opts)→text|null, encrypt(env,plain)→str, decrypt(env,stored)→str|null,
//   verifySignature(secret,rawBody,sigHeader)→bool, metaAppSecret(env)→str,
//   onTaskChanged(env,cid,taskId,prevStatus), waSend(creds,body)→{ok,id?,error?},
//   waLookup(creds)→{ok,display_phone?,error?}, webhookBase(env)→str }

export function ceoEnabled(c){ return !!c && c.ceo_bot_enabled==='Yes'; }
export function ceoIsOwner(c, email){
  const e=String(email||'').trim().toLowerCase();
  return !!e && e===String(c?.authentik_email||'').trim().toLowerCase();
}

// ── Settings ─────────────────────────────────────────────────────────────────────────────────────
export const CEO_PLAYBOOKS=['brief','reminders','escalation','standup','wrap','weekly','recognition'];
export const CEO_AUTONOMY=['observe','suggest','auto_safe','full'];
export const CEO_DEFAULT_CONFIG={
  active:false,                 // owner's master switch
  paused:false,                 // emergency pause — stops every outbound message
  autonomy:'suggest',           // observe | suggest | auto_safe | full
  persona:{name:'CEO Bot', language:'English'},
  playbooks:{brief:true, reminders:true, escalation:true, standup:false, wrap:true, weekly:true, recognition:true},
  schedule:{brief:'09:00', standup:'10:00', wrap:'18:30', weekly_day:1, weekly_time:'09:30',
    work_days:[1,2,3,4,5,6], quiet_start:21, quiet_end:7, tz_offset_min:330},
  escalation:{staff_after_days:1, admin_after_days:2},
  staff_delay_needs_approval:true,
  project_scope:[],             // empty = every active project
  staff:{},                     // email → {phone, standup, muted}
  admin_phone:'',               // blank = owner's number from User Management
  template:{name:'', lang:'en'},// approved utility template with one {{1}} body variable
  monthly_ai_cap:300,
};
const TASK_STATUSES=['todo','in_progress','review','blocked','done'];
const TASK_PRIORITIES=['low','medium','high','urgent'];

function ceoClamp(v, min, max, dflt){
  if(v===null || v===undefined || v==='') return dflt;
  const n=Number(v);
  return Number.isFinite(n)?Math.min(max, Math.max(min, Math.round(n))):dflt;
}
function ceoHm(v, dflt){
  const m=String(v||'').match(/^(\d{1,2}):(\d{2})$/);
  if(!m || Number(m[1])>23 || Number(m[2])>59) return dflt;
  return `${m[1].padStart(2,'0')}:${m[2]}`;
}
export function ceoNormalizeConfig(raw){
  let src=raw;
  if(typeof raw==='string'){ try{ src=JSON.parse(raw||'{}'); }catch(e){ src={}; } }
  if(!src || typeof src!=='object') src={};
  const D=CEO_DEFAULT_CONFIG;
  const pb=src.playbooks&&typeof src.playbooks==='object'?src.playbooks:{};
  const playbooks={}; CEO_PLAYBOOKS.forEach(k=>{ playbooks[k]=pb[k]===undefined?D.playbooks[k]:!!pb[k]; });
  const s=src.schedule&&typeof src.schedule==='object'?src.schedule:{};
  const days=Array.isArray(s.work_days)?[...new Set(s.work_days.map(Number).filter(n=>Number.isInteger(n)&&n>=0&&n<=6))].sort():D.schedule.work_days;
  const esc=src.escalation&&typeof src.escalation==='object'?src.escalation:{};
  const staff={};
  if(src.staff && typeof src.staff==='object'){
    for(const [email, v] of Object.entries(src.staff)){
      const e=String(email).trim().toLowerCase(); if(!e || !v || typeof v!=='object') continue;
      staff[e]={phone:String(v.phone||'').replace(/[^\d+]/g,'').slice(0,20), standup:v.standup!==false, muted:!!v.muted};
    }
  }
  const persona=src.persona&&typeof src.persona==='object'?src.persona:{};
  const tpl=src.template&&typeof src.template==='object'?src.template:{};
  return {
    active:!!src.active,
    paused:!!src.paused,
    autonomy:CEO_AUTONOMY.includes(src.autonomy)?src.autonomy:D.autonomy,
    persona:{name:String(persona.name||D.persona.name).trim().slice(0,40)||D.persona.name,
      language:String(persona.language||D.persona.language).trim().slice(0,30)||D.persona.language},
    playbooks,
    schedule:{
      brief:ceoHm(s.brief, D.schedule.brief), standup:ceoHm(s.standup, D.schedule.standup), wrap:ceoHm(s.wrap, D.schedule.wrap),
      weekly_day:ceoClamp(s.weekly_day, 0, 6, D.schedule.weekly_day), weekly_time:ceoHm(s.weekly_time, D.schedule.weekly_time),
      work_days:days.length?days:D.schedule.work_days,
      quiet_start:ceoClamp(s.quiet_start, 0, 23, D.schedule.quiet_start), quiet_end:ceoClamp(s.quiet_end, 0, 23, D.schedule.quiet_end),
      tz_offset_min:ceoClamp(s.tz_offset_min, -720, 840, D.schedule.tz_offset_min),
    },
    escalation:{staff_after_days:ceoClamp(esc.staff_after_days, 0, 30, D.escalation.staff_after_days),
      admin_after_days:ceoClamp(esc.admin_after_days, 0, 60, D.escalation.admin_after_days)},
    staff_delay_needs_approval:src.staff_delay_needs_approval===undefined?D.staff_delay_needs_approval:!!src.staff_delay_needs_approval,
    project_scope:Array.isArray(src.project_scope)?[...new Set(src.project_scope.map(Number).filter(n=>Number.isInteger(n)&&n>0))]:[],
    staff,
    admin_phone:String(src.admin_phone||'').replace(/[^\d+]/g,'').slice(0,20),
    template:{name:String(tpl.name||'').trim().replace(/[^a-z0-9_]/gi,'').slice(0,100), lang:String(tpl.lang||'en').trim().slice(0,10)||'en'},
    monthly_ai_cap:ceoClamp(src.monthly_ai_cap, 0, 100000, D.monthly_ai_cap),
  };
}

async function ceoSettingsRow(env, cid){
  return env.DB.prepare(`SELECT * FROM ceo_bot_settings WHERE client_id=?`).bind(Number(cid)).first();
}

// ── Time helpers (client-local via a fixed UTC offset, same approach as Hospitality Pro) ─────────
const DAY_MS=86400000;
const WEEKDAYS=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
const MONTHS=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
export function ceoLocal(nowMs, tzOffsetMin){
  const d=new Date(nowMs+tzOffsetMin*60000);
  return {date:d.toISOString().slice(0,10), minutes:d.getUTCHours()*60+d.getUTCMinutes(), hour:d.getUTCHours(), dow:d.getUTCDay()};
}
function hmMinutes(hm){ const [h,m]=String(hm).split(':').map(Number); return h*60+m; }
export function ceoAddDays(iso, n){ return new Date(Date.parse(iso+'T00:00:00Z')+n*DAY_MS).toISOString().slice(0,10); }
export function ceoDaysBetween(a, b){ return Math.round((Date.parse(b+'T00:00:00Z')-Date.parse(a+'T00:00:00Z'))/DAY_MS); }
export function ceoIsQuiet(hour, cfg){
  const {quiet_start:s, quiet_end:e}=cfg.schedule;
  if(s===e) return false;
  return s<e ? (hour>=s && hour<e) : (hour>=s || hour<e);
}
function fmtDate(iso){
  if(!iso) return '';
  const d=new Date(iso+'T00:00:00Z');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()][0].toUpperCase()+MONTHS[d.getUTCMonth()].slice(1)}`;
}
// "tomorrow", "friday", "next monday", "in 3 days", "3 days", "2026-10-12", "12/10", "12 oct", "oct 12"
export function ceoParseDate(text, today){
  const t=String(text||'').toLowerCase().trim();
  if(!t) return null;
  let m=t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if(m) return `${m[1]}-${m[2]}-${m[3]}`;
  if(/\btoday\b/.test(t)) return today;
  if(/\b(tomorrow|tmrw|tmr)\b/.test(t)) return ceoAddDays(today, 1);
  m=t.match(/\b(?:in\s+)?(\d{1,2})\s*(day|days|d)\b/);
  if(m) return ceoAddDays(today, Number(m[1]));
  m=t.match(/\b(?:in\s+)?(\d{1,2})\s*(week|weeks|w)\b/);
  if(m) return ceoAddDays(today, Number(m[1])*7);
  const wd=WEEKDAYS.findIndex(w=>new RegExp(`\\b${w.slice(0,3)}(${w.slice(3)})?\\b`).test(t));
  if(wd>=0){
    const cur=new Date(today+'T00:00:00Z').getUTCDay();
    let add=(wd-cur+7)%7; if(add===0) add=7;
    return ceoAddDays(today, add);
  }
  const year=Number(today.slice(0,4));
  const pick=(d, mo)=>{
    if(!(mo>=1&&mo<=12&&d>=1&&d<=31)) return null;
    let iso=`${year}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    if(new Date(iso+'T00:00:00Z').getUTCDate()!==d) return null;
    if(iso<today) iso=`${year+1}${iso.slice(4)}`;
    return iso;
  };
  m=t.match(/\b(\d{1,2})[\/.](\d{1,2})\b/);
  if(m) return pick(Number(m[1]), Number(m[2]));
  m=t.match(/\b(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/);
  if(m) return pick(Number(m[1]), MONTHS.indexOf(m[2])+1);
  m=t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*(\d{1,2})\b/);
  if(m) return pick(Number(m[2]), MONTHS.indexOf(m[1])+1);
  return null;
}

// ── Team ─────────────────────────────────────────────────────────────────────────────────────────
// Everyone in Settings → User Management. Phone: CEO Bot override, else the number already saved in
// the user's profile (team_whatsapp — the same one hot-lead alerts use).
export function ceoTeam(c, cfg, deps){
  const owner=String(c?.authentik_email||'').trim().toLowerCase();
  const emails=[owner, ...String(c?.team_emails||'').split(',')].map(e=>e.trim().toLowerCase()).filter(Boolean);
  let names={}; try{ names=JSON.parse(c?.team_names||'{}')||{}; }catch(e){}
  const lowerNames={}; for(const [k,v] of Object.entries(names)) lowerNames[String(k).toLowerCase()]=v;
  const wa=deps.parseTeamWhatsapp(c)||{};
  const seen=new Set(), out=[];
  for(const email of emails){
    if(seen.has(email)) continue; seen.add(email);
    const o=cfg.staff[email]||{};
    const isAdmin=email===owner;
    const phone=(isAdmin&&cfg.admin_phone?deps.normalizePhone(cfg.admin_phone, c):'') || (o.phone?deps.normalizePhone(o.phone, c):'') || wa[email] || '';
    out.push({email, name:String(lowerNames[email]||email.split('@')[0]).trim(), isAdmin, phone, standup:o.standup!==false, muted:!!o.muted});
  }
  return out;
}
function firstName(n){ return String(n||'').trim().split(/\s+/)[0]||'there'; }
function phoneMatch(a, b){
  const x=String(a||'').replace(/\D/g,''), y=String(b||'').replace(/\D/g,'');
  if(!x || !y) return false;
  return x===y || (x.length>=10 && y.length>=10 && x.slice(-10)===y.slice(-10));
}

// ── Context for one client ───────────────────────────────────────────────────────────────────────
export async function ceoBuildContext(env, deps, c, row, nowMs=Date.now()){
  const cfg=ceoNormalizeConfig(row?.config_json||'{}');
  const team=ceoTeam(c, cfg, deps);
  const admin=team.find(m=>m.isAdmin)||{email:String(c?.authentik_email||'').toLowerCase(), name:'Owner', phone:'', isAdmin:true};
  let token='';
  if(row?.wa_token_enc){ try{ token=await deps.decrypt(env, row.wa_token_enc)||''; }catch(e){ token=''; } }
  return {c, cid:Number(c.Id||row?.client_id), row, cfg, team, admin, nowMs, local:ceoLocal(nowMs, cfg.schedule.tz_offset_min),
    creds:{wa_phone_id:row?.wa_phone_id||'', wa_token:token}};
}

// ── Task data ────────────────────────────────────────────────────────────────────────────────────
export async function ceoLoadTasks(env, ctx){
  const {results}=await env.DB.prepare(`SELECT t.id, t.project_id, t.title, t.status, t.priority, t.assignee_email, t.due_date,
      t.done_at, t.created_at, t.updated_at, p.name AS project_name, p.status AS project_status
    FROM pm_tasks t LEFT JOIN pm_projects p ON p.id=t.project_id AND p.client_id=t.client_id
    WHERE t.client_id=?`).bind(ctx.cid).all();
  const scope=ctx.cfg.project_scope;
  return (results||[]).filter(t=>t.project_status!=='archived' && (!scope.length || scope.includes(Number(t.project_id))))
    .map(t=>({...t, assignee_email:String(t.assignee_email||'').toLowerCase()}));
}
function isOpen(t){ return t.status!=='done'; }
function daysLate(t, today){ return t.due_date && isOpen(t) && t.due_date<today ? ceoDaysBetween(t.due_date, today) : 0; }
function memberName(ctx, email){ return ctx.team.find(m=>m.email===email)?.name || (email?email.split('@')[0]:'Unassigned'); }
function taskLine(ctx, t, today, {who=true}={}){
  const late=daysLate(t, today);
  const when=late?`${late}d late`:t.due_date===today?'due today':t.due_date?`due ${fmtDate(t.due_date)}`:'';
  return `• #${t.id} ${String(t.title).slice(0,60)}${who?` — ${memberName(ctx, t.assignee_email)}`:''}${when?`, ${when}`:''}`;
}

// ── WhatsApp sending (dedicated number; 24-hour window aware) ────────────────────────────────────
const WINDOW_MS=23.5*3600000;
async function ceoContact(env, cid, phone){
  return env.DB.prepare(`SELECT * FROM ceo_bot_contacts WHERE client_id=? AND phone=?`).bind(cid, phone).first();
}
function ctxJson(row){ try{ return JSON.parse(row?.context_json||'{}')||{}; }catch(e){ return {}; } }
async function ceoSetContext(env, cid, phone, patch){
  const cur=ctxJson(await ceoContact(env, cid, phone));
  const next={...cur, ...patch};
  await env.DB.prepare(`INSERT INTO ceo_bot_contacts (client_id, phone, context_json) VALUES (?,?,?)
    ON CONFLICT(client_id, phone) DO UPDATE SET context_json=excluded.context_json`).bind(cid, phone, JSON.stringify(next)).run();
  return next;
}
async function ceoLog(env, cid, m){
  await env.DB.prepare(`INSERT INTO ceo_bot_messages (client_id, phone, party_email, party_role, direction, kind, body, task_id, status, detail, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(cid, m.phone||'', m.email||'', m.role||'', m.direction||'out', m.kind||'', String(m.body||'').slice(0,4000),
      m.taskId?Number(m.taskId):null, m.status||'', String(m.detail||'').slice(0,300), m.at||new Date().toISOString()).run();
}
export function ceoTemplateParam(text){
  return String(text||'').replace(/\s*\n+\s*/g,' · ').replace(/\t/g,' ').replace(/ {4,}/g,'   ').trim().slice(0,1000);
}
export async function ceoSend(env, deps, ctx, {phone, email='', role='', kind, text, buttons=null, taskId=null}){
  const base={phone:phone||'', email, role, direction:'out', kind, body:text, taskId, at:new Date(ctx.nowMs).toISOString()};
  if(!phone){ await ceoLog(env, ctx.cid, {...base, status:'skipped', detail:'No WhatsApp number (Projects → CEO Bot → Team)'}); return {ok:false, skipped:'no-phone'}; }
  if(!ctx.creds.wa_phone_id || !ctx.creds.wa_token){ await ceoLog(env, ctx.cid, {...base, status:'skipped', detail:'CEO WhatsApp number not connected'}); return {ok:false, skipped:'no-channel'}; }
  const contact=await ceoContact(env, ctx.cid, phone);
  const last=Date.parse(contact?.last_inbound_at||'');
  const inWindow=Number.isFinite(last) && ctx.nowMs-last<WINDOW_MS;
  let body;
  if(inWindow){
    body=buttons&&buttons.length
      ? {type:'interactive', interactive:{type:'button', body:{text:String(text).slice(0,1024)},
          action:{buttons:buttons.slice(0,3).map(b=>({type:'reply', reply:{id:String(b.id).slice(0,256), title:String(b.title).slice(0,20)}}))}}}
      : {type:'text', text:{body:String(text).slice(0,4096), preview_url:false}};
  }else if(ctx.cfg.template.name){
    body={type:'template', template:{name:ctx.cfg.template.name, language:{code:ctx.cfg.template.lang},
      components:[{type:'body', parameters:[{type:'text', text:ceoTemplateParam(text)}]}]}};
  }else{
    await ceoLog(env, ctx.cid, {...base, status:'skipped', detail:'Outside WhatsApp 24h window and no template set'});
    return {ok:false, skipped:'window'};
  }
  let res;
  try{ res=await deps.waSend(ctx.creds, {messaging_product:'whatsapp', recipient_type:'individual', to:phone, ...body}); }
  catch(e){ res={ok:false, error:String(e?.message||e)}; }
  await ceoLog(env, ctx.cid, {...base, status:res?.ok?'sent':'failed', detail:res?.ok?(inWindow?'':'template'):(res?.error||'send failed')});
  return res?.ok?{ok:true}:{ok:false, error:res?.error};
}
const sendAdmin=(env, deps, ctx, kind, text, extra={})=>ceoSend(env, deps, ctx, {phone:ctx.admin.phone, email:ctx.admin.email, role:'admin', kind, text, ...extra});

async function ceoClaim(env, cid, kind, key, nowIso){
  const r=await env.DB.prepare(`INSERT OR IGNORE INTO ceo_bot_runs (client_id, kind, run_key, created_at) VALUES (?,?,?,?)`).bind(cid, kind, String(key), nowIso).run();
  return Number(r?.meta?.changes||0)===1;
}
// Lets the existing Projects reminder/automation queue see a bot-made change exactly like a
// Projects-page edit. Never throws — a queue hiccup must not lose the reply to staff.
async function taskChanged(env, deps, cid, taskId, prevStatus){
  try{ await deps.onTaskChanged(env, cid, taskId, prevStatus); }
  catch(e){ await deps.reportOpsError(env, 'ceoBotTaskChanged', e, {clientId:cid, taskId}).catch(()=>{}); }
}
async function ceoEvent(env, cid, taskId, email, event, detail, nowIso){
  await env.DB.prepare(`INSERT INTO ceo_bot_task_events (client_id, task_id, member_email, event, detail, created_at) VALUES (?,?,?,?,?,?)`)
    .bind(cid, taskId?Number(taskId):null, email||'', event, String(detail||'').slice(0,300), nowIso).run();
}

// ── Message builders (deterministic — no AI needed, so they're cheap and never hallucinate) ──────
export function ceoBriefText(ctx, tasks){
  const today=ctx.local.date, yesterday=ceoAddDays(today, -1);
  const open=tasks.filter(isOpen);
  const overdue=open.filter(t=>daysLate(t, today)>0).sort((a,b)=>daysLate(b, today)-daysLate(a, today));
  const dueToday=open.filter(t=>t.due_date===today);
  const blocked=open.filter(t=>t.status==='blocked');
  const doneY=tasks.filter(t=>t.status==='done' && String(t.done_at||'').slice(0,10)===yesterday);
  const lines=[`☀️ Good morning, ${firstName(ctx.admin.name)}! — ${WEEKDAYS[ctx.local.dow][0].toUpperCase()+WEEKDAYS[ctx.local.dow].slice(1)}, ${fmtDate(today)}`,
    `📋 Open: ${open.length} · Due today: ${dueToday.length} · Overdue: ${overdue.length} · Blocked: ${blocked.length}`,
    `✅ Done yesterday: ${doneY.length}`];
  if(overdue.length) lines.push('', '🔴 *Overdue*', ...overdue.slice(0,5).map(t=>taskLine(ctx, t, today)), ...(overdue.length>5?[`  …and ${overdue.length-5} more`]:[]));
  if(dueToday.length) lines.push('', '🟠 *Due today*', ...dueToday.slice(0,5).map(t=>taskLine(ctx, t, today)));
  if(blocked.length) lines.push('', '🚧 *Blocked*', ...blocked.slice(0,5).map(t=>taskLine(ctx, t, today)));
  const load=ctx.team.filter(m=>!m.isAdmin).map(m=>({m, open:open.filter(t=>t.assignee_email===m.email).length,
    late:overdue.filter(t=>t.assignee_email===m.email).length})).sort((a,b)=>b.open-a.open);
  if(load.length){
    lines.push('', '👥 *Workload*', ...load.map(x=>`• ${x.m.name} — ${x.open} open${x.late?` (${x.late} overdue)`:''}`));
    const avg=load.reduce((s,x)=>s+x.open, 0)/load.length;
    const heavy=load.filter(x=>x.open>=5 && x.open>=avg*1.75), idle=load.filter(x=>x.open===0);
    if(heavy.length && idle.length) lines.push(`⚖️ Tip: ${heavy[0].m.name} is overloaded while ${idle.map(x=>x.m.name).join(', ')} ${idle.length>1?'have':'has'} nothing open — reassign?`);
  }
  const unassigned=open.filter(t=>!t.assignee_email).length;
  if(unassigned) lines.push(`❔ ${unassigned} open task${unassigned>1?'s have':' has'} no owner.`);
  lines.push('', 'Ask me anything or give an instruction, e.g. "move #12 to Friday".');
  return lines.join('\n');
}
export function ceoStaffDailyText(ctx, member, tasks){
  const today=ctx.local.date, tomorrow=ceoAddDays(today, 1);
  const mine=tasks.filter(t=>isOpen(t) && t.assignee_email===member.email && t.due_date && t.due_date<=tomorrow)
    .sort((a,b)=>String(a.due_date).localeCompare(String(b.due_date)));
  if(!mine.length) return null;
  const icon=t=>daysLate(t, today)?'🔴':t.due_date===today?'🟠':'🟡';
  return [`Good morning ${firstName(member.name)} 👋 Your tasks:`,
    ...mine.slice(0,8).map(t=>`${icon(t)} #${t.id} ${String(t.title).slice(0,60)} — ${daysLate(t, today)?`${daysLate(t, today)}d late`:t.due_date===today?'due today':'due tomorrow'}`),
    '', 'Reply: DONE 12 · BLOCKED 12 <reason> · DELAY 12 friday'].join('\n');
}
export function ceoWrapText(ctx, tasks, standups, events){
  const today=ctx.local.date;
  const doneToday=tasks.filter(t=>t.status==='done' && String(t.done_at||'').slice(0,10)===today);
  const overdue=tasks.filter(t=>daysLate(t, today)>0);
  const blockers=events.filter(e=>e.event==='blocked');
  const delays=events.filter(e=>e.event==='delay');
  const asked=standups.length, answered=standups.filter(s=>s.answered_at).length;
  const lines=[`🌙 Day wrap — ${fmtDate(today)}`, `✅ Completed today: ${doneToday.length}`];
  lines.push(...doneToday.slice(0,6).map(t=>taskLine(ctx, t, today)));
  lines.push(`🔴 Still overdue: ${overdue.length}`);
  if(blockers.length) lines.push('🚧 Blockers reported:', ...blockers.slice(0,5).map(e=>`• #${e.task_id} — ${memberName(ctx, e.member_email)}: ${e.detail||'no reason given'}`));
  if(delays.length) lines.push(`⏳ Delays requested: ${delays.length}`);
  if(asked) lines.push(`🗣️ Standups: ${answered}/${asked} answered${answered<asked?` (missing: ${standups.filter(s=>!s.answered_at).map(s=>memberName(ctx, s.member_email)).join(', ')})`:''}`);
  return lines.join('\n');
}

// Per-member scorecard — used by the weekly report AND Reports → Team (GET /ceo/team-report).
// score = 40% on-time rate + 40% completion (done vs done+overdue now) + 20% standup answer rate
// (weights re-spread over whatever parts have data; null when there's nothing to score yet).
export async function ceoScorecard(env, ctx, days, tasksIn=null){
  const tasks=tasksIn||await ceoLoadTasks(env, ctx);
  const today=ctx.local.date, from=ceoAddDays(today, -(days-1));
  const sinceIso=new Date(Date.parse(from+'T00:00:00Z')-ctx.cfg.schedule.tz_offset_min*60000).toISOString();
  const [time, stand, ev]=await Promise.all([
    env.DB.prepare(`SELECT user_email, SUM(hours) AS hours FROM pm_time_entries WHERE client_id=? AND entry_date>=? GROUP BY user_email`).bind(ctx.cid, from).all().catch(()=>({results:[]})),
    env.DB.prepare(`SELECT member_email, COUNT(*) AS asked, SUM(CASE WHEN answered_at<>'' THEN 1 ELSE 0 END) AS answered FROM ceo_bot_standups WHERE client_id=? AND standup_date>=? GROUP BY member_email`).bind(ctx.cid, from).all(),
    env.DB.prepare(`SELECT member_email, event, COUNT(*) AS n FROM ceo_bot_task_events WHERE client_id=? AND created_at>=? GROUP BY member_email, event`).bind(ctx.cid, sinceIso).all(),
  ]);
  const hoursBy={}; for(const r of time.results||[]) hoursBy[String(r.user_email||'').toLowerCase()]=Number(r.hours)||0;
  const standBy={}; for(const r of stand.results||[]) standBy[String(r.member_email).toLowerCase()]={asked:Number(r.asked)||0, answered:Number(r.answered)||0};
  const evBy={}; for(const r of ev.results||[]){ const e=String(r.member_email).toLowerCase(); (evBy[e]=evBy[e]||{})[r.event]=Number(r.n)||0; }
  const localDone=t=>{ const ms=Date.parse(t.done_at||''); return Number.isFinite(ms)?ceoLocal(ms, ctx.cfg.schedule.tz_offset_min).date:''; };
  const members=ctx.team.map(m=>{
    const mine=tasks.filter(t=>t.assignee_email===m.email);
    const done=mine.filter(t=>t.status==='done' && localDone(t)>=from);
    const withDue=done.filter(t=>t.due_date);
    const onTime=withDue.filter(t=>localDone(t)<=t.due_date).length;
    const open=mine.filter(isOpen), overdue=open.filter(t=>daysLate(t, today)>0);
    const st=standBy[m.email]||{asked:0, answered:0};
    const e=evBy[m.email]||{};
    const parts=[];
    if(withDue.length) parts.push([0.4, onTime/withDue.length]);
    if(done.length+overdue.length) parts.push([0.4, done.length/(done.length+overdue.length)]);
    if(st.asked) parts.push([0.2, st.answered/st.asked]);
    const w=parts.reduce((s,p)=>s+p[0], 0);
    return {email:m.email, name:m.name, is_admin:m.isAdmin, has_whatsapp:!!m.phone,
      open:open.length, overdue:overdue.length, blocked:open.filter(t=>t.status==='blocked').length,
      done:done.length, on_time_pct:withDue.length?Math.round(onTime/withDue.length*100):null,
      hours:Math.round((hoursBy[m.email]||0)*10)/10,
      standups_asked:st.asked, standups_answered:st.answered,
      bot_updates:(e.done||0)+(e.blocked||0)+(e.delay||0)+(e.progress||0), nudges:(e.reminded||0)+(e.escalated||0),
      score:w?Math.round(parts.reduce((s,p)=>s+p[0]*p[1], 0)/w*100):null};
  }).sort((a,b)=>(b.score??-1)-(a.score??-1) || b.done-a.done);
  const created=tasks.filter(t=>String(t.created_at||'')>=sinceIso).length;
  const totals={done:members.reduce((s,m)=>s+m.done, 0), overdue:tasks.filter(t=>daysLate(t, today)>0).length,
    blocked:tasks.filter(t=>isOpen(t)&&t.status==='blocked').length, open:tasks.filter(isOpen).length, created,
    hours:Math.round(members.reduce((s,m)=>s+m.hours, 0)*10)/10};
  const allWithDue=members.reduce((s,m)=>s+(m.on_time_pct===null?0:1), 0);
  totals.on_time_pct=allWithDue?Math.round(members.filter(m=>m.on_time_pct!==null).reduce((s,m)=>s+m.on_time_pct, 0)/allWithDue):null;
  return {days, from, to:today, members, totals};
}
export function ceoWeeklyText(ctx, sc){
  const lines=[`📊 *Weekly CEO report* — ${fmtDate(sc.from)} to ${fmtDate(sc.to)}`,
    `✅ Completed: ${sc.totals.done}${sc.totals.on_time_pct!==null?` (on time ${sc.totals.on_time_pct}%)`:''} · ➕ Created: ${sc.totals.created}`,
    `🔴 Overdue now: ${sc.totals.overdue} · 🚧 Blocked: ${sc.totals.blocked} · 📋 Open: ${sc.totals.open}`];
  if(sc.totals.hours) lines.push(`⏱️ Hours logged: ${sc.totals.hours}`);
  const staff=sc.members.filter(m=>!m.is_admin || m.done || m.open);
  const top=[...staff].sort((a,b)=>b.done-a.done)[0];
  if(top && top.done) lines.push(`🏆 Top performer: ${top.name} (${top.done} done)`);
  if(staff.length){
    lines.push('', '👥 *Team scorecard*');
    for(const m of staff) lines.push(`• ${m.name} — ${m.score===null?'—':m.score+'/100'} · ${m.done} done${m.on_time_pct!==null?` · ${m.on_time_pct}% on time`:''}${m.overdue?` · ${m.overdue} overdue`:''}${m.standups_asked?` · standups ${m.standups_answered}/${m.standups_asked}`:''}`);
  }
  return lines.join('\n');
}

// ── Scheduled runs (cron, every 15 min) ──────────────────────────────────────────────────────────
export async function ceoRunForAllClients(env, deps, nowMs=Date.now()){
  if(!env.DB) return;
  let rows=[];
  try{ rows=(await env.DB.prepare(`SELECT client_id FROM ceo_bot_settings WHERE wa_phone_id<>'' AND wa_token_enc<>''`).all())?.results||[]; }
  catch(e){ return; } // migration not applied yet
  for(const r of rows){
    try{ await ceoRunForClient(env, deps, r.client_id, nowMs); }
    catch(e){ await deps.reportOpsError(env, 'ceoBotCron', e, {clientId:r.client_id}).catch(()=>{}); }
  }
}
export async function ceoRunForClient(env, deps, cid, nowMs=Date.now()){
  const c=await deps.getClientById(env, cid);
  if(!ceoEnabled(c)) return {skipped:'disabled'};
  const row=await ceoSettingsRow(env, cid);
  const ctx=await ceoBuildContext(env, deps, c, row, nowMs);
  if(!ctx.cfg.active || ctx.cfg.paused) return {skipped:'inactive'};
  if(ceoIsQuiet(ctx.local.hour, ctx.cfg)) return {skipped:'quiet'};
  const {cfg, local}=ctx, pb=cfg.playbooks, nowIso=new Date(nowMs).toISOString(), today=local.date;
  const due=hm=>local.minutes>=hmMinutes(hm) && local.minutes<hmMinutes(hm)+180;
  const workday=cfg.schedule.work_days.includes(local.dow);
  const tasks=await ceoLoadTasks(env, ctx);
  const sent=[];
  const staff=ctx.team.filter(m=>!m.isAdmin && !m.muted);

  if(workday){
    if(pb.brief && due(cfg.schedule.brief) && await ceoClaim(env, cid, 'brief', today, nowIso)){
      await sendAdmin(env, deps, ctx, 'brief', ceoBriefText(ctx, tasks)); sent.push('brief');
    }
    if(pb.reminders && due(cfg.schedule.brief)){
      for(const m of staff){
        const text=ceoStaffDailyText(ctx, m, tasks);
        if(!text || !await ceoClaim(env, cid, 'staff_daily', `${today}:${m.email}`, nowIso)) continue;
        const r=await ceoSend(env, deps, ctx, {phone:m.phone, email:m.email, role:'staff', kind:'reminder', text});
        if(r.ok) await ceoEvent(env, cid, null, m.email, 'reminded', 'daily list', nowIso);
        sent.push('reminder:'+m.email);
      }
    }
    if(pb.standup && due(cfg.schedule.standup)){
      for(const m of staff.filter(s=>s.standup && s.phone)){
        if(!await ceoClaim(env, cid, 'standup', `${today}:${m.email}`, nowIso)) continue;
        await env.DB.prepare(`INSERT OR IGNORE INTO ceo_bot_standups (client_id, member_email, standup_date, asked_at) VALUES (?,?,?,?)`).bind(cid, m.email, today, nowIso).run();
        const r=await ceoSend(env, deps, ctx, {phone:m.phone, email:m.email, role:'staff', kind:'standup',
          text:`Hi ${firstName(m.name)} 👋 Quick standup:\n1️⃣ What did you finish yesterday?\n2️⃣ What are you doing today?\n3️⃣ Any blockers?\nReply in one message.`});
        if(r.ok) await ceoSetContext(env, cid, m.phone, {standup_date:today});
        sent.push('standup:'+m.email);
      }
    }
    // Escalations start an hour after the brief, so the staff daily list always goes first.
    if(pb.escalation && local.minutes>=hmMinutes(cfg.schedule.brief)+60){
      const late=tasks.filter(t=>daysLate(t, today)>0).sort((a,b)=>daysLate(b, today)-daysLate(a, today));
      for(const m of staff){
        const mine=late.filter(t=>t.assignee_email===m.email && daysLate(t, today)>=Math.max(1, cfg.escalation.staff_after_days));
        if(!mine.length || !await ceoClaim(env, cid, 'esc_staff', `${today}:${m.email}`, nowIso)) continue;
        const t=mine[0];
        const text=[`⏰ ${firstName(m.name)}, ${mine.length>1?`${mine.length} of your tasks are`:'a task is'} overdue:`,
          ...mine.slice(0,5).map(x=>taskLine(ctx, x, today, {who:false})), '', `Update #${t.id}?`].join('\n');
        const r=await ceoSend(env, deps, ctx, {phone:m.phone, email:m.email, role:'staff', kind:'escalation', text, taskId:t.id,
          buttons:[{id:`ceo:done:${t.id}`, title:'✅ Done'}, {id:`ceo:delay:${t.id}`, title:'⏳ Need more time'}, {id:`ceo:blocked:${t.id}`, title:'🚧 Blocked'}]});
        if(r.ok) for(const x of mine) await ceoEvent(env, cid, x.id, m.email, 'escalated', 'staff', nowIso);
        sent.push('esc_staff:'+m.email);
      }
      const toAdmin=[];
      for(const t of late.filter(x=>daysLate(x, today)>=Math.max(1, cfg.escalation.admin_after_days))){
        if(await ceoClaim(env, cid, 'esc_admin', `${t.id}:${t.due_date}`, nowIso)) toAdmin.push(t);
      }
      if(toAdmin.length){
        await sendAdmin(env, deps, ctx, 'escalation', ['🚨 *Overdue escalation*', ...toAdmin.slice(0,10).map(t=>taskLine(ctx, t, today)),
          ...(toAdmin.length>10?[`…and ${toAdmin.length-10} more`]:[]), '', 'Reply e.g. "move #12 to Monday" or "assign #12 to Priya".'].join('\n'));
        sent.push('esc_admin');
      }
    }
    if(pb.wrap && due(cfg.schedule.wrap) && await ceoClaim(env, cid, 'wrap', today, nowIso)){
      const standups=(await env.DB.prepare(`SELECT * FROM ceo_bot_standups WHERE client_id=? AND standup_date=?`).bind(cid, today).all()).results||[];
      const startIso=new Date(Date.parse(today+'T00:00:00Z')-cfg.schedule.tz_offset_min*60000).toISOString();
      const events=(await env.DB.prepare(`SELECT * FROM ceo_bot_task_events WHERE client_id=? AND created_at>=? ORDER BY id`).bind(cid, startIso).all()).results||[];
      await sendAdmin(env, deps, ctx, 'wrap', ceoWrapText(ctx, tasks, standups, events)); sent.push('wrap');
    }
  }
  if(local.dow===cfg.schedule.weekly_day && due(cfg.schedule.weekly_time) && (pb.weekly || pb.recognition) && await ceoClaim(env, cid, 'weekly', today, nowIso)){
    const sc=await ceoScorecard(env, ctx, 7, tasks);
    if(pb.weekly){ await sendAdmin(env, deps, ctx, 'weekly', ceoWeeklyText(ctx, sc)); sent.push('weekly'); }
    if(pb.recognition){
      for(const m of sc.members.filter(x=>!x.is_admin && x.done>=3 && !x.overdue)){
        const mem=staff.find(s=>s.email===m.email); if(!mem) continue;
        await ceoSend(env, deps, ctx, {phone:mem.phone, email:mem.email, role:'staff', kind:'recognition',
          text:`👏 Great week, ${firstName(mem.name)}! You closed ${m.done} tasks${m.on_time_pct===100?', all on time':''}. Keep it up! 🚀`});
        sent.push('recognition:'+m.email);
      }
    }
  }
  return {sent};
}

// ── AI (owner questions/instructions + fallback parsing of staff replies) ───────────────────────
async function ceoAiAllowed(env, ctx){
  const month=new Date(ctx.nowMs).toISOString().slice(0,7);
  const r=await env.DB.prepare(`SELECT ai_calls FROM ceo_bot_usage WHERE client_id=? AND month=?`).bind(ctx.cid, month).first();
  if((Number(r?.ai_calls)||0)>=ctx.cfg.monthly_ai_cap) return false;
  await env.DB.prepare(`INSERT INTO ceo_bot_usage (client_id, month, ai_calls) VALUES (?,?,1) ON CONFLICT(client_id, month) DO UPDATE SET ai_calls=ai_calls+1`).bind(ctx.cid, month).run();
  return true;
}
export function ceoExtractJson(text){
  const s=String(text||''); const a=s.indexOf('{'), b=s.lastIndexOf('}');
  if(a<0 || b<=a) return null;
  try{ return JSON.parse(s.slice(a, b+1)); }catch(e){ return null; }
}
async function ceoAdminAi(env, deps, ctx, text, tasks){
  if(!await ceoAiAllowed(env, ctx)) return {reply:'⚠️ Monthly AI limit for CEO Bot is reached. Raise it in Projects → CEO Bot → Settings.', actions:[]};
  const today=ctx.local.date, recentDone=ceoAddDays(today, -14);
  const {results:projects}=await env.DB.prepare(`SELECT id, name FROM pm_projects WHERE client_id=? AND status<>'archived' ORDER BY id`).bind(ctx.cid).all();
  const data={today, team:ctx.team.map(m=>({email:m.email, name:m.name, owner:m.isAdmin})),
    projects:(projects||[]).filter(p=>!ctx.cfg.project_scope.length || ctx.cfg.project_scope.includes(Number(p.id))),
    tasks:tasks.filter(t=>isOpen(t) || String(t.done_at||'').slice(0,10)>=recentDone).slice(0,250)
      .map(t=>({id:t.id, title:String(t.title).slice(0,80), project_id:t.project_id, status:t.status, priority:t.priority,
        assignee:t.assignee_email||null, due:t.due_date||null, done_at:t.done_at?String(t.done_at).slice(0,10):null}))};
  const recent=((await env.DB.prepare(`SELECT direction, body FROM ceo_bot_messages WHERE client_id=? AND party_role='admin' AND kind IN ('chat','reply') ORDER BY id DESC LIMIT 6`).bind(ctx.cid).all()).results||[]).reverse();
  const system=`You are ${ctx.cfg.persona.name}, the AI chief of staff for ${ctx.c.client_name||'this business'}. You manage the team's INTERNAL project tasks only — never customers, leads or sales chats. `
    +`Answer the owner using ONLY the JSON data given; never invent tasks, people or numbers. Reply in ${ctx.cfg.persona.language}, WhatsApp style: short lines, *bold* allowed, under 900 characters. `
    +`If the owner asks to change something, add actions. Output ONLY JSON: {"reply":"...","actions":[...]}. Action shapes: `
    +`{"type":"update_task","task_id":1,"status":"todo|in_progress|review|blocked|done","due_date":"YYYY-MM-DD","priority":"low|medium|high|urgent","assignee_email":"..."} (only the fields that change); `
    +`{"type":"create_task","title":"...","project_id":1,"assignee_email":"...","due_date":"YYYY-MM-DD","priority":"medium"}; `
    +`{"type":"message_staff","email":"...","text":"..."}. Use only ids and emails that appear in the data. Resolve relative dates against "today".`;
  const user=`DATA:\n${JSON.stringify(data)}\n\nRECENT CHAT:\n${recent.map(r=>`${r.direction==='in'?'Owner':'You'}: ${String(r.body).slice(0,300)}`).join('\n')}\n\nOwner: ${text}`;
  const out=await deps.ai(env, ctx.c, system, user, {maxOutputTokens:700, temperature:0.2});
  if(!out) return {reply:'Sorry, I could not reach the AI right now. Try again in a minute.', actions:[]};
  const j=ceoExtractJson(out);
  if(!j || typeof j.reply!=='string') return {reply:String(out).slice(0,1500), actions:[]};
  return {reply:j.reply.slice(0,1500), actions:Array.isArray(j.actions)?j.actions.slice(0,8):[]};
}

// ── Actions: validate → (approve) → execute ──────────────────────────────────────────────────────
function isIsoDate(s){ return /^\d{4}-\d{2}-\d{2}$/.test(String(s||'')) && Number.isFinite(Date.parse(s+'T00:00:00Z')); }
export async function ceoValidateAction(env, ctx, a){
  if(!a || typeof a!=='object') return {error:'Invalid action'};
  const team=new Set(ctx.team.map(m=>m.email));
  if(a.type==='update_task'){
    const t=await env.DB.prepare(`SELECT id, title, status, due_date, assignee_email, priority FROM pm_tasks WHERE id=? AND client_id=?`).bind(Number(a.task_id)||0, ctx.cid).first();
    if(!t) return {error:`Task #${a.task_id} not found`};
    const ch={};
    if(a.status!==undefined && a.status!==null){ if(!TASK_STATUSES.includes(a.status)) return {error:'Invalid status'}; if(a.status!==t.status) ch.status=a.status; }
    if(a.due_date){ if(!isIsoDate(a.due_date)) return {error:'Invalid due date'}; if(a.due_date!==t.due_date) ch.due_date=a.due_date; }
    if(a.priority){ if(!TASK_PRIORITIES.includes(a.priority)) return {error:'Invalid priority'}; if(a.priority!==t.priority) ch.priority=a.priority; }
    if(a.assignee_email){ const e=String(a.assignee_email).toLowerCase(); if(!team.has(e)) return {error:`${a.assignee_email} is not on the team`}; if(e!==String(t.assignee_email||'').toLowerCase()) ch.assignee_email=e; }
    if(!Object.keys(ch).length) return {error:`Nothing to change on #${t.id}`};
    const bits=Object.entries(ch).map(([k,v])=>k==='assignee_email'?`assign → ${memberName(ctx, v)}`:k==='due_date'?`due → ${fmtDate(v)}`:`${k} → ${v}`);
    return {action:{type:'update_task', task_id:t.id, changes:ch}, summary:`#${t.id} ${String(t.title).slice(0,50)}: ${bits.join(', ')}`,
      safe:!ch.assignee_email};
  }
  if(a.type==='create_task'){
    const title=String(a.title||'').trim().slice(0,300);
    if(!title) return {error:'Task title missing'};
    let projectId=Number(a.project_id)||0;
    if(projectId && !await env.DB.prepare(`SELECT id FROM pm_projects WHERE id=? AND client_id=?`).bind(projectId, ctx.cid).first()) projectId=0;
    const e=a.assignee_email?String(a.assignee_email).toLowerCase():'';
    if(e && !team.has(e)) return {error:`${a.assignee_email} is not on the team`};
    const due=isIsoDate(a.due_date)?a.due_date:'';
    const priority=TASK_PRIORITIES.includes(a.priority)?a.priority:'medium';
    return {action:{type:'create_task', title, project_id:projectId, assignee_email:e, due_date:due, priority},
      summary:`New task "${title.slice(0,60)}"${e?` for ${memberName(ctx, e)}`:''}${due?`, due ${fmtDate(due)}`:''}`, safe:false};
  }
  if(a.type==='message_staff'){
    const e=String(a.email||'').toLowerCase(); const text=String(a.text||'').trim().slice(0,1000);
    if(!team.has(e)) return {error:`${a.email} is not on the team`};
    if(!text) return {error:'Message is empty'};
    return {action:{type:'message_staff', email:e, text}, summary:`Message ${memberName(ctx, e)}: "${text.slice(0,80)}"`, safe:true};
  }
  return {error:'Unknown action'};
}
export async function ceoExecuteAction(env, deps, ctx, action){
  const nowIso=new Date(ctx.nowMs).toISOString();
  if(action.type==='update_task'){
    const before=await env.DB.prepare(`SELECT * FROM pm_tasks WHERE id=? AND client_id=?`).bind(action.task_id, ctx.cid).first();
    if(!before) return {ok:false, result:'Task no longer exists'};
    const ch=action.changes||{}, sets=[], vals=[];
    for(const k of ['status','due_date','priority','assignee_email']) if(ch[k]!==undefined){ sets.push(`${k}=?`); vals.push(ch[k]); }
    if(ch.status!==undefined && ch.status!==before.status){ sets.push('done_at=?'); vals.push(ch.status==='done'?nowIso:null); }
    if(!sets.length) return {ok:false, result:'Nothing to change'};
    sets.push('updated_at=?'); vals.push(nowIso);
    await env.DB.prepare(`UPDATE pm_tasks SET ${sets.join(', ')} WHERE id=? AND client_id=?`).bind(...vals, action.task_id, ctx.cid).run();
    await taskChanged(env, deps, ctx.cid, action.task_id, before.status);
    if(ch.assignee_email){
      const m=ctx.team.find(x=>x.email===ch.assignee_email);
      if(m && !m.isAdmin) await ceoSend(env, deps, ctx, {phone:m.phone, email:m.email, role:'staff', kind:'action', taskId:action.task_id,
        text:`📌 ${firstName(m.name)}, task #${action.task_id} "${String(before.title).slice(0,80)}" is now yours${(ch.due_date||before.due_date)?` — due ${fmtDate(ch.due_date||before.due_date)}`:''}.`});
    }else if(ch.due_date && before.assignee_email){
      const m=ctx.team.find(x=>x.email===String(before.assignee_email).toLowerCase());
      if(m && !m.isAdmin) await ceoSend(env, deps, ctx, {phone:m.phone, email:m.email, role:'staff', kind:'action', taskId:action.task_id,
        text:`📅 Task #${action.task_id} "${String(before.title).slice(0,80)}" is now due ${fmtDate(ch.due_date)}.`});
    }
    return {ok:true, result:'Updated'};
  }
  if(action.type==='create_task'){
    const r=await env.DB.prepare(`INSERT INTO pm_tasks (client_id, project_id, title, status, priority, assignee_email, due_date, ai_created, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,1,?,?)`).bind(ctx.cid, action.project_id||0, action.title, 'todo', action.priority, action.assignee_email||null, action.due_date||null, nowIso, nowIso).run();
    const id=Number(r?.meta?.last_row_id);
    await taskChanged(env, deps, ctx.cid, id, '');
    const m=ctx.team.find(x=>x.email===action.assignee_email);
    if(m && !m.isAdmin) await ceoSend(env, deps, ctx, {phone:m.phone, email:m.email, role:'staff', kind:'action', taskId:id,
      text:`📌 New task for you, ${firstName(m.name)}: #${id} "${action.title.slice(0,80)}"${action.due_date?` — due ${fmtDate(action.due_date)}`:''}.`});
    return {ok:true, result:`Created #${id}`, task_id:id};
  }
  if(action.type==='message_staff'){
    const m=ctx.team.find(x=>x.email===action.email);
    const r=await ceoSend(env, deps, ctx, {phone:m?.phone, email:action.email, role:'staff', kind:'action', text:`💬 From ${firstName(ctx.admin.name)}: ${action.text}`});
    return {ok:!!r.ok, result:r.ok?'Sent':`Not sent (${r.skipped||r.error||'error'})`};
  }
  return {ok:false, result:'Unknown action'};
}
async function ceoRecordAction(env, ctx, v, status, via, result=''){
  const nowIso=new Date(ctx.nowMs).toISOString();
  const r=await env.DB.prepare(`INSERT INTO ceo_bot_actions (client_id, kind, payload_json, summary, status, requested_via, result, created_at, decided_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(ctx.cid, v.action.type, JSON.stringify(v.action), v.summary, status, via, result, nowIso, status==='pending'?'':nowIso).run();
  return Number(r?.meta?.last_row_id);
}
// Applies the autonomy level: observe → nothing; suggest → everything waits for approval;
// auto_safe → status/due/priority changes + staff messages run, reassign/new tasks wait; full → all run.
export async function ceoHandleActions(env, deps, ctx, rawActions, via){
  const done=[], pending=[], errors=[];
  if(!rawActions.length) return {done, pending, errors};
  if(ctx.cfg.autonomy==='observe') return {done, pending, errors, observe:true};
  for(const a of rawActions){
    const v=await ceoValidateAction(env, ctx, a);
    if(v.error){ errors.push(v.error); continue; }
    const auto=ctx.cfg.autonomy==='full' || (ctx.cfg.autonomy==='auto_safe' && v.safe);
    if(auto){
      const res=await ceoExecuteAction(env, deps, ctx, v.action);
      await ceoRecordAction(env, ctx, v, res.ok?'executed':'failed', via, res.result);
      done.push(`${res.ok?'✅':'⚠️'} ${v.summary}${res.ok?'':` (${res.result})`}`);
    }else{
      const id=await ceoRecordAction(env, ctx, v, 'pending', via);
      pending.push({id, summary:v.summary});
    }
  }
  return {done, pending, errors};
}
function actionsFooter(r){
  const out=[];
  if(r.observe) out.push('👀 Observe mode — I can\'t make changes. Change autonomy in Projects → CEO Bot.');
  if(r.done.length) out.push('*Done:*', ...r.done);
  if(r.pending.length) out.push('📝 *Needs your OK:*', ...r.pending.map(p=>`A${p.id}: ${p.summary}`), `Reply APPROVE ${r.pending.map(p=>p.id).join(',')} or REJECT <id>.`);
  if(r.errors.length) out.push('⚠️ Skipped: '+r.errors.join('; '));
  return out.length?'\n\n'+out.join('\n'):'';
}
export async function ceoDecideAction(env, deps, ctx, id, decision){
  const row=await env.DB.prepare(`SELECT * FROM ceo_bot_actions WHERE id=? AND client_id=?`).bind(Number(id)||0, ctx.cid).first();
  if(!row) return {ok:false, message:`A${id} not found`};
  if(row.status!=='pending') return {ok:false, message:`A${id} was already ${row.status}`};
  const nowIso=new Date(ctx.nowMs).toISOString();
  if(decision!=='approve'){
    await env.DB.prepare(`UPDATE ceo_bot_actions SET status='rejected', decided_at=? WHERE id=?`).bind(nowIso, row.id).run();
    // A staff delay request that was turned down — tell them.
    let p={}; try{ p=JSON.parse(row.payload_json||'{}'); }catch(e){}
    if(p.requested_by){ const m=ctx.team.find(x=>x.email===p.requested_by); if(m) await ceoSend(env, deps, ctx, {phone:m.phone, email:m.email, role:'staff', kind:'action', text:`❌ Your request (${row.summary}) was not approved.`}); }
    return {ok:true, message:`❌ Rejected A${row.id}: ${row.summary}`};
  }
  let action={}; try{ action=JSON.parse(row.payload_json||'{}'); }catch(e){}
  const res=await ceoExecuteAction(env, deps, ctx, action);
  await env.DB.prepare(`UPDATE ceo_bot_actions SET status=?, result=?, decided_at=? WHERE id=?`).bind(res.ok?'executed':'failed', res.result, nowIso, row.id).run();
  return {ok:res.ok, message:`${res.ok?'✅ Approved':'⚠️ Failed'} A${row.id}: ${row.summary}${res.ok?'':` (${res.result})`}`};
}

// ── Inbound: owner ───────────────────────────────────────────────────────────────────────────────
const ADMIN_HELP='I\'m your CEO Bot 🤖 for staff tasks.\n• Ask: "what\'s overdue?", "how is Rahul doing?"\n• Instruct: "move #12 to Friday", "assign #8 to Priya"\n• BRIEF · WRAP · REPORT — send now\n• APPROVE 3 / REJECT 3 — pending changes\n• PAUSE / RESUME — stop or restart all messages';
export async function ceoAdminTurn(env, deps, ctx, text, {via='whatsapp'}={}){
  const t=String(text||'').trim();
  const lower=t.toLowerCase();
  let m;
  if(/^(help|menu|\?)$/.test(lower)) return ADMIN_HELP;
  if((m=lower.match(/^(approve|reject|yes|no)\s*a?\s*([\d,\sa]+)$/))){
    const ids=m[2].split(/[,\s]+/).map(x=>x.replace(/^a/,'')).filter(Boolean);
    const out=[]; for(const id of ids) out.push((await ceoDecideAction(env, deps, ctx, id, ['approve','yes'].includes(m[1])?'approve':'reject')).message);
    return out.join('\n');
  }
  if(lower==='pause' || lower==='resume'){
    const cfg={...ctx.cfg, paused:lower==='pause'};
    await env.DB.prepare(`UPDATE ceo_bot_settings SET config_json=?, updated_at=? WHERE client_id=?`).bind(JSON.stringify(cfg), new Date(ctx.nowMs).toISOString(), ctx.cid).run();
    ctx.cfg=cfg;
    return lower==='pause'?'⏸️ Paused. I won\'t send any scheduled messages until you say RESUME.':'▶️ Resumed. Scheduled messages are back on.';
  }
  const tasks=await ceoLoadTasks(env, ctx);
  if(lower==='brief') return ceoBriefText(ctx, tasks);
  if(lower==='report' || lower==='weekly') return ceoWeeklyText(ctx, await ceoScorecard(env, ctx, 7, tasks));
  if(lower==='wrap'){
    const today=ctx.local.date;
    const startIso=new Date(Date.parse(today+'T00:00:00Z')-ctx.cfg.schedule.tz_offset_min*60000).toISOString();
    const standups=(await env.DB.prepare(`SELECT * FROM ceo_bot_standups WHERE client_id=? AND standup_date=?`).bind(ctx.cid, today).all()).results||[];
    const events=(await env.DB.prepare(`SELECT * FROM ceo_bot_task_events WHERE client_id=? AND created_at>=? ORDER BY id`).bind(ctx.cid, startIso).all()).results||[];
    return ceoWrapText(ctx, tasks, standups, events);
  }
  const ai=await ceoAdminAi(env, deps, ctx, t, tasks);
  const r=await ceoHandleActions(env, deps, ctx, ai.actions, via);
  return ai.reply+actionsFooter(r);
}

// ── Inbound: staff ───────────────────────────────────────────────────────────────────────────────
const VERB_MAP={done:'done', complete:'done', completed:'done', finished:'done', finish:'done',
  blocked:'blocked', block:'blocked', stuck:'blocked',
  delay:'delay', postpone:'delay', extend:'delay',
  progress:'progress', wip:'progress', started:'progress'};
export function ceoParseStaffCommand(text){
  const m=String(text||'').trim().match(/^([a-z]+)\b[\s:,-]*#?(\d+)?[\s:,-]*([\s\S]*)$/i);
  if(!m) return null;
  const verb=VERB_MAP[m[1].toLowerCase()];
  if(!verb) return null;
  return {verb, id:m[2]?Number(m[2]):null, rest:String(m[3]||'').trim()};
}
async function staffOpenTasks(env, ctx, member){
  const {results}=await env.DB.prepare(`SELECT id, title, status, due_date FROM pm_tasks WHERE client_id=? AND LOWER(assignee_email)=? AND status<>'done' ORDER BY COALESCE(due_date,'9999') ASC, id ASC LIMIT 40`)
    .bind(ctx.cid, member.email).all();
  return results||[];
}
async function ceoStaffApply(env, deps, ctx, member, task, verb, rest){
  const nowIso=new Date(ctx.nowMs).toISOString(), today=ctx.local.date;
  const title=`#${task.id} "${String(task.title).slice(0,60)}"`;
  if(verb==='done'){
    await env.DB.prepare(`UPDATE pm_tasks SET status='done', done_at=?, updated_at=? WHERE id=? AND client_id=?`).bind(nowIso, nowIso, task.id, ctx.cid).run();
    await taskChanged(env, deps, ctx.cid, task.id, task.status);
    await ceoEvent(env, ctx.cid, task.id, member.email, 'done', rest, nowIso);
    return `✅ Marked ${title} done. Nice work${member.name?`, ${firstName(member.name)}`:''}!`;
  }
  if(verb==='progress'){
    if(task.status==='todo'){
      await env.DB.prepare(`UPDATE pm_tasks SET status='in_progress', updated_at=? WHERE id=? AND client_id=?`).bind(nowIso, task.id, ctx.cid).run();
      await taskChanged(env, deps, ctx.cid, task.id, task.status);
    }
    await ceoEvent(env, ctx.cid, task.id, member.email, 'progress', rest, nowIso);
    return `👍 Noted progress on ${title}${rest?`: ${rest.slice(0,80)}`:''}.`;
  }
  if(verb==='blocked'){
    if(!rest){ await ceoSetContext(env, ctx.cid, member.phone, {awaiting:{type:'blocked', task_id:task.id}}); return `🚧 What's blocking ${title}? Reply with the reason.`; }
    await env.DB.prepare(`UPDATE pm_tasks SET status='blocked', updated_at=? WHERE id=? AND client_id=?`).bind(nowIso, task.id, ctx.cid).run();
    await taskChanged(env, deps, ctx.cid, task.id, task.status);
    await ceoEvent(env, ctx.cid, task.id, member.email, 'blocked', rest, nowIso);
    await sendAdmin(env, deps, ctx, 'escalation', `🚧 ${member.name} is blocked on ${title}:\n"${rest.slice(0,300)}"\n\nReply e.g. "message ${firstName(member.name)}: …" or "assign #${task.id} to …".`, {taskId:task.id});
    return `🚧 Marked ${title} blocked and told ${firstName(ctx.admin.name)}. Hang tight.`;
  }
  if(verb==='delay'){
    const date=ceoParseDate(rest, today);
    if(!date || date<today){ await ceoSetContext(env, ctx.cid, member.phone, {awaiting:{type:'delay', task_id:task.id}}); return `⏳ New date for ${title}? e.g. "Friday", "tomorrow" or "12 Oct".`; }
    await ceoEvent(env, ctx.cid, task.id, member.email, 'delay', date, nowIso);
    const v={action:{type:'update_task', task_id:task.id, changes:{due_date:date}, requested_by:member.email}, summary:`${member.name} asks to move ${title} → ${fmtDate(date)}`};
    if(ctx.cfg.staff_delay_needs_approval){
      const id=await ceoRecordAction(env, ctx, v, 'pending', 'whatsapp');
      await sendAdmin(env, deps, ctx, 'escalation', `⏳ ${v.summary}.\nReply APPROVE ${id} or REJECT ${id}.`, {taskId:task.id,
        buttons:[{id:`ceoa:approve:${id}`, title:'✅ Approve'}, {id:`ceoa:reject:${id}`, title:'❌ Reject'}]});
      return `⏳ Asked ${firstName(ctx.admin.name)} to move ${title} to ${fmtDate(date)}. I'll let you know.`;
    }
    await env.DB.prepare(`UPDATE pm_tasks SET due_date=?, updated_at=? WHERE id=? AND client_id=?`).bind(date, nowIso, task.id, ctx.cid).run();
    await taskChanged(env, deps, ctx.cid, task.id, task.status);
    await ceoRecordAction(env, ctx, v, 'executed', 'whatsapp', 'Updated');
    return `📅 Moved ${title} to ${fmtDate(date)}.`;
  }
  return null;
}
export async function ceoStaffTurn(env, deps, ctx, member, text, buttonId=''){
  const nowIso=new Date(ctx.nowMs).toISOString(), today=ctx.local.date;
  const contact=ctxJson(await ceoContact(env, ctx.cid, member.phone));
  const open=await staffOpenTasks(env, ctx, member);
  const find=id=>open.find(t=>Number(t.id)===Number(id));
  // 1) Button taps from escalation messages.
  let m=String(buttonId||'').match(/^ceo:(done|delay|blocked):(\d+)$/);
  if(m){
    const task=find(m[2]);
    if(!task) return `Task #${m[2]} isn't open on your list any more.`;
    return ceoStaffApply(env, deps, ctx, member, task, m[1], '');
  }
  const t=String(text||'').trim();
  // 2) Follow-up to a question the bot just asked (delay date / blocker reason).
  if(contact.awaiting && contact.awaiting.type){
    const aw=contact.awaiting; await ceoSetContext(env, ctx.cid, member.phone, {awaiting:null});
    const task=find(aw.task_id);
    if(task && !ceoParseStaffCommand(t)) return ceoStaffApply(env, deps, ctx, member, task, aw.type, t);
  }
  // 3) Explicit commands: DONE 12 · BLOCKED 12 reason · DELAY 12 friday · PROGRESS 12 note.
  // While today's standup is still unanswered, only a command WITH a task number counts as one —
  // "Done the banner, today the deck" is a standup answer, not "mark my only task done".
  const cmd=ceoParseStaffCommand(t);
  const standupPending=contact.standup_date===today;
  if(cmd && (cmd.id || !standupPending)){
    let task=cmd.id?find(cmd.id):(open.length===1?open[0]:null);
    if(cmd.id && !task) return `#${cmd.id} isn't one of your open tasks. Your open tasks:\n${open.slice(0,8).map(x=>`• #${x.id} ${String(x.title).slice(0,50)}`).join('\n')||'(none)'}`;
    if(!task) return `Which task? Reply e.g. "${cmd.verb.toUpperCase()} ${open[0]?.id||12}". Your open tasks:\n${open.slice(0,8).map(x=>`• #${x.id} ${String(x.title).slice(0,50)}`).join('\n')||'(none)'}`;
    return ceoStaffApply(env, deps, ctx, member, task, cmd.verb, cmd.rest);
  }
  if(/^(help|menu|\?|hi|hello|hey)$/i.test(t)){
    return `Hi ${firstName(member.name)} 👋 I track your project tasks.\nReply: DONE 12 · BLOCKED 12 <reason> · DELAY 12 friday · PROGRESS 12 <note>\nYour open tasks:\n${open.slice(0,8).map(x=>`• #${x.id} ${String(x.title).slice(0,50)}${x.due_date?` (due ${fmtDate(x.due_date)})`:''}`).join('\n')||'(none)'}`;
  }
  // 4) Today's standup answer.
  if(standupPending){
    const r=await env.DB.prepare(`UPDATE ceo_bot_standups SET answer=?, answered_at=? WHERE client_id=? AND member_email=? AND standup_date=? AND answered_at=''`)
      .bind(t.slice(0,2000), nowIso, ctx.cid, member.email, today).run();
    if(Number(r?.meta?.changes||0)===1){
      await ceoSetContext(env, ctx.cid, member.phone, {standup_date:null});
      if(/block|stuck|waiting|need help|issue/i.test(t)) await sendAdmin(env, deps, ctx, 'escalation', `🗣️ ${member.name}'s standup mentions a blocker:\n"${t.slice(0,400)}"`);
      return `Thanks ${firstName(member.name)}! Standup logged ✅`;
    }
  }
  // 5) Free text → AI maps it to one of their tasks (only when they have open tasks).
  if(open.length && await ceoAiAllowed(env, ctx)){
    const sys='Map a staff member\'s WhatsApp message to ONE of their open tasks. Output ONLY JSON: {"task_id":number|null,"action":"done|blocked|delay|progress|none","date":"YYYY-MM-DD"|null,"note":"short"}. '
      +'Use "none" when the message is not a clear task update. Resolve relative dates against today.';
    const user=`today=${today}\nOPEN TASKS:\n${open.map(x=>`#${x.id} ${x.title} (status ${x.status}${x.due_date?`, due ${x.due_date}`:''})`).join('\n')}\n\nMESSAGE: ${t}`;
    const j=ceoExtractJson(await deps.ai(env, ctx.c, sys, user, {maxOutputTokens:200, temperature:0}));
    const task=j&&find(j.task_id);
    if(task && ['done','blocked','delay','progress'].includes(j.action)){
      const rest=j.action==='delay'?(j.date||''):(j.note||t).slice(0,300);
      return ceoStaffApply(env, deps, ctx, member, task, j.action, rest);
    }
  }
  return `Got it 👍 To update a task reply: DONE 12 · BLOCKED 12 <reason> · DELAY 12 friday. Send HELP for your list.`;
}

// ── Webhook (dedicated CEO number) ───────────────────────────────────────────────────────────────
function inboundText(msg){
  if(msg?.type==='text') return {text:String(msg.text?.body||''), button:''};
  if(msg?.type==='interactive') return {text:String(msg.interactive?.button_reply?.title||msg.interactive?.list_reply?.title||''),
    button:String(msg.interactive?.button_reply?.id||msg.interactive?.list_reply?.id||'')};
  if(msg?.type==='button') return {text:String(msg.button?.text||''), button:String(msg.button?.payload||'')};
  return {text:'', button:'', unsupported:msg?.type||'unknown'};
}
export async function ceoProcessInbound(env, deps, ctx, msg){
  const phone=String(msg.from||'').replace(/\D/g,'');
  const nowIso=new Date(ctx.nowMs).toISOString();
  if(!phone) return {skipped:'no-from'};
  if(msg.id){
    const dup=await env.DB.prepare(`SELECT 1 AS x FROM ceo_bot_messages WHERE client_id=? AND direction='in' AND detail=? LIMIT 1`).bind(ctx.cid, String(msg.id)).first();
    if(dup) return {skipped:'duplicate'};
  }
  const member=ctx.team.find(x=>phoneMatch(x.phone, phone));
  const role=member?(member.isAdmin?'admin':'staff'):'unknown';
  const {text, button, unsupported}=inboundText(msg);
  await ceoLog(env, ctx.cid, {phone, email:member?.email||'', role, direction:'in', kind:role==='admin'?'chat':'reply',
    body:text||`[${unsupported||'message'}]`, status:'received', detail:String(msg.id||''), at:nowIso});
  await env.DB.prepare(`INSERT INTO ceo_bot_contacts (client_id, phone, last_inbound_at) VALUES (?,?,?)
    ON CONFLICT(client_id, phone) DO UPDATE SET last_inbound_at=excluded.last_inbound_at`).bind(ctx.cid, phone, nowIso).run();
  if(!member){
    // Never chat with outsiders on this number (it is not a customer line); log only, once a day reply.
    if(await ceoClaim(env, ctx.cid, 'unknown_reply', `${ctx.local.date}:${phone}`, nowIso)){
      await ceoSend(env, deps, ctx, {phone, role:'unknown', kind:'reply', text:'This is an internal team number. Your message was not delivered to anyone.'});
    }
    return {role};
  }
  // Use the matched contact's stored phone format from here on so threads stay together.
  const who={...member, phone};
  let reply;
  if(unsupported && !button) reply='I can read text messages and button taps only for now 🙏';
  else if(role==='admin'){
    const b=button.match(/^ceoa:(approve|reject):(\d+)$/);
    reply=b?(await ceoDecideAction(env, deps, ctx, b[2], b[1])).message:await ceoAdminTurn(env, deps, ctx, text, {via:'whatsapp'});
  }else if(ctx.cfg.paused) reply='⏸️ CEO Bot is paused right now — your message was saved for the owner.';
  else reply=await ceoStaffTurn(env, deps, ctx, who, text, button);
  if(reply) await ceoSend(env, deps, ctx, {phone, email:member.email, role, kind:role==='admin'?'chat':'reply', text:reply});
  return {role, reply};
}
async function ceoWebhook(request, env, deps, hookKey, ctxExec){
  const {json}=deps;
  const url=new URL(request.url);
  if(!/^[a-f0-9]{32}$/.test(hookKey)) return json({error:'Not found'}, 404);
  const row=await env.DB.prepare(`SELECT * FROM ceo_bot_settings WHERE hook_key=?`).bind(hookKey).first();
  if(!row) return json({error:'Not found'}, 404);
  if(request.method==='GET'){
    if(url.searchParams.get('hub.mode')==='subscribe' && url.searchParams.get('hub.verify_token')===hookKey)
      return new Response(url.searchParams.get('hub.challenge')||'', {status:200});
    return json({error:'Verification failed'}, 403);
  }
  const raw=await request.text();
  let secret='';
  if(row.app_secret_enc){ try{ secret=await deps.decrypt(env, row.app_secret_enc)||''; }catch(e){} }
  if(!secret) secret=deps.metaAppSecret(env)||'';
  if(!secret || !await deps.verifySignature(secret, raw, request.headers.get('X-Hub-Signature-256'))) return new Response('Invalid signature', {status:401});
  let body; try{ body=JSON.parse(raw); }catch(e){ return json({error:'Invalid JSON'}, 400); }
  const msgs=[];
  for(const entry of body?.entry||[]) for(const ch of entry?.changes||[]){
    const v=ch?.value||{};
    if(String(v?.metadata?.phone_number_id||'')!==String(row.wa_phone_id)) continue;
    for(const m of v.messages||[]) msgs.push(m);
  }
  const work=(async()=>{
    try{
      const c=await deps.getClientById(env, row.client_id);
      if(!ceoEnabled(c)) return;
      for(const m of msgs){
        const ctx=await ceoBuildContext(env, deps, c, await ceoSettingsRow(env, row.client_id), Date.now());
        await ceoProcessInbound(env, deps, ctx, m);
      }
    }catch(e){ await deps.reportOpsError(env, 'ceoBotInbound', e, {clientId:row.client_id}).catch(()=>{}); }
  })();
  if(ctxExec?.waitUntil){ ctxExec.waitUntil(work); return json({ok:true, accepted:msgs.length}); }
  await work;
  return json({ok:true, accepted:msgs.length});
}

// ── Dashboard API (/ceo/*) ───────────────────────────────────────────────────────────────────────
function newHookKey(){ const b=new Uint8Array(16); crypto.getRandomValues(b); return [...b].map(x=>x.toString(16).padStart(2,'0')).join(''); }
function channelInfo(env, deps, row, origin=''){
  const base=String(deps.webhookBase(env)||origin||'').replace(/\/+$/,'');
  return {connected:!!(row?.wa_phone_id && row?.wa_token_enc), wa_phone_id:row?.wa_phone_id||'', display_phone:row?.display_phone||'',
    has_app_secret:!!row?.app_secret_enc, webhook_url:row?.hook_key?`${base}/ceo/wa/webhook/${row.hook_key}`:'',
    verify_token:row?.hook_key||''};
}
export async function ceoHandleRoute(request, env, deps, url, ctxExec=null){
  const {json}=deps;
  const path=url.pathname, method=request.method;
  const hook=path.match(/^\/ceo\/wa\/webhook\/([^/]+)$/);
  if(hook) return ceoWebhook(request, env, deps, hook[1], ctxExec);

  const payload=await deps.requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  const cid=Number(payload.cid);
  const c=await deps.getClientById(env, cid);
  const owner=ceoIsOwner(c, payload.email);
  // Status is readable by any session so the UI knows whether to show the tab at all.
  if(path==='/ceo/status' && method==='GET') return json({enabled:ceoEnabled(c), admin:owner});
  if(!ceoEnabled(c)) return json({error:'CEO Bot is not enabled for this account.'}, 403);
  if(!owner) return json({error:'Only the account owner can use CEO Bot.'}, 403);
  const body=['POST','PATCH','DELETE'].includes(method)?await request.json().catch(()=>({})):{};
  const nowIso=new Date().toISOString();
  let row=await ceoSettingsRow(env, cid);
  const ensureRow=async()=>{
    if(row) return row;
    await env.DB.prepare(`INSERT OR IGNORE INTO ceo_bot_settings (client_id, config_json, hook_key, updated_at) VALUES (?,?,?,?)`)
      .bind(cid, JSON.stringify(ceoNormalizeConfig({})), newHookKey(), nowIso).run();
    row=await ceoSettingsRow(env, cid); return row;
  };
  const ctx=async()=>ceoBuildContext(env, deps, c, await ensureRow(), Date.now());

  if(path==='/ceo/config' && method==='GET'){
    const x=await ctx();
    const {results:projects}=await env.DB.prepare(`SELECT id, name, status FROM pm_projects WHERE client_id=? ORDER BY name`).bind(cid).all().catch(()=>({results:[]}));
    return json({config:x.cfg, channel:channelInfo(env, deps, x.row, url.origin), team:x.team, projects:projects||[], admin_email:x.admin.email});
  }
  if(path==='/ceo/config' && method==='POST'){
    const r=await ensureRow();
    const cur=ceoNormalizeConfig(r.config_json||'{}');
    const inc=body.config&&typeof body.config==='object'?body.config:{};
    const merged={...cur, ...inc,
      persona:{...cur.persona, ...(inc.persona||{})}, playbooks:{...cur.playbooks, ...(inc.playbooks||{})},
      schedule:{...cur.schedule, ...(inc.schedule||{})}, escalation:{...cur.escalation, ...(inc.escalation||{})},
      template:{...cur.template, ...(inc.template||{})}, staff:inc.staff&&typeof inc.staff==='object'?inc.staff:cur.staff};
    const cfg=ceoNormalizeConfig(merged);
    await env.DB.prepare(`UPDATE ceo_bot_settings SET config_json=?, updated_at=? WHERE client_id=?`).bind(JSON.stringify(cfg), nowIso, cid).run();
    return json({ok:true, config:cfg});
  }
  if(path==='/ceo/channel' && method==='POST'){
    const r=await ensureRow();
    if(body.disconnect){
      await env.DB.prepare(`UPDATE ceo_bot_settings SET wa_phone_id='', display_phone='', wa_token_enc='', app_secret_enc='', updated_at=? WHERE client_id=?`).bind(nowIso, cid).run();
      return json({ok:true, channel:channelInfo(env, deps, await ceoSettingsRow(env, cid), url.origin)});
    }
    const phoneId=String(body.wa_phone_id||r.wa_phone_id||'').replace(/\D/g,'').slice(0,40);
    if(!phoneId) return json({error:'Enter the Phone number ID of the CEO WhatsApp number (Meta → WhatsApp → API Setup).'}, 400);
    let tokenEnc=r.wa_token_enc||'', secretEnc=r.app_secret_enc||'', token='';
    try{
      if(body.wa_token){ token=String(body.wa_token).trim(); tokenEnc=await deps.encrypt(env, token); }
      else if(tokenEnc) token=await deps.decrypt(env, tokenEnc)||'';
      if(body.app_secret) secretEnc=await deps.encrypt(env, String(body.app_secret).trim());
    }catch(e){ return json({error:'Secure storage is not configured on the server.'}, 500); }
    if(!token) return json({error:'Enter the access token for the CEO WhatsApp number.'}, 400);
    // This number must not be one the lead bot already uses.
    const leadsIds=[c?.wa_phone_id].filter(Boolean).map(String);
    if(leadsIds.includes(phoneId)) return json({error:'That is your leads WhatsApp number. CEO Bot needs its own, separate number.'}, 400);
    const look=await deps.waLookup({wa_phone_id:phoneId, wa_token:token}).catch(e=>({ok:false, error:e.message}));
    if(!look?.ok) return json({error:`Meta rejected these details: ${look?.error||'unknown error'}`}, 400);
    const display=String(look.display_phone||body.display_phone||'').slice(0,30);
    await env.DB.prepare(`UPDATE ceo_bot_settings SET wa_phone_id=?, display_phone=?, wa_token_enc=?, app_secret_enc=?, hook_key=CASE WHEN hook_key='' THEN ? ELSE hook_key END, updated_at=? WHERE client_id=?`)
      .bind(phoneId, display, tokenEnc, secretEnc, newHookKey(), nowIso, cid).run();
    return json({ok:true, channel:channelInfo(env, deps, await ceoSettingsRow(env, cid), url.origin)});
  }
  if(path==='/ceo/test' && method==='POST'){
    const x=await ctx();
    const r=await sendAdmin(env, deps, x, 'test', `👋 Hi ${firstName(x.admin.name)}, ${x.cfg.persona.name} is connected. Reply HELP to see what I can do.`);
    return json(r.ok?{ok:true}:{ok:false, error:r.skipped==='window'?'Outside WhatsApp\'s 24-hour window: send any message to the CEO number from your phone first (or set an approved template).':r.skipped==='no-phone'?'Add your WhatsApp number in Team below (or in User Management).':r.error||r.skipped});
  }
  if(path==='/ceo/run' && method==='POST'){
    const x=await ctx(), kind=String(body.kind||'');
    if(!['brief','wrap','weekly'].includes(kind)) return json({error:'kind must be brief, wrap or weekly'}, 400);
    const text=await ceoAdminTurn(env, deps, x, kind==='weekly'?'report':kind, {via:'console'});
    const r=await sendAdmin(env, deps, x, kind, text);
    return json({ok:!!r.ok, text, error:r.ok?undefined:(r.skipped||r.error)});
  }
  if(path==='/ceo/chat' && method==='POST'){
    const text=String(body.text||'').trim().slice(0,2000);
    if(!text) return json({error:'text required'}, 400);
    const x=await ctx();
    await ceoLog(env, cid, {phone:'console', email:x.admin.email, role:'admin', direction:'in', kind:'chat', body:text, status:'received'});
    const reply=await ceoAdminTurn(env, deps, x, text, {via:'console'});
    await ceoLog(env, cid, {phone:'console', email:x.admin.email, role:'admin', direction:'out', kind:'chat', body:reply, status:'sent'});
    return json({reply});
  }
  if(path==='/ceo/threads' && method==='GET'){
    const x=await ctx();
    const {results}=await env.DB.prepare(`SELECT m.phone, m.party_email, m.party_role, m.body, m.direction, m.created_at, (SELECT COUNT(*) FROM ceo_bot_messages z WHERE z.client_id=m.client_id AND z.phone=m.phone) AS total
      FROM ceo_bot_messages m WHERE m.client_id=? AND m.id IN (SELECT MAX(id) FROM ceo_bot_messages WHERE client_id=? GROUP BY phone) ORDER BY m.id DESC LIMIT 100`).bind(cid, cid).all();
    return json({threads:(results||[]).map(t=>({...t, name:t.phone==='console'?'Web console':(t.party_email?memberName(x, t.party_email):t.phone)}))});
  }
  if(path==='/ceo/messages' && method==='GET'){
    const phone=String(url.searchParams.get('phone')||'');
    const before=Number(url.searchParams.get('before'))||0;
    const {results}=await env.DB.prepare(`SELECT id, phone, party_email, party_role, direction, kind, body, task_id, status, detail, created_at FROM ceo_bot_messages
      WHERE client_id=? AND phone=? ${before?'AND id<?':''} ORDER BY id DESC LIMIT 100`).bind(...(before?[cid, phone, before]:[cid, phone])).all();
    return json({messages:(results||[]).reverse().map(r=>({...r, detail:r.direction==='in'?'':r.detail}))});
  }
  if(path==='/ceo/actions' && method==='GET'){
    const status=String(url.searchParams.get('status')||'');
    const {results}=await env.DB.prepare(`SELECT id, kind, summary, status, requested_via, result, created_at, decided_at FROM ceo_bot_actions WHERE client_id=? ${status?'AND status=?':''} ORDER BY id DESC LIMIT 100`)
      .bind(...(status?[cid, status]:[cid])).all();
    return json({actions:results||[]});
  }
  if(path==='/ceo/actions/decide' && method==='POST'){
    const x=await ctx();
    const r=await ceoDecideAction(env, deps, x, body.id, body.decision==='approve'?'approve':'reject');
    return json(r, r.ok?200:400);
  }
  if(path==='/ceo/team-report' && method==='GET'){
    const days=Math.min(180, Math.max(1, Number(url.searchParams.get('days'))||30));
    return json(await ceoScorecard(env, await ctx(), days));
  }
  if(path==='/ceo/standups' && method==='GET'){
    const x=await ctx();
    const from=ceoAddDays(x.local.date, -13);
    const {results}=await env.DB.prepare(`SELECT member_email, standup_date, answer, asked_at, answered_at FROM ceo_bot_standups WHERE client_id=? AND standup_date>=? ORDER BY standup_date DESC, member_email`).bind(cid, from).all();
    return json({standups:(results||[]).map(s=>({...s, name:memberName(x, s.member_email)}))});
  }
  return json({error:'Not found'}, 404);
}
