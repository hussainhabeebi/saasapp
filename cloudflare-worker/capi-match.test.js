// Conversions API match keys (Reports → 💸 Ads ROI → Results sent to Meta): an Instant Form lead
// goes back with its own lead id, a click-to-WhatsApp lead with its ctwa_clid, anything else with
// hashed phone/email; Purchase carries the deal value; each stage reaches Meta once per lead; the
// bot's own turns report the ad click (Lead) and a Hot score (QualifiedLead).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { metaCapiBuildEvent, engineReportCapiFromTurn } from './worker.js';

const c={Id:7, meta_pixel_id:'PIX', meta_capi_token:'TOK', waba_id:'WABA1', deal_currency:'aed'};

describe('event builder', ()=>{
  test('Instant Form lead: system_generated with the form lead id, CRM source', ()=>{
    const {event, matchKey}=metaCapiBuildEvent(c, 'qualified', {Id:5, MetaLeadgenId:'1234567890123456789'}, {}, {ph:'h'});
    assert.equal(matchKey, 'lead_id');
    assert.equal(event.action_source, 'system_generated');
    assert.equal(event.user_data.lead_id, '1234567890123456789');
    assert.deepEqual(event.custom_data, {event_source:'crm', lead_event_source:'LeadVyne'});
    assert.equal(event.event_name, 'QualifiedLead');
  });
  test('click-to-WhatsApp lead: business_messaging with ctwa_clid and the WABA id', ()=>{
    const {event, matchKey}=metaCapiBuildEvent(c, 'lead', {Id:5, CtwaClid:'ARAk'}, {}, {});
    assert.equal(matchKey, 'ctwa_clid');
    assert.deepEqual([event.action_source, event.messaging_channel], ['business_messaging', 'whatsapp']);
    assert.deepEqual(event.user_data, {ctwa_clid:'ARAk', whatsapp_business_account_id:'WABA1'});
    assert.equal(event.event_id, 'lead_5_lead');
  });
  test('no click id: hashed phone/email only, and an error when there is neither', ()=>{
    assert.equal(metaCapiBuildEvent(c, 'lead', {Id:5}, {}, {ph:'h'}).matchKey, 'hashed');
    assert.match(metaCapiBuildEvent(c, 'lead', {Id:5}, {}, {}).error, /no email or phone/);
  });
  test('Purchase always carries value + currency (the account deal currency by default)', ()=>{
    assert.deepEqual(metaCapiBuildEvent(c, 'purchase', {Id:5, CtwaClid:'x'}, {value:'25000'}, {}).event.custom_data, {value:25000, currency:'AED'});
    assert.deepEqual(metaCapiBuildEvent(c, 'purchase', {Id:5, CtwaClid:'x'}, {}, {}).event.custom_data, {value:0, currency:'AED'});
    assert.equal(metaCapiBuildEvent(c, 'purchase', {Id:5, CtwaClid:'x'}).event.event_name, 'Purchase');
  });
});

describe('sending from a bot turn', ()=>{
  let db, env, origFetch, posts;
  function d1(db){
    const mk=(sql)=>{ let args=[]; const st={ bind(...a){ args=a; return st; },
      async run(){ const r=db.prepare(sql).run(...args); return {meta:{changes:Number(r.changes), last_row_id:Number(r.lastInsertRowid)}}; },
      async all(){ return {results:db.prepare(sql).all(...args)}; }, async first(){ return db.prepare(sql).get(...args)||null; } }; return st; };
    return {prepare:mk, async batch(list){ const out=[]; for(const st of list) out.push(await st.run()); return out; }};
  }
  beforeEach(()=>{
    db=new DatabaseSync(':memory:');
    for(const f of ['0003_meta_capi_log.sql','0118_meta_ads_report.sql']) db.exec(readFileSync(new URL('./migrations/'+f, import.meta.url), 'utf8'));
    env={DB:d1(db)}; posts=[];
    origFetch=globalThis.fetch;
    globalThis.fetch=async (url, init={})=>{ posts.push({url:String(url), body:JSON.parse(init.body)}); return new Response('{"events_received":1}'); };
  });
  afterEach(()=>{ globalThis.fetch=origFetch; db.close(); });

  test('an ad click sends Lead, a Hot score sends QualifiedLead — each once per lead, logged with its match key', async ()=>{
    const state={phone:'919876543210', adSource:{Source:'Click-to-WhatsApp ad', AdId:'120200001', CtwaClid:'ARAk'}, lead:{Score:'Warm'}};
    const r=await engineReportCapiFromTurn(env, c, 41, state, {Score:'Hot'});
    assert.deepEqual(r.map(([k, res])=>[k, res.ok, res.matchKey]), [['lead', true, 'ctwa_clid'], ['qualified', true, 'ctwa_clid']]);
    assert.deepEqual(posts.map(p=>p.body.data[0].event_name), ['Lead', 'QualifiedLead']);
    assert.match(posts[0].url, /\/PIX\/events\?access_token=TOK$/);
    // Same turn replayed (webhook redelivery): nothing sent again.
    const again=await engineReportCapiFromTurn(env, c, 41, state, {Score:'Hot'});
    assert.ok(again.every(([, res])=>res.duplicate));
    assert.equal(posts.length, 2);
    assert.deepEqual(db.prepare('SELECT event, match_key FROM meta_capi_events ORDER BY id').all().map(r=>[r.event, r.match_key]), [['lead', 'ctwa_clid'], ['qualified', 'ctwa_clid']]);
  });
  test('no Pixel/Dataset connected, or a turn with nothing new: nothing sent', async ()=>{
    assert.deepEqual(await engineReportCapiFromTurn(env, {Id:7}, 41, {adSource:{CtwaClid:'x'}}, {}), []);
    assert.deepEqual(await engineReportCapiFromTurn(env, c, 41, {lead:{Score:'Hot'}}, {Score:'Hot'}), []);
    assert.equal(posts.length, 0);
  });
});
