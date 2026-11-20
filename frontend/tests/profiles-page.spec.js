// 👤 Profiles (profiles.html) and who sees it in the dashboard: travel and hospitality accounts
// only. Hermetic file:// — the worker is mocked with page.route.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pageUrl = 'file://' + path.resolve(__dirname, '../profiles.html') + '?client=7&token=t';
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');
const iso = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);

const PROFILES = [
  { id: 1, first_name: 'Anu', last_name: 'Mathew', name: 'Anu Mathew', age: 36, nationality: 'Indian', whatsapp: '+971 50 123 4567', family_group: 'Mathew family', relation: 'self',
    marketing_ok: true, next_birthday: { date: iso(3), days: 3 }, next_anniversary: null,
    docs: [{ id: 11, type: 'passport', number_masked: '•••••567', has_number: true, expiry_date: iso(20), days_left: 20, status: 'expiring', issuing_country: 'India' },
      { id: 12, type: 'visa', visa_country: 'UAE', number_masked: '', has_number: false, expiry_date: iso(400), days_left: 400, status: 'valid' }] },
  { id: 2, first_name: 'Ravi', last_name: 'Mathew', name: 'Ravi Mathew', age: 8, family_group: 'Mathew family', relation: 'child', marketing_ok: true,
    next_birthday: { date: iso(200), days: 200 }, docs: [{ id: 13, type: 'passport', number_masked: '•••••901', has_number: true, expiry_date: iso(-4), days_left: -4, status: 'expired' }] },
  { id: 3, first_name: 'Chen', name: 'Chen', marketing_ok: false, next_birthday: null, docs: [] },
];
const REMINDERS = [
  { id: 5, kind: 'passport', status: 'open', title: 'Anu Mathew — Passport expires in 20 days', due_date: iso(20), days: 20, profile_id: 1, name: 'Anu Mathew',
    phone: '+971 50 123 4567', lead_id: null, marketing_ok: true, message: 'Hi Anu, a friendly reminder that your Passport expires soon.' },
  { id: 6, kind: 'birthday', status: 'open', title: '🎂 Chen — birthday in 2 days', due_date: iso(2), days: 2, profile_id: 3, name: 'Chen', phone: '', marketing_ok: false, message: 'Happy birthday, Chen!' },
];

async function open(page, query = '') {
  const calls = [];
  await page.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.protocol === 'file:') return route.continue();
    const body = req.postData() ? req.postDataJSON() : null;
    calls.push({ path: url.pathname + url.search, method: req.method(), body });
    if (url.pathname.endsWith('/profiles') && req.method() === 'GET') return route.fulfill({ json: { today: iso(0), profiles: PROFILES } });
    if (url.pathname.endsWith('/profiles') && req.method() === 'POST') return route.fulfill({ json: { profile: { ...PROFILES[2], id: 9, first_name: body.first_name, name: body.first_name, docs: [] } } });
    if (url.pathname.endsWith('/profiles/reminders') && req.method() === 'GET') return route.fulfill({ json: { reminders: REMINDERS } });
    if (url.pathname.endsWith('/profiles/reminders')) return route.fulfill({ json: { ok: true } });
    if (url.pathname.endsWith('/profiles/reveal')) return route.fulfill({ json: { number: 'M1234567' } });
    if (url.pathname.endsWith('/profiles/check')) return route.fulfill({ json: { results: [{ profile_id: 1, name: 'Anu Mathew', issues: [{ level: 'warn', code: 'six_months', message: 'Anu Mathew: passport expires soon after the return.' }] }] } });
    return route.abort();
  });
  await page.goto(pageUrl + query, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#list .card')).toHaveCount(3);
  return calls;
}

test('lists profiles with document status, stats and family groups', async ({ page }) => {
  await open(page);
  await expect(page.locator('#h1')).toHaveText('👤 Traveller profiles');
  await expect(page.locator('#stats')).toContainText('Open reminders');
  await expect(page.locator('#stats .stat', { hasText: 'Documents expired' }).locator('b')).toHaveText('1');
  const anu = page.locator('#list .card', { hasText: 'Anu Mathew' });
  await expect(anu.locator('.pill.st-expiring')).toContainText('Passport');
  await expect(anu).toContainText('Mathew family');
  await expect(anu).toContainText('🎂 in 3d');
  await page.locator('#toolbar select').selectOption('Mathew family');
  await expect(page.locator('#list .card')).toHaveCount(2);
});

test('hospitality wording with ?kind=guest', async ({ page }) => {
  await open(page, '&kind=guest');
  await expect(page.locator('#h1')).toHaveText('👤 Guest profiles');
  await expect(page.locator('#newBtn')).toHaveText('＋ New guest');
});

test('profile sheet masks numbers and reveals on request', async ({ page }) => {
  const calls = await open(page);
  await page.locator('#list .card', { hasText: 'Anu Mathew' }).click();
  await expect(page.locator('#pOv')).toBeVisible();
  await expect(page.locator('#p_first_name')).toHaveValue('Anu');
  await expect(page.locator('#num11')).toHaveText('•••••567');
  await page.locator('#docList .doc', { hasText: 'Passport' }).getByRole('button', { name: '👁 Show' }).click();
  await expect(page.locator('#num11')).toHaveText('M1234567');
  expect(calls.some((c) => c.path.includes('/profiles/reveal?doc_id=11'))).toBe(true);
  await expect(page.locator('#docList .doc', { hasText: 'UAE visa' })).toContainText('Valid');
});

test('reminders: WhatsApp link with the message, no greeting without consent, mark done', async ({ page }) => {
  const calls = await open(page);
  await page.getByRole('tab', { name: /Reminders/ }).click();
  const pass = page.locator('#list .card', { hasText: 'Passport expires' });
  await expect(pass.getByRole('link', { name: '💬 WhatsApp' })).toHaveAttribute('href', /^https:\/\/wa\.me\/971501234567\?text=Hi%20Anu/);
  const bday = page.locator('#list .card', { hasText: 'Chen' });
  await expect(bday).toContainText('no consent');
  await expect(bday.getByRole('link', { name: '💬 WhatsApp' })).toHaveCount(0);
  await pass.getByRole('button', { name: '✓ Done' }).click();
  await expect(page.locator('#list .card')).toHaveCount(1);
  expect(calls.find((c) => c.method === 'PATCH').body).toEqual({ id: 5, status: 'done' });
});

test('expiring tab and trip check', async ({ page }) => {
  await open(page);
  await page.getByRole('tab', { name: /Expiring/ }).click();
  await expect(page.locator('#list .card')).toHaveCount(2);
  await expect(page.locator('#list .card').first()).toContainText('Ravi Mathew');
  await page.getByRole('button', { name: '✈️ Trip check' }).click();
  await page.locator('#c_dep').fill(iso(30));
  await page.locator('#c_pick label', { hasText: 'Anu Mathew' }).locator('input').check();
  await page.locator('#cRun').click();
  await expect(page.locator('#c_res .issue.warn')).toContainText('passport expires soon');
});

test('new profile opens the passport form next', async ({ page }) => {
  const calls = await open(page);
  await page.locator('#newBtn').click();
  await page.locator('#p_first_name').fill('Meera');
  await page.locator('#pSave').click();
  await expect(page.locator('#docForm')).toBeVisible();
  await expect(page.locator('#d_type')).toHaveValue('passport');
  expect(calls.find((c) => c.method === 'POST').body.first_name).toBe('Meera');
});

async function dashboard(page, rec) {
  await page.route('**/*', (route) => (route.request().url().startsWith('file://') ? route.continue() : route.abort()));
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate((r) => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    try { localStorage.setItem('lv_travel_view_7', 'classic'); } catch (e) {}
    // @ts-ignore
    clientId = 7; clientRecord = r; sessionToken = 't'; myEmail = '';
    // @ts-ignore
    applyTheme(r.industry);
  }, rec);
}

test.describe('dashboard visibility', () => {
  test.use({ viewport: { width: 1400, height: 900 } });
  for (const [rec, on] of [[{ industry: 'travel' }, true], [{ industry: 'hospitality', hospitality_enabled: 'Yes' }, true], [{ industry: 'general', ta_enabled: 'Yes' }, true],
    [{ industry: 'general' }, false], [{ industry: 'ecommerce' }, false], [{ industry: 'real_estate' }, false]]) {
    test(`${JSON.stringify(rec)} → ${on ? 'shown' : 'hidden'}`, async ({ page }) => {
      await dashboard(page, rec);
      await expect(page.locator('#dnProfilesTab')).toBeVisible({ visible: on });
    });
  }

  test('hospitality opens the page worded for guests', async ({ page }) => {
    await dashboard(page, { industry: 'hospitality' });
    // @ts-ignore
    await page.evaluate(() => navigate('profiles'));
    await expect(page.locator('#profilesFrame')).toHaveAttribute('src', /profiles\.html\?client=7&token=t&embed=1&kind=guest$/);
  });

  test('travel workspace nav has Travellers', async ({ page }) => {
    await page.route('**/*', (route) => (route.request().url().startsWith('file://') ? route.continue() : route.abort()));
    await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      document.getElementById('app').classList.add('show');
      document.getElementById('gate')?.style.setProperty('display', 'none');
      try { localStorage.removeItem('lv_travel_view_7'); } catch (e) {}
      // @ts-ignore
      clientId = 7; clientRecord = { industry: 'travel', ta_enabled: 'Yes' }; sessionToken = 't'; myEmail = ''; allLeads = [];
      // @ts-ignore
      applyTheme('travel');
    });
    await page.locator('#travelNav .dnTab[data-page="profiles"]').click();
    await expect(page.locator('#pageProfiles')).toBeVisible();
    await expect(page.locator('#profilesFrame')).toHaveAttribute('src', /profiles\.html\?client=7&token=t&embed=1$/);
  });
});
