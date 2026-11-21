// ── Reply Quality fixes (Settings → Bot Behavior → 🛠️ Reply Quality) ─────────────────────────────
// From the Couplo bot fix plan (Nov 2026): the bot repeated its opener as a fallback, replied twice,
// switched language on "ok"/"sorry", claimed it "can only reply in English", said it can't send
// photos, guessed shop facts, and kept selling to a customer who asked it to stop messaging.
//
// Every fix here is a separate bot_config toggle, OFF unless the account switches it on, so an
// existing account's bot behaves exactly as before until someone opts in. The module is pure (no
// worker.js imports) so each rule is unit-tested on its own; worker.js does the wiring.
//
// bot_config keys:
//   rq_burst_wait        wait ~9 s after a customer message so a burst gets ONE reply (default 5 s)
//   rq_dedupe            drop a reply whose text matches a bot message sent in the last 60 s
//   rq_opener_gate       the opener/welcome goes out at most once per 24 h; never as a fallback
//   rq_opener_signatures lines of text that identify the opener (e.g. "Premium baby set ₹899")
//   rq_known_state       "Known so far" block (age, product, language, stage, occasion) + no-restart rules
//   rq_language_rule     reply in the customer's language; "ok"/"K"/"sorry" keep the current one;
//                        "Tamil" / "in Malayalam" switches; Manglish → Malayalam; never "only English"
//   rq_fact_sheet        shop facts block; anything not in it → rq_unknown_reply + tag for the team
//   rq_fact_sheet_text   the confirmed facts (free text)
//   rq_unknown_reply     what the bot says when a fact is missing (blank = default per language)
//   rq_media_aware       tell the AI it CAN send photos (the system sends them) — never "I can't"
//   rq_photo_first       Malayalam / Manglish photo asks ("photo ayakkamo", "ഫോട്ടോ") send photos
//   rq_soft_optout       "don't message me" in any language → opt out, short apology, no follow-ups

export const RQ_BURST_WAIT_MS=9000;
export const RQ_DEDUPE_WINDOW_MS=60*1000;
export const RQ_OPENER_WINDOW_MS=24*60*60*1000;

const RQ_BOOL_KEYS=['rq_burst_wait','rq_dedupe','rq_opener_gate','rq_known_state','rq_language_rule','rq_fact_sheet','rq_media_aware','rq_photo_first','rq_soft_optout'];
export const RQ_TOGGLES=RQ_BOOL_KEYS;

function parseObj(raw){
  if(raw && typeof raw==='object') return raw;
  try{ const o=JSON.parse(raw||'{}'); return o&&typeof o==='object'?o:{}; }catch(e){ return {}; }
}

// Reads the toggles off a client row (or a bot_config object/string).
export function rqConfig(cOrBotConfig){
  const bc=parseObj(cOrBotConfig&&Object.prototype.hasOwnProperty.call(cOrBotConfig,'bot_config')?cOrBotConfig.bot_config:cOrBotConfig);
  const out={};
  for(const k of RQ_BOOL_KEYS) out[k.slice(3)]=bc[k]===true;
  out.opener_signatures=String(bc.rq_opener_signatures||'').split('\n').map(s=>s.trim()).filter(s=>s.length>=6).slice(0,10);
  out.fact_sheet_text=String(bc.rq_fact_sheet_text||'').trim().slice(0,6000);
  out.unknown_reply=String(bc.rq_unknown_reply||'').trim().slice(0,300);
  out.any=RQ_BOOL_KEYS.some(k=>bc[k]===true);
  return out;
}

// ── Text helpers ─────────────────────────────────────────────────────────────────────────────────
export function rqNormText(t){
  return String(t||'').normalize('NFC').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu,' ').trim();
}
const SCRIPTS=[['ml',/[ഀ-ൿ]/],['ta',/[஀-௿]/],['te',/[ఀ-౿]/],['kn',/[ಀ-೿]/],['bn',/[ঀ-৿]/],
  ['gu',/[઀-૿]/],['pa',/[਀-੿]/],['or',/[଀-୿]/],['hi',/[ऀ-ॿ]/],['ar',/[؀-ۿ]/]];
export function rqScriptLang(text){
  const t=String(text||'');
  for(const [code, re] of SCRIPTS) if(re.test(t)) return code;
  return /[A-Za-z]/.test(t)?'en':null;
}

// ── Language rule ────────────────────────────────────────────────────────────────────────────────
const LANG_WORDS={
  ml:['malayalam','malayalm','malyalam','മലയാളം','മലയാളത്തിൽ'], ta:['tamil','thamil','தமிழ்','தமிழில்'], en:['english','eng','ഇംഗ്ലീഷ്'],
  hi:['hindi','हिंदी','हिन्दी'], te:['telugu','తెలుగు'], kn:['kannada','ಕನ್ನಡ'], ar:['arabic','عربي'],
};
const LANG_WORD_TO_CODE=new Map(Object.entries(LANG_WORDS).flatMap(([code, ws])=>ws.map(w=>[w, code])));
// "Tamil", "in Malayalam", "reply in tamil please", "can you speak hindi?", "malayalathil parayamo"
export function rqExplicitLanguageRequest(text){
  const t=rqNormText(text);
  if(!t || t.split(' ').length>7) return null;
  const words=t.split(' ');
  const hits=words.map(w=>LANG_WORD_TO_CODE.get(w)||(/^malayala(?:th|tt)il$/.test(w)?'ml':null)).filter(Boolean);
  if(hits.length!==1) return null;
  const rest=words.filter(w=>!LANG_WORD_TO_CODE.has(w) && !/^malayala(?:th|tt)il$/.test(w));
  const filler=/^(in|reply|replay|speak|talk|type|write|answer|message|msg|chat|send|please|pls|plz|can|could|you|u|me|only|language|lang|il|il|parayu|parayamo|paranju|tharamo|venam|do|it|ok|okay|sir|madam|mam|bro|the|to)$/;
  return rest.every(w=>filler.test(w))?hits[0]:null;
}
// Malayalam written in English letters (Manglish). One clear marker is enough.
const MANGLISH_RE=/\b(?:ndo|undo|undu|und|venam|venda|vende|ethra|etra|aano|ano|aanu|alle|ille|illa|illey|enthu|entha|enth|ningal|ningalude|kittumo|kittum|kitumo|cheyyumo|cheyyamo|cheyyo|ayakkamo|ayakko|ayakku|ayakkanda|ayakkenda|kanikkamo|kanikko|kaanan|kanan|mathi|sheri|shari|evide|eppo|eppozha|onnu|pinne|kunju|kunjinu|kuttikku|vila|paisa|kodukkamo|tharamo|parayamo|manassilayilla|manasilayilla|mone|mole|chechi|chetta|ikka|itha|ithu|athu|aayi|aayo|kollam|nokkatte)\b/i;
export function rqIsManglish(text){ return MANGLISH_RE.test(String(text||'')); }
// Short acknowledgements that carry no language signal of their own.
const FILLER_RE=/^(?:ok+|okay+|okk+|k+|kk+|sorry|sry|hmm+|hm+|mm+|yes|yeah|ya+|yup|no|nope|thanks?|thank you|thx|ty|tq|fine|good|nice|super|done|sure|alright|haa+|ha+|oh+|ohk+|accha|seri|sheri|\?+|\.+)$/i;
export function rqIsFiller(text){
  const raw=String(text||'').trim();
  if(!raw) return true;
  if(!/[\p{L}\p{N}]/u.test(raw)) return true; // emoji / punctuation only
  return FILLER_RE.test(rqNormText(raw));
}
// The language for this reply. history: [{role, content}] oldest→newest, without the current message.
export function rqDecideLanguage({text, history=[], detected=null, fallback='en'}={}){
  const explicit=rqExplicitLanguageRequest(text);
  if(explicit) return {lang:explicit, reason:'asked'};
  const script=rqScriptLang(text);
  if(script && script!=='en') return {lang:script, reason:'script'};
  if(script==='en' && rqIsManglish(text)) return {lang:'ml', reason:'manglish'};
  const msgs=(history||[]).filter(m=>m && typeof m.content==='string');
  const lastBot=[...msgs].reverse().find(m=>m.role==='assistant');
  const prevLang=lastBot?rqScriptLang(lastBot.content):null;
  if(rqIsFiller(text) && prevLang) return {lang:prevLang, reason:'kept'};
  // A language the customer asked for earlier sticks for short English-letter messages ("price?").
  const asked=[...msgs].filter(m=>m.role==='user').slice(-6).reverse().map(m=>rqExplicitLanguageRequest(m.content)).find(Boolean);
  if(asked && script==='en' && rqNormText(text).split(' ').length<=4) return {lang:asked, reason:'asked_earlier'};
  if(script==='en') return {lang:'en', reason:'script'};
  return {lang:detected||prevLang||fallback, reason:'fallback'};
}
const LANG_NAMES={en:'English', ml:'Malayalam', ta:'Tamil', hi:'Hindi', te:'Telugu', kn:'Kannada', bn:'Bengali', gu:'Gujarati', pa:'Punjabi', or:'Odia', ar:'Arabic', ur:'Urdu', mr:'Marathi'};
export function rqLangName(code){ return LANG_NAMES[code]||'English'; }

// ── Soft opt-out ("don't keep messaging me") ─────────────────────────────────────────────────────
// Needs a messaging word next to a stop/no-need word, so "no need blue, send pink" never matches.
const OPTOUT_RES=[
  /\b(?:do\s*n[o']?t|dont|pls\s+dont|please\s+dont|stop|no\s+need\s+to|never)\s+(?:keep\s+)?(?:message|messaging|msg|msging|texting|text|sending\s+(?:me\s+)?(?:messages?|msgs?)|send(?:ing)?\s+(?:me\s+)?(?:any\s+)?(?:more\s+)?(?:messages?|msgs?)|ping(?:ing)?|disturb(?:ing)?|spamm?(?:ing)?)(?:\s+me)?\b/i,
  /\b(?:stop|no\s+more)\s+(?:the\s+)?(?:messages?|msgs?|follow\s*-?\s*ups?|reminders?)\b/i,
  /\b(?:message|msg|msgs|messages?)\s+(?:ayakkanda|ayakkenda|ayakanda|ayakenda|ayakkandaa|ayakkaruthu|ayakkalle|venda|vendaa)\b/i,
  /\b(?:ayakkanda|ayakkenda|ayakkaruthu)\b/i,
  /(?:മെസ്സേജ്|മെസേജ്|msg|message)[^\n]{0,30}?(?:അയക്കേണ്ട|അയക്കണ്ട|അയക്കരുത്|അയക്കല്ലേ|വേണ്ട|അയക്കേണ്ടതില്ല|അയക്കേണ്ട\s*ആവശ്യമില്ല)/i,
  /(?:അയക്കേണ്ട|അയക്കരുത്)\s*(?:ആവശ്യമില്ല)?/,
  /(?:ശല്യം\s*ചെയ്യ(?:രുത്|ല്ലേ|ണ്ട))/,
];
export function rqIsSoftOptOut(text){
  const t=String(text||'');
  if(!t.trim() || t.length>600) return false;
  return OPTOUT_RES.some(re=>re.test(t));
}
export function rqOptOutReply(lang){
  if(lang==='ml') return 'ക്ഷമിക്കണം 🙏 ഇനി ഞങ്ങൾ മെസ്സേജ് അയക്കില്ല. എപ്പോൾ വേണമെങ്കിലും ഇവിടെ മെസ്സേജ് ചെയ്താൽ മതി 😊';
  if(lang==='ta') return 'மன்னிக்கவும் 🙏 இனி நாங்கள் மெசேஜ் அனுப்ப மாட்டோம். தேவைப்படும்போது இங்கே மெசேஜ் செய்யுங்கள் 😊';
  if(lang==='hi') return 'माफ़ कीजिए 🙏 अब हम आपको मैसेज नहीं भेजेंगे। जब भी ज़रूरत हो, यहाँ मैसेज कर दीजिए 😊';
  return 'Sorry for the trouble 🙏 We won\'t message you again. Whenever you need us, just send a message here 😊';
}

// ── Photo asks in Malayalam / Manglish ───────────────────────────────────────────────────────────
// ecomIsPhotoRequest (worker.js) already covers English. These are the asks it missed
// ("T-shirt photos ayakkamo?", "ഫോട്ടോ അയക്കാമോ", "design kaanikku").
const PHOTO_ML_RE=/(?:ഫോട്ടോ|ഫോട്ടോസ്|ചിത്രം|ചിത്രങ്ങൾ|പിക്ചർ|പടം|ഡിസൈൻ|ഡിസൈനുകൾ|മോഡൽ|കാണിക്കാമോ|കാണിക്കൂ|അയക്കാമോ|കാണാം|കാണണം|കാണട്ടെ)/;
const PHOTO_MANGLISH_RE=/\b(?:(?:photos?|pics?|pictures?|images?|designs?|models?|padam|fotos?)\s+(?:ayakko|ayakkamo|ayakkamoo|ayakku|ayakkuo|ayakkumo|ayachu\s+tharamo|tharamo|kanikko|kanikkamo|kanikku|kaanikku|kaanikkamo|venam|venamayirunnu|kaanan|kanan|undo|ndo)|(?:kanikko|kanikkamo|kaanikku|kaanikkamo)\b|pic\s+venam|photo\s+venam|design\s+kaanikku)\b/i;
const PHOTO_BUTTON_RE=/view\s+our\s+catalog|സെറ്റുകൾ\s*കാണാം|designs?\s*കാണണം|ഡിസൈൻസ്?\s*കാണാം/i;
export function rqIsPhotoAsk(text){
  const t=String(text||'');
  if(!t.trim() || t.length>300) return false;
  return PHOTO_BUTTON_RE.test(t)||PHOTO_MANGLISH_RE.test(t)||(PHOTO_ML_RE.test(t)&&/(?:ഫോട്ടോ|ചിത്ര|പിക്ചർ|പടം|ഡിസൈൻ|മോഡൽ|സെറ്റ്|കാണ|അയക്ക)/.test(t));
}
// An English phrasing of the ask that the existing photo planner understands, keeping any product
// or category words the customer used ("T-shirt photos ayakkamo" → "send T-shirt photos").
export function rqPhotoAskAsEnglish(text){
  const keep=String(text||'').replace(/\b(?:ayakko|ayakkamo|ayakkamoo|ayakku|ayakkuo|ayakkumo|ayachu|tharamo|kanikko|kanikkamo|kanikku|kaanikku|kaanikkamo|venam|venamayirunnu|kaanan|kanan|undo|ndo|photos?|pics?|pictures?|images?|fotos?|padam|pls|plz|please)\b/gi,' ')
    .replace(/[ഀ-ൿ]+/g,' ').replace(/[^\p{L}\p{N}\s-]/gu,' ').replace(/\s+/g,' ').trim();
  return `send ${keep?keep+' ':''}photos`.replace(/\s+/g,' ');
}

// ── Known-so-far state ───────────────────────────────────────────────────────────────────────────
const AGE_RE=/\b(\d{1,2}(?:\.\d)?)\s*(?:-|to)?\s*(days?|weeks?|wks?|months?|month|mnths?|mths?|mon|m|years?|yrs?|year|y)\b(?:\s*old)?/i;
const AGE_ML_RE=/(\d{1,2})\s*(മാസം|മാസമായി|മാസ|വയസ്സ്|വയസ്|വയസ്സായി|ദിവസം)/;
export function rqExtractAge(text){
  const t=String(text||'');
  const ml=AGE_ML_RE.exec(t);
  if(ml){ const unit=/മാസ/.test(ml[2])?'months':/ദിവസ/.test(ml[2])?'days':'years'; return `${ml[1]} ${unit}`; }
  const m=AGE_RE.exec(t);
  if(!m) return null;
  const u=m[2].toLowerCase();
  const unit=/^d/.test(u)?'days':/^w/.test(u)?'weeks':/^(y|yr)/.test(u)?'years':'months';
  if(unit==='months' && Number(m[1])>36) return null;
  return `${m[1]} ${unit}`;
}
const OCCASIONS=[['naming ceremony',/naming|name\s*ceremony|noolukett|nool\s*kett|പേരിടൽ|നൂലുകെട്ട്/i],['cradle ceremony',/cradle|thottil|തൊട്ടിൽ/i],
  ['photoshoot',/photo\s*shoot|photoshoot|ഫോട്ടോഷൂട്ട്/i],['birthday',/birthday|b'?day|ബർത്ത്ഡേ|പിറന്നാൾ/i],['gift',/\bgift|ഗിഫ്റ്റ്|സമ്മാനം/i]];
export function rqExtractOccasion(text){ const t=String(text||''); const hit=OCCASIONS.find(([, re])=>re.test(t)); return hit?hit[0]:null; }

// Builds the state from the lead, the chat so far and the current message. Values are short strings.
export function rqKnownState({history=[], userText='', lead=null, babyProfile=null, lang='', stage=''}={}){
  const userMsgs=[...(history||[]).filter(m=>m?.role==='user').map(m=>String(m.content||'')), String(userText||'')];
  let age=null, occasion=null;
  for(const t of userMsgs){ age=rqExtractAge(t)||age; occasion=rqExtractOccasion(t)||occasion; }
  if(!age && babyProfile){
    if(babyProfile.ageLabel) age=String(babyProfile.ageLabel);
    else if(Number.isFinite(Number(babyProfile.ageMonths))) age=`${Number(babyProfile.ageMonths)} months`;
  }
  const product=String(lead?.InterestedProduct||lead?.['Last Product Name']||lead?.ProductInterest||'').trim().slice(0,80);
  const stageLabel=rqStageLabel(stage||lead?.Stage||'');
  return {baby_age:age||'', occasion:occasion||'', product_interest:product, language:rqLangName(lang||''), stage:stageLabel};
}
export function rqStageLabel(stage){
  const s=String(stage||'').toLowerCase();
  if(!s || s==='new') return 'browsing';
  if(/order|checkout|cart|address|payment/.test(s)) return 'ordering';
  if(/human|handover/.test(s)) return 'handed to team';
  if(/product|choos|select|interest|qualif|contacted/.test(s)) return 'choosing';
  return 'browsing';
}

// ── Prompt blocks ────────────────────────────────────────────────────────────────────────────────
export function rqDefaultUnknownReply(lang){
  if(lang==='ml') return 'ടീമിനോട് ചോദിച്ച് ഉടനെ പറയാം 😊';
  if(lang==='ta') return 'எங்கள் டீமிடம் கேட்டு உடனே சொல்கிறோம் 😊';
  if(lang==='hi') return 'मैं टीम से पूछकर अभी बताती हूँ 😊';
  return 'Let me check with our team and get back to you shortly 😊';
}
export function rqUnknownReply(cfg, lang){ return cfg?.unknown_reply||rqDefaultUnknownReply(lang); }

export function rqPromptBlock(cfg, {known=null, lang='en', babycare=false}={}){
  if(!cfg?.any) return '';
  const parts=[];
  if(cfg.known_state){
    const k=known||{};
    const fields=[['baby_age', k.baby_age], ['occasion', k.occasion], ['product_interest', k.product_interest], ['language', k.language], ['stage', k.stage]]
      .filter(([key])=>babycare || (key!=='baby_age' && key!=='occasion'))
      .map(([key, v])=>`${key}: ${v||'not known yet'}`).join(', ');
    parts.push(`KNOWN SO FAR: ${fields}

Rules:
- Never repeat the welcome message. It has already been sent.
${babycare?'- If baby_age is known, never ask for it again. Use it.\n':'- Never ask again for anything listed above as known. Use it.\n'}- Answer the customer's last message first, in one or two short sentences.
- If you do not understand, ask ONE short question about what they just said. Never restart the sales pitch.${babycare?'\n- Age guide: 0-6 months → baby sets. 6 months to 10 years → T-shirts and cord sets.':''}`);
  }
  if(cfg.language_rule){
    parts.push(`LANGUAGE: Reply in ${rqLangName(lang)}, the language of the customer's latest message${lang==='ml'?' (Malayalam script; product names may stay in English)':''}. You can write in English, Malayalam, Tamil, Hindi and other languages — never say you can only reply in one language. If the customer asks for a language, switch to it.`);
  }
  if(cfg.media_aware){
    parts.push('MEDIA: You CAN send photos. The system sends product and category photos for you. Never say you cannot send photos, pictures or images — if the customer wants photos, tell them they are on the way or ask which product or category they want to see.');
  }
  if(cfg.fact_sheet){
    const unknown=rqUnknownReply(cfg, lang);
    parts.push(`SHOP FACTS — use only these. If something is not here, say "${unknown}" and stop. Never guess.
${cfg.fact_sheet_text||'(No facts entered yet — for any price, colour, delivery, payment or policy question that is not in the product catalog, use the line above.)'}`);
  }
  return parts.length?'\n\n'+parts.join('\n\n'):'';
}
// True when the reply used the "I'll ask the team" line, so the chat can be tagged for staff.
export function rqUsedUnknownReply(cfg, lang, reply){
  if(!cfg?.fact_sheet) return false;
  const n=rqNormText(reply), u=rqNormText(rqUnknownReply(cfg, lang));
  return !!u && n.includes(u.slice(0, Math.min(u.length, 40)));
}

// ── Opener gate ──────────────────────────────────────────────────────────────────────────────────
// Is this outgoing text the opener? Matched against the configured signatures and the flow intro.
export function rqIsOpenerText(text, {signatures=[], introText=''}={}){
  const n=rqNormText(text);
  if(!n) return false;
  const sigs=[...signatures, introText].map(rqNormText).filter(s=>s.length>=6);
  return sigs.some(s=>{
    if(n.includes(s)) return true;
    // The flow intro itself: same first 60 characters counts as the opener.
    const head=s.slice(0, 60);
    return head.length>=24 && n.includes(head);
  });
}
export function rqBotRepliedWithin(history, nowMs=Date.now(), windowMs=RQ_OPENER_WINDOW_MS, lastBotAtMs=null){
  if(Number.isFinite(lastBotAtMs) && lastBotAtMs>0) return nowMs-lastBotAtMs<windowMs;
  const bot=[...(history||[])].reverse().find(m=>m?.role==='assistant');
  if(!bot) return false;
  const at=Date.parse(bot.ts||bot.at||bot.timestamp||'');
  return Number.isFinite(at) ? nowMs-at<windowMs : false;
}
export const RQ_FALLBACK_BUTTONS={
  en:['📸 Photos','💰 Prices','🙋 Talk to our team'],
  ml:['📸 Photos','💰 Price','🙋 Team-നോട് സംസാരിക്കാം'],
};
export function rqFallbackButtons(lang){ return RQ_FALLBACK_BUTTONS[lang]||RQ_FALLBACK_BUTTONS.en; }
export function rqFallbackReply(lang){
  if(lang==='ml') return 'ക്ഷമിക്കണം, ഒന്ന് കൂടി പറയാമോ? 😊 താഴെ നിന്ന് ഒന്ന് തിരഞ്ഞെടുക്കാം 👇';
  if(lang==='ta') return 'மன்னிக்கவும், கொஞ்சம் விளக்கமாகச் சொல்ல முடியுமா? 😊 கீழே ஒன்றைத் தேர்ந்தெடுக்கலாம் 👇';
  return 'Sorry, could you tell me a little more? 😊 Or pick one below 👇';
}
export function rqWelcomeBack(lang, name=''){
  const n=rqCleanName(name);
  if(lang==='ml') return `വീണ്ടും സ്വാഗതം${n?' '+n:''} 😊 എന്താണ് നോക്കുന്നത്?`;
  if(lang==='ta') return `மீண்டும் வருக${n?' '+n:''} 😊 என்ன பார்க்கிறீர்கள்?`;
  return `Welcome back${n?' '+n:''} 😊 What would you like to see?`;
}
const GREETING_RE=/^(?:hi+|hii+|hello+|helo|hey+|hai+|hlo|good\s+(?:morning|afternoon|evening|night)|gm|namaskaram|namaste|salam|assalamu\s*alaikum|നമസ്കാരം|ഹായ്|ഹലോ)[\s!.,?😊🙏👋]*$/i;
export function rqIsGreetingOnly(text){ return GREETING_RE.test(String(text||'').trim()); }

// A display name usable in a greeting: letters only, no emoji/digit noise ("Subi🥰N🥰7510…" → "Subi").
export function rqCleanName(name){
  const first=String(name||'').normalize('NFC').split(/[^\p{L}\p{M}'.-]+/u).find(w=>/\p{L}/u.test(w)&&w.length>=2)||'';
  return first.length<=24?first.charAt(0).toUpperCase()+first.slice(1):'';
}

// ── 60-second duplicate drop ─────────────────────────────────────────────────────────────────────
export function rqIsRecentDuplicate(text, recent=[], nowMs=Date.now(), windowMs=RQ_DEDUPE_WINDOW_MS){
  const n=rqNormText(text);
  if(!n) return false;
  return (recent||[]).some(r=>r && rqNormText(r.text)===n && nowMs-Number(r.at||0)<windowMs);
}
