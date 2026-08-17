// Regression tests for the fixes made across the "message repetition" / quick-reply-buttons
// session (see ../FIXES.md for the full log). Most of these cover pure, synchronous logic with
// zero network access; a few mock `fetch` to test the Chatwoot-send functions' return values
// without a live worker or real credentials. Run with `npm test` from this directory, or
// `node --test`.
//
// Before editing any function tested here, read its entry in ../FIXES.md — these tests encode
// real, previously-observed production failures, not hypothetical edge cases.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  engineTruncateButtonTitle,
  engineTextSimilarity,
  engineQualQuestionText,
  engineQualQuestionOptional,
  engineQualQuestionOptions,
  engineExtractReplyOptions,
  engineHandoverCannedTexts,
  engineRouteFlow,
  engineSendChatwootReply,
  engineBuildFaqSystemPrompt,
  engineExtractPlainOptionsFromReply,
  hcNormalizeText,
  hcQueryTokens,
  hcServiceChoiceItems,
  hcVerifiedServiceText,
  hcEmergencyMatch,
  hcEnsureOperationsSchema,
  hcAppointmentUtcMs,
  hcHandleQueueBatch,
  HealthcareAppointmentWorkflow,
  pmEnsureAutomationSchema,
  pmTaskDueUtcMs,
  pmHandleQueueBatch,
  ProjectTaskWorkflow,
  engineParseInstagramEvents,
  engineSendInstagramReply,
  subscribeInstagramWebhooks,
  verifyWebhookSignature,
  ecomIsGeneralBusinessInfoQuery,
  ecomMatchProductCategory,
  ecomAvailableCatalogueItems,
} from './worker.js';

describe('Ecom category button and minimal matching', () => {
  const categories=['Mattress','Wooden Bed','Sofa Sets'];

  test('resolves an exact database category regardless of case or punctuation', () => {
    assert.equal(ecomMatchProductCategory('  MATTRESS! ',categories),'Mattress');
    assert.equal(ecomMatchProductCategory('Wooden bed',categories),'Wooden Bed');
  });

  test('accepts a unique minimal word but never guesses an ambiguous category', () => {
    assert.equal(ecomMatchProductCategory('sofa',['Premium Sofa Sets','Mattress']),'Premium Sofa Sets');
    assert.equal(ecomMatchProductCategory('bed',['Wooden Bed','Bed Linen']),null);
  });

  test('does not downgrade a product-like multiword phrase into category browsing', () => {
    assert.equal(ecomMatchProductCategory('Cloudnine Mattress Deluxe',categories),null);
  });
});

describe('Ecom verified fallback catalogue menu', () => {
  test('combines exact categories and active Product rows in one ten-option menu', () => {
    const categories=['Mattress','Furniture','Bedding','Pillows','Beds','Sofas','Chairs','Tables'];
    const products=[
      {Id:1,name:'Cloudnine Ortho Mattress',short_label:'Ortho Mattress'},
      {Id:2,name:'Teak Wooden Cot'},
      {Id:3,name:'Three Seater Sofa'},
      {Id:4,name:'Recliner Chair'},
    ];
    const items=ecomAvailableCatalogueItems(categories,products);
    assert.equal(items.length,10);
    assert.deepEqual(items.slice(-3),[
      {title:'Ortho Mattress',value:'Cloudnine Ortho Mattress'},
      {title:'Teak Wooden Cot',value:'Teak Wooden Cot'},
      {title:'Three Seater Sofa',value:'Three Seater Sofa'},
    ]);
  });

  test('uses only product records when categories are not configured', () => {
    assert.deepEqual(ecomAvailableCatalogueItems([], [{Id:1,name:'Verified Product'}]),[
      {title:'Verified Product',value:'Verified Product'},
    ]);
  });
});

describe('Ecom general business information routing', () => {
  test('recognizes generic ad CTA and business-introduction questions', () => {
    assert.equal(ecomIsGeneralBusinessInfoQuery('Hello! Can I get more info on this?'),true);
    assert.equal(ecomIsGeneralBusinessInfoQuery('Tell me more about your business'),true);
    assert.equal(ecomIsGeneralBusinessInfoQuery('What does your company do?'),true);
  });

  test('never diverts explicit product enquiries from verified Products data', () => {
    assert.equal(ecomIsGeneralBusinessInfoQuery('Can I get more info on this product?'),false);
    assert.equal(ecomIsGeneralBusinessInfoQuery('Can I get price and stock for this sofa?'),false);
    assert.equal(ecomIsGeneralBusinessInfoQuery('I want to order SKU SOFA-3'),false);
  });
});

describe('Instagram messaging reliability', () => {
  test('parses every actionable event in a webhook batch and ignores echoes', () => {
    const events=engineParseInstagramEvents({id:'business-1',messaging:[
      {sender:{id:'customer-1'},recipient:{id:'business-1'},message:{mid:'m1',text:'Hello'}},
      {sender:{id:'business-1'},recipient:{id:'customer-1'},message:{mid:'m2',text:'echo',is_echo:true}},
      {sender:{id:'customer-1'},recipient:{id:'business-1'},postback:{mid:'m3',title:'Book now',payload:'BOOK'}},
    ]});
    assert.deepEqual(events.map(e=>[e.mid,e.text,e.recipientId]),[['m1','Hello','business-1'],['m3','Book now','business-1']]);
  });

  test('preserves image, voice and story-reply content for the Chats timeline', () => {
    const events=engineParseInstagramEvents({id:'business-1',messaging:[
      {sender:{id:'c1'},message:{mid:'i1',attachments:[{type:'image',payload:{url:'https://cdn.example/image.jpg'}}]}},
      {sender:{id:'c1'},message:{mid:'a1',attachments:[{type:'audio',payload:{url:'https://cdn.example/audio.mp4'}}]}},
      {sender:{id:'c1'},message:{mid:'s1',text:'How much?',reply_to:{story:{url:'https://cdn.example/story.jpg'}}}},
    ]});
    assert.equal(events[0].userMedia.url,'https://cdn.example/image.jpg');
    assert.equal(events[1].userAttachment.kind,'voice');
    assert.equal(events[2].text,'How much?');
    assert.equal(events[2].mediaUrl,'https://cdn.example/story.jpg');
  });

  test('validates Meta webhook signatures with the Instagram app secret', async () => {
    const secret='instagram-secret', body='{"object":"instagram"}';
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const bytes=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(body)));
    const signature='sha256='+[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');
    assert.equal(await verifyWebhookSignature(secret,body,signature),true);
    const wrong=signature.slice(0,7)+(signature[7]==='0'?'1':'0')+signature.slice(8);
    assert.equal(await verifyWebhookSignature(secret,body,wrong),false);
  });

  test('subscribes connected accounts to the required messaging webhook fields', async t => {
    let captured;
    t.mock.method(global,'fetch',async (url,opts)=>{ captured={url,opts}; return new Response('{"success":true}',{status:200}); });
    await subscribeInstagramWebhooks('1789','token');
    assert.match(captured.url,/\/v24\.0\/1789\/subscribed_apps$/);
    const body=new URLSearchParams(captured.opts.body);
    assert.ok(body.get('subscribed_fields').split(',').includes('messages'));
    assert.equal(captured.opts.headers.Authorization,'Bearer token');
  });

  test('reports Graph API rejection as non-delivery', async t => {
    t.mock.method(global,'fetch',async ()=>new Response('{"error":{"message":"expired token"}}',{status:400,headers:{'Content-Type':'application/json'}}));
    assert.equal(await engineSendInstagramReply({}, {ig_id:'business-1',ig_access_token:'bad'}, 'customer-1', 'Hi'),false);
  });
});

describe('Healthcare verified-data routing', () => {
  test('normalizes natural patient wording without losing Unicode text', () => {
    assert.equal(hcNormalizeText('  Root-Canal / RCT!  '), 'root canal rct');
    assert.equal(hcNormalizeText('ദന്ത ചികിത്സ'), 'ദന്ത ചികിത്സ');
  });

  test('choice labels and values come only from saved Service records', () => {
    const rows=[
      {id:1,name:'Root Canal Treatment',short_label:'Root Canal'},
      {id:2,name:'Dental Cleaning',short_label:''},
      {id:3,name:'Root Canal Treatment',short_label:'Duplicate'},
    ];
    assert.deepEqual(hcServiceChoiceItems(rows), [
      {title:'Root Canal',value:'Root Canal Treatment'},
      {title:'Dental Cleaning',value:'Dental Cleaning'},
    ]);
  });

  test('verified service reply never invents absent price, duration, preparation or link', () => {
    const text=hcVerifiedServiceText({name:'Dental Checkup',description:'A routine dental examination.',price:0,duration_minutes:0,preparation:'',booking_url:''}, 'how much and how long?');
    assert.equal(text, '*Dental Checkup*\n\nA routine dental examination.');
  });

  test('emergency matcher catches configured phrases but respects simple negation', () => {
    const settings={emergency_keywords:'chest pain,severe bleeding'};
    assert.equal(hcEmergencyMatch(settings,'I have severe chest pain'), 'chest pain');
    assert.equal(hcEmergencyMatch(settings,'I have no chest pain'), null);
  });

  test('generic words are removed before service matching', () => {
    assert.deepEqual(hcQueryTokens('Please book a doctor appointment for root canal'), ['root','canal']);
  });

  test('repairs a missing Healthcare schema once per D1 binding', async () => {
    const statements=[];
    const DB={prepare(sql){statements.push(sql);return {async run(){return {success:true};}};}};
    await hcEnsureOperationsSchema({DB});
    await hcEnsureOperationsSchema({DB});
    for(const table of ['departments','doctors','services','doctor_schedules','appointments','insurance','settings','media_sent','automation_settings','appointment_automation','appointment_notifications','queue_failures']){
      assert.equal(statements.filter(sql=>sql.includes(`CREATE TABLE IF NOT EXISTS healthcare_${table}`)).length,1,table);
    }
    assert.equal(statements.filter(sql=>sql.includes('idx_healthcare_insurance_client')).length,1);
  });

  test('converts a clinic wall-clock appointment to the correct UTC instant', () => {
    assert.equal(new Date(hcAppointmentUtcMs('2026-08-17','12:30','Asia/Dubai')).toISOString(),'2026-08-17T08:30:00.000Z');
  });

  test('appointment Workflow queues confirmation, 24-hour and 2-hour reminders', async () => {
    const jobs=[], sleeps=[], dbUpdates=[];
    const DB={prepare(sql){return {bind(...values){dbUpdates.push({sql,values});return this;},async run(){return {success:true};}};}};
    const workflow=new HealthcareAppointmentWorkflow({}, {DB,HEALTHCARE_JOBS:{async send(job){jobs.push(job);}}});
    const started=Date.parse('2026-08-17T00:00:00.000Z'), appointment=started+26*3600000;
    const step={
      async do(name,...args){return args.at(-1)();},
      async sleepUntil(name,when){sleeps.push({name,when:when.toISOString()});}
    };
    const result=await workflow.run({payload:{client_id:7,appointment_id:9,appointment_version:'v1',appointment_at_ms:appointment,workflow_started_at_ms:started,reminder_24h_enabled:true,reminder_2h_enabled:true}},step);
    assert.deepEqual(jobs.map(x=>x.kind),['confirmation','reminder_24h','reminder_2h']);
    assert.equal(dbUpdates.length,1);
    assert.match(dbUpdates[0].sql,/workflow_status='complete'/);
    assert.deepEqual(sleeps.map(x=>x.when),['2026-08-17T02:00:00.000Z','2026-08-18T00:00:00.000Z']);
    assert.deepEqual(result,{appointment_id:9,status:'reminders_queued'});
  });

  test('Queue failures retry exponentially and DLQ messages are durably recorded', async () => {
    const statements=[];
    const DB={prepare(sql){statements.push(sql);return {bind(){return this;},async run(){return {success:true};},async first(){return null;}};}};
    const failed={body:{type:'invalid_test_job',client_id:7,appointment_id:9,appointment_version:'v1'},attempts:2,acked:false,retried:null,ack(){this.acked=true;},retry(options){this.retried=options;}};
    await hcHandleQueueBatch({queue:'leadvyne-healthcare-jobs',messages:[failed]},{DB});
    assert.equal(failed.acked,false);
    assert.deepEqual(failed.retried,{delaySeconds:120});

    const dead={body:{type:'appointment_message',client_id:7,appointment_id:9,appointment_version:'v1'},attempts:6,acked:false,ack(){this.acked=true;},retry(){throw new Error('DLQ record should not retry after a successful insert');}};
    await hcHandleQueueBatch({queue:'leadvyne-healthcare-jobs-dlq',messages:[dead]},{DB});
    assert.equal(dead.acked,true);
    assert.ok(statements.some(sql=>sql.includes('INSERT INTO healthcare_queue_failures')));
  });
});

describe('Project Queues and Workflows', () => {
  test('repairs Project automation tables and settings columns once per D1 binding', async () => {
    const statements=[];
    const DB={prepare(sql){
      statements.push(sql);
      return {async all(){ return sql.includes('PRAGMA table_info')?{results:[{name:'id'}]}:{results:[]}; },async run(){return {success:true};}};
    }};
    await pmEnsureAutomationSchema({DB});
    await pmEnsureAutomationSchema({DB});
    assert.equal(statements.filter(sql=>sql.includes('ADD COLUMN task_reminders_enabled')).length,1);
    assert.equal(statements.filter(sql=>sql.includes('ADD COLUMN overdue_escalation_enabled')).length,1);
    for(const table of ['task_automation','task_notifications','queue_failures']){
      assert.equal(statements.filter(sql=>sql.includes(`CREATE TABLE IF NOT EXISTS pm_${table}`)).length,1,table);
    }
  });

  test('converts the task due-day 9 AM in the account timezone to UTC', () => {
    assert.equal(new Date(pmTaskDueUtcMs('2026-08-20','Asia/Dubai')).toISOString(),'2026-08-20T05:00:00.000Z');
    assert.equal(new Date(pmTaskDueUtcMs('2026-08-20','Asia/Dubai',1)).toISOString(),'2026-08-21T05:00:00.000Z');
  });

  test('task Workflow queues 48-hour, due-day and overdue notifications', async () => {
    const sent=[],sleeps=[],updates=[];
    const env={
      PROJECT_JOBS:{async send(job){sent.push(job);}},
      DB:{prepare(sql){return {bind(...values){updates.push({sql,values});return this;},async run(){return {success:true};}};}}
    };
    const workflow=new ProjectTaskWorkflow({},env);
    const start=Date.parse('2026-08-17T00:00:00Z'),due=Date.parse('2026-08-20T05:00:00Z');
    const step={async sleepUntil(name,date){sleeps.push({name,date:date.toISOString()});},async do(name,options,fn){return fn();}};
    const result=await workflow.run({payload:{client_id:7,task_id:11,task_version:'v1',due_at_ms:due,overdue_at_ms:due+86400000,workflow_started_at_ms:start,reminders_enabled:true,overdue_enabled:true}},step);
    assert.deepEqual(sent.map(x=>x.kind),['reminder_48h','due_today','overdue']);
    assert.equal(sleeps.length,3);
    assert.equal(updates.length,1);
    assert.deepEqual(result,{task_id:11,status:'reminders_queued'});
  });

  test('Project Queue retries failures exponentially and records DLQ messages', async () => {
    const statements=[];
    const DB={prepare(sql){
      statements.push(sql);
      return {bind(){return this;},async all(){return sql.includes('PRAGMA table_info')?{results:[{name:'task_reminders_enabled'},{name:'overdue_escalation_enabled'}]}:{results:[]};},async first(){return null;},async run(){return {success:true,meta:{changes:1}};}};
    }};
    let delay=0,retried=false,acked=false;
    await pmHandleQueueBatch({queue:'leadvyne-project-jobs',messages:[{body:{type:'unknown',client_id:1,project_id:2,task_id:3,task_version:'v1'},attempts:3,ack(){acked=true;},retry(o){retried=true;delay=o.delaySeconds;}}]},{DB});
    assert.equal(acked,false); assert.equal(retried,true); assert.equal(delay,240);
    await pmHandleQueueBatch({queue:'leadvyne-project-jobs-dlq',messages:[{body:{type:'pm_notification',client_id:1,project_id:2,task_id:3},attempts:6,ack(){acked=true;},retry(){}}]},{DB});
    assert.equal(acked,true);
    assert.ok(statements.some(sql=>sql.includes('INSERT INTO pm_queue_failures')));
  });
});

describe('engineTruncateButtonTitle — WhatsApp title-length safety (FIXES.md #5)', () => {
  test('leaves a short title untouched', () => {
    assert.equal(engineTruncateButtonTitle('Mattress', 24), 'Mattress');
  });

  test('truncates a long title at a word boundary with an ellipsis', () => {
    const out = engineTruncateButtonTitle('Semi Medicated Orthopedic Mattress', 24);
    assert.ok(out.length <= 24, `expected <=24 chars, got ${out.length}: "${out}"`);
    assert.ok(out.endsWith('…'));
    assert.ok(!out.includes('  '), 'should not leave a double space before the ellipsis');
  });

  test('never exceeds the cap even with no good word boundary', () => {
    const out = engineTruncateButtonTitle('Supercalifragilisticexpialidocious', 20);
    assert.ok(out.length <= 20, `expected <=20 chars, got ${out.length}: "${out}"`);
    assert.ok(out.endsWith('…'));
  });
});

describe('engineTextSimilarity — near-duplicate loop detection (FIXES.md #13)', () => {
  test('identical text scores 1', () => {
    assert.equal(engineTextSimilarity('hello there', 'hello there'), 1);
  });

  test('the exact Wellness Virtue near-duplicate case scores above the 0.7 loop threshold', () => {
    const a = 'For general health and wellness, our Glutathione Tablets are an excellent choice! They offer antioxidant support, immunity support, and detox benefits. Would you like to know more about them?';
    const b = 'For general health, our Glutathione Tablets are an excellent choice! They offer antioxidant support, immunity support, and detox benefits. Would you like to know more about them?';
    assert.ok(engineTextSimilarity(a, b) >= 0.7, 'reworded near-duplicate replies must be caught by the loop detector');
  });

  test('genuinely different replies stay below the loop threshold', () => {
    const a = 'Our delivery takes 3-5 business days within Kerala.';
    const b = 'Our Glutathione Tablets support immunity and detox benefits.';
    assert.ok(engineTextSimilarity(a, b) < 0.7, 'unrelated replies must not false-positive as a loop');
  });

  test('short unrelated replies do not false-positive on shared function words', () => {
    assert.ok(engineTextSimilarity('Do you need help?', 'Do you want more?') < 0.7);
  });
});

describe('engineQualQuestion* — qual_questions options shape (FIXES.md #8)', () => {
  test('reads a legacy plain-string entry as required, no options', () => {
    const q = 'What is your budget?';
    assert.equal(engineQualQuestionText(q), 'What is your budget?');
    assert.equal(engineQualQuestionOptional(q), false);
    assert.deepEqual(engineQualQuestionOptions(q), []);
  });

  test('reads the new {text, optional, options} shape, trimming/dropping blanks', () => {
    const q = { text: 'Do you need a mattress, a wooden bed, or something else?', optional: false, options: ['Mattress', ' Wooden bed ', '', 'Something else'] };
    assert.equal(engineQualQuestionText(q), 'Do you need a mattress, a wooden bed, or something else?');
    assert.deepEqual(engineQualQuestionOptions(q), ['Mattress', 'Wooden bed', 'Something else']);
  });

  test('a malformed (non-array) options field never reaches the send path', () => {
    assert.deepEqual(engineQualQuestionOptions({ text: 'x', options: 'not-an-array' }), []);
    assert.deepEqual(engineQualQuestionOptions({ text: 'x' }), []);
    assert.deepEqual(engineQualQuestionOptions(null), []);
  });
});

describe('engineExtractReplyOptions — the OPTIONS: marker parser', () => {
  test('splits and strips a trailing OPTIONS: line', () => {
    const { text, options } = engineExtractReplyOptions('Pick one!\nOPTIONS: Skincare | Wellness | Diet plan');
    assert.equal(text, 'Pick one!');
    assert.deepEqual(options, ['Skincare', 'Wellness', 'Diet plan']);
  });

  test('leaves ordinary replies untouched', () => {
    const { text, options } = engineExtractReplyOptions('We deliver within 3-5 days.');
    assert.equal(text, 'We deliver within 3-5 days.');
    assert.equal(options, null);
  });
});

describe('engineRouteFlow — anti-loop escalation (FIXES.md #1, #13, #14)', () => {
  const baseC = { bot_config: '{}', qual_questions: '[]', flow_json: '{}', industry: 'ecommerce' };
  const baseCls = { intent: 'QUESTION', sentiment: 'Neutral', objectionCategory: 'none', aiWinProbability: null, customerLanguage: null, nextStage: null, confidence: null, productInterest: '' };

  test('a real (non-canned-text) loop forces a human handover and reports loopDetected', () => {
    const state = { looping: true, botMsgs: ['Some AI-generated pitch, reworded each time.'], stage: 'new', qualAnswers: {}, leadOptOut: 'No' };
    const result = engineRouteFlow(baseC, state, 'yes', baseCls);
    assert.equal(result.route, 'human');
    assert.equal(result.loopDetected, true, 'engineRouteFlow must surface loopDetected for handleEngineWebhook to alert on');
  });

  test('a repeated handover confirmation is NOT treated as a stuck loop', () => {
    const cannedText = 'Sure 🙏 connecting you to our advisor now. Someone will be with you shortly.';
    const state = { looping: true, botMsgs: [cannedText], stage: 'human_handover', qualAnswers: {}, leadOptOut: 'No' };
    const result = engineRouteFlow(baseC, state, 'hi', baseCls);
    assert.equal(result.loopDetected, false, 'a correctly-repeated handover confirmation must not re-trigger the loop escalation');
  });

  test('antiloop_enabled=false opts a client out entirely', () => {
    const c = { ...baseC, bot_config: JSON.stringify({ antiloop_enabled: false }) };
    const state = { looping: true, botMsgs: ['Reworded pitch again.'], stage: 'new', qualAnswers: {}, leadOptOut: 'No' };
    const result = engineRouteFlow(c, state, 'yes', baseCls);
    assert.equal(result.loopDetected, false);
  });
});

describe('engineRouteFlow — qualifying-question choices carry through (FIXES.md #8)', () => {
  test('qualify_next surfaces the next question\'s configured options', () => {
    const c = {
      bot_config: '{}', flow_json: '{}', industry: 'ecommerce',
      qual_questions: JSON.stringify([
        { text: 'What is your name?', optional: false, options: [] },
        { text: 'Do you need a mattress, a wooden bed, or something else?', optional: false, options: ['Mattress', 'Wooden bed', 'Something else'] },
      ]),
    };
    const state = { looping: false, botMsgs: [], stage: 'qual_0', qualAnswers: {}, leadOptOut: 'No' };
    const cls = { ...baseClsFor(), intent: 'AFFIRMATIVE' };
    const result = engineRouteFlow(c, state, 'John', cls);
    assert.equal(result.route, 'qualify_next');
    assert.equal(result.next, 'qual_1');
    assert.deepEqual(result.qualNextOptions, ['Mattress', 'Wooden bed', 'Something else']);
  });
});

function baseClsFor() {
  return { intent: 'QUESTION', sentiment: 'Neutral', objectionCategory: 'none', aiWinProbability: null, customerLanguage: null, nextStage: null, confidence: null, productInterest: '' };
}

describe('engineSendChatwootReply — return value reflects actual delivery (FIXES.md #17)', () => {
  const c = { chatwoot_base: 'https://chatwoot.example', chatwoot_account_id: '1', chatwoot_token: 'tok' };
  // Minimal env: no env.DB / OPS_ALERT_* — logEngineSkip/reportOpsError both swallow their own
  // failures internally (see worker.js), so calling them against an incomplete env is safe and
  // exercises the same no-op path production takes when neither alert channel is configured.
  const env = {};

  test('returns true when Chatwoot accepts the send', async (t) => {
    t.mock.method(global, 'fetch', async () => new Response('{}', { status: 200 }));
    const ok = await engineSendChatwootReply(env, c, 'client1', 'conv1', 'hello');
    assert.equal(ok, true);
  });

  test('returns false — not just "didn\'t throw" — when Chatwoot rejects the send', async (t) => {
    t.mock.method(global, 'fetch', async () => new Response('server error', { status: 500 }));
    const ok = await engineSendChatwootReply(env, c, 'client1', 'conv1', 'hello');
    assert.equal(ok, false, 'a rejected Chatwoot send must not be reported as delivered — this is the exact gap that made Settings → Logs show "Replied" for a message the customer never received');
  });

  test('returns false when the request itself throws (network failure)', async (t) => {
    t.mock.method(global, 'fetch', async () => { throw new Error('network unreachable'); });
    const ok = await engineSendChatwootReply(env, c, 'client1', 'conv1', 'hello');
    assert.equal(ok, false);
  });

  test('returns false, not undefined, when there is nothing to send to', async () => {
    const ok = await engineSendChatwootReply(env, {}, 'client1', 'conv1', 'hello');
    assert.equal(ok, false, 'missing Chatwoot credentials must be reported as non-delivery, not silently ignored');
  });
});

describe('Button/list titles are pinned to English regardless of reply language (FIXES.md #19)', () => {
  // Real production failure: Chatwoot's own inbound WhatsApp webhook (Meta signature verification)
  // has been observed rejecting a customer's tap reply outright (401, never reaches this engine at
  // all) when its body contains non-ASCII UTF-8 bytes — Malayalam-language button taps specifically.
  // WhatsApp echoes a button's title back verbatim when tapped, so any code path that lets an
  // option/button label inherit the reply's own (non-English) language reintroduces this exact bug.

  test('the FAQ system prompt instructs the model to keep OPTIONS: labels in English even when replying in another language', () => {
    const c = { main_prompt: '', services: '[]', kb_summary: '' };
    const state = {};
    const sys = engineBuildFaqSystemPrompt(c, state, null, 'ecommerce', 'ml', false);
    assert.match(sys, /write each option itself in ENGLISH/i, 'must explicitly override "reply in the customer\'s language" for OPTIONS: labels');
    assert.doesNotMatch(sys, /write each option itself in the customer's language/i, 'the old instruction (translate options into replyLang) must not come back');
  });

  test('engineExtractPlainOptionsFromReply asks the LLM to translate extracted labels into English, not keep the reply\'s own language', async (t) => {
    let capturedSystemPrompt = null;
    t.mock.method(global, 'fetch', async (url, opts) => {
      capturedSystemPrompt = JSON.parse(opts.body).messages[0].content;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"options":["Mattress","Wooden bed"]}' } }] }), { status: 200 });
    });
    const c = { openrouter_key: 'test-key' };
    const options = await engineExtractPlainOptionsFromReply({}, c, 'നിങ്ങൾക്ക് ഒരു മെത്തയാണോ, മരം കൊണ്ടുള്ള കട്ടിലാണോ വേണ്ടത്?');
    assert.match(capturedSystemPrompt, /ALWAYS translated into English/i, 'must not let extracted option labels inherit the source reply\'s language');
    assert.doesNotMatch(capturedSystemPrompt, /keep it in the reply's own language/i, 'the old instruction must not come back');
    assert.deepEqual(options, ['Mattress', 'Wooden bed']);
  });
});
