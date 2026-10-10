// Chats thread media: the customer's real photo / voice note / file and the bot's product photos
// must reach the D1 lead_messages row chats.html reads — not just the AI's text reading of them.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { engineInboundMediaFields, d1InsertLeadMessage, d1InsertLeadMessages, chatwootOutgoingMediaRows, chatwootMediaRows } from './worker.js';

function fakeDb(){
  const rows=[];
  return {rows, prepare(){ return {bind(...args){ return {async run(){ rows.push(args); }}; }}; }};
}

describe('engineInboundMediaFields', ()=>{
  test('an inbound photo keeps its URL and the customer\'s own caption', ()=>{
    assert.deepEqual(engineInboundMediaFields('image','https://cw.test/p.jpg','is this in stock?'),
      {userMedia:{type:'image', url:'https://cw.test/p.jpg', caption:'is this in stock?', ai_text:true}});
  });
  test('a voice note becomes a voice attachment', ()=>{
    assert.equal(engineInboundMediaFields('voice','https://cw.test/v.ogg','').userAttachment.kind, 'voice');
  });
  test('a document keeps its file name', ()=>{
    assert.deepEqual(engineInboundMediaFields('document','https://cw.test/files/Price%20List.pdf?x=1',''),
      {userAttachment:{kind:'document', url:'https://cw.test/files/Price%20List.pdf?x=1', name:'Price List.pdf'}});
  });
  test('plain text adds nothing', ()=>{
    assert.deepEqual(engineInboundMediaFields('text','','hi'), {});
  });
});

describe('d1InsertLeadMessage', ()=>{
  test('a photo sent as `media` is stored as an image attachment', async ()=>{
    const DB=fakeDb();
    await d1InsertLeadMessage({DB}, 7, 48, {role:'user', content:'a red dress', ts:'t', media:{type:'image', url:'https://cw.test/p.jpg', caption:''}});
    assert.deepEqual(JSON.parse(DB.rows[0][4]), {url:'https://cw.test/p.jpg', caption:'', kind:'image'});
  });
  test('an explicit attachment wins over media', async ()=>{
    const DB=fakeDb();
    await d1InsertLeadMessage({DB}, 7, 48, {role:'assistant', content:'', ts:'t', attachment:{kind:'voice', url:'v'}, media:{type:'image', url:'p'}});
    assert.deepEqual(JSON.parse(DB.rows[0][4]), {kind:'voice', url:'v'});
  });
});

describe('chatwootOutgoingMediaRows (bot/agent photos from the message_created webhook)', ()=>{
  const body={id:901, message_type:'outgoing', private:false, content:'Here are the photos', created_at:1790000000,
    attachments:[{file_type:'image', data_url:'https://cw.test/rails/a/romper.jpg', file_size:1200},
                 {file_type:'audio', data_url:'https://cw.test/rails/a/reply.ogg'}]};
  test('one row per attachment, tagged with the Chatwoot message id, no repeated caption', ()=>{
    const rows=chatwootOutgoingMediaRows(body);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {role:'assistant', content:'', ts:new Date(1790000000000).toISOString(),
      attachment:{kind:'image', url:'https://cw.test/rails/a/romper.jpg', name:'romper.jpg', size:1200, cw_id:901}});
    assert.equal(rows[1].attachment.kind, 'voice');
    assert.notEqual(rows[0].ts, rows[1].ts);
  });
  test('incoming, private and text-only messages give nothing', ()=>{
    assert.deepEqual(chatwootOutgoingMediaRows({...body, message_type:'incoming'}), []);
    assert.deepEqual(chatwootOutgoingMediaRows({...body, private:true}), []);
    assert.deepEqual(chatwootOutgoingMediaRows({...body, attachments:[]}), []);
  });
  test('backfilled customer photos keep their caption as the user', ()=>{
    const [row]=chatwootMediaRows({id:5, message_type:0, created_at:'2026-09-20T09:00:00Z', attachments:[{file_type:'image', data_url:'https://cw.test/x.jpg'}]}, 'user', 'is this in stock?');
    assert.equal(row.role, 'user');
    assert.equal(row.content, 'is this in stock?');
    assert.equal(row.ts, '2026-09-20T09:00:00.000Z');
  });
});

test('inbound media carries its Chatwoot message id so the one-off backfill skips it', ()=>{
  assert.equal(engineInboundMediaFields('image','https://cw.test/p.jpg','',77).userMedia.cw_id, 77);
});

describe('d1InsertLeadMessages', ()=>{
  function batchDb({failBatch=false}={}){
    const rows=[], batches=[];
    return {rows, batches,
      prepare(){ return {bind(...args){ return {args, async run(){ rows.push(args); }}; }}; },
      async batch(list){ if(failBatch) throw new Error('batch failed'); batches.push(list.length); for(const st of list) await st.run(); }};
  }
  test('writes a whole history in one batch, skipping rows with no role', async ()=>{
    const DB=batchDb();
    await d1InsertLeadMessages({DB}, 7, 48, [{role:'user', content:'hi', ts:'1'}, {content:'no role'}, {role:'assistant', content:'hello', ts:'2', media:{type:'image', url:'p'}}]);
    assert.deepEqual(DB.batches, [2]);
    assert.deepEqual(DB.rows.map(r=>r[3]), ['hi', 'hello']);
    assert.equal(JSON.parse(DB.rows[1][4]).kind, 'image');
  });
  test('splits long histories into chunks of 100', async ()=>{
    const DB=batchDb();
    await d1InsertLeadMessages({DB}, 7, 48, Array.from({length:250}, (_, i)=>({role:'user', content:String(i), ts:String(i)})));
    assert.deepEqual(DB.batches, [100, 100, 50]);
  });
  test('falls back to row-by-row when the batch fails', async ()=>{
    const DB=batchDb({failBatch:true});
    await d1InsertLeadMessages({DB}, 7, 48, [{role:'user', content:'a', ts:'1'}, {role:'user', content:'b', ts:'2'}]);
    assert.deepEqual(DB.rows.map(r=>r[3]), ['a', 'b']);
  });
  test('an empty list does nothing', async ()=>{
    const DB=batchDb();
    await d1InsertLeadMessages({DB}, 7, 48, []);
    assert.deepEqual(DB.batches, []);
  });
});
