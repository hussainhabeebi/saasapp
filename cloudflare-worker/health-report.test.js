import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHealthReport, healthRecurringIssues, healthCriticalAlerts, healthTotals, healthSummaryLine } from './health-report.js';

const r=(key,status,extra={})=>({key,label:key.toUpperCase(),category:'integration',status,detail:`${key} ${status}`,...extra});
const day=n=>new Date(Date.UTC(2026,10,n,2));

test('Totals, overall label and categories',()=>{
  const rep=buildHealthReport([r('a','ok'),r('b','warn',{category:'crm',hint:'Fix b'}),r('c','fail',{category:'database'}),r('d','off',{category:'core'})],{now:day(1),trigger:'daily'});
  assert.deepEqual(rep.totals,{total:4,passed:1,failed:1,warnings:1,not_tested:1});
  assert.equal(rep.status,'fail');
  assert.equal(rep.label,'Critical');
  assert.equal(rep.trigger,'daily');
  // Old category keys fold into the new groups ("core" → Automation).
  assert.deepEqual(rep.categories.map(c=>[c.key,c.status]),[['integration','ok'],['crm','warn'],['automation','off'],['database','fail']]);
  // Recommended actions: errors first, own hint when there is one, a default otherwise.
  assert.deepEqual(rep.recommendations.map(x=>[x.key,x.severity]),[['c','error'],['b','warning']]);
  assert.equal(rep.recommendations[1].action,'Fix b');
  assert.match(rep.recommendations[0].action,/run the health check again/);
  assert.equal(healthSummaryLine(rep),'Critical — 1 passed, 1 failed, 1 warning(s), 1 not tested');
  assert.equal(buildHealthReport([r('a','ok'),r('d','off')]).label,'Healthy');
  assert.equal(buildHealthReport([r('a','warn')]).label,'Needs Attention');
});

test('Comparison with history: new, recurring and fixed issues, streaks and last success',()=>{
  const r1=buildHealthReport([r('a','ok'),r('b','fail'),r('c','ok')],{now:day(1)});
  const r2=buildHealthReport([r('a','ok'),r('b','fail'),r('c','ok')],{now:day(2),previous:[r1]});
  const r3=buildHealthReport([r('a','ok'),r('b','fail'),r('c','warn')],{now:day(3),previous:[r1,r2]});
  const by=Object.fromEntries(r3.results.map(x=>[x.key,x]));
  assert.equal(by.b.change,'recurring');
  assert.equal(by.b.streak,3);
  assert.equal(by.b.last_ok_at,undefined,'never passed');
  assert.equal(by.c.change,'new');
  assert.equal(by.c.streak,1);
  assert.equal(by.c.last_ok_at,day(2).toISOString());
  assert.equal(by.a.last_ok_at,day(3).toISOString());
  assert.equal(r3.last_healthy_at,null);
  // Recurring errors come before new ones in the recommended actions.
  assert.deepEqual(r3.recommendations.map(x=>x.key),['b','c']);

  const r4=buildHealthReport([r('a','ok'),r('b','ok'),r('c','ok')],{now:day(4),previous:[r1,r2,r3]});
  assert.deepEqual(r4.fixed,[{key:'b',label:'B',was:'fail'},{key:'c',label:'C',was:'warn'}]);
  assert.equal(r4.last_healthy_at,day(4).toISOString());
  assert.equal(r4.previous_status,'fail');

  const rec=healthRecurringIssues([r1,r2,r3,r4]);
  assert.deepEqual(rec.map(x=>[x.key,x.count,x.errors,x.open]),[['b',3,3,false]]);
});

test('Critical alerts only for errors that are new since the last run',()=>{
  const r1=buildHealthReport([r('a','fail'),r('b','ok')],{now:day(1)});
  assert.deepEqual(healthCriticalAlerts(r1).map(x=>x.key),['a']);
  const r2=buildHealthReport([r('a','fail'),r('b','fail')],{now:day(2),previous:[r1]});
  assert.deepEqual(healthCriticalAlerts(r2).map(x=>x.key),['b'],'a is still broken — already alerted');
  const r3=buildHealthReport([r('a','warn')],{now:day(3),previous:[r2]});
  assert.deepEqual(healthCriticalAlerts(r3),[]);
});

test('Older client-row log entries (no label/totals) still compare',()=>{
  const legacy={ts:day(1).toISOString(),results:[r('whatsapp','fail',{category:'integration'}),r('recovery_engine','ok',{category:'core'})]};
  const rep=buildHealthReport([r('whatsapp','ok'),r('recovery_engine','ok',{category:'automation'})],{now:day(2),previous:[legacy]});
  assert.deepEqual(rep.fixed.map(x=>x.key),['whatsapp']);
  assert.deepEqual(healthTotals(rep.results),{total:2,passed:2,failed:0,warnings:0,not_tested:0});
});
