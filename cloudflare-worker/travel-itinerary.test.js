import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taFindPackageInText, taPackageFollowUp, taMatchItinerary, taPackageItineraryText, taBuildItineraryPdf, taItineraryPdfName, taPackagePrice } from './travel-itinerary.js';
import { engineHandleTravelPackage } from './worker.js';

const pkgs = [
  { Id: 1, name: 'HYDERABAD FLIGHT PACKAGE', destination: 'HYDERABAD', nights: 3, pax_min: 1, pax_max: 99, currency: 'INR', sell_price: 24900 },
  { Id: 2, name: 'HYDERABAD TRAIN PACKAGE', destination: 'HYDERABAD', nights: 3, pax_min: 1, pax_max: 99, currency: 'INR', sell_price: 0, base_price: 11499,
    inclusions: '["Train tickets","3* hotel","Breakfast"]', exclusions: '["Lunch"]', notes: 'Ramoji Film City entry extra.' },
  { Id: 3, name: 'HYDERABAD BUSS PACKAGE', destination: 'HYDERABAD', nights: 2, currency: 'INR', sell_price: 14999 },
];
const itins = [
  { Id: 9, title: 'Hyderabad Train Package', from_date: '2026-11-10', to_date: '2026-11-13',
    days: JSON.stringify([{ day_no: 1, title: 'Arrival', items: [{ type: 'transfer', description: 'Pickup from Secunderabad station' }, { type: 'hotel', description: 'Check-in' }] },
      { day_no: 2, title: 'City tour', items: [{ type: 'activity', description: 'Charminar & Golconda Fort' }] }]) },
  { Id: 10, title: 'Empty one', days: '[]' },
];

test('finds the one package a message names, ignoring words like "package"', () => {
  assert.equal(taFindPackageInText(pkgs, 'Hyderabad train package details')?.Id, 2);
  assert.equal(taFindPackageInText(pkgs, 'hyderabad train')?.Id, 2);
  assert.equal(taFindPackageInText(pkgs, 'hyderabad package'), null);
  assert.equal(taFindPackageInText(pkgs, 'hello'), null);
});

test('details / pdf follow-ups', () => {
  assert.equal(taPackageFollowUp('Other details'), 'details');
  assert.equal(taPackageFollowUp('Itinerary'), 'details');
  assert.equal(taPackageFollowUp('send pdf please'), 'pdf');
  assert.equal(taPackageFollowUp('yes'), null);
});

test('price falls back to base_price; itinerary matched by package name', () => {
  assert.equal(taPackagePrice(pkgs[1]), 11499);
  assert.equal(taMatchItinerary(pkgs[1], itins)?.Id, 9);
  assert.equal(taMatchItinerary(pkgs[0], itins), null);
});

test('itinerary text reads like an agent wrote it, without invented days', () => {
  const t = taPackageItineraryText(pkgs[1], taMatchItinerary(pkgs[1], itins));
  assert.match(t, /^🏝️ \*HYDERABAD TRAIN PACKAGE\*/);
  assert.match(t, /🌙 3 nights \/ 4 days/);
  assert.match(t, /💰 \*INR 11,499\* per person/);
  assert.match(t, /\*Day 1 – Arrival\*\n🚌 Pickup from Secunderabad station\n🏨 Check-in/);
  assert.match(t, /✅ \*Includes\*\n• Train tickets\n• 3\* hotel/);
  assert.match(t, /❌ \*Excludes\*\n• Lunch/);
  assert.doesNotMatch(t, /1–99/);
  const plain = taPackageItineraryText(pkgs[0], null);
  assert.doesNotMatch(plain, /Day-wise/);
  assert.match(plain, /INR 24,900/);
});

test('PDF is a valid multi-page document with the package content', () => {
  const long = { ...taMatchItinerary(pkgs[1], itins), days: JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ day_no: i + 1, title: `Day (${i + 1}) ✨`, items: [{ type: 'activity', description: 'Sightseeing '.repeat(20) }] }))) };
  const bytes = taBuildItineraryPdf(pkgs[1], long, { agencyName: 'Fly Indo Holidays', agencyPhone: '+91 70254 44507' });
  const s = new TextDecoder().decode(bytes);
  assert.ok(s.startsWith('%PDF-1.4'));
  assert.ok(s.trimEnd().endsWith('%%EOF'));
  assert.ok(!/[^\x00-\x7F]/.test(s), 'all ASCII');
  const count = Number(/\/Count (\d+)/.exec(s)[1]);
  assert.ok(count > 1);
  assert.match(s, /\(HYDERABAD TRAIN PACKAGE\) Tj/);
  assert.match(s, /\(INR 11,499 per person\) Tj/);
  assert.match(s, /Day 1 - Day \\\(1\\\)/);
  assert.match(s, new RegExp(`\\(Page ${count} of ${count}\\) Tj`));
  // xref offsets point at their objects
  const xref = Number(/startxref\n(\d+)/.exec(s)[1]);
  assert.ok(s.slice(xref).startsWith('xref'));
  const offs = [...s.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map(m => Number(m[1]));
  offs.forEach((o, i) => assert.ok(s.slice(o).startsWith(`${i + 1} 0 obj`)));
  assert.equal(taItineraryPdfName(pkgs[1]), 'Itinerary-HYDERABAD-TRAIN-PACKAGE.pdf');
});

function stubEnv(calls) {
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, opts });
    if (u.includes('/tables/tpk/')) return Response.json({ list: pkgs });
    if (u.includes('/tables/tit/')) return Response.json({ list: itins });
    if (u.includes('/messages')) return Response.json({ id: 1 });
    return Response.json({});
  };
  return { NOCODB_BASE: 'https://nc.test', NOCODB_TOKEN: 't' };
}
const client = { industry: 'travel', client_name: 'Fly Indo Holidays', ta_table_ids: JSON.stringify({ packages: 'tpk', itineraries: 'tit' }),
  chatwoot_base: 'https://cw.test', chatwoot_account_id: '1', chatwoot_token: 'x' };

test('a package name gets the itinerary with PDF / Book buttons, and the PDF tap sends a PDF', async () => {
  const calls = [];
  const env = stubEnv(calls);
  const state = { convId: 55, stage: 'new', activeHistory: [] };
  const r = await engineHandleTravelPackage(env, client, 7, state, 'Hyderabad train package', 'text');
  assert.match(r.turn.text, /Day 1 – Arrival/);
  const offered = await r.turn.deliver();
  assert.deepEqual(offered.map(o => o.value), ['TPKGPDF:2', 'TPKGENQ:2', 'INTRO_HUMAN']);

  calls.length = 0;
  const pdf = await engineHandleTravelPackage(env, client, 7, state, 'TPKGPDF:2', 'text');
  await pdf.turn.deliver();
  const att = calls.find(c => c.opts.body instanceof FormData && c.opts.body.get('attachments[]'));
  assert.ok(att);
  const file = att.opts.body.get('attachments[]');
  assert.equal(file.type, 'application/pdf');
  assert.equal(file.name, 'Itinerary-HYDERABAD-TRAIN-PACKAGE.pdf');

  // "Other details" after the bot described a package refers back to it
  const follow = await engineHandleTravelPackage(env, client, 7, { ...state, activeHistory: [{ role: 'assistant', content: 'The HYDERABAD TRAIN PACKAGE is for 3 nights.' }] }, 'Other details', 'text');
  assert.match(follow.turn.text, /HYDERABAD TRAIN PACKAGE/);

  // not about a package, or answering the booking questions → normal path
  assert.equal(await engineHandleTravelPackage(env, client, 7, state, 'what visas do you do', 'text'), null);
  assert.equal(await engineHandleTravelPackage(env, client, 7, { ...state, activeHistory: [{ role: 'assistant', content: 'Please send:\n• your travel date' }] }, 'hyderabad train 2 adults', 'text'), null);
  assert.equal(await engineHandleTravelPackage(env, { ...client, industry: 'ecommerce' }, 7, state, 'Hyderabad train package', 'text'), null);
});
