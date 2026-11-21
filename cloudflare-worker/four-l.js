// 4L — Ecom communication style (bot_config.ecom_communication_style === 'four_l').
//
// Built for 4L Fashion. It is the full Baby Care style (button-led shopping, fabric tiers,
// customisation, chat orders, order assignment, summary follow-ups…) plus a strict bot / team split:
//
//   1. The bot sends the greeting.
//   2. The bot answers only product questions — size, colour, price, stock, fabric, photos, a
//      product or category by name, and the shopping/order flow itself.
//   3. Anything else goes to the team: one short "our team will reply" note, the chat is handed
//      over (Handover='Yes') and the bot stays quiet on those messages from then on.
//   4. Product questions asked in between — while the customer waits for the team — are still
//      answered by the bot, so nobody waits for a size or colour.
//   5. As soon as a person replies (Chatwoot, the Chats page, the WhatsApp Business app) the chat
//      is taken over (HandoverBy set) and the bot goes fully silent until "Hand back to bot".
//      engineDeliverReply re-checks this right before sending, so the bot and a person never
//      answer the same message.
//
// Settings (bot_config): four_l_handoff_text (the team note), four_l_product_keywords (extra
// words, comma separated, that count as product questions).
// Pure helpers only — worker.js wires them into the turn.

export const FOUR_L_STYLE='four_l';

function cfg(c){
  if(!c) return {};
  if(c.bot_config && typeof c.bot_config==='object') return c.bot_config;
  try{ return JSON.parse(c.bot_config||'{}')||{}; }catch(e){ return {}; }
}
export function fourLIsStyle(c){ return cfg(c).ecom_communication_style===FOUR_L_STYLE; }
// 4L runs everything Baby Care runs.
export function ecomStyleIsBabyCare(style){ return style==='baby_care' || style===FOUR_L_STYLE; }

// Product words — English, Manglish and Malayalam. Word-boundary matched on a lowercased text.
const PRODUCT_WORDS=[
  'size','sizes','sizing','fit','fits','fitting','measurement','measurements','length','width','chest','waist','inch','inches','cm',
  'xs','xl','xxl','xxxl','2xl','3xl','4xl','small','medium','large','free size',
  'colour','colours','color','colors','shade','shades','kalar','niram',
  'price','prices','rate','rates','cost','costs','mrp','how much','vila','vilai','amount','offer','discount','combo',
  'stock','available','availability','in stock','out of stock','have this','do you have','undo','undoo','kittumo','kittum',
  'fabric','material','cloth','cotton','linen','silk','rayon','polyester','jersey','interlock','quality','wash','washable',
  'design','designs','pattern','print','printed','model','models','style','styles','variant','variants','collection','new arrival','new arrivals',
  'photo','photos','pic','pics','picture','pictures','image','images','video','catalogue','catalog','show me','details','detail','specification','specs',
  'months','month','yrs','newborn','baby','kids','boy','girl','sets','baby set',
  'dress','dresses','shirt','shirts','tshirt','t-shirt','top','tops','kurti','kurtis','saree','sarees','frock','frocks','pant','pants','jeans','churidar','gown','gowns','lehenga','skirt','shorts','nightwear','innerwear',
  'order','buy','purchase','book','cart','checkout','cod',
  'സൈസ്','നിറം','കളർ','വില','സ്റ്റോക്ക്','ഫോട്ടോ','ഡിസൈൻ','മെറ്റീരിയൽ',
];
function escapeRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
function wordRe(words){
  const latin=words.filter(w=>/^[\x00-\x7f]+$/.test(w)).map(escapeRe);
  const other=words.filter(w=>!/^[\x00-\x7f]+$/.test(w)).map(escapeRe);
  const parts=[];
  if(latin.length) parts.push(`(?:^|[^a-z0-9])(?:${latin.join('|')})(?=$|[^a-z0-9])`);
  if(other.length) parts.push(`(?:${other.join('|')})`);
  return new RegExp(parts.join('|'), 'i');
}
const PRODUCT_RE=wordRe(PRODUCT_WORDS);
// Bare sizes in the text ("38", "size 40", "2-3 yrs") also count.
const SIZE_NUMBER_RE=/(?:^|\s)(?:2[0-9]|3[0-9]|4[0-9]|5[0-2])(?:\s|$)|\b\d{1,2}\s*-\s*\d{1,2}\s*(?:m|y|yr|yrs|months?|years?)\b/i;
const GREETING_RE=/^(?:hi+|hii+|hello+|helo|hey+|hai+|hlo|good\s+(?:morning|afternoon|evening|night|noon)|gm|namaskaram|namaste|salam|assalamu\s*alaikum|നമസ്കാരം|ഹായ്|ഹലോ)[\s!.,?😊🙏👋]*$/i;
export function fourLIsGreeting(text){ return GREETING_RE.test(String(text||'').trim()); }
const ACK_RE=/^(?:ok+|okay|k+|kk|fine|sure|yes|yeah|yep|no|nope|thanks?|thank\s*you|thx|ty|great|good|nice|super|done|👍|🙏|😊|❤️|♥️)[\s!.,😊🙏👍]*$/i;
export function fourLIsAck(text){ return ACK_RE.test(String(text||'').trim()); }
// Tapped buttons and list rows the shopping flows send (BABY_*, FASHION_*, SHOP flow, FLOW_ANSWER:…).
const BUTTON_RE=/^(?:(?:BABY|FASHION|ELEC|SHOP|ECOM|PROD|CAT|ORDER)_[A-Z0-9_:\-]+|FLOW_ANSWER:.+)$/i;

function norm(s){ return String(s||'').toLowerCase().replace(/[^a-z0-9ഀ-ൿ]+/g,' ').trim(); }
// A product / category / SKU named in the message (whole-word, 4+ letter names only).
export function fourLMentionsCatalogue(text, {products=[], categories=[]}={}){
  const t=` ${norm(text)} `;
  if(t.trim().length<3) return false;
  const names=[];
  for(const p of products||[]){ if(p?.name) names.push(p.name); if(p?.sku) names.push(p.sku); if(p?.category) names.push(p.category); }
  for(const cat of categories||[]) names.push(typeof cat==='string'?cat:(cat?.name||''));
  return names.some(n=>{ const x=norm(n); return x.length>=4 && t.includes(` ${x} `); });
}

// Clearly a team matter even when a product word is in it ("refund for the blue dress").
const TEAM_RE=/(?:^|[^a-z])(?:refund|return|returns|exchange|replace|replacement|complaint|complain|damaged|damage|defect|defective|wrong (?:item|product|size|colour|color)|missing|track|tracking|where is my order|order status|not (?:received|delivered)|delay|delayed|late|cancel|cancellation|payment (?:failed|issue|problem)|paid|transaction|invoice|bill|gst|wholesale|bulk|franchise|reseller|job|vacancy|career|manager|owner|call me|phone number|contact number|talk to|speak to|human|agent|staff|person)(?=$|[^a-z])/i;
export function fourLIsTeamMatter(text){ return TEAM_RE.test(String(text||'')); }

export function fourLIsProductQuery(text, {products=[], categories=[], extraKeywords=[]}={}){
  const t=String(text||'').trim();
  if(!t) return false;
  if(BUTTON_RE.test(t)) return true;
  if(fourLIsTeamMatter(t)) return false;
  if(PRODUCT_RE.test(t) || SIZE_NUMBER_RE.test(t)) return true;
  const extra=(extraKeywords||[]).map(w=>String(w||'').trim().toLowerCase()).filter(Boolean);
  if(extra.length && wordRe(extra).test(t)) return true;
  return fourLMentionsCatalogue(t, {products, categories});
}
export function fourLExtraKeywords(c){
  const raw=cfg(c).four_l_product_keywords;
  const list=Array.isArray(raw)?raw:String(raw||'').split(/[,\n]/);
  return list.map(w=>String(w||'').trim()).filter(Boolean).slice(0,200);
}

// Waiting for the team: the bot (or a person) already handed this chat over.
export function fourLWithTeam(lead, stage){
  return !!lead && (lead.Handover==='Yes' || stage==='human_handover' || lead.Stage==='human_handover');
}
// A shopping / order step is in progress — names, addresses, quantities typed into it are part of
// the flow, not "other questions".
export function fourLInShoppingStep(stage){
  return /^(?:baby_|order_collect_|fashion_order_|shop_)/.test(String(stage||''));
}

// What the bot does with this message:
//   'bot'    — answer it (greeting, product question, flow step, opt-out / restart words)
//   'handoff'— not a product question: send the team note once and hand the chat over
//   'queue'  — not a product question and the team already has the chat: stay silent
export function fourLDecide({text='', mediaType='text', stage='', lead=null, isNewLead=false, isOptOut=false, products=[], categories=[], extraKeywords=[]}={}){
  if(isOptOut) return 'bot';
  const withTeam=fourLWithTeam(lead, stage);
  const t=String(text||'').trim();
  // A photo from the customer is usually "do you have this?" — the product matcher handles it.
  if(mediaType==='image' && !withTeam) return 'bot';
  if(mediaType!=='text' && mediaType!=='image' && mediaType!=='audio') return withTeam?'queue':'handoff';
  if(!t) return withTeam?'queue':'bot';
  if(/^(?:stop|start|unsubscribe)$/i.test(t)) return 'bot';
  if(fourLIsGreeting(t)) return withTeam?'queue':'bot';
  if(!BUTTON_RE.test(t) && fourLIsTeamMatter(t)) return withTeam?'queue':'handoff';
  if(!withTeam && fourLInShoppingStep(stage)) return 'bot';
  if(fourLIsProductQuery(t, {products, categories, extraKeywords})) return 'bot';
  if(fourLIsAck(t)) return withTeam?'queue':(isNewLead?'bot':'queue');
  return withTeam?'queue':'handoff';
}

export const FOUR_L_DEFAULT_HANDOFF='Thank you for your message 🙏 Our team will reply to you here shortly. Meanwhile, feel free to ask me about any product — size, colour, price or availability.';
export function fourLHandoffText(c, {isNewLead=false, name='', business=''}={}){
  const custom=String(cfg(c).four_l_handoff_text||'').trim();
  const body=custom||FOUR_L_DEFAULT_HANDOFF;
  if(!isNewLead) return body;
  const who=String(name||'').trim().split(/\s+/)[0]||'';
  const biz=String(business||'').trim();
  return `Hi${who?' '+who:''} 👋 Welcome${biz?' to '+biz:''}!\n\n${body}`;
}

// The person who took the chat over, for HandoverBy.
export function fourLAgentLabel(body){
  const s=body?.sender||{};
  return String(s.email||s.available_name||s.name||'Team').trim().slice(0,120)||'Team';
}
