// Financial statements read straight off the General Ledger (accounting-core.js). Every report
// runs ledgerSync() first so it always reflects the current Documents / Expenses / Bills data.
import {r2, num, todayStr, addDays, addMonths, monthsRange, monthEnd, fiscalYear, allRows, firstRow, accountTotals, naturalBalance,
  invoiceBalances, daysBetween, INTERVAL_MONTHS, SOURCE_LABELS, POSTABLE_INVOICE} from './accounting-core.js';

const SUBTYPE_LABELS={operating:'Operating revenue', contra:'Returns & discounts', other:'Other income', cogs:'Cost of revenue', payroll:'Payroll', sales_marketing:'Sales & marketing',
  cash:'Cash', bank:'Bank', receivable:'Receivables', current:'Other current', tax:'Taxes', fixed:'Fixed assets', contra_fixed:'Accumulated depreciation',
  payable:'Payables', deferred:'Deferred revenue', long_term:'Long-term', equity:'Equity'};
const subLabel=s=>SUBTYPE_LABELS[s]||s||'Other';
const range=(url)=>{
  const t=todayStr();
  const to=url.searchParams.get('to')||t;
  const from=url.searchParams.get('from')||`${to.slice(0,7)}-01`;
  return {from, to};
};

export function computeTrialBalance(accounts, opening, period){
  const rows=[]; let td=0, tc=0;
  for(const a of [...accounts].sort((x,y)=>String(x.code).localeCompare(String(y.code)))){
    const o=opening[a.id]||{debit:0,credit:0}, p=period[a.id]||{debit:0,credit:0};
    const ob=r2(o.debit-o.credit), cb=r2(ob+p.debit-p.credit);
    if(!ob && !p.debit && !p.credit) continue;
    rows.push({account_id:a.id, code:a.code, name:a.name, type:a.type, subtype:a.subtype, opening:ob, debit:p.debit, credit:p.credit, closing:cb,
      closing_debit:cb>0?cb:0, closing_credit:cb<0?-cb:0});
    td+=cb>0?cb:0; tc+=cb<0?-cb:0;
  }
  return {rows, total_debit:r2(td), total_credit:r2(tc), balanced:Math.abs(td-tc)<0.01};
}
export async function trialBalance(env, clientId, accounts, {from, to, branch}){
  const opening=from?await accountTotals(env, clientId, {to:addDays(from,-1), branch}):{};
  const period=await accountTotals(env, clientId, {from, to, branch});
  return computeTrialBalance(accounts, opening, period);
}

// P&L sections; year-end closing entries are excluded (they zero income/expense into Retained).
export async function profitAndLoss(env, clientId, accounts, {from, to, branch}){
  const t=await accountTotals(env, clientId, {from, to, branch, excludeTypes:['year_close']});
  return plFromTotals(accounts, t);
}
export function plFromTotals(accounts, t){
  const sec={revenue:[], cogs:[], opex:[], other:[]};
  for(const a of accounts){
    if(a.type!=='income' && a.type!=='expense') continue;
    const bal=naturalBalance(a.type, t[a.id]); if(!bal) continue;
    const row={account_id:a.id, code:a.code, name:a.name, subtype:a.subtype, amount:bal, group:subLabel(a.subtype)};
    if(a.type==='income') (a.subtype==='other'?sec.other:sec.revenue).push(row);
    else (a.subtype==='cogs'?sec.cogs:sec.opex).push(row);
  }
  for(const k of Object.keys(sec)) sec[k].sort((x,y)=>String(x.code).localeCompare(String(y.code)));
  const s=k=>r2(sec[k].reduce((a,b)=>a+b.amount,0));
  const revenue=s('revenue'), cogs=s('cogs'), opex=s('opex'), other=s('other');
  const gross=r2(revenue-cogs), operating=r2(gross-opex), net=r2(operating+other);
  return {sections:sec, revenue, cogs, gross_profit:gross, gross_margin_pct:revenue?r2(gross/revenue*100):0, opex, operating_profit:operating, other_income:other, net_profit:net};
}
export async function balanceSheet(env, clientId, accounts, asOf, branch){
  const t=await accountTotals(env, clientId, {to:asOf, branch});
  const groups={asset:{}, liability:{}, equity:{}};
  let earnings=0;
  for(const a of accounts){
    const bal=naturalBalance(a.type, t[a.id]);
    if(a.type==='income') earnings+=bal; else if(a.type==='expense') earnings-=bal;
    else if(groups[a.type] && bal){ const g=subLabel(a.subtype); (groups[a.type][g]=groups[a.type][g]||[]).push({account_id:a.id, code:a.code, name:a.name, amount:bal}); }
  }
  earnings=r2(earnings);
  // Income/expense not yet closed into Retained Earnings shows as its own equity line, which is
  // what keeps Assets = Liabilities + Equity before any year-end close has been run.
  if(earnings) (groups.equity['Current earnings (not yet closed)']=[]).push({account_id:null, code:'', name:'Profit / (loss) to date', amount:earnings});
  const tot=k=>r2(Object.values(groups[k]).flat().reduce((s,r)=>s+r.amount,0));
  const assets=tot('asset'), liabilities=tot('liability'), equity=tot('equity');
  const asList=k=>Object.entries(groups[k]).map(([group,rows])=>({group, rows:rows.sort((x,y)=>String(x.code).localeCompare(String(y.code))), total:r2(rows.reduce((s,r)=>s+r.amount,0))}));
  return {as_of:asOf, assets:asList('asset'), liabilities:asList('liability'), equity:asList('equity'), total_assets:assets, total_liabilities:liabilities, total_equity:equity,
    difference:r2(assets-liabilities-equity), balanced:Math.abs(assets-liabilities-equity)<0.01};
}
export async function generalLedger(env, clientId, account, {from, to, party}){
  const opening=await accountTotals(env, clientId, {to:addDays(from,-1)});
  const debitNormal=['asset','expense'].includes(account.type);
  let bal=opening[account.id]?r2(opening[account.id].debit-opening[account.id].credit):0;
  let sql=`SELECT l.*, j.entry_no, j.entry_date, j.memo, j.source_type, j.source_ref FROM acc_journal_lines l JOIN acc_journals j ON j.id=l.journal_id
    WHERE l.client_id=? AND l.account_id=? AND j.status='posted' AND j.entry_date>=? AND j.entry_date<=?`;
  const b=[clientId, account.id, from, to];
  if(party){ sql+=` AND l.party_name=?`; b.push(party); }
  sql+=` ORDER BY j.entry_date, j.entry_no, l.id LIMIT 5000`;
  const lines=await allRows(env, sql, ...b);
  const openingBal=bal;
  const rows=lines.map(l=>{ bal=r2(bal+l.debit-l.credit); return {journal_id:l.journal_id, entry_no:l.entry_no, date:l.entry_date, memo:l.memo, source:SOURCE_LABELS[l.source_type]||l.source_type, source_type:l.source_type, source_ref:l.source_ref, party:l.party_name, description:l.description, debit:l.debit, credit:l.credit, balance:debitNormal?bal:-bal}; });
  return {account:{id:account.id, code:account.code, name:account.name, type:account.type}, from, to, opening:debitNormal?openingBal:-openingBal, closing:debitNormal?bal:-bal, rows,
    total_debit:r2(rows.reduce((s,r)=>s+r.debit,0)), total_credit:r2(rows.reduce((s,r)=>s+r.credit,0))};
}

// Direct-method cash flow off the ledger: every posted entry that touches a cash/bank account is
// classified by what's on the OTHER side — fixed assets → investing, equity/loans → financing,
// everything else → operating. Transfers between two cash accounts net to zero.
export async function cashFlow(env, clientId, accounts, {from, to}){
  const byId={}; for(const a of accounts) byId[a.id]=a;
  const isCash=a=>a && a.type==='asset' && (a.subtype==='bank'||a.subtype==='cash');
  const cashIds=accounts.filter(isCash).map(a=>a.id);
  if(!cashIds.length) return {sections:[], net_change:0, opening_cash:0, closing_cash:0, months:[]};
  const ph=cashIds.map(()=>'?').join(',');
  const lines=await allRows(env, `SELECT l.journal_id, l.account_id, l.debit, l.credit, j.entry_date FROM acc_journal_lines l JOIN acc_journals j ON j.id=l.journal_id
    WHERE l.client_id=? AND j.status='posted' AND j.entry_date>=? AND j.entry_date<=? AND l.journal_id IN (SELECT DISTINCT l2.journal_id FROM acc_journal_lines l2 WHERE l2.client_id=? AND l2.account_id IN (${ph}))`,
    clientId, from, to, clientId, ...cashIds);
  const byJ={}; for(const l of lines) (byJ[l.journal_id]=byJ[l.journal_id]||[]).push(l);
  const cat={operating:{}, investing:{}, financing:{}}; const monthly={};
  for(const ls of Object.values(byJ)){
    const cashNet=r2(ls.filter(l=>cashIds.includes(l.account_id)).reduce((s,l)=>s+l.debit-l.credit,0));
    if(!cashNet) continue;
    const others=ls.filter(l=>!cashIds.includes(l.account_id));
    const otherTotal=others.reduce((s,l)=>s+Math.abs(l.debit-l.credit),0)||1;
    const m=ls[0].entry_date.slice(0,7); monthly[m]=monthly[m]||{inflow:0,outflow:0};
    if(cashNet>0) monthly[m].inflow=r2(monthly[m].inflow+cashNet); else monthly[m].outflow=r2(monthly[m].outflow-cashNet);
    for(const o of others){
      const a=byId[o.account_id]; const share=r2(cashNet*Math.abs(o.debit-o.credit)/otherTotal);
      const section=(a?.subtype==='fixed'||a?.subtype==='contra_fixed')?'investing':(a?.type==='equity'||a?.subtype==='long_term')?'financing':'operating';
      const label=a?.name||'Other';
      cat[section][label]=r2((cat[section][label]||0)+share);
    }
  }
  const sections=Object.entries(cat).map(([k,v])=>({section:k, rows:Object.entries(v).filter(([,a])=>a).map(([label,amount])=>({label, amount})).sort((x,y)=>Math.abs(y.amount)-Math.abs(x.amount)), total:r2(Object.values(v).reduce((s,a)=>s+a,0))}));
  const openingT=await accountTotals(env, clientId, {to:addDays(from,-1)});
  const opening=r2(cashIds.reduce((s,id)=>s+(openingT[id]?openingT[id].debit-openingT[id].credit:0),0));
  const net=r2(sections.reduce((s,x)=>s+x.total,0));
  return {sections, opening_cash:opening, net_change:net, closing_cash:r2(opening+net), months:monthsRange(from.slice(0,7), to.slice(0,7)).map(m=>({month:m, inflow:monthly[m]?.inflow||0, outflow:monthly[m]?.outflow||0, net:r2((monthly[m]?.inflow||0)-(monthly[m]?.outflow||0))}))};
}

// Party balances from AR / AP lines (party_name tagged at posting time).
export async function partyBalances(env, clientId, ctx, type){
  const acct=type==='supplier'?ctx.byKey.AP:ctx.byKey.AR;
  const rows=await allRows(env, `SELECT l.party_name, SUM(l.debit) d, SUM(l.credit) c, MAX(j.entry_date) last_date FROM acc_journal_lines l JOIN acc_journals j ON j.id=l.journal_id
    WHERE l.client_id=? AND l.account_id=? AND j.status='posted' GROUP BY l.party_name`, clientId, acct);
  return rows.map(r=>({party:r.party_name||'—', debit:r2(r.d), credit:r2(r.c), balance:type==='supplier'?r2(r.c-r.d):r2(r.d-r.c), last_date:r.last_date}))
    .filter(r=>r.debit||r.credit).sort((a,b)=>b.balance-a.balance);
}
export async function partyStatement(env, clientId, ctx, {type, name, from, to}){
  const acct=type==='supplier'?ctx.byId[ctx.byKey.AP]:ctx.byId[ctx.byKey.AR];
  const gl=await generalLedger(env, clientId, acct, {from, to, party:name});
  return {...gl, party:name, party_type:type};
}

export function arAging(src, base){
  const t=todayStr();
  const bal=invoiceBalances(src);
  const buckets=[['current',0],['1-30',0],['31-60',0],['61-90',0],['90+',0]].map(([key])=>({key, count:0, amount:0}));
  const items=[];
  for(const b of Object.values(bal)){
    if(b.balance<=0.009) continue;
    const due=b.invoice.due_date||String(b.invoice.doc_created_at).slice(0,10);
    const od=Math.max(0, daysBetween(due, t));
    const bk=od===0?0:od<=30?1:od<=60?2:od<=90?3:4;
    buckets[bk].count++; buckets[bk].amount=r2(buckets[bk].amount+b.balance);
    items.push({invoice_id:b.invoice.id, customer:b.invoice.customer_name||'—', title:b.invoice.title, date:String(b.invoice.doc_created_at).slice(0,10), due_date:due, currency:b.invoice.currency||base, total:b.total, paid:b.paid, credited:b.credited, tds:b.tds, balance:b.balance, overdue_days:od, bucket:buckets[bk].key, lead_id:b.invoice.lead_id});
  }
  items.sort((a,b)=>b.overdue_days-a.overdue_days);
  return {buckets, items, total:r2(items.reduce((s,i)=>s+i.balance,0))};
}

/* ── SaaS MRR (used by dashboard + metrics) ── */
export function subMrr(s){
  if(!['active','past_due'].includes(s.status)) return 0;
  const months=INTERVAL_MONTHS[s.interval]||1;
  let amt=num(s.amount)*(num(s.quantity)||1);
  if(s.discount_months_left!==0){ amt=amt*(1-num(s.discount_pct)/100)-num(s.discount_amount); }
  return r2(Math.max(0, amt)/months);
}

export async function cashPosition(env, clientId, accounts, asOf){
  const cash=accounts.filter(a=>a.type==='asset' && (a.subtype==='bank'||a.subtype==='cash'));
  const t=await accountTotals(env, clientId, {to:asOf});
  return {accounts:cash.map(a=>({account_id:a.id, name:a.name, balance:naturalBalance('asset', t[a.id])})).filter(a=>a.balance||a.name), total:r2(cash.reduce((s,a)=>s+naturalBalance('asset', t[a.id]),0))};
}
// Average monthly net cash burn over the last N full months (positive = burning).
export async function burnRate(env, clientId, accounts, months=3){
  const t=todayStr(); const end=addDays(t.slice(0,7)+'-01',-1); const start=addMonths(t.slice(0,7)+'-01',-months);
  const cf=await cashFlow(env, clientId, accounts, {from:start, to:end});
  const net=cf.months.reduce((s,m)=>s+m.net,0);
  return r2(-net/months);
}

export async function ownerDashboard(env, clientId, sync){
  const {ctx, src, settings}=sync;
  const accounts=ctx.accounts, t=todayStr();
  const [cash, bs, burn]=await Promise.all([cashPosition(env, clientId, accounts, t), balanceSheet(env, clientId, accounts, t), burnRate(env, clientId, accounts, 3)]);
  const ar=arAging(src, settings.base_currency);
  const apT=await accountTotals(env, clientId, {to:t});
  const ap=naturalBalance('liability', apT[ctx.byKey.AP]);
  const subs=await allRows(env, `SELECT * FROM acc_subscriptions WHERE client_id=?`, clientId);
  const mrr=r2(subs.reduce((s,x)=>s+subMrr(x),0));
  const months=monthsRange(addMonths(t.slice(0,7)+'-01',-5).slice(0,7), t.slice(0,7));
  const trend=[];
  for(const m of months){
    const pl=await profitAndLoss(env, clientId, accounts, {from:m+'-01', to:monthEnd(m)});
    trend.push({month:m, revenue:pl.revenue, expenses:r2(pl.cogs+pl.opex), net:pl.net_profit});
  }
  const ytd=fiscalYear(t, settings.fy_start_month);
  const plYtd=await profitAndLoss(env, clientId, accounts, {from:ytd.from, to:t});
  const topOverdue={};
  for(const i of ar.items.filter(i=>i.overdue_days>0)) topOverdue[i.customer]=r2((topOverdue[i.customer]||0)+i.balance);
  return {
    base_currency:settings.base_currency, as_of:t,
    cash:cash.total, cash_accounts:cash.accounts, receivables:ar.total, overdue_receivables:r2(ar.items.filter(i=>i.overdue_days>0).reduce((s,i)=>s+i.balance,0)), payables:ap,
    mrr, arr:r2(mrr*12), active_subscriptions:subs.filter(s=>['active','past_due'].includes(s.status)).length,
    burn_rate:burn, runway_months:burn>0?r2(cash.total/burn):null,
    revenue_ytd:plYtd.revenue, net_profit_ytd:plYtd.net_profit, gross_margin_pct_ytd:plYtd.gross_margin_pct, fy:ytd,
    total_assets:bs.total_assets, total_liabilities:bs.total_liabilities,
    trend, top_overdue:Object.entries(topOverdue).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([customer,amount])=>({customer, amount})),
    aging:ar.buckets,
  };
}

// 13-week cash forecast: opening = ledger cash today. Inflows: open invoices by due date (past-due
// ones land in week 1), subscription renewals not yet invoiced, open Financial Planning dues.
// Outflows: unpaid vendor bills by due date, recurring journals hitting cash, the last payroll
// run's net pay monthly, active fixed-expense templates monthly.
export async function cashForecast13(env, clientId, sync){
  const {ctx, src, settings}=sync; const t=todayStr();
  const cash=await cashPosition(env, clientId, ctx.accounts, t);
  const weeks=[...Array(13)].map((_,i)=>({week:i+1, start:addDays(t,i*7), end:addDays(t,i*7+6), inflow:0, outflow:0, items:[]}));
  const horizon=weeks[12].end;
  const put=(date, amount, label, dir)=>{
    if(!amount) return;
    const d=date<t?t:date; if(d>horizon) return;
    const w=weeks.find(w=>d>=w.start && d<=w.end); if(!w) return;
    w[dir]=r2(w[dir]+amount); if(w.items.length<12) w.items.push({label, amount:r2(amount), dir});
  };
  for(const i of arAging(src, settings.base_currency).items) put(i.due_date, i.balance, `Invoice #${i.invoice_id} ${i.customer}`, 'inflow');
  const subs=await allRows(env, `SELECT * FROM acc_subscriptions WHERE client_id=? AND status IN ('active','past_due','trialing') AND auto_invoice=1`, clientId);
  for(const s of subs){
    let d=s.next_billing_date; let guard=0;
    const per=num(s.amount)*(num(s.quantity)||1);
    while(d && d<=horizon && guard++<20){ put(addDays(d, settings.payment_terms_days||0), per, `${s.customer_name} renewal`, 'inflow'); d=addMonths(d, INTERVAL_MONTHS[s.interval]||1); }
  }
  for(const d of await allRows(env, `SELECT d.*, c.name AS customer_name FROM fp_expected_dues d LEFT JOIN fp_customers c ON c.id=d.customer_id WHERE d.client_id=? AND d.status IN ('open','partial')`, clientId))
    put(d.due_date, r2(num(d.amount)-num(d.collected_amount)), `Due — ${d.customer_name||'customer'}`, 'inflow');
  for(const b of src.bills.filter(b=>b.status!=='paid')) put(b.due_date||b.bill_date, num(b.total), `Bill — ${b.supplier}`, 'outflow');
  const cashIds=new Set(ctx.accounts.filter(a=>a.subtype==='bank'||a.subtype==='cash').map(a=>a.id));
  for(const rj of await allRows(env, `SELECT * FROM acc_recurring_journals WHERE client_id=? AND is_active=1`, clientId)){
    let lines=[]; try{ lines=JSON.parse(rj.lines_json); }catch(_){}
    const out=lines.filter(l=>cashIds.has(Number(l.account_id))).reduce((s,l)=>s+num(l.credit)-num(l.debit),0);
    let d=rj.next_date, g=0; const step=INTERVAL_MONTHS[rj.frequency]||1;
    while(d<=horizon && g++<20){ if(rj.end_date && d>rj.end_date) break; if(out>0) put(d, out, rj.name, 'outflow'); else if(out<0) put(d, -out, rj.name, 'inflow'); d=rj.frequency==='week'?addDays(d,7):addMonths(d, step); }
  }
  const lastPay=src.payroll.sort((a,b)=>String(b.period_month).localeCompare(a.period_month))[0];
  if(lastPay){ for(let i=0;i<4;i++){ const d=addMonths(t.slice(0,7)+'-01', i); const pd=addDays(addMonths(d,1),-1); put(pd, num(lastPay.net), 'Payroll (based on last run)', 'outflow'); } }
  for(const tpl of await allRows(env, `SELECT * FROM fp_expense_templates WHERE client_id=? AND active=1`, clientId)){
    for(let i=1;i<=3;i++) put(addMonths(t.slice(0,7)+'-01', i), num(tpl.amount), tpl.name, 'outflow');
  }
  let bal=cash.total;
  for(const w of weeks){ w.opening=r2(bal); bal=r2(bal+w.inflow-w.outflow); w.closing=bal; }
  return {opening_cash:cash.total, weeks, lowest_balance:Math.min(...weeks.map(w=>w.closing)), base_currency:settings.base_currency};
}

export async function budgetVsActual(env, clientId, accounts, settings, fy, branch){
  const fyStart=`${fy}-${String(settings.fy_start_month||4).padStart(2,'0')}-01`;
  const months=[...Array(12)].map((_,i)=>addMonths(fyStart,i).slice(0,7));
  const budgets=await allRows(env, `SELECT * FROM acc_budgets WHERE client_id=? AND fiscal_year=? AND branch=?`, clientId, fy, branch||'');
  const byAcct={}; for(const b of budgets){ try{ byAcct[b.account_id]=JSON.parse(b.months_json); }catch(_){ byAcct[b.account_id]=[]; } }
  const actual={};
  for(const m of months){
    if(m>todayStr().slice(0,7)) break;
    const t=await accountTotals(env, clientId, {from:m+'-01', to:monthEnd(m), branch, excludeTypes:['year_close']});
    for(const a of accounts) if((a.type==='income'||a.type==='expense') && t[a.id]){ (actual[a.id]=actual[a.id]||Array(12).fill(0))[months.indexOf(m)]=naturalBalance(a.type, t[a.id]); }
  }
  const rows=accounts.filter(a=>(a.type==='income'||a.type==='expense') && (byAcct[a.id]||actual[a.id])).map(a=>{
    const bud=(byAcct[a.id]||[]).map(num); while(bud.length<12) bud.push(0);
    const act=actual[a.id]||Array(12).fill(0);
    const bt=r2(bud.reduce((s,x)=>s+x,0)), at=r2(act.reduce((s,x)=>s+x,0));
    const variance=a.type==='income'?r2(at-bt):r2(bt-at);
    return {account_id:a.id, code:a.code, name:a.name, type:a.type, budget:bud, actual:act.map(r2), budget_total:bt, actual_total:at, variance, variance_pct:bt?r2(variance/bt*100):null};
  }).sort((x,y)=>String(x.code).localeCompare(String(y.code)));
  return {fy, months, rows};
}

export {range as reportRange};
export const _test={plFromTotals, computeTrialBalance, subMrr, arAging, POSTABLE_INVOICE};
