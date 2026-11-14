// Settings → Travel Agency → itinerary options on the Travel Agency page: auto-added photos for
// items without one, and the 📲 WA send attaching the itinerary PDF when "Share as PDF" is on.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pageUrl = 'file://' + path.resolve(__dirname, '../travel-agency.html') + '?client=7&token=t';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function open(page, handlers = {}) {
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('file://')) return route.continue();
    for (const [part, fn] of Object.entries(handlers)) if (url.includes(part)) return fn(route);
    return route.abort();
  });
  await page.goto(pageUrl);
  await page.waitForFunction(() => typeof itinWithAutoImages === 'function');
}

test('auto images: past itinerary photo, then a matching Property photo, one per day, uploads win', async ({ page }) => {
  const driveIds = [];
  await open(page, { '/travel/drive-image': (route) => { driveIds.push(new URL(route.request().url()).searchParams.get('id')); return route.fulfill({ json: { data_url: PNG } }); } });
  const out = await page.evaluate(async (png) => {
    // @ts-ignore
    _taTravelSettings = { itin_share_pdf: false, itin_auto_images: true };
    // @ts-ignore
    _taProperties = [{ name: 'Hotel Sitara', image_url: 'https://drive.google.com/file/d/abcdefghij123/view' }];
    // @ts-ignore
    _taItineraries = [{ days: [{ items: [{ description: 'Charminar', image: 'data:image/png;base64,PAST' }] }] }];
    const it = { days: [
      { overnight: 'Hotel Sitara', items: [{ type: 'activity', description: 'Charminar' }, { type: 'hotel', description: 'Check in' }] },
      { overnight: 'Hotel Sitara', items: [{ type: 'hotel', description: 'Check in' }] },
      { items: [{ type: 'activity', description: 'Golconda', image: 'data:image/png;base64,OWN' }] },
    ] };
    // @ts-ignore
    const filled = await itinWithAutoImages(it);
    // @ts-ignore
    _taTravelSettings.itin_auto_images = false;
    // @ts-ignore
    const off = await itinWithAutoImages(it);
    return { filled: filled.days.map((d) => d.items.map((i) => i.image || '')), original: it.days[0].items[0].image || '', off: off === it };
  }, PNG);
  expect(out.filled).toEqual([['data:image/png;base64,PAST', ''], [PNG], ['data:image/png;base64,OWN']]);
  expect(out.original).toBe('');
  expect(out.off).toBe(true);
  expect(driveIds).toEqual(['abcdefghij123']);
});

test('Share as PDF: the WA send attaches the itinerary PDF to the lead chat, else offers text', async ({ page }) => {
  const sends = [], texts = [];
  await open(page, {
    '/quote/send': async (route) => { sends.push(route.request().postData() || ''); return route.fulfill({ json: { ok: true } }); },
    '/wa/send': (route) => { texts.push(JSON.parse(route.request().postData())); return route.fulfill({ json: { ok: true } }); },
    // patchClient re-reads the client record to confirm the saved itin_number_seq.
    '/api/v2/': (route) => route.fulfill({ json: route.request().method() === 'PATCH' ? {} : { Id: 7, itin_number_seq: 5 } }),
  });
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.type() === 'prompt' ? d.accept(dialogs.length === 1 ? '+971 50 123 4567' : '971559999999') : d.accept(); });
  await page.evaluate(() => {
    // @ts-ignore
    clientRecord = { client_name: 'Test Travels', itin_number_seq: 4 };
    // @ts-ignore
    _taTravelSettings = { itin_share_pdf: true, itin_auto_images: false };
    // @ts-ignore
    allLeads = [{ Id: 11, Name: 'Asha', Phone: '971501234567', ConversationID: '88' }];
    // @ts-ignore
    _taItineraries = [{ Id: 1, title: 'Hyderabad Trip', days: [{ day_no: 1, title: 'Arrival', items: [{ type: 'activity', description: 'Charminar' }] }] }];
  });
  await page.evaluate(() => sendItinViaWa('1'));
  expect(sends.length).toBe(1);
  expect(sends[0]).toContain('name="conv_id"\r\n\r\n88');
  expect(sends[0]).toContain('Hyderabad Trip');
  expect(sends[0]).toContain('filename="Itinerary-Asha.pdf"');
  expect(texts).toEqual([]);
  // @ts-ignore
  expect(await page.evaluate(() => clientRecord.itin_number_seq)).toBe(5);
  // A number with no linked chat: confirm, then the text message goes out.
  await page.evaluate(() => sendItinViaWa('1'));
  expect(sends.length).toBe(1);
  expect(dialogs.some((m) => m.includes('No WhatsApp chat is linked'))).toBe(true);
  expect(texts.length).toBe(1);
  expect(texts[0].phone).toBe('971559999999');
});
