import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taFindPackageInText, taPackagesForLocation, taPackageMediaItems, taPackageFollowUp, taMatchItinerary, taPackageItineraryText, taBuildItineraryPdf, taItineraryPdfName, taPackagePrice, taParseNotesPlan, taPrepareImage, taFetchItineraryAssets } from './travel-itinerary.js';
import { deflateSync } from 'node:zlib';
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
  assert.match(s, /\(INR 11,499\) Tj/);
  assert.match(s, /\(PRICE PER PERSON\) Tj/);
  assert.match(s, /DAY 1\) Tj/);
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

const notesPkg = { Id: 4, name: 'HYDERABAD FLIGHT PACKAGE', destination: 'HYDERABAD', nights: 3, currency: 'INR', sell_price: 24500,
  notes: 'Hotel check-in 12 PM. DAY 01 - Sightseeing Golconda Fort, Seven Tombs, Buddha StatueDAY 2 - Salar Jung Museum, Charminar, Shopping DAY 4 - Ramoji Film City' };

test('a day plan typed into the package notes becomes days', () => {
  const p = taParseNotesPlan(notesPkg.notes);
  assert.equal(p.notes, 'Hotel check-in 12 PM.');
  assert.deepEqual(p.days.map(d => d.day_no), [1, 2, 4]);
  assert.equal(p.days[0].title, 'Sightseeing: Golconda Fort, Seven Tombs & more');
  assert.deepEqual(p.days[0].items.map(i => i.description), ['Golconda Fort', 'Seven Tombs', 'Buddha Statue']);
  assert.deepEqual(p.days[1].items.map(i => i.description), ['Salar Jung Museum', 'Charminar', 'Shopping']);
  assert.equal(p.days[2].title, 'Ramoji Film City');
  const t = taPackageItineraryText(notesPkg, null);
  assert.match(t, /\*Day 2 – Salar Jung Museum & Charminar\*\n📍 Salar Jung Museum/);
  assert.match(t, /📝 Hotel check-in 12 PM\./);
  assert.doesNotMatch(t, /DAY 01/);
  assert.deepEqual(taParseNotesPlan('Free cancellation. Holiday 2 nights.').days, []);
});

function png(w, h, rgba) {
  const crc = b => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length); b.write(t, 4); d.copy(b, 8); b.writeUInt32BE(crc(b.subarray(4, 8 + d.length)), 8 + d.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = y % 2 ? 2 : 1; Buffer.from(rgba(y)).copy(raw, y * (w * 4 + 1) + 1); }
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
const JPEG = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 0, 0, 0xFF, 0xC0, 0, 11, 8, 0, 30, 0, 40, 3, 1, 0x11, 0, 0xFF, 0xD9]);

test('images: JPEG kept as-is, PNG decoded with its alpha, anything else skipped', async () => {
  const j = await taPrepareImage(JPEG);
  assert.deepEqual([j.filter, j.w, j.h, j.cs], ['DCTDecode', 40, 30, 'DeviceRGB']);
  // filtered rows (Sub / Up) with a transparent pixel
  const p = await taPrepareImage(png(2, 2, () => [10, 20, 30, 255, 0, 0, 0, 0]));
  assert.deepEqual([p.filter, p.w, p.h], ['FlateDecode', 2, 2]);
  assert.ok(p.smask);
  assert.equal(await taPrepareImage(new Uint8Array([1, 2, 3])), null);
});

test('assets: logo + cover + place photos from Wikipedia, unrelated articles dropped', async () => {
  const seen = [];
  const fakeFetch = async url => {
    url = String(url); seen.push(url);
    if (url.includes('api.php')) {
      const q = decodeURIComponent(/gsrsearch=([^&]+)/.exec(url)[1]);
      if (q.startsWith('Shopping')) return Response.json({ query: { pages: [{ title: 'Retail', extract: 'x' }] } });
      const title = q.replace(/ Hyderabad$/, '');
      return Response.json({ query: { pages: [{ title, extract: `${title} (est. 1591) is famous.`, thumbnail: { source: `https://img.test/${encodeURIComponent(title)}.jpg` } }] } });
    }
    if (url.startsWith('https://img.test/') || url.includes('logo')) return new Response(JPEG);
    return new Response('', { status: 404 });
  };
  const a = await taFetchItineraryAssets(notesPkg, null, { logoUrl: 'https://cdn.test/logo.jpg', fetchImpl: fakeFetch });
  assert.equal(a.logo.filter, 'DCTDecode');
  assert.equal(a.cover.title, 'Hyderabad');
  assert.equal(a.places.get('charminar').extract, 'Charminar is famous.');
  assert.ok(a.places.get('golconda fort').image);
  assert.ok(!seen.some(u => /gsrsearch=Shopping/.test(u)), 'activities are not looked up');
  const pdf = new TextDecoder('latin1').decode(taBuildItineraryPdf(notesPkg, null, { agencyName: 'Fly Indo', assets: a }));
  assert.match(pdf, /\/Subtype \/Image/);
  assert.match(pdf, /\(About Hyderabad\) Tj/);
  assert.match(pdf, /Wikimedia Commons/);
  const xref = Number(/startxref\n(\d+)/.exec(pdf)[1]);
  const offs = [...pdf.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map(m => Number(m[1]));
  offs.forEach((o, i) => assert.ok(pdf.slice(o).startsWith(`${i + 1} 0 obj`)));
});

test('child rates and per-day details from the detailed itinerary builder', () => {
  const pkg = { ...pkgs[2], child_price: 9999, child_nobed_price: 7999, infant_price: 0 };
  const itin = { title: 'HYDERABAD BUSS PACKAGE', days: JSON.stringify([
    { day_no: 1, title: 'Arrival', description: 'Reach Hyderabad by morning.', meals: ['B', 'D'], overnight: 'Hotel Sitara',
      items: [{ type: 'activity', time: '16:00', description: 'Charminar' }] }]) };
  const text = taPackageItineraryText(pkg, itin);
  assert.match(text, /💰 \*INR 14,999\* per person/);
  assert.match(text, /👶 Child \(with bed\): \*INR 9,999\*/);
  assert.match(text, /👶 Child \(no bed\): \*INR 7,999\*/);
  assert.doesNotMatch(text, /Infant/);
  assert.match(text, /Reach Hyderabad by morning\./);
  assert.match(text, /📍 16:00 Charminar/);
  assert.match(text, /🍽️ Breakfast, Dinner/);
  assert.match(text, /🌙 Overnight: Hotel Sitara/);
});

test('a destination named in the message finds its packages; flight routes and visa asks do not', () => {
  const list = [...pkgs, { Id: 5, name: 'Bali Honeymoon 5N', destination: 'Bali, Indonesia' }];
  assert.deepEqual(taPackagesForLocation(list, 'bali').map(p => p.Id), [5]);
  assert.deepEqual(taPackagesForLocation(list, 'Any trip to Bali?').map(p => p.Id), [5]);
  assert.deepEqual(taPackagesForLocation(list, 'I want to go to bali in december').map(p => p.Id), [5]);
  assert.deepEqual(taPackagesForLocation(list, 'hyderabad package').map(p => p.Id), [1, 2, 3]);
  assert.deepEqual(taPackagesForLocation(list, 'Kochi to Bali'), []);
  assert.deepEqual(taPackagesForLocation(list, 'bali flight tickets'), []);
  assert.deepEqual(taPackagesForLocation(list, 'bali visa'), []);
  assert.deepEqual(taPackagesForLocation(list, 'indonesian food'), []);
});

test('package media: photos then brochure, caption on the first; cover only when not full', () => {
  const p = { name: 'Bali Honeymoon 5N', destination: 'Bali', nights: 5, currency: 'INR', sell_price: 45000,
    image_url: 'https://drive.google.com/file/d/i1/view', image_url_3: 'https://drive.google.com/file/d/i3/view', pdf_url: 'https://drive.google.com/file/d/p1/view' };
  const items = taPackageMediaItems(p);
  assert.deepEqual(items.map(i => i.kind), ['image', 'image', 'pdf']);
  assert.match(items[0].caption, /Bali Honeymoon 5N\* — Bali\n5 nights \/ 6 days · From INR 45,000 per person/);
  assert.equal(items[2].filename, 'Bali-Honeymoon-5N.pdf');
  assert.deepEqual(taPackageMediaItems(p, { full: false }).map(i => i.kind), ['image', 'pdf']);
  assert.deepEqual(taPackageMediaItems({ name: 'x' }), []);
});

const JPEG_BYTES = new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]);
function mediaEnv(calls, list) {
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, opts });
    if (u.includes('/tables/tpk/')) return Response.json({ list });
    if (u.includes('/tables/tit/')) return Response.json({ list: [] });
    if (u.includes('/messages')) return Response.json({ id: 1 });
    if (u.includes('drive.google.com/thumbnail?id=good')) return new Response(new Blob([JPEG_BYTES], { type: 'image/jpeg' }));
    // Drive labels the PDF octet-stream; the %PDF header is what counts
    if (u.includes('drive.google.com/uc?export=download&id=pdf1')) return new Response(new Blob(['%PDF-1.4'], { type: 'application/octet-stream' }), { headers: { 'content-type': 'application/octet-stream' } });
    // larger file: Drive's newer "can't scan for viruses" form, then the real download
    if (u.includes('drive.google.com/uc?export=download&id=big1')) return new Response('<form id="download-form" action="https://drive.usercontent.google.com/download" method="get"><input type="hidden" name="id" value="big1"><input type="hidden" name="export" value="download"><input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="u-1"></form>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (u.startsWith('https://drive.usercontent.google.com/download?id=big1&export=download&confirm=t&uuid=u-1')) return new Response(new Blob(['%PDF-1.7 big'], { type: 'application/octet-stream' }), { headers: { 'content-type': 'application/octet-stream' } });
    return new Response('nope', { status: 404 });
  };
  return { NOCODB_BASE: 'https://nc.test', NOCODB_TOKEN: 't' };
}
const sent = calls => calls.filter(c => c.url.includes('/messages')).map(c => c.opts.body instanceof FormData
  ? { file: c.opts.body.get('attachments[]')?.name, content: c.opts.body.get('content'), text: c.opts.body.get('attachments[]') ? undefined : c.opts.body.get('content') }
  : { text: JSON.parse(c.opts.body).content });

test('naming a package or its destination sends its photos and PDF straight into the chat', async () => {
  const bali = { Id: 5, name: 'Bali Honeymoon 5N', destination: 'Bali, Indonesia', nights: 5, currency: 'INR', sell_price: 45000,
    image_url: 'https://drive.google.com/file/d/good/view', image_url_2: 'https://drive.google.com/file/d/private/view', pdf_url: 'https://drive.google.com/file/d/pdf1/view' };
  const calls = [];
  const env = mediaEnv(calls, [...pkgs, bali]);
  const state = { convId: 55, stage: 'new', activeHistory: [] };

  const r = await engineHandleTravelPackage(env, client, 7, state, 'Hi, any bali trip?', 'text');
  assert.equal(r.turn.route, 'travel_package');
  await r.turn.deliver();
  const out = sent(calls);
  assert.equal(out[0].file, 'photo.jpg');
  assert.match(out[0].content, /Bali Honeymoon 5N/);
  // the photo that couldn't be fetched goes as its link, the PDF as a real attachment
  assert.equal(out[1].file, 'Bali-Honeymoon-5N.pdf');
  assert.ok(out.some(o => /📷 Photo: https:\/\/drive.google.com\/file\/d\/private/.test(o.text || '')));
  assert.ok(out.some(o => /Day|Bali Honeymoon 5N/.test(o.text || o.content || '')));

  // several packages for one destination → a list with a button per package
  calls.length = 0;
  const many = await engineHandleTravelPackage(env, client, 7, state, 'hyderabad', 'text');
  assert.match(many.turn.text, /3 packages for \*HYDERABAD\*/);
  const offered = await many.turn.deliver();
  assert.deepEqual(offered.map(o => o.value), ['TPKG:1', 'TPKG:2', 'TPKG:3']);

  // a flight route mentioning the destination is left to the flight path
  assert.equal(await engineHandleTravelPackage(env, client, 7, state, 'Kochi to Bali 12 Dec', 'text'), null);

  // the PDF button sends the agency's own brochure rather than the generated itinerary
  calls.length = 0;
  const pdf = await engineHandleTravelPackage(env, client, 7, state, 'TPKGPDF:5', 'text');
  await pdf.turn.deliver();
  const files = sent(calls).filter(o => o.file).map(o => o.file);
  assert.deepEqual(files, ['Bali-Honeymoon-5N.pdf']);
  const att = calls.find(c => c.opts.body instanceof FormData && c.opts.body.get('attachments[]')).opts.body.get('attachments[]');
  assert.equal(att.type, 'application/pdf');

  // a PDF behind Drive's virus-scan page still goes as the file, not its link
  const georgia = { Id: 6, name: 'GEORGIA TRIP', destination: 'Georgia', pdf_url: 'https://drive.google.com/file/d/big1/view?usp=sharing' };
  const env2 = mediaEnv(calls, [georgia]);
  calls.length = 0;
  const g = await engineHandleTravelPackage(env2, client, 7, state, 'georgia trip', 'text');
  await g.turn.deliver();
  const out2 = sent(calls);
  assert.equal(out2[0].file, 'GEORGIA-TRIP.pdf');
  assert.ok(!out2.some(o => /Brochure: https/.test(o.text || '')));
});
