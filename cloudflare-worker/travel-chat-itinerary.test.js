// Chats → ✨ AI Itinerary: what a browser sends as the approved draft becomes the itinerary record
// the PDF builder reads — only day fields it uses, trimmed, and only Wikimedia photo links.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {taChatDraftItin} from './worker.js';

test('the approved draft keeps the plan and drops anything else', ()=>{
  const it=taChatDraftItin({name:'Bali 4N/5D'},[
    {day_no:9, title:'Arrival', description:'Pickup', overnight:'Kuta', meals:['B','X','D'], evil:'<script>',
      items:[{type:'activity', time:'17:00', description:'Kuta Beach', image:'https://upload.wikimedia.org/a.jpg'},
        {type:'activity', description:'Spa', image:'https://evil.example/track.png'}]},
    {title:'', description:'', items:[{description:''}]},
    {title:'Ubud', items:[]},
  ]);
  assert.equal(it.title, 'Bali 4N/5D');
  assert.deepEqual(it.days.map(d=>[d.day_no, d.title]), [[1,'Arrival'], [2,'Ubud']]);
  assert.deepEqual(it.days[0].meals, ['B','D']);
  assert.equal(it.days[0].evil, undefined);
  assert.equal(it.days[0].items[0].image, 'https://upload.wikimedia.org/a.jpg');
  assert.equal(it.days[0].items[1].image, '');
});

test('a draft that is not a list gives no days', ()=>{
  assert.deepEqual(taChatDraftItin({name:'X'}, 'nope').days, []);
  assert.equal(taChatDraftItin({name:'X'}, Array.from({length:40}, (_, i)=>({title:'D'+i}))).days.length, 31);
});
