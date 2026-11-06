/* ── TRAVEL STATUS BOARD (travel workspace → 📌 Status Board) ─────────────────────────────────────
   Staff mark where each inquiry stands — First call done, Follow up pending (with a due date),
   Booking closed, Booking not done… The board shows a count per status, filters, and a row per
   inquiry with an inline status picker.
   Stored on the lead (NocoDB Leads, created on first use like every other optional lead column):
     TravelStatus        status key (TS_STATUSES below)
     TravelFollowUpAt    YYYY-MM-DD, for follow_up_pending
     TravelStatusAt/By   when / who last changed it
     TravelStatusLog     JSON history, newest first: [{at, by, from, to, fu}] — Reports → 📌 Status Changes
   An inquiry with no status yet shows "New inquiry", or "First call done (auto)" once a call is in
   its CallLog — so the board is useful before anyone has marked anything.
   Linked to the lead's pipeline Stage both ways (tsStageFor / tsStatusOf): Booking closed, Ticket
   issued and Travelled mark the lead Won; Booking not done and Cancelled mark it Lost; picking an
   open status on a won/lost lead reopens it (to the pipeline stage of the same name when there is
   one). A lead marked Won / Lost anywhere else shows Booking closed / Booking not done (auto).
   Uses dashboard.html's globals: $id, esc, allLeads, ncPatch, CONFIG, ensureLeadsField, myEmail,
   getTeamMembers, sameEmail, seesAllLeads, parseCallLog, openDetail, showToast, TODAY,
   LEAD_CATEGORIES, serviceCategoryIcon, clientId.
   Bump the ?v= on its <script> tag in dashboard.html when changing this file — sw.js serves
   scripts cache-first. ── */

// Lead origin badge/colour (dashboard.html leadOriginBadge/leadOriginClass) and a phone that
// never shows an Instagram lead's internal "ig:<id>" key.
const tsOriginBadge=l=>typeof leadOriginBadge==='function'?leadOriginBadge(l):'';
const tsOriginClass=l=>typeof leadOriginClass==='function'?leadOriginClass(l):'';
const tsLeadName=l=>(typeof leadDisplayName==='function'?leadDisplayName(l):(l.Name||l.Phone))||'Inquiry';
const tsPhone=l=>String(l?.Phone||'').startsWith('ig:')?'Instagram':(l?.Phone||'');

// [key, label, icon, colour group]. Order = the inquiry's usual journey.
const TS_STATUSES=[
  ['new','New inquiry','🆕','gray'],
  ['first_call','First call done','📞','blue'],
  ['not_reachable','Not reachable','📵','amber'],
  ['quote_sent','Quote sent','📤','blue'],
  ['follow_up_pending','Follow up pending','⏰','amber'],
  ['follow_up_done','Follow up done','✅','blue'],
  ['negotiating','Negotiating','🤝','blue'],
  ['docs_pending','Documents pending','📄','amber'],
  ['payment_pending','Payment pending','💳','amber'],
  ['booking_closed','Booking closed','🎉','green'],
  ['ticket_issued','Ticket / voucher issued','🎫','green'],
  ['travelled','Travelled','🧳','green'],
  ['booking_not_done','Booking not done','❌','red'],
  ['cancelled','Cancelled','🚫','red'],
];
const TS_BY_KEY=Object.fromEntries(TS_STATUSES.map(s=>[s[0],s]));
const TS_WON=new Set(['booking_closed','ticket_issued','travelled']);
const TS_LOST=new Set(['booking_not_done','cancelled']);
const tsStageWon=l=>l?.Stage==='won'||l?.Stage==='converted';
const tsStageLost=l=>l?.Stage==='lost';
// The pipeline Stage a travel status puts the lead in, or null to leave Stage as it is.
function tsStageFor(key, lead){
  if(TS_WON.has(key)) return tsStageWon(lead)?null:'won';
  if(TS_LOST.has(key)) return tsStageLost(lead)?null:'lost';
  let stages=[]; try{ stages=Object.keys((typeof getFlow==='function'?getFlow():{}).stages||{}); }catch(e){}
  if(stages.includes(key)) return lead?.Stage===key?null:key;
  return (tsStageWon(lead)||tsStageLost(lead))?'new':null;
}
const TS_FIELDS=['TravelStatus','TravelFollowUpAt','TravelStatusAt','TravelStatusBy',['TravelStatusLog','LongText']];
const TS_LOG_MAX=200;
const TS_PAGE_SIZE=100;

let _tsFilter={status:'',owner:'',cat:'',q:''};
let _tsShown=TS_PAGE_SIZE;
let _tsFieldsReady=false;

// The status an inquiry is shown with: what staff set, else derived from its calls.
function tsStatusOf(l){
  // The pipeline outcome wins: a lead marked Won / Lost elsewhere (Mark Won, kanban, the bot) never
  // keeps showing an open travel status.
  const k=TS_BY_KEY[l.TravelStatus]?l.TravelStatus:'';
  if(tsStageWon(l)&&!TS_WON.has(k)) return {key:'booking_closed', auto:true};
  if(tsStageLost(l)&&!TS_LOST.has(k)) return {key:'booking_not_done', auto:true};
  if(k) return {key:k, auto:false};
  let calls=[]; try{ calls=parseCallLog(l.CallLog); }catch(e){}
  return calls.length?{key:'first_call', auto:true}:{key:'new', auto:true};
}
function tsFollowUpState(l){
  if(l.TravelStatus!=='follow_up_pending'||!l.TravelFollowUpAt) return '';
  const d=String(l.TravelFollowUpAt).slice(0,10);
  return d<TODAY?'overdue':d===TODAY?'today':'later';
}

function tsInjectStyle(){
  if($id('tsStyle')) return;
  const st=document.createElement('style'); st.id='tsStyle';
  st.textContent=`
.ts-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-bottom:14px}
.ts-tile{background:var(--card);border:1.5px solid var(--line);border-radius:12px;padding:10px 12px;cursor:pointer;text-align:left;font-family:inherit;color:inherit}
.ts-tile:hover{border-color:var(--accent)}
.ts-tile.on{border-color:var(--accent);background:var(--accent-soft)}
.ts-tile .n{font-family:var(--disp);font-size:24px;font-weight:700;line-height:1.1}
.ts-tile .l{font-size:11.5px;color:var(--muted);font-weight:600;margin-top:2px}
.ts-tile.amber .n{color:#B45309}.ts-tile.green .n{color:#047857}.ts-tile.red .n{color:#B91C1C}.ts-tile.blue .n{color:var(--accent-ink)}
.ts-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
.ts-bar .form-input{max-width:220px;padding:8px 10px;font-size:13px}
.ts-tbl{width:100%;border-collapse:collapse;font-size:13px;min-width:820px}
.ts-tbl th{text-align:left;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);padding:8px 10px;border-bottom:1px solid var(--line)}
.ts-tbl td{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:middle}
.ts-tbl tr:hover td{background:var(--accent-soft)}
.ts-tbl a{color:var(--ink);text-decoration:none}.ts-tbl a:hover{color:var(--accent-ink);text-decoration:underline}
.ts-sel{font:inherit;font-size:12.5px;padding:6px 8px;border-radius:8px;border:1.5px solid var(--line);background:var(--card);color:var(--ink);max-width:210px}
.ts-sel.gray{border-color:#CBD5E1}.ts-sel.blue{border-color:#7DD3FC}.ts-sel.amber{border-color:#FBBF24;background:#FFFBEB}.ts-sel.green{border-color:#34D399;background:#ECFDF5}.ts-sel.red{border-color:#F87171;background:#FEF2F2}
.ts-auto{font-size:10.5px;color:var(--muted);margin-left:4px}
.ts-date{font:inherit;font-size:12px;padding:5px 6px;border-radius:8px;border:1.5px solid var(--line);background:var(--card);color:var(--ink)}
.ts-due{font-size:10.5px;font-weight:700;border-radius:6px;padding:2px 6px;margin-left:4px}
.ts-due.overdue{background:#FEE2E2;color:#991B1B}.ts-due.today{background:#FEF3C7;color:#92400E}
.ts-meta{font-size:11px;color:var(--muted)}
.ts-empty{color:var(--muted);text-align:center;padding:24px;font-size:13px}
.ts-inline{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:6px}
.ts-sel-inline{min-height:34px}
.ts-cat{font:inherit;font-size:12.5px;padding:6px 8px;border-radius:8px;border:1.5px solid #CBD5E1;background:var(--card);color:var(--ink);max-width:210px;min-height:34px}
.ts-cat.set{border-color:#7DD3FC}
.ts-chip{display:inline-block;font-size:11.5px;font-weight:600;border-radius:999px;padding:3px 9px;white-space:nowrap;border:1px solid var(--line)}
.ts-chip.gray{background:#F1F5F9;color:#475569}.ts-chip.blue{background:#E0F2FE;color:#075985}.ts-chip.amber{background:#FEF3C7;color:#92400E}.ts-chip.green{background:#DCFCE7;color:#166534}.ts-chip.red{background:#FEE2E2;color:#991B1B}
.ts-rpt-tbl{width:100%;min-width:720px}
/* ── Status Board v2: group cards, one status-chip row, rows that become cards on a phone,
   and a status picker (popover on PC, bottom sheet on a phone). Colour tokens follow dark mode. */
#pageTvstatus,.tsb-sheet{--tsg-bg:#F1F5F9;--tsg-fg:#475569;--tsg-bd:#CBD5E1;--tsb-bg:#E0F2FE;--tsb-fg:#075985;--tsb-bd:#7DD3FC;
  --tsa-bg:#FEF3C7;--tsa-fg:#92400E;--tsa-bd:#FBBF24;--tsn-bg:#DCFCE7;--tsn-fg:#166534;--tsn-bd:#34D399;--tsr-bg:#FEE2E2;--tsr-fg:#991B1B;--tsr-bd:#F87171}
html.dark #pageTvstatus,html.dark .tsb-sheet{--tsg-bg:#1E293B;--tsg-fg:#CBD5E1;--tsg-bd:#334155;--tsb-bg:#0C2A3F;--tsb-fg:#7DD3FC;--tsb-bd:#0369A1;
  --tsa-bg:#3A2A12;--tsa-fg:#FCD34D;--tsa-bd:#B45309;--tsn-bg:#0F2E22;--tsn-fg:#6EE7B7;--tsn-bd:#047857;--tsr-bg:#3B1416;--tsr-fg:#FCA5A5;--tsr-bd:#B91C1C}
@media(prefers-color-scheme:dark){html:not(.light):not(.dark) #pageTvstatus,html:not(.light):not(.dark) .tsb-sheet{--tsg-bg:#1E293B;--tsg-fg:#CBD5E1;--tsg-bd:#334155;--tsb-bg:#0C2A3F;--tsb-fg:#7DD3FC;--tsb-bd:#0369A1;
  --tsa-bg:#3A2A12;--tsa-fg:#FCD34D;--tsa-bd:#B45309;--tsn-bg:#0F2E22;--tsn-fg:#6EE7B7;--tsn-bd:#047857;--tsr-bg:#3B1416;--tsr-fg:#FCA5A5;--tsr-bd:#B91C1C}}
.tsb-c-gray{--c-bg:var(--tsg-bg);--c-fg:var(--tsg-fg);--c-bd:var(--tsg-bd)}.tsb-c-blue{--c-bg:var(--tsb-bg);--c-fg:var(--tsb-fg);--c-bd:var(--tsb-bd)}
.tsb-c-amber{--c-bg:var(--tsa-bg);--c-fg:var(--tsa-fg);--c-bd:var(--tsa-bd)}.tsb-c-green{--c-bg:var(--tsn-bg);--c-fg:var(--tsn-fg);--c-bd:var(--tsn-bd)}.tsb-c-red{--c-bg:var(--tsr-bg);--c-fg:var(--tsr-fg);--c-bd:var(--tsr-bd)}
.tsb-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.tsb-head h2{font-family:var(--disp);font-size:20px;margin:0;line-height:1.2}
.tsb-sub{font-size:12.5px;color:var(--muted);margin-top:3px}
.tsb-search{position:relative;flex:1;max-width:340px;min-width:200px}
.tsb-search input{width:100%;box-sizing:border-box;font:inherit;font-size:14px;padding:10px 12px 10px 34px;border-radius:10px;border:1.5px solid var(--line);background:var(--card);color:var(--ink)}
.tsb-search input:focus{outline:none;border-color:var(--accent)}
.tsb-search span{position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--muted);pointer-events:none}
.tsb-groups{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin-bottom:12px}
.tsb-group{display:flex;flex-direction:column;align-items:flex-start;gap:2px;text-align:left;font:inherit;color:inherit;cursor:pointer;background:var(--card);border:1.5px solid var(--line);border-radius:12px;padding:11px 13px;transition:border-color .15s,box-shadow .15s}
.tsb-group:hover{border-color:var(--c-bd,var(--accent))}
.tsb-group.on{border-color:var(--c-bd,var(--accent));background:var(--c-bg,var(--accent-soft));box-shadow:0 0 0 2px var(--c-bd,var(--accent)) inset}
.tsb-group .n{font-family:var(--disp);font-size:24px;font-weight:700;line-height:1.1;color:var(--c-fg,var(--ink))}
.tsb-group .l{font-size:12px;font-weight:600;color:var(--muted)}
.tsb-group.alert .n{color:var(--tsr-fg)}
.tsb-chips{display:flex;gap:6px;overflow-x:auto;padding:2px 2px 8px;margin-bottom:6px;scrollbar-width:thin;-webkit-overflow-scrolling:touch}
.tsb-chip{flex:none;display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12.5px;font-weight:600;white-space:nowrap;cursor:pointer;border-radius:999px;padding:6px 11px;border:1.5px solid var(--line);background:var(--card);color:var(--ink)}
.tsb-chip .c{font-size:11px;font-weight:700;border-radius:999px;padding:1px 7px;background:var(--c-bg,var(--tsg-bg));color:var(--c-fg,var(--tsg-fg))}
.tsb-chip.on{background:var(--c-bg,var(--accent-soft));border-color:var(--c-bd,var(--accent));color:var(--c-fg,var(--ink))}
.tsb-chip.on .c{background:var(--card)}
.tsb-chip.zero{opacity:.55}
.tsb-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
.tsb-bar select{font:inherit;font-size:13px;padding:8px 10px;border-radius:10px;border:1.5px solid var(--line);background:var(--card);color:var(--ink);min-height:38px}
.tsb-bar .ts-meta{margin-left:auto}
.tsb-clear{font:inherit;font-size:12.5px;background:none;border:none;color:var(--accent-ink);cursor:pointer;text-decoration:underline;padding:6px}
.tsb-list{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.tsb-cols,.tsb-row{display:grid;grid-template-columns:minmax(190px,2.2fr) minmax(130px,1.1fr) var(--tsb-staff,minmax(100px,.9fr)) minmax(170px,1.3fr) minmax(120px,1fr) minmax(90px,.8fr) 76px;gap:12px;align-items:center;padding:10px 14px}
.tsb-list.nostaff .tsb-cols,.tsb-list.nostaff .tsb-row{grid-template-columns:minmax(190px,2.2fr) minmax(130px,1.1fr) minmax(170px,1.3fr) minmax(120px,1fr) minmax(90px,.8fr) 76px}
.tsb-cols{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);border-bottom:1px solid var(--line);padding-top:9px;padding-bottom:9px}
.tsb-row{border-bottom:1px solid var(--line);font-size:13px;border-left:3px solid var(--c-bd,transparent)}
.tsb-row:last-child{border-bottom:none}
.tsb-row:hover{background:var(--accent-soft)}
.tsb-who{display:flex;gap:10px;align-items:center;min-width:0;cursor:pointer}
.tsb-av{flex:none;width:34px;height:34px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:700;background:var(--c-bg);color:var(--c-fg)}
.tsb-who b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tsb-who .ts-meta{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tsb-who>div{min-width:0}
.tsb-pill{display:inline-flex;align-items:center;gap:6px;max-width:100%;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;border-radius:999px;padding:6px 10px 6px 11px;border:1.5px solid var(--c-bd);background:var(--c-bg);color:var(--c-fg);min-height:34px}
.tsb-pill .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tsb-pill .car{opacity:.7;font-size:10px}
.tsb-pill:focus-visible,.tsb-chip:focus-visible,.tsb-group:focus-visible,.tsb-opt:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.tsb-fu{font:inherit;font-size:12px;font-weight:600;cursor:pointer;border-radius:8px;padding:5px 9px;border:1.5px dashed var(--line);background:none;color:var(--ink);white-space:nowrap}
.tsb-fu.overdue{border:1.5px solid var(--tsr-bd);background:var(--tsr-bg);color:var(--tsr-fg)}
.tsb-fu.today{border:1.5px solid var(--tsa-bd);background:var(--tsa-bg);color:var(--tsa-fg)}
.tsb-acts{display:flex;gap:6px;justify-content:flex-end}
.tsb-row .ts-cat{width:100%;max-width:100%;min-height:34px;box-sizing:border-box}
.tsb-row>div{min-width:0}
.tsb-row .staff{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tsb-pill .t{flex:1;text-align:left}
.tsb-ic{width:32px;height:32px;display:grid;place-items:center;border-radius:9px;border:1px solid var(--line);background:var(--card);color:var(--ink);text-decoration:none;font-size:15px;cursor:pointer}
.tsb-ic:hover{border-color:var(--accent)}
.tsb-lbl{display:none}
.tsb-more{text-align:center;padding:12px}
.tsb-empty{color:var(--muted);text-align:center;padding:36px 16px;font-size:13.5px}
.tsb-empty b{display:block;font-size:28px;margin-bottom:6px}
/* Picker */
.tsb-back{position:fixed;inset:0;z-index:1200;background:transparent}
.tsb-sheet{position:fixed;z-index:1201;background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow-md,0 8px 30px rgba(0,0,0,.18));width:300px;max-height:min(70vh,520px);overflow:auto;padding:8px}
.tsb-sheet.list{width:480px}
.tsb-cols2{display:grid;grid-template-columns:1fr 1fr;gap:4px}
.tsb-sheet h4{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:8px 8px 4px}
.tsb-sheet .grab,.tsb-sheet .ttl{display:none}
.tsb-opt{display:flex;align-items:center;gap:10px;width:100%;text-align:left;font:inherit;font-size:13.5px;cursor:pointer;border:none;background:none;color:var(--ink);border-radius:9px;padding:8px 9px}
.tsb-opt:hover{background:var(--accent-soft)}
.tsb-opt .dot{width:10px;height:10px;border-radius:50%;background:var(--c-bd);flex:none}
.tsb-opt .ck{margin-left:auto;color:var(--accent);font-weight:700}
.tsb-opt.cur{background:var(--c-bg);color:var(--c-fg);font-weight:600}
.tsb-dates{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:6px}
.tsb-dates button{font:inherit;font-size:13px;font-weight:600;cursor:pointer;border-radius:10px;padding:10px;border:1.5px solid var(--line);background:var(--card);color:var(--ink)}
.tsb-dates button:hover{border-color:var(--accent)}
.tsb-dates small{display:block;font-weight:500;color:var(--muted);font-size:11px;margin-top:2px}
.tsb-custom{display:flex;gap:8px;padding:6px}
.tsb-custom input{flex:1;font:inherit;font-size:14px;padding:9px;border-radius:10px;border:1.5px solid var(--line);background:var(--card);color:var(--ink)}
.tsb-custom button{font:inherit;font-weight:600;border:none;border-radius:10px;padding:0 14px;background:var(--accent);color:#fff;cursor:pointer}
.tsb-backlink{font:inherit;font-size:12.5px;background:none;border:none;color:var(--accent-ink);cursor:pointer;padding:6px 8px}
@media(max-width:1023px){.tsb-groups{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(max-width:767px){
  .tsb-head h2{font-size:18px}.tsb-search{max-width:none;min-width:100%}
  .tsb-search input{font-size:16px}
  .tsb-groups{display:flex;overflow-x:auto;gap:8px;padding-bottom:4px;-webkit-overflow-scrolling:touch;scrollbar-width:none}
  .tsb-groups::-webkit-scrollbar,.tsb-chips::-webkit-scrollbar{display:none}
  .tsb-group{flex:none;min-width:92px;padding:9px 12px}.tsb-group .n{font-size:20px}.tsb-group .l{font-size:11px;white-space:nowrap}
  .tsb-chip{padding:8px 12px;font-size:13px}
  .tsb-bar select{flex:1;min-width:0;font-size:15px;min-height:42px}.tsb-bar .ts-meta{width:100%;margin-left:0}
  .tsb-list{background:none;border:none;border-radius:0;overflow:visible;display:flex;flex-direction:column;gap:10px}
  .tsb-cols{display:none}
  .tsb-row,.tsb-list.nostaff .tsb-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:12px;border:1px solid var(--line);border-left:4px solid var(--c-bd);border-radius:12px;background:var(--card)}
  .tsb-row:hover{background:var(--card)}
  .tsb-row>.who{order:1;flex:1 1 0;min-width:0}.tsb-row>.acts{order:2}
  .tsb-row>.st{order:3;flex:1 1 100%}
  .tsb-row>.svc{order:4;flex:1 1 150px}.tsb-row>.fu{order:5;flex:0 1 auto}
  .tsb-row>.staff{order:6;flex:1 1 auto}.tsb-row>.upd{order:7;margin-left:auto;text-align:right}
  .tsb-row .ts-cat{font-size:15px;min-height:40px}
  .tsb-row>.fu:has(>.ts-meta){display:none}
  .tsb-pill{width:100%;font-size:15px;min-height:46px;padding:8px 14px;border-radius:12px;gap:10px}
  .tsb-fu{min-height:40px}
  .tsb-ic{width:40px;height:40px;font-size:17px;border-radius:11px}
  .tsb-fu{font-size:13px;padding:8px 10px}
  .tsb-lbl{display:inline;color:var(--muted);font-size:11px;font-weight:600;margin-right:4px}
  .tsb-back{background:rgba(0,0,0,.4)}
  .tsb-sheet{left:0!important;right:0;top:auto!important;bottom:0;width:auto;max-height:82vh;border-radius:18px 18px 0 0;padding:6px 12px calc(14px + env(safe-area-inset-bottom));border-bottom:none}
  .tsb-sheet.list{width:auto}.tsb-cols2{display:block}
  .tsb-sheet .grab{display:block;width:40px;height:4px;border-radius:4px;background:var(--line);margin:6px auto 4px}
  .tsb-sheet .ttl{display:block;font-weight:700;font-size:15px;padding:6px 8px 2px}
  .tsb-opt{font-size:15.5px;padding:12px 10px;min-height:46px}
  .tsb-dates button{padding:13px 10px;font-size:14.5px}
}
@media(max-width:767px){.ts-cat{width:100%;max-width:none;font-size:16px;min-height:42px}.ts-sel-inline{width:100%;max-width:none;font-size:16px;min-height:42px;padding:6px 2px 6px 6px;letter-spacing:-.2px}.ts-inline .ts-due{margin-left:0}}
`;
  document.head.appendChild(st);
}

function tsEnsurePage(){
  if($id('pageTvstatus')) return;
  const d=document.createElement('div'); d.className='page hidden'; d.id='pageTvstatus';
  d.innerHTML='<div class="page-pad" id="tsBody"></div>';
  $id('pages')?.appendChild(d);
}

function tsOwnerName(email){
  if(!email) return 'Unassigned';
  const m=getTeamMembers().find(x=>sameEmail(x.email,email));
  return m?.name||email;
}
function tsAgo(iso){
  if(!iso) return '';
  const m=Math.floor((Date.now()-new Date(iso).getTime())/60000);
  if(m<1) return 'just now'; if(m<60) return m+'m ago';
  const h=Math.floor(m/60); if(h<24) return h+'h ago';
  return Math.floor(h/24)+'d ago';
}

function tsFiltered(){
  const q=_tsFilter.q.trim().toLowerCase();
  return (typeof allLeads!=='undefined'?allLeads:[]).filter(l=>{
    if(_tsFilter.status){
      if(_tsFilter.status==='__overdue'){ if(tsFollowUpState(l)!=='overdue'&&tsFollowUpState(l)!=='today') return false; }
      else if(['__open','__won','__lost'].includes(_tsFilter.status)){ if(tsGroupOf(tsStatusOf(l).key)!==_tsFilter.status.slice(2)) return false; }
      else if(tsStatusOf(l).key!==_tsFilter.status) return false;
    }
    if(_tsFilter.owner==='__none'){ if(String(l.Owner||'').trim()) return false; }
    else if(_tsFilter.owner && !sameEmail(l.Owner,_tsFilter.owner)) return false;
    if(_tsFilter.cat && l.ServiceCategory!==_tsFilter.cat) return false;
    if(q && ![l.Name,l.Phone,l.Destination,l.LeadRef].some(v=>String(v||'').toLowerCase().includes(q))) return false;
    return true;
  });
}
// Follow-ups that are due come first, then most recently changed / arrived.
function tsSort(list){
  const rank={overdue:0,today:1,later:2,'':3};
  return list.sort((a,b)=>(rank[tsFollowUpState(a)]-rank[tsFollowUpState(b)])
    ||String(b.TravelStatusAt||b.Date||'').localeCompare(String(a.TravelStatusAt||a.Date||'')));
}

// Group of a status for the summary cards: open / won / lost.
const tsGroupOf=key=>TS_WON.has(key)?'won':TS_LOST.has(key)?'lost':'open';
const TS_GROUPS=[['','All','📋','blue'],['__overdue','Follow-ups due','🔔','red'],['__open','In progress','⏳','blue'],['__won','Won','🎉','green'],['__lost','Lost','❌','red']];
function tsInitials(l){ const n=String(tsLeadName(l)||'?').trim().split(/\s+/); return ((n[0]||'?')[0]+(n[1]?.[0]||'')).toUpperCase(); }
function tsFmtDate(d){ try{ return new Date(String(d).slice(0,10)+'T00:00:00').toLocaleDateString([], {day:'numeric', month:'short'}); }catch(e){ return String(d||''); } }
let _tsPickerOpen=false, _tsRenderPending=false;

function renderTravelStatus(){
  tsInjectStyle(); tsEnsurePage();
  const el=$id('tsBody'); if(!el) return;
  // A live update while the picker is open would pull the row out from under it: draw after it closes.
  if(_tsPickerOpen){ _tsRenderPending=true; return; }
  const leads=typeof allLeads!=='undefined'?allLeads:[];
  const counts={}, groups={open:0, won:0, lost:0}; let due=0;
  leads.forEach(l=>{ const k=tsStatusOf(l).key; counts[k]=(counts[k]||0)+1; groups[tsGroupOf(k)]++; const f=tsFollowUpState(l); if(f==='overdue'||f==='today') due++; });
  const list=tsSort(tsFiltered());
  const all=seesAllLeads();
  const f=_tsFilter.status;
  const groupN={'':leads.length, __overdue:due, __open:groups.open, __won:groups.won, __lost:groups.lost};
  // The group a chip row belongs to: the selected group, or the group of the selected status.
  const activeGroup=f.startsWith('__')&&f!=='__overdue'?f.slice(2):(TS_BY_KEY[f]?tsGroupOf(f):'');
  const groupOn=k=>k===f||(k==='__'+activeGroup&&TS_BY_KEY[f]);
  const chipStatuses=TS_STATUSES.filter(s=>!activeGroup||tsGroupOf(s[0])===activeGroup);
  const filtered=!!(f||_tsFilter.owner||_tsFilter.cat||_tsFilter.q);
  const staffSel=all?`<select aria-label="Staff" onchange="tsSetFilter('owner',this.value)">
        <option value="">👤 All staff</option>
        ${getTeamMembers().map(m=>`<option value="${esc(m.email)}"${sameEmail(_tsFilter.owner,m.email)?' selected':''}>${esc(m.name||m.email)}</option>`).join('')}
        <option value="__none"${_tsFilter.owner==='__none'?' selected':''}>Unassigned</option>
      </select>`:'';
  const row=l=>{
    const st=tsStatusOf(l), s=TS_BY_KEY[st.key], grp=s[3], fu=tsFollowUpState(l), id=Number(l.Id);
    const tel=String(l.Phone||'').startsWith('ig:')?'':String(l.Phone||'').replace(/[^0-9+]/g,'');
    const fuCell=st.key==='follow_up_pending'
      ?`<button class="tsb-fu ${fu==='overdue'?'overdue':fu==='today'?'today':''}" onclick="tsPick(${id},this,'date')" aria-label="Follow-up date">⏰ ${l.TravelFollowUpAt?esc(tsFmtDate(l.TravelFollowUpAt)):'Set date'}${fu==='overdue'?' · Overdue':fu==='today'?' · Today':''}</button>`
      :'<span class="ts-meta">—</span>';
    return `<div class="tsb-row tsb-c-${grp} ${tsOriginClass(l)}" data-lead="${id}" data-status="${st.key}">
      <div class="who tsb-who" onclick="openDetail(${id})" title="Open inquiry"><span class="tsb-av">${esc(tsInitials(l))}</span>
        <div><b>${esc(tsLeadName(l))}${tsOriginBadge(l)}</b><div class="ts-meta">${[tsPhone(l),l.Destination,l.TravelDates].filter(Boolean).map(esc).join(' · ')||'&nbsp;'}</div></div></div>
      <div class="svc">${tsInlineCategoryHTML(l)}</div>
      ${all?`<div class="staff ts-meta" data-mob="1"><span class="tsb-lbl">Staff</span>${esc(tsOwnerName(l.Owner))}</div>`:''}
      <div class="st"><button class="tsb-pill" onclick="tsPick(${id},this)" aria-haspopup="dialog" aria-label="Status: ${esc(s[1])}${st.auto?' (auto)':''}. Change status"><span>${s[2]}</span><span class="t">${esc(s[1])}${st.auto?' <span class="ts-auto">auto</span>':''}</span><span class="car">▼</span></button></div>
      <div class="fu">${fuCell}</div>
      <div class="upd ts-meta">${l.TravelStatusAt?`${esc(tsAgo(l.TravelStatusAt))}${l.TravelStatusBy?' · '+esc(tsOwnerName(l.TravelStatusBy)):''}`:'—'}</div>
      <div class="acts tsb-acts">${tel?`<a class="tsb-ic" href="tel:${esc(tel)}" title="Call" aria-label="Call ${esc(tsLeadName(l))}" onclick="event.stopPropagation()">📞</a>`:''}${typeof openLeadChat==='function'?`<button class="tsb-ic" title="Open chat" aria-label="Open chat" onclick="openLeadChat(${id})">💬</button>`:''}</div>
    </div>`;
  };
  el.innerHTML=`
    <div class="tsb-head">
      <div><h2>📌 Status Board</h2><div class="tsb-sub">${leads.length} inquir${leads.length===1?'y':'ies'}${due?` · <b style="color:var(--tsr-fg)">${due} follow-up${due===1?'':'s'} due</b>`:''}</div></div>
      <div class="tsb-search"><span>⌕</span><input id="tsSearch" type="search" placeholder="Search name, phone, destination…" value="${esc(_tsFilter.q)}" oninput="tsSetFilter('q',this.value)" aria-label="Search inquiries"></div>
    </div>
    <div class="tsb-groups" role="group" aria-label="Status groups">
      ${TS_GROUPS.map(([k,l,i,g])=>`<button class="tsb-group ts-tile tsb-c-${g}${groupOn(k)?' on':''}${k==='__overdue'&&due?' alert':''}" data-group="${k}" onclick="tsSetFilter('status','${k}')" aria-pressed="${groupOn(k)?'true':'false'}"><span class="n">${groupN[k]}</span><span class="l">${i} ${esc(l)}</span></button>`).join('')}
    </div>
    <div class="tsb-chips" role="group" aria-label="Statuses">
      ${chipStatuses.map(([k,l,i,g])=>`<button class="tsb-chip ts-tile tsb-c-${g}${f===k?' on':''}${counts[k]?'':' zero'}" data-status="${k}" onclick="tsSetFilter('status',${f===k?`'${activeGroup?'__'+activeGroup:''}'`:`'${k}'`})" aria-pressed="${f===k?'true':'false'}">${i} <span class="l">${esc(l)}</span> <span class="c n">${counts[k]||0}</span></button>`).join('')}
    </div>
    <div class="tsb-bar">
      ${staffSel}
      <select aria-label="Service" onchange="tsSetFilter('cat',this.value)">
        <option value="">🗂️ All services</option>
        ${(typeof LEAD_CATEGORIES!=='undefined'?LEAD_CATEGORIES:[]).map(c=>`<option value="${esc(c)}"${_tsFilter.cat===c?' selected':''}>${serviceCategoryIcon(c)} ${esc(c)}</option>`).join('')}
      </select>
      ${filtered?'<button class="tsb-clear" onclick="tsClearFilters()">Clear filters</button>':''}
      <span class="ts-meta">Showing ${Math.min(list.length,_tsShown)} of ${list.length}</span>
    </div>
    <div class="tsb-list${all?'':' nostaff'}">
      <div class="tsb-cols"><span>Inquiry</span><span>Service</span>${all?'<span>Staff</span>':''}<span>Status</span><span>Follow-up</span><span>Updated</span><span></span></div>
      ${list.length?list.slice(0,_tsShown).map(row).join(''):`<div class="tsb-empty"><b>🔍</b>No inquiries match these filters.${filtered?'<br><button class="tsb-clear" onclick="tsClearFilters()">Clear filters</button>':''}</div>`}
    </div>
    ${list.length>_tsShown?`<div class="tsb-more"><button class="btn-ghost" onclick="tsMore()">Show more (${list.length-_tsShown} left)</button></div>`:''}`;
}
function tsClearFilters(){ _tsFilter={status:'',owner:'',cat:'',q:''}; _tsShown=TS_PAGE_SIZE; renderTravelStatus(); }

/* ── Status picker: a popover under the pill on PC, a bottom sheet on a phone. Picking "Follow up
   pending" goes straight to a date step (Today / Tomorrow / In 3 days / Next week / any date), so
   the status and its date are saved in one change. Esc or a tap outside closes it. */
function tsIsoIn(days){ const d=new Date(); d.setDate(d.getDate()+days); return d.toISOString().slice(0,10); }
function tsPickClose(){
  $id('tsbBack')?.remove(); $id('tsbSheet')?.remove();
  document.removeEventListener('keydown', tsPickKey, true);
  const ret=_tsPickReturn; _tsPickReturn=null;
  _tsPickerOpen=false;
  if(_tsRenderPending){ _tsRenderPending=false; renderTravelStatus(); }
  if(ret){ const b=document.querySelector(`#tsBody .tsb-row[data-lead="${ret}"] .tsb-pill`); b?.focus({preventScroll:true}); }
}
let _tsPickReturn=null;
function tsPickKey(e){
  if(e.key==='Escape'){ e.preventDefault(); tsPickClose(); return; }
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){
    const opts=[...document.querySelectorAll('#tsbSheet .tsb-opt, #tsbSheet .tsb-dates button')]; if(!opts.length) return;
    e.preventDefault(); const i=opts.indexOf(document.activeElement);
    opts[(i+(e.key==='ArrowDown'?1:-1)+opts.length)%opts.length].focus();
  }
}
function tsPick(id, anchor, step){
  const lead=(typeof allLeads!=='undefined'?allLeads:[]).find(l=>Number(l.Id)===Number(id)); if(!lead) return;
  tsPickClose();
  _tsPickerOpen=true; _tsPickReturn=Number(id);
  const back=document.createElement('div'); back.className='tsb-back'; back.id='tsbBack'; back.onclick=tsPickClose;
  const sh=document.createElement('div'); sh.className='tsb-sheet'; sh.id='tsbSheet'; sh.setAttribute('role','dialog'); sh.setAttribute('aria-modal','true'); sh.setAttribute('aria-label','Change status');
  document.body.append(back, sh);
  const draw=(mode)=>{
    const cur=tsStatusOf(lead).key;
    sh.classList.toggle('list', mode!=='date'); sh.style.left=''; sh.style.top='';
    if(mode==='date'){
      const quick=[['Today',0],['Tomorrow',1],['In 3 days',3],['Next week',7]];
      sh.innerHTML=`<div class="grab"></div>
        <h4>⏰ Follow up when? · ${esc(tsLeadName(lead))}</h4>
        <div class="tsb-dates">${quick.map(([l,d])=>`<button data-days="${d}" onclick="tsPickDate(${Number(id)},'${tsIsoIn(d)}')">${l}<small>${esc(tsFmtDate(tsIsoIn(d)))}</small></button>`).join('')}</div>
        <div class="tsb-custom"><input type="date" id="tsbDate" aria-label="Pick a date" min="${tsIsoIn(0)}" value="${esc(String(lead.TravelFollowUpAt||'').slice(0,10)||tsIsoIn(1))}"><button onclick="tsPickDate(${Number(id)},$id('tsbDate').value)">Save</button></div>
        ${cur==='follow_up_pending'?'':'<button class="tsb-backlink" onclick="tsPickBack()">← Back to statuses</button>'}`;
    } else {
      const sec=(title, keys)=>`<h4>${title}</h4>${TS_STATUSES.filter(s=>keys(s[0])).map(([k,l,i,g])=>`<button class="tsb-opt tsb-c-${g}${k===cur?' cur':''}" data-status="${k}" onclick="tsPickStatus(${Number(id)},'${k}')"><span class="dot"></span>${i} ${esc(l)}${k===cur?'<span class="ck">✓</span>':''}</button>`).join('')}`;
      sh.innerHTML=`<div class="grab"></div><div class="ttl">${esc(tsLeadName(lead))}</div>
        <div class="tsb-cols2"><div>${sec('In progress', k=>tsGroupOf(k)==='open')}</div><div>${sec('Won', k=>TS_WON.has(k))}${sec('Lost', k=>TS_LOST.has(k))}</div></div>`;
    }
    // PC: under the pill (or above it when there's no room), kept on screen.
    if(!window.matchMedia('(max-width:767px)').matches && anchor){
      const r=anchor.getBoundingClientRect(), w=sh.offsetWidth, h=sh.offsetHeight;
      let left=Math.min(Math.max(8, r.left), window.innerWidth-w-8);
      let top=r.bottom+6; if(top+h>window.innerHeight-8) top=Math.max(8, r.top-h-6);
      sh.style.left=left+'px'; sh.style.top=top+'px';
    }
    (sh.querySelector('.tsb-opt.cur')||sh.querySelector('.tsb-opt, .tsb-dates button'))?.focus({preventScroll:true});
  };
  window.tsPickBack=()=>draw('list');
  sh._draw=draw;
  draw(step==='date'?'date':'list');
  document.addEventListener('keydown', tsPickKey, true);
}
function tsPickStatus(id, key){
  if(key==='follow_up_pending'){ $id('tsbSheet')?._draw('date'); return; }
  tsPickClose();
  tsSetStatus(id, key);
}
function tsPickDate(id, date){
  if(!date) return;
  const lead=allLeads.find(l=>Number(l.Id)===Number(id));
  tsPickClose();
  if(lead?.TravelStatus==='follow_up_pending') return tsSetFollowUp(id, date);
  return tsSave(id, {TravelStatus:'follow_up_pending', TravelFollowUpAt:date});
}

function tsSetFilter(k,v){
  _tsFilter[k]=v; _tsShown=TS_PAGE_SIZE;
  if(k==='q'){
    // Keep typing focus: re-render, then put the caret back in the search box.
    renderTravelStatus();
    const s=$id('tsSearch'); if(s){ s.focus(); s.setSelectionRange(s.value.length,s.value.length); }
    return;
  }
  renderTravelStatus();
}
function tsMore(){ _tsShown+=TS_PAGE_SIZE; renderTravelStatus(); }

async function tsEnsureFields(){
  if(_tsFieldsReady) return;
  await Promise.all(TS_FIELDS.map(f=>Array.isArray(f)?ensureLeadsField(f[0],f[1]):ensureLeadsField(f)));
  _tsFieldsReady=true;
}
function tsParseLog(raw){
  try{ const v=typeof raw==='string'?JSON.parse(raw||'[]'):raw; return Array.isArray(v)?v:[]; }catch(e){ return []; }
}
async function tsSave(id,patch){
  const lead=(typeof allLeads!=='undefined'?allLeads:[]).find(l=>l.Id===id);
  if(!lead) return;
  const now=new Date().toISOString();
  const full={...patch, TravelStatusAt:now, TravelStatusBy:myEmail||''};
  const statusChanged=!!patch.TravelStatus && patch.TravelStatus!==lead.TravelStatus;
  const stage=statusChanged?tsStageFor(patch.TravelStatus, lead):null;
  if(stage) full.Stage=stage;
  const before={}; Object.keys(full).concat('TravelStatusLog').forEach(k=>{ before[k]=lead[k]; });
  const from=tsStatusOf(lead).key;
  Object.assign(lead,full);
  // Held over any leads reload that lands before the save does (dashboard.html _applyLeadEdits),
  // so the board never flicks back to the old status.
  if(typeof _noteLeadEdits==='function') _noteLeadEdits({Id:id,...full});
  tsRefreshViews();
  try{
    // Column check and the stored history are read side by side, not one after the other.
    const [,freshLog]=await Promise.all([
      tsEnsureFields(),
      statusChanged?ncGet(`${CONFIG.NOCODB_BASE}/api/v2/tables/${CONFIG.LEADS_TABLE_ID}/records/${id}?fields=TravelStatusLog`).catch(()=>null):null,
    ]);
    if(statusChanged){
      // Append to the history; start from the stored copy so a teammate's change made since this
      // page loaded isn't lost (same approach as appendCallLog).
      let log=tsParseLog(before.TravelStatusLog);
      if(freshLog) log=tsParseLog(freshLog.TravelStatusLog);
      const entry={at:now, by:myEmail||'', from, to:patch.TravelStatus};
      if(full.TravelFollowUpAt) entry.fu=full.TravelFollowUpAt;
      full.TravelStatusLog=JSON.stringify([entry,...log].slice(0,TS_LOG_MAX));
      lead.TravelStatusLog=full.TravelStatusLog;
    }
    await ncPatch(`${CONFIG.NOCODB_BASE}/api/v2/tables/${CONFIG.LEADS_TABLE_ID}/records`,{Id:id,...full});
    if(stage && typeof reportLeadQualityChange==='function') reportLeadQualityChange(id, {Stage:before.Stage, DealValue:lead.DealValue, DealCurrency:lead.DealCurrency}, {Stage:stage, DealValue:lead.DealValue, DealCurrency:lead.DealCurrency});
    if(stage && !$id('pageLeads')?.classList.contains('hidden') && typeof renderLeadsCurrentView==='function') renderLeadsCurrentView();
    if(typeof showToast==='function') showToast(stage?`Status saved — lead moved to ${typeof stageLabel==='function'?stageLabel(stage):stage}`:'Status saved');
  }catch(e){
    if(typeof _dropLeadEdits==='function') _dropLeadEdits({Id:id});
    Object.assign(lead,before);
    tsRefreshViews(true);
    if(typeof showToast==='function') showToast('Could not save status — '+e.message,'err');
  }
}
// Re-render whichever views show travel status. The Inquiries list only needs a redraw when a save
// failed (to put the old value back) — the dropdown the user just changed already shows the new one.
function tsRefreshViews(failed){
  if(!$id('pageTvstatus')?.classList.contains('hidden')) renderTravelStatus();
  if(failed && !$id('pageLeads')?.classList.contains('hidden') && typeof renderLeadsCurrentView==='function') renderLeadsCurrentView();
}
function tsSetStatus(id,key){
  if(!TS_BY_KEY[key]) return;
  const patch={TravelStatus:key};
  // A new follow-up defaults to tomorrow so it lands in "Follow-ups due" instead of nowhere.
  if(key==='follow_up_pending'){
    const lead=allLeads.find(l=>l.Id===id);
    if(!lead?.TravelFollowUpAt||String(lead.TravelFollowUpAt).slice(0,10)<TODAY){
      const d=new Date(); d.setDate(d.getDate()+1); patch.TravelFollowUpAt=d.toISOString().slice(0,10);
    }
  }
  return tsSave(id,patch);
}
function tsSetFollowUp(id,date){ return tsSave(id,{TravelFollowUpAt:date||''}); }

// Today page summary: how many inquiries sit in each open status, and follow-ups due.
function tsSummaryHtml(){
  const leads=typeof allLeads!=='undefined'?allLeads:[];
  if(!leads.length) return '';
  const counts={}; let due=0;
  leads.forEach(l=>{ const k=tsStatusOf(l).key; counts[k]=(counts[k]||0)+1; const f=tsFollowUpState(l); if(f==='overdue'||f==='today') due++; });
  const chips=TS_STATUSES.filter(([k])=>counts[k]).map(([k,l,i])=>`<span class="tv-chip" onclick="tsOpen('${k}')">${i} ${esc(l)}<b>${counts[k]}</b></span>`).join('');
  return `<div class="card" style="margin-bottom:14px"><div class="card-title">📌 Inquiry status
      <button class="btn-ghost" onclick="tsOpen('')" style="font-size:12px;font-weight:500;margin-left:auto">Status board →</button></div>
    ${due?`<div class="tv-banner" style="margin-bottom:10px;cursor:pointer" onclick="tsOpen('__overdue')">🔔 <b>${due}</b> follow-up${due===1?'':'s'} due today or overdue</div>`:''}
    <div class="tv-chips">${chips}</div></div>`;
}
function tsOpen(status){
  _tsFilter={status:status||'',owner:'',cat:'',q:''}; _tsShown=TS_PAGE_SIZE;
  navigate('tvstatus');
}

/* ── Inquiries tab: one compact status dropdown per inquiry (list cards and table) ── */
function tsIsTravel(){ return clientRecord?.industry==='travel'; }
function tsInlineStatusHTML(l){
  if(!tsIsTravel()||!l) return '';
  tsInjectStyle();
  const st=tsStatusOf(l); const grp=TS_BY_KEY[st.key][3]; const f=tsFollowUpState(l);
  return `<div class="ts-inline" onclick="event.stopPropagation()">
    <select class="ts-sel ts-sel-inline ${grp}" aria-label="Travel status" onchange="tsInlineChange(${Number(l.Id)},this)">
      ${TS_STATUSES.map(s=>`<option value="${s[0]}"${st.key===s[0]?' selected':''}>${s[2]} ${esc(s[1])}</option>`).join('')}
    </select>${l.TravelStatus==='follow_up_pending'&&l.TravelFollowUpAt?`<span class="ts-due ${f==='overdue'?'overdue':f==='today'?'today':''}">⏰ ${esc(String(l.TravelFollowUpAt).slice(0,10))}</span>`:''}
  </div>`;
}
function tsInlineChange(id,sel){
  const s=TS_BY_KEY[sel.value]; if(!s) return;
  sel.className=`ts-sel ts-sel-inline ${s[3]}`;
  tsSetStatus(id,sel.value);
}

/* ── Service Category picker (Leads table and list, Status Board) ──
   Saves straight to the lead's ServiceCategory — the field the Leads category filter/chips, Home
   "Leads by category", Reports → 🗂️ Service Category, the inbox category chips and the per-user
   category access all read. A category saved before LEAD_CATEGORIES changed stays selectable. */
let _tsCatFieldReady=false;
function tsInlineCategoryHTML(l){
  if(!tsIsTravel()||!l) return '';
  tsInjectStyle();
  const cats=typeof LEAD_CATEGORIES!=='undefined'?LEAD_CATEGORIES:[];
  const cur=String(l.ServiceCategory||'').trim();
  const opts=!cur||cats.includes(cur)?cats:[cur,...cats];
  return `<select class="ts-cat ${cur?'set':''}" data-lead="${Number(l.Id)}" aria-label="Service category" title="Service category" onclick="event.stopPropagation()" onchange="tsSetCategory(${Number(l.Id)},this.value)">
      <option value="">🗂️ No category</option>${opts.map(c=>`<option value="${esc(c)}"${c===cur?' selected':''}>${serviceCategoryIcon(c)} ${esc(c)}</option>`).join('')}
    </select>`;
}
async function tsSetCategory(id,cat){
  const lead=(typeof allLeads!=='undefined'?allLeads:[]).find(l=>l.Id===id);
  if(!lead) return;
  cat=String(cat||'').trim();
  const before=lead.ServiceCategory||'';
  if(before===cat) return;
  lead.ServiceCategory=cat;
  tsRefreshCategoryViews();
  try{
    if(!_tsCatFieldReady){ await ensureLeadsField('ServiceCategory'); _tsCatFieldReady=true; }
    await ncPatch(`${CONFIG.NOCODB_BASE}/api/v2/tables/${CONFIG.LEADS_TABLE_ID}/records`,{Id:id, ServiceCategory:cat});
    if(typeof _cacheLeads==='function') _cacheLeads(allLeads);
    if(typeof showToast==='function') showToast(cat?`Category set to ${cat}`:'Category cleared');
  }catch(e){
    lead.ServiceCategory=before;
    tsRefreshCategoryViews(true);
    if(typeof showToast==='function') showToast('Could not save category — '+e.message,'err');
  }
}
// Category counts (Leads chips, Home report, Status Board) follow the change. The Leads list is
// only redrawn when a category filter is on (the row may no longer belong) or a save failed.
function tsRefreshCategoryViews(failed){
  if(!$id('pageLeads')?.classList.contains('hidden')){
    if(failed||$id('leadCategoryFilter')?.value){ if(typeof renderLeadsCurrentView==='function') renderLeadsCurrentView(); }
    else if(typeof renderLeadsCategoryChips==='function') renderLeadsCategoryChips();
  }
  if(!$id('pageTvstatus')?.classList.contains('hidden')&&(failed||_tsFilter.cat)) renderTravelStatus();
  if(typeof renderHome==='function') try{ renderHome(); }catch(e){}
}

/* ── Reports → 📌 Status Changes: every status change, date and time wise ── */
let _tsRpt={q:'', status:'', group:false, shown:300};
function tsRptRange(){
  const f=typeof _rptFilters!=='undefined'?_rptFilters:{period:'all'};
  const now=new Date(); let from=null, to=null;
  if(f.period==='today'){ from=new Date(now); from.setHours(0,0,0,0); }
  else if(f.period==='week'){ from=new Date(now); from.setDate(now.getDate()-now.getDay()); from.setHours(0,0,0,0); }
  else if(f.period==='month'){ from=new Date(now.getFullYear(),now.getMonth(),1); }
  else if(f.period==='year'){ from=new Date(now.getFullYear(),0,1); }
  else if(f.period==='custom'){ if(f.from) from=new Date(f.from+'T00:00:00'); if(f.to) to=new Date(f.to+'T23:59:59'); }
  return {from, to};
}
// Every change across all inquiries, newest first. Inquiries marked before the history was kept
// contribute their last change (TravelStatusAt/By) so they still show up.
function tsAllChanges(){
  const out=[];
  for(const l of (typeof allLeads!=='undefined'?allLeads:[])){
    const log=tsParseLog(l.TravelStatusLog);
    if(log.length) log.forEach(e=>{ if(e?.at&&TS_BY_KEY[e.to]) out.push({...e, lead:l}); });
    else if(l.TravelStatusAt&&TS_BY_KEY[l.TravelStatus]) out.push({at:l.TravelStatusAt, by:l.TravelStatusBy||'', from:'', to:l.TravelStatus, fu:l.TravelFollowUpAt||'', lead:l, legacy:true});
  }
  return out.sort((a,b)=>String(b.at).localeCompare(String(a.at)));
}
function tsFmtDateTime(iso){
  try{ const d=new Date(iso); return {date:d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}), time:d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}; }
  catch(e){ return {date:String(iso).slice(0,10), time:''}; }
}
function tsStatusChip(key){
  const s=TS_BY_KEY[key]; if(!s) return '<span class="ts-meta">—</span>';
  return `<span class="ts-chip ${s[3]}">${s[2]} ${esc(s[1])}</span>`;
}
function renderReportsTravelStatus(){
  tsInjectStyle();
  const el=$id('reportsContent'); if(!el) return;
  const {from,to}=tsRptRange();
  const member=$id('rptMember')?.value||'';
  const q=_tsRpt.q.trim().toLowerCase();
  const all=tsAllChanges().filter(c=>{
    const t=new Date(c.at);
    if(from&&t<from) return false;
    if(to&&t>to) return false;
    if(member&&!sameEmail(c.by,member)) return false;
    if(_tsRpt.status&&c.to!==_tsRpt.status) return false;
    if(q&&![c.lead.Name,c.lead.Phone,c.lead.Destination].some(v=>String(v||'').toLowerCase().includes(q))) return false;
    return true;
  });
  const leadsTouched=new Set(all.map(c=>c.lead.Id)).size;
  const count=k=>all.filter(c=>c.to===k).length;
  const row=c=>{ const dt=tsFmtDateTime(c.at); return `<tr>
      <td style="white-space:nowrap">${esc(dt.date)}</td><td style="white-space:nowrap">${esc(dt.time)}</td>
      <td><a href="#" onclick="openDetail(${Number(c.lead.Id)});return false"><b>${esc(tsLeadName(c.lead))}</b></a>${tsOriginBadge(c.lead)}<div class="ts-meta">${esc(tsPhone(c.lead))}</div></td>
      <td>${c.from?tsStatusChip(c.from):'<span class="ts-meta">—</span>'}</td>
      <td>${tsStatusChip(c.to)}${c.legacy?' <span class="ts-auto" title="Changed before status history was kept">last change</span>':''}</td>
      <td>${c.fu?esc(String(c.fu).slice(0,10)):'<span class="ts-meta">—</span>'}</td>
      <td>${esc(tsOwnerName(c.by))}</td></tr>`; };
  const head='<thead><tr><th>Date</th><th>Time</th><th>Inquiry</th><th>From</th><th>To</th><th>Follow-up</th><th>Changed by</th></tr></thead>';
  let body;
  if(_tsRpt.group){
    const byLead=new Map();
    all.forEach(c=>{ if(!byLead.has(c.lead.Id)) byLead.set(c.lead.Id,[]); byLead.get(c.lead.Id).push(c); });
    body=[...byLead.values()].slice(0,_tsRpt.shown).map(list=>{
      const l=list[0].lead;
      return `<div class="card" style="margin-bottom:10px;padding:12px 14px">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:6px">
          <span><a href="#" onclick="openDetail(${Number(l.Id)});return false"><b>${esc(tsLeadName(l))}</b></a>${tsOriginBadge(l)}</span>
          <span>Now: ${tsStatusChip(tsStatusOf(l).key)}</span></div>
        <div style="overflow-x:auto"><table class="leads-tbl ts-rpt-tbl">${head}<tbody>${list.map(row).join('')}</tbody></table></div></div>`;
    }).join('');
  } else {
    body=`<div class="card" style="padding:6px 8px"><div style="overflow-x:auto"><table class="leads-tbl ts-rpt-tbl">${head}<tbody>${all.slice(0,_tsRpt.shown).map(row).join('')}</tbody></table></div></div>`;
  }
  const more=(_tsRpt.group?leadsTouched:all.length)>_tsRpt.shown;
  el.innerHTML=`
    <div style="margin-bottom:12px"><div class="card-title" style="margin-bottom:0">📌 Status Changes</div>
      <div class="s-note">Every travel status change on an inquiry, by date and time. The period and member filters above apply (member = who changed it).</div></div>
    <div style="display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:14px">
      <div class="stat accent"><div class="stat-lbl">Status changes</div><div class="stat-val">${all.length}</div></div>
      <div class="stat"><div class="stat-lbl">Inquiries updated</div><div class="stat-val">${leadsTouched}</div></div>
      <div class="stat"><div class="stat-lbl">🎉 Booking closed</div><div class="stat-val">${count('booking_closed')}</div></div>
      <div class="stat"><div class="stat-lbl">❌ Booking not done</div><div class="stat-val">${count('booking_not_done')}</div></div>
      <div class="stat"><div class="stat-lbl">⏰ Follow ups set</div><div class="stat-val">${count('follow_up_pending')}</div></div>
    </div>
    <div class="ts-bar">
      <input class="form-input" id="tsRptSearch" placeholder="Search inquiry name or phone…" value="${esc(_tsRpt.q)}" oninput="tsRptSet('q',this.value)">
      <select class="form-input" onchange="tsRptSet('status',this.value)"><option value="">Any new status</option>
        ${TS_STATUSES.map(s=>`<option value="${s[0]}"${_tsRpt.status===s[0]?' selected':''}>${s[2]} ${esc(s[1])}</option>`).join('')}</select>
      <label class="ts-meta" style="display:flex;align-items:center;gap:6px;font-size:12.5px"><input type="checkbox" ${_tsRpt.group?'checked':''} onchange="tsRptSet('group',this.checked)"> Group by inquiry</label>
    </div>
    ${all.length?body:'<div class="card"><div class="ts-empty">No status changes in this period.</div></div>'}
    ${more?`<div style="text-align:center;padding:10px"><button class="btn-ghost" onclick="tsRptSet('shown',${_tsRpt.shown+300})">Show more</button></div>`:''}`;
  if(document.activeElement?.id!=='tsRptSearch' && _tsRpt._focus){ const s=$id('tsRptSearch'); if(s){ s.focus(); s.setSelectionRange(s.value.length,s.value.length); } }
  _tsRpt._focus=false;
}
function tsRptSet(k,v){
  _tsRpt[k]=v; if(k!=='shown') _tsRpt.shown=300;
  if(k==='q') _tsRpt._focus=true;
  renderReportsTravelStatus();
}
