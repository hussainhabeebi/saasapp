// Custom API connector (Live Agency → Suppliers → Custom API): checkout links and currency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ltOfferCheckoutLink, ltCustomOfferCtx, ltNormalizeOffer, ltConvertStoredChatOffers } from './worker.js';
import { ltCheckoutUrl } from './live-travel-wa-menu.js';

test('checkout link: site base gets /book?fareId=…, a {fareId} template is used as written',()=>{
  assert.equal(ltOfferCheckoutLink('https://tripcod.com/',{fareId:'F 1',supplier:'DUFFEL',clientId:7}),'https://tripcod.com/book?fareId=F%201&supplier=DUFFEL&source=leadvyne&client=7');
  assert.equal(ltOfferCheckoutLink('https://tripcod.com/checkout/{fareId}?src=wa',{fareId:'F1'}),'https://tripcod.com/checkout/F1?src=wa');
  assert.equal(ltOfferCheckoutLink('',{fareId:'F1'}),'');
  const selected={fareId:'F1',supplier:'DUFFEL',checkoutBase:'https://tripcod.com/checkout/{fareId}?src=wa'};
  assert.equal(ltCheckoutUrl(selected,7,{passenger:{name:'Asha Nair',email:'a@x.com'},phone:'+971500000000',adults:2}),
    'https://tripcod.com/checkout/F1?src=wa&first_name=Asha&last_name=Nair&email=a%40x.com&phone=%2B971500000000&adults=2');
});

test('a connector currency is shown unconverted and never re-priced; without one the agency rate applies',()=>{
  const raw={id:'F1',isBookable:true,displayPrice:21500,currency:'INR',airlineName:'IndiGo',origin:'DXB',destination:'BOM'};
  const fx={target:'AED',rate:0.044,source:'test'};
  const fixed=ltNormalizeOffer('custom',raw,ltCustomOfferCtx({endpoints:{currency:'INR',checkout:'https://tripcod.com'}},{fx,markup_type:'percent',markup_value:10,client_id:7}));
  assert.equal(fixed.currency,'INR');
  assert.equal(fixed.total_amount,21500,'no conversion and no agency markup');
  assert.equal(fixed.raw._fixed_currency,true);
  assert.match(fixed.checkout_url,/^https:\/\/tripcod\.com\/book\?fareId=F1/);
  const stored=[{fareId:'F1',currency:'INR',total:21500,fixedCurrency:true}];
  assert.deepEqual(ltConvertStoredChatOffers(stored,fx),stored);
  // A generic (non-POOMAS-shaped) fare from the connector is still bookable through its link.
  const generic=ltNormalizeOffer('custom',{id:'G1',total_amount:900,currency:'AED',airline:'EK'},ltCustomOfferCtx({endpoints:{checkout:'https://tripcod.com'}},{client_id:7}));
  assert.equal(generic.supplier,'custom');
  assert.equal(generic.bookable,true);
  assert.equal(generic.total_amount,900);
  assert.match(generic.checkout_url,/fareId=G1/);
});
