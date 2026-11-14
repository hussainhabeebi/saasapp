// Products & Services catalogue for General-industry accounts (products-services.html).
//
// The account lists what it sells — products and services, with full details, a price, photos,
// an optional voice note and brochure, all as Google Drive share links. Two things read it:
//  - the bot: when a customer names an item in chat, its details card, photos, voice note and
//    brochure go into the chat (once per lead per item per day), and the AI's answers are
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
  if(has('keywords')) out.keywords=line(b.keywords,500);
  if(has('price')){
    if(String(b.price??'').trim()!==''&&pcPrice(b.price)===null) return {error:'Price must be a number'};
    out.price=pcPrice(b.price);
  }
  if(has('currency')) out.currency=pcCurrency(b.currency);
  if(has('price_unit')) out.price_unit=line(b.price_unit,40);
  for(const f of [...PC_IMAGE_FIELDS,'voice_note_url','brochure_url']){
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
  return out.join('\n').replace(/\n{3,}/g,'\n\n').trim();
}

// What the bot sends after the card, in order: photos, the voice note, then the brochure.
export function pcMediaPlan(item){
  const plan=pcPhotos(item).map((url,i)=>({url,kind:'image',caption:i===0?`📷 ${line(item?.name,120)}`:''}));
  if(isLink(item?.voice_note_url)) plan.push({url:line(item.voice_note_url,1000),kind:'voice',caption:''});
  if(isLink(item?.brochure_url)) plan.push({url:line(item.brochure_url,1000),kind:'document',caption:`📄 ${line(item?.name,120)} — brochure`});
  return plan;
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
    pcList(i.features).length?`  highlights: ${pcList(i.features).slice(0,10).join('; ')}`:'',i.details?`  details: ${line(i.details,1200)}`:'',
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
    description:said.get(String(i.id))||line(i.short_description,400)}));
  const summary=line(j.summary,1500);
  if(!summary) return {error:'The AI draft had no summary.'};
  return {title:line(j.title,120)||'Business Proposal',summary,items,
    benefits:pcStrList(j.benefits,6,200),next_steps:pcStrList(j.next_steps,5,200),terms:pcStrList(j.terms,6,240),
    closing:line(j.closing,500)};
}

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
      price_unit:line(it.price_unit,40),description:line(r?.description,400)};
  }).filter(Boolean).slice(0,PC_PROPOSAL_MAX_ITEMS);
  const list=v=>(Array.isArray(v)?v:pcList(v)).map(x=>line(x,240)).filter(Boolean).slice(0,8);
  const pct=v=>{const n=Number(v);return Number.isFinite(n)&&n>0?Math.min(100,Math.round(n*100)/100):0;};
  return {title:line(p?.title,120)||'Business Proposal',summary:str(p?.summary,2000),items:rows,
    benefits:list(p?.benefits),next_steps:list(p?.next_steps),terms:list(p?.terms),closing:str(p?.closing,600),
    discount_pct:pct(p?.discount_pct),tax_pct:pct(p?.tax_pct),tax_label:line(p?.tax_label,20)||'Tax',
    valid_days:Math.min(365,Math.max(0,Math.round(Number(p?.valid_days)||0)))};
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

// A4 proposal PDF (Uint8Array): header band with logo and business name, title and "prepared
// for", the summary, one card per item (photo, name, description, qty × price), the totals,
// why-us / next steps / terms, the closing, and a footer with the contact and page numbers.
// opts.images: Map(item id → prepared image from taPrepareImage); opts.logo: prepared image.
export function pcBuildProposalPdf(p,{business='',phone='',email='',customer='',accent='#0D9C93',logo=null,images=new Map(),now=new Date(),ref=''}={}){
  const {safe,esc,wrap,textWidth,hexRgb}=taPdf;
  const W=595,H=842,MX=44,CW=W-MX*2,BOTTOM=64;
  const AC=hexRgb(accent,[0.05,0.61,0.58]).map(v=>v.toFixed(3)).join(' ');
  const INK='0.13 0.15 0.19',MUTED='0.4 0.43 0.48';
  const biz=safe(business).trim();
  const pics=[];const imgName=img=>{if(!img)return null;let i=pics.indexOf(img);if(i<0){pics.push(img);i=pics.length-1;}return `Im${i+1}`;};
  const pages=[];let ops=[],y=0;
  const o=s=>ops.push(s);
  const txt=(x,yy,s,size,bold,rgb=INK)=>o(`BT ${rgb} rg /${bold?'F2':'F1'} ${size} Tf ${x.toFixed(1)} ${yy.toFixed(1)} Td (${esc(safe(s))}) Tj ET`);
  const rect=(x,yy,w,h,rgb)=>o(`${rgb} rg ${x.toFixed(1)} ${yy.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re f`);
  const round=(x,yy,w,h,r,rgb)=>{const k=0.5523*r;o(`${rgb} rg ${x+r} ${yy} m ${x+w-r} ${yy} l ${x+w-r+k} ${yy} ${x+w} ${yy+r-k} ${x+w} ${yy+r} c ${x+w} ${yy+h-r} l ${x+w} ${yy+h-r+k} ${x+w-r+k} ${yy+h} ${x+w-r} ${yy+h} c ${x+r} ${yy+h} l ${x+r-k} ${yy+h} ${x} ${yy+h-r+k} ${x} ${yy+h-r} c ${x} ${yy+r} l ${x} ${yy+r-k} ${x+r-k} ${yy} ${x+r} ${yy} c h f`);};
  const image=(img,x,yy,w,h,fit=false)=>{
    const n=imgName(img);if(!n)return;
    const s=fit?Math.min(w/img.w,h/img.h):Math.max(w/img.w,h/img.h),dw=img.w*s,dh=img.h*s;
    o(`q ${x.toFixed(1)} ${yy.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re W n ${dw.toFixed(2)} 0 0 ${dh.toFixed(2)} ${(x+(w-dw)/2).toFixed(2)} ${(yy+(h-dh)/2).toFixed(2)} cm /${n} Do Q`);
  };
  const right=(xr,yy,s,size,bold,rgb)=>txt(xr-textWidth(safe(s),size,bold),yy,s,size,bold,rgb);
  const header=first=>{
    const hh=first?84:46;
    rect(0,H-hh,W,hh,AC);
    let tx=MX;
    if(logo){
      const box=first?60:32,by=H-hh+(hh-box)/2;
      round(MX,by,box*1.6,box,6,'1 1 1');
      image(logo,MX+5,by+4,box*1.6-10,box-8,true);
      tx=MX+box*1.6+14;
    }
    if(first){
      txt(tx,H-38,(biz||'Proposal').slice(0,40),19,true,'1 1 1');
      const contact=[safe(phone).trim(),safe(email).trim()].filter(Boolean).join('  |  ');
      if(contact)txt(tx,H-56,contact.slice(0,70),10,false,'0.9 0.97 0.96');
      right(W-MX,H-38,'PROPOSAL',9,true,'0.9 0.97 0.96');
    }else txt(tx,H-28,`${biz?biz.slice(0,40)+'  |  ':''}${safe(p.title).slice(0,50)}`,10,true,'1 1 1');
    y=H-hh;
  };
  const newPage=()=>{pages.push(ops);ops=[];header(false);y-=22;};
  const need=h=>{if(y-h<BOTTOM)newPage();};
  const section=(title,follow=40)=>{need(48+follow);y-=18;rect(MX,y-18,4,18,AC);txt(MX+12,y-14,title,14,true,AC);y-=30;};
  const para=(text,size=10.5,rgb='0.25 0.28 0.32',gap=4.5)=>{for(const l of wrap(text,size,false,CW)){need(size+gap);txt(MX,y-size,l,size,false,rgb);y-=size+gap;}};
  const bullets=list=>list.forEach(item=>{
    const ls=wrap(item,10.2,false,CW-20);
    need(ls.length*13.5+4);
    o(`${AC} rg ${MX+7} ${y-6} m ${MX+9.2} ${y-6} ${MX+11} ${y-7.8} ${MX+11} ${y-10} c ${MX+11} ${y-12.2} ${MX+9.2} ${y-14} ${MX+7} ${y-14} c ${MX+4.8} ${y-14} ${MX+3} ${y-12.2} ${MX+3} ${y-10} c ${MX+3} ${y-7.8} ${MX+4.8} ${y-6} ${MX+7} ${y-6} c f`);
    ls.forEach(l=>{txt(MX+20,y-13,l,10.2,false,'0.2 0.23 0.27');y-=13.5;});
    y-=4;
  });

  // ── Cover ──
  header(true);
  y-=30;
  wrap(p.title||'Business Proposal',24,true,CW,3).forEach(l=>{txt(MX,y-24,l,24,true);y-=30;});
  const meta=[customer?`Prepared for ${customer}`:'',dateText(now),p.valid_days?`Valid until ${dateText(new Date(now.getTime()+p.valid_days*864e5))}`:'',ref?`Ref ${ref}`:''].filter(Boolean).join('   |   ');
  if(meta){txt(MX,y-11,meta.slice(0,110),11,false,MUTED);y-=22;}
  if(p.summary){section('Overview');para(p.summary);}

  // ── Items ──
  const totals=pcProposalTotals(p);
  if(p.items.length){
    section('Proposed Products & Services',110);
    p.items.forEach((r,idx)=>{
      const img=images.get(String(r.id))||null;
      const iw=img?104:0,tx=MX+14+(img?iw+14:0),tw=CW-28-(img?iw+14:0)-118;
      const head=wrap(r.name,12,true,tw,2),body=r.description?wrap(r.description,9.4,false,tw,5):[];
      const h=Math.max(img?96:0,18+head.length*15+body.length*12.4+8);
      need(h+10);
      round(MX,y-h,CW,h,8,idx%2?'0.975 0.98 0.985':'0.955 0.97 0.97');
      if(img)image(img,MX+10,y-h+(h-78)/2,iw,78);
      let ty=y-20;
      head.forEach(l=>{txt(tx,ty,l,12,true);ty-=15;});
      body.forEach(l=>{txt(tx,ty,l,9.4,false,'0.36 0.39 0.44');ty-=12.4;});
      const xr=MX+CW-14;
      if(r.unit_price!==null&&r.unit_price!==undefined){
        right(xr,y-20,pcMoney(r.unit_price*r.qty,r.currency),12,true,AC);
        right(xr,y-35,`${r.qty} x ${pcMoney(r.unit_price,r.currency)}${r.price_unit?` ${r.price_unit}`:''}`.slice(0,40),8.8,false,MUTED);
      }else{
        right(xr,y-20,'On request',11,true,AC);
        right(xr,y-35,`Qty ${r.qty}`,8.8,false,MUTED);
      }
      y-=h+8;
    });
    // ── Totals ──
    if(totals.priced){
      const rows=[['Subtotal',pcMoney(totals.subtotal,totals.currency)]];
      if(totals.discount)rows.push([`Discount (${p.discount_pct}%)`,`- ${pcMoney(totals.discount,totals.currency)}`]);
      if(totals.tax)rows.push([`${p.tax_label||'Tax'} (${p.tax_pct}%)`,pcMoney(totals.tax,totals.currency)]);
      const bw=250,bh=rows.length*18+40,bx=MX+CW-bw;
      need(bh+12);y-=4;
      round(bx,y-bh,bw,bh,8,'0.955 0.97 0.97');
      let ty=y-18;
      rows.forEach(([k,v])=>{txt(bx+14,ty,k,10,false,MUTED);right(bx+bw-14,ty,v,10,true);ty-=18;});
      o(`0.82 0.86 0.88 RG 0.6 w ${bx+14} ${ty+8} m ${bx+bw-14} ${ty+8} l S`);
      txt(bx+14,ty-8,'TOTAL',10.5,true,AC);right(bx+bw-14,ty-9,pcMoney(totals.total,totals.currency),15,true,AC);
      y-=bh+6;
      if(totals.unpriced){need(16);txt(MX,y-9,`${totals.unpriced} item${totals.unpriced>1?'s are':' is'} priced on request and not included in the total.`,8.5,false,MUTED);y-=16;}
    }
  }
  if(p.benefits.length){section(`Why ${biz||'Us'}`);bullets(p.benefits);}
  if(p.next_steps.length){section('Next Steps');bullets(p.next_steps);}
  if(p.terms.length){section('Terms & Conditions');bullets(p.terms);}
  if(p.closing){need(40);y-=12;para(p.closing,10.5,INK);}
  if(biz){need(36);y-=14;txt(MX,y-10,'Warm regards,',10,false,MUTED);y-=16;txt(MX,y-11,biz.slice(0,60),11.5,true);y-=16;}
  pages.push(ops);

  const total=pages.length;
  const contact=[biz,safe(phone).trim(),safe(email).trim()].filter(Boolean).join('   |   ');
  pages.forEach((pg,i)=>{
    pg.push(`${AC} rg 0 0 ${W} 4 re f`);
    pg.push(`0.86 0.88 0.9 RG 0.6 w ${MX} 44 m ${W-MX} 44 l S`);
    if(contact)pg.push(`BT 0.42 0.45 0.5 rg /F2 8.5 Tf ${MX} 28 Td (${esc(contact.slice(0,90))}) Tj ET`);
    const label=`Page ${i+1} of ${total}`;
    pg.push(`BT 0.42 0.45 0.5 rg /F1 8.5 Tf ${(W-MX-textWidth(label,8.5)).toFixed(1)} 28 Td (${label}) Tj ET`);
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
