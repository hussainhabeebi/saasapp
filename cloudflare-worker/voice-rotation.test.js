import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  engineHedgeAi4BharatTts,
  engineResolveSarvamCredential,
  engineRunLiveVoiceTtsRotation,
} from './worker.js';

test('client Sarvam key wins; Worker key remains identifiable for quota enforcement',()=>{
  assert.deepEqual(
    engineResolveSarvamCredential({SARVAM_API_KEY:'worker-key'},{sarvam_api_key:'client-key'}),
    {apiKey:'client-key',source:'client'}
  );
  assert.deepEqual(
    engineResolveSarvamCredential({SARVAM_API_KEY:'worker-key'},{}),
    {apiKey:'worker-key',source:'worker'}
  );
});

test('returns Piper immediately and never starts heavier or paid providers',async()=>{
  const calls=[];
  const result=await engineRunLiveVoiceTtsRotation(
    async()=>{ calls.push('piper'); return new Uint8Array([1]).buffer; },
    async()=>{ calls.push('ai4bharat'); return null; },
    async()=>{ calls.push('sarvam'); return null; },
    20
  );
  assert.equal(result.provider,'piper');
  assert.deepEqual(calls,['piper']);
});

test('rotates Piper then AI4Bharat without spending Sarvam when local audio succeeds',async()=>{
  const calls=[];
  const result=await engineRunLiveVoiceTtsRotation(
    async()=>{ calls.push('piper'); return null; },
    async()=>{ calls.push('ai4bharat'); return new Uint8Array([1]).buffer; },
    async()=>{ calls.push('sarvam'); return new Uint8Array([2]).buffer; },
    20
  );
  assert.equal(result.provider,'ai4bharat');
  assert.deepEqual(calls,['piper','ai4bharat']);
});

test('AI4Bharat/Sarvam hedge still returns text on schedule when both stall',async()=>{
  const started=Date.now();
  const audio=await engineHedgeAi4BharatTts(
    ()=>new Promise(()=>{}),
    ()=>new Promise(()=>{}),
    2,
    15
  );
  assert.equal(audio,null);
  assert.ok(Date.now()-started<100);
});

test('voice summary transcript labels turns and keeps the most recent ones within budget',async()=>{
  const {engineBuildVoiceSummaryTranscript}=await import('./worker.js');
  const transcript=engineBuildVoiceSummaryTranscript([
    {role:'user',content:'old question'},
    {role:'system',content:'ignored'},
    {role:'assistant',content:'  old\n answer '},
    {role:'user',content:''},
    {role:'user',content:'latest question'},
  ]);
  assert.equal(transcript,'Customer: old question\nBusiness: old answer\nCustomer: latest question');
  const trimmed=engineBuildVoiceSummaryTranscript([
    {role:'user',content:'a'.repeat(50)},
    {role:'assistant',content:'b'.repeat(50)},
  ],70);
  assert.equal(trimmed,'Business: '+'b'.repeat(50));
});
