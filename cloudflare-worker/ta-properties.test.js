import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taPropertyClean, taPropertyMediaRequest, taPropertiesInText, taPropertyMediaPlan, taPropertyMediaItems, taPropertyContextLines, taPropertyMediaUrlError } from './ta-properties.js';

const drive = id => `https://drive.google.com/file/d/${id}/view?usp=sharing`;
const props = [
  { id: 1, name: 'Spice Village Resort', property_type: 'resort', location: 'Thekkady', star_rating: 4, price_from: 8500, currency: 'INR', price_unit: 'per night',
    image_url: drive('img1'), image_url_2: drive('img2'), video_url: drive('vid1'), pdf_url: drive('pdf1'), status: 'active' },
  { id: 2, name: 'Taj Bekal Hotel', property_type: 'hotel', location: 'Bekal', image_url: drive('img3'), status: 'active' },
  { id: 3, name: 'Beach Resort', property_type: 'resort', location: 'Kovalam', pdf_url: drive('pdf3'), status: 'active' },
  { id: 4, name: 'Old Closed Resort', image_url: drive('img4'), status: 'inactive' },
  { id: 5, name: 'No Media Hotel', status: 'active' },
];

test('a lead naming a property gets all of its media', () => {
  const plan = taPropertyMediaPlan(props, { userText: 'Is spice village resort available in December?' });
  assert.deepEqual(plan.properties.map(p => p.id), [1]);
  assert.deepEqual(plan.kinds, { images: true, video: true, pdf: true });
  assert.equal(plan.explicit, false);
});

test('distinctive words match without the generic suffix', () => {
  assert.deepEqual(taPropertiesInText(props, 'how much for spice village?').map(p => p.id), [1]);
  assert.deepEqual(taPropertiesInText(props, 'any beach resort?').map(p => p.id), [3]);
  assert.deepEqual(taPropertiesInText(props, 'beach please').map(p => p.id), []);
});

test('asking for photos sends only photos of the property the bot just talked about', () => {
  const plan = taPropertyMediaPlan(props, { userText: 'send photos', replyText: 'Sure! Here are the photos.', previousBotText: 'Taj Bekal Hotel is a great sea-view option.' });
  assert.deepEqual(plan.properties.map(p => p.id), [2]);
  assert.deepEqual(plan.kinds, { images: true, video: false, pdf: false });
  assert.equal(plan.explicit, true);
  assert.deepEqual(taPropertyMediaItems(plan.properties[0], plan.kinds).map(i => i.field), ['image_url']);
});

test('a media ask that cannot be pinned to one property sends nothing', () => {
  assert.equal(taPropertyMediaPlan(props, { userText: 'send pics', replyText: 'We have Spice Village Resort and Taj Bekal Hotel.' }), null);
});

test('the only property with media is sent on a bare photo ask', () => {
  const plan = taPropertyMediaPlan([props[1]], { userText: 'can I see pictures?' });
  assert.deepEqual(plan.properties.map(p => p.id), [2]);
});

test('a reply recommending one property volunteers its media; a long list does not', () => {
  const one = taPropertyMediaPlan(props, { userText: 'suggest a resort in thekkady', replyText: 'I recommend Spice Village Resort in Thekkady.' });
  assert.deepEqual(one.properties.map(p => p.id), [1]);
  assert.equal(one.explicit, false);
  const many = taPropertyMediaPlan(props, { userText: 'options?', replyText: 'Spice Village Resort, Taj Bekal Hotel and Beach Resort are available.' });
  assert.equal(many, null);
});

test('inactive and media-less properties are never sent', () => {
  assert.equal(taPropertyMediaPlan(props, { userText: 'old closed resort photos' }), null);
  assert.equal(taPropertyMediaPlan(props, { userText: 'no media hotel photos', replyText: '' }), null);
});

test('media items go photos, video, brochure with a caption on the first', () => {
  const items = taPropertyMediaItems(props[0]);
  assert.deepEqual(items.map(i => i.field), ['image_url', 'image_url_2', 'video_url', 'pdf_url']);
  assert.match(items[0].caption, /Spice Village Resort ⭐⭐⭐⭐ — Thekkady\nFrom INR 8,500 per night/);
  assert.equal(items[3].filename, 'spice-village-resort-brochure.pdf');
});

test('media request detection', () => {
  assert.deepEqual(taPropertyMediaRequest('video please'), { images: false, video: true, pdf: false });
  assert.deepEqual(taPropertyMediaRequest('send the brochure'), { images: false, video: false, pdf: true });
  assert.equal(taPropertyMediaRequest('what is the price'), null);
});

test('save validation rejects Drive folders and bad links', () => {
  assert.match(taPropertyClean({ name: 'X', image_url: 'https://drive.google.com/drive/folders/abc' }).error, /not a folder/);
  assert.match(taPropertyClean({ name: 'X', pdf_url: 'drive.google.com/file/d/x' }).error, /https/);
  assert.equal(taPropertyMediaUrlError('video_url', drive('ok')), '');
  assert.match(taPropertyClean({}).error, /name is required/);
  const { values } = taPropertyClean({ name: ' Hill View ', star_rating: '9', price_from: '', property_type: 'castle' });
  assert.equal(values.name, 'Hill View');
  assert.equal(values.star_rating, null);
  assert.equal(values.price_from, null);
  assert.equal(values.property_type, 'resort');
  assert.deepEqual(Object.keys(taPropertyClean({ status: 'inactive' }, true).values), ['status']);
});

test('bot context lists active properties and tells the model media is sent for it', () => {
  const lines = taPropertyContextLines(props);
  assert.equal(lines[0], '## Resorts & Hotels');
  assert.ok(lines.some(l => l.includes('Spice Village Resort (resort, 4-star) — Thekkady — from INR 8500 per night') && l.includes('photos, video, PDF brochure available')));
  assert.ok(!lines.some(l => l.includes('Old Closed Resort')));
  assert.match(lines.at(-1), /never say you cannot send photos/);
});
