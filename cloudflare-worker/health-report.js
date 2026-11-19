/* ── HEALTH REPORT — turns one run of the health checks (worker.js HEALTH_CHECKS) into the
   client's daily health report, and compares it with the reports before it.

   A check result is {key, label, category, status, detail, hint?, ms?} where status is
     ok   — passed
     warn — works, but something needs a look (a warning)
     fail — broken (an error)
     off  — not tested: not set up, or not used by this account. Never counts against the overall
            status.
   Everything here is pure (no I/O) so the report shape is easy to test; worker.js stores the
   reports in D1 (health_reports) and serves them to Settings → Integrations → Health Check. ── */

export const HEALTH_CATEGORIES=[
  {key:'integration', label:'Integration Health'},
  {key:'crm', label:'CRM Functionality'},
  {key:'chatbot', label:'AI Chatbot Health'},
  {key:'automation', label:'Automation Health'},
  {key:'database', label:'Database Health'},
];
// Older reports used these category keys — fold them into the new groups.
const CATEGORY_ALIAS={sheets:'integration', core:'automation'};
export const healthCategoryOf=r=>CATEGORY_ALIAS[r?.category]||r?.category||'integration';

export const HEALTH_STATUS_LABEL={ok:'Healthy', warn:'Needs Attention', fail:'Critical'};
const SEVERITY={fail:0, warn:1, ok:2, off:3};

export function healthOverall(results){
  const rs=results||[];
  if(rs.some(r=>r.status==='fail')) return 'fail';
  if(rs.some(r=>r.status==='warn')) return 'warn';
  return 'ok';
}

export function healthTotals(results){
  const t={total:0, passed:0, failed:0, warnings:0, not_tested:0};
  for(const r of results||[]){
    t.total++;
    if(r.status==='ok') t.passed++;
    else if(r.status==='fail') t.failed++;
    else if(r.status==='warn') t.warnings++;
    else t.not_tested++;
  }
  return t;
}

const isProblem=s=>s==='fail'||s==='warn';

/* Build the report for this run. `previous` is the list of earlier reports for the same client,
   oldest first (each as returned by buildHealthReport — only ts/status/results are read), so the
   report can say, per check:
     last_ok_at — when it last passed (this run included)
     change     — 'new' (a problem that wasn't there last run), 'recurring' (still a problem),
                  'fixed' (was a problem, passes now), or '' (no change worth showing)
     streak     — how many runs in a row (this one included) it has been a problem
   plus the recommended actions, fixed issues, and the last run where everything passed. */
export function buildHealthReport(results, {previous=[], now=new Date(), trigger='manual'}={}){
  const ts=(now instanceof Date?now:new Date(now)).toISOString();
  const prev=(previous||[]).filter(p=>p&&Array.isArray(p.results));
  const last=prev[prev.length-1]||null;
  const lastBy=Object.fromEntries((last?.results||[]).map(r=>[r.key,r]));

  const out=(results||[]).map(r=>{
    const row={...r, category:healthCategoryOf(r)};
    const was=lastBy[r.key];
    // Walk back through history: last time this check passed, and how long it's been a problem.
    let lastOk=r.status==='ok'?ts:null, streak=isProblem(r.status)?1:0, streakOpen=streak>0;
    for(let i=prev.length-1;i>=0;i--){
      const p=(prev[i].results||[]).find(x=>x.key===r.key);
      if(!lastOk&&p?.status==='ok') lastOk=prev[i].ts;
      if(streakOpen){ if(p&&isProblem(p.status)) streak++; else streakOpen=false; }
      if(lastOk&&!streakOpen) break;
    }
    if(lastOk) row.last_ok_at=lastOk;
    // A previous run's last_ok_at survives history trimming.
    else if(was?.last_ok_at) row.last_ok_at=was.last_ok_at;
    row.streak=streak;
    row.change=isProblem(r.status)
      ? (was&&isProblem(was.status)?'recurring':'new')
      : (r.status==='ok'&&was&&isProblem(was.status)?'fixed':'');
    if(was&&was.status!==r.status) row.previous_status=was.status;
    return row;
  });

  const status=healthOverall(out);
  const categories=HEALTH_CATEGORIES.map(cat=>{
    const rows=out.filter(r=>r.category===cat.key);
    // A group where nothing could be tested is "not tested", not "healthy".
    return {key:cat.key, label:cat.label, status:rows.some(r=>r.status!=='off')?healthOverall(rows):'off', totals:healthTotals(rows)};
  }).filter(c=>c.totals.total);

  // Recommended actions — errors first, then warnings; recurring ones before new ones since
  // they've been left alone the longest.
  const recommendations=out.filter(r=>isProblem(r.status))
    .sort((a,b)=>SEVERITY[a.status]-SEVERITY[b.status]||b.streak-a.streak||String(a.label).localeCompare(String(b.label)))
    .map(r=>({key:r.key, label:r.label, category:r.category, severity:r.status==='fail'?'error':'warning',
      problem:r.detail||'', action:r.hint||defaultAction(r), change:r.change, streak:r.streak}));

  const fixed=out.filter(r=>r.change==='fixed').map(r=>({key:r.key, label:r.label, was:r.previous_status}));
  const errors=out.filter(r=>r.status==='fail').map(r=>({key:r.key, label:r.label, detail:r.detail}));
  const warnings=out.filter(r=>r.status==='warn').map(r=>({key:r.key, label:r.label, detail:r.detail}));

  let lastHealthyAt=status==='ok'?ts:null;
  for(let i=prev.length-1;i>=0&&!lastHealthyAt;i--) if(healthOverall(prev[i].results)==='ok') lastHealthyAt=prev[i].ts;
  if(!lastHealthyAt&&last?.last_healthy_at) lastHealthyAt=last.last_healthy_at;

  return {ts, trigger, status, label:HEALTH_STATUS_LABEL[status], totals:healthTotals(out), categories,
    results:out, recommendations, fixed, errors, warnings, last_healthy_at:lastHealthyAt||null,
    previous_status:last?healthOverall(last.results):null};
}

function defaultAction(r){
  return r.status==='fail'
    ? `Open ${r.label} in Settings and re-check its connection details, then run the health check again.`
    : `Review ${r.label} — it works but needs a look.`;
}

/* Across a list of reports (oldest first): the issues that keep coming back. A check counts once
   per report it was a problem in; only checks that were a problem in 2+ reports are listed. Also
   says whether each is still open in the newest report. */
export function healthRecurringIssues(reports, {min=2}={}){
  const by=new Map();
  const list=(reports||[]).filter(r=>Array.isArray(r?.results));
  for(const rep of list) for(const r of rep.results){
    if(!isProblem(r.status)) continue;
    const e=by.get(r.key)||{key:r.key, label:r.label, category:healthCategoryOf(r), count:0, errors:0, first_seen:rep.ts, last_seen:rep.ts};
    e.count++; if(r.status==='fail') e.errors++;
    e.last_seen=rep.ts; e.label=r.label||e.label;
    by.set(r.key, e);
  }
  const newest=list[list.length-1];
  const openNow=new Set((newest?.results||[]).filter(r=>isProblem(r.status)).map(r=>r.key));
  return [...by.values()].filter(e=>e.count>=min)
    .map(e=>({...e, open:openNow.has(e.key), runs:list.length}))
    .sort((a,b)=>Number(b.open)-Number(a.open)||b.count-a.count||b.errors-a.errors);
}

/* Should this run alert the client? Only for errors that are new since the last run, so a problem
   that stays broken alerts once, not every day. */
export function healthCriticalAlerts(report){
  if(!report||report.status!=='fail') return [];
  return report.results.filter(r=>r.status==='fail'&&r.change==='new');
}

// Short one-line summary of a report, used in list views and alert subjects.
export function healthSummaryLine(report){
  const t=report?.totals||healthTotals(report?.results);
  return `${HEALTH_STATUS_LABEL[report?.status||healthOverall(report?.results)]} — ${t.passed} passed, ${t.failed} failed, ${t.warnings} warning(s), ${t.not_tested} not tested`;
}
