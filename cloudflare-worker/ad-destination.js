// Destination from an ad or poster (travel agencies).
//
// A customer who taps a destination poster or ad — a Click-to-WhatsApp ad ("Goa 3N/4D from
// ₹9,999"), a poster's wa.me link with a pre-filled message ("Hi, I want the Bali package"), or a
// Facebook / Instagram lead form ("Dubai Summer Form") — arrives already knowing where they want
// to go. The new lead's Destination is set from it, so:
//   • Leads → 📍 Destination and the 📌 Status Board's destination chips list it under that place;
//   • the teammate who handles that destination (Lead Routing → 📍 Destination Staff Routing, or
//     Lead Routing's product rules) becomes its Owner (worker.js engineAssignLeadOwner).
//
// Which places count: the agency's own (destinations in Destination Staff Routing, Lead Routing
// products, the guided-flow destination list), then a built-in list of popular holiday
// destinations. Whole words only, so "Goa" never matches "Goal".
//
// Pure decisions only (no I/O) so they can be unit-tested; worker.js reads and writes the lead.

import {dsrNorm} from './dest-staff-routing.js';

// Popular holiday destinations for Indian / Gulf travel agencies. Origin cities customers usually
// fly from (Kochi, Mumbai, Delhi…) are left out on purpose: "Goa package from Kochi" is Goa.
export const AD_DEST_BUILTIN=[
  'Goa','Bali','Dubai','Abu Dhabi','Manali','Shimla','Kashmir','Srinagar','Gulmarg','Pahalgam','Ladakh','Leh',
  'Kerala','Munnar','Alleppey','Wayanad','Thekkady','Varkala','Ooty','Kodaikanal','Coorg','Mysore','Andaman',
  'Rajasthan','Jaipur','Udaipur','Jaisalmer','Darjeeling','Sikkim','Gangtok','Meghalaya','Shillong','Rishikesh',
  'Mussoorie','Nainital','Kedarnath','Char Dham','Varanasi','Agra','Lakshadweep','Hampi','Pondicherry',
  'Maldives','Thailand','Phuket','Krabi','Pattaya','Bangkok','Singapore','Malaysia','Kuala Lumpur','Langkawi',
  'Vietnam','Sri Lanka','Nepal','Bhutan','Oman','Qatar','Turkey','Istanbul','Cappadocia','Egypt','Georgia',
  'Azerbaijan','Baku','Armenia','Kazakhstan','Almaty','Uzbekistan','Europe','Switzerland','Paris','London',
  'Japan','Mauritius','Seychelles','Australia','New Zealand','Hong Kong','Cambodia','Philippines','Kenya',
];

const str=v=>String(v??'').trim();
// A place is at least 3 letters once normalised ("Leh" yes, "Go" no).
const placeKey=p=>{ const k=dsrNorm(p); return k.replace(/ /g,'').length>=3?k:''; };

// The agency's own destination names, from its settings. Wildcards ("*") and flight routes are
// left out — a route ("Kochi - Dubai") is not one place.
export function adDestinationOwnPlaces(c, {dsrRules={}, routingRules={}, flowDestinations=[]}={}){
  const out=[];
  for(const r of Object.values(dsrRules||{})) out.push(...(r?.packages||[]), ...(r?.resorts||[]));
  for(const r of Object.values(routingRules||{})) out.push(...(Array.isArray(r?.products)?r.products:[]));
  for(const d of flowDestinations||[]) out.push(typeof d==='string'?d:d?.name);
  return out.map(str).filter(p=>p && p!=='*' && p.length<=60);
}

// [{label, key}], the agency's own places first, then the built-in list; one entry per place.
export function adDestinationCatalog(own=[], {builtin=true}={}){
  const seen=new Set(), out=[];
  for(const label of [...own, ...(builtin?AD_DEST_BUILTIN:[])]){
    const key=placeKey(label);
    if(!key || seen.has(key)) continue;
    seen.add(key); out.push({label:str(label), key});
  }
  return out;
}

// Every catalog place found in one text, in the order they appear: [{label, key, at}]. A longer
// place wins over a shorter one inside it ("Abu Dhabi" over "Dhabi", "Kuala Lumpur" once).
export function adDestinationMatches(text, catalog){
  const hay=` ${dsrNorm(text)} `;
  if(hay.trim().length<3) return [];
  const hits=[];
  for(const p of catalog||[]){
    const at=hay.indexOf(` ${p.key} `);
    if(at>=0) hits.push({...p, at, end:at+p.key.length});
  }
  hits.sort((a,b)=>a.at-b.at || (b.end-b.at)-(a.end-a.at));
  const out=[];
  for(const h of hits) if(!out.some(o=>h.at<o.end && h.end>o.at)) out.push(h);
  return out;
}

// The destination a lead came in for, or ''.
//   adTexts   what the ad / poster / form says — headline, body, ad / campaign / form name, link —
//             most telling first. The first place named in the first text that names one wins.
//   firstText the customer's first message (a poster's pre-filled text). Used only when the ad says
//             nothing, and only when it names exactly one place — "I'm in Dubai, want Kerala" is
//             not a clear choice.
export function adDestinationDetect({adTexts=[], firstText=''}={}, catalog=[]){
  for(const t of adTexts){
    const m=adDestinationMatches(t, catalog);
    if(m.length) return m[0].label;
  }
  const m=adDestinationMatches(firstText, catalog);
  const distinct=[...new Set(m.map(x=>x.key))];
  return distinct.length===1?m[0].label:'';
}

// The ad texts Meta / Chatwoot pass on with a Click-to-WhatsApp referral.
export function adDestinationReferralTexts(ref){
  if(!ref || typeof ref!=='object') return [];
  let url=str(ref.source_url);
  // A link's path and query carry the campaign ("…/goa-honeymoon-offer?utm_campaign=bali"); the
  // host ("fb.me", "instagram.com") never names a place.
  try{ const u=new URL(url); url=decodeURIComponent(`${u.pathname} ${u.search}`); }catch(e){}
  return [ref.headline, ref.body, url].map(str).filter(Boolean);
}
