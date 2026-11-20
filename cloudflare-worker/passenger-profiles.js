/* ═══════════════════════════════════════════════════════════════════════════
   👤 PROFILES — traveller / guest profiles with their documents (Dashboard → 👤 Profiles).
   Travel agency and hospitality accounts only (ppIsOn). Pure, no I/O; storage, routes and the
   daily reminder job live in worker.js (D1 pp_profiles / pp_documents / pp_reminders / pp_audit,
   /profiles*).

   One profile per person, kept across bookings, so passport and visa details are typed once:
     • documents (passport, visa, residence permit, national ID…) with issue and expiry dates and a
       status worked out from today (ppDocStatus);
     • reminders before a document expires and before birthdays / anniversaries (ppRemindersDue):
       one reminder per step, so a passport expiring in 20 days raises the 30-day reminder only,
       never every step at once;
     • a trip check: a passport must stay valid 6 months after the return date (ppTravelCheck).
   Document numbers are masked everywhere (ppMask); the full number is only returned by the reveal
   route, which writes an audit row.
   ═══════════════════════════════════════════════════════════════════════════ */

// Travel (industry or the Travel Agency module) and hospitality (industry or the Hospitality module).
export function ppIsOn(c){
  if(!c) return false;
  const ind=String(c.industry||'').trim().toLowerCase();
  return ind==='travel'||ind==='hospitality'||c.ta_enabled==='Yes'||c.hospitality_enabled==='Yes';
}

export const PP_DOC_TYPES={
  passport:'Passport', visa:'Visa', residence:'Residence permit / Iqama / Emirates ID',
  national_id:'National ID (Aadhaar, CNIC…)', driving_licence:'Driving licence', insurance:'Travel insurance',
  vaccination:'Vaccination certificate', other:'Other document',
};
// Days before expiry at which a reminder is raised. 0 = on the day; expired gets one more.
export const PP_DOC_STEPS={passport:[270,180,90,30,0], default:[60,30,7,0]};
// A document reads "expiring" inside this many days (passports: the 6-month rule).
export const PP_EXPIRING_DAYS={passport:180, default:60};
export const PP_PASSPORT_RULE_MONTHS=6;
export const PP_OCCASION_DAYS=7;      // birthday / anniversary reminder this many days ahead…
export const PP_MAX_DOCS=30;          // …and documents per profile
export const PP_GENDERS=['','male','female','other'];
export const PP_RELATIONS=['','self','spouse','child','parent','sibling','relative','friend','colleague','other'];

const clip=(v,n)=>String(v??'').replace(/[\r\n]+/g,' ').trim().slice(0,n);
const text=(v,n)=>String(v??'').replace(/\r/g,'').trim().slice(0,n);
const digits=s=>String(s||'').replace(/\D/g,'');
export const ppPhoneKey=s=>digits(s).slice(-9);
const tidyPhone=s=>clip(s,40).replace(/[^\d+()\s-]/g,'').replace(/\s+/g,' ').trim();
const EMAIL_RE=/^[^\s@,<>]+@[^\s@,<>]+\.[a-z]{2,}$/i;

// 'YYYY-MM-DD' if it is a real calendar date, else ''. Accepts DD/MM/YYYY and DD-MM-YYYY too.
export function ppDate(v){
  let s=String(v??'').trim();
  if(!s) return '';
  let m=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if(!m){ const d=s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/); if(d) m=[s,d[3],d[2],d[1]]; }
  if(!m) return '';
  const y=+m[1], mo=+m[2], da=+m[3];
  const dt=new Date(Date.UTC(y,mo-1,da));
  if(dt.getUTCFullYear()!==y||dt.getUTCMonth()!==mo-1||dt.getUTCDate()!==da||y<1900||y>2200) return '';
  return dt.toISOString().slice(0,10);
}
// Anniversary may be stored without a year ('MM-DD').
export function ppMonthDay(v){
  const s=String(v??'').trim();
  const full=ppDate(s); if(full) return full;
  const m=s.match(/^(\d{1,2})-(\d{1,2})$/);
  if(!m) return '';
  const dt=new Date(Date.UTC(2000,+m[1]-1,+m[2]));
  return dt.getUTCMonth()===+m[1]-1&&dt.getUTCDate()===+m[2]?dt.toISOString().slice(5,10):'';
}
export function ppToday(now=new Date()){ return new Date(now).toISOString().slice(0,10); }
const dayMs=d=>Date.UTC(+d.slice(0,4),+d.slice(5,7)-1,+d.slice(8,10));
export function ppDaysBetween(from,to){ return Math.round((dayMs(to)-dayMs(from))/864e5); }
export function ppAddMonths(date,n){
  const y=+date.slice(0,4), m=+date.slice(5,7)-1+n, d=+date.slice(8,10);
  const last=new Date(Date.UTC(y,m+1,0)).getUTCDate();
  return new Date(Date.UTC(y,m,Math.min(d,last))).toISOString().slice(0,10);
}

// The next date (today or later) a yearly occasion falls on. 29 Feb → 28 Feb in other years.
export function ppNextOccurrence(md,today){
  const mmdd=String(md||'').length>5?String(md).slice(5,10):String(md||'');
  if(!/^\d{2}-\d{2}$/.test(mmdd)) return null;
  const on=y=>{ const leap=(y%4===0&&y%100!==0)||y%400===0; return `${y}-${mmdd==='02-29'&&!leap?'02-28':mmdd}`; };
  const y=+today.slice(0,4);
  const d=on(y)>=today?on(y):on(y+1);
  return {date:d, days:ppDaysBetween(today,d)};
}
export function ppAge(dob,today){
  if(!ppDate(dob)) return null;
  let a=+today.slice(0,4)-+dob.slice(0,4);
  if(today.slice(5)<dob.slice(5)) a--;
  return a>=0&&a<130?a:null;
}

// "P1234567" → "•••••567". Short numbers keep only their last 2.
export function ppMask(n){
  const s=String(n||'').replace(/\s+/g,'');
  if(!s) return '';
  const keep=s.length>6?3:Math.min(2,Math.max(0,s.length-2));
  return '•'.repeat(Math.max(3,s.length-keep))+s.slice(s.length-keep);
}

export function ppFullName(p){
  return [p?.title,p?.first_name,p?.last_name].map(x=>String(x||'').trim()).filter(Boolean).join(' ');
}

const PROFILE_TEXT={title:12,first_name:60,last_name:60,nationality:60,email:120,address:300,family_group:80,
  meal:80,seat:40,room:120,frequent_flyer:200,tags:200,emergency_contact:160};
// Cleans what the page sent. Returns {data, errors}.
export function ppCleanProfile(input){
  const s=input&&typeof input==='object'?input:{};
  const errors=[];
  const d={};
  for(const [k,n] of Object.entries(PROFILE_TEXT)) d[k]=clip(s[k],n);
  d.email=d.email.toLowerCase();
  d.phone=tidyPhone(s.phone);
  d.whatsapp=tidyPhone(s.whatsapp);
  d.gender=PP_GENDERS.includes(String(s.gender||'').toLowerCase())?String(s.gender||'').toLowerCase():'';
  d.relation=PP_RELATIONS.includes(String(s.relation||'').toLowerCase())?String(s.relation||'').toLowerCase():'';
  d.date_of_birth=ppDate(s.date_of_birth);
  d.anniversary=ppMonthDay(s.anniversary);
  d.notes=text(s.notes,2000);
  d.lead_id=Number(s.lead_id)>0?Math.floor(Number(s.lead_id)):null;
  d.marketing_ok=s.marketing_ok!==false;
  if(!d.first_name&&!d.last_name) errors.push('First or last name is required.');
  if(s.date_of_birth&&!d.date_of_birth) errors.push('Date of birth is not a valid date.');
  if(s.anniversary&&!d.anniversary) errors.push('Anniversary is not a valid date.');
  if(d.date_of_birth&&d.date_of_birth>ppToday()) errors.push('Date of birth is in the future.');
  if(d.email&&!EMAIL_RE.test(d.email)) errors.push('Email address is not valid.');
  for(const k of ['phone','whatsapp']){ const n=digits(d[k]).length; if(d[k]&&(n<7||n>15)) errors.push(`${k==='phone'?'Phone':'WhatsApp'} number looks incomplete.`); }
  return {data:d, errors};
}

export function ppCleanDocument(input){
  const s=input&&typeof input==='object'?input:{};
  const errors=[];
  const type=Object.hasOwn(PP_DOC_TYPES,String(s.type||''))?String(s.type):'other';
  const d={type,
    number:clip(s.number,40).replace(/\s+/g,'').toUpperCase(),
    label:clip(s.label,80),                 // "Schengen visa", "UAE residence"
    issuing_country:clip(s.issuing_country,60),
    place_of_issue:clip(s.place_of_issue,60),
    visa_country:clip(s.visa_country,60),
    issue_date:ppDate(s.issue_date),
    expiry_date:ppDate(s.expiry_date),
    notes:text(s.notes,500),
    state:['','renewal','replaced'].includes(String(s.state||''))?String(s.state||''):''};
  if(s.issue_date&&!d.issue_date) errors.push('Issue date is not a valid date.');
  if(s.expiry_date&&!d.expiry_date) errors.push('Expiry date is not a valid date.');
  if(d.issue_date&&d.expiry_date&&d.expiry_date<=d.issue_date) errors.push('Expiry date must be after the issue date.');
  if(type==='passport'&&!d.number) errors.push('Passport number is required.');
  if(type==='passport'&&!d.expiry_date) errors.push('Passport expiry date is required.');
  if(d.number&&!/^[A-Z0-9/-]{3,40}$/.test(d.number)) errors.push('Document number may only have letters, digits, / and -.');
  return {data:d, errors};
}

// valid | expiring | expired | no_expiry | renewal | replaced
export function ppDocStatus(doc,today){
  if(doc?.state==='replaced') return 'replaced';
  if(!doc?.expiry_date) return doc?.state==='renewal'?'renewal':'no_expiry';
  const days=ppDaysBetween(today,doc.expiry_date);
  if(days<0) return 'expired';
  if(doc.state==='renewal') return 'renewal';
  return days<=(PP_EXPIRING_DAYS[doc.type]??PP_EXPIRING_DAYS.default)?'expiring':'valid';
}

// The passport a booking would use: the valid one that lasts longest (replaced ones never count).
export function ppCurrentPassport(docs){
  return (docs||[]).filter(d=>d.type==='passport'&&d.state!=='replaced')
    .sort((a,b)=>String(b.expiry_date||'').localeCompare(String(a.expiry_date||'')))[0]||null;
}

// A trip from `departure` to `ret` (return, or the departure for one-way). Returns problems found,
// worst first: [{level:'error'|'warn', code, message}].
export function ppTravelCheck(profile,docs,{departure,ret,destination}={},today=ppToday()){
  const out=[];
  const name=ppFullName(profile)||'This traveller';
  const dep=ppDate(departure), back=ppDate(ret)||dep;
  if(!dep) return [{level:'error',code:'no_date',message:'Enter the departure date.'}];
  if(back<dep) return [{level:'error',code:'bad_dates',message:'Return date is before the departure date.'}];
  const pp=ppCurrentPassport(docs);
  if(!pp) out.push({level:'error',code:'no_passport',message:`${name}: no passport on file.`});
  else if(!pp.expiry_date) out.push({level:'warn',code:'no_expiry',message:`${name}: passport expiry date is missing.`});
  else{
    const need=ppAddMonths(back,PP_PASSPORT_RULE_MONTHS);
    if(pp.expiry_date<dep) out.push({level:'error',code:'expired_before',message:`${name}: passport expires ${pp.expiry_date}, before the trip starts.`});
    else if(pp.expiry_date<back) out.push({level:'error',code:'expires_during',message:`${name}: passport expires ${pp.expiry_date}, during the trip.`});
    else if(pp.expiry_date<need) out.push({level:'warn',code:'six_months',message:`${name}: passport expires ${pp.expiry_date} — less than ${PP_PASSPORT_RULE_MONTHS} months after the return (${need} needed). Many countries refuse entry.`});
  }
  const dest=String(destination||'').trim().toLowerCase();
  if(dest){
    const visa=(docs||[]).filter(d=>d.type==='visa'&&d.state!=='replaced'&&String(d.visa_country||d.label||'').toLowerCase().includes(dest));
    if(!visa.length) out.push({level:'warn',code:'no_visa',message:`${name}: no ${destination} visa on file — check if one is needed.`});
    else if(!visa.some(v=>!v.expiry_date||v.expiry_date>=back)) out.push({level:'error',code:'visa_expires',message:`${name}: ${destination} visa expires before the return.`});
  }
  if(profile?.date_of_birth&&ppAge(profile.date_of_birth,dep)!=null&&ppAge(profile.date_of_birth,dep)<18&&!out.length)
    out.push({level:'warn',code:'minor',message:`${name} is a minor on the travel date — check parental consent / NOC rules.`});
  return out.sort((a,b)=>(a.level==='error'?0:1)-(b.level==='error'?0:1));
}

// The one reminder step a document is at today: the smallest step that is still ≥ days left, or
// 'expired' once past. null when it is further away than the first step.
export function ppDocStep(doc,today){
  if(!doc?.expiry_date||doc.state==='replaced') return null;
  const days=ppDaysBetween(today,doc.expiry_date);
  if(days<0) return {step:'expired', days};
  const steps=PP_DOC_STEPS[doc.type]||PP_DOC_STEPS.default;
  const fit=steps.filter(s=>s>=days);
  return fit.length?{step:Math.min(...fit), days}:null;
}

const docName=d=>d.type==='visa'&&(d.visa_country||d.label)?`${d.visa_country||d.label} visa`:(d.label||PP_DOC_TYPES[d.type]||'Document');
const fmtDate=d=>{ try{ return new Date(d+'T00:00:00Z').toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}); }catch(e){ return d; } };
const inDays=n=>n===0?'today':n===1?'tomorrow':n<0?`${-n} day${n===-1?'':'s'} ago`:`in ${n} days`;

// Every reminder due today. `profiles` carry their `docs`. Each has a stable `key`: the job stores
// it, so a reminder is raised once (a renewed document has a new expiry, so new keys).
export function ppRemindersDue(profiles,today,{occasionDays=PP_OCCASION_DAYS}={}){
  const out=[];
  for(const p of profiles||[]){
    const who=ppFullName(p)||'Customer';
    for(const d of p.docs||[]){
      const s=ppDocStep(d,today);
      if(!s) continue;
      out.push({key:`doc:${d.id}:${d.expiry_date}:${s.step}`, kind:d.type==='passport'?'passport':'document', profile_id:p.id, doc_id:d.id,
        due_date:d.expiry_date, days:s.days,
        title:s.step==='expired'?`${who} — ${docName(d)} expired ${fmtDate(d.expiry_date)}`:`${who} — ${docName(d)} expires ${inDays(s.days)} (${fmtDate(d.expiry_date)})`});
    }
    for(const kind of ['birthday','anniversary']){
      const src=kind==='birthday'?p.date_of_birth:p.anniversary;
      const next=src&&ppNextOccurrence(src,today);
      if(!next||next.days>occasionDays) continue;
      const step=next.days===0?'day':'ahead';
      const age=kind==='birthday'?ppAge(p.date_of_birth,next.date):null;
      out.push({key:`${kind}:${p.id}:${next.date}:${step}`, kind, profile_id:p.id, doc_id:null, due_date:next.date, days:next.days,
        title:`${kind==='birthday'?'🎂':'💍'} ${who} — ${kind} ${inDays(next.days)}${age?` (turns ${age})`:''}`});
    }
  }
  return out.sort((a,b)=>a.days-b.days);
}

// The WhatsApp message the agent can send in one tap (opened in wa.me / the chat, never auto-sent).
export function ppReminderMessage(rem,profile,doc,business=''){
  const first=String(profile?.first_name||'').trim()||'there';
  const from=business?` — ${business}`:'';
  if(rem.kind==='birthday') return `Happy birthday, ${first}! 🎂 Wishing you a wonderful year full of happy journeys.${from}`;
  if(rem.kind==='anniversary') return `Happy anniversary, ${first}! 💍 Wishing you both many more beautiful trips together.${from}`;
  const what=doc?docName(doc):'travel document';
  if(rem.days<0) return `Hi ${first}, your ${what} expired on ${fmtDate(rem.due_date)}. Reply here and we will help you renew it before your next trip.${from}`;
  const tail=doc?.type==='passport'?' Many countries need 6 months of passport validity to enter, so it is worth renewing early.':'';
  return `Hi ${first}, a friendly reminder that your ${what} expires on ${fmtDate(rem.due_date)}.${tail} Reply here if you would like our help with the renewal.${from}`;
}

const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// The owner's daily email: new reminders raised today.
export function ppDigestHtml(rems,business=''){
  const rows=rems.map(r=>`<li style="margin:4px 0">${esc(r.title)}</li>`).join('');
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#0f1a1e">
<p><b>${rems.length} profile reminder${rems.length===1?'':'s'}</b>${business?` for ${esc(business)}`:''} today:</p>
<ul style="padding-left:18px">${rows}</ul>
<p>Open <b>👤 Profiles → 🔔 Reminders</b> in your Leadvyne dashboard to message each customer in one tap and mark it done.</p></div>`;
}
