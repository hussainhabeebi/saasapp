// Travel flows (Travel Settings → 🧩 Flows): the pure flow engine (validation, triggers, answers,
// AI-first turns) and the worker handler end to end on an in-memory D1, with NocoDB, Gemini, Meta
// and Chatwoot stubbed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { engineHandleTravelFlows, ltTravelSettingsNormalize } from './worker.js';
import { tfNormalizeFlow, tfValidateFlow, tfTemplateFlow, tfMatchTrigger, tfPackageInMessage, tfStart, tfApplyTurn, tfDirectAnswer,
  tfAcceptAnswer, tfParseTravellers, tfParseAiReply, tfBuildAiPrompt, tfQuote, tfQualAnswers, tfPending, tfIsContinue, TF_MAX_DETOURS } from './travel-flows.js';
import { taPackagesByKeyword, taFindPackageInText } from './travel-itinerary.js';

const TODAY=new Date('2026-11-02T10:00:00Z');
const pkgs=[
  {Id:1,name:'GEORGIA SPECIAL',keywords:'ladies only',destination:'Tbilisi',nights:4,currency:'AED',sell_price:1500,child_price:900},
  {Id:2,name:'Bali Escape',destination:'Bali',nights:5,currency:'AED',sell_price:2500},
];
const pkgFlow=()=>tfNormalizeFlow({...tfTemplateFlow('package_booking'),id:'fpkg',name:'Georgia booking',status:'active',trigger:{type:'package',package_ids:['1']}});
const visaFlow=()=>tfNormalizeFlow({...tfTemplateFlow('visa'),id:'fvisa',status:'active'});

describe('flow model', ()=>{
  test('normalize: limits, ids, defaults', ()=>{
    const f=tfNormalizeFlow({name:'  X  ',trigger:{type:'nope',keywords:'umrah, Umrah ,hajj'},steps:[{type:'ask_custom',label:'Room',options:['A','a','B']},{type:'weird'},{type:'handover'}]});
    assert.equal(f.name,'X');
    assert.equal(f.status,'draft');
    assert.equal(f.trigger.type,'keyword');
    assert.deepEqual(f.trigger.keywords,['umrah','hajj']);
    assert.deepEqual(f.steps[0].options,['A','B']);
    assert.equal(f.steps[1].type,'ask_custom','unknown step type → custom question');
    assert.equal(new Set(f.steps.map(s=>s.id)).size,3);
  });
  test('validate: publishing needs a trigger and an ending step', ()=>{
    const bad=tfNormalizeFlow({name:'Trip',trigger:{type:'keyword',keywords:['trip']},steps:[{type:'ask_date'}]});
    const {errors}=tfValidateFlow(bad,{packages:pkgs});
    assert.ok(errors.some(e=>/keyword/i.test(e)),'generic-only keyword');
    assert.ok(errors.some(e=>/End the flow/.test(e)));
    assert.deepEqual(tfValidateFlow(pkgFlow(),{packages:pkgs}).errors,[]);
    assert.deepEqual(tfValidateFlow(visaFlow(),{packages:pkgs}).errors,[]);
  });
  test('validate: a package belongs to one active flow; a keyword to one active flow', ()=>{
    const other=tfNormalizeFlow({...pkgFlow(),id:'other',name:'Other'});
    assert.ok(tfValidateFlow(other,{packages:pkgs,flows:[pkgFlow()]}).errors.some(e=>/already start/.test(e)));
    const kw=tfNormalizeFlow({...visaFlow(),id:'v2',name:'Visa 2',trigger:{type:'keyword',keywords:['Visit Visa']}});
    assert.ok(tfValidateFlow(kw,{packages:pkgs,flows:[visaFlow()]}).errors.some(e=>/visit visa/i.test(e)));
    const clash=tfNormalizeFlow({...visaFlow(),id:'v3',name:'Ladies',trigger:{type:'keyword',keywords:['ladies only']}});
    assert.ok(tfValidateFlow(clash,{packages:pkgs}).warnings.some(w=>/package keyword/.test(w)));
  });
  test('validate: handover must be last', ()=>{
    const f=tfNormalizeFlow({name:'A',trigger:{type:'keyword',keywords:['umrah']},steps:[{type:'handover'},{type:'payment'}]});
    assert.ok(tfValidateFlow(f).errors.some(e=>/must be the last step/.test(e)));
  });
});

describe('triggers', ()=>{
  test('package trigger: tap, package keyword, name', ()=>{
    const opts={byKeyword:taPackagesByKeyword,findInText:taFindPackageInText};
    assert.equal(tfPackageInMessage(pkgs,'TPKG:1',opts).Id,1);
    assert.equal(tfPackageInMessage(pkgs,'any ladies only tours?',opts).Id,1);
    assert.equal(tfPackageInMessage(pkgs,'bali escape price',opts).Id,2);
    const flows=[pkgFlow(),visaFlow()];
    assert.equal(tfMatchTrigger(flows,'ladies only trip',{pkg:pkgs[0]}).flow.id,'fpkg');
    assert.equal(tfMatchTrigger(flows,'bali escape',{pkg:pkgs[1]}),null,'package not in any flow');
  });
  test('keyword trigger: word order free, drafts never run, "start only" flows', ()=>{
    const flows=[visaFlow()];
    assert.equal(tfMatchTrigger(flows,'I need a visa visit for dubai').flow.id,'fvisa');
    assert.equal(tfMatchTrigger(flows,'need visa'),null);
    assert.equal(tfMatchTrigger([{...visaFlow(),status:'draft'}],'visit visa'),null);
    const startOnly=tfNormalizeFlow({...visaFlow(),trigger:{type:'keyword',keywords:['visit visa'],when:'start'}});
    assert.equal(tfMatchTrigger([startOnly],'visit visa',{isNewChat:false}),null);
    assert.ok(tfMatchTrigger([startOnly],'visit visa',{isNewChat:true}));
  });
});

describe('answers', ()=>{
  test('travellers in free text', ()=>{
    assert.deepEqual(tfParseTravellers('2 adults 1 child'),{adults:2,children:1,infants:0,ages:[]});
    assert.deepEqual(tfParseTravellers('two adults and 2 kids aged 5 and 8'),{adults:2,children:2,infants:0,ages:[5,8]});
    assert.equal(tfParseTravellers('3 pax').adults,3);
    assert.equal(tfParseTravellers('just 2').adults,2);
    assert.equal(tfParseTravellers('me and my wife').adults,2);
    assert.equal(tfParseTravellers('how much is it'),null);
  });
  test('dates: day, month, past and too far are refused', ()=>{
    const step={id:'d',type:'ask_date'};
    assert.equal(tfAcceptAnswer(step,'2026-12-15',TODAY).date,'2026-12-15');
    assert.equal(tfAcceptAnswer(step,'2026-12',TODAY).label,'December 2026');
    assert.equal(tfAcceptAnswer(step,'december',TODAY).date,'2026-12');
    assert.equal(tfAcceptAnswer(step,'march',TODAY).date,'2027-03');
    assert.equal(tfAcceptAnswer(step,'2026-10-01',TODAY),null,'past');
    assert.equal(tfAcceptAnswer(step,'2030-01',TODAY),null,'too far');
  });
  test('options: a tap maps to the option', ()=>{
    const step={id:'r',type:'ask_custom',options:['Twin sharing','Single room']};
    assert.equal(tfAcceptAnswer(step,'twin SHARING'),'Twin sharing');
  });
  test('AI reply parsing is defensive', ()=>{
    assert.equal(tfParseAiReply('nonsense'),null);
    const r=tfParseAiReply('```json\n{"answers":{"a":1},"reply":"hi","action":"weird"}\n```');
    assert.equal(r.action,'continue');
    assert.equal(r.reply,'hi');
  });
});

describe('AI-first turns', ()=>{
  const steps=f=>f.steps.reduce((a,s)=>(a[s.type]=s.id,a),{});
  test('first message can fill several steps; package + question go out', ()=>{
    const f=pkgFlow(),ids=steps(f),st=tfStart(f,pkgs[0],TODAY);
    const ai={answers:{[ids.ask_date]:'2026-12-15'},answer:'',side_question:false,ask_step:ids.ask_travellers,reply:'Lovely! How many travellers?',action:'continue'};
    const r=tfApplyTurn(st,{ai,today:TODAY,firstTurn:true});
    assert.equal(r.action,'continue');
    assert.equal(r.outputs[0].kind,'package');
    assert.equal(r.ask.type,'ask_travellers');
    assert.equal(r.usedAi,false,'a package goes out first, so the flow asks its own question after it');
    assert.equal(st.answers[ids.ask_date].date,'2026-12-15');
  });
  test('a side question is answered and the flow asks the next detail with the AI wording', ()=>{
    const f=pkgFlow(),ids=steps(f),st=tfStart(f,pkgs[0],TODAY);
    tfApplyTurn(st,{ai:null,today:TODAY,firstTurn:true});
    assert.equal(st.current,ids.ask_date);
    const ai={answers:{},answer:'Yes, breakfast is included daily.',side_question:true,ask_step:ids.ask_date,reply:'Yes, breakfast is included daily. 😊 When would you like to travel?',action:'continue'};
    const r=tfApplyTurn(st,{ai,today:TODAY});
    assert.equal(r.usedAi,true);
    assert.match(r.reply,/breakfast/);
    assert.equal(st.detours,1);
  });
  test('ages are asked when children are given without them; quote and handover at the end', ()=>{
    const f=pkgFlow(),ids=steps(f),st=tfStart(f,pkgs[0],TODAY);
    tfApplyTurn(st,{today:TODAY,firstTurn:true});
    tfApplyTurn(st,{direct:tfDirectAnswer(st,'15 December',TODAY),today:TODAY});
    let r=tfApplyTurn(st,{direct:tfDirectAnswer(st,'2 adults 1 child',TODAY),today:TODAY});
    assert.equal(r.ask.type,'ask_travellers');
    assert.match(r.reply,/How old/);
    r=tfApplyTurn(st,{direct:tfDirectAnswer(st,'6',TODAY),today:TODAY});
    assert.equal(r.ask.type,'ask_city');
    // Departure city is optional: a reply that isn't one (and no side question) skips it.
    r=tfApplyTurn(st,{ai:{answers:{},answer:'',side_question:false,ask_step:'',reply:'',action:'continue'},today:TODAY});
    assert.equal(r.action,'finished_handover');
    const quote=r.outputs.find(o=>o.kind==='quote').text;
    assert.match(quote,/2 Adults × AED 1,500 = AED 3,000/);
    assert.match(quote,/1 Child × AED 900/);
    assert.match(quote,/Total: AED 3,900/);
    const ho=r.outputs.find(o=>o.kind==='handover').text;
    assert.match(ho,/GEORGIA SPECIAL/);
    assert.match(ho,/2 adults, 1 child \(age 6\)/);
    const q=tfQualAnswers(st);
    assert.equal(q.travel_date,'2026-12-15');
    assert.equal(q.children_ages,'6');
  });
  test('topic change pauses (not on the first message); too many detours pause', ()=>{
    const f=visaFlow(),st=tfStart(f,null,TODAY);
    assert.equal(tfApplyTurn(st,{ai:{answers:{},action:'pause'},today:TODAY,firstTurn:true}).action,'continue');
    assert.equal(tfApplyTurn(st,{ai:{answers:{},action:'pause'},today:TODAY}).action,'pause');
    const st2=tfStart(f,null,TODAY);tfApplyTurn(st2,{today:TODAY,firstTurn:true});
    let r;for(let i=0;i<TF_MAX_DETOURS;i++)r=tfApplyTurn(st2,{ai:{answers:{},side_question:true,action:'continue',answer:'x'},today:TODAY});
    assert.equal(r.action,'pause');
    assert.ok(tfIsContinue('continue booking'));
  });
  test('the AI prompt lists only pending details and carries the business prompt', ()=>{
    const f=pkgFlow(),ids=steps(f),st=tfStart(f,pkgs[0],TODAY);
    st.answers[ids.ask_date]={date:'2026-12-15',label:'Tue, 15 December 2026'};
    const p=tfBuildAiPrompt(st,{text:'is visa included?',agency:'ABC',mainPrompt:'We are ABC Travels.',lang:'en',today:TODAY});
    assert.match(p.system,/We are ABC Travels/);
    assert.doesNotMatch(p.user,new RegExp(`id "${ids.ask_date}"`));
    assert.match(p.user,new RegExp(`id "${ids.ask_travellers}"`));
    assert.equal(tfPending(st).length,2);
    assert.equal(tfQuote({...st,answers:{}}).includes('Per adult'),true);
  });
});

test('settings: flows are on by default and can be switched off', ()=>{
  assert.equal(ltTravelSettingsNormalize({}).lt_flows_enabled,true);
  assert.equal(ltTravelSettingsNormalize({lt_flows_enabled:false}).lt_flows_enabled,false);
});

class D1Statement {
  constructor(db,sql,args=[]){this.db=db;this.sql=sql;this.args=args;}
  bind(...args){return new D1Statement(this.db,this.sql,args);}
  async run(){const r=this.db.prepare(this.sql).run(...this.args);return {success:true,meta:{last_row_id:Number(r.lastInsertRowid),changes:r.changes}};}
  async first(){return this.db.prepare(this.sql).get(...this.args)||null;}
  async all(){return {results:this.db.prepare(this.sql).all(...this.args)};}
}
class D1Database { constructor(){this.db=new DatabaseSync(':memory:');} prepare(sql){return new D1Statement(this.db,sql);} }

test('worker: a published package flow runs AI-first, then hands over with a summary', async()=>{
  const env={DB:new D1Database(),NOCODB_BASE:'https://nc.test',NOCODB_TOKEN:'t',GEMINI_API_KEY:'g'},realFetch=globalThis.fetch,sent=[];
  let aiReply=null;
  globalThis.fetch=async(url,opts={})=>{
    const u=String(url);
    if(u.startsWith('https://nc.test/'))return Response.json({list:u.includes('/tables/tpk/')?pkgs:[]});
    if(u.includes('generativelanguage.googleapis.com'))return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(aiReply)}]}}]});
    if(u.startsWith('https://graph.facebook.com/')){sent.push({meta:JSON.parse(opts.body)});return new Response('{}');}
    if(u.startsWith('https://cw.test/')){const b=opts.body;sent.push({cw:b?.get?b.get('content'):(typeof b==='string'?(JSON.parse(b).content||JSON.parse(b).labels):'')});return new Response('{"id":1}');}
    return new Response('{}',{status:404});
  };
  try{
    const c={Id:7,industry:'travel',client_name:'ABC Travels',language:'en',ta_table_ids:JSON.stringify({packages:'tpk',itineraries:'tit'}),
      chatwoot_base:'https://cw.test',chatwoot_account_id:'1',chatwoot_token:'cw',wa_phone_id:'PHONE',wa_token:'TOKEN'};
    const phone='+919800000002',state={convId:'77',stage:'new',activeHistory:[]};
    // No flows yet → nothing changes.
    assert.equal(await engineHandleTravelFlows(env,c,7,state,phone,'','ladies only trip','text'),null);
    const f=pkgFlow(),ids=f.steps.reduce((a,s)=>(a[s.type]=s.id,a),{});
    await env.DB.prepare(`INSERT INTO lt_travel_flows (client_id,id,status,flow_json,position,updated_at) VALUES (7,?,?,?,0,?)`).bind(f.id,'active',JSON.stringify(f),new Date().toISOString()).run();
    assert.equal(await engineHandleTravelFlows(env,{...c,lt_flows_enabled:false},7,state,phone,'','ladies only trip','text'),null,'master switch off');
    assert.equal(await engineHandleTravelFlows(env,c,7,state,phone,'','bali escape','text'),null,'other packages keep the normal path');

    // Trigger: the package keyword. The AI reads the dates out of the same message.
    const date=new Date(Date.now()+30*86400000).toISOString().slice(0,10);
    aiReply={answers:{[ids.ask_date]:date},answer:'',side_question:false,ask_step:ids.ask_travellers,reply:'Great! How many travellers?',action:'continue'};
    let r=await engineHandleTravelFlows(env,c,7,state,phone,'',`ladies only trip on ${date}`,'text');
    assert.equal(r.turn.route,'travel_flow');
    assert.equal(r.turn.qualAnswers.package,'GEORGIA SPECIAL');
    assert.equal(r.turn.qualAnswers.travel_date,date);
    assert.match(r.turn.text,/How many people are travelling/);
    await r.turn.deliver();
    assert.ok(sent.some(x=>String(x.cw||'').includes('GEORGIA SPECIAL')),'package details sent');

    // A side question: answered by the AI, then the same detail asked again.
    aiReply={answers:{},answer:'Visa is not included; our team can arrange it.',side_question:true,ask_step:ids.ask_travellers,reply:'Visa is not included; our team can arrange it. 😊 How many travellers?',action:'continue'};
    r=await engineHandleTravelFlows(env,c,7,state,phone,'','is visa included?','text');
    assert.match(r.turn.text,/Visa is not included/);
    assert.match(r.turn.text,/How many travellers/);

    // Clean answers go without the AI.
    aiReply=null;
    r=await engineHandleTravelFlows(env,c,7,state,phone,'','2 adults','text');
    assert.match(r.turn.text,/Which city/);
    // A topic change pauses the flow: the normal bot answers.
    aiReply={answers:{},answer:'',side_question:true,ask_step:'',reply:'',action:'pause'};
    assert.equal(await engineHandleTravelFlows(env,c,7,state,phone,'','I want only flight tickets to Delhi','text'),null);
    assert.equal(await engineHandleTravelFlows(env,c,7,state,phone,'','what time do you open','text'),null,'paused: normal path');
    r=await engineHandleTravelFlows(env,c,7,state,phone,'','continue booking','text');
    assert.match(r.turn.text,/continue with \*GEORGIA SPECIAL\*/);

    aiReply={answers:{[ids.ask_city]:'Kochi'},answer:'',side_question:false,ask_step:'',reply:'',action:'continue'};
    r=await engineHandleTravelFlows(env,c,7,state,phone,'','from kochi','text');
    assert.equal(r.turn.route,'human');
    assert.equal(r.turn.next,'human_handover');
    assert.equal(r.turn.intent,'BOOKING');
    assert.match(r.turn.text,/Total: AED 3,000/);
    assert.match(r.turn.text,/From: Kochi|Departure city: Kochi/);
    await r.turn.deliver();
    assert.ok(sent.some(x=>Array.isArray(x.cw)||String(x.cw||'').includes('human')),'handover label');
    const stats=(await env.DB.prepare(`SELECT metric,n FROM lt_travel_flow_stats WHERE client_id=7`).all()).results.reduce((a,x)=>(a[x.metric]=x.n,a),{});
    assert.equal(stats.started,1);
    assert.equal(stats.handed_over,1);
    assert.equal(stats.paused,1);
    assert.equal(stats.side_answers>=1,true);
    // Finished: the next message is not in a flow any more.
    assert.equal(await engineHandleTravelFlows(env,c,7,state,phone,'','thanks','text'),null);
    // "talk to agent" inside a flow goes to the team.
    aiReply={answers:{},answer:'',side_question:false,ask_step:'',reply:'',action:'continue'};
    await engineHandleTravelFlows(env,c,7,state,phone,'','ladies only','text');
    r=await engineHandleTravelFlows(env,c,7,state,phone,'','talk to agent','text');
    assert.equal(r.introAction.intent,'WANTS_HUMAN');
  }finally{ globalThis.fetch=realFetch; }
});
