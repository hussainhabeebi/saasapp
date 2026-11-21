/* ── Travel Status Board: automatic follow-ups for stalled inquiries ───────────────────────────
   An inquiry left at Quote sent / Negotiating / Documents pending / Payment pending for
   TS_STALE_DAYS days with no status change is moved to "Follow up pending" due today, the change is
   written to its status history (by "auto"), and each owner gets one email listing their inquiries
   (unassigned ones go to the account owner). Open dashboards update live (lead_updated).
   Runs on the daily cron for travel accounts. Off for an account whose clients row has
   travel_auto_followup = 'No'. Pure logic + injected deps, so it is unit-tested without a network:
     deps.listLeads(clientId) → leads with Id, Name, Phone, Owner, TravelStatus, TravelStatusAt, TravelStatusLog
     deps.patch(rows)          → PATCH the Leads table (array)
     deps.email(to, subject, html)
     deps.broadcast(clientId, payload)                                                            ── */

export const TS_STALE_STATUSES=['quote_sent','negotiating','docs_pending','payment_pending'];
export const TS_STALE_DAYS=2;
export const TS_AUTO_BY='auto';
const TS_LOG_MAX=200;
const LABELS={quote_sent:'Quote sent', negotiating:'Negotiating', docs_pending:'Documents pending', payment_pending:'Payment pending'};

export function travelAutoFollowupOn(c){
  return String(c?.industry||'')==='travel' && String(c?.travel_auto_followup||'').trim().toLowerCase()!=='no';
}
export function travelStaleDue(lead, nowMs, days=TS_STALE_DAYS){
  if(!TS_STALE_STATUSES.includes(String(lead?.TravelStatus||''))) return false;
  const at=Date.parse(lead?.TravelStatusAt||'');
  return Number.isFinite(at) && nowMs-at>=days*864e5;
}
function parseLog(raw){ try{ const v=typeof raw==='string'?JSON.parse(raw||'[]'):raw; return Array.isArray(v)?v:[]; }catch(e){ return []; } }
export function travelStalePatch(lead, now=new Date()){
  const at=now.toISOString(), today=at.slice(0,10);
  const entry={at, by:TS_AUTO_BY, from:String(lead.TravelStatus||''), to:'follow_up_pending', fu:today, note:`No update for ${TS_STALE_DAYS}+ days`};
  return {Id:Number(lead.Id), TravelStatus:'follow_up_pending', TravelFollowUpAt:today, TravelStatusAt:at, TravelStatusBy:TS_AUTO_BY,
    TravelStatusLog:JSON.stringify([entry, ...parseLog(lead.TravelStatusLog)].slice(0,TS_LOG_MAX))};
}
const escHtml=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export async function travelStaleProcessClient(c, deps, now=new Date()){
  if(!travelAutoFollowupOn(c)) return {moved:0};
  const nowMs=now.getTime();
  const leads=(await deps.listLeads(c.Id)||[]).filter(l=>travelStaleDue(l, nowMs));
  if(!leads.length) return {moved:0};
  const patches=leads.map(l=>travelStalePatch(l, now));
  for(let i=0;i<patches.length;i+=50) await deps.patch(patches.slice(i,i+50));
  const ids=patches.map(p=>p.Id);
  try{ await deps.broadcast(c.Id, {type:'lead_updated', lead_ids:ids.slice(0,100), fields:['TravelStatus','TravelFollowUpAt','TravelStatusAt','TravelStatusBy','TravelStatusLog'], by:TS_AUTO_BY, at:now.toISOString()}); }catch(e){}
  // One email per owner; unassigned inquiries go to the account owner.
  const lower=v=>String(v||'').trim().toLowerCase();
  const fallback=lower(c.authentik_email);
  const byOwner={};
  for(const l of leads){ const to=lower(l.Owner)||fallback; if(to) (byOwner[to]=byOwner[to]||[]).push(l); }
  for(const [to, list] of Object.entries(byOwner)){
    const n=list.length;
    const items=list.slice(0,50).map(l=>`<li><strong>${escHtml(l.Name||l.Phone||('Inquiry #'+l.Id))}</strong> — was ${escHtml(LABELS[l.TravelStatus]||l.TravelStatus)} for ${Math.floor((nowMs-Date.parse(l.TravelStatusAt))/864e5)} days</li>`).join('');
    try{ await deps.email(to, n===1?`⏰ Follow up today: ${list[0].Name||list[0].Phone||'an inquiry'}`:`⏰ ${n} inquiries need a follow-up today`,
      `<p>${n===1?'This inquiry has':'These inquiries have'} had no status update for ${TS_STALE_DAYS} days, so ${n===1?'it was':'they were'} moved to <strong>Follow up pending</strong>, due today, on your 📌 Status Board.</p><ul>${items}</ul><p>Open Leadvyne → 📌 Status Board → 🔔 Follow-ups due.</p>`); }catch(e){}
  }
  return {moved:patches.length, ids};
}
