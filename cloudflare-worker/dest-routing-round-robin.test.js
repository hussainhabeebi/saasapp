// Destination routing round robin: when several teammates have the same destination, each new
// lead goes to the next of them — and the lead is assigned to exactly the teammate whose number
// the customer is given.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {dsrNormalizeSettings, dsrMatchAll, dsrMatch, dsrRotationKey, dsrPickRoundRobin} from './dest-staff-routing.js';
import {engineDsrApply, engineDsrLeadFields} from './worker.js';

class D1Statement{
  constructor(db,sql,args=[]){this.db=db;this.sql=sql;this.args=args;}
  bind(...a){return new D1Statement(this.db,this.sql,a);}
  async run(){const r=this.db.prepare(this.sql).run(...this.args);return {success:true,meta:{changes:r.changes}};}
  async first(){return this.db.prepare(this.sql).get(...this.args)||null;}
  async all(){return {results:this.db.prepare(this.sql).all(...this.args)};}
}
class D1Database{constructor(){this.db=new DatabaseSync(':memory:');}prepare(sql){return new D1Statement(this.db,sql);}}

const cfg=dsrNormalizeSettings({enabled:true, rules:{
  'sruthi@x.com':{resorts:['Ooty','Wayanad']},
  'rinsha@x.com':{resorts:['Ooty']},
  'adil@x.com':{resorts:['Munnar','ooty']},
  'shakir@x.com':{resorts:['*']},
}});

test('every teammate with the destination, in table order; "*" only when nobody named it', ()=>{
  const ask={kind:'resort', destination:'Ooty'};
  assert.deepEqual(dsrMatchAll(cfg, ask).map(h=>h.email), ['sruthi@x.com','rinsha@x.com','adil@x.com']);
  assert.equal(dsrMatch(cfg, ask).email, 'sruthi@x.com');
  assert.deepEqual(dsrMatchAll(cfg, {kind:'resort', destination:'Munnar'}).map(h=>h.email), ['adil@x.com']);
  assert.deepEqual(dsrMatchAll(cfg, {kind:'resort', destination:'Kovalam'}).map(h=>[h.email,h.wildcard]), [['shakir@x.com',true]]);
  assert.deepEqual(dsrMatchAll(cfg, ask, e=>e!=='rinsha@x.com').map(h=>h.email), ['sruthi@x.com','adil@x.com'], 'away / gone skipped');
  assert.deepEqual(dsrMatchAll({...cfg, enabled:false}, ask), []);
});

test('rotation key ignores order; pick wraps around', ()=>{
  const hits=dsrMatchAll(cfg, {kind:'resort', destination:'Ooty'});
  assert.equal(dsrRotationKey('resort', hits), 'resort:adil@x.com,rinsha@x.com,sruthi@x.com');
  assert.equal(dsrRotationKey('resort', [...hits].reverse()), dsrRotationKey('resort', hits));
  assert.deepEqual([0,1,2,3,4].map(n=>dsrPickRoundRobin(hits, n).email), ['sruthi@x.com','rinsha@x.com','adil@x.com','sruthi@x.com','rinsha@x.com']);
  assert.equal(dsrPickRoundRobin([], 3), null);
});

test('consecutive Ooty leads: Sruthi, Rinsha, Adil, Sruthi — each lead owned by the person whose number it was given', async()=>{
  const env={DB:new D1Database(), NOCODB_BASE:'https://nc.test', NOCODB_TOKEN:'t'};
  const c={Id:7, industry:'travel', client_name:'Yathra', authentik_email:'boss@x.com',
    team_emails:'sruthi@x.com,rinsha@x.com,adil@x.com,shakir@x.com',
    team_names:JSON.stringify({'sruthi@x.com':'Sruthi','rinsha@x.com':'Rinsha','adil@x.com':'Adil','shakir@x.com':'Shakir'}),
    team_whatsapp:JSON.stringify({'sruthi@x.com':'916282917343','rinsha@x.com':'919074288723','adil@x.com':'918590796340','shakir@x.com':'918680055639'}),
    dest_staff_routing:JSON.stringify({enabled:true, rules:{'sruthi@x.com':{resorts:['Ooty']}, 'rinsha@x.com':{resorts:['Ooty']}, 'adil@x.com':{resorts:['Ooty']}, 'shakir@x.com':{resorts:['Munnar']}}})};
  const real=globalThis.fetch; globalThis.fetch=async()=>Response.json({list:[]});
  try{
    const got=[];
    for(let i=0;i<4;i++){
      const state={convId:String(100+i), stage:'new', lead:{Id:200+i, Name:'Guest'}, phone:'+91900000000'+i, qualAnswers:{}, inboxId:''};
      const turn=await engineDsrApply(env, c, '7', state, {route:'faq', lang:'en', text:'', dsr:{kind:'resort', destination:'Ooty'}});
      const fields=engineDsrLeadFields(turn.dsrPlan);
      // The lead is assigned to the same person whose number the customer is told.
      assert.equal(fields.Owner, turn.dsrPlan.email);
      assert.ok(turn.text.includes('+'+JSON.parse(c.team_whatsapp)[fields.Owner]), turn.text);
      assert.ok(turn.text.includes(turn.dsrPlan.staffName));
      assert.deepEqual(turn.dsrPlan.rotation, ['Sruthi','Rinsha','Adil']);
      got.push(turn.dsrPlan.staffName);
    }
    assert.deepEqual(got, ['Sruthi','Rinsha','Adil','Sruthi']);
    // Another destination has its own rotation.
    const m=await engineDsrApply(env, c, '7', {convId:'9', stage:'new', lead:{Id:9}, phone:'+919', qualAnswers:{}}, {route:'faq', lang:'en', text:'', dsr:{kind:'resort', destination:'Munnar'}});
    assert.equal(m.dsrPlan.staffName, 'Shakir');
  }finally{ globalThis.fetch=real; }
});

test('the private note says who the destination rotates between — or that only one person has it', async()=>{
  const {dsrNoteText}=await import('./dest-staff-routing.js');
  assert.match(dsrNoteText({kind:'resort', destination:'Ooty', staffName:'Rinsha', rotation:['Sruthi','Rinsha','Adil']}), /Round robin between Sruthi, Rinsha, Adil\./);
  assert.match(dsrNoteText({kind:'resort', destination:'Ooty', staffName:'Sruthi', rotation:['Sruthi']}), /Only Sruthi has this destination — add it to other teammates' rows for round robin\./);
});
