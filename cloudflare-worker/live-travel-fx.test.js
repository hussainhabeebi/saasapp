import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ltFxRate, ltFxRound, ltFxFormat, ltFxApplyToOffer, ltFxCurrencyFromPhone, ltFxCurrencyFromText,
  ltFxDriftPct, ltFxNormalizeSettings, ltFxRates, ltFxResetMemoryCache, LT_FX_USD_PEGS,
} from './live-travel-fx.js';
import { ltNormalizeOffer, ltChatCurrencySwitch, ltConvertStoredChatOffers, ltFormatChatOffers, ltNormalizeChatFlightRequest } from './worker.js';

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

describe('Live Agency rate cache', () => {
  const db=row=>({prepare:sql=>({bind:()=>({first:async()=>row,run:async()=>({})}),first:async()=>/SELECT/.test(sql)?row:null,run:async()=>({})})});

  test('falls back to USD pegs when the provider fails and nothing is stored', async () => {
    ltFxResetMemoryCache();
    const r=await ltFxRates({DB:db(null)},{fetchImpl:async()=>{throw new Error('offline')}});
    assert.equal(r.source,'usd_peg_fallback');
    assert.deepEqual(r.rates,LT_FX_USD_PEGS);
    assert.equal(r.rates.INR,undefined,'INR is never guessed');
  });

  test('uses stored rates (marked stale) when the provider fails', async () => {
    ltFxResetMemoryCache();
    const old={rates_json:JSON.stringify({INR:87}),source:'exchangerate-api',fetched_at:'2020-01-01T00:00:00Z'};
    const r=await ltFxRates({DB:db(old)},{fetchImpl:async()=>{throw new Error('offline')}});
    assert.equal(r.rates.INR,87);
    assert.equal(r.stale,true);
  });

  test('fetches the keyless provider and keeps only supported currencies', async () => {
    ltFxResetMemoryCache();
    let url='';
    const r=await ltFxRates({DB:db(null)},{fetchImpl:async u=>{url=u;return new Response(JSON.stringify({result:'success',rates:{USD:1,INR:88.1,AED:3.6725,JPY:150}}))}});
    assert.match(url,/open\.er-api\.com/);
    assert.equal(r.rates.INR,88.1);
    assert.equal(r.rates.JPY,undefined);
    assert.equal(r.stale,false);
    ltFxResetMemoryCache();
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
