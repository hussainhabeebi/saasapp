import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import worker,{FollowupV3Scheduler} from './worker.js';

function state(){
  const data=new Map();let alarm=null;
  return {storage:{get:async k=>data.get(k),put:async(k,v)=>data.set(k,v),getAlarm:async()=>alarm,setAlarm:async v=>{alarm=v;},deleteAlarm:async()=>{alarm=null;}}};
}
test('durable scheduler persists tenant identity and never postpones an earlier alarm',async()=>{
  const s=state(),do1=new FollowupV3Scheduler(s,{});
  const req=cid=>new Request('https://internal/schedule',{method:'POST',body:JSON.stringify({cid})});
  assert.equal((await do1.fetch(req(42))).status,200);
  const alarm=await s.storage.getAlarm();assert.ok(alarm>Date.now());
  const restarted=new FollowupV3Scheduler(s,{});
  assert.equal((await restarted.fetch(req(42))).status,200);assert.equal(await s.storage.getAlarm(),alarm);
  assert.equal((await restarted.fetch(req(43))).status,403);
  assert.equal((await restarted.fetch(req(-1))).status,400);
});
test('delivery webhook rejects unsigned or invalidly signed payloads before storage writes',async()=>{
  for(const signature of [null,'sha256=bad']){
    const headers={'Content-Type':'application/json'};if(signature) headers['x-hub-signature-256']=signature;
    const response=await worker.fetch(new Request('https://worker/followups/meta-status',{method:'POST',headers,body:'{}'}),{META_APP_SECRET:'test'},{});
    assert.equal(response.status,403);
  }
});
test('delivery verification challenge requires configured matching token',async()=>{
  const url='https://worker/followups/meta-status?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=123';
  assert.equal((await worker.fetch(new Request(url),{},{})).status,403);
  const good=await worker.fetch(new Request(url),{META_FOLLOWUP_VERIFY_TOKEN:'verify'},{});
  assert.equal(good.status,200);assert.equal(await good.text(),'123');
});
test('a valid delivery signature still reports unavailable storage instead of acknowledging lost events',async()=>{
  const body=JSON.stringify({entry:[]});
  const signature='sha256='+createHmac('sha256','test').update(body).digest('hex');
  const response=await worker.fetch(new Request('https://worker/followups/meta-status',{method:'POST',headers:{'x-hub-signature-256':signature},body}),{META_APP_SECRET:'test'},{});
  assert.equal(response.status,500);
});
