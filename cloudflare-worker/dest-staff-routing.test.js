// Destination Staff Routing (dest-staff-routing.js): rules, matching and messages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dsrNormalizeSettings, dsrSettingsPatch, dsrMatch, dsrPlaceMatch, dsrParseRoute, dsrDestinationLabel, dsrCustomerText,
  dsrStaffAlertParams, dsrStaffAlertText, dsrOn, dsrIsAgency, dsrNoteText } from './dest-staff-routing.js';

const cfg=dsrNormalizeSettings({enabled:true, rules:{
  'anu@x.com':{resorts:['Munnar', 'Thekkady'], packages:['Kashmir'], flights:['Kochi - Dubai', 'COK-SHJ']},
  'ravi@x.com':{resorts:['Wayanad'], packages:['Bali, Thailand'], flights:['Doha']},
  'sam@x.com':{packages:['*'], flights:['*']},
  'BAD':{resorts:['Goa']},
}});
const kochi={code:'COK', name:'Kochi'}, dubai={code:'DXB', name:'Dubai'}, doha={code:'DOH', name:'Doha'}, sharjah={code:'SHJ', name:'Sharjah'};

test('settings: clean lists, emails only, kinds default on', ()=>{
  assert.deepEqual(Object.keys(cfg.rules), ['anu@x.com', 'ravi@x.com', 'sam@x.com']);
  assert.deepEqual(cfg.rules['ravi@x.com'].packages, ['Bali', 'Thailand']);
  assert.deepEqual(cfg.kinds, {resort:true, package:true, flight:true});
  assert.equal(cfg.start_from_staff_number, true);
  assert.equal(dsrNormalizeSettings('not json').enabled, false);
  const p=dsrSettingsPatch({enabled:false, kinds:{flight:false}, rules:{'anu@x.com':{resorts:'Ooty'}, 'gone@x.com':{resorts:['Goa']}}, customer_text:'Hi'},
    cfg, e=>e!=='gone@x.com');
  assert.equal(p.enabled, false);
  assert.equal(p.kinds.flight, false); assert.equal(p.kinds.resort, true);
  assert.deepEqual(Object.keys(p.rules), ['anu@x.com']);
  assert.deepEqual(p.rules['anu@x.com'].resorts, ['Ooty']);
  assert.equal(p.customer_text, 'Hi');
});

test('only travel agencies with it switched on', ()=>{
  const on=JSON.stringify({enabled:true});
  assert.equal(dsrOn({industry:'travel', dest_staff_routing:on}), true);
  assert.equal(dsrOn({industry:'retail', ta_enabled:'Yes', dest_staff_routing:on}), true);
  assert.equal(dsrOn({industry:'retail', dest_staff_routing:on}), false);
  assert.equal(dsrOn({industry:'travel'}), false);
  assert.equal(dsrIsAgency({industry:'Travel Agency'}), true);
});

test('place matching: whole words, at least 3 letters', ()=>{
  assert.ok(dsrPlaceMatch('Munnar', 'Munnar, Kerala'));
  assert.ok(dsrPlaceMatch('munnar hills', 'Munnar'));
  assert.ok(!dsrPlaceMatch('Goa', 'Goalpara'));
  assert.ok(!dsrPlaceMatch('Ba', 'Bali'));
  assert.deepEqual(dsrParseRoute('Kochi - Dubai'), {from:'Kochi', to:'Dubai'});
  assert.deepEqual(dsrParseRoute('COK→DXB'), {from:'COK', to:'DXB'});
  assert.deepEqual(dsrParseRoute('kochi to dubai'), {from:'kochi', to:'dubai'});
  assert.deepEqual(dsrParseRoute('Dubai'), {any:'Dubai'});
});

test('resort and package destinations go to their teammate; * catches the rest', ()=>{
  assert.equal(dsrMatch(cfg, {kind:'resort', destination:'Munnar'})?.email, 'anu@x.com');
  assert.equal(dsrMatch(cfg, {kind:'resort', destination:'Wayanad, Kerala'})?.email, 'ravi@x.com');
  assert.equal(dsrMatch(cfg, {kind:'resort', destination:'Ooty'}), null, 'no resort wildcard');
  assert.equal(dsrMatch(cfg, {kind:'package', destination:'Kashmir'})?.email, 'anu@x.com');
  assert.equal(dsrMatch(cfg, {kind:'package', destination:'Ubud', names:['Bali Honeymoon 5N']})?.email, 'ravi@x.com', 'package name counts');
  const wild=dsrMatch(cfg, {kind:'package', destination:'Paris'});
  assert.equal(wild.email, 'sam@x.com'); assert.equal(wild.wildcard, true);
  // A teammate who left is skipped.
  assert.equal(dsrMatch(cfg, {kind:'resort', destination:'Munnar'}, e=>e!=='anu@x.com'), null);
  // Off, or that kind switched off.
  assert.equal(dsrMatch({...cfg, enabled:false}, {kind:'resort', destination:'Munnar'}), null);
  assert.equal(dsrMatch({...cfg, kinds:{...cfg.kinds, resort:false}}, {kind:'resort', destination:'Munnar'}), null);
});

test('flight routes: a route rule, a one-city rule, codes or names', ()=>{
  assert.equal(dsrMatch(cfg, {kind:'flight', origin:kochi, destination:dubai})?.email, 'anu@x.com');
  assert.equal(dsrMatch(cfg, {kind:'flight', origin:kochi, destination:sharjah})?.email, 'anu@x.com', 'COK-SHJ by code');
  assert.equal(dsrMatch(cfg, {kind:'flight', origin:dubai, destination:kochi})?.email, 'sam@x.com', 'a route rule is one direction');
  assert.equal(dsrMatch(cfg, {kind:'flight', origin:kochi, destination:doha})?.email, 'ravi@x.com');
  assert.equal(dsrMatch(cfg, {kind:'flight', origin:doha, destination:kochi})?.email, 'ravi@x.com', 'a city rule is either end');
  assert.equal(dsrDestinationLabel({kind:'flight', origin:kochi, destination:dubai}), 'Kochi → Dubai');
});

test('customer message: expert name, number and a wa.me link; custom text tokens', ()=>{
  const t=dsrCustomerText({customerName:'Priya Nair', destination:'Munnar', kind:'resort', staffName:'Anu', staffPhone:'919800000002', business:'Kerala Holidays'});
  assert.match(t, /^Thank you Priya! 🙏/);
  assert.match(t, /enquiry is now with \*Anu\*, our Munnar travel expert/);
  assert.match(t, /from \*\+919800000002\*/);
  assert.match(t, /https:\/\/wa\.me\/919800000002\?text=Hi%20Anu/);
  const n=dsrCustomerText({destination:'Goa'});
  assert.match(n, /our travel expert/); assert.doesNotMatch(n, /wa\.me/);
  const c=dsrCustomerText({customText:'Hi {{customer_name}}, {{staff_name}} ({{staff_phone}}) handles {{destination}} {{service}}: {{staff_link}}',
    customerName:'Priya', destination:'Kashmir', kind:'package', staffName:'Anu', staffPhone:'+91 98000 00002'});
  assert.equal(c, 'Hi Priya, Anu (+919800000002) handles Kashmir Holiday Package: https://wa.me/919800000002?text=Hi%20Anu%2C%20I%20enquired%20about%20Kashmir.');
});

test('staff alert: template params never empty or multi-line; text fallback', ()=>{
  const p=dsrStaffAlertParams({kind:'flight', customerName:'Priya\nNair', customerPhone:'+91 98000 00001', destination:'Kochi → Dubai', staffName:'Anu', business:'KH'});
  assert.equal(p.length, 5);
  assert.deepEqual(p.slice(0, 4), ['Flight', 'Priya Nair', '+919800000001', 'Kochi → Dubai']);
  assert.match(p[4], /^https:\/\/wa\.me\/919800000001\?text=Hi%20Priya/);
  assert.ok(p.every(x=>x && !/\n/.test(x)));
  assert.deepEqual(dsrStaffAlertParams({kind:'package'}).slice(1, 4), ['New customer', '-', '-']);
  assert.match(dsrStaffAlertText(p), /New Flight enquiry for you: Priya Nair \(\+919800000001\) chose Kochi → Dubai/);
  assert.match(dsrNoteText({kind:'resort', destination:'Munnar', staffName:'Anu', staffPhone:'9198', alert:'sent to +9198'}), /Munnar → Anu \(\+9198\).*silent.*Staff alert: sent/);
});

// ── Location-based view for staff (Chats → properties) ──
import { dsrStaffLocations, dsrLocationAllowed } from './dest-staff-routing.js';
test('staff locations: the teammate\'s Hotels & Resorts list, null when no limit', () => {
  assert.deepEqual(dsrStaffLocations(cfg, 'RAVI@x.com'), ['Wayanad']);
  assert.deepEqual(dsrStaffLocations(cfg, 'anu@x.com'), ['Munnar', 'Thekkady']);
  assert.equal(dsrStaffLocations(cfg, 'sam@x.com'), null);      // no resorts rule
  assert.equal(dsrStaffLocations(cfg, 'nobody@x.com'), null);
  assert.equal(dsrStaffLocations(cfg, ''), null);
  const star=dsrNormalizeSettings({rules:{'a@x.com':{resorts:['Wayanad', '*']}}});
  assert.equal(dsrStaffLocations(star, 'a@x.com'), null);        // "*" = every location
  // Routing switched off: the list still defines the teammate's locations.
  assert.deepEqual(dsrStaffLocations(dsrNormalizeSettings({enabled:false, rules:{'a@x.com':{resorts:['Vythiri']}}}), 'a@x.com'), ['Vythiri']);
});
test('location allowed: location or name, whole words', () => {
  const w=['Wayanad'];
  assert.equal(dsrLocationAllowed(null, 'Munnar'), true);
  assert.equal(dsrLocationAllowed(w, 'Wayanad, Kerala'), true);
  assert.equal(dsrLocationAllowed(w, 'Munnar'), false);
  assert.equal(dsrLocationAllowed(w, '', 'Wayanad Hill Resort'), true);
  assert.equal(dsrLocationAllowed(w, '', ''), false);
  assert.equal(dsrLocationAllowed(['Vythiri', 'Munnar'], 'Vythiri'), true);
});

test('hand-over chat button: the teammate\'s WhatsApp as a tap-to-chat button', async ()=>{
  const {dsrChatButton}=await import('./dest-staff-routing.js');
  const b=dsrChatButton({staffName:'Sruthi K', staffPhone:'+91 62829 17343', destination:'Munnar', business:'Yathra'});
  assert.equal(b.button, 'Chat with Sruthi');
  assert.ok(b.button.length<=20);
  assert.equal(b.url, 'https://wa.me/916282917343?text='+encodeURIComponent('Hi Sruthi K, I enquired about Munnar with Yathra.'));
  assert.match(b.text, /\*Sruthi K\*.*\+916282917343/);
  // An email instead of a name, or a long first name → generic title; no number → no button.
  assert.equal(dsrChatButton({staffName:'a@b.com', staffPhone:'919000000000'}).button, 'Chat on WhatsApp');
  assert.equal(dsrChatButton({staffName:'Venkatalakshminarayana', staffPhone:'919000000000'}).button, 'Chat on WhatsApp');
  assert.equal(dsrChatButton({staffName:'Anu', staffPhone:''}), null);
  assert.equal(dsrChatButton({staffName:'Anu', staffPhone:'12345'}), null);
});

test('hand-over text: the link line is dropped when the button carries it', ()=>{
  const args={customerName:'Priya', destination:'Munnar', staffName:'Anu', staffPhone:'919000000000'};
  assert.match(dsrCustomerText(args), /chat with them directly 👉 https:\/\/wa\.me\/919000000000/);
  const noLink=dsrCustomerText({...args, linkLine:false});
  assert.doesNotMatch(noLink, /wa\.me/);
  assert.match(noLink, /\*Anu\*.*\+919000000000/s);
  // A custom text keeps its own {{staff_link}}.
  assert.match(dsrCustomerText({...args, linkLine:false, customText:'Talk to {{staff_name}}: {{staff_link}}'}), /wa\.me\/919000000000/);
});

test('generic human hand-over: the assigned teammate, only with routing on and a number', async ()=>{
  const {dsrAssignedChat}=await import('./worker.js');
  const c={industry:'travel', authentik_email:'boss@x.com', team_emails:'anu@x.com, sam@x.com', team_names:JSON.stringify({'anu@x.com':'Anu'}),
    team_whatsapp:JSON.stringify({'anu@x.com':'919000000001'}),
    dest_staff_routing:JSON.stringify({enabled:true, rules:{'sam@x.com':{packages:['Bali'], phone:'919000000002'}}})};
  assert.deepEqual(dsrAssignedChat(c, {Owner:'anu@x.com'}), {email:'anu@x.com', staffName:'Anu', staffPhone:'919000000001', destination:''});
  // The routed teammate wins over the owner; their routing-row number first.
  assert.equal(dsrAssignedChat(c, {Owner:'anu@x.com', DsrStaff:'sam@x.com', DsrDestination:'Bali'}).staffPhone, '919000000002');
  assert.equal(dsrAssignedChat(c, {Owner:'anu@x.com', DsrStaff:'sam@x.com', DsrDestination:'Bali'}).destination, 'Bali');
  assert.equal(dsrAssignedChat(c, {Owner:'boss@x.com'}), null, 'no number on file');
  assert.equal(dsrAssignedChat(c, {Owner:'gone@x.com'}), null, 'no longer on the team');
  assert.equal(dsrAssignedChat(c, {}), null);
  assert.equal(dsrAssignedChat({...c, dest_staff_routing:JSON.stringify({enabled:false})}, {Owner:'anu@x.com'}), null, 'routing off');
});
