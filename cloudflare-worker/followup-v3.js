// ── Follow-up V3 ─────────────────────────────────────────────────────────────────────────────────
// A switch-on layer over the Follow-up Engine's 5-step ladder (worker.js FOLLOWUP_LADDER_STEP_SHAPE,
// followup_ladder_steps). Off until the client turns it on (🔁 Follow-ups → Settings →
// "Follow-up V3"); once on it needs no further setup. Ideas borrowed from the market:
//   - Ready-made sequence on day one, templates submitted for approval automatically (WATI,
//     Interakt, AiSensy default flows) — fv3Setup.
//   - Exit goals: stop once the lead books, buys or is won (HubSpot sequences, Klaviyo flow goals).
//   - Send-time optimisation: template steps go out at the hour this lead usually writes
//     (Klaviyo Smart Send Time, Brevo).
//   - Objection-aware nudges: a lead whose last objection matches the Objection Playbook gets a
//     nudge that answers it (Respond.io / Kommo branching).
//   - Re-engagement after long silence, smart retry, Meta frequency-cap aware (AiSensy, Gallabox).
//   - Report: replies, conversions and revenue per step, opt-out health, trend, best hour,
//     failures with a fix, industry benchmark, weekly digest (Klaviyo flow analytics).
//   - Per-lead status ("sent / next / why not") on the lead card and in Chats.
//
// What it fixes over the classic cron (classicFollowupProcessClient), for V3 clients only:
//   - Steps are spaced: every step also waits min_gap_hours after the previous send, so a lead who
//     went quiet late at night no longer gets nudge 1 and nudge 2 fifteen minutes apart.
//   - Only nights are blocked (quiet_start→quiet_end), not everything outside an evening window.
//   - A reply credits only the latest follow-up, and only inside attribution_hours.
//   - A template step with no template yet is shown as "waiting for approval", not logged as a
//     failure for every lead on every tick; repeated identical failures are logged once a day.
//   - The bot's/our own outgoing message doesn't count as "your team replied" (agent heuristics).
//
// Isolation: every V3 table is new (migrations/0114_followup_v3.sql, also created lazily here).
// The classic cron and the Smart Follow-ups Durable Object skip a client while V3 is on, so nothing
// is sent twice. Turning V3 off hands the client straight back to the classic engine.
// This file imports nothing from worker.js; worker.js passes helpers in as `deps` (FOLLOWUP_V3_DEPS):
// { json, requireSession, getClientById, ncFetch, ensureLeadsColumns, leadsTable, reportOpsError,
//   ai(env,c,sys,user,opts)→text|null, metaCreds(c, lead?)→{waba_id,wa_phone_id,wa_token}|null,
//   sendStep(env,c,lead,step,stepCfg,opts)→{text,variant,sendId}, sendEmail(env,to,subject,html),
//   orderPhones(env,c)→{digits10:{date,total}}|null, objectionPlaybook(c)→[{category,approved_response}],
//   leadColumns(env)→[column titles of the leads table] }

const H=3600000, D=24*H;

export const FV3_DEFAULTS={
  staff_reply_hours:24,       // resume after our reply; 0 preserves the old indefinite hold
  stage_sequences:{},        // optional per-stage session wording and approved templates
  paused:false,               // emergency stop for this account (sends nothing, keeps the setting)
  include_existing_leads:false, // false = only leads created after V3 was switched on
  quiet_start:21, quiet_end:9,  // no sends between these local hours (night)
  min_gap_hours:3,            // minimum time between two follow-ups to the same lead
  daily_cap:300,              // max V3 sends per account per 24h
  warmup_cap:50, warmup_days:7, // lower cap for the first week after switching on
  lead_cap_30d:8,             // max follow-ups one lead can receive in 30 days
  smart_send_time:true,       // template steps go out at the hour this lead usually writes
  objection_branching:true,   // nudges 1-2 answer the lead's last objection from the Playbook
  exit_stages:[],             // extra Stages that end the sequence (on top of won/booked/lost)
  exit_on_order:true,         // ecom: placing an order ends the sequence
  reengage_enabled:true, reengage_after_days:30, reengage_max:2,
  auto_templates:true,        // submit + attach the day-1/3/7 and re-engage templates automatically
  ai_variant_b:true,          // AI writes a Variant B for nudges 1-2 so A/B testing starts on day one
  attribution_hours:72,       // a reply within this many hours of a follow-up counts for it
  weekly_digest:true,         // Monday email to the account owner
};

// Mirrors worker.js PIPELINE_TERMINAL_STAGES — a closed lead never gets another follow-up.
export const FV3_WON_STAGES=new Set(['won','converted','Converted']);
export const FV3_BOOKED_STAGES=new Set(['consultation_booked','visit_booked','appt_booked']);
export const FV3_CLOSED_STAGES=new Set(['lost','Lost','Closed','Opt Out']);
const SESSION_THRESHOLD_DEFAULT={1:1, 2:6};
const TEMPLATE_THRESHOLD={3:25, 4:72, 5:168};
const STALE_TEMPLATE_HOURS=72; // a template step more than 3 days overdue is dropped, not sent late
const SESSION_WINDOW_MARGIN=10*60000;
const REENGAGE_STEP=6;
const CONVERSION_WINDOW_DAYS=14;

function clampInt(v, min, max, dflt){ const n=parseInt(v, 10); return Number.isFinite(n)?Math.min(max, Math.max(min, n)):dflt; }
export function fv3Config(raw){
  let o=raw; if(typeof o==='string'){ try{ o=JSON.parse(o||'{}'); }catch(e){ o={}; } }
  o=o&&typeof o==='object'?o:{};
  const d=FV3_DEFAULTS, b=(k)=>typeof o[k]==='boolean'?o[k]:d[k];
  return {
    staff_reply_hours:clampInt(o.staff_reply_hours, 0, 336, d.staff_reply_hours),
    stage_sequences:fv3StageConfig(o.stage_sequences),
    paused:b('paused'), include_existing_leads:b('include_existing_leads'),
    quiet_start:clampInt(o.quiet_start, 0, 23, d.quiet_start), quiet_end:clampInt(o.quiet_end, 0, 23, d.quiet_end),
    min_gap_hours:clampInt(o.min_gap_hours, 1, 48, d.min_gap_hours),
    daily_cap:clampInt(o.daily_cap, 1, 5000, d.daily_cap),
    warmup_cap:clampInt(o.warmup_cap, 1, 5000, d.warmup_cap), warmup_days:clampInt(o.warmup_days, 0, 30, d.warmup_days),
    lead_cap_30d:clampInt(o.lead_cap_30d, 1, 30, d.lead_cap_30d),
    smart_send_time:b('smart_send_time'), objection_branching:b('objection_branching'),
    exit_stages:Array.isArray(o.exit_stages)?o.exit_stages.map(s=>String(s).trim()).filter(Boolean).slice(0, 20):[],
    exit_on_order:b('exit_on_order'),
    reengage_enabled:b('reengage_enabled'), reengage_after_days:clampInt(o.reengage_after_days, 7, 180, d.reengage_after_days),
    reengage_max:clampInt(o.reengage_max, 1, 6, d.reengage_max),
    auto_templates:b('auto_templates'), ai_variant_b:b('ai_variant_b'),
    attribution_hours:clampInt(o.attribution_hours, 1, 336, d.attribution_hours),
    weekly_digest:b('weekly_digest'),
  };
}

// Stage overrides change wording/templates, never bypass exit goals or WhatsApp windows.
export function fv3StageConfig(raw){
  const out={};
  if(!raw || typeof raw!=='object' || Array.isArray(raw)) return out;
  for(const [stage, value] of Object.entries(raw).slice(0,20)){
    if(!stage.trim() || !value || typeof value!=='object') continue;
    const steps={};
    for(let i=1;i<=5;i++){
      const v=value[i]; if(!v || typeof v!=='object') continue;
      steps[i]=i<=2 ? {message:String(v.message||'').slice(0,2000), hours:clampInt(v.hours,1,23,SESSION_THRESHOLD_DEFAULT[i])}
        : {template_name:String(v.template_name||'').slice(0,512), template_language:String(v.template_language||'en').slice(0,20)};
    }
    out[stage.trim()]=steps;
  }
  return out;
}
export function fv3StepsForLead(steps,cfg,lead){
  const overrides=cfg.stage_sequences?.[String(lead.Stage||'')];
  if(!overrides) return steps;
  const out={...steps};
  for(const [i,v] of Object.entries(overrides)) out[i]={...steps[i],...v, step:Number(i), type:Number(i)<=2?'session':'template', message_b:'', template_name_b:'', ai_mode:0};
  return out;
}

// ── Time helpers (client's own timezone, bot_config.timezone) ──────────────────────────────────
const dtfCache=new Map();
function dtf(tz){
  let f=dtfCache.get(tz);
  if(!f){
    try{ f=new Intl.DateTimeFormat('en-US', {timeZone:tz, hour:'numeric', hourCycle:'h23', weekday:'short'}); }
    catch(e){ f=new Intl.DateTimeFormat('en-US', {timeZone:'Asia/Kolkata', hour:'numeric', hourCycle:'h23', weekday:'short'}); }
    dtfCache.set(tz, f);
  }
  return f;
}
const DOW={Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6};
export function fv3LocalParts(ms, tz){
  const parts=dtf(tz||'Asia/Kolkata').formatToParts(new Date(ms));
  const hour=Number(parts.find(p=>p.type==='hour')?.value)%24;
  const dow=DOW[parts.find(p=>p.type==='weekday')?.value]??0;
  return {hour, dow};
}
export function fv3IsQuiet(hour, start, end){
  if(start===end) return false;
  return start>end ? (hour>=start || hour<end) : (hour>=start && hour<end);
}
// First moment at/after `ms` outside quiet hours (15-minute resolution).
export function fv3NextAllowedMs(ms, tz, start, end){
  let t=ms;
  for(let i=0; i<100 && fv3IsQuiet(fv3LocalParts(t, tz).hour, start, end); i++) t=Math.ceil((t+1)/(15*60000))*15*60000;
  return t;
}
// First moment at/after `ms` that falls in local hour `hour`, within the next 24h (else `ms`).
export function fv3AlignToHour(ms, tz, hour){
  if(hour===null||hour===undefined) return ms;
  let t=ms;
  for(let i=0; i<=96; i++){
    if(fv3LocalParts(t, tz).hour===hour) return t;
    t=Math.ceil((t+1)/(15*60000))*15*60000;
  }
  return ms;
}
// The lead's usual writing hour, once there's enough signal: at least 3 messages, and the busiest
// hour holding at least 2 of them.
export function fv3PreferredHour(hoursJson){
  let h=hoursJson; if(typeof h==='string'){ try{ h=JSON.parse(h||'{}'); }catch(e){ h={}; } }
  if(!h||typeof h!=='object') return null;
  let total=0, best=null, bestN=0;
  for(const [k, v] of Object.entries(h)){
    const n=Number(v)||0; total+=n;
    if(n>bestN){ bestN=n; best=Number(k); }
  }
  return total>=3 && bestN>=2 && Number.isInteger(best) && best>=0 && best<24 ? best : null;
}

const ms=(v)=>{ const t=Date.parse(v||''); return Number.isFinite(t)?t:null; };
export function fv3LastCustomerMs(lead){ return ms(lead?.LastCustomerMsgAt)||ms(lead?.LastMsgAt)||ms(lead?.Date)||ms(lead?.CreatedAt); }

export function fv3StepLabel(step, cfg){
  if(step===1||step===2) return `Nudge ${step} · after ${cfg?.hours||SESSION_THRESHOLD_DEFAULT[step]}h`;
  if(step===3) return 'Template · day 1';
  if(step===4) return 'Template · day 3';
  if(step===5) return 'Template · day 7';
  return 'Re-engage';
}

function parseSkip(state){ try{ const s=JSON.parse(state?.skip_json||'{}'); return s&&typeof s==='object'?s:{}; }catch(e){ return {}; } }

// The whole "what happens to this lead next, and why" decision — pure, so the sweep, the lead
// status card and the tests all share one answer.
// in: {lead, steps:{1..5: followup_ladder_steps row}, cfg, state, sends:[{step,kind,sent_at,replied_at,variant}],
//      enabledAt, now, tz, hasOrder, reengageReady, terminalStages?}
export function fv3Decide(input){
  const {lead, steps:baseSteps={}, cfg=fv3Config({}), state=null, sends=[], enabledAt=null, now=Date.now(), tz='Asia/Kolkata', hasOrder=false, reengageReady=false, hasMeeting=false}=input;
  const steps=fv3StepsForLead(baseSteps,cfg,lead);
  const stage=String(lead?.Stage||'');
  const lastCust=fv3LastCustomerMs(lead);
  const out=(status, reason, text, extra={})=>({status, reason, text, next:null, steps:stepRows(null), cycle:lastCust?new Date(lastCust).toISOString():null, ...extra});
  const sorted=[...sends].sort((a, b)=>(ms(a.sent_at)||0)-(ms(b.sent_at)||0));
  const cycleSends=lastCust?sorted.filter(s=>(ms(s.sent_at)||0)>lastCust):[];
  const ladderSent=new Map(); cycleSends.filter(s=>(s.kind||'ladder')!=='reengage' && s.step<=5).forEach(s=>ladderSent.set(Number(s.step), s));
  const skip=parseSkip(state);
  const skipped=new Set(lastCust && skip.cycle===new Date(lastCust).toISOString() ? (skip.steps||[]).map(Number) : []);
  const stepState={};
  function stepRows(nextStep){
    const rows=[];
    for(let s=1; s<=5; s++){
      const sent=ladderSent.get(s);
      rows.push({step:s, type:s<=2?'session':'template', label:fv3StepLabel(s, steps[s]),
        state:sent?'sent':(stepState[s]||(nextStep===s?'next':'upcoming')),
        sent_at:sent?.sent_at||null, replied_at:sent?.replied_at||null, variant:sent?.variant||null,
        due_at:stepState['due'+s]||null});
    }
    return rows;
  }
  if(state?.delivery_hold) return out('paused','delivery_unknown','An earlier send needs delivery verification before any retry.');
  if(cfg.paused) return out('paused', 'account_paused', 'Follow-ups are paused for your account.');
  if(lead?.OptOut==='Yes') return out('stopped', 'opted_out', 'The customer opted out — no more follow-ups.');
  if(FV3_WON_STAGES.has(stage) || (hasOrder && cfg.exit_on_order)) return out('goal_reached', hasOrder&&!FV3_WON_STAGES.has(stage)?'ordered':'won', hasOrder&&!FV3_WON_STAGES.has(stage)?'Customer placed an order — sequence finished.':'Lead is won — sequence finished.');
  if(FV3_BOOKED_STAGES.has(stage)) return out('goal_reached', 'booked', 'Lead booked — sequence finished.');
  if(cfg.exit_stages.includes(stage)) return out('goal_reached', 'exit_stage', `Lead reached "${stage}" — sequence finished.`);
  if(lead?.Handover==='Yes' || stage==='human_handover') return out('human', 'human_handling', 'A person from your team is handling this chat — follow-ups are on hold.');
  if(hasMeeting) return out('meeting', 'meeting_booked', 'A meeting is booked or agreed with this lead — follow-ups are on hold until its outcome is logged (meeting reminders still go out).');
  if(FV3_CLOSED_STAGES.has(stage) || input.terminalStages?.has?.(stage)) return out('stopped', 'closed', 'Lead is closed — no more follow-ups.');
  const created=ms(lead?.CreatedAt)||ms(lead?.Date);
  if(!cfg.include_existing_leads && ms(enabledAt) && (!created || created<ms(enabledAt))) return out('not_enrolled', 'existing_lead', 'Lead came in before Follow-up V3 was switched on, so it isn\'t enrolled.');
  if(!lastCust) return out('not_enrolled', 'no_message', 'Waiting for the customer\'s first message.');
  const agentAt=ms(lead?.LastAgentMsgAt);
  let staffFloor=0;
  if(agentAt && agentAt>lastCust+90000 && !sorted.some(s=>{ const t=ms(s.sent_at)||0; return agentAt>=t-60000 && agentAt<=t+5*60000; })){
    if(!cfg.staff_reply_hours) return out('agent_replied', 'agent_replied', 'Your team replied last — waiting for the customer.');
    staffFloor=agentAt+cfg.staff_reply_hours*H;
  }
  const sent30=sorted.filter(s=>(ms(s.sent_at)||0)>now-30*D).length;
  if(sent30>=cfg.lead_cap_30d) return out('capped', 'lead_cap', `This lead already got ${sent30} follow-ups in 30 days — taking a break.`);

  const lastSent=sorted.length?ms(sorted[sorted.length-1].sent_at):null;
  const gapFloor=(t)=>lastSent?Math.max(t, lastSent+cfg.min_gap_hours*H):t;
  const deferUntil=ms(state?.defer_until);
  const prefHour=cfg.smart_send_time?fv3PreferredHour(state?.hours_json):null;
  let pendingTemplate=null;
  for(let s=1; s<=5; s++){
    const row=steps[s];
    if(ladderSent.has(s)) continue;
    if(skipped.has(s)){ stepState[s]='skipped'; continue; }
    if(!row){ stepState[s]='not_set'; continue; }
    const isSession=s<=2;
    if(isSession && !String(row.message||'').trim() && !row.ai_mode){ stepState[s]='not_set'; continue; }
    if(!isSession && !String(row.template_name||'').trim()){ stepState[s]='pending_template'; if(!pendingTemplate) pendingTemplate=s; continue; }
    const thr=isSession?(Number(row.hours)||SESSION_THRESHOLD_DEFAULT[s]):TEMPLATE_THRESHOLD[s];
    const base=lastCust+thr*H;
    let due=fv3NextAllowedMs(Math.max(gapFloor(base),staffFloor), tz, cfg.quiet_start, cfg.quiet_end);
    if(isSession){
      if(deferUntil && deferUntil>due) due=fv3NextAllowedMs(deferUntil, tz, cfg.quiet_start, cfg.quiet_end);
      if(due>=lastCust+D-SESSION_WINDOW_MARGIN || now>=lastCust+D-SESSION_WINDOW_MARGIN){ stepState[s]='expired'; continue; }
    } else {
      if(now>base+STALE_TEMPLATE_HOURS*H){ stepState[s]='expired'; continue; }
      if(prefHour!==null) due=fv3NextAllowedMs(fv3AlignToHour(due, tz, prefHour), tz, cfg.quiet_start, cfg.quiet_end);
      if(deferUntil && deferUntil>due) due=fv3NextAllowedMs(deferUntil, tz, cfg.quiet_start, cfg.quiet_end);
    }
    stepState['due'+s]=new Date(due).toISOString();
    const next={step:s, kind:'ladder', type:isSession?'session':'template', label:fv3StepLabel(s, row), due_at:new Date(due).toISOString()};
    const isDue=due<=now;
    return {status:isDue?'due':'scheduled', reason:isDue?'due':'scheduled',
      text:isDue?`Follow-up ${s} (${next.label}) is going out now.`:`Next: follow-up ${s} (${next.label}).`,
      next, steps:stepRows(s), cycle:new Date(lastCust).toISOString()};
  }
  // Ladder done for this silence — re-engage, if switched on.
  const reSends=sorted.filter(s=>s.kind==='reengage');
  const reAfterLast=reSends.filter(s=>(ms(s.sent_at)||0)>lastCust);
  if(cfg.reengage_enabled && reAfterLast.length<cfg.reengage_max){
    if(!reengageReady) return out(pendingTemplate?'waiting_template':'completed', pendingTemplate?'template_pending':'ladder_done',
      pendingTemplate?`Follow-up ${pendingTemplate} is waiting for its WhatsApp template to be approved.`:'All follow-ups sent — re-engage starts once its template is approved.', {steps:stepRows(null)});
    const lastRe=reAfterLast.length?ms(reAfterLast[reAfterLast.length-1].sent_at):null;
    let due=Math.max(lastCust+cfg.reengage_after_days*D, lastRe?lastRe+cfg.reengage_after_days*D:0);
    due=Math.max(gapFloor(due),staffFloor);
    if(prefHour!==null) due=fv3AlignToHour(due, tz, prefHour);
    due=fv3NextAllowedMs(due, tz, cfg.quiet_start, cfg.quiet_end);
    if(deferUntil && deferUntil>due) due=fv3NextAllowedMs(deferUntil, tz, cfg.quiet_start, cfg.quiet_end);
    const next={step:REENGAGE_STEP, kind:'reengage', type:'template', label:'Re-engage', due_at:new Date(due).toISOString()};
    const isDue=due<=now;
    return {status:isDue?'due':'scheduled', reason:isDue?'due':'reengage',
      text:isDue?'Re-engage message is going out now.':`All follow-ups sent with no reply — re-engage message ${reAfterLast.length+1} of ${cfg.reengage_max} is scheduled.`,
      next, steps:stepRows(null), cycle:new Date(lastCust).toISOString()};
  }
  if(pendingTemplate) return out('waiting_template', 'template_pending', `Follow-up ${pendingTemplate} is waiting for its WhatsApp template to be approved.`, {steps:stepRows(null)});
  return out('completed', 'ladder_done', ladderSent.size?'All follow-ups sent — no reply yet.':'No follow-up could go out in this silence window (24h session closed or steps not set).', {steps:stepRows(null)});
}

// Plain-language reason + what to do about it, for the report's "Who isn't getting follow-ups".
export const FV3_REASON_INFO={
  due:{label:'Being followed up now', ok:true},
  scheduled:{label:'Next follow-up scheduled', ok:true},
  reengage:{label:'Re-engage message scheduled', ok:true},
  existing_lead:{label:'Came in before Follow-up V3 was switched on', fix:'Turn on "Also follow up leads from before V3" in Settings below.', setting:'include_existing_leads'},
  template_pending:{label:'Waiting for a WhatsApp template to be approved', fix:'Day 1/3/7 follow-ups need approved templates — use "Re-check templates" below, or pick an approved template for each step.'},
  ladder_done:{label:'All follow-ups sent, or the 24-hour chat window closed before one could go', fix:'Leads silent for more than 24 hours can only get template follow-ups — make sure the Day 1/3/7 templates are approved.'},
  meeting_booked:{label:'Meeting booked or agreed', ok:true},
  human_handling:{label:'Handed to your team (handover)', fix:'Follow-ups pause while a person handles the chat. Close the handover (or resolve the chat) when your team is done so follow-ups resume.'},
  agent_replied:{label:'Your team replied last', fix:'Follow-ups wait until the customer writes again — expected.'},
  ordered:{label:'Customer placed an order', ok:true},
  won:{label:'Lead is won', ok:true}, booked:{label:'Lead booked', ok:true}, exit_stage:{label:'Reached an exit stage', ok:true},
  closed:{label:'Lead is closed / lost', ok:true}, opted_out:{label:'Opted out', ok:true},
  lead_cap:{label:'Already got the maximum follow-ups for 30 days', fix:'Raise "Max follow-ups per lead in 30 days" in Settings if you want more.'},
  no_message:{label:'Never messaged you', fix:'Follow-ups start after the customer\'s first message.'},
  account_paused:{label:'Follow-ups are paused', fix:'Press ▶ Resume.'},
  delivery_unknown:{label:'Delivery needs verification',fix:'Check send attempts below. Verify the provider conversation before allowing a retry.'},
  unknown:{label:'Not checked yet', fix:'The 15-minute sweep hasn\'t evaluated these leads yet. If this stays for more than an hour, check Settings → Logs for "followup v3 sweep".'},
};
export function fv3CoverageRows(reasonRows, cfg={}){
  return (reasonRows||[]).map(r=>{
    const key=String(r.reason||'unknown'), info=FV3_REASON_INFO[key]||{label:key};
    const fixable=!info.ok && !(info.setting && cfg?.[info.setting]===true);
    return {reason:key, n:Number(r.n)||0, label:info.label, ok:!!info.ok, fix:fixable?(info.fix||''):'', setting:fixable?(info.setting||''):''};
  }).sort((a, b)=>(a.ok-b.ok)||(b.n-a.n));
}

// Which follow-up a reply counts for: only the most recent one, and only within the window.
export function fv3AttributeReply(sends, nowMs, attributionHours){
  if(!sends?.length) return null;
  const latest=[...sends].sort((a, b)=>(ms(b.sent_at)||0)-(ms(a.sent_at)||0))[0];
  if(latest.replied_at) return null;
  if(nowMs-(ms(latest.sent_at)||0)>attributionHours*H) return null;
  return latest;
}

// Meta / send error → what to do. Codes: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
export function fv3ErrorAction(code, message=''){
  const c=Number(code)||0, m=String(message||'');
  if(c===131049) return {kind:'defer', hours:24};                     // Meta held a marketing message (frequency cap)
  if(c===131047) return {kind:'skip'};                                // 24h window closed for a session message
  if(c===131050) return {kind:'stop_marketing'};                      // customer stopped marketing messages
  if(c===131026 || c===131021) return {kind:'skip'};                  // undeliverable / not on WhatsApp
  if(c===190 || c===10 || c===200 || c===131031 || c===132000 || c===132001 || c===132015 || c===132016 || /not configured|not connected/i.test(m)) return {kind:'client_error', hours:6};
  if(/no conversation yet|no phone number/i.test(m)) return {kind:'skip'};
  return {kind:'retry'};
}
export function fv3FailureHint(code, message=''){
  const c=Number(code)||0, m=String(message||'');
  if(c===190) return {hint:'WhatsApp access token expired.', fix:'Reconnect WhatsApp in Settings → Channels.'};
  if(c===131049) return {hint:'Meta held the message to protect the customer\'s experience (marketing frequency limit).', fix:'Nothing to do — V3 retries a day later.'};
  if(c===132001 || c===132000) return {hint:'Template missing or its variables don\'t match.', fix:'Open Follow-up V3 → "Re-check templates", or pick another template for that step.'};
  if(c===131031 || c===132015 || c===132016) return {hint:'Template paused, disabled or the account is restricted.', fix:'Check WhatsApp Manager → Message templates and account quality.'};
  if(c===131050) return {hint:'Customer turned off marketing messages from your business.', fix:'Nothing to do — this lead won\'t get template follow-ups.'};
  if(c===131026) return {hint:'Message undeliverable (number not on WhatsApp or app outdated).', fix:'Check the number or reach the lead another way.'};
  if(c===131047) return {hint:'The 24-hour WhatsApp window closed before the message went out.', fix:'Nothing to do — the template steps take over.'};
  if(/not configured|not connected/i.test(m)) return {hint:'WhatsApp / Chatwoot connection missing.', fix:'Connect it in Settings → Channels.'};
  if(/no conversation yet/i.test(m)) return {hint:'Lead has no chat conversation yet.', fix:'Nothing to do.'};
  return {hint:'Send failed.', fix:'V3 retries automatically; if it keeps failing, check Settings → Channels.'};
}

// ── Template presets ─────────────────────────────────────────────────────────────────────────────
// One English set for every industry (wording stays generic so Meta approves it quickly); only the
// "interest" fallback changes per industry. Variables are never first or last in the body (Meta
// rejects that), and each ends with a STOP line the engine already understands (ENGINE_OPT_OUT_WORDS).
const INTEREST_FALLBACK={ecommerce:'the products you looked at', fashion:'the products you looked at', real_estate:'the property you asked about',
  travel:'your trip plans', hospitality:'your stay', education:'the course you asked about', higher_education:'the course you asked about',
  healthcare:'your appointment', ev_charging:'your EV charging enquiry'};
export function fv3InterestFallback(industry){ return INTEREST_FALLBACK[industry]||'your enquiry'; }
export const FV3_TEMPLATE_KINDS=['s3', 's4', 's5', 'reengage'];
const TEMPLATE_BODIES={
  s3:'Hi {{1}}, this is {{2}}. Just checking in about {{3}} — do you have any questions we can help with? Reply here and we will get back to you right away. Reply STOP to opt out.',
  s4:'Hello {{1}}, your request about {{3}} is still open with {{2}}. Would you like us to share the latest details or options? Just reply to this message. Reply STOP to opt out.',
  s5:'Hi {{1}}, one last note from {{2}}. If {{3}} is still on your mind, reply YES and our team will help you today. If now is not a good time, no worries at all. Reply STOP to opt out.',
  reengage:'Hi {{1}}, it has been a while since we last spoke at {{2}}. We have some new updates you may like. Reply to this message and we will share them with you. Reply STOP to opt out.',
};
const TEMPLATE_PARAMS={s3:['name', 'business', 'interest'], s4:['name', 'interest', 'business'], s5:['name', 'business', 'interest'], reengage:['name', 'business']};
export function fv3TemplatePreset(kind, {industry='', businessName='Our team'}={}){
  const body=TEMPLATE_BODIES[kind]; if(!body) return null;
  const params=TEMPLATE_PARAMS[kind];
  const sample={name:'Asha', business:String(businessName||'Our team').slice(0, 40), interest:fv3InterestFallback(industry)};
  return {kind, body, params, category:'MARKETING', language:'en', example:params.map(p=>sample[p])};
}
export function fv3TemplateName(kind, attempt=1){ return `lv_followup_${kind}`+(attempt>1?`_v${attempt}`:''); }
function cleanParam(v, fallback){ const t=String(v||'').replace(/\s+/g, ' ').trim().slice(0, 60); return t||fallback; }
export function fv3TemplateParams(params, lead, c, industry){
  const first=String(lead?.Name||'').trim().split(/\s+/)[0];
  const values={name:cleanParam(first, 'there'), business:cleanParam(c?.client_name, 'our team'), interest:cleanParam(lead?.InterestedProduct, fv3InterestFallback(industry))};
  return (params||[]).map(p=>values[p]??'');
}

// Session-step presets (nudges 1-2), {name}/{product}/{business} filled at send time.
export const FV3_SESSION_PRESETS={
  1:{a:'Hi {name}, just checking in — did you get everything you needed? Happy to help with any questions 😊',
     b:'Hi {name}, anything else you\'d like to know about {product}? Just reply here and I\'ll help right away.'},
  2:{a:'Hi {name}, quick follow-up on {product}. Would you like me to share more details or the next steps?',
     b:'Hi {name}, still thinking it over? Tell me what matters most to you and I\'ll point you to the best option.'},
};

// ── Report (pure) ───────────────────────────────────────────────────────────────────────────────
const pct=(a, b)=>b?Math.round(a/b*1000)/10:0;
export function fv3BuildReport(rows, {tz='Asia/Kolkata', now=Date.now(), weeks=8, ladder={}}={}){
  const totals={sent:0, replied:0, converted:0, revenue:0, opted_out:0, leads:new Set(), reengaged:new Set()};
  const steps={};
  const heat=Array.from({length:7}, ()=>Array(24).fill(0));
  const weekStart=(t)=>{ const d=new Date(t); const day=(d.getUTCDay()+6)%7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()-day); };
  const thisWeek=weekStart(now);
  const trend=[]; for(let i=weeks-1; i>=0; i--) trend.push({week_start:new Date(thisWeek-i*7*D).toISOString().slice(0, 10), sent:0, replied:0, converted:0});
  for(const r of rows||[]){
    const sentMs=ms(r.sent_at); if(!sentMs) continue;
    const st=Number(r.step), key=(r.kind==='reengage'||st===REENGAGE_STEP)?REENGAGE_STEP:st;
    const s=steps[key]||(steps[key]={step:key, label:fv3StepLabel(key, ladder[key]), sent:0, replied:0, converted:0, revenue:0, opted_out:0, variants:{}});
    const v=s.variants[r.variant||'A']||(s.variants[r.variant||'A']={variant:r.variant||'A', sent:0, replied:0});
    s.sent++; v.sent++; totals.sent++; totals.leads.add(r.lead_id);
    if(r.replied_at){ s.replied++; v.replied++; totals.replied++; totals.reengaged.add(r.lead_id);
      const rp=fv3LocalParts(ms(r.replied_at)||sentMs, tz); heat[rp.dow][rp.hour]++; }
    if(r.converted_at){ s.converted++; totals.converted++; const rev=Number(r.revenue)||0; s.revenue+=rev; totals.revenue+=rev; }
    if(r.opted_out_at){ s.opted_out++; totals.opted_out++; }
    const w=trend.find(x=>x.week_start===new Date(weekStart(sentMs)).toISOString().slice(0, 10));
    if(w){ w.sent++; if(r.replied_at) w.replied++; if(r.converted_at) w.converted++; }
  }
  const stepList=Object.values(steps).sort((a, b)=>a.step-b.step).map(s=>{
    const optRate=pct(s.opted_out, s.sent);
    return {...s, reply_rate:pct(s.replied, s.sent), conversion_rate:pct(s.converted, s.sent), opt_out_rate:optRate,
      health:s.sent<10?'new':optRate>5?'bad':optRate>2?'watch':'good',
      variants:Object.values(s.variants).map(v=>({...v, reply_rate:pct(v.replied, v.sent)})).sort((a, b)=>a.variant.localeCompare(b.variant))};
  });
  let best=null; heat.forEach((row, d)=>row.forEach((n, h)=>{ if(n>0 && (!best || n>best.replies)) best={dow:d, hour:h, replies:n}; }));
  return {
    totals:{sent:totals.sent, replied:totals.replied, reply_rate:pct(totals.replied, totals.sent), converted:totals.converted,
      revenue:Math.round(totals.revenue*100)/100, opted_out:totals.opted_out, opt_out_rate:pct(totals.opted_out, totals.sent),
      leads_contacted:totals.leads.size, leads_reengaged:totals.reengaged.size},
    steps:stepList, trend, heatmap:heat, best_slot:best,
  };
}

// ── Storage ──────────────────────────────────────────────────────────────────────────────────────
const SCHEMA=[
  `CREATE TABLE IF NOT EXISTS followup_v3_jobs (client_id INTEGER NOT NULL, lead_id INTEGER NOT NULL, cycle TEXT NOT NULL, step INTEGER NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(client_id,lead_id,cycle,step))`,
  `CREATE TABLE IF NOT EXISTS followup_v3_settings (client_id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, enabled_at TEXT, config TEXT NOT NULL DEFAULT '{}', industry TEXT NOT NULL DEFAULT '', maint_at TEXT, last_digest_at TEXT, last_setup TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS followup_v3_leads (lead_id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', next_step INTEGER, next_due_at TEXT, lead_name TEXT NOT NULL DEFAULT '', skip_json TEXT NOT NULL DEFAULT '{}', defer_until TEXT, retries INTEGER NOT NULL DEFAULT 0, hours_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_followup_v3_leads_client ON followup_v3_leads(client_id, next_due_at)`,
  `CREATE TABLE IF NOT EXISTS followup_v3_templates (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'en', status TEXT NOT NULL DEFAULT 'PENDING', params TEXT NOT NULL DEFAULT '[]', attempt INTEGER NOT NULL DEFAULT 1, error TEXT NOT NULL DEFAULT '', submitted_at TEXT NOT NULL, checked_at TEXT)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_followup_v3_templates_kind ON followup_v3_templates(client_id, kind)`,
  `CREATE TABLE IF NOT EXISTS followup_sends (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, lead_id INTEGER NOT NULL, step INTEGER NOT NULL, variant TEXT NOT NULL, sent_at TEXT NOT NULL, replied_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS followup_send_failures (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, lead_id INTEGER NOT NULL, step INTEGER NOT NULL, error_message TEXT NOT NULL DEFAULT '', error_code INTEGER, source TEXT NOT NULL DEFAULT 'cron', failed_at TEXT NOT NULL)`,
];
const SEND_COLUMNS=[
  `ALTER TABLE followup_sends ADD COLUMN v3 INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE followup_sends ADD COLUMN kind TEXT NOT NULL DEFAULT 'ladder'`,
  `ALTER TABLE followup_sends ADD COLUMN lead_name TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE followup_sends ADD COLUMN converted_at TEXT`,
  `ALTER TABLE followup_sends ADD COLUMN revenue REAL`,
  `ALTER TABLE followup_sends ADD COLUMN opted_out_at TEXT`,
  `ALTER TABLE followup_v3_settings ADD COLUMN sweep_lock_until TEXT`,
  `ALTER TABLE followup_v3_settings ADD COLUMN last_run_at TEXT`,
  `ALTER TABLE followup_v3_settings ADD COLUMN last_success_at TEXT`,
  `ALTER TABLE followup_v3_settings ADD COLUMN last_check_at TEXT`,
  `ALTER TABLE followup_v3_settings ADD COLUMN last_error TEXT`,
  `ALTER TABLE followup_v3_settings ADD COLUMN last_result TEXT`,
  `ALTER TABLE followup_sends ADD COLUMN provider_message_id TEXT`,
  `ALTER TABLE followup_sends ADD COLUMN delivery_status TEXT DEFAULT 'accepted'`,
  `ALTER TABLE followup_sends ADD COLUMN delivered_at TEXT`,
  `ALTER TABLE followup_sends ADD COLUMN read_at TEXT`,
  `ALTER TABLE followup_sends ADD COLUMN delivery_error TEXT`,
];
const schemaReady=new WeakMap();
export async function fv3EnsureSchema(env){
  if(!env?.DB) return false;
  let p=schemaReady.get(env.DB);
  if(!p){
    p=(async()=>{
      for(const sql of SCHEMA) await env.DB.prepare(sql).run();
      for(const sql of SEND_COLUMNS){ try{ await env.DB.prepare(sql).run(); }catch(e){ if(!/duplicate column/i.test(String(e?.message))) throw e; } }
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_followup_sends_client_sent ON followup_sends(client_id, sent_at)`).run();
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_followup_sends_provider ON followup_sends(provider_message_id)`).run();
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_followup_v3_jobs_status ON followup_v3_jobs(client_id,status)`).run();
      return true;
    })().catch(()=>{ schemaReady.delete(env.DB); return false; });
    schemaReady.set(env.DB, p);
  }
  return p;
}

export async function fv3GetSettings(env, clientId){
  if(!await fv3EnsureSchema(env)) return null;
  const row=await env.DB.prepare(`SELECT * FROM followup_v3_settings WHERE client_id=?`).bind(Number(clientId)).first().catch(()=>null);
  if(!row) return {client_id:Number(clientId), enabled:false, enabled_at:null, cfg:fv3Config({}), industry:'', row:null};
  let lastSetup={}; try{ lastSetup=JSON.parse(row.last_setup||'{}'); }catch(e){}
  return {client_id:row.client_id, enabled:!!row.enabled, enabled_at:row.enabled_at, cfg:fv3Config(row.config), industry:row.industry||'', last_setup:lastSetup, row};
}
// Cheap check used by the classic cron, the Durable Object and the engine webhook.
export async function fv3IsEnabled(env, clientId){
  try{
    if(!env?.DB || !Number(clientId)) return false;
    const row=await env.DB.prepare(`SELECT enabled FROM followup_v3_settings WHERE client_id=?`).bind(Number(clientId)).first();
    return !!row?.enabled;
  }catch(e){ return false; } // table not created yet → V3 has never been switched on
}
export async function fv3SaveSettings(env, clientId, {enabled, config, industry}={}){
  await fv3EnsureSchema(env);
  const cur=await fv3GetSettings(env, clientId);
  const now=new Date().toISOString();
  const nextEnabled=enabled===undefined?cur.enabled:!!enabled;
  const nextCfg=config===undefined?cur.cfg:fv3Config({...cur.cfg, ...config});
  const enabledAt=cur.enabled_at||(nextEnabled?now:null);
  await env.DB.prepare(`INSERT INTO followup_v3_settings (client_id, enabled, enabled_at, config, industry, updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(client_id) DO UPDATE SET enabled=excluded.enabled, enabled_at=excluded.enabled_at, config=excluded.config, industry=excluded.industry, updated_at=excluded.updated_at`)
    .bind(Number(clientId), nextEnabled?1:0, enabledAt, JSON.stringify(nextCfg), String(industry??cur.industry??''), now).run();
  return {...cur, enabled:nextEnabled, enabled_at:enabledAt, cfg:nextCfg, industry:String(industry??cur.industry??'')};
}

function clientTz(c){
  try{ const b=typeof c?.bot_config==='string'?JSON.parse(c.bot_config||'{}'):(c?.bot_config||{}); return b?.timezone||'Asia/Kolkata'; }
  catch(e){ return 'Asia/Kolkata'; }
}
async function ladderRows(env, clientId){
  const {results}=await env.DB.prepare(`SELECT * FROM followup_ladder_steps WHERE client_id=?`).bind(Number(clientId)).all().catch(()=>({results:[]}));
  const steps={}; (results||[]).forEach(r=>{ steps[r.step]=r; });
  return steps;
}
async function templateRows(env, clientId){
  const {results}=await env.DB.prepare(`SELECT * FROM followup_v3_templates WHERE client_id=?`).bind(Number(clientId)).all().catch(()=>({results:[]}));
  return results||[];
}
function reengageTemplate(templates){ return templates.find(t=>t.kind==='reengage' && t.status==='APPROVED')||null; }

// ── Setup: seed the ladder, submit / poll / attach templates ─────────────────────────────────────
async function ensureLadderTable(env){
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS followup_ladder_steps (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, step INTEGER NOT NULL, type TEXT NOT NULL, hours INTEGER, days INTEGER, message TEXT NOT NULL DEFAULT '', template_name TEXT NOT NULL DEFAULT '', template_language TEXT NOT NULL DEFAULT 'en_US', template_category TEXT NOT NULL DEFAULT 'MARKETING', template_body_vars INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`).run();
  await env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_followup_ladder_steps_unique ON followup_ladder_steps(client_id, step)`).run();
  for(const sql of [
    `ALTER TABLE followup_ladder_steps ADD COLUMN message_b TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE followup_ladder_steps ADD COLUMN template_name_b TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE followup_ladder_steps ADD COLUMN template_language_b TEXT NOT NULL DEFAULT 'en_US'`,
    `ALTER TABLE followup_ladder_steps ADD COLUMN template_category_b TEXT NOT NULL DEFAULT 'MARKETING'`,
    `ALTER TABLE followup_ladder_steps ADD COLUMN template_body_vars_b INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE followup_ladder_steps ADD COLUMN ai_mode INTEGER NOT NULL DEFAULT 0`,
  ]) await env.DB.prepare(sql).run().catch(()=>null);
}
async function aiVariantB(env, deps, c, messageA){
  if(!deps.ai) return null;
  const sys=`You write WhatsApp follow-up messages for "${c?.client_name||'a business'}". Rewrite the message below with a different angle (e.g. a helpful question instead of a check-in). Keep it to 1-2 short, friendly sentences, keep the {name} placeholder exactly as written, no quotes, no greeting like "Dear".`;
  const out=await deps.ai(env, c, sys, messageA, {temperature:0.8, maxOutputTokens:120, caller:'followup-v3-variant'}).catch(()=>null);
  const t=String(out||'').trim().replace(/^["']|["']$/g, '');
  return t && t.length<=400 && /\{name\}/i.test(t) ? t : null;
}
async function graph(url, opts){
  const r=await fetch(url, opts);
  const data=await r.json().catch(()=>({}));
  return {ok:r.ok, status:r.status, data};
}
async function submitTemplate(env, creds, clientId, kind, preset, attempt){
  const name=fv3TemplateName(kind, attempt);
  const now=new Date().toISOString();
  const res=await graph(`https://graph.facebook.com/v21.0/${creds.waba_id}/message_templates`, {
    method:'POST', headers:{Authorization:`Bearer ${creds.wa_token}`, 'Content-Type':'application/json'},
    body:JSON.stringify({name, category:preset.category, language:preset.language,
      components:[{type:'BODY', text:preset.body, example:{body_text:[preset.example]}}]}),
  });
  const exists=/already exists|2388023|2388024/i.test(JSON.stringify(res.data?.error||{}));
  const status=res.ok?String(res.data?.status||'PENDING').toUpperCase():(exists?'PENDING':'ERROR');
  const error=res.ok||exists?'':String(res.data?.error?.error_user_msg||res.data?.error?.message||('HTTP '+res.status)).slice(0, 300);
  await env.DB.prepare(`INSERT INTO followup_v3_templates (client_id, kind, name, language, status, params, attempt, error, submitted_at, checked_at) VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(client_id, kind) DO UPDATE SET name=excluded.name, language=excluded.language, status=excluded.status, params=excluded.params, attempt=excluded.attempt, error=excluded.error, submitted_at=excluded.submitted_at, checked_at=excluded.checked_at`)
    .bind(Number(clientId), kind, name, preset.language, status, JSON.stringify(preset.params), attempt, error, now, now).run();
  return {kind, name, status, error};
}
export async function pollTemplate(env, creds, t){
  const res=await graph(`https://graph.facebook.com/v21.0/${creds.waba_id}/message_templates?name=${encodeURIComponent(t.name)}&fields=name,status,language,rejected_reason&limit=20`, {headers:{Authorization:`Bearer ${creds.wa_token}`}});
  if(!res.ok) throw new Error('Template verification failed: HTTP '+res.status);
  const hit=(res.data?.data||[]).find(x=>x.name===t.name && (!x.language || x.language===t.language));
  if(!hit) return {...t,status:'NOT_FOUND',error:'Template not found for this WhatsApp account/language'};
  const status=String(hit.status||t.status).toUpperCase();
  const error=status==='REJECTED'?String(hit.rejected_reason||'Rejected by Meta').slice(0, 300):'';
  if(t.id) await env.DB.prepare(`UPDATE followup_v3_templates SET status=?, error=?, checked_at=? WHERE id=?`).bind(status, error, new Date().toISOString(), t.id).run();
  return {...t, status, error};
}
async function attachTemplate(env, clientId, step, t){
  const params=(()=>{ try{ return JSON.parse(t.params||'[]'); }catch(e){ return []; } })();
  const now=new Date().toISOString();
  const row=await env.DB.prepare(`SELECT template_name FROM followup_ladder_steps WHERE client_id=? AND step=?`).bind(Number(clientId), step).first();
  if(!row){
    await env.DB.prepare(`INSERT INTO followup_ladder_steps (client_id, step, type, hours, days, message, template_name, template_language, template_category, template_body_vars, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(Number(clientId), step, 'template', TEMPLATE_THRESHOLD[step], null, '', t.name, t.language, 'MARKETING', params.length, now).run();
    return true;
  }
  if(String(row.template_name||'').trim()) return false; // the merchant picked their own — keep it
  await env.DB.prepare(`UPDATE followup_ladder_steps SET template_name=?, template_language=?, template_category='MARKETING', template_body_vars=?, updated_at=? WHERE client_id=? AND step=?`)
    .bind(t.name, t.language, params.length, now, Number(clientId), step).run();
  return true;
}

// Idempotent: safe to run on every switch-on, from the "Re-check" button, and hourly from the cron.
export async function fv3Setup(env, deps, c, settings, {resubmit=false}={}){
  await fv3EnsureSchema(env); await ensureLadderTable(env);
  const cid=Number(c.Id), cfg=settings.cfg, now=new Date().toISOString();
  const report={session:{}, templates:{}, whatsapp:'connected', chatwoot:!!(c.chatwoot_base&&c.chatwoot_account_id&&c.chatwoot_token)};
  const steps=await ladderRows(env, cid);
  // Nudges 1-2: keep whatever the merchant wrote; fill only what's empty.
  for(const s of [1, 2]){
    const row=steps[s], preset=FV3_SESSION_PRESETS[s];
    if(!row){
      const b=cfg.ai_variant_b?(await aiVariantB(env, deps, c, preset.a))||preset.b:'';
      await env.DB.prepare(`INSERT INTO followup_ladder_steps (client_id, step, type, hours, days, message, message_b, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
        .bind(cid, s, 'session', SESSION_THRESHOLD_DEFAULT[s], null, preset.a, b, now).run();
      report.session[s]='created';
    } else {
      const fill={};
      if(!String(row.message||'').trim() && !row.ai_mode) fill.message=preset.a;
      if(cfg.ai_variant_b && !String(row.message_b||'').trim()) fill.message_b=(await aiVariantB(env, deps, c, fill.message||row.message||preset.a))||preset.b;
      const keys=Object.keys(fill);
      if(keys.length){
        await env.DB.prepare(`UPDATE followup_ladder_steps SET ${keys.map(k=>k+'=?').join(', ')}, updated_at=? WHERE client_id=? AND step=?`).bind(...keys.map(k=>fill[k]), now, cid, s).run();
        report.session[s]='filled';
      } else report.session[s]='kept';
    }
  }
  for(const s of [3, 4, 5]) if(!steps[s]){
    await env.DB.prepare(`INSERT INTO followup_ladder_steps (client_id, step, type, hours, days, message, updated_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(cid, s, 'template', TEMPLATE_THRESHOLD[s], null, '', now).run().catch(()=>null);
  }
  const fresh=await ladderRows(env, cid);
  const creds=deps.metaCreds?.(c)||null;
  if(!creds?.waba_id || !creds?.wa_token){ report.whatsapp='not_connected'; }
  else if(cfg.auto_templates){
    const existing=await templateRows(env, cid);
    for(const kind of FV3_TEMPLATE_KINDS){
      const step=kind==='reengage'?null:Number(kind.slice(1));
      let t=existing.find(x=>x.kind===kind);
      const ownTemplate=step && String(fresh[step]?.template_name||'').trim() && (!t || fresh[step].template_name!==t.name);
      if(ownTemplate){ report.templates[kind]={status:'OWN', name:fresh[step].template_name}; continue; }
      const preset=fv3TemplatePreset(kind, {industry:c.industry||settings.industry, businessName:c.client_name});
      try{
        if(!t){ await submitTemplate(env, creds, cid, kind, preset, 1); t=await env.DB.prepare(`SELECT * FROM followup_v3_templates WHERE client_id=? AND kind=?`).bind(cid, kind).first(); }
        else if((t.status==='REJECTED'||t.status==='ERROR') && resubmit){ await submitTemplate(env, creds, cid, kind, preset, (t.attempt||1)+1); t=await env.DB.prepare(`SELECT * FROM followup_v3_templates WHERE client_id=? AND kind=?`).bind(cid, kind).first(); }
        else if(t.status!=='ERROR' && t.status!=='REJECTED') t=await pollTemplate(env, creds, t);
        if(t.status==='APPROVED' && step) await attachTemplate(env, cid, step, t);
      }catch(e){ deps.reportOpsError?.(env, 'followup v3 template '+kind, e, {clientId:cid}); }
      report.templates[kind]={status:t?.status||'ERROR', name:t?.name||'', error:t?.error||''};
    }
  }
  await env.DB.prepare(`UPDATE followup_v3_settings SET maint_at=?, last_setup=?, industry=? WHERE client_id=?`).bind(now, JSON.stringify(report), String(c.industry||settings.industry||''), cid).run().catch(()=>null);
  return report;
}

// ── Checklist shown on the settings card ─────────────────────────────────────────────────────────
async function checklist(env, deps, c, settings){
  const steps=await ladderRows(env, c.Id);
  const templates=await templateRows(env, c.Id);
  const creds=deps.metaCreds?.(c)||null;
  const items=[];
  items.push({key:'chatwoot', ok:!!(c.chatwoot_base&&c.chatwoot_account_id&&c.chatwoot_token), label:'WhatsApp chat connected (nudges 1-2)'});
  items.push({key:'whatsapp_api', ok:!!(creds?.waba_id&&creds?.wa_token), label:'WhatsApp Cloud API connected (templates, day 1/3/7)'});
  for(const s of [1, 2]) items.push({key:'step'+s, ok:!!(steps[s]&&(String(steps[s].message||'').trim()||steps[s].ai_mode)), label:`Nudge ${s} message`+(steps[s]?.message_b?' (A/B)':'')});
  for(const s of [3, 4, 5]){
    const name=String(steps[s]?.template_name||'').trim();
    const t=templates.find(x=>x.kind==='s'+s);
    const status=name?(t?.name===name?t.status:'UNVERIFIED'):(t?.status||'NOT_SUBMITTED');
    items.push({key:'step'+s, ok:!!name && status==='APPROVED', status, template:name||t?.name||'', error:t?.error||'', label:`Day ${s===3?1:s===4?3:7} template`});
  }
  const re=templates.find(x=>x.kind==='reengage');
  items.push({key:'reengage', ok:re?.status==='APPROVED', status:re?.status||'NOT_SUBMITTED', template:re?.name||'', error:re?.error||'', label:'Re-engage template', optional:!settings.cfg.reengage_enabled});
  return items;
}

// ── Inbound hook (engine webhook) ────────────────────────────────────────────────────────────────
// Returns true when V3 handled reply tracking for this client (so the classic "credit every open
// send" UPDATE is skipped).
export async function fv3OnInbound(env, c, leadId, {optOut=false, at=Date.now()}={}){
  if(!leadId || !await fv3IsEnabled(env, c?.Id)) return false;
  const settings=await fv3GetSettings(env, c.Id);
  const nowIso=new Date(at).toISOString();
  try{
    const {results}=await env.DB.prepare(`SELECT id, sent_at, replied_at FROM followup_sends WHERE lead_id=? ORDER BY sent_at DESC LIMIT 1`).bind(Number(leadId)).all();
    const hit=fv3AttributeReply(results||[], at, settings.cfg.attribution_hours);
    if(hit) await env.DB.prepare(`UPDATE followup_sends SET replied_at=? WHERE id=?`).bind(nowIso, hit.id).run();
    if(optOut && results?.[0] && at-(ms(results[0].sent_at)||0)<7*D)
      await env.DB.prepare(`UPDATE followup_sends SET opted_out_at=? WHERE id=? AND opted_out_at IS NULL`).bind(nowIso, results[0].id).run();
    const hour=fv3LocalParts(at, clientTz(c)).hour;
    const st=await env.DB.prepare(`SELECT hours_json FROM followup_v3_leads WHERE lead_id=?`).bind(Number(leadId)).first();
    let hours={}; try{ hours=JSON.parse(st?.hours_json||'{}')||{}; }catch(e){}
    hours[hour]=(Number(hours[hour])||0)+1;
    await env.DB.prepare(`INSERT INTO followup_v3_leads (lead_id, client_id, hours_json, retries, defer_until, updated_at) VALUES (?,?,?,0,NULL,?)
      ON CONFLICT(lead_id) DO UPDATE SET hours_json=excluded.hours_json, retries=0, defer_until=NULL, updated_at=excluded.updated_at`)
      .bind(Number(leadId), Number(c.Id), JSON.stringify(hours), nowIso).run();
  }catch(e){ /* best-effort — never break the live reply path */ }
  return true;
}

// ── Sweep (every 15 min) ─────────────────────────────────────────────────────────────────────────
const LEAD_FIELDS=['Id', 'Name', 'Phone', 'Stage', 'Handover', 'OptOut', 'LastMsgAt', 'LastCustomerMsgAt', 'LastAgentMsgAt', 'Date', 'CreatedAt', 'Language',
  'ConversationID', 'conv_id', 'ConversationId', 'chatwoot_conv_id', 'InboxId', 'InterestedProduct', 'LastObjectionCategory', 'DealValue',
  'Follow up 1', 'Follow up 2', 'Follow up 3', 'Follow up 4', 'Follow up 5'];
const digits10=(p)=>String(p||'').replace(/\D/g, '').slice(-10);
// NocoDB refuses a whole read when `fields` names a column the table doesn't have, and most of
// LEAD_FIELDS are optional (conv_id, DealValue, LastObjectionCategory… exist only on some bases).
// Couplo, Oct 2026: one missing column made every sweep read fail, so no lead was ever evaluated
// (351 leads "unknown", 0 in a sequence). Ask only for the columns this table has.
export function fv3LeadFields(existing){
  if(!Array.isArray(existing) || !existing.length) return LEAD_FIELDS;
  const have=new Set(existing);
  return LEAD_FIELDS.filter(f=>f==='Id' || have.has(f));
}
// An order ends the sequence only if it was placed around or after this conversation (latest order
// on or after the day before the customer's last message) — an order from months ago doesn't.
export function fv3OrderCounts(order, lead){
  if(!order) return false;
  const placed=ms(order.date), lastCust=fv3LastCustomerMs(lead)||0;
  return placed===null ? true : placed>=lastCust-D;
}

async function objectionText(env, deps, c, lead){
  const cat=String(lead.LastObjectionCategory||'').trim(); if(!cat) return null;
  const entry=(deps.objectionPlaybook?.(c)||[]).find(o=>String(o.category||'').toLowerCase()===cat.toLowerCase());
  const approved=String(entry?.approved_response||'').trim(); if(!approved) return null;
  const sys=`You write one short WhatsApp follow-up for "${c.client_name||'us'}" to ${lead.Name||'a customer'}, who hesitated because of: ${cat}. Use this approved answer as the substance: "${approved}". 1-2 friendly sentences, end with a light question, no "Dear", no quotes.`;
  const ai=await deps.ai?.(env, c, sys, '(write it now)', {temperature:0.6, maxOutputTokens:140, caller:'followup-v3-objection'}).catch(()=>null);
  const t=String(ai||'').trim();
  return t || `Hi ${String(lead.Name||'').split(' ')[0]||'there'}, ${approved}`.slice(0, 600);
}

async function logFailure(env, cid, leadId, step, e){
  const code=Number(e?.code)||Number(String(e?.message||'').match(/\b(1\d{5}|190|100)\b/)?.[0])||null;
  const msg=String(e?.message||e||'').slice(0, 500);
  const dup=await env.DB.prepare(`SELECT id FROM followup_send_failures WHERE client_id=? AND lead_id=? AND step=? AND source='v3' AND COALESCE(error_code,0)=? AND failed_at>=? LIMIT 1`)
    .bind(cid, Number(leadId), step, code||0, new Date(Date.now()-D).toISOString()).first().catch(()=>null);
  if(dup) return code;
  await env.DB.prepare(`INSERT INTO followup_send_failures (client_id, lead_id, step, error_message, error_code, source, failed_at) VALUES (?,?,?,?,?,?,?)`)
    .bind(cid, Number(leadId), step, msg, code, 'v3', new Date().toISOString()).run().catch(()=>null);
  return code;
}

export async function fv3ProcessClient(env, deps, c, settings, {now=Date.now(), preview=false}={}){
  const cid=Number(c.Id), cfg=settings.cfg, tz=clientTz(c);
  if(!preview && (!settings.row?.maint_at || now-(ms(settings.row.maint_at)||0)>H)) await fv3Setup(env, deps, c, settings).catch(e=>deps.reportOpsError?.(env, 'followup v3 setup', e, {clientId:cid}));
  if(!preview && cfg.weekly_digest) await fv3MaybeDigest(env, deps, c, settings, now).catch(()=>null);
  if(cfg.paused && !preview) return {sent:0, checked:0, paused:true};
  const steps=await ladderRows(env, cid);
  const templates=await templateRows(env, cid);
  const tplByName={}; templates.forEach(t=>{ tplByName[t.name]=t; });
  const reTpl=reengageTemplate(templates);
  const {results:sendRows}=await env.DB.prepare(`SELECT id, lead_id, step, kind, variant, sent_at, replied_at, converted_at FROM followup_sends WHERE client_id=? AND sent_at>=?`)
    .bind(cid, new Date(now-200*D).toISOString()).all();
  const sendsByLead={}; (sendRows||[]).forEach(r=>{ (sendsByLead[r.lead_id]||(sendsByLead[r.lead_id]=[])).push(r); });
  const {results:stateRows}=await env.DB.prepare(`SELECT * FROM followup_v3_leads WHERE client_id=?`).bind(cid).all();
  const stateByLead={}; (stateRows||[]).forEach(r=>{ stateByLead[r.lead_id]=r; });
  const {results:held}=await env.DB.prepare(`SELECT lead_id FROM followup_v3_jobs WHERE client_id=? AND status IN ('sending','uncertain')`).bind(cid).all();
  for(const r of held||[]) stateByLead[r.lead_id]={...stateByLead[r.lead_id],delivery_hold:true};
  let orders=null, ordersLoaded=false;
  const getOrders=async()=>{ if(!ordersLoaded){ ordersLoaded=true; orders=cfg.exit_on_order&&deps.orderPhones?await deps.orderPhones(env, c):null; } return orders; };
  if(!preview) await deps.ensureLeadsColumns?.(env, ['LastCustomerMsgAt', 'LastAgentMsgAt', 'InterestedProduct', 'Follow up 4', 'Follow up 5']).catch(()=>null);
  const where=`(ClientId,eq,${cid})`;
  const fields=fv3LeadFields(await deps.leadColumns?.(env).catch(()=>null));
  const meetingLeads=await deps.meetingLeadIds?.(env, cid)||new Set();
  const due=[];
  const stateWrites=[]; let checked=0; const reasons={}; const sample=[];
  for(let page=1; page<=30; page++){
    const r=await deps.ncFetch(env, `api/v2/tables/${deps.leadsTable}/records?where=${encodeURIComponent(where)}&limit=200&offset=${(page-1)*200}&fields=${encodeURIComponent(fields.join(','))}`);
    if(!r.ok){
      const detail=await r.text().catch(()=>'');
      throw new Error(`leads read failed (NocoDB ${r.status}) ${detail.slice(0, 300)}`);
    }
    const data=await r.json();
    if(!Array.isArray(data?.list)) throw new Error('Invalid leads response: list missing');
    const list=data.list;
    for(const lead of list){
      const sends=sendsByLead[lead.Id]||[];
      const state=stateByLead[lead.Id]||null;
      // Only look up orders for leads it can matter for (ecom, and either due or recently followed up).
      const recent=sends.some(s=>(ms(s.sent_at)||0)>now-CONVERSION_WINDOW_DAYS*D);
      const hasOrder=lead.Phone?fv3OrderCounts((await getOrders())?.[digits10(lead.Phone)], lead):false;
      const d=fv3Decide({lead, steps, cfg, state, sends, enabledAt:settings.enabled_at, now, tz, hasOrder, reengageReady:!!reTpl, hasMeeting:meetingLeads.has(Number(lead.Id))});
      checked++; reasons[d.reason]=(reasons[d.reason]||0)+1;
      if(sample.length<100) sample.push({lead_id:lead.Id,name:lead.Name,status:d.status,reason:d.reason,next:d.next});
      if(!preview && d.status==='goal_reached' && recent) stateWrites.push(markConversion(env, cid, lead, sends, now, hasOrder?orders?.[digits10(lead.Phone)]:null));
      const nextStep=d.next?.step??null, nextDue=d.next?.due_at??null;
      if(!preview && (!state || state.status!==d.status || state.reason!==d.reason || (state.next_step??null)!==nextStep || (state.next_due_at??null)!==nextDue || (state.lead_name||'')!==String(lead.Name||''))){
        stateWrites.push(env.DB.prepare(`INSERT INTO followup_v3_leads (lead_id, client_id, status, reason, next_step, next_due_at, lead_name, updated_at) VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(lead_id) DO UPDATE SET status=excluded.status, reason=excluded.reason, next_step=excluded.next_step, next_due_at=excluded.next_due_at, lead_name=excluded.lead_name, updated_at=excluded.updated_at`)
          .bind(Number(lead.Id), cid, d.status, d.reason, nextStep, nextDue, String(lead.Name||'').slice(0, 120), new Date(now).toISOString()).run());
      }
      if(d.status==='due') due.push({lead, d, state});
    }
    const writes=await Promise.allSettled(stateWrites.splice(0));
    const failedWrite=writes.find(r=>r.status==='rejected');
    if(failedWrite) throw failedWrite.reason;
    if(list.length<200) break;
    if(page===30) throw new Error('Lead scan exceeds 6000 records; split this account into batches before sending');
  }
  await Promise.all(stateWrites);
  const summary={checked,due:due.length,reasons,sample};
  if(preview) return {sent:0,preview:true,...summary};
  if(!due.length) return {sent:0,...summary};
  // Daily cap (lower during the warm-up week).
  const warm=settings.enabled_at && now-(ms(settings.enabled_at)||0)<cfg.warmup_days*D;
  const cap=warm?Math.min(cfg.warmup_cap, cfg.daily_cap):cfg.daily_cap;
  const sent24=(await env.DB.prepare(`SELECT COUNT(*) n FROM followup_sends WHERE client_id=? AND v3=1 AND sent_at>=?`).bind(cid, new Date(now-D).toISOString()).first())?.n||0;
  let budget=Math.max(0, cap-sent24);
  due.sort((a, b)=>(ms(a.d.next.due_at)||0)-(ms(b.d.next.due_at)||0));
  let sent=0, failed=0, clientBroken=false;
  const batch=due.slice(0, Math.min(budget,50));
  for(let i=0; i<batch.length && !clientBroken; i+=5){
    const outcomes=await Promise.allSettled(batch.slice(i, i+5).map(async ({lead, d, state})=>{
      if(clientBroken) return;
      const step=d.next.step;
      const liveR=await deps.ncFetch(env, `api/v2/tables/${deps.leadsTable}/records/${Number(lead.Id)}`);
      if(!liveR.ok) throw new Error('Pre-send lead refresh failed: '+liveR.status);
      const live=await liveR.json();
      if(String(live.ClientId)!==String(cid)) throw new Error('Pre-send lead ownership mismatch');
      const latestSettings=await fv3GetSettings(env,cid);
      if(!latestSettings?.enabled || latestSettings.cfg.paused) return;
      const latest=fv3Decide({lead:live,steps,cfg:latestSettings.cfg,state,sends:sendsByLead[lead.Id]||[],enabledAt:settings.enabled_at,now:Date.now(),tz,hasOrder:cfg.exit_on_order&&deps.orderPhones?fv3OrderCounts((await deps.orderPhones(env,c,{fresh:true}))?.[digits10(live.Phone)],live):false,hasMeeting:!!(await deps.leadHasMeeting?.(env,cid,lead.Id)),reengageReady:!!reTpl});
      if(latest.status!=='due' || latest.cycle!==d.cycle || latest.next.step!==step) return;
      lead=live;
      const leadSteps=fv3StepsForLead(steps,latestSettings.cfg,lead);
      const stepCfg=step===REENGAGE_STEP
        ? {step, type:'template', template_name:reTpl.name, template_language:reTpl.language, template_category:'MARKETING', template_body_vars:JSON.parse(reTpl.params||'[]').length}
        : leadSteps[step];
      const selectedVariant=stepCfg.type==='template'&&deps.chooseVariant?await deps.chooseVariant(env,c.Id,step,stepCfg):'A';
      const selectedTemplate=selectedVariant==='B'&&stepCfg.template_name_b?{name:stepCfg.template_name_b,language:stepCfg.template_language_b||stepCfg.template_language}:{name:stepCfg.template_name,language:stepCfg.template_language};
      const opts={selectedVariant:stepCfg.type==='template'?selectedVariant:undefined,v3:true, kind:d.next.kind, leadName:String(lead.Name||'').slice(0, 120), creds:deps.metaCreds?.(c, lead)||null};
      if(stepCfg.type==='template'){
        const t=tplByName[selectedTemplate.name];
        if(t){ let params=[]; try{ params=JSON.parse(t.params||'[]'); }catch(e){} opts.templateParams=fv3TemplateParams(params, lead, c, c.industry||settings.industry); }
      } else {
        opts.fill={product:String(lead.InterestedProduct||'').trim()||fv3InterestFallback(c.industry||settings.industry), business:c.client_name||'us'};
        if(cfg.objection_branching){ const t=await objectionText(env, deps, c, lead).catch(()=>null); if(t){ opts.overrideText=t; opts.variant='OBJ'; opts.kind='objection'; } }
      }
      let claimed=false;
      const jobCycle=step===REENGAGE_STEP?d.next.due_at:d.cycle;
      try{
        if(stepCfg.type==='template'){
          const creds=opts.creds;
          if(!creds?.waba_id || !creds?.wa_token) throw new Error('WhatsApp API credentials missing');
          const verified=await pollTemplate(env,creds,{name:selectedTemplate.name,language:selectedTemplate.language||'en_US',status:'UNKNOWN'});
          if(verified.status!=='APPROVED') throw new Error('Template not approved: '+verified.status);
        }
        const claim=await env.DB.prepare(`INSERT INTO followup_v3_jobs (client_id,lead_id,cycle,step,status,updated_at) VALUES (?,?,?,?,'sending',?) ON CONFLICT(client_id,lead_id,cycle,step) DO UPDATE SET status='sending',updated_at=excluded.updated_at WHERE followup_v3_jobs.status='retry'`)
          .bind(cid,Number(lead.Id),jobCycle,step,new Date().toISOString()).run();
        if(!claim?.meta?.changes) return;
        claimed=true;
        await deps.sendStep(env, c, lead, step, stepCfg, opts);
        await env.DB.prepare(`UPDATE followup_v3_jobs SET status='accepted',updated_at=? WHERE client_id=? AND lead_id=? AND cycle=? AND step=?`).bind(new Date().toISOString(),cid,Number(lead.Id),jobCycle,step).run();
        sent++;
        if(state?.retries || state?.defer_until) await env.DB.prepare(`UPDATE followup_v3_leads SET retries=0, defer_until=NULL WHERE lead_id=?`).bind(Number(lead.Id)).run().catch(()=>null);
      }catch(e){
        failed++;
        const code=await logFailure(env, cid, lead.Id, step, e);
        const act=fv3ErrorAction(code, e?.message);
        // A timeout may mean the provider accepted it. Never retry an ambiguous send automatically.
        if(claimed) await env.DB.prepare(`UPDATE followup_v3_jobs SET status=?,updated_at=? WHERE client_id=? AND lead_id=? AND cycle=? AND step=?`)
          .bind(e?.definiteFailure?'retry':'uncertain',new Date().toISOString(),cid,Number(lead.Id),jobCycle,step).run();
        const retries=(Number(state?.retries)||0)+1;
        const skip=parseSkip(state); const cycle=d.cycle;
        const addSkip=(...ss)=>{ const base=skip.cycle===cycle?(skip.steps||[]):[]; return JSON.stringify({cycle, steps:[...new Set([...base, ...ss])]}); };
        let deferUntil=null, skipJson=null, newRetries=retries;
        if(act.kind==='defer') deferUntil=new Date(now+act.hours*H).toISOString();
        else if(act.kind==='skip') { skipJson=addSkip(step); newRetries=0; }
        else if(act.kind==='stop_marketing') { skipJson=addSkip(3, 4, 5, REENGAGE_STEP); newRetries=0; deferUntil=new Date(now+30*D).toISOString(); }
        else if(act.kind==='client_error'){ clientBroken=true; deferUntil=new Date(now+act.hours*H).toISOString(); }
        else if(retries>=3){ skipJson=addSkip(step); newRetries=0; }
        else deferUntil=new Date(now+15*60000*Math.pow(2, retries)).toISOString();
        await env.DB.prepare(`UPDATE followup_v3_leads SET retries=?, defer_until=?, skip_json=COALESCE(?, skip_json), updated_at=? WHERE lead_id=?`)
          .bind(newRetries, deferUntil, skipJson, new Date(now).toISOString(), Number(lead.Id)).run().catch(()=>null);
      }
    }));
    const rejected=outcomes.find(r=>r.status==='rejected');
    if(rejected) throw rejected.reason;
  }
  return {sent,failed,...summary,budget};
}

async function markConversion(env, cid, lead, sends, now, order){
  if(sends.some(s=>s.converted_at && (ms(s.converted_at)||0)>now-30*D)) return;
  const credit=[...sends].filter(s=>s.replied_at && (ms(s.sent_at)||0)>now-CONVERSION_WINDOW_DAYS*D).sort((a, b)=>(ms(b.sent_at)||0)-(ms(a.sent_at)||0))[0];
  if(!credit) return;
  const revenue=Number(lead.DealValue)||Number(order?.total)||null;
  await env.DB.prepare(`UPDATE followup_sends SET converted_at=?, revenue=? WHERE id=? AND converted_at IS NULL`).bind(new Date(now).toISOString(), revenue, credit.id).run().catch(()=>null);
}

// One sweep per account at a time: the 15-minute cron and "run now" (someone opened Leads) would
// otherwise read the same due list and send a lead the same follow-up twice. The lock frees itself
// after SWEEP_LOCK_MS if a run dies; `minGapMs` keeps repeated Leads opens from re-running it.
const SWEEP_LOCK_MS=10*60000;
export const FV3_RUN_NOW_GAP_MS=2*60000;
export async function fv3RunClient(env, deps, c, settings, {now=Date.now(), minGapMs=0}={}){
  const cid=Number(c.Id), iso=(t)=>new Date(t).toISOString();
  const got=await env.DB.prepare(`UPDATE followup_v3_settings SET sweep_lock_until=?, last_run_at=? WHERE client_id=? AND enabled=1
    AND (sweep_lock_until IS NULL OR sweep_lock_until<?) AND (last_run_at IS NULL OR last_run_at<?)`)
    .bind(iso(now+SWEEP_LOCK_MS), iso(now), cid, iso(now), iso(now-minGapMs)).run();
  if(!(got?.meta?.changes>0)) return {sent:0, skipped:'recent'};
  try{
    const result=await fv3ProcessClient(env,deps,c,settings,{now});
    await env.DB.prepare(`UPDATE followup_v3_settings SET last_success_at=?,last_error=NULL,last_result=? WHERE client_id=?`).bind(new Date().toISOString(),JSON.stringify({...result,sample:undefined}),cid).run();
    return result;
  }catch(e){
    await env.DB.prepare(`UPDATE followup_v3_settings SET last_error=? WHERE client_id=?`).bind(String(e.message||e).slice(0,1000),cid).run();
    throw e;
  }
  finally{
    await env.DB.prepare(`UPDATE followup_v3_settings SET sweep_lock_until=NULL WHERE client_id=? AND sweep_lock_until=?`).bind(cid,iso(now+SWEEP_LOCK_MS)).run();
    await fv3Schedule(env,cid);
  }
}

export async function fv3RunForAllClients(env, deps){
  if(!await fv3EnsureSchema(env)) return;
  const {results}=await env.DB.prepare(`SELECT client_id FROM followup_v3_settings WHERE enabled=1`).all().catch(()=>({results:[]}));
  for(const row of results||[]){
    try{
      const c=await deps.getClientById(env, row.client_id);
      if(!c || c.active==='No') continue;
      const settings=await fv3GetSettings(env, row.client_id);
      if(!settings?.enabled) continue;
      if(env.FOLLOWUP_SCHEDULER) await fv3Schedule(env,row.client_id);
      else await fv3RunClient(env, deps, c, settings);
    }catch(e){ await deps.reportOpsError?.(env, 'followup v3 sweep', e, {clientId:row.client_id}); }
  }
}

// ── Weekly digest (Monday morning, client's own timezone) ────────────────────────────────────────
async function fv3MaybeDigest(env, deps, c, settings, now){
  const tz=clientTz(c); const {hour, dow}=fv3LocalParts(now, tz);
  if(dow!==1 || hour<9 || hour>=12) return;
  if(settings.row?.last_digest_at && now-(ms(settings.row.last_digest_at)||0)<6*D) return;
  await env.DB.prepare(`UPDATE followup_v3_settings SET last_digest_at=? WHERE client_id=?`).bind(new Date(now).toISOString(), Number(c.Id)).run();
  const to=String(c.authentik_email||'').trim(); if(!to || !deps.sendEmail) return;
  const {results}=await env.DB.prepare(`SELECT * FROM followup_sends WHERE client_id=? AND sent_at>=?`).bind(Number(c.Id), new Date(now-7*D).toISOString()).all();
  const rep=fv3BuildReport(results||[], {tz, now, weeks:1});
  if(!rep.totals.sent) return;
  const t=rep.totals, cur=c.deal_currency||'';
  const best=rep.steps.filter(s=>s.sent>=5).sort((a, b)=>b.reply_rate-a.reply_rate)[0];
  const html=`<div style="font-family:system-ui,sans-serif;max-width:520px">
    <h2 style="margin:0 0 6px">Your follow-ups this week</h2>
    <p style="color:#555;margin:0 0 14px">${esc(c.client_name||'')} · Follow-up V3</p>
    <p style="font-size:16px;line-height:1.5">Follow-ups re-engaged <b>${t.leads_reengaged}</b> lead${t.leads_reengaged===1?'':'s'}
      (${t.reply_rate}% reply rate on ${t.sent} messages)${t.converted?`, and <b>${t.converted}</b> of them converted${t.revenue?` — <b>${esc(cur)} ${t.revenue.toLocaleString('en-IN')}</b> recovered`:''}`:''}.</p>
    ${best?`<p>Best step: <b>${esc(best.label)}</b> at ${best.reply_rate}% replies.</p>`:''}
    ${t.opt_out_rate>2?`<p style="color:#b45309">Opt-outs are at ${t.opt_out_rate}% — consider softer wording on the steps marked "watch".</p>`:''}
    <p style="color:#777;font-size:12px">Full report: 🔁 Follow-ups → Overview in Leadvyne. Turn this email off in the same place.</p></div>`;
  await deps.sendEmail(env, to, `Follow-ups re-engaged ${t.leads_reengaged} lead${t.leads_reengaged===1?'':'s'} this week`, html).catch(()=>null);
}
function esc(s){ return String(s??'').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// ── Lead status (lead card + Chats) ──────────────────────────────────────────────────────────────
export async function fv3LeadStatus(env, deps, c, lead, {now=Date.now()}={}){
  const settings=await fv3GetSettings(env, c.Id);
  if(!settings?.enabled) return {enabled:false};
  const steps=await ladderRows(env, c.Id);
  const templates=await templateRows(env, c.Id);
  const {results:sends}=await env.DB.prepare(`SELECT id, step, kind, variant, sent_at, replied_at, converted_at, opted_out_at, delivery_status, delivered_at, read_at, delivery_error FROM followup_sends WHERE lead_id=? ORDER BY sent_at DESC LIMIT 50`).bind(Number(lead.Id)).all();
  let state=await env.DB.prepare(`SELECT * FROM followup_v3_leads WHERE lead_id=? AND client_id=?`).bind(Number(lead.Id),Number(c.Id)).first();
  const held=await env.DB.prepare(`SELECT lead_id FROM followup_v3_jobs WHERE client_id=? AND lead_id=? AND status IN ('sending','uncertain') LIMIT 1`).bind(Number(c.Id),Number(lead.Id)).first();
  if(held) state={...state,delivery_hold:true};
  let hasOrder=false;
  if(settings.cfg.exit_on_order && deps.orderPhones && lead.Phone){
    const o=await deps.orderPhones(env, c);
    hasOrder=fv3OrderCounts(o?.[digits10(lead.Phone)], lead);
  }
  const hasMeeting=!!(await deps.leadHasMeeting?.(env, c.Id, lead.Id).catch(()=>false));
  const d=fv3Decide({lead, steps, cfg:settings.cfg, state, sends:sends||[], enabledAt:settings.enabled_at, now, tz:clientTz(c), hasOrder, reengageReady:!!reengageTemplate(templates), hasMeeting});
  const lastFail=await env.DB.prepare(`SELECT error_message, error_code, failed_at, step FROM followup_send_failures WHERE lead_id=? AND failed_at>=? ORDER BY failed_at DESC LIMIT 1`)
    .bind(Number(lead.Id), new Date(now-3*D).toISOString()).first().catch(()=>null);
  return {enabled:true, ...d,
    paused:settings.cfg.paused,
    defer_until:state?.defer_until||null,
    last_failure:lastFail?{...lastFail, ...fv3FailureHint(lastFail.error_code, lastFail.error_message)}:null,
    history:(sends||[]).slice(0, 12).map(s=>({step:s.step, kind:s.kind||'ladder', label:fv3StepLabel(Number(s.step)), variant:s.variant, sent_at:s.sent_at, replied_at:s.replied_at, converted_at:s.converted_at, opted_out_at:s.opted_out_at,delivery_status:s.delivery_status,delivered_at:s.delivered_at,read_at:s.read_at,delivery_error:s.delivery_error}))};
}

// One alarm owner per tenant; D1 holds each lead's next action. Cron only repairs missing alarms.
export async function fv3Schedule(env,cid){
  if(!env.FOLLOWUP_SCHEDULER) return;
  const stub=env.FOLLOWUP_SCHEDULER.get(env.FOLLOWUP_SCHEDULER.idFromName(String(cid)));
  const response=await stub.fetch('https://followups.internal/schedule',{method:'POST',body:JSON.stringify({cid:Number(cid)})});
  if(!response.ok) throw new Error('Follow-up alarm scheduling failed');
}

export function fv3Health(settings, now=Date.now()){
  const row=settings.row||{};
  let result={}; try{ result=JSON.parse(row.last_result||'{}'); }catch{}
  const status=!settings.enabled?'disabled':settings.cfg.paused?'paused':row.last_error||result.failed?'failed':!row.last_success_at||now-(ms(row.last_success_at)||0)>30*60000?'delayed':'healthy';
  return {status,last_attempt_at:row.last_run_at||null,last_success_at:row.last_success_at||null,last_check_at:row.last_check_at||null,error:row.last_error||(result.failed?result.failed+' send attempts failed; see send problems below':null),checked:result.checked||0,due:result.due||0,sent:result.sent||0,budget:result.budget??null};
}

// Signed Meta delivery callbacks are routed before the authenticated dashboard API.
export async function fv3DeliveryStatus(env, body){
  if(!await fv3EnsureSchema(env)) throw new Error('Follow-up storage unavailable');
  for(const entry of body.entry||[]) for(const change of entry.changes||[]) for(const st of change.value?.statuses||[]){
    if(!['sent','delivered','read','failed'].includes(st.status)||!st.id) continue;
    const at=new Date(Number(st.timestamp)*1000); if(!Number.isFinite(at.getTime())) continue;
    const status=st.status==='sent'?'accepted':st.status;
    await env.DB.prepare(`UPDATE followup_sends SET delivery_status=CASE WHEN delivery_status='read' THEN 'read' WHEN delivery_status='delivered' AND ?='accepted' THEN 'delivered' ELSE ? END, delivered_at=CASE WHEN ? IN ('delivered','read') THEN COALESCE(delivered_at,?) ELSE delivered_at END,read_at=CASE WHEN ?='read' THEN COALESCE(read_at,?) ELSE read_at END,delivery_error=CASE WHEN ?='failed' THEN ? ELSE delivery_error END WHERE provider_message_id=?`)
      .bind(status,status,status,at.toISOString(),status,at.toISOString(),status,JSON.stringify(st.errors||[]).slice(0,1000),st.id).run();
  }
}

// ── Routes: /followups/v3/* ──────────────────────────────────────────────────────────────────────
export async function fv3HandleRoute(request, env, deps, url){
  const {json}=deps;
  const payload=await deps.requireSession(request, env);
  if(!payload) return json({error:'Invalid or expired session'}, 401);
  if(!await fv3EnsureSchema(env)) return json({error:'Storage unavailable'}, 503);
  const cid=Number(payload.cid);
  const c=await deps.getClientById(env, cid);
  if(!c) return json({error:'Client not found'}, 404);
  const path=url.pathname.replace(/^\/followups\/v3/, '');
  const method=request.method;

  if(path==='/settings' && method==='GET'){
    const s=await fv3GetSettings(env, cid);
    return json({enabled:s.enabled, enabled_at:s.enabled_at, config:s.cfg, health:fv3Health(s), defaults:FV3_DEFAULTS, last_setup:s.last_setup||{}, checklist:s.enabled?await checklist(env, deps, c, s):[]});
  }
  if(path==='/settings' && method==='POST'){
    const body=await request.json().catch(()=>({}));
    const before=await fv3GetSettings(env, cid);
    const s=await fv3SaveSettings(env, cid, {enabled:body.enabled, config:body.config, industry:c.industry||''});
    let setup=null;
    if(s.enabled && !before.enabled) setup=await fv3Setup(env, deps, c, s).catch(e=>({error:e.message}));
    await fv3Schedule(env,cid);
    return json({ok:true, health:fv3Health(await fv3GetSettings(env,cid)), enabled:s.enabled, enabled_at:s.enabled_at, config:s.cfg, setup, checklist:s.enabled?await checklist(env, deps, c, s):[]});
  }
  if(path==='/setup' && method==='POST'){
    const s=await fv3GetSettings(env, cid);
    if(!s.enabled) return json({error:'Switch Follow-up V3 on first.'}, 400);
    const body=await request.json().catch(()=>({}));
    const setup=await fv3Setup(env, deps, c, s, {resubmit:!!body.resubmit});
    return json({ok:true, setup, checklist:await checklist(env, deps, c, s)});
  }
  // Leads page opened → send whatever is already due now instead of waiting for the next
  // 15-minute tick. At most once every FV3_RUN_NOW_GAP_MS per account, never alongside the cron.
  if(path==='/attempts' && method==='GET'){
    const {results}=await env.DB.prepare(`SELECT lead_id,cycle,step,status,updated_at FROM followup_v3_jobs WHERE client_id=? AND status IN ('sending','uncertain') ORDER BY updated_at DESC LIMIT 100`).bind(cid).all();
    return json({list:results||[]});
  }
  if(path==='/attempts/resolve' && method==='POST'){
    const b=await request.json();
    if(!['sent','not_sent'].includes(b.outcome)) return json({error:'Verify whether the provider sent this message first'},400);
    const job=await env.DB.prepare(`SELECT * FROM followup_v3_jobs WHERE client_id=? AND lead_id=? AND cycle=? AND step=?`).bind(cid,Number(b.lead_id),String(b.cycle),Number(b.step)).first();
    if(!job || !['sending','uncertain'].includes(job.status)) return json({error:'Attempt not awaiting verification'},409);
    if(Date.now()-(ms(job.updated_at)||0)<SWEEP_LOCK_MS) return json({error:'Wait 10 minutes for the in-progress send to settle before verifying'},409);
    if(b.outcome==='sent'){
      // Recover the send ledger if the provider accepted a message but persistence failed.
      const logged=await env.DB.prepare(`SELECT id FROM followup_sends WHERE client_id=? AND lead_id=? AND step=? AND sent_at>=? LIMIT 1`).bind(cid,job.lead_id,job.step,new Date((ms(job.updated_at)||0)-5*60000).toISOString()).first();
      if(!logged) await env.DB.prepare(`INSERT INTO followup_sends (client_id,lead_id,step,variant,sent_at,v3,kind,delivery_status) VALUES (?,?,?,'VERIFIED',?,1,?,'accepted')`).bind(cid,job.lead_id,job.step,job.updated_at,job.step===REENGAGE_STEP?'reengage':'ladder').run();
    }
    await env.DB.prepare(`UPDATE followup_v3_leads SET retries=0,defer_until=NULL WHERE client_id=? AND lead_id=?`).bind(cid,job.lead_id).run();
    await env.DB.prepare(`UPDATE followup_v3_jobs SET status=?,updated_at=? WHERE client_id=? AND lead_id=? AND cycle=? AND step=? AND status IN ('sending','uncertain')`).bind(b.outcome==='sent'?'verified_sent':'retry',new Date().toISOString(),cid,job.lead_id,job.cycle,job.step).run();
    await fv3Schedule(env,cid);
    return json({ok:true});
  }
  if(path==='/check' && method==='POST'){
    const s=await fv3GetSettings(env,cid);
    if(!s.enabled) return json({error:'Switch Follow-up V3 on first'},400);
    const result=await fv3ProcessClient(env,deps,c,s,{preview:true});
    await env.DB.prepare(`UPDATE followup_v3_settings SET last_check_at=? WHERE client_id=?`).bind(new Date().toISOString(),cid).run();
    return json(result);
  }
  if(path==='/run' && method==='POST'){
    const s=await fv3GetSettings(env, cid);
    if(!s.enabled) return json({ok:true, enabled:false});
    const r=await fv3RunClient(env, deps, c, s, {minGapMs:FV3_RUN_NOW_GAP_MS})
      .catch(e=>{ deps.reportOpsError?.(env, 'followup v3 run now', e, {clientId:cid}); return {sent:0,error:e.message||'Follow-up run failed'}; });
    return json({ok:!r.error, enabled:true, sent:r.sent||0, due:r.due||0, skipped:r.skipped||null, error:r.error||null},r.error?500:200);
  }
  if(path==='/lead' && method==='GET'){
    const leadId=Number(url.searchParams.get('lead_id'));
    if(!leadId) return json({error:'lead_id required'}, 400);
    const r=await deps.ncFetch(env, `api/v2/tables/${deps.leadsTable}/records/${leadId}`);
    if(!r.ok) return json({error:'Lead not found'}, 404);
    const lead=await r.json().catch(()=>null);
    if(!lead || String(lead.ClientId)!==String(cid)) return json({error:'Not your lead'}, 403);
    return json(await fv3LeadStatus(env, deps, c, lead));
  }
  if(path==='/lead/skip' && method==='POST'){
    const {lead_id, step}=await request.json().catch(()=>({}));
    const leadId=Number(lead_id), st=Number(step);
    if(!leadId || !(st>=1 && st<=REENGAGE_STEP)) return json({error:'lead_id and step required'}, 400);
    const r=await deps.ncFetch(env, `api/v2/tables/${deps.leadsTable}/records/${leadId}`);
    const lead=r.ok?await r.json().catch(()=>null):null;
    if(!lead || String(lead.ClientId)!==String(cid)) return json({error:'Not your lead'}, 403);
    const lastCust=fv3LastCustomerMs(lead);
    if(!lastCust) return json({error:'Nothing scheduled for this lead.'}, 400);
    const cycle=new Date(lastCust).toISOString();
    const state=await env.DB.prepare(`SELECT skip_json FROM followup_v3_leads WHERE lead_id=?`).bind(leadId).first();
    const skip=parseSkip(state);
    const stepsList=[...new Set([...(skip.cycle===cycle?(skip.steps||[]):[]), st])];
    await env.DB.prepare(`INSERT INTO followup_v3_leads (lead_id, client_id, skip_json, lead_name, updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(lead_id) DO UPDATE SET skip_json=excluded.skip_json, updated_at=excluded.updated_at`)
      .bind(leadId, cid, JSON.stringify({cycle, steps:stepsList}), String(lead.Name||'').slice(0, 120), new Date().toISOString()).run();
    return json(await fv3LeadStatus(env, deps, c, lead));
  }
  if(path==='/upcoming' && method==='GET'){
    const {results}=await env.DB.prepare(`SELECT lead_id, lead_name, status, next_step, next_due_at FROM followup_v3_leads WHERE client_id=? AND status IN ('due','scheduled') AND next_due_at IS NOT NULL AND next_due_at<=? ORDER BY next_due_at ASC LIMIT 200`)
      .bind(cid, new Date(Date.now()+D).toISOString()).all();
    return json({list:(results||[]).map(r=>({...r, label:fv3StepLabel(Number(r.next_step))}))});
  }
  if(path==='/report' && method==='GET'){
    const days=clampInt(url.searchParams.get('days'), 7, 180, 30);
    const since=new Date(Date.now()-days*D).toISOString();
    const s=await fv3GetSettings(env, cid);
    const {results:rows}=await env.DB.prepare(`SELECT step, kind, variant, sent_at, replied_at, converted_at, revenue, opted_out_at, lead_id FROM followup_sends WHERE client_id=? AND sent_at>=?`).bind(cid, since).all();
    const rep=fv3BuildReport(rows||[], {tz:clientTz(c), weeks:Math.min(12, Math.ceil(days/7)), ladder:await ladderRows(env, cid)});
    const {results:statusRows}=await env.DB.prepare(`SELECT status, COUNT(*) n FROM followup_v3_leads WHERE client_id=? GROUP BY status`).bind(cid).all();
    const statusCounts={}; (statusRows||[]).forEach(r=>{ statusCounts[r.status||'unknown']=r.n; });
    // Why leads are / aren't in a sequence right now (Couplo, Oct 2026: 97 sends in 30 days for
    // 1,005 leads) — one row per reason with the fix, so the gap is visible instead of silent.
    const {results:reasonRows}=await env.DB.prepare(`SELECT reason, COUNT(*) n FROM followup_v3_leads WHERE client_id=? GROUP BY reason`).bind(cid).all();
    const coverage=fv3CoverageRows(reasonRows||[], s.cfg);
    const {results:fails}=await env.DB.prepare(`SELECT error_code, MAX(error_message) error_message, COUNT(*) n, MAX(failed_at) last_at FROM followup_send_failures WHERE client_id=? AND failed_at>=? GROUP BY error_code ORDER BY n DESC LIMIT 10`).bind(cid, since).all();
    // Industry benchmark: average reply rate per step across other V3 accounts in the same industry
    // (anonymised; needs 3+ accounts with 20+ sends on that step).
    let benchmark=null;
    if(s.industry){
      const {results:b}=await env.DB.prepare(`SELECT fs.client_id, fs.step, COUNT(*) sent, SUM(CASE WHEN fs.replied_at IS NOT NULL THEN 1 ELSE 0 END) replied
        FROM followup_sends fs JOIN followup_v3_settings s ON s.client_id=fs.client_id
        WHERE s.industry=? AND fs.client_id!=? AND fs.v3=1 AND fs.sent_at>=? GROUP BY fs.client_id, fs.step`).bind(s.industry, cid, since).all().catch(()=>({results:[]}));
      const per={};
      (b||[]).filter(r=>r.sent>=20).forEach(r=>{ (per[r.step]||(per[r.step]=[])).push(r.replied/r.sent); });
      const out={}; Object.entries(per).forEach(([st, rates])=>{ if(rates.length>=3) out[st]=Math.round(rates.reduce((a, x)=>a+x, 0)/rates.length*1000)/10; });
      benchmark=Object.keys(out).length?{industry:s.industry, reply_rate_by_step:out}:null;
    }
    const {results:delivery}=await env.DB.prepare(`SELECT delivery_status status,COUNT(*) n FROM followup_sends WHERE client_id=? AND sent_at>=? GROUP BY delivery_status`).bind(cid,since).all();
    const uncertain=(await env.DB.prepare(`SELECT COUNT(*) n FROM followup_v3_jobs WHERE client_id=? AND status IN ('sending','uncertain')`).bind(cid).first())?.n||0;
    return json({health:fv3Health(s),delivery:delivery||[],uncertain,days, ...rep, in_sequence:(statusCounts.due||0)+(statusCounts.scheduled||0), status_counts:statusCounts, coverage,
      failures:(fails||[]).map(f=>({...f, ...fv3FailureHint(f.error_code, f.error_message)})),
      templates:(await templateRows(env, cid)).map(t=>({kind:t.kind, name:t.name, status:t.status, error:t.error})),
      benchmark, currency:c.deal_currency||''});
  }
  if(path==='/report/leads' && method==='GET'){
    const days=clampInt(url.searchParams.get('days'), 7, 180, 30);
    const step=Number(url.searchParams.get('step'));
    const outcome=String(url.searchParams.get('outcome')||'all');
    const cond={replied:'AND replied_at IS NOT NULL', ignored:'AND replied_at IS NULL', converted:'AND converted_at IS NOT NULL', opted_out:'AND opted_out_at IS NOT NULL'}[outcome]||'';
    const stepCond=step===REENGAGE_STEP?`AND (step=${REENGAGE_STEP} OR kind='reengage')`:(step>=1&&step<=5?`AND step=${step} AND kind!='reengage'`:'');
    const {results}=await env.DB.prepare(`SELECT lead_id, lead_name, step, kind, variant, sent_at, replied_at, converted_at, revenue, opted_out_at FROM followup_sends WHERE client_id=? AND sent_at>=? ${stepCond} ${cond} ORDER BY sent_at DESC LIMIT 100`)
      .bind(cid, new Date(Date.now()-days*D).toISOString()).all();
    return json({list:results||[]});
  }
  return json({error:'Not found'}, 404);
}
