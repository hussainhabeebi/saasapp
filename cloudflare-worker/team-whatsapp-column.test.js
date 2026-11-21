// /team/whatsapp stored nothing when the CLIENTS table had no team_whatsapp column: NocoDB ignores
// a PATCH field it doesn't have, and the old create only tried /fields. ncEnsureColumnProbed
// proves the column with a records read and falls back to /columns.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ncEnsureColumnProbed} from './worker.js';

function nocodb({fieldsWorks}){
  let exists=false;const calls=[];
  globalThis.fetch=async(url,opts={})=>{
    const u=String(url),m=opts.method||'GET';calls.push(`${m} ${u.replace('https://nc/','')}`);
    if(m==='GET'&&u.includes('fields=Id,team_whatsapp'))return new Response('{}',{status:exists?200:400});
    if(m==='POST'&&u.endsWith('/fields')){if(fieldsWorks)exists=true;return new Response('{}',{status:fieldsWorks?200:404});}
    if(m==='POST'&&u.endsWith('/columns')){exists=true;return new Response('{}',{status:200});}
    return new Response('{}',{status:200});
  };
  return {calls,exists:()=>exists};
}
const env={NOCODB_BASE:'https://nc',NOCODB_TOKEN:'t'};

test('already there: no create', async()=>{
  const nc=nocodb({fieldsWorks:true});
  globalThis.fetch=async()=>new Response('{}',{status:200});
  assert.equal(await ncEnsureColumnProbed(env,'T','team_whatsapp','LongText'),true);
  void nc;
});
test('/fields refused → created through /columns, then proven', async()=>{
  const nc=nocodb({fieldsWorks:false});
  assert.equal(await ncEnsureColumnProbed(env,'T','team_whatsapp','LongText'),true);
  assert.ok(nc.exists());
  assert.ok(nc.calls.some(c=>c.startsWith('POST')&&c.endsWith('/columns')));
});
test('/fields works → /columns not needed', async()=>{
  const nc=nocodb({fieldsWorks:true});
  assert.equal(await ncEnsureColumnProbed(env,'T','team_whatsapp','LongText'),true);
  assert.ok(!nc.calls.some(c=>c.endsWith('/columns')));
});
test('neither works → false (the save then reports an error instead of a fake ✓)', async()=>{
  globalThis.fetch=async(url,opts={})=>new Response('{}',{status:String(url).includes('fields=Id')?400:500});
  const orig=console.error;console.error=()=>{};
  try{assert.equal(await ncEnsureColumnProbed(env,'T','team_whatsapp','LongText'),false);}finally{console.error=orig;}
});
