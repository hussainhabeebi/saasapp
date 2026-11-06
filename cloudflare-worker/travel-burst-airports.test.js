// Consecutive customer messages are answered once, together, and the live travel route reader
// knows the airports customers actually type (Singapore, Trichy, …).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ltParseFlightRoute, ltChatFlightIntent, ltUnknownRouteCities, engineCoalesceBurst, engineBurstWaitMs, engineJoinBurstTexts } from './worker.js';

class D1Statement {
  constructor(db,sql,args=[]){this.db=db;this.sql=sql;this.args=args;}
  bind(...args){return new D1Statement(this.db,this.sql,args);}
  async run(){const r=this.db.prepare(this.sql).run(...this.args);return {success:true,meta:{last_row_id:Number(r.lastInsertRowid),changes:r.changes}};}
  async first(){return this.db.prepare(this.sql).get(...this.args)||null;}
  async all(){return {results:this.db.prepare(this.sql).all(...this.args)};}
}
class D1Database {
  constructor(){this.db=new DatabaseSync(':memory:');}
  prepare(sql){return new D1Statement(this.db,sql);}
}

test('new airports: Singapore to Trichy and other common routes are read',()=>{
  assert.deepEqual(ltParseFlightRoute('Singapore To Trichy'),{origin:'SIN',destination:'TRZ'});
  assert.deepEqual(ltParseFlightRoute('Singapore To Trichy\n08 Nov 2026'),{origin:'SIN',destination:'TRZ'});
  assert.deepEqual(ltParseFlightRoute('kuala lumpur to madurai'),{origin:'KUL',destination:'IXM'});
  assert.deepEqual(ltParseFlightRoute('Colombo to Coimbatore'),{origin:'CMB',destination:'CJB'});
  assert.deepEqual(ltParseFlightRoute('Kuwait to Kochi'),{origin:'KWI',destination:'COK'});
  assert.deepEqual(ltParseFlightRoute('trichy singapore ticket'),{origin:'TRZ',destination:'SIN'});
  assert.deepEqual(ltParseFlightRoute('London to Delhi'),{origin:'LHR',destination:'DEL'});
  assert.equal(ltChatFlightIntent('Singapore to Trichy 08 Nov 2026'),true);
  // Existing aliases keep working.
  assert.deepEqual(ltParseFlightRoute('Dubai to Kochi'),{origin:'DXB',destination:'COK'});
  assert.deepEqual(ltParseFlightRoute('sharjah ninnu calicut'),{origin:'SHJ',destination:'CCJ'});
});

test('unknown route cities are named instead of re-asking the same question',()=>{
  assert.deepEqual(ltUnknownRouteCities('Salem to Trichy',{destination:'TRZ'}),['Salem']);
  assert.deepEqual(ltUnknownRouteCities('foo town to bar city\n08 Nov',{}),['Foo Town','Bar City']);
  assert.deepEqual(ltUnknownRouteCities('Singapore To Trichy',{origin:'SIN',destination:'TRZ'}),[]);
  assert.deepEqual(ltUnknownRouteCities('08 Nov 2026',{}),[]);
});

test('burst wait setting: default on, 0 turns it off, clamped',()=>{
  assert.equal(engineBurstWaitMs({}),2500);
  assert.equal(engineBurstWaitMs({burst_wait_ms:0}),0);
  assert.equal(engineBurstWaitMs({burst_wait_ms:'99999'}),8000);
  assert.equal(engineJoinBurstTexts(['Singapore To Trichy','Singapore To Trichy',' 08 Nov 2026 ']),'Singapore To Trichy\n08 Nov 2026');
});

test('consecutive messages: the older turn stands down, the newest answers both together',async()=>{
  const env={DB:new D1Database()};
  let release;const gate=new Promise(r=>{release=r;});
  // First message waits until the second has been recorded.
  const first=engineCoalesceBurst(env,7,'+6591234567','m1','Singapore To Trichy','text',{},()=>gate);
  await new Promise(r=>setTimeout(r,10));
  const second=engineCoalesceBurst(env,7,'+6591234567','m2','08 Nov 2026','text',{},async()=>{release();});
  const [a,b]=await Promise.all([first,second]);
  assert.equal(a.superseded,true);
  assert.equal(b.coalesced,true);
  assert.equal(b.text,'Singapore To Trichy\n08 Nov 2026');
  assert.deepEqual(ltParseFlightRoute(b.text),{origin:'SIN',destination:'TRZ'});

  // A redelivery of an already-answered message is not answered again.
  const again=await engineCoalesceBurst(env,7,'+6591234567','m1','Singapore To Trichy','text',{},async()=>{});
  assert.equal(again.superseded,true);

  // A later, separate message is answered on its own.
  const later=await engineCoalesceBurst(env,7,'+6591234567','m3','1 adult','text',{},async()=>{});
  assert.deepEqual(later,{text:'1 adult',coalesced:false});

  // Other customers are never mixed in; media and the off switch skip coalescing entirely.
  const other=await engineCoalesceBurst(env,7,'+6599999999','x1','hi','text',{},async()=>{});
  assert.equal(other.coalesced,false);
  assert.deepEqual(await engineCoalesceBurst(env,7,'+6591234567','m4','','image',{},async()=>{throw new Error('no wait');}),{text:'',coalesced:false});
  assert.deepEqual(await engineCoalesceBurst(env,7,'+6591234567','m5','hi','text',{burst_wait_ms:0},async()=>{throw new Error('no wait');}),{text:'hi',coalesced:false});
});

test('burst coalescing fails open when D1 errors',async()=>{
  const env={DB:{prepare(){throw new Error('d1 down');}}};
  assert.deepEqual(await engineCoalesceBurst(env,7,'+1','m1','hello','text',{},async()=>{}),{text:'hello',coalesced:false});
});
