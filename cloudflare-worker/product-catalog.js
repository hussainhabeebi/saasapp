// Products & Services catalogue for General-industry accounts (products-services.html).
//
// The account lists what it sells — products and services, with full details, a price, photos,
// an optional video, voice note and brochure, all as Google Drive share links (a video may also be
// a YouTube or other link). Two things read it:
//  - the bot: when a customer names an item in chat, its details card, photos, video, voice note
//    and brochure go into the chat (once per lead per item per day), and the AI's answers are
//    grounded on the catalogue (pcContextBlock);
//  - Chats → 📑 AI Proposal: the agent picks items and quantities, the AI writes the proposal's
//    words from the chat (pcProposalPrompt / pcProposalDraft), the agent reviews and edits it, and
//    "Approve & send" puts a proposal PDF into the chat (pcBuildProposalPdf).
// Prices only ever come from the catalogue or the agent — never from the AI.
//
// Pure: no env, no fetch. worker.js owns D1, Drive and Chatwoot.

import {taPdf} from './travel-itinerary.js';

export const PC_KINDS=['product','service'];
export const PC_IMAGE_FIELDS=['image_url_1','image_url_2','image_url_3','image_url_4','image_url_5'];
export const PC_MEDIA_RESEND_WINDOW_MS=24*60*60*1000;
export const PC_MAX_ITEMS_PER_MESSAGE=2;
export const PC_PROPOSAL_MAX_ITEMS=20;

// Industries with their own catalogue modules. Every other account — 'general', no industry, or a
// free-text industry the dashboard doesn't know — is a General account and gets this one.
const PC_OWN_CATALOGUE_INDUSTRIES=new Set(['insurance','real_estate','healthcare','education','automotive','travel','ecommerce','consultancy',
  'b2b','hospitality','saas_digital_marketing','business_services','matrimonial','ev_charging']);
export function pcIsOn(c){
  if(!c) return false;
  return !PC_OWN_CATALOGUE_INDUSTRIES.has(String(c.industry||'').trim().toLowerCase());
}

const str=(v,max)=>String(v??'').replace(/\r\n?/g,'\n').trim().slice(0,max);
const line=(v,max)=>String(v??'').replace(/\s+/g,' ').trim().slice(0,max);
const isLink=u=>/^https?:\/\/\S+$/i.test(String(u||'').trim());
const norm=s=>String(s||'').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();

export function pcPrice(v){
  if(v===null||v===undefined||String(v).trim()==='') return null;
  const n=Number(String(v).replace(/[, ]/g,''));
  return Number.isFinite(n)&&n>=0?Math.round(n*100)/100:null;
}
export function pcCurrency(v){
  const s=String(v||'').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(s)?s:'INR';
}
export function pcMoney(n,cur){
  if(n===null||n===undefined||!Number.isFinite(Number(n))) return '';
  const c=pcCurrency(cur);
  const v=Math.round(Number(n)*100)/100,d=Number.isInteger(v)?0:2;
  return `${c} ${v.toLocaleString(c==='INR'?'en-IN':'en-US',{minimumFractionDigits:d,maximumFractionDigits:d})}`;
}
export const pcList=v=>String(v||'').split(/\n|;|•/).map(x=>x.replace(/^\s*[-*]\s*/,'').trim()).filter(Boolean);
export const pcKeywords=v=>String(v||'').split(/[,\n]/).map(x=>x.trim()).filter(x=>x.length>=2).slice(0,20);

// A create/update body → the columns to write, or {error}. `partial` (an update) only touches the
// fields present in the body.
export function pcCleanItem(body,{partial=false}={}){
  const b=body&&typeof body==='object'?body:{};
  const has=k=>!partial||k in b;
  const out={};
  if(has('name')){ const n=line(b.name,120); if(!n) return {error:'Name is required'}; out.name=n; }
  if(has('kind')) out.kind=PC_KINDS.includes(String(b.kind||'').toLowerCase())?String(b.kind).toLowerCase():'product';
  if(has('category')) out.category=line(b.category,80);
  if(has('sku')) out.sku=line(b.sku,60);
  if(has('short_description')) out.short_description=line(b.short_description,300);
  if(has('details')) out.details=str(b.details,5000);
  if(has('features')) out.features=str(b.features,2000);
  // What the price covers and what it doesn't (one per line) — the proposal's scope page.
  if(has('inclusions')) out.inclusions=pcList(b.inclusions).map(x=>line(x,200)).slice(0,30).join('\n');
  if(has('exclusions')) out.exclusions=pcList(b.exclusions).map(x=>line(x,200)).slice(0,30).join('\n');
  if(has('keywords')) out.keywords=line(b.keywords,500);
  if(has('price')){
    if(String(b.price??'').trim()!==''&&pcPrice(b.price)===null) return {error:'Price must be a number'};
    out.price=pcPrice(b.price);
  }
  if(has('currency')) out.currency=pcCurrency(b.currency);
  if(has('price_unit')) out.price_unit=line(b.price_unit,40);
  for(const f of [...PC_IMAGE_FIELDS,'video_url','voice_note_url','brochure_url']){
    if(!has(f)) continue;
    const u=line(b[f],1000);
    if(u&&!isLink(u)) return {error:`${f.replace(/_/g,' ')} must be a link (https://…)`};
    out[f]=u;
  }
  if(has('auto_send')) out.auto_send=b.auto_send===false||b.auto_send===0||b.auto_send==='0'?0:1;
  if(has('status')) out.status=String(b.status||'').toLowerCase()==='inactive'?'inactive':'active';
  if(has('sort_order')) out.sort_order=Number.isFinite(Number(b.sort_order))?Math.trunc(Number(b.sort_order)):0;
  return out;
}

export const pcPhotos=item=>PC_IMAGE_FIELDS.map(f=>line(item?.[f],1000)).filter(isLink);
export function pcPriceText(item){
  const p=pcPrice(item?.price);
  if(p===null) return '';
  return `${pcMoney(p,item?.currency)}${item?.price_unit?` ${line(item.price_unit,40).replace(/^(?!\/|per\b)/i,'/ ')}`:''}`;
}

/* ── Bot: which item did the customer name? ─────────────────────────────────────────────────── */

// The item names (and keywords) the message mentions as whole words — longest match wins, so
// "Solar Water Heater 200L" wins over "Solar Water Heater" when both exist. Names shorter than 3
// characters never match on their own (too easy to hit by accident).
export function pcFindItemsInText(items,text,{max=PC_MAX_ITEMS_PER_MESSAGE}={}){
  const t=` ${norm(text)} `;
  if(!t.trim()) return [];
  const hits=[];
  for(const it of items||[]){
    if(!it||it.status==='inactive') continue;
    const terms=[it.name,it.sku,...pcKeywords(it.keywords)].map(norm).filter(x=>x.length>=3);
    let best=0,at=Infinity;
    for(const term of terms){ const i=t.indexOf(` ${term} `); if(i>=0){ best=Math.max(best,term.length); at=Math.min(at,i); } }
    if(best) hits.push({it,best,at});
  }
  hits.sort((a,b)=>b.best-a.best);
  // A shorter name that's part of a longer matched one ("Heater" inside "Solar Water Heater") is
  // the same mention, not a second item.
  const out=[];
  for(const h of hits){
    const n=norm(h.it.name);
    if(out.some(o=>norm(o.it.name).includes(n))) continue;
    out.push(h);
    if(out.length>=max) break;
  }
  // …returned in the order the customer mentioned them.
  return out.sort((a,b)=>a.at-b.at).map(h=>h.it);
}

// The details card the bot sends for a named item (WhatsApp formatting).
export function pcItemCard(item){
  const out=[`${item?.kind==='service'?'🛠️':'📦'} *${line(item?.name,120)}*`];
  const price=pcPriceText(item);
  if(price) out.push(`💰 ${price}`);
  if(item?.short_description) out.push('',line(item.short_description,300));
  if(item?.details) out.push('',str(item.details,1500));
  const feats=pcList(item?.features).slice(0,12);
  if(feats.length) out.push('','✅ *Highlights*',...feats.map(f=>`• ${f}`));
  const inc=pcList(item?.inclusions).slice(0,12),exc=pcList(item?.exclusions).slice(0,12);
  if(inc.length) out.push('','📦 *What\'s included*',...inc.map(f=>`• ${f}`));
  if(exc.length) out.push('','🚫 *Not included*',...exc.map(f=>`• ${f}`));
  return out.join('\n').replace(/\n{3,}/g,'\n\n').trim();
}

// A Google Drive link (sent as the file itself); anything else (YouTube, Vimeo…) goes as a link.
export const pcIsDriveLink=u=>/^https?:\/\/(drive|docs)\.google\.com\//i.test(String(u||'').trim());
// What the bot sends after the card, in order: photos, the video, the voice note, then the brochure.
// A video is a Drive file sent as a WhatsApp video when it fits (worker.js), else its link.
export function pcMediaPlan(item){
  const plan=pcPhotos(item).map((url,i)=>({url,kind:'image',caption:i===0?`📷 ${line(item?.name,120)}`:''}));
  if(isLink(item?.video_url)){
    const url=line(item.video_url,1000);
    plan.push({url,kind:'video',drive:pcIsDriveLink(url),caption:`🎬 ${line(item?.name,120)}`});
  }
  if(isLink(item?.voice_note_url)) plan.push({url:line(item.voice_note_url,1000),kind:'voice',caption:''});
  if(isLink(item?.brochure_url)) plan.push({url:line(item.brochure_url,1000),kind:'document',caption:`📄 ${line(item?.name,120)} — brochure`});
  return plan;
}

// The message for a video that goes as a link (YouTube, or a Drive video too large to attach).
export function pcVideoLinkText(item,url){
  return `🎬 Watch the ${line(item?.name,120)} video: ${line(url,1000)}`;
}

// Verified catalogue for the AI's grounded answers (appended to the FAQ prompt's context).
export function pcContextBlock(items,{max=60}={}){
  const list=(items||[]).filter(i=>i&&i.status!=='inactive'&&line(i.name,120)).slice(0,max);
  if(!list.length) return '';
  const lines=['\n\n## VERIFIED PRODUCTS & SERVICES (use ONLY these facts for names, details and prices — never invent an item, feature or price that is not listed. When an item is named, its details, photos and any voice note or brochure are sent to the customer automatically, so keep your own reply short and don\'t paste the full details again)'];
  for(const k of PC_KINDS){
    const group=list.filter(i=>(i.kind||'product')===k);
    if(!group.length) continue;
    lines.push(`\n### ${k==='service'?'Services':'Products'}`);
    for(const i of group){
      let l=`- **${line(i.name,120)}**`;
      if(i.category) l+=` | Category: ${line(i.category,80)}`;
      const price=pcPriceText(i);
      l+=` | Price: ${price||'on request — the team shares it'}`;
      if(i.short_description) l+=` | ${line(i.short_description,200)}`;
      const feats=pcList(i.features).slice(0,6);
      if(feats.length) l+=` | Highlights: ${feats.join('; ')}`;
      const inc=pcList(i.inclusions).slice(0,8),exc=pcList(i.exclusions).slice(0,8);
      if(inc.length) l+=` | Included: ${inc.join('; ')}`;
      if(exc.length) l+=` | NOT included: ${exc.join('; ')}`;
      if(i.details) l+=` | Details: ${line(i.details,500)}`;
      lines.push(l);
    }
  }
  return lines.join('\n');
}

/* ── Chats → 📑 AI Proposal ─────────────────────────────────────────────────────────────────── */

// Chat rows (lead_messages, oldest first) → a "Customer:/Business:" transcript, newest kept when
// it is too long.
export function pcTranscript(rows,{maxChars=6000}={}){
  const lines=(rows||[]).map(r=>{
    const t=line(r?.content,600);
    if(!t) return '';
    return `${r.role==='user'?'Customer':'Business'}: ${t}`;
  }).filter(Boolean);
  const out=[];let n=0;
  for(let i=lines.length-1;i>=0;i--){ n+=lines[i].length+1; if(n>maxChars) break; out.unshift(lines[i]); }
  return out.join('\n');
}

// Selected [{id,qty}] + the catalogue rows → [{item,qty}] in the agent's order (unknown ids and
// inactive items dropped, quantities clamped to 1…9999, duplicates merged).
export function pcSelection(selected,items){
  const byId=new Map((items||[]).map(i=>[String(i.id),i]));
  const out=[];
  for(const s of Array.isArray(selected)?selected:[]){
    const it=byId.get(String(s?.id??s));
    if(!it||it.status==='inactive') continue;
    const qty=Math.min(9999,Math.max(1,Math.round(Number(s?.qty)||1)));
    const prev=out.find(o=>o.item===it);
    if(prev) prev.qty=Math.min(9999,prev.qty+qty); else out.push({item:it,qty});
    if(out.length>=PC_PROPOSAL_MAX_ITEMS) break;
  }
  return out;
}

export function pcProposalPrompt({business='',customer='',selection=[],transcript='',notes=''}={}){
  const biz=line(business,120)||'our company';
  const system=`You are a senior sales consultant at ${biz}, writing a professional, customer-facing business proposal for a customer you have been chatting with on WhatsApp. Respond with ONLY compact JSON, no commentary, in exactly this shape:
{"title":"proposal title, max 10 words","summary":"3-5 sentences: what the customer needs, in their own terms from the chat, and how this proposal meets it","items":[{"id":"the item's id exactly as given","description":"1-2 sentences on what this item is and why it fits this customer"}],"benefits":["3-5 short reasons to choose ${biz.replace(/"/g,"'")}"],"next_steps":["2-4 short, concrete next steps"],"terms":["2-5 short commercial terms"],"closing":"1-2 warm closing sentences"}
Rules:
- Write in clear, professional English, unless the agent's notes ask for another language.
- "items" lists every selected item once, in the order given, and nothing else — never add, swap or rename an item.
- Describe each item using ONLY its own details below. Never invent features, specifications, certifications, warranties, delivery times or results that are not given.
- Never write any price, rate, discount, tax or total anywhere — the system adds the price table from the catalogue.
- Base the summary on what the customer actually said in the chat. If the chat says little, keep it general and positive; never invent the customer's requirements.
- Terms: only general ones (validity, payment on confirmation, prices subject to final confirmation) unless the agent's notes give specific terms.
- Never invent phone numbers, emails, addresses or links.`;
  const items=selection.map(({item:i,qty})=>[
    `- id: ${i.id}`,`  name: ${line(i.name,120)}`,`  type: ${i.kind==='service'?'service':'product'}`,`  quantity: ${qty}`,
    i.category?`  category: ${line(i.category,80)}`:'',i.short_description?`  summary: ${line(i.short_description,300)}`:'',
    pcList(i.features).length?`  highlights: ${pcList(i.features).slice(0,10).join('; ')}`:'',
    pcList(i.inclusions).length?`  included: ${pcList(i.inclusions).slice(0,15).join('; ')}`:'',pcList(i.exclusions).length?`  not included: ${pcList(i.exclusions).slice(0,15).join('; ')}`:'',i.details?`  details: ${line(i.details,1200)}`:'',
  ].filter(Boolean).join('\n')).join('\n');
  const user=[`Business: ${biz}`,customer?`Customer: ${line(customer,80)}`:'',`Selected items:\n${items}`,
    notes?`Agent's notes (follow these): ${str(notes,1500)}`:'',
    `Chat with the customer (oldest first):\n${transcript||'(no messages yet)'}`].filter(Boolean).join('\n\n');
  return {system,user};
}

function pcJson(text){
  const s=String(text||'').replace(/```(?:json)?/gi,'');
  const a=s.indexOf('{'),b=s.lastIndexOf('}');
  if(a<0||b<=a) return null;
  try{ return JSON.parse(s.slice(a,b+1)); }catch(e){ return null; }
}
const pcStrList=(v,max,len)=>(Array.isArray(v)?v:[]).map(x=>line(x,len)).filter(Boolean).slice(0,max);

// The model's JSON → the proposal the review shows: every selected item exactly once, in the
// agent's order, with the catalogue price; the AI's wording where it gave one.
export function pcParseProposal(text,selection){
  const j=pcJson(text);
  if(!j||typeof j!=='object') return {error:'The AI reply was not valid JSON.'};
  const said=new Map((Array.isArray(j.items)?j.items:[]).map(x=>[String(x?.id??''),line(x?.description,400)]));
  const items=selection.map(({item:i,qty})=>({id:String(i.id),name:line(i.name,120),qty,
    unit_price:pcPrice(i.price),currency:pcCurrency(i.currency),price_unit:line(i.price_unit,40),
    description:said.get(String(i.id))||line(i.short_description,400),
    inclusions:pcScopeList(i.inclusions),exclusions:pcScopeList(i.exclusions)}));
  const summary=line(j.summary,1500);
  if(!summary) return {error:'The AI draft had no summary.'};
  return {title:line(j.title,120)||'Business Proposal',summary,items,
    benefits:pcStrList(j.benefits,6,200),next_steps:pcStrList(j.next_steps,5,200),terms:pcStrList(j.terms,6,240),
    closing:line(j.closing,500),inclusions:[],exclusions:[]};
}
// Inclusions / exclusions: one per line in the catalogue, a list in a proposal.
export const pcScopeList=v=>(Array.isArray(v)?v.map(x=>String(x??'')):pcList(v)).map(x=>line(x,200)).filter(Boolean).slice(0,30);

// (system,user) → model text or {error}; one retry on an unusable reply.
export async function pcProposalDraft(opts,generate){
  if(!opts?.selection?.length) return {error:'Pick at least one product or service.'};
  const {system,user}=pcProposalPrompt(opts);
  const reasons=[];
  for(let attempt=0;attempt<2;attempt++){
    const out=await generate(system,attempt?`${user}\n\nYour previous reply was not usable JSON. Reply with ONLY the JSON object.`:user);
    if(out&&typeof out==='object'&&out.error){ reasons.push(out.error); break; }
    const p=pcParseProposal(out,opts.selection);
    if(!p.error) return p;
    reasons.push(p.error);
  }
  return {error:reasons[reasons.length-1]||'The AI could not draft this proposal.',reasons};
}

// The proposal as the agent sent it back from the review → clean values (text trimmed, prices
// and quantities re-checked, item ids kept only when they're in the catalogue).
export function pcCleanProposal(p,items){
  const byId=new Map((items||[]).map(i=>[String(i.id),i]));
  const rows=(Array.isArray(p?.items)?p.items:[]).map(r=>{
    const it=byId.get(String(r?.id??''));
    if(!it) return null;
    return {id:String(it.id),name:line(it.name,120),qty:Math.min(9999,Math.max(1,Math.round(Number(r?.qty)||1))),
      unit_price:r?.unit_price===undefined?pcPrice(it.price):pcPrice(r.unit_price),currency:pcCurrency(it.currency),
      price_unit:line(it.price_unit,40),description:line(r?.description,400),
      // The agent's edited lists from the review; the catalogue's when the proposal didn't carry any.
      inclusions:pcScopeList(r?.inclusions===undefined?it.inclusions:r.inclusions),exclusions:pcScopeList(r?.exclusions===undefined?it.exclusions:r.exclusions)};
  }).filter(Boolean).slice(0,PC_PROPOSAL_MAX_ITEMS);
  const list=v=>(Array.isArray(v)?v:pcList(v)).map(x=>line(x,240)).filter(Boolean).slice(0,8);
  const pct=v=>{const n=Number(v);return Number.isFinite(n)&&n>0?Math.min(100,Math.round(n*100)/100):0;};
  return {title:line(p?.title,120)||'Business Proposal',summary:str(p?.summary,2000),items:rows,customer:pcCleanCustomer(p?.customer),prepared_by:line(p?.prepared_by,60),
    benefits:list(p?.benefits),next_steps:list(p?.next_steps),terms:list(p?.terms),closing:str(p?.closing,600),
    inclusions:pcScopeList(p?.inclusions),exclusions:pcScopeList(p?.exclusions),
    discount_pct:pct(p?.discount_pct),tax_pct:pct(p?.tax_pct),tax_label:line(p?.tax_label,20)||'Tax',
    valid_days:Math.min(365,Math.max(0,Math.round(Number(p?.valid_days)||0)))};
}

// The "Prepared for" block: who the proposal is addressed to. Address keeps its line breaks.
export function pcCleanCustomer(c){
  const o=c&&typeof c==='object'?c:{};
  return {name:line(o.name,100),company:line(o.company,120),phone:line(o.phone,40),email:line(o.email,120),
    address:str(o.address,400).split('\n').map(x=>line(x,120)).filter(Boolean).slice(0,5).join('\n'),gstin:line(o.gstin,20).toUpperCase()};
}

// Proposal status (Dashboard → 📑 Proposals). The agent sets sent / negotiating / accepted /
// rejected; "expired" (validity passed) and "revised" (a newer proposal went to the same lead)
// are worked out while the proposal is still open.
export const PC_PROPOSAL_STATUSES=['sent','negotiating','accepted','rejected'];
export const PC_PROPOSAL_OPEN=new Set(['sent','negotiating']);
export function pcProposalStatus(row,{now=new Date(),newerSent=false}={}){
  const st=PC_PROPOSAL_STATUSES.includes(row?.status)?row.status:'sent';
  if(!PC_PROPOSAL_OPEN.has(st)) return st;
  if(newerSent) return 'revised';
  if(row?.valid_until&&new Date(row.valid_until).getTime()<now.getTime()) return 'expired';
  return st;
}
// Sequential per-account proposal number: PRP-2026-0007.
export function pcProposalRef(seq,now=new Date()){
  return `PRP-${now.getUTCFullYear()}-${String(Math.max(1,Number(seq)||1)).padStart(4,'0')}`;
}
export function pcProposalValidUntil(p,now=new Date()){
  return p?.valid_days?new Date(now.getTime()+p.valid_days*864e5).toISOString():'';
}

// Subtotal / discount / tax / total over the priced rows (all in the first priced row's currency).
export function pcProposalTotals(p){
  const priced=(p?.items||[]).filter(r=>r.unit_price!==null&&r.unit_price!==undefined);
  const currency=priced[0]?.currency||p?.items?.[0]?.currency||'INR';
  const r2=n=>Math.round(n*100)/100;
  const subtotal=r2(priced.reduce((s,r)=>s+r.unit_price*r.qty,0));
  const discount=r2(subtotal*(Number(p?.discount_pct)||0)/100);
  const tax=r2((subtotal-discount)*(Number(p?.tax_pct)||0)/100);
  return {currency,subtotal,discount,tax,total:r2(subtotal-discount+tax),priced:priced.length,unpriced:(p?.items||[]).length-priced.length};
}

export function pcProposalPdfName(p,customer){
  const slug=s=>String(s||'').replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'').slice(0,50);
  return `Proposal-${slug(customer)||slug(p?.title)||'proposal'}.pdf`;
}

const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const dateText=d=>`${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

// A4 proposal PDF (Uint8Array), laid out like a business letterhead:
//  - letterhead: logo, business name, full address, phone / email / website, GSTIN; on the right
//    "PROPOSAL" with the proposal number, date and validity;
//  - "Prepared for" (customer name, company, address, phone, email, GSTIN) and "Prepared by";
//  - title, overview, one card per item (photo, name, description, quantity), then a priced
//    commercial summary table with subtotal / discount / tax / total;
//  - "Scope of Work — Inclusions & Exclusions" on a page of its own (when any item, or the
//    proposal as a whole, lists them): per item, what is included beside what is not;
//  - why-us, next steps, terms, the closing, and an acceptance block with two signature lines;
//  - every page: a footer with the business name, address, contacts and "Page x of y".
// opts.images: Map(item id → prepared image from taPrepareImage); opts.logo: prepared image.
// opts.customer: the customer's name when p.customer has none (older callers).
export function pcBuildProposalPdf(p,{business='',address='',phone='',email='',website='',gstin='',preparedBy='',customer='',accent='#0D9C93',logo=null,images=new Map(),now=new Date(),ref=''}={}){
  const {safe,esc,wrap,textWidth,hexRgb}=taPdf;
  const W=595,H=842,MX=44,CW=W-MX*2,BOTTOM=72;
  const AC=hexRgb(accent,[0.05,0.61,0.58]).map(v=>v.toFixed(3)).join(' ');
  const TINT=hexRgb(accent,[0.05,0.61,0.58]).map(v=>(0.93+v*0.07).toFixed(3)).join(' ');
  const INK='0.13 0.15 0.19',MUTED='0.4 0.43 0.48',BODY='0.25 0.28 0.32',RULE='0.84 0.87 0.89';
  const biz=safe(business).trim();
  const cust={...pcCleanCustomer(p.customer)};if(!cust.name)cust.name=line(customer,100);
  const addrLines=String(address||'').split('\n').map(x=>x.trim()).filter(Boolean).slice(0,4);
  const site=String(website||'').trim().replace(/^https?:\/\//i,'').replace(/\/$/,'');
  const contactBits=[safe(phone).trim(),safe(email).trim(),safe(site)].filter(Boolean);
  const validUntil=p.valid_days?dateText(new Date(now.getTime()+p.valid_days*864e5)):'';
  const pics=[];const imgName=img=>{if(!img)return null;let i=pics.indexOf(img);if(i<0){pics.push(img);i=pics.length-1;}return `Im${i+1}`;};
  const pages=[];let ops=[],y=0;
  const o=s=>ops.push(s);
  const fit=(s,size,bold,w)=>{s=safe(s);if(textWidth(s,size,bold)<=w)return s;while(s&&textWidth(s+'...',size,bold)>w)s=s.slice(0,-1);return s.replace(/[\s,|]+$/,'')+'...';};
  const txt=(x,yy,s,size,bold,rgb=INK)=>o(`BT ${rgb} rg /${bold?'F2':'F1'} ${size} Tf ${x.toFixed(1)} ${yy.toFixed(1)} Td (${esc(safe(s))}) Tj ET`);
  const rect=(x,yy,w,h,rgb)=>o(`${rgb} rg ${x.toFixed(1)} ${yy.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re f`);
  const hline=(x1,x2,yy,rgb=RULE,w=0.6)=>o(`${rgb} RG ${w} w ${x1.toFixed(1)} ${yy.toFixed(1)} m ${x2.toFixed(1)} ${yy.toFixed(1)} l S`);
  const round=(x,yy,w,h,r,rgb)=>{const k=0.5523*r;o(`${rgb} rg ${x+r} ${yy} m ${x+w-r} ${yy} l ${x+w-r+k} ${yy} ${x+w} ${yy+r-k} ${x+w} ${yy+r} c ${x+w} ${yy+h-r} l ${x+w} ${yy+h-r+k} ${x+w-r+k} ${yy+h} ${x+w-r} ${yy+h} c ${x+r} ${yy+h} l ${x+r-k} ${yy+h} ${x} ${yy+h-r+k} ${x} ${yy+h-r} c ${x} ${yy+r} l ${x} ${yy+r-k} ${x+r-k} ${yy} ${x+r} ${yy} c h f`);};
  const image=(img,x,yy,w,h,fitIn=false)=>{
    const n=imgName(img);if(!n)return;
    const s=fitIn?Math.min(w/img.w,h/img.h):Math.max(w/img.w,h/img.h),dw=img.w*s,dh=img.h*s;
    o(`q ${x.toFixed(1)} ${yy.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re W n ${dw.toFixed(2)} 0 0 ${dh.toFixed(2)} ${(x+(w-dw)/2).toFixed(2)} ${(yy+(h-dh)/2).toFixed(2)} cm /${n} Do Q`);
  };
  const right=(xr,yy,s,size,bold,rgb)=>txt(xr-textWidth(safe(s),size,bold),yy,s,size,bold,rgb);

  // ── Letterhead (first page) ──
  const letterhead=()=>{
    rect(0,H-6,W,6,AC);
    const top=H-30;let tx=MX;
    if(logo){const bh=54,bw=Math.min(110,Math.max(54,bh*logo.w/logo.h));image(logo,MX,top-bh,bw,bh,true);tx=MX+bw+14;}
    const lw=W-MX-200-tx;let ly=top-16;
    wrap(biz||'Proposal',16,true,lw,2).forEach(l=>{txt(tx,ly,l,16,true);ly-=19;});
    ly-=1;
    addrLines.forEach(a=>wrap(a,8.8,false,lw,3).forEach(l=>{txt(tx,ly,l,8.8,false,MUTED);ly-=11.5;}));
    if(contactBits.length)wrap(contactBits.join('  |  '),8.8,false,lw,2).forEach(l=>{txt(tx,ly,l,8.8,false,MUTED);ly-=11.5;});
    if(gstin){txt(tx,ly,`GSTIN: ${gstin}`,8.8,true,MUTED);ly-=11.5;}
    // Right: PROPOSAL + number / date / validity
    right(W-MX,top-20,'PROPOSAL',22,true,AC);
    let ry=top-40;const lx=W-MX-180;
    [['Proposal No.',ref],['Date',dateText(now)],['Valid until',validUntil]].filter(([,v])=>v).forEach(([k,v])=>{
      txt(lx,ry,k,8.8,false,MUTED);right(W-MX,ry,v,9.2,true);ry-=13.5;});
    y=Math.min(ly,ry,logo?top-54:top)-10;
    hline(MX,W-MX,y,AC,1.2);
    y-=18;
  };
  const contHeader=()=>{
    rect(0,H-6,W,6,AC);
    txt(MX,H-28,fit(`${biz?biz+'  |  ':''}${safe(p.title)}`,9.5,true,CW-150),9.5,true,INK);
    if(ref)right(W-MX,H-28,ref,9,false,MUTED);
    hline(MX,W-MX,H-38);
    y=H-56;
  };
  const newPage=()=>{pages.push(ops);ops=[];contHeader();};
  const need=h=>{if(y-h<BOTTOM)newPage();};
  const section=(title,follow=40)=>{need(44+follow);y-=14;txt(MX,y-12,title.toUpperCase(),10.5,true,AC);hline(MX,W-MX,y-19,RULE,0.6);y-=32;};
  const para=(text,size=10.3,rgb=BODY,gap=4.6)=>{for(const l of wrap(text,size,false,CW)){need(size+gap);txt(MX,y-size,l,size,false,rgb);y-=size+gap;}};
  const bullets=list=>list.forEach(item=>{
    const ls=wrap(item,10,false,CW-20);
    need(ls.length*13.5+4);
    rect(MX+4,y-10.5,4.5,4.5,AC);
    ls.forEach(l=>{txt(MX+18,y-10,l,10,false,'0.2 0.23 0.27');y-=13.5;});
    y-=3;
  });

  letterhead();

  // ── Prepared for / Prepared by ──
  {
    const gap=14,bw=(CW-gap)/2,pad=12;
    const forLines=[];
    if(cust.company&&cust.name)forLines.push([cust.company,false]);
    cust.address.split('\n').filter(Boolean).forEach(a=>wrap(a,9.2,false,bw-pad*2,3).forEach(l=>forLines.push([l,false])));
    if(cust.phone)forLines.push([`Phone: ${cust.phone}`,false]);
    if(cust.email)forLines.push([`Email: ${cust.email}`,false]);
    if(cust.gstin)forLines.push([`GSTIN: ${cust.gstin}`,false]);
    const forName=cust.name||cust.company||'Valued Customer';
    const byLines=[];
    preparedBy=preparedBy||p.prepared_by||'';
    if(preparedBy)byLines.push([`Contact: ${line(preparedBy,60)}`,false]);
    if(phone)byLines.push([`Phone: ${safe(phone).trim()}`,false]);
    if(email)byLines.push([`Email: ${safe(email).trim()}`,false]);
    if(site)byLines.push([`Web: ${site}`,false]);
    const h=pad+14+16+Math.max(forLines.length,byLines.length,1)*12.5+pad-4;
    const box=(x,label,name,ls)=>{
      round(x,y-h,bw,h,6,TINT);rect(x,y-h,3,h,AC);
      let ty=y-pad-8;
      txt(x+pad+4,ty,label,8,true,AC);ty-=16;
      txt(x+pad+4,ty,fit(name,11.5,true,bw-pad*2-4),11.5,true);ty-=14.5;
      ls.forEach(([l])=>{txt(x+pad+4,ty,fit(l,9.2,false,bw-pad*2-4),9.2,false,BODY);ty-=12.5;});
    };
    box(MX,'PREPARED FOR',forName,forLines);
    box(MX+bw+gap,'PREPARED BY',biz||'Our team',byLines);
    y-=h+20;
  }

  // ── Title ──
  wrap(p.title||'Business Proposal',21,true,CW,3).forEach(l=>{need(28);txt(MX,y-21,l,21,true);y-=27;});
  y-=2;
  if(p.summary){section('Overview');para(p.summary);}

  // ── Items ──
  const totals=pcProposalTotals(p);
  if(p.items.length){
    section('Proposed Products & Services',100);
    p.items.forEach((r,idx)=>{
      const img=images.get(String(r.id))||null;
      const iw=img?92:0,tx=MX+14+(img?iw+14:0),tw=CW-28-(img?iw+14:0)-70;
      const head=wrap(`${idx+1}. ${r.name}`,11.5,true,tw,2),body=r.description?wrap(r.description,9.3,false,tw,5):[];
      const h=Math.max(img?84:0,18+head.length*14.5+body.length*12.2+8);
      need(h+10);
      round(MX,y-h,CW,h,7,idx%2?'0.975 0.978 0.982':'0.962 0.968 0.972');
      if(img)image(img,MX+10,y-h+(h-68)/2,iw,68);
      let ty=y-19;
      head.forEach(l=>{txt(tx,ty,l,11.5,true);ty-=14.5;});
      body.forEach(l=>{txt(tx,ty,l,9.3,false,'0.36 0.39 0.44');ty-=12.2;});
      right(MX+CW-14,y-19,`Qty ${r.qty}`,9.5,true,AC);
      y-=h+7;
    });

    // ── Commercial summary (price table) ──
    section('Commercial Summary',90);
    const cols=[{k:'#',w:26,a:'l'},{k:'Description',w:CW-26-48-104-110,a:'l'},{k:'Qty',w:48,a:'r'},{k:'Unit Price',w:104,a:'r'},{k:'Amount',w:110,a:'r'}];
    const xs=[];cols.reduce((x,c)=>{xs.push(x);return x+c.w;},MX);
    const cell=(i,yy,s,size,bold,rgb)=>{const c=cols[i];if(c.a==='r')right(xs[i]+c.w-8,yy,s,size,bold,rgb);else txt(xs[i]+8,yy,fit(s,size,bold,c.w-14),size,bold,rgb);};
    const headRow=()=>{rect(MX,y-22,CW,22,AC);cols.forEach((c,i)=>cell(i,y-15,c.k,8.8,true,'1 1 1'));y-=22;};
    need(22+24);headRow();
    p.items.forEach((r,idx)=>{
      const nl=wrap(r.name,9.4,false,cols[1].w-14,2);const rh=Math.max(22,nl.length*12+10);
      if(y-rh<BOTTOM){newPage();headRow();}
      if(idx%2)rect(MX,y-rh,CW,rh,'0.975 0.978 0.982');
      cell(0,y-14.5,String(idx+1),9.2,false,MUTED);
      nl.forEach((l,k)=>txt(xs[1]+8,y-14.5-k*12,l,9.4,false,INK));
      cell(2,y-14.5,String(r.qty),9.2,false,INK);
      const priced=r.unit_price!==null&&r.unit_price!==undefined;
      const per=r.price_unit?` / ${String(r.price_unit).replace(/^(per\s+|\/\s*)/i,'')}`:'';
      cell(3,y-14.5,priced?fit(pcMoney(r.unit_price,r.currency)+per,9.2,false,cols[3].w-12):'On request',9.2,false,priced?INK:MUTED);
      cell(4,y-14.5,priced?pcMoney(r.unit_price*r.qty,r.currency):'On request',9.2,true,priced?INK:MUTED);
      hline(MX,W-MX,y-rh,RULE,0.5);
      y-=rh;
    });
    if(totals.priced){
      const rows=[['Subtotal',pcMoney(totals.subtotal,totals.currency)]];
      if(totals.discount)rows.push([`Discount (${p.discount_pct}%)`,`- ${pcMoney(totals.discount,totals.currency)}`]);
      if(totals.tax)rows.push([`${p.tax_label||'Tax'} (${p.tax_pct}%)`,pcMoney(totals.tax,totals.currency)]);
      const bw=250,bx=MX+CW-bw,bh=rows.length*17+12+30;
      need(bh+8);y-=6;
      let ty=y-13;
      rows.forEach(([k,v])=>{txt(bx+12,ty,k,9.6,false,MUTED);right(bx+bw-10,ty,v,9.6,true);ty-=17;});
      rect(bx,ty-20,bw,28,AC);
      txt(bx+12,ty-10,'TOTAL',10.5,true,'1 1 1');right(bx+bw-10,ty-11,pcMoney(totals.total,totals.currency),13.5,true,'1 1 1');
      y=ty-28;
      if(totals.unpriced){need(16);y-=4;txt(MX,y-9,`${totals.unpriced} item${totals.unpriced>1?'s are':' is'} priced on request and not included in the total.`,8.5,false,MUTED);y-=14;}
      y-=4;
    }else{need(16);y-=4;txt(MX,y-9,'All items are priced on request - we will confirm the final price with you.',8.8,false,MUTED);y-=16;}
  }
  // ── Scope: inclusions & exclusions, starting on a page of its own ──
  const scoped=p.items.map((r,idx)=>({title:`${idx+1}. ${r.name}`,inc:r.inclusions||[],exc:r.exclusions||[]})).filter(x=>x.inc.length||x.exc.length);
  if((p.inclusions||[]).length||(p.exclusions||[]).length) scoped.push({title:'General - applies to the whole proposal',inc:p.inclusions||[],exc:p.exclusions||[]});
  if(scoped.length){
    newPage();
    txt(MX,y-18,'Scope of Work',18,true);y-=26;
    txt(MX,y-10,'Inclusions & Exclusions - what this proposal covers, and what it does not.',9.6,false,MUTED);y-=24;
    const GREEN='0.09 0.52 0.29',RED='0.72 0.14 0.09',gap=18,cw=(CW-gap)/2,LS=9.6,LH=12.6;
    const tick=(x,yy)=>o(`${GREEN} RG 1.4 w 1 J 1 j ${x} ${yy+3.6} m ${x+2.8} ${yy+0.8} l ${x+7.4} ${yy+6.6} l S`);
    const cross=(x,yy)=>o(`${RED} RG 1.3 w 1 J ${x+0.6} ${yy+0.6} m ${x+6.4} ${yy+6.4} l ${x+0.6} ${yy+6.4} m ${x+6.4} ${yy+0.6} l S`);
    const colHeads=()=>{
      rect(MX,y-20,cw,20,'0.9 0.96 0.92');rect(MX+cw+gap,y-20,cw,20,'0.99 0.92 0.91');
      txt(MX+10,y-13.5,'INCLUDED',8.6,true,GREEN);txt(MX+cw+gap+10,y-13.5,'NOT INCLUDED',8.6,true,RED);y-=26;
    };
    scoped.forEach((it,k)=>{
      need(30+20+LH*2+10);
      if(k)y-=8;
      round(MX,y-24,CW,24,5,TINT);rect(MX,y-24,3,24,AC);
      txt(MX+12,y-16,fit(it.title,11,true,CW-24),11,true);y-=30;
      colHeads();
      const L=it.inc.map(t=>wrap(t,LS,false,cw-26)),R=it.exc.map(t=>wrap(t,LS,false,cw-26));
      if(!L.length)L.push(null);if(!R.length)R.push(null);
      for(let i=0;i<Math.max(L.length,R.length);i++){
        const a=L[i],b=R[i],h=Math.max(a?a.length:b&&i===0?1:0,b?b.length:a&&i===0?1:0,1)*LH+4;
        if(y-h<BOTTOM){newPage();txt(MX,y-11,fit(`${it.title} (continued)`,10,true,CW),10,true);y-=20;colHeads();}
        if(a){tick(MX+10,y-LH+2.6);a.forEach((l,j)=>txt(MX+24,y-LH+3-j*LH,l,LS,false,BODY));}
        else if(i===0)txt(MX+10,y-LH+3,'Nothing listed',LS,false,MUTED);
        if(b){cross(MX+cw+gap+10,y-LH+2.6);b.forEach((l,j)=>txt(MX+cw+gap+24,y-LH+3-j*LH,l,LS,false,BODY));}
        else if(i===0)txt(MX+cw+gap+10,y-LH+3,'Nothing listed',LS,false,MUTED);
        y-=h;
      }
      hline(MX,W-MX,y-2,RULE,0.5);y-=6;
    });
    need(30);y-=8;
    para('Anything not listed as included is outside the scope of this proposal unless agreed in writing.',8.8,MUTED,4);
  }

  if(p.benefits.length){section(`Why ${biz||'Us'}`);bullets(p.benefits);}
  if(p.next_steps.length){section('Next Steps');bullets(p.next_steps);}
  if(p.terms.length){section('Terms & Conditions');bullets(p.terms);}
  if(p.closing){need(36);y-=10;para(p.closing,10.3,INK);}

  // ── Acceptance ──
  section('Acceptance',90);
  para('To accept this proposal, please sign below and share a copy with us, or simply confirm by replying to us on WhatsApp.',9.4,MUTED,4);
  {
    need(70);y-=40;const bw=(CW-40)/2;
    [[MX,`For ${biz||'the company'}`,'Authorised Signatory'],[MX+bw+40,`Accepted by ${cust.name||cust.company||'the customer'}`,'Signature, Name & Date']].forEach(([x,a,b])=>{
      hline(x,x+bw,y,'0.55 0.58 0.62',0.7);
      txt(x,y-13,fit(a,9.4,true,bw),9.4,true);txt(x,y-25,b,8.6,false,MUTED);
    });
    y-=34;
  }
  pages.push(ops);

  const total=pages.length;
  const foot1=fit([biz,addrLines.join(', ')].filter(Boolean).join('  |  '),8,true,CW-80);
  const foot2=fit(contactBits.join('  |  '),8,false,CW-80);
  pages.forEach((pg,i)=>{
    pg.push(`${AC} rg 0 0 ${W} 4 re f`);
    pg.push(`${RULE} RG 0.6 w ${MX} 50 m ${W-MX} 50 l S`);
    if(foot1)pg.push(`BT 0.35 0.38 0.43 rg /F2 8 Tf ${MX} 37 Td (${esc(foot1)}) Tj ET`);
    if(foot2)pg.push(`BT 0.45 0.48 0.53 rg /F1 8 Tf ${MX} 26 Td (${esc(foot2)}) Tj ET`);
    const label=`Page ${i+1} of ${total}`;
    pg.push(`BT 0.42 0.45 0.5 rg /F1 8 Tf ${(W-MX-textWidth(label,8)).toFixed(1)} 37 Td (${label}) Tj ET`);
  });

  const enc=new TextEncoder();
  const parts=[];let pos=0;const offs=[];
  const put=x=>{const b=typeof x==='string'?enc.encode(x):x;parts.push(b);pos+=b.length;};
  const objs=[];const reserve=()=>{objs.push(null);return objs.length;};
  const cat=reserve(),pagesObj=reserve(),f1=reserve(),f2=reserve();
  const imgObjs=pics.map(img=>{const id=reserve();const sm=img.smask?reserve():0;return {img,id,sm};});
  const pageObjs=pages.map(()=>({page:reserve(),content:reserve()}));
  objs[cat-1]='<</Type /Catalog /Pages 2 0 R>>';
  objs[pagesObj-1]=`<</Type /Pages /Kids [${pageObjs.map(x=>`${x.page} 0 R`).join(' ')}] /Count ${total}>>`;
  objs[f1-1]='<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding>>';
  objs[f2-1]='<</Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding>>';
  imgObjs.forEach(({img,id,sm})=>{
    objs[id-1]={dict:`<</Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /${img.cs} /BitsPerComponent 8 /Filter /${img.filter}${img.decode?' /Decode [1 0 1 0 1 0 1 0]':''}${sm?` /SMask ${sm} 0 R`:''} /Length ${img.data.length}>>`,data:img.data};
    if(sm)objs[sm-1]={dict:`<</Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${img.smask.length}>>`,data:img.smask};
  });
  const xobjs=imgObjs.map((x,i)=>`/Im${i+1} ${x.id} 0 R`).join(' ');
  const res=`<</Font <</F1 ${f1} 0 R /F2 ${f2} 0 R>>${xobjs?` /XObject <<${xobjs}>>`:''}>>`;
  pages.forEach((pg,i)=>{
    const content=enc.encode(pg.join('\n'));
    objs[pageObjs[i].page-1]=`<</Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${pageObjs[i].content} 0 R /Resources ${res}>>`;
    objs[pageObjs[i].content-1]={dict:`<</Length ${content.length}>>`,data:content};
  });
  put('%PDF-1.4\n');
  objs.forEach((ob,i)=>{
    offs[i+1]=pos;
    if(typeof ob==='string')put(`${i+1} 0 obj\n${ob}\nendobj\n`);
    else{put(`${i+1} 0 obj\n${ob.dict}\nstream\n`);put(ob.data);put('\nendstream\nendobj\n');}
  });
  const xref=pos;
  put(`xref\n0 ${objs.length+1}\n0000000000 65535 f \n`);
  for(let n=1;n<=objs.length;n++)put(`${String(offs[n]).padStart(10,'0')} 00000 n \n`);
  put(`trailer\n<</Size ${objs.length+1} /Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`);
  const out=new Uint8Array(pos);let at=0;for(const b of parts){out.set(b,at);at+=b.length;}
  return out;
}

/* ── Proposal outside the 24-hour window: approved template + PDF link ───────────────────────── */
// WhatsApp only delivers an approved template once the customer's 24-hour window has closed, so a
// proposal sent then goes as this template with a link to the PDF (worker /p/<token>). Created in
// the account's own WhatsApp Business Account the first time an agent opens AI Proposal.
// Meta rules: example values for every {{n}}, and the body can't start or end with a variable.
export const PC_PROPOSAL_TEMPLATE={
  name:'leadvyne_proposal_link',category:'UTILITY',language:'en',
  body:'Hi {{1}}, please find attached our proposal "{{2}}". You can view and download the PDF here: {{3}}\n\nPlease reply to this message if you have any questions.',
  example:['Asha','Solar Hot Water Solution','https://leadvyne-api-proxy.leadvyne.workers.dev/p/Xk29fLq8vN3mR7tY'],
};
// Template parameter text: no line breaks or tabs, no runs of 4+ spaces, never empty.
const pcTplParam=(v,max,fallback)=>String(v??'').replace(/[\r\n\t]+/g,' ').replace(/ {4,}/g,'   ').trim().slice(0,max)||fallback;
export function pcProposalTemplateParams({customer='',title='',link=''}={}){
  return [pcTplParam(String(customer).split(/\s+/)[0],60,'there'),pcTplParam(title,120,'Business Proposal'),pcTplParam(link,500,'')];
}
// The template's text with its values filled in — what the chat shows for the sent message.
export function pcProposalTemplateText(params){
  return PC_PROPOSAL_TEMPLATE.body.replace(/\{\{(\d)\}\}/g,(m,n)=>params[Number(n)-1]??m);
}
// Private link token for a proposal's PDF: 22 characters, ~131 bits.
export function pcShareToken(rand=n=>crypto.getRandomValues(new Uint8Array(n))){
  const A='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from(rand(22),b=>A[b%A.length]).join('');
}
// Link-preview crawlers (WhatsApp, Facebook, Telegram, Slack…) fetch the link when it's sent —
// those aren't the customer opening it.
export const pcIsPreviewBot=ua=>/WhatsApp|facebookexternalhit|facebookcatalog|Facebot|TelegramBot|Slackbot|Twitterbot|LinkedInBot|Discordbot|SkypeUriPreview|bot\b|crawler|spider/i.test(String(ua||''));
