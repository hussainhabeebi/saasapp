// Follow-up V3 Pro add-ons (followup-pro.js + their hooks in followup-v3.js): every switch is off by
// default and changes nothing; each one, switched on, does only its own job.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { deflateSync } from 'node:zlib';
import {
  FP_DEFAULTS, fpAccountHour, fpClassifyObjection, fpObjectionFor, fpParseLater, fpScriptLang, fpLeadLanguage, fpTemplateLanguages,
  fpNbaScore, fpMatchProducts, fpQuoteItem, fpQuoteTotals, fpBuildQuotePdf, fpFetchQuoteAssets, fpQuoteNumber,
} from './followup-pro.js';
import { fv3Config, fv3Decide, FV3_DEFAULTS, fv3SaveSettings, fv3GetSettings, fv3OnInbound, fv3ProcessClient, fv3EnsureSchema, fv3HandleRoute, fv3LeadStatus } from './followup-v3.js';

const H=3600000, D=24*H;
const T=(s)=>Date.parse(s);
const iso=(ms)=>new Date(ms).toISOString();
const steps={
  1:{step:1, type:'session', hours:1, message:'Hi {name}, A1'},
  2:{step:2, type:'session', hours:6, message:'Hi {name}, A2'},
  3:{step:3, type:'template', template_name:'tpl3', template_body_vars:1},
  4:{step:4, type:'template', template_name:'tpl4', template_body_vars:1},
  5:{step:5, type:'template', template_name:'tpl5', template_body_vars:1},
};
const lead=(o={})=>({Id:7, Name:'Asha K', Phone:'919876543210', Stage:'new', CreatedAt:'2026-10-05T10:00:00Z', LastCustomerMsgAt:'2026-10-10T10:00:00Z', ...o});
const decide=(o={})=>fv3Decide({lead:lead(o.lead), steps, cfg:fv3Config(o.cfg||{}), state:o.state||null, sends:o.sends||[], enabledAt:'2026-10-01T00:00:00Z', now:o.now, tz:'UTC', accountHour:o.accountHour});

describe('defaults — nothing changes for existing accounts', ()=>{
  test('every Pro switch is off by default and survives a config round trip', ()=>{
    for(const k of ['pro_smart_send', 'pro_nba_home', 'pro_objections', 'pro_quote_pdf', 'pro_auto_language']){
      assert.equal(FP_DEFAULTS[k], false); assert.equal(FV3_DEFAULTS[k], false); assert.equal(fv3Config({})[k], false);
      assert.equal(fv3Config({[k]:true})[k], true);
    }
    assert.equal(fv3Config({pro_quote_valid_days:500}).pro_quote_valid_days, 90);
  });

  test('with the switches off, account hour and snooze are ignored — same decision as before', ()=>{
    const sends=[{step:1, sent_at:'2026-10-10T11:00:00Z'}, {step:2, sent_at:'2026-10-10T16:00:00Z'}];
    const state={snooze_until:'2026-10-20T10:00:00Z', hours_json:'{}'};
    const base=decide({now:T('2026-10-11T10:30:00Z'), sends});
    const withInputs=decide({now:T('2026-10-11T10:30:00Z'), sends, state, accountHour:19});
    assert.deepEqual(withInputs, base);
    assert.equal(base.next.due_at, '2026-10-11T11:00:00.000Z');
  });
});

describe('Smart send time+', ()=>{
  test('account busiest hour needs enough signal', ()=>{
    assert.equal(fpAccountHour([{hours_json:'{"19":3}'}]), null);
    assert.equal(fpAccountHour([{hours_json:'{"19":12,"8":3}'}, {hours_json:{'19':4, '10':2}}]), 19);
  });
  test('template step uses the account hour when the lead has no history', ()=>{
    const sends=[{step:1, sent_at:'2026-10-10T11:00:00Z'}, {step:2, sent_at:'2026-10-10T16:00:00Z'}];
    const d=decide({now:T('2026-10-11T10:30:00Z'), sends, accountHour:19, cfg:{pro_smart_send:true}});
    assert.equal(d.next.step, 3); assert.equal(d.next.due_at, '2026-10-11T19:00:00.000Z');
    // The lead's own hour still wins over the account's.
    const own=decide({now:T('2026-10-11T10:30:00Z'), sends, accountHour:19, cfg:{pro_smart_send:true}, state:{hours_json:JSON.stringify({14:3})}});
    assert.equal(own.next.due_at, '2026-10-11T14:00:00.000Z');
  });
  test('nudge 2 moves to the usual hour only while it still fits the 24h window', ()=>{
    const sends=[{step:1, sent_at:'2026-10-10T11:00:00Z'}];
    let d=decide({now:T('2026-10-10T12:00:00Z'), sends, accountHour:19, cfg:{pro_smart_send:true, quiet_start:23, quiet_end:7}});
    assert.equal(d.next.step, 2); assert.equal(d.next.due_at, '2026-10-10T19:00:00.000Z');
    // Usual hour 10:00 would land after the window closes (10:00 next day minus margin) — keep 16:00.
    d=decide({now:T('2026-10-10T12:00:00Z'), sends, accountHour:10, cfg:{pro_smart_send:true, quiet_start:23, quiet_end:7}});
    assert.equal(d.next.due_at, '2026-10-10T16:00:00.000Z');
  });
});

describe('Objections', ()=>{
  test('keyword classification across languages', ()=>{
    assert.equal(fpClassifyObjection('This is too expensive for me'), 'price');
    assert.equal(fpClassifyObjection('vila kooduthal aanu, kurachu tharumo'), 'price');
    assert.equal(fpClassifyObjection('bahut mehenga hai'), 'price');
    assert.equal(fpClassifyObjection('I will discuss with my wife and tell you'), 'family');
    assert.equal(fpClassifyObjection('veettil chodichittu parayam'), 'family');
    assert.equal(fpClassifyObjection('is this genuine? any reviews'), 'trust');
    assert.equal(fpClassifyObjection('another agency gave a better price'), 'competitor');
    assert.equal(fpClassifyObjection('ok I will let you know later'), 'timing');
    assert.equal(fpClassifyObjection('പിന്നെ പറയാം'), 'timing');
    assert.equal(fpClassifyObjection('Hi, please send details'), null);
  });
  test('the classifier category wins, except "family" from the text', ()=>{
    assert.equal(fpObjectionFor({LastObjectionCategory:'price'}, {last_text:'later'}), 'price');
    assert.equal(fpObjectionFor({LastObjectionCategory:'price'}, {last_text:'need to ask my husband'}), 'family');
    assert.equal(fpObjectionFor({LastObjectionCategory:'none'}, {last_text:'too costly'}), 'price');
  });
  test('"talk later" dates', ()=>{
    const now=T('2026-11-13T08:00:00Z'); // Friday, 13:30 in Kolkata
    const k=(s)=>{ const r=fpParseLater(s, now, 'Asia/Kolkata'); return r?new Date(r).toISOString():null; };
    assert.equal(k('call me tomorrow'), '2026-11-14T04:30:00.000Z');         // 10:00 IST
    assert.equal(k('tomorrow evening'), '2026-11-14T12:30:00.000Z');         // 18:00 IST
    assert.equal(k('nale vilikkam'), '2026-11-14T04:30:00.000Z');
    assert.equal(k('നാളെ പറയാം'), '2026-11-14T04:30:00.000Z');
    assert.equal(k('next week please'), '2026-11-16T04:30:00.000Z');        // Monday
    assert.equal(k('in 3 days'), '2026-11-16T04:30:00.000Z');
    assert.equal(k('after salary'), '2026-12-02T04:30:00.000Z');
    assert.equal(k('next month'), '2026-12-01T04:30:00.000Z');
    assert.equal(k('on monday'), '2026-11-16T04:30:00.000Z');
    assert.equal(k('ok thanks'), null);
  });
  test('a snooze holds the sequence and moves day 1/3/7 to start on that date', ()=>{
    const state={snooze_until:'2026-10-20T10:00:00Z'};
    const cfg={pro_objections:true, quiet_start:0, quiet_end:0};
    let d=decide({now:T('2026-10-10T10:30:00Z'), state, cfg});
    assert.equal(d.status, 'scheduled'); assert.equal(d.next.step, 3); assert.equal(d.next.due_at, '2026-10-20T10:00:00.000Z');
    assert.equal(d.snooze_until, '2026-10-20T10:00:00.000Z');
    assert.match(d.text, /talk later/);
    // Still due on the day even though day 1 is long "stale" by the normal clock.
    d=decide({now:T('2026-10-20T10:05:00Z'), state, cfg});
    assert.equal(d.status, 'due'); assert.equal(d.next.step, 3);
    // Day 3 keeps the ladder's own spacing (47h after day 1) from the snoozed day 1.
    d=decide({now:T('2026-10-20T12:00:00Z'), state, cfg, sends:[{step:3, sent_at:'2026-10-20T10:05:00Z'}]});
    assert.equal(d.next.step, 4); assert.equal(d.next.due_at, '2026-10-22T09:00:00.000Z');
    // An older snooze (before the latest message) no longer applies.
    d=decide({now:T('2026-10-10T10:30:00Z'), state:{snooze_until:'2026-10-09T10:00:00Z'}, cfg});
    assert.equal(d.next.step, 1);
  });
});

describe('Language', ()=>{
  test('script detection and the language to follow up in', ()=>{
    assert.equal(fpScriptLang('ഹായ്'), 'ml'); assert.equal(fpScriptLang('नमस्ते'), 'hi'); assert.equal(fpScriptLang('مرحبا'), 'ar');
    assert.equal(fpScriptLang('வணக்கம்'), 'ta'); assert.equal(fpScriptLang('hello'), null);
    assert.equal(fpLeadLanguage({Language:'hi'}, {last_lang:'ml'}, {language:'en'}), 'ml');
    assert.equal(fpLeadLanguage({Language:'hi'}, null, {language:'en'}), 'hi');
    assert.equal(fpLeadLanguage({}, null, {}), 'en');
  });
  test('template language candidates skip the template\'s own language', ()=>{
    assert.deepEqual(fpTemplateLanguages('ml', 'en_US'), ['ml']);
    assert.deepEqual(fpTemplateLanguages('en', 'en_US'), []);
    assert.deepEqual(fpTemplateLanguages('ar', 'ar'), []);
  });
});

describe('Next-best-action score', ()=>{
  const now=T('2026-11-13T10:00:00Z');
  test('a hot, active quote-stage lead is critical: ask for the decision', ()=>{
    const n=fpNbaScore({lead:{Stage:'quotation_sent', LastCustomerMsgAt:iso(now-H), LastAgentMsgAt:iso(now-5*H), Score:'Hot', WinProbability:70}, state:{hours_json:'{"10":6,"11":6}'}, now});
    assert.equal(n.band, 'critical'); assert.ok(n.score>=70);
    assert.match(n.action, /decision.*while the chat is open/);
  });
  test('a handed-over customer waiting on the team is always critical: reply now', ()=>{
    const n=fpNbaScore({lead:{Stage:'new', Handover:'Yes', LastCustomerMsgAt:iso(now-2*H), LastAgentMsgAt:iso(now-6*H)}, now});
    assert.equal(n.band, 'critical'); assert.match(n.action, /^Reply now/); assert.equal(n.waiting_hours, 2);
    // Bot-handled chat (no handover): not "waiting", just a message-now nudge.
    const bot=fpNbaScore({lead:{Stage:'new', LastCustomerMsgAt:iso(now-2*H)}, now});
    assert.match(bot.action, /Message now while the WhatsApp window is open \(22h left\)/);
  });
  test('closed / opted-out leads are left out; cold leads are cold', ()=>{
    assert.equal(fpNbaScore({lead:{Stage:'won', LastCustomerMsgAt:iso(now)}, now}), null);
    assert.equal(fpNbaScore({lead:{Stage:'new', OptOut:'Yes', LastCustomerMsgAt:iso(now)}, now}), null);
    const cold=fpNbaScore({lead:{Stage:'new', LastCustomerMsgAt:iso(now-20*D), LastAgentMsgAt:iso(now-19*D)}, now});
    assert.equal(cold.band, 'cold'); assert.match(cold.action, /re-engage/);
  });
  test('objection and snooze shape the action', ()=>{
    const p=fpNbaScore({lead:{Stage:'new', LastCustomerMsgAt:iso(now-30*H), LastAgentMsgAt:iso(now-29*H), LastObjectionCategory:'price'}, now});
    assert.match(p.action, /quote/i);
    const s=fpNbaScore({lead:{Stage:'new', LastCustomerMsgAt:iso(now-30*H), LastAgentMsgAt:iso(now-29*H)}, state:{snooze_until:iso(now+3*D)}, now});
    assert.match(s.action, /Check back/);
  });
});

// A 2×2 PNG (RGB) for the PDF image path.
function tinyPng(){
  const crcTable=Array.from({length:256}, (_, n)=>{ let c=n; for(let k=0; k<8; k++) c=c&1?0xEDB88320^(c>>>1):c>>>1; return c>>>0; });
  const crc=b=>{ let c=0xFFFFFFFF; for(const x of b) c=crcTable[(c^x)&255]^(c>>>8); return (c^0xFFFFFFFF)>>>0; };
  const chunk=(type, data)=>{ const t=Buffer.from(type), len=Buffer.alloc(4), c=Buffer.alloc(4); len.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr=Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8]=8; ihdr[9]=2;
  const raw=Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

describe('Quote PDF', ()=>{
  const catalog=[
    {id:1, name:'Kerala Houseboat 2N', sku:'KH2', price:12000, currency:'INR', image_url:'https://img.test/a.png', description:'Alleppey backwaters, all meals'},
    {id:2, name:'Munnar Tea Valley 3N', sku:'MT3', price:18500, currency:'INR', category:'Hill stations'},
    {id:3, name:'Goa Beach 4N', sku:'GB4', price:21000, currency:'INR'},
  ].map(p=>({...fpQuoteItem(p), key:String(p.id), category:p.category||''}));
  test('products the lead chose: SKU first, then name overlap', ()=>{
    assert.deepEqual(fpMatchProducts(catalog, {LastProductSku:'MT3'}).map(p=>p.name), ['Munnar Tea Valley 3N']);
    assert.deepEqual(fpMatchProducts(catalog, {InterestedProduct:'houseboat'}).map(p=>p.name), ['Kerala Houseboat 2N']);
    assert.deepEqual(fpMatchProducts(catalog, {InterestedProduct:'something else'}), []);
  });
  test('totals and quote number', ()=>{
    assert.deepEqual(fpQuoteTotals([{price:100, qty:2}, {price:50, qty:1}], 30), {subtotal:250, discount:30, total:220});
    assert.equal(fpQuoteNumber(12345, T('2026-11-13T10:00:00Z')), 'Q-20261113-12345');
  });
  test('builds a valid multi-item PDF with a product photo', async ()=>{
    const png=tinyPng();
    const items=[{...catalog[0], qty:2}, catalog[1]];
    const assets=await fpFetchQuoteAssets(items, {fetchImpl:async()=>new Response(png)});
    assert.equal(assets.photos.size, 1);
    const bytes=fpBuildQuotePdf({items, business:'Acme Travels', phone:'+91 90000', leadName:'Asha', quoteNo:'Q-1', currency:'INR', discount:500, note:'Prices per couple.', assets});
    const text=new TextDecoder('latin1').decode(bytes);
    assert.ok(text.startsWith('%PDF-1.4'));
    assert.match(text, /Kerala Houseboat 2N/); assert.match(text, /INR 24,000/); assert.match(text, /INR 42,000/); assert.match(text, /Discount/);
    assert.match(text, /\/Subtype \/Image/);
    // Every xref offset points at its object.
    const start=Number(/startxref\n(\d+)/.exec(text)[1]);
    const offs=text.slice(start).split('\n').slice(3).filter(l=>/^\d{10} 00000 n/.test(l)).map(l=>Number(l.slice(0, 10)));
    offs.forEach((o, i)=>assert.ok(text.startsWith(`${i+1} 0 obj`, o), `object ${i+1}`));
  });
});

// ── D1-backed ────────────────────────────────────────────────────────────────────────────────────
function d1(db){
  return {prepare(sql){
    let args=[];
    const st={
      bind(...a){ args=a; return st; },
      async run(){ const r=db.prepare(sql).run(...args); return {meta:{changes:Number(r.changes), last_row_id:Number(r.lastInsertRowid)}}; },
      async all(){ return {results:db.prepare(sql).all(...args)}; },
      async first(){ return db.prepare(sql).get(...args)||null; },
    };
    return st;
  }};
}
function freshDb(){
  const db=new DatabaseSync(':memory:');
  for(const f of ['0007_followup_engine.sql', '0047_followup_ladder.sql', '0048_followup_ladder_variants.sql', '0087_followup_send_failures.sql', '0114_followup_v3.sql'])
    db.exec(readFileSync(new URL('./migrations/'+f, import.meta.url), 'utf8'));
  return db;
}

describe('with D1', ()=>{
  let db, env, realFetch;
  const client={Id:42, client_name:'Acme', industry:'travel', deal_currency:'INR', chatwoot_base:'https://cw.test', chatwoot_account_id:1, chatwoot_token:'t', bot_config:JSON.stringify({timezone:'UTC'})};
  beforeEach(()=>{ db=freshDb(); env={DB:d1(db)}; realFetch=globalThis.fetch; });
  afterEach(()=>{ globalThis.fetch=realFetch; });

  test('inbound keeps the message, language and snooze only when a Pro switch is on', async ()=>{
    await fv3SaveSettings(env, 42, {enabled:true});
    const at=T('2026-11-13T08:00:00Z');
    await fv3OnInbound(env, client, 7, {at, text:'nale vilikkam', lang:'ml'});
    let st=db.prepare(`SELECT last_text, last_lang, snooze_until FROM followup_v3_leads WHERE lead_id=7`).get();
    assert.deepEqual({...st}, {last_text:null, last_lang:null, snooze_until:null});
    await fv3SaveSettings(env, 42, {config:{pro_objections:true}});
    await fv3OnInbound(env, client, 7, {at, text:'nale vilikkam', lang:'ml'});
    st=db.prepare(`SELECT last_text, last_lang, snooze_until FROM followup_v3_leads WHERE lead_id=7`).get();
    assert.deepEqual({...st}, {last_text:'nale vilikkam', last_lang:'ml', snooze_until:'2026-11-14T10:00:00.000Z'});
    // A new message without a date clears the snooze.
    await fv3OnInbound(env, client, 7, {at:at+H, text:'ok send details', lang:'en'});
    assert.equal(db.prepare(`SELECT snooze_until FROM followup_v3_leads WHERE lead_id=7`).get().snooze_until, null);
  });

  async function sweepFixture(config, leadExtra={}){
    await fv3EnsureSchema(env);
    const now=Date.now();
    await fv3SaveSettings(env, 42, {enabled:true, config:{quiet_start:0, quiet_end:0, weekly_digest:false, ...config}});
    db.prepare(`UPDATE followup_v3_settings SET maint_at=?, enabled_at=? WHERE client_id=42`).run(iso(now), iso(now-5*D));
    db.prepare(`INSERT INTO followup_ladder_steps (client_id, step, type, hours, message, updated_at) VALUES (42,1,'session',1,'Hi {name}, any questions about {product}?',?)`).run(iso(now));
    const l={Id:7, ClientId:42, Name:'Asha', Phone:'91900', Stage:'new', CreatedAt:iso(now-D), LastCustomerMsgAt:iso(now-2*H), ConversationID:55, InterestedProduct:'houseboat', ...leadExtra};
    const sent=[];
    const aiCalls=[];
    const deps={
      leadsTable:'L', ensureLeadsColumns:async()=>{},
      ncFetch:async(e, path)=>new Response(JSON.stringify(/records\/\d+$/.test(path)?l:{list:[l]})),
      ai:async(e, c, sys, user, opts)=>{ aiCalls.push({sys, user, caller:opts.caller}); return opts.caller==='followup-v3-translate'?'Hai Asha, enthenkilum samshayam undo?':'Totally fair — the attached quote shows the value; want a lower-budget option?'; },
      quoteProducts:async()=>[{id:1, name:'Kerala Houseboat 2N', price:12000, currency:'INR'}],
      sendStep:async(e, c, lead, step, stepCfg, opts)=>{ sent.push({step, opts}); db.prepare(`INSERT INTO followup_sends (client_id, lead_id, step, variant, sent_at, v3, kind) VALUES (42,?,?,?,?,1,?)`).run(lead.Id, step, opts.variant||'A', iso(now), opts.kind); },
    };
    return {now, l, deps, sent, aiCalls};
  }

  test('sweep with Pro off: a plain nudge, no translation, no attachment', async ()=>{
    const f=await sweepFixture({objection_branching:false}, {LastObjectionCategory:'price'});
    db.prepare(`INSERT INTO followup_v3_leads (lead_id, client_id, last_text, last_lang, updated_at) VALUES (7,42,'too costly','ml',?)`).run(iso(f.now));
    const r=await fv3ProcessClient(env, f.deps, client, await fv3GetSettings(env, 42), {now:f.now});
    assert.equal(r.sent, 1);
    assert.equal(f.sent[0].opts.overrideText, undefined); assert.equal(f.sent[0].opts.translate, undefined); assert.equal(f.sent[0].opts.attachment, undefined);
    assert.equal(f.aiCalls.length, 0);
  });

  test('sweep with objections + quote + language: price nudge carries the quote PDF, in the lead\'s language', async ()=>{
    const f=await sweepFixture({objection_branching:false, pro_objections:true, pro_quote_pdf:true, pro_auto_language:true}, {LastObjectionCategory:'price'});
    db.prepare(`INSERT INTO followup_v3_leads (lead_id, client_id, last_text, last_lang, updated_at) VALUES (7,42,'vila kooduthal aanu','ml',?)`).run(iso(f.now));
    globalThis.fetch=async()=>new Response('', {status:404}); // no logo / photos
    const r=await fv3ProcessClient(env, f.deps, client, await fv3GetSettings(env, 42), {now:f.now});
    assert.equal(r.sent, 1);
    const o=f.sent[0].opts;
    assert.equal(o.kind, 'objection'); assert.equal(o.variant, 'OBJ');
    assert.match(o.overrideText, /attached quote/);
    assert.equal(o.attachment.type, 'application/pdf'); assert.match(o.attachment.name, /^Quotation-Q-/);
    assert.ok(new TextDecoder('latin1').decode(o.attachment.bytes).includes('Kerala Houseboat 2N'));
    const objCall=f.aiCalls.find(c=>c.caller==='followup-v3-objection');
    assert.match(objCall.sys, /Malayalam using English letters/); assert.match(objCall.sys, /quotation PDF/);
    assert.equal(o.translate, undefined, 'the objection text is already written in the lead\'s language');
    assert.equal(db.prepare(`SELECT via FROM followup_v3_quotes WHERE lead_id=7`).get().via, 'followup');
  });

  test('sweep with only auto-language: the normal nudge gets translated', async ()=>{
    const f=await sweepFixture({objection_branching:false, pro_auto_language:true});
    db.prepare(`INSERT INTO followup_v3_leads (lead_id, client_id, last_text, last_lang, updated_at) VALUES (7,42,'trip details venam','ml',?)`).run(iso(f.now));
    await fv3ProcessClient(env, f.deps, client, await fv3GetSettings(env, 42), {now:f.now});
    const o=f.sent[0].opts;
    assert.equal(o.lang, 'ml');
    assert.equal(await o.translate('Hi Asha, any questions?'), 'Hai Asha, enthenkilum samshayam undo?');
    assert.match(f.aiCalls[0].sys, /English letters/);
  });

  const route=(deps, path, {method='GET', body, email='owner@acme.test'}={})=>fv3HandleRoute(
    new Request('https://w.test/followups/v3'+path, {method, headers:{'Content-Type':'application/json'}, body:body?JSON.stringify(body):undefined}),
    env, {json:(d, s)=>new Response(JSON.stringify(d), {status:s||200, headers:{'Content-Type':'application/json'}}), requireSession:async()=>({cid:42, email}), getClientById:async()=>client, ...deps},
    new URL('https://w.test/followups/v3'+path));

  test('/nba: off until switched on; ranks leads and scopes staff to their own', async ()=>{
    await fv3SaveSettings(env, 42, {enabled:true});
    const now=Date.now();
    const leads=[
      {Id:1, Name:'Waiting', Stage:'new', Handover:'Yes', LastCustomerMsgAt:iso(now-H), LastAgentMsgAt:iso(now-3*H), Owner:'staff@acme.test'},
      {Id:2, Name:'Cold', Stage:'new', LastCustomerMsgAt:iso(now-20*D), LastAgentMsgAt:iso(now-19*D), Owner:'other@acme.test'},
      {Id:3, Name:'Won', Stage:'won', LastCustomerMsgAt:iso(now)},
    ];
    const deps={leadsTable:'L', ncFetch:async()=>new Response(JSON.stringify({list:leads})), seesAllLeads:(c, e)=>e==='owner@acme.test'};
    let r=await (await route(deps, '/nba')).json();
    assert.deepEqual(r, {enabled:false});
    await fv3SaveSettings(env, 42, {config:{pro_nba_home:true}});
    r=await (await route(deps, '/nba')).json();
    assert.deepEqual(r.list.map(x=>x.name), ['Waiting', 'Cold']);
    assert.equal(r.list[0].band, 'critical'); assert.equal(r.counts.cold, 1);
    r=await (await route(deps, '/nba', {email:'staff@acme.test'})).json();
    assert.deepEqual(r.list.map(x=>x.name), ['Waiting']);
  });

  test('/quote: catalog with suggestions, PDF preview, send into the chat', async ()=>{
    await fv3SaveSettings(env, 42, {enabled:true});
    const now=Date.now();
    const l={Id:7, ClientId:42, Name:'Asha K', Phone:'91900', LastCustomerMsgAt:iso(now-2*H), ConversationID:55, InterestedProduct:'houseboat'};
    const deps={leadsTable:'L', ncFetch:async()=>new Response(JSON.stringify(l)),
      quoteProducts:async()=>[{id:'p1', name:'Kerala Houseboat 2N', price:12000, currency:'INR', image_url:'https://img.test/a.png'}, {id:'p2', name:'Goa Beach 4N', price:21000, currency:'INR'}]};
    let res=await route(deps, '/quote/catalog?lead_id=7');
    assert.equal(res.status, 400, 'off until switched on');
    await fv3SaveSettings(env, 42, {config:{pro_quote_pdf:true}});
    const cat=await (await route(deps, '/quote/catalog?lead_id=7')).json();
    assert.deepEqual(cat.suggested, ['p1']); assert.equal(cat.catalog.length, 2); assert.equal(cat.window_open, true);
    const posts=[];
    globalThis.fetch=async(url, opts={})=>{ if(String(url).startsWith('https://cw.test')){ posts.push({url:String(url), body:opts.body}); return new Response('{"id":1}'); } return new Response(tinyPng()); };
    res=await route(deps, '/quote', {method:'POST', body:{lead_id:7, items:[{key:'p1', qty:2}, {name:'Airport transfer', price:1500}], discount:1000}});
    assert.equal(res.headers.get('Content-Type'), 'application/pdf');
    assert.ok(new TextDecoder('latin1').decode(new Uint8Array(await res.arrayBuffer())).includes('Airport transfer'));
    assert.equal(posts.length, 0, 'preview never sends');
    res=await route(deps, '/quote', {method:'POST', body:{lead_id:7, items:[{key:'p1', qty:2}], send:true}});
    const sentR=await res.json();
    assert.equal(sentR.ok, true); assert.equal(sentR.total, 24000);
    assert.equal(posts.length, 1); assert.match(posts[0].url, /conversations\/55\/messages$/);
    assert.ok(posts[0].body.get('attachments[]')); assert.match(posts[0].body.get('content'), /quotation Q-.* Kerala Houseboat 2N/);
    // Window closed → no send, clear reason.
    l.LastCustomerMsgAt=iso(now-30*H);
    res=await route(deps, '/quote', {method:'POST', body:{lead_id:7, items:[{key:'p1'}], send:true}});
    assert.equal(res.status, 409);
    // Not your lead.
    l.ClientId=99;
    assert.equal((await route(deps, '/quote/catalog?lead_id=7')).status, 403);
  });

  test('saving settings mirrors the Home switch to the client record (and only when it changes)', async ()=>{
    await fv3SaveSettings(env, 42, {enabled:true});
    const flags=[];
    const deps={setClientFlag:async(e, cid, field, value)=>{ flags.push([cid, field, value]); }};
    await route(deps, '/settings', {method:'POST', body:{config:{pro_quote_pdf:true}}});
    assert.deepEqual(flags, [], 'nothing to mirror while the Home add-on stays off');
    await route(deps, '/settings', {method:'POST', body:{config:{pro_nba_home:true}}});
    assert.deepEqual(flags, [[42, 'followup_pro_nba', 'Yes']]);
  });

  test('lead status shows only the Pro parts that are on', async ()=>{
    await fv3SaveSettings(env, 42, {enabled:true});
    const l={Id:7, ClientId:42, Name:'Asha', Stage:'new', CreatedAt:iso(Date.now()-D), LastCustomerMsgAt:iso(Date.now()-H), LastObjectionCategory:'price'};
    let s=await fv3LeadStatus(env, {}, client, l);
    assert.deepEqual(s.pro, {});
    await fv3SaveSettings(env, 42, {config:{pro_objections:true, pro_nba_home:true, pro_auto_language:true, pro_quote_pdf:true}});
    s=await fv3LeadStatus(env, {}, client, {...l, Language:'hi'});
    assert.equal(s.pro.objection, 'price'); assert.equal(s.pro.language, 'hi'); assert.equal(s.pro.language_name, 'Hindi');
    assert.ok(s.pro.nba.score>0); assert.equal(s.pro.quote_pdf, true); assert.equal(s.pro.last_quote, null);
  });
});
