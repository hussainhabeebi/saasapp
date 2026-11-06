/* ═══════════════════════════════════════════════════════════════════════════
   PEOPLE & CONTACTS (Settings → 📇 People & Contacts). Pure, no I/O; storage and routes live in
   worker.js (D1 business_contacts, /settings/contacts).

   One place for the business's official identity (name, logo, address, phone, email…) and the
   contact person for each department (Sales, Tech, custom ones). It does two jobs for the bot:
     1. bcPromptBlock — a section added AFTER the bot prompt on every customer reply, so the bot
        always has the real details and the rules for sharing them;
     2. bcFindInventedContact — a check on every reply: a phone number or email address the bot
        wrote that appears nowhere in what it was given is invented, and must not reach a customer
        (the reply is regenerated once, then the line is removed).
   ═══════════════════════════════════════════════════════════════════════════ */

export const BC_MAX_DEPARTMENTS=20;
export const BC_DEFAULT_DEPARTMENTS=[
  {name:'Sales',handles:'packages, bookings, prices, new enquiries'},
  {name:'Tech support',handles:'payment links, website or app problems'},
];
const IDENTITY_FIELDS={official_name:120,short_name:60,address:300,map_url:500,hours:120,phone:40,whatsapp:40,email:120,website:300,logo_url:600,logo_wide_url:600};
const DEPT_FIELDS={name:60,person:80,phone:40,email:120,hours:120,handles:200,teammate:120};
export const BC_EMAIL_RE=/^[^\s@,<>]+@[^\s@,<>]+\.[a-z]{2,}$/i;

const clip=(v,n)=>String(v??'').replace(/[\r\n]+/g,' ').trim().slice(0,n);
const digits=s=>String(s||'').replace(/\D/g,'');
// The part of a phone number that is the same however it is written (+971 52…, 0097152…, 052…).
export const bcPhoneKey=s=>digits(s).slice(-9);
export function bcValidPhone(s){ const d=digits(s); return d.length>=7&&d.length<=15; }
// "+971 52 931 9100" stays as typed, only tidied (single spaces, no stray characters).
export function bcTidyPhone(s){ return clip(s,40).replace(/[^\d+()\s-]/g,'').replace(/\s+/g,' ').trim(); }
const safeUrl=s=>{ const v=clip(s,600); return !v||/^https:\/\/[^\s"'<>]+$/i.test(v)?v:''; };
const deptId=()=>'d'+Math.random().toString(36).slice(2,9);

export function bcEmpty(){
  return {identity:Object.fromEntries(Object.keys(IDENTITY_FIELDS).map(k=>[k,''])),
    departments:BC_DEFAULT_DEPARTMENTS.map((d,i)=>({id:'d'+(i+1),name:d.name,person:'',phone:'',whatsapp:true,email:'',hours:'',handles:d.handles,public:true,is_default:i===0,teammate:''})),
    guard:true};
}

// Cleans what the settings page sent. Returns {data, errors}; errors are messages for the page.
export function bcNormalize(input){
  const src=input&&typeof input==='object'?input:{};
  const errors=[];
  const id=src.identity&&typeof src.identity==='object'?src.identity:{};
  const identity={};
  for(const [k,n] of Object.entries(IDENTITY_FIELDS)) identity[k]=clip(id[k],n);
  identity.phone=bcTidyPhone(identity.phone);
  identity.whatsapp=bcTidyPhone(identity.whatsapp);
  identity.email=identity.email.toLowerCase();
  for(const k of ['map_url','website','logo_url','logo_wide_url']) identity[k]=safeUrl(identity[k]);
  if(id.website&&!identity.website) errors.push('Website must start with https://');
  if(id.map_url&&!identity.map_url) errors.push('Map link must start with https://');
  if(identity.phone&&!bcValidPhone(identity.phone)) errors.push('Main phone number looks incomplete.');
  if(identity.whatsapp&&!bcValidPhone(identity.whatsapp)) errors.push('Main WhatsApp number looks incomplete.');
  if(identity.email&&!BC_EMAIL_RE.test(identity.email)) errors.push('Main email address is not valid.');

  const seen=new Set();
  const departments=(Array.isArray(src.departments)?src.departments:[]).slice(0,BC_MAX_DEPARTMENTS).map(d=>{
    const o={};
    for(const [k,n] of Object.entries(DEPT_FIELDS)) o[k]=clip(d?.[k],n);
    o.phone=bcTidyPhone(o.phone);
    o.email=o.email.toLowerCase();
    o.teammate=o.teammate.toLowerCase();
    o.id=/^[a-z0-9]{2,12}$/i.test(String(d?.id||''))&&!seen.has(d.id)?String(d.id):deptId();
    seen.add(o.id);
    o.whatsapp=d?.whatsapp!==false;
    o.public=d?.public!==false;
    o.is_default=d?.is_default===true;
    return o;
  }).filter(d=>d.name||d.person||d.phone||d.email);
  departments.forEach((d,i)=>{
    const label=d.name||`Row ${i+1}`;
    if(!d.name) errors.push(`${label}: department name is required.`);
    if(d.phone&&!bcValidPhone(d.phone)) errors.push(`${label}: phone number looks incomplete.`);
    if(d.email&&!BC_EMAIL_RE.test(d.email)) errors.push(`${label}: email address is not valid.`);
  });
  const names=departments.map(d=>d.name.toLowerCase()).filter(Boolean);
  if(new Set(names).size!==names.length) errors.push('Two departments have the same name.');
  // Exactly one default, and it must be one customers may be given.
  const pub=departments.filter(d=>d.public);
  let def=pub.find(d=>d.is_default)||pub[0]||null;
  departments.forEach(d=>{ d.is_default=d===def; });
  return {data:{identity,departments,guard:src.guard!==false},errors};
}

// Stored JSON → data, never throwing (an unreadable row reads as "nothing set yet").
export function bcParse(raw){
  if(!raw) return null;
  try{ const o=typeof raw==='string'?JSON.parse(raw):raw; return o&&typeof o==='object'?bcNormalize(o).data:null; }catch(e){ return null; }
}

export function bcHasContent(data){
  if(!data) return false;
  const id=data.identity||{};
  return ['official_name','address','phone','whatsapp','email','website','hours'].some(k=>id[k])
    ||(data.departments||[]).some(d=>d.public&&(d.phone||d.email||d.person));
}

// The section added after the bot prompt. '' when nothing is set, so accounts that never open the
// tab get exactly the prompt they had before.
export function bcPromptBlock(data){
  if(!bcHasContent(data)) return '';
  const id=data.identity||{};
  const lines=['','','## Official business details — use exactly as written'];
  const add=(label,v)=>{ if(v) lines.push(`${label}: ${v}`); };
  add('Official name',id.official_name);
  if(id.short_name&&id.short_name!==id.official_name) add('Short name (casual replies)',id.short_name);
  add('Address',id.address);
  add('Map',id.map_url);
  add('Office hours',id.hours);
  add('Main phone',id.phone);
  if(id.whatsapp&&bcPhoneKey(id.whatsapp)!==bcPhoneKey(id.phone)) add('WhatsApp',id.whatsapp);
  add('Email',id.email);
  add('Website',id.website);
  const depts=(data.departments||[]).filter(d=>d.public&&(d.phone||d.email||d.person));
  if(depts.length){
    lines.push('','## Official contacts by department — share ONLY these');
    for(const d of depts){
      const how=[d.person,d.phone?`${d.phone}${d.whatsapp?' (call / WhatsApp)':' (call)'}`:'',d.email,d.hours?`hours ${d.hours}`:''].filter(Boolean).join(' — ');
      lines.push(`- ${d.name}${d.handles?` (${d.handles})`:''}: ${how}${d.is_default?'  [DEFAULT]':''}`);
    }
  }
  lines.push('','Rules for contact details:',
    '- Give only the ONE contact that fits what the customer asked. Do not list every contact.',
    depts.length?'- If no department clearly fits, give the [DEFAULT] one.':'- When a customer needs to reach the team, give the main phone or email above.',
    '- Never invent, guess, change, shorten or "complete" a name, phone number, email, address or link. Copy them exactly as written above.',
    '- If a detail is not written above, do not make one up: say the team will share it.');
  return lines.join('\n');
}

// Everything a reply may legitimately quote: the visible contacts plus any extra text (the system
// prompt the model saw, the customer's message). Hidden departments are left out on purpose.
export function bcAllowedSource(data,...extra){
  const parts=[...extra.map(x=>String(x||''))];
  if(data){
    const id=data.identity||{};
    parts.push(id.phone,id.whatsapp,id.email);
    for(const d of data.departments||[]) if(d.public) parts.push(d.phone,d.email);
  }
  return parts.filter(Boolean).join('\n');
}

// Phone-like runs: optional +/00, then digits with spaces, dashes, dots or brackets between (never across a line break, so two numbers on two lines stay two numbers).
const PHONE_RE=/(?:\+|\b00)?\(?\d[\d \t\u00a0().-]{5,}\d/g;
const EMAIL_RE=/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// True for a run that reads as a phone number rather than a price, date, time or reference.
function looksLikePhone(raw,text,at){
  const s=raw.trim();
  const d=digits(s);
  if(d.length<8||d.length>15) return false;
  if(/\d[.]\d{1,2}$/.test(s)&&!/\s/.test(s)) return false;           // 1299.00
  if(/^\d{1,4}[-.]\d{1,2}[-.]\d{1,4}$/.test(s)) return false;          // 2026-11-06, 06.11.2026
  const before=text.slice(Math.max(0,at-12),at);
  if(/(?:₹|rs\.?|inr|aed|usd|sar|qar|\$|€|£)\s*$/i.test(before)) return false; // a price
  if(/(?:pnr|ref|booking|order|invoice|id|no\.?|#)\s*[:#]?\s*$/i.test(before)&&!/^\+/.test(s)) return false;
  // Plain 8–9 digit runs without a + or leading 0 are usually references, not phones.
  if(!/^(?:\+|00|0|\()/.test(s)&&d.length<10) return false;
  return true;
}
export function bcPhonesIn(text){
  const t=String(text||'');
  const out=[];
  for(const m of t.matchAll(PHONE_RE)) if(looksLikePhone(m[0],t,m.index)) out.push(m[0].trim());
  return out;
}
export function bcEmailsIn(text){ return (String(text||'').match(EMAIL_RE)||[]).map(e=>e.replace(/\.+$/,'').toLowerCase()); }

// The first phone number or email in `reply` that is not in `source`, or null when every contact
// detail in the reply was given to the bot. Phones compare on their last 9 digits, so a real
// number written another way (+971529319100, 052 931 9100) still passes.
export function bcFindInventedContact(reply,source){
  const src=String(source||'');
  const keys=new Set();
  for(const m of src.matchAll(PHONE_RE)){ const d=digits(m[0]); if(d.length>=7) keys.add(d.slice(-9)); }
  const emails=new Set(bcEmailsIn(src));
  for(const p of bcPhonesIn(reply)) if(!keys.has(bcPhoneKey(p))) return p;
  for(const e of bcEmailsIn(reply)) if(!emails.has(e)) return e;
  return null;
}

// Last resort when a regenerated reply still has an invented contact: drop each line/sentence
// that carries one (a number cut out mid-sentence reads worse than no sentence).
export function bcStripInvented(reply,source){
  const pieces=String(reply||'').split(/\n/);
  const kept=pieces.map(line=>{
    if(!bcFindInventedContact(line,source)) return line;
    const sentences=line.split(/(?<=[.!?।])\s+/).filter(s=>!bcFindInventedContact(s,source));
    return sentences.join(' ');
  }).filter((l,i,a)=>l.trim()||(i>0&&a[i-1].trim()));
  return kept.join('\n').replace(/\n{3,}/g,'\n\n').trim();
}

// The instruction added for the one regeneration.
export function bcCorrection(bad,data){
  const allowed=[];
  if(data){
    const id=data.identity||{};
    if(id.phone) allowed.push(id.phone);
    if(id.whatsapp&&bcPhoneKey(id.whatsapp)!==bcPhoneKey(id.phone)) allowed.push(id.whatsapp);
    if(id.email) allowed.push(id.email);
    for(const d of data.departments||[]) if(d.public){ if(d.phone) allowed.push(`${d.name}: ${d.phone}`); if(d.email) allowed.push(`${d.name}: ${d.email}`); }
  }
  return `\n\nIMPORTANT: your draft reply included a phone number or email address that was never given to you: "${bad}". Never invent, guess or complete a phone number or email. `
    +(allowed.length?`The ONLY real ones you may share: ${allowed.join('; ')}. Give just the one that fits.`:'You have no contact number or email to share right now — say the team will reach out instead.');
}
