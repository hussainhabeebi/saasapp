// Indian tax compliance off the same data the ledger posts: GSTR-1 / GSTR-3B working papers,
// the purchase tax register (GST input credit, reverse charge, TDS per bill/expense), TDS
// challans + 26Q-style deduction register + 26AS reconciliation, e-invoice (IRP) JSON, and
// foreign-exchange rates with an unrealised-gain/loss revaluation of open invoices and bills.
// Returns are prepared here for filing on the GST/TRACES portals or through a GSP — this module
// never files anything itself.
import {r2, num, str, todayStr, addDays, monthEnd, allRows, firstRow, audit, loadSources, invoiceBalances, makeFx, POSTABLE_INVOICE, docDate, getSettings} from './accounting-core.js';
import {HttpError, parseCsv, normDate} from './accounting-saas.js';

const need=(c, m, s=400)=>{ if(!c) throw new HttpError(s, m); };
const monthParam=c=>{ const m=str(c.url.searchParams.get('month'),7)||todayStr().slice(0,7); need(/^\d{4}-\d{2}$/.test(m), 'month must be YYYY-MM'); return m; };
const lineItems=d=>{ try{ const l=JSON.parse(d.line_items_json||'[]'); return Array.isArray(l)?l:[]; }catch(_){ return []; } };
// GSTR-1 B2CL threshold (inter-state B2C invoices above this are reported invoice-wise).
const B2CL_LIMIT=100000;

function taxParts(d){
  const tax=r2(num(d.total)-num(d.subtotal));
  const c=num(d.cgst_amount), s=num(d.sgst_amount), i=num(d.igst_amount); const sum=c+s+i;
  if(!tax) return {cgst:0, sgst:0, igst:0};
  if(sum>0) return {cgst:r2(c*tax/sum), sgst:r2(s*tax/sum), igst:r2(i*tax/sum)};
  return {cgst:0, sgst:0, igst:tax};
}

export async function gstr1(c){
  const m=monthParam(c); const from=`${m}-01`, to=monthEnd(m);
  const src=await loadSources(c.env, c.clientId); const s=c.settings;
  const fx=makeFx(src.rates, s.base_currency, []);
  const inv=src.docs.filter(d=>d.type==='invoice' && POSTABLE_INVOICE.has(d.status) && docDate(d)>=from && docDate(d)<=to);
  const b2b=[], b2cl=[], b2csMap={}, exp=[], hsn={};
  for(const d of inv){
    const rate=fx(d.currency, docDate(d));
    const t=taxParts(d); const row={invoice_id:d.id, invoice_no:`INV-${d.id}`, date:docDate(d), customer:d.customer_name, gstin:d.recipient_gstin||'', pos:d.place_of_supply||'', rate:num(d.gst_rate_pct),
      taxable:r2(num(d.subtotal)*rate), igst:r2(t.igst*rate), cgst:r2(t.cgst*rate), sgst:r2(t.sgst*rate), value:r2(num(d.total)*rate), reverse_charge:d.reverse_charge?'Y':'N', currency:d.currency};
    if(d.supply_type==='EXPORT') exp.push({...row, export_type:row.igst?'WPAY':'WOPAY', lut:row.igst?'':(s.lut_number||'')});
    else if(d.recipient_gstin) b2b.push(row);
    else if(row.igst && row.value>B2CL_LIMIT) b2cl.push(row);
    else{ const k=`${row.pos}|${row.rate}`; const g=b2csMap[k]=b2csMap[k]||{pos:row.pos, rate:row.rate, taxable:0, igst:0, cgst:0, sgst:0, type:row.igst?'Inter-state':'Intra-state'}; for(const f of ['taxable','igst','cgst','sgst']) g[f]=r2(g[f]+row[f]); }
    // HSN/SAC summary — line-level, tax allocated pro-rata to each line's share of the subtotal.
    const lines=lineItems(d); const sub=num(d.subtotal)||1;
    for(const l of lines){
      const code=str(l.hsn||l.hsn_sac||l.sac,10)||'NA'; const lv=num(l.qty)*num(l.price); const share=lv/sub;
      const h=hsn[code]=hsn[code]||{hsn:code, description:str(l.name,80), qty:0, taxable:0, igst:0, cgst:0, sgst:0};
      h.qty=r2(h.qty+num(l.qty)); h.taxable=r2(h.taxable+lv*rate); h.igst=r2(h.igst+t.igst*share*rate); h.cgst=r2(h.cgst+t.cgst*share*rate); h.sgst=r2(h.sgst+t.sgst*share*rate);
    }
  }
  const notes=src.notes.filter(n=>n.note_type==='credit' && n.status!=='void' && n.reason!=='write_off' && n.note_date>=from && n.note_date<=to).map(n=>({
    note_no:`CN-${n.id}`, date:n.note_date, party:n.party_name, gstin:n.recipient_gstin||'', against:n.linked_type==='invoice'?`INV-${n.linked_id}`:'', pos:n.place_of_supply||'',
    taxable:r2(num(n.subtotal)*fx(n.currency,n.note_date)), igst:r2(num(n.igst)*fx(n.currency,n.note_date)), cgst:r2(num(n.cgst)*fx(n.currency,n.note_date)), sgst:r2(num(n.sgst)*fx(n.currency,n.note_date)), value:r2(num(n.total)*fx(n.currency,n.note_date))}));
  const ids=inv.map(d=>d.id).sort((a,b)=>a-b);
  const sum=(arr,k)=>r2(arr.reduce((x,y)=>x+num(y[k]),0));
  const all=[...b2b,...b2cl,...Object.values(b2csMap),...exp];
  return {month:m, gstin:s.gstin||'', b2b, b2cl, b2cs:Object.values(b2csMap), exports:exp, cdnr:notes.filter(n=>n.gstin), cdnur:notes.filter(n=>!n.gstin), hsn:Object.values(hsn),
    docs:{from:ids[0]?`INV-${ids[0]}`:'', to:ids.length?`INV-${ids[ids.length-1]}`:'', total:ids.length, cancelled:src.docs.filter(d=>d.type==='invoice' && d.status==='void' && docDate(d)>=from && docDate(d)<=to).length},
    totals:{taxable:sum(all,'taxable'), igst:sum(all,'igst'), cgst:sum(all,'cgst'), sgst:sum(all,'sgst'), credit_notes:sum(notes,'value')},
    warnings:[...(!s.gstin?['Add your GSTIN in Operations → Settings.']:[]), ...b2b.filter(r=>!r.pos).map(r=>`${r.invoice_no}: place of supply missing`), ...(fx.missing.size?[`Missing FX rates: ${[...fx.missing].join(', ')}`]:[])]};
}

export async function purchaseRegister(c){
  const from=str(c.url.searchParams.get('from'),10)||`${todayStr().slice(0,7)}-01`, to=str(c.url.searchParams.get('to'),10)||todayStr();
  const src=await loadSources(c.env, c.clientId);
  const fx=makeFx(src.rates, c.settings.base_currency, []);
  const rows=[];
  for(const b of src.bills) if(b.bill_date>=from && b.bill_date<=to){
    const m=src.purchaseMeta[`vendor_bill:${b.id}`]||null; const rt=fx(b.currency, b.bill_date);
    rows.push({source_type:'vendor_bill', source_id:b.id, date:b.bill_date, party:b.supplier, reference:b.vendor_invoice_no||'', currency:b.currency, amount:num(b.total), amount_base:r2(num(b.total)*rt), meta:m, has_meta:!!m});
  }
  for(const x of src.expenses) if(x.expense_date>=from && x.expense_date<=to){
    const m=src.purchaseMeta[`expense:${x.id}`]||null; const rt=fx(x.currency, x.expense_date);
    rows.push({source_type:'expense', source_id:x.id, date:x.expense_date, party:x.vendor||'', reference:x.category||x.expense_account_name||'', currency:x.currency, amount:num(x.amount), amount_base:r2(num(x.amount)*rt), meta:m, has_meta:!!m, approval:src.approvals[x.id]?.status||null});
  }
  rows.sort((a,b)=>b.date.localeCompare(a.date));
  const withTax=rows.filter(r=>r.meta);
  const sum=k=>r2(withTax.reduce((s,r)=>s+num(r.meta[k]),0));
  return {from, to, rows, totals:{cgst:sum('cgst'), sgst:sum('sgst'), igst:sum('igst'), tds:sum('tds_amount'),
    itc:r2(withTax.filter(r=>num(r.meta.itc_eligible)!==0).reduce((s,r)=>s+num(r.meta.cgst)+num(r.meta.sgst)+num(r.meta.igst),0))}};
}
export async function purchaseMetaSave(c){
  const b=c.body; need(['vendor_bill','expense'].includes(b.source_type) && b.source_id, 'source_type and source_id required');
  const table=b.source_type==='vendor_bill'?'accounting_vendor_bills':'accounting_expenses';
  const row=await firstRow(c.env, `SELECT * FROM ${table} WHERE id=? AND client_id=?`, Number(b.source_id), c.clientId);
  need(row, 'Not found', 404);
  const date=row.bill_date||row.expense_date;
  if(c.settings.lock_date && date<=c.settings.lock_date) throw new HttpError(409, `This ${b.source_type==='vendor_bill'?'bill':'expense'} is in a locked period (≤ ${c.settings.lock_date}).`);
  const amount=num(row.total??row.amount);
  // Rate given but no amounts → back the GST out of the GST-inclusive amount and split it by state.
  let {cgst, sgst, igst}={cgst:num(b.cgst), sgst:num(b.sgst), igst:num(b.igst)};
  const rate=num(b.gst_rate_pct);
  if(rate && !cgst && !sgst && !igst){
    const gst=r2(b.reverse_charge?amount*rate/100:amount-amount/(1+rate/100));
    const intra=b.supplier_state && c.settings.state_code && String(b.supplier_state).toUpperCase()===String(c.settings.state_code).toUpperCase();
    if(intra){ cgst=r2(gst/2); sgst=r2(gst-cgst); } else igst=gst;
  }
  need(r2(cgst+sgst+igst)<=amount || b.reverse_charge, 'GST cannot exceed the bill amount');
  const tdsRate=num(b.tds_rate); let tds=num(b.tds_amount);
  if(tdsRate && !tds) tds=r2((amount-(b.reverse_charge?0:cgst+sgst+igst))*tdsRate/100);
  const f={expense_account_id:b.expense_account_id?Number(b.expense_account_id):null, gst_rate_pct:rate, cgst:r2(cgst), sgst:r2(sgst), igst:r2(igst), itc_eligible:b.itc_eligible===false||b.itc_eligible===0?0:1,
    reverse_charge:b.reverse_charge?1:0, supplier_gstin:str(b.supplier_gstin,15)||null, supplier_pan:str(b.supplier_pan,10).toUpperCase()||null, hsn_sac:str(b.hsn_sac,10)||null,
    tds_section:str(b.tds_section,10)||null, tds_rate:tdsRate, tds_amount:r2(tds), branch:str(b.branch,60)||null};
  const cols=Object.keys(f);
  await c.env.DB.prepare(`INSERT INTO acc_purchase_meta (client_id, source_type, source_id, ${cols.join(',')}) VALUES (?,?,?,${cols.map(()=>'?').join(',')})
    ON CONFLICT(client_id, source_type, source_id) DO UPDATE SET ${cols.map(k=>`${k}=excluded.${k}`).join(',')}`).bind(c.clientId, b.source_type, Number(b.source_id), ...Object.values(f)).run();
  await audit(c.env, c.clientId, c.actor, 'purchase_tax_update', b.source_type, b.source_id, f);
  return {ok:true, meta:f};
}

export async function gstr3b(c){
  const m=monthParam(c); const from=`${m}-01`, to=monthEnd(m);
  const g1=await gstr1(c);
  const src=await loadSources(c.env, c.clientId);
  const fx=makeFx(src.rates, c.settings.base_currency, []);
  const nonExport=[...g1.b2b, ...g1.b2cl, ...g1.b2cs];
  const sum=(arr,k)=>r2(arr.reduce((s,r)=>s+num(r[k]),0));
  const zeroRatedNoTax=nonExport.filter(r=>!r.igst&&!r.cgst&&!r.sgst);
  const taxable=nonExport.filter(r=>r.igst||r.cgst||r.sgst);
  const cn=[...g1.cdnr, ...g1.cdnur];
  const out={taxable:r2(sum(taxable,'taxable')-sum(cn,'taxable')), igst:r2(sum(taxable,'igst')-sum(cn,'igst')), cgst:r2(sum(taxable,'cgst')-sum(cn,'cgst')), sgst:r2(sum(taxable,'sgst')-sum(cn,'sgst'))};
  const purchases=[];
  for(const b of src.bills) if(b.bill_date>=from && b.bill_date<=to){ const mm=src.purchaseMeta[`vendor_bill:${b.id}`]; if(mm) purchases.push({mm, rate:fx(b.currency,b.bill_date)}); }
  for(const x of src.expenses) if(x.expense_date>=from && x.expense_date<=to){ const ap=src.approvals[x.id]; if(ap && ap.status!=='approved') continue; const mm=src.purchaseMeta[`expense:${x.id}`]; if(mm) purchases.push({mm, rate:fx(x.currency,x.expense_date)}); }
  const pick=(f)=>{ const r={igst:0,cgst:0,sgst:0}; for(const p of purchases.filter(f)){ for(const k of ['igst','cgst','sgst']) r[k]=r2(r[k]+num(p.mm[k])*p.rate); } return r; };
  const rcm=pick(p=>p.mm.reverse_charge);
  const itcRcm=pick(p=>p.mm.reverse_charge && num(p.mm.itc_eligible)!==0);
  const itcOther=pick(p=>!p.mm.reverse_charge && num(p.mm.itc_eligible)!==0);
  const fees=src.settlements.filter(s=>s.settlement_date>=from && s.settlement_date<=to).reduce((s,x)=>s+num(x.tax_on_fee),0);
  itcOther.igst=r2(itcOther.igst+fees);
  const ineligible=pick(p=>num(p.mm.itc_eligible)===0 && !p.mm.reverse_charge);
  const itc={igst:r2(itcRcm.igst+itcOther.igst), cgst:r2(itcRcm.cgst+itcOther.cgst), sgst:r2(itcRcm.sgst+itcOther.sgst)};
  // Set-off: IGST credit against IGST, then CGST, then SGST; CGST credit against CGST then IGST;
  // SGST credit against SGST then IGST (CGST↔SGST cross-utilisation is not allowed).
  const liab={igst:r2(out.igst+rcm.igst), cgst:r2(out.cgst+rcm.cgst), sgst:r2(out.sgst+rcm.sgst)};
  const credit={...itc}; const pay={...liab};
  const use=(from, to)=>{ const u=Math.min(credit[from], pay[to]); credit[from]=r2(credit[from]-u); pay[to]=r2(pay[to]-u); };
  use('igst','igst'); use('igst','cgst'); use('igst','sgst'); use('cgst','cgst'); use('cgst','igst'); use('sgst','sgst'); use('sgst','igst');
  return {month:m, outward_taxable:out, zero_rated:{taxable:r2(sum(g1.exports,'taxable')), igst:sum(g1.exports,'igst')}, nil_rated:{taxable:sum(zeroRatedNoTax,'taxable')},
    inward_rcm:rcm, itc_available:{rcm:itcRcm, other:itcOther, total:itc}, itc_ineligible:ineligible, tax_liability:liab,
    cash_payable:pay, credit_carried_forward:credit, total_cash_payable:r2(pay.igst+pay.cgst+pay.sgst)};
}

/* ── TDS ── */
const quarterOf=(date, fyStart=4)=>{ const [y,mo]=date.split('-').map(Number); const fy=mo>=fyStart?y:y-1; const q=Math.floor(((mo-fyStart+12)%12)/3)+1; return `FY${fy}-${String(fy+1).slice(-2)} Q${q}`; };
export async function tdsRegister(c){
  const src=await loadSources(c.env, c.clientId);
  const fyStart=c.settings.fy_start_month||4;
  const deductions=[];
  for(const b of src.bills){ const m=src.purchaseMeta[`vendor_bill:${b.id}`]; if(m && num(m.tds_amount)) deductions.push({date:b.bill_date, quarter:quarterOf(b.bill_date,fyStart), deductee:b.supplier, pan:m.supplier_pan||'', section:m.tds_section||'', amount_paid:r2(num(b.total)-num(m.cgst)-num(m.sgst)-num(m.igst)), tds:num(m.tds_amount), rate:num(m.tds_rate), source:`Bill #${b.id}`}); }
  for(const x of src.expenses){ const m=src.purchaseMeta[`expense:${x.id}`]; if(m && num(m.tds_amount)) deductions.push({date:x.expense_date, quarter:quarterOf(x.expense_date,fyStart), deductee:x.vendor||'', pan:m.supplier_pan||'', section:m.tds_section||'', amount_paid:r2(num(x.amount)-num(m.cgst)-num(m.sgst)-num(m.igst)), tds:num(m.tds_amount), rate:num(m.tds_rate), source:`Expense #${x.id}`}); }
  for(const p of src.payroll){ let lines=[]; try{ lines=JSON.parse(p.lines_json||'[]'); }catch(_){}
    for(const l of lines) if(num(l.tds)) deductions.push({date:p.run_date, quarter:quarterOf(p.run_date,fyStart), deductee:l.name, pan:l.pan||'', section:'192', amount_paid:num(l.gross), tds:num(l.tds), rate:null, source:`Payroll ${p.period_month}`}); }
  deductions.sort((a,b)=>b.date.localeCompare(a.date));
  const challans=src.challans.slice().sort((a,b)=>b.paid_date.localeCompare(a.paid_date));
  const byQ={};
  for(const d of deductions){ const k=`${d.quarter}|${d.section}`; (byQ[k]=byQ[k]||{quarter:d.quarter, section:d.section, deducted:0, deposited:0}).deducted=r2(byQ[k].deducted+d.tds); }
  for(const ch of challans){ const k=`${ch.quarter||quarterOf(ch.paid_date,fyStart)}|${ch.section||''}`; (byQ[k]=byQ[k]||{quarter:ch.quarter||quarterOf(ch.paid_date,fyStart), section:ch.section||'', deducted:0, deposited:0}).deposited=r2(byQ[k].deposited+num(ch.amount)); }
  const receivable=src.tdsEntries.slice().sort((a,b)=>b.entry_date.localeCompare(a.entry_date));
  return {deductions, challans, summary:Object.values(byQ).map(q=>({...q, pending:r2(q.deducted-q.deposited)})).sort((a,b)=>b.quarter.localeCompare(a.quarter)), receivable,
    receivable_total:r2(receivable.reduce((s,t)=>s+num(t.amount),0)), tan:c.settings.tan||''};
}
export async function tdsChallanSave(c){
  const b=c.body; need(b.paid_date && num(b.amount)>0, 'paid_date and amount required');
  if(c.settings.lock_date && b.paid_date<=c.settings.lock_date) throw new HttpError(409, 'Date is in a locked period');
  const f=[str(b.section,10)||null, str(b.quarter,20)||quarterOf(b.paid_date, c.settings.fy_start_month||4), num(b.amount), num(b.interest), str(b.paid_date,10), str(b.challan_no,40)||null, str(b.bsr_code,20)||null, b.bank_account_id?Number(b.bank_account_id):null];
  if(b.id) await c.env.DB.prepare(`UPDATE acc_tds_challans SET section=?, quarter=?, amount=?, interest=?, paid_date=?, challan_no=?, bsr_code=?, bank_account_id=? WHERE id=? AND client_id=?`).bind(...f, Number(b.id), c.clientId).run();
  else await c.env.DB.prepare(`INSERT INTO acc_tds_challans (client_id, section, quarter, amount, interest, paid_date, challan_no, bsr_code, bank_account_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(c.clientId, ...f, new Date().toISOString()).run();
  await audit(c.env, c.clientId, c.actor, 'tds_challan_save', 'tds_challan', b.id||null, {amount:f[2], section:f[0]});
  return {ok:true};
}
export async function tdsReceivableSave(c){
  const b=c.body; need(b.entry_date && num(b.amount)>0, 'entry_date and amount required');
  if(c.settings.lock_date && b.entry_date<=c.settings.lock_date) throw new HttpError(409, 'Date is in a locked period');
  let party=str(b.party_name,140);
  if(b.linked_invoice_id){ const inv=await firstRow(c.env, `SELECT customer_name FROM accounting_documents WHERE id=? AND client_id=? AND type='invoice'`, Number(b.linked_invoice_id), c.clientId); need(inv, 'Invoice not found', 404); party=party||inv.customer_name; }
  const f=[str(b.entry_date,10), party||null, str(b.tan,10).toUpperCase()||null, str(b.section,10)||null, num(b.base_amount), num(b.amount), b.linked_invoice_id?Number(b.linked_invoice_id):null, b.offset_account_id?Number(b.offset_account_id):null, str(b.certificate_no,40)||null, str(b.notes,300)||null];
  if(b.id) await c.env.DB.prepare(`UPDATE acc_tds_entries SET entry_date=?, party_name=?, tan=?, section=?, base_amount=?, amount=?, linked_invoice_id=?, offset_account_id=?, certificate_no=?, notes=? WHERE id=? AND client_id=?`).bind(...f, Number(b.id), c.clientId).run();
  else await c.env.DB.prepare(`INSERT INTO acc_tds_entries (client_id, entry_date, party_name, tan, section, base_amount, amount, linked_invoice_id, offset_account_id, certificate_no, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(c.clientId, ...f, new Date().toISOString()).run();
  await audit(c.env, c.clientId, c.actor, 'tds_receivable_save', 'tds_entry', b.id||null, {amount:f[5], party});
  return {ok:true};
}
export async function tdsDelete(c){
  const table=c.body.kind==='challan'?'acc_tds_challans':'acc_tds_entries', dcol=c.body.kind==='challan'?'paid_date':'entry_date';
  const row=await firstRow(c.env, `SELECT ${dcol} d FROM ${table} WHERE id=? AND client_id=?`, Number(c.body.id), c.clientId); need(row, 'Not found', 404);
  if(c.settings.lock_date && row.d<=c.settings.lock_date) throw new HttpError(409, 'Entry is in a locked period');
  await c.env.DB.prepare(`DELETE FROM ${table} WHERE id=? AND client_id=?`).bind(Number(c.body.id), c.clientId).run();
  await audit(c.env, c.clientId, c.actor, 'tds_delete', table, c.body.id, null);
  return {ok:true};
}
// 26AS / AIS reconciliation: paste the "Part A" rows (deductor name, TAN, amount, TDS) — each is
// matched to a recorded TDS-receivable entry by TAN (or name) and amount within ₹1.
export async function tds26asReconcile(c){
  const rows=parseCsv(String(c.body.csv||'')); need(rows.length>1, 'Paste the 26AS rows with a header line');
  const h=rows[0].map(x=>x.toLowerCase());
  const col=(...n)=>h.findIndex(x=>n.some(k=>x.includes(k)));
  const iName=col('deductor','name'), iTan=col('tan'), iTds=col('tds deposited','tax deducted','tds'), iAmt=col('amount paid','amount credited','amount'), iDate=col('date');
  need(iTds>=0, 'Could not find a TDS column');
  const entries=(await allRows(c.env, `SELECT * FROM acc_tds_entries WHERE client_id=?`, c.clientId)).map(e=>({...e, _used:false}));
  const out=[];
  for(const r of rows.slice(1)){
    const tds=num(String(r[iTds]).replace(/,/g,'')); if(!tds) continue;
    const tan=iTan>=0?String(r[iTan]).toUpperCase():''; const name=iName>=0?r[iName]:'';
    const m=entries.find(e=>!e._used && Math.abs(num(e.amount)-tds)<=1 && ((tan && e.tan===tan) || (name && e.party_name && name.toLowerCase().includes(String(e.party_name).toLowerCase().slice(0,8)))));
    if(m) m._used=true;
    out.push({deductor:name, tan, date:iDate>=0?normDate(r[iDate]):null, amount:iAmt>=0?num(String(r[iAmt]).replace(/,/g,'')):null, tds, matched:!!m, entry_id:m?.id||null});
  }
  return {rows:out, unmatched_in_26as:out.filter(r=>!r.matched).length, unmatched_in_books:entries.filter(e=>!e._used).map(e=>({id:e.id, party:e.party_name, tan:e.tan, amount:e.amount, date:e.entry_date})),
    total_26as:r2(out.reduce((s,r)=>s+r.tds,0)), total_books:r2(entries.reduce((s,e)=>s+num(e.amount),0))};
}

/* ── E-invoice (IRP) ── */
const ddmmyyyy=d=>{ const [y,m,dd]=String(d).slice(0,10).split('-'); return `${dd}/${m}/${y}`; };
export async function einvoiceJson(c){
  const id=Number(c.url.searchParams.get('invoice_id'));
  const d=await firstRow(c.env, `SELECT * FROM accounting_documents WHERE id=? AND client_id=? AND type='invoice'`, id, c.clientId); need(d, 'Invoice not found', 404);
  const s=c.settings; const t=taxParts(d); const lines=lineItems(d); const sub=num(d.subtotal)||1;
  const missing=[];
  if(!s.gstin) missing.push('Your GSTIN (Operations → Settings)');
  if(!d.recipient_gstin && d.supply_type!=='EXPORT') missing.push('Customer GSTIN on the invoice (e-invoicing applies to B2B and exports)');
  if(lines.some(l=>!(l.hsn||l.hsn_sac))) missing.push('HSN/SAC code on every line item');
  const exportType=d.supply_type==='EXPORT'?(t.igst?'EXPWP':'EXPWOP'):'B2B';
  const json={Version:'1.1',
    TranDtls:{TaxSch:'GST', SupTyp:exportType, RegRev:d.reverse_charge?'Y':'N', IgstOnIntra:'N'},
    DocDtls:{Typ:'INV', No:`INV-${d.id}`, Dt:ddmmyyyy(docDate(d))},
    SellerDtls:{Gstin:s.gstin||'', LglNm:s.business_name||'', Addr1:'', Loc:'', Pin:0, Stcd:s.state_code||''},
    BuyerDtls:{Gstin:d.supply_type==='EXPORT'?'URP':(d.recipient_gstin||''), LglNm:d.customer_name||'', Pos:d.supply_type==='EXPORT'?'96':(d.place_of_supply||''), Addr1:'', Loc:'', Pin:d.supply_type==='EXPORT'?999999:0, Stcd:d.supply_type==='EXPORT'?'96':(d.place_of_supply||'')},
    ItemList:lines.map((l,i)=>{ const v=r2(num(l.qty)*num(l.price)); const sh=v/sub;
      return {SlNo:String(i+1), PrdDesc:str(l.name,300), IsServc:'Y', HsnCd:str(l.hsn||l.hsn_sac,8), Qty:num(l.qty), Unit:'OTH', UnitPrice:num(l.price), TotAmt:v, AssAmt:v, GstRt:num(d.gst_rate_pct),
        IgstAmt:r2(t.igst*sh), CgstAmt:r2(t.cgst*sh), SgstAmt:r2(t.sgst*sh), TotItemVal:r2(v+(t.igst+t.cgst+t.sgst)*sh)}; }),
    ValDtls:{AssVal:r2(num(d.subtotal)), CgstVal:t.cgst, SgstVal:t.sgst, IgstVal:t.igst, TotInvVal:r2(num(d.total))},
  };
  if(d.supply_type==='EXPORT') json.ExpDtls={ForCur:d.currency||'', CntCode:''};
  const meta=await firstRow(c.env, `SELECT irn, ack_no, ack_date, signed_qr, eway_bill_no FROM acc_doc_meta WHERE client_id=? AND doc_id=?`, c.clientId, id);
  return {json, missing, meta:meta||{}, note:'Upload this JSON on the IRP (einvoice1.gst.gov.in) or send it through your GSP, then paste the IRN and Ack details back here. Fill seller/buyer address and PIN before upload.'};
}
export async function einvoiceSave(c){
  const b=c.body; const d=await firstRow(c.env, `SELECT id FROM accounting_documents WHERE id=? AND client_id=? AND type='invoice'`, Number(b.invoice_id), c.clientId); need(d, 'Invoice not found', 404);
  const f={irn:str(b.irn,80)||null, ack_no:str(b.ack_no,40)||null, ack_date:str(b.ack_date,30)||null, signed_qr:str(b.signed_qr,4000)||null, eway_bill_no:str(b.eway_bill_no,40)||null};
  const cols=Object.keys(f);
  await c.env.DB.prepare(`INSERT INTO acc_doc_meta (client_id, doc_id, ${cols.join(',')}) VALUES (?,?,${cols.map(()=>'?').join(',')}) ON CONFLICT(client_id, doc_id) DO UPDATE SET ${cols.map(k=>`${k}=excluded.${k}`).join(',')}`)
    .bind(c.clientId, d.id, ...Object.values(f)).run();
  await audit(c.env, c.clientId, c.actor, 'einvoice_save', 'invoice', d.id, {irn:f.irn, ack_no:f.ack_no});
  return {ok:true};
}

/* ── FX ── */
export async function fxList(c){
  const rates=await allRows(c.env, `SELECT * FROM acc_fx_rates WHERE client_id=? ORDER BY rate_date DESC, currency LIMIT 500`, c.clientId);
  const used=new Set();
  for(const t of ['accounting_documents','accounting_expenses','accounting_vendor_bills','acc_payment_entries','acc_subscriptions']) for(const r of await allRows(c.env, `SELECT DISTINCT UPPER(currency) cur FROM ${t} WHERE client_id=? AND currency IS NOT NULL AND currency!=''`, c.clientId)) used.add(r.cur);
  used.delete(String(c.settings.base_currency).toUpperCase());
  const have=new Set(rates.map(r=>String(r.currency).toUpperCase()));
  return {base_currency:c.settings.base_currency, rates, currencies_in_use:[...used], missing:[...used].filter(x=>!have.has(x))};
}
export async function fxSave(c){
  const b=c.body; const cur=str(b.currency,10).toUpperCase(); need(cur && b.rate_date && num(b.rate)>0, 'currency, rate_date and a positive rate required');
  need(cur!==String(c.settings.base_currency).toUpperCase(), 'That is the base currency');
  await c.env.DB.prepare(`INSERT INTO acc_fx_rates (client_id, currency, rate_date, rate) VALUES (?,?,?,?) ON CONFLICT(client_id, currency, rate_date) DO UPDATE SET rate=excluded.rate`).bind(c.clientId, cur, str(b.rate_date,10), num(b.rate)).run();
  await audit(c.env, c.clientId, c.actor, 'fx_rate_save', 'fx', cur, {date:b.rate_date, rate:num(b.rate)});
  return {ok:true};
}
export async function fxDelete(c){ await c.env.DB.prepare(`DELETE FROM acc_fx_rates WHERE id=? AND client_id=?`).bind(Number(c.body.id), c.clientId).run(); return {ok:true}; }
// Unrealised FX: open foreign-currency invoices/bills are carried at their booking rate; this
// restates them at the as-of rate. Report only — post an adjusting journal if your accountant wants it booked.
export async function fxRevaluation(c){
  const asOf=str(c.url.searchParams.get('as_of'),10)||todayStr();
  const src=await loadSources(c.env, c.clientId); const base=String(c.settings.base_currency).toUpperCase();
  const warnings=[]; const fx=makeFx(src.rates, base, warnings);
  const rows=[];
  for(const b of Object.values(invoiceBalances(src))){
    const cur=String(b.invoice.currency||base).toUpperCase(); if(cur===base || b.balance<=0) continue;
    const booked=fx(cur, docDate(b.invoice)), now=fx(cur, asOf);
    rows.push({kind:'receivable', ref:`Invoice #${b.invoice.id}`, party:b.invoice.customer_name, currency:cur, open:b.balance, booked_rate:booked, current_rate:now, gain_loss:r2(b.balance*(now-booked))});
  }
  for(const bill of src.bills.filter(x=>x.status!=='paid')){
    const cur=String(bill.currency||base).toUpperCase(); if(cur===base) continue;
    const booked=fx(cur, bill.bill_date), now=fx(cur, asOf);
    rows.push({kind:'payable', ref:`Bill #${bill.id}`, party:bill.supplier, currency:cur, open:num(bill.total), booked_rate:booked, current_rate:now, gain_loss:r2(-num(bill.total)*(now-booked))});
  }
  return {as_of:asOf, base_currency:base, rows, net_gain_loss:r2(rows.reduce((s,r)=>s+r.gain_loss,0)), warnings};
}
export {quarterOf};
