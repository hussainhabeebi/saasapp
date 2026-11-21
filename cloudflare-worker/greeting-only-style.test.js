// Chat Style "Greetings only" (Travel Settings → 🧭 Chat Style): the first message gets the Flyindo
// welcome and the chat is handed to the team; after that the bot stays silent for that customer.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { engineGreetingOnlyTurn, engineHandoverSilenceTurn, ltTravelSettingsNormalize } from './worker.js';
import { greetingOnlyText, greetingOnlyOn, flyindoOn, flyindoNormalizeStyle } from './flyindo-flow.js';

const realFetch=globalThis.fetch;
afterEach(()=>{ globalThis.fetch=realFetch; });

test('style and greeting text', ()=>{
  assert.equal(flyindoNormalizeStyle('Greeting'), 'greeting');
  assert.equal(flyindoNormalizeStyle('other'), '');
  assert.ok(greetingOnlyOn({lt_chat_style:'greeting'}));
  assert.ok(!flyindoOn({lt_chat_style:'greeting'}), 'Flyindo booking flow stays off');
  assert.match(greetingOnlyText('ABC Travels'), /^Hello! 👋 Welcome to \*ABC Travels\*!\nWe're happy to help you plan your next trip\. 🌍\n\nWhere would you like to travel today\?/);
  assert.doesNotMatch(greetingOnlyText('ABC Travels'), /select/i, 'no list is sent, so no "select below"');
  assert.equal(greetingOnlyText('ABC', 'Hi from {agency}!'), 'Hi from ABC!');
  const n=ltTravelSettingsNormalize({lt_chat_style:'greeting', lt_flyindo_greeting_text:'  Hello  '});
  assert.equal(n.lt_chat_style, 'greeting');
  assert.equal(n.lt_flyindo_greeting_text, 'Hello');
  assert.equal(ltTravelSettingsNormalize({}).lt_flyindo_greeting_text, '');
});

test('first message → welcome and handover; off, opt-out or already handed over → null', async()=>{
  const sent=[];
  globalThis.fetch=async(url,opts={})=>{ sent.push({url:String(url),body:opts.body}); return Response.json({id:1}); };
  const c={Id:7,industry:'travel',client_name:'ABC Travels',language:'en',lt_chat_style:'greeting',chatwoot_base:'https://cw.test',chatwoot_account_id:'1',chatwoot_token:'x'};
  const state={convId:'55',stage:'new',lead:null};
  assert.equal(engineGreetingOnlyTurn({},{...c,lt_chat_style:''},7,state,'hi'), null);
  assert.equal(engineGreetingOnlyTurn({},{...c,lt_chat_style:'flyindo'},7,state,'hi'), null);
  assert.equal(engineGreetingOnlyTurn({},c,7,state,'stop'), null);
  assert.equal(engineGreetingOnlyTurn({},c,7,{...state,stage:'human_handover'},'hi'), null);
  assert.equal(engineGreetingOnlyTurn({},c,7,{...state,lead:{Handover:'Yes'}},'hi'), null);

  const r=engineGreetingOnlyTurn({},c,7,state,'Hi, need a Goa trip');
  assert.equal(r.turn.route, 'human');
  assert.equal(r.turn.next, 'human_handover');
  assert.match(r.turn.text, /Welcome to \*ABC Travels\*/);
  await r.turn.deliver();
  assert.ok(sent.some(x=>x.url.includes('/conversations/55/messages')), 'welcome sent');
  assert.ok(sent.some(x=>x.url.includes('/conversations/55/labels')), 'handover label added');

  const custom=engineGreetingOnlyTurn({},{...c,lt_flyindo_agency_name:'Fly Co',lt_flyindo_greeting_text:'Welcome to {agency} 🙏'},7,state,'hi');
  assert.equal(custom.turn.text, 'Welcome to Fly Co 🙏');
});

test('after the greeting the bot is silent even with handover silence off', async()=>{
  globalThis.fetch=async()=>Response.json({});
  const stmt={bind(){return stmt;},async run(){return {meta:{changes:1,last_row_id:1}};},async first(){return null;},async all(){return {results:[]};}};
  const env={DB:{prepare:()=>stmt,async batch(l){return l.map(()=>({}));}},NOCODB_BASE:'https://nc.test',NOCODB_TOKEN:'t'};
  const lead={Id:42,Stage:'human_handover',Handover:'Yes'};
  const state={lead,leadId:42,stage:'human_handover',history:[],phone:'+919800000001'};
  const parsed={phone:'+919800000001',name:'Sara',convId:'77',mediaType:'text',mediaUrl:'',channel:'whatsapp'};
  const c={Id:7,industry:'travel',lt_chat_style:'greeting',handover_silence_enabled:'No'};
  const r=await engineHandoverSilenceTurn(env,c,'7',{id:'m2'},state,parsed,'What is the price?');
  assert.equal((await r.json()).skipped, 'greeting-only');
  assert.equal(await engineHandoverSilenceTurn(env,{...c,lt_chat_style:''},'7',{id:'m3'},state,parsed,'hi'), null, 'other styles unchanged');
  assert.equal(await engineHandoverSilenceTurn(env,c,'7',{id:'m4'},{...state,lead:{Id:42,Stage:'new',Handover:'No'},stage:'new'},parsed,'hi'), null, 'not greeted yet');
});
