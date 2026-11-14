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

test('who gets the hospitality AI Itinerary', async ()=>{
  const {hospChatIsOn}=await import('./worker.js');
  assert.equal(hospChatIsOn({hospitality_enabled:'Yes'}), true);
  assert.equal(hospChatIsOn({hospitality_enabled:'yes'}), true);
  assert.equal(hospChatIsOn({industry:'hospitality'}), true);
  assert.equal(hospChatIsOn({industry:'travel',channel_industry_map:'[{"inbox_id":1,"industry":"hospitality"}]'}), true);
  assert.equal(hospChatIsOn({industry:'travel',hospitality_enabled:'No'}), false);
  assert.equal(hospChatIsOn({industry:'ecommerce',channel_industry_map:'not json'}), false);
});

test('Agency Resorts & Hotels rows join the picker with their own ids and room choices', async ()=>{
  const {hospAiParseId,hospAiAgencyProperty,hospAiAgencyRooms}=await import('./hospitality-ai-itinerary.js');
  assert.deepEqual(hospAiParseId('3'), {source:'hospitality',id:3,room:0});
  assert.deepEqual(hospAiParseId('a-7'), {source:'agency',id:7,room:0});
  assert.deepEqual(hospAiParseId('a-7-r2'), {source:'agency',id:7,room:2});
  assert.equal(hospAiParseId('x-1'), null);
  const row={id:7,name:'Bay View Resort',property_type:'resort',star_rating:4,location:'Wayanad',description:'Lake-side.',amenities:'Pool',
    image_url:'https://drive.google.com/file/d/p1/view',image_url_2:'',image_url_3:'https://x.test/3.jpg',price_from:4500,room_types:'Deluxe, Pool Villa\nDeluxe'};
  const p=hospAiAgencyProperty(row);
  assert.equal(p.id, 'a-7');
  assert.equal(p.description, '4-star Resort. Lake-side.');
  assert.deepEqual(hospAiPhotos(p), ['https://drive.google.com/file/d/p1/view','https://x.test/3.jpg']);
  assert.equal(JSON.stringify(p).includes('4500'), false);
  assert.deepEqual(hospAiAgencyRooms(row).map(r=>[r.id,r.name]), [['a-7-r1','Deluxe'],['a-7-r2','Pool Villa']]);
  // The stay prompt reads it like a Hospitality property.
  const {system,user}=hospAiItineraryPrompt(p,hospAiAgencyRooms(row)[1],{nights:2});
  assert.match(system, /check-in at Bay View Resort/);
  assert.match(user, /Room: Pool Villa/);
});

test('optional price range: cleaned, formatted, pre-filled from rates', async ()=>{
  const {hospAiPrice,hospAiPriceLine,hospAiPriceHint}=await import('./hospitality-ai-itinerary.js');
  assert.equal(hospAiPrice(null), null);
  assert.equal(hospAiPrice({from:'', to:''}), null);
  assert.deepEqual(hospAiPrice({from:'6,000', to:'4500', currency:'inr', unit:'per night'}), {from:4500,to:6000,currency:'INR',unit:'per night'});
  assert.deepEqual(hospAiPrice({to:'120', currency:'usd', unit:'whatever'}), {from:120,to:0,currency:'USD',unit:'per night'});
  assert.equal(hospAiPriceLine({from:4500,to:12000,currency:'INR',unit:'per night'}), 'INR 4,500 - 12,000 per night');
  assert.equal(hospAiPriceLine({from:250,to:250,currency:'AED',unit:'per person'}), 'AED 250 per person');
  assert.deepEqual(hospAiPriceHint([4500,0,6000,null],'inr','per night'), {from:4500,to:6000,currency:'INR',unit:'per night'});
  assert.equal(hospAiPriceHint([0,null],'INR'), null);
});

test('the PDF draws the price band only when a range is given', ()=>{
  const pkg=hospAiStayPkg(PROP,ROOM,2);
  const itin={days:[{day_no:1,title:'Arrival',items:[{type:'hotel',description:'Check in'}]}]};
  const dec=b=>new TextDecoder('latin1').decode(b);
  const withPrice=dec(taBuildItineraryPdf(pkg,itin,{tag:'Stay Itinerary',facts:[['Stay','2 nights']],priceBand:{label:'Price range · Valley View Suite',value:'INR 4,500 - 6,000 per night',note:'Indicative.'}}));
  assert.match(withPrice, /\(PRICE RANGE \\267 VALLEY VIEW SUITE\)|\(PRICE RANGE/);
  assert.match(withPrice, /\(INR 4,500 - 6,000 per night\)/);
  const without=dec(taBuildItineraryPdf(pkg,itin,{tag:'Stay Itinerary',facts:[['Stay','2 nights']]}));
  assert.doesNotMatch(without, /PRICE RANGE/);
});

test('Resorts & Hotels brochure: price pre-fill, photo list, PDF with all photos and no day plan', async ()=>{
  const {hospAiAgencyPriceHint,hospAiBrochurePhotoList,hospAiBrochurePdfName,hospAiPriceLine}=await import('./hospitality-ai-itinerary.js');
  assert.deepEqual(hospAiAgencyPriceHint({price_range_min:5000,price_range_max:9000,price_from:4000,currency:'INR',price_unit:'per night'}), {from:5000,to:9000,currency:'INR',unit:'per night'});
  assert.deepEqual(hospAiAgencyPriceHint({price_from:4000,season_price:7000,currency:'INR'}), {from:4000,to:7000,currency:'INR',unit:'per night'});
  const prop={image_url_1:'https://drive.google.com/file/d/AAA/view',image_url_2:'https://x.test/2.jpg'};
  assert.deepEqual(hospAiBrochurePhotoList(prop,['AAA','BBB','CCC'],3), [{url:'https://drive.google.com/file/d/AAA/view'},{url:'https://x.test/2.jpg'},{drive_id:'BBB'}]);
  assert.equal(hospAiBrochurePdfName({name:'Bay View Resort'}), 'Bay-View-Resort.pdf');
  const img={filter:'DCTDecode',data:new Uint8Array([1,2,3]),w:4,h:3,cs:'DeviceRGB'};
  const imgs=Array.from({length:12},(_,i)=>({...img,data:new Uint8Array([i])}));
  const pdf=new TextDecoder('latin1').decode(taBuildItineraryPdf({name:'Bay View Resort',destination:'Wayanad',nights:0},{days:[]},{tag:'Stay Itinerary',facts:[['Location','Wayanad']],
    priceBand:{label:'Price range',value:hospAiPriceLine({from:5000,to:9000,currency:'INR',unit:'per night'})},galleryTitle:'Photos',galleryMax:30,galleryPhotoH:175,
    assets:{cover:{image:imgs[0]},gallery:imgs.slice(1).map(image=>({image}))}}));
  assert.match(pdf, /\(Photos\)/);
  assert.match(pdf, /\/Im12 Do/);
  assert.match(pdf, /\(INR 5,000 - 9,000 per night\)/);
  assert.doesNotMatch(pdf, /Day-by-Day|nights \/|About /);
});

test('inclusions / exclusions: cleaned, on the stay package and in the AI prompt', async ()=>{
  const {hospAiList}=await import('./hospitality-ai-itinerary.js');
  assert.deepEqual(hospAiList('Breakfast\n- Welcome drink\n\nbreakfast; ✓ Pool'), ['Breakfast','Welcome drink','Pool']);
  assert.deepEqual(hospAiList(['A','',' B ']), ['A','B']);
  assert.equal(hospAiList(Array.from({length:40},(_,i)=>'x'+i)).length, 25);
  const pkg=hospAiStayPkg(PROP,ROOM,2,{inclusions:['Breakfast','Welcome drink'],exclusions:'Lunch'});
  assert.equal(pkg.inclusions, 'Breakfast\nWelcome drink');
  assert.equal(pkg.exclusions, 'Lunch');
  assert.equal(hospAiStayPkg(PROP,ROOM,2).inclusions, '');
  const {system,user}=hospAiItineraryPrompt(PROP,ROOM,{nights:2,inclusions:['Breakfast'],exclusions:['Lunch']});
  assert.match(user, /Included in the stay: Breakfast/);
  assert.match(user, /Not included: Lunch/);
  assert.match(system, /never present anything under "Not included" as included/);
});

test('one photo per row, at its own proportions; inclusions printed before the photos', ()=>{
  const wide={filter:'DCTDecode',data:new Uint8Array([1]),w:1600,h:900,cs:'DeviceRGB'};
  const tall={filter:'DCTDecode',data:new Uint8Array([2]),w:900,h:1600,cs:'DeviceRGB'};
  const pdf=new TextDecoder('latin1').decode(taBuildItineraryPdf({name:'Bay View Resort',destination:'Wayanad',nights:0,inclusions:'Breakfast',exclusions:'Lunch'},{days:[]},
    {tag:'Stay Itinerary',galleryTitle:'Photos',galleryMax:30,galleryCols:1,incExcFirst:true,assets:{gallery:[{image:wide},{image:tall}]}}));
  // Full content width (595 - 2×44 = 507): the wide photo keeps 16:9; the tall one is scaled to fit 300pt, uncropped.
  assert.match(pdf, /507\.00 0 0 285\.19 /);
  assert.match(pdf, /168\.75 0 0 300\.00 /);
  assert.ok(pdf.indexOf('(INCLUDED)')<pdf.indexOf('(Photos)'), 'inclusions come before the photos');
  assert.match(pdf, /\(NOT INCLUDED\)/);
});
