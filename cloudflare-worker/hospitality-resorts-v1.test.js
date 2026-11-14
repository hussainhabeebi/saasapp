// Hospitality style "Resorts V1" (hospitality-resorts-v1.js): Agency Resorts & Hotels flow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RV1_NAV, rv1IsStyle, rv1Decide, rv1PropertyOptions, rv1IntroText, rv1DetailsText, rv1PropertyRowDesc, rv1PriceText,
  rv1StripPrices, rv1AiContext, rv1IsBookText, rv1MoreTap, RV1_PRICE_NOTE } from './hospitality-resorts-v1.js';
import { taPropertyClean, taPropertyPriceRange } from './ta-properties.js';
import { h3Locations } from './hospitality-h3.js';

const P=(id, name, location, extra={})=>({id, name, location, status:'active', property_type:'resort', currency:'INR', price_unit:'per night', ...extra});
const properties=[
  P(1, 'Aadhisakthi Resort', 'Munnar, Kerala', {price_range_min:8000, price_range_max:15000, price_from:8500, amenities:'Pool\nWi-Fi', star_rating:4}),
  P(2, 'Bay View Suites', 'Munnar', {price_range_min:5000}),
  P(3, 'Calinz Thekkady', 'Thekkady, Kerala', {category:'couple'}),
  P(4, 'Wayanad Wild', 'Wayanad', {price_range_max:20000}),
  P(5, 'Old Closed Resort', 'Goa', {status:'inactive'}),
];
const decide=(text, o={})=>rv1Decide({text, properties, ctx:{}, ...o});

test('Resorts V1 needs Hospitality, Agency and the style', ()=>{
  assert.equal(rv1IsStyle({hospitality_enabled:'Yes', ta_enabled:'Yes', hospitality_style:'resorts_v1'}), true);
  assert.equal(rv1IsStyle({hospitality_enabled:'yes', ta_enabled:'YES', hospitality_style:'resorts_v1'}), true);
  assert.equal(rv1IsStyle({hospitality_enabled:'Yes', ta_enabled:'No', hospitality_style:'resorts_v1'}), false);
  assert.equal(rv1IsStyle({hospitality_enabled:'No', ta_enabled:'Yes', hospitality_style:'resorts_v1'}), false);
  for(const s of ['h3', 'resort', 'hotel', '']) assert.equal(rv1IsStyle({hospitality_enabled:'Yes', ta_enabled:'Yes', hospitality_style:s}), false);
});

test('price range field: saved low → high, shown as a range, never the exact price', ()=>{
  const {values}=taPropertyClean({name:'X', price_range_min:'15000', price_range_max:'8000'});
  assert.equal(values.price_range_min, 8000);
  assert.equal(values.price_range_max, 15000);
  assert.equal(taPropertyClean({name:'X', price_range_min:''}).values.price_range_min, null);
  assert.equal(taPropertyPriceRange(properties[0]), '₹8,000 – ₹15,000 per night');
  assert.equal(taPropertyPriceRange(properties[1]), 'From ₹5,000 per night');
  assert.equal(taPropertyPriceRange(properties[3]), 'Up to ₹20,000 per night');
  assert.equal(taPropertyPriceRange(properties[2]), '');
  assert.equal(taPropertyPriceRange({price_range_min:100, price_range_max:200, currency:'AED', price_unit:'per person'}), 'AED 100 – AED 200 per person');
  assert.match(rv1PropertyRowDesc(properties[0]), /^₹8,000 – ₹15,000 per night · Resort ⭐⭐⭐⭐/);
  assert.match(rv1PropertyRowDesc(properties[2]), /^Price on request · Couple Resort/);
});

test('intro names the locations in the text; new lead / greeting gets the location list', ()=>{
  const locs=h3Locations(properties.filter(p=>p.status==='active'));
  const intro=rv1IntroText('Kerala Stays', locs, {useLoc:true});
  assert.match(intro, /Welcome to \*Kerala Stays\*/);
  assert.match(intro, /resorts & hotels in \*Munnar\*, \*Thekkady\* and \*Wayanad\*/);
  assert.doesNotMatch(intro, /Goa/); // inactive resorts are not offered
  assert.deepEqual(decide('Hi', {isNewLead:true}), {type:'locations', page:1, intro:true});
  assert.deepEqual(decide('hello'), {type:'locations', page:1, intro:true});
  assert.deepEqual(decide('anything at all', {isNewLead:true}), {type:'locations', page:1, intro:true});
});

test('one location only: starts at the resort list', ()=>{
  const one=[P(1, 'A Resort', 'Munnar'), P(2, 'B Resort', 'Munnar')];
  assert.deepEqual(rv1Decide({text:'hi', properties:one, isNewLead:true}), {type:'properties', locKey:null, page:1, intro:true});
  assert.match(rv1IntroText('Biz', h3Locations(one), {useLoc:false, count:2}), /resorts & hotels in \*Munnar\*/);
  assert.equal(rv1Decide({text:'hi', properties:[], isNewLead:true}), null);
});

test('location tap → its resorts; resort tap → photos & details', ()=>{
  assert.deepEqual(decide('Munnar (2)'), {type:'properties', locKey:'munnar', page:1});
  assert.deepEqual(decide('Munnar (2)\n2 resorts & hotels'), {type:'properties', locKey:'munnar', page:1});
  assert.deepEqual(decide('Bay View Suites', {ctx:{location:'Munnar'}}), {type:'property', propertyId:2});
  assert.deepEqual(decide('bayview'), {type:'property', propertyId:2});
  assert.deepEqual(decide('Wayanad'), {type:'properties', locKey:'wayanad', page:1});
  assert.notEqual(decide('Old Closed Resort')?.type, 'property'); // inactive: never opened
});

test('navigation and paging', ()=>{
  assert.deepEqual(decide(RV1_NAV.changeLocation, {ctx:{property:'Bay View Suites'}}), {type:'locations', page:1});
  assert.deepEqual(decide(RV1_NAV.otherResorts, {ctx:{property:'Bay View Suites'}}), {type:'properties', locKey:'munnar', page:1});
  assert.deepEqual(rv1MoreTap('More resorts · page 2'), {kind:'resorts', page:2});
  assert.deepEqual(decide('More resorts · page 2', {ctx:{location:'Munnar'}}), {type:'properties', locKey:'munnar', page:2});
});

test('booking: Book now / "I want to book" → book (handover)', ()=>{
  assert.deepEqual(decide(RV1_NAV.book, {ctx:{property:'Aadhisakthi Resort'}}), {type:'book', propertyId:1});
  assert.deepEqual(decide('I want to book', {ctx:{property:'Aadhisakthi Resort'}}), {type:'book', propertyId:1});
  assert.deepEqual(decide('book now'), {type:'book', propertyId:null});
  assert.deepEqual(decide('book bay view suites'), {type:'book', propertyId:2});
  for(const t of ['Book now', 'book it', 'confirm booking', 'ok book', 'please book', 'booking confirm']) assert.equal(rv1IsBookText(t), true, t);
  for(const t of ['is booking available?', 'how to book', 'booked already?']) assert.equal(rv1IsBookText(t), false, t);
});

test('price questions get the range, never an exact price', ()=>{
  assert.deepEqual(decide('price?', {ctx:{property:'Aadhisakthi Resort'}}), {type:'price', propertyId:1});
  assert.deepEqual(decide('rate of bay view suites'), {type:'price', propertyId:2});
  assert.deepEqual(decide('price', {ctx:{location:'Munnar'}}), {type:'price', locKey:'munnar'});
  assert.equal(decide('price'), null);
  const one=rv1PriceText({property:properties[0]});
  assert.match(one, /₹8,000 – ₹15,000 per night/);
  assert.doesNotMatch(one, /8,500|8500/);
  const many=rv1PriceText({list:properties.slice(0, 2), locLabel:'Munnar'});
  assert.match(many, /Aadhisakthi Resort — ₹8,000 – ₹15,000/);
  assert.match(many, /Bay View Suites — From ₹5,000/);
});

test('details show the range and amenities, not price_from or season rates', ()=>{
  const d=rv1DetailsText({...properties[0], season_price:12000, description:'Hilltop stay.'});
  assert.match(d, /Price range: \*₹8,000 – ₹15,000 per night\*/);
  assert.match(d, /Amenities: Pool, Wi-Fi/);
  assert.match(d, /Hilltop stay\./);
  assert.doesNotMatch(d, /8,500|12,000|12000/);
  assert.match(rv1DetailsText(properties[2]), /Price on request/);
});

test('questions go to the AI; a named resort follows the answer', ()=>{
  assert.deepEqual(decide('is breakfast included at bay view suites?'), {type:'property', propertyId:2, aiFirst:true});
  assert.deepEqual(decide('what is there to do in Wayanad?'), {type:'properties', locKey:'wayanad', page:1, aiFirst:true});
  assert.equal(decide('is pet allowed?'), null);
  assert.deepEqual(decide('is pet allowed?', {isNewLead:true}), {type:'locations', page:1, intro:false, aiFirst:true});
});

test('AI reply guard keeps ranges, drops exact stay prices', ()=>{
  const ok='Aadhisakthi Resort is ₹8,000 – ₹15,000 per night. It has a pool.';
  assert.equal(rv1StripPrices(ok, properties), ok);
  const bad='Aadhisakthi Resort costs ₹8,500 per night. It has a pool.';
  const out=rv1StripPrices(bad, properties);
  assert.doesNotMatch(out, /8,500/);
  assert.match(out, /It has a pool\./);
  assert.match(out, new RegExp(RV1_PRICE_NOTE.slice(0, 20)));
  assert.equal(rv1StripPrices('The drive from Kochi is 120 km.', properties), 'The drive from Kochi is 120 km.');
});

test('AI context lists ranges only and puts the browsed resort first', ()=>{
  const ctx=rv1AiContext(properties, {property:'Wayanad Wild'});
  assert.match(ctx, /Locations: Munnar, Thekkady, Wayanad/);
  assert.match(ctx, /price range: ₹8,000 – ₹15,000 per night/);
  assert.doesNotMatch(ctx, /8500|8,500/);
  assert.doesNotMatch(ctx, /Old Closed Resort/);
  assert.ok(ctx.indexOf('- Wayanad Wild')<ctx.indexOf('- Aadhisakthi Resort'));
  assert.match(ctx, /never give an exact price/);
});

test('after booking (handed over) the bot stays silent, even with handover silence off', async()=>{
  const { engineHandoverSilenceTurn }=await import('./worker.js');
  const realFetch=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({});
  try{
    const stmt={bind(){return stmt;},async run(){return {meta:{changes:1,last_row_id:1}};},async first(){return null;},async all(){return {results:[]};}};
    const env={DB:{prepare:()=>stmt,async batch(l){return l.map(()=>({}));}},NOCODB_BASE:'https://nc.test',NOCODB_TOKEN:'t'};
    const state={lead:{Id:42,Stage:'human_handover',Handover:'Yes'},leadId:42,stage:'human_handover',history:[],phone:'+919800000001'};
    const parsed={phone:'+919800000001',name:'Sara',convId:'77',mediaType:'text',mediaUrl:'',channel:'whatsapp'};
    const c={Id:7,industry:'hospitality',hospitality_enabled:'Yes',ta_enabled:'Yes',hospitality_style:'resorts_v1',handover_silence_enabled:'No'};
    const r=await engineHandoverSilenceTurn(env,c,'7',{id:'m2'},state,parsed,'What is the price?');
    assert.equal((await r.json()).skipped, 'resorts-v1-booked');
    assert.equal(await engineHandoverSilenceTurn(env,{...c,hospitality_style:'h3'},'7',{id:'m3'},state,parsed,'hi'), null, 'other styles unchanged');
    assert.equal(await engineHandoverSilenceTurn(env,c,'7',{id:'m4'},{...state,lead:{Id:42,Stage:'new',Handover:'No'},stage:'new'},parsed,'hi'), null, 'not booked yet');
  }finally{ globalThis.fetch=realFetch; }
});

test('travel agencies: Chat Style "Resorts V1" turns it on without the Hospitality module', ()=>{
  assert.equal(rv1IsStyle({industry:'travel', lt_chat_style:'resorts_v1'}), true);
  assert.equal(rv1IsStyle({industry:'general', ta_enabled:'Yes', lt_chat_style:'resorts_v1'}), true);
  assert.equal(rv1IsStyle({industry:'travel', lt_chat_style:'flyindo'}), false);
  assert.equal(rv1IsStyle({industry:'travel', lt_chat_style:''}), false);
  assert.equal(rv1IsStyle({industry:'ecommerce', lt_chat_style:'resorts_v1'}), false, 'not an agency');
});

test('full list: 🏨 All resorts, and paging through every resort', ()=>{
  assert.deepEqual(decide(RV1_NAV.allResorts), {type:'properties', locKey:null, page:1, all:true});
  assert.deepEqual(decide('show all resorts'), {type:'properties', locKey:null, page:1, all:true});
  assert.deepEqual(decide('More resorts · page 2'), {type:'properties', locKey:null, page:2, all:true});
  assert.deepEqual(decide('More resorts · page 2', {ctx:{location:'Munnar'}}), {type:'properties', locKey:'munnar', page:2});
});

test('full buttons under a resort: Book, More photos, Video, Brochure, Other resorts, Change location', ()=>{
  const p={...properties[0], photos_folder_url:'https://drive.google.com/drive/folders/abc123', video_url:'https://drive.google.com/file/d/v/view', pdf_url:'https://drive.google.com/file/d/p/view'};
  assert.deepEqual(rv1PropertyOptions(p).map(o=>o.title), [RV1_NAV.book, RV1_NAV.photos, RV1_NAV.video, RV1_NAV.brochure, RV1_NAV.otherResorts, RV1_NAV.changeLocation]);
  assert.deepEqual(rv1PropertyOptions(properties[2], {useLoc:false}).map(o=>o.title), [RV1_NAV.book, RV1_NAV.otherResorts]);
  const ctx={property:'Aadhisakthi Resort'};
  assert.deepEqual(decide(RV1_NAV.photos, {ctx}), {type:'photos', propertyId:1});
  assert.deepEqual(decide('more photos', {ctx}), {type:'photos', propertyId:1});
  assert.deepEqual(decide(RV1_NAV.video, {ctx}), {type:'video', propertyId:1});
  assert.deepEqual(decide(RV1_NAV.brochure, {ctx}), {type:'brochure', propertyId:1});
});

test('price guard leaves a travel agency\'s package and flight prices alone', ()=>{
  const pkg='Our Goa 3N/4D package with hotel is ₹14,999 per person.';
  assert.equal(rv1StripPrices(pkg, properties), pkg);
  const named='Aadhisakthi Resort package is ₹9,999 per night.';
  assert.doesNotMatch(rv1StripPrices(named, properties), /9,999/);
});
