// Chats thread media: the customer's real photo / voice note / file and the bot's product photos
// must reach the D1 lead_messages row chats.html reads — not just the AI's text reading of them.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { engineInboundMediaFields, d1InsertLeadMessage } from './worker.js';

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
