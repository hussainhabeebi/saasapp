// Company profile (Settings → 📇 People & Contacts): logo, official name, tagline, bio, licence and
// brand colour are one profile shared by the top bar, quotation / itinerary PDFs (synced client
// fields) and the travel workspace's Today home, which is branded with the logo and its colour.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');

const identity = {
  official_name: 'Kerala Holidays LLP', short_name: 'KH', tagline: 'Handpicked Kerala holidays since 2009', licence: 'IATA 14-3 1234',
  address: 'MG Road, Kochi', map_url: 'https://maps.app.goo.gl/x', hours: 'Mon–Sat 9–7', phone: '+91 98470 00000', whatsapp: '+91 98470 00001',
  email: 'hello@kh.in', website: 'https://kh.in', about: 'We plan Kerala trips for families.\n\nHouseboats, hill stations and beaches.',
  brand_color: '', logo_url: '', logo_wide_url: '',
};

// A 40×40 logo: red square on white — its colour is red.
const redLogo = () => {
  const cv = document.createElement('canvas'); cv.width = 40; cv.height = 40;
  const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 40, 40); g.fillStyle = '#d32f2f'; g.fillRect(8, 8, 24, 24);
  return cv.toDataURL('image/png');
};

async function boot(page, { client, profile = identity, canManage = true } = {}) {
  const posts = [];
  await page.route('**/*', async (route) => {
    const req = route.request(), url = req.url();
    if (url.startsWith('file://') || url.startsWith('data:')) return route.continue();
    if (url.endsWith('/settings/contacts') && req.method() === 'GET')
      return route.fulfill({ json: { data: { identity: profile, departments: [], guard: true }, saved: true, can_manage: canManage, logo_upload: true, billing: {}, teammates: [] } });
    if (url.endsWith('/settings/contacts') && req.method() === 'POST') {
      const b = JSON.parse(req.postData()); posts.push(b);
      return route.fulfill({ json: { ok: true, data: b.data, prompt_block: '', client_fields: {
        business_name: b.data.identity.official_name, business_tagline: b.data.identity.tagline, business_about: b.data.identity.about,
        brand_color: b.data.identity.brand_color, quote_accent_color: b.data.identity.brand_color, quote_footer_address: 'MG Road, Kochi\n+91 98470 00000' } } });
    }
    return route.abort();
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate((rec) => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    try { localStorage.removeItem('lv_travel_view_7'); } catch (e) {}
    // @ts-ignore
    clientId = 7; clientRecord = rec; sessionToken = 't'; myEmail = 'owner@kh.in'; allLeads = []; _taBookings = [];
    // @ts-ignore
    applyTheme(rec.industry);
  }, client);
  return posts;
}

test('logo colour: the main colour of a logo, none for a plain black/white one', async ({ page }) => {
  await boot(page, { client: { industry: 'general', client_name: 'X' } });
  const out = await page.evaluate(async (fn) => {
    const red = await window.lvLogoColor(eval(`(${fn})`)());
    const cv = document.createElement('canvas'); cv.width = 20; cv.height = 20; cv.getContext('2d').fillRect(0, 0, 20, 20);
    const black = await window.lvLogoColor(cv.toDataURL());
    const sh = window.lvBrandShades('#ffd400'); // bright yellow is darkened until white text reads on it
    return { red, black, sh };
  }, redLogo.toString());
  expect(out.red).toMatch(/^#d[0-9a-f]2[0-9a-f]2[0-9a-f]$/);
  expect(out.black).toBe('');
  const lum = (hex) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)); return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  expect(lum(out.sh.accent)).toBeLessThanOrEqual(0.18);
});

test('profile: tagline, bio, licence and brand colour are saved and update the CRM', async ({ page }) => {
  const posts = await boot(page, { client: { industry: 'travel', ta_enabled: 'Yes', client_name: 'kh account' }, profile: { ...identity, tagline: '', about: '', licence: '' } });
  await page.evaluate(() => navigate('peoplecontacts'));
  await expect(page.locator('#pcId_about')).toBeVisible();
  await page.locator('#pcId_tagline').fill('Handpicked Kerala holidays since 2009');
  await page.locator('#pcId_licence').fill('IATA 14-3 1234');
  await page.locator('#pcId_about').fill('We plan Kerala trips.\n\nFamily run.');
  await page.locator('#pcBrandHex').fill('#0F766E');
  await expect(page.locator('#pcPreview')).toContainText('About the business: We plan Kerala trips. Family run.');
  await page.locator('#pcSaveBtn').click();
  await expect(page.locator('#pcSaveMsg')).toContainText('Saved');
  const saved = posts[0].data.identity;
  expect(saved).toMatchObject({ tagline: 'Handpicked Kerala holidays since 2009', licence: 'IATA 14-3 1234', about: 'We plan Kerala trips.\n\nFamily run.', brand_color: '#0f766e' });
  // The synced fields reach the client record: company name in the top bar, colour, PDF footer.
  await expect(page.locator('#hChip')).toHaveText('Kerala Holidays LLP');
  const rec = await page.evaluate(() => ({ b: clientRecord.brand_color, f: clientRecord.quote_footer_address }));
  expect(rec).toEqual({ b: '#0f766e', f: 'MG Road, Kochi\n+91 98470 00000' });
});

test('travel Today home: logo, company name, tagline, bio and contacts, in the brand colour', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 900 });
  await boot(page, { client: { industry: 'travel', ta_enabled: 'Yes', client_name: 'kh account', business_name: 'Kerala Holidays LLP', brand_color: '#0f766e' } });
  await page.evaluate((fn) => { clientRecord.quote_logo_url = eval(`(${fn})`)(); navigate('travelhome'); }, redLogo.toString());
  const home = page.locator('#tvHomeBody');
  await expect(home.locator('.tv-company')).toHaveText('Kerala Holidays LLP');
  await expect(home.locator('.tv-logo img')).toHaveAttribute('alt', 'Kerala Holidays LLP logo');
  await expect(home.locator('.tv-tagline')).toHaveText('Handpicked Kerala holidays since 2009');
  const about = home.locator('#tvAboutCard');
  await expect(about).toContainText('About Kerala Holidays LLP');
  await expect(about.locator('.tv-bio')).toContainText('Houseboats, hill stations and beaches.');
  await expect(about.locator('a[href="tel:+919847000000"]')).toHaveText('+91 98470 00000');
  await expect(about.locator('a[href="https://wa.me/919847000001"]')).toBeVisible();
  await expect(about).toContainText('IATA 14-3 1234');
  await expect(about.getByRole('button', { name: '✏️ Edit company profile' })).toBeVisible();
  // The workspace accent is the brand colour.
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())).toBe('#0f766e');
});

test('travel home without a brand colour takes it from the logo; empty profile asks the owner to set it up', async ({ page }) => {
  await boot(page, { client: { industry: 'travel', ta_enabled: 'Yes', client_name: 'Acme Travels' }, profile: { official_name: '' } });
  await page.evaluate((fn) => { clientRecord.quote_logo_url = eval(`(${fn})`)(); tvApply(); navigate('travelhome'); }, redLogo.toString());
  await expect(page.locator('#tvHomeBody .tv-company')).toHaveText('Acme Travels');
  await expect(page.locator('#tvHomeBody')).toContainText('Your company profile');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())).toBe('#d32f2f');
});
