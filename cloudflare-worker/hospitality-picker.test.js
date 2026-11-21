// Resort WhatsApp pickers (worker.js): lists over WhatsApp's 10-row limit are paged instead of
// silently cut, the "More" tap is recognised (and not mistaken for dates by Hospitality Pro), and
// locations match by city part so imported "Munnar, Kerala" and typed "Munnar" are one destination.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hospPickerItems, hospMoreTap, hospLocKey } from './worker.js';
import { hpParseDateRange } from './hospitality-pro.js';

const names=n=>Array.from({length:n}, (_, i)=>`Resort ${String(i+1).padStart(2,'0')}`);

test('10 or fewer names are sent as they are', ()=>{
  assert.deepEqual(hospPickerItems(['A','B']), [{title:'A', value:'A'}, {title:'B', value:'B'}]);
  assert.equal(hospPickerItems(names(10), 'properties').length, 10);
});

test('more than 10 names are paged 9 at a time, and every name is reachable', ()=>{
  const all=names(25);
  const seen=[];
  for(let page=1; page<=3; page++){
    const items=hospPickerItems(all, 'properties', page);
    assert.ok(items.length<=10);
    const more=items.at(-1);
    assert.equal(more.title, `More properties · page ${page===3?1:page+1}`);
    assert.ok(more.title.length<=24);
    assert.deepEqual(hospMoreTap(more.title), {kind:'properties', page:page===3?1:page+1});
    seen.push(...items.slice(0,-1).map(i=>i.title));
  }
  assert.deepEqual(seen, all);
  assert.equal(hospPickerItems(all, 'properties', 99).at(-1).title, 'More properties · page 1'); // out of range → last page
});

test('very long lists keep the label within 24 characters', ()=>{
  const items=hospPickerItems(names(120), 'properties', 9);
  assert.equal(items.at(-1).title, 'Properties · page 10');
  assert.deepEqual(hospMoreTap('Properties · page 10'), {kind:'properties', page:10});
  assert.deepEqual(hospMoreTap('More rooms · page 2'), {kind:'rooms', page:2});
});

test('ordinary messages are not "More" taps, and the label is not a date', ()=>{
  for(const t of ['more properties please', 'rooms', 'Deluxe Rooms', 'page 2']) assert.equal(hospMoreTap(t), null);
  assert.equal(hpParseDateRange('More properties · page 2', '2026-11-12'), null);
  assert.equal(hpParseDateRange('More rooms · page 3', '2026-11-12'), null);
});

test('location key is the city part', ()=>{
  assert.equal(hospLocKey('Munnar, Kerala'), 'munnar');
  assert.equal(hospLocKey(' Munnar '), 'munnar');
  assert.equal(hospLocKey(''), '');
  assert.equal(hospLocKey(null), '');
});
