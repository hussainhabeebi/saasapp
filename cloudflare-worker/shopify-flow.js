// ── Shopify-style guided shopping chat (Ecom communication style "shopify") ─────────────────────
// Button-led WhatsApp flow for Shopify / general stores:
//   menu (categories + 📦 Track my order) → category (photos + product picker) → product (photo,
//   price, sizes in stock) → size → checkout link (Shopify cart permalink for the exact variant).
// Order tracking answers from the customer's own orders, matched on their WhatsApp number.
// A free-text question at any step is answered by the normal AI reply first; the flow's prompt for
// the step the customer was on follows as a second message (worker.js engineShopifyFlowResume).
//
// Pure helpers only — worker.js does the sending and NocoDB reads (engineShopifyFlowTurn).
// Button values (`SHOP_<ACTION>[:arg]`) come back as the customer's message on a tap.

export const SHOP_FLOW_STAGES=['shop_menu','shop_category','shop_product','shop_track'];

const norm=v=>String(v||'').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();

export function shopFlowParse(text){
  const m=String(text||'').trim().match(/^SHOP_(MENU|TRACK|CAT|PROD|SIZE|MORE)(?::([\s\S]*))?$/i);
  return m?{action:m[1].toUpperCase(), arg:(m[2]||'').trim()}:null;
}

export function shopFlowIsGreeting(text){
  return /^(?:hi+|hello+|hey+|hai+|hii+|hlo|helo|hy|yo|namaste|namaskaram|menu|main menu|start shopping|shop|good\s+(?:morning|afternoon|evening|night))[!.,? ]*$/i.test(String(text||'').trim());
}

// "Where is my order", "track", "order status", "my order ethi?" … — not "I want to order".
export function shopFlowIsTrackRequest(text){
  const t=String(text||'').toLowerCase();
  // A bare "track" isn't enough — "Track pants" is a product.
  return /\b(?:track (?:my |the )?(?:order|parcel|package|shipment|delivery)|tracking (?:id|number|link|details|status)|where(?:'s| is)? my (?:order|parcel|package)|order status|status of my order|my order (?:status|details)|(?:order|parcel) (?:evide|ethi|kittiyilla|not received|not delivered)|delivery status|when will (?:my order|i get my))\b/.test(t);
}

// "#1001", "order 1001", "1001" (3–10 digits) → "#1001"
export function shopFlowOrderNumber(text){
  const m=String(text||'').trim().match(/^(?:order\s*(?:no\.?|number|#)?\s*)?#?\s*(\d{3,10})$/i);
  return m?`#${m[1]}`:'';
}

// "I want this", "buy", "order it", "add to cart" … while looking at a product.
export function shopFlowIsPurchaseIntent(text){
  return /\b(?:buy|order (?:it|this|now|cheyyam|cheyyanam)|i(?:'ll| will)? take (?:it|this|one)|want (?:this|it|one|to buy|to order)|add to cart|checkout|place (?:an |the )?order|venam|veenam|chahiye)\b/i.test(String(text||''));
}

export const shopFlowInStock=p=>Number(p?.stock)>0;
// NocoDB row id — products read from the D1 copy (ecom_products_mirror) carry it as nocodb_id.
export const shopFlowProductId=p=>String(p?.Id??p?.nocodb_id??p?.id??'');

export function shopFlowMoney(amount, currency){
  const n=Number(amount);
  if(!Number.isFinite(n)||n<=0) return '';
  const v=n%1?n.toFixed(2):n.toLocaleString('en-IN');
  return (!currency||currency==='INR')?`₹${v}`:`${currency} ${v}`;
}

// In-stock categories, most products first.
export function shopFlowCategories(products){
  const counts=new Map();
  (products||[]).filter(shopFlowInStock).forEach(p=>{
    const name=String(p.category||'').trim();
    if(name) counts.set(name, (counts.get(name)||0)+1);
  });
  return [...counts.entries()].sort((a, b)=>b[1]-a[1]||a[0].localeCompare(b[0])).map(([name, count])=>({name, count}));
}

export function shopFlowMenuItems(products){
  const cats=shopFlowCategories(products);
  const items=cats.slice(0, 9).map(cat=>({title:cat.name, value:`SHOP_CAT:${cat.name}`}));
  if(!items.length && (products||[]).some(shopFlowInStock)) items.push({title:'🛍️ Browse products', value:'SHOP_CAT:*'});
  items.push({title:'📦 Track my order', value:'SHOP_TRACK'});
  return items;
}

export function shopFlowFindCategory(products, text){
  const t=norm(text);
  if(!t) return '';
  return shopFlowCategories(products).find(cat=>norm(cat.name)===t)?.name||'';
}

// In-stock products of one category ('*' = all), up to 10 (WhatsApp list limit).
export function shopFlowCategoryProducts(products, category){
  const want=norm(category);
  return (products||[]).filter(shopFlowInStock)
    .filter(p=>category==='*'||norm(p.category)===want)
    .slice(0, 10);
}

export function shopFlowFindProduct(products, text){
  const t=norm(text);
  if(!t) return null;
  return (products||[]).find(p=>norm(p.name)===t)||null;
}

// Shopify handle from a synced product's order link (https://{shop}/products/{handle}).
export function shopFlowProductHandle(product){
  const m=String(product?.shopify_product_url||'').match(/\/products\/([^/?#]+)/);
  return m?decodeURIComponent(m[1]):'';
}

// Size/variant options. Shopify variants (shopify_inventory rows) carry per-size stock; a product
// without them falls back to its Size field (comma-separated), assumed available.
export function shopFlowSizeOptions(product, variantRows){
  const rows=(variantRows||[]).filter(r=>r.shopify_variant_id);
  if(rows.length){
    return rows.map(r=>({
      title:String(r.variant_title||'').trim()||'Standard', variantId:String(r.shopify_variant_id),
      price:Number(r.price)||Number(product?.price)||0,
      inStock:r.tracked==='No'||Number(r.available)>0,
    }));
  }
  const sizes=String(product?.size||'').split(/\s*,\s*/).map(s=>s.trim()).filter(Boolean);
  return sizes.map(s=>({title:s, variantId:'', price:Number(product?.price)||0, inStock:true}));
}

export function shopFlowMatchOption(options, text){
  const raw=String(text||'').trim();
  const parsed=shopFlowParse(raw);
  if(parsed?.action==='SIZE') return options.find(o=>o.variantId===parsed.arg||o.title===parsed.arg)||null;
  const t=norm(raw.replace(/^size\s*/i, ''));
  return t?options.find(o=>norm(o.title)===t)||null:null;
}

// Shopify cart permalink: opens checkout with this exact variant already in the cart.
export function shopFlowCartLink(shop, variantId, qty=1){
  return shop&&variantId?`https://${shop}/cart/${variantId}:${Math.max(1, qty|0)}`:'';
}

export function shopFlowProductCaption(product, options){
  const lines=[`*${product?.name||''}*${shopFlowMoney(product?.price, product?.currency)?` — ${shopFlowMoney(product.price, product.currency)}`:''}`];
  const desc=String(product?.description||'').replace(/\s+/g, ' ').trim();
  if(desc) lines.push(desc.length>280?`${desc.slice(0, 277).replace(/\s+\S*$/, '')}…`:desc);
  const inStock=(options||[]).filter(o=>o.inStock&&o.title!=='Standard'&&o.title!=='Default Title');
  if(inStock.length) lines.push(`Sizes in stock: ${inStock.map(o=>o.title).join(' · ')}`);
  return lines.join('\n\n');
}

const last10=p=>String(p||'').replace(/\D/g, '').slice(-10);
export const shopFlowPhoneMatches=(a, b)=>{ const x=last10(a), y=last10(b); return x.length===10&&x===y; };
export const shopFlowPhoneKey=last10;

// One order as a WhatsApp message — a shopify_orders row (Shopify connected) or an Ecom Orders row.
export function shopFlowOrderSummary(o){
  if(o?.shopify_order_id!==undefined && o?.fulfillment_status!==undefined){
    let fulfillments=[]; try{ fulfillments=JSON.parse(o.fulfillments_json||'[]'); }catch(e){}
    if(!Array.isArray(fulfillments)) fulfillments=[];
    const status=o.cancelled_at?'❌ Cancelled'
      :fulfillments.length&&fulfillments.every(f=>f.shipment_status==='delivered')?'📦 Delivered'
      :fulfillments.length||['fulfilled','partial'].includes(o.fulfillment_status)?'🚚 Shipped'
      :o.financial_status==='paid'?'✅ Confirmed — getting it ready'
      :'🕒 Received';
    let items=[]; try{ items=JSON.parse(o.line_items_json||'[]'); }catch(e){}
    const what=Array.isArray(items)&&items.length?items.map(li=>`${li.quantity}x ${li.title}${li.variant_title?` (${li.variant_title})`:''}`).join(', '):'';
    const lines=[`*Order ${o.name||''}*${shopFlowMoney(o.total, o.currency)?` · ${shopFlowMoney(o.total, o.currency)}`:''}`];
    if(what) lines.push(what);
    lines.push(`Status: ${status}`);
    const track=fulfillments.find(f=>f.number||f.url);
    if(track) lines.push(`Tracking: ${[track.company, track.number].filter(Boolean).join(' ')}${track.url?`\n${track.url}`:''}`);
    if(o.order_status_url&&!o.cancelled_at) lines.push(`Order details: ${o.order_status_url}`);
    return lines.join('\n');
  }
  const status=String(o?.status||'received');
  const icon={cancelled:'❌', delivered:'📦', shipped:'🚚', processing:'✅', received:'🕒', pending:'🕒'}[status.toLowerCase()]||'•';
  const lines=[`*Order ${String(o?.order_id||o?.Id||'').trim()}*${shopFlowMoney(o?.total, o?.currency)?` · ${shopFlowMoney(o.total, o.currency)}`:''}`];
  if(o?.items) lines.push(String(o.items));
  lines.push(`Status: ${icon} ${status.charAt(0).toUpperCase()+status.slice(1)}`);
  return lines.join('\n');
}

// Newest first, only this customer's own (phone match), up to `max`.
export function shopFlowCustomerOrders(rows, phone, max=3){
  return (rows||[]).filter(o=>shopFlowPhoneMatches(o.customer_phone, phone))
    .sort((a, b)=>String(b.created_at||b.order_date||'').localeCompare(String(a.created_at||a.order_date||'')))
    .slice(0, max);
}
