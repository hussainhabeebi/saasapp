import test from 'node:test';
import assert from 'node:assert/strict';
import {taAiItinerary,taAiItineraryParse,taAiItineraryPrompt,taAiDayCount} from './travel-ai-itinerary.js';

const pkg={name:'Hyderabad Bus Package',destination:'Hyderabad',nights:2,inclusions:'["Hotel","Breakfast"]',notes:'DAY 1 - Charminar',
  image_url:'https://drive.google.com/file/d/PKGPHOTO1/view',image_url_2:''};
const reply=JSON.stringify({days:[
  {title:'Arrival & Charminar',description:'Reach Hyderabad.',overnight:'Hyderabad',meals:['D','x'],items:[{type:'transfer',time:'9:00',description:'Pick up from bus stand',place:''},{type:'activity',time:'16:00',description:'Visit Charminar',place:'Charminar'}]},
  {title:'Golconda Fort',description:'Fort day.',overnight:'Hyderabad',meals:['B'],items:[{type:'weird',time:'25:00',description:'Golconda Fort',place:'Golconda Fort'}]},
]});
const jpg=new Uint8Array([0xFF,0xD8,0xFF,0xD9]);
function fakeFetch(calls){
  return async (url)=>{
    calls.push(url);
    if(url.includes('wikipedia.org')){
      const q=decodeURIComponent(new URL(url).searchParams.get('gsrsearch'));
      const title=q.startsWith('Charminar')?'Charminar':'Hyderabad';
      return new Response(JSON.stringify({query:{pages:[{title,thumbnail:{source:`https://upload.wikimedia.org/${title}.jpg`}}]}}),{headers:{'content-type':'application/json'}});
    }
    return new Response(jpg,{headers:{'content-type':'image/jpeg'}});
  };
}

test('prompt asks for exactly nights+1 days and carries the package facts', ()=>{
  const {system,user}=taAiItineraryPrompt(pkg);
  assert.match(system,/Exactly 3 days \(2 nights\)/);
  assert.match(user,/Destination: Hyderabad/);
  assert.match(user,/Inclusions: Hotel; Breakfast/);
  assert.match(user,/Agency notes: DAY 1 - Charminar/);
  assert.equal(taAiDayCount({nights:0}),2);
  assert.equal(taAiDayCount({nights:99}),30);
});

test('reply is cleaned into the builder day shape, padded to the day count', ()=>{
  const days=taAiItineraryParse('```json\n'+reply+'\n```',pkg);
  assert.equal(days.length,3);
  assert.deepEqual(days[0].meals,['D']);
  assert.equal(days[0].items[0].time,'09:00');
  assert.equal(days[1].items[0].type,'activity');
  assert.equal(days[1].items[0].time,'');
  assert.deepEqual(days[2],{day_no:3,title:'',description:'',overnight:'',meals:[],image_links:[],items:[]});
  assert.equal(taAiItineraryParse('not json',pkg),null);
});

test('adds one Wikipedia photo per day where the title matches, and package photos on day 1', async ()=>{
  const calls=[];
  const out=await taAiItinerary(pkg,async()=>reply,{fetchImpl:fakeFetch(calls)});
  assert.equal(out.days[0].items[1].image,'https://upload.wikimedia.org/Charminar.jpg');
  assert.equal(out.days[0].items[0].image,'');
  assert.equal(out.days[1].items[0].image,'', 'Golconda search returned an unrelated title, so no photo');
  assert.deepEqual(out.days[0].image_links,['https://drive.google.com/file/d/PKGPHOTO1/view']);
  assert.ok(out.days.every(d=>d.items.every(it=>!('place' in it))));
});

test('retries once on a non-JSON reply, then reports an error', async ()=>{
  let n=0;
  const ok=await taAiItinerary(pkg,async()=>(++n===1?'sorry':reply),{fetchImpl:fakeFetch([])});
  assert.equal(n,2); assert.equal(ok.days.length,3);
  const bad=await taAiItinerary(pkg,async()=>null,{fetchImpl:fakeFetch([])});
  assert.match(bad.error,/could not draft/);
  assert.match((await taAiItinerary({},async()=>reply)).error,/package name/);
});

test('a reply cut off mid-way keeps the days that closed; the AI error reason is passed on', async ()=>{
  const cut=reply.slice(0,reply.indexOf('"title":"Golconda Fort"')+20);
  const days=taAiItineraryParse(cut,pkg);
  assert.equal(days.length,3);
  assert.equal(days[0].title,'Arrival & Charminar');
  assert.equal(days[1].title,'');
  const bad=await taAiItinerary(pkg,async()=>({error:'shared Gemini: HTTP 429 quota'}),{fetchImpl:fakeFetch([])});
  assert.match(bad.error,/HTTP 429 quota/);
});
