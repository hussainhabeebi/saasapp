// Chats → ✨ AI Itinerary for Hospitality accounts: the stay prompt, the draft (AI stubbed), the
// PDF's key facts, and the PDF builder's stay options (tag, facts, no price line, photo gallery).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hospAiItineraryPrompt,hospAiItinerary,hospAiNights,hospAiDate,hospAiCheckOut,hospAiPhotos,hospAiStayFacts,hospAiStayPkg,hospAiPdfName,HOSP_AI_FOOTNOTE} from './hospitality-ai-itinerary.js';
import {taBuildItineraryPdf} from './travel-itinerary.js';

const PROP={id:3,name:'Misty Hills Resort',location:'Munnar, Kerala',description:'Hill-top resort among tea estates.',amenities:'Infinity pool, Ayurvedic spa, Breakfast included',
  image_url_1:'https://drive.google.com/file/d/abc/view',image_url_2:'',image_url_3:'not a link'};
const ROOM={id:9,name:'Valley View Suite',unit_type:'Suite',amenities:'Balcony, Bathtub',description:'Faces the valley.'};

test('nights, dates and check-out', ()=>{
  assert.equal(hospAiNights(''), 2);
  assert.equal(hospAiNights('3'), 3);
  assert.equal(hospAiNights(400), 29);
  assert.equal(hospAiDate('2026-12-20'), '2026-12-20');
  assert.equal(hospAiDate('2026-02-30'), '');
  assert.equal(hospAiDate('20/12/2026'), '');
  assert.equal(hospAiCheckOut('2026-12-30', 3), '2027-01-02');
  assert.equal(hospAiCheckOut('', 3), '');
  assert.deepEqual(hospAiPhotos(PROP), ['https://drive.google.com/file/d/abc/view']);
});

test('the stay prompt is about this property, its amenities and area, with no prices', ()=>{
  const {system,user}=hospAiItineraryPrompt(PROP,ROOM,{nights:3,checkIn:'2026-12-20',guest:{adults:2,children:1,child_ages:'6',pace:'relaxed',interests:['Nature']}});
  assert.match(system, /Exactly 4 days \(3 nights\)/);
  assert.match(system, /check-in at Misty Hills Resort/);
  assert.match(system, /never suggest another hotel/);
  assert.match(system, /Never give any price/);
  assert.match(system, /around Munnar, Kerala/);
  assert.match(system, /family-friendly/);
  assert.match(user, /Property: Misty Hills Resort/);
  assert.match(user, /Property amenities: Infinity pool, Ayurvedic spa/);
  assert.match(user, /Room: Valley View Suite/);
  assert.match(user, /Check-in date: 2026-12-20/);
  assert.match(user, /Guests: 2 adults, 1 child \(age 6\)/);
  assert.doesNotMatch(user, /Route/);
});

test('the draft has one day per night plus check-out, with place photos looked up', async ()=>{
  const reply=JSON.stringify({days:[
    {title:'Arrival & check-in',overnight:'Misty Hills Resort',meals:['D'],items:[{type:'hotel',time:'14:00',description:'Check in and settle in'}]},
    {title:'Tea country',meals:['B'],items:[{type:'activity',description:'Visit Eravikulam National Park',place:'Eravikulam National Park'}]},
    {title:'Check-out',items:[{type:'hotel',description:'Check out'}]},
  ]});
  const seen=[];
  const fetchImpl=async(url)=>{seen.push(String(url));return {ok:true,json:async()=>({query:{pages:[{title:'Eravikulam National Park',thumbnail:{source:'https://upload.wikimedia.org/x/Eravikulam.jpg'}}]}})};};
  const out=await hospAiItinerary(PROP,ROOM,async()=>reply,{nights:2,fetchImpl});
  assert.equal(out.days.length, 3);
  assert.equal(out.days[1].items[0].image, 'https://upload.wikimedia.org/x/Eravikulam.jpg');
  assert.ok(seen.some(u=>u.includes('Eravikulam')));
  assert.deepEqual(out.days[0].image_links, []);
});

test('an AI that gives nothing usable is an error, not an empty plan', async ()=>{
  const out=await hospAiItinerary(PROP,null,async()=>({error:'timed out'}),{nights:1,fetchImpl:async()=>({ok:false})});
  assert.match(out.error, /timed out/);
  assert.match((await hospAiItinerary({name:''},null,async()=>'{}')).error, /no name/);
});

test('key facts for the PDF and its file name', ()=>{
  assert.deepEqual(hospAiStayFacts(PROP,ROOM,{nights:2,checkIn:'2026-12-20',guest:{adults:2,children:1}}),
    [['Location','Munnar, Kerala'],['Stay','2 nights / 3 days'],['Dates','20-22 Dec 2026'],['Guests','2 adults, 1 child']]);
  assert.deepEqual(hospAiStayFacts(PROP,ROOM,{nights:1}).map(f=>f[0]), ['Location','Stay','Room']);
  assert.equal(hospAiStayFacts(PROP,null,{nights:3,checkIn:'2026-12-30'})[2][1], '30 Dec - 2 Jan');
  assert.equal(hospAiPdfName(PROP), 'Stay-Itinerary-Misty-Hills-Resort.pdf');
});

test('the stay PDF has its own tag, facts and foot note, and draws the gallery photos', ()=>{
  // The gallery takes images already prepared by taPrepareImage.
  const img={filter:'DCTDecode',data:new Uint8Array([1,2,3]),w:4,h:3,cs:'DeviceRGB'};
  const pkg=hospAiStayPkg(PROP,ROOM,2);
  const itin={days:[{day_no:1,title:'Arrival',items:[{type:'hotel',description:'Check in'}]}],from_date:'2026-12-20',to_date:'2026-12-22'};
  const pdf=new TextDecoder('latin1').decode(taBuildItineraryPdf(pkg,itin,{agencyName:'Misty Hills',assets:{gallery:[{image:img,title:'Misty Hills Resort',text:'Infinity pool'}]},
    tag:'Stay Itinerary',facts:hospAiStayFacts(PROP,ROOM,{nights:2,guest:{adults:2}}),footNote:HOSP_AI_FOOTNOTE}));
  assert.match(pdf, /\(STAY ITINERARY\)/);
  assert.match(pdf, /\(Your Stay\)/);
  assert.match(pdf, /\(Misty Hills Resort\)/);
  assert.match(pdf, /\(GUESTS\)/);
  assert.match(pdf, /\/Im1 Do/);
  assert.doesNotMatch(pdf, /PRICE PER PERSON|TRAVEL ITINERARY|final price/);
  assert.doesNotMatch(pdf, /What's Included/);
});
