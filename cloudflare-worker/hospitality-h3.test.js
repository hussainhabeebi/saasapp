// Hospitality style H3 (hospitality-h3.js): Location → Property → Room → Book decisions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { H3_NAV, h3IsStyle, h3LocationStepOn, h3Locations, h3UseLocationStep, h3LocationTitle, h3PageRows,
  h3MoreTap, h3ExactName, h3Truncate, h3MentionsName, h3PropertyDesc, h3RoomDesc, h3Decide } from './hospitality-h3.js';

const P=(id, name, location, extra={})=>({id, name, location, amenities:'', ...extra});
const U=(id, name, property_id, extra={})=>({id, name, property_id, capacity_adults:2, capacity_children:0, base_rate:0, currency:'INR', ...extra});
const properties=[
  P(1, 'Aadhisakthi Resort', 'Munnar, Kerala', {amenities:'Pool, Wi-Fi'}),
  P(2, 'Bay View Suites', 'Munnar'),
  P(3, 'Calinz Thekkady', 'Thekkady, Kerala'),
  P(4, 'Cinnamon Stay', ''),
];
const units=[
  U(11, 'Deluxe Room', 1, {base_rate:4500}),
  U(12, 'Pool Villa', 1, {base_rate:9000}),
  U(21, 'Deluxe Room', 2, {base_rate:5000}),
  U(31, 'Tree House Premium Suite With View', 3, {base_rate:7000}),
];
const decide=(text, o={})=>h3Decide({text, properties, units, locationStep:true, ctx:{}, ...o});

test('H3 is its own style; other styles are not H3', ()=>{
  assert.equal(h3IsStyle({hospitality_enabled:'Yes', hospitality_style:'h3'}), true);
  for(const s of ['resort', 'hotel', 'houseboat', '']) assert.equal(h3IsStyle({hospitality_enabled:'Yes', hospitality_style:s}), false);
  assert.equal(h3IsStyle({hospitality_enabled:'No', hospitality_style:'h3'}), false);
  assert.equal(h3LocationStepOn({}), true);
  assert.equal(h3LocationStepOn({hospitality_h3_locations:'off'}), false);
});

test('locations group by city part, A–Z, with "Other" last', ()=>{
  const locs=h3Locations(properties);
  assert.deepEqual(locs.map(l=>[l.key, l.label, l.count]), [['munnar', 'Munnar', 2], ['thekkady', 'Thekkady', 1], ['', 'Other', 1]]);
  assert.equal(h3LocationTitle(locs[0]), 'Munnar (2)');
  assert.equal(h3UseLocationStep(true, locs), true);
  assert.equal(h3UseLocationStep(false, locs), false);
  assert.equal(h3UseLocationStep(true, h3Locations([P(1, 'A', 'Munnar'), P(2, 'B', '')])), false); // one real location
});

test('new lead / greeting gets the location list; step off or one location starts at properties', ()=>{
  assert.deepEqual(decide('Hi', {isNewLead:true}), {type:'locations', page:1, intro:true});
  assert.deepEqual(decide('Is there a pool?', {isNewLead:true}), {type:'locations', page:1, intro:true});
  assert.deepEqual(decide('hello', {locationStep:false}), {type:'properties', locKey:null, page:1, intro:true});
  assert.deepEqual(h3Decide({text:'hi', isNewLead:true, properties:[P(1, 'A', 'Munnar')], units:[], ctx:{}}), {type:'properties', locKey:null, page:1, intro:true});
  assert.deepEqual(h3Decide({text:'hi', isNewLead:true, properties:[], units:[U(1, 'Room A', null)], ctx:{}}), {type:'rooms', propertyId:null, page:1, intro:true});
  assert.equal(h3Decide({text:'hi', isNewLead:true, properties:[], units:[], ctx:{}}), null);
});

test('location tap (with count) or typed location → that location\'s properties', ()=>{
  assert.deepEqual(decide('Munnar (2)'), {type:'properties', locKey:'munnar', page:1});
  assert.deepEqual(decide('Thekkady'), {type:'properties', locKey:'thekkady', page:1});
  assert.deepEqual(decide('Other (1)'), {type:'properties', locKey:'', page:1});
  assert.deepEqual(decide('any stays in thekkady?'), {type:'properties', locKey:'thekkady', page:1});
});

test('property tap → its rooms; room tap → that room (scoped to the chosen property)', ()=>{
  assert.deepEqual(decide('Bay View Suites', {ctx:{location:'Munnar'}}), {type:'rooms', propertyId:2, page:1});
  // "Deluxe Room" exists in two properties: the chosen property decides which one.
  assert.deepEqual(decide('Deluxe Room', {ctx:{location:'Munnar', property:'Bay View Suites'}}), {type:'room', unitId:21});
  assert.deepEqual(decide('Deluxe Room', {ctx:{location:'Munnar', property:'Aadhisakthi Resort'}}), {type:'room', unitId:11});
  // Ambiguous with no property chosen → not guessed; the flow starts at the locations instead.
  assert.deepEqual(decide('Deluxe Room', {ctx:{}}), {type:'locations', page:1, intro:false});
  // A unique room name works from anywhere.
  assert.deepEqual(decide('Pool Villa'), {type:'room', unitId:12});
  // Typed property name anywhere in the sentence.
  assert.deepEqual(decide('show me rooms at calinz thekkady please'), {type:'rooms', propertyId:3, page:1});
});

test('WhatsApp-cut titles still resolve', ()=>{
  const long='Tree House Premium Suite With View';
  const cut=h3Truncate(long, 24);
  assert.equal(cut, 'Tree House Premium');
  assert.equal(h3ExactName(cut, long), true);
  assert.equal(h3ExactName('Tree House', long), false);
  assert.deepEqual(decide(cut, {ctx:{property:'Calinz Thekkady'}}), {type:'room', unitId:31});
  assert.equal(h3MentionsName('the deluxe rooms', 'Deluxe Room'), false);
  assert.equal(h3MentionsName('is the deluxe room free', 'Deluxe Room'), true);
});

test('navigation buttons', ()=>{
  const ctx={location:'Munnar', property:'Aadhisakthi Resort', unit:'Pool Villa'};
  assert.deepEqual(decide(H3_NAV.changeLocation, {ctx}), {type:'locations', page:1});
  assert.deepEqual(decide(H3_NAV.otherProperties, {ctx}), {type:'properties', locKey:'munnar', page:1});
  assert.deepEqual(decide(H3_NAV.otherRooms, {ctx}), {type:'rooms', propertyId:1, page:1});
  assert.deepEqual(decide(H3_NAV.book, {ctx}), {type:'book', unitId:12});
  assert.deepEqual(decide('book now', {ctx}), {type:'book', unitId:12});
  assert.equal(decide(H3_NAV.book, {ctx:{}}), null); // nothing chosen: the AI / Pro answers
  assert.deepEqual(decide('change location', {ctx, locationStep:false}), {type:'properties', locKey:null, page:1});
});

test('stale choices fall back instead of showing an empty list', ()=>{
  // Saved location no longer has any active property.
  assert.deepEqual(decide(H3_NAV.otherProperties, {ctx:{location:'Vagamon'}}), {type:'locations', page:1});
  // Saved property deactivated → "Other rooms" restarts.
  assert.deepEqual(decide(H3_NAV.otherRooms, {ctx:{property:'Gone Resort'}}), {type:'locations', page:1, intro:false});
});

test('returning guest saying hi resumes their location', ()=>{
  assert.deepEqual(decide('Hello', {ctx:{location:'Munnar'}}), {type:'properties', locKey:'munnar', page:1, resume:true});
  assert.deepEqual(decide('Hello', {ctx:{}}), {type:'locations', page:1, intro:true});
});

test('free questions mid-flow go to the AI', ()=>{
  const ctx={location:'Munnar', property:'Aadhisakthi Resort'};
  assert.equal(decide('Is breakfast included?', {ctx}), null);
  assert.equal(decide('12 to 14 Dec, 2 adults', {ctx}), null);
});

test('paging keeps every row reachable within 10 rows, nav rows included', ()=>{
  const rows=Array.from({length:25}, (_, i)=>({title:`Prop ${i+1}`, value:`Prop ${i+1}`}));
  const nav=[{title:H3_NAV.changeLocation, value:H3_NAV.changeLocation}];
  const seen=[];
  let page=1;
  for(let i=0; i<10; i++){
    const r=h3PageRows(rows, 'properties', page, nav);
    assert.ok(r.rows.length<=10);
    assert.equal(r.rows.at(-1).title, H3_NAV.changeLocation);
    const more=r.rows.at(-2);
    const tap=h3MoreTap(more.title);
    assert.equal(tap.kind, 'properties');
    seen.push(...r.rows.slice(0, -2).map(x=>x.title));
    page=tap.page;
    if(page===1) break;
  }
  assert.deepEqual(seen, rows.map(r=>r.title));
  assert.deepEqual(h3PageRows(rows.slice(0, 5), 'properties', 1, nav).rows.length, 6);
  assert.deepEqual(decide('More properties · page 2', {ctx:{location:'Munnar'}}), {type:'properties', locKey:'munnar', page:2});
  assert.deepEqual(decide('More locations · page 2'), {type:'locations', page:2});
  assert.deepEqual(decide('More rooms · page 2', {ctx:{property:'Aadhisakthi Resort'}}), {type:'rooms', propertyId:1, page:2});
});

test('list row descriptions: amenities; room capacity and type — never a price', ()=>{
  // No prices anywhere in H3 — the human agent gives the price at checkout.
  assert.equal(h3PropertyDesc(properties[0], units), 'Pool, Wi-Fi');
  assert.equal(h3PropertyDesc(properties[1], units), '1 room type');
  assert.equal(h3RoomDesc(units[0]), '2 adults');
  assert.equal(h3RoomDesc(U(9, 'X', 1, {capacity_adults:2, capacity_children:1, base_rate:0, unit_type:'Villa'})), '2 adults + 1 child · Villa');
});

test('short forms of names match within the chosen location ("bay view" after tapping Wayanad)', async ()=>{
  const { h3WordsMatch } = await import('./hospitality-h3.js');
  const props=[P(1, 'Bay View Suites', 'Wayanad'), P(2, 'Bluebell Resort', 'Wayanad'), P(3, 'Ambady Estate', 'Munnar'), P(4, 'Bay Leaf Inn', 'Munnar')];
  const d=(text, ctx={})=>h3Decide({text, properties:props, units:[], locationStep:true, ctx});
  assert.equal(h3WordsMatch('bay view', 'Bay View Suites'), true);
  assert.equal(h3WordsMatch('bayview', 'Bay View Suites'), true);
  assert.equal(h3WordsMatch('bluebell', 'Bluebell Resort'), true);
  assert.equal(h3WordsMatch('is breakfast included', 'Bluebell Resort'), false);
  assert.deepEqual(d('bay view', {location:'Wayanad'}), {type:'rooms', propertyId:1, page:1});
  assert.deepEqual(d('bluebell', {location:'Wayanad'}), {type:'rooms', propertyId:2, page:1});
  // Outside the chosen location still works when the name is unique.
  assert.deepEqual(d('bay leaf', {location:'Wayanad'}), {type:'rooms', propertyId:4, page:1});
  // Too short to trust ("bay" fits two properties) → left to the AI resolver.
  assert.equal(d('bay', {}), null);
  assert.deepEqual(d('wayanad'), {type:'properties', locKey:'wayanad', page:1});
});

test('a list tap echoed with its description line still resolves', ()=>{
  assert.deepEqual(decide('Munnar (2)\n2 properties'), {type:'properties', locKey:'munnar', page:1});
  assert.deepEqual(decide('Bay View Suites\nFrom ₹5,000', {ctx:{location:'Munnar'}}), {type:'rooms', propertyId:2, page:1});
});

test('AI candidates: current rooms, then this location\'s properties, then the rest, then locations', async ()=>{
  const { h3AiCandidates, h3PickCandidate } = await import('./hospitality-h3.js');
  const c=h3AiCandidates({properties, units, locationStep:true, ctx:{location:'Munnar', property:'Aadhisakthi Resort'}});
  assert.deepEqual(c.map(x=>x.label), ['Room: Deluxe Room', 'Room: Pool Villa',
    'Property: Aadhisakthi Resort', 'Property: Bay View Suites', 'Property: Calinz Thekkady', 'Property: Cinnamon Stay',
    'Location: Munnar', 'Location: Thekkady']);
  assert.deepEqual(h3PickCandidate(c, 'Property: Bay View Suites').action, {type:'rooms', propertyId:2, page:1});
  assert.deepEqual(h3PickCandidate(c, 'pool villa').action, {type:'room', unitId:12});
  assert.equal(h3PickCandidate(c, null), null);
  assert.equal(h3PickCandidate(c, 'Kovalam'), null);
});

test('AI replies lose every stay price, keep everything else', async ()=>{
  const { h3StripPrices, h3HasStayPrice, H3_PRICE_NOTE } = await import('./hospitality-h3.js');
  const names=['Bay View Suites', 'Pool Villa'];
  const out=h3StripPrices('Bay View Suites has a pool and Wi-Fi. The Deluxe Room is ₹4,500 per night. Would you like photos?', names);
  assert.equal(out, `Bay View Suites has a pool and Wi-Fi. Would you like photos?\n\n${H3_PRICE_NOTE}`);
  for(const s of ['Rooms start from Rs. 3,999', 'Pool Villa: INR 9000', 'Tariff is 5000/- for 2 adults', 'It costs 4,500 a night', 'Our cottages are AED 450', '- Pool Villa — ₹9,000']) assert.equal(h3HasStayPrice(s, names), true, s);
  for(const s of ['The Munnar package is ₹12,999 per person', 'Flights from Kochi start at ₹4,200', 'Check-in is at 2 PM', 'It sleeps 4 adults', 'Call us on 9876543210']) assert.equal(h3HasStayPrice(s, names), false, s);
  assert.equal(h3StripPrices('No prices here 😊', names), 'No prices here 😊');
  assert.equal(h3StripPrices('Pool Villa — ₹9,000/night', names), H3_PRICE_NOTE);
  // List lines with a price lose the price line only.
  assert.equal(h3StripPrices('Here are the rooms:\n- Pool Villa — ₹9,000\n- Garden view', names), `Here are the rooms:\n- Garden view\n\n${H3_PRICE_NOTE}`);
});

test('room list rows show the starting price; other H3 texts do not', async ()=>{
  const { h3RoomRowDesc, h3RoomCaption } = await import('./hospitality-h3.js');
  assert.equal(h3RoomRowDesc(units[0]), '2 adults · From ₹4,500/night');
  assert.equal(h3RoomRowDesc(U(9, 'X', 1, {capacity_adults:3, base_rate:12000, currency:'AED'})), '3 adults · From AED 12,000/night');
  assert.equal(h3RoomRowDesc(U(9, 'X', 1, {capacity_adults:3, base_rate:0})), '3 adults'); // no price set → none shown
  assert.equal(h3RoomCaption(units[0]), '*Deluxe Room*\n2 adults');
  assert.equal(h3PropertyDesc(properties[0], units), 'Pool, Wi-Fi');
});
