// Trips pipeline: requests the WhatsApp booking bot files on its own (status `requested`, source
// whatsapp_bot, worker trip-requests.js) show with their badges, filters and quick actions, and a
// status change on a trip moves its lead's Stage.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';
const ids = { packages: 'tp', bookings: 'tb', cases: 'tc', itineraries: 'ti', umrah_groups: 'tu' };
const ago = min => new Date(Date.now() - min * 60000).toISOString();

const TRIPS = [
  { Id: 1, client_name: 'Asha', client_phone: '919876543210', package_name: 'Kashmir', destination: 'Kashmir', departure_date: '2027-04-29',
    adults: '5', children: '0', pax: 5, status: 'requested', source: 'whatsapp_bot', lead_id: '42', requested_at: ago(90), missing_info: '', assigned_to: 'rep@x.com' },
  { Id: 2, client_name: 'Ravi', client_phone: '919800000000', package_name: 'Goa', destination: 'Goa', travel_month: '2027-02',
    adults: '', children: '0', pax: 1, status: 'requested', source: 'whatsapp_bot', lead_id: '43', requested_at: ago(5), missing_info: 'exact date, travellers' },
  { Id: 3, client_name: 'Meera', package_name: 'Dubai 5N', departure_date: '2027-01-10', pax: 2, status: 'quoted', sell_price: 2000, deposit: 0, currency: 'AED' },
];
// An anticipated trip picked up from the chat (worker tripChatSync) — an air ticket, not a package.
const CHAT_TRIP = { Id: 4, client_name: 'Fathima', client_phone: '919811111111', package_name: 'Air Ticket · Calicut → Dubai', destination: 'Dubai',
  departure_city: 'Calicut', departure_date: '2027-03-15', return_date: '2027-03-22', travel_month: '2027-03', service: 'Air Ticket', pax: 1,
  status: 'requested', source: 'whatsapp_chat', lead_id: '44', requested_at: ago(2), missing_info: 'travellers' };

async function open(page, { patches = [], leadPatches = [], trips = TRIPS } = {}) {
  await page.route('**/*', async (route) => {
    const req = route.request(), url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (!url.startsWith(WORKER)) return route.abort();
    const u = new URL(url);
    if (u.pathname.endsWith('/records/7')) return route.fulfill({ json: { Id: 7, ta_enabled: 'Yes', ta_table_ids: JSON.stringify(ids), sla_minutes: '30', team_emails: 'rep@x.com,ops@x.com', authentik_email: 'boss@x.com' } });
    if (u.pathname.endsWith('/meta/tables/tb')) return route.fulfill({ json: { columns: ['client_name', 'status', 'lead_id', 'source', 'destination', 'travel_month', 'adults', 'children', 'children_ages', 'departure_city', 'assigned_to', 'requested_at', 'status_changed_at', 'missing_info', 'lost_reason', 'duplicate_of', 'created_at', 'alerted_at'].map(title => ({ title })) } });
    if (u.pathname.includes('/meta/')) return route.fulfill({ json: { columns: [] } });
    if (u.pathname.endsWith('/tables/tb/records') && req.method() === 'GET') return route.fulfill({ json: { list: trips } });
    if (u.pathname.endsWith('/tables/tb/records') && req.method() === 'PATCH') { patches.push(req.postDataJSON()); return route.fulfill({ json: { Id: 1 } }); }
    if (u.pathname.includes('/records') && req.method() === 'PATCH') { leadPatches.push(req.postDataJSON()); return route.fulfill({ json: { Id: 42 } }); }
    return route.fulfill({ json: { list: [] } });
  });
  await page.goto('file://' + path.resolve(__dirname, '../travel-agency.html') + '?client=7&token=t&embed=1&shell=travel&tab=bookings', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#bookingList')).toBeVisible();
}

test('bot requests show in the pipeline with wait time, incomplete and assignee badges', async ({ page }) => {
  await open(page);
  const list = page.locator('#bookingList');
  // Open trips: the oldest waiting request first.
  await expect(list.locator('.booking-row').first()).toContainText('Asha');
  await expect(list.locator('.booking-row')).toHaveCount(3);
  const asha = list.locator('.booking-row', { hasText: 'Asha' });
  await expect(asha).toContainText('🤖 Bot');
  await expect(asha).toContainText('5A');
  await expect(asha.locator('.ta-tb-late')).toContainText('⏰');
  await expect(asha).toContainText('rep');
  const ravi = list.locator('.booking-row', { hasText: 'Ravi' });
  await expect(ravi).toContainText('Incomplete: exact date, travellers');
  await expect(ravi).toContainText('Unassigned');
  await expect(page.locator('.ta-trip-alert')).toContainText('1 new request has waited more than 30 min');
  // Incomplete filter
  await page.click('.ta-trip-chip:has-text("Incomplete")');
  await expect(list.locator('.booking-row')).toHaveCount(1);
  await expect(list).toContainText('Ravi');
  // Stage card filter
  await page.click('.ta-trip-stage:has-text("Quoted")');
  await expect(list.locator('.booking-row')).toHaveCount(1);
  await expect(list).toContainText('Meera');
});

test('✓ Contacted moves the request on; Lost on a trip marks its lead lost', async ({ page }) => {
  const patches = [], leadPatches = [];
  await open(page, { patches, leadPatches });
  await page.locator('.booking-row', { hasText: 'Asha' }).locator('button:has-text("Contacted")').click();
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toMatchObject({ Id: 1, status: 'contacted' });
  expect(patches[0].status_changed_at).toBeTruthy();
  expect(leadPatches).toEqual([]);

  await page.locator('.booking-row', { hasText: 'Asha' }).click();
  await expect(page.locator('#bookingReqInfo')).toContainText('Collected by the WhatsApp bot');
  await page.selectOption('#bookingStatus', 'cancelled');
  await expect(page.locator('#bookingLostWrap')).toBeVisible();
  await page.selectOption('#bookingLostReason', 'Booked elsewhere');
  await page.click('#saveBookingBtn');
  await expect.poll(() => patches.length).toBe(2);
  expect(patches[1]).toMatchObject({ Id: 1, status: 'cancelled', lost_reason: 'Booked elsewhere', assigned_to: 'rep@x.com' });
  await expect.poll(() => leadPatches.length).toBe(1);
  expect(leadPatches[0]).toMatchObject({ Id: 42, Stage: 'lost' });
});

test('💰 Quote opens the trip on Quoted, 💬 Chat opens the lead in the dashboard', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { window.__msgs = []; window.parent.postMessage = (m) => window.__msgs.push(m); });
  const asha = page.locator('.booking-row', { hasText: 'Asha' });
  await asha.locator('button:has-text("Chat")').click();
  // @ts-ignore
  expect(await page.evaluate(() => window.__msgs)).toEqual([{ type: 'ta:openLead', leadId: 42 }]);
  await asha.locator('button:has-text("Quote")').click();
  await expect(page.locator('#bookingStatus')).toHaveValue('quoted');
  await expect(page.locator('#bookingModalTitle')).toHaveText('Trip request');
});

test('anticipated trips from the chat (ticket, visa…) show with their service, a From chat filter and their details', async ({ page }) => {
  await open(page, { trips: [...TRIPS, CHAT_TRIP] });
  const list = page.locator('#bookingList');
  const row = list.locator('.booking-row', { hasText: 'Fathima' });
  await expect(row).toContainText('💬 From chat');
  await expect(row).toContainText('Air Ticket · Calicut → Dubai');
  await expect(row).toContainText('2027-03-15');
  await page.click('.ta-trip-chip:has-text("From chat")');
  await expect(list.locator('.booking-row')).toHaveCount(1);
  await row.click();
  const info = page.locator('#bookingReqInfo');
  await expect(info).toContainText('Picked up from the chat');
  await expect(info).toContainText('Air Ticket');
  await expect(info).toContainText('2027-03-22');
  await expect(info).toContainText('Calicut');
});
