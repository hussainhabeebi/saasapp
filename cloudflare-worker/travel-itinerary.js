// Travel Agency packages as a customer-facing itinerary: the WhatsApp text an agent would type by
// hand (header, price, day-by-day plan, includes/excludes, notes) and the same content as a PDF the
// bot can attach on a "📄 PDF Itinerary" tap. Pure functions only — worker.js does the NocoDB reads
// and the Chatwoot sends. Day-by-day plans come from the agency's own Itineraries (ta_itineraries);
// nothing here ever invents a day the agency did not write.

export const TA_PKG_PREFIX='TPKG:';
export const TA_PKG_PDF_PREFIX='TPKGPDF:';
export const TA_PKG_ENQUIRE_PREFIX='TPKGENQ:';

const ITEM_ICON={flight:'✈️',hotel:'🏨',activity:'🎯',transfer:'🚌',meal:'🍽️',note:'📝'};
const ITEM_LABEL={flight:'Flight',hotel:'Hotel',activity:'Activity',transfer:'Transfer',meal:'Meal',note:'Note'};
// Words that name the kind of listing rather than which one, so "hyderabad train" finds
// "HYDERABAD TRAIN PACKAGE" and "hyderabad package" alone matches none of three Hyderabad packages.
const GENERIC=new Set(['package','packages','pkg','tour','tours','trip','trips','holiday','holidays','the','a','an','of','for','and','with']);

export function taList(v){
  if(Array.isArray(v))return v.map(x=>String(x).trim()).filter(Boolean);
  if(v==null||v==='')return [];
  try{const a=JSON.parse(v);if(Array.isArray(a))return a.map(x=>String(x).trim()).filter(Boolean);}catch(e){}
  return String(v).split(/\n|;/).map(x=>x.trim()).filter(Boolean);
}
function days(v){
  let d=v;
  if(typeof d==='string'){try{d=JSON.parse(d);}catch(e){d=[];}}
  return (Array.isArray(d)?d:[]).map((x,i)=>({day_no:Number(x?.day_no)||i+1,title:String(x?.title||'').trim(),
    items:(Array.isArray(x?.items)?x.items:[]).map(it=>({type:ITEM_ICON[it?.type]?it.type:'note',description:String(it?.description||'').trim()})).filter(it=>it.description)}))
    .filter(x=>x.title||x.items.length);
}
const norm=s=>String(s||'').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const words=s=>norm(s).split(' ').filter(Boolean);

// Same price the dashboard's package card shows: sell_price, else base_price.
export function taPackagePrice(p){
  const s=Number(p?.sell_price),b=Number(p?.base_price);
  return s>0?s:b>0?b:0;
}
export function taMoney(n,cur){
  const v=Number(n);
  return v>0?`${String(cur||'').trim()||'AED'} ${v.toLocaleString('en-US',{maximumFractionDigits:2})}`:'';
}

// The itinerary built for this package: Itineraries created from a package (🗺️ on its card) take
// the package name as their title, so an exact name match wins, then one name containing the other.
export function taMatchItinerary(pkg,itineraries){
  const name=norm(pkg?.name);
  if(!name)return null;
  const withDays=(itineraries||[]).filter(it=>days(it?.days).length);
  return withDays.find(it=>norm(it.title)===name)
    ||(name.length>=6?withDays.find(it=>{const t=norm(it.title);return t.length>=6&&(t.includes(name)||name.includes(t));}):null)
    ||null;
}

// The one package a message names, or null when it names none or can't be told apart.
export function taFindPackageInText(packages,text){
  const have=new Set(words(text));
  if(!have.size)return null;
  let best=null,bestScore=0,tie=false;
  for(const p of packages||[]){
    const all=words(p?.name);
    if(!all.length)continue;
    const key=all.filter(w=>!GENERIC.has(w));
    const need=key.length?key:all;
    if(!need.every(w=>have.has(w)))continue;
    const score=need.length;
    if(score>bestScore){best=p;bestScore=score;tie=false;}
    else if(score===bestScore)tie=true;
  }
  return tie?null:best;
}

// "details" / "itinerary" / "send pdf" style follow-ups that refer back to the package the bot
// just described. 'pdf' when the PDF itself is asked for.
export function taPackageFollowUp(text){
  const t=norm(text);
  if(!t||t.split(' ').length>6)return null;
  if(/\bpdf\b/.test(t))return 'pdf';
  if(/\b(itinerary|itenary|itinerery|details?|day wise|daywise|schedule|plan|full info|more info|inclusions?)\b/.test(t))return 'details';
  return null;
}

function nightsLine(n){
  const v=Number(n)||0;
  return v>0?`${v} night${v===1?'':'s'} / ${v+1} days`:'';
}
function paxLine(p){
  const min=Number(p?.pax_min)||0,max=Number(p?.pax_max)||0;
  if(min>1&&max&&max<99)return `${min}–${max} travellers`;
  if(min>1)return `Minimum ${min} travellers`;
  if(max&&max<99)return `Up to ${max} travellers`;
  return '';
}
function dateLine(it){
  const f=String(it?.from_date||'').slice(0,10),t=String(it?.to_date||'').slice(0,10);
  return f&&t?`${f} to ${t}`:f||'';
}

// The WhatsApp message: what an agent would type out by hand for this package.
export function taPackageItineraryText(pkg,itin){
  const price=taMoney(taPackagePrice(pkg),pkg?.currency);
  const plan=days(itin?.days);
  const inc=taList(pkg?.inclusions),exc=taList(pkg?.exclusions);
  const notes=String(pkg?.notes||'').trim(),itinNotes=String(itin?.notes||'').trim();
  const out=[`🏝️ *${String(pkg?.name||'Package').trim()}*`];
  const meta=[pkg?.destination?`📍 ${String(pkg.destination).trim()}`:'',nightsLine(pkg?.nights)?`🌙 ${nightsLine(pkg.nights)}`:''].filter(Boolean).join('  ·  ');
  if(meta)out.push(meta);
  if(dateLine(itin))out.push(`📅 ${dateLine(itin)}`);
  if(paxLine(pkg))out.push(`👥 ${paxLine(pkg)}`);
  if(price)out.push(`💰 *${price}* per person`);
  if(plan.length){
    out.push('','🗓️ *Day-wise itinerary*');
    plan.forEach(d=>{
      out.push('',`*Day ${d.day_no}${d.title?` – ${d.title}`:''}*`);
      d.items.forEach(it=>out.push(`${ITEM_ICON[it.type]} ${it.description}`));
    });
  }
  if(inc.length)out.push('','✅ *Includes*',...inc.map(x=>`• ${x}`));
  if(exc.length)out.push('','❌ *Excludes*',...exc.map(x=>`• ${x}`));
  const extra=[notes,itinNotes&&itinNotes!==notes&&!/^includes:/i.test(itinNotes)?itinNotes:''].filter(Boolean).join('\n\n');
  if(extra)out.push('',`📝 ${extra.slice(0,600)}`);
  if(price)out.push('','_Price is per person and subject to availability at the time of booking._');
  return out.join('\n');
}

/* ── PDF ─────────────────────────────────────────────────────────────────────────────────────── */

// Helvetica advance widths (1/1000 em) for ASCII 32–126; bold is close enough at ×1.07 for wrapping.
const HW=[278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const textWidth=(s,size,bold)=>{let w=0;for(const ch of s){const c=ch.charCodeAt(0);w+=c>=32&&c<=126?HW[c-32]:556;}return w*size/1000*(bold?1.07:1);};
// Standard Type1 fonts only carry WinAnsi glyphs: keep Latin-1, map common punctuation, drop the rest (emoji, ₹ …).
const pdfSafe=s=>String(s||'').replace(/₹/g,'INR ').replace(/[★☆]/g,'*').replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/[–—]/g,'-').replace(/…/g,'...').replace(/•/g,'-')
  .normalize('NFC').replace(/[^\x20-\x7E\xA0-\xFF\n]/g,'').replace(/[ \t]+/g,' ');
const esc=s=>s.replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)').replace(/[\xA0-\xFF]/g,ch=>'\\'+ch.charCodeAt(0).toString(8).padStart(3,'0'));
function wrap(text,size,bold,width){
  const lines=[];
  for(const para of pdfSafe(text).split('\n')){
    let line='';
    for(const word of para.split(' ').filter(Boolean)){
      let w=word;
      while(textWidth(w,size,bold)>width){ // a single word wider than the line: hard-break it
        let cut=w.length;while(cut>1&&textWidth(w.slice(0,cut),size,bold)>width)cut--;
        if(line){lines.push(line);line='';}
        lines.push(w.slice(0,cut));w=w.slice(cut);
      }
      const next=line?`${line} ${w}`:w;
      if(textWidth(next,size,bold)>width){lines.push(line);line=w;}else line=next;
    }
    lines.push(line);
  }
  return lines;
}

// A4 itinerary PDF (Uint8Array) — agency header band, package summary, day-by-day plan, includes /
// excludes, notes, and a footer with the agency contact and page numbers on every page.
export function taBuildItineraryPdf(pkg,itin,{agencyName='',agencyPhone='',accent=[0.07,0.45,0.47]}={}){
  const W=595,H=842,MX=48,CW=W-MX*2,TOP=H-128,BOTTOM=70;
  const pages=[];let ops=[],y=TOP;
  const [ar,ag,ab]=accent.map(v=>Math.max(0,Math.min(1,Number(v)||0)).toFixed(3));
  const o=s=>ops.push(s);
  const txt=(x,yy,s,size,bold,rgb='0.12 0.14 0.18')=>o(`BT ${rgb} rg /${bold?'F2':'F1'} ${size} Tf ${x.toFixed(1)} ${yy.toFixed(1)} Td (${esc(s)}) Tj ET`);
  const rect=(x,yy,w,h,rgb)=>o(`${rgb} rg ${x} ${yy} ${w} ${h} re f`);
  const header=first=>{
    rect(0,H-(first?96:44),W,first?96:44,`${ar} ${ag} ${ab}`);
    const name=pdfSafe(agencyName).trim()||'Travel Itinerary';
    if(first){
      txt(MX,H-46,name.slice(0,60),20,true,'1 1 1');
      txt(MX,H-70,'TRAVEL ITINERARY',10,true,'0.85 0.95 0.95');
    }else txt(MX,H-28,`${name.slice(0,50)} - ${pdfSafe(pkg?.name).slice(0,50)}`,10,true,'1 1 1');
  };
  const newPage=()=>{pages.push(ops);ops=[];header(false);y=H-80;};
  const need=h=>{if(y-h<BOTTOM)newPage();};
  const para=(s,{size=10.5,bold=false,indent=0,gap=4,rgb}={})=>{
    for(const line of wrap(s,size,bold,CW-indent)){need(size+gap);txt(MX+indent,y-size,line,size,bold,rgb);y-=size+gap;}
  };
  const section=title=>{
    need(46);y-=14;
    rect(MX,y-16,3,16,`${ar} ${ag} ${ab}`);
    txt(MX+10,y-13,pdfSafe(title),12.5,true,`${ar} ${ag} ${ab}`);y-=26;
  };
  header(true);
  para(String(pkg?.name||'Package').trim(),{size:20,bold:true,gap:6});
  y-=4;
  const facts=[
    ['Destination',String(pkg?.destination||'').trim()],
    ['Duration',nightsLine(pkg?.nights)],
    ['Travel dates',dateLine(itin)],
    ['Travellers',paxLine(pkg)],
    ['Price',taMoney(taPackagePrice(pkg),pkg?.currency)?`${taMoney(taPackagePrice(pkg),pkg?.currency)} per person`:''],
  ].filter(f=>f[1]);
  if(facts.length){
    const boxH=facts.length*18+16;need(boxH+8);
    rect(MX,y-boxH,CW,boxH,'0.95 0.97 0.97');
    let fy=y-22;
    facts.forEach(([k,v])=>{txt(MX+14,fy,k,10,false,'0.42 0.45 0.5');txt(MX+120,fy,pdfSafe(v).slice(0,70),10.5,true);fy-=18;});
    y-=boxH+6;
  }
  const plan=days(itin?.days);
  if(plan.length){
    section('Day-by-day plan');
    plan.forEach(d=>{
      need(40);
      y-=4;
      para(`Day ${d.day_no}${d.title?` - ${d.title}`:''}`,{size:11.5,bold:true,gap:5});
      d.items.forEach(it=>para(`${ITEM_LABEL[it.type]}: ${it.description}`,{indent:14}));
      y-=4;
    });
  }
  const inc=taList(pkg?.inclusions),exc=taList(pkg?.exclusions);
  if(inc.length){section('Inclusions');inc.forEach(x=>para(`+  ${x}`,{indent:6}));}
  if(exc.length){section('Exclusions');exc.forEach(x=>para(`-  ${x}`,{indent:6}));}
  const notes=[String(pkg?.notes||'').trim(),String(itin?.notes||'').trim()].filter((n,i,a)=>n&&a.indexOf(n)===i&&!/^includes:/i.test(n));
  if(notes.length){section('Notes');notes.forEach(n=>para(n));}
  y-=10;
  para('Prices are per person and subject to availability at the time of booking.',{size:9,rgb:'0.42 0.45 0.5'});
  pages.push(ops);

  const total=pages.length;
  const contact=[pdfSafe(agencyName).trim(),pdfSafe(agencyPhone).trim()].filter(Boolean).join('  |  ');
  pages.forEach((p,i)=>{
    p.push(`0.85 0.87 0.9 RG 0.6 w ${MX} 52 m ${W-MX} 52 l S`);
    if(contact)p.push(`BT 0.42 0.45 0.5 rg /F1 8.5 Tf ${MX} 38 Td (${esc(contact.slice(0,90))}) Tj ET`);
    const label=`Page ${i+1} of ${total}`;
    p.push(`BT 0.42 0.45 0.5 rg /F1 8.5 Tf ${(W-MX-textWidth(label,8.5)).toFixed(1)} 38 Td (${label}) Tj ET`);
  });

  // Objects: 1 catalog, 2 pages, 3 F1, 4 F2, then a page + content stream pair per page.
  const objs=[];
  const kids=pages.map((_,i)=>`${5+i*2} 0 R`).join(' ');
  objs[1]='<</Type /Catalog /Pages 2 0 R>>';
  objs[2]=`<</Type /Pages /Kids [${kids}] /Count ${total}>>`;
  objs[3]='<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding>>';
  objs[4]='<</Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding>>';
  pages.forEach((p,i)=>{
    const content=p.join('\n');
    objs[5+i*2]=`<</Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${6+i*2} 0 R /Resources <</Font <</F1 3 0 R /F2 4 0 R>>>>>>`;
    objs[6+i*2]=`<</Length ${content.length}>>\nstream\n${content}\nendstream`;
  });
  // Every byte is ASCII (non-ASCII text is octal-escaped above), so string length = byte length.
  let out='%PDF-1.4\n';const offs=[];
  for(let n=1;n<objs.length;n++){offs[n]=out.length;out+=`${n} 0 obj\n${objs[n]}\nendobj\n`;}
  const xref=out.length;
  out+=`xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for(let n=1;n<objs.length;n++)out+=`${String(offs[n]).padStart(10,'0')} 00000 n \n`;
  out+=`trailer\n<</Size ${objs.length} /Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

export function taItineraryPdfName(pkg){
  return `Itinerary-${String(pkg?.name||'package').replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'').slice(0,60)||'package'}.pdf`;
}
