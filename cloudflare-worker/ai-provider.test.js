// Bring-your-own AI provider (Integrations → 🤖 AI Models) — URL validation, key encryption,
// per-provider request shapes (fetch stubbed), and the "no row → original path" guarantee against
// the real migration (node:sqlite through the same tiny D1 shim meetings.test.js uses).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  AI_PROVIDERS,
  aiValidateBaseUrl,
  aiKeyHint,
  aiEncryptSecret,
  aiDecryptSecret,
  aiProviderCall,
  aiProviderListModels,
  aiClientGenerate,
} from './worker.js';

function d1(db){
  return {prepare(sql){
    let args=[];
    const st={
      bind(...a){ args=a; return st; },
      async run(){ const r=db.prepare(sql).run(...args); return {meta:{changes:Number(r.changes)}}; },
      async all(){ return {results:db.prepare(sql).all(...args)}; },
      async first(){ return db.prepare(sql).get(...args)||null; },
    };
    return st;
  }};
}

const realFetch=globalThis.fetch;
let calls=[];
function stubFetch(handler){
  calls=[];
  globalThis.fetch=async(url, init={})=>{
    const call={url:String(url), init, body:init.body?JSON.parse(init.body):null};
    calls.push(call);
    const {status=200, json}=handler(call);
    return new Response(JSON.stringify(json), {status, headers:{'content-type':'application/json'}});
  };
}
afterEach(()=>{ globalThis.fetch=realFetch; });

describe('aiValidateBaseUrl', ()=>{
  test('accepts public https endpoints and strips trailing slash', ()=>{
    assert.equal(aiValidateBaseUrl('https://api.together.xyz/v1/'), 'https://api.together.xyz/v1');
    assert.equal(aiValidateBaseUrl('https://llm.example.com'), 'https://llm.example.com');
  });
  test('rejects http, credentials, local and private hosts', ()=>{
    for(const bad of ['http://api.example.com/v1', 'https://user:pw@api.example.com', 'https://localhost:11434/v1',
      'https://ollama.local/v1', 'https://10.0.0.5/v1', 'https://192.168.1.2/v1', 'https://172.20.0.1/v1',
      'https://127.0.0.1/v1', 'https://169.254.169.254/latest', 'https://[::1]/v1', 'https://intranet/v1', 'not a url', ''])
      assert.equal(aiValidateBaseUrl(bad), null, bad);
  });
});

test('key encryption round-trips and fails closed with the wrong secret', async()=>{
  const enc=await aiEncryptSecret({AI_KEY_ENC_SECRET:'s1'}, 'sk-ant-secret-1234');
  assert.match(enc, /^v1:/);
  assert.ok(!enc.includes('sk-ant'));
  assert.equal(await aiDecryptSecret({AI_KEY_ENC_SECRET:'s1'}, enc), 'sk-ant-secret-1234');
  assert.equal(await aiDecryptSecret({AI_KEY_ENC_SECRET:'other'}, enc), null);
  assert.equal(aiKeyHint('sk-ant-secret-1234'), '1234');
  assert.equal(aiKeyHint('short'), '');
});

describe('aiProviderCall request shapes', ()=>{
  test('Claude: x-api-key + version header, no temperature, low effort, text blocks joined', async()=>{
    stubFetch(()=>({json:{content:[{type:'thinking', thinking:''}, {type:'text', text:'Hi '}, {type:'text', text:'there'}], stop_reason:'end_turn'}}));
    const r=await aiProviderCall({provider:'anthropic', model:'claude-opus-5-5', apiKey:'k'}, 'sys', 'hello', {maxOutputTokens:300, temperature:0.5});
    assert.deepEqual(r, {ok:true, text:'Hi there'});
    assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
    assert.equal(calls[0].init.headers['x-api-key'], 'k');
    assert.equal(calls[0].init.headers['anthropic-version'], '2023-06-01');
    assert.equal(calls[0].body.system, 'sys');
    assert.equal(calls[0].body.temperature, undefined);
    assert.deepEqual(calls[0].body.output_config, {effort:'low'});
    assert.ok(calls[0].body.max_tokens>=2048);
    assert.equal(calls[0].body.fallbacks, undefined);
  });
  test('Claude Haiku 4.5 gets no effort param; Opus 5 gets server-side refusal fallback', async()=>{
    stubFetch(()=>({json:{content:[{type:'text', text:'ok'}]}}));
    await aiProviderCall({provider:'anthropic', model:'claude-haiku-4-5', apiKey:'k'}, '', 'x');
    assert.equal(calls[0].body.output_config, undefined);
    await aiProviderCall({provider:'anthropic', model:'claude-opus-5', apiKey:'k'}, '', 'x');
    assert.equal(calls.at(-1).body.fallbacks, 'default');
    assert.equal(calls.at(-1).init.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  });
  test('Claude refusal is reported as a failure', async()=>{
    stubFetch(()=>({json:{content:[], stop_reason:'refusal', stop_details:{category:'cyber'}}}));
    const r=await aiProviderCall({provider:'anthropic', model:'claude-sonnet-5', apiKey:'k'}, '', 'x');
    assert.equal(r.ok, false);
    assert.match(r.error, /declined.*cyber/);
  });
  test('OpenAI uses max_completion_tokens and no temperature; other compatible APIs keep classic params', async()=>{
    stubFetch(()=>({json:{choices:[{message:{content:' hello '}}]}}));
    const r=await aiProviderCall({provider:'openai', model:'gpt-x', apiKey:'k'}, 'sys', 'u', {maxOutputTokens:100, temperature:0.5});
    assert.deepEqual(r, {ok:true, text:'hello'});
    assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer k');
    assert.equal(calls[0].body.temperature, undefined);
    assert.ok(calls[0].body.max_completion_tokens>=2048);
    assert.deepEqual(calls[0].body.messages, [{role:'system', content:'sys'}, {role:'user', content:'u'}]);
    await aiProviderCall({provider:'groq', model:'m', apiKey:'k'}, '', 'u', {maxOutputTokens:100, temperature:0.5});
    assert.equal(calls.at(-1).url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(calls.at(-1).body.max_tokens, 100);
    assert.equal(calls.at(-1).body.temperature, 0.5);
  });
  test('custom endpoint uses the validated base URL and refuses private ones', async()=>{
    stubFetch(()=>({json:{choices:[{message:{content:'ok'}}]}}));
    await aiProviderCall({provider:'custom', base_url:'https://api.together.xyz/v1/', model:'m', apiKey:'k'}, '', 'u');
    assert.equal(calls[0].url, 'https://api.together.xyz/v1/chat/completions');
    const r=await aiProviderCall({provider:'custom', base_url:'https://10.1.1.1/v1', model:'m', apiKey:'k'}, '', 'u');
    assert.equal(r.ok, false);
    assert.equal(calls.length, 1);
  });
  test('Gemini own key goes in a header, not the URL', async()=>{
    stubFetch(()=>({json:{candidates:[{content:{parts:[{text:'hey'}]}}]}}));
    const r=await aiProviderCall({provider:'gemini', model:'gemini-2.5-flash', apiKey:'gk'}, 'sys', 'u');
    assert.equal(r.text, 'hey');
    assert.ok(!calls[0].url.includes('gk'));
    assert.equal(calls[0].init.headers['x-goog-api-key'], 'gk');
  });
  test('HTTP errors surface the provider message', async()=>{
    stubFetch(()=>({status:401, json:{error:{type:'authentication_error', message:'invalid x-api-key'}}}));
    const r=await aiProviderCall({provider:'anthropic', model:'claude-sonnet-5', apiKey:'bad'}, '', 'u');
    assert.deepEqual(r, {ok:false, error:'HTTP 401: invalid x-api-key'});
  });
  test('model listing normalises each provider format', async()=>{
    stubFetch(()=>({json:{models:[{name:'models/gemini-2.5-pro', supportedGenerationMethods:['generateContent']}, {name:'models/embedding-001', supportedGenerationMethods:['embedContent']}]}}));
    assert.deepEqual(await aiProviderListModels({provider:'gemini', apiKey:'k'}), {ok:true, models:['gemini-2.5-pro']});
    stubFetch(()=>({json:{data:[{id:'claude-sonnet-5'}, {id:'claude-opus-5-5'}]}}));
    assert.deepEqual(await aiProviderListModels({provider:'anthropic', apiKey:'k'}), {ok:true, models:['claude-opus-5-5', 'claude-sonnet-5']});
  });
});

describe('aiClientGenerate against the D1 migration', ()=>{
  let env;
  beforeEach(()=>{
    const db=new DatabaseSync(':memory:');
    db.exec(readFileSync(new URL('./migrations/0105_ai_provider_config.sql', import.meta.url), 'utf8'));
    env={DB:d1(db), AI_KEY_ENC_SECRET:'test-secret', _db:db};
  });
  async function insert(extra={}){
    const now=new Date().toISOString();
    env._db.prepare(`INSERT INTO ai_provider_config (client_id, provider, model, api_key_enc, key_hint, enabled, fallback_shared, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(7, extra.provider||'anthropic', extra.model||'claude-sonnet-5', await aiEncryptSecret(env, 'sk-client-key-9999'), '9999', extra.enabled??1, extra.fallback??1, now, now);
  }

  test('existing clients with no row are untouched (null → original path, no network)', async()=>{
    stubFetch(()=>{ throw new Error('should not be called'); });
    assert.equal(await aiClientGenerate(env, {Id:7}, 's', 'u'), null);
    assert.equal(await aiClientGenerate({...env, AI_KEY_ENC_SECRET:undefined}, {Id:7}, 's', 'u'), null);
    assert.equal(await aiClientGenerate({}, {Id:7}, 's', 'u'), null);
    assert.equal(calls.length, 0);
  });
  test('disabled row is ignored', async()=>{
    await insert({enabled:0});
    stubFetch(()=>{ throw new Error('should not be called'); });
    assert.equal(await aiClientGenerate(env, {Id:7}, 's', 'u'), null);
  });
  test('enabled row calls the client provider with the decrypted key and records success', async()=>{
    await insert();
    stubFetch(()=>({json:{content:[{type:'text', text:'Namaste!'}]}}));
    const out=await aiClientGenerate(env, {Id:7}, 's', 'u', {caller:'reply'});
    assert.deepEqual(out, {text:'Namaste!', fallback:true});
    assert.equal(calls[0].init.headers['x-api-key'], 'sk-client-key-9999');
    assert.ok(env._db.prepare('SELECT last_ok_at FROM ai_provider_config WHERE client_id=7').get().last_ok_at);
  });
  test('failure records the error and reports the client fallback preference', async()=>{
    await insert({fallback:0});
    stubFetch(()=>({status:429, json:{error:{message:'rate limited'}}}));
    const out=await aiClientGenerate(env, {Id:7}, 's', 'u');
    assert.equal(out.text, null);
    assert.equal(out.fallback, false);
    assert.equal(env._db.prepare('SELECT last_error FROM ai_provider_config WHERE client_id=7').get().last_error, 'HTTP 429: rate limited');
  });
});

test('provider catalog lists Claude models with the latest first', ()=>{
  assert.equal(AI_PROVIDERS.anthropic.models[0], 'claude-opus-5-5');
  assert.equal(AI_PROVIDERS.anthropic.default_model, 'claude-opus-5-5');
  for(const [id, p] of Object.entries(AI_PROVIDERS)){
    assert.ok(['anthropic','openai','gemini'].includes(p.format), id);
    if(id!=='custom') assert.match(p.base, /^https:\/\//, id);
  }
});
