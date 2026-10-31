// chatwootMessageStatus — Chatwoot's message_updated webhook has no `status`, so the Chats ticks
// read it back from the messages API, asking for exactly the one message by id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatwootMessageStatus } from './worker.js';

const C={chatwoot_base:'https://cw.example', chatwoot_account_id:3, chatwoot_token:'tok'};

async function withFetch(fn, handler){
  const real=globalThis.fetch, calls=[];
  globalThis.fetch=async (url, opts={})=>{ calls.push({url:String(url), opts}); return handler(String(url)); };
  try{ return {out:await fn(), calls}; }
  finally{ globalThis.fetch=real; }
}

test('reads the one message by id and returns its status', async()=>{
  const {out, calls}=await withFetch(()=>chatwootMessageStatus(C, 77, 900),
    ()=>new Response(JSON.stringify({payload:[{id:900, status:'read'}]})));
  assert.equal(out, 'read');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://cw.example/api/v1/accounts/3/conversations/77/messages?after=900&before=901');
  assert.equal(calls[0].opts.headers.api_access_token, 'tok');
});

test('empty when the message is missing, the API fails, or ids/config are missing', async()=>{
  assert.equal((await withFetch(()=>chatwootMessageStatus(C, 77, 900), ()=>new Response(JSON.stringify({payload:[{id:899, status:'read'}]})))).out, '');
  assert.equal((await withFetch(()=>chatwootMessageStatus(C, 77, 900), ()=>new Response('nope', {status:404}))).out, '');
  assert.equal((await withFetch(()=>chatwootMessageStatus(C, 77, 900), ()=>{ throw new Error('network'); })).out, '');
  const {out, calls}=await withFetch(()=>chatwootMessageStatus(C, null, 900), ()=>new Response('{}'));
  assert.equal(out, ''); assert.equal(calls.length, 0);
  assert.equal((await withFetch(()=>chatwootMessageStatus({}, 77, 900), ()=>new Response('{}'))).calls.length, 0);
});
