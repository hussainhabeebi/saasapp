// Monthly Marketing module (Campaigns → 📅 Monthly Marketing) — eligibility, planning and the
// duplicate guards. The guard tests run the real migration against node:sqlite through a tiny D1
// shim, so the partial unique indexes in migrations/0100_monthly_marketing.sql are what's tested,
// not a mock of them.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  monthlyMktSkipReason,
  monthlyMktIndexHistory,
  monthlyMktPlan,
  monthlyMktLocalParts,
  monthlyMktRuleDue,
  monthlyMktRuleEnabled,
  monthlyMktValidateRule,
  monthlyMktSendOne,
  runMonthlyMarketingForAllClients,
} from './worker.js';

const MONTH='2026-09';
const lead=(o={})=>({Id:1, Name:'Asha', Phone:'+91 98765 43210', Score:'Hot', Stage:'new', ...o});
const rule=(o={})=>({id:1, rule_type:'category', match_value:'Kerala Tours', frequency:'monthly', day_of_month:1, active:1,
  templates_json:JSON.stringify([{name:'tpl_a', language:'en', body_vars:1}, {name:'tpl_b', language:'en', body_vars:0}]), ...o});

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
  db.exec(readFileSync(new URL('./migrations/0100_monthly_marketing.sql', import.meta.url), 'utf8'));
  return db;
}

describe('monthlyMktSkipReason — who is eligible', ()=>{
  const empty=()=>monthlyMktIndexHistory([]);
  test('Hot and Warm leads are eligible', ()=>{
    assert.equal(monthlyMktSkipReason(lead({Score:'Hot'}), empty(), MONTH), null);
    assert.equal(monthlyMktSkipReason(lead({Score:'warm'}), empty(), MONTH), null);
  });
  test('Cold or unscored leads are skipped', ()=>{
    assert.equal(monthlyMktSkipReason(lead({Score:'Cold'}), empty(), MONTH), 'not_hot_or_warm');
    assert.equal(monthlyMktSkipReason(lead({Score:''}), empty(), MONTH), 'not_hot_or_warm');
  });
  test('won customers are skipped, lost leads are not', ()=>{
    assert.equal(monthlyMktSkipReason(lead({Stage:'won'}), empty(), MONTH), 'won');
    assert.equal(monthlyMktSkipReason(lead({Stage:'Converted'}), empty(), MONTH), 'won');
    assert.equal(monthlyMktSkipReason(lead({Stage:'lost'}), empty(), MONTH), null);
  });
  test('opted-out and phoneless leads are skipped', ()=>{
    assert.equal(monthlyMktSkipReason(lead({OptOut:'Yes'}), empty(), MONTH), 'opted_out');
    assert.equal(monthlyMktSkipReason(lead({Phone:''}), empty(), MONTH), 'no_phone');
  });
  test('no second message until the lead replies to the last one', ()=>{
    const hist=()=>monthlyMktIndexHistory([{lead_id:1, phone:'919876543210', template_name:'tpl_a', month_key:'2026-08', status:'sent', sent_at:'2026-08-01T10:00:00Z'}]);
    assert.equal(monthlyMktSkipReason(lead(), hist(), MONTH), 'awaiting_reply');
    assert.equal(monthlyMktSkipReason(lead({LastCustomerMsgAt:'2026-07-30T10:00:00Z'}), hist(), MONTH), 'awaiting_reply');
    assert.equal(monthlyMktSkipReason(lead({LastCustomerMsgAt:'2026-08-03T10:00:00Z'}), hist(), MONTH), null);
  });
  test('one message a month, also across two lead records sharing a phone', ()=>{
    const hist=monthlyMktIndexHistory([{lead_id:99, phone:'919876543210', template_name:'tpl_a', month_key:MONTH, status:'sent', sent_at:'2026-09-01T10:00:00Z'}]);
    assert.equal(monthlyMktSkipReason(lead({LastCustomerMsgAt:'2026-09-05T00:00:00Z'}), hist, MONTH), 'already_sent_this_month');
  });
  test('failed attempts do not count as sent, but stop after the monthly cap', ()=>{
    const failed=n=>Array.from({length:n}, ()=>({lead_id:1, phone:'919876543210', template_name:'tpl_a', month_key:MONTH, status:'failed', created_at:'2026-09-01T10:00:00Z'}));
    assert.equal(monthlyMktSkipReason(lead(), monthlyMktIndexHistory(failed(1)), MONTH), null);
    assert.equal(monthlyMktSkipReason(lead(), monthlyMktIndexHistory(failed(3)), MONTH), 'send_failed');
  });
});

describe('monthlyMktPlan', ()=>{
  test('category rule wins over tag rule — one message per lead', ()=>{
    const rules=[rule({id:2, rule_type:'tag', match_value:'VIP'}), rule({id:1})];
    const plan=monthlyMktPlan({rules, leads:[lead({ServiceCategory:'kerala tours', Tags:'VIP, Repeat'})], history:monthlyMktIndexHistory([]), monthKey:MONTH});
    assert.equal(plan.sends.length, 1);
    assert.equal(plan.sends[0].rule.id, 1);
    assert.equal(plan.sends[0].template.name, 'tpl_a');
  });
  test('tag rules match leads-panel tags', ()=>{
    const plan=monthlyMktPlan({rules:[rule({rule_type:'tag', match_value:'repeat'})], leads:[lead({Tags:'VIP, Repeat'}), lead({Id:2, Phone:'9999999999', Tags:'VIP'})], history:monthlyMktIndexHistory([]), monthKey:MONTH});
    assert.deepEqual(plan.sends.map(s=>s.lead.Id), [1]);
  });
  test('each lead gets the next template it has not received yet', ()=>{
    const history=monthlyMktIndexHistory([{lead_id:1, phone:'919876543210', template_name:'tpl_a', month_key:'2026-08', status:'sent', sent_at:'2026-08-01T10:00:00Z'}]);
    const plan=monthlyMktPlan({rules:[rule()], leads:[lead({ServiceCategory:'Kerala Tours', LastCustomerMsgAt:'2026-08-02T00:00:00Z'})], history, monthKey:MONTH});
    assert.equal(plan.sends[0].template.name, 'tpl_b');
  });
  test('falls through to the tag rule when the category rule has no unused template', ()=>{
    const history=monthlyMktIndexHistory(['tpl_a','tpl_b'].map((t,i)=>({lead_id:1, phone:'919876543210', template_name:t, month_key:`2026-0${6+i}`, status:'sent', sent_at:`2026-0${6+i}-01T10:00:00Z`})));
    const rules=[rule(), rule({id:2, rule_type:'tag', match_value:'VIP', templates_json:JSON.stringify([{name:'tpl_c'}])})];
    const l=lead({ServiceCategory:'Kerala Tours', Tags:'VIP', LastCustomerMsgAt:'2026-09-01T00:00:00Z'});
    const plan=monthlyMktPlan({rules, leads:[l], history, monthKey:MONTH});
    assert.equal(plan.sends[0].template.name, 'tpl_c');
    const none=monthlyMktPlan({rules:[rule()], leads:[l], history:monthlyMktIndexHistory(['tpl_a','tpl_b'].map((t,i)=>({lead_id:1, phone:'919876543210', template_name:t, month_key:`2026-0${6+i}`, status:'sent', sent_at:`2026-0${6+i}-01T10:00:00Z`}))), monthKey:MONTH});
    assert.equal(none.sends.length, 0);
    assert.equal(none.stats[1].skipped.all_templates_used, 1);
  });
  test('two lead records with the same phone are planned once', ()=>{
    const leads=[lead({ServiceCategory:'Kerala Tours'}), lead({Id:2, Phone:'919876543210', ServiceCategory:'Kerala Tours'})];
    const plan=monthlyMktPlan({rules:[rule()], leads, history:monthlyMktIndexHistory([]), monthKey:MONTH});
    assert.equal(plan.sends.length, 1);
    assert.equal(plan.stats[1].skipped.already_sent_this_month, 1);
  });
  test('limit caps sends but still counts every eligible lead', ()=>{
    const leads=[1,2,3].map(i=>lead({Id:i, Phone:'90000000'+i, ServiceCategory:'Kerala Tours'}));
    const plan=monthlyMktPlan({rules:[rule()], leads, history:monthlyMktIndexHistory([]), monthKey:MONTH, limit:2});
    assert.equal(plan.sends.length, 2);
    assert.equal(plan.truncated, true);
    assert.equal(plan.stats[1].eligible, 3);
  });
});

describe('rule settings', ()=>{
  test('a rule is only enabled with a frequency, a template and active on', ()=>{
    assert.equal(monthlyMktRuleEnabled(rule()), true);
    assert.equal(monthlyMktRuleEnabled(rule({frequency:null})), false);
    assert.equal(monthlyMktRuleEnabled(rule({templates_json:'[]'})), false);
    assert.equal(monthlyMktRuleEnabled(rule({active:0})), false);
  });
  test('turning a rule on without frequency or template is rejected', ()=>{
    assert.match(monthlyMktValidateRule({rule_type:'tag', match_value:'VIP', active:true, templates:[{name:'a'}]}).error, /frequency/);
    assert.match(monthlyMktValidateRule({rule_type:'tag', match_value:'VIP', active:true, frequency:'monthly', templates:[]}).error, /template/);
    assert.equal(monthlyMktValidateRule({rule_type:'tag', match_value:'VIP'}).rule.active, 0);
    assert.equal(monthlyMktValidateRule({rule_type:'tag', match_value:' VIP ', active:true, frequency:'monthly', templates:[{name:'a'}]}).rule.match_key, 'vip');
  });
  test('due on/after day_of_month in the client timezone, clamped to the month end', ()=>{
    const local=monthlyMktLocalParts(new Date('2026-02-28T20:00:00Z'), 'Asia/Kolkata'); // 1 Mar 01:30 IST
    assert.equal(local.monthKey, '2026-03');
    assert.equal(monthlyMktRuleDue({day_of_month:1}, local), true);
    const feb=monthlyMktLocalParts(new Date('2026-02-28T10:00:00Z'), 'Asia/Kolkata');
    assert.equal(monthlyMktRuleDue({day_of_month:31}, feb), true);
    assert.equal(monthlyMktRuleDue({day_of_month:31}, {...feb, day:27}), false);
  });
});

describe('monthlyMktSendOne — database guards', ()=>{
  let db, env, calls, origFetch, reply;
  beforeEach(()=>{
    db=freshDb(); env={DB:d1(db)}; calls=[];
    reply=()=>new Response(JSON.stringify({messages:[{id:'wamid.1'}]}), {status:200});
    origFetch=globalThis.fetch;
    globalThis.fetch=async (url, init)=>{ calls.push({url, body:JSON.parse(init.body)}); return reply(); };
  });
  afterEach(()=>{ globalThis.fetch=origFetch; db.close(); });
  const creds={wa_phone_id:'123', wa_token:'tok'};
  const item=(o={})=>({rule:{id:1}, lead:lead(), phone:'919876543210', template:{name:'tpl_a', language:'en', body_vars:1}, ...o});

  test('sends a Graph API template with the name filled in', async ()=>{
    assert.equal(await monthlyMktSendOne(env, 7, creds, item(), MONTH), 'sent');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://graph.facebook.com/v18.0/123/messages');
    assert.equal(calls[0].body.template.name, 'tpl_a');
    assert.deepEqual(calls[0].body.template.components, [{type:'body', parameters:[{type:'text', text:'Asha'}]}]);
    const row=db.prepare('SELECT status, wa_message_id FROM monthly_marketing_sends').get();
    assert.equal(row.status, 'sent'); assert.equal(row.wa_message_id, 'wamid.1');
  });
  test('second send to the same lead in the same month is blocked without calling Meta', async ()=>{
    await monthlyMktSendOne(env, 7, creds, item(), MONTH);
    assert.equal(await monthlyMktSendOne(env, 7, creds, item({template:{name:'tpl_b', language:'en'}}), MONTH), 'duplicate');
    assert.equal(await monthlyMktSendOne(env, 7, creds, item({lead:lead({Id:2}), template:{name:'tpl_b', language:'en'}}), MONTH), 'duplicate');
    assert.equal(calls.length, 1);
  });
  test('the same template never goes to the same lead or phone again, even next month', async ()=>{
    await monthlyMktSendOne(env, 7, creds, item(), MONTH);
    assert.equal(await monthlyMktSendOne(env, 7, creds, item(), '2026-10'), 'duplicate');
    assert.equal(await monthlyMktSendOne(env, 7, creds, item({lead:lead({Id:2})}), '2026-10'), 'duplicate');
    assert.equal(await monthlyMktSendOne(env, 7, creds, item({template:{name:'tpl_b', language:'en'}}), '2026-10'), 'sent');
    assert.equal(calls.length, 2);
  });
  test('a Meta error frees the slot for a retry; a network error does not', async ()=>{
    reply=()=>new Response(JSON.stringify({error:{message:'Template paused'}}), {status:400});
    assert.equal(await monthlyMktSendOne(env, 7, creds, item(), MONTH), 'failed');
    reply=()=>new Response(JSON.stringify({messages:[{id:'wamid.2'}]}), {status:200});
    assert.equal(await monthlyMktSendOne(env, 7, creds, item(), MONTH), 'sent');

    globalThis.fetch=async ()=>{ throw new Error('socket hang up'); };
    assert.equal(await monthlyMktSendOne(env, 8, creds, item(), MONTH), 'unknown');
    globalThis.fetch=async ()=>{ calls.push('retry'); return reply(); };
    assert.equal(await monthlyMktSendOne(env, 8, creds, item(), MONTH), 'duplicate');
    assert.ok(!calls.includes('retry'));
  });
  test('guards are per client', async ()=>{
    await monthlyMktSendOne(env, 7, creds, item(), MONTH);
    assert.equal(await monthlyMktSendOne(env, 8, creds, item(), MONTH), 'sent');
  });
});

describe('runMonthlyMarketingForAllClients — cron path end to end', ()=>{
  let db, env, graphCalls, origFetch, leads;
  const client={Id:7, wa_phone_id:'123', waba_id:'456', wa_token:'tok', bot_config:JSON.stringify({followup_quiet_hours_enabled:false, timezone:'Asia/Kolkata'})};
  beforeEach(()=>{
    db=freshDb(); env={DB:d1(db), NOCODB_BASE:'https://noco.test', NOCODB_TOKEN:'x'}; graphCalls=[];
    leads=[
      lead({Id:1, ServiceCategory:'Kerala Tours'}),
      lead({Id:2, Phone:'9000000002', ServiceCategory:'Kerala Tours', Stage:'won'}),
      lead({Id:3, Phone:'9000000003', ServiceCategory:'Kerala Tours', Score:'Cold'}),
      lead({Id:4, Phone:'9000000004', ServiceCategory:'Kerala Tours', Score:'Warm', Stage:'lost'}),
      lead({Id:5, Phone:'9000000005', Tags:'VIP'}),
    ];
    origFetch=globalThis.fetch;
    globalThis.fetch=async (url, init={})=>{
      const u=String(url);
      if(u.startsWith('https://noco.test/api/v2/tables/') && u.includes('/records/7')) return new Response(JSON.stringify(client));
      if(u.startsWith('https://noco.test/api/v2/tables/')) return new Response(JSON.stringify({list:leads}));
      if(u.startsWith('https://graph.facebook.com/')){ graphCalls.push(JSON.parse(init.body)); return new Response(JSON.stringify({messages:[{id:'wamid.'+graphCalls.length}]})); }
      throw new Error('unexpected fetch '+u);
    };
    const now='2026-09-01T00:00:00Z';
    db.prepare(`INSERT INTO monthly_marketing_rules (client_id, rule_type, match_value, match_key, frequency, day_of_month, templates_json, active, created_at, updated_at) VALUES (7,'category','Kerala Tours','kerala tours','monthly',1,?,1,?,?)`)
      .run(JSON.stringify([{name:'tpl_a', language:'en', body_vars:1}, {name:'tpl_b', language:'en'}]), now, now);
    db.prepare(`INSERT INTO monthly_marketing_rules (client_id, rule_type, match_value, match_key, frequency, day_of_month, templates_json, active, created_at, updated_at) VALUES (7,'tag','VIP','vip',NULL,1,?,1,?,?)`)
      .run(JSON.stringify([{name:'tpl_vip', language:'en'}]), now, now);
  });
  afterEach(()=>{ globalThis.fetch=origFetch; db.close(); });

  test('sends once per eligible lead, skips won/cold and rules without a frequency, and never repeats', async ()=>{
    await runMonthlyMarketingForAllClients(env, new Date('2026-09-10T06:00:00Z'));
    assert.deepEqual(graphCalls.map(c=>c.to).sort(), ['9000000004', '919876543210']);
    assert.ok(graphCalls.every(c=>c.template.name==='tpl_a'));

    // Same month, even after the rescan interval — nothing new goes out.
    await runMonthlyMarketingForAllClients(env, new Date('2026-09-20T06:00:00Z'));
    assert.equal(graphCalls.length, 2);

    // Next month: lead 1 replied, lead 4 did not — only lead 1 gets the next template.
    // (send rows are stamped with the real clock, so the reply must come after that)
    leads[0].LastCustomerMsgAt=new Date(Date.now()+60_000).toISOString();
    await runMonthlyMarketingForAllClients(env, new Date('2026-10-02T06:00:00Z'));
    assert.equal(graphCalls.length, 3);
    assert.equal(graphCalls[2].to, '919876543210');
    assert.equal(graphCalls[2].template.name, 'tpl_b');
  });
  test('nothing is sent before the rule\'s day of month', async ()=>{
    db.prepare(`UPDATE monthly_marketing_rules SET day_of_month=15`).run();
    await runMonthlyMarketingForAllClients(env, new Date('2026-09-10T06:00:00Z'));
    assert.equal(graphCalls.length, 0);
  });
  test('a client with no enabled rule is never loaded', async ()=>{
    db.prepare(`UPDATE monthly_marketing_rules SET active=0`).run();
    globalThis.fetch=async ()=>{ throw new Error('should not fetch'); };
    await runMonthlyMarketingForAllClients(env, new Date('2026-09-10T06:00:00Z'));
  });
});
