// Router for the accounting ledger module — every /accounting/ledger/* route plus the public
// client portal (/accounting/portal/<token>) and the daily job (billing run, recurring journals,
// dunning/reminders). Session-gated like the rest of the Accounting module (client_id always from
// the session), with an extra role check (acc_user_roles) on top. See accounting-core.js for the
// ledger design.
import {r2, num, str, todayStr, addDays, fiscalYear, allRows, firstRow, dbBatch, audit, accLedgerEnsureSchema, getSettings, SETTINGS_FIELDS, roleFor, ROLE_RANK,
  loadAccountContext, ledgerSync, insertJournal, expenseAccountFor, isLocked, gstSplitFor, accountTotals, naturalBalance, ACCOUNT_TYPES, SOURCE_LABELS, DERIVED_TYPES, DEFAULT_REMINDERS, DEFAULT_DUNNING, DEFAULT_PAYROLL} from './accounting-core.js';
import {trialBalance, profitAndLoss, balanceSheet, generalLedger, cashFlow, partyBalances, partyStatement, arAging, ownerDashboard, cashForecast13, budgetVsActual, reportRange} from './accounting-reports.js';
import * as saas from './accounting-saas.js';
import * as tax from './accounting-tax.js';
import * as ops from './accounting-ops.js';

class HttpError extends Error{ constructor(status, message){ super(message); this.status=status; } }
const need=(c, m, s=400)=>{ if(!c) throw new HttpError(s, m); };
const lockCheck=(settings, date)=>{ if(isLocked(settings, date)) throw new HttpError(409, `The books are locked up to ${settings.lock_date}.`); };

/* ── Settings / roles ── */
async function settingsGet(c){
  const {reminders_json, dunning_json, payroll_json, ...s}=c.settings;
  const ctx=await loadAccountContext(c.env, c.clientId, c.settings);
  return {settings:s, role:c.role, email:c.actor, accounts:ctx.accounts.filter(a=>a.is_active).map(a=>({id:a.id, code:a.code, name:a.name, type:a.type, subtype:a.subtype, system_key:a.system_key, bank_account_id:a.bank_account_id})),
    defaults:{reminders:DEFAULT_REMINDERS, dunning:DEFAULT_DUNNING, payroll:DEFAULT_PAYROLL}};
}
async function settingsSave(c){
  const b=c.body; const sets=[], vals=[];
  for(const [k,kind] of Object.entries(SETTINGS_FIELDS)){
    if(b[k]===undefined || k==='lock_date') continue; // lock_date has its own audited route
    let v=b[k];
    if(kind==='int') v=parseInt(v)||0; else if(kind==='bool') v=v?1:0; else if(kind==='id') v=v?Number(v):null;
    else if(kind==='date') v=v?str(v,10):null; else if(kind==='json') v=JSON.stringify(v&&typeof v==='object'?v:{});
    else v=str(v, kind)||null;
    if(k==='base_currency') v=String(v||'INR').toUpperCase();
    if(k==='fy_start_month') v=Math.min(12, Math.max(1, v||4));
    if(k==='default_role' && !ROLE_RANK[v]) continue;
    sets.push(`${k==='reminders'||k==='dunning'||k==='payroll'?k+'_json':k}=?`); vals.push(v);
  }
  if(!sets.length) return {ok:true};
  await c.env.DB.prepare(`UPDATE acc_settings SET ${sets.join(', ')}, updated_at=? WHERE client_id=?`).bind(...vals, new Date().toISOString(), c.clientId).run();
  await audit(c.env, c.clientId, c.actor, 'settings_update', 'settings', null, b);
  return {ok:true};
}
async function rolesList(c){ return {list:await allRows(c.env, `SELECT * FROM acc_user_roles WHERE client_id=? ORDER BY email`, c.clientId), default_role:c.settings.default_role, you:c.actor, your_role:c.role}; }
async function roleSave(c){
  const email=str(c.body.email,200).toLowerCase(); const role=c.body.role;
  need(email.includes('@'), 'A valid email is required'); need(ROLE_RANK[role], 'Unknown role');
  need(!(email===c.actor && role!=='admin'), "You can't lower your own role");
  await c.env.DB.prepare(`INSERT INTO acc_user_roles (client_id, email, role, created_at) VALUES (?,?,?,?) ON CONFLICT(client_id, email) DO UPDATE SET role=excluded.role`).bind(c.clientId, email, role, new Date().toISOString()).run();
  await audit(c.env, c.clientId, c.actor, 'role_set', 'user', email, {role});
  return {ok:true};
}
async function roleDelete(c){
  const email=str(c.body.email,200).toLowerCase(); need(email!==c.actor, "You can't remove yourself");
  await c.env.DB.prepare(`DELETE FROM acc_user_roles WHERE client_id=? AND email=?`).bind(c.clientId, email).run();
  await audit(c.env, c.clientId, c.actor, 'role_remove', 'user', email, null);
  return {ok:true};
}

/* ── Chart of accounts ── */
async function accountsList(c){
  const ctx=await loadAccountContext(c.env, c.clientId, c.settings);
  const t=await accountTotals(c.env, c.clientId, {to:todayStr()});
  const used=new Set((await allRows(c.env, `SELECT DISTINCT account_id FROM acc_journal_lines WHERE client_id=?`, c.clientId)).map(r=>r.account_id));
  return {list:ctx.accounts.sort((a,b)=>String(a.code).localeCompare(String(b.code))).map(a=>({...a, balance:naturalBalance(a.type, t[a.id]), has_entries:used.has(a.id)}))};
}
async function accountSave(c){
  const b=c.body; const ctx=await loadAccountContext(c.env, c.clientId, c.settings);
  need(str(b.code) && str(b.name), 'code and name required');
  const dup=ctx.accounts.find(a=>a.code===str(b.code,20) && a.id!==Number(b.id)); need(!dup, `Code ${b.code} is already used by ${dup?.name}`);
  if(b.parent_id) need(ctx.byId[b.parent_id] && Number(b.parent_id)!==Number(b.id), 'Invalid parent account');
  if(b.id){
    const a=ctx.byId[b.id]; need(a, 'Account not found', 404);
    const hasLines=await firstRow(c.env, `SELECT 1 x FROM acc_journal_lines WHERE client_id=? AND account_id=? LIMIT 1`, c.clientId, a.id);
    const type=b.type&&b.type!==a.type?b.type:a.type;
    need(type===a.type || !hasLines, "An account with entries can't change type — create a new one and move the balance with a journal");
    need(!(a.system_key && b.is_active===false), 'System accounts are used by automatic postings and cannot be deactivated');
    await c.env.DB.prepare(`UPDATE acc_accounts SET code=?, name=?, type=?, subtype=?, parent_id=?, description=?, is_active=? WHERE id=? AND client_id=?`)
      .bind(str(b.code,20), str(b.name,140), type, str(b.subtype??a.subtype,30)||null, b.parent_id?Number(b.parent_id):null, str(b.description??a.description,300)||null, b.is_active===false||b.is_active===0?0:1, a.id, c.clientId).run();
    await audit(c.env, c.clientId, c.actor, 'account_update', 'account', a.id, {from:{code:a.code, name:a.name, type:a.type}, to:{code:b.code, name:b.name, type}});
    return {ok:true, id:a.id};
  }
  need(ACCOUNT_TYPES.includes(b.type), 'type must be asset, liability, equity, income or expense');
  const r=await c.env.DB.prepare(`INSERT INTO acc_accounts (client_id, code, name, type, subtype, parent_id, description, is_active, created_at) VALUES (?,?,?,?,?,?,?,1,?)`)
    .bind(c.clientId, str(b.code,20), str(b.name,140), b.type, str(b.subtype,30)||null, b.parent_id?Number(b.parent_id):null, str(b.description,300)||null, new Date().toISOString()).run();
  await audit(c.env, c.clientId, c.actor, 'account_create', 'account', r.meta.last_row_id, {code:b.code, name:b.name, type:b.type});
  return {ok:true, id:r.meta.last_row_id};
}
async function accountDelete(c){
  const a=await firstRow(c.env, `SELECT * FROM acc_accounts WHERE id=? AND client_id=?`, Number(c.body.id), c.clientId); need(a, 'Account not found', 404);
  need(!a.system_key && !a.bank_account_id, 'System and bank-linked accounts cannot be deleted');
  const used=await firstRow(c.env, `SELECT 1 x FROM acc_journal_lines WHERE client_id=? AND account_id=? LIMIT 1`, c.clientId, a.id);
  need(!used, 'This account has entries — deactivate it instead');
  await c.env.DB.prepare(`DELETE FROM acc_accounts WHERE id=?`).bind(a.id).run();
  await c.env.DB.prepare(`DELETE FROM acc_category_map WHERE client_id=? AND account_id=?`).bind(c.clientId, a.id).run();
  await audit(c.env, c.clientId, c.actor, 'account_delete', 'account', a.id, {code:a.code, name:a.name});
  return {ok:true};
}
async function categoryMapList(c){
  const cats=new Set();
  for(const r of await allRows(c.env, `SELECT DISTINCT category FROM accounting_expenses WHERE client_id=? AND category IS NOT NULL AND category!=''`, c.clientId)) cats.add(String(r.category).toLowerCase());
  for(const r of await allRows(c.env, `SELECT DISTINCT category FROM fp_expenses WHERE client_id=? AND category IS NOT NULL AND category!=''`, c.clientId)) cats.add(String(r.category).toLowerCase());
  const map=await allRows(c.env, `SELECT * FROM acc_category_map WHERE client_id=?`, c.clientId);
  for(const m of map) cats.add(m.category);
  const ctx=await loadAccountContext(c.env, c.clientId, c.settings);
  return {list:[...cats].sort().map(cat=>{ const m=map.find(x=>x.category===cat); return {category:cat, account_id:m?.account_id||null, effective_account_id:m?.account_id||expenseAccountFor(ctx, cat)}; })};
}
async function categoryMapSave(c){
  const cat=str(c.body.category,100).toLowerCase(); need(cat, 'category required');
  if(c.body.account_id) await c.env.DB.prepare(`INSERT INTO acc_category_map (client_id, category, account_id) VALUES (?,?,?) ON CONFLICT(client_id, category) DO UPDATE SET account_id=excluded.account_id`).bind(c.clientId, cat, Number(c.body.account_id)).run();
  else await c.env.DB.prepare(`DELETE FROM acc_category_map WHERE client_id=? AND category=?`).bind(c.clientId, cat).run();
  await audit(c.env, c.clientId, c.actor, 'category_map', 'category', cat, {account_id:c.body.account_id||null});
  return {ok:true};
}

/* ── Journals ── */
async function journalsList(c){
  const u=c.url.searchParams; const {from, to}=reportRange(c.url);
  let sql=`SELECT * FROM acc_journals WHERE client_id=? AND entry_date>=? AND entry_date<=?`; const b=[c.clientId, from, to];
  if(u.get('source_type')){ sql+=` AND source_type=?`; b.push(u.get('source_type')); }
  if(u.get('status')){ sql+=` AND status=?`; b.push(u.get('status')); } else sql+=` AND status='posted'`;
  if(u.get('q')){ sql+=` AND (memo LIKE ? OR CAST(entry_no AS TEXT)=?)`; b.push(`%${str(u.get('q'),80)}%`, str(u.get('q'),20)); }
  sql+=` ORDER BY entry_date DESC, entry_no DESC LIMIT ? OFFSET ?`;
  const limit=Math.min(500, parseInt(u.get('limit'))||200), offset=Math.max(0, parseInt(u.get('offset'))||0);
  b.push(limit, offset);
  const list=await allRows(c.env, sql, ...b);
  const ids=list.map(j=>j.id);
  const lines=ids.length?await allRows(c.env, `SELECT l.*, a.code, a.name AS account_name FROM acc_journal_lines l LEFT JOIN acc_accounts a ON a.id=l.account_id WHERE l.client_id=? AND l.journal_id IN (${ids.map(()=>'?').join(',')}) ORDER BY l.id`, c.clientId, ...ids):[];
  const byJ={}; for(const l of lines) (byJ[l.journal_id]=byJ[l.journal_id]||[]).push(l);
  return {list:list.map(j=>({...j, source_label:SOURCE_LABELS[j.source_type]||j.source_type, editable:!DERIVED_TYPES.includes(j.source_type) && j.status==='posted' && !isLocked(c.settings, j.entry_date), lines:byJ[j.id]||[]})), limit, offset};
}
async function journalCreate(c){
  const ctx=await loadAccountContext(c.env, c.clientId, c.settings);
  const r=await insertJournal(c.env, c.clientId, c.settings, ctx, {date:c.body.date, memo:c.body.memo, lines:c.body.lines, actor:c.actor, branch:str(c.body.branch,60)||null});
  return {ok:true, ...r};
}
async function getManual(c, id){
  const j=await firstRow(c.env, `SELECT * FROM acc_journals WHERE id=? AND client_id=?`, Number(id), c.clientId); need(j, 'Journal not found', 404);
  need(!DERIVED_TYPES.includes(j.source_type), `This entry is posted automatically from a ${SOURCE_LABELS[j.source_type]||j.source_type} — edit that document instead.`);
  return j;
}
async function journalUpdate(c){
  const j=await getManual(c, c.body.id); need(j.status==='posted', 'Journal is void');
  lockCheck(c.settings, j.entry_date); lockCheck(c.settings, c.body.date||j.entry_date);
  const ctx=await loadAccountContext(c.env, c.clientId, c.settings);
  const old=await allRows(c.env, `SELECT account_id, debit, credit, description, party_name FROM acc_journal_lines WHERE journal_id=?`, j.id);
  // Validate by writing the replacement first (same checks as create), then swap it in under the old id/number.
  const tmp=await insertJournal(c.env, c.clientId, c.settings, ctx, {date:c.body.date||j.entry_date, memo:c.body.memo??j.memo, lines:c.body.lines, actor:c.actor, source_type:'tmp_edit', branch:str(c.body.branch??j.branch,60)||null});
  await dbBatch(c.env, [
    c.env.DB.prepare(`DELETE FROM acc_journal_lines WHERE journal_id=?`).bind(j.id),
    c.env.DB.prepare(`UPDATE acc_journal_lines SET journal_id=? WHERE journal_id=?`).bind(j.id, tmp.id),
    c.env.DB.prepare(`UPDATE acc_journals SET entry_date=(SELECT entry_date FROM acc_journals WHERE id=?), memo=(SELECT memo FROM acc_journals WHERE id=?), total=(SELECT total FROM acc_journals WHERE id=?), branch=(SELECT branch FROM acc_journals WHERE id=?), updated_at=? WHERE id=?`).bind(tmp.id, tmp.id, tmp.id, tmp.id, new Date().toISOString(), j.id),
    c.env.DB.prepare(`DELETE FROM acc_journals WHERE id=?`).bind(tmp.id),
  ]);
  await audit(c.env, c.clientId, c.actor, 'journal_update', 'journal', j.id, {before:{date:j.entry_date, memo:j.memo, lines:old}, after:{date:c.body.date, memo:c.body.memo, lines:c.body.lines}});
  return {ok:true};
}
async function journalVoid(c){
  const j=await getManual(c, c.body.id); need(j.status==='posted', 'Already void'); lockCheck(c.settings, j.entry_date);
  const now=new Date().toISOString();
  await c.env.DB.prepare(`UPDATE acc_journals SET status='void', voided_at=?, void_reason=?, updated_at=? WHERE id=?`).bind(now, str(c.body.reason,300)||'Voided', now, j.id).run();
  await audit(c.env, c.clientId, c.actor, 'journal_void', 'journal', j.id, {reason:c.body.reason||null});
  return {ok:true};
}
// Reversal works on ANY posted entry (including automatic ones in a locked period) — it's the
// audit-safe way to correct closed books.
async function journalReverse(c){
  const j=await firstRow(c.env, `SELECT * FROM acc_journals WHERE id=? AND client_id=?`, Number(c.body.id), c.clientId); need(j && j.status==='posted', 'Journal not found', 404);
  const lines=await allRows(c.env, `SELECT * FROM acc_journal_lines WHERE journal_id=?`, j.id);
  const ctx=await loadAccountContext(c.env, c.clientId, c.settings);
  const r=await insertJournal(c.env, c.clientId, c.settings, ctx, {date:c.body.date||todayStr(), memo:`Reversal of #${j.entry_no}: ${j.memo||''}`, actor:c.actor, reversal_of:j.id,
    lines:lines.map(l=>({account_id:l.account_id, debit:l.credit, credit:l.debit, description:l.description, party_type:l.party_type, party_name:l.party_name}))});
  return {ok:true, ...r};
}
async function lockSet(c){
  const d=c.body.lock_date?str(c.body.lock_date,10):null;
  need(!d || /^\d{4}-\d{2}-\d{2}$/.test(d), 'lock_date must be YYYY-MM-DD');
  need(!d || d<=todayStr(), "Can't lock a future date");
  await c.env.DB.prepare(`UPDATE acc_settings SET lock_date=?, updated_at=? WHERE client_id=?`).bind(d, new Date().toISOString(), c.clientId).run();
  await audit(c.env, c.clientId, c.actor, d?'period_lock':'period_unlock', 'settings', null, {from:c.settings.lock_date||null, to:d});
  return {ok:true, lock_date:d};
}
// Year-end close: zero every income/expense account for the FY into Retained Earnings with one
// dated entry, then lock the year. P&L reports ignore year_close entries.
async function closeYear(c){
  const fyStart=parseInt(c.body.fy); need(fyStart>2000, 'fy (starting year) required');
  const fy=fiscalYear(`${fyStart}-${String(c.settings.fy_start_month||4).padStart(2,'0')}-01`, c.settings.fy_start_month);
  need(fy.to<todayStr(), 'That financial year has not ended yet');
  const exists=await firstRow(c.env, `SELECT id FROM acc_journals WHERE client_id=? AND source_type='year_close' AND source_ref=? AND status='posted'`, c.clientId, `FY${fyStart}`);
  need(!exists, 'This year is already closed — void its closing entry (after unlocking) to reopen it');
  const sync=await ledgerSync(c.env, c.clientId, c.actor);
  if(isLocked(c.settings, fy.to)) throw new HttpError(409, `Unlock the books (currently locked to ${c.settings.lock_date}) before closing, the closing entry is dated ${fy.to}.`);
  const t=await accountTotals(c.env, c.clientId, {from:fy.from, to:fy.to, excludeTypes:['year_close']});
  const lines=[]; let net=0;
  for(const a of sync.ctx.accounts){
    if(a.type!=='income' && a.type!=='expense') continue;
    const x=t[a.id]; if(!x) continue; const d=r2(x.debit-x.credit); if(!d) continue;
    lines.push(d>0?{account_id:a.id, credit:d}:{account_id:a.id, debit:-d}); net=r2(net+d);
  }
  need(lines.length, 'Nothing to close for that year');
  if(net>0) lines.push({account_id:sync.ctx.byKey.RETAINED, debit:net}); else if(net<0) lines.push({account_id:sync.ctx.byKey.RETAINED, credit:-net});
  const r=await insertJournal(c.env, c.clientId, c.settings, sync.ctx, {date:fy.to, memo:`Year-end close FY ${fy.from} → ${fy.to}`, lines, source_type:'year_close', source_ref:`FY${fyStart}`, actor:c.actor});
  const lock=c.settings.lock_date && c.settings.lock_date>fy.to?c.settings.lock_date:fy.to;
  await c.env.DB.prepare(`UPDATE acc_settings SET lock_date=?, updated_at=? WHERE client_id=?`).bind(lock, new Date().toISOString(), c.clientId).run();
  await audit(c.env, c.clientId, c.actor, 'year_close', 'journal', r.id, {fy:fyStart, net_profit:-net, locked_to:lock});
  return {ok:true, journal_id:r.id, net_profit:r2(-net), locked_to:lock};
}
async function auditList(c){
  const u=c.url.searchParams; let sql=`SELECT * FROM acc_audit_log WHERE client_id=?`; const b=[c.clientId];
  if(u.get('entity_type')){ sql+=` AND entity_type=?`; b.push(u.get('entity_type')); }
  if(u.get('actor')){ sql+=` AND actor=?`; b.push(u.get('actor')); }
  if(u.get('hide_sync')==='1') sql+=` AND action!='ledger_sync'`;
  sql+=` ORDER BY id DESC LIMIT ? OFFSET ?`; b.push(Math.min(500, parseInt(u.get('limit'))||200), Math.max(0, parseInt(u.get('offset'))||0));
  return {list:await allRows(c.env, sql, ...b)};
}

/* ── Credit / debit notes ── */
async function notesList(c){ return {list:await allRows(c.env, `SELECT * FROM acc_notes WHERE client_id=? ORDER BY note_date DESC, id DESC LIMIT 500`, c.clientId)}; }
async function noteCreate(c){
  const b=c.body; const type=b.note_type==='debit'?'debit':'credit';
  const date=str(b.note_date,10)||todayStr(); lockCheck(c.settings, date);
  let party=str(b.party_name,200), currency=str(b.currency,10)||c.settings.base_currency, pos=str(b.place_of_supply,10)||null, gstin=str(b.recipient_gstin,15)||null, rate=num(b.gst_rate_pct), linkedType=null, linkedId=null;
  const reason=['return','discount','write_off','refund','other'].includes(b.reason)?b.reason:'return';
  let sub=num(b.subtotal);
  if(type==='credit' && b.linked_id){
    const inv=await firstRow(c.env, `SELECT * FROM accounting_documents WHERE id=? AND client_id=? AND type='invoice'`, Number(b.linked_id), c.clientId); need(inv, 'Invoice not found', 404);
    linkedType='invoice'; linkedId=inv.id; party=party||inv.customer_name; currency=inv.currency||currency; pos=pos||inv.place_of_supply; gstin=gstin||inv.recipient_gstin;
    if(b.gst_rate_pct==null||b.gst_rate_pct==='') rate=num(inv.gst_rate_pct);
    const prior=(await firstRow(c.env, `SELECT SUM(total) s FROM acc_notes WHERE client_id=? AND linked_type='invoice' AND linked_id=? AND note_type='credit' AND status!='void'`, c.clientId, inv.id))?.s||0;
    const g=reason==='write_off'?0:r2(sub*rate/100);
    need(r2(sub+g)<=r2(num(inv.total)-prior)+0.01, `Credit exceeds what's left on Invoice #${inv.id} (${r2(num(inv.total)-prior)})`);
  }
  if(type==='debit' && b.linked_id){
    const bill=await firstRow(c.env, `SELECT * FROM accounting_vendor_bills WHERE id=? AND client_id=?`, Number(b.linked_id), c.clientId); need(bill, 'Bill not found', 404);
    linkedType='vendor_bill'; linkedId=bill.id; party=party||bill.supplier; currency=bill.currency||currency;
  }
  need(party, 'party_name required'); need(sub>0, 'Amount must be positive');
  const g=reason==='write_off'?{cgst:0,sgst:0,igst:0}:gstSplitFor(sub, rate, c.settings.state_code, type==='credit'?pos:(str(b.supplier_state,10)||null));
  const total=r2(sub+g.cgst+g.sgst+g.igst);
  const r=await c.env.DB.prepare(`INSERT INTO acc_notes (client_id, note_type, note_date, party_name, linked_type, linked_id, reason, currency, subtotal, gst_rate_pct, cgst, sgst, igst, total, place_of_supply, recipient_gstin, refund_account_id, refund_date, status, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?)`)
    .bind(c.clientId, type, date, party, linkedType, linkedId, reason, currency, r2(sub), reason==='write_off'?0:rate, g.cgst, g.sgst, g.igst, total, pos, gstin, reason==='refund'&&b.refund_account_id?Number(b.refund_account_id):null, reason==='refund'?(str(b.refund_date,10)||date):null, str(b.notes,500)||null, new Date().toISOString()).run();
  await audit(c.env, c.clientId, c.actor, `${type}_note_create`, 'note', r.meta.last_row_id, {party, total, reason, linked_id:linkedId});
  return {ok:true, id:r.meta.last_row_id, total};
}
async function noteVoid(c){
  const n=await firstRow(c.env, `SELECT * FROM acc_notes WHERE id=? AND client_id=?`, Number(c.body.id), c.clientId); need(n, 'Note not found', 404);
  lockCheck(c.settings, n.note_date);
  await c.env.DB.prepare(`UPDATE acc_notes SET status='void' WHERE id=?`).bind(n.id).run();
  await audit(c.env, c.clientId, c.actor, 'note_void', 'note', n.id, null);
  return {ok:true};
}
async function docMetaSave(c){
  const b=c.body; const d=await firstRow(c.env, `SELECT id, doc_created_at FROM accounting_documents WHERE id=? AND client_id=?`, Number(b.doc_id), c.clientId); need(d, 'Document not found', 404);
  lockCheck(c.settings, String(d.doc_created_at).slice(0,10));
  await saas.upsertDocMeta(c.env, c.clientId, d.id, {revenue_account_id:b.revenue_account_id?Number(b.revenue_account_id):null, branch:str(b.branch,60)||null});
  await audit(c.env, c.clientId, c.actor, 'doc_meta', 'invoice', d.id, b);
  return {ok:true};
}

/* ── Reports ── */
const withSync=fn=>async c=>{ const sync=await ledgerSync(c.env, c.clientId, c.actor); return fn(c, sync); };
const ROUTES=[
  // [method, path, minRole, handler]
  ['GET','me','viewer',async c=>({role:c.role, email:c.actor, base_currency:c.settings.base_currency, lock_date:c.settings.lock_date})],
  ['GET','settings','viewer',settingsGet], ['POST','settings','admin',settingsSave],
  ['GET','roles','admin',rolesList], ['POST','roles','admin',roleSave], ['POST','roles/delete','admin',roleDelete],
  ['GET','accounts','viewer',accountsList], ['POST','accounts','accountant',accountSave], ['POST','accounts/delete','admin',accountDelete],
  ['GET','category-map','viewer',categoryMapList], ['POST','category-map','accountant',categoryMapSave],
  ['POST','sync','accountant',async c=>{ const s=await ledgerSync(c.env, c.clientId, c.actor); return {ok:true, posted:s.posted, reposted:s.reposted, voided:s.voided, warnings:s.warnings}; }],
  ['GET','journals','viewer',withSync(journalsList)], ['POST','journals','accountant',journalCreate], ['POST','journals/update','accountant',journalUpdate],
  ['POST','journals/void','accountant',journalVoid], ['POST','journals/reverse','accountant',journalReverse],
  ['POST','lock','admin',lockSet], ['POST','close-year','admin',closeYear], ['GET','audit','viewer',auditList],
  ['GET','notes','viewer',notesList], ['POST','notes','accountant',noteCreate], ['POST','notes/void','accountant',noteVoid], ['POST','doc-meta','accountant',docMetaSave],
  ['GET','trial-balance','viewer',withSync(async (c,s)=>{ const {from,to}=reportRange(c.url); return {from, to, base_currency:c.settings.base_currency, warnings:s.warnings, ...(await trialBalance(c.env, c.clientId, s.ctx.accounts, {from, to, branch:c.url.searchParams.get('branch')||null}))}; })],
  ['GET','pl','viewer',withSync(async (c,s)=>{
    const {from,to}=reportRange(c.url); const branch=c.url.searchParams.get('branch')||null; const cmp=c.url.searchParams.get('compare');
    const cur=await profitAndLoss(c.env, c.clientId, s.ctx.accounts, {from, to, branch});
    let compare=null;
    if(cmp==='prev'){ const days=Math.round((new Date(to)-new Date(from))/86400000)+1; const pto=addDays(from,-1), pfrom=addDays(pto,-(days-1)); compare={label:`${pfrom} → ${pto}`, from:pfrom, to:pto, ...(await profitAndLoss(c.env, c.clientId, s.ctx.accounts, {from:pfrom, to:pto, branch}))}; }
    else if(cmp==='yoy'){ const y=d=>`${Number(d.slice(0,4))-1}${d.slice(4)}`; compare={label:`${y(from)} → ${y(to)}`, from:y(from), to:y(to), ...(await profitAndLoss(c.env, c.clientId, s.ctx.accounts, {from:y(from), to:y(to), branch}))}; }
    return {from, to, base_currency:c.settings.base_currency, warnings:s.warnings, ...cur, compare};
  })],
  ['GET','balance-sheet','viewer',withSync(async (c,s)=>{ const asOf=c.url.searchParams.get('as_of')||todayStr(); const cmp=c.url.searchParams.get('compare_as_of');
    return {base_currency:c.settings.base_currency, warnings:s.warnings, ...(await balanceSheet(c.env, c.clientId, s.ctx.accounts, asOf, c.url.searchParams.get('branch')||null)), compare:cmp?await balanceSheet(c.env, c.clientId, s.ctx.accounts, cmp):null}; })],
  ['GET','general-ledger','viewer',withSync(async (c,s)=>{ const {from,to}=reportRange(c.url); const a=s.ctx.byId[Number(c.url.searchParams.get('account_id'))]; need(a, 'account_id required');
    return {base_currency:c.settings.base_currency, ...(await generalLedger(c.env, c.clientId, a, {from, to, party:c.url.searchParams.get('party')||null}))}; })],
  ['GET','cash-flow','viewer',withSync(async (c,s)=>{ const {from,to}=reportRange(c.url); return {from, to, base_currency:c.settings.base_currency, ...(await cashFlow(c.env, c.clientId, s.ctx.accounts, {from, to}))}; })],
  ['GET','parties','viewer',withSync(async (c,s)=>({list:await partyBalances(c.env, c.clientId, s.ctx, c.url.searchParams.get('type')==='supplier'?'supplier':'customer'), base_currency:c.settings.base_currency}))],
  ['GET','party-statement','viewer',withSync(async (c,s)=>{ const {from,to}=reportRange(c.url); const name=c.url.searchParams.get('name'); need(name, 'name required');
    return {base_currency:c.settings.base_currency, business_name:c.settings.business_name||'', ...(await partyStatement(c.env, c.clientId, s.ctx, {type:c.url.searchParams.get('type')==='supplier'?'supplier':'customer', name, from, to}))}; })],
  ['GET','ar-aging','viewer',withSync(async (c,s)=>({base_currency:c.settings.base_currency, ...arAging(s.src, c.settings.base_currency)}))],
  ['GET','dashboard','viewer',withSync(async (c,s)=>({...(await ownerDashboard(c.env, c.clientId, s)), warnings:s.warnings, anomalies:(await ops.anomalies(c.env, c.clientId, s)).slice(0,8)}))],
  ['GET','forecast','viewer',withSync(async (c,s)=>cashForecast13(c.env, c.clientId, s))],
  ['GET','budget','viewer',withSync(async (c,s)=>budgetVsActual(c.env, c.clientId, s.ctx.accounts, c.settings, parseInt(c.url.searchParams.get('fy'))||fiscalYear(todayStr(), c.settings.fy_start_month).fy, c.url.searchParams.get('branch')||''))],
  ['POST','budget','accountant',ops.budgetSave], ['POST','budget/from-actuals','accountant',ops.budgetFromActuals],
  ['GET','anomalies','viewer',withSync(async (c,s)=>({list:await ops.anomalies(c.env, c.clientId, s)}))],
  ['GET','unit-economics','viewer',withSync(async (c)=>{ const {from,to}=reportRange(c.url); return {base_currency:c.settings.base_currency, ...(await ops.unitEconomics(c.env, c.clientId, c.settings, {from, to}))}; })],
  // SaaS
  ['GET','plans','viewer',saas.plansList], ['POST','plans','accountant',saas.planSave],
  ['GET','coupons','viewer',saas.couponsList], ['POST','coupons','accountant',saas.couponSave],
  ['GET','subscriptions','viewer',saas.subscriptionsList], ['POST','subscriptions','accountant',saas.subscriptionCreate], ['POST','subscriptions/update','accountant',saas.subscriptionUpdate],
  ['POST','subscriptions/change','accountant',saas.subscriptionChange], ['POST','subscriptions/action','accountant',saas.subscriptionAction], ['GET','subscription-events','viewer',saas.subscriptionEvents],
  ['POST','billing-run','accountant',saas.billingRun], ['POST','import-fp-customers','accountant',saas.importFpCustomers],
  ['GET','usage','viewer',saas.usageList], ['POST','usage','accountant',saas.usageCreate],
  ['GET','revrec','viewer',saas.revrecList], ['POST','revrec','accountant',saas.revrecSave], ['POST','revrec/delete','accountant',saas.revrecDelete],
  ['GET','metrics','viewer',withSync(async (c,s)=>saas.computeSaasMetrics(c.env, c.clientId, s))],
  ['GET','reminders-log','viewer',saas.remindersLog], ['POST','collections-run','accountant',saas.runCollectionsNow],
  ['GET','settlements','viewer',saas.settlementsList], ['POST','settlements','accountant',saas.settlementSave], ['POST','settlements/delete','accountant',saas.settlementDelete], ['POST','settlements/import','accountant',saas.settlementImport],
  // Tax
  ['GET','gstr1','viewer',tax.gstr1], ['GET','gstr3b','viewer',tax.gstr3b], ['GET','purchase-register','viewer',tax.purchaseRegister], ['POST','purchase-meta','accountant',tax.purchaseMetaSave],
  ['GET','tds','viewer',tax.tdsRegister], ['POST','tds/challan','accountant',tax.tdsChallanSave], ['POST','tds/receivable','accountant',tax.tdsReceivableSave], ['POST','tds/delete','accountant',tax.tdsDelete], ['POST','tds/26as','viewer',tax.tds26asReconcile],
  ['GET','einvoice','viewer',tax.einvoiceJson], ['POST','einvoice','accountant',tax.einvoiceSave],
  ['GET','fx','viewer',tax.fxList], ['POST','fx','accountant',tax.fxSave], ['POST','fx/delete','accountant',tax.fxDelete], ['GET','fx/revaluation','viewer',tax.fxRevaluation],
  // Operations
  ['GET','recurring','viewer',ops.recurringList], ['POST','recurring','accountant',ops.recurringSave], ['POST','recurring/delete','accountant',ops.recurringDelete], ['POST','recurring/run','accountant',ops.recurringRunNow],
  ['GET','bank-rules','viewer',ops.bankRulesList], ['POST','bank-rules','accountant',ops.bankRuleSave], ['POST','bank-rules/delete','accountant',ops.bankRuleDelete],
  ['GET','bank-unmatched','viewer',ops.bankUnmatched], ['POST','bank-categorize','accountant',ops.bankCategorize], ['POST','payment-account','accountant',ops.paymentAccountSet],
  ['GET','approvals','viewer',ops.approvalsList], ['POST','approvals/decide','approver',ops.approvalDecide],
  ['GET','assets','viewer',ops.assetsList], ['POST','assets','accountant',ops.assetSave], ['POST','assets/delete','accountant',ops.assetDelete],
  ['GET','employees','accountant',ops.employeesList], ['POST','employees','accountant',ops.employeeSave],
  ['GET','payroll','accountant',ops.payrollList], ['POST','payroll/prepare','accountant',ops.payrollPrepare], ['POST','payroll/action','accountant',ops.payrollAction],
  ['GET','allocations','viewer',ops.allocationsList], ['POST','allocations','accountant',ops.allocationSave], ['POST','allocations/delete','accountant',ops.allocationDelete],
  ['POST','payment-link','accountant',ops.paymentLinkCreate],
  ['GET','portal-tokens','viewer',ops.portalTokens], ['POST','portal-tokens','accountant',ops.portalTokenCreate], ['POST','portal-tokens/revoke','accountant',ops.portalTokenRevoke],
  ['GET','export/tally','viewer',ops.exportTally], ['GET','export/journals','viewer',ops.exportJournals],
  ['GET','categorize','accountant',withSync(ops.categorizeSuggestions)], ['POST','categorize/apply','accountant',ops.categorizeApply],
];
const ROUTE_MAP=new Map(ROUTES.map(([m,p,role,h])=>[`${m} ${p}`, {role, h}]));

function wireDeps(deps){
  const d={sendEmail:deps.sendEmail, sendWhatsApp:deps.sendWhatsApp, recordInvoicePaid:deps.recordInvoicePaid, getClientById:deps.getClientById};
  saas.setSaasDeps(d); ops.setOpsDeps(d);
  return d;
}
const corsJson=(deps, data, status)=>deps.json(data, status);

export async function accLedgerHandleRoute(request, env, deps, url){
  wireDeps(deps);
  // Public client portal — the token in the path is the credential.
  if(url.pathname.startsWith('/accounting/portal/') && request.method==='GET'){
    try{
      await accLedgerEnsureSchema(env);
      const tok=await firstRow(env, `SELECT client_id FROM acc_portal_tokens WHERE token=?`, str(url.pathname.slice('/accounting/portal/'.length),64));
      if(tok && deps.isAccountingEnabled && !await deps.isAccountingEnabled(env, tok.client_id)) return corsJson(deps, {error:'This link is no longer valid.'}, 404);
      return corsJson(deps, await ops.portalView(env, url.pathname.slice('/accounting/portal/'.length), deps));
    }
    catch(e){ return corsJson(deps, {error:e.status?e.message:'Something went wrong'}, e.status||500); }
  }
  const path=url.pathname.slice('/accounting/ledger/'.length).replace(/\/+$/,'');
  const route=ROUTE_MAP.get(`${request.method} ${path}`);
  if(!route) return corsJson(deps, {error:'Not found'}, 404);
  const payload=await deps.requireSession(request, env);
  if(!payload) return corsJson(deps, {error:'Invalid or expired session'}, 401);
  const clientId=Number(payload.cid);
  // The whole module is switched on per client by the Leadvyne admin (clients.accounting_enabled).
  if(deps.isAccountingEnabled && !await deps.isAccountingEnabled(env, clientId))
    return corsJson(deps, {error:'The Accounting module is not enabled for this account. Contact Leadvyne to turn it on.', module_disabled:true}, 403);
  try{
    await accLedgerEnsureSchema(env);
    const settings=await getSettings(env, clientId);
    const actor=String(payload.email||'').toLowerCase()||'owner';
    const role=await roleFor(env, clientId, payload.email, settings);
    if((ROLE_RANK[role]||0)<ROLE_RANK[route.role]) return corsJson(deps, {error:`Your role (${role}) can't do this — it needs ${route.role} access.`}, 403);
    const body=request.method==='POST'?await request.json().catch(()=>({})):{};
    const c={env, clientId, actor, role, settings, body, url, deps};
    return corsJson(deps, await route.h(c));
  }catch(e){
    const status=e.status||500;
    if(status>=500 && deps.reportOpsError) await deps.reportOpsError(env, `accounting ledger ${request.method} ${path}`, e, {clientId}).catch(()=>{});
    return corsJson(deps, {error:status>=500?`Something went wrong: ${String(e.message||e).slice(0,200)}`:e.message}, status);
  }
}

// Daily: subscription billing, recurring journals, dunning / invoice reminders — only for clients
// who have opened the ledger (an acc_settings row exists) and whose module is enabled in admin.
export async function accLedgerRunDaily(env, deps){
  if(!env?.DB) return;
  wireDeps(deps);
  try{ await accLedgerEnsureSchema(env); }catch(e){ return; }
  const clients=await allRows(env, `SELECT client_id FROM acc_settings`);
  for(const {client_id} of clients){
    if(deps.isAccountingEnabled && !await deps.isAccountingEnabled(env, client_id)) continue;
    try{
      const settings=await getSettings(env, client_id);
      await saas.runBillingForClient(env, client_id, settings);
      await ops.runRecurringForClient(env, client_id);
      await saas.runCollectionsForClient(env, client_id, deps);
    }catch(e){ if(deps.reportOpsError) await deps.reportOpsError(env, 'accounting ledger daily', e, {clientId:client_id}).catch(()=>{}); }
  }
}
export const accLedgerOnExpenseCreated=ops.onExpenseCreated;
export const accLedgerOnPaymentLinkPaid=ops.onRazorpayPaymentLinkPaid;
export {ROUTES as _ROUTES};
