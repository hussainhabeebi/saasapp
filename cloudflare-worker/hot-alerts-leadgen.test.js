// Hot-lead staff alerts (Settings → 👥 User Management → 🔥 Hot Lead Alerts) and Meta Lead Ads →
// instant WhatsApp (Integrations → 📋 Facebook & Instagram Lead Forms). Pure helpers, then both
// flows end to end against the real migrations (node:sqlite D1 shim, same as cold-realloc.test.js)
// with NocoDB and the Graph API stubbed.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  normalizeStaffWhatsapp,
  parseTeamWhatsapp,
  hotLeadAlertSettings,
  hotLeadAlertReason,
  hotLeadAlertRecipients,
  hotLeadAlertParams,
  hotLeadAlertLink,
  engineMaybeSendHotLeadAlert,
  metaLeadgenSettings,
  metaLeadgenParseFields,
  metaLeadgenTemplateParams,
  metaLeadgenRenderWelcome,
  processMetaLeadgenChange,
  safeClient,
} from './worker.js';

function d1(db){
  const mk=(sql)=>{
    let args=[];
    const st={
      bind(...a){ args=a; return st; },
      async run(){ const r=db.prepare(sql).run(...args); return {meta:{changes:Number(r.changes), last_row_id:Number(r.lastInsertRowid)}}; },
      async all(){ return {results:db.prepare(sql).all(...args)}; },
      async first(){ return db.prepare(sql).get(...args)||null; },
    };
    return st;
  };
  return {prepare:mk, async batch(list){ const out=[]; for(const st of list) out.push(await st.run()); return out; }};
}
function freshDb(){
  const db=new DatabaseSync(':memory:');
  for(const f of ['0076_lead_messages.sql','0101_lead_create_claims.sql','0107_hot_alerts_lead_forms.sql']){
    db.exec(readFileSync(new URL('./migrations/'+f, import.meta.url), 'utf8'));
  }
  return db;
}

const ON={enabled:true};
const client=(extra={})=>({
  Id:7, client_name:'Acme Tours', authentik_email:'Boss@x.com', team_emails:'a@x.com,b@x.com',
  wa_phone_id:'PHONE1', wa_token:'TOKEN', waba_id:'WABA1',
  team_whatsapp:JSON.stringify({'boss@x.com':'919000000001', 'A@x.com':'919000000002'}),
  hot_lead_alert_config:JSON.stringify({enabled:true, template_name:'hot_lead_alert_leadvyne', template_lang:'en'}),
  ...extra,
});

describe('helpers', ()=>{
  test('staff WhatsApp numbers normalise to country-code digits', ()=>{
    assert.equal(normalizeStaffWhatsapp('+91 98765 43210'), '919876543210');
    assert.equal(normalizeStaffWhatsapp('98765 43210'), '919876543210');
    assert.equal(normalizeStaffWhatsapp('098765 43210'), '919876543210');
    assert.equal(normalizeStaffWhatsapp('0044 7700 900123'), '447700900123');
    assert.equal(normalizeStaffWhatsapp('9876543210', '971'), '9719876543210');
    assert.equal(normalizeStaffWhatsapp('12345'), '');
    assert.equal(normalizeStaffWhatsapp(''), '');
    assert.deepEqual(parseTeamWhatsapp({team_whatsapp:'{"A@X.com":"+91 900","b@x.com":""}'}), {'a@x.com':'91900'});
    assert.deepEqual(parseTeamWhatsapp({team_whatsapp:'nope'}), {});
  });

  test('settings default off with sane cooldown', ()=>{
    const s=hotLeadAlertSettings({});
    assert.equal(s.enabled, false);
    assert.equal(s.cooldown_hours, 12);
    assert.equal(s.on_hot && s.on_hot_moment && s.on_lead_ad, true);
    assert.equal(hotLeadAlertSettings({hot_lead_alert_config:'{"cooldown_hours":999}'}).cooldown_hours, 168);
    assert.equal(hotLeadAlertSettings({hot_lead_alert_config:'{"cooldown_hours":0}'}).cooldown_hours, 12);
  });

  test('only a transition into hot fires', ()=>{
    const cfg=hotLeadAlertSettings({hot_lead_alert_config:JSON.stringify(ON)});
    assert.equal(hotLeadAlertReason({Score:'Warm'}, {Score:'Hot'}, cfg), 'hot');
    assert.equal(hotLeadAlertReason(null, {Score:'Hot'}, cfg), 'hot');
    assert.equal(hotLeadAlertReason({Score:'Hot'}, {Score:'Hot'}, cfg), null);
    assert.equal(hotLeadAlertReason({Score:'Cold'}, {Score:'Cold', HotMoment:'Yes'}, cfg), 'hot_moment');
    assert.equal(hotLeadAlertReason({Score:'Cold', HotMoment:'Yes'}, {Score:'Cold', HotMoment:'Yes'}, cfg), null);
    const noMoment=hotLeadAlertSettings({hot_lead_alert_config:JSON.stringify({...ON, on_hot_moment:false})});
    assert.equal(hotLeadAlertReason(null, {HotMoment:'Yes'}, noMoment), null);
  });

  test('recipients: owner first, account owner as fallback or copy', ()=>{
    const c=client();
    const cfg=hotLeadAlertSettings(c);
    assert.deepEqual(hotLeadAlertRecipients(c, 'A@x.com', cfg), [{email:'a@x.com', phone:'919000000002'}]);
    assert.deepEqual(hotLeadAlertRecipients(c, 'b@x.com', cfg), [{email:'boss@x.com', phone:'919000000001'}], 'owner has no number');
    assert.deepEqual(hotLeadAlertRecipients(c, '', cfg), [{email:'boss@x.com', phone:'919000000001'}], 'unowned lead');
    const both=hotLeadAlertSettings({hot_lead_alert_config:JSON.stringify({...ON, notify_owner_too:true})});
    assert.equal(hotLeadAlertRecipients(c, 'a@x.com', both).length, 2);
    assert.deepEqual(hotLeadAlertRecipients({authentik_email:'x@x.com'}, 'a@x.com', cfg), []);
  });

  test('template params are single-line, non-empty and link to the lead', ()=>{
    const link=hotLeadAlertLink({APP_BASE_URL:'https://app.test/dashboard.html'}, 42);
    assert.equal(link, 'https://app.test/dashboard.html?lead=42');
    assert.equal(hotLeadAlertLink({APP_BASE_URL:'https://app.test/d.html?client=1'}, 42), 'https://app.test/d.html?client=1&lead=42');
    const p=hotLeadAlertParams({name:'  Priya\n\nK ', phone:'919876543210', reason:'hot_moment', detail:'how much\tfor 2 nights?', link});
    assert.deepEqual(p, ['Priya K', '+919876543210', 'asked: "how much for 2 nights?"', link]);
    assert.deepEqual(hotLeadAlertParams({reason:'hot'}).slice(0,3), ['New lead', '-', 'is ready to book']);
  });

  test('lead form fields: name, phone, email and the rest as answers', ()=>{
    const r=metaLeadgenParseFields([
      {name:'full_name', values:['Priya Kumar']},
      {name:'phone_number', values:['+91 98765-43210']},
      {name:'email', values:['p@x.com']},
      {name:'which_package_are_you_interested_in?', values:['Goa 3N']},
      {name:'city', values:['Kochi']},
      {name:'empty', values:['']},
    ]);
    assert.equal(r.name, 'Priya Kumar');
    assert.equal(r.firstName, 'Priya');
    assert.equal(r.phone, '919876543210');
    assert.equal(r.email, 'p@x.com');
    assert.deepEqual(r.answers, {'Which package are you interested in':'Goa 3N', City:'Kochi'});
    const split=metaLeadgenParseFields([{name:'first_name', values:['Ann']}, {name:'last_name', values:['Lee']}, {name:'phone', values:['9876543210']}], '971');
    assert.equal(split.name, 'Ann Lee');
    assert.equal(split.phone, '9719876543210');
  });

  test('welcome template params and rendered text', ()=>{
    const params=metaLeadgenTemplateParams(['first_name','business_name'], {firstName:'Priya', businessName:'Acme Tours'});
    assert.deepEqual(params, ['Priya', 'Acme Tours']);
    assert.deepEqual(metaLeadgenTemplateParams(['first_name','business_name'], {}), ['there', 'our team']);
    assert.match(metaLeadgenRenderWelcome('lead_form_welcome_leadvyne', [], params), /^Hi Priya, thank you for your enquiry with Acme Tours\./);
    assert.equal(metaLeadgenRenderWelcome('custom_one', [], params), '[WhatsApp template: custom_one]');
    assert.deepEqual(metaLeadgenSettings({meta_leadgen_config:'{"params":["first_name","evil"]}'}).params, ['first_name']);
  });

  test('page token never reaches the browser', ()=>{
    const s=safeClient({Id:1, meta_leadgen_page_token:'SECRET', meta_leadgen_page_id:'55'});
    assert.equal('meta_leadgen_page_token' in s, false);
    assert.equal(s.meta_leadgen_connected, true);
  });
});

describe('engineMaybeSendHotLeadAlert', ()=>{
  let db, env, origFetch, sent;
  beforeEach(()=>{
    db=freshDb();
    env={DB:d1(db), NOCODB_BASE:'https://noco.test', NOCODB_TOKEN:'x', APP_BASE_URL:'https://app.test/dashboard.html'};
    sent=[];
    origFetch=globalThis.fetch;
    globalThis.fetch=async (url, init={})=>{
      url=String(url);
      if(url.includes('graph.facebook.com') && url.endsWith('/messages')){ sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({messages:[{id:'wamid.'+sent.length}]})); }
      return new Response('{}');
    };
  });
  afterEach(()=>{ globalThis.fetch=origFetch; db.close(); });

  test('sends the template to the lead owner once, then respects the cooldown', async ()=>{
    const c=client();
    const body={Name:'Priya', Phone:'919876543210', Score:'Hot', Owner:'a@x.com'};
    const res=await engineMaybeSendHotLeadAlert(env, c, 7, 42, {Score:'Warm'}, body);
    assert.equal(res.reason, 'hot');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, '919000000002');
    assert.equal(sent[0].type, 'template');
    assert.equal(sent[0].template.name, 'hot_lead_alert_leadvyne');
    assert.deepEqual(sent[0].template.components[0].parameters.map(p=>p.text),
      ['Priya', '+919876543210', 'is ready to book', 'https://app.test/dashboard.html?lead=42']);
    const again=await engineMaybeSendHotLeadAlert(env, c, 7, 42, {Score:'Cold'}, body);
    assert.deepEqual(again, {skipped:'cooldown'});
    assert.equal(sent.length, 1);
    const rows=db.prepare('SELECT status, recipient_email FROM hot_lead_alerts').all();
    assert.deepEqual(rows.map(r=>[r.status, r.recipient_email]), [['sent', 'a@x.com']]);
  });

  test('disabled, no transition, or no number: nothing is sent', async ()=>{
    const off=client({hot_lead_alert_config:'{}'});
    assert.equal(await engineMaybeSendHotLeadAlert(env, off, 7, 42, null, {Score:'Hot'}), null);
    assert.equal(await engineMaybeSendHotLeadAlert(env, client(), 7, 42, {Score:'Hot'}, {Score:'Hot'}), null);
    const noNumbers=client({team_whatsapp:'{}'});
    assert.deepEqual(await engineMaybeSendHotLeadAlert(env, noNumbers, 7, 43, null, {Score:'Hot'}), {skipped:'no-recipient'});
    assert.equal(sent.length, 0);
    assert.equal(db.prepare("SELECT status FROM hot_lead_alerts").get().status, 'skipped');
  });

  test('falls back to plain text when no template is set', async ()=>{
    const c=client({hot_lead_alert_config:JSON.stringify(ON)});
    await engineMaybeSendHotLeadAlert(env, c, 7, 44, null, {Name:'Ravi', Phone:'919111111111', HotMoment:'Yes', HotMomentText:'price?'});
    assert.equal(sent[0].type, 'text');
    assert.match(sent[0].text.body, /Ravi \(\+919111111111\) asked: "price\?"/);
  });

  test('a Graph API failure is logged, never thrown', async ()=>{
    globalThis.fetch=async ()=>new Response(JSON.stringify({error:{message:'Template not approved'}}), {status:400});
    const res=await engineMaybeSendHotLeadAlert(env, client(), 7, 45, null, {Score:'Hot', Owner:'a@x.com'});
    assert.equal(res.results[0].ok, false);
    assert.equal(db.prepare('SELECT detail FROM hot_lead_alerts').get().detail, 'Template not approved');
  });
});

describe('processMetaLeadgenChange', ()=>{
  let db, env, origFetch, sent, leads, nextId, clients;
  const leadgen={
    id:'LG1', created_time:'2026-09-28T10:00:00+0000', form_id:'F1', ad_id:'AD1', ad_name:'Goa ad', campaign_name:'Goa Sept', platform:'ig',
    field_data:[{name:'full_name', values:['Priya Kumar']}, {name:'phone_number', values:['+919876543210']}, {name:'budget', values:['50k']}],
  };
  beforeEach(()=>{
    db=freshDb();
    env={DB:d1(db), NOCODB_BASE:'https://noco.test', NOCODB_TOKEN:'x', APP_BASE_URL:'https://app.test/dashboard.html'};
    sent=[]; leads=[]; nextId=100;
    clients=[client({
      meta_leadgen_page_id:'555', meta_leadgen_page_token:'PAGETOKEN',
      meta_leadgen_config:JSON.stringify({enabled:true, page_id:'555', template_name:'lead_form_welcome_leadvyne', template_lang:'en', params:['first_name','business_name']}),
      lead_routing:JSON.stringify({enabled:true, modes:['roundrobin'], rules:{'a@x.com':{inPool:true}}}),
    })];
    origFetch=globalThis.fetch;
    globalThis.fetch=async (url, init={})=>{
      url=String(url);
      const method=init.method||'GET';
      if(url.startsWith('https://graph.facebook.com')){
        if(url.endsWith('/messages')){ sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({messages:[{id:'wamid.'+sent.length}]})); }
        if(url.includes('/LG1?')) return new Response(JSON.stringify(leadgen));
        if(url.includes('/F1?')) return new Response(JSON.stringify({name:'Goa enquiry form'}));
        return new Response(JSON.stringify({error:{message:'unexpected '+url}}), {status:400});
      }
      if(url.includes('/api/v2/meta/tables/')) return new Response(JSON.stringify({columns:['LeadSource','AdCampaign','AdName','LeadFormName','MetaLeadgenId'].map(title=>({title}))}));
      if(url.includes('/records') && url.includes('meta_leadgen_page_id')) return new Response(JSON.stringify({list:clients}));
      if(url.match(/mxl33bg4wi70fqj\/records\/\d+$/)) return new Response(JSON.stringify(clients[0]));
      if(method==='GET' && url.includes('/records')){
        const phone=decodeURIComponent(url).match(/\(Phone,eq,(\d+)\)/)?.[1];
        return new Response(JSON.stringify({list:leads.filter(l=>l.Phone===phone)}));
      }
      if(method==='POST' && url.includes('/records')){ const b=JSON.parse(init.body); const l={Id:nextId++, ...b}; leads.push(l); return new Response(JSON.stringify(l)); }
      if(method==='PATCH' && url.includes('/records')){ const b=JSON.parse(init.body); const l=leads.find(x=>x.Id===b.Id); if(l) Object.assign(l, b); else clients[0]={...clients[0], ...b}; return new Response('{}'); }
      return new Response('{}');
    };
  });
  afterEach(()=>{ globalThis.fetch=origFetch; db.close(); });

  test('new lead: saved, routed, welcomed on WhatsApp, owner alerted — once', async ()=>{
    const res=await processMetaLeadgenChange(env, {leadgen_id:'LG1', page_id:'555', form_id:'F1'});
    assert.equal(res.ok, true);
    assert.equal(res.isNewLead, true);
    assert.equal(leads.length, 1);
    const lead=leads[0];
    assert.equal(lead.Phone, '919876543210');
    assert.equal(lead.Name, 'Priya Kumar');
    assert.equal(lead.Owner, 'a@x.com');
    assert.equal(lead.LeadSource, 'Instagram Lead Ad');
    assert.equal(lead.AdCampaign, 'Goa Sept');
    assert.equal(lead.LeadFormName, 'Goa enquiry form');
    assert.deepEqual(JSON.parse(lead.QualAnswers), {Budget:'50k'});
    assert.match(JSON.parse(lead.ConvHistory)[0].content, /^Hi Priya, thank you for your enquiry with Acme Tours/);

    const welcome=sent.find(m=>m.to==='919876543210');
    assert.equal(welcome.template.name, 'lead_form_welcome_leadvyne');
    assert.deepEqual(welcome.template.components[0].parameters.map(p=>p.text), ['Priya', 'Acme Tours']);
    const alert=sent.find(m=>m.to==='919000000002');
    assert.equal(alert.template.components[0].parameters[2].text, 'just filled your lead form (Goa enquiry form)');

    const ev=db.prepare('SELECT status, lead_id FROM meta_leadgen_events WHERE leadgen_id=?').get('LG1');
    assert.deepEqual({...ev}, {status:'sent', lead_id:lead.Id});
    assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_messages').get().n, 1);

    // Meta retries the same webhook — nothing happens twice.
    assert.deepEqual(await processMetaLeadgenChange(env, {leadgen_id:'LG1', page_id:'555'}), {skipped:'duplicate'});
    assert.equal(sent.length, 2);
    assert.equal(leads.length, 1);
  });

  test('existing lead is updated, keeps its name and history', async ()=>{
    leads.push({Id:9, ClientId:'7', Phone:'919876543210', Name:'Priya (old)', Stage:'qualified', ConvHistory:JSON.stringify([{role:'user', content:'hi'}]), QualAnswers:'{"City":"Kochi"}'});
    const res=await processMetaLeadgenChange(env, {leadgen_id:'LG1', page_id:'555'});
    assert.equal(res.isNewLead, false);
    assert.equal(leads.length, 1);
    assert.equal(leads[0].Name, 'Priya (old)');
    assert.equal(leads[0].Stage, 'qualified');
    assert.deepEqual(JSON.parse(leads[0].QualAnswers), {City:'Kochi', Budget:'50k'});
    assert.equal(JSON.parse(leads[0].ConvHistory).length, 2);
  });

  test('opted-out lead gets no WhatsApp; unknown page is skipped', async ()=>{
    leads.push({Id:9, ClientId:'7', Phone:'919876543210', OptOut:'Yes'});
    await processMetaLeadgenChange(env, {leadgen_id:'LG1', page_id:'555'});
    assert.equal(sent.filter(m=>m.to==='919876543210').length, 0);
    assert.equal(db.prepare('SELECT status FROM meta_leadgen_events').get().status, 'saved');

    clients=[];
    assert.deepEqual(await processMetaLeadgenChange(env, {leadgen_id:'LG2', page_id:'999'}), {skipped:'no-client'});
  });
});
