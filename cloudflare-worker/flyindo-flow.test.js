// Flyindo chat style (Travel Settings → 🧭 Chat Style): the pure step machine, date validation,
// and the worker handler end to end on an in-memory D1 with Meta/Chatwoot stubbed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, { engineHandleFlyindo, ltTravelSettingsNormalize } from './worker.js';
import { flyindoParseDate, flyindoCheckDate, flyindoMonthRows, flyindoWeekRows, flyindoDayRows, flyindoAdvance, flyindoPrompt, flyindoStart,
  flyindoNormalizeDestinations, flyindoSummaryText, flyindoQualAnswers, FLYINDO_DEFAULT_DESTINATIONS,
  flyindoWantsAi, flyindoTapValue, flyindoBuildAiPrompt, flyindoParseAiReply, flyindoAiValueInput } from './flyindo-flow.js';

const TODAY=new Date('2026-11-02T10:00:00Z');
const dests=FLYINDO_DEFAULT_DESTINATIONS;

describe('dates', ()=>{
  test('typed dates', ()=>{
    assert.equal(flyindoParseDate('15 December', TODAY), '2026-12-15');
    assert.equal(flyindoParseDate('Dec 15th', TODAY), '2026-12-15');
    assert.equal(flyindoParseDate('15/12', TODAY), '2026-12-15');
    assert.equal(flyindoParseDate('1 November', TODAY), '2027-11-01', 'day+month already past this year → next year');
    assert.equal(flyindoParseDate('15-12-2026', TODAY), '2026-12-15');
    assert.equal(flyindoParseDate('tomorrow', TODAY), '2026-11-03');
    assert.equal(flyindoParseDate('next summer', TODAY), '');
  });
  test('only future dates within range are bookable', ()=>{
    assert.equal(flyindoCheckDate('2026-11-02', TODAY).reason, 'past');
    assert.equal(flyindoCheckDate('2026-10-01', TODAY).reason, 'past');
    assert.equal(flyindoCheckDate('2026-02-30', TODAY).reason, 'invalid');
    assert.equal(flyindoCheckDate('2029-01-01', TODAY).reason, 'too_far');
    assert.ok(flyindoCheckDate('2026-11-03', TODAY).ok);
  });
  test('month → week → day rows never offer a past day and fit a WhatsApp list', ()=>{
    const months=flyindoMonthRows(TODAY);
    assert.equal(months.length, 10);
    assert.equal(months[0].title, '⚡ Next 7 days');
    assert.equal(months[1].title, '📅 November 2026');
    const weeks=flyindoWeekRows('2026-11', TODAY);
    assert.equal(weeks[0].title, '3 – 7 Nov', 'starts tomorrow');
    const days=flyindoDayRows('2026-11-03', '2026-11-07', TODAY);
    assert.deepEqual(days.map(d=>d.value), ['FLY:date:2026-11-03','FLY:date:2026-11-04','FLY:date:2026-11-05','FLY:date:2026-11-06','FLY:date:2026-11-07']);
    assert.equal(days[0].description, 'Tomorrow');
  });
});

describe('steps', ()=>{
  const go=(st, input, o={})=>flyindoAdvance(st, input, {destinations:dests, today:TODAY, askAges:true, ...o});
  test('full buttons flow collects destination, date, adults, children and ages', ()=>{
    let s=flyindoStart();
    s=go(s,'FLY:dest:0').state;           assert.equal(s.destination,'Munnar'); assert.equal(s.step,'month');
    s=go(s,'FLY:month:2026-12').state;     assert.equal(s.step,'week'); assert.equal(s.monthLabel,'December 2026');
    s=go(s,'FLY:week:2026-12-15:2026-12-21').state; assert.equal(s.step,'day');
    s=go(s,'FLY:date:2026-12-15').state;   assert.equal(s.date,'2026-12-15'); assert.equal(s.step,'adults');
    s=go(s,'FLY:adults:2').state;          assert.equal(s.step,'children');
    s=go(s,'FLY:kids:1').state;            assert.equal(s.step,'ages');
    s=go(s,'FLY:age:5-7').state;           assert.equal(s.step,'done');
    const p=flyindoPrompt(s,{agency:'ABC Travels'});
    assert.ok(p.done);
    assert.match(p.text, /📍 Destination: Munnar/);
    assert.match(p.text, /📅 Travel Date: Tue, 15 December 2026/);
    assert.match(p.text, /👨 Adults: 2\n👧 Children: 1/);
    assert.match(p.text, /Children's ages: 5 – 7 years/);
    assert.match(p.text, /Thank you for choosing \*ABC Travels\*! ❤️/);
    assert.deepEqual(flyindoQualAnswers(s), {destination:'Munnar', travel_date:'2026-12-15', adults:'2', children:'1', children_ages:'5 – 7 years'});
  });
  test('free text that is not an answer repeats the step with a note', ()=>{
    const r=go(flyindoStart(), 'what is the price?');
    assert.equal(r.state.step, 'destination');
    assert.match(r.note, /didn't catch that/);
    const p=flyindoPrompt(r.state,{agency:'ABC Travels',destinations:dests,note:r.note,resume:true});
    assert.match(p.text, /Please select a destination from the list below/);
    assert.doesNotMatch(p.text, /Welcome to/, 'a chat under way is not welcomed again');
  });
  test('row titles and typed answers also work', ()=>{
    let s=go(flyindoStart(), '🏖️ Goa').state;  assert.equal(s.destination,'Goa');
    s=go(s,'📅 December 2026').state;          assert.equal(s.step,'week');
    s=go(s,'20 dec').state;                     assert.equal(s.date,'2026-12-20');
    s=go(s,'3 Adults').state;                   assert.equal(s.adults,3);
    s=go(s,'No children').state;                assert.equal(s.step,'done', 'no children → straight to handover');
  });
  test('a past typed date is refused and the date step starts over', ()=>{
    const s={step:'month', destination:'Goa', ages:[]};
    const r=go(s,'1 Oct 2026');
    assert.equal(r.state.step,'month'); assert.match(r.note, /already passed/);
  });
  test('ages are skipped when the agency turns that off; 10+ adults kept as text', ()=>{
    let s={step:'adults', destination:'Goa', date:'2026-12-20', ages:[]};
    s=go(s,'FLY:adults:10+').state; assert.equal(s.adults,'10+');
    s=go(s,'FLY:kids:2',{askAges:false}).state; assert.equal(s.step,'done');
  });
  test('a typed child age maps to its band', ()=>{
    const s=go({step:'ages', children:1, ages:[]}, '3').state;
    assert.deepEqual(s.ages, ['2-4']);
  });
  test('destinations: defaults, de-duplicated, max 10', ()=>{
    assert.equal(flyindoNormalizeDestinations(null).length, 5);
    assert.deepEqual(flyindoNormalizeDestinations([{name:'Bali'},{name:'bali'},{name:''}]), [{emoji:'',name:'Bali'}]);
    assert.equal(flyindoNormalizeDestinations(Array.from({length:14},(_,i)=>({name:'D'+i}))).length, 10);
  });
});

test('settings normalize', ()=>{
  const n=ltTravelSettingsNormalize({lt_chat_style:'FLYINDO', lt_flyindo_child_ages:'No'});
  assert.equal(n.lt_chat_style, 'flyindo');
  assert.equal(n.lt_flyindo_child_ages, false);
  assert.equal(ltTravelSettingsNormalize({}).lt_chat_style, '');
});

class D1Statement {
  constructor(db,sql,args=[]){this.db=db;this.sql=sql;this.args=args;}
  bind(...args){return new D1Statement(this.db,this.sql,args);}
  async run(){const r=this.db.prepare(this.sql).run(...this.args);return {success:true,meta:{last_row_id:Number(r.lastInsertRowid),changes:r.changes}};}
  async first(){return this.db.prepare(this.sql).get(...this.args)||null;}
  async all(){return {results:this.db.prepare(this.sql).all(...this.args)};}
}
class D1Database { constructor(){this.db=new DatabaseSync(':memory:');} prepare(sql){return new D1Statement(this.db,sql);} }

test('worker: Flyindo greets with destinations, re-asks on free text, hands over with a summary', async()=>{
  const env={DB:new D1Database()},realFetch=globalThis.fetch,meta=[],chatwoot=[];
  globalThis.fetch=async(url,opts={})=>{
    const u=String(url);
    if(u.startsWith('https://graph.facebook.com/')){meta.push(JSON.parse(opts.body));return new Response('{}');}
    if(u.startsWith('https://cw.test/')){const b=opts.body;chatwoot.push({url:u,content:b?.get?b.get('content'):(typeof b==='string'?JSON.parse(b).content||JSON.parse(b).labels:'')});return new Response('{"id":1}');}
    return new Response('{}',{status:404});
  };
  try{
    const c={Id:7,industry:'travel',client_name:'ABC Travels',language:'en',lt_chat_style:'flyindo',lt_flyindo_destinations:dests,chatwoot_base:'https://cw.test',chatwoot_account_id:'1',chatwoot_token:'cw',wa_phone_id:'PHONE',wa_token:'TOKEN'};
    const phone='+919800000001',state={convId:'55',stage:'new'};
    assert.equal(await engineHandleFlyindo(env,{...c,lt_chat_style:''},7,state,phone,'','hi','text'), null, 'off by default');
    assert.equal(await engineHandleFlyindo(env,c,7,state,phone,'','stop','text'), null, 'opt-out keeps its own path');

    let r=await engineHandleFlyindo(env,c,7,state,phone,'','Do you have honeymoon packages?','text');
    assert.match(r.turn.text, /Hello! 👋 Welcome to \*ABC Travels\*!/);
    await r.turn.deliver();
    const list=meta.at(-1).interactive;
    assert.equal(list.type,'list');
    assert.deepEqual(list.action.sections[0].rows.map(x=>x.title), ['🏔️ Munnar','🏖️ Goa','🌴 Wayanad','🏝️ Maldives','🏔️ Kashmir']);

    r=await engineHandleFlyindo(env,c,7,state,phone,'','how much?','text');
    assert.match(r.turn.text, /Please select a destination/);

    r=await engineHandleFlyindo(env,c,7,state,phone,'','FLY:dest:0','text');
    assert.match(r.turn.text, /When are you planning to visit \*Munnar\*/);
    const tomorrow=new Date(Date.now()+86400000).toISOString().slice(0,10);
    await engineHandleFlyindo(env,c,7,state,phone,'',`FLY:week:${tomorrow}`,'text');
    r=await engineHandleFlyindo(env,c,7,state,phone,'',`FLY:date:${tomorrow}`,'text');
    assert.match(r.turn.text, /How many people will be travelling/);
    await engineHandleFlyindo(env,c,7,state,phone,'','FLY:adults:2','text');
    r=await engineHandleFlyindo(env,c,7,state,phone,'','FLY:kids:0','text');
    assert.equal(r.turn.route,'human', 'handed to the team');
    assert.equal(r.turn.intent,'BOOKING');
    assert.equal(r.turn.qualAnswers.destination,'Munnar');
    assert.match(r.turn.text, /Our travel consultant will contact you shortly/);
    await r.turn.deliver();
    assert.ok(chatwoot.some(x=>String(x.url).endsWith('/labels')), 'human-requested label added');

    // Handed over: the consultant has the chat, the bot stays out — until the customer starts again.
    const after={...state, stage:'human_handover'};
    assert.equal(await engineHandleFlyindo(env,c,7,after,phone,'','ok thanks','text'), null);
    r=await engineHandleFlyindo(env,c,7,after,phone,'','hi','text');
    assert.match(r.turn.text, /Where would you like to travel today/);

    r=await engineHandleFlyindo(env,c,7,state,phone,'','talk to agent','text');
    assert.equal(r.introAction.intent,'WANTS_HUMAN');
  }finally{ globalThis.fetch=realFetch; }
});

describe('AI upgrade', ()=>{
  test('only typed questions / non-answers go to the AI; taps never do', ()=>{
    const s=flyindoStart(),o={destinations:dests,today:TODAY};
    const ask=t=>flyindoWantsAi(t, flyindoAdvance(s,t,o), flyindoTapValue(s,t,o));
    assert.equal(ask('FLY:dest:1'), false);
    assert.equal(ask('🏖️ Goa'), false, 'a row title is a tap');
    assert.equal(ask('Goa'), false, 'a clean typed answer');
    assert.equal(ask('Rs'), true, 'not an answer');
    assert.equal(ask('Goa package price?'), true, 'answer + question');
    assert.equal(ask('do you do visa for dubai'), true);
  });
  test('prompt carries the step, destinations, staff messages and the KB', ()=>{
    const st={step:'adults',destination:'Goa',date:'2026-12-15',ages:[]};
    const p=flyindoBuildAiPrompt(st,{text:'Rs',agency:'FLY INDO HOLIDAYS',kb:'Goa 3N/4D from Rs 12,999',destinations:dests,
      history:[{role:'assistant',by:'agent',content:'PLEASE SEND CONTACT NUMBER'}],today:TODAY});
    assert.match(p.system, /Goa 3N\/4D from Rs 12,999/);
    assert.match(p.system, /- Maldives/);
    assert.match(p.system, /the number of adults/);
    assert.match(p.user, /Staff: PLEASE SEND CONTACT NUMBER/);
    assert.match(p.user, /Destination: Goa/);
  });
  test('reply parsing and value mapping', ()=>{
    assert.deepEqual(flyindoParseAiReply('```json\n{"answer":"Hi","value":"Goa","action":"answer"}\n```'), {answer:'Hi',value:'Goa',action:'answer'});
    assert.equal(flyindoParseAiReply('not json'), null);
    assert.equal(flyindoParseAiReply('{"answer":"","action":"answer"}'), null);
    assert.equal(flyindoParseAiReply('{"answer":"","action":"handover"}').action, 'handover');
    assert.equal(flyindoAiValueInput('month','2026-12'), 'FLY:month:2026-12');
    assert.equal(flyindoAiValueInput('month','2026-12-20'), '2026-12-20');
    assert.equal(flyindoAiValueInput('adults',2), '2');
  });
});

test('worker: Flyindo AI answers a question, then takes the customer back to the menu', async()=>{
  const env={DB:new D1Database(),GEMINI_API_KEY:'k'},realFetch=globalThis.fetch,meta=[],prompts=[];
  let aiReply=null;
  globalThis.fetch=async(url,opts={})=>{
    const u=String(url);
    if(u.includes('generativelanguage.googleapis.com')){prompts.push(String(opts.body||''));return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(aiReply)}]}}]});}
    if(u.startsWith('https://graph.facebook.com/')){meta.push(JSON.parse(opts.body));return new Response('{}');}
    if(u.startsWith('https://cw.test/'))return new Response('{"id":1}');
    return new Response('{}',{status:404});
  };
  try{
    const c={Id:8,industry:'travel',client_name:'FLY INDO HOLIDAYS',language:'en',lt_chat_style:'flyindo',lt_flyindo_destinations:dests,kb_summary:'Goa 3N/4D package from Rs 12,999 per person.',chatwoot_base:'https://cw.test',chatwoot_account_id:'1',chatwoot_token:'cw',wa_phone_id:'PHONE',wa_token:'TOKEN'};
    const phone='+919800000002',state={convId:'56',stage:'new'};
    let r=await engineHandleFlyindo(env,c,8,state,phone,'','hi','text');
    assert.match(r.turn.text, /Welcome to \*FLY INDO HOLIDAYS\*/);
    assert.equal(prompts.length, 0, 'greeting: no AI call');

    // A question that isn't an answer: answered, destination list shown again (no second welcome).
    aiReply={answer:'Our Goa 3N/4D package starts at *Rs 12,999* per person 😊',value:'',action:'answer'};
    r=await engineHandleFlyindo(env,c,8,state,phone,'','Rs','text');
    assert.equal(prompts.length, 1);
    assert.match(r.turn.text, /^Our Goa 3N\/4D package starts at \*Rs 12,999\*/);
    assert.match(r.turn.text, /Please select a destination from the list below 👇$/);
    assert.doesNotMatch(r.turn.text, /Welcome to/);
    await r.turn.deliver();
    assert.equal(meta.at(-1).interactive.type, 'list', 'back to the menu');

    // A question that also picks a destination moves the booking on.
    aiReply={answer:'Goa is lovely in December! 🏖️',value:'Goa',action:'answer'};
    r=await engineHandleFlyindo(env,c,8,state,phone,'','Goa package price?','text');
    assert.match(r.turn.text, /Goa is lovely in December/);
    assert.match(r.turn.text, /When are you planning to visit \*Goa\*/);
    assert.equal(r.turn.qualAnswers.destination, 'Goa');

    // Taps never call the AI.
    const n=prompts.length;
    r=await engineHandleFlyindo(env,c,8,state,phone,'','FLY:month:2026-12','text');
    assert.equal(prompts.length, n);

    // AI unavailable → the old behaviour (same options again).
    aiReply='garbage';
    r=await engineHandleFlyindo(env,c,8,state,phone,'','what about hotels?','text');
    assert.match(r.turn.text, /Which week in/);

    // Asking for a person through the AI hands over.
    aiReply={answer:'',value:'',action:'handover'};
    r=await engineHandleFlyindo(env,c,8,state,phone,'','can someone call me please','text');
    assert.equal(r.introAction.intent, 'WANTS_HUMAN');

    // Switched off in settings → no AI call.
    await engineHandleFlyindo(env,c,8,state,phone,'','hi','text');
    const m=prompts.length;
    r=await engineHandleFlyindo(env,{...c,lt_flyindo_ai:false},8,state,phone,'','Rs','text');
    assert.equal(prompts.length, m);
    assert.match(r.turn.text, /didn't catch that/);
  }finally{ globalThis.fetch=realFetch; }
});
