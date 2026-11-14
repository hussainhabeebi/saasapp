// Products & Services (General accounts): item cleaning, the bot's "which item was named" match,
// its details card / media plan / AI context, and Chats → 📑 AI Proposal (prompt, parse, totals, PDF).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pcIsOn,pcIsDriveLink,pcVideoLinkText,pcCleanItem,pcFindItemsInText,pcItemCard,pcMediaPlan,pcContextBlock,pcPriceText,pcMoney,pcTranscript,pcSelection,
  pcProposalPrompt,pcParseProposal,pcProposalDraft,pcCleanProposal,pcProposalTotals,pcProposalPdfName,pcBuildProposalPdf} from './product-catalog.js';

const HEATER={id:1,kind:'product',name:'Solar Water Heater',category:'Solar',short_description:'Rooftop solar water heater for homes.',
  details:'Stainless steel tank, 5-year warranty.',features:'200 litre tank\nWorks on cloudy days',keywords:'geyser, solar heater',
  price:42000,currency:'INR',price_unit:'',image_url_1:'https://drive.google.com/file/d/img1/view',image_url_2:'',
  voice_note_url:'https://drive.google.com/file/d/voice1/view',brochure_url:'https://drive.google.com/file/d/pdf1/view',status:'active'};
const HEATER_XL={...HEATER,id:2,name:'Solar Water Heater 300L',keywords:'',price:55000};
const AMC={id:3,kind:'service',name:'Annual Maintenance',short_description:'Yearly service visit.',price:2500,currency:'INR',price_unit:'year',status:'active'};
const SURVEY={id:4,kind:'service',name:'Site Survey',price:null,status:'active'};
const OLD={id:5,kind:'product',name:'Old Panel',status:'inactive'};

test('General accounts only: general, blank and unknown industries; not industries with their own catalogue', ()=>{
  assert.equal(pcIsOn({industry:'general'}), true);
  assert.equal(pcIsOn({industry:''}), true);
  assert.equal(pcIsOn({}), true);
  assert.equal(pcIsOn({industry:'Marketing Agency'}), true);
  assert.equal(pcIsOn({industry:'ecommerce'}), false);
  assert.equal(pcIsOn({industry:'Hospitality'}), false);
  assert.equal(pcIsOn(null), false);
});

test('cleaning an item: name required, prices are numbers, media must be links', ()=>{
  assert.deepEqual(pcCleanItem({name:'  '}), {error:'Name is required'});
  assert.equal(pcCleanItem({name:'X',price:'abc'}).error, 'Price must be a number');
  assert.match(pcCleanItem({name:'X',voice_note_url:'my drive'}).error, /voice note url must be a link/);
  const c=pcCleanItem({name:' Solar  Heater ',kind:'SERVICE',price:'42,000',currency:'aed',auto_send:false});
  assert.equal(c.name, 'Solar Heater');
  assert.equal(c.kind, 'service');
  assert.equal(c.price, 42000);
  assert.equal(c.currency, 'AED');
  assert.equal(c.auto_send, 0);
  assert.equal(c.status, 'active');
  assert.equal(pcCleanItem({name:'X',kind:'other'}).kind, 'product');
  assert.equal(pcCleanItem({name:'X',price:''}).price, null);
  // An update only writes what it was given.
  assert.deepEqual(pcCleanItem({status:'inactive'},{partial:true}), {status:'inactive'});
});

test('prices read naturally', ()=>{
  assert.equal(pcMoney(42000,'INR'), 'INR 42,000');
  assert.equal(pcMoney(1234567.5,'AED'), 'AED 1,234,567.50');
  assert.equal(pcPriceText(HEATER), 'INR 42,000');
  assert.equal(pcPriceText(AMC), 'INR 2,500 / year');
  assert.equal(pcPriceText({...AMC,price_unit:'per visit'}), 'INR 2,500 per visit');
  assert.equal(pcPriceText(SURVEY), '');
});

test('the bot finds the item the customer named — whole words, longest name first, never inactive', ()=>{
  const items=[HEATER,HEATER_XL,AMC,SURVEY,OLD];
  assert.deepEqual(pcFindItemsInText(items,'Price of solar water heater?').map(i=>i.id), [1]);
  assert.deepEqual(pcFindItemsInText(items,'do you have the solar water heater 300L').map(i=>i.id), [2]);
  assert.deepEqual(pcFindItemsInText(items,'need a geyser').map(i=>i.id), [1]);
  assert.deepEqual(pcFindItemsInText(items,'Heater and annual maintenance please').map(i=>i.id), [3]);
  assert.deepEqual(pcFindItemsInText(items,'solar heater + annual maintenance').map(i=>i.id), [1,3]);
  assert.deepEqual(pcFindItemsInText(items,'old panel'), []);
  assert.deepEqual(pcFindItemsInText(items,'Site surveys'), []);
  assert.deepEqual(pcFindItemsInText(items,''), []);
});

test('details card, then photos, voice note and brochure', ()=>{
  const card=pcItemCard(HEATER);
  assert.match(card, /^📦 \*Solar Water Heater\*/);
  assert.match(card, /💰 INR 42,000/);
  assert.match(card, /Stainless steel tank/);
  assert.match(card, /• 200 litre tank\n• Works on cloudy days/);
  assert.match(pcItemCard(AMC), /^🛠️ \*Annual Maintenance\*/);
  assert.deepEqual(pcMediaPlan(HEATER).map(m=>m.kind), ['image','voice','document']);
  assert.equal(pcMediaPlan(HEATER)[0].caption, '📷 Solar Water Heater');
  assert.deepEqual(pcMediaPlan(AMC), []);
});

test('the AI context lists active items with prices and never inactive ones', ()=>{
  const ctx=pcContextBlock([HEATER,AMC,SURVEY,OLD]);
  assert.match(ctx, /VERIFIED PRODUCTS & SERVICES/);
  assert.match(ctx, /### Products\n- \*\*Solar Water Heater\*\* \| Category: Solar \| Price: INR 42,000/);
  assert.match(ctx, /### Services/);
  assert.match(ctx, /Site Survey\*\* \| Price: on request/);
  assert.doesNotMatch(ctx, /Old Panel/);
  assert.equal(pcContextBlock([]), '');
});

test('transcript keeps the newest messages when long', ()=>{
  const rows=[{role:'user',content:'Hi'},{role:'assistant',content:'Hello! How can I help?'},{role:'user',content:'Need a solar heater for 5 people'},{role:'user',content:''}];
  assert.equal(pcTranscript(rows), 'Customer: Hi\nBusiness: Hello! How can I help?\nCustomer: Need a solar heater for 5 people');
  assert.equal(pcTranscript(rows,{maxChars:45}), 'Customer: Need a solar heater for 5 people');
});

test('selection keeps the agent order, merges duplicates, drops unknown and inactive items', ()=>{
  const sel=pcSelection([{id:'3',qty:2},{id:1},{id:'99'},{id:5},{id:3,qty:1}],[HEATER,AMC,OLD]);
  assert.deepEqual(sel.map(s=>[s.item.id,s.qty]), [[3,3],[1,1]]);
});

test('the proposal prompt carries the items, notes and chat, and forbids prices', ()=>{
  const selection=pcSelection([{id:1,qty:2},{id:3}],[HEATER,AMC]);
  const {system,user}=pcProposalPrompt({business:'Sunrise Solar',customer:'Asha',selection,transcript:'Customer: Need hot water for 6 people',notes:'Mention free installation'});
  assert.match(system, /sales consultant at Sunrise Solar/);
  assert.match(system, /Never write any price/);
  assert.match(system, /never add, swap or rename an item/);
  assert.match(user, /- id: 1\n  name: Solar Water Heater\n  type: product\n  quantity: 2/);
  assert.match(user, /highlights: 200 litre tank; Works on cloudy days/);
  assert.match(user, /Agent's notes \(follow these\): Mention free installation/);
  assert.match(user, /Customer: Need hot water for 6 people/);
  assert.doesNotMatch(user, /42000|42,000/);
});

test('parsing the draft: every selected item once, catalogue prices, the AI wording', ()=>{
  const selection=pcSelection([{id:1,qty:2},{id:3}],[HEATER,AMC]);
  const raw='```json\n'+JSON.stringify({title:'Hot water for the Nair family',summary:'You need hot water for 6.',
    items:[{id:'3',description:'Keeps it running.'},{id:'1',description:'Fits a family of 6.',price:1},{id:'77',description:'invented'}],
    benefits:['Local team'],next_steps:['Book a site visit'],terms:['Valid 15 days'],closing:'Thank you!'})+'\n```';
  const p=pcParseProposal(raw,selection);
  assert.equal(p.title, 'Hot water for the Nair family');
  assert.deepEqual(p.items.map(i=>[i.id,i.qty,i.unit_price,i.description]), [['1',2,42000,'Fits a family of 6.'],['3',1,2500,'Keeps it running.']]);
  assert.deepEqual(p.benefits, ['Local team']);
  // An item the AI skipped keeps its own short description.
  const q=pcParseProposal(JSON.stringify({summary:'ok',items:[]}),selection);
  assert.equal(q.items[0].description, 'Rooftop solar water heater for homes.');
  assert.equal(q.title, 'Business Proposal');
  assert.match(pcParseProposal('not json',selection).error, /not valid JSON/);
  assert.match(pcParseProposal('{"title":"x"}',selection).error, /no summary/);
});

test('the draft retries once on an unusable reply and reports a provider error', async ()=>{
  const selection=pcSelection([{id:1}],[HEATER]);
  let calls=0;
  const ok=await pcProposalDraft({selection},async()=>{calls++;return calls===1?'oops':JSON.stringify({summary:'Good fit.'});});
  assert.equal(calls, 2);
  assert.equal(ok.summary, 'Good fit.');
  const bad=await pcProposalDraft({selection},async()=>({error:'quota exceeded'}));
  assert.equal(bad.error, 'quota exceeded');
  assert.match((await pcProposalDraft({selection:[]},async()=>'')).error, /Pick at least one/);
});

test('the reviewed proposal is re-checked, and totals add up', ()=>{
  const p=pcCleanProposal({title:' Offer ',summary:'S',items:[{id:'1',qty:'2',unit_price:'40000',description:'D'},{id:'3',qty:0},{id:'4'},{id:'99'}],
    benefits:'Fast\nLocal',discount_pct:'5',tax_pct:18,tax_label:'GST',valid_days:'15'},[HEATER,AMC,SURVEY]);
  assert.equal(p.title, 'Offer');
  assert.deepEqual(p.items.map(i=>[i.id,i.qty,i.unit_price]), [['1',2,40000],['3',1,2500],['4',1,null]]);
  assert.deepEqual(p.benefits, ['Fast','Local']);
  assert.equal(p.valid_days, 15);
  const t=pcProposalTotals(p);
  assert.deepEqual(t, {currency:'INR',subtotal:82500,discount:4125,tax:14107.5,total:92482.5,priced:2,unpriced:1});
  assert.equal(pcProposalPdfName(p,'Asha Nair'), 'Proposal-Asha-Nair.pdf');
  assert.equal(pcProposalPdfName(p,''), 'Proposal-Offer.pdf');
});

test('the proposal PDF has the title, customer, items, totals and sections', ()=>{
  const p=pcCleanProposal({title:'Hot Water Proposal',summary:'You need hot water for 6 people.',items:[{id:'1',qty:2,description:'Fits a family.'},{id:'4'}],
    benefits:['Local service team'],next_steps:['Site visit'],terms:['Valid for 15 days'],closing:'Thank you.',tax_pct:18,tax_label:'GST',valid_days:15},[HEATER,SURVEY]);
  const bytes=pcBuildProposalPdf(p,{business:'Sunrise Solar',phone:'+91 98000 00000',customer:'Asha',now:new Date('2026-11-14T00:00:00Z')});
  const s=new TextDecoder('latin1').decode(bytes);
  assert.match(s, /^%PDF-1\.4/);
  assert.match(s, /%%EOF\n$/);
  for(const t of ['Hot Water Proposal','Prepared for Asha','14 Nov 2026','Valid until 29 Nov 2026','Overview','Solar Water Heater','INR 84,000','2 x INR 42,000','On request',
    'GST \\(18%\\)','INR 99,120','TOTAL','Why Sunrise Solar','Next Steps','Terms & Conditions','Warm regards,','1 item is priced on request','Page 1 of'])
    assert.ok(s.includes(t), `PDF has ${t}`);
});

test('video link: Drive videos go as a file (worker falls back to the link), other links as a link', ()=>{
  assert.match(pcCleanItem({name:'X',video_url:'not a link'}).error, /video url must be a link/);
  assert.equal(pcCleanItem({name:'X',video_url:' https://youtu.be/abc '}).video_url, 'https://youtu.be/abc');
  assert.equal(pcIsDriveLink('https://drive.google.com/file/d/v1/view'), true);
  assert.equal(pcIsDriveLink('https://www.youtube.com/watch?v=abc'), false);
  // Photos first, then the video, then the voice note and brochure.
  const plan=pcMediaPlan({...HEATER,video_url:'https://drive.google.com/file/d/vid1/view'});
  assert.deepEqual(plan.map(m=>m.kind), ['image','video','voice','document']);
  assert.deepEqual(plan[1], {url:'https://drive.google.com/file/d/vid1/view',kind:'video',drive:true,caption:'🎬 Solar Water Heater'});
  assert.equal(pcMediaPlan({...AMC,video_url:'https://youtu.be/abc'})[0].drive, false);
  assert.equal(pcVideoLinkText(HEATER,'https://youtu.be/abc'), '🎬 Watch the Solar Water Heater video: https://youtu.be/abc');
});
