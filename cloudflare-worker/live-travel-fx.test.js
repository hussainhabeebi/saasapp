import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  ltFxRate, ltFxRound, ltFxFormat, ltFxApplyToOffer, ltFxCurrencyFromPhone, ltFxCurrencyFromText,
  ltFxDriftPct, ltFxNormalizeSettings, ltFxRates, ltFxRefresh, ltFxRefreshIfStale, ltFxSlotStart, ltFxNextSlot, LT_FX_USD_PEGS,
} from './live-travel-fx.js';
import { ltNormalizeOffer, ltChatCurrencySwitch, ltConvertStoredChatOffers, ltFormatChatOffers, ltNormalizeChatFlightRequest, ltStoredOfferSelectionIndex, ltChatCustomerCurrency } from './worker.js';

const RATES={USD:1,INR:88,AED:3.6725,SAR:3.75,QAR:3.64,KWD:0.3065};
const fx=(target,extra={})=>({target,rates:RATES,buffer_pct:0,rounding:'none',fetched_at:'2026-10-02T00:00:00Z',source:'test',...extra});

describe('Live Agency currency conversion', () => {
  test('cross rates go through USD and same-currency is 1', () => {
    assert.equal(ltFxRate('AED','AED',RATES),1);
    assert.ok(Math.abs(ltFxRate('INR','AED',RATES)-3.6725/88)<1e-12);
    assert.equal(ltFxRate('INR','XYZ',RATES),null);
  });

  test('rounds per currency: whole units for INR/AED, 3 decimals for KWD', () => {
    assert.equal(ltFxRound(1078.01,'AED','auto'),1079);
    assert.equal(ltFxRound(1050,'INR','auto'),1050);
    assert.equal(ltFxRound(12.34567,'KWD','auto'),12.346);
    assert.equal(ltFxRound(101,'SAR','up_5'),105);
    assert.equal(ltFxRound(99.999,'USD','none'),100);
  });

  test('formats amounts with currency-appropriate decimals', () => {
    assert.equal(ltFxFormat(425.5,'AED'),'AED 425.50');
    assert.equal(ltFxFormat(25000,'INR'),'INR 25,000');
    assert.equal(ltFxFormat(12.5,'KWD'),'KWD 12.500');
  });

  test('converts an INR supplier fare to AED with buffer, markup after conversion and rounding', () => {
    const offer=ltNormalizeOffer('tripjack',{id:'TJ-1',totalPrice:25000,taxes:5000,currency:'INR'},
      {markup_type:'fixed',markup_value:20,fx:fx('AED',{buffer_pct:1.5,rounding:'auto'})});
    const rate=3.6725/88*1.015;
    assert.equal(offer.currency,'AED');
    assert.equal(offer.supplier_currency,'INR');
    assert.equal(offer.supplier_total,25000,'supplier_total is what the supplier charges, without our markup');
    assert.equal(offer.fx_status,'converted');
    assert.ok(Math.abs(offer.fx_rate-rate)<1e-7);
    // 25000 INR → 1058.985 AED, + 20 AED markup = 1078.985 → rounded up to 1079.
    assert.equal(offer.total_amount,1079);
    assert.equal(Math.round((offer.base_amount+offer.tax_amount+offer.markup_amount)*100)/100,1079,'components add up to the rounded total');
  });

  test('a fixed markup means the same agency money for every supplier', () => {
    const ctx={markup_type:'fixed',markup_value:50,fx:fx('AED')};
    const inr=ltNormalizeOffer('tripjack',{id:'A',totalPrice:8800,currency:'INR'},ctx);
    const aed=ltNormalizeOffer('riya',{offer_id:'B',fare:{totalFare:367.25},currency:'AED'},ctx);
    assert.equal(inr.markup_amount,50);
    assert.equal(aed.markup_amount,50);
    assert.equal(inr.total_amount,aed.total_amount,'8800 INR and 367.25 AED are the same fare');
  });

  test('POOMAS display prices are converted without adding agency markup', () => {
    const offer=ltNormalizeOffer('poomas',{id:'F1',isBookable:true,supplier:'DUFFEL',displayPrice:367.25,currency:'AED'},
      {markup_type:'fixed',markup_value:99,fx:fx('INR')});
    assert.equal(offer.currency,'INR');
    assert.equal(offer.total_amount,8800);
    assert.equal(offer.markup_amount,0);
  });

  test('never guesses a missing rate — the fare stays in supplier currency', () => {
    const offer=ltFxApplyToOffer({currency:'JPY',total_amount:50000,base_amount:0,tax_amount:0,markup_amount:0},{fx:fx('AED')});
    assert.equal(offer.fx_status,'unconverted');
    assert.equal(offer.currency,'JPY');
    assert.equal(offer.total_amount,50000);
  });

  test('without an fx context offers keep legacy behaviour', () => {
    const offer=ltNormalizeOffer('tripjack',{id:'TJ',totalPrice:1000,currency:'INR'},{markup_type:'percent',markup_value:5});
    assert.equal(offer.currency,'INR');
    assert.equal(offer.total_amount,1050);
    assert.equal(offer.fx_status,'native');
  });

  test('detects currency from phone prefix and explicit customer text', () => {
    assert.equal(ltFxCurrencyFromPhone('+91 98765 43210'),'INR');
    assert.equal(ltFxCurrencyFromPhone('971501234567'),'AED');
    assert.equal(ltFxCurrencyFromPhone('+966 50 123 4567'),'SAR');
    assert.equal(ltFxCurrencyFromPhone('97455123456'),'QAR');
    assert.equal(ltFxCurrencyFromPhone('123'),'');
    assert.equal(ltFxCurrencyFromText('price in rupees please'),'INR');
    assert.equal(ltFxCurrencyFromText('Dubai to Kochi in QAR'),'QAR');
    assert.equal(ltFxCurrencyFromText('a riyal fare'),'','bare riyal is ambiguous');
  });

  test('drift compares today\'s market rate with the locked rate minus its buffer', () => {
    const locked=3.6725/88*1.015;
    assert.equal(ltFxDriftPct(locked,'INR','AED',RATES,1.5),0);
    assert.equal(ltFxDriftPct(locked,'INR','AED',{...RATES,INR:80},1.5),10);
  });

  test('settings are clamped to safe values', () => {
    const s=ltFxNormalizeSettings({default_currency:'xyz',fx_buffer_pct:50,rounding:'weird',allow_currency_override:0});
    assert.deepEqual(s,{default_currency:'AED',fx_buffer_pct:10,rounding:'auto',allow_currency_override:0,auto_detect_phone_currency:1});
  });
});

describe('Live Agency platform-wide rate snapshot (max 4 provider calls/day)', () => {
  // One in-memory SQLite DB for the whole file: ltFxEnsureTable runs once per process.
  const sql=new DatabaseSync(':memory:');
  const st=(q,a=[])=>({bind:(...b)=>st(q,b),run:async()=>{const r=sql.prepare(q).run(...a);return {meta:{changes:r.changes}}},first:async()=>sql.prepare(q).get(...a)||null});
  const env={DB:{prepare:q=>st(q)}};
  const reset=()=>{try{sql.exec(`DELETE FROM live_travel_fx_rates`)}catch(e){}};
  let calls=0;
  const ok=rates=>async()=>{calls++;return new Response(JSON.stringify({result:'success',rates}))};
  const down=async()=>{calls++;throw new Error('offline')};
  const at=t=>new Date(`2026-10-02T${t}Z`);

  test('falls back to USD pegs when nothing was ever stored and the provider is down', async () => {
    reset();calls=0;
    const r=await ltFxRates(env,{fetchImpl:down});
    assert.equal(r.source,'usd_peg_fallback');
    assert.deepEqual(r.rates,LT_FX_USD_PEGS);
    assert.equal(r.rates.INR,undefined,'INR is never guessed');
  });

  test('every read returns the one stored snapshot and never calls the provider', async () => {
    reset();calls=0;
    await ltFxRefresh(env,{now:at('00:05:00'),fetchImpl:ok({INR:88,AED:3.6725})});
    assert.equal(calls,1);
    const a=await ltFxRates(env,{fetchImpl:ok({INR:99})}),b=await ltFxRates(env,{fetchImpl:ok({INR:99})});
    assert.equal(calls,1,'reads never refresh, however old the snapshot is');
    assert.equal(a.rates.INR,88);
    assert.deepEqual(a,b,'search, quotes, wallet and chat all see identical rates');
  });

  test('cron refreshes once per 6-hour UTC slot, so at most 4 times a day', async () => {
    reset();calls=0;
    const tick=t=>ltFxRefreshIfStale(env,{now:at(t),fetchImpl:ok({INR:88,AED:3.6725})});
    for(const t of ['00:00:00','00:15:00','05:45:00','06:00:00','06:15:00','11:59:00','12:00:00','17:30:00','18:00:00','23:45:00'])await tick(t);
    assert.equal(calls,4,'one refresh in each of 00:00, 06:00, 12:00 and 18:00 slots');
    // Same UTC day as the ticks above — "today" must not depend on when the suite runs.
    const r=await ltFxRates(env,{now:at('23:50:00')});
    assert.equal(r.refreshes_today,4);
    // Next UTC day the count starts again.
    const next=await ltFxRefreshIfStale(env,{now:new Date('2026-10-03T00:05:00Z'),fetchImpl:ok({INR:87})});
    assert.equal(next.refreshed,true);
  });

  test('a second call in the same slot is refused, from any client or isolate', async () => {
    reset();calls=0;
    const first=await ltFxRefresh(env,{now:at('01:00:00'),fetchImpl:ok({INR:88})});
    const again=await ltFxRefresh(env,{now:at('03:00:00'),fetchImpl:ok({INR:99})});
    assert.equal(first.reason,'ok');
    assert.equal(again.reason,'slot_used');
    assert.equal(calls,1);
    assert.equal((await ltFxRates(env)).rates.INR,88);
  });

  test('a provider outage still costs at most 4 calls a day and keeps the last snapshot', async () => {
    reset();calls=0;
    await ltFxRefresh(env,{now:new Date('2026-10-01T18:00:00Z'),fetchImpl:ok({INR:88})});
    calls=0;
    for(let m=0;m<24*60;m+=15)await ltFxRefreshIfStale(env,{now:new Date(Date.UTC(2026,9,2,0,m)),fetchImpl:down});
    assert.equal(calls,4,'one failed call per slot, never a retry storm');
    const r=await ltFxRates(env,{fetchImpl:down});
    assert.equal(r.rates.INR,88);
  });

  test('a brand-new deployment seeds once per slot, however many requests arrive', async () => {
    reset();calls=0;
    for(let k=0;k<25;k++)await ltFxRates(env,{fetchImpl:down});
    assert.equal(calls,1);
  });

  test('a refresh already running elsewhere is not duplicated', async () => {
    reset();calls=0;
    await ltFxRefresh(env,{now:at('00:05:00'),fetchImpl:ok({INR:88})});
    sql.prepare(`UPDATE live_travel_fx_rates SET refreshing_until=?,last_attempt_at=NULL WHERE base='USD'`).run(at('06:01:00').toISOString());
    const r=await ltFxRefresh(env,{now:at('06:00:30'),fetchImpl:ok({INR:89})});
    assert.equal(r.reason,'in_progress');
    assert.equal(calls,1);
  });

  test('fetches the keyless provider and keeps only supported currencies', async () => {
    reset();
    let url='';
    const r=await ltFxRefresh(env,{now:at('00:05:00'),fetchImpl:async u=>{url=u;return new Response(JSON.stringify({result:'success',rates:{USD:1,INR:88.1,AED:3.6725,JPY:150}}))}});
    assert.match(url,/open\.er-api\.com/);
    assert.equal(r.rates.rates.INR,88.1);
    assert.equal(r.rates.rates.JPY,undefined);
  });

  test('slot boundaries are 00, 06, 12 and 18 UTC', () => {
    assert.equal(ltFxSlotStart(at('13:47:00')).toISOString(),'2026-10-02T12:00:00.000Z');
    assert.equal(ltFxNextSlot(at('18:00:00')).toISOString(),'2026-10-03T00:00:00.000Z');
  });
});

describe('Live Agency WhatsApp currency', () => {
  test('recognises a bare currency switch but not a new search', () => {
    assert.equal(ltChatCurrencySwitch('INR'),'INR');
    assert.equal(ltChatCurrencySwitch('show prices in SAR please'),'SAR');
    assert.equal(ltChatCurrencySwitch('rupees'),'INR');
    assert.equal(ltChatCurrencySwitch('DXB to COK on 2026-10-20 in INR'),'');
    assert.equal(ltChatCurrencySwitch('book first'),'');
  });

  test('re-prices stored chat offers from the supplier amount', () => {
    const stored=[{fareId:'F1',airline:'EK',currency:'AED',total:368,supplierCurrency:'AED',supplierTotal:367.25}];
    const [o]=ltConvertStoredChatOffers(stored,fx('INR'));
    assert.equal(o.currency,'INR');
    assert.equal(o.total,8800);
    assert.equal(o.fxStatus,'converted');
  });

  test('chat list notes that a converted fare is charged in the supplier currency', () => {
    const text=ltFormatChatOffers([{airline_name:'Air',total_amount:8800,currency:'INR',supplier_currency:'AED',fx_status:'converted',bookable:true,supplier_offer_id:'f',itinerary:[{origin:'DXB',destination:'COK'}]}]);
    assert.match(text,/\*INR 8,800\*/);
    assert.match(text,/Converted from AED at today's rate; checkout is charged in AED/);
  });

  test('chat requests default to the agency currency', () => {
    assert.equal(ltNormalizeChatFlightRequest({origin:'DXB',destination:'COK',departure_date:'2026-10-20'},'QAR').currency,'QAR');
    assert.equal(ltNormalizeChatFlightRequest({currency:'kwd'},'QAR').currency,'KWD');
  });
});

describe('Live Agency WhatsApp stored options (regression: "One Way" picked an old INR fare)', () => {
  const offers=[{fareId:'a',airline:'Flynas Airline',flightNumber:'66'},{fareId:'b',airline:'Saudia',flightNumber:'SV 1'},{fareId:'c',airline:'Air India',flightNumber:'AI 9'}];

  test('answers to other questions never select a flight', () => {
    for(const t of ['One Way','one way','Round Trip','two adults','1 adult','one adult, economy','Singapore to Dubai on October 20','I need one ticket'])
      assert.equal(ltStoredOfferSelectionIndex(offers,t),-1,t);
  });

  test('explicit choices still select', () => {
    const cases={'1':0,'book first':0,'Book Option 2':1,'book second':1,'second':1,'the third one':2,'option two':1,'2nd':1,'first please':0,'saudia':1};
    for(const [t,want] of Object.entries(cases))assert.equal(ltStoredOfferSelectionIndex(offers,t),want,t);
  });

  test('customer currency: asked > phone country > agency default', () => {
    const on={default_currency:'AED',allow_currency_override:1,auto_detect_phone_currency:1};
    assert.equal(ltChatCustomerCurrency(on,'+966509980182'),'SAR');
    assert.equal(ltChatCustomerCurrency(on,'+966509980182','INR'),'INR');
    assert.equal(ltChatCustomerCurrency({...on,auto_detect_phone_currency:0},'+966509980182'),'AED');
    assert.equal(ltChatCustomerCurrency({...on,allow_currency_override:0},'+966509980182','INR'),'AED');
  });

  test('an option saved in INR before currency support is re-priced into SAR, and re-pricing is stable', () => {
    const legacy=[{fareId:'f',airline:'Flynas Airline',currency:'INR',total:34100}];
    const sar=ltConvertStoredChatOffers(legacy,fx('SAR',{rounding:'auto'}));
    assert.equal(sar[0].currency,'SAR');
    assert.equal(sar[0].total,Math.ceil(34100*3.75/88));
    assert.equal(sar[0].supplierCurrency,'INR');
    assert.equal(sar[0].supplierTotal,34100);
    assert.deepEqual(ltConvertStoredChatOffers(sar,fx('SAR',{rounding:'auto'})),sar,'converting again does not compound');
  });
});
